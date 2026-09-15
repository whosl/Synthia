#!/bin/sh
# Synthia dev stack: Core + Runtime + Web, each under the H1 supervisor.
#
# Usage:  sh deploy/supervise/dev-up.sh
# Stops:  pkill -f "core/scripts/serve.ts"; pkill -f "runtime/server.ts"; pkill -f vite
#
# Requires (this lab setup):
#   /tmp/synthia-tokens.txt   — bootstrap-admin output (ADMIN_TOKEN/SERVICE_TOKEN/TASK_RUNTIME_TOKEN)
#   ~/.synthia/certs/worker-66/worker-66.client.json — mTLS connector config
#   worker 66 up (scheduled task synthia-worker) for real Vivado runs
set -eu
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
SUP="$ROOT/deploy/supervise/supervise.sh"
LOGDIR=/tmp; mkdir -p "$LOGDIR"

if [ ! -f /tmp/synthia-tokens.txt ]; then
  echo "missing /tmp/synthia-tokens.txt — run:" >&2
  echo "  DATABASE_URL='postgres://synthia_core:syn_core_9f4k2m7q_zj81@127.0.0.1:55432/synthia_real_ui' bun run core/scripts/bootstrap-admin.ts" >&2
  exit 1
fi
SERVICE_TOKEN=$(grep '^SERVICE_TOKEN=' /tmp/synthia-tokens.txt | cut -d= -f2-)
TASK_RUNTIME_TOKEN=$(grep '^TASK_RUNTIME_TOKEN=' /tmp/synthia-tokens.txt | cut -d= -f2-)

pkill -f "core/scripts/serve.ts" 2>/dev/null || true
pkill -f "runtime/server.ts" 2>/dev/null || true
# Our own vite instances (this repo only — other projects' vite are left alone).
pkill -f "synthia-golden/web" 2>/dev/null || true
pkill -f "supervise.sh web" 2>/dev/null || true
sleep 1
# Port 5180 may be squatted by a stale vite from another worktree (a mock
# instance there once shadowed this stack for two days) — refuse to start
# silently on a bumped port; surface the squatter instead.
if lsof -nP -iTCP:5180 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 5180 is held by another process:" >&2
  lsof -nP -iTCP:5180 -sTCP:LISTEN >&2
  echo "kill it (or edit web/vite.config.ts port) and re-run." >&2
  exit 1
fi
# Same preflight for the backend ports — an m4f E2E service squatting 8790
# once sent this stack's runtime into a 745-attempt crash loop while Core
# silently pointed task traffic at the wrong process.
for PORT in 5130 8791; do
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT is held by another process:" >&2
    lsof -nP -iTCP:$PORT -sTCP:LISTEN >&2
    echo "free it (or change the port in this script) and re-run." >&2
    exit 1
  fi
done

# ── Core (8787 → web vite proxy expects 5130; we run Core ON 5130) ──────────
DATABASE_URL="postgres://synthia_core:syn_core_9f4k2m7q_zj81@127.0.0.1:55432/synthia_real_ui" \
PORT=5130 \
SYNTHIA_CONNECTOR_CONFIG="$HOME/.synthia/certs/worker-66/worker-66.client.json" \
SYNTHIA_RUNTIME_URL="http://127.0.0.1:8791" \
SYNTHIA_FEATURE_SELF_EVOLUTION="${SYNTHIA_FEATURE_SELF_EVOLUTION:-1}" \
  nohup sh "$SUP" core "$LOGDIR/synthia-core.log" \
  bun run core/scripts/serve.ts > /dev/null 2>&1 &

# ── Runtime (GLM via Zhipu Anthropic-compatible endpoint) ───────────────────
SYNTHIA_RUNTIME_MODE=core \
SYNTHIA_RUNTIME_PORT=8791 \
SYNTHIA_CORE_URL="http://127.0.0.1:5130" \
SYNTHIA_CORE_TOKEN="$SERVICE_TOKEN" \
SYNTHIA_TASK_RUNTIME_TOKEN="$TASK_RUNTIME_TOKEN" \
SYNTHIA_FEATURE_SELF_EVOLUTION="${SYNTHIA_FEATURE_SELF_EVOLUTION:-1}" \
SYNTHIA_MODEL_URL="https://open.bigmodel.cn/api/anthropic" \
SYNTHIA_MODEL_API="anthropic-messages" \
SYNTHIA_MODEL_NAME="glm-4.6" \
SYNTHIA_MODEL_KEY="${SYNTHIA_MODEL_KEY:?set SYNTHIA_MODEL_KEY to the Zhipu key}" \
SYNTHIA_MODEL_CHAT_MAX_TOKENS=65536 \
SYNTHIA_MODEL_TOOL_MAX_TOKENS=32768 \
SYNTHIA_MODEL_DOC_MAX_TOKENS=49152 \
  nohup sh "$SUP" runtime "$LOGDIR/synthia-runtime.log" \
  bun run runtime/server.ts > /dev/null 2>&1 &

# ── Web (vite on 5180, /api proxied to 5130) ─────────────────────────────────
cd web
# Compile-time feature flags — the same set dev:mock enables. Missing flags
# compile whole UI sections out (historical materials, side tasks), which
# makes the real-mode app look like an older, plainer build than the mock.
VITE_FEATURE_HISTORICAL_MATERIALS=1 \
VITE_FEATURE_SIDE_TASKS=1 \
VITE_FEATURE_FORMAL_DELIVERY=1 \
  nohup sh "$ROOT/deploy/supervise/supervise.sh" web "$LOGDIR/synthia-web.log" \
  bun run dev > /dev/null 2>&1 &
cd "$ROOT"

sleep 6
echo "core:    $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5130/api/v1/projects -H "Authorization: Bearer $(grep '^ADMIN_TOKEN=' /tmp/synthia-tokens.txt | cut -d= -f2-)") (200=ok)"
echo "runtime: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8791/tasks)"
echo "web:     http://127.0.0.1:5180  (login token = ADMIN_TOKEN in /tmp/synthia-tokens.txt)"
