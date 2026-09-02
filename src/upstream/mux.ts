/**
 * WebSocket mux consumer for the DSH apiproxy event stream.
 *
 * The mux endpoint (`ws://<host>/api/events.mux`) is a full-volume broadcast:
 * every active session's events are multiplexed onto one WebSocket. This module
 * maintains one connection per endpoint and distributes frames to per-session
 * listeners.
 *
 * Wire reality (dsh-client-connection, DSH 0.1.1-rc.2):
 * - The socket is DOWNLINK ONLY: the host closes the socket (1008) on any
 *   client message. The manager never sends frames.
 * - Every message is the ServerRequest full form, JSON-encoded:
 *     { type:'server-request', rpcId, method, payload }
 *   where `method` is the frame type ('session/event', 'question/requested',
 *   ...) and `payload` is the frame body.
 * - Answerable frames (question/approval requested) carry a stable rpcId that
 *   respond() must echo; approval/resolved frames name the approvalId instead,
 *   so this module keeps an approvalId→rpcId map.
 * - The stream also emits `session/subscribed` baselines on open,
 *   `session/projection` per-key snapshots, and one `stream/error` frame
 *   before closing on host failure.
 *
 * Reconnect is the consumer's job (the host does not retry for us).
 */

import type { UpstreamEndpoint } from './rpc.js'
import type { MuxFrame } from './translate.js'
import type { GatewayFrame } from '../gateway/stream.js'
import {
  muxFrameToGatewayFrame,
  questionRequestedFrame, questionResolvedFrame,
  approvalRequestedFrame, approvalResolvedFrame,
} from './translate.js'

export type MuxListener = (sessionId: string, frame: GatewayFrame) => void

/** One parsed WebSocket message: the ServerRequest full form. */
export interface WireEnvelope {
  type: 'server-request'
  rpcId: string
  method: string
  payload: MuxFrame
}

interface MuxConnection {
  ep: UpstreamEndpoint
  ws: WebSocket | null
  listeners: Map<string, Set<MuxListener>>
  /** Listeners that receive frames from ALL sessions (for monitoring). */
  globalListeners: Set<MuxListener>
  closed: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** approvalId → the rpcId of the original approval/requested frame. */
  approvalRpcIds: Map<string, string>
}

const connections = new Map<string, MuxConnection>()

const RECONNECT_MS = 3_000

/**
 * Derives the WebSocket URL from an HTTP endpoint base.
 * `http://host:port/api` → `ws://host:port/api/events.mux`
 * `https://…` → `wss://…`
 */
export const muxUrl = (base: string): string => {
  const wsBase = base.replace(/^http/, 'ws')
  return `${wsBase}/events.mux`
}

/**
 * Parses one WebSocket message into a server-request envelope.
 * Returns `null` for anything that is not a well-formed server-request.
 * Exported for testing.
 */
export const parseMuxFrame = (data: string): WireEnvelope | null => {
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const e = parsed as Record<string, unknown>
    if (e.type !== 'server-request' || typeof e.method !== 'string') return null
    const payload = e.payload
    if (payload === null || typeof payload !== 'object') return null
    return {
      type: 'server-request',
      rpcId: typeof e.rpcId === 'string' ? e.rpcId : '',
      method: e.method,
      payload: payload as MuxFrame,
    }
  } catch {
    return null
  }
}

const emit = (conn: MuxConnection, sessionId: string, gw: GatewayFrame): void => {
  const listeners = conn.listeners.get(sessionId)
  if (listeners !== undefined) {
    for (const listener of listeners) listener(sessionId, gw)
  }
  for (const listener of conn.globalListeners) listener(sessionId, gw)
}

const dispatch = (conn: MuxConnection, env: WireEnvelope): void => {
  const payload = env.payload
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
  if (sessionId === undefined) return

  switch (env.method) {
    case 'session/event': {
      const gw = muxFrameToGatewayFrame(payload)
      if (gw === null) return
      emit(conn, sessionId, gw)
      return
    }
    case 'question/requested': {
      emit(conn, sessionId, questionRequestedFrame(env.rpcId, payload))
      return
    }
    case 'question/resolved': {
      emit(conn, sessionId, questionResolvedFrame(payload))
      return
    }
    case 'approval/requested': {
      if (typeof payload.approvalId === 'string') {
        conn.approvalRpcIds.set(payload.approvalId, env.rpcId)
      }
      emit(conn, sessionId, approvalRequestedFrame(env.rpcId, payload))
      return
    }
    case 'approval/resolved': {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : null
      const decisionId = approvalId === null ? null : conn.approvalRpcIds.get(approvalId) ?? null
      if (approvalId !== null && decisionId !== null) conn.approvalRpcIds.delete(approvalId)
      emit(conn, sessionId, approvalResolvedFrame(payload, decisionId))
      return
    }
    default:
      // session/subscribed、session/queue、session/jobs、session/projection 等：
      // 不转成 GatewayFrame（投影另有 extract 函数；其余对本驱动无意义）。
      return
  }
}

/**
 * Opens the WebSocket. When a key is configured, custom headers are passed in
 * the options bag (supported by Node's undici WebSocket); older runtimes that
 * reject the options form fall back to a plain connection.
 */
const openSocket = (conn: MuxConnection): WebSocket => {
  const url = muxUrl(conn.ep.base)
  let ws: WebSocket
  if (conn.ep.key !== '') {
    try {
      ws = new WebSocket(url, { headers: { 'x-api-key': conn.ep.key } } as never)
    } catch {
      ws = new WebSocket(url)
    }
  } else {
    ws = new WebSocket(url)
  }
  return ws
}

/** Wires one socket's handlers; the socket connects immediately on construction. */
const attach = (conn: MuxConnection): void => {
  const ws = openSocket(conn)
  conn.ws = ws

  ws.onmessage = (event: MessageEvent) => {
    const data = typeof event.data === 'string' ? event.data : String(event.data)
    const env = parseMuxFrame(data)
    if (env === null) return
    if (env.method === 'stream/error') {
      // Host-side failure: the host closes right after this frame. Treat it as
      // a closed connection so the reconnect path runs.
      try { ws.close() } catch { /* already closing */ }
      return
    }
    dispatch(conn, env)
  }

  ws.onerror = () => {
    // onerror always fires before onclose, and onclose handles reconnection.
  }

  ws.onclose = () => {
    if (conn.closed) return
    // Auto-reconnect if there are still listeners.
    if (conn.listeners.size > 0 || conn.globalListeners.size > 0) {
      if (conn.reconnectTimer === null) {
        conn.reconnectTimer = setTimeout(() => {
          conn.reconnectTimer = null
          if (conn.closed) return
          attach(conn)
        }, RECONNECT_MS)
      }
    } else {
      connections.delete(conn.ep.base)
    }
  }
}

const connect = (ep: UpstreamEndpoint): MuxConnection => {
  const key = ep.base
  const existing = connections.get(key)
  if (existing !== undefined && !existing.closed) return existing

  const conn: MuxConnection = {
    ep,
    ws: null,
    listeners: new Map(),
    globalListeners: new Set(),
    closed: false,
    reconnectTimer: null,
    approvalRpcIds: new Map(),
  }
  connections.set(key, conn)
  attach(conn)
  return conn
}

/**
 * Subscribe to events for a specific session on a given endpoint.
 * Returns a function that removes the subscription.
 *
 * The first subscription for an endpoint opens the mux WebSocket.
 * The last unsubscription closes it.
 */
export const subscribe = (ep: UpstreamEndpoint, sessionId: string, listener: MuxListener): (() => void) => {
  const conn = connect(ep)
  const set = conn.listeners.get(sessionId) ?? new Set()
  set.add(listener)
  conn.listeners.set(sessionId, set)

  return () => {
    set.delete(listener)
    if (set.size === 0) conn.listeners.delete(sessionId)
    maybeClose(conn, ep.base)
  }
}

/**
 * Subscribe to events from ALL sessions on a given endpoint.
 * Returns a function that removes the subscription.
 */
export const subscribeAll = (ep: UpstreamEndpoint, listener: MuxListener): (() => void) => {
  const conn = connect(ep)
  conn.globalListeners.add(listener)

  return () => {
    conn.globalListeners.delete(listener)
    maybeClose(conn, ep.base)
  }
}

const maybeClose = (conn: MuxConnection, key: string): void => {
  if (conn.listeners.size === 0 && conn.globalListeners.size === 0) {
    conn.closed = true
    if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer)
    try { conn.ws?.close() } catch { /* already closed */ }
    connections.delete(key)
  }
}

/**
 * Close all mux connections. For tests and shutdown.
 */
export const closeAllMux = (): void => {
  for (const conn of connections.values()) {
    conn.closed = true
    if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer)
    try { conn.ws?.close() } catch { /* already closed */ }
  }
  connections.clear()
}

/**
 * Returns a promise that resolves when a specific frame kind arrives for a session,
 * or rejects on timeout. Useful for waiting on `turn_end`.
 */
export const waitForFrame = (
  ep: UpstreamEndpoint,
  sessionId: string,
  kind: string,
  timeoutMs: number,
): Promise<GatewayFrame> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`timeout waiting for ${kind} on session ${sessionId}`))
    }, timeoutMs)

    const unsub = subscribe(ep, sessionId, (_sid, frame) => {
      if (frame.kind === kind) {
        clearTimeout(timer)
        unsub()
        resolve(frame)
      }
    })
  })
