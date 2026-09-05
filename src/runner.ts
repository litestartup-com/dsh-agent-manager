import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import type { ResolvedAgent } from './config.js'
import { GatewayError, isAdoptDisabled, type GatewayClient } from './gateway/client.js'
import { normalizeUsage, streamFrames, sumUsage, type GatewayFrame, type TokenUsage } from './gateway/stream.js'
import { computeCost, DEFAULT_PRICING, type PricingTable } from './pricing.js'
import { currentHead, snapshotAfter, snapshotBefore } from './workspace/snapshot.js'
import type { UpstreamClient } from './upstream/client.js'
import { UpstreamError } from './upstream/rpc.js'

/**
 * Drives one agent turn end to end: acquire a session bounded to the workspace,
 * subscribe, send the instruction, follow the stream to `turn_end`, and record
 * what it cost.
 *
 * A turn either starts a new session or continues an existing one (`sessionId`).
 * Continuing is what makes a multi-turn conversation possible at all: the model
 * sees the earlier turns only because the gateway session is the same one.
 *
 * Two ordering decisions matter:
 *
 * 1. The stream is subscribed to *before* the message is sent. The gateway
 *    replays history in its `hello` frame, so a late subscriber would still see
 *    the turn -- but it could not tell replayed events from live ones.
 * 2. Usage is therefore counted only from live `message` frames, and only live
 *    frames are relayed to browsers. Counting the `hello` log would bill every
 *    previous turn again on each run, which grows with the conversation.
 *
 * Each response is priced as it arrives rather than the whole turn being priced
 * once at the end. The provider bills by time of day at two rates, and a turn
 * can run long enough to cross a boundary, so a single end-of-turn timestamp
 * would put the entire turn on the wrong side of the clock.
 *
 * The workspace is committed after every turn, including a failed one -- see
 * workspace/snapshot.ts. 蜂群 P5.4 起回合并行：git 快照/提交由每 agent 的
 * 提交锁串行执行（落盘是唯一的排队点），运行期间被并发回合提交过的工作区
 * 会在 run 行上记 conflict——冲突显性化，绝不静默覆盖。
 *
 * The gateway session is handed back when the turn is done, unless the caller
 * asked to keep it (`keepSession`, which is what a conversation does). Sessions
 * are a capped resource on the gateway -- `maxSessions` -- and a one-shot turn
 * that keeps its slot never gives it back, so cron alone would eventually
 * exhaust the cap and block every conversation too. Releasing is not deleting:
 * the gateway keeps the transcript, so a released session can still be read and
 * can be adopted back.
 */

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * How long a turn may produce NOTHING before it is cancelled.
 *
 * Distinct from the total timeout, and neither replaces the other. The total
 * timeout has to be generous, because a turn that works for twenty minutes is
 * legitimate; that generosity is exactly what a blocked turn exploits. A
 * working turn emits frames continuously (deltas, tool calls), so silence this
 * long means the turn is not slow but stopped -- typically waiting on an
 * interactive prompt that, for an API-driven session, nobody can answer.
 *
 * The gateway is supposed to make that unanswerable-prompt case impossible
 * (its questionMode: conversation). This is the backstop for when it is not:
 * an older gateway, questionMode: host, or a permission dialog, which cannot be
 * turned into conversation at all. It costs one timer and guarantees that no
 * turn hangs indefinitely regardless of what the other side does.
 */
export const DEFAULT_SILENCE_MS = 5 * 60 * 1000

/**
 * True when two paths denote the same directory.
 *
 * Compared through realpath where possible: on Windows the same directory can
 * be spelled with different case or as an 8.3 short name, and a false mismatch
 * here would block every run.
 */
export const sameDirectory = (a: string, b: string): boolean => {
  const canonical = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const left = canonical(a)
  const right = canonical(b)
  if (left === right) return true
  return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase()
}

export type RunTrigger = 'manual' | 'cron' | 'api' | 'capture' | 'brain'
export type RunState = 'pending' | 'running' | 'done' | 'failed' | 'missed'

export interface RunInput {
  agent: ResolvedAgent
  client: GatewayClient
  /** The apiproxy client, set when driver is 'apiproxy'. */
  upstream?: UpstreamClient
  /** Which driver the endpoint uses. Defaults to 'gateway'. */
  driver?: 'gateway' | 'apiproxy'
  prompt: string
  trigger: RunTrigger
  cronId?: string | null
  idempotencyKey?: string | null
  timeoutMs?: number
  /** Cancel after this long with no frames at all; 0 disables. */
  silenceMs?: number
  /**
   * Continue this gateway session instead of creating a fresh one.
   *
   * This is what makes a conversation a conversation: the model only sees the
   * earlier turns because the session is the same one.
   */
  sessionId?: string | null
  /**
   * Keep the gateway session alive after this turn instead of releasing it.
   *
   * Set by a conversation, which continues on the same session and would
   * otherwise pay for a cold resume on every turn. Left unset by one-shot work
   * (cron, a manual run, a capture): those sessions are never continued, and a
   * turn that does not hand its slot back holds one against the gateway's
   * `maxSessions` until DSH restarts. Enough of those and the gateway can
   * neither create nor adopt, which takes the conversations down too.
   *
   * Default is therefore to release: leaking has to be asked for.
   */
  keepSession?: boolean
  /** The chat this turn belongs to, recorded on the run row. */
  chatId?: string | null
  /**
   * 蜂群 P2：主脑派工时所在的会话（delegation 帧归属）。与 `chatId` 不同——
   * 后者是「run 写入哪个工作会话」，前者是「谁发起的」。
   */
  sourceChatId?: string | null
  /**
   * Receives every *live* frame, for relaying to browsers.
   *
   * Live only, and for the same reason usage is counted from live frames only:
   * the gateway's `hello` frame replays the entire durable history, so treating
   * it as live would re-emit -- and re-bill -- the whole conversation on every
   * reconnect.
   */
  onFrame?: (frame: GatewayFrame) => void
}

export interface RunOutcome {
  runId: string
  state: RunState
  sessionId: string | null
  /** Assistant text, trimmed for storage. */
  summary: string
  usage: TokenUsage | null
  costMicroUsd: number | null
  /** The part of `costMicroUsd` billed at the peak rate. */
  peakCostMicroUsd: number | null
  provider: string | null
  model: string | null
  /** turn_end reason as reported by the gateway. */
  reason: string | null
  error: string | null
  toolCalls: number
  durationMs: number
  /** The commit holding this run's changes, or null when it changed nothing. */
  commit: string | null
  /** Workspace-relative paths this run changed. */
  changedFiles: string[]
  /**
   * Why no snapshot was taken, when that happened. The turn itself still ran;
   * its changes are simply not committed.
   */
  snapshotSkipped: string | null
  /**
   * 蜂群 P5.4：并发写冲突说明。运行期间工作区被另一个回合提交过时为非空
   * ——本回合基于旧状态工作，文件可能被并发修改。NULL = 无冲突。
   */
  conflict: string | null
}

export interface RunnerDeps {
  db: Db
  clock?: () => number
  pricing?: PricingTable
  /** Injected so tests do not have to wait fifteen minutes. */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

/**
 * 蜂群 P5.4：每个 agent 的活跃 run 集合（并发）。上限是 gateway 的
 * maxSessions——DSH 自身的会话名额，manager 不再人为串行。这个 map 只
 * 服务于 UI 与路由的「正在进行」展示，不再是拒绝的理由。
 */
const activeRuns = new Map<string, Set<string>>()

/** 任一活跃 run 的 id（UI 的忙点只需要「有没有」）。 */
export const runningRunId = (agentId: string): string | null => {
  const set = activeRuns.get(agentId)
  if (set === undefined || set.size === 0) return null
  return [...set][0] ?? null
}

/** 活跃 run 数（并发度展示）。 */
export const activeRunCount = (agentId: string): number => activeRuns.get(agentId)?.size ?? 0

/**
 * 蜂群 P5.4：每 agent 一把提交锁。回合并行，但 git 快照/提交排队执行——
 * 两个回合同时 git add/commit 会在 index.lock 上互相踩踏。落盘是排队点，
 * 其余全程并行。
 */
const commitTails = new Map<string, Promise<void>>()

const withCommitLock = async <T>(agentId: string, fn: () => Promise<T>): Promise<T> => {
  const prev = commitTails.get(agentId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  commitTails.set(agentId, gate)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (commitTails.get(agentId) === gate) commitTails.delete(agentId)
  }
}

const SUMMARY_LIMIT = 4_000

const truncate = (text: string, limit = SUMMARY_LIMIT): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`

/** Frames whose kind indicates the turn produced visible assistant output. */
const isLiveMessage = (frame: GatewayFrame): boolean => frame.kind === 'message'

/**
 * Turns an adopt failure into something a person can act on.
 *
 * The gateway funnels every adopt problem through one shape -- 400
 * `adopt_failed` with the real cause only in `detail` (its index.ts:721-723) --
 * so without this the user would see "gateway responded 400" for four situations
 * that need four different responses.
 */
export const adoptFailure = (error: unknown, sessionId: string): string => {
  if (isAdoptDisabled(error)) {
    return (
      `this conversation's DSH session (${sessionId}) is no longer live, and the gateway has session ` +
      'adoption turned off, so it cannot be resumed. The history is still readable. ' +
      'Set allowAdopt on the gateway to continue conversations across restarts.'
    )
  }
  const detail = error instanceof GatewayError ? error.detail : String(error)
  if (detail.includes('session cap reached')) {
    return (
      'the gateway is holding its maximum number of live sessions, so this one could not be resumed. ' +
      'Raise maxSessions on the gateway, or wait for a session to be released.'
    )
  }
  if (detail.includes('session_not_found')) {
    return (
      `the DSH session ${sessionId} no longer exists on the gateway, so this conversation cannot be ` +
      'continued. Start a new one; the history above is kept.'
    )
  }
  if (detail.includes('resume_failed')) {
    return `DSH could not rebuild the session ${sessionId}: ${detail}`
  }
  return error instanceof GatewayError ? error.message : String(error)
}

export const runAgent = async (deps: RunnerDeps, input: RunInput): Promise<RunOutcome> => {
  const now = deps.clock ?? Date.now
  const log = deps.log
  const { agent, client, prompt } = input
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const silenceMs = input.silenceMs ?? DEFAULT_SILENCE_MS
  const startedAt = now()

  const runId = randomUUID()
  const set = activeRuns.get(agent.id) ?? new Set<string>()
  set.add(runId)
  activeRuns.set(agent.id, set)

  // Recorded before any network call, so a crashed run still leaves a trace.
  try {
    deps.db
      .insert(schema.run)
      .values({
        id: runId,
        agentId: agent.id,
        chatId: input.chatId ?? null,
        sourceChatId: input.sourceChatId ?? null,
        cronId: input.cronId ?? null,
        apiKeyId: null,
        dshSessionId: input.sessionId ?? null,
        trigger: input.trigger,
        idempotencyKey: input.idempotencyKey ?? null,
        state: 'running',
        resultSummary: null,
        startedAt,
        endedAt: null,
        error: null,
        conflict: null,
      })
      .run()
  } catch (error) {
    set.delete(runId)
    if (set.size === 0) activeRuns.delete(agent.id)
    throw new Error(`could not record run ${runId}: ${(error as Error).message}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('run timed out')), timeoutMs)

  // Armed when the stream opens and pushed forward by every frame, so it only
  // fires on real silence. Tracked separately from the total timeout because the
  // two mean different things to the person reading the failure.
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let silenced = false
  const clearSilence = () => {
    if (silenceTimer !== null) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  /**
   * How many questions or permission prompts this turn is waiting on a human for.
   *
   * The backstop exists to catch a turn that went quiet for a reason nobody can
   * see. A turn waiting on an answer is the opposite: quiet for a reason that is
   * on screen, with someone possibly mid-way through typing it. Cancelling that
   * would throw the turn's work away at the worst possible moment, so the
   * backstop stands down while the count is above zero -- the total timeout still
   * bounds the whole thing.
   */
  let awaitingHuman = 0
  const trackAwaiting = (frame: GatewayFrame) => {
    switch (frame.kind) {
      case 'question_asked':
      case 'approval_pending':
        awaitingHuman += 1
        return
      case 'question_resolved':
      case 'approval_resolved':
        awaitingHuman = Math.max(0, awaitingHuman - 1)
        return
      case 'hello': {
        // A stream can open onto a session that is already waiting on something.
        const questions = Array.isArray(frame.questions) ? frame.questions.length : 0
        const approvals = Array.isArray(frame.approvals) ? frame.approvals.length : 0
        awaitingHuman = questions + approvals
        return
      }
      case 'turn_end':
        awaitingHuman = 0
        return
      default:
        return
    }
  }

  const armSilence = () => {
    if (silenceMs <= 0) return
    clearSilence()
    if (awaitingHuman > 0) return
    silenceTimer = setTimeout(() => {
      silenced = true
      controller.abort(new Error('no frames'))
    }, silenceMs)
  }

  /** Why the turn was cancelled, phrased for whoever has to act on it. */
  const cancelledText = (): string =>
    silenced
      ? `nothing happened for ${Math.round(silenceMs / 1000)}s, so the turn was cancelled. ` +
        'A turn that goes quiet this long is usually waiting on something this side never saw -- ' +
        'an interactive question or a permission prompt that went somewhere else. Ask again, and if it ' +
        "keeps happening set the gateway's questions/approvals to 'gateway' so they arrive here, and " +
        "check the deployment's approval policy."
      : `no response within ${Math.round(timeoutMs / 1000)}s; the turn was cancelled`

  let sessionId: string | null = null
  let provider: string | null = null
  let model: string | null = null
  let usage: TokenUsage | null = null
  let reason: string | null = null
  let toolCalls = 0
  let timedOut = false
  const texts: string[] = []

  // Accumulated per response, because the rate depends on when each one landed.
  const pricing = deps.pricing ?? DEFAULT_PRICING
  let accruedCost = 0
  let accruedPeakCost = 0
  // Cleared the first time a priced response has no configured rate, so an
  // unpriced model reports an honest gap instead of a partial total.
  let costKnown = true

  // Note this does not release the agent lock: the caller does that only after
  // the workspace has been committed, so the next turn cannot write files that
  // would end up in this run's commit.
  const finish = (state: RunState, errorText: string | null): RunOutcome => {
    clearTimeout(timer)
    clearSilence()
    const endedAt = now()
    const summary = truncate(texts.join('\n').trim())
    const costMicroUsd = usage === null || !costKnown ? null : accruedCost
    const peakCostMicroUsd = costMicroUsd === null ? null : accruedPeakCost

    deps.db
      .update(schema.run)
      .set({
        state,
        dshSessionId: sessionId,
        resultSummary: summary === '' ? null : summary,
        endedAt,
        error: errorText,
      })
      .where(eq(schema.run.id, runId))
      .run()

    // Written even when the run failed: the tokens were spent either way, and
    // usage cannot be reconstructed after the fact.
    if (usage !== null) {
      deps.db
        .insert(schema.usageRecord)
        .values({
          runId,
          provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheReadTokens ?? null,
          cacheWrite: usage.cacheWriteTokens ?? null,
          reasoningTokens: usage.reasoningTokens ?? null,
          cost: costMicroUsd,
          peakCost: peakCostMicroUsd,
          at: endedAt,
        })
        .run()
    }

    return {
      runId,
      state,
      sessionId,
      summary,
      usage,
      costMicroUsd,
      peakCostMicroUsd,
      provider,
      model,
      reason,
      error: errorText,
      toolCalls,
      durationMs: endedAt - startedAt,
      // Filled in by the snapshot below, once the turn is over.
      commit: null,
      changedFiles: [],
      snapshotSkipped: null,
      conflict: null,
    }
  }

  // ---- gateway turn (existing path) ----

  const turnGateway = async (): Promise<RunOutcome> => {
    try {
      let cwd: string | null | undefined

      if (input.sessionId === undefined || input.sessionId === null) {
        const created = await client.createSession({
          cwd: agent.workspacePath,
          ...(agent.provider === undefined || agent.provider === null ? {} : { provider: agent.provider }),
          ...(agent.model === undefined || agent.model === null ? {} : { model: agent.model }),
        })
        sessionId = created.sessionId
        provider = created.provider ?? agent.provider ?? null
        model = created.model ?? agent.model ?? null
        cwd = created.cwd
      } else {
        // Adopt rather than send-and-retry-on-404.
        //
        // The gateway holds sessions in an in-memory map, so a DSH restart or its
        // maxSessions cap turns a session cold, and both `messages` and `stream`
        // answer 404 for a cold session. `adopt` is idempotent -- it returns the
        // live entry untouched when one exists (gateway index.ts:570-573) -- so
        // one unconditional call covers both the warm and the cold case.
        sessionId = input.sessionId
        let adopted
        try {
          adopted = await client.adopt(input.sessionId)
        } catch (error) {
          return finish('failed', adoptFailure(error, input.sessionId))
        }
        provider = adopted.provider ?? agent.provider ?? null
        model = adopted.model ?? agent.model ?? null
        cwd = adopted.cwd
      }

      // The gateway does not take a sandbox mode, and `cwd` is only the session's
      // working directory -- the real write boundary is the DSH process's own
      // sandboxPolicy.workspaceRoot, which manager cannot set. Worse, with
      // workspaceMode 'auto' the gateway may remap cwd to a workspace's canonical
      // path (dsh-api-gateway/src/index.ts:504-509).
      //
      // So verify where the session actually landed. Checked on the adopt path too,
      // not just on creation: a resumed session reports the cwd DSH rebuilt it
      // with, which is not guaranteed to be the one it was created with.
      if (cwd !== null && cwd !== undefined && !sameDirectory(cwd, agent.workspacePath)) {
        return finish(
          'failed',
          `the gateway placed the session in ${cwd} instead of ${agent.workspacePath}. ` +
            'Check the DSH profile\'s workspaceMode and sandboxPolicy.workspaceRoot; ' +
            'a session outside the agent workspace would write to the wrong place.',
        )
      }
      if (cwd === null || cwd === undefined) {
        log?.warn(
          `run ${runId}: the gateway reported no cwd, so the session's write location is whatever the DSH profile defaults to`,
        )
      }

      deps.db.update(schema.run).set({ dshSessionId: sessionId }).where(eq(schema.run.id, runId)).run()
      log?.info(`run ${runId}: session ${sessionId} on ${client.id}, cwd=${agent.workspacePath}`)

      const frames = streamFrames(client.streamUrl(sessionId), {
        headers: client.headers(),
        signal: controller.signal,
      })

      armSilence()
      let sent = false
      for await (const frame of frames) {
        // Counted before the timer is re-armed: the frame that says a question is
        // open is the same frame that must stop the backstop from arming.
        trackAwaiting(frame)
        armSilence()
        if (frame.kind === 'hello') {
          // Deliberately ignoring frame.log: it is history, and counting its usage
          // would bill previous turns again.
          if (!sent) {
            await client.sendMessage(sessionId, prompt)
            sent = true
          }
          continue
        }

        // Past hello, so this is live: safe to relay and safe to bill.
        input.onFrame?.(frame)

        if (isLiveMessage(frame)) {
          const frameUsage = normalizeUsage(frame.usage)
          usage = sumUsage(usage, frameUsage)
          if (frameUsage !== null) {
            const cost = computeCost(frameUsage, provider, model, now(), pricing)
            if (cost === null) costKnown = false
            else {
              accruedCost += cost.microUsd
              if (cost.peak) accruedPeakCost += cost.microUsd
            }
          }
          const text = typeof frame.text === 'string' ? frame.text : ''
          if (text !== '') texts.push(text)
          continue
        }

        if (frame.kind === 'tool_call') {
          toolCalls += 1
          continue
        }

        if (frame.kind === 'turn_end') {
          reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
          const detail = frame.detail as { message?: string; cause?: string } | null
          if (reason === 'error') {
            return finish('failed', detail?.message ?? 'the turn ended with an error')
          }
          if (reason === 'aborted') {
            return finish('failed', `the turn was aborted (${detail?.cause ?? 'unknown cause'})`)
          }
          return finish('done', null)
        }
      }

      // The stream ended without turn_end: the gateway keeps subscriptions open,
      // so this means the connection dropped or the abort fired.
      if (timedOut || controller.signal.aborted) {
        return finish('failed', cancelledText())
      }
      if (!sent) return finish('failed', 'the stream closed before the instruction could be sent')
      return finish('failed', 'the stream ended before the turn finished')
    } catch (error) {
      const aborted = controller.signal.aborted
      if (aborted) {
        timedOut = true
        // Cancelled rather than released here: the session may still be wanted
        // (a chat turn that timed out is still a chat), and the release decision
        // belongs to the cleanup below, which knows whether it is.
        if (sessionId !== null) {
          await client.cancel(sessionId).catch((cancelError: unknown) => {
            log?.warn(`run ${runId}: cancel failed: ${(cancelError as Error).message}`)
          })
        }
        return finish('failed', cancelledText())
      }
      const message = error instanceof GatewayError ? error.message : (error as Error).message
      log?.error(`run ${runId} failed: ${message}`)
      return finish('failed', message)
    }
  }

  // ---- apiproxy turn (new path) ----

  const turnApiproxy = async (): Promise<RunOutcome> => {
    const upstream = input.upstream!

    try {
      // apiproxy has no adopt/resume concept; prompt is the universal entry.
      // For a new session, create first; for an existing one, just prompt.
      if (input.sessionId === undefined || input.sessionId === null) {
        const created = await upstream.createSession(agent.workspacePath, agent.preset)
        sessionId = created.sessionId
        provider = created.provider ?? agent.provider ?? null
        model = created.model ?? agent.model ?? null
        // 蜂群 P0：在首次 prompt 之前把沙箱模式钉在会话上（sandbox/mode 日志
        // 事件，冷醒 replay 恢复，一次即持久）。续接路径的模式在创建时已设过。
        if (agent.sandboxMode !== null) {
          await upstream.setSandboxMode(sessionId, agent.sandboxMode)
        }
      } else {
        sessionId = input.sessionId
        provider = agent.provider ?? null
        model = agent.model ?? null
      }

      deps.db.update(schema.run).set({ dshSessionId: sessionId }).where(eq(schema.run.id, runId)).run()
      log?.info(`run ${runId}: session ${sessionId} on ${upstream.id} (apiproxy), cwd=${agent.workspacePath}`)

      // Subscribe to mux BEFORE sending the prompt, so we catch all frames.
      const turnDone = new Promise<RunOutcome>((resolveTurn) => {
        const unsub = upstream.subscribe(sessionId!, (_sid, frame) => {
          trackAwaiting(frame)
          armSilence()

          // All mux frames are live (no hello replay), safe to relay.
          input.onFrame?.(frame)

          // 审计留痕：主脑/agent 问人、要授权的帧到达即记一行，方便事后追溯
          // 「卡没出现」类问题的断点定位（第一次踩坑 2026-09-05）。
          if (frame.kind === 'question_asked' || frame.kind === 'approval_pending') {
            const qs = (frame as { questions?: unknown[] }).questions
            const ap = (frame as { approvalId?: string }).approvalId
            log?.info(
              `run ${runId}: ${frame.kind} (${frame.kind === 'question_asked' ? String(qs?.length ?? '?') + ' questions' : String(ap ?? '')})`,
            )
          }

          if (isLiveMessage(frame)) {
            const frameUsage = normalizeUsage(frame.usage)
            usage = sumUsage(usage, frameUsage)
            if (frameUsage !== null) {
              const cost = computeCost(frameUsage, provider, model, now(), pricing)
              if (cost === null) costKnown = false
              else {
                accruedCost += cost.microUsd
                if (cost.peak) accruedPeakCost += cost.microUsd
              }
            }
            const text = typeof frame.text === 'string' ? frame.text : ''
            if (text !== '') texts.push(text)
            return
          }

          if (frame.kind === 'tool_call') {
            toolCalls += 1
            return
          }

          if (frame.kind === 'turn_end') {
            unsub()
            reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
            const detail = frame.detail as { message?: string; cause?: string } | null
            if (reason === 'error') {
              resolveTurn(finish('failed', detail?.message ?? 'the turn ended with an error'))
              return
            }
            if (reason === 'aborted') {
              resolveTurn(finish('failed', `the turn was aborted (${detail?.cause ?? 'unknown cause'})`))
              return
            }
            resolveTurn(finish('done', null))
          }
        })

        // Abort handler: clean up the subscription
        controller.signal.addEventListener('abort', () => {
          unsub()
          timedOut = true
          upstream.cancel(sessionId!).catch((cancelError: unknown) => {
            log?.warn(`run ${runId}: cancel failed: ${(cancelError as Error).message}`)
          })
          resolveTurn(finish('failed', cancelledText()))
        }, { once: true })
      })

      armSilence()
      // Send the prompt (also resumes cold sessions: P3 confirmed)
      const promptResult = await upstream.prompt(sessionId, prompt)
      if (!promptResult.accepted) {
        return finish('failed', 'the prompt was not accepted by the upstream')
      }

      return await turnDone
    } catch (error) {
      if (controller.signal.aborted) {
        return finish('failed', cancelledText())
      }
      const message = error instanceof UpstreamError ? error.message
        : error instanceof GatewayError ? error.message
          : (error as Error).message
      log?.error(`run ${runId} failed: ${message}`)
      return finish('failed', message)
    }
  }

  const turn = (input.driver ?? 'gateway') === 'apiproxy' ? turnApiproxy : turnGateway

  try {
    // 蜂群 P5.4：git 层三件套之一——提交串行化。快照（含 git add/commit）
    // 必须排队执行：两个回合同时动 index 会在 .lock 上互相踩踏。回合本身
    // 全程并行，这里只是落盘排队的入口。
    const pre = await withCommitLock(agent.id, () => snapshotBefore(agent.workspacePath, { runId, agentName: agent.name }))
    if (pre.commit !== null) {
      log?.warn(
        `run ${runId}: committed ${pre.files.length} pre-existing change(s) in ${agent.name}'s workspace as ${pre.commit.slice(0, 8)} before starting`,
      )
    }
    if (pre.skipped !== null) log?.warn(`run ${runId}: ${pre.skipped}`)

    // 冲突检测的基线 = 本回合开始落盘时的工作区 HEAD。
    const baseline = pre.commit ?? (await currentHead(agent.workspacePath))

    const outcome = await turn()

    // 蜂群 P5.4：git 层三件套之二——冲突显性化。结束提交前看 HEAD 是否已
    // 被并发回合推走：是则本回合基于旧状态工作，冲突写进 run 行，绝不静默。
    const post = await withCommitLock(agent.id, async () => {
      const headNow = await currentHead(agent.workspacePath)
      if (baseline !== null && headNow !== null && baseline !== headNow) {
        const conflict = `并发修改：运行期间工作区被另一个回合提交（HEAD ${baseline.slice(0, 8)} → ${headNow.slice(0, 8)}），本回合基于旧状态工作`
        deps.db.update(schema.run).set({ conflict }).where(eq(schema.run.id, runId)).run()
        log?.warn(`run ${runId}: ${conflict}`)
      }
      return snapshotAfter(agent.workspacePath, {
        runId,
        agentName: agent.name,
        prompt,
        trigger: input.trigger,
        state: outcome.state,
      })
    })
    if (post.skipped !== null) log?.warn(`run ${runId}: ${post.skipped}`)
    else if (post.commit === null) log?.info(`run ${runId}: changed no files, so there is nothing to commit`)
    else log?.info(`run ${runId}: committed ${post.files.length} file(s) as ${post.commit.slice(0, 8)}`)

    // Stored, not just returned: a cron run's outcome goes to nobody, so this is
    // the only place the run list can learn what the run touched.
    if (post.commit !== null) {
      deps.db.update(schema.run).set({ commitHash: post.commit }).where(eq(schema.run.id, runId)).run()
    }

    const conflictRow = deps.db.select({ conflict: schema.run.conflict }).from(schema.run).where(eq(schema.run.id, runId)).all()
    return {
      ...outcome,
      commit: post.commit,
      changedFiles: post.files,
      snapshotSkipped: post.skipped,
      conflict: conflictRow[0]?.conflict ?? null,
    }
  } finally {
    // Handed back before the lock is dropped, so the next run cannot be refused
    // by `maxSessions` over a session this run has finished with.
    //
    // In `finally` because a thrown snapshot must not turn into a leaked slot,
    // and the failure is swallowed for the same reason the snapshot's is: the
    // turn already ran and was already paid for, so its outcome must not be lost
    // to a cleanup error. The gateway keeps the transcript either way, so the
    // worst case is a slot that stays held until DSH restarts -- visible in the
    // log, and recoverable.
    // apiproxy has no slot management; only gateway sessions need releasing.
    if ((input.driver ?? 'gateway') === 'gateway' && input.keepSession !== true && sessionId !== null) {
      try {
        await client.release(sessionId)
      } catch (error) {
        log?.warn(
          `run ${runId}: could not hand session ${sessionId} back to the gateway, ` +
            `so it still counts against maxSessions: ${(error as Error).message}`,
        )
      }
    }

    // 蜂群 P5.4：会话名额在任何提交/释放之前归还；活跃集合只登记展示。
    const set = activeRuns.get(agent.id)
    if (set !== undefined) {
      set.delete(runId)
      if (set.size === 0) activeRuns.delete(agent.id)
    }
  }
}
