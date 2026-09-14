/**
 * Synthia Runtime — 会话事件流 hub（SSE 切片）。
 *
 * FreeAgentSession 的模型文本 delta 与 server 的会话状态变化汇聚为带单调 seq
 * 的事件流，供 GET /tasks/:agentId/stream 按 seq 有序推送：
 *
 *  - `part`   新/更新 part 的 JSON（kind + state + 完整文本）：
 *             `text` Agent 回复正文 / `reasoning` 思维链 / `tool` 工具调用；
 *  - `delta`  {partId, text} 纯文本追加（打字机增量，text 与 reasoning 通用）；
 *  - `status` 会话状态变化（idle/running/awaiting_approval/…）；
 *  - `done`   整轮完成（携带最终 reply 摘要）；
 *  - `reset`  订阅游标早于保留窗口（客户端应全量刷新后重订）。
 *
 * 设计：每 agent 一个 hub（`StreamHub.for(agentId)`），事件保留环形上限（默认
 * 2000 条）；订阅 = 每连接独立游标 + 等待者（emit 广播唤醒），断线重连可用
 * Last-Event-ID 续传；游标过老收到 `reset` 后全量刷新。
 */

export type StreamEvent =
  | { type: "part"; seq: number; part: StreamPart }
  | { type: "delta"; seq: number; partId: string; text: string }
  | { type: "status"; seq: number; status: string; ts: string }
  | { type: "done"; seq: number; reply: string; status: string; ts: string }
  | { type: "reset"; seq: number; reason: string };

/** Preserve each event variant while removing the hub-owned sequence field. */
type StreamEventInput = StreamEvent extends infer Event
  ? Event extends { readonly seq: number }
    ? Omit<Event, "seq">
    : never
  : never;

/** part 事件载荷：流式文本 / 思维链 part（二者形态一致，只差 kind）。 */
export interface StreamTextPart {
  /** `text` = Agent 回复正文；`reasoning` = 思维链（思考过程）。 */
  readonly kind: "text" | "reasoning";
  readonly id: string;
  readonly state: "streaming" | "done";
  /** 累计文本（done 时为完整定稿文本）。 */
  readonly text: string;
  readonly ts: string;
}

/** part 事件载荷：工具调用 part（free-agent 自身的 tool_calls，实时四态）。 */
export interface StreamToolPart {
  readonly kind: "tool";
  readonly id: string;
  readonly state: "running" | "done" | "error";
  /** 工具名。 */
  readonly name: string;
  /** 入参 JSON 原文（超长截断，避免大 payload 灌流）。 */
  readonly args: string;
  /** 结果摘要（running 时为 null；超长截断）。 */
  readonly result: string | null;
  readonly ts: string;
}

export type StreamPart = StreamTextPart | StreamToolPart;

/** 订阅游标句柄（每个 SSE 连接一个）。 */
export interface StreamCursor {
  /** 等待下一批事件（seq > cursor）；连接关闭后返回空数组。 */
  next(): Promise<readonly StreamEvent[]>;
  /** 已消费到的 seq。 */
  cursor: number;
  /** 停止等待（客户端断开时）。 */
  stop(): void;
  /** 是否已停止。 */
  readonly stopped: boolean;
}

interface HubInternal {
  events: StreamEvent[];
  seq: number;
  retain: number;
  /** 同一 partId 的连续 delta 在此窗口内聚合为一条事件（ms）。0 = 不聚合。 */
  deltaBatchMs: number;
  /** 聚合中的 delta 批（flush 时才分配 seq 入列）。 */
  pendingDelta: { partId: string; text: string } | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** 等待新事件的 next() 唤醒回调。 */
  waiters: Array<() => void>;
}

const DEFAULT_RETAIN = 2000;
const DEFAULT_DELTA_BATCH_MS = 80;
/** 聚合批达到该字符数立即 flush（不等窗口）。 */
const DELTA_BATCH_CHARS = 64;
const hubs = new Map<string, HubInternal>();

function hubFor(agentId: string, retain: number = DEFAULT_RETAIN, deltaBatchMs: number = DEFAULT_DELTA_BATCH_MS): HubInternal {
  let hub = hubs.get(agentId);
  if (!hub) {
    hub = { events: [], seq: 0, retain, deltaBatchMs, pendingDelta: null, pendingTimer: null, waiters: [] };
    hubs.set(agentId, hub);
  }
  return hub;
}

/** seq > cursor 的事件（无等待）。 */
function eventsSince(hub: HubInternal, cursor: number): readonly StreamEvent[] {
  return hub.events.filter((e) => e.seq > cursor);
}

export class StreamHub {
  private constructor(private readonly hub: HubInternal) {}

  /** 取或创建 agent 的 hub。 */
  static for(agentId: string, retain?: number, deltaBatchMs?: number): StreamHub {
    return new StreamHub(hubFor(agentId, retain, deltaBatchMs));
  }

  /** 当前最大 seq（Last-Event-ID 校验用）。聚合中的 delta 先 flush 保证准确。 */
  get lastSeq(): number {
    this.flushDeltaBatch();
    return this.hub.seq;
  }

  /** 保留窗口内最老 seq（-1 表示空）。 */
  get oldestSeq(): number {
    return this.hub.events[0]?.seq ?? -1;
  }

  /** 把聚合中的 delta 批落成一条事件（分配 seq、入列、唤醒等待者）。 */
  private flushDeltaBatch(): void {
    const hub = this.hub;
    if (hub.pendingTimer) {
      clearTimeout(hub.pendingTimer);
      hub.pendingTimer = null;
    }
    const pending = hub.pendingDelta;
    if (!pending) return;
    hub.pendingDelta = null;
    const full: StreamEvent = { type: "delta", seq: ++hub.seq, partId: pending.partId, text: pending.text };
    hub.events.push(full);
    if (hub.events.length > hub.retain) {
      hub.events.splice(0, hub.events.length - hub.retain);
    }
    for (const wake of hub.waiters.splice(0)) wake();
  }

  /**
   * 发布事件。delta 与同一 partId 的前一条在时间窗内聚合为一条（长思考逐
   * token 发射会把保留窗口单轮打爆，刷新重放触发 stale → reset → 思考块
   * 丢失）；其余事件先 flush 聚合批再入列，保证全序。delta 的 seq 在 flush
   * 时才分配，返回值里的 seq 对 delta 表示「不晚于此 seq 可见」。
   */
  emit(event: StreamEventInput): StreamEvent {
    const hub = this.hub;
    if (event.type === "delta" && hub.deltaBatchMs > 0) {
      let pending = hub.pendingDelta;
      if (pending && pending.partId === event.partId) {
        pending.text += event.text;
      } else {
        this.flushDeltaBatch();
        pending = { partId: event.partId, text: event.text };
        hub.pendingDelta = pending;
      }
      if (pending.text.length >= DELTA_BATCH_CHARS) {
        this.flushDeltaBatch();
      } else if (!hub.pendingTimer) {
        hub.pendingTimer = setTimeout(() => {
          hub.pendingTimer = null;
          this.flushDeltaBatch();
        }, hub.deltaBatchMs);
      }
      return { ...event, seq: hub.seq };
    }
    this.flushDeltaBatch();
    const full = { ...event, seq: ++hub.seq } as StreamEvent;
    hub.events.push(full);
    if (hub.events.length > hub.retain) {
      hub.events.splice(0, hub.events.length - hub.retain);
    }
    for (const wake of hub.waiters.splice(0)) wake();
    return full;
  }

  /** seq > cursor 的事件（无等待）。聚合中的 delta 先 flush。 */
  since(cursor: number): readonly StreamEvent[] {
    this.flushDeltaBatch();
    return eventsSince(this.hub, cursor);
  }

  /**
   * 订阅：游标从 `after` 开始（缺省从头回放保留窗口）。
   * 游标早于保留窗口起点时默认返回单个 `reset` 事件；`staleReplay` 为 true
   * 时改为从头回放保留窗口（`from=turn` 首连场景：客户端没有本地流状态可
   * 丢弃，reset 只会把它推去轮询兜底，而轮询对轮内思考是盲的）。
   */
  subscribe(after?: number, opts?: { readonly staleReplay?: boolean }): StreamCursor {
    const hub = this.hub;
    const flush = (): void => this.flushDeltaBatch();
    let stopped = false;
    let cursor = after ?? 0;
    const staleReplay = opts?.staleReplay === true;
    let stale = after !== undefined && (after > hub.seq
      || (hub.events.length > 0 && after < hub.events[0]!.seq - 1));
    const cursorObj: StreamCursor = {
      get stopped() {
        return stopped;
      },
      get cursor() {
        return cursor;
      },
      set cursor(v: number) {
        cursor = v;
      },
      stop() {
        stopped = true;
        for (const wake of hub.waiters.splice(0)) wake();
      },
      async next(): Promise<readonly StreamEvent[]> {
        if (stopped) return [];
        if (stale) {
          stale = false;
          if (!staleReplay) {
            cursor = hub.seq;
            return [{ type: "reset", seq: hub.seq, reason: "cursor outside retained stream" }];
          }
          cursor = 0; // 全量回放保留窗口
        }
        flush();
        let pending = eventsSince(hub, cursor);
        if (pending.length === 0) {
          await new Promise<void>((resolve) => {
            hub.waiters.push(resolve);
          });
          if (stopped) return [];
          pending = eventsSince(hub, cursor);
        }
        if (pending.length > 0) cursor = pending[pending.length - 1]!.seq;
        return pending;
      },
    };
    return cursorObj;
  }

  /**
   * 订阅「当前轮次」：游标定位到保留窗口内最后一个 `done` 事件之后。
   *
   * 首次连接用。历史消息由前端 3 秒轮询的 audit 物化（domain/parts.ts），流只需
   * 补上「正在生成的这一轮」——全量回放保留窗口实测 227 KB / 2000 条，浏览器每
   * 次重连都要重新解析一遍，纯粹浪费。窗口内没有 `done`（单轮超长）时退化为全量。
   */
  subscribeCurrentTurn(): StreamCursor {
    const events = this.hub.events;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "done") return this.subscribe(events[i]!.seq, { staleReplay: true });
    }
    return this.subscribe();
  }

  /** 丢弃 agent 的 hub（agent 删除时）。 */
  static drop(agentId: string): void {
    const hub = hubs.get(agentId);
    if (hub) {
      if (hub.pendingTimer) {
        clearTimeout(hub.pendingTimer);
        hub.pendingTimer = null;
      }
      hubs.delete(agentId);
      for (const wake of hub.waiters.splice(0)) wake();
    }
  }
}
