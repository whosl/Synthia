/**
 * 任务工作台领域规则（UI-2）。
 *
 * - 阶段链硬编码与 Contract 一致：intake→G1→behavior_wave→G2→architecture→
 *   register_spec→G3→rtl→validate→tb→simulate→xdc→synthesize→implement→G4。
 * - 节点状态推导：完成 / 进行中 / 等待（门节点 awaiting_approval）/ 未开始，
 *   终态失败时当前节点标「失败」。
 * - audit 事件类别（model/gate/tool_call/lifecycle/governance/loop）映射中文文案。
 */

import { GATE_REVIEW_NAMES, type GateId } from "./gates.ts";
import type { TaskAuditEvent } from "../api/types.ts";

// ─── 阶段链 ──────────────────────────────────────────────────────────

export type StageNodeKind = "stage" | "gate";

export interface StageNode {
  readonly id: string;
  readonly kind: StageNodeKind;
  readonly name: string;
}

/** 完整阶段链（顺序与 Contract 一致；门节点默认中文名，G 编号 hover 可见）。 */
export const STAGE_CHAIN: readonly StageNode[] = [
  { id: "intake", kind: "stage", name: "需求解析" },
  { id: "G1", kind: "gate", name: GATE_REVIEW_NAMES.G1 },
  { id: "behavior_wave", kind: "stage", name: "行为与波形设计" },
  { id: "G2", kind: "gate", name: GATE_REVIEW_NAMES.G2 },
  { id: "architecture", kind: "stage", name: "架构设计" },
  { id: "register_spec", kind: "stage", name: "寄存器规格" },
  { id: "G3", kind: "gate", name: GATE_REVIEW_NAMES.G3 },
  { id: "rtl", kind: "stage", name: "RTL 生成" },
  { id: "validate", kind: "stage", name: "源文件校验" },
  { id: "tb", kind: "stage", name: "测试台生成" },
  { id: "simulate", kind: "stage", name: "仿真" },
  { id: "xdc", kind: "stage", name: "约束生成" },
  { id: "synthesize", kind: "stage", name: "综合" },
  { id: "implement", kind: "stage", name: "布局布线实现" },
  { id: "G4", kind: "gate", name: GATE_REVIEW_NAMES.G4 },
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
  fail_closed: "已安全停止",
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

/** 单条 audit 事件 → 中文可读叙述条目（L3 技术向，仅运行记录页使用）。 */
export function describeAuditEvent(event: TaskAuditEvent): string {
  const category = AUDIT_CATEGORY_TEXT[event.category] ?? event.category;
  const phase = AUDIT_PHASE_TEXT[normalizeStageId(event.phase)] ?? event.phase;
  const result = event.result ? `（${AUDIT_RESULT_TEXT[event.result] ?? event.result}）` : "";
  const detail = event.detail ? ` — ${event.detail}` : "";
  return `${category} · ${phase} · ${event.action}${result}${detail}`;
}

// ─── 对话区叙述（L1 用户语言：完整中文句子，audit 原文禁止出现）────────────────

/** 工具操作 → 中文（L2 工程语言，工作台/运行记录共用）。 */
export const TOOL_OPERATION_TEXT: Readonly<Record<string, string>> = {
  validate_sources: "源文件校验",
  simulate: "仿真",
  synthesize: "综合",
  implement: "实现",
};

const MODEL_PHASE_SENTENCE: Readonly<Record<string, string>> = {
  generate_intake: "我已读完需求，整理出需求规格草案。",
  generate_behavior_wave: "行为与波形设计文档已整理完成。",
  generate_architecture: "架构设计文档已整理完成。",
  generate_register_spec: "寄存器规格文档已整理完成。",
  generate_rtl: "RTL 代码已生成。",
  generate_testbench: "仿真测试台已生成。",
  generate_xdc: "约束文件已生成。",
};

/** 从 gate 类 action 文本（如 "G2: awaiting human approval"）提取审查中文名。 */
function reviewNameFromAction(action: string): string | null {
  const match = /^(G\d)/.exec(action);
  return match ? (GATE_REVIEW_NAMES[match[1] as GateId] ?? null) : null;
}

/**
 * audit 事件 → 工作台对话气泡（完整中文句子）。
 * 返回 null 表示该事件不进对话区（技术事件一律跳过，绝不回退到 audit 原文）。
 */
export function narrateAuditEvent(event: TaskAuditEvent): string | null {
  if (event.category === "model") {
    const repair = /^repair round (\d+) applied$/.exec(event.action);
    if (repair) return `仿真发现问题，正在修复（第 ${repair[1]} 次尝试）。`;
    if (event.action === "validation feedback") return "生成内容未通过校验，正在调整。";
    if (event.action.endsWith(" failed")) return "内容生成失败，任务停止。";
    return MODEL_PHASE_SENTENCE[event.phase] ?? null;
  }

  if (event.category === "tool_call") {
    const operation = TOOL_OPERATION_TEXT[event.phase];
    if (!operation) return null;
    if (event.result === "ok") {
      switch (event.phase) {
        case "validate_sources": return "源文件校验通过。";
        case "simulate": return "仿真通过。";
        case "synthesize": return "综合完成，资源占用正常。";
        case "implement": return "实现完成，码流已生成 ✅";
      }
    }
    return `${operation}未能完成，任务已安全停止。`;
  }

  if (event.category === "gate") {
    // 权限门（"gate ok (vivado-batch-1)" 等）与快照/轮询属技术事件，不进对话。
    if (event.phase !== "gate_review") return null;
    const review = reviewNameFromAction(event.action);
    if (!review) return null;
    if (event.action.includes("submitting for review")) return `「${review}」已提交，等待批准。`;
    if (event.action.includes("awaiting human approval")) return `「${review}」正在等待你的批准。`;
    if (event.action.includes("approved — continuing")) return `「${review}」已通过，继续下一步。`;
    if (event.action.includes("auto-approved")) return `「${review}」已通过。`;
    if (event.action.includes("rejected")) return `「${review}」被驳回，任务已安全停止。`;
    if (event.action.includes("withdrawn")) return `「${review}」已撤回，任务已安全停止。`;
    return null;
  }

  if (event.category === "loop") {
    if (event.action === "loop succeeded") return "全流程完成，码流已生成 ✅";
    if (event.action === "loop failed" || event.action === "loop fail_closed") return "任务已停止，技术原因请查看运行记录。";
    return null; // "loop paused at Gx" 由 gate awaiting 句覆盖
  }

  // lifecycle / governance：技术事件，不进对话区。
  return null;
}

/**
 * 失败原因 → 人话（主页面横幅用；技术原文只进运行记录页）。
 */
export function humanizeReason(reason: string | null | undefined): string {
  if (!reason) return "任务未成功完成，已安全停止。";
  const rejected = /gate (G\d) was rejected/i.exec(reason);
  if (rejected) {
    const review = GATE_REVIEW_NAMES[rejected[1] as GateId];
    return review ? `「${review}」被驳回，任务已安全停止。` : "审查被驳回，任务已安全停止。";
  }
  const withdrawn = /gate (G\d) was withdrawn/i.exec(reason);
  if (withdrawn) {
    const review = GATE_REVIEW_NAMES[withdrawn[1] as GateId];
    return review ? `「${review}」已撤回，任务已安全停止。` : "审查已撤回，任务已安全停止。";
  }
  return "任务遇到问题，已安全停止；技术原因见运行记录。";
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
