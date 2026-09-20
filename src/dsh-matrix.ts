/**
 * 能力二（2026-09-20）：DSH 版本矩阵——(dsh 版本 ↔ facade ref) 配对表，
 * manager 版本治理的唯一真相源（原 dsh-version.ts 常量迁入此处，旧文件变
 * re-export 垫片保持导入面）。
 *
 * 关键洞察（设计稿 §2.1）：manager 的上游 wire 是经 facade 冻结的契约，所以
 * 「多版本 DSH」的耦合 = (dsh, facade) 配对；每行必须各自通过全链 smoke
 * （scripts/smoke-proxy-b.ts 同款 + 问答/授权卡片 + 版本告警 + GUI token），
 * 验证通过才把 status 升为 verified。未验证配对允许安装但必须黄字警告
 * （与 setup --skip-version-check 同款风险自负口径）。
 */
export const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'

export interface DshPair {
  dsh: string
  /** 该 DSH 版本配对的 facade 钉 commit（github:<repo>#<sha>）。 */
  gateway: string
  /** verified = 全链 smoke 通过；pending = 未验证（安装黄字警告）。 */
  status: 'verified' | 'pending'
}

/**
 * 0.1.2 线（切主路）：facade 插件包名 = ohdsh-api-facade（ohdsh- 前缀约定）。
 * 仓库 URL 仍是 litestartup-com/dsh-api-gateway（钉版链暂不动），引用钉
 * next-012 分支的最新 commit。
 */
export const GATEWAY_PACKAGE = 'ohdsh-api-facade'
export const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#b592b4f'

export const SUPPORTED_DSH: DshPair[] = [
  { dsh: '0.1.2-rc.1', gateway: GATEWAY_REF, status: 'verified' },
  // 生产服务器已实跑 0.1.5-rc.2（access 报告）；配对 facade 待 P3 smoke 验证。
  { dsh: '0.1.5-rc.2', gateway: GATEWAY_REF, status: 'pending' },
]

/** 默认版本 = 矩阵首行（新节点缺省）。 */
export const COMPAT_DSH_VERSION = SUPPORTED_DSH[0]?.dsh ?? '0.1.2-rc.1'

/** 安装命令：版本钉死，不追最新。 */
export const DSH_INSTALL_COMMAND = `npm install -g ${COMPAT_DSH_PACKAGE}@${COMPAT_DSH_VERSION}`

export const defaultDshVersion = (): string => COMPAT_DSH_VERSION

/** 已知配对回矩阵行；未知版本回 null（调用方按「不在矩阵」处理）。 */
export const resolvePair = (version: string): DshPair | null =>
  SUPPORTED_DSH.find((p) => p.dsh === version.replace(/^v/, '')) ?? null

/** verified | pending | null（不在矩阵）。 */
export const pairStatus = (version: string): 'verified' | 'pending' | null => {
  const pair = resolvePair(version)
  return pair === null ? null : pair.status
}

export const isSupportedDsh = (version: string | null): boolean =>
  version !== null && resolvePair(version) !== null

/**
 * 版本比对：容忍 v 前缀；null = 未探测到。
 * 能力二语义升级：旧实现严格等于 COMPAT_DSH_VERSION；现在 = 在矩阵内
 * （含未验证配对——安装/告警由 pairStatus 分层处理）。
 */
export const dshCompatible = (version: string | null): boolean => isSupportedDsh(version)
