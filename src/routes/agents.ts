import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema, type Db } from '../db/index.js'
import type { AuditKind } from '../audit.js'

/**
 * 能力四（舰队，M1-2）：node-agent 注册链。
 *
 * 两条面（与主脑面 /api/internal 共用前缀但鉴权完全不同）：
 * - `POST /api/agents/join` —— manager 用户面（requireUser）：签发一次性
 *   join token（15 分钟过期、一次即焚，DB 只存哈希）。
 * - `POST /api/internal/agents/register` —— agent 面（无用户会话、Bearer 不适用，
 *   join token 走 body）：换发 agent 身份（agentId + agentToken，token 只存哈希，
 *   明文只出现一次——与 session token 同款纪律）。
 *
 * 网络面：agent 从远端服务器拨号，所以 register 不套主脑面的私网闸——靠
 * 一次性 token + 限流兜底；agentToken 后续的指令/事件通道（M1-3）用 Bearer。
 */

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export const JOIN_TOKEN_TTL_MS = 15 * 60_000

const registerBody = z.object({
  joinToken: z.string().min(1).max(200),
  hostname: z.string().min(1).max(128),
  os: z.string().min(1).max(64),
  arch: z.string().min(1).max(32),
  nodeVersion: z.string().min(1).max(32),
})

/** 按 agentToken 找未吊销的 agent 行；找不到/已吊销 = null（M1-3 通道用）。 */
export const findAgentByToken = (db: Db, token: string): { id: string; hostname: string; os: string; arch: string; nodeVersion: string } | null => {
  const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.tokenHash, hashToken(token))).all()[0]
  if (row === undefined || row.revokedAt !== null) return null
  return { id: row.id, hostname: row.hostname, os: row.os, arch: row.arch, nodeVersion: row.nodeVersion }
}

export const registerAgentsRoutes = (
  app: FastifyInstance,
  db: Db,
  requireUser: preHandlerHookHandler,
  /** 审计回调（wiring 注入；测试可不传）。 */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
): void => {
  // ---- 用户面：签发一次性 join token ----
  app.post(
    '/api/agents/join',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = randomBytes(24).toString('base64url')
      const expiresAt = Date.now() + JOIN_TOKEN_TTL_MS
      db.insert(schema.agentJoinToken).values({
        tokenHash: hashToken(token),
        expiresAt,
        usedAt: null,
        createdAt: Date.now(),
      }).run()
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_join_issued', `join token 签发（${Math.round(JOIN_TOKEN_TTL_MS / 60_000)} 分钟有效）`)
      return reply.send({ token, expiresAt })
    },
  )

  // ---- agent 面：join token 换发 agent 身份 ----
  app.post(
    '/api/internal/agents/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = registerBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: 'joinToken/hostname/os/arch/nodeVersion 必填' })
      const { joinToken, hostname, os, arch, nodeVersion } = parsed.data

      const joinRow = db.select().from(schema.agentJoinToken).where(eq(schema.agentJoinToken.tokenHash, hashToken(joinToken))).all()[0]
      if (joinRow === undefined || joinRow.usedAt !== null || joinRow.expiresAt <= Date.now()) {
        return reply.code(401).send({ error: 'join_token_invalid', hint: 'join token 无效、已使用或已过期——在 manager 重新签发一次性 join token' })
      }
      db.update(schema.agentJoinToken).set({ usedAt: Date.now() }).where(eq(schema.agentJoinToken.tokenHash, hashToken(joinToken))).run()

      const agentId = `agent-${randomBytes(6).toString('hex')}`
      const agentToken = randomBytes(32).toString('base64url')
      db.insert(schema.agentMachine).values({
        id: agentId,
        hostname,
        os,
        arch,
        nodeVersion,
        tokenHash: hashToken(agentToken),
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
      }).run()
      audit?.(agentId, 'agent_registered', `${hostname} ${os}/${arch} node ${nodeVersion}`)
      return reply.send({ agentId, agentToken })
    },
  )

  // ---- 用户面：吊销 agent ----
  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/revoke',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const row = db.select().from(schema.agentMachine).where(eq(schema.agentMachine.id, request.params.id)).all()[0]
      if (row === undefined) return reply.code(404).send({ error: 'unknown_agent' })
      db.update(schema.agentMachine).set({ revokedAt: Date.now() }).where(eq(schema.agentMachine.id, request.params.id)).run()
      audit?.(request.currentUser?.username ?? 'unknown', 'agent_revoked', `agent ${request.params.id}（${row.hostname}）已吊销`)
      return reply.send({ ok: true })
    },
  )
}
