/**
 * 流式 Markdown 块投影（markdown-stream）。
 *
 * 移植自 opencode（anomalyco/opencode）
 *   packages/session-ui/src/components/markdown-stream.ts
 *   packages/session-ui/src/components/markdown-projection.ts
 * MIT License — Copyright (c) 2025 opencode（https://github.com/anomalyco/opencode）
 *
 * 改动（Synthia 移植说明）：
 * - 依赖收敛：remend（上游用于修复截断 Markdown）在离线内网不可得，本地以
 *   `heal()` 等价占位（marked 对截断文本已可安全渲染，代码围栏未闭合时 marked
 *   按代码块处理；链接引用定义场景由 refs() 短路为单一 live 块，语义不变）；
 * - completedProjection 内联自 markdown-projection.ts（原文件仅此一函数被使用）；
 * - 其余算法（稳定块切分、活动尾块、closesFence 增量续写判定）逐行保留。
 *
 * 语义：`project(previous, text, live)` 把累计文本切成稳定块（full/code）+
 * 活动尾块（live）；代码围栏增量续写不重排（同一 code 块只追加 src）。
 */

import { marked, type Tokens } from "marked";

export type Block = {
  raw: string;
  src: string;
  mode: "full" | "live" | "code";
  language?: string;
  complete?: boolean;
};

export type Projection = {
  text: string;
  blocks: Block[];
};

function refs(text: string) {
  if (!text.includes("]:")) return false;
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text);
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined;
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n");
  return newline < 0 ? "" : raw.slice(newline + 1);
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const mark = match[1];
  if (!mark) return false;
  const char = mark[0];
  const size = mark.length;
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? "";
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
  if (!mark) return suffix.includes("```") || suffix.includes("~~~");
  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark);
}

/**
 * 截断 Markdown 修复（上游此处调用 remend(text, {linkMode:"text-only"})）。
 * 本地实现：保持原文（marked 对截断输入的渲染已足够安全；见文件头说明）。
 */
function heal(text: string) {
  return text;
}

export function completedProjection(text: string): Projection {
  return { text, blocks: [{ raw: text, src: text, mode: "full" }] };
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks;
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[];
  const tokens = marked.lexer(text) as unknown as Array<{ type: string; raw: string } & Tokens.Generic>;
  let tail = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i]!.type !== "space") { tail = i; break; }
  }
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[];
  const last = tokens[tail];
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[];

  const result: Block[] = [];
  for (let index = 0; index < tail; index++) {
    const token = tokens[index];
    if (!token || token.type === "space") continue;
    let raw = token.raw;
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw;
    if (token.type === "code") {
      const code = token as Tokens.Code;
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true });
      continue;
    }
    result.push({ raw, src: raw, mode: "full" });
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("");
  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }];

  const code = last as Tokens.Code;
  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }];
  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }];
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live) {
    const current =
      previous?.text === text
        ? previous
        : previous && text.startsWith(previous.text)
          ? project(previous, text, true)
          : undefined;
    if (!current) return completedProjection(text);
    return {
      text,
      blocks: current.blocks.map((block) => {
        if (block.mode === "live") return { raw: block.raw, src: block.raw, mode: "full" };
        if (block.mode === "code" && !block.complete) return { ...block, complete: true };
        return block;
      }),
    };
  }
  if (!previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) };
  const tail = previous.blocks.at(-1);
  const suffix = text.slice(previous.text.length);
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
    return { text, blocks: stream(text, live) };
  return {
    text,
    blocks: [
      ...previous.blocks.slice(0, -1),
      {
        ...tail,
        raw: tail.raw + suffix,
        src: tail.src + suffix,
      },
    ],
  };
}
