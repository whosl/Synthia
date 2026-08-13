/**
 * 任务工作台领域规则（UI-2）。
 *
 * - 阶段链硬编码与 Contract 一致：intake→G1→behavior_wave→G2→architecture→
 *   register_spec→G3→rtl→validate→tb→simulate→xdc→synthesize→implement→G4。
 * - 节点状态推导：完成 / 进行中 / 等待（门节点 awaiting_approval）/ 未开始，
 *   终态失败时当前节点标「失败」。
 * - audit 事件类别（model/gate/tool_call/lifecycle/governance/loop）映射中文文案。
 */

import { GATE_NAMES } from "./gates.ts";
import type { TaskAuditEvent } from "../api/types.ts";

// ─── 阶段链 ──────────────────────────────────────────────────────────

export type StageNodeKind = "stage" | "gate";

export interface StageNode {
  readonly id: string;
  readonly kind: StageNodeKind;
  readonly name: string;
}

/** 完整阶段链（顺序与 Contract 一致，不得私改）。 */
export const STAGE_CHAIN: readonly StageNode[] = [
  { id: "intake", kind: "stage", name: "需求解析" },
  { id: "G1", kind: "gate", name: `G1 ${GATE_NAMES.G1}` },
  { id: "behavior_wave", kind: "stage", name: "行为与波形设计" },
  { id: "G2", kind: "gate", name: `G2 ${GATE_NAMES.G2}` },
  { id: "architecture", kind: "stage", name: "架构设计" },
  { id: "register_spec", kind: "stage", name: "寄存器规格" },
  { id: "G3", kind: "gate", name: `G3 ${GATE_NAMES.G3}` },
  { id: "rtl", kind: "stage", name: "RTL 生成" },
  { id: "validate", kind: "stage", name: "源文件校验" },
  { id: "tb", kind: "stage", name: "测试台生成" },
  { id: "simulate", kind: "stage", name: "仿真" },
  { id: "xdc", kind: "stage", name: "约束生成" },
  { id: "synthesize", kind: "stage", name: "综合" },
  { id: "implement", kind: "stage", name: "布局布线实现" },
  { id: "G4", kind: "gate", name: `G4 ${GATE_NAMES.G4}` },
];

/** Runtime run-state 的阶段别名 → 阶段链节点 id（runtime 用 rtl_build，Contract 链用 rtl）。 */
const STAGE_ALIASES: Readonly<Record<string, string>> = {
  rtl_build: "rtl",
};

/** 阶段 id → 中文名（含 audit phase 的别名）。 */
export const STAGE_NAME_TEXT: Readonly<Record<string, string>> = Object.fromEntries(
  STAGE_CHAIN.map((n) => [n.id, n.name]),
);

export function normalizeStageId(stage: string): string {
  return STAGE_ALIASES[stage] ?? stage;
}

/** 阶段/门节点状态。 */
export type StageNodeStatus = "done" | "running" | "waiting" | "pending" | "failed";

export const STAGE_NODE_STATUS_TEXT: Readonly<Record<StageNodeStatus, string>> = {
  done: "完成",
  running: "进行中",
  waiting: "等待批准",
  pending: "未开始",
  failed: "失败",
};

export interface StageChainNode {
  readonly node: StageNode;
  readonly status: StageNodeStatus;
}

export interface StageChainInput {
  readonly status: string;
  readonly current_stage: string | null;
  readonly awaiting_gate: string | null;
}

/**
 * 由 run 状态推导阶段链各节点状态。
 *
 * - succeeded：全部完成。
 * - awaiting_approval：等待门之前的节点全部完成，该门「等待批准」，之后未开始。
 * - running / interrupted：current_stage 节点进行中，之前完成，之后未开始。
 * - failed / fail_closed：current_stage 节点失败，之前完成，之后未开始。
 * - current_stage 为 null 且非终态：全部未开始。
 */
export function deriveStageChain(input: StageChainInput): StageChainNode[] {
  if (input.status === "succeeded") {
    return STAGE_CHAIN.map((node) => ({ node, status: "done" }));
  }

  const chainIndex = (id: string): number => STAGE_CHAIN.findIndex((n) => n.id === id);

  if (input.status === "awaiting_approval" && input.awaiting_gate) {
    const gateIdx = chainIndex(input.awaiting_gate);
    if (gateIdx >= 0) {
      return STAGE_CHAIN.map((node, i) => ({
        node,
        status: i < gateIdx ? "done" : i === gateIdx ? "waiting" : "pending",
      }));
    }
  }

  const currentId = input.current_stage ? normalizeStageId(input.current_stage) : null;
  const currentIdx = currentId ? chainIndex(currentId) : -1;
  if (currentIdx < 0) {
    return STAGE_CHAIN.map((node) => ({ node, status: "pending" }));
  }

  const failed = input.status === "failed" || input.status === "fail_closed";
  return STAGE_CHAIN.map((node, i) => ({
    node,
    status: i < currentIdx ? "done" : i === currentIdx ? (failed ? "failed" : "running") : "pending",
  }));
}

// ─── run 状态文案 ─────────────────────────────────────────────────────

export const TASK_STATUS_TEXT: Readonly<Record<string, string>> = {
  running: "运行中",
  awaiting_approval: "等待批准",
  succeeded: "已完成",
  failed: "失败",
  fail_closed: "失败关闭",
  interrupted: "已中断",
};

/** 是否为终态（终态后前端停止轮询）。 */
export function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "fail_closed" || status === "interrupted";
}

/** run_id 短码：run-<uuid> → 取 uuid 前 8 位。 */
export function shortRunId(runId: string): string {
  const rest = runId.startsWith("run-") ? runId.slice(4) : runId;
  return rest.length > 8 ? `${rest.slice(0, 8)}…` : rest;
}

// ─── audit 事件中文叙述 ────────────────────────────────────────────────

export const AUDIT_CATEGORY_TEXT: Readonly<Record<string, string>> = {
  model: "模型生成",
  gate: "门禁",
  tool_call: "工具调用",
  lifecycle: "运行生命周期",
  governance: "产物登记",
  loop: "流程控制",
};

const AUDIT_PHASE_TEXT: Readonly<Record<string, string>> = {
  ...STAGE_NAME_TEXT,
  gate_review: "门禁评审",
  governance: "产物登记",
  loop: "流程控制",
};

const AUDIT_RESULT_TEXT: Readonly<Record<string, string>> = {
  ok: "成功",
  failed: "失败",
  fail_closed: "失败关闭",
};

/** 单条 audit 事件 → 中文可读叙述条目。 */
export function describeAuditEvent(event: TaskAuditEvent): string {
  const category = AUDIT_CATEGORY_TEXT[event.category] ?? event.category;
  const phase = AUDIT_PHASE_TEXT[normalizeStageId(event.phase)] ?? event.phase;
  const result = event.result ? `（${AUDIT_RESULT_TEXT[event.result] ?? event.result}）` : "";
  const detail = event.detail ? ` — ${event.detail}` : "";
  return `${category} · ${phase} · ${event.action}${result}${detail}`;
}

// ─── 轮询 ────────────────────────────────────────────────────────────

export interface Poller {
  stop(): void;
}

/**
 * 简单轮询器：setInterval + stop 清理（页面卸载时必须 stop）。
 * tick 返回 false 时自动停止（如 run 到达终态）。
 */
export function createPoller(tick: () => boolean | void, intervalMs: number): Poller {
  const timer = setInterval(() => {
    if (tick() === false) clearInterval(timer);
  }, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
