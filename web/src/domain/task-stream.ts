/**
 * 任务 SSE 订阅（打字机数据源）。
 *
 * 订阅 GET /api/v1/projects/:id/tasks/:agentId/stream（Core 透传 Runtime SSE）。
 * 说明：Core 鉴权为 Bearer 头，而原生 EventSource 无法携带自定义头，故用
 * fetch + ReadableStream 解析同构的 SSE 字节流（事件语义与 EventSource 完全
 * 一致：event/id/data 字段），断线用指数退避重连（Last-Event-ID 续传），
 * 连续 3 次失败降级纯轮询并给出提示文案。
 *
 * 输出喂给 `StreamingFeed`（流式 part 状态）：
 * - part   → upsert 流式 part（text 回复正文 / reasoning 思考过程 / tool 工具调用）；
 * - delta  → 追加文本到对应 part（text 与 reasoning 通用）；
 * - status → 会话状态（前端据此刷新 detail 轮询）；
 * - done   → 整轮完成（触发一次全量 refresh 对齐 audit）；
 * - reset  → 游标过老：丢弃本地流式状态，全量刷新。
 */

/** Agent 回复正文的流式 part。 */
export interface StreamFeedReplyPart {
  readonly kind: "text";
  readonly id: string;
  readonly state: "streaming" | "done";
  readonly text: string;
}

/** 思考过程（模型思维链）的流式 part：与回复正文同构，只差 kind。 */
export interface StreamFeedReasoningPart {
  readonly kind: "reasoning";
  readonly id: string;
  readonly state: "streaming" | "done";
  readonly text: string;
}

/**
 * 文本型流式 part（delta 追加的目标）。
 *
 * 拆成两个 kind 各自独立的接口、再并起来，而不是写成
 * `{ kind: "text" | "reasoning" }`：后者不是判别联合，`Extract<StreamFeedPart,
 * { kind: "text" }>` 会解析成 `never`，调用方按 kind 收窄全部失效。
 */
export type StreamFeedTextPart = StreamFeedReplyPart | StreamFeedReasoningPart;

/** 工具调用流式 part（free-agent 自身的 tool_calls，实时三态）。 */
export interface StreamFeedToolPart {
  readonly kind: "tool";
  readonly id: string;
  readonly state: "running" | "done" | "error";
  readonly name: string;
  readonly args: string;
  readonly result: string | null;
}

export type StreamFeedPart = StreamFeedTextPart | StreamFeedToolPart;

/** 服务端 part 事件载荷（宽松形态：按 kind 取用对应字段）。 */
export interface StreamWirePart {
  readonly kind: string;
  readonly id: string;
  readonly state: string;
  readonly text?: string;
  readonly name?: string;
  readonly args?: string;
  readonly result?: string | null;
}

export type StreamFeedEvent =
  | { type: "part"; part: StreamWirePart }
  | { type: "delta"; partId: string; text: string }
  | { type: "status"; status: string }
  | { type: "done"; reply: string }
  | { type: "reset"; reason?: string }
  /** 未知事件名：忽略（不能当成 reset，否则服务端新增一种事件就会清空整条流）。 */
  | { type: "unknown" };

export type StreamPhase = "connecting" | "live" | "degraded";

export interface StreamCallbacks {
  onEvent: (ev: StreamFeedEvent) => void;
  onPhase: (phase: StreamPhase) => void;
}

export interface StreamHandle {
  close(): void;
}

const MAX_FAILURES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

/** 解析一段 SSE 文本为事件（导出供单测：帧解析与字段提取）。 */
export function parseSSEFrames(chunk: string): Array<{ event: string; id?: number; data: unknown }> {
  const out: Array<{ event: string; id?: number; data: unknown }> = [];
  for (const frame of chunk.split("\n\n")) {
    if (frame === "" || frame.startsWith(":")) continue;
    const lines = frame.split("\n");
    const evLine = lines.find((l) => l.startsWith("event: "));
    const idLine = lines.find((l) => l.startsWith("id: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!evLine || !dataLine) continue;
    let data: unknown = null;
    try { data = JSON.parse(dataLine.slice(6)); } catch { data = null; }
    out.push({ event: evLine.slice(7), id: idLine ? Number(idLine.slice(4)) : undefined, data });
  }
  return out;
}

/** fetch-based SSE 订阅（带重连与降级）。返回句柄供组件卸载时关闭。 */
export function subscribeTaskStream(
  url: string,
  token: string | null,
  lastEventId: number,
  cb: StreamCallbacks,
): StreamHandle {
  let closed = false;
  let failures = 0;
  let cursor = lastEventId;
  const controller = new AbortController();

  const scheduleReconnect = (): void => {
    if (closed) return;
    failures++;
    // 连续失败达上限：报降级（轮询兜底接管），但仍以最大退避继续重试——
    // 永久放弃会让一次网络抖动把整个会话的流式输出关掉，直到用户手动刷新。
    if (failures === MAX_FAILURES) cb.onPhase("degraded");
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
    setTimeout(() => void pump(), backoff);
  };

  const pump = async (): Promise<void> => {
    if (closed) return;
    try {
      const res = await fetch(url, {
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cursor > 0 ? { "last-event-id": String(cursor) } : {}),
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
      failures = 0;
      cb.onPhase("live");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = carry.indexOf("\n\n")) >= 0) {
          const frame = carry.slice(0, idx);
          carry = carry.slice(idx + 2);
          const [parsed] = parseSSEFrames(frame);
          if (!parsed) continue;
          if (typeof parsed.id === "number" && parsed.id > cursor) cursor = parsed.id;
          cb.onEvent(toFeedEvent(parsed));
        }
      }
      // 服务端正常收流（idle 保活断开）→ 重连。
      scheduleReconnect();
    } catch {
      if (closed) return;
      scheduleReconnect();
    }
  };

  cb.onPhase("connecting");
  void pump();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}

function toFeedEvent(parsed: { event: string; data: unknown }): StreamFeedEvent {
  const d = (parsed.data ?? {}) as Record<string, unknown>;
  switch (parsed.event) {
    case "part":
      return { type: "part", part: d.part as StreamWirePart };
    case "delta":
      return { type: "delta", partId: String(d.partId ?? ""), text: String(d.text ?? "") };
    case "status":
      return { type: "status", status: String(d.status ?? "") };
    case "done":
      return { type: "done", reply: String(d.reply ?? "") };
    case "reset":
      return { type: "reset", reason: typeof d.reason === "string" ? d.reason : undefined };
    default:
      // 认不出的事件名一律忽略。以前这里 fallthrough 到 reset，等于「服务端多发
      // 一种事件 → 前端清空整条流」，是个隐藏的向前兼容陷阱。
      return { type: "unknown" };
  }
}

/**
 * 流式 part 状态归并（纯函数，导出供单测）：
 * - part(upsert) 按 id 替换（state done 定稿）；tool 的定稿事件不带 name/args，
 *   沿用已有 part 的字段（服务端只在 running 事件里带一次）；
 * - delta 追加到对应 streaming 文本 part（找不到目标时忽略：早于订阅的增量由轮询补齐）；
 * - reset 清空（全量刷新）；unknown 原样返回。
 */
export function applyStreamEvent(feed: readonly StreamFeedPart[], ev: StreamFeedEvent): StreamFeedPart[] {
  switch (ev.type) {
    case "reset":
      return [];
    case "part": {
      const p = ev.part;
      if (!p || typeof p.id !== "string") return [...feed];
      const idx = feed.findIndex((f) => f.id === p.id);
      const prev = idx >= 0 ? feed[idx] : undefined;
      let next: StreamFeedPart;
      if (p.kind === "tool") {
        const prevTool = prev?.kind === "tool" ? prev : undefined;
        next = {
          kind: "tool",
          id: p.id,
          state: (p.state === "done" || p.state === "error" ? p.state : "running"),
          name: p.name || prevTool?.name || "",
          args: p.args || prevTool?.args || "",
          result: p.result ?? prevTool?.result ?? null,
        };
      } else if (p.kind === "text" || p.kind === "reasoning") {
        next = {
          kind: p.kind,
          id: p.id,
          state: p.state === "done" ? "done" : "streaming",
          text: p.text ?? "",
        };
      } else {
        return [...feed]; // 未知 kind：忽略，不污染流
      }
      if (idx < 0) return [...feed, next];
      const copy = [...feed];
      copy[idx] = next;
      return copy;
    }
    case "delta": {
      const idx = feed.findIndex((f) => f.id === ev.partId && f.kind !== "tool" && f.state === "streaming");
      if (idx < 0) return [...feed];
      const copy = [...feed];
      const prev = copy[idx] as StreamFeedTextPart;
      copy[idx] = { ...prev, text: prev.text + ev.text };
      return copy;
    }
    default:
      return [...feed];
  }
}
