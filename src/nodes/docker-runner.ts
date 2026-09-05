/**
 * DockerRunner — 蜂群2计划 P2b：manager 经 docker.sock 管理本机节点容器。
 *
 * 一个 DSH 节点容器 = 镜像（构建期冻结依赖）+ 命名卷（节点 home）+ bind mount
 * （工作区）。所有容器打 `com.ohdsh.managed=true` 标签：manager 只碰自己拉的
 * 容器，对账（认领在跑 / 补拉缺失）也以标签为界。
 *
 * 构造函数可注入 docker 实例（测试用假实现），生产走 /var/run/docker.sock。
 */
import Dockerode from 'dockerode'
import type { ResolvedSpawnSpec } from '../config.js'

export const MANAGED_LABEL = 'com.ohdsh.managed'
export const NODE_LABEL = 'com.ohdsh.node'

export interface ManagedContainerInfo {
  id: string
  name: string
  labels: Record<string, string>
  state: 'running' | 'exited' | 'other'
}

export class DockerRunner {
  private readonly docker: Dockerode

  constructor(options: { socketPath?: string; docker?: Dockerode } = {}) {
    this.docker = options.docker ?? new Dockerode({ socketPath: options.socketPath ?? '/var/run/docker.sock' })
  }

  /** 镜像不存在才拉取；已存在 = 零网络。 */
  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect()
      return
    } catch {
      // 镜像缺失 → 拉取
    }
    await new Promise<void>((resolvePull, rejectPull) => {
      this.docker.pull(image, (error: Error | null, stream?: NodeJS.ReadableStream) => {
        if (error !== null || stream === undefined) {
          rejectPull(error ?? new Error(`pull ${image}: no stream`))
          return
        }
        this.docker.modem.followProgress(stream, () => resolvePull(), () => undefined)
      })
    })
  }

  /**
   * 创建并启动节点容器，返回容器 id。
   * 同名残留容器先强制清掉（重启/重建场景幂等）。
   */
  async start(spec: ResolvedSpawnSpec, nodeId: string, env: Record<string, string>): Promise<string> {
    const d = spec.docker
    if (d === null) throw new Error('docker runner 需要 docker 段')
    const name = d.containerName ?? `ohdsh-node-${nodeId}`

    const leftovers = await this.docker.listContainers({ all: true, filters: { name: [name] } }).catch(() => [])
    for (const c of leftovers) {
      await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined)
    }

    const container = await this.docker.createContainer({
      name,
      Image: d.image,
      // 端口参数由 entrypoint 透传给 web app；容器内网访问，不发布到宿主机
      Cmd: ['--port', String(d.port)],
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      Labels: { [MANAGED_LABEL]: 'true', [NODE_LABEL]: nodeId },
      WorkingDir: '/workspace',
      HostConfig: {
        NetworkMode: d.network,
        Binds: [
          ...Object.entries(d.hostVolumes).map(([host, containerPath]) => `${host}:${containerPath}`),
          ...Object.entries(d.namedVolumes).map(([volume, containerPath]) => `${volume}:${containerPath}`),
        ],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      // 蜂群2计划 P6 实测根因：manager 探活 URL 是 http://node-<id>:port，但 compose 的
      // 内嵌 DNS 只认识 compose 服务名——manager 自己拉的容器必须显式注册网络别名，
      // 否则 DNS 解析失败（fetch failed）。别名给两个形态：node-<id> 与 <id>。
      NetworkingConfig: {
        EndpointsConfig: {
          [d.network]: { Aliases: [`node-${nodeId}`, nodeId] },
        },
      },
    })
    await container.start()
    return container.id
  }

  /** 停止并删除容器（停止 = 删除：状态都在卷里，容器本身无状态）。 */
  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId)
    await container.stop({ t: 5 }).catch(() => undefined)
    await container.remove({ force: true }).catch(() => undefined)
  }

  /** 容器日志（尾部 tail 行）。promise 形态返回 Buffer（dockerode 契约）。 */
  async logs(containerId: string, tail: number): Promise<string> {
    const output = await this.docker.getContainer(containerId).logs({ stdout: true, stderr: true, tail, timestamps: false })
    return Buffer.isBuffer(output) ? output.toString('utf8') : String(output)
  }

  /** 本机所有 manager 管理的节点容器（对账以标签为界）。 */
  async listManaged(): Promise<ManagedContainerInfo[]> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } })
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? c.Id).replace(/^\//, ''),
      labels: c.Labels ?? {},
      state: c.State === 'running' ? 'running' : c.State === 'exited' ? 'exited' : 'other',
    }))
  }

  /**
   * 蜂群2计划 P4：跑一个一次性工具容器（节点 home 卷的备份/恢复用），
   * 退出即自删；退出码非 0 抛错。
   */
  async runTool(image: string, cmd: string[], binds: Array<{ from: string; to: string }>): Promise<void> {
    await this.ensureImage(image)
    const container = await this.docker.createContainer({
      Image: image,
      Cmd: cmd,
      HostConfig: {
        Binds: binds.map((b) => `${b.from}:${b.to}`),
        AutoRemove: true,
      },
    })
    await container.start()
    const result = await container.wait()
    if (result.StatusCode !== 0) {
      throw new Error(`工具容器退出码 ${String(result.StatusCode)}：${cmd.join(' ')}`)
    }
  }
}
