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

# 安装目录 = 执行本脚本时所在的目录（cd 到哪装到哪；APP_DIR 环境变量可覆盖）。
APP_DIR="${APP_DIR:-.}"
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
log "install dir: $(pwd)"
confirm "Continue?" || { log "aborted."; exit 0; }

# 家目录本身拒绝默认安装：避免把 docker-compose.yml/.env/workspaces 摊一屋子
if [ "$APP_DIR" = "." ] && [ "$(pwd)" = "$HOME" ]; then
  echo "[install] 检测到你在家目录（$HOME）里执行——请先建一个专用目录再跑："
  echo "           mkdir -p ~/appx && cd ~/appx && bash ~/install.sh"
  echo "          （确要装进家目录本身：设 APP_DIR=\$HOME 重跑。）"
  exit 1
fi

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
if ! command -v git >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
  log "git not found."
  confirm "Install git (apt)?" || { log "aborted (git required for fallback)."; exit 1; }
  run apt-get update -qq
  run apt-get install -y git
fi
if [ -f "$APP_DIR/docker-compose.yml" ]; then
  log "skip (exists): $APP_DIR"
else
  log "Downloading release bundle ${OHDSH_VERSION}..."
  run mkdir -p "$APP_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: curl ${RELEASE_BASE}/ohdsh-compose.zip"
  elif curl -fsSL "${RELEASE_BASE}/ohdsh-compose.zip" -o /tmp/ohdsh-compose.zip 2>/dev/null; then
    unzip -q -o /tmp/ohdsh-compose.zip -d "$APP_DIR"
    rm -f /tmp/ohdsh-compose.zip
    log "bundle unpacked."
  else
    # 发布包尚不存在（tag 未打）或下载失败：回退到源码克隆。
    # 绝不 rm -rf 安装目录（APP_DIR=. 时会删掉用户当前目录本身）——克隆进临时目录再搬入。
    log "release bundle unavailable — falling back to git clone (master)"
    TMP_CLONE="$(mktemp -d)"
    run git clone --depth 1 https://github.com/litestartup-com/dsh-agent-manager.git "$TMP_CLONE"
    run cp -a "$TMP_CLONE"/. "$APP_DIR"/
    run rm -rf "$TMP_CLONE"
  fi
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

# ---- domain / TLS（留空 = 纯 HTTP 直连；给了域名会自动问 TLS 模式）----
if [ -z "$APP_DOMAIN" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: domain not provided — plain HTTP"
  else
    read -rp "Public domain (empty = plain HTTP, no TLS): " APP_DOMAIN || true
  fi
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
    # 评审 B2：docker.sock 由宿主机 dockerd 解析 bind 路径——host_volumes 里
    # 行首的 /opt/ohdsh/workspaces（= 宿主机路径）必须换成宿主机真实绝对路径；
    # 冒号右侧（= 节点容器内路径）与 agents.workspace 保持 /opt/ohdsh/... 不变。
    sed -i -e "s|^\( *\)/opt/ohdsh/workspaces|\1${APP_DIR_ABS}/workspaces|g" manager.config.yaml
    log "created: manager.config.yaml (host workspace path pinned to ${APP_DIR_ABS}/workspaces)"
  fi
  # 节点容器与宿主机部署用户同 uid（工作区写权限两边一致；root 服务器 = 0）
  grep -q '^HOST_UID=' .env || echo "HOST_UID=$(id -u)" >> .env
  grep -q '^HOST_GID=' .env || echo "HOST_GID=$(id -g)" >> .env
fi

# ---- optional nginx TLS ----
if [ -n "$APP_DOMAIN" ]; then
  if [ -z "$TLS_MODE" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      TLS_MODE=origin-ca
    else
      read -rp "TLS mode — origin-ca (Cloudflare Origin CA, default) / letsencrypt / none (CF Flexible) [origin-ca]: " TLS_MODE || true
      [ -n "$TLS_MODE" ] || TLS_MODE=origin-ca
    fi
  fi
  log "nginx: domain=$APP_DOMAIN tls=$TLS_MODE"

  if [ "$TLS_MODE" = "origin-ca" ]; then
    # 证书约定位置 = <安装目录>/ssl/cert.pem 与 key.pem（文档明示，可提前放置）；
    # 也支持交互输入现有证书路径，或 SSL_CERT_SRC/SSL_KEY_SRC 环境变量指定。
    # 新用户从 Cloudflare 下载的证书（SSL/TLS → Origin Server）直接放进约定位置即可。
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY: ensure cert/key (canonical: $APP_DIR_ABS/ssl/{cert,key}.pem, or prompt for paths)"
    else
      mkdir -p "$APP_DIR_ABS/ssl"
      CERT="$APP_DIR_ABS/ssl/cert.pem"
      KEY="$APP_DIR_ABS/ssl/key.pem"
      if [ ! -f "$CERT" ]; then
        if [ -n "${SSL_CERT_SRC:-}" ]; then
          if [ -f "$SSL_CERT_SRC" ]; then
            cp "$SSL_CERT_SRC" "$CERT" && log "cert copied from $SSL_CERT_SRC"
          else
            echo "[install] SSL_CERT_SRC 指向的文件不存在：$SSL_CERT_SRC"; exit 1
          fi
        else
          read -rp "证书文件路径 cert.pem（回车 = $APP_DIR_ABS/ssl/cert.pem）: " CERT_SRC || true
          if [ -n "$CERT_SRC" ]; then
            if [ -f "$CERT_SRC" ]; then cp "$CERT_SRC" "$CERT"; else echo "[install] 找不到证书文件：$CERT_SRC"; exit 1; fi
          fi
        fi
      fi
      if [ ! -f "$KEY" ]; then
        if [ -n "${SSL_KEY_SRC:-}" ]; then
          if [ -f "$SSL_KEY_SRC" ]; then
            cp "$SSL_KEY_SRC" "$KEY" && log "key copied from $SSL_KEY_SRC"
          else
            echo "[install] SSL_KEY_SRC 指向的文件不存在：$SSL_KEY_SRC"; exit 1
          fi
        else
          read -rp "私钥文件路径 key.pem（回车 = $APP_DIR_ABS/ssl/key.pem）: " KEY_SRC || true
          if [ -n "$KEY_SRC" ]; then
            if [ -f "$KEY_SRC" ]; then cp "$KEY_SRC" "$KEY"; else echo "[install] 找不到私钥文件：$KEY_SRC"; exit 1; fi
          fi
        fi
      fi
      if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
        echo "[install] 还缺证书/私钥（Cloudflare 用户：SSL/TLS → Origin Server → Create Certificate 下载）："
        echo "           1) 放进 $APP_DIR_ABS/ssl/cert.pem 与 $APP_DIR_ABS/ssl/key.pem 后重跑（幂等）；"
        echo "           2) 或重跑时直接输入两个文件路径；"
        echo "           3) 或设 SSL_CERT_SRC/SSL_KEY_SRC 环境变量后重跑。"
        exit 1
      fi
      chmod 600 "$KEY"
      # 反代上 HTTPS 后 manager 必须开 secure cookie
      grep -q '^NODE_ENV=' .env 2>/dev/null || echo 'NODE_ENV=production' >> .env
    fi
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: write deploy/nginx/default.conf"
  else
    case "$TLS_MODE" in
      origin-ca) SRC=tls-origin-ca.conf ;;
      letsencrypt) SRC=tls-letsencrypt.conf ;;
      *) SRC=tls-none.conf ;;
    esac
    sed -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
        -e "s|__SSL_CERT_PATH__|$SSL_CERT_PATH|g" \
        -e "s|__SSL_KEY_PATH__|$SSL_KEY_PATH|g" \
        "deploy/nginx/$SRC" > deploy/nginx/default.conf
    log "nginx config written ($SRC)"
    NGINX_CONFIG_WRITTEN=1
  fi
fi

# ---- up ----
run docker compose up -d --build
# 重跑场景：default.conf 是 bind mount，文件变了 nginx 不会自己 reload
if [ "${NGINX_CONFIG_WRITTEN:-0}" = "1" ] && [ "$DRY_RUN" != "1" ]; then
  run docker compose restart nginx
fi

cat <<EOF

============================================================
Installed. (first boot pulls images — a few minutes on a fresh box)
  dir:     $APP_DIR_ABS
  watch:   cd "$APP_DIR_ABS" && docker compose logs -f manager
  manager: http://127.0.0.1:$MANAGER_PORT  (nginx on :80/:443 when domain set)
  login:   user \$(grep '^MANAGER_USERNAME=' .env | cut -d= -f2)
           password \$(grep '^MANAGER_INITIAL_PASSWORD=' .env | cut -d= -f2)
           (first login forces a password change)
============================================================
EOF
