/**
 * 右栏输入区语义（spec §3.5，D21：如实叫「插话/纠偏」，不伪装成排队）。
 *
 * 后端 `POST .../tasks/:runId/message` 是同一个端点，服务端按 run 状态自动决定
 * 语义：run 处于 idle/终态时是新一轮 `session.prompt`；run 运行中时是
 * `session.steer`——**纠偏注入，不是排队**，不保证按顺序逐条送达，前端不得出现
 * 「排队」「已加入队列」这类措辞（v3 对齐轮次的明确决策，见 spec D21）。
 *
 * `judgeComposer` 与 `ProjectView.vue` 里 `composerMode`/`canAbort` 的推导同源
 * （项目尚无 run → new-task；当前 run running → steer；其余 → prompt），在此
 * 单独导出一份纯函数版本，供输入区组件与单测复用、避免语义在多处各自维护
 * 而漂移。ProjectView 是唯一编排者，实际 props 仍由它计算并下发（见契约），
 * 本函数不产生副作用、不读取任何全局状态。
 */

import type { ChatComposerMode } from "../views/project-view-contract.ts";
import type { SynthiaPart } from "./parts.ts";

// ─── 占位文案（spec §3.5 表；new-task 视为「尚无 run」的 idle 态，同用「说点什么…」）──

export const COMPOSER_PLACEHOLDER: Readonly<Record<ChatComposerMode, string>> = {
  "new-task": "说点什么…",
  prompt: "说点什么…",
  steer: "插一句（当前步骤结束后生效）",
};

/** 插话消息在对话流里的标记文案（D21：视觉上与普通用户消息区分）。 */
export const STEER_BADGE_TEXT = "↗ 纠偏";

/** 占位文案查表（`judgeComposer` 与组件都走这一份，避免两处各写一套文案）。 */
export function composerPlaceholder(mode: ChatComposerMode): string {
  return COMPOSER_PLACEHOLDER[mode];
}

export interface ComposerJudgement {
  readonly mode: ChatComposerMode;
  readonly placeholder: string;
  /** 当前是否允许发送（不含输入内容是否为空的判定，见 `canSendText`）。 */
  readonly canSend: boolean;
  /** 是否可点「⏹ 打断」（仅 steer 态，即当前 run 运行中）。 */
  readonly canAbort: boolean;
}

/**
 * 由 run 状态推导输入区语义：
 * - 项目尚无任何 run → "new-task"（发送即创建首个任务）；
 * - 当前 run 状态为 "running" → "steer"（插话/纠偏，可打断）；
 * - 其余（idle 未建过 run 之外的场景理论不存在 / 已到终态）→ "prompt"（新一轮）。
 */
export function judgeComposer(input: {
  readonly hasRun: boolean;
  readonly runStatus: string | null;
  readonly sending: boolean;
}): ComposerJudgement {
  const mode: ChatComposerMode = !input.hasRun ? "new-task" : input.runStatus === "running" ? "steer" : "prompt";
  return {
    mode,
    placeholder: composerPlaceholder(mode),
    canSend: !input.sending,
    canAbort: mode === "steer",
  };
}

/** 发送按钮可用性：文本非空（trim 后）且当前未在发送中。 */
export function canSendText(text: string, sending: boolean): boolean {
  return text.trim().length > 0 && !sending;
}

// ─── 插话消息在对话流里的配对识别（纯展示层推导，不改变 parts 顺序/内容）──────

/**
 * `domain/parts.ts:auditToParts` 把 `free_agent_steer` 事件物化为一条独立的
 * 提示 note（"纠偏消息已注入，Agent 将在当前工具结束后看到。"），而插话的实际
 * 文本仍走 `user_message` → 普通 user 文本 part；两者在 audit 时序上紧邻
 * （steer 调用先落地文本，再记一条注入提示）。
 *
 * 本模块的文件边界不含 `domain/parts.ts`（属于地基阶段既有实现，已有测试覆盖，
 * 不应重复改造），因此改在展示层按「user 文本 part 后紧跟纠偏提示 note」的相邻
 * 关系识别插话消息并打标，供 ChatFeed 渲染 `STEER_BADGE_TEXT` 标记
 * （spec §3.5 D21：插话消息需与普通用户消息视觉可辨）。识别到的伴随 note 会被
 * 一并跳过，避免同一件事在流里说两遍（一条打标消息 + 一条冗余提示）。
 */
export const STEER_NOTE_MARK = "纠偏消息已注入";

export interface ChatRenderItem {
  readonly part: SynthiaPart;
  /** 该条 user 消息是否为插话（steer）发出；非 user 文本 part 恒为 false。 */
  readonly steer: boolean;
}

function isSteerCompanionNote(part: SynthiaPart): boolean {
  return part.kind === "note" && part.tone === "info" && part.text.includes(STEER_NOTE_MARK);
}

/**
 * `parts` → 渲染条目列表：按原数组顺序原样保留（严格回合制排序不改变，见
 * v3 `8b81173` 的教训），只做两件事：
 * 1. 给紧跟纠偏提示 note 的 user 文本 part 打上 `steer: true`；
 * 2. 跳过被打标消息「消费」掉的那条纠偏提示 note（避免重复表达同一件事）。
 */
export function buildChatRenderItems(parts: readonly SynthiaPart[]): ChatRenderItem[] {
  const out: ChatRenderItem[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.kind === "text" && part.role === "user") {
      const next = parts[i + 1];
      const steer = next !== undefined && isSteerCompanionNote(next);
      out.push({ part, steer });
      continue;
    }
    const prev = parts[i - 1];
    if (isSteerCompanionNote(part) && prev !== undefined && prev.kind === "text" && prev.role === "user") {
      continue; // 已折叠进上一条消息的 steer 标记，不重复渲染
    }
    out.push({ part, steer: false });
  }
  return out;
}
