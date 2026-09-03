# Oh! dsh

> 基于 DeepSeek Harness 的个人 / 小团队 AI agent 中台。
> 管理 agent、在任何设备上对话、定时干活、并追踪花掉的每一个 token。

## 特性

- **聊天界面** — 多轮对话、流式输出、工具调用卡片，互动提问与授权确认直接在浏览器里应答
- **多 agent** — 一份声明式配置管理多个 agent，自带 personal / company / product 模板
- **定时任务** — cron 自动化，带单日预算上限与峰谷计价感知
- **大盘** — 从结构化数据文件渲染财务 / 健康 / 工作面板
- **花费追踪** — 每次运行的 token 用量与费用，月度汇总
- **安全写入** — 可选的写入层在**落盘前**校验内容；每次运行把 agent 工作区快照为一次 git 提交
- **DSH 原生传输** — 经 harness 的 /api（apiproxy）面直连（loopback），或经 `dsh-api-gateway`（>= 0.2.0）跨机、多宿主访问

## 整体结构

```
浏览器 ── Oh! dsh (Fastify + SQLite) ── DSH 节点
               │   鉴权 · 会话中继 · 运行 · 定时 · 大盘 · 计费
               ├─ 方案 A：loopback   http://127.0.0.1:3080/api
               └─ 方案 B：跨机       http://<host>:3080/api-gw/v1/proxy（密钥鉴权）
```

DeepSeek Harness 提供 agent 运行时（会话、工具、沙箱、文件系统）；
Oh! dsh 提供控制面（鉴权、中继、调度、大盘、计费）。
与 DSH /api 的线上契约实现位于 `src/upstream/`，已对 DSH 0.1.1-rc.2 实测验证。

## 环境要求

- Node.js >= 20（推荐 22）
- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 0.1.1-rc.2+（启用 /api 面）
- [dsh-api-gateway](https://github.com/litestartup-com/dsh-api-gateway) >= 0.2.0 — 仅跨机 / 多宿主部署需要

## 快速开始

```powershell
git clone <repo-url>
cd dsh-agent-manager
npm install
Copy-Item .env.example .env   # 填写密钥与密钥引用
npm run dev                   # 监听 http://127.0.0.1:8080
```

打开 http://127.0.0.1:8080，用首次启动创建的初始用户登录（变量清单见 `.env.example`）。

### 一键安装（Ubuntu 24，节点容器 + manager 一起）

```bash
git clone https://github.com/litestartup-com/dsh-agent-manager.git
cd dsh-agent-manager
sudo ./install.sh     # 节点容器 + manager systemd 服务 + 验收脚本
```

脚本幂等、可用 `DRY_RUN=1` 预演；手动部署方式见 `docker/README.md`。

### 安装后的运维（install.sh 之后）

| 操作 | 命令 |
| --- | --- |
| manager 状态 | `systemctl status ohdsh-manager` |
| manager 日志 | `journalctl -u ohdsh-manager -f` |
| 重启 / 停止 manager | `sudo systemctl restart ohdsh-manager` / `sudo systemctl stop ohdsh-manager` |
| 节点容器状态 | `docker compose -f docker/docker-compose.yml ps` |
| 节点容器日志 | `docker compose -f docker/docker-compose.yml logs -f` |
| 重启 / 停止节点 | `docker compose -f docker/docker-compose.yml restart` / `... down` |
| 升级代码 | `git pull && sudo ./install.sh`（幂等，已有配置不覆盖） |
| 重建节点镜像 | `docker compose -f docker/docker-compose.yml up -d --build` |

数据位置：

- manager SQLite：`./data`（已 gitignore）
- 节点会话/settings：Docker 卷 `dsh-data`
- agent 工作区：`WORKSPACE_PATH`（默认仓库旁的 `../workspace`）

## 配置

`manager.config.yaml` 是唯一配置源：

- `endpoints` — 每台 DSH 宿主一条（`driver: apiproxy` 走原生 /api；`driver: gateway` 走旧版 dsh-api-gateway 实例）
- `agents` — 每个 agent 一个工作区，模板在 `templates/` 下
- `runner` — 回合超时、静默兜底、cron 失败预算
- `pricing` — 按模型的 token 单价（峰 / 谷时段）

## 测试

```powershell
npm test   # 284 个测试，node:test + tsx
```

## License

MIT
