/**
 * 顶栏「运行校验/仿真/…」按钮的作业参数推导（纯函数 + 注入式文件读取）。
 *
 * UI 上一次点击要变成一个合法的 POST /projects/:id/jobs 请求，缺的 三件事从
 * 工作区推：源文件清单（.v/.sv 内联全文）、约束（.xdc）、top/testbench 模块名。
 * 推导规则刻意与 connector 侧保持同源（tb 目录启发式见 vivado.ts 的
 * simulate 路由；.xdc 白名单见约束校验），保证「UI 推导出什么就提交什么，
 * 连接器不会二次拒绝」。top 取「声明了却没被任何文件例化」的模块，与
 * P4 formal 的 oneModule 同一思路，但允许多模块层级里唯一悬空者当选。
 */

import type { JobSourceInput } from "../api/types.ts";

/** 运行按钮需要的最小工作区事实（来自 getWorkspaceTree）。 */
export interface WorkspaceRunFile {
  readonly path: string;
}

/** 惰性文件内容读取（getWorkspaceFile 的注入点，便于测试）。 */
export type WorkspaceFileLoader = (path: string) => Promise<string>;

export type ImplRunDerivation =
  | {
    readonly ok: true;
    readonly sources: readonly JobSourceInput[];
    readonly constraints: readonly JobSourceInput[];
    readonly top: string | null;
    readonly testbench: string | null;
  }
  | { readonly ok: false; readonly reason: string };

const RTL_RE = /\.(?:v|sv)$/i;
const XDC_RE = /\.xdc$/i;
/** 与 connector/vivado.ts simulate 路由的 tb 目录启发式保持一致。 */
const TB_PATH_RE = /(^|\/)(?:tb|test|tests|testbench)(?:\/|$)/i;

/** 去注释/字符串后扫描模块声明（独立实现，不牵动 Core P4 的门禁判定）。 */
export function moduleNames(content: string): string[] {
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");
  return [...clean.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g)].map(match => match[1]!);
}

/** `name #(...) inst (` 形态的例化探测；声明行（name 与 ( 直接相邻）不会误报。 */
function isInstantiated(name: string, contents: readonly string[]): boolean {
  const pattern = new RegExp(
    `\\b${name}\\b\\s*(?:#\\s*\\([^;]*?\\))?\\s*[A-Za-z_][A-Za-z0-9_$]*\\s*\\(`,
  );
  return contents.some(content => {
    const clean = content
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:\\.|[^"\\])*"/g, " ");
    return pattern.test(clean);
  });
}

/** 集合里未被例化的模块（顶层候选）；全部被例化 → 空数组。 */
function danglingModules(files: readonly { path: string; content: string }[]): string[] {
  const declared = new Set(files.flatMap(file => moduleNames(file.content)));
  const allContents = files.map(file => file.content);
  return [...declared].filter(name => !isInstantiated(name, allContents)).sort();
}

/**
 * 从工作区推导一次工具作业的完整参数。deriveTop/deriveTb 关闭时对应字段为
 * null（validate_sources 不需要模块名）；开着时推导失败 → ok:false + 人话原因。
 */
export async function deriveJobInputs(
  files: readonly WorkspaceRunFile[],
  loadContent: WorkspaceFileLoader,
  options: { readonly deriveTop?: boolean; readonly deriveTb?: boolean } = {},
): Promise<ImplRunDerivation> {
  const rtlPaths = files.map(file => file.path).filter(path => RTL_RE.test(path));
  if (rtlPaths.length === 0) {
    return { ok: false, reason: "工作区里没有 .v/.sv 源文件，无可运行内容" };
  }
  const xdcPaths = files.map(file => file.path).filter(path => XDC_RE.test(path));

  const sources: JobSourceInput[] = [];
  try {
    for (const path of rtlPaths) {
      sources.push({
        path,
        content: await loadContent(path),
        mediaType: path.toLowerCase().endsWith(".sv") ? "text/systemverilog" : "text/verilog",
      });
    }
  } catch (err) {
    return { ok: false, reason: `读取源文件失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const constraints: JobSourceInput[] = [];
  try {
    for (const path of xdcPaths) {
      constraints.push({ path, content: await loadContent(path), mediaType: "text/plain" });
    }
  } catch (err) {
    return { ok: false, reason: `读取约束文件失败：${err instanceof Error ? err.message : String(err)}` };
  }

  let top: string | null = null;
  if (options.deriveTop) {
    const design = sources.filter(source => !TB_PATH_RE.test(source.path));
    if (design.length === 0) {
      return { ok: false, reason: "工作区里除 tb/ 目录外没有设计源文件，无法确定设计顶层" };
    }
    const dangling = danglingModules(design);
    if (dangling.length === 0) {
      return { ok: false, reason: "没有找到悬空的顶层模块（所有模块都被例化）——请确认设计顶层" };
    }
    if (dangling.length > 1) {
      return { ok: false, reason: `顶层模块不唯一（${dangling.join("、")}）——请先明确设计顶层` };
    }
    top = dangling[0]!;
  }

  let testbench: string | null = null;
  if (options.deriveTb) {
    const tbFiles = sources.filter(source => TB_PATH_RE.test(source.path));
    if (tbFiles.length === 0) {
      return { ok: false, reason: "工作区里没有 testbench（应放在 tb/、test/ 等目录）" };
    }
    const dangling = danglingModules(tbFiles);
    if (dangling.length === 0) {
      return { ok: false, reason: "tb 文件里没有悬空的 testbench 顶层——请确认 testbench 模块名" };
    }
    if (dangling.length > 1) {
      return { ok: false, reason: `testbench 顶层不唯一（${dangling.join("、")}）——请先明确要跑哪一个` };
    }
    testbench = dangling[0]!;
    if (testbench === top) {
      return { ok: false, reason: "testbench 与设计顶层同名，连接器会拒绝（SAME_TOP_TESTBENCH）" };
    }
  }

  return { ok: true, sources, constraints, top, testbench };
}

/** 按钮操作 → 请求参数的公共部分（stop_before_bitstream 由调用方按按钮补）。 */
export type ImplRunOperation = SubmitJobOperation;

export type SubmitJobOperation = "validate_sources" | "simulate" | "synthesize" | "implement" | "report_sta";

/** 一颗运行按钮对应的作业语义；码流/布局布线同为 implement，仅码流标志不同。 */
export interface ImplRunAction {
  readonly key: "validate" | "simulate" | "synthesize" | "implement" | "bitstream" | "sta";
  readonly operation: SubmitJobOperation;
  readonly stopBeforeBitstream?: boolean;
  readonly label: string;
}

/** 哪些操作需要推导设计顶层 / testbench。 */
export function operationNeeds(operation: SubmitJobOperation): { readonly top: boolean; readonly tb: boolean } {
  switch (operation) {
    case "validate_sources":
      return { top: false, tb: false };
    case "simulate":
      return { top: true, tb: true };
    case "synthesize":
    case "implement":
    case "report_sta":
      return { top: true, tb: false };
  }
}
