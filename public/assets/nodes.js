// 节点总览页（蜂群 Q4）：侧栏只放一行汇总 + 异常，全景在这里。
//
// 两个列表：全部节点（托管读监督器状态机，外管读探活）+ 全局最近任务
// 流。15 秒轮询，与侧栏同一数据源 /api/nodes，不另起真相。
import { $, ago, esc, setHtml, apiFetch } from './ui.js'

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
  // 蜂群2计划 P1：DSH 版本与验证版本不符 → 黄标（照跑不装瞎）
  const versionWarn =
    typeof n.dshVersion === 'string' && n.dshVersion !== '' && n.dshCompatible === false
      ? `<span class="pill-mini warn" title="节点 DSH ${esc(n.dshVersion)} 与验证版本不符，契约未经此版本验证">版本告警</span>`
      : ''
  const starting = n.state === 'starting'
  const controls = n.managed
    ? `<div class="node-actions">
        ${
          n.state === 'cold' || n.state === 'offline'
            ? `<button type="button" class="btn-quiet btn-sm" data-node-up="${esc(n.id)}">启动</button>`
            : `<button type="button" class="btn-quiet btn-sm" data-node-down="${esc(n.id)}" ${starting ? 'disabled' : ''}>停止</button>
               <button type="button" class="btn-quiet btn-sm" data-node-restart="${esc(n.id)}" ${starting ? 'disabled' : ''}>重启</button>`
        }
        <button type="button" class="btn-quiet btn-sm" data-node-logs="${esc(n.id)}">日志</button>
        <button type="button" class="btn-quiet btn-sm" data-node-rm="${esc(n.id)}" title="解除托管（磁盘目录保留）">删除</button>
      </div>`
    : '<span class="muted small">外管 · 手动维护</span>'
  return `<div class="node-row" data-node-row="${esc(n.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(n.id)} <span class="muted">· ${esc(label)}</span> ${versionWarn}</div>
      <div class="node-meta">${esc(meta)}${esc(err)}</div>
      <div class="node-detail">agent：${esc(agents)}</div>
    </div>
    ${controls}
  </div>`
}

const runRow = (r) => {
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

// 蜂群 P5.1：节点管控（起/停/重启）+ 日志抽屉。
const nodeAction = async (id, action) => {
  try {
    const response = await apiFetch(`/api/nodes/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      alert(body.detail ?? `操作失败（${response.status}）`)
    }
  } catch (error) {
    alert(`操作失败：${error.message}`)
  }
  await load()
}

let logsNode = null
let logsTimer = null

const refreshLogs = async () => {
  if (logsNode === null) return
  try {
    const response = await apiFetch(`/api/nodes/${encodeURIComponent(logsNode)}/logs`)
    const body = await response.json().catch(() => ({}))
    $('node-logs-body').textContent = typeof body.logs === 'string' && body.logs !== '' ? body.logs : '（暂无输出）'
    $('node-logs-body').scrollTop = $('node-logs-body').scrollHeight
  } catch {
    $('node-logs-body').textContent = '读取日志失败'
  }
}

const openLogs = (id) => {
  logsNode = id
  $('node-logs').hidden = false
  $('node-logs-title').textContent = `节点 ${id} · 日志`
  void refreshLogs()
  if (logsTimer !== null) clearInterval(logsTimer)
  logsTimer = setInterval(() => void refreshLogs(), 5_000)
}

const closeLogs = () => {
  logsNode = null
  $('node-logs').hidden = true
  if (logsTimer !== null) clearInterval(logsTimer)
  logsTimer = null
}

$('nodes-list').addEventListener('click', (event) => {
  const up = event.target.closest('[data-node-up]')
  if (up !== null) return void nodeAction(up.dataset.nodeUp, 'up')
  const down = event.target.closest('[data-node-down]')
  if (down !== null) return void nodeAction(down.dataset.nodeDown, 'down')
  const restart = event.target.closest('[data-node-restart]')
  if (restart !== null) return void nodeAction(restart.dataset.nodeRestart, 'restart')
  const logs = event.target.closest('[data-node-logs]')
  if (logs !== null) return void openLogs(logs.dataset.nodeLogs)
  const rm = event.target.closest('[data-node-rm]')
  if (rm !== null) return void removeNode(rm.dataset.nodeRm)
})

$('node-logs-refresh').addEventListener('click', () => void refreshLogs())
$('node-logs-close').addEventListener('click', closeLogs)

// ---- 蜂群 P5.5：新增节点向导 + 删除 ----

const removeNode = async (id) => {
  if (!window.confirm(`解除节点「${id}」的托管？\n\n- 进程会停止\n- 配置里会删掉「节点 + 它绑定的工作区」两行\n- 磁盘上的目录全部保留`)) return
  try {
    const response = await apiFetch(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      alert(body.detail ?? `删除失败（${response.status}）`)
      return
    }
    await load()
  } catch (error) {
    alert(`删除失败：${error.message}`)
  }
}

$('new-node').addEventListener('click', () => {
  $('node-editor').hidden = false
  $('f-node-name').focus()
})

$('f-cancel').addEventListener('click', () => {
  $('node-editor').hidden = true
})

// 高级设置随节点名实时联动：没被手改过的字段跟着节点名走；手改过（dirty）
// 的字段保持不动，清空才重新跟随。提交时 clean 字段省略，后端按同一规则
// 自动生成——展示与落盘永远一致。
const advancedFields = ['f-agent-id', 'f-agent-name', 'f-agent-workspace']
const advancedDirty = new Set()
// 蜂群2计划 P6：容器模式（docker runner）下默认工作区 = manager 挂载视角路径
let dockerMode = false

for (const id of advancedFields) {
  const el = $(id)
  el.addEventListener('input', () => {
    if (el.value.trim() === '') advancedDirty.delete(id)
    else advancedDirty.add(id)
  })
}

$('f-node-name').addEventListener('input', () => {
  const name = $('f-node-name').value.trim()
  if (!advancedDirty.has('f-agent-id')) $('f-agent-id').value = name
  if (!advancedDirty.has('f-agent-name')) $('f-agent-name').value = name
  if (!advancedDirty.has('f-agent-workspace')) {
    const base = dockerMode ? '/opt/ohdsh/workspaces' : '~/.dsh-ohdsh/workspaces'
    $('f-agent-workspace').value = name === '' ? '' : `${base}/${name}`
  }
})

$('node-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const name = $('f-node-name').value.trim()
  const portRaw = $('f-node-port').value.trim()
  if (name === '') return

  // 工作区总是创建；clean 的字段省略（后端按节点名生成同款默认）。
  const payload = {
    name,
    ...(portRaw === '' ? {} : { port: Number(portRaw) }),
    agent: {
      ...(advancedDirty.has('f-agent-id') ? { id: $('f-agent-id').value.trim() } : {}),
      ...(advancedDirty.has('f-agent-name') ? { name: $('f-agent-name').value.trim() } : {}),
      ...(advancedDirty.has('f-agent-workspace') ? { workspace: $('f-agent-workspace').value.trim() } : {}),
      ...($('f-agent-preset').value.trim() === '' ? {} : { preset: $('f-agent-preset').value.trim() }),
      sandboxMode: $('f-agent-sandbox').value,
    },
  }

  const save = $('f-save')
  save.disabled = true
  save.textContent = '创建中（安装依赖，可能需要一两分钟）…'
  try {
    const response = await apiFetch('/api/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      $('f-warn').textContent = body.detail ?? `创建失败（${response.status}）`
      return
    }
    $('f-warn').textContent =
      body.workspaceWarning === null || body.workspaceWarning === undefined
        ? ''
        : `已创建，但有个提醒：${body.workspaceWarning}`
    $('node-editor').hidden = true
    $('node-form').reset()
    advancedDirty.clear()
    await load()
  } catch (error) {
    $('f-warn').textContent = `创建失败：${error.message}`
  } finally {
    save.disabled = false
    save.textContent = '创建'
  }
})

const load = async () => {
  try {
    const [nodesResponse, runsResponse] = await Promise.all([apiFetch('/api/nodes'), apiFetch('/api/runs')])
    if (!nodesResponse.ok) return
    const { nodes, dockerMode: isDocker } = await nodesResponse.json()
    dockerMode = isDocker === true
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
