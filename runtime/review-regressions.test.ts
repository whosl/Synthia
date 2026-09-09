import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFreeAgentSession, loadFreeAgentConversation } from "./free-agent.ts";
import { createAgentState, loadAgentState } from "./agent-state.ts";
import { RuntimeServer } from "./server.ts";
import { CounterScriptedModel, rtlCounter, tbCounter } from "./deps.ts";
import { FakeVivadoConnector, LoopExecutor, successBehavior, failOnceThenSucceedBehavior } from "./loop.ts";
import { NoGovernanceClient } from "./types.ts";
import { StreamHub } from "./stream-hub.ts";
import { CoreApiConnector } from "./core-api-connector.ts";

// Explicit audit reproducer: no network, real model, database, or Vivado work.
// These assertions describe expected behavior; R6 permits explicit rejection of pipeline chat.

let directory: string;
let priorDirectory: string | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "synthia-runtime-review-"));
  priorDirectory = process.env.SYNTHIA_RUNS_DIR;
  process.env.SYNTHIA_RUNS_DIR = directory;
});
afterEach(async () => {
  if (priorDirectory === undefined) delete process.env.SYNTHIA_RUNS_DIR;
  else process.env.SYNTHIA_RUNS_DIR = priorDirectory;
  await rm(directory, { recursive: true, force: true });
});
const prompts = { rtl: "", tb: "", xdc: "", repair: "", intake: "", behaviorWave: "", architecture: "", registerSpec: "" };
const config = { port: 0, gatePollMs: 0, skillPrompts: prompts, defaultPart: "xc7k70tfbv676-1", toolModelPolicyHash: "a".repeat(64) };
function makeSession(id: string, model: any) {
  return createFreeAgentSession(id, {
    model, tools: [], projectId: "review-project", part: "xc7k70tfbv676-1", classification: "internal",
    governance: new NoGovernanceClient(), connector: null, systemPrompt: "review-only fixture",
    initialState: createAgentState({ agentId: id, projectId: "review-project", task: "review", part: "xc7k70tfbv676-1", processInstanceId: "free:review-project", projectType: "free", executionMode: "free" }),
  });
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(5); }
  throw new Error("fixture did not reach its synchronization barrier");
}

test("R1: successful simulation repair must reach synthesis and returned artifacts", async () => {
  const fixedRtl = { ...rtlCounter(), content: rtlCounter().content + "// repaired-rtl-v2\n" };
  const fixedTb = { ...tbCounter(), content: tbCounter().content + "// repaired-tb-v2\n" };
  class RepairingModel extends CounterScriptedModel {
    override async repair() { return { phase: "repair" as const, reasoning: "fixed", sources: [fixedRtl], testbench: fixedTb }; }
  }
  const requests: any[] = [];
  const behavior = failOnceThenSucceedBehavior("simulate", 1);
  const connector = new FakeVivadoConnector({ behavior: { respond: (request, index) => {
    requests.push(structuredClone(request));
    return behavior.respond(request, index);
  } } });
  const checkpoints: any[] = [];
  const agentState = createAgentState({ agentId: "repair-checkpoint", task: "8-bit counter", projectId: "review-project", processInstanceId: "pi-review", part: "xc7k70tfbv676-1" });
  const result = await new LoopExecutor({ model: new RepairingModel(), connector, governance: new NoGovernanceClient(),
    onStateChange: async (state) => { checkpoints.push(structuredClone(state)); },
    skillPrompts: prompts, projectId: "review-project", processInstanceId: "pi-review", part: "xc7k70tfbv676-1", toolModelPolicyHash: "a".repeat(64),
  }).run("8-bit counter", { agentId: "repair-checkpoint", agentState });
  const simulations = requests.filter((request) => request.operation === "simulate");
  const synthesis = requests.find((request) => request.operation === "synthesize");
  assert.equal(simulations.at(-1)?.sources[0].content, fixedRtl.content);
  assert.equal(synthesis.sources[0].content, fixedRtl.content);
  assert.equal(requests.find((r) => r.operation === "implement").sources[0].content, fixedRtl.content);
  assert.equal(result.rtl?.sources[0]?.content, fixedRtl.content);
  assert.equal(result.testbench?.testbench.content, fixedTb.content);
  const repairedCheckpoints = checkpoints.filter((state) => state.rtlRevision?.version > 1);
  assert.ok(repairedCheckpoints.length > 0);
  for (const state of repairedCheckpoints) assert.equal(state.rtlArtifacts.sources[0].content, fixedRtl.content);
  assert.equal(checkpoints.at(-1).tbArtifacts.testbench.content, fixedTb.content);
  for (const state of checkpoints.filter((state) => state.tbRevision?.version > 1)) {
    assert.equal(state.tbArtifacts.testbench.content, fixedTb.content);
  }
});

test("R2: lazy recovery must restore the persisted conversation before overwriting it", async () => {
  const id = "agent-review-history";
  const first = makeSession(id, { chat: async () => ({ kind: "text", content: "original-answer-unique" }) });
  await first.prompt("original-request-unique");
  const before = await loadFreeAgentConversation(id);
  const calls: any[] = [];
  const server = new RuntimeServer(config, async () => ({ model: new CounterScriptedModel(), connector: new FakeVivadoConnector({ behavior: successBehavior() }), governance: new NoGovernanceClient() }),
    () => ({ chat: async (messages: any) => { calls.push(structuredClone(messages)); return { kind: "text", content: "followup-answer" }; } }));
  const recovered = await (server as any).getOrCreateSession(id);
  assert.notEqual(recovered, null);
  await recovered.prompt("continue-from-prior-request");
  const after = await loadFreeAgentConversation(id);
  assert.ok(JSON.stringify(calls).includes("original-request-unique"));
  assert.ok(JSON.stringify(after).includes("original-request-unique"));
  assert.ok((after?.messages.length ?? 0) > (before?.messages.length ?? 0));
});

test("R3: a plain-text model return must consume an accepted in-flight steer", async () => {
  const id = "agent-review-steer";
  const release = Promise.withResolvers<any>();
  let calls = 0;
  const session = makeSession(id, { chat: async () => { calls++; return calls === 1 ? release.promise : { kind: "text", content: "corrected-answer" }; } });
  const prompt = session.prompt("initial task");
  await until(() => calls === 1);
  await session.steer("correction-that-must-not-disappear");
  release.resolve({ kind: "text", content: "outdated-answer" });
  const reply = await prompt;
  const disk = await loadFreeAgentConversation(id);
  assert.ok(calls > 1);
  assert.equal(reply, "corrected-answer");
  assert.ok(JSON.stringify(disk).includes("correction-that-must-not-disappear"));
});

test("R4: a cursor from before Runtime restart must reset instead of hiding fresh events", async () => {
  const id = "agent-review-stream";
  const hub = StreamHub.for(id);
  const cursor = hub.subscribe(200);
  hub.emit({ type: "status", status: "running", ts: "review" });
  const pending = cursor.next();
  const result = await Promise.race([pending, Bun.sleep(30).then(() => "timed-out")]);
  cursor.stop();
  await pending;
  StreamHub.drop(id);
  assert.notEqual(result, "timed-out");
});

test("R5: a job polling deadline must bound an individual stuck HTTP read", async () => {
  let observedSignal: unknown;
  let gets = 0;
  const pending = Promise.withResolvers<Response>();
  const connector = new CoreApiConnector({ projectId: "review-project", baseUrl: "http://unused.local", token: "synthetic-test-token", maxPollMs: 10, pollIntervalMs: 1,
    fetchImpl: (async (_url: any, init: any) => {
      if (init.method === "POST") return Response.json({ data: { jobId: "review-job", state: "queued" } });
      gets++; observedSignal = init.signal;
      if (gets === 1) {
        init.signal?.addEventListener("abort", () => pending.reject(init.signal.reason), { once: true });
        return pending.promise;
      }
      return Response.json({ data: { entries: [] } });
    }) as typeof fetch,
  });
  const submission = connector.submit({ operation: "validate_sources", runClass: "exploratory", projectId: "review-project", sources: [rtlCounter()], top: "counter", part: "xc7k70tfbv676-1" });
  const outcome = await Promise.race([submission.then(() => "settled", () => "settled"), Bun.sleep(40).then(() => "still-pending")]);
  pending.resolve(Response.json({ data: { jobId: "review-job", state: "succeeded" } }));
  await submission.catch(() => {});
  assert.equal(outcome, "settled");
});

test("R6: engineering message and abort must operate on the active pipeline", async () => {
  const hold = Promise.withResolvers<void>();
  let modelStarted = false;
  class DelayedModel extends CounterScriptedModel {
    override async generateIntake(task: string) { modelStarted = true; await hold.promise; return super.generateIntake(task); }
  }
  const server = new RuntimeServer(config, async () => ({ model: new DelayedModel(), connector: new FakeVivadoConnector({ behavior: successBehavior() }), governance: new NoGovernanceClient() }),
    () => ({ chat: async () => ({ kind: "text", content: "independent-conversation-answer" }) }));
  const internal = server as any;
  const send = (path: string, body?: unknown) => internal.handle(new Request(`http://runtime.test${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Promise<Response>;
  const created = await (await send("/tasks", { project_id: "review-project", process_instance_id: "pi-review", task: "8-bit counter" })).json() as any;
  const id = created.agent_id;
  assert.equal(typeof id, "string");
  await until(() => modelStarted);
  const coreEvents: any[] = [];
  internal.registry.get(id).taskEvents = { appendEvent: async (event: any) => { coreEvents.push(event); } };
  const messageResponse = await send(`/tasks/${id}/message`, { text: "please correct the ongoing pipeline" });
  assert.equal(messageResponse.status, 409);
  assert.equal((await messageResponse.json()).error.code, "pipeline_message_not_supported");
  assert.equal(internal.sessions.has(id), false);
  assert.equal((await loadAgentState(id)).task, "8-bit counter");
  const abort = await (await send(`/tasks/${id}/abort`, {})).json() as any;
  await until(() => !internal.registry.get(id).busy);
  const persisted = await loadAgentState(id);
  assert.equal(abort.aborted, true);
  assert.equal(coreEvents.filter((e) => e.type === "status" && e.payload.status === "cancelled").length, 1);
  assert.equal(persisted.status, "failed");
  assert.ok(persisted.endedReason?.includes("aborted"));
  hold.resolve();
  await Bun.sleep(10);
  assert.equal((await loadAgentState(id)).status, "failed");
  assert.equal((await loadAgentState(id)).task, "8-bit counter");
  StreamHub.drop(id);
});

test("R2: interrupted tool batch recovers with unknown results without replaying tools", async () => {
  const session = createFreeAgentSession("recover-tools", {
    model: { chat: async (messages) => {
      const result = messages.find((m) => m.role === "tool" && m.toolCallId === "unfinished");
      assert.equal(result?.role, "tool");
      assert.ok(result && "isError" in result && result.isError);
      return { kind: "text", content: "inspect current state" };
    } },
    tools: [], systemPrompt: "fresh rules", projectId: "p", part: "", classification: "internal",
    governance: new NoGovernanceClient(), connector: null,
    initialConversation: { agentId: "recover-tools", status: "running", messages: [
      { role: "system", content: "old rules" },
      { role: "user", content: "original" },
      { role: "assistant", content: null, toolCalls: [{ toolCallId: "unfinished", name: "write", args: {} }] },
    ] },
  });
  await session.prompt("continue");
  const history = await loadFreeAgentConversation("recover-tools");
  assert.equal(history?.messages[0]?.content, "fresh rules");
});

test("R2: corrupt existing history fails closed and retains its bytes", async () => {
  const path = join(directory, "corrupt.conversation.json");
  await writeFile(path, "{broken");
  await assert.rejects(loadFreeAgentConversation("corrupt"));
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("R3: steering is durable before acknowledgement and follows the whole tool batch", async () => {
  const first = Promise.withResolvers<any>();
  let called = false;
  const seen: any[] = [];
  const session = makeSession("steer-batch", { chat: async (messages: any) => {
    seen.push(structuredClone(messages));
    if (!called) { called = true; return first.promise; }
    return { kind: "text", content: "updated" };
  } });
  const run = session.prompt("initial");
  await until(() => called);
  await session.steer("durable-correction");
  assert.deepEqual((await loadFreeAgentConversation("steer-batch"))?.pendingSteer, ["durable-correction"]);
  first.resolve({ kind: "tool_calls", content: null, calls: [
    { toolCallId: "a", name: "unknown", args: {} }, { toolCallId: "b", name: "unknown", args: {} },
  ] });
  assert.equal(await run, "updated");
  assert.deepEqual(seen[1].slice(-4).map((m: any) => m.role), ["assistant", "tool", "tool", "user"]);
  assert.deepEqual((await loadFreeAgentConversation("steer-batch"))?.pendingSteer, []);
});

test("R4: future cursor resets even before the new hub emits anything", async () => {
  const hub = StreamHub.for("reset-empty");
  const cursor = hub.subscribe(500);
  assert.equal((await cursor.next())[0]?.type, "reset");
  const emitted = hub.emit({ type: "status", status: "running", ts: "t" });
  assert.deepEqual(await cursor.next(), [emitted]);
  cursor.stop();
  StreamHub.drop("reset-empty");
});

test("R5: a response body that ignores abort is still bounded and keeps the job identity", async () => {
  let signal: AbortSignal | undefined;
  const connector = new CoreApiConnector({
    projectId: "p", baseUrl: "http://unused", token: "fixture", maxPollMs: 20, requestTimeoutMs: 100,
    fetchImpl: (async (_url: any, init: any) => {
      if (init.method === "POST") return Response.json({ data: { jobId: "same-job" } });
      signal = init.signal;
      return { status: 200, text: () => new Promise(() => {}) } as Response;
    }) as typeof fetch,
  });
  const result = await connector.submit({ operation: "validate_sources", runClass: "exploratory", projectId: "p", sources: [rtlCounter()], top: "counter", part: "" });
  assert.equal(result.jobId, "same-job");
  assert.equal(result.status, "unknown_effect");
  assert.equal(result.errorCode, "poll_timeout");
  assert.equal(signal?.aborted, true);
});

test("R5/R6: cancellation reaches Core fetch and prevents polling after a late submit response", async () => {
  const controller = new AbortController();
  const response = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  const connector = new CoreApiConnector({
    projectId: "p", baseUrl: "http://unused", token: "fixture",
    fetchImpl: (async (_url: any, init: any) => { signals.push(init.signal); return response.promise; }) as typeof fetch,
  }).withSignal(controller.signal);
  const run = connector.submit({ operation: "validate_sources", runClass: "exploratory", projectId: "p", sources: [rtlCounter()], top: "counter", part: "" });
  await until(() => signals.length === 1);
  controller.abort(new Error("cancel-test"));
  await assert.rejects(run, /cancel-test/);
  assert.equal(signals[0]?.aborted, true);
  response.resolve(Response.json({ data: { jobId: "late-job" } }));
  await Bun.sleep(10);
  assert.equal(signals.length, 1);
});
