/**
 * P4 formal-flow API.
 *
 * This module deliberately owns the GJB_REF_V1 write path. Legacy/free flows
 * remain in handlers.ts and are selected by router dispatch; a modern project
 * never falls back to the legacy submit/approve semantics.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TransactionClient } from "../db/repository.ts";
import { appendOutboxEventInTx, withTransaction } from "../db/repository.ts";
import { canonicalRequestHash, hashPayload, sha256Hex, stableStringify } from "../hashing.ts";
import {
  FORMAL_OPERATIONS,
  P4ValidationError,
  buildFormalInputManifest,
  buildFormalPreview,
  engineeringConfigFacts,
  evidenceKind,
  evidenceManifestHash,
  evidenceRole,
  evidenceVerdicts,
  expectedClockNames,
  formalPath,
  formalRoleForArtifactType,
  hasXdcConstraintFact,
  inlineJsonItem,
  parseEngineeringConfig,
  validateFormalInputContent,
  validateEvidenceName,
  type EngineeringConfigV1,
  type FormalInputFileV1,
  type FormalInputManifestV1,
  type FormalOperation,
  type FrozenEvidenceCandidate,
  type XdcConstraintKind,
} from "../services/p4-formal-flow.ts";
import {
  evaluateP4GateEvidence,
  type FrozenGateTrace,
  type ManagedGateRevision,
  type P4GateEvidenceEvaluation,
  type P4RequirementAuthority,
  type P4StructuredGateId,
} from "../services/p4-gate-evidence.ts";
import {
  GJB_REF_V1_PROFILE,
  isP4Gate,
  nextP4Gate,
  type P4GateId,
} from "../services/process-profile.ts";
import { collectWorkspaceFacts } from "../services/workspace-facts.ts";
import { validateWorkspacePath } from "../workspace/paths.ts";
import {
  readRegularFileAtLocation,
} from "../workspace/store.ts";
import {
  CAPABILITY_UNAVAILABLE_CODES,
  CONNECTOR_NOT_FOUND_CODES,
  ConnectorError,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
  type ConnectorPort,
  type SourceInput,
} from "./connector-port.ts";
import {
  ApiError,
  capabilityUnavailableError,
  conflictApiError,
  forbiddenError,
  internalError,
  notFoundError,
  validationError,
} from "./errors.ts";
import {
  asObject,
  optionalString,
  optionalStringArray,
  outboxEvent,
  requireString,
  runIdempotent,
  runIdempotentInTransaction,
  type HandlerResult,
  type RequestContext,
} from "./handlers.ts";
import {
  acquireP4ProjectMutationSessionLock,
  acquireP4ProjectMutationTransactionLock,
  releaseP4ProjectMutationSessionLock,
  type P4ProjectMutationLockOwner,
} from "./p4-write-guard.ts";

type QueryClient = Pick<Pool, "query"> | TransactionClient;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTIVE_SUBMISSION_STATES = ["preparing", "submitted", "checking", "in_review"] as const;
const TERMINAL_RUN_STATES = new Set(["rejected", "succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"]);

async function runP4SessionLockedIdempotent<T>(
  ctx: RequestContext,
  projectId: string,
  owner: P4ProjectMutationLockOwner,
  operation: string,
  work: (tx: TransactionClient) => Promise<T>,
  authorize?: (tx: TransactionClient) => Promise<void>,
): Promise<{ result: T; replayed: boolean }> {
  const connection = await ctx.pool.connect();
  let locked = false;
  try {
    await acquireP4ProjectMutationSessionLock(connection, projectId, owner);
    locked = true;
    return await withTransaction(
      connection as unknown as TransactionClient,
      (tx) => runIdempotentInTransaction(
        ctx,
        tx,
        operation,
        projectId,
        work,
        authorize,
      ),
    );
  } finally {
    if (locked) {
      await releaseP4ProjectMutationSessionLock(connection, projectId)
        .catch(() => undefined);
    }
    connection.release();
  }
}

interface ModernProjectRow {
  readonly id: string;
  readonly project_type: string;
  readonly process_version_id: string | null;
  readonly process_profile_id: string | null;
  readonly process_profile_version: string | null;
  readonly target_part: string | null;
  readonly toolchain_profile_ref: string | null;
  readonly data_classification: string;
}

interface WorkVersionRow {
  readonly id: string;
  readonly project_id: string;
  readonly process_instance_id: string;
  readonly version: number;
  readonly origin: "initial" | "change_request";
  readonly change_request_id: string | null;
  readonly base_delivery_release_id: string | null;
  readonly start_gate: P4GateId;
  readonly current_gate: P4GateId;
  readonly state: "working" | "in_review" | "released" | "abandoned";
  readonly created_at: Date | string;
  readonly released_at: Date | string | null;
}

function assertFeature(ctx: RequestContext): void {
  if (ctx.featureFlags?.formalDelivery !== true) {
    throw capabilityUnavailableError("FORMAL_DELIVERY_DISABLED", {
      feature: "SYNTHIA_FEATURE_FORMAL_DELIVERY",
    });
  }
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw validationError(`field '${field}' must be a safe non-empty id`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw validationError(`field '${field}' must be a lowercase SHA-256 digest`);
  }
  return value;
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw validationError("request contains unsupported fields", { fields: unexpected.sort() });
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function numberValue(value: unknown): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw internalError("P4_NUMERIC_VALUE_INVALID");
  return converted;
}

async function projectRow(query: QueryClient, projectId: string): Promise<ModernProjectRow> {
  const { rows } = await query.query(
    `SELECT id, project_type, process_version_id, process_profile_id,
            process_profile_version, target_part, toolchain_profile_ref,
            data_classification::text
       FROM project WHERE id = $1`,
    [projectId],
  );
  const row = rows[0] as ModernProjectRow | undefined;
  if (!row) throw notFoundError(`project not found: ${projectId}`);
  return row;
}

export async function isModernP4Project(pool: Pool, projectId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT project_type, process_version_id, process_profile_id FROM project WHERE id = $1",
    [projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row?.project_type === "engineering"
    && row.process_version_id === "GJB_REF_V1"
    && row.process_profile_id === "GJB_REF_V1";
}

async function requireModernProject(query: QueryClient, projectId: string): Promise<ModernProjectRow> {
  const project = await projectRow(query, projectId);
  if (
    project.project_type !== "engineering"
    || project.process_version_id !== "GJB_REF_V1"
    || project.process_profile_id !== "GJB_REF_V1"
    || project.process_profile_version !== "GJB_REF_V1"
  ) {
    throw conflictApiError("P4_PROJECT_REQUIRED", {
      projectType: project.project_type,
      processVersionId: project.process_version_id,
    });
  }
  return project;
}

async function requireHumanProjectRole(
  query: QueryClient,
  ctx: RequestContext,
  requestedRole?: string,
): Promise<string> {
  if (ctx.identity.actorType !== "human") {
    throw forbiddenError("P4_HUMAN_CONFIRMATION_REQUIRED", { actorType: ctx.identity.actorType });
  }
  const values: unknown[] = [ctx.params.projectId!, ctx.identity.actorId];
  let sql = `SELECT role FROM role_assignment
              WHERE project_id = $1 AND actor_type = 'human' AND actor_id = $2`;
  if (requestedRole) {
    values.push(requestedRole);
    sql += " AND role = $3";
  }
  sql += " ORDER BY assigned_at, id LIMIT 1";
  const { rows } = await query.query(sql, values);
  const role = (rows[0] as { role?: string } | undefined)?.role;
  if (!role) throw forbiddenError("P4_PROJECT_ROLE_REQUIRED");
  return role;
}

async function activeWorkVersion(
  query: QueryClient,
  projectId: string,
  lock = false,
): Promise<WorkVersionRow | null> {
  const { rows } = await query.query(
    `SELECT id, project_id, process_instance_id, version, origin,
            change_request_id, base_delivery_release_id,
            start_gate::text, current_gate::text, state, created_at, released_at
       FROM project_work_version
      WHERE project_id = $1 AND state IN ('working','in_review')
      ORDER BY version DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [projectId],
  );
  return rows[0] as WorkVersionRow | undefined ?? null;
}

async function acquireG4ProjectMutationLockForSubmission(
  tx: TransactionClient,
  projectId: string,
  submissionId: string,
  owner: "g4.evaluate" | "g4.submit" | "g4.approve",
): Promise<boolean> {
  const result = await tx.query(
    `SELECT gate::text AS gate
       FROM gate_submission
      WHERE id = $1 AND project_id = $2`,
    [submissionId, projectId],
  );
  if ((result.rows[0] as { gate?: string } | undefined)?.gate !== "G4") {
    return false;
  }
  await acquireP4ProjectMutationTransactionLock(tx, projectId, owner);
  return true;
}

async function latestWorkVersion(query: QueryClient, projectId: string): Promise<WorkVersionRow | null> {
  const { rows } = await query.query(
    `SELECT id, project_id, process_instance_id, version, origin,
            change_request_id, base_delivery_release_id,
            start_gate::text, current_gate::text, state, created_at, released_at
       FROM project_work_version WHERE project_id = $1
      ORDER BY version DESC LIMIT 1`,
    [projectId],
  );
  return rows[0] as WorkVersionRow | undefined ?? null;
}

async function ensureInitialWorkVersion(
  tx: TransactionClient,
  ctx: RequestContext,
  requestedId: string,
): Promise<WorkVersionRow> {
  const current = await activeWorkVersion(tx, ctx.params.projectId!, true);
  if (current) {
    if (current.id !== requestedId) {
      throw conflictApiError("WORK_VERSION_MISMATCH", { expected: current.id, received: requestedId });
    }
    return current;
  }
  const latest = await latestWorkVersion(tx, ctx.params.projectId!);
  if (latest) throw conflictApiError("CHANGE_REQUEST_REQUIRED", { latestWorkVersionId: latest.id });
  throw conflictApiError("P4_WORK_VERSION_REQUIRED");
}

function mapP4Error(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof P4ValidationError) return validationError(error.message, error.details);
  if (error instanceof ConnectorError) {
    if (error.code in CAPABILITY_UNAVAILABLE_CODES) {
      return capabilityUnavailableError(error.code, null);
    }
    if (error.code in CONNECTOR_NOT_FOUND_CODES) return notFoundError(error.code);
    return conflictApiError(error.code, null, error.retryable);
  }
  return internalError("P4_OPERATION_FAILED");
}

export function validateP4EvidenceManifestLimits(
  entries: readonly { readonly name: string; readonly sizeBytes: number }[],
): number {
  if (entries.length > MAX_EVIDENCE_ENTRIES) {
    throw conflictApiError("EVIDENCE_LIMIT_EXCEEDED");
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_EVIDENCE_ENTRY_BYTES) {
      throw conflictApiError("EVIDENCE_LIMIT_EXCEEDED", { name: entry.name });
    }
    totalBytes += entry.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
      throw conflictApiError("EVIDENCE_LIMIT_EXCEEDED");
    }
  }
  return totalBytes;
}

function requireConnector(ctx: RequestContext): ConnectorPort {
  if (!ctx.connector) throw capabilityUnavailableError("CONNECTOR_NOT_CONFIGURED");
  return ctx.connector;
}

async function appendP4Outbox(
  tx: TransactionClient,
  ctx: RequestContext,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: unknown,
): Promise<number> {
  return appendOutboxEventInTx(tx, {
    eventId: randomUUID(),
    aggregateType,
    aggregateId,
    eventType,
    projectId: ctx.params.projectId!,
    payload,
    correlationId: ctx.correlationId,
    causationId: null,
    classification: ctx.classification,
  });
}

async function recordEvidenceDivergence(
  ctx: RequestContext,
  jobId: string,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  // The evidence-freeze transaction must roll back on divergence, but the
  // rejected attempt is itself an audit fact. Persist it on a separate short
  // transaction so rollback cannot erase the security signal. Failure to
  // write the audit event is logged without replacing the original 409.
  const conn = await ctx.pool.connect();
  try {
    await conn.query("BEGIN");
    await appendP4Outbox(
      conn as unknown as TransactionClient,
      ctx,
      "tool_run",
      jobId,
      "tool_run.evidence_rejected",
      {
        jobId,
        projectId: ctx.params.projectId!,
        reason,
        details,
        attemptedBy: {
          type: ctx.identity.actorType,
          id: ctx.identity.actorId,
        },
      },
    );
    await conn.query("COMMIT");
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => undefined);
    console.error("[synthia-api] evidence divergence audit failed", {
      projectId: ctx.params.projectId!,
      jobId,
      reason,
      error,
    });
  } finally {
    conn.release();
  }
}

// ─── Profile and process state ───────────────────────────────────────────────

export async function getP4ProcessProfileHandler(ctx: RequestContext): Promise<HandlerResult> {
  const id = ctx.params.processVersionId ?? ctx.params.id;
  if (id !== "GJB_REF_V1") throw notFoundError(`process profile not found: ${id ?? ""}`);
  const { rows } = await ctx.pool.query(
    `SELECT gate::text, ordinal, name, goal, activities, required_checks,
            milestone_baseline::text, profile_hash
       FROM process_gate_definition
      WHERE process_version_id = $1
      ORDER BY ordinal`,
    [id],
  );
  const definitions = rows as Array<{
    gate: string;
    ordinal: number;
    name: string;
    goal: string;
    activities: unknown;
    required_checks: unknown;
    milestone_baseline: string | null;
    profile_hash: string;
  }>;
  if (
    definitions.length !== 5
    || definitions.some((row, ordinal) => (
      row.ordinal !== ordinal
      || row.gate !== `G${ordinal}`
      || !isP4Gate(row.gate)
      || !Array.isArray(row.activities)
      || row.activities.length === 0
      || row.activities.some((activity) => typeof activity !== "string" || activity.length === 0)
      || !Array.isArray(row.required_checks)
      || row.required_checks.length === 0
      || row.required_checks.some((check) => {
        if (!check || typeof check !== "object" || Array.isArray(check)) return true;
        const value = check as Record<string, unknown>;
        return typeof value.code !== "string"
          || (value.severity !== "hard" && value.severity !== "advisory");
      })
      || row.profile_hash !== GJB_REF_V1_PROFILE.profileHash
    ))
  ) {
    throw conflictApiError("PROCESS_PROFILE_DB_MISMATCH");
  }
  const body = {
    schema: "process-profile.v1" as const,
    id: "GJB_REF_V1" as const,
    version: "GJB_REF_V1" as const,
    name: "GJB 参考流程 v1" as const,
    nodes: definitions.map((row) => ({
      id: row.gate,
      kind: "gate" as const,
      ordinal: row.ordinal,
      name: row.name,
      goal: row.goal,
      activities: row.activities,
      requiredChecks: row.required_checks,
      milestoneBaseline: row.milestone_baseline,
    })),
  };
  const profileHash = hashPayload(body);
  if (profileHash !== GJB_REF_V1_PROFILE.profileHash) {
    throw conflictApiError("PROCESS_PROFILE_DB_MISMATCH", {
      expected: GJB_REF_V1_PROFILE.profileHash,
      actual: profileHash,
    });
  }
  return { status: 200, data: { ...body, profileHash } };
}

interface ReadinessProjectionRow {
  readonly id: string;
  readonly state: "ready" | "blocked";
  readonly readiness_hash: string;
  readonly target_part: string | null;
  readonly board_ref: string | null;
  readonly workspace_ready: boolean;
  readonly data_scope_recorded: boolean;
  readonly source_materials_recorded: boolean;
  readonly pin_constraints_complete: boolean;
  readonly electrical_constraints_complete: boolean;
  readonly clock_constraints_complete: boolean;
  readonly toolchain_profile_hash: string | null;
  readonly constraint_revision_ids: string[];
  readonly generated_by_type: string;
  readonly generated_by: string;
  readonly confirmed_by: string | null;
  readonly confirmed_at: Date | string | null;
}

function processReadiness(row: ReadinessProjectionRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const confirmed = row.confirmed_by !== null && row.confirmed_at !== null;
  const constraintsComplete = row.pin_constraints_complete
    && row.electrical_constraints_complete
    && row.clock_constraints_complete;
  return {
    id: row.id,
    status: confirmed ? "confirmed" : "draft",
    ready: confirmed && row.state === "ready",
    readinessHash: row.readiness_hash,
    targetPart: row.target_part ?? "missing",
    boardRef: row.board_ref ?? "missing",
    workspaceReady: row.workspace_ready,
    dataScopeRecorded: row.data_scope_recorded,
    sourceMaterialsRecorded: row.source_materials_recorded,
    pinConstraintsComplete: row.pin_constraints_complete,
    electricalConstraintsComplete: row.electrical_constraints_complete,
    clockConstraintsComplete: row.clock_constraints_complete,
    constraintsComplete,
    toolchainProfileHash: row.toolchain_profile_hash,
    constraintRevisionIds: row.constraint_revision_ids,
    generatedBy: { type: row.generated_by_type, id: row.generated_by },
    confirmedBy: confirmed ? { id: row.confirmed_by, at: iso(row.confirmed_at) } : null,
  };
}

export async function getP4ProcessStateHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  let work = await activeWorkVersion(ctx.pool, projectId);
  if (!work) {
    const releasedResult = await ctx.pool.query(
      `SELECT id, project_id, process_instance_id, version, origin,
              change_request_id, base_delivery_release_id,
              start_gate::text, current_gate::text, state, created_at, released_at
         FROM project_work_version
        WHERE project_id = $1 AND state = 'released'
        ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    work = releasedResult.rows[0] as WorkVersionRow | undefined
      ?? await latestWorkVersion(ctx.pool, projectId);
  }
  if (!work) throw conflictApiError("P4_WORK_VERSION_REQUIRED");
  const piResult = await ctx.pool.query(
    `SELECT id, current_gate::text FROM process_instance
      WHERE project_id = $1 AND gate_profile_version = 'GJB_REF_V1'
      ORDER BY created_at, id LIMIT 1`,
    [projectId],
  );
  const process = piResult.rows[0] as { id?: string; current_gate?: P4GateId } | undefined;
  if (!process?.id) throw conflictApiError("P4_PROCESS_INSTANCE_REQUIRED");
  const readinessResult = work ? await ctx.pool.query(
    `SELECT id, state, readiness_hash, target_part, board_ref, workspace_ready,
            data_scope_recorded, source_materials_recorded,
            pin_constraints_complete, electrical_constraints_complete,
            clock_constraints_complete, toolchain_profile_hash,
            constraint_revision_ids, generated_by_type::text, generated_by,
            confirmed_by, confirmed_at
       FROM project_readiness
      WHERE project_id = $1 AND work_version_id = $2
      ORDER BY sequence DESC LIMIT 1`,
    [projectId, work.id],
  ) : { rows: [] };
  const currentGate = work?.current_gate ?? process.current_gate ?? "G0";
  return {
    status: 200,
    data: {
      schema: "process-state.v1",
      projectId,
      processInstanceId: process.id,
      workVersionId: work.id,
      profileId: "GJB_REF_V1",
      profileHash: GJB_REF_V1_PROFILE.profileHash,
      currentGate,
      completed: work.state === "released",
      readiness: processReadiness(readinessResult.rows[0] as ReadinessProjectionRow | undefined),
    },
  };
}

// ─── G0 readiness ────────────────────────────────────────────────────────────

interface ReadinessCheck {
  readonly code: string;
  readonly severity: "hard";
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
}

interface ConstraintRevisionRow {
  readonly id: string;
  readonly content: string | null;
  readonly content_hash: string;
  readonly content_location: string;
  readonly artifact_type: string;
}

interface ConstraintRevisionFact {
  readonly id: string;
  readonly valid: boolean;
  readonly path: string | null;
  readonly text: string | null;
  readonly issue: string | null;
}

interface ConstraintCategoryFact {
  readonly hardPassed: boolean;
  readonly complete: boolean;
  readonly details: Record<string, unknown>;
}

function constraintFailureCode(error: unknown): string {
  if (error instanceof P4ValidationError) return "FORBIDDEN_OR_INVALID_CONTENT";
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code);
  }
  return "CONSTRAINT_CONTENT_UNAVAILABLE";
}

async function inspectConstraintRevisions(
  query: QueryClient,
  projectId: string,
  config: EngineeringConfigV1,
): Promise<{
  readonly rows: ReadonlyMap<string, ConstraintRevisionRow>;
  readonly facts: ReadonlyMap<string, ConstraintRevisionFact>;
}> {
  const allIds = [...new Set([
    ...config.constraints.pin.revisionIds,
    ...config.constraints.electrical.revisionIds,
    ...config.constraints.clock.revisionIds,
  ])].sort();
  const completeIds = new Set<string>([
    ...(config.constraints.pin.state === "complete" ? config.constraints.pin.revisionIds : []),
    ...(config.constraints.electrical.state === "complete" ? config.constraints.electrical.revisionIds : []),
    ...(config.constraints.clock.state === "complete" ? config.constraints.clock.revisionIds : []),
  ]);
  const selected = allIds.length === 0 ? [] : (await query.query(
    `SELECT ar.id, ar.content, ar.content_hash, ar.content_location, a.artifact_type
       FROM artifact_revision ar
       JOIN artifact a ON a.id = ar.artifact_id AND a.project_id = ar.project_id
      WHERE ar.project_id = $1 AND ar.id = ANY($2::text[])`,
    [projectId, allIds],
  )).rows as ConstraintRevisionRow[];
  const rows = new Map(selected.map((row) => [row.id, row]));
  const facts = new Map<string, ConstraintRevisionFact>();

  for (const id of completeIds) {
    const row = rows.get(id);
    if (!row) {
      facts.set(id, { id, valid: false, path: null, text: null, issue: "REVISION_NOT_OWNED" });
      continue;
    }
    if (row.artifact_type !== "XDC_CANDIDATE") {
      facts.set(id, { id, valid: false, path: null, text: null, issue: "REVISION_NOT_XDC" });
      continue;
    }
    try {
      const path = formalPath(row.content_location);
      const gitBytes = await readRegularFileAtLocation(projectId, row.content_location);
      const bytes = gitBytes ?? (row.content === null ? null : new TextEncoder().encode(row.content));
      if (bytes === null) throw new Error("constraint revision has no immutable bytes");
      if (sha256Hex(bytes) !== row.content_hash) {
        const mismatch = new Error("constraint revision bytes do not match content_hash") as Error & { code: string };
        mismatch.code = "CONTENT_HASH_MISMATCH";
        throw mismatch;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateFormalInputContent(path, text);
      facts.set(id, { id, valid: true, path, text, issue: null });
    } catch (error) {
      facts.set(id, {
        id,
        valid: false,
        path: null,
        text: null,
        issue: constraintFailureCode(error),
      });
    }
  }
  return { rows, facts };
}

function constraintCategoryFact(
  config: EngineeringConfigV1,
  kind: XdcConstraintKind,
  facts: ReadonlyMap<string, ConstraintRevisionFact>,
): ConstraintCategoryFact {
  const declared = config.constraints[kind];
  if (declared.state !== "complete") {
    return {
      hardPassed: true,
      complete: false,
      details: {
        declaredState: declared.state,
        revisionIds: declared.revisionIds,
        semanticFactRequired: false,
      },
    };
  }
  const revisions = declared.revisionIds.map((id) => facts.get(id) ?? {
    id,
    valid: false,
    path: null,
    text: null,
    issue: "REVISION_NOT_OWNED",
  });
  const integrityPassed = revisions.every((revision) => revision.valid);
  const semanticFactPresent = integrityPassed
    && revisions.some((revision) => revision.text !== null && hasXdcConstraintFact(revision.text, kind));
  const passed = integrityPassed && semanticFactPresent;
  return {
    hardPassed: passed,
    complete: passed,
    details: {
      declaredState: declared.state,
      revisionIds: declared.revisionIds,
      integrityPassed,
      semanticFactPresent,
      issues: revisions
        .filter((revision) => !revision.valid)
        .map((revision) => ({ revisionId: revision.id, issue: revision.issue })),
    },
  };
}

function readinessPublic(row: Record<string, unknown>): Record<string, unknown> {
  const confirmed = row.confirmed_by !== null && row.confirmed_at !== null;
  const checks = (row.check_results as ReadinessCheck[] | undefined) ?? [];
  return {
    id: row.id,
    project_id: row.project_id,
    process_instance_id: row.process_instance_id,
    work_version_id: row.work_version_id,
    status: confirmed ? "confirmed" : "draft",
    state: row.state,
    ready: confirmed && row.state === "ready",
    readiness_hash: row.readiness_hash,
    result_hash: row.result_hash,
    engineering_config: row.engineering_config,
    engineering_config_hash: row.engineering_config_hash,
    target_part: row.target_part ?? "missing",
    board_ref: row.board_ref ?? "missing",
    workspace_ready: row.workspace_ready,
    data_scope_recorded: row.data_scope_recorded,
    source_materials_recorded: row.source_materials_recorded,
    pin_constraints_complete: row.pin_constraints_complete,
    electrical_constraints_complete: row.electrical_constraints_complete,
    clock_constraints_complete: row.clock_constraints_complete,
    constraints_complete: Boolean(row.pin_constraints_complete)
      && Boolean(row.electrical_constraints_complete)
      && Boolean(row.clock_constraints_complete),
    constraint_revision_ids: row.constraint_revision_ids,
    toolchain_profile_hash: row.toolchain_profile_hash,
    generated_by_type: row.generated_by_type,
    generated_by: row.generated_by,
    generated_at: row.generated_at,
    confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at,
    checks,
  };
}

async function selectReadiness(query: QueryClient, projectId: string, id: string): Promise<Record<string, unknown>> {
  const { rows } = await query.query(
    `SELECT id, project_id, process_instance_id, process_version_id,
            profile_definition_hash, work_version_id, sequence,
            supersedes_readiness_id, engineering_config,
            engineering_config_hash, source_snapshot_ids, workspace_commit,
            workspace_manifest_hash, check_results, result_hash, state,
            board_ref, workspace_ready, data_scope_recorded,
            source_materials_recorded, pin_constraints_complete,
            electrical_constraints_complete, clock_constraints_complete,
            constraint_revision_ids, toolchain_profile_hash, target_part,
            readiness_hash, generated_by_type, generated_by, generated_at,
            confirmed_by, confirmed_at, created_at
       FROM project_readiness WHERE id = $1 AND project_id = $2`,
    [id, projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`readiness not found: ${id}`);
  return readinessPublic(row);
}

export async function prepareP4ReadinessHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, [
    "engineering_config",
    "id",
    "reason",
    "source_snapshot_ids",
    "work_version_id",
    "workspace_expected_commit",
    "workspace_manifest_hash",
  ]);
  const id = requireId(body.id, "id");
  const workVersionId = requireId(body.work_version_id, "work_version_id");
  const reason = requireString(body, "reason");
  const sourceSnapshotIds = optionalStringArray(body, "source_snapshot_ids");
  if (new Set(sourceSnapshotIds).size !== sourceSnapshotIds.length) {
    throw validationError("source_snapshot_ids must be unique");
  }
  const expectedCommit = requireString(body, "workspace_expected_commit");
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(expectedCommit)) {
    throw validationError("workspace_expected_commit must be a git object id");
  }
  const expectedManifestHash = requireHash(body.workspace_manifest_hash, "workspace_manifest_hash");
  let config;
  try {
    config = parseEngineeringConfig(body.engineering_config);
  } catch (error) {
    throw mapP4Error(error);
  }
  const configFacts = engineeringConfigFacts(config);
  let discoveryStatus: "bound" | "missing" | "failed" | "drift" | "invalid_hash" = "missing";
  let discoveryHash: string | null = null;
  let discoveryConnectorId: string | null = null;
  let discoveryFailureCode: string | null = null;
  if (ctx.connector) {
    try {
      const discovery = await ctx.connector.discover(projectId);
      if (discovery.drift) {
        discoveryStatus = "drift";
      } else if (typeof discovery.toolchainProfileHash !== "string" || !SHA256.test(discovery.toolchainProfileHash)) {
        discoveryStatus = "invalid_hash";
      } else {
        discoveryStatus = "bound";
        discoveryHash = discovery.toolchainProfileHash;
        discoveryConnectorId = ctx.connector.connectorId;
      }
    } catch (error) {
      discoveryStatus = "failed";
      discoveryFailureCode = error instanceof Error && "code" in error
        ? String((error as Error & { code?: unknown }).code ?? "DISCOVERY_FAILED")
        : "DISCOVERY_FAILED";
      // Readiness records a blocked toolchain check instead of erasing the rest
      // of the human-visible preparation result.
    }
  }
  let actualWorkspace: Awaited<ReturnType<typeof collectWorkspaceFacts>> | null = null;
  let constraintInspection: Awaited<ReturnType<typeof inspectConstraintRevisions>> | null = null;
  let pinConstraint: ConstraintCategoryFact | null = null;
  let electricalConstraint: ConstraintCategoryFact | null = null;
  let clockConstraint: ConstraintCategoryFact | null = null;

  const { result } = await runP4SessionLockedIdempotent(
    ctx,
    projectId,
    "readiness.prepare",
    "prepare_p4_readiness",
    async (tx) => {
    const workspaceFacts = actualWorkspace;
    const inspection = constraintInspection;
    const pinFacts = pinConstraint;
    const electricalFacts = electricalConstraint;
    const clockFacts = clockConstraint;
    if (!workspaceFacts || !inspection || !pinFacts || !electricalFacts || !clockFacts) {
      throw internalError("READINESS_MUTATION_FACTS_MISSING");
    }
    const project = await requireModernProject(tx, projectId);
    const work = await ensureInitialWorkVersion(tx, ctx, workVersionId);
    if (work.state !== "working") throw conflictApiError("WORK_VERSION_NOT_WORKING");

    const constraintsOwned = inspection.rows.size === configFacts.constraintRevisionIds.length
      && [...inspection.rows.values()]
        .every((row) => row.artifact_type === "XDC_CANDIDATE" || row.artifact_type === "CONSTRAINT_DESIGN");
    const configuredToolchainValid = project.toolchain_profile_ref === null
      || SHA256.test(project.toolchain_profile_ref);
    const configuredToolchainMatches = project.toolchain_profile_ref === null
      || project.toolchain_profile_ref === discoveryHash;
    const toolchainBound = discoveryStatus === "bound"
      && discoveryHash !== null
      && configuredToolchainValid
      && configuredToolchainMatches;
    const toolchainHash = toolchainBound ? discoveryHash : null;

    let sourcesOwned = true;
    if (sourceSnapshotIds.length > 0) {
      const sourceRows = await tx.query(
        `SELECT id FROM import_snapshot
          WHERE project_id = $1 AND id = ANY($2::text[])
            AND status = 'confirmed'
            AND (expires_at IS NULL OR expires_at > now())`,
        [projectId, sourceSnapshotIds],
      );
      sourcesOwned = sourceRows.rows.length === sourceSnapshotIds.length;
    }

    const targetMatches = config.targetPart.state === "missing"
      || project.target_part === null
      || project.target_part === config.targetPart.value;
    if (project.target_part === null && config.targetPart.state === "identified") {
      await tx.query("UPDATE project SET target_part = $1 WHERE id = $2 AND target_part IS NULL", [config.targetPart.value, projectId]);
    }
    if (project.toolchain_profile_ref === null && toolchainBound && discoveryHash) {
      await tx.query(
        "UPDATE project SET toolchain_profile_ref = $1 WHERE id = $2 AND toolchain_profile_ref IS NULL",
        [discoveryHash, projectId],
      );
    }

    const checks: ReadinessCheck[] = [
      { code: "G0_PROFILE_BOUND", severity: "hard", passed: true, details: { processVersionId: "GJB_REF_V1", profileHash: GJB_REF_V1_PROFILE.profileHash } },
      { code: "G0_SCOPE_RECORDED", severity: "hard", passed: config.dataScope.description.trim().length > 0, details: { classification: config.dataScope.classification } },
      { code: "G0_ENGINEERING_CONFIG_RECORDED", severity: "hard", passed: constraintsOwned && targetMatches, details: { constraintsOwned, targetMatches, targetState: config.targetPart.state, boardState: config.board.state } },
      { code: "constraints.pin.complete", severity: "hard", passed: pinFacts.hardPassed, details: pinFacts.details },
      { code: "constraints.electrical.complete", severity: "hard", passed: electricalFacts.hardPassed, details: electricalFacts.details },
      { code: "constraints.clock.complete", severity: "hard", passed: clockFacts.hardPassed, details: clockFacts.details },
      { code: "G0_SOURCES_RECORDED", severity: "hard", passed: sourcesOwned && config.sourcePolicy.confirmedOnly, details: { sourceSnapshotIds, sourcesOwned, confirmedOnly: true } },
      { code: "G0_WORKSPACE_READY", severity: "hard", passed: workspaceFacts.commit === expectedCommit && workspaceFacts.manifestHash === expectedManifestHash && workspaceFacts.pending.length === 0, details: { expectedCommit, actualCommit: workspaceFacts.commit, expectedManifestHash, actualManifestHash: workspaceFacts.manifestHash, pending: workspaceFacts.pending, skippedBinary: workspaceFacts.skippedBinary } },
      {
        code: "toolchain.bound",
        severity: "hard",
        passed: toolchainBound,
        details: {
          status: discoveryStatus,
          connectorId: discoveryConnectorId,
          configuredProfileHash: configuredToolchainValid ? project.toolchain_profile_ref : null,
          discoveredProfileHash: discoveryHash,
          configuredProfileMatches: configuredToolchainMatches,
          failureCode: discoveryFailureCode,
        },
      },
    ];
    const state = checks.every((check) => check.passed) ? "ready" : "blocked";
    const previousResult = await tx.query(
      `SELECT id, sequence FROM project_readiness
        WHERE project_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,
      [projectId],
    );
    const previous = previousResult.rows[0] as { id?: string; sequence?: number } | undefined;
    const sequence = (previous?.sequence ?? 0) + 1;
    const resultBody = {
      schema: "project-readiness-result.v1",
      projectId,
      processInstanceId: work.process_instance_id,
      workVersionId: work.id,
      engineeringConfigHash: configFacts.configHash,
      workspaceCommit: workspaceFacts.commit,
      workspaceManifestHash: workspaceFacts.manifestHash,
      toolchainProfileHash: toolchainHash,
      checks,
      state,
    };
    const resultHash = hashPayload(resultBody);
    const readinessHash = hashPayload({ ...resultBody, sequence, supersedesReadinessId: previous?.id ?? null });
    await tx.query(
      `INSERT INTO project_readiness
       (id, project_id, process_instance_id, process_version_id,
        profile_definition_hash, work_version_id, sequence,
        supersedes_readiness_id, engineering_config,
        engineering_config_hash, source_snapshot_ids, workspace_commit,
        workspace_manifest_hash, check_results, result_hash, state,
        board_ref, workspace_ready, data_scope_recorded,
        source_materials_recorded, pin_constraints_complete,
        electrical_constraints_complete, clock_constraints_complete,
        constraint_revision_ids, toolchain_profile_hash, target_part,
        readiness_hash, generated_by_type, generated_by)
       VALUES ($1,$2,$3,'GJB_REF_V1',$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,
               $13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [
        id,
        projectId,
        work.process_instance_id,
        GJB_REF_V1_PROFILE.profileHash,
        work.id,
        sequence,
        previous?.id ?? null,
        JSON.stringify(config),
        configFacts.configHash,
        sourceSnapshotIds,
        workspaceFacts.commit,
        workspaceFacts.manifestHash,
        JSON.stringify(checks),
        resultHash,
        state,
        config.board.ref,
        workspaceFacts.commit === expectedCommit
          && workspaceFacts.manifestHash === expectedManifestHash
          && workspaceFacts.pending.length === 0,
        config.dataScope.description.trim().length > 0,
        sourcesOwned && config.sourcePolicy.confirmedOnly,
        pinFacts.complete,
        electricalFacts.complete,
        clockFacts.complete,
        configFacts.constraintRevisionIds,
        toolchainHash,
        config.targetPart.value,
        readinessHash,
        ctx.identity.actorType,
        ctx.identity.actorId,
      ],
    );
    await appendP4Outbox(tx, ctx, "project_readiness", id, "project.readiness_prepared", {
      id,
      projectId,
      workVersionId: work.id,
      state,
      resultHash,
      reason,
    });
    return selectReadiness(tx, projectId, id);
  }, async (tx) => {
    actualWorkspace = await collectWorkspaceFacts(projectId);
    constraintInspection = await inspectConstraintRevisions(tx, projectId, config);
    pinConstraint = constraintCategoryFact(config, "pin", constraintInspection.facts);
    electricalConstraint = constraintCategoryFact(config, "electrical", constraintInspection.facts);
    clockConstraint = constraintCategoryFact(config, "clock", constraintInspection.facts);
    const workspaceFacts = actualWorkspace;
    const pinFacts = pinConstraint;
    const electricalFacts = electricalConstraint;
    const clockFacts = clockConstraint;
    const project = await requireModernProject(tx, projectId);
    const work = await activeWorkVersion(tx, projectId, true);
    if (!work || work.id !== workVersionId || work.state !== "working") {
      throw conflictApiError("WORK_VERSION_INACTIVE");
    }
    const existingResult = await tx.query(
      `SELECT id, work_version_id, workspace_commit, workspace_manifest_hash,
              toolchain_profile_hash, state
         FROM project_readiness WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    const existing = existingResult.rows[0] as {
      id?: string;
      work_version_id?: string;
      workspace_commit?: string;
      workspace_manifest_hash?: string;
      toolchain_profile_hash?: string | null;
      state?: string;
    } | undefined;
    if (!existing) return;
    const latestResult = await tx.query(
      `SELECT id FROM project_readiness
        WHERE project_id = $1 AND work_version_id = $2
        ORDER BY sequence DESC LIMIT 1`,
      [projectId, workVersionId],
    );
    const currentToolchainBound = discoveryStatus === "bound"
      && discoveryHash !== null
      && (project.toolchain_profile_ref === null || SHA256.test(project.toolchain_profile_ref))
      && (project.toolchain_profile_ref === null || project.toolchain_profile_ref === discoveryHash);
    const currentConstraintFactsValid = pinFacts.hardPassed
      && electricalFacts.hardPassed
      && clockFacts.hardPassed;
    if (
      existing.work_version_id !== workVersionId
      || (latestResult.rows[0] as { id?: string } | undefined)?.id !== id
      || existing.workspace_commit !== workspaceFacts.commit
      || existing.workspace_manifest_hash !== workspaceFacts.manifestHash
      || existing.toolchain_profile_hash !== (currentToolchainBound ? discoveryHash : null)
      || (existing.state === "ready" && (!currentToolchainBound || !currentConstraintFactsValid))
    ) {
      throw conflictApiError("READINESS_FACTS_CHANGED");
    }
  });
  return { status: 201, data: result };
}

export async function confirmP4ReadinessHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const readinessId = ctx.params.readinessId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["reason"]);
  const reason = requireString(body, "reason");
  const { result } = await runP4SessionLockedIdempotent(
    ctx,
    projectId,
    "readiness.confirm",
    "confirm_p4_readiness",
    async (tx) => {
      await requireModernProject(tx, projectId);
      await requireHumanProjectRole(tx, ctx);
      const lock = await tx.query(
        `SELECT id, work_version_id, process_instance_id, state, confirmed_by
           FROM project_readiness
          WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [readinessId, projectId],
      );
      const row = lock.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw notFoundError(`readiness not found: ${readinessId}`);
      if (row.confirmed_by !== null) {
        if (row.confirmed_by !== ctx.identity.actorId) {
          throw conflictApiError("READINESS_ALREADY_CONFIRMED");
        }
        return selectReadiness(tx, projectId, readinessId);
      }
      if (row.state !== "ready") throw conflictApiError("READINESS_BLOCKED");
      const work = await activeWorkVersion(tx, projectId, true);
      if (!work || work.id !== row.work_version_id) throw conflictApiError("READINESS_WORK_VERSION_INACTIVE");
      await tx.query(
        `UPDATE project_readiness SET confirmed_by = $1, confirmed_at = now()
          WHERE id = $2 AND project_id = $3 AND confirmed_by IS NULL`,
        [ctx.identity.actorId, readinessId, projectId],
      );
      if (work.current_gate === "G0") {
        await tx.query(
          "UPDATE project_work_version SET current_gate = 'G1' WHERE id = $1 AND project_id = $2",
          [work.id, projectId],
        );
        await tx.query(
          "UPDATE process_instance SET current_gate = 'G1' WHERE id = $1 AND project_id = $2",
          [work.process_instance_id, projectId],
        );
      }
      await appendP4Outbox(tx, ctx, "project_readiness", readinessId, "project.readiness_confirmed", {
        id: readinessId,
        projectId,
        workVersionId: work.id,
        confirmedBy: ctx.identity.actorId,
        reason,
      });
      return selectReadiness(tx, projectId, readinessId);
    },
    async (tx) => {
      await requireModernProject(tx, projectId);
      await requireHumanProjectRole(tx, ctx);
      const workspace = await collectWorkspaceFacts(projectId);
      const readinessResult = await tx.query(
        `SELECT id, work_version_id, confirmed_by, workspace_commit,
                workspace_manifest_hash
           FROM project_readiness WHERE id = $1 AND project_id = $2`,
        [readinessId, projectId],
      );
      const readiness = readinessResult.rows[0] as {
        id?: string;
        work_version_id?: string;
        confirmed_by?: string | null;
        workspace_commit?: string;
        workspace_manifest_hash?: string;
      } | undefined;
      if (!readiness?.id) throw notFoundError(`readiness not found: ${readinessId}`);
      if (
        workspace.pending.length > 0
        || workspace.skippedBinary.length > 0
        || readiness.workspace_commit !== workspace.commit
        || readiness.workspace_manifest_hash !== workspace.manifestHash
      ) {
        throw conflictApiError("READINESS_WORKSPACE_CHANGED", {
          expectedCommit: readiness.workspace_commit,
          actualCommit: workspace.commit,
          expectedManifestHash: readiness.workspace_manifest_hash,
          actualManifestHash: workspace.manifestHash,
          pending: workspace.pending,
          skippedBinary: workspace.skippedBinary,
        });
      }
      if (readiness.confirmed_by !== null && readiness.confirmed_by !== ctx.identity.actorId) {
        throw conflictApiError("READINESS_ALREADY_CONFIRMED");
      }
      const work = await activeWorkVersion(tx, projectId, true);
      if (!work || work.id !== readiness.work_version_id) {
        throw conflictApiError("READINESS_WORK_VERSION_INACTIVE");
      }
      const latest = await tx.query(
        `SELECT id FROM project_readiness
          WHERE project_id = $1 AND work_version_id = $2
          ORDER BY sequence DESC LIMIT 1`,
        [projectId, work.id],
      );
      if ((latest.rows[0] as { id?: string } | undefined)?.id !== readinessId) {
        throw conflictApiError("READINESS_SUPERSEDED");
      }
    },
  );
  return { status: 200, data: result };
}

export async function listP4ReadinessHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT id FROM project_readiness WHERE project_id = $1 ORDER BY sequence DESC`,
    [projectId],
  );
  const result: Record<string, unknown>[] = [];
  for (const row of rows as { id: string }[]) result.push(await selectReadiness(ctx.pool, projectId, row.id));
  return { status: 200, data: result };
}

// ─── Gate submissions and Core-owned evaluation ─────────────────────────────

export async function createP4GateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["gate", "id", "process_instance_id", "snapshot_id", "work_version_id"]);
  const id = requireId(body.id, "id");
  const processInstanceId = requireId(body.process_instance_id, "process_instance_id");
  const snapshotId = requireId(body.snapshot_id, "snapshot_id");
  const requestedWorkVersionId = body.work_version_id === undefined
    ? null
    : requireId(body.work_version_id, "work_version_id");
  if (!isP4Gate(body.gate) || body.gate === "G0") {
    throw validationError("field 'gate' must be one of G1-G4");
  }
  const gate = body.gate;
  const { result } = await runIdempotent(ctx, "create_p4_gate_submission", projectId, async (tx) => {
    await requireModernProject(tx, projectId);
    const work = await activeWorkVersion(tx, projectId, true);
    if (
      !work
      || (requestedWorkVersionId !== null && work.id !== requestedWorkVersionId)
      || work.process_instance_id !== processInstanceId
    ) {
      throw conflictApiError("WORK_VERSION_INACTIVE");
    }
    if (work.state !== "working" || work.current_gate !== gate) {
      throw conflictApiError("GATE_OUT_OF_SEQUENCE", {
        expectedGate: work.current_gate,
        receivedGate: gate,
        workState: work.state,
      });
    }
    const readiness = await tx.query(
      `SELECT 1 FROM project_readiness
        WHERE project_id = $1 AND work_version_id = $2
          AND state = 'ready' AND confirmed_by IS NOT NULL
        ORDER BY sequence DESC LIMIT 1`,
      [projectId, work.id],
    );
    if (readiness.rows.length === 0) throw conflictApiError("G0_READINESS_REQUIRED");
    const snapshotResult = await tx.query(
      `SELECT id, gate_profile_version, manifest_hash, work_version_id
         FROM configuration_snapshot
        WHERE id = $1 AND project_id = $2`,
      [snapshotId, projectId],
    );
    const snapshot = snapshotResult.rows[0] as {
      gate_profile_version?: string;
      manifest_hash?: string;
      work_version_id?: string | null;
    } | undefined;
    if (!snapshot) throw notFoundError(`snapshot not found: ${snapshotId}`);
    if (snapshot.gate_profile_version !== "GJB_REF_V1") {
      throw conflictApiError("SNAPSHOT_PROFILE_MISMATCH");
    }
    if (snapshot.work_version_id !== work.id) {
      throw conflictApiError("SNAPSHOT_WORK_VERSION_MISMATCH", {
        expected: work.id,
        actual: snapshot.work_version_id ?? null,
      });
    }
    const activeResult = await tx.query(
      `SELECT id, state FROM gate_submission
        WHERE project_id = $1 AND process_instance_id = $2 AND gate = $3
          AND state = ANY($4::gate_sub_state[])
        ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [projectId, processInstanceId, gate, ACTIVE_SUBMISSION_STATES],
    );
    if (activeResult.rows.length > 0) {
      throw conflictApiError("ACTIVE_GATE_SUBMISSION_EXISTS", activeResult.rows[0]);
    }
    await tx.query(
      `INSERT INTO gate_submission
        (id, project_id, process_instance_id, work_version_id, gate, snapshot_id, state, submitter_id)
       VALUES ($1,$2,$3,$4,$5,$6,'preparing',$7)`,
      [id, projectId, processInstanceId, work.id, gate, snapshotId, ctx.identity.actorId],
    );
    await appendP4Outbox(tx, ctx, "gate_submission", id, "gate.submission_created", {
      id,
      projectId,
      workVersionId: work.id,
      processInstanceId,
      gate,
      snapshotId,
    });
    return {
      id,
      project_id: projectId,
      process_instance_id: processInstanceId,
      work_version_id: work.id,
      gate,
      snapshot_id: snapshotId,
      state: "preparing",
    };
  }, async (tx) => {
    await requireModernProject(tx, projectId);
    const work = await activeWorkVersion(tx, projectId, true);
    if (
      !work
      || (requestedWorkVersionId !== null && work.id !== requestedWorkVersionId)
      || work.process_instance_id !== processInstanceId
    ) {
      throw conflictApiError("WORK_VERSION_INACTIVE");
    }
    if (work.state !== "working" || work.current_gate !== gate) {
      throw conflictApiError("GATE_OUT_OF_SEQUENCE", {
        expectedGate: work.current_gate,
        receivedGate: gate,
        workState: work.state,
      });
    }
    const snapshot = await tx.query(
      `SELECT 1 FROM configuration_snapshot
        WHERE id = $1 AND project_id = $2 AND work_version_id = $3
          AND gate_profile_version = 'GJB_REF_V1'`,
      [snapshotId, projectId, work.id],
    );
    if (snapshot.rows.length === 0) throw conflictApiError("SNAPSHOT_WORK_VERSION_MISMATCH");
    const readiness = await tx.query(
      `SELECT 1 FROM project_readiness
        WHERE project_id = $1 AND work_version_id = $2
          AND state = 'ready' AND confirmed_by IS NOT NULL
        ORDER BY sequence DESC LIMIT 1`,
      [projectId, work.id],
    );
    if (readiness.rows.length === 0) throw conflictApiError("G0_READINESS_REQUIRED");
  });
  return { status: 201, data: result };
}

interface SubmissionContext {
  readonly id: string;
  readonly project_id: string;
  readonly process_instance_id: string;
  readonly work_version_id: string;
  readonly gate: P4GateId;
  readonly snapshot_id: string;
  readonly state: string;
  readonly snapshot_manifest_hash: string;
  readonly member_revision_ids: string[];
  readonly trace_relation_ids: string[];
  readonly gate_profile_version: string;
  readonly snapshot_work_version_id: string;
}

async function submissionContext(
  query: QueryClient,
  projectId: string,
  submissionId: string,
  lock = false,
): Promise<SubmissionContext> {
  const { rows } = await query.query(
    `SELECT gs.id, gs.project_id, gs.process_instance_id, gs.work_version_id, gs.gate::text,
            gs.snapshot_id, gs.state::text, s.manifest_hash AS snapshot_manifest_hash,
            s.member_revision_ids, s.trace_relation_ids, s.gate_profile_version,
            s.work_version_id AS snapshot_work_version_id
       FROM gate_submission gs
       JOIN configuration_snapshot s ON s.id = gs.snapshot_id AND s.project_id = gs.project_id
      WHERE gs.id = $1 AND gs.project_id = $2${lock ? " FOR UPDATE OF gs" : ""}`,
    [submissionId, projectId],
  );
  const row = rows[0] as SubmissionContext | undefined;
  if (!row) throw notFoundError(`gate_submission not found: ${submissionId}`);
  if (!isP4Gate(row.gate) || row.gate_profile_version !== "GJB_REF_V1") {
    throw conflictApiError("P4_GATE_SUBMISSION_REQUIRED");
  }
  if (
    typeof row.work_version_id !== "string"
    || row.snapshot_work_version_id !== row.work_version_id
  ) {
    throw conflictApiError("P4_GATE_SUBMISSION_WORK_VERSION_REQUIRED");
  }
  return row;
}

interface GateCheckFact {
  readonly code: string;
  readonly severity: "hard" | "advisory";
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
  readonly evidenceRefs: readonly unknown[];
}

interface ArtifactFact {
  readonly revision_id: string;
  readonly artifact_type: string;
  readonly content_hash: string;
  readonly content_location: string;
  readonly content: string | null;
  readonly title: string;
}

async function snapshotArtifacts(
  query: QueryClient,
  projectId: string,
  revisionIds: readonly string[],
): Promise<ArtifactFact[]> {
  if (revisionIds.length === 0) return [];
  const { rows } = await query.query(
    `SELECT ar.id AS revision_id, a.artifact_type, ar.content_hash,
            ar.content_location, ar.content, a.title
       FROM artifact_revision ar JOIN artifact a ON a.id = ar.artifact_id
      WHERE ar.project_id = $1 AND ar.id = ANY($2::text[])
      ORDER BY ar.id`,
    [projectId, revisionIds],
  );
  return rows as ArtifactFact[];
}

async function managedGateRevisions(
  query: QueryClient,
  projectId: string,
  revisionIds: readonly string[],
): Promise<ManagedGateRevision[]> {
  if (revisionIds.length === 0) return [];
  const { rows } = await query.query(
    `SELECT ar.id AS revision_id, ar.project_id, ar.content_hash,
            ar.content_location, ar.content
       FROM artifact_revision ar
      WHERE ar.id = ANY($1::text[])
      ORDER BY ar.id`,
    [revisionIds],
  );
  const revisions: ManagedGateRevision[] = [];
  for (const row of rows as Array<{
    revision_id: string;
    project_id: string;
    content_hash: string;
    content_location: string;
    content: string | null;
  }>) {
    let bytes: string | null = null;
    if (row.project_id === projectId) {
      try {
        const archived = await readRegularFileAtLocation(projectId, row.content_location);
        const raw = archived ?? (row.content === null ? null : new TextEncoder().encode(row.content));
        if (raw !== null && sha256Hex(raw) === row.content_hash) {
          bytes = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        }
      } catch {
        // The semantic evaluator records unavailable or hash-mismatched bytes
        // as a failed hard fact instead of accepting a revision by metadata.
      }
    }
    revisions.push({
      revisionId: row.revision_id,
      projectId: row.project_id,
      contentHash: row.content_hash,
      bytes,
    });
  }
  return revisions;
}

async function frozenGateTraces(
  query: QueryClient,
  traceIds: readonly string[],
): Promise<FrozenGateTrace[]> {
  if (traceIds.length === 0) return [];
  const { rows } = await query.query(
    `SELECT relation.id, relation.project_id, relation.state::text,
            relation.source_id, source.project_id AS source_project_id,
            relation.target_id, target.project_id AS target_project_id,
            relation.basis
       FROM trace_relation relation
       LEFT JOIN artifact_revision source ON source.id = relation.source_id
       LEFT JOIN artifact_revision target ON target.id = relation.target_id
      WHERE relation.id = ANY($1::text[])
      ORDER BY relation.id`,
    [traceIds],
  );
  return (rows as Array<{
    id: string;
    project_id: string;
    state: string;
    source_id: string;
    source_project_id: string | null;
    target_id: string;
    target_project_id: string | null;
    basis: string;
  }>).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    sourceRevisionId: row.source_id,
    sourceProjectId: row.source_project_id,
    targetRevisionId: row.target_id,
    targetProjectId: row.target_project_id,
    basis: row.basis,
  }));
}

interface StructuredBaselineFact {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly manifest_hash: string;
  readonly member_revision_ids: string[];
  readonly trace_relation_ids: string[];
}

async function activeStructuredBaseline(
  query: QueryClient,
  projectId: string,
  kind: "B0" | "B1",
  lock = false,
): Promise<StructuredBaselineFact | null> {
  const result = await query.query(
    `SELECT id, kind::text, state::text, manifest_hash,
            member_revision_ids, trace_relation_ids
       FROM baseline WHERE project_id = $1 AND kind = $2 AND state = 'active'
      ORDER BY created_at DESC, id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [projectId, kind],
  );
  return result.rows[0] as StructuredBaselineFact | undefined ?? null;
}

async function b0RequirementAuthority(
  query: QueryClient,
  projectId: string,
  baseline: StructuredBaselineFact | null,
): Promise<P4RequirementAuthority | null> {
  if (!baseline || baseline.kind !== "B0" || baseline.state !== "active") return null;
  const revisions = await managedGateRevisions(query, projectId, baseline.member_revision_ids);
  const traces = await frozenGateTraces(query, baseline.trace_relation_ids);
  const evaluation = evaluateP4GateEvidence({
    gate: "G1",
    projectId,
    snapshotId: `baseline:${baseline.id}`,
    snapshotManifestHash: baseline.manifest_hash,
    memberRevisionIds: baseline.member_revision_ids,
    revisions,
    traceRelationIds: baseline.trace_relation_ids,
    traces,
  });
  return evaluation.checks["artifact.development_requirements"]?.passed === true
    && evaluation.checks["snapshot.members_frozen"]?.passed === true
    ? evaluation.authority
    : null;
}

async function structuredGateEvaluation(
  query: QueryClient,
  projectId: string,
  context: SubmissionContext,
  b0: StructuredBaselineFact | null,
): Promise<P4GateEvidenceEvaluation | null> {
  if (context.gate !== "G1" && context.gate !== "G2" && context.gate !== "G3") return null;
  const revisions = await managedGateRevisions(query, projectId, context.member_revision_ids);
  const traces = await frozenGateTraces(query, context.trace_relation_ids);
  const authoritativeRequirements = context.gate === "G1"
    ? null
    : await b0RequirementAuthority(query, projectId, b0);
  return evaluateP4GateEvidence({
    gate: context.gate as P4StructuredGateId,
    projectId,
    snapshotId: context.snapshot_id,
    snapshotManifestHash: context.snapshot_manifest_hash,
    memberRevisionIds: context.member_revision_ids,
    revisions,
    traceRelationIds: context.trace_relation_ids,
    traces,
    authoritativeRequirements,
  });
}

function artifactCheck(
  code: string,
  severity: "hard" | "advisory",
  artifacts: readonly ArtifactFact[],
  acceptedTypes: readonly string[],
): GateCheckFact {
  const matches = artifacts.filter((artifact) => acceptedTypes.includes(artifact.artifact_type));
  return {
    code,
    severity,
    passed: matches.length > 0,
    details: { acceptedTypes, revisionIds: matches.map((artifact) => artifact.revision_id) },
    evidenceRefs: matches.map((artifact) => ({ type: "artifact_revision", id: artifact.revision_id })),
  };
}

interface G4Facts {
  readonly approval: Record<string, unknown> | null;
  readonly runs: readonly Record<string, unknown>[];
  readonly bitstream: Record<string, unknown> | null;
  readonly items: readonly DeliveryCandidateItem[];
  readonly releaseId: string;
  readonly releaseVersion: number;
  readonly supersedesReleaseId: string | null;
  readonly plannedApprovalRecordId: string;
  readonly expectedClocks: readonly string[];
  readonly workspace: Awaited<ReturnType<typeof collectWorkspaceFacts>>;
  readonly revisionSetHash: string;
  readonly revisionCount: number;
}

interface DeliveryCandidateItem {
  readonly category: "rtl" | "tb" | "constraint" | "document" | "run_result" | "raw_evidence" | "confirmation" | "source" | "bitstream";
  readonly path: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly storage_uri: string;
  readonly provenance: Record<string, unknown>;
}

function dataItem(
  category: DeliveryCandidateItem["category"],
  path: string,
  sourceType: string,
  sourceId: string,
  value: unknown,
): DeliveryCandidateItem {
  const encoded = inlineJsonItem(value);
  return {
    category,
    path,
    source_type: sourceType,
    source_id: sourceId,
    sha256: encoded.sha256,
    size_bytes: encoded.sizeBytes,
    media_type: "application/json",
    storage_uri: encoded.uri,
    provenance: { schema: "delivery-provenance.v1", sourceType, sourceId },
  };
}

async function buildG4Facts(
  tx: TransactionClient,
  projectId: string,
  work: WorkVersionRow,
  context: SubmissionContext,
  evaluationId: string,
): Promise<G4Facts> {
  const workspace = await collectWorkspaceFacts(projectId);
  const revisionSetResult = await tx.query(
    `SELECT ar.id, ar.artifact_id, ar.version, ar.content_hash
       FROM artifact_revision ar
      WHERE ar.project_id = $1
      ORDER BY ar.artifact_id, ar.version, ar.id`,
    [projectId],
  );
  const revisionSet = (revisionSetResult.rows as Array<{
    id: string;
    artifact_id: string;
    version: number;
    content_hash: string;
  }>).map((revision) => ({
    artifactId: revision.artifact_id,
    revisionId: revision.id,
    version: revision.version,
    contentHash: revision.content_hash,
  }));
  const revisionSetHash = hashPayload({
    schema: "project-artifact-revision-set.v1",
    projectId,
    revisions: revisionSet,
  });
  const approvalResult = await tx.query(
    `SELECT f.*, r.engineering_config, r.check_results AS readiness_checks,
            r.result_hash AS readiness_result_hash
       FROM formal_input_approval f
       JOIN project_readiness r ON r.id = f.readiness_id AND r.project_id = f.project_id
       JOIN configuration_snapshot s ON s.id = f.snapshot_id AND s.project_id = f.project_id
       JOIN baseline b ON b.id = f.baseline_id AND b.project_id = f.project_id
       JOIN project p ON p.id = f.project_id
      WHERE f.project_id = $1 AND f.work_version_id = $2 AND f.snapshot_id = $3
        AND f.confirmed_by IS NOT NULL
        AND f.process_instance_id = $4
        AND f.manifest_hash = s.manifest_hash
        AND f.baseline_manifest_hash = b.manifest_hash
        AND b.kind = 'B1' AND b.state = 'active'
        AND r.work_version_id = f.work_version_id
        AND r.process_instance_id = f.process_instance_id
        AND r.engineering_config_hash = f.engineering_config_hash
        AND r.toolchain_profile_hash = f.toolchain_profile_hash
        AND r.target_part = f.target_part
        AND r.state = 'ready' AND r.confirmed_by IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM project_readiness newer
           WHERE newer.project_id = r.project_id
             AND newer.work_version_id = r.work_version_id
             AND newer.sequence > r.sequence
        )
        AND r.pin_constraints_complete AND r.electrical_constraints_complete
        AND r.clock_constraints_complete
        AND p.toolchain_profile_ref = f.toolchain_profile_hash
        AND p.target_part = f.target_part
      ORDER BY f.confirmed_at DESC, f.id DESC LIMIT 1`,
    [projectId, work.id, context.snapshot_id, work.process_instance_id],
  );
  const approval = approvalResult.rows[0] as Record<string, unknown> | undefined ?? null;
  const runsResult = approval ? await tx.query(
    `SELECT tr.id, tr.operation, tr.state::text, tr.run_class::text,
            tr.formal_input_approval_id, tr.input_hash,
            tr.input_snapshot_id, tr.input_manifest_hash,
            tr.toolchain_profile_hash, tr.binding_version,
            tr.parameters, m.id AS evidence_manifest_id,
            m.manifest_hash AS evidence_manifest_hash, m.verdicts,
            m.frozen_at
       FROM tool_run tr
       LEFT JOIN tool_run_evidence_manifest m
         ON m.tool_run_id = tr.id AND m.project_id = tr.project_id
      WHERE tr.project_id = $1 AND tr.formal_input_approval_id = $2
        AND tr.operation = ANY($3::text[])
      ORDER BY tr.operation, tr.created_at DESC, tr.id DESC`,
    [projectId, approval.id, FORMAL_OPERATIONS],
  ) : { rows: [] };
  const newestByOperation = new Map<string, Record<string, unknown>>();
  for (const run of runsResult.rows as Record<string, unknown>[]) {
    if (!newestByOperation.has(String(run.operation))) newestByOperation.set(String(run.operation), run);
  }
  const runs = FORMAL_OPERATIONS.map((operation) => newestByOperation.get(operation)).filter(Boolean) as Record<string, unknown>[];
  const implement = newestByOperation.get("implement");
  const bitstreamResult = implement ? await tx.query(
    `SELECT * FROM bitstream_result
      WHERE project_id = $1 AND work_version_id = $2 AND tool_run_id = $3
        AND class = 'formal'
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, work.id, implement.id],
  ) : { rows: [] };
  const bitstream = bitstreamResult.rows[0] as Record<string, unknown> | undefined ?? null;

  const currentReleaseResult = await tx.query(
    `SELECT id, version FROM delivery_release
      WHERE project_id = $1 AND state = 'sealed'
      ORDER BY version DESC LIMIT 1 FOR UPDATE`,
    [projectId],
  );
  const currentRelease = currentReleaseResult.rows[0] as { id?: string; version?: number } | undefined;
  const releaseVersion = (currentRelease?.version ?? 0) + 1;
  const releaseId = `rel_${sha256Hex(`${projectId}:${work.id}:${evaluationId}`).slice(0, 32)}`;
  const items: DeliveryCandidateItem[] = [];
  const expectedClocks = new Set<string>();
  const plannedApprovalRecordId = `apr_${sha256Hex(`${projectId}:${context.id}:${evaluationId}`).slice(0, 32)}`;

  if (approval) {
    const manifest = approval.input_manifest as FormalInputManifestV1;
    for (const file of manifest.files ?? []) {
      const category = file.role === "rtl" ? "rtl"
        : file.role === "tb" ? "tb"
        : file.role === "constraint" ? "constraint"
        : "document";
      items.push({
        category,
        path: file.path,
        source_type: "artifact_revision",
        source_id: file.revision_id,
        sha256: file.sha256,
        size_bytes: file.size_bytes,
        media_type: file.role === "document" ? "text/markdown" : "text/plain",
        storage_uri: file.storage_uri,
        provenance: { schema: "delivery-provenance.v1", formalInputApprovalId: approval.id, inputHash: approval.input_hash },
      });
      if (file.role === "constraint") {
        const bytes = await managedFormalContentBytes(tx, projectId, file.sha256, file.size_bytes);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw conflictApiError("FORMAL_INPUT_TEXT_REQUIRED", { path: file.path });
        }
        for (const clock of expectedClockNames(content)) expectedClocks.add(clock);
      }
      items.push({
        category: "source",
        path: `provenance/source/${file.path}`,
        source_type: "artifact_revision",
        source_id: file.revision_id,
        sha256: file.sha256,
        size_bytes: file.size_bytes,
        media_type: file.role === "document" ? "text/markdown" : "text/plain",
        storage_uri: file.storage_uri,
        provenance: { schema: "delivery-provenance.v1", originalPath: file.path, revisionId: file.revision_id },
      });
    }
    items.push(dataItem("confirmation", "confirmations/readiness.json", "project_readiness", String(approval.readiness_id), {
      id: approval.readiness_id,
      engineeringConfigHash: approval.engineering_config_hash,
      resultHash: approval.readiness_result_hash,
      confirmedBy: (approval as Record<string, unknown>).confirmed_by,
    }));
    items.push(dataItem("confirmation", "confirmations/formal-input.json", "formal_input_approval", String(approval.id), {
      id: approval.id,
      inputHash: approval.input_hash,
      previewHash: approval.preview_hash,
      confirmedBy: approval.confirmed_by,
      confirmedAt: approval.confirmed_at,
    }));
    const formalRevisionIds = new Set(manifest.files.map((file) => file.revision_id));
    const designRows = await tx.query(
      `SELECT ar.id, ar.content_hash, ar.content_location, ar.content,
              a.artifact_type
         FROM baseline b
         JOIN artifact_revision ar
           ON ar.project_id = b.project_id AND ar.id = ANY(b.member_revision_ids)
         JOIN artifact a ON a.id = ar.artifact_id AND a.project_id = ar.project_id
        WHERE b.id = $1 AND b.project_id = $2 AND b.kind = 'B1' AND b.state = 'active'
        ORDER BY ar.id`,
      [approval.baseline_id, projectId],
    );
    for (const design of designRows.rows as Array<{
      id: string;
      content_hash: string;
      content_location: string;
      content: string | null;
      artifact_type: string;
    }>) {
      if (formalRevisionIds.has(design.id)) continue;
      const path = formalPath(design.content_location);
      const content = await formalArtifactContent(projectId, path, design);
      await materializeFormalContents(tx, projectId, [content]);
      items.push({
        category: "document",
        path: `documents/${path}`,
        source_type: "artifact_revision",
        source_id: design.id,
        sha256: design.content_hash,
        size_bytes: content.sizeBytes,
        media_type: "text/markdown",
        storage_uri: `content://sha256/${design.content_hash}`,
        provenance: { schema: "delivery-provenance.v1", baselineId: approval.baseline_id, artifactType: design.artifact_type },
      });
      items.push({
        category: "source",
        path: `provenance/b1/${path}`,
        source_type: "artifact_revision",
        source_id: design.id,
        sha256: design.content_hash,
        size_bytes: content.sizeBytes,
        media_type: "text/markdown",
        storage_uri: `content://sha256/${design.content_hash}`,
        provenance: { schema: "delivery-provenance.v1", baselineId: approval.baseline_id, originalPath: path },
      });
    }
  }

  for (const run of runs) {
    items.push(dataItem("run_result", `results/${String(run.operation)}.json`, "tool_run", String(run.id), {
      id: run.id,
      operation: run.operation,
      state: run.state,
      runClass: run.run_class,
      inputHash: run.input_hash,
      evidenceManifestHash: run.evidence_manifest_hash,
      verdicts: run.verdicts,
    }));
    if (run.evidence_manifest_id) {
      const evidenceResult = await tx.query(
        `SELECT id, name, role, evidence_kind, sha256, size_bytes,
                media_type, uri, verdict
           FROM tool_run_evidence_entry
          WHERE project_id = $1 AND manifest_id = $2
          ORDER BY name`,
        [projectId, run.evidence_manifest_id],
      );
      for (const entry of evidenceResult.rows as Record<string, unknown>[]) {
        items.push({
          category: "raw_evidence",
          path: `evidence/${String(run.operation)}/${String(entry.name)}`,
          source_type: "tool_run_evidence_entry",
          source_id: String(entry.id),
          sha256: String(entry.sha256),
          size_bytes: numberValue(entry.size_bytes),
          media_type: String(entry.media_type),
          storage_uri: `evidence-entry://${String(entry.id)}`,
          provenance: { schema: "delivery-provenance.v1", toolRunId: run.id, role: entry.role, verdict: entry.verdict },
        });
      }
    }
  }
  if (bitstream) {
    items.push({
      category: "bitstream",
      path: "bitstream/formal-synthia.bit",
      source_type: "bitstream_result",
      source_id: String(bitstream.id),
      sha256: String(bitstream.sha256),
      size_bytes: numberValue(bitstream.size_bytes),
      media_type: "application/octet-stream",
      storage_uri: String(bitstream.storage_uri),
      provenance: { schema: "delivery-provenance.v1", class: "formal", toolRunId: bitstream.tool_run_id, inputHash: bitstream.input_hash },
    });
  }
  items.sort((left, right) => {
    const a = [left.category, left.path, left.source_type, left.source_id, left.sha256].join("\0");
    const b = [right.category, right.path, right.source_type, right.source_id, right.sha256].join("\0");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return {
    approval,
    runs,
    bitstream,
    items,
    releaseId,
    releaseVersion,
    supersedesReleaseId: currentRelease?.id ?? null,
    plannedApprovalRecordId,
    expectedClocks: [...expectedClocks].sort(),
    workspace,
    revisionSetHash,
    revisionCount: revisionSet.length,
  };
}

function resultObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedBoolean(value: unknown, section: string, key: string): boolean {
  return resultObject(resultObject(value)[section])[key] === true;
}

function gateChecks(
  context: SubmissionContext,
  artifacts: readonly ArtifactFact[],
  required: readonly { code: string; severity: "hard" | "advisory" }[],
  work: WorkVersionRow,
  prerequisite: StructuredBaselineFact | null,
  g4: G4Facts | null,
  structured: P4GateEvidenceEvaluation | null,
): GateCheckFact[] {
  const byCode = new Map<string, GateCheckFact>();
  const add = (fact: GateCheckFact) => byCode.set(fact.code, fact);
  if (context.gate === "G1" || context.gate === "G2" || context.gate === "G3") {
    for (const check of required) {
      const evaluated = structured?.checks[check.code];
      add({
        code: check.code,
        severity: check.severity,
        passed: evaluated?.passed === true,
        details: evaluated?.details ?? {
          reason: "structured p4 gate evidence is unavailable",
          gate: context.gate,
          workVersionId: work.id,
        },
        evidenceRefs: evaluated?.evidenceRefs ?? [],
      });
    }
  } else if (context.gate === "G4") {
    const approval = g4?.approval;
    const runMap = new Map((g4?.runs ?? []).map((run) => [String(run.operation), run]));
    const allRuns = FORMAL_OPERATIONS.every((operation) => {
      const run = runMap.get(operation);
      const common = resultObject(resultObject(run?.verdicts).common);
      const operationVerdict = operation === "validate_sources"
        ? resultObject(resultObject(run?.verdicts).validation)
        : operation === "simulate"
          ? resultObject(resultObject(run?.verdicts).simulation)
          : operation === "synthesize"
            ? resultObject(resultObject(run?.verdicts).synthesis)
            : resultObject(resultObject(run?.verdicts).implementation);
      return run?.state === "succeeded"
        && run.run_class === "formal"
        && run.binding_version === "formal-input.v1"
        && run.formal_input_approval_id === approval?.id
        && run.input_hash === approval?.input_hash
        && Boolean(run.evidence_manifest_id)
        && common.inputManifest === true
        && common.runScript === true
        && common.stdout === true
        && common.stderr === true
        && common.toolLog === true
        && operationVerdict.determined === true
        && operationVerdict.passed === true;
    });
    const simulation = runMap.get("simulate");
    const implement = runMap.get("implement");
    const simulationPassed = simulation?.state === "succeeded"
      && nestedBoolean(simulation.verdicts, "simulation", "passed")
      && nestedBoolean(simulation.verdicts, "simulation", "determined");
    const implementationPassed = implement?.state === "succeeded"
      && nestedBoolean(implement.verdicts, "implementation", "passed")
      && nestedBoolean(implement.verdicts, "implementation", "determined");
    const drc = resultObject(resultObject(implement?.verdicts)["drc"]);
    const timing = resultObject(resultObject(implement?.verdicts)["timing"]);
    const coveredClocks = Array.isArray(timing.coveredClocks)
      ? timing.coveredClocks.filter((value): value is string => typeof value === "string")
      : [];
    const missingClocks = (g4?.expectedClocks ?? []).filter((clock) => !coveredClocks.includes(clock));
    const constraintsComplete = approval?.constraints_complete === true;
    const categorySet = new Set((g4?.items ?? []).map((item) => item.category));
    const workspaceClean = g4 !== null
      && g4.workspace.pending.length === 0
      && g4.workspace.skippedBinary.length === 0;
    const deliveryComplete = workspaceClean
      && ["rtl", "tb", "constraint", "document", "run_result", "raw_evidence", "confirmation", "source", "bitstream"]
        .every((category) => categorySet.has(category as DeliveryCandidateItem["category"]));
    add(artifactCheck("artifact.rtl", "hard", artifacts, ["RTL_SOURCE_SET"]));
    add(artifactCheck("artifact.testbench", "hard", artifacts, ["TB_SOURCE_SET"]));
    add(artifactCheck("artifact.constraints", "hard", artifacts, ["XDC_CANDIDATE", "CONSTRAINT_DESIGN"]));
    add({ code: "formal_input.confirmed", severity: "hard", passed: approval !== null, details: { formalInputApprovalId: approval?.id ?? null, inputHash: approval?.input_hash ?? null }, evidenceRefs: approval ? [{ type: "formal_input_approval", id: approval.id }] : [] });
    add({ code: "constraints.complete", severity: "hard", passed: constraintsComplete, details: { constraintsComplete }, evidenceRefs: approval ? [{ type: "project_readiness", id: approval.readiness_id }] : [] });
    add({ code: "formal_simulation.succeeded", severity: "hard", passed: simulationPassed, details: { toolRunId: simulation?.id ?? null, verdict: resultObject(simulation?.verdicts)["simulation"] ?? null }, evidenceRefs: simulation ? [{ type: "tool_run", id: simulation.id }] : [] });
    add({ code: "formal_implementation.succeeded", severity: "hard", passed: implementationPassed, details: { toolRunId: implement?.id ?? null, verdict: resultObject(implement?.verdicts)["implementation"] ?? null }, evidenceRefs: implement ? [{ type: "tool_run", id: implement.id }] : [] });
    add({ code: "drc.clean", severity: "hard", passed: drc.determined === true && drc.clean === true && drc.errorCount === 0, details: drc, evidenceRefs: implement ? [{ type: "tool_run_evidence_manifest", id: implement.evidence_manifest_id }] : [] });
    add({ code: "timing.met", severity: "hard", passed: timing.determined === true && timing.met === true && (g4?.expectedClocks.length ?? 0) > 0 && missingClocks.length === 0, details: { ...timing, expectedClocks: g4?.expectedClocks ?? [], missingClocks }, evidenceRefs: implement ? [{ type: "tool_run_evidence_manifest", id: implement.evidence_manifest_id }] : [] });
    add({ code: "evidence.frozen", severity: "hard", passed: allRuns, details: { operations: Object.fromEntries(FORMAL_OPERATIONS.map((operation) => [operation, runMap.get(operation)?.evidence_manifest_id ?? null])) }, evidenceRefs: (g4?.runs ?? []).map((run) => ({ type: "tool_run_evidence_manifest", id: run.evidence_manifest_id })) });
    add({ code: "bitstream.formal", severity: "hard", passed: g4?.bitstream?.class === "formal", details: { bitstreamResultId: g4?.bitstream?.id ?? null, class: g4?.bitstream?.class ?? null }, evidenceRefs: g4?.bitstream ? [{ type: "bitstream_result", id: g4.bitstream.id }] : [] });
    add({
      code: "delivery.manifest_sealed",
      severity: "hard",
      passed: deliveryComplete,
      details: {
        deliveryComplete,
        releaseId: g4?.releaseId ?? null,
        categories: [...categorySet].sort(),
        workspace: g4 ? {
          commit: g4.workspace.commit,
          manifestHash: g4.workspace.manifestHash,
          pending: g4.workspace.pending,
          skippedBinary: g4.workspace.skippedBinary,
        } : null,
        revisionSetHash: g4?.revisionSetHash ?? null,
        revisionCount: g4?.revisionCount ?? 0,
      },
      evidenceRefs: [],
    });
  }
  return required.map((check) => byCode.get(check.code) ?? {
    code: check.code,
    severity: check.severity,
    passed: false,
    details: { reason: "check evaluator has no supported fact mapping", gate: context.gate, workVersionId: work.id, prerequisiteBaselineId: prerequisite?.id ?? null },
    evidenceRefs: [],
  });
}

function sealedDeliveryProjection(
  projectId: string,
  context: SubmissionContext,
  work: WorkVersionRow,
  evaluationId: string,
  g4: G4Facts,
): Record<string, unknown> {
  return {
    schema: "delivery-candidate.v1",
    releaseId: g4.releaseId,
    releaseVersion: g4.releaseVersion,
    supersedesReleaseId: g4.supersedesReleaseId,
    plannedApprovalRecordId: g4.plannedApprovalRecordId,
    projectId,
    processVersionId: "GJB_REF_V1",
    processInstanceId: context.process_instance_id,
    workVersionId: work.id,
    gateSubmissionId: context.id,
    gateEvaluationId: evaluationId,
    snapshotId: context.snapshot_id,
    snapshotManifestHash: context.snapshot_manifest_hash,
    projectWorkspace: {
      commit: g4.workspace.commit,
      manifestHash: g4.workspace.manifestHash,
      pending: g4.workspace.pending,
      skippedBinary: g4.workspace.skippedBinary,
    },
    projectArtifactRevisionSet: {
      hash: g4.revisionSetHash,
      count: g4.revisionCount,
    },
    formalInputApprovalId: g4.approval!.id,
    inputHash: g4.approval!.input_hash,
    readinessId: g4.approval!.readiness_id,
    engineeringConfigHash: g4.approval!.engineering_config_hash,
    prerequisiteBaselineId: g4.approval!.baseline_id,
    targetPart: g4.approval!.target_part,
    toolchainProfileHash: g4.approval!.toolchain_profile_hash,
    formalRuns: g4.runs.map((run) => ({
      operation: run.operation,
      toolRunId: run.id,
      evidenceManifestHash: run.evidence_manifest_hash,
    })),
    bitstreamResultId: g4.bitstream!.id,
    items: g4.items,
  };
}

function evaluationPublic(row: Record<string, unknown>, items: readonly Record<string, unknown>[]): Record<string, unknown> {
  const projection = resultObject(row.sealed_projection);
  const plannedReleaseId = typeof projection.releaseId === "string" ? projection.releaseId : null;
  const plannedReleaseVersion = Number.isSafeInteger(projection.releaseVersion)
    ? projection.releaseVersion as number
    : null;
  const supersedesReleaseId = projection.supersedesReleaseId === null
    ? null
    : typeof projection.supersedesReleaseId === "string"
      ? projection.supersedesReleaseId
      : null;
  return {
    id: row.id,
    project_id: row.project_id,
    work_version_id: row.work_version_id,
    gate_submission_id: row.gate_submission_id,
    snapshot_id: row.snapshot_id,
    snapshot_manifest_hash: row.snapshot_manifest_hash,
    profile_hash: row.profile_hash,
    result_hash: row.result_hash,
    passed: row.passed,
    sealed_projection_hash: row.sealed_projection_hash,
    delivery_release_id: plannedReleaseId,
    delivery_release_version: plannedReleaseVersion,
    supersedes_release_id: supersedesReleaseId,
    evaluated_at: row.evaluated_at,
    items: items.map((item) => ({
      id: item.id,
      check_code: item.check_code,
      severity: item.severity,
      passed: item.passed,
      details: item.details,
      evidence_refs: item.evidence_refs,
    })),
  };
}

async function selectEvaluation(
  query: QueryClient,
  projectId: string,
  evaluationId: string,
): Promise<Record<string, unknown>> {
  const rowResult = await query.query(
    `SELECT ge.*, dr.id AS delivery_release_id
       FROM gate_check_evaluation ge
       LEFT JOIN delivery_release dr
         ON dr.gate_check_evaluation_id = ge.id AND dr.project_id = ge.project_id
      WHERE ge.id = $1 AND ge.project_id = $2`,
    [evaluationId, projectId],
  );
  const row = rowResult.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`gate evaluation not found: ${evaluationId}`);
  const items = await query.query(
    `SELECT id, check_code, severity, passed, details, evidence_refs
       FROM gate_check_item WHERE evaluation_id = $1 AND project_id = $2
      ORDER BY check_code`,
    [evaluationId, projectId],
  );
  return evaluationPublic(row, items.rows as Record<string, unknown>[]);
}

export async function createP4GateEvaluationHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["evaluation_id", "expected_snapshot_manifest_hash", "work_version_id"]);
  const evaluationId = requireId(body.evaluation_id, "evaluation_id");
  const workVersionId = requireId(body.work_version_id, "work_version_id");
  const expectedSnapshotHash = requireHash(body.expected_snapshot_manifest_hash, "expected_snapshot_manifest_hash");
  const { result } = await runIdempotent(ctx, "create_p4_gate_evaluation", projectId, async (tx) => {
    await requireModernProject(tx, projectId);
    const context = await submissionContext(tx, projectId, submissionId, true);
    const work = await activeWorkVersion(tx, projectId, true);
    if (
      !work
      || work.id !== workVersionId
      || work.id !== context.work_version_id
      || work.process_instance_id !== context.process_instance_id
    ) {
      throw conflictApiError("WORK_VERSION_INACTIVE");
    }
    if (work.current_gate !== context.gate || work.state !== "working") {
      throw conflictApiError("GATE_OUT_OF_SEQUENCE", { currentGate: work.current_gate, gate: context.gate, workState: work.state });
    }
    if (context.snapshot_manifest_hash !== expectedSnapshotHash) {
      throw conflictApiError("SNAPSHOT_MANIFEST_CHANGED", { expected: expectedSnapshotHash, actual: context.snapshot_manifest_hash });
    }
    if (context.state === "preparing") {
      await tx.query("UPDATE gate_submission SET state = 'submitted' WHERE id = $1 AND state = 'preparing'", [submissionId]);
      await tx.query("UPDATE gate_submission SET state = 'checking' WHERE id = $1 AND state = 'submitted'", [submissionId]);
    } else if (context.state === "submitted") {
      await tx.query("UPDATE gate_submission SET state = 'checking' WHERE id = $1 AND state = 'submitted'", [submissionId]);
    } else if (context.state !== "checking") {
      throw conflictApiError("GATE_SUBMISSION_NOT_EVALUATABLE", { state: context.state });
    }
    const prior = await tx.query(
      "SELECT id FROM gate_check_evaluation WHERE gate_submission_id = $1 AND project_id = $2",
      [submissionId, projectId],
    );
    if (prior.rows.length > 0) throw conflictApiError("GATE_SUBMISSION_ALREADY_EVALUATED", prior.rows[0]);

    const artifacts = await snapshotArtifacts(tx, projectId, context.member_revision_ids);
    const profileNode = GJB_REF_V1_PROFILE.nodes.find((node) => node.id === context.gate)!;
    const prerequisite = context.gate === "G2" || context.gate === "G3"
      ? await activeStructuredBaseline(tx, projectId, "B0", true)
      : context.gate === "G4"
        ? await activeStructuredBaseline(tx, projectId, "B1", true)
        : null;
    const g4 = context.gate === "G4"
      ? await buildG4Facts(tx, projectId, work, context, evaluationId)
      : null;
    const structured = await structuredGateEvaluation(
      tx,
      projectId,
      context,
      context.gate === "G2" || context.gate === "G3"
        ? prerequisite as StructuredBaselineFact | null
        : null,
    );
    const checks = gateChecks(context, artifacts, profileNode.requiredChecks, work, prerequisite, g4, structured);
    if ((context.gate === "G3" || context.gate === "G4") && prerequisite === null) {
      // The prerequisite is a gate-wide invariant rather than a second profile
      // check. Preserve the exact profile check set while making every hard fact
      // fail closed and explaining the missing baseline.
      for (let index = 0; index < checks.length; index++) {
        checks[index] = {
          ...checks[index]!,
          passed: false,
          details: { ...checks[index]!.details, prerequisiteBaselineMissing: context.gate === "G3" ? "B0" : "B1" },
        };
      }
    }
    const passed = checks.every((check) => check.severity !== "hard" || check.passed);
    const sealedProjection = passed && context.gate === "G4" && g4
      ? sealedDeliveryProjection(projectId, context, work, evaluationId, g4)
      : null;
    const sealedProjectionHash = sealedProjection ? hashPayload(sealedProjection) : null;
    const checkSetHash = hashPayload(profileNode.requiredChecks);
    const inputFactHash = hashPayload({
      snapshotId: context.snapshot_id,
      snapshotManifestHash: context.snapshot_manifest_hash,
      artifacts: artifacts.map((artifact) => ({ id: artifact.revision_id, type: artifact.artifact_type, sha256: artifact.content_hash })),
      prerequisiteBaseline: prerequisite,
      structuredChecks: structured
        ? Object.fromEntries(Object.entries(structured.checks).map(([code, check]) => [code, {
          passed: check.passed,
          factHash: hashPayload(check.details),
        }]))
        : null,
      formalInputApprovalId: g4?.approval?.id ?? null,
      formalRuns: g4?.runs.map((run) => ({ id: run.id, operation: run.operation, state: run.state, evidenceManifestHash: run.evidence_manifest_hash })) ?? [],
      bitstreamResultId: g4?.bitstream?.id ?? null,
      projectWorkspace: g4 ? {
        commit: g4.workspace.commit,
        manifestHash: g4.workspace.manifestHash,
        pending: g4.workspace.pending,
        skippedBinary: g4.workspace.skippedBinary,
      } : null,
      projectArtifactRevisionSet: g4 ? {
        hash: g4.revisionSetHash,
        count: g4.revisionCount,
      } : null,
    });
    const resultHash = hashPayload({
      schema: "gate-evaluation-result.v1",
      projectId,
      processInstanceId: context.process_instance_id,
      workVersionId: work.id,
      gateSubmissionId: submissionId,
      gate: context.gate,
      snapshotManifestHash: context.snapshot_manifest_hash,
      profileHash: GJB_REF_V1_PROFILE.profileHash,
      checks: checks.map((check) => ({ code: check.code, severity: check.severity, passed: check.passed, factHash: hashPayload(check.details) })),
      passed,
      sealedProjectionHash,
    });
    for (const check of checks) {
      await tx.query(
        `INSERT INTO gate_check_item
          (id, project_id, evaluation_id, check_code, check_version,
           severity, passed, status, fact_hash, details, evidence_refs)
         VALUES ($1,$2,$3,$4,'p4-check.v2',$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
        [
          `gci_${sha256Hex(`${evaluationId}:${check.code}`).slice(0, 32)}`,
          projectId,
          evaluationId,
          check.code,
          check.severity,
          check.passed,
          check.passed ? "passed" : "failed",
          hashPayload(check.details),
          JSON.stringify(check.details),
          JSON.stringify(check.evidenceRefs),
        ],
      );
    }
    await tx.query(
      `INSERT INTO gate_check_evaluation
        (id, project_id, process_instance_id, work_version_id,
         gate_submission_id, gate, snapshot_id, profile_hash,
         profile_definition_hash, check_set_hash, snapshot_manifest_hash,
         input_fact_hash, result_hash, passed, state, sealed_projection,
         sealed_projection_hash, evaluated_at, evaluator_version,
         generated_by_type, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,
               $15::jsonb,$16,now(),'p4-core-evaluator.v2','system','synthia-core')`,
      [
        evaluationId,
        projectId,
        context.process_instance_id,
        work.id,
        submissionId,
        context.gate,
        context.snapshot_id,
        GJB_REF_V1_PROFILE.profileHash,
        checkSetHash,
        context.snapshot_manifest_hash,
        inputFactHash,
        resultHash,
        passed,
        passed ? "passed" : "failed",
        sealedProjection ? JSON.stringify(sealedProjection) : null,
        sealedProjectionHash,
      ],
    );

    if (!passed) {
      await tx.query("UPDATE gate_submission SET state = 'rejected' WHERE id = $1 AND state = 'checking'", [submissionId]);
    }
    await appendP4Outbox(tx, ctx, "gate_check_evaluation", evaluationId, "gate.evaluated", {
      evaluationId,
      projectId,
      workVersionId: work.id,
      gateSubmissionId: submissionId,
      gate: context.gate,
      passed,
      resultHash,
      sealedProjectionHash,
      deliveryReleaseId: passed && context.gate === "G4" ? g4?.releaseId : null,
    });
    return selectEvaluation(tx, projectId, evaluationId);
  }, async (tx) => {
    await requireModernProject(tx, projectId);
    await acquireG4ProjectMutationLockForSubmission(
      tx,
      projectId,
      submissionId,
      "g4.evaluate",
    );
    const context = await submissionContext(tx, projectId, submissionId, true);
    const work = await activeWorkVersion(tx, projectId, true);
    if (
      !work
      || work.id !== workVersionId
      || work.id !== context.work_version_id
      || work.process_instance_id !== context.process_instance_id
      || work.current_gate !== context.gate
      || work.state !== "working"
    ) {
      throw conflictApiError("WORK_VERSION_INACTIVE");
    }
    if (context.snapshot_manifest_hash !== expectedSnapshotHash) {
      throw conflictApiError("SNAPSHOT_MANIFEST_CHANGED", {
        expected: expectedSnapshotHash,
        actual: context.snapshot_manifest_hash,
      });
    }
  });
  return { status: 201, data: result };
}

export async function listP4GateEvaluationsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;
  await requireModernProject(ctx.pool, projectId);
  await submissionContext(ctx.pool, projectId, submissionId);
  const { rows } = await ctx.pool.query(
    `SELECT id FROM gate_check_evaluation
      WHERE project_id = $1 AND gate_submission_id = $2
      ORDER BY evaluated_at DESC, id`,
    [projectId, submissionId],
  );
  const data: Record<string, unknown>[] = [];
  for (const row of rows as { id: string }[]) data.push(await selectEvaluation(ctx.pool, projectId, row.id));
  return { status: 200, data };
}

export async function submitP4GateSubmissionHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["check_results_hash", "gate_check_evaluation_id"]);
  const requestedEvaluationId = body.gate_check_evaluation_id === undefined
    ? null
    : requireId(body.gate_check_evaluation_id, "gate_check_evaluation_id");
  const requestedHash = body.check_results_hash === undefined
    ? null
    : requireHash(body.check_results_hash, "check_results_hash");
  const { result } = await runIdempotent(ctx, "submit_p4_gate_submission", projectId, async (tx) => {
    await requireModernProject(tx, projectId);
    const context = await submissionContext(tx, projectId, submissionId, true);
    const work = await activeWorkVersion(tx, projectId, true);
    if (
      !work
      || work.id !== context.work_version_id
      || work.process_instance_id !== context.process_instance_id
      || work.current_gate !== context.gate
    ) {
      throw conflictApiError("GATE_OUT_OF_SEQUENCE");
    }
    if (context.state === "in_review") {
      const existing = await tx.query(
        `SELECT id, result_hash FROM gate_check_evaluation
          WHERE project_id = $1 AND gate_submission_id = $2 AND passed
          ORDER BY evaluated_at DESC LIMIT 1`,
        [projectId, submissionId],
      );
      const evaluation = existing.rows[0] as { id?: string; result_hash?: string } | undefined;
      return { id: submissionId, project_id: projectId, gate: context.gate, state: "in_review", gate_check_evaluation_id: evaluation?.id, check_results_hash: evaluation?.result_hash };
    }
    if (context.state !== "checking") throw conflictApiError("GATE_SUBMISSION_NOT_SUBMITTABLE", { state: context.state });
    const evalResult = await tx.query(
      `SELECT id, result_hash, sealed_projection, sealed_projection_hash
         FROM gate_check_evaluation
        WHERE project_id = $1 AND gate_submission_id = $2 AND work_version_id = $3
          AND snapshot_id = $4 AND passed
        ORDER BY evaluated_at DESC LIMIT 1 FOR UPDATE`,
      [projectId, submissionId, work.id, context.snapshot_id],
    );
    const evaluation = evalResult.rows[0] as Record<string, unknown> | undefined;
    if (!evaluation) throw conflictApiError("PASSED_GATE_EVALUATION_REQUIRED");
    if (requestedEvaluationId && requestedEvaluationId !== evaluation.id) throw conflictApiError("GATE_EVALUATION_MISMATCH");
    if (requestedHash && requestedHash !== evaluation.result_hash) throw conflictApiError("CHECK_RESULTS_HASH_MISMATCH");
    if (context.gate === "G4") {
      if (!evaluation.sealed_projection_hash) throw conflictApiError("G4_SEALED_PROJECTION_REQUIRED");
      const projection = await tx.query(
        `SELECT sealed_projection FROM gate_check_evaluation
          WHERE project_id = $1 AND id = $2 AND sealed_projection_hash = $3`,
        [projectId, evaluation.id, evaluation.sealed_projection_hash],
      );
      if (projection.rows.length === 0) throw conflictApiError("G4_SEALED_PROJECTION_REQUIRED");
      await revalidateEvaluation(tx, projectId, context, work, evaluation);
    }
    const checkItems = await tx.query(
      `SELECT check_code AS code, severity, passed, details
         FROM gate_check_item WHERE project_id = $1 AND evaluation_id = $2
        ORDER BY check_code`,
      [projectId, evaluation.id],
    );
    await tx.query(
      `UPDATE gate_submission SET state = 'in_review', submitted_at = now(),
              check_results = $1::jsonb
        WHERE id = $2 AND project_id = $3 AND state = 'checking'`,
      [JSON.stringify(checkItems.rows), submissionId, projectId],
    );
    if (context.gate === "G4") {
      await tx.query(
        "UPDATE project_work_version SET state = 'in_review' WHERE id = $1 AND project_id = $2 AND state = 'working'",
        [work.id, projectId],
      );
    }
    await appendP4Outbox(tx, ctx, "gate_submission", submissionId, "gate_submission.submitted_for_review", {
      id: submissionId,
      projectId,
      workVersionId: work.id,
      gate: context.gate,
      evaluationId: evaluation.id,
      resultHash: evaluation.result_hash,
    });
    return {
      id: submissionId,
      project_id: projectId,
      gate: context.gate,
      state: "in_review",
      gate_check_evaluation_id: evaluation.id,
      check_results_hash: evaluation.result_hash,
    };
  }, async (tx) => {
    await requireModernProject(tx, projectId);
    await acquireG4ProjectMutationLockForSubmission(
      tx,
      projectId,
      submissionId,
      "g4.submit",
    );
    const context = await submissionContext(tx, projectId, submissionId, true);
    const work = await activeWorkVersion(tx, projectId, true);
    if (
      !work
      || work.id !== context.work_version_id
      || work.process_instance_id !== context.process_instance_id
      || work.current_gate !== context.gate
      || (context.gate === "G4" ? work.state !== "in_review" && work.state !== "working" : work.state !== "working")
      || (context.state !== "checking" && context.state !== "in_review")
    ) {
      throw conflictApiError("GATE_OUT_OF_SEQUENCE");
    }
    if (context.gate === "G4" && context.state === "in_review") {
      const evaluationResult = await tx.query(
        `SELECT id, result_hash, sealed_projection, sealed_projection_hash
           FROM gate_check_evaluation
          WHERE project_id = $1 AND gate_submission_id = $2
            AND work_version_id = $3 AND snapshot_id = $4 AND passed
          ORDER BY evaluated_at DESC LIMIT 1`,
        [projectId, submissionId, work.id, context.snapshot_id],
      );
      const evaluation = evaluationResult.rows[0] as Record<string, unknown> | undefined;
      if (!evaluation) throw conflictApiError("PASSED_GATE_EVALUATION_REQUIRED");
      await revalidateEvaluation(tx, projectId, context, work, evaluation);
    }
  });
  return { status: 200, data: result };
}

// ─── Formal input confirmation ──────────────────────────────────────────────

interface FormalInputAssembly {
  readonly manifest: FormalInputManifestV1;
  readonly preview: Record<string, unknown>;
  readonly snapshotManifestHash: string;
  readonly baselineId: string;
  readonly baselineManifestHash: string;
  readonly readinessId: string;
  readonly engineeringConfigHash: string;
  readonly constraintHash: string;
  readonly toolchainProfileHash: string;
  readonly connectorId: string;
  readonly targetPart: string;
  readonly runtimeActorId: string;
  readonly authorizedTaskId: string;
  readonly managedContents: readonly ManagedFormalInputContent[];
}

interface FormalToolchainBinding {
  readonly connectorId: string;
  readonly profileHash: string;
}

async function discoverFormalToolchain(
  ctx: RequestContext,
  projectId: string,
): Promise<FormalToolchainBinding> {
  const connector = requireConnector(ctx);
  let discovery;
  try {
    discovery = await connector.discover(projectId);
  } catch (error) {
    throw mapP4Error(error);
  }
  if (
    discovery.drift
    || !discovery.toolchainProfileHash
    || !SHA256.test(discovery.toolchainProfileHash)
  ) {
    throw capabilityUnavailableError("FORMAL_TOOLCHAIN_UNAVAILABLE");
  }
  return {
    connectorId: connector.connectorId,
    profileHash: discovery.toolchainProfileHash,
  };
}

interface ManagedFormalInputContent {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
  readonly text: string;
}

async function formalArtifactContent(
  projectId: string,
  path: string,
  row: { readonly content_location: string; readonly content: string | null; readonly content_hash: string },
): Promise<ManagedFormalInputContent> {
  let bytes: Uint8Array;
  try {
    const archived = await readRegularFileAtLocation(projectId, row.content_location);
    if (archived !== null) bytes = archived;
    else if (row.content !== null) bytes = new TextEncoder().encode(row.content);
    else {
      throw conflictApiError("FORMAL_INPUT_CONTENT_UNAVAILABLE", {
        contentLocation: row.content_location,
        expectedSha256: row.content_hash,
      });
    }
  } catch (error) {
    throw mapP4Error(error);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw conflictApiError("FORMAL_INPUT_TEXT_REQUIRED", { path });
  }
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== row.content_hash) {
    throw conflictApiError("FORMAL_INPUT_CONTENT_UNAVAILABLE", {
      contentLocation: row.content_location,
      expectedSha256: row.content_hash,
      actualSha256,
    });
  }
  try {
    validateFormalInputContent(path, text);
  } catch (error) {
    throw mapP4Error(error);
  }
  return { path, sha256: actualSha256, sizeBytes: bytes.byteLength, bytes, text };
}

async function materializeFormalContents(
  query: QueryClient,
  projectId: string,
  contents: readonly ManagedFormalInputContent[],
): Promise<void> {
  for (const content of contents) {
    await query.query(
      `INSERT INTO formal_input_content
        (project_id, sha256, size_bytes, managed_content)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, sha256) DO NOTHING`,
      [projectId, content.sha256, content.sizeBytes, Buffer.from(content.bytes)],
    );
    const stored = await query.query(
      `SELECT size_bytes, encode(digest(managed_content, 'sha256'), 'hex') AS actual_sha256
         FROM formal_input_content
        WHERE project_id = $1 AND sha256 = $2`,
      [projectId, content.sha256],
    );
    const row = stored.rows[0] as { size_bytes?: string | number; actual_sha256?: string } | undefined;
    if (
      !row
      || numberValue(row.size_bytes) !== content.sizeBytes
      || row.actual_sha256 !== content.sha256
    ) {
      throw conflictApiError("FORMAL_INPUT_MANAGED_CONTENT_DIVERGED", { path: content.path });
    }
  }
}

async function managedFormalContentBytes(
  query: QueryClient,
  projectId: string,
  sha256: string,
  expectedSize?: number,
): Promise<Uint8Array> {
  const result = await query.query(
    `SELECT size_bytes, managed_content
       FROM formal_input_content
      WHERE project_id = $1 AND sha256 = $2`,
    [projectId, sha256],
  );
  const row = result.rows[0] as {
    size_bytes?: string | number;
    managed_content?: Uint8Array;
  } | undefined;
  if (
    !row?.managed_content
    || (expectedSize !== undefined && numberValue(row.size_bytes) !== expectedSize)
    || sha256Hex(row.managed_content) !== sha256
  ) {
    throw conflictApiError("FORMAL_INPUT_CONTENT_UNAVAILABLE", { sha256 });
  }
  return row.managed_content;
}

async function assembleFormalInput(
  query: QueryClient,
  ctx: RequestContext,
  input: {
    readonly workVersionId: string;
    readonly snapshotId: string;
    readonly readinessId: string;
    readonly authorizedTaskId: string;
  },
  toolchain: FormalToolchainBinding,
): Promise<FormalInputAssembly> {
  const projectId = ctx.params.projectId!;
  const project = await requireModernProject(query, projectId);
  const work = await activeWorkVersion(query, projectId, true);
  if (!work || work.id !== input.workVersionId || work.state !== "working") {
    throw conflictApiError("WORK_VERSION_INACTIVE");
  }
  if (work.current_gate !== "G4") {
    throw conflictApiError("FORMAL_INPUT_G4_REQUIRED", { currentGate: work.current_gate });
  }

  const workspace = await collectWorkspaceFacts(projectId);
  if (workspace.pending.length > 0 || workspace.skippedBinary.length > 0) {
    throw conflictApiError("FORMAL_INPUT_WORKSPACE_NOT_CLEAN", {
      pending: workspace.pending,
      skippedBinary: workspace.skippedBinary,
    });
  }

  const snapshotResult = await query.query(
    `SELECT id, manifest_hash, member_revision_ids, gate_profile_version,
            work_version_id
       FROM configuration_snapshot
      WHERE id = $1 AND project_id = $2`,
    [input.snapshotId, projectId],
  );
  const snapshot = snapshotResult.rows[0] as {
    id: string;
    manifest_hash: string;
    member_revision_ids: string[];
    gate_profile_version: string;
    work_version_id: string | null;
  } | undefined;
  if (!snapshot) throw notFoundError(`snapshot not found: ${input.snapshotId}`);
  if (snapshot.gate_profile_version !== "GJB_REF_V1") {
    throw conflictApiError("SNAPSHOT_PROFILE_MISMATCH");
  }
  if (snapshot.work_version_id !== work.id) {
    throw conflictApiError("SNAPSHOT_WORK_VERSION_MISMATCH", {
      expected: work.id,
      actual: snapshot.work_version_id,
    });
  }

  const readinessResult = await query.query(
    `SELECT id, work_version_id, process_instance_id, engineering_config,
            engineering_config_hash, result_hash, state, confirmed_by,
            workspace_commit, workspace_manifest_hash,
            workspace_ready, data_scope_recorded, source_materials_recorded,
            pin_constraints_complete, electrical_constraints_complete,
            clock_constraints_complete, constraint_revision_ids,
            toolchain_profile_hash, target_part, board_ref
       FROM project_readiness
      WHERE id = $1 AND project_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM project_readiness newer
           WHERE newer.project_id = project_readiness.project_id
             AND newer.work_version_id = project_readiness.work_version_id
             AND newer.sequence > project_readiness.sequence
        )`,
    [input.readinessId, projectId],
  );
  const readiness = readinessResult.rows[0] as Record<string, unknown> | undefined;
  if (!readiness) throw notFoundError(`readiness not found: ${input.readinessId}`);
  if (
    readiness.workspace_commit !== workspace.commit
    || readiness.workspace_manifest_hash !== workspace.manifestHash
  ) {
    throw conflictApiError("FORMAL_INPUT_READINESS_WORKSPACE_CHANGED", {
      expectedCommit: readiness.workspace_commit,
      actualCommit: workspace.commit,
      expectedManifestHash: readiness.workspace_manifest_hash,
      actualManifestHash: workspace.manifestHash,
    });
  }
  const constraintsComplete = readiness.pin_constraints_complete === true
    && readiness.electrical_constraints_complete === true
    && readiness.clock_constraints_complete === true;
  if (
    readiness.work_version_id !== work.id
    || readiness.process_instance_id !== work.process_instance_id
    || readiness.state !== "ready"
    || readiness.confirmed_by === null
    || readiness.workspace_ready !== true
    || readiness.data_scope_recorded !== true
    || readiness.source_materials_recorded !== true
    || !constraintsComplete
    || typeof readiness.target_part !== "string"
    || typeof readiness.board_ref !== "string"
  ) {
    throw conflictApiError("FORMAL_INPUT_COMPLETE_READINESS_REQUIRED");
  }
  let config;
  try {
    config = parseEngineeringConfig(readiness.engineering_config);
  } catch (error) {
    throw mapP4Error(error);
  }
  const configFacts = engineeringConfigFacts(config);
  if (
    configFacts.configHash !== readiness.engineering_config_hash
    || !configFacts.constraintsComplete
    || config.targetPart.value !== readiness.target_part
    || config.board.ref !== readiness.board_ref
  ) {
    throw conflictApiError("FORMAL_INPUT_READINESS_HASH_MISMATCH");
  }

  const baselineResult = await query.query(
    `SELECT b.id, b.manifest_hash, b.state::text, agr.gate::text
       FROM baseline b
       JOIN approved_gate_result agr
         ON agr.id = b.approved_gate_result_id AND agr.project_id = b.project_id
      WHERE b.project_id = $1 AND b.kind = 'B1' AND b.state = 'active'
      ORDER BY b.created_at DESC, b.id DESC LIMIT 1 FOR UPDATE OF b`,
    [projectId],
  );
  const baseline = baselineResult.rows[0] as {
    id: string;
    manifest_hash: string;
    state: string;
    gate: string;
  } | undefined;
  if (!baseline || baseline.gate !== "G3") {
    throw conflictApiError("FORMAL_INPUT_ACTIVE_B1_REQUIRED");
  }

  const taskResult = await query.query(
    `SELECT id, runtime_actor_id
       FROM agent_task
      WHERE id = $1 AND project_id = $2 AND project_type = 'engineering'
        AND kind = 'main' AND agent_role = 'project' AND process_instance_id = $3
        AND status IN ('queued','running','awaiting_user')`,
    [input.authorizedTaskId, projectId, work.process_instance_id],
  );
  const task = taskResult.rows[0] as { id: string; runtime_actor_id: string } | undefined;
  if (!task) throw conflictApiError("FORMAL_INPUT_ACTIVE_MAIN_TASK_REQUIRED");

  const toolchainProfileHash = toolchain.profileHash;
  if (
    readiness.toolchain_profile_hash !== toolchainProfileHash
    || project.toolchain_profile_ref !== toolchainProfileHash
  ) {
    throw conflictApiError("FORMAL_TOOLCHAIN_CHANGED", {
      projectToolchainProfileHash: project.toolchain_profile_ref,
      readinessToolchainProfileHash: readiness.toolchain_profile_hash,
      discoveredToolchainProfileHash: toolchainProfileHash,
    });
  }
  if (project.target_part !== readiness.target_part) {
    throw conflictApiError("FORMAL_TARGET_PART_CHANGED", {
      projectTargetPart: project.target_part,
      readinessTargetPart: readiness.target_part,
    });
  }

  const members = snapshot.member_revision_ids;
  if (members.length === 0 || new Set(members).size !== members.length) {
    throw conflictApiError("FORMAL_INPUT_SNAPSHOT_MEMBERS_INVALID");
  }
  const revisionResult = await query.query(
    `SELECT ar.id, ar.content_hash, ar.content_location, ar.content,
            a.artifact_type
       FROM artifact_revision ar
       JOIN artifact a ON a.id = ar.artifact_id AND a.project_id = ar.project_id
      WHERE ar.project_id = $1 AND ar.id = ANY($2::text[])
      ORDER BY ar.id`,
    [projectId, members],
  );
  if (revisionResult.rows.length !== members.length) {
    throw conflictApiError("FORMAL_INPUT_SNAPSHOT_MEMBERS_INVALID");
  }
  const files: FormalInputFileV1[] = [];
  const managedContents: ManagedFormalInputContent[] = [];
  for (const raw of revisionResult.rows as Array<{
    id: string;
    content_hash: string;
    content_location: string;
    content: string | null;
    artifact_type: string;
  }>) {
    let path: string;
    try {
      path = formalPath(raw.content_location);
    } catch (error) {
      throw mapP4Error(error);
    }
    const content = await formalArtifactContent(projectId, path, raw);
    managedContents.push(content);
    files.push({
      revision_id: raw.id,
      path,
      role: formalRoleForArtifactType(raw.artifact_type),
      sha256: raw.content_hash,
      size_bytes: content.sizeBytes,
      storage_uri: `content://sha256/${raw.content_hash}`,
    });
  }
  if (new Set(files.map((file) => file.revision_id)).size !== files.length) {
    throw conflictApiError("FORMAL_INPUT_REVISION_DUPLICATED");
  }
  const constraintIds = new Set(configFacts.constraintRevisionIds);
  if (
    constraintIds.size === 0
    || [...constraintIds].some((id) => !files.some((file) => file.revision_id === id && file.role === "constraint"))
  ) {
    throw conflictApiError("FORMAL_INPUT_CONSTRAINT_BINDING_INVALID");
  }

  let manifest: FormalInputManifestV1;
  try {
    manifest = buildFormalInputManifest({
      projectId,
      workVersionId: work.id,
      configurationSnapshot: { id: snapshot.id, manifestHash: snapshot.manifest_hash },
      prerequisiteBaseline: { id: baseline.id, kind: "B1", manifestHash: baseline.manifest_hash },
      readiness: { id: String(readiness.id), engineeringConfigHash: String(readiness.engineering_config_hash) },
      targetPart: String(readiness.target_part),
      toolchain: { connectorId: toolchain.connectorId, profileHash: toolchainProfileHash },
      files,
    });
  } catch (error) {
    throw mapP4Error(error);
  }
  const preview = buildFormalPreview({
    manifest,
    readinessId: String(readiness.id),
    authorizedTaskId: task.id,
    toolchainProfileHash,
    constraintsComplete,
  });
  return {
    manifest,
    preview,
    snapshotManifestHash: snapshot.manifest_hash,
    baselineId: baseline.id,
    baselineManifestHash: baseline.manifest_hash,
    readinessId: String(readiness.id),
    engineeringConfigHash: String(readiness.engineering_config_hash),
    constraintHash: configFacts.constraintHash,
    toolchainProfileHash,
    connectorId: toolchain.connectorId,
    targetPart: String(readiness.target_part),
    runtimeActorId: task.runtime_actor_id,
    authorizedTaskId: task.id,
    managedContents,
  };
}

async function selectFormalInputApproval(
  query: QueryClient,
  projectId: string,
  approvalId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await query.query(
    `SELECT id, project_id, work_version_id, snapshot_id, readiness_id,
            baseline_id, toolchain_profile_hash, constraints_complete,
            authorized_task_id, input_manifest, input_hash, preview_hash,
            confirmed_by, confirmed_at
       FROM formal_input_approval
      WHERE id = $1 AND project_id = $2`,
    [approvalId, projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`formal input approval not found: ${approvalId}`);
  const manifest = row.input_manifest as FormalInputManifestV1;
  const preview = buildFormalPreview({
    manifest,
    readinessId: String(row.readiness_id),
    authorizedTaskId: String(row.authorized_task_id),
    toolchainProfileHash: String(row.toolchain_profile_hash),
    constraintsComplete: row.constraints_complete === true,
  });
  if (preview.input_hash !== row.input_hash || preview.preview_hash !== row.preview_hash) {
    throw conflictApiError("FORMAL_INPUT_APPROVAL_HASH_MISMATCH");
  }
  return {
    ...preview,
    id: row.id,
    confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at,
  };
}

export async function previewP4FormalInputHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["authorized_task_id", "readiness_id", "snapshot_id", "work_version_id"]);
  const input = {
    workVersionId: requireId(body.work_version_id, "work_version_id"),
    snapshotId: requireId(body.snapshot_id, "snapshot_id"),
    readinessId: requireId(body.readiness_id, "readiness_id"),
    authorizedTaskId: requireId(body.authorized_task_id, "authorized_task_id"),
  };
  const toolchain = await discoverFormalToolchain(ctx, ctx.params.projectId!);
  const conn = await ctx.pool.connect();
  try {
    await conn.query("BEGIN");
    const assembled = await assembleFormalInput(
      conn as unknown as TransactionClient,
      ctx,
      input,
      toolchain,
    );
    // Preview is deliberately side-effect free. Confirmation reassembles the
    // same facts, verifies preview_hash, then writes every content blob before
    // inserting/updating the human confirmation in that one transaction.
    await conn.query("ROLLBACK");
    return { status: 200, data: assembled.preview };
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw mapP4Error(error);
  } finally {
    conn.release();
  }
}

export async function confirmP4FormalInputHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["authorized_task_id", "id", "preview_hash", "purpose", "readiness_id", "snapshot_id", "work_version_id"]);
  const id = requireId(body.id, "id");
  const purpose = requireString(body, "purpose");
  if (purpose !== "g4_delivery") throw validationError("purpose must be g4_delivery");
  const previewHash = requireHash(body.preview_hash, "preview_hash");
  const input = {
    workVersionId: requireId(body.work_version_id, "work_version_id"),
    snapshotId: requireId(body.snapshot_id, "snapshot_id"),
    readinessId: requireId(body.readiness_id, "readiness_id"),
    authorizedTaskId: requireId(body.authorized_task_id, "authorized_task_id"),
  };
  // Connector discovery is a network operation and must never run while the
  // project mutation lock is held. The locked transaction below re-reads the
  // project/readiness facts and requires them to match this discovered hash.
  const toolchain = await discoverFormalToolchain(ctx, projectId);
  let assembledForTransaction: FormalInputAssembly | null = null;
  const { result } = await runP4SessionLockedIdempotent(
    ctx,
    projectId,
    "formal-input.confirm",
    "confirm_p4_formal_input",
    async (tx) => {
      await requireHumanProjectRole(tx, ctx);
      const assembled = assembledForTransaction;
      if (!assembled) throw internalError("FORMAL_INPUT_ASSEMBLY_MISSING");
      await materializeFormalContents(tx, projectId, assembled.managedContents);
      await tx.query(
        `INSERT INTO formal_input_approval
          (id, project_id, process_instance_id, work_version_id, snapshot_id,
           baseline_id, readiness_id, manifest_hash, input_hash,
           engineering_config_hash, baseline_manifest_hash,
           toolchain_profile_hash, connector_id, target_part, constraint_hash,
           constraints_complete, purpose, target_gate, allowed_operations,
           authorized_task_id, runtime_actor_id, input_manifest, preview_hash,
           authoritative_inputs, generated_by_type, generated_by)
         SELECT $1,$2,w.process_instance_id,w.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                true,'g4_delivery','G4',$14,$15,$16,$17::jsonb,$18,$19::jsonb,
                'system','synthia-core'
           FROM project_work_version w
          WHERE w.id = $20 AND w.project_id = $2 AND w.state = 'working'`,
        [
          id,
          projectId,
          input.snapshotId,
          assembled.baselineId,
          assembled.readinessId,
          assembled.snapshotManifestHash,
          assembled.preview.input_hash,
          assembled.engineeringConfigHash,
          assembled.baselineManifestHash,
          assembled.toolchainProfileHash,
          assembled.connectorId,
          assembled.targetPart,
          assembled.constraintHash,
          FORMAL_OPERATIONS,
          assembled.authorizedTaskId,
          assembled.runtimeActorId,
          JSON.stringify(assembled.manifest),
          previewHash,
          JSON.stringify(assembled.manifest.files),
          input.workVersionId,
        ],
      );
      await tx.query(
        `UPDATE formal_input_approval
            SET confirmed_by = $1, confirmed_at = now()
          WHERE id = $2 AND project_id = $3 AND confirmed_by IS NULL`,
        [ctx.identity.actorId, id, projectId],
      );
      await appendP4Outbox(tx, ctx, "formal_input_approval", id, "formal_input.confirmed", {
        id,
        projectId,
        workVersionId: input.workVersionId,
        inputHash: assembled.preview.input_hash,
        previewHash,
        confirmedBy: ctx.identity.actorId,
      });
      return selectFormalInputApproval(tx, projectId, id);
    },
    async (tx) => {
      await requireModernProject(tx, projectId);
      await requireHumanProjectRole(tx, ctx);
      const work = await activeWorkVersion(tx, projectId, true);
      if (!work || work.id !== input.workVersionId) throw conflictApiError("WORK_VERSION_INACTIVE");
      const assembled = await assembleFormalInput(tx, ctx, input, toolchain);
      if (assembled.preview.preview_hash !== previewHash) {
        throw conflictApiError("FORMAL_INPUT_PREVIEW_CHANGED", {
          expected: previewHash,
          actual: assembled.preview.preview_hash,
        });
      }
      assembledForTransaction = assembled;
    },
  );
  return { status: 201, data: result };
}

export async function getP4FormalInputApprovalHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  return {
    status: 200,
    data: await selectFormalInputApproval(ctx.pool, projectId, ctx.params.formalInputApprovalId!),
  };
}

// ─── Formal jobs ────────────────────────────────────────────────────────────

interface LiveFormalApprovalRow extends Record<string, unknown> {
  readonly id: string;
  readonly work_version_id: string;
  readonly process_instance_id: string;
  readonly snapshot_id: string;
  readonly manifest_hash: string;
  readonly input_hash: string;
  readonly input_manifest: FormalInputManifestV1;
  readonly baseline_id: string;
  readonly approved_gate_result_id: string;
  readonly readiness_id: string;
  readonly engineering_config_hash: string;
  readonly baseline_manifest_hash: string;
  readonly toolchain_profile_hash: string;
  readonly connector_id: string;
  readonly target_part: string;
  readonly constraint_hash: string;
  readonly constraints_complete: boolean;
  readonly allowed_operations: string[];
  readonly authorized_task_id: string;
  readonly runtime_actor_id: string;
  readonly confirmed_by: string;
}

async function liveFormalApproval(
  query: QueryClient,
  projectId: string,
  approvalId: string,
  lock = false,
): Promise<LiveFormalApprovalRow> {
  const { rows } = await query.query(
    `SELECT f.*, b.approved_gate_result_id
       FROM formal_input_approval f
       JOIN project_work_version w ON w.id = f.work_version_id AND w.project_id = f.project_id
       JOIN baseline b ON b.id = f.baseline_id AND b.project_id = f.project_id
       JOIN project_readiness r ON r.id = f.readiness_id AND r.project_id = f.project_id
       JOIN configuration_snapshot s ON s.id = f.snapshot_id AND s.project_id = f.project_id
       JOIN project p ON p.id = f.project_id
      WHERE f.id = $1 AND f.project_id = $2
        AND f.confirmed_by IS NOT NULL
        AND w.state IN ('working','in_review') AND w.current_gate = 'G4'
        AND b.kind = 'B1' AND b.state = 'active'
        AND b.manifest_hash = f.baseline_manifest_hash
        AND s.manifest_hash = f.manifest_hash
        AND r.work_version_id = f.work_version_id
        AND r.process_instance_id = f.process_instance_id
        AND r.state = 'ready' AND r.confirmed_by IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM project_readiness newer
           WHERE newer.project_id = r.project_id
             AND newer.work_version_id = r.work_version_id
             AND newer.sequence > r.sequence
        )
        AND r.engineering_config_hash = f.engineering_config_hash
        AND r.toolchain_profile_hash = f.toolchain_profile_hash
        AND r.target_part = f.target_part
        AND r.pin_constraints_complete AND r.electrical_constraints_complete
        AND r.clock_constraints_complete
        AND p.process_version_id = 'GJB_REF_V1'
        AND p.toolchain_profile_ref = f.toolchain_profile_hash
        AND p.target_part = f.target_part${lock ? " FOR UPDATE OF w, b" : ""}`,
    [approvalId, projectId],
  );
  const row = rows[0] as LiveFormalApprovalRow | undefined;
  if (!row) throw conflictApiError("FORMAL_INPUT_APPROVAL_INACTIVE", { approvalId });
  if (hashPayload(row.input_manifest) !== row.input_hash) {
    throw conflictApiError("FORMAL_INPUT_APPROVAL_HASH_MISMATCH");
  }
  return row;
}

async function authorizeFormalSubmitter(
  query: QueryClient,
  ctx: RequestContext,
  approval: LiveFormalApprovalRow,
): Promise<void> {
  if (ctx.identity.actorType === "human") {
    if (ctx.identity.actorId !== approval.confirmed_by) {
      throw forbiddenError("FORMAL_INPUT_CONFIRMING_HUMAN_REQUIRED");
    }
    await requireHumanProjectRole(query, ctx);
    return;
  }
  if (
    ctx.identity.scopes.length !== 1
    || ctx.identity.scopes[0] !== "core:task-runtime"
  ) {
    throw forbiddenError("FORMAL_INPUT_BOUND_RUNTIME_REQUIRED");
  }
  if (ctx.identity.actorId !== approval.runtime_actor_id) {
    throw forbiddenError("FORMAL_INPUT_BOUND_RUNTIME_REQUIRED");
  }
  if (ctx.request.headers.get("x-synthia-task-id") !== approval.authorized_task_id) {
    throw forbiddenError("FORMAL_INPUT_BOUND_RUNTIME_REQUIRED");
  }
  const task = await query.query(
    `SELECT 1 FROM agent_task
      WHERE id = $1 AND project_id = $2 AND kind = 'main'
        AND agent_role = 'project'
        AND runtime_actor_id = $3 AND status IN ('queued','running','awaiting_user','failed','cancelled','fail_closed')`,
    [approval.authorized_task_id, ctx.params.projectId!, ctx.identity.actorId],
  );
  if (task.rows.length === 0) throw forbiddenError("FORMAL_INPUT_BOUND_RUNTIME_REQUIRED");
}

function moduleNames(content: string): readonly string[] {
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");
  return [...clean.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g)].map((match) => match[1]!);
}

function oneModule(files: readonly SourceInput[], label: string): string {
  const names = [...new Set(files.flatMap((file) => moduleNames(file.content)))].sort();
  if (names.length !== 1) {
    throw conflictApiError("FORMAL_INPUT_MODULE_AMBIGUOUS", { label, modules: names });
  }
  return names[0]!;
}

async function formalJobParameters(
  query: QueryClient,
  projectId: string,
  approval: LiveFormalApprovalRow,
): Promise<{
  readonly sources: SourceInput[];
  readonly constraints: SourceInput[];
  readonly top: string;
  readonly testbench: string;
}> {
  const manifest = approval.input_manifest;
  const hashes = [...new Set(manifest.files.map((file) => file.sha256))];
  const stored = await query.query(
    `SELECT sha256, size_bytes, managed_content
       FROM formal_input_content
      WHERE project_id = $1 AND sha256 = ANY($2::text[])`,
    [projectId, hashes],
  );
  const byHash = new Map((stored.rows as Array<{
    sha256: string;
    size_bytes: string | number;
    managed_content: Uint8Array;
  }>).map((row) => [row.sha256, row]));
  const rtl: SourceInput[] = [];
  const tb: SourceInput[] = [];
  const constraints: SourceInput[] = [];
  for (const file of manifest.files) {
    if (file.role === "document") continue;
    const contentRow = byHash.get(file.sha256);
    const expectedUri = `content://sha256/${file.sha256}`;
    if (
      !contentRow
      || numberValue(contentRow.size_bytes) !== file.size_bytes
      || file.storage_uri !== expectedUri
      || sha256Hex(contentRow.managed_content) !== file.sha256
    ) {
      throw conflictApiError("FORMAL_INPUT_CONTENT_UNAVAILABLE", {
        revisionId: file.revision_id,
        sha256: file.sha256,
      });
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contentRow.managed_content);
    } catch {
      throw conflictApiError("FORMAL_INPUT_TEXT_REQUIRED", { path: file.path });
    }
    const input: SourceInput = {
      path: file.path,
      content,
      mediaType: file.path.toLowerCase().endsWith(".sv") ? "text/systemverilog" : "text/verilog",
    };
    if (file.role === "rtl") rtl.push(input);
    else if (file.role === "tb") tb.push(input);
    else constraints.push({ ...input, mediaType: "text/plain" });
  }
  if (rtl.length === 0 || tb.length === 0 || constraints.length === 0) {
    throw conflictApiError("FORMAL_INPUT_ARTIFACT_SET_INCOMPLETE");
  }
  return {
    sources: [...rtl, ...tb],
    constraints,
    top: oneModule(rtl, "rtl top"),
    testbench: oneModule(tb, "testbench"),
  };
}

function formalJobPublic(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    jobId: row.id,
    state: row.state,
    operation: row.operation,
    runClass: "formal",
    formalInputApprovalId: row.formal_input_approval_id,
    inputSnapshotId: row.input_snapshot_id,
    inputHash: row.input_hash,
    toolchainProfileHash: row.toolchain_profile_hash,
  };
  if (row.error_code !== null && row.error_code !== undefined) result.errorCode = row.error_code;
  if (row.output_sha256 !== null && row.output_sha256 !== undefined) result.outputSha256 = row.output_sha256;
  return result;
}

async function selectFormalJob(query: QueryClient, projectId: string, jobId: string): Promise<Record<string, unknown>> {
  const { rows } = await query.query(
    `SELECT id, state::text, operation, run_class::text,
            formal_input_approval_id, input_snapshot_id, input_hash,
            toolchain_profile_hash, error_code, output_sha256
       FROM tool_run
      WHERE id = $1 AND project_id = $2 AND binding_version = 'formal-input.v1'`,
    [jobId, projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`formal job not found: ${jobId}`);
  return formalJobPublic(row);
}

export async function submitP4FormalJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["formal_input_approval_id", "operation", "run_class_intent"]);
  if (body.run_class_intent !== "formal") throw validationError("run_class_intent must be formal");
  if (!FORMAL_OPERATIONS.includes(body.operation as FormalOperation)) {
    throw validationError(`operation must be one of: ${FORMAL_OPERATIONS.join(", ")}`);
  }
  const operation = body.operation as FormalOperation;
  const approvalId = requireId(body.formal_input_approval_id, "formal_input_approval_id");
  const connector = requireConnector(ctx);
  const formalExecutionKey = `${projectId}\0${approvalId}\0${operation}`;
  const formalExecutionDigest = sha256Hex(formalExecutionKey);
  const jobId = `job_${formalExecutionDigest.slice(0, 48)}`;
  const downstreamCorrelationId = `p4_${sha256Hex(`correlation\0${formalExecutionKey}`).slice(0, 48)}`;
  const { result } = await runIdempotent(
    ctx,
    "submit_p4_formal_job",
    projectId,
    async (tx) => {
      const approval = await liveFormalApproval(tx, projectId, approvalId, true);
      await authorizeFormalSubmitter(tx, ctx, approval);
      if (!approval.allowed_operations.includes(operation)) {
        throw conflictApiError("FORMAL_OPERATION_NOT_APPROVED");
      }
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`p4-formal-job:${formalExecutionDigest}`]);
      const attached = await tx.query(
        `SELECT id FROM tool_run
          WHERE project_id = $1 AND formal_input_approval_id = $2
            AND operation = $3 AND binding_version = 'formal-input.v1'
          LIMIT 1 FOR UPDATE`,
        [projectId, approvalId, operation],
      );
      const attachedId = (attached.rows[0] as { id?: string } | undefined)?.id;
      if (attachedId) {
        if (attachedId !== jobId) throw conflictApiError("FORMAL_JOB_IDENTITY_DIVERGED");
        return selectFormalJob(tx, projectId, attachedId);
      }
      let discovery;
      try {
        discovery = await connector.discover(projectId);
      } catch (error) {
        throw mapP4Error(error);
      }
      if (
        discovery.drift
        || discovery.toolchainProfileHash !== approval.toolchain_profile_hash
        || connector.connectorId !== approval.connector_id
      ) {
        throw conflictApiError("FORMAL_TOOLCHAIN_CHANGED");
      }
      const inputs = await formalJobParameters(tx, projectId, approval);
      const parameters = {
        sources: inputs.sources,
        constraints: operation === "implement" ? inputs.constraints : [],
        top: inputs.top,
        testbench: operation === "simulate" ? inputs.testbench : undefined,
        part: operation === "synthesize" || operation === "implement" ? approval.target_part : undefined,
      };
      const capability = discovery.capabilities.find((item) => item.operation === operation);
      if (!capability || !capability.runClasses.includes("formal")) {
        throw capabilityUnavailableError("FORMAL_CAPABILITY_UNAVAILABLE", { operation });
      }
      await tx.query(
        `INSERT INTO tool_run
          (id, project_id, operation, capability_version, run_class, state,
           input_snapshot_id, input_manifest_hash, authorization_context,
           toolchain_profile_hash, connector_id, parameters, correlation_id,
           formal_input_approval_id, submitted_by_type, submitted_by,
           input_hash, binding_version)
         VALUES ($1,$2,$3,$4,'formal','submitted',$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,
                 $12,$13,$14,$15,'formal-input.v1')`,
        [
          jobId,
          projectId,
          operation,
          capability.version,
          approval.snapshot_id,
          approval.manifest_hash,
          JSON.stringify({ formalInputApprovalId: approval.id, baselineId: approval.baseline_id }),
          approval.toolchain_profile_hash,
          connector.connectorId,
          JSON.stringify({ operation, jobId, projectId, runClass: "formal", ...parameters }),
          downstreamCorrelationId,
          approval.id,
          ctx.identity.actorType,
          ctx.identity.actorId,
          approval.input_hash,
        ],
      );
      await appendP4Outbox(tx, ctx, "tool_run", jobId, "tool_run.submitted", {
        jobId,
        projectId,
        operation,
        runClass: "formal",
        formalInputApprovalId: approval.id,
        inputHash: approval.input_hash,
      });
      try {
        const remote = await connector.submitJob({
          jobId,
          projectId,
          operation,
          runClass: "formal",
          idempotencyKey: `p4-formal:${projectId}:${approval.id}:${operation}`,
          correlationId: downstreamCorrelationId,
          inputHash: approval.input_hash,
          toolchainProfileHash: approval.toolchain_profile_hash,
          actor: { actorType: ctx.identity.actorType, actorId: ctx.identity.actorId },
          parameters,
          approval: {
            baselineId: approval.baseline_id,
            approvedGateResultId: approval.approved_gate_result_id,
          },
        });
        if (remote.jobId !== jobId) throw conflictApiError("CONNECTOR_JOB_BINDING_MISMATCH");
      } catch (error) {
        throw mapP4Error(error);
      }
      return selectFormalJob(tx, projectId, jobId);
    },
    async (tx) => {
      await requireModernProject(tx, projectId);
      const approval = await liveFormalApproval(tx, projectId, approvalId, true);
      await authorizeFormalSubmitter(tx, ctx, approval);
    },
  );
  return { status: 201, data: result };
}

export async function getP4FormalJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const jobId = ctx.params.jobId!;
  await requireModernProject(ctx.pool, projectId);
  const existing = await selectFormalJob(ctx.pool, projectId, jobId);
  // When P4 is disabled, historical facts remain readable but GET must be a
  // pure Core read: do not require/contact Connector and do not mutate ToolRun.
  if (ctx.featureFlags?.formalDelivery !== true) {
    return { status: 200, data: existing };
  }
  const connector = requireConnector(ctx);
  let remote;
  try {
    remote = await connector.queryStatus(projectId, jobId);
  } catch (error) {
    throw mapP4Error(error);
  }
  const terminal = TERMINAL_RUN_STATES.has(remote.state);
  await ctx.pool.query(
    `UPDATE tool_run SET state = $1, error_code = $2, output_sha256 = $3,
            end_time = CASE WHEN $4::boolean AND end_time IS NULL THEN now() ELSE end_time END
      WHERE id = $5 AND project_id = $6 AND binding_version = 'formal-input.v1'`,
    [remote.state, remote.errorCode ?? null, remote.outputSha256 ?? null, terminal, jobId, projectId],
  );
  return { status: 200, data: { ...existing, ...formalJobPublic({
    id: jobId,
    state: remote.state,
    operation: existing.operation,
    formal_input_approval_id: existing.formalInputApprovalId,
    input_snapshot_id: existing.inputSnapshotId,
    input_hash: existing.inputHash,
    toolchain_profile_hash: existing.toolchainProfileHash,
    error_code: remote.errorCode ?? null,
    output_sha256: remote.outputSha256 ?? null,
  }) } };
}

// ─── Frozen evidence and bitstream classification ──────────────────────────

function evidenceEntryPublic(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: row.name,
    role: row.role,
    sha256: row.sha256,
    sizeBytes: numberValue(row.size_bytes),
    mediaType: row.media_type,
    storageUri: row.uri,
    completeness: row.completeness,
    corrupt: row.corrupt,
    verdict: row.verdict,
  };
}

async function selectFrozenEvidence(
  query: QueryClient,
  projectId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const manifestResult = await query.query(
    `SELECT id, project_id, tool_run_id, schema_version, run_state::text,
            operation, run_class::text, input_hash, toolchain_profile_hash,
            manifest_hash, frozen_at, verdicts
       FROM tool_run_evidence_manifest
      WHERE project_id = $1 AND tool_run_id = $2`,
    [projectId, jobId],
  );
  const manifest = manifestResult.rows[0] as Record<string, unknown> | undefined;
  if (!manifest) throw conflictApiError("EVIDENCE_NOT_FROZEN", { jobId });
  const entriesResult = await query.query(
    `SELECT name, role, sha256, size_bytes, media_type, uri,
            completeness, corrupt, verdict
       FROM tool_run_evidence_entry
      WHERE project_id = $1 AND manifest_id = $2
      ORDER BY name`,
    [projectId, manifest.id],
  );
  return {
    schema: "evidence-manifest.v1",
    id: manifest.id,
    jobId: manifest.tool_run_id,
    projectId: manifest.project_id,
    runState: manifest.run_state,
    operation: manifest.operation,
    runClass: manifest.run_class,
    inputHash: manifest.input_hash,
    toolchainProfileHash: manifest.toolchain_profile_hash,
    manifestHash: manifest.manifest_hash,
    frozenAt: manifest.frozen_at,
    verdicts: manifest.verdicts,
    entries: (entriesResult.rows as Record<string, unknown>[]).map(evidenceEntryPublic),
  };
}

function evidenceInputMember(value: unknown): Record<string, unknown> {
  const row = resultObject(value);
  const content = row.content;
  if (typeof row.path !== "string" || typeof content !== "string") {
    throw conflictApiError("FORMAL_JOB_PARAMETERS_INVALID");
  }
  const bytes = new TextEncoder().encode(content);
  return {
    path: row.path,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: typeof row.mediaType === "string" ? row.mediaType : "application/octet-stream",
  };
}

function expectedConnectorInputManifest(run: Record<string, unknown>): Record<string, unknown> {
  const parameters = resultObject(run.parameters);
  const sources = Array.isArray(parameters.sources) ? parameters.sources.map(evidenceInputMember) : [];
  const constraints = Array.isArray(parameters.constraints) ? parameters.constraints.map(evidenceInputMember) : [];
  const byPath = (left: Record<string, unknown>, right: Record<string, unknown>) => {
    return Buffer.compare(
      Buffer.from(String(left.path), "utf8"),
      Buffer.from(String(right.path), "utf8"),
    );
  };
  return {
    schema: "vivado-input-manifest.v1",
    jobId: run.id,
    projectId: run.project_id,
    operation: run.operation,
    runClass: run.run_class,
    inputHash: run.input_hash,
    toolchainHash: run.toolchain_profile_hash,
    top: typeof parameters.top === "string" ? parameters.top : null,
    testbench: run.operation === "simulate" && typeof parameters.testbench === "string"
      ? parameters.testbench
      : null,
    part: (run.operation === "synthesize" || run.operation === "implement")
      && typeof parameters.part === "string" ? parameters.part : null,
    sources: sources.sort(byPath),
    constraints: constraints.sort(byPath),
  };
}

function decodeJsonEvidence(entry: FrozenEvidenceCandidate): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes));
  } catch {
    throw conflictApiError("EVIDENCE_INPUT_MANIFEST_INVALID", { name: entry.name });
  }
}

async function expectedClocksForApproval(
  query: QueryClient,
  projectId: string,
  approval: LiveFormalApprovalRow,
): Promise<readonly string[]> {
  const parameters = await formalJobParameters(query, projectId, approval);
  return [...new Set(parameters.constraints.flatMap((entry) => expectedClockNames(entry.content)))].sort();
}

async function classifyBitstream(
  tx: TransactionClient,
  ctx: RequestContext,
  run: Record<string, unknown>,
  manifestId: string,
  manifestHash: string,
  entries: readonly FrozenEvidenceCandidate[],
  verdicts: Record<string, unknown>,
): Promise<void> {
  const bitstream = entries.find((entry) => entry.kind === "bitstream");
  if (!bitstream || run.operation !== "implement" || run.state !== "succeeded") return;
  const projectId = ctx.params.projectId!;
  let approval: LiveFormalApprovalRow | null = null;
  if (typeof run.formal_input_approval_id === "string") {
    try {
      approval = await liveFormalApproval(tx, projectId, run.formal_input_approval_id, true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
    }
  }
  const implementation = resultObject(verdicts.implementation);
  const drc = resultObject(verdicts.drc);
  const timing = resultObject(verdicts.timing);
  const common = resultObject(verdicts.common);
  const expectedClocks = approval ? await expectedClocksForApproval(tx, projectId, approval) : [];
  const covered = Array.isArray(timing.coveredClocks)
    ? timing.coveredClocks.filter((value): value is string => typeof value === "string")
    : [];
  const formal = approval !== null
    && run.run_class === "formal"
    && run.binding_version === "formal-input.v1"
    && approval.input_hash === run.input_hash
    && implementation.determined === true
    && implementation.passed === true
    && drc.determined === true
    && drc.clean === true
    && drc.errorCount === 0
    && timing.determined === true
    && timing.met === true
    && expectedClocks.length > 0
    && expectedClocks.every((clock) => covered.includes(clock))
    && ["inputManifest", "runScript", "stdout", "stderr", "toolLog"].every((key) => common[key] === true);
  const work = approval
    ? await activeWorkVersion(tx, projectId, true)
    : await activeWorkVersion(tx, projectId, true);
  if (!work) throw conflictApiError("WORK_VERSION_INACTIVE");
  const id = `bit_${sha256Hex(`${projectId}:${run.id}:${bitstream.name}`).slice(0, 40)}`;
  await tx.query(
    `INSERT INTO bitstream_result
      (id, project_id, work_version_id, tool_run_id, evidence_manifest_id,
       evidence_manifest_hash, evidence_entry_name, class,
       formal_input_approval_id, snapshot_id, readiness_id, input_hash,
       engineering_config_hash, prerequisite_baseline_id, target_part,
       toolchain_profile_hash, constraint_hash, sha256, size_bytes,
       storage_uri, generated_by_type, generated_by, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             'system','synthia-core',now())
     ON CONFLICT (tool_run_id, evidence_entry_name) DO NOTHING`,
    [
      id,
      projectId,
      work.id,
      run.id,
      manifestId,
      manifestHash,
      bitstream.name,
      formal ? "formal" : "trial",
      approval?.id ?? null,
      approval?.snapshot_id ?? null,
      approval?.readiness_id ?? null,
      run.input_hash,
      approval?.engineering_config_hash ?? null,
      approval?.baseline_id ?? null,
      approval?.target_part ?? resultObject(run.parameters).part ?? "unknown",
      run.toolchain_profile_hash,
      approval?.constraint_hash ?? null,
      bitstream.sha256,
      bitstream.sizeBytes,
      `content://sha256/${bitstream.sha256}`,
    ],
  );
}

export async function freezeP4EvidenceHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const jobId = ctx.params.jobId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["manifest_hash"]);
  const requestedHash = body.manifest_hash === undefined
    ? null
    : requireHash(body.manifest_hash, "manifest_hash");
  const connector = requireConnector(ctx);
  try {
    const { result } = await runIdempotent(ctx, "freeze_p4_evidence", projectId, async (tx) => {
    await requireModernProject(tx, projectId);
    const runResult = await tx.query(
      `SELECT id, project_id, operation, state::text, run_class::text,
              input_hash, input_manifest_hash, toolchain_profile_hash,
              binding_version, formal_input_approval_id, parameters
         FROM tool_run WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [jobId, projectId],
    );
    const run = runResult.rows[0] as Record<string, unknown> | undefined;
    if (!run) throw notFoundError(`job not found: ${jobId}`);
    if (!TERMINAL_RUN_STATES.has(String(run.state))) {
      throw conflictApiError("EVIDENCE_RUN_NOT_TERMINAL", { state: run.state });
    }
    const formalBinding = run.binding_version === "formal-input.v1" && run.run_class === "formal";
    const exploratoryBinding = run.binding_version === "legacy"
      && run.run_class === "exploratory"
      && typeof run.input_hash === "string"
      && SHA256.test(run.input_hash)
      && typeof run.toolchain_profile_hash === "string"
      && SHA256.test(run.toolchain_profile_hash);
    if (!formalBinding && !exploratoryBinding) {
      throw conflictApiError("P4_EVIDENCE_BINDING_REQUIRED");
    }
    const existing = await tx.query(
      "SELECT manifest_hash FROM tool_run_evidence_manifest WHERE tool_run_id = $1 AND project_id = $2",
      [jobId, projectId],
    );
    if (existing.rows.length > 0) {
      const hash = String((existing.rows[0] as Record<string, unknown>).manifest_hash);
      if (requestedHash !== null && requestedHash !== hash) {
        throw conflictApiError("EVIDENCE_MANIFEST_DIVERGED", {
          expected: hash,
          received: requestedHash,
        });
      }
      return selectFrozenEvidence(tx, projectId, jobId);
    }
    let remoteManifest;
    try {
      remoteManifest = await connector.fetchEvidence(projectId, jobId);
    } catch (error) {
      throw mapP4Error(error);
    }
    if (remoteManifest.jobId !== jobId || remoteManifest.entries.length === 0) {
      throw conflictApiError("EVIDENCE_MANIFEST_BINDING_MISMATCH");
    }
    validateP4EvidenceManifestLimits(remoteManifest.entries);
    const seen = new Set<string>();
    const entries: FrozenEvidenceCandidate[] = [];
    let retrievedTotalBytes = 0;
    for (const remote of remoteManifest.entries) {
      let name: string;
      try {
        name = validateEvidenceName(remote.name);
      } catch (error) {
        throw mapP4Error(error);
      }
      if (seen.has(name)) throw conflictApiError("EVIDENCE_ENTRY_DUPLICATED", { name });
      seen.add(name);
      let content;
      try {
        content = await connector.fetchEvidenceContent(projectId, jobId, name, { requireFull: true });
      } catch (error) {
        throw mapP4Error(error);
      }
      if (content.truncated || content.sha256 !== remote.sha256 || content.mediaType !== remote.mediaType) {
        throw conflictApiError("EVIDENCE_CONTENT_DIVERGED", { name });
      }
      const bytes = content.bytes ?? new TextEncoder().encode(content.content);
      retrievedTotalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(retrievedTotalBytes) || retrievedTotalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
        throw conflictApiError("EVIDENCE_LIMIT_EXCEEDED");
      }
      if (
        sha256Hex(bytes) !== remote.sha256
        || bytes.byteLength !== remote.sizeBytes
        || (remote.mediaType === "application/octet-stream" && content.bytes === undefined)
      ) {
        throw conflictApiError("EVIDENCE_CONTENT_DIVERGED", { name });
      }
      const kind = evidenceKind(name);
      entries.push({
        name,
        role: evidenceRole(name, kind),
        kind,
        sha256: remote.sha256,
        sizeBytes: remote.sizeBytes,
        mediaType: remote.mediaType,
        bytes,
        verdict: null,
      });
    }
    const inputManifestEntry = entries.find((entry) => entry.role === "input_manifest");
    if (!inputManifestEntry) throw conflictApiError("EVIDENCE_INPUT_MANIFEST_REQUIRED");
    const actualInputManifest = decodeJsonEvidence(inputManifestEntry);
    const expectedInputManifest = expectedConnectorInputManifest(run);
    if (stableStringify(actualInputManifest) !== stableStringify(expectedInputManifest)) {
      throw conflictApiError("EVIDENCE_INPUT_MANIFEST_BINDING_MISMATCH", {
        expectedHash: hashPayload(expectedInputManifest),
        actualHash: hashPayload(actualInputManifest),
      });
    }
    const operation = run.operation as FormalOperation;
    if (!FORMAL_OPERATIONS.includes(operation)) throw conflictApiError("FORMAL_OPERATION_NOT_APPROVED");
    const verdicts = evidenceVerdicts(operation, entries);
    const manifestHash = evidenceManifestHash(entries);
    if (requestedHash !== null && requestedHash !== manifestHash) {
      throw conflictApiError("EVIDENCE_MANIFEST_DIVERGED", {
        expected: manifestHash,
        received: requestedHash,
      });
    }
    const manifestId = `evm_${sha256Hex(`${projectId}:${jobId}`).slice(0, 40)}`;
    for (const entry of entries) {
      await tx.query(
        `INSERT INTO tool_run_evidence_entry
          (id, project_id, manifest_id, tool_run_id, name, role,
           evidence_kind, uri, sha256, size_bytes, media_type,
           completeness, corrupt, verdict, source_entry_names, managed_content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'full',false,$12::jsonb,'{}',$13)`,
        [
          `eve_${sha256Hex(`${manifestId}:${entry.name}`).slice(0, 40)}`,
          projectId,
          manifestId,
          jobId,
          entry.name,
          entry.role,
          entry.kind,
          `content://sha256/${entry.sha256}`,
          entry.sha256,
          entry.sizeBytes,
          entry.mediaType,
          entry.verdict === null ? null : JSON.stringify(entry.verdict),
          Buffer.from(entry.bytes),
        ],
      );
    }
    await tx.query(
      `INSERT INTO tool_run_evidence_manifest
        (id, project_id, tool_run_id, schema_version, run_state, operation,
         run_class, manifest_hash, input_hash, toolchain_profile_hash,
         parser_version, verdicts, entry_count, generated_by_type,
         generated_by, sealed_at, frozen_at)
       VALUES ($1,$2,$3,'evidence-manifest.v1',$4,$5,$6,$7,$8,$9,
               'p4-evidence-parser.v1',$10::jsonb,$11,'system','synthia-core',now(),now())`,
      [
        manifestId,
        projectId,
        jobId,
        run.state,
        run.operation,
        run.run_class,
        manifestHash,
        run.input_hash,
        run.toolchain_profile_hash,
        JSON.stringify(verdicts),
        entries.length,
      ],
    );
    await classifyBitstream(tx, ctx, run, manifestId, manifestHash, entries, verdicts);
    await appendP4Outbox(tx, ctx, "tool_run_evidence_manifest", manifestId, "tool_run.evidence_frozen", {
      manifestId,
      manifestHash,
      projectId,
      jobId,
      operation: run.operation,
      runState: run.state,
    });
    return selectFrozenEvidence(tx, projectId, jobId);
  }, async (tx) => {
    await requireModernProject(tx, projectId);
    const runResult = await tx.query(
      `SELECT binding_version, run_class::text, formal_input_approval_id
         FROM tool_run WHERE id = $1 AND project_id = $2`,
      [jobId, projectId],
    );
    const run = runResult.rows[0] as {
      binding_version?: string;
      run_class?: string;
      formal_input_approval_id?: string | null;
    } | undefined;
    if (!run) throw notFoundError(`job not found: ${jobId}`);
    if (
      run.binding_version === "formal-input.v1"
      && run.run_class === "formal"
      && typeof run.formal_input_approval_id === "string"
    ) {
      await liveFormalApproval(tx, projectId, run.formal_input_approval_id, true);
      return;
    }
    const work = await activeWorkVersion(tx, projectId, true);
    if (!work) throw conflictApiError("WORK_VERSION_INACTIVE");
    });
    return { status: 201, data: result };
  } catch (error) {
    const mapped = mapP4Error(error);
    if (
      mapped.httpStatus === 409
      && [
        "EVIDENCE_CONTENT_DIVERGED",
        "EVIDENCE_INPUT_MANIFEST_BINDING_MISMATCH",
        "EVIDENCE_MANIFEST_DIVERGED",
      ].includes(mapped.message)
    ) {
      await recordEvidenceDivergence(
        ctx,
        jobId,
        mapped.message,
        mapped.details && typeof mapped.details === "object" && !Array.isArray(mapped.details)
          ? mapped.details as Record<string, unknown>
          : {},
      );
    }
    throw error;
  }
}

export async function getP4EvidenceHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  return { status: 200, data: await selectFrozenEvidence(ctx.pool, projectId, ctx.params.jobId!) };
}

export async function getP4EvidenceContentHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const jobId = ctx.params.jobId!;
  await requireModernProject(ctx.pool, projectId);
  const nameRaw = ctx.url.searchParams.get("name");
  if (!nameRaw) throw validationError("query parameter 'name' is required");
  let name: string;
  try {
    name = validateEvidenceName(nameRaw);
  } catch (error) {
    throw mapP4Error(error);
  }
  const result = await ctx.pool.query(
    `SELECT e.name, e.sha256, e.size_bytes, e.media_type, e.managed_content
       FROM tool_run_evidence_entry e
       JOIN tool_run_evidence_manifest m
         ON m.id = e.manifest_id AND m.project_id = e.project_id
      WHERE e.project_id = $1 AND e.tool_run_id = $2 AND e.name = $3`,
    [projectId, jobId, name],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    const frozen = await ctx.pool.query(
      "SELECT 1 FROM tool_run_evidence_manifest WHERE project_id = $1 AND tool_run_id = $2",
      [projectId, jobId],
    );
    if (frozen.rows.length === 0) throw conflictApiError("EVIDENCE_NOT_FROZEN", { jobId });
    throw notFoundError(`evidence entry not found: ${name}`);
  }
  const bytes = row.managed_content as Uint8Array;
  if (sha256Hex(bytes) !== row.sha256 || bytes.byteLength !== numberValue(row.size_bytes)) {
    throw conflictApiError("EVIDENCE_CONTENT_HASH_MISMATCH", { name });
  }
  const mediaType = String(row.media_type);
  const textLike = mediaType.startsWith("text/") || mediaType === "application/json";
  return {
    status: 200,
    data: {
      name,
      content: textLike ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
      encoding: textLike ? "utf8" : "base64",
      sha256: row.sha256,
      sizeBytes: numberValue(row.size_bytes),
      mediaType,
    },
  };
}

export async function listP4BitstreamsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT id, project_id, work_version_id, tool_run_id,
            evidence_manifest_id, evidence_manifest_hash, evidence_entry_name,
            class, formal_input_approval_id, snapshot_id, readiness_id,
            input_hash, engineering_config_hash, prerequisite_baseline_id,
            target_part, toolchain_profile_hash, constraint_hash, sha256,
            size_bytes, storage_uri, generated_by_type, generated_by,
            generated_at, created_at
       FROM bitstream_result WHERE project_id = $1
      ORDER BY generated_at DESC, id`,
    [projectId],
  );
  return { status: 200, data: rows };
}

// ─── Human gate approval and atomic release ─────────────────────────────────

function optionalStringValue(body: Record<string, unknown>, key: string, fallback = ""): string {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw validationError(`field '${key}' must be a string`);
  return value;
}

async function currentPrerequisiteBaseline(
  tx: TransactionClient,
  projectId: string,
  gate: P4GateId,
): Promise<StructuredBaselineFact | null> {
  const kind = gate === "G2" || gate === "G3" ? "B0" : gate === "G4" ? "B1" : null;
  if (kind === null) return null;
  return activeStructuredBaseline(tx, projectId, kind, true);
}

async function revalidateEvaluation(
  tx: TransactionClient,
  projectId: string,
  context: SubmissionContext,
  work: WorkVersionRow,
  evaluation: Record<string, unknown>,
): Promise<G4Facts | null> {
  const artifacts = await snapshotArtifacts(tx, projectId, context.member_revision_ids);
  const prerequisite = await currentPrerequisiteBaseline(tx, projectId, context.gate);
  const g4 = context.gate === "G4"
    ? await buildG4Facts(tx, projectId, work, context, String(evaluation.id))
    : null;
  const structured = await structuredGateEvaluation(
    tx,
    projectId,
    context,
    context.gate === "G2" || context.gate === "G3" ? prerequisite : null,
  );
  const node = GJB_REF_V1_PROFILE.nodes.find((item) => item.id === context.gate)!;
  const current = gateChecks(context, artifacts, node.requiredChecks, work, prerequisite, g4, structured);
  if ((context.gate === "G3" || context.gate === "G4") && prerequisite === null) {
    throw conflictApiError("PREREQUISITE_BASELINE_INACTIVE");
  }
  if (context.gate === "G4") {
    if (!g4 || !g4.approval || !g4.bitstream || g4.runs.length !== FORMAL_OPERATIONS.length) {
      throw conflictApiError("G4_FORMAL_FACTS_INACTIVE");
    }
    const projection = sealedDeliveryProjection(projectId, context, work, String(evaluation.id), g4);
    if (
      hashPayload(projection) !== evaluation.sealed_projection_hash
      || stableStringify(projection) !== stableStringify(evaluation.sealed_projection)
    ) {
      throw conflictApiError("G4_SEALED_PROJECTION_CHANGED");
    }
  }
  const storedResult = await tx.query(
    `SELECT check_code, severity, passed, fact_hash
       FROM gate_check_item
      WHERE project_id = $1 AND evaluation_id = $2
      ORDER BY check_code`,
    [projectId, evaluation.id],
  );
  const stored = storedResult.rows as Array<{
    check_code: string;
    severity: string;
    passed: boolean;
    fact_hash: string;
  }>;
  if (
    stored.length !== current.length
    || current.some((check) => {
      const prior = stored.find((item) => item.check_code === check.code);
      return !prior
        || prior.severity !== check.severity
        || prior.passed !== check.passed
        || prior.fact_hash !== hashPayload(check.details)
        || (check.severity === "hard" && !check.passed);
    })
  ) {
    throw conflictApiError("GATE_EVALUATION_FACTS_CHANGED");
  }
  return g4;
}

export async function approveP4GateHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const submissionId = ctx.params.subId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, [
    "approval_record_id",
    "approved_gate_result_id",
    "approver_role",
    "authorization_basis",
    "baseline_id",
    "candidate_manifest_hash",
    "check_results_hash",
    "client_audit_digest",
    "configuration_snapshot_id",
    "delivery_release_id",
    "gate_check_evaluation_id",
    "issues",
    "reason",
    "risks",
    "signature_method",
    "signed_at",
    "waivers",
  ]);
  const snapshotId = requireId(body.configuration_snapshot_id, "configuration_snapshot_id");
  const approvedGateResultId = requireId(body.approved_gate_result_id, "approved_gate_result_id");
  const requestedEvaluationId = requireId(body.gate_check_evaluation_id, "gate_check_evaluation_id");
  const resultHash = requireHash(body.check_results_hash, "check_results_hash");
  const candidateHash = body.candidate_manifest_hash === undefined
    ? null
    : requireHash(body.candidate_manifest_hash, "candidate_manifest_hash");
  const baselineId = body.baseline_id === null ? null : requireId(body.baseline_id, "baseline_id");
  const releaseId = body.delivery_release_id === undefined
    ? null
    : requireId(body.delivery_release_id, "delivery_release_id");
  const signedAt = requireString(body, "signed_at");
  if (!Number.isFinite(Date.parse(signedAt))) throw validationError("signed_at must be an ISO timestamp");
  const reason = optionalStringValue(body, "reason");
  const issues = optionalStringArray(body, "issues");
  const risks = optionalStringArray(body, "risks");
  const waivers = optionalStringArray(body, "waivers");
  const approvalRecordId = body.approval_record_id === undefined
    ? `apr_${sha256Hex(`${projectId}:${submissionId}:${requestedEvaluationId}`).slice(0, 32)}`
    : requireId(body.approval_record_id, "approval_record_id");
  const authorizationBasis = optionalStringValue(body, "authorization_basis", "project role and platform token");
  const signatureMethod = optionalStringValue(body, "signature_method", "platform_token");

  const { result } = await runIdempotent(
    ctx,
    "approve_p4_gate",
    projectId,
    async (tx) => {
      await requireModernProject(tx, projectId);
      const role = await requireHumanProjectRole(
        tx,
        ctx,
        optionalStringValue(body, "approver_role", "quality"),
      );
      const context = await submissionContext(tx, projectId, submissionId, true);
      if (context.state !== "in_review") {
        throw conflictApiError("GATE_SUBMISSION_NOT_APPROVABLE", { state: context.state });
      }
      if (context.snapshot_id !== snapshotId) throw conflictApiError("SNAPSHOT_MISMATCH");
      const work = await activeWorkVersion(tx, projectId, true);
      if (
        !work
        || work.id !== context.work_version_id
        || work.process_instance_id !== context.process_instance_id
        || work.current_gate !== context.gate
        || (context.gate === "G4" ? work.state !== "in_review" : work.state !== "working")
      ) {
        throw conflictApiError("WORK_VERSION_INACTIVE");
      }
      const evaluationResult = await tx.query(
        `SELECT id, result_hash, passed, state, work_version_id,
                snapshot_id, profile_hash, sealed_projection,
                sealed_projection_hash
           FROM gate_check_evaluation
          WHERE id = $1 AND project_id = $2 AND gate_submission_id = $3`,
        [requestedEvaluationId, projectId, submissionId],
      );
      const evaluation = evaluationResult.rows[0] as Record<string, unknown> | undefined;
      if (
        !evaluation
        || evaluation.passed !== true
        || evaluation.state !== "passed"
        || evaluation.result_hash !== resultHash
        || evaluation.work_version_id !== work.id
        || evaluation.snapshot_id !== snapshotId
        || evaluation.profile_hash !== GJB_REF_V1_PROFILE.profileHash
      ) {
        throw conflictApiError("PASSED_GATE_EVALUATION_REQUIRED");
      }
      if (waivers.length > 0) {
        throw validationError("P4 hard checks cannot be waived", { waivers });
      }
      const node = GJB_REF_V1_PROFILE.nodes.find((item) => item.id === context.gate)!;
      const expectedBaselineKind = node.milestoneBaseline;
      if ((expectedBaselineKind === null) !== (baselineId === null)) {
        throw validationError(expectedBaselineKind === null
          ? "baseline_id is forbidden for this gate"
          : "baseline_id is required for this gate");
      }
      if (context.gate === "G4") {
        const projection = resultObject(evaluation.sealed_projection);
        if (
          candidateHash === null
          || candidateHash !== evaluation.sealed_projection_hash
          || releaseId === null
          || releaseId !== projection.releaseId
          || approvalRecordId !== projection.plannedApprovalRecordId
        ) {
          throw conflictApiError("G4_SEALED_PROJECTION_REQUIRED");
        }
      } else if (candidateHash !== null || releaseId !== null) {
        throw validationError("delivery fields are only valid for G4 approval");
      }

      const g4 = await revalidateEvaluation(tx, projectId, context, work, evaluation);
      const snapshotResult = await tx.query(
        `SELECT member_revision_ids, trace_relation_ids, manifest_hash
           FROM configuration_snapshot
          WHERE id = $1 AND project_id = $2 AND work_version_id = $3`,
        [snapshotId, projectId, work.id],
      );
      const snapshot = snapshotResult.rows[0] as {
        member_revision_ids: string[];
        trace_relation_ids: string[];
        manifest_hash: string;
      } | undefined;
      if (!snapshot) throw conflictApiError("SNAPSHOT_WORK_VERSION_MISMATCH");

      await tx.query(
        `INSERT INTO approval_record
          (id, project_id, gate_submission_id, decision, approver_id,
           approver_role, authorization_basis, reason, issues, risks, waivers,
           check_results_hash, signed_at, signature_method,
           client_audit_digest, approved_gate_result_id)
         VALUES ($1,$2,$3,'approve',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          approvalRecordId,
          projectId,
          submissionId,
          ctx.identity.actorId,
          role,
          authorizationBasis,
          reason,
          issues,
          risks,
          waivers,
          resultHash,
          signedAt,
          signatureMethod,
          body.client_audit_digest ?? null,
          approvedGateResultId,
        ],
      );
      await tx.query(
        `INSERT INTO approved_gate_result
          (id, project_id, gate, gate_submission_id, approval_record_id, snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [approvedGateResultId, projectId, context.gate, submissionId, approvalRecordId, snapshotId],
      );

      if (baselineId !== null && expectedBaselineKind !== null) {
        const predecessorResult = await tx.query(
          `SELECT id FROM baseline
            WHERE project_id = $1 AND kind = $2 AND state = 'active'
            ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
          [projectId, expectedBaselineKind],
        );
        const predecessorId = (predecessorResult.rows[0] as { id?: string } | undefined)?.id ?? null;
        await tx.query(
          `INSERT INTO baseline
            (id, project_id, kind, state, approved_gate_result_id,
             member_revision_ids, trace_relation_ids, manifest_hash,
             approval_record_id, supersedes_baseline_id)
           VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9)`,
          [
            baselineId,
            projectId,
            expectedBaselineKind,
            approvedGateResultId,
            snapshot.member_revision_ids,
            snapshot.trace_relation_ids,
            snapshot.manifest_hash,
            approvalRecordId,
            predecessorId,
          ],
        );
      }

      let sealedReleaseId: string | null = null;
      if (context.gate === "G4" && g4 && releaseId && baselineId) {
        const approvalConfirmation = dataItem(
          "confirmation",
          "confirmations/gate-approval.json",
          "approval_record",
          approvalRecordId,
          {
            schema: "gate-approval-confirmation.v1",
            projectId,
            gateSubmissionId: submissionId,
            gateEvaluationId: String(evaluation.id),
            gate: "G4",
            approvalRecordId,
            approvedGateResultId,
            approver: { type: "human", id: ctx.identity.actorId, role },
            authorizationBasis,
            reason,
            issues,
            risks,
            waivers,
            checkResultsHash: resultHash,
            signedAt,
            signatureMethod,
          },
        );
        const releaseItems = [...g4.items, approvalConfirmation].sort((left, right) => {
          const a = [left.category, left.path, left.source_type, left.source_id, left.sha256].join("\0");
          const b = [right.category, right.path, right.source_type, right.source_id, right.sha256].join("\0");
          return a < b ? -1 : a > b ? 1 : 0;
        });
        const priorResult = await tx.query(
          `SELECT id, version FROM delivery_release
            WHERE project_id = $1 AND state = 'sealed'
            ORDER BY version DESC, id DESC LIMIT 1 FOR UPDATE`,
          [projectId],
        );
        const prior = priorResult.rows[0] as { id?: string; version?: number } | undefined;
        const version = (prior?.version ?? 0) + 1;
        const manifest = {
          schema: "delivery-manifest.v1",
          project_id: projectId,
          release_id: releaseId,
          version,
          work_version_id: work.id,
          input_hash: g4.approval!.input_hash,
          items: releaseItems.map((item) => ({
            category: item.category,
            path: item.path,
            source_type: item.source_type,
            source_id: item.source_id,
            sha256: item.sha256,
            size_bytes: item.size_bytes,
            media_type: item.media_type,
            storage_uri: item.storage_uri,
            provenance: item.provenance,
          })),
        };
        const manifestHash = hashPayload(manifest);
        await tx.query(
          `INSERT INTO delivery_release
            (id, project_id, version, supersedes_release_id,
             process_version_id, process_instance_id, work_version_id,
             gate_submission_id, gate_check_evaluation_id,
             candidate_manifest_hash, approval_record_id,
             approved_gate_result_id, baseline_id, formal_input_approval_id,
             bitstream_result_id, schema_version, manifest, manifest_hash,
             item_count, state, generated_by_type, generated_by,
             confirmed_by, confirmed_at, released_at)
           VALUES ($1,$2,$3,$4,'GJB_REF_V1',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                   'delivery-manifest.v1',$15::jsonb,$16,$17,'sealed','system','synthia-core',$18,now(),now())`,
          [
            releaseId,
            projectId,
            version,
            prior?.id ?? null,
            context.process_instance_id,
            work.id,
            submissionId,
            evaluation.id,
            evaluation.sealed_projection_hash,
            approvalRecordId,
            approvedGateResultId,
            baselineId,
            g4.approval!.id,
            g4.bitstream!.id,
            JSON.stringify(manifest),
            manifestHash,
            releaseItems.length,
            ctx.identity.actorId,
          ],
        );
        for (const item of releaseItems) {
          await tx.query(
            `INSERT INTO delivery_release_item
              (id, project_id, release_id, category, path, source_type,
               source_id, sha256, size_bytes, media_type, storage_uri, provenance)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
            [
              `dri_${sha256Hex(`${releaseId}:${item.path}`).slice(0, 40)}`,
              projectId,
              releaseId,
              item.category,
              item.path,
              item.source_type,
              item.source_id,
              item.sha256,
              item.size_bytes,
              item.media_type,
              item.storage_uri,
              JSON.stringify(item.provenance),
            ],
          );
        }
        sealedReleaseId = releaseId;
      }

      await tx.query(
        "UPDATE gate_submission SET state = 'approved' WHERE id = $1 AND project_id = $2 AND state = 'in_review'",
        [submissionId, projectId],
      );
      const nextGate = nextP4Gate(context.gate);
      if (context.gate === "G4") {
        await tx.query(
          `UPDATE project_work_version
              SET state = 'released', current_gate = 'G4', released_at = now()
            WHERE id = $1 AND project_id = $2 AND state = 'in_review'`,
          [work.id, projectId],
        );
        if (work.change_request_id) {
          await tx.query(
            `UPDATE change_request SET state = 'released', released_at = now()
              WHERE id = $1 AND project_id = $2 AND state = 'open'`,
            [work.change_request_id, projectId],
          );
        }
      } else if (nextGate) {
        await tx.query(
          "UPDATE project_work_version SET current_gate = $1 WHERE id = $2 AND project_id = $3 AND state = 'working'",
          [nextGate, work.id, projectId],
        );
        await tx.query(
          "UPDATE process_instance SET current_gate = $1 WHERE id = $2 AND project_id = $3",
          [nextGate, work.process_instance_id, projectId],
        );
      }
      if (context.gate === "G4") {
        await tx.query(
          "UPDATE process_instance SET current_gate = 'G4' WHERE id = $1 AND project_id = $2",
          [work.process_instance_id, projectId],
        );
      }
      await appendP4Outbox(tx, ctx, "approved_gate_result", approvedGateResultId, "gate.approved", {
        projectId,
        submissionId,
        evaluationId: evaluation.id,
        gate: context.gate,
        approvalRecordId,
        approvedGateResultId,
        baselineId,
        deliveryReleaseId: sealedReleaseId,
        workVersionId: work.id,
      });
      if (sealedReleaseId) {
        await appendP4Outbox(tx, ctx, "delivery_release", sealedReleaseId, "delivery.release_sealed", {
          projectId,
          releaseId: sealedReleaseId,
          workVersionId: work.id,
          baselineId,
        });
      }
      return {
        approvalRecordId,
        approvedGateResultId,
        baselineId,
        deliveryReleaseId: sealedReleaseId,
        gate: context.gate,
        state: "approved",
      };
    },
    async (tx) => {
      await requireModernProject(tx, projectId);
      await acquireG4ProjectMutationLockForSubmission(
        tx,
        projectId,
        submissionId,
        "g4.approve",
      );
      const replayRole = await requireHumanProjectRole(
        tx,
        ctx,
        optionalStringValue(body, "approver_role", "quality"),
      );
      const context = await submissionContext(tx, projectId, submissionId, true);
      const work = await activeWorkVersion(tx, projectId, true);
      if (work && work.id === context.work_version_id) return;
      if (context.gate !== "G4" || context.state !== "approved" || releaseId === null || candidateHash === null) {
        throw conflictApiError("WORK_VERSION_INACTIVE");
      }
      const sealed = await tx.query(
        `SELECT 1
           FROM delivery_release dr
           JOIN gate_check_evaluation ge
             ON ge.id = dr.gate_check_evaluation_id
            AND ge.project_id = dr.project_id
           JOIN approval_record ar
             ON ar.id = dr.approval_record_id
            AND ar.project_id = dr.project_id
          WHERE dr.id = $1 AND dr.project_id = $2 AND dr.state = 'sealed'
            AND dr.gate_submission_id = $3
            AND dr.gate_check_evaluation_id = $4
            AND dr.candidate_manifest_hash = $5
            AND dr.approval_record_id = $6
            AND dr.approved_gate_result_id = $7
            AND dr.baseline_id = $8
            AND dr.work_version_id = $9
            AND dr.confirmed_by = $10
            AND ge.result_hash = $11
            AND ge.snapshot_id = $12
            AND ar.approver_id = $10
            AND ar.approver_role = $13`,
        [
          releaseId,
          projectId,
          submissionId,
          requestedEvaluationId,
          candidateHash,
          approvalRecordId,
          approvedGateResultId,
          baselineId,
          context.work_version_id,
          ctx.identity.actorId,
          resultHash,
          snapshotId,
          replayRole,
        ],
      );
      if (sealed.rows.length === 0) throw conflictApiError("WORK_VERSION_INACTIVE");
    },
  );
  return { status: 200, data: result };
}

// ─── Sealed delivery reads and post-release change control ─────────────────

const DELIVERY_RELEASE_COLUMNS = `
  id, project_id, version, supersedes_release_id, process_version_id,
  process_instance_id, work_version_id, gate_submission_id,
  gate_check_evaluation_id, candidate_manifest_hash, approval_record_id,
  approved_gate_result_id, baseline_id, formal_input_approval_id,
  bitstream_result_id, schema_version, manifest_hash, item_count, state,
  generated_by_type::text, generated_by, generated_at, confirmed_by,
  confirmed_at, created_at, released_at`;

async function selectDeliveryRelease(
  query: QueryClient,
  projectId: string,
  releaseId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await query.query(
    `SELECT ${DELIVERY_RELEASE_COLUMNS}
       FROM delivery_release WHERE id = $1 AND project_id = $2`,
    [releaseId, projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`delivery release not found: ${releaseId}`);
  return row;
}

async function selectDeliveryItems(
  query: QueryClient,
  projectId: string,
  releaseId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await query.query(
    `SELECT id, project_id, release_id, category, path, source_type,
            source_id, sha256, size_bytes, media_type, storage_uri,
            provenance, created_at
       FROM delivery_release_item
      WHERE project_id = $1 AND release_id = $2
      ORDER BY category, path, source_type, source_id, sha256`,
    [projectId, releaseId],
  );
  return rows as Record<string, unknown>[];
}

export async function listP4DeliveryReleasesHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT ${DELIVERY_RELEASE_COLUMNS}
       FROM delivery_release WHERE project_id = $1
      ORDER BY version DESC, id DESC`,
    [projectId],
  );
  return { status: 200, data: rows };
}

export async function getP4DeliveryReleaseHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const releaseId = ctx.params.releaseId!;
  await requireModernProject(ctx.pool, projectId);
  const release = await selectDeliveryRelease(ctx.pool, projectId, releaseId);
  const items = await selectDeliveryItems(ctx.pool, projectId, releaseId);
  return { status: 200, data: { ...release, items } };
}

export async function getP4DeliveryManifestHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const releaseId = ctx.params.releaseId!;
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT manifest, manifest_hash FROM delivery_release
      WHERE id = $1 AND project_id = $2`,
    [releaseId, projectId],
  );
  const row = rows[0] as { manifest?: unknown; manifest_hash?: string } | undefined;
  if (!row) throw notFoundError(`delivery release not found: ${releaseId}`);
  if (!row.manifest || typeof row.manifest !== "object" || Array.isArray(row.manifest)) {
    throw conflictApiError("DELIVERY_MANIFEST_INVALID");
  }
  const actual = hashPayload(row.manifest);
  if (actual !== row.manifest_hash) {
    throw conflictApiError("DELIVERY_MANIFEST_DIVERGED", {
      expected: row.manifest_hash,
      actual,
    });
  }
  return {
    status: 200,
    data: { ...(row.manifest as Record<string, unknown>), manifest_hash: row.manifest_hash },
  };
}

function decodeDataUri(uri: string): Uint8Array | null {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match) return null;
  try {
    return new Uint8Array(Buffer.from(match[2]!, "base64"));
  } catch {
    return null;
  }
}

function validateDeliveryPath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || input.includes("\\")) {
    throw validationError("delivery path must be a non-empty relative POSIX path");
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw validationError("delivery path must be relative");
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw validationError("delivery path contains an invalid segment");
  }
  return input;
}

async function deliveryItemBytes(
  query: QueryClient,
  projectId: string,
  item: Record<string, unknown>,
): Promise<Uint8Array> {
  const uri = String(item.storage_uri);
  const inline = decodeDataUri(uri);
  if (inline) return inline;
  if (item.source_type === "artifact_revision") {
    const match = /^content:\/\/sha256\/([0-9a-f]{64})$/.exec(uri);
    if (!match || match[1] !== item.sha256) {
      throw conflictApiError("DELIVERY_ITEM_STORAGE_UNSUPPORTED", {
        path: item.path,
        sourceType: item.source_type,
        storageUri: uri,
      });
    }
    return managedFormalContentBytes(
      query,
      projectId,
      match[1]!,
      numberValue(item.size_bytes),
    );
  }
  if (item.source_type === "tool_run_evidence_entry") {
    const result = await query.query(
      `SELECT managed_content FROM tool_run_evidence_entry
        WHERE id = $1 AND project_id = $2`,
      [item.source_id, projectId],
    );
    const content = (result.rows[0] as { managed_content?: Uint8Array } | undefined)?.managed_content;
    if (!content) throw conflictApiError("DELIVERY_ITEM_SOURCE_MISSING", { path: item.path });
    return content;
  }
  if (item.source_type === "bitstream_result") {
    const result = await query.query(
      `SELECT e.managed_content
         FROM bitstream_result b
         JOIN tool_run_evidence_entry e
           ON e.manifest_id = b.evidence_manifest_id
          AND e.tool_run_id = b.tool_run_id
          AND e.project_id = b.project_id
          AND e.name = b.evidence_entry_name
        WHERE b.id = $1 AND b.project_id = $2 AND b.class = 'formal'`,
      [item.source_id, projectId],
    );
    const content = (result.rows[0] as { managed_content?: Uint8Array } | undefined)?.managed_content;
    if (!content) throw conflictApiError("DELIVERY_ITEM_SOURCE_MISSING", { path: item.path });
    return content;
  }
  throw conflictApiError("DELIVERY_ITEM_STORAGE_UNSUPPORTED", {
    path: item.path,
    sourceType: item.source_type,
    storageUri: uri,
  });
}

export async function getP4DeliveryContentHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const releaseId = ctx.params.releaseId!;
  const path = validateDeliveryPath(ctx.url.searchParams.get("path"));
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT id, category, path, source_type, source_id, sha256,
            size_bytes, media_type, storage_uri, provenance
       FROM delivery_release_item
      WHERE release_id = $1 AND project_id = $2 AND path = $3`,
    [releaseId, projectId, path],
  );
  const item = rows[0] as Record<string, unknown> | undefined;
  if (!item) {
    const release = await ctx.pool.query(
      "SELECT 1 FROM delivery_release WHERE id = $1 AND project_id = $2",
      [releaseId, projectId],
    );
    if (release.rows.length === 0) throw notFoundError(`delivery release not found: ${releaseId}`);
    throw notFoundError(`delivery item not found: ${path}`);
  }
  const bytes = await deliveryItemBytes(ctx.pool, projectId, item);
  const actualHash = sha256Hex(bytes);
  const actualSize = bytes.byteLength;
  if (actualHash !== item.sha256 || actualSize !== numberValue(item.size_bytes)) {
    throw conflictApiError("DELIVERY_ITEM_CONTENT_DIVERGED", {
      path,
      expectedHash: item.sha256,
      actualHash,
      expectedSize: numberValue(item.size_bytes),
      actualSize,
    });
  }
  const mediaType = String(item.media_type);
  const textLike = mediaType.startsWith("text/") || mediaType === "application/json";
  return {
    status: 200,
    data: {
      path,
      content: textLike ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
      encoding: textLike ? "utf8" : "base64",
      media_type: mediaType,
      sha256: actualHash,
      file_name: path.split("/").at(-1),
    },
  };
}

function changeRequestPublic(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    base_delivery_release_id: row.base_delivery_release_id,
    project_work_version_id: row.project_work_version_id,
    reason: row.reason,
    affected_paths: row.affected_paths,
    impact_gate: row.impact_gate,
    state: row.state,
    proposed_by_type: row.proposed_by_type,
    proposed_by: row.proposed_by,
    proposed_at: row.proposed_at,
    confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at,
    released_at: row.released_at,
    withdrawn_at: row.withdrawn_at,
    created_at: row.created_at,
  };
}

async function selectChangeRequest(
  query: QueryClient,
  projectId: string,
  changeRequestId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await query.query(
    `SELECT id, project_id, base_delivery_release_id, project_work_version_id,
            reason, affected_paths, impact_gate::text, state,
            proposed_by_type::text, proposed_by, proposed_at, confirmed_by,
            confirmed_at, released_at, withdrawn_at, created_at
       FROM change_request WHERE id = $1 AND project_id = $2`,
    [changeRequestId, projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`change request not found: ${changeRequestId}`);
  return changeRequestPublic(row);
}

export async function createP4ChangeRequestHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, [
    "affected_paths",
    "base_delivery_release_id",
    "id",
    "impact_gate",
    "reason",
    "work_version_id",
  ]);
  const id = requireId(body.id, "id");
  const workVersionId = requireId(body.work_version_id, "work_version_id");
  const baseReleaseId = requireId(body.base_delivery_release_id, "base_delivery_release_id");
  const reason = requireString(body, "reason").trim();
  if (reason.length === 0) throw validationError("field 'reason' must not be blank");
  const affectedPaths = optionalStringArray(body, "affected_paths").map((path) => validateWorkspacePath(path));
  if (affectedPaths.length === 0 || new Set(affectedPaths).size !== affectedPaths.length) {
    throw validationError("affected_paths must be a non-empty unique path list");
  }
  if (!isP4Gate(body.impact_gate) || body.impact_gate === "G0") {
    throw validationError("impact_gate must be one of G1-G4");
  }
  const impactGate = body.impact_gate;
  const { result } = await runIdempotent(ctx, "create_p4_change_request", projectId, async (tx) => {
    await requireModernProject(tx, projectId);
    await requireHumanProjectRole(tx, ctx);
    const active = await activeWorkVersion(tx, projectId, true);
    if (active) throw conflictApiError("ACTIVE_WORK_VERSION_EXISTS", { workVersionId: active.id });
    const releaseResult = await tx.query(
      `SELECT id, version, process_instance_id
         FROM delivery_release WHERE project_id = $1 AND state = 'sealed'
        ORDER BY version DESC, id DESC LIMIT 1 FOR UPDATE`,
      [projectId],
    );
    const release = releaseResult.rows[0] as {
      id?: string;
      version?: number;
      process_instance_id?: string;
    } | undefined;
    if (!release?.id || release.id !== baseReleaseId || !release.process_instance_id) {
      throw conflictApiError("BASE_DELIVERY_RELEASE_NOT_CURRENT", {
        expected: release?.id ?? null,
        received: baseReleaseId,
      });
    }
    const workResult = await tx.query(
      "SELECT COALESCE(MAX(version),0)::int AS version FROM project_work_version WHERE project_id = $1",
      [projectId],
    );
    const nextVersion = numberValue((workResult.rows[0] as { version?: number } | undefined)?.version ?? 0) + 1;
    const requestHash = hashPayload({
      schema: "change-request.v1",
      projectId,
      baseDeliveryReleaseId: baseReleaseId,
      reason,
      affectedPaths: [...affectedPaths].sort(),
      impactGate,
    });
    await tx.query(
      `INSERT INTO change_request
        (id, project_id, base_delivery_release_id, project_work_version_id,
         reason, affected_paths, impact_gate, request_hash, state,
         proposed_by_type, proposed_by, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$10,now())`,
      [
        id,
        projectId,
        baseReleaseId,
        workVersionId,
        reason,
        affectedPaths,
        impactGate,
        requestHash,
        ctx.identity.actorType,
        ctx.identity.actorId,
      ],
    );
    await tx.query(
      `INSERT INTO project_work_version
        (id, project_id, process_instance_id, version, origin,
         change_request_id, base_delivery_release_id, start_gate,
         current_gate, state, created_by_type, created_by)
       VALUES ($1,$2,$3,$4,'change_request',$5,$6,$7,$7,'working',$8,$9)`,
      [
        workVersionId,
        projectId,
        release.process_instance_id,
        nextVersion,
        id,
        baseReleaseId,
        impactGate,
        ctx.identity.actorType,
        ctx.identity.actorId,
      ],
    );
    await tx.query(
      "UPDATE process_instance SET current_gate = $1 WHERE id = $2 AND project_id = $3",
      [impactGate, release.process_instance_id, projectId],
    );
    await appendP4Outbox(tx, ctx, "change_request", id, "change_request.opened", {
      id,
      projectId,
      workVersionId,
      baseDeliveryReleaseId: baseReleaseId,
      impactGate,
      affectedPaths,
    });
    return selectChangeRequest(tx, projectId, id);
  }, async (tx) => {
    await requireModernProject(tx, projectId);
    await requireHumanProjectRole(tx, ctx);
    const existingResult = await tx.query(
      `SELECT id, base_delivery_release_id, project_work_version_id,
              state, confirmed_by
         FROM change_request WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    const existing = existingResult.rows[0] as {
      id?: string;
      base_delivery_release_id?: string;
      project_work_version_id?: string;
      state?: string;
      confirmed_by?: string;
    } | undefined;
    if (!existing) return;
    if (
      existing.state !== "open"
      || existing.base_delivery_release_id !== baseReleaseId
      || existing.project_work_version_id !== workVersionId
      || existing.confirmed_by !== ctx.identity.actorId
    ) {
      throw conflictApiError("CHANGE_REQUEST_INACTIVE");
    }
    const latest = await tx.query(
      `SELECT id FROM delivery_release
        WHERE project_id = $1 AND state = 'sealed'
        ORDER BY version DESC, id DESC LIMIT 1`,
      [projectId],
    );
    if ((latest.rows[0] as { id?: string } | undefined)?.id !== baseReleaseId) {
      throw conflictApiError("BASE_DELIVERY_RELEASE_NOT_CURRENT");
    }
  });
  return { status: 201, data: result };
}

export async function withdrawP4ChangeRequestHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertFeature(ctx);
  const projectId = ctx.params.projectId!;
  const changeRequestId = ctx.params.changeRequestId!;
  const body = asObject(ctx.body);
  rejectUnknownFields(body, ["reason"]);
  const reason = requireString(body, "reason").trim();
  if (reason.length === 0) throw validationError("field 'reason' must not be blank");
  const { result } = await runIdempotent(ctx, "withdraw_p4_change_request", projectId, async (tx) => {
    await requireModernProject(tx, projectId);
    await requireHumanProjectRole(tx, ctx);
    const requestResult = await tx.query(
      `SELECT id, project_work_version_id, state
         FROM change_request WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [changeRequestId, projectId],
    );
    const request = requestResult.rows[0] as {
      id?: string;
      project_work_version_id?: string;
      state?: string;
    } | undefined;
    if (!request?.id || !request.project_work_version_id) {
      throw notFoundError(`change request not found: ${changeRequestId}`);
    }
    if (request.state !== "open") {
      throw conflictApiError("CHANGE_REQUEST_NOT_WITHDRAWABLE", { state: request.state });
    }
    const workResult = await tx.query(
      `SELECT id, process_instance_id, state
         FROM project_work_version
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [request.project_work_version_id, projectId],
    );
    const work = workResult.rows[0] as {
      id?: string;
      process_instance_id?: string;
      state?: string;
    } | undefined;
    if (!work?.id || !work.process_instance_id || (work.state !== "working" && work.state !== "in_review")) {
      throw conflictApiError("CHANGE_REQUEST_WORK_VERSION_INACTIVE", { state: work?.state ?? null });
    }
    await tx.query(
      `UPDATE gate_submission SET state = 'withdrawn'
        WHERE project_id = $1 AND work_version_id = $2
          AND state = ANY($3::gate_sub_state[])`,
      [projectId, work.id, ACTIVE_SUBMISSION_STATES],
    );
    await tx.query(
      `UPDATE project_work_version
          SET state = 'abandoned', abandoned_at = now()
        WHERE id = $1 AND project_id = $2 AND state IN ('working','in_review')`,
      [work.id, projectId],
    );
    await tx.query(
      `UPDATE change_request
          SET state = 'withdrawn', withdrawn_at = now()
        WHERE id = $1 AND project_id = $2 AND state = 'open'`,
      [changeRequestId, projectId],
    );
    await tx.query(
      "UPDATE process_instance SET current_gate = 'G4' WHERE id = $1 AND project_id = $2",
      [work.process_instance_id, projectId],
    );
    await appendP4Outbox(tx, ctx, "change_request", changeRequestId, "change_request.withdrawn", {
      id: changeRequestId,
      projectId,
      workVersionId: work.id,
      reason,
      confirmedBy: ctx.identity.actorId,
    });
    return selectChangeRequest(tx, projectId, changeRequestId);
  }, async (tx) => {
    await requireModernProject(tx, projectId);
    await requireHumanProjectRole(tx, ctx);
    await acquireP4ProjectMutationTransactionLock(
      tx,
      projectId,
      "change-request.withdraw",
    );
    const existing = await selectChangeRequest(tx, projectId, changeRequestId);
    if (existing.state !== "open" && existing.state !== "withdrawn") {
      throw conflictApiError("CHANGE_REQUEST_NOT_WITHDRAWABLE", { state: existing.state });
    }
  });
  return { status: 200, data: result };
}

export async function listP4ChangeRequestsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT id FROM change_request WHERE project_id = $1
      ORDER BY created_at DESC, id DESC`,
    [projectId],
  );
  const data: Record<string, unknown>[] = [];
  for (const row of rows as { id: string }[]) {
    data.push(await selectChangeRequest(ctx.pool, projectId, row.id));
  }
  return { status: 200, data };
}

export async function getP4WorkVersionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const workVersionId = ctx.params.workVersionId!;
  await requireModernProject(ctx.pool, projectId);
  const { rows } = await ctx.pool.query(
    `SELECT id, project_id, process_instance_id, version, origin,
            change_request_id, base_delivery_release_id, start_gate::text,
            current_gate::text, state, created_by_type::text, created_by,
            created_at, released_at, abandoned_at
       FROM project_work_version WHERE id = $1 AND project_id = $2`,
    [workVersionId, projectId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFoundError(`work version not found: ${workVersionId}`);
  return { status: 200, data: row };
}
