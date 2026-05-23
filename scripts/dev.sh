#!/usr/bin/env bash
# Local dev: activate venv and start backend (or frontend).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Creating .venv …"
  python3 -m venv .venv
  .venv/bin/pip install -U pip
  .venv/bin/pip install -e ".[dev,all]"
fi

# shellcheck disable=SC1091
source .venv/bin/activate

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

case "${1:-web}" in
  web)
    exec edagent web --host "${EDAGENT_HOST:-0.0.0.0}" --port "${EDAGENT_PORT:-8484}"
    ;;
  frontend)
    cd frontend && exec npm run dev
    ;;
  *)
    echo "Usage: $0 [web|frontend]" >&2
    exit 1
    ;;
esac
