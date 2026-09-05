// 蜂群2计划 P2：构建期生成容器内节点 profile（与 src/cli/setup.ts 的 profileFiles
// 同构，但 webserver 绑 0.0.0.0 —— 容器网络隔离下端口不发布，manager 走 hive 内网）。
// 版本钉死值由 Dockerfile 的 ARG 注入，默认与 src/dsh-version.ts 一致。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const DSH_VERSION = process.env.DSH_VERSION ?? '0.1.1-rc.2'
const GATEWAY_REF = process.env.GATEWAY_REF ?? 'github:litestartup-com/dsh-api-gateway#db50fba2ffc9be4041742d1b4faf89cfcd708f31'
const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const out = process.env.PROFILE_DIR ?? '/opt/ohdsh-profile'

mkdirSync(out, { recursive: true })

writeFileSync(`${out}/package.json`, JSON.stringify(
  {
    name: 'dsh-profile-ohdsh-node',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-api-gateway'] } },
    dependencies: {
      '@deepseek-ai/dsh-base': DSH_VERSION,
      '@deepseek-ai/dsh-web-app': DSH_VERSION,
      'dsh-api-gateway': GATEWAY_REF,
    },
  },
  null,
  2,
) + '\n', 'utf8')
// pnpm ≥10 默认拒绝运行依赖构建脚本（ERR_PNPM_IGNORED_BUILDS）——
// 显式批准 DSH 依赖链里必须构建的原生/后置脚本包。10 认顶层键、11 认 pnpm 嵌套键，
// 两个形态都给（9 及以下直接忽略，按旧语义照跑）。
writeFileSync(
  `${out}/pnpm-workspace.yaml`,
  [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'onlyBuiltDependencies:',
    "  - '@deepseek-ai/dsh-subprocess-local'",
    "  - '@google/genai'",
    '  - koffi',
    '  - node-pty',
    '  - protobufjs',
    'pnpm:',
    '  onlyBuiltDependencies:',
    "    - '@deepseek-ai/dsh-subprocess-local'",
    "    - '@google/genai'",
    '    - koffi',
    '    - node-pty',
    '    - protobufjs',
    '',
  ].join('\n'),
  'utf8',
)
writeFileSync(`${out}/cordis.yml`, '# dsh profile root — empty entry list; edit cordis.patch.yml\n[]\n', 'utf8')
// 端口用动态表达式透传 CLI --port（写死 3080 会盖掉 --port，节点全听 3080，
// manager 探 3081/3082 全 fetch failed——容器实测踩坑）。
const patchYaml = "- id: webserver\n  config:\n    host: '0.0.0.0'\n    port: !!js ctx.webStartup.port ?? 3080\n"
writeFileSync(`${out}/cordis.patch.yml`, patchYaml, 'utf8')
// 播种版本标记：entrypoint 据此判断卷里旧 profile 是否需要重播种（镜像升级自愈）
writeFileSync(
  `${out}/.seed-version`,
  createHash('sha1').update(`${DSH_VERSION}|${GATEWAY_REF}|${patchYaml}`).digest('hex') + '\n',
  'utf8',
)

execFileSync('pnpm', ['install', `--registry=${NPM_REGISTRY}`], { cwd: out, stdio: 'inherit' })
console.log(`[gen-node-profile] ${out} ready (DSH ${DSH_VERSION}, gateway ${GATEWAY_REF})`)
