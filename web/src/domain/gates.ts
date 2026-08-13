/**
 * 门禁 / 基线领域规则（与 core/src/domain/enums.ts 及 SYNTHIA-FLOW-001 §4/§6 一致）。
 *
 * - 里程碑门集合硬编码：G1/G3/G4/G7/G9 → B0/B1/B2/B3/B4。
 * - 门禁泳道状态由 gate_submissions 列表推导（无提交=未开始，in_review=审批中，
 *   approved=已批准，rejected=被驳回；submitted/checking 视为审批中，
 *   preparing/withdrawn 视为未开始）。
 */

export type GateId =
  | "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";

export type BaselineKind = "B0" | "B1" | "B2" | "B3" | "B4";

export const GATES: readonly GateId[] = [
  "G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9",
];

export const MILESTONE_GATES: readonly GateId[] = ["G1", "G3", "G4", "G7", "G9"];

export function isMilestoneGate(gate: string): gate is GateId {
  return (MILESTONE_GATES as readonly string[]).includes(gate);
}

/** 里程碑门 → 基线种类（core domain/enums.ts GATE_TO_BASELINE 镜像）。 */
export const GATE_TO_BASELINE: Readonly<Record<string, BaselineKind>> = {
  G1: "B0",
  G3: "B1",
  G4: "B2",
  G7: "B3",
  G9: "B4",
};

export const BASELINE_NAMES: Readonly<Record<BaselineKind, string>> = {
  B0: "需求里程碑",
  B1: "设计里程碑",
  B2: "RTL里程碑",
  B3: "实现里程碑",
  B4: "发布里程碑",
};

export const BASELINE_KINDS: readonly BaselineKind[] = ["B0", "B1", "B2", "B3", "B4"];

/** 批准里程碑门时自动生成的基线 id：bl-<gate小写>-<时间戳>。 */
export function makeBaselineId(gate: GateId, now: number = Date.now()): string {
  return `bl-${gate.toLowerCase()}-${now}`;
}

// ─── 门禁泳道状态推导 ────────────────────────────────────────────────────────

export type GateLaneState = "not_started" | "in_review" | "approved" | "rejected";

export const GATE_LANE_STATE_TEXT: Readonly<Record<GateLaneState, string>> = {
  not_started: "未开始",
  in_review: "等待批准",
  approved: "已通过",
  rejected: "被驳回",
};

// ─── UI 术语表（spec ui-redesign-v1 §5）───────────────────────────────────────

/** 门审查中文名：主页面默认显示中文，G 编号仅 hover 可见。 */
export const GATE_REVIEW_NAMES: Readonly<Record<GateId, string>> = {
  G0: "项目启动",
  G1: "需求审查",
  G2: "行为审查",
  G3: "设计审查",
  G4: "RTL审查",
  G5: "综合审查",
  G6: "实现审查",
  G7: "测试审查",
  G8: "码流审查",
  G9: "验收审查",
};

/** 审查提交状态 → 中文（英文枚举不得出现在主页面）。 */
export const SUBMISSION_STATE_TEXT: Readonly<Record<string, string>> = {
  preparing: "准备中",
  submitted: "已提交",
  checking: "检查中",
  in_review: "等待批准",
  approved: "已通过",
  rejected: "被驳回",
  withdrawn: "已撤回",
};

/** 项目状态 → 中文。 */
export const PROJECT_STATUS_TEXT: Readonly<Record<string, string>> = {
  active: "进行中",
  archived: "已归档",
  closed: "已关闭",
};

export type GateSubmissionState =
  | "preparing" | "submitted" | "checking" | "in_review"
  | "approved" | "rejected" | "withdrawn";

export interface GateSubmissionLite {
  readonly id: string;
  readonly gate: string;
  readonly state: GateSubmissionState | string;
  readonly created_at: string;
  readonly submitted_at?: string | null;
}

/** 单个提交状态 → 泳道状态。 */
export function submissionToLaneState(state: string): GateLaneState {
  switch (state) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "submitted":
    case "checking":
    case "in_review":
      return "in_review";
    default:
      // preparing / withdrawn / 未知：视为未开始（未进入审批流）
      return "not_started";
  }
}

/**
 * 由项目的全部 gate_submissions 推导每个门的泳道状态。
 * 同一门取最新一次提交（created_at 最大）判定。
 */
export function deriveGateLanes(submissions: readonly GateSubmissionLite[]): Record<GateId, GateLaneState> {
  const latest = new Map<string, GateSubmissionLite>();
  for (const sub of submissions) {
    const prev = latest.get(sub.gate);
    if (!prev || sub.created_at > prev.created_at) latest.set(sub.gate, sub);
  }
  const lanes = {} as Record<GateId, GateLaneState>;
  for (const gate of GATES) {
    const sub = latest.get(gate);
    lanes[gate] = sub ? submissionToLaneState(sub.state) : "not_started";
  }
  return lanes;
}

/**
 * 当前门：G0→G9 顺序中第一个未批准的门；全部批准时返回 null（项目已交付）。
 */
export function currentGate(lanes: Record<GateId, GateLaneState>): GateId | null {
  for (const gate of GATES) {
    if (lanes[gate] !== "approved") return gate;
  }
  return null;
}

// ─── 修订状态标签 ────────────────────────────────────────────────────────────

export const REVISION_STATE_TEXT: Readonly<Record<string, string>> = {
  candidate: "候选",
  in_review: "审批中",
  approved: "已批准",
  rejected: "被驳回",
  superseded: "已替换",
  invalidated: "已失效",
};

export const BASELINE_STATE_TEXT: Readonly<Record<string, string>> = {
  active: "生效",
  superseded: "已替换",
  invalidated: "已失效",
  retired: "已退役",
};
