import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { COOKIE_NAME, issueSession, resolveSession, revokeSession } from '../auth/session.js'
import { recordAudit } from '../audit.js'

/** 蜂群2计划 P3：CSRF 双提交 cookie（非 httpOnly，前端读出来放进 X-CSRF-Token）。 */
export const CSRF_COOKIE = 'ohdsh_csrf'

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
})

export const registerAuthRoutes = (app: FastifyInstance, db: Db, secure: boolean): void => {
  app.post(
    '/api/login',
    {
      // Rate limited independently of everything else: this is the one endpoint
      // an attacker can hammer without credentials.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' })
      const { username, password } = parsed.data

      const rows = db.select().from(schema.user).where(eq(schema.user.username, username)).all()
      const found = rows[0]

      // Same generic message and comparable work whether or not the user
      // exists, so the response cannot be used to enumerate accounts.
      const ok = found === undefined ? false : await verifyPassword(found.passwordHash, password)
      if (!ok || found === undefined) {
        // 蜂群2计划 P3：审计留痕（失败也留，actor = 尝试的用户名）
        recordAudit(db, { actor: username, kind: 'login_failed', detail: '登录失败' })
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      recordAudit(db, { actor: username, kind: 'login_success', detail: '登录成功' })

      const { token, expiresAt } = issueSession(db, found.id)
      const csrf = randomBytes(24).toString('base64url')
      reply.setCookie(CSRF_COOKIE, csrf, { path: '/', sameSite: 'lax', secure, expires: new Date(expiresAt) })
      return reply
        .setCookie(COOKIE_NAME, token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure,
          expires: new Date(expiresAt),
        })
        .send({ ok: true, username: found.username, mustChangePassword: found.mustChangePassword === 1 })
    },
  )

  app.post('/api/logout', async (request, reply) => {
    revokeSession(db, request.cookies[COOKIE_NAME])
    return reply
      .clearCookie(COOKIE_NAME, { path: '/' })
      .clearCookie(CSRF_COOKIE, { path: '/' })
      .send({ ok: true })
  })

  app.get('/api/me', async (request, reply) => {
    const user = resolveSession(db, request.cookies[COOKIE_NAME])
    if (user === null) return reply.code(401).send({ error: 'unauthorized' })
    return reply.send({ username: user.username, mustChangePassword: user.mustChangePassword })
  })

  /**
   * 蜂群2计划 P3：修改密码 —— 首登强制改密的唯一出口。
   * 强度规则（D2）：新密码 ≥ 10 字符；改成功即清除强制标记。
   */
  app.post('/api/account/password', async (request, reply) => {
    const user = resolveSession(db, request.cookies[COOKIE_NAME])
    if (user === null) return reply.code(401).send({ error: 'unauthorized' })
    const parsed = passwordBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' })
    if (parsed.data.newPassword.length < 10) {
      recordAudit(db, { actor: user.username, kind: 'password_change', detail: '失败：新密码长度不足 10' })
      return reply.code(400).send({ error: 'password_too_short' })
    }
    const rows = db.select().from(schema.user).where(eq(schema.user.id, user.id)).all()
    const found = rows[0]
    if (found === undefined) return reply.code(401).send({ error: 'unauthorized' })
    const ok = await verifyPassword(found.passwordHash, parsed.data.currentPassword)
    if (!ok) {
      recordAudit(db, { actor: user.username, kind: 'password_change', detail: '失败：当前密码不对' })
      return reply.code(403).send({ error: 'invalid_current_password' })
    }
    db.update(schema.user)
      .set({ passwordHash: await hashPassword(parsed.data.newPassword), mustChangePassword: 0 })
      .where(eq(schema.user.id, user.id))
      .run()
    recordAudit(db, { actor: user.username, kind: 'password_change', detail: '成功' })
    return reply.send({ ok: true })
  })
}
