import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreeAgentSession, loadFreeAgentConversation } from "./free-agent.ts";
import { ModelWatchdogError, modelWatchdogMs, watchModelRequest } from "./model-watchdog.ts";
import { NoGovernanceClient } from "./types.ts";
import type { AgentTool, ConversationalModel } from "./agent-types.ts";

async function fixture(model: ConversationalModel, tools: readonly AgentTool[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "synthia-watchdog-"));
  const session = createFreeAgentSession(`agent-watchdog-${crypto.randomUUID()}`, {
    model, tools, agentsDir: dir, modelWatchdogMs: 60,
    projectId: "test-watchdog", part: "", classification: "internal",
    governance: new NoGovernanceClient(), connector: null, systemPrompt: "test",
  });
  return { session, dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

describe("H36 model-only watchdog", () => {
  test("defaults to 15 minutes; allows configuration and explicit disable", () => {
    expect(modelWatchdogMs({})).toBe(900_000);
    expect(modelWatchdogMs({ SYNTHIA_MODEL_WATCHDOG_MINUTES: "2" })).toBe(120_000);
    expect(modelWatchdogMs({ SYNTHIA_MODEL_WATCHDOG_MINUTES: "0" })).toBe(0);
    expect(modelWatchdogMs({ SYNTHIA_MODEL_WATCHDOG_MINUTES: "bad" })).toBe(900_000);
  });

  test("wedged request is aborted, interruption persisted, and retried once", async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const f = await fixture({ async chat(messages, _tools, signal) {
      calls++;
      if (calls === 1) { firstSignal = signal; return new Promise(() => {}); }
      expect(messages.some(m => m.role === "system" && m.content.includes("从中断点续"))).toBe(true);
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      expect(disk?.messages.some(m => m.role === "system" && m.content.includes("model_watchdog"))).toBe(true);
      return { kind: "text", content: "continued" };
    } });
    try {
      expect(await f.session.prompt("continue")).toBe("continued");
      expect(firstSignal?.aborted).toBe(true);
      expect(calls).toBe(2);
    } finally { await f.clean(); }
  });

  test("a second stall fails with no infinite retry", async () => {
    let calls = 0;
    const f = await fixture({ chat: async () => { calls++; return new Promise(() => {}); } });
    try {
      await expect(f.session.prompt("continue")).rejects.toBeInstanceOf(ModelWatchdogError);
      expect(calls).toBe(2);
    } finally { await f.clean(); }
  });

  test("operator abort cancels the current request without watchdog retry", async () => {
    let calls = 0;
    const entered = Promise.withResolvers<void>();
    let requestSignal: AbortSignal | undefined;
    const f = await fixture({ chat: async (_m, _t, signal) => { calls++; requestSignal = signal; entered.resolve(); return new Promise(() => {}); } });
    try {
      const pending = f.session.prompt("continue");
      await entered.promise;
      f.session.abort("operator cancelled");
      await expect(pending).rejects.toThrow("operator cancelled");
      expect(requestSignal?.aborted).toBe(true);
      expect(calls).toBe(1);
    } finally { await f.clean(); }
  });

  test("slow tool execution is outside the watchdog window", async () => {
    let calls = 0;
    let toolCalls = 0;
    const f = await fixture({ chat: async () => ++calls === 1
      ? { kind: "tool_calls", content: null, calls: [{ toolCallId: "slow-1", name: "slow_read", args: {} }] }
      : { kind: "text", content: "finished" } }, [{
      name: "slow_read", description: "test", parameters: { type: "object", properties: {} },
      execute: async () => { toolCalls++; await Bun.sleep(180); return { content: "done" }; },
    }]);
    try {
      expect(await f.session.prompt("run")).toBe("finished");
      expect(toolCalls).toBe(1);
      expect(calls).toBe(2);
      const disk = await loadFreeAgentConversation(f.session.agentId, f.dir);
      expect(disk?.messages.some(m => m.role === "system" && m.content.includes("model_watchdog"))).toBe(false);
    } finally { await f.clean(); }
  });

  test("conversation persistence resets inactivity, rather than imposing an absolute round deadline", async () => {
    let lastPersisted = 0;
    const controller = new AbortController();
    const timer = setInterval(() => { lastPersisted = Date.now(); }, 15);
    try {
      expect(await watchModelRequest(async () => { await Bun.sleep(150); return "ok"; }, controller, 60, () => lastPersisted)).toBe("ok");
      expect(controller.signal.aborted).toBe(false);
    } finally { clearInterval(timer); }
  });
});

test("H36 streaming retries drop late text from the aborted request", async () => {
  let calls = 0;
  let late: (() => void) | undefined;
  const deltas: string[] = [];
  const model: import("./agent-types.ts").ConversationalModel & import("./agent-types.ts").StreamingConversationalModel = {
    chat: async () => { throw new Error("streaming expected"); },
    chatStream: async (_messages, _tools, opts) => {
      calls++;
      if (calls === 1) {
        late = () => { opts.onTextStart?.(); opts.onDelta?.("discard me"); };
        return new Promise(() => {});
      }
      opts.onTextStart?.();
      opts.onDelta?.("continued");
      return { kind: "text", content: "continued" };
    },
  };
  const f = await fixture(model);
  try {
    expect(await f.session.prompt("continue", { onTextStart: () => {}, onDelta: (_id, text) => deltas.push(text) })).toBe("continued");
    late?.();
    expect(deltas).toEqual(["continued"]);
    expect(calls).toBe(2);
  } finally { await f.clean(); }
});
