# Oh! dsh

> 蜂群计划 —— 单主机多节点的本地多 agent 管理器，建在 DeepSeek Harness 之上。
> 默认安装 = manager（总办）+ 主脑（总控）+ 个人（工作区）。一条命令、5 分钟用起来。

## 一键安装

**Linux 服务器（容器，推荐）：**

```bash
curl -fsSL https://get.ohdsh.com/install.sh -o install.sh && bash install.sh
# 熟手一行：curl -fsSL https://get.ohdsh.com/install.sh | bash
```

**Windows（本机直跑）：**

```powershell
irm https://get.ohdsh.com/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
# 熟手一行：irm https://get.ohdsh.com/install.ps1 | iex
```

脚本幂等：已装组件自动跳过，重跑不覆盖配置与数据；唯一需要输入的是 DeepSeek API key
（`DEEPSEEK_API_KEY=...` 预置则全自动）；首次登录强制修改密码。
完整使用手册见 `docs/USER-GUIDE.md`。

## 是什么

DeepSeek Harness 提供 agent 运行时（会话 / 工具 / 沙箱 / 文件系统）；Oh! dsh 提供控制面：
认证、聊天中继、主脑派工、定时任务、节点管理、技能清单、记账、备份恢复。

概念层级（详见 `docs/MILESTONES.md`）：

```
服务器 ──► 节点（= 一个 DSH agent 进程 + 独立 DSH_HOME）──► 工作区（身份+目录+preset+沙箱）──► 会话
```

- **主脑** = manager 级总控：跨域规划、派工单、查 fleet；对工作区只读，执行永远委托。
- **工作区** = 文件即真相的边界：每个工作区一个 git 仓，每次运行落一次提交（审计留痕）。

## 功能

- **聊天 UI**：多轮对话、流式输出、工具调用卡片、互动提问/授权卡片直接作答
- **主脑派工**：对话式编排 + delegation 帧（点击跳回被派会话）+ 会话复用（同类续接）
- **多节点**：`/nodes` 页全 UI 管控（起/停/重启/日志）+ 向导新增节点 + 侧栏 `N/N` 就绪计数
- **多会话并发**：会话内串行、会话间并行（DSH 原生语义 + git 提交锁 + 冲突显性化）
- **定时任务**：cron 自动化、连续失败自动停用、主脑日预算熔断（只拦派工，人工不拦）
- **技能清单**：`/skills` 页按工作区列技能 + 版本对照（= 工作区 git HEAD）
- **站内通知**：铃铛——cron 成败 / 预算熔断 / 主脑任务完成
- **记账**：峰谷计价（**周六周日全天谷价**）、每 run 花费、月度汇总、按工作区分账
- **备份恢复**：15 分钟自动快照 + 保留策略（24h 全留 → 每日 30 天 → 每周 12 周）+ 一键恢复
- **服务化**：开机自启（Windows 任务计划 / Linux systemd）
- **自更新**：备份 → 拉新 → 构建 → 探活，失败自动回滚

## 从源码运行（开发者）

前置：Node ≥ 20（推荐 22）、pnpm、git、DeepSeek Harness（版本见 `COMPAT_DSH_VERSION`）。

```powershell
git clone <repo-url>
cd dsh-agent-manager
npm install
npm run setup          # 自检表（node/pnpm/git/dsh）+ 初始化工作区/节点/配置
npm run build
npm start              # 启动 manager，自动拉起托管节点
```

## CLI 一览

| 命令 | 用途 |
| --- | --- |
| `npm run setup [--force]` | 初始化/重装（`--force` 保留已定制的工作区） |
| `npm start` | 启动 manager（自动拉起托管节点） |
| `npm run nodes -- up/down/list/logs <名>` | 节点生命周期（UI 在 /nodes 页） |
| `npm run backup [-- list]` / `npm run restore -- latest` | 备份 / 恢复（恢复前自动探测 manager 是否在跑） |
| `npm run service -- install/uninstall/status` | 开机自启服务 |
| `npm run update` | 自更新（失败自动回滚） |
| `npm test` / `npm run typecheck` | 测试 / 类型检查 |

## 配置

`manager.config.yaml` 是唯一真相源：`endpoints`（每个 DSH 进程的入口 + spawn 生命周期）、
`agents`（工作区绑定）、`runner`（超时/静默/预算）、`pricing`（峰谷窗口 + 周末规则）、
`brain.daily_budget_usd`（主脑派工熔断）。密钥只进 `.env`（`GW_KEY_*` / `BRAIN_TOKEN`），永不入库。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/USER-GUIDE.md` | 用户手册（安装 / 主脑 / 节点 / 定时 / 记账 / 备份） |
| `docs/MILESTONES.md` | **路线图唯一真相源** |
| `CHANGELOG.md` | 变更记录 |

## 测试

```powershell
npm test   # 全绿（数量由 CI 断言，不手写）
```

## License

MIT
