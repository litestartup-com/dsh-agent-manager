// 债务 C3:共享测试 harness——临时目录/makeDb/personalAgent 收敛。
//
// 此前 14+ 个测试文件各自抄一份 makeDb/agentFor,拼写已开始漂移
// (有的 agent 落 DB 有的不落、字段缺 provider/model/sandboxMode)。
// 单一实现 = 单一语义:任何 DB 形状或 ResolvedAgent 字段变化只改这里。
//
// configFor 不入 harness:它的端点形状随 FakeGateway/真 gateway 而变,
// 强行统一反而把「假依赖注入」变成「隐式网络」,留在各测试里更诚实。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedAgent } from './config.js'
import { openDb, schema, type Db } from './db/index.js'

/** 独立临时目录,测试结束由调用方(或进程退出)清理。 */
export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), `${prefix}-`))

/**
 * 开一个带 personal agent 行的文件 DB。
 * 返回目录以便测试访问 DB 文件路径(备份/迁移类用例)。
 */
export const makeDb = (workspace?: string): { db: Db; dir: string; workspace: string } => {
  const dir = tempDir('harness-db')
  const ws = workspace ?? tempDir('harness-ws')
  const { db } = openDb(join(dir, 'test.db'))
  db.insert(schema.agent)
    .values({
      id: 'personal',
      name: 'Personal',
      workspacePath: ws,
      endpoint: 'A',
      preset: null,
      gitRemote: null,
      public: 0,
      createdAt: Date.now(),
    })
    .run()
  return { db, dir, workspace: ws }
}

/** 与 makeDb 落库的 personal 行一致的 ResolvedAgent(端点 A)。 */
export const personalAgent = (workspacePath: string): ResolvedAgent => ({
  id: 'personal',
  name: 'Personal',
  endpoint: 'A',
  workspacePath,
  public: false,
  preset: null,
  gitRemote: null,
  provider: null,
  model: null,
  sandboxMode: null,
  validate: null,
})
