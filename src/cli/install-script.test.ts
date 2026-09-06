import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 蜂群2计划 P6 回归：install.ps1 必须带 UTF-8 BOM。
 *
 * 实测现场：Windows PowerShell 5.1（官方推荐执行路径）对无 BOM 的 .ps1
 * 按 ANSI 代码页（中文系统 = GBK）解码——脚本里的中文串全部乱码，
 * 乱码字节又恰巧含引号/括号字节 → ParserError，脚本根本无法启动。
 * BOM 让 PS5.1 按 UTF-8 解码，问题消失。
 */
test('install.ps1 starts with a UTF-8 BOM so Windows PowerShell 5.1 can parse it', () => {
  const bytes = readFileSync(join(root, 'install.ps1'))
  assert.deepEqual(
    [bytes[0], bytes[1], bytes[2]],
    [0xef, 0xbb, 0xbf],
    'install.ps1 必须以 UTF-8 BOM 开头（否则 PS5.1 实测 ParserError）',
  )
  // BOM 之后必须是合法 UTF-8，杜绝半吊子编码
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
})
