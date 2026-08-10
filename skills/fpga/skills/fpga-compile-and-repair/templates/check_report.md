# 编译检查报告

## Compile Result

| Item | Value |
| --- | --- |
| Status | PASS / COMPILE_FAIL |
| Exit Code | 0 / non-zero |
| Log Evidence | EvidenceManifest 条目（SHA-256） |
| Observed Worker command (evidence only) | （引用 Core 登记的 ToolRun 记录字段，见下方说明） |

> 上表命令与日志仅引用 Core 登记的 ToolRun/EvidenceManifest 条目（含 SHA-256），
> 属于历史执行证据：**不可复制执行、不可由 Skill/UI 触发**。任何新的工具运行
> 只能由 Core 经 Connector Port → Adapter → Worker 链路重新构造 JobRequest。

## Diagnostics (if failed)

| Severity | File | Line | Message | Root Cause |
| --- | --- | --- | --- | --- |

## Patches Applied (if any)

| File | Change | Reason |
| --- | --- | --- |
| | | |

## Remaining Issues

-

## Recommended Next Skill

- If compile failed after 3 attempts: `fpga-tb-write` (revise TB) or `fpga-rtl-build` (fix RTL)
- If compile passed and user wants runtime evidence: `fpga-sim-run`
- If compile passed and user did not request simulation: done
