#!/usr/bin/env bash
# Oh! dsh — one-command install (Ubuntu 24, single-host container form:
# nginx + manager + 主脑 spine; the 个人 worker is created by the manager).
#
# Usage:
#   curl -fsSL https://get.ohdsh.com/install.sh -o install.sh && bash install.sh
#   # one-liner for the impatient: curl -fsSL https://get.ohdsh.com/install.sh | bash
#
# Idempotent: Docker present → skipped; .env existing → never overwritten.
# Non-interactive: DEEPSEEK_API_KEY / MANAGER_PASSWORD / MANAGER_PORT / APP_DOMAIN /
# TLS_MODE / OHDSH_VERSION can be preset via environment; only the missing ones prompt.
# Plan-only pass: DRY_RUN=1 bash install.sh
#
# Note: output is intentionally English — a minimal server locale (LANG=C)
# would garble non-ASCII text (the one sanctioned exception to 默认中文).
set -euo pipefail

APP_DIR="${APP_DIR:-./ohdsh}"
OHDSH_VERSION="${OHDSH_VERSION:-v1.0.1}"
RELEASE_BASE="https://github.com/litestartup-com/dsh-agent-manager/releases/download/${OHDSH_VERSION}"
MANAGER_PORT="${MANAGER_PORT:-8080}"
DRY_RUN="${DRY_RUN:-0}"
YES="${YES:-0}"
APP_DOMAIN="${APP_DOMAIN:-}"
TLS_MODE="${TLS_MODE:-}"
SSL_CERT_PATH="${SSL_CERT_PATH:-/etc/ssl/ohdsh/cert.pem}"
SSL_KEY_PATH="${SSL_KEY_PATH:-/etc/ssl/ohdsh/key.pem}"
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
MANAGER_PASSWORD="${MANAGER_PASSWORD:-}"

log() { echo "[install] $*"; }
run() { if [ "$DRY_RUN" = "1" ]; then log "DRY: $*"; else "$@"; fi }

confirm() {
  [ "$YES" = "1" ] && return 0
  [ "$DRY_RUN" = "1" ] && return 0
  read -rp "$1 [y/N]: " ANS || true
  case "$ANS" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

# ---- plan first (计划先行) ----
log "plan: Docker (skip if present) → download release ${OHDSH_VERSION} → .env (never overwrite) → compose up"
confirm "Continue?" || { log "aborted."; exit 0; }

# ---- docker ----
if command -v docker >/dev/null 2>&1; then
  log "Docker present, skipping install."
else
  log "Docker not found."
  confirm "Install Docker via get.docker.com?" || { log "aborted (Docker required)."; exit 1; }
  run sh -c 'curl -fsSL https://get.docker.com | sh'
fi
if [ "$DRY_RUN" != "1" ]; then
  docker compose version >/dev/null 2>&1 || { echo "[install] docker compose (v2 plugin) not available."; exit 1; }
fi

# ---- release bundle ----
if ! command -v unzip >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
  log "unzip not found."
  confirm "Install unzip (apt)?" || { log "aborted (unzip required)."; exit 1; }
  run apt-get update -qq
  run apt-get install -y unzip
fi
if [ -f "$APP_DIR/docker-compose.yml" ]; then
  log "skip (exists): $APP_DIR"
else
  log "Downloading release bundle ${OHDSH_VERSION}..."
  run mkdir -p "$APP_DIR"
  run curl -fsSL "${RELEASE_BASE}/ohdsh-compose.zip" -o /tmp/ohdsh-compose.zip
  run unzip -q -o /tmp/ohdsh-compose.zip -d "$APP_DIR"
  run rm -f /tmp/ohdsh-compose.zip
fi

# ---- secrets (唯一人肉输入 = API key) ----
if [ -z "$DEEPSEEK_API_KEY" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    DEEPSEEK_API_KEY="(ask in real run)"
  else
    read -rp "DeepSeek API key (the only required input): " DEEPSEEK_API_KEY || true
  fi
fi
if [ -z "$MANAGER_PASSWORD" ] && [ "$DRY_RUN" != "1" ]; then
  read -rsp "Manager initial password (empty = generate one): " MANAGER_PASSWORD; echo
fi

# ---- .env + config (never overwrite) ----
cd "$APP_DIR"
APP_DIR_ABS="$(pwd)"
if [ "$DRY_RUN" = "1" ]; then
  log "DRY: scripts/gen-env.sh .env + copy manager.config.container.example.yaml"
else
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" MANAGER_PASSWORD="$MANAGER_PASSWORD" bash scripts/gen-env.sh .env
  if [ -f manager.config.yaml ]; then
    log "skip (exists): manager.config.yaml"
  else
    cp manager.config.container.example.yaml manager.config.yaml
    # 评审 B2：docker.sock 由宿主机 dockerd 解析 bind 路径——host_volumes 里的
    # /opt/ohdsh/workspaces 必须换成宿主机真实绝对路径（compose 的 ./workspaces 同指此处），
    # 而 agents.workspace 保持容器内视角（manager 挂载点）不变。
    sed -i -e "/host_volumes:/,/named_volumes:/ s|/opt/ohdsh/workspaces|${APP_DIR_ABS}/workspaces|g" manager.config.yaml
    log "created: manager.config.yaml (host workspace path pinned to ${APP_DIR_ABS}/workspaces)"
  fi
fi

# ---- optional nginx TLS ----
if [ -n "$APP_DOMAIN" ]; then
  if [ -z "$TLS_MODE" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      TLS_MODE=none
    else
      read -rp "TLS mode — origin-ca / letsencrypt / none (Cloudflare Flexible) [none]: " TLS_MODE || true
      [ -n "$TLS_MODE" ] || TLS_MODE=none
    fi
  fi
  log "nginx: domain=$APP_DOMAIN tls=$TLS_MODE"
  if [ "$DRY_RUN" != "1" ]; then
    case "$TLS_MODE" in
      origin-ca) SRC=tls-origin-ca.conf ;;
      letsencrypt) SRC=tls-letsencrypt.conf ;;
      *) SRC=tls-none.conf ;;
    esac
    sed -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
        -e "s|__SSL_CERT_PATH__|$SSL_CERT_PATH|g" \
        -e "s|__SSL_KEY_PATH__|$SSL_KEY_PATH|g" \
        "deploy/nginx/$SRC" > deploy/nginx/default.conf
  fi
fi

# ---- up ----
run docker compose up -d

cat <<EOF

============================================================
Installed. (first boot pulls images — a few minutes on a fresh box)
  watch:   cd $APP_DIR && docker compose logs -f manager
  manager: http://127.0.0.1:$MANAGER_PORT  (nginx on :80 when configured)
  login:   user \$(grep '^MANAGER_USERNAME=' .env | cut -d= -f2)
           password \$(grep '^MANAGER_INITIAL_PASSWORD=' .env | cut -d= -f2)
           (first login forces a password change)
  backup:  docker compose exec manager node dist/../ — see docs/USER-GUIDE.md
============================================================
EOF
