import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'

/**
 * Spend, read back out of the ledger.
 *
 * Two rules run through all of it:
 *
 * 1. **A missing rate is not zero.** Rows whose model had no configured rate are
 *    counted in `unpriced` and left out of the money, so a total is always
 *    reported as a floor with a visible gap beside it rather than as a
 *    confident number that happens to be too low.
 * 2. **Months are local.** Buckets come from SQLite's `localtime` modifier, so
 *    an evening run in UTC+8 lands in the month the operator thinks it did.
 *    Server timezone is the authority; there is one operator and one machine.
 */

/** `strftime` over an epoch-milliseconds column, in local time. */
const localBucket = (format: string): ReturnType<typeof sql> =>
  sql.raw(`strftime('${format}', at / 1000, 'unixepoch', 'localtime')`)

/**
 * 债务 B5:分桶过滤不再用 strftime(索引用不上,全表扫)——把本地月/日分桶
 * 换算成 epoch 毫秒半开区间,`at >= start AND at < end` 命中 usage_at 索引。
 * 与 strftime '%Y-%m'/'%Y-%m-%d' 分桶在本地时区语义上完全等价。
 */
export const monthRangeMs = (month: string): { start: number; end: number } => {
  const [y, m] = month.split('-').map(Number)
  return { start: new Date(y ?? 0, (m ?? 1) - 1, 1).getTime(), end: new Date(y ?? 0, m ?? 1, 1).getTime() }
}

export const dayRangeMs = (day: string): { start: number; end: number } => {
  const [y, m, d] = day.split('-').map(Number)
  return { start: new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime(), end: new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + 1).getTime() }
}

/** 范围过滤片段的模板(sql 参数化,防注入)。 */
const inRange = (range: { start: number; end: number }): ReturnType<typeof sql> =>
  sql`at >= ${range.start} AND at < ${range.end}`

export interface SpendTotals {
  runs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Sum of known costs, in micro-USD. A floor when `unpriced` is above zero. */
  costMicroUsd: number
  /** The part of `costMicroUsd` billed at the peak rate. */
  peakCostMicroUsd: number
  /** Records whose model had no configured rate, so their cost is unknown. */
  unpriced: number
}

export interface AgentSpend extends SpendTotals {
  agentId: string
}

export interface ModelSpend extends SpendTotals {
  provider: string | null
  model: string | null
}

export interface DailySpend {
  day: string
  costMicroUsd: number
  peakCostMicroUsd: number
  unpriced: number
}

interface RawTotals {
  runs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  costMicroUsd: number | null
  peakCostMicroUsd: number | null
  unpriced: number | null
}

const toTotals = (r: RawTotals | undefined): SpendTotals => ({
  runs: r?.runs ?? 0,
  inputTokens: r?.inputTokens ?? 0,
  outputTokens: r?.outputTokens ?? 0,
  cacheReadTokens: r?.cacheReadTokens ?? 0,
  costMicroUsd: r?.costMicroUsd ?? 0,
  peakCostMicroUsd: r?.peakCostMicroUsd ?? 0,
  unpriced: r?.unpriced ?? 0,
})

/**
 * The aggregate columns, shared by every grouping below.
 *
 * `SUM(cost)` skips NULLs, which is exactly right -- an unknown cost must not
 * be added in as zero -- but it also means the total alone cannot tell you
 * whether anything was missing. That is what the `unpriced` counter is for.
 */
const AGGREGATES = sql.raw(`
  COUNT(DISTINCT run_id) AS runs,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read), 0) AS cacheReadTokens,
  COALESCE(SUM(cost), 0) AS costMicroUsd,
  COALESCE(SUM(peak_cost), 0) AS peakCostMicroUsd,
  SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced
`)

/** Months that have any recorded usage, newest first. */
export const spendMonths = (db: Db): string[] => {
  const rows = db.all<{ month: string }>(
    sql`SELECT DISTINCT ${localBucket('%Y-%m')} AS month FROM usage_record ORDER BY month DESC`,
  )
  return rows.map((r) => r.month)
}

/** 债务 E15:美元 ↔ 微美元换算因子(钱领域唯一来源,不再散落 1e6 字面量)。 */
export const USD_TO_MICRO = 1_000_000

export const monthTotals = (db: Db, month: string): SpendTotals => {
  const rows = db.all<RawTotals>(
    sql`SELECT ${AGGREGATES} FROM usage_record WHERE ${inRange(monthRangeMs(month))}`,
  )
  return toTotals(rows[0])
}

/**
 * Spend per agent for a month.
 *
 * The agent is reached through `run`, since `usage_record` only knows its run.
 * Every column is table-qualified: an unqualified name inside a join resolves
 * against whichever table happens to have it, which is a silent wrong answer
 * rather than an error.
 */
export const monthByAgent = (db: Db, month: string): AgentSpend[] => {
  const rows = db.all<RawTotals & { agentId: string }>(sql`
    SELECT
      run.agent_id AS agentId,
      COUNT(DISTINCT usage_record.run_id) AS runs,
      COALESCE(SUM(usage_record.input_tokens), 0) AS inputTokens,
      COALESCE(SUM(usage_record.output_tokens), 0) AS outputTokens,
      COALESCE(SUM(usage_record.cache_read), 0) AS cacheReadTokens,
      COALESCE(SUM(usage_record.cost), 0) AS costMicroUsd,
      COALESCE(SUM(usage_record.peak_cost), 0) AS peakCostMicroUsd,
      SUM(CASE WHEN usage_record.cost IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM usage_record
    JOIN run ON run.id = usage_record.run_id
    WHERE usage_record.at >= ${monthRangeMs(month).start} AND usage_record.at < ${monthRangeMs(month).end}
    GROUP BY run.agent_id
    ORDER BY costMicroUsd DESC, runs DESC
  `)
  return rows.map((r) => ({ agentId: r.agentId, ...toTotals(r) }))
}

export const monthByModel = (db: Db, month: string): ModelSpend[] => {
  const rows = db.all<RawTotals & { provider: string | null; model: string | null }>(sql`
    SELECT provider, model, ${AGGREGATES}
    FROM usage_record
    WHERE ${inRange(monthRangeMs(month))}
    GROUP BY provider, model
    ORDER BY costMicroUsd DESC, runs DESC
  `)
  return rows.map((r) => ({ provider: r.provider, model: r.model, ...toTotals(r) }))
}

/** One bucket per day that has usage, oldest first, for a bar chart. */
export const monthByDay = (db: Db, month: string): DailySpend[] =>
  db.all<DailySpend>(sql`
    SELECT
      ${localBucket('%Y-%m-%d')} AS day,
      COALESCE(SUM(cost), 0) AS costMicroUsd,
      COALESCE(SUM(peak_cost), 0) AS peakCostMicroUsd,
      SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM usage_record
    WHERE ${inRange(monthRangeMs(month))}
    GROUP BY day
    ORDER BY day ASC
  `)

/**
 * Spend for one local day, which is what a daily budget has to be measured on.
 *
 * Deliberately a floor: unpriced rows are excluded from the money and counted
 * separately. A budget guard that treated an unknown cost as zero would keep
 * spending happily through the exact situation where it cannot see the bill --
 * so the caller is told, and refuses to run rather than guessing.
 */
export const daySpend = (db: Db, day: string): { costMicroUsd: number; unpriced: number } => {
  const rows = db.all<{ costMicroUsd: number | null; unpriced: number | null }>(sql`
    SELECT
      COALESCE(SUM(cost), 0) AS costMicroUsd,
      SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM usage_record
    WHERE ${inRange(dayRangeMs(day))}
  `)
  return { costMicroUsd: rows[0]?.costMicroUsd ?? 0, unpriced: rows[0]?.unpriced ?? 0 }
}

/** Today in the same local-time terms the day buckets use. */
export const currentDay = (now: number = Date.now()): string => {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The current month in the same local-time terms the buckets use. */
export const currentMonth = (now: number = Date.now()): string => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
