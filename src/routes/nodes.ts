import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import type { GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import type { AuditKind } from '../audit.js'
import { mutateYamlFile, withConfigLock } from '../config-store.js'
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
  upstreamClients: Map<string, SessionDriver>,
  requireUser: preHandlerHookHandler,
  /** 蜂群2计划 P3：节点操作审计回调（wiring 层注入，测试可不传）。 */
  audit?: (actor: string, kind: AuditKind, detail: string) => void,
): void => {
  app.get('/api/nodes', { preHandler: requireUser }, async () => {
    const nodes = await Promise.all(
      Object.keys(config.endpoints).map(async (id) => {
        const agentIds = Object.values(config.agents)
          .filter((a) => a.endpoint === id)
          .map((a) => a.id)
        const supervisor = supervisors.get(id)
        const probe = await probeEndpoint(config, clients, upstreamClients, id)
        if (supervisor !== undefined) {
          const s = supervisor.current
          // 容器形态：镜像标签就是节点 DSH 版本的真相（镜像 tag 即 DSH 版本）。
          const image = await supervisor.containerImage()
          return {
            id,
            managed: true,
            state: s.state,
            pid: s.pid,
            attempts: s.attempts,
            lastError: s.lastError,
            agents: agentIds,
            dshVersion: probe.dshVersion,
            dshCompatible: probe.dshCompatible,
            ...(image === null ? {} : { image }),
          }
        }
        return {
          id,
          managed: false,
          state: probe.reachable ? 'live' : 'offline',
          pid: null,
          attempts: 0,
          lastError: probe.reachable ? null : probe.error,
          sessions: probe.sessions,
          agents: agentIds,
          dshVersion: probe.dshVersion,
          dshCompatible: probe.dshCompatible,
        }
      }),
    )
    // 蜂群2计划 P6：向导需要知道部署形态（docker runner 节点默认工作区路径不同）
    const dockerMode = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
    return { nodes, dockerMode }
  })

  /**
   * 蜂群 P5.1：节点管控。只有托管节点（有 spawn 配置 + 监督器在册）能操作；
   * 外部管理的节点友好拒绝——manager 的手伸不到的地方，按钮就不该出现。
   */
  type Managed =
    | { kind: 'ok'; supervisor: NodeSupervisor; spawn: NonNullable<AppConfig['endpoints'][string]['spawn']> }
    | { kind: 'unknown' }
    | { kind: 'unmanaged' }

  const managed = (request: { params: { id: string } }): Managed => {
    const ep = config.endpoints[request.params.id]
    if (ep === undefined) return { kind: 'unknown' }
    if (ep.spawn === null) return { kind: 'unmanaged' }
    const supervisor = supervisors.get(request.params.id)
    if (supervisor === undefined) return { kind: 'unmanaged' }
    return { kind: 'ok', supervisor, spawn: ep.spawn }
  }

  app.post<{ Params: { id: string } }>('/api/nodes/:id/up', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法启动它` })
    }
    target.supervisor.start(target.spawn)
    audit?.(request.currentUser?.username ?? 'unknown', 'node_up', `节点 ${request.params.id} 启动`)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.post<{ Params: { id: string } }>('/api/nodes/:id/down', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法停止它` })
    }
    target.supervisor.stop()
    audit?.(request.currentUser?.username ?? 'unknown', 'node_down', `节点 ${request.params.id} 停止`)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.post<{ Params: { id: string } }>('/api/nodes/:id/restart', { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const target = managed(request)
    if (target.kind === 'unknown') return reply.code(404).send({ error: 'unknown_node' })
    if (target.kind === 'unmanaged') {
      return reply
        .code(409)
        .send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法重启它` })
    }
    target.supervisor.restart(target.spawn)
    audit?.(request.currentUser?.username ?? 'unknown', 'node_restart', `节点 ${request.params.id} 重启`)
    return reply.send({ ok: true, state: target.supervisor.current.state })
  })

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/nodes/:id/logs',
    { preHandler: requireUser },
    async (request, reply) => {
      const ep = config.endpoints[request.params.id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const limit = Math.min(Math.max(Number(request.query.limit ?? 200) || 200, 1), 2000)
      const tail = (text: string): string => text.split(/\r?\n/).slice(-limit).join('\n')

      // 日志文件（detached + log_file 的节点）从文件读；否则读监督器内存缓冲。
      if (ep.spawn?.logFile !== undefined && ep.spawn.logFile !== null) {
        try {
          return reply.send({ logs: tail(readFileSync(ep.spawn.logFile, 'utf8')), source: 'file' })
        } catch (error) {
          // 债务 E11:读失败不再静默返回空串(用户会把「无日志」当成节点没跑,
          // 而真相是权限/IO 错误)——记日志并把原因带回给前端展示。
          const message = error instanceof Error ? error.message : String(error)
          app.log.warn(`node ${request.params.id}: reading log file failed: ${message}`)
          return reply.send({ logs: '', source: 'file', error: `读取日志失败: ${message}` })
        }
      }
      const supervisor = supervisors.get(request.params.id)
      if (supervisor === undefined) {
        return reply.code(409).send({ error: 'not_managed', detail: '外部管理的节点没有日志可供读取' })
      }
      // 蜂群2计划 P2b：docker runner 的节点日志走 docker logs（缓冲里没有进程输出）
      if (ep.spawn?.runner === 'docker') {
        const dockerLogs = await supervisor.dockerLogs()
        if (dockerLogs !== null) return reply.send({ logs: tail(dockerLogs), source: 'docker' })
      }
      return reply.send({ logs: tail(supervisor.logs()), source: 'buffer' })
    },
  )

  /**
   * 能力三 v1：节点原生 GUI 的 SSH 隧道元数据（真相源 = endpoints.<id>.access）。
   * clear=true 移除该段；否则 ssh_user/ssh_host/local_port 必填，ssh_port/gui_port
   * 缺省 22/3080。写真相源（锁 + 原子写）后热加载进内存配置。
   * 红线：ssh 私钥不进本接口——manager 只记「怎么连」，不记「凭什么连」。
   */
  const accessBody = z.object({
    clear: z.boolean().optional(),
    ssh_user: z.string().min(1).optional(),
    ssh_host: z.string().min(1).optional(),
    ssh_port: z.number().int().positive().optional(),
    gui_port: z.number().int().positive().optional(),
    local_port: z.number().int().positive().optional(),
  })

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/nodes/:id/access',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const ep = config.endpoints[request.params.id]
      if (ep === undefined) return reply.code(404).send({ error: 'unknown_node' })
      const parsed = accessBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
      const body = parsed.data
      const configPath = config.configPath ?? resolve('manager.config.yaml')

      try {
        if (body.clear === true) {
          await withConfigLock(() => mutateYamlFile(configPath, (doc) => doc.deleteIn(['endpoints', request.params.id, 'access'])))
          ep.access = null
          audit?.(request.currentUser?.username ?? 'unknown', 'node_access_update', `节点 ${request.params.id} 移除原生访问配置`)
          return reply.send({ ok: true, access: null })
        }
        const sshUser = body.ssh_user
        const sshHost = body.ssh_host
        const localPort = body.local_port
        if (sshUser === undefined || sshHost === undefined || localPort === undefined) {
          return reply.code(400).send({ error: 'missing_fields', detail: 'ssh_user / ssh_host / local_port 必填（clear=true 表示移除）' })
        }
        const access = {
          ssh_user: sshUser,
          ssh_host: sshHost,
          ssh_port: body.ssh_port ?? 22,
          gui_port: body.gui_port ?? 3080,
          local_port: localPort,
        }
        await withConfigLock(() => mutateYamlFile(configPath, (doc) => doc.setIn(['endpoints', request.params.id, 'access'], access)))
        ep.access = {
          sshUser: access.ssh_user,
          sshHost: access.ssh_host,
          sshPort: access.ssh_port,
          guiPort: access.gui_port,
          localPort: access.local_port,
        }
        audit?.(request.currentUser?.username ?? 'unknown', 'node_access_update', `节点 ${request.params.id} 原生访问 → ${access.ssh_user}@${access.ssh_host}:${access.ssh_port} gui=${access.gui_port} local=${access.local_port}`)
        return reply.send({ ok: true, access: ep.access })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        app.log.error(`node ${request.params.id}: access update failed: ${message}`)
        return reply.code(500).send({ error: 'config_write_failed', detail: message })
      }
    },
  )
}
