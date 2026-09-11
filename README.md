# Oh! dsh

> The Swarm Project — a single-host, multi-node local multi-agent manager built on top of DeepSeek Harness.
> Default install = manager (HQ) + brain (chief controller) + personal workspace. One command, up in 5 minutes.

> 中文文档见 [README.zh.md](./README.zh.md)。

## One-line install

**Linux server (containers, recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.0.3/install.sh -o install.sh && bash install.sh
# pros: curl -fsSL https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.0.3/install.sh | bash
```

**Windows (bare metal):**

```powershell
irm https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.0.3/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
# pros: irm https://raw.githubusercontent.com/litestartup-com/dsh-agent-manager/v1.0.3/install.ps1 | iex
```

The scripts are idempotent: already-installed components are skipped, and re-runs never overwrite config or data.
The only input needed is your DeepSeek API key (pre-set `DEEPSEEK_API_KEY=...` for a fully unattended install);
first login forces a password change. Full manual: `docs/USER-GUIDE.md` (Chinese).

## What it is

DeepSeek Harness provides the agent runtime (sessions / tools / sandbox / filesystem); Oh! dsh provides the control plane:
auth, chat relay, brain dispatch, cron jobs, node management, skill inventory, billing, backup & restore.

Concept hierarchy (see `docs/USER-GUIDE.md`):

```
server ──► node (= one DSH agent process + its own DSH_HOME) ──► workspace (identity + dir + preset + sandbox) ──► session
```

- **Brain** = manager-level chief controller: cross-domain planning, work orders, fleet queries; read-only on workspaces, execution is always delegated.
- **Workspace** = files-as-truth boundary: one git repo per workspace, one commit per run (audit trail).

## Features

- **Chat UI**: multi-turn conversation, streaming output, tool-call cards, inline question/authorization answers, context usage, session model selection, and restricted read-only/workspace-write access switching when the endpoint supports it
- **Brain dispatch**: conversational orchestration + delegation frames (click to jump to the delegated session) + session reuse
- **Multi-node**: full UI control on `/nodes` (start/stop/restart/logs) + guided node wizard + `N/N` readiness count in the sidebar
- **Concurrent sessions**: serial within a session, parallel across sessions (native DSH semantics + git commit locks + surfaced conflicts)
- **Cron jobs**: automation, auto-disable after repeated failures, brain daily-budget circuit breaker (blocks dispatch only, never humans)
- **Skill inventory**: `/skills` page lists skills per workspace with version mapping (= workspace git HEAD)
- **In-app notifications**: bell — cron results / budget breaker / brain task completions
- **Billing**: peak/off-peak pricing (**weekends are all off-peak**), per-run cost, monthly summary, per-workspace breakdown
- **Backup & restore**: 15-minute automatic snapshots + retention policy (24h full → daily 30 days → weekly 12 weeks) + one-click restore
- **Service**: auto-start on boot (Windows Task Scheduler / Linux systemd)
- **Self-update**: backup → pull → build → health probe, auto-rollback on failure

## Run from source (developers)

Prerequisites: Node ≥ 20 (22 recommended), git, DeepSeek Harness (version in `COMPAT_DSH_VERSION`);
node dependencies are installed by setup via npm, no global pnpm needed.

```powershell
git clone <repo-url>
cd dsh-agent-manager
npm install
npm run setup          # self-check (node/git/dsh) + initialize workspaces/nodes/config
npm run build
npm start              # start manager, auto-spawns managed nodes
```

## CLI overview

| Command | Purpose |
| --- | --- |
| `npm run setup [--force]` | Initialize / reinstall (`--force` keeps customized workspaces) |
| `npm start` | Start manager (auto-spawns managed nodes) |
| `npm run nodes -- up/down/list/logs <name>` | Node lifecycle (UI on /nodes page) |
| `npm run backup [-- list]` / `npm run restore -- latest` | Backup / restore (probes whether manager is running before restore) |
| `npm run service -- install/uninstall/status` | Auto-start service |
| `npm run update` | Self-update (auto-rollback on failure) |
| `npm test` / `npm run typecheck` | Tests / type check |

## Configuration

`manager.config.yaml` is the single source of truth: `endpoints` (entry + spawn lifecycle for each DSH process),
`agents` (workspace bindings), `runner` (timeouts/silence/budget), `pricing` (peak/off-peak windows + weekend rule),
`brain.daily_budget_usd` (brain dispatch breaker). Secrets live only in `.env` (`GW_KEY_*` / `BRAIN_TOKEN`), never in git.

## Documentation

| Doc | Contents |
| --- | --- |
| `docs/USER-GUIDE.md` | User manual (install / brain / nodes / cron / billing / backup) — Chinese |
| `README.zh.md` | This README in Chinese |
| `CHANGELOG.md` | Changelog |

> **This repo carries user-facing docs only.** Design drafts, roadmaps, implementation plans, review records,
> release procedures and upstream behavior fact cards live in the private internal design library.
> **Delivered capabilities are in `CHANGELOG.md` and GitHub Releases; no public promises for unreleased features.**
> Code, config samples and the user manual are the complete runnable, self-hostable deliverable.

## Tests

```powershell
npm test   # all green (count asserted by CI, not hardcoded)
```

## License

MIT
