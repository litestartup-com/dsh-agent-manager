import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { loadConfig } from './config.js'

// dotenv does not override existing vars, so a test-local secret wins over any
// real .env the repo may have.
if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const baseConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  listen: { host: '127.0.0.1', port: 8080 },
  endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy' } },
  agents: { personal: { name: '个人', endpoint: 'A', workspace: '.' } },
  ...extra,
})

const loadFrom = (obj: Record<string, unknown>): ReturnType<typeof loadConfig> => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-config-test-'))
  try {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, stringify(obj), 'utf8')
    return loadConfig(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const withEnv = (vars: Record<string, string>, fn: () => void): void => {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('parses the P0 fields: agent preset/sandbox_mode and endpoint sandbox surface', () => {
  withEnv({ GW_KEY_A: 'test-gw-key' }, () => {
    const cfg = loadFrom(baseConfig({
      endpoints: {
        A: {
          url: 'http://127.0.0.1:3080',
          driver: 'apiproxy',
          sandbox_base: 'http://127.0.0.1:3080/api-gw/v1/',
          sandbox_key_ref: 'GW_KEY_A',
        },
      },
      agents: {
        personal: { name: '个人', endpoint: 'A', workspace: '.', preset: 'standard', sandbox_mode: 'workspace-write' },
      },
    }))
    const ep = cfg.endpoints['A']
    assert.ok(ep !== undefined)
    assert.equal(ep.sandboxBase, 'http://127.0.0.1:3080/api-gw/v1')
    assert.equal(ep.sandboxKey, 'test-gw-key')
    const agent = cfg.agents['personal']
    assert.ok(agent !== undefined)
    assert.equal(agent.preset, 'standard')
    assert.equal(agent.sandboxMode, 'workspace-write')
  })
})

test('defaults: no sandbox surface, no preset, no mode', () => {
  const cfg = loadFrom(baseConfig())
  const ep = cfg.endpoints['A']
  assert.ok(ep !== undefined)
  assert.equal(ep.sandboxBase, null)
  assert.equal(ep.sandboxKey, '')
  const agent = cfg.agents['personal']
  assert.ok(agent !== undefined)
  assert.equal(agent.preset, null)
  assert.equal(agent.sandboxMode, null)
})

test('agent sandbox_mode without endpoint sandbox_base fails loud at boot', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      agents: { personal: { name: '个人', endpoint: 'A', workspace: '.', sandbox_mode: 'read-only' } },
    })),
    /no sandbox_base/,
  )
})

test('endpoint sandbox_base with empty key env fails loud at boot', () => {
  withEnv({ GW_KEY_A: '' }, () => {
    assert.throws(
      () => loadFrom(baseConfig({
        endpoints: {
          A: {
            url: 'http://127.0.0.1:3080',
            driver: 'apiproxy',
            sandbox_base: 'http://127.0.0.1:3080/api-gw/v1',
            sandbox_key_ref: 'GW_KEY_A',
          },
        },
      })),
      /GW_KEY_A is empty/,
    )
  })
})

test('parses a managed spawn spec with defaults and resolved cwd', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        spawn: {
          managed: true,
          command: 'node',
          args: ['bin.js', '--profile', 'web'],
          cwd: '.',
        },
      },
    },
  }))
  const ep = cfg.endpoints['A']
  assert.ok(ep !== undefined)
  assert.ok(ep.spawn !== null)
  assert.equal(ep.spawn.managed, true)
  assert.equal(ep.spawn.command, 'node')
  assert.deepEqual(ep.spawn.args, ['bin.js', '--profile', 'web'])
  assert.equal(ep.spawn.cwd, resolve('.'))
  assert.equal(ep.spawn.readyTimeoutMs, 30_000)
  assert.equal(ep.spawn.detached, false)
  assert.equal(ep.spawn.logFile, null)
  assert.deepEqual(ep.spawn.restart, { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 })
})

test('蜂群 P5.1: brain daily budget defaults off and parses when set', () => {
  assert.equal(loadFrom(baseConfig()).brainDailyBudgetMicroUsd, null)
  const capped = loadFrom(baseConfig({ brain: { daily_budget_usd: 1.5 } }))
  assert.equal(capped.brainDailyBudgetMicroUsd, 1_500_000)
})

test('no spawn block resolves to null (externally managed node)', () => {  const cfg = loadFrom(baseConfig())
  assert.equal(cfg.endpoints['A']?.spawn, null)
})

test('蜂群2计划 P2: spawn.runner defaults to process; docker runner resolves its spec', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: {
        url: 'http://127.0.0.1:3080',
        driver: 'apiproxy',
        spawn: {
          managed: true,
          runner: 'docker',
          docker: {
            image: 'ohdsh/dsh-node:0.1.1-rc.2',
            network: 'hive',
            port: 3081,
            host_volumes: { '/opt/ohdsh/workspaces/personal': '/workspace' },
            named_volumes: { 'ohdsh-personal': '/data' },
          },
        },
      },
    },
  }))
  const spawn = cfg.endpoints['A']?.spawn
  assert.ok(spawn !== null && spawn !== undefined)
  assert.equal(spawn.runner, 'docker')
  assert.equal(spawn.command, '', 'docker runner 不需要 command')
  assert.equal(spawn.docker?.image, 'ohdsh/dsh-node:0.1.1-rc.2')
  assert.equal(spawn.docker?.containerName, null)
  assert.equal(spawn.docker?.network, 'hive')
  assert.equal(spawn.docker?.port, 3081)
  assert.deepEqual(spawn.docker?.hostVolumes, { '/opt/ohdsh/workspaces/personal': '/workspace' })
  assert.deepEqual(spawn.docker?.namedVolumes, { 'ohdsh-personal': '/data' })
})

test('蜂群2计划 P2: runner=docker without docker block fails loud', () => {
  assert.throws(
    () => loadFrom(baseConfig({
      endpoints: {
        A: {
          url: 'http://127.0.0.1:3080',
          driver: 'apiproxy',
          spawn: { managed: true, runner: 'docker' },
        },
      },
    })),
    /runner=docker 需要 docker 段/,
  )
})

test('蜂群2计划 P2: process spawn keeps resolving with runner=process and docker=null', () => {
  const cfg = loadFrom(baseConfig({
    endpoints: {
      A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy', spawn: { managed: true, command: 'node' } },
    },
  }))
  assert.equal(cfg.endpoints['A']?.spawn?.runner, 'process')
  assert.equal(cfg.endpoints['A']?.spawn?.docker, null)
})

test('蜂群2计划 P5: 随仓发布的容器示例配置必须始终通过 schema（install.sh 依赖它）', () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), '..', 'manager.config.container.example.yaml')
  withEnv({ GW_KEY_A: 'apigw-a', GW_KEY_B: 'apigw-b' }, () => {
    const cfg = loadConfig(example)
    const brain = cfg.endpoints['brain']
    const personal = cfg.endpoints['personal']
    assert.ok(brain !== undefined && personal !== undefined)
    assert.equal(brain.spawn, null, '主脑由 compose 声明（脊柱，非托管）')
    assert.equal(personal.spawn?.runner, 'docker')
    assert.equal(personal.spawn?.docker?.image, 'ohdsh/dsh-node:0.1.1-rc.2')
    assert.equal(personal.spawn?.docker?.network, 'hive')
    assert.deepEqual(cfg.backupDockerVolumes, ['ohdsh-brain'], '脊柱主脑卷进备份声明')
    assert.equal(cfg.agents['brain']?.sandboxMode, 'workspace-write')
  })
})
