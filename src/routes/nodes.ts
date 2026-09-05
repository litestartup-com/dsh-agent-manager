import { readFileSync } from 'node:fs'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { probeEndpoint } from './status.js'

/**
 * 蜂群 P3：节点（fleet）视图数据源。
 *
 * 一个节点 = 一个 endpoint 的实体。托管节点（spawn.managed）的真相是监督器
 * 状态机（cold/starting/live/restarting/offline）；未托管节点的真相是探活
 * 结果（live/offline）。侧栏节点区与未来的 /nodes 页共用这一份。
 */
export const registerNodesRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  supervisors: Map<string, NodeSupervisor>,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, UpstreamClient>,
  requireUser: preHandlerHookHandler,
): void => {
  app.get('/api/nodes', { preHandler: requireUser }, async () => {
    const nodes = await Promise.all(
      Object.keys(config.endpoints).map(async (id) => {
        const agentIds = Object.values(config.agents)
          .filter((a) => a.endpoint === id)
          .map((a) => a.id)
        const supervisor = supervisors.get(id)
        const probe = await probeEndpoint(config, clients, upstreamClients, id)
        if (supervisor !== undefined) {
          const s = supervisor.current
          return {
            id,
            managed: true,
            state: s.state,
            pid: s.pid,
            attempts: s.attempts,
            lastError: s.lastError,
            agents: agentIds,
            dshVersion: probe.dshVersion,
            dshCompatible: probe.dshCompatible,
          }
        }
        return {
          id,
          managed: false,
          state: probe.reachable ? 'live' : 'offline',
          pid: null,
          attempts: 0,
          lastError: probe.reachable ? null : probe.error,
          sessions: probe.sessions,
          agents: agentIds,
          dshVersion: probe.dshVersion,
          dshCompatible: probe.dshCompatible,
        }
      }),
    )
    return { nodes }
  })

  /**
   * 蜂群 P5.1：节点管控。只有托管节点（有 spawn 配置 + 监督器在册）能操作；
   * 外部管理的节点友好拒绝——manager 的手伸不到的地方，按钮就不该出现。
   */
  type Managed =
    | { kind: 'ok'; supervisor: NodeSupervisor; spawn: NonNullable<AppConfig['endpoints'][string]['spawn']> }
    | { kind: 'unknown' }
    | { kind: 'unmanaged' }

  const managed = (request: { params: { id: string } }): Managed => {
    const ep = config.endpoints[request.params.id]
    if (ep === undefined) return { kind: 'unknown' }
    if (ep.spawn === null) return { kind: 'unmanaged' }
    const supervisor = supervisors.get(request.params.id)
    if (supervisor === undefined) return { kind: 'unmanaged' }
    return { kind: 'ok', supervisor, spawn: ep.spawn }
  }

  app.post<{ Params: { id: string } }>('/api/nodes/:id/up', { preHandler: requireUser }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法启动它` })
    }
    target.supervisor.start(target.spawn)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.post<{ Params: { id: string } }>('/api/nodes/:id/down', { preHandler: requireUser }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法停止它` })
    }
    target.supervisor.stop()
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.post<{ Params: { id: string } }>('/api/nodes/:id/restart', { preHandler: requireUser }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法重启它` })
    }
    target.supervisor.restart(target.spawn)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/nodes/:id/logs',
    { preHandler: requireUser },
    async (request, reply) => {
      const ep = config.endpoints[request.params.id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const limit = Math.min(Math.max(Number(request.query.limit ?? 200) || 200, 1), 2000)
      const tail = (text: string): string => text.split(/\r?\n/).slice(-limit).join('\n')

      // 日志文件（detached + log_file 的节点）从文件读；否则读监督器内存缓冲。
      if (ep.spawn?.logFile !== undefined && ep.spawn.logFile !== null) {
        try {
          return reply.send({ logs: tail(readFileSync(ep.spawn.logFile, 'utf8')), source: 'file' })
        } catch {
          return reply.send({ logs: '', source: 'file' })
        }
      }
      const supervisor = supervisors.get(request.params.id)
      if (supervisor === undefined) {
        return reply.code(409).send({ error: 'not_managed', detail: '外部管理的节点没有日志可供读取' })
      }
      return reply.send({ logs: tail(supervisor.logs()), source: 'buffer' })
    },
  )
}
