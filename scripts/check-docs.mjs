// scripts/check-docs.mjs — CI 门禁（蜂群2计划 P0）：
// 1) README.md 的仓库内 markdown 链接必须指向存在的文件（外部 http/mailto 链接不校验）；
// 2) README/CHANGELOG 禁止手写测试数（数字由 CI 断言，禁绝漂移）。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

// ---- 1) 死链：仓库内相对链接必须解析到真实文件 ----
for (const rel of ['README.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1].trim()
    if (target === '' || /^(https?:|mailto:)/i.test(target)) continue
    const path = resolve(root, target.replace(/^\.\//, ''))
    if (!existsSync(path)) failures.push(`${rel}: 死链 \`${target}\``)
  }
}

// ---- 2) 手写测试数：README/CHANGELOG 不得出现「N 测试/tests」字样 ----
for (const rel of ['README.md', 'CHANGELOG.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  const hits = text.match(/\d{2,4}\s*(tests?|测试|用例)/gi) ?? []
  if (hits.length > 0) failures.push(`${rel}: 手写测试数（禁绝）→ ${hits.join(', ')}`)
}

if (failures.length > 0) {
  console.error('check-docs FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-docs: OK（README 无死链、无手写测试数）')
