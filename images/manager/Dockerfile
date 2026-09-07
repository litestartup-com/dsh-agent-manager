# ohdsh/manager — 蜂群2计划 P2：控制面镜像（构建期 install+build，运行时零安装）
#
# 依赖 docker.sock（宿主机挂载）管理工蜂容器；git/curl 供工作区快照与 agent 工具。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production TZ=Asia/Shanghai
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY public ./public
# 工作区模板：容器路径没有 setup 步骤，manager 启动时对空工作区自动播种
COPY templates ./templates
# 债务 H1：manager 容器非 root。docker.sock 的访问靠 compose 的 group_add
# 注入宿主 docker 组 GID（镜像内不需要存在同名组）。/app/data 的宿主侧属主
# 由 install.sh 按 HOST_UID 放行（compose 里是 bind mount，以宿主权限为准）。
RUN mkdir -p /app/data \
    && groupadd -g 1000 ohdsh \
    && useradd -u 1000 -g ohdsh -s /bin/sh ohdsh \
    && chown -R 1000:1000 /app/data
EXPOSE 8080
USER 1000:1000
CMD ["node", "dist/index.js"]
