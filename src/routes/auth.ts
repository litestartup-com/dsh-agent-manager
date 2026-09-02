import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import { verifyPassword } from '../auth/password.js'
import { COOKIE_NAME, issueSession, resolveSession, revokeSession } from '../auth/session.js'

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
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
      if (!ok || found === undefined) return reply.code(401).send({ error: 'invalid_credentials' })

      const { token, expiresAt } = issueSession(db, found.id)
      return reply
        .setCookie(COOKIE_NAME, token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure,
          expires: new Date(expiresAt),
        })
        .send({ ok: true, username: found.username })
    },
  )

  app.post('/api/logout', async (request, reply) => {
    revokeSession(db, request.cookies[COOKIE_NAME])
    return reply.clearCookie(COOKIE_NAME, { path: '/' }).send({ ok: true })
  })

  app.get('/api/me', async (request, reply) => {
    const user = resolveSession(db, request.cookies[COOKIE_NAME])
    if (user === null) return reply.code(401).send({ error: 'unauthorized' })
    return reply.send({ username: user.username })
  })
}
