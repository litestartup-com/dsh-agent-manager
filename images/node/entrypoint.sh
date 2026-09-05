#!/usr/bin/env bash
# 蜂群2计划 P2：节点容器入口。幂等：重启不重复复制、不覆盖已有 settings。
set -euo pipefail

mkdir -p "$DSH_HOME"

# 1) 首次：把镜像里预装好（依赖已冻结）的 profile 复制进卷 —— 本地复制，零网络
if [ ! -d "$DSH_HOME/profiles/ohdsh-node" ]; then
  cp -a /opt/ohdsh-profile "$DSH_HOME/profiles/ohdsh-node"
  echo "[entrypoint] profile seeded into $DSH_HOME/profiles/ohdsh-node"
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
