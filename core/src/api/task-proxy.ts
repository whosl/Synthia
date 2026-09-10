/**
 * Synthia Core API — Runtime task proxy (UI-2 task workbench slice)
 *
 * Core forwards task lifecycle requests to the Runtime HTTP service
 * (runtime/server.ts). Legacy tasks remain Runtime-owned; P3 tasks are first
 * persisted as Core facts. Core's role is:
 *   1. project ownership validation (project exists, process instance belongs
 *      to the project, the agent's project_id matches the path);
 *   2. project-aware task routing. Free projects never acquire a process
 *      instance; engineering projects reuse or provision one whose frozen
 *      profile matches the project binding;
 *   3. envelope + error-model translation between Runtime's error vocabulary
 *      and Core's stable {@link ApiError} model;
 *   4. compatibility reads that merge old Runtime-only mains with Core-owned
 *      tasks without treating Runtime's side-task cache as task truth.
 *
 * The Runtime client is an injectable port so tests drive an in-process fake
 * against a real PostgreSQL instance; production builds an HttpRuntimeClient
 * from `SYNTHIA_RUNTIME_URL` (default http://127.0.0.1:8790). When the client
 * is absent or unreachable, Runtime-dependent writes and legacy-only reads
 * surface 503 capability_unavailable; persisted Core task reads remain usable.
 *
 * Idempotency: POST /projects/:id/tasks requires an Idempotency-Key. The legacy
 * path stores the forwarded Runtime response and replays it without another
 * Runtime call. P3 stores Core task facts plus the stable Runtime registration
 * request; every same-key replay deliberately retries the idempotent
 * register/bind/start sequence so a failure after the Core commit can recover.
 */

import {
  appendOutboxEventInTx,
  claimIdempotencySlot,
  completeIdempotencySlot,
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import { canonicalRequestHash, sha256Hex } from "../hashing.ts";
import { headSha } from "../workspace/git.ts";
import { ensureWorkspace, readTreeAt } from "../workspace/store.ts";
import {
  ApiError,
  capabilityUnavailableError,
  conflictApiError,
  internalError,
  notFoundError,
  validationError,
} from "./errors.ts";
import {
  runIdempotent as runCoreIdempotent,
  type HandlerResult,
  type RequestContext,
} from "./handlers.ts";

// ─── Runtime task shapes (mirror runtime/server.ts contract) ─────────────────

export type RuntimeTaskStatus =
  | "queued"
  | "idle"
  | "running"
  | "awaiting_user"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
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
  readonly kind?: "main" | "side";
  readonly agent_role?: "project" | "run" | "side";
  readonly parent_task_id?: string | null;
  readonly workspace_id?: string | null;
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
  readonly kind?: "main" | "side";
  readonly agent_role?: "project" | "run" | "side";
  readonly parent_task_id?: string | null;
  readonly workspace_id?: string | null;
}

export interface RuntimeListResponse {
  readonly agents: readonly RuntimeAgentSummary[];
}

export interface RuntimeCreateResponse {
  readonly agent_id: string;
}

export interface RuntimeStartResponse {
  readonly started: boolean;
  readonly status: RuntimeTaskStatus;
  readonly reason?: string;
}

// ─── Runtime client port ─────────────────────────────────────────────────────

/**
 * The operations Core performs against the Runtime. Every method may reject
 * with a {@link RuntimeClientError}; the handler layer maps those to stable
 * API errors. Absence of a client (Runtime not configured) → 503.
 */
export interface RuntimeClient {
  /** POST /tasks — create legacy work or idempotently register a P3 task. */
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
    /** P3 Core-owned identity. Runtime must reuse this id idempotently. */
    task_id?: string;
    task_kind?: "main" | "side";
    /** Explicit lifecycle intent; project_agent never starts the governed loop. */
    execution_intent?: "project_agent" | "run" | "side_agent";
    parent_task_id?: string;
    workspace_id?: string;
    authorization_scope?: Readonly<Record<string, unknown>>;
    /** Core-computed immutable task input identity (lowercase SHA-256). */
    input_hash?: string;
  }): Promise<RuntimeCreateResponse>;
  /** POST /tasks/:agentId/start — start any registered Core-owned task. */
  startTask(agentId: string): Promise<RuntimeStartResponse>;
  /** GET /tasks — list agents filtered by project. */
  listTasks(projectId: string): Promise<RuntimeListResponse>;
  /** GET /tasks/:agentId — fetch a single agent's detail. */
  getTask(agentId: string): Promise<RuntimeAgentDetail>;
  /** POST /tasks/:agentId/message — free-agent conversation (prompt/steer). */
  sendMessage(agentId: string, text: string, idempotencyKey?: string): Promise<unknown>;
  /** POST /tasks/:agentId/abort — abort the free-agent session. */
  abortTask(agentId: string, idempotencyKey?: string): Promise<unknown>;
  resolveTaskPermission(
    agentId: string,
    body: { callId?: string; allow?: boolean; skipAll?: boolean },
  ): Promise<unknown>;
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number; headers?: Readonly<Record<string, string>> },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      const headers = new Headers(opts?.headers);
      if (body !== undefined) headers.set("content-type", "application/json");
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        signal: controller.signal,
        headers,
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
    task_id?: string;
    task_kind?: "main" | "side";
    execution_intent?: "project_agent" | "run" | "side_agent";
    parent_task_id?: string;
    workspace_id?: string;
    authorization_scope?: Readonly<Record<string, unknown>>;
    input_hash?: string;
  }): Promise<RuntimeCreateResponse> {
    return this.request<RuntimeCreateResponse>("POST", "/tasks", body);
  }

  async startTask(agentId: string): Promise<RuntimeStartResponse> {
    return this.request<RuntimeStartResponse>(
      "POST",
      `/tasks/${encodeURIComponent(agentId)}/start`,
    );
  }

  async listTasks(projectId: string): Promise<RuntimeListResponse> {
    return this.request<RuntimeListResponse>("GET", `/tasks?project_id=${encodeURIComponent(projectId)}`);
  }

  async getTask(agentId: string): Promise<RuntimeAgentDetail> {
    return this.request<RuntimeAgentDetail>("GET", `/tasks/${encodeURIComponent(agentId)}`);
  }

  async sendMessage(agentId: string, text: string, idempotencyKey?: string): Promise<unknown> {
    // The Runtime message endpoint returns `{accepted:true}` (or a 4xx) in
    // seconds — the multi-minute TURN runs in the background and is consumed
    // via stream/audit. The previous 10-minute timeout conflated the two and
    // turned a stuck Runtime dispatch (observed: a recovery-path session
    // rebuild held the per-agent dispatch lock for ~30 minutes in the T1 AES
    // run) into a silent client-side hang with no error. 90s bounds the
    // accept path generously while making any stall loud.
    return this.request(
      "POST",
      `/tasks/${encodeURIComponent(agentId)}/message`,
      { text },
      {
        timeoutMs: 90_000,
        ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
      },
    );
  }

  async abortTask(agentId: string, idempotencyKey?: string): Promise<unknown> {
    return this.request(
      "POST",
      `/tasks/${encodeURIComponent(agentId)}/abort`,
      undefined,
      idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : undefined,
    );
  }

  /** POST /tasks/:agentId/permission — 裁决挂起的权限请求或切换 skip-all。 */
  async resolveTaskPermission(
    agentId: string,
    body: { callId?: string; allow?: boolean; skipAll?: boolean },
  ): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(agentId)}/permission`, body);
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
export function requireRuntime(ctx: RequestContext): RuntimeClient {
  if (!ctx.runtimeClient) throw capabilityUnavailableError("runtime not configured");
  return ctx.runtimeClient;
}

/** Resolve the configured callback uid against Core's active service identities. */
export async function requireConfiguredRuntimeActor(
  ctx: RequestContext,
  client: Pick<TransactionClient, "query">,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1
       FROM user_account
      WHERE uid=$1 AND actor_type='service' AND status='active'
      LIMIT 1`,
    [ctx.runtimeActorId],
  );
  if (rows.length === 0) {
    throw capabilityUnavailableError(
      "SYNTHIA_RUNTIME_ACTOR_ID does not name an active service identity",
    );
  }
}

/** Map a Runtime failure to a stable API error. */
export function mapRuntimeError(err: unknown): ApiError {
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
export interface ProjectTaskContext {
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

export interface ResolvedTaskContext extends ProjectTaskContext {
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
export async function resolveProcessInstance(
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

// ─── P3 Core-owned task facts ───────────────────────────────────────────────

const MAIN_AUTHORIZATION_SCOPE = Object.freeze({
  schema: "task-scope.v1",
  workspace: "project",
  read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  write_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  run_classes: ["exploratory", "gate_check", "formal"],
  can_submit_gates: true,
  can_create_milestones: true,
  can_start_formal_runs: true,
});

interface CoreTaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_type: "free" | "engineering";
  readonly kind: "main" | "side";
  readonly agent_role: "project" | "run" | "side";
  readonly parent_task_id: string | null;
  readonly workspace_id: string | null;
  readonly runtime_agent_id: string | null;
  readonly runtime_actor_id: string;
  readonly objective: string;
  readonly authorization_scope: Readonly<Record<string, unknown>>;
  readonly status: RuntimeTaskStatus;
  readonly input_hash: string;
  readonly output_hash: string | null;
  readonly adoption_state: string;
  readonly current_stage: string | null;
  readonly awaiting_gate: string | null;
  readonly runtime_snapshot: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly finished_at: Date | string | null;
  readonly workspace_state?: string | null;
  readonly base_commit?: string | null;
  readonly base_manifest_hash?: string | null;
  readonly head_commit?: string | null;
}

function p3Enabled(ctx: RequestContext): boolean {
  return ctx.featureFlags?.sideTasks === true;
}

function stableTaskId(ctx: RequestContext, projectId: string, kind: "main" | "side"): string {
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");
  const digest = canonicalRequestHash({
    schema: "task-id.v1",
    projectId,
    kind,
    actorType: ctx.identity.actorType,
    actorId: ctx.identity.actorId,
    idempotencyKey: ctx.idempotencyKey,
  });
  return `task-${digest.slice(0, 32)}`;
}

/** One stable Project Agent identity per project, independent of actor/retry key. */
function projectAgentTaskId(projectId: string): string {
  const digest = canonicalRequestHash({ schema: "project-agent-id.v1", projectId });
  return `task-${digest.slice(0, 32)}`;
}

function baseManifestHash(files: readonly { path: string; contentHash: string; sizeBytes: number }[]): string {
  const canonical = [...files]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map((file) => `${file.path}\0${file.contentHash}\0${file.sizeBytes}\n`)
    .join("");
  return sha256Hex(canonical);
}

function asRuntimeSnapshot(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function taskSummary(row: CoreTaskRow): RuntimeAgentSummary & Record<string, unknown> {
  return {
    agent_id: row.id,
    task_id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    agent_role: row.agent_role,
    parent_task_id: row.parent_task_id,
    workspace_id: row.workspace_id,
    objective: row.objective,
    task: row.objective,
    goal: row.objective,
    status: row.status as RuntimeTaskStatus,
    current_stage: row.current_stage ?? undefined,
    awaiting_gate: row.awaiting_gate ?? undefined,
    input_hash: row.input_hash,
    output_hash: row.output_hash,
    adoption_state: row.adoption_state,
    authorization_scope: row.authorization_scope,
    base_commit: row.base_commit ?? null,
    base_manifest_hash: row.base_manifest_hash ?? null,
    workspace_state: row.workspace_state ?? null,
    head_commit: row.head_commit ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    finished_at: row.finished_at ? iso(row.finished_at) : null,
  };
}

function taskDetail(row: CoreTaskRow): RuntimeAgentDetail & Record<string, unknown> {
  const snapshot = asRuntimeSnapshot(row.runtime_snapshot);
  return {
    ...snapshot,
    ...taskSummary(row),
    agent_id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    parent_task_id: row.parent_task_id,
    workspace_id: row.workspace_id,
    status: row.status as RuntimeTaskStatus,
    docs: Array.isArray(snapshot.docs) ? snapshot.docs as RuntimeDocRef[] : [],
    audit: Array.isArray(snapshot.audit) ? snapshot.audit as RuntimeAuditEntry[] : [],
    evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence as RuntimeEvidenceEntry[] : [],
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Only an explicit Runtime main may use the legacy compatibility path. */
function isReadableRuntimeMain(
  value: unknown,
  projectId: string,
  expectedAgentId?: string,
): value is RuntimeAgentSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.agent_id === "string"
    && row.agent_id.length > 0
    && row.project_id === projectId
    && (expectedAgentId === undefined || row.agent_id === expectedAgentId)
    && row.kind === "main";
}

function asReadableRuntimeMain<T extends RuntimeAgentSummary>(task: T): T & { kind: "main" } {
  return { ...task, kind: "main" };
}

async function requireCoreOwnedTask(
  ctx: RequestContext,
  projectId: string,
  taskId: string,
): Promise<CoreTaskRow> {
  const { rows } = await ctx.pool.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2",
    [taskId, projectId],
  );
  const row = rows[0] as CoreTaskRow | undefined;
  if (!row) throw notFoundError(`task not found: ${taskId}`);
  return row;
}

async function findCoreOwnedTask(
  ctx: RequestContext,
  projectId: string,
  taskId: string,
): Promise<CoreTaskRow | null> {
  const { rows } = await ctx.pool.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2",
    [taskId, projectId],
  );
  return rows[0] as CoreTaskRow | undefined ?? null;
}

/**
 * Project-scoped task reads require both a globally readable identity and a
 * current project role.  The router enforces the global scope; this helper is
 * the tenant boundary.  Return 404 for a missing role so callers cannot use a
 * task route to probe another project's existence.  Platform administrators
 * retain their cross-project read capability.
 */
async function requireProjectReadable(ctx: RequestContext, projectId: string): Promise<void> {
  const project = await ctx.pool.query("SELECT id FROM project WHERE id=$1", [projectId]);
  if (project.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  if (ctx.identity.scopes.includes("core:admin")) return;
  const access = await ctx.pool.query(
    "SELECT 1 FROM role_assignment WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3 LIMIT 1",
    [projectId, ctx.identity.actorType, ctx.identity.actorId],
  );
  if (access.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
}

/**
 * Re-check mutable write eligibility in one short transaction immediately
 * before a task write may reach Runtime or mutate Core facts.  Access is
 * checked before project status so an unassigned caller cannot distinguish an
 * inactive project from a missing one.  Platform administrators bypass only
 * the role lookup; inactive projects remain read-only for every identity.
 */
async function findCoreOwnedTaskForWrite(
  ctx: RequestContext,
  projectId: string,
  taskId: string,
): Promise<CoreTaskRow | null> {
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(
      conn as unknown as TransactionClient,
      (tx) => findCoreOwnedTaskForWriteTx(ctx, tx, projectId, taskId),
    );
  } finally {
    conn.release();
  }
}

/**
 * Transaction-scoped variant used by idempotent Core-owned writes. Project and
 * role rows are locked for the transaction so a completed replay cannot race
 * an archive or access revocation between authorization and its fact write.
 */
async function findCoreOwnedTaskForWriteTx(
  ctx: RequestContext,
  tx: TransactionClient,
  projectId: string,
  taskId: string,
): Promise<CoreTaskRow | null> {
  const project = await tx.query(
    "SELECT status FROM project WHERE id=$1 FOR SHARE",
    [projectId],
  );
  const projectRow = project.rows[0] as { status?: unknown } | undefined;
  if (!projectRow) throw notFoundError(`project not found: ${projectId}`);
  if (!ctx.identity.scopes.includes("core:admin")) {
    const access = await tx.query(
      `SELECT 1 FROM role_assignment
        WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3
        LIMIT 1 FOR SHARE`,
      [projectId, ctx.identity.actorType, ctx.identity.actorId],
    );
    if (access.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  }
  if (projectRow.status !== "active") {
    throw conflictApiError("PROJECT_NOT_ACTIVE", { projectId });
  }
  const task = await tx.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2 FOR UPDATE",
    [taskId, projectId],
  );
  return task.rows[0] as CoreTaskRow | undefined ?? null;
}

function requireCoreTaskMessageable(task: CoreTaskRow): void {
  if (task.agent_role === "project" && task.status !== "queued") return;
  if (task.status !== "running" && task.status !== "awaiting_user") {
    throw conflictApiError("CORE_TASK_NOT_MESSAGEABLE", {
      taskId: task.id,
      status: task.status,
    });
  }
}

async function appendConversationEventRecord(
  client: TransactionClient,
  ctx: RequestContext,
  projectId: string,
  taskId: string,
  eventId: string,
  eventKind: string,
  payload: unknown,
): Promise<void> {
  const payloadHash = canonicalRequestHash(payload);
  const inserted = await client.query(
    `WITH locked AS (
       SELECT id FROM agent_task WHERE id=$1 AND project_id=$2 FOR UPDATE
     ), next_sequence AS (
       SELECT COALESCE(MAX(sequence),0)+1 AS value
         FROM task_conversation_event
        WHERE task_id=$1 AND EXISTS (SELECT 1 FROM locked)
     )
     INSERT INTO task_conversation_event
       (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id)
     SELECT $3,$2,$1,value,$4,$5::jsonb,$6,$7,$8 FROM next_sequence
     RETURNING id`,
    [
      taskId,
      projectId,
      eventId,
      eventKind,
      JSON.stringify(payload),
      payloadHash,
      ctx.identity.actorType,
      ctx.identity.actorId,
    ],
  );
  if (inserted.rows.length === 0) throw notFoundError(`task not found: ${taskId}`);
}

type RuntimeCreateTaskBody = Parameters<RuntimeClient["createTask"]>[0];

interface CoreMainCreateRecord {
  readonly taskId: string;
  readonly inputHash: string;
  readonly runtimeRequest: RuntimeCreateTaskBody;
  /** All Core-owned tasks use Runtime's explicit start barrier. */
  readonly requiresExplicitStart: boolean;
}

async function bindCoreTaskToRuntime(
  ctx: RequestContext,
  projectId: string,
  taskId: string,
  runtimeAgentId: string,
): Promise<void> {
  const bound = await ctx.pool.query(
    `UPDATE agent_task
        SET runtime_agent_id=$3,runtime_actor_id=$4,updated_at=now()
      WHERE id=$1 AND project_id=$2
        AND (runtime_agent_id IS NULL OR runtime_agent_id=$3)
        AND runtime_actor_id=$4
      RETURNING id`,
    [taskId, projectId, runtimeAgentId, ctx.runtimeActorId],
  );
  if (bound.rows.length > 0) return;

  const current = await findCoreOwnedTask(ctx, projectId, taskId);
  if (!current) throw notFoundError(`task not found: ${taskId}`);
  throw conflictApiError("RUNTIME_TASK_BINDING_CONFLICT", {
    taskId,
    expected: current.runtime_agent_id,
    received: runtimeAgentId,
    expectedActor: current.runtime_actor_id,
    receivedActor: ctx.runtimeActorId,
  });
}

async function markRegisteredMainReady(
  ctx: RequestContext,
  projectId: string,
  taskId: string,
  status: "running" | "awaiting_user",
): Promise<void> {
  // Runtime may have already written a more advanced status event. Only fill
  // the original queued state; never move a callback-owned fact backwards.
  await ctx.pool.query(
    `UPDATE agent_task
        SET status=$3,
            current_stage=CASE WHEN $3='running' THEN COALESCE(current_stage,'intake') ELSE current_stage END,
            runtime_snapshot=runtime_snapshot || $4::jsonb,
            updated_at=now()
      WHERE id=$1 AND project_id=$2 AND status='queued'`,
    [
      taskId,
      projectId,
      status,
      JSON.stringify({
        agent_id: taskId,
        project_id: projectId,
        kind: "main",
        status,
        ...(status === "running" ? { current_stage: "intake" } : {}),
      }),
    ],
  );
}

async function createCoreOwnedMainTask(
  ctx: RequestContext,
  projectId: string,
  task: string,
  part: string | null,
  explicitPi: string | null,
): Promise<HandlerResult> {
  const runtime = requireRuntime(ctx);
  const taskId = projectAgentTaskId(projectId);

  const { result } = await runCoreIdempotent<CoreMainCreateRecord>(ctx, "create_core_task", projectId, async (tx) => {
    await requireConfiguredRuntimeActor(ctx, tx);
    const taskContext = await resolveProcessInstance(tx, projectId, explicitPi);
    const existingProjectAgent = await tx.query(
      `SELECT id,objective,input_hash,authorization_scope,runtime_snapshot
         FROM agent_task
        WHERE project_id=$1 AND agent_role='project'
        FOR UPDATE`,
      [projectId],
    );
    const existing = existingProjectAgent.rows[0] as {
      id: string;
      objective: string;
      input_hash: string;
      authorization_scope: Readonly<Record<string, unknown>>;
      runtime_snapshot: unknown;
    } | undefined;
    if (existing) {
      const snapshot = asRuntimeSnapshot(existing.runtime_snapshot);
      const persistedPart = typeof snapshot.agent_part === "string" && snapshot.agent_part.trim()
        ? snapshot.agent_part.trim()
        : taskContext.targetPart;
      return {
        taskId: existing.id,
        inputHash: existing.input_hash,
        requiresExplicitStart: true,
        runtimeRequest: {
          task_id: existing.id,
          task_kind: "main",
          execution_intent: "project_agent",
          authorization_scope: existing.authorization_scope,
          input_hash: existing.input_hash,
          project_id: projectId,
          task: existing.objective,
          ...(persistedPart ? { part: persistedPart } : {}),
          ...(taskContext.processInstanceId ? { process_instance_id: taskContext.processInstanceId } : {}),
          mode: "agent" as const,
          project_type: taskContext.projectType,
          ...(taskContext.processVersionId ? { process_version_id: taskContext.processVersionId } : {}),
          ...(taskContext.processProfileId ? { process_profile_id: taskContext.processProfileId } : {}),
          ...(taskContext.processProfileName ? { process_profile_name: taskContext.processProfileName } : {}),
          ...(taskContext.processProfileVersion ? { process_profile_version: taskContext.processProfileVersion } : {}),
        },
      };
    }
    // Legacy main/run handles remain readable history, but they no longer own
    // the project's durable dialogue or block Project Agent creation.

    const controlledDir = await ensureWorkspace(projectId);
    const baseCommit = await headSha(controlledDir);
    if (!baseCommit) throw internalError("TASK_WORKSPACE_HEAD_MISSING");
    const tree = await readTreeAt(projectId, baseCommit);
    const manifestHash = baseManifestHash(tree.files);
    const inputHash = canonicalRequestHash({
      schema: "task-input.v1",
      projectId,
      kind: "main",
      objective: task,
      baseCommit,
      baseManifestHash: manifestHash,
      authorizationScope: MAIN_AUTHORIZATION_SCOPE,
    });
    const now = new Date().toISOString();
    const effectivePart = part ?? taskContext.targetPart;

    await tx.query(
      `INSERT INTO agent_task
       (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,process_instance_id,
          runtime_actor_id,objective,authorization_scope,status,input_hash,adoption_state,
          runtime_snapshot,created_by_type,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,'main','project',NULL,NULL,$4,$5,$6,$7::jsonb,'queued',$8,'not_applicable',$9::jsonb,$10,$11,$12,$12)`,
      [
        taskId,
        projectId,
        taskContext.projectType,
        taskContext.processInstanceId ?? null,
        ctx.runtimeActorId,
        task,
        JSON.stringify(MAIN_AUTHORIZATION_SCOPE),
        inputHash,
        JSON.stringify({ agent_role: "project", agent_part: effectivePart }),
        ctx.identity.actorType,
        ctx.identity.actorId,
        now,
      ],
    );
    await tx.query(
      `INSERT INTO task_conversation_event
         (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id,created_at)
       VALUES ($1,$2,$3,1,'user_message',$4::jsonb,$5,$6,$7,$8)`,
      [
        `te-${canonicalRequestHash({ taskId, task }).slice(0, 40)}`,
        projectId,
        taskId,
        JSON.stringify({ text: task, source: "main_task_objective" }),
        canonicalRequestHash({ text: task, source: "main_task_objective" }),
        ctx.identity.actorType,
        ctx.identity.actorId,
        now,
      ],
    );

    await outboxEvent(tx, ctx, { type: "task", id: taskId }, "task.created", {
      taskId,
      projectId,
      kind: "main",
      inputHash,
    });
    return {
      taskId,
      inputHash,
      requiresExplicitStart: true,
      runtimeRequest: {
        task_id: taskId,
        task_kind: "main",
        execution_intent: "project_agent",
        authorization_scope: MAIN_AUTHORIZATION_SCOPE,
        input_hash: inputHash,
        project_id: projectId,
        task,
        ...(effectivePart ? { part: effectivePart } : {}),
        ...(taskContext.processInstanceId ? { process_instance_id: taskContext.processInstanceId } : {}),
        mode: "agent" as const,
        project_type: taskContext.projectType,
        ...(taskContext.processVersionId ? { process_version_id: taskContext.processVersionId } : {}),
        ...(taskContext.processProfileId ? { process_profile_id: taskContext.processProfileId } : {}),
        ...(taskContext.processProfileName ? { process_profile_name: taskContext.processProfileName } : {}),
        ...(taskContext.processProfileVersion ? { process_profile_version: taskContext.processProfileVersion } : {}),
      },
    };
  });

  // The transaction above is the durable boundary. Replays deliberately drive
  // these idempotent Runtime operations again, repairing a previous request
  // that committed Core facts but lost contact during create, bind, or start.
  let created: RuntimeCreateResponse;
  try {
    created = await runtime.createTask(result.runtimeRequest);
  } catch (error) {
    throw mapRuntimeError(error);
  }
  if (created.agent_id !== result.taskId) {
    throw conflictApiError("RUNTIME_TASK_ID_MISMATCH", {
      expected: result.taskId,
      received: created.agent_id,
    });
  }
  await bindCoreTaskToRuntime(ctx, projectId, result.taskId, created.agent_id);

  let started: RuntimeStartResponse;
  try {
    started = await runtime.startTask(created.agent_id);
  } catch (error) {
    throw mapRuntimeError(error);
  }
  if (!started.started && started.reason !== "already_started") {
    throw conflictApiError("RUNTIME_TASK_NOT_RUNNING", {
      taskId: result.taskId,
      status: started.status,
      reason: started.reason ?? null,
    });
  }
  if (started.status === "failed" || started.status === "fail_closed" || started.status === "cancelled") {
    const terminal = started.status === "cancelled" ? "cancelled" : started.status;
    await ctx.pool.query(
      `UPDATE agent_task
          SET status=$3,finished_at=now(),updated_at=now(),
              runtime_snapshot=runtime_snapshot || $4::jsonb
        WHERE id=$1 AND project_id=$2 AND status IN ('queued','running','awaiting_user')`,
      [
        result.taskId,
        projectId,
        terminal,
        JSON.stringify({ status: terminal, reason: "Runtime reports an already-started terminal task" }),
      ],
    );
  }
  if (started.status === "running") {
    await markRegisteredMainReady(ctx, projectId, result.taskId, "running");
  }

  const persisted = await requireCoreOwnedTask(ctx, projectId, result.taskId);
  return {
    status: 201,
    data: {
      agentId: result.taskId,
      task_id: result.taskId,
      kind: "main" as const,
      agent_role: "project" as const,
      parent_task_id: null,
      workspace_id: null,
      status: persisted.status,
      input_hash: result.inputHash,
    },
  };
}

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * POST /projects/:projectId/tasks — start a Runtime loop agent for this project.
 *
 * Body: `{ task, part? }` (and optionally an explicit `process_instance_id`,
 * which MUST belong to the project). Core resolves the immutable project
 * context before forwarding: free projects use the Runtime free-agent mode and
 * carry no process instance; engineering projects use the frozen profile and a
 * matching (or newly provisioned) process instance. With P3 disabled, the
 * forwarded `{ agent_id }` is translated to `{ agentId }`, stored idempotently,
 * and replayed without re-contacting Runtime; task truth remains in Runtime and
 * Core emits `task.forwarded` for observability. With P3 enabled, Core first
 * commits the task/event/outbox facts, then runs idempotent Runtime
 * register/bind/start; a same-key replay repeats that sequence to repair a
 * failure after the Core commit.
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

  if (p3Enabled(ctx)) {
    return createCoreOwnedMainTask(ctx, projectId, task, part, explicitPi);
  }

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
 * Core-owned rows are authoritative and remain readable without Runtime.
 * Runtime contributes only legacy main tasks, with Core identities winning
 * deduplication. Runtime-only side tasks are deliberately not surfaced.
 */
export async function listTasksHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireProjectReadable(ctx, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT t.*,w.state AS workspace_state,w.base_commit,w.base_manifest_hash,w.head_commit
       FROM agent_task t
       LEFT JOIN task_workspace w
         ON w.id=t.workspace_id AND w.task_id=t.id AND w.project_id=t.project_id
      WHERE t.project_id=$1
      ORDER BY t.created_at DESC,t.id DESC`,
    [projectId],
  );
  const coreRows = rows as CoreTaskRow[];
  const coreAgents = coreRows.map(taskSummary);

  let list: RuntimeListResponse;
  try {
    list = await requireRuntime(ctx).listTasks(projectId);
  } catch (err) {
    // Persisted Core facts remain readable while Runtime is unavailable. If
    // there are no Core facts, fail closed because legacy task truth cannot be
    // distinguished from an empty project without consulting Runtime.
    if (coreAgents.length > 0) return { status: 200, data: { agents: coreAgents } };
    throw mapRuntimeError(err);
  }
  if (!Array.isArray(list?.agents)) {
    if (coreAgents.length > 0) return { status: 200, data: { agents: coreAgents } };
    throw capabilityUnavailableError("runtime task list is malformed");
  }

  const seenAgentIds = new Set<string>();
  for (const row of coreRows) {
    seenAgentIds.add(row.id);
    if (row.runtime_agent_id) seenAgentIds.add(row.runtime_agent_id);
  }
  const legacyMainAgents: Array<RuntimeAgentSummary & { kind: "main" }> = [];
  for (const candidate of list.agents) {
    if (!isReadableRuntimeMain(candidate, projectId) || seenAgentIds.has(candidate.agent_id)) continue;
    seenAgentIds.add(candidate.agent_id);
    legacyMainAgents.push(asReadableRuntimeMain(candidate));
  }
  return { status: 200, data: { agents: [...coreAgents, ...legacyMainAgents] } };
}

/**
 * GET /projects/:projectId/tasks/:agentId — fetch a single task agent's detail.
 *
 * Core facts win. A Core miss falls back to Runtime only for a legacy main;
 * project/id mismatches, Runtime-only sides, and unknown kinds return 404.
 * Runtime transport failure remains 503 because Core cannot prove whether an
 * unpersisted legacy main exists.
 */
export async function getTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  await requireProjectReadable(ctx, projectId);
  const { rows } = await ctx.pool.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2",
    [agentId, projectId],
  );
  const row = rows[0] as CoreTaskRow | undefined;
  if (row) {
    const detail = taskDetail(row);
    if (row.kind === "side" && row.workspace_id) {
      const workspace = await ctx.pool.query(
        `SELECT state,base_commit,base_manifest_hash,head_commit
           FROM task_workspace WHERE id=$1 AND task_id=$2 AND project_id=$3`,
        [row.workspace_id, row.id, projectId],
      );
      const workspaceRow = workspace.rows[0] as Record<string, unknown> | undefined;
      if (workspaceRow) {
        Object.assign(detail, {
          workspace_state: workspaceRow.state,
          base_commit: workspaceRow.base_commit,
          base_manifest_hash: workspaceRow.base_manifest_hash,
          head_commit: workspaceRow.head_commit,
          workspace_label: `探索副本 ${row.workspace_id.slice(-8)}`,
        });
      }
    }
    // 权限交互快照与上下文水位活在 runtime 会话里——Core-owned 任务也要
    // 合并这两个字段（best-effort：runtime 不可达时缺省，不阻塞 detail）。
    if (row.runtime_agent_id) {
      try {
        const rt = await requireRuntime(ctx).getTask(row.runtime_agent_id);
        if (rt && typeof rt === "object") {
          const extra = rt as { permission?: unknown; context_usage?: unknown };
          if (extra.permission !== undefined) Object.assign(detail, { permission: extra.permission });
          if (extra.context_usage !== undefined) Object.assign(detail, { context_usage: extra.context_usage });
        }
      } catch {
        // runtime 不可达：detail 仍可返回（持久化事实在 Core 侧是完整的）。
      }
    }
    return { status: 200, data: detail };
  }
  const runtime = requireRuntime(ctx);

  let detail: RuntimeAgentDetail;
  try {
    detail = await runtime.getTask(agentId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (!isReadableRuntimeMain(detail, projectId, agentId)) {
    throw notFoundError(`task not found: ${agentId}`);
  }
  return { status: 200, data: asReadableRuntimeMain(detail) };
}

/**
 * POST /projects/:projectId/tasks/:agentId/message — forward a free-agent
 * conversation message (prompt when idle, steer when running). Ownership of
 * the agent is verified before forwarding; the Runtime reply is passed through.
 */
export async function sendTaskMessageHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const coreTask = await findCoreOwnedTaskForWrite(ctx, projectId, agentId);
  const runtime = requireRuntime(ctx);
  const body = asObject(ctx.body);
  const text = requireString(body, "text");

  if (coreTask) {
    if (coreTask.kind === "side" && !p3Enabled(ctx)) {
      throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
    }
    const task = coreTask;
    const write = await runCoreIdempotent<{
      readonly taskId: string;
      readonly runtimeAgentId: string;
      readonly runtimeIdempotencyKey: string;
      readonly eventId: string;
    }>(
      ctx,
      `send_core_task_message:${task.id}`,
      projectId,
      async (tx) => {
        const current = await findCoreOwnedTaskForWriteTx(ctx, tx, projectId, task.id);
        if (!current) throw notFoundError(`task not found: ${task.id}`);
        if (current.kind === "side" && !p3Enabled(ctx)) {
          throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
        }
        requireCoreTaskMessageable(current);
        const dispatchHash = canonicalRequestHash({
          schema: "task-message-dispatch.v1",
          projectId,
          taskId: current.id,
          actorType: ctx.identity.actorType,
          actorId: ctx.identity.actorId,
          idempotencyKey: ctx.idempotencyKey,
        });
        const eventId = `te-${dispatchHash.slice(0, 40)}`;
        await appendConversationEventRecord(
          tx,
          ctx,
          projectId,
          current.id,
          eventId,
          "user_message",
          { text },
        );
        return {
          taskId: current.id,
          runtimeAgentId: current.runtime_agent_id ?? current.id,
          // Core's public idempotency scope includes the actor and project.
          // Namespace the downstream key so two actors may safely choose the
          // same client key without colliding in Runtime's per-agent store.
          runtimeIdempotencyKey: `core-message-${dispatchHash.slice(0, 48)}`,
          eventId,
        };
      },
      async (tx) => {
        const current = await findCoreOwnedTaskForWriteTx(ctx, tx, projectId, task.id);
        if (!current) throw notFoundError(`task not found: ${task.id}`);
        if (current.kind === "side" && !p3Enabled(ctx)) {
          throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
        }
        requireCoreTaskMessageable(current);
      },
    );

    // The Core transaction is the durable boundary. Same-key replays keep the
    // single user_message fact but deliberately re-drive Runtime delivery. The
    // forwarded key lets Runtime distinguish a repair from a second prompt,
    // including the response-lost-after-acceptance window.
    try {
      const reply = await runtime.sendMessage(
        write.result.runtimeAgentId,
        text,
        write.result.runtimeIdempotencyKey,
      );
      return { status: 200, data: reply };
    } catch (err) {
      throw mapRuntimeError(err);
    }
  }

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

/** POST /projects/:projectId/tasks/:agentId/permission — 权限卡片裁决 / skip-all 开关。 */
export async function permissionTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const runtime = requireRuntime(ctx);
  const body = asObject(ctx.body);
  const payload: { callId?: string; allow?: boolean; skipAll?: boolean } = {};
  if (typeof body.skipAll === "boolean") {
    payload.skipAll = body.skipAll;
  } else {
    if (typeof body.callId !== "string" || !body.callId) {
      throw validationError("body must contain callId (string) + allow (boolean), or skipAll (boolean)");
    }
    payload.callId = body.callId;
    payload.allow = body.allow === true;
  }

  // Core-owned 任务用绑定的 runtime agent id；legacy 自由会话直接用 agentId。
  let runtimeAgentId = agentId;
  const coreTask = await findCoreOwnedTaskForWrite(ctx, projectId, agentId).catch(() => null);
  if (coreTask?.runtime_agent_id) runtimeAgentId = coreTask.runtime_agent_id;

  try {
    const response = await runtime.resolveTaskPermission(runtimeAgentId, payload);
    return { status: 200, data: response };
  } catch (err) {
    throw mapRuntimeError(err);
  }
}

/** POST /projects/:projectId/tasks/:agentId/abort — abort the free-agent session. */
export async function abortTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const agentId = ctx.params.agentId!;
  const coreTask = await findCoreOwnedTaskForWrite(ctx, projectId, agentId);

  if (coreTask) {
    if (coreTask.kind === "side" && !p3Enabled(ctx)) {
      throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
    }
    if (!ctx.idempotencyKey) {
      throw validationError("Idempotency-Key header is required for writes");
    }
    const runtime = requireRuntime(ctx);
    const task = coreTask;
    const dispatchHash = canonicalRequestHash({
      schema: "task-abort-dispatch.v1",
      projectId,
      taskId: task.id,
      actorType: ctx.identity.actorType,
      actorId: ctx.identity.actorId,
      idempotencyKey: ctx.idempotencyKey,
    });
    const downstreamKey = `core-abort-${dispatchHash.slice(0, 48)}`;
    const write = await runCoreIdempotent<{
      readonly response: unknown;
    }>(
      ctx,
      `abort_core_task:${task.id}`,
      projectId,
      async (tx) => {
        const current = await findCoreOwnedTaskForWriteTx(ctx, tx, projectId, task.id);
        if (!current) throw notFoundError(`task not found: ${task.id}`);
        if (current.kind === "side" && !p3Enabled(ctx)) {
          throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
        }

        let response: unknown;
        try {
          response = await runtime.abortTask(
            current.runtime_agent_id ?? current.id,
            downstreamKey,
          );
        } catch (err) {
          throw mapRuntimeError(err);
        }

        const cancelled = await tx.query(
          `UPDATE agent_task
              SET status='cancelled',finished_at=now(),updated_at=now(),
                  adoption_state=CASE WHEN kind='side' THEN 'discarded' ELSE adoption_state END
            WHERE id=$1 AND project_id=$2
              AND status IN ('queued','running','awaiting_user')
            RETURNING id`,
          [current.id, projectId],
        );
        if (cancelled.rows.length > 0) {
          await appendConversationEventRecord(
            tx,
            ctx,
            projectId,
            current.id,
            `te-${dispatchHash.slice(0, 40)}`,
            "status",
            { status: "cancelled" },
          );
        }
        return { response };
      },
      async (tx) => {
        const current = await findCoreOwnedTaskForWriteTx(ctx, tx, projectId, task.id);
        if (!current) throw notFoundError(`task not found: ${task.id}`);
        if (current.kind === "side" && !p3Enabled(ctx)) {
          throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
        }
      },
    );
    return { status: 200, data: write.result.response };
  }

  const runtime = requireRuntime(ctx);
  let detail: RuntimeAgentDetail;
  try {
    detail = await runtime.getTask(agentId);
  } catch (err) {
    throw mapRuntimeError(err);
  }
  if (detail.project_id !== projectId) throw notFoundError(`task not found: ${agentId}`);

  try {
    const legacyDownstreamKey = ctx.idempotencyKey
      ? `core-legacy-abort-${canonicalRequestHash({
          schema: "legacy-task-abort-dispatch.v1",
          projectId,
          agentId,
          actorType: ctx.identity.actorType,
          actorId: ctx.identity.actorId,
          idempotencyKey: ctx.idempotencyKey,
        }).slice(0, 41)}`
      : undefined;
    const result = await runtime.abortTask(agentId, legacyDownstreamKey);
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
  await requireProjectReadable(ctx, projectId);
  const runtime = requireRuntime(ctx);

  const coreTask = await findCoreOwnedTask(ctx, projectId, agentId);
  if (coreTask) {
    const task = coreTask;
    let upstream: Response;
    try {
      upstream = await runtime.streamTask(task.runtime_agent_id ?? task.id, {
        signal: ctx.request.signal,
        lastEventId: ctx.request.headers.get("last-event-id"),
        from: ctx.url.searchParams.get("from"),
      });
    } catch (err) {
      throw mapRuntimeError(err);
    }
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
