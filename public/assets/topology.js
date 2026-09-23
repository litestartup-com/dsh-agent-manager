// @ts-check
// 集群拓扑（UI 收尾 C-P1）：manager → 机器（node-agent）→ 节点（DSH）三列
// 静态拓扑，纯前端聚合 /api/nodes + /api/agents，零新 API、零依赖。
// 卡片拼装与边配对是纯函数（topology.test.mjs 可单测）；SVG 连线只在浏览器
// 里按实测矩形画（drawTopoEdges，DOM 函数）。
import { esc } from './ui.js'
import { machineMetricBits } from './machines.js'

/** 节点形态 tag：host 派发 → agent 远端；有镜像 → 容器工蜂；其余看托管态。 */
export const formTag = (n) => {
  if (typeof n.host === 'string' && n.host !== '') return 'agent 远端'
  if (typeof n.image === 'string' && n.image !== '') return '容器工蜂'
  return n.managed === true ? '宿主机进程' : '外管'
}

/** 机器在线态决定边样式：在线绿实线 / 离线红虚线（revoked 也走虚线）。 */
export const machineAlive = (m) => m.online === true && m.revoked !== true

/**
 * manager 卡片：版本 + 监听面 + 部署形态 + 机器/节点计数。
 * @param {{ managerVersion: string, origin: string, containerForm: boolean, machineCount: number, nodeCount: number }} m
 * @returns {string}
 */
export const managerCardHtml = (m) => {
  const deploy = m.containerForm ? '容器部署' : '裸机部署'
  return `<div class="topo-item topo-manager-card" data-topo-manager>
    <div class="topo-item-head">
      <span class="dot ok"></span><strong>manager</strong>
      <span class="pill-mini">${esc(deploy)}</span>
    </div>
    <div class="topo-item-line muted small">v${esc(m.managerVersion)}</div>
    <div class="topo-item-line muted small">监听 ${esc(m.origin)}</div>
    <div class="topo-item-line muted small">${m.machineCount} 台机器 · ${m.nodeCount} 个节点</div>
  </div>`
}

/**
 * 机器卡片：在线点 + 主机名 + 指标徽标 + 待更新徽标；离线/已吊销进折叠区。
 * @param {{ id: string, hostname: string, os: string, arch: string, nodeVersion: string, online: boolean, revoked: boolean, pendingCommands: number, agentVersion?: string | null, managerVersion?: string, latestMetric?: unknown }} m
 * @param {string} managerVersion
 * @returns {string}
 */
export const machineCardHtml = (m, managerVersion) => {
  const alive = machineAlive(m)
  const stale = typeof m.agentVersion === 'string' && m.agentVersion !== '' && typeof m.managerVersion === 'string' && m.agentVersion !== m.managerVersion
  const metrics = machineMetricBits(m.latestMetric)
  const meta = [m.os, m.arch, `node ${m.nodeVersion}`].filter((v) => typeof v === 'string' && v !== '').join(' · ')
  return `<div class="topo-item ${alive ? '' : 'topo-item-off'}" data-topo-machine="${esc(m.id)}" title="点卡片跳到机器列表行">
    <div class="topo-item-head">
      <span class="dot ${m.revoked ? 'muted' : alive ? 'ok' : 'err'}"></span><strong>${esc(m.hostname)}</strong>
      ${stale ? '<span class="badge warn">待更新</span>' : ''}
      ${m.revoked ? '<span class="pill-mini muted">已吊销</span>' : ''}
    </div>
    <div class="topo-item-line muted small">${esc(meta)}${typeof m.agentVersion === 'string' && m.agentVersion !== '' ? ` · agent v${esc(m.agentVersion)}` : ''}</div>
    ${metrics.length > 0 ? `<div class="topo-item-line muted small">${metrics.map(esc).join(' · ')}</div>` : ''}
  </div>`
}

/**
 * 节点卡片：状态点 + 工作区 + DSH 版本 + 形态 tag；漂移/版本告警同列表口径。
 * @param {{ id: string, state: string, agents?: string[], dshVersion?: string | null, configuredDshVersion?: string | null, dshDrift?: boolean, dshCompatible?: boolean, host?: string | null, image?: string | null, managed: boolean }} n
 * @param {Map<string, string>} hostnameById 机器 id → hostname
 * @returns {string}
 */
export const nodeCardHtml = (n, hostnameById) => {
  const NODE_DOT = { live: 'ok', cold: 'muted', starting: 'warn', restarting: 'warn', offline: 'bad' }
  const agents = Array.isArray(n.agents) && n.agents.length > 0 ? n.agents.join(' / ') : '—'
  const versionWarn =
    typeof n.dshVersion === 'string' && n.dshVersion !== '' && n.dshCompatible === false
      ? '<span class="pill-mini warn" title="DSH 版本与验证版本不符">版本告警</span>'
      : ''
  const driftWarn = n.dshDrift === true ? '<span class="pill-mini warn" title="profile 与配置钉版不一致">版本漂移</span>' : ''
  const bits = []
  if (typeof n.image === 'string' && n.image !== '') bits.push(esc(n.image))
  if (typeof n.dshVersion === 'string' && n.dshVersion !== '') bits.push(`DSH ${esc(n.dshVersion)}`)
  if (typeof n.configuredDshVersion === 'string' && n.configuredDshVersion !== '') bits.push(`钉 ${esc(n.configuredDshVersion)}`)
  const hostBit = typeof n.host === 'string' && n.host !== '' ? ` · 主机 ${esc(hostnameById.get(n.host) ?? n.host)}` : ''
  return `<div class="topo-item" data-topo-node="${esc(n.id)}" title="点卡片跳到节点列表行">
    <div class="topo-item-head">
      <span class="dot ${NODE_DOT[n.state] ?? 'muted'}"></span><strong>${esc(n.id)}</strong>
      <span class="pill-mini">${esc(formTag(n))}</span> ${versionWarn} ${driftWarn}
    </div>
    <div class="topo-item-line muted small">工作区 ${esc(agents)}</div>
    ${bits.length > 0 ? `<div class="topo-item-line muted small">${bits.join(' · ')}${hostBit}</div>` : ''}
  </div>`
}

/**
 * 边的源-目标配对（纯函数，供测试与 drawTopoEdges 共用）：
 * - manager → 每台机器（在线绿实线 / 离线红虚线）
 * - 节点归属机器 → 节点（机器离线则红虚线）；host 不在机器目录（含本机
 *   host=null 的节点）直接从 manager 拉线，按节点状态上色。
 * @param {Array<{ id: string, online: boolean, revoked?: boolean }>} machines
 * @param {Array<{ id: string, state: string, host?: string | null }>} nodes
 * @returns {Array<{ from: string, to: string, on: boolean }>}
 */
export const edgePairs = (machines, nodes) => {
  const byId = new Map(machines.map((m) => [m.id, m]))
  const pairs = []
  for (const m of machines) pairs.push({ from: 'manager', to: `machine:${m.id}`, on: machineAlive(m) })
  for (const n of nodes) {
    const host = typeof n.host === 'string' && n.host !== '' && byId.has(n.host) ? byId.get(n.host) : null
    if (host === null) {
      pairs.push({ from: 'manager', to: `node:${n.id}`, on: n.state === 'live' })
    } else {
      pairs.push({ from: `machine:${host.id}`, to: `node:${n.id}`, on: machineAlive(host) })
    }
  }
  return pairs
}

/**
 * 三列拓扑骨架（DOM 装配的前半段）：manager 列 + 机器列（离线折叠）+ 节点列。
 * @param {{ managerVersion: string, origin: string, containerForm: boolean, machines: any[], nodes: any[] }} data
 * @returns {string}
 */
export const topologyHtml = (data) => {
  const { managerVersion, origin, containerForm, machines, nodes } = data
  const hostnameById = new Map(machines.map((m) => [m.id, m.hostname]))
  const online = machines.filter(machineAlive)
  const offline = machines.filter((m) => !machineAlive(m))
  const manager = managerCardHtml({
    managerVersion,
    origin,
    containerForm,
    machineCount: machines.length,
    nodeCount: nodes.length,
  })
  return `<div class="topo">
    <svg class="topo-edges" aria-hidden="true"></svg>
    <div class="topo-col">
      <div class="topo-col-head">manager</div>
      ${manager}
    </div>
    <div class="topo-col">
      <div class="topo-col-head">机器（node-agent）</div>
      ${online.length === 0 ? '<p class="muted small">没有在线机器</p>' : online.map((m) => machineCardHtml(m, managerVersion)).join('')}
      ${offline.length === 0
        ? ''
        : `<details class="topo-fold"><summary class="muted small">离线/已吊销 ${offline.length} 台</summary>${offline.map((m) => machineCardHtml(m, managerVersion)).join('')}</details>`}
    </div>
    <div class="topo-col">
      <div class="topo-col-head">节点（DSH）</div>
      ${nodes.length === 0 ? '<p class="muted small">没有节点</p>' : nodes.map((n) => nodeCardHtml(n, hostnameById)).join('')}
    </div>
  </div>`
}

/**
 * 按实测矩形画 SVG 连线（仅浏览器；隐藏时跳过）。卡片锚点：源右缘中点 →
 * 目标左缘中点。pair 由调用方用 edgePairs(machines, nodes) 从真实数据算出。
 * @param {HTMLElement} container `.topo` 容器
 * @param {Array<{ from: string, to: string, on: boolean }>} pairs
 */
export const drawTopoEdges = (container, pairs) => {
  if (container.clientWidth === 0) return
  const svg = container.querySelector('.topo-edges')
  if (svg === null) return
  svg.innerHTML = ''
  svg.setAttribute('viewBox', `0 0 ${container.clientWidth} ${container.clientHeight}`)
  svg.setAttribute('width', String(container.clientWidth))
  svg.setAttribute('height', String(container.clientHeight))
  const base = container.getBoundingClientRect()
  const anchor = (el, side) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round((side === 'right' ? r.right : r.left) - base.left), y: Math.round(r.top + r.height / 2 - base.top) }
  }
  const find = (key) => {
    if (key === 'manager') return container.querySelector('[data-topo-manager]')
    const [kind, id] = key.split(':')
    const attr = kind === 'machine' ? 'data-topo-machine' : 'data-topo-node'
    return container.querySelector(`[${attr}="${CSS.escape(id)}"]`)
  }
  const lines = []
  for (const pair of pairs) {
    const fromEl = find(pair.from)
    const toEl = find(pair.to)
    if (fromEl === null || toEl === null) continue
    const a = anchor(fromEl, 'right')
    const b = anchor(toEl, 'left')
    lines.push(`<line class="topo-edge ${pair.on ? 'on' : 'off'}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`)
  }
  svg.innerHTML = lines.join('')
}
