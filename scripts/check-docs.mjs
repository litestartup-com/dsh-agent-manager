// scripts/check-docs.mjs — CI 门禁（蜂群2计划 P0/P6）：
// 1) README.md 的仓库内 markdown 链接必须指向存在的文件（外部 http/mailto 链接不校验）；
// 2) README/CHANGELOG 禁止手写测试数（数字由 CI 断言，禁绝漂移）；
// 3) 部署文件完整性：compose 引用的本地文件存在；容器示例配置可解析且形态正确。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

// ---- 1) 死链：仓库内相对链接必须解析到真实文件 ----
for (const rel of ['README.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1].trim()
    if (target === '' || /^(https?:|mailto:)/i.test(target)) continue
    const path = resolve(root, target.replace(/^\.\//, ''))
    if (!existsSync(path)) failures.push(`${rel}: 死链 \`${target}\``)
  }
}

// ---- 2) 手写测试数：README/CHANGELOG 不得出现「N 测试/tests」字样 ----
for (const rel of ['README.md', 'CHANGELOG.md']) {
  const text = readFileSync(join(root, rel), 'utf8')
  const hits = text.match(/\d{2,4}\s*(tests?|测试|用例)/gi) ?? []
  if (hits.length > 0) failures.push(`${rel}: 手写测试数（禁绝）→ ${hits.join(', ')}`)
}

// ---- 3) 部署文件完整性 ----
try {
  const compose = parseYaml(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
  const services = compose?.services ?? {}
  for (const name of ['nginx', 'manager', 'node-brain']) {
    if (services[name] === undefined) failures.push(`docker-compose.yml: 缺少服务 ${name}`)
  }
  for (const rel of [
    'deploy/nginx/default.conf.example',
    'images/node/Dockerfile',
    'images/node/entrypoint.sh',
    'images/node/gen-node-profile.mjs',
    'images/manager/Dockerfile',
    'manager.config.container.example.yaml',
    'scripts/gen-env.sh',
  ]) {
    if (!existsSync(join(root, rel))) failures.push(`部署文件缺失: ${rel}`)
  }
  const example = parseYaml(readFileSync(join(root, 'manager.config.container.example.yaml'), 'utf8'))
  if (example?.endpoints?.brain?.sandbox_key_ref !== 'GW_KEY_B') failures.push('容器示例配置: brain 缺少 sandbox_key_ref=GW_KEY_B')
  if (example?.endpoints?.personal?.spawn?.runner !== 'docker') failures.push('容器示例配置: personal 应为 docker runner')
  if (!Array.isArray(example?.backup?.docker_volumes) || !example.backup.docker_volumes.includes('ohdsh-brain')) {
    failures.push('容器示例配置: backup.docker_volumes 应含 ohdsh-brain')
  }
} catch (error) {
  failures.push(`部署文件校验失败: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 4) 债务 H1:manager 容器非 root + docker.sock 降权接线 + nginx 封内网面 ----
try {
  const managerDockerfile = readFileSync(join(root, 'images/manager/Dockerfile'), 'utf8')
  if (!/^\s*USER\s+\d+:\d+\s*$/m.test(managerDockerfile)) {
    failures.push('images/manager/Dockerfile: 缺少 USER 指令（manager 容器必须非 root）')
  }
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
  if (!/group_add/.test(compose)) failures.push('docker-compose.yml: manager 缺少 group_add（docker.sock 经宿主 docker 组 GID 访问）')
  if (!/\$\{DOCKER_GID:/.test(compose)) failures.push('docker-compose.yml: group_add 应引用 DOCKER_GID（gen-env.sh 探测宿主 docker 组）')
  for (const rel of ['deploy/nginx/default.conf.example', 'deploy/nginx/tls-none.conf', 'deploy/nginx/tls-origin-ca.conf', 'deploy/nginx/tls-letsencrypt.conf']) {
    const conf = readFileSync(join(root, rel), 'utf8')
    if (!conf.includes('location /api/internal/')) failures.push(`${rel}: 缺少 /api/internal/ 反代块`)
    if (!conf.includes('deny all')) failures.push(`${rel}: /api/internal/ 缺少私网 ACL（deny all）`)
  }
} catch (error) {
  failures.push(`H1 部署加固校验失败: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 5) 容器部署红线静态断言（compose-e2e 2026-09-14 首次实证四坑，复盘见设计库
//          manager/facts/container-deploy-facts.md——红线 A/B/C/D 的 CI 侧拦网）----
try {
  // 红线 A：每条引导路径都必须写 HOST_UID/HOST_GID（容器 uid = 宿主文件属主；缺失 → SQLITE_CANTOPEN）
  const genEnv = readFileSync(join(root, 'scripts/gen-env.sh'), 'utf8')
  for (const v of ['HOST_UID', 'HOST_GID']) {
    if (!genEnv.includes(`ensure ${v} `)) failures.push(`scripts/gen-env.sh: 必须写入 ${v}（红线 A：容器 uid 与宿主文件属主同源）`)
  }
  // 红线 B：运行时 uid 参数化 → 运行时写目录必须 uid 无关（命名卷根 777、HOME 落可写卷）
  const nodeDockerfile = readFileSync(join(root, 'images/node/Dockerfile'), 'utf8')
  if (!nodeDockerfile.includes('chmod 777 /data')) failures.push('images/node/Dockerfile: /data 卷根必须 chmod 777（红线 B：HOST_UID≠1000 时命名卷属主 EACCES）')
  if (!nodeDockerfile.includes('HOME=/data')) failures.push('images/node/Dockerfile: 必须 HOME=/data（.brain-auth 等运行时写入落可写卷）')
  // 红线 C：真相文件原子写（.tmp+rename）要求所在目录可写（/app 是镜像层 root 属主）
  const managerDockerfile2 = readFileSync(join(root, 'images/manager/Dockerfile'), 'utf8')
  if (!managerDockerfile2.includes('chmod 777 /app')) failures.push('images/manager/Dockerfile: /app 必须放写（红线 C：真相文件 .tmp+rename 原子写需要目录写权限）')
  // 红线 D：节点卷备份必须走 runToolIo 流式传输（容器内绝对路径做 bind 源 = 宿主路径幻觉）
  const nodebackup = readFileSync(join(root, 'src/nodebackup.ts'), 'utf8')
  if (!nodebackup.includes('runToolIo')) failures.push('src/nodebackup.ts: 节点卷备份必须走 runToolIo（红线 D：禁止把容器内备份目录当宿主路径 bind）')
} catch (error) {
  failures.push(`容器部署红线断言失败: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- 6) 能力二（2026-09-20）：钉版同步守卫——DSH/gateway 钉版只许来自版本矩阵
//          src/dsh-matrix.ts；安装器/镜像/升级脚本/发布包出现不一致 = CI 即红 ----
try {
  const matrixSrc = readFileSync(join(root, 'src/dsh-matrix.ts'), 'utf8')
  const defaultDsh = /dsh: '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const gatewayRef = /GATEWAY_REF = '([^']+)'/.exec(matrixSrc)?.[1] ?? ''
  const pinChecks = [
    ['install.ps1', /\$DSH_VERSION = '([^']+)'/, defaultDsh],
    ['images/node/gen-node-profile.mjs', /DSH_VERSION = process\.env\.DSH_VERSION \?\? '([^']+)'/, defaultDsh],
    ['images/node/gen-node-profile.mjs', /GATEWAY_REF = process\.env\.GATEWAY_REF \?\? '([^']+)'/, gatewayRef],
    ['images/node/Dockerfile', /ARG DSH_VERSION=([^\s]+)/, defaultDsh],
    ['images/node/Dockerfile', /ARG GATEWAY_REF=([^\s]+)/, gatewayRef],
    ['scripts/upgrade-node-version.mjs', /GATEWAY_REF = '([^']+)'/, gatewayRef],
    ['scripts/make-release.mjs', /nodeImage = process\.env\.DSH_NODE_IMAGE \?\? 'ohdsh\/dsh-node:([^']+)'/, defaultDsh],
  ]
  for (const [file, re, expected] of pinChecks) {
    const content = readFileSync(join(root, file), 'utf8')
    const match = re.exec(content)
    if (match === null) {
      failures.push(`${file}: 找不到钉版字面量（能力二守卫；格式变更请同步本断言）`)
      continue
    }
    if (match[1] !== expected) {
      failures.push(`${file}: 钉版 ${match[1]} 与版本矩阵不一致（期望 ${expected}）——统一改 src/dsh-matrix.ts，禁止多点手改`)
    }
  }
  // 升级脚本的 SUPPORTED 表 = 矩阵行集合（dsh 列表 + needsLegacyPeerDeps 对齐）——
  // 矩阵加行/改 flag 而脚本表漏改 = CI 红。
  const upgradeSrc = readFileSync(join(root, 'scripts/upgrade-node-version.mjs'), 'utf8')
  const matrixDsh = [...matrixSrc.matchAll(/dsh: '([^']+)'/g)].map((m) => m[1])
  const matrixLegacy = [...matrixSrc.matchAll(/dsh: '([^']+)',[^\n]*needsLegacyPeerDeps: true/g)].map((m) => m[1])
  for (const v of matrixDsh) {
    if (!upgradeSrc.includes(`dsh: '${v}'`)) failures.push(`scripts/upgrade-node-version.mjs: SUPPORTED 表缺矩阵行 ${v}`)
  }
  const scriptRows = [...upgradeSrc.matchAll(/\{ dsh: '([^']+)', legacyPeerDeps: (true|false) \}/g)]
  for (const v of matrixDsh) {
    const row = scriptRows.find((m) => m[1] === v)
    if (row === undefined) continue
    const wantsLegacy = matrixLegacy.includes(v)
    if ((row[2] === 'true') !== wantsLegacy) failures.push(`scripts/upgrade-node-version.mjs: 行 ${v} 的 legacyPeerDeps=${row[2]} 与矩阵 needsLegacyPeerDeps=${wantsLegacy} 不一致`)
  }
  // 容器构建脚本的 LEGACY_PEER_DEPS_VERSIONS = 矩阵 needsLegacyPeerDeps 行集合——
  // 构建 0.1.5 镜像时 profile 安装不带 --legacy-peer-deps 必 ERESOLVE（dsh-facts §12）。
  const genProfileSrc = readFileSync(join(root, 'images/node/gen-node-profile.mjs'), 'utf8')
  const legacyListMatch = /const LEGACY_PEER_DEPS_VERSIONS = \[([^\]]*)\]/.exec(genProfileSrc)
  if (legacyListMatch === null) {
    failures.push('images/node/gen-node-profile.mjs: 缺 LEGACY_PEER_DEPS_VERSIONS 声明（能力二守卫；格式变更请同步本断言）')
  } else {
    const scriptLegacy = [...legacyListMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    for (const v of matrixLegacy) {
      if (!scriptLegacy.includes(v)) failures.push(`images/node/gen-node-profile.mjs: LEGACY_PEER_DEPS_VERSIONS 缺矩阵行 ${v}`)
    }
    for (const v of scriptLegacy) {
      if (!matrixLegacy.includes(v)) failures.push(`images/node/gen-node-profile.mjs: LEGACY_PEER_DEPS_VERSIONS 的 ${v} 在矩阵里不是 needsLegacyPeerDeps`)
    }
  }
  // 搬家重钉守卫（2026-09-20）：install.sh 每次运行都要把 host_volumes 的
  // 宿主侧工作区路径重钉到安装目录真实绝对路径（评审 B2 扩展）——目录搬家后
  // cd 进去重跑 install.sh 即收敛的前提；sed 被删/改坏 = CI 红。
  const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
  if (!installSh.includes('APP_DIR_ABS}/workspaces')) {
    failures.push('install.sh: 缺 host_volumes 宿主侧路径重钉 sed（搬家重钉守卫）')
  }
  // 前端 import 完整性 canary（2026-09-22 事故）：nodes.js 用到
  // versionOptionsHtml 但漏导入 → 页面卡「加载中」且无测试可拦（DOM 文件
  // 不可单测导入）。至少守住这一个已知回归点。
  const nodesJs = readFileSync(join(root, 'public/assets/nodes.js'), 'utf8')
  if (nodesJs.includes('versionOptionsHtml(') && !nodesJs.includes('versionOptionsHtml }')) {
    failures.push('public/assets/nodes.js: 使用了 versionOptionsHtml 但未导入（前端 ReferenceError 回归点）')
  }
  // P0 配置迁移链守卫（hive/plan-config-version-switch）：CONFIG_MIGRATIONS
  // 必须覆盖 0..CURRENT_CONFIG_VERSION 连续 +1 升链——升级自动迁移的前提；
  // 删/断链 = CI 红。
  const migrationsSrc = readFileSync(join(root, 'src/config/migrations.ts'), 'utf8')
  const currentMatch = /CURRENT_CONFIG_VERSION = (\d+)/.exec(migrationsSrc)
  if (currentMatch === null) {
    failures.push('src/config/migrations.ts: 缺 CURRENT_CONFIG_VERSION 声明（配置迁移链守卫）')
  } else {
    const current = Number(currentMatch[1])
    const steps = [...migrationsSrc.matchAll(/\{ from: (\d+), to: (\d+),/g)]
    const covered = new Set(steps.map((m) => m[1]))
    for (let v = 0; v < current; v += 1) {
      if (!covered.has(String(v))) failures.push(`src/config/migrations.ts: 迁移链缺 ${v} → ${v + 1}（CURRENT_CONFIG_VERSION=${current}）`)
    }
    for (const m of steps) {
      if (Number(m[2]) !== Number(m[1]) + 1) failures.push(`src/config/migrations.ts: 迁移 {from:${m[1]},to:${m[2]}} 必须是 +1 升链`)
      if (Number(m[1]) >= current) failures.push(`src/config/migrations.ts: 迁移 {from:${m[1]},to:${m[2]}} 起点不在 0..${current - 1} 范围`)
    }
  }
} catch (error) {
  failures.push(`钉版同步守卫失败: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length > 0) {
  console.error('check-docs FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-docs: OK（README 无死链、无手写测试数、部署文件完整、钉版与矩阵一致）')
