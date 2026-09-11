import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./chat.js', import.meta.url), 'utf8')

test('optional composer controls are guarded before event binding', () => {
  assert.match(source, /if \(el\.access !== null\) \{\n  el\.access\.addEventListener/)
  assert.match(source, /if \(el\.model !== null\) \{\n  el\.model\.addEventListener/)
  assert.match(source, /if \(el\.context !== null && el\.contextPopover !== null && el\.contextWrap !== null\)/)
  assert.match(source, /if \(el\.settings !== null && el\.identity !== null\)/)
})
