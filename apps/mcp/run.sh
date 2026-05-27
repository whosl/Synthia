#!/usr/bin/env bash
# Launch Synthia MCP server (stdio mode).
set -euo pipefail

if [[ -z "${SYNTHIA_MCP_TOKEN:-}" ]] && [[ -z "${SYNTHIA_API_TOKEN:-}" ]]; then
    echo "ERROR: SYNTHIA_MCP_TOKEN env var required" >&2
    exit 1
fi

export SYNTHIA_BASE_URL="${SYNTHIA_BASE_URL:-http://127.0.0.1:8484}"
exec synthia-mcp
