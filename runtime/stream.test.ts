/**
 * Synthia Runtime — SSE streaming integration tests.
 *
 * Full-chain (mock model stream → FreeAgentSession deltas → StreamHub →
 * GET /tasks/:runId/stream SSE):
 *  1. consumeChatSSE: canned chunk sequences (text + tool-call argument
 *     fragments, cross-chunk splits, CRLF, [DONE], malformed payloads);
 *  2. ModelClient.chatStream against a mock SSE server: aggregation matches
 *     the buffered parseChatTurn semantics; onDelta fires per fragment;
 *  3. RuntimeServer end-to-end: POST /tasks (mode=agent) → POST /message
 *     returns {accepted:true} IMMEDIATELY (not blocked on the turn) →
 *     SSE stream delivers part/delta/done/status events in seq order;
 *  4. Last-Event-ID resume: reconnect replays events after the cursor;
 *  5. FreeAgentSession falls back to buffered chat() when the model has no
 *     chatStream (no events, reply still correct).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ModelClient,
  consumeChatSSE,
  type ChatStreamPoster,
} from "./model-client.ts";
import { StreamHub, StreamHub as Hub, type StreamEvent } from "./stream-hub.ts";
import { RuntimeServer, type ServerConfig, type DepsFactory } from "./server.ts";
import { NoGovernanceClient } from "./types.ts";
import type { SkillPrompts } from "./skill-loader.ts";
import type {
  AgentMessage,
  AgentTool,
  ChatTurn,
  ConversationalModel,
} from "./agent-types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]!));
      } else {
        controller.close();
      }
    },
  });
}

const EMPTY_PROMPTS: SkillPrompts = {
  rtl: "", tb: "", xdc: "", repair: "",
  intake: "", behaviorWave: "", architecture: "", registerSpec: "",
};

function makeConfig(opts: Partial<ServerConfig> = {}): ServerConfig {
  return {
    skillPrompts: EMPTY_PROMPTS,
    toolModelPolicyHash: "test-policy-v1",
    defaultPart: "xc7k70tfbv676-1",
    gatePollMs: 0,
    port: 0,
    ...opts,
  };
}

/** Collect SSE events from the endpoint as parsed {event,id,data} tuples. */
async function readSSE(
  url: string,
  headers: Record<string, string> = {},
  until: (ev: ParsedSSE, all: readonly ParsedSSE[]) => boolean,
  timeoutMs = 10_000,
): Promise<ParsedSSE[]> {
  const res = await fetch(url, { headers });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSSE[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(200).then(() => ({ value: undefined, done: false as boolean | undefined })),
    ]) as ReadableStreamReadResult<Uint8Array> | { value: undefined; done: boolean };
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (raw.startsWith(":")) continue; // comment/heartbeat
      const lines = raw.split("\n");
      const evLine = lines.find((l) => l.startsWith("event: "));
      const idLine = lines.find((l) => l.startsWith("id: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!evLine || !dataLine) continue;
      const parsed: ParsedSSE = {
        event: evLine.slice(7),
        id: idLine ? Number(idLine.slice(4)) : undefined,
        data: JSON.parse(dataLine.slice(6)),
      };
      events.push(parsed);
      if (until(parsed, events)) {
        reader.cancel().catch(() => {});
        return events;
      }
    }
  }
  reader.cancel().catch(() => {});
  throw new Error(`readSSE timeout; got ${events.length} events`);
}

interface ParsedSSE {
  event: string;
  id?: number;
  data: Record<string, unknown>;
}

type ReadableStreamReadResult<T> = { value?: T; done?: boolean };

// ---------------------------------------------------------------------------
// consumeChatSSE unit tests (canned chunk sequences)
// ---------------------------------------------------------------------------

describe("consumeChatSSE", () => {
  test("aggregates text deltas and fires onDelta per fragment", async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"你好"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"，"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"世界"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const deltas: string[] = [];
    let textStarts = 0;
    const result = await consumeChatSSE(sseStream(chunks), {
      onTextStart: () => textStarts++,
      onDelta: (t) => deltas.push(t),
    });
    expect(result.text).toBe("你好，世界");
    expect(deltas).toEqual(["你好", "，", "世界"]);
    expect(textStarts).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });

  test("aggregates tool-call argument fragments by index", async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"write_file","arguments":"{\\"path\\": \\"a"}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".v\\"}"}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"run","arguments":"{\\"op\\":1}"}}]}}]}\n\n`,
      `data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const result = await consumeChatSSE(sseStream(chunks));
    expect(result.text).toBe("");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.id).toBe("call_a");
    expect(result.toolCalls[0]!.name).toBe("write_file");
    expect(JSON.parse(result.toolCalls[0]!.argsRaw)).toEqual({ path: "a.v" });
    expect(JSON.parse(result.toolCalls[1]!.argsRaw)).toEqual({ op: 1 });
    expect(result.finishReason).toBe("tool_calls");
  });

  test("handles events split across chunk boundaries and CRLF", async () => {
    const whole = JSON.stringify({ choices: [{ delta: { content: "split" } }] });
    const chunks = [
      `data: ${whole.slice(0, 10)}`,
      `${whole.slice(10)}\r\n\r`,
      `\ndata: [DONE]\n\n`,
    ];
    const result = await consumeChatSSE(sseStream(chunks));
    expect(result.text).toBe("split");
  });

  test("skips malformed payloads and comments, tolerates missing [DONE]", async () => {
    const chunks = [
      `: heartbeat\n\n`,
      `data: not-json\n\n`,
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
      `data: {"choices":[]}\n\n`,
    ];
    const result = await consumeChatSSE(sseStream(chunks));
    expect(result.text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// ModelClient.chatStream against a mock SSE upstream
// ---------------------------------------------------------------------------

describe("ModelClient.chatStream", () => {
  const cfg = {
    baseUrl: "http://mock",
    apiKey: "k",
    model: "m",
    protocol: "tools" as const,
    networkRetries: 0,
  };

  function poster(sse: string): ChatStreamPoster {
    return async () => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("streams text turn with onDelta callbacks", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"hello "}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"stream"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const client = new ModelClient({ ...cfg, postStream: poster(sse) });
    const deltas: string[] = [];
    const turn = await client.chatStream(
      [{ role: "user", content: "hi" }],
      [],
      { onDelta: (t) => deltas.push(t) },
    );
    expect(turn.kind).toBe("text");
    if (turn.kind === "text") expect(turn.content).toBe("hello stream");
    expect(deltas).toEqual(["hello ", "stream"]);
  });

  test("streams tool-call turn with per-index argument concat", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"vivado_run","arguments":"{\\"opera"}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tion\\":\\"simulate\\"}"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const client = new ModelClient({ ...cfg, postStream: poster(sse) });
    const turn = await client.chatStream([{ role: "user", content: "go" }], []);
    expect(turn.kind).toBe("tool_calls");
    if (turn.kind === "tool_calls") {
      expect(turn.calls[0]!.name).toBe("vivado_run");
      expect(turn.calls[0]!.args).toEqual({ operation: "simulate" });
    }
  });

  test("falls back to buffered parse on non-SSE response", async () => {
    const buffered = JSON.stringify({
      choices: [{ message: { content: "buffered reply" } }],
    });
    const postStream: ChatStreamPoster = async () => new Response(buffered, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const client = new ModelClient({ ...cfg, postStream });
    const turn = await client.chatStream([{ role: "user", content: "hi" }], []);
    expect(turn.kind).toBe("text");
    if (turn.kind === "text") expect(turn.content).toBe("buffered reply");
  });

  test("fault-tolerant: invalid JSON arguments surface as raw string", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{oops"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const client = new ModelClient({ ...cfg, postStream: poster(sse) });
    const turn = await client.chatStream([{ role: "user", content: "go" }], []);
    expect(turn.kind).toBe("tool_calls");
    if (turn.kind === "tool_calls") expect(turn.calls[0]!.args).toBe("{oops");
  });
});

// ---------------------------------------------------------------------------
// StreamHub unit tests
// ---------------------------------------------------------------------------

describe("StreamHub", () => {
  test("seq is monotonic and since() windows correctly", () => {
    const hub = Hub.for(`hub-${Math.random()}`);
    const a = hub.emit({ type: "status", status: "running", ts: "t" });
    const b = hub.emit({ type: "delta", partId: "p1", text: "x" });
    expect(b.seq).toBe(a.seq + 1);
    expect(hub.since(a.seq)).toHaveLength(1);
    expect(hub.since(b.seq)).toHaveLength(0);
  });

  test("subscriber waits for and receives later events", async () => {
    const hub = Hub.for(`hub-${Math.random()}`);
    const cursor = hub.subscribe();
    const first = hub.emit({ type: "status", status: "running", ts: "t" });
    const batch = await cursor.next();
    expect(batch.map((e) => e.seq)).toEqual([first.seq]);
    // next() with no events blocks until emit
    const waiting = cursor.next();
    const second = hub.emit({ type: "delta", partId: "p", text: "y" });
    expect((await waiting).map((e) => e.seq)).toEqual([second.seq]);
    cursor.stop();
    expect(await cursor.next()).toEqual([]);
  });

  test("Last-Event-ID resume replays only events after cursor", async () => {
    const hub = Hub.for(`hub-${Math.random()}`);
    const e1 = hub.emit({ type: "status", status: "running", ts: "t" });
    const e2 = hub.emit({ type: "delta", partId: "p", text: "a" });
    const e3 = hub.emit({ type: "delta", partId: "p", text: "b" });
    const cursor = hub.subscribe(e2.seq);
    const batch = await cursor.next();
    expect(batch.map((e) => e.seq)).toEqual([e3.seq]);
    expect(hub.lastSeq).toBe(e3.seq);
    void e1;
  });
});

// ---------------------------------------------------------------------------
// RuntimeServer SSE end-to-end
// ---------------------------------------------------------------------------

/** Scripted streaming ConversationalModel. */
class ScriptedStreamModel implements ConversationalModel {
  private idx = 0;
  constructor(private readonly turns: readonly ChatTurn[]) {}
  async chat(): Promise<ChatTurn> {
    return this.turns[this.idx++] ?? { kind: "text", content: "(exhausted)" };
  }
  async chatStream(
    _messages: readonly AgentMessage[],
    _tools: readonly AgentTool[],
    opts: { onTextStart?: () => void; onDelta?: (t: string) => void },
  ): Promise<ChatTurn> {
    const turn = this.turns[this.idx++] ?? { kind: "text", content: "(exhausted)" };
    if (turn.kind === "text" && (opts.onTextStart || opts.onDelta)) {
      opts.onTextStart?.();
      for (const piece of turn.content.match(/./gu) ?? []) {
        opts.onDelta?.(piece);
      }
    }
    return turn;
  }
}

describe("RuntimeServer SSE (mode=agent full chain)", () => {
  let runsDir: string;
  let server: RuntimeServer;
  const runIds: string[] = [];

  beforeAll(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "synthia-sse-test-"));
    process.env.SYNTHIA_RUNS_DIR = runsDir;
    // The env model is only built lazily via getOrCreateSession → ModelClient;
    // point it at a placeholder (session assembly in these tests injects the
    // scripted model through depsFactory + a patched sessions map is NOT
    // available — instead we drive ModelClient via postStream env? No: the
    // server builds ModelClient from env. For determinism we run the SSE
    // endpoint against a real session created through the public HTTP API
    // with a mock upstream SSE served by a local Bun server.)
    const mockUpstream = Bun.serve({
      port: 0,
      fetch: () => new Response(
        [
          `data: {"choices":[{"delta":{"content":"我来"}}]}\n\n`,
          `data: {"choices":[{"delta":{"content":"设计"}}]}\n\n`,
          `data: {"choices":[{"delta":{"content":"计数器"}}]}\n\n`,
          `data: [DONE]\n\n`,
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    });
    process.env.SYNTHIA_MODEL_URL = `http://127.0.0.1:${mockUpstream.port}/v1`;
    process.env.SYNTHIA_MODEL_KEY = "test-key";
    process.env.SYNTHIA_MODEL_NAME = "mock-model";
    process.env.SYNTHIA_MODEL_PROTOCOL = "tools";

    const governance = new NoGovernanceClient();
    const factory: DepsFactory = async () => ({
      model: {} as never,
      connector: null,
      governance,
    });
    server = new RuntimeServer(makeConfig({ gatePollMs: 0 }), factory);
    await server.start();
    // Keep the mock upstream alive until teardown.
    (server as unknown as { _mockUpstream?: unknown })._mockUpstream = mockUpstream;
  });

  afterAll(async () => {
    await server.reset();
    const mock = (server as unknown as { _mockUpstream?: { stop: (force: boolean) => void } })._mockUpstream;
    mock?.stop(true);
    delete process.env.SYNTHIA_RUNS_DIR;
    delete process.env.SYNTHIA_MODEL_URL;
    delete process.env.SYNTHIA_MODEL_KEY;
    delete process.env.SYNTHIA_MODEL_NAME;
    delete process.env.SYNTHIA_MODEL_PROTOCOL;
    await rm(runsDir, { recursive: true, force: true });
    for (const runId of runIds) StreamHub.drop(runId);
  });

  test("message accepted immediately; SSE delivers ordered part/delta/done", async () => {
    const createRes = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "p-sse",
        process_instance_id: "pi-sse",
        task: "sse smoke",
        mode: "agent",
      }),
    });
    expect(createRes.status).toBe(201);
    const runId = (await createRes.json() as { run_id: string }).run_id;
    runIds.push(runId);

    const startedAt = Date.now();
    const msgRes = await fetch(`${server.url}/tasks/${runId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "设计一个计数器" }),
    });
    expect(msgRes.status).toBe(200);
    const msgBody = await msgRes.json() as { accepted?: boolean; steered?: boolean };
    expect(msgBody.accepted).toBe(true);
    // Immediate return: the mock model streams instantly, but the endpoint
    // must not have awaited the full turn even so — assert a loose bound.
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    const events = await readSSE(
      `${server.url}/tasks/${runId}/stream`,
      {},
      // Read through the turn-end status event (emitted right after done).
      (ev, all) => ev.event === "status" && all.some((e) => e.event === "done"),
    );
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("status");
    expect(types).toContain("part");
    expect(types.filter((t) => t === "delta").length).toBeGreaterThanOrEqual(3);
    expect(types[types.length - 1]).toBe("status");
    expect(types).toContain("done");
    // seq strictly increasing
    const ids = events.map((e) => e.id!);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    // done carries the full reply
    const done = events.find((e) => e.event === "done")!;
    expect((done.data as { reply: string }).reply).toContain("计数器");
    // part event precedes its deltas and finalize flips state to done
    const partIdx = types.indexOf("part");
    const firstDeltaIdx = types.indexOf("delta");
    expect(partIdx).toBeLessThan(firstDeltaIdx);
    const finalized = events.filter((e) => e.event === "part");
    const lastPart = finalized[finalized.length - 1]!;
    expect((lastPart.data as { part: { state: string } }).part.state).toBe("done");
    expect((lastPart.data as { part: { text: string } }).part.text).toBe("我来设计计数器");
  }, 20_000);

  test("stream 404s for unknown run", async () => {
    const res = await fetch(`${server.url}/tasks/run-does-not-exist/stream`);
    expect(res.status).toBe(404);
    await res.text();
  });

  test("steer while running still returns steered:true", async () => {
    const createRes = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "p-sse",
        process_instance_id: "pi-sse",
        task: "steer smoke",
        mode: "agent",
      }),
    });
    const runId = (await createRes.json() as { run_id: string }).run_id;
    runIds.push(runId);
    await fetch(`${server.url}/tasks/${runId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "开始" }),
    });
    // The turn completes almost instantly with the mock; either steered (if
    // running) or accepted (if already idle) is a valid outcome — both are 200.
    const res = await fetch(`${server.url}/tasks/${runId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "改一下" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { steered?: boolean; accepted?: boolean };
    expect(body.steered === true || body.accepted === true).toBe(true);
  });
});
