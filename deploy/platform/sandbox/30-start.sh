#!/usr/bin/env bash
#
# 沙箱侧 Step 3：起服务（平台惯例 nohup 后台 + 固定端口）。
#   core API  -> 127.0.0.1:8000（平台预览代理 {预览根}/__backend/* 剥前缀转发至此）
#   web 静态  -> 0.0.0.0:5173（平台预览入口，调 generate_preview_url(5173) 生成访问路径）
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "FAIL: node missing"; exit 1; }
[ -f env.real ] || { echo "FAIL: cp env.example env.real 并填写后重试"; exit 1; }
[ -f core-serve.mjs ] || { echo "FAIL: core-serve.mjs missing"; exit 1; }

# 部署目录自适应（原 /root 路径仅适用于家庭 Linux 节点；沙箱等受限环境落在部署目录内）
export SYNTHIA_WORKSPACES_DIR="${SYNTHIA_WORKSPACES_DIR:-$PWD/synthia-data/workspaces}"
mkdir -p logs "$SYNTHIA_WORKSPACES_DIR"

# 幂等：先清旧的（按端口精确找 PID）。
# 冷启动时端口无人监听 → grep 无匹配退出 1 → 在 set -euo pipefail 下会
# 静默中止整个脚本，因此该管道必须容忍空结果（|| true）。
for port in 8000 5173; do
  pids=$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
done
sleep 0.5

set -a; . ./env.real; set +a
nohup node "$PWD/core-serve.mjs" >> logs/core.log 2>&1 &
echo "core pid=$! -> :8000 (logs/core.log)"
nohup python3 -m http.server 5173 --bind 0.0.0.0 --directory "$PWD/web" >> logs/web.log 2>&1 &
echo "web  pid=$! -> :5173 (logs/web.log)"

sleep 1.5
echo "--- 自检 ---"
curl -s -m 3 "http://127.0.0.1:8000/api/v1/projects" | head -c 120; echo " <- core(401=正常，未带token)"
curl -s -m 3 -o /dev/null -w "web http_code=%{http_code}\n" http://127.0.0.1:5173/
echo "最后一步：调 generate_preview_url(5173) 生成预览路径，浏览器访问 {预览根}/ 即 Synthia。"
