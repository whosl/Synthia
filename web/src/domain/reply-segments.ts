/**
 * free-agent 回复分段与折叠规则（信息流 UX：长代码块不再刷屏）。
 *
 * 规则（Contract 前端部分）：
 * - ``` 围栏代码块超过 {@link CODE_CARD_LINE_THRESHOLD} 行 → 折叠为「代码卡」
 *   （语言/文件名推断 + 行数 + 点击展开）；≤ 阈值内联展示，行为不变。
 * - 未围栏的长文本（如直接粘贴的日志）同理折叠。
 * - 语言/文件名从围栏 info 串推断：` ```verilog `、` ```counter.v `、
 *   ` ```verilog counter.v ` 三种形态都支持；文件名可推断语言。
 *
 * 分段基于 marked lexer（与 renderMarkdown 同源，围栏判定一致）。
 */

import { marked } from "marked";

/** 代码块/长文本折叠阈值（行）：超过即折叠。 */
export const CODE_CARD_LINE_THRESHOLD = 15;

export interface ReplyCodeSegment {
  readonly kind: "code";
  readonly id: string;
  /** 代码原文（已去尾部换行）。 */
  readonly code: string;
  readonly lineCount: number;
  /** 语言显示名（如 Verilog）；无法推断为 null。 */
  readonly language: string | null;
  /** 文件名（围栏 info 串推断）；无为 null。 */
  readonly filename: string | null;
  /** lineCount > 阈值。 */
  readonly collapsible: boolean;
}

export interface ReplyTextSegment {
  readonly kind: "text";
  readonly id: string;
  /** Markdown 原文（渲染走 renderMarkdown）。 */
  readonly text: string;
  readonly lineCount: number;
  /** lineCount > 阈值（未围栏长文本同理折叠）。 */
  readonly collapsible: boolean;
}

export type ReplySegment = ReplyCodeSegment | ReplyTextSegment;

/** 统计文本行数（忽略尾部空行；空串为 0）。 */
export function countLines(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

/** 语言标识 → 显示名。 */
const LANGUAGE_DISPLAY: Readonly<Record<string, string>> = {
  verilog: "Verilog",
  systemverilog: "SystemVerilog",
  sv: "SystemVerilog",
  vhdl: "VHDL",
  tcl: "Tcl",
  xdc: "XDC",
  sdc: "SDC",
  json: "JSON",
  jsonc: "JSON",
  python: "Python",
  py: "Python",
  typescript: "TypeScript",
  ts: "TypeScript",
  javascript: "JavaScript",
  js: "JavaScript",
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  markdown: "Markdown",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  h: "C/C++ 头文件",
  text: "文本",
  plain: "文本",
  log: "日志",
};

/** 扩展名 → 语言标识（文件名推断语言用）。 */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ".v": "verilog",
  ".sv": "systemverilog",
  ".vhd": "vhdl",
  ".vhdl": "vhdl",
  ".tcl": "tcl",
  ".xdc": "xdc",
  ".sdc": "sdc",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".ts": "typescript",
  ".js": "javascript",
  ".sh": "bash",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".c": "c",
  ".h": "h",
  ".cpp": "cpp",
  ".log": "log",
  ".txt": "text",
};

/** 文件名形态：`name.ext`（路径允许，扩展名必填；`verilog` 这类裸词不算）。 */
const FILENAME_PATTERN = /^(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]+$/;

export interface FenceInfo {
  readonly language: string | null;
  readonly filename: string | null;
}

/**
 * 解析围栏 info 串（如 `verilog counter.v` / `counter.v` / `verilog`）。
 * 语言显示名：命中映射表取中文/标准名，未命中保留原串；仅有文件名时按扩展名推断。
 */
export function parseFenceInfo(info: string): FenceInfo {
  let langToken: string | null = null;
  let filename: string | null = null;
  for (const token of info.trim().split(/\s+/)) {
    if (!token) continue;
    if (filename === null && FILENAME_PATTERN.test(token)) {
      filename = token;
    } else if (langToken === null) {
      langToken = token;
    }
  }

  let language: string | null = null;
  if (langToken !== null) {
    language = LANGUAGE_DISPLAY[langToken.toLowerCase()] ?? langToken;
  } else if (filename !== null) {
    const dot = filename.lastIndexOf(".");
    const ext = filename.slice(dot).toLowerCase();
    const langId = EXTENSION_LANGUAGE[ext];
    language = langId ? (LANGUAGE_DISPLAY[langId] ?? langId) : null;
  }
  return { language, filename };
}

/**
 * free-agent 回复原文 → 分段数组（文本/代码按出现顺序）。
 * 连续非代码 token 合并为一个文本段；纯空白段丢弃。
 */
export function segmentAgentReply(source: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let textBuf = "";

  const flushText = () => {
    const text = textBuf.trim();
    textBuf = "";
    if (!text) return;
    const lineCount = countLines(text);
    segments.push({
      kind: "text",
      id: `seg-${segments.length}`,
      text,
      lineCount,
      collapsible: lineCount > CODE_CARD_LINE_THRESHOLD,
    });
  };

  for (const token of marked.lexer(source)) {
    if (token.type === "code") {
      flushText();
      const code = token.text.replace(/\n+$/, "");
      const lineCount = countLines(code);
      const { language, filename } = parseFenceInfo(token.lang ?? "");
      segments.push({
        kind: "code",
        id: `seg-${segments.length}`,
        code,
        lineCount,
        language,
        filename,
        collapsible: lineCount > CODE_CARD_LINE_THRESHOLD,
      });
    } else {
      textBuf += token.raw;
    }
  }
  flushText();
  return segments;
}

/** 构造单个文本段（工具条展开区长文本复用同一折叠组件）。 */
export function makeTextSegment(id: string, text: string): ReplyTextSegment {
  const lineCount = countLines(text);
  return { kind: "text", id, text, lineCount, collapsible: lineCount > CODE_CARD_LINE_THRESHOLD };
}

/**
 * 展开状态切换（纯函数，供折叠组件与视图共用；返回新 Set 以触发响应式）。
 */
export function toggleSetKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
