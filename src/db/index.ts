import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * Migrations are plain SQL applied in order, tracked by `schema_version`.
 *
 * Deliberately not using drizzle-kit's generated migrations at boot: a first run
 * must succeed with `npm install && npm run dev` and nothing else. Drizzle is
 * still used for all queries, so the type safety is unaffected.
 *
 * Append-only: never edit a released step, always add a new one.
 */
const MIGRATIONS: readonly string[][] = [
  // 1 -- initial schema
  [
    `CREATE TABLE IF NOT EXISTS user (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS session (
       id TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
       expires_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS session_expires ON session(expires_at)`,
    `CREATE TABLE IF NOT EXISTS agent (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       workspace_path TEXT NOT NULL,
       endpoint TEXT NOT NULL,
       preset TEXT,
       git_remote TEXT,
       public INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS api_key (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       key_hash TEXT NOT NULL,
       scope_agents TEXT NOT NULL,
       scope_actions TEXT NOT NULL,
       quota_tokens_day INTEGER,
       quota_runs_day INTEGER,
       revoked INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       last_used_at INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS cron (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       schedule TEXT NOT NULL,
       timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
       prompt TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       last_run_at INTEGER
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS cron_agent_name ON cron(agent_id, name)`,
    `CREATE TABLE IF NOT EXISTS run (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       cron_id TEXT,
       api_key_id TEXT,
       dsh_session_id TEXT,
       trigger TEXT NOT NULL,
       idempotency_key TEXT,
       state TEXT NOT NULL,
       result_summary TEXT,
       started_at INTEGER NOT NULL,
       ended_at INTEGER,
       error TEXT
     )`,
    // Retrying an outward API call must never make an agent do the work twice.
    `CREATE UNIQUE INDEX IF NOT EXISTS run_idem ON run(agent_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS run_agent_state ON run(agent_id, state)`,
    `CREATE INDEX IF NOT EXISTS run_started ON run(started_at)`,
    `CREATE TABLE IF NOT EXISTS usage_record (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
       provider TEXT,
       model TEXT,
       input_tokens INTEGER NOT NULL DEFAULT 0,
       output_tokens INTEGER NOT NULL DEFAULT 0,
       cache_read INTEGER,
       cache_write INTEGER,
       reasoning_tokens INTEGER,
       cost INTEGER,
       at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS usage_at ON usage_record(at)`,
    `CREATE INDEX IF NOT EXISTS usage_run ON usage_record(run_id)`,
  ],
  // 2 -- one live run per agent
  [
    // The in-process lock cannot survive a restart, and two concurrent turns in
    // one workspace would interleave writes to the same files. This index is the
    // authority; the lock is only a fast path with a clearer error.
    `CREATE UNIQUE INDEX IF NOT EXISTS run_one_live_per_agent ON run(agent_id)
       WHERE state IN ('pending', 'running')`,
  ],
  // 3 -- multi-turn chats
  [
    // A chat owns exactly one long-lived DSH session and many turns. The session
    // id is nullable because a chat exists from the moment the user opens it,
    // while the gateway session is only created when the first message is sent.
    //
    // `removed_at` rather than DELETE, and the session id survives it. Removing
    // a chat hands the gateway slot back but does not destroy the transcript,
    // which stays on the gateway and stays reachable through this id. Dropping
    // the row would lose the only pointer to a conversation that still exists.
    `CREATE TABLE IF NOT EXISTS chat (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       dsh_session_id TEXT,
       title TEXT,
       created_at INTEGER NOT NULL,
       last_active_at INTEGER NOT NULL,
       removed_at INTEGER
     )`,
    // The sidebar lists an agent's chats newest-first, so order by the same key.
    `CREATE INDEX IF NOT EXISTS chat_agent_active ON chat(agent_id, last_active_at)`,
    // Looking a chat up by the gateway session id is how an inbound stream frame
    // is attributed back to a chat.
    `CREATE UNIQUE INDEX IF NOT EXISTS chat_session ON chat(dsh_session_id)
       WHERE dsh_session_id IS NOT NULL`,
    // Turns keep living in `run`, so the cost ledger, cron and the outward API
    // all keep working untouched. A chat is only the thread that groups them.
    `ALTER TABLE run ADD COLUMN chat_id TEXT REFERENCES chat(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS run_chat ON run(chat_id, started_at)`,
  ],
  // 4 -- peak / off-peak split
  [
    // DeepSeek bills V4 at two rates, peak being exactly double off-peak for 7
    // of every 24 hours. Knowing the split is what makes "move this cron two
    // hours earlier" a decision rather than a guess.
    //
    // It has to be stored: `at` is when the run ended, but a turn is priced per
    // response and a long turn can straddle a boundary, so the split cannot be
    // recomputed from one timestamp. Existing rows keep NULL -- they were
    // written before rates were configured and their cost is unknown, which is
    // the honest value.
    `ALTER TABLE usage_record ADD COLUMN peak_cost INTEGER`,
  ],
  // 5 -- the commit each run produced
  [
    // Without this the snapshot is invisible for the runs nobody watches. A cron
    // run's outcome is returned to no one, so `git log --grep=<run id>` would be
    // the only way to find what it changed. Storing the hash makes the run list
    // answer "what did this actually do to my files".
    //
    // NULL means the run changed nothing, or that no snapshot could be taken;
    // those are different states and `error` carries the reason for the latter.
    `ALTER TABLE run ADD COLUMN commit_hash TEXT`,
  ],
  // 6 -- what a schedule has to remember between runs
  [
    // Ordering by name puts "weekly-review" above "trade-log" for no reason the
    // operator can see. Creation order is at least stable and meaningful.
    `ALTER TABLE cron ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
    // A cron run reports to nobody, so "it failed three times" is useless
    // without the reason. This is the only place the cause survives.
    `ALTER TABLE cron ADD COLUMN last_error TEXT`,
    // The one thing that must never be ambiguous: whether *you* switched this
    // off or the manager did. Same `enabled = 0` either way, and a bare toggle
    // sitting off would read as your own decision.
    `ALTER TABLE cron ADD COLUMN disabled_reason TEXT`,
    // Answers "did it run yet today" without scanning the run table, and is what
    // the missed-occurrence count at boot is measured from.
    `ALTER TABLE cron ADD COLUMN last_state TEXT`,
  ],
  // 7 -- 蜂群 P2：主脑派工的来源会话（delegation 帧按它归属到主脑会话页）
  [
    `ALTER TABLE run ADD COLUMN source_chat_id TEXT REFERENCES chat(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS run_source_chat ON run(source_chat_id, started_at)`,
  ],
  // 8 -- 蜂群 P5.4：同 agent 多会话并发。
  // 「每 agent 一活 run」的唯一索引退役：DSH 自身的会话名额（maxSessions）
  // 是天然上限，manager 不再人为串行。conflict 列记录并发写冲突的显性化。
  [
    `DROP INDEX IF EXISTS run_one_live_per_agent`,
    `ALTER TABLE run ADD COLUMN conflict TEXT`,
  ],
]

export interface OpenDbResult {
  db: Db
  sqlite: Database.Database
  applied: number[]
}

export const openDb = (path: string): OpenDbResult => {
  mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')

  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  const current = row.v ?? 0

  const applied: number[] = []
  for (let i = current; i < MIGRATIONS.length; i += 1) {
    const version = i + 1
    const statements = MIGRATIONS[i]
    if (statements === undefined) continue
    const tx = sqlite.transaction(() => {
      for (const sql of statements) sqlite.exec(sql)
      sqlite.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now())
    })
    tx()
    applied.push(version)
  }

  return { db: drizzle(sqlite, { schema }), sqlite, applied }
}

export { schema }
