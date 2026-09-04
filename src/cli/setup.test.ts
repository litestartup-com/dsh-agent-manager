import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildManagerConfig, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, resolveGatewayKey } from './setup.js'

test('buildManagerConfig wires two managed nodes, agents, sandbox and presets', () => {
  const config = buildManagerConfig({
    personalWorkspace: 'C:/ws/personal',
    brainWorkspace: 'C:/ws/brain',
    personalPort: 3081,
    brainPort: 3082,
    dshBin: 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
    personalProfile: 'ohdsh-personal',
    brainProfile: 'ohdsh-brain',
    personalHome: 'C:/Users/me/.dsh-ohdsh/ohdsh-personal',
    brainHome: 'C:/Users/me/.dsh-ohdsh/ohdsh-brain',
  })
  const ep = config.endpoints as Record<string, Record<string, unknown>>
  const spawn = (id: string) => (ep[id]?.spawn ?? {}) as Record<string, unknown>
  assert.equal(ep['personal_node']?.url, 'http://127.0.0.1:3081')
  assert.equal(ep['brain_node']?.url, 'http://127.0.0.1:3082')
  assert.deepEqual(spawn('brain_node').args, ['C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'ohdsh-brain'])
  assert.deepEqual(spawn('personal_node').env, { DSH_HOME: 'C:/Users/me/.dsh-ohdsh/ohdsh-personal' })
  assert.deepEqual(spawn('brain_node').env, { DSH_HOME: 'C:/Users/me/.dsh-ohdsh/ohdsh-brain' })
  // 每节点独立 gateway 密钥（分 ref 引用）
  assert.equal(ep['personal_node']?.sandbox_key_ref, 'GW_KEY_A')
  assert.equal(ep['brain_node']?.sandbox_key_ref, 'GW_KEY_B')
  const agents = config.agents as Record<string, Record<string, unknown>>
  assert.equal(agents['personal']?.preset, 'standard')
  assert.equal(agents['personal']?.sandbox_mode, 'workspace-write')
  assert.equal(agents['brain']?.endpoint, 'brain_node')
})

test('ensureNodeProfiles writes one isolated DSH_HOME per node, idempotently', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'setup-nodes-home-'))
  try {
    const specs = [
      { name: 'ohdsh-personal', port: 3081 },
      { name: 'ohdsh-brain', port: 3082 },
    ]
    const created = ensureNodeProfiles(nodesHome, specs, 'github:litestartup-com/dsh-api-gateway')
    assert.deepEqual(created.sort(), [join(nodesHome, 'ohdsh-personal'), join(nodesHome, 'ohdsh-brain')].sort())
    for (const spec of specs) {
      const dir = join(nodesHome, spec.name, 'profiles', spec.name)
      const patch = parseYaml(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: { port: number; host: string } }>
      assert.equal(patch[0]?.id, 'webserver')
      assert.equal(patch[0]?.config.port, spec.port)
      assert.equal(patch[0]?.config.host, '127.0.0.1')
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
        dependencies: Record<string, string>
      }
      assert.ok(pkg.dsh.profile.bundles.includes('dsh-api-gateway'))
      assert.equal(pkg.dependencies['dsh-api-gateway'], 'github:litestartup-com/dsh-api-gateway')
    }
    // 幂等：第二次不重建、不报错
    assert.deepEqual(ensureNodeProfiles(nodesHome, specs, 'github:litestartup-com/dsh-api-gateway'), [])
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('ensureNodeProfiles writes a file: dependency when given a local gateway path', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'setup-nodes-home-local-'))
  try {
    ensureNodeProfiles(nodesHome, [{ name: 'ohdsh-personal', port: 3081 }], 'file:C:/src/dsh-api-gateway')
    const pkg = JSON.parse(readFileSync(join(nodesHome, 'ohdsh-personal', 'profiles', 'ohdsh-personal', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    assert.equal(pkg.dependencies['dsh-api-gateway'], 'file:C:/src/dsh-api-gateway')
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})

test('ensureNodeCredentials copies the model key once, never overwriting', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-cred-'))
  const main = join(root, 'main')
  const node = join(root, 'node')
  try {
    mkdirSync(main, { recursive: true })
    writeFileSync(join(main, '.credentials.yaml'), 'provider: x\n', 'utf8')
    assert.equal(ensureNodeCredentials(main, node), true)
    assert.equal(readFileSync(join(node, '.credentials.yaml'), 'utf8'), 'provider: x\n')
    // 已有凭据不覆盖
    writeFileSync(join(node, '.credentials.yaml'), 'provider: mine\n', 'utf8')
    assert.equal(ensureNodeCredentials(main, node), false)
    assert.equal(readFileSync(join(node, '.credentials.yaml'), 'utf8'), 'provider: mine\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveGatewayKey reuses the provisioned key, else mints and appends apiKeys', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-key-'))
  const settings = join(home, 'settings.yaml')
  try {
    writeFileSync(settings, stringifyYaml({ 'dsh-api-gw': { enabled: true, provisionedKey: 'apigw-existing' } }), 'utf8')
    assert.equal(resolveGatewayKey(home, settings), 'apigw-existing')

    rmSync(settings)
    const minted = resolveGatewayKey(home, settings)
    assert.match(minted, /^apigw-[0-9a-f]{48}$/)
    const parsed = parseYaml(readFileSync(settings, 'utf8')) as { 'dsh-api-gw': { apiKeys: string[] } }
    assert.deepEqual(parsed['dsh-api-gw'].apiKeys, [minted])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('mergeEnv fills missing values and never overwrites existing ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-'))
  const env = join(dir, '.env')
  try {
    const merged = mergeEnv(env, { SESSION_SECRET: 'new-secret', GW_KEY_A: 'new-key' })
    assert.equal(merged.SESSION_SECRET, 'new-secret')

    const again = mergeEnv(env, { SESSION_SECRET: 'other', BRAIN_TOKEN: 'token-1' })
    assert.equal(again.SESSION_SECRET, 'new-secret', 'existing value survives')
    assert.equal(again.BRAIN_TOKEN, 'token-1')
    assert.ok(existsSync(env))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeEnv forceKeys overrides stale values (setup-owned secrets must match node settings)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-env-force-'))
  const env = join(dir, '.env')
  try {
    mergeEnv(env, { GW_KEY_A: 'old-key', GW_KEY_B: 'old-b' })
    const again = mergeEnv(env, { GW_KEY_A: 'new-key', GW_KEY_B: 'new-b', SESSION_SECRET: 's' }, ['GW_KEY_A', 'GW_KEY_B'])
    assert.equal(again.GW_KEY_A, 'new-key')
    assert.equal(again.GW_KEY_B, 'new-b')
    assert.equal(again.SESSION_SECRET, 's')
    // 非 force 键仍是旧值优先
    const third = mergeEnv(env, { SESSION_SECRET: 'later' }, ['GW_KEY_A', 'GW_KEY_B'])
    assert.equal(third.SESSION_SECRET, 's')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
