#!/usr/bin/env bash
#
# 灾难恢复包组装（在仓库根、Bun 1.4.1 下执行；golden 线数据环境）。
# 产物 dist/synthia-full-restore-<date>.tar.gz —— 单文件全量恢复包：
#   core/runtime/evolution bundle + 全量 UI web + skills + 沙箱脚本
#   + env.real（token/key 全在文件，不进对话通道）+ golden dump.gz + 工作区 git 仓库
#
# 沙箱侧恢复 = 解包 → 10-setup-pg → 20-restore-db → mint-evolution → 30-start（见 README）。
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v bun >/dev/null || { echo "FAIL: bun not found"; exit 1; }
[ -d ~/.synthia/workspaces ] || { echo "FAIL: ~/.synthia/workspaces missing"; exit 1; }
[ -f dist/env.real ] || { echo "FAIL: dist/env.real missing（token 载体文件）"; exit 1; }
[ -f dist/synthia-golden.dump.gz ] || { echo "FAIL: 先导出 pg_dump --inserts --no-owner --no-privileges -h 127.0.0.1 -U synthia synthia_real_ui | gzip > dist/synthia-golden.dump.gz"; exit 1; }

bash deploy/platform/build.sh >/dev/null

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/synthia-data"
cp -r dist/platform/. "$STAGE/"
cp dist/env.real dist/synthia-golden.dump.gz "$STAGE/"
cp -r ~/.synthia/workspaces "$STAGE/synthia-data/workspaces"

# 属主归一说明：沙箱 core 以 root 运行；tar 若保留源机 uid 会触发 git
# "dubious ownership"（core 的 git 封装 GIT_CONFIG_GLOBAL=/dev/null，
# safe.directory 白名单无效，只能靠属主正确）→ 最终 tar 统一 --owner=0。
OUT="dist/synthia-full-restore-$(date +%Y%m%d).tar.gz"
tar -czf "$OUT" --owner=0 --group=0 -C "$STAGE" .
md5sum "$OUT"
echo "OK: $OUT ($(du -h "$OUT" | cut -f1)，$(tar -tzf "$OUT" | wc -l) 条目) —— 上传后按 README 六步恢复"
