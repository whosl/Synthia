# H38 部署后回合静默终结修复（2026-10-08，worktree，未部署）

基线 `aa72598`，用户提供 p32 的两次 12:11 静默终结现象。本轮只读核对源码、部署提交和运行状态；未向生产会话发消息、未写 p32 文件、未重启或部署运行服务。生产现场由操作者进行上下文手术，未用原会话重放故障；以下为源码链路及独立大历史的确定性复现。

## 根因：输入预算失败在 Project Agent 恢复时丢失本地证据

构造 634 条消息（211 组 user/assistant-tool-call/tool-result + system），正文约 4.45MB，中段 4 个 250KB 工具结果，全部工具调用/结果配对合法。用 200,000 contextWindow / 65,536 outputReserveTokens 的策略运行旧版，复现：

1. `maybeCompactBySummary` 的摘要提示词本身超预算，打印用户看到的同款 `summary prompt exceeds window budget ... falling back to mechanical truncation`，然后退化为机械投影。
2. 机械层逐消息截断后仍保留全部消息、tool-call 参数及上下文结构，完整请求估算 **213,396 tokens > 输入预算 134,464**。
3. `prepareRequest` 在主模型调用前抛出 `context_budget_exceeded`；模型 mock 调用次数 **0**，H36 没有挂起窗口，也不会超时。
4. `prompt().catch` 原来只把失败写进 AgentState，没有追加 conversation 消息。
5. `RuntimeServer` 的 Project Agent 恢复分支将本回合错误同步到 Core，然后回到 awaiting_user 并清除 endedReason；该状态是可继续对话的治理语义，不意味着回合成功。恢复时又使用旧 `handle.currentState` 写盘，覆盖了新 `contextUsageSnapshot.failure=context_limit`，因此本地 conversation 无记录、state 无错误或仍显示旧测量。

这条确定性复现链与用户提供的“模型未挂起、摘要警告、零 conversation 追加、awaiting_user、endedReason=None”吻合。初始生产失败的旧 audit 已不在可用快照中，不能声称直接回放了 p32 原故障。

`git blame` 显示 prepareRequest 预算拒绝来自 `432b1ff4`（2026-09-26），Project Agent catch/recovery 来自更早提交；这两个缺口在 H38 之前存在。没有证据指向 H38 非空 max_tokens 的自动续跑分支导致零追加。

## 所有终结出口盘点与修复

| 旧出口 | 原有记录 | 本次处理 |
|---|---|---|
| beforeModelCallHook stop-return | 没有；当前默认 hook 固定放行，因此不是本次已激活的根因 | 拒绝原因写 system + stderr + 持久化后返回 |
| 普通非空 text return | 已追加 assistant | 保留；prompt 边界增加终结不变量兜底 |
| claim-check fallback return | 已追加 system | 保留 |
| 空 text 连续两次 | nudge 是 user；耗尽返回空 assistant，前端无可见正文 | 保留一次 nudge，耗尽返回非空系统提示，记录 empty_reply_exhausted/stop_reason/次数 |
| prepareRequest/模型调用/取消/总轮数上限 throw | prompt 只存状态；没有 conversation 错误 | prompt catch 先追加 bounded system 错误标注与 stderr，再落盘并继续抛错 |
| 未来新增零输出 return | 没有通用检查 | prompt 成功边界检测本轮非 user 的有效记录；缺失时写 turn_no_output 系统注记和非空返回 |

`runtime/server.ts` 的 Project Agent 错误恢复从刚刚持久化的 AgentState 读取最新失败信息，再恢复 awaiting_user；context_limit/request_failed 等上下文诊断保留，不把失败当新成功测量。endedReason 仍按原 Project Agent 非终态语义清除。

本次不改压缩算法、不删历史、不放宽请求预算；若完整请求仍超预算，会显式失败并保留原因，操作者可据此缩减上下文后继续。空 content + max_tokens 走 nudge 路径，不消耗非空截断的两次独立额度。权限/claim-check/H36 与有限总轮数上限保持。

## 回归验证

- 新建 `runtime/turn-termination.test.ts` **6 项**：大历史摘要失败+预算拒绝；同一大历史较小投影后空 max_tokens 的 nudge/耗尽；预检 stop；模型错误；总轮数耗尽；未来零输出 return 的边界兜底。
- 在旧 `aa72598` 上六项 **0 pass / 6 fail**，失败均为缺少终结记录/空返回。修复后六项通过；大历史测试同时断言持久化全文不被压缩投影修改。
- Project Agent 的 server 回归覆盖普通模型错误与 context_budget_exceeded：Core 可见错误、本地 system 注记、恢复 awaiting_user 后失败上下文仍在、同一 agent 可接受下一条消息。
- 受影响 6 文件：**188 pass / 0 fail**（包含 free-agent、server、stream、H36 watchdog、H38 续跑与终结回归）。
- 根目录 `bun run test`（未设置 DATABASE_URL）：**986 pass / 400 skip / 0 fail**，数据库相关测试未执行。
- `bun run check` / `bunx tsc --noEmit -p runtime/tsconfig.json` / `git diff --check` 均通过。

日志：`/tmp/synthia-h38-termination-baseline.log`、`/tmp/synthia-h38-termination-tests-final.log`、`/tmp/synthia-h38-termination-root.log`、`/tmp/synthia-h38-termination-core-check.log`、`/tmp/synthia-h38-termination-runtime-check.log`。

本地完成，待用户安排 Runtime 部署窗口；无数据库迁移、Core/Worker/Web 改动，未改 Worker bundle。生产 p32 的上下文手术不由本修复执行或覆盖。
