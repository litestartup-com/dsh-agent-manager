import assert from 'node:assert/strict'
import test from 'node:test'
import { money, moneyAdaptive, uniqueFrames } from './ui.js'

test('a live snapshot and its buffered copy produce one user frame', () => {
  const user = { kind: 'user', text: '你好', at: 1 }
  assert.deepEqual(uniqueFrames([user, { ...user }]), [user])
})

// 债务 F8:前端测试补课——money 全站单一实现(债务 F2)的精度行为直测。
test('债务 F2 回归: money 默认 4 位小数,digits 参数给紧凑卡片', () => {
  assert.equal(money(12_340_000), '$12.3400')
  assert.equal(money(12_340_000, 2), '$12.34')
  assert.equal(money(null), '—')
})

test('债务 F2 回归: moneyAdaptive 按量级自适应精度(几分钱不显示成 $0.00)', () => {
  assert.equal(moneyAdaptive(0), '$0')
  assert.equal(moneyAdaptive(5_000), '$0.0050')
  assert.equal(moneyAdaptive(500_000), '$0.500')
  assert.equal(moneyAdaptive(12_340_000), '$12.34')
  assert.equal(moneyAdaptive(null), '—')
})
