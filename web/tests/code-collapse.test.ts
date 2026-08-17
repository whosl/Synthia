/**
 * 折叠逻辑测试（Contract 前端部分）：
 * - ``` 围栏代码块超 15 行折叠为代码卡；≤15 行内联（阈值边界）。
 * - 语言/文件名推断（```verilog / ```counter.v / ```verilog counter.v）。
 * - 未围栏长文本同理折叠；展开状态切换（toggleSetKey）。
 * - auditToParts：user_message → 用户气泡、free_agent_reply → 分段回复，按 seq 时序交织。
 *   （v2 buildFeed 已由 v3 web/src/domain/parts.ts 取代）
 */
import { describe, expect, test } from "bun:test";
import {
  CODE_CARD_LINE_THRESHOLD,
  countLines,
  makeTextSegment,
  parseFenceInfo,
  segmentAgentReply,
  toggleSetKey,
  type ReplyCodeSegment,
  type ReplySegment,
} from "../src/domain/reply-segments.ts";
import { auditToParts } from "../src/domain/parts.ts";
import type { TaskAuditEvent, TaskRunDetail } from "../src/api/types.ts";

// ─── 夹具 ────────────────────────────────────────────────────────────

function codeOfLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

function codeSegment(seg: ReplySegment | undefined): ReplyCodeSegment {
  if (!seg || seg.kind !== "code") throw new Error("expected code segment");
  return seg;
}

let seq = 0;
function audit(partial: Partial<TaskAuditEvent> & Pick<TaskAuditEvent, "category" | "phase" | "action">): TaskAuditEvent {
  seq += 1;
  return { ts: `2026-08-14T00:00:${String(seq).padStart(2, "0")}Z`, seq, ...partial };
}

function makeDetail(overrides: Partial<TaskRunDetail>): TaskRunDetail {
  seq = 0;
  return {
    run_id: "run-1",
    project_id: "proj-1",
    status: "idle",
    current_stage: null,
    awaiting_gate: null,
    created_at: "2026-08-14T00:00:00Z",
    task: "首轮指令",
    docs: [],
    audit: [],
    evidence: [],
    ...overrides,
  };
}

// ─── 行数统计 ─────────────────────────────────────────────────────────

describe("countLines", () => {
  test("空串/纯换行为 0；尾部换行不计", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("\n\n")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

// ─── 围栏 info 解析（语言/文件名推断）─────────────────────────────────

describe("parseFenceInfo：语言/文件名推断", () => {
  test("仅语言：```verilog → Verilog，无文件名", () => {
    expect(parseFenceInfo("verilog")).toEqual({ language: "Verilog", filename: null });
  });

  test("仅文件名：```counter.v → 文件名 + 按扩展名推断 Verilog", () => {
    expect(parseFenceInfo("counter.v")).toEqual({ language: "Verilog", filename: "counter.v" });
  });

  test("路径文件名：```src/top/counter.sv → SystemVerilog", () => {
    expect(parseFenceInfo("src/top/counter.sv")).toEqual({ language: "SystemVerilog", filename: "src/top/counter.sv" });
  });

  test("语言 + 文件名：```verilog counter.v → 两者皆有，语言以显式标注为准", () => {
    expect(parseFenceInfo("verilog counter.v")).toEqual({ language: "Verilog", filename: "counter.v" });
  });

  test("未知语言原样保留；空 info 串两者皆 null", () => {
    expect(parseFenceInfo("frobnicate")).toEqual({ language: "frobnicate", filename: null });
    expect(parseFenceInfo("")).toEqual({ language: null, filename: null });
    expect(parseFenceInfo("   ")).toEqual({ language: null, filename: null });
  });

  test("未知扩展名的文件名：保留文件名，语言为 null", () => {
    expect(parseFenceInfo("waveform.wdb")).toEqual({ language: null, filename: "waveform.wdb" });
  });
});

// ─── 回复分段与折叠阈值 ────────────────────────────────────────────────

describe("segmentAgentReply：折叠阈值", () => {
  test(`代码块 ≤ ${CODE_CARD_LINE_THRESHOLD} 行内联（不折叠）`, () => {
    const segs = segmentAgentReply("```verilog\n" + codeOfLines(CODE_CARD_LINE_THRESHOLD) + "\n```");
    const code = codeSegment(segs[0]);
    expect(code.lineCount).toBe(CODE_CARD_LINE_THRESHOLD);
    expect(code.collapsible).toBe(false);
  });

  test(`代码块 ${CODE_CARD_LINE_THRESHOLD + 1} 行 → 折叠为代码卡`, () => {
    const segs = segmentAgentReply("```verilog\n" + codeOfLines(CODE_CARD_LINE_THRESHOLD + 1) + "\n```");
    const code = codeSegment(segs[0]);
    expect(code.lineCount).toBe(CODE_CARD_LINE_THRESHOLD + 1);
    expect(code.collapsible).toBe(true);
    expect(code.code).toContain("line 1");
    expect(code.code).toContain(`line ${CODE_CARD_LINE_THRESHOLD + 1}`);
  });

  test("未围栏长文本同理折叠；短文本不折叠", () => {
    const longSeg = segmentAgentReply(codeOfLines(CODE_CARD_LINE_THRESHOLD + 5))[0]!;
    expect(longSeg.kind).toBe("text");
    expect(longSeg.collapsible).toBe(true);

    const shortSeg = segmentAgentReply("仿真通过，详见报告。")[0]!;
    expect(shortSeg.kind).toBe("text");
    expect(shortSeg.collapsible).toBe(false);
  });

  test("文本/代码按出现顺序分段；连续代码块各自成段；纯空白间隔丢弃", () => {
    const src = "前文\n\n```tcl\nread_xdc a.xdc\n```\n\n中间\n\n```\nputs hi\n```\n\n尾部";
    const segs = segmentAgentReply(src);
    expect(segs.map((s) => s.kind)).toEqual(["text", "code", "text", "code", "text"]);
    expect(segs[0]).toMatchObject({ kind: "text", text: "前文" });
    expect(codeSegment(segs[1]).language).toBe("Tcl");
    expect(codeSegment(segs[3]).language).toBeNull();
    expect(segs[4]).toMatchObject({ kind: "text", text: "尾部" });
  });

  test("未闭合围栏：到文末全部算代码段", () => {
    const segs = segmentAgentReply("说明\n\n```python\nprint(1)\nprint(2)");
    expect(segs.map((s) => s.kind)).toEqual(["text", "code"]);
    expect(codeSegment(segs[1]).code).toBe("print(1)\nprint(2)");
  });

  test("空回复/纯空白 → 无分段", () => {
    expect(segmentAgentReply("")).toEqual([]);
    expect(segmentAgentReply("   \n\n  ")).toEqual([]);
  });

  test("段 id 稳定递增（折叠状态键依赖）", () => {
    const segs = segmentAgentReply("a\n\n```\nx\n```\n\nb");
    expect(segs.map((s) => s.id)).toEqual(["seg-0", "seg-1", "seg-2"]);
  });
});

// ─── 展开状态切换（点击展开交互的核心逻辑）─────────────────────────────

describe("toggleSetKey：展开/收起交互", () => {
  test("默认折叠 → 点击展开 → 再点收起", () => {
    let expanded: ReadonlySet<string> = new Set();
    expect(expanded.has("r3:seg-1")).toBe(false);

    expanded = toggleSetKey(expanded, "r3:seg-1");
    expect(expanded.has("r3:seg-1")).toBe(true);

    expanded = toggleSetKey(expanded, "r3:seg-1");
    expect(expanded.has("r3:seg-1")).toBe(false);
  });

  test("返回新 Set（原集合不变，触发响应式）；多段互不影响", () => {
    const original: ReadonlySet<string> = new Set(["a"]);
    const next = toggleSetKey(original, "b");
    expect(original.has("b")).toBe(false);
    expect([...next].sort()).toEqual(["a", "b"]);
  });
});

// ─── makeTextSegment（工具条展开区长文本复用）──────────────────────────

describe("makeTextSegment：工具结果长文本", () => {
  test("超阈值折叠，短文本不折叠", () => {
    expect(makeTextSegment("x", codeOfLines(30)).collapsible).toBe(true);
    expect(makeTextSegment("x", "仿真未能完成，任务已安全停止。").collapsible).toBe(false);
  });
});

// ─── auditToParts：free-agent 对话进对话流（v3 数据层）────────────────

describe("auditToParts：free-agent 对话 part", () => {
  test("user_message → 用户气泡；free_agent_reply → 分段回复；与工具条按 seq 时序交织", () => {
    const detail = makeDetail({
      audit: [
        audit({ category: "model", phase: "loop", action: "user_message", detail: "帮我生成计数器 RTL" }),
        audit({ category: "model", phase: "generate_rtl", action: "rtl generated", result: "ok" }),
        audit({ category: "model", phase: "loop", action: "free_agent_reply", detail: "RTL 已生成：\n\n```verilog counter.v\nmodule c;\n```" }),
        audit({ category: "tool_call", phase: "simulate", action: "simulate succeeded", result: "ok" }),
        audit({ category: "model", phase: "loop", action: "user_message", detail: "再补一个测试台" }),
        audit({ category: "model", phase: "loop", action: "free_agent_reply", detail: "好的。" }),
      ],
    });
    const parts = auditToParts(detail);
    const kinds = parts.map((p) => (p.kind === "text" ? `text:${p.role}` : p.kind));
    // seq2 叙述与 seq3 回复为相邻 Agent 文本 → 拼接为同一 part（流式拼接）
    expect(kinds).toEqual(["text:user", "text:user", "text:agent", "tool", "text:user", "text:agent"]);

    const reply = parts.find((p) => p.kind === "text" && p.role === "agent" && p.segments?.some((s) => s.kind === "code"));
    const segs = reply?.segments ?? [];
    expect(segs.map((s) => s.kind)).toEqual(["text", "code"]);
    expect(codeSegment(segs[1])).toMatchObject({ filename: "counter.v", language: "Verilog", collapsible: false });
  });

  test("回复中的长代码块 → 折叠代码卡段（刷屏修复验收点；叙述文本不折叠）", () => {
    const detail = makeDetail({
      audit: [
        audit({
          category: "model",
          phase: "loop",
          action: "free_agent_reply",
          detail: "完整 RTL 如下：\n\n```verilog counter.v\n" + codeOfLines(40) + "\n```\n\n以上是全部代码。",
        }),
      ],
    });
    const parts = auditToParts(detail);
    const reply = parts.find((p) => p.kind === "text" && p.role === "agent")!;
    if (reply.kind !== "text") throw new Error("expected text part");
    const code = codeSegment(reply.segments?.find((s) => s.kind === "code"));
    expect(code.collapsible).toBe(true);
    expect(code.lineCount).toBe(40);
    expect(code.filename).toBe("counter.v");
  });

  test("空回复/空白用户消息不进对话流；steer 事件为提示卡而非叙述", () => {
    const detail = makeDetail({
      audit: [
        audit({ category: "model", phase: "loop", action: "user_message", detail: "   " }),
        audit({ category: "model", phase: "loop", action: "free_agent_reply", detail: "" }),
        audit({ category: "model", phase: "loop", action: "free_agent_steer" }),
        audit({ category: "model", phase: "loop", action: "free_agent_reply", detail: "有效回复" }),
      ],
    });
    const parts = auditToParts(detail);
    expect(parts.filter((p) => p.kind === "text" && p.role === "user")).toHaveLength(1); // 仅 detail.task 首轮气泡
    expect(parts.filter((p) => p.kind === "text" && p.role === "agent")).toHaveLength(1); // 仅有效回复；空回复不进流
    expect(parts.some((p) => p.kind === "note")).toBe(true);
  });

  test("part id 唯一（v-for/折叠状态键稳定）", () => {
    const detail = makeDetail({
      audit: [
        audit({ category: "model", phase: "loop", action: "free_agent_reply", detail: "第一条" }),
        audit({ category: "model", phase: "loop", action: "free_agent_reply", detail: "第二条" }),
      ],
    });
    const ids = auditToParts(detail).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
