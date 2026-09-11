import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'
import { createInterface } from 'node:readline/promises'
import { backupNow, listSnapshots, restoreSnapshot } from '../backup.js'
import { loadConfig, type AppConfig } from '../config.js'
import { collectNodeHomes, lastNodeHomeArchive, packNodeHomes, restoreNodeHome } from '../nodebackup.js'
import { DockerRunner } from '../nodes/docker-runner.js'

/**
 * `npm run backup` / `npm run restore -- [快照名|latest]` / `npm run backup -- list`
 *
 * 蜂群 P6 + 蜂群2计划 P4：数据库快照（加密）+ 配置副本（明文，仅供人工参考）
 * + 节点 home（加密归档）。恢复要求 manager 已停止（按配置端口探活）。
 *
 * 债务 R3（2026-09-12）：DB 路径、备份目录、探活端口与密钥只来自一次成功的
 * loadConfig()——自定义 database.path / listen.port 不再备错/恢复错文件。
 * 恢复在配置不可读时大声拒绝，绝不静默回退默认库；备份保留 A5 的既定容错
 * （配置损坏时警告 + 回退 cwd 相对默认，备份主体不受阻）。
 *
 * 债务 R4（2026-09-12）口径：`backups/current/manager.config.yaml` 与 `.env.enc`
 * 只是「同备份目录内的参考副本」，restore 只还原 DB 与节点 home——配置恢复
 * 是人工动作（对照参考副本重写真相源），本 CLI 不做自动配置恢复。
 */

/** 端口探活：通 = manager 在跑（恢复前必须停）。port 来自 loadConfig，不再写死 8080。 */
const probePort = (port: number): Promise<boolean> =>
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
    socket.connect(port, '127.0.0.1')
  })

/** 配置可读时收集节点 home + 必要的 docker runner（传入已加载的 config，不重复 loadConfig）。 */
const nodeContext = (config: AppConfig | null): { entries: ReturnType<typeof collectNodeHomes>; runner: DockerRunner | undefined } => {
  if (config === null) return { entries: [], runner: undefined }
  const entries = collectNodeHomes(config)
  const runner = entries.some((e) => e.kind === 'docker') ? new DockerRunner({}) : undefined
  return { entries, runner }
}

const main = async (): Promise<void> => {
  const [command, name] = process.argv.slice(2)

  if (command === 'restore') {
    // 债务 R3：恢复要求一次成功的 loadConfig——配置不可读即拒绝，绝不静默
    // 回退默认库（恢复错文件比不恢复更糟）。
    let cfg: AppConfig
    try {
      cfg = loadConfig()
    } catch (error) {
      console.error(`配置不可读，拒绝恢复：${(error as Error).message}`)
      process.exit(1)
    }
    const dbPath = cfg.databasePath
    const dir = join(dirname(dbPath), 'backups')
    if (await probePort(cfg.listen.port)) {
      console.error('manager 还在运行——先停掉它再恢复（恢复会覆盖数据库文件）。')
      process.exit(1)
    }
    const startedAt = Date.now()
    try {
      const result = await restoreSnapshot(dbPath, dir, name ?? 'latest', () => false, cfg.sessionSecret)
      if (!result.ok) {
        console.log(`恢复失败：${result.detail}`)
        process.exit(1)
      }
      console.log(result.detail)
      // 债务 R4 口径：配置副本仅供人工参考，本 CLI 不自动恢复配置。
      console.log('注意：backups/current/ 下的配置副本（manager.config.yaml / .env.enc）仅供人工参考，未自动恢复。')
    } catch (error) {
      // 加密快照解密失败（篡改/密钥错）也会走到这里——显性失败，绝不静默。
      console.error(`恢复失败：${(error as Error).message}`)
      process.exit(1)
    }

    // 蜂群2计划 P4：节点 home 一并恢复（各节点取最新归档）。
    // 评审 B4：目录形态恢复会清空目标——先列出将清空的目录，要求确认。
    const { entries, runner } = nodeContext(cfg)
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
      try {
        await restoreNodeHome(entry, last.file, dir, cfg.sessionSecret, runner)
        console.log(`节点 ${entry.nodeId}：home 已从 ${last.file} 恢复。`)
      } catch (error) {
        console.error(`节点 ${entry.nodeId}：home 恢复失败：${(error as Error).message}`)
        process.exit(1)
      }
    }
    console.log(`恢复完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s（RTO 目标 ≤ 5 分钟）。`)
    return
  }

  // 债务 R3：备份/list 的路径只来自一次成功的 loadConfig；配置损坏时大声
  // 警告 + 回退 cwd 相对默认（A5 既定设计——数据保护不因配置损坏而停摆）。
  let dbPath = resolve('data/manager.db')
  let dir = join(resolve('data'), 'backups')
  let cfg: AppConfig | null = null
  try {
    cfg = loadConfig()
    dbPath = cfg.databasePath
    dir = join(dirname(dbPath), 'backups')
  } catch (error) {
    console.warn(`配置不可读（${(error as Error).message}），路径回退默认值——如使用自定义 database.path，请先修复配置。`)
  }

  if (command === 'list') {
    const snaps = listSnapshots(dir)
    if (snaps.length === 0) console.log('还没有快照。')
    for (const s of snaps) {
      console.log(`${s.file}  ${new Date(s.at).toLocaleString('zh-CN')}  ${(s.bytes / 1024).toFixed(0)} KB`)
    }
    const { entries } = nodeContext(cfg)
    for (const entry of entries) {
      const last = lastNodeHomeArchive(dir, entry.nodeId)
      console.log(last === null ? `节点 ${entry.nodeId}：还没有 home 归档` : `节点 ${entry.nodeId}：${last.file}  ${new Date(last.at).toLocaleString('zh-CN')}`)
    }
    return
  }

  // 默认 = backup
  if (!existsSync(dbPath)) {
    console.error(`没有 ${dbPath}——先启动过 manager 才有东西可备份。`)
    process.exit(1)
  }
  // 债务 A5/R3：真相源路径从同一次 loadConfig 的结果取（单一来源）。
  const configPath = cfg?.configPath ?? resolve('manager.config.yaml')
  const envPath = cfg?.envPath ?? resolve('.env')
  const result = await backupNow(dbPath, configPath, envPath, dir, cfg?.sessionSecret ?? '')
  console.log(`快照完成：${result.snapshot.file}（${(result.snapshot.bytes / 1024).toFixed(0)} KB，已加密），配置副本已更新。`)
  if (result.pruned.length > 0) console.log(`按保留策略清理了 ${result.pruned.length} 个旧快照。`)

  const { entries, runner } = nodeContext(cfg)
  if (cfg !== null && entries.length > 0) {
    const packed = await packNodeHomes(entries, dir, cfg.sessionSecret, runner)
    if (packed.length === 0) console.log('节点 home：6 小时内已有归档，跳过。')
    else console.log(`节点 home 归档（加密）：${packed.join(', ')}`)
  } else if (cfg === null) {
    console.warn('节点 home 备份跳过（配置不可读）。')
  }
}

void main()
