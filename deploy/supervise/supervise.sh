#!/bin/sh
# Synthia process supervisor (H1) — restart-on-exit with crash journal.
#
# Core and Runtime both died silently in the same window during the C-series
# experiments: logs stopped at the startup line, in-flight agent turns were
# lost, and nothing restarted them. This supervisor keeps a crash journal so
# the death is at least visible, and brings the process back.
#
# Usage:
#   supervise.sh <name> <logfile> <command...>
# Example:
#   supervise.sh core /tmp/synthia-core.log bun run core/scripts/serve.ts
#
# Environment for the supervised process is provided by the caller (this
# script adds nothing) — keep using env vars in a wrapper or systemd/launchd
# unit for production.
set -u

NAME=$1; LOG=$2; shift 2
COMMAND=$*
JOURNAL="${LOG}.crash"
BACKOFF=5

echo "[supervisor] ${NAME}: starting: ${COMMAND}" >>"$JOURNAL"
attempt=0
while :; do
  start_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  "$@" >>"$LOG" 2>&1
  code=$?
  attempt=$((attempt + 1))
  echo "[supervisor] ${NAME}: exit code ${code} after start ${start_ts} (attempt ${attempt}) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$JOURNAL"
  # Exit code 0 = clean shutdown (SIGTERM path) — do not restart.
  if [ "$code" -eq 0 ]; then
    echo "[supervisor] ${NAME}: clean exit, not restarting" >>"$JOURNAL"
    break
  fi
  sleep "$BACKOFF"
done
