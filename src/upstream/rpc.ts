/**
 * Unary RPC caller for the DSH apiproxy contract.
 *
 * Wire format verified against the host implementation
 * (dsh-host-apiproxy/lib/types/fetch/handler.js, DSH 0.1.1-rc.2):
 *
 *   POST <base>/<method>
 *   body:  { type:'client-request', rpcId, method, payload }
 *   reply: HTTP 200 with
 *     { type:'server-response', rpcId, result: { ok:true, value } }
 *   or { type:'server-response', rpcId, result: { ok:false, error:{ code, message, details } } }
 *
 * The envelope's `method` must match the path segment (a mismatch is a
 * bad-request). HTTP status expresses only the carrier: 404 unknown path,
 * 415 non-JSON media type, 400 non-JSON body, 500 handler crash. Success or
 * failure is determined by `result.ok`, never by the HTTP status code.
 *
 * A fail-closed whitelist gates every call: methods not on the list are
 * rejected locally before any network request is made.
 */

export interface UpstreamEndpoint {
  /** e.g. 'http://127.0.0.1:3080/api' */
  base: string
  /** Non-empty when the endpoint requires auth (Scheme B / cross-machine). */
  key: string
}

// ---- whitelist ----

/**
 * Methods the manager is allowed to call through apiproxy.
 * Everything else is rejected locally — fail-closed, no exceptions.
 */
const WHITELIST = new Set([
  // session lifecycle
  'session.list',
  'session.create',
  'session.history',
  'session.prompt',
  'session.cancel',
  'session.rename',
  'session.fork',
  'session.updateQueue',
  'session.attachment',
  // model
  'session.models',
  'session.selectModel',
  // host
  'host.describe',
])

/** Exported for testing: the whitelist is the security boundary. */
export const isMethodAllowed = (method: string): boolean => WHITELIST.has(method)

// ---- RPC types ----

export interface RpcOk<T = unknown> {
  id: string
  result: { ok: true; value: T }
}

export interface RpcError {
  code: string
  message: string
}

export class UpstreamError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
  }
}

// ---- RPC call ----

let rpcSeq = 0

/**
 * One apiproxy RPC call.
 *
 * The caller must check `result.ok` — HTTP is always 200. An `ok: false`
 * response throws `UpstreamError` with the upstream's `code` and `message`.
 *
 * @throws {UpstreamError} when result.ok is false
 * @throws {Error} on network / timeout / whitelist violations
 */
export async function rpc<T = unknown>(
  ep: UpstreamEndpoint,
  method: string,
  params: Record<string, unknown> = {},
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<RpcOk<T>> {
  if (!isMethodAllowed(method)) {
    throw new Error(`upstream: method "${method}" is not on the whitelist — rejected locally`)
  }

  const id = `upstream-${Date.now()}-${++rpcSeq}`
  const url = `${ep.base}/${method}`
  const body = JSON.stringify({ type: 'client-request', rpcId: id, method, payload: params })

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ep.key !== '') headers['x-api-key'] = ep.key

  const signal = opts?.timeoutMs !== undefined
    ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts?.signal ? [opts.signal] : [])])
    : opts?.signal

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal,
  })

  // apiproxy always returns 200 for business outcomes; a non-200 means we hit
  // the carrier layer (unknown path 404, non-JSON 415/400, trust fence, or a
  // handler crash 500).
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`upstream ${method}: HTTP ${response.status} — ${detail.slice(0, 300)}`)
  }

  const json = await response.json() as {
    type?: string
    rpcId?: string
    result?: { ok: boolean; value?: unknown; error?: { code?: string; message?: string; details?: unknown } }
  }

  if (json.type !== 'server-response' || json.result === undefined || json.result === null) {
    throw new Error(`upstream ${method}: response missing "result" field`)
  }

  if (!json.result.ok) {
    const code = typeof json.result.error?.code === 'string' ? json.result.error.code : 'unknown'
    const message = typeof json.result.error?.message === 'string' ? json.result.error.message : 'upstream error'
    throw new UpstreamError(code, `upstream ${method}: ${message}`)
  }

  return { id: json.rpcId ?? id, result: { ok: true, value: json.result.value as T } }
}
