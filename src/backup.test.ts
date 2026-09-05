import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { backupNow, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotDb } from './backup.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'backup-'))

/** Windows 上刚写入/覆盖过的文件句柄可能滞后释放（EBUSY）：清理重试几次。 */
const cleanup = async (dir: string): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 120))
    }
  }
}

test('蜂群 P6: snapshotDb takes a consistent copy with the same rows', async () => {
  const dir = fresh()
  try {
    const dbPath = join(dir, 'manager.db')
    const src = new Database(dbPath)
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const insert = src.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 50; i += 1) insert.run(`row-${i}`)
    src.close()

    const snap = await snapshotDb(dbPath, join(dir, 'backups'))
    assert.ok(existsSync(join(dir, 'backups', snap.file)))

    const copy = new Database(join(dir, 'backups', snap.file), { readonly: true })
    const rows = copy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }
    assert.equal(rows.n, 50)
    copy.close()
  } finally {
    await cleanup(dir)
  }
})

test('蜂群 P6: retention keeps 24h hourly, then daily for 30d, then weekly for 12w', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  mkdirSync(backups, { recursive: true })
  try {
    const now = Date.now()
    const HOUR = 3_600_000
    const DAY = 24 * HOUR
    const plant = (age: number): void => {
      const d = new Date(now - age)
      const pad = (n: number): string => String(n).padStart(2, '0')
      const file = `manager-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}00.db`
      writeFileSync(join(backups, file), 'x')
      utimesSync(join(backups, file), new Date(now - age), new Date(now - age))
    }

    plant(10 * 60_000) // 10 分钟前 → 留
    plant(20 * HOUR) // 昨天 → 留（30 天内每日一份）
    plant(10 * DAY) // 10 天前 → 留
    plant(40 * DAY) // 6 周前 → 周桶留
    plant(100 * DAY) // 15 周前 → 删
    plant(10 * DAY) // 同一天第二份 → 删（每日只留第一份）

    const removed = pruneSnapshots(backups, now)
    const kept = listSnapshots(backups).map((s) => s.file)

    assert.ok(!removed.some((f) => f.includes('recent')), '24h 内的快照全留')
    assert.equal(kept.length, 4, `kept 4 of 6, got: ${kept.join(', ')}`)
    // 15 周前那份（100 天）被删
    assert.ok(!kept.some((f) => f.includes('100')), '')
  } finally {
    await cleanup(dir)
  }
})

test('蜂群 P6: restoreSnapshot refuses while the manager runs and recovers by name or latest', async () => {
  const dir = fresh()
  const backups = join(dir, 'backups')
  try {
    const dbPath = join(dir, 'manager.db')
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE t (v TEXT)')
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('sentinel')
    seed.close()
    const result = await backupNow(dbPath, join(dir, 'cfg.yaml'), join(dir, '.env'), backups)

    // 运行中拒绝
    const refused = restoreSnapshot(dbPath, backups, 'latest', () => true)
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /运行/)

    const readSentinel = (): string => {
      const db = new Database(dbPath, { readonly: true })
      const row = db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string }
      db.close()
      return row.v
    }

    // 按名恢复
    rmSync(dbPath, { force: true })
    const byName = restoreSnapshot(dbPath, backups, result.snapshot.file, () => false)
    assert.equal(byName.ok, true)
    assert.equal(readSentinel(), 'sentinel')

    // latest
    rmSync(dbPath, { force: true })
    const byLatest = restoreSnapshot(dbPath, backups, 'latest', () => false)
    assert.equal(byLatest.ok, true)
    assert.equal(readSentinel(), 'sentinel')

    // 未知快照
    const missing = restoreSnapshot(dbPath, backups, 'nope.db', () => false)
    assert.equal(missing.ok, false)
  } finally {
    await cleanup(dir)
  }
})
