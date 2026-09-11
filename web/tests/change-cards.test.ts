/**
 * 「本轮改动」汇总卡注入单测（domain/change-cards.ts）：
 * - 轮边界（用户消息）切分与卡位置（轮末、下一条用户消息之前）；
 * - tailOpen（末轮仍在进行）时末段不注卡；
 * - 同版修订去重与字段映射（prevRevisionId 决定 diff/打开语义）。
 */
import { describe, expect, test } from "bun:test";
import { injectChangeCards } from "../src/domain/change-cards.ts";
import type { SynthiaChangesPart, SynthiaDocPart, SynthiaPart, SynthiaTextPart } from "../src/domain/parts.ts";

// ─── 夹具 ─────────────────────────────────────────────────────────────

function user(id: string): SynthiaTextPart {
  return { kind: "text", id, role: "user", state: "done", text: "做这件事", segments: null, ts: null };
}

function agentText(id: string): SynthiaTextPart {
  return { kind: "text", id, role: "agent", state: "done", text: "已完成。", segments: null, ts: null };
}

function doc(id: string, revisionId: string, prevRevisionId: string | null = null): SynthiaDocPart {
  return {
    kind: "doc",
    id,
    doc: { phase: "G2", path: `rtl/${id}.v`, artifact_id: `art-${id}`, revision_id: revisionId },
    title: "RTL 源代码",
    ts: null,
    prevRevisionId,
  };
}

function kinds(parts: readonly SynthiaPart[]): string[] {
  return parts.map((p) => p.kind);
}

function cards(parts: readonly SynthiaPart[]): SynthiaChangesPart[] {
  return parts.filter((p): p is SynthiaChangesPart => p.kind === "changes");
}

// ─── injectChangeCards ───────────────────────────────────────────────

describe("injectChangeCards", () => {
  test("空流与无 doc 的流原样通过", () => {
    expect(injectChangeCards([], { tailOpen: false })).toEqual([]);
    const flow: SynthiaPart[] = [user("u1"), agentText("a1")];
    expect(injectChangeCards(flow, { tailOpen: false })).toEqual(flow);
  });

  test("一轮的 doc 卡归集成一张汇总卡，插在轮末（回复之后、下一条用户消息之前）", () => {
    const flow: SynthiaPart[] = [
      user("u1"),
      doc("d1", "rev-1"),
      doc("d2", "rev-2", "rev-1"),
      agentText("a1"),
      user("u2"),
      agentText("a2"),
    ];
    const out = injectChangeCards(flow, { tailOpen: true });
    expect(kinds(out)).toEqual(["text", "doc", "doc", "text", "changes", "text", "text"]);
    const card = cards(out)[0]!;
    expect(card.items.map((i) => i.revisionId)).toEqual(["rev-1", "rev-2"]);
  });

  test("每个有 doc 的轮各得一张卡", () => {
    const flow: SynthiaPart[] = [
      user("u1"), doc("d1", "rev-1"), agentText("a1"),
      user("u2"), doc("d2", "rev-2"), agentText("a2"),
    ];
    const out = injectChangeCards(flow, { tailOpen: false });
    expect(cards(out)).toHaveLength(2);
    expect(cards(out)[1]!.items.map((i) => i.revisionId)).toEqual(["rev-2"]);
  });

  test("tailOpen=true 时末段不注卡（轮内进行中），已闭合的轮照注", () => {
    const flow: SynthiaPart[] = [
      user("u1"), doc("d1", "rev-1"),
      user("u2"), doc("d2", "rev-2"),
    ];
    const open = injectChangeCards(flow, { tailOpen: true });
    expect(cards(open)).toHaveLength(1);
    expect(cards(open)[0]!.items.map((i) => i.revisionId)).toEqual(["rev-1"]);

    const closed = injectChangeCards(flow, { tailOpen: false });
    expect(cards(closed)).toHaveLength(2);
  });

  test("同一版修订只留一行；字段映射保留 diff 语义", () => {
    const flow: SynthiaPart[] = [
      user("u1"),
      doc("d1", "rev-1", "rev-0"),
      doc("d1dup", "rev-1", "rev-0"),
      doc("d2", "rev-2"),
    ];
    const out = injectChangeCards(flow, { tailOpen: false });
    const card = cards(out)[0]!;
    expect(card.items).toHaveLength(2);
    expect(card.items[0]).toMatchObject({
      artifactId: "art-d1",
      revisionId: "rev-1",
      prevRevisionId: "rev-0",
      path: "rtl/d1.v",
      title: "RTL 源代码",
    });
    expect(card.items[1]!.prevRevisionId).toBeNull();
  });

  test("首条用户消息之前的 doc 也归集（旧数据引导段）", () => {
    const flow: SynthiaPart[] = [doc("d0", "rev-0"), user("u1"), agentText("a1")];
    const out = injectChangeCards(flow, { tailOpen: true });
    expect(kinds(out)).toEqual(["doc", "changes", "text", "text"]);
  });
});
