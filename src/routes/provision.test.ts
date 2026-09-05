import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { openDb, schema, type Db } from '../db/index.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { registerProvisionRoutes } from './provision.js'

const configFor = (): AppConfig => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: {},
  agents: {},
  runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const dir = mkdtempSync(join(tmpdir(), 'provision-'))
const nodesRoot = join(dir, 'nodes')
mkdirSync(nodesRoot, { recursive: true })
writeFileSync(join(dir, 'manager.config.yaml'), 'listen:\n  host: 127.0.0.1\n  port: 8080\nendpoints: {}\nagents: {}\n', 'utf8')
writeFileSync(join(dir, 'fake-dsh.js'), 'process.exit(0)\n', 'utf8')

const previousCwd = process.cwd()
process.chdir(dir)
process.env.DSH_BIN = join(dir, 'fake-dsh.js')
process.env.DSH_OHDSH_NODES_HOME = nodesRoot

const stopped: NodeSupervisor[] = []
after(() => {
  for (const s of stopped) s.stop()
  process.chdir(previousCwd)
  delete process.env.DSH_BIN
  delete process.env.DSH_OHDSH_NODES_HOME
  rmSync(dir, { recursive: true, force: true })
})

const boot = (): { app: ReturnType<typeof Fastify>; config: AppConfig; db: Db; supervisors: Map<string, NodeSupervisor> } => {
  const config = configFor()
  const { db } = openDb(':memory:')
  const supervisors = new Map<string, NodeSupervisor>()
  const app = Fastify()
  registerProvisionRoutes(app, config, async () => {}, { db, supervisors, clients: new Map(), upstreamClients: new Map() })
  return { app, config, db, supervisors }
}

test('蜂群 P5.5: provision creates a node (profile/key/config write-back/hot-load) and removes it', async () => {
  const { app, config, supervisors } = await boot()

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'product', install: false },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const body = created.json() as { node: { id: string; port: number; home: string } }
  assert.equal(body.node.id, 'product')
  assert.equal(body.node.port, 3090)

  // 热加载：内存配置、监督器、yaml 写回、.env 密钥
  assert.ok(config.endpoints['product'] !== undefined)
  assert.ok(config.endpoints['product']!.spawn !== null)
  assert.ok(supervisors.has('product'))
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /product/)
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_PRODUCT=/)
  assert.ok(join(nodesRoot, 'product') !== '')

  // 重名 / 端口冲突
  const dup = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'product', install: false } })
  assert.equal(dup.statusCode, 409)
  const port = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'other', port: 3090, install: false } })
  assert.equal(port.statusCode, 409)
  assert.match(String((port.json() as { detail: string }).detail), /端口/)

  // 删除（无 agent 绑定）
  const supervisor = supervisors.get('product')!
  stopped.push(supervisor)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/product' })
  assert.equal(removed.statusCode, 200)
  assert.equal(config.endpoints['product'], undefined)
  assert.ok(!supervisors.has('product'))
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /product/)
})

test('蜂群 P5.5: a node with a bound agent refuses deletion, and agent rows are mirrored', async () => {
  const { app, config, db, supervisors } = await boot()

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: {
      name: 'company',
      install: false,
      agent: { id: 'company', name: '企业', workspace: join(dir, 'ws-company'), preset: 'standard', sandboxMode: 'workspace-write' },
    },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))

  assert.equal(config.agents['company']?.name, '企业')
  assert.equal(config.agents['company']?.endpoint, 'company')
  const row = db.select().from(schema.agent).all().find((a) => a.id === 'company')
  assert.ok(row !== undefined, 'agent mirrored into the registry table')

  const supervisor = supervisors.get('company')!
  stopped.push(supervisor)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/company' })
  assert.equal(removed.statusCode, 409)
  assert.equal((removed.json() as { error: string }).error, 'agents_bound')

  const missing = await app.inject({ method: 'DELETE', url: '/api/nodes/nope' })
  assert.equal(missing.statusCode, 404)
})

test('蜂群 P5.5: unknown agent id shape is rejected', async () => {
  const { app } = await boot()
  const bad = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'BAD NAME', install: false } })
  assert.equal(bad.statusCode, 400)
})
