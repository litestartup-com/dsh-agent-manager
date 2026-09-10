# Changelog

## 1.0.3 — 0.1.2 切主路（2026-09-10）

> ⚠️ **升级注意**：切主路升级顺序 = **先停栈 → 跑 upgrade 脚本 → 重启 → smoke**。
> 脚本首次运行自动备份 `*.pre-012.bak`（含 `.env`，不入库），出错按备份回滚。
> Linux 容器：`node scripts/upgrade-012.mjs`（manager.config.yaml 接线 + .env 镜像标签）；
> Windows 裸机：`node scripts/upgrade-012-win.mjs`（profile 换 facade / 铸钥 / .env 同步 / 全局 DSH，
> 端口预检被占即拒）。

### 修路（manager 上层重写）

- **SessionDriver 端口化**：上层只依赖端口，facade 驱动成为插头（探活改 probeVersion、release 语义入端口，零行为变化）；拔插头验收 FakeSessionDriver 纯内存驱动 apiproxy 全链路 8 条测试
- **ACP 窄桥**：SDK 客户端中继 + 窄面映射（权限→审批帧；usage/history 缺口入档），假 agent 验收 4 条 + runner 拔插头复跑
- **对账单一化**：reconcileAll 统一入口（镜像/run 收敛/孤儿/fleet/节点认领），boot 与 provision 共用；healOnly 只治 offline；supervisor 运行时健康对账（probeLive 连续失败转 offline，同 tick 自愈）
- **apiproxy prefix 显式配置生效**：0.1.2 facade 接线的先决条件（省略时保留旧默认 /api）

### 0.1.2 切主路

- COMPAT_DSH_VERSION 升 `0.1.2-rc.1`，gateway 0.1.2 门禁化改包名 **ohdsh-api-facade** 全线接线（镜像 / 节点 profile / entrypoint 命名空间 / 默认 tag），endpoints 走 `/api-gw/v1/proxy` + key_ref（与 sandbox_key_ref 同一把钥匙）
- **upgrade-012.mjs**：manager.config.yaml 一次性接线迁移（幂等 / 备份 / 缺钥匙退出码 2 大声失败）+ `.env` 镜像标签迁移（`DSH_NODE_IMAGE→0.1.2-rc.1`、`MANAGER_VERSION→1.0.3`，gen-env 幂等不覆盖旧值所以必须显式升）
- **upgrade-012-win.mjs**：Windows 裸机节点升级（profile 换 facade / 铸钥 / .env 同步 / 全局 DSH），端口预检（8080/3081/3082/3090 被占即拒，EPERM 半毁树教训固化）、`--dry-run` / `--force`、幂等
- 节点 profile 依赖安装 **pnpm→npm**（pnpm@9 预发布区间失效 + pnpm@11 白名单失效，双墙实证；npm 同版本集本机 e2e 全绿）
- Windows setup resolveGatewayKey 切 facade 命名空间（旧 dsh-api-gw 段不读，含回归测试）
- entrypoint 密钥判定加命名空间条件（0.1.1 旧 settings.yaml 残留同 key 串不再误判跳过）
- compose 删 `--trusted-host`（0.1.2 CLI 已删）；镜像 stage-2 用户创建兼容已有 1000:1000
- **双线验证**：Linux 容器集群 + Windows 生产节点 smoke 全 PASS（三节点 apiKeySet:true）
- 文档双语规范落地：README.md（英文）+ README.zh.md（中文）分文件，禁止混排

## 1.0.2 — 安全与部署加固（2026-09-08）

> ⚠️ **升级注意**：本版数据库迁移会把既有账号的 `must_change_password` 置 1——升级后首次登录
> 强制改密。请确认你记得当前密码、或 `.env` 里 `MANAGER_INITIAL_PASSWORD` 仍在；两者都丢失的
> 用户将被锁死（当前无重置途径，只能重建 `data/manager.db` 并丢失运行历史）。

### 安全

- **H1 manager 容器非 root + docker.sock 组级降权 + nginx 内网 ACL**：manager 镜像内建 `USER 1000:1000`；compose 以 `HOST_UID:HOST_GID` 运行并经 `group_add` 注入宿主 docker 组 GID（`DOCKER_GID` 由 gen-env.sh 探测写入 .env）；install.sh 按 HOST_UID 放行 `.env`/`manager.config.yaml`/`data`/`workspaces`；四个 nginx 模板对 `/api/internal/` 加私网 ACL（token 之外的第二道门）。注意：部署用户为 root（HOST_UID=0）时容器仍为 root——完整收口需 socket-proxy/rootless docker（后续）
- **H2 provision 全量回滚**：副作用重排为「准备 → DB → 真相文件 → 内存 → 进程」，任一步失败按相反顺序撤销，杜绝半开通幽灵节点；审计记录失败尝试
- **H3 fleet.md 提交收窄**：`git commit -- fleet.md` 路径限定（用户已 staged 的其它改动绝不被捎带）+ 每 agent 提交锁，不再互踩 index.lock
- **登录限流不再信任转发头**：trustProxy 收紧，轮换 X-Forwarded-For 绕过已封堵（回归测试实证）
- **helmet + CSP `script-src 'self'`** 全套安全头（HSTS 仅 TLS 形态），与前端逐条核对零冲突
- **改密吊销其它会话** + `.env` 抹除初始口令（配合首登强制改密与 CSRF 自愈）
- **BRAIN_TOKEN 落点 `$HOME/.brain-auth`**（0600，不进工作区/不随 git 流动）

### 部署

- **nginx 运行时 default.conf 改为生成物**：模板改名 `default.conf.example`，install.sh 每次重跑生成，gitignore 排除——线上 git pull 不再报 modified。老部署升级：`git checkout -- deploy/nginx/default.conf && git pull`，然后重跑 `bash scripts/gen-env.sh .env`（补 DOCKER_GID）并 `docker compose restart nginx`
- CI 扩展：lint + 前端测试（md.test 进 CI）+ 部署门禁（manager 非 root / group_add / nginx ACL 断言）

### 回归测试

- `fleet-doc.test.ts`：用户预 staged 文件不得进入 manager 提交的断言
- `provision.test.ts`：DB 写入失败 → 六面（内存/监督器/yaml/.env/目录/DB）零残留断言
- `scripts/check-docs.mjs`：manager 镜像 USER、compose group_add/DOCKER_GID、nginx internal ACL 的部署门禁

## 1.0.1 — 产品级单机版（蜂群2计划，2026-09-05）

从「功能 v1」到「产品级 v1」：一键安装、容器化、安全三件、备份全量、版本治理。

### 部署与分发

- **两条一键命令**：`install.sh`（Ubuntu 容器：nginx + manager + 主脑脊柱）/ `install.ps1`（Windows 裸机），幂等跳过已装组件，唯一人肉输入 = API key
- `install.ps1` 带 UTF-8 BOM（发布前实测：无 BOM 时 Windows PowerShell 5.1 按 GBK 读中文 → ParserError，官方推荐路径直接失败）
- `install.ps1` 克隆失败自动回退 codeload zip（发布前实测：国内网络 github.com git/raw 均超时，codeload 可达 200）
- Windows 安装的节点依赖固定 `npx pnpm@9`（发布前实测：全局 pnpm 11 无视构建白名单，原生依赖不构建）；setup 预生成首启密码进 `.env`（隐藏窗口启动下生成密码会丢）
- **容器化**：dsh-node / manager 双镜像（构建期冻结依赖，运行时零安装）+ compose 脊柱 + manager 经 docker.sock 管理工蜂容器（标签对账，向导/起停/日志语义不变）
- nginx 三模式 TLS 模板 + `gen-env.sh` 幂等密钥生成 + 发布包生成器 + 发布清单（维护者内部）

### 安全（D2/D4）

- **首登强制改密**（既有账号也转正一次）+ 改密页；新密码 ≥ 10 字符
- **CSRF 双提交**：所有非 GET `/api/*` 校验（登录与主脑内部 API 豁免）
- **CSRF 自愈**：升级前的老会话缺 csrf cookie 时，服务端 403 补发 + 前端带新 cookie 自动重试一次（Windows 升级改密的 403 现场修复）
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
一条命令、5 分钟用起来。

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
