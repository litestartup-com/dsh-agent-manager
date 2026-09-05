import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import type { AppConfig, ResolvedEndpoint, ResolvedSpawnSpec } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import type { UpstreamClient } from '../upstream/client.js'
import { buildUpstreamClients } from '../upstream/client.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import type { DockerRunner } from '../nodes/docker-runner.js'
import { makeSupervisor } from '../nodes/registry.js'
import { detectDshBin, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, resolveGatewayKey } from '../cli/setup.js'
import { ensureWorkspaceGit } from '../workspace/init.js'
import { recordAudit } from '../audit.js'

/**
 * 蜂群 P5.5：运行时新增 / 删除节点。
 *
 * 原则：文件即真相 + 只增热加载。落盘顺序 = profile → 密钥 → .env →
 * manager.config.yaml，**最后才动内存**；中途任何一步失败即回滚（删节点
 * 目录），配置与内存都保持原样。删除 = 解除托管（不删磁盘目录），要求
 * 节点上没有 agent（迁移是后话）。
 */

const GATEWAY_DEP = 'github:litestartup-com/dsh-api-gateway'
const CONFIG_PATH = 'manager.config.yaml'
const ENV_PATH = '.env'

const nodeNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/, '节点名只能是小写字母/数字/下划线/连字符')
const provisionBody = z.object({
  name: nodeNameSchema,
  port: z.number().int().positive().optional(),
  /** 测试与离线环境：跳过 pnpm install。 */
  install: z.boolean().optional(),
  /**
   * 向导总是带着 agent（节点 = agent 节点，创建即配工作区）；字段都可省，
   * 缺省 = id/名称同节点名、路径 ~/.dsh-ohdsh/workspaces/<节点名>。
   */
  agent: z
    .object({
      id: nodeNameSchema.optional(),
      name: z.string().min(1).max(80).optional(),
      workspace: z.string().optional(),
      preset: z.string().optional(),
      sandboxMode: z.enum(['read-only', 'workspace-write']).optional(),
    })
    .optional(),
})

const userHome = (): string => process.env.USERPROFILE ?? process.env.HOME ?? '.'
/** 节点目录根；测试可用 DSH_OHDSH_NODES_HOME 覆盖。 */
const nodesHome = (): string => process.env.DSH_OHDSH_NODES_HOME ?? `${userHome()}/.dsh-ohdsh`

const usedPorts = (config: AppConfig): Set<number> => {
  const ports = new Set<number>([config.listen.port])
  for (const ep of Object.values(config.endpoints)) {
    try {
      ports.add(Number(new URL(ep.url).port))
    } catch {
      // 解析不出的 url 不参与占位判断
    }
  }
  return ports
}

const suggestPort = (config: AppConfig): number => {
  const used = usedPorts(config)
  let port = 3090
  while (used.has(port)) port += 1
  return port
}

/** 新节点的 spawn 规格（与写入 yaml 的值一一对应，热加载用）。 */
const spawnFor = (dshBin: string, name: string, nodeHomePath: string): ResolvedSpawnSpec => ({
  managed: true,
  command: 'node',
  args: [dshBin, '--profile', name, '--no-open'],
  cwd: null,
  readyTimeoutMs: 30_000,
  detached: false,
  logFile: null,
  env: { DSH_HOME: nodeHomePath },
  restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  runner: 'process',
  docker: null,
})

interface ProvisionDeps {
  db: Db
  supervisors: Map<string, NodeSupervisor>
  clients: Map<string, GatewayClient>
  upstreamClients: Map<string, UpstreamClient>
  /** 蜂群2计划 P6：容器模式新增节点需要（docker runner 接线）。 */
  docker?: DockerRunner
}

/**
 * 容器模式：从既有 docker 端点的 host_volumes 推导宿主机工作区前缀
 * （install.sh 已把宿主路径钉成真实绝对路径），新节点沿用同一前缀。
 */
const deriveHostWorkspacePath = (config: AppConfig, nodeId: string, workspacePath: string | undefined): string => {
  const containerPath = workspacePath ?? `/opt/ohdsh/workspaces/${nodeId}`
  for (const ep of Object.values(config.endpoints)) {
    if (ep.spawn?.runner !== 'docker' || ep.spawn.docker === null) continue
    for (const [host, mounted] of Object.entries(ep.spawn.docker.hostVolumes)) {
      if (mounted.startsWith('/opt/ohdsh/workspaces/')) {
        const tail = mounted.slice(mounted.lastIndexOf('/'))
        if (host.endsWith(tail)) return host.slice(0, -tail.length) + '/' + nodeId
        return host
      }
    }
  }
  // 兜底：同串路径（宿主侧可能不存在——workspaceWarning 会提醒）
  return containerPath
}

export const registerProvisionRoutes = (
  app: FastifyInstance,
  config: AppConfig,
  requireUser: preHandlerHookHandler,
  deps: ProvisionDeps,
): void => {
  const { db, supervisors, upstreamClients } = deps

  app.post<{ Body: unknown }>('/api/nodes', { preHandler: requireUser }, async (request, reply) => {
    const parsed = provisionBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues.map((i) => i.message) })
    }
    const body = parsed.data

    if (config.endpoints[body.name] !== undefined) {
      return reply.code(409).send({ error: 'duplicate_node', detail: `节点 ${body.name} 已存在` })
    }
    // 归一化工作区规格：缺省值全部由节点名推导（与向导展示的默认一致）。
    // 蜂群2计划 P6：容器模式（任何既有 endpoint 用 docker runner）下新节点同形态，
    // 工作区默认落在 manager 挂载视角 /opt/ohdsh/workspaces/<名>。
    const dockerMode = Object.values(config.endpoints).some((e) => e.spawn?.runner === 'docker')
    const workspaceDefault = dockerMode
      ? `/opt/ohdsh/workspaces/${body.name}`
      : join(nodesHome(), 'workspaces', body.name)
    const agentSpec =
      body.agent === undefined
        ? null
        : {
            id: body.agent.id ?? body.name,
            name: body.agent.name ?? body.name,
            workspace: resolve(body.agent.workspace ?? workspaceDefault),
            preset: body.agent.preset ?? 'standard',
            sandboxMode: body.agent.sandboxMode ?? 'workspace-write',
          }
    if (agentSpec !== null && config.agents[agentSpec.id] !== undefined) {
      return reply.code(409).send({ error: 'duplicate_agent', detail: `工作区 "${agentSpec.id}" 已存在` })
    }
    const port = body.port ?? suggestPort(config)
    if (usedPorts(config).has(port)) {
      return reply.code(409).send({ error: 'port_taken', detail: `端口 ${port} 已被占用（manager 或现有节点）` })
    }

    const nodeHomePath = join(nodesHome(), body.name)
    const keyRef = `GW_KEY_${body.name.toUpperCase()}`
    let createdHome: string | null = null

    try {
      // 蜂群2计划 P6：容器模式分支——节点 = docker runner 工蜂（镜像 + 命名卷 +
      // 网络别名），不找 DSH bin、不做 profile/pnpm（运行时零安装）。
      if (dockerMode) {
        const key = 'apigw-' + randomBytes(24).toString('hex')
        mergeEnv(ENV_PATH, { [keyRef]: key }, [keyRef])

        let workspaceWarning: string | null = null
        if (agentSpec !== null) {
          mkdirSync(agentSpec.workspace, { recursive: true })
          const git = ensureWorkspaceGit(agentSpec.workspace, agentSpec.name)
          workspaceWarning = git.warning
        }

        // 宿主机侧工作区路径：从既有 docker 端点的 host_volumes 推导前缀
        // （install.sh 已把示例里的宿主路径钉成真实路径，这里照抄同一前缀）。
        const hostKey = deriveHostWorkspacePath(config, body.name, agentSpec?.workspace)

        const dockerSpec = {
          image: process.env.DSH_NODE_IMAGE ?? 'ohdsh/dsh-node:0.1.1-rc.2',
          network: 'ohdsh-hive',
          port,
          host_volumes: { [hostKey]: agentSpec?.workspace ?? workspaceDefault },
          named_volumes: { [`ohdsh-${body.name}`]: '/data' },
        }

        const yaml = parseYaml(readFileSync(resolve(CONFIG_PATH), 'utf8')) as Record<string, Record<string, unknown>>
        const endpoints = (yaml.endpoints ??= {}) as Record<string, unknown>
        const agents = (yaml.agents ??= {}) as Record<string, unknown>
        endpoints[body.name] = {
          url: `http://node-${body.name}:${port}`,
          driver: 'apiproxy',
          prefix: '/api',
          key_ref: '',
          sandbox_base: `http://node-${body.name}:${port}/api-gw/v1`,
          sandbox_key_ref: keyRef,
          spawn: {
            managed: true,
            runner: 'docker',
            ready_timeout_ms: 30_000,
            docker: dockerSpec,
          },
        }
        if (agentSpec !== null) {
          agents[agentSpec.id] = {
            name: agentSpec.name,
            endpoint: body.name,
            workspace: agentSpec.workspace,
            public: false,
            preset: agentSpec.preset,
            sandbox_mode: agentSpec.sandboxMode,
          }
        }
        writeFileSync(resolve(CONFIG_PATH), stringifyYaml(yaml), 'utf8')

        const spawn: ResolvedSpawnSpec = {
          managed: true,
          command: '',
          args: [],
          cwd: null,
          readyTimeoutMs: 30_000,
          detached: false,
          logFile: null,
          env: {},
          restart: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
          runner: 'docker',
          docker: {
            image: dockerSpec.image,
            containerName: null,
            network: dockerSpec.network,
            port,
            hostVolumes: dockerSpec.host_volumes,
            namedVolumes: dockerSpec.named_volumes,
          },
        }
        const endpoint: ResolvedEndpoint = {
          id: body.name,
          url: `http://node-${body.name}:${port}`,
          driver: 'apiproxy',
          prefix: '/api',
          key: '',
          sandboxBase: `http://node-${body.name}:${port}/api-gw/v1`,
          sandboxKey: key,
          spawn,
        }
        config.endpoints[body.name] = endpoint
        const fresh = buildUpstreamClients({ [body.name]: endpoint })
        const upstream = fresh.get(body.name)
        if (upstream !== undefined) upstreamClients.set(body.name, upstream)
        const supervisor = makeSupervisor(endpoint, {
          upstream: (id) => upstreamClients.get(id),
          gateway: () => deps.clients.get(body.name),
          log: (line) => app.log.info(line),
          docker: deps.docker,
        })
        supervisors.set(body.name, supervisor)
        supervisor.start(endpoint.spawn!)

        if (agentSpec !== null) {
          config.agents[agentSpec.id] = {
            id: agentSpec.id,
            name: agentSpec.name,
            endpoint: body.name,
            workspacePath: agentSpec.workspace,
            public: false,
            preset: agentSpec.preset,
            sandboxMode: agentSpec.sandboxMode,
            gitRemote: null,
            provider: null,
            model: null,
          }
        }

        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `节点 ${body.name}（docker 工蜂，端口 ${port}，工作区 ${agentSpec?.workspace ?? '—'}）` })
        return reply.code(201).send({
          node: { id: body.name, port, home: `ohdsh-${body.name}` },
          workspace: agentSpec === null ? null : { id: agentSpec.id, path: agentSpec.workspace },
          workspaceWarning,
        })
      }

      const dshBin = detectDshBin(join(userHome(), '.dsh'), null)

      // 1. 节点三件套：profile → 凭据 → gateway 密钥（文件层）
      ensureNodeProfiles(nodesHome(), [{ name: body.name, port }], GATEWAY_DEP)
      createdHome = nodeHomePath
      ensureNodeCredentials(join(userHome(), '.dsh'), nodeHomePath)
      const key = resolveGatewayKey(nodeHomePath, null)
      mergeEnv(ENV_PATH, { [keyRef]: key }, [keyRef])

      // 2. 依赖安装（同步；pnpm store 命中时通常几十秒）
      if (body.install !== false) {
        const dir = join(nodeHomePath, 'profiles', body.name)
        execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install', '--prefer-offline'], {
          cwd: dir,
          shell: true,
          stdio: ['ignore', 'inherit', 'inherit'],
        })
      }

      // 3. 工作区：目录 + git init + 通用 AGENTS.md（文件即真相，运行才有审计）
      let workspaceWarning: string | null = null
      if (agentSpec !== null) {
        mkdirSync(agentSpec.workspace, { recursive: true })
        const git = ensureWorkspaceGit(agentSpec.workspace, agentSpec.name)
        workspaceWarning = git.warning
      }

      // 4. 写回 manager.config.yaml（文件即真相；成功后才动内存）
      const yaml = parseYaml(readFileSync(resolve(CONFIG_PATH), 'utf8')) as Record<string, Record<string, unknown>>
      const endpoints = (yaml.endpoints ??= {}) as Record<string, unknown>
      const agents = (yaml.agents ??= {}) as Record<string, unknown>
      endpoints[body.name] = {
        url: `http://127.0.0.1:${port}`,
        driver: 'apiproxy',
        prefix: '/api',
        key_ref: '',
        sandbox_base: `http://127.0.0.1:${port}/api-gw/v1`,
        sandbox_key_ref: keyRef,
        spawn: {
          managed: true,
          command: 'node',
          args: [dshBin, '--profile', body.name, '--no-open'],
          ready_timeout_ms: 30_000,
          env: { DSH_HOME: nodeHomePath },
        },
      }
      if (agentSpec !== null) {
        agents[agentSpec.id] = {
          name: agentSpec.name,
          endpoint: body.name,
          workspace: agentSpec.workspace,
          public: false,
          preset: agentSpec.preset,
          sandbox_mode: agentSpec.sandboxMode,
        }
      }
      writeFileSync(resolve(CONFIG_PATH), stringifyYaml(yaml), 'utf8')

      // 5. 热加载：endpoint + 工作区进内存配置，监督器入册并拉起
      const endpoint: ResolvedEndpoint = {
        id: body.name,
        url: `http://127.0.0.1:${port}`,
        driver: 'apiproxy',
        prefix: '/api',
        key: '',
        sandboxBase: `http://127.0.0.1:${port}/api-gw/v1`,
        sandboxKey: key,
        spawn: spawnFor(dshBin, body.name, nodeHomePath),
      }
      config.endpoints[body.name] = endpoint
      const fresh = buildUpstreamClients({ [body.name]: endpoint })
      const upstream = fresh.get(body.name)
      if (upstream !== undefined) upstreamClients.set(body.name, upstream)

      const supervisor = makeSupervisor(endpoint, {
        upstream: (id) => upstreamClients.get(id),
        gateway: () => deps.clients.get(body.name),
        log: (line) => app.log.info(line),
      })
      supervisors.set(body.name, supervisor)
      supervisor.start(endpoint.spawn!)

      if (agentSpec !== null) {
        config.agents[agentSpec.id] = {
          id: agentSpec.id,
          name: agentSpec.name,
          endpoint: body.name,
          workspacePath: agentSpec.workspace,
          public: false,
          preset: agentSpec.preset,
          sandboxMode: agentSpec.sandboxMode,
          gitRemote: null,
          provider: null,
          model: null,
        }
        const row = db.select({ id: schema.agent.id }).from(schema.agent).all().find((a) => a.id === agentSpec.id)
        if (row === undefined) {
          db.insert(schema.agent)
            .values({
              id: agentSpec.id,
              name: agentSpec.name,
              workspacePath: agentSpec.workspace,
              endpoint: body.name,
              preset: agentSpec.preset,
              gitRemote: null,
              public: 0,
              createdAt: Date.now(),
            })
            .run()
        }
      }

      // 蜂群2计划 P3：审计留痕（创建节点）
      recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `节点 ${body.name}（端口 ${port}，工作区 ${agentSpec?.workspace ?? '—'}）` })
      return reply.code(201).send({
        node: { id: body.name, port, home: nodeHomePath, state: supervisor.current.state },
        workspace: agentSpec === null ? null : { id: agentSpec.id, path: agentSpec.workspace },
        workspaceWarning,
      })
    } catch (error) {
      // 回滚：yaml 写在最后，此前任何失败都不会有配置残留；删掉半成品目录即可。
      if (createdHome !== null) rmSync(createdHome, { recursive: true, force: true })
      app.log.error(`provision node ${body.name} failed: ${(error as Error).message}`)
      return reply.code(500).send({ error: 'provision_failed', detail: (error as Error).message })
    }
  })

  /**
   * 2026-09-05 定：删除节点 = 停进程 + 配置里删「节点 + 它绑定的工作区」两行
   * + 磁盘目录全部保留。确认语义由前端确认框明示。
   */
  app.delete<{ Params: { id: string } }>('/api/nodes/:id', { preHandler: requireUser }, async (request, reply) => {
    const endpoint = config.endpoints[request.params.id]
    if (endpoint === undefined) return reply.code(404).send({ error: 'unknown_node' })
    if (endpoint.spawn === null || !supervisors.has(request.params.id)) {
      return reply.code(409).send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法删除它` })
    }

    const bound = Object.values(config.agents).filter((a) => a.endpoint === request.params.id)

    supervisors.get(request.params.id)!.stop()
    supervisors.delete(request.params.id)
    delete config.endpoints[request.params.id]
    for (const a of bound) delete config.agents[a.id]

    const yaml = parseYaml(readFileSync(resolve(CONFIG_PATH), 'utf8')) as Record<string, Record<string, unknown>>
    if (yaml.endpoints !== undefined) delete yaml.endpoints[request.params.id]
    for (const a of bound) {
      if (yaml.agents !== undefined) delete yaml.agents[a.id]
    }
    writeFileSync(resolve(CONFIG_PATH), stringifyYaml(yaml), 'utf8')

    app.log.info(
      `node ${request.params.id}: unmanaged (${bound.length} workspace binding(s) removed from config; files on disk kept)`,
    )
    // 蜂群2计划 P3：审计留痕（删除节点）
    recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_delete', detail: `节点 ${request.params.id} 删除（磁盘目录保留）` })
    return reply.send({ ok: true, removedWorkspaces: bound.map((a) => a.id) })
  })
}
