import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeCreatePayload, hostRunnerConfirmText } from './node-form.js'

test('能力一回归: runner=auto 时省略字段（后端按部署自动判定），显式选择才下发', () => {
  const base = { name: 'worker', port: '3083', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'auto' }), {
    name: 'worker', port: 3083, agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'auto = 不下发 runner')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'process' }), {
    name: 'worker', port: 3083, runner: 'process', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '显式 process 下发')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'docker' }), {
    name: 'worker', port: 3083, runner: 'docker', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '显式 docker 下发')
})

test('能力一回归: 宿主机进程形态的确认文案含整机风险警告', () => {
  const text = hostRunnerConfirmText('ops-agent')
  assert.match(text, /宿主机进程/)
  assert.match(text, /整台机器/)
  assert.match(text, /ops-agent/)
})
