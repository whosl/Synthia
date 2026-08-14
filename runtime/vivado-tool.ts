/**
 * Synthia Runtime — Vivado job tool for the free-agent mode (spec 001-agent-freedom).
 *
 * `vivado_run` submits a versioned vivado operation (validate_sources / simulate
 * / synthesize / implement) through the CoreApiConnector → Core `POST /jobs`
 * endpoint (the connector polls to a terminal state internally). The agent only
 * ever issues exploratory run-class intents; Core adjudicates the real
 * `run_class` server-side.
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

/** Narrow a model-produced source entry to a safe ArtifactFile (fail-closed). */
function narrowSource(v: unknown): ArtifactFile | null {
  if (!isPlainObject(v)) return null;
  const path = typeof v.path === "string" ? v.path : "";
  const content = typeof v.content === "string" ? v.content : "";
  if (!path || content === "") return null;
  return { path, content, ...(typeof v.mediaType === "string" ? { mediaType: v.mediaType } : {}) };
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
      "operation∈validate_sources|simulate|synthesize|implement。sources=源文件数组（{path,content}，include TB 文件以便推断 testbench）；" +
      "top=顶层模块名，可省略：系统从 sources 自动推断（顶层=未被其他文件例化且声明于非 tb 路径文件的模块）；显式填写时与推断校验，不一致将被拒绝并给出正确值。" +
      "simulate 需 testbench（同样可省略自动推断：例化了 top 的未例化模块，优先取 tb 路径文件中的）；implement 需 constraints。轮询到终态后返回 state/errorCode 与 evidence 清单。" +
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
              path: { type: "string" },
              content: { type: "string" },
              mediaType: { type: "string" },
            },
            required: ["path", "content"],
          },
          description: "RTL/TB 源文件（validate_sources/simulate 至少 1 个；synthesize/implement 为 RTL 源）。",
        },
        top: { type: "string", description: "顶层模块名。省略时自动推断；显式填写与推断不一致会被拒绝并给出正确值。" },
        testbench: { type: "string", description: "Testbench 模块名（仅 simulate）。省略时自动推断（例化了 top 的未例化模块）。" },
        constraints: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
          description: "XDC 约束文件（仅 implement）。",
        },
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
      const sources = rawSources.map(narrowSource).filter((s): s is ArtifactFile => s !== null);
      if (sources.length === 0) {
        return {
          content: JSON.stringify({ error: "bad_args", reason: "sources 须为非空数组，每项 {path, content} 均非空" }),
          isError: true,
        };
      }

      const rawConstraints = Array.isArray(argObj.constraints) ? argObj.constraints : [];
      const constraints = rawConstraints.map(narrowSource).filter((s): s is ArtifactFile => s !== null);
      const timeoutMs = typeof argObj.timeoutMs === "number" && argObj.timeoutMs > 0 ? argObj.timeoutMs : undefined;

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
        ...(errorCode ? { errorCode } : {}),
        ...(result.stderr ? { stderr: capDiagnostic(result.stderr) } : {}),
        ...(result.stdout ? { stdout: capDiagnostic(result.stdout) } : {}),
        evidence: evidenceEntries.map((e) => ({ name: e.name, uri: e.uri, mediaType: e.mediaType, sizeBytes: e.sizeBytes })),
      };

      // On a normal simulation/compile failure (not fail-closed), pull the
      // structured worker-result.json so the model gets exitCode/phase + stdout/
      // stderr tails rather than blind repair. Degrades to the manifest-only
      // summary above on any fetch/parse error (existing behavior).
      if (result.status === "failed" && !failClosed) {
        const hasResult = evidenceEntries.some((e) => e.name === WORKER_RESULT_NAME);
        let diagnosticsFetched = false;
        if (hasResult) {
          try {
            const c = await connector.fetchEvidenceContent(result.jobId, WORKER_RESULT_NAME);
            const parsed = JSON.parse(c.content) as { exitCode?: number; phase?: string; stdout?: string; stderr?: string };
            const headerParts: string[] = [];
            if (parsed.phase) headerParts.push(`phase=${parsed.phase}`);
            if (parsed.exitCode !== undefined) headerParts.push(`exitCode=${parsed.exitCode}`);
            summary.failureDiagnostics = {
              ...(headerParts.length > 0 ? { summary: headerParts.join(", ") } : {}),
              stdout: capDiagnostic(parsed.stdout ?? ""),
              stderr: capDiagnostic(parsed.stderr ?? ""),
            };
            diagnosticsFetched = true;
          } catch {
            diagnosticsFetched = false;
          }
        }
        summary.diagnosticsFetched = diagnosticsFetched;
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

/** Bound a diagnostic string to 2000 chars, marking the elided tail. */
function capDiagnostic(s: string): string {
  return s.length <= 2000 ? s : s.slice(0, 2000) + `\n…(truncated, ${s.length - 2000} more chars)`;
}
