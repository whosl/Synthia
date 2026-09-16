/**
 * Narrow Runtime clients for the two self-evolution service identities.
 *
 * Each client is constructed with its own singleton capability token and can
 * only call its A.4 or A.5 internal run routes. Neither surface exposes task,
 * project, governance, Connector, or Vivado operations.
 */


export type EvolutionQualityState =
  | "active_unproven"
  | "active_observed"
  | "needs_review"
  | "degraded"
  | "quarantined";

export type EvolutionEvaluationOutcome =
  | "success"
  | "applicability_failure"
  | "execution_failure"
  | "inconclusive";

export interface EvolutionSkillMetricsV1 {
  readonly measurement_state: "unknown" | "observed";
  readonly primary_applied: number;
  readonly evaluated: number;
  readonly pending: number;
  readonly inconclusive: number;
  readonly success: number;
  readonly applicability_failure: number;
  readonly execution_failure: number;
  readonly success_rate: number | null;
  readonly median_duration_ms: number | null;
  readonly human_corrections: number | null;
  readonly first_solved_problem_families: number | null;
}

export interface EvolutionLearnedSkillSummaryV1 {
  readonly schema: "learned-skill-summary.v1";
  readonly skill_id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly applicability_summary: string;
  readonly active_version_id: string | null;
  readonly active_version_no: number | null;
  readonly quality_state: EvolutionQualityState | null;
  readonly freshness_state: "current" | "stale";
  readonly availability_state: "available" | "archived";
  readonly enabled: boolean;
  readonly pinned: boolean;
  readonly recommended: boolean;
  readonly control_revision: number;
  readonly last_used_at: string | null;
  readonly metrics: EvolutionSkillMetricsV1;
}

export interface DistillationClaimRequestV1 {
  readonly worker_id: string;
  readonly lease_seconds: number;
}

export interface DistillationClaimV1 {
  readonly schema: "distillation-claim.v1";
  readonly run: null | {
    readonly run_id: string;
    readonly state: "running";
    readonly attempt: number;
    readonly lease_token: string;
    readonly lease_expires_at: string;
    readonly episode: {
      readonly episode_id: string;
      readonly observation_key: string;
      readonly episode_key: string;
      readonly project_ref: string;
      readonly task_ref: string;
      readonly turn_id: string | null;
      readonly end_event_sequence: number;
      readonly content_hash: string;
      readonly outcome_claim: string | null;
    };
    readonly trajectory: {
      readonly schema: "learning-trajectory.v1";
      readonly objective: string;
      readonly messages: readonly {
        readonly sequence: number;
        readonly role: "user" | "assistant";
        readonly content: string;
        readonly content_hash: string;
      }[];
      readonly tools: readonly {
        readonly call_sequence: number;
        readonly result_sequence: number | null;
        readonly tool_call_id: string;
        readonly name: string;
        readonly args: unknown;
        readonly args_hash: string;
        readonly result: unknown;
        readonly result_hash: string;
        readonly is_error: boolean;
        readonly tool_run_refs: readonly string[];
        readonly evidence_refs: readonly string[];
      }[];
      readonly human_corrections: readonly {
        readonly sequence: number;
        readonly content: string;
        readonly content_hash: string;
      }[];
    };
    readonly existing_skills: readonly EvolutionLearnedSkillSummaryV1[];
  };
}

export interface EvolutionLeaseRequestV1 {
  readonly lease_token: string;
  readonly lease_seconds: number;
}

export interface DistillationLeaseV1 {
  readonly schema: "distillation-lease.v1";
  readonly run_id: string;
  readonly lease_expires_at: string;
}

export type EvolutionSkillFileKind = "skill_md" | "reference" | "template" | "script";

export interface DistillationSkillFileV1 {
  readonly path: string;
  readonly kind: EvolutionSkillFileKind;
  readonly language: "tcl" | "python" | "typescript" | null;
  readonly content: string;
}

export interface DistillationSkillV1 {
  readonly skill_id?: string | null;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly applicability: unknown;
  readonly outcome_contract: unknown;
  readonly files: readonly DistillationSkillFileV1[];
}

export type DistillationCompleteRequestV1 = {
  readonly lease_token: string;
  readonly input_hash: string;
  readonly model_id: string;
  readonly prompt_hash: string;
} & (
  | {
    readonly action: "no_op";
    readonly expected_parent_version_id: null;
    readonly expected_control_revision: null;
    readonly skill: null;
  }
  | {
    readonly action: "create";
    readonly expected_parent_version_id: null;
    readonly expected_control_revision: null;
    readonly skill: DistillationSkillV1;
  }
  | {
    readonly action: "patch";
    readonly expected_parent_version_id: string;
    readonly expected_control_revision: number;
    readonly skill: DistillationSkillV1 & { readonly skill_id: string };
  }
);

export interface DistillationResultV1 {
  readonly schema: "distillation-result.v1";
  readonly run_id: string;
  readonly state: "noop" | "succeeded" | "quarantined";
  readonly version_id: string | null;
  readonly replayed: boolean;
}

export interface EvolutionFailRequestV1 {
  readonly lease_token: string;
  readonly error_code: string;
  readonly retryable: boolean;
  readonly details_hash: string;
}

export interface DistillationFailureV1 {
  readonly schema: "distillation-failure.v1";
  readonly run_id: string;
  readonly state: "queued" | "failed";
}

export interface SkillApplicationDetailV1 {
  readonly schema: "skill-application-detail.v1";
  readonly application_id: string;
  readonly project_ref: string;
  readonly task_ref: string;
  readonly observation_key: string;
  readonly episode_ref: string | null;
  readonly local_goal: string;
  readonly state: "open" | "closed_pending_episode" | "pending_evaluation" | "evaluated";
  readonly started_at: string;
  readonly closed_at: string | null;
  readonly duration_ms: number | null;
  readonly human_corrections: number | null;
  readonly outcome_claim: string | null;
  readonly skills: readonly {
    readonly skill_id: string;
    readonly version_id: string;
    readonly role: "primary" | "supporting";
    readonly reason_codes: readonly string[];
  }[];
  readonly evidence_summary: {
    readonly visible: number;
    readonly redacted: number;
    readonly refs: readonly { readonly type: string; readonly id: string; readonly hash: string }[];
  };
  readonly evaluations: readonly {
    readonly evaluation_id: string;
    readonly outcome: EvolutionEvaluationOutcome;
    readonly confidence: number;
    readonly reason: string;
    readonly evidence_summary: {
      readonly visible: number;
      readonly redacted: number;
      readonly hashes: readonly string[];
    };
    readonly supersedes_id: string | null;
    readonly evaluator_type: "curator" | "human";
    readonly evaluator_version: string;
    readonly created_at: string;
  }[];
}

export interface CuratorClaimRequestV1 {
  readonly worker_id: string;
  readonly lease_seconds: number;
}

export interface CuratorClaimV1 {
  readonly schema: "curator-claim.v1";
  readonly run: null | {
    readonly run_id: string;
    readonly mode: "run" | "dry_run";
    readonly state: "running";
    readonly attempt: number;
    readonly lease_token: string;
    readonly lease_expires_at: string;
    readonly schedule_bucket: string;
    readonly applications: readonly {
      readonly application: SkillApplicationDetailV1;
      readonly primary_version: {
        readonly skill: EvolutionLearnedSkillSummaryV1;
        readonly version_id: string;
        readonly content_manifest_hash: string;
        readonly description: string;
        readonly applicability: unknown;
        readonly outcome_contract: unknown;
        readonly files: readonly {
          readonly path: string;
          readonly kind: string;
          readonly language: string | null;
          readonly sha256: string;
          readonly content: string;
        }[];
      };
      readonly evidence_snapshot_hash: string;
      readonly evidence: readonly {
        readonly type: string;
        readonly id: string;
        readonly sha256: string;
        readonly summary: string;
        readonly content: string | null;
      }[];
    }[];
  };
}

export interface CuratorLeaseV1 {
  readonly schema: "curator-lease.v1";
  readonly run_id: string;
  readonly lease_expires_at: string;
}

export interface CuratorEvaluationV1 {
  readonly application_id: string;
  readonly evidence_snapshot_hash: string;
  readonly outcome: EvolutionEvaluationOutcome;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence_refs: readonly unknown[];
  readonly eval_job_refs: readonly {
    readonly eval_job_id: string;
    readonly tool_run_id: string;
    readonly evidence_manifest_hash: string | null;
  }[];
  readonly supersedes_id: string | null;
}

export interface CuratorRemediationV1 {
  readonly skill_id: string;
  readonly expected_active_version_id: string;
  readonly expected_control_revision: number;
  readonly action: "no_op" | "patch" | "scope_change" | "state_action";
  readonly patch?: unknown;
  readonly state_action?: unknown;
}

export interface CuratorCompleteRequestV1 {
  readonly lease_token: string;
  readonly evaluator_version: string;
  readonly evaluations: readonly CuratorEvaluationV1[];
  readonly remediations: readonly CuratorRemediationV1[];
}

export interface CuratorSkippedActionV1 {
  readonly skill_id: string;
  readonly action: "no_op" | "patch" | "scope_change" | "state_action";
  readonly reason: string;
}

export interface CuratorResultV1 {
  readonly schema: "curator-result.v1";
  readonly run_id: string;
  readonly state: "completed" | "dry_run_complete";
  readonly evaluation_ids: readonly string[];
  readonly proposed_evaluations: readonly CuratorEvaluationV1[];
  readonly produced_version_ids: readonly string[];
  readonly skipped_actions: readonly CuratorSkippedActionV1[];
  readonly replayed: boolean;
}

export interface CuratorFailureV1 {
  readonly schema: "curator-failure.v1";
  readonly run_id: string;
  readonly state: "queued" | "failed";
}

interface InternalClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly requestTimeoutMs?: number;
}

export interface CoreDistillerEvolutionClientOptions extends InternalClientOptions {
  readonly distillerToken: string;
}

export interface CoreCuratorEvolutionClientOptions extends InternalClientOptions {
  readonly curatorToken: string;
}

export interface CoreSchedulerEvolutionClientOptions extends InternalClientOptions {
  readonly schedulerToken: string;
}

export interface CuratorScheduleRequestV1 {
  readonly request_key: string;
}

export interface CuratorScheduleResultV1 {
  readonly schema: "curator-schedule.v1";
  readonly request_key: string;
  readonly schedule_bucket: string;
  readonly eligible_at: string;
  readonly state: "queued" | "no_work" | "already_completed";
  readonly curator_run_id: string | null;
  readonly reason_code: string;
  readonly retry_not_before: string | null;
  readonly replayed: boolean;
}

export interface DistillerEvolutionClient {
  claim(input: DistillationClaimRequestV1, signal?: AbortSignal): Promise<DistillationClaimV1>;
  renewLease(runId: string, input: EvolutionLeaseRequestV1, signal?: AbortSignal): Promise<DistillationLeaseV1>;
  complete(runId: string, input: DistillationCompleteRequestV1, signal?: AbortSignal): Promise<DistillationResultV1>;
  fail(runId: string, input: EvolutionFailRequestV1, signal?: AbortSignal): Promise<DistillationFailureV1>;
}

export interface CuratorEvolutionClient {
  claim(input: CuratorClaimRequestV1, signal?: AbortSignal): Promise<CuratorClaimV1>;
  renewLease(runId: string, input: EvolutionLeaseRequestV1, signal?: AbortSignal): Promise<CuratorLeaseV1>;
  complete(runId: string, input: CuratorCompleteRequestV1, signal?: AbortSignal): Promise<CuratorResultV1>;
  fail(runId: string, input: EvolutionFailRequestV1, signal?: AbortSignal): Promise<CuratorFailureV1>;
}

export interface SchedulerEvolutionClient {
  ensureScheduled(
    input: CuratorScheduleRequestV1,
    signal?: AbortSignal,
  ): Promise<CuratorScheduleResultV1>;
}

export class EvolutionWorkerClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly correlationId: string | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "EvolutionWorkerClientError";
  }
}

export class CoreDistillerEvolutionClient implements DistillerEvolutionClient {
  private readonly transport: InternalEvolutionTransport;

  constructor(options: CoreDistillerEvolutionClientOptions) {
    this.transport = new InternalEvolutionTransport(options, requireToken(options.distillerToken));
  }

  async claim(input: DistillationClaimRequestV1, signal?: AbortSignal): Promise<DistillationClaimV1> {
    const data = await this.transport.post("distillation-runs/claim", claimBody(input), false, signal);
    return parseDistillationClaim(data);
  }

  async renewLease(runId: string, input: EvolutionLeaseRequestV1, signal?: AbortSignal): Promise<DistillationLeaseV1> {
    const id = requireRouteId(runId, "runId");
    const data = await this.transport.post(`distillation-runs/${encodeURIComponent(id)}/lease`, leaseBody(input), true, signal);
    return parseLease(data, "distillation-lease.v1", id) as DistillationLeaseV1;
  }

  async complete(runId: string, input: DistillationCompleteRequestV1, signal?: AbortSignal): Promise<DistillationResultV1> {
    const id = requireRouteId(runId, "runId");
    const data = await this.transport.post(
      `distillation-runs/${encodeURIComponent(id)}/complete`,
      distillationCompleteBody(input),
      true,
      signal,
    );
    return parseDistillationResult(data, id);
  }

  async fail(runId: string, input: EvolutionFailRequestV1, signal?: AbortSignal): Promise<DistillationFailureV1> {
    const id = requireRouteId(runId, "runId");
    const data = await this.transport.post(`distillation-runs/${encodeURIComponent(id)}/fail`, failBody(input), false, signal);
    return parseFailure(data, "distillation-failure.v1", id) as DistillationFailureV1;
  }
}

export class CoreCuratorEvolutionClient {
  private readonly transport: InternalEvolutionTransport;

  constructor(options: CoreCuratorEvolutionClientOptions) {
    this.transport = new InternalEvolutionTransport(options, requireToken(options.curatorToken));
  }

  async claimManual(input: CuratorClaimRequestV1, signal?: AbortSignal): Promise<CuratorClaimV1> {
    const data = await this.transport.post("curator-runs/claim-manual", claimBody(input), false, signal);
    return parseCuratorClaim(data);
  }

  async claimScheduled(input: CuratorClaimRequestV1, signal?: AbortSignal): Promise<CuratorClaimV1> {
    const data = await this.transport.post("curator-runs/claim-scheduled", claimBody(input), false, signal);
    return parseCuratorClaim(data);
  }

  async renewLease(runId: string, input: EvolutionLeaseRequestV1, signal?: AbortSignal): Promise<CuratorLeaseV1> {
    const id = requireRouteId(runId, "runId");
    const data = await this.transport.post(`curator-runs/${encodeURIComponent(id)}/lease`, leaseBody(input), true, signal);
    return parseLease(data, "curator-lease.v1", id) as CuratorLeaseV1;
  }

  async complete(runId: string, input: CuratorCompleteRequestV1, signal?: AbortSignal): Promise<CuratorResultV1> {
    const id = requireRouteId(runId, "runId");
    const data = await this.transport.post(
      `curator-runs/${encodeURIComponent(id)}/complete`,
      curatorCompleteBody(input),
      true,
      signal,
    );
    return parseCuratorResult(data, id);
  }

  async fail(runId: string, input: EvolutionFailRequestV1, signal?: AbortSignal): Promise<CuratorFailureV1> {
    const id = requireRouteId(runId, "runId");
    const data = await this.transport.post(`curator-runs/${encodeURIComponent(id)}/fail`, failBody(input), false, signal);
    return parseFailure(data, "curator-failure.v1", id) as CuratorFailureV1;
  }
}

export class CoreSchedulerEvolutionClient implements SchedulerEvolutionClient {
  private readonly transport: InternalEvolutionTransport;

  constructor(options: CoreSchedulerEvolutionClientOptions) {
    this.transport = new InternalEvolutionTransport(options, requireToken(options.schedulerToken));
  }

  async ensureScheduled(
    input: CuratorScheduleRequestV1,
    signal?: AbortSignal,
  ): Promise<CuratorScheduleResultV1> {
    const requestKey = requireOpaqueText(input.request_key, "request_key");
    const data = await this.transport.post(
      "curator-runs/ensure-scheduled",
      { request_key: requestKey },
      true,
      signal,
    );
    return parseCuratorSchedule(data, requestKey);
  }
}

class InternalEvolutionTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleeper: (ms: number) => Promise<void>;

  constructor(options: InternalClientOptions, private readonly token: string) {
    this.baseUrl = requireBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw contractError("retryDelayMs must be a non-negative number");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw contractError("requestTimeoutMs must be a positive safe integer");
    }
    this.sleeper = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async post(
    suffix: string,
    body: Record<string, unknown>,
    retrySafe: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/api/v1/internal/evolution/${suffix}`;
    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(body);
    } catch {
      throw contractError("request body must be JSON-serializable");
    }
    const maxAttempts = retrySafe ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      let response: Response;
      let payload: unknown;
      try {
        ({ response, payload } = await withAbortTimeout(async (requestSignal) => {
          const next = await abortable(this.fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
            },
            body: serializedBody,
            signal: requestSignal,
          }), requestSignal);
          return { response: next, payload: await abortable(readJson(next), requestSignal) };
        }, this.requestTimeoutMs, signal));
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof EvolutionWorkerClientError) throw error;
        if (attempt + 1 < maxAttempts) {
          await abortable(this.sleeper(this.retryDelayMs), signal);
          continue;
        }
        throw new EvolutionWorkerClientError(
          error instanceof Error ? error.message : String(error),
          "network_error",
          0,
          true,
        );
      }

      if (response.ok) {
        const envelope = record(payload, "success envelope");
        requireText(envelope.correlation_id, "correlation_id");
        if (!("data" in envelope)) throw contractError("success envelope.data is missing", response.status);
        return envelope.data;
      }

      const parsedError = parseCoreError(payload, response.status);
      if (parsedError.retryable && attempt + 1 < maxAttempts) {
        await abortable(this.sleeper(this.retryDelayMs), signal);
        continue;
      }
      throw parsedError;
    }
    throw new EvolutionWorkerClientError("request failed after retry", "request_failed", 0, true);
  }
}

function claimBody(input: DistillationClaimRequestV1 | CuratorClaimRequestV1): Record<string, unknown> {
  return {
    worker_id: requireRouteId(input.worker_id, "worker_id"),
    lease_seconds: requireLeaseSeconds(input.lease_seconds),
  };
}

function leaseBody(input: EvolutionLeaseRequestV1): Record<string, unknown> {
  return {
    lease_token: requireOpaqueText(input.lease_token, "lease_token"),
    lease_seconds: requireLeaseSeconds(input.lease_seconds),
  };
}

function failBody(input: EvolutionFailRequestV1): Record<string, unknown> {
  return {
    lease_token: requireOpaqueText(input.lease_token, "lease_token"),
    error_code: requireRouteId(input.error_code, "error_code"),
    retryable: requireBoolean(input.retryable, "retryable"),
    details_hash: requireHash(input.details_hash, "details_hash"),
  };
}

function distillationCompleteBody(input: DistillationCompleteRequestV1): Record<string, unknown> {
  const common = {
    lease_token: requireOpaqueText(input.lease_token, "lease_token"),
    input_hash: requireHash(input.input_hash, "input_hash"),
    model_id: requireOpaqueText(input.model_id, "model_id"),
    prompt_hash: requireHash(input.prompt_hash, "prompt_hash"),
    action: input.action,
  };
  if (input.action === "no_op") {
    if (
      input.expected_parent_version_id !== null
      || input.expected_control_revision !== null
      || input.skill !== null
    ) {
      throw contractError("no_op must carry null CAS fields and null skill");
    }
    return {
      ...common,
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: null,
    };
  }

  const skill = distillationSkillBody(input.skill);
  if (input.action === "create") {
    if (
      input.expected_parent_version_id !== null
      || input.expected_control_revision !== null
      || skill.skill_id !== undefined && skill.skill_id !== null
    ) {
      throw contractError("create must carry null CAS fields and no skill_id");
    }
    return {
      ...common,
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill,
    };
  }

  if (skill.skill_id === undefined || skill.skill_id === null) {
    throw contractError("patch requires skill_id");
  }
  return {
    ...common,
    expected_parent_version_id: requireRouteId(
      input.expected_parent_version_id,
      "expected_parent_version_id",
    ),
    expected_control_revision: requirePositiveInteger(
      input.expected_control_revision,
      "expected_control_revision",
    ),
    skill,
  };
}

function distillationSkillBody(input: DistillationSkillV1): Record<string, unknown> {
  const skillId = input.skill_id === undefined
    ? undefined
    : input.skill_id === null
      ? null
      : requireRouteId(input.skill_id, "skill.skill_id");
  return {
    ...(skillId === undefined ? {} : { skill_id: skillId }),
    slug: requireRouteId(input.slug, "skill.slug"),
    name: requireOpaqueText(input.name, "skill.name"),
    summary: requireOpaqueText(input.summary, "skill.summary"),
    description: requireOpaqueText(input.description, "skill.description"),
    applicability: input.applicability,
    outcome_contract: input.outcome_contract,
    files: requireArray(input.files, "skill.files").map((raw, index) => {
      const file = raw as DistillationSkillFileV1;
      if (!isSkillFileKind(file.kind)) throw contractError(`skill.files[${index}].kind is invalid`);
      if (
        file.language !== null
        && file.language !== "tcl"
        && file.language !== "python"
        && file.language !== "typescript"
      ) {
        throw contractError(`skill.files[${index}].language is invalid`);
      }
      return {
        path: requireOpaqueText(file.path, `skill.files[${index}].path`),
        kind: file.kind,
        language: file.language,
        content: requireOpaqueText(file.content, `skill.files[${index}].content`, true),
      };
    }),
  };
}

function curatorCompleteBody(input: CuratorCompleteRequestV1): Record<string, unknown> {
  return {
    lease_token: requireOpaqueText(input.lease_token, "lease_token"),
    evaluator_version: requireOpaqueText(input.evaluator_version, "evaluator_version"),
    evaluations: requireArray(input.evaluations, "evaluations")
      .map((item, index) => curatorEvaluationBody(item as CuratorEvaluationV1, `evaluations[${index}]`)),
    remediations: requireArray(input.remediations, "remediations")
      .map((item, index) => curatorRemediationBody(item as CuratorRemediationV1, `remediations[${index}]`)),
  };
}

function curatorEvaluationBody(input: CuratorEvaluationV1, path: string): Record<string, unknown> {
  return {
    application_id: requireRouteId(input.application_id, `${path}.application_id`),
    evidence_snapshot_hash: requireHash(input.evidence_snapshot_hash, `${path}.evidence_snapshot_hash`),
    outcome: requireEvaluationOutcome(input.outcome, `${path}.outcome`),
    confidence: requireUnitNumber(input.confidence, `${path}.confidence`),
    reason: requireOpaqueText(input.reason, `${path}.reason`),
    evidence_refs: [...requireArray(input.evidence_refs, `${path}.evidence_refs`)],
    eval_job_refs: requireArray(input.eval_job_refs, `${path}.eval_job_refs`).map((raw, index) => {
      const ref = record(raw, `${path}.eval_job_refs[${index}]`);
      return {
        eval_job_id: requireRouteId(ref.eval_job_id, `${path}.eval_job_refs[${index}].eval_job_id`),
        tool_run_id: requireRouteId(ref.tool_run_id, `${path}.eval_job_refs[${index}].tool_run_id`),
        evidence_manifest_hash: ref.evidence_manifest_hash === null
          ? null
          : requireHash(
              ref.evidence_manifest_hash,
              `${path}.eval_job_refs[${index}].evidence_manifest_hash`,
            ),
      };
    }),
    supersedes_id: input.supersedes_id === null
      ? null
      : requireRouteId(input.supersedes_id, `${path}.supersedes_id`),
  };
}

function curatorRemediationBody(input: CuratorRemediationV1, path: string): Record<string, unknown> {
  const action = input.action;
  if (action !== "no_op" && action !== "patch" && action !== "scope_change" && action !== "state_action") {
    throw contractError(`${path}.action is invalid`);
  }
  return {
    skill_id: requireRouteId(input.skill_id, `${path}.skill_id`),
    expected_active_version_id: requireRouteId(
      input.expected_active_version_id,
      `${path}.expected_active_version_id`,
    ),
    expected_control_revision: requirePositiveInteger(
      input.expected_control_revision,
      `${path}.expected_control_revision`,
    ),
    action,
    ...(input.patch === undefined ? {} : { patch: input.patch }),
    ...(input.state_action === undefined ? {} : { state_action: input.state_action }),
  };
}

function parseDistillationClaim(value: unknown): DistillationClaimV1 {
  const row = record(value, "distillation claim");
  requireSchema(row, "distillation-claim.v1");
  if (row.run === null) return { schema: "distillation-claim.v1", run: null };
  const run = record(row.run, "run");
  if (run.state !== "running") throw contractError("run.state must be running");
  const episode = record(run.episode, "run.episode");
  const trajectory = record(run.trajectory, "run.trajectory");
  requireSchema(trajectory, "learning-trajectory.v1");
  return {
    schema: "distillation-claim.v1",
    run: {
      run_id: requireText(run.run_id, "run.run_id"),
      state: "running",
      attempt: requirePositiveInteger(run.attempt, "run.attempt"),
      lease_token: requireOpaqueText(run.lease_token, "run.lease_token"),
      lease_expires_at: requireTimestamp(run.lease_expires_at, "run.lease_expires_at"),
      episode: {
        episode_id: requireText(episode.episode_id, "run.episode.episode_id"),
        observation_key: requireText(episode.observation_key, "run.episode.observation_key"),
        episode_key: requireText(episode.episode_key, "run.episode.episode_key"),
        project_ref: requireText(episode.project_ref, "run.episode.project_ref"),
        task_ref: requireText(episode.task_ref, "run.episode.task_ref"),
        turn_id: nullableText(episode.turn_id, "run.episode.turn_id"),
        end_event_sequence: requirePositiveInteger(
          episode.end_event_sequence,
          "run.episode.end_event_sequence",
        ),
        content_hash: requireHash(episode.content_hash, "run.episode.content_hash"),
        outcome_claim: nullableText(episode.outcome_claim, "run.episode.outcome_claim"),
      },
      trajectory: {
        schema: "learning-trajectory.v1",
        objective: requireText(trajectory.objective, "run.trajectory.objective"),
        messages: requireArray(trajectory.messages, "run.trajectory.messages").map((raw, index) => {
          const item = record(raw, `run.trajectory.messages[${index}]`);
          if (item.role !== "user" && item.role !== "assistant") {
            throw contractError(`run.trajectory.messages[${index}].role is invalid`);
          }
          return {
            sequence: requirePositiveInteger(item.sequence, `run.trajectory.messages[${index}].sequence`),
            role: item.role,
            content: requireText(item.content, `run.trajectory.messages[${index}].content`, true),
            content_hash: requireHash(item.content_hash, `run.trajectory.messages[${index}].content_hash`),
          };
        }),
        tools: requireArray(trajectory.tools, "run.trajectory.tools").map((raw, index) => {
          const item = record(raw, `run.trajectory.tools[${index}]`);
          return {
            call_sequence: requirePositiveInteger(item.call_sequence, `run.trajectory.tools[${index}].call_sequence`),
            result_sequence: nullablePositiveInteger(
              item.result_sequence,
              `run.trajectory.tools[${index}].result_sequence`,
            ),
            tool_call_id: requireText(item.tool_call_id, `run.trajectory.tools[${index}].tool_call_id`),
            name: requireText(item.name, `run.trajectory.tools[${index}].name`),
            args: item.args,
            args_hash: requireHash(item.args_hash, `run.trajectory.tools[${index}].args_hash`),
            result: item.result,
            result_hash: requireHash(item.result_hash, `run.trajectory.tools[${index}].result_hash`),
            is_error: requireBoolean(item.is_error, `run.trajectory.tools[${index}].is_error`),
            tool_run_refs: stringArray(item.tool_run_refs, `run.trajectory.tools[${index}].tool_run_refs`),
            evidence_refs: stringArray(item.evidence_refs, `run.trajectory.tools[${index}].evidence_refs`),
          };
        }),
        human_corrections: requireArray(
          trajectory.human_corrections,
          "run.trajectory.human_corrections",
        ).map((raw, index) => {
          const item = record(raw, `run.trajectory.human_corrections[${index}]`);
          return {
            sequence: requirePositiveInteger(
              item.sequence,
              `run.trajectory.human_corrections[${index}].sequence`,
            ),
            content: requireText(item.content, `run.trajectory.human_corrections[${index}].content`, true),
            content_hash: requireHash(
              item.content_hash,
              `run.trajectory.human_corrections[${index}].content_hash`,
            ),
          };
        }),
      },
      existing_skills: requireArray(run.existing_skills, "run.existing_skills")
        .map((raw, index) => parseSkillSummary(raw, `run.existing_skills[${index}]`)),
    },
  };
}



function requireCommit(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw contractError(`${path} is not a canonical Git commit`);
  }
  return value;
}

function parseCuratorClaim(value: unknown): CuratorClaimV1 {
  const row = record(value, "curator claim");
  requireSchema(row, "curator-claim.v1");
  if (row.run === null) return { schema: "curator-claim.v1", run: null };
  const run = record(row.run, "run");
  if (run.mode !== "run" && run.mode !== "dry_run") throw contractError("run.mode is invalid");
  if (run.state !== "running") throw contractError("run.state must be running");
  return {
    schema: "curator-claim.v1",
    run: {
      run_id: requireText(run.run_id, "run.run_id"),
      mode: run.mode,
      state: "running",
      attempt: requirePositiveInteger(run.attempt, "run.attempt"),
      lease_token: requireOpaqueText(run.lease_token, "run.lease_token"),
      lease_expires_at: requireTimestamp(run.lease_expires_at, "run.lease_expires_at"),
      schedule_bucket: requireText(run.schedule_bucket, "run.schedule_bucket"),
      applications: requireArray(run.applications, "run.applications")
        .map((raw, index) => parseCuratorApplication(raw, `run.applications[${index}]`)),
    },
  };
}

function parseCuratorSchedule(
  value: unknown,
  requestKey: string,
): CuratorScheduleResultV1 {
  const row = record(value, "curator schedule");
  requireSchema(row, "curator-schedule.v1");
  if (requireText(row.request_key, "curator schedule.request_key") !== requestKey) {
    throw contractError("curator schedule.request_key does not match request");
  }
  if (
    row.state !== "queued"
    && row.state !== "no_work"
    && row.state !== "already_completed"
  ) {
    throw contractError("curator schedule.state is invalid");
  }
  const runId = nullableText(row.curator_run_id, "curator schedule.curator_run_id");
  if (row.state === "queued" && runId === null) {
    throw contractError("queued curator schedule requires curator_run_id");
  }
  return {
    schema: "curator-schedule.v1",
    request_key: requestKey,
    schedule_bucket: requireText(row.schedule_bucket, "curator schedule.schedule_bucket"),
    eligible_at: requireTimestamp(row.eligible_at, "curator schedule.eligible_at"),
    state: row.state,
    curator_run_id: runId,
    reason_code: requireText(row.reason_code, "curator schedule.reason_code"),
    retry_not_before: nullableTimestamp(
      row.retry_not_before ?? null,
      "curator schedule.retry_not_before",
    ),
    replayed: requireBoolean(row.replayed, "curator schedule.replayed"),
  };
}

function parseCuratorApplication(
  value: unknown,
  path: string,
): NonNullable<CuratorClaimV1["run"]>["applications"][number] {
  const row = record(value, path);
  const version = record(row.primary_version, `${path}.primary_version`);
  return {
    application: parseApplicationDetail(row.application, `${path}.application`),
    primary_version: {
      skill: parseSkillSummary(version.skill, `${path}.primary_version.skill`),
      version_id: requireText(version.version_id, `${path}.primary_version.version_id`),
      content_manifest_hash: requireHash(
        version.content_manifest_hash,
        `${path}.primary_version.content_manifest_hash`,
      ),
      description: requireText(version.description, `${path}.primary_version.description`, true),
      applicability: version.applicability,
      outcome_contract: version.outcome_contract,
      files: requireArray(version.files, `${path}.primary_version.files`).map((raw, index) => {
        const file = record(raw, `${path}.primary_version.files[${index}]`);
        return {
          path: requireText(file.path, `${path}.primary_version.files[${index}].path`),
          kind: requireText(file.kind, `${path}.primary_version.files[${index}].kind`),
          language: nullableText(file.language, `${path}.primary_version.files[${index}].language`),
          sha256: requireHash(file.sha256, `${path}.primary_version.files[${index}].sha256`),
          content: requireText(file.content, `${path}.primary_version.files[${index}].content`, true),
        };
      }),
    },
    evidence_snapshot_hash: requireHash(row.evidence_snapshot_hash, `${path}.evidence_snapshot_hash`),
    evidence: requireArray(row.evidence, `${path}.evidence`).map((raw, index) => {
      const item = record(raw, `${path}.evidence[${index}]`);
      return {
        type: requireText(item.type, `${path}.evidence[${index}].type`),
        id: requireText(item.id, `${path}.evidence[${index}].id`),
        sha256: requireHash(item.sha256, `${path}.evidence[${index}].sha256`),
        summary: requireText(item.summary, `${path}.evidence[${index}].summary`, true),
        content: nullableText(item.content, `${path}.evidence[${index}].content`, true),
      };
    }),
  };
}

function parseApplicationDetail(value: unknown, path: string): SkillApplicationDetailV1 {
  const row = record(value, path);
  requireSchema(row, "skill-application-detail.v1");
  const state = row.state;
  if (
    state !== "open"
    && state !== "closed_pending_episode"
    && state !== "pending_evaluation"
    && state !== "evaluated"
  ) {
    throw contractError(`${path}.state is invalid`);
  }
  const evidence = record(row.evidence_summary, `${path}.evidence_summary`);
  return {
    schema: "skill-application-detail.v1",
    application_id: requireText(row.application_id, `${path}.application_id`),
    project_ref: requireText(row.project_ref, `${path}.project_ref`),
    task_ref: requireText(row.task_ref, `${path}.task_ref`),
    observation_key: requireText(row.observation_key, `${path}.observation_key`),
    episode_ref: nullableText(row.episode_ref, `${path}.episode_ref`),
    local_goal: requireText(row.local_goal, `${path}.local_goal`),
    state,
    started_at: requireTimestamp(row.started_at, `${path}.started_at`),
    closed_at: nullableTimestamp(row.closed_at, `${path}.closed_at`),
    duration_ms: nullableNonNegativeInteger(row.duration_ms, `${path}.duration_ms`),
    human_corrections: nullableNonNegativeInteger(row.human_corrections, `${path}.human_corrections`),
    outcome_claim: nullableText(row.outcome_claim, `${path}.outcome_claim`, true),
    skills: requireArray(row.skills, `${path}.skills`).map((raw, index) => {
      const item = record(raw, `${path}.skills[${index}]`);
      if (item.role !== "primary" && item.role !== "supporting") {
        throw contractError(`${path}.skills[${index}].role is invalid`);
      }
      return {
        skill_id: requireText(item.skill_id, `${path}.skills[${index}].skill_id`),
        version_id: requireText(item.version_id, `${path}.skills[${index}].version_id`),
        role: item.role,
        reason_codes: stringArray(item.reason_codes, `${path}.skills[${index}].reason_codes`),
      };
    }),
    evidence_summary: {
      visible: requireNonNegativeInteger(evidence.visible, `${path}.evidence_summary.visible`),
      redacted: requireNonNegativeInteger(evidence.redacted, `${path}.evidence_summary.redacted`),
      refs: requireArray(evidence.refs, `${path}.evidence_summary.refs`).map((raw, index) => {
        const item = record(raw, `${path}.evidence_summary.refs[${index}]`);
        return {
          type: requireText(item.type, `${path}.evidence_summary.refs[${index}].type`),
          id: requireText(item.id, `${path}.evidence_summary.refs[${index}].id`),
          hash: requireHash(item.hash, `${path}.evidence_summary.refs[${index}].hash`),
        };
      }),
    },
    evaluations: requireArray(row.evaluations, `${path}.evaluations`).map((raw, index) => {
      const item = record(raw, `${path}.evaluations[${index}]`);
      const itemEvidence = record(item.evidence_summary, `${path}.evaluations[${index}].evidence_summary`);
      if (item.evaluator_type !== "curator" && item.evaluator_type !== "human") {
        throw contractError(`${path}.evaluations[${index}].evaluator_type is invalid`);
      }
      return {
        evaluation_id: requireText(item.evaluation_id, `${path}.evaluations[${index}].evaluation_id`),
        outcome: requireEvaluationOutcome(item.outcome, `${path}.evaluations[${index}].outcome`),
        confidence: requireUnitNumber(item.confidence, `${path}.evaluations[${index}].confidence`),
        reason: requireText(item.reason, `${path}.evaluations[${index}].reason`, true),
        evidence_summary: {
          visible: requireNonNegativeInteger(
            itemEvidence.visible,
            `${path}.evaluations[${index}].evidence_summary.visible`,
          ),
          redacted: requireNonNegativeInteger(
            itemEvidence.redacted,
            `${path}.evaluations[${index}].evidence_summary.redacted`,
          ),
          hashes: hashArray(itemEvidence.hashes, `${path}.evaluations[${index}].evidence_summary.hashes`),
        },
        supersedes_id: nullableText(item.supersedes_id, `${path}.evaluations[${index}].supersedes_id`),
        evaluator_type: item.evaluator_type,
        evaluator_version: requireText(
          item.evaluator_version,
          `${path}.evaluations[${index}].evaluator_version`,
        ),
        created_at: requireTimestamp(item.created_at, `${path}.evaluations[${index}].created_at`),
      };
    }),
  };
}

function parseSkillSummary(value: unknown, path: string): EvolutionLearnedSkillSummaryV1 {
  const row = record(value, path);
  requireSchema(row, "learned-skill-summary.v1");
  const quality = row.quality_state === null ? null : requireQualityState(row.quality_state, `${path}.quality_state`);
  if (row.freshness_state !== "current" && row.freshness_state !== "stale") {
    throw contractError(`${path}.freshness_state is invalid`);
  }
  if (row.availability_state !== "available" && row.availability_state !== "archived") {
    throw contractError(`${path}.availability_state is invalid`);
  }
  return {
    schema: "learned-skill-summary.v1",
    skill_id: requireText(row.skill_id, `${path}.skill_id`),
    slug: requireText(row.slug, `${path}.slug`),
    name: requireText(row.name, `${path}.name`),
    summary: requireText(row.summary, `${path}.summary`, true),
    applicability_summary: requireText(row.applicability_summary, `${path}.applicability_summary`, true),
    active_version_id: nullableText(row.active_version_id, `${path}.active_version_id`),
    active_version_no: nullableNonNegativeInteger(row.active_version_no, `${path}.active_version_no`),
    quality_state: quality,
    freshness_state: row.freshness_state,
    availability_state: row.availability_state,
    enabled: requireBoolean(row.enabled, `${path}.enabled`),
    pinned: requireBoolean(row.pinned, `${path}.pinned`),
    recommended: requireBoolean(row.recommended, `${path}.recommended`),
    control_revision: requirePositiveInteger(row.control_revision, `${path}.control_revision`),
    last_used_at: nullableTimestamp(row.last_used_at, `${path}.last_used_at`),
    metrics: parseMetrics(row.metrics, `${path}.metrics`),
  };
}

function parseMetrics(value: unknown, path: string): EvolutionSkillMetricsV1 {
  const row = record(value, path);
  if (row.measurement_state !== "unknown" && row.measurement_state !== "observed") {
    throw contractError(`${path}.measurement_state is invalid`);
  }
  const metrics: EvolutionSkillMetricsV1 = {
    measurement_state: row.measurement_state,
    primary_applied: requireNonNegativeInteger(row.primary_applied, `${path}.primary_applied`),
    evaluated: requireNonNegativeInteger(row.evaluated, `${path}.evaluated`),
    pending: requireNonNegativeInteger(row.pending, `${path}.pending`),
    inconclusive: requireNonNegativeInteger(row.inconclusive, `${path}.inconclusive`),
    success: requireNonNegativeInteger(row.success, `${path}.success`),
    applicability_failure: requireNonNegativeInteger(
      row.applicability_failure,
      `${path}.applicability_failure`,
    ),
    execution_failure: requireNonNegativeInteger(row.execution_failure, `${path}.execution_failure`),
    success_rate: row.success_rate === null ? null : requireUnitNumber(row.success_rate, `${path}.success_rate`),
    median_duration_ms: nullableNonNegativeNumber(row.median_duration_ms, `${path}.median_duration_ms`),
    human_corrections: nullableNonNegativeInteger(row.human_corrections, `${path}.human_corrections`),
    first_solved_problem_families: row.first_solved_problem_families === null
      ? null
      : requireNonNegativeInteger(
        row.first_solved_problem_families,
        `${path}.first_solved_problem_families`,
      ),
  };
  const deterministic = metrics.success + metrics.applicability_failure + metrics.execution_failure;
  const evaluated = deterministic + metrics.inconclusive;
  if (metrics.evaluated !== evaluated) {
    throw contractError(`${path}.evaluated does not match canonical outcome counts`);
  }
  if (metrics.measurement_state === "unknown" && metrics.success_rate !== null) {
    throw contractError(`${path}.unknown measurement cannot expose success_rate`);
  }
  if (metrics.measurement_state === "observed" && metrics.success_rate === null) {
    throw contractError(`${path}.observed measurement must expose success_rate`);
  }
  if (deterministic === 0) {
    if (metrics.success_rate !== null) {
      throw contractError(`${path}.success_rate must be null without deterministic outcomes`);
    }
  } else {
    const expectedRate = metrics.success / deterministic;
    if (metrics.success_rate === null || Math.abs(metrics.success_rate - expectedRate) > 1e-12) {
      throw contractError(`${path}.success_rate does not match canonical outcome counts`);
    }
  }
  return metrics;
}

function parseLease(
  value: unknown,
  schema: "distillation-lease.v1" | "curator-lease.v1",
  runId: string,
): DistillationLeaseV1 | CuratorLeaseV1 {
  const row = record(value, "lease result");
  requireSchema(row, schema);
  assertRunId(row, runId);
  return {
    schema,
    run_id: runId,
    lease_expires_at: requireTimestamp(row.lease_expires_at, "lease_expires_at"),
  } as DistillationLeaseV1 | CuratorLeaseV1;
}

function parseDistillationResult(value: unknown, runId: string): DistillationResultV1 {
  const row = record(value, "distillation result");
  requireSchema(row, "distillation-result.v1");
  assertRunId(row, runId);
  if (row.state !== "noop" && row.state !== "succeeded" && row.state !== "quarantined") {
    throw contractError("distillation result state is invalid");
  }
  const versionId = nullableText(row.version_id, "version_id");
  if ((row.state === "noop") !== (versionId === null)) {
    throw contractError("distillation result version_id is inconsistent with state");
  }
  return {
    schema: "distillation-result.v1",
    run_id: runId,
    state: row.state,
    version_id: versionId,
    replayed: requireBoolean(row.replayed, "replayed"),
  };
}

function parseCuratorResult(value: unknown, runId: string): CuratorResultV1 {
  const row = record(value, "curator result");
  requireSchema(row, "curator-result.v1");
  assertRunId(row, runId);
  if (row.state !== "completed" && row.state !== "dry_run_complete") {
    throw contractError("curator result state is invalid");
  }
  return {
    schema: "curator-result.v1",
    run_id: runId,
    state: row.state,
    evaluation_ids: stringArray(row.evaluation_ids, "evaluation_ids"),
    proposed_evaluations: requireArray(row.proposed_evaluations, "proposed_evaluations")
      .map((raw, index) => curatorEvaluationBody(
        raw as CuratorEvaluationV1,
        `proposed_evaluations[${index}]`,
      ) as unknown as CuratorEvaluationV1),
    produced_version_ids: stringArray(row.produced_version_ids, "produced_version_ids"),
    skipped_actions: requireArray(row.skipped_actions, "skipped_actions").map((raw, index) => {
      const item = record(raw, `skipped_actions[${index}]`);
      const action = item.action;
      if (action !== "no_op" && action !== "patch" && action !== "scope_change" && action !== "state_action") {
        throw contractError(`skipped_actions[${index}].action is invalid`);
      }
      return {
        skill_id: requireText(item.skill_id, `skipped_actions[${index}].skill_id`),
        action,
        reason: requireText(item.reason, `skipped_actions[${index}].reason`),
      };
    }),
    replayed: requireBoolean(row.replayed, "replayed"),
  };
}

function parseFailure(
  value: unknown,
  schema: "distillation-failure.v1" | "curator-failure.v1",
  runId: string,
): DistillationFailureV1 | CuratorFailureV1 {
  const row = record(value, "failure result");
  requireSchema(row, schema);
  assertRunId(row, runId);
  if (row.state !== "queued" && row.state !== "failed") {
    throw contractError("failure result state is invalid");
  }
  return { schema, run_id: runId, state: row.state } as DistillationFailureV1 | CuratorFailureV1;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    if (response.status >= 500) return undefined;
    throw contractError("Core returned non-JSON", response.status);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("self-evolution request aborted", "AbortError");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException(
    "self-evolution request timed out",
    "TimeoutError",
  )), timeoutMs);
  try {
    return await abortable(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function parseCoreError(value: unknown, httpStatus: number): EvolutionWorkerClientError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new EvolutionWorkerClientError(
      `HTTP ${httpStatus}`,
      `http_${httpStatus}`,
      httpStatus,
      httpStatus >= 500,
    );
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.error !== "object" || envelope.error === null || Array.isArray(envelope.error)) {
    return new EvolutionWorkerClientError(
      `HTTP ${httpStatus}`,
      `http_${httpStatus}`,
      httpStatus,
      httpStatus >= 500,
    );
  }
  const error = envelope.error as Record<string, unknown>;
  return new EvolutionWorkerClientError(
    typeof error.message === "string" ? error.message : `HTTP ${httpStatus}`,
    typeof error.code === "string" ? error.code : `http_${httpStatus}`,
    httpStatus,
    typeof error.retryable === "boolean" ? error.retryable : httpStatus >= 500,
    typeof error.correlation_id === "string" ? error.correlation_id : null,
    error.details ?? null,
  );
}

function requireBaseUrl(value: unknown): string {
  const text = requireOpaqueText(value, "baseUrl");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw contractError("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw contractError("baseUrl must use http or https");
  }
  return text.replace(/\/+$/, "");
}

function requireToken(value: unknown): string {
  return requireOpaqueText(value, "singleton token");
}

function requireRouteId(value: unknown, path: string): string {
  const text = requireOpaqueText(value, path);
  if (text.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw contractError(`${path} is not a safe identifier`);
  }
  return text;
}

function requireOpaqueText(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw contractError(`${path} must be ${allowEmpty ? "a string" : "non-empty"}`);
  }
  return value;
}

function requireText(value: unknown, path: string, allowEmpty = false): string {
  return requireOpaqueText(value, path, allowEmpty);
}

function nullableText(value: unknown, path: string, allowEmpty = false): string | null {
  return value === null ? null : requireText(value, path, allowEmpty);
}

function requireTimestamp(value: unknown, path: string): string {
  const text = requireText(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) {
    throw contractError(`${path} must be an ISO-8601 timestamp`);
  }
  return text;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : requireTimestamp(value, path);
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw contractError(`${path} must be a lowercase SHA-256`);
  }
  return value;
}

function requireLeaseSeconds(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 30 || (value as number) > 900) {
    throw contractError("lease_seconds must be an integer between 30 and 900");
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw contractError(`${path} must be a non-negative integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const integer = requireNonNegativeInteger(value, path);
  if (integer === 0) throw contractError(`${path} must be positive`);
  return integer;
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  return value === null ? null : requireNonNegativeInteger(value, path);
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  return value === null ? null : requirePositiveInteger(value, path);
}

function nullableNonNegativeNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw contractError(`${path} must be a non-negative number or null`);
  }
  return value;
}

function requireUnitNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw contractError(`${path} must be between 0 and 1`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw contractError(`${path} must be boolean`);
  return value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw contractError(`${path} must be an array`);
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  return requireArray(value, path).map((item, index) => requireText(item, `${path}[${index}]`));
}

function hashArray(value: unknown, path: string): readonly string[] {
  return requireArray(value, path).map((item, index) => requireHash(item, `${path}[${index}]`));
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contractError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireSchema(row: Record<string, unknown>, schema: string): void {
  if (row.schema !== schema) throw contractError(`expected schema ${schema}`);
}

function requireExactKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) throw contractError(`${path} has unknown or missing fields`);
}

function requireQualityState(value: unknown, path: string): EvolutionQualityState {
  if (
    value !== "active_unproven"
    && value !== "active_observed"
    && value !== "needs_review"
    && value !== "degraded"
    && value !== "quarantined"
  ) {
    throw contractError(`${path} is invalid`);
  }
  return value;
}

function requireEvaluationOutcome(value: unknown, path: string): EvolutionEvaluationOutcome {
  if (
    value !== "success"
    && value !== "applicability_failure"
    && value !== "execution_failure"
    && value !== "inconclusive"
  ) {
    throw contractError(`${path} is invalid`);
  }
  return value;
}

function isSkillFileKind(value: unknown): value is EvolutionSkillFileKind {
  return value === "skill_md" || value === "reference" || value === "template" || value === "script";
}

function assertRunId(row: Record<string, unknown>, runId: string): void {
  if (row.run_id !== runId) throw contractError("Core returned a different run_id");
}

function contractError(message: string, httpStatus = 0): EvolutionWorkerClientError {
  return new EvolutionWorkerClientError(message, "evolution_contract_error", httpStatus, false);
}
