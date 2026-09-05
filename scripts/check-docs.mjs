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
    'deploy/nginx/default.conf',
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

if (failures.length > 0) {
  console.error('check-docs FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-docs: OK（README 无死链、无手写测试数、部署文件完整）')
