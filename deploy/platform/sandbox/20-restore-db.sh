#!/usr/bin/env bash
#
# 沙箱侧 Step 2：恢复数据。用法：./20-restore-db.sh [dump路径]
# 缺省 /upload/synthia.dump（平台上传通道）。恢复后输出关键表计数，与导出
# 基线（deploy/platform/sandbox/BASELINE.txt，随包分发）人工比对。
set -euo pipefail
cd "$(dirname "$0")"

DUMP="${1:-/upload/synthia.dump}"
[ -f "$DUMP" ] || { echo "FAIL: dump not found at $DUMP"; exit 1; }
[ -d pg-bootstrap/node_modules/pg ] || { echo "FAIL: run 10-setup-pg.sh first"; exit 1; }

DUMP_ABS="$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")"
(cd pg-bootstrap && node ../restore.mjs "$DUMP_ABS")

if [ -f BASELINE.txt ]; then
  echo "--- 导出基线（比对上方 restore-ok 计数）---"
  cat BASELINE.txt
fi
echo "OK: data restored"
