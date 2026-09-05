// scripts/make-release.mjs — 生成发布包 ohdsh-compose.zip（纯镜像引用，剥离 build 段）。
// 发布者用：OHDSH_VERSION=v1.0.1 DSH_NODE_IMAGE=... MANAGER_IMAGE=... node scripts/make-release.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.env.OHDSH_VERSION ?? 'v1.0.1'
const nodeImage = process.env.DSH_NODE_IMAGE ?? 'ohdsh/dsh-node:0.1.1-rc.2'
const managerImage = process.env.MANAGER_IMAGE ?? `ohdsh/manager:${version.replace(/^v/, '')}`
const releaseDir = join(root, 'dist-release')
const stage = join(releaseDir, 'stage')

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// ---- compose：剥离 build 段、钉镜像 ----
const compose = parseYaml(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
delete compose.services.manager.build
compose.services.manager.image = managerImage
delete compose.services['node-brain'].build
compose.services['node-brain'].image = nodeImage
writeFileSync(join(stage, 'docker-compose.yml'), stringifyYaml(compose), 'utf8')

// ---- 静态件 ----
cpSync(join(root, 'manager.config.container.example.yaml'), join(stage, 'manager.config.container.example.yaml'))
cpSync(join(root, 'scripts', 'gen-env.sh'), join(stage, 'scripts', 'gen-env.sh'))
mkdirSync(join(stage, 'deploy', 'nginx'), { recursive: true })
for (const f of ['default.conf', 'tls-origin-ca.conf', 'tls-letsencrypt.conf', 'tls-none.conf']) {
  cpSync(join(root, 'deploy', 'nginx', f), join(stage, 'deploy', 'nginx', f))
}
writeFileSync(
  join(stage, 'README.txt'),
  [
    'Oh! dsh 发布包（compose 三件套）',
    '',
    '快速开始：',
    '  DEEPSEEK_API_KEY=sk-xxx bash scripts/gen-env.sh .env',
    '  cp manager.config.container.example.yaml manager.config.yaml',
    '  docker compose up -d',
    '',
    '完整文档：https://github.com/litestartup-com/dsh-agent-manager',
  ].join('\n'),
  'utf8',
)

// ---- 打包 zip（跨平台：Windows 用 Compress-Archive，其余用 zip） ----
rmSync(join(releaseDir, 'ohdsh-compose.zip'), { force: true })
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${join(releaseDir, 'ohdsh-compose.zip')}' -Force`,
  ])
} else {
  execFileSync('zip', ['-qr', join(releaseDir, 'ohdsh-compose.zip'), '.'], { cwd: stage })
}

console.log(`[make-release] ${join(releaseDir, 'ohdsh-compose.zip')}`)
console.log(`[make-release] compose: manager=${managerImage} node=${nodeImage} (${version})`)
