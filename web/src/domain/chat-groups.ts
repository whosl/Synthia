/**
 * 对话流展示层推导（纯函数）：工具活动分组 + 回合分隔线相对时间。
 *
 * 分组只做**显示层折叠**，不触碰顺序：渲染条目仍按 ProjectView 合并去重后的
 * 权威顺序排列（严格回合制铁律见 ChatFeed.vue 头注），本模块把「极大连续工具
 * 调用条目段」折叠成一个可展开的活动组，组内顺序与原数组完全一致——只是默认
 * 收起已完成的工具噪音（Cursor/Devin 的对话流形态：连续工具调用收成单行可
 * 展开的活动行，回合之间有分隔便于扫视）。
 */

import type { ChatRenderItem } from "./composer.ts";
import type { SynthiaAgentToolPart, SynthiaToolPart } from "./parts.ts";

/** 可折叠进工具活动组的 part（流水线阶段工具条 + Agent 自身工具调用）。 */
export type ToolActivityPart = SynthiaToolPart | SynthiaAgentToolPart;

/** part 已收窄为工具类的渲染条目。 */
export type ToolActivityItem = ChatRenderItem & { readonly part: ToolActivityPart };

export function isToolActivityItem(item: ChatRenderItem): item is ToolActivityItem {
  return item.part.kind === "tool" || item.part.kind === "agent_tool";
}

/** 连续工具调用条目的折叠组（≥2 条才成组；单条不成组、原样渲染）。 */
export interface ToolActivityGroup {
  /** 组 key = 首条目 part.id：流式增量向同组追加条目时保持不变（:key 复用契约）。 */
  readonly id: string;
  readonly items: readonly ToolActivityItem[];
  readonly total: number;
  readonly errors: number;
  /** 仍有 pending/running 条目 → 默认展开（进行中的工作不藏进折叠里）。 */
  readonly active: boolean;
  /** 各条目 durationMs 之和（只统计带耗时的条目；全都没有 → null，头部不显示耗时）。 */
  readonly durationMs: number | null;
}

/** ChatFeed 的行：普通渲染条目，或一个工具活动折叠组。 */
export type ChatFeedRow =
  | { readonly kind: "item"; readonly id: string; readonly item: ChatRenderItem }
  | { readonly kind: "tool-group"; readonly id: string; readonly group: ToolActivityGroup };

/**
 * 渲染条目 → 行列表：极大连续 tool/agent_tool 条目段折叠为一行组，其余原样
 * 出行；顺序与原数组完全一致。流式期间每次 parts 增量都会整量重算（纯函数，
 * 同输入同输出），组 id 取首条目 part.id，跨 delta 稳定。
 */
export function groupToolActivity(items: readonly ChatRenderItem[]): ChatFeedRow[] {
  const rows: ChatFeedRow[] = [];
  let run: ToolActivityItem[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0]!;
    if (run.length === 1) {
      rows.push({ kind: "item", id: first.part.id, item: first });
    } else {
      rows.push({ kind: "tool-group", id: first.part.id, group: summarizeToolGroup(first.part.id, run) });
    }
    run = [];
  };

  for (const item of items) {
    if (isToolActivityItem(item)) {
      run.push(item);
      continue;
    }
    flush();
    rows.push({ kind: "item", id: item.part.id, item });
  }
  flush();
  return rows;
}

/** 组摘要（状态优先级与头部状态点一致：error > 进行中 > 全部完成）。 */
export function summarizeToolGroup(id: string, items: readonly ToolActivityItem[]): ToolActivityGroup {
  let errors = 0;
  let active = false;
  let durationMs: number | null = null;
  for (const { part } of items) {
    if (part.kind === "tool") {
      if (part.status === "error") errors++;
      else if (part.status === "pending" || part.status === "running") active = true;
      if (part.durationMs !== null) durationMs = (durationMs ?? 0) + part.durationMs;
    } else if (part.state === "error") {
      errors++;
    } else if (part.state === "running") {
      active = true;
    }
  }
  return { id, items, total: items.length, errors, active, durationMs };
}

// ─── 回合分隔线的相对时间 ────────────────────────────────────────────

/**
 * ISO 时间戳 → 相对时间（「12 分钟前」）。
 * 无法解析、或落在未来（本机与服务端时钟漂移）→ null：调用方退化为纯分隔线，
 * 宁可不显示时间也不显示一个错的。
 */
export function formatRelativeTime(ts: string, now: number = Date.now()): string | null {
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return null;
  const diff = now - at;
  if (diff < 0) return null;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
