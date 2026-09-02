/**
 * Pure-function translation layer between the apiproxy wire format and the
 * manager's own types.
 *
 * Two directions:
 * 1. mux frame payload / history entry → manager's HistoryEvent (same shape as GatewayEvent)
 * 2. manager inputs → apiproxy RPC params
 *
 * Wire reality (dsh-host-apiproxy, DSH 0.1.1-rc.2):
 * - mux messages are WebSocket messages carrying the ServerRequest full form
 *   `{ type:'server-request', rpcId, method, payload }`; the payload of a
 *   `session/event` frame is `{ type:'session/event', sessionId, event, view? }`,
 *   where `event` is `{ type, seq, time, data }`.
 * - `session.history` returns `{ events: [{ event, view? }], hasMore, projections? }`,
 *   one wrapper per entry.
 * - `session.list` returns `{ items: [{ sessionId, updatedAt, running, blank, ... }] }`.
 * - `session/projection` frames arrive one key at a time:
 *   `{ type:'session/projection', sessionId, key, value, seq }`.
 *
 * This module re-implements the subset of the gateway's eventPayload we need
 * rather than importing from dsh-api-gateway, keeping the two repos decoupled.
 */

import type { HistoryEvent } from '../gateway/client.js'
import type { TokenUsage, GatewayFrame } from '../gateway/stream.js'

// ---- mux frame → HistoryEvent ----

/**
 * The payload of a mux ServerRequest (the `payload` slot of
 * `{ type:'server-request', rpcId, method, payload }` over the /api/events.mux
 * WebSocket). The `type` field mirrors the envelope's `method`.
 */
export interface MuxFrame {
  type: string
  sessionId?: string
  /** Present on `session/event` frames. */
  event?: { type?: string; seq?: number; data?: unknown; time?: number }
  /** Present on `session/projection` frames: one key per frame. */
  key?: string
  value?: unknown
  /** Present on `question/requested` frames. */
  questions?: { id: string; question: string; [k: string]: unknown }[]
  /** Present on `question/resolved` frames. */
  questionRpcId?: string
  /** Present on `approval/requested` / `approval/resolved` frames. */
  approvalId?: string
  toolName?: string
  reason?: string
  /** Present on `question/resolved` / `approval/resolved` frames. */
  outcome?: string
  [key: string]: unknown
}

// ---- event mapping (mirrors dsh-api-gateway/src/events.ts) ----

const extractBlocks = (content: unknown): { text: string; reasoning: string } => {
  let text = ''
  let reasoning = ''
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text') text += String(b.text)
        else if (b.type === 'reasoning') reasoning += String(b.text)
      }
    }
  }
  return { text, reasoning }
}

const OPTIONAL_USAGE_KEYS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

const normalizeUsageLocal = (usage: unknown): TokenUsage | null => {
  if (usage === null || typeof usage !== 'object') return null
  const source = usage as Record<string, unknown>
  const count = (key: string): number | undefined => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const inputTokens = count('inputTokens')
  const outputTokens = count('outputTokens')
  if (inputTokens === undefined && outputTokens === undefined) return null
  const out: TokenUsage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
  for (const key of OPTIONAL_USAGE_KEYS) {
    const value = count(key)
    if (value !== undefined) out[key] = value
  }
  return out
}

const chunkJson = (chunk: unknown): Record<string, unknown> | null => {
  if (chunk === null || typeof chunk !== 'object') return null
  const c = chunk as Record<string, unknown>
  switch (c.type) {
    case 'text-delta': return { type: 'text-delta', text: String(c.text) }
    case 'reasoning-delta': return { type: 'reasoning-delta', text: String(c.text) }
    case 'tool-call-delta': return { type: 'tool-call-delta', id: c.id == null ? null : String(c.id), name: c.name == null ? null : String(c.name), argumentsDelta: String(c.argumentsDelta ?? '') }
    case 'usage': return { type: 'usage', usage: normalizeUsageLocal(c.usage) }
    case 'finish': return { type: 'finish', reason: (c.reason as Record<string, unknown>)?.kind ? String((c.reason as Record<string, unknown>).kind) : 'unknown' }
    default: return null
  }
}

/**
 * Maps a raw session-log event (from mux or history) to a manager HistoryEvent.
 * Returns `null` for event types that have no wire form (e.g. internal bookkeeping).
 */
export const eventPayload = (event: unknown): HistoryEvent | null => {
  if (event === null || typeof event !== 'object') return null
  const e = event as Record<string, unknown>
  const data = (e.data ?? null) as Record<string, unknown> | null
  const seq = typeof e.seq === 'number' ? e.seq : 0
  switch (e.type) {
    case 'user/message':
      return { kind: 'user', seq, messageId: data?.id ? String(data.id) : null, text: extractBlocks(data?.content).text }
    case 'assistant/chunk': {
      const c = chunkJson(data?.chunk)
      if (c === null) return null
      return { kind: 'chunk', seq, chunk: c }
    }
    case 'assistant/message': {
      const parts = extractBlocks((data?.message as Record<string, unknown>)?.content)
      return { kind: 'message', seq, text: parts.text, reasoning: parts.reasoning !== '' ? parts.reasoning : null, usage: normalizeUsageLocal(data?.usage) }
    }
    case 'tool/call':
      return { kind: 'tool_call', seq, name: data ? String(data.name) : '', arguments: data ? String(data.arguments) : '' }
    case 'tool/result': {
      const message = data?.message as Record<string, unknown> | undefined
      const block = message && Array.isArray(message.content) ? message.content[0] as Record<string, unknown> | null : null
      return {
        kind: 'tool_result',
        seq,
        isError: Boolean(data && ((data as Record<string, unknown>).error || (block && block.isError))),
        text: block?.content ? extractBlocks(block.content).text : '',
      }
    }
    case 'approval/asked':
      return { kind: 'approval_asked', seq, id: data?.id ? String(data.id) : '', toolName: data?.toolName ? String(data.toolName) : '', callId: data?.callId ? String(data.callId) : null, reason: data?.reason ? String(data.reason) : null }
    case 'approval/decided':
      return { kind: 'approval_decided', seq, id: data?.id ? String(data.id) : '', outcome: data?.outcome ? String(data.outcome) : 'unknown' }
    case 'approval/policy':
      return { kind: 'approval_policy', seq, policy: data?.policy ? String(data.policy) : 'unknown', source: data?.source ? String(data.source) : null }
    case 'turn/start':
      return { kind: 'turn_start', seq, turn: data?.turn ?? null }
    case 'turn/end': {
      const reason = (data?.reason ?? null) as Record<string, unknown> | null
      let detail = null
      if (reason?.kind === 'error' && reason.error) {
        const err = reason.error as Record<string, unknown>
        detail = { message: String(err.message ?? ''), code: String(err.code ?? '') }
      }
      if (reason?.kind === 'aborted' && reason.reason) {
        const r = reason.reason as Record<string, unknown>
        detail = { cause: String(r.kind ?? '') }
      }
      return { kind: 'turn_end', seq, turn: data?.turn ?? null, reason: reason ? String(reason.kind) : 'unknown', detail }
    }
    default:
      return null
  }
}

/**
 * Maps a batch of raw events (from `session.history`) to HistoryEvent[].
 * Drops events with no wire form.
 */
export const mapEvents = (events: readonly unknown[]): HistoryEvent[] => {
  const out: HistoryEvent[] = []
  for (const event of events) {
    const mapped = eventPayload(event)
    if (mapped !== null) out.push(mapped)
  }
  return out
}

/**
 * Extracts a HistoryEvent from a mux `session/event` frame.
 * Returns `null` for non-event frames or unmappable events.
 */
export const muxFrameToEvent = (frame: MuxFrame): HistoryEvent | null => {
  if (frame.type !== 'session/event' || frame.event === undefined) return null
  return eventPayload(frame.event)
}

/**
 * Extracts a GatewayFrame (for the SSE relay) from a mux `session/event` frame.
 * This is the same as muxFrameToEvent but typed as GatewayFrame for the relay.
 */
export const muxFrameToGatewayFrame = (frame: MuxFrame): GatewayFrame | null => {
  const event = muxFrameToEvent(frame)
  if (event === null) return null
  return event as GatewayFrame
}

// ---- manager input → apiproxy params ----

/**
 * Build params for `session.create`.
 * apiproxy auto-installs model selection (P4 confirmed), so provider/model
 * are NOT passed. cwd is the workspace path.
 */
export const createSessionParams = (opts: { cwd: string; preset?: string | null }): Record<string, unknown> => ({
  cwd: opts.cwd,
  ...(opts.preset != null ? { agentPreset: opts.preset } : {}),
})

/**
 * Build params for `session.prompt`.
 * mode:'queue' means "add to inbox, let the agent decide when to process".
 * This also serves as attach/resume for cold sessions (P3 confirmed).
 */
export const promptParams = (sessionId: string, text: string): Record<string, unknown> => ({
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text }],
})

/** Build params for `session.cancel`. */
export const cancelParams = (sessionId: string): Record<string, unknown> => ({
  sessionId,
})

/** Build params for `session.history`. */
export const historyParams = (sessionId: string): Record<string, unknown> => ({
  sessionId,
})

/** Build params for `session.list`. */
export const listSessionsParams = (): Record<string, unknown> => ({})

// ---- projection extraction ----

/**
 * Extracts token usage from a `session/projection` mux frame.
 * Returns null if the frame is not a projection or has no tokenUsage.
 */
export const extractProjectionUsage = (frame: MuxFrame): { sessionId: string; usage: TokenUsage } | null => {
  if (frame.type !== 'session/projection' || frame.sessionId === undefined) return null
  if (frame.key !== 'tokenUsage') return null
  const usage = normalizeUsageLocal(frame.value)
  if (usage === null) return null
  return { sessionId: frame.sessionId, usage }
}

/**
 * Extracts title from a `session/projection` mux frame.
 */
export const extractProjectionTitle = (frame: MuxFrame): { sessionId: string; title: string } | null => {
  if (frame.type !== 'session/projection' || frame.sessionId === undefined) return null
  if (frame.key !== 'title' || typeof frame.value !== 'string' || frame.value === '') return null
  return { sessionId: frame.sessionId, title: frame.value }
}

// ---- mux 问答/授权帧 → GatewayFrame（供 runner 与浏览器消费） ----

/**
 * `question/requested` payload → question_asked GatewayFrame.
 * The envelope's rpcId is the id echoed back to `respond`, so it doubles as
 * the manager's questionId.
 */
export const questionRequestedFrame = (rpcId: string, payload: MuxFrame): GatewayFrame => ({
  kind: 'question_asked',
  seq: 0,
  questionId: rpcId,
  questions: Array.isArray(payload.questions) ? payload.questions : [],
})

/** `question/resolved` payload → question_resolved GatewayFrame. */
export const questionResolvedFrame = (payload: MuxFrame): GatewayFrame => ({
  kind: 'question_resolved',
  seq: 0,
  questionId: typeof payload.questionRpcId === 'string' ? payload.questionRpcId : null,
  outcome: typeof payload.outcome === 'string' ? payload.outcome : 'unknown',
})

/**
 * `approval/requested` payload → approval_pending GatewayFrame.
 * The envelope's rpcId is the id echoed back to `respond`; approvalId is
 * carried alongside so the respond payload can name the exact request.
 */
export const approvalRequestedFrame = (rpcId: string, payload: MuxFrame): GatewayFrame => ({
  kind: 'approval_pending',
  seq: 0,
  decisionId: rpcId,
  approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : null,
  toolName: typeof payload.toolName === 'string' ? payload.toolName : '',
  reason: typeof payload.reason === 'string' ? payload.reason : null,
})

/**
 * `approval/resolved` payload → approval_resolved GatewayFrame.
 * The resolved frame names the approvalId, not the original rpcId, so the
 * caller supplies decisionId from its approvalId→rpcId map.
 */
export const approvalResolvedFrame = (payload: MuxFrame, decisionId: string | null): GatewayFrame => ({
  kind: 'approval_resolved',
  seq: 0,
  decisionId,
  approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : null,
  outcome: typeof payload.outcome === 'string' ? payload.outcome : 'unknown',
})

// ---- history / session.list 解包 ----

/**
 * `session.history` 的 value 是 `{ events:[{ event, view? }], hasMore, projections? }`。
 * 拆出每项的 `event`（裸 session 事件），供 mapEvents 消费。
 */
export const unwrapHistoryEvents = (value: unknown): unknown[] => {
  if (value === null || typeof value !== 'object') return []
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.events)) return []
  const out: unknown[] = []
  for (const entry of v.events) {
    if (entry !== null && typeof entry === 'object') {
      out.push((entry as Record<string, unknown>).event)
    }
  }
  return out
}

/**
 * `session.list` 的 value 是 `{ items:[{ sessionId, updatedAt, running, blank, projections? }] }`。
 * title 位于 `projections.values.title`（投影块形如 `{ asOfSeq, values }`）。
 */
export interface SessionSummary {
  sessionId: string
  title?: string
  updatedAt: number | null
  running: boolean
  blank: boolean
}

export const mapSessionList = (value: unknown): SessionSummary[] => {
  if (value === null || typeof value !== 'object') return []
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.items)) return []
  const out: SessionSummary[] = []
  for (const item of v.items) {
    if (item === null || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const sessionId = typeof s.sessionId === 'string' ? s.sessionId : ''
    const projections = s.projections as Record<string, unknown> | undefined
    const values = projections?.values as Record<string, unknown> | undefined
    const title = typeof values?.title === 'string' ? values.title : undefined
    out.push({
      sessionId,
      ...(title === undefined ? {} : { title }),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
      running: s.running === true,
      blank: s.blank === true,
    })
  }
  return out
}
