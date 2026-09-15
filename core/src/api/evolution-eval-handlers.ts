/**
 * Dedicated Core-only evolution-eval API.
 *
 * R1 deliberately persists inputs, drafts, isolated workspace revisions and
 * reconciliation intent only. It never calls Connector, Runtime, a host
 * workspace, or a generic project Job endpoint.
 */

import { randomUUID } from "node:crypto";
import {
  appendOutboxEventInTx,
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import {
  EVOLUTION_EVAL_LIMITS,
  EVOLUTION_EVAL_OPERATIONS,
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
  evolutionEvalCanonicalHash,
  portableEvolutionEvalPath,
  portablePathKey,
  requireNfcString,
  validateEvolutionEvalParameters,
  vivadoMediaTypeForPath,
  type EvolutionEvalOperation,
  type EvolutionEvalParametersV1,
  type EvolutionEvalWorkspaceManifestFileV1,
  type EvolutionEvalWorkspaceManifestV1,
} from "../domain/evolution-eval.ts";
import { sha256Hex } from "../hashing.ts";
import {
  claimEvolutionEvalReconcileDutyForRun,
  processEvolutionEvalDuty,
} from "../services/evolution-eval-dispatcher.ts";
import { scanEvolutionEvalXdc } from "../services/evolution-eval-xdc-scan.ts";
import { ConnectorError } from "./connector-port.ts";
import {
  ApiError,
  evolutionEvalApiError,
  evolutionScopeForbiddenError,
} from "./errors.ts";
import type { HandlerResult, RequestContext } from "./handlers.ts";

type QueryClient = Pick<TransactionClient, "query">;
type Row = Record<string, unknown>;

const HASH = /^[0-9a-f]{64}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPAQUE = /^[^\u0000-\u001f\u007f]+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FORBIDDEN_OPERATION_FIELDS = new Set([
  "run_class",
  "run_class_intent",
  "command",
  "raw_tcl",
  "tcl",
  "formal_input_approval_id",
  "baseline_id",
  "gate_submission_id",
  "approval_id",
  "adopt",
  "publish",
  "download",
  "program",
  "hardware",
  "artifact_classification",
  "usage_classification",
]);

interface ClaimApplicationInput {
  readonly applicationId: string;
  readonly evidenceSnapshotHash: string;
}

export interface EvolutionEvalClaimMaterialization {
  readonly evalInputs: ReadonlyMap<string, Record<string, unknown> | null>;
  readonly recovery: Record<string, unknown>;
}

interface SourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly content: Buffer;
}

interface SkillFile {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly language: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly content: string;
}

interface EvalInputSnapshot {
  readonly projectId: string;
  readonly versionId: string;
  readonly sourceCommit: string;
  readonly sourceFiles: readonly SourceFile[];
  readonly skillFiles: readonly SkillFile[];
  readonly part: string | null;
  readonly toolchainProfileHash: string;
  readonly allowedOperations: readonly EvolutionEvalOperation[];
  readonly trialBitstreamAllowed: boolean;
}

interface LockedRun {
  readonly id: string;
  readonly mode: string;
  readonly state: string;
  readonly lease_token: string | null;
  readonly lease_valid: boolean;
}

interface LockedEvalJob extends Row {
  readonly id: string;
  readonly curator_run_id: string;
  readonly project_id: string;
  readonly tool_run_id: string;
  readonly workspace_id: string;
  readonly operation: EvolutionEvalOperation;
  readonly correlation_id: string;
  readonly state: string;
  readonly reconciliation_state: string;
  readonly application_id: string;
  readonly version_id: string;
  readonly deadline_at: Date | string;
}

const TERMINAL_EVAL_STATES = new Set([
  "rejected",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "unknown_effect",
]);
const ACCEPTED_TERMINAL_EVAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
]);
const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function fail(
  code: Parameters<typeof evolutionEvalApiError>[0],
  status: number,
  retryable = false,
  details: unknown = null,
): never {
  throw evolutionEvalApiError(code, status, retryable, details);
}

function invalid(details: unknown = null): never {
  fail("EVOLUTION_EVAL_INVALID_REQUEST", 400, false, details);
}

function assertEvalCapability(ctx: RequestContext): void {
  if (
    ctx.identity.actorType !== "service"
    || ctx.identity.scopes.length !== 1
    || ctx.identity.scopes[0] !== "core:evolution-eval"
  ) {
    throw evolutionScopeForbiddenError();
  }
}

function requireNoQuery(ctx: RequestContext): void {
  if (ctx.url.search.length > 0) invalid({ reason: "query_not_allowed" });
}

function object(value: unknown, label = "request body"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid({ reason: `${label}_must_be_object` });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid({ reason: `${label}_must_be_plain_object` });
  }
  return value as Record<string, unknown>;
}

function canonicalText(value: string, label: string, maxBytes?: number): string {
  try {
    requireNfcString(value, label);
  } catch {
    invalid({ field: label, reason: "nfc" });
  }
  if (CONTROL.test(value) || (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes)) {
    invalid({ field: label });
  }
  return value;
}

function validateRequestJson(value: unknown, label = "request body"): void {
  const visit = (item: unknown, path: string): void => {
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      canonicalText(item, path);
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid({ field: path });
      return;
    }
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item)) invalid({ field: `${path}[${index}]` });
        visit(item[index], `${path}[${index}]`);
      }
      return;
    }
    const record = object(item, path);
    for (const [key, nested] of Object.entries(record)) {
      canonicalText(key, `${path} key`);
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value, label);
}

function requestObject(value: unknown): Record<string, unknown> {
  validateRequestJson(value);
  return object(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[], label = "request body"): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    invalid({ reason: `${label}_shape`, expected });
  }
}

function string(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0) invalid({ field: key });
  return canonicalText(item, key);
}

function opaque(value: Record<string, unknown>, key: string): string {
  const item = string(value, key);
  if (Buffer.byteLength(item, "utf8") > 128 || !OPAQUE.test(item) || CONTROL.test(item)) invalid({ field: key });
  return item;
}

function routeIdentifier(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) invalid({ field: label });
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    invalid({ field: label });
  }
  return canonicalText(decoded, label, 128);
}

function logicalRequestHash(value: unknown): string {
  try {
    return evolutionEvalCanonicalHash(value);
  } catch {
    invalid({ reason: "request_not_canonical" });
  }
}

function hash(value: Record<string, unknown>, key: string): string {
  const item = string(value, key);
  if (!HASH.test(item)) invalid({ field: key });
  return item;
}

function integer(value: Record<string, unknown>, key: string, min: number, max: number): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || (item as number) < min || (item as number) > max) {
    invalid({ field: key });
  }
  return item as number;
}

function assertSchema(body: Record<string, unknown>, schema: string): void {
  if (body.schema !== schema) invalid({ field: "schema", expected: schema });
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function sortedByPortablePath<T extends { readonly path: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => Buffer.compare(
    Buffer.from(portablePathKey(left.path), "utf8"),
    Buffer.from(portablePathKey(right.path), "utf8"),
  ));
}

async function hasProjectAcl(
  query: QueryClient,
  ctx: RequestContext,
  projectId: string,
): Promise<boolean> {
  const result = await query.query(
    `SELECT 1 FROM role_assignment
      WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3 LIMIT 1`,
    [projectId, ctx.identity.actorType, ctx.identity.actorId],
  );
  return result.rows.length > 0;
}

function sourceMediaType(path: string): string {
  try {
    return vivadoMediaTypeForPath(path);
  } catch {
    throw new TypeError("source path is not a supported Vivado input");
  }
}

async function reproducibleInputSnapshot(
  tx: TransactionClient,
  ctx: RequestContext,
  applicationId: string,
): Promise<EvalInputSnapshot | null> {
  const bound = await tx.query(
    `SELECT a.project_id,a.task_id,sas.version_id,tr.result_commit,
            p.target_part,p.toolchain_profile_ref
       FROM skill_application a
       JOIN skill_application_skill sas
         ON sas.application_id=a.id AND sas.role='primary'
       JOIN task_result tr ON tr.task_id=a.task_id AND tr.project_id=a.project_id
       JOIN task_workspace workspace
         ON workspace.id=tr.workspace_id AND workspace.task_id=tr.task_id
        AND workspace.project_id=tr.project_id
       JOIN project p ON p.id=a.project_id
      WHERE a.id=$1 AND workspace.state='sealed'
        AND workspace.head_commit=tr.result_commit
      ORDER BY tr.created_at DESC,tr.id DESC LIMIT 1`,
    [applicationId],
  );
  const row = bound.rows[0] as Row | undefined;
  if (!row) return null;
  const projectId = String(row.project_id);
  if (!await hasProjectAcl(tx, ctx, projectId)) return null;
  const toolchainProfileHash = row.toolchain_profile_ref === null
    ? ""
    : String(row.toolchain_profile_ref);
  const part = row.target_part === null ? null : String(row.target_part);
  if (!HASH.test(toolchainProfileHash) || (part !== null && !PART.test(part))) return null;

  const sourceRows = await tx.query(
    `SELECT path,content_hash,size_bytes,content_text
       FROM task_workspace_file
      WHERE task_id=$1 AND project_id=$2 AND workspace_commit=$3
      ORDER BY path COLLATE "C"`,
    [row.task_id, projectId, row.result_commit],
  );
  if (sourceRows.rows.length === 0) return null;
  const sourceFiles: SourceFile[] = [];
  try {
    for (const raw of sourceRows.rows as Row[]) {
      const path = portableEvolutionEvalPath(String(raw.path));
      const content = Buffer.from(String(raw.content_text), "utf8");
      const sizeBytes = Number(raw.size_bytes);
      const sha256 = String(raw.content_hash);
      if (
        sizeBytes !== content.byteLength
        || sha256Hex(content) !== sha256
        || sizeBytes > EVOLUTION_EVAL_LIMITS.source.fileBytes
      ) return null;
      sourceFiles.push({
        path,
        sha256,
        sizeBytes,
        mediaType: sourceMediaType(path),
        content,
      });
    }
  } catch {
    return null;
  }
  if (
    sourceFiles.length > EVOLUTION_EVAL_LIMITS.source.files
    || sourceFiles.reduce((sum, file) => sum + file.sizeBytes, 0) > EVOLUTION_EVAL_LIMITS.source.bytes
  ) return null;

  const skillResult = await tx.query(
    `SELECT id,path,kind,language,sha256,size_bytes,media_type,content
       FROM learned_skill_file WHERE version_id=$1 ORDER BY path COLLATE "C"`,
    [row.version_id],
  );
  const skillFiles: SkillFile[] = [];
  try {
    for (const raw of skillResult.rows as Row[]) {
      const path = portableEvolutionEvalPath(String(raw.path));
      const content = String(raw.content);
      const sizeBytes = Number(raw.size_bytes);
      if (
        Buffer.byteLength(content, "utf8") !== sizeBytes
        || sha256Hex(content) !== raw.sha256
        || sizeBytes > EVOLUTION_EVAL_LIMITS.skill.fileBytes
      ) return null;
      skillFiles.push({
        id: String(raw.id),
        path,
        kind: String(raw.kind),
        language: raw.language === null ? null : String(raw.language),
        sha256: String(raw.sha256),
        sizeBytes,
        mediaType: String(raw.media_type),
        content,
      });
    }
  } catch {
    return null;
  }
  if (
    skillFiles.length > EVOLUTION_EVAL_LIMITS.skill.files
    || skillFiles.reduce((sum, file) => sum + file.sizeBytes, 0) > EVOLUTION_EVAL_LIMITS.skill.bytes
  ) return null;
  const portableKeys = [...sourceFiles, ...skillFiles].map((file) => portablePathKey(file.path));
  if (new Set(portableKeys).size !== portableKeys.length) return null;

  return {
    projectId,
    versionId: String(row.version_id),
    sourceCommit: String(row.result_commit),
    sourceFiles: sortedByPortablePath(sourceFiles),
    skillFiles: sortedByPortablePath(skillFiles),
    part,
    toolchainProfileHash,
    allowedOperations: part === null
      ? ["validate_sources", "simulate"]
      : [...EVOLUTION_EVAL_OPERATIONS],
    trialBitstreamAllowed: part !== null,
  };
}

function evalInputDto(row: Row): Record<string, unknown> {
  return {
    eval_input_ref: row.eval_input_ref,
    input_manifest_hash: row.input_manifest_hash,
    source_commit: row.source_commit,
    source_manifest_hash: row.source_manifest_hash,
    allowed_operations: row.allowed_operations,
    trial_bitstream_allowed: row.trial_bitstream_allowed,
    part: row.part ?? null,
    toolchain_profile_hash: row.toolchain_profile_hash,
  };
}

async function ensureEvalInput(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
  application: ClaimApplicationInput,
): Promise<Record<string, unknown> | null> {
  const existing = await tx.query(
    "SELECT * FROM evolution_eval_input WHERE curator_run_id=$1 AND application_id=$2",
    [runId, application.applicationId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0] as Row;
    return await hasProjectAcl(tx, ctx, String(row.project_id)) ? evalInputDto(row) : null;
  }
  const snapshot = await reproducibleInputSnapshot(tx, ctx, application.applicationId);
  if (!snapshot) return null;
  const evalInputRef = id("eei");
  const sourceFiles = snapshot.sourceFiles.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size_bytes: file.sizeBytes,
    media_type: file.mediaType,
  }));
  const skillFiles = snapshot.skillFiles.map((file) => ({
    path: file.path,
    kind: file.kind,
    language: file.language,
    sha256: file.sha256,
    size_bytes: file.sizeBytes,
    media_type: file.mediaType,
  }));
  const sourceManifestHash = evolutionEvalCanonicalHash({
    schema: "evolution-eval-source-manifest.v1",
    source_commit: snapshot.sourceCommit,
    files: sourceFiles,
  });
  const manifest = {
    schema: "evolution-eval-input-manifest.v1",
    eval_input_ref: evalInputRef,
    curator_run_id: runId,
    application_id: application.applicationId,
    project_id: snapshot.projectId,
    version_id: snapshot.versionId,
    evidence_snapshot_hash: application.evidenceSnapshotHash,
    source_commit: snapshot.sourceCommit,
    source_manifest_hash: sourceManifestHash,
    allowed_operations: snapshot.allowedOperations,
    trial_bitstream_allowed: snapshot.trialBitstreamAllowed,
    part: snapshot.part,
    toolchain_profile_hash: snapshot.toolchainProfileHash,
    files: sourceFiles,
    skill_files: skillFiles,
  };
  const inputManifestHash = evolutionEvalCanonicalHash(manifest);
  await tx.query(
    `INSERT INTO evolution_eval_input
      (eval_input_ref,curator_run_id,application_id,project_id,version_id,
       evidence_snapshot_hash,input_manifest_hash,source_commit,source_manifest_hash,
       allowed_operations,trial_bitstream_allowed,part,toolchain_profile_hash,input_manifest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      evalInputRef,
      runId,
      application.applicationId,
      snapshot.projectId,
      snapshot.versionId,
      application.evidenceSnapshotHash,
      inputManifestHash,
      snapshot.sourceCommit,
      sourceManifestHash,
      snapshot.allowedOperations,
      snapshot.trialBitstreamAllowed,
      snapshot.part,
      snapshot.toolchainProfileHash,
      JSON.stringify(manifest),
    ],
  );
  for (const file of snapshot.sourceFiles) {
    await tx.query(
      `INSERT INTO evolution_eval_input_file
        (eval_input_ref,path,sha256,size_bytes,media_type,managed_content)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [evalInputRef, file.path, file.sha256, file.sizeBytes, file.mediaType, file.content],
    );
  }
  for (const file of snapshot.skillFiles) {
    await tx.query(
      `INSERT INTO evolution_eval_input_skill_file
        (eval_input_ref,version_id,learned_skill_file_id,path,kind,language,
         sha256,size_bytes,media_type,content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        evalInputRef,
        snapshot.versionId,
        file.id,
        file.path,
        file.kind,
        file.language,
        file.sha256,
        file.sizeBytes,
        file.mediaType,
        file.content,
      ],
    );
  }
  return evalInputDto({
    eval_input_ref: evalInputRef,
    input_manifest_hash: inputManifestHash,
    source_commit: snapshot.sourceCommit,
    source_manifest_hash: sourceManifestHash,
    allowed_operations: snapshot.allowedOperations,
    trial_bitstream_allowed: snapshot.trialBitstreamAllowed,
    part: snapshot.part,
    toolchain_profile_hash: snapshot.toolchainProfileHash,
  });
}

async function markRecoveryRequired(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
): Promise<void> {
  await tx.query(
    "SELECT curator_run_id FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
    [runId],
  );
  const candidates = await tx.query(
    `SELECT job.id,job.curator_run_id,job.project_id,job.workspace_id,
            job.connector_job_id,job.connector_idempotency_key,job.operation,
            tool.correlation_id,projection.current_revision,revision.manifest_hash,
            revision.file_count,revision.total_bytes,
            COALESCE((SELECT max(f.reconciliation_sequence)
                        FROM evolution_eval_reconcile_fact f
                       WHERE f.eval_job_id=job.id),0)::int + 1 AS next_sequence
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_workspace_projection projection
         ON projection.workspace_id=job.workspace_id
       JOIN evolution_eval_workspace_revision revision
         ON revision.workspace_id=job.workspace_id
        AND revision.revision=projection.current_revision
      WHERE job.curator_run_id=$1 AND job.reconciliation_state<>'required'
        AND (
          tool.state='running'
          OR (
            tool.state='submitted'
            AND EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id)
          )
        )
      ORDER BY job.ordinal
      FOR UPDATE OF job,tool`,
    [runId],
  );
  for (const job of candidates.rows as Row[]) {
    const sequence = Number(job.next_sequence);
    const requestHash = logicalRequestHash({
      schema: "evolution-eval-reconcile-intent.v1",
      eval_job_id: job.id,
      connector_job_id: job.connector_job_id,
      connector_idempotency_key: job.connector_idempotency_key,
      reconciliation_sequence: sequence,
      workspace_id: job.workspace_id,
      workspace_revision: Number(job.current_revision),
      workspace_manifest_hash: job.manifest_hash,
    });
    const factId = id("eerf");
    const auditId = id("eea");
    const outboxId = randomUUID();
    const payload = {
      fact_id: factId,
      reconcile_request_hash: requestHash,
      reconciliation_sequence: sequence,
      connector_job_id: job.connector_job_id,
      connector_idempotency_key: job.connector_idempotency_key,
      workspace_id: job.workspace_id,
      workspace_revision: Number(job.current_revision),
      workspace_manifest_hash: job.manifest_hash,
    };
    await tx.query(
      `INSERT INTO evolution_eval_reconcile_fact
        (id,eval_job_id,reconciliation_sequence,reconcile_request_hash,
         workspace_id,workspace_revision,workspace_manifest_hash,audit_event_id,outbox_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        factId,
        job.id,
        sequence,
        requestHash,
        job.workspace_id,
        Number(job.current_revision),
        job.manifest_hash,
        auditId,
        outboxId,
      ],
    );
    await tx.query(
      `INSERT INTO evolution_eval_audit_event
        (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
         correlation_id,request_hash,operation,workspace_manifest_hash,file_count,byte_count)
       VALUES ($1,$2,$3,$4,'reconcile_required',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        auditId,
        runId,
        job.id,
        job.project_id,
        ctx.identity.actorType,
        ctx.identity.actorId,
        job.correlation_id,
        requestHash,
        job.operation,
        job.manifest_hash,
        Number(job.file_count),
        Number(job.total_bytes),
      ],
    );
    await appendOutboxEventInTx(tx, {
      eventId: outboxId,
      aggregateType: "evolution_eval_job",
      aggregateId: String(job.id),
      eventType: "evolution_eval.reconcile_requested",
      projectId: String(job.project_id),
      payload,
      headers: {},
      correlationId: String(job.correlation_id),
      classification: "D1",
    });
    await tx.query(
      "UPDATE evolution_eval_job SET reconciliation_state='required' WHERE id=$1",
      [job.id],
    );
  }
}

async function recoverySnapshot(query: QueryClient, runId: string): Promise<Record<string, unknown>> {
  const runResult = await query.query(
    `SELECT budget_started_at,deadline_at,unknown_effect_latched_at
       FROM evolution_eval_run WHERE curator_run_id=$1`,
    [runId],
  );
  const run = runResult.rows[0] as Row | undefined;
  if (!run) {
    return {
      budget_started_at: null,
      deadline_at: null,
      unknown_effect_latched_at: null,
      jobs: [],
    };
  }
  const jobsResult = await query.query(
    `SELECT job.*,tool.state,workspace_projection.current_revision,
            workspace_revision.manifest_hash AS workspace_manifest_hash,
            workspace_projection.sealed_at,
            COALESCE(array_agg(evidence.fact_type ORDER BY evidence.created_at,evidence.id)
              FILTER (WHERE evidence.id IS NOT NULL),'{}'::text[]) AS evidence_facts,
            max(evidence.manifest_hash) FILTER (WHERE evidence.fact_type='frozen') AS evidence_manifest_hash
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_workspace_projection workspace_projection
         ON workspace_projection.workspace_id=job.workspace_id
       JOIN evolution_eval_workspace_revision workspace_revision
         ON workspace_revision.workspace_id=job.workspace_id
        AND workspace_revision.revision=workspace_projection.current_revision
       LEFT JOIN evolution_eval_evidence_fact evidence ON evidence.eval_job_id=job.id
      WHERE job.curator_run_id=$1
      GROUP BY job.id,tool.state,workspace_projection.current_revision,
               workspace_revision.manifest_hash,workspace_projection.sealed_at
      ORDER BY job.ordinal`,
    [runId],
  );
  return {
    budget_started_at: iso(run.budget_started_at),
    deadline_at: iso(run.deadline_at),
    unknown_effect_latched_at: run.unknown_effect_latched_at === null
      ? null
      : iso(run.unknown_effect_latched_at),
    jobs: (jobsResult.rows as Row[]).map((job) => {
      const facts = new Set((job.evidence_facts as string[] | undefined) ?? []);
      const evidenceState = facts.has("frozen")
        ? "frozen"
        : facts.has("corrupt")
        ? "corrupt"
        : facts.has("unavailable_at_deadline")
        ? "unavailable_at_deadline"
        : facts.has("freeze_pending")
        ? "freeze_pending"
        : "none";
      const retentionState = facts.has("expired")
        ? "expired"
        : facts.has("quarantine_pending")
        ? "quarantine_pending"
        : facts.has("acknowledged")
        ? "acknowledged"
        : facts.has("ack_pending")
        ? "pending_ack"
        : "not_applicable";
      return {
        eval_job_id: job.id,
        tool_run_id: job.tool_run_id,
        application_id: job.application_id,
        version_id: job.version_id,
        ordinal: Number(job.ordinal),
        operation: job.operation,
        state: job.state,
        workspace_id: job.workspace_id,
        workspace_revision: Number(job.current_revision),
        workspace_manifest_hash: job.workspace_manifest_hash,
        workspace_sealed: job.sealed_at !== null,
        evidence_state: evidenceState,
        retention_state: retentionState,
        evidence_manifest_hash: job.evidence_manifest_hash ?? null,
        reconciliation_state: evidenceState === "freeze_pending"
          ? "required"
          : job.reconciliation_state,
      };
    }),
  };
}

/** Called by the Curator claim transaction before the new lease is returned. */
export async function materializeEvolutionEvalClaim(
  tx: TransactionClient,
  ctx: RequestContext,
  run: { readonly id: string; readonly mode: string },
  applications: readonly ClaimApplicationInput[],
): Promise<EvolutionEvalClaimMaterialization> {
  const evalInputs = new Map<string, Record<string, unknown> | null>();
  if (run.mode === "dry_run") {
    for (const application of applications) evalInputs.set(application.applicationId, null);
    return {
      evalInputs,
      recovery: {
        budget_started_at: null,
        deadline_at: null,
        unknown_effect_latched_at: null,
        jobs: [],
      },
    };
  }
  await tx.query(
    `INSERT INTO evolution_eval_run
      (curator_run_id,budget_started_at,deadline_at,created_at)
     VALUES ($1,now(),now()+interval '2 hours',now())
     ON CONFLICT (curator_run_id) DO NOTHING`,
    [run.id],
  );
  const budgetResult = await tx.query(
    "SELECT completed_at FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
    [run.id],
  );
  const budget = budgetResult.rows[0] as Row;
  if (budget.completed_at !== null) {
    for (const application of applications) {
      const existing = await tx.query(
        `SELECT * FROM evolution_eval_input
          WHERE curator_run_id=$1 AND application_id=$2`,
        [run.id, application.applicationId],
      );
      const input = existing.rows[0] as Row | undefined;
      evalInputs.set(
        application.applicationId,
        input && await hasProjectAcl(tx, ctx, String(input.project_id)) ? evalInputDto(input) : null,
      );
    }
    return { evalInputs, recovery: await recoverySnapshot(tx, run.id) };
  }
  for (const application of applications) {
    evalInputs.set(
      application.applicationId,
      await ensureEvalInput(tx, ctx, run.id, application),
    );
  }
  await markRecoveryRequired(tx, ctx, run.id);
  return { evalInputs, recovery: await recoverySnapshot(tx, run.id) };
}

/**
 * Post-commit query-first reconciliation shared by Curator claim and recover.
 * The caller must commit its reconcile intents before entering this function.
 * Each Connector query happens inside `processEvolutionEvalDuty` between its
 * short inspection and settle transactions. A missing/unavailable Connector
 * deliberately leaves the durable `required` projection for later recovery.
 */
export async function reconcileEvolutionEvalAfterCommit(
  ctx: RequestContext,
  runId: string,
): Promise<Record<string, unknown>> {
  const connector = ctx.evolutionEvalConnector;
  if (connector !== undefined) {
    const conn = await ctx.pool.connect();
    try {
      for (let index = 0; index < 3; index += 1) {
        const lease = await claimEvolutionEvalReconcileDutyForRun(
          conn as unknown as TransactionClient,
          runId,
          { holderId: `api-recovery:${ctx.correlationId}` },
        );
        if (!lease) break;
        try {
          await processEvolutionEvalDuty(
            conn as unknown as TransactionClient,
            connector,
            lease,
            { allowNewEffects: false, rolloutEnabled: false },
          );
        } catch (error) {
          if (error instanceof ConnectorError) continue;
          throw error;
        }
      }
    } finally {
      conn.release();
    }
  }
  return recoverySnapshot(ctx.pool as unknown as QueryClient, runId);
}

async function lockRun(
  tx: TransactionClient,
  runId: string,
  leaseToken: string,
): Promise<LockedRun> {
  const result = await tx.query(
    `SELECT id,mode,state,lease_token,
            lease_expires_at>clock_timestamp() AS lease_valid
       FROM curator_run WHERE id=$1 FOR UPDATE`,
    [runId],
  );
  const run = result.rows[0] as LockedRun | undefined;
  if (!run) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
  if (run.lease_token !== leaseToken || run.lease_valid !== true) {
    fail("EVOLUTION_LEASE_CONFLICT", 409, true);
  }
  if (run.mode === "dry_run") fail("EVOLUTION_EVAL_FORBIDDEN", 403);
  if (run.mode !== "run" || run.state !== "running") {
    fail("EVOLUTION_EVAL_RUN_NOT_ACTIVE", 409);
  }
  const evalRun = await tx.query(
    "SELECT completed_at FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
    [runId],
  );
  const evalBudget = evalRun.rows[0] as Row | undefined;
  if (!evalBudget || evalBudget.completed_at !== null) {
    fail("EVOLUTION_EVAL_RUN_NOT_ACTIVE", 409);
  }
  return run;
}

async function requireMutationAllowed(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
): Promise<Row> {
  if (
    ctx.featureFlags?.selfEvolution !== true
    || ctx.featureFlags?.evolutionEvalExecution !== true
  ) fail("EVOLUTION_EVAL_FORBIDDEN", 403);
  const settings = await tx.query(
    "SELECT learning_paused FROM evolution_settings WHERE singleton_id='global' FOR UPDATE",
  );
  if ((settings.rows[0] as Row | undefined)?.learning_paused === true) {
    fail("EVOLUTION_EVAL_FORBIDDEN", 403);
  }
  const result = await tx.query(
    `SELECT *,greatest(0,floor(extract(epoch FROM (deadline_at-clock_timestamp()))*1000))::bigint
              AS remaining_ms
       FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE`,
    [runId],
  );
  const run = result.rows[0] as Row | undefined;
  if (!run || run.unknown_effect_latched_at !== null) {
    fail("EVOLUTION_EVAL_RUN_NOT_ACTIVE", 409);
  }
  if (Number(run.remaining_ms) <= 0) fail("EVOLUTION_EVAL_BUDGET_EXHAUSTED", 409);
  const required = await tx.query(
    `SELECT 1 FROM evolution_eval_job
      WHERE curator_run_id=$1 AND reconciliation_state='required' LIMIT 1`,
    [runId],
  );
  if (required.rows.length > 0) {
    fail("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
  }
  return run;
}

async function requireJobAcl(
  tx: TransactionClient,
  ctx: RequestContext,
  projectId: string,
): Promise<void> {
  if (!await hasProjectAcl(tx, ctx, projectId)) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
}

function idempotencyKey(ctx: RequestContext): string {
  const key = ctx.idempotencyKey;
  if (
    key === null
    || key.length === 0
    || Buffer.byteLength(key, "utf8") > 128
    || !OPAQUE.test(key)
  ) invalid({ header: "Idempotency-Key" });
  return canonicalText(key, "Idempotency-Key", 128);
}

interface IdempotencyReplay {
  readonly responseStatus: number;
  readonly response: Record<string, unknown>;
}

async function claimIdempotency(
  tx: TransactionClient,
  runId: string,
  evalJobId: string | null,
  action: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyReplay | null> {
  const existing = await tx.query(
    `SELECT request_hash,response_status,response FROM evolution_eval_idempotency
      WHERE scope='core:evolution-eval' AND curator_run_id=$1
        AND COALESCE(eval_job_id,'')=COALESCE($2,'') AND action=$3 AND idempotency_key=$4
      FOR UPDATE`,
    [runId, evalJobId, action, key],
  );
  const row = existing.rows[0] as Row | undefined;
  if (row) {
    if (row.request_hash !== requestHash) {
      fail("EVOLUTION_EVAL_IDEMPOTENCY_CONFLICT", 409);
    }
    if (row.response === null || row.response_status === null) {
      fail("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
    }
    return {
      responseStatus: Number(row.response_status),
      response: row.response as Record<string, unknown>,
    };
  }
  await tx.query(
    `INSERT INTO evolution_eval_idempotency
      (id,scope,curator_run_id,eval_job_id,action,idempotency_key,request_hash)
     VALUES ($1,'core:evolution-eval',$2,$3,$4,$5,$6)`,
    [id("eeidem"), runId, evalJobId, action, key, requestHash],
  );
  return null;
}

async function completeIdempotency(
  tx: TransactionClient,
  runId: string,
  evalJobId: string | null,
  action: string,
  key: string,
  status: number,
  response: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `UPDATE evolution_eval_idempotency
        SET response_status=$5,response=$6::jsonb,completed_at=now()
      WHERE scope='core:evolution-eval' AND curator_run_id=$1
        AND COALESCE(eval_job_id,'')=COALESCE($2,'') AND action=$3 AND idempotency_key=$4`,
    [runId, evalJobId, action, key, status, JSON.stringify(response)],
  );
}

async function appendOperationFact(
  tx: TransactionClient,
  ctx: RequestContext,
  job: {
    readonly id: string;
    readonly curatorRunId: string;
    readonly projectId: string;
    readonly operation: EvolutionEvalOperation;
    readonly correlationId: string;
    readonly prepareRequestHash: string;
    readonly inputManifestHash: string;
  },
  factType: "prepare" | "workspace_revision" | "workspace_projection" | "workspace_seal",
  workspace: {
    readonly id: string;
    readonly revision: number;
    readonly manifestHash: string;
    readonly fileCount: number;
    readonly byteCount: number;
  },
): Promise<void> {
  const factId = id("eeof");
  const auditId = id("eea");
  const outboxId = randomUUID();
  const prepare = factType === "prepare";
  const auditType = prepare
    ? "eval_job.prepared"
    : factType === "workspace_revision"
    ? "workspace_revision"
    : factType === "workspace_projection"
    ? "workspace_projection"
    : "workspace_sealed";
  const eventType = prepare
    ? "evolution_eval.job_prepared"
    : factType === "workspace_revision"
    ? "evolution_eval.workspace_revision"
    : factType === "workspace_projection"
    ? "evolution_eval.workspace_projection"
    : "evolution_eval.workspace_sealed";
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,request_hash,operation,workspace_manifest_hash,file_count,byte_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      auditId,
      job.curatorRunId,
      job.id,
      job.projectId,
      auditType,
      ctx.identity.actorType,
      ctx.identity.actorId,
      job.correlationId,
      prepare ? job.prepareRequestHash : null,
      job.operation,
      workspace.manifestHash,
      workspace.fileCount,
      workspace.byteCount,
    ],
  );
  const payload = prepare
    ? {
        fact_id: factId,
        prepare_request_hash: job.prepareRequestHash,
        input_manifest_hash: job.inputManifestHash,
        workspace_manifest_hash: workspace.manifestHash,
      }
    : {
        fact_id: factId,
        workspace_id: workspace.id,
        revision: workspace.revision,
        workspace_manifest_hash: workspace.manifestHash,
        file_count: workspace.fileCount,
        byte_count: workspace.byteCount,
      };
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: job.id,
    eventType,
    projectId: job.projectId,
    payload,
    headers: {},
    correlationId: job.correlationId,
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_operation_fact
      (id,eval_job_id,fact_type,workspace_id,workspace_revision,
       workspace_manifest_hash,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      factId,
      job.id,
      factType,
      prepare ? null : workspace.id,
      prepare ? null : workspace.revision,
      prepare ? null : workspace.manifestHash,
      auditId,
      outboxId,
    ],
  );
}

function forbiddenOperationShape(body: Record<string, unknown>): boolean {
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) => FORBIDDEN_OPERATION_FIELDS.has(key) || visit(nested),
    );
  };
  return visit(body);
}

function prepareBody(ctx: RequestContext): {
  readonly body: Record<string, unknown>;
  readonly leaseToken: string;
  readonly applicationId: string;
  readonly evidenceSnapshotHash: string;
  readonly versionId: string;
  readonly evalInputRef: string;
  readonly inputManifestHash: string;
  readonly operation: EvolutionEvalOperation;
  readonly parameters: EvolutionEvalParametersV1;
  readonly timeoutMs: number;
  readonly requestHash: string;
} {
  const body = requestObject(ctx.body);
  if (forbiddenOperationShape(body)) fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400);
  exact(body, [
    "schema",
    "curator_lease_token",
    "application_id",
    "evidence_snapshot_hash",
    "version_id",
    "eval_input_ref",
    "input_manifest_hash",
    "operation",
    "parameters",
    "timeout_ms",
  ]);
  assertSchema(body, "evolution-eval-prepare.v1");
  const operationValue = body.operation;
  if (
    typeof operationValue !== "string"
    || !EVOLUTION_EVAL_OPERATIONS.includes(operationValue as EvolutionEvalOperation)
  ) fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400);
  const operation = operationValue as EvolutionEvalOperation;
  let parameters: EvolutionEvalParametersV1;
  try {
    parameters = validateEvolutionEvalParameters(operation, body.parameters);
  } catch {
    if (forbiddenOperationShape(object(body.parameters, "parameters"))) {
      fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400);
    }
    invalid({ field: "parameters" });
  }
  const timeout = body.timeout_ms;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > EVOLUTION_EVAL_LIMITS.operationCapMs) {
    fail("EVOLUTION_EVAL_TIMEOUT_INVALID", 400);
  }
  const { curator_lease_token: _lease, ...logicalBody } = body;
  return {
    body,
    leaseToken: opaque(body, "curator_lease_token"),
    applicationId: opaque(body, "application_id"),
    evidenceSnapshotHash: hash(body, "evidence_snapshot_hash"),
    versionId: opaque(body, "version_id"),
    evalInputRef: opaque(body, "eval_input_ref"),
    inputManifestHash: hash(body, "input_manifest_hash"),
    operation,
    parameters,
    timeoutMs: timeout as number,
    requestHash: logicalRequestHash(logicalBody),
  };
}

async function spoolAvailable(tx: TransactionClient): Promise<void> {
  const result = await tx.query(
    `SELECT COALESCE(sum(frozen.total_bytes),0)::bigint AS bytes
       FROM evolution_eval_evidence_fact frozen
      WHERE frozen.fact_type='frozen'
        AND NOT EXISTS (
          SELECT 1 FROM evolution_eval_evidence_fact terminal
           WHERE terminal.eval_job_id=frozen.eval_job_id
             AND terminal.fact_type IN ('acknowledged','expired','cleaned')
        )`,
  );
  if (Number((result.rows[0] as Row).bytes) >= EVOLUTION_EVAL_LIMITS.connectorUnackedSpoolBytes) {
    fail("EVOLUTION_EVAL_SPOOL_FULL", 503, true);
  }
}

export async function prepareEvolutionEvalJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const parsed = prepareBody(ctx);
  const key = idempotencyKey(ctx);
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const conn = await ctx.pool.connect();
  try {
    const outcome = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, parsed.leaseToken);
      const evalRun = await requireMutationAllowed(tx, ctx, runId);
      const inputResult = await tx.query(
        `SELECT * FROM evolution_eval_input
          WHERE eval_input_ref=$1 AND curator_run_id=$2`,
        [parsed.evalInputRef, runId],
      );
      const input = inputResult.rows[0] as Row | undefined;
      if (!input) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
      await requireJobAcl(tx, ctx, String(input.project_id));
      if (
        input.application_id !== parsed.applicationId
        || input.version_id !== parsed.versionId
        || input.evidence_snapshot_hash !== parsed.evidenceSnapshotHash
        || input.input_manifest_hash !== parsed.inputManifestHash
      ) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      if (!(input.allowed_operations as string[]).includes(parsed.operation)) {
        fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400);
      }
      if (
        (parsed.parameters.operation === "synthesize" || parsed.parameters.operation === "implement")
        && parsed.parameters.part !== input.part
      ) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      if (
        parsed.parameters.operation === "implement"
        && parsed.parameters.generate_trial_bitstream
        && input.trial_bitstream_allowed !== true
      ) fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400);
      const replay = await claimIdempotency(tx, runId, null, "prepare", key, parsed.requestHash);
      if (replay) return { status: 200, data: { ...replay.response, replayed: true } };
      await spoolAvailable(tx);

      const jobs = await tx.query(
        `SELECT job.ordinal,tool.state
           FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
          WHERE job.curator_run_id=$1 ORDER BY job.ordinal FOR UPDATE OF job,tool`,
        [runId],
      );
      if (jobs.rows.length >= Number(evalRun.max_jobs)) {
        fail("EVOLUTION_EVAL_BUDGET_EXHAUSTED", 409);
      }
      const prior = jobs.rows.at(-1) as Row | undefined;
      if (prior && !new Set(["rejected", "succeeded", "failed", "cancelled", "timeout"]).has(String(prior.state))) {
        fail("EVOLUTION_EVAL_SERIAL_CONFLICT", 409, true);
      }
      const remainingMs = Number(evalRun.remaining_ms);
      const effectiveTimeoutMs = Math.min(parsed.timeoutMs, EVOLUTION_EVAL_LIMITS.operationCapMs, remainingMs);
      if (effectiveTimeoutMs < 1) fail("EVOLUTION_EVAL_BUDGET_EXHAUSTED", 409);

      const sourceResult = await tx.query(
        `SELECT path,sha256,size_bytes,media_type,managed_content
           FROM evolution_eval_input_file WHERE eval_input_ref=$1`,
        [parsed.evalInputRef],
      );
      const skillResult = await tx.query(
        `SELECT path,sha256,size_bytes,media_type,content
           FROM evolution_eval_input_skill_file WHERE eval_input_ref=$1`,
        [parsed.evalInputRef],
      );
      const sourceBytes = (sourceResult.rows as Row[]).reduce((sum, file) => sum + Number(file.size_bytes), 0);
      const skillBytes = (skillResult.rows as Row[]).reduce((sum, file) => sum + Number(file.size_bytes), 0);
      if (
        sourceResult.rows.length > EVOLUTION_EVAL_LIMITS.source.files
        || sourceBytes > EVOLUTION_EVAL_LIMITS.source.bytes
        || skillResult.rows.length > EVOLUTION_EVAL_LIMITS.skill.files
        || skillBytes > EVOLUTION_EVAL_LIMITS.skill.bytes
      ) fail("EVOLUTION_EVAL_RESOURCE_LIMIT", 413);

      const evalJobId = id("eej");
      const toolRunId = id("eet");
      const workspaceId = id("eew");
      const connectorJobId = id("eec");
      const connectorIdempotencyKey = sha256Hex(`evolution-eval-connector.v1:${evalJobId}`);
      const workspaceFiles: Array<{
        path: string;
        sha256: string;
        sizeBytes: number;
        mediaType: string;
        layer: "source" | "skill";
        content: Buffer;
      }> = [
        ...(sourceResult.rows as Row[]).map((file) => ({
          path: String(file.path),
          sha256: String(file.sha256),
          sizeBytes: Number(file.size_bytes),
          mediaType: String(file.media_type),
          layer: "source" as const,
          content: file.managed_content as Buffer,
        })),
        ...(skillResult.rows as Row[]).map((file) => ({
          path: String(file.path),
          sha256: String(file.sha256),
          sizeBytes: Number(file.size_bytes),
          mediaType: String(file.media_type),
          layer: "skill" as const,
          content: Buffer.from(String(file.content), "utf8"),
        })),
      ];
      let canonicalWorkspace;
      try {
        canonicalWorkspace = canonicalEvolutionEvalWorkspaceManifest({
          schema: "evolution-eval-workspace-manifest.v1",
          workspace_id: workspaceId,
          revision: 1,
          files: workspaceFiles.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            size_bytes: file.sizeBytes,
            media_type: file.mediaType,
            layer: file.layer,
            read_only: true,
          })),
        });
      } catch {
        fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      }
      const fileCount = workspaceFiles.length;
      const totalBytes = sourceBytes + skillBytes;
      if (
        fileCount > EVOLUTION_EVAL_LIMITS.workspace.files
        || totalBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes
      ) fail("EVOLUTION_EVAL_RESOURCE_LIMIT", 413);
      const ordinal = jobs.rows.length + 1;
      const deadlineAt = iso(evalRun.deadline_at);
      await tx.query(
        `INSERT INTO tool_run
          (id,project_id,operation,capability_version,run_class,state,
           input_manifest_hash,authorization_context,toolchain_profile_hash,
           parameters,correlation_id)
         VALUES ($1,$2,$3,'v1','evolution_eval','submitted',$4,$5::jsonb,$6,$7::jsonb,$8)`,
        [
          toolRunId,
          input.project_id,
          parsed.operation,
          parsed.inputManifestHash,
          JSON.stringify({
            schema: "evolution-eval-authorization.v1",
            curator_run_id: runId,
            application_id: parsed.applicationId,
            version_id: parsed.versionId,
          }),
          input.toolchain_profile_hash,
          JSON.stringify(parsed.parameters),
          ctx.correlationId,
        ],
      );
      await tx.query(
        `INSERT INTO evolution_eval_job
          (id,curator_run_id,application_id,project_id,version_id,eval_input_ref,
           input_manifest_hash,evidence_snapshot_hash,tool_run_id,workspace_id,
           connector_job_id,connector_idempotency_key,request_key,prepare_request_hash,
           ordinal,operation,parameters,requested_timeout_ms,effective_timeout_ms,deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17::jsonb,$18,$19,$20)`,
        [
          evalJobId,
          runId,
          parsed.applicationId,
          input.project_id,
          parsed.versionId,
          parsed.evalInputRef,
          parsed.inputManifestHash,
          parsed.evidenceSnapshotHash,
          toolRunId,
          workspaceId,
          connectorJobId,
          connectorIdempotencyKey,
          key,
          parsed.requestHash,
          ordinal,
          parsed.operation,
          JSON.stringify(parsed.parameters),
          parsed.timeoutMs,
          effectiveTimeoutMs,
          deadlineAt,
        ],
      );
      await tx.query(
        `INSERT INTO evolution_eval_workspace
          (id,eval_job_id,eval_input_ref,source_commit,input_manifest_hash,source_manifest_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          workspaceId,
          evalJobId,
          parsed.evalInputRef,
          input.source_commit,
          parsed.inputManifestHash,
          input.source_manifest_hash,
        ],
      );
      await tx.query(
        `INSERT INTO evolution_eval_workspace_revision
          (workspace_id,revision,manifest,manifest_hash,file_count,total_bytes,
           source_files,source_bytes,skill_files,skill_bytes,overlay_files,overlay_bytes)
         VALUES ($1,1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,0,0)`,
        [
          workspaceId,
          JSON.stringify(canonicalWorkspace.manifest),
          canonicalWorkspace.sha256,
          fileCount,
          totalBytes,
          sourceResult.rows.length,
          sourceBytes,
          skillResult.rows.length,
          skillBytes,
        ],
      );
      for (const file of workspaceFiles) {
        await tx.query(
          `INSERT INTO evolution_eval_workspace_file
            (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
           VALUES ($1,1,$2,$3,$4,$5,$6,true,$7)`,
          [workspaceId, file.path, file.sha256, file.sizeBytes, file.mediaType, file.layer, file.content],
        );
      }
      await tx.query(
        `INSERT INTO evolution_eval_workspace_projection(workspace_id,current_revision)
         VALUES ($1,1)`,
        [workspaceId],
      );
      const factJob = {
        id: evalJobId,
        curatorRunId: runId,
        projectId: String(input.project_id),
        operation: parsed.operation,
        correlationId: ctx.correlationId,
        prepareRequestHash: parsed.requestHash,
        inputManifestHash: parsed.inputManifestHash,
      };
      const factWorkspace = {
        id: workspaceId,
        revision: 1,
        manifestHash: canonicalWorkspace.sha256,
        fileCount,
        byteCount: totalBytes,
      };
      await appendOperationFact(tx, ctx, factJob, "prepare", factWorkspace);
      await appendOperationFact(tx, ctx, factJob, "workspace_revision", factWorkspace);
      await appendOperationFact(tx, ctx, factJob, "workspace_projection", factWorkspace);
      const response = {
        schema: "evolution-eval-prepare-result.v1",
        eval_job_id: evalJobId,
        tool_run_id: toolRunId,
        workspace_id: workspaceId,
        ordinal,
        state: "submitted",
        workspace_revision: 1,
        source_commit: input.source_commit,
        source_manifest_hash: input.source_manifest_hash,
        workspace_manifest_hash: canonicalWorkspace.sha256,
        deadline_at: deadlineAt,
        effective_timeout_ms: effectiveTimeoutMs,
        replayed: false,
      };
      await completeIdempotency(tx, runId, null, "prepare", key, 201, response);
      return { status: 201, data: response };
    });
    return outcome;
  } finally {
    conn.release();
  }
}

async function lockJob(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
  evalJobId: string,
  workspaceId: string,
): Promise<LockedEvalJob> {
  const result = await tx.query(
    `SELECT job.*,tool.state,tool.correlation_id
       FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
      WHERE job.id=$1 AND job.curator_run_id=$2 AND job.workspace_id=$3
      FOR UPDATE OF job,tool`,
    [evalJobId, runId, workspaceId],
  );
  const job = result.rows[0] as LockedEvalJob | undefined;
  if (!job) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
  await requireJobAcl(tx, ctx, job.project_id);
  return job;
}

function workspaceReadRequest(ctx: RequestContext): {
  readonly leaseToken: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly paths: string[];
} {
  const body = requestObject(ctx.body);
  exact(body, ["schema", "curator_lease_token", "workspace_id", "workspace_revision", "paths"]);
  assertSchema(body, "evolution-eval-workspace-read.v1");
  if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > EVOLUTION_EVAL_LIMITS.read.paths) {
    invalid({ field: "paths" });
  }
  let paths: string[];
  try {
    paths = body.paths.map((path) => {
      if (typeof path !== "string") throw new TypeError("path");
      return portableEvolutionEvalPath(path);
    });
  } catch {
    invalid({ field: "paths" });
  }
  if (new Set(paths.map(portablePathKey)).size !== paths.length) invalid({ field: "paths" });
  return {
    leaseToken: opaque(body, "curator_lease_token"),
    workspaceId: opaque(body, "workspace_id"),
    revision: integer(body, "workspace_revision", 1, Number.MAX_SAFE_INTEGER),
    paths,
  };
}

export async function readEvolutionEvalWorkspaceHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const request = workspaceReadRequest(ctx);
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const evalJobId = routeIdentifier(ctx.params.evalJobId, "evalJobId");
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, request.leaseToken);
      await lockJob(tx, ctx, runId, evalJobId, request.workspaceId);
      const revisionResult = await tx.query(
        `SELECT manifest_hash FROM evolution_eval_workspace_revision
          WHERE workspace_id=$1 AND revision=$2`,
        [request.workspaceId, request.revision],
      );
      const revision = revisionResult.rows[0] as Row | undefined;
      if (!revision) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
      const files = await tx.query(
        `SELECT path,sha256,size_bytes,media_type,read_only,managed_content
           FROM evolution_eval_workspace_file
          WHERE workspace_id=$1 AND revision=$2 AND path=ANY($3::text[])
          ORDER BY translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                   path COLLATE "C"`,
        [request.workspaceId, request.revision, request.paths],
      );
      if (files.rows.length !== request.paths.length) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
      const totalBytes = (files.rows as Row[]).reduce((sum, file) => sum + Number(file.size_bytes), 0);
      if (totalBytes > EVOLUTION_EVAL_LIMITS.read.bytes) fail("EVOLUTION_EVAL_RESOURCE_LIMIT", 413);
      return {
        status: 200,
        data: {
          schema: "evolution-eval-workspace-files.v1",
          workspace_id: request.workspaceId,
          workspace_revision: request.revision,
          workspace_manifest_hash: revision.manifest_hash,
          files: (files.rows as Row[]).map((file) => ({
            path: file.path,
            sha256: file.sha256,
            size_bytes: Number(file.size_bytes),
            media_type: file.media_type,
            read_only: file.read_only,
            content_base64: (file.managed_content as Buffer).toString("base64"),
          })),
        },
      };
    });
  } finally {
    conn.release();
  }
}

interface WorkspaceChange {
  readonly action: "upsert" | "delete";
  readonly path: string;
  readonly sha256: string | null;
  readonly content: Buffer | null;
  readonly mediaType: string | null;
}

function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) invalid({ field: "content_base64" });
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) invalid({ field: "content_base64" });
  return decoded;
}

function workspaceWriteRequest(ctx: RequestContext): {
  readonly body: Record<string, unknown>;
  readonly leaseToken: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly changes: WorkspaceChange[];
  readonly requestHash: string;
} {
  const body = requestObject(ctx.body);
  exact(body, ["schema", "curator_lease_token", "workspace_id", "expected_workspace_revision", "changes"]);
  assertSchema(body, "evolution-eval-workspace-write.v1");
  if (!Array.isArray(body.changes) || body.changes.length < 1 || body.changes.length > EVOLUTION_EVAL_LIMITS.write.changes) {
    invalid({ field: "changes" });
  }
  const changes = body.changes.map((raw, index): WorkspaceChange => {
    const change = object(raw, `changes[${index}]`);
    if (change.action === "upsert") {
      exact(change, ["action", "path", "sha256", "content_base64"], `changes[${index}]`);
      let path: string;
      let mediaType: string;
      try {
        path = portableEvolutionEvalPath(string(change, "path"));
        mediaType = vivadoMediaTypeForPath(path);
      } catch {
        invalid({ field: `changes[${index}].path` });
      }
      const content = decodeBase64(change.content_base64);
      if (content.byteLength > EVOLUTION_EVAL_LIMITS.overlay.fileBytes) {
        fail("EVOLUTION_EVAL_RESOURCE_LIMIT", 413);
      }
      let contentText: string;
      try {
        contentText = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        invalid({ field: `changes[${index}].content_base64` });
      }
      if (mediaType === "application/x-xdc") {
        const scanned = scanEvolutionEvalXdc(contentText);
        if (scanned.decision !== "pass") {
          fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400, false, {
            field: `changes[${index}].content_base64`,
            finding_codes: scanned.findings.map((finding) => finding.code),
          });
        }
      }
      const expectedHash = hash(change, "sha256");
      if (sha256Hex(content) !== expectedHash) invalid({ field: `changes[${index}].sha256` });
      return { action: "upsert", path, sha256: expectedHash, content, mediaType };
    }
    if (change.action === "delete") {
      exact(change, ["action", "path"], `changes[${index}]`);
      let path: string;
      try {
        path = portableEvolutionEvalPath(string(change, "path"));
      } catch {
        invalid({ field: `changes[${index}].path` });
      }
      return { action: "delete", path, sha256: null, content: null, mediaType: null };
    }
    invalid({ field: `changes[${index}].action` });
  });
  if (new Set(changes.map((change) => portablePathKey(change.path))).size !== changes.length) {
    invalid({ field: "changes" });
  }
  const changedBytes = changes.reduce((sum, change) => sum + (change.content?.byteLength ?? 0), 0);
  if (changedBytes > EVOLUTION_EVAL_LIMITS.write.bytes) fail("EVOLUTION_EVAL_RESOURCE_LIMIT", 413);
  const { curator_lease_token: _lease, ...logicalBody } = body;
  return {
    body,
    leaseToken: opaque(body, "curator_lease_token"),
    workspaceId: opaque(body, "workspace_id"),
    expectedRevision: integer(body, "expected_workspace_revision", 1, Number.MAX_SAFE_INTEGER),
    changes,
    requestHash: logicalRequestHash(logicalBody),
  };
}

export async function writeEvolutionEvalWorkspaceHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const request = workspaceWriteRequest(ctx);
  const key = idempotencyKey(ctx);
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const evalJobId = routeIdentifier(ctx.params.evalJobId, "evalJobId");
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, request.leaseToken);
      await requireMutationAllowed(tx, ctx, runId);
      const job = await lockJob(tx, ctx, runId, evalJobId, request.workspaceId);
      const replay = await claimIdempotency(
        tx,
        runId,
        evalJobId,
        "workspace_write",
        key,
        request.requestHash,
      );
      if (replay) return { status: 200, data: { ...replay.response, replayed: true } };
      if (job.state !== "submitted") fail("EVOLUTION_EVAL_TERMINAL_CONFLICT", 409);
      if (job.reconciliation_state === "required") {
        fail("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
      }
      const projectionResult = await tx.query(
        `SELECT * FROM evolution_eval_workspace_projection
          WHERE workspace_id=$1 FOR UPDATE`,
        [request.workspaceId],
      );
      const projection = projectionResult.rows[0] as Row | undefined;
      if (!projection) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
      if (projection.sealed_at !== null) fail("EVOLUTION_EVAL_WORKSPACE_SEALED", 409);
      if (Number(projection.current_revision) !== request.expectedRevision) {
        fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      }
      const dispatch = await tx.query(
        "SELECT 1 FROM evolution_eval_dispatch WHERE eval_job_id=$1",
        [evalJobId],
      );
      if (dispatch.rows.length > 0) fail("EVOLUTION_EVAL_WORKSPACE_SEALED", 409);
      const currentResult = await tx.query(
        `SELECT path,sha256,size_bytes,media_type,layer,read_only,managed_content
           FROM evolution_eval_workspace_file
          WHERE workspace_id=$1 AND revision=$2`,
        [request.workspaceId, request.expectedRevision],
      );
      const byPortable = new Map(
        (currentResult.rows as Row[]).map((file) => [portablePathKey(String(file.path)), file]),
      );
      for (const change of request.changes) {
        const portable = portablePathKey(change.path);
        const existing = byPortable.get(portable);
        if (change.action === "delete") {
          if (!existing || existing.layer !== "overlay" || existing.path !== change.path) {
            invalid({ field: "changes", reason: "delete_requires_exact_overlay" });
          }
          byPortable.delete(portable);
          continue;
        }
        if (existing && (existing.layer !== "overlay" || existing.path !== change.path)) {
          invalid({ field: "changes", reason: "read_only_or_portable_collision" });
        }
        byPortable.set(portable, {
          path: change.path,
          sha256: change.sha256,
          size_bytes: change.content!.byteLength,
          media_type: change.mediaType,
          layer: "overlay",
          read_only: false,
          managed_content: change.content,
        });
      }
      const files = sortedByPortablePath([...byPortable.values()].map((raw) => ({
        path: String(raw.path),
        sha256: String(raw.sha256),
        sizeBytes: Number(raw.size_bytes),
        mediaType: String(raw.media_type),
        layer: raw.layer as "source" | "skill" | "overlay",
        readOnly: raw.read_only === true,
        content: raw.managed_content as Buffer,
      })));
      const counters = {
        sourceFiles: files.filter((file) => file.layer === "source").length,
        sourceBytes: files.filter((file) => file.layer === "source").reduce((sum, file) => sum + file.sizeBytes, 0),
        skillFiles: files.filter((file) => file.layer === "skill").length,
        skillBytes: files.filter((file) => file.layer === "skill").reduce((sum, file) => sum + file.sizeBytes, 0),
        overlayFiles: files.filter((file) => file.layer === "overlay").length,
        overlayBytes: files.filter((file) => file.layer === "overlay").reduce((sum, file) => sum + file.sizeBytes, 0),
      };
      const totalBytes = counters.sourceBytes + counters.skillBytes + counters.overlayBytes;
      if (
        counters.sourceFiles > EVOLUTION_EVAL_LIMITS.source.files
        || counters.sourceBytes > EVOLUTION_EVAL_LIMITS.source.bytes
        || counters.skillFiles > EVOLUTION_EVAL_LIMITS.skill.files
        || counters.skillBytes > EVOLUTION_EVAL_LIMITS.skill.bytes
        || counters.overlayFiles > EVOLUTION_EVAL_LIMITS.overlay.files
        || counters.overlayBytes > EVOLUTION_EVAL_LIMITS.overlay.bytes
        || files.length > EVOLUTION_EVAL_LIMITS.workspace.files
        || totalBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes
      ) fail("EVOLUTION_EVAL_RESOURCE_LIMIT", 413);
      const revision = request.expectedRevision + 1;
      const canonical = canonicalEvolutionEvalWorkspaceManifest({
        schema: "evolution-eval-workspace-manifest.v1",
        workspace_id: request.workspaceId,
        revision,
        files: files.map((file): EvolutionEvalWorkspaceManifestFileV1 => ({
          path: file.path,
          sha256: file.sha256,
          size_bytes: file.sizeBytes,
          media_type: file.mediaType,
          layer: file.layer,
          read_only: file.readOnly,
        })),
      });
      await tx.query(
        `INSERT INTO evolution_eval_workspace_revision
          (workspace_id,revision,manifest,manifest_hash,file_count,total_bytes,
           source_files,source_bytes,skill_files,skill_bytes,overlay_files,overlay_bytes)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          request.workspaceId,
          revision,
          JSON.stringify(canonical.manifest),
          canonical.sha256,
          files.length,
          totalBytes,
          counters.sourceFiles,
          counters.sourceBytes,
          counters.skillFiles,
          counters.skillBytes,
          counters.overlayFiles,
          counters.overlayBytes,
        ],
      );
      for (const file of files) {
        await tx.query(
          `INSERT INTO evolution_eval_workspace_file
            (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            request.workspaceId,
            revision,
            file.path,
            file.sha256,
            file.sizeBytes,
            file.mediaType,
            file.layer,
            file.readOnly,
            file.content,
          ],
        );
      }
      await tx.query(
        `UPDATE evolution_eval_workspace_projection
            SET current_revision=$2,updated_at=now()
          WHERE workspace_id=$1`,
        [request.workspaceId, revision],
      );
      const factJob = {
        id: evalJobId,
        curatorRunId: runId,
        projectId: job.project_id,
        operation: job.operation,
        correlationId: job.correlation_id,
        prepareRequestHash: String(job.prepare_request_hash),
        inputManifestHash: String(job.input_manifest_hash),
      };
      const factWorkspace = {
        id: request.workspaceId,
        revision,
        manifestHash: canonical.sha256,
        fileCount: files.length,
        byteCount: totalBytes,
      };
      await appendOperationFact(tx, ctx, factJob, "workspace_revision", factWorkspace);
      await appendOperationFact(tx, ctx, factJob, "workspace_projection", factWorkspace);
      const response = {
        schema: "evolution-eval-workspace-result.v1",
        workspace_id: request.workspaceId,
        workspace_revision: revision,
        workspace_manifest_hash: canonical.sha256,
        file_count: files.length,
        total_bytes: totalBytes,
        replayed: false,
      };
      await completeIdempotency(tx, runId, evalJobId, "workspace_write", key, 200, response);
      return { status: 200, data: response };
    });
  } finally {
    conn.release();
  }
}

export async function recoverEvolutionEvalJobsHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const body = requestObject(ctx.body);
  exact(body, ["schema", "curator_lease_token"]);
  assertSchema(body, "evolution-eval-recover.v1");
  const leaseToken = opaque(body, "curator_lease_token");
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const conn = await ctx.pool.connect();
  try {
    await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, leaseToken);
      const projects = await tx.query(
        "SELECT DISTINCT project_id FROM evolution_eval_job WHERE curator_run_id=$1",
        [runId],
      );
      for (const row of projects.rows as Row[]) await requireJobAcl(tx, ctx, String(row.project_id));
      await applyEvolutionEvalDeadlineCutoff(tx, ctx, runId);
      await markRecoveryRequired(tx, ctx, runId);
    });
  } finally {
    conn.release();
  }
  return {
    status: 200,
    data: await reconcileEvolutionEvalAfterCommit(ctx, runId),
  };
}

async function lockBoundJob(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
  evalJobId: string,
): Promise<LockedEvalJob> {
  const result = await tx.query(
    `SELECT job.*,tool.state::text,tool.correlation_id,tool.error_code,
            projection.current_revision,projection.sealed_at,
            revision.manifest AS workspace_manifest,
            revision.manifest_hash AS workspace_manifest_hash,
            revision.file_count,revision.total_bytes
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_workspace_projection projection
         ON projection.workspace_id=job.workspace_id
       JOIN evolution_eval_workspace_revision revision
         ON revision.workspace_id=job.workspace_id
        AND revision.revision=projection.current_revision
      WHERE job.id=$1 AND job.curator_run_id=$2
      FOR UPDATE OF job,tool,projection`,
    [evalJobId, runId],
  );
  const job = result.rows[0] as LockedEvalJob | undefined;
  if (!job) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
  await requireJobAcl(tx, ctx, job.project_id);
  return job;
}

function bodyWithoutLease(body: Record<string, unknown>): Record<string, unknown> {
  const { curator_lease_token: _lease, ...logical } = body;
  return logical;
}

function evidenceState(facts: ReadonlySet<string>): string {
  if (facts.has("frozen")) return "frozen";
  if (facts.has("corrupt")) return "corrupt";
  if (facts.has("unavailable_at_deadline")) return "unavailable_at_deadline";
  if (facts.has("freeze_pending")) return "freeze_pending";
  return "none";
}

function retentionState(facts: ReadonlySet<string>): string {
  if (facts.has("expired")) return "expired";
  if (facts.has("quarantine_pending")) return "quarantine_pending";
  if (facts.has("acknowledged")) return "acknowledged";
  if (facts.has("ack_pending")) return "pending_ack";
  return "not_applicable";
}

async function evolutionEvalStatus(
  query: QueryClient,
  runId: string,
  evalJobId: string,
  replayed: boolean,
): Promise<Record<string, unknown>> {
  const result = await query.query(
    `SELECT job.*,tool.state::text,tool.error_code,
            revision.manifest_hash AS workspace_manifest_hash,
            COALESCE(array_agg(fact.fact_type ORDER BY fact.created_at,fact.id)
              FILTER (WHERE fact.id IS NOT NULL),'{}'::text[]) AS evidence_facts,
            max(fact.manifest_hash) FILTER (WHERE fact.fact_type='frozen') AS evidence_manifest_hash
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_workspace_projection projection
         ON projection.workspace_id=job.workspace_id
       JOIN evolution_eval_workspace_revision revision
         ON revision.workspace_id=job.workspace_id
        AND revision.revision=projection.current_revision
       LEFT JOIN evolution_eval_evidence_fact fact ON fact.eval_job_id=job.id
      WHERE job.id=$1 AND job.curator_run_id=$2
      GROUP BY job.id,tool.state,tool.error_code,revision.manifest_hash`,
    [evalJobId, runId],
  );
  const job = result.rows[0] as Row | undefined;
  if (!job) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
  const facts = new Set((job.evidence_facts as string[] | undefined) ?? []);
  const projectedEvidenceState = evidenceState(facts);
  return {
    schema: "evolution-eval-status.v1",
    eval_job_id: job.id,
    tool_run_id: job.tool_run_id,
    curator_run_id: job.curator_run_id,
    application_id: job.application_id,
    version_id: job.version_id,
    ordinal: Number(job.ordinal),
    operation: job.operation,
    run_class: "evolution_eval",
    state: job.state,
    deadline_at: iso(job.deadline_at),
    error_code: job.error_code ?? null,
    workspace_manifest_hash: job.workspace_manifest_hash,
    evidence_manifest_hash: job.evidence_manifest_hash ?? null,
    evidence_state: projectedEvidenceState,
    retention_state: retentionState(facts),
    reconciliation_state: projectedEvidenceState === "freeze_pending"
      ? "required"
      : job.reconciliation_state,
    replayed,
  };
}

async function appendTransitionFact(
  tx: TransactionClient,
  ctx: RequestContext,
  job: LockedEvalJob,
  fromState: string,
  toState: string,
): Promise<void> {
  const sequenceResult = await tx.query(
    `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
       FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
    [job.id],
  );
  const sequence = Number((sequenceResult.rows[0] as Row).sequence);
  const factId = id("eetf");
  const auditId = id("eea");
  const outboxId = randomUUID();
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,from_state,to_state,operation)
     VALUES ($1,$2,$3,$4,'tool_run_transition',$5,$6,$7,$8,$9,$10)`,
    [
      auditId,
      job.curator_run_id,
      job.id,
      job.project_id,
      ctx.identity.actorType,
      ctx.identity.actorId,
      job.correlation_id,
      fromState,
      toState,
      job.operation,
    ],
  );
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.id),
    eventType: "evolution_eval.tool_run_transition",
    projectId: job.project_id,
    payload: { from_state: fromState, to_state: toState },
    headers: {},
    correlationId: job.correlation_id,
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_transition_fact
      (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [factId, job.id, sequence, fromState, toState, auditId, outboxId],
  );
}

async function appendDispatchTombstone(
  tx: TransactionClient,
  ctx: RequestContext,
  job: LockedEvalJob,
  reasonCode: string,
  errorHash: string,
): Promise<boolean> {
  const existing = await tx.query(
    "SELECT 1 FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1",
    [job.id],
  );
  if (existing.rows.length > 0) return false;
  const auditId = id("eea");
  const outboxId = randomUUID();
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,request_hash,operation,error_code)
     VALUES ($1,$2,$3,$4,'dispatch_tombstone',$5,$6,$7,$8,$9,$10)`,
    [
      auditId,
      job.curator_run_id,
      job.id,
      job.project_id,
      ctx.identity.actorType,
      ctx.identity.actorId,
      job.correlation_id,
      errorHash,
      job.operation,
      reasonCode,
    ],
  );
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.id),
    eventType: "evolution_eval.dispatch_tombstoned",
    projectId: job.project_id,
    payload: { error_hash: errorHash },
    headers: {},
    correlationId: job.correlation_id,
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_dispatch_tombstone
      (eval_job_id,reason_code,error_hash,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [job.id, reasonCode, errorHash, auditId, outboxId],
  );
  return true;
}

type EvidenceFactType =
  | "freeze_pending"
  | "frozen"
  | "corrupt"
  | "unavailable_at_deadline"
  | "ack_pending"
  | "acknowledged"
  | "quarantine_pending"
  | "expired"
  | "cleanup_pending"
  | "cleaned";

async function appendEvidenceFact(
  tx: TransactionClient,
  ctx: RequestContext,
  job: LockedEvalJob,
  factType: EvidenceFactType,
  options: {
    readonly factHash: string;
    readonly manifestHash?: string;
    readonly errorCode?: string;
  },
): Promise<string> {
  const factId = id("eeef");
  const auditId = id("eea");
  const outboxId = randomUUID();
  const eventType = factType === "freeze_pending"
    ? "evolution_eval.evidence.freeze_requested"
    : factType === "ack_pending"
    ? "evolution_eval.evidence.ack_requested"
    : `evolution_eval.evidence.${factType === "quarantine_pending" ? "quarantine_requested" : factType === "cleanup_pending" ? "cleanup_requested" : factType}`;
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,request_hash,operation,evidence_manifest_hash,error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      auditId,
      job.curator_run_id,
      job.id,
      job.project_id,
      `evidence.${factType}`,
      ctx.identity.actorType,
      ctx.identity.actorId,
      job.correlation_id,
      options.factHash,
      job.operation,
      options.manifestHash ?? null,
      options.errorCode ?? null,
    ],
  );
  const payload: Record<string, unknown> = {
    fact_id: factId,
    fact_type: factType,
    fact_hash: options.factHash,
  };
  if (options.manifestHash !== undefined) payload.manifest_hash = options.manifestHash;
  if (options.errorCode !== undefined) payload.error_code = options.errorCode;
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.id),
    eventType,
    projectId: job.project_id,
    payload,
    headers: {},
    correlationId: job.correlation_id,
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_evidence_fact
      (id,eval_job_id,fact_type,manifest_hash,error_code,fact_hash,
       audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      factId,
      job.id,
      factType,
      options.manifestHash ?? null,
      options.errorCode ?? null,
      options.factHash,
      auditId,
      outboxId,
    ],
  );
  return factId;
}

async function rejectBeforeEffect(
  tx: TransactionClient,
  ctx: RequestContext,
  job: LockedEvalJob,
  reasonCode: string,
): Promise<void> {
  const errorHash = logicalRequestHash({
    schema: "evolution-eval-dispatch-tombstone.v1",
    eval_job_id: job.id,
    reason_code: reasonCode,
  });
  await appendDispatchTombstone(tx, ctx, job, reasonCode, errorHash);
  if (job.state === "submitted") {
    await appendTransitionFact(tx, ctx, job, "submitted", "rejected");
    await tx.query(
      `UPDATE tool_run SET state='rejected',error_code=$2,end_time=clock_timestamp()
        WHERE id=$1 AND state='submitted'`,
      [job.tool_run_id, reasonCode],
    );
  }
}

async function appendUnavailableAtDeadline(
  tx: TransactionClient,
  ctx: RequestContext,
  job: LockedEvalJob,
): Promise<void> {
  const factsResult = await tx.query(
    "SELECT fact_type FROM evolution_eval_evidence_fact WHERE eval_job_id=$1",
    [job.id],
  );
  const facts = new Set((factsResult.rows as Row[]).map((row) => String(row.fact_type)));
  if (facts.has("frozen") || facts.has("corrupt") || facts.has("unavailable_at_deadline")) return;
  const errorCode = "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE";
  const unavailableHash = logicalRequestHash({
    schema: "evolution-eval-evidence-deadline.v1",
    eval_job_id: job.id,
    deadline_at: iso(job.deadline_at),
    error_code: errorCode,
  });
  await appendEvidenceFact(tx, ctx, job, "unavailable_at_deadline", {
    factHash: unavailableHash,
    errorCode,
  });
  const cleanupHash = logicalRequestHash({
    schema: "evolution-eval-evidence-cleanup.v1",
    eval_job_id: job.id,
    cause_fact_hash: unavailableHash,
  });
  await appendEvidenceFact(tx, ctx, job, "cleanup_pending", { factHash: cleanupHash });
}

async function applyEvolutionEvalDeadlineCutoff(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
): Promise<void> {
  const runResult = await tx.query(
    `SELECT deadline_at<=clock_timestamp() AS expired
       FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE`,
    [runId],
  );
  if ((runResult.rows[0] as Row | undefined)?.expired !== true) return;
  const result = await tx.query(
    `SELECT job.*,tool.state::text,tool.correlation_id,tool.error_code,
            projection.current_revision,projection.sealed_at,
            revision.manifest_hash AS workspace_manifest_hash
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_workspace_projection projection ON projection.workspace_id=job.workspace_id
       JOIN evolution_eval_workspace_revision revision
         ON revision.workspace_id=job.workspace_id AND revision.revision=projection.current_revision
      WHERE job.curator_run_id=$1 ORDER BY job.ordinal
      FOR UPDATE OF job,tool,projection`,
    [runId],
  );
  for (const raw of result.rows as Row[]) {
    const job = raw as LockedEvalJob;
    if (job.state === "submitted") {
      await rejectBeforeEffect(tx, ctx, job, "EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH");
    } else if (job.state === "running") {
      const errorHash = logicalRequestHash({
        schema: "evolution-eval-deadline-cancel.v1",
        eval_job_id: job.id,
        deadline_at: iso(job.deadline_at),
      });
      await appendDispatchTombstone(
        tx,
        ctx,
        job,
        "EVOLUTION_EVAL_DEADLINE_CANCEL_REQUESTED",
        errorHash,
      );
    } else if (ACCEPTED_TERMINAL_EVAL_STATES.has(job.state)) {
      await appendUnavailableAtDeadline(tx, ctx, job);
    }
  }
}

function submitRequest(ctx: RequestContext): {
  readonly leaseToken: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly expectedManifestHash: string;
  readonly requestHash: string;
} {
  const body = requestObject(ctx.body);
  exact(body, [
    "schema",
    "curator_lease_token",
    "workspace_id",
    "expected_workspace_revision",
    "expected_workspace_manifest_hash",
  ]);
  assertSchema(body, "evolution-eval-submit.v1");
  return {
    leaseToken: opaque(body, "curator_lease_token"),
    workspaceId: opaque(body, "workspace_id"),
    expectedRevision: integer(body, "expected_workspace_revision", 1, Number.MAX_SAFE_INTEGER),
    expectedManifestHash: hash(body, "expected_workspace_manifest_hash"),
    requestHash: logicalRequestHash(bodyWithoutLease(body)),
  };
}

async function validateSealedDispatchInputs(
  tx: TransactionClient,
  job: LockedEvalJob,
): Promise<void> {
  const paths = new Set<string>([
    ...((job.parameters as EvolutionEvalParametersV1).source_paths ?? []),
    ...(((job.parameters as EvolutionEvalParametersV1 & { constraint_paths?: string[] }).constraint_paths) ?? []),
  ]);
  if (paths.size === 0) invalid({ field: "parameters.source_paths" });
  const result = await tx.query(
    `SELECT path,layer,media_type,managed_content
       FROM evolution_eval_workspace_file
      WHERE workspace_id=$1 AND revision=$2 AND path=ANY($3::text[])`,
    [job.workspace_id, Number(job.current_revision), [...paths]],
  );
  if (result.rows.length !== paths.size) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
  for (const row of result.rows as Row[]) {
    if (row.layer === "skill") fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400);
    const path = String(row.path);
    try {
      const expected = sourceMediaType(path);
      if (row.media_type !== expected) throw new TypeError("media");
      new TextDecoder("utf-8", { fatal: true }).decode(row.managed_content as Uint8Array);
      if (expected === "application/x-xdc") {
        const scan = scanEvolutionEvalXdc(
          Buffer.from(row.managed_content as Uint8Array).toString("utf8"),
        );
        if (scan.decision !== "pass") {
          fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400, false, {
            path,
            finding_codes: scan.findings.map((finding) => finding.code),
          });
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      fail("EVOLUTION_EVAL_OPERATION_FORBIDDEN", 400, false, { path });
    }
  }
}

export async function submitEvolutionEvalJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const request = submitRequest(ctx);
  const key = idempotencyKey(ctx);
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const evalJobId = routeIdentifier(ctx.params.evalJobId, "evalJobId");
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, request.leaseToken);
      // The current lease, authoritative run lock, job binding and source ACL
      // are all revalidated before replay.  A completed same-hash replay is a
      // read of an already committed fact, so reconciliation/mutation gates
      // must not hide it from a newly claimed holder.
      await tx.query(
        "SELECT curator_run_id FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
        [runId],
      );
      const job = await lockBoundJob(tx, ctx, runId, evalJobId);
      if (job.workspace_id !== request.workspaceId) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
      const replay = await claimIdempotency(tx, runId, evalJobId, "submit", key, request.requestHash);
      if (replay) return { status: 200, data: { ...replay.response, replayed: true } };
      await requireMutationAllowed(tx, ctx, runId);
      if (job.state !== "submitted") fail("EVOLUTION_EVAL_TERMINAL_CONFLICT", 409);
      if (job.reconciliation_state === "required") {
        fail("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
      }
      if (job.sealed_at !== null) fail("EVOLUTION_EVAL_WORKSPACE_SEALED", 409);
      const existingDispatch = await tx.query(
        "SELECT 1 FROM evolution_eval_dispatch WHERE eval_job_id=$1",
        [evalJobId],
      );
      if (existingDispatch.rows.length > 0) fail("EVOLUTION_EVAL_WORKSPACE_SEALED", 409);
      if (
        Number(job.current_revision) !== request.expectedRevision
        || job.workspace_manifest_hash !== request.expectedManifestHash
      ) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      await spoolAvailable(tx);
      await validateSealedDispatchInputs(tx, job);
      const inputResult = await tx.query(
        `SELECT part,toolchain_profile_hash FROM evolution_eval_input
          WHERE eval_input_ref=$1`,
        [job.eval_input_ref],
      );
      const input = inputResult.rows[0] as Row | undefined;
      if (!input) fail("EVOLUTION_EVAL_NOT_FOUND", 404);
      let sealedInputProjectionHash: string;
      try {
        const fullManifest = job.workspace_manifest as EvolutionEvalWorkspaceManifestV1;
        if (
          canonicalEvolutionEvalWorkspaceManifest(fullManifest).sha256
          !== job.workspace_manifest_hash
        ) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
        sealedInputProjectionHash = canonicalEvolutionEvalSealedInputProjection(
          fullManifest,
        ).sha256;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      }
      const dispatchRequestHash = logicalRequestHash({
        schema: "evolution-eval-dispatch-request.v1",
        eval_job_id: job.id,
        connector_job_id: job.connector_job_id,
        connector_idempotency_key: job.connector_idempotency_key,
        eval_input_ref: job.eval_input_ref,
        input_manifest_hash: job.input_manifest_hash,
        workspace_id: job.workspace_id,
        workspace_revision: Number(job.current_revision),
        workspace_manifest_hash: job.workspace_manifest_hash,
        sealed_input_projection_hash: sealedInputProjectionHash,
        operation: job.operation,
        parameters: job.parameters,
        part: input.part ?? null,
        toolchain_profile_hash: input.toolchain_profile_hash,
        requested_timeout_ms: Number(job.requested_timeout_ms),
        operation_cap_ms: EVOLUTION_EVAL_LIMITS.operationCapMs,
        deadline_at: iso(job.deadline_at),
        run_class: "evolution_eval",
      });
      await tx.query(
        `UPDATE evolution_eval_workspace_projection
            SET sealed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND current_revision=$2 AND sealed_at IS NULL`,
        [job.workspace_id, Number(job.current_revision)],
      );
      const factJob = {
        id: job.id,
        curatorRunId: job.curator_run_id,
        projectId: job.project_id,
        operation: job.operation as EvolutionEvalOperation,
        correlationId: job.correlation_id,
        prepareRequestHash: String(job.prepare_request_hash),
        inputManifestHash: String(job.input_manifest_hash),
      };
      const factWorkspace = {
        id: job.workspace_id,
        revision: Number(job.current_revision),
        manifestHash: String(job.workspace_manifest_hash),
        fileCount: Number(job.file_count),
        byteCount: Number(job.total_bytes),
      };
      await appendOperationFact(tx, ctx, factJob, "workspace_seal", factWorkspace);
      const auditId = id("eea");
      const outboxId = randomUUID();
      await tx.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,request_hash,operation,workspace_manifest_hash)
         VALUES ($1,$2,$3,$4,'dispatch_sealed',$5,$6,$7,$8,$9,$10)`,
        [
          auditId,
          runId,
          job.id,
          job.project_id,
          ctx.identity.actorType,
          ctx.identity.actorId,
          job.correlation_id,
          dispatchRequestHash,
          job.operation,
          job.workspace_manifest_hash,
        ],
      );
      await appendOutboxEventInTx(tx, {
        eventId: outboxId,
        aggregateType: "evolution_eval_job",
        aggregateId: String(job.id),
        eventType: "evolution_eval.dispatch_requested",
        projectId: job.project_id,
        payload: { dispatch_request_hash: dispatchRequestHash },
        headers: {},
        correlationId: job.correlation_id,
        classification: "D1",
      });
      await tx.query(
        `INSERT INTO evolution_eval_dispatch
          (eval_job_id,workspace_id,workspace_revision,workspace_manifest_hash,
           sealed_input_projection_hash,dispatch_request_hash,
           requested_timeout_ms,operation_cap_ms,deadline_at,
           audit_event_id,outbox_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          job.id,
          job.workspace_id,
          Number(job.current_revision),
          job.workspace_manifest_hash,
          sealedInputProjectionHash,
          dispatchRequestHash,
          Number(job.requested_timeout_ms),
          EVOLUTION_EVAL_LIMITS.operationCapMs,
          job.deadline_at,
          auditId,
          outboxId,
        ],
      );
      const response = await evolutionEvalStatus(tx, runId, evalJobId, false);
      await completeIdempotency(tx, runId, evalJobId, "submit", key, 202, response);
      return { status: 202, data: response };
    });
  } finally {
    conn.release();
  }
}

export async function statusEvolutionEvalJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const body = requestObject(ctx.body);
  exact(body, ["schema", "curator_lease_token"]);
  assertSchema(body, "evolution-eval-status-request.v1");
  const leaseToken = opaque(body, "curator_lease_token");
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const evalJobId = routeIdentifier(ctx.params.evalJobId, "evalJobId");
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, leaseToken);
      await lockBoundJob(tx, ctx, runId, evalJobId);
      await applyEvolutionEvalDeadlineCutoff(tx, ctx, runId);
      await markRecoveryRequired(tx, ctx, runId);
      return { status: 200, data: await evolutionEvalStatus(tx, runId, evalJobId, false) };
    });
  } finally {
    conn.release();
  }
}

export async function cancelEvolutionEvalJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const body = requestObject(ctx.body);
  exact(body, ["schema", "curator_lease_token", "reason_code"]);
  assertSchema(body, "evolution-eval-cancel.v1");
  const leaseToken = opaque(body, "curator_lease_token");
  const reasonCode = string(body, "reason_code");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reasonCode)) invalid({ field: "reason_code" });
  const requestHash = logicalRequestHash(bodyWithoutLease(body));
  const key = idempotencyKey(ctx);
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const evalJobId = routeIdentifier(ctx.params.evalJobId, "evalJobId");
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, leaseToken);
      const job = await lockBoundJob(tx, ctx, runId, evalJobId);
      const replay = await claimIdempotency(tx, runId, evalJobId, "cancel", key, requestHash);
      if (replay) return { status: 200, data: { ...replay.response, replayed: true } };
      let status = 200;
      if (job.state === "submitted") {
        await rejectBeforeEffect(tx, ctx, job, "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH");
      } else if (job.state === "running") {
        const errorHash = logicalRequestHash({
          schema: "evolution-eval-cancel-intent.v1",
          eval_job_id: job.id,
          reason_code: reasonCode,
        });
        await appendDispatchTombstone(tx, ctx, job, reasonCode, errorHash);
        status = 202;
      } else if (!TERMINAL_EVAL_STATES.has(job.state)) {
        fail("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
      }
      const response = await evolutionEvalStatus(tx, runId, evalJobId, false);
      await completeIdempotency(tx, runId, evalJobId, "cancel", key, status, response);
      return { status, data: response };
    });
  } finally {
    conn.release();
  }
}

async function frozenEvidenceManifest(
  query: QueryClient,
  evalJobId: string,
  replayed: boolean,
): Promise<Record<string, unknown> | null> {
  const factResult = await query.query(
    `SELECT fact.id,fact.manifest_hash,job.tool_run_id,
            EXISTS (SELECT 1 FROM evolution_eval_evidence_fact acknowledged
                     WHERE acknowledged.eval_job_id=job.id
                       AND acknowledged.fact_type='acknowledged') AS acknowledged
       FROM evolution_eval_evidence_fact fact
       JOIN evolution_eval_job job ON job.id=fact.eval_job_id
      WHERE fact.eval_job_id=$1 AND fact.fact_type='frozen'`,
    [evalJobId],
  );
  const fact = factResult.rows[0] as Row | undefined;
  if (!fact) return null;
  const entries = await query.query(
    `SELECT name,sha256,size_bytes,media_type,artifact_classification,usage_classification
       FROM evolution_eval_evidence_entry WHERE evidence_fact_id=$1
      ORDER BY name COLLATE "C"`,
    [fact.id],
  );
  return {
    schema: "evolution-eval-evidence-manifest.v1",
    eval_job_id: evalJobId,
    tool_run_id: fact.tool_run_id,
    manifest_hash: fact.manifest_hash,
    evidence_state: "frozen",
    retention_state: fact.acknowledged === true ? "acknowledged" : "pending_ack",
    entries: (entries.rows as Row[]).map((entry) => ({
      name: entry.name,
      sha256: entry.sha256,
      size_bytes: Number(entry.size_bytes),
      media_type: entry.media_type,
      artifact_classification: entry.artifact_classification,
      usage_classification: entry.usage_classification,
    })),
    replayed,
  };
}

export async function evolutionEvalEvidenceHandler(ctx: RequestContext): Promise<HandlerResult> {
  assertEvalCapability(ctx);
  requireNoQuery(ctx);
  const body = requestObject(ctx.body);
  const action = body.action;
  if (action === "freeze") exact(body, ["schema", "curator_lease_token", "action"]);
  else if (action === "ack") {
    exact(body, ["schema", "curator_lease_token", "action", "expected_manifest_hash"]);
  } else if (action === "read") {
    exact(body, ["schema", "curator_lease_token", "action", "name", "expected_sha256"]);
  } else invalid({ field: "action" });
  assertSchema(body, "evolution-eval-evidence.v1");
  const leaseToken = opaque(body, "curator_lease_token");
  const runId = routeIdentifier(ctx.params.runId, "runId");
  const evalJobId = routeIdentifier(ctx.params.evalJobId, "evalJobId");
  const requestHash = logicalRequestHash(bodyWithoutLease(body));
  const conn = await ctx.pool.connect();
  try {
    return await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await lockRun(tx, runId, leaseToken);
      const job = await lockBoundJob(tx, ctx, runId, evalJobId);
      if (action === "read") {
        const name = string(body, "name");
        if (!EVIDENCE_NAME.test(name)) invalid({ field: "name" });
        const expectedSha256 = hash(body, "expected_sha256");
        const result = await tx.query(
          `SELECT entry.name,entry.sha256,entry.size_bytes,entry.media_type,entry.managed_content
             FROM evolution_eval_evidence_entry entry
             JOIN evolution_eval_evidence_fact fact
               ON fact.id=entry.evidence_fact_id AND fact.fact_type='frozen'
            WHERE entry.eval_job_id=$1 AND entry.name=$2`,
          [evalJobId, name],
        );
        const entry = result.rows[0] as Row | undefined;
        if (!entry) fail("EVOLUTION_EVAL_EVIDENCE_NOT_READY", 409, true);
        const bytes = Buffer.from(entry.managed_content as Uint8Array);
        if (
          entry.sha256 !== expectedSha256
          || bytes.byteLength !== Number(entry.size_bytes)
          || sha256Hex(bytes) !== entry.sha256
        ) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
        return {
          status: 200,
          data: {
            schema: "evolution-eval-evidence-content.v1",
            name,
            sha256: entry.sha256,
            size_bytes: Number(entry.size_bytes),
            media_type: entry.media_type,
            content_base64: bytes.toString("base64"),
          },
        };
      }
      const key = idempotencyKey(ctx);
      const actionName = action === "freeze" ? "evidence_freeze" : "evidence_ack";
      const replay = await claimIdempotency(tx, runId, evalJobId, actionName, key, requestHash);
      if (replay) return { status: replay.responseStatus, data: { ...replay.response, replayed: true } };
      const frozen = await frozenEvidenceManifest(tx, evalJobId, false);
      if (action === "freeze") {
        if (frozen) {
          await completeIdempotency(tx, runId, evalJobId, actionName, key, 200, frozen);
          return { status: 200, data: frozen };
        }
        const unusableConclusion = await tx.query(
          `SELECT 1 FROM evolution_eval_evidence_fact
            WHERE eval_job_id=$1
              AND fact_type IN ('corrupt','unavailable_at_deadline')
            LIMIT 1`,
          [evalJobId],
        );
        if (
          unusableConclusion.rows.length > 0
          || !ACCEPTED_TERMINAL_EVAL_STATES.has(job.state)
          || job.error_code === "EVOLUTION_EVAL_NOT_ACCEPTED"
        ) {
          fail("EVOLUTION_EVAL_EVIDENCE_NOT_READY", 409, true);
        }
        const existing = await tx.query(
          "SELECT 1 FROM evolution_eval_evidence_fact WHERE eval_job_id=$1 AND fact_type='freeze_pending'",
          [evalJobId],
        );
        if (existing.rows.length === 0) {
          await appendEvidenceFact(tx, ctx, job, "freeze_pending", { factHash: requestHash });
        }
        const response = {
          schema: "evolution-eval-evidence-pending.v1",
          eval_job_id: evalJobId,
          action: "freeze",
          duty_state: "freeze_pending",
          replayed: existing.rows.length > 0,
        };
        await completeIdempotency(tx, runId, evalJobId, actionName, key, 202, response);
        return { status: 202, data: response };
      }
      const expectedManifestHash = hash(body, "expected_manifest_hash");
      const unusableRetention = await tx.query(
        `SELECT 1 FROM evolution_eval_evidence_fact
          WHERE eval_job_id=$1
            AND fact_type IN (
              'corrupt','unavailable_at_deadline','quarantine_pending','expired'
            )
          LIMIT 1`,
        [evalJobId],
      );
      if (unusableRetention.rows.length > 0) {
        fail("EVOLUTION_EVAL_EVIDENCE_NOT_READY", 409, true);
      }
      if (!frozen) fail("EVOLUTION_EVAL_EVIDENCE_NOT_READY", 409, true);
      if (frozen.manifest_hash !== expectedManifestHash) fail("EVOLUTION_EVAL_BINDING_CONFLICT", 409);
      if (frozen.retention_state === "acknowledged") {
        await completeIdempotency(tx, runId, evalJobId, actionName, key, 200, frozen);
        return { status: 200, data: frozen };
      }
      const existing = await tx.query(
        "SELECT 1 FROM evolution_eval_evidence_fact WHERE eval_job_id=$1 AND fact_type='ack_pending'",
        [evalJobId],
      );
      if (existing.rows.length === 0) {
        await appendEvidenceFact(tx, ctx, job, "ack_pending", {
          factHash: requestHash,
          manifestHash: expectedManifestHash,
        });
      }
      const response = {
        schema: "evolution-eval-evidence-pending.v1",
        eval_job_id: evalJobId,
        action: "ack",
        duty_state: "ack_pending",
        replayed: existing.rows.length > 0,
      };
      await completeIdempotency(tx, runId, evalJobId, actionName, key, 202, response);
      return { status: 202, data: response };
    });
  } finally {
    conn.release();
  }
}
