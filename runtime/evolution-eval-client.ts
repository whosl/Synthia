/** Strict Runtime client for the frozen evolution_eval Appendix-B surface. */

export const EVOLUTION_EVAL_OPERATIONS = [
  "validate_sources",
  "simulate",
  "synthesize",
  "implement",
] as const;

export type EvolutionEvalOperation = (typeof EVOLUTION_EVAL_OPERATIONS)[number];
export type EvolutionEvalJobState =
  | "submitted"
  | "running"
  | "rejected"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout"
  | "unknown_effect";

export type EvolutionEvalParametersV1 =
  | { readonly operation: "validate_sources"; readonly source_paths: readonly string[]; readonly top: string | null }
  | { readonly operation: "simulate"; readonly source_paths: readonly string[]; readonly top: string; readonly testbench: string }
  | { readonly operation: "synthesize"; readonly source_paths: readonly string[]; readonly top: string; readonly part: string }
  | {
      readonly operation: "implement";
      readonly source_paths: readonly string[];
      readonly constraint_paths: readonly string[];
      readonly top: string;
      readonly part: string;
      readonly generate_trial_bitstream: boolean;
    };

export interface EvolutionEvalInputV1 {
  readonly eval_input_ref: string;
  readonly input_manifest_hash: string;
  readonly source_commit: string;
  readonly source_manifest_hash: string;
  readonly allowed_operations: readonly EvolutionEvalOperation[];
  readonly trial_bitstream_allowed: boolean;
  readonly part: string | null;
  readonly toolchain_profile_hash: string;
}

export interface EvolutionEvalRecoveryJobV1 {
  readonly eval_job_id: string;
  readonly tool_run_id: string;
  readonly application_id: string;
  readonly version_id: string;
  readonly ordinal: 1 | 2 | 3;
  readonly operation: EvolutionEvalOperation;
  readonly state: EvolutionEvalJobState;
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly workspace_manifest_hash: string;
  readonly workspace_sealed: boolean;
  readonly evidence_state: EvolutionEvalEvidenceState;
  readonly retention_state: EvolutionEvalRetentionState;
  readonly evidence_manifest_hash: string | null;
  readonly reconciliation_state: EvolutionEvalReconciliationState;
}

export interface EvolutionEvalRecoveryV1 {
  readonly budget_started_at: string | null;
  readonly deadline_at: string | null;
  readonly unknown_effect_latched_at: string | null;
  readonly jobs: readonly EvolutionEvalRecoveryJobV1[];
}

export type EvolutionEvalEvidenceState =
  | "none"
  | "freeze_pending"
  | "frozen"
  | "corrupt"
  | "unavailable_at_deadline";
export type EvolutionEvalRetentionState =
  | "not_applicable"
  | "pending_ack"
  | "acknowledged"
  | "quarantine_pending"
  | "expired";
export type EvolutionEvalReconciliationState = "not_needed" | "confirmed" | "required";

export interface EvolutionEvalStatusV1 {
  readonly schema: "evolution-eval-status.v1";
  readonly eval_job_id: string;
  readonly tool_run_id: string;
  readonly curator_run_id: string;
  readonly application_id: string;
  readonly version_id: string;
  readonly ordinal: 1 | 2 | 3;
  readonly operation: EvolutionEvalOperation;
  readonly run_class: "evolution_eval";
  readonly state: EvolutionEvalJobState;
  readonly deadline_at: string;
  readonly error_code: string | null;
  readonly workspace_manifest_hash: string;
  readonly evidence_manifest_hash: string | null;
  readonly evidence_state: EvolutionEvalEvidenceState;
  readonly retention_state: EvolutionEvalRetentionState;
  readonly reconciliation_state: EvolutionEvalReconciliationState;
  readonly replayed: boolean;
}

export interface EvolutionEvalPrepareRequestV1 {
  readonly schema: "evolution-eval-prepare.v1";
  readonly curator_lease_token: string;
  readonly application_id: string;
  readonly evidence_snapshot_hash: string;
  readonly version_id: string;
  readonly eval_input_ref: string;
  readonly input_manifest_hash: string;
  readonly operation: EvolutionEvalOperation;
  readonly parameters: EvolutionEvalParametersV1;
  readonly timeout_ms: number;
}

export interface EvolutionEvalPrepareResultV1 {
  readonly schema: "evolution-eval-prepare-result.v1";
  readonly eval_job_id: string;
  readonly tool_run_id: string;
  readonly workspace_id: string;
  readonly ordinal: 1 | 2 | 3;
  readonly state: "submitted";
  readonly workspace_revision: number;
  readonly source_commit: string;
  readonly source_manifest_hash: string;
  readonly workspace_manifest_hash: string;
  readonly deadline_at: string;
  readonly effective_timeout_ms: number;
  readonly replayed: boolean;
}

export type EvolutionEvalWorkspaceChangeV1 =
  | { readonly action: "upsert"; readonly path: string; readonly sha256: string; readonly content_base64: string }
  | { readonly action: "delete"; readonly path: string };

export interface EvolutionEvalWorkspaceResultV1 {
  readonly schema: "evolution-eval-workspace-result.v1";
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly workspace_manifest_hash: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly replayed: boolean;
}

export interface EvolutionEvalWorkspaceFilesV1 {
  readonly schema: "evolution-eval-workspace-files.v1";
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly workspace_manifest_hash: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly media_type: string;
    readonly read_only: boolean;
    readonly content_base64: string;
  }[];
}

export interface EvolutionEvalEvidencePendingV1 {
  readonly schema: "evolution-eval-evidence-pending.v1";
  readonly eval_job_id: string;
  readonly action: "freeze" | "ack";
  readonly duty_state: "freeze_pending" | "ack_pending";
  readonly replayed: boolean;
}

export interface EvolutionEvalEvidenceManifestV1 {
  readonly schema: "evolution-eval-evidence-manifest.v1";
  readonly eval_job_id: string;
  readonly tool_run_id: string;
  readonly manifest_hash: string;
  readonly evidence_state: "frozen";
  readonly retention_state: "pending_ack" | "acknowledged";
  readonly entries: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly media_type: "application/json" | "text/plain" | "application/octet-stream";
    readonly artifact_classification: "experimental/evolution_eval" | "evolution_eval_evidence";
    readonly usage_classification: "evolution_eval_only";
  }[];
  readonly replayed: boolean;
}

export interface EvolutionEvalEvidenceContentV1 {
  readonly schema: "evolution-eval-evidence-content.v1";
  readonly name: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly content_base64: string;
}

export type EvolutionEvalEvidenceMutationResultV1 =
  | EvolutionEvalEvidencePendingV1
  | EvolutionEvalEvidenceManifestV1;

export interface EvolutionEvalClient {
  recover(runId: string, curatorLeaseToken: string, signal?: AbortSignal): Promise<EvolutionEvalRecoveryV1>;
  prepare(runId: string, request: EvolutionEvalPrepareRequestV1, idempotencyKey: string, signal?: AbortSignal): Promise<EvolutionEvalPrepareResultV1>;
  readWorkspace(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly workspace_id: string; readonly workspace_revision: number; readonly paths: readonly string[] }, signal?: AbortSignal): Promise<EvolutionEvalWorkspaceFilesV1>;
  writeWorkspace(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly workspace_id: string; readonly expected_workspace_revision: number; readonly changes: readonly EvolutionEvalWorkspaceChangeV1[] }, idempotencyKey: string, signal?: AbortSignal): Promise<EvolutionEvalWorkspaceResultV1>;
  submit(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly workspace_id: string; readonly expected_workspace_revision: number; readonly expected_workspace_manifest_hash: string }, idempotencyKey: string, signal?: AbortSignal): Promise<EvolutionEvalStatusV1>;
  status(runId: string, evalJobId: string, curatorLeaseToken: string, signal?: AbortSignal): Promise<EvolutionEvalStatusV1>;
  cancel(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly reason_code: string }, idempotencyKey: string, signal?: AbortSignal): Promise<EvolutionEvalStatusV1>;
  freezeEvidence(runId: string, evalJobId: string, curatorLeaseToken: string, idempotencyKey: string, signal?: AbortSignal): Promise<EvolutionEvalEvidenceMutationResultV1>;
  readEvidence(runId: string, evalJobId: string, curatorLeaseToken: string, name: string, expectedSha256: string, signal?: AbortSignal): Promise<EvolutionEvalEvidenceContentV1>;
}

export interface CoreEvolutionEvalClientOptions {
  readonly baseUrl: string;
  readonly evaluatorToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export class EvolutionEvalClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly correlationId: string | null = null,
  ) {
    super(message);
    this.name = "EvolutionEvalClientError";
  }
}

export class CoreEvolutionEvalClient implements EvolutionEvalClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CoreEvolutionEvalClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new TypeError("baseUrl must use http(s)");
    this.#baseUrl = base.toString().replace(/\/$/, "");
    this.#token = opaque(options.evaluatorToken, "evaluatorToken");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = positiveInteger(options.requestTimeoutMs ?? 120_000, "requestTimeoutMs");
  }

  async recover(runId: string, curatorLeaseToken: string, signal?: AbortSignal): Promise<EvolutionEvalRecoveryV1> {
    return parseRecovery(await this.#post(`${run(runId)}/eval-jobs/recover`, {
      schema: "evolution-eval-recover.v1",
      curator_lease_token: opaque(curatorLeaseToken, "curatorLeaseToken"),
    }, null, signal));
  }

  async prepare(runId: string, request: EvolutionEvalPrepareRequestV1, key: string, signal?: AbortSignal): Promise<EvolutionEvalPrepareResultV1> {
    validatePrepare(request);
    return parsePrepare(await this.#post(`${run(runId)}/eval-jobs/prepare`, request, key, signal));
  }

  async readWorkspace(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly workspace_id: string; readonly workspace_revision: number; readonly paths: readonly string[] }, signal?: AbortSignal): Promise<EvolutionEvalWorkspaceFilesV1> {
    const body = {
      schema: "evolution-eval-workspace-read.v1" as const,
      curator_lease_token: opaque(input.curator_lease_token, "curator_lease_token"),
      workspace_id: routeId(input.workspace_id, "workspace_id"),
      workspace_revision: positiveInteger(input.workspace_revision, "workspace_revision"),
      paths: paths(input.paths, "paths", 1, 32),
    };
    return parseWorkspaceFiles(await this.#post(`${job(runId, evalJobId)}/workspace/read`, body, null, signal));
  }

  async writeWorkspace(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly workspace_id: string; readonly expected_workspace_revision: number; readonly changes: readonly EvolutionEvalWorkspaceChangeV1[] }, key: string, signal?: AbortSignal): Promise<EvolutionEvalWorkspaceResultV1> {
    if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 32) throw new TypeError("changes must contain 1..32 entries");
    const changes = input.changes.map((change, index) => validateChange(change, index));
    return parseWorkspaceResult(await this.#post(`${job(runId, evalJobId)}/workspace/write`, {
      schema: "evolution-eval-workspace-write.v1",
      curator_lease_token: opaque(input.curator_lease_token, "curator_lease_token"),
      workspace_id: routeId(input.workspace_id, "workspace_id"),
      expected_workspace_revision: positiveInteger(input.expected_workspace_revision, "expected_workspace_revision"),
      changes,
    }, key, signal));
  }

  async submit(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly workspace_id: string; readonly expected_workspace_revision: number; readonly expected_workspace_manifest_hash: string }, key: string, signal?: AbortSignal): Promise<EvolutionEvalStatusV1> {
    return parseStatus(await this.#post(`${job(runId, evalJobId)}/submit`, {
      schema: "evolution-eval-submit.v1",
      curator_lease_token: opaque(input.curator_lease_token, "curator_lease_token"),
      workspace_id: routeId(input.workspace_id, "workspace_id"),
      expected_workspace_revision: positiveInteger(input.expected_workspace_revision, "expected_workspace_revision"),
      expected_workspace_manifest_hash: hash(input.expected_workspace_manifest_hash, "expected_workspace_manifest_hash"),
    }, key, signal));
  }

  async status(runId: string, evalJobId: string, token: string, signal?: AbortSignal): Promise<EvolutionEvalStatusV1> {
    return parseStatus(await this.#post(`${job(runId, evalJobId)}/status`, {
      schema: "evolution-eval-status-request.v1",
      curator_lease_token: opaque(token, "curatorLeaseToken"),
    }, null, signal));
  }

  async cancel(runId: string, evalJobId: string, input: { readonly curator_lease_token: string; readonly reason_code: string }, key: string, signal?: AbortSignal): Promise<EvolutionEvalStatusV1> {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(input.reason_code)) throw new TypeError("reason_code is invalid");
    return parseStatus(await this.#post(`${job(runId, evalJobId)}/cancel`, {
      schema: "evolution-eval-cancel.v1",
      curator_lease_token: opaque(input.curator_lease_token, "curator_lease_token"),
      reason_code: input.reason_code,
    }, key, signal));
  }

  async freezeEvidence(runId: string, evalJobId: string, token: string, key: string, signal?: AbortSignal): Promise<EvolutionEvalEvidenceMutationResultV1> {
    return parseEvidenceMutation(await this.#post(`${job(runId, evalJobId)}/evidence`, {
      schema: "evolution-eval-evidence.v1",
      curator_lease_token: opaque(token, "curatorLeaseToken"),
      action: "freeze",
    }, key, signal));
  }

  async readEvidence(runId: string, evalJobId: string, token: string, name: string, expectedSha256: string, signal?: AbortSignal): Promise<EvolutionEvalEvidenceContentV1> {
    return parseEvidenceContent(await this.#post(`${job(runId, evalJobId)}/evidence`, {
      schema: "evolution-eval-evidence.v1",
      curator_lease_token: opaque(token, "curatorLeaseToken"),
      action: "read",
      name: evidenceName(name),
      expected_sha256: hash(expectedSha256, "expectedSha256"),
    }, null, signal));
  }

  async #post(path: string, body: object, key: string | null, signal?: AbortSignal): Promise<unknown> {
    const serialized = JSON.stringify(body);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("evolution eval request timed out", "TimeoutError")), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/v1/internal/evolution/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          ...(key === null ? {} : { "Idempotency-Key": opaque(key, "idempotencyKey") }),
        },
        body: serialized,
        signal: controller.signal,
      });
      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch {
        throw new EvolutionEvalClientError("Core returned malformed JSON", "INVALID_CORE_RESPONSE", response.status, false);
      }
      const envelope = record(payload, "Core envelope");
      if (!response.ok) {
        const error = record(envelope.error, "Core error");
        throw new EvolutionEvalClientError(
          text(error.message, "error.message"),
          text(error.code, "error.code"),
          response.status,
          bool(error.retryable, "error.retryable"),
          typeof error.correlation_id === "string" ? error.correlation_id : null,
        );
      }
      text(envelope.correlation_id, "correlation_id");
      if (!("data" in envelope)) throw new EvolutionEvalClientError("Core response omitted data", "INVALID_CORE_RESPONSE", response.status, false);
      return envelope.data;
    } catch (error) {
      if (error instanceof EvolutionEvalClientError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new EvolutionEvalClientError(error instanceof Error ? error.message : "network error", "network_error", 0, true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function run(runId: string): string {
  return `curator-runs/${encodeURIComponent(routeId(runId, "runId"))}`;
}

function job(runId: string, evalJobId: string): string {
  return `${run(runId)}/eval-jobs/${encodeURIComponent(routeId(evalJobId, "evalJobId"))}`;
}

function validatePrepare(input: EvolutionEvalPrepareRequestV1): void {
  exactKeys(record(input, "prepare"), [
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
  ], "prepare");
  if (input.schema !== "evolution-eval-prepare.v1") throw new TypeError("prepare schema is invalid");
  opaque(input.curator_lease_token, "curator_lease_token");
  routeId(input.application_id, "application_id");
  hash(input.evidence_snapshot_hash, "evidence_snapshot_hash");
  routeId(input.version_id, "version_id");
  opaque(input.eval_input_ref, "eval_input_ref");
  hash(input.input_manifest_hash, "input_manifest_hash");
  if (!EVOLUTION_EVAL_OPERATIONS.includes(input.operation)) throw new TypeError("operation is forbidden");
  validateParameters(input.parameters, input.operation);
  const timeout = positiveInteger(input.timeout_ms, "timeout_ms");
  if (timeout > 7_200_000) throw new TypeError("timeout_ms exceeds operation cap");
}

export function validateEvolutionEvalModelParameters(value: unknown, operation: EvolutionEvalOperation): EvolutionEvalParametersV1 {
  const row = exactRecord(value, "parameters");
  if (row.operation !== operation) throw new TypeError("parameters.operation does not match operation");
  const sourcePaths = paths(row.source_paths, "source_paths", 1, 512);
  if (operation === "validate_sources") {
    exactKeys(row, ["operation", "source_paths", "top"], "parameters");
    return { operation, source_paths: sourcePaths, top: row.top === null ? null : symbol(row.top, "top") };
  }
  if (operation === "simulate") {
    exactKeys(row, ["operation", "source_paths", "top", "testbench"], "parameters");
    return { operation, source_paths: sourcePaths, top: symbol(row.top, "top"), testbench: symbol(row.testbench, "testbench") };
  }
  if (operation === "synthesize") {
    exactKeys(row, ["operation", "source_paths", "top", "part"], "parameters");
    return { operation, source_paths: sourcePaths, top: symbol(row.top, "top"), part: part(row.part) };
  }
  exactKeys(row, ["operation", "source_paths", "constraint_paths", "top", "part", "generate_trial_bitstream"], "parameters");
  return {
    operation,
    source_paths: sourcePaths,
    constraint_paths: paths(row.constraint_paths, "constraint_paths", 0, 128),
    top: symbol(row.top, "top"),
    part: part(row.part),
    generate_trial_bitstream: bool(row.generate_trial_bitstream, "generate_trial_bitstream"),
  };
}

function validateParameters(value: unknown, operation: EvolutionEvalOperation): void {
  validateEvolutionEvalModelParameters(value, operation);
}

function validateChange(change: EvolutionEvalWorkspaceChangeV1, index: number): EvolutionEvalWorkspaceChangeV1 {
  const row = exactRecord(change, `changes[${index}]`);
  if (row.action === "delete") {
    exactKeys(row, ["action", "path"], `changes[${index}]`);
    return { action: "delete", path: portablePath(row.path, "path") };
  }
  if (row.action !== "upsert") throw new TypeError("workspace change action is invalid");
  exactKeys(row, ["action", "path", "sha256", "content_base64"], `changes[${index}]`);
  const content = text(row.content_base64, "content_base64");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new TypeError("content_base64 is invalid");
  return { action: "upsert", path: portablePath(row.path, "path"), sha256: hash(row.sha256, "sha256"), content_base64: content };
}

function parseRecovery(value: unknown): EvolutionEvalRecoveryV1 {
  const row = exactRecord(value, "recovery");
  exactKeys(row, ["budget_started_at", "deadline_at", "unknown_effect_latched_at", "jobs"], "recovery");
  const started = nullableTimestamp(row.budget_started_at, "budget_started_at");
  const deadline = nullableTimestamp(row.deadline_at, "deadline_at");
  if ((started === null) !== (deadline === null)) throw new TypeError("recovery budget timestamps are inconsistent");
  const jobs = array(row.jobs, "jobs").map((item, index) => parseRecoveryJob(item, index));
  if (jobs.length > 3) throw new TypeError("recovery exceeds three-job budget");
  jobs.forEach((item, index) => { if (item.ordinal !== index + 1) throw new TypeError("recovery ordinals are not contiguous"); });
  return { budget_started_at: started, deadline_at: deadline, unknown_effect_latched_at: nullableTimestamp(row.unknown_effect_latched_at, "unknown_effect_latched_at"), jobs };
}

function parseRecoveryJob(value: unknown, index: number): EvolutionEvalRecoveryJobV1 {
  const row = exactRecord(value, `jobs[${index}]`);
  exactKeys(row, ["eval_job_id", "tool_run_id", "application_id", "version_id", "ordinal", "operation", "state", "workspace_id", "workspace_revision", "workspace_manifest_hash", "workspace_sealed", "evidence_state", "retention_state", "evidence_manifest_hash", "reconciliation_state"], `jobs[${index}]`);
  return {
    eval_job_id: routeId(row.eval_job_id, "eval_job_id"),
    tool_run_id: routeId(row.tool_run_id, "tool_run_id"),
    application_id: routeId(row.application_id, "application_id"),
    version_id: routeId(row.version_id, "version_id"),
    ordinal: ordinal(row.ordinal),
    operation: operation(row.operation),
    state: state(row.state),
    workspace_id: routeId(row.workspace_id, "workspace_id"),
    workspace_revision: positiveInteger(row.workspace_revision, "workspace_revision"),
    workspace_manifest_hash: hash(row.workspace_manifest_hash, "workspace_manifest_hash"),
    workspace_sealed: bool(row.workspace_sealed, "workspace_sealed"),
    evidence_state: evidenceState(row.evidence_state),
    retention_state: retentionState(row.retention_state),
    evidence_manifest_hash: row.evidence_manifest_hash === null ? null : hash(row.evidence_manifest_hash, "evidence_manifest_hash"),
    reconciliation_state: reconciliationState(row.reconciliation_state),
  };
}

function parsePrepare(value: unknown): EvolutionEvalPrepareResultV1 {
  const row = exactRecord(value, "prepare result");
  exactKeys(row, ["schema", "eval_job_id", "tool_run_id", "workspace_id", "ordinal", "state", "workspace_revision", "source_commit", "source_manifest_hash", "workspace_manifest_hash", "deadline_at", "effective_timeout_ms", "replayed"], "prepare result");
  if (row.schema !== "evolution-eval-prepare-result.v1" || row.state !== "submitted") throw new TypeError("prepare result is invalid");
  return { schema: row.schema, eval_job_id: routeId(row.eval_job_id, "eval_job_id"), tool_run_id: routeId(row.tool_run_id, "tool_run_id"), workspace_id: routeId(row.workspace_id, "workspace_id"), ordinal: ordinal(row.ordinal), state: "submitted", workspace_revision: positiveInteger(row.workspace_revision, "workspace_revision"), source_commit: commit(row.source_commit), source_manifest_hash: hash(row.source_manifest_hash, "source_manifest_hash"), workspace_manifest_hash: hash(row.workspace_manifest_hash, "workspace_manifest_hash"), deadline_at: timestamp(row.deadline_at, "deadline_at"), effective_timeout_ms: positiveInteger(row.effective_timeout_ms, "effective_timeout_ms"), replayed: bool(row.replayed, "replayed") };
}

function parseStatus(value: unknown): EvolutionEvalStatusV1 {
  const row = exactRecord(value, "status");
  exactKeys(row, ["schema", "eval_job_id", "tool_run_id", "curator_run_id", "application_id", "version_id", "ordinal", "operation", "run_class", "state", "deadline_at", "error_code", "workspace_manifest_hash", "evidence_manifest_hash", "evidence_state", "retention_state", "reconciliation_state", "replayed"], "status");
  if (row.schema !== "evolution-eval-status.v1" || row.run_class !== "evolution_eval") throw new TypeError("status binding is invalid");
  return { schema: row.schema, eval_job_id: routeId(row.eval_job_id, "eval_job_id"), tool_run_id: routeId(row.tool_run_id, "tool_run_id"), curator_run_id: routeId(row.curator_run_id, "curator_run_id"), application_id: routeId(row.application_id, "application_id"), version_id: routeId(row.version_id, "version_id"), ordinal: ordinal(row.ordinal), operation: operation(row.operation), run_class: "evolution_eval", state: state(row.state), deadline_at: timestamp(row.deadline_at, "deadline_at"), error_code: row.error_code === null ? null : text(row.error_code, "error_code"), workspace_manifest_hash: hash(row.workspace_manifest_hash, "workspace_manifest_hash"), evidence_manifest_hash: row.evidence_manifest_hash === null ? null : hash(row.evidence_manifest_hash, "evidence_manifest_hash"), evidence_state: evidenceState(row.evidence_state), retention_state: retentionState(row.retention_state), reconciliation_state: reconciliationState(row.reconciliation_state), replayed: bool(row.replayed, "replayed") };
}

function parseWorkspaceResult(value: unknown): EvolutionEvalWorkspaceResultV1 {
  const row = exactRecord(value, "workspace result");
  exactKeys(row, ["schema", "workspace_id", "workspace_revision", "workspace_manifest_hash", "file_count", "total_bytes", "replayed"], "workspace result");
  if (row.schema !== "evolution-eval-workspace-result.v1") throw new TypeError("workspace result schema is invalid");
  return { schema: row.schema, workspace_id: routeId(row.workspace_id, "workspace_id"), workspace_revision: positiveInteger(row.workspace_revision, "workspace_revision"), workspace_manifest_hash: hash(row.workspace_manifest_hash, "workspace_manifest_hash"), file_count: nonnegativeInteger(row.file_count, "file_count"), total_bytes: nonnegativeInteger(row.total_bytes, "total_bytes"), replayed: bool(row.replayed, "replayed") };
}

function parseWorkspaceFiles(value: unknown): EvolutionEvalWorkspaceFilesV1 {
  const row = exactRecord(value, "workspace files");
  exactKeys(row, ["schema", "workspace_id", "workspace_revision", "workspace_manifest_hash", "files"], "workspace files");
  if (row.schema !== "evolution-eval-workspace-files.v1") throw new TypeError("workspace files schema is invalid");
  const files = array(row.files, "files").map((raw, index) => {
    const file = exactRecord(raw, `files[${index}]`);
    exactKeys(file, ["path", "sha256", "size_bytes", "media_type", "read_only", "content_base64"], `files[${index}]`);
    return { path: portablePath(file.path, "path"), sha256: hash(file.sha256, "sha256"), size_bytes: nonnegativeInteger(file.size_bytes, "size_bytes"), media_type: text(file.media_type, "media_type"), read_only: bool(file.read_only, "read_only"), content_base64: text(file.content_base64, "content_base64") };
  });
  return { schema: row.schema, workspace_id: routeId(row.workspace_id, "workspace_id"), workspace_revision: positiveInteger(row.workspace_revision, "workspace_revision"), workspace_manifest_hash: hash(row.workspace_manifest_hash, "workspace_manifest_hash"), files };
}

function parseEvidenceMutation(value: unknown): EvolutionEvalEvidenceMutationResultV1 {
  const row = exactRecord(value, "evidence result");
  if (row.schema === "evolution-eval-evidence-pending.v1") {
    exactKeys(row, ["schema", "eval_job_id", "action", "duty_state", "replayed"], "evidence pending");
    if ((row.action !== "freeze" && row.action !== "ack") || (row.duty_state !== "freeze_pending" && row.duty_state !== "ack_pending")) throw new TypeError("evidence pending is invalid");
    return { schema: row.schema, eval_job_id: routeId(row.eval_job_id, "eval_job_id"), action: row.action, duty_state: row.duty_state, replayed: bool(row.replayed, "replayed") };
  }
  exactKeys(row, ["schema", "eval_job_id", "tool_run_id", "manifest_hash", "evidence_state", "retention_state", "entries", "replayed"], "evidence manifest");
  if (row.schema !== "evolution-eval-evidence-manifest.v1" || row.evidence_state !== "frozen" || (row.retention_state !== "pending_ack" && row.retention_state !== "acknowledged")) throw new TypeError("evidence manifest is invalid");
  const entries = array(row.entries, "entries").map((raw, index) => {
    const item = exactRecord(raw, `entries[${index}]`);
    exactKeys(item, ["name", "sha256", "size_bytes", "media_type", "artifact_classification", "usage_classification"], `entries[${index}]`);
    if (item.media_type !== "application/json" && item.media_type !== "text/plain" && item.media_type !== "application/octet-stream") throw new TypeError("evidence media_type is invalid");
    if (item.artifact_classification !== "experimental/evolution_eval" && item.artifact_classification !== "evolution_eval_evidence") throw new TypeError("evidence classification is invalid");
    if (item.usage_classification !== "evolution_eval_only") throw new TypeError("evidence usage classification is invalid");
    return {
      name: evidenceName(item.name),
      sha256: hash(item.sha256, "sha256"),
      size_bytes: nonnegativeInteger(item.size_bytes, "size_bytes"),
      media_type: item.media_type as "application/json" | "text/plain" | "application/octet-stream",
      artifact_classification: item.artifact_classification as "experimental/evolution_eval" | "evolution_eval_evidence",
      usage_classification: "evolution_eval_only" as const,
    };
  });
  return { schema: row.schema, eval_job_id: routeId(row.eval_job_id, "eval_job_id"), tool_run_id: routeId(row.tool_run_id, "tool_run_id"), manifest_hash: hash(row.manifest_hash, "manifest_hash"), evidence_state: "frozen", retention_state: row.retention_state, entries, replayed: bool(row.replayed, "replayed") };
}

function parseEvidenceContent(value: unknown): EvolutionEvalEvidenceContentV1 {
  const row = exactRecord(value, "evidence content");
  exactKeys(row, ["schema", "name", "sha256", "size_bytes", "media_type", "content_base64"], "evidence content");
  if (row.schema !== "evolution-eval-evidence-content.v1") throw new TypeError("evidence content schema is invalid");
  return { schema: row.schema, name: evidenceName(row.name), sha256: hash(row.sha256, "sha256"), size_bytes: nonnegativeInteger(row.size_bytes, "size_bytes"), media_type: text(row.media_type, "media_type"), content_base64: text(row.content_base64, "content_base64") };
}

function exactRecord(value: unknown, name: string): Record<string, unknown> {
  return record(value, name);
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${name} has unknown or missing fields`);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/.test(value) || value.normalize("NFC") !== value) throw new TypeError(`${name} is invalid`);
  return value;
}
function opaque(value: unknown, name: string): string {
  const result = text(value, name);
  if (Buffer.byteLength(result, "utf8") > 128) throw new TypeError(`${name} is too long`);
  return result;
}
function routeId(value: unknown, name: string): string {
  const result = opaque(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new TypeError(`${name} is invalid`);
  return result;
}
function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} must be a lowercase sha256`);
  return value;
}
function commit(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new TypeError("source_commit is invalid");
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${name} must be a positive integer`);
  return Number(value);
}
function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return Number(value);
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw new TypeError(`${name} must be an ISO UTC timestamp`);
  return result;
}
function nullableTimestamp(value: unknown, name: string): string | null {
  return value === null ? null : timestamp(value, name);
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}
function ordinal(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) throw new TypeError("ordinal is invalid");
  return value;
}
function operation(value: unknown): EvolutionEvalOperation {
  if (typeof value !== "string" || !EVOLUTION_EVAL_OPERATIONS.includes(value as EvolutionEvalOperation)) throw new TypeError("operation is forbidden");
  return value as EvolutionEvalOperation;
}
function state(value: unknown): EvolutionEvalJobState {
  if (value !== "submitted" && value !== "running" && value !== "rejected" && value !== "succeeded" && value !== "failed" && value !== "cancelled" && value !== "timeout" && value !== "unknown_effect") throw new TypeError("job state is invalid");
  return value;
}
function evidenceState(value: unknown): EvolutionEvalEvidenceState {
  if (value !== "none" && value !== "freeze_pending" && value !== "frozen" && value !== "corrupt" && value !== "unavailable_at_deadline") throw new TypeError("evidence state is invalid");
  return value;
}
function retentionState(value: unknown): EvolutionEvalRetentionState {
  if (value !== "not_applicable" && value !== "pending_ack" && value !== "acknowledged" && value !== "quarantine_pending" && value !== "expired") throw new TypeError("retention state is invalid");
  return value;
}
function reconciliationState(value: unknown): EvolutionEvalReconciliationState {
  if (value !== "not_needed" && value !== "confirmed" && value !== "required") throw new TypeError("reconciliation state is invalid");
  return value;
}
function portablePath(value: unknown, name: string): string {
  const result = text(value, name);
  if (Buffer.byteLength(result, "utf8") > 512 || result.includes("\\") || result.startsWith("/") || result.split("/").length > 32 || result.split("/").some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) throw new TypeError(`${name} is not a portable workspace path`);
  return result;
}
function paths(value: unknown, name: string, min: number, max: number): string[] {
  const rows = array(value, name);
  if (rows.length < min || rows.length > max) throw new TypeError(`${name} has invalid length`);
  const result = rows.map(item => portablePath(item, name));
  if (new Set(result.map(item => item.toLowerCase())).size !== result.length) throw new TypeError(`${name} contains duplicates or case collisions`);
  return result;
}
function symbol(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(result)) throw new TypeError(`${name} is invalid`);
  return result;
}
function part(value: unknown): string {
  const result = text(value, "part");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new TypeError("part is invalid");
  return result;
}
function evidenceName(value: unknown): string {
  const result = text(value, "evidence name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(result)) throw new TypeError("evidence name is invalid");
  return result;
}
