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

export function assembleVivadoTool(): AgentTool {
  return {
    name: "vivado_run",
    description:
      "提交并运行一次 Vivado 作业（经 Core jobs 端点，run_class 恒为 exploratory；Core 服务端裁决实际 run_class）。" +
      "operation∈validate_sources|simulate|synthesize|implement。sources=源文件数组（{path,content}）；" +
      "top=顶层模块名；simulate 需 testbench；implement 需 constraints。轮询到终态后返回 state/errorCode 与 evidence 清单。" +
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
        top: { type: "string", description: "顶层模块名。" },
        testbench: { type: "string", description: "Testbench 模块名（仅 simulate）。" },
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
      required: ["operation", "sources", "top"],
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

      const top = typeof argObj.top === "string" ? argObj.top.trim() : "";
      if (!top) {
        return { content: JSON.stringify({ error: "bad_args", reason: "top（顶层模块名）必填" }), isError: true };
      }

      const rawSources = Array.isArray(argObj.sources) ? argObj.sources : [];
      const sources = rawSources.map(narrowSource).filter((s): s is ArtifactFile => s !== null);
      if (sources.length === 0) {
        return {
          content: JSON.stringify({ error: "bad_args", reason: "sources 须为非空数组，每项 {path, content} 均非空" }),
          isError: true,
        };
      }

      const testbench = typeof argObj.testbench === "string" && argObj.testbench.trim() ? argObj.testbench.trim() : undefined;
      const rawConstraints = Array.isArray(argObj.constraints) ? argObj.constraints : [];
      const constraints = rawConstraints.map(narrowSource).filter((s): s is ArtifactFile => s !== null);
      const timeoutMs = typeof argObj.timeoutMs === "number" && argObj.timeoutMs > 0 ? argObj.timeoutMs : undefined;

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
