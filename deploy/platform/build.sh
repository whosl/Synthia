#!/usr/bin/env bash
#
# 构建 Synthia 平台部署包（在仓库根、Bun 1.4.1 下执行）。
# 产物 dist/platform/ + dist/synthia-platform-<date>.tar.gz：
#   core-serve.mjs        Node 20 单文件 bundle（--target=node）
#   web/                  VITE_PLATFORM_PREVIEW=1 构建的静态前端（相对 base + hash 路由）
#   worker-66.config.json connector endpoint 描述（core 读）
#   env.example           沙箱环境变量模板
#   sandbox/*.sh|*.mjs    沙箱侧 setup/restore/start/snapshot 脚本
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v bun >/dev/null || { echo "bun not found (need Bun 1.4.1)"; exit 1; }

OUT=dist/platform
rm -rf "$OUT"
mkdir -p "$OUT"

echo "[1/4] core bundle (node target)..."
bun build core/scripts/serve.ts --target=node --outfile "$OUT/core-serve.mjs"
grep -q "Bun\.serve\|Bun\.spawn" "$OUT/core-serve.mjs" && { echo "bundle still references Bun.* — abort"; exit 1; }

echo "[2/5] web platform build（feature flags 对齐 golden 线 dev-up）..."
(cd web && VITE_PLATFORM_PREVIEW=1 VITE_FEATURE_HISTORICAL_MATERIALS=1 \
  VITE_FEATURE_SIDE_TASKS=1 VITE_FEATURE_FORMAL_DELIVERY=1 bun run build >/dev/null)
cp -r web/dist "$OUT/web"

echo "[3/5] runtime bundle (node target)..."
bun build runtime/server.ts --target=node --outfile "$OUT/runtime-serve.mjs"
grep -q "Bun\.serve\|Bun\.spawn" "$OUT/runtime-serve.mjs" && { echo "runtime bundle still references Bun.* — abort"; exit 1; }

echo "[4/5] collect assets..."
cp connector/worker-66.config.json "$OUT/"
# runtime 的 SkillLoader 按 cwd 相对路径 skills/fpga/skill-pack.json 启动即读
# （DEFAULT_PACK_PATH，无 env 覆盖点）——技能包必须随包分发。
cp -r skills "$OUT/skills"
cp deploy/platform/env.example "$OUT/"
cp deploy/platform/sandbox/* "$OUT/"

echo "[5/5] tar..."
printf '*\n' > dist/.gitignore
TARBALL="dist/synthia-platform-$(date +%Y%m%d).tar.gz"
tar -czf "$TARBALL" -C "$OUT" .
echo "OK: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
echo "上传两个文件到沙箱：$TARBALL + 本机导出的 synthia.dump"
