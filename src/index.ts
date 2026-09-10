import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply } from 'fastify'
import { desc, isNull } from 'drizzle-orm'
import { loadConfig } from './config.js'
import { openDb, schema } from './db/index.js'
import { backupNow } from './backup.js'
import { generatePassword, hashPassword } from './auth/password.js'
import { pruneExpiredSessions } from './auth/session.js'
import { makeRequirePage, makeRequireUser } from './auth/hooks.js'
import { buildClients } from './gateway/client.js'
import { buildUpstreamClients, closeAllMux } from './upstream/client.js'
import { reconcileAll, startPeriodicReconcile } from './reconcile/index.js'
import { buildNodeSupervisors } from './nodes/registry.js'
import { DockerRunner } from './nodes/docker-runner.js'
import { recordAudit } from './audit.js'
import { makeCsrfHook } from './routes/auth.js'
import { registerAuditRoutes } from './routes/audit.js'
import { collectNodeHomes, packNodeHomes } from './nodebackup.js'
import { seedEmptyWorkspaces } from './workspace/seed.js'
import { provisionBrainToken } from './workspace/fleet-doc.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerStatusRoutes } from './routes/status.js'
import { registerWorkspaceRoutes } from './routes/workspace.js'
import { registerRunRoutes } from './routes/run.js'
import { closeBoardWatchers, registerBoardRoutes } from './routes/board.js'
import { closeChatRelays, registerChatRoutes } from './routes/chat.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerCronRoutes } from './routes/cron.js'
import { registerInternalRoutes } from './routes/internal.js'
import { registerNodesRoutes } from './routes/nodes.js'
import { registerSkillsRoutes } from './routes/skills.js'
import { registerNotificationRoutes } from './routes/notifications.js'
import { registerProvisionRoutes } from './routes/provision.js'
import { Scheduler } from './cron/schedule.js'
import { assetCacheHeaders, buildPages } from './pages.js'
import { registerSecurityHeaders } from './security.js'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')

const main = async (): Promise<void> => {
  const config = loadConfig()
  const { db, applied } = openDb(config.databasePath)

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
    },
    // P0-4：反代信任边界由 TRUST_PROXY 决定，默认不信任转发头 —— 登录限流以
    // request.ip 为键，全信任等于让攻击者换个 X-Forwarded-For 就绕过唯一的暴破防线。
    // 反代后想要真实客户端 IP：在 .env 里写可信的那一跳（如 TRUST_PROXY=127.0.0.1）。
    trustProxy: config.trustProxy ?? false,
  })

  if (applied.length > 0) app.log.info(`applied database migrations: ${applied.join(', ')}`)
  for (const warning of config.warnings) app.log.warn(warning)
  const pruned = pruneExpiredSessions(db)
  if (pruned > 0) app.log.info(`pruned ${pruned} expired session(s)`)

  // First boot: create the admin account. Without this the instance would come
  // up with no way to log in.
  const existing = db.select({ id: schema.user.id }).from(schema.user).limit(1).all()
  if (existing.length === 0) {
    const password = config.initialUser.password ?? generatePassword()
    const generated = config.initialUser.password === null
    db.insert(schema.user)
      .values({
        username: config.initialUser.username,
        passwordHash: await hashPassword(password),
        createdAt: Date.now(),
        mustChangePassword: 1,
      })
      .run()
    app.log.warn(`created initial user "${config.initialUser.username}"`)
    if (generated) {
      // Printed exactly once, and only because no password was configured.
      app.log.warn(`generated password: ${password}  <-- save it now, it will not be shown again`)
    }
  }

  // Mirror configured agents into the registry so later stages (bootstrap,
  // runner) read one source of truth at runtime.
  // ↓ 已收敛进 src/reconcile（A 清单 #2 单一化）：DB 镜像 / 遗留 run / 孤儿会话
  //   / fleet 下发 / 节点认领统一走 reconcileAll，见下方调用点。

  const clients = buildClients(config.endpoints)
  const upstreamClients = buildUpstreamClients(config.endpoints)
  // 蜂群2计划 P2b：只有存在 runner=docker 的节点才连 docker.sock（裸机路径零依赖）
  const needsDocker = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
  const dockerRunner = needsDocker ? new DockerRunner({}) : null
  const nodeSupervisors = buildNodeSupervisors(config, {
    gateway: (id) => clients.get(id),
    upstream: (id) => upstreamClients.get(id),
    log: (line) => app.log.info(line),
    docker: dockerRunner ?? undefined,
  })
  // 蜂群2计划 P6：容器路径没有 setup 步骤——空工作区启动即播种模板
  // （主脑的 AGENTS.md/技能手册、个人的模板页），任何已有文件的工作区绝不触碰。
  const seededWorkspaces = seedEmptyWorkspaces(
    Object.values(config.agents).map((a) => ({ id: a.id, workspacePath: a.workspacePath })),
    (line) => app.log.info(line),
  )
  if (seededWorkspaces.length > 0) app.log.info(`workspaces seeded: ${seededWorkspaces.join(', ')}`)
  // 裸机形态：主脑令牌写入节点用户 HOME（容器形态由节点 entrypoint 自己派生）。
  // DSH 工具沙箱洗 TOKEN 字样 env（DSH-FACTS §2），技能手册读 $HOME/.brain-auth。
  const brainAgent = config.agents['brain']
  const brainSpawn = brainAgent === undefined ? undefined : config.endpoints[brainAgent.endpoint]?.spawn
  if (brainSpawn !== undefined && brainSpawn !== null && brainSpawn.runner === 'process') {
    provisionBrainToken(undefined, (line) => app.log.info(line))
  }

  // 对账单一化（A 清单 #2）：DB 注册表镜像、遗留 run 收敛、孤儿会话归档、
  // fleet.md 派生下发、托管节点认领（docker 对账 / process 拉起）——
  // boot 与配置变更（provision 路由）共用这一个入口，runHygiene 仅 boot 打开。
  await reconcileAll(
    { db, config, supervisors: nodeSupervisors, docker: dockerRunner, log: (line) => app.log.info(line) },
    { runHygiene: true },
  )
  // 修路 A2：周期对账（间隔配置 reconcile_interval_minutes，0 = 关）。
  // healOnly：人手动停的冷态节点不动，失败落 offline 的节点自愈。
  const stopPeriodicReconcile = startPeriodicReconcile(
    { db, config, supervisors: nodeSupervisors, docker: dockerRunner, log: (line) => app.log.info(line) },
    config.reconcileIntervalMs ?? 10 * 60_000,
  )
  app.addHook('onClose', async () => { stopPeriodicReconcile() })
  const requireUser = makeRequireUser(db)
  const requirePage = makeRequirePage(db)
  // Secure cookies require HTTPS; on plain-HTTP localhost dev they would simply
  // never be sent back, making login appear broken.
  const secureCookies = process.env.NODE_ENV === 'production'

  // P1-1：安全响应头（CSP 等）——在任何路由之前注册，页面与 API 一并覆盖。
  // secure 同时决定 HSTS 是否下发：明文 HTTP 形态下发 HSTS 会把站点钉死。
  await registerSecurityHeaders(app, secureCookies)
  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(rateLimit, { global: false })
  // 蜂群2计划 P3：CSRF —— 非 GET 的 API 请求必须带与 cookie 一致的 X-CSRF-Token
  // （双提交）。豁免：/api/login（尚无会话）与 /api/internal/*（主脑令牌认证）。
  // P6 自愈：升级前的老会话缺 csrf cookie → 服务端补发，前端 403 重试一次。
  app.addHook('onRequest', makeCsrfHook(secureCookies))
  // `no-cache` means "you may keep it, but ask before using it" -- a conditional
  // request answered by a 304, not a re-download. The page URLs carry a content
  // hash so they rarely even get here; this covers what a hash cannot reach,
  // namely one module importing another by a bare path. Anything is better than
  // the default, under which an edited stylesheet may simply never arrive and the
  // symptom looks like a CSS bug rather than a cached file.
  await app.register(fastifyStatic, {
    root: join(publicDir, 'assets'),
    prefix: '/assets/',
    cacheControl: false,
    setHeaders: assetCacheHeaders,
  })

  // Composed once at boot, so a missing fragment fails here rather than in
  // somebody's browser.
  const pages = buildPages(publicDir)
  // HTML documents carry no version of their own: stale-proofing them is one
  // header. (Assets are the opposite -- hash-versioned URLs plus must-revalidate
  // -- so a restart changes their URL, but a document URL never does.)
  const noCache = (reply: FastifyReply): FastifyReply => reply.header('cache-control', 'no-store')
  const page =
    (name: string) =>
    async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> =>
      noCache(reply.type('text/html').send(pages.get(name)))

  // 蜂群 Q5：首页已删。/ 与 /app 都直达最近会话——首页最后剩下的职能就
  // 是重定向，那就让它只是重定向。一条会话都没有时落在 /chat 空态
  // （chat.js 会提示从侧栏选会话），绝不在 GET 上做创建副作用。
  const landing = async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
    const rows = db
      .select()
      .from(schema.chat)
      .where(isNull(schema.chat.removedAt))
      .orderBy(desc(schema.chat.lastActiveAt))
      .all()
    const latest = rows.find((row) => config.agents[row.agentId] !== undefined)
    return reply.redirect(latest === undefined ? '/chat' : `/chat/${encodeURIComponent(latest.id)}`, 302)
  }
  app.get('/', landing)
  app.get('/app', landing)
  // The only page outside the shell, on purpose: the sidebar is agent data, and
  // there is no session yet to fetch it with.
  app.get('/login', async (_request, reply) => noCache(reply.type('text/html').sendFile('login.html', publicDir)))
  // One page for every agent; which board to draw comes from the path, and the
  // data comes from /api/board/:id.
  app.get<{ Params: { id: string } }>('/board/:id', { preHandler: requirePage }, page('board'))
  // Same shape as the board: one page, and which conversation to draw comes from
  // the path. `/chat` without an id is the empty state, which is what the "new
  // conversation" action navigates to before a chat row exists.
  app.get('/chat', { preHandler: requirePage }, page('chat'))
  app.get<{ Params: { id: string } }>('/chat/:id', { preHandler: requirePage }, page('chat'))
  app.get('/archive', { preHandler: requirePage }, page('archive'))
  app.get('/spend', { preHandler: requirePage }, page('spend'))
  app.get('/crons', { preHandler: requirePage }, page('crons'))
  app.get('/nodes', { preHandler: requirePage }, page('nodes'))
  app.get('/skills', { preHandler: requirePage }, page('skills'))
  // 蜂群2计划 P3：改密页（强制改密期间的落点）与审计页
  app.get('/password', { preHandler: requirePage }, page('password'))
  app.get('/audit', { preHandler: requirePage }, page('audit'))

  // P1-5：改密成功后抹掉 .env 里的初始口令（路径推导与自动备份处一致；
  // 单一来源收进 AppConfig 是 P2-5 的事）。
  registerAuthRoutes(app, db, secureCookies, join(here, '..', '.env'))
  registerAuditRoutes(app, db, requireUser)
  registerStatusRoutes(app, config, db, clients, requireUser, upstreamClients, nodeSupervisors)
  registerWorkspaceRoutes(app, config, requireUser)
  registerRunRoutes(app, config, db, clients, requireUser, upstreamClients)
  registerBoardRoutes(app, config, requireUser)
  registerChatRoutes(app, config, db, clients, requireUser, upstreamClients)
  registerUsageRoutes(app, config, db, requireUser)

  const scheduler = new Scheduler({
    db,
    config,
    clients,
    upstreamClients,
    log: {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
      error: (m) => app.log.error(m),
    },
  })
  registerCronRoutes(app, config, db, scheduler, requireUser)
  // 蜂群 P2：主脑面内部 API（仅 127.0.0.1 + X-Brain-Token）。
  registerInternalRoutes(app, config, db, clients, upstreamClients, scheduler)
  // 蜂群 P3：节点（fleet）视图。审计回调：节点操作全留痕。
  registerNodesRoutes(app, config, nodeSupervisors, clients, upstreamClients, requireUser, (actor, kind, detail) =>
    recordAudit(db, { actor, kind, detail }),
  )
  registerProvisionRoutes(app, config, requireUser, { db, supervisors: nodeSupervisors, clients, upstreamClients, docker: dockerRunner ?? undefined })
  registerSkillsRoutes(app, config, requireUser)
  registerNotificationRoutes(app, db, requireUser)

  const close = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`)
    // Open SSE streams and filesystem watchers would otherwise keep the event
    // loop alive and turn a clean stop into a hang.
    closeBoardWatchers()
    closeChatRelays()
    closeAllMux()
    scheduler.stop()
    // 蜂群 P1：manager 退场时带走它拉起的节点（taskkill /T 同步发出，不留孤儿）。
    for (const supervisor of nodeSupervisors.values()) supervisor.stop()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void close('SIGINT'))
  process.on('SIGTERM', () => void close('SIGTERM'))

  await app.listen({ host: config.listen.host, port: config.listen.port })
  // Started only once the process is fully up: the stale-run sweep above has to
  // have cleared the previous process's locks, or the first fire would collide
  // with a run that no longer exists.
  scheduler.start()
  app.log.info(
    `agents: ${Object.keys(config.agents).join(', ') || '(none)'} | endpoints: ${Object.keys(config.endpoints).join(', ')}`,
  )

  // 蜂群 P6：15 分钟级数据库快照（RPO），保留策略在 backup.ts。备份失败只
  // 打日志不退出——manager 的价值高于备份，但失败必须看得见。
  const backupDir = join(dirname(config.databasePath), 'backups')
  const autoBackup = async (): Promise<void> => {
    try {
      const result = await backupNow(config.databasePath, join(dirname(fileURLToPath(import.meta.url)), '..', 'manager.config.yaml'), join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), backupDir)
      app.log.info(`backup: ${result.snapshot.file} (${result.snapshot.bytes} bytes)${result.pruned.length > 0 ? `, pruned ${result.pruned.length}` : ''}`)
      // 蜂群2计划 P3：审计留痕（自动备份，actor = system）
      recordAudit(db, { actor: 'system', kind: 'backup', detail: `快照 ${result.snapshot.file}` })
      // 蜂群2计划 P4：节点 home 一并打包加密（6 小时内已有归档则跳过）
      const nodeEntries = collectNodeHomes(config)
      if (nodeEntries.length > 0) {
        try {
          const packed = await packNodeHomes(nodeEntries, backupDir, config.sessionSecret, dockerRunner ?? undefined)
          if (packed.length > 0) app.log.info(`backup: node homes → ${packed.join(', ')}`)
        } catch (error) {
          app.log.error(`node home backup failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      app.log.error(`backup failed: ${(error as Error).message}`)
    }
  }
  setInterval(() => void autoBackup(), 15 * 60_000)
}

main().catch((error: unknown) => {
  // Config and migration failures land here. Print plainly -- the logger may not
  // exist yet, and a stack trace for "SESSION_SECRET is empty" only obscures it.
  console.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
