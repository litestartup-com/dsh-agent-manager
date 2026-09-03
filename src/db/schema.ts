import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Eight tables, none of which holds business data.
 *
 * All notes, dashboard JSON and markdown live in the agents' workspaces as
 * ordinary files under git (DESIGN.md §0). If this database is deleted, nothing
 * of yours is lost -- only accounts, schedules, run history and the cost ledger.
 *
 * Timestamps are epoch milliseconds (integer), so SQLite comparisons are cheap
 * and no timezone ambiguity can creep in.
 */

export const user = sqliteTable('user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
})

/** Server-side sessions so a login can actually be revoked (a JWT cannot). */
export const session = sqliteTable('session', {
  /** sha256 of the cookie token. The raw token exists only in the cookie. */
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const agent = sqliteTable('agent', {
  /** Slug used in URLs: personal / company / product. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  workspacePath: text('workspace_path').notNull(),
  /** Endpoint id from manager.config.yaml, not a URL. */
  endpoint: text('endpoint').notNull(),
  preset: text('preset'),
  gitRemote: text('git_remote'),
  /** 1 = callable through the outward task API. Forces a dedicated DSH process. */
  public: integer('public').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

export const apiKey = sqliteTable('api_key', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  /** JSON array of agent ids. Never defaults to include private agents. */
  scopeAgents: text('scope_agents').notNull(),
  scopeActions: text('scope_actions').notNull(),
  quotaTokensDay: integer('quota_tokens_day'),
  quotaRunsDay: integer('quota_runs_day'),
  revoked: integer('revoked').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
})

export const cron = sqliteTable('cron', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  prompt: text('prompt').notNull(),
  enabled: integer('enabled').notNull().default(1),
  /** Auto-disables the job once this hits the configured ceiling. */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastRunAt: integer('last_run_at'),
  createdAt: integer('created_at').notNull().default(0),
  /** Why the last attempt failed. Cleared on success. */
  lastError: text('last_error'),
  /**
   * Set only when the manager disabled the job itself.
   *
   * `enabled = 0` looks identical whether the operator flipped it or the failure
   * ceiling did, and an unexplained toggle sitting off reads as your own doing.
   */
  disabledReason: text('disabled_reason'),
  /** Outcome of the last attempt: a run state, or 'skipped'. */
  lastState: text('last_state'),
})

/**
 * A multi-turn conversation, owning exactly one long-lived DSH session.
 *
 * `removedAt` hides a chat rather than deleting anything. Removing it hands the
 * gateway slot back, but the transcript stays on the gateway, so `dshSessionId`
 * remains the pointer to a conversation that still exists and can be adopted.
 */
export const chat = sqliteTable('chat', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  /** Null until the first message creates the gateway session. */
  dshSessionId: text('dsh_session_id'),
  /** The gateway's own session title when it has one, else the first message. */
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  lastActiveAt: integer('last_active_at').notNull(),
  removedAt: integer('removed_at'),
})

export const run = sqliteTable('run', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  /** The thread this turn belongs to. Null for cron and API runs with no chat. */
  chatId: text('chat_id'),
  /**
   * 蜂群 P2：主脑派工时所在的会话——delegation 帧按它归属到主脑会话页。
   * Null for everything that did not come from the brain conversation.
   */
  sourceChatId: text('source_chat_id'),
  cronId: text('cron_id'),
  apiKeyId: text('api_key_id'),
  dshSessionId: text('dsh_session_id'),
  /** 'cron' | 'manual' | 'api' | 'capture' | 'brain' */
  trigger: text('trigger').notNull(),
  idempotencyKey: text('idempotency_key'),
  /** 'pending' | 'running' | 'done' | 'failed' | 'missed' */
  state: text('state').notNull(),
  resultSummary: text('result_summary'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  error: text('error'),
  /**
   * The commit holding whatever this run changed in the workspace.
   *
   * NULL when the run changed nothing, which is the common case for a run that
   * only read files, and also when no snapshot could be taken at all.
   */
  commitHash: text('commit_hash'),
})

/**
 * Written from the provider's reported usage on the gateway SSE stream, never
 * from dsh-token-meter (that one is a context-pressure heuristic, not billing).
 */
export const usageRecord = sqliteTable('usage_record', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  provider: text('provider'),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheRead: integer('cache_read'),
  cacheWrite: integer('cache_write'),
  reasoningTokens: integer('reasoning_tokens'),
  cost: integer('cost'),
  /**
   * The part of `cost` that was billed at the peak rate.
   *
   * Stored rather than derived: `at` is when the run ended, but a turn is priced
   * per response and a long one can straddle a peak boundary, so the split
   * cannot be recovered from a single timestamp afterwards.
   */
  peakCost: integer('peak_cost'),
  at: integer('at').notNull(),
})
