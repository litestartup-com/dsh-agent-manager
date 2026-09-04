import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { registerRunRoutes } from './run.js'

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

const agent: ResolvedAgent = {
  id: 'personal',
  name: '个人',
  endpoint: 'A',
  workspacePath: '.',
  public: false,
  preset: null,
  sandboxMode: null,
  gitRemote: null,
  provider: null,
  model: null,
}

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
  const dir = mkdtempSync(join(tmpdir(), 'runs-global-'))
  const { db } = openDb(join(dir, 'test.db'))
  const app = Fastify()
  registerRunRoutes(app, config, db, new Map(), async () => {}, new Map())
  // run.agent_id and chat.agent_id both reference agent(id).
  db.insert(schema.agent)
    .values([
      { id: 'personal', name: '个人', workspacePath: '.', endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: 1 },
      { id: 'brain', name: '主脑', workspacePath: '.', endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: 1 },
    ])
    .run()
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
  const dir = mkdtempSync(join(tmpdir(), 'runs-global-auth-'))
  const { db } = openDb(join(dir, 'test.db'))
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
