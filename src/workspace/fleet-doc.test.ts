import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderFleetDoc, syncFleetDocs, FLEET_FILE } from './fleet-doc.js'
import { DEFAULT_PRICING } from '../pricing.js'
import type { AppConfig } from '../config.js'

const configFor = (): AppConfig => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-doc-'))
  return {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {
      brain: { id: 'brain', url: 'http://node-brain:3082', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null },
      personal: {
        id: 'personal',
        url: 'http://node-personal:3081',
        driver: 'apiproxy',
        prefix: '/api',
        key: '',
        sandboxBase: null,
        sandboxKey: '',
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
          docker: { image: 'x', containerName: null, network: 'ohdsh-hive', port: 3081, hostVolumes: {}, namedVolumes: { 'ohdsh-personal': '/data' } },
        },
      },
    },
    agents: {
      brain: { id: 'brain', name: '主脑', endpoint: 'brain', workspacePath: join(root, 'brain'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null },
      personal: { id: 'personal', name: '个人', endpoint: 'personal', workspacePath: join(root, 'personal'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null },
    },
    runner: { timeoutMs: 1_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
}

test('蜂群2计划 P6: fleet.md 派生自配置——节点清单/形态/边界/环境变量引用', () => {
  const config = configFor()
  const doc = renderFleetDoc(config)
  assert.match(doc, /fleet 拓扑与边界/)
  assert.match(doc, /\*\*brain\*\*（主脑）：外部 · 外管 · 私有/)
  assert.match(doc, /\*\*personal\*\*（个人）：容器 · 托管 · 私有/)
  assert.match(doc, /\$MANAGER_URL/)
  assert.match(doc, /BRAIN_TOKEN/)
  assert.match(doc, /跨节点的一切执行都通过 manager 派工/)
  // 不写死任何真实地址
  assert.doesNotMatch(doc, /127\.0\.0\.1|172\.\d+/)
})

test('蜂群2计划 P6: syncFleetDocs 写入每个工作区、幂等、内容变化时更新', () => {
  const config = configFor()
  const updated = syncFleetDocs(config)
  assert.deepEqual(updated.sort(), ['brain', 'personal'])
  for (const agent of Object.values(config.agents)) {
    assert.equal(readFileSync(join(agent.workspacePath, FLEET_FILE), 'utf8'), renderFleetDoc(config))
    assert.ok(existsSync(join(agent.workspacePath, FLEET_FILE)))
  }
  // 幂等：内容一致不重写
  assert.deepEqual(syncFleetDocs(config), [])
  // 拓扑变化 → 自动更新
  config.agents['product'] = { id: 'product', name: '产品', endpoint: 'personal', workspacePath: join(config.agents['brain']!.workspacePath, '..', 'product'), public: false, preset: 'standard', sandboxMode: null, gitRemote: null, provider: null, model: null }
  assert.deepEqual(syncFleetDocs(config).sort(), ['brain', 'personal', 'product'])
  assert.match(readFileSync(join(config.agents['product']!.workspacePath, FLEET_FILE), 'utf8'), /product/)
})
