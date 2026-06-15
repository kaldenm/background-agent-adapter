#!/bin/bash
# Usage:
#   ./scripts/sandbox.sh list              — list recent sandboxes
#   ./scripts/sandbox.sh exec <id> <cmd>   — run a command in a sandbox
#   ./scripts/sandbox.sh logs <id>         — check auth, env, workspace, processes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../packages/daytona-infra"
set -a && source .env && set +a

DAYTONA_HEADERS=(-H "Authorization: Bearer $DAYTONA_API_KEY")
if [ -n "${DAYTONA_ORGANIZATION_ID:-}" ]; then
  DAYTONA_HEADERS+=(-H "X-Daytona-Organization-ID: $DAYTONA_ORGANIZATION_ID")
fi

resolve_id() {
  curl -s "${DAYTONA_HEADERS[@]}" "$DAYTONA_API_URL/sandbox?limit=20" | python3 -c "
import sys, json
prefix = '$1'
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for s in items:
    if isinstance(s, dict) and s.get('id','').startswith(prefix):
        print(s['id']); break"
}

case "$1" in
  list)
    curl -s "${DAYTONA_HEADERS[@]}" "$DAYTONA_API_URL/sandbox?limit=10" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for s in items:
    if isinstance(s, dict):
        print(f'{s.get(\"name\",\"?\"):60s} {s.get(\"state\",\"?\"):10s} {s.get(\"id\",\"?\")[:12]}')"
    ;;
  exec)
    FULL_ID=$(resolve_id "$2")
    if [ -z "$FULL_ID" ]; then echo "Sandbox not found"; exit 1; fi
    curl -s "${DAYTONA_HEADERS[@]}" \
      "https://proxy.app.daytona.io/toolbox/$FULL_ID/process/execute" \
      -X POST -H "Content-Type: application/json" \
      -d "{\"command\":\"$3\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','(no output)'))"
    ;;
  logs)
    FULL_ID=$(resolve_id "$2")
    if [ -z "$FULL_ID" ]; then echo "Sandbox not found"; exit 1; fi
    curl -s "${DAYTONA_HEADERS[@]}" \
      "https://proxy.app.daytona.io/toolbox/$FULL_ID/process/execute" \
      -X POST -H "Content-Type: application/json" \
      -d '{"command":"echo === PROCESSES ===; ps aux | grep -v grep | grep -E \"python|pi|bridge\"; echo === WORKSPACE ===; ls /workspace/; echo === AUTH ===; cat /root/.pi/agent/auth.json 2>/dev/null || echo NO_AUTH; echo === ENV ===; env | grep -i ANTHROPIC | sed s/=.*/=SET/; echo === EXTENSIONS ===; find /workspace -path \"*/.pi/extensions/*\" -name \"*.ts\" 2>/dev/null || echo none; echo === ERRORS ===; find /workspace -name \"*.jsonl\" -exec grep errorMessage {} \\; 2>/dev/null | tail -3"}' \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','(no output)'))"
    ;;
  *)
    echo "Usage: ./scripts/sandbox.sh [list|exec <id> <cmd>|logs <id>]"
    ;;
esac
