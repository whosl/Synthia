/**
 * 统一项目页 v3 对话流数据层（specs/unified-project-page-v3.md §3；调研路线 B 第 1 层）。
 *
 * SynthiaPart 判别联合：借 opencode session Part 判别联合的「形」+ AI SDK UIMessage
 * 的词表（text.state: streaming|done；tool 四态 pending/running/completed/error 照抄
 * opencode ToolState，含 time.start/end）；gate/lifecycle/governance/doc/evidence/
 * note/interrupt 为 Synthia 自定义 kind（audit 六类事件 + docs + evidence 无原生对应）。
 *
 * auditToParts：audit 六类事件 + docs + evidence → part 数组。按 seq 时序 upsert
 * （opencode part-upsert 语义：part 首次出现即固定位置，后续事件原地替换，绝不重排）。
 * 纯函数：每次轮询整量重算，part id 跨轮询稳定（Vue :key 复用 DOM = 增量渲染）。
 */

import { GATE_REVIEW_NAMES, type GateId } from "./gates.ts";
import { phaseDocName } from "./artifacts.ts";
import { segmentAgentReply, type ReplySegment } from "./reply-segments.ts";
import {
  TOOL_BAR_TITLES,
  formatDuration,
  humanizeReason,
  narrateAuditEvent,
  normalizeStageId,
  STAGE_TO_TOOL_OP,
} from "./tasks.ts";
import type { SideTaskConversationEvent, TaskDocRef, TaskAgentDetail } from "../api/types.ts";

// ─── SynthiaPart 判别联合 ────────────────────────────────────────────

/** 工具四态（opencode ToolState 的 status 判别照抄）。 */
export type ToolPartStatus = "pending" | "running" | "completed" | "error";

export interface ToolPartTime {
  readonly start: string | null;
  readonly end: string | null;
}

export interface SynthiaToolPart {
  readonly kind: "tool";
  readonly id: string;
  /** 工具操作（audit phase：validate_sources/simulate/synthesize/implement）。 */
  readonly op: string;
  readonly title: string;
  readonly status: ToolPartStatus;
  readonly time: ToolPartTime;
  readonly durationMs: number | null;
  /** error 态可展开的人话说明。 */
  readonly errorText: string | null;
  /** 关联的 job id（tool_call 完成事件带来，未完成为 null）；驱动跳转运行记录面板。 */
  readonly jobId: string | null;
  /** 错误码原文（仅记录面板展示，对话流不直接暴露）。 */
  readonly errorCode: string | null;
}

/** 文本 part：user 气泡（右）/ Agent 叙述（左，永不折叠）。 */
export interface SynthiaTextPart {
  readonly kind: "text";
  readonly id: string;
  readonly role: "user" | "agent";
  /** AI SDK 词表：运行中且位于流尾的 Agent 文本为 streaming，其余 done。 */
  readonly state: "streaming" | "done";
  readonly text: string;
  /** Agent 叙述分段（>15 行代码块折叠为代码卡）；user 气泡为 null。 */
  readonly segments: readonly ReplySegment[] | null;
}

export type GatePartState = "evaluating" | "awaiting" | "passed" | "failed";

/** 门审查状态事件卡（「✓ 需求审查已通过」）。 */
export interface SynthiaGatePart {
  readonly kind: "gate";
  readonly id: string;
  readonly gate: string;
  readonly review: string;
  readonly state: GatePartState;
  readonly ts: string;
}

/** 产物卡片（点开右侧抽屉阅读）。 */
export interface SynthiaDocPart {
  readonly kind: "doc";
  readonly id: string;
  readonly doc: TaskDocRef;
  readonly title: string;
  readonly ts: string | null;
  /**
   * 上一版修订 id：非 null 时这张卡能直接跳中栏 diff（本版 vs 上一版）。
   *
   * `auditToParts` 填不了它——audit 与 `detail.docs` 里只有「当时登记的这一版」，
   * 完整版本链在 artifacts 的 revisions 上，由 ProjectView 合流时补齐
   * （见其 parts 计算）。首版、或版本链还没加载完时为 null。
   *
   * 流内不做行级 diff（对标结论里那条 P1 的取舍：复用中栏 Monaco 的 diff 模式，
   * 见 specs/agent-stream-benchmark.md §4），所以这里只带一个跳转钩子。
   */
  readonly prevRevisionId: string | null;
}

/** 证据摘要卡（一行，详情在记录面板）。 */
export interface SynthiaEvidencePart {
  readonly kind: "evidence";
  readonly id: string;
  readonly count: number;
}

/** 治理事件卡（登记了产物但无文档引用可关联时）。 */
export interface SynthiaGovernancePart {
  readonly kind: "governance";
  readonly id: string;
  readonly text: string;
  readonly ts: string;
}

/** 码流证据条目（成功卡用）。 */
export interface BitstreamInfo {
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** 运行终态卡（成功 = 大成功卡；失败 = 对话式汇报，无弹窗）。 */
export interface SynthiaLifecyclePart {
  readonly kind: "lifecycle";
  readonly id: string;
  readonly state: "succeeded" | "failed";
  readonly text: string;
  readonly ts: string;
  /** 成功卡附加码流证据（evidence 中 .bit 条目）；无则 null。 */
  readonly bitstream: BitstreamInfo | null;
  /** 证据链总条目数（成功卡展示）。 */
  readonly evidenceCount: number;
}

export type NoteTone = "info" | "warn" | "error";

/** 提示卡（插话/纠偏注入、回复出错、进化提示位）。 */
export interface SynthiaNotePart {
  readonly kind: "note";
  readonly id: string;
  readonly tone: NoteTone;
  readonly text: string;
  readonly ts: string | null;
}

/** 打断标记卡（「直接插入」abort 后在流内留痕）。 */
export interface SynthiaInterruptPart {
  readonly kind: "interrupt";
  readonly id: string;
  readonly text: string;
  readonly ts: string;
}

/**
 * 思考过程 part（模型思维链）。
 *
 * 只来自 SSE 实时流（runtime/model-client.ts 解出 delta.reasoning_content），
 * 不落 audit——思维链体量大且不是回复内容，属于「过程可见」而非「记录」。
 * 因此本轮结束后刷新页面不再重放，这是有意的。
 *
 * TODO(reasoning): **这个 part 在生产中从未产生过**。当前网关每个 delta 只带
 * `['content','role']`，一个 `reasoning_content` 都不转发（实测见
 * specs/agent-stream-benchmark.md §1.3①），所以从 runtime 的 reasoningFragment()
 * 到 ReasoningItem.vue 整条管线是死路径。
 *
 * 已拍板挂起、刻意保留不删：错的是上游而不是这套投影，留到多模型适配换上游时一并
 * 解决（同上 §4.1）。在那之前**等待期的反馈不要指望它**——该由一条不依赖上游
 * reasoning 的活动条承担（§3 P0.1，尚未做）。改上游时按 `TODO(reasoning)` 搜。
 */
export interface SynthiaReasoningPart {
  readonly kind: "reasoning";
  readonly id: string;
  readonly state: "streaming" | "done";
  readonly text: string;
}

/**
 * Agent 自身的工具调用 part（free-agent 的 tool_calls，实时三态）。
 *
 * 与 {@link SynthiaToolPart} 不同：那个是流水线阶段工具条（validate_sources /
 * simulate / synthesize / implement，来自 audit），这个是 Agent 在对话轮里
 * 直接发起的任意工具调用。
 *
 * 两个来源，同一个 id（runtime 的 callId）：SSE 实时流给 running→done 的三态与
 * 完整载荷；audit 在工具结束时补一条预览记录，保证**刷新页面后还能回看本轮调了
 * 什么工具**。合流时按 id 去重，位置听 audit、内容优先听 SSE。
 */
export interface SynthiaAgentToolPart {
  readonly kind: "agent_tool";
  readonly id: string;
  readonly state: "running" | "done" | "error";
  readonly name: string;
  /** 入参 JSON 原文（服务端已截断）。 */
  readonly args: string;
  /** 结果摘要（running 时 null；服务端已截断）。 */
  readonly result: string | null;
}

export type SynthiaPart =
  | SynthiaToolPart
  | SynthiaTextPart
  | SynthiaGatePart
  | SynthiaDocPart
  | SynthiaEvidencePart
  | SynthiaGovernancePart
  | SynthiaLifecyclePart
  | SynthiaNotePart
  | SynthiaInterruptPart
  | SynthiaReasoningPart
  | SynthiaAgentToolPart;

// ─── 工具条状态文案（四态，主页面中文）────────────────────────────────

export const TOOL_STATUS_TEXT: Readonly<Record<ToolPartStatus, string>> = {
  pending: "准备中",
  running: "运行中",
  completed: "完成",
  error: "未通过",
};

function conversationPayloadText(value: unknown, max = 4_000): string {
  const text = typeof value === "string"
    ? value
    : value === undefined
      ? ""
      : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Core append-only conversation facts → refresh-stable Project Agent parts. */
export function conversationEventsToParts(
  events: readonly SideTaskConversationEvent[],
): SynthiaPart[] {
  const parts: SynthiaPart[] = [];
  const tools = new Map<string, number>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.event_kind === "user_message" || event.event_kind === "assistant_message") {
      const text = conversationPayloadText(event.payload.text).trim();
      if (!text) continue;
      const role = event.event_kind === "user_message" ? "user" as const : "agent" as const;
      parts.push({
        kind: "text",
        id: `core-${event.id}`,
        role,
        state: "done",
        text,
        segments: role === "agent" ? segmentAgentReply(text) : null,
      });
      continue;
    }
    if (event.event_kind === "tool_call") {
      const callId = typeof event.payload.tool_call_id === "string"
        ? event.payload.tool_call_id
        : event.id;
      const part: SynthiaAgentToolPart = {
        kind: "agent_tool",
        id: callId,
        state: "running",
        name: typeof event.payload.name === "string" ? event.payload.name : "tool",
        args: conversationPayloadText(event.payload.args, 400),
        result: null,
      };
      tools.set(callId, parts.length);
      parts.push(part);
      continue;
    }
    if (event.event_kind === "tool_result") {
      const callId = typeof event.payload.tool_call_id === "string"
        ? event.payload.tool_call_id
        : event.id;
      const at = tools.get(callId);
      const previous = at === undefined ? undefined : parts[at];
      const completed: SynthiaAgentToolPart = {
        kind: "agent_tool",
        id: callId,
        state: event.payload.ok === false ? "error" : "done",
        name: typeof event.payload.name === "string"
          ? event.payload.name
          : previous?.kind === "agent_tool"
            ? previous.name
            : "tool",
        args: previous?.kind === "agent_tool" ? previous.args : "",
        result: conversationPayloadText(event.payload.result, 800),
      };
      if (at === undefined) parts.push(completed);
      else parts[at] = completed;
      continue;
    }
    if (event.event_kind === "status" && event.payload.status === "cancelled") {
      parts.push({
        kind: "interrupt",
        id: `core-${event.id}`,
        text: "已打断当前回复，按新消息继续。",
        ts: event.created_at,
      });
    }
  }
  return parts;
}

/** 工具条耗时展示（null → 不显示；<2s 弱化为空，对齐 spec「completed 弱化+耗时」）。 */
export function toolDurationLabel(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 2000) return null;
  return formatDuration(durationMs);
}

// ─── 辅助（与 runtime audit 事件形态一一对应，见 runtime/loop.ts、server.ts）──

/** 从 gate 类 action 提取门 id（如 "G2: …" → "G2"）。 */
function gateIdFromAction(action: string): GateId | null {
  const match = /^(G\d)/.exec(action);
  return match && match[1]! in GATE_REVIEW_NAMES ? (match[1] as GateId) : null;
}

/** governance 登记事件 action（"registered X artifact: <revId>"）→ 修订 id。 */
function revisionIdFromGovernanceAction(action: string): string | null {
  const match = /:\s*(\S+)\s*$/.exec(action);
  return match ? match[1]! : null;
}

/** 工具失败 → 人话（error 态展开区；错误码只在记录面板）。 */
function toolErrorText(title: string, result: string | undefined): string {
  if (result === "fail_closed") return `${title}未能完成，任务已安全停止。技术详情见运行记录。`;
  return `${title}未通过，Agent 将根据结果继续处理（修复或停止）。技术详情见运行记录。`;
}

/**
 * free_agent_reply_error 的 detail（runtime 抛出的 `Error.message` 原文）→ 人话。
 *
 * 之前这里不看 detail，一律渲染「本轮回复出现错误」——网关 504、模型限流、密钥失效
 * 长得一模一样，用户只能盲目重发（限流该等、密钥失效重发一万次也没用）。现在按原因
 * 分类给出「该怎么办」。
 *
 * 沿用既有约定：**英文原文不进对话流**（见 parts.test.ts 的守卫），认不出来的原因
 * 只落到兜底句，不回显 detail。
 */
export function replyErrorText(detail: string | undefined): string {
  const raw = detail ?? "";
  const retry = "可在下方重发消息。";

  // 网关首字节超时：api 网关对「模型还没吐第一个 token」有硬上限（实测 60s），
  // 推理强度越高越容易撞上。runtime 已经会自动重试，走到这里说明重试也没过。
  if (/\b(504|gateway ?time-?out)\b/i.test(raw)) {
    return `模型思考超时，网关在返回首个字符前就断开了。${retry}若反复出现，把推理强度调低一档更有效。`;
  }
  // 空闲看门狗：连上了但长时间零字节。
  if (/no bytes from upstream|abort/i.test(raw)) {
    return `模型长时间没有输出，本轮已中止。${retry}`;
  }
  if (/\b429\b|rate ?limit|too many requests/i.test(raw)) {
    return `模型服务限流，本轮回复未完成。请稍等片刻再重发。`;
  }
  if (/\b(401|403)\b|unauthorized|forbidden|invalid api key/i.test(raw)) {
    return `模型服务认证失败，本轮回复未完成。重发无效，需要先修正模型密钥配置。`;
  }
  if (/\b(context|token).{0,20}(length|limit|exceed)|too long/i.test(raw)) {
    return `本轮上下文超出模型长度上限。请新开一轮对话，或把需求拆小后重发。`;
  }
  const status = /upstream returned (\d{3})/.exec(raw);
  if (status && Number(status[1]) >= 500) {
    return `模型服务暂时不可用（HTTP ${status[1]}），本轮回复未完成。${retry}`;
  }
  if (/fetch failed|econnrefused|enotfound|network|socket/i.test(raw)) {
    return `连不上模型服务，本轮回复未完成。请检查网络与服务地址后重发。`;
  }
  return `本轮回复出现错误，未能完成。${retry}`;
}

/**
 * free_agent_tool 的 detail（runtime 写的 JSON 预览）→ agent_tool part 字段。
 *
 * 这条 audit 是**预览**：args/result 在 runtime 侧已按预览尺寸截断（server.ts 的
 * AUDIT_TOOL_*_MAX），因为 audit 每 3 秒整量轮询一次，全文会被反复传几百遍。
 * 本轮还活着时 SSE 那份更全，合流时以 SSE 为准（见 ProjectView 的 parts 合成）。
 *
 * 解析容错：认不出来返回 null，由调用方整条丢弃——空壳工具卡比没有更糟。
 */
function parseToolAudit(
  detail: string | undefined,
): { id: string; name: string; args: string; result: string } | null {
  if (!detail) return null;
  let raw: unknown;
  try { raw = JSON.parse(detail); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const name = typeof j.name === "string" ? j.name : "";
  if (!name) return null;
  return {
    id: typeof j.id === "string" ? j.id : "",
    name,
    args: typeof j.args === "string" ? j.args : "",
    result: typeof j.result === "string" ? j.result : "",
  };
}

/** evidence 中的码流条目（文件名 .bit 结尾；取最新一条）。 */
export function bitstreamFromEvidence(
  evidence: readonly { readonly entries: ReadonlyArray<{ readonly name: string; readonly sha256: string; readonly sizeBytes: number }> }[],
): BitstreamInfo | null {
  for (const ev of [...evidence].reverse()) {
    for (const entry of [...ev.entries].reverse()) {
      if (entry.name.endsWith(".bit")) return { name: entry.name, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
    }
  }
  return null;
}

function evidenceEntryCount(evidence: TaskAgentDetail["evidence"]): number {
  return evidence.reduce((n, ev) => n + Math.max(ev.entries.length, 1), 0);
}

// ─── auditToParts：audit 六类事件 + docs + evidence → parts ──────────

/**
 * 物化对话流（纯函数）。
 *
 * 映射规则：
 * - model/user_message → user 文本气泡；free_agent_reply / 叙述类 model 事件 →
 *   Agent 文本（连续事件拼接到同一 part = 文本流式拼接；连续重复句降噪合并）；
 * - free_agent_steer → note（插话/纠偏注入提示；是 steer 注入，不是排队，见 D21）；
 *   free_agent_reply_error → note（错误）；
 *   free_agent_abort → interrupt（打断标记卡）；
 * - gate（权限门，phase=操作）→ 工具 part 进入 running（time.start）；
 * - tool_call → 工具 part 四态转移（ok → completed / 其他 → error，time.end + 耗时）；
 *   同一操作多轮（仿真修复循环）按 FIFO 配对：权限门开新 part，完成事件关最老未决 part；
 * - gate（gate_review）→ 门禁事件卡，同一门 upsert 不重排；
 * - governance → 产物卡（按修订 id 关联 docs；关联不上 → 治理事件卡）；
 * - loop succeeded/failed → 运行终态卡（成功附码流证据与证据链计数）；
 * - lifecycle（心跳/重连）与 gate 轮询事件 → 不进流（L3，记录面板可见）；
 * - detail.task 首轮指令 → 流首 user 气泡；未关联登记事件的 docs → 流尾产物卡；
 *   evidence → 一行摘要卡；运行中且当前阶段是工具操作 → 追加 pending 工具条
 *   （新工具条 3 秒内可见：阶段一翻即可见，先于权限门事件）。
 * - 流尾 Agent 文本且 run 仍 running → state=streaming，否则 done。
 */
export function auditToParts(detail: TaskAgentDetail): SynthiaPart[] {
  const parts: SynthiaPart[] = [];
  /** 当前「开放」的 Agent 文本 part 下标（连续文本事件拼接目标）。 */
  let openAgentText = -1;
  const filedDocs = new Set<string>(); // 已出产物卡的 revision_id

  const push = (part: SynthiaPart): void => {
    openAgentText = -1; // 任何新 part 都结束当前叙述段
    parts.push(part);
  };

  const appendAgentText = (seq: number, chunk: string): void => {
    const text = chunk.trim();
    if (!text) return;
    if (openAgentText >= 0) {
      const prev = parts[openAgentText] as SynthiaTextPart;
      if (prev.text === text) return; // 降噪：连续重复句合并
      const merged = `${prev.text}\n\n${text}`;
      parts[openAgentText] = { ...prev, text: merged, segments: segmentAgentReply(merged) };
      return;
    }
    parts.push({ kind: "text", id: `t${seq}`, role: "agent", state: "done", text, segments: segmentAgentReply(text) });
    openAgentText = parts.length - 1;
  };

  /** 最新的未决（pending/running）工具 part 下标。 */
  const lastOpenTool = (op: string): number => {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (p.kind === "tool" && p.op === op && (p.status === "pending" || p.status === "running")) return i;
    }
    return -1;
  };

  /** 最老的未决工具 part 下标（多轮 FIFO 配对：完成事件关最老一轮）。 */
  const firstOpenTool = (op: string): number => {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.kind === "tool" && p.op === op && (p.status === "pending" || p.status === "running")) return i;
    }
    return -1;
  };

  /** 工具 part 轮次 id：tool-<op>-<该操作已有 part 数>。与创建路径无关，跨轮询稳定
   *（阶段翻转先出 live part、权限门事件后到时 id 不变，Vue :key 复用 DOM）。 */
  const roundToolId = (op: string): string =>
    `tool-${op}-${parts.filter((p) => p.kind === "tool" && p.op === op).length}`;

  const makeTool = (
    id: string,
    op: string,
    status: ToolPartStatus,
    time: ToolPartTime,
    errorText: string | null,
    jobId: string | null = null,
    errorCode: string | null = null,
  ): SynthiaToolPart => ({
    kind: "tool",
    id,
    op,
    title: TOOL_BAR_TITLES[op] ?? op,
    status,
    time,
    durationMs: durationBetween(time),
    errorText,
    jobId,
    errorCode,
  });

  // 首轮指令气泡（runtime 不为初始 task 记 user_message 事件，取 agent-state.task）。
  if (detail.task && detail.task.trim()) {
    push({ kind: "text", id: "t0-task", role: "user", state: "done", text: detail.task.trim(), segments: null });
  }

  const sorted = [...detail.audit].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    // Any non-model event closes the open agent narration run — otherwise
    // narration written before a tool bar merges with narration after it
    // (opencode semantics: text and tool parts interleave strictly by time).
    if (event.category !== "model") openAgentText = -1;
    switch (event.category) {
      case "model": {
        if (event.action === "user_message") {
          const text = event.detail?.trim();
          // A user message starts a NEW conversation turn: close the open
          // agent narration run so replies from different turns never merge
          // (dsh/opencode semantics: strict turn-by-turn ordering).
          openAgentText = -1;
          if (text) push({ kind: "text", id: `u${event.seq}`, role: "user", state: "done", text, segments: null });
          break;
        }
        if (event.action === "free_agent_reply") {
          // Streaming finalize dedup: SSE already rendered this text as a
          // streaming part (sp-*) that transitioned to done. Match by full
          // text fingerprint instead of id, or the reply renders twice
          // (once streamed, once from audit).
          appendAgentText(event.seq, event.detail ?? "");
          break;
        }
        if (event.action === "free_agent_steer") {
          push({ kind: "note", id: `n${event.seq}`, tone: "info", text: "纠偏消息已注入，Agent 将在当前工具结束后看到。", ts: event.ts });
          break;
        }
        if (event.action === "free_agent_reply_error") {
          push({ kind: "note", id: `n${event.seq}`, tone: "error", text: replyErrorText(event.detail), ts: event.ts });
          break;
        }
        if (event.action === "free_agent_abort") {
          push({ kind: "interrupt", id: `i${event.seq}`, text: "已打断当前回复，按新消息继续。", ts: event.ts });
          break;
        }
        if (event.action === "free_agent_tool") {
          const call = parseToolAudit(event.detail);
          // detail 解不出来就整条丢掉：宁可少一张卡，也不要渲染一张空壳工具卡。
          if (call) {
            push({
              kind: "agent_tool",
              // id 取 runtime 的 callId——SSE 实时流里那张卡用的是同一个 id，
              // 合流时按 id 去重（见 ProjectView 的 parts 合成），否则本轮渲染两遍。
              id: call.id || `at${event.seq}`,
              state: event.result === "ok" ? "done" : "error",
              name: call.name,
              args: call.args,
              result: call.result,
            });
          }
          break;
        }
        const sentence = narrateAuditEvent(event);
        if (sentence) appendAgentText(event.seq, sentence);
        break;
      }

      case "tool_call": {
        const op = event.phase;
        if (!(op in TOOL_BAR_TITLES)) break; // repair 诊断等内部事件不进流
        const failed = event.result !== "ok";
        const jobId = event.jobId ?? null;
        const errorCode = failed ? event.errorCode ?? null : null;
        const idx = firstOpenTool(op);
        if (idx >= 0) {
          const prev = parts[idx] as SynthiaToolPart;
          parts[idx] = {
            ...prev,
            status: failed ? "error" : "completed",
            time: { start: prev.time.start, end: event.ts },
            durationMs: durationBetween({ start: prev.time.start, end: event.ts }),
            errorText: failed ? toolErrorText(prev.title, event.result) : null,
            jobId,
            errorCode,
          };
        } else {
          push(
            makeTool(
              roundToolId(op),
              op,
              failed ? "error" : "completed",
              { start: null, end: event.ts },
              failed ? toolErrorText(TOOL_BAR_TITLES[op]!, event.result) : null,
              jobId,
              errorCode,
            ),
          );
        }
        break;
      }

      case "gate": {
        if (event.phase !== "gate_review") {
          // 权限门（"gate ok (vivado-batch-1)"）= 工具启动：pending → running。
          const op = event.phase;
          if (!(op in TOOL_BAR_TITLES)) break;
          const idx = lastOpenTool(op);
          if (idx >= 0) {
            const prev = parts[idx] as SynthiaToolPart;
            if (prev.status === "pending") {
              parts[idx] = { ...prev, status: "running", time: { start: event.ts, end: null }, durationMs: null };
            }
          } else {
            push(makeTool(roundToolId(op), op, "running", { start: event.ts, end: null }, null));
          }
          break;
        }
        const gate = gateIdFromAction(event.action);
        if (!gate) break;
        let state: GatePartState;
        if (event.action.includes("approved")) state = "passed";
        else if (event.action.includes("rejected") || event.action.includes("withdrawn")) state = "failed";
        else if (event.action.includes("awaiting human approval")) state = "awaiting";
        else if (event.action.includes("polling approval status")) break; // 轮询属技术细节
        else state = "evaluating"; // creating snapshot / submitting for review
        const existing = parts.findIndex((p) => p.kind === "gate" && p.id === `gate-${gate}`);
        if (existing >= 0) {
          const prev = parts[existing] as SynthiaGatePart;
          parts[existing] = { ...prev, ts: event.ts, state };
        } else {
          push({ kind: "gate", id: `gate-${gate}`, gate, review: GATE_REVIEW_NAMES[gate], state, ts: event.ts });
        }
        break;
      }

      case "governance": {
        const revisionId = revisionIdFromGovernanceAction(event.action);
        const doc = revisionId ? detail.docs.find((d) => d.revision_id === revisionId) : undefined;
        if (doc) {
          if (!filedDocs.has(doc.revision_id)) {
            filedDocs.add(doc.revision_id);
            push({ kind: "doc", id: `doc-${doc.revision_id}`, doc, title: phaseDocName(doc.phase), ts: event.ts, prevRevisionId: null });
          }
        } else {
          push({ kind: "governance", id: `gov${event.seq}`, text: "已登记候选产物（候选修订待审）。", ts: event.ts });
        }
        break;
      }

      case "loop": {
        if (event.action === "loop succeeded") {
          const evidenceCount = evidenceEntryCount(detail.evidence);
          push({
            kind: "lifecycle",
            id: `z${event.seq}`,
            state: "succeeded",
            text: "全流程完成，码流已生成 ✅",
            ts: event.ts,
            bitstream: bitstreamFromEvidence(detail.evidence),
            evidenceCount,
          });
        } else if (event.action === "loop failed" || event.action === "loop fail_closed") {
          push({
            kind: "lifecycle",
            id: `z${event.seq}`,
            state: "failed",
            text: humanizeReason(detail.reason ?? event.detail),
            ts: event.ts,
            bitstream: null,
            evidenceCount: evidenceEntryCount(detail.evidence),
          });
        }
        break; // "loop paused at Gx" 由门禁卡 awaiting 覆盖
      }

      case "lifecycle":
        break; // 心跳/重连一律不进对话流（L3，记录面板可见）
    }
  }

  // 未关联登记事件的产物 → 产物卡补到流尾。
  for (const doc of detail.docs) {
    if (filedDocs.has(doc.revision_id)) continue;
    filedDocs.add(doc.revision_id);
    push({ kind: "doc", id: `doc-${doc.revision_id}`, doc, title: phaseDocName(doc.phase), ts: null, prevRevisionId: null });
  }

  // 证据摘要：一行合并，详情在记录面板。
  const evidenceCount = evidenceEntryCount(detail.evidence);
  if (evidenceCount > 0) {
    push({ kind: "evidence", id: "evidence", count: evidenceCount });
  }

  // 运行中且当前阶段是工具操作：追加 pending 工具条（阶段一翻即现，先于权限门事件）。
  // 仅在该操作尚无任何 part 时（阶段刚开始）；多轮修复循环的后续轮由各自权限门事件开条。
  if (detail.status === "running" && detail.current_stage) {
    const op = STAGE_TO_TOOL_OP[normalizeStageId(detail.current_stage)];
    if (op && !parts.some((p) => p.kind === "tool" && p.op === op)) {
      push(makeTool(roundToolId(op), op, "pending", { start: null, end: null }, null));
    }
  }

  // 流尾 Agent 文本 + run 仍在 running → streaming（准直播：等待后续拼接）。
  const last = parts[parts.length - 1];
  if (detail.status === "running" && last?.kind === "text" && last.role === "agent") {
    parts[parts.length - 1] = { ...last, state: "streaming" };
  }

  return parts;
}

/** time.start/end → 耗时（缺失或非法 → null）。 */
function durationBetween(time: ToolPartTime): number | null {
  if (!time.start || !time.end) return null;
  const ms = Date.parse(time.end) - Date.parse(time.start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
