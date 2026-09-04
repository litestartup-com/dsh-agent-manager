import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { DEFAULT_PRICING, parseUtcTime, type ModelPricing, type PricingTable } from './pricing.js'

dotenv.config()

const spawnSchema = z.object({
  // 蜂群 P1：manager 托管该节点的进程生命周期。false（默认）= 节点由外部拉起，
  // manager 只探活不管理（与现状一致，用户手动起的 DSH 不会被 manager 抢管）。
  managed: z.boolean().default(false),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  ready_timeout_ms: z.number().int().positive().default(30_000),
  // detached: true = 节点独立于拉起者存活（CLI `nodes up` 场景），必须配
  // log_file（stdout/stderr 落文件，pidfile 落 <log_file>.pid 供跨进程 down）。
  // manager 常驻启动用默认 false（节点随 manager 同生共死）。
  detached: z.boolean().default(false),
  log_file: z.string().optional(),
  // 蜂群 v1.1：节点的额外环境变量（典型：DSH_HOME 指向该节点自己的目录，
  // 会话/settings/附件与其它节点完全隔离）。
  env: z.record(z.string(), z.string()).optional(),
  restart: z
    .object({
      max_attempts: z.number().int().positive().default(3),
      base_delay_ms: z.number().int().nonnegative().default(1_000),
      max_delay_ms: z.number().int().nonnegative().default(30_000),
    })
    .default({ max_attempts: 3, base_delay_ms: 1_000, max_delay_ms: 30_000 }),
})

const endpointSchema = z.object({
  url: z.string().url(),
  driver: z.enum(['gateway', 'apiproxy']).default('gateway'),
  prefix: z.string().startsWith('/').default('/api-gw/v1'),
  key_ref: z.string().default(''),
  // 蜂群 P0：dsh-api-gateway 的 sandbox-mode 路由基址（方案 A 下与 /api 并存，
  // 指向 http://host:3080/api-gw/v1）。缺省 = 该端点不提供按会话沙箱模式。
  sandbox_base: z.string().url().optional(),
  sandbox_key_ref: z.string().default(''),
  // 蜂群 P1：节点进程生命周期（manager 拉起/停止/重启）。缺省 = 不托管。
  spawn: spawnSchema.optional(),
})

const agentSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  workspace: z.string().min(1),
  public: z.boolean().default(false),
  preset: z.string().optional(),
  // 蜂群 P0：按会话沙箱模式（经 gateway sandbox-mode 路由）。缺省 = 不覆盖，
  // 沿用 DSH 部署默认。
  sandbox_mode: z.enum(['read-only', 'workspace-write']).optional(),
  git_remote: z.string().optional(),
  // Left unset, the DSH profile's own default applies. Set per agent so a
  // cheap model can handle dictation while a stronger one writes the weekly
  // review.
  provider: z.string().optional(),
  model: z.string().optional(),
})

const rateSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
})

/**
 * Rates live in config because they change: DeepSeek repriced V4 mid-August 2026
 * and moved it to time-of-day billing at the same time. A model with no entry
 * here records tokens with a null cost, which surfaces as "rate not configured"
 * rather than a free run.
 */
const pricingSchema = z.object({
  peak_windows_utc: z
    .array(z.object({ start: z.string(), end: z.string() }))
    .default([]),
  models: z
    .record(
      z.object({
        off_peak: rateSchema,
        peak: rateSchema.optional(),
      }),
    )
    .default({}),
})

const fileSchema = z.object({
  listen: z
    .object({ host: z.string().default('127.0.0.1'), port: z.number().int().positive().default(8080) })
    .default({ host: '127.0.0.1', port: 8080 }),
  endpoints: z.record(endpointSchema).refine((v) => Object.keys(v).length > 0, {
    message: 'at least one endpoint is required',
  }),
  agents: z.record(agentSchema).refine((v) => Object.keys(v).length > 0, {
    message: 'at least one agent is required',
  }),
  runner: z
    .object({
      timeout_minutes: z.number().int().positive().default(15),
      // Cancels a turn that produces nothing at all for this long. Deliberately
      // much shorter than the total timeout: a working turn streams frames the
      // whole time, so silence means stopped, not slow -- usually blocked on a
      // prompt nobody can answer from here. 0 disables the backstop.
      silence_timeout_minutes: z.number().int().min(0).default(5),
      max_consecutive_failures: z.number().int().positive().default(3),
      // Auto-disable after repeated failures stops a job that keeps breaking. It
      // does nothing about a job that keeps succeeding expensively -- which is
      // the way scheduled work actually drains an account, quietly and on time.
      // Unset means no ceiling.
      daily_budget_usd: z.number().positive().optional(),
    })
    .default({ timeout_minutes: 15, silence_timeout_minutes: 5, max_consecutive_failures: 3 }),
  database: z.object({ path: z.string().min(1) }).default({ path: './data/manager.db' }),
  // 蜂群 P5.1：主脑派工（trigger=brain）的日预算熔断——超限拒绝并转述；
  // 人手动操作保持不拦。缺省 = 不设上限。
  brain: z
    .object({ daily_budget_usd: z.number().positive().optional() })
    .default({}),
  pricing: pricingSchema.optional(),
})

export interface ResolvedSpawnSpec {
  managed: boolean
  command: string
  args: string[]
  cwd: string | null
  readyTimeoutMs: number
  detached: boolean
  /** Absolute path for node stdout/stderr (and its pidfile), or null for in-memory capture. */
  logFile: string | null
  /** Extra env vars layered over the manager's own (典型：DSH_HOME 节点专属目录). */
  env: Record<string, string>
  restart: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
}

export interface ResolvedEndpoint {
  id: string
  url: string
  driver: 'gateway' | 'apiproxy'
  prefix: string
  /** Resolved from the env var named by `key_ref`. Never logged, never sent to a browser. */
  key: string
  /** Base URL of the gateway sandbox-mode surface; null = route unavailable. */
  sandboxBase: string | null
  /** Gateway key for the sandbox-mode route. Never logged, never sent to a browser. */
  sandboxKey: string
  /** Node lifecycle spec; null = this endpoint's DSH process is externally managed. */
  spawn: ResolvedSpawnSpec | null
}

export interface ResolvedAgent {
  id: string
  name: string
  endpoint: string
  workspacePath: string
  public: boolean
  preset: string | null
  sandboxMode: 'read-only' | 'workspace-write' | null
  gitRemote: string | null
  provider: string | null
  model: string | null
}

export interface AppConfig {
  listen: { host: string; port: number }
  endpoints: Record<string, ResolvedEndpoint>
  agents: Record<string, ResolvedAgent>
  runner: {
    timeoutMs: number
    /** Cancel a turn after this long with no frames at all; 0 disables. */
    silenceMs: number
    maxConsecutiveFailures: number
    /** Ceiling for one local day's scheduled spend, or null for no ceiling. */
    dailyBudgetMicroUsd: number | null
  }
  databasePath: string
  /**
   * 蜂群 P5.1：主脑日派工预算（微美元），null = 不设上限。只拦 trigger=brain
   * 的派工；人工直连与手动派工不受影响。
   */
  brainDailyBudgetMicroUsd?: number | null
  /** Token rates and peak windows, from config or the built-in defaults. */
  pricing: PricingTable
  sessionSecret: string
  initialUser: { username: string; password: string | null }
  /**
   * Non-fatal problems worth saying out loud at boot. Kept as data rather than
   * logged from here so the rules stay testable.
   */
  warnings: string[]
}

/**
 * Fail loudly at boot rather than at first use. A half-configured manager that
 * starts and then 500s on the first agent call is strictly worse than one that
 * refuses to start.
 */
export const loadConfig = (configPath = 'manager.config.yaml'): AppConfig => {
  const raw = parseYaml(readFileSync(resolve(configPath), 'utf8')) as unknown
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`invalid ${configPath}:\n${detail}`)
  }
  const file = parsed.data

  const sessionSecret = process.env.SESSION_SECRET ?? ''
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters (see .env.example)')
  }

  const endpoints: Record<string, ResolvedEndpoint> = {}
  for (const [id, ep] of Object.entries(file.endpoints)) {
    const driver = ep.driver
    const key = ep.key_ref !== '' ? (process.env[ep.key_ref] ?? '') : ''
    if (driver === 'gateway' && key === '') {
      throw new Error(`endpoint "${id}": env var ${ep.key_ref} is empty; it must match one entry of the gateway's apiKeys`)
    }
    const prefix = driver === 'apiproxy' ? '/api' : ep.prefix
    const sandboxBase = ep.sandbox_base === undefined ? null : ep.sandbox_base.replace(/\/+$/, '')
    const sandboxKey = ep.sandbox_key_ref !== '' ? (process.env[ep.sandbox_key_ref] ?? '') : ''
    if (sandboxBase !== null && sandboxKey === '') {
      throw new Error(`endpoint "${id}": env var ${ep.sandbox_key_ref} is empty; it must match one entry of the gateway's apiKeys`)
    }
    // 蜂群 P1：节点的进程生命周期配置。managed: true 意味着 manager 会真的 spawn
    // 这个 DSH 进程——命令/参数要指向 dsh 的 bin.js + 该节点自己的 profile。
    const spawnRaw = ep.spawn
    const spawn: ResolvedSpawnSpec | null =
      spawnRaw === undefined
        ? null
        : {
            managed: spawnRaw.managed,
            command: spawnRaw.command,
            args: spawnRaw.args,
            cwd: spawnRaw.cwd === undefined ? null : resolve(spawnRaw.cwd),
            readyTimeoutMs: spawnRaw.ready_timeout_ms,
            detached: spawnRaw.detached,
            logFile: spawnRaw.log_file === undefined ? null : resolve(spawnRaw.log_file),
            env: spawnRaw.env ?? {},
            restart: {
              maxAttempts: spawnRaw.restart.max_attempts,
              baseDelayMs: spawnRaw.restart.base_delay_ms,
              maxDelayMs: spawnRaw.restart.max_delay_ms,
            },
          }
    endpoints[id] = {
      id,
      url: ep.url.replace(/\/+$/, ''),
      driver,
      prefix: prefix.replace(/\/+$/, ''),
      key,
      sandboxBase,
      sandboxKey,
      spawn,
    }
  }

  const agents: Record<string, ResolvedAgent> = {}
  for (const [id, a] of Object.entries(file.agents)) {
    if (endpoints[a.endpoint] === undefined) {
      throw new Error(`agent "${id}": unknown endpoint "${a.endpoint}"`)
    }
    agents[id] = {
      id,
      name: a.name,
      endpoint: a.endpoint,
      workspacePath: resolve(a.workspace),
      public: a.public,
      preset: a.preset ?? null,
      sandboxMode: a.sandbox_mode ?? null,
      gitRemote: a.git_remote ?? null,
      provider: a.provider ?? null,
      model: a.model ?? null,
    }
  }

  // 蜂群 P0：显式声明沙箱模式的 agent，必须落在配置了 sandbox 路由的端点上，
  // 否则声明会被静默忽略（fail loud at boot）。
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.sandboxMode === null) continue
    const ep = endpoints[agent.endpoint]
    if (ep === undefined || ep.sandboxBase === null) {
      throw new Error(
        `agent "${agentId}" sets sandbox_mode but endpoint "${agent.endpoint}" has no sandbox_base. ` +
          'Add endpoint.sandbox_base + sandbox_key_ref (the dsh-api-gateway surface) to honour it.',
      )
    }
  }

  // DESIGN.md §6 iron rule two: an externally callable agent must not share a
  // DSH process with a private one, because DSH reads are never sandboxed.
  const byEndpoint = new Map<string, ResolvedAgent[]>()
  for (const agent of Object.values(agents)) {
    const list = byEndpoint.get(agent.endpoint) ?? []
    list.push(agent)
    byEndpoint.set(agent.endpoint, list)
  }
  for (const [endpointId, list] of byEndpoint) {
    if (list.some((a) => a.public) && list.some((a) => !a.public)) {
      const pub = list.filter((a) => a.public).map((a) => a.id).join(', ')
      const priv = list.filter((a) => !a.public).map((a) => a.id).join(', ')
      throw new Error(
        `endpoint "${endpointId}" mixes public agents (${pub}) with private ones (${priv}). ` +
          'DSH reads are never sandboxed, so a prompt-injected public agent could read private data. ' +
          'Give the public agent its own endpoint (DESIGN.md §6).',
      )
    }
    // apiproxy mux is a full-volume stream: every session on the DSH process is
    // visible, not just the ones manager created. A public agent on an apiproxy
    // endpoint means an external request could trigger subscription to that
    // stream, which is the *only* visibility boundary in this mode.
    const ep = endpoints[endpointId]
    if (ep !== undefined && ep.driver === 'apiproxy' && list.some((a) => a.public)) {
      const pub = list.filter((a) => a.public).map((a) => a.id).join(', ')
      throw new Error(
        `endpoint "${endpointId}" (driver: apiproxy) has public agents (${pub}). ` +
          'apiproxy mux exposes all sessions on the DSH process; a public agent ' +
          'must not share that visibility. Use a gateway-mode endpoint for public agents.',
      )
    }
  }

  const warnings: string[] = []
  for (const [endpointId, list] of byEndpoint) {
    if (list.length < 2) continue
    // A DSH session's write boundary is not its cwd. The gateway only passes cwd
    // as the session's working directory (dsh-api-gateway/src/index.ts:517) --
    // the actual sandbox comes from that DSH process's own
    // sandboxPolicy.workspaceRoot, which is process-global. So agents sharing an
    // endpoint can reach each other's workspaces regardless of what manager asks
    // for, and the runner's cwd check cannot prevent it.
    warnings.push(
      `endpoint "${endpointId}" is shared by ${list.length} agents (${list.map((a) => a.id).join(', ')}). ` +
        'A DSH sandbox root is per process, not per session, so these agents can read and write ' +
        "each other's workspaces. Give each one its own DSH process if that matters.",
    )
  }

  let pricing = DEFAULT_PRICING
  if (file.pricing !== undefined) {
    const rates: Record<string, ModelPricing> = {}
    for (const [key, entry] of Object.entries(file.pricing.models)) {
      const toRate = (r: z.infer<typeof rateSchema>): { input: number; output: number; cacheRead?: number; cacheWrite?: number } => ({
        input: r.input,
        output: r.output,
        ...(r.cache_read === undefined ? {} : { cacheRead: r.cache_read }),
        ...(r.cache_write === undefined ? {} : { cacheWrite: r.cache_write }),
      })
      rates[key] = {
        offPeak: toRate(entry.off_peak),
        ...(entry.peak === undefined ? {} : { peak: toRate(entry.peak) }),
      }
    }
    // parseUtcTime throws on a malformed window, which is what should happen:
    // a typo here would silently bill every run at the wrong rate.
    const peakWindows = file.pricing.peak_windows_utc.map((w) => ({
      startMinuteUtc: parseUtcTime(w.start),
      endMinuteUtc: parseUtcTime(w.end),
    }))
    pricing = { rates, peakWindows }
  }

  const password = process.env.MANAGER_INITIAL_PASSWORD ?? ''

  return {
    listen: file.listen,
    endpoints,
    agents,
    runner: {
      timeoutMs: file.runner.timeout_minutes * 60_000,
      silenceMs: file.runner.silence_timeout_minutes * 60_000,
      maxConsecutiveFailures: file.runner.max_consecutive_failures,
      // Money is integer micro-USD everywhere past this line, so no float ever
      // reaches a comparison or the database.
      dailyBudgetMicroUsd:
        file.runner.daily_budget_usd === undefined ? null : Math.round(file.runner.daily_budget_usd * 1e6),
    },
    databasePath: resolve(file.database.path),
    brainDailyBudgetMicroUsd:
      file.brain.daily_budget_usd === undefined ? null : Math.round(file.brain.daily_budget_usd * 1e6),
    pricing,
    sessionSecret,
    initialUser: {
      username: process.env.MANAGER_USERNAME ?? 'admin',
      password: password === '' ? null : password,
    },
    warnings,
  }
}
