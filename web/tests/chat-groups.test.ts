/**
 * 对话流展示层推导单测（domain/chat-groups.ts）：
 * - groupToolActivity：极大连续工具条目段的显示层折叠（顺序不变、组 key 稳定）；
 * - summarizeToolGroup：状态优先级 error > 进行中 > 完成、耗时求和；
 * - formatRelativeTime：回合分隔线的相对时间。
 */
import { describe, expect, test } from "bun:test";
import {
  formatRelativeTime,
  groupToolActivity,
  summarizeToolGroup,
  type ChatFeedRow,
  type ToolActivityItem,
} from "../src/domain/chat-groups.ts";
import type { ChatRenderItem } from "../src/domain/composer.ts";
import type { SynthiaAgentToolPart, SynthiaTextPart, SynthiaToolPart } from "../src/domain/parts.ts";

// ─── 夹具 ─────────────────────────────────────────────────────────────

function tool(
  id: string,
  status: SynthiaToolPart["status"],
  durationMs: number | null = null,
): ToolActivityItem {
  return {
    part: {
      kind: "tool",
      id,
      op: "simulate",
      title: "仿真",
      status,
      time: { start: null, end: null },
      durationMs,
      errorText: status === "error" ? "仿真未通过。" : null,
      jobId: null,
      errorCode: null,
    },
    steer: false,
  };
}

function agentTool(id: string, state: SynthiaAgentToolPart["state"]): ToolActivityItem {
  return { part: { kind: "agent_tool", id, state, name: "read_file", args: "{}", result: null }, steer: false };
}

function textItem(id: string, role: SynthiaTextPart["role"]): ChatRenderItem {
  return { part: { kind: "text", id, role, state: "done", text: "…", segments: null }, steer: false };
}

function rowIds(rows: readonly ChatFeedRow[]): string[] {
  return rows.map((row) => row.id);
}

function groupOf(row: ChatFeedRow): ToolActivityItem[] {
  if (row.kind !== "tool-group") throw new Error("expected a tool-group row");
  return [...row.group.items];
}

// ─── groupToolActivity ───────────────────────────────────────────────

describe("groupToolActivity：工具活动显示层折叠", () => {
  test("无工具条目 → 全部原样出行，顺序与 id 不变", () => {
    const items = [textItem("u1", "user"), textItem("a1", "agent")];
    const rows = groupToolActivity(items);
    expect(rows.every((row) => row.kind === "item")).toBe(true);
    expect(rowIds(rows)).toEqual(["u1", "a1"]);
  });

  test("连续 ≥2 条工具折叠成组：组 id = 首条目 id，组内顺序保持", () => {
    const rows = groupToolActivity([
      textItem("u1", "user"),
      tool("t1", "completed"),
      tool("t2", "completed"),
      agentTool("c1", "done"),
      textItem("a1", "agent"),
    ]);
    expect(rowIds(rows)).toEqual(["u1", "t1", "a1"]);
    const group = rows[1]!;
    expect(group.kind).toBe("tool-group");
    expect(groupOf(group).map((item) => item.part.id)).toEqual(["t1", "t2", "c1"]);
  });

  test("单条工具不成组，原样渲染（不套组壳）", () => {
    const rows = groupToolActivity([textItem("u1", "user"), tool("t1", "running"), textItem("a1", "agent")]);
    expect(rows.every((row) => row.kind === "item")).toBe(true);
    expect(rowIds(rows)).toEqual(["u1", "t1", "a1"]);
  });

  test("极大连续段：被文本打断的两段工具各自成组，不跨段合并", () => {
    const rows = groupToolActivity([
      tool("t1", "completed"),
      tool("t2", "completed"),
      textItem("a1", "agent"),
      tool("t3", "error"),
      agentTool("c1", "done"),
    ]);
    expect(rowIds(rows)).toEqual(["t1", "a1", "t3"]);
    expect(rows[0]!.kind).toBe("tool-group");
    expect(rows[2]!.kind).toBe("tool-group");
    expect(groupOf(rows[0]!).map((item) => item.part.id)).toEqual(["t1", "t2"]);
    expect(groupOf(rows[2]!).map((item) => item.part.id)).toEqual(["t3", "c1"]);
  });

  test("流式增量：向同组末尾追加工具条目，组 id 保持首条目 id（:key 复用契约）", () => {
    const before = groupToolActivity([tool("t1", "running"), tool("t2", "pending")]);
    const after = groupToolActivity([tool("t1", "running"), tool("t2", "pending"), tool("t3", "pending")]);
    expect(before[0]!.id).toBe("t1");
    expect(after[0]!.id).toBe("t1");
    expect(after[0]!.kind === "tool-group" && after[0]!.group.total).toBe(3);
  });

  test("空输入 → 空输出", () => {
    expect(groupToolActivity([])).toEqual([]);
  });
});

// ─── summarizeToolGroup ──────────────────────────────────────────────

describe("summarizeToolGroup：组摘要", () => {
  test("全部终态（completed/done）→ active=false，默认收起", () => {
    const g = summarizeToolGroup("t1", [tool("t1", "completed"), agentTool("c1", "done")]);
    expect(g.active).toBe(false);
    expect(g.errors).toBe(0);
  });

  test("任一 pending/running → active=true（进行中的工作默认展开）", () => {
    const g = summarizeToolGroup("t1", [tool("t1", "completed"), tool("t2", "running")]);
    expect(g.active).toBe(true);
  });

  test("tool error 与 agent_tool error 都计入失败数", () => {
    const g = summarizeToolGroup("t1", [tool("t1", "error"), agentTool("c1", "error"), tool("t2", "completed")]);
    expect(g.errors).toBe(2);
    expect(g.total).toBe(3);
  });

  test("耗时求和只统计带 durationMs 的条目；全缺 → null", () => {
    const withSome = summarizeToolGroup("t1", [tool("t1", "completed", 61_000), agentTool("c1", "done"), tool("t2", "completed", 7_000)]);
    expect(withSome.durationMs).toBe(68_000);
    const none = summarizeToolGroup("t1", [agentTool("c1", "done"), agentTool("c2", "done")]);
    expect(none.durationMs).toBeNull();
  });
});

// ─── formatRelativeTime ──────────────────────────────────────────────

describe("formatRelativeTime：回合分隔线相对时间", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");

  test("1 分钟内 → 「刚刚」；之后按分钟/小时/天取整", () => {
    expect(formatRelativeTime("2026-09-11T11:59:30Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-09-11T11:48:00Z", now)).toBe("12 分钟前");
    expect(formatRelativeTime("2026-09-11T09:00:00Z", now)).toBe("3 小时前");
    expect(formatRelativeTime("2026-09-09T12:00:00Z", now)).toBe("2 天前");
  });

  test("边界：恰好 60 秒进分钟档，恰好 60 分钟进小时档", () => {
    expect(formatRelativeTime("2026-09-11T11:59:00Z", now)).toBe("1 分钟前");
    expect(formatRelativeTime("2026-09-11T11:00:00Z", now)).toBe("1 小时前");
  });

  test("无法解析或未来时间（时钟漂移）→ null，退化为纯分隔线", () => {
    expect(formatRelativeTime("not-a-date", now)).toBeNull();
    expect(formatRelativeTime("2026-09-11T12:00:01Z", now)).toBeNull();
  });
});
