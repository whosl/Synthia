/**
 * Synthia Core API — Runtime task proxy (UI-2 task workbench slice)
 *
 * Core forwards task lifecycle requests to the Runtime HTTP service
 * (runtime/server.ts) WITHOUT persistencing task truth. Core's role is:
 *   1. project ownership validation (project exists, process instance belongs
 *      to the project, the run's project_id matches the path);
 *   2. lazy default process instance provisioning (one project → one G0→G9
 *      main flow, materialized as process_instance "pi-default:<projectId>");
 *   3. envelope + error-model translation between Runtime's error vocabulary
 *      and Core's stable {@link ApiError} model.
 *
 * The Runtime client is an injectable port so tests drive an in-process fake
 * against a real PostgreSQL instance; production builds an HttpRuntimeClient
 * from `SYNTHIA_RUNTIME_URL` (default http://127.0.0.1:8790). When the client
 * is absent or the Runtime is unreachable, task endpoints surface 503
 * capability_unavailable (retryable), mirroring the Connector slice's behavior.
 *
 * Idempotency: POST /projects/:id/tasks requires an Idempotency-Key and stores
 * the forwarded Runtime response in `idempotency_records` (same table, same
 * semantics as every other write) so a same-key replay returns the original
 * runId WITHOUT re-contacting the Runtime.
 */

import {
  appendOutboxEventInTx,
  claimIdempotencySlot,
  completeIdempotencySlot,
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import { canonicalRequestHash } from "../hashing.ts";
import {
  ApiError,
  capabilityUnavailableError,
  conflictApiError,
  internalError,
  notFoundError,
  validationError,
} from "./errors.ts";
import type { HandlerResult, RequestContext } from "./handlers.ts";

// ─── Runtime task shapes (mirror runtime/server.ts contract) ─────────────────

export type RuntimeTaskStatus =
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "fail_closed";

/** A doc/artifact registered by the Runtime against Core. */
export interface RuntimeDocRef {
  readonly phase: string;
  readonly path: string;
  readonly artifact_id: string;
  readonly revision_id: string;
}

/** Condensed audit entry returned by GET /tasks/:runId (last ~50). */
export interface RuntimeAuditEntry {
  readonly ts: string;
  readonly seq: number;
  readonly category: string;
  readonly phase?: string;
  readonly action?: string;
  readonly result?: string;
  readonly detail?: string;
}

/** Evidence summary entry for a terminal run. */
export interface RuntimeEvidenceEntry {
  readonly job_id: string;
  readonly operation: string;
  readonly status: string;
  readonly entries?: ReadonlyArray<{ name: string; sha256: string; size_bytes: number; media_type: string }>;
}

export interface RuntimeRunSummary {
  readonly run_id: string;
  readonly project_id: string;
  readonly status: RuntimeTaskStatus;
  readonly current_stage?: string;
  readonly awaiting_gate?: string;
  readonly created_at?: string;
}

export interface RuntimeRunDetail {
  readonly run_id: string;
  readonly project_id: string;
  readonly status: RuntimeTaskStatus;
  readonly current_stage?: string;
  readonly awaiting_gate?: string;
  readonly docs?: readonly RuntimeDocRef[];
  readonly audit?: readonly RuntimeAuditEntry[];
  readonly evidence?: readonly RuntimeEvidenceEntry[];
  readonly reason?: string;
}

export interface RuntimeListResponse {
  readonly runs: readonly RuntimeRunSummary[];
}

export interface RuntimeCreateResponse {
  readonly run_id: string;
}

// ─── Runtime client port ─────────────────────────────────────────────────────

/**
 * The operations Core performs against the Runtime. Every method may reject
 * with a {@link RuntimeClientError}; the handler layer maps those to stable
 * API errors. Absence of a client (Runtime not configured) → 503.
 */
export interface RuntimeClient {
  /** POST /tasks — asynchronously start a loop run. */
  createTask(body: {
    project_id: string;
    process_instance_id: string;
    task: string;
    part?: string;
    /** "agent" = free-agent session only (do not start the pipeline loop). */
    mode?: "agent";
  }): Promise<RuntimeCreateResponse>;
  /** GET /tasks — list runs filtered by project. */
  listTasks(projectId: string): Promise<RuntimeListResponse>;
  /** GET /tasks/:runId — fetch a single run's detail. */
  getTask(runId: string): Promise<RuntimeRunDetail>;
  /** POST /tasks/:runId/message — free-agent conversation (prompt/steer). */
  sendMessage(runId: string, text: string): Promise<unknown>;
  /** POST /tasks/:runId/abort — abort the free-agent session. */
  abortTask(runId: string): Promise<unknown>;
}

/**
 * Failure reported by (or mapped from) the Runtime. `status` carries the
 * Runtime HTTP status when available so the handler can map a 404/400
 * transparently; `code` is a stable Runtime-side vocabulary token when the
 * Runtime emits an error envelope.
 */
export class RuntimeClientError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;
  constructor(status: number, message: string, opts: { code?: string | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "RuntimeClientError";
    this.status = status;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable ?? status >= 500;
  }
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8790";
const DEFAULT_RUNTIME_TIMEOUT_MS = 15_000;

/**
 * Production {@link RuntimeClient} backed by the Runtime HTTP service.
 *
 * Uses `fetch` + an AbortController timeout. Network failures, connection
 * resets, timeouts, and Runtime 5xx responses all surface as a retryable
 * RuntimeClientError (status 503), so the handler maps them to a single
 * capability_unavailable. Runtime 4xx responses are passed through with their
 * status so a 404 (unknown run) / 400 (malformed task) maps to the matching
 * Core error.
 */
export class HttpRuntimeClient implements RuntimeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_RUNTIME_URL).trim();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // AbortController abort (timeout) vs. a genuine network failure both mean
      // the Runtime is currently unreachable → retryable 503.
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new RuntimeClientError(503, aborted ? "runtime request timed out" : "runtime unreachable", {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      // Pass through the Runtime's structured error envelope when present.
      const code = payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload
        && payload.error !== null && typeof payload.error === "object" && !Array.isArray(payload.error) && "code" in payload.error
        && typeof payload.error.code === "string"
          ? payload.error.code
          : null;
      const message = payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload
        && payload.error !== null && typeof payload.error === "object" && !Array.isArray(payload.error) && "message" in payload.error
        && typeof payload.error.message === "string"
          ? payload.error.message
          : `runtime error: ${response.status}`;
      throw new RuntimeClientError(response.status, message, {
        code,
        retryable: response.status >= 500,
      });
    }
    return payload as T;
  }

  async createTask(body: {
    project_id: string;
    process_instance_id: string;
    task: string;
    part?: string;
  }): Promise<RuntimeCreateResponse> {
    return this.request<RuntimeCreateResponse>("POST", "/tasks", body);
  }

  async listTasks(projectId: string): Promise<RuntimeListResponse> {
    return this.request<RuntimeListResponse>("GET", `/tasks?project_id=${encodeURIComponent(projectId)}`);
  }

  async getTask(runId: string): Promise<RuntimeRunDetail> {
    return this.request<RuntimeRunDetail>("GET", `/tasks/${encodeURIComponent(runId)}`);
  }

  async sendMessage(runId: string, text: string): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(runId)}/message`, { text });
  }

  async abortTask(runId: string): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(runId)}/abort`);
  }
}

export interface RuntimeEnvOptions {
  /** Env source. Default: `process.env`. */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Build an {@link HttpRuntimeClient} from environment, or return undefined when
 * the Runtime is explicitly disabled. Returns undefined — never throws — so a
 * misconfigured server still boots and surfaces 503 on task endpoints rather
 * than failing to start. SYNTHIA_RUNTIME_URL defaults to
 * http://127.0.0.1:8790; set SYNTHIA_RUNTIME_URL="none" to disable.
 */
export function createRuntimeClientFromEnv(opts: RuntimeEnvOptions = {}): RuntimeClient | undefined {
  const env = opts.env ?? process.env;
  const url = (env.SYNTHIA_RUNTIME_URL ?? "").trim();
  if (url === "none") return undefined;
  return new HttpRuntimeClient({ baseUrl: url || DEFAULT_RUNTIME_URL });
}

// ─── handler helpers ─────────────────────────────────────────────────────────

/** Resolve the Runtime client or fail closed (503) when none is configured. Mirrors requireConnector. */
function requireRuntime(ctx: RequestContext): RuntimeClient {
  if (!ctx.runtimeClient) throw capabilityUnavailableError("runtime not configured");
  return ctx.runtimeClient;
}

/** Map a Runtime failure to a stable API error. */
function mapRuntimeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof RuntimeClientError) {
    // Runtime 404 → Core not_found; Runtime 400 → Core validation; 409 → conflict;
    // everything else (5xx, network, timeout) → retryable 503 capability_unavailable.
    if (err.status === 404) return notFoundError(err.message, err.code ? { code: err.code } : null);
    if (err.status === 400) return validationError(err.message, err.code ? { code: err.code } : null);
    if (err.status === 409) return conflictApiError(err.message, err.code ? { code: err.code } : null, err.retryable);
    return capabilityUnavailableError(err.message, err.code ? { code: err.code } : null);
  }
  return internalError(err instanceof Error ? err.message : "runtime error");
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw validationError(`field '${key}' must be a non-empty string`);
  return v;
}

function nullableString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw validationError(`field '${key}' must be a string`);
  return v;
}

/** Read the `id` field of the first row of a pg query result, narrowing safely. */
function firstRowId(rows: unknown[]): string {
  const row = rows[0];
  if (row && typeof row === "object" && !(row instanceof Array) && "id" in row && typeof row.id === "string") {
    return row.id;
  }
  throw internalError("PROCESS_INSTANCE_UNEXPECTED_STATE");
}

/**
 * Resolve the process instance for a task POST. When the caller supplies a
 * `process_instance_id`, it MUST belong to the project (else 404). When
 * omitted, lazily provision the project's single default main-flow instance
 * ("pi-default:<projectId>") — idempotent + concurrency-safe via ON CONFLICT.
 * Returns the resolved process instance id.
 *
 * Note: process_instance.id is a GLOBAL text PRIMARY KEY (schema.sql:40), so a
 * bare literal "pi-default" would collide across projects. The project-scoped
 * deterministic suffix keeps it unique-per-project while remaining stable for
 * idempotent re-provisioning.
 */
async function resolveProcessInstance(tx: TransactionClient, projectId: string, explicitId: string | null): Promise<string> {
  const projectRow = await tx.query("SELECT 1 FROM project WHERE id = $1", [projectId]);
  if (projectRow.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);

  if (explicitId) {
    const { rows } = await tx.query("SELECT 1 FROM process_instance WHERE id = $1 AND project_id = $2", [explicitId, projectId]);
    if (rows.length === 0) throw notFoundError(`process instance not found or not in project: ${explicitId}`);
    return explicitId;
  }

  // Lazily provision / reuse the project's default main-flow instance. First
  // reuse any existing instance for the project; only when none exists do we
  // create the deterministic default ("pi-default:<projectId>"). The ON CONFLICT
  // guard keeps concurrent first-time POSTs for the same project from racing —
  // both attempt the insert, exactly one wins, then the SELECT returns the
  // single surviving row.
  const existing = await tx.query("SELECT id FROM process_instance WHERE project_id = $1 ORDER BY created_at LIMIT 1", [projectId]);
  if (existing.rows.length > 0) return firstRowId(existing.rows);

  const defaultId = `pi-default:${projectId}`;
  await tx.query(
    `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
     VALUES ($1,$2,'flow-v1','G0')
     ON CONFLICT (id) DO NOTHING`,
    [defaultId, projectId],
  );
  const { rows } = await tx.query("SELECT id FROM process_instance WHERE project_id = $1 ORDER BY created_at LIMIT 1", [projectId]);
  return firstRowId(rows);
}

// ─── idempotent forward ──────────────────────────────────────────────────────

async function runIdempotent<T>(
  ctx: RequestContext,
  operation: string,
  projectId: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");

  const scope = {
    actorType: ctx.identity.actorType,
    actorId: ctx.identity.actorId,
    projectId,
    operation,
    key: ctx.idempotencyKey,
  };
  const requestHash = canonicalRequestHash(ctx.body);

  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      const claim = await claimIdempotencySlot(tx, scope, requestHash);
      if (claim.owned) {
        const result = await work(tx);
        await completeIdempotencySlot(tx, scope, requestHash, result);
        return result;
      }
      if (!claim.existing) throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
      if (claim.existing.requestHash !== requestHash) throw conflictApiError("IDEMPOTENCY_CONFLICT", { operation });
      if (claim.existing.status !== "completed") throw conflictApiError("IDEMPOTENCY_IN_PROGRESS", { operation }, true);
      const response = claim.existing.response;
      return typeof response === "string" ? (JSON.parse(response) as T) : (response as T);
    });
  } finally {
    conn.release();
  }
}

function outboxEvent(tx: TransactionClient, ctx: RequestContext, aggregate: { type: string; id: string }, eventType: string, payload: unknown): Promise<number> {
  return appendOutboxEventInTx(tx, {
    eventId: crypto.randomUUID(),
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    eventType,
    projectId: ctx.params.projectId ?? "",
    payload,
    correlationId: ctx.correlationId,
    causationId: null,
    classification: ctx.classification,
  });
}

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * POST /projects/:projectId/tasks — start a Runtime loop run for this project.
 *
 * Body: `{ task, part? }` (and optionally an explicit `process_instance_id`,
 * which MUST belong to the project). Core lazily provisions the default main-
 * flow process instance when none is supplied, then forwards to the Runtime's
 * POST /tasks with `project_id` + `process_instance_id` injected. The forwarded
 * response `{ run_id }` is translated to `{ runId }` and stored idempotently so
 * a same-key replay returns the original runId without re-contacting the
 * Runtime. Core emits a `task.forwarded` outbox event (observability only —
 * task truth lives in the Runtime).
 */
export async function createTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const runtime = requireRuntime(ctx);
  const body = asObject(ctx.body);
  const task = requireString(body, "task");
  const part = nullableString(body, "part");
  const mode = nullableString(body, "mode");
  const explicitPi = nullableString(body, "process_instance_id");

  const result = await runIdempotent<{ runId: string }>(ctx, "create_task", projectId, async (tx) => {
    const processInstanceId = await resolveProcessInstance(tx, projectId, explicitPi);

    let response: RuntimeCreateResponse;
    try {
      response = await runtime.createTask({
        project_id: projectId,
        process_instance_id: processInstanceId,
        task,
        part: part ?? undefined,
        ...(mode === "agent" ? { mode: "agent" } : {}),
      });
    } catch (err) {
      throw mapRuntimeError(err);
    }

    await outboxEvent(tx, ctx, { type: "task", id: response.run_id }, "task.forwarded", {
      runId: response.run_id,
      projectId,
      processInstanceId,
    });
    return { runId: response.run_id };
  });

  return { status: 201, data: result };
}

/**
 * GET /projects/:projectId/tasks — list task runs for this project.
 *
 * Core forwards to Runtime GET /tasks and filters to runs whose project_id
 * matches the path. The Runtime is the authority for task state.
 */
export async function listTasksHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const runtime = requireRuntime(ctx);

  // Validate the project exists (cheap ownership guard before forwarding).
  const projectRow = await ctx.pool.query("SELECT 1 FROM project WHERE id = $1", [projectId]);
  if (projectRow.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);

  let list: RuntimeListResponse;
  try {
    list = await runtime.listTasks(projectId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  const runs = (list.runs ?? []).filter((r) => r.project_id === projectId);
  return { status: 200, data: { runs } };
}

/**
 * GET /projects/:projectId/tasks/:runId — fetch a single task run's detail.
 *
 * Core forwards to Runtime GET /tasks/:runId; the returned run's project_id
 * MUST match the path project_id (else 404 — never surface another project's
 * run). docs entries are passed through verbatim, including artifact_id +
 * revision_id so the frontend can render revision content via Core's content
 * endpoint without a reverse lookup.
 */
export async function getTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const runId = ctx.params.runId!;
  const runtime = requireRuntime(ctx);

  let detail: RuntimeRunDetail;
  try {
    detail = await runtime.getTask(runId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${runId}`);
  return { status: 200, data: detail };
}

/**
 * POST /projects/:projectId/tasks/:runId/message — forward a free-agent
 * conversation message (prompt when idle, steer when running). Ownership of
 * the run is verified before forwarding; the Runtime reply is passed through.
 */
export async function sendTaskMessageHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const runId = ctx.params.runId!;
  const runtime = requireRuntime(ctx);
  const body = asObject(ctx.body);
  const text = requireString(body, "text");

  let detail: RuntimeRunDetail;
  try {
    detail = await runtime.getTask(runId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${runId}`);

  try {
    const reply = await runtime.sendMessage(runId, text);
    return { status: 200, data: reply };
  } catch (err) {
    throw mapRuntimeError(err);
  }
}

/** POST /projects/:projectId/tasks/:runId/abort — abort the free-agent session. */
export async function abortTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const runId = ctx.params.runId!;
  const runtime = requireRuntime(ctx);

  let detail: RuntimeRunDetail;
  try {
    detail = await runtime.getTask(runId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${runId}`);

  try {
    const result = await runtime.abortTask(runId);
    return { status: 200, data: result };
  } catch (err) {
    throw mapRuntimeError(err);
  }
}
