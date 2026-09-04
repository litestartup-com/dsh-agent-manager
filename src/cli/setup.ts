import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { initWorkspace } from '../workspace/init.js'

/**
 * `npm run setup -- [选项]` — 蜂群 P4：默认安装。
 *
 * 一条命令把「单主机多节点」搭起来：
 *   1. 初始化个人与主脑两个工作区（模板幂等，绝不覆盖已有文件）
 *   2. 在 $DSH_HOME/profiles 下生成两个节点 profile（web 同款 bundle + 端口 patch）
 *   3. 解析 gateway 密钥（settings.yaml 的 provisionedKey，或生成并追加 apiKeys）
 *   4. 生成 .env（SESSION_SECRET / GW_KEY_A / BRAIN_TOKEN，幂等保留旧值）
 *   5. 生成 manager.config.yaml（两个托管节点 + 两个 agent + 沙箱/pre-set 全接）
 *
 * 前置：本机已装 DSH（$DSH_HOME 存在且有 credentials）、node / pnpm / git 在 PATH。
 */

interface SetupOptions {
  personalWorkspace: string
  brainWorkspace: string
  personalPort: number
  brainPort: number
  /** 主 DSH_HOME（GUI/日常用），只用于取模型凭据副本。 */
  dshHome: string
  /** 节点目录根：每个节点一个独立 DSH_HOME，会话/settings/附件完全隔离。 */
  nodesHome: string
  dshBin: string | null
  installProfiles: boolean
  /** 本地 gateway 包路径（file: 依赖，离线安装）；null = 用 GitHub 引用。 */
  gatewayLocal: string | null
  force: boolean
}

interface ProfileSpec {
  name: string
  port: number
}

const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-api-gateway']

const profileFiles = (spec: ProfileSpec, gatewayDep: string): Record<string, string> => {
  const pkg = {
    name: `dsh-profile-${spec.name}`,
    private: true,
    dsh: { profile: { bundles: PROFILE_BUNDLES } },
    dependencies: { 'dsh-api-gateway': gatewayDep },
  }
  const patch = [
    {
      id: 'webserver',
      config: {
        // 整行 config 替换（无深度合并，README 原话）：节点永远只绑回环。
        host: '127.0.0.1',
        port: spec.port,
      },
    },
  ]
  return {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'pnpm-workspace.yaml': 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    'cordis.yml': '# dsh profile root — empty entry list; edit cordis.patch.yml\n[]\n',
    'cordis.patch.yml': stringifyYaml(patch),
  }
}

/**
 * 在 nodesHome 下为每个节点生成独立 DSH_HOME（<nodesHome>/<name>/profiles/<name>）。
 * 节点目录已存在则不动。
 */
export const ensureNodeProfiles = (nodesHome: string, specs: ProfileSpec[], gatewayDep: string): string[] => {
  mkdirSync(nodesHome, { recursive: true })
  const created: string[] = []
  for (const spec of specs) {
    const nodeHome = join(nodesHome, spec.name)
    const dir = join(nodeHome, 'profiles', spec.name)
    if (existsSync(dir)) continue
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(profileFiles(spec, gatewayDep))) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    created.push(nodeHome)
  }
  return created
}

/** 把主 DSH_HOME 的模型凭据复制进节点目录（同一用户同一把 key，缺省不覆盖）。 */
export const ensureNodeCredentials = (mainDshHome: string, nodeHome: string): boolean => {
  const source = join(mainDshHome, '.credentials.yaml')
  const target = join(nodeHome, '.credentials.yaml')
  if (!existsSync(source) || existsSync(target)) return false
  mkdirSync(nodeHome, { recursive: true })
  writeFileSync(target, readFileSync(source, 'utf8'), 'utf8')
  return true
}

/** 解析 DSH 命令所在目录：优先 $DSH_BIN，其次 `where dsh` 的 .ps1 包装器。 */
export const detectDshBin = (dshHome: string, override: string | null): string => {
  const fromEnv = override ?? process.env.DSH_BIN ?? null
  if (fromEnv !== null && fromEnv !== '' && existsSync(fromEnv)) return resolve(fromEnv)
  try {
    const found = execFileSync('where', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')[0]
    if (found !== undefined && /\.ps1$/i.test(found)) {
      const candidate = join(dirname(found), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(candidate)) return resolve(candidate)
    }
  } catch {
    // `where` 找不到 dsh：继续按常见位置猜测
  }
  const guesses = [
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const guess of guesses) if (existsSync(guess)) return resolve(guess)
  throw new Error('找不到 DSH 的 bin.js：请用 --dsh-bin 指定（node 直接跑该文件 + --profile <名>）')
}

/**
 * 解析 gateway 密钥：优先 settings.yaml 里 dsh-api-gw 的 provisionedKey；
 * 没有则生成一个并追加到 apiKeys（gateway 的静态密钥数组，settings live 生效）。
 */
export const resolveGatewayKey = (dshHome: string, settingsPath: string | null): string => {
  const path = settingsPath ?? join(dshHome, 'settings.yaml')
  if (existsSync(path)) {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as { 'dsh-api-gw'?: { provisionedKey?: string; apiKeys?: string[] } }
    const section = parsed['dsh-api-gw']
    if (typeof section?.provisionedKey === 'string' && section.provisionedKey !== '') return section.provisionedKey
    const keys = Array.isArray(section?.apiKeys) ? section.apiKeys.filter((k) => k !== '') : []
    const first = keys[0]
    if (first !== undefined) return first
  }
  const minted = 'apigw-' + randomBytes(24).toString('hex')
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
  const section = (parsed['dsh-api-gw'] ?? {}) as Record<string, unknown>
  const apiKeys = Array.isArray(section.apiKeys) ? [...section.apiKeys, minted] : [minted]
  parsed['dsh-api-gw'] = { ...section, apiKeys }
  writeFileSync(path, stringifyYaml(parsed), 'utf8')
  return minted
}

/** .env 合并：已有的值绝不覆盖。返回最终的 env 记录。 */
export const mergeEnv = (path: string, values: Record<string, string>): Record<string, string> => {
  const existing: Record<string, string> = {}
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
      if (match !== null && match[1] !== undefined && match[2] !== undefined && match[2] !== '') {
        existing[match[1]] = match[2]
      }
    }
  }
  const merged = { ...values, ...existing }
  const content = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  writeFileSync(path, content + '\n', 'utf8')
  return merged
}

/** 生成 manager.config.yaml 的配置对象（纯函数，可单测）。 */
export const buildManagerConfig = (options: {
  personalWorkspace: string
  brainWorkspace: string
  personalPort: number
  brainPort: number
  dshBin: string
  personalProfile: string
  brainProfile: string
  /** 各节点自己的 DSH_HOME：会话/settings/附件完全隔离（蜂群 v1.1）。 */
  personalHome: string
  brainHome: string
}): Record<string, unknown> => {
  const endpoint = (port: number, profile: string, home: string, keyRef: string) => ({
    url: `http://127.0.0.1:${port}`,
    driver: 'apiproxy',
    prefix: '/api',
    key_ref: '',
    sandbox_base: `http://127.0.0.1:${port}/api-gw/v1`,
    sandbox_key_ref: keyRef,
    spawn: {
      managed: true,
      command: 'node',
      args: [options.dshBin, '--profile', profile],
      ready_timeout_ms: 30_000,
      env: { DSH_HOME: home },
    },
  })
  return {
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: {
      personal_node: endpoint(options.personalPort, options.personalProfile, options.personalHome, 'GW_KEY_A'),
      brain_node: endpoint(options.brainPort, options.brainProfile, options.brainHome, 'GW_KEY_B'),
    },
    agents: {
      personal: {
        name: '个人',
        endpoint: 'personal_node',
        workspace: options.personalWorkspace,
        public: false,
        preset: 'standard',
        sandbox_mode: 'workspace-write',
      },
      brain: {
        name: '主脑',
        endpoint: 'brain_node',
        workspace: options.brainWorkspace,
        public: false,
        preset: 'standard',
        sandbox_mode: 'workspace-write',
      },
    },
    runner: {
      timeout_minutes: 15,
      silence_timeout_minutes: 5,
      max_consecutive_failures: 3,
      daily_budget_usd: 2.0,
    },
    database: { path: './data/manager.db' },
    pricing: {
      peak_windows_utc: [
        { start: '01:00', end: '04:00' },
        { start: '06:00', end: '10:00' },
      ],
      models: {
        'deepseek-v4-pro': {
          off_peak: { input: 0.66, output: 1.98, cache_read: 0.022 },
          peak: { input: 1.32, output: 3.96, cache_read: 0.044 },
        },
        'deepseek-v4-flash': {
          off_peak: { input: 0.22, output: 0.66, cache_read: 0.007 },
          peak: { input: 0.44, output: 1.32, cache_read: 0.014 },
        },
      },
    },
  }
}

const parseArgs = (argv: string[]): { options: SetupOptions; help: boolean } => {
  const defaults: SetupOptions = {
    personalWorkspace: './workspaces/personal',
    brainWorkspace: './workspaces/brain',
    personalPort: 3081,
    brainPort: 3082,
    dshHome: process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}/.dsh`,
    nodesHome: `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}/.dsh-ohdsh`,
    dshBin: null,
    installProfiles: true,
    gatewayLocal: null,
    force: false,
  }
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      i += 1
      return argv[i] ?? ''
    }
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--workspace') defaults.personalWorkspace = next()
    else if (arg === '--brain-workspace') defaults.brainWorkspace = next()
    else if (arg === '--ports') {
      const parts = next().split(',').map((n) => Number(n))
      const a = parts[0]
      const b = parts[1]
      if (a !== undefined && Number.isInteger(a) && a > 0) defaults.personalPort = a
      if (b !== undefined && Number.isInteger(b) && b > 0) defaults.brainPort = b
    } else if (arg === '--dsh-home') defaults.dshHome = next()
    else if (arg === '--nodes-home') defaults.nodesHome = next()
    else if (arg === '--dsh-bin') defaults.dshBin = next()
    else if (arg === '--gateway-local') defaults.gatewayLocal = next()
    else if (arg === '--no-install') defaults.installProfiles = false
    else if (arg === '--force') defaults.force = true
  }
  return { options: defaults, help }
}

const usage = (): void => {
  console.log('用法: npm run setup -- [--workspace 路径] [--brain-workspace 路径] [--ports 3081,3082] [--dsh-bin 路径] [--gateway-local 路径] [--nodes-home 路径] [--no-install] [--force]')
  console.log('  --gateway-local  用本地 dsh-api-gateway 目录做 file: 依赖（离线安装；缺省从 GitHub 拉）')
  console.log('  --nodes-home     节点目录根（每个节点一个独立 DSH_HOME，默认 ~/.dsh-ohdsh）')
}

const main = (): void => {
  const { options, help } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }
  const configPath = 'manager.config.yaml'

  // ---- 前置检查 -----------------------------------------------------------
  if (existsSync(configPath) && !options.force) {
    console.error(`已存在 ${configPath}。改配置请直接编辑；重装请加 --force（不会覆盖工作区，但会重写配置）。`)
    process.exit(2)
  }
  if (!existsSync(join(options.dshHome, '.credentials.yaml'))) {
    console.error(`未找到 ${options.dshHome}/.credentials.yaml —— 请先运行一次 DSH 并配置模型凭证，再执行 setup。`)
    process.exit(2)
  }

  // ---- 工作区（模板幂等，绝不覆盖已有文件） --------------------------------
  console.log('① 初始化工作区…')
  initWorkspace({ workspacePath: options.personalWorkspace, preset: 'personal' })
  initWorkspace({ workspacePath: options.brainWorkspace, preset: 'brain' })

  // ---- 节点 profile（每节点一个独立 DSH_HOME） -----------------------------
  console.log('② 生成节点目录与 profile…')
  const specs: ProfileSpec[] = [
    { name: 'ohdsh-personal', port: options.personalPort },
    { name: 'ohdsh-brain', port: options.brainPort },
  ]
  const gatewayDep =
    options.gatewayLocal === null
      ? 'github:litestartup-com/dsh-api-gateway'
      : `file:${resolve(options.gatewayLocal).replace(/\\/g, '/')}`
  console.log(`   gateway 依赖: ${gatewayDep}`)
  const nodeHomes = new Map<string, string>()
  for (const spec of specs) {
    nodeHomes.set(spec.name, join(options.nodesHome, spec.name))
  }
  for (const home of ensureNodeProfiles(options.nodesHome, specs, gatewayDep)) {
    console.log(`   节点目录已生成: ${home}`)
  }
  // 模型凭据：同一用户同一把 key，从主 DSH_HOME 复制（绝不覆盖已有）。
  for (const home of nodeHomes.values()) {
    if (ensureNodeCredentials(options.dshHome, home)) {
      console.log(`   凭据已复制到 ${home}`)
    }
  }
  const dshBin = detectDshBin(options.dshHome, options.dshBin)
  console.log(`   DSH bin: ${dshBin}`)
  // Windows 上 pnpm 是 .cmd 垫片：execFileSync 不经 shell 解析不到 'pnpm'，
  // 必须指向 pnpm.cmd（PowerShell 里用户能跑 pnpm，正是这个原因）。
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  if (options.installProfiles) {
    for (const [name, home] of nodeHomes) {
      const dir = join(home, 'profiles', name)
      try {
        execFileSync(pnpmCmd, ['install'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] })
      } catch (error) {
        const message = ((error as Error).message ?? String(error)).split('\n')[0] ?? ''
        console.error(`   pnpm install 失败于 ${dir}: ${message}`)
        if (message.includes('ENOENT')) {
          console.error('   找不到 pnpm 命令——请确认 pnpm 在 PATH（或稍后手动进入该目录执行 pnpm install）。')
        } else {
          console.error('   可稍后手动在该目录执行 pnpm install；GitHub 不通时改用 --gateway-local 指向本地 dsh-api-gateway 目录重跑 setup --force。')
        }
      }
    }
  }

  // ---- 密钥与 .env --------------------------------------------------------
  console.log('③ 生成密钥…')
  // 每个节点自己的 settings.yaml 里一把独立的 gateway 密钥；manager 分 ref 引用。
  const personalKey = resolveGatewayKey(nodeHomes.get('ohdsh-personal')!, null)
  const brainKey = resolveGatewayKey(nodeHomes.get('ohdsh-brain')!, null)
  mergeEnv('.env', {
    SESSION_SECRET: randomBytes(32).toString('hex'),
    GW_KEY_A: personalKey,
    GW_KEY_B: brainKey,
    BRAIN_TOKEN: randomBytes(24).toString('hex'),
  })

  // ---- manager 配置 -------------------------------------------------------
  console.log('④ 生成 manager.config.yaml…')
  const managerConfig = buildManagerConfig({
    personalWorkspace: resolve(options.personalWorkspace),
    brainWorkspace: resolve(options.brainWorkspace),
    personalPort: options.personalPort,
    brainPort: options.brainPort,
    dshBin,
    personalProfile: 'ohdsh-personal',
    brainProfile: 'ohdsh-brain',
    personalHome: nodeHomes.get('ohdsh-personal')!,
    brainHome: nodeHomes.get('ohdsh-brain')!,
  })
  writeFileSync(configPath, stringifyYaml(managerConfig), 'utf8')

  console.log('')
  console.log('完成。下一步：')
  console.log('  npm run build && npm start     # manager 启动时会自动拉起两个节点')
  console.log('  （节点状态：npm run nodes -- list；主脑入口在侧栏顶部）')
  console.log('  每个节点有独立 DSH_HOME（会话/settings/附件互不可见）：')
  for (const [name, home] of nodeHomes) console.log(`    ${name}: ${home}`)
  console.log(`  访问 http://127.0.0.1:8080（登录用户 ${process.env.MANAGER_USERNAME ?? 'admin'}）`)
}

// 只在被直接执行时运行（测试导入本模块时不应触发安装流程）。
const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) void main()
