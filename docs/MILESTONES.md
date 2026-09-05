# 「蜂群计划」里程碑总纲（v1 之后的路）

> 编制于 2026-09-04。本文档 = 唯一的路线图真相源，收口以下文档的全部结论：
> `notes/BRAINSTORM-MULTIAGENT.md`（概念与决策台账）、`notes/PLAN-MULTIAGENT.md`（P0–P4 任务计划）、
> `notes/REPORT-FLEET-ROADMAP.md`（节点/服务器/FinOps 调研）、`notes/TASKS.md`（实施进度）。
> 原则不变：① 先修路再跑车；② 每里程碑独立交付、可验收、可回滚；③ 模型只建议、代码才决定；
> ④ 文件是唯一真相源；⑤ 能简化就简化；⑥ 审计留痕。

## 0. 定位：三条线，一个产品

| 线 | 角色 | 状态 |
| --- | --- | --- |
| A · 个人/小团队自托管 | 本机多 agent 管理器（manager + 主脑 + N 节点） | **v1 已实现，待验收发布** |
| B · AI 中台（公司内） | 给现有产品提供 agent 集群能力：网关/路由/负载均衡/故障转移/分账 | M6，触发制 |
| C · 大规模集群 | 万级节点 | 远景，只记设计原则 |

## 1. 里程碑总览

| 里程碑 | 内容 | 时机 | 验收一句话 |
| --- | --- | --- | --- |
| **M0 · v1 真实验收** | P0 沙箱部署验收 + P4 第 0–4 幕 + 环境清理（会话迁移 / note-kaka revert / 首次备份） | 现在 | 全幕通过，连续 3 天日常使用无阻断 bug |
| **M1 · 平台化小件** | P5.1 节点管控 UI+日志+预算熔断；P5.2 skill 仓库+/skills 页；P5.3 会话复用+通知 v0；**P5.4 同 agent 多会话并发（跟随 DSH 名额，git 层兜底，重点）**；**P5.5 新增节点/agent 向导** | 1.5–2 周 | 节点/技能全 UI 可管；同一 agent 多会话真并行且写不冲突；向导加节点 5 分钟可用 |
| **M2 · v1.0 正式发布** | P6 一键安装补全（服务化+`ohdsh update`+备份恢复）+ E2E 冒烟 + 发布物料（README/官网/许可） | M1 后约 1 周 | 新机器一条命令 5 分钟可用；发布物齐整 |
| **M3 · FinOps** | LiteLLM 侧车（吞吐放大器：多 key/多模型/降级）+ 按节点分账 | 触发：撞限流/多供应商 | 多 key 轮询与降级生效 |
| **M4 · 多账户与团队** | 人类/服务账户双层 + 组 + 配额 + 审计日志 | 触发：第二个人要用 | 两个账户互不可见对方 agent；一切操作留痕 |
| **M5 · 跨机 v2** | 多机形态：node-agent（宿主机服务，内建 docker/process 双 runner，进程 runner 预留后话）+ 每节点容器 + 拓扑视图 + server 生命周期 + 监控告警（网络：VPC 私网优先，跨网络 Tailscale/WireGuard overlay） | 触发：第一个真实异地需求 | 第二台机器上的节点在拓扑里可管可控 |
| **M7 · 部署与分发** | 文档公开面修复（docs 拆分 + README 一致性）+ 单机全栈容器化（manager + 节点 + nginx，一条 compose 拉起）+ DSH 版本治理（COMPAT 常量 / setup 校验 / 节点版本告警） | 现在（v1.0 后第一批） | 新机器 `docker compose up -d` 5 分钟可用；README 无死链 |

> **M7 = 蜂群2计划**，任务分解与开发真相源见 `notes/PLAN-HIVE2.md`（P0–P6）；旧 `notes/TASKS.md` 已归档。
| **M6 · AI 中台网关** | 对外公开 API（OpenAI 兼容）+ 路由/负载均衡/故障转移/会话粘连/按调用方分账 + SLO | 触发：公司产品接入需求 | 现有产品零改造接入一个 agent 集群 |
| 远景 · 万级节点 | 分层控制面/聚合心跳/配置拉模式/存储升级/分区分脑 | 规模信号出现才动 | — |

**正式对外发布时间 = M2 完成**，预计 **M0 验收顺利的话 3–4 周后**，发布物 = GitHub Release v1.0 + npm `ohdsh` + 文档站。定位口径：面向个人/小团队的本地多 agent 管理器（A 线）；中台与万级在路线图上但**不承诺 v1.0 交付**，避免过度承诺。

## 2. M2（v1.0）发布门槛清单

1. M0 全幕验收 + 3 天日常使用无阻断；
2. P6：manager 服务化（WinSW / systemd）、`ohdsh update`（备份→换新→探活失败自动回滚）、
   `ohdsh backup/restore`（15 分钟级 DB 快照 + 五层备份物，**并实际做一次「备份→异地目录恢复→集群可用」演练**——DR 是发布门槛，不是口号）；
3. 一条前端 E2E 冒烟（登录→主脑派活→delegation 帧→直连会话）；
4. 许可确认（DESIGN §8 遗留的 MIT 问题）、README + 安装/使用/排障文档、官网一页；
5. semver + changelog 起步；数据库迁移向下兼容承诺；`stable`/`beta` 灰度通道。

## 3. 议题记录（本轮新收，只定原则不动工）

### 3.1 AI 中台网关（M6）

- **已有地基**：`agent.public` 标志、API key 路由（`run.apiKeyId` / `trigger='api'`）、
  薄网关 loopback proxy 思想、LiteLLM 同款 OpenAI 兼容面——中台不是新楼，是这几块的正面出口。
- **能力面**：路由（**会话粘连**：同一会话固定同一 agent 实例；**用户粘连**：同一调用方固定分片；
  健康路由）、负载均衡（同构副本池）、故障转移（沿用 BRAINSTORM §2.4 裁决：**优雅转移，不做热迁移**）、
  按调用方分账与配额。
- **纪律**：对外 API 版本化契约（`/v1`），发布即冻结；SLO 三指标（可用性 / P95 派工延迟 / 派工成功率）——中台立身之本；审计全留痕。
- **前置**：M5 跨机 + M4 多账户（调用方身份是分账与配额的前提）。

### 3.2 大规模集群（远景，只记原则）

- 控制面分层：区级 manager + 全局只读视图，拒绝单点。
- 心跳/指标聚合上报（节点→server→区），避免 1 万心跳打爆控制面。
- 配置分发 = 拉模式 + 版本号（期望状态 git），拒绝广播。
- 存储：SQLite → Postgres（TASKS.md C 阶段已记）；run/usage 归档列式。
- 节点调度：**记录决策点**——节点容器化后，万级大概率直接托管 k8s/Nomad，
  manager 只做应用层控制面；自研调度仅当评估证明薄调度更优。
- 主脑联邦：分区分脑 / 每租户一脑。

### 3.3 CLI + 基础设施即代码 + 数据/配置分离（并入 M2 的 P6）

- `ohdsh` CLI 为唯一操作面：`setup` / `apply -f fleet.yaml`（期望状态声明：diff → dry-run → 确认执行，
  延续「模型只建议、代码才决定」）/ `node add|rm|up|down|logs` / `backup` / `restore` / `update`。
- **数据与配置分离**：配置 = git 仓（fleet.yaml + 各节点 profile）；数据 = 节点 home（会话/凭据）+
  manager.db（账本/审计）+ 工作区 git。两者备份物分开打包。
- **DR 目标**：机房没了 → 新机 `ohdsh apply` + `ohdsh restore` → 分钟级恢复整套集群（M2 演练验证）。

### 3.4 数据层治理：git 即真相，分四层（2026-09-04 定）

| 层 | 数据 | 处理 |
| --- | --- | --- |
| 真相态（进 git） | 工作区文件（看板/笔记/产出）、fleet.yaml、profile 配置、DB schema 迁移（代码） | 直接提交 |
| 快照态（导出进 git） | 账本 usage_record、run 摘要、会话元数据 | `ohdsh export` 定时导出 JSONL → 私有仓，**每晚一个 commit = 版本化审计留痕** |
| 运行态（不进 git） | SQLite 行数据、会话 transcript、队列 | 本地 + 定期备份文件 |
| 秘密（永不进 git） | 密钥、.env、settings.yaml、私密会话 | 本地 only，备份走加密包 |

- **数据库表版本管理** = schema 走 git（已实现：`schema_version` + 显式迁移在 `src/db`）+
  行数据走快照导出。**SQLite 二进制永远不进 git**（不可 diff/merge，且会泄露密钥）。
- **远端策略两步走**：前期远端自由配置（GitHub/Gitee/自建/无远端——git 本地优先，远端只是备份与同步）；
  后期 manager 托管 **Gitea 容器**（开源、单容器、VPC 内网）作为第一公民节点——落在 M5 的 Docker 架构里，
  内网 git 快且数据不出门。
- **安全红线**：① 密钥/`.env` 结构上就进不了 git（.gitignore + 导出默认排除）；② 私密 transcript 默认不出本地，
  只有用户显式开启的归档仓才收；③ 共享看板仓与私有仓分开建（M4 起，共享仓即「组」的载体）。
- 排期影响：M2 的 P6 增加 `ohdsh export` + `git remote` 配置；Gitea 托管容器并入 M5。

### 3.5 数据库备份（M2 P6 重点）

- **事实**：manager.db = SQLite + WAL（better-sqlite3），当前**无任何备份**——数据是账本与审计的命根子。
- **在线备份**：`db.backup()`（better-sqlite3 原生 API，WAL 下一致快照、不停机）；配合周期 `wal_checkpoint` 与备份文件体积控制。
- **策略**：每 15 分钟快照 + `ohdsh update`/迁移前强制快照；保留 24h 小时级 + 30 天日级 + 12 周周级；快照落本地备份目录，加密包可选远端/对象存储。
- **备份物五层**：① DB 快照；② 账本 JSONL 导出进 git（§3.4，审计/对账）；③ 配置仓 git；④ 工作区各 git 远端；⑤ 节点 home（会话）加密打包。
- **目标**：RPO ≤ 15 分钟，RTO ≤ 5 分钟（restore 一条命令）。**恢复演练 = M2 发布门槛**——「备份过」不算数，「恢复过」才算。

### 3.6 同 agent 多会话并发（M1 P5.4，重点，2026-09-04 拍板）

- **事实澄清**：单点 DSH 本身支持多会话并行；manager 目前每 agent 并发=1（会话回合排队、派工 409）——
  这是当年防「同工作区并发写竞态」的安全选择，代价是能力上低于单点 DSH。裁决：**DSH 怎么做我们就怎么做，
  我们只是多了 git 层**——manager 不再人为设并发上限，上限 = gateway 自身的会话名额（DSH 的能力边界）。
- **git 层三件套（相对单点 DSH 的唯一增量）**：
  1. **提交串行化**：每 agent 一把提交锁——回合并行，git 快照/提交排队执行（git index.lock 天然互斥，
     manager 显式串行化）。写盘提交是排队点，其余全程并行。
  2. **冲突检测显性化**：run 开始时记录目标文件指纹，提交前比对——被并发 run 改过 → 重读当前版本让模型
     reconcile，或 run 行记 `conflict` 状态上报。绝不静默覆盖。
  3. **会话排队仅作 gateway 满员时的缓冲**：人工 FIFO 队列退役；gateway 容量满了才排队（沿用现有 409 语义）。
- **每 agent 并发配置 K**：默认不设（跟随 DSH 名额）；仅作「收紧」选项——写重 agent 可手动设回 1，
  UI 上标注「此 agent 已限制并发」。
- **与 LiteLLM 解耦**：并发上限是 gateway 名额与上游限流的交集；LiteLLM（M3）只是吞吐放大器。

### 3.7 我补充的点

1. **对外契约纪律**（API 版本化 + 冻结 + changelog）——M6 之前就要立规矩，内部 API 现在还能随便改。
2. **前端自动化测试欠账**：UI 改动全靠人肉验收，发布前至少补一条 E2E 冒烟（M2 门槛），SPA 改造前必须补。
3. **主脑上下文单独记账**（BRAINSTORM §8.2 遗留）：主脑会话最长命，成本持续累积，M3 前定口径。
4. **审计日志表**：登录/配置变更/节点操作/预算调整全留痕——M4 多账户的前提，可提前到 M1 顺手建。
5. **密钥卫生**：token 不进 git、轮换命令、泄露处置流程（发布前自查项）。
6. **合规**：会话数据归属（不进第三方）、模型供应商条款核对。
7. **成本可观测**：预算/花费页持续升级是 FinOps 的仪表盘，别等 LiteLLM 才想起它。
8. **灰度通道**：`ohdsh update --channel stable|beta`，敢发才敢更。
9. **i18n（多语言）**：manager UI/错误提示抽字典（默认英文 + zh 完整），M2 后按需——TASKS 已记，此处收口。
10. **依赖安全扫描**：`npm audit` 纳入发布门槛与 CI；依赖升级跟随 `ohdsh update`。
11. **通知节流**：同事件去重 + 冷却窗口（节点反复掉线只报一次），否则告警变骚扰。
12. **磁盘水位**：DB 增长 + 日志轮转 + 备份目录的水位告警，并入 M5 监控面。

### 3.8 部署形态：三场景、两形态、容器化（2026-09-05 定）

**三个场景**（写入文档作为部署参考，实现上收敛为两种形态）：

| 场景 | 形态 | 网络 |
| --- | --- | --- |
| A · 线上最小闭环 | 形态一 | 同机 loopback；浏览器从家里访问 nginx 公网入口 |
| B · 多台 VPS | 形态二 | 同 VPC 私网优先；跨厂商用 overlay |
| C · 家里机器也入群 | 形态二 | Tailscale/WireGuard overlay（家里机器进不了 VPC） |

**形态一「单机多节点」**：一台机器，全栈容器化，一条 `docker compose up -d` 拉起。
**compose 静态 = 蜂群脊柱**：nginx（入口）+ manager（控制面）+ 主脑（总控）——永远存在的
基础设施，非可增可减的节点。**manager 动态 = 工蜂**：个人与向导新增的节点由 manager 经
docker.sock `docker run` 现拉现管（Portainer 同款模式），向导 / up / down / logs 语义不变。
节点容器只进 compose 内网、不发布端口（DSH Web GUI 不暴露到宿主机）；对外只有 nginx 80/443。
主脑经 compose 声明 = 非托管节点（up/down/restart 409「由 compose 管理」，状态/日志保留
只读）；工蜂带 `com.ohdsh.managed` 标签，manager 启动时对账（认领在跑、补拉缺失）。
节点镜像 tag 单点存 .env（`DSH_NODE_IMAGE`），compose 插值与 manager 共用，升级只改一处。

**形态二「多机多节点」**：每台机器一个 node-agent（manager 伸到远端机器的手）：
执行节点生命周期 / 日志转发 / mux 通路（NAT 后主动反连）/ 注册心跳 / 期望状态自愈。
manager 只对 node-agent 下指令，节点仍是同一镜像。网络优先级：同机 loopback >
同 VPC 私网 > Tailscale/WireGuard overlay > 公网+TLS（最后手段，能不用就不用）。
用户流程与关键设计（join token 注册 / agent 主动拨号 / 工作机零入站端口）见
`notes/M5-MULTIMACHINE-DESIGN.md`（讨论稿，未动工）；`spawn` 预留远程形态接口。

**容器化单元** = 一个容器一个 DSH 节点（DSH + gateway + 独立 DSH_HOME），版本钉死在
镜像 tag（`ohdsh/dsh-node:<DSH 版本>`）；构建期 pnpm 安装 + 锁文件冻结，运行时零安装
——根治 profile 依赖漂移（bundle 无版本号 + gateway 走 github: master，裸机每次
`pnpm install` 都在拉最新）。

**能力边界**：工作区 bind mount + 工具集镜像预装 + DSH_HOME 卷持久化；不摸宿主机
全盘（分布式下是安全收益而非损失）；docker-in-docker 不支持（此类技能留给宿主机侧）。

**安全边界**：manager 容器挂 docker.sock = 宿主机 root 等价权——自托管单机形态接受，
文档明示；多机形态该权限收敛到 node-agent。nginx 沿用 install.sh 三套 TLS 模板，
Caddy（自动签证书）列为备选。

**DSH 升级治理**：`COMPAT_DSH_VERSION` 单点声明 + setup 版本校验（
`--skip-version-check` 放行）+ 节点 hostVersion 告警 + 月度对齐窗口（不追最新）；
升级 = 换镜像 tag 滚动替换，回滚秒级。

## 4. 开放问题台账（收口全部遗留）

| 来源 | 问题 | 状态 |
| --- | --- | --- |
| BRAINSTORM §8.2 | 主脑派工续接 vs 新建 | ✅ 已定（P5.3：同类续同名、空会话复用、明说新任务才新建） |
| BRAINSTORM §8.2 | delegation 帧深链粒度（会话级 vs 消息级） | 先会话级（现状）；消息级等上游 trace，M3 后议 |
| BRAINSTORM §8.2 | brain 会话上下文单独记账 | M3 前定（见 §3.7 第 3 条） |
| BRAINSTORM §8.2 | product 挪到服务器（第一个多机场景） | = M5 触发器 |
| §8.3 借用 1 | 派工单结构化（目标/验收标准） | M1 后（P2 观察期已过，主脑真实使用数据在手再做） |
| §8.3 借用 2 | 主脑派工预算熔断 | **M1（P5.1）** |
| §8.3 借用 3 | run 执行轨迹展示 | M1 后（数据 DSH 已有，只读展示） |
| §8.3 借用 4 | 行为异常告警（token 飙升/外部访问） | M5 一起做 |
| REPORT §7.4 | 并发槽位池 K | **M1（P5.4，重点，与 LiteLLM 解耦）** |
| REPORT §7.1 | LiteLLM 接入时机 | M3 触发制（限流/多供应商，纯吞吐放大器） |
| REPORT §7.6/7.7 | skill 仓库 / 插件只读展示 | M1（P5.2）/ M1 后 |
| 本轮 | SPA 无刷新切换 | 单独评估，未排期 |
| 本轮 | 万级集群 | 远景，只记原则（§3.2） |
| 本轮 | AI 中台网关 | M6 触发制（§3.1） |
| 本轮 | IaC/CLI/DR | 并入 M2 P6（§3.3） |
| 本轮 | 数据层四层治理 / 快照导出 / Gitea 托管 | §3.4；`ohdsh export`+remote 并入 M2 P6，Gitea 容器并入 M5 |
| 本轮 | 数据库备份（15 分钟快照 / RPO/RTO / 恢复演练） | §3.5；并入 M2 P6 |
| 本轮 | 同 agent 多会话并发（跟随 DSH + git 层兜底） | §3.6；M1 P5.4 重点 |
| 本轮 | 新增 DSH 节点（向导 + 热加载 + 删除） | **M1 P5.5**：P5.2/P5.3 之后；抽 setup 生成逻辑为可复用模块，只做「增」的运行时热加载（改/删重启），失败自动回滚，节点与 agent 一个向导两个入口 |
| TASKS | i18n 多语言 | §3.7 第 9 条；M2 后按需 |

## 5. 相关文档索引

- 概念与决策：`notes/BRAINSTORM-MULTIAGENT.md`（§8 台账）
- 实施计划：`notes/PLAN-MULTIAGENT.md`（P0–P4）
- 节点/服务器/FinOps 调研：`notes/REPORT-FLEET-ROADMAP.md`
- 进度日志：`notes/TASKS.md`（已归档）
