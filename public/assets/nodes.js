// 节点总览页（蜂群 Q4）：侧栏只放一行汇总 + 异常，全景在这里。
//
// 两个列表：全部节点（托管读监督器状态机，外管读探活）+ 全局最近任务
// 流。15 秒轮询，与侧栏同一数据源 /api/nodes，不另起真相。
// 能力三 v1：节点行挂「原生 GUI」卡（隧道命令 + 打开/配置），纯函数层在
// gui-access.js。
import { $, ago, esc, setHtml, apiJson, poll } from './ui.js'
import { guiCardHtml, guiSetupButton } from './gui-access.js'

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
  // 版本信息：容器形态先展示镜像标签（tag 即 DSH 版本），再补 DSH 版本行。
  const versionBits = []
  if (typeof n.image === 'string' && n.image !== '') versionBits.push(esc(n.image))
  if (typeof n.dshVersion === 'string' && n.dshVersion !== '') versionBits.push(`DSH ${esc(n.dshVersion)}`)
  const detail = `agent：${esc(agents)}${versionBits.length > 0 ? ` · ${versionBits.join(' · ')}` : ''}`
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
  // 能力三 v1：原生 GUI 卡（已配置）或配置入口（未配置）。
  const guiBits =
    n.access !== null && n.access !== undefined
      ? `<div class="node-side">${guiCardHtml(n.id, n.access, n.guiUrl)}</div>`
      : `<div class="node-side">${guiSetupButton(n.id)}</div>`
  return `<div class="node-row" data-node-row="${esc(n.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(n.id)} <span class="muted">· ${esc(label)}</span> ${versionWarn}</div>
      <div class="node-meta">${esc(meta)}${esc(err)}</div>
      <div class="node-detail">${detail}</div>
    </div>
    ${controls}
    ${guiBits}
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
    // 债务 F6:统一 Result 层——失败 alert 读 r.detail,不再手拼 body 与状态码。
    const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
    if (!r.ok) alert(r.detail)
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
    const r = await apiJson(`/api/nodes/${encodeURIComponent(logsNode)}/logs`)
    const body = r.ok ? r.data : {}
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
  // 能力三 v1：原生 GUI 卡操作
  const guiOpen = event.target.closest('[data-gui-open]')
  if (guiOpen !== null) {
    const url = guiOpen.dataset.guiUrl
    if (typeof url === 'string' && url !== '') window.open(url, '_blank', 'noopener')
    return
  }
  const guiCopy = event.target.closest('[data-gui-copy]')
  if (guiCopy !== null) {
    const command = guiCopy.dataset.guiCmd ?? ''
    navigator.clipboard
      ?.writeText(command)
      .then(() => alert('隧道命令已复制——在终端跑起来（窗口别关），再点「打开 GUI」。'))
      .catch(() => alert(`复制失败，手动复制：\n${command}`))
    return
  }
  const access = event.target.closest('[data-node-access]')
  if (access !== null) return void openAccessEditor(access.dataset.nodeAccess)
})

$('node-logs-refresh').addEventListener('click', () => void refreshLogs())
$('node-logs-close').addEventListener('click', closeLogs)

// ---- 蜂群 P5.5：新增节点向导 + 删除 ----

const removeNode = async (id) => {
  if (!window.confirm(`解除节点「${id}」的托管？\n\n- 进程会停止\n- 配置里会删掉「节点 + 它绑定的工作区」两行\n- 磁盘上的目录全部保留`)) return
  try {
    // 债务 F6:统一 Result 层。
    const r = await apiJson(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!r.ok) {
      alert(r.detail)
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
    // 债务 F6:统一 Result 层——创建失败提示读 r.detail。
    const r = await apiJson('/api/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      $('f-warn').textContent = r.detail
      return
    }
    const body = r.data
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

// ---- 能力三 v1：原生访问配置（SSH 隧道元数据） ----

/** @type {Record<string, { sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number } | null>} */
let accessById = {}
/** @type {string | null} 编辑器当前编辑的节点 id。 */
let accessNode = null

const openAccessEditor = (id) => {
  accessNode = id
  const current = accessById[id]
  $('f-acc-title').textContent = `配置原生访问 · ${id}`
  $('f-acc-user').value = current?.sshUser ?? ''
  $('f-acc-host').value = current?.sshHost ?? ''
  $('f-acc-sshport').value = current !== null && current !== undefined ? String(current.sshPort) : ''
  $('f-acc-gui').value = current !== null && current !== undefined ? String(current.guiPort) : ''
  $('f-acc-local').value = current !== null && current !== undefined ? String(current.localPort) : ''
  $('f-acc-warn').textContent = ''
  $('node-access-editor').hidden = false
  $('f-acc-user').focus()
}

const closeAccessEditor = () => {
  accessNode = null
  $('node-access-editor').hidden = true
}

$('f-acc-cancel').addEventListener('click', closeAccessEditor)

$('f-acc-clear').addEventListener('click', async () => {
  if (accessNode === null) return
  if (!window.confirm(`清除节点「${accessNode}」的原生访问配置？`)) return
  try {
    const r = await apiJson(`/api/nodes/${encodeURIComponent(accessNode)}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    })
    if (!r.ok) {
      $('f-acc-warn').textContent = r.detail
      return
    }
    closeAccessEditor()
    await load()
  } catch (error) {
    $('f-acc-warn').textContent = `清除失败：${error.message}`
  }
})

$('node-access-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (accessNode === null) return
  const user = $('f-acc-user').value.trim()
  const host = $('f-acc-host').value.trim()
  const local = Number($('f-acc-local').value.trim())
  if (user === '' || host === '' || !Number.isInteger(local) || local <= 0) {
    $('f-acc-warn').textContent = 'SSH 账号 / 主机 / 本机映射端口必填'
    return
  }
  const sshPort = Number($('f-acc-sshport').value.trim())
  const guiPort = Number($('f-acc-gui').value.trim())
  const payload = {
    ssh_user: user,
    ssh_host: host,
    local_port: local,
    ...(Number.isInteger(sshPort) && sshPort > 0 ? { ssh_port: sshPort } : {}),
    ...(Number.isInteger(guiPort) && guiPort > 0 ? { gui_port: guiPort } : {}),
  }
  try {
    const r = await apiJson(`/api/nodes/${encodeURIComponent(accessNode)}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      $('f-acc-warn').textContent = r.detail
      return
    }
    closeAccessEditor()
    await load()
  } catch (error) {
    $('f-acc-warn').textContent = `保存失败：${error.message}`
  }
})

const load = async () => {
  try {
    // 债务 F6:统一 Result 层。
    const [nodesResult, runsResult] = await Promise.all([apiJson('/api/nodes'), apiJson('/api/runs')])
    if (!nodesResult.ok) return
    const { nodes, dockerMode: isDocker } = nodesResult.data
    dockerMode = isDocker === true
    // 能力三 v1：access 真相缓存（编辑器预填用）
    accessById = Object.fromEntries(nodes.map((n) => [n.id, n.access ?? null]))
    const live = nodes.filter((n) => n.state === 'live').length
    const abnormal = nodes.filter((n) => n.state !== 'live').length
    $('nodes-count').textContent = `${live}/${nodes.length} 正常${abnormal > 0 ? ` · ${abnormal} 个异常` : ''}`
    setHtml(
      'nodes-list',
      nodes.length === 0
        ? '<p class="muted small">没有节点。config 里的 endpoints 为空，或全部节点由外部管理。</p>'
        : nodes.map(nodeRow).join(''),
    )

    if (runsResult.ok) {
      const { runs } = runsResult.data
      setHtml('runs-list', runs.length === 0 ? '<p class="muted small">还没有任务记录。</p>' : runs.map(runRow).join(''))
    }
    $('nodes-refresh').textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 15 秒自动`
  } catch {
    // 网络失败时保留上一帧，不刷成错误页。
  }
}

void load()
poll(() => void load(), 15_000)
