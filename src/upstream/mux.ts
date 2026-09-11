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
  closed: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** approvalId → the rpcId of the original approval/requested frame. */
  approvalRpcIds: Map<string, string>
  /** 债务 A4:曾连上过(重连成功后要向订阅者广播 stream_reconnected)。 */
  wasConnected: boolean
  /** 债务 A4:连续断线计数,驱动指数退避;连上即清零。 */
  reconnectAttempt: number
}

const connections = new Map<string, MuxConnection>()

/** 债务 B6:重连累计计数(metrics 展示;每次断线重连 +1)。 */
let reconnectCount = 0
export const getMuxReconnects = (): number => reconnectCount

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 30_000

/**
 * 债务 A4:指数退避 + ±25% 抖动(纯函数,可测)。
 * 固定 3s 无退避会在上游抖动时形成重连风暴。
 */
export const nextReconnectDelay = (attempt: number): number => {
  const exp = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(attempt - 1, 0), RECONNECT_MAX_MS)
  const jitter = exp * 0.25 * (Math.random() * 2 - 1)
  return Math.round(exp + jitter)
}

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

/** Wires one socket's handlers; the socket connects immediately on construction. */
const attach = (conn: MuxConnection): void => {
  const ws = socketFactory(conn)
  conn.ws = ws

  ws.onopen = () => {
    // 债务 A4:重连成功即向所有活跃订阅者广播 stream_reconnected——
    // 断线期间丢掉的 turn_end 不会无声无息,上层按通知显性失败/对账。
    // 首连(wasConnected=false)不发。
    conn.reconnectAttempt = 0
    if (!conn.wasConnected) return
    for (const sessionId of conn.listeners.keys()) {
      emit(conn, sessionId, { kind: 'stream_reconnected', seq: 0 })
    }
  }

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
    if (conn.listeners.size > 0) {
      conn.wasConnected = true
      reconnectCount += 1
      if (conn.reconnectTimer === null) {
        const delay = nextReconnectDelay(conn.reconnectAttempt)
        conn.reconnectAttempt += 1
        conn.reconnectTimer = setTimeout(() => {
          conn.reconnectTimer = null
          if (conn.closed) return
          attach(conn)
        }, delay)
      }
    } else {
      connections.delete(conn.ep.base)
    }
  }
}

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

/** 连接工厂(测试注入假 socket 用);生产走真实 WebSocket。 */
type SocketFactory = (conn: MuxConnection) => WebSocket
let socketFactory: SocketFactory = openSocket

/** Testing only:替换连接工厂,验证重连通知/退订修复等连接级行为。 */
export const _setSocketFactory = (factory: SocketFactory): void => {
  socketFactory = factory
}

const connect = (ep: UpstreamEndpoint): MuxConnection => {
  const key = ep.base
  const existing = connections.get(key)
  if (existing !== undefined && !existing.closed) return existing

  const conn: MuxConnection = {
    ep,
    ws: null,
    listeners: new Map(),
    closed: false,
    reconnectTimer: null,
    approvalRpcIds: new Map(),
    wasConnected: false,
    reconnectAttempt: 0,
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
    // 债务 A4:只有当 map 里挂着的还是本订阅创建的 set 时才删除——旧 unsub
    // 在「退订后又重新订阅」之后调用,会把新订阅的 set 从 map 误删。
    if (set.size === 0 && conn.listeners.get(sessionId) === set) conn.listeners.delete(sessionId)
    maybeClose(conn, ep.base)
  }
}

/**
 * 债务 E13:subscribeAll(全局订阅)已删除——全仓无生产调用者,是进入公共
 * barrel 的死接口,读者会误以为「全局订阅」是被使用的特性。需要时再加回
 * 并补测试。
 */

const maybeClose = (conn: MuxConnection, key: string): void => {
  if (conn.listeners.size === 0) {
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
