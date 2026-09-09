/**
 * 蜂群2计划 P1：DSH 版本治理单一真相源。
 *
 * manager 的 apiproxy 契约按 COMPAT_DSH_VERSION 实测（wire 面见 notes/APIPROXY.md）。
 * setup 自检、节点 hostVersion 告警、节点镜像 tag、安装器提示全部引用这里 ——
 * 官方出新版时只改这一处，配合冒烟通过后一起 bump。
 */
export const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'
export const COMPAT_DSH_VERSION = '0.1.2-rc.1'
/** 安装命令：版本钉死，不追最新。 */
export const DSH_INSTALL_COMMAND = `npm install -g ${COMPAT_DSH_PACKAGE}@${COMPAT_DSH_VERSION}`
/**
 * 0.1.2 线（切主路）：facade 插件包名 = ohdsh-api-facade（ohdsh- 前缀约定）。
 * 仓库 URL 仍是 litestartup-com/dsh-api-gateway（钉版链暂不动），引用钉
 * next-012 分支的最新 commit（eeb33d6 = 白名单全量迁移完成点）。
 */
export const GATEWAY_PACKAGE = 'ohdsh-api-facade'
export const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#e6b3c5b6dfc8c1cb1226f2b391fcd9a1582dc050'
/** 版本比对：容忍 v 前缀；null = 未探测到。 */
export const dshCompatible = (version: string | null): boolean =>
  version !== null && version.replace(/^v/, '') === COMPAT_DSH_VERSION
