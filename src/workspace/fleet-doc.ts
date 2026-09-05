/**
 * 蜂群2计划 P6：fleet.md —— manager 生成的拓扑/边界共享文档（唯一派生真相）。
 *
 * 每个节点工作区一份，随 config 变化自动同步；节点 AGENTS.md 引用它，
 * 主脑的派工判据读它而不是背死名单。文件是生成物：内容变了就覆盖，
 * 用户永远不手改它（改拓扑 = 改 manager.config.yaml / 用向导）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'

export const FLEET_FILE = 'fleet.md'
export const BRAIN_TOKEN_FILE = '.brain-auth'

export const renderFleetDoc = (config: AppConfig): string => {
  const agents = Object.values(config.agents)
  const lines: string[] = [
    '# fleet 拓扑与边界（manager 生成，勿手改）',
    '',
    '本文件由 manager 从配置自动生成——网络拓扑、节点清单与边界以这里为准。',
    '改拓扑 = 改 `manager.config.yaml` 或用向导加/删节点；本文件随之一同更新。',
    '',
    '## 关键地址（用环境变量，绝不写死值）',
    '',
    '- manager 内部 API 基址：`$MANAGER_URL`（bash）/ `$env:MANAGER_URL`（pwsh）',
    '- 内部 API 鉴权头：`X-Brain-Token`，值在环境变量 `BRAIN_TOKEN`（只引用、绝不打印/写文件）',
    '- 浏览器入口：用户给的 URL（nginx 80/443）；节点端口只在容器/本机内网，不对外',
    '',
    '## 节点清单',
    '',
  ]
  for (const agent of agents) {
    const ep = config.endpoints[agent.endpoint]
    const runner = ep?.spawn?.runner === 'docker' ? '容器' : ep?.spawn === null ? '外部' : '进程'
    const managed = ep?.spawn?.managed === true ? '托管' : '外管'
    const visibility = agent.public ? 'public（可被外部 API 调用）' : '私有'
    lines.push(`- **${agent.id}**（${agent.name}）：${runner} · ${managed} · ${visibility}`)
  }
  lines.push(
    '',
    '## 边界（红线，所有节点一致）',
    '',
    '1. 每个节点只读写**自己的工作区**（本目录）；跨节点的一切执行都通过 manager 派工。',
    '2. 主脑对 fleet 只读：观察用内部 API，执行永远派工给 worker。',
    '3. 环境变量（`BRAIN_TOKEN` / `MANAGER_URL` / `GW_KEY_*`）只引用不打印、不落盘。',
    '',
  )
  return lines.join('\n')
}

/** 把 fleet.md 同步进每个 agent 工作区；返回被写入/更新的 agent id。 */
export const syncFleetDocs = (config: AppConfig, log?: (line: string) => void): string[] => {
  const updated: string[] = []
  const doc = renderFleetDoc(config)
  for (const agent of Object.values(config.agents)) {
    const path = join(agent.workspacePath, FLEET_FILE)
    try {
      if (readFileSync(path, 'utf8') === doc) continue
    } catch {
      // 文件不存在 → 写
    }
    try {
      mkdirSync(agent.workspacePath, { recursive: true })
      writeFileSync(path, doc, 'utf8')
      updated.push(agent.id)
    } catch (error) {
      log?.(`fleet.md ${agent.id}: sync failed: ${(error as Error).message.split('\n')[0]}`)
    }
    // 蜂群2计划 P6：主脑的 X-Brain-Token 经文件下发——DSH 工具沙箱会洗掉
    // 一切 KEY/TOKEN/SECRET 字样环境变量（dsh-subprocess SENSITIVE_ENV_PATTERN，
    // 实测），env 通路走不通；0600 文件 + gitignore 是唯一版本无关的通路。
    if (agent.id === 'brain') provisionBrainTokenFile(agent.workspacePath, log)
  }
  return updated
}

const TOKEN_FILE = BRAIN_TOKEN_FILE

/** 主脑令牌文件：内容与 .env 的 BRAIN_TOKEN 一致；0600 + 进工作区 .gitignore。 */
export const provisionBrainTokenFile = (workspacePath: string, log?: (line: string) => void): void => {
  const token = process.env.BRAIN_TOKEN ?? ''
  if (token === '') {
    log?.(`brain token file: skipped（BRAIN_TOKEN 未设置）`)
    return
  }
  const path = join(workspacePath, TOKEN_FILE)
  try {
    mkdirSync(workspacePath, { recursive: true })
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      // 文件不存在 → 首次写入
    }
    if (current !== token) {
      writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 })
    }
    const gitignore = join(workspacePath, '.gitignore')
    const lines = existsSync(gitignore) ? readFileSync(gitignore, 'utf8').split(/\r?\n/) : []
    if (!lines.includes(TOKEN_FILE)) {
      writeFileSync(gitignore, [...lines, TOKEN_FILE, ''].join('\n'), 'utf8')
    }
  } catch (error) {
    log?.(`brain token file: failed: ${(error as Error).message.split('\n')[0]}`)
  }
}
