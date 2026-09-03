# DSH 节点容器（DSH + dsh-api-gateway）

一个容器 = 一个 DSH agent 节点。容器内：DSH web profile 绑 `0.0.0.0:3080`；
`dsh-api-gateway`（v0.2.0+）提供带鉴权的北向代理；`/api` 只认容器内 loopback，
外部只能经 `/api-gw/v1/proxy/*` 带 key 访问（安全模型与单机部署一致）。

**端口暴露**：compose 默认只绑宿主机 `127.0.0.1:3080`（同机 manager 可访问，
公网不可达）。跨机部署时才改 `0.0.0.0:3080:3080`——注意那会把 DSH Web GUI 也
暴露出去，必须配防火墙只放行网关路径，或前置反向代理收敛到 `/api-gw/v1/*`。

## 部署步骤

**推荐：用仓库根的一键脚本**（Ubuntu 24，单机 all-in-one：节点容器 + manager + systemd 一起装）：

```bash
git clone https://github.com/litestartup-com/dsh-agent-manager.git
cd dsh-agent-manager
sudo ./install.sh        # 幂等；DRY_RUN=1 sudo ./install.sh 只打印计划
```

**手动方式（只装节点容器）**：

```bash
cd dsh-agent-manager/docker
cp .env.example .env
# 填四项：GW_KEY（openssl rand -hex 32）、DEEPSEEK_API_KEY、
#        WORKSPACE_PATH（宿主机绝对路径，与 manager 配置一致）、HOST_UID/HOST_GID
docker compose up -d --build
./smoke.sh               # 外部调用验收
```

## 验收清单

- [ ] `curl http://<host>:3080/api-gw/v1/health` → 200，`upstream: ok`
- [ ] `./smoke.sh` 四步全过（health / host.describe / session.list / 403 负例）
- [ ] 不带 key 调 `/api-gw/v1/proxy/session.list` → 401
- [ ] （可选）WS mux：`ws://<host>:3080/api-gw/v1/proxy/events.mux`，握手带 `X-API-Key`
- [ ] （可选）manager 方案 B 指向本节点：`url: http://<host>:3080`、
  `prefix: /api-gw/v1/proxy`、`key_ref: GW_KEY_<node>`，跑 `npx tsx scripts/smoke-proxy-b.ts http://<host>:3080/api-gw/v1/proxy`

## manager 同机联调

同一台机器上跑 manager + 容器节点时，**必须走方案 B（经网关）**：
`/api` 的 loopback 栅栏会挡住 docker 网络边界的连接（设计如此），直连不可用。

```yaml
# manager.config.yaml
endpoints:
  A:
    url: http://127.0.0.1:3080
    driver: apiproxy
    prefix: /api-gw/v1/proxy
    key_ref: GW_KEY_A      # manager .env 里填容器 .env 那把 GW_KEY

agents:
  personal:
    workspace: <宿主机绝对路径>/docker/workspace   # 与 compose 挂载一致
```

验收：`npx tsx scripts/smoke-proxy-b.ts http://127.0.0.1:3080/api-gw/v1/proxy`
（`SMOKE_KEY` 填容器 `GW_KEY`）。

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

## 日常管理（容器）

| 操作 | 命令（在 docker/ 目录下） |
| --- | --- |
| 状态 | `docker compose ps` |
| 日志 | `docker compose logs -f --tail 100 dsh-node` |
| 重启节点 | `docker compose restart` |
| 停止 / 启动 | `docker compose stop` / `docker compose start` |
| 完全停止（保留数据） | `docker compose down` |
| 完全停止并清空数据 | `docker compose down -v`（会删 dsh-data 卷与容器内配置，慎用） |
| 重建镜像（升级） | `docker compose up -d --build` |
| 进容器排查 | `docker compose exec dsh-node bash` |

数据卷：

- `dsh-data` → 容器内 `/data`（会话、settings、skills、凭据——**备份优先备份它**）
- `WORKSPACE_PATH` → 容器内 `/workspace`（agent 写的文件，宿主机同路径可见）

备份示例：

```bash
docker run --rm -v dsh-node_dsh-data:/data -v $PWD:/backup alpine tar czf /backup/dsh-data.tar.gz -C /data .
```

## 已知坑

- **GitHub 网络**：首次启动要 `dsh plugin add github:litestartup-com/dsh-api-gateway`。
  拉不动时，把 gateway 仓库打成 tgz（`pnpm pack`）挂进容器后手动
  `docker exec dsh-node dsh plugin --profile web add /path/to/tgz`。
- **改 GW_KEY**：删除容器内 `$DSH_HOME/cordis.patch.yml` 后重启（`docker exec dsh-node rm /data/cordis.patch.yml`）。
- **数据**：会话/settings/skills 在 `dsh-data` 卷，工作区在 `dsh-workspace` 卷；
  `docker compose down`（不带 -v）不丢数据。
- **端口**：`docker compose run` 里可用 `--port` 透传（patch 里 `ctx.webStartup.port ?? 3080`）。