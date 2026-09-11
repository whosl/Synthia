/**
 * 「本轮改动」汇总卡注入单测（domain/change-cards.ts）：
 * - 轮边界（用户消息）切分与卡位置（轮末、下一条用户消息之前）；
 * - tailOpen（末轮仍在进行）时末段不注卡；
 * - 同版修订去重与字段映射（prevRevisionId 决定 diff/打开语义）。
 */
import { describe, expect, test } from "bun:test";
import { injectChangeCards, type RevisionChangeInput } from "../src/domain/change-cards.ts";
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

// ─── 时间窗模式（durable 会话：project agent / 探索任务） ────────────────

function userAt(id: string, ts: string): SynthiaTextPart {
  return { kind: "text", id, role: "user", state: "done", text: "做这件事", segments: null, ts };
}

function rev(revisionId: string, version: number, createdAt: string, prevRevisionId: string | null = null): RevisionChangeInput {
  return {
    artifactId: `art-${revisionId}`,
    revisionId,
    version,
    createdAt,
    path: `rtl/${revisionId}.v`,
    prevRevisionId,
  };
}

describe("injectChangeCards · 时间窗模式", () => {
  const t1 = "2026-09-11T20:00:00Z";
  const t2 = "2026-09-11T20:10:00Z";

  test("修订按登记时间归入对应轮次，卡插在下一条用户消息之前", () => {
    const flow: SynthiaPart[] = [userAt("u1", t1), agentText("a1"), userAt("u2", t2), agentText("a2")];
    const revisions = [
      rev("r1", 1, "2026-09-11T20:03:00Z"),
      rev("r2", 1, "2026-09-11T20:12:00Z"),
    ];
    const out = injectChangeCards(flow, { tailOpen: false, revisions });
    expect(kinds(out)).toEqual(["text", "text", "changes", "text", "text", "changes"]);
    const [c1, c2] = cards(out);
    expect(c1!.items.map((i) => i.revisionId)).toEqual(["r1"]);
    expect(c2!.items.map((i) => i.revisionId)).toEqual(["r2"]);
    expect(c2!.items[0]!.title).toBe("v1");
  });

  test("首轮对话之前登记的修订（种子）被丢弃", () => {
    const flow: SynthiaPart[] = [userAt("u1", t1), agentText("a1")];
    const revisions = [
      rev("seed", 1, "2026-09-11T19:00:00Z"),
      rev("r1", 2, "2026-09-11T20:03:00Z", "seed"),
    ];
    const out = injectChangeCards(flow, { tailOpen: false, revisions });
    const card = cards(out)[0]!;
    expect(card.items).toHaveLength(1);
    expect(card.items[0]!.revisionId).toBe("r1");
    expect(card.items[0]!.prevRevisionId).toBe("seed"); // diff 链不受丢弃影响
  });

  test("末轮运行中（tailOpen）时末窗不注卡", () => {
    const flow: SynthiaPart[] = [userAt("u1", t1), agentText("a1"), userAt("u2", t2)];
    const revisions = [rev("r1", 1, "2026-09-11T20:03:00Z"), rev("r2", 1, "2026-09-11T20:12:00Z")];
    const open = injectChangeCards(flow, { tailOpen: true, revisions });
    expect(cards(open).flatMap((c) => c.items.map((i) => i.revisionId))).toEqual(["r1"]);
  });

  test("同一轮多次登记按时间排序；无 ts 的用户消息不切窗", () => {
    const flow: SynthiaPart[] = [user("u0"), userAt("u1", t1), agentText("a1")];
    const revisions = [
      rev("rb", 2, "2026-09-11T20:05:00Z", "ra"),
      rev("ra", 1, "2026-09-11T20:02:00Z"),
    ];
    const out = injectChangeCards(flow, { tailOpen: false, revisions });
    const card = cards(out)[0]!;
    expect(card.items.map((i) => i.revisionId)).toEqual(["ra", "rb"]);
  });

  test("durable 流里混入的 doc 卡在时间窗模式下不重复归集", () => {
    const flow: SynthiaPart[] = [userAt("u1", t1), doc("d1", "rev-x"), agentText("a1")];
    const revisions = [rev("r1", 1, "2026-09-11T20:03:00Z")];
    const out = injectChangeCards(flow, { tailOpen: false, revisions });
    expect(cards(out)).toHaveLength(1);
    expect(cards(out)[0]!.items.map((i) => i.revisionId)).toEqual(["r1"]);
  });
});
