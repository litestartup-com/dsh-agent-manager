import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { createInterface } from 'node:readline/promises'
import { backupNow, listSnapshots, restoreSnapshot } from '../backup.js'
import { loadConfig } from '../config.js'
import { collectNodeHomes, lastNodeHomeArchive, packNodeHomes, restoreNodeHome } from '../nodebackup.js'
import { deriveBackupKey } from '../crypt.js'
import { DockerRunner } from '../nodes/docker-runner.js'

/**
 * `npm run backup` / `npm run restore -- [快照名|latest]` / `npm run backup -- list`
 *
 * 蜂群 P6 + 蜂群2计划 P4：数据库快照 + 配置副本 + 节点 home（加密归档）。
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

/** 配置可读时收集节点 home + 必要的 docker runner；配置损坏则返回空（备份/恢复主体不受阻）。 */
const nodeContext = (): { entries: ReturnType<typeof collectNodeHomes>; runner: DockerRunner | undefined; key: Buffer | null } => {
  try {
    const config = loadConfig()
    const entries = collectNodeHomes(config)
    const runner = entries.some((e) => e.kind === 'docker') ? new DockerRunner({}) : undefined
    const key = deriveBackupKey(config.sessionSecret)
    return { entries, runner, key }
  } catch (error) {
    console.warn(`节点 home 备份/恢复跳过（配置不可读）：${(error as Error).message}`)
    return { entries: [], runner: undefined, key: null }
  }
}

const main = async (): Promise<void> => {
  const [command, name] = process.argv.slice(2)
  const dbPath = resolve('data/manager.db')
  const dir = join(resolve('data'), 'backups')

  if (command === 'restore') {
    if (await probe8080()) {
      console.error('manager 还在运行——先停掉它再恢复（恢复会覆盖数据库文件）。')
      process.exit(1)
    }
    const startedAt = Date.now()
    const result = restoreSnapshot(dbPath, dir, name ?? 'latest', () => false)
    if (!result.ok) {
      console.log(`恢复失败：${result.detail}`)
      process.exit(1)
    }
    console.log(result.detail)

    // 蜂群2计划 P4：节点 home 一并恢复（各节点取最新归档）。
    // 评审 B4：目录形态恢复会清空目标——先列出将清空的目录，要求确认。
    const { entries, runner, key } = nodeContext()
    const dirTargets = entries.filter((e) => e.kind === 'dir').map((e) => e.home)
    if (dirTargets.length > 0) {
      console.log('将清空并还原以下节点 home 目录：')
      for (const target of dirTargets) console.log(`  - ${target}`)
      if (process.env.OHDSH_RESTORE_YES !== '1') {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question('确认继续？输入 yes 执行，其它任意键取消：')
        rl.close()
        if (answer !== 'yes') {
          console.log('已取消。')
          process.exit(1)
        }
      }
    }
    for (const entry of entries) {
      const last = lastNodeHomeArchive(dir, entry.nodeId)
      if (last === null) {
        console.warn(`节点 ${entry.nodeId}：没有 home 归档，跳过。`)
        continue
      }
      if (key === null) continue
      try {
        await restoreNodeHome(entry, last.file, dir, key, runner)
        console.log(`节点 ${entry.nodeId}：home 已从 ${last.file} 恢复。`)
      } catch (error) {
        console.error(`节点 ${entry.nodeId}：home 恢复失败：${(error as Error).message}`)
        process.exit(1)
      }
    }
    console.log(`恢复完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s（RTO 目标 ≤ 5 分钟）。`)
    return
  }

  if (command === 'list') {
    const snaps = listSnapshots(dir)
    if (snaps.length === 0) console.log('还没有快照。')
    for (const s of snaps) {
      console.log(`${s.file}  ${new Date(s.at).toLocaleString('zh-CN')}  ${(s.bytes / 1024).toFixed(0)} KB`)
    }
    const { entries } = nodeContext()
    for (const entry of entries) {
      const last = lastNodeHomeArchive(dir, entry.nodeId)
      console.log(last === null ? `节点 ${entry.nodeId}：还没有 home 归档` : `节点 ${entry.nodeId}：${last.file}  ${new Date(last.at).toLocaleString('zh-CN')}`)
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

  const { entries, runner, key } = nodeContext()
  if (entries.length > 0 && key !== null) {
    const packed = await packNodeHomes(entries, dir, key, runner)
    if (packed.length === 0) console.log('节点 home：6 小时内已有归档，跳过。')
    else console.log(`节点 home 归档（加密）：${packed.join(', ')}`)
  }
}

void main()
