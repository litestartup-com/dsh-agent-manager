#!/usr/bin/env bash
# 首次启动初始化 + 拉起 DSH web。幂等：重启容器不会重复安装。
set -euo pipefail

mkdir -p "$DSH_HOME"

# 1) 生成 home-level patch（仅当 GW_KEY 已设置且 patch 不存在）
#    - webserver 绑 0.0.0.0（容器外可达；/api 仍只认容器内 loopback）
#    - 挂 dsh-api-gw 行：apiKeys 来自环境变量，proxyTarget 走容器内 loopback
PATCH="$DSH_HOME/cordis.patch.yml"
if [[ -n "${GW_KEY:-}" && ! -f "$PATCH" ]]; then
  # 注意：dsh-api-gw 行由插件的 bundle patch 自动 insert，这里只能 update 其
  # config（再 insert 一次会报 duplicate loader entry id: dsh-api-gw）。
  cat > "$PATCH" <<EOF
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080

- id: dsh-api-gw
  config:
    apiKeys: ['$GW_KEY']
    proxyTarget: 'http://127.0.0.1:3080/api'
EOF
  chmod 600 "$PATCH"
  echo "[entrypoint] wrote $PATCH"
elif [[ -n "${GW_KEY:-}" ]]; then
  echo "[entrypoint] patch exists, keeping it (delete $PATCH to regenerate)"
fi

# 2) 安装 dsh-api-gateway 插件（幂等：装过就跳过）
#    优先用挂载进 /packages 的本地 tgz（国内 GitHub 不通时）；否则走 github 协议
if [[ ! -d "$DSH_HOME/profiles/web/node_modules/dsh-api-gateway" ]]; then
  LOCAL_TGZ=$(ls /packages/dsh-api-gateway-*.tgz 2>/dev/null | head -n 1 || true)
  # -w: the profile directory is its own workspace root; pnpm refuses to add
  # to a workspace root without it being explicit.
  if [[ -n "$LOCAL_TGZ" ]]; then
    echo "[entrypoint] installing dsh-api-gateway from $LOCAL_TGZ"
    dsh plugin --profile web add -w "$LOCAL_TGZ"
  else
    echo "[entrypoint] installing dsh-api-gateway from github..."
    dsh plugin --profile web add -w github:litestartup-com/dsh-api-gateway
  fi
fi

# 3) 启动（透传参数给 web app，例如 --port 3080）
exec dsh web "$@"
