/**
 * High-level client for the apiproxy driver — SessionDriver 插头一（facade）。
 *
 * Wraps rpc, mux, translate, and respond into the SessionDriver port (修路阶段
 * 第一项)：上层只见端口，不见 wire。Deliberately does NOT extend or implement
 * the GatewayClient class — the legacy gateway driver is a separate branch and
 * is not a SessionDriver plug (its slot/release model is pre-port).
 */

import type { ResolvedEndpoint } from '../config.js'
import type { HistoryEvent } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { rpc, type UpstreamEndpoint, UpstreamError } from './rpc.js'
import { respond, type RpcReceipt } from './respond.js'
import { subscribe, closeAllMux, type MuxListener } from './mux.js'
import {
  mapEvents, createSessionParams, promptParams,
  cancelParams, historyParams,
  unwrapHistoryEvents, mapSessionList,
} from './translate.js'
import { compactHistory } from '../chat/replay.js'

export interface UpstreamModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface UpstreamModelCatalog {
  current: UpstreamModelSelection | null
  routable: boolean
  groups: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
    }>
  }>
  failures: Array<{ id: string; name: string; message: string }>
}

export interface UpstreamComposerState {
  model: UpstreamModelSelection | null
  context: { usedTokens: number; contextWindow: number; percent: number; breakdown: { systemTokens: number; toolsTokens: number; messageTokens: number } | null } | null
  accessMode: 'read-only' | 'workspace-write' | null
}

export interface UpstreamSessionHistory {
  sessionId: string
  sessionState: 'live' | 'cold'
  title: string | null
  events: HistoryEvent[]
  composer: UpstreamComposerState
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null

const selectionOf = (value: unknown): UpstreamModelSelection | null => {
  const source = recordOf(value)
  if (source === null || typeof source.provider !== 'string' || typeof source.model !== 'string') return null
  return {
    provider: source.provider,
    model: source.model,
    ...(typeof source.reasoningEffort === 'string' ? { reasoningEffort: source.reasoningEffort } : {}),
  }
}

const composerStateOf = (values: Record<string, unknown> | undefined): UpstreamComposerState => {
  const pressure = recordOf(values?.contextPressure)
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  const breakdown = recordOf(values?.contextBreakdown)
  const context = typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens >= 0
    && typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
    ? {
        usedTokens,
        contextWindow,
        percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)),
        breakdown: typeof breakdown?.systemTokens === 'number' && typeof breakdown.toolsTokens === 'number' && typeof breakdown.messageTokens === 'number'
          ? { systemTokens: breakdown.systemTokens, toolsTokens: breakdown.toolsTokens, messageTokens: breakdown.messageTokens }
          : null,
      }
    : null
  const permissions = recordOf(values?.permissions)
  const currentValue = permissions?.currentValue
  return {
    model: selectionOf(recordOf(values?.modelSelection)?.next) ?? selectionOf(recordOf(values?.modelSelection)?.lastUsed),
    context,
    accessMode: currentValue === 'read-only' || currentValue === 'workspace-write' ? currentValue : null,
  }
}

const modelCatalogOf = (value: unknown): UpstreamModelCatalog => {
  const source = recordOf(value)
  const groups = Array.isArray(source?.groups) ? source.groups.flatMap((group) => {
    const value = recordOf(group)
    if (value === null || typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.models)) return []
    const models = value.models.flatMap((model) => {
      const row = recordOf(model)
      if (row === null || typeof row.id !== 'string' || typeof row.name !== 'string') return []
      const reasoning = recordOf(row.reasoning)
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts.flatMap((effort) => {
            const item = recordOf(effort)
            return item === null || typeof item.id !== 'string' || typeof item.name !== 'string' ? [] : [{ id: item.id, name: item.name }]
          })
        : []
      return [{ id: row.id, name: row.name, ...(reasoning === null ? {} : { reasoning: { efforts, ...(typeof reasoning.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}) } }) }]
    })
    return [{ id: value.id, name: value.name, models }]
  }) : []
  const failures = Array.isArray(source?.failures) ? source.failures.flatMap((failure) => {
    const row = recordOf(failure)
    return row === null || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.message !== 'string' ? [] : [{ id: row.id, name: row.name, message: row.message }]
  }) : []
  return { current: selectionOf(source?.current), routable: source?.routable === true, groups, failures }
}

export interface UpstreamCreatedSession {
  sessionId: string
  /** The host's echo of the requested agentPreset, or null. */
  preset: string | null
  provider: string | null
  model: string | null
}

export class UpstreamClient implements SessionDriver {
  readonly id: string
  private readonly ep: UpstreamEndpoint
  private readonly sandboxBase: string | null
  private readonly sandboxKey: string

  constructor(endpoint: ResolvedEndpoint) {
    this.id = endpoint.id
    this.ep = {
      base: `${endpoint.url}${endpoint.prefix}`,
      key: endpoint.key,
    }
    this.sandboxBase = endpoint.sandboxBase
    this.sandboxKey = endpoint.sandboxKey
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
      preset: typeof v.agentPreset === 'string' ? v.agentPreset : null,
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

  /**
   * Pins a live session's sandbox mode through the gateway's sandbox-mode
   * route (蜂群 P0). The override is durable — a `sandbox/mode` log event that
   * replays on cold wake — so one call at creation time is enough.
   *
   * Config validation guarantees sandboxBase is set whenever an agent declares
   * a mode; this still guards the unconfigured case instead of sending to a
   * junk URL.
   */
  canSetSandboxMode(): boolean {
    return this.sandboxBase !== null
  }

  async setSandboxMode(sessionId: string, mode: 'read-only' | 'workspace-write'): Promise<void> {
    if (this.sandboxBase === null) {
      throw new UpstreamError('sandbox_unconfigured', `endpoint ${this.id}: no sandbox_base configured`)
    }
    const call = async (): Promise<Response> =>
      fetch(`${this.sandboxBase}/sessions/${encodeURIComponent(sessionId)}/sandbox-mode`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.sandboxKey,
        },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(10_000),
      })
    let response = await call()
    // 蜂群2计划 P6（DSH-FACTS §7）：网关 settings 命名空间异步加载的竞态——
    // 节点刚启动时第一次沙箱调用可能 401「provisions a key (first call only)」，
    // 数秒后 settings 就位即恢复。只对这一种 hint 重试一次，把竞态变确定性；
    // 其它 401（真钥匙错）照旧抛出。
    if (response.status === 401) {
      const firstText = await response.text()
      if (firstText.includes('provisions a key')) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
        response = await call()
      } else {
        throw new UpstreamError('sandbox_mode_failed', `endpoint ${this.id}: sandbox-mode 401: ${firstText.slice(0, 300)}`)
      }
    }
    if (!response.ok) {
      const text = await response.text()
      throw new UpstreamError(
        'sandbox_mode_failed',
        `endpoint ${this.id}: sandbox-mode ${response.status}: ${text.slice(0, 300)}`,
      )
    }
  }

  async modelCatalog(): Promise<UpstreamModelCatalog> {
    const result = await rpc<unknown>(this.ep, 'session.models', {}, { timeoutMs: 10_000 })
    return modelCatalogOf(result.result.value)
  }

  async selectModel(sessionId: string, selection: UpstreamModelSelection): Promise<UpstreamModelSelection> {
    const result = await rpc<unknown>(this.ep, 'session.selectModel', { sessionId, ...selection }, { timeoutMs: 10_000 })
    const selected = selectionOf((result.result.value as { selected?: unknown } | null)?.selected)
    if (selected === null) throw new UpstreamError('model_selection_invalid', `endpoint ${this.id}: selectModel returned no selection`)
    return selected
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
    const composer = composerStateOf(v.projections?.values)
    // apiproxy doesn't have the adopted/live distinction; any session that
    // answers history is readable. Whether it's "live" depends on whether
    // the agent is currently attached, but for our purposes cold sessions
    // are auto-resumed by prompt, so we always report 'cold'.
    return { sessionId, sessionState: 'cold', title, events, composer }
  }

  async listSessions(): Promise<Array<{ sessionId: string; title?: string }>> {
    const result = await rpc<unknown>(this.ep, 'session.list')
    return mapSessionList(result.result.value).map((s) => ({
      sessionId: s.sessionId,
      ...(s.title === undefined ? {} : { title: s.title }),
    }))
  }

  /**
   * 探活（端口词汇）：读 DSH 版本串——apiproxy 契约里经 `host.describe`
   * （无 `host.version` 方法）。失败抛出，上层 catch 判不可达。
   */
  async probeVersion(): Promise<string> {
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

  /**
   * 释放（端口词汇）：插头一无槽位可还——会话由宿主持有，manager 不做
   * 槽位管理（旧 gateway 驱动的 maxSessions 模型与端口无关）。no-op。
   */
  async release(_sessionId: string): Promise<void> {
    // 无资源持有：宿主的会话存活与 manager 无关。
  }
}

/**
 * Builds SessionDriver plugs for all apiproxy-mode endpoints.
 * 插头一 = UpstreamClient（facade 契约）。
 */
export const buildUpstreamClients = (endpoints: Record<string, ResolvedEndpoint>): Map<string, SessionDriver> => {
  const map = new Map<string, SessionDriver>()
  for (const endpoint of Object.values(endpoints)) {
    if (endpoint.driver === 'apiproxy') {
      map.set(endpoint.id, new UpstreamClient(endpoint))
    }
  }
  return map
}

export { closeAllMux }
