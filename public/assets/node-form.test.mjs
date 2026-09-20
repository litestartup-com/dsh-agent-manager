import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeCreatePayload, hostRunnerConfirmText } from './node-form.js'

test('能力一回归: runner=auto 时省略字段（后端按部署自动判定），显式选择才下发', () => {
  const base = { name: 'worker', port: '3083', dshVersion: '', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'auto' }), {
    name: 'worker', port: 3083, agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, 'auto = 不下发 runner；版本空串 = 跟随默认不下发')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'process' }), {
    name: 'worker', port: 3083, runner: 'process', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '显式 process 下发')
  assert.deepEqual(nodeCreatePayload({ ...base, runner: 'docker' }), {
    name: 'worker', port: 3083, runner: 'docker', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '显式 docker 下发')
})

test('能力二回归: 向导选版本 → dsh_version 进载荷；缺省字段不出现', () => {
  const base = { name: 'v15', port: '', runner: 'auto', agent: { preset: 'standard', sandboxMode: 'workspace-write' } }
  assert.deepEqual(nodeCreatePayload({ ...base, dshVersion: '0.1.5-rc.2' }), {
    name: 'v15', dsh_version: '0.1.5-rc.2', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '选中版本下发 dsh_version；空端口省略')
  assert.deepEqual(nodeCreatePayload({ ...base, dshVersion: '' }), {
    name: 'v15', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '空串 = 跟随矩阵首行')
  assert.deepEqual(nodeCreatePayload(base), {
    name: 'v15', agent: { preset: 'standard', sandboxMode: 'workspace-write' },
  }, '缺省字段不出现 dsh_version')
})

test('能力一回归: 宿主机进程形态的确认文案含整机风险警告', () => {
  const text = hostRunnerConfirmText('ops-agent')
  assert.match(text, /宿主机进程/)
  assert.match(text, /整台机器/)
  assert.match(text, /ops-agent/)
})
