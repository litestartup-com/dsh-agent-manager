# Oh! dsh

> 蜂群计划 v1 —— 单主机多节点的本地多 agent 管理器，建在 DeepSeek Harness 之上。
> 默认安装 = manager（总办）+ 主脑（总控）+ 个人（工作区），一条命令、5 分钟用起来。

## 是什么

DeepSeek Harness 提供 agent 运行时（会话 / 工具 / 沙箱 / 文件系统）；Oh! dsh 提供控制面：
认证、聊天中继、主脑派工、定时任务、大盘、记账、节点生命周期、备份恢复。

概念层级（详见 `docs/MILESTONES.md`）：

```
服务器 ──► 节点（= 一个 DSH agent 进程 + 门房）──► 工作区（身份+目录+preset+沙箱）──► 会话
```

- **主脑** = manager 级总控：跨域规划、派工单、查 fleet；对工作区只读，执行永远委托。
- **工作区** = 文件即真相的边界：每个工作区一个 git 仓，每次运行落一次提交（审计留痕）。

## 功能

- **聊天 UI**：多轮对话、流式输出、工具调用卡片、互动提问/授权卡片直接作答
- **主脑派工**：对话式编排 + delegation 帧（点击跳回被派会话）+ 会话复用（同类续接）
- **多节点**：`/nodes` 页全 UI 管控（起/停/重启/日志）+ 向导新增节点（自动配工作区）+ 侧栏 `N/N` 就绪计数
- **多会话并发**：会话内串行、会话间并行（DSH 原生语义 + git 提交锁 + 冲突显性化）
- **定时任务**：cron 自动化、连续失败自动停用、主脑日预算熔断（只拦派工，人工不拦）
- **技能清单**：`/skills` 页按工作区列技能 + 版本对照（= 工作区 git HEAD）
- **站内通知**：铃铛——cron 成败 / 预算熔断 / 主脑任务完成
- **记账**：峰谷计价（**周六周日全天谷价**）、每 run 花费、月度汇总、按工作区分账
- **备份恢复**：15 分钟自动 DB 快照 + 保留策略（24h 全留 → 每日 30 天 → 每周 12 周）+ 一键恢复
- **服务化**：开机自启（Windows 任务计划 / Linux systemd user unit，零额外二进制）
- **自更新**：`npm run update` = 备份 → 拉新 → 构建 → 探活，失败自动回滚

## 快速开始（Windows / 单机）

前置：Node ≥ 20（推荐 22）、pnpm、git，本机已装 DeepSeek Harness 并配好模型凭证。

```powershell
git clone <repo-url>
cd dsh-agent-manager
npm install
npm run setup          # 初始化个人+主脑工作区、两个节点（独立 DSH_HOME/端口/密钥）、生成配置
npm start              # 启动 manager，自动拉起两个节点
```

打开 http://127.0.0.1:8080，用 `.env` 里 `MANAGER_USERNAME` / `MANAGER_INITIAL_PASSWORD` 登录。
`npm run setup -- --help` 看全部选项（工作区路径 / 端口 / 本地 gateway 等）。

## CLI 一览

| 命令 | 用途 |
| --- | --- |
| `npm run setup [--force]` | 初始化/重装（`--force` 保留已定制的工作区） |
| `npm start` | 启动 manager（自动拉起托管节点） |
| `npm run nodes -- up/down/list/logs <名>` | 节点生命周期（CLI 面；UI 在 /nodes 页） |
| `npm run backup [-- list]` / `npm run restore -- latest` | 数据库快照 / 恢复（恢复前自动探测 manager 是否在跑） |
| `npm run service -- install/uninstall/status` | 开机自启服务 |
| `npm run update` | 自更新（备份 → 拉新 → 构建 → 探活，失败回滚） |
| `npm test` / `npm run typecheck` | 测试 / 类型检查 |

## 配置

`manager.config.yaml` 是唯一真相源：`endpoints`（每个 DSH 进程的入口 + spawn 生命周期）、
`agents`（工作区绑定）、`runner`（超时/静默/预算）、`pricing`（峰谷窗口 + 周末规则）、
`brain.daily_budget_usd`（主脑派工熔断）。密钥只进 `.env`（`GW_KEY_*` / `BRAIN_TOKEN`），永不入库。

## Linux 服务器部署（可选，早期路径）

`install.sh`（幂等，`DRY_RUN=1` 先看计划）提供 node + manager systemd 服务 + 反代/TLS
（`DEPLOY_ENV=prod` 支持 Cloudflare 三种 TLS 模式）。v2 跨机形态（node-agent + 容器）见路线图。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/BRAINSTORM-MULTIAGENT.md` | 概念对齐 + 决策台账 |
| `docs/MILESTONES.md` | **路线图唯一真相源**（M0–M6 + 发布门槛） |
| `docs/REPORT-FLEET-ROADMAP.md` | 节点/服务器/FinOps 调研 |
| `docs/PLAN-MULTIAGENT.md` | P0–P4 实施计划（已交付，历史） |
| `docs/TASKS.md` | 实施进度日志 |

## 测试

```powershell
npm test   # 334 tests（node:test + tsx，全绿）
```

## License

MIT
