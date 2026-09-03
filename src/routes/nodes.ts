import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import { probeEndpoint } from './status.js'

/**
 * 蜂群 P3：节点（fleet）视图数据源。
 *
 * 一个节点 = 一个 endpoint 的实体。托管节点（spawn.managed）的真相是监督器
 * 状态机（cold/starting/live/restarting/offline）；未托管节点的真相是探活
 * 结果（live/offline）。侧栏节点区与未来的 /nodes 页共用这一份。
 */
export const registerNodesRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  supervisors: Map<string, NodeSupervisor>,
  clients: Map<string, GatewayClient>,
  upstreamClients: Map<string, UpstreamClient>,
  requireUser: preHandlerHookHandler,
): void => {
  app.get('/api/nodes', { preHandler: requireUser }, async () => {
    const nodes = await Promise.all(
      Object.keys(config.endpoints).map(async (id) => {
        const agentIds = Object.values(config.agents)
          .filter((a) => a.endpoint === id)
          .map((a) => a.id)
        const supervisor = supervisors.get(id)
        if (supervisor !== undefined) {
          const s = supervisor.current
          return {
            id,
            managed: true,
            state: s.state,
            pid: s.pid,
            attempts: s.attempts,
            lastError: s.lastError,
            agents: agentIds,
          }
        }
        const probe = await probeEndpoint(config, clients, upstreamClients, id)
        return {
          id,
          managed: false,
          state: probe.reachable ? 'live' : 'offline',
          pid: null,
          attempts: 0,
          lastError: probe.reachable ? null : probe.error,
          sessions: probe.sessions,
          agents: agentIds,
        }
      }),
    )
    return { nodes }
  })
}
