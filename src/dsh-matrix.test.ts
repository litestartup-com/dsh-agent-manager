import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPAT_DSH_VERSION, GATEWAY_REF, SUPPORTED_DSH,
  defaultDshVersion, resolvePair, pairStatus, isSupportedDsh, dshCompatible,
} from './dsh-matrix.js'

test('债务 P3 回归: 默认版本 = 矩阵首行；首批两行 0.1.2-rc.1(verified) + 0.1.5-rc.2(pending)', () => {
  assert.equal(COMPAT_DSH_VERSION, '0.1.2-rc.1')
  assert.equal(defaultDshVersion(), '0.1.2-rc.1')
  assert.deepEqual(SUPPORTED_DSH.map((p) => p.dsh), ['0.1.2-rc.1', '0.1.5-rc.2'])
  assert.equal(SUPPORTED_DSH[0]?.status, 'verified')
  assert.equal(SUPPORTED_DSH[1]?.status, 'pending')
})

test('债务 P3 回归: resolvePair / pairStatus——已知配对回矩阵行，未知回 null', () => {
  assert.deepEqual(resolvePair('0.1.2-rc.1'), { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF, status: 'verified' })
  assert.equal(pairStatus('0.1.5-rc.2'), 'pending')
  assert.equal(pairStatus('0.1.1-rc.2'), null)
  assert.equal(resolvePair('0.9.9'), null)
})

test('债务 P3 回归: dshCompatible 升级为矩阵内判断（含未验证配对；v 前缀容忍）', () => {
  assert.equal(dshCompatible('0.1.2-rc.1'), true)
  assert.equal(dshCompatible('0.1.5-rc.2'), true, '矩阵内未验证版本 = 兼容（安装黄字警告由 pairStatus 决定）')
  assert.equal(dshCompatible('v0.1.2-rc.1'), true, 'v 前缀容忍')
  assert.equal(dshCompatible('0.1.1-rc.2'), false)
  assert.equal(dshCompatible(null), false)
  assert.equal(isSupportedDsh('0.1.5-rc.2'), true)
})
