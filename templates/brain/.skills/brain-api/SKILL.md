---
name: brain-api
description: manager 内部 REST API 执行手册——查各 agent 状态、派工、看大盘、读花费、起草定时任务。当你需要观察整个 fleet 或派活给其他 agent 时使用。
---

# brain-api：manager 内部 REST API（主脑执行手册）

## 前置

- manager 地址：`http://127.0.0.1:8080`
- 每个请求都要带头部：bash 用 `X-Brain-Token: $BRAIN_TOKEN`，pwsh 用 `X-Brain-Token: $env:BRAIN_TOKEN`。
  `BRAIN_TOKEN` 在环境变量里——**直接用变量引用，绝不打印它的值、绝不把它写进文件**。
- 错误码读法：
  - `401` = token 不对（检查头部拼写，不打印 token）
  - `403` = 非本机调用（不应发生）
  - `409` = agent 忙或重名——**读 `detail` 原样转述给用户，不重试硬闯**
  - `404` = 目标不存在（agent/chat 名写错）
  - `400` = 请求体或 cron 表达式有误——读 `detail` 修正

## 调用模式：先写 JSON 文件，再 curl，绝不手拼长 JSON

bash（Linux / macOS / Git Bash）：

```bash
cat > /tmp/req.json <<'EOF'
{"agentId":"personal","prompt":"把这周开销汇总写进周报"}
EOF
curl -s -X POST http://127.0.0.1:8080/api/internal/dispatch \
  -H 'Content-Type: application/json' \
  -H "X-Brain-Token: $BRAIN_TOKEN" \
  --data @/tmp/req.json
```

pwsh（Windows）：

```powershell
@{ agentId='personal'; prompt='把这周开销汇总写进周报' } |
  ConvertTo-Json | Set-Content "$env:TEMP\req.json" -Encoding utf8
curl.exe -s -X POST http://127.0.0.1:8080/api/internal/dispatch `
  -H 'Content-Type: application/json' `
  -H "X-Brain-Token: $env:BRAIN_TOKEN" `
  --data "@$env:TEMP\req.json"
```

GET 类请求直接 curl，不需要文件。

## 端点速查

| 端点 | 用途 | 关键返回 |
| --- | --- | --- |
| `GET /api/internal/agents` | 各 agent 状态 | `agents[]`：`id`/`name`/`busy`/`runningRunId`/`chatCount`/`spendMicroUsd` |
| `GET /api/internal/agents/:id` | 单 agent 详情 | `preset`/`sandboxMode`/`endpoint`/`recentRuns` |
| `GET /api/internal/agents/:id/board` | 只读大盘 | `pages`/`blocks`（board JSON） |
| `GET /api/internal/usage` | 本月花费 | `totals`/`byAgent`/`byModel`（单位微美元，1e6 = $1） |
| `GET /api/internal/agents/:id/chats` | 会话列表 | `chats[]`：`id`/`title`/`turns` |
| `GET /api/internal/chats/:id/summary` | 会话摘要 | `title`/`state`/`turns`/`lastRun` |
| `POST /api/internal/dispatch` | 派工（同步等结果，可能几分钟） | body `{agentId, prompt, sourceChatId?}` → `{runId, state, summary, costMicroUsd, error}` |
| `POST /api/internal/crons` | 起草定时任务 | body `{agentId, name, schedule, timezone?, prompt}` → **默认停用**，提醒用户去确认 |

## 典型流程

1. **先查状态再派工**：`GET /api/internal/agents`。目标 `busy=false` 才 dispatch；`busy=true` 就告诉用户「谁正忙（run xxx）」，不硬派。
2. **派工**：`POST /api/internal/dispatch`，body 里 `sourceChatId` 填你当前会话的 id（用户界面会提供；没有就省略）。
   - `state=done` → 用 `summary` 回报用户，引用 `runId`；
   - `state=failed` → 读 `error` 转述，不自动重试；
   - `409 agent_busy` → 转述 `detail`。
3. **起草定时任务**：`POST /api/internal/crons` → 成功后说「已起草，请在定时任务页确认启用」。schedule 是 5 段 cron 表达式（分 时 日 月 周），时区默认 `Asia/Shanghai`。
4. **看大盘**：`GET /api/internal/agents/personal/board`，直接引用返回里的数字回答用户。
5. **看花费**：`GET /api/internal/usage`，注意微美元换算（1e6 微美元 = $1）。

## 派工判据（与 AGENTS.md 一致）

个人 = 笔记/记账/健康/交易/周报；企业 = 战略/OKR/会议/项目；产品 = 博客/文档/changelog/邮件。
不确定归谁先问用户，不猜。
