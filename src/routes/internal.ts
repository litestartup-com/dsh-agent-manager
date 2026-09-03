import { randomUUID } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'
import { drainAgentQueue } from '../chat/queue.js'
import { listChats, getChat } from '../chat/store.js'
import { readBoard } from '../board/store.js'
import { AgentBusy, runAgent, runningRunId } from '../runner.js'
import { monthTotals, monthByAgent, monthByModel, currentMonth } from '../usage/store.js'
import { scheduleProblem, type Scheduler } from '../cron/schedule.js'

/**
 * 蜂群 P2：brain 面内部 REST API。
 *
 * 主脑（DSH 里的 skill + curl）吃这一面；第三方走北向 /api/v1。两道门缺一
 * 不可，全不过则这一面不存在（fail closed）：
 *
 * 1. 仅接受回环来源（主脑与 manager 同机；token 即使外带，公网也打不进来）；
 * 2. `X-Brain-Token` 常量时间比较，值来自 `.env` 的 `BRAIN_TOKEN`。
 *
 * 语义对齐 BRAINSTORM §3.2 三组：看（只读）与做（manager 侧裁决）；红线
 * （写文件 / 发信 / 管理操作）在此面根本不提供路由。
 */

const tokenOk = (candidate: string | null): boolean => {
  const token = process.env.BRAIN_TOKEN ?? ''
  if (token === '' || candidate === null) return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(token, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

const brainGate: preHandlerHookHandler = async (request, reply) => {
  if (!isLoopback(request.ip)) {
    await reply.code(403).send({ error: 'loopback_only', hint: 'the brain API accepts loopback connections only' })
    return
  }
  if ((process.env.BRAIN_TOKEN ?? '') === '') {
    await reply.code(503).send({ error: 'brain_disabled', hint: 'BRAIN_TOKEN is not set in .env' })
    return
  }
  const candidate = typeof request.headers['x-brain-token'] === 'string' ? request.headers['x-brain-token'] : null
  if (!tokenOk(candidate)) {
    await reply.code(401).send({ error: 'unauthorized' })
    return
  }
}

const dispatchBody = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  chatId: z.string().optional(),
})

const cronBody = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(80),
  schedule: z.string().min(1).max(120),
  timezone: z.string().min(1).max(60).default('Asia/Shanghai'),
  prompt: z.string().min(1).max(20_000),
})

export const registerInternalRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, UpstreamClient>,
  scheduler: Scheduler,
): void => {
  const gated = { preHandler: brainGate }

  // ---- 看 ----

  app.get('/api/internal/agents', gated, async () => {
    const month = currentMonth()
    const byAgent = new Map(monthByAgent(db, month).map((s) => [s.agentId, s]))
    return {
      agents: Object.values(config.agents).map((agent) => {
        const chats = listChats(db, agent.id, 1_000)
        const running = runningRunId(agent.id)
        return {
          id: agent.id,
          name: agent.name,
          public: agent.public,
          preset: agent.preset,
          sandboxMode: agent.sandboxMode,
          busy: running !== null,
          runningRunId: running,
          chatCount: chats.length,
          spendMicroUsd: byAgent.get(agent.id)?.costMicroUsd ?? 0,
        }
      }),
    }
  })

  app.get<{ Params: { id: string } }>('/api/internal/agents/:id', gated, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    const endpoint = config.endpoints[agent.endpoint]
    const runs = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.agentId, agent.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(5)
      .all()
    return {
      ...agent,
      endpoint: {
        id: agent.endpoint,
        driver: endpoint?.driver ?? null,
        url: endpoint?.url ?? null,
      },
      runningRunId: runningRunId(agent.id),
      recentRuns: runs.map((r) => ({
        id: r.id,
        state: r.state,
        trigger: r.trigger,
        summary: r.resultSummary,
        startedAt: r.startedAt,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/api/internal/agents/:id/board', gated, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    return readBoard(agent.workspacePath, agent.name)
  })

  app.get('/api/internal/usage', gated, async () => {
    const month = currentMonth()
    return { month, totals: monthTotals(db, month), byAgent: monthByAgent(db, month), byModel: monthByModel(db, month) }
  })

  app.get<{ Params: { id: string } }>('/api/internal/agents/:id/chats', gated, async (request, reply) => {
    const agent = config.agents[request.params.id]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    return {
      chats: listChats(db, agent.id).map((chat) => ({
        id: chat.id,
        title: chat.title,
        turns: chat.turns,
        lastActiveAt: chat.lastActiveAt,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/api/internal/chats/:id/summary', gated, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })
    const lastRun = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.chatId, chat.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(1)
      .all()[0]
    return {
      id: chat.id,
      agentId: chat.agentId,
      title: chat.title,
      state: chat.removedAt === null ? 'active' : 'archived',
      turns: listChats(db, chat.agentId).find((c) => c.id === chat.id)?.turns ?? 0,
      lastRun: lastRun === undefined
        ? null
        : { state: lastRun.state, summary: lastRun.resultSummary, startedAt: lastRun.startedAt },
    }
  })

  // ---- 做（manager 侧裁决） ----

  app.post<{ Body: unknown }>('/api/internal/dispatch', gated, async (request, reply) => {
    const parsed = dispatchBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data
    const agent = config.agents[body.agentId]
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    const driver = config.endpoints[agent.endpoint]?.driver ?? 'gateway'
    const upstream = upstreamClients.get(agent.endpoint)
    const client = clients.get(agent.endpoint)
    if (driver === 'apiproxy' && upstream === undefined) return reply.code(500).send({ error: 'endpoint_not_configured' })
    if (driver === 'gateway' && client === undefined) return reply.code(500).send({ error: 'endpoint_not_configured' })

    try {
      const outcome = await runAgent(
        {
          db,
          pricing: config.pricing,
          log: {
            info: (m) => app.log.info(m),
            warn: (m) => app.log.warn(m),
            error: (m) => app.log.error(m),
          },
        },
        {
          agent,
          client: client!,
          upstream,
          driver,
          prompt: body.prompt,
          trigger: 'brain',
          timeoutMs: config.runner.timeoutMs,
          silenceMs: config.runner.silenceMs,
        },
      )
      drainAgentQueue(agent.id)
      return reply.code(200).send(outcome)
    } catch (error) {
      if (error instanceof AgentBusy) {
        return reply.code(409).send({
          error: 'agent_busy',
          detail: `${agent.name} 正忙（run ${error.runningRunId}），拒绝派工，请稍后或改派其他 agent。`,
          runningRunId: error.runningRunId,
        })
      }
      app.log.error(`internal dispatch failed for ${agent.id}: ${(error as Error).message}`)
      return reply.code(500).send({ error: 'dispatch_failed', detail: (error as Error).message })
    }
  })

  app.post<{ Body: unknown }>('/api/internal/crons', gated, async (request, reply) => {
    const parsed = cronBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data
    if (config.agents[body.agentId] === undefined) return reply.code(404).send({ error: 'unknown_agent' })
    const problem = scheduleProblem(body.schedule, body.timezone)
    if (problem !== null) return reply.code(400).send({ error: 'invalid_schedule', detail: problem })

    const id = randomUUID()
    try {
      db.insert(schema.cron)
        .values({
          id,
          agentId: body.agentId,
          name: body.name,
          schedule: body.schedule,
          timezone: body.timezone,
          prompt: body.prompt,
          // 主脑可以起草定时任务，开关必须是人（BRAINSTORM §3.2）：默认停用，
          // 用户在 crons 页确认后才启用。
          enabled: 0,
          consecutiveFailures: 0,
          createdAt: Date.now(),
        })
        .run()
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'duplicate_name', detail: 'this agent already has a schedule by that name' })
      }
      throw error
    }
    scheduler.reload()
    return reply.code(201).send({ id, enabled: false, note: '已起草，待你在定时任务页确认后启用' })
  })
}
