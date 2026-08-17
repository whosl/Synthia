import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOOL_BAR_TITLES,
  formatDuration,
} from "../src/domain/tasks.ts";
import { auditToParts, type SynthiaPart } from "../src/domain/parts.ts";
import { BASELINE_NAMES, BASELINE_KINDS } from "../src/domain/gates.ts";
import {
  ARTIFACT_DOC_NAMES,
  artifactDocName,
  artifactGroupName,
  phaseDocName,
} from "../src/domain/artifacts.ts";
import type { TaskAuditEvent, TaskDocRef, TaskRunDetail } from "../src/api/types.ts";

// ─── 测试夹具 ─────────────────────────────────────────────────────────

let seq = 0;
function audit(partial: Partial<TaskAuditEvent> & Pick<TaskAuditEvent, "category" | "phase" | "action">, ts?: string): TaskAuditEvent {
  seq += 1;
  return { ts: ts ?? `2026-08-13T00:00:${String(seq).padStart(2, "0")}Z`, seq, ...partial };
}

function makeDetail(overrides: Partial<TaskRunDetail>): TaskRunDetail {
  seq = 0;
  return {
    run_id: "run-1",
    project_id: "proj-1",
    status: "running",
    current_stage: null,
    awaiting_gate: null,
    created_at: "2026-08-13T00:00:00Z",
    task: "设计一个计数器",
    docs: [],
    audit: [],
    evidence: [],
    ...overrides,
  };
}

function kinds(parts: readonly SynthiaPart[]): string[] {
  return parts.map((p) => (p.kind === "text" ? `text:${p.role}` : p.kind));
}

// ─── §5.2 GJB 文档名 ──────────────────────────────────────────────────

describe("产物 GJB 正式文档名（v2 §3）", () => {
  test("映射表完整且与规格一致", () => {
    expect(ARTIFACT_DOC_NAMES.DEVELOPMENT_REQUIREMENTS).toBe("研制（开发）技术要求");
    expect(ARTIFACT_DOC_NAMES.SYSTEM_REQUIREMENTS).toBe("系统需求规格说明");
    expect(ARTIFACT_DOC_NAMES.PLDS_SRS).toBe("PLDS 需求规格说明");
    expect(ARTIFACT_DOC_NAMES.ARCHITECTURE_DESIGN).toBe("PLDS 结构设计说明");
    expect(ARTIFACT_DOC_NAMES.DETAILED_DESIGN).toBe("PLDS 详细设计说明");
    expect(ARTIFACT_DOC_NAMES.CONSTRAINT_DESIGN).toBe("PLDS 接口与约束设计说明（草案）");
    expect(ARTIFACT_DOC_NAMES.XDC_CANDIDATE).toBe("PLDS 接口与约束设计说明（草案）");
    expect(ARTIFACT_DOC_NAMES.RTL_SOURCE_SET).toBe("PLDS 源代码（RTL）");
    expect(ARTIFACT_DOC_NAMES.TB_SOURCE_SET).toBe("PLDS 验证环境源代码");
    expect(ARTIFACT_DOC_NAMES.SYNTH_RESULT).toBe("综合报告");
    expect(ARTIFACT_DOC_NAMES.IMPLEMENT_RESULT).toBe("布局布线（实现）报告");
    expect(ARTIFACT_DOC_NAMES.DRC_REPORT).toBe("设计规则检查（DRC）报告");
    expect(ARTIFACT_DOC_NAMES.STA_REPORT).toBe("静态时序分析报告");
    expect(ARTIFACT_DOC_NAMES.POWER_REPORT).toBe("功耗分析报告");
    expect(ARTIFACT_DOC_NAMES.BITSTREAM_PACKAGE).toBe("PLDS 码流（固化）包");
  });

  test("未映射类型显示「工程文档」，不显示英文枚举", () => {
    expect(artifactDocName("WAIVER")).toBe("工程文档");
    expect(artifactDocName("SOMETHING_NEW")).toBe("工程文档");
    expect(artifactGroupName("WAIVER")).toBe("其他");
  });

  test("工作台 phase → GJB 文档名", () => {
    expect(phaseDocName("intake")).toBe("研制（开发）技术要求");
    expect(phaseDocName("architecture")).toBe("PLDS 结构设计说明");
    expect(phaseDocName("rtl_build")).toBe("PLDS 源代码（RTL）");
    expect(phaseDocName("unknown_phase")).toBe("工程文档");
  });
});

// ─── §5.1 基线 → 里程碑 ────────────────────────────────────────────────

describe("「基线」改名「里程碑」（v2 §2）", () => {
  test("B0~B4 中文映射为里程碑", () => {
    expect(BASELINE_NAMES.B0).toBe("需求里程碑");
    expect(BASELINE_NAMES.B1).toBe("设计里程碑");
    expect(BASELINE_NAMES.B2).toBe("RTL里程碑");
    expect(BASELINE_NAMES.B3).toBe("实现里程碑");
    expect(BASELINE_NAMES.B4).toBe("发布里程碑");
    for (const kind of BASELINE_KINDS) {
      expect(BASELINE_NAMES[kind]).toContain("里程碑");
    }
  });

  test("渲染模板层「基线」出现 0 次", () => {
    const viewsDir = join(import.meta.dir, "../src/views");
    const componentsDir = join(import.meta.dir, "../src/components");
    const files = [
      ...readdirSync(viewsDir).map((f) => join(viewsDir, f)),
      ...readdirSync(componentsDir).map((f) => join(componentsDir, f)),
    ].filter((f) => f.endsWith(".vue"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? "";
      expect(template.includes("基线"), `${file} 模板层仍含「基线」`).toBe(false);
    }
  });
});

// ─── §5.3 turn 式对话流（v3：web/src/domain/parts.ts auditToParts）────────

describe("对话流 part 映射（v3）", () => {
  test("完整流：叙述/产物卡/门禁卡/工具条/终态/证据按时间序", () => {
    const doc: TaskDocRef = { phase: "intake", path: "docs/intake.md", artifact_id: "a1", revision_id: "r1" };
    const detail = makeDetail({
      status: "succeeded",
      current_stage: "implement",
      docs: [doc],
      audit: [
        audit({ category: "model", phase: "generate_intake", action: "intake doc generated: docs/intake.md", result: "ok" }, "2026-08-13T00:00:01Z"),
        audit({ category: "governance", phase: "governance", action: "registered intake artifact: r1", result: "ok", detail: "type=DEVELOPMENT_REQUIREMENTS path=docs/intake.md" }, "2026-08-13T00:00:02Z"),
        audit({ category: "gate", phase: "gate_review", action: "G1: submitting for review", result: "ok" }, "2026-08-13T00:00:03Z"),
        audit({ category: "gate", phase: "gate_review", action: "G1: approved — continuing", result: "ok" }, "2026-08-13T00:00:04Z"),
        audit({ category: "gate", phase: "synthesize", action: "gate ok (vivado-batch-1)", result: "ok" }, "2026-08-13T00:00:05Z"),
        audit({ category: "tool_call", phase: "synthesize", action: "synthesize succeeded", result: "ok", jobId: "job-1", inputSha256: "a".repeat(64) }, "2026-08-13T00:00:17Z"),
        audit({ category: "loop", phase: "loop", action: "loop succeeded", result: "ok" }, "2026-08-13T00:00:18Z"),
      ],
      evidence: [{ jobId: "job-1", operation: "synthesize", status: "succeeded", inputSha256: "a".repeat(64), entries: [{ name: "synth.rpt", sha256: "b".repeat(64), sizeBytes: 1024, mediaType: "text/plain" }] }],
    });
    const parts = auditToParts(detail);
    expect(kinds(parts)).toEqual(["text:user", "text:agent", "doc", "gate", "tool", "lifecycle", "evidence"]);
    const gate = parts.find((p) => p.kind === "gate");
    expect(gate && gate.kind === "gate" ? gate.state : null).toBe("passed"); // 同一门只留一个 part，取最新状态
    expect(gate && gate.kind === "gate" ? gate.review : null).toBe("需求审查");

    const tool = parts.find((p) => p.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.status : null).toBe("completed");
    expect(tool && tool.kind === "tool" ? tool.durationMs : null).toBe(12_000); // 权限门→完成的时间差
    expect(tool && tool.kind === "tool" ? tool.title : null).toBe("综合");

    const terminal = parts.find((p) => p.kind === "lifecycle");
    expect(terminal && terminal.kind === "lifecycle" ? terminal.state : null).toBe("succeeded");

    const evidence = parts.find((p) => p.kind === "evidence");
    expect(evidence && evidence.kind === "evidence" ? evidence.count : null).toBe(1);
  });

  test("lifecycle 事件一律不进对话流（§5.5）", () => {
    const detail = makeDetail({
      audit: [
        audit({ category: "lifecycle", phase: "loop", action: "connector heartbeat", result: "ok" }),
        audit({ category: "lifecycle", phase: "loop", action: "reconnect attempt 1" }),
        audit({ category: "model", phase: "generate_rtl", action: "rtl generated", result: "ok" }),
      ],
    });
    const parts = auditToParts(detail);
    // 首轮指令气泡 + 一条叙述（lifecycle 不进流）
    expect(kinds(parts)).toEqual(["text:user", "text:agent"]);
  });

  test("权限门转为工具启动；轮询技术事件隐藏；等待批准 → 流内 awaiting 标记", () => {
    const detail = makeDetail({
      status: "awaiting_approval",
      current_stage: "validate",
      awaiting_gate: "G2",
      audit: [
        audit({ category: "gate", phase: "validate_sources", action: "gate ok (vivado-batch-1)", result: "ok" }),
        audit({ category: "tool_call", phase: "validate_sources", action: "validate_sources succeeded", result: "ok" }),
        audit({ category: "gate", phase: "gate_review", action: "G2: submitting for review", result: "ok" }),
        audit({ category: "gate", phase: "gate_review", action: "G2: polling approval status", result: "ok" }),
        audit({ category: "gate", phase: "gate_review", action: "G2: awaiting human approval", result: "ok" }),
        audit({ category: "loop", phase: "loop", action: "loop paused at G2", result: "ok" }),
      ],
    });
    const parts = auditToParts(detail);
    const gate = parts.find((p) => p.kind === "gate")!;
    expect(gate.kind === "gate" && gate.state).toBe("awaiting");
    expect(gate.kind === "gate" && gate.review).toBe("行为审查");
  });

  test("工具失败 → error 可展开（人话原因）；不泄漏 jobId/错误码", () => {
    const detail = makeDetail({
      status: "fail_closed",
      current_stage: "simulate",
      audit: [
        audit({ category: "tool_call", phase: "simulate", action: "simulate fail-closed", result: "fail_closed", errorCode: "SIM_ASSERT", jobId: "job-7" }),
        audit({ category: "loop", phase: "loop", action: "loop fail_closed", result: "fail_closed", detail: "simulate returned fail-closed status failed" }),
      ],
      reason: "simulate returned fail-closed status failed",
    });
    const parts = auditToParts(detail);
    const tool = parts.find((p) => p.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.status : null).toBe("error");
    const reason = tool && tool.kind === "tool" ? tool.errorText : null;
    expect(reason).toBeTruthy();
    expect(reason).not.toContain("SIM_ASSERT");
    expect(reason).not.toContain("job-7");
    const terminal = parts.find((p) => p.kind === "lifecycle");
    expect(terminal && terminal.kind === "lifecycle" ? terminal.state : null).toBe("failed");
  });

  test("连续重复叙述合并；无登记事件的产物补产物卡到流尾", () => {
    const doc: TaskDocRef = { phase: "architecture", path: "docs/arch.md", artifact_id: "a2", revision_id: "r2" };
    const detail = makeDetail({
      docs: [doc],
      audit: [
        audit({ category: "model", phase: "generate_intake", action: "intake doc generated: a", result: "ok" }),
        audit({ category: "model", phase: "generate_intake", action: "intake doc generated: b", result: "ok" }),
        audit({ category: "model", phase: "generate_intake", action: "intake doc generated: c", result: "ok" }),
      ],
    });
    const parts = auditToParts(detail);
    expect(parts.filter((p) => p.kind === "text" && p.role === "agent").length).toBe(1); // 三句相同 → 合并一段
    expect(parts.filter((p) => p.kind === "text").length).toBe(2); // 首轮指令 + 合并后的叙述
    const file = parts[parts.length - 1]!;
    expect(file.kind).toBe("doc");
    expect(file.kind === "doc" ? file.title : null).toBe("PLDS 结构设计说明");
  });

  test("工具条标题映射与耗时格式化", () => {
    expect(TOOL_BAR_TITLES.validate_sources).toBe("编译检查");
    expect(TOOL_BAR_TITLES.simulate).toBe("仿真");
    expect(TOOL_BAR_TITLES.synthesize).toBe("综合");
    expect(TOOL_BAR_TITLES.implement).toBe("实现并生成码流");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(800)).toBe("800ms");
    expect(formatDuration(75_000)).toBe("1m15s");
  });
});
