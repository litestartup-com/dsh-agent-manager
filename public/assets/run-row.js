// @ts-check
// UI 收尾 A：任务流纯函数层——任务行拼装与查询串构造。
// DOM 装配在 runs.js；可单测（runs.test.mjs）。
import { ago, esc } from './ui.js'

export const RUN_STATE_DOT = { pending: 'muted', running: 'busy', done: 'ok', failed: 'bad', missed: 'warn' }
export const RUN_STATE_LABEL = { pending: '排队', running: '跑着', done: '做完', failed: '失败', missed: '错过' }
export const TRIGGER_LABEL = { manual: '人工', cron: '定时', api: 'API', capture: '捕捉', brain: '主脑' }

/**
 * 任务行：状态点 / 状态与触发来源文案 / 冲突徽标 / 会话链接。
 * @param {{ agentName: string, trigger: string, state: string, summary?: string | null, error?: string | null, sourceChatId?: string | null, conflict?: string | null, startedAt: number }} r
 * @returns {string}
 */
export const runRow = (r) => {
  const dot = RUN_STATE_DOT[r.state] ?? 'muted'
  const label = RUN_STATE_LABEL[r.state] ?? r.state
  const trigger = TRIGGER_LABEL[r.trigger] ?? r.trigger
  const summary = r.summary ?? r.error ?? ''
  const conflict =
    typeof r.conflict === 'string' && r.conflict !== ''
      ? `<span class="pill-mini warn" title="${esc(r.conflict)}">冲突</span>`
      : ''
  const whenText = r.state === 'running' ? '进行中' : esc(ago(r.startedAt))
  const link =
    r.sourceChatId !== null && r.sourceChatId !== undefined
      ? `<a class="node-link" href="/chat/${encodeURIComponent(r.sourceChatId)}" title="打开这次派活的会话">会话 ›</a>`
      : ''
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title">
        <span class="dot ${dot}"></span>${esc(r.agentName)} <span class="muted">· ${esc(label)} · ${esc(trigger)} · ${whenText}</span> ${conflict}
      </div>
      ${summary !== '' ? `<div class="node-detail">${esc(summary)}</div>` : ''}
    </div>
    ${link !== '' ? `<div class="node-side">${link}</div>` : ''}
  </div>`
}

/**
 * 任务流查询串（纯函数，供测试）：筛选 + 游标，空串 = 第一页默认。
 * @param {{ agentId?: string, state?: string, before?: number | null }} f
 * @returns {string}
 */
export const runsQuery = ({ agentId = '', state = '', before = null } = {}) => {
  const params = new URLSearchParams()
  if (agentId !== '') params.set('agent_id', agentId)
  if (state !== '') params.set('state', state)
  if (Number.isFinite(before) && before > 0) params.set('before', String(before))
  return params.toString()
}
