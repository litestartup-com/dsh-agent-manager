#!/usr/bin/env bash
# 蜂群2计划 P2/P5：生成/补全 .env（幂等：已有且非空的值绝不覆盖）。
# 用法：bash scripts/gen-env.sh [env文件]；DEEPSEEK_API_KEY 可先 export 预置。
set -euo pipefail

ENV_FILE="${1:-.env}"
gen() { openssl rand -hex 32; }

ensure() { # key value
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null || [ -z "$(grep "^${key}=" "$ENV_FILE" | cut -d= -f2-)" ]; then
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

ensure SESSION_SECRET "$(gen)"
ensure GW_KEY_A "apigw-$(openssl rand -hex 24)"
ensure GW_KEY_B "apigw-$(openssl rand -hex 24)"
ensure BRAIN_TOKEN "$(openssl rand -hex 24)"
ensure MANAGER_USERNAME "admin"
ensure MANAGER_INITIAL_PASSWORD "$(openssl rand -hex 8)"
ensure DSH_NODE_IMAGE "ohdsh/dsh-node:0.1.1-rc.2"
ensure MANAGER_VERSION "1.0.1"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  ensure DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
fi

chmod 600 "$ENV_FILE"
mkdir -p workspaces/personal workspaces/brain data

echo "[gen-env] $ENV_FILE 就绪（幂等）。"
echo "[gen-env] 初始密码：$(grep '^MANAGER_INITIAL_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
if ! grep -q '^DEEPSEEK_API_KEY=' "$ENV_FILE"; then
  echo "[gen-env] ⚠ 尚未设置 DEEPSEEK_API_KEY —— 手动编辑 $ENV_FILE 填入后启动。"
fi
