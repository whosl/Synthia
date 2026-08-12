/**
 * Synthia Runtime — Core API connector adapter.
 *
 * Adapts the Synthia Core REST API (`/api/v1/projects/:id/jobs...`) to the
 * loop-facing {@link LoopConnector}. This is the "via-core" path: the runtime
 * no longer talks to worker 66 directly; it submits/polls jobs through Core,
 * which persists ToolRun/evidence, adjudicates run_class, and proxies the
 * Connector on its own.
 *
 * Contract (see SYNTHIA-RUNTIME-CORE-CONTRACT):
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
import { RemoteConnectorError } from "../connector/remote.ts";
import { submissionSha, VIVADO_CAPABILITY_VERSION } from "./loop.ts";
import {
  WHITELISTED_OPERATIONS,
  type ConnectorCapability,
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
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect",
]);

// ---------------------------------------------------------------------------
// Options + env resolution
// ---------------------------------------------------------------------------

export interface CoreApiConnectorOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly connectorId?: string;
  /** Inject fetch (tests). Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly maxPollMs?: number;
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
    throw new Error("--via-core requires SYNTHIA_CORE_TOKEN (Core service token with core:read/core:write scopes)");
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
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;

  constructor(opts: CoreApiConnectorOptions) {
    this.id = opts.connectorId ?? "core-api";
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.projectId = opts.projectId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollMs = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.clock = opts.now ?? Date.now;
    this.sleeper = opts.sleep ?? defaultSleep;
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

    const submitted = (await this.request(
      "POST",
      `/api/v1/projects/${this.projectId}/jobs`,
      body,
      idempotencyKey,
    )) as { jobId: string; runClass: string; state: string };
    const jobId = submitted.jobId ?? idempotencyKey;

    const terminal = await this.pollTerminal(jobId);

    // Evidence may be absent (esp. on failure) — mirror RemoteVivadoConnector.
    let evidence: EvidenceManifest | undefined;
    try {
      const ev = (await this.request(
        "GET",
        `/api/v1/projects/${this.projectId}/jobs/${jobId}/evidence`,
      )) as { jobId: string; entries: EvidenceManifest["entries"] };
      evidence = { jobId, entries: ev.entries ?? [] };
    } catch (e) {
      if (!(e instanceof RemoteConnectorError) || e.code !== "not_found") throw e;
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

  // ----- internals -----

  /** Poll GET /jobs/:jobId until terminal or the deadline expires. */
  private async pollTerminal(jobId: string): Promise<{ state: string; errorCode?: string }> {
    const deadline = this.clock() + this.maxPollMs;
    let last: { state: string; errorCode?: string } = { state: "queued" };
    while (this.clock() < deadline) {
      const data = (await this.request(
        "GET",
        `/api/v1/projects/${this.projectId}/jobs/${jobId}`,
      )) as { jobId: string; state: string; errorCode?: string; outputSha256?: string };
      last = { state: data.state, ...(data.errorCode ? { errorCode: data.errorCode } : {}) };
      if (TERMINAL_STATES.has(data.state)) return last;
      await this.sleeper(this.pollIntervalMs);
    }
    return { ...last, state: "timeout" };
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
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { status, json } = await this.doFetch(url, this.buildInit(method, body, idempotencyKey));
        const err = classifyResponse(status, json);
        if (!err) return (json as { data?: unknown } | undefined)?.data;
        if (err.retryable && attempt === 0) {
          await this.sleeper(this.retryDelayMs);
          continue;
        }
        throw err;
      } catch (e) {
        // Classified RemoteConnectorError (non-retryable, or retry budget spent).
        if (e instanceof RemoteConnectorError) throw e;
        // Network-level failure (fetch threw): retry once, then surface.
        if (attempt === 0) {
          await this.sleeper(this.retryDelayMs);
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

  private async doFetch(url: string, init: RequestInit): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json };
  }

  private buildInit(method: "GET" | "POST", body?: unknown, idempotencyKey?: string): RequestInit {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }
    return { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
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

function jobStateToResultStatus(state: string): VivadoResult["status"] {
  switch (state) {
    case "succeeded": return "succeeded";
    case "timeout": return "timeout";
    case "lost": return "lost";
    case "unknown_effect": return "unknown_effect";
    default: return "failed"; // failed | cancelled → failed
  }
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
  if (submission.timeoutMs !== undefined) body.timeout_ms = submission.timeoutMs;
  return body;
}

function toSourceInput(f: { path: string; content: string; mediaType?: string }) {
  return { path: f.path, content: f.content, ...(f.mediaType ? { mediaType: f.mediaType } : {}) };
}
