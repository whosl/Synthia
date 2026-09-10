#!/usr/bin/env bash
#
# 「未定义标识符」门禁（core/ + runtime/）。
#
# 背景：runtime/ 从来没被 typecheck 过（根 package.json 的 check 只跑 core），
# 于是 `maxNetwork is not defined` 这种低级错误一路进了生产——runtime/.runs/ 里
# 有 6 个 agent 的 endedReason 就是它，整轮对话直接打死。同一类问题在 server.ts
# （NoGovernanceClient）和 core/api/router.ts（RequiredScope）也各躺着一处。
#
# 只查 TS2304 / TS2552（「找不到名称 X」），不查别的：
#   - 值位置的未定义名 → 运行时必然 ReferenceError，零容忍；
#   - 类型位置的未定义名 → 会被转译器擦掉，运行时不炸，但意味着那一处的类型
#     约束是假的（router.ts 的 30 多条路由 scope 就这么裸奔了很久），照样要修。
#   两种都是确定性缺陷且都是一两行的修法，所以合并成一道门。
#
# 为什么不直接 `tsc -p`：这两个工程当前共有 ~160 条历史类型错误（core 侧 56 条
# 是 tsconfig 缺 allowImportingTsExtensions 的配置问题，runtime 侧多为 TS2300
# 重复声明 / TS2353 多余字段）。清理是独立一件事，不该挡住日常 check。
# 等历史错误清完，把这个脚本换成两条 `tsc -p` 即可。
set -uo pipefail

cd "$(dirname "$0")/.."

tsc=./node_modules/.bin/tsc
status=0

for proj in core runtime; do
  out=$("$tsc" --noEmit -p "$proj/tsconfig.json" --pretty false 2>&1)
  hits=$(printf '%s\n' "$out" | grep -E 'error TS(2304|2552):' || true)
  total=$(printf '%s\n' "$out" | grep -cE 'error TS' || true)

  if [ -n "$hits" ]; then
    echo "[$proj] 未定义标识符：" >&2
    printf '%s\n' "$hits" >&2
    status=1
  else
    echo "[$proj] 无未定义标识符（另有 ${total} 条历史类型错误未纳入门禁）"
  fi
done

exit "$status"
