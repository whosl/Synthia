import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreeAgentSession, loadFreeAgentConversation, type ContextPolicy, type FreeAgentDeps } from "./free-agent.ts";
import { NoGovernanceClient } from "./types.ts";
import { deleteAgent, loadAgentState } from "./agent-state.ts";
import type { AgentMessage, BeforeModelCallHook, ChatTurn } from "./agent-types.ts";

function largeHistory(): AgentMessage[] {
  const history: AgentMessage[] = [{ role: "system", content: "old system" }];
  for (let i = 0; i < 211; i++) {
    history.push({ role: "user", content: `历史任务 ${i}` });
    history.push({ role: "assistant", content: "N".repeat(14_400), toolCalls: [{ toolCallId: `read-${i}`, name: "read", args: { path: `rtl/source-${i}.v` } }] });
    history.push({ role: "tool", toolCallId: `read-${i}`, name: "read", content: "T".repeat(i < 4 ? 250_000 : 2_000) });
  }
  return history;
}

async function fixture(turns: readonly ChatTurn[], opts: Partial<FreeAgentDeps> = {}, history?: AgentMessage[]) {
  const dir = await mkdtemp(join(tmpdir(), "synthia-turn-termination-"));
  const agentId = `agent-turn-end-${crypto.randomUUID()}`;
  const requests: (readonly AgentMessage[])[] = [];
  const session = createFreeAgentSession(agentId, {
    model: { async chat(messages) {
      requests.push([...messages]);
      const turn = turns[requests.length - 1];
      if (!turn) throw new Error("injected model failure");
      return turn;
    } },
    tools: [], agentsDir: dir, modelWatchdogMs: 0, systemPrompt: "system",
    projectId: "test-turn-end", part: "", classification: "internal",
    governance: new NoGovernanceClient(), connector: null,
    ...(history ? { initialConversation: { agentId, status: "idle", messages: history } } : {}),
    ...opts,
  });
  return {
    session, agentId, dir, requests,
    conversation: () => loadFreeAgentConversation(agentId, dir),
    state: () => loadAgentState(agentId),
    clean: async () => { await deleteAgent(agentId); await rm(dir, { recursive: true, force: true }); },
  };
}

const policy: ContextPolicy = { contextWindow: 200_000, outputReserveTokens: 65_536, enforceEstimatedBudget: true };
const empty: ChatTurn = { kind: "text", content: "", stopReason: "max_tokens" };

describe("H38 every terminated turn has a durable visible record", () => {
  test("634 messages / 4.45MB: failed summary and insufficient mechanical compaction never end silently", async () => {
    const history = largeHistory();
    expect(history).toHaveLength(634);
    expect(history.reduce((n, m) => n + (m.content?.length ?? 0), 0)).toBeGreaterThan(4_400_000);
    const f = await fixture([empty], { contextPolicy: policy }, history);
    try {
      await expect(f.session.prompt("继续任务")).rejects.toThrow("context_budget_exceeded");
      expect(f.requests).toHaveLength(0);
      const disk = await f.conversation();
      expect(disk!.messages.slice(history.length + 1).some(m => m.role === "system" && m.content.includes("context_budget_exceeded"))).toBe(true);
      expect(f.session.status()).toBe("failed");
      expect((await f.state()).contextUsageSnapshot.failure).toBe("context_limit");
    } finally { await f.clean(); }
  });

  test("same large history / tighter projection: empty max_tokens nudges then leaves a visible exhaustion note", async () => {
    const history = largeHistory();
    const f = await fixture([empty, empty], { contextPolicy: { ...policy, toolResultBudgetChars: 100 } }, history);
    try {
      const reply = await f.session.prompt("继续任务");
      expect(reply.trim().length).toBeGreaterThan(0);
      expect(f.requests).toHaveLength(2);
      const disk = await f.conversation();
      const tail = disk!.messages.slice(history.length + 1);
      expect(tail.some(m => m.role === "system" && m.content.includes("empty_reply_exhausted"))).toBe(true);
      expect(tail.some(m => m.content?.includes("回复内容为空"))).toBe(true);
      expect(disk!.messages.slice(1, history.length)).toEqual(history.slice(1));
      expect((await f.state()).status).toBe("awaiting_user");
    } finally { await f.clean(); }
  });

  test("beforeModelCall stop persists its reason even though the provider is never called", async () => {
    const f = await fixture([]);
    (f.session as unknown as { beforeModelCallHook: BeforeModelCallHook }).beforeModelCallHook = () => ({ stop: true, reason: "test data-domain rejection" });
    try {
      expect(await f.session.prompt("go")).toContain("test data-domain rejection");
      expect(f.requests).toHaveLength(0);
      expect((await f.conversation())!.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("test data-domain rejection") });
    } finally { await f.clean(); }
  });

  test("model errors are recorded in conversation before being rethrown", async () => {
    const f = await fixture([]);
    try {
      await expect(f.session.prompt("go")).rejects.toThrow("injected model failure");
      expect((await f.conversation())!.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("injected model failure") });
    } finally { await f.clean(); }
  });

  test("finite round exhaustion after an empty nudge also leaves an error record", async () => {
    const f = await fixture([empty], { maxToolRounds: 1 });
    try {
      await expect(f.session.prompt("go")).rejects.toThrow("exceeded 1 tool rounds");
      expect((await f.conversation())!.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("exceeded 1 tool rounds") });
    } finally { await f.clean(); }
  });

  test("a future return without any recorded output is caught by the prompt boundary", async () => {
    const f = await fixture([]);
    (f.session as unknown as { runLoop: () => Promise<string> }).runLoop = async () => "";
    try {
      expect((await f.session.prompt("go")).trim().length).toBeGreaterThan(0);
      expect((await f.conversation())!.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("turn_no_output") });
    } finally { await f.clean(); }
  });
});
