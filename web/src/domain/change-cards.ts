/**
 * 「本轮改动」汇总卡的注入（纯函数，ProjectView 的 parts computed 最后一步调用）。
 *
 * 对话流逐张的 doc 卡只回答「这一步生成了什么」，没有回答「这一轮下来改了哪些
 * 文件」——diff 入口埋在每张卡里。本函数把每轮（一条用户消息到下一条用户消息
 * 之间）的改动归集成一张汇总卡，插在该轮末尾；行点击进中栏 Monaco diff
 * （有上一版时）或打开该版（首版/新文件）。
 *
 * 两种归因模式（按对话数据源自动二选一，不会混用）：
 *
 * - **时间窗模式**（durable 会话事件，project agent / 探索任务）：用户消息 part
 *   带 ts（event.created_at），以它为锚点划时间窗 [t_i, t_{i+1})，窗内登记的
 *   **制品修订**（fileTreeEntries 的版本链，含 created_at）就是本轮改动。
 *   首轮对话之前登记的修订（项目种子/初始化上传）不算对话改动，自动丢弃。
 * - **doc 卡模式**（legacy audit 路径）：audit 用户消息没有 ts，退化为归集段内
 *   的 doc part（governance 登记事件产生的产物卡）。
 *
 * tailOpen：末轮仍在进行（流式未收口或 run 在跑）时不给末轮注卡——轮内的登记
 * 本来还在发生，汇总卡等轮次落定再出现。
 */
import type { SynthiaChangeItem, SynthiaChangesPart, SynthiaDocPart, SynthiaPart } from "./parts.ts";

/** 时间窗模式的一行输入：制品版本链上的一次登记。 */
export interface RevisionChangeInput {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly version: number;
  /** ISO 时间（artifact_revision.created_at）。 */
  readonly createdAt: string;
  readonly path: string;
  readonly prevRevisionId: string | null;
}

function isUserText(part: SynthiaPart): boolean {
  return part.kind === "text" && part.role === "user";
}

function anchorTime(part: SynthiaPart): number | null {
  if (!isUserText(part) || part.kind !== "text" || !part.ts) return null;
  const t = Date.parse(part.ts);
  return Number.isNaN(t) ? null : t;
}

function docItem(part: SynthiaDocPart): SynthiaChangeItem {
  return {
    artifactId: part.doc.artifact_id,
    revisionId: part.doc.revision_id,
    prevRevisionId: part.prevRevisionId,
    path: part.doc.path,
    title: part.title,
  };
}

function revisionItem(rev: RevisionChangeInput): SynthiaChangeItem {
  return {
    artifactId: rev.artifactId,
    revisionId: rev.revisionId,
    prevRevisionId: rev.prevRevisionId,
    path: rev.path,
    title: `v${rev.version}`,
  };
}

function makeCard(items: readonly SynthiaChangeItem[], ts: string | null): SynthiaChangesPart {
  return { kind: "changes", id: `changes-${items[0]!.revisionId}`, ts, items };
}

/** doc 卡模式：按用户消息切段，段内 doc part 收成一张卡插到段末。 */
function injectDocMode(parts: readonly SynthiaPart[], tailOpen: boolean): SynthiaPart[] {
  const out: SynthiaPart[] = [];
  let docs: SynthiaDocPart[] = [];

  const flush = (): void => {
    if (docs.length === 0) return;
    const seen = new Set<string>();
    const items: SynthiaChangeItem[] = [];
    for (const doc of docs) {
      if (seen.has(doc.doc.revision_id)) continue;
      seen.add(doc.doc.revision_id);
      items.push(docItem(doc));
    }
    out.push(makeCard(items, docs[docs.length - 1]!.ts));
    docs = [];
  };

  for (const part of parts) {
    // 先收上一段的卡，再推用户消息——卡留在它总结的那一轮内部。
    if (isUserText(part)) flush();
    out.push(part);
    if (part.kind === "doc") docs.push(part);
  }
  if (!tailOpen) flush();
  return out;
}

/**
 * 时间窗模式：每条带 ts 的用户消息开一个窗 [t_i, t_{i+1})，窗内登记的修订
 * 归到那一轮，卡插在下一条带 ts 用户消息之前（末窗插在流尾）。
 * 无 ts 的用户消息不参与切窗（durable 路径里用户消息必然有 ts）。
 */
function injectWindowMode(
  parts: readonly SynthiaPart[],
  revisions: readonly RevisionChangeInput[],
  tailOpen: boolean,
): SynthiaPart[] {
  // 锚点：part 下标 + 时间。
  const anchors: { readonly index: number; readonly time: number }[] = [];
  parts.forEach((part, index) => {
    const t = anchorTime(part);
    if (t !== null) anchors.push({ index, time: t });
  });
  if (anchors.length === 0) return [...parts];

  // 修订归窗：最后一个早于等于它创建时间的锚点。
  const revsByAnchor = new Map<number, RevisionChangeInput[]>();
  for (const rev of revisions) {
    const t = Date.parse(rev.createdAt);
    if (Number.isNaN(t)) continue;
    let owner = -1;
    for (let a = 0; a < anchors.length; a++) {
      if (anchors[a]!.time <= t) owner = a;
      else break;
    }
    if (owner < 0) continue; // 首轮对话之前的登记（种子/初始化）不算对话改动
    const list = revsByAnchor.get(owner) ?? [];
    list.push(rev);
    revsByAnchor.set(owner, list);
  }
  if (revsByAnchor.size === 0) return [...parts];

  // 卡内按登记时间先后排序（修订来自各制品的版本链，输入序是按文件而非按时间）。
  const itemsByAnchor = new Map<number, SynthiaChangeItem[]>();
  for (const [ordinal, list] of revsByAnchor) {
    const sorted = [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    itemsByAnchor.set(ordinal, sorted.map(revisionItem));
  }

  const anchorOrdinal = new Map(anchors.map((a, i) => [a.index, i]));
  const out: SynthiaPart[] = [];
  const lastAnchor = anchors.length - 1;
  parts.forEach((part, index) => {
    const ordinal = anchorOrdinal.get(index);
    if (ordinal !== undefined && ordinal > 0) {
      // 新一窗开始：先把上一窗的卡收了（如果它有改动）。
      const items = itemsByAnchor.get(ordinal - 1);
      if (items) out.push(makeCard(items, null));
    }
    out.push(part);
  });
  if (!tailOpen) {
    const items = itemsByAnchor.get(lastAnchor);
    if (items) out.push(makeCard(items, null));
  }
  return out;
}

export function injectChangeCards(
  parts: readonly SynthiaPart[],
  opts: { readonly tailOpen: boolean; readonly revisions?: readonly RevisionChangeInput[] },
): SynthiaPart[] {
  const hasAnchors = parts.some((part) => anchorTime(part) !== null);
  if (hasAnchors && opts.revisions && opts.revisions.length > 0) {
    return injectWindowMode(parts, opts.revisions, opts.tailOpen);
  }
  return injectDocMode(parts, opts.tailOpen);
}
