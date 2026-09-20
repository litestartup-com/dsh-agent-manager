/**
 * 能力三 v1（2026-09-20）：从节点日志捕获原生 GUI 的启动行与 token。
 *
 * 节点启动时打出 `dsh web: http://127.0.0.1:<port>/?token=...`（0.1.5-rc.2 起
 * 带 bootstrap token，每次重启轮换；0.1.2 及以下只有裸 URL——GUI 无鉴权，
 * 隧道即唯一门禁）。manager 从 process 节点 supervisor.logs() / 容器节点
 * docker logs 拿日志，本函数取**最后一次**出现的启动行 = 当前态。
 */

export interface GuiTokenCapture {
  /** 是否出现过 GUI 启动行（false = 节点还在启动/日志里还没有）。 */
  found: boolean
  /** 0.1.5+ 的 bootstrap token；无 token 时代（0.1.2 及以下）= null。 */
  token: string | null
}

// 两种形态：0.1.5+ `http://127.0.0.1:3080/?token=...`；0.1.2- `http://127.0.0.1:3080`
//（裸 URL 无尾斜杠、无 token——spike 与容器实测两种行都出现过）。
const GUI_LINE = /dsh web: http:\/\/127\.0\.0\.1:\d+(\/\?token=([A-Za-z0-9_-]+))?/

export const captureGuiToken = (logs: string): GuiTokenCapture => {
  let found = false
  let token: string | null = null
  for (const line of logs.split(/\r?\n/)) {
    const match = GUI_LINE.exec(line)
    if (match === null) continue
    found = true
    // 重启轮换：后面出现的行覆盖前面——最后一次即当前态
    token = match[2] ?? null
  }
  return { found, token }
}

/** 拼装浏览器打开 URL：用户本机 loopback 的 localPort + 捕获到的 token。 */
export const guiOpenUrl = (localPort: number, capture: GuiTokenCapture): string | null => {
  if (!capture.found) return null
  const base = `http://127.0.0.1:${localPort}/`
  return capture.token === null ? base : `${base}?token=${encodeURIComponent(capture.token)}`
}
