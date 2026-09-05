import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * 蜂群 P6：数据库备份/恢复（RPO ≤ 15 分钟，RTO ≤ 5 分钟）。
 *
 * 快照用 better-sqlite3 的原生 backup()：WAL 下一致、不停机。
 * 保留策略（§3.5）：最近 24 小时全留（15 分钟粒度）→ 之后每日留一份，
 * 保留 30 天 → 更早每周留一份，保留 12 周。
 */

export interface SnapshotInfo {
  file: string
  at: number
  bytes: number
}

/** 备份目录里按时间正序的 db 快照列表。 */
export const listSnapshots = (dir: string): SnapshotInfo[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^manager-\d{8}-\d{6}\.db$/.test(f))
    .map((file) => {
      const path = join(dir, file)
      return { file, at: statSync(path).mtimeMs, bytes: statSync(path).size }
    })
    .sort((a, b) => a.at - b.at)
}

/**
 * 给 manager.db 拍一张一致快照到备份目录。返回快照信息。
 * 直接失败抛出：备份失败必须可见，不能静默吞掉。
 */
export const snapshotDb = async (dbPath: string, dir: string, now = Date.now()): Promise<SnapshotInfo> => {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const file = `manager-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.db`
  const out = join(dir, file)
  const src = new Database(dbPath, { readonly: true, fileMustExist: true })
  await src.backup(out) // better-sqlite3：目标传路径，一致复制（WAL 安全），异步
  src.close()
  return { file, at: now, bytes: statSync(out).size }
}

/** 按保留策略清掉过期的快照。返回被删除的文件名。 */
export const pruneSnapshots = (dir: string, now = Date.now()): string[] => {
  const all = listSnapshots(dir)
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const kept = new Set<string>()
  const firstOfDay = new Set<string>()
  const firstOfWeek = new Set<string>()

  for (const s of all) {
    if (now - s.at <= 24 * HOUR) {
      kept.add(s.file)
      continue
    }
    const d = new Date(s.at)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (!firstOfDay.has(dayKey)) {
      firstOfDay.add(dayKey)
      if (now - s.at <= 30 * DAY) {
        kept.add(s.file)
        continue
      }
      // 周桶：取每周一（周一当天的最早一份）
      const weekKey = weekStamp(d)
      if (!firstOfWeek.has(weekKey) && now - s.at <= 12 * 7 * DAY) {
        firstOfWeek.add(weekKey)
        kept.add(s.file)
      }
    }
  }

  const removed: string[] = []
  for (const s of all) {
    if (!kept.has(s.file)) {
      rmSync(join(dir, s.file), { force: true })
      removed.push(s.file)
    }
  }
  return removed
}

/** 周一 00:00 的时间戳键（周桶）。 */
const weekStamp = (d: Date): string => {
  const day = d.getDay() === 0 ? 7 : d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day - 1))
  monday.setHours(0, 0, 0, 0)
  return String(monday.getTime())
}

export interface BackupResult {
  snapshot: SnapshotInfo
  pruned: string[]
}

/**
 * 一次完整备份：DB 快照 + 配置（manager.config.yaml 与 .env）副本 + 清单。
 * 配置副本只保留最新一份（备份目录里 .current/ 符号式目录），避免重复膨胀。
 */
export const backupNow = async (dbPath: string, configPath: string, envPath: string, dir: string): Promise<BackupResult> => {
  const snapshot = await snapshotDb(dbPath, dir)
  const current = join(dir, 'current')
  mkdirSync(current, { recursive: true })
  if (existsSync(configPath)) copyFileSync(configPath, join(current, 'manager.config.yaml'))
  if (existsSync(envPath)) copyFileSync(envPath, join(current, '.env'))
  writeFileSync(join(current, 'manifest.json'), JSON.stringify({ at: snapshot.at, snapshot: snapshot.file }, null, 2), 'utf8')
  const pruned = pruneSnapshots(dir, snapshot.at)
  return { snapshot, pruned }
}

/** 恢复是否被阻止：manager 还在跑时绝不能覆盖它的库。probe = 探活函数。 */
export interface RestoreResult {
  ok: boolean
  detail: string
}

export const restoreSnapshot = (
  dbPath: string,
  dir: string,
  name: string | 'latest',
  managerRunning: () => boolean,
): RestoreResult => {
  if (managerRunning()) {
    return { ok: false, detail: 'manager 还在运行——先停掉它再恢复（恢复会覆盖数据库文件）。' }
  }
  const snaps = listSnapshots(dir)
  const pick = name === 'latest' ? snaps[snaps.length - 1] : snaps.find((s) => s.file === name)
  if (pick === undefined) {
    return { ok: false, detail: name === 'latest' ? '没有可恢复的快照。' : `找不到快照 ${name}。` }
  }
  // 直接覆盖拷贝：manager 已停（调用方把关），无需 rename 两步——
  // Windows 上 rename 覆盖与 unlink 都容易撞上句柄占用（EBUSY）。
  copyFileSync(join(dir, pick.file), dbPath)
  return { ok: true, detail: `已从 ${pick.file} 恢复（${new Date(pick.at).toLocaleString('zh-CN')}）。` }
}
