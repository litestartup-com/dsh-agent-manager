/**
 * 对账单一化（A 清单 #2）：镜像/收敛/删除的纯函数面测试。
 * convergeNodes 的 docker 认领路径已有 supervisor/docker-runner 测试覆盖；
 * 这里锁「一个真相源」的语义：insert/update/delete 全部由配置驱动。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { openDb, schema } from '../db/index.js'
import { convergeRuns, mirrorAgentRow, mirrorAgents } from './index.js'

if (process.env.SESSION_SECRET === undefined) process.env.SESSION_SECRET = 'x'.repeat(32)

const configOf = (agents: Record<string, { name?: string; endpoint?: string; workspace?: string }>): ReturnType<typeof loadConfig> => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-config-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, stringify({
    listen: { host: '127.0.0.1', port: 8080 },
    endpoints: { A: { url: 'http://127.0.0.1:3080', driver: 'apiproxy' } },
    agents: Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, {
      name: a.name ?? id, endpoint: a.endpoint ?? 'A', workspace: a.workspace ?? '.',
    }])),
  }), 'utf8')
  try {
    return loadConfig(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const makeDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-db-'))
  return openDb(join(dir, 'test.db')).db
}

test('mirrorAgents: insert / update / delete 全部由配置驱动（单一真相源）', () => {
  const db = makeDb()
  const first = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' }, brain: {} }))
  assert.deepEqual(first, { inserted: 2, updated: 0, deleted: 0 })
  // 幂等重跑：全部变 update（无重复行）。
  const second = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' }, brain: {} }))
  assert.deepEqual(second, { inserted: 0, updated: 2, deleted: 0 })
  // 配置删除 brain → 收敛删除（FK 教训：派生品不记住已删真相）。
  const third = mirrorAgents(db, configOf({ personal: { workspace: 'C:/ws1' } }))
  assert.deepEqual(third, { inserted: 0, updated: 1, deleted: 1 })
  const rows = db.select().from(schema.agent).all()
  assert.deepEqual(rows.map((r) => r.id).sort(), ['personal'])
  assert.equal(rows[0]?.workspacePath, resolve('C:/ws1'), '工作区按 config 解析后的绝对路径镜像')
})

test('mirrorAgentRow: 同 id 第二次调用是 update，不产生重复行', () => {
  const db = makeDb()
  const agent = { id: 'p', name: 'P', workspacePath: 'C:/w', endpoint: 'A', preset: null, gitRemote: null, public: false }
  assert.equal(mirrorAgentRow(db, agent), 'inserted')
  assert.equal(mirrorAgentRow(db, { ...agent, name: 'P2' }), 'updated')
  assert.equal(db.select().from(schema.agent).all().length, 1)
  assert.equal(db.select().from(schema.agent).all()[0]?.name, 'P2')
})

test('convergeRuns: 上一个进程遗留的 pending/running 行收敛为 failed', () => {
  const db = makeDb()
  db.insert(schema.agent).values({ id: 'a', name: 'a', workspacePath: '.', endpoint: 'A', preset: null, gitRemote: null, public: 0, createdAt: Date.now() }).run()
  const base = { agentId: 'a', sourceChatId: null, dshSessionId: null, trigger: 'manual' as const, prompt: 'x', startedAt: Date.now(), endedAt: null, error: null, summary: null, usageTokens: null, costMicroUsd: null, peakCostMicroUsd: null, commitHash: null, changedFiles: null, state: 'running' as const, cronId: null, idempotencyKey: null, conflict: null }
  db.insert(schema.run).values({ id: 'r1', ...base }).run()
  db.insert(schema.run).values({ id: 'r2', ...base, state: 'pending' }).run()
  db.insert(schema.run).values({ id: 'r3', ...base, state: 'done' }).run()
  const marked = convergeRuns(db)
  assert.equal(marked, 2)
  const rows = db.select().from(schema.run).all()
  assert.deepEqual(rows.filter((r) => r.state === 'failed').map((r) => r.id).sort(), ['r1', 'r2'])
  assert.equal(rows.find((r) => r.id === 'r3')?.state, 'done', '已终态行不动')
  assert.match(rows.find((r) => r.id === 'r1')?.error ?? '', /manager restarted/)
})
