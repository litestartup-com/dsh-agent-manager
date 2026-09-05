/**
 * Node registry — builds a NodeSupervisor per managed endpoint (蜂群 P1).
 *
 * The probe is the endpoint health check the manager already knows how to run:
 * apiproxy → host.describe (hostVersion), gateway → /health. Nothing in here
 * touches the filesystem or the database; the wiring layer passes in the
 * clients and the logger.
 */

import { NodeSupervisor, type NodeProbeResult } from './supervisor.js'
import type { DockerRunner } from './docker-runner.js'
import type { AppConfig, ResolvedEndpoint } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'

export interface NodeRegistryDeps {
  gateway: (id: string) => GatewayClient | undefined
  upstream: (id: string) => UpstreamClient | undefined
  log?: (line: string) => void
  /** 蜂群2计划 P2b：docker runner（有 runner=docker 的 endpoint 才需要）。 */
  docker?: DockerRunner
}

/** 蜂群 P5.5：单节点监督器构造（boot 全量构建与运行时热加载共用）。 */
export const makeSupervisor = (endpoint: ResolvedEndpoint, deps: NodeRegistryDeps): NodeSupervisor =>
  new NodeSupervisor(endpoint.id, {
    probe: async (): Promise<NodeProbeResult> => {
      try {
        if (endpoint.driver === 'apiproxy') {
          const version = await deps.upstream(endpoint.id)?.hostVersion()
          return version === undefined || version === 'unknown'
            ? { ok: false, detail: 'host.describe returned no version' }
            : { ok: true, detail: `host.describe ok (${version})` }
        }
        const health = await deps.gateway(endpoint.id)?.health()
        return health !== undefined && health.status === 'ok'
          ? { ok: true, detail: 'gateway health ok' }
          : { ok: false, detail: 'gateway health not ok' }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    log: deps.log,
    docker: deps.docker,
    // 蜂群2计划 P2b：节点容器的环境 —— GW_KEY 走 gateway 沙箱密钥（与 settings
    // 注入一致），模型 key 走继承环境（DSH 凭据分层里优先级最高）。
    // MANAGER_URL：主脑技能手册调内部 API 用（容器里 127.0.0.1 是节点自己，不是 manager）。
    dockerEnv: () => ({
      DSH_HOME: '/data',
      GW_KEY: endpoint.sandboxKey,
      MANAGER_URL: 'http://manager:8080',
      ...(process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== ''
        ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
        : {}),
    }),
  })

export const buildNodeSupervisors = (config: AppConfig, deps: NodeRegistryDeps): Map<string, NodeSupervisor> => {
  const map = new Map<string, NodeSupervisor>()
  for (const endpoint of Object.values(config.endpoints)) {
    // 蜂群2计划 P2b：docker runner 的节点也是托管节点（manager 经 socket 拉容器）
    if (endpoint.spawn === null || !endpoint.spawn.managed) continue
    map.set(endpoint.id, makeSupervisor(endpoint, deps))
  }
  return map
}
