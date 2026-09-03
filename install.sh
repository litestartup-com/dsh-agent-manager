#!/usr/bin/env bash
# Oh! dsh 一键安装（Ubuntu 24 单机 all-in-one）：DSH 节点容器 + manager 服务
#
# 用法：
#   git clone https://github.com/litestartup-com/dsh-agent-manager.git
#   cd dsh-agent-manager && sudo ./install.sh
#
# 幂等：重复运行不覆盖已有配置（.env / manager.config.yaml / docker/.env 已存在则跳过）。
# 非交互：所有值可用环境变量预置（GW_KEY / SESSION_SECRET / DEEPSEEK_API_KEY /
#          MANAGER_PASSWORD / WORKSPACE_PATH / MANAGER_PORT），缺的才会交互询问。
# 预演：DRY_RUN=1 sudo ./install.sh 只打印将执行的步骤。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_PATH="${WORKSPACE_PATH:-$(dirname "$APP_ROOT")/workspace}"
MANAGER_PORT="${MANAGER_PORT:-8080}"
GW_KEY="${GW_KEY:-}"
SESSION_SECRET="${SESSION_SECRET:-}"
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
MANAGER_USERNAME="${MANAGER_USERNAME:-admin}"
MANAGER_PASSWORD="${MANAGER_PASSWORD:-}"
DRY_RUN="${DRY_RUN:-0}"

RUN_USER="${SUDO_USER:-$(whoami)}"
HOST_UID="$(id -u "$RUN_USER")"
HOST_GID="$(id -g "$RUN_USER")"

log() { echo "[install] $*"; }
run() { if [ "$DRY_RUN" = "1" ]; then log "DRY: $*"; else "$@"; fi }
gen() { openssl rand -hex 32; }

# ---- 前置检查 ----
[ "$(id -u)" = "0" ] || { echo "请用 sudo 运行：sudo ./install.sh"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "未检测到 Docker。Ubuntu 24：https://docs.docker.com/engine/install/ubuntu/ 装好后重跑。"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "缺少 docker compose v2 插件（docker compose 命令不可用）。"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "未检测到 Node.js（需要 >= 20）。安装后重跑。"; exit 1; }
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || { echo "Node.js 版本过旧（$MAJOR），需要 >= 20。"; exit 1; }

log "APP_ROOT=$APP_ROOT"
log "WORKSPACE_PATH=$WORKSPACE_PATH"
log "运行用户 $RUN_USER (uid=$HOST_UID gid=$HOST_GID)"

# ---- 密钥与口令 ----
[ -n "$GW_KEY" ] || GW_KEY="$(gen)"
[ -n "$SESSION_SECRET" ] || SESSION_SECRET="$(gen)"
if [ "$DRY_RUN" = "1" ]; then
  [ -n "$DEEPSEEK_API_KEY" ] || DEEPSEEK_API_KEY="(预演未提供)"
  [ -n "$MANAGER_PASSWORD" ] || MANAGER_PASSWORD="(预演未提供)"
else
  if [ -z "$DEEPSEEK_API_KEY" ]; then read -rp "DeepSeek API Key（留空 = 之后在 DSH GUI 里配）: " DEEPSEEK_API_KEY || true; fi
  if [ -z "$MANAGER_PASSWORD" ]; then
    read -rsp "manager 初始密码（留空 = 自动生成）: " MANAGER_PASSWORD; echo
    [ -n "$MANAGER_PASSWORD" ] || MANAGER_PASSWORD="$(gen | cut -c1-16)"
  fi
fi

# ---- 生成配置（已存在不覆盖） ----
if [ -f .env ]; then
  log "跳过（已存在）：.env"
else
  sed -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESSION_SECRET|" \
      -e "s|^MANAGER_USERNAME=.*|MANAGER_USERNAME=$MANAGER_USERNAME|" \
      -e "s|^MANAGER_INITIAL_PASSWORD=.*|MANAGER_INITIAL_PASSWORD=$MANAGER_PASSWORD|" \
      -e "s|^GW_KEY_A=.*|GW_KEY_A=$GW_KEY|" \
      .env.example > .env
  log "生成：.env"
fi

if [ -f manager.config.yaml ]; then
  log "跳过（已存在）：manager.config.yaml"
else
  cat > manager.config.yaml <<EOF
# 由 install.sh 生成（同机方案 B：经容器内 dsh-api-gateway 带 key 访问）。
listen:
  host: 127.0.0.1
  port: $MANAGER_PORT

endpoints:
  A:
    url: http://127.0.0.1:3080
    driver: apiproxy
    prefix: /api-gw/v1/proxy
    key_ref: GW_KEY_A

agents:
  personal:
    name: 个人
    endpoint: A
    workspace: $WORKSPACE_PATH
    public: false

runner:
  timeout_minutes: 15
  silence_timeout_minutes: 5
  max_consecutive_failures: 3
  daily_budget_usd: 2.0

database:
  path: ./data/manager.db

pricing:
  peak_windows_utc:
    - { start: '01:00', end: '04:00' }
    - { start: '06:00', end: '10:00' }
  models:
    deepseek-v4-pro:
      off_peak: { input: 0.66, output: 1.98, cache_read: 0.022 }
      peak: { input: 1.32, output: 3.96, cache_read: 0.044 }
    deepseek-v4-flash:
      off_peak: { input: 0.22, output: 0.66, cache_read: 0.007 }
      peak: { input: 0.44, output: 1.32, cache_read: 0.014 }
EOF
  log "生成：manager.config.yaml（端点 A 走方案 B 经网关）"
fi

if [ -f docker/.env ]; then
  log "跳过（已存在）：docker/.env"
else
  cat > docker/.env <<EOF
# 由 install.sh 生成
GW_KEY=$GW_KEY
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
WORKSPACE_PATH=$WORKSPACE_PATH
HOST_UID=$HOST_UID
HOST_GID=$HOST_GID
EOF
  log "生成：docker/.env"
fi

# ---- 工作区与数据目录（宿主机与容器同 uid 读写） ----
run mkdir -p "$WORKSPACE_PATH"
run chown -R "$HOST_UID:$HOST_GID" "$WORKSPACE_PATH"
# manager 的 SQLite 数据目录归服务用户（npm install 是以 root 跑的）
run mkdir -p "$APP_ROOT/data"
run chown -R "$HOST_UID:$HOST_GID" "$APP_ROOT/data"
if [ "$HOST_UID" != "1000" ]; then
  log "注意：HOST_UID=$HOST_UID（非 1000）。容器内 /data 卷按 uid 1000 初始化；"
  log "      如遇容器内写入权限问题，请按 docker/README.md 调整镜像或用户。"
fi

# ---- 节点容器 ----
if [ "$DRY_RUN" = "1" ]; then
  log "DRY: docker compose up -d --build (docker/)"
else
  log "构建节点容器（首次 2-5 分钟，请稍候）..."
  (cd docker && docker compose up -d --build)
fi

# ---- manager 依赖与构建 ----
run npm install
run npm run build

# ---- systemd 服务 ----
if command -v systemctl >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY: 写 /etc/systemd/system/ohdsh-manager.service + enable --now"
  else
    sed -e "s|__APP_ROOT__|$APP_ROOT|g" \
        -e "s|__RUN_USER__|$RUN_USER|g" \
        -e "s|__NODE_BIN__|$NODE_BIN|g" \
        deploy/ohdsh-manager.service > /etc/systemd/system/ohdsh-manager.service
    systemctl daemon-reload
    systemctl enable --now ohdsh-manager
    log "systemd 服务 ohdsh-manager 已启动（journalctl -u ohdsh-manager -f 看日志）"
  fi
else
  log "无 systemd：请用 nohup node dist/index.js & 之类的方式运行 manager"
fi

# ---- 收尾 ----
cat <<EOF

============================================================
安装完成。
  manager:    http://127.0.0.1:$MANAGER_PORT  （用户 $MANAGER_USERNAME）
  节点容器:   docker compose -f $APP_ROOT/docker/docker-compose.yml ps
  workspace:  $WORKSPACE_PATH

验收（在 $APP_ROOT 下）：
  export SMOKE_KEY="$(grep '^GW_KEY=' docker/.env | cut -d= -f2)"
  npx tsx scripts/smoke-proxy-b.ts http://127.0.0.1:3080/api-gw/v1/proxy
  ./docker/smoke.sh
============================================================
EOF
