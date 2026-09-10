/**
 * Synthia Runtime — Core API connector adapter.
 *
 * Adapts the Synthia Core REST API (`/api/v1/projects/:id/jobs...`) to the
 * loop-facing {@link LoopConnector}. This is the "via-core" path: the runtime
 * no longer talks to worker 66 directly; it submits/polls jobs through Core,
 * which persists ToolRun/evidence, adjudicates run_class, and proxies the
 * Connector on its own.
 *
 * Generic contract (see SYNTHIA-RUNTIME-CORE-CONTRACT):
 *   POST /api/v1/projects/:id/jobs            → 201 {data:{jobId,runClass,state}}
 *   GET  /api/v1/projects/:id/jobs/:jobId     → 200 {data:{jobId,state,errorCode?,outputSha256?}}
 *   GET  /api/v1/projects/:id/jobs/:jobId/evidence
 *                                              → 200 {data:{jobId,entries:[{name,uri?,sha256,sizeBytes,mediaType}]}}
 *
 * Error model:
 *   - 401/403 → fail-closed "authorization"        (non-retryable)
 *   - 404     → fail-closed "not_found"            (non-retryable)
 *   - 503 / 5xx → "capability_unavailable"-style   (retryable, retried once)
 *   - network (fetch threw)                         (retryable, retried once)
 *   Every Core error envelope `{error:{code,message}}` is destructured and its
 *   `code` is carried by a thrown {@link RemoteConnectorError}. The loop's
 *   runTool() only forwards `error.code` into the audit for errors whose name
 *   is "RemoteConnectorError", so we reuse that connector-side error type
 *   verbatim (CoreApiConnector IS a connector adapter) rather than inventing a
 *   parallel type that the loop would flatten to CONNECTOR_ERROR.
 *
 * run_class: the runtime is always exploratory. We send `run_class_intent` and
 * NEVER send gate_submission_id / approved_gate_result_id / baseline_id; Core
 * adjudicates the final run_class server-side.
 */

import { randomUUID } from "node:crypto";
import { abortable } from "./execution-control.ts";
import { RemoteConnectorError } from "../connector/remote.ts";
import { submissionSha, VIVADO_CAPABILITY_VERSION } from "./loop.ts";
import { TERMINAL_STATES, jobStateToResultStatus } from "./utils.ts";
import {
  WHITELISTED_OPERATIONS,
  type ConnectorCapability,
  type EvidenceContent,
  type EvidenceManifest,
  type LoopConnector,
  type VivadoResult,
  type VivadoSubmission,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Static capability surface
// ---------------------------------------------------------------------------

/**
 * Core has no /discover endpoint — capability/version enforcement is Core's
 * responsibility (drift/lease/capability rejection surface as 503). The loop's
 * permissionGate still needs the four whitelisted operations at
 * vivado-batch-1 to admit each call, so we expose the frozen surface here.
 * `drift` is therefore always false on this connector.
 */
const CORE_API_CAPABILITIES: readonly ConnectorCapability[] = WHITELISTED_OPERATIONS.map((operation) => ({
  operation,
  version: VIVADO_CAPABILITY_VERSION,
  runClasses: ["exploratory", "gate_check", "formal"],
}));

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 500;

/** Core job states that mark a job terminal (mirrors connector/index.ts). */

// ---------------------------------------------------------------------------
// Options + env resolution
// ---------------------------------------------------------------------------

export interface CoreApiConnectorOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  /**
   * Optional Core-owned side-task binding. Both fields must be supplied
   * together. Submission, status, and evidence all remain on the task-scoped
   * route surface when this binding is present.
   */
  readonly taskId?: string;
  readonly workspaceId?: string;
  readonly connectorId?: string;
  /** Inject fetch (tests). Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly maxPollMs?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CoreApiConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Resolve Core API client config from env. Used by the CLI (--via-core) and
 * directly testable. `baseUrl` defaults to the local Core dev server;
 * `token` is REQUIRED — the runtime never talks to Core unauthenticated.
 */
export function resolveCoreApiConfig(env: Record<string, string | undefined>): CoreApiConfig {
  const token = env.SYNTHIA_CORE_TOKEN;
  if (!token || !token.trim()) {
    throw new Error("--via-core requires SYNTHIA_CORE_TOKEN (ordinary Core service token without core:task-runtime)");
  }
  const baseUrl = (env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  return { baseUrl, token };
}

/** Resolve the dedicated singleton-scope credential for task-bound calls. */
export function resolveTaskRuntimeApiConfig(
  env: Record<string, string | undefined>,
): CoreApiConfig {
  const token = env.SYNTHIA_TASK_RUNTIME_TOKEN;
  if (!token || !token.trim()) {
    throw new Error("task-bound Core access requires SYNTHIA_TASK_RUNTIME_TOKEN (singleton core:task-runtime scope)");
  }
  const baseUrl = (env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  return { baseUrl, token };
}

// ---------------------------------------------------------------------------
// CoreApiConnector
// ---------------------------------------------------------------------------

export class CoreApiConnector implements LoopConnector {
  readonly id: string;
  /** Always false: capability drift is a Connector concern, proxied by Core. */
  readonly drift = false;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly taskId?: string;
  private readonly workspaceId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly requestTimeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly retryDelayMs: number;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;

  constructor(private readonly opts: CoreApiConnectorOptions) {
    if ((opts.taskId === undefined) !== (opts.workspaceId === undefined)) {
      throw new TypeError("taskId and workspaceId must be supplied together");
    }
    this.id = opts.connectorId ?? "core-api";
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.projectId = opts.projectId;
    if (opts.taskId !== undefined && opts.workspaceId !== undefined) {
      this.taskId = requireTaskBindingIdentifier("taskId", opts.taskId);
      this.workspaceId = requireTaskBindingIdentifier("workspaceId", opts.workspaceId);
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollMs = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0
      || !Number.isFinite(this.maxPollMs) || this.maxPollMs <= 0) {
      throw new TypeError("requestTimeoutMs and maxPollMs must be positive finite numbers");
    }
    this.signal = opts.signal;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.clock = opts.now ?? Date.now;
    this.sleeper = opts.sleep ?? defaultSleep;
  }

  withSignal(signal: AbortSignal): CoreApiConnector {
    return new CoreApiConnector({ ...this.opts, signal: this.signal ? AbortSignal.any([signal, this.signal]) : signal });
  }

  async discover(): Promise<readonly ConnectorCapability[]> {
    return CORE_API_CAPABILITIES;
  }

  async submit(submission: VivadoSubmission): Promise<VivadoResult> {
    const inputSha = submissionSha(submission);
    // Client-generated jobId; reused as the Idempotency-Key. Core may adopt it
    // or mint its own job-<uuid>; we always follow the jobId Core returns.
    const idempotencyKey = `job-${randomUUID()}`;
    const body = buildSubmitBody(submission);

    const submitPath = this.taskId === undefined
      ? `/api/v1/projects/${this.projectId}/jobs`
      : `/api/v1/projects/${this.projectId}/tasks/${this.taskId}/jobs`;
    const submitted = (await this.request(
      "POST",
      submitPath,
      body,
      idempotencyKey,
    )) as { jobId: string; runClass: string; state: string };
    const jobId = submitted.jobId ?? idempotencyKey;

    const terminal = await this.pollTerminal(jobId);

    // Evidence may be absent (esp. on failure) — mirror RemoteVivadoConnector.
    let evidence: EvidenceManifest | undefined;
    if (terminal.errorCode !== "poll_timeout") {
      try {
        const ev = (await this.request(
          "GET",
          `${this.jobPath(jobId)}/evidence`,
        )) as { jobId: string; entries: EvidenceManifest["entries"] };
        evidence = { jobId, entries: ev.entries ?? [] };
      } catch (e) {
        if (!(e instanceof RemoteConnectorError) || e.code !== "not_found") throw e;
      }
    }

    return {
      status: jobStateToResultStatus(terminal.state),
      jobId,
      operation: submission.operation,
      inputSha256: inputSha,
      ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }

  async fetchEvidenceContent(jobId: string, name: string): Promise<EvidenceContent> {
    const data = (await this.request(
      "GET",
      `${this.jobPath(jobId)}/evidence/content?name=${encodeURIComponent(name)}`,
    )) as { name: string; content: string; sha256: string; truncated: boolean; mediaType: string };
    return {
      content: data.content,
      sha256: data.sha256,
      truncated: data.truncated,
      mediaType: data.mediaType,
    };
  }

  // ----- internals -----

  /** Poll GET /jobs/:jobId until terminal or the deadline expires. */
  private async pollTerminal(jobId: string): Promise<{ state: string; errorCode?: string }> {
    const deadline = this.clock() + this.maxPollMs;
    while (this.clock() < deadline) {
      try {
        const data = (await this.request("GET", this.jobPath(jobId), undefined, undefined, deadline)) as {
          state: string; errorCode?: string;
        };
        if (TERMINAL_STATES.has(data.state)) return data;
      } catch (error) {
        if (!(error instanceof RemoteConnectorError) || error.code !== "request_timeout") throw error;
        break;
      }
      await this.pause(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.clock())));
    }
    // A local polling timeout says nothing about the remote job's terminal state.
    return { state: "unknown_effect", errorCode: "poll_timeout" };
  }

  /**
   * Issue a Core API request with one bounded retry on transient failures
   * (5xx / network). Non-retryable HTTP errors (401/403/404/4xx) throw
   * immediately. Resolves to the `data` payload on 2xx.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    deadline?: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.signal?.throwIfAborted();
        const remaining = deadline === undefined ? this.requestTimeoutMs : deadline - this.clock();
        if (remaining <= 0) throw new RemoteConnectorError("request_timeout", `Core request deadline exceeded: ${path}`, true);
        const { status, json } = await this.doFetch(url, this.buildInit(method, body, idempotencyKey), Math.min(this.requestTimeoutMs, remaining));
        const err = classifyResponse(status, json);
        if (!err) return (json as { data?: unknown } | undefined)?.data;
        if (err.retryable && attempt === 0) {
          await this.pause(Math.min(this.retryDelayMs, deadline === undefined ? this.retryDelayMs : Math.max(0, deadline - this.clock())));
          continue;
        }
        throw err;
      } catch (e) {
        this.signal?.throwIfAborted();
        // Classified RemoteConnectorError (non-retryable, or retry budget spent).
        if (e instanceof RemoteConnectorError) throw e;
        // Network-level failure (fetch threw): retry once, then surface.
        if (attempt === 0) {
          await this.pause(Math.min(this.retryDelayMs, deadline === undefined ? this.retryDelayMs : Math.max(0, deadline - this.clock())));
          continue;
        }
        throw new RemoteConnectorError(
          "network_error",
          e instanceof Error ? e.message : String(e),
          true,
        );
      }
    }
    // Unreachable: the loop above always returns or throws.
    throw new RemoteConnectorError("request_failed", "Core API request failed after retry", false);
  }

  private pause(ms: number): Promise<void> {
    return this.signal ? abortable(() => this.sleeper(ms), this.signal) : this.sleeper(ms);
  }

  private async doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal?.reason);
    this.signal?.addEventListener("abort", onAbort, { once: true });
    if (this.signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new RemoteConnectorError(
      "request_timeout", `Core request timed out: ${url}`, true,
    )), timeoutMs);
    try {
      return await abortable(async () => {
        const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
        const text = await res.text();
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        return { status: res.status, json };
      }, controller.signal);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }

  private buildInit(method: "GET" | "POST", body?: unknown, idempotencyKey?: string): RequestInit {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (this.taskId !== undefined && this.workspaceId !== undefined) {
      headers["X-Synthia-Task-Id"] = this.taskId;
      headers["X-Synthia-Workspace-Id"] = this.workspaceId;
    }
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }
    return { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  }

  private jobPath(jobId: string): string {
    const projectJobs = `/api/v1/projects/${this.projectId}/jobs/${jobId}`;
    return this.taskId === undefined
      ? projectJobs
      : `/api/v1/projects/${this.projectId}/tasks/${this.taskId}/jobs/${jobId}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function requireTaskBindingIdentifier(field: string, value: string): string {
  if (
    value.length === 0 ||
    value.length > 160 ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new TypeError(`${field} is not a valid Core task binding identifier`);
  }
  return value;
}


/** Map a Core HTTP response into a RemoteConnectorError (or null when OK). */
function classifyResponse(status: number, json: unknown): RemoteConnectorError | null {
  if (status >= 200 && status < 300) return null;
  const env = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
  const code = env?.code;
  const message = env?.message;
  if (status === 401 || status === 403) {
    return new RemoteConnectorError(code ?? "authorization", message ?? "authorization", false);
  }
  if (status === 404) {
    return new RemoteConnectorError(code ?? "not_found", message ?? "not_found", false);
  }
  if (status >= 500 && status <= 599) {
    return new RemoteConnectorError(code ?? "capability_unavailable", message ?? "capability_unavailable", true);
  }
  // Other 4xx (400/409/422...): non-retryable; carry the Core code if present.
  return new RemoteConnectorError(code ?? `http_${status}`, message ?? `HTTP ${status}`, status === 408 || status === 429);
}

/** Build the POST /jobs body strictly per Contract; run_class_intent fixed exploratory. */
function buildSubmitBody(submission: VivadoSubmission): Record<string, unknown> {
  const body: Record<string, unknown> = {
    operation: submission.operation,
    run_class_intent: "exploratory",
    sources: submission.sources.map(toSourceInput),
    top: submission.top,
    part: submission.part,
  };
  if (submission.operation === "simulate" && submission.testbench) body.testbench = submission.testbench;
  if (submission.operation === "implement" && submission.constraints?.length) {
    body.constraints = submission.constraints.map(toSourceInput);
  }
  if (submission.operation === "implement" && submission.stopBeforeBitstream !== undefined) {
    body.stop_before_bitstream = submission.stopBeforeBitstream;
  }
  if (submission.timeoutMs !== undefined) body.timeout_ms = submission.timeoutMs;
  return body;
}

function toSourceInput(f: { path: string; content: string; mediaType?: string }) {
  return { path: f.path, content: f.content, ...(f.mediaType ? { mediaType: f.mediaType } : {}) };
}
