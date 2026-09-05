import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { openDb, schema, type Db } from '../db/index.js'
import { hashPassword } from '../auth/password.js'
import { makeRequireUser } from '../auth/hooks.js'
import { listAudit } from '../audit.js'
import { CSRF_COOKIE, registerAuthRoutes } from './auth.js'
import { registerAuditRoutes } from './audit.js'

/**
 * 蜂群2计划 P3：认证/CSRF/强制改密/审计 全链路。
 * CSRF hook 与 index.ts 同款（复制而非复用：hook 属于 boot 装配，单测各自装配）。
 */

const csrfHook = async (app: FastifyInstance): Promise<void> => {
  app.addHook('onRequest', async (request, reply) => {
    const method = request.method ?? 'GET'
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
    const url = (request.url ?? '').split('?')[0] ?? ''
    if (url === '/api/login' || url.startsWith('/api/internal/')) return
    const cookieToken = request.cookies[CSRF_COOKIE] ?? ''
    const headerToken = request.headers['x-csrf-token']
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken
    if (cookieToken === '' || headerValue !== cookieToken) {
      await reply.code(403).send({ error: 'csrf_token_missing_or_mismatch' })
    }
  })
}

const boot = async (): Promise<{ app: FastifyInstance; db: Db }> => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'))
  const { db } = openDb(join(dir, 'test.db'))
  db.insert(schema.user)
    .values({ username: 'admin', passwordHash: await hashPassword('initial-pass'), createdAt: Date.now(), mustChangePassword: 1 })
    .run()
  const app = Fastify()
  await app.register(cookie, { secret: 'x'.repeat(32) })
  await csrfHook(app)
  registerAuthRoutes(app, db, false)
  registerAuditRoutes(app, db, makeRequireUser(db))
  return { app, db }
}

const cookieOf = (response: { headers: unknown }, name: string): string => {
  const header = (response.headers as { 'set-cookie'?: string | string[] })['set-cookie']
  const list = Array.isArray(header) ? header : header === undefined ? [] : [header]
  const line = list.find((c) => c.startsWith(`${name}=`))
  if (line === undefined) return ''
  return line.split(';')[0]?.slice(name.length + 1) ?? ''
}

const login = async (app: FastifyInstance, username: string, password: string) => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password },
  })
  return {
    response,
    sid: cookieOf(response, 'mgr_sid'),
    csrf: cookieOf(response, CSRF_COOKIE),
  }
}

test('蜂群2计划 P3: 登录成功种会话+CSRF cookie，报强制改密，审计留痕', async () => {
  const { app, db } = await boot()
  const { response, sid, csrf } = await login(app, 'admin', 'initial-pass')
  assert.equal(response.statusCode, 200)
  const body = response.json() as { ok: boolean; username: string; mustChangePassword: boolean }
  assert.equal(body.mustChangePassword, true)
  assert.ok(sid !== '')
  assert.ok(csrf !== '')

  const entries = listAudit(db, 10)
  assert.equal(entries[0]?.kind, 'login_success')
  assert.equal(entries[0]?.actor, 'admin')
  await app.close()
})

test('蜂群2计划 P3: 密码错登录失败，审计留痕且不种会话', async () => {
  const { app, db } = await boot()
  const { response, sid } = await login(app, 'admin', 'wrong')
  assert.equal(response.statusCode, 401)
  assert.equal(sid, '')
  assert.equal(listAudit(db, 10)[0]?.kind, 'login_failed')
  await app.close()
})

test('蜂群2计划 P3: 非 GET 请求缺 CSRF 令牌被拒，带一致令牌放行', async () => {
  const { app } = await boot()
  const { sid, csrf } = await login(app, 'admin', 'initial-pass')

  const bare = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal(bare.statusCode, 403)
  assert.equal((bare.json() as { error: string }).error, 'csrf_token_missing_or_mismatch')

  const mismatched = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': 'other' },
  })
  assert.equal(mismatched.statusCode, 403)

  const ok = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf },
  })
  assert.equal(ok.statusCode, 200)
  await app.close()
})

test('蜂群2计划 P3: 强制改密期间业务 API 403，改密成功后放行', async () => {
  const { app } = await boot()
  const { sid, csrf } = await login(app, 'admin', 'initial-pass')
  const headers = { cookie: `mgr_sid=${sid}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf }

  // 改密前：业务 API 被 403 拦截
  const blocked = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal(blocked.statusCode, 403)
  assert.equal((blocked.json() as { error: string }).error, 'password_change_required')

  // 当前密码错 / 新密码太短
  const wrongCurrent = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'nope', newPassword: 'new-password-123' },
  })
  assert.equal(wrongCurrent.statusCode, 403)
  const tooShort = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'initial-pass', newPassword: 'short' },
  })
  assert.equal(tooShort.statusCode, 400)

  // 成功改密 → 清除强制标记 → 业务 API 放行
  const changed = await app.inject({
    method: 'POST',
    url: '/api/account/password',
    headers,
    payload: { currentPassword: 'initial-pass', newPassword: 'new-password-123' },
  })
  assert.equal(changed.statusCode, 200)

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal((me.json() as { mustChangePassword: boolean }).mustChangePassword, false)

  const auditOk = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: `mgr_sid=${sid}` } })
  assert.equal(auditOk.statusCode, 200)
  const { entries } = auditOk.json() as { entries: Array<{ kind: string }> }
  assert.equal(entries[0]?.kind, 'password_change')

  // 旧密码已失效，新密码可登录
  const relogin = await login(app, 'admin', 'new-password-123')
  assert.equal(relogin.response.statusCode, 200)
  await app.close()
})
