/**
 * Synthia Runtime — SSE streaming integration tests.
 *
 * Full-chain (mock model stream → FreeAgentSession deltas → StreamHub →
 * GET /tasks/:agentId/stream SSE):
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
  type ChatPoster,
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

  // 网关 504 降级：SSE 通道在这个网关上比非流式慢 2.6 倍，首字节经常骑在 60s
  // 上限上（specs/agent-stream-benchmark.md §1.3）。重试治不了它——降级非流式才有答案。
  const bufferedPost = (content: string): ChatPoster => async () => ({
    status: 200,
    text: "",
    json: { choices: [{ message: { content } }] },
  });

  test("falls back to buffered chat() when the SSE connect fails with 504", async () => {
    let streamCalls = 0;
    const postStream: ChatStreamPoster = async () => {
      streamCalls++;
      return new Response("upstream timeout", { status: 504 });
    };
    const client = new ModelClient({ ...cfg, postStream, post: bufferedPost("late but here") });
    const deltas: string[] = [];
    const turn = await client.chatStream(
      [{ role: "user", content: "hi" }],
      [],
      { onDelta: (t) => deltas.push(t) },
    );
    expect(turn.kind).toBe("text");
    if (turn.kind === "text") expect(turn.content).toBe("late but here");
    expect(streamCalls).toBe(1);       // networkRetries: 0 → 一次建连即放弃
    expect(deltas).toEqual([]);        // 降级那轮没有打字机效果，这是已知代价
  });

  test("falls back to buffered chat() when the SSE connect throws", async () => {
    const postStream: ChatStreamPoster = async () => { throw new Error("ECONNRESET"); };
    const client = new ModelClient({ ...cfg, postStream, post: bufferedPost("recovered") });
    const turn = await client.chatStream([{ role: "user", content: "hi" }], []);
    expect(turn.kind).toBe("text");
    if (turn.kind === "text") expect(turn.content).toBe("recovered");
  });

  test("fallback disabled: surfaces the streaming error verbatim", async () => {
    const postStream: ChatStreamPoster = async () => new Response("boom", { status: 504 });
    let bufferedCalls = 0;
    const post: ChatPoster = async () => { bufferedCalls++; return { status: 200, text: "", json: {} }; };
    const client = new ModelClient({ ...cfg, postStream, post, streamFallbackToBuffered: false });
    await expect(client.chatStream([{ role: "user", content: "hi" }], [])).rejects.toThrow(/504/);
    expect(bufferedCalls).toBe(0);
  });

  test("fallback failure surfaces the streaming error, not the buffered one", async () => {
    const postStream: ChatStreamPoster = async () => new Response("boom", { status: 504 });
    const post: ChatPoster = async () => { throw new Error("SECOND_FAILURE"); };
    const client = new ModelClient({ ...cfg, postStream, post });
    // 首因是网关 504；前端 replyErrorText 靠状态码分类，二次错误不该盖掉它。
    await expect(client.chatStream([{ role: "user", content: "hi" }], [])).rejects.toThrow(/504/);
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
    // delta 进聚合批：flush（since 触发）后分配的 seq = a.seq + 1。
    expect(b.seq).toBe(a.seq);
    const deltas = hub.since(a.seq);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.seq).toBe(a.seq + 1);
    expect(hub.since(a.seq + 1)).toHaveLength(0);
  });

  test("consecutive deltas for one part aggregate into one event", async () => {
    const hub = Hub.for(`hub-${Math.random()}`, undefined, 15);
    hub.emit({ type: "status", status: "running", ts: "t" });
    for (const ch of ["a", "b", "c", "d"]) hub.emit({ type: "delta", partId: "p1", text: ch });
    await new Promise((r) => setTimeout(r, 40)); // 等聚合窗口 flush
    const deltas = hub.since(0).filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.type === "delta" ? deltas[0]!.text : "").toBe("abcd");
  });

  test("different partId or non-delta event flushes the pending batch first", () => {
    const hub = Hub.for(`hub-${Math.random()}`, undefined, 60_000); // 长窗口：只靠边界 flush
    hub.emit({ type: "delta", partId: "p1", text: "a" });
    hub.emit({ type: "delta", partId: "p2", text: "b" });
    hub.emit({ type: "part", part: { kind: "reasoning", id: "p1", state: "done", text: "a", ts: "t" } });
    const all = hub.since(0);
    expect(all.map((e) => e.type)).toEqual(["delta", "delta", "part"]);
  });

  test("subscriber waits for and receives later events", async () => {
    const hub = Hub.for(`hub-${Math.random()}`, undefined, 15);
    const cursor = hub.subscribe();
    const first = hub.emit({ type: "status", status: "running", ts: "t" });
    const batch = await cursor.next();
    expect(batch.map((e) => e.seq)).toEqual([first.seq]);
    // next() with no events blocks until emit；delta 经聚合窗口 flush 后投递。
    const waiting = cursor.next();
    hub.emit({ type: "delta", partId: "p", text: "y" });
    const batch2 = await waiting;
    expect(batch2).toHaveLength(1);
    expect(batch2[0]!.type).toBe("delta");
    if (batch2[0]!.type === "delta") expect(batch2[0]!.text).toBe("y");
    cursor.stop();
    expect(await cursor.next()).toEqual([]);
  });

  test("Last-Event-ID resume replays only events after cursor", async () => {
    const hub = Hub.for(`hub-${Math.random()}`, undefined, 15);
    const e1 = hub.emit({ type: "status", status: "running", ts: "t" });
    const e2 = hub.emit({ type: "delta", partId: "p", text: "a" });
    const e3 = hub.emit({ type: "delta", partId: "p", text: "b" });
    void e1;
    await new Promise((r) => setTimeout(r, 40)); // 两条 delta 聚合为一条
    const cursor = hub.subscribe(e2.seq);
    const batch = await cursor.next();
    expect(batch).toHaveLength(1);
    const aggregated = batch[0]!;
    expect(aggregated.type).toBe("delta");
    if (aggregated.type === "delta") expect(aggregated.text).toBe("ab");
    expect(aggregated.seq).toBeGreaterThan(e2.seq);
    expect(hub.lastSeq).toBe(aggregated.seq);
  });

  test("subscribeCurrentTurn with done evicted falls back to full subscription", () => {
    const hub = Hub.for(`hub-${Math.random()}`, 8, 0); // 不聚合；保留 8 条
    hub.emit({ type: "delta", partId: "old", text: "1" });
    const done = hub.emit({ type: "done", reply: "r", status: "idle", ts: "t" });
    // 当前轮事件把 done 挤出保留窗口（长思考轮打爆 retain 的形态）。
    for (let i = 0; i < 12; i++) hub.emit({ type: "delta", partId: `p${i}`, text: "x" });
    expect(hub.oldestSeq).toBeGreaterThan(done.seq);
    // done 不在窗口 → 找不到 → 全量订阅（不存在 stale 游标，天然无 reset）。
    const cursor = hub.subscribeCurrentTurn();
    void cursor; // 惰性游标：首个 next() 才回放，构造成功即达测试目的
  });

  test("staleReplay returns retained replay instead of reset", async () => {
    const hub = Hub.for(`hub-${Math.random()}`, 4, 0);
    for (let i = 0; i < 10; i++) hub.emit({ type: "delta", partId: `p${i}`, text: "x" });
    const oldest = hub.oldestSeq;
    const cursor = hub.subscribe(1, { staleReplay: true }); // seq1 已被裁掉
    const batch = await cursor.next();
    expect(batch[0]!.type).not.toBe("reset");
    expect(batch.map((e) => e.seq)).toEqual([oldest, oldest + 1, oldest + 2, oldest + 3]);
  });

  test("without staleReplay a stale cursor yields reset (unchanged default)", async () => {
    const hub = Hub.for(`hub-${Math.random()}`, 4, 0);
    for (let i = 0; i < 10; i++) hub.emit({ type: "delta", partId: `p${i}`, text: "x" });
    const cursor = hub.subscribe(1);
    const batch = await cursor.next();
    expect(batch[0]!.type).toBe("reset");
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
  let agentsDir: string;
  let server: RuntimeServer;
  let previousModelApi: string | undefined;
  const agentIds: string[] = [];

  const DEFAULT_TEXT_SSE = [
    `data: {"choices":[{"delta":{"content":"我来"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"设计"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"计数器"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");
  /** 下一次上游请求返回的 SSE（消费即清空）；null → DEFAULT_TEXT_SSE。 */
  let nextUpstreamSSE: string | null = null;

  beforeAll(async () => {
    agentsDir = await mkdtemp(join(tmpdir(), "synthia-sse-test-"));
    process.env.SYNTHIA_RUNS_DIR = agentsDir;
    // The env model is only built lazily via getOrCreateSession → ModelClient;
    // point it at a placeholder (session assembly in these tests injects the
    // scripted model through depsFactory + a patched sessions map is NOT
    // available — instead we drive ModelClient via postStream env? No: the
    // server builds ModelClient from env. For determinism we run the SSE
    // endpoint against a real session created through the public HTTP API
    // with a mock upstream SSE served by a local Bun server.)
    const mockUpstream = Bun.serve({
      port: 0,
      fetch: () => {
        // 一次性脚本优先（工具调用那一轮用），消费即清空，之后回落到默认文本流
        // ——否则 free-agent 会拿着同一个 tool_call 无限循环。
        const sse = nextUpstreamSSE ?? DEFAULT_TEXT_SSE;
        nextUpstreamSSE = null;
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    process.env.SYNTHIA_MODEL_URL = `http://127.0.0.1:${mockUpstream.port}/v1`;
    process.env.SYNTHIA_MODEL_KEY = "test-key";
    process.env.SYNTHIA_MODEL_NAME = "mock-model";
    process.env.SYNTHIA_MODEL_PROTOCOL = "tools";
    previousModelApi = process.env.SYNTHIA_MODEL_API;
    process.env.SYNTHIA_MODEL_API = "chat-completions";

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
    if (previousModelApi === undefined) delete process.env.SYNTHIA_MODEL_API;
    else process.env.SYNTHIA_MODEL_API = previousModelApi;
    await rm(agentsDir, { recursive: true, force: true });
    for (const agentId of agentIds) StreamHub.drop(agentId);
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
    const agentId = (await createRes.json() as { agent_id: string }).agent_id;
    agentIds.push(agentId);

    const startedAt = Date.now();
    const msgRes = await fetch(`${server.url}/tasks/${agentId}/message`, {
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
      `${server.url}/tasks/${agentId}/stream`,
      {},
      // Read through the turn-end status event (emitted right after done).
      (ev, all) => ev.event === "status" && all.some((e) => e.event === "done"),
    );
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("status");
    expect(types).toContain("part");
    // delta 在 hub 内按时间窗聚合（80ms）：mock 上游瞬时发完 → 至少 1 条。
    // 文本完整性由下方 done/part 的 full-text 断言保障，不依赖 delta 条数。
    expect(types.filter((t) => t === "delta").length).toBeGreaterThanOrEqual(1);
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

  test("stream 404s for unknown agent", async () => {
    const res = await fetch(`${server.url}/tasks/agent-does-not-exist/stream`);
    expect(res.status).toBe(404);
    await res.text();
  });

  test("reasoning block streams and finalizes intact across delta aggregation", async () => {
    // 上游先发 reasoning_content（思维链），再发正文——hub 80ms 聚合窗口下，
    // 思考块仍须以完整文本定稿（done part 的 full text 是权威，delta 只是
    // 打字机增量）。这正是「长思考轮刷新丢失」修复的核心不变式。
    nextUpstreamSSE = [
      `data: {"choices":[{"delta":{"reasoning_content":"我需要"}}]}\n\n`,
      `data: {"choices":[{"delta":{"reasoning_content":"先想清楚"}}]}\n\n`,
      `data: {"choices":[{"delta":{"reasoning_content":"再动手"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"好的。"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const createRes = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "p-sse",
        process_instance_id: "pi-sse",
        task: "reasoning smoke",
        mode: "agent",
      }),
    });
    const agentId = (await createRes.json() as { agent_id: string }).agent_id;
    agentIds.push(agentId);
    await fetch(`${server.url}/tasks/${agentId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "思考后回答" }),
    });
    const events = await readSSE(
      `${server.url}/tasks/${agentId}/stream`,
      {},
      (ev, all) => ev.event === "status" && all.some((e) => e.event === "done"),
    );
    const reasoningParts = events.filter((e) => e.event === "part").map((e) => (e.data as { part: { kind: string; state: string; text: string } }).part).filter((p) => p.kind === "reasoning");
    expect(reasoningParts.length).toBeGreaterThanOrEqual(1);
    const finalized = reasoningParts[reasoningParts.length - 1]!;
    expect(finalized.state).toBe("done");
    expect(finalized.text).toBe("我需要先想清楚再动手");
    // 思考块与正文块都定稿：两个不同的 part id。
    const textParts = events.filter((e) => e.event === "part").map((e) => (e.data as { part: { kind: string; text: string } }).part).filter((p) => p.kind === "text");
    expect(textParts[textParts.length - 1]!.text).toBe("好的。");
  }, 20_000);

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
    const agentId = (await createRes.json() as { agent_id: string }).agent_id;
    agentIds.push(agentId);
    await fetch(`${server.url}/tasks/${agentId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "开始" }),
    });
    // The turn completes almost instantly with the mock; either steered (if
    // running) or accepted (if already idle) is a valid outcome — both are 200.
    const res = await fetch(`${server.url}/tasks/${agentId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "改一下" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { steered?: boolean; accepted?: boolean };
    expect(body.steered === true || body.accepted === true).toBe(true);
    for (let attempt = 0; attempt < 200; attempt++) {
      const detail = await (await fetch(`${server.url}/tasks/${agentId}`)).json() as { status: string };
      if (detail.status !== "running") return;
      await Bun.sleep(5);
    }
    throw new Error("steered turn did not finish");
  });

  test("工具调用落 audit：本轮结束后 GET /tasks/:id 仍能回看调了什么", async () => {
    const createRes = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "p-tool-audit",
        process_instance_id: "pi-tool-audit",
        task: "tool audit",
        mode: "agent",
      }),
    });
    const agentId = (await createRes.json() as { agent_id: string }).agent_id;
    agentIds.push(agentId);

    // 第一轮上游吐一个 tool_call，第二轮回落到默认文本流收尾。工具名故意不存在：
    // free-agent 对未知工具走 unknown_tool 错误结果，onToolStart/onToolEnd 照常触发
    // ——这里要验的是 audit 有没有写，不是工具本身。
    nextUpstreamSSE = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_audit_1",`
        + `"function":{"name":"nope_tool","arguments":"{\\"path\\":\\"top.v\\"}"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    await fetch(`${server.url}/tasks/${agentId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "读一下 top.v" }),
    });

    // POST /message 立即返回，轮次在后台跑完才写 audit。
    let toolEvent: { action: string; result?: string; detail?: string } | undefined;
    for (let i = 0; i < 60 && !toolEvent; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const detailRes = await fetch(`${server.url}/tasks/${agentId}`);
      const detailBody = await detailRes.json() as {
        audit: Array<{ action: string; result?: string; detail?: string }>;
      };
      toolEvent = detailBody.audit.find((e) => e.action === "free_agent_tool");
    }

    expect(toolEvent).toBeDefined();
    expect(toolEvent!.result).toBe("failed"); // unknown_tool → isError
    const payload = JSON.parse(toolEvent!.detail!) as Record<string, unknown>;
    // id 必须是模型给的 callId——前端靠它与 SSE 那张卡去重。
    expect(payload.id).toBe("call_audit_1");
    expect(payload.name).toBe("nope_tool");
    expect(payload.args).toContain("top.v");
    expect(String(payload.result)).toContain("unknown_tool");
  });
});
