import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureGuiToken } from './gui-token.js'

test('债务 P1 回归: 0.1.5 token 行捕获(启动行含 ?token=)', () => {
  const logs = [
    'profile seeded into /data/profiles/ohdsh-node (seed 25f00fc3)',
    'dsh web: http://127.0.0.1:3080/?token=BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg (LAN: http://172.17.0.2:3080/?token=BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg)',
  ].join('\n')
  assert.deepEqual(captureGuiToken(logs), { found: true, token: 'BMJaU1Hgo6ZMqG8ak-exj31Hy9i0KPFq3H424qcESyg' })
})

test('债务 P1 回归: 0.1.2 及以下无 token 行(裸 URL = GUI 已就绪、无需鉴权参数)', () => {
  const logs = 'dsh web: http://127.0.0.1:3080 (LAN: http://172.17.0.2:3080)'
  assert.deepEqual(captureGuiToken(logs), { found: true, token: null })
})

test('债务 P1 回归: 重启轮换——最后一次出现的 token 是当前态', () => {
  const logs = [
    'dsh web: http://127.0.0.1:3080/?token=old-token',
    'restarted...',
    'dsh web: http://127.0.0.1:3080/?token=new-token-2',
  ].join('\n')
  assert.deepEqual(captureGuiToken(logs), { found: true, token: 'new-token-2' })
})

test('债务 P1 回归: 尚无启动行 = 未捕获(GUI 还在启动)', () => {
  assert.deepEqual(captureGuiToken('random log lines\nno url here'), { found: false, token: null })
  assert.deepEqual(captureGuiToken(''), { found: false, token: null })
})
