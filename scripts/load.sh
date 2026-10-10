#!/usr/bin/env bash
# Sobe a API com banco temporário, roda o k6 em Docker e confere as invariantes.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3104}"
TMP_DIR="$(mktemp -d)"
DB_FILE="$TMP_DIR/load.db"
export NODE_OPTIONS='--disable-warning=ExperimentalWarning'

PORT="$PORT" DB_PATH="$DB_FILE" node --import tsx src/index.ts > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP_DIR"; }
trap cleanup EXIT

for _ in $(seq 1 50); do
  curl -sf "http://localhost:$PORT/health" > /dev/null && break
  sleep 0.2
done
curl -sf "http://localhost:$PORT/health" > /dev/null || { echo "API não subiu"; cat "$TMP_DIR/server.log"; exit 1; }

docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e BASE_URL="http://host.docker.internal:$PORT" \
  -v "$PWD/load:/load:ro" -w /load \
  grafana/k6:0.54.0 run - < load/attribution.js

kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true
npx tsx scripts/verify-load.ts "$DB_FILE"
