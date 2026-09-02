import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { loadConfig } from './config.js'
import { openDb, schema } from './db/index.js'
import { generatePassword, hashPassword } from './auth/password.js'
import { pruneExpiredSessions } from './auth/session.js'
import { makeRequirePage, makeRequireUser } from './auth/hooks.js'
import { buildClients } from './gateway/client.js'
import { buildUpstreamClients, closeAllMux } from './upstream/client.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerStatusRoutes } from './routes/status.js'
import { registerWorkspaceRoutes } from './routes/workspace.js'
import { registerRunRoutes } from './routes/run.js'
import { closeBoardWatchers, registerBoardRoutes } from './routes/board.js'
import { closeChatRelays, registerChatRoutes } from './routes/chat.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerCronRoutes } from './routes/cron.js'
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
  const page =
    (name: string) =>
    async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> =>
      reply.type('text/html').send(pages.get(name))

  app.get('/', async (_request, reply) => reply.redirect('/app', 302))
  // The only page outside the shell, on purpose: the sidebar is agent data, and
  // there is no session yet to fetch it with.
  app.get('/login', async (_request, reply) => reply.type('text/html').sendFile('login.html', publicDir))
  app.get('/app', { preHandler: requirePage }, page('home'))
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

  const close = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`)
    // Open SSE streams and filesystem watchers would otherwise keep the event
    // loop alive and turn a clean stop into a hang.
    closeBoardWatchers()
    closeChatRelays()
    closeAllMux()
    scheduler.stop()
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
}

main().catch((error: unknown) => {
  // Config and migration failures land here. Print plainly -- the logger may not
  // exist yet, and a stack trace for "SESSION_SECRET is empty" only obscures it.
  console.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
