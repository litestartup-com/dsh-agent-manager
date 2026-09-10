/**
 * 0.1.2 切主路：Windows 裸机节点升级（幂等，--dry-run 可预演）。
 *
 * 对 manager.config.yaml 里每个 process 托管节点：
 * 1. 节点 profile 换 facade：bundles/依赖 '@deepseek-ai/dsh-*' 升 COMPAT_DSH_VERSION、
 *    'dsh-api-gateway' → 'ohdsh-api-facade'（GATEWAY_REF），清 node_modules 后 npm install；
 * 2. 节点 settings.yaml：在 'ohdsh-api-facade' 命名空间铸/复用 apiKeys（旧 dsh-api-gw 段不动）；
 * 3. 全局 DSH：bin.js 所在 prefix 目录 npm install @deepseek-ai/dsh@COMPAT_DSH_VERSION（版本已对则跳过）；
 * 4. .env：把各节点新钥匙 force 写回对应的 sandbox_key_ref 变量（GW_KEY_A/B/…）。
 *
 * 不碰 manager.config.yaml（接线迁移归 upgrade-012.mjs）。
 * 用法：node scripts/upgrade-012-win.mjs [config路径] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const { parse: parseYaml, stringify: stringifyYaml } = require('yaml')
// 与 src/dsh-version.ts 保持一致（脚本独立运行，不依赖 ts 源码/构建产物）。
const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'
const COMPAT_DSH_VERSION = '0.1.2-rc.1'
const GATEWAY_PACKAGE = 'ohdsh-api-facade'
const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#91e53c1'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const positional = args.filter((a) => !a.startsWith('--'))
const configPath = positional[0] ?? 'manager.config.yaml'

// 预检：生产端口被占 = 栈还在跑，npm 清旧文件必 EPERM（2026-09-10 实测炸过
// 一半留半毁树）。要求先停栈，--force 跳过。
const BUSY_PORTS = [8080, 3081, 3082, 3090]
const portBusy = (p) => new Promise((resolveBusy) => {
  const probe = createServer()
  probe.once('error', () => resolveBusy(true))
  probe.once('listening', () => { probe.close(); resolveBusy(false) })
  probe.listen(p, '127.0.0.1')
})
if (!force && !dryRun) {
  const busy = []
  for (const p of BUSY_PORTS) if (await portBusy(p)) busy.push(p)
  if (busy.length > 0) {
    console.error(`upgrade-012-win: 端口 ${busy.join(', ')} 被占用——生产栈还在运行，升级会 EPERM 半途而废。`)
    console.error('先停栈：schtasks /end /tn OhdshManager，等节点进程退出后重跑本脚本。')
    process.exit(1)
  }
}
const log = (line) => console.log(`[upgrade-012-win] ${line}`)

const cfg = parseYaml(readFileSync(configPath, 'utf8'))
const actions = []

const backup = (path) => {
  const bak = `${path}.pre-012.bak`
  if (!existsSync(bak)) {
    if (!dryRun) writeFileSync(bak, readFileSync(path, 'utf8'), 'utf8')
    log(`备份 ${path} → ${bak}`)
  }
}

const npmCmd = process.platform === 'win32' ? 'npm' : 'npm'
const npm = (cwd, args) => {
  log(`npm ${args.join(' ')} (cwd ${cwd})`)
  if (dryRun) return
  execFileSync(npmCmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

// ---- 1/2/3: 节点 profile + settings + 全局 DSH ----
const dshPrefixes = new Set()
const keyByVar = new Map()
for (const [id, ep] of Object.entries(cfg.endpoints ?? {})) {
  // schema 默认 runner='process'：原始 yaml 常省略该字段
  const runner = ep?.spawn?.runner ?? 'process'
  if (runner !== 'process') continue
  const home = ep.spawn.env?.DSH_HOME
  const binPath = ep.spawn.args?.[0]
  if (typeof home !== 'string' || typeof binPath !== 'string') continue
  const profileIdx = (ep.spawn.args ?? []).indexOf('--profile')
  const profileName = profileIdx >= 0 ? ep.spawn.args[profileIdx + 1] : null
  if (profileName === null || typeof profileName !== 'string') continue

  const profileDir = join(home, 'profiles', profileName)
  if (!existsSync(join(profileDir, 'package.json'))) {
    log(`⚠ 节点 ${id}: ${profileDir}/package.json 不存在，跳过（外管节点？）`)
    continue
  }
  // 1) profile 换 facade
  const pkgPath = join(profileDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = { '@deepseek-ai/dsh-base': COMPAT_DSH_VERSION, '@deepseek-ai/dsh-web-app': COMPAT_DSH_VERSION, [GATEWAY_PACKAGE]: GATEWAY_REF }
  const next = { ...pkg, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', GATEWAY_PACKAGE] } }, dependencies: deps }
  if (JSON.stringify(pkg) !== JSON.stringify(next)) {
    actions.push(`节点 ${id}: profile 依赖换 facade + bundle 钉 ${COMPAT_DSH_VERSION}`)
    backup(pkgPath)
    if (!dryRun) writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    if (!dryRun) rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
    npm(profileDir, ['install', '--no-audit', '--no-fund'])
  } else {
    log(`节点 ${id}: profile 已是最新，跳过`)
  }

  // 2) settings.yaml 铸/复用 facade 钥匙
  const settingsPath = join(home, 'settings.yaml')
  const settings = existsSync(settingsPath) ? parseYaml(readFileSync(settingsPath, 'utf8')) ?? {} : {}
  const ns = settings[GATEWAY_PACKAGE] ?? {}
  let key = typeof ns.provisionedKey === 'string' && ns.provisionedKey !== '' ? ns.provisionedKey
    : (Array.isArray(ns.apiKeys) ? ns.apiKeys.find((k) => k !== '') : undefined)
  if (key === undefined) {
    key = 'apigw-' + randomBytes(24).toString('hex')
    settings[GATEWAY_PACKAGE] = { ...ns, apiKeys: [...(Array.isArray(ns.apiKeys) ? ns.apiKeys : []), key] }
    backup(settingsPath)
    if (!dryRun) writeFileSync(settingsPath, stringifyYaml(settings), 'utf8')
    actions.push(`节点 ${id}: 铸新钥匙写入 ${GATEWAY_PACKAGE} 段`)
  } else {
    log(`节点 ${id}: 复用现有钥匙（${GATEWAY_PACKAGE}）`)
  }
  if (typeof ep.sandbox_key_ref === 'string' && ep.sandbox_key_ref !== '') keyByVar.set(ep.sandbox_key_ref, key)

  // 3) 全局 DSH prefix（bin.js 所在安装目录）
  const marker = '/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const normalizedBin = binPath.replace(/\\/g, '/')
  if (normalizedBin.endsWith(marker)) dshPrefixes.add(normalizedBin.slice(0, -marker.length))
}

// ---- 4) .env 钥匙同步 ----
if (keyByVar.size > 0) {
  const envPath = join(dirname(resolve(configPath)), '.env')
  if (existsSync(envPath)) {
    const envLines = readFileSync(envPath, 'utf8').split(/\r?\n/)
    const seen = new Set()
    let touched = false
    for (let i = 0; i < envLines.length; i += 1) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(envLines[i])
      if (m !== null && keyByVar.has(m[1])) {
        envLines[i] = `${m[1]}=${keyByVar.get(m[1])}`
        seen.add(m[1])
        touched = true
      }
    }
    for (const [name, value] of keyByVar) {
      if (!seen.has(name)) { envLines.push(`${name}=${value}`); touched = true }
    }
    if (touched) {
      actions.push('.env: GW_KEY_* 同步为新钥匙')
      backup(envPath)
      if (!dryRun) writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8')
    }
  } else {
    log('⚠ .env 不存在，跳过钥匙同步')
  }
}

// ---- 全局 DSH 升级 ----
for (const prefix of dshPrefixes) {
  const manifestPath = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).version : '缺失'
  if (current === COMPAT_DSH_VERSION) {
    log(`全局 DSH 已是 ${COMPAT_DSH_VERSION}，跳过`)
  } else {
    actions.push(`全局 DSH: ${current} → ${COMPAT_DSH_VERSION}`)
    npm(prefix, ['install', `${COMPAT_DSH_PACKAGE}@${COMPAT_DSH_VERSION}`, '--no-audit', '--no-fund'])
  }
}

console.log('')
console.log(dryRun ? '[dry-run] 预演完成，将执行以下动作：' : '执行完成：')
if (actions.length === 0) console.log('  （无变化——已是 0.1.2 接线）')
for (const a of actions) console.log('  - ' + a)
if (!dryRun && actions.length > 0) {
  console.log('')
  console.log('下一步：schtasks /run /tn OhdshManager（脚本运行前已要求停栈；等待 ~60 秒后验收四端口 + facade health）')
}
