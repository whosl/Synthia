/**
 * Synthia Runtime — 会话事件流 hub（SSE 切片）。
 *
 * FreeAgentSession 的模型文本 delta 与 server 的会话状态变化汇聚为带单调 seq
 * 的事件流，供 GET /tasks/:runId/stream 按 seq 有序推送：
 *
 *  - `part`   新/更新 part 的 JSON（kind + state + 完整文本）；
 *  - `delta`  {partId, text} 纯文本追加（打字机增量）；
 *  - `status` 会话状态变化（idle/running/awaiting_approval/…）；
 *  - `done`   整轮完成（携带最终 reply 摘要）；
 *  - `reset`  订阅游标早于保留窗口（客户端应全量刷新后重订）。
 *
 * 设计：每 run 一个 hub（`StreamHub.for(runId)`），事件保留环形上限（默认
 * 2000 条）；订阅 = 每连接独立游标 + 等待者（emit 广播唤醒），断线重连可用
 * Last-Event-ID 续传；游标过老收到 `reset` 后全量刷新。
 */

export type StreamEvent =
  | { type: "part"; seq: number; part: StreamPart }
  | { type: "delta"; seq: number; partId: string; text: string }
  | { type: "status"; seq: number; status: string; ts: string }
  | { type: "done"; seq: number; reply: string; status: string; ts: string }
  | { type: "reset"; seq: number; reason: string };

/** part 事件载荷：流式文本 part。 */
export interface StreamPart {
  readonly kind: "text";
  readonly id: string;
  readonly state: "streaming" | "done";
  /** 累计文本（done 时为完整定稿文本）。 */
  readonly text: string;
  readonly ts: string;
}

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
  /** 等待新事件的 next() 唤醒回调。 */
  waiters: Array<() => void>;
}

const DEFAULT_RETAIN = 2000;
const hubs = new Map<string, HubInternal>();

function hubFor(runId: string, retain: number = DEFAULT_RETAIN): HubInternal {
  let hub = hubs.get(runId);
  if (!hub) {
    hub = { events: [], seq: 0, retain, waiters: [] };
    hubs.set(runId, hub);
  }
  return hub;
}

/** seq > cursor 的事件（无等待）。 */
function eventsSince(hub: HubInternal, cursor: number): readonly StreamEvent[] {
  return hub.events.filter((e) => e.seq > cursor);
}

export class StreamHub {
  private constructor(private readonly hub: HubInternal) {}

  /** 取或创建 run 的 hub。 */
  static for(runId: string, retain?: number): StreamHub {
    return new StreamHub(hubFor(runId, retain));
  }

  /** 当前最大 seq（Last-Event-ID 校验用）。 */
  get lastSeq(): number {
    return this.hub.seq;
  }

  /** 保留窗口内最老 seq（-1 表示空）。 */
  get oldestSeq(): number {
    return this.hub.events[0]?.seq ?? -1;
  }

  /** 发布事件（seq 自增）；返回带 seq 的完整事件。 */
  emit(event: Omit<StreamEvent, "seq">): StreamEvent {
    const hub = this.hub;
    const full = { ...event, seq: ++hub.seq } as StreamEvent;
    hub.events.push(full);
    if (hub.events.length > hub.retain) {
      hub.events.splice(0, hub.events.length - hub.retain);
    }
    for (const wake of hub.waiters.splice(0)) wake();
    return full;
  }

  /** seq > cursor 的事件（无等待）。 */
  since(cursor: number): readonly StreamEvent[] {
    return eventsSince(this.hub, cursor);
  }

  /**
   * 订阅：游标从 `after` 开始（缺省从头回放保留窗口）。
   * 游标早于保留窗口起点时，next() 首批返回单个 `reset` 事件。
   */
  subscribe(after?: number): StreamCursor {
    const hub = this.hub;
    let stopped = false;
    let cursor = after ?? 0;
    let stale = after !== undefined && hub.events.length > 0 && after < hub.events[0]!.seq - 1;
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
          cursor = hub.seq;
          return [{ type: "reset", seq: hub.seq, reason: "cursor older than retained window" }];
        }
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

  /** 丢弃 run 的 hub（run 删除时）。 */
  static drop(runId: string): void {
    const hub = hubs.get(runId);
    if (hub) {
      hubs.delete(runId);
      for (const wake of hub.waiters.splice(0)) wake();
    }
  }
}
