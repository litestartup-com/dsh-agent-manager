# dsh-agent-manager — 设计稿 v0.1（草案）

> 轻量级企业 Agent 管理平面。控制平面自研，数据平面全部复用既有组件。
> 上游依赖：`dsh-api-gateway`（HTTP 数据面）、DeepSeek Harness、LiteLLM、git、Docker。

## 0. 一句话定位

manager **不干活、不懂 AI**，只做四件事：**发钥匙、分工位、记账、转发**。
干活的是 DSH，管代码的是 git，管模型的是 LiteLLM。

## 1. 已验证的上游事实（决定了下面的所有设计）

在 `.dsh/profiles/node_modules/@deepseek-ai/` 与本机 gateway 依赖树上核对过：

| # | 事实 | 依据 | 设计后果 |
| --- | --- | --- | --- |
| 1 | 沙箱写边界**按会话 cwd 解析**，per-call | `dsh-sandbox-policy`："A session cwd is its workspace-write boundary" | 同容器内多会话可各自独立**写**边界 → 一部门一容器成立 |
| 2 | 沙箱模式可**按会话覆盖**，以 `sandbox/mode` 日志事件存储，重启 replay 恢复 | `dsh-sandbox-policy/session-mode` | 无需外部配置存储；manager 可按用户/任务设不同模式 |
| 3 | **读完全不受限**，任何模式都允许读 | `dsh-fs-sandbox`："Reads pass through untouched: every mode permits reading" | 共享容器**只能在同一信任域内**使用 |
| 4 | `workspace-write` 的可写根 = 工作区 + `/tmp` + `os.tmpdir()` | `dsh-sandbox/roots` | 同容器所有会话**共享可写 /tmp** → 跨会话投毒通道 |
| 5 | 网络与进程可见性**不在沙箱语义内** | `dsh-sandbox`："Network and process visibility are outside this vocabulary" | 出网管控必须靠容器/防火墙 |
| 6 | 官方明确**容器是替代这一层的能力边界** | `dsh-sandbox` 模块头 | "每 agent 一容器"与官方设计意图一致 |
| 7 | 默认沙箱模式 = `read-only`（fail-safe） | `dsh-sandbox-policy` Config | agent 要能写必须**显式** opt-in `workspace-write` |
| 8 | **原生 MCP client**：stdio + streamable-http，工具名 `mcp__<server>__<tool>`，每实例一 server | `dsh-mcp-client` | agent 出站能力的**备选**通道（见 4.3 取舍）；不需要 A2A |
| 8b | `web_fetch` 只收 `{ url }`，**GET-only，无 method/headers/body** | `dsh-tool-web/fetch` | agent 想调带鉴权的 REST，**只能走 `bash` + `curl`** |
| 9 | **原生 subagent**：`dsh-subagent` + `dsh-tool-subagent`，子 agent 继承父沙箱覆盖（`source: 'delegation'`） | `dsh-subagent/child-agent` | 单容器内的多 agent 协同已具备；manager 只解决**跨容器** |
| 10 | token 用量随 `assistant/message` 事件上报（`inputTokens`/`outputTokens`/`cacheRead`/`cacheWrite`/`reasoningTokens`） | `dsh-session` + `dsh-llm` `TokenUsage` | 计量数据源已就绪；gateway SSE 与 `gateway/*` 事件均已透出 |

**由此得到的隔离分级（硬性）**

- **共享容器**：仅限**同一信任域**（同部门/同项目组）。可接受"同事之间可读、/tmp 共享"。
- **独占容器**：跨部门、涉密数据、对外产品能力、执行不可信代码 —— 一律 per-session 短命容器。

## 2. 架构

```
用户浏览器 / GitHub Issue / 外部产品
              │
        ┌─────▼───────────────────────────────┐
        │  manager（单进程）                   │
        │  OIDC · 代理+审计 · 配额 · 容器生命周期│
        │  worktree 供给 · 内部 REST · 分发器   │
        └─────┬───────────────────▲───────────┘
              │ REST+SSE          │ bash+curl
    ┌─────────▼─────────┐         │
    │ DSH 容器 × N       ├─────────┘  agent 互调 / RAG 检索
    │ + dsh-api-gateway  │
    └─────────┬─────────┘
              │ OpenAI 兼容
        ┌─────▼─────┐        ┌──────────────────┐
        │  LiteLLM   │        │ git bare repo     │
        │ 账号池/限流 │        │ + per-session     │
        │ /计量      │        │   worktree        │
        └───────────┘        └──────────────────┘
```

自研代码只有 manager 一个进程。部署形态：**docker compose，Linux 主机**（Windows 仅作开发/客户端）。

## 3. 数据模型（Postgres；起步可 SQLite）

```
agent_template   id, name, image, preset, dept, sandbox_mode, isolation('shared'|'per_session'),
                 repo_url, mcp_servers[], max_sessions, quota_tokens_day, created_at
instance         id, template_id, container_id, host, port, gateway_key(enc), state, started_at,
                 last_active_at, dsh_version, gateway_version
session          id, instance_id, user_id, dsh_session_id, worktree_path, branch, state,
                 created_at, ended_at
usage_record     id, session_id, user_id, turn, provider, model,
                 input_tokens, output_tokens, cache_read, cache_write, reasoning_tokens, cost, at
audit_log        id, at, user_id, session_id, action, target, request_digest, outcome
quota            subject_type('user'|'dept'), subject_id, tokens_day, concurrent_max
task             id, source('github'|'manual'), external_ref, template_id, state, deps[],
                 lease_owner, lease_until, attempts
```

`instance.gateway_key` 由 manager 生成并注入容器；**容器端口只绑内网，绝不暴露**。

## 4. 关键流程

### 4.1 一次会话

1. OIDC 认证 → 解析出 user + dept。
2. 查配额（tokens/day、并发数）→ 超限直接 429。
3. 选实例：`isolation=shared` 且同 dept 有空位 → 复用；否则起新容器（compose/docker SDK + 健康探活）。
4. **供给工位**：`git worktree add <base>/<user>/<task> -b agent/<task>`（objects 靠 `--reference` 共享）。
5. `POST /sessions`，`cwd` = worktree 路径，`workspace` = 同路径 → 该会话的**写边界即此路径**（事实 1）。
6. 按模板设 `sandbox_mode`（默认 `workspace-write`；事实 7 提醒：不设就是只读）。
7. 代理 `/messages` 与 `/stream`，逐帧转发给浏览器，同时：
   - `message.usage` → 写 `usage_record`
   - 每次请求 → 写 `audit_log`
8. 会话结束：agent push 分支 → 开 PR → 人/CI 合并 → 回收 worktree。
9. 实例空闲超 TTL → 停容器；下次靠 `POST /sessions/:id/adopt`（`resumed`）冷恢复上下文。

### 4.2 容器侧固定配置（安全基线）

```yaml
# 每个 DSH 容器
dsh-api-gw:
  apiKeys: [<manager 注入>]
  allowKeyProvision: false     # 焊死首调发钥
  allowDiscover: false         # 单密钥模型下，发现=越权
  allowAdopt: true             # 必须开：4.1 步 9 冷恢复与 4.3 回调重投都靠它，
                               # 且 manager 是唯一持钥者、容器端口不出内网
  corsOrigin: <manager 域>
  exposeErrors: false
```

Docker 侧：`--read-only` rootfs、`--cap-drop=ALL`、rootless、cpu/mem limit、
**egress 默认拒绝**（白名单：LiteLLM、git 服务、manager 的内部 REST 端点）。
高危场景上 gVisor/Kata。`/tmp` 用 `--tmpfs` 且 per-container（缓解事实 4）。

### 4.3 agent 互调 —— 统一 REST，经 manager（已定稿）

**全链路只有一个协议：HTTP REST。不用 MCP，不用 A2A。**

两条通道方向相反，别混淆：

| 通道 | 方向 | 载体 | 谁主动 |
| --- | --- | --- | --- |
| **派活** | manager → agent | `dsh-api-gateway` 的 REST（容器的"门铃"） | manager |
| **求助** | agent → manager | `bash` + `curl` 打 manager 内部 REST（agent 的"电话"） | agent 自己 |

`dsh-api-gateway` **承担全部"派活"动作**；agent 出站只是提出请求。二者是一条链的两端，不是竞品。

**A 委派 B 的全链路**

1. A 调 `bash`：`curl -X POST $MANAGER/internal/tasks -d '{"agent":"qa","task":"..."}'`
2. manager 校验：调用者权限、预算余额、**调用深度**、**环检测**、幂等键 → 落 `task` 表，立即返回 `taskId`
3. manager 用 REST 按 B 的门铃：`POST /sessions`（`cwd` = 同分支 worktree）→ `POST /messages` → `GET /stream`
4. B 完成 → manager **回调注入 A 的会话**：`POST /sessions/{A}/messages`，正文 `[任务 t-123 完成] …`
   - A 若已 `turn_end`，注入会**触发新回合** —— 正是想要的唤醒语义
5. 兜底：A 也可以主动 `curl $MANAGER/internal/tasks/{id}`（轮询只作兜底，**不作主路** —— 每次轮询都烧一个回合和一坨 token）

**回调三个必须处理的点**

- **幂等键**：重投会让 A 收到两条相同消息，然后干两遍
- **消息先落库再投递**：A 的容器可能已停 → 等 `adopt` 恢复后重投，否则消息直接丢
- **由 manager 代发回调**，不由 B 直发 —— 否则 B 要持有 A 的密钥（N² 密钥管理）

**为什么不让 A 直连 B**（延迟真成问题时再改）

当前 gateway 鉴权是**单密钥 + 静态密钥列表**，密钥不携带身份。B 只能验"key 有效"，验不出"张三有没有权限用 qa"、该记谁的账、深度到第几层。直连的前置条件是给 gateway 加 **per-key scope**，否则只能 N² 发钥。

**接受的代价**（bash+curl 的固有成本）

- 凭据在容器环境变量里，**shell 能读** → agent 自己能拿到 key
- 参数是模型手搓的 JSON，**无 schema 校验**
- 审计只看到一条 bash 命令，需靠 manager 侧 `audit_log` 补出因果

> MCP（事实 8）能消掉上面三条代价（schema 校验、凭据不过 shell、工具调用天然成为 `tool/call`/`tool/result` 审计事件），代价是多一个协议和一个 MCP server。**当前选择用单协议换简单性**；等审计合规提出要求时，把 manager 的内部 REST 再包一层 MCP server 即可，agent 侧只需在 `cordis.yml` 加一段 `dsh-mcp-client`，**manager 逻辑不用重写**。

**文档只传产物，不当消息总线**：B 把完整报告写到共享只读目录，回调消息里只带路径。理由——写边界各自隔离（事实 1），共享可写目录是新攻击面；文件没有通知机制；因果关系无法审计。

### 4.4 任务分发（GitHub 作控制平面）

- 载体用 **Issues + labels**（不用纯 markdown 文件：Issue 有 API、webhook、权限）
- webhook 触发（不轮询）；`assignee` + `in-progress` label + 心跳评论 = 乐观锁
- **状态只经 manager API 变更**，agent 不许直接改状态（会写坏状态机）
- 依赖/重试/DAG：`task` 表做状态机就够，**不上 Temporal**
- GitLab/Gitea 通过 dispatcher 抽象层适配（私有化客户常用）

## 5. 分阶段里程碑

| 阶段 | 内容 | 判定标准 |
| --- | --- | --- |
| **M1 管理 + 一键化** | 模板表、容器起停、健康探活、worktree 供给 | 一个部门能用起来 |
| **M2 治理** | OIDC、代理审计、usage 落库、配额熔断、仪表盘 | 能回答"谁花了多少钱" |
| **M3 协同** | GitHub Issue 分发、PR 门、`/internal/tasks` 委派 + 回调注入 | 一个任务能全自动走完 issue→PR |
| **M4 能力** | RAG（pgvector + ACL 过滤的检索端点） | 检索不越权 |
| **M5 规模** | 跨机器调度、scale-to-zero 调优、指标导出 | 有真实负载数据后再做 |

**明确不做/缓做**：自建 trace 存储（用 Langfuse）、自建 LLM 计量（用 LiteLLM）、
k8s（M5 前不上）、**MCP server（M3 用 REST 替代，合规提要求时再包一层）**、
**A2A**（只在需要跨厂商互操作时加，且只在 manager 侧加适配器）、多集群。

## 6. 容量与成本

- **并发 ≠ 人数**：一个编码回合内会连发多次工具调用，人均峰值远大于 1。
  按 **3–5 人 / 并发槽** 折算：20 并发 ≈ 5–8 人舒适。
- 瓶颈常先出现在 **DSH 单进程 Node**（session log 读写、文件 IO），不只是模型并发。
- 模型账号池**在 LiteLLM 层**做轮转/排队/重试，DSH 只配一个 `base_url`。
- 空闲容器 300–800 MB → scale-to-zero + 小 warm pool 压首字延迟。

## 7. 待办 / 未决

- [ ] `dsh-api-gateway`：`POST /messages` 幂等键 —— **4.3 回调注入的前置条件，最便宜先做**
- [ ] `dsh-api-gateway`：密钥携带身份 / per-key scope —— **A 直连 B 的前置条件，最关键**
- [ ] `dsh-api-gateway`：出站 webhook（manager 不必长期挂 SSE 也能收到 usage 与"B 干完了"）
- [ ] `dsh-api-gateway`：`/metrics` 与 readiness（容量指标：活跃会话、内存）
- [ ] `dsh-api-gateway`：密钥从 env/file 注入（当前单密钥内存模型，重启丢钥）
- [ ] `dsh-api-gateway`：WebSocket 双工（manager 做长连代理时 SSE 单工别扭）
- [ ] `gateway/message` 的 `messageId` 恒为 `null`（`assistant/message` 映射未取 id）
- [ ] 压测：单 DSH 进程 10–20 路并发会话的真实 CPU/内存；`maxSessions` 打满是拒绝还是排队
- [ ] 核实 DSH 许可与模型服务条款是否允许对外供能力
- [ ] 决策：首要客户是内部部门还是对外产品（两条路架构不通用）
