import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { startFakeGateway, type FakeGateway, type FakeScript } from '../gateway/fake.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { closeChatRelays, openChatRelays, registerChatRoutes } from './chat.js'

/**
 * The chat relay, over a real socket.
 *
 * These need an actual listening server rather than `app.inject`: the behaviour
 * under test is a stream that stays open across a request, and inject resolves
 * with a finished response.
 */

const API_KEY = 'test-key'

const agentFor = (workspacePath: string): ResolvedAgent => ({
  id: 'personal',
  name: 'Personal',
  endpoint: 'A',
  workspacePath,
  public: false,
  preset: null,
  gitRemote: null,
  provider: null,
  model: null,
  sandboxMode: null,
})

const configFor = (gw: FakeGateway, agent: ResolvedAgent): AppConfig => ({
  listen: { host: '127.0.0.1', port: 0 },
  endpoints: { A: { id: 'A', url: gw.url, driver: 'gateway', prefix: gw.prefix, key: API_KEY, sandboxBase: null, sandboxKey: '', spawn: null } },
  agents: { personal: agent },
  runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
  databasePath: ':memory:',
  pricing: DEFAULT_PRICING,
  sessionSecret: 'x'.repeat(32),
  initialUser: { username: 'admin', password: null },
  warnings: [],
})

const apps: FastifyInstance[] = []
const gateways: FakeGateway[] = []

interface Harness {
  base: string
  db: Db
}

const boot = async (script: FakeScript): Promise<Harness> => {
  const gw = await startFakeGateway(script, API_KEY)
  gateways.push(gw)

  const dir = mkdtempSync(join(tmpdir(), 'route-chat-'))
  const workspace = mkdtempSync(join(tmpdir(), 'route-chat-ws-'))
  const { db } = openDb(join(dir, 'test.db'))
  const agent = agentFor(workspace)
  db.insert(schema.agent)
    .values({
      id: 'personal',
      name: 'Personal',
      workspacePath: workspace,
      endpoint: 'A',
      preset: null,
      gitRemote: null,
      public: 0,
      createdAt: Date.now(),
    })
    .run()

  const app = Fastify()
  apps.push(app)
  const clients = new Map([['A', new GatewayClient({ id: 'A', url: gw.url, driver: 'gateway', prefix: gw.prefix, key: API_KEY, sandboxBase: null, sandboxKey: '', spawn: null })]])
  // Auth has its own tests; every request here counts as signed in.
  registerChatRoutes(app, configFor(gw, agent), db, clients, async () => undefined)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, db }
}

after(async () => {
  closeChatRelays()
  await Promise.all(apps.map((a) => a.close()))
  await Promise.all(gateways.map((g) => g.close()))
})

/**
 * Collects relayed frames until the turn reports itself finished.
 *
 * Reading to end-of-stream is not an option: the relay is deliberately kept open
 * for the next turn, so a test that waited for EOF would hang.
 */
const collectFrames = async (
  response: Response,
  stopWhen: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> => {
  const reader = response.body?.getReader()
  assert.ok(reader !== undefined, 'the relay answered without a body')
  const decoder = new TextDecoder()
  const frames: Record<string, unknown>[] = []
  let buffered = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    // Frames are separated by a blank line; a partial tail stays buffered.
    const blocks = buffered.split('\n\n')
    buffered = blocks.pop() ?? ''
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>
        frames.push(frame)
      }
    }
    if (frames.some(stopWhen)) break
  }

  await reader.cancel()
  return frames
}

const newChat = async (base: string): Promise<string> => {
  const created = await fetch(`${base}/api/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'personal' }),
  })
  assert.equal(created.status, 201)
  const body = (await created.json()) as { chat: { id: string } }
  return body.chat.id
}

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

test('the user message is relayed once, not twice', async () => {
  // The gateway echoes the instruction back as its own `user` event, and this
  // route publishes one the moment the message arrives. Relaying both draws the
  // same bubble twice in every watching tab.
  const { base } = await boot({
    frames: [
      { kind: 'user', text: '把这周的开销汇总一下' },
      { kind: 'message', text: '好的。', reasoning: null, usage: { inputTokens: 10, outputTokens: 5 } },
      { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
    ],
  })
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  assert.equal(stream.status, 200)
  const collected = collectFrames(stream, (f) => f.kind === 'turn_done')

  const sent = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '把这周的开销汇总一下' }),
  })
  assert.equal(sent.status, 202)

  const frames = await collected
  const users = frames.filter((f) => f.kind === 'user')
  assert.equal(users.length, 1, `expected one user frame, got ${JSON.stringify(users)}`)
  assert.equal(users[0]?.text, '把这周的开销汇总一下')
  // The rest of the turn still arrives; the filter is not swallowing the stream.
  assert.ok(
    frames.some((f) => f.kind === 'message'),
    'the assistant reply is still relayed',
  )
  assert.ok(frames.some((f) => f.kind === 'turn_done'))
})

test('a browser that walks away frees its connection', async () => {
  // The failure this guards against does not look like a bug in the relay: a
  // subscriber that is never dropped keeps one of the six connections HTTP/1.1
  // gives an origin, and six of those make every later request -- including the
  // next page's HTML -- hang with nothing in the log to explain it.
  const { base } = await boot({ frames: [] })
  const chatId = await newChat(base)
  const before = openChatRelays()

  const controller = new AbortController()
  const stream = await fetch(`${base}/api/chats/${chatId}/events`, { signal: controller.signal })
  assert.equal(stream.status, 200)
  // One chunk, with the reader left open: `collectFrames` cancels the body when
  // it is done, which would end the stream and hide the very thing under test.
  const reader = stream.body?.getReader()
  assert.ok(reader !== undefined)
  await reader.read()
  assert.equal(openChatRelays(), before + 1, 'the watcher is registered')

  controller.abort()

  // The socket teardown is asynchronous; poll rather than sleep a fixed amount.
  for (let i = 0; i < 50 && openChatRelays() > before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(openChatRelays(), before, 'and unregistered once the browser is gone')
})

// ---------------------------------------------------------------------------
// archive and restore
// ---------------------------------------------------------------------------

test('archiving hides a chat, listing it as archived, and restore brings it back', async () => {
  // Archiving is a soft delete, so the round trip has to actually close: a chat
  // that disappears from both lists is indistinguishable from a deleted one.
  const { base } = await boot({ frames: [] })
  const chatId = await newChat(base)

  const archived = await fetch(`${base}/api/chats/${chatId}/remove`, { method: 'POST' })
  assert.equal(archived.status, 200)

  const live = (await (await fetch(`${base}/api/chats`)).json()) as {
    agents: { chats: { id: string }[] }[]
  }
  assert.ok(
    !live.agents.some((a) => a.chats.some((c) => c.id === chatId)),
    'an archived chat is out of the sidebar list',
  )

  const list = (await (await fetch(`${base}/api/chats/archived`)).json()) as {
    chats: { id: string; agentName: string; agentGone: boolean; removedAt: number | null }[]
  }
  const row = list.chats.find((c) => c.id === chatId)
  assert.ok(row !== undefined, 'the archived chat is listed')
  assert.equal(row.agentName, 'Personal')
  assert.equal(row.agentGone, false)
  assert.ok(typeof row.removedAt === 'number', 'the row says when it was archived')

  const restored = await fetch(`${base}/api/chats/${chatId}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200)

  const after = (await (await fetch(`${base}/api/chats`)).json()) as {
    agents: { chats: { id: string }[] }[]
  }
  assert.ok(
    after.agents.some((a) => a.chats.some((c) => c.id === chatId)),
    'a restored chat is back in the sidebar list',
  )
  const emptied = (await (await fetch(`${base}/api/chats/archived`)).json()) as { chats: { id: string }[] }
  assert.ok(!emptied.chats.some((c) => c.id === chatId), 'and out of the archive')
})

test('/api/chats/archived is not read as a chat id', async () => {
  // `archived` is a static segment sharing a prefix with `/api/chats/:id`. If
  // routing ever prefers the parameter, this becomes a 404 for a chat nobody
  // created -- and the archive page silently shows nothing.
  const { base } = await boot({ frames: [] })
  const response = await fetch(`${base}/api/chats/archived`)
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(((await response.json()) as { chats: unknown[] }).chats))
})

test('restoring a chat that was never archived is not an error', async () => {
  // Two tabs, one archive: the second restore must not report a failure for a
  // state that already matches what was asked for.
  const { base } = await boot({ frames: [] })
  const chatId = await newChat(base)
  const response = await fetch(`${base}/api/chats/${chatId}/restore`, { method: 'POST' })
  assert.equal(response.status, 200)
})

test('the echo arrives before the gateway is even involved', async () => {
  // The point of publishing our own copy: a second tab should show the message
  // immediately, not sit blank until a session has been created upstream.
  const { base } = await boot({
    frames: [
      { kind: 'message', text: '收到', reasoning: null, usage: { inputTokens: 1, outputTokens: 1 } },
      { kind: 'turn_end', turn: 1, reason: 'completed', detail: null },
    ],
    gapMs: 50,
  })
  const chatId = await newChat(base)

  const stream = await fetch(`${base}/api/chats/${chatId}/events`)
  const collected = collectFrames(stream, (f) => f.kind === 'user')

  void fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗' }),
  })

  const frames = await collected
  const first = frames.find((f) => f.kind === 'user')
  assert.equal(first?.text, '在吗')
  assert.ok(typeof first?.at === 'number', "manager's own echo carries a timestamp")
})

test('delegations: a chat lists the brain runs it dispatched (蜂群 P2)', async () => {
  const { base, db } = await boot({ frames: [] })
  const chatId = await newChat(base)
  const now = Date.now()
  db.insert(schema.run)
    .values({
      id: 'run-brain-1',
      agentId: 'personal',
      chatId: null,
      sourceChatId: chatId,
      cronId: null,
      apiKeyId: null,
      dshSessionId: null,
      trigger: 'brain',
      idempotencyKey: null,
      state: 'done',
      resultSummary: '周报已更新',
      startedAt: now,
      endedAt: now,
      error: null,
      commitHash: null,
    })
    .run()

  const response = await fetch(`${base}/api/chats/${chatId}/delegations`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { delegations: Array<{ runId: string; state: string; agentName: string; summary: string | null }> }
  assert.equal(body.delegations.length, 1)
  assert.equal(body.delegations[0]?.runId, 'run-brain-1')
  assert.equal(body.delegations[0]?.state, 'done')
  assert.equal(body.delegations[0]?.agentName, 'Personal')
  assert.equal(body.delegations[0]?.summary, '周报已更新')

  const missing = await fetch(`${base}/api/chats/no-such-chat/delegations`)
  assert.equal(missing.status, 404)
})

test('vacate: an empty chat is hard-deleted; a chat with turns or a title refuses (蜂群 Q5)', async () => {
  const { base, db } = await boot({ frames: [] })
  const now = Date.now()

  const insertChat = (id: string, title: string | null) => {
    db.insert(schema.chat)
      .values({ id, agentId: 'personal', title, createdAt: now, lastActiveAt: now, removedAt: null, dshSessionId: null })
      .run()
  }

  // 空会话：删掉，行消失
  insertChat('empty-1', null)
  const vacated = await fetch(`${base}/api/chats/empty-1/vacate`, { method: 'POST' })
  assert.equal(vacated.status, 200)
  assert.deepEqual(await vacated.json(), { ok: true, vacated: true })
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, 'empty-1')).all().length, 0)

  // 有回合：409，行保留
  insertChat('busy-1', null)
  db.insert(schema.run)
    .values({
      id: 'run-1',
      agentId: 'personal',
      chatId: 'busy-1',
      sourceChatId: null,
      cronId: null,
      apiKeyId: null,
      dshSessionId: null,
      trigger: 'manual',
      idempotencyKey: null,
      state: 'done',
      resultSummary: 'x',
      startedAt: now,
      endedAt: now,
      error: null,
      commitHash: null,
    })
    .run()
  const busy = await fetch(`${base}/api/chats/busy-1/vacate`, { method: 'POST' })
  assert.equal(busy.status, 409)
  assert.equal(db.select().from(schema.chat).where(eq(schema.chat.id, 'busy-1')).all().length, 1)

  // 有标题：409
  insertChat('titled-1', '被网关起过名字')
  const titled = await fetch(`${base}/api/chats/titled-1/vacate`, { method: 'POST' })
  assert.equal(titled.status, 409)

  // 未知 / 已归档：404
  const missing = await fetch(`${base}/api/chats/no-such/vacate`, { method: 'POST' })
  assert.equal(missing.status, 404)
  insertChat('gone-1', null)
  db.update(schema.chat).set({ removedAt: now }).where(eq(schema.chat.id, 'gone-1')).run()
  const archived = await fetch(`${base}/api/chats/gone-1/vacate`, { method: 'POST' })
  assert.equal(archived.status, 404)
})
