import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { registerRunRoutes } from './run.js'
// 债务 C3:agent 构造 + 多 agent 测试库收敛进 test-harness。
import { agentWith, makeDbWithAgents } from '../test-harness.js'

// 蜂群 Q4：/nodes 页的任务流数据源——全局最近任务，含主脑派工标记。
const endpoint: ResolvedEndpoint = {
  id: 'A',
  url: 'http://127.0.0.1:1',
  driver: 'gateway',
  prefix: '/api',
  key: 'test-key',
  sandboxBase: null,
  sandboxKey: '',
  spawn: null,
}

const agent: ResolvedAgent = agentWith({ id: 'personal', name: '个人', workspacePath: '.' })

const config: AppConfig = {
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: endpoint },
  agents: { personal: agent },
  runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
}

const boot = (): { app: ReturnType<typeof Fastify>; db: Db } => {
  // run.agent_id and chat.agent_id both reference agent(id).
  const db = makeDbWithAgents([
    { id: 'personal', name: '个人', workspacePath: '.' },
    { id: 'brain', name: '主脑', workspacePath: '.' },
  ])
  const app = Fastify()
  registerRunRoutes(app, config, db, new Map(), async () => {}, new Map())
  return { app, db }
}

test('GET /api/runs returns every run newest-first with agent name and source chat', async () => {
  const { app, db } = boot()
  db.insert(schema.chat)
    .values({ id: 'c1', agentId: 'brain', createdAt: 10, lastActiveAt: 10, title: 'brain chat' })
    .run()
  db.insert(schema.run)
    .values([
      {
        id: 'r-old',
        agentId: 'personal',
        trigger: 'manual',
        state: 'done',
        resultSummary: 'older',
        startedAt: 10,
        endedAt: 20,
      },
      {
        id: 'r-brain',
        agentId: 'personal',
        trigger: 'brain',
        state: 'done',
        resultSummary: 'delegated',
        sourceChatId: 'c1',
        startedAt: 30,
        endedAt: 40,
      },
    ])
    .run()

  const res = await app.inject({ method: 'GET', url: '/api/runs' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = res.json() as {
    runs: Array<{ id: string; agentName: string; trigger: string; sourceChatId: string | null }>
  }
  assert.equal(body.runs.length, 2)
  // 新在前
  assert.equal(body.runs[0]?.id, 'r-brain')
  assert.equal(body.runs[0]?.agentName, '个人')
  assert.equal(body.runs[0]?.trigger, 'brain')
  assert.equal(body.runs[0]?.sourceChatId, 'c1')
  assert.equal(body.runs[1]?.id, 'r-old')
  assert.equal(body.runs[1]?.sourceChatId, null)
})

test('GET /api/runs caps the limit and needs auth', async () => {
  const { app, db } = boot()
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    agentId: 'personal',
    trigger: 'manual',
    state: 'done',
    startedAt: i,
  }))
  db.insert(schema.run).values(rows).run()

  const capped = await app.inject({ method: 'GET', url: '/api/runs?limit=2' })
  assert.equal(capped.statusCode, 200)
  assert.equal((capped.json() as { runs: unknown[] }).runs.length, 2)

  const huge = await app.inject({ method: 'GET', url: '/api/runs?limit=9999' })
  assert.equal((huge.json() as { runs: unknown[] }).runs.length, 5)
})

test('unauthenticated GET /api/runs is rejected by the requireUser hook', async () => {
  const db = makeDbWithAgents([])
  const app = Fastify()
  registerRunRoutes(
    app,
    config,
    db,
    new Map(),
    async () => {
      throw { statusCode: 401 }
    },
    new Map(),
  )
  const res = await app.inject({ method: 'GET', url: '/api/runs' })
  assert.equal(res.statusCode, 401)
})

test('债务 E9: runs API 的钱字段统一 MicroUsd 命名(不泄露裸列名 cost/peakCost)', async () => {
  const { app, db } = boot()
  db.insert(schema.run)
    .values({ id: 'r1', agentId: 'personal', trigger: 'manual', state: 'done', startedAt: 1, endedAt: 2 })
    .run()
  db.insert(schema.usageRecord)
    .values({ runId: 'r1', provider: 'p', model: 'm', inputTokens: 10, outputTokens: 20, cost: 1234, peakCost: 456, at: 2 })
    .run()

  const res = await app.inject({ method: 'GET', url: '/api/agents/personal/runs' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { runs: Array<{ usage: Record<string, unknown> | null }> }
  const usage = body.runs[0]?.usage
  assert.ok(usage !== null && usage !== undefined)
  assert.equal(usage.costMicroUsd, 1234, 'API 必须用 costMicroUsd')
  assert.equal(usage.peakCostMicroUsd, 456, 'API 必须用 peakCostMicroUsd')
  assert.equal('cost' in usage, false, 'API 不得再泄露裸列名 cost')
  assert.equal('peakCost' in usage, false, 'API 不得再泄露裸列名 peakCost')
})
