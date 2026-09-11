import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { mutateYamlFile, withConfigLock, writeFileAtomic } from '../config-store.js'
import type { AppConfig, ResolvedEndpoint, ResolvedSpawnSpec } from '../config.js'
import type { Db } from '../db/index.js'
import { schema } from '../db/index.js'
import type { GatewayClient } from '../gateway/client.js'
import type { SessionDriver } from '../session-driver/port.js'
import { buildUpstreamClients } from '../upstream/client.js'
import type { NodeSupervisor } from '../nodes/supervisor.js'
import type { DockerRunner } from '../nodes/docker-runner.js'
import { makeSupervisor } from '../nodes/registry.js'
import { detectDshBin, ensureNodeCredentials, ensureNodeProfiles, mergeEnv, profileInstallCommand, resolveGatewayKey } from '../cli/setup.js'
import { ensureWorkspaceGit } from '../workspace/init.js'
import { reconcileAll, removeAgentRow } from '../reconcile/index.js'
import { GATEWAY_REF } from '../dsh-version.js'
import { recordAudit } from '../audit.js'

/**
 * 蜂群 P5.5：运行时新增 / 删除节点。
 *
 * 原则：文件即真相 + 只增热加载。落盘顺序 = profile → 密钥 → .env →
 * manager.config.yaml，**最后才动内存**；中途任何一步失败即回滚（删节点
 * 目录），配置与内存都保持原样。删除 = 解除托管（不删磁盘目录），要求
 * 节点上没有 agent（迁移是后话）。
 *
 * 债务 E3：docker/process 双分支共享「开通流水线」（准备 → DB → 真相文件
 * → 内存 → 进程），形态差异（url/沙箱地址、spawn 规格、镜像 vs bin）参数化；
 * 回滚台账（H2 顺序）与 B1 异步 install 流程留在分支内。
 */

const GATEWAY_DEP = GATEWAY_REF // 0.1.2 线：钉 next-012 commit（dsh-version 单一真相源）
const CONFIG_PATH = 'manager.config.yaml'
const ENV_PATH = '.env'

/** 债务 E3:新节点携带的 agent 规格（两分支同形）。 */
interface NewAgentSpec {
  id: string
  name: string
  workspace: string
  preset: string | null
  sandboxMode: 'read-only' | 'workspace-write' | null
}

/** 流水线第 1 步：工作区目录 + git 初始化（返回警告文案）。 */
const prepareWorkspace = (agentSpec: NewAgentSpec | null): string | null => {
  if (agentSpec === null) return null
  mkdirSync(agentSpec.workspace, { recursive: true })
  const git = ensureWorkspaceGit(agentSpec.workspace, agentSpec.name)
  return git.warning
}

/**
 * 流水线第 2 步：DB 先行记账。镜像本身由 reconcileAll 的 mirrorAgents 完成
 * （债务 R9，单一实现），这里只记「行是否存在」供回滚台账用。
 */
const markDbFirst = (db: Db, agentSpec: NewAgentSpec | null): boolean => {
  if (agentSpec === null) return false
  const row = db.select({ id: schema.agent.id }).from(schema.agent).all().find((a) => a.id === agentSpec.id)
  return row === undefined
}

/**
 * 流水线第 3 步：真相文件写入（.env 密钥 + yaml；债务 A3 原子写 + 保注释，
 * 债务 R6 锁入口）。返回写前快照供 H2 回滚。
 */
const writeNodeTruth = async (
  paths: { envPath: string; configPath: string },
  spec: {
    keyRef: string
    key: string
    name: string
    url: string
    sandboxBase: string
    agentSpec: NewAgentSpec | null
    /** 形态差异：docker spec 或 process spawn 块，原样写进 yaml 的 spawn。 */
    spawnYaml: unknown
  },
): Promise<{ envSnap: string | null; yamlSnap: string }> => {
  const envSnap = existsSync(paths.envPath) ? readFileSync(paths.envPath, 'utf8') : null
  const yamlSnap = readFileSync(paths.configPath, 'utf8')
  await withConfigLock(() => {
    mergeEnv(paths.envPath, { [spec.keyRef]: spec.key }, [spec.keyRef])
    mutateYamlFile(
      paths.configPath,
      (doc) => {
        doc.setIn(['endpoints', spec.name], {
          url: spec.url,
          driver: 'apiproxy',
          prefix: '/api',
          key_ref: '',
          sandbox_base: spec.sandboxBase,
          sandbox_key_ref: spec.keyRef,
          spawn: spec.spawnYaml,
        })
        if (spec.agentSpec !== null) {
          doc.setIn(['agents', spec.agentSpec.id], {
            name: spec.agentSpec.name,
            endpoint: spec.name,
            workspace: spec.agentSpec.workspace,
            public: false,
            preset: spec.agentSpec.preset,
            sandbox_mode: spec.agentSpec.sandboxMode,
          })
        }
      },
    )
  })
  return { envSnap, yamlSnap }
}

/** 流水线第 4 步：工作区热加载进内存配置（两分支逐字相同）。 */
const hotLoadAgent = (config: AppConfig, endpointId: string, agentSpec: NewAgentSpec | null): void => {
  if (agentSpec === null) return
  config.agents[agentSpec.id] = {
    id: agentSpec.id,
    name: agentSpec.name,
    endpoint: endpointId,
    workspacePath: agentSpec.workspace,
    public: false,
    preset: agentSpec.preset,
    sandboxMode: agentSpec.sandboxMode,
    gitRemote: null,
    provider: null,
    model: null,
    validate: null,
  }
}

/**
 * 债务 B1:节点依赖安装后台化——旧代码在请求处理里同步 execFileSync(npx pnpm@9
 * install,注释自承"通常几十秒"),Node 单线程下全站(SSE 中继/cron/探活/登录)冻结。
 * 本函数用异步 spawn:请求路径不再等待,安装完成/失败由调用方接线。
 * spawnImpl 可注入(测试用假 spawn,不触网)。
 */
export const installNodeDepsAsync = (
  dir: string,
  spawnImpl: typeof spawn = spawn,
): Promise<void> => {
  const { cmd, args } = profileInstallCommand(process.platform)
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, [...args, '--prefer-offline'], { cwd: dir, shell: true, stdio: 'inherit' })
    child.on('error', (error: Error) => reject(error))
    child.on('exit', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(`dependency install failed (exit ${code ?? 'unknown'}) in ${dir}`))
    })
  })
}
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
  upstreamClients: Map<string, SessionDriver>
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
  // 债务 A5:真相源路径从 loadConfig 解析结果取(单一来源);测试字面量缺省时回退 cwd 相对
  const configPath = config.configPath ?? resolve(CONFIG_PATH)
  const envPath = config.envPath ?? resolve(ENV_PATH)

  // 债务 R9:派生状态(DB 镜像 / fleet.md / 节点生命周期)统一交给 reconcile 收敛,
  // provision 只做真相源变更(配置文件)+ 内存热加载。onlyNodes 范围化:
  // - 空集 = 本轮不动任何节点(镜像与 fleet 照跑);
  // - {新节点} = 只拉起新节点——绝不借热变更把用户手动停掉的其它冷节点抢拉起来。
  // removeStaleAgents=false:热删除后 agent 行在进程存活期内保留(账单/审计 FK)。
  const reconcile = (onlyNodes: Set<string>): Promise<void> =>
    reconcileAll(
      { db, config, supervisors, docker: deps.docker ?? null, log: (line) => app.log.info(line) },
      { onlyNodes, removeStaleAgents: false },
    )

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
    // 债务 H2:回滚台账——副作用按「准备 → DB → 真相文件 → 内存 → 进程」顺序推进,
    // 每完成一步记一步;失败时按相反顺序撤销,绝不留下半开通的幽灵节点。
    // envSnap 三态:undefined = mergeEnv 从未执行(.env 未被本请求碰过);
    // null = 执行时文件不存在(本请求创建的,回滚应移除);string = 写前快照。
    let dbRowInserted = false
    let envSnap: string | null | undefined
    let yamlSnap: string | null = null
    let supervisorStarted: NodeSupervisor | null = null
    // 债务 B1:回滚后禁止后台 install 完成时再拉起(防泄漏)
    let rolledBack = false

    try {
      // 蜂群2计划 P6：容器模式分支——节点 = docker runner 工蜂（镜像 + 命名卷 +
      // 网络别名），不找 DSH bin、不做 profile/pnpm（运行时零安装）。
      if (dockerMode) {
        const key = 'apigw-' + randomBytes(24).toString('hex')

        // 流水线 1:工作区
        const workspaceWarning = prepareWorkspace(agentSpec)

        // 宿主机侧工作区路径：从既有 docker 端点的 host_volumes 推导前缀
        // （install.sh 已把示例里的宿主路径钉成真实路径，这里照抄同一前缀）。
        const hostKey = deriveHostWorkspacePath(config, body.name, agentSpec?.workspace)

        const dockerSpec = {
          image: process.env.DSH_NODE_IMAGE ?? 'ohdsh/dsh-node:0.1.2-rc.1',
          network: 'ohdsh-hive',
          port,
          host_volumes: { [hostKey]: agentSpec?.workspace ?? workspaceDefault },
          named_volumes: { [`ohdsh-${body.name}`]: '/data' },
        }

        // 流水线 2:DB 先行(债务 H2/R9)
        dbRowInserted = markDbFirst(db, agentSpec)
        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `节点 ${body.name}（docker 工蜂，端口 ${port}，工作区 ${agentSpec?.workspace ?? '—'}）` })

        // 流水线 3:真相文件(带快照,失败可还原;债务 A3 原子写 + R6 锁入口)
        const snaps = await writeNodeTruth(
          { envPath, configPath },
          {
            keyRef,
            key,
            name: body.name,
            url: `http://node-${body.name}:${port}`,
            sandboxBase: `http://node-${body.name}:${port}/api-gw/v1`,
            agentSpec,
            spawnYaml: {
              managed: true,
              runner: 'docker',
              ready_timeout_ms: 30_000,
              docker: dockerSpec,
            },
          },
        )
        envSnap = snaps.envSnap
        yamlSnap = snaps.yamlSnap

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
        // 债务 R9:节点拉起交给 reconcile(convergeNodes 对 docker runner 走认领/
        // 补拉),这里只记台账供回滚 stop。
        supervisorStarted = supervisor

        // 流水线 4:agent 热加载进内存配置
        hotLoadAgent(config, body.name, agentSpec)

        // 债务 R9:派生状态统一交 reconcile——镜像/fleet 立即跑,节点经
        // convergeNodes 拉起(docker 分支无 install 延迟)。
        await reconcile(new Set([body.name]))
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

      // 2. 依赖安装（债务 B1:后台化——数十秒的同步 pnpm 不再冻结全站）。
      // 201 先返回;install 完成才拉起节点;失败 = 审计留痕 + 仍拉起(节点
      // 缺依赖时崩溃,supervisor 状态机显性 offline,错误可见)。
      const installDir = join(nodeHomePath, 'profiles', body.name)
      const installPromise: Promise<void> = body.install !== false ? installNodeDepsAsync(installDir) : Promise.resolve()

      // 流水线 1:工作区（目录 + git init + 通用 AGENTS.md,文件即真相,运行才有审计）
      const workspaceWarning = prepareWorkspace(agentSpec)

      // 流水线 2:DB 先行(债务 H2/R9)
      dbRowInserted = markDbFirst(db, agentSpec)
      // 蜂群2计划 P3：审计留痕（创建节点）
      recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `节点 ${body.name}（端口 ${port}，工作区 ${agentSpec?.workspace ?? '—'}）` })

      // 流水线 3:真相文件（带快照，失败可还原;债务 A3 原子写 + R6 锁入口）
      const snaps = await writeNodeTruth(
        { envPath, configPath },
        {
          keyRef,
          key,
          name: body.name,
          url: `http://127.0.0.1:${port}`,
          sandboxBase: `http://127.0.0.1:${port}/api-gw/v1`,
          agentSpec,
          spawnYaml: {
            managed: true,
            command: 'node',
            args: [dshBin, '--profile', body.name, '--no-open'],
            ready_timeout_ms: 30_000,
            env: { DSH_HOME: nodeHomePath },
          },
        },
      )
      envSnap = snaps.envSnap
      yamlSnap = snaps.yamlSnap

      // 热加载：endpoint + 工作区进内存配置，监督器入册并拉起
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
      // 债务 B1:拉起延后到依赖安装完成(201 先返回,请求路径不再等待安装)。
      // 回滚后的迟到安装完成不得再拉起(rolledBack 防泄漏)。
      const startAfterInstall = (): void => {
        if (rolledBack) return
        supervisorStarted = supervisor
        // 债务 R9:节点拉起也走 reconcile(单一入口),不再自己 supervisor.start。
        void reconcile(new Set([body.name])).catch((error: unknown) => {
          app.log.error(`node ${body.name}: reconcile after install failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      installPromise.then(startAfterInstall).catch((installError: unknown) => {
        if (rolledBack) return
        const message = installError instanceof Error ? installError.message : String(installError)
        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `失败:节点 ${body.name} 依赖安装失败: ${message}` })
        app.log.error(`node ${body.name}: dependency install failed: ${message}`)
        startAfterInstall() // 仍拉起:缺依赖时节点崩溃,supervisor 状态机显性 offline
      })

      // 流水线 4:agent 热加载进内存配置
      hotLoadAgent(config, body.name, agentSpec)

      // 债务 R9:派生状态统一交 reconcile——镜像/fleet 立即跑;节点拉起延后到
      // 依赖安装完成(startAfterInstall 里的 reconcile,见上)。
      await reconcile(new Set())
      return reply.code(201).send({
        node: { id: body.name, port, home: nodeHomePath, state: supervisor.current.state },
        workspace: agentSpec === null ? null : { id: agentSpec.id, path: agentSpec.workspace },
        workspaceWarning,
      })
    } catch (error) {
      // 债务 H2：全量回滚——按完成步骤反向撤销，绝不留下半开通的幽灵节点。
      rolledBack = true
      if (supervisorStarted !== null) {
        try {
          supervisorStarted.stop()
        } catch {
          // 停进程/容器失败不阻断回滚其余步骤
        }
        supervisors.delete(body.name)
      }
      if (config.endpoints[body.name] !== undefined) {
        delete config.endpoints[body.name]
        upstreamClients.delete(body.name)
      }
      if (agentSpec !== null && config.agents[agentSpec.id] !== undefined) delete config.agents[agentSpec.id]
      if (dbRowInserted && agentSpec !== null) {
        try {
          removeAgentRow(db, agentSpec.id)
        } catch {
          // DB 本身可能已不可用——不阻断其余回滚
        }
      }
      if (yamlSnap !== null) {
        try {
          writeFileAtomic(configPath, yamlSnap)
        } catch (rollbackError) {
          app.log.warn(`provision rollback: restore config failed: ${(rollbackError as Error).message}`)
        }
      }
      if (envSnap !== undefined) {
        if (envSnap === null) {
          // .env 在本请求之前不存在：它由 mergeEnv 创建且只含本节点的 key，直接移除。
          try {
            rmSync(envPath, { force: true })
          } catch {
            // 删不掉只影响卫生，不影响正确性
          }
        } else {
          try {
            writeFileAtomic(envPath, envSnap, 0o600)
          } catch (rollbackError) {
            app.log.warn(`provision rollback: restore .env failed: ${(rollbackError as Error).message}`)
          }
        }
      }
      if (createdHome !== null) {
        try {
          rmSync(createdHome, { recursive: true, force: true })
        } catch {
          // 目录残留由下次 boot 的对账收敛
        }
      }
      // 债务 R9:回滚后重跑收敛——按还原后的真相源重镜像/fleet 重同步
      // (fleet.md 不残留失败节点条目;agent 行恢复旧值)。
      try {
        await reconcile(new Set())
      } catch (rollbackError) {
        app.log.warn(`provision rollback: reconcile failed: ${(rollbackError as Error).message}`)
      }
      try {
        recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_create', detail: `失败：${(error as Error).message}` })
      } catch {
        // 审计失败不影响回滚结果
      }
      app.log.error(`provision node ${body.name} failed (rolled back): ${(error as Error).message}`)
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

    // 债务 E10:569 行已判 supervisors.has,此处显式收窄替代 `!`
    const supervisor = supervisors.get(request.params.id)
    if (supervisor === undefined) return reply.code(409).send({ error: 'not_managed' })
    supervisor.stop()
    supervisors.delete(request.params.id)
    delete config.endpoints[request.params.id]
    for (const a of bound) delete config.agents[a.id]

    // 债务 A3:删除也走原子写(syntax 校验,防磁盘级损坏);债务 R6:统一锁入口
    await withConfigLock(() =>
      mutateYamlFile(
        configPath,
        (doc) => {
          doc.deleteIn(['endpoints', request.params.id])
          for (const a of bound) doc.deleteIn(['agents', a.id])
        },
      ),
    )

    app.log.info(
      `node ${request.params.id}: unmanaged (${bound.length} workspace binding(s) removed from config; files on disk kept)`,
    )
    // 蜂群2计划 P3：审计留痕（删除节点）
    recordAudit(db, { actor: request.currentUser?.username ?? 'unknown', kind: 'node_delete', detail: `节点 ${request.params.id} 删除（磁盘目录保留）` })
    // 债务 R9:镜像与 fleet 的收敛统一走 reconcile(空节点集 = 不动节点生命周期;
    // removeStaleAgents=false = agent 行在进程存活期内保留,账单/审计不丢)。
    await reconcile(new Set())
    return reply.send({ ok: true, removedWorkspaces: bound.map((a) => a.id) })
  })
}
