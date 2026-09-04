/**
 * Synthia Runtime — Vivado job tool for the free-agent mode (spec 001-agent-freedom).
 *
 * `vivado_run` submits a versioned vivado operation (validate_sources / simulate
 * / synthesize / implement) through the CoreApiConnector → Core `POST /jobs`
 * endpoint (the connector polls to a terminal state internally). The agent only
 * ever issues exploratory run-class intents; Core adjudicates the real
 * `run_class` server-side.
 *
 * **Sources are named, not pasted.** The model passes `{path}` and the runtime
 * fetches the bytes from the project workspace (`GET workspace/file`). Before
 * this, `sources` carried the full text inline, which meant nothing tied the
 * bytes sent to Vivado to the revision registered in Core — the model retyped
 * them, and a single dropped line made the evidence describe code that was never
 * registered. Under GJB that gap is the whole point of the traceability chain,
 * so the tool result now reports each file's sha256 and whether those exact
 * bytes are a registered revision.
 *
 * Reuses the pipeline loop's permission gate + fail-closed code set so the
 * capability / drift / lease semantics are identical to the loop. On a
 * fail-closed condition the tool returns an `isError` result (the model can
 * surface it); on a normal simulation/compile failure it returns the available
 * diagnostics (state + errorCode + evidence manifest) so the model can attempt a
 * repair. Evidence content fetching is a follow-up batch; this tool faithfully
 * returns the evidence manifest (entry list) it can see.
 */

import type { AgentTool, AgentToolResult, ToolExecContext } from "./agent-types.ts";
import type { ArtifactFile, VivadoSubmission, WhitelistedOperation } from "./types.ts";
import { WHITELISTED_OPERATIONS } from "./types.ts";
import {
  permissionGate,
  FAIL_CLOSED_CODES,
  PermissionDeniedError,
  FailClosedError,
  WORKER_RESULT_NAME,
} from "./loop.ts";

const WHITELIST_SET: Readonly<Record<string, true>> = Object.fromEntries(
  WHITELISTED_OPERATIONS.map((o) => [o, true]),
) as Readonly<Record<string, true>>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A workspace path the model named, plus any (discouraged) inline text it pasted. */
interface SourceRef {
  readonly path: string;
  /** Inline text the model sent anyway — kept only to cross-check the workspace bytes. */
  readonly inlineContent: string | null;
}

/** Narrow a model-produced source entry to a workspace path (fail-closed). */
function narrowSourceRef(v: unknown): SourceRef | null {
  if (!isPlainObject(v)) return null;
  const path = typeof v.path === "string" ? v.path.trim() : "";
  if (!path) return null;
  return { path, inlineContent: typeof v.content === "string" ? v.content : null };
}

/** A resolved source: workspace bytes + the identity of those bytes in Core. */
interface ResolvedSource {
  readonly file: ArtifactFile;
  readonly sha256: string;
  readonly registered: boolean;
  readonly revisionId: string | null;
  readonly version: number | null;
  readonly commit: string | null;
}

/** Why one named path could not become a source file. */
interface SourceFailure {
  readonly path: string;
  readonly reason: string;
}

/**
 * Fetch each named path's **current** workspace bytes from Core.
 *
 * Reads are sequential on purpose: a wrong path list should surface as one clear
 * "these files aren't in the workspace" message, not as a burst of concurrent
 * 404s. The lists are short (a handful of RTL files), so the latency is noise.
 *
 * A model that pasted `content` anyway gets a hard error when its text differs
 * from the workspace — silently preferring one over the other is how the bytes
 * sent to Vivado stop matching the bytes registered in Core.
 */
async function resolveSources(
  ctx: ToolExecContext,
  refs: readonly SourceRef[],
): Promise<{ resolved: ResolvedSource[]; failures: SourceFailure[] }> {
  const resolved: ResolvedSource[] = [];
  const failures: SourceFailure[] = [];
  for (const ref of refs) {
    let file: {
      path: string;
      encoding: "utf8" | "base64";
      content: string | null;
      contentHash: string;
      registered: boolean;
      revisionId: string | null;
      version: number | null;
      commit: string | null;
    };
    try {
      if (ctx.taskKind === "side") {
        if (!ctx.workspace) throw new Error("Core-issued task workspace capability is missing");
        const isolated = await ctx.workspace.readFile(ref.path);
        file = {
          ...isolated,
          registered: false,
          revisionId: null,
          version: null,
        };
      } else {
        file = await ctx.governance.readWorkspaceFile(ref.path);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ path: ref.path, reason: msg });
      continue;
    }
    if (file.encoding !== "utf8" || file.content === null) {
      failures.push({ path: ref.path, reason: "Vivado 源文件必须是 UTF-8 文本，不能是二进制工作区文件。" });
      continue;
    }
    if (ref.inlineContent !== null && ref.inlineContent !== file.content) {
      failures.push({
        path: ref.path,
        reason:
          "你在 content 里贴的正文与工作区当前内容不一致。vivado_run 只编译工作区里的字节；" +
          "要改这个文件，请先用对应技能把新内容写进工作区（会登记成下一版），再运行本工具。",
      });
      continue;
    }
    resolved.push({
      file: { path: file.path, content: file.content },
      sha256: file.contentHash,
      registered: file.registered,
      revisionId: file.revisionId,
      version: file.version,
      commit: file.commit,
    });
  }
  return { resolved, failures };
}

// ---------------------------------------------------------------------------
// Verilog 模块图解析 + top/testbench 推断（参数防呆 1）
// ---------------------------------------------------------------------------
//
// 目标：消灭 p7 实证的两类参数错误——(a) top/testbench 填成同名（Core 以
// SAME_TOP_TESTBENCH 拒绝）；(b) 把 testbench 模块名填进 top。规则（确定性、
// 可测试的简化启发式）：
//   1. 每个源文件用行首 `module NAME` 提取全部模块声明（多模块文件取全部）。
//   2. 例化检测：文件正文中出现 `NAME [#(...)] instance (` 形态（剥离注释与
//      module 声明头后匹配）。被非 tb 文件例化 ⇒ 子模块。
//   3. 路径含 tb/testbench 段（由分隔符界定）的文件视为 testbench 文件。
//   4. top 候选 = 声明于非 tb 文件、未被任何非 tb 文件（含自身文件）例化的
//      模块；恰一个 ⇒ 采纳。
//   5. testbench 候选 = 未被任何文件例化、且其声明文件例化了 top 的模块
//      （优先取声明于 tb 路径文件者）；top 唯一且候选恰一个 ⇒ 采纳。
// 已知简化：不解析字符串字面量/编译指令；`#(...)` 参数列表用非贪婪跨行匹配。

/** 路径含 tb/testbench 段（如 `tb/`、`_tb.`、`/tb_`）的文件视为 testbench 文件。 */
const TB_PATH_RE = /(?:^|[\\/._-])(?:tb|testbench)(?=$|[\\/._-])/i;

/** 行首 module 声明（多模块文件全部提取）。 */
const MODULE_DECL_RE = /^[ \t]*module\s+([A-Za-z_][A-Za-z0-9_$]*)/gm;

/** 剥离 Verilog 注释（保留换行与非换行占位，维持行首锚点有效）。 */
function stripVerilogComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** 剥离 module 声明头（至首个分号），使例化扫描不会把声明误判为例化。 */
function stripModuleHeaders(content: string): string {
  return content.replace(/^[ \t]*module\s+[A-Za-z_][A-Za-z0-9_$]*[\s\S]*?;/gm, "");
}

/** 检测 body 中是否存在 `NAME [#(...)] instance (` 形态的例化。 */
function isInstantiatedIn(name: string, body: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    "(?:^|[^\\w$.])" + esc + "\\s*(?:#\\s*\\([\\s\\S]*?\\))?\\s*[A-Za-z_][\\w$]*\\s*\\(",
  ).test(body);
}

/** sources 的模块依赖图（推断 top/testbench 的底座）。 */
export interface ModuleGraph {
  /** 模块名 → 声明文件 path（重名时以首个声明为准）。 */
  readonly declFile: ReadonlyMap<string, string>;
  /** 文件 path → 该文件声明的模块名（按声明顺序）。 */
  readonly modulesByFile: ReadonlyMap<string, readonly string[]>;
  /** 模块名 → 例化了它的文件集合（含声明文件自身的同文件例化）。 */
  readonly instantiatedIn: ReadonlyMap<string, ReadonlySet<string>>;
  /** 文件 path → 剥离注释与声明头后的正文（例化扫描缓存）。 */
  readonly bodyByFile: ReadonlyMap<string, string>;
}

/** 解析 sources 的模块声明与例化关系。纯函数，供单测直接使用。 */
export function buildModuleGraph(sources: readonly ArtifactFile[]): ModuleGraph {
  const declFile = new Map<string, string>();
  const modulesByFile = new Map<string, string[]>();
  const bodyByFile = new Map<string, string>();
  for (const s of sources) {
    const stripped = stripVerilogComments(s.content);
    const names: string[] = [];
    for (const m of stripped.matchAll(MODULE_DECL_RE)) {
      if (!declFile.has(m[1])) declFile.set(m[1], s.path);
      names.push(m[1]);
    }
    modulesByFile.set(s.path, names);
    bodyByFile.set(s.path, stripModuleHeaders(stripped));
  }
  const instantiatedIn = new Map<string, Set<string>>();
  for (const s of sources) {
    const body = bodyByFile.get(s.path)!;
    for (const [name, file] of declFile) {
      if (file === s.path || instantiatedIn.get(name)?.has(s.path)) continue;
      if (isInstantiatedIn(name, body)) {
        let set = instantiatedIn.get(name);
        if (!set) {
          set = new Set();
          instantiatedIn.set(name, set);
        }
        set.add(s.path);
      }
    }
    // 同文件例化（单文件层级）也会使模块沦为子模块：计入 instantiatedIn。
    for (const name of modulesByFile.get(s.path) ?? []) {
      if (isInstantiatedIn(name, body)) {
        let set = instantiatedIn.get(name);
        if (!set) {
          set = new Set();
          instantiatedIn.set(name, set);
        }
        set.add(s.path);
      }
    }
  }
  return { declFile, modulesByFile, instantiatedIn, bodyByFile };
}

/** 推断出的模块引用（名字 + 声明文件，用于错误指引）。 */
export interface InferredModuleRef {
  readonly name: string;
  readonly file: string;
}

/** top/testbench 推断结果。top/testbench 仅在候选唯一时给出。 */
export interface TopTestbenchInference {
  /** 推断出的 top（候选恰一个时存在）。 */
  readonly top?: InferredModuleRef;
  /** 推断出的 testbench（top 唯一且候选恰一个时存在；仅 needTestbench 时计算）。 */
  readonly testbench?: InferredModuleRef;
  /** top 候选清单（声明于非 tb 文件且未被任何非 tb 文件例化的模块）。 */
  readonly topCandidates: readonly string[];
  /** testbench 候选清单（未被例化且其文件例化了 top；tb 路径文件优先）。 */
  readonly testbenchCandidates: readonly string[];
  /** sources 中声明的全部模块名（候选清单提示/未知 top 校验用）。 */
  readonly declaredModules: readonly string[];
}

/** 从 sources 推断 top/testbench。纯函数，供单测直接使用。 */
export function inferTopAndTestbench(
  sources: readonly ArtifactFile[],
  needTestbench: boolean,
): TopTestbenchInference {
  const g = buildModuleGraph(sources);
  const declaredModules = [...g.declFile.keys()];
  const isTbPath = (p: string) => TB_PATH_RE.test(p);
  const nonTbFiles = new Set(sources.map((s) => s.path).filter((p) => !isTbPath(p)));

  // top 候选：声明于非 tb 文件，且没有任何非 tb 文件（含自身声明文件）例化它。
  const topCandidates = declaredModules.filter((name) => {
    if (!nonTbFiles.has(g.declFile.get(name)!)) return false;
    for (const f of g.instantiatedIn.get(name) ?? []) {
      if (nonTbFiles.has(f)) return false;
    }
    return true;
  });

  if (topCandidates.length !== 1) {
    return { topCandidates, testbenchCandidates: [], declaredModules };
  }

  const top: InferredModuleRef = { name: topCandidates[0], file: g.declFile.get(topCandidates[0])! };

  if (!needTestbench) {
    return { top, topCandidates, testbenchCandidates: [], declaredModules };
  }

  // testbench 候选：自身未被任何文件例化，且其声明文件例化了 top。
  const rawTbCandidates = declaredModules.filter((name) => {
    if (name === top.name) return false;
    if ((g.instantiatedIn.get(name)?.size ?? 0) > 0) return false;
    const file = g.declFile.get(name)!;
    if (file === top.file) return false;
    return isInstantiatedIn(top.name, g.bodyByFile.get(file)!);
  });
  const hinted = rawTbCandidates.filter((n) => isTbPath(g.declFile.get(n)!));
  const testbenchCandidates = hinted.length > 0 ? hinted : rawTbCandidates;

  return {
    top,
    ...(testbenchCandidates.length === 1
      ? { testbench: { name: testbenchCandidates[0], file: g.declFile.get(testbenchCandidates[0])! } }
      : {}),
    topCandidates,
    testbenchCandidates,
    declaredModules,
  };
}

export function assembleVivadoTool(): AgentTool {
  return {
    name: "vivado_run",
    description:
      "提交并运行一次 Vivado 作业（经 Core jobs 端点，run_class 恒为 exploratory；Core 服务端裁决实际 run_class）。" +
      "operation∈validate_sources|simulate|synthesize|implement。" +
      "sources=**工作区文件路径**数组（{path}，如 rtl/pwm.v；不要贴正文，正文由系统从工作区读取；simulate 时把 TB 文件一并列出以便推断 testbench）。" +
      "文件必须先存在于工作区（由技能工具写入），否则本工具拒绝执行并列出缺失路径。" +
      "top=顶层模块名，可省略：系统从 sources 自动推断（顶层=未被其他文件例化且声明于非 tb 路径文件的模块）；显式填写时与推断校验，不一致将被拒绝并给出正确值。" +
      "simulate 需 testbench（同样可省略自动推断：例化了 top 的未例化模块，优先取 tb 路径文件中的）；implement 需 constraints；stopBeforeBitstream=true 会完成布局布线和报告但绝不调用 write_bitstream。轮询到终态后返回 state/errorCode 与 evidence 清单，" +
      "并回报每个源文件的 sha256 与它对应的登记修订（证据指向确定的字节）。" +
      "能力漂移/租约/能力不可用等按 fail-closed 返回错误（不静默）；仿真/编译失败返回可得诊断（errorCode/stderr/evidence 清单）。",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["validate_sources", "simulate", "synthesize", "implement"] },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，如 rtl/pwm.v、tb/pwm_tb.v。" },
            },
            required: ["path"],
          },
          description:
            "RTL/TB 源文件的**工作区路径**（validate_sources/simulate 至少 1 个；synthesize/implement 为 RTL 源）。只给路径，不要贴正文。",
        },
        top: { type: "string", description: "顶层模块名。省略时自动推断；显式填写与推断不一致会被拒绝并给出正确值。" },
        testbench: { type: "string", description: "Testbench 模块名（仅 simulate）。省略时自动推断（例化了 top 的未例化模块）。" },
        constraints: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string", description: "工作区相对路径，如 prj/constr/top.xdc。" } },
            required: ["path"],
          },
          description: "XDC 约束文件的工作区路径（仅 implement）。只给路径，不要贴正文。",
        },
        stopBeforeBitstream: { type: "boolean", description: "仅 implement；为 true 时停在生成码流前，仍生成 DCP/DRC/STA/资源报告。" },
        timeoutMs: { type: "number", description: "可选超时（毫秒）。" },
      },
      required: ["operation", "sources"],
    },

    async execute(args: unknown, ctx: ToolExecContext): Promise<AgentToolResult> {
      const connector = ctx.connector;
      if (!connector) {
        return {
          content: JSON.stringify({
            error: "no_connector",
            reason: "无可用 Vivado Connector（经 Core 提交）。fail-closed：未执行作业。",
          }),
          isError: true,
        };
      }

      const argObj = isPlainObject(args) ? args : {};
      const operation = typeof argObj.operation === "string" ? argObj.operation : "";
      if (!WHITELIST_SET[operation]) {
        return {
          content: JSON.stringify({
            error: "bad_operation",
            reason: `operation "${operation}" 不在白名单 [${WHITELISTED_OPERATIONS.join(", ")}]`,
          }),
          isError: true,
        };
      }

      const providedTop = typeof argObj.top === "string" ? argObj.top.trim() : "";
      const providedTestbench =
        typeof argObj.testbench === "string" && argObj.testbench.trim() ? argObj.testbench.trim() : "";

      const rawSources = Array.isArray(argObj.sources) ? argObj.sources : [];
      const sourceRefs = rawSources.map(narrowSourceRef).filter((s): s is SourceRef => s !== null);
      if (sourceRefs.length === 0) {
        return {
          content: JSON.stringify({
            error: "bad_args",
            reason: "sources 须为非空数组，每项形如 {path: \"rtl/pwm.v\"}（工作区相对路径，不要贴正文）",
          }),
          isError: true,
        };
      }

      const rawConstraints = Array.isArray(argObj.constraints) ? argObj.constraints : [];
      const constraintRefs = rawConstraints.map(narrowSourceRef).filter((s): s is SourceRef => s !== null);
      const timeoutMs = typeof argObj.timeoutMs === "number" && argObj.timeoutMs > 0 ? argObj.timeoutMs : undefined;
      const stopBeforeBitstream = typeof argObj.stopBeforeBitstream === "boolean" ? argObj.stopBeforeBitstream : undefined;

      // --- 从工作区取正文（模型只给了路径）---
      // 放在 permission gate 之前：路径写错是模型自己能修的错，不该先占用连接器的
      // discover 往返，也不该在错误里混进能力/租约的噪音。
      const src = await resolveSources(ctx, sourceRefs);
      const con = await resolveSources(ctx, constraintRefs);
      const failures = [...src.failures, ...con.failures];
      if (failures.length > 0) {
        return {
          content: JSON.stringify({
            error: "sources_unavailable",
            reason:
              `以下文件无法从工作区取得，未提交作业（fail-closed）：` +
              failures.map((f) => `${f.path}（${f.reason}）`).join("；") +
              `。请先用相应技能把它们写进工作区，或核对路径（工作区相对路径，如 rtl/pwm.v）。`,
            failed: failures.map((f) => f.path),
          }),
          isError: true,
        };
      }
      const sources = src.resolved.map((r) => r.file);
      const constraints = con.resolved.map((r) => r.file);

      // --- 参数防呆：top/testbench 自动推断与显式校验 ---
      const needTestbench = operation === "simulate";
      const inference = inferTopAndTestbench(sources, needTestbench);
      const guidance = inference.top
        ? `top 应为 "${inference.top.name}"（来自 ${inference.top.file}）` +
          (inference.testbench
            ? `，testbench 应为 "${inference.testbench.name}"（来自 ${inference.testbench.file}）`
            : "")
        : "";

      let top = providedTop;
      let testbench = providedTestbench || undefined;
      let topInferred = false;
      let testbenchInferred = false;

      if (!top) {
        if (!inference.top) {
          const reason =
            inference.topCandidates.length === 0
              ? `无法从 sources 推断 top：没有「声明于非 tb 路径文件且未被其他文件例化」的顶层模块。` +
                `已声明的模块：${inference.declaredModules.join(", ") || "（无）"}。请显式填写 top，或补充可定位顶层的源文件。`
              : `无法唯一推断 top（候选：${inference.topCandidates.join(", ")}）。` +
                `请显式填写 top（顶层 = 未被其他文件例化的模块）。`;
          return {
            content: JSON.stringify({
              error: inference.topCandidates.length === 0 ? "no_top_candidate" : "ambiguous_top",
              reason,
              candidates: inference.topCandidates,
              declaredModules: inference.declaredModules,
            }),
            isError: true,
          };
        }
        top = inference.top.name;
        topInferred = true;
      } else if (inference.top && inference.top.name !== top) {
        return {
          content: JSON.stringify({
            error: "top_mismatch",
            reason:
              `top 参数防呆：${guidance}；你填写的是 "${top}"，与推断不一致（常见原因：把 testbench 模块名填进了 top）。` +
              `请改用推断值，或修正 sources。`,
            expected: inference.top,
            ...(inference.testbench ? { expectedTestbench: inference.testbench } : {}),
          }),
          isError: true,
        };
      } else if (!inference.declaredModules.includes(top)) {
        return {
          content: JSON.stringify({
            error: "unknown_top",
            reason:
              `top "${top}" 未在任何 source 文件中声明。` +
              `已声明的模块：${inference.declaredModules.join(", ") || "（无）"}。请核对模块名（区分大小写）。`,
            declaredModules: inference.declaredModules,
          }),
          isError: true,
        };
      }

      if (needTestbench) {
        if (!testbench) {
          if (!inference.testbench) {
            const reason =
              inference.testbenchCandidates.length === 0
                ? `无法推断 testbench：sources 中没有「未被例化且其声明文件例化了 top "${top}"」的模块。` +
                  `请在 sources 中加入声明 testbench 模块（例化 top）的文件（建议路径含 tb/ 段），或显式填写 testbench。`
                : `无法唯一推断 testbench（候选：${inference.testbenchCandidates.join(", ")}）。请显式填写 testbench。`;
            return {
              content: JSON.stringify({
                error: inference.testbenchCandidates.length === 0 ? "no_testbench_candidate" : "ambiguous_testbench",
                reason,
                top,
                candidates: inference.testbenchCandidates,
              }),
              isError: true,
            };
          }
          testbench = inference.testbench.name;
          testbenchInferred = true;
        } else if (testbench === top) {
          return {
            content: JSON.stringify({
              error: "same_top_testbench",
              reason:
                `top 与 testbench 不能相同（均为 "${top}"）。` +
                (guidance || `testbench 应是例化了 top "${top}" 的独立模块，请修正参数。`),
            ...(inference.top ? { expected: inference.top } : {}),
            ...(inference.testbench ? { expectedTestbench: inference.testbench } : {}),
          }),
          isError: true,
        };
        } else if (inference.testbench && inference.testbench.name !== testbench) {
          return {
            content: JSON.stringify({
              error: "testbench_mismatch",
              reason:
                `testbench 参数防呆：${guidance}；你填写的 testbench 是 "${testbench}"，与推断不一致。` +
                `请改用推断值，或修正 sources。`,
              expectedTestbench: inference.testbench,
            }),
            isError: true,
          };
        }
        // 推断不可用（0 候选）时放行显式 testbench：TB 模块可能未包含在 sources 内，交给 Core 裁决。
      }

      const submission: VivadoSubmission = {
        operation: operation as WhitelistedOperation,
        runClass: "exploratory",
        projectId: ctx.projectId,
        sources,
        top,
        part: ctx.part,
        ...(testbench ? { testbench } : {}),
        ...(constraints.length > 0 ? { constraints } : {}),
        ...(operation === "implement" && stopBeforeBitstream !== undefined ? { stopBeforeBitstream } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      };

      // --- permission gate (whitelist + versioned capability + drift) ---
      let capabilities;
      try {
        capabilities = await connector.discover();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({ error: "discover_failed", reason, failClosed: true }),
          isError: true,
        };
      }

      let version: string;
      try {
        version = permissionGate(operation, connector.drift, capabilities);
      } catch (e) {
        const code = e instanceof FailClosedError
          ? e.code
          : e instanceof PermissionDeniedError
            ? "PERMISSION_DENIED"
            : "GATE_ERROR";
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({ error: "permission_denied", code, reason, failClosed: e instanceof FailClosedError }),
          isError: true,
        };
      }

      // --- submit + poll to terminal ---
      let result;
      try {
        result = await connector.submit(submission);
      } catch (e) {
        const code = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "CONNECTOR_ERROR";
        const reason = e instanceof Error ? e.message : String(e);
        return {
          content: JSON.stringify({
            error: "connector_error",
            code,
            reason,
            operation,
            top,
            capabilityVersion: version,
            failClosed: FAIL_CLOSED_CODES.has(code) || connector.drift,
          }),
          isError: true,
        };
      }

      const errorCode = result.errorCode ?? "";
      const failClosed =
        result.status === "unsupported" ||
        result.status === "unknown_effect" ||
        FAIL_CLOSED_CODES.has(errorCode) ||
        connector.drift;

      const evidenceEntries = result.evidence?.entries ?? [];

      // 送去编译的每一份字节的出处。`registered:false` 是**如实报告**而非错误：工作区
      // 里带着未登记改动的文件照样可以先编译再登记，但证据必须说清这一点，否则读的人
      // 会以为跑的是那条已登记的修订。
      const allInputs = [...src.resolved, ...con.resolved];
      const unregistered = allInputs.filter((r) => !r.registered).map((r) => r.file.path);
      const commits = [...new Set(allInputs.map((r) => r.commit).filter((c): c is string => c !== null))];

      const summary: Record<string, unknown> = {
        operation,
        top,
        // 防呆 1：标记 top/testbench 来自系统自动推断（未填）还是模型显式填写。
        ...(topInferred ? { topInferred: true } : {}),
        ...(testbenchInferred ? { testbenchInferred: true } : {}),
        ...(testbench ? { testbench } : {}),
        part: ctx.part,
        state: result.status,
        jobId: result.jobId,
        inputSha256: result.inputSha256,
        capabilityVersion: version,
        // 编译的是工作区里的这些字节——路径 + sha256 + 它们对应的登记修订。
        inputs: allInputs.map((r) => ({
          path: r.file.path,
          sha256: r.sha256,
          registered: r.registered,
          ...(r.revisionId ? { revisionId: r.revisionId } : {}),
          ...(r.version !== null ? { version: r.version } : {}),
        })),
        ...(commits.length === 1 ? { workspaceCommit: commits[0] } : {}),
        ...(unregistered.length > 0
          ? {
              unregisteredInputs: unregistered,
              unregisteredNote:
                "这些文件在工作区里带有尚未登记的改动，本次编译用的是它们的当前字节，而不是任何一条已登记修订。" +
                "结论要进门禁前，请先把它们登记成候选修订。",
            }
          : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(result.stderr ? { stderr: diagnosticExcerpt(result.stderr) } : {}),
        ...(result.stdout ? { stdout: diagnosticExcerpt(result.stdout) } : {}),
        evidence: evidenceEntries.map((e) => ({ name: e.name, uri: e.uri, mediaType: e.mediaType, sizeBytes: e.sizeBytes })),
      };

      // Diagnostics for the model: prefer the worker's structured log digest
      // (synthia-log-digest.v1, a small dedicated evidence file), then the
      // logDigest embedded in worker-result.json, then degrade to smart
      // excerpts of worker-result's simulator/stdout streams. On success we
      // still surface the compact digest (pass markers / phase trail) so the
      // model can cite what actually passed, not just the state field.
      const wantsDiagnostics = (result.status === "failed" || result.status === "succeeded") && !failClosed;
      if (wantsDiagnostics) {
        const diagnostics = await fetchDiagnostics(connector, result.jobId, evidenceEntries);
        if (result.status === "failed" && diagnostics) {
          summary.failureDiagnostics = diagnostics.diagnostics;
          summary.diagnosticsSource = diagnostics.source;
        } else if (result.status === "succeeded" && diagnostics?.digest) {
          summary.logDigest = compactDigest(diagnostics.digest);
        }
      }

      if (failClosed) {
        summary.failClosed = true;
        summary.note = "fail-closed：能力漂移/租约/能力不可用等致命条件；已停止，不自动重试。";
      }

      return {
        content: JSON.stringify(summary),
        ...(failClosed ? { isError: true } : {}),
      };
    },
  };
}

/** Line classification mirroring the worker's log digest (connector/log-digest.ts). */
const DIAGNOSTIC_FAILURE_RE = /^\s*(?:ERROR\b|Fatal:|\*\s*Error|FAIL\b)/;
const DIAGNOSTIC_WARNING_RE = /^\s*(?:CRITICAL WARNING\b|WARNING\b|WARN\b)/;
const DIAGNOSTIC_SIM_FAILURE_RE = /(?:\$fatal|\bFatal:)/;
const DIAGNOSTIC_PASS_RE = /\bPASS/;
const DIAGNOSTIC_PHASE_RE = /^(?:PHASE=\S+|PHASE_EXIT_CODE=\d+|SOURCE_VALIDATION_OK|SIMULATION_OK|SYNTHIA_DRC_FAILED|SYNTHIA_TIMING_FAILED|SYNTHIA_TIMING_UNCONSTRAINED)$/;

export interface DiagnosticExcerptPart { readonly kind: "head" | "failure" | "pass" | "warning" | "phase" | "tail"; readonly text: string }

/**
 * Content-aware log excerpt. Position windows (head or tail slices) are wrong
 * for Vivado logs: batch runs put project-generation noise up front and TB
 * assertions at the end, but multi-scenario TBs interleave errors anywhere.
 * This keeps the head banner, every classified line with 2 lines of context
 * (capped), phase markers, and the tail verdict — with elision counts so the
 * reader knows what was dropped. Returns the whole string when it fits.
 */
export function diagnosticExcerptParts(s: string, cap = 2000): DiagnosticExcerptPart[] {
  if (s.length <= cap) return [{ kind: "head", text: s }];
  const lines = s.split(/\r?\n/);
  const parts: DiagnosticExcerptPart[] = [];
  const budget = () => cap - parts.reduce((n, p) => n + p.text.length + 1, 0);
  const emit = (kind: DiagnosticExcerptPart["kind"], text: string, maxLines = 1): boolean => {
    let block = "";
    const chosen: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (chosen.length >= maxLines) break;
      const candidate = line.length > 400 ? `${line.slice(0, 400)}…` : line;
      if (block.length + candidate.length + 2 > budget()) break;
      chosen.push(candidate);
      block = chosen.join("\n");
    }
    if (chosen.length === 0) return false;
    parts.push({ kind, text: block });
    return true;
  };

  emit("head", lines.slice(0, 3).join("\n"));
  let failureKept = 0;
  let elided = 0;
  for (let i = 0; i < lines.length && failureKept < 10; i++) {
    const line = lines[i]!;
    const isFailure = DIAGNOSTIC_FAILURE_RE.test(line) || DIAGNOSTIC_SIM_FAILURE_RE.test(line);
    const isPass = DIAGNOSTIC_PASS_RE.test(line) && !isFailure;
    const isWarning = DIAGNOSTIC_WARNING_RE.test(line);
    const isPhase = DIAGNOSTIC_PHASE_RE.test(line);
    if (!isFailure && !isPass && !isWarning && !isPhase) continue;
    const context: string[] = [];
    if (isFailure) {
      for (let j = i - 1; j >= 0 && context.length < 2; j--) {
        const prev = lines[j]!;
        if (prev.trim().length > 0) context.unshift(prev.length > 200 ? `${prev.slice(0, 200)}…` : prev);
      }
    }
    const block = [...context, line.length > 400 ? `${line.slice(0, 400)}…` : line].join("\n");
    const kind: DiagnosticExcerptPart["kind"] = isFailure ? "failure" : isPhase ? "phase" : isPass ? "pass" : "warning";
    if (budget() - 40 <= 0) { elided++; continue; }
    parts.push({ kind, text: block });
    if (isFailure) failureKept++;
  }
  emit("tail", lines.slice(-5).join("\n"), 5);
  return parts;
}

export function diagnosticExcerpt(s: string, cap = 2000): string {
  const parts = diagnosticExcerptParts(s, cap);
  return parts.length === 1 ? parts[0]!.text
    : parts.map((p, i) => (i === 0 ? p.text : `«${p.kind}»\n${p.text}`)).join("\n…(elided)…\n");
}

/** Wire shape of connector/log-digest.ts's synthia-log-digest.v1. */
export interface WireLogDigest {
  readonly schema?: string;
  readonly counts?: { failure?: number; warning?: number; pass?: number };
  readonly failureLines?: readonly { source?: string; index?: number; line?: string; contextBefore?: readonly string[] }[];
  readonly warningLines?: readonly { line?: string }[];
  readonly passLines?: readonly { line?: string }[];
  readonly phaseMarkers?: readonly string[];
  readonly scanned?: { stdout?: number; stderr?: number; simulator?: number };
  readonly truncated?: boolean;
}

function isLogDigest(v: unknown): v is WireLogDigest {
  return isPlainObject(v) && (v as WireLogDigest).schema === "synthia-log-digest.v1";
}

function compactDigest(digest: WireLogDigest): WireLogDigest {
  return {
    schema: digest.schema,
    counts: digest.counts,
    passLines: digest.passLines,
    phaseMarkers: digest.phaseMarkers,
    ...(digest.truncated !== undefined ? { truncated: digest.truncated } : {}),
  };
}

interface FetchedDiagnostics {
  readonly source: "log-digest.json" | "worker-result.json";
  readonly digest?: WireLogDigest;
  readonly diagnostics?: Record<string, unknown>;
}

export async function fetchDiagnostics(
  connector: { fetchEvidenceContent(jobId: string, name: string): Promise<{ content: string }> },
  jobId: string,
  evidenceEntries: readonly { name: string }[],
): Promise<FetchedDiagnostics | undefined> {
  // 1) Dedicated digest file (a few KB; produced by workers ≥ this change).
  if (evidenceEntries.some((e) => e.name === "log-digest.json")) {
    try {
      const c = await connector.fetchEvidenceContent(jobId, "log-digest.json");
      const parsed = JSON.parse(c.content) as unknown;
      if (isLogDigest(parsed)) {
        return {
          source: "log-digest.json",
          digest: parsed,
          diagnostics: { logDigest: parsed },
        };
      }
    } catch { /* fall through */ }
  }
  // 2) worker-result.json: embedded digest, else smart stream excerpts. The
  // old head-slice here is what blinded repair loops to TB assertions.
  if (!evidenceEntries.some((e) => e.name === WORKER_RESULT_NAME)) return undefined;
  try {
    const c = await connector.fetchEvidenceContent(jobId, WORKER_RESULT_NAME);
    const parsed = JSON.parse(c.content) as {
      exitCode?: number; phase?: string; stdout?: string; stderr?: string; simulatorStdout?: string; logDigest?: unknown;
    };
    const headerParts: string[] = [];
    if (parsed.phase) headerParts.push(`phase=${parsed.phase}`);
    if (parsed.exitCode !== undefined) headerParts.push(`exitCode=${parsed.exitCode}`);
    const diagnostics: Record<string, unknown> = {
      ...(headerParts.length > 0 ? { summary: headerParts.join(", ") } : {}),
      ...(parsed.simulatorStdout !== undefined ? { simulatorStdout: diagnosticExcerpt(parsed.simulatorStdout) } : {}),
      ...(parsed.stdout !== undefined ? { stdout: diagnosticExcerpt(parsed.stdout) } : {}),
      ...(parsed.stderr ? { stderr: diagnosticExcerpt(parsed.stderr) } : {}),
    };
    const digest = isLogDigest(parsed.logDigest) ? parsed.logDigest : undefined;
    if (digest) diagnostics.logDigest = digest;
    return { source: "worker-result.json", ...(digest ? { digest } : {}), diagnostics };
  } catch {
    return undefined;
  }
}
