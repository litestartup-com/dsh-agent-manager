/**
 * NodeSupervisor — process lifecycle for one managed DSH node (蜂群 P1).
 *
 * State machine:
 *
 *   cold ──start()──▶ starting ──probe ok──▶ live
 *     ▲                │  │                    │
 *     │                │  └─exit (crash)─▶ restarting ──backoff──▶ starting
 *     │                └─probe timeout→kill─▶ (exit path, counts as one attempt)
 *     │                                             │ attempts ≥ maxAttempts
 *     └────────────stop() ◀─────────────────────────┴──▶ offline（连续失败自动停用）
 *
 * Pure decisions (`backoffDelayMs` / `decideAfterExit`) are extracted so the
 * retry policy is directly unit-testable; the class itself is thin plumbing.
 *
 * Design notes:
 * - The probe is injected by the wiring layer (endpoint health check), so this
 *   module has no HTTP knowledge and no config knowledge.
 * - Child stdout/stderr are captured into a bounded ring of lines so `logs`
 *   works without a log-file convention.
 * - On Windows the tree is killed with taskkill /T /F; elsewhere SIGTERM then
 *   SIGKILL. The stop() path is marked manual so the exit handler settles to
 *   `cold` instead of restarting.
 */

import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { openSync, rmSync, writeFileSync } from 'node:fs'
import type { ResolvedSpawnSpec } from '../config.js'
import type { DockerRunner } from './docker-runner.js'

export type NodeState = 'cold' | 'starting' | 'live' | 'restarting' | 'offline'

export interface NodeProbeResult {
  ok: boolean
  detail: string
}

export interface NodeStatus {
  id: string
  state: NodeState
  pid: number | null
  /** Consecutive failed starts/crashes since the last time the node was live. */
  attempts: number
  lastError: string | null
  startedAt: number | null
  stateSince: number
}

export interface SupervisorDeps {
  /** Endpoint health probe; must resolve quickly and never throw. */
  probe: (id: string) => Promise<NodeProbeResult>
  log?: (line: string) => void
  /** 蜂群2计划 P2b：docker runner（runner=docker 的节点用）；缺 = 该模式不可用。 */
  docker?: DockerRunner
  /** docker 容器的附加环境（GW_KEY / DEEPSEEK_API_KEY 等，由 wiring 层按 endpoint 提供）。 */
  dockerEnv?: () => Record<string, string>
}

/** Exponential backoff, capped: attempt 1 → base, 2 → 2×base, … never above max. */
export const backoffDelayMs = (attempt: number, baseDelayMs: number, maxDelayMs: number): number =>
  Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs)

/** What happens after the child exits, given how many failures this streak has. */
export const decideAfterExit = (attempts: number, maxAttempts: number, manual: boolean): 'cold' | 'restart' | 'offline' => {
  if (manual) return 'cold'
  return attempts >= maxAttempts ? 'offline' : 'restart'
}

const PROBE_POLL_MS = 1_000
/** A node's captured output is kept as lines, bounded to roughly this many bytes. */
const LOG_BUFFER_BYTES = 64 * 1024

export class NodeSupervisor {
  readonly id: string
  private readonly deps: SupervisorDeps
  private child: ChildProcess | null = null
  /** 蜂群2计划 P2b：docker runner 模式下当前容器 id（process 模式恒为 null）。 */
  private containerId: string | null = null
  /** 最近一次 start/restart 的规格：stop/restart 的 docker 分支要用。 */
  private lastSpec: ResolvedSpawnSpec | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private manualStop = false
  /** 蜂群 P5.1：主动重启标记——stop 后进程消失时再拉起，而不是进入冷态。 */
  private restartRequested = false
  private lastError: string | null = null
  private pidFile: string | null = null
  private logLines: string[] = []
  private logBytes = 0
  private status: NodeStatus

  constructor(id: string, deps: SupervisorDeps) {
    this.id = id
    this.deps = deps
    this.status = {
      id,
      state: 'cold',
      pid: null,
      attempts: 0,
      lastError: null,
      startedAt: null,
      stateSince: Date.now(),
    }
  }

  get current(): NodeStatus {
    return { ...this.status }
  }

  /** Start the node (no-op unless cold/offline-restart). */
  start(spec: ResolvedSpawnSpec): void {
    this.lastSpec = spec
    if (spec.runner === 'docker') {
      if (this.containerId !== null || this.restartTimer !== null || this.status.state === 'starting') return
      this.manualStop = false
      this.startDocker(spec)
      return
    }
    if (this.child !== null || this.restartTimer !== null || this.status.state === 'starting') return
    this.manualStop = false
    this.spawnOnce(spec)
  }

  /** Stop the node; settles to cold when the process is actually gone. */
  stop(): void {
    this.manualStop = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    // 蜂群2计划 P2b：docker 模式 —— 停容器即停节点（状态都在卷里）
    const spec = this.lastSpec
    if (spec !== null && spec.runner === 'docker') {
      const cid = this.containerId
      this.containerId = null
      const runner = this.deps.docker
      if (cid === null || runner === undefined) {
        this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
        return
      }
      void runner
        .stop(cid)
        .then(() => {
          if (this.restartRequested) {
            this.restartRequested = false
            this.manualStop = false
            this.status = { ...this.status, state: 'cold', pid: null, attempts: 0, stateSince: Date.now() }
            this.deps.log?.(`node ${this.id}: restarting (docker)`)
            this.startDocker(spec)
            return
          }
          this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
          this.deps.log?.(`node ${this.id}: stopped (docker)`)
        })
        .catch((error: unknown) => {
          this.deps.log?.(`node ${this.id}: docker stop 失败: ${error instanceof Error ? error.message : String(error)}`)
        })
      return
    }
    if (this.child === null) {
      this.clearPidFile()
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      return
    }
    this.killTree()
  }

  /** 蜂群 P5.1：主动重启。stop 之后进程消失时自动重新拉起，清零重试计数。 */
  restart(spec: ResolvedSpawnSpec): void {
    this.lastSpec = spec
    // 没有进程在跑 = 直接启动；否则等进程消失后再拉起，避免残留标记。
    if (this.child === null && this.containerId === null && this.restartTimer === null) {
      this.start(spec)
      return
    }
    this.restartRequested = true
    this.stop()
  }

  /** Buffered stdout/stderr of the current (or last) child, as text. */
  logs(): string {
    return this.logLines.join('')
  }

  /** 蜂群2计划 P2b：docker 模式的日志走 docker logs；不可用返回 null（调用方回退缓冲）。 */
  async dockerLogs(): Promise<string | null> {
    if (this.deps.docker === undefined || this.containerId === null) return null
    try {
      return await this.deps.docker.logs(this.containerId, 500)
    } catch (error) {
      this.deps.log?.(`node ${this.id}: docker logs 失败: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** 蜂群2计划 P2b：启动对账——认领已在跑的托管容器（不重复拉起）。 */
  adopt(spec: ResolvedSpawnSpec, containerId: string): void {
    this.lastSpec = spec
    this.containerId = containerId
    this.manualStop = false
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    this.deps.log?.(`node ${this.id}: adopting container ${containerId}`)
    this.armReadyProbe(spec)
  }

  private spawnOnce(spec: ResolvedSpawnSpec): void {
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    // Detached nodes outlive the launcher: output goes to the log file (and a
    // pidfile next to it), never to pipes that die with the parent.
    let outputFd: number | null = null
    let stdio: StdioOptions
    if (spec.logFile !== null) {
      outputFd = openSync(spec.logFile, 'a')
      stdio = ['ignore', outputFd, outputFd]
    } else if (spec.detached) {
      stdio = ['ignore', 'ignore', 'ignore']
    } else {
      stdio = ['ignore', 'pipe', 'pipe']
    }
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd ?? undefined,
      env: { ...process.env, ...spec.env },
      stdio,
      windowsHide: true,
      detached: spec.detached,
    })
    if (spec.detached) child.unref()
    this.child = child
    this.status = { ...this.status, pid: child.pid ?? null, startedAt: Date.now() }
    if (spec.logFile !== null && child.pid !== undefined) {
      this.pidFile = spec.logFile + '.pid'
      writeFileSync(this.pidFile, String(child.pid))
    }
    this.deps.log?.(`node ${this.id}: spawning ${spec.command} ${spec.args.join(' ')} (pid ${child.pid ?? '?'})`)

    if (outputFd !== null) {
      child.stdout = null
      child.stderr = null
    } else {
      child.stdout?.on('data', (chunk: Buffer) => this.pushLog(String(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => this.pushLog(String(chunk)))
    }
    child.once('error', (error) => {
      // spawn itself failed (ENOENT etc.): no process, no exit event on some
      // platforms — settle through the same exit path.
      this.lastError = error.message
      this.deps.log?.(`node ${this.id}: spawn failed: ${error.message}`)
      if (this.child === child) this.onExit(spec, null, null)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.onExit(spec, code, signal)
    })

    this.armReadyProbe(spec)
  }

  private armReadyProbe(spec: ResolvedSpawnSpec): void {
    const deadline = Date.now() + spec.readyTimeoutMs
    const poll = (): void => {
      if (this.status.state !== 'starting') return
      void this.deps.probe(this.id).then((result) => {
        if (this.status.state !== 'starting') return
        if (result.ok) {
          this.status = { ...this.status, state: 'live', attempts: 0, lastError: null, stateSince: Date.now() }
          this.deps.log?.(`node ${this.id}: live`)
          return
        }
        if (Date.now() >= deadline) {
          this.lastError = `not ready within ${spec.readyTimeoutMs}ms: ${result.detail}`
          this.deps.log?.(`node ${this.id}: ${this.lastError}`)
          this.killTree()
          return
        }
        this.readyTimer = setTimeout(poll, PROBE_POLL_MS)
      })
    }
    poll()
  }

  private startDocker(spec: ResolvedSpawnSpec): void {
    const runner = this.deps.docker
    if (runner === undefined || spec.docker === null) {
      this.lastError = 'docker runner 未接线（manager 未挂载 docker.sock？）'
      this.deps.log?.(`node ${this.id}: ${this.lastError}`)
      this.status = { ...this.status, state: 'offline', lastError: this.lastError, stateSince: Date.now() }
      return
    }
    this.status = { ...this.status, state: 'starting', lastError: null, stateSince: Date.now() }
    const env = { ...(this.deps.dockerEnv?.() ?? {}), ...spec.env }
    void runner
      .ensureImage(spec.docker.image)
      .then(() => runner.start(spec, this.id, env))
      .then((containerId) => {
        if (this.status.state !== 'starting') {
          // 等待期间被 stop：刚拉起的容器成为孤儿，补刀清掉
          void runner.stop(containerId).catch(() => undefined)
          return
        }
        this.containerId = containerId
        this.deps.log?.(`node ${this.id}: container ${containerId} (${spec.docker?.image ?? '?'})`)
        this.armReadyProbe(spec)
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.deps.log?.(`node ${this.id}: docker 启动失败: ${this.lastError}`)
        if (this.status.state !== 'starting') return
        this.afterDockerFailure(spec)
      })
  }

  /** docker 启动失败后的重试/停用决策（复用 process 模式的同一策略函数）。 */
  private afterDockerFailure(spec: ResolvedSpawnSpec): void {
    if (this.manualStop) {
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      return
    }
    const attempts = this.status.attempts + 1
    const decision = decideAfterExit(attempts, spec.restart.maxAttempts, false)
    this.status = {
      ...this.status,
      pid: null,
      attempts,
      lastError: this.lastError ?? 'docker 启动失败',
      startedAt: null,
      stateSince: Date.now(),
    }
    if (decision === 'offline') {
      this.status = { ...this.status, state: 'offline' }
      this.deps.log?.(`node ${this.id}: offline after ${attempts} consecutive failures`)
      return
    }
    const delay = backoffDelayMs(attempts, spec.restart.baseDelayMs, spec.restart.maxDelayMs)
    this.status = { ...this.status, state: 'restarting' }
    this.deps.log?.(`node ${this.id}: restart in ${delay}ms (attempt ${attempts})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.startDocker(spec)
    }, delay)
  }

  private onExit(spec: ResolvedSpawnSpec, code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    const exitNote = `exited code=${String(code)} signal=${String(signal)}`
    if (this.manualStop) {
      this.clearPidFile()
      // 蜂群 P5.1：主动重启——进程消失即重新拉起，而不是停在冷态。
      if (this.restartRequested) {
        this.restartRequested = false
        this.manualStop = false
        this.status = { ...this.status, state: 'cold', pid: null, attempts: 0, stateSince: Date.now() }
        this.deps.log?.(`node ${this.id}: restarting (${exitNote})`)
        this.spawnOnce(spec)
        return
      }
      this.status = { ...this.status, state: 'cold', pid: null, stateSince: Date.now() }
      this.deps.log?.(`node ${this.id}: stopped (${exitNote})`)
      return
    }
    const attempts = this.status.attempts + 1
    const decision = decideAfterExit(attempts, spec.restart.maxAttempts, false)
    this.status = {
      ...this.status,
      pid: null,
      attempts,
      lastError: this.lastError ?? exitNote,
      startedAt: null,
      stateSince: Date.now(),
    }
    if (decision === 'offline') {
      this.clearPidFile()
      this.status = { ...this.status, state: 'offline' }
      this.deps.log?.(`node ${this.id}: offline after ${attempts} consecutive failures`)
      return
    }
    const delay = backoffDelayMs(attempts, spec.restart.baseDelayMs, spec.restart.maxDelayMs)
    this.status = { ...this.status, state: 'restarting' }
    this.deps.log?.(`node ${this.id}: restart in ${delay}ms (attempt ${attempts})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnOnce(spec)
    }, delay)
  }

  private clearPidFile(): void {
    if (this.pidFile === null) return
    try {
      rmSync(this.pidFile, { force: true })
    } catch {
      // best effort: a stale pidfile misleads `nodes down` but never hurts data
    }
    this.pidFile = null
  }

  private killTree(): void {
    const child = this.child
    if (child === null || child.pid === undefined) return
    if (process.platform === 'win32') {
      // taskkill /T /F is the reliable way to take a console-app tree down on
      // Windows; child.kill() only signals the outer shell. spawnSync so the
      // kill is issued before a fast shutdown can exit the process and orphan
      // the node.
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      if (result.error !== undefined) this.deps.log?.(`node ${this.id}: taskkill failed: ${result.error.message}`)
      return
    }
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000).unref()
  }

  private pushLog(chunk: string): void {
    const lines = chunk.split(/\r?\n/)
    for (const line of lines) {
      if (line === '') continue
      this.logLines.push(line + '\n')
      this.logBytes += line.length + 1
    }
    while (this.logBytes > LOG_BUFFER_BYTES && this.logLines.length > 0) {
      const dropped = this.logLines.shift()
      if (dropped !== undefined) this.logBytes -= dropped.length
    }
  }
}
