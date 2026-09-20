// 蜂群2计划 P2：构建期生成容器内节点 profile（与 src/cli/setup.ts 的 profileFiles
// 同构，但 webserver 绑 0.0.0.0 —— 容器网络隔离下端口不发布，manager 走 hive 内网）。
// 版本钉死值由 Dockerfile 的 ARG 注入，默认与 src/dsh-version.ts 一致。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const DSH_VERSION = process.env.DSH_VERSION ?? '0.1.2-rc.1'
const GATEWAY_REF = process.env.GATEWAY_REF ?? 'github:litestartup-com/dsh-api-gateway#b592b4f'
const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const out = process.env.PROFILE_DIR ?? '/opt/ohdsh-profile'
// 与 src/dsh-matrix.ts 的 needsLegacyPeerDeps 保持一致（check-docs.mjs 常驻断言）：
// facade peer 区间 ^0.1.2-rc.1 覆盖不到 0.1.5 线 → 不带 --legacy-peer-deps 必 ERESOLVE
// （服务器 smoke15 实测，事实卡 dsh-facts §12；裸机路径 profileInstallCommand 同款修复）。
const LEGACY_PEER_DEPS_VERSIONS = ['0.1.5-rc.2']

mkdirSync(out, { recursive: true })

writeFileSync(`${out}/package.json`, JSON.stringify(
  {
    name: 'dsh-profile-ohdsh-node',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ohdsh-api-facade'] } },
    dependencies: {
      '@deepseek-ai/dsh-base': DSH_VERSION,
      '@deepseek-ai/dsh-web-app': DSH_VERSION,
      'ohdsh-api-facade': GATEWAY_REF,
    },
  },
  null,
  2,
) + '\n', 'utf8')
// profile 依赖安装已改 npm（见下方 execFileSync）：pnpm@9 对 0.1.2-rc.1 的内层
// 预发布区间解析失败、pnpm@11 的 onlyBuiltDependencies 白名单失效——服务器构建两次实锤；
// npm 同版本集实证可解析且按旧语义跑原生构建脚本。
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

const installArgs = ['install', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`]
if (LEGACY_PEER_DEPS_VERSIONS.includes(DSH_VERSION)) installArgs.push('--legacy-peer-deps')
execFileSync('npm', installArgs, { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' })
console.log(`[gen-node-profile] ${out} ready (DSH ${DSH_VERSION}, gateway ${GATEWAY_REF})`)
