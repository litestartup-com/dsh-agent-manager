/**
 * 蜂群2计划 P4：备份加密（AES-256-CBC）。
 * 密钥派生自 SESSION_SECRET —— 备份与恢复在同一份 .env 前提下自动可用，
 * 无需额外口令管理；.env 丢失 = 备份不可解（诚实语义，文档明示）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export const deriveBackupKey = (sessionSecret: string): Buffer =>
  createHash('sha256').update(`ohdsh-backup:${sessionSecret}`).digest()

/**
 * 明文文件 → 加密文件（格式：16 字节随机 IV + 密文）。
 * 先写 <out>.tmp 再改名：失败绝不留下会被当成最新归档的半成品（评审 B4 中危）。
 */
export const encryptFile = async (plainPath: string, outPath: string, key: Buffer): Promise<void> => {
  const tmpPath = `${outPath}.tmp`
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const output = createWriteStream(tmpPath)
  output.write(iv)
  try {
    await pipeline(createReadStream(plainPath), cipher, output)
    renameSync(tmpPath, outPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}

/** 加密文件 → 明文文件。密钥错 = 解密抛错（调用方转成人话）。 */
export const decryptFile = async (encPath: string, outPath: string, key: Buffer): Promise<void> => {
  const fd = openSync(encPath, 'r')
  const iv = Buffer.alloc(16)
  readSync(fd, iv, 0, 16, 0)
  closeSync(fd)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  await pipeline(createReadStream(encPath, { start: 16 }), decipher, createWriteStream(outPath))
}
