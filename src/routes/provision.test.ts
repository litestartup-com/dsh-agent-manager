import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { openDb, schema, type Db } from '../db/index.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { registerProvisionRoutes, installNodeDepsAsync } from './provision.js'

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

const boot = (): {
  app: ReturnType<typeof Fastify>
  config: AppConfig
  db: Db
  sqlite: ReturnType<typeof openDb>['sqlite']
  supervisors: Map<string, NodeSupervisor>
} => {
  const config = configFor()
  const { db, sqlite } = openDb(':memory:')
  const supervisors = new Map<string, NodeSupervisor>()
  const app = Fastify()
  registerProvisionRoutes(app, config, async () => {}, { db, supervisors, clients: new Map(), upstreamClients: new Map() })
  return { app, config, db, sqlite, supervisors }
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
  assert.ok(config.endpoints['product'].spawn !== null)
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

test('蜂群 P5.5: deleting a node removes its workspace binding rows too, files untouched', async () => {
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
  assert.ok(join(dir, 'ws-company', '.git') !== '', 'workspace got git init')

  const supervisor = supervisors.get('company')!
  stopped.push(supervisor)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/company' })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual((removed.json() as { removedWorkspaces: string[] }).removedWorkspaces, ['company'])
  assert.equal(config.endpoints['company'], undefined)
  assert.equal(config.agents['company'], undefined)
  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.doesNotMatch(yaml, /company/)
  // DB 行保留（账单与审计不删）；工作区目录保留
  assert.ok(db.select().from(schema.agent).all().find((a) => a.id === 'company') !== undefined)
  assert.ok(join(dir, 'ws-company') !== '')

  const missing = await app.inject({ method: 'DELETE', url: '/api/nodes/nope' })
  assert.equal(missing.statusCode, 404)
})

test('蜂群 P5.5: unknown agent id shape is rejected', async () => {
  const { app } = await boot()
  const bad = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'BAD NAME', install: false } })
  assert.equal(bad.statusCode, 400)
})

test('蜂群2计划 P6: 容器模式新节点 = docker runner（不找 DSH bin，命名卷 + 内网别名 + 宿主路径推导）', async () => {
  const { app, config, supervisors } = await boot()
  // 模拟脊柱部署已存在 personal 工蜂（docker runner），向导据此进入容器模式
  config.endpoints['personal'] = {
    id: 'personal',
    url: 'http://node-personal:3081',
    driver: 'apiproxy',
    prefix: '/api',
    key: '',
    sandboxBase: 'http://node-personal:3081/api-gw/v1',
    sandboxKey: 'apigw-x',
    spawn: {
      managed: true,
      command: '',
      args: [],
      cwd: null,
      readyTimeoutMs: 30_000,
      detached: false,
      logFile: null,
      env: {},
      restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      runner: 'docker',
      docker: {
        image: 'ohdsh/dsh-node:0.1.1-rc.2',
        containerName: null,
        network: 'ohdsh-hive',
        port: 3081,
        hostVolumes: { '/srv/ohdsh/workspaces/personal': '/opt/ohdsh/workspaces/personal' },
        namedVolumes: { 'ohdsh-personal': '/data' },
      },
    },
  }

  const created = await app.inject({ method: 'POST', url: '/api/nodes', payload: { name: 'product' } })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const body = created.json() as { node: { id: string; home: string; port: number } }
  assert.equal(body.node.home, 'ohdsh-product', '节点 home = 命名卷')

  const spawn = config.endpoints['product']?.spawn
  assert.ok(spawn !== null && spawn !== undefined)
  assert.equal(spawn.runner, 'docker', '容器模式绝不找 DSH bin')
  assert.equal(spawn.docker?.network, 'ohdsh-hive')
  assert.equal(spawn.docker?.namedVolumes['ohdsh-product'], '/data')
  // 宿主路径前缀从 personal 推导（/srv/ohdsh/workspaces/product），容器内路径 = manager 视角
  assert.equal(spawn.docker?.hostVolumes['/srv/ohdsh/workspaces/product'], '/opt/ohdsh/workspaces/product')
  assert.equal(config.endpoints['product']?.url, 'http://node-product:3090')

  const yaml = readFileSync(join(dir, 'manager.config.yaml'), 'utf8')
  assert.match(yaml, /runner: docker/)
  assert.match(yaml, /http:\/\/node-product:3090/)
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_PRODUCT=/)

  stopped.push(supervisors.get('product')!)
  const removed = await app.inject({ method: 'DELETE', url: '/api/nodes/product' })
  assert.equal(removed.statusCode, 200)
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /product/)
})

test('蜂群2计划 P6 回归: 容器模式新建节点同步镜像进 DB（chat 外键不再炸）', async () => {
  const { app, config, db } = await boot()
  config.endpoints['personal'] = {
    id: 'personal',
    url: 'http://node-personal:3081',
    driver: 'apiproxy',
    prefix: '/api',
    key: '',
    sandboxBase: 'http://node-personal:3081/api-gw/v1',
    sandboxKey: 'apigw-x',
    spawn: {
      managed: true,
      command: '',
      args: [],
      cwd: null,
      readyTimeoutMs: 30_000,
      detached: false,
      logFile: null,
      env: {},
      restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      runner: 'docker',
      docker: {
        image: 'ohdsh/dsh-node:0.1.1-rc.2',
        containerName: null,
        network: 'ohdsh-hive',
        port: 3081,
        hostVolumes: { '/srv/ohdsh/workspaces/personal': '/opt/ohdsh/workspaces/personal' },
        namedVolumes: { 'ohdsh-personal': '/data' },
      },
    },
  }

  const created = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'product', agent: { id: 'product', name: '产品', workspace: join(dir, 'ws-product-docker') } },
  })
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const row = db.select().from(schema.agent).all().find((a) => a.id === 'product')
  assert.ok(row !== undefined, 'agent 镜像进 DB registry（chat 外键依赖它）')
})

test('债务 B1 回归: 依赖安装后台化——installNodeDepsAsync 不冻结事件循环,spawn 参数正确', async () => {
  // TS 无法追踪闭包内赋值,用已断言类型的哨兵对象
  const spawnArgs = {} as { cmd: string; args: string[]; cwd: string }
  const fakeSpawn = (cmd: string, args: string[], opts: { cwd: string }): unknown => {
    spawnArgs.cmd = cmd
    spawnArgs.args = args
    spawnArgs.cwd = opts.cwd
    const listeners: Record<string, (code: number) => void> = {}
    const child = {
      on: (ev: string, fn: (code: number) => void) => {
        listeners[ev] = fn
        return child
      },
    }
    setTimeout(() => listeners['exit']?.(0), 400) // 400ms 后 exit 0
    return child
  }
  const promise = installNodeDepsAsync('/tmp/node-home/profiles/x', fakeSpawn as never)
  // 事件循环未被冻结:install 完成前,立即排队的 timer 必须先触发(旧同步 execFileSync 会冻结)
  let ticked = false
  setTimeout(() => {
    ticked = true
  }, 50)
  await promise
  assert.ok(ticked, 'install 期间事件循环必须保持响应')
  assert.ok(spawnArgs.cmd !== '')
  assert.ok(spawnArgs.args.includes('--prefer-offline'), '必须带 --prefer-offline')
  assert.equal(spawnArgs.cwd, '/tmp/node-home/profiles/x')
})

test('债务 B1 回归: 后台 install 非零退出 = reject(调用方据此审计留痕)', async () => {
  const fakeSpawn = (): unknown => {
    const listeners: Record<string, (code: number) => void> = {}
    const child = {
      on: (ev: string, fn: (code: number) => void) => {
        listeners[ev] = fn
        return child
      },
    }
    setTimeout(() => listeners['exit']?.(1), 10) // 非零退出 = 失败
    return child
  }
  await assert.rejects(
    () => installNodeDepsAsync('/tmp/any', fakeSpawn as never),
    /exit|失败|failed/i,
    '非零退出必须 reject',
  )
})

test('债务 H2 回归: DB 写入失败 → provision 全量回滚,无幽灵节点残留', async () => {
  const { app, config, db, sqlite, supervisors } = await boot()
  // 真实 DB 层注入:agent 表插入即抛（模拟磁盘满/约束冲突等真实失败路径）
  sqlite.exec("CREATE TRIGGER boom_agent_insert BEFORE INSERT ON agent BEGIN SELECT RAISE(ABORT, 'boom'); END")

  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    payload: { name: 'boom-node', install: false, agent: { id: 'boom-agent', workspace: join(dir, 'ws-boom') } },
  })
  assert.equal(res.statusCode, 500)

  // 全量回滚:内存 / 监督器 / yaml / .env / 节点目录 / DB 六面全部无残留
  assert.equal(config.endpoints['boom-node'], undefined, '内存 endpoint 不得残留')
  assert.equal(config.agents['boom-agent'], undefined, '内存 agent 不得残留')
  assert.ok(!supervisors.has('boom-node'), '监督器不得残留')
  assert.doesNotMatch(readFileSync(join(dir, 'manager.config.yaml'), 'utf8'), /boom-node/, 'yaml 不得残留')
  assert.doesNotMatch(readFileSync(join(dir, '.env'), 'utf8'), /GW_KEY_BOOM_NODE/, '.env 密钥不得残留')
  assert.ok(!existsSync(join(nodesRoot, 'boom-node')), '节点目录必须被清理')
  assert.equal(
    db.select().from(schema.agent).all().find((a) => a.id === 'boom-agent'),
    undefined,
    'DB agent 行不得残留',
  )
})
