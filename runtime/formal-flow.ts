import { sha256Hex } from "../core/src/hashing.ts";
import type { ToolRunState } from "../core/src/domain/enums.ts";

export const FORMAL_G4_OPERATIONS = [
  "validate_sources",
  "simulate",
  "synthesize",
  "implement",
] as const;
export type FormalG4Operation = (typeof FORMAL_G4_OPERATIONS)[number];

/** Canonical set order embedded in formal-input.v1. */
export const FORMAL_G4_ALLOWED_OPERATIONS = [
  "implement",
  "simulate",
  "synthesize",
  "validate_sources",
] as const satisfies readonly FormalG4Operation[];

export interface ReadinessCheckV1 {
  readonly code: string;
  readonly severity: "hard" | "advisory";
  readonly passed: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ProjectReadinessRecordV1 {
  readonly id: string;
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly workVersionId: string;
  readonly status: "draft" | "confirmed";
  readonly state: "ready" | "blocked";
  readonly ready: boolean;
  readonly readinessHash: string;
  readonly resultHash: string;
  readonly engineeringConfig: Readonly<Record<string, unknown>>;
  readonly engineeringConfigHash: string;
  readonly targetPart: string;
  readonly boardRef: string;
  readonly workspaceReady: boolean;
  readonly dataScopeRecorded: boolean;
  readonly sourceMaterialsRecorded: boolean;
  readonly pinConstraintsComplete: boolean;
  readonly electricalConstraintsComplete: boolean;
  readonly clockConstraintsComplete: boolean;
  readonly constraintsComplete: boolean;
  readonly constraintRevisionIds: readonly string[];
  readonly toolchainProfileHash: string | null;
  readonly generatedByType: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly checks: readonly ReadinessCheckV1[];
}

export interface FormalInputFileV1 {
  readonly revisionId: string;
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageUri: string;
}

export interface FormalInputPreviewV1 {
  readonly schema: "formal-input-preview.v1";
  readonly workVersionId: string;
  readonly snapshotId: string;
  readonly readinessId: string;
  readonly authorizedTaskId: string;
  readonly prerequisiteBaselineId: string;
  readonly targetPart: string;
  readonly toolchainProfileHash: string;
  readonly constraintsComplete: boolean;
  readonly purpose: "g4_delivery";
  readonly allowedOperations: typeof FORMAL_G4_ALLOWED_OPERATIONS;
  readonly files: readonly FormalInputFileV1[];
  readonly inputHash: string;
  readonly previewHash: string;
}

export interface FormalInputApprovalV1 extends FormalInputPreviewV1 {
  readonly id: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export interface FormalJobBindingV1 {
  readonly jobId: string;
  readonly state: ToolRunState;
  readonly operation: FormalG4Operation;
  readonly runClass: "formal";
  readonly formalInputApprovalId: string;
  readonly inputSnapshotId: string;
  readonly inputHash: string;
  readonly toolchainProfileHash: string;
  readonly errorCode?: string;
  readonly outputSha256?: string;
}

export interface FrozenEvidenceEntryV1 {
  readonly name: string;
  readonly role: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly storageUri: string;
  readonly completeness: "full" | "partial";
  readonly corrupt: boolean;
  readonly verdict: unknown;
}

export interface FrozenEvidenceManifestV1 {
  readonly schema: "evidence-manifest.v1";
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly runState: ToolRunState;
  readonly operation: FormalG4Operation;
  readonly runClass: "formal";
  readonly inputHash: string;
  readonly toolchainProfileHash: string;
  readonly manifestHash: string;
  readonly frozenAt: string;
  readonly verdicts: Readonly<Record<string, unknown>>;
  readonly entries: readonly FrozenEvidenceEntryV1[];
}

export interface GateEvaluationItemV1 {
  readonly id: string;
  readonly checkCode: string;
  readonly severity: "hard" | "advisory";
  readonly passed: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly unknown[];
}

export interface GateEvaluationV1 {
  readonly id: string;
  readonly projectId: string;
  readonly gateSubmissionId: string;
  readonly workVersionId: string;
  readonly snapshotId: string;
  readonly snapshotManifestHash: string;
  readonly profileHash: string;
  readonly resultHash: string;
  readonly passed: boolean;
  readonly sealedProjectionHash: string | null;
  readonly deliveryReleaseId: string | null;
  readonly deliveryReleaseVersion: number | null;
  readonly supersedesReleaseId: string | null;
  readonly evaluatedAt: string;
  readonly items: readonly GateEvaluationItemV1[];
}

export interface EvaluatedGateSubmissionV1 {
  readonly id: string;
  readonly projectId: string;
  readonly gate: "G1" | "G2" | "G3" | "G4";
  readonly state: "in_review" | "approved";
  readonly gateCheckEvaluationId: string;
  readonly checkResultsHash: string;
}

export interface BitstreamResultV1 {
  readonly id: string;
  readonly projectId: string;
  readonly workVersionId: string;
  readonly toolRunId: string;
  readonly evidenceManifestId: string;
  readonly evidenceManifestHash: string;
  readonly evidenceEntryName: string;
  readonly class: "trial" | "formal";
  readonly formalInputApprovalId: string | null;
  readonly snapshotId: string | null;
  readonly readinessId: string | null;
  readonly inputHash: string;
  readonly engineeringConfigHash: string;
  readonly prerequisiteBaselineId: string | null;
  readonly targetPart: string;
  readonly toolchainProfileHash: string;
  readonly constraintHash: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageUri: string;
  readonly generatedByType: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly createdAt: string;
}

export interface DeliveryReleaseV1 {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly supersedesReleaseId: string | null;
  readonly processVersionId: string;
  readonly processInstanceId: string;
  readonly workVersionId: string;
  readonly gateSubmissionId: string;
  readonly gateCheckEvaluationId: string;
  readonly candidateManifestHash: string;
  readonly approvalRecordId: string;
  readonly approvedGateResultId: string;
  readonly baselineId: string;
  readonly formalInputApprovalId: string;
  readonly bitstreamResultId: string;
  readonly schemaVersion: "delivery-manifest.v1";
  readonly manifestHash: string;
  readonly itemCount: number;
  readonly state: "sealed";
  readonly generatedByType: string;
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly createdAt: string;
  readonly releasedAt: string;
}

export interface FormalFlowClient {
  prepareReadiness(input: {
    id: string;
    workVersionId: string;
    engineeringConfig: Readonly<Record<string, unknown>>;
    sourceSnapshotIds: readonly string[];
    workspaceExpectedCommit: string;
    workspaceManifestHash: string;
    reason: string;
  }): Promise<ProjectReadinessRecordV1>;
  confirmReadiness(id: string, reason: string): Promise<ProjectReadinessRecordV1>;
  listReadiness(): Promise<readonly ProjectReadinessRecordV1[]>;
  previewFormalInput(input: {
    workVersionId: string;
    snapshotId: string;
    readinessId: string;
    authorizedTaskId: string;
  }): Promise<FormalInputPreviewV1>;
  confirmFormalInput(input: {
    id: string;
    workVersionId: string;
    snapshotId: string;
    readinessId: string;
    authorizedTaskId: string;
    purpose: "g4_delivery";
    previewHash: string;
  }): Promise<FormalInputApprovalV1>;
  getFormalInputApproval(id: string): Promise<FormalInputApprovalV1>;
  submitFormalJob(
    operation: FormalG4Operation,
    formalInputApprovalId: string,
    idempotencyKey: string,
  ): Promise<FormalJobBindingV1>;
  getFormalJob(jobId: string): Promise<FormalJobBindingV1>;
  freezeFormalEvidence(
    jobId: string,
    idempotencyKey: string,
    manifestHash?: string,
  ): Promise<FrozenEvidenceManifestV1>;
  getFormalEvidence(jobId: string): Promise<FrozenEvidenceManifestV1>;
  createGateEvaluation(input: {
    submissionId: string;
    evaluationId: string;
    workVersionId: string;
    expectedSnapshotManifestHash: string;
  }): Promise<GateEvaluationV1>;
  listGateEvaluations(submissionId: string): Promise<readonly GateEvaluationV1[]>;
  submitEvaluatedGate(input: {
    submissionId: string;
    evaluationId: string;
    resultHash: string;
  }): Promise<EvaluatedGateSubmissionV1>;
  listBitstreams(): Promise<readonly BitstreamResultV1[]>;
  listDeliveryReleases(): Promise<readonly DeliveryReleaseV1[]>;
}

export class FormalFlowError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "FormalFlowError";
  }
}

const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_PATH_PART = /^(?!\.\.?$)[^/\\\u0000-\u001f\u007f]+$/u;
const TERMINAL_JOB_STATES = new Set<ToolRunState>([
  "succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect", "rejected",
]);

function shape(message: string): never {
  throw new FormalFlowError(message, "FORMAL_FLOW_RESPONSE_INVALID");
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) shape(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(row, key)) || Object.keys(row).some((key) => !allowed.has(key))) {
    shape(`${path} has unexpected or missing fields`);
  }
}

function text(value: unknown, path: string, id = false): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    shape(`${path} must be a non-empty safe string`);
  }
  if (new TextEncoder().encode(value).length > 1024 || id && !SAFE_ID.test(value)) shape(`${path} is invalid`);
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH.test(value)) shape(`${path} must be a lowercase SHA-256 digest`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") shape(`${path} must be a boolean`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) shape(`${path} must be a non-negative safe integer`);
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path);
  if (Number.isNaN(Date.parse(result))) shape(`${path} must be a timestamp`);
  return result;
}

function nullableText(value: unknown, path: string, id = true): string | null {
  return value === null ? null : text(value, path, id);
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

function objectValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return record(value, path);
}

function stringArray(value: unknown, path: string, ids = true): string[] {
  if (!Array.isArray(value)) shape(`${path} must be an array`);
  const values = value.map((item, index) => text(item, `${path}[${index}]`, ids));
  if (new Set(values).size !== values.length) shape(`${path} must be unique`);
  return values;
}

function safePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => !SAFE_PATH_PART.test(part))) {
    shape(`${path} must be a safe relative path`);
  }
  return result;
}

function formalOperation(value: unknown, path: string): FormalG4Operation {
  if (typeof value !== "string" || !FORMAL_G4_OPERATIONS.includes(value as FormalG4Operation)) {
    shape(`${path} is not a formal G4 operation`);
  }
  return value as FormalG4Operation;
}

function toolState(value: unknown, path: string): ToolRunState {
  const states: readonly ToolRunState[] = [
    "submitted", "rejected", "queued", "preparing", "running", "succeeded", "failed",
    "cancelling", "cancelled", "timeout", "lost", "unknown_effect",
  ];
  if (typeof value !== "string" || !states.includes(value as ToolRunState)) shape(`${path} is invalid`);
  return value as ToolRunState;
}

export function parseProjectReadinessRecord(value: unknown, expectedProjectId: string): ProjectReadinessRecordV1 {
  const row = record(value, "readiness");
  exact(row, [
    "id", "project_id", "process_instance_id", "work_version_id", "status", "state", "ready",
    "readiness_hash", "result_hash", "engineering_config", "engineering_config_hash", "target_part",
    "board_ref", "workspace_ready", "data_scope_recorded", "source_materials_recorded",
    "pin_constraints_complete", "electrical_constraints_complete", "clock_constraints_complete",
    "constraints_complete", "constraint_revision_ids", "toolchain_profile_hash", "generated_by_type",
    "generated_by", "generated_at", "confirmed_by", "confirmed_at", "checks",
  ], [], "readiness");
  const projectId = text(row.project_id, "readiness.project_id", true);
  if (projectId !== expectedProjectId) throw new FormalFlowError("readiness belongs to another project", "PROJECT_OWNERSHIP_MISMATCH");
  if (row.status !== "draft" && row.status !== "confirmed") shape("readiness.status is invalid");
  if (row.state !== "ready" && row.state !== "blocked") shape("readiness.state is invalid");
  const ready = bool(row.ready, "readiness.ready");
  if (ready !== (row.status === "confirmed" && row.state === "ready")) shape("readiness.ready disagrees with status/state");
  const pin = bool(row.pin_constraints_complete, "readiness.pin_constraints_complete");
  const electrical = bool(row.electrical_constraints_complete, "readiness.electrical_constraints_complete");
  const clock = bool(row.clock_constraints_complete, "readiness.clock_constraints_complete");
  const complete = bool(row.constraints_complete, "readiness.constraints_complete");
  if (complete !== (pin && electrical && clock)) shape("readiness.constraints_complete is inconsistent");
  const confirmedBy = row.confirmed_by === null ? null : text(row.confirmed_by, "readiness.confirmed_by", true);
  const confirmedAt = row.confirmed_at === null ? null : timestamp(row.confirmed_at, "readiness.confirmed_at");
  if ((confirmedBy === null) !== (confirmedAt === null) || (row.status === "confirmed") !== (confirmedBy !== null)) {
    shape("readiness confirmation facts are inconsistent");
  }
  if (!Array.isArray(row.checks)) shape("readiness.checks must be an array");
  const checks = row.checks.map((value, index): ReadinessCheckV1 => {
    const check = record(value, `readiness.checks[${index}]`);
    exact(check, ["code", "severity", "passed", "details"], [], `readiness.checks[${index}]`);
    if (check.severity !== "hard" && check.severity !== "advisory") shape(`readiness.checks[${index}].severity is invalid`);
    return {
      code: text(check.code, `readiness.checks[${index}].code`),
      severity: check.severity,
      passed: bool(check.passed, `readiness.checks[${index}].passed`),
      details: objectValue(check.details, `readiness.checks[${index}].details`),
    };
  });
  if (new Set(checks.map((check) => check.code)).size !== checks.length) shape("readiness checks must be unique");
  const toolchainProfileHash = row.toolchain_profile_hash === null
    ? null
    : hash(row.toolchain_profile_hash, "readiness.toolchain_profile_hash");
  if (row.state === "ready" && toolchainProfileHash === null) {
    shape("a ready readiness must have a bound toolchain profile hash");
  }
  return {
    id: text(row.id, "readiness.id", true),
    projectId,
    processInstanceId: text(row.process_instance_id, "readiness.process_instance_id", true),
    workVersionId: text(row.work_version_id, "readiness.work_version_id", true),
    status: row.status,
    state: row.state,
    ready,
    readinessHash: hash(row.readiness_hash, "readiness.readiness_hash"),
    resultHash: hash(row.result_hash, "readiness.result_hash"),
    engineeringConfig: objectValue(row.engineering_config, "readiness.engineering_config"),
    engineeringConfigHash: hash(row.engineering_config_hash, "readiness.engineering_config_hash"),
    targetPart: text(row.target_part, "readiness.target_part"),
    boardRef: text(row.board_ref, "readiness.board_ref"),
    workspaceReady: bool(row.workspace_ready, "readiness.workspace_ready"),
    dataScopeRecorded: bool(row.data_scope_recorded, "readiness.data_scope_recorded"),
    sourceMaterialsRecorded: bool(row.source_materials_recorded, "readiness.source_materials_recorded"),
    pinConstraintsComplete: pin,
    electricalConstraintsComplete: electrical,
    clockConstraintsComplete: clock,
    constraintsComplete: complete,
    constraintRevisionIds: stringArray(row.constraint_revision_ids, "readiness.constraint_revision_ids"),
    toolchainProfileHash,
    generatedByType: text(row.generated_by_type, "readiness.generated_by_type", true),
    generatedBy: text(row.generated_by, "readiness.generated_by", true),
    generatedAt: timestamp(row.generated_at, "readiness.generated_at"),
    confirmedBy,
    confirmedAt,
    checks,
  };
}

const PREVIEW_KEYS = [
  "schema", "work_version_id", "snapshot_id", "readiness_id", "authorized_task_id",
  "prerequisite_baseline_id", "target_part", "toolchain_profile_hash", "constraints_complete",
  "purpose", "allowed_operations", "files", "input_hash", "preview_hash",
] as const;

function parseFormalInputBase(value: unknown, approval: boolean): FormalInputPreviewV1 & Partial<Pick<FormalInputApprovalV1, "id" | "confirmedBy" | "confirmedAt">> {
  const row = record(value, approval ? "formalApproval" : "formalPreview");
  exact(row, approval ? [...PREVIEW_KEYS, "id", "confirmed_by", "confirmed_at"] : PREVIEW_KEYS, [], approval ? "formalApproval" : "formalPreview");
  if (row.schema !== "formal-input-preview.v1" || row.purpose !== "g4_delivery") shape("formal input schema/purpose is invalid");
  if (!Array.isArray(row.allowed_operations) || row.allowed_operations.join("\0") !== FORMAL_G4_ALLOWED_OPERATIONS.join("\0")) {
    shape("formal input allowed_operations must be the canonical four-operation set");
  }
  if (!Array.isArray(row.files) || row.files.length === 0) shape("formal input files must be non-empty");
  const files = row.files.map((value, index): FormalInputFileV1 => {
    const file = record(value, `formalInput.files[${index}]`);
    exact(file, ["revision_id", "path", "role", "sha256", "size_bytes", "storage_uri"], [], `formalInput.files[${index}]`);
    return {
      revisionId: text(file.revision_id, `formalInput.files[${index}].revision_id`, true),
      path: safePath(file.path, `formalInput.files[${index}].path`),
      role: text(file.role, `formalInput.files[${index}].role`, true),
      sha256: hash(file.sha256, `formalInput.files[${index}].sha256`),
      sizeBytes: integer(file.size_bytes, `formalInput.files[${index}].size_bytes`),
      storageUri: text(file.storage_uri, `formalInput.files[${index}].storage_uri`),
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length || new Set(files.map((file) => file.revisionId)).size !== files.length) {
    shape("formal input files must have unique paths and revisions");
  }
  const preview: FormalInputPreviewV1 = {
    schema: "formal-input-preview.v1",
    workVersionId: text(row.work_version_id, "formalInput.work_version_id", true),
    snapshotId: text(row.snapshot_id, "formalInput.snapshot_id", true),
    readinessId: text(row.readiness_id, "formalInput.readiness_id", true),
    authorizedTaskId: text(row.authorized_task_id, "formalInput.authorized_task_id", true),
    prerequisiteBaselineId: text(row.prerequisite_baseline_id, "formalInput.prerequisite_baseline_id", true),
    targetPart: text(row.target_part, "formalInput.target_part"),
    toolchainProfileHash: hash(row.toolchain_profile_hash, "formalInput.toolchain_profile_hash"),
    constraintsComplete: bool(row.constraints_complete, "formalInput.constraints_complete"),
    purpose: "g4_delivery",
    allowedOperations: FORMAL_G4_ALLOWED_OPERATIONS,
    files,
    inputHash: hash(row.input_hash, "formalInput.input_hash"),
    previewHash: hash(row.preview_hash, "formalInput.preview_hash"),
  };
  if (approval) {
    return {
      ...preview,
      id: text(row.id, "formalApproval.id", true),
      confirmedBy: text(row.confirmed_by, "formalApproval.confirmed_by", true),
      confirmedAt: timestamp(row.confirmed_at, "formalApproval.confirmed_at"),
    };
  }
  return preview;
}

export function parseFormalInputPreview(value: unknown): FormalInputPreviewV1 {
  return parseFormalInputBase(value, false) as FormalInputPreviewV1;
}

export function parseFormalInputApproval(value: unknown): FormalInputApprovalV1 {
  return parseFormalInputBase(value, true) as FormalInputApprovalV1;
}

export function parseFormalJobBinding(value: unknown): FormalJobBindingV1 {
  const row = record(value, "formalJob");
  exact(row, [
    "jobId", "state", "operation", "runClass", "formalInputApprovalId", "inputSnapshotId",
    "inputHash", "toolchainProfileHash",
  ], ["errorCode", "outputSha256"], "formalJob");
  if (row.runClass !== "formal") shape("formalJob.runClass must be formal");
  return {
    jobId: text(row.jobId, "formalJob.jobId", true),
    state: toolState(row.state, "formalJob.state"),
    operation: formalOperation(row.operation, "formalJob.operation"),
    runClass: "formal",
    formalInputApprovalId: text(row.formalInputApprovalId, "formalJob.formalInputApprovalId", true),
    inputSnapshotId: text(row.inputSnapshotId, "formalJob.inputSnapshotId", true),
    inputHash: hash(row.inputHash, "formalJob.inputHash"),
    toolchainProfileHash: hash(row.toolchainProfileHash, "formalJob.toolchainProfileHash"),
    ...(row.errorCode === undefined ? {} : { errorCode: text(row.errorCode, "formalJob.errorCode", true) }),
    ...(row.outputSha256 === undefined ? {} : { outputSha256: hash(row.outputSha256, "formalJob.outputSha256") }),
  };
}

export function parseFrozenEvidenceManifest(value: unknown, expectedProjectId: string): FrozenEvidenceManifestV1 {
  const row = record(value, "evidenceManifest");
  exact(row, [
    "schema", "id", "jobId", "projectId", "runState", "operation", "runClass", "inputHash",
    "toolchainProfileHash", "manifestHash", "frozenAt", "verdicts", "entries",
  ], [], "evidenceManifest");
  if (row.schema !== "evidence-manifest.v1" || row.runClass !== "formal") shape("evidence manifest schema/runClass is invalid");
  const projectId = text(row.projectId, "evidenceManifest.projectId", true);
  if (projectId !== expectedProjectId) throw new FormalFlowError("evidence manifest belongs to another project", "PROJECT_OWNERSHIP_MISMATCH");
  if (!Array.isArray(row.entries) || row.entries.length === 0) shape("evidence manifest entries must be non-empty");
  const entries = row.entries.map((value, index): FrozenEvidenceEntryV1 => {
    const entry = record(value, `evidenceManifest.entries[${index}]`);
    exact(entry, ["name", "role", "sha256", "sizeBytes", "mediaType", "storageUri", "completeness", "corrupt", "verdict"], [], `evidenceManifest.entries[${index}]`);
    if (entry.completeness !== "full" && entry.completeness !== "partial") shape(`evidenceManifest.entries[${index}].completeness is invalid`);
    return {
      name: safePath(entry.name, `evidenceManifest.entries[${index}].name`),
      role: text(entry.role, `evidenceManifest.entries[${index}].role`, true),
      sha256: hash(entry.sha256, `evidenceManifest.entries[${index}].sha256`),
      sizeBytes: integer(entry.sizeBytes, `evidenceManifest.entries[${index}].sizeBytes`),
      mediaType: text(entry.mediaType, `evidenceManifest.entries[${index}].mediaType`),
      storageUri: text(entry.storageUri, `evidenceManifest.entries[${index}].storageUri`),
      completeness: entry.completeness,
      corrupt: bool(entry.corrupt, `evidenceManifest.entries[${index}].corrupt`),
      verdict: entry.verdict,
    };
  });
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) shape("evidence entry names must be unique");
  return {
    schema: "evidence-manifest.v1",
    id: text(row.id, "evidenceManifest.id", true),
    jobId: text(row.jobId, "evidenceManifest.jobId", true),
    projectId,
    runState: toolState(row.runState, "evidenceManifest.runState"),
    operation: formalOperation(row.operation, "evidenceManifest.operation"),
    runClass: "formal",
    inputHash: hash(row.inputHash, "evidenceManifest.inputHash"),
    toolchainProfileHash: hash(row.toolchainProfileHash, "evidenceManifest.toolchainProfileHash"),
    manifestHash: hash(row.manifestHash, "evidenceManifest.manifestHash"),
    frozenAt: timestamp(row.frozenAt, "evidenceManifest.frozenAt"),
    verdicts: objectValue(row.verdicts, "evidenceManifest.verdicts"),
    entries,
  };
}

export function parseGateEvaluation(value: unknown, expectedProjectId: string): GateEvaluationV1 {
  const row = record(value, "gateEvaluation");
  exact(row, [
    "id", "project_id", "gate_submission_id", "work_version_id", "snapshot_id",
    "snapshot_manifest_hash", "profile_hash", "result_hash", "passed",
    "sealed_projection_hash", "delivery_release_id", "delivery_release_version",
    "supersedes_release_id", "evaluated_at", "items",
  ], [], "gateEvaluation");
  const projectId = text(row.project_id, "gateEvaluation.project_id", true);
  if (projectId !== expectedProjectId) throw new FormalFlowError("gate evaluation belongs to another project", "PROJECT_OWNERSHIP_MISMATCH");
  if (!Array.isArray(row.items) || row.items.length === 0) shape("gateEvaluation.items must be non-empty");
  const items = row.items.map((value, index): GateEvaluationItemV1 => {
    const item = record(value, `gateEvaluation.items[${index}]`);
    exact(item, ["id", "check_code", "severity", "passed", "details", "evidence_refs"], [], `gateEvaluation.items[${index}]`);
    if (item.severity !== "hard" && item.severity !== "advisory") shape(`gateEvaluation.items[${index}].severity is invalid`);
    if (!Array.isArray(item.evidence_refs)) shape(`gateEvaluation.items[${index}].evidence_refs must be an array`);
    return {
      id: text(item.id, `gateEvaluation.items[${index}].id`, true),
      checkCode: text(item.check_code, `gateEvaluation.items[${index}].check_code`),
      severity: item.severity,
      passed: bool(item.passed, `gateEvaluation.items[${index}].passed`),
      details: objectValue(item.details, `gateEvaluation.items[${index}].details`),
      evidenceRefs: item.evidence_refs,
    };
  });
  if (new Set(items.map((item) => item.checkCode)).size !== items.length) shape("gate evaluation check codes must be unique");
  const passed = bool(row.passed, "gateEvaluation.passed");
  if (passed && items.some((item) => item.severity === "hard" && !item.passed)) shape("passed evaluation contains a failed hard item");
  const sealedProjectionHash = row.sealed_projection_hash === null
    ? null
    : hash(row.sealed_projection_hash, "gateEvaluation.sealed_projection_hash");
  const deliveryReleaseId = nullableText(row.delivery_release_id, "gateEvaluation.delivery_release_id");
  const deliveryReleaseVersion = row.delivery_release_version === null
    ? null
    : integer(row.delivery_release_version, "gateEvaluation.delivery_release_version");
  const supersedesReleaseId = nullableText(row.supersedes_release_id, "gateEvaluation.supersedes_release_id");
  if (
    (sealedProjectionHash === null) !== (deliveryReleaseId === null) ||
    (sealedProjectionHash === null) !== (deliveryReleaseVersion === null)
  ) {
    shape("G4 evaluation delivery projection facts are incomplete");
  }
  if (sealedProjectionHash !== null && !passed) {
    shape("a failed evaluation cannot carry a sealed delivery projection");
  }
  if (deliveryReleaseVersion === 0) {
    shape("gateEvaluation.delivery_release_version must be positive");
  }
  if (sealedProjectionHash === null && supersedesReleaseId !== null) {
    shape("a non-G4 evaluation cannot supersede a delivery release");
  }
  return {
    id: text(row.id, "gateEvaluation.id", true),
    projectId,
    gateSubmissionId: text(row.gate_submission_id, "gateEvaluation.gate_submission_id", true),
    workVersionId: text(row.work_version_id, "gateEvaluation.work_version_id", true),
    snapshotId: text(row.snapshot_id, "gateEvaluation.snapshot_id", true),
    snapshotManifestHash: hash(row.snapshot_manifest_hash, "gateEvaluation.snapshot_manifest_hash"),
    profileHash: hash(row.profile_hash, "gateEvaluation.profile_hash"),
    resultHash: hash(row.result_hash, "gateEvaluation.result_hash"),
    passed,
    sealedProjectionHash,
    deliveryReleaseId,
    deliveryReleaseVersion,
    supersedesReleaseId,
    evaluatedAt: timestamp(row.evaluated_at, "gateEvaluation.evaluated_at"),
    items,
  };
}

export function parseEvaluatedGateSubmission(value: unknown, expectedProjectId: string): EvaluatedGateSubmissionV1 {
  const row = record(value, "evaluatedGateSubmission");
  exact(row, ["id", "project_id", "gate", "state", "gate_check_evaluation_id", "check_results_hash"], [], "evaluatedGateSubmission");
  const projectId = text(row.project_id, "evaluatedGateSubmission.project_id", true);
  if (projectId !== expectedProjectId) throw new FormalFlowError("gate submission belongs to another project", "PROJECT_OWNERSHIP_MISMATCH");
  if (
    (row.gate !== "G1" && row.gate !== "G2" && row.gate !== "G3" && row.gate !== "G4") ||
    row.state !== "in_review" && row.state !== "approved"
  ) {
    shape("evaluated gate submission state is invalid");
  }
  return {
    id: text(row.id, "evaluatedGateSubmission.id", true),
    projectId,
    gate: row.gate,
    state: row.state,
    gateCheckEvaluationId: text(row.gate_check_evaluation_id, "evaluatedGateSubmission.gate_check_evaluation_id", true),
    checkResultsHash: hash(row.check_results_hash, "evaluatedGateSubmission.check_results_hash"),
  };
}

export function parseBitstreamResult(value: unknown, expectedProjectId: string): BitstreamResultV1 {
  const row = record(value, "bitstream");
  exact(row, [
    "id", "project_id", "work_version_id", "tool_run_id", "evidence_manifest_id",
    "evidence_manifest_hash", "evidence_entry_name", "class", "formal_input_approval_id",
    "snapshot_id", "readiness_id", "input_hash", "engineering_config_hash",
    "prerequisite_baseline_id", "target_part", "toolchain_profile_hash", "constraint_hash",
    "sha256", "size_bytes", "storage_uri", "generated_by_type", "generated_by",
    "generated_at", "created_at",
  ], [], "bitstream");
  const projectId = text(row.project_id, "bitstream.project_id", true);
  if (projectId !== expectedProjectId) throw new FormalFlowError("bitstream belongs to another project", "PROJECT_OWNERSHIP_MISMATCH");
  if (row.class !== "trial" && row.class !== "formal") shape("bitstream.class is invalid");
  const formalInputApprovalId = nullableText(row.formal_input_approval_id, "bitstream.formal_input_approval_id");
  const snapshotId = nullableText(row.snapshot_id, "bitstream.snapshot_id");
  const readinessId = nullableText(row.readiness_id, "bitstream.readiness_id");
  const prerequisiteBaselineId = nullableText(row.prerequisite_baseline_id, "bitstream.prerequisite_baseline_id");
  if (row.class === "formal" && [formalInputApprovalId, snapshotId, readinessId, prerequisiteBaselineId].some((field) => field === null)) {
    shape("formal bitstream is missing formal provenance");
  }
  return {
    id: text(row.id, "bitstream.id", true),
    projectId,
    workVersionId: text(row.work_version_id, "bitstream.work_version_id", true),
    toolRunId: text(row.tool_run_id, "bitstream.tool_run_id", true),
    evidenceManifestId: text(row.evidence_manifest_id, "bitstream.evidence_manifest_id", true),
    evidenceManifestHash: hash(row.evidence_manifest_hash, "bitstream.evidence_manifest_hash"),
    evidenceEntryName: safePath(row.evidence_entry_name, "bitstream.evidence_entry_name"),
    class: row.class,
    formalInputApprovalId,
    snapshotId,
    readinessId,
    inputHash: hash(row.input_hash, "bitstream.input_hash"),
    engineeringConfigHash: hash(row.engineering_config_hash, "bitstream.engineering_config_hash"),
    prerequisiteBaselineId,
    targetPart: text(row.target_part, "bitstream.target_part"),
    toolchainProfileHash: hash(row.toolchain_profile_hash, "bitstream.toolchain_profile_hash"),
    constraintHash: hash(row.constraint_hash, "bitstream.constraint_hash"),
    sha256: hash(row.sha256, "bitstream.sha256"),
    sizeBytes: integer(row.size_bytes, "bitstream.size_bytes"),
    storageUri: text(row.storage_uri, "bitstream.storage_uri"),
    generatedByType: text(row.generated_by_type, "bitstream.generated_by_type", true),
    generatedBy: text(row.generated_by, "bitstream.generated_by", true),
    generatedAt: timestamp(row.generated_at, "bitstream.generated_at"),
    createdAt: timestamp(row.created_at, "bitstream.created_at"),
  };
}

export function parseDeliveryRelease(value: unknown, expectedProjectId: string): DeliveryReleaseV1 {
  const row = record(value, "deliveryRelease");
  exact(row, [
    "id", "project_id", "version", "supersedes_release_id", "process_version_id",
    "process_instance_id", "work_version_id", "gate_submission_id", "gate_check_evaluation_id",
    "candidate_manifest_hash", "approval_record_id", "approved_gate_result_id", "baseline_id",
    "formal_input_approval_id", "bitstream_result_id", "schema_version", "manifest_hash",
    "item_count", "state", "generated_by_type", "generated_by", "generated_at",
    "confirmed_by", "confirmed_at", "created_at", "released_at",
  ], [], "deliveryRelease");
  const projectId = text(row.project_id, "deliveryRelease.project_id", true);
  if (projectId !== expectedProjectId) throw new FormalFlowError("delivery release belongs to another project", "PROJECT_OWNERSHIP_MISMATCH");
  if (row.schema_version !== "delivery-manifest.v1") shape("delivery release schema_version is invalid");
  if (row.state !== "sealed") shape("delivery release state must be sealed");
  if (row.confirmed_by === null || row.confirmed_at === null || row.released_at === null) {
    shape("sealed delivery is missing confirmation/released_at");
  }
  const confirmedBy = text(row.confirmed_by, "deliveryRelease.confirmed_by", true);
  const confirmedAt = timestamp(row.confirmed_at, "deliveryRelease.confirmed_at");
  const releasedAt = timestamp(row.released_at, "deliveryRelease.released_at");
  return {
    id: text(row.id, "deliveryRelease.id", true),
    projectId,
    version: (() => {
      const version = integer(row.version, "deliveryRelease.version");
      if (version === 0) shape("deliveryRelease.version must be positive");
      return version;
    })(),
    supersedesReleaseId: nullableText(row.supersedes_release_id, "deliveryRelease.supersedes_release_id"),
    processVersionId: text(row.process_version_id, "deliveryRelease.process_version_id", true),
    processInstanceId: text(row.process_instance_id, "deliveryRelease.process_instance_id", true),
    workVersionId: text(row.work_version_id, "deliveryRelease.work_version_id", true),
    gateSubmissionId: text(row.gate_submission_id, "deliveryRelease.gate_submission_id", true),
    gateCheckEvaluationId: text(row.gate_check_evaluation_id, "deliveryRelease.gate_check_evaluation_id", true),
    candidateManifestHash: hash(row.candidate_manifest_hash, "deliveryRelease.candidate_manifest_hash"),
    approvalRecordId: text(row.approval_record_id, "deliveryRelease.approval_record_id", true),
    approvedGateResultId: text(row.approved_gate_result_id, "deliveryRelease.approved_gate_result_id", true),
    baselineId: text(row.baseline_id, "deliveryRelease.baseline_id", true),
    formalInputApprovalId: text(row.formal_input_approval_id, "deliveryRelease.formal_input_approval_id", true),
    bitstreamResultId: text(row.bitstream_result_id, "deliveryRelease.bitstream_result_id", true),
    schemaVersion: "delivery-manifest.v1",
    manifestHash: hash(row.manifest_hash, "deliveryRelease.manifest_hash"),
    itemCount: (() => {
      const itemCount = integer(row.item_count, "deliveryRelease.item_count");
      if (itemCount === 0) shape("deliveryRelease.item_count must be positive");
      return itemCount;
    })(),
    state: row.state,
    generatedByType: text(row.generated_by_type, "deliveryRelease.generated_by_type", true),
    generatedBy: text(row.generated_by, "deliveryRelease.generated_by", true),
    generatedAt: timestamp(row.generated_at, "deliveryRelease.generated_at"),
    confirmedBy,
    confirmedAt,
    createdAt: timestamp(row.created_at, "deliveryRelease.created_at"),
    releasedAt,
  };
}

export interface FormalJobProgressV1 {
  readonly jobId: string;
  readonly state: ToolRunState;
  readonly evidenceManifestId?: string;
  readonly evidenceManifestHash?: string;
}

export interface FormalFlowProgressV1 {
  readonly schema: "formal-flow-progress.v1";
  readonly status: "awaiting_input_confirmation" | "running" | "awaiting_gate_approval";
  readonly projectId: string;
  readonly gateSubmissionId: string;
  readonly workVersionId: string;
  readonly snapshotId: string;
  readonly snapshotManifestHash: string;
  readonly profileHash: string;
  readonly readinessId: string;
  readonly authorizedTaskId: string;
  readonly approvalId: string;
  readonly preview: FormalInputPreviewV1;
  readonly approval?: FormalInputApprovalV1;
  readonly jobs: Readonly<Partial<Record<FormalG4Operation, FormalJobProgressV1>>>;
  readonly evaluation?: GateEvaluationV1;
}

export interface FormalFlowAdvanceResult {
  readonly progress: FormalFlowProgressV1;
  readonly blockedOn: "input_confirmation" | "job" | "gate_approval";
}

export type EvaluatedProcessGate = "G1" | "G2" | "G3" | "G4";

/** Durable Core-evaluation binding for one modern gate submission. */
export interface EvaluatedGateFlowProgressV1 {
  readonly schema: "evaluated-gate-flow-progress.v1";
  readonly gate: EvaluatedProcessGate;
  readonly projectId: string;
  readonly submissionId: string;
  readonly workVersionId: string;
  readonly snapshotId: string;
  readonly snapshotManifestHash: string;
  readonly profileHash: string;
  readonly evaluationId: string;
  readonly evaluation?: GateEvaluationV1;
  readonly submitted?: EvaluatedGateSubmissionV1;
}

function verifyModernGateEvaluation(
  progress: EvaluatedGateFlowProgressV1,
  evaluation: GateEvaluationV1,
): void {
  if (
    evaluation.id !== progress.evaluationId ||
    evaluation.projectId !== progress.projectId ||
    evaluation.gateSubmissionId !== progress.submissionId ||
    evaluation.workVersionId !== progress.workVersionId ||
    evaluation.snapshotId !== progress.snapshotId ||
    evaluation.snapshotManifestHash !== progress.snapshotManifestHash ||
    evaluation.profileHash !== progress.profileHash ||
    !evaluation.passed
  ) {
    throw new FormalFlowError(
      `${progress.gate} evaluation failed or diverged from its frozen submission`,
      "GATE_EVALUATION_BINDING_MISMATCH",
    );
  }
  if (
    progress.gate === "G4"
      ? evaluation.sealedProjectionHash === null || evaluation.deliveryReleaseId === null
      : evaluation.sealedProjectionHash !== null || evaluation.deliveryReleaseId !== null
  ) {
    throw new FormalFlowError(
      `${progress.gate} evaluation carries invalid delivery projection facts`,
      "GATE_EVALUATION_DELIVERY_MISMATCH",
    );
  }
}

function verifyEvaluatedSubmission(
  progress: EvaluatedGateFlowProgressV1,
  evaluation: GateEvaluationV1,
  submitted: EvaluatedGateSubmissionV1,
): void {
  if (
    submitted.id !== progress.submissionId ||
    submitted.projectId !== progress.projectId ||
    submitted.gate !== progress.gate ||
    submitted.gateCheckEvaluationId !== evaluation.id ||
    submitted.checkResultsHash !== evaluation.resultHash ||
    (submitted.state !== "in_review" && submitted.state !== "approved")
  ) {
    throw new FormalFlowError(
      `${progress.gate} submission does not reference its passed evaluation`,
      "GATE_SUBMISSION_BINDING_MISMATCH",
    );
  }
}

/**
 * Create and submit a modern gate only through Core's immutable evaluation.
 * Every identifier is deterministic and the caller persists before and after
 * each write, so a lost response or Runtime restart replays the same intent.
 */
export class EvaluatedGateOrchestrator {
  constructor(
    private readonly client: FormalFlowClient,
    private readonly onProgress: (progress: EvaluatedGateFlowProgressV1) => Promise<void> = async () => {},
  ) {}

  async initialize(input: {
    gate: EvaluatedProcessGate;
    projectId: string;
    submissionId: string;
    workVersionId: string;
    snapshotId: string;
    snapshotManifestHash: string;
    profileHash: string;
  }): Promise<EvaluatedGateFlowProgressV1> {
    const evaluationId = `eval-${sha256Hex(
      `${input.submissionId}\0${input.workVersionId}\0${input.snapshotManifestHash}\0${input.profileHash}`,
    ).slice(0, 48)}`;
    const progress: EvaluatedGateFlowProgressV1 = {
      schema: "evaluated-gate-flow-progress.v1",
      ...input,
      evaluationId,
    };
    await this.onProgress(progress);
    return progress;
  }

  async advance(initial: EvaluatedGateFlowProgressV1): Promise<EvaluatedGateFlowProgressV1> {
    let progress = initial;
    let evaluation = progress.evaluation;
    if (!evaluation) {
      evaluation = await this.client.createGateEvaluation({
        submissionId: progress.submissionId,
        evaluationId: progress.evaluationId,
        workVersionId: progress.workVersionId,
        expectedSnapshotManifestHash: progress.snapshotManifestHash,
      });
      verifyModernGateEvaluation(progress, evaluation);
      progress = { ...progress, evaluation };
      await this.onProgress(progress);
    } else {
      verifyModernGateEvaluation(progress, evaluation);
    }

    if (!progress.submitted) {
      const submitted = await this.client.submitEvaluatedGate({
        submissionId: progress.submissionId,
        evaluationId: evaluation.id,
        resultHash: evaluation.resultHash,
      });
      verifyEvaluatedSubmission(progress, evaluation, submitted);
      progress = { ...progress, submitted };
      await this.onProgress(progress);
    } else {
      verifyEvaluatedSubmission(progress, evaluation, progress.submitted);
    }
    return progress;
  }
}

export function isFormalFlowClient(value: unknown): value is FormalFlowClient {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return [
    "listReadiness", "previewFormalInput", "getFormalInputApproval", "submitFormalJob", "getFormalJob",
    "freezeFormalEvidence", "getFormalEvidence", "createGateEvaluation", "submitEvaluatedGate",
  ].every((method) => typeof row[method] === "function");
}

function verifyApproval(progress: FormalFlowProgressV1, approval: FormalInputApprovalV1): void {
  const preview = progress.preview;
  if (
    approval.id !== progress.approvalId ||
    approval.workVersionId !== preview.workVersionId ||
    approval.snapshotId !== preview.snapshotId ||
    approval.readinessId !== preview.readinessId ||
    approval.authorizedTaskId !== preview.authorizedTaskId ||
    approval.inputHash !== preview.inputHash ||
    approval.previewHash !== preview.previewHash ||
    approval.toolchainProfileHash !== preview.toolchainProfileHash
  ) {
    throw new FormalFlowError("formal input approval does not match the preview", "FORMAL_INPUT_BINDING_MISMATCH");
  }
}

function verifyJob(progress: FormalFlowProgressV1, operation: FormalG4Operation, job: FormalJobBindingV1): void {
  const approval = progress.approval;
  if (!approval) throw new FormalFlowError("formal input is not confirmed", "FORMAL_INPUT_NOT_CONFIRMED");
  if (
    job.operation !== operation ||
    job.formalInputApprovalId !== approval.id ||
    job.inputSnapshotId !== approval.snapshotId ||
    job.inputHash !== approval.inputHash ||
    job.toolchainProfileHash !== approval.toolchainProfileHash ||
    job.runClass !== "formal"
  ) {
    throw new FormalFlowError(`formal ${operation} job binding diverged from the approval`, "FORMAL_JOB_BINDING_MISMATCH");
  }
}

function verifyEvidence(progress: FormalFlowProgressV1, operation: FormalG4Operation, jobId: string, evidence: FrozenEvidenceManifestV1): void {
  const approval = progress.approval!;
  if (
    evidence.jobId !== jobId ||
    evidence.operation !== operation ||
    evidence.projectId !== progress.projectId ||
    evidence.runClass !== "formal" ||
    evidence.runState !== "succeeded" ||
    evidence.inputHash !== approval.inputHash ||
    evidence.toolchainProfileHash !== approval.toolchainProfileHash ||
    evidence.entries.some((entry) => entry.completeness !== "full" || entry.corrupt)
  ) {
    throw new FormalFlowError(`formal ${operation} evidence is incomplete or misbound`, "FORMAL_EVIDENCE_BINDING_MISMATCH");
  }
}

function verifyG4Evaluation(progress: FormalFlowProgressV1, evaluation: GateEvaluationV1): void {
  if (
    evaluation.projectId !== progress.projectId ||
    evaluation.gateSubmissionId !== progress.gateSubmissionId ||
    evaluation.workVersionId !== progress.workVersionId ||
    evaluation.snapshotId !== progress.snapshotId ||
    evaluation.snapshotManifestHash !== progress.snapshotManifestHash ||
    evaluation.profileHash !== progress.profileHash ||
    !evaluation.passed ||
    evaluation.sealedProjectionHash === null ||
    evaluation.deliveryReleaseId === null
  ) {
    throw new FormalFlowError("G4 evaluation failed or did not seal a delivery projection", "G4_EVALUATION_FAILED");
  }
}

/**
 * Durable, single-step P4 formal orchestration. Callers persist every returned
 * progress update. Re-entry uses stored job ids, while a lost submit response
 * is recovered by replaying the deterministic Idempotency-Key.
 */
export class FormalFlowOrchestrator {
  constructor(
    private readonly client: FormalFlowClient,
    private readonly onProgress: (progress: FormalFlowProgressV1) => Promise<void> = async () => {},
  ) {}

  async initialize(input: {
    projectId: string;
    gateSubmissionId: string;
    workVersionId: string;
    snapshotId: string;
    snapshotManifestHash: string;
    profileHash: string;
    readinessId: string;
    authorizedTaskId: string;
  }): Promise<FormalFlowProgressV1> {
    const preview = await this.client.previewFormalInput({
      workVersionId: input.workVersionId,
      snapshotId: input.snapshotId,
      readinessId: input.readinessId,
      authorizedTaskId: input.authorizedTaskId,
    });
    if (
      preview.workVersionId !== input.workVersionId ||
      preview.snapshotId !== input.snapshotId ||
      preview.readinessId !== input.readinessId ||
      preview.authorizedTaskId !== input.authorizedTaskId
    ) {
      throw new FormalFlowError("formal input preview does not match the requested facts", "FORMAL_INPUT_BINDING_MISMATCH");
    }
    if (!preview.constraintsComplete) {
      throw new FormalFlowError("formal G4 requires complete pin/electrical/clock constraints", "FORMAL_CONSTRAINTS_INCOMPLETE");
    }
    const approvalId = `fia-${sha256Hex(`${input.projectId}\0${preview.previewHash}\0${input.authorizedTaskId}`).slice(0, 48)}`;
    const progress: FormalFlowProgressV1 = {
      schema: "formal-flow-progress.v1",
      status: "awaiting_input_confirmation",
      projectId: input.projectId,
      gateSubmissionId: input.gateSubmissionId,
      workVersionId: input.workVersionId,
      snapshotId: input.snapshotId,
      snapshotManifestHash: input.snapshotManifestHash,
      profileHash: input.profileHash,
      readinessId: input.readinessId,
      authorizedTaskId: input.authorizedTaskId,
      approvalId,
      preview,
      jobs: {},
    };
    await this.onProgress(progress);
    return progress;
  }

  async advance(initial: FormalFlowProgressV1): Promise<FormalFlowAdvanceResult> {
    let progress = initial;
    if (!progress.approval) {
      let approval: FormalInputApprovalV1;
      try {
        approval = await this.client.getFormalInputApproval(progress.approvalId);
      } catch (error) {
        if (error && typeof error === "object" && "httpStatus" in error && error.httpStatus === 404) {
          return { progress, blockedOn: "input_confirmation" };
        }
        throw error;
      }
      verifyApproval(progress, approval);
      progress = { ...progress, status: "running", approval };
      await this.onProgress(progress);
    }

    for (const operation of FORMAL_G4_OPERATIONS) {
      const existing = progress.jobs[operation];
      const job = existing
        ? await this.client.getFormalJob(existing.jobId)
        : await this.client.submitFormalJob(
            operation,
            progress.approval!.id,
            `formal-job-${progress.approval!.id}-${operation}`,
          );
      verifyJob(progress, operation, job);
      progress = {
        ...progress,
        status: "running",
        jobs: { ...progress.jobs, [operation]: { ...existing, jobId: job.jobId, state: job.state } },
      };
      await this.onProgress(progress);
      if (!TERMINAL_JOB_STATES.has(job.state)) return { progress, blockedOn: "job" };
      if (job.state !== "succeeded") {
        throw new FormalFlowError(
          `formal ${operation} ended in ${job.state}${job.errorCode ? ` (${job.errorCode})` : ""}`,
          job.errorCode ?? "FORMAL_JOB_FAILED",
        );
      }
      if (existing?.evidenceManifestHash) {
        const evidence = await this.client.getFormalEvidence(job.jobId);
        verifyEvidence(progress, operation, job.jobId, evidence);
        if (
          evidence.id !== existing.evidenceManifestId ||
          evidence.manifestHash !== existing.evidenceManifestHash
        ) {
          throw new FormalFlowError(
            `formal ${operation} persisted evidence binding diverged from Core`,
            "FORMAL_EVIDENCE_BINDING_MISMATCH",
          );
        }
      } else {
        const evidence = await this.client.freezeFormalEvidence(
          job.jobId,
          `formal-evidence-${progress.approval!.id}-${operation}`,
        );
        verifyEvidence(progress, operation, job.jobId, evidence);
        progress = {
          ...progress,
          jobs: {
            ...progress.jobs,
            [operation]: {
              jobId: job.jobId,
              state: job.state,
              evidenceManifestId: evidence.id,
              evidenceManifestHash: evidence.manifestHash,
            },
          },
        };
        await this.onProgress(progress);
      }
    }

    let evaluation = progress.evaluation;
    if (!evaluation) {
      const evaluationId = `eval-${sha256Hex(`${progress.gateSubmissionId}\0${progress.snapshotManifestHash}\0${progress.approval!.inputHash}`).slice(0, 48)}`;
      evaluation = await this.client.createGateEvaluation({
        submissionId: progress.gateSubmissionId,
        evaluationId,
        workVersionId: progress.workVersionId,
        expectedSnapshotManifestHash: progress.snapshotManifestHash,
      });
      if (evaluation.id !== evaluationId) {
        throw new FormalFlowError("G4 evaluation id diverged from the deterministic intent", "G4_EVALUATION_FAILED");
      }
      verifyG4Evaluation(progress, evaluation);
      progress = { ...progress, evaluation };
      await this.onProgress(progress);
    } else {
      verifyG4Evaluation(progress, evaluation);
    }

    const submitted = await this.client.submitEvaluatedGate({
      submissionId: progress.gateSubmissionId,
      evaluationId: evaluation.id,
      resultHash: evaluation.resultHash,
    });
    if (
      submitted.id !== progress.gateSubmissionId ||
      submitted.gateCheckEvaluationId !== evaluation.id ||
      submitted.checkResultsHash !== evaluation.resultHash
    ) {
      throw new FormalFlowError("G4 submission does not reference the passed evaluation", "G4_SUBMISSION_BINDING_MISMATCH");
    }
    progress = { ...progress, status: "awaiting_gate_approval" };
    await this.onProgress(progress);
    return { progress, blockedOn: "gate_approval" };
  }

  /** Verify the atomic G4 approval produced the release bound to this flow. */
  async verifyReleased(progress: FormalFlowProgressV1): Promise<DeliveryReleaseV1> {
    if (
      !progress.evaluation?.sealedProjectionHash ||
      !progress.evaluation.deliveryReleaseId ||
      !progress.approval
    ) {
      throw new FormalFlowError("formal flow has no sealed G4 evaluation", "DELIVERY_RELEASE_NOT_READY");
    }
    const releases = await this.client.listDeliveryReleases();
    const release = releases.find((candidate) => candidate.id === progress.evaluation!.deliveryReleaseId);
    if (!release) {
      throw new FormalFlowError("approved G4 has no deterministic sealed delivery", "DELIVERY_RELEASE_MISSING");
    }
    if (
      release.state !== "sealed" ||
      release.projectId !== progress.projectId ||
      release.workVersionId !== progress.workVersionId ||
      release.gateCheckEvaluationId !== progress.evaluation.id ||
      release.candidateManifestHash !== progress.evaluation.sealedProjectionHash ||
      release.formalInputApprovalId !== progress.approval.id
    ) {
      throw new FormalFlowError("delivery release binding diverged from the formal G4 flow", "DELIVERY_RELEASE_BINDING_MISMATCH");
    }
    return release;
  }
}
