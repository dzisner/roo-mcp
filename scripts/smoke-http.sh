#!/usr/bin/env bash
# Smoke-test the hosted roo-mcp HTTP endpoint end-to-end:
#   health → unauthed error → initialize → tools/list → one real tool call.
# Usage:
#   ROO_API_KEY=xxx scripts/smoke-http.sh                     # against local dev server
#   ROO_API_KEY=xxx scripts/smoke-http.sh https://mcp.roo.bz  # against production
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8787}"
API_KEY="${ROO_API_KEY:-}"

if [[ -z "$API_KEY" ]]; then
  echo "ROO_API_KEY env var required." >&2
  exit 2
fi

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n     %s\n' "$1" "$2" >&2; exit 1; }

echo "roo-mcp smoke test against $BASE_URL"
echo

# 1. health
echo "1. GET /health"
body=$(curl -fsS "$BASE_URL/health")
[[ "$body" == '{"ok":true}' ]] && pass "returns {ok:true}" || fail "unexpected" "$body"

# 2. unauthed /mcp -> 401 + jsonrpc error
echo "2. POST /mcp without x-api-key"
status=$(curl -s -o /tmp/roo-smoke-2.json -w '%{http_code}' -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
[[ "$status" == '401' ]] && pass "401" || fail "wrong status: $status" "$(cat /tmp/roo-smoke-2.json)"
grep -q 'Missing x-api-key' /tmp/roo-smoke-2.json && pass "mentions x-api-key" || fail "no missing-key message" "$(cat /tmp/roo-smoke-2.json)"

# 3. initialize with key -> serverInfo
echo "3. POST /mcp initialize"
curl -fsS -o /tmp/roo-smoke-3.txt -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "x-api-key: $API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
grep -q '"serverInfo":{"name":"roo-mcp"' /tmp/roo-smoke-3.txt && pass "serverInfo returned" || fail "no serverInfo" "$(cat /tmp/roo-smoke-3.txt)"

# 4. tools/list -> expected tools present
echo "4. POST /mcp tools/list"
curl -fsS -o /tmp/roo-smoke-4.txt -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "x-api-key: $API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
for tool in roo_whoami roo_create_shortlink roo_list_shortlinks roo_set_scheduled_redirect roo_list_custom_domains; do
  grep -q "\"name\":\"$tool\"" /tmp/roo-smoke-4.txt && pass "$tool present" || fail "$tool missing" "$(head -c 400 /tmp/roo-smoke-4.txt)"
done

# 5. tools/call roo_whoami -> live Roo API round-trip
echo "5. POST /mcp tools/call roo_whoami (hits api.roo.bz)"
curl -fsS -o /tmp/roo-smoke-5.txt -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "x-api-key: $API_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"roo_whoami","arguments":{}}}'
grep -q '"isError":true' /tmp/roo-smoke-5.txt && fail "roo_whoami returned error" "$(head -c 400 /tmp/roo-smoke-5.txt)"
grep -q 'Roo account:' /tmp/roo-smoke-5.txt && pass "returned account info" || fail "no account info in response" "$(head -c 400 /tmp/roo-smoke-5.txt)"

echo
echo "all green."
