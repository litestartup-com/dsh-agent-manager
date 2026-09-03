# Oh! dsh

> Personal / small-team AI agent middle platform on top of DeepSeek Harness.
> Manage agents, chat from any device, schedule work, and track every token you spend.

## Features

- **Chat UI** — multi-turn conversations with streaming output, tool-call cards, and
  interactive questions & permission prompts answered right in the browser
- **Multiple agents** from one declarative config, with personal / company / product templates
- **Schedules** — cron automation with a daily budget cap and peak / off-peak pricing awareness
- **Dashboards** — finance / health / work boards rendered from structured data files
- **Spend tracking** — per-run token usage and cost, monthly summaries
- **Safe writes** — an optional writer layer validates content *before* it hits disk;
  every run snapshots the agent workspace as a git commit
- **DSH native transport** — talks to the harness through its /api (apiproxy) surface on
  loopback, or through `dsh-api-gateway` (>= 0.2.0) for cross-machine and multi-host setups

## How it fits together

```
browser ── Oh! dsh (Fastify + SQLite) ── DSH node(s)
               │   auth · chat relay · runs · schedules · boards · billing
               ├─ scheme A: loopback   http://127.0.0.1:3080/api
               └─ scheme B: cross-host http://<host>:3080/api-gw/v1/proxy (key auth)
```

DeepSeek Harness provides the agent runtime (sessions, tools, sandbox, filesystem);
Oh! dsh provides the control plane (auth, relay, scheduling, dashboards, cost).
The wire contract with DSH /api lives in `src/upstream/` and is verified against
DSH 0.1.1-rc.2.

## Requirements

- Node.js >= 20 (22 recommended)
- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 0.1.1-rc.2+ with its /api surface enabled
- [dsh-api-gateway](https://github.com/litestartup-com/dsh-api-gateway) >= 0.2.0 — only for cross-machine / multi-host setups

## Quick start

```powershell
git clone <repo-url>
cd dsh-agent-manager
npm install
Copy-Item .env.example .env   # fill in secrets and key references
npm run dev                   # serves http://127.0.0.1:8080
```

Open http://127.0.0.1:8080 and log in with the initial user (created on first boot;
see `.env.example` for the full variable list).

### One-command install (Ubuntu 24, node + manager together)

```bash
git clone https://github.com/litestartup-com/dsh-agent-manager.git
cd dsh-agent-manager
sudo ./install.sh     # node container + manager systemd service + smoke scripts
```

See `install.sh` (idempotent, `DRY_RUN=1` for a plan-only pass) and `docker/README.md`
for the manual path.

### Operating it (after install.sh)

| Task | Command |
| --- | --- |
| Manager status | `systemctl status ohdsh-manager` |
| Manager logs | `journalctl -u ohdsh-manager -f` |
| Restart / stop manager | `sudo systemctl restart ohdsh-manager` / `sudo systemctl stop ohdsh-manager` |
| Node container status | `docker compose -f docker/docker-compose.yml ps` |
| Node container logs | `docker compose -f docker/docker-compose.yml logs -f` |
| Restart / stop node | `docker compose -f docker/docker-compose.yml restart` / `... down` |
| Upgrade the code | `git pull && sudo ./install.sh`（idempotent，configs 不被覆盖） |
| Rebuild node image | `docker compose -f docker/docker-compose.yml up -d --build` |

Data locations:

- manager SQLite: `./data`（gitignored）
- node sessions/settings: Docker volume `dsh-data`
- agent workspace: `WORKSPACE_PATH`（default `../workspace` next to the repo）

### Public domain + TLS (Cloudflare etc.)

`install.sh` supports `DEPLOY_ENV=prod`: installs nginx, writes the reverse-proxy config
(SSE unbuffered, long timeouts), configures one of three TLS modes via `TLS_MODE`, and
switches the manager to `NODE_ENV=production` (Secure cookies):

| TLS_MODE | For |
| --- | --- |
| `origin-ca` (default) | Cloudflare proxied + Full (strict): generate the Origin CA files in the CF panel, place them in `/etc/ssl/ohdsh/` |
| `letsencrypt` | certbot auto-issue (domain resolving to the origin, or CF proxied) |
| `none` | Cloudflare Flexible: TLS terminates at the edge, origin stays http |

```bash
DEPLOY_ENV=prod APP_DOMAIN=app.ohdsh.com TLS_MODE=origin-ca sudo ./install.sh
# or interactively: sudo ./install.sh (choose prod, enter domain and TLS mode)
```

Manual reference: `deploy/nginx-manager.conf.example`.

## Configuration

`manager.config.yaml` is the single source of truth:

- `endpoints` — one entry per DSH host (`driver: apiproxy` for the native /api,
  or `driver: gateway` for a legacy dsh-api-gateway instance)
- `agents` — one workspace per agent, with templates under `templates/`
- `runner` — turn timeouts, silence backstop, cron failure budget
- `pricing` — per-model token rates (peak / off-peak windows)

## Testing

```powershell
npm test   # 284 tests, node:test + tsx
```

## License

MIT
