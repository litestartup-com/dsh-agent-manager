import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineRowHtml, joinCommand } from './machines.js'

test('能力四 M1-7: 机器行——在线/离线/吊销/待执行指令各态渲染', () => {
  const base = { id: 'agent-abc123', hostname: 'srv-b', os: 'linux', arch: 'amd64', nodeVersion: '22.23.2', joinedAt: Date.now(), online: true, revoked: false, pendingCommands: 0 }
  assert.ok(machineRowHtml(base).includes('dot ok'), '在线绿点')
  assert.ok(machineRowHtml(base).includes('srv-b'))
  assert.ok(machineRowHtml({ ...base, online: false }).includes('dot err'), '离线红点')
  assert.ok(machineRowHtml({ ...base, online: false }).includes('离线'))
  assert.ok(machineRowHtml({ ...base, revoked: true }).includes('已吊销'), '吊销态文案')
  assert.ok(!machineRowHtml({ ...base, revoked: true }).includes('data-agent-revoke'), '已吊销不显示吊销按钮')
  assert.ok(machineRowHtml({ ...base, pendingCommands: 3 }).includes('3 条待执行指令'))
  assert.ok(machineRowHtml(base).includes('data-agent-revoke="agent-abc123"'))
  assert.ok(machineRowHtml(base).includes('data-agent-rotate="agent-abc123"'), 'M4-1: 未吊销机器显示轮换密钥按钮')
  assert.ok(!machineRowHtml({ ...base, revoked: true }).includes('data-agent-rotate'), '已吊销不显示轮换按钮')
})

test('能力四 M1-7: join 命令——origin 与 token 注入，静态面分发 join.sh', () => {
  const cmd = joinCommand('https://app.example.com', 'ohdsh-join-xyz')
  assert.ok(cmd.includes('https://app.example.com/assets/agent/join.sh'), 'join.sh 走 manager 静态面')
  assert.ok(cmd.includes('MANAGER_URL=https://app.example.com'), 'MANAGER_URL 注入')
  assert.ok(cmd.includes('AGENT_JOIN_TOKEN=ohdsh-join-xyz'), '一次性 token 注入')
  assert.ok(cmd.includes('| MANAGER_URL='), '管道 + env 前缀执行')
  assert.ok(cmd.trimEnd().endsWith(' bash'), 'bash 从 stdin 读脚本')
})
