/**
 * 拔插头验收（修路 S2）：FakeSessionDriver（纯内存、零 wire 依赖）驱动 runner
 * 的 apiproxy 全链路——证明上层运行时只依赖 SessionDriver 端口：
 * 插头三替身接上即跑，上层代码一行不改（TRANSLATOR-OPTIONS §5 验收标准）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import type { ResolvedAgent } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { runAgent } from '../runner.js'
import { FakeSessionDriver, type FakeScript } from './fake.js'

const SUCCESS: FakeScript = {
  frames: [
    { kind: 'turn_start', seq: 0, turn: 1 },
    { kind: 'message', seq: 0, text: '收到。', reasoning: null, usage: { inputTokens: 120, outputTokens: 8 } },
    { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
  ],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

const makeDb = (): Db => {
  const dir = mkdtempSync(join(tmpdir(), 'apiproxy-runner-db-'))
  const { db } = openDb(join(dir, 'test.db'))
  db.insert(schema.agent)
    .values({ id: 'personal', name: 'Personal', workspacePath: dir, endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() })
    .run()
  return db
}

const agentFor = (workspacePath: string, sandboxMode: 'read-only' | 'workspace-write' | null = null): ResolvedAgent => ({
  id: 'personal', name: 'Personal', endpoint: 'A', workspacePath, public: false,
  preset: 'standard', gitRemote: null, provider: null, model: null, sandboxMode, validate: null,
})

/** 端口不涉及 GatewayClient，但 RunInput 要求一个（gateway 分支才用得到）。 */
const dummyClient = (): GatewayClient =>
  new GatewayClient({ id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '', sandboxBase: null, sandboxKey: '', spawn: null })

test('apiproxy turn: create → sandbox → prompt → frames → turn_end，全部走端口', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', SUCCESS)
  const workspace = mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))
  const seen: string[] = []

  const outcome = await runAgent({ db }, {
    agent: agentFor(workspace, 'workspace-write'),
    client: dummyClient(),
    upstream: fake,
    driver: 'apiproxy',
    prompt: '只回复：收到',
    trigger: 'manual',
    onFrame: (frame) => seen.push(frame.kind),
  })

  assert.equal(outcome.state, 'done')
  assert.equal(outcome.reason, 'completed')
  assert.match(outcome.sessionId ?? '', /^fake-\d+$/)
  assert.deepEqual(outcome.usage, { inputTokens: 120, outputTokens: 8 })
  assert.equal(outcome.model, 'deepseek-v4-flash')
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0]?.cwd, workspace, 'cwd = 工作区（写边界）')
  assert.deepEqual(fake.sandboxPins, [{ sessionId: outcome.sessionId, mode: 'workspace-write' }], '端口可选能力：首次 prompt 前钉沙箱')
  assert.deepEqual(fake.prompts, ['只回复：收到'])
  assert.deepEqual(seen, ['turn_start', 'message', 'turn_end'], '直播帧经端口到达 onFrame')

  const run = db.select().from(schema.run).where(eq(schema.run.id, outcome.runId)).all()[0]
  assert.equal(run?.state, 'done')
  assert.equal(run?.dshSessionId, outcome.sessionId)
})

test('apiproxy turn: prompt 未被接受 = failed，不等待帧', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, promptAccepted: false })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /not accepted/)
})

test('apiproxy turn: createSession 抛错 = failed 带上游信息', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { ...SUCCESS, createError: 'upstream 503' })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /upstream 503/)
})

test('apiproxy turn: turn_end reason=error 携带 detail.message', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [{ kind: 'turn_end', seq: 0, turn: 1, reason: 'error', detail: { message: 'model exploded', cause: null } }],
  })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /model exploded/)
})

test('apiproxy turn: question/approval 帧照常到达 onFrame，回合照常收尾', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'question_asked', seq: 0, questionId: 'q1', questions: [{ id: 'a', question: 'go?' }] },
      { kind: 'approval_pending', seq: 0, decisionId: 'd1', approvalId: 'ap1', toolName: 'shell', reason: 'writes' },
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })
  const seen: string[] = []
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    onFrame: (frame) => seen.push(frame.kind),
  })
  assert.equal(outcome.state, 'done')
  assert.deepEqual(seen, ['question_asked', 'approval_pending', 'turn_end'])
})

test('apiproxy turn: 静默超时 = cancelled，且经端口调用 cancel', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', { frames: [] })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 60,
  })
  assert.equal(outcome.state, 'failed')
  assert.equal(fake.cancels, 1, '取消经端口发出')
})

test('债务 A4 回归: 回合中流重连 → 显性失败(结果未知),绝不静默等超时', async () => {
  const db = makeDb()
  const fake = new FakeSessionDriver('A', {
    frames: [
      { kind: 'turn_start', seq: 0, turn: 1 },
      { kind: 'stream_reconnected', seq: 0 },
      // 上游其实已完成,但 turn_end 丢在断线期间——重连后只有通知帧
      { kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null },
    ],
  })
  const outcome = await runAgent({ db }, {
    agent: agentFor(mkdtempSync(join(tmpdir(), 'apiproxy-ws-'))),
    client: dummyClient(), upstream: fake, driver: 'apiproxy', prompt: 'hi', trigger: 'manual',
    silenceMs: 0, timeoutMs: 5_000,
  })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.error ?? '', /reconnected|重连|结果未知/, '重连必须显性失败,不得静默等超时')
})

test('端口九操作全覆盖：history/answer/decline/decide/release/probe 走记录', async () => {
  const fake = new FakeSessionDriver('A', { frames: [], probeVersion: '0.1.1-rc.2' })
  const history = await fake.history('fake-9')
  assert.equal(history.sessionId, 'fake-9')
  assert.equal(history.sessionState, 'cold')
  assert.deepEqual(await fake.answerQuestion('r1', 's1', { answers: [] }), { accepted: true })
  assert.deepEqual(fake.answered, [{ rpcId: 'r1', sessionId: 's1', answer: { answers: [] } }])
  assert.deepEqual(await fake.declineQuestion('r2', 's1'), { accepted: true })
  assert.deepEqual(await fake.decideApproval('r3', 's1', 'ap1', 'rejected'), { accepted: true })
  assert.equal(fake.decided[0]?.outcome, 'rejected')
  await fake.release('fake-9')
  assert.deepEqual(fake.released, ['fake-9'])
  assert.equal(await fake.probeVersion(), '0.1.1-rc.2')
  const down = new FakeSessionDriver('B', { frames: [], probeVersion: null })
  await assert.rejects(() => down.probeVersion(), /unreachable/, '探活失败必须抛出（上层 catch 判不可达）')
})

test('端口订阅可退订：退订后不再收帧', async () => {
  const fake = new FakeSessionDriver('A', { frames: [{ kind: 'turn_end', seq: 0, turn: 1, reason: 'completed', detail: null }] })
  const seen: string[] = []
  const unsub = fake.subscribe('s1', (_sid, frame) => seen.push(frame.kind))
  unsub()
  await fake.prompt('s1', 'hi')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen, [], '退订后零投递')
})
