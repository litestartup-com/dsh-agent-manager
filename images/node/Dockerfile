# ohdsh/dsh-node — 蜂群2计划 P2：一个容器 = 一个 DSH 节点（DSH + gateway + 独立 DSH_HOME）
#
# 构建期冻结依赖（DSH 钉版 + gateway 钉 commit），运行时零安装。
# 国内构建：
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# git：插件/工作区；curl/jq：agent 常用工具；tzdata：TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl jq tzdata \
    && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmjs.org
# 与 src/dsh-version.ts 保持一致的钉死版本（官方出新版时一起 bump）
ARG DSH_VERSION=0.1.1-rc.2
ARG GATEWAY_REF=github:litestartup-com/dsh-api-gateway#db50fba2ffc9be4041742d1b4faf89cfcd708f31
# pnpm@9（不是 11）：9 按旧语义运行依赖构建脚本，与裸机 setup 的既有验证一致；
# pnpm ≥10 的构建脚本白名单键语义在 11 又变过（实测 ERR_PNPM_IGNORED_BUILDS 仍触发），
# 构建期工具没必要追新。
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@9 --registry="${NPM_REGISTRY}" --no-audit --no-fund \
    && npm cache clean --force

# 构建期生成节点 profile（bundle 钉版 + gateway 钉 commit）并 pnpm install 冻结
COPY gen-node-profile.mjs /usr/local/bin/gen-node-profile.mjs
RUN DSH_VERSION="${DSH_VERSION}" GATEWAY_REF="${GATEWAY_REF}" NPM_REGISTRY="${NPM_REGISTRY}" \
    node /usr/local/bin/gen-node-profile.mjs

COPY entrypoint.sh /usr/local/bin/dsh-node-entrypoint
RUN chmod +x /usr/local/bin/dsh-node-entrypoint \
    && mkdir -p /data /workspace && chown -R 1000:1000 /data /workspace

# DSH_HOME 挂卷：首次启动从 /opt/ohdsh-profile 复制 profile（本地复制，零网络）。
# 节点内绑 0.0.0.0（容器网络隔离，端口不发布到宿主机，manager 走 hive 内网访问）。
ENV DSH_HOME=/data \
    NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["dsh-node-entrypoint"]
