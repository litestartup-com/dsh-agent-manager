import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb, schema, type Db } from '../db/index.js'
import type { AppConfig, ResolvedAgent, ResolvedEndpoint } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway, type FakeScript } from '../gateway/fake.js'
import { registerInternalRoutes } from './internal.js'
import type { Scheduler } from '../cron/schedule.js'

const API_KEY = 'test-key'
const BRAIN_TOKEN = 'brain-token-42'

// The gate reads process.env per request; set it once for the whole file and
// let individual tests toggle it (never delete it, or the rest 503).
process.env.BRAIN_TOKEN = BRAIN_TOKEN

const endpoint = (gw: FakeGateway): ResolvedEndpoint => ({
  id: 'A',
  url: gw.url,
  driver: 'gateway',
  prefix: gw.prefix,
  key: API_KEY,
  sandboxBase: null,
  sandboxKey: '',
  spawn: null,
})

const agentFor = (workspacePath: string): ResolvedAgent => ({
  id: 'personal',
  name: '个人',
  endpoint: 'A',
  workspacePath,
  public: false,
  preset: null,
  sandboxMode: null,
  gitRemote: null,
  provider: null,
  model: null,
})

const SUCCESS: FakeScript = {
  frames: [
    { kind: 'message', text: 'ok', reasoning: null, usage: { inputTokens: 10, outputTokens: 5 } },
    { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
  ],
}

interface Harness {
  app: ReturnType<typeof Fastify>
  db: Db
  gw: FakeGateway
  config: AppConfig
}

const gateways: FakeGateway[] = []

const boot = async (script: FakeScript): Promise<Harness> => {
  const gw = await startFakeGateway(script, API_KEY)
  gateways.push(gw)
  const dir = mkdtempSync(join(tmpdir(), 'internal-'))
  const workspace = mkdtempSync(join(tmpdir(), 'internal-ws-'))
  const { db } = openDb(join(dir, 'test.db'))
  db.insert(schema.agent)
    .values({
      id: 'personal',
      name: '个人',
      workspacePath: workspace,
      endpoint: 'A',
      preset: null,
      gitRemote: null,
      public: 0,
      createdAt: Date.now(),
    })
    .run()
  const agent = agentFor(workspace)
  const ep = endpoint(gw)
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    endpoints: { A: ep },
    agents: { personal: agent },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  const clients = new Map([['A', new GatewayClient(ep)]])
  const schedulerStub = { reload: () => {}, nextRunAt: () => null, problemFor: () => null } as unknown as Scheduler
  registerInternalRoutes(app, config, db, clients, new Map(), schedulerStub)
  return { app, db, gw, config }
}

after(async () => {
  await Promise.all(gateways.map((g) => g.close()))
})

const authed = (headers: Record<string, string> = {}): Record<string, string> => ({
  'x-brain-token': BRAIN_TOKEN,
  ...headers,
})

test('the brain gate fails closed: no token, wrong token, non-loopback, disabled', async () => {
  const { app } = await boot(SUCCESS)
  try {
    process.env.BRAIN_TOKEN = ''
    const disabled = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed() })
    assert.equal(disabled.statusCode, 503)
  } finally {
    process.env.BRAIN_TOKEN = BRAIN_TOKEN
  }

  const missing = await app.inject({ method: 'GET', url: '/api/internal/agents' })
  assert.equal(missing.statusCode, 401)

  const wrong = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed({ 'x-brain-token': 'nope' }) })
  assert.equal(wrong.statusCode, 401)

  const remote = await app.inject({
    method: 'GET',
    url: '/api/internal/agents',
    headers: authed(),
    remoteAddress: '203.0.113.9',
  })
  assert.equal(remote.statusCode, 403)
})

test('agents list: shape and busy flag', async () => {
  const { app } = await boot(SUCCESS)
  const res = await app.inject({ method: 'GET', url: '/api/internal/agents', headers: authed() })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { agents: Array<{ id: string; busy: boolean; chatCount: number }> }
  assert.equal(body.agents.length, 1)
  assert.equal(body.agents[0]?.id, 'personal')
  assert.equal(body.agents[0]?.busy, false)
  assert.equal(body.agents[0]?.chatCount, 0)
})

test('agent detail and empty board read', async () => {
  const { app } = await boot(SUCCESS)
  const detail = await app.inject({ method: 'GET', url: '/api/internal/agents/personal', headers: authed() })
  assert.equal(detail.statusCode, 200)
  const body = detail.json() as { id: string; endpoint: { driver: string } }
  assert.equal(body.id, 'personal')
  assert.equal(body.endpoint.driver, 'gateway')

  const board = await app.inject({ method: 'GET', url: '/api/internal/agents/personal/board', headers: authed() })
  assert.equal(board.statusCode, 200)
  // An uninitialised workspace reads as an empty model, not an error.
  assert.ok(Array.isArray((board.json() as { pages: unknown[] }).pages))

  const missing = await app.inject({ method: 'GET', url: '/api/internal/agents/nope', headers: authed() })
  assert.equal(missing.statusCode, 404)
})

test('dispatch: unknown agent 404, success runs with trigger=brain, busy 409', async () => {
  const { app, db, gw, config } = await boot(SUCCESS)

  const missing = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'nope', prompt: 'hi' },
  })
  assert.equal(missing.statusCode, 404)

  // source_chat_id has a FK to chat: the brain dispatches from its own chat, so
  // the row exists in the real flow.
  db.insert(schema.chat)
    .values({
      id: 'brain-chat-1',
      agentId: 'personal',
      dshSessionId: null,
      title: '主脑会话',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      removedAt: null,
    })
    .run()

  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'personal', prompt: '写一行', sourceChatId: 'brain-chat-1' },
  })
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  const outcome = ok.json() as { state: string }
  assert.equal(outcome.state, 'done')
  const runRow = db.select().from(schema.run).where(eq(schema.run.agentId, 'personal')).all()[0]
  assert.equal(runRow?.trigger, 'brain')
  assert.equal(runRow?.sourceChatId, 'brain-chat-1')

  // Busy: hold the agent with an in-flight silent run (the lock lives in the
  // runner module, shared by the route and this direct call), then dispatch.
  const { runAgent } = await import('../runner.js')
  const client = new GatewayClient(config.endpoints['A']!)
  const agent = config.agents['personal']!
  gw.setScript({ silent: true })
  const first = runAgent(
    { db, pricing: DEFAULT_PRICING, log: { info: () => {}, warn: () => {}, error: () => {} } },
    {
      agent,
      client,
      upstream: undefined,
      driver: 'gateway',
      prompt: 'hold',
      trigger: 'manual',
      timeoutMs: 5_000,
      silenceMs: 0,
    },
  )
  // give the in-flight run a beat to take the lock
  await new Promise((resolve) => setTimeout(resolve, 50))
  const busy = await app.inject({
    method: 'POST',
    url: '/api/internal/dispatch',
    headers: authed(),
    payload: { agentId: 'personal', prompt: '再写一行' },
  })
  assert.equal(busy.statusCode, 409)
  const busyBody = busy.json() as { error: string; detail: string }
  assert.equal(busyBody.error, 'agent_busy')
  assert.match(busyBody.detail, /正忙/)
  gw.setScript(SUCCESS)
  await first
})

test('crons: drafted disabled by default, duplicate name 409, bad schedule 400', async () => {
  const { app, db } = await boot(SUCCESS)
  const ok = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'brain-drafted', schedule: '30 21 * * *', prompt: '复盘' },
  })
  assert.equal(ok.statusCode, 201)
  const body = ok.json() as { id: string; enabled: boolean }
  assert.equal(body.enabled, false)
  const row = db.select().from(schema.cron).where(eq(schema.cron.id, body.id)).all()[0]
  assert.equal(row?.enabled, 0)

  const dup = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'brain-drafted', schedule: '30 21 * * *', prompt: 'x' },
  })
  assert.equal(dup.statusCode, 409)

  const bad = await app.inject({
    method: 'POST',
    url: '/api/internal/crons',
    headers: authed(),
    payload: { agentId: 'personal', name: 'bad', schedule: 'not a cron', prompt: 'x' },
  })
  assert.equal(bad.statusCode, 400)
})
