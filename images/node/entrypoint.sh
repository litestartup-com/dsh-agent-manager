#!/usr/bin/env bash
# 蜂群2计划 P2：节点容器入口。幂等：重启不重复复制、不覆盖已有 settings。
set -euo pipefail

mkdir -p "$DSH_HOME"

# 1) 播种/升级 profile：卷里没有，或播种版本与镜像不一致 → 重新复制（本地，零网络）
SEED_CUR=""
SEED_NEW="$(cat /opt/ohdsh-profile/.seed-version 2>/dev/null || echo unknown)"
[ -f "$DSH_HOME/profiles/ohdsh-node/.seed-version" ] && SEED_CUR="$(cat "$DSH_HOME/profiles/ohdsh-node/.seed-version")"
if [ ! -d "$DSH_HOME/profiles/ohdsh-node" ] || [ "$SEED_CUR" != "$SEED_NEW" ]; then
  rm -rf "$DSH_HOME/profiles/ohdsh-node"
  mkdir -p "$DSH_HOME/profiles"
  cp -a /opt/ohdsh-profile "$DSH_HOME/profiles/ohdsh-node"
  echo "[entrypoint] profile seeded into $DSH_HOME/profiles/ohdsh-node (seed ${SEED_NEW:0:8})"
fi

# 2) gateway 静态密钥（环境注入；已有 settings 不覆盖）
if [[ -n "${GW_KEY:-}" && ! -f "$DSH_HOME/settings.yaml" ]]; then
  cat > "$DSH_HOME/settings.yaml" <<EOF
dsh-api-gw:
  apiKeys: ['$GW_KEY']
EOF
  chmod 600 "$DSH_HOME/settings.yaml"
  echo "[entrypoint] wrote $DSH_HOME/settings.yaml"
fi

# 3) 模型凭据：DEEPSEEK_API_KEY 环境变量在 DSH 凭据分层里优先级最高，无需写文件

# 4) 启动：端口等参数透传给 web app（manager 侧 docker run 命令带 --port N）
exec dsh --profile ohdsh-node --no-open "$@"
