# Oh! dsh — DSH 节点容器镜像（DSH + dsh-api-gateway）
#
# 一个容器 = 一个 DSH agent 节点。
# 国内环境构建提示见 docker/README.md「国内网络」一节：
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# git: 插件经 github 协议安装；curl: smoke 自检
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# DSH 启动器 + pnpm（dsh plugin add 转发给 pnpm）；
# NPM_REGISTRY 供国内构建切换 npm 镜像源
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm install -g @deepseek-ai/dsh@0.1.1-rc.2 pnpm@11 --registry="${NPM_REGISTRY}" --no-audit --no-fund \
    && npm cache clean --force

ENV DSH_HOME=/data \
    NODE_ENV=production

COPY entrypoint.sh /usr/local/bin/dsh-node-entrypoint
RUN chmod +x /usr/local/bin/dsh-node-entrypoint

# /data（DSH_HOME）与 /workspace 归 uid 1000：容器以非 root（user 1000:1000）运行，
# 命名卷首次挂载会继承镜像目录所有权，先 chown 才能写入。
RUN mkdir -p /data /workspace && chown -R 1000:1000 /data /workspace
# agent 工作区根（DSH 的默认 workspace 根 = 启动目录）
WORKDIR /workspace

EXPOSE 3080
ENTRYPOINT ["dsh-node-entrypoint"]
