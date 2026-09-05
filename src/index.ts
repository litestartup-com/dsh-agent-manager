import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply } from 'fastify'
import { desc, eq, inArray, isNull } from 'drizzle-orm'
import { loadConfig } from './config.js'
import { openDb, schema } from './db/index.js'
import { backupNow } from './backup.js'
import { generatePassword, hashPassword } from './auth/password.js'
import { pruneExpiredSessions } from './auth/session.js'
import { makeRequirePage, makeRequireUser } from './auth/hooks.js'
import { buildClients } from './gateway/client.js'
import { buildUpstreamClients, closeAllMux } from './upstream/client.js'
import { buildNodeSupervisors } from './nodes/registry.js'
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
    // Behind Caddy/nginx for TLS, so trust the proxy headers for client IPs
    // (which the login rate limiter keys on).
    trustProxy: true,
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
  for (const agent of Object.values(config.agents)) {
    const rows = db.select({ id: schema.agent.id }).from(schema.agent).where(eq(schema.agent.id, agent.id)).all()
    const values = {
      id: agent.id,
      name: agent.name,
      workspacePath: agent.workspacePath,
      endpoint: agent.endpoint,
      preset: agent.preset,
      gitRemote: agent.gitRemote,
      public: agent.public ? 1 : 0,
      createdAt: Date.now(),
    }
    if (rows.length === 0) db.insert(schema.agent).values(values).run()
    else {
      const { createdAt: _ignored, ...rest } = values
      db.update(schema.agent).set(rest).where(eq(schema.agent.id, agent.id)).run()
    }
  }

  // A run only exists inside a manager process, so anything still marked live
  // at boot died with the previous one. Left alone it would hold the
  // one-live-run-per-agent index forever and no further run could start.
  const stale = db
    .update(schema.run)
    .set({ state: 'failed', endedAt: Date.now(), error: 'manager restarted while this run was in flight' })
    .where(inArray(schema.run.state, ['pending', 'running']))
    .run()
  if (stale.changes > 0) app.log.warn(`marked ${stale.changes} interrupted run(s) as failed`)

  const clients = buildClients(config.endpoints)
  const upstreamClients = buildUpstreamClients(config.endpoints)
  const nodeSupervisors = buildNodeSupervisors(config, {
    gateway: (id) => clients.get(id),
    upstream: (id) => upstreamClients.get(id),
    log: (line) => app.log.info(line),
  })
  // 蜂群 P1：被托管的节点随 manager 一起拉起。不托管（spawn 缺省/关闭）的节点
  // 由外部管理，manager 只探活——用户手动起的 DSH 不会被抢管。
  for (const [id, supervisor] of nodeSupervisors) {
    const spec = config.endpoints[id]?.spawn
    if (spec === null || spec === undefined) continue
    app.log.info(`node ${id}: managed (${spec.command} ${spec.args.join(' ')})`)
    supervisor.start(spec)
  }
  const requireUser = makeRequireUser(db)
  const requirePage = makeRequirePage(db)
  // Secure cookies require HTTPS; on plain-HTTP localhost dev they would simply
  // never be sent back, making login appear broken.
  const secureCookies = process.env.NODE_ENV === 'production'

  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(rateLimit, { global: false })
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

  registerAuthRoutes(app, db, secureCookies)
  registerStatusRoutes(app, config, db, clients, requireUser, upstreamClients)
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
  // 蜂群 P3：节点（fleet）视图。
  registerNodesRoutes(app, config, nodeSupervisors, clients, upstreamClients, requireUser)
  registerProvisionRoutes(app, config, requireUser, { db, supervisors: nodeSupervisors, clients, upstreamClients })
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
