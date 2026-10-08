import { describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreeAgentSession, loadFreeAgentConversation } from "./free-agent.ts";
import { NoGovernanceClient } from "./types.ts";
import type { AgentMessage, AgentTool, ChatTurn, ConversationalModel, StreamingConversationalModel } from "./agent-types.ts";

function text(content: string, stopReason = "end_turn"): ChatTurn {
  return { kind: "text", content, stopReason };
}

async function fixture(turns: readonly ChatTurn[], tools: readonly AgentTool[] = [], streaming = false) {
  const dir = await mkdtemp(join(tmpdir(), "synthia-output-limit-"));
  const calls: (readonly AgentMessage[])[] = [];
  let beforeReply: (() => Promise<void>) | undefined;
  const chat: ConversationalModel["chat"] = async (messages) => {
    calls.push([...messages]);
    await beforeReply?.();
    const turn = turns[calls.length - 1];
    if (!turn) throw new Error("unexpected extra model request");
    return turn;
  };
  const model: ConversationalModel & Partial<StreamingConversationalModel> = { chat };
  if (streaming) model.chatStream = async (messages, tools, opts) => {
    const turn = await chat(messages, tools, opts.signal);
    opts.onTextStart?.();
    if (turn.content) opts.onDelta?.(turn.content);
    return turn;
  };
  const session = createFreeAgentSession(`agent-output-limit-${crypto.randomUUID()}`, {
    model, tools, agentsDir: dir, modelWatchdogMs: 0,
    projectId: "test-output-limit", part: "", classification: "internal",
    governance: new NoGovernanceClient(), connector: null, systemPrompt: "test",
  });
  session.setPermissionSkipAll(true);
  return { session, dir, calls, setBeforeReply: (callback: () => Promise<void>) => { beforeReply = callback; }, clean: () => rm(dir, { recursive: true, force: true }) };
}

describe("H38 deterministic output-limit continuation", () => {
  test("two truncations persist partial text and retry audits before a normal reply", async () => {
    const f = await fixture([text("先读 X：", "max_tokens"), text("再读 Y：", "max_tokens"), text("阶段汇总")]);
    const logs: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (String(chunk).includes(f.session.agentId)) { logs.push(String(chunk)); return true; }
      return original(chunk);
    });
    f.setBeforeReply(async () => {
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      const notes = disk!.messages.filter(m => m.content?.startsWith("[model_output_limit]"));
      expect(notes).toHaveLength(f.calls.length - 1);
    });
    try {
      expect(await f.session.prompt("继续任务")).toBe("阶段汇总");
      expect(f.calls).toHaveLength(3);
      expect(logs).toEqual([
        `[free-agent] ${f.session.agentId}: model output limit stop_reason=max_tokens; retry=1/2\n`,
        `[free-agent] ${f.session.agentId}: model output limit stop_reason=max_tokens; retry=2/2\n`,
      ]);
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      expect(disk!.messages.filter(m => m.role === "assistant").map(m => m.content)).toEqual(["先读 X：", "再读 Y：", "阶段汇总"]);
      expect(disk!.messages.filter(m => m.role === "assistant").map(m => m.stopReason)).toEqual(["max_tokens", "max_tokens", "end_turn"]);
      expect(f.calls[2]!.at(-1)!.content).toContain("retry=2/2 disposition=retry");
      expect(f.session.status()).toBe("idle");
    } finally { spy.mockRestore(); await f.clean(); }
  });

  test("streaming truncations reach tools, execute once, then finish", async () => {
    let executed = 0;
    const f = await fixture([
      text("先读：", "max_tokens"), text("再读：", "max_tokens"),
      { kind: "tool_calls", calls: [{ toolCallId: "read-1", name: "read_probe", args: {} }], content: "读取", stopReason: "tool_use" },
      text("读取完成"),
    ], [{ name: "read_probe", description: "test", parameters: { type: "object", properties: {} }, execute: async () => { executed++; return { content: "file content" }; } }], true);
    const deltas: string[] = [];
    try {
      expect(await f.session.prompt("读文件", { onTextStart: () => {}, onDelta: (_id, delta) => deltas.push(delta) })).toBe("读取完成");
      expect(f.calls).toHaveLength(4);
      expect(executed).toBe(1);
      expect(deltas).toEqual(["先读：", "再读：", "读取", "读取完成"]);
      expect(f.calls[3]!.filter(m => m.role === "tool")).toHaveLength(1);
    } finally { await f.clean(); }
  });

  test("a third truncation exhausts two retries; a later user prompt has a fresh budget", async () => {
    const f = await fixture([text("一", "max_tokens"), text("二", "max_tokens"), text("三", "max_tokens"), text("四", "max_tokens"), text("结束")]);
    const logs: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => { logs.push(String(chunk)); return true; });
    try {
      expect(await f.session.prompt("开始")).toBe("三");
      expect(f.calls).toHaveLength(3);
      expect(f.session.status()).toBe("idle");
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      expect(disk!.messages.filter(m => m.content?.includes("disposition=exhausted"))).toHaveLength(1);
      expect(logs.at(-1)).toBe(`[free-agent] ${f.session.agentId}: model output limit stop_reason=max_tokens; retry=2/2 exhausted\n`);
      expect(await f.session.prompt("继续")).toBe("结束");
      expect(f.calls).toHaveLength(5);
      expect(f.calls[4]!.at(-1)!.content).toContain("retry=1/2");
    } finally { spy.mockRestore(); await f.clean(); }
  });

  for (const emptyFirst of [true, false]) test(`empty nudge and truncation budgets are independent (emptyFirst=${emptyFirst})`, async () => {
    const empty = text("", "max_tokens");
    const truncated = text("继续：", "max_tokens");
    const f = await fixture([...(emptyFirst ? [empty, truncated] : [truncated, empty]), truncated, text("汇总")]);
    try {
      expect(await f.session.prompt("继续")).toBe("汇总");
      expect(f.calls).toHaveLength(4);
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      expect(disk!.messages.filter(m => m.content?.includes("回复内容为空"))).toHaveLength(1);
      expect(disk!.messages.filter(m => m.content?.startsWith("[model_output_limit]"))).toHaveLength(2);
    } finally { await f.clean(); }
  });

  test("whitespace truncation uses only the existing empty-reply guard", async () => {
    const f = await fixture([text(" \n", "max_tokens"), text("", "max_tokens")]);
    try {
      expect(await f.session.prompt("开始")).toContain("模型连续返回空正文");
      expect(f.calls).toHaveLength(2);
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      expect(disk!.messages.some(m => m.content?.includes("[model_output_limit]"))).toBe(false);
    } finally { await f.clean(); }
  });

  test("end_turn and unknown stop reasons never trigger semantic continuation", async () => {
    for (const turn of [text("先读 X 再读 Y："), { kind: "text", content: "先读 X：" } as ChatTurn]) {
      const f = await fixture([turn]);
      try {
        expect(await f.session.prompt("开始")).toBe(turn.content!);
        expect(f.calls).toHaveLength(1);
      } finally { await f.clean(); }
    }
  });

  test("tool_calls with max_tokens still run through the tool loop once", async () => {
    let executed = 0;
    const f = await fixture([
      { kind: "tool_calls", content: "部分文本", stopReason: "max_tokens", calls: [{ toolCallId: "read-1", name: "read_probe", args: {} }] }, text("完成"),
    ], [{ name: "read_probe", description: "test", parameters: { type: "object", properties: {} }, execute: async () => { executed++; return { content: "data" }; } }]);
    try {
      expect(await f.session.prompt("读取")).toBe("完成");
      expect(executed).toBe(1);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1]!.some(m => m.content?.includes("[model_output_limit]"))).toBe(false);
    } finally { await f.clean(); }
  });

  test("exhausted truncation still passes through the existing completion-claim check", async () => {
    const f = await fixture([text("一", "max_tokens"), text("二", "max_tokens"), text("仿真通过", "max_tokens"), text("未验证，需要真实仿真证据")]);
    try {
      expect(await f.session.prompt("验证")).toBe("未验证，需要真实仿真证据");
      expect(f.calls).toHaveLength(4);
      expect(f.calls[3]!.some(m => m.role === "tool" && m.name === "claim_check" && m.isError)).toBe(true);
    } finally { await f.clean(); }
  });
});
