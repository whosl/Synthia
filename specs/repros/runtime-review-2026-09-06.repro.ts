import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFreeAgentSession, loadFreeAgentConversation } from "../../runtime/free-agent.ts";
import { createAgentState, loadAgentState } from "../../runtime/agent-state.ts";
import { RuntimeServer } from "../../runtime/server.ts";
import { CounterScriptedModel, rtlCounter, tbCounter } from "../../runtime/deps.ts";
import { FakeVivadoConnector, LoopExecutor, successBehavior, failOnceThenSucceedBehavior } from "../../runtime/loop.ts";
import { NoGovernanceClient } from "../../runtime/types.ts";
import { StreamHub } from "../../runtime/stream-hub.ts";
import { CoreApiConnector } from "../../runtime/core-api-connector.ts";

// Explicit audit reproducer: no network, real model, database, or Vivado work.
// These assertions describe expected behavior; R6 permits explicit rejection of pipeline chat.
// Run with: bun run specs/repros/runtime-review-2026-09-06.repro.ts
const cases: Array<{ name: string; run: () => Promise<void> }> = [];
function test(name: string, run: () => Promise<void>): void { cases.push({ name, run }); }

let directory: string;
let priorDirectory: string | undefined;
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "synthia-runtime-review-"));
  priorDirectory = process.env.SYNTHIA_RUNS_DIR;
  process.env.SYNTHIA_RUNS_DIR = directory;
}
async function teardown() {
  if (priorDirectory === undefined) delete process.env.SYNTHIA_RUNS_DIR;
  else process.env.SYNTHIA_RUNS_DIR = priorDirectory;
  await rm(directory, { recursive: true, force: true });
}
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
  const result = await new LoopExecutor({ model: new RepairingModel(), connector, governance: new NoGovernanceClient(),
    skillPrompts: prompts, projectId: "review-project", processInstanceId: "pi-review", part: "xc7k70tfbv676-1", toolModelPolicyHash: "a".repeat(64),
  }).run("8-bit counter");
  const simulations = requests.filter((request) => request.operation === "simulate");
  const synthesis = requests.find((request) => request.operation === "synthesize");
  console.log("R1", JSON.stringify({ status: result.status, repairedSimulation: simulations.at(-1)?.sources[0].content.includes("repaired-rtl-v2"), synthesisUsesRepair: synthesis?.sources[0].content.includes("repaired-rtl-v2"), resultUsesRepair: result.rtl?.sources[0]?.content.includes("repaired-rtl-v2") }));
  assert.equal(simulations.at(-1)?.sources[0].content, fixedRtl.content);
  assert.equal(synthesis.sources[0].content, fixedRtl.content);
  assert.equal(requests.find((r) => r.operation === "implement").sources[0].content, fixedRtl.content);
  assert.equal(result.rtl?.sources[0]?.content, fixedRtl.content);
  assert.equal(result.testbench?.testbench.content, fixedTb.content);
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
  console.log("R2", JSON.stringify({ beforeMessages: before?.messages.length, modelSawOriginal: JSON.stringify(calls).includes("original-request-unique"), persistedOriginalAfterRecovery: JSON.stringify(after).includes("original-request-unique") }));
  assert.ok(JSON.stringify(calls).includes("original-request-unique"));
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
  console.log("R3", JSON.stringify({ reply, calls, persistedSteer: JSON.stringify(disk).includes("correction-that-must-not-disappear") }));
  assert.ok(calls > 1);
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
  console.log("R4", JSON.stringify({ result }));
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
  console.log("R5", JSON.stringify({ outcome, hasRequestSignal: observedSignal !== undefined }));
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
  const messageResponse = await send(`/tasks/${id}/message`, { text: "please correct the ongoing pipeline" });
  assert.equal(messageResponse.status, 409);
  assert.equal((await messageResponse.json()).error.code, "pipeline_message_not_supported");
  assert.equal(internal.sessions.has(id), false);
  assert.equal((await loadAgentState(id)).task, "8-bit counter");
  const abort = await (await send(`/tasks/${id}/abort`, {})).json() as any;
  await until(() => !internal.registry.get(id).busy);
  const persisted = await loadAgentState(id);
  assert.equal(abort.aborted, true);
  assert.equal(persisted.status, "failed");
  assert.ok(persisted.endedReason?.includes("aborted"));
  hold.resolve();
  await Bun.sleep(10);
  assert.equal((await loadAgentState(id)).status, "failed");
  assert.equal((await loadAgentState(id)).task, "8-bit counter");
  StreamHub.drop(id);
});

let failures = 0;
for (const item of cases) {
  await setup();
  try {
    await item.run();
    console.log(`PASS ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await teardown();
  }
}
console.log(`${cases.length - failures} passed; ${failures} failed`);
process.exitCode = failures ? 1 : 0;
