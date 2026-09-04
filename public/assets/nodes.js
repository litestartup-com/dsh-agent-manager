// 节点总览页（蜂群 Q4）：侧栏只放一行汇总 + 异常，全景在这里。
//
// 两个列表：全部节点（托管读监督器状态机，外管读探活）+ 全局最近任务
// 流。15 秒轮询，与侧栏同一数据源 /api/nodes，不另起真相。
import { $, ago, esc, setHtml } from './ui.js'

const NODE_STATE_DOT = { live: 'ok', cold: 'muted', starting: 'warn', restarting: 'warn', offline: 'bad' }
const NODE_STATE_LABEL = { live: 'live', cold: '未启动', starting: '启动中', restarting: '重启中', offline: 'offline' }

const RUN_STATE_DOT = { pending: 'muted', running: 'busy', done: 'ok', failed: 'bad', missed: 'warn' }
const RUN_STATE_LABEL = { pending: '排队', running: '跑着', done: '做完', failed: '失败', missed: '错过' }
const TRIGGER_LABEL = { manual: '人工', cron: '定时', api: 'API', capture: '捕捉', brain: '主脑' }

const nodeRow = (n) => {
  const dot = NODE_STATE_DOT[n.state] ?? 'muted'
  const label = NODE_STATE_LABEL[n.state] ?? n.state
  const agents = Array.isArray(n.agents) && n.agents.length > 0 ? n.agents.join(' / ') : '—'
  const meta = [n.managed ? '托管' : '外管', typeof n.pid === 'number' && n.pid !== null ? `pid ${n.pid}` : null]
    .filter(Boolean)
    .join(' · ')
  const err = typeof n.lastError === 'string' && n.lastError !== '' ? ` — ${n.lastError}` : ''
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(n.id)} <span class="muted">· ${esc(label)}</span></div>
      <div class="node-meta">${esc(meta)}${esc(err)}</div>
      <div class="node-detail">agent：${esc(agents)}</div>
    </div>
  </div>`
}

const runRow = (r) => {
  const dot = RUN_STATE_DOT[r.state] ?? 'muted'
  const label = RUN_STATE_LABEL[r.state] ?? r.state
  const trigger = TRIGGER_LABEL[r.trigger] ?? r.trigger
  const summary = r.summary ?? r.error ?? ''
  const whenText = r.state === 'running' ? '进行中' : esc(ago(r.startedAt))
  const link =
    r.sourceChatId !== null && r.sourceChatId !== undefined
      ? `<a class="node-link" href="/chat/${encodeURIComponent(r.sourceChatId)}" title="打开这次派活的会话">会话 ›</a>`
      : ''
  return `<div class="node-row">
    <div class="node-main">
      <div class="node-title">
        <span class="dot ${dot}"></span>${esc(r.agentName)} <span class="muted">· ${esc(label)} · ${esc(trigger)} · ${whenText}</span>
      </div>
      ${summary !== '' ? `<div class="node-detail">${esc(summary)}</div>` : ''}
    </div>
    ${link !== '' ? `<div class="node-side">${link}</div>` : ''}
  </div>`
}

const load = async () => {
  try {
    const [nodesResponse, runsResponse] = await Promise.all([fetch('/api/nodes'), fetch('/api/runs')])
    if (!nodesResponse.ok) return
    const { nodes } = await nodesResponse.json()
    const live = nodes.filter((n) => n.state === 'live').length
    const abnormal = nodes.filter((n) => n.state !== 'live').length
    $('nodes-count').textContent = `${live}/${nodes.length} 正常${abnormal > 0 ? ` · ${abnormal} 个异常` : ''}`
    setHtml(
      'nodes-list',
      nodes.length === 0
        ? '<p class="muted small">没有节点。config 里的 endpoints 为空，或全部节点由外部管理。</p>'
        : nodes.map(nodeRow).join(''),
    )

    if (runsResponse.ok) {
      const { runs } = await runsResponse.json()
      setHtml('runs-list', runs.length === 0 ? '<p class="muted small">还没有任务记录。</p>' : runs.map(runRow).join(''))
    }
    $('nodes-refresh').textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 15 秒自动`
  } catch {
    // 网络失败时保留上一帧，不刷成错误页。
  }
}

void load()
setInterval(() => void load(), 15_000)
