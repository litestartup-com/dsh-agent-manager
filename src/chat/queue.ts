/**
 * Per-agent chat send queue (scheme C).
 *
 * 蜂群 P5.4：busy 触发已退役——同 agent 多会话直接并发，上限由 gateway
 * 名额约束。本模块与「取消排队」端点、前端的 turn_queued dock 一并保留，
 * 作为将来「gateway 满员时降级为排队」的缓冲机制接线点（触发条件待接入，
 * 目前没有生产者，队列恒为空）。
 *
 * In-memory only — a manager restart drops queued turns, which is no worse
 * than today's refusal (the sender re-sends).
 */

export interface QueuedTurn {
  id: string
  chatId: string
  execute: () => Promise<void>
}

const queues = new Map<string, QueuedTurn[]>()
const draining = new Set<string>()

/** How many turns are queued for one agent. */
export const queuedTurnsFor = (agentId: string): number => queues.get(agentId)?.length ?? 0

/**
 * Add one turn to the agent's queue. Returns its 1-based position.
 */
export const enqueueTurn = (agentId: string, turn: QueuedTurn): number => {
  const q = queues.get(agentId) ?? []
  q.push(turn)
  queues.set(agentId, q)
  return q.length
}

/**
 * Start the next queued turn for an agent, if any. Safe to call at any time:
 * a concurrent drain is a no-op, and when the queue is empty nothing happens.
 */
export const drainAgentQueue = (agentId: string): void => {
  if (draining.has(agentId)) return
  const q = queues.get(agentId)
  if (q === undefined || q.length === 0) {
    queues.delete(agentId)
    return
  }
  const next = q.shift()!
  draining.add(agentId)
  // The catch is load-bearing: a rejecting execute would otherwise surface as
  // an unhandledRejection and, on some runtimes, take the process down. The
  // turn's own error reporting is the execute closure's job.
  void next.execute().catch(() => undefined).finally(() => {
    draining.delete(agentId)
    drainAgentQueue(agentId)
  })
}

/**
 * Drop one queued turn by id (edit/undo or delete from the dock).
 * Idempotent: an id that already ran — or never existed — is a no-op, so the
 * caller can apply the UI removal optimistically.
 */
export const cancelQueuedTurn = (chatId: string, turnId: string): void => {
  for (const [agentId, items] of Array.from(queues.entries())) {
    const kept = items.filter((turn) => !(turn.chatId === chatId && turn.id === turnId))
    if (kept.length === items.length) continue
    if (kept.length === 0) queues.delete(agentId)
    else queues.set(agentId, kept)
  }
}

/** Drop every queued turn of one chat (archive / delete). */
export const cancelQueuedTurns = (chatId: string): void => {
  for (const [agentId, q] of Array.from(queues.entries())) {
    const kept = q.filter((turn) => turn.chatId !== chatId)
    if (kept.length === 0) queues.delete(agentId)
    else queues.set(agentId, kept)
  }
}

/** Clear all queues (shutdown / tests). */
export const closeQueues = (): void => {
  queues.clear()
  draining.clear()
}
