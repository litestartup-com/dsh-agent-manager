/**
 * Node registry — builds a NodeSupervisor per managed endpoint (蜂群 P1).
 *
 * The probe is the endpoint health check the manager already knows how to run:
 * apiproxy → host.describe (hostVersion), gateway → /health. Nothing in here
 * touches the filesystem or the database; the wiring layer passes in the
 * clients and the logger.
 */

import { NodeSupervisor, type NodeProbeResult } from './supervisor.js'
import type { AppConfig } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'

export interface NodeRegistryDeps {
  gateway: (id: string) => GatewayClient | undefined
  upstream: (id: string) => UpstreamClient | undefined
  log?: (line: string) => void
}

export const buildNodeSupervisors = (config: AppConfig, deps: NodeRegistryDeps): Map<string, NodeSupervisor> => {
  const map = new Map<string, NodeSupervisor>()
  for (const endpoint of Object.values(config.endpoints)) {
    if (endpoint.spawn === null || !endpoint.spawn.managed) continue
    map.set(endpoint.id, new NodeSupervisor(endpoint.id, {
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
    }))
  }
  return map
}
