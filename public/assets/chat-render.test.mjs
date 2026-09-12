// 债务 F1:chat-render 渲染函数测试——帧→HTML 的纯字符串构造(无 DOM),
// 拆分前用测试钉死转义与折叠行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRenderer } from './chat-render.js'

const setup = () =>
  makeRenderer({
    getState: () => ({ agent: { id: 'a1', name: '写手', workspacePath: 'C:\\ws' }, chat: { title: 't' } }),
    openTools: new Set(),
    openContext: new Set(),
  })

test('债务 F1: tokens 千分位缩写与空值', () => {
  const { tokens } = setup()
  assert.equal(tokens(null), null)
  assert.equal(tokens({ inputTokens: 12, outputTokens: 34 }), '12 in · 34 out')
  assert.equal(tokens({ inputTokens: 1500, outputTokens: 999 }), '1.5k in · 999 out')
})

test('债务 F1: questionCard 转义问题文本与选项 label(模型输出进 HTML 必须 esc)', () => {
  const { questionCard } = setup()
  const html = questionCard({
    kind: 'question',
    id: 'q1',
    questions: [
      { id: 'a', question: '<img src=x onerror=alert(1)>', header: '<b>h</b>', options: [{ label: '<script>x</script>', description: '<i>d</i>' }] },
    ],
  })
  assert.ok(!html.includes('<img'), '问题文本必须转义')
  assert.ok(!html.includes('<script>'), '选项 label 必须转义')
  assert.ok(!html.includes('<b>'), 'header 必须转义')
  assert.ok(html.includes('&lt;img'), '转义后应出现实体')
})

test('债务 F1: approvalCard 转义工具名与原因', () => {
  const { approvalCard } = setup()
  const html = approvalCard({ kind: 'approval', id: 'a1', toolName: '<x>', reason: 'y<i>' })
  assert.ok(!html.includes('<x>'))
  assert.ok(!html.includes('<i>'))
})

test('债务 F1: toolsBlock 折叠状态由 openTools 决定,失败默认展开结果', () => {
  const { toolsBlock } = setup()
  const tools = [
    { name: 'read', args: null, raw: '{}', failed: false, done: true, resultText: 'ok' },
    { name: 'write', args: { path: 'a.txt' }, raw: '{"path":"a.txt"}', failed: true, done: true, resultText: 'boom' },
  ]
  const html = toolsBlock(tools, 3)
  assert.ok(html.includes('工具调用 ×2 · 1 个失败'))
  assert.ok(!html.includes('<details class="tools" data-fold="3" open>'), '未展开时不得带 open')
  const opened = makeRenderer({ getState: () => null, openTools: new Set([3]), openContext: new Set() }).toolsBlock(tools, 3)
  assert.ok(opened.includes('data-fold="3" open>'), 'openTools 命中必须带 open')
  assert.ok(html.includes('<details class="tool-result" open>'), '失败结果必须默认展开')
  assert.ok(!html.includes('<details class="tool-result" open>') === false)
})

test('债务 F1: agentTurn 流式时用 streamed,message 后权威 text 胜出', () => {
  const { agentTurn } = setup()
  const streaming = agentTurn({ role: 'agent', text: '', streamed: '预览', streaming: true, reasoning: '', tools: [], usage: null, reason: null, error: null, runId: null, runState: null, awaiting: null }, 0, false)
  assert.ok(streaming.includes('预览'))
  const final = agentTurn({ role: 'agent', text: '最终', streamed: '预览', streaming: false, reasoning: '', tools: [], usage: null, reason: null, error: null, runId: null, runState: null, awaiting: null }, 0, false)
  assert.ok(final.includes('最终'))
  assert.ok(!final.includes('预览'), 'message 后 streamed 必须弃用')
})

test('债务 F1: footer 失败态优先于统计行', () => {
  const { footer } = setup()
  const failed = footer({ role: 'agent', error: '<boom>', streaming: false }, 0, true)
  assert.ok(failed.includes('&lt;boom&gt;'))
  assert.ok(!failed.includes('turn-actions'), '失败态不渲染反馈按钮')
})

test('债务 F1: userTurn 不渲染 markdown,纯文本转义', () => {
  const { userTurn } = setup()
  const html = userTurn({ role: 'user', text: '**加粗** <script>x</script>', injected: false })
  assert.ok(html.includes('**加粗**'), '星号原样保留(用户的话不渲染 markdown)')
  assert.ok(!html.includes('<script>'))
})
