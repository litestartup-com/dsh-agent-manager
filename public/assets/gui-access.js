// @ts-check
// 能力三 v1（2026-09-20）：节点原生 GUI 的隧道命令与卡片——纯函数层，
// DOM 装配留在 nodes.js。可单测（gui-access.test.mjs）。
// 红线：SSH 私钥永不进 manager——卡片只生成「怎么连」的命令，密钥留在用户本机。
import { esc } from './ui.js'

/**
 * 用户在本机终端执行的隧道命令：本地 loopback localPort → 节点宿主机
 * loopback guiPort。ssh 端口 22 时省略 -p。
 * @param {{ sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number }} access
 * @returns {string}
 */
export const guiTunnelCommand = (access) => {
  const portPart = Number(access.sshPort) !== 22 ? ` -p ${Number(access.sshPort)}` : ''
  return `ssh -L 127.0.0.1:${Number(access.localPort)}:127.0.0.1:${Number(access.guiPort)} ${access.sshUser}@${access.sshHost}${portPart}`
}

/**
 * 节点行里的「原生 GUI」卡。guiUrl 由后端按请求拼好（含 0.1.5 token）；
 * null = 节点还没输出 GUI 启动行（未就绪），打开按钮禁用。
 * @param {string} nodeId
 * @param {{ sshUser: string, sshHost: string, sshPort: number, guiPort: number, localPort: number }} access
 * @param {string | null | undefined} guiUrl
 * @returns {string}
 */
export const guiCardHtml = (nodeId, access, guiUrl) => {
  const command = guiTunnelCommand(access)
  const notReady = guiUrl === null || guiUrl === undefined
  const urlAttr = notReady ? '' : ` data-gui-url="${esc(guiUrl)}"`
  return `<div class="node-gui">
    <div class="node-gui-title">原生 GUI <span class="muted small">SSH 隧道 · 密钥在你本机</span></div>
    <code class="node-gui-cmd">${esc(command)}</code>
    <div class="node-actions">
      <button type="button" class="btn-quiet btn-sm" data-gui-copy="${esc(nodeId)}" data-gui-cmd="${esc(command)}">复制命令</button>
      <button type="button" class="btn btn-sm" data-gui-open="${esc(nodeId)}"${urlAttr}${notReady ? ' disabled' : ''}>打开 GUI</button>
      <button type="button" class="btn-quiet btn-sm" data-node-access="${esc(nodeId)}">配置</button>
    </div>
    ${notReady ? '<div class="muted small">节点未就绪——先在终端跑上面的命令；节点输出 GUI 启动行后按钮自动可用。</div>' : ''}
  </div>`
}

/** 未配置 access 的节点：一个「配置原生访问」入口。 */
export const guiSetupButton = (nodeId) =>
  `<button type="button" class="btn-quiet btn-sm" data-node-access="${esc(nodeId)}">配置原生访问</button>`
