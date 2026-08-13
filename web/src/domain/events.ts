/**
 * 项目事件流 / 产物类型的 UI 中文映射（spec ui-redesign-v1 §4.3 / §4.6）。
 *
 * - 事件流在主页面只显示人话叙述（「架构设计文档已提交审查」），
 *   event_type 原文、aggregate_id、sequence 一律不出现。
 * - 产物按「需求/行为/架构/寄存器/RTL/约束/…」中文分组，英文类型枚举不直接显示。
 */

import { GATE_REVIEW_NAMES, type GateId } from "./gates.ts";
import type { OutboxEvent } from "../api/types.ts";

// ─── 事件流人话叙述 ────────────────────────────────────────────────────

/** 从事件 payload 中提取 gate 字段（存在且为已知门时返回中文审查名）。 */
function reviewNameFromPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("gate" in payload)) return null;
  const gate = payload.gate;
  if (typeof gate !== "string" || !(gate in GATE_REVIEW_NAMES)) return null;
  return GATE_REVIEW_NAMES[gate as GateId];
}

/** 单条项目事件 → 人话叙述（完整中文句子；未知类型给通用句，绝不回退原文）。 */
export function eventNarration(event: OutboxEvent): string {
  const review = reviewNameFromPayload(event.payload);
  switch (event.event_type) {
    case "project.created": return "项目已创建。";
    case "process.created": return "项目流程已启动。";
    case "revision.created": return "产物文档有新版本（候选）。";
    case "snapshot.created": return "候选产物已汇总，准备送审。";
    case "gate.submission_created":
      return review ? `「${review}」的审查提交已创建。` : "审查提交已创建。";
    case "gate_submission.submitted_for_review": return "审查已提交，等待批准。";
    case "gate.approved":
      return review ? `「${review}」已通过。` : "审查已通过。";
    case "gate_submission.rejected": return "审查被驳回。";
    case "gate_submission.withdrawn": return "审查提交已撤回。";
    case "task.forwarded": return "新任务已下发执行。";
    case "tool_run.submitted": return "工具运行已提交。";
    case "trace.created": return "追踪关系已建立。";
    case "role.assigned": return "项目角色已分配。";
    default: return "项目有新的动态。";
  }
}

// ─── 产物中文分组 ──────────────────────────────────────────────────────

/** 产物类型 → 中文分组（spec §4.6；未列出的治理/内部类型归「其他」）。 */
const ARTIFACT_TYPE_GROUP: Readonly<Record<string, string>> = {
  DEVELOPMENT_REQUIREMENTS: "需求",
  SYSTEM_REQUIREMENTS: "需求",
  OPEN_QUESTION_SET: "需求",
  PLDS_SRS: "行为",
  DERIVED_REQUIREMENT_SET: "行为",
  REQUIREMENT_TRACE: "行为",
  VERIFICATION_METHOD_MAP: "行为",
  DETAILED_DESIGN: "行为",
  ARCHITECTURE_DESIGN: "架构",
  CONSTRAINT_DESIGN: "架构",
  DESIGN_TRACE: "架构",
  DESIGN_REVIEW: "架构",
  RTL_SOURCE_SET: "RTL",
  TB_SOURCE_SET: "RTL",
  CODE_TRACE: "RTL",
  CODE_REVIEW: "RTL",
  XDC_CANDIDATE: "约束",
};

/** 产物类型 → 中文分组名（未知类型归「其他」，不显示英文枚举）。 */
export function artifactGroupName(artifactType: string): string {
  return ARTIFACT_TYPE_GROUP[artifactType] ?? "其他";
}

/** 分组显示顺序。 */
export const ARTIFACT_GROUP_ORDER: readonly string[] = [
  "需求", "行为", "架构", "RTL", "约束", "其他",
];
