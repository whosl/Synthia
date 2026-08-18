/**
 * 中栏编辑器纯逻辑（spec §3.3 三态表 + D19、§4.2 主题联动）。
 *
 * 只读状态判定 / 扩展名→Monaco 语言 id 映射 / Markdown 默认预览判定 / 主题联动，
 * 全部是不碰 Vue、不碰 DOM 的纯函数，供 CodeEditor.vue、DocPreview.vue 与后续
 * 批次（写入、diff）复用，也是单测的直接对象。
 *
 * 第一批 UI 上编辑器恒为只读（CodeEditor.vue 里 readOnly 写死 true），但
 * deriveReadonlyReason 的判定逻辑现在就写对——第二批放开可编辑时直接复用，
 * 不需要回头重新设计这条规则。
 */

import type { EditorReadonlyReason } from "../views/project-view-contract.ts";
import type { Theme } from "./theme.ts";

// ─── 只读状态判定（spec §3.3 三态表 + D19）──────────────────────────────

/**
 * 推导编辑器只读原因，优先级：已批准 > agent 运行中 > 可编辑。
 *
 * - 当前查看版本的 state 为 "approved" → "approved"（已批准的快照任何时候都
 *   只读，哪怕 agent 已经 idle——批准态是终态，不应再被改写）；
 * - 否则若当前 run 状态非终态（agent 仍在跑）→ "agent-running"（D19：人机写
 *   冲突用「agent 运行时锁定只读」解决，不做协同编辑合并）；
 * - 否则可编辑 → null。
 *
 * @param revisionState 当前查看版本的 `ArtifactRevision.state` 原文；未打开
 *   任何文件（无版本可判定）时传 null，此时无意义地返回 null（不进入只读态）。
 * @param agentStatus 当前 run 状态原文（`TaskAgentDetail.status`）；项目尚无 run 时
 *   传 null（视为「没有 agent 在跑」）。
 * @param isAgentTerminal 判定 run 状态是否终态的谓词。以依赖注入方式传入而不是
 *   直接 import `domain/tasks.ts:isTerminalStatus`，让本模块保持零耦合、纯函数，
 *   单测无需构造完整的 run 状态机。
 */
export function deriveReadonlyReason(
  revisionState: string | null,
  agentStatus: string | null,
  isAgentTerminal: (status: string) => boolean,
): EditorReadonlyReason {
  if (revisionState === null) return null;
  if (revisionState === "approved") return "approved";
  if (agentStatus !== null && !isAgentTerminal(agentStatus)) return "agent-running";
  return null;
}

// ─── 文件扩展名 → Monaco 语言 id（spec §3.3）────────────────────────────

/** 未识别扩展名的兜底语言 id（Monaco 无该语言时按纯文本渲染，不影响只读展示）。 */
export const FALLBACK_LANGUAGE = "plaintext";

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  v: "verilog",
  vh: "verilog",
  sv: "systemverilog",
  svh: "systemverilog",
  tcl: "tcl",
  xdc: "tcl", // XDC 约束文件语法上是 Tcl 的子集，复用 tcl 语言高亮
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
};

/** 扩展名（不含前导点，大小写不敏感）→ Monaco 语言 id；未知扩展名兜底 "plaintext"。 */
export function languageFromExtension(ext: string): string {
  return EXTENSION_LANGUAGE_MAP[ext.toLowerCase()] ?? FALLBACK_LANGUAGE;
}

/** 文件路径 → Monaco 语言 id（取路径最后一段的扩展名）；无路径/无扩展名兜底 "plaintext"。 */
export function languageFromPath(path: string | null): string {
  if (!path) return FALLBACK_LANGUAGE;
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return FALLBACK_LANGUAGE;
  return languageFromExtension(path.slice(dot + 1));
}

// ─── Markdown 默认预览判定（spec §3.3：".md 默认渲染视图，[源码/预览]切换") ──

/** 是否应默认走文档预览视图（当前仅 markdown；源码/预览切换由 DocPreview 内部提供）。 */
export function isDocPreviewLanguage(language: string): boolean {
  return language === "markdown";
}

// ─── Monaco 主题联动（spec §4.2：深色 vs-dark / 浅色 vs）──────────────────

export type MonacoTheme = "vs-dark" | "vs";

/** 全局主题 → Monaco 内置主题 id。 */
export function monacoThemeFor(theme: Theme): MonacoTheme {
  return theme === "dark" ? "vs-dark" : "vs";
}
