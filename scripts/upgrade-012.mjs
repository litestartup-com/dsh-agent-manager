/**
 * 0.1.2 切主路：manager.config.yaml 一次性接线迁移（幂等，可反复跑）。
 *
 * 规则（对每个 endpoints 段）：
 * - `prefix: /api` → `/api-gw/v1/proxy`（已迁移则跳过，其它值保持并告警）；
 * - `key_ref` 为空时取同段 `sandbox_key_ref` 的值（同一把门钥匙，语义一致）；
 *   sandbox_key_ref 也为空 → 该端点无法迁移，列出并退出码 2（大声失败）。
 *
 * 备份：首次运行前把原文件拷为 <config>.pre-012.bak（已存在不覆盖）。
 * 用法：node scripts/upgrade-012.mjs [config路径]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const configPath = process.argv[2] ?? 'manager.config.yaml'
if (!existsSync(configPath)) {
  console.error(`upgrade-012: ${configPath} not found`)
  process.exit(1)
}
const original = readFileSync(configPath, 'utf8')
const lines = original.split(/\r?\n/)

// 只在 endpoints 段内扫描（段边界：'endpoints:' 到下一个顶层键，通常 'agents:'）
const sectionStart = lines.findIndex((l) => /^endpoints:\s*$/.test(l))
if (sectionStart === -1) {
  console.error('upgrade-012: no endpoints: section found — nothing to do')
  process.exit(1)
}
let sectionEnd = lines.length
for (let i = sectionStart + 1; i < lines.length; i += 1) {
  if (/^[a-zA-Z]/.test(lines[i])) { sectionEnd = i; break }
}

const endpointLine = (l) => /^  [\w-]+:\s*$/.test(l)
const field = (l) => {
  const m = /^    ([\w-]+):\s*(.*)$/.exec(l)
  return m === null ? null : { name: m[1], value: m[2] }
}

let changed = false
const report = []
let current = null
for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
  const line = lines[i]
  if (endpointLine(line)) {
    current = { name: line.trim().replace(/:$/, ''), sandboxKey: '', hadPrefixChange: false, prefix: '' }
    report.push(current)
    continue
  }
  if (current === null) continue
  const f = field(line)
  if (f === null) continue
  if (f.name === 'sandbox_key_ref') current.sandboxKey = f.value.replace(/^"(.*)"$/, '$1')
  if (f.name === 'prefix') {
    current.prefix = f.value
    if (f.value === '/api') {
      lines[i] = '    prefix: /api-gw/v1/proxy'
      current.hadPrefixChange = true
      changed = true
    }
  }
  if (f.name === 'key_ref' && f.value === '""') {
    // 置空标记：sandbox_key_ref 已在同一段扫描到（key_ref 位于其前时先置空后回填）
    current.keyLine = i
  }
}

const missing = []
for (const ep of report) {
  if (ep.keyLine !== undefined) {
    if (ep.sandboxKey === '') {
      missing.push(ep.name)
    } else {
      lines[ep.keyLine] = `    key_ref: ${ep.sandboxKey}`
      changed = true
    }
  }
}

if (missing.length > 0) {
  console.error(`upgrade-012: 这些端点没有 sandbox_key_ref，无法自动接 key（请人工配 key_ref）：${missing.join(', ')}`)
  process.exit(2)
}

for (const ep of report) {
  console.log(`  ${ep.name}: prefix=${ep.hadPrefixChange ? '/api-gw/v1/proxy (已迁)' : ep.prefix === '/api-gw/v1/proxy' ? '已迁移' : ep.prefix}${ep.keyLine !== undefined ? ` key_ref=${ep.sandboxKey}` : ''}`)
}

if (!changed) {
  console.log('upgrade-012: 配置已是 0.1.2 接线，无需改动')
} else {
  const bak = `${configPath}.pre-012.bak`
  if (!existsSync(bak)) writeFileSync(bak, original, 'utf8')
  writeFileSync(configPath, lines.join('\n'), 'utf8')
  console.log(`upgrade-012: 已写入 ${configPath}（原文件备份于 ${bak}）`)
}
