/**
 * 统一项目页 v3 状态带领域规则（specs/unified-project-page-v3.md §4/§11）。
 *
 * 「当前动作」一句话推导：awaiting → 「G? 等待批准」+高亮；running → 阶段+已用时；
 * 终态 → 人话总结。等待/失败一律人话 + 可感知的等待时长（关联号只在记录面板）。
 */

export type CurrentActionTone = "running" | "awaiting" | "done" | "failed" | "idle";

export interface CurrentAction {
  readonly text: string;
  readonly tone: CurrentActionTone;
}

export interface CurrentActionInput {
  readonly status: string;
  /** 当前阶段中文名（STAGE_NAME_TEXT；无当前阶段为 null）。 */
  readonly stageName: string | null;
  /** 等待批准的审查中文名（GATE_REVIEW_NAMES；无等待为 null）。 */
  readonly awaitingReview: string | null;
  /** 当前动作已持续的毫秒数（未知为 null）。 */
  readonly elapsedMs: number | null;
}

/** 等待时长人话（<1 分钟按秒，<1 小时按分钟，更长带小时）。 */
export function waitText(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/** 终态 → 人话短句（与 TASK_STATUS_TEXT 对齐的口语版）。 */
export function terminalActionText(status: string): string {
  switch (status) {
    case "succeeded": return "全流程完成，码流已生成 ✅";
    case "failed": return "任务失败，已停止";
    case "fail_closed": return "任务已安全停止";
    case "interrupted": return "任务已中断";
    default: return "等待新指令";
  }
}

/**
 * 「当前动作」一句话：
 * - awaiting_approval →「<审查> 等待批准 · 已等待 X」（tone=awaiting，状态带高亮）；
 * - running →「<阶段>中 · 已 X」（无阶段仅「处理中」）；
 * - 终态 → terminalActionText；
 * - 其余 → 等待新指令。
 */
export function currentAction(input: CurrentActionInput): CurrentAction {
  if (input.status === "awaiting_approval") {
    const wait = input.elapsedMs !== null ? ` · 已等待 ${waitText(input.elapsedMs)}` : "";
    return {
      text: input.awaitingReview ? `${input.awaitingReview}等待批准${wait}` : `等待批准${wait}`,
      tone: "awaiting",
    };
  }
  if (input.status === "running") {
    const elapsed = input.elapsedMs !== null ? ` · 已 ${waitText(input.elapsedMs)}` : "…";
    return {
      text: input.stageName ? `${input.stageName}中${elapsed}` : `Agent 正在处理${elapsed}`,
      tone: "running",
    };
  }
  if (input.status === "failed" || input.status === "fail_closed" || input.status === "interrupted") {
    return { text: terminalActionText(input.status), tone: "failed" };
  }
  if (input.status === "succeeded") {
    return { text: terminalActionText(input.status), tone: "done" };
  }
  return { text: terminalActionText(input.status), tone: "idle" };
}

/**
 * 阶段/等待的起始时刻估算（供已用时计算）：
 * 运行中 → 该阶段最新一条 audit 事件时间（无事件 → null）；
 * 等待批准 → 提交时间 submitted_at（缺失回退最新 audit 事件时间）。
 */
export function actionStartedAt(
  status: string,
  submittedAt: string | null,
  lastAuditTs: string | null,
): string | null {
  if (status === "awaiting_approval") return submittedAt ?? lastAuditTs;
  return lastAuditTs;
}
