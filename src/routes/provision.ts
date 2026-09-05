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
import { makeSupervisor } from '../nodes/registry.js'
import { detectDshBin, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, resolveGatewayKey } from '../cli/setup.js'

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
  agent: z
    .object({
      id: nodeNameSchema,
      name: z.string().min(1).max(80),
      workspace: z.string().min(1),
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
})

interface ProvisionDeps {
  db: Db
  supervisors: Map<string, NodeSupervisor>
  clients: Map<string, GatewayClient>
  upstreamClients: Map<string, UpstreamClient>
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
    if (body.agent !== undefined && config.agents[body.agent.id] !== undefined) {
      return reply.code(409).send({ error: 'duplicate_agent', detail: `agent "${body.agent.id}" 已存在` })
    }
    const port = body.port ?? suggestPort(config)
    if (usedPorts(config).has(port)) {
      return reply.code(409).send({ error: 'port_taken', detail: `端口 ${port} 已被占用（manager 或现有节点）` })
    }

    const nodeHomePath = join(nodesHome(), body.name)
    const keyRef = `GW_KEY_${body.name.toUpperCase()}`
    let createdHome: string | null = null

    try {
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

      // 3. 工作区目录（不写模板：新 agent 的模板向导是下一轮的事）
      if (body.agent !== undefined) mkdirSync(resolve(body.agent.workspace), { recursive: true })

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
      if (body.agent !== undefined) {
        agents[body.agent.id] = {
          name: body.agent.name,
          endpoint: body.name,
          workspace: body.agent.workspace,
          public: false,
          ...(body.agent.preset === undefined ? {} : { preset: body.agent.preset }),
          ...(body.agent.sandboxMode === undefined ? {} : { sandbox_mode: body.agent.sandboxMode }),
        }
      }
      writeFileSync(resolve(CONFIG_PATH), stringifyYaml(yaml), 'utf8')

      // 5. 热加载：endpoint + agent 进内存配置，监督器入册并拉起
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

      let agentId: string | null = null
      if (body.agent !== undefined) {
        agentId = body.agent.id
        config.agents[body.agent.id] = {
          id: body.agent.id,
          name: body.agent.name,
          endpoint: body.name,
          workspacePath: resolve(body.agent.workspace),
          public: false,
          preset: body.agent.preset ?? null,
          sandboxMode: body.agent.sandboxMode ?? null,
          gitRemote: null,
          provider: null,
          model: null,
        }
        const row = db.select({ id: schema.agent.id }).from(schema.agent).all().find((a) => a.id === body.agent!.id)
        if (row === undefined) {
          db.insert(schema.agent)
            .values({
              id: body.agent.id,
              name: body.agent.name,
              workspacePath: resolve(body.agent.workspace),
              endpoint: body.name,
              preset: body.agent.preset ?? null,
              gitRemote: null,
              public: 0,
              createdAt: Date.now(),
            })
            .run()
        }
      }

      return reply.code(201).send({
        node: { id: body.name, port, home: nodeHomePath, state: supervisor.current.state },
        agent: agentId,
      })
    } catch (error) {
      // 回滚：yaml 写在最后，此前任何失败都不会有配置残留；删掉半成品目录即可。
      if (createdHome !== null) rmSync(createdHome, { recursive: true, force: true })
      app.log.error(`provision node ${body.name} failed: ${(error as Error).message}`)
      return reply.code(500).send({ error: 'provision_failed', detail: (error as Error).message })
    }
  })

  app.delete<{ Params: { id: string } }>('/api/nodes/:id', { preHandler: requireUser }, async (request, reply) => {
    const endpoint = config.endpoints[request.params.id]
    if (endpoint === undefined) return reply.code(404).send({ error: 'unknown_node' })
    const bound = Object.values(config.agents).filter((a) => a.endpoint === request.params.id)
    if (bound.length > 0) {
      return reply
        .code(409)
        .send({ error: 'agents_bound', detail: `节点上还有 agent（${bound.map((a) => a.name).join('、')}），先把它们迁走再删节点。` })
    }
    if (endpoint.spawn === null || !supervisors.has(request.params.id)) {
      return reply.code(409).send({ error: 'not_managed', detail: `节点 ${request.params.id} 由外部管理，manager 无法删除它` })
    }

    supervisors.get(request.params.id)!.stop()
    supervisors.delete(request.params.id)
    delete config.endpoints[request.params.id]

    const yaml = parseYaml(readFileSync(resolve(CONFIG_PATH), 'utf8')) as Record<string, Record<string, unknown>>
    if (yaml.endpoints !== undefined) delete yaml.endpoints[request.params.id]
    writeFileSync(resolve(CONFIG_PATH), stringifyYaml(yaml), 'utf8')

    app.log.info(`node ${request.params.id}: removed from management (files on disk kept)`)
    return reply.send({ ok: true })
  })
}
