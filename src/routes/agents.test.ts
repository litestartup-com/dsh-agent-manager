import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import Fastify, { type preHandlerHookHandler } from 'fastify'
import { openDb, schema, type Db } from '../db/index.js'
import { registerAgentsRoutes } from './agents.js'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const buildApp = (db: Db, requireUser: preHandlerHookHandler = async () => {}, audits: string[] = []): Fastify.FastifyInstance => {
  const app = Fastify()
  registerAgentsRoutes(app, db, requireUser, (_actor, kind) => audits.push(kind))
  return app
}

test('能力四 M1-2: join 生成一次性 token（15 分钟过期；DB 只存哈希）', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)

  const res = await app.inject({ method: 'POST', url: '/api/agents/join' })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const body = res.json() as { token: string; expiresAt: number }
  assert.ok(body.token.length >= 24, 'token 足够长')
  assert.ok(body.expiresAt > Date.now() && body.expiresAt <= Date.now() + 16 * 60_000, '15 分钟过期窗口')

  const rows = db.select().from(schema.agentJoinToken).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.tokenHash, sha256(body.token), '库中只存哈希不存明文')
  assert.ok(audits.includes('agent_join_issued'), '签发留痕')
})

test('能力四 M1-2: register 用一次性 join token 换发 agent 身份（token 哈希落库）', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token

  const res = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-b', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  const body = res.json() as { agentId: string; agentToken: string }
  assert.match(body.agentId, /^agent-/, 'agent id 前缀')
  assert.ok(body.agentToken.length >= 32)

  const rows = db.select().from(schema.agentMachine).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.hostname, 'srv-b')
  assert.equal(rows[0]?.tokenHash, sha256(body.agentToken), 'agent token 只存哈希')
  assert.equal(rows[0]?.revokedAt, null)
  assert.ok(audits.includes('agent_registered'), '注册留痕')

  // 一次性：同一个 join token 再用 = 拒绝
  const again = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'evil', os: 'linux', arch: 'amd64', nodeVersion: '22' },
  })
  assert.equal(again.statusCode, 401, 'join token 一次性')
  assert.equal((again.json() as { error: string }).error, 'join_token_invalid')
})

test('能力四 M1-2: register 拒绝无效/过期 join token；非法载荷 400', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)

  const bad = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: 'nope-not-a-token', hostname: 'x', os: 'linux', arch: 'amd64', nodeVersion: '22' },
  })
  assert.equal(bad.statusCode, 401, '无效 token 拒绝')

  // 过期 token：直接落库一个已过期的
  const expired = 'expired-token-value'
  db.insert(schema.agentJoinToken).values({ tokenHash: sha256(expired), expiresAt: Date.now() - 1_000, usedAt: null, createdAt: Date.now() }).run()
  const exp = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: expired, hostname: 'x', os: 'linux', arch: 'amd64', nodeVersion: '22' },
  })
  assert.equal(exp.statusCode, 401, '过期 token 拒绝')

  const malformed = await app.inject({ method: 'POST', url: '/api/internal/agents/register', payload: { joinToken: 'x' } })
  assert.equal(malformed.statusCode, 400, '缺字段 400')
})

test('能力四 M1-2: revoke 吊销 agent（requireUser 门内；未知 id 404）', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-c', os: 'windows', arch: 'x64', nodeVersion: '22.23.2' },
  })
  const agentId = (registered.json() as { agentId: string }).agentId

  const revoke = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/revoke` })
  assert.equal(revoke.statusCode, 200, JSON.stringify(revoke.body))
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.ok(row !== undefined && row.revokedAt !== null, '吊销落库')
  assert.ok(audits.includes('agent_revoked'), '吊销留痕')

  const missing = await app.inject({ method: 'POST', url: '/api/agents/agent-nope/revoke' })
  assert.equal(missing.statusCode, 404)
})
