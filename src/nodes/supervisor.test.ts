import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSupervisor, backoffDelayMs, decideAfterExit } from './supervisor.js'
import type { DockerRunner } from './docker-runner.js'
import type { ResolvedSpawnSpec } from '../config.js'

const spec = (over: Partial<ResolvedSpawnSpec> = {}): ResolvedSpawnSpec => ({
  managed: true,
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  cwd: null,
  readyTimeoutMs: 5_000,
  detached: false,
  logFile: null,
  env: {},
  restart: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100 },
  runner: 'process',
  docker: null,
  ...over,
})

/** 蜂群2计划 P2b：docker runner 节点规格（快速退避，测试友好）。 */
const dockerSpec = (): ResolvedSpawnSpec =>
  spec({
    command: '',
    runner: 'docker',
    readyTimeoutMs: 2_000,
    restart: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
    docker: { image: 'ohdsh/dsh-node:0.1.1-rc.2', containerName: null, network: 'hive', port: 3081, hostVolumes: {}, namedVolumes: {} },
  })

const stubDocker = (startFails = false): { runner: DockerRunner; calls: { ensureImage: number; start: number; stop: number; logs: number } } => {
  const calls = { ensureImage: 0, start: 0, stop: 0, logs: 0 }
  const runner = {
    ensureImage: async () => {
      calls.ensureImage += 1
    },
    start: async () => {
      calls.start += 1
      if (startFails) throw new Error('no docker')
      return 'cid-1'
    },
    stop: async () => {
      calls.stop += 1
    },
    logs: async () => {
      calls.logs += 1
      return 'docker-logs\n'
    },
    listManaged: async () => [],
  } as unknown as DockerRunner
  return { runner, calls }
}

const okProbe = async (): Promise<{ ok: true; detail: string }> => ({ ok: true, detail: '' })
const badProbe = async (): Promise<{ ok: false; detail: string }> => ({ ok: false, detail: 'down' })

const waitFor = async (fn: () => boolean, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const keepAliveScript = 'console.log("hello-node"); setInterval(() => {}, 1000)'

test('backoffDelayMs: exponential, capped, and sane below attempt 1', () => {
  assert.equal(backoffDelayMs(1, 1_000, 30_000), 1_000)
  assert.equal(backoffDelayMs(2, 1_000, 30_000), 2_000)
  assert.equal(backoffDelayMs(3, 1_000, 30_000), 4_000)
  assert.equal(backoffDelayMs(20, 1_000, 30_000), 30_000)
  assert.equal(backoffDelayMs(0, 1_000, 30_000), 1_000)
  assert.equal(backoffDelayMs(-3, 1_000, 30_000), 1_000)
})

test('decideAfterExit: manual stop always settles cold', () => {
  assert.equal(decideAfterExit(1, 3, true), 'cold')
  assert.equal(decideAfterExit(99, 3, true), 'cold')
})

test('decideAfterExit: crashes restart until the streak hits the cap', () => {
  assert.equal(decideAfterExit(1, 3, false), 'restart')
  assert.equal(decideAfterExit(2, 3, false), 'restart')
  assert.equal(decideAfterExit(3, 3, false), 'offline')
  assert.equal(decideAfterExit(4, 3, false), 'offline')
})

test('a managed node goes live, buffers logs, and stops to cold', async () => {
  const lines: string[] = []
  const node = new NodeSupervisor('A', { probe: okProbe, log: (l) => lines.push(l) })
  assert.equal(node.current.state, 'cold')

  node.start(spec({ args: ['-e', keepAliveScript] }))
  try {
    await waitFor(() => node.current.state === 'live', 10_000, 'live')
    assert.ok(node.current.pid !== null)
    assert.equal(node.current.attempts, 0)
    // stdout arrives asynchronously; live is not a proof the pipe flushed.
    await waitFor(() => node.logs().includes('hello-node'), 5_000, 'captured log')
  } finally {
    node.stop()
    await waitFor(() => node.current.state === 'cold', 10_000, 'cold')
  }
  assert.equal(node.current.pid, null)
})

test('a node that never becomes ready is killed and restarted with backoff until offline', async () => {
  const node = new NodeSupervisor('B', { probe: badProbe })
  node.start(
    spec({
      args: ['-e', keepAliveScript],
      readyTimeoutMs: 250,
      restart: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
    }),
  )
  await waitFor(() => node.current.state === 'offline', 10_000, 'offline')
  assert.equal(node.current.attempts, 2)
  assert.match(node.current.lastError ?? '', /not ready within 250ms/)
})

test('a spawn failure (ENOENT) settles to offline after the cap', async () => {
  const node = new NodeSupervisor('C', { probe: badProbe })
  node.start(
    spec({
      command: 'definitely-not-a-real-binary-xyz-31415',
      readyTimeoutMs: 250,
      restart: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 50 },
    }),
  )
  await waitFor(() => node.current.state === 'offline', 10_000, 'offline')
  assert.equal(node.current.attempts, 1)
  assert.match(node.current.lastError ?? '', /spawn|ENOENT|not found|failed/i)
})

test('a detached node writes to its log file, leaves a pidfile, and cleans it on stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-sup-'))
  const logFile = join(dir, 'node.log')
  const node = new NodeSupervisor('D', { probe: okProbe })
  node.start(
    spec({
      args: ['-e', 'console.log("detached-up"); setInterval(() => {}, 1000)'],
      detached: true,
      logFile,
    }),
  )
  try {
    await waitFor(() => node.current.state === 'live', 10_000, 'live')
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('detached-up'), 5_000, 'log file content')
    assert.ok(existsSync(logFile + '.pid'), 'pidfile exists while running')
  } finally {
    node.stop()
    await waitFor(() => node.current.state === 'cold', 10_000, 'cold')
  }
  assert.equal(existsSync(logFile + '.pid'), false, 'pidfile removed on stop')
  rmSync(dir, { recursive: true, force: true })
})

// ---- 蜂群2计划 P2b：docker runner 模式 ----

test('P2b: docker 节点启动→探活→停止走 runner，不碰子进程', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner, dockerEnv: () => ({ DSH_HOME: '/data', GW_KEY: 'k' }) })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'live', 5_000, 'docker live')
  assert.equal(calls.ensureImage, 1)
  assert.equal(calls.start, 1)
  assert.equal(node.current.pid, null, 'docker 模式没有进程 pid')
  node.stop()
  await waitFor(() => node.current.state === 'cold', 5_000, 'docker cold')
  assert.equal(calls.stop, 1)
})

test('P2b: adopt 认领在跑容器，探活通过即 live，绝不重复拉起', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.adopt(dockerSpec(), 'cid-adopted')
  await waitFor(() => node.current.state === 'live', 5_000, 'adopted live')
  assert.equal(calls.start, 0)
  assert.equal(calls.ensureImage, 0)
})

test('P2b: docker 启动连续失败按退避重试，超过次数停用', async () => {
  const { runner } = stubDocker(true)
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.start(dockerSpec())
  await waitFor(() => node.current.state === 'offline', 5_000, 'docker offline')
  assert.equal(node.current.attempts, 2)
  assert.match(node.current.lastError ?? '', /no docker/)
})

test('P2b: dockerLogs 无容器返回 null；认领后走 runner.logs', async () => {
  const { runner, calls } = stubDocker()
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  assert.equal(await node.dockerLogs(), null)
  node.adopt(dockerSpec(), 'cid-1')
  assert.equal(await node.dockerLogs(), 'docker-logs\n')
  assert.equal(calls.logs, 1)
})

test('P6 评审 B3: 启动等待期间 stop——在途链作废、孤儿容器被补刀清理、不采纳容器', async () => {
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate
  })
  const calls = { ensureImage: 0, start: 0, stop: 0 }
  const runner = {
    ensureImage: async () => {
      calls.ensureImage += 1
      await gate
    },
    start: async () => {
      calls.start += 1
      return 'cid-late'
    },
    stop: async () => {
      calls.stop += 1
    },
    logs: async () => 'late',
    listManaged: async () => [],
  } as unknown as DockerRunner
  const node = new NodeSupervisor('E', { probe: okProbe, docker: runner })
  node.start(dockerSpec())
  await waitFor(() => calls.ensureImage === 1, 2_000, 'ensureImage entered')
  node.stop()
  assert.equal(node.current.state, 'cold')
  releaseGate()
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  assert.equal(node.current.state, 'cold', '过期链不得改变状态')
  assert.equal(calls.stop, 1, '过期链拉起的孤儿容器被补刀清理')
  assert.equal(await node.dockerLogs(), null, '过期链不得采纳 containerId')
})

test('P6 评审 B3: docker 就绪超时——停容器并走失败决策链（不卡 starting）', async () => {
  const calls = { start: 0, stop: 0 }
  const runner = {
    ensureImage: async () => undefined,
    start: async () => {
      calls.start += 1
      return 'cid-x'
    },
    stop: async () => {
      calls.stop += 1
    },
    logs: async () => '',
    listManaged: async () => [],
  } as unknown as DockerRunner
  const node = new NodeSupervisor('E', { probe: badProbe, docker: runner })
  node.start(dockerSpec()) // readyTimeoutMs 2s，maxAttempts 2，退避 10/20ms
  await waitFor(() => node.current.state === 'offline', 15_000, 'offline after probe timeouts')
  assert.equal(node.current.attempts, 2)
  assert.ok(calls.stop >= 2, '每次就绪超时都停容器')
})
