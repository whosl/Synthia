/**
 * Synthia Core API — Runtime task proxy (UI-2 task workbench slice)
 *
 * Core forwards task lifecycle requests to the Runtime HTTP service
 * (runtime/server.ts) WITHOUT persistencing task truth. Core's role is:
 *   1. project ownership validation (project exists, process instance belongs
 *      to the project, the agent's project_id matches the path);
 *   2. project-aware task routing. Free projects never acquire a process
 *      instance; engineering projects reuse or provision one whose frozen
 *      profile matches the project binding;
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
 * agentId WITHOUT re-contacting the Runtime.
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
  | "idle"
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

/** Condensed audit entry returned by GET /tasks/:agentId (last ~50). */
export interface RuntimeAuditEntry {
  readonly ts: string;
  readonly seq: number;
  readonly category: string;
  readonly phase?: string;
  readonly action?: string;
  readonly result?: string;
  readonly detail?: string;
}

/** Evidence summary entry for a terminal agent. */
export interface RuntimeEvidenceEntry {
  readonly job_id: string;
  readonly operation: string;
  readonly status: string;
  readonly entries?: ReadonlyArray<{ name: string; sha256: string; size_bytes: number; media_type: string }>;
}

export interface RuntimeAgentSummary {
  readonly agent_id: string;
  readonly project_id: string;
  readonly status: RuntimeTaskStatus;
  readonly current_stage?: string;
  readonly awaiting_gate?: string;
  readonly created_at?: string;
}

export interface RuntimeAgentDetail {
  readonly agent_id: string;
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
  readonly agents: readonly RuntimeAgentSummary[];
}

export interface RuntimeCreateResponse {
  readonly agent_id: string;
}

// ─── Runtime client port ─────────────────────────────────────────────────────

/**
 * The operations Core performs against the Runtime. Every method may reject
 * with a {@link RuntimeClientError}; the handler layer maps those to stable
 * API errors. Absence of a client (Runtime not configured) → 503.
 */
export interface RuntimeClient {
  /** POST /tasks — asynchronously start a loop agent. */
  createTask(body: {
    project_id: string;
    /** Omitted for free-project sessions. */
    process_instance_id?: string;
    task: string;
    part?: string;
    /** "agent" = free-agent session only (do not start the pipeline loop). */
    mode?: "agent";
    /** Frozen project execution context, copied from Core's project row. */
    project_type?: string;
    process_version_id?: string | null;
    process_profile_id?: string | null;
    process_profile_name?: string | null;
    process_profile_version?: string | null;
  }): Promise<RuntimeCreateResponse>;
  /** GET /tasks — list agents filtered by project. */
  listTasks(projectId: string): Promise<RuntimeListResponse>;
  /** GET /tasks/:agentId — fetch a single agent's detail. */
  getTask(agentId: string): Promise<RuntimeAgentDetail>;
  /** POST /tasks/:agentId/message — free-agent conversation (prompt/steer). */
  sendMessage(agentId: string, text: string): Promise<unknown>;
  /** POST /tasks/:agentId/abort — abort the free-agent session. */
  abortTask(agentId: string): Promise<unknown>;
  /**
   * GET /tasks/:agentId/stream — open the SSE event stream and return the raw
   * upstream Response (body streamed; Core NEVER buffers it). Rejects with a
   * RuntimeClientError when the Runtime is unreachable (→ 503).
   *
   * `lastEventId` / `from` are forwarded verbatim so resume-after-reconnect and
   * turn-scoped replay work end to end — without them every reconnect re-dumps
   * the whole retained window (measured: ~227 KB).
   */
  streamTask(
    agentId: string,
    init?: { signal?: AbortSignal; lastEventId?: string | null; from?: string | null },
  ): Promise<Response>;
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
 * status so a 404 (unknown agent) / 400 (malformed task) maps to the matching
 * Core error.
 */
export class HttpRuntimeClient implements RuntimeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_RUNTIME_URL).trim();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
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
    process_instance_id?: string;
    task: string;
    part?: string;
    mode?: "agent";
    project_type?: string;
    process_version_id?: string | null;
    process_profile_id?: string | null;
    process_profile_name?: string | null;
    process_profile_version?: string | null;
  }): Promise<RuntimeCreateResponse> {
    return this.request<RuntimeCreateResponse>("POST", "/tasks", body);
  }

  async listTasks(projectId: string): Promise<RuntimeListResponse> {
    return this.request<RuntimeListResponse>("GET", `/tasks?project_id=${encodeURIComponent(projectId)}`);
  }

  async getTask(agentId: string): Promise<RuntimeAgentDetail> {
    return this.request<RuntimeAgentDetail>("GET", `/tasks/${encodeURIComponent(agentId)}`);
  }

  async sendMessage(agentId: string, text: string): Promise<unknown> {
    // A free-agent turn (context + tool calls + generation) takes minutes,
    // not seconds — never the 15s control-path timeout.
    return this.request("POST", `/tasks/${encodeURIComponent(agentId)}/message`, { text }, { timeoutMs: 10 * 60_000 });
  }

  async abortTask(agentId: string): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(agentId)}/abort`);
  }

  async streamTask(
    agentId: string,
    init?: { signal?: AbortSignal; lastEventId?: string | null; from?: string | null },
  ): Promise<Response> {
    // SSE pass-through must NOT go through request(): no buffering, no
    // read-then-parse, no timeout — the body is handed to the caller as-is.
    let response: Response;
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(agentId)}/stream`);
    if (init?.from) url.searchParams.set("from", init.from);
    try {
      response = await fetch(url, {
        method: "GET",
        signal: init?.signal,
        headers: {
          accept: "text/event-stream",
          ...(init?.lastEventId ? { "last-event-id": init.lastEventId } : {}),
        },
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new RuntimeClientError(503, aborted ? "runtime stream closed" : "runtime unreachable", {
        retryable: !aborted,
      });
    }
    if (!response.ok) {
      // Drain so the socket can be reused, then map like request() would.
      await response.text().catch(() => "");
      throw new RuntimeClientError(response.status, `runtime stream error: ${response.status}`, {
        retryable: response.status >= 500,
      });
    }
    return response;
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
 * The fields below are the immutable project context that Core owns and
 * Runtime must not infer from missing request values.  A null profile is valid
 * only for a free project; an engineering project with no frozen profile is a
 * corrupt/legacy record and is rejected rather than silently assigned GJB.
 */
interface ProjectTaskContext {
  readonly projectType: "free" | "engineering";
  /** Project-canonical FPGA part; null means the project has not selected one. */
  readonly targetPart: string | null;
  /** Historical rows retain the old request mode during the compatibility window. */
  readonly legacyCompatibility: boolean;
  readonly processVersionId: string | null;
  readonly processProfileId: string | null;
  readonly processProfileName: string | null;
  readonly processProfileVersion: string | null;
}

interface ResolvedTaskContext extends ProjectTaskContext {
  readonly processInstanceId: string | undefined;
}

const GJB_REF_V1_BINDING = {
  id: "GJB_REF_V1",
  version: "GJB_REF_V1",
  name: "GJB 参考流程 v1",
} as const;

const LEGACY_COMPAT_BINDING = {
  id: "LEGACY_COMPAT",
  version: "LEGACY_COMPAT",
  name: "兼容旧流程",
} as const;

/**
 * Read the project binding once, then resolve its task process.  Keeping this
 * in the same transaction as the idempotency claim means a concurrent first
 * task cannot create two engineering G0 instances.
 */
async function resolveProcessInstance(
  tx: TransactionClient,
  projectId: string,
  explicitId: string | null,
): Promise<ResolvedTaskContext> {
  const projectResult = await tx.query(
    `SELECT project_type, target_part, process_version_id, process_profile_id,
            process_profile_version, process_profile_name
       FROM project WHERE id = $1 FOR UPDATE`,
    [projectId],
  );
  if (projectResult.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);

  const row = projectResult.rows[0] as {
    project_type?: unknown;
    target_part?: unknown;
    process_version_id?: unknown;
    process_profile_id?: unknown;
    process_profile_version?: unknown;
    process_profile_name?: unknown;
  };
  const projectType = row.project_type === "free"
    ? "free"
    : row.project_type === "engineering"
      ? "engineering"
      : null;
  if (!projectType) throw validationError("project has an unsupported project_type", { projectId, projectType: row.project_type });

  const processVersionId = typeof row.process_version_id === "string" && row.process_version_id.length > 0
    ? row.process_version_id
    : null;
  const processProfileId = typeof row.process_profile_id === "string" && row.process_profile_id.length > 0
    ? row.process_profile_id
    : null;
  const processProfileVersion = typeof row.process_profile_version === "string" && row.process_profile_version.length > 0
    ? row.process_profile_version
    : null;
  const processProfileName = typeof row.process_profile_name === "string" && row.process_profile_name.length > 0
    ? row.process_profile_name
    : null;
  const targetPart = typeof row.target_part === "string" && row.target_part.trim().length > 0
    ? row.target_part.trim()
    : null;

  if (projectType === "free") {
    if (processVersionId || processProfileId || processProfileVersion || processProfileName) {
      throw conflictApiError("FREE_PROJECT_PROCESS_PROFILE_CONFLICT", { projectId });
    }
    if (explicitId) {
      throw validationError("free projects cannot use a process_instance_id", { projectId });
    }
    return {
      projectType,
      targetPart,
      legacyCompatibility: false,
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      processInstanceId: undefined,
    };
  }

  const modernBinding =
    processVersionId === GJB_REF_V1_BINDING.id &&
    processProfileId === GJB_REF_V1_BINDING.id &&
    processProfileVersion === GJB_REF_V1_BINDING.version &&
    processProfileName === GJB_REF_V1_BINDING.name;
  const legacyBinding =
    processVersionId === LEGACY_COMPAT_BINDING.id &&
    processProfileId === LEGACY_COMPAT_BINDING.id &&
    processProfileVersion === LEGACY_COMPAT_BINDING.version &&
    processProfileName === LEGACY_COMPAT_BINDING.name;
  if (!modernBinding && !legacyBinding) {
    throw conflictApiError("PROJECT_PROCESS_BINDING_INVALID", {
      projectId,
      processVersionId,
      processProfileId,
      processProfileVersion,
      processProfileName,
    });
  }
  const frozenProfile = modernBinding ? GJB_REF_V1_BINDING.id : LEGACY_COMPAT_BINDING.id;

  const context: ProjectTaskContext = {
    projectType,
    targetPart,
    legacyCompatibility: legacyBinding,
    processVersionId,
    processProfileId,
    processProfileName,
    processProfileVersion,
  };

  if (explicitId) {
    const { rows } = await tx.query(
      "SELECT id, gate_profile_version FROM process_instance WHERE id = $1 AND project_id = $2",
      [explicitId, projectId],
    );
    if (rows.length === 0) throw notFoundError(`process instance not found or not in project: ${explicitId}`);
    validateInstanceProfile(rows[0] as { gate_profile_version?: unknown }, frozenProfile, projectId, explicitId);
    return { ...context, processInstanceId: explicitId };
  }

  const existing = await tx.query(
    "SELECT id, gate_profile_version FROM process_instance WHERE project_id = $1 ORDER BY created_at, id",
    [projectId],
  );
  // A non-legacy engineering project must never silently pick an instance
  // frozen to a different profile. Check every existing row before selecting
  // the first one, so a corrupted second row cannot be hidden by ordering.
  for (const candidate of existing.rows) {
    validateInstanceProfile(candidate as { gate_profile_version?: unknown }, frozenProfile, projectId, firstRowId([candidate]));
  }
  if (existing.rows.length > 0) {
    return { ...context, processInstanceId: firstRowId(existing.rows) };
  }

  // The id is deterministic and the project row is locked above. ON CONFLICT
  // remains necessary for deployments where another writer already inserted
  // the same id before this transaction acquired its lock.
  const defaultId = `pi-default:${projectId}`;
  await tx.query(
    `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
     VALUES ($1,$2,$3,'G0')
     ON CONFLICT (id) DO NOTHING`,
    [defaultId, projectId, frozenProfile],
  );
  const { rows } = await tx.query(
    "SELECT id, gate_profile_version FROM process_instance WHERE project_id = $1 ORDER BY created_at, id",
    [projectId],
  );
  if (rows.length === 0) throw internalError("PROCESS_INSTANCE_UNEXPECTED_STATE");
  for (const candidate of rows) {
    validateInstanceProfile(candidate as { gate_profile_version?: unknown }, frozenProfile, projectId, firstRowId([candidate]));
  }
  return { ...context, processInstanceId: firstRowId(rows) };
}

function validateInstanceProfile(
  row: { gate_profile_version?: unknown },
  frozenProfile: string,
  projectId: string,
  processInstanceId: string,
): void {
  const actual = typeof row.gate_profile_version === "string" ? row.gate_profile_version : null;
  // LEGACY_COMPAT intentionally preserves the historical instance's profile;
  // old projects predate the frozen binding and may still contain `flow-v1`.
  if (frozenProfile !== "LEGACY_COMPAT" && actual !== frozenProfile) {
    throw conflictApiError("PROCESS_PROFILE_IMMUTABLE", {
      projectId,
      processInstanceId,
      expected: frozenProfile,
      received: actual,
    });
  }
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
 * POST /projects/:projectId/tasks — start a Runtime loop agent for this project.
 *
 * Body: `{ task, part? }` (and optionally an explicit `process_instance_id`,
 * which MUST belong to the project). Core resolves the immutable project
 * context before forwarding: free projects use the Runtime free-agent mode and
 * carry no process instance; engineering projects use the frozen profile and a
 * matching (or newly provisioned) process instance. The forwarded response
 * `{ agent_id }` is translated to `{ agentId }` and stored idempotently so a
 * same-key replay returns the original agentId without re-contacting Runtime.
 * Core emits a `task.forwarded` outbox event (observability only — task truth
 * lives in Runtime).
 */
export async function createTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const runtime = requireRuntime(ctx);
  const body = asObject(ctx.body);
  const task = requireString(body, "task");
  const requestedPart = nullableString(body, "part");
  const part = requestedPart && requestedPart.trim().length > 0 ? requestedPart.trim() : null;
  // Validate the legacy hint but never let it override Core-owned project facts.
  nullableString(body, "mode");
  const explicitPi = nullableString(body, "process_instance_id");

  const result = await runIdempotent<{ agentId: string }>(ctx, "create_task", projectId, async (tx) => {
    const taskContext = await resolveProcessInstance(tx, projectId, explicitPi);

    let response: RuntimeCreateResponse;
    try {
      if (taskContext.projectType === "engineering") {
        const existing = await runtime.listTasks(projectId);
        if ((existing.agents ?? []).some((agent) => agent.project_id === projectId)) {
          throw conflictApiError("ENGINEERING_MAIN_AGENT_EXISTS", {
            projectId,
            message: "engineering projects allow one formal main agent until isolated side tasks are available",
          });
        }
      }
      const effectivePart = part ?? taskContext.targetPart;
      response = await runtime.createTask({
        project_id: projectId,
        task,
        // An explicit task part is a deliberate one-off override. Otherwise
        // use the project's canonical target; when both are absent, omit the
        // field so Runtime cannot silently select a hardware default.
        ...(effectivePart ? { part: effectivePart } : {}),
        ...(taskContext.processInstanceId ? { process_instance_id: taskContext.processInstanceId } : {}),
        // The project row, rather than an arbitrary request mode, is the
        // authority for execution mode. This prevents an engineering task
        // from bypassing its formal mainline by sending mode="agent".
        ...(taskContext.projectType === "free" || taskContext.legacyCompatibility
          ? { mode: "agent" as const }
          : {}),
        project_type: taskContext.projectType,
        ...(taskContext.processVersionId ? { process_version_id: taskContext.processVersionId } : {}),
        ...(taskContext.processProfileId ? { process_profile_id: taskContext.processProfileId } : {}),
        ...(taskContext.processProfileName ? { process_profile_name: taskContext.processProfileName } : {}),
        ...(taskContext.processProfileVersion ? { process_profile_version: taskContext.processProfileVersion } : {}),
      });
    } catch (err) {
      throw mapRuntimeError(err);
    }

    await outboxEvent(tx, ctx, { type: "task", id: response.agent_id }, "task.forwarded", {
      agentId: response.agent_id,
      projectId,
      ...(taskContext.processInstanceId ? { processInstanceId: taskContext.processInstanceId } : {}),
      projectType: taskContext.projectType,
      ...(taskContext.processProfileId ? { processProfileId: taskContext.processProfileId } : {}),
    });
    return { agentId: response.agent_id };
  });

  return { status: 201, data: result };
}

/**
 * GET /projects/:projectId/tasks — list task agents for this project.
 *
 * Core forwards to Runtime GET /tasks and filters to agents whose project_id
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
  const agents = (list.agents ?? []).filter((r) => r.project_id === projectId);
  return { status: 200, data: { agents } };
}

/**
 * GET /projects/:projectId/tasks/:agentId — fetch a single task agent's detail.
 *
 * Core forwards to Runtime GET /tasks/:agentId; the returned agent's project_id
 * MUST match the path project_id (else 404 — never surface another project's
 * agent). docs entries are passed through verbatim, including artifact_id +
 * revision_id so the frontend can render revision content via Core's content
 * endpoint without a reverse lookup.
 */
export async function getTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const runtime = requireRuntime(ctx);

  let detail: RuntimeAgentDetail;
  try {
    detail = await runtime.getTask(agentId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${agentId}`);
  return { status: 200, data: detail };
}

/**
 * POST /projects/:projectId/tasks/:agentId/message — forward a free-agent
 * conversation message (prompt when idle, steer when running). Ownership of
 * the agent is verified before forwarding; the Runtime reply is passed through.
 */
export async function sendTaskMessageHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const runtime = requireRuntime(ctx);
  const body = asObject(ctx.body);
  const text = requireString(body, "text");

  let detail: RuntimeAgentDetail;
  try {
    detail = await runtime.getTask(agentId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${agentId}`);

  try {
    const reply = await runtime.sendMessage(agentId, text);
    return { status: 200, data: reply };
  } catch (err) {
    throw mapRuntimeError(err);
  }
}

/** POST /projects/:projectId/tasks/:agentId/abort — abort the free-agent session. */
export async function abortTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const runtime = requireRuntime(ctx);

  let detail: RuntimeAgentDetail;
  try {
    detail = await runtime.getTask(agentId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${agentId}`);

  try {
    const result = await runtime.abortTask(agentId);
    return { status: 200, data: result };
  } catch (err) {
    throw mapRuntimeError(err);
  }
}

/**
 * GET /projects/:projectId/tasks/:agentId/stream — SSE pass-through.
 *
 * Ownership is verified against the Runtime agent detail (same as the other
 * task routes), then the Runtime SSE response is forwarded VERBATIM: the
 * body stream is never buffered and content-type stays text/event-stream.
 * The response bypasses the JSON envelope by design (EventSource clients
 * consume the raw SSE bytes); errors before the stream opens still surface
 * through the standard envelope (404/503).
 *
 * Returns the raw Response; the router serves it directly.
 */
export async function streamTaskHandler(ctx: RequestContext): Promise<Response> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const runtime = requireRuntime(ctx);

  let detail: RuntimeAgentDetail;
  try {
    detail = await runtime.getTask(agentId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${agentId}`);

  let upstream: Response;
  try {
    // Forward the resume cursor + replay scope, and tie the upstream request to
    // the client connection so a browser disconnect tears down the Runtime
    // subscription instead of leaking it.
    upstream = await runtime.streamTask(agentId, {
      signal: ctx.request.signal,
      lastEventId: ctx.request.headers.get("last-event-id"),
      from: ctx.url.searchParams.get("from"),
    });
  } catch (err) {
    throw mapRuntimeError(err);
  }

  // Pipe the body through unchanged. Explicit headers (not upstream.headers)
  // so no hop-by-hop headers leak through.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
