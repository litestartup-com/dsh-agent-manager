import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { schema, type Db } from '../db/index.js'
import { GatewayError, type GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'
import { listArchivedChats, listChats } from '../chat/store.js'
import { activeRunCount, runningRunId } from '../runner.js'
import { currentMonth, monthByAgent } from '../usage/store.js'

export interface EndpointStatus {
  id: string
  url: string
  driver: 'gateway' | 'apiproxy'
  reachable: boolean
  sessions: number | null
  apiKeySet: boolean | null
  enabled: boolean | null
  error: string | null
  /** 蜂群2计划 P1：apiproxy 探测到的节点 DSH 版本；gateway/未知 = null。 */
  dshVersion: string | null
  /** 与验证版本 COMPAT_DSH_VERSION 是否一致；null = 版本未知（无告警）。 */
  dshCompatible: boolean | null
}

/**
 * One endpoint liveness probe, branched by driver:
 * - gateway  → the old plugin's own GET /health
 * - apiproxy → one bounded host.describe RPC (there is no /health under /api)
 *
 * Exported for the nodes route (蜂群 P3): an unmanaged node's state *is* its
 * probe result.
 */
export const probeEndpoint = async (
  config: AppConfig,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, UpstreamClient>,
  endpointId: string,
): Promise<EndpointStatus> => {
  const endpoint = config.endpoints[endpointId]
  const url = endpoint?.url ?? ''
  const driver = endpoint?.driver ?? 'gateway'
  const row: EndpointStatus = {
    id: endpointId,
    url,
    driver,
    reachable: false,
    sessions: null,
    apiKeySet: null,
    enabled: null,
    error: null,
    dshVersion: null,
    dshCompatible: null,
  }
  if (driver === 'apiproxy') {
    const upstream = upstreamClients.get(endpointId)
    if (upstream === undefined) {
      row.error = 'endpoint not configured'
      return row
    }
    try {
      const version = await upstream.hostVersion()
      row.reachable = true
      if (version !== 'unknown') {
        // 注意（DSH-FACTS §6）：host.describe 的 version 字段恒为协议号（0.0.1），
        // 不是 DSH 版本——只作信息展示，绝不用于兼容性告警。
        row.dshVersion = version
      }
      return row
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      row.error = detail.slice(0, 300)
      return row
    }
  }
  const client = clients.get(endpointId)
  if (client === undefined) {
    row.error = 'endpoint not configured'
    return row
  }
  try {
    const health = await client.health()
    row.reachable = true
    row.sessions = health.sessions
    row.apiKeySet = health.apiKeySet
    row.enabled = health.enabled
    return row
  } catch (error) {
    // A dead endpoint must not take the whole status page down; it shows
    // up as one unreachable row instead.
    const detail = error instanceof GatewayError ? error.detail || error.message : String(error)
    row.error = detail.slice(0, 300)
    return row
  }
}

export const registerStatusRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  requireUser: preHandlerHookHandler,
  upstreamClients: Map<string, UpstreamClient>,
): void => {
  /** Liveness for a supervisor. Intentionally unauthenticated and contentless. */
  app.get('/healthz', async (_request, reply) => reply.send({ ok: true }))

  app.get('/api/status', { preHandler: requireUser }, async (_request, reply) => {
    // Every configured endpoint gets a row, whatever its driver: the green dot
    // is the page's whole job, and a missing row reads as "forgotten", not "down".
    const endpoints: EndpointStatus[] = await Promise.all(
      Object.keys(config.endpoints).map((id) => probeEndpoint(config, clients, upstreamClients, id)),
    )

    const agents = Object.values(config.agents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      endpoint: agent.endpoint,
      workspacePath: agent.workspacePath,
      public: agent.public,
    }))

    // Boot-time warnings were only ever written to the log, where nobody sees
    // them again. Things like "these agents share one DSH sandbox root" need to
    // be visible in the UI for as long as they remain true.
    return reply.send({ endpoints, agents, warnings: config.warnings })
  })

  /**
   * Everything about one agent, in one request.
   *
   * The sidebar's green dot is endpoint health, not agent health, and when two
   * agents share an endpoint their dots move together -- which reads as "both
   * agents are down" when the truth is "one DSH process is down". This is where
   * that gets spelled out: which endpoint, who else is on it, and what the
   * sandbox consequence of sharing it is.
   *
   * One aggregate rather than five requests from the drawer: the panel is opened
   * to answer a single question, and five independent fetches can disagree with
   * each other about which agent is busy.
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id', { preHandler: requireUser }, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    const health = await probeEndpoint(config, clients, upstreamClients, agent.endpoint)

    // Sharing an endpoint is the fact most worth surfacing here: a DSH sandbox
    // root is per process, not per session, so these agents can read and write
    // each other's workspaces no matter what manager asks for.
    const sharedWith = Object.values(config.agents)
      .filter((a) => a.endpoint === agent.endpoint && a.id !== agent.id)
      .map((a) => ({ id: a.id, name: a.name }))

    const month = currentMonth()
    const spend = monthByAgent(db, month).find((row) => row.agentId === agent.id) ?? null

    const runs = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.agentId, agent.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(5)
      .all()

    return reply.header('cache-control', 'no-store').send({
      agent: {
        id: agent.id,
        name: agent.name,
        endpoint: agent.endpoint,
        workspacePath: agent.workspacePath,
        public: agent.public,
        preset: agent.preset,
        provider: agent.provider,
        model: agent.model,
        gitRemote: agent.gitRemote,
      },
      endpoint: health,
      sharedWith,
      busyRunId: runningRunId(agent.id),
      activeRuns: activeRunCount(agent.id),
      chats: {
        active: listChats(db, agent.id).length,
        archived: listArchivedChats(db).filter((c) => c.agentId === agent.id).length,
      },
      month: {
        month,
        costMicroUsd: spend?.costMicroUsd ?? 0,
        peakCostMicroUsd: spend?.peakCostMicroUsd ?? 0,
        unpriced: spend?.unpriced ?? 0,
        runs: spend?.runs ?? 0,
      },
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        state: r.state,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        error: r.error,
      })),
      // Only the warnings that are about this agent's endpoint. The full list is
      // on /api/status for the pages that show all of them.
      warnings: config.warnings.filter((w) => w.includes(`"${agent.endpoint}"`)),
    })
  })
}
