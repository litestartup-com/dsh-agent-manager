import assert from 'node:assert/strict'
import test from 'node:test'
import { uniqueFrames } from './ui.js'

test('a live snapshot and its buffered copy produce one user frame', () => {
  const user = { kind: 'user', text: '你好', at: 1 }
  assert.deepEqual(uniqueFrames([user, { ...user }]), [user])
})
