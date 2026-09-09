# Runtime 修复与全 worktree 同步记录

日期：2026-09-07。已将此前审查的 R1–R6 修复合入 `git worktree list` 列出的全部 5 个工作区。每个工作区新增 12 项常规回归测试，全部通过。

## 修复行为

- **R1：产物一致性。** 仿真修复后的 RTL/TB 成为后续综合、实现和最终返回的输入；修订与对应内容共同写入检查点。dc6d 保持旧版登记协议，更新 RTL 修订并持久化修复后的 TB。测试使用不同的修复前后字节，检查下游输入、返回产物及检查点。
- **R2：历史恢复。** 会话装配前加载历史，刷新系统提示并保留用户、模型、工具和纠偏记录；恢复工具/快照登记信息。未完成的工具批次补充“执行结果未知”的错误结果，不自动重放操作。损坏或身份不匹配的历史拒绝加载并保留原文件；并发装配共用一个会话。历史文件串行写入并用原子替换提交。golden 的重启说明保留新增的历史字段。
- **R3：纠偏闭环。** 接收纠偏后持久化队列再确认；模型直接返回文本时仍处理纠偏并继续当前轮。多工具批次的全部结果先闭合，再注入用户消息，避免破坏工具协议顺序。
- **R4：SSE 重连。** 旧进程的游标超过新 Hub 序号时立即发送 reset；空 Hub 也能处理，不再等待序号追平。
- **R5：HTTP 预算。** 单次请求默认 30 秒，覆盖响应头和正文读取，并受剩余轮询预算限制。支持取消；重试沿用原幂等键。轮询超时保留 Core job ID，返回 `unknown_effect / poll_timeout`，不把本地等待超时当作远端任务已结束。
- **R6：执行控制。** 工程流水线共享取消边界，中断会停止本地续执行以及适配器的后续轮询/重试。直接从 Runtime 中断时同步 Core 取消事件；经 Core 发起时由 Core 提交取消事实，避免重复写入。运行与状态落盘期间防止另开同 ID 自由会话；流水线普通消息返回 `409 pipeline_message_not_supported`。m4f/golden 的 Project Agent 和 Side Agent 仍可对话。未决远端操作可能已产生效果，取消不等于远端 Vivado 作业已撤销；需在 Core 查询确认。旧状态协议以 `failed` 和明确的中断原因保存本地停止状态。

## 验证结果

`bun test ./runtime` 精确限定 Runtime 目录；`bun test runtime` 的字符串过滤还会匹配其他目录中名称带 runtime 的测试。

| 工作区 | HEAD | Runtime 测试 | 新增回归 | Runtime 类型检查 |
| --- | --- | --- | --- | --- |
| `/Users/wenzhuolin/dev/synthia` | `b830e054` | 383 通过，0 失败 | 12/12 | 20 条既有诊断 |
| `/Users/wenzhuolin/.codex/worktrees/157d/synthia` | `b830e054` | 383 通过，0 失败 | 12/12 | 20 条既有诊断 |
| `/Users/wenzhuolin/.codex/worktrees/dc6d/synthia` | `7fbbde7a` | 235 通过，0 失败 | 12/12 | 此旧版没有 `runtime/tsconfig.json` |
| `/Users/wenzhuolin/.codex/worktrees/m4f-recover` | `b830e054` | 550 通过，0 失败 | 12/12 | 通过 |
| `/Users/wenzhuolin/dev/synthia-golden` | `315be4f0` | 412 通过，0 失败 | 12/12 | 23 条既有诊断 |

当前 157d 完整 `bun test`：**1095 通过、339 跳过、0 失败**。各工作区 `git diff --check -- runtime` 通过。

类型诊断使用修复前的 Runtime 文件快照独立复查：主目录/157d 的 20 条、golden 的 23 条均未新增，m4f 修复前后均通过。它们仍是类型门禁限制，本次没有把单元测试通过写成全部类型检查通过。

m4f 执行宽泛的 `bun test runtime` 还会包含 `connector/m4f-direct-six-process-runtime-probe-20.test.ts`：其中 8 项依赖缺失的 `/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json`，因此失败。该 Connector 文件未修改；没有伪造测试所需的生产验收记录。以上 Runtime 目录测试和 12 项回归不依赖该文件。

## 同步与保留

补丁按各工作区实际内容进行三方合并；dc6d 适配 `runId`/`RunState`，m4f/golden 保留 Project Agent、演化逻辑、已有历史恢复和外部验收流程。逐文件比较确认：本次范围外的既有 Runtime 文件未改动。

同步结果均为各工作区的**未提交改动**；分支 HEAD 未移动。没有向 Git 远端推送。前端和其他既有未提交工作保留。

实现文件：`runtime/loop.ts`、`free-agent.ts`、`server.ts`、`stream-hub.ts`、`core-api-connector.ts`、`remote-connector.ts`、`execution-control.ts`，以及相关接口与测试。回归入口：`bun test ./runtime/review-regressions.test.ts`。测试使用临时目录、脚本模型、Fake Connector/HTTP，不依赖真实模型、Core 数据库或 Vivado。
