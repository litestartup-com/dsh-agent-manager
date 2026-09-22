// @ts-check
// 能力一（2026-09-20）：新增节点向导的纯函数层——形态选择（runner）载荷组装
// 与宿主机进程形态的黄字确认文案。DOM 装配留在 nodes.js。

/**
 * 组装 POST /api/nodes 的载荷。runner=auto = 省略字段（后端按部署自动判定
 * 容器/进程形态）；显式选择才下发。dsh_version 空串 = 跟随矩阵首行（省略）。
 * @param {{ name: string, port: string, runner: string, dshVersion: string, agent: Record<string, unknown> }} input
 * @returns {Record<string, unknown>}
 */
export const nodeCreatePayload = (input) => {
  const port = Number(input.port)
  return {
    name: input.name,
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    ...(input.runner === 'auto' ? {} : { runner: input.runner }),
    ...(typeof input.dshVersion === 'string' && input.dshVersion !== '' ? { dsh_version: input.dshVersion } : {}),
    agent: input.agent,
  }
}

/**
 * 宿主机进程形态的确认文案——该节点以本机用户权限运行，可操作整台机器
 * （与 M5 §6 拍板的黄字风险口径一致）。
 * @param {string} name
 * @returns {string}
 */
export const hostRunnerConfirmText = (name) =>
  `把节点「${name}」建成【宿主机进程】形态？\n\n⚠️ 此节点以本机用户权限直接运行，可操作整台机器（文件、终端、安装软件）。\n\n- 依赖装进节点自己的目录（不碰全局 npm）\n- 创建会留下审计记录（node_create_host）\n\n确定继续？`

/**
 * 能力二/P1：节点行「DSH 版本」下拉的 option 列表（纯函数）。
 * 数据源 = GET /api/nodes 的 supportedDsh（矩阵，前端不硬编码版本清单）。
 * @param {Array<{ dsh: string, status: string }>} list
 * @param {string | null | undefined} current 当前配置钉版（null/空 = 跟随默认）
 * @returns {string}
 */
export const versionOptionsHtml = (list, current) => {
  const cur = typeof current === 'string' && current !== '' ? current : ''
  const opts = (Array.isArray(list) ? list : [])
    .map((v) => `<option value="${v.dsh}"${v.dsh === cur ? ' selected' : ''}>${v.dsh}${v.status === 'pending' ? '（未验证）' : ''}</option>`)
    .join('')
  return `<option value=""${cur === '' ? ' selected' : ''}>跟随默认</option>${opts}`
}
