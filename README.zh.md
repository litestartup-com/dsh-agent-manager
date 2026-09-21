# Oh! dsh

> 蜂群计划 —— 单主机多节点的本地多 agent 管理器，建在 DeepSeek Harness 之上。
> 默认安装 = manager（总办）+ 主脑（总控）+ 个人（工作区）。一条命令、5 分钟用起来。

> English version: [README.md](./README.md)。

## 一键安装

**Linux 服务器（容器，推荐）：**

```bash
curl -fsSL https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.1.1/install.sh -o install.sh && bash install.sh
# 熟手一行：curl -fsSL https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.1.1/install.sh | bash
```

**Windows（本机直跑）：**

```powershell
irm https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.1.1/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
# 熟手一行：irm https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.1.1/install.ps1 | iex
```

脚本幂等：已装组件自动跳过，重跑不覆盖配置与数据；唯一需要输入的是 DeepSeek API key
（`DEEPSEEK_API_KEY=...` 预置则全自动）；首次登录强制修改密码。
完整使用手册见 `docs/USER-GUIDE.md`。

## 是什么

DeepSeek Harness 提供 agent 运行时（会话 / 工具 / 沙箱 / 文件系统）；Oh! dsh 提供控制面：
认证、聊天中继、主脑派工、定时任务、节点管理、技能清单、记账、备份恢复。

概念层级（详见 `docs/USER-GUIDE.md`）：

```
服务器 ──► 节点（= 一个 DSH agent 进程 + 独立 DSH_HOME）──► 工作区（身份+目录+preset+沙箱）──► 会话
```

- **主脑** = manager 级总控：跨域规划、派工单、查 fleet；对工作区只读，执行永远委托。
- **工作区** = 文件即真相的边界：每个工作区一个 git 仓，每次运行落一次提交（审计留痕）。

## 功能

- **聊天 UI**：多轮对话、流式输出、工具调用卡片、互动提问/授权卡片直接作答；支持端点会显示上下文使用率、会话模型选择及只读/工作区可写访问模式切换
- **主脑派工**：对话式编排 + delegation 帧（点击跳回被派会话）+ 会话复用（同类续接）
- **多节点**：`/nodes` 页全 UI 管控（起/停/重启/日志）+ 向导新增节点 + 侧栏 `N/N` 就绪计数；向导可选节点形态——**容器工蜂（隔离）**或**宿主机进程（整机能力，黄字风险 + 审计）**，宿主机节点依赖装进自己目录、不碰全局 npm
- **多会话并发**：会话内串行、会话间并行（DSH 原生语义 + git 提交锁 + 冲突显性化）
- **定时任务**：cron 自动化、连续失败自动停用、主脑日预算熔断（只拦派工，人工不拦）
- **技能清单**：`/skills` 页按工作区列技能 + 版本对照（= 工作区 git HEAD）
- **站内通知**：铃铛——cron 成败 / 预算熔断 / 主脑任务完成
- **记账**：峰谷计价（**周六周日全天谷价**）、每 run 花费、月度汇总、按工作区分账
- **备份恢复**：手动 `npm run backup` + 一键恢复；自动快照可选（`backup.auto: true` 开启，**默认关闭**——15 分钟 DB 快照 + 保留策略 24h 全留 → 每日 30 天 → 每周 12 周）
- **服务化**：开机自启（Windows 任务计划 / Linux systemd）
- **自更新**：备份 → 拉新 → 构建 → 探活，失败自动回滚
- **原生 GUI 一键直开**：节点页「原生 GUI」卡——一条 SSH 隧道命令（密钥只在你本机）+
  一键打开节点原生界面，0.1.5 的 token 由 manager 自动捕获拼接、重启轮换自动跟随
  （DSH 原生 UI 只绑 loopback，反代不可行——见设计库事实卡 dsh-facts §11）
- **节点级 DSH 版本**：(dsh ↔ facade) 版本矩阵为唯一真相源；建节点可钉版本，
  节点页显示配置版本 + 漂移状态，一键对齐（重建 profile → 重装依赖 → 重启）

## 打开节点原生 GUI（SSH 隧道）

1. 节点页点「配置原生访问」：填一次 SSH 账号 / 主机 / 端口与本地映射端口，
   可选填本机 SSH 私钥路径（命令会带上 `-i`）；
2. 终端执行卡片上的 `ssh -L` 命令（窗口保持打开）；
3. 点「打开 GUI」——新标签页直达该节点的 DSH 原生界面。

**本机节点免隧道**：节点地址是 loopback（127.0.0.1/localhost）时，卡片直接
切成「本机直连」——浏览器与节点同在 loopback，一键直达原生界面（URL 用节点
启动行里自己打印的端口，token 照拼）。

manager 只生成「怎么连」的命令，**SSH 私钥永不进入 manager**（只记录可选的本机
私钥*路径*）；隧道两端都绑 loopback，节点 GUI 端口也只发布在宿主机 127.0.0.1
（不进公网面）。

## 节点级 DSH 版本

节点向导可填 `dsh_version`，按版本矩阵 `SUPPORTED_DSH`（`src/dsh-matrix.ts`——
每行 = DSH 版本 ↔ facade ref 配对）校验：未知版本直接拒绝，未验证配对安装带
黄字警告。每个节点的 profile 钉自己的版本；节点页显示配置版本 + 漂移状态，
「对齐版本」= 重建 profile → 重装依赖 → 按钉版重启。容器节点用镜像
`ohdsh/dsh-node:<version>`。

## 从源码运行（开发者）

前置：Node ≥ 20（推荐 22）、git、DeepSeek Harness（版本见 `COMPAT_DSH_VERSION`）；
节点依赖由 setup 用 npm 安装，无需全局 pnpm。

```powershell
git clone <repo-url>
cd dsh-agent-manager
npm install
npm run setup          # 自检表（node/git/dsh）+ 初始化工作区/节点/配置
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
| `README.md` | 本 README 的英文版 |
| `CHANGELOG.md` | 变更记录 |

> **本仓库只放用户面文档。** 设计稿、路线图、实施计划、评审记录、发布流程、
> 上游行为事实卡均在不公开的内部设计库。**已交付的能力看 `CHANGELOG.md` 与
> GitHub Release，不对未发布的功能做公开承诺。** 代码、配置样例与用户手册
> 即完整的可运行、可自托管交付物。

## 测试

```powershell
npm test   # 全绿（数量由 CI 断言，不手写）
```

## License

MIT
