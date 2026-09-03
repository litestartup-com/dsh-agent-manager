import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { buildManagerConfig, ensureNodeProfiles, mergeEnv, resolveGatewayKey } from './setup.js'

test('buildManagerConfig wires two managed nodes, agents, sandbox and presets', () => {
  const config = buildManagerConfig({
    personalWorkspace: 'C:/ws/personal',
    brainWorkspace: 'C:/ws/brain',
    personalPort: 3081,
    brainPort: 3082,
    dshBin: 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
    personalProfile: 'ohdsh-personal',
    brainProfile: 'ohdsh-brain',
  })
  const ep = config.endpoints as Record<string, Record<string, unknown>>
  const spawn = (id: string) => (ep[id]?.spawn ?? {}) as Record<string, unknown>
  assert.equal(ep['personal_node']?.url, 'http://127.0.0.1:3081')
  assert.equal(ep['brain_node']?.url, 'http://127.0.0.1:3082')
  assert.deepEqual(spawn('brain_node').args, ['C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'ohdsh-brain'])
  const agents = config.agents as Record<string, Record<string, unknown>>
  assert.equal(agents['personal']?.preset, 'standard')
  assert.equal(agents['personal']?.sandbox_mode, 'workspace-write')
  assert.equal(agents['brain']?.endpoint, 'brain_node')
})

test('ensureNodeProfiles writes web-style profiles with a port patch, idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-dsh-home-'))
  try {
    const specs = [
      { name: 'ohdsh-personal', port: 3081 },
      { name: 'ohdsh-brain', port: 3082 },
    ]
    const created = ensureNodeProfiles(home, specs)
    assert.equal(created.length, 2)
    for (const spec of specs) {
      const dir = join(home, 'profiles', spec.name)
      const patch = parseYaml(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: { port: number; host: string } }>
      assert.equal(patch[0]?.id, 'webserver')
      assert.equal(patch[0]?.config.port, spec.port)
      assert.equal(patch[0]?.config.host, '127.0.0.1')
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      assert.ok(pkg.dsh.profile.bundles.includes('dsh-api-gateway'))
    }
    // 幂等：第二次不重建、不报错
    assert.deepEqual(ensureNodeProfiles(home, specs), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
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
