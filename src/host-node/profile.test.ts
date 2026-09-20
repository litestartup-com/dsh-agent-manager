import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileFiles, profileDependencies, dshBinInProfile } from './profile.js'
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
