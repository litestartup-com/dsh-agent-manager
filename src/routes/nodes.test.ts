import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { AppConfig } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway } from '../gateway/fake.js'
import { NodeSupervisor } from '../nodes/supervisor.js'
import { registerNodesRoutes } from './nodes.js'

const API_KEY = 'test-key'
const gateways: FakeGateway[] = []

const ep = (gw: FakeGateway) => ({
  id: 'A',
  url: gw.url,
  driver: 'gateway' as const,
  prefix: gw.prefix,
  key: API_KEY,
  sandboxBase: null,
  sandboxKey: '',
  spawn: null,
})

const configFor = (gw: FakeGateway): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: ep(gw) },
  agents: {
    personal: {
      id: 'personal', name: '个人', endpoint: 'A', workspacePath: '.',
      public: false, preset: null, sandboxMode: null, gitRemote: null, provider: null, model: null,
    },
  },
  runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

after(async () => {
  await Promise.all(gateways.map((g) => g.close()))
})

test('an unmanaged node reports the probe result as its state', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  const clients = new Map([['A', new GatewayClient(ep(gw))]])
  registerNodesRoutes(app, config, new Map(), clients, new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  assert.equal(res.statusCode, 200)
  const body = res.json() as { nodes: Array<{ id: string; managed: boolean; state: string; agents: string[] }> }
  assert.equal(body.nodes.length, 1)
  assert.equal(body.nodes[0]?.id, 'A')
  assert.equal(body.nodes[0]?.managed, false)
  assert.equal(body.nodes[0]?.state, 'live')
  assert.deepEqual(body.nodes[0]?.agents, ['personal'])
})

test('a managed node reports the supervisor state machine', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  const supervisors = new Map([
    ['A', new NodeSupervisor('A', { probe: async () => ({ ok: true, detail: '' }) })],
  ])
  registerNodesRoutes(app, config, supervisors, new Map(), new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  const body = res.json() as { nodes: Array<{ id: string; managed: boolean; state: string; pid: number | null }> }
  assert.equal(body.nodes[0]?.managed, true)
  assert.equal(body.nodes[0]?.state, 'cold')
  assert.equal(body.nodes[0]?.pid, null)
})

test('an unreachable unmanaged node reports offline with the reason', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  const clients = new Map([['A', new GatewayClient({ ...ep(gw), url: 'http://127.0.0.1:1' })]])
  registerNodesRoutes(app, config, new Map(), clients, new Map(), async () => {})

  const res = await app.inject({ method: 'GET', url: '/api/nodes' })
  const body = res.json() as { nodes: Array<{ state: string; lastError: string | null }> }
  assert.equal(body.nodes[0]?.state, 'offline')
  assert.ok((body.nodes[0]?.lastError ?? '').length > 0)
})
