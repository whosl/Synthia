/**
 * Synthia Core API — command/query handlers (IF-001 §3 first slice)
 *
 * Every write handler is idempotency-scoped on
 *   (actorType, actorId=uid, projectId, operation, key=Idempotency-Key)
 * reusing the existing `idempotency_records` table. Same key + same canonical
 * request hash replays the stored response; same key + different hash is a
 * stable 409 conflict. Each write appends a monotonic outbox event so the
 * events query reflects real committed state.
 *
 * The approval handler delegates to the existing `approveGateSubmission`
 * service (no semantic weakening) and is hard-denied for service identities
 * (403) before the service is reached.
 */

import type { Client } from "pg";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  appendOutboxEventInTx,
  claimIdempotencySlot,
  completeIdempotencySlot,
  createRevision,
  createSnapshot,
  createSubmission,
  createTraceRelation,
  findRoleAssignment,
  lockGateSubmission,
  transitionSubmissionState,
  withTransaction,
  type GateSubmissionLock,
  type TransactionClient,
} from "../db/repository.ts";
import { canonicalRequestHash, computeManifestHash, sha256Hex } from "../hashing.ts";
import { approveGateSubmission, type ApproveGateSubmissionInput } from "../services/approval.ts";
import { ConflictError, InvariantError } from "../memory-repository.ts";
import { gateSubmissionMachine } from "../domain/state-machines.ts";
import type { DataClassification, GateId, GateSubmissionState, RunClass, TraceRelationState } from "../domain/enums.ts";
import type { AuthenticatedIdentity } from "./auth.ts";
import {
  ApiError,
  capabilityUnavailableError,
  conflictApiError,
  forbiddenError,
  internalError,
  isPgUniqueViolation,
  notFoundError,
  validationError,
} from "./errors.ts";
import {
  CAPABILITY_UNAVAILABLE_CODES,
  CONNECTOR_NOT_FOUND_CODES,
  ConnectorError,
  type ConnectorPort,
  type SourceInput,
} from "./connector-port.ts";
import type { RuntimeClient } from "./task-proxy.ts";
import { parseGitLocation, validateProjectId } from "../workspace/paths.ts";
import { ensureWorkspace, readAtLocation } from "../workspace/store.ts";
import { freezeBaselineContent } from "../workspace/archive.ts";
import type { CoreFeatureFlags } from "./feature-flags.ts";

// ─── shared request context ──────────────────────────────────────────────────

export interface RequestContext {
  readonly pool: Pool;
  readonly identity: AuthenticatedIdentity;
  readonly method: string;
  readonly url: URL;
  /**
   * 原始 Request。仅 SSE 透传使用（需要 `last-event-id` 请求头与客户端断连的
   * abort signal，二者都无法从解析后的字段还原）；其余处理器请用上面的字段。
   */
  readonly request: Request;
  readonly params: Record<string, string>;
  /** Parsed JSON body (POST only); null for GET. */
  readonly body: unknown;
  readonly correlationId: string;
  readonly idempotencyKey: string | null;
  readonly classification: string;
  /** Connector port for the run/Job slice; undefined when not configured (Job endpoints → 503). */
  readonly connector?: ConnectorPort;
  /** Runtime client for the task-workbench slice; undefined when not configured (task endpoints → 503). */
  readonly runtimeClient?: RuntimeClient;
  /** Explicitly resolved Core capabilities. Missing flags are fail-closed. */
  readonly featureFlags?: Readonly<CoreFeatureFlags>;
}

export interface HandlerResult {
  readonly status: number;
  readonly data: unknown;
}

// ─── helpers ─────────────────────────────────────────────────────────────────
//
// 下面几个 helper 除了本文件，还被 `workspace-handlers.ts` 复用（工作区那几条也要
// 走同一套幂等/事务/outbox 语义）。它们导出**只是为了那个兄弟模块**，不是给外部用的
// 公共 API——handlers.ts 是处理器内核，workspace-handlers.ts 是它的一部分，只是分了文件。

/** Bridge a TransactionClient to the `Client` type expected by CRUD repository
 *  functions. Runtime-safe: those functions only call `.query()`. */
export function asClient(tx: TransactionClient): Client {
  return tx as unknown as Client;
}

export function asObject(value: unknown): Record<string, unknown> {
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

export function optionalString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") throw validationError(`field '${key}' must be a string`);
  return v;
}

function optionalNullableString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw validationError(`field '${key}' must be a string or null`);
  return v;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw validationError(`field '${key}' must be an array of strings`);
  }
  return v as string[];
}

function optionalObject(obj: Record<string, unknown>, key: string): unknown {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw validationError(`field '${key}' must be a JSON object`);
  return v;
}

/** Enum vocabularies mirrored from the DB (validated at the API boundary so an
 *  illegal value never reaches a PG constraint and surfaces as a 500 leak). */
const CLASSIFICATION_VALUES: Record<string, true> = { D1: true, D2: true, D3: true, D4: true, UNCLASSIFIED: true };
const PROJECT_TYPE_VALUES: Record<string, true> = { free: true, engineering: true };
const GATE_VALUES: Record<string, true> = { G0: true, G1: true, G2: true, G3: true, G4: true, G5: true, G6: true, G7: true, G8: true, G9: true };
const TRACE_STATE_VALUES: Record<string, true> = { candidate: true, in_review: true, approved: true, rejected: true, review_required: true, superseded: true, invalidated: true };

const GJB_REF_V1 = {
  id: "GJB_REF_V1",
  version: "GJB_REF_V1",
  name: "GJB 参考流程 v1",
  status: "active",
} as const;

const LEGACY_COMPAT = {
  id: "LEGACY_COMPAT",
  version: "LEGACY_COMPAT",
  name: "兼容旧流程",
  status: "retired",
} as const;

interface ProjectProcessBindingRow {
  readonly project_type: string;
  readonly process_profile_id: string | null;
}

async function requireProjectProcessBinding(
  tx: TransactionClient,
  projectId: string,
): Promise<ProjectProcessBindingRow> {
  const { rows } = await tx.query(
    "SELECT project_type, process_profile_id FROM project WHERE id = $1",
    [projectId],
  );
  const project = rows[0] as ProjectProcessBindingRow | undefined;
  if (!project) throw notFoundError(`project not found: ${projectId}`);
  return project;
}

/**
 * Return the profile that every process-bound child row must use for a modern
 * engineering project. Free and LEGACY_COMPAT projects deliberately retain
 * their pre-P1 defaults and are not tightened by this compatibility bridge.
 */
function frozenModernProcessProfile(project: ProjectProcessBindingRow): string | null {
  if (project.project_type !== "engineering" || project.process_profile_id === LEGACY_COMPAT.id) {
    return null;
  }
  if (typeof project.process_profile_id !== "string" || project.process_profile_id.trim().length === 0) {
    throw conflictApiError("PROJECT_PROCESS_PROFILE_INVALID", {
      projectType: project.project_type,
      processProfileId: project.process_profile_id,
    });
  }
  return project.process_profile_id;
}

function resolveGateProfileVersion(
  body: Record<string, unknown>,
  frozenProfile: string | null,
): string {
  const gateProfile = optionalString(body, "gate_profile_version", frozenProfile ?? "flow-v1");
  if (frozenProfile !== null && gateProfile !== frozenProfile) {
    throw conflictApiError("PROCESS_PROFILE_IMMUTABLE", {
      expected: frozenProfile,
      received: gateProfile,
    });
  }
  return gateProfile;
}

function assertFrozenGateProfile(
  frozenProfile: string | null,
  actual: unknown,
  resource: "process_instance" | "configuration_snapshot",
): void {
  if (frozenProfile !== null && actual !== frozenProfile) {
    throw conflictApiError("PROCESS_PROFILE_IMMUTABLE", {
      resource,
      expected: frozenProfile,
      received: actual,
    });
  }
}

/** Every field whose presence makes a project-create request part of the new
 * project/process contract. A compatibility request must omit all of them. */
const MODERN_PROJECT_PROCESS_FIELDS = [
  "project_type",
  "process_version_id",
  "process_profile_id",
  "process_profile",
  "process_profile_version",
  "process_profile_name",
] as const;

/** Maximum inline revision content (1 MiB, measured in UTF-8 bytes). */
export const MAX_CONTENT_BYTES = 1024 * 1024;

function requireEnum(value: unknown, key: string, valid: Record<string, true>): string {
  if (typeof value !== "string" || !(value in valid)) {
    throw validationError(`field '${key}' must be one of: ${Object.keys(valid).join(", ")}`);
  }
  return value;
}

/** Verify a project exists; throws 404 (not a validation error) if missing. */
export async function requireProject(tx: TransactionClient, projectId: string): Promise<void> {
  const { rows } = await tx.query("SELECT 1 FROM project WHERE id = $1", [projectId]);
  if (rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
}

/**
 * Run an idempotent write inside one transaction. The work callback receives
 * the transaction client and must perform all writes + the outbox append on it.
 * On same-key replay the stored response is returned; same-key-different-hash
 * raises a 409 conflict.
 */
export async function runIdempotent<T>(
  ctx: RequestContext,
  operation: string,
  projectId: string,
  work: (tx: TransactionClient) => Promise<T>,
  authorize?: (tx: TransactionClient) => Promise<void>,
): Promise<{ result: T; replayed: boolean }> {
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
      // Authorization is deliberately evaluated before the idempotency claim.
      // A completed replay must not return a cached response after the actor's
      // project access is revoked or the project becomes ineligible for the
      // operation. Keeping this check in the same transaction also avoids a
      // handler-level preflight racing with claim/replay.
      if (authorize) await authorize(tx);
      const claim = await claimIdempotencySlot(tx, scope, requestHash);
      if (claim.owned) {
        const result = await work(tx);
        await completeIdempotencySlot(tx, scope, requestHash, result);
        return { result, replayed: false };
      }
      if (!claim.existing) throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
      if (claim.existing.requestHash !== requestHash) throw conflictApiError("IDEMPOTENCY_CONFLICT", { operation });
      if (claim.existing.status !== "completed") throw conflictApiError("IDEMPOTENCY_IN_PROGRESS", { operation }, true);
      return { result: decodeResponse<T>(claim.existing.response), replayed: true };
    });
  } finally {
    conn.release();
  }
}

function decodeResponse<T>(response: unknown): T {
  if (typeof response === "string") {
    try {
      return JSON.parse(response) as T;
    } catch {
      throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
    }
  }
  return response as T;
}

/** Map an approval-service error (ConflictError / InvariantError) to an ApiError. */
function mapServiceError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ConflictError) return conflictApiError(err.message);
  if (err instanceof InvariantError) {
    const msg = err.message;
    if (msg === "APPROVAL_AUTHORIZATION_DENIED") return forbiddenError(msg);
    if (msg === "STATE_TRANSITION_CONFLICT") return conflictApiError(msg, null, true);
    if (msg.includes("NOT_FOUND")) return notFoundError(msg);
    // remaining invariant failures are payload/state validation issues
    return validationError(msg);
  }
  // Approving a milestone gate whose (project_id, kind) already has an active
  // baseline trips `baseline_unique_active_project_kind`. Without this branch the
  // 23505 falls through to internalError below and the client sees a 500 — and
  // because callers `throw mapServiceError(err)`, it never reaches the router's
  // own isPgUniqueViolation branch (router.ts), which is dead code for approve.
  if (isPgUniqueViolation(err)) return conflictApiError("ACTIVE_BASELINE_CONFLICT", null, false);
  return internalError(err instanceof Error ? err.message : "unknown service error");
}

export function outboxEvent(tx: TransactionClient, ctx: RequestContext, aggregate: { type: string; id: string }, eventType: string, payload: unknown): Promise<number> {
  return appendOutboxEventInTx(tx, {
    eventId: randomUUID(),
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

// ─── 1. Project / Process ────────────────────────────────────────────────────

export async function createProject(ctx: RequestContext): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  const id = requireString(body, "id");
  const name = requireString(body, "name");
  // 项目 id 同时是磁盘上的工作区目录名，所以在建库之前就要挡住不能当目录名的 id，
  // 而不是等到第一次写文件时才失败——那时项目已经建好了，工作区却永远建不出来。
  validateProjectId(id);

  const dataClassification = optionalString(body, "data_classification", "D1");
  requireEnum(dataClassification, "data_classification", CLASSIFICATION_VALUES);
  const legacyCompatibility = MODERN_PROJECT_PROCESS_FIELDS.every((field) => body[field] === undefined);
  const projectType = optionalString(body, "project_type", legacyCompatibility ? "engineering" : "free");
  requireEnum(projectType, "project_type", PROJECT_TYPE_VALUES);
  // These are frozen server-owned snapshots, not selection aliases. Silently
  // ignoring a client-supplied value could turn a malformed modern request into
  // a LEGACY_COMPAT project or conceal a conflicting version/name.
  if (body.process_profile_version !== undefined || body.process_profile_name !== undefined) {
    throw validationError("process_profile_version and process_profile_name are read-only");
  }
  const suppliedProfiles = [body.process_profile_id, body.process_profile, body.process_version_id]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError("field 'process_profile_id' must be a non-empty string");
      }
      return value.trim();
    });
  if (new Set(suppliedProfiles).size > 1) {
    throw validationError("process profile fields must identify the same version");
  }
  const requestedProfile = suppliedProfiles[0] ?? (legacyCompatibility ? LEGACY_COMPAT.id : undefined);
  // The device is optional for both project types at creation time. Formal
  // engineering runs will validate that it has been filled in later; creation
  // must not silently invent a device for a project that does not have one.
  const requestedTargetPart = optionalNullableString(body, "target_part");
  // Keep the historical default only for the legacy request shape. New
  // explicit free/engineering projects remain genuinely nullable.
  const targetPart = requestedTargetPart ?? (legacyCompatibility ? "xc7vx690tffg1761-2" : null);

  if (projectType === "engineering" && !requestedProfile) {
    throw validationError("engineering projects require process_profile_id");
  }
  if (projectType === "free" && requestedProfile) {
    throw validationError("free projects cannot select a process profile");
  }
  if (!legacyCompatibility && requestedProfile && requestedProfile !== GJB_REF_V1.id) {
    throw validationError("process_profile_id must reference a supported active process version");
  }

  const { result } = await runIdempotent(ctx, "create_project", id, async (tx) => {
    let profile: { id: string; version: string; name: string } | null = null;
    if (requestedProfile) {
      const expectedProfile = legacyCompatibility ? LEGACY_COMPAT : GJB_REF_V1;
      const profileResult = await tx.query(
        `SELECT id, version, name FROM process_version
          WHERE id = $1 AND profile_id = $1 AND version = $2
            AND name = $3 AND status = $4`,
        [requestedProfile, expectedProfile.version, expectedProfile.name, expectedProfile.status],
      );
      profile = profileResult.rows[0] as { id: string; version: string; name: string } | undefined ?? null;
      if (!profile) throw validationError("process_profile_id must reference an active process version");
    }
    // Workspace creation is part of a successful project create. Keep the
    // idempotency slot and project/outbox writes uncommitted until it succeeds;
    // otherwise a filesystem error would return 500 while permanently storing
    // a successful response for the same key.
    await ensureWorkspace(id);
    // Detect a prior create of the same id with DIFFERENT content. A same-id
    // request must either replay the identical project (idempotent) or surface
    // a stable 409 conflict — never silently 201 with a different payload.
    const insertResult = await tx.query(
      `INSERT INTO project (id, name, scope, data_classification, standard_version, target_part, toolchain_profile_ref, project_type, process_version_id, process_profile_id, process_profile_version, process_profile_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        id,
        name,
        optionalString(body, "scope", ""),
        dataClassification,
        optionalString(body, "standard_version", "GB/T 33781-2017"),
        targetPart,
        (body.toolchain_profile_ref ?? null) as string | null,
        projectType,
        requestedProfile ?? null,
        requestedProfile ?? null,
        profile?.version ?? null,
        profile?.name ?? null,
      ],
    );
    if (insertResult.rows.length === 0) {
      // Row already exists; reject if the new payload differs from the stored one.
      const existing = await tx.query(
        "SELECT name, scope, data_classification, standard_version, target_part, toolchain_profile_ref, project_type, process_version_id, process_profile_id, process_profile_version, process_profile_name, status FROM project WHERE id = $1",
        [id],
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw internalError("PROJECT_INSERT_RACE");
      const same =
        row.name === name &&
        row.scope === optionalString(body, "scope", "") &&
        row.data_classification === dataClassification &&
        row.standard_version === optionalString(body, "standard_version", "GB/T 33781-2017") &&
        row.target_part === targetPart &&
        row.toolchain_profile_ref === ((body.toolchain_profile_ref ?? null) as string | null) &&
        row.project_type === projectType &&
        row.process_version_id === (requestedProfile ?? null) &&
        row.process_profile_id === (requestedProfile ?? null);
      if (!same) throw conflictApiError("PROJECT_ALREADY_EXISTS_DIFFERENT_PAYLOAD", { id });
      // Same payload: idempotent — return the stored project, no new outbox event.
      const existingProcess = await tx.query(
        `SELECT id, gate_profile_version, current_gate, created_at
           FROM process_instance WHERE project_id = $1 ORDER BY created_at`,
        [id],
      );
      return {
        id,
        name: row.name as string,
        status: row.status as string,
        project_type: row.project_type,
        process_profile_id: row.process_profile_id,
        process_profile_version: row.process_profile_version,
        process_profile_name: row.process_profile_name,
        process_version_id: row.process_version_id,
        target_part: row.target_part,
        process_instances: existingProcess.rows,
      };
    }
    let createdProcessInstances: unknown[] = [];
    if (projectType === "engineering" && !legacyCompatibility) {
      const pi = `pi_${id}_G0`;
      const processInsert = await tx.query(
        `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
         VALUES ($1,$2,$3,'G0') ON CONFLICT DO NOTHING
         RETURNING id, gate_profile_version, current_gate, created_at`,
        [pi, id, requestedProfile],
      );
      if (processInsert.rows.length !== 1) {
        throw conflictApiError("PROCESS_INSTANCE_ID_CONFLICT", { id: pi, projectId: id });
      }
      createdProcessInstances = processInsert.rows;
      await appendOutboxEventInTx(tx, {
        eventId: randomUUID(),
        aggregateType: "process_instance",
        aggregateId: pi,
        eventType: "process.created",
        projectId: id,
        payload: { id: pi, projectId: id, gateProfile: requestedProfile, currentGate: "G0" },
        correlationId: ctx.correlationId,
        causationId: null,
        classification: ctx.classification,
      });
    }
    await appendOutboxEventInTx(tx, {
      eventId: randomUUID(),
      aggregateType: "project",
      aggregateId: id,
      eventType: "project.created",
      projectId: id,
      payload: { id, name, project_type: projectType, process_profile_id: requestedProfile ?? null },
      correlationId: ctx.correlationId,
      causationId: null,
      classification: ctx.classification,
    });
    return {
      id,
      name,
      status: "active",
      project_type: projectType,
      process_version_id: requestedProfile ?? null,
      process_profile_id: requestedProfile ?? null,
      process_profile_version: profile?.version ?? null,
      process_profile_name: profile?.name ?? null,
      target_part: targetPart,
      process_instances: createdProcessInstances,
    };
  });

  return { status: 201, data: result };
}

/**
 * POST /projects/:projectId/copy-as-engineering
 *
 * P1 formalization is intentionally narrow: it creates a new
 * engineering+GJB_REF_V1 project, copies only project-level configuration, and
 * records an immutable source relation. The target gets a fresh empty workspace
 * and G0 instance; artifacts, revisions, roles, historical process state and
 * source workspace bytes remain with the source project (their copy semantics
 * belong to P2).
 */
export async function copyProjectAsEngineering(ctx: RequestContext): Promise<HandlerResult> {
  const sourceProjectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");
  const name = requireString(body, "name");
  validateProjectId(id);
  if (id === sourceProjectId) {
    throw validationError("copy target id must differ from source project id");
  }

  for (const field of [
    ...MODERN_PROJECT_PROCESS_FIELDS,
    "scope",
    "data_classification",
    "standard_version",
    "toolchain_profile_ref",
  ]) {
    if (body[field] !== undefined) {
      throw validationError(`field '${field}' is derived by copy-as-engineering and cannot be supplied`);
    }
  }
  const hasTargetPartOverride = body.target_part !== undefined;
  const requestedTargetPart = optionalNullableString(body, "target_part");

  const { result } = await runIdempotent(ctx, "copy_project_as_engineering", sourceProjectId, async (tx) => {
    const sourceResult = await tx.query(
      `SELECT id, scope, data_classification, standard_version, target_part,
              toolchain_profile_ref, project_type, process_version_id,
              process_profile_id, process_profile_version, process_profile_name
         FROM project WHERE id = $1 FOR UPDATE`,
      [sourceProjectId],
    );
    const source = sourceResult.rows[0] as Record<string, unknown> | undefined;
    if (!source) throw notFoundError(`project not found: ${sourceProjectId}`);

    const freeSource =
      source.project_type === "free" &&
      source.process_version_id === null &&
      source.process_profile_id === null &&
      source.process_profile_version === null &&
      source.process_profile_name === null;
    const legacySource =
      source.project_type === "engineering" &&
      source.process_version_id === LEGACY_COMPAT.id &&
      source.process_profile_id === LEGACY_COMPAT.id &&
      source.process_profile_version === LEGACY_COMPAT.version &&
      source.process_profile_name === LEGACY_COMPAT.name;
    if (!freeSource && !legacySource) {
      throw conflictApiError("PROJECT_COPY_SOURCE_NOT_ELIGIBLE", {
        sourceProjectId,
        projectType: source.project_type,
        processVersionId: source.process_version_id,
      });
    }

    const profileResult = await tx.query(
      `SELECT id, version, name FROM process_version
        WHERE id = $1 AND profile_id = $1 AND version = $2
          AND name = $3 AND status = $4`,
      [GJB_REF_V1.id, GJB_REF_V1.version, GJB_REF_V1.name, GJB_REF_V1.status],
    );
    const profile = profileResult.rows[0] as { id: string; version: string; name: string } | undefined;
    if (!profile) throw validationError("GJB_REF_V1 is not an active supported process version");

    const targetPart = hasTargetPartOverride ? requestedTargetPart : (source.target_part as string | null);
    await ensureWorkspace(id);
    const insertResult = await tx.query(
      `INSERT INTO project (
         id, name, scope, data_classification, standard_version, target_part,
         toolchain_profile_ref, project_type, process_version_id,
         process_profile_id, process_profile_version, process_profile_name, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'engineering',$8,$8,$9,$10,'active')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        id,
        name,
        source.scope,
        source.data_classification,
        source.standard_version,
        targetPart,
        source.toolchain_profile_ref,
        profile.id,
        profile.version,
        profile.name,
      ],
    );

    if (insertResult.rows.length === 0) {
      const existingResult = await tx.query(
        `SELECT id, name, scope, data_classification, standard_version, target_part,
                toolchain_profile_ref, status, project_type, process_version_id,
                process_profile_id, process_profile_version, process_profile_name
           FROM project WHERE id = $1`,
        [id],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      const relationResult = await tx.query(
        `SELECT source_project_id, target_project_id, relation_kind,
                created_by_type, created_by, created_at
           FROM project_source_relation WHERE target_project_id = $1`,
        [id],
      );
      const relation = relationResult.rows[0] as Record<string, unknown> | undefined;
      const processResult = await tx.query(
        `SELECT id, gate_profile_version, current_gate, created_at
           FROM process_instance WHERE project_id = $1 ORDER BY created_at, id`,
        [id],
      );
      const process = processResult.rows[0] as Record<string, unknown> | undefined;
      const same =
        existing?.name === name &&
        existing.scope === source.scope &&
        existing.data_classification === source.data_classification &&
        existing.standard_version === source.standard_version &&
        existing.target_part === targetPart &&
        existing.toolchain_profile_ref === source.toolchain_profile_ref &&
        existing.status === "active" &&
        existing.project_type === "engineering" &&
        existing.process_version_id === GJB_REF_V1.id &&
        existing.process_profile_id === GJB_REF_V1.id &&
        existing.process_profile_version === GJB_REF_V1.version &&
        existing.process_profile_name === GJB_REF_V1.name &&
        relation?.source_project_id === sourceProjectId &&
        relation?.target_project_id === id &&
        relation?.relation_kind === "copied_as_engineering" &&
        processResult.rows.length === 1 &&
        process?.id === `pi_${id}_G0` &&
        process?.gate_profile_version === GJB_REF_V1.id &&
        process?.current_gate === "G0";
      if (!same) throw conflictApiError("PROJECT_ALREADY_EXISTS_DIFFERENT_PAYLOAD", { id });
      return {
        ...existing,
        process_instances: processResult.rows,
        source_relation: relation,
        workspace_content_copied: false,
      };
    }

    const processId = `pi_${id}_G0`;
    const processInsert = await tx.query(
      `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
       VALUES ($1,$2,$3,'G0') ON CONFLICT DO NOTHING
       RETURNING id, gate_profile_version, current_gate, created_at`,
      [processId, id, GJB_REF_V1.id],
    );
    if (processInsert.rows.length !== 1) {
      throw conflictApiError("PROCESS_INSTANCE_ID_CONFLICT", { id: processId, projectId: id });
    }
    const relationInsert = await tx.query(
      `INSERT INTO project_source_relation (
         target_project_id, source_project_id, relation_kind, created_by_type, created_by
       ) VALUES ($1,$2,'copied_as_engineering',$3,$4)
       RETURNING source_project_id, target_project_id, relation_kind,
                 created_by_type, created_by, created_at`,
      [id, sourceProjectId, ctx.identity.actorType, ctx.identity.actorId],
    );
    const relation = relationInsert.rows[0];

    await appendOutboxEventInTx(tx, {
      eventId: randomUUID(),
      aggregateType: "process_instance",
      aggregateId: processId,
      eventType: "process.created",
      projectId: id,
      payload: { id: processId, projectId: id, gateProfile: GJB_REF_V1.id, currentGate: "G0" },
      correlationId: ctx.correlationId,
      causationId: null,
      classification: ctx.classification,
    });
    await appendOutboxEventInTx(tx, {
      eventId: randomUUID(),
      aggregateType: "project",
      aggregateId: id,
      eventType: "project.created",
      projectId: id,
      payload: {
        id,
        name,
        project_type: "engineering",
        process_profile_id: GJB_REF_V1.id,
        source_project_id: sourceProjectId,
      },
      correlationId: ctx.correlationId,
      causationId: null,
      classification: ctx.classification,
    });
    await appendOutboxEventInTx(tx, {
      eventId: randomUUID(),
      aggregateType: "project_source_relation",
      aggregateId: id,
      eventType: "project.copied_as_engineering",
      projectId: id,
      payload: { sourceProjectId, targetProjectId: id, workspaceContentCopied: false },
      correlationId: ctx.correlationId,
      causationId: null,
      classification: ctx.classification,
    });

    return {
      id,
      name,
      status: "active",
      project_type: "engineering",
      process_version_id: profile.id,
      process_profile_id: profile.id,
      process_profile_version: profile.version,
      process_profile_name: profile.name,
      target_part: targetPart,
      process_instances: processInsert.rows,
      source_relation: relation,
      workspace_content_copied: false,
    };
  });

  return { status: 201, data: result };
}

export async function getProject(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const { rows } = await ctx.pool.query(
    `SELECT id, name, scope, data_classification, standard_version, target_part,
            toolchain_profile_ref, status, created_at, project_type,
            process_profile_id, process_profile_version, process_profile_name,
            process_version_id
       FROM project WHERE id = $1`,
    [projectId],
  );
  if (rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  const procRows = await ctx.pool.query(
    `SELECT id, gate_profile_version, current_gate, created_at
       FROM process_instance WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  const relationRows = await ctx.pool.query(
    `SELECT source_project_id, target_project_id, relation_kind,
            created_by_type, created_by, created_at
       FROM project_source_relation WHERE target_project_id = $1`,
    [projectId],
  );
  return {
    status: 200,
    data: {
      ...rows[0],
      process_instances: procRows.rows,
      source_relation: relationRows.rows[0] ?? null,
    },
  };
}

/**
 * GET /projects — list all projects (core:read). Returns the stable contract
 * fields, ordered by created_at descending (newest first).
 */
export async function getProjects(ctx: RequestContext): Promise<HandlerResult> {
  const { rows } = await ctx.pool.query(
    `SELECT id, name, status, data_classification, created_at, project_type,
            target_part, process_profile_id, process_profile_version, process_profile_name,
            process_version_id
       FROM project ORDER BY created_at DESC`,
  );
  const processRows = rows.length === 0 ? { rows: [] } : await ctx.pool.query(
    `SELECT id, project_id, gate_profile_version, current_gate, created_at
       FROM process_instance WHERE project_id = ANY($1::text[]) ORDER BY created_at`,
    [rows.map((row) => row.id)],
  );
  const grouped = new Map<string, unknown[]>();
  for (const process of processRows.rows) {
    const list = grouped.get(process.project_id) ?? [];
    const { project_id: _projectId, ...publicProcess } = process;
    list.push(publicProcess);
    grouped.set(process.project_id, list);
  }
  return { status: 200, data: rows.map((row) => ({ ...row, process_instances: grouped.get(row.id) ?? [] })) };
}

/** GET /process-versions — active process versions available for engineering projects. */
export async function getProcessVersions(ctx: RequestContext): Promise<HandlerResult> {
  const { rows } = await ctx.pool.query(
    `SELECT id, profile_id, version, name, status,
            id AS process_profile_id, version AS process_profile_version,
            name AS process_profile_name
       FROM process_version
      WHERE id = $1 AND profile_id = $1 AND version = $2
        AND name = $3 AND status = $4
      ORDER BY id`,
    [GJB_REF_V1.id, GJB_REF_V1.version, GJB_REF_V1.name, GJB_REF_V1.status],
  );
  return { status: 200, data: rows };
}

export async function createProcessInstance(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");

  const { result } = await runIdempotent(ctx, "create_process_instance", projectId, async (tx) => {
    const project = await requireProjectProcessBinding(tx, projectId);
    const gateProfile = resolveGateProfileVersion(body, frozenModernProcessProfile(project));
    const currentGate = optionalString(body, "current_gate", "G0");
    requireEnum(currentGate, "current_gate", GATE_VALUES);
    await tx.query(
      `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
       VALUES ($1,$2,$3,$4)`,
      [id, projectId, gateProfile, currentGate],
    );
    await outboxEvent(tx, ctx, { type: "process_instance", id }, "process.created", { id, projectId, gateProfile, currentGate });
    return { id, projectId, gateProfile, currentGate };
  });

  return { status: 201, data: result };
}

export async function assignRole(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");
  // NOTE: actor_type / actor_id / role describe the ASSIGNEE (domain data),
  // not the requester. The requester identity is always ctx.identity (token).
  const assigneeType = requireString(body, "actor_type");
  const assigneeId = requireString(body, "actor_id");
  const role = requireString(body, "role");

  const { result } = await runIdempotent(ctx, "assign_role", projectId, async (tx) => {
    await requireProject(tx, projectId);
    await tx.query(
      `INSERT INTO role_assignment (id, project_id, actor_type, actor_id, role, permissions)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, projectId, assigneeType, assigneeId, role, JSON.stringify(optionalObject(body, "permissions") ?? {})],
    );
    await outboxEvent(tx, ctx, { type: "role_assignment", id }, "role.assigned", { id, projectId, assigneeType, assigneeId, role });
    return { id, projectId, actorType: assigneeType, actorId: assigneeId, role };
  });

  return { status: 201, data: result };
}

// ─── 2. Artifact / Revision ──────────────────────────────────────────────────

export async function createRevisionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const artifactId = ctx.params.artifactId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");
  // version 可省略：省略时由服务端在事务里取「当前最大版本 + 1」。这是自由 agent
  // 能出第二版的前提——客户端不可能安全地自己算下一版（读到写之间会有竞争），
  // 以前写死 1 导致同一产物第二次登记必然撞 `UNIQUE (artifact_id, version)`。
  const versionNum = body.version;
  const versionRequested: number | null = versionNum === undefined || versionNum === null ? null : (() => {
    if (typeof versionNum !== "number" || !Number.isInteger(versionNum) || versionNum < 1) {
      throw validationError("field 'version' must be a positive integer");
    }
    return versionNum;
  })();
  // Content may be supplied inline. When present, the server computes content_hash
  // (a client-supplied content_hash that disagrees is a 400) and content_location
  // defaults to db://artifact_revision/<id>. When absent, content_hash is required
  // and the client addresses out-of-band content via content_location.
  let content: string | null = null;
  let contentHash: string;
  if (body.content !== undefined && body.content !== null) {
    if (typeof body.content !== "string") throw validationError("field 'content' must be a string");
    if (Buffer.byteLength(body.content, "utf8") > MAX_CONTENT_BYTES) {
      throw validationError(`field 'content' must be at most ${MAX_CONTENT_BYTES} bytes`);
    }
    content = body.content;
    contentHash = sha256Hex(content);
    if (body.content_hash !== undefined && body.content_hash !== null) {
      if (typeof body.content_hash !== "string") throw validationError("field 'content_hash' must be a string");
      if (body.content_hash !== contentHash) {
        throw validationError("content_hash does not match sha256(content)", { expected: contentHash });
      }
    }
  } else {
    contentHash = requireString(body, "content_hash");
  }
  const contentLocation = optionalString(body, "content_location", `db://artifact_revision/${id}`);

  requireEnum(optionalString(body, "data_classification", "D1"), "data_classification", CLASSIFICATION_VALUES);

  const { result } = await runIdempotent(ctx, "create_revision", projectId, async (tx) => {
    await requireProject(tx, projectId);

    // Upsert the artifact container (first revision creates it).
    await tx.query(
      `INSERT INTO artifact (id, project_id, artifact_type, title)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
      [
        artifactId,
        projectId,
        optionalString(body, "artifact_type", "SYSTEM_REQUIREMENTS"),
        optionalString(body, "title", `Artifact ${artifactId}`),
      ],
    );

    // 这条 upsert 会把 artifact 行锁到事务结束，所以下面读到的 MAX(version) 在本事务
    // 里是稳定的：同一 artifact 的并发登记会阻塞在各自的 upsert 上，依次拿到 n、n+1。
    const currentMaxResult = await tx.query(
      "SELECT COALESCE(MAX(version), 0)::int AS max FROM artifact_revision WHERE artifact_id = $1",
      [artifactId],
    );
    const currentMax = (currentMaxResult.rows[0] as { max: number } | undefined)?.max ?? 0;

    // Optional optimistic concurrency: expected_version = current max artifact version.
    if (body.expected_version !== undefined && body.expected_version !== null) {
      if (typeof body.expected_version !== "number" || !Number.isInteger(body.expected_version)) {
        throw validationError("field 'expected_version' must be an integer");
      }
      if (currentMax !== body.expected_version) {
        throw conflictApiError("REVISION_VERSION_CONFLICT", { artifactId, current: currentMax, expected: body.expected_version });
      }
    }

    const versionNum = versionRequested ?? currentMax + 1;

    const revRow = {
      id,
      artifactId,
      projectId,
      version: versionNum,
      state: "candidate" as const,
      parentRevisionId: (body.parent_revision_id ?? null) as string | null,
      contentHash,
      contentLocation,
      content,
      schemaVersion: optionalString(body, "schema_version", "v1"),
      sourceIds: optionalStringArray(body, "source_ids"),
      dataClassification: optionalString(body, "data_classification", "D1") as DataClassification,
      toolModelProvenance: optionalObject(body, "tool_model_provenance") as object | null,
      changeReason: optionalString(body, "change_reason", ""),
      createdBy: ctx.identity.actorId,
      createdByType: ctx.identity.actorType,
      reviewIds: optionalStringArray(body, "review_ids"),
      createdAt: new Date().toISOString(),
    };
    await createRevision(asClient(tx), revRow);
    await outboxEvent(tx, ctx, { type: "artifact_revision", id }, "revision.created", { id, artifactId, projectId, version: versionNum, state: "candidate" });
    return { id, artifactId, projectId, version: versionNum, state: "candidate" };
  });

  return { status: 201, data: result };
}

export async function getRevision(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const revId = ctx.params.revId!;
  const { rows } = await ctx.pool.query(
    `SELECT id, artifact_id, project_id, version, state, parent_revision_id, content_hash,
            content_location, schema_version, source_ids, data_classification,
            tool_model_provenance, change_reason, created_by, created_by_type, created_at, review_ids
       FROM artifact_revision WHERE id = $1 AND project_id = $2 AND artifact_id = $3`,
    [revId, projectId, ctx.params.artifactId!],
  );
  if (rows.length === 0) throw notFoundError(`revision not found: ${revId}`);
  return { status: 200, data: rows[0] };
}

/**
 * GET /projects/:projectId/artifacts — list artifact containers in a project
 * (core:read). Returns the stable contract fields, ordered by created_at.
 */
export async function getArtifacts(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const { rows } = await ctx.pool.query(
    `SELECT id, artifact_type, created_at
       FROM artifact WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return { status: 200, data: rows };
}

/**
 * GET /projects/:projectId/artifacts/:artifactId/revisions — list revisions of
 * an artifact (core:read). Returns the stable contract fields (including the
 * artifact title) ordered by version descending. Empty list when the artifact
 * has no revisions.
 */
export async function getRevisions(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const artifactId = ctx.params.artifactId!;
  const { rows } = await ctx.pool.query(
    `SELECT ar.id, ar.version, ar.state, ar.content_hash, ar.content_location,
            a.title, ar.created_at
       FROM artifact_revision ar
       JOIN artifact a ON a.id = ar.artifact_id
      WHERE ar.project_id = $1 AND ar.artifact_id = $2
      ORDER BY ar.version DESC`,
    [projectId, artifactId],
  );
  return { status: 200, data: rows };
}

/**
 * GET /projects/:projectId/artifacts/:artifactId/revisions/:revId/content —
 * return a revision's content + its hash (core:read).
 *
 * 内容按 `content_location` 的 scheme 分派：`git://<sha>/<path>` 从项目工作区的
 * git 对象里取（读出来**复核 sha256**，对不上说明历史被改写/对象损坏，报 500 而不是
 * 悄悄返回坏内容）；其余（`db://…`）读 `content` 列。git 对象取不到时回落到 DB 里的
 * 归档副本——已批准修订进基线时会把正文冻回来，正是为这一刻准备的。
 *
 * 响应体 `{ content, content_hash }` 不变，前端读路径零改动。
 */
export async function getRevisionContent(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const artifactId = ctx.params.artifactId!;
  const revId = ctx.params.revId!;
  const { rows } = await ctx.pool.query(
    `SELECT content, content_hash, content_location FROM artifact_revision
      WHERE id = $1 AND project_id = $2 AND artifact_id = $3`,
    [revId, projectId, artifactId],
  );
  if (rows.length === 0) throw notFoundError(`revision not found: ${revId}`);
  const row = rows[0] as { content: string | null; content_hash: string; content_location: string };

  if (parseGitLocation(row.content_location)) {
    const fromGit = await readAtLocation(projectId, row.content_location);
    if (fromGit !== null) {
      const actual = sha256Hex(fromGit);
      if (actual !== row.content_hash) {
        throw new ApiError("internal", 500, "CONTENT_HASH_MISMATCH", false, {
          revisionId: revId,
          expected: row.content_hash,
          actual,
          contentLocation: row.content_location,
        });
      }
      return { status: 200, data: { content: fromGit, content_hash: row.content_hash } };
    }
    // git 里读不到：只有归档副本能救场，否则如实报缺内容。
    if (row.content === null) {
      throw notFoundError(`revision content unavailable in git and no archived copy: ${revId}`, {
        contentLocation: row.content_location,
      });
    }
  }

  if (row.content === null) throw notFoundError(`revision has no inline content: ${revId}`);
  return { status: 200, data: { content: row.content, content_hash: row.content_hash } };
}

// ─── 3. Snapshot / Gate ──────────────────────────────────────────────────────

export async function createSnapshotHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");
  const memberRevisionIds = optionalStringArray(body, "member_revision_ids");
  if (memberRevisionIds.length === 0) throw validationError("field 'member_revision_ids' must be a non-empty array");

  const { result } = await runIdempotent(ctx, "create_snapshot", projectId, async (tx) => {
    const project = await requireProjectProcessBinding(tx, projectId);
    const gateProfileVersion = resolveGateProfileVersion(body, frozenModernProcessProfile(project));

    // Resolve member content hashes from the committed revisions (freeze binding).
    const revResult = await tx.query(
      "SELECT id, content_hash FROM artifact_revision WHERE id = ANY($1::text[]) AND project_id = $2",
      [memberRevisionIds, projectId],
    );
    const revRows = revResult.rows as { id: string; content_hash: string }[];
    if (revRows.length !== memberRevisionIds.length) {
      throw validationError("one or more member_revision_ids not found in project", { memberRevisionIds });
    }
    const manifestHash = computeManifestHash(revRows.map((r) => ({ id: r.id, sha256: r.content_hash })));
    const traceRelationIds = optionalStringArray(body, "trace_relation_ids");

    const snapRow = {
      id,
      projectId,
      memberRevisionIds,
      traceRelationIds,
      gateProfileVersion,
      toolModelPolicyHash: requireString(body, "tool_model_policy_hash"),
      manifestHash,
      createdBy: ctx.identity.actorId,
      createdAt: new Date().toISOString(),
    };
    await createSnapshot(asClient(tx), snapRow);
    await outboxEvent(tx, ctx, { type: "configuration_snapshot", id }, "snapshot.created", { id, projectId, manifestHash, memberRevisionIds });
    return { id, projectId, manifestHash, memberRevisionIds };
  });

  return { status: 201, data: result };
}

export async function createGateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");
  const processInstanceId = requireString(body, "process_instance_id");
  const gate = requireEnum(requireString(body, "gate"), "gate", GATE_VALUES);
  const snapshotId = requireString(body, "snapshot_id");

  const { result } = await runIdempotent(ctx, "create_gate_submission", projectId, async (tx) => {
    const project = await requireProjectProcessBinding(tx, projectId);
    const frozenProfile = frozenModernProcessProfile(project);
    // Validate FK targets belong to this project (fail closed, 404/400).
    const pi = await tx.query(
      "SELECT gate_profile_version FROM process_instance WHERE id = $1 AND project_id = $2",
      [processInstanceId, projectId],
    );
    if (pi.rows.length === 0) throw notFoundError(`process_instance not found: ${processInstanceId}`);
    const snap = await tx.query(
      "SELECT gate_profile_version FROM configuration_snapshot WHERE id = $1 AND project_id = $2",
      [snapshotId, projectId],
    );
    if (snap.rows.length === 0) throw notFoundError(`snapshot not found: ${snapshotId}`);
    const processInstance = pi.rows[0] as { gate_profile_version: string };
    const snapshot = snap.rows[0] as { gate_profile_version: string };
    assertFrozenGateProfile(frozenProfile, processInstance.gate_profile_version, "process_instance");
    assertFrozenGateProfile(frozenProfile, snapshot.gate_profile_version, "configuration_snapshot");

    await createSubmission(asClient(tx), {
      id,
      projectId,
      processInstanceId,
      gate: gate as GateId,
      snapshotId,
      state: "preparing",
      submitterId: ctx.identity.actorId,
      checkResults: null,
      issues: [],
      createdAt: new Date().toISOString(),
      submittedAt: null,
    });
    await outboxEvent(tx, ctx, { type: "gate_submission", id }, "gate.submission_created", { id, projectId, processInstanceId, gate, snapshotId });
    return { id, projectId, processInstanceId, gate, snapshotId, state: "preparing" };
  });

  return { status: 201, data: result };
}

// ─── 3b. Gate submission lifecycle: submit / withdraw / get (SYNTHIA-FLOW-001) ─

/**
 * Fixed forward pipeline a gate_submission traverses from draft to human review
 * (ARC-002 §5.2): preparing → submitted → checking → in_review. `submit` drives
 * the submission atomically along this pipeline to `in_review`; the intermediate
 * `submitted`/`checking` states are the automated gate-check stages which this
 * endpoint completes synchronously (preparing → in_review is not a single legal
 * hop in the machine, so submit traverses the pipeline).
 */
const SUBMIT_PIPELINE: readonly GateSubmissionState[] = ["preparing", "submitted", "checking", "in_review"];

/** Column set returned for a gate_submission (stable contract). */
const SUBMISSION_SELECT_COLUMNS =
  "id, project_id, process_instance_id, gate, snapshot_id, state, submitter_id, check_results, issues, submitted_at, created_at";

/**
 * Lock + load a submission scoped to a project. Throws 404 when the submission
 * is absent OR belongs to a different project (fail-closed, no cross-project leak).
 */
async function requireSubmission(tx: TransactionClient, projectId: string, submissionId: string): Promise<GateSubmissionLock> {
  const lock = await lockGateSubmission(tx, submissionId);
  if (!lock || lock.projectId !== projectId) throw notFoundError(`gate_submission not found: ${submissionId}`);
  return lock;
}

/** Re-read the submission row (post-transition) for an accurate response body. */
async function selectSubmission(tx: TransactionClient, submissionId: string): Promise<Record<string, unknown>> {
  const { rows } = await tx.query(`SELECT ${SUBMISSION_SELECT_COLUMNS} FROM gate_submission WHERE id = $1`, [submissionId]);
  return rows[0] as Record<string, unknown>;
}

/**
 * POST /projects/:projectId/gate-submissions/:subId/submit — submit a gate for
 * human review. Drives the submission to `in_review` via the legal state-machine
 * pipeline and records `submitted_at`. Idempotent: re-submitting an already
 * `in_review` submission returns its current state (no transition, no event); a
 * submission already in a terminal state (approved/rejected/withdrawn) yields
 * 409 conflict.
 */
export async function submitGateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;

  const { result } = await runIdempotent(ctx, "submit_gate_submission", projectId, async (tx) => {
    await requireProject(tx, projectId);
    const lock = await requireSubmission(tx, projectId, submissionId);
    const current = lock.state as GateSubmissionState;

    const idx = SUBMIT_PIPELINE.indexOf(current);
    if (idx === -1) {
      // Terminal state (approved/rejected/withdrawn): a resolved gate cannot be (re-)submitted.
      throw conflictApiError("GATE_SUBMISSION_NOT_SUBMITTABLE", { state: current });
    }
    const driven = idx < SUBMIT_PIPELINE.length - 1; // false only when already in_review
    if (driven) {
      for (let i = idx + 1; i < SUBMIT_PIPELINE.length; i++) {
        await transitionSubmissionState(asClient(tx), submissionId, SUBMIT_PIPELINE[i]!);
      }
      await tx.query("UPDATE gate_submission SET submitted_at = now() WHERE id = $1", [submissionId]);
      await outboxEvent(tx, ctx, { type: "gate_submission", id: submissionId }, "gate_submission.submitted_for_review", { id: submissionId, projectId, state: "in_review" });
    }
    return selectSubmission(tx, submissionId);
  });

  return { status: 200, data: result };
}

/**
 * POST /projects/:projectId/gate-submissions/:subId/withdraw — withdraw a gate
 * submission. A single direct state-machine edge to `withdrawn`, legal from
 * preparing/submitted/in_review (not from checking or any terminal state).
 * Idempotent: withdrawing an already `withdrawn` submission returns its current
 * state; a submission in checking/approved/rejected yields 409 conflict.
 */
export async function withdrawGateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;

  const { result } = await runIdempotent(ctx, "withdraw_gate_submission", projectId, async (tx) => {
    await requireProject(tx, projectId);
    const lock = await requireSubmission(tx, projectId, submissionId);
    const current = lock.state as GateSubmissionState;

    if (current !== "withdrawn") {
      if (!gateSubmissionMachine.canTransition(current, "withdrawn")) {
        throw conflictApiError("GATE_SUBMISSION_NOT_WITHDRAWABLE", { state: current });
      }
      await transitionSubmissionState(asClient(tx), submissionId, "withdrawn");
      await outboxEvent(tx, ctx, { type: "gate_submission", id: submissionId }, "gate_submission.withdrawn", { id: submissionId, projectId, state: "withdrawn" });
    }
    return selectSubmission(tx, submissionId);
  });

  return { status: 200, data: result };
}

/**
 * GET /projects/:projectId/gate-submissions/:subId — return the submission's
 * current state for approval-result polling. `state` reflects approved/rejected
 * once the human approval service has run.
 */
export async function getGateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;
  const { rows } = await ctx.pool.query(
    `SELECT ${SUBMISSION_SELECT_COLUMNS} FROM gate_submission WHERE id = $1 AND project_id = $2`,
    [submissionId, projectId],
  );
  if (rows.length === 0) throw notFoundError(`gate_submission not found: ${submissionId}`);
  return { status: 200, data: rows[0] };
}

/**
 * GET /projects/:projectId/gate-submissions[?state=] — list gate submissions for
 * a project (core:read). Optional `state` query filters by submission state
 * (e.g. in_review); omitted returns all. Ordered by created_at. Returns the
 * stable contract fields (no check_results / issues payloads).
 */
export async function getGateSubmissions(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const state = ctx.url.searchParams.get("state");
  const { rows } = await ctx.pool.query(
    `SELECT id, gate, state, snapshot_id, process_instance_id, submitter_id, submitted_at, created_at
       FROM gate_submission
      WHERE project_id = $1 AND ($2::text IS NULL OR state::text = $2)
      ORDER BY created_at`,
    [projectId, state],
  );
  return { status: 200, data: rows };
}

// ─── 4. Approval / Baseline ──────────────────────────────────────────────────

export async function approveGateHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const gateSubmissionId = ctx.params.subId!;
  const body = asObject(ctx.body);

  // P4 human-exclusive: service identities cannot approve/revoke/waive.
  if (ctx.identity.actorType !== "human") {
    throw forbiddenError("APPROVAL_AUTHORIZATION_DENIED", { actorType: ctx.identity.actorType });
  }
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");

  const configurationSnapshotId = requireString(body, "configuration_snapshot_id");
  const approvedGateResultId = requireString(body, "approved_gate_result_id");
  const approverRole = optionalString(body, "approver_role", "quality");
  const checkResultsHash = requireString(body, "check_results_hash");
  const signedAt = requireString(body, "signed_at");
  const signatureMethod = optionalString(body, "signature_method", "platform_token");

  const input: ApproveGateSubmissionInput = {
    projectId,
    gateSubmissionId,
    configurationSnapshotId,
    approver: { actorType: "human", actorId: ctx.identity.actorId },
    approvalContent: {
      decision: "approve",
      approverRole,
      authorizationBasis: optionalString(body, "authorization_basis", "role-bound approval"),
      reason: optionalString(body, "reason", ""),
      issues: optionalStringArray(body, "issues"),
      risks: optionalStringArray(body, "risks"),
      waivers: optionalStringArray(body, "waivers"),
      checkResultsHash,
      signedAt,
      signatureMethod,
      clientAuditDigest: (body.client_audit_digest ?? null) as string | null,
    },
    approvedGateResultId,
    baselineId: (body.baseline_id ?? null) as string | null,
    idempotency: {
      actorType: "human",
      actorId: ctx.identity.actorId,
      projectId,
      operation: "approve_gate",
      key: ctx.idempotencyKey,
    },
    requestHash: canonicalRequestHash(ctx.body),
    correlationId: ctx.correlationId,
    causationId: null,
    classification: ctx.classification as ApproveGateSubmissionInput["classification"],
  };

  const conn = await ctx.pool.connect();
  let result: Awaited<ReturnType<typeof approveGateSubmission>>;
  try {
    result = await withTransaction(conn as unknown as TransactionClient, (tx) => approveGateSubmission(tx, input));
  } catch (err) {
    throw mapServiceError(err);
  } finally {
    conn.release();
  }

  // 事务外冻结：把进了基线的那版正文从 git 固化进 DB 作归档冗余。失败只记日志——
  // 归档是冗余，git 仍是权威，审批本身已经提交，不该因为一次文件 IO 而被判失败。
  if (result.baselineId) {
    try {
      const outcome = await freezeBaselineContent(ctx.pool, result.baselineId);
      // 只有「声称在 git 里却取不回来」才告警——老修订本来就没在 git 里，属正常。
      if (outcome.failed.length > 0) {
        console.warn("[synthia-api] baseline content freeze could not read git content:", result.baselineId, outcome.failed);
      }
    } catch (err) {
      console.error("[synthia-api] baseline content freeze failed:", result.baselineId, err);
    }
  }
  return { status: 200, data: result };
}

/**
 * POST /projects/:projectId/gate-submissions/:subId/reject — reject a gate
 * submission (human + project role + core:approve). Mirrors approve's
 * authorization path: a natural human with an active project role assignment may
 * reject; service identities and role-less humans are denied (403). Only a
 * submission in `in_review` may be rejected (anything else → 409). The reason is
 * required and is carried in the gate_submission.rejected outbox event. Idempotent.
 */
export async function rejectGateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;
  const body = asObject(ctx.body);
  const reason = requireString(body, "reason");
  const approverRole = optionalString(body, "approver_role", "quality");

  // P4 human-exclusive (same gate as approve): service identities cannot reject.
  if (ctx.identity.actorType !== "human") {
    throw forbiddenError("APPROVAL_AUTHORIZATION_DENIED", { actorType: ctx.identity.actorType });
  }

  const { result } = await runIdempotent(ctx, "reject_gate_submission", projectId, async (tx) => {
    await requireProject(tx, projectId);
    const lock = await requireSubmission(tx, projectId, submissionId);

    // Reuse approve's authorization: an active project role assignment is required.
    const role = await findRoleAssignment(tx, projectId, "human", ctx.identity.actorId, approverRole);
    if (!role) {
      throw forbiddenError("APPROVAL_AUTHORIZATION_DENIED", { actorType: ctx.identity.actorType });
    }

    const current = lock.state as GateSubmissionState;
    if (current !== "in_review") {
      throw conflictApiError("GATE_SUBMISSION_NOT_REJECTABLE", { state: current });
    }
    await transitionSubmissionState(asClient(tx), submissionId, "rejected");
    await outboxEvent(tx, ctx, { type: "gate_submission", id: submissionId }, "gate_submission.rejected", {
      id: submissionId,
      projectId,
      state: "rejected",
      reason,
      approver: ctx.identity.actorId,
    });
    return selectSubmission(tx, submissionId);
  });

  return { status: 200, data: result };
}

export async function getBaselines(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const { rows } = await ctx.pool.query(
    `SELECT id, project_id, kind, state, approved_gate_result_id, member_revision_ids,
            trace_relation_ids, manifest_hash, approval_record_id, created_at, superseded_by_baseline_id
       FROM baseline WHERE project_id = $1 ORDER BY kind, created_at`,
    [projectId],
  );
  return { status: 200, data: rows };
}

// ─── 5. Trace ────────────────────────────────────────────────────────────────

export async function createTraceRelationHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const id = requireString(body, "id");

  const { result } = await runIdempotent(ctx, "create_trace_relation", projectId, async (tx) => {
    await requireProject(tx, projectId);
    await createTraceRelation(asClient(tx), {
      id,
      projectId,
      sourceType: requireString(body, "source_type"),
      sourceId: requireString(body, "source_id"),
      targetType: requireString(body, "target_type"),
      targetId: requireString(body, "target_id"),
      relationKind: requireString(body, "relation_kind"),
      state: requireEnum(optionalString(body, "state", "candidate"), "state", TRACE_STATE_VALUES) as TraceRelationState,
      basis: optionalString(body, "basis", ""),
      dataClassification: requireEnum(optionalString(body, "data_classification", "D1"), "data_classification", CLASSIFICATION_VALUES) as DataClassification,
      createdBy: ctx.identity.actorId,
      createdAt: new Date().toISOString(),
    });
    await outboxEvent(tx, ctx, { type: "trace_relation", id }, "trace.created", { id, projectId, sourceId: body.source_id, targetId: body.target_id });
    return { id, projectId };
  });

  return { status: 201, data: result };
}

export async function getTraceRelations(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const source = ctx.url.searchParams.get("source");
  const target = ctx.url.searchParams.get("target");
  if (source && target) throw validationError("specify either 'source' (forward) or 'target' (reverse), not both");
  const client = await ctx.pool.connect();
  try {
    let rows: unknown[];
    if (source) {
      ({ rows } = await client.query(
        `SELECT * FROM trace_relation WHERE project_id = $1 AND source_id = $2 ORDER BY created_at`,
        [projectId, source],
      ));
    } else if (target) {
      ({ rows } = await client.query(
        `SELECT * FROM trace_relation WHERE project_id = $1 AND target_id = $2 ORDER BY created_at`,
        [projectId, target],
      ));
    } else {
      throw validationError("query parameter 'source' or 'target' is required");
    }
    return { status: 200, data: rows };
  } finally {
    client.release();
  }
}

// ─── 6. Events (read outbox) ─────────────────────────────────────────────────

export async function getEvents(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const aggregateType = ctx.url.searchParams.get("aggregate_type");
  const aggregateId = ctx.url.searchParams.get("aggregate_id");
  const afterSequenceRaw = ctx.url.searchParams.get("after_sequence");
  let afterSequence: number | null = null;
  if (afterSequenceRaw !== null) {
    afterSequence = Number(afterSequenceRaw);
    if (!Number.isInteger(afterSequence)) throw validationError("after_sequence must be an integer");
  }
  const { rows } = await ctx.pool.query(
    `SELECT event_id, aggregate_type, aggregate_id, sequence::int AS sequence, event_type, payload,
            correlation_id, classification, occurred_at
       FROM outbox_events
      WHERE project_id = $1
        AND ($2::text IS NULL OR aggregate_type = $2)
        AND ($3::text IS NULL OR aggregate_id = $3)
        AND ($4::bigint IS NULL OR sequence > $4)
      ORDER BY aggregate_type, aggregate_id, sequence`,
    [projectId, aggregateType, aggregateId, afterSequence],
  );
  return { status: 200, data: rows };
}

// ─── 7. Run / Job (IF-002 Connector slice) ──────────────────────────────────

/** Operations Core proxies to the Connector (matches the 66 worker capabilities). */
const JOB_OPERATION_VALUES: Record<string, true> = {
  validate_sources: true,
  simulate: true,
  synthesize: true,
  implement: true,
};
const RUN_CLASS_INTENT_VALUES: Record<string, true> = {
  exploratory: true,
  gate_check: true,
  formal: true,
};
/** gate_submission states that count as "frozen / in_review" for a gate_check run.
 *  The DB enum has no literal 'frozen'; a submission is frozen once it leaves the
 *  'preparing' draft state and has not been withdrawn. */
const GATE_CHECK_FROZEN_STATES: Record<string, true> = {
  submitted: true,
  checking: true,
  in_review: true,
};
/** ToolRun states with no outgoing transition — evidence is only available once terminal. */
const TOOL_RUN_TERMINAL_STATES: Record<string, true> = {
  succeeded: true,
  failed: true,
  cancelled: true,
  timeout: true,
  lost: true,
  unknown_effect: true,
  rejected: true,
};

/** String field that may be absent (→ null) but must be a string when present. */
function nullableString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw validationError(`field '${key}' must be a string`);
  return v;
}

/** Optional positive numeric field. */
function optionalPositiveNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw validationError(`field '${key}' must be a positive number`);
  }
  return v;
}

/** Validate a `sources`/`constraints` array: each member has a non-empty path,
 *  string content, and optional string mediaType. Absent → empty array. */
function validateSourceList(obj: Record<string, unknown>, key: string): SourceInput[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw validationError(`field '${key}' must be an array`);
  const out: SourceInput[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw validationError(`field '${key}[${i}]' must be an object`);
    }
    const o = item as Record<string, unknown>;
    const path = o.path;
    if (typeof path !== "string" || path.length === 0) {
      throw validationError(`field '${key}[${i}].path' must be a non-empty string`);
    }
    const content = o.content;
    if (typeof content !== "string") {
      throw validationError(`field '${key}[${i}].content' must be a string`);
    }
    const entry: SourceInput = { path, content };
    const mediaType = o.mediaType;
    if (mediaType !== undefined && mediaType !== null) {
      if (typeof mediaType !== "string") throw validationError(`field '${key}[${i}].mediaType' must be a string`);
      entry.mediaType = mediaType;
    }
    out.push(entry);
  }
  return out;
}

/** Resolve the Connector port or fail closed (503) when none is configured. */
function requireConnector(ctx: RequestContext): ConnectorPort {
  if (!ctx.connector) throw capabilityUnavailableError("connector not configured");
  return ctx.connector;
}

/** Map a Connector failure to a stable API error: drift/lease/capability → 503,
 *  not-found/evidence-missing → 404, anything else → 503 (retryable). */
function mapConnectorError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ConnectorError) {
    if (err.code in CONNECTOR_NOT_FOUND_CODES) return notFoundError(`connector: ${err.code}`);
    return capabilityUnavailableError(`connector: ${err.code}`, { code: err.code });
  }
  return internalError(err instanceof Error ? err.message : "connector error");
}

/**
 * Adjudicate the run_class for a Job submission. The caller states an *intent*
 * (`run_class_intent`, default exploratory); the server grants it only when the
 * matching authorization context is present and valid — otherwise 403. This is
 * fail-closed: an escalation request the caller cannot back is rejected, never
 * silently downgraded. (SYNTHIA-IF-002 run_class adjudication.)
 *
 *   - exploratory: always granted.
 *   - gate_check:  requires `gate_submission_id` referring to a frozen/in_review
 *                  submission within the project.
 *   - formal:      requires `approved_gate_result_id` or `baseline_id` referring
 *                  to an existing governed artifact within the project.
 */
async function adjudicateRunClass(tx: TransactionClient, projectId: string, body: Record<string, unknown>): Promise<RunClass> {
  const intent = requireEnum(optionalString(body, "run_class_intent", "exploratory"), "run_class_intent", RUN_CLASS_INTENT_VALUES) as RunClass;
  if (intent === "exploratory") return "exploratory";

  if (intent === "gate_check") {
    const gateSubmissionId = nullableString(body, "gate_submission_id");
    if (!gateSubmissionId) throw forbiddenError("RUN_CLASS_GATE_CHECK_REQUIRES_SUBMISSION");
    const { rows } = await tx.query("SELECT state FROM gate_submission WHERE id = $1 AND project_id = $2", [gateSubmissionId, projectId]);
    if (rows.length === 0) throw forbiddenError("RUN_CLASS_GATE_CHECK_SUBMISSION_NOT_FOUND");
    const state = String((rows[0] as Record<string, unknown>).state);
    if (!(state in GATE_CHECK_FROZEN_STATES)) throw forbiddenError("RUN_CLASS_GATE_CHECK_SUBMISSION_NOT_FROZEN");
    return "gate_check";
  }

  // intent === "formal"
  const approvedGateResultId = nullableString(body, "approved_gate_result_id");
  const baselineId = nullableString(body, "baseline_id");
  if (!approvedGateResultId && !baselineId) throw forbiddenError("RUN_CLASS_FORMAL_REQUIRES_APPROVAL");
  if (approvedGateResultId) {
    const { rows } = await tx.query("SELECT 1 FROM approved_gate_result WHERE id = $1 AND project_id = $2", [approvedGateResultId, projectId]);
    if (rows.length === 0) throw forbiddenError("RUN_CLASS_FORMAL_APPROVED_GATE_RESULT_NOT_FOUND");
  }
  if (baselineId) {
    const { rows } = await tx.query("SELECT 1 FROM baseline WHERE id = $1 AND project_id = $2", [baselineId, projectId]);
    if (rows.length === 0) throw forbiddenError("RUN_CLASS_FORMAL_BASELINE_NOT_FOUND");
  }
  return "formal";
}

/** Build the persisted authorization_context from provided context fields. */
function buildAuthorizationContext(body: Record<string, unknown>): Record<string, string> {
  const ctx: Record<string, string> = {};
  const gateSubmissionId = nullableString(body, "gate_submission_id");
  if (gateSubmissionId) ctx.gateSubmissionId = gateSubmissionId;
  const approvedGateResultId = nullableString(body, "approved_gate_result_id");
  if (approvedGateResultId) ctx.approvedGateResultId = approvedGateResultId;
  const baselineId = nullableString(body, "baseline_id");
  if (baselineId) ctx.baselineId = baselineId;
  return ctx;
}

/**
 * POST /projects/:projectId/jobs — submit a Job through Core to the Connector.
 *
 * Creates a `tool_run` in state `submitted`, appends a `tool_run.submitted`
 * outbox event, and submits to the Connector — all inside one idempotent
 * transaction. A Connector drift/lease/capability rejection rolls the whole
 * thing back (no row, no event, idempotency slot released) and surfaces as 503.
 * Idempotent replay returns the original `jobId` without re-contacting the
 * Connector. (SYNTHIA-IF-002 §jobs.)
 */
export async function submitJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  const operation = requireEnum(requireString(body, "operation"), "operation", JOB_OPERATION_VALUES);
  const sources = validateSourceList(body, "sources");
  const constraints = validateSourceList(body, "constraints");
  const top = nullableString(body, "top");
  const testbench = nullableString(body, "testbench");
  const part = nullableString(body, "part");
  const timeoutMs = optionalPositiveNumber(body, "timeout_ms");
  const connector = requireConnector(ctx);

  const { result } = await runIdempotent(ctx, "submit_job", projectId, async (tx) => {
    await requireProject(tx, projectId);
    const runClass = await adjudicateRunClass(tx, projectId, body);
    const jobId = `job-${randomUUID()}`;
    const inputManifestHash = canonicalRequestHash(ctx.body);
    const parameters = { operation, jobId, projectId, runClass, sources, top, testbench, part, constraints, timeoutMs };
    const authorizationContext = buildAuthorizationContext(body);

    await tx.query(
      `INSERT INTO tool_run (id, project_id, operation, capability_version, run_class, state,
                              input_manifest_hash, authorization_context, parameters, connector_id, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
      [
        jobId, projectId, operation, "v1", runClass, "submitted", inputManifestHash,
        JSON.stringify(authorizationContext), JSON.stringify(parameters), connector.connectorId, ctx.correlationId,
      ],
    );
    await outboxEvent(tx, ctx, { type: "tool_run", id: jobId }, "tool_run.submitted", {
      jobId, projectId, operation, runClass, state: "submitted",
    });

    // Submit to the Connector inside the transaction: a rejection rolls back the
    // row + event + idempotency slot so the caller can retry with the same key.
    // `approval` carries the authorization context the remote client needs for
    // gate_check/formal runs; exploratory omits it.
    try {
      await connector.submitJob({
        jobId,
        projectId,
        operation,
        runClass,
        idempotencyKey: ctx.idempotencyKey!,
        correlationId: ctx.correlationId,
        actor: { actorType: ctx.identity.actorType, actorId: ctx.identity.actorId },
        parameters: { sources, top: top ?? undefined, testbench: testbench ?? undefined, part: part ?? undefined, constraints, timeoutMs },
        approval: Object.keys(authorizationContext).length > 0 ? authorizationContext : undefined,
      });
    } catch (err) {
      throw mapConnectorError(err);
    }
    return { jobId, runClass, state: "submitted" };
  });

  return { status: 201, data: result };
}

/**
 * GET /projects/:projectId/jobs[?limit=n] — list a project's tool runs
 * (core:read), newest first, for the UI run-history view.
 *
 * Pure database read: unlike GET /jobs/:jobId it does NOT refresh each row
 * from the Connector (that would fan out one Connector call per run); live
 * per-run state stays on the status endpoint. Rows are ordered by effective
 * start descending — `start_time` when one was recorded, else `created_at`
 * (POST /jobs rows are created with a NULL start_time) — with the id as a
 * deterministic tiebreaker. `limit` defaults to 100 and must be a positive
 * integer. A missing project → 404.
 */
export async function listJobsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;

  const limitRaw = ctx.url.searchParams.get("limit");
  let limit = 100;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) throw validationError("limit must be a positive integer");
  }

  const projectRow = await ctx.pool.query("SELECT 1 FROM project WHERE id = $1", [projectId]);
  if (projectRow.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);

  const { rows } = await ctx.pool.query(
    `SELECT id, operation, run_class, state, error_code, start_time, end_time
       FROM tool_run
      WHERE project_id = $1
      ORDER BY COALESCE(start_time, created_at) DESC, id
      LIMIT $2`,
    [projectId, limit],
  );

  const data = rows.map((row: Record<string, unknown>) => {
    const item: Record<string, unknown> = {
      id: row.id,
      operation: row.operation,
      runClass: row.run_class,
      state: row.state,
      startTime: row.start_time,
      endTime: row.end_time,
    };
    if (row.error_code !== null && row.error_code !== undefined) item.errorCode = row.error_code;
    return item;
  });
  return { status: 200, data };
}

/**
 * GET /projects/:projectId/jobs/:jobId — poll a Job's execution state.
 *
 * Core must already know the jobId (it minted it on submit); otherwise 404. The
 * Connector is queried for the live state and the row is updated (state /
 * error_code / output_sha256; end_time stamped on first terminal observation).
 * The Connector is the authority for execution state, so the update is direct.
 */
export async function getJobStatusHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const jobId = ctx.params.jobId!;
  const connector = requireConnector(ctx);

  const found = await ctx.pool.query("SELECT 1 FROM tool_run WHERE id = $1 AND project_id = $2", [jobId, projectId]);
  if (found.rows.length === 0) throw notFoundError(`job not found: ${jobId}`);

  let snapshot;
  try {
    snapshot = await connector.queryStatus(projectId, jobId);
  } catch (err) {
    throw mapConnectorError(err);
  }

  const terminal = snapshot.state in TOOL_RUN_TERMINAL_STATES;
  await ctx.pool.query(
    `UPDATE tool_run
        SET state = $1, error_code = $2, output_sha256 = $3,
            end_time = CASE WHEN $4::boolean AND end_time IS NULL THEN now() ELSE end_time END
      WHERE id = $5 AND project_id = $6`,
    [snapshot.state, snapshot.errorCode ?? null, snapshot.outputSha256 ?? null, terminal, jobId, projectId],
  );

  const data: Record<string, unknown> = { jobId, state: snapshot.state };
  if (snapshot.errorCode !== undefined) data.errorCode = snapshot.errorCode;
  if (snapshot.outputSha256 !== undefined) data.outputSha256 = snapshot.outputSha256;
  return { status: 200, data };
}

/**
 * GET /projects/:projectId/jobs/:jobId/evidence — fetch the frozen evidence
 * manifest for a terminal Job.
 *
 * Non-terminal: Core first refreshes status once; if still non-terminal → 404.
 * Terminal: the Connector manifest is fetched, frozen onto `tool_run.evidence`
 * (migration 0004), and returned. Connector "no evidence" → 404 not_found.
 */
export async function getJobEvidenceHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const jobId = ctx.params.jobId!;
  const connector = requireConnector(ctx);

  const found = await ctx.pool.query("SELECT state FROM tool_run WHERE id = $1 AND project_id = $2", [jobId, projectId]);
  if (found.rows.length === 0) throw notFoundError(`job not found: ${jobId}`);
  let state = String((found.rows[0] as Record<string, unknown>).state);

  // Non-terminal: refresh status once before deciding evidence availability.
  if (!(state in TOOL_RUN_TERMINAL_STATES)) {
    let snapshot;
    try {
      snapshot = await connector.queryStatus(projectId, jobId);
    } catch (err) {
      throw mapConnectorError(err);
    }
    state = snapshot.state;
    const terminal = state in TOOL_RUN_TERMINAL_STATES;
    await ctx.pool.query(
      `UPDATE tool_run
          SET state = $1, error_code = $2, output_sha256 = $3,
              end_time = CASE WHEN $4::boolean AND end_time IS NULL THEN now() ELSE end_time END
        WHERE id = $5 AND project_id = $6`,
      [state, snapshot.errorCode ?? null, snapshot.outputSha256 ?? null, terminal, jobId, projectId],
    );
    if (!terminal) throw notFoundError("evidence not available: job not terminal");
  }

  let manifest;
  try {
    manifest = await connector.fetchEvidence(projectId, jobId);
  } catch (err) {
    throw mapConnectorError(err);
  }

  // Freeze the manifest on the row (terminal-only persistence, migration 0004).
  await ctx.pool.query(
    "UPDATE tool_run SET evidence = $1::jsonb WHERE id = $2 AND project_id = $3",
    [JSON.stringify({ jobId: manifest.jobId, entries: manifest.entries }), jobId, projectId],
  );

  return { status: 200, data: { jobId, entries: manifest.entries } };
}

/**
 * GET /projects/:projectId/jobs/:jobId/evidence/content?name=<name> — fetch the
 * decoded content of a single evidence artifact for a terminal Job.
 *
 * Mirrors the evidence-manifest handler's terminal precondition: non-terminal
 * jobs get one status refresh, still non-terminal → 404. Ownership is verified
 * by the `tool_run` row's `project_id`. The Connector is the authority for the
 * content; Connector EVIDENCE_NOT_AVAILABLE / EVIDENCE_CORRUPT → 404. A missing
 * `name` query parameter → 400 validation.
 */
export async function getJobEvidenceContentHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const jobId = ctx.params.jobId!;
  const connector = requireConnector(ctx);

  const name = ctx.url.searchParams.get("name");
  if (!name) throw validationError("query parameter 'name' is required");

  const found = await ctx.pool.query("SELECT state FROM tool_run WHERE id = $1 AND project_id = $2", [jobId, projectId]);
  if (found.rows.length === 0) throw notFoundError(`job not found: ${jobId}`);
  let state = String((found.rows[0] as Record<string, unknown>).state);

  // Non-terminal: refresh status once before deciding content availability.
  if (!(state in TOOL_RUN_TERMINAL_STATES)) {
    let snapshot;
    try {
      snapshot = await connector.queryStatus(projectId, jobId);
    } catch (err) {
      throw mapConnectorError(err);
    }
    state = snapshot.state;
    const terminal = state in TOOL_RUN_TERMINAL_STATES;
    await ctx.pool.query(
      `UPDATE tool_run
          SET state = $1, error_code = $2, output_sha256 = $3,
              end_time = CASE WHEN $4::boolean AND end_time IS NULL THEN now() ELSE end_time END
        WHERE id = $5 AND project_id = $6`,
      [state, snapshot.errorCode ?? null, snapshot.outputSha256 ?? null, terminal, jobId, projectId],
    );
    if (!terminal) throw notFoundError("evidence content not available: job not terminal");
  }

  let content;
  try {
    content = await connector.fetchEvidenceContent(projectId, jobId, name);
  } catch (err) {
    throw mapConnectorError(err);
  }

  return {
    status: 200,
    data: {
      name: content.name,
      content: content.content,
      sha256: content.sha256,
      truncated: content.truncated,
      mediaType: content.mediaType,
    },
  };
}
