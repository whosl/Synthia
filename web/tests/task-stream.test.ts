/**
 * task-stream.ts 单测（spec §5.1：SSE 订阅 + 断线退避 + Last-Event-ID 续传，
 * 此前零覆盖，本文件补上）。`streaming.test.ts` 已覆盖 `parseSSEFrames` 的基础
 * 帧解析与 `applyStreamEvent` 的状态归并，本文件聚焦其未覆盖的部分：
 * - `parseSSEFrames` 多帧粘包（一次拿到的字节里含多条完整帧）拆分；
 * - `applyStreamEvent` 对 status/done 类事件的处理（原样透传，不影响 feed）；
 * - `applyStreamEvent` 对过程 part 的归并：reasoning（思考过程，与 text 同构、
 *   delta 按 id 追加）与 tool（Agent 工具调用，定稿事件只带 result，name/args
 *   沿用 running 事件）；
 * - `subscribeTaskStream` 端到端：跨网络分片（chunk 边界与帧边界不对齐）时的
 *   帧重组、五种事件类型（status/part/delta/done/reset）的分发、以及断线重连
 *   携带 Last-Event-ID 续传游标。
 */
import { describe, expect, test } from "bun:test";
import {
  applyStreamEvent,
  parseSSEFrames,
  subscribeTaskStream,
  type StreamFeedEvent,
  type StreamFeedPart,
  type StreamPhase,
} from "../src/domain/task-stream.ts";

// ─── parseSSEFrames：多帧粘包拆分 ───────────────────────────────────────

describe("parseSSEFrames（多帧粘包拆分）", () => {
  test("一个 chunk 内含三条完整帧（part/delta/status）→ 按顺序全部解析", () => {
    const chunk =
      "event: part\nid: 1\ndata: {\"part\":{\"kind\":\"text\",\"id\":\"sp-1\",\"state\":\"streaming\",\"text\":\"\"}}\n\n" +
      "event: delta\nid: 2\ndata: {\"partId\":\"sp-1\",\"text\":\"你好\"}\n\n" +
      "event: status\nid: 3\ndata: {\"status\":\"running\"}\n\n";
    const frames = parseSSEFrames(chunk);
    expect(frames.map((f) => f.event)).toEqual(["part", "delta", "status"]);
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  test("心跳注释帧穿插在多帧之间不产生解析结果，也不打断后续帧", () => {
    const chunk = ": hb\n\nevent: done\nid: 9\ndata: {\"reply\":\"ok\"}\n\n: hb\n\nevent: reset\nid: 10\ndata: {}\n\n";
    const frames = parseSSEFrames(chunk);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.event).toBe("done");
    expect(frames[1]!.event).toBe("reset");
  });

  test("末尾半条帧（缺 JSON 收尾，无结尾 \\n\\n）不抛错：data 解析失败时安全降级为 null", () => {
    // 帧的边界拼接（跨 chunk 重组）是 subscribeTaskStream 内部 carry 缓冲区的职责
    // （只把 indexOf(\"\\n\\n\") 之前的完整帧喂给 parseSSEFrames，见下方端到端用例）；
    // parseSSEFrames 本身对不完整帧的容错只保证「不抛错」，不保证丢弃。
    const chunk = "event: part\nid: 1\ndata: {\"part\":{\"kind\":\"text\",\"id\":\"sp-1\",\"state\":\"done\",\"text\":\"a\"}}\n\nevent: delta\nid: 2\ndata: {";
    const frames = parseSSEFrames(chunk);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.event).toBe("part");
    expect(frames[1]!.event).toBe("delta");
    expect(frames[1]!.data).toBeNull(); // 不完整 JSON 解析失败，安全降级
  });
});

// ─── applyStreamEvent：status/done 事件的归并语义 ───────────────────────

describe("applyStreamEvent（status/done 事件透传，不影响 feed 内容）", () => {
  test("status 事件不改变现有 streaming feed", () => {
    let feed: StreamFeedPart[] = [{ kind: "text", id: "sp-1", state: "streaming", text: "在跑" }];
    const next = applyStreamEvent(feed, { type: "status", status: "running" });
    expect(next).toEqual(feed);
    expect(next).not.toBe(feed); // 仍返回新数组（纯函数惯例，不复用引用）
  });

  test("done 事件不清空 feed（清空由 ProjectView 收到 done 后触发 refresh 决定，不是本函数职责）", () => {
    let feed: StreamFeedPart[] = [{ kind: "text", id: "sp-1", state: "done", text: "完成" }];
    const next = applyStreamEvent(feed, { type: "done", reply: "完成" });
    expect(next).toEqual(feed);
  });

  test("reset 事件清空 feed（游标过老，全量刷新兜底）", () => {
    const feed: StreamFeedPart[] = [{ kind: "text", id: "sp-1", state: "streaming", text: "x" }];
    expect(applyStreamEvent(feed, { type: "reset" })).toEqual([]);
  });
});

// ─── applyStreamEvent：过程 part（思考过程 / Agent 工具调用）────────────

describe("applyStreamEvent（reasoning 思考过程 part）", () => {
  test("reasoning part 与 text part 同构：delta 按 partId 追加，两条流互不串味", () => {
    let feed: StreamFeedPart[] = [];
    feed = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "reasoning", id: "rs-1", state: "streaming", text: "" },
    });
    feed = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "text", id: "sp-1", state: "streaming", text: "" },
    });
    feed = applyStreamEvent(feed, { type: "delta", partId: "rs-1", text: "先看时钟域" });
    feed = applyStreamEvent(feed, { type: "delta", partId: "sp-1", text: "结论：" });
    feed = applyStreamEvent(feed, { type: "delta", partId: "rs-1", text: "，再算裕量" });

    expect(feed).toEqual([
      { kind: "reasoning", id: "rs-1", state: "streaming", text: "先看时钟域，再算裕量" },
      { kind: "text", id: "sp-1", state: "streaming", text: "结论：" },
    ]);
  });

  test("reasoning 定稿事件按 id 覆盖为 done（后续 delta 因不再 streaming 被忽略）", () => {
    let feed: StreamFeedPart[] = [{ kind: "reasoning", id: "rs-1", state: "streaming", text: "思考中" }];
    feed = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "reasoning", id: "rs-1", state: "done", text: "思考中" },
    });
    expect(feed).toEqual([{ kind: "reasoning", id: "rs-1", state: "done", text: "思考中" }]);

    feed = applyStreamEvent(feed, { type: "delta", partId: "rs-1", text: "迟到的增量" });
    expect(feed[0]).toMatchObject({ text: "思考中" });
  });
});

describe("applyStreamEvent（agent 工具调用 part）", () => {
  test("running → done：定稿事件不带 name/args 时沿用 running 事件的字段，只补 result", () => {
    let feed: StreamFeedPart[] = [];
    feed = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "tool", id: "fc-1", state: "running", name: "core_check_gate", args: "{\"gate\":\"G1\"}" },
    });
    expect(feed).toEqual([
      { kind: "tool", id: "fc-1", state: "running", name: "core_check_gate", args: "{\"gate\":\"G1\"}", result: null },
    ]);

    // 服务端只在 running 事件里带一次 name/args（见 runtime/free-agent.ts）。
    feed = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "tool", id: "fc-1", state: "done", result: "{\"status\":\"in_review\"}" },
    });
    expect(feed).toEqual([
      {
        kind: "tool",
        id: "fc-1",
        state: "done",
        name: "core_check_gate",
        args: "{\"gate\":\"G1\"}",
        result: "{\"status\":\"in_review\"}",
      },
    ]);
  });

  test("工具报错：state=error 保留 name/args，供失败卡默认展开", () => {
    let feed: StreamFeedPart[] = [
      { kind: "tool", id: "fc-1", state: "running", name: "vivado_run", args: "{}", result: null },
    ];
    feed = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "tool", id: "fc-1", state: "error", result: "connector timeout" },
    });
    expect(feed[0]).toEqual({
      kind: "tool",
      id: "fc-1",
      state: "error",
      name: "vivado_run",
      args: "{}",
      result: "connector timeout",
    });
  });

  test("delta 永不落到工具 part 上（工具结果整条下发，没有 token 级增量）", () => {
    const feed: StreamFeedPart[] = [
      { kind: "tool", id: "fc-1", state: "running", name: "core_check_gate", args: "{}", result: null },
    ];
    expect(applyStreamEvent(feed, { type: "delta", partId: "fc-1", text: "xx" })).toEqual(feed);
  });

  test("未知 kind 的 part 被忽略（服务端新增一种 part 不会污染流）", () => {
    const feed: StreamFeedPart[] = [{ kind: "text", id: "sp-1", state: "streaming", text: "a" }];
    const next = applyStreamEvent(feed, {
      type: "part",
      part: { kind: "future_kind", id: "x-1", state: "streaming" },
    });
    expect(next).toEqual(feed);
  });
});

// ─── subscribeTaskStream：端到端（mock fetch + ReadableStream）──────────

/** 把若干字符串片段封装成一个 ReadableStream<Uint8Array>，模拟网络分片到达。 */
function sseBodyFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

/** 临时替换 globalThis.fetch，测试结束后自动恢复（避免污染其它测试文件）。 */
async function withMockFetch<T>(
  impl: (url: string, init: RequestInit | undefined) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function fakeResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

describe("subscribeTaskStream（跨 chunk 边界的帧重组 + 事件分发 + 续传）", () => {
  test("帧被拆成多个网络分片到达时仍正确重组并按序分发五种事件类型", async () => {
    await withMockFetch(
      async () =>
        fakeResponse(
          sseBodyFromChunks([
            "event: status\nid: 1\ndata: {\"stat", // 帧被从中间切断
            "us\":\"running\"}\n\nevent: part\nid: 2\ndata: {\"part\":{\"kind\":\"text\",\"id\":\"sp-1\",",
            "\"state\":\"streaming\",\"text\":\"\"}}\n\n",
            "event: delta\nid: 3\ndata: {\"partId\":\"sp-1\",\"text\":\"你好\"}\n\n",
            "event: done\nid: 4\ndata: {\"reply\":\"你好\"}\n\n",
            "event: reset\nid: 5\ndata: {}\n\n",
          ]),
        ),
      async () => {
        const events: StreamFeedEvent[] = [];
        const phases: StreamPhase[] = [];
        const handle = subscribeTaskStream("http://test/stream", null, 0, {
          onEvent: (ev) => events.push(ev),
          onPhase: (p) => phases.push(p),
        });

        // 等待 pull()/reader 循环把全部分片消费完（微任务链，轮询等待即可）。
        for (let i = 0; i < 50 && events.length < 5; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        handle.close();

        expect(events.map((e) => e.type)).toEqual(["status", "part", "delta", "done", "reset"]);
        const statusEv = events[0];
        if (statusEv?.type === "status") expect(statusEv.status).toBe("running");
        const deltaEv = events[2];
        if (deltaEv?.type === "delta") {
          expect(deltaEv.partId).toBe("sp-1");
          expect(deltaEv.text).toBe("你好");
        }
        expect(phases[0]).toBe("connecting");
        expect(phases).toContain("live");
      },
    );
  });

  test("Last-Event-ID 续传：断线重连后携带迄今为止见过的最大 id", async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    let callCount = 0;

    await withMockFetch(
      async (_url, init) => {
        callCount++;
        calls.push(init?.headers as Record<string, string> | undefined);
        if (callCount === 1) {
          // 首次连接：吐出一条 id=7 的事件后正常结束（服务端 keepalive 断开）。
          return fakeResponse(sseBodyFromChunks(["event: status\nid: 7\ndata: {\"status\":\"running\"}\n\n"]));
        }
        // 第二次连接（重连）：不再产出数据，测试到这里即可收尾。
        return fakeResponse(sseBodyFromChunks([]));
      },
      async () => {
        const handle = subscribeTaskStream("http://test/stream", "tok-abc", 0, {
          onEvent: () => {},
          onPhase: () => {},
        });

        // 第一次连接没有 last-event-id 头（初始游标为 0）。
        for (let i = 0; i < 50 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
        expect(calls[0]?.["last-event-id"]).toBeUndefined();
        expect(calls[0]?.["authorization"]).toBe("Bearer tok-abc");

        // 等待断线退避重连（BASE_BACKOFF_MS=1000ms）触发第二次连接。
        for (let i = 0; i < 200 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        handle.close();

        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls[1]?.["last-event-id"]).toBe("7");
      },
    );
  }, 6000);
});
