/**
 * 「本轮改动」汇总卡的注入（纯函数，ProjectView 的 parts computed 最后一步调用）。
 *
 * 对话流里 agent 的产物登记是逐张 doc 卡散落在轮内的（叙事位置正确，保留不动），
 * 但「这一轮下来到底改了哪些文件」没有答案——diff 入口埋在每张卡里。本函数把
 * 每轮（一条用户消息到下一条用户消息之间）登记过的 doc 卡归集成一张汇总卡，
 * 插在该轮末尾，行点击直接进中栏 Monaco diff（或首版时打开文件）。
 *
 * 轮边界 = 用户消息 part（kind text + role user），与 ChatFeed 的回合分隔线一致。
 * 首条用户消息之前的段（旧数据/系统引导期的登记）同样归集，卡插在那段末尾。
 *
 * tailOpen：末轮仍在进行（流式未收口或 run 在跑）时不给末轮注卡——轮内 doc 卡
 * 本来就在流里，汇总卡等轮次落定再出现，避免流式回复下方再长一张变化的卡。
 */
import type { SynthiaChangeItem, SynthiaChangesPart, SynthiaDocPart, SynthiaPart } from "./parts.ts";

function isUserText(part: SynthiaPart): boolean {
  return part.kind === "text" && part.role === "user";
}

function toChangeItem(part: SynthiaDocPart): SynthiaChangeItem {
  return {
    artifactId: part.doc.artifact_id,
    revisionId: part.doc.revision_id,
    prevRevisionId: part.prevRevisionId,
    path: part.doc.path,
    title: part.title,
  };
}

export function injectChangeCards(
  parts: readonly SynthiaPart[],
  opts: { readonly tailOpen: boolean },
): SynthiaPart[] {
  const out: SynthiaPart[] = [];
  let docs: SynthiaDocPart[] = [];

  const flush = (): void => {
    if (docs.length === 0) return;
    // 同一版修订只留一行（防御性去重：auditToParts 已按 revision_id 去重过一次）。
    const seen = new Set<string>();
    const items: SynthiaChangeItem[] = [];
    for (const doc of docs) {
      if (seen.has(doc.doc.revision_id)) continue;
      seen.add(doc.doc.revision_id);
      items.push(toChangeItem(doc));
    }
    const card: SynthiaChangesPart = {
      kind: "changes",
      id: `changes-${docs[0]!.id}`,
      ts: docs[docs.length - 1]!.ts,
      items,
    };
    out.push(card);
    docs = [];
  };

  for (const part of parts) {
    // 先收上一段的卡，再推用户消息——卡留在它总结的那一轮内部。
    if (isUserText(part)) flush();
    out.push(part);
    if (part.kind === "doc") docs.push(part);
  }
  if (!opts.tailOpen) flush();
  return out;
}
