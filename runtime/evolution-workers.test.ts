import { describe, expect, test } from "bun:test";
import type {
  CuratorClaimV1,
  CuratorCompleteRequestV1,
  CuratorEvolutionClient,
  CuratorResultV1,
  DistillationClaimV1,
  DistillationCompleteRequestV1,
  DistillerEvolutionClient,
  EvolutionFailRequestV1,
  EvolutionLeaseRequestV1,
  EvolutionLearnedSkillSummaryV1,
} from "./evolution-worker-client.ts";
import {
  CURATOR_PROMPT_VERSION,
  CuratorWorker,
  DISTILLER_PROMPT_VERSION,
  DistillerWorker,
  type EvolutionJsonModel,
  type EvolutionJsonModelRequest,
} from "./evolution-workers.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

class FakeModel implements EvolutionJsonModel {
  readonly requests: EvolutionJsonModelRequest[] = [];
  readonly responses: unknown[] = [];
  readonly modelId = "test-model-v1";

  async generateJson(request: EvolutionJsonModelRequest): Promise<unknown> {
    this.requests.push(request);
    const value = this.responses.shift();
    if (value instanceof Error) throw value;
    return value;
  }
}

class RetryableModelError extends Error {
  readonly code = "MODEL_TEMPORARY";
  readonly retryable = true;
}

class FakeDistillerClient implements DistillerEvolutionClient {
  readonly log: string[] = [];
  readonly completes: DistillationCompleteRequestV1[] = [];
  readonly failures: EvolutionFailRequestV1[] = [];
  readonly renewals: EvolutionLeaseRequestV1[] = [];
  claims: DistillationClaimV1[] = [];

  async claim(): Promise<DistillationClaimV1> {
    this.log.push("claim");
    return this.claims.shift() ?? { schema: "distillation-claim.v1", run: null };
  }

  async renewLease(_runId: string, input: EvolutionLeaseRequestV1) {
    this.log.push("renew");
    this.renewals.push(input);
    return {
      schema: "distillation-lease.v1" as const,
      run_id: "dist-1",
      lease_expires_at: "2026-08-26T01:10:00.000Z",
    };
  }

  async complete(runId: string, input: DistillationCompleteRequestV1) {
    this.log.push("complete");
    this.completes.push(input);
    return {
      schema: "distillation-result.v1" as const,
      run_id: runId,
      state: input.action === "no_op" ? "noop" as const : "succeeded" as const,
      version_id: input.action === "no_op" ? null : "version-1",
      replayed: false,
    };
  }

  async fail(runId: string, input: EvolutionFailRequestV1) {
    this.log.push("fail");
    this.failures.push(input);
    return {
      schema: "distillation-failure.v1" as const,
      run_id: runId,
      state: input.retryable ? "queued" as const : "failed" as const,
    };
  }
}

class FakeCuratorClient implements CuratorEvolutionClient {
  readonly log: string[] = [];
  readonly completes: CuratorCompleteRequestV1[] = [];
  readonly failures: EvolutionFailRequestV1[] = [];
  readonly renewals: EvolutionLeaseRequestV1[] = [];
  claims: CuratorClaimV1[] = [];

  async claim(): Promise<CuratorClaimV1> {
    this.log.push("claim");
    return this.claims.shift() ?? { schema: "curator-claim.v1", run: null };
  }

  async renewLease(_runId: string, input: EvolutionLeaseRequestV1) {
    this.log.push("renew");
    this.renewals.push(input);
    return {
      schema: "curator-lease.v1" as const,
      run_id: "cur-1",
      lease_expires_at: "2026-08-26T01:10:00.000Z",
    };
  }

  async complete(runId: string, input: CuratorCompleteRequestV1): Promise<CuratorResultV1> {
    this.log.push("complete");
    this.completes.push(input);
    const dry = this.claims.length === -1;
    return {
      schema: "curator-result.v1",
      run_id: runId,
      state: dry ? "dry_run_complete" : "completed",
      evaluation_ids: input.evaluations.map((_, index) => `eval-${index}`),
      proposed_evaluations: [],
      produced_version_ids: [],
      skipped_actions: [],
      replayed: false,
    };
  }

  async fail(runId: string, input: EvolutionFailRequestV1) {
    this.log.push("fail");
    this.failures.push(input);
    return {
      schema: "curator-failure.v1" as const,
      run_id: runId,
      state: input.retryable ? "queued" as const : "failed" as const,
    };
  }
}

function metrics() {
  return {
    measurement_state: "unknown" as const,
    primary_applied: 0,
    evaluated: 0,
    pending: 0,
    inconclusive: 0,
    success: 0,
    applicability_failure: 0,
    execution_failure: 0,
    success_rate: null,
    median_duration_ms: null,
    human_corrections: null,
    first_solved_problem_families: null,
  };
}

function skillSummary(index = 1): EvolutionLearnedSkillSummaryV1 {
  return {
    schema: "learned-skill-summary.v1",
    skill_id: `skill-${index}`,
    slug: `skill-${index}`,
    name: `Skill ${index}`,
    summary: "A reusable timing method",
    applicability_summary: "Timing failures",
    active_version_id: `version-${index}`,
    active_version_no: 1,
    quality_state: "active_unproven",
    freshness_state: "current",
    availability_state: "available",
    enabled: true,
    pinned: false,
    recommended: true,
    control_revision: index + 3,
    last_used_at: null,
    metrics: metrics(),
  };
}

function distillationClaim(overrides: Partial<NonNullable<DistillationClaimV1["run"]>> = {}): DistillationClaimV1 {
  return {
    schema: "distillation-claim.v1",
    run: {
      run_id: "dist-1",
      state: "running",
      attempt: 1,
      lease_token: "secret-distiller-lease",
      lease_expires_at: "2026-08-26T01:05:00.000Z",
      episode: {
        episode_id: "episode-1",
        observation_key: "turn:turn-1",
        episode_key: "turn:turn-1:8",
        project_ref: "project-1",
        task_ref: "task-1",
        turn_id: "turn-1",
        end_event_sequence: 8,
        content_hash: H1,
        outcome_claim: "timing fixed",
      },
      trajectory: {
        schema: "learning-trajectory.v1",
        objective: "Resolve setup timing",
        messages: [{ sequence: 1, role: "user", content: "fix timing", content_hash: H2 }],
        tools: [{
          call_sequence: 2,
          result_sequence: 3,
          tool_call_id: "call-1",
          name: "read_timing_report",
          args: {},
          args_hash: H1,
          result: { slack: 0.1 },
          result_hash: H2,
          is_error: false,
          tool_run_refs: [],
          evidence_refs: ["ev-1"],
        }],
        human_corrections: [],
      },
      existing_skills: [skillSummary(1)],
      ...overrides,
    },
  };
}

function validSkill(includeId = false) {
  return {
    ...(includeId ? { skill_id: "skill-1" } : {}),
    slug: "timing-diagnosis",
    name: "Timing diagnosis",
    summary: "Diagnose a recurring setup timing failure",
    description: "Inspect the timing evidence, isolate the path, and verify the repaired constraint.",
    applicability: { summary: "Vivado setup timing failures" },
    outcome_contract: { expected: "non-negative setup slack" },
    files: [{
      path: "SKILL.md",
      kind: "skill_md",
      language: null,
      content: "# Timing diagnosis\n\nUse only existing governed tools.\n",
    }],
  };
}

function curatorBundle(index: number): NonNullable<CuratorClaimV1["run"]>["applications"][number] {
  const skill = skillSummary(index);
  return {
    application: {
      schema: "skill-application-detail.v1",
      application_id: `app-${index}`,
      project_ref: "project-1",
      task_ref: `task-${index}`,
      observation_key: `task:task-${index}`,
      episode_ref: `episode-${index}`,
      local_goal: `Goal ${index}`,
      state: "pending_evaluation",
      started_at: "2026-08-26T00:00:00.000Z",
      closed_at: "2026-08-26T00:01:00.000Z",
      duration_ms: 60_000,
      human_corrections: index - 1,
      outcome_claim: "done",
      skills: [{
        skill_id: skill.skill_id,
        version_id: skill.active_version_id!,
        role: "primary",
        reason_codes: ["timing"],
      }],
      evidence_summary: {
        visible: 1,
        redacted: 0,
        refs: [{ type: "report", id: `evidence-${index}`, hash: H2 }],
      },
      evaluations: [],
    },
    primary_version: {
      skill,
      version_id: skill.active_version_id!,
      content_manifest_hash: H1,
      description: "Timing method",
      applicability: { summary: "timing" },
      outcome_contract: { expected: "pass" },
      files: [{ path: "SKILL.md", kind: "skill_md", language: null, sha256: H3, content: "# Skill" }],
    },
    eval_input: {
      eval_input_ref: `eval-input-${index}`,
      input_manifest_hash: H1,
      source_commit: "a".repeat(40),
      source_manifest_hash: H2,
      allowed_operations: ["validate_sources", "simulate", "synthesize", "implement"],
      trial_bitstream_allowed: true,
      part: "xc7a35tcpg236-1",
      toolchain_profile_hash: H3,
    },
    evidence_snapshot_hash: String(index).repeat(64),
    evidence: [{
      type: "report",
      id: `evidence-${index}`,
      sha256: H2,
      summary: "Observed report",
      content: "pass",
    }],
  };
}

function curatorClaim(
  count = 4,
  mode: "run" | "dry_run" = "run",
): CuratorClaimV1 {
  return {
    schema: "curator-claim.v1",
    run: {
      run_id: "cur-1",
      mode,
      state: "running",
      attempt: 1,
      lease_token: "secret-curator-lease",
    lease_expires_at: "2026-08-26T01:05:00.000Z",
    schedule_bucket: "manual:test",
    eval_recovery: mode === "dry_run" ? {
      budget_started_at: null,
      deadline_at: null,
      unknown_effect_latched_at: null,
      jobs: [],
    } : {
      budget_started_at: "2026-08-26T00:00:00.000Z",
      deadline_at: "2026-08-26T02:00:00.000Z",
      unknown_effect_latched_at: null,
      jobs: [],
    },
      applications: Array.from({ length: count }, (_, index) => {
        const bundle = curatorBundle(index + 1);
        return mode === "dry_run" ? { ...bundle, eval_input: null } : bundle;
      }),
    },
  };
}

describe("DistillerWorker", () => {
  test("no claim is idle and never invokes the model or lease", async () => {
    const client = new FakeDistillerClient();
    const model = new FakeModel();
    expect(await new DistillerWorker(client, model, { workerId: "distiller-1" }).runOnce())
      .toEqual({ state: "idle" });
    expect(model.requests).toHaveLength(0);
    expect(client.log).toEqual(["claim"]);
  });

  test("no_op renews before complete and keeps lease token away from the model", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim());
    const model = new FakeModel();
    model.responses.push(JSON.stringify({ action: "no_op" }));
    const result = await new DistillerWorker(client, model, {
      workerId: "distiller-1",
      leaseSeconds: 120,
    }).runOnce();
    expect(result.state).toBe("completed");
    expect(client.log).toEqual(["claim", "renew", "complete"]);
    expect(client.completes[0]).toMatchObject({
      action: "no_op",
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: null,
      model_id: "test-model-v1",
    });
    expect(client.renewals[0]).toEqual({ lease_token: "secret-distiller-lease", lease_seconds: 120 });
    expect(model.requests[0]!.userPrompt).not.toContain("secret-distiller-lease");
    expect(model.requests[0]!.systemPrompt).toContain(DISTILLER_PROMPT_VERSION);
    expect(client.completes[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(client.completes[0]!.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("create and patch use strict skill content while patch CAS is derived from the claim", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim(), distillationClaim({
      attempt: 9,
      lease_token: "another-secret-lease",
      lease_expires_at: "2026-08-26T02:00:00.000Z",
    }));
    const model = new FakeModel();
    model.responses.push(
      { action: "create", skill: validSkill(false) },
      { action: "patch", skill: validSkill(true) },
    );
    const worker = new DistillerWorker(client, model, { workerId: "distiller-1" });
    await worker.runOnce();
    await worker.runOnce();
    expect(client.completes[0]).toMatchObject({
      action: "create",
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: { slug: "timing-diagnosis" },
    });
    expect(client.completes[1]).toMatchObject({
      action: "patch",
      expected_parent_version_id: "version-1",
      expected_control_revision: 4,
      skill: { skill_id: "skill-1" },
    });
    expect(client.completes[1]!.input_hash).toBe(client.completes[0]!.input_hash);
    expect(client.completes[1]!.prompt_hash).toBe(client.completes[0]!.prompt_hash);
  });

  test("malformed output fails closed without renewing or completing", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim());
    const model = new FakeModel();
    model.responses.push({ action: "create", skill: { ...validSkill(), capability: "vivado" } });
    const result = await new DistillerWorker(client, model, { workerId: "distiller-1" }).runOnce();
    expect(result).toMatchObject({
      state: "failed",
      errorCode: "MALFORMED_MODEL_OUTPUT",
      retryable: false,
      coreState: "failed",
    });
    expect(client.log).toEqual(["claim", "fail"]);
    expect(client.failures[0]).toMatchObject({
      lease_token: "secret-distiller-lease",
      error_code: "MALFORMED_MODEL_OUTPUT",
      retryable: false,
    });
  });

  test("retryable model failure requeues the run through Core fail", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim());
    const model = new FakeModel();
    model.responses.push(new RetryableModelError("temporary model outage"));
    const result = await new DistillerWorker(client, model, { workerId: "distiller-1" }).runOnce();
    expect(result).toMatchObject({
      state: "failed",
      errorCode: "MODEL_TEMPORARY",
      retryable: true,
      coreState: "queued",
    });
    expect(client.failures[0]!.details_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("renews throughout slow inference before completing", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim());
    const model: EvolutionJsonModel = {
      modelId: "slow-model-v1",
      async generateJson() {
        await new Promise<void>((resolve) => setTimeout(resolve, 18));
        return { action: "no_op" };
      },
    };
    const result = await new DistillerWorker(client, model, {
      workerId: "distiller-1",
      leaseSeconds: 30,
      heartbeatIntervalMs: 3,
    }).runOnce();
    expect(result.state).toBe("completed");
    expect(client.renewals.length).toBeGreaterThan(1);
    expect(client.log.at(-1)).toBe("complete");
  });

  test("a heartbeat failure prevents completion under uncertain ownership", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim());
    client.renewLease = async () => {
      client.log.push("renew_failed");
      throw new Error("lease ownership lost");
    };
    const model: EvolutionJsonModel = {
      modelId: "slow-model-v1",
      async generateJson() {
        await new Promise<void>((resolve) => setTimeout(resolve, 12));
        return { action: "no_op" };
      },
    };
    const result = await new DistillerWorker(client, model, {
      workerId: "distiller-1",
      leaseSeconds: 30,
      heartbeatIntervalMs: 2,
    }).runOnce();
    expect(result).toMatchObject({ state: "failed", retryable: false });
    expect(client.completes).toHaveLength(0);
    expect(client.failures).toHaveLength(1);
  });

  test("abort detaches hung model inference and a late result never completes or fails the run", async () => {
    const client = new FakeDistillerClient();
    client.claims.push(distillationClaim());
    let release!: (value: unknown) => void;
    let observedSignal: AbortSignal | undefined;
    const model: EvolutionJsonModel = {
      modelId: "hung-model-v1",
      async generateJson(_request, signal) {
        observedSignal = signal;
        return await new Promise<unknown>((resolve) => { release = resolve; });
      },
    };
    const worker = new DistillerWorker(client, model, {
      workerId: "distiller-abort-test",
      heartbeatIntervalMs: 10_000,
    });
    const controller = new AbortController();
    const running = worker.runOnce(controller.signal);
    for (let attempt = 0; attempt < 50 && observedSignal === undefined; attempt += 1) {
      await Bun.sleep(1);
    }

    controller.abort(new DOMException("service stopping", "AbortError"));
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
    expect(client.completes).toHaveLength(0);
    expect(client.failures).toHaveLength(0);

    release({ action: "no_op" });
    await Bun.sleep(1);
    expect(client.completes).toHaveLength(0);
    expect(client.failures).toHaveLength(0);
  });
});

describe("CuratorWorker", () => {
  test("no claim is idle", async () => {
    const client = new FakeCuratorClient();
    const model = new FakeModel();
    expect(await new CuratorWorker(client, model, { workerId: "curator-1" }).runOnce())
      .toEqual({ state: "idle" });
    expect(model.requests).toHaveLength(0);
    expect(client.log).toEqual(["claim"]);
  });

  test("emits all four outcomes, evidence-bound evaluations, remediation CAS, and renews", async () => {
    const client = new FakeCuratorClient();
    client.claims.push(curatorClaim());
    const model = new FakeModel();
    const outcomes = ["success", "applicability_failure", "execution_failure", "inconclusive"] as const;
    model.responses.push({
      evaluations: outcomes.map((outcome, index) => ({
        application_id: `app-${index + 1}`,
        outcome,
        confidence: outcome === "inconclusive" ? 0.4 : 0.9,
        reason: `Reason ${index + 1}`,
        evidence_refs: outcome === "inconclusive" ? [] : [`evidence-${index + 1}`],
        supersedes_id: null,
      })),
      remediations: outcomes.map((_, index) => ({
        skill_id: `skill-${index + 1}`,
        action: "no_op",
      })),
    });
    const result = await new CuratorWorker(client, model, {
      workerId: "curator-1",
      leaseSeconds: 90,
    }).runOnce();
    expect(result.state).toBe("completed");
    expect(client.log).toEqual(["claim", "renew", "complete"]);
    expect(client.completes[0]!.evaluations.map((item) => item.outcome)).toEqual([...outcomes]);
    expect(client.completes[0]!.evaluations[0]).toMatchObject({
      application_id: "app-1",
      evidence_snapshot_hash: "1".repeat(64),
      evidence_refs: ["evidence-1"],
    });
    expect(client.completes[0]!.remediations[0]).toEqual({
      skill_id: "skill-1",
      expected_active_version_id: "version-1",
      expected_control_revision: 4,
      action: "no_op",
    });
    expect(client.completes[0]!.evaluator_version).toContain(CURATOR_PROMPT_VERSION);
    expect(model.requests[0]!.userPrompt).not.toContain("secret-curator-lease");
  });

  test("dry-run still computes and submits proposals through the same zero-tool path", async () => {
    const client = new FakeCuratorClient();
    client.claims.push(curatorClaim(1, "dry_run"));
    const model = new FakeModel();
    model.responses.push({
      evaluations: [{
        application_id: "app-1",
        outcome: "success",
        confidence: 0.95,
        reason: "Evidence proves the local goal",
        evidence_refs: ["evidence-1"],
        supersedes_id: null,
      }],
      remediations: [{ skill_id: "skill-1", action: "no_op" }],
    });
    await new CuratorWorker(client, model, { workerId: "curator-1" }).runOnce();
    expect(model.requests).toHaveLength(1);
    expect(client.completes[0]!.evaluations).toHaveLength(1);
    expect(client.completes[0]!.remediations).toHaveLength(1);
    expect(client.log).toEqual(["claim", "renew", "complete"]);
  });

  test("low-confidence attributable output is malformed and never completes", async () => {
    const client = new FakeCuratorClient();
    client.claims.push(curatorClaim(1));
    const model = new FakeModel();
    model.responses.push({
      evaluations: [{
        application_id: "app-1",
        outcome: "success",
        confidence: 0.5,
        reason: "Guess",
        evidence_refs: ["evidence-1"],
        supersedes_id: null,
      }],
      remediations: [{ skill_id: "skill-1", action: "no_op" }],
    });
    const result = await new CuratorWorker(client, model, { workerId: "curator-1" }).runOnce();
    expect(result).toMatchObject({
      state: "failed",
      errorCode: "MALFORMED_MODEL_OUTPUT",
      retryable: false,
    });
    expect(client.log).toEqual(["claim", "fail"]);
  });

  test("retryable Curator model failure requeues without complete", async () => {
    const client = new FakeCuratorClient();
    client.claims.push(curatorClaim(1));
    const model = new FakeModel();
    model.responses.push(new RetryableModelError("temporary model outage"));
    const result = await new CuratorWorker(client, model, { workerId: "curator-1" }).runOnce();
    expect(result).toMatchObject({ state: "failed", retryable: true, coreState: "queued" });
    expect(client.log).toEqual(["claim", "fail"]);
  });

  test("an uncertain eval mutation escapes without calling Curator fail", async () => {
    const client = new FakeCuratorClient();
    client.claims.push(curatorClaim(1));
    const model = new FakeModel();
    const uncertain = Object.assign(new Error("recovery required"), {
      code: "EVOLUTION_EVAL_RECONCILIATION_REQUIRED",
      retryable: true,
      suppressCuratorFail: true,
    });
    const worker = new CuratorWorker(client, model, {
      workerId: "curator-1",
      evaluator: {
        async run() {
          throw uncertain;
        },
      },
    });
    await expect(worker.runOnce()).rejects.toBe(uncertain);
    expect(client.failures).toHaveLength(0);
    expect(client.completes).toHaveLength(0);
    expect(client.log).toEqual(["claim"]);
  });
});
