/**
 * 运行记录面板数据层（对话流之外的技术细节：jobId/errorCode/证据条目全量）。
 *
 * `domain/parts.ts:auditToParts` 把 audit 六类事件压缩成人话对话流，`evidence`
 * 只剩一行计数——这是有意的降噪（见该文件注释「关联号只在记录面板可见」），
 * 不应该往回塞技术字段。本模块反过来：从同一份 `TaskAgentDetail` 里取
 * `evidence`（每个真实工具调用的冻结证据清单）与 `audit`（tool_call 事件带的
 * jobId/errorCode/时间戳）按 jobId 关联，拼成运行记录面板要的完整视图——
 * 纯函数，不发请求；单条证据的解码内容仍需调用方按需另调
 * `api/index.ts:getJobEvidenceContent`（ProjectView 持有，见受控组件契约）。
 */

import type { TaskAgentDetail } from "../api/types.ts";
import { TOOL_BAR_TITLES } from "./tasks.ts";

export interface RecordEvidenceEntry {
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
}

export interface RecordJob {
  readonly jobId: string;
  /** 白名单操作原文（validate_sources/simulate/…），供 `${jobId}:${name}` 之外的关联用。 */
  readonly operation: string;
  /** 操作中文标题，复用 `TOOL_BAR_TITLES`（与对话流工具条标题一致）。 */
  readonly title: string;
  /** VivadoResult 状态原文（succeeded/failed/timeout/lost/unsupported/unknown_effect）。 */
  readonly status: string;
  readonly ok: boolean;
  readonly inputSha256: string;
  /** 关联的 tool_call audit 事件时间戳；未找到匹配事件为 null。 */
  readonly ts: string | null;
  /** 关联的 tool_call audit 事件错误码；成功或未找到为 null。 */
  readonly errorCode: string | null;
  /** 同一操作在本次 run 中第几轮（1 起）；仿真修复循环据此显示「第 N 轮」。 */
  readonly round: number;
  readonly entries: readonly RecordEvidenceEntry[];
}

/** 证据条目在记录面板内的稳定 key（`getJobEvidenceContent` 缓存键复用同一格式）。 */
export function recordEntryKey(jobId: string, name: string): string {
  return `${jobId}:${name}`;
}

/**
 * `TaskAgentDetail` → 运行记录面板的 job 列表，按 `evidence` 原有顺序（即执行
 * 顺序）保留，逐条关联同 jobId 的 tool_call audit 事件取 ts/errorCode，并按
 * operation 计算「第几轮」。
 */
export function buildRecordJobs(detail: TaskAgentDetail): RecordJob[] {
  const roundByOp = new Map<string, number>();
  return detail.evidence.map((ev): RecordJob => {
    const round = (roundByOp.get(ev.operation) ?? 0) + 1;
    roundByOp.set(ev.operation, round);
    const auditEvent = detail.audit.find((e) => e.category === "tool_call" && e.jobId === ev.jobId);
    const ok = ev.status === "succeeded";
    return {
      jobId: ev.jobId,
      operation: ev.operation,
      title: TOOL_BAR_TITLES[ev.operation] ?? ev.operation,
      status: ev.status,
      ok,
      inputSha256: ev.inputSha256,
      ts: auditEvent?.ts ?? null,
      errorCode: ok ? null : auditEvent?.errorCode ?? null,
      round,
      entries: ev.entries,
    };
  });
}
