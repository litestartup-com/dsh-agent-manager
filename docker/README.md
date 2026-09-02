# DSH 节点容器（DSH + dsh-api-gateway）

一个容器 = 一个 DSH agent 节点。容器内：DSH web profile 绑 `0.0.0.0:3080`；
`dsh-api-gateway`（v0.2.0+）提供带鉴权的北向代理；`/api` 只认容器内 loopback，
外部只能经 `/api-gw/v1/proxy/*` 带 key 访问（安全模型与单机部署一致）。

## 部署步骤

```bash
# 1. 把这套文件弄到服务器（git clone 或直接拷贝 docker/ 目录）
cd dsh-agent-manager/docker

# 2. 配置密钥
cp .env.example .env
#    GW_KEY：网关 API 密钥，openssl rand -hex 32 生成
#    DEEPSEEK_API_KEY：DeepSeek 模型密钥

# 3. 构建并启动（首次构建约 2-5 分钟）
docker compose up -d --build

# 4. 看日志，等 "mounted" / 端口起来
docker compose logs -f --tail 50

# 5. 外部调用验收
export GW_KEY=<与 .env 一致>
./smoke.sh
```

## 验收清单

- [ ] `curl http://<host>:3080/api-gw/v1/health` → 200，`upstream: ok`
- [ ] `./smoke.sh` 四步全过（health / host.describe / session.list / 403 负例）
- [ ] 不带 key 调 `/api-gw/v1/proxy/session.list` → 401
- [ ] （可选）WS mux：`ws://<host>:3080/api-gw/v1/proxy/events.mux`，握手带 `X-API-Key`
- [ ] （可选）manager 方案 B 指向本节点：`url: http://<host>:3080`、
  `prefix: /api-gw/v1/proxy`、`key_ref: GW_KEY_<node>`，跑 `npx tsx scripts/smoke-proxy-b.ts http://<host>:3080/api-gw/v1/proxy`

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GW_KEY` | 是 | 网关 API 密钥；首启写入 `$DSH_HOME/cordis.patch.yml` |
| `DEEPSEEK_API_KEY` | 否 | 模型密钥；环境变量层优先级最高，无需挂 credentials 文件 |

## 国内网络（Docker Hub / GitHub 不通时）

三处网络依赖，逐层兜底：

**1) 基础镜像（node:22-bookworm-slim）**

```bash
# 方式 A：daemon 级加速（一劳永逸，编辑 /etc/docker/daemon.json 后重启 docker）
#   { "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run"] }

# 方式 B：手动拉取 + tag（立即生效，不用重启 daemon）
docker pull docker.m.daocloud.io/library/node:22-bookworm-slim
docker tag docker.m.daocloud.io/library/node:22-bookworm-slim node:22-bookworm-slim
# 不通就换 docker.1ms.run / docker.xuanyuan.me / 阿里云个人加速器（需 cr.console.aliyun.com 申请）
```

**2) npm（装 @deepseek-ai/dsh）**

```bash
docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

**3) dsh-api-gateway 插件（github 协议）**

在能访问 GitHub 的机器上（比如你本机）：

```bash
cd dsh-api-gateway
pnpm pack          # 生成 dsh-api-gateway-0.2.0.tgz
scp dsh-api-gateway-0.2.0.tgz 服务器:~/ohdsh/dsh-agent-manager/docker/packages/
```

服务器上取消 compose 里 `./packages:/packages:ro` 那行挂载的注释，entrypoint 会
**优先用本地 tgz**，不再走 GitHub。

---

## 已知坑

- **GitHub 网络**：首次启动要 `dsh plugin add github:litestartup-com/dsh-api-gateway`。
  拉不动时，把 gateway 仓库打成 tgz（`pnpm pack`）挂进容器后手动
  `docker exec dsh-node dsh plugin --profile web add /path/to/tgz`。
- **改 GW_KEY**：删除容器内 `$DSH_HOME/cordis.patch.yml` 后重启（`docker exec dsh-node rm /data/cordis.patch.yml`）。
- **数据**：会话/settings/skills 在 `dsh-data` 卷，工作区在 `dsh-workspace` 卷；
  `docker compose down`（不带 -v）不丢数据。
- **端口**：`docker compose run` 里可用 `--port` 透传（patch 里 `ctx.webStartup.port ?? 3080`）。