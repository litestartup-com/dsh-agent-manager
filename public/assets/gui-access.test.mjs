import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guiTunnelCommand, guiCardHtml, guiSetupButton } from './gui-access.js'

const ACCESS = { sshUser: 'ubuntu', sshHost: '10.0.0.5', sshPort: 22, guiPort: 3080, localPort: 3088 }

test('债务 P1 回归: 隧道命令——默认 22 端口省略 -p，其余字段照拼', () => {
  assert.equal(guiTunnelCommand(ACCESS), 'ssh -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5')
  assert.equal(
    guiTunnelCommand({ ...ACCESS, sshPort: 2222, guiPort: 3082, localPort: 4090 }),
    'ssh -L 127.0.0.1:4090:127.0.0.1:3082 ubuntu@10.0.0.5 -p 2222',
  )
})

test('债务 P1 回归: GUI 卡——命令+打开按钮；guiUrl 为空时按钮禁用并提示', () => {
  const ready = guiCardHtml('brain', ACCESS, 'http://127.0.0.1:3088/?token=tok-1')
  assert.ok(ready.includes('ssh -L 127.0.0.1:3088:127.0.0.1:3080 ubuntu@10.0.0.5'), '卡片含隧道命令')
  assert.ok(ready.includes('data-gui-open="brain"'), '打开按钮挂节点 id')
  assert.ok(ready.includes('http://127.0.0.1:3088/?token=tok-1'), '打开 URL 拼入')
  assert.ok(!ready.includes('disabled'), '有 guiUrl 时按钮不禁用')

  const booting = guiCardHtml('brain', ACCESS, null)
  assert.ok(booting.includes('disabled'), '节点未就绪时打开按钮禁用')
  assert.ok(booting.includes('节点未就绪'), '未就绪有提示')
})

test('债务 P1 回归: 未配置 access 的节点显示「配置原生访问」入口', () => {
  const html = guiSetupButton('personal')
  assert.ok(html.includes('data-node-access="personal"'), '配置入口挂节点 id')
  assert.ok(html.includes('配置原生访问'), '文案')
})
