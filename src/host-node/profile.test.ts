import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileFiles, profileDependencies, dshBinInProfile, ensureNodeProfiles, profileSeed, currentProfileSeed, profileDrift } from './profile.js'
import { COMPAT_DSH_VERSION, GATEWAY_PACKAGE, GATEWAY_REF } from '../dsh-version.js'

test('能力一回归: profile 依赖含 @deepseek-ai/dsh 自身（隔离安装后不依赖全局 dsh）', () => {
  const deps = profileDependencies()
  assert.equal(deps['@deepseek-ai/dsh'], COMPAT_DSH_VERSION, 'dsh 包钉兼容版本')
  assert.equal(deps['@deepseek-ai/dsh-base'], COMPAT_DSH_VERSION)
  assert.equal(deps['@deepseek-ai/dsh-web-app'], COMPAT_DSH_VERSION)
  assert.equal(deps[GATEWAY_PACKAGE], GATEWAY_REF)
})

test('能力一回归: profileFiles 的 package.json 携带 dsh 依赖与 bundles 清单', () => {
  const files = profileFiles({ name: 'worker', port: 3083 }, GATEWAY_REF)
  const pkg = JSON.parse(files['package.json'] ?? '{}')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh'], COMPAT_DSH_VERSION)
  assert.ok(Array.isArray(pkg.dsh?.profile?.bundles), 'bundles 清单保留')
  assert.ok(pkg.dsh.profile.bundles.includes(GATEWAY_PACKAGE))
  // patch 仍绑 loopback + 节点端口（stringifyYaml 输出不带引号）
  assert.match(files['cordis.patch.yml'] ?? '', /host: 127\.0\.0\.1/)
  assert.match(files['cordis.patch.yml'] ?? '', /port: 3083/)
})

test('能力一回归: dshBinInProfile——隔离安装后指向 profile 内 bin，未装则 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-node-'))
  try {
    assert.equal(dshBinInProfile(join(dir, 'nope')), null, '未安装 = null')
    const binDir = join(dir, 'profiles', 'worker', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'bin.js'), '', 'utf8')
    assert.equal(dshBinInProfile(join(dir, 'profiles', 'worker')), join(binDir, 'bin.js'), '指向 profile 内 bin.js')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力二回归: .seed-version 标记与漂移判定——生成即带标记，版本/ref 变化即漂移', () => {
  const nodesHome = mkdtempSync(join(tmpdir(), 'host-node-seed-'))
  try {
    ensureNodeProfiles(nodesHome, [{ name: 'worker', port: 3083 }], GATEWAY_REF)
    const profileDir = join(nodesHome, 'worker', 'profiles', 'worker')
    const marker = join(profileDir, '.seed-version')
    assert.ok(readFileSync(marker, 'utf8').trim().length === 40, '生成即带 sha1 标记')
    assert.equal(currentProfileSeed(profileDir), profileSeed(COMPAT_DSH_VERSION, GATEWAY_REF))
    assert.equal(profileDrift(profileDir, COMPAT_DSH_VERSION, GATEWAY_REF), false, '同版本同 ref = 无漂移')
    assert.equal(profileDrift(profileDir, '0.1.5-rc.2', GATEWAY_REF), true, '版本变化 = 漂移')
    assert.equal(profileDrift(profileDir, COMPAT_DSH_VERSION, 'github:litestartup-com/dsh-api-gateway#deadbeef'), true, 'ref 变化 = 漂移')
    // 未生成过（目录存在但无标记）= 视同漂移（存量老 profile 对齐入口）
    const legacy = join(nodesHome, 'legacy', 'profiles', 'legacy')
    mkdirSync(legacy, { recursive: true })
    assert.equal(profileDrift(legacy, COMPAT_DSH_VERSION, GATEWAY_REF), true, '无标记的存量 profile = 漂移')
  } finally {
    rmSync(nodesHome, { recursive: true, force: true })
  }
})
