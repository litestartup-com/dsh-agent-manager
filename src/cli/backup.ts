import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { backupNow, listSnapshots, restoreSnapshot } from '../backup.js'

/**
 * `npm run backup` / `npm run restore -- [快照名|latest]` / `npm run backup -- list`
 *
 * 蜂群 P6：数据库备份与恢复。备份 = DB 一致快照 + 配置副本 + 保留策略；
 * 恢复要求 manager 已停止（探 8080 端口）。
 */

/** 8080 端口探活：通 = manager 在跑（恢复前必须停）。 */
const probe8080 = (): Promise<boolean> =>
  new Promise((done) => {
    const socket = new net.Socket()
    let open = false
    socket.setTimeout(500)
    socket.once('connect', () => {
      open = true
      socket.destroy()
    })
    socket.once('error', () => socket.destroy())
    socket.once('timeout', () => socket.destroy())
    socket.once('close', () => done(open))
    socket.connect(8080, '127.0.0.1')
  })

const main = async (): Promise<void> => {
  const [command, name] = process.argv.slice(2)
  const dbPath = resolve('data/manager.db')
  const dir = join(resolve('data'), 'backups')

  if (command === 'restore') {
    if (await probe8080()) {
      console.error('manager 还在运行——先停掉它再恢复（恢复会覆盖数据库文件）。')
      process.exit(1)
    }
    const result = restoreSnapshot(dbPath, dir, name ?? 'latest', () => false)
    console.log(result.ok ? result.detail : `恢复失败：${result.detail}`)
    process.exit(result.ok ? 0 : 1)
    return
  }

  if (command === 'list') {
    const snaps = listSnapshots(dir)
    if (snaps.length === 0) {
      console.log('还没有快照。')
      return
    }
    for (const s of snaps) {
      console.log(`${s.file}  ${new Date(s.at).toLocaleString('zh-CN')}  ${(s.bytes / 1024).toFixed(0)} KB`)
    }
    return
  }

  // 默认 = backup
  if (!existsSync(dbPath)) {
    console.error('没有 data/manager.db——先启动过 manager 才有东西可备份。')
    process.exit(1)
  }
  const result = await backupNow(dbPath, resolve('manager.config.yaml'), resolve('.env'), dir)
  console.log(`快照完成：${result.snapshot.file}（${(result.snapshot.bytes / 1024).toFixed(0)} KB），配置副本已更新。`)
  if (result.pruned.length > 0) console.log(`按保留策略清理了 ${result.pruned.length} 个旧快照。`)
}

void main()
