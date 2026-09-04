import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify'
import { count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig, ResolvedAgent } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { GatewayError, type GatewayClient, type HistoryEvent, type QuestionAnswer } from '../gateway/client.js'
import type { GatewayFrame } from '../gateway/stream.js'
import type { UpstreamClient } from '../upstream/client.js'
import { UpstreamError } from '../upstream/rpc.js'
import { runAgent, runningRunId, type RunOutcome } from '../runner.js'
import { cancelQueuedTurn, cancelQueuedTurns, drainAgentQueue, enqueueTurn } from '../chat/queue.js'
import { compactHistory } from '../chat/replay.js'
import {
  bindSession,
  chatRuns,
  createChat,
  deriveTitle,
  getChat,
  listArchivedChats,
  listChats,
  removeChat,
  renameChat,
  restoreChat,
  setTitleIfEmpty,
  touchChat,
} from '../chat/store.js'

/**
 * The chat API: threads, transcripts, and one live relay per chat.
 *
 * manager does not store the transcript. The gateway already persists it and
 * serves it from `GET /sessions/:id/history`, and a second copy would only be a
 * copy that can disagree with the first. So a transcript request is a read
 * through to the gateway, and manager's own tables hold nothing but the thread
 * metadata and the cost ledger.
 */

const sendBody = z.object({ text: z.string().min(1, 'a message is required').max(20_000) })
const renameBody = z.object({ title: z.string().min(1).max(200) })
const createBody = z.object({ agentId: z.string().min(1) })

/**
 * Browsers watching one chat.
 *
 * A relay rather than letting each browser open the gateway stream directly:
 * the gateway needs the endpoint API key, and that key must never reach a
 * browser. It also means N open tabs cost one upstream subscription, not N.
 */
interface Relay {
  subscribers: Set<FastifyReply>
}

const relays = new Map<string, Relay>()

const relayFor = (chatId: string): Relay => {
  const existing = relays.get(chatId)
  if (existing !== undefined) return existing
  const created: Relay = { subscribers: new Set() }
  relays.set(chatId, created)
  return created
}

/** 蜂群 P2：给任意会话推一帧（internal 派工完成时用它推 delegation 帧）。 */
export const publish = (chatId: string, payload: unknown): void => {
  const relay = relays.get(chatId)
  if (relay === undefined) return
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const reply of relay.subscribers) {
    // Checked rather than caught: writing to a destroyed socket does not throw,
    // so a catch here would never run and a dead watcher would be written to
    // forever.
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      relay.subscribers.delete(reply)
      continue
    }
    reply.raw.write(frame)
  }
  if (relay.subscribers.size === 0) relays.delete(chatId)
}

/**
 * How many chats have an open relay. For tests.
 *
 * A leaked subscriber is invisible from the outside -- it costs one browser
 * connection out of the six an origin gets, which shows up much later as "the
 * whole site hangs" -- so it needs to be assertable.
 */
export const openChatRelays = (): number => relays.size

/** Releases every open relay so the process can exit cleanly. */
export const closeChatRelays = (): void => {
  for (const relay of relays.values()) {
    for (const reply of relay.subscribers) {
      try {
        reply.raw.end()
      } catch {
        // Already gone.
      }
    }
  }
  relays.clear()
}

export const registerChatRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  clients: Map<string, GatewayClient>,
  requireUser: preHandlerHookHandler,
  upstreamClients?: Map<string, UpstreamClient>,
): void => {
  const agentOf = (chatAgentId: string): ResolvedAgent | undefined => config.agents[chatAgentId]

  const driverOf = (endpointId: string): 'gateway' | 'apiproxy' =>
    config.endpoints[endpointId]?.driver ?? 'gateway'

  /** Loads a chat and its agent, answering the right 404 for each. */
  const resolve = (
    chatId: string,
    reply: FastifyReply,
  ): { chat: NonNullable<ReturnType<typeof getChat>>; agent: ResolvedAgent; client: GatewayClient; upstream: UpstreamClient | null; driver: 'gateway' | 'apiproxy' } | null => {
    const chat = getChat(db, chatId)
    if (chat === null || chat.removedAt !== null) {
      void reply.code(404).send({ error: 'unknown_chat' })
      return null
    }
    const agent = agentOf(chat.agentId)
    if (agent === undefined) {
      void reply.code(409).send({
        error: 'agent_gone',
        detail: `这个会话属于 agent "${chat.agentId}"，但配置里已经没有它了`,
      })
      return null
    }
    const driver = driverOf(agent.endpoint)
    const upstream = upstreamClients?.get(agent.endpoint) ?? null
    const client = clients.get(agent.endpoint)
    if (driver === 'apiproxy' && upstream === null) {
      void reply.code(500).send({ error: 'endpoint_not_configured' })
      return null
    }
    if (driver === 'gateway' && client === undefined) {
      void reply.code(500).send({ error: 'endpoint_not_configured' })
      return null
    }
    // For gateway mode, client is always defined here; for apiproxy, we still
    // need a GatewayClient reference for routes that haven't been branched yet.
    // Use a dummy that will never be called on the apiproxy path.
    return { chat, agent, client: client!, upstream, driver }
  }

  // ---- history cache (avoids re-reading the same session log on every page open) ----

  interface CachedHistory { events: HistoryEvent[]; sessionState: string; title: string | null; at: number }
  const historyCache = new Map<string, CachedHistory>()
  const HISTORY_TTL_MS = 30_000  // cold sessions don't change; 30s is safe

  const invalidateHistory = (sessionId: string): void => { historyCache.delete(sessionId) }

  // ---- threads ------------------------------------------------------------

  app.get('/api/chats', { preHandler: requireUser }, async (_request, reply) => {
    // Grouped by agent, in config order, because that is the order the sidebar
    // draws them in and the client should not have to guess it.
    const agents = Object.values(config.agents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      public: agent.public,
      endpoint: agent.endpoint,
      busyRunId: runningRunId(agent.id),
      chats: listChats(db, agent.id),
    }))
    return reply.header('cache-control', 'no-store').send({ agents })
  })

  /**
   * Archived chats, so archiving is reversible.
   *
   * A soft delete the user cannot see into is indistinguishable from a real
   * delete, which would make "归档" a lie about their own data.
   *
   * Static segment, so it is matched ahead of `/api/chats/:id` regardless of the
   * order these are registered in.
   */
  app.get('/api/chats/archived', { preHandler: requireUser }, async (_request, reply) => {
    const chats = listArchivedChats(db).map((chat) => {
      const agent = agentOf(chat.agentId)
      return {
        ...chat,
        // Named for display, and flagged when the agent is gone: such a chat
        // cannot be restored, and the list has to say so before the button is
        // pressed.
        agentName: agent?.name ?? chat.agentId,
        agentGone: agent === undefined,
      }
    })
    return reply.header('cache-control', 'no-store').send({ chats })
  })

  app.post<{ Body: unknown }>('/api/chats', { preHandler: requireUser }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
    const agent = agentOf(parsed.data.agentId)
    if (agent === undefined) return reply.code(404).send({ error: 'unknown_agent' })

    // No gateway session yet. Creating one now would consume a slot against the
    // gateway's maxSessions for a chat the user may never type into.
    const chat = createChat(db, agent.id)
    return reply.code(201).send({ chat, turns: [], events: [] })
  })

  /**
   * 蜂群 P2：主脑派工记录（delegation 帧的数据源）。
   *
   * 该会话发起的每一次派工 = 一条 run（trigger='brain'、source_chat_id=本会话）。
   * 页面首屏读这里，实时更新靠 relay 上的 delegation_done 帧。
   */
  app.get<{ Params: { id: string } }>('/api/chats/:id/delegations', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })
    const rows = db
      .select()
      .from(schema.run)
      .where(eq(schema.run.sourceChatId, chat.id))
      .orderBy(desc(schema.run.startedAt))
      .limit(50)
      .all()
    return reply.header('cache-control', 'no-store').send({
      delegations: rows.map((r) => ({
        runId: r.id,
        agentId: r.agentId,
        agentName: config.agents[r.agentId]?.name ?? r.agentId,
        state: r.state,
        summary: r.resultSummary,
        error: r.error,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
    })
  })

  /**
   * A chat with its transcript.
   *
   * `sessionState` is reported explicitly because the three cases need three
   * different things from the user, and all of them look identical if you only
   * report a message list:
   *   - `fresh`   nothing sent yet
   *   - `live`    the gateway holds the session and it can take a turn now
   *   - `cold`    readable, and will be revived on the next message
   *   - `lost`    the gateway has no record of it at all; it cannot continue
   */
  app.get<{ Params: { id: string } }>('/api/chats/:id', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    const { chat, agent, client, upstream, driver } = found

    const base = {
      chat,
      // `workspacePath` is here rather than left to /api/status because the
      // composer prints it next to the send button, and that line is the one
      // thing this UI adds over DSH: sending to the wrong agent does not mean a
      // worse answer, it means the wrong workspace was written to. Making it
      // depend on a second, racing request would let the page render a send
      // button with no destination under it. Already visible to the same signed
      // in user through /api/status, so nothing new is exposed.
      agent: { id: agent.id, name: agent.name, public: agent.public, workspacePath: agent.workspacePath },
      busyRunId: runningRunId(agent.id),
      turns: chatRuns(db, chat.id),
    }

    if (chat.dshSessionId === null) {
      return reply.header('cache-control', 'no-store').send({ ...base, sessionState: 'fresh', events: [] })
    }

    let events: HistoryEvent[] = []
    let sessionState = 'cold'
    const t0 = Date.now()

    // Check cache first — DSH session log reads are expensive (~6s for large sessions).
    const cached = historyCache.get(chat.dshSessionId)
    if (cached !== undefined && Date.now() - cached.at < HISTORY_TTL_MS) {
      events = cached.events
      sessionState = cached.sessionState
      if (cached.title !== null && cached.title !== '') renameChat(db, chat.id, cached.title)
      app.log.info(`GET /api/chats/${chat.id}: history CACHED ${Date.now() - t0}ms, ${events.length} events`)
    } else {
      try {
        if (driver === 'apiproxy' && upstream !== null) {
          // apiproxy path: session.history returns raw events + projections.
          // compactHistory is already called inside upstream.history().
          const history = await upstream.history(chat.dshSessionId)
          events = history.events
          sessionState = history.sessionState
          if (history.title !== null && history.title !== '') renameChat(db, chat.id, history.title)
          historyCache.set(chat.dshSessionId, { events, sessionState, title: history.title, at: Date.now() })
        } else {
          // Read-only and does not wake the session, so opening an old chat costs
          // nothing on the gateway.
          const history = await client.history(chat.dshSessionId)
          // Chunks were the streaming preview of text the `message` frames already
          // carry. Replaying them costs the browser 30x the events for nothing.
          events = compactHistory(history.events)
          sessionState = history.adopted ? 'live' : 'cold'
          // The gateway names sessions itself; prefer its title over our guess.
          const title = history.header?.title
          if (typeof title === 'string' && title !== '') renameChat(db, chat.id, title)
          historyCache.set(chat.dshSessionId, { events, sessionState, title: title ?? null, at: Date.now() })
        }
        app.log.info(`GET /api/chats/${chat.id}: history ${driver} ${Date.now() - t0}ms, ${events.length} events`)
      } catch (error) {
        app.log.warn(`GET /api/chats/${chat.id}: history ${driver} failed after ${Date.now() - t0}ms: ${(error as Error).message}`)
        if (error instanceof GatewayError && error.status === 404) {
          sessionState = 'lost'
        } else if (error instanceof UpstreamError && error.code === 'not_found') {
          sessionState = 'lost'
        } else {
          const detail = error instanceof GatewayError ? error.message
            : error instanceof UpstreamError ? error.message
              : String(error)
          return reply.code(502).send({ error: 'gateway_unreachable', detail })
        }
      }
    }

    const refreshed = getChat(db, chat.id) ?? chat
    return reply.header('cache-control', 'no-store').send({ ...base, chat: refreshed, sessionState, events })
  })

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/chats/:id',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const parsed = renameBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' })
      renameChat(db, found.chat.id, parsed.data.title)
      return reply.send({ chat: getChat(db, found.chat.id) })
    },
  )

  /**
   * Hides a chat and hands its gateway slot back.
   *
   * Still named `remove`, not `delete`, because nothing is destroyed: the
   * transcript stays on the gateway and the `dshSessionId` stays on the row, so
   * the conversation remains readable and could be adopted again. What the
   * release gives up is one slot against the gateway's `maxSessions`. Chat
   * sessions are long-lived, so without this every removed chat would hold a
   * slot until DSH restarted.
   *
   * The run rows stay too -- they are the cost ledger, and money spent does not
   * become unspent.
   *
   * Best effort on the release: a chat whose agent has left the config, or an
   * unreachable gateway, must still disappear from the list when asked. The
   * response reports what actually happened rather than assuming.
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/remove', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })

    let slotReleased = false
    let releaseFailure: string | null = null
    if (chat.dshSessionId !== null) {
      const agent = agentOf(chat.agentId)
      const driver = agent !== undefined ? driverOf(agent.endpoint) : 'gateway'
      if (driver === 'apiproxy') {
        // apiproxy has no slot management; sessions persist in DSH until
        // archived via workspace.archiveSession (which we don't call).
        // Nothing to release.
        slotReleased = false
      } else {
        const client = agent === undefined ? undefined : clients.get(agent.endpoint)
        if (client === undefined) {
          releaseFailure = `agent "${chat.agentId}" 已不在配置里，无法归还 DSH 会话名额`
        } else {
          try {
            const result = await client.release(chat.dshSessionId)
            slotReleased = result.released
          } catch (error) {
            releaseFailure = error instanceof GatewayError ? error.message : String(error)
            app.log.warn(`chat ${chat.id}: releasing session ${chat.dshSessionId} failed: ${releaseFailure}`)
          }
        }
      }
    }

    removeChat(db, chat.id)
    // Queued turns of this chat must not fire after the chat is gone.
    cancelQueuedTurns(chat.id)

    const detail =
      chat.dshSessionId === null
        ? '会话已归档，可在【已归档】里恢复'
        : releaseFailure !== null
          ? `会话已归档，但 DSH 会话名额没能归还，仍占用网关上限：${releaseFailure}`
          : slotReleased
            ? '会话已归档，DSH 会话名额已归还。历史记录保留，可恢复。'
            : '会话已归档。网关已经不持有这个会话，无名额需要归还。历史记录保留，可恢复。'

    return reply.send({
      ok: true,
      removedFromManager: true,
      dshSessionId: chat.dshSessionId,
      slotReleased,
      releaseFailure,
      detail,
    })
  })

  /**
   * 蜂群 Q5：清掉「建了但一个字没写」的空会话。
   *
   * 硬删除而不是归档：空会话没有 transcript、没有账单、没有网关 session，
   * 把这样的空壳收进「可恢复的已归档」反而是对恢复承诺的谎报。有过回合
   * 或已被网关起过标题的会话一律 409——红线：有内容的会话只能归档，
   * 永远不许物理删除。
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/vacate', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null || chat.removedAt !== null) return reply.code(404).send({ error: 'unknown_chat' })

    const turns = db
      .select({ n: count() })
      .from(schema.run)
      .where(eq(schema.run.chatId, chat.id))
      .all()
    if ((turns[0]?.n ?? 0) > 0 || (chat.title ?? '') !== '') {
      return reply.code(409).send({
        error: 'chat_not_empty',
        detail: '这个会话有内容，只能归档，不会自动删除',
      })
    }

    db.delete(schema.chat).where(eq(schema.chat.id, chat.id)).run()
    return reply.send({ ok: true, vacated: true })
  })

  /**
   * Un-archives a chat.
   *
   * The gateway slot was handed back on archive, so the thread may come back
   * `cold` (revived on the next message) or `lost`. That is reported by
   * `GET /api/chats/:id` and deliberately not hidden here: silently reviving a
   * session would spend money on a click the user thought was free.
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/restore', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null) return reply.code(404).send({ error: 'unknown_chat' })
    if (chat.removedAt === null) return reply.send({ ok: true, chat, detail: '这个会话本来就在列表里' })
    if (agentOf(chat.agentId) === undefined) {
      // Restoring it would put a row in a tree that has no branch for it: the
      // sidebar groups by configured agents, so it would come back invisible.
      return reply.code(409).send({
        error: 'agent_gone',
        detail: `这个会话属于 agent "${chat.agentId}"，配置里已经没有它了，恢复后不会出现在任何 agent 下`,
      })
    }
    restoreChat(db, chat.id)
    return reply.send({ ok: true, chat: getChat(db, chat.id), detail: '会话已恢复' })
  })

  // ---- turns --------------------------------------------------------------

  /**
   * One chat turn end to end: run + the post-run bookkeeping (history cache,
   * session binding, turn_done frame). Shared by the direct path and the queue,
   * so a queued turn does exactly what a direct one does.
   */
  const runChatTurn = async (
    chat: NonNullable<ReturnType<typeof getChat>>,
    agent: ResolvedAgent,
    client: GatewayClient,
    upstream: UpstreamClient | null,
    driver: 'gateway' | 'apiproxy',
    text: string,
  ): Promise<RunOutcome> => {
    const outcome = await runAgent(
      {
        db,
        pricing: config.pricing,
        log: {
          info: (m) => app.log.info(m),
          warn: (m) => app.log.warn(m),
          error: (m) => app.log.error(m),
        },
      },
      {
        agent,
        client,
        upstream: upstream ?? undefined,
        driver,
        prompt: text,
        trigger: 'manual',
        timeoutMs: config.runner.timeoutMs,
        silenceMs: config.runner.silenceMs,
        chatId: chat.id,
        sessionId: chat.dshSessionId,
        // A conversation continues on this session, so it keeps its slot.
        // Releasing here would make the next message pay for a cold resume.
        keepSession: true,
        // The gateway echoes the message we just sent back as its own
        // `user` frame, and the route has already published one above. Both
        // would reach the browser and draw the same bubble twice. manager
        // owns the echo because it can publish before the session even
        // exists, so the upstream copy is the redundant one.
        onFrame: (frame: GatewayFrame) => {
          if (frame.kind === 'user') return
          publish(chat.id, frame)
        },
      },
    )

    // Invalidate history cache — the turn added new events.
    if (outcome.sessionId !== null) invalidateHistory(outcome.sessionId)

    // First turn: remember the session so the next message continues it
    // rather than starting a fresh conversation.
    if (outcome.sessionId !== null && chat.dshSessionId === null) {
      bindSession(db, chat.id, outcome.sessionId)
    } else {
      touchChat(db, chat.id)
    }

    publish(chat.id, { kind: 'turn_done', runId: outcome.runId, state: outcome.state, error: outcome.error })
    return outcome
  }

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/chats/:id/messages',
    {
      preHandler: requireUser,
      // A turn costs money and holds the agent, so an authenticated but stuck
      // tab cannot spend all day.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const { chat, agent, client, upstream, driver } = found

      const parsed = sendBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
      }
      const text = parsed.data.text

      // Titled from the user's own first words before the turn runs, so the
      // sidebar has a label even if the turn then fails.
      setTitleIfEmpty(db, chat.id, deriveTitle(text))
      touchChat(db, chat.id)

      // Echoed to watchers immediately: the sender already has it on screen, but
      // a second tab should not sit blank until the assistant replies.
      publish(chat.id, { kind: 'user', text, at: Date.now() })

      // DSH's own queue semantics: accept immediately, run the turn in the
      // background, and report progress through the relay. A synchronous POST
      // would hold the browser's `sending` state for the whole turn and make
      // the second message impossible to send.
      try {
        const busyRunId = runningRunId(agent.id)
        if (busyRunId !== null) {
          // Scheme C: queue instead of refuse. Turns stay serialised per
          // workspace (each still snapshots alone), but the sender no longer
          // hits a wall — the queued turn starts automatically when the
          // current one finishes.
          const queuedId = randomUUID()
          const position = enqueueTurn(agent.id, {
            id: queuedId,
            chatId: chat.id,
            // Re-read the chat when the turn finally runs: the queued closure
            // must not carry a stale snapshot (a null dshSessionId would make
            // the second turn start a fresh session), and an archived chat
            // must not fire at all.
            execute: () => {
              const fresh = getChat(db, chat.id)
              if (fresh === null || fresh.removedAt !== null) return Promise.resolve()
              return runChatTurn(fresh, agent, client, upstream, driver, text)
                .then(() => undefined)
                .catch((error: unknown) => {
                  // No HTTP reply exists for a queued turn; the failure must
                  // still reach the browser through the relay.
                  publish(chat.id, {
                    kind: 'turn_done',
                    state: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                  })
                })
            },
          })
          publish(chat.id, { kind: 'turn_queued', id: queuedId, position, text })
          return reply.code(202).send({
            queued: true,
            position,
            runningRunId: busyRunId,
            chat: getChat(db, chat.id),
          })
        }

        // Idle: start in the background and answer at once.
        void runChatTurn(chat, agent, client, upstream, driver, text)
          .then(() => drainAgentQueue(agent.id))
          .catch((error: unknown) => {
            // No HTTP reply carries the failure any more; the relay does.
            publish(chat.id, {
              kind: 'turn_done',
              state: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
          })
        return reply.code(202).send({ accepted: true, chat: getChat(db, chat.id) })
      } catch (error) {
        app.log.error(`chat turn failed for ${chat.id}: ${(error as Error).message}`)
        return reply.code(500).send({ error: 'turn_failed', detail: (error as Error).message })
      }
    },
  )

  /**
   * Drop one queued turn. Edit/undo pulls the text back into the composer;
   * delete just removes it. Idempotent: a turn that already started (or an
   * unknown id) answers ok so the UI can remove the row optimistically.
   */
  app.post<{ Params: { id: string; turnId: string } }>(
    '/api/chats/:id/queued/:turnId/cancel',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      cancelQueuedTurn(found.chat.id, request.params.turnId)
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { id: string } }>('/api/chats/:id/cancel', { preHandler: requireUser }, async (request, reply) => {
    const found = resolve(request.params.id, reply)
    if (found === null) return reply
    const { chat, client, upstream, driver } = found
    if (chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
    try {
      if (driver === 'apiproxy' && upstream !== null) {
        await upstream.cancel(chat.dshSessionId)
      } else {
        await client.cancel(chat.dshSessionId)
      }
      return reply.send({ ok: true })
    } catch (error) {
      return reply.code(502).send({
        error: 'cancel_failed',
        detail: error instanceof GatewayError ? error.message
          : error instanceof UpstreamError ? error.message
            : String(error),
      })
    }
  })

  // ---- answering what the agent is blocked on -----------------------------

  /**
   * Answer, or decline, one interactive question.
   *
   * A thin pass-through on purpose: the gateway owns the pending question and the
   * validation of an answer against it, and duplicating either here would mean
   * two places deciding what a valid answer is. Everything this adds is the
   * session lookup and the browser's own authentication.
   */
  app.post<{ Params: { id: string; questionId: string }; Body: { answers?: unknown; decline?: unknown } }>(
    '/api/chats/:id/questions/:questionId',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const { chat, client, upstream, driver } = found
      if (chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
      const body = request.body ?? {}
      try {
        if (driver === 'apiproxy' && upstream !== null) {
          // apiproxy: questionId is the rpcId from the mux frame.
          if (body.decline === true) {
            await upstream.declineQuestion(request.params.questionId, chat.dshSessionId)
            return reply.send({ ok: true, outcome: 'cancelled' })
          }
          if (!Array.isArray(body.answers)) return reply.code(400).send({ error: 'answers_required' })
          await upstream.answerQuestion(request.params.questionId, chat.dshSessionId, { answers: body.answers })
          return reply.send({ ok: true, outcome: 'answered' })
        } else {
          if (body.decline === true) {
            await client.declineQuestion(chat.dshSessionId, request.params.questionId)
            return reply.send({ ok: true, outcome: 'cancelled' })
          }
          if (!Array.isArray(body.answers)) return reply.code(400).send({ error: 'answers_required' })
          await client.answerQuestion(chat.dshSessionId, request.params.questionId, body.answers as QuestionAnswer[])
          return reply.send({ ok: true, outcome: 'answered' })
        }
      } catch (error) {
        // The gateway's own detail is passed through rather than flattened: a
        // rejected answer says exactly what was wrong with it, and that message
        // is the only thing that lets the person fix it.
        const status = error instanceof GatewayError && error.status === 404 ? 409
          : error instanceof UpstreamError ? 502
            : 502
        return reply.code(status).send({
          error: 'answer_failed',
          detail: error instanceof GatewayError ? error.detail
            : error instanceof UpstreamError ? error.message
              : String(error),
        })
      }
    },
  )

  /** Decide one permission prompt. `allowed-once` covers only the call in hand. */
  app.post<{ Params: { id: string; decisionId: string }; Body: { outcome?: unknown; approvalId?: unknown } }>(
    '/api/chats/:id/approvals/:decisionId',
    { preHandler: requireUser },
    async (request, reply) => {
      const found = resolve(request.params.id, reply)
      if (found === null) return reply
      const { chat, client, upstream, driver } = found
      if (chat.dshSessionId === null) return reply.code(409).send({ error: 'no_session' })
      const outcome = request.body?.outcome
      if (outcome !== 'allowed-once' && outcome !== 'rejected') return reply.code(400).send({ error: 'invalid_outcome' })
      try {
        if (driver === 'apiproxy' && upstream !== null) {
          // apiproxy: decisionId is the rpcId from the mux frame; the respond
          // contract also requires the approvalId and sessionId to name the
          // exact pending request, so the browser echoes the approvalId the
          // approval_pending frame carried.
          const approvalId = request.body?.approvalId
          if (typeof approvalId !== 'string' || approvalId === '') return reply.code(400).send({ error: 'approval_id_required' })
          await upstream.decideApproval(request.params.decisionId, chat.dshSessionId, approvalId, outcome)
        } else {
          await client.decideApproval(chat.dshSessionId, request.params.decisionId, outcome)
        }
        return reply.send({ ok: true, outcome })
      } catch (error) {
        const status = error instanceof GatewayError && error.status === 404 ? 409
          : error instanceof UpstreamError ? 502
            : 502
        return reply.code(status).send({
          error: 'decide_failed',
          detail: error instanceof GatewayError ? error.detail
            : error instanceof UpstreamError ? error.message
              : String(error),
        })
      }
    },
  )

  // ---- relay --------------------------------------------------------------

  /**
   * Live frames for one chat, as server-sent events.
   *
   * Carries live frames only. History comes from `GET /api/chats/:id`, because
   * the gateway's own `hello` frame replays the entire durable log -- relaying
   * that would re-render the whole conversation on every reconnect, and the same
   * confusion between replayed and live events is what makes double-billing
   * possible upstream.
   */
  app.get<{ Params: { id: string } }>('/api/chats/:id/events', { preHandler: requireUser }, async (request, reply) => {
    const chat = getChat(db, request.params.id)
    if (chat === null || chat.removedAt !== null) return reply.code(404).send({ error: 'unknown_chat' })

    const relay = relayFor(chat.id)

    // Fastify is told to stop tracking this reply: the response is written by
    // hand and never ends, so leaving it inside the normal lifecycle only means
    // the framework is holding a request that will never complete.
    reply.hijack()

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx and Caddy would otherwise buffer the stream into uselessness.
      'x-accel-buffering': 'no',
    })
    reply.raw.write('retry: 3000\n')
    reply.raw.write(`data: ${JSON.stringify({ kind: 'hello', chatId: chat.id, at: Date.now() })}\n\n`)
    relay.subscribers.add(reply)

    // Phones drop idle sockets, and so do proxies. A comment line is a no-op for
    // the client but keeps the connection open.
    //
    // The exit condition is `destroyed`, not a thrown error: `write` on a dead
    // socket does not throw, it reports through a callback. A try/catch here
    // never fires, so the interval and the subscriber would live until the
    // process exits -- one leaked entry per abandoned browser.
    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        clearInterval(heartbeat)
        drop()
        return
      }
      reply.raw.write(': ping\n\n')
    }, 25_000)

    const drop = (): void => {
      clearInterval(heartbeat)
      relay.subscribers.delete(reply)
      // Dropped when the last watcher leaves, so the map cannot grow without
      // bound over a long uptime. Safe during a turn in flight: `publish` looks
      // the relay up by chat id on every frame, so a browser that connects
      // mid-turn gets a fresh relay and still receives the rest of the stream.
      if (relay.subscribers.size === 0) relays.delete(chat.id)
    }

    // Both, deliberately: `close` covers the browser going away cleanly, `error`
    // covers a socket that broke. Either way this subscriber must stop being
    // counted, or a chat can end up with watchers nobody is watching from.
    request.raw.on('close', drop)
    request.raw.on('error', drop)
    reply.raw.on('error', drop)
  })
}
