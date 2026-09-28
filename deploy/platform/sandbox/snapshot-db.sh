#!/usr/bin/env bash
#
# 沙箱侧：数据冷备（对抗沙箱销毁重建丢数据的风险）。
# 嵌入式 PG 包无 pg_dump 二进制，采用停库 → tar pg-data → 重启的冷备
# （一致性完美；期间 core :8000 会短暂报数据库错误，选低频时段执行）。
set -euo pipefail
cd "$(dirname "$0")"

NATIVE="$PWD/pg-bootstrap/node_modules/@embedded-postgres/linux-x64/native"
DATA="$PWD/pg-data"
BACKUPS="$PWD/backups"
[ -f "$DATA/PG_VERSION" ] || { echo "FAIL: pg-data missing (run 10-setup-pg.sh first)"; exit 1; }

mkdir -p "$BACKUPS"
export LD_LIBRARY_PATH="$NATIVE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "stopping postgres..."
su pguser -s /bin/bash -c "\"$NATIVE/bin/pg_ctl\" -D \"$DATA\" -m fast -w stop"
STAMP="$(date +%Y%m%d-%H%M%S)"
tar -czf "$BACKUPS/pg-data-$STAMP.tar.gz" -C "$PWD" pg-data
echo "restart postgres..."
su pguser -s /bin/bash -c "\"$NATIVE/bin/pg_ctl\" -D \"$DATA\" \
  -o \"-p 5432 -k $PWD/pg-home -c listen_addresses=127.0.0.1\" \
  -l \"$PWD/pg-home/postgres.log\" -w start"
echo "OK: $BACKUPS/pg-data-$STAMP.tar.gz ($(du -h "$BACKUPS/pg-data-$STAMP.tar.gz" | cut -f1))"
echo "注意：沙箱重建即丢一切——重要节点把备份经平台下载通道取出沙箱。"
