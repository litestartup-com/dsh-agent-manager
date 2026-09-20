import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  spawn: null, access: null,
})

const configFor = (gw: FakeGateway): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: ep(gw) },
  agents: {
    personal: {
      id: 'personal', name: '个人', endpoint: 'A', workspacePath: '.',
      public: false, preset: null, sandboxMode: null, gitRemote: null, provider: null, model: null,
  validate: null,
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
  const body = res.json()
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
  const body = res.json()
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
  const body = res.json()
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
  assert.equal((logs.json()).logs, 'hello\nworld')
  assert.equal((logs.json()).source, 'buffer')
})

test('蜂群 P5.1: unmanaged nodes get a friendly 409, unknown nodes a 404', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const app = Fastify()
  registerNodesRoutes(app, config, new Map(), new Map(), new Map(), async () => {})

  const up = await app.inject({ method: 'POST', url: '/api/nodes/A/up' })
  assert.equal(up.statusCode, 409)
  assert.match(String((up.json()).detail), /外部管理/)

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
  config.endpoints['A']!.spawn = dockerSpawn
  const calls = { start: 0, stop: 0, restart: 0 }
  const supervisor = stubSupervisor(calls) as unknown as NodeSupervisor & { dockerLogs: () => Promise<string | null> }
  supervisor.dockerLogs = async () => 'container-log\n'
  const app = Fastify()
  registerNodesRoutes(app, config, new Map([['A', supervisor]]), new Map(), new Map(), async () => {})

  const logs = await app.inject({ method: 'GET', url: '/api/nodes/A/logs' })
  assert.equal(logs.statusCode, 200)
  assert.equal((logs.json()).logs, 'container-log\n')
  assert.equal((logs.json()).source, 'docker')
})

test('债务 P1 回归: POST /api/nodes/:id/access 写真相源并热加载;clear 移除;非法值 400', async () => {
  const gw = await startFakeGateway({ frames: [] }, API_KEY)
  gateways.push(gw)
  const config = configFor(gw)
  const dir = mkdtempSync(join(tmpdir(), 'nodes-access-'))
  const configPath = join(dir, 'manager.config.yaml')
  writeFileSync(configPath, 'endpoints:\n  A:\n    url: http://x\n', 'utf8')
  config.configPath = configPath
  const audits: string[] = []
  const app = Fastify()
  registerNodesRoutes(app, config, new Map(), new Map(), new Map(), async () => {}, (_actor, kind) => audits.push(kind))

  const set = await app.inject({
    method: 'POST',
    url: '/api/nodes/A/access',
    payload: { ssh_user: 'ubuntu', ssh_host: '10.0.0.5', local_port: 3088 },
  })
  assert.equal(set.statusCode, 200)
  assert.deepEqual(config.endpoints['A']?.access, { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088 }, '内存热加载')
  assert.match(readFileSync(configPath, 'utf8'), /access:/, '真相源落盘')
  assert.ok(audits.includes('node_access_update'), '审计留痕')

  const clear = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { clear: true } })
  assert.equal(clear.statusCode, 200)
  assert.equal(config.endpoints['A']?.access, null)
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), /access:/)

  const bad = await app.inject({ method: 'POST', url: '/api/nodes/A/access', payload: { ssh_user: 'u', ssh_host: 'h' } })
  assert.equal(bad.statusCode, 400)

  const missing = await app.inject({ method: 'POST', url: '/api/nodes/nope/access', payload: { ssh_user: 'u', ssh_host: 'h', local_port: 1 } })
  assert.equal(missing.statusCode, 404)
})
