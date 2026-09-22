// @ts-check
/**
 * 能力四（舰队 M1-5）：node-agent 运行时——零原生依赖（Node ≥20），
 * 出站拨号 manager（长轮询指令 + 事件回报），管理本机 DSH 节点进程。
 *
 * 纪律：
 * - 固定指令集，绝不提供通用 shell；
 * - 身份与状态只落 <agentDir>/agent.json（0600，token 明文只在首次注册出现）；
 * - manager 失联：节点照跑，指数退避重连；指令执行与回报都在本地闭环。
 *
 * 注入面（测试用）：transport / proc / fs / install / backoff。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostname } from 'node:os'

/** 与 src/dsh-matrix.ts 的 needsLegacyPeerDeps 保持一致（check-docs.mjs 常驻断言）。 */
export const LEGACY_PEER_DEPS_VERSIONS = ['0.1.5-rc.2']

const RING_BYTES = 64 * 1024
const DSH_PACKAGE = '@deepseek-ai/dsh'

const defaultTransport = {
  register: async (managerUrl, body) => {
    const res = await fetch(`${managerUrl}/api/internal/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`register failed: HTTP ${res.status} ${JSON.stringify(json)}`)
    return json
  },
  commands: async (managerUrl, agentId, token, waitMs) => {
    const res = await fetch(`${managerUrl}/api/internal/agents/${agentId}/commands?wait=${waitMs}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) throw new Error('unauthorized')
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`commands failed: HTTP ${res.status}`)
    return json.commands ?? []
  },
  events: async (managerUrl, agentId, token, events) => {
    const res = await fetch(`${managerUrl}/api/internal/agents/${agentId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    })
    if (!res.ok) throw new Error(`events failed: HTTP ${res.status}`)
  },
}

const defaultProc = {
  /** 安装 DSH 到 agent 自有 prefix（不碰用户全局 npm）。 */
  install: async (agentDir, version, legacyPeerDeps) => {
    const { execFileSync } = await import('node:child_process')
    const prefix = `${agentDir}/dsh/${version}`
    const args = ['install', `${DSH_PACKAGE}@${version}`, '--prefix', prefix, '--no-audit', '--no-fund']
    if (legacyPeerDeps) args.push('--legacy-peer-deps')
    execFileSync('npm', args, { stdio: 'inherit' })
    return `${prefix}/node_modules/${DSH_PACKAGE}/lib/bin.js`
  },
  /** 拉起节点进程（detached + 文件流），返回 pid。 */
  spawn: async (bin, args, env, outPath) => {
    const { spawn } = await import('node:child_process')
    const { openSync } = await import('node:fs')
    const fd = openSync(outPath, 'a')
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      detached: true,
      windowsHide: true,
    })
    child.unref()
    return { pid: child.pid }
  },
  /** 停节点：先 TERM 等 5s 再 KILL（Windows 走 taskkill /T /F）。 */
  kill: async (pid) => {
    const { execFileSync } = await import('node:child_process')
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
      await sleep(5_000)
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGKILL')
      } catch { /* 已退出 */ }
    } catch { /* 已不在 */ }
  },
  alive: async (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
}

export class AgentRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.managerUrl
   * @param {string} opts.joinToken
   * @param {string} opts.agentDir
   * @param {typeof defaultTransport} [opts.transport]
   * @param {typeof defaultProc} [opts.proc]
   * @param {{ readFile: (p:string)=>string|null, writeFile: (p:string, c:string)=>void, mkdir: (p:string)=>void, exists: (p:string)=>boolean, stat: (p:string)=>number|null }} [opts.fs]
   * @param {number} [opts.maxWaitMs]
   * @param {(ms:number)=>Promise<void>} [opts.backoff]
   * @param {(line:string)=>void} [opts.log]
   */
  constructor(opts) {
    this.managerUrl = opts.managerUrl.replace(/\/+$/, '')
    this.joinToken = opts.joinToken
    this.agentDir = opts.agentDir
    this.transport = opts.transport ?? defaultTransport
    this.proc = opts.proc ?? defaultProc
    this.fs = opts.fs ?? defaultFs()
    this.maxWaitMs = opts.maxWaitMs ?? 25_000
    this.backoff = opts.backoff ?? ((ms) => sleep(ms))
    this.log = opts.log ?? ((line) => console.log(`[node-agent] ${line}`))
    this.agentId = null
    this.agentToken = null
    /** @type {Map<string, { pid:number|null, startedAt:number|null, logOffset:number }>} */
    this.nodes = new Map()
    this.retryAttempt = 0
  }

  /** 读/恢复身份（agent.json 0600）。 */
  loadIdentity() {
    const raw = this.fs.readFile(`${this.agentDir}/agent.json`)
    if (raw === null) return
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.agentId === 'string' && typeof parsed.agentToken === 'string') {
        this.agentId = parsed.agentId
        this.agentToken = parsed.agentToken
      }
    } catch { /* 坏文件 = 重新注册 */ }
  }

  saveIdentity() {
    this.fs.mkdir(this.agentDir)
    this.fs.writeFile(`${this.agentDir}/agent.json`, JSON.stringify({ agentId: this.agentId, agentToken: this.agentToken }, null, 2))
  }

  async registerOnce() {
    this.loadIdentity()
    if (this.agentId !== null && this.agentToken !== null) return true
    const body = {
      joinToken: this.joinToken,
      hostname: hostname(),
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    }
    const res = await this.transport.register(this.managerUrl, body)
    this.agentId = res.agentId
    this.agentToken = res.agentToken
    this.saveIdentity()
    this.log(`registered as ${this.agentId}`)
    return true
  }

  nodeHome(nodeId) {
    return `${this.agentDir}/nodes/${nodeId}`
  }

  /** 确保 DSH 钉版装在 agent 自有 prefix，返回 bin.js 绝对路径。 */
  async ensureDsh(dshVersion) {
    const version = typeof dshVersion === 'string' && dshVersion !== '' ? dshVersion : '0.1.2-rc.1'
    const bin = `${this.agentDir}/dsh/${version}/node_modules/${DSH_PACKAGE}/lib/bin.js`
    if (this.fs.exists(bin)) return bin
    this.fs.mkdir(`${this.agentDir}/dsh/${version}`)
    const legacy = LEGACY_PEER_DEPS_VERSIONS.includes(version)
    this.log(`installing ${DSH_PACKAGE}@${version} into agent prefix${legacy ? ' (--legacy-peer-deps)' : ''}`)
    return this.proc.install(this.agentDir, version, legacy)
  }

  async execSpawn(command) {
    const payload = command.payload ?? {}
    const nodeId = payload.nodeId
    const home = this.nodeHome(nodeId)
    const dshHome = payload.env?.DSH_HOME ?? home
    this.fs.mkdir(home)
    this.fs.mkdir(dshHome)
    // 钥匙：spawn 载荷 env 里的 GW_KEY → DSH_HOME/settings.yaml（facade 只读
    // settings；容器 entrypoint 同款派生，单向下发）。
    if (typeof payload.env?.GW_KEY === 'string' && payload.env.GW_KEY !== '') {
      this.fs.writeFile(`${dshHome}/settings.yaml`, `ohdsh-api-facade:\n  apiKeys: ['${payload.env.GW_KEY}']\n`)
    }
    try {
      const bin = await this.ensureDsh(payload.dshVersion)
      const env = { ...(payload.env ?? {}), DSH_HOME: dshHome }
      const { pid } = await this.proc.spawn(bin, payload.args ?? [], env, `${home}/node.log`)
      this.fs.writeFile(`${home}/node.pid`, String(pid))
      this.nodes.set(nodeId, { pid, startedAt: Date.now(), logOffset: 0 })
      this.log(`node ${nodeId} spawned (pid ${pid})`)
      return { ok: true, result: { pid } }
    } catch (error) {
      return { ok: false, result: { message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async execStop(command) {
    const payload = command.payload ?? {}
    const nodeId = payload.nodeId
    const node = this.nodes.get(nodeId)
    const home = this.nodeHome(nodeId)
    const pidRaw = node?.pid ?? (this.fs.readFile(`${home}/node.pid`) ?? null)
    const pid = pidRaw === null ? null : Number(pidRaw)
    if (pid !== null && Number.isInteger(pid) && pid > 0) {
      try {
        await this.proc.kill(pid)
        this.log(`node ${nodeId} stopped (pid ${pid})`)
      } catch (error) {
        return { ok: false, result: { message: error instanceof Error ? error.message : String(error) } }
      }
    }
    this.nodes.set(nodeId, { pid: null, startedAt: null, logOffset: node?.logOffset ?? 0 })
    return { ok: true, result: { pid: pid ?? null } }
  }

  async execRestart(command) {
    const stop = await this.execStop(command)
    if (!stop.ok) return stop
    const spawnCommand = { payload: command.payload }
    return this.execSpawn(spawnCommand)
  }

  async execLogs(command) {
    const payload = command.payload ?? {}
    const home = this.nodeHome(payload.nodeId)
    const lines = this.fs.readFile(`${home}/node.log`) ?? ''
    const tail = lines.length > 16_000 ? lines.slice(lines.length - 16_000) : lines
    return { ok: true, result: { logs: tail } }
  }

  async execStatus() {
    const status = []
    for (const [nodeId, node] of this.nodes) {
      const alive = node.pid === null ? false : await this.proc.alive(node.pid)
      status.push({ nodeId, pid: node.pid, running: alive, startedAt: node.startedAt })
    }
    return { ok: true, result: { nodes: status } }
  }

  async execute(command) {
    if (command.type === 'node.spawn') return this.execSpawn(command)
    if (command.type === 'node.stop') return this.execStop(command)
    if (command.type === 'node.restart') return this.execRestart(command)
    if (command.type === 'node.logs') return this.execLogs(command)
    if (command.type === 'node.status') return this.execStatus(command)
    return { ok: false, result: { message: `command type ${command.type} not implemented in this agent version` } }
  }

  /** 每个轮询周期的日志增量（分块回传，manager 侧环形缓冲）。 */
  collectLogChunks() {
    const events = []
    for (const [nodeId, node] of this.nodes) {
      const lines = this.fs.readFile(`${this.nodeHome(nodeId)}/node.log`) ?? ''
      if (node.logOffset >= lines.length) continue
      const chunk = lines.slice(node.logOffset)
      events.push({ type: 'log_chunk', nodeId, chunk: chunk.slice(0, 32_000) })
      node.logOffset = lines.length
    }
    return events
  }

  /** 一轮：领指令 → 执行 → 回报结果 + 日志增量。返回本轮是否有过失败。 */
  async loopOnce() {
    if (this.agentId === null || this.agentToken === null) throw new Error('not registered')
    const commands = await this.transport.commands(this.managerUrl, this.agentId, this.agentToken, this.maxWaitMs)
    const events = []
    for (const command of commands) {
      const outcome = await this.execute(command)
      events.push({ type: 'command_result', commandId: command.id, ok: outcome.ok, result: outcome.result })
    }
    events.push(...this.collectLogChunks())
    if (events.length > 0) {
      await this.transport.events(this.managerUrl, this.agentId, this.agentToken, events)
    }
    return commands.length
  }

  /**
   * 常驻循环：注册 → 轮询；网络失败指数退避（1s→30s），永不退出。
   * 可传 AbortSignal 干净退出（测试/停机用）。
   * 每轮迭代后 `sleep(0)` 让出事件循环——瞬时 resolve 的传输在测试/故障
   * 场景下会微任务饥饿，定时器（信号/心跳）永远得不到执行。
   */
  async run(opts = {}) {
    await this.registerOnce()
    for (;;) {
      if (opts?.signal?.aborted === true) return
      try {
        await this.loopOnce()
        this.retryAttempt = 0
      } catch (error) {
        if (error instanceof Error && error.message === 'unauthorized') {
          this.log('身份被拒（吊销/失效）——清身份后重新注册')
          this.agentId = null
          this.agentToken = null
          this.fs.writeFile(`${this.agentDir}/agent.json`, '')
          await this.registerOnce()
        } else {
          this.retryAttempt += 1
          const delay = Math.min(1_000 * 2 ** Math.max(0, this.retryAttempt - 1), 30_000)
          this.log(`manager 不可达（第 ${this.retryAttempt} 次），${delay}ms 后重试`)
          await this.backoff(delay)
          if (opts?.signal?.aborted === true) return
        }
      }
      await sleep(0)
    }
  }
}

function defaultFs() {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (p, c) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, c, 'utf8')
      if (p.endsWith('agent.json') || p.endsWith('settings.yaml')) {
        try {
          chmodSync(p, 0o600)
        } catch { /* Windows 空操作 */ }
      }
    },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    exists: (p) => existsSync(p),
    stat: (p) => {
      try {
        return statSync(p).size
      } catch {
        return null
      }
    },
  }
}
