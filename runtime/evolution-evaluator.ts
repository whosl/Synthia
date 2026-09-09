import { createHash } from "node:crypto";
import type {
  CuratorClaimV1,
  CuratorEvaluationV1,
  CuratorRemediationV1,
} from "./evolution-worker-client.ts";
import {
  EVOLUTION_MODEL_OUTPUT_MAX_BYTES,
  parseCuratorOutput,
  type EvolutionJsonModel,
} from "./evolution-workers.ts";
import {
  EVOLUTION_EVAL_OPERATIONS,
  EvolutionEvalClientError,
  validateEvolutionEvalModelParameters,
  type EvolutionEvalClient,
  type EvolutionEvalInputV1,
  type EvolutionEvalOperation,
  type EvolutionEvalParametersV1,
  type EvolutionEvalRecoveryJobV1,
  type EvolutionEvalRecoveryV1,
  type EvolutionEvalStatusV1,
  type EvolutionEvalWorkspaceChangeV1,
} from "./evolution-eval-client.ts";

export const EVOLUTION_EVALUATOR_PROMPT_VERSION = "evolution-evaluator.v1";
export const EVOLUTION_EVALUATOR_MAX_JOBS = 3;
export const EVOLUTION_EVALUATOR_BUDGET_MS = 2 * 60 * 60 * 1000;

export const EVOLUTION_EVALUATOR_SYSTEM_PROMPT = [
  `You are Synthia's ${EVOLUTION_EVALUATOR_PROMPT_VERSION}.`,
  "Return exactly one JSON object and no markdown.",
  "The only actions are run_eval and finalize; obey the supplied allowed_actions array.",
  "run_eval may request exactly one validate_sources, simulate, synthesize, or implement job.",
  "Never emit raw Tcl, commands, hardware access, formal/gate/publish/download/project writes, or execute Skill scripts.",
  "Workspace changes may only create/delete bounded HDL or XDC overlay files for this isolated eval job.",
  "Use finalize when evaluation is possible from current evidence or further effects are forbidden.",
].join("\n");

export interface EvolutionEvaluatorOptions {
  readonly pollIntervalMs?: number;
  readonly maxRecoveryPolls?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface EvolutionEvaluatorResult {
  readonly evaluations: readonly CuratorEvaluationV1[];
  readonly remediations: readonly CuratorRemediationV1[];
  readonly evalRecovery: EvolutionEvalRecoveryV1;
  readonly turns: number;
  readonly jobsRun: number;
}

export interface EvolutionEvaluatorRunInput {
  readonly run: NonNullable<CuratorClaimV1["run"]>;
}

type RunEvalAction = {
  readonly action: "run_eval";
  readonly applicationId: string;
  readonly operation: EvolutionEvalOperation;
  readonly parameters: EvolutionEvalParametersV1;
  readonly timeoutMs: number;
  readonly changes: readonly EvolutionEvalWorkspaceChangeV1[];
};

type EvaluatorAction = RunEvalAction | { readonly action: "finalize"; readonly output: unknown };

export class EvolutionEvaluator {
  readonly #pollIntervalMs: number;
  readonly #maxRecoveryPolls: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly client: EvolutionEvalClient,
    private readonly model: EvolutionJsonModel,
    options: EvolutionEvaluatorOptions = {},
  ) {
    this.#pollIntervalMs = nonnegativeInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    this.#maxRecoveryPolls = positiveInteger(options.maxRecoveryPolls ?? 7_200, "maxRecoveryPolls");
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async run(input: EvolutionEvaluatorRunInput, signal?: AbortSignal): Promise<EvolutionEvaluatorResult> {
    const run = input.run;
    throwIfAborted(signal);
    let recovery = run.mode === "dry_run"
      ? validateDryRunRecovery(run.eval_recovery)
      : await this.#recoverUntilSafe(run, signal);
    let turns = 0;
    let jobsRun = 0;

    while (turns <= EVOLUTION_EVALUATOR_MAX_JOBS) {
      throwIfAborted(signal);
      const allowedActions = this.#allowedActions(run, recovery);
      const raw = await this.model.generateJson({
        purpose: "curation",
        systemPrompt: EVOLUTION_EVALUATOR_SYSTEM_PROMPT,
        userPrompt: JSON.stringify(modelInput(run, recovery, allowedActions)),
        maxOutputBytes: EVOLUTION_MODEL_OUTPUT_MAX_BYTES,
      }, signal);
      turns += 1;
      const action = parseAction(raw, run, recovery, allowedActions);

      if (action.action === "finalize") {
        if (run.mode !== "dry_run") recovery = await this.#recoverUntilSafe(run, signal);
        const parsed = parseCuratorOutput(action.output, run);
        const evaluations = attachExactRefs(parsed.evaluations, recovery);
        const constrained = constrainUnattributableApplications(
          run,
          evaluations,
          parsed.remediations,
          recovery,
        );
        return {
          evaluations: constrained.evaluations,
          remediations: constrained.remediations,
          evalRecovery: recovery,
          turns,
          jobsRun,
        };
      }

      if (jobsRun >= EVOLUTION_EVALUATOR_MAX_JOBS || recovery.jobs.length >= EVOLUTION_EVALUATOR_MAX_JOBS) {
        throw new EvolutionEvaluatorContractError("model requested a fourth eval job");
      }
      const closeout = await this.#runOne(
        run,
        action,
        recovery.jobs.length + 1,
        new Set(recovery.jobs.map(job => job.eval_job_id)),
        recovery.deadline_at,
        signal,
      );
      jobsRun += 1;
      recovery = closeout ?? await this.#recoverUntilSafe(run, signal);
    }
    throw new EvolutionEvaluatorContractError("model omitted finalize after the bounded eval budget");
  }

  #allowedActions(
    run: NonNullable<CuratorClaimV1["run"]>,
    recovery: EvolutionEvalRecoveryV1,
  ): readonly ("run_eval" | "finalize")[] {
    if (
      run.mode === "dry_run"
      || recovery.unknown_effect_latched_at !== null
      || recovery.jobs.length >= EVOLUTION_EVALUATOR_MAX_JOBS
      || recovery.jobs.some(job => !terminal(job.state) || job.reconciliation_state === "required")
      || recovery.deadline_at === null
      || this.#now() >= Date.parse(recovery.deadline_at)
      || !run.applications.some(bundle => bundle.eval_input !== null)
    ) return ["finalize"];
    return ["run_eval", "finalize"];
  }

  async #runOne(
    run: NonNullable<CuratorClaimV1["run"]>,
    action: RunEvalAction,
    ordinal: number,
    knownJobIds: ReadonlySet<string>,
    deadlineAt: string | null,
    signal?: AbortSignal,
  ): Promise<EvolutionEvalRecoveryV1 | null> {
    if (deadlineAt === null || this.#now() >= Date.parse(deadlineAt)) {
      throw new EvolutionEvaluatorContractError("run_eval crossed the authoritative eval deadline");
    }
    const bundle = run.applications.find(
      candidate => candidate.application.application_id === action.applicationId,
    );
    const evalInput = bundle?.eval_input;
    if (!bundle || evalInput === null || evalInput === undefined) {
      throw new EvolutionEvaluatorContractError("run_eval application has no eval_input_ref");
    }
    validateActionBinding(action, evalInput);
    const baseKey = deterministicKey({
      schema: EVOLUTION_EVALUATOR_PROMPT_VERSION,
      run_id: run.run_id,
      application_id: action.applicationId,
      ordinal,
      operation: action.operation,
      parameters: action.parameters,
      timeout_ms: action.timeoutMs,
      changes: action.changes,
    });
    try {
      const prepared = await this.client.prepare(run.run_id, {
        schema: "evolution-eval-prepare.v1",
        curator_lease_token: run.lease_token,
        application_id: action.applicationId,
        evidence_snapshot_hash: bundle.evidence_snapshot_hash,
        version_id: bundle.primary_version.version_id,
        eval_input_ref: evalInput.eval_input_ref,
        input_manifest_hash: evalInput.input_manifest_hash,
        operation: action.operation,
        parameters: action.parameters,
        timeout_ms: action.timeoutMs,
      }, `${baseKey}:prepare`, signal);
      let revision = prepared.workspace_revision;
      let manifestHash = prepared.workspace_manifest_hash;
      if (action.changes.length > 0) {
        const written = await this.client.writeWorkspace(run.run_id, prepared.eval_job_id, {
          curator_lease_token: run.lease_token,
          workspace_id: prepared.workspace_id,
          expected_workspace_revision: revision,
          changes: action.changes,
        }, `${baseKey}:write`, signal);
        revision = written.workspace_revision;
        manifestHash = written.workspace_manifest_hash;
      }
      await this.client.submit(run.run_id, prepared.eval_job_id, {
        curator_lease_token: run.lease_token,
        workspace_id: prepared.workspace_id,
        expected_workspace_revision: revision,
        expected_workspace_manifest_hash: manifestHash,
      }, `${baseKey}:submit`, signal);
      return null;
    } catch (error) {
      throwIfAborted(signal);
      return await this.#closeoutAfterMutationError(
        run,
        knownJobIds,
        error,
        signal,
      );
    }
  }

  async #closeoutAfterMutationError(
    run: NonNullable<CuratorClaimV1["run"]>,
    knownJobIds: ReadonlySet<string>,
    originalError: unknown,
    signal?: AbortSignal,
  ): Promise<EvolutionEvalRecoveryV1> {
    let recovery: EvolutionEvalRecoveryV1;
    try {
      recovery = await this.client.recover(run.run_id, run.lease_token, signal);
    } catch (recoveryError) {
      throw new EvolutionEvaluatorUnsafeToFailError(originalError, recoveryError);
    }
    const newJobs = recovery.jobs.filter(job => !knownJobIds.has(job.eval_job_id));
    if (newJobs.length === 0) throw originalError;
    for (const job of newJobs) {
      if (!terminal(job.state)) {
        try {
          await this.client.cancel(run.run_id, job.eval_job_id, {
            curator_lease_token: run.lease_token,
            reason_code: "EVALUATOR_TRANSPORT_UNCERTAIN",
          }, `${deterministicKey({ run_id: run.run_id, eval_job_id: job.eval_job_id })}:cancel`, signal);
        } catch {
          // The durable cancel request may itself have lost its response. The
          // following recovery is the only authority for whether closeout won.
        }
      }
    }
    try {
      return await this.#recoverUntilSafe(run, signal);
    } catch (recoveryError) {
      throw new EvolutionEvaluatorUnsafeToFailError(originalError, recoveryError);
    }
  }

  async #recoverUntilSafe(
    run: NonNullable<CuratorClaimV1["run"]>,
    signal?: AbortSignal,
  ): Promise<EvolutionEvalRecoveryV1> {
    const elapsedDeadline = this.#now() + EVOLUTION_EVALUATOR_BUDGET_MS;
    let recovery: EvolutionEvalRecoveryV1 | null = null;
    for (let poll = 0; poll < this.#maxRecoveryPolls; poll += 1) {
      throwIfAborted(signal);
      recovery = await this.client.recover(run.run_id, run.lease_token, signal);
      const safeNoEvidence = await this.#requestMissingEvidence(run, recovery, signal);
      recovery = await this.client.recover(run.run_id, run.lease_token, signal);
      if (safeForModel(recovery, safeNoEvidence)) return recovery;
      const authoritativeDeadline = recovery.deadline_at === null
        ? elapsedDeadline
        : Date.parse(recovery.deadline_at);
      const cutoff = Math.min(elapsedDeadline, authoritativeDeadline);
      if (this.#now() >= cutoff) {
        // One final query-first closeout attempt is allowed after the clock
        // crosses the boundary. It may freeze evidence, but it can never
        // start a new eval effect or keep polling beyond this attempt.
        recovery = await this.client.recover(run.run_id, run.lease_token, signal);
        const finalSafeNoEvidence = await this.#requestMissingEvidence(run, recovery, signal);
        recovery = await this.client.recover(run.run_id, run.lease_token, signal);
        if (safeForModel(recovery, finalSafeNoEvidence)) return recovery;
        throw new EvolutionEvaluatorRecoveryError(recovery);
      }
      if (poll + 1 < this.#maxRecoveryPolls) {
        await this.#sleep(
          Math.min(this.#pollIntervalMs, Math.max(0, cutoff - this.#now())),
          signal,
        );
      }
    }
    throw new EvolutionEvaluatorRecoveryError(recovery);
  }

  async #requestMissingEvidence(
    run: NonNullable<CuratorClaimV1["run"]>,
    recovery: EvolutionEvalRecoveryV1,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const safeNoEvidence = new Map<string, string>();
    for (const job of recovery.jobs) {
      if (
        (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled" || job.state === "timeout")
        && (job.evidence_state === "none" || job.evidence_state === "freeze_pending")
      ) {
        if (
          job.state === "failed"
          && job.evidence_state === "none"
        ) {
          let status: EvolutionEvalStatusV1;
          try {
            status = await this.client.status(
              run.run_id,
              job.eval_job_id,
              run.lease_token,
              signal,
            );
            assertExactStatusBinding(run.run_id, recovery.deadline_at, job, status);
          } catch (error) {
            throw new EvolutionEvaluatorUnsafeToFailError(error);
          }
          if (
            status.error_code === "EVOLUTION_EVAL_NOT_ACCEPTED"
            || status.error_code === "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE"
          ) {
            safeNoEvidence.set(job.eval_job_id, recoveryJobFingerprint(job));
            continue;
          }
        }
        try {
          await this.client.freezeEvidence(
            run.run_id,
            job.eval_job_id,
            run.lease_token,
            `${deterministicKey({ run_id: run.run_id, eval_job_id: job.eval_job_id })}:freeze`,
            signal,
          );
        } catch (error) {
          if (
            error instanceof EvolutionEvalClientError
            && (error.retryable || error.code === "EVOLUTION_EVAL_EVIDENCE_NOT_READY")
          ) continue;
          throw new EvolutionEvaluatorUnsafeToFailError(error);
        }
      }
    }
    return safeNoEvidence;
  }
}

export class EvolutionEvaluatorContractError extends Error {
  readonly code = "MALFORMED_MODEL_OUTPUT";
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "EvolutionEvaluatorContractError";
  }
}

export class EvolutionEvaluatorRecoveryError extends Error {
  readonly code = "EVOLUTION_EVAL_RECONCILIATION_REQUIRED";
  readonly retryable = true;
  readonly suppressCuratorFail = true;
  constructor(readonly recovery: EvolutionEvalRecoveryV1 | null) {
    super("evolution eval recovery did not settle within the bounded poll window");
    this.name = "EvolutionEvaluatorRecoveryError";
  }
}

export class EvolutionEvaluatorUnsafeToFailError extends Error {
  readonly code = "EVOLUTION_EVAL_RECONCILIATION_REQUIRED";
  readonly retryable = true;
  readonly suppressCuratorFail = true;
  constructor(readonly originalError: unknown, readonly recoveryError: unknown = null) {
    super("evolution eval mutation is uncertain; Curator fail is forbidden until recovery closes it");
    this.name = "EvolutionEvaluatorUnsafeToFailError";
  }
}

function parseAction(
  value: unknown,
  run: NonNullable<CuratorClaimV1["run"]>,
  recovery: EvolutionEvalRecoveryV1,
  allowed: readonly ("run_eval" | "finalize")[],
): EvaluatorAction {
  const row = strictRecord(value, "evaluator action");
  if (row.action === "finalize") {
    exactKeys(row, ["action", "evaluations", "remediations"], "finalize action");
    return { action: "finalize", output: { evaluations: row.evaluations, remediations: row.remediations } };
  }
  if (row.action !== "run_eval" || !allowed.includes("run_eval")) {
    throw new EvolutionEvaluatorContractError("run_eval is not currently allowed");
  }
  exactKeys(row, ["action", "application_id", "operation", "parameters", "timeout_ms", "workspace_changes"], "run_eval action");
  if (typeof row.operation !== "string" || !EVOLUTION_EVAL_OPERATIONS.includes(row.operation as EvolutionEvalOperation)) {
    throw new EvolutionEvaluatorContractError("operation is forbidden");
  }
  const applicationId = identifier(row.application_id, "application_id");
  const bundle = run.applications.find(item => item.application.application_id === applicationId);
  if (!bundle || bundle.eval_input === null) throw new EvolutionEvaluatorContractError("application is not eval-capable");
  if (recovery.jobs.some(job => job.application_id === applicationId && !terminal(job.state))) {
    throw new EvolutionEvaluatorContractError("eval jobs must be serial");
  }
  let parameters: EvolutionEvalParametersV1;
  try {
    parameters = validateEvolutionEvalModelParameters(row.parameters, row.operation as EvolutionEvalOperation);
  } catch (error) {
    throw new EvolutionEvaluatorContractError(error instanceof Error ? error.message : "parameters are invalid");
  }
  const timeoutMs = positiveInteger(row.timeout_ms, "timeout_ms");
  if (timeoutMs > EVOLUTION_EVALUATOR_BUDGET_MS) throw new EvolutionEvaluatorContractError("timeout exceeds two-hour cap");
  const changes = parseChanges(row.workspace_changes, bundle);
  return { action: "run_eval", applicationId, operation: row.operation as EvolutionEvalOperation, parameters, timeoutMs, changes };
}

function parseChanges(
  value: unknown,
  bundle: NonNullable<CuratorClaimV1["run"]>["applications"][number],
): readonly EvolutionEvalWorkspaceChangeV1[] {
  if (!Array.isArray(value) || value.length > 32) throw new EvolutionEvaluatorContractError("workspace_changes exceeds its limit");
  const skillPaths = new Set(bundle.primary_version.files.map(file => file.path.toLowerCase()));
  let decodedBytes = 0;
  return value.map((raw, index) => {
    const row = strictRecord(raw, `workspace_changes[${index}]`);
    const path = portableOverlayPath(row.path);
    if (skillPaths.has(path.toLowerCase())) throw new EvolutionEvaluatorContractError("Skill assets are immutable");
    if (row.action === "delete") {
      exactKeys(row, ["action", "path"], `workspace_changes[${index}]`);
      return { action: "delete", path };
    }
    if (row.action !== "upsert") throw new EvolutionEvaluatorContractError("workspace change action is invalid");
    exactKeys(row, ["action", "path", "sha256", "content_base64"], `workspace_changes[${index}]`);
    if (!/^[0-9a-f]{64}$/.test(String(row.sha256))) throw new EvolutionEvaluatorContractError("workspace content hash is invalid");
    if (typeof row.content_base64 !== "string" || !canonicalBase64(row.content_base64)) throw new EvolutionEvaluatorContractError("workspace content is not canonical base64");
    const bytes = Buffer.from(row.content_base64, "base64");
    if (bytes.byteLength > 1024 * 1024) throw new EvolutionEvaluatorContractError("workspace file exceeds 1 MiB");
    decodedBytes += bytes.byteLength;
    if (decodedBytes > 8 * 1024 * 1024) throw new EvolutionEvaluatorContractError("workspace write exceeds 8 MiB");
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new EvolutionEvaluatorContractError("workspace content hash does not match bytes");
    return { action: "upsert", path, sha256: row.sha256, content_base64: row.content_base64 };
  });
}

function validateActionBinding(action: RunEvalAction, input: EvolutionEvalInputV1): void {
  if (!input.allowed_operations.includes(action.operation)) throw new EvolutionEvaluatorContractError("operation is outside eval input allowlist");
  if (
    (action.parameters.operation === "synthesize" || action.parameters.operation === "implement")
    && action.parameters.part !== input.part
  ) throw new EvolutionEvaluatorContractError("part differs from Core eval input binding");
  if (action.parameters.operation === "implement" && action.parameters.generate_trial_bitstream && !input.trial_bitstream_allowed) {
    throw new EvolutionEvaluatorContractError("trial bitstream is not allowed by eval input");
  }
}

function safeForModel(
  recovery: EvolutionEvalRecoveryV1,
  safeNoEvidence: ReadonlyMap<string, string>,
): boolean {
  return recovery.jobs.every(job => {
    if (!terminal(job.state) || job.reconciliation_state === "required") return false;
    if (job.state === "rejected" || job.state === "unknown_effect") return job.evidence_state === "none";
    if (job.state === "failed" && job.evidence_state === "none") {
      return safeNoEvidence.get(job.eval_job_id) === recoveryJobFingerprint(job);
    }
    return job.evidence_state === "frozen" || job.evidence_state === "corrupt" || job.evidence_state === "unavailable_at_deadline";
  });
}

function recoveryJobFingerprint(job: EvolutionEvalRecoveryJobV1): string {
  return deterministicKey(job);
}

function assertExactStatusBinding(
  runId: string,
  recoveryDeadlineAt: string | null,
  job: EvolutionEvalRecoveryJobV1,
  status: EvolutionEvalStatusV1,
): void {
  const exact: readonly [unknown, unknown][] = [
    [status.eval_job_id, job.eval_job_id],
    [status.tool_run_id, job.tool_run_id],
    [status.curator_run_id, runId],
    [status.application_id, job.application_id],
    [status.version_id, job.version_id],
    [status.ordinal, job.ordinal],
    [status.operation, job.operation],
    [status.state, job.state],
    [status.deadline_at, recoveryDeadlineAt],
    [status.workspace_manifest_hash, job.workspace_manifest_hash],
    [status.evidence_manifest_hash, job.evidence_manifest_hash],
    [status.evidence_state, job.evidence_state],
    [status.retention_state, job.retention_state],
    [status.reconciliation_state, job.reconciliation_state],
  ];
  if (exact.some(([left, right]) => left !== right)) {
    throw new EvolutionEvaluatorContractError("status does not match the exact recovery binding");
  }
}

function attachExactRefs(
  evaluations: readonly CuratorEvaluationV1[],
  recovery: EvolutionEvalRecoveryV1,
): CuratorEvaluationV1[] {
  return evaluations.map(evaluation => ({
    ...evaluation,
    eval_job_refs: recovery.jobs
      .filter(job => job.application_id === evaluation.application_id)
      .map(job => ({
        eval_job_id: job.eval_job_id,
        tool_run_id: job.tool_run_id,
        evidence_manifest_hash: job.evidence_state === "frozen" ? job.evidence_manifest_hash : null,
      })),
  }));
}

function constrainUnattributableApplications(
  run: NonNullable<CuratorClaimV1["run"]>,
  evaluations: readonly CuratorEvaluationV1[],
  remediations: readonly CuratorRemediationV1[],
  recovery: EvolutionEvalRecoveryV1,
): { evaluations: CuratorEvaluationV1[]; remediations: CuratorRemediationV1[] } {
  const affectedApplications = new Set(recovery.jobs
    .filter(job => job.state === "unknown_effect" || job.evidence_state === "corrupt" || job.evidence_state === "unavailable_at_deadline")
    .map(job => job.application_id));
  const affectedSkills = new Set(run.applications
    .filter(bundle => affectedApplications.has(bundle.application.application_id))
    .map(bundle => bundle.primary_version.skill.skill_id));
  for (const evaluation of evaluations) {
    if (affectedApplications.has(evaluation.application_id) && evaluation.outcome !== "inconclusive") {
      throw new EvolutionEvaluatorContractError("unknown/corrupt/unavailable application must be inconclusive");
    }
  }
  for (const remediation of remediations) {
    if (affectedSkills.has(remediation.skill_id) && remediation.action !== "no_op") {
      throw new EvolutionEvaluatorContractError("unknown/corrupt/unavailable remediation must be no_op");
    }
  }
  return { evaluations: [...evaluations], remediations: [...remediations] };
}

function modelInput(
  run: NonNullable<CuratorClaimV1["run"]>,
  recovery: EvolutionEvalRecoveryV1,
  allowedActions: readonly ("run_eval" | "finalize")[],
): Record<string, unknown> {
  return {
    schema: "evolution-evaluator-model-input.v1",
    mode: run.mode,
    allowed_actions: allowedActions,
    budget: {
      deadline_at: recovery.deadline_at,
      max_jobs: EVOLUTION_EVALUATOR_MAX_JOBS,
      jobs_used: recovery.jobs.length,
      serial: true,
    },
    unknown_effect_latched: recovery.unknown_effect_latched_at !== null,
    eval_recovery: recovery,
    applications: run.applications.map(bundle => ({
      application: bundle.application,
      primary_version: bundle.primary_version,
      evidence_snapshot_hash: bundle.evidence_snapshot_hash,
      evidence: bundle.evidence,
      eval_input: bundle.eval_input,
    })),
  };
}

function validateDryRunRecovery(recovery: EvolutionEvalRecoveryV1): EvolutionEvalRecoveryV1 {
  if (recovery.budget_started_at !== null || recovery.deadline_at !== null || recovery.unknown_effect_latched_at !== null || recovery.jobs.length !== 0) {
    throw new EvolutionEvaluatorContractError("dry-run claim carried eval state");
  }
  return recovery;
}

function terminal(state: EvolutionEvalRecoveryJobV1["state"]): boolean {
  return state !== "submitted" && state !== "running";
}

function deterministicKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EvolutionEvaluatorContractError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new EvolutionEvaluatorContractError(`${label} has unknown or missing fields`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || Buffer.byteLength(value) > 128) throw new EvolutionEvaluatorContractError(`${label} is invalid`);
  return value;
}

function portableOverlayPath(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 512 || value.includes("\\") || value.startsWith("/")) throw new EvolutionEvaluatorContractError("workspace path is invalid");
  const segments = value.split("/");
  if (segments.length > 32 || segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) throw new EvolutionEvaluatorContractError("workspace path is invalid");
  const extension = value.slice(value.lastIndexOf(".")).toLowerCase();
  if (![".v", ".vh", ".sv", ".svh", ".xdc"].includes(extension)) throw new EvolutionEvaluatorContractError("raw Tcl, command, binary, and Skill-script overlays are forbidden");
  return value;
}

function canonicalBase64(value: string): boolean {
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new EvolutionEvaluatorContractError(`${label} must be a positive integer`);
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return Number(value);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
}
