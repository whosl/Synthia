/**
 * 右栏输入区语义单测（domain/composer.ts；spec §3.5 D21）。
 */
import { describe, expect, test } from "bun:test";
import {
  COMPOSER_PLACEHOLDER,
  STEER_BADGE_TEXT,
  STEER_NOTE_MARK,
  buildChatRenderItems,
  canSendText,
  composerPlaceholder,
  judgeComposer,
} from "../src/domain/composer.ts";
import type { SynthiaGatePart, SynthiaNotePart, SynthiaPart, SynthiaTextPart } from "../src/domain/parts.ts";

// ─── 判定函数 judgeComposer ──────────────────────────────────────────

describe("judgeComposer", () => {
  test("项目尚无 run → new-task，占位「说点什么…」，不可打断", () => {
    const j = judgeComposer({ hasRun: false, runStatus: null, sending: false });
    expect(j.mode).toBe("new-task");
    expect(j.placeholder).toBe("说点什么…");
    expect(j.canAbort).toBe(false);
    expect(j.canSend).toBe(true);
  });

  test("run 运行中 → steer，占位含「当前步骤结束后生效」，可打断", () => {
    const j = judgeComposer({ hasRun: true, runStatus: "running", sending: false });
    expect(j.mode).toBe("steer");
    expect(j.placeholder).toContain("当前步骤结束后生效");
    expect(j.canAbort).toBe(true);
  });

  test("run 终态（succeeded/failed/…）→ prompt，占位「说点什么…」，不可打断", () => {
    for (const status of ["succeeded", "failed", "fail_closed", "interrupted", "awaiting_approval"]) {
      const j = judgeComposer({ hasRun: true, runStatus: status, sending: false });
      expect(j.mode).toBe("prompt");
      expect(j.placeholder).toBe("说点什么…");
      expect(j.canAbort).toBe(false);
    }
  });

  test("sending=true 时 canSend 为 false，与 mode 无关", () => {
    expect(judgeComposer({ hasRun: false, runStatus: null, sending: true }).canSend).toBe(false);
    expect(judgeComposer({ hasRun: true, runStatus: "running", sending: true }).canSend).toBe(false);
    expect(judgeComposer({ hasRun: true, runStatus: "succeeded", sending: true }).canSend).toBe(false);
  });

  test("占位文案表里绝不出现「排队」措辞（D21 铁律）", () => {
    for (const text of Object.values(COMPOSER_PLACEHOLDER)) {
      expect(text).not.toContain("排队");
      expect(text).not.toContain("队列");
    }
  });

  test("composerPlaceholder 与 COMPOSER_PLACEHOLDER 表一致", () => {
    expect(composerPlaceholder("new-task")).toBe(COMPOSER_PLACEHOLDER["new-task"]);
    expect(composerPlaceholder("prompt")).toBe(COMPOSER_PLACEHOLDER.prompt);
    expect(composerPlaceholder("steer")).toBe(COMPOSER_PLACEHOLDER.steer);
  });
});

// ─── canSendText ──────────────────────────────────────────────────────

describe("canSendText", () => {
  test("空串/纯空白不可发送", () => {
    expect(canSendText("", false)).toBe(false);
    expect(canSendText("   \n\t  ", false)).toBe(false);
  });

  test("有内容且未在发送中 → 可发送", () => {
    expect(canSendText("继续", false)).toBe(true);
  });

  test("发送中禁止重复提交，即使有内容", () => {
    expect(canSendText("继续", true)).toBe(false);
  });
});

// ─── buildChatRenderItems：插话消息配对识别 ────────────────────────────

function userText(id: string, text: string): SynthiaTextPart {
  return { kind: "text", id, role: "user", state: "done", text, segments: null };
}

function agentText(id: string, text: string): SynthiaTextPart {
  return { kind: "text", id, role: "agent", state: "done", text, segments: null };
}

function steerNote(id: string): SynthiaNotePart {
  return { kind: "note", id, tone: "info", text: `${STEER_NOTE_MARK}，Agent 将在当前工具结束后看到。`, ts: "2026-08-17T10:00:00Z" };
}

function otherNote(id: string, tone: SynthiaNotePart["tone"] = "error"): SynthiaNotePart {
  return { kind: "note", id, tone, text: "本轮回复出现错误，未能完成。", ts: "2026-08-17T10:00:00Z" };
}

describe("buildChatRenderItems", () => {
  test("普通消息原样保留，顺序不变，steer 全为 false", () => {
    const parts: SynthiaPart[] = [userText("u1", "你好"), agentText("a1", "在的")];
    const items = buildChatRenderItems(parts);
    expect(items.map((i) => i.part.id)).toEqual(["u1", "a1"]);
    expect(items.every((i) => i.steer === false)).toBe(true);
  });

  test("user 消息紧跟纠偏 note → 打标 steer=true，且该 note 被折叠（不重复渲染）", () => {
    const parts: SynthiaPart[] = [agentText("a1", "正在跑仿真"), userText("u1", "先看看波形"), steerNote("n1")];
    const items = buildChatRenderItems(parts);
    expect(items.map((i) => i.part.id)).toEqual(["a1", "u1"]); // n1 被消费，不出现在结果里
    const u = items.find((i) => i.part.id === "u1")!;
    expect(u.steer).toBe(true);
  });

  test("普通错误 note（非纠偏文案）不会被误判为 steer 伴随项，照常保留", () => {
    const parts: SynthiaPart[] = [userText("u1", "重试一下"), otherNote("n1")];
    const items = buildChatRenderItems(parts);
    expect(items.map((i) => i.part.id)).toEqual(["u1", "n1"]);
    expect(items.find((i) => i.part.id === "u1")!.steer).toBe(false);
  });

  test("纠偏 note 紧跟的不是 user 消息（例如流首单独出现）时不被吞掉", () => {
    const parts: SynthiaPart[] = [agentText("a1", "…"), steerNote("n1")];
    const items = buildChatRenderItems(parts);
    expect(items.map((i) => i.part.id)).toEqual(["a1", "n1"]);
  });

  test("末尾 user 消息（无后续 part）不会因越界访问而报错，steer=false", () => {
    const parts: SynthiaPart[] = [agentText("a1", "…"), userText("u1", "还在吗")];
    const items = buildChatRenderItems(parts);
    expect(items.at(-1)!.steer).toBe(false);
  });

  test("多轮插话：每条 user 消息各自独立配对，不串扰", () => {
    const parts: SynthiaPart[] = [
      userText("u1", "第一条插话"),
      steerNote("n1"),
      userText("u2", "第二条插话"),
      steerNote("n2"),
    ];
    const items = buildChatRenderItems(parts);
    expect(items.map((i) => i.part.id)).toEqual(["u1", "u2"]);
    expect(items.every((i) => i.steer)).toBe(true);
  });

  test("门禁卡等其它 part 类型原样透传，不受影响", () => {
    const gate: SynthiaGatePart = { kind: "gate", id: "gate-G1", gate: "G1", review: "需求审查", state: "passed", ts: "2026-08-17T10:00:00Z" };
    const items = buildChatRenderItems([gate]);
    expect(items).toEqual([{ part: gate, steer: false }]);
  });

  test("STEER_BADGE_TEXT 是「↗ 纠偏」，不含「排队」措辞", () => {
    expect(STEER_BADGE_TEXT).toBe("↗ 纠偏");
    expect(STEER_BADGE_TEXT).not.toContain("排队");
  });
});
