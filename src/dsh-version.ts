/**
 * 蜂群2计划 P1：DSH 版本治理单一真相源。
 *
 * manager 的 apiproxy 契约按 COMPAT_DSH_VERSION 实测（wire 面见 notes/APIPROXY.md）。
 * setup 自检、节点 hostVersion 告警、节点镜像 tag、安装器提示全部引用这里 ——
 * 官方出新版时只改这一处，配合冒烟通过后一起 bump。
 */
export const COMPAT_DSH_PACKAGE = '@deepseek-ai/dsh'
export const COMPAT_DSH_VERSION = '0.1.1-rc.2'
/** 安装命令：版本钉死，不追最新。 */
export const DSH_INSTALL_COMMAND = `npm install -g ${COMPAT_DSH_PACKAGE}@${COMPAT_DSH_VERSION}`
/**
 * dsh-api-gateway 固定引用。仓库尚无 tag，钉 main 上 v0.2.0 对应的 commit；
 * 打上 tag 后改 `github:litestartup-com/dsh-api-gateway#v0.2.0`。
 */
export const GATEWAY_REF = 'github:litestartup-com/dsh-api-gateway#db50fba2ffc9be4041742d1b4faf89cfcd708f31'
/** 版本比对：容忍 v 前缀；null = 未探测到。 */
export const dshCompatible = (version: string | null): boolean =>
  version !== null && version.replace(/^v/, '') === COMPAT_DSH_VERSION
