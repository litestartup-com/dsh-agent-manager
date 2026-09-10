/**
 * 债务 A3:真相源(`manager.config.yaml` / 任意配置文件)的原子写。
 *
 * 旧代码 read → parse(JS 对象)→ stringify → 直写同一路径,四个问题:
 * 1. 崩溃截断:写一半进程死 = 配置损坏,manager 下次启动直接拒启(loadConfig fail-loud);
 * 2. 丢注释:`manager.config.yaml` 是唯一手改入口(AGENTS A-1),注释与手工格式是文档本体;
 * 3. 无写后校验:坏结构写进去才发现,而且已经覆盖了上一版;
 * 4. 并发写互相覆盖(provision 新增/删除两个请求)。
 *
 * 本模块:Document API 保注释 → `.tmp` + `rename` 原子 → 写后回读校验,
 * 失败自动还原上一版并抛错——坏配置绝不留在真相源。
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parseDocument, stringify, type Document } from 'yaml'
import { loadConfig } from './config.js'

let chain: Promise<unknown> = Promise.resolve()

/** 进程内写锁:并发的 read-modify-write 串行执行,绝不互相覆盖。 */
export const withConfigLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const run = chain.then(fn)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 原子写:先写 `<path>.tmp` 再 rename。中途失败清 .tmp,绝不留下会被当成
 * 最新配置的半成品。`mode` 可选(如 .env 的 0600)。
 */
export const writeFileAtomic = (path: string, content: string, mode?: number): void => {
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode)
      } catch {
        // 权限模型不支持(Windows)——不是失败
      }
    }
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清不掉的 .tmp 不影响正确性
    }
    throw error
  }
}

export type YamlValidate = 'none' | 'syntax' | 'full'

/**
 * 读 → Document(保注释)→ mutate → stringify → 原子写 → 回读校验。
 *
 * 校验语义:
 * - `syntax`:写后回读 parseDocument 必须可解析(防磁盘级损坏);
 * - `full`:写后 `loadConfig` 必须可加载(provision 写的是完整真相源),
 *   失败 = 还原上一版并抛错;
 * - `none`:跳过校验(全新文件生成,尚无完整语义)。
 */
export const mutateYamlFile = (
  path: string,
  mutate: (doc: Document) => void,
  opts: { validate?: YamlValidate } = {},
): void => {
  const validate = opts.validate ?? 'syntax'
  const before = readFileSync(path, 'utf8')
  const doc = parseDocument(before)
  mutate(doc)
  const next = stringify(doc, { lineWidth: 0 })
  if (next === before) return
  writeFileAtomic(path, next)
  try {
    if (validate === 'full') loadConfig(path)
    else if (validate === 'syntax') parseDocument(readFileSync(path, 'utf8'))
  } catch (error) {
    // 坏配置绝不留在真相源:还原上一版,错误显性抛出
    try {
      writeFileAtomic(path, before)
    } catch (restoreError) {
      throw new Error(
        `config write rejected and restore failed: ${(error as Error).message}; restore: ${(restoreError as Error).message}`,
      )
    }
    throw new Error(`config write rejected (validation failed, previous version restored): ${(error as Error).message}`)
  }
}
