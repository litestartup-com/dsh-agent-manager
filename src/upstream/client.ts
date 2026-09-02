/**
 * High-level client for the apiproxy driver.
 *
 * Wraps rpc, mux, translate, and respond into an interface that the runner and
 * chat routes can consume without knowing the wire format. Deliberately does NOT
 * extend or implement the GatewayClient class — the two are separate branches,
 * and a common interface is deferred to S4.
 */

import type { ResolvedEndpoint } from '../config.js'
import type { HistoryEvent } from '../gateway/client.js'
import { rpc, type UpstreamEndpoint } from './rpc.js'
import { respond, type RpcReceipt } from './respond.js'
import { subscribe, closeAllMux, type MuxListener } from './mux.js'
import {
  mapEvents, createSessionParams, promptParams,
  cancelParams, historyParams,
  unwrapHistoryEvents, mapSessionList,
} from './translate.js'
import { compactHistory } from '../chat/replay.js'

export interface UpstreamSessionHistory {
  sessionId: string
  sessionState: 'live' | 'cold'
  title: string | null
  events: HistoryEvent[]
}

export interface UpstreamCreatedSession {
  sessionId: string
  provider: string | null
  model: string | null
}

export class UpstreamClient {
  readonly id: string
  private readonly ep: UpstreamEndpoint

  constructor(endpoint: ResolvedEndpoint) {
    this.id = endpoint.id
    this.ep = {
      base: `${endpoint.url}${endpoint.prefix}`,
      key: endpoint.key,
    }
  }

  get endpoint(): UpstreamEndpoint { return this.ep }

  // ---- session lifecycle ----

  async createSession(cwd: string, preset?: string | null): Promise<UpstreamCreatedSession> {
    const result = await rpc<{ sessionId: string; [k: string]: unknown }>(
      this.ep, 'session.create', createSessionParams({ cwd, preset }), { timeoutMs: 30_000 },
    )
    const v = result.result.value
    return {
      sessionId: v.sessionId,
      provider: typeof v.provider === 'string' ? v.provider : null,
      model: typeof v.model === 'string' ? v.model : null,
    }
  }

  /**
   * Send a prompt (also serves as attach/resume for cold sessions).
   * Returns the RPC receipt; frames arrive on the mux subscription.
   */
  async prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
    const result = await rpc<{ accepted?: boolean }>(
      this.ep, 'session.prompt', promptParams(sessionId, text),
    )
    return { accepted: result.result.value.accepted !== false }
  }

  async cancel(sessionId: string): Promise<void> {
    await rpc(this.ep, 'session.cancel', cancelParams(sessionId))
  }

  async history(sessionId: string): Promise<UpstreamSessionHistory> {
    // Real value shape: { events:[{ event, view? }], hasMore, projections? }
    // where projections = { asOfSeq, values: {...} }.
    const result = await rpc<{
      events?: unknown
      projections?: { values?: Record<string, unknown> }
      [k: string]: unknown
    }>(this.ep, 'session.history', historyParams(sessionId))
    const v = result.result.value
    const events = compactHistory(mapEvents(unwrapHistoryEvents(v)))
    const title = typeof v.projections?.values?.title === 'string' ? v.projections.values.title : null
    // apiproxy doesn't have the adopted/live distinction; any session that
    // answers history is readable. Whether it's "live" depends on whether
    // the agent is currently attached, but for our purposes cold sessions
    // are auto-resumed by prompt, so we always report 'cold'.
    return { sessionId, sessionState: 'cold', title, events }
  }

  async listSessions(): Promise<Array<{ sessionId: string; title?: string }>> {
    const result = await rpc<unknown>(this.ep, 'session.list')
    return mapSessionList(result.result.value).map((s) => ({
      sessionId: s.sessionId,
      ...(s.title === undefined ? {} : { title: s.title }),
    }))
  }

  /**
   * Reads the DSH version through `host.describe` — the apiproxy contract has
   * no `host.version` method.
   */
  async hostVersion(): Promise<string> {
    const result = await rpc<{ version?: string }>(this.ep, 'host.describe', {}, { timeoutMs: 5_000 })
    return typeof result.result.value.version === 'string' ? result.result.value.version : 'unknown'
  }

  // ---- mux ----

  /**
   * Subscribe to live events for a specific session.
   * Returns unsubscribe function.
   */
  subscribe(sessionId: string, listener: MuxListener): () => void {
    return subscribe(this.ep, sessionId, listener)
  }

  // ---- respond (S2) ----

  /**
   * Answer an interactive question via apiproxy's `respond` endpoint.
   *
   * `answer` must be `{ answers: [{ id, selected: string[], custom?: string }] }`
   * — the host validates it against the original question batch (order, ids,
   * option labels, multi-select rules).
   */
  async answerQuestion(rpcId: string, sessionId: string, answer: unknown): Promise<RpcReceipt> {
    return respond(this.ep, rpcId, { ok: true, value: { sessionId, answer } })
  }

  /**
   * Decline an interactive question. The wire form of a decline is a not-ok
   * client-response whose error code is 'cancelled' — the host resolves the
   * pending entry with outcome 'cancelled' and accepts the receipt.
   */
  async declineQuestion(rpcId: string, sessionId: string): Promise<RpcReceipt> {
    return respond(this.ep, rpcId, {
      ok: false,
      error: { code: 'cancelled', message: 'the user cancelled ask_user_question', details: { sessionId } },
    })
  }

  /**
   * Decide an approval request via apiproxy's `respond` endpoint.
   * The host matches the pending approval by rpcId AND validates that
   * sessionId + approvalId name the exact pending request.
   */
  async decideApproval(
    rpcId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<RpcReceipt> {
    return respond(this.ep, rpcId, { ok: true, value: { sessionId, approvalId, outcome } })
  }
}

/**
 * Builds UpstreamClient instances for all apiproxy-mode endpoints.
 */
export const buildUpstreamClients = (endpoints: Record<string, ResolvedEndpoint>): Map<string, UpstreamClient> => {
  const map = new Map<string, UpstreamClient>()
  for (const endpoint of Object.values(endpoints)) {
    if (endpoint.driver === 'apiproxy') {
      map.set(endpoint.id, new UpstreamClient(endpoint))
    }
  }
  return map
}

export { closeAllMux }
