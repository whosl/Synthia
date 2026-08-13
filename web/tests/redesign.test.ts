import { describe, expect, test } from "bun:test";
import {
  STAGE_CHAIN,
  STAGE_NODE_STATUS_TEXT,
  TASK_STATUS_TEXT,
  humanizeReason,
  narrateAuditEvent,
} from "../src/domain/tasks.ts";
import {
  BASELINE_NAMES,
  GATE_LANE_STATE_TEXT,
  GATE_REVIEW_NAMES,
  GATES,
  PROJECT_STATUS_TEXT,
  REVISION_STATE_TEXT,
  SUBMISSION_STATE_TEXT,
} from "../src/domain/gates.ts";
import { eventNarration } from "../src/domain/events.ts";
import { ARTIFACT_GROUP_ORDER, artifactGroupName } from "../src/domain/artifacts.ts";
import type { OutboxEvent, TaskAuditEvent } from "../src/api/types.ts";

/**
 * L3 禁止词表（spec ui-redesign-v1 §6.1/§6.7）：
 * 主页面默认渲染的所有文案来源（domain 文案函数与映射表）一律不得包含这些内容。
 * 注：SFC 无法在 bun test 中挂载，主页面的默认渲染文案全部由 domain 层函数产出，
 * 对 domain 产出做禁止词断言即等价于对默认渲染的组件级断言。
 */
const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "jobId", pattern: /jobid/i },
  { name: "64位哈希", pattern: /\b[0-9a-f]{64}\b/ },
  { name: "vivado-batch-1", pattern: /vivado-batch-1/i },
  {
    name: "英文状态枚举",
    pattern: /\b(running|awaiting_approval|succeeded|fail_closed|interrupted|in_review|candidate|submitted|checking|preparing|withdrawn|active)\b/i,
  },
  { name: "audit 类别/阶段原文", pattern: /\b(tool_call|gate_review|lifecycle|governance|rtl_build|behavior_wave|register_spec)\b/i },
];

function expectClean(text: string, context: string): void {
  for (const { name, pattern } of FORBIDDEN) {
    expect(pattern.test(text), `${context} 含禁止内容「${name}」：${text}`).toBe(false);
  }
}

function audit(partial: Partial<TaskAuditEvent> & Pick<TaskAuditEvent, "category" | "phase" | "action">): TaskAuditEvent {
  return { ts: "2026-08-13T00:00:00Z", seq: 1, ...partial };
}

describe("术语表（§5）", () => {
  test("G0~G9 均有中文审查名且通过禁止词检查", () => {
    for (const gate of GATES) {
      const name = GATE_REVIEW_NAMES[gate];
      expect(name).toBeTruthy();
      expect(/[一-鿿]/.test(name)).toBe(true);
      expectClean(name, `GATE_REVIEW_NAMES.${gate}`);
    }
    expect(GATE_REVIEW_NAMES.G1).toBe("需求审查");
    expect(GATE_REVIEW_NAMES.G2).toBe("行为审查");
    expect(GATE_REVIEW_NAMES.G3).toBe("设计审查");
    expect(GATE_REVIEW_NAMES.G4).toBe("RTL审查");
  });

  test("全部状态文案映射通过禁止词检查", () => {
    const maps: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
      ["GATE_LANE_STATE_TEXT", GATE_LANE_STATE_TEXT],
      ["SUBMISSION_STATE_TEXT", SUBMISSION_STATE_TEXT],
      ["PROJECT_STATUS_TEXT", PROJECT_STATUS_TEXT],
      ["TASK_STATUS_TEXT", TASK_STATUS_TEXT],
      ["STAGE_NODE_STATUS_TEXT", STAGE_NODE_STATUS_TEXT],
      ["BASELINE_NAMES", BASELINE_NAMES],
      ["REVISION_STATE_TEXT", REVISION_STATE_TEXT],
    ];
    for (const [label, map] of maps) {
      for (const [key, text] of Object.entries(map)) {
        expectClean(text, `${label}.${key}`);
      }
    }
    expect(TASK_STATUS_TEXT.fail_closed).toBe("已安全停止");
    expect(GATE_LANE_STATE_TEXT.in_review).toBe("等待批准");
    expect(GATE_LANE_STATE_TEXT.approved).toBe("已通过");
  });

  test("阶段链门节点默认显示中文审查名", () => {
    for (const node of STAGE_CHAIN) {
      expectClean(node.name, `STAGE_CHAIN.${node.id}`);
      if (node.kind === "gate") {
        expect(node.name).toBe(GATE_REVIEW_NAMES[node.id as keyof typeof GATE_REVIEW_NAMES]);
      }
    }
  });
});

describe("工作台对话叙述（§4.4/§6.2）", () => {
  test("模型生成事件 → 完整中文句子", () => {
    expect(narrateAuditEvent(audit({ category: "model", phase: "generate_intake", action: "intake doc generated: docs/intake.md", result: "ok" })))
      .toBe("我已读完需求，整理出需求规格草案。");
    expect(narrateAuditEvent(audit({ category: "model", phase: "generate_rtl", action: "rtl generated", result: "ok" })))
      .toBe("RTL 代码已生成。");
    expect(narrateAuditEvent(audit({ category: "model", phase: "repair", action: "repair round 2 applied", result: "ok" })))
      .toBe("仿真发现问题，正在修复（第 2 次尝试）。");
  });

  test("工具调用成功 → 人话结论（jobId/哈希不得泄漏）", () => {
    const synth = narrateAuditEvent(audit({
      category: "tool_call", phase: "synthesize", action: "synthesize succeeded", result: "ok",
      jobId: "job-123", inputSha256: "a".repeat(64),
    }));
    expect(synth).toBe("综合完成，资源占用正常。");
    const impl = narrateAuditEvent(audit({ category: "tool_call", phase: "implement", action: "implement succeeded", result: "ok", jobId: "job-9" }));
    expect(impl).toBe("实现完成，码流已生成 ✅");
  });

  test("门禁事件 → 审查中文名句子", () => {
    expect(narrateAuditEvent(audit({ category: "gate", phase: "gate_review", action: "G1: submitting for review", result: "ok" })))
      .toBe("「需求审查」已提交，等待批准。");
    expect(narrateAuditEvent(audit({ category: "gate", phase: "gate_review", action: "G2: awaiting human approval", result: "ok" })))
      .toBe("「行为审查」正在等待你的批准。");
    expect(narrateAuditEvent(audit({ category: "gate", phase: "gate_review", action: "G2: approved — continuing", result: "ok" })))
      .toBe("「行为审查」已通过，继续下一步。");
    expect(narrateAuditEvent(audit({ category: "gate", phase: "gate_review", action: "G2: rejected — fail-closed", result: "fail_closed" })))
      .toBe("「行为审查」被驳回，任务已安全停止。");
  });

  test("loop 终态 → 人话；技术事件一律跳过（不回退原文）", () => {
    expect(narrateAuditEvent(audit({ category: "loop", phase: "loop", action: "loop succeeded", result: "ok" })))
      .toBe("全流程完成，码流已生成 ✅");
    // 以下技术事件必须返回 null，绝不允许原文出现在对话气泡
    expect(narrateAuditEvent(audit({ category: "gate", phase: "validate_sources", action: "gate ok (vivado-batch-1)", result: "ok" }))).toBeNull();
    expect(narrateAuditEvent(audit({ category: "gate", phase: "gate_review", action: "G1: creating snapshot (3 revisions)", result: "ok" }))).toBeNull();
    expect(narrateAuditEvent(audit({ category: "gate", phase: "gate_review", action: "G1: polling approval status", result: "ok" }))).toBeNull();
    expect(narrateAuditEvent(audit({ category: "governance", phase: "governance", action: "registered RTL artifact: rev-abc", result: "ok" }))).toBeNull();
    expect(narrateAuditEvent(audit({ category: "lifecycle", phase: "loop", action: "connector heartbeat", result: "ok" }))).toBeNull();
    expect(narrateAuditEvent(audit({ category: "loop", phase: "loop", action: "loop paused at G2", result: "ok" }))).toBeNull();
  });

  test("仿真修复 + 失败停句", () => {
    expect(narrateAuditEvent(audit({ category: "tool_call", phase: "simulate", action: "simulate fail-closed", result: "fail_closed", errorCode: "SIM_ASSERT" })))
      .toBe("仿真未能完成，任务已安全停止。");
    expect(narrateAuditEvent(audit({ category: "model", phase: "generate_rtl", action: "model generate_rtl failed", result: "failed" })))
      .toBe("内容生成失败，任务停止。");
  });

  test("真实风格 audit 流：全部非空叙述都是干净中文句", () => {
    const stream: TaskAuditEvent[] = [
      audit({ category: "model", phase: "generate_intake", action: "intake doc generated: docs/intake.md", result: "ok" }),
      audit({ category: "governance", phase: "governance", action: "registered intake artifact: rev-1", result: "ok" }),
      audit({ category: "gate", phase: "gate_review", action: "G1: creating snapshot (1 revisions)", result: "ok" }),
      audit({ category: "gate", phase: "gate_review", action: "G1: submitting for review", result: "ok" }),
      audit({ category: "gate", phase: "gate_review", action: "G1: awaiting human approval", result: "ok" }),
      audit({ category: "gate", phase: "gate_review", action: "G1: approved — continuing", result: "ok" }),
      audit({ category: "gate", phase: "validate_sources", action: "gate ok (vivado-batch-1)", result: "ok" }),
      audit({ category: "tool_call", phase: "validate_sources", action: "validate_sources succeeded", result: "ok", jobId: "job-1", inputSha256: "b".repeat(64) }),
      audit({ category: "model", phase: "repair", action: "repair round 1 applied", result: "ok" }),
      audit({ category: "tool_call", phase: "synthesize", action: "synthesize succeeded", result: "ok", jobId: "job-2" }),
      audit({ category: "tool_call", phase: "implement", action: "implement succeeded", result: "ok", jobId: "job-3" }),
      audit({ category: "loop", phase: "loop", action: "loop succeeded", result: "ok" }),
    ];
    const sentences = stream.map(narrateAuditEvent).filter((s): s is string => s !== null);
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(/[一-鿿]/.test(sentence), `叙述应含中文：${sentence}`).toBe(true);
      expect(sentence.endsWith("。") || sentence.endsWith("✅"), `叙述应为完整句子：${sentence}`).toBe(true);
      expectClean(sentence, "对话叙述");
    }
  });
});

describe("失败原因人话化（§6.6）", () => {
  test("门禁驳回/撤回 → 中文句；技术原文不泄漏", () => {
    expect(humanizeReason("gate G2 was rejected — stopping (fail-closed)")).toBe("「行为审查」被驳回，任务已安全停止。");
    expect(humanizeReason("gate G3 was withdrawn — stopping (fail-closed)")).toBe("「设计审查」已撤回，任务已安全停止。");
    const generic = humanizeReason("connector submit for simulate failed: CONNECTOR_ERROR");
    expect(generic).toBe("任务遇到问题，已安全停止；技术原因见运行记录。");
    expect(generic).not.toContain("CONNECTOR_ERROR");
    expect(humanizeReason(null)).toBe("任务未成功完成，已安全停止。");
    for (const text of [
      humanizeReason("gate G1 was rejected"),
      humanizeReason("implement ended in non-success state timeout (vivado-batch-1)"),
      humanizeReason(undefined),
    ]) {
      expectClean(text, "humanizeReason");
    }
  });
});

describe("事件流人话叙述（§4.3）", () => {
  function evt(eventType: string, payload: unknown): OutboxEvent {
    return {
      event_id: "e1", aggregate_type: "x", aggregate_id: "y", sequence: 1,
      event_type: eventType, payload, correlation_id: "c", classification: "D1",
      occurred_at: "2026-08-13T00:00:00Z",
    };
  }

  test("已知事件类型 → 完整中文句", () => {
    expect(eventNarration(evt("gate.submission_created", { gate: "G3" }))).toBe("「设计审查」的审查提交已创建。");
    expect(eventNarration(evt("gate.approved", { gate: "G1", baselineId: "b" }))).toBe("「需求审查」已通过。");
    expect(eventNarration(evt("gate_submission.submitted_for_review", {}))).toBe("审查已提交，等待批准。");
    expect(eventNarration(evt("revision.created", { artifactId: "a" }))).toBe("产物文档有新版本（候选）。");
    expect(eventNarration(evt("task.forwarded", { runId: "run-1" }))).toBe("新任务已下发执行。");
  });

  test("全部已知类型 + 未知类型通过禁止词检查", () => {
    const types = [
      "project.created", "process.created", "revision.created", "snapshot.created",
      "gate.submission_created", "gate_submission.submitted_for_review", "gate.approved",
      "gate_submission.rejected", "gate_submission.withdrawn", "task.forwarded",
      "tool_run.submitted", "trace.created", "role.assigned", "something.unknown",
    ];
    for (const type of types) {
      const text = eventNarration(evt(type, { gate: "G4" }));
      expect(/[一-鿿]/.test(text)).toBe(true);
      expectClean(text, `eventNarration(${type})`);
    }
  });
});

describe("产物中文分组（§4.6）", () => {
  test("常见类型归入中文组，未知类型归「其他」且不显示英文枚举", () => {
    expect(artifactGroupName("DEVELOPMENT_REQUIREMENTS")).toBe("需求");
    expect(artifactGroupName("DETAILED_DESIGN")).toBe("行为");
    expect(artifactGroupName("ARCHITECTURE_DESIGN")).toBe("架构");
    expect(artifactGroupName("RTL_SOURCE_SET")).toBe("RTL");
    expect(artifactGroupName("XDC_CANDIDATE")).toBe("约束");
    expect(artifactGroupName("BITSTREAM_PACKAGE")).toBe("其他");
    for (const group of ARTIFACT_GROUP_ORDER) {
      if (group !== "RTL") expect(/[一-鿿]/.test(group)).toBe(true);
      expectClean(group, `ARTIFACT_GROUP.${group}`);
    }
  });
});
