import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSupervisor, backoffDelayMs, decideAfterExit } from './supervisor.js'
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
  ...over,
})

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
