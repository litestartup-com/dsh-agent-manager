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
  const body = res.json() as { nodes: Array<{ id: string; managed: boolean; state: string; agents: string[]; dshVersion: string | null; dshCompatible: boolean | null }> }
  assert.equal(body.nodes.length, 1)
  assert.equal(body.nodes[0]?.id, 'A')
  assert.equal(body.nodes[0]?.managed, false)
  assert.equal(body.nodes[0]?.state, 'live')
  assert.deepEqual(body.nodes[0]?.agents, ['personal'])
  // 蜂群2计划 P1：gateway 驱动探测不到 DSH 版本 → null，不产生虚假告警
  assert.equal(body.nodes[0]?.dshVersion, null)
  assert.equal(body.nodes[0]?.dshCompatible, null)
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

// ---- 蜂群 P5.1：节点管控 ----

const managedSpawn = {
  managed: true,
  command: 'node',
  args: ['--version'],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
}

const stubSupervisor = (calls: { start: number; stop: number; restart: number }) =>
  ({
    start: () => {
      calls.start += 1
    },
    stop: () => {
      calls.stop += 1
    },
    restart: () => {
      calls.restart += 1
    },
    logs: () => 'hello\nworld',
    current: { state: 'cold' },
  }) as unknown as NodeSupervisor

test('蜂群 P5.1: managed nodes accept up/down/restart and serve their log buffer', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  config.endpoints['A']!.spawn = managedSpawn as never
  const calls = { start: 0, stop: 0, restart: 0 }
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', stubSupervisor(calls)]]), new Map(), new Map(), async () => {})

  const up = await app.inject({ method: 'POST', url: '/api/nodes/A/up' })
  assert.equal(up.statusCode, 200)
  assert.equal(calls.start, 1)

  const down = await app.inject({ method: 'POST', url: '/api/nodes/A/down' })
  assert.equal(down.statusCode, 200)
  assert.equal(calls.stop, 1)

  const restart = await app.inject({ method: 'POST', url: '/api/nodes/A/restart' })
  assert.equal(restart.statusCode, 200)
  assert.equal(calls.restart, 1)

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 200)
  assert.equal((logs.json() as { logs: string; source: string }).logs, 'hello\nworld')
  assert.equal((logs.json() as { source: string }).source, 'buffer')
})

test('蜂群 P5.1: unmanaged nodes get a friendly 409, unknown nodes a 404', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  registerNodesRoutes(app, config, new Map(), new Map(), new Map(), async () => {})

  const up = await app.inject({ method: 'POST', url: '/api/nodes/A/up' })
  assert.equal(up.statusCode, 409)
  assert.match(String((up.json() as { detail: string }).detail), /外部管理/)

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 409)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/down' })
  assert.equal(missing.statusCode, 404)
})

test('蜂群2计划 P2b: docker runner 节点的日志走 docker logs', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dockerSpawn = {
    ...managedSpawn,
    runner: 'docker' as const,
    docker: { image: 'ohdsh/dsh-node:0.1.1-rc.2', containerName: null, network: 'hive', port: 3081, hostVolumes: {}, namedVolumes: {} },
  }
  config.endpoints['A']!.spawn = dockerSpawn as never
  const calls = { start: 0, stop: 0, restart: 0 }
  const supervisor = stubSupervisor(calls) as unknown as NodeSupervisor & { dockerLogs: () => Promise<string | null> }
  supervisor.dockerLogs = async () => 'container-log\n'
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map(), new Map(), async () => {})

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 200)
  assert.equal((logs.json() as { logs: string; source: string }).logs, 'container-log\n')
  assert.equal((logs.json() as { source: string }).source, 'docker')
})
