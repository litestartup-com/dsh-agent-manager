// @ts-check
// 能力四（舰队 M1-7）：机器页纯函数层——agent 列表行与 join 命令拼装。
// DOM 装配在 nodes.js；可单测（machines.test.mjs）。
import { esc } from './ui.js'

/**
 * M4-4：最新指标快照徽标文案（CPU % / 内存 % / 磁盘 %）；无快照返回空数组。
 * 机器列表与集群拓扑共用同一换算（×10 整数、占比四舍五入）。
 * @param {{ cpuPercent?: number | null, memTotal?: number | null, memUsed?: number | null, diskTotal?: number | null, diskFree?: number | null } | null | undefined} lm
 * @returns {string[]}
 */
export const machineMetricBits = (lm) => {
  if (lm === null || lm === undefined) return []
  const pct = (used, total) => (typeof used === 'number' && typeof total === 'number' && total > 0 ? Math.round((used / total) * 100) : null)
  return [
    typeof lm.cpuPercent === 'number' ? `CPU ${lm.cpuPercent / 10}%` : null,
    pct(lm.memUsed, lm.memTotal) !== null ? `内存 ${pct(lm.memUsed, lm.memTotal)}%` : null,
    pct(lm.diskTotal - lm.diskFree, lm.diskTotal) !== null ? `磁盘 ${pct(lm.diskTotal - lm.diskFree, lm.diskTotal)}%` : null,
  ].filter(Boolean)
}

/**
 * 机器（agent）行：在线点 / 吊销态 / 待执行指令数 / 待更新徽标（M4-3）。
 * @param {{ id: string, hostname: string, os: string, arch: string, nodeVersion: string, joinedAt: number, online: boolean, revoked: boolean, pendingCommands: number, agentVersion?: string | null, managerVersion?: string }} m
 * @returns {string}
 */
export const machineRowHtml = (m) => {
  const dot = m.revoked ? 'muted' : m.online ? 'ok' : 'err'
  const when = new Date(m.joinedAt).toLocaleString('zh-CN', { hour12: false })
  const stale = typeof m.agentVersion === 'string' && m.agentVersion !== '' && typeof m.managerVersion === 'string' && m.agentVersion !== m.managerVersion
  const metricBits = machineMetricBits(m.latestMetric)
  const detail = [
    m.online ? '在线' : '离线',
    `注册于 ${when}`,
    m.pendingCommands > 0 ? `${m.pendingCommands} 条待执行指令` : null,
    typeof m.agentVersion === 'string' && m.agentVersion !== '' ? `agent v${m.agentVersion}` : null,
    ...metricBits,
    m.revoked ? '已吊销' : null,
  ].filter(Boolean).join(' · ')
  return `<div class="node-row" data-machine-row="${esc(m.id)}">
    <div class="node-main">
      <div class="node-title"><span class="dot ${dot}"></span>${esc(m.hostname)} <span class="muted">· ${esc(m.os)}/${esc(m.arch)} · node ${esc(m.nodeVersion)}</span>${stale ? ' <span class="badge warn">待更新</span>' : ''}</div>
      <div class="node-detail">${esc(detail)}</div>
    </div>
    <div class="node-actions">
      ${m.revoked
        ? `<button type="button" class="btn-quiet btn-sm" data-agent-delete="${esc(m.id)}">删除记录</button>`
        : `<button type="button" class="btn-quiet btn-sm" data-agent-rotate="${esc(m.id)}">轮换密钥</button>`}
      ${m.revoked ? '' : `<button type="button" class="btn-quiet btn-sm" data-agent-revoke="${esc(m.id)}">吊销</button>`}
    </div>
  </div>`
}

/**
 * join 命令（Linux 一条命令加入）：join.sh 由 manager 静态面分发，
 * MANAGER_URL 与一次性 token 走环境变量注入。
 * @param {string} origin manager 站点源（如 https://app.example.com）
 * @param {string} token 一次性 join token
 * @returns {string}
 */
export const joinCommand = (origin, token) =>
  `curl -fsSL ${origin}/assets/agent/join.sh | MANAGER_URL=${origin} AGENT_JOIN_TOKEN=${token} bash`
