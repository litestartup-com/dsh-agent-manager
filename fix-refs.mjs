// 一次性脚本：把指向已改名文件的注释修正为 src/dsh-matrix.ts。
import { readFileSync, writeFileSync } from 'node:fs'

const edits = {
  'src/version.ts': [
    ['// 债务 D5:manager 自身版本的运行时真相源(DSH 兼容版本见 dsh-version.ts,两者勿混淆)。', '// 债务 D5:manager 自身版本的运行时真相源(DSH 兼容版本见 dsh-matrix.ts,两者勿混淆)。'],
  ],
  'scripts/inject-version.mjs': [
    ['// 债务 D5:manager 自身版本的运行时真相源(DSH 兼容版本见 dsh-version.ts,两者勿混淆)。', '// 债务 D5:manager 自身版本的运行时真相源(DSH 兼容版本见 dsh-matrix.ts,两者勿混淆)。'],
  ],
  'images/node/Dockerfile': [
    ['# 与 src/dsh-version.ts 保持一致的钉死版本（官方出新版时一起 bump）', '# 钉死版本与 src/dsh-matrix.ts 的 SUPPORTED_DSH 首行一致（check-docs 常驻断言；官方出新版时一起 bump）'],
  ],
  'images/node/gen-node-profile.mjs': [
    ['// 版本钉死值由 Dockerfile 的 ARG 注入，默认与 src/dsh-version.ts 一致。', '// 版本钉死值由 Dockerfile 的 ARG 注入，默认与 src/dsh-matrix.ts 的 SUPPORTED_DSH 首行一致。'],
  ],
}

for (const [file, pairs] of Object.entries(edits)) {
  const text = readFileSync(file, 'utf8')
  let out = text
  const missed = []
  for (const [from, to] of pairs) {
    if (out.includes(from)) out = out.replaceAll(from, to)
    else missed.push(from.slice(0, 50))
  }
  writeFileSync(file, out, 'utf8')
  console.log(`${file}: ${pairs.length - missed.length}/${pairs.length}${missed.length > 0 ? ` MISSED ${missed.join(' | ')}` : ''}`)
}
