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
import { phaseDocName } from "./artifacts.ts";
import { segmentAgentReply, type ReplySegment } from "./reply-segments.ts";
import type { TaskAuditEvent, TaskDocRef, TaskRunDetail } from "../api/types.ts";

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

// ─── 信息流（opencode 模式，spec ui-redesign-v2 §4）──────────────────────

/** 工具条标题（v2 §4.2）。 */
export const TOOL_BAR_TITLES: Readonly<Record<string, string>> = {
  validate_sources: "编译检查",
  simulate: "仿真",
  synthesize: "综合",
  implement: "实现并生成码流",
};

/** 阶段 id → 工具操作（工作台 current_stage 推导进行中工具条用）。 */
const STAGE_TO_TOOL_OP: Readonly<Record<string, string>> = {
  validate: "validate_sources",
  simulate: "simulate",
  synthesize: "synthesize",
  implement: "implement",
};

export type ToolBarState = "running" | "ok" | "failed";
export type GateBarState = "evaluating" | "passed" | "failed" | "awaiting";

export type FeedPart =
  | { readonly kind: "text"; readonly key: string; readonly ts: string; readonly text: string }
  /** free-agent 用户消息（右侧气泡；首轮指令由 detail.task 气泡覆盖）。 */
  | { readonly kind: "user"; readonly key: string; readonly ts: string; readonly text: string }
  /** free-agent 回复（左侧 assistant 叙述；已分段，长代码块折叠为代码卡）。 */
  | { readonly kind: "reply"; readonly key: string; readonly ts: string; readonly segments: readonly ReplySegment[] }
  | { readonly kind: "tool"; readonly key: string; readonly ts: string | null; readonly op: string; readonly title: string; readonly state: ToolBarState; readonly durationMs: number | null; readonly reason: string | null }
  | { readonly kind: "gate"; readonly key: string; readonly ts: string; readonly review: string; readonly state: GateBarState }
  | { readonly kind: "file"; readonly key: string; readonly ts: string | null; readonly doc: TaskDocRef; readonly title: string }
  | { readonly kind: "evidence"; readonly key: string; readonly ts: string | null; readonly count: number }
  | { readonly kind: "terminal"; readonly key: string; readonly ts: string; readonly state: "succeeded" | "failed"; readonly text: string };

/** 从 gate 类 action 提取门 id（如 "G2: …" → "G2"）。 */
function gateIdFromAction(action: string): string | null {
  const match = /^(G\d)/.exec(action);
  return match && match[1]! in GATE_REVIEW_NAMES ? match[1]! : null;
}

/** 从 governance 登记事件 detail 提取产物路径（`type=… path=…`）。 */
function pathFromGovernanceDetail(detail: string | undefined): string | null {
  if (!detail) return null;
  const match = /(?:^|\s)path=(\S+)/.exec(detail);
  return match ? match[1]! : null;
}

/**
 * 物化对话信息流（v2 §4）：audit + docs + evidence → part 数组，按时间序，不重排。
 *
 * 规则：
 * - model → 文本叙述（narrateAuditEvent 的中文句；连续重复句合并）；
 * - tool_call → 工具条（成功/失败；耗时=完成事件与对应权限门事件的时间差）；
 * - gate（gate_review）→ 门禁条，同一门只保留一个 part，状态取最新事件；
 * - gate（权限门 "gate ok (vivado-batch-1)"）与 lifecycle → 隐藏；
 * - governance 登记 → 产物文件卡（按 detail 里的 path 关联 docs）；
 * - evidence → 末尾一条「已收集证据 · N 项」摘要；
 * - loop → 终态卡（成功绿 / 失败红 + 人话原因）；
 * - run 进行中且当前阶段是工具操作 → 追加「进行中」工具条。
 */
export function buildFeed(detail: TaskRunDetail): FeedPart[] {
  const parts: FeedPart[] = [];
  const gatePartIndex = new Map<string, number>(); // gate → parts 下标
  const gateOkTs = new Map<string, number>(); // 工具操作 → 权限门通过时间（耗时起点）
  const filedDocs = new Set<string>(); // 已出文件卡的 revision_id

  const sorted = [...detail.audit].sort((a, b) => a.seq - b.seq);

  for (const event of sorted) {
    switch (event.category) {
      case "lifecycle":
        break; // 心跳/重连一律隐藏（HIDDEN 集合）

      case "model": {
        // free-agent 对话事件：用户消息 → 右侧气泡；回复 → assistant 分段叙述。
        // （free_agent_steer 无内容、free_agent_reply_error 已由输入区 ErrorNotice 覆盖，均不进流。）
        if (event.action === "user_message") {
          const text = event.detail?.trim();
          if (text) parts.push({ kind: "user", key: `u${event.seq}`, ts: event.ts, text });
          break;
        }
        if (event.action === "free_agent_reply") {
          const text = event.detail?.trim();
          if (text) parts.push({ kind: "reply", key: `r${event.seq}`, ts: event.ts, segments: segmentAgentReply(text) });
          break;
        }
        const text = narrateAuditEvent(event);
        if (!text) break;
        const prev = parts[parts.length - 1];
        if (prev?.kind === "text" && prev.text === text) break; // 降噪：连续重复句合并
        parts.push({ kind: "text", key: `t${event.seq}`, ts: event.ts, text });
        break;
      }

      case "tool_call": {
        const title = TOOL_BAR_TITLES[event.phase];
        if (!title) break;
        const startTs = gateOkTs.get(event.phase);
        const endTs = Date.parse(event.ts);
        const durationMs = startTs !== undefined && Number.isFinite(endTs) && endTs >= startTs ? endTs - startTs : null;
        const failed = event.result !== "ok";
        parts.push({
          kind: "tool",
          key: `x${event.seq}`,
          ts: event.ts,
          op: event.phase,
          title,
          state: failed ? "failed" : "ok",
          durationMs,
          reason: failed ? `${title}未能完成，任务已安全停止。技术原因见运行记录。` : null,
        });
        break;
      }

      case "gate": {
        if (event.phase !== "gate_review") {
          // 权限门：记录时间戳供工具条耗时计算，本身不进信息流。
          const ts = Date.parse(event.ts);
          if (Number.isFinite(ts)) gateOkTs.set(event.phase, ts);
          break;
        }
        const gateId = gateIdFromAction(event.action);
        if (!gateId) break;
        const review = GATE_REVIEW_NAMES[gateId as GateId];
        let state: GateBarState;
        if (event.action.includes("approved") || event.action.includes("auto-approved")) state = "passed";
        else if (event.action.includes("rejected") || event.action.includes("withdrawn")) state = "failed";
        else if (event.action.includes("awaiting human approval")) state = "awaiting";
        else if (event.action.includes("polling approval status")) break; // 轮询属技术细节
        else state = "evaluating"; // creating snapshot / submitting for review
        const existing = gatePartIndex.get(gateId);
        if (existing !== undefined) {
          const prev = parts[existing]!;
          if (prev.kind === "gate") parts[existing] = { ...prev, ts: event.ts, state };
        } else {
          gatePartIndex.set(gateId, parts.length);
          parts.push({ kind: "gate", key: `g-${gateId}`, ts: event.ts, review, state });
        }
        break;
      }

      case "governance": {
        const path = pathFromGovernanceDetail(event.detail);
        const doc = path ? detail.docs.find((d) => d.path === path) : undefined;
        if (doc && !filedDocs.has(doc.revision_id)) {
          filedDocs.add(doc.revision_id);
          parts.push({ kind: "file", key: `f-${doc.revision_id}`, ts: event.ts, doc, title: phaseDocName(doc.phase) });
        }
        break;
      }

      case "loop": {
        if (event.action === "loop succeeded") {
          parts.push({ kind: "terminal", key: `z${event.seq}`, ts: event.ts, state: "succeeded", text: "全流程完成，码流已生成 ✅" });
        } else if (event.action === "loop failed" || event.action === "loop fail_closed") {
          parts.push({ kind: "terminal", key: `z${event.seq}`, ts: event.ts, state: "failed", text: humanizeReason(detail.reason ?? event.detail) });
        }
        break; // "loop paused at Gx" 由门禁条 awaiting 覆盖
      }
    }
  }

  // 未能关联登记事件的产物 → 文件卡补到流尾。
  for (const doc of detail.docs) {
    if (filedDocs.has(doc.revision_id)) continue;
    filedDocs.add(doc.revision_id);
    parts.push({ kind: "file", key: `f-${doc.revision_id}`, ts: null, doc, title: phaseDocName(doc.phase) });
  }

  // 证据摘要：不内联全文，一行合并。
  const evidenceCount = detail.evidence.reduce((n, ev) => n + Math.max(ev.entries.length, 1), 0);
  if (evidenceCount > 0) {
    parts.push({ kind: "evidence", key: "evidence", ts: null, count: evidenceCount });
  }

  // 进行中的工具条（当前阶段是工具操作且尚无该操作的完成/失败条）。
  if (detail.status === "running" && detail.current_stage) {
    const op = STAGE_TO_TOOL_OP[normalizeStageId(detail.current_stage)];
    if (op && !parts.some((p) => p.kind === "tool" && p.op === op)) {
      parts.push({ kind: "tool", key: `running-${op}`, ts: null, op, title: TOOL_BAR_TITLES[op]!, state: "running", durationMs: null, reason: null });
    }
  }

  return parts;
}

/** 耗时格式化（工具条右侧）。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
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
