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

test('能力四 M4-3: 版本协商——注册带 agentVersion 落库；心跳刷新；列表暴露 agentVersion + managerVersion', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-f', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2', agentVersion: '1.0.0' },
  })
  const { agentId, agentToken } = registered.json() as { agentId: string; agentToken: string }
  let row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(row?.agentVersion, '1.0.0', '注册即报版本')

  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { events: [{ type: 'heartbeat', detail: { agentVersion: '1.1.2' } }] },
  })
  row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(row?.agentVersion, '1.1.2', '心跳刷新版本（自更新后上报新版本）')

  const list = await app.inject({ method: 'GET', url: '/api/agents' })
  const body = list.json() as { agents: Array<{ agentVersion: string | null }>; managerVersion: string }
  assert.equal(body.agents[0]?.agentVersion, '1.1.2')
  assert.match(body.managerVersion, /^\d+\.\d+\.\d+/, '列表带 manager 版本（前端徽标比较用）')
})

test('能力四 M4-3: update 端点——在线机器入队 agent.update 指令（携带双文件 + 校验和）；离线 409', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-g', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const agentId = (registered.json() as { agentId: string }).agentId

  const upd = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/update` })
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.body))
  const cmd = db.select().from(schema.agentCommand).all().find((c) => c.type === 'agent.update')
  assert.ok(cmd !== undefined, '入队 agent.update')
  const payload = JSON.parse(cmd.payload) as { files: Record<string, string>; sha256: string; managerVersion: string }
  assert.equal(typeof payload.files['runtime.mjs'], 'string')
  assert.ok((payload.files['runtime.mjs'] ?? '').length > 1000, 'runtime.mjs 内容随载荷')
  assert.equal(typeof payload.files['agent.mjs'], 'string')
  assert.ok((payload.files['agent.mjs'] ?? '').length > 100, 'agent.mjs 内容随载荷')
  assert.equal(typeof payload.files['update.mjs'], 'string', 'update.mjs 随载荷（入口依赖）')
  const digest = createHash('sha256').update(Object.keys(payload.files).sort().map((name) => `${name}:${payload.files[name]}`).join('\n')).digest('hex')
  assert.equal(payload.sha256, digest, '校验和 = 文件名排序后的 name:内容 拼接摘要')
  assert.ok(audits.includes('agent_update_requested'), '更新请求留痕')

  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() - 120_000 }).where(eq(schema.agentMachine.id, agentId)).run()
  const off = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/update` })
  assert.equal(off.statusCode, 409, '离线机器不投递更新（丢指令）')
})

test('能力四 M4-1: 轮换 agent token——在线才可轮换、旧 token 宽限期可用、ack 后旧 token 失效', async () => {
  const { db } = openDb(':memory:')
  const audits: string[] = []
  const app = buildApp(db, async () => {}, audits)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-d', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const { agentId, agentToken: oldToken } = registered.json() as { agentId: string; agentToken: string }

  const rot = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/rotate` })
  assert.equal(rot.statusCode, 200, JSON.stringify(rot.body))
  assert.ok((rot.json() as { ok: boolean }).ok)
  // 新 token 不回传浏览器——只经 config.deliver 指令投递给 agent（测试从指令载荷取）
  const cmd0 = db.select().from(schema.agentCommand).all().find((c) => c.type === 'config.deliver')
  const newToken = (JSON.parse(cmd0?.payload ?? '{}') as { agentToken?: string }).agentToken
  assert.ok(typeof newToken === 'string' && newToken.length >= 32, '新 token 在指令载荷里')
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(row?.tokenHash, sha256(newToken!), '主 token 换新（只存哈希）')
  assert.equal(row?.prevTokenHash, sha256(oldToken), '旧 token 进宽限位')
  assert.ok(audits.includes('agent_token_rotated'), '轮换留痕')

  const auth = (token: string): Promise<number> =>
    app.inject({ method: 'GET', url: `/api/internal/agents/${agentId}/commands`, headers: { authorization: `Bearer ${token}` } }).then((r) => r.statusCode)
  assert.equal(await auth(newToken!), 200, '新 token 立即可用')
  assert.equal(await auth(oldToken), 200, '旧 token 宽限期内仍可用（防 ack 丢失把机器打砖）')

  // 投递 ack：agent 报 config.deliver 成功 → 宽限位清除 → 旧 token 失效
  const cmd = cmd0
  assert.ok(cmd !== undefined, '轮换 = 入队一条 config.deliver 指令')
  const ack = await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${newToken}` },
    payload: { events: [{ type: 'command_result', commandId: cmd.id, ok: true, result: {} }] },
  })
  assert.equal(ack.statusCode, 200)
  const after = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(after?.prevTokenHash, null, 'ack 后宽限位清除')
  assert.equal(await auth(oldToken), 401, '旧 token 此后失效')
})

test('能力四 M4-1: 离线机器轮换 409 agent_offline；apply 失败回滚回旧 token', async () => {
  const { db } = openDb(':memory:')
  const app = buildApp(db)
  const join = ((await app.inject({ method: 'POST', url: '/api/agents/join' })).json() as { token: string }).token
  const registered = await app.inject({
    method: 'POST',
    url: '/api/internal/agents/register',
    payload: { joinToken: join, hostname: 'srv-e', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2' },
  })
  const { agentId, agentToken: oldToken } = registered.json() as { agentId: string; agentToken: string }
  // 标记离线（lastSeenAt 超出 90s）
  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() - 120_000 }).where(eq(schema.agentMachine.id, agentId)).run()
  const off = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/rotate` })
  assert.equal(off.statusCode, 409, JSON.stringify(off.body))
  assert.equal((off.json() as { error: string }).error, 'agent_offline', '离线拒绝轮换（防打砖）')

  // 恢复在线后轮换，agent 报 apply 失败 → 回滚
  db.update(schema.agentMachine).set({ lastSeenAt: Date.now() }).where(eq(schema.agentMachine.id, agentId)).run()
  const rot = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/rotate` })
  assert.equal(rot.statusCode, 200)
  const cmd = db.select().from(schema.agentCommand).all().find((c) => c.type === 'config.deliver')
  const newToken = (JSON.parse(cmd?.payload ?? '{}') as { agentToken?: string }).agentToken
  // 真实时序：agent 先长轮询领取（delivered）再回报结果
  const claim = await app.inject({
    method: 'GET',
    url: `/api/internal/agents/${agentId}/commands?wait=0`,
    headers: { authorization: `Bearer ${newToken!}` },
  })
  assert.equal(claim.statusCode, 200)
  await app.inject({
    method: 'POST',
    url: `/api/internal/agents/${agentId}/events`,
    headers: { authorization: `Bearer ${newToken!}` },
    payload: { events: [{ type: 'command_result', commandId: cmd!.id, ok: false, result: { message: 'apply failed' } }] },
  })
  const after = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, agentId)).all()[0]
  assert.equal(after?.tokenHash, sha256(oldToken), 'apply 失败回滚主 token')
  assert.equal(after?.prevTokenHash, null)
})
