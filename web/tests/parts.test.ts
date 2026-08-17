/**
 * v3 对话流数据层测试（Contract 数据层 + spec §3）：
 * - 工具事件 pending→running→completed/error 四态转移（含耗时）；
 * - 多工具乱序（part 位置固定、按操作各自 upsert）与同操作多轮 FIFO 配对；
 * - 文本流式拼接（连续叙述并入同一 part；流尾 + running → streaming）；
 * - 打断标记插入（free_agent_abort → interrupt 卡）；
 * - 门禁卡 upsert、产物卡、证据摘要、终态卡（成功附码流证据）、排队/错误提示卡。
 */
import { describe, expect, test } from "bun:test";
import {
  TOOL_STATUS_TEXT,
  auditToParts,
  bitstreamFromEvidence,
  toolDurationLabel,
  type SynthiaLifecyclePart,
  type SynthiaPart,
  type SynthiaTextPart,
  type SynthiaToolPart,
} from "../src/domain/parts.ts";
import type { TaskAuditEvent, TaskRunDetail } from "../src/api/types.ts";

// ─── 夹具 ────────────────────────────────────────────────────────────

let seq = 0;
function audit(partial: Partial<TaskAuditEvent> & Pick<TaskAuditEvent, "category" | "phase" | "action">, ts?: string): TaskAuditEvent {
  seq += 1;
  return { ts: ts ?? `2026-08-17T10:00:${String(seq).padStart(2, "0")}Z`, seq, ...partial };
}

function makeDetail(overrides: Partial<TaskRunDetail>): TaskRunDetail {
  seq = 0;
  return {
    run_id: "run-test",
    project_id: "proj-1",
    status: "running",
    current_stage: null,
    awaiting_gate: null,
    created_at: "2026-08-17T10:00:00Z",
    docs: [],
    audit: [],
    evidence: [],
    ...overrides,
  };
}

function toolParts(parts: readonly SynthiaPart[]): SynthiaToolPart[] {
  return parts.filter((p): p is SynthiaToolPart => p.kind === "tool");
}

function textParts(parts: readonly SynthiaPart[]): SynthiaTextPart[] {
  return parts.filter((p): p is SynthiaTextPart => p.kind === "text");
}

/** 权限门事件（工具启动，runtime loop.ts "gate ok (vivado-batch-1)"）。 */
const permGate = (op: string, ts?: string) =>
  audit({ category: "gate", phase: op, action: "gate ok (vivado-batch-1)", result: "ok" }, ts);

/** 工具完成事件（runtime loop.ts "<op> succeeded"）。 */
const toolDone = (op: string, ts?: string) =>
  audit({ category: "tool_call", phase: op, action: `${op} succeeded`, result: "ok" }, ts);

// ─── 工具四态：pending→running→completed 转移 ─────────────────────────

describe("auditToParts：工具四态转移", () => {
  test("current_stage 推导 pending 工具条（阶段一翻即现，先于权限门事件）", () => {
    const parts = auditToParts(makeDetail({ status: "running", current_stage: "synthesize" }));
    const tools = toolParts(parts);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ op: "synthesize", title: "综合", status: "pending", time: { start: null, end: null }, durationMs: null });
  });

  test("权限门事件：pending → running（time.start 记录）", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        current_stage: "synthesize",
        audit: [permGate("synthesize", "2026-08-17T10:00:05Z")],
      }),
    );
    const tools = toolParts(parts);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe("running");
    expect(tools[0]!.time.start).toBe("2026-08-17T10:00:05Z");
    // 轮次 id 与 live 推断一致（跨轮询稳定，Vue :key 复用）
    expect(tools[0]!.id).toBe("tool-synthesize-0");
  });

  test("完成事件：running → completed（time.end + 耗时），completed 弱化不重开", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        current_stage: "implement",
        audit: [
          permGate("implement", "2026-08-17T10:00:10Z"),
          toolDone("implement", "2026-08-17T10:02:10Z"),
        ],
      }),
    );
    const tools = toolParts(parts);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe("completed");
    expect(tools[0]!.time).toEqual({ start: "2026-08-17T10:00:10Z", end: "2026-08-17T10:02:10Z" });
    expect(tools[0]!.durationMs).toBe(120_000);
    expect(tools[0]!.errorText).toBeNull();
  });

  test("失败事件：running → error（人话 errorText，可展开）", () => {
    const parts = auditToParts(
      makeDetail({
        status: "fail_closed",
        current_stage: "simulate",
        audit: [
          permGate("simulate", "2026-08-17T10:00:10Z"),
          audit({ category: "tool_call", phase: "simulate", action: "simulate fail-closed", result: "fail_closed", errorCode: "X" }),
        ],
      }),
    );
    const tools = toolParts(parts);
    expect(tools[0]!.status).toBe("error");
    expect(tools[0]!.errorText).toBe("仿真未能完成，任务已安全停止。技术详情见运行记录。");
    expect(tools[0]!.errorText).not.toMatch(/X/); // 错误码不进对话流（L3）
  });

  test("无权限门事件的完成事件 → 直接 completed part（容错）", () => {
    const parts = auditToParts(makeDetail({ status: "running", audit: [toolDone("validate_sources")] }));
    const tools = toolParts(parts);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ op: "validate_sources", status: "completed", title: "编译检查" });
    expect(tools[0]!.time.start).toBeNull();
  });

  test("四态文案齐备且为中文", () => {
    expect(TOOL_STATUS_TEXT).toEqual({ pending: "准备中", running: "运行中", completed: "完成", error: "未通过" });
  });

  test("耗时展示：<2s 不显示（弱化），≥2s 格式化", () => {
    expect(toolDurationLabel(null)).toBeNull();
    expect(toolDurationLabel(1500)).toBeNull();
    expect(toolDurationLabel(2000)).toBe("2s");
    expect(toolDurationLabel(125_000)).toBe("2m5s");
  });
});

// ─── 多工具乱序 ──────────────────────────────────────────────────────

describe("auditToParts：多工具乱序 upsert", () => {
  test("两工具交错：part 位置按首次出现固定，完成顺序不影响排列", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        audit: [
          permGate("simulate", "2026-08-17T10:00:00Z"),
          permGate("synthesize", "2026-08-17T10:01:00Z"),
          toolDone("synthesize", "2026-08-17T10:03:00Z"),
          toolDone("simulate", "2026-08-17T10:04:00Z"),
        ],
      }),
    );
    const tools = toolParts(parts);
    expect(tools.map((t) => t.op)).toEqual(["simulate", "synthesize"]);
    expect(tools.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(tools[0]!.durationMs).toBe(240_000); // 10:00:00 → 10:04:00
    expect(tools[1]!.durationMs).toBe(120_000); // 10:01:00 → 10:03:00
    expect(new Set(tools.map((t) => t.id)).size).toBe(2);
  });

  test("同操作多轮（仿真修复循环）：FIFO 配对，每轮独立 part", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        current_stage: "simulate",
        audit: [
          permGate("simulate", "2026-08-17T10:00:00Z"),
          audit({ category: "tool_call", phase: "simulate", action: "simulate failed", result: "failed" }, "2026-08-17T10:01:00Z"),
          audit({ category: "model", phase: "repair", action: "repair round 1 applied", result: "ok" }, "2026-08-17T10:01:30Z"),
          permGate("simulate", "2026-08-17T10:02:00Z"),
          toolDone("simulate", "2026-08-17T10:03:00Z"),
        ],
      }),
    );
    const tools = toolParts(parts);
    expect(tools.map((t) => t.status)).toEqual(["error", "completed"]);
    expect(tools[0]!.id).not.toBe(tools[1]!.id);
    // 第二轮 running part 被完成事件关闭；current_stage 推断不再新开 pending
    expect(tools).toHaveLength(2);
    // 修复叙述出现在两轮工具之间
    const texts = textParts(parts).map((t) => t.text);
    expect(texts).toContain("仿真发现问题，正在修复（第 1 次尝试）。");
  });
});

// ─── 文本流式拼接 ────────────────────────────────────────────────────

describe("auditToParts：文本流式拼接", () => {
  test("连续叙述事件并入同一 part；流尾 + running → streaming", () => {
    const detail = makeDetail({
      status: "running",
      audit: [
        audit({ category: "model", phase: "generate_intake", action: "intake doc generated: docs/intake.md", result: "ok" }),
        audit({ category: "model", phase: "generate_behavior_wave", action: "behavior/wave doc generated: docs/b.md", result: "ok" }),
      ],
    });
    const parts = auditToParts(detail);
    const texts = textParts(parts);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.role).toBe("agent");
    expect(texts[0]!.state).toBe("streaming");
    expect(texts[0]!.text).toBe("我已读完需求，整理出需求规格草案。\n\n行为与波形设计文档已整理完成。");
  });

  test("非文本 part 插入后，后续叙述开新 part（前段转 done）", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        audit: [
          audit({ category: "model", phase: "generate_intake", action: "intake doc generated: docs/intake.md", result: "ok" }),
          permGate("validate_sources"),
          toolDone("validate_sources"),
          audit({ category: "model", phase: "generate_rtl", action: "rtl generated", result: "ok" }),
        ],
      }),
    );
    const texts = textParts(parts);
    expect(texts).toHaveLength(2);
    expect(texts[0]!.text).toBe("我已读完需求，整理出需求规格草案。");
    expect(texts[0]!.state).toBe("done");
    expect(texts[1]!.text).toBe("RTL 代码已生成。");
  });

  test("终态后流尾文本为 done", () => {
    const parts = auditToParts(
      makeDetail({
        status: "succeeded",
        audit: [
          audit({ category: "model", phase: "generate_rtl", action: "rtl generated", result: "ok" }),
          audit({ category: "loop", phase: "loop", action: "loop succeeded", result: "ok" }),
        ],
      }),
    );
    const texts = textParts(parts);
    expect(texts.at(-1)!.state).toBe("done");
  });

  test("连续重复句降噪合并（同句不重复追加）", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        audit: [
          audit({ category: "model", phase: "generate_intake", action: "intake doc generated: a.md", result: "ok" }),
          audit({ category: "model", phase: "generate_intake", action: "intake doc generated: a.md", result: "ok" }),
        ],
      }),
    );
    expect(textParts(parts)).toHaveLength(1);
    expect(textParts(parts)[0]!.text).toBe("我已读完需求，整理出需求规格草案。");
  });

  test("free_agent_reply 带长代码块 → segments 折叠（>15 行代码卡）", () => {
    const code = Array.from({ length: 20 }, (_, i) => `assign w${i} = ${i};`).join("\n");
    const parts = auditToParts(
      makeDetail({
        status: "running",
        audit: [
          { ...audit({ category: "model", phase: "loop", action: "free_agent_reply" }), detail: `说明如下：\n\`\`\`verilog\n${code}\n\`\`\`` },
        ],
      }),
    );
    const segs = textParts(parts)[0]!.segments!;
    expect(segs.some((s) => s.kind === "code" && s.collapsible && s.lineCount === 20)).toBe(true);
  });
});

// ─── 用户气泡 / 打断 / 排队提示 ───────────────────────────────────────

describe("auditToParts：用户气泡、打断标记与提示卡", () => {
  test("首轮指令（detail.task）→ 流首 user 气泡", () => {
    const parts = auditToParts(makeDetail({ task: "设计一个 UART 收发器" }));
    const first = parts[0]!;
    expect(first).toMatchObject({ kind: "text", role: "user", state: "done", text: "设计一个 UART 收发器" });
    expect((first as SynthiaTextPart).segments).toBeNull();
  });

  test("user_message 事件 → user 气泡（右侧）", () => {
    const parts = auditToParts(
      makeDetail({ audit: [{ ...audit({ category: "model", phase: "loop", action: "user_message" }), detail: "改用 115200 波特率" }] }),
    );
    const user = textParts(parts).find((t) => t.role === "user");
    expect(user?.text).toBe("改用 115200 波特率");
  });

  test("free_agent_abort → 打断标记卡（「直接插入」在流内留痕）", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        audit: [
          { ...audit({ category: "model", phase: "loop", action: "free_agent_reply" }), detail: "正在分析需求……" },
          audit({ category: "model", phase: "loop", action: "free_agent_abort" }),
          { ...audit({ category: "model", phase: "loop", action: "user_message" }), detail: "停下，先改需求" },
        ],
      }),
    );
    const interrupt = parts.find((p) => p.kind === "interrupt");
    expect(interrupt).toBeDefined();
    expect(interrupt!.kind === "interrupt" && interrupt.text).toContain("打断");
    // 打断后叙述段关闭，新 user 气泡在其后
    const kinds = parts.map((p) => `${p.kind}:${p.role ?? ""}`);
    expect(kinds.indexOf("interrupt:")).toBeGreaterThan(-1);
    expect(kinds.indexOf("text:user")).toBeGreaterThan(kinds.indexOf("interrupt:"));
  });

  test("free_agent_steer → 排队注入提示卡；reply_error → 错误提示卡", () => {
    const parts = auditToParts(
      makeDetail({
        status: "running",
        audit: [
          { ...audit({ category: "model", phase: "loop", action: "user_message" }), detail: "提高时钟频率" },
          audit({ category: "model", phase: "loop", action: "free_agent_steer" }),
          audit({ category: "model", phase: "loop", action: "free_agent_reply_error", detail: "boom" }),
        ],
      }),
    );
    const notes = parts.filter((p) => p.kind === "note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ tone: "info" });
    expect(notes[0]!.kind === "note" && notes[0].text).toContain("注入");
    expect(notes[1]).toMatchObject({ tone: "error" });
    // 英文错误原文不进对话流
    expect(notes[1]!.kind === "note" && notes[1].text.includes("boom")).toBe(false);
  });
});

// ─── 门禁 / 产物 / 证据 / 终态 ───────────────────────────────────────

describe("auditToParts：门禁卡 upsert 与产物/证据/终态", () => {
  test("同一门多次事件 upsert 原地更新，不重排不重复", () => {
    const parts = auditToParts(
      makeDetail({
        status: "awaiting_approval",
        awaiting_gate: "G2",
        audit: [
          audit({ category: "gate", phase: "gate_review", action: "G2: creating snapshot (2 revisions)", result: "ok" }),
          audit({ category: "gate", phase: "gate_review", action: "G2: submitting for review", result: "ok", detail: "sub-1" }),
          audit({ category: "gate", phase: "gate_review", action: "G2: awaiting human approval", result: "ok" }),
        ],
      }),
    );
    const gates = parts.filter((p) => p.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ gate: "G2", review: "行为审查", state: "awaiting" });
    // 轮询类技术事件不进流
    expect(parts.some((p) => p.kind === "note" && p.text.includes("polling"))).toBe(false);
  });

  test("approved — continuing → passed", () => {
    const parts = auditToParts(
      makeDetail({ status: "running", audit: [audit({ category: "gate", phase: "gate_review", action: "G2: approved — continuing", result: "ok" })] }),
    );
    expect(parts.find((p) => p.kind === "gate")).toMatchObject({ state: "passed" });
  });

  test("governance 登记按修订 id 关联 docs → 产物卡；未关联 → 治理事件卡", () => {
    const detail = makeDetail({
      status: "running",
      docs: [
        { phase: "intake", path: "docs/intake.md", artifact_id: "art-1", revision_id: "rev-1" },
      ],
      audit: [
        audit({ category: "governance", phase: "governance", action: "registered intake artifact: rev-1", result: "ok", detail: "type=DEVELOPMENT_REQUIREMENTS path=docs/intake.md" }),
        audit({ category: "governance", phase: "governance", action: "registered RTL artifact: rev-unknown", result: "ok", detail: "top=uart_top" }),
      ],
    });
    const parts = auditToParts(detail);
    const docParts = parts.filter((p) => p.kind === "doc");
    expect(docParts).toHaveLength(1);
    expect(docParts[0]).toMatchObject({ title: "研制（开发）技术要求" });
    const gov = parts.filter((p) => p.kind === "governance");
    expect(gov).toHaveLength(1);
  });

  test("未关联登记事件的 docs → 流尾产物卡；evidence → 摘要卡", () => {
    const parts = auditToParts(
      makeDetail({
        status: "succeeded",
        docs: [{ phase: "rtl", path: "rtl/uart.v", artifact_id: "art-2", revision_id: "rev-2" }],
        evidence: [{ jobId: "job-1", operation: "simulate", status: "succeeded", inputSha256: "a".repeat(64), entries: [{ name: "sim.log", sha256: "b".repeat(64), sizeBytes: 10, mediaType: "text/plain" }] }],
        audit: [audit({ category: "loop", phase: "loop", action: "loop succeeded", result: "ok" })],
      }),
    );
    expect(parts.some((p) => p.kind === "doc" && p.title === "PLDS 源代码（RTL）")).toBe(true);
    expect(parts.find((p) => p.kind === "evidence")).toMatchObject({ count: 1 });
  });

  test("loop succeeded → 成功卡附码流证据与证据链计数；failed → 人话失败卡", () => {
    const ok = auditToParts(
      makeDetail({
        status: "succeeded",
        evidence: [
          { jobId: "job-1", operation: "implement", status: "succeeded", inputSha256: "a".repeat(64), entries: [{ name: "uart.bitstream.bit", sha256: "c".repeat(64), sizeBytes: 4096, mediaType: "application/octet-stream" }] },
          { jobId: "job-2", operation: "simulate", status: "succeeded", inputSha256: "a".repeat(64), entries: [] },
        ],
        audit: [audit({ category: "loop", phase: "loop", action: "loop succeeded", result: "ok" })],
      }),
    );
    const life = ok.find((p) => p.kind === "lifecycle") as SynthiaLifecyclePart;
    expect(life.state).toBe("succeeded");
    expect(life.bitstream).toMatchObject({ name: "uart.bitstream.bit", sizeBytes: 4096 });
    expect(life.evidenceCount).toBe(2);

    const bad = auditToParts(
      makeDetail({
        status: "fail_closed",
        reason: "gate G2 was rejected — stopping (fail-closed)",
        audit: [audit({ category: "loop", phase: "loop", action: "loop fail_closed", result: "fail_closed" })],
      }),
    );
    const badLife = bad.find((p) => p.kind === "lifecycle") as SynthiaLifecyclePart;
    expect(badLife.state).toBe("failed");
    expect(badLife.text).toBe("「行为审查」被驳回，任务已安全停止。");
  });

  test("lifecycle 心跳/重连类事件不进对话流", () => {
    const parts = auditToParts(
      makeDetail({ status: "running", audit: [audit({ category: "lifecycle", phase: "loop", action: "reconnected" })] }),
    );
    expect(parts).toHaveLength(0);
  });
});

// ─── bitstreamFromEvidence ───────────────────────────────────────────

describe("bitstreamFromEvidence", () => {
  test("取最新 .bit 条目；无 → null", () => {
    const ev = [
      { entries: [{ name: "a.bit", sha256: "1", sizeBytes: 1 }] },
      { entries: [{ name: "b.bit", sha256: "2", sizeBytes: 2 }, { name: "c.log", sha256: "3", sizeBytes: 3 }] },
    ];
    expect(bitstreamFromEvidence(ev)).toEqual({ name: "b.bit", sha256: "2", sizeBytes: 2 });
    expect(bitstreamFromEvidence([{ entries: [] }])).toBeNull();
  });
});
