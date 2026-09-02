import type { NoteData } from './notedata.js'

/**
 * Enforces rules that already exist in note-kaka's own documentation, so an
 * agent cannot quietly violate them:
 *
 *  - note-data/README.md §3  governance windows (files must not grow forever)
 *  - note-data/README.md §4  no credentials in data files
 *  - RULE.md §7             trade records percentages only, never amounts
 *
 * These are checks, not rewrites. A failing write is rejected and rolled back
 * rather than silently "fixed", because silently truncating someone's data is
 * worse than refusing to write it.
 */

export interface Violation {
  rule: string
  path: string
  detail: string
}

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

const dig = (data: NoteData, path: string[]): unknown => {
  let current: unknown = data
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** README §3: page shows the active window only; history belongs in markdown. */
const WINDOWS: { path: string[]; max: number; archive: string }[] = [
  { path: ['trade', 'history'], max: 8, archive: 'E03.10.01-交易大盘（持仓·任务·快照）.md' },
  { path: ['weekly', 'weeks'], max: 26, archive: 'G-日志/.../00-2026年周报/*.md' },
  { path: ['weekly', 'logs'], max: 10, archive: 'G01.08-2026年/0X月份/' },
]

const checkWindows = (data: NoteData): Violation[] => {
  const out: Violation[] = []
  for (const { path, max, archive } of WINDOWS) {
    const list = asArray(dig(data, path))
    if (list === null) continue
    if (list.length > max) {
      out.push({
        rule: 'governance-window',
        path: path.join('.'),
        detail: `${list.length} entries exceeds the documented cap of ${max}; archive the oldest to ${archive} first (note-data/README.md §3)`,
      })
    }
  }
  return out
}

/**
 * RULE.md §7 and trade.js's own header: percentages only, never amounts.
 *
 * `cost` and `price` are legitimate per-share quotes already present in the
 * file; what must never appear is anything that reveals position size in money.
 */
const MONEY_FIELDS = /^(amount|amt|money|cash_?value|value|total|shares|qty|quantity|金额|市值|数量|股数|成本额)$/i

const checkTradePrivacy = (data: NoteData): Violation[] => {
  const out: Violation[] = []
  const trade = dig(data, ['trade'])
  if (trade === null || typeof trade !== 'object') return out

  const scan = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => scan(item, `${path}[${i}]`))
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (MONEY_FIELDS.test(key)) {
        out.push({
          rule: 'no-amounts',
          path: `${path}.${key}`,
          detail: 'trade data records percentages only, never amounts (RULE.md §7)',
        })
      }
      scan(value, `${path}.${key}`)
    }
  }

  scan(trade, 'trade')
  return out
}

/**
 * README §4: no password, token, API key or server credential may appear in a
 * data file. Patterns are deliberately narrow -- a false positive blocks a
 * legitimate write, which is far more annoying than a missed exotic format.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'aws access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'url with inline credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
  { name: 'labelled credential', re: /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i },
]

const checkSecrets = (data: NoteData): Violation[] => {
  const out: Violation[] = []
  const scan = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(node)) {
          out.push({
            rule: 'no-secrets',
            path,
            // The offending value is never echoed back -- that would copy the
            // secret into manager's logs and HTTP responses.
            detail: `looks like a ${name}; credentials must not appear in data files (note-data/README.md §4)`,
          })
        }
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => scan(item, `${path}[${i}]`))
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) scan(value, `${path}.${key}`)
  }
  scan(data, '$')
  return out
}

/** README §2.5 / §2.1: `acct.flow` keeps the current and previous month only. */
const checkAcctFlow = (data: NoteData, now = new Date()): Violation[] => {
  const flow = asArray(dig(data, ['acct', 'flow']))
  if (flow === null) return []

  const allowed = new Set<string>()
  for (let back = 0; back <= 1; back += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1)
    allowed.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    allowed.add(String(d.getMonth() + 1).padStart(2, '0'))
  }

  const out: Violation[] = []
  flow.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object') return
    const d = (entry as { d?: unknown }).d
    if (typeof d !== 'string') return
    // Placeholder rows are the documented way to show "no data yet" (README
    // §2.0), and acct.js currently ships exactly that. Only a genuinely
    // date-shaped value can be stale.
    const match = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(d.trim())
    if (match === null) return
    const month = match[1] === undefined ? (match[2] ?? '').padStart(2, '0') : `${match[1]}-${(match[2] ?? '').padStart(2, '0')}`
    if (!allowed.has(month)) {
      out.push({
        rule: 'governance-window',
        path: `acct.flow[${i}]`,
        detail: `entry dated "${d}" is older than last month; archive it to the E-财富 accounting markdown first (note-data/README.md §3)`,
      })
    }
  })
  return out
}

export interface ValidateOptions {
  now?: Date
}

export const validateNoteData = (data: NoteData, options: ValidateOptions = {}): Violation[] => [
  ...checkWindows(data),
  ...checkTradePrivacy(data),
  ...checkSecrets(data),
  ...checkAcctFlow(data, options.now ?? new Date()),
]
