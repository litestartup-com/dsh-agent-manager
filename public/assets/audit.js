// 蜂群2计划 P3：审计流水页（只读）。
import { $, apiFetch, esc, setHtml, when } from './ui.js'

const KIND_LABEL = {
  login_success: '登录成功',
  login_failed: '登录失败',
  password_change: '修改密码',
  node_create: '创建节点',
  node_delete: '删除节点',
  node_up: '节点启动',
  node_down: '节点停止',
  node_restart: '节点重启',
  backup: '备份',
}

const row = (e) => `<div class="node-row">
  <div class="node-main">
    <div class="node-title">${esc(KIND_LABEL[e.kind] ?? e.kind)} <span class="muted">· ${esc(e.actor)} · ${esc(when(e.at))}</span></div>
    <div class="node-detail">${esc(e.detail)}</div>
  </div>
</div>`

const load = async () => {
  try {
    const response = await apiFetch('/api/audit')
    if (!response.ok) return
    const { entries } = await response.json()
    setHtml('audit-list', entries.length === 0 ? '<p class="muted small">还没有审计记录。</p>' : entries.map(row).join(''))
    $('audit-refresh').textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  } catch {
    setHtml('audit-list', '<p class="muted small">读取失败</p>')
  }
}

void load()
