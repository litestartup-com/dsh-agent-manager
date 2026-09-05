import { test } from 'node:test'
import assert from 'node:assert/strict'
import type Dockerode from 'dockerode'
import { DockerRunner } from './docker-runner.js'
import type { ResolvedSpawnSpec } from '../config.js'

/** 测试用假 dockerode：只实现 DockerRunner 用到的面，调用全部留痕。 */
const fake = (options: { imageExists?: boolean; leftovers?: Array<{ Id: string }> } = {}) => {
  const state = {
    pulls: [] as string[],
    created: [] as Array<Record<string, unknown>>,
    started: [] as string[],
    stopped: [] as string[],
    removed: [] as string[],
    listed: 0,
    logRequests: [] as string[],
  }
  const docker = {
    getImage: (image: string) => ({
      inspect: async () => {
        if (options.imageExists !== true) throw new Error(`no such image: ${image}`)
        return {}
      },
    }),
    pull: (image: string, cb: (error: Error | null, stream?: unknown) => void) => {
      state.pulls.push(image)
      cb(null, {})
    },
    modem: { followProgress: (_stream: unknown, onFinished: () => void) => onFinished() },
    listContainers: async () => {
      state.listed += 1
      return options.leftovers ?? []
    },
    createContainer: async (params: Record<string, unknown>) => {
      state.created.push(params)
      return {
        id: 'container-1',
        start: async () => {
          state.started.push('container-1')
        },
      }
    },
    getContainer: (id: string) => ({
      stop: async () => {
        state.stopped.push(id)
      },
      remove: async () => {
        state.removed.push(id)
      },
      logs: async () => {
        state.logRequests.push(id)
        return Buffer.from(`logs-of-${id}\n`)
      },
    }),
  }
  return { state, docker: docker as unknown as Dockerode }
}

const dockerSpec = (): ResolvedSpawnSpec => ({
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
    image: 'ohdsh/dsh-node:0.1.1-rc.2',
    containerName: null,
    network: 'hive',
    port: 3081,
    hostVolumes: { '/opt/ohdsh/workspaces/personal': '/workspace' },
    namedVolumes: { 'ohdsh-personal': '/data' },
  },
})

test('蜂群2计划 P2b: ensureImage 缺失才拉，存在零网络', async () => {
  const missing = fake()
  await new DockerRunner({ docker: missing.docker }).ensureImage('img')
  assert.deepEqual(missing.state.pulls, ['img'])

  const present = fake({ imageExists: true })
  await new DockerRunner({ docker: present.docker }).ensureImage('img')
  assert.deepEqual(present.state.pulls, [])
})

test('蜂群2计划 P2b: start 创建容器（名称/标签/命令/环境/挂载），同名残留先清', async () => {
  const f = fake({ leftovers: [{ Id: 'stale-1' }] })
  const runner = new DockerRunner({ docker: f.docker })
  const id = await runner.start(dockerSpec(), 'personal', { DSH_HOME: '/data', GW_KEY: 'apigw-x' })
  assert.equal(id, 'container-1')
  assert.deepEqual(f.state.removed, ['stale-1'], '同名残留容器被强制清理')
  const created = f.state.created[0]
  assert.ok(created !== undefined)
  assert.equal(created.name, 'ohdsh-node-personal')
  assert.equal(created.Image, 'ohdsh/dsh-node:0.1.1-rc.2')
  assert.deepEqual(created.Cmd, ['--port', '3081'])
  assert.deepEqual(created.Labels, { 'com.ohdsh.managed': 'true', 'com.ohdsh.node': 'personal' })
  assert.deepEqual(created.Env, ['DSH_HOME=/data', 'GW_KEY=apigw-x'])
  const host = created.HostConfig as { NetworkMode: string; Binds: string[]; RestartPolicy: { Name: string } }
  assert.equal(host.NetworkMode, 'hive')
  assert.deepEqual(host.Binds, ['/opt/ohdsh/workspaces/personal:/workspace', 'ohdsh-personal:/data'])
  assert.deepEqual(host.RestartPolicy, { Name: 'unless-stopped' })
})

test('蜂群2计划 P2b: stop = stop + remove；logs 收集容器输出', async () => {
  const f = fake()
  const runner = new DockerRunner({ docker: f.docker })
  await runner.stop('cid-9')
  assert.deepEqual(f.state.stopped, ['cid-9'])
  assert.deepEqual(f.state.removed, ['cid-9'])
  assert.equal(await runner.logs('cid-9', 100), 'logs-of-cid-9\n')
})

test('蜂群2计划 P2b: listManaged 只回 managed 标签容器并归一化字段', async () => {
  const listed = [
    { Id: 'abc', Names: ['/ohdsh-node-personal'], Labels: { 'com.ohdsh.managed': 'true', 'com.ohdsh.node': 'personal' }, State: 'running' },
    { Id: 'def', Names: ['/ohdsh-node-product'], Labels: { 'com.ohdsh.managed': 'true', 'com.ohdsh.node': 'product' }, State: 'exited' },
  ]
  const f = fake()
  const original = (f.docker as unknown as { listContainers: () => Promise<unknown> }).listContainers
  ;(f.docker as unknown as { listContainers: () => Promise<unknown> }).listContainers = async () => listed
  const runner = new DockerRunner({ docker: f.docker })
  const result = await runner.listManaged()
  assert.deepEqual(result, [
    { id: 'abc', name: 'ohdsh-node-personal', labels: { 'com.ohdsh.managed': 'true', 'com.ohdsh.node': 'personal' }, state: 'running' },
    { id: 'def', name: 'ohdsh-node-product', labels: { 'com.ohdsh.managed': 'true', 'com.ohdsh.node': 'product' }, state: 'exited' },
  ])
  void original
})
