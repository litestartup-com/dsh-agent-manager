# Changelog

## 1.0.1 — 产品级单机版（蜂群2计划，2026-09-05）

从「功能 v1」到「产品级 v1」：一键安装、容器化、安全三件、备份全量、版本治理。

### 部署与分发

- **两条一键命令**：`install.sh`（Ubuntu 容器：nginx + manager + 主脑脊柱）/ `install.ps1`（Windows 裸机），幂等跳过已装组件，唯一人肉输入 = API key
- **容器化**：dsh-node / manager 双镜像（构建期冻结依赖，运行时零安装）+ compose 脊柱 + manager 经 docker.sock 管理工蜂容器（标签对账，向导/起停/日志语义不变）
- nginx 三模式 TLS 模板 + `gen-env.sh` 幂等密钥生成 + 发布包生成器 + 发布清单（`docs/RELEASE.md`）

### 安全（D2/D4）

- **首登强制改密**（既有账号也转正一次）+ 改密页；新密码 ≥ 10 字符
- **CSRF 双提交**：所有非 GET `/api/*` 校验（登录与主脑内部 API 豁免）
- **审计流水**：登录成败 / 改密 / 节点操作 / 备份，侧栏审计页
- `.env` 在 POSIX 上收紧 600

### 备份（D3）

- 节点 home（会话/技能/settings）**加密归档**（AES-256-CBC，密钥派生自 SESSION_SECRET）
- restore 扩展：DB + 节点 home 一并回滚
- DR 演练 `npm run drill`（CI 常驻，实测全链路 0.2s，RTO 目标 ≤ 5 分钟）

### 版本治理（R4）

- `COMPAT_DSH_VERSION` 单点真相源；setup 自检表（node/pnpm/git/dsh 红绿 + 端口占用检查，失败即红字退出，**无半成功态**）
- 节点 hostVersion 告警（/nodes 页黄标 + 日志）；profile bundle 钉版本；gateway 钉 commit
- Linux `detectDshBin` 修复（POSIX `command -v` + `npm root -g`）

### 工程

- docs/notes 拆分（公开 docs/ = 路线图 + 用户手册）、README 重写（零死链 CI 断言、测试数禁手写）
- CI：test + drill + fresh-boot 旅程 E2E + typecheck + audit + build + check-docs
- 测试套件 335 → 360+

## 1.0.0 — 蜂群 v1（2026-09-05）

单主机多节点版正式发布：默认安装 = manager（总办）+ 主脑（总控）+ 个人（工作区），
一条命令、5 分钟用起来。路线图见 `docs/MILESTONES.md`。

### 蜂群核心

- **主脑**：全局协调入口（派工单 / 查 fleet / 起草定时任务），对工作区只读、执行永远委托；
  内部 REST API（仅 127.0.0.1 + `X-Brain-Token`）+ 技能手册（skill + curl，无 MCP）
- **delegation 帧**：主脑会话页可见派工轨迹，点击跳回被派会话；`brain_done` 站内通知
- **会话复用**：同类任务续接同名会话、空会话优先复用（`POST /api/internal/chats/:id/prompt`）
- **主脑日预算熔断**：`brain.daily_budget_usd`（默认 $1/天），只拦派工、人工不拦，409 人话转述

### 多节点（fleet）

- manager 拉起/停止/重启多个 DSH 节点（监督器五态 + 指数退避 + 连续失败停用）
- `/nodes` 页：节点全表 + 起/停/重启 + 日志抽屉；侧栏 `N/N` 就绪计数
- **新增节点向导**：节点 = 工作区成对创建（高级设置折叠自定义），端口自动分配，
  文件先行 + 失败自动回滚；删除 = 解除托管（磁盘目录保留）
- 每节点独立 DSH_HOME / 端口 / gateway 密钥（`GW_KEY_*` 进 `.env`）

### 会话与并发

- 多轮对话（会话 adopt / SSE 中继 / 取消 / 双计费防护）、会话归档与恢复、
  空会话自动清理（vacate）
- **同 agent 多会话并发**：会话内串行、会话间并行（DSH 原生语义 + git 提交锁 +
  冲突显性化 `run.conflict`）
- 首页直达最近会话；归档单跳不双刷新

### 平台化小件（P5）

- `/skills` 技能清单页（文件即真相 + 工作区 git HEAD 版本对照）+ 技能仓库约定位置
- 站内通知（铃铛 + 未读角标）：cron 成败 / 预算熔断 / 主脑派工完成
- 计价：峰谷窗口 + **周六周日全天谷价**（`pricing.weekends_off_peak`）

### 运维（P6）

- 数据库备份/恢复：15 分钟自动快照、保留策略（24h 全留 → 每日 30 天 → 每周 12 周）、
  `npm run backup/restore`
- 服务化：`npm run service -- install/uninstall/status`（Windows 任务计划 / systemd user unit）
- 自更新：`npm run update`（备份 → 拉新 → 构建 → 探活，失败自动回滚）
- E2E 冒烟：`node scripts/smoke.mjs`（登录 → 聊天回合 → 主脑派工 → 通知，全链路）

### 工程

- SQLite 显式迁移 `schema_version`；测试套件全绿（数量由 CI 断言）；前端零构建（hash 版本化资产）
- 文档体系：公开 `docs/`（用户手册 + 路线图）与内部 `notes/`（设计/计划/调研）分层
