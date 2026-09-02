#!/usr/bin/env bash
# 容器外调用验收：宿主机执行（容器起来之后）。
# 用法：GW_KEY=xxx ./smoke.sh [base-url]
set -euo pipefail
BASE="${1:-http://127.0.0.1:3080/api-gw/v1}"
KEY="${GW_KEY:?请先设置 GW_KEY（与 .env 一致）}"

echo "== 1/4 health（无需鉴权，应 200 + upstream: ok）=="
curl -fsS "$BASE/health"
echo

echo "== 2/4 host.describe（经代理 unary，应返回 DSH 版本）=="
curl -fsS -X POST "$BASE/proxy/host.describe" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"type":"client-request","rpcId":"smoke-1","method":"host.describe","payload":{}}'
echo

echo "== 3/4 session.list（经代理，应返回 items）=="
curl -fsS -X POST "$BASE/proxy/session.list" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"type":"client-request","rpcId":"smoke-2","method":"session.list","payload":{}}'
echo

echo "== 4/4 白名单负例（credentials.set 应 403）=="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/proxy/credentials.set" \
  -H "x-api-key: $KEY" -H "content-type: application/json" -d '{}')
if [[ "$CODE" == "403" ]]; then echo "403 OK"; else echo "预期 403，实际 $CODE"; exit 1; fi

echo
echo "ALL SMOKE STEPS PASSED"
