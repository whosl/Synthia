import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { CuratorClaimV1 } from "./evolution-worker-client.ts";
import type { EvolutionJsonModel, EvolutionJsonModelRequest } from "./evolution-workers.ts";
import {
  EvolutionEvaluator,
  EvolutionEvaluatorContractError,
  type EvolutionEvaluatorRunInput,
} from "./evolution-evaluator.ts";
import type {
  EvolutionEvalClient,
  EvolutionEvalEvidenceContentV1,
  EvolutionEvalEvidenceMutationResultV1,
  EvolutionEvalPrepareRequestV1,
  EvolutionEvalPrepareResultV1,
  EvolutionEvalRecoveryJobV1,
  EvolutionEvalRecoveryV1,
  EvolutionEvalStatusV1,
  EvolutionEvalWorkspaceFilesV1,
  EvolutionEvalWorkspaceResultV1,
} from "./evolution-eval-client.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const START = "2026-08-27T01:00:00.000Z";
const DEADLINE = "2026-08-27T03:00:00.000Z";

class FakeModel implements EvolutionJsonModel {
  readonly modelId = "eval-model";
  readonly responses: unknown[] = [];
  readonly requests: EvolutionJsonModelRequest[] = [];
  readonly log: string[];

  constructor(log: string[]) {
    this.log = log;
  }

  async generateJson(request: EvolutionJsonModelRequest): Promise<unknown> {
    this.log.push("model");
    this.requests.push(request);
    return this.responses.shift();
  }
}

class FakeEvalClient implements EvolutionEvalClient {
  readonly log: string[];
  readonly prepareBodies: EvolutionEvalPrepareRequestV1[] = [];
  readonly keys: string[] = [];
  readonly statusErrorCodes = new Map<string, string | null>();
  recovery: EvolutionEvalRecoveryV1;
  recoverQueue: EvolutionEvalRecoveryV1[] = [];
  recoverHook: (() => void) | null = null;
  prepareError: Error | null = null;
  writeError: Error | null = null;
  submitError: Error | null = null;
  statusDeadlineAt = DEADLINE;

  constructor(log: string[], recovery = emptyRecovery()) {
    this.log = log;
    this.recovery = recovery;
  }

  async recover(): Promise<EvolutionEvalRecoveryV1> {
    this.log.push("recover");
    this.recoverHook?.();
    const queued = this.recoverQueue.shift();
    if (queued) this.recovery = queued;
    return structuredClone(this.recovery);
  }

  async prepare(_runId: string, request: EvolutionEvalPrepareRequestV1, key: string): Promise<EvolutionEvalPrepareResultV1> {
    this.log.push("prepare");
    this.prepareBodies.push(request);
    this.keys.push(key);
    const ordinal = (this.recovery.jobs.length + 1) as 1 | 2 | 3;
    const draft = recoveryJob(ordinal, request.application_id, `eval-job-${ordinal}`, `tool-run-${ordinal}`, "submitted", "none");
    this.recovery = {
      ...this.recovery,
      jobs: [...this.recovery.jobs, { ...draft, workspace_sealed: false, reconciliation_state: "not_needed" }],
    };
    if (this.prepareError) throw this.prepareError;
    return {
      schema: "evolution-eval-prepare-result.v1",
      eval_job_id: `eval-job-${ordinal}`,
      tool_run_id: `tool-run-${ordinal}`,
      workspace_id: `workspace-${ordinal}`,
      ordinal,
      state: "submitted",
      workspace_revision: 1,
      source_commit: "a".repeat(40),
      source_manifest_hash: H1,
      workspace_manifest_hash: H2,
      deadline_at: DEADLINE,
      effective_timeout_ms: request.timeout_ms,
      replayed: false,
    };
  }

  async readWorkspace(): Promise<EvolutionEvalWorkspaceFilesV1> {
    throw new Error("unexpected readWorkspace");
  }

  async writeWorkspace(_runId: string, _jobId: string, input: { readonly workspace_id: string; readonly expected_workspace_revision: number }, key: string): Promise<EvolutionEvalWorkspaceResultV1> {
    this.log.push("write");
    this.keys.push(key);
    if (this.writeError) throw this.writeError;
    return { schema: "evolution-eval-workspace-result.v1", workspace_id: input.workspace_id, workspace_revision: input.expected_workspace_revision + 1, workspace_manifest_hash: H3, file_count: 2, total_bytes: 10, replayed: false };
  }

  async submit(_runId: string, evalJobId: string, _input: unknown, key: string): Promise<EvolutionEvalStatusV1> {
    this.log.push("submit");
    this.keys.push(key);
    const prepared = this.prepareBodies.at(-1)!;
    const ordinal = this.prepareBodies.length as 1 | 2 | 3;
    const job = recoveryJob(ordinal, prepared.application_id, evalJobId, `tool-run-${ordinal}`, "succeeded", "frozen");
    this.recovery = {
      ...this.recovery,
      jobs: this.recovery.jobs.map(existing => existing.eval_job_id === evalJobId ? job : existing),
    };
    if (this.submitError) throw this.submitError;
    return statusFrom(job, null);
  }

  async status(_runId: string, evalJobId: string): Promise<EvolutionEvalStatusV1> {
    this.log.push("status");
    const job = this.recovery.jobs.find(candidate => candidate.eval_job_id === evalJobId)!;
    return statusFrom(
      job,
      this.statusErrorCodes.get(evalJobId)
        ?? (job.state === "failed" ? "EVOLUTION_EVAL_EXECUTION_FAILED" : null),
      this.statusDeadlineAt,
    );
  }

  async cancel(_runId: string, evalJobId: string): Promise<EvolutionEvalStatusV1> {
    this.log.push("cancel");
    const current = this.recovery.jobs.find(job => job.eval_job_id === evalJobId)!;
    const rejected = { ...current, state: "rejected" as const, reconciliation_state: "confirmed" as const };
    this.recovery = { ...this.recovery, jobs: this.recovery.jobs.map(job => job.eval_job_id === evalJobId ? rejected : job) };
    this.statusErrorCodes.set(evalJobId, "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH");
    return statusFrom(rejected, "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH");
  }

  async freezeEvidence(): Promise<EvolutionEvalEvidenceMutationResultV1> {
    this.log.push("freeze");
    return { schema: "evolution-eval-evidence-pending.v1", eval_job_id: "job", action: "freeze", duty_state: "freeze_pending", replayed: false };
  }

  async readEvidence(): Promise<EvolutionEvalEvidenceContentV1> {
    throw new Error("unexpected readEvidence");
  }
}

function claim(mode: "run" | "dry_run" = "run", evalCapable = true): EvolutionEvaluatorRunInput {
  const recovery = mode === "dry_run"
    ? { budget_started_at: null, deadline_at: null, unknown_effect_latched_at: null, jobs: [] }
    : emptyRecovery();
  const run: NonNullable<CuratorClaimV1["run"]> = {
    run_id: "run-1",
    mode,
    state: "running",
    attempt: 1,
    lease_token: "secret-lease",
    lease_expires_at: "2026-08-27T01:15:00.000Z",
    schedule_bucket: "manual:test",
    eval_recovery: recovery,
    applications: [{
      application: {
        schema: "skill-application-detail.v1",
        application_id: "app-1",
        project_ref: "project-1",
        task_ref: "task-1",
        observation_key: "task:1",
        episode_ref: "episode-1",
        local_goal: "verify timing repair",
        state: "pending_evaluation",
        started_at: START,
        closed_at: "2026-08-27T01:01:00.000Z",
        duration_ms: 60_000,
        human_corrections: 0,
        outcome_claim: "fixed",
        skills: [{ skill_id: "skill-1", version_id: "version-1", role: "primary", reason_codes: ["timing"] }],
        evidence_summary: { visible: 1, redacted: 0, refs: [{ type: "report", id: "evidence-1", hash: H1 }] },
        evaluations: [],
      },
      primary_version: {
        skill: {
          schema: "learned-skill-summary.v1",
          skill_id: "skill-1",
          slug: "timing",
          name: "Timing",
          summary: "Timing repair",
          applicability_summary: "Vivado",
          active_version_id: "version-1",
          active_version_no: 1,
          quality_state: "active_unproven",
          freshness_state: "current",
          availability_state: "available",
          enabled: true,
          pinned: false,
          recommended: true,
          control_revision: 1,
          last_used_at: null,
          metrics: { measurement_state: "unknown", primary_applied: 0, evaluated: 0, pending: 0, inconclusive: 0, success: 0, applicability_failure: 0, execution_failure: 0, success_rate: null, median_duration_ms: null, human_corrections: null, first_solved_problem_families: null },
        },
        version_id: "version-1",
        content_manifest_hash: H2,
        description: "read-only guidance",
        applicability: { toolchain: "Vivado" },
        outcome_contract: { expected: "pass" },
        files: [{ path: "SKILL.md", kind: "skill_md", language: null, sha256: H3, content: "# Timing" }, { path: "scripts/check.tcl", kind: "script", language: "tcl", sha256: H2, content: "puts inert" }],
      },
      eval_input: mode === "dry_run" || !evalCapable ? null : {
        eval_input_ref: "input-1",
        input_manifest_hash: H1,
        source_commit: "a".repeat(40),
        source_manifest_hash: H2,
        allowed_operations: ["validate_sources", "simulate", "synthesize", "implement"],
        trial_bitstream_allowed: true,
        part: "xc7a35tcpg236-1",
        toolchain_profile_hash: H3,
      },
      evidence_snapshot_hash: H1,
      evidence: [{ type: "report", id: "evidence-1", sha256: H1, summary: "main evidence", content: "pass" }],
    }],
  };
  return { run };
}

function emptyRecovery(): EvolutionEvalRecoveryV1 {
  return { budget_started_at: START, deadline_at: DEADLINE, unknown_effect_latched_at: null, jobs: [] };
}

function recoveryJob(
  ordinal: 1 | 2 | 3,
  applicationId: string,
  evalJobId: string,
  toolRunId: string,
  state: EvolutionEvalRecoveryJobV1["state"],
  evidenceState: EvolutionEvalRecoveryJobV1["evidence_state"],
): EvolutionEvalRecoveryJobV1 {
  return {
    eval_job_id: evalJobId,
    tool_run_id: toolRunId,
    application_id: applicationId,
    version_id: "version-1",
    ordinal,
    operation: "synthesize",
    state,
    workspace_id: `workspace-${ordinal}`,
    workspace_revision: 1,
    workspace_manifest_hash: H2,
    workspace_sealed: true,
    evidence_state: evidenceState,
    retention_state: evidenceState === "frozen" ? "pending_ack" : "not_applicable",
    evidence_manifest_hash: evidenceState === "frozen" ? H3 : null,
    reconciliation_state: "confirmed",
  };
}

function statusFrom(
  job: EvolutionEvalRecoveryJobV1,
  errorCode: string | null,
  deadlineAt = DEADLINE,
): EvolutionEvalStatusV1 {
  return { schema: "evolution-eval-status.v1", eval_job_id: job.eval_job_id, tool_run_id: job.tool_run_id, curator_run_id: "run-1", application_id: job.application_id, version_id: job.version_id, ordinal: job.ordinal, operation: job.operation, run_class: "evolution_eval", state: job.state, deadline_at: deadlineAt, error_code: errorCode, workspace_manifest_hash: job.workspace_manifest_hash, evidence_manifest_hash: job.evidence_manifest_hash, evidence_state: job.evidence_state, retention_state: job.retention_state, reconciliation_state: job.reconciliation_state, replayed: false };
}

function runEval(operation: "validate_sources" | "simulate" | "synthesize" | "implement" = "synthesize"): Record<string, unknown> {
  const parameters = operation === "validate_sources"
    ? { operation, source_paths: ["rtl/top.sv"], top: "top" }
    : operation === "simulate"
    ? { operation, source_paths: ["rtl/top.sv", "sim/tb.sv"], top: "top", testbench: "tb" }
    : operation === "synthesize"
    ? { operation, source_paths: ["rtl/top.sv"], top: "top", part: "xc7a35tcpg236-1" }
    : { operation, source_paths: ["rtl/top.sv"], constraint_paths: ["constraints/top.xdc"], top: "top", part: "xc7a35tcpg236-1", generate_trial_bitstream: true };
  return { action: "run_eval", application_id: "app-1", operation, parameters, timeout_ms: 60_000, workspace_changes: [] };
}

function finalize(outcome: "success" | "inconclusive" = "success", remediation: "no_op" | "patch" = "no_op"): Record<string, unknown> {
  return {
    action: "finalize",
    evaluations: [{ application_id: "app-1", outcome, confidence: outcome === "success" ? 0.95 : 0.5, reason: "evidence reviewed", evidence_refs: outcome === "success" ? ["evidence-1"] : [], supersedes_id: null }],
    remediations: [{ skill_id: "skill-1", action: remediation, ...(remediation === "patch" ? { patch: { description: "unsafe" } } : {}) }],
  };
}

describe("EvolutionEvaluator", () => {
  test("recovers before the first model turn, runs one serial job, and attaches exact DB refs", async () => {
    const log: string[] = [];
    const client = new FakeEvalClient(log);
    const model = new FakeModel(log);
    model.responses.push(runEval(), finalize());
    const result = await new EvolutionEvaluator(client, model, { now: () => Date.parse(START), pollIntervalMs: 0 }).run(claim());
    expect(log.slice(0, 3)).toEqual(["recover", "recover", "model"]);
    expect(log).toContain("prepare");
    expect(log).toContain("submit");
    expect(result.jobsRun).toBe(1);
    expect(result.evaluations[0]!.eval_job_refs).toEqual([{ eval_job_id: "eval-job-1", tool_run_id: "tool-run-1", evidence_manifest_hash: H3 }]);
    expect(client.keys.every(key => /^[0-9a-f]{64}:(prepare|submit)$/.test(key))).toBe(true);
    expect(model.requests.every(request => !request.userPrompt.includes("secret-lease"))).toBe(true);
  });

  test("dry-run, absent eval input, deadline, and unknown latch expose finalize only", async () => {
    const cases = [
      { input: claim("dry_run"), recovery: null, now: Date.parse(START) },
      { input: claim("run", false), recovery: emptyRecovery(), now: Date.parse(START) },
      { input: claim(), recovery: emptyRecovery(), now: Date.parse(DEADLINE) },
      { input: claim(), recovery: { ...emptyRecovery(), unknown_effect_latched_at: START }, now: Date.parse(START) },
    ];
    for (const item of cases) {
      const log: string[] = [];
      const client = new FakeEvalClient(log, item.recovery ?? emptyRecovery());
      const model = new FakeModel(log);
      model.responses.push(runEval());
      await expect(new EvolutionEvaluator(client, model, { now: () => item.now, pollIntervalMs: 0 }).run(item.input))
        .rejects.toBeInstanceOf(EvolutionEvaluatorContractError);
      expect(client.prepareBodies).toHaveLength(0);
      expect(JSON.parse(model.requests[0]!.userPrompt).allowed_actions).toEqual(["finalize"]);
      if (item.input.run.mode === "dry_run") expect(log[0]).toBe("model");
      else expect(log[0]).toBe("recover");
    }
  });

  test("rejects raw Tcl, hardware/project fields, and Skill-script overlay attempts before Core writes", async () => {
    const invalid = [
      { ...runEval(), hardware_target: "xilinx_tcf" },
      { ...runEval(), project_path: "/project" },
      { ...runEval(), parameters: { ...(runEval().parameters as object), raw_tcl: "exec sh" } },
      { ...runEval(), workspace_changes: [{ action: "upsert", path: "scripts/evil.tcl", sha256: H1, content_base64: Buffer.from("puts bad").toString("base64") }] },
      { ...runEval(), workspace_changes: [{ action: "delete", path: "scripts/check.tcl" }] },
    ];
    for (const action of invalid) {
      const log: string[] = [];
      const client = new FakeEvalClient(log);
      const model = new FakeModel(log);
      model.responses.push(action);
      await expect(new EvolutionEvaluator(client, model, { now: () => Date.parse(START), pollIntervalMs: 0 }).run(claim()))
        .rejects.toBeInstanceOf(EvolutionEvaluatorContractError);
      expect(client.prepareBodies).toHaveLength(0);
    }
  });

  test("recovery-first settles an inherited running job before the model and never redrives it", async () => {
    const log: string[] = [];
    const running = recoveryJob(1, "app-1", "old-job", "old-tool", "running", "none");
    const settled = recoveryJob(1, "app-1", "old-job", "old-tool", "succeeded", "frozen");
    const client = new FakeEvalClient(log, { ...emptyRecovery(), jobs: [running] });
    client.recoverQueue.push({ ...emptyRecovery(), jobs: [running] }, { ...emptyRecovery(), jobs: [settled] });
    const model = new FakeModel(log);
    model.responses.push(finalize());
    const result = await new EvolutionEvaluator(client, model, { now: () => Date.parse(START), pollIntervalMs: 0 }).run(claim());
    expect(log.slice(0, 3)).toEqual(["recover", "recover", "model"]);
    expect(client.prepareBodies).toHaveLength(0);
    expect(result.evaluations[0]!.eval_job_refs[0]).toEqual({ eval_job_id: "old-job", tool_run_id: "old-tool", evidence_manifest_hash: H3 });
  });

  test("write response loss cancels the durable draft, recovers it, and never blind-fails the run", async () => {
    const log: string[] = [];
    const client = new FakeEvalClient(log);
    client.writeError = new Error("write response lost");
    const model = new FakeModel(log);
    const content = Buffer.from("module helper; endmodule\n");
    model.responses.push({
      ...runEval(),
      workspace_changes: [{
        action: "upsert",
        path: "overlay/helper.sv",
        sha256: createHash("sha256").update(content).digest("hex"),
        content_base64: content.toString("base64"),
      }],
    }, finalize());
    const result = await new EvolutionEvaluator(client, model, {
      now: () => Date.parse(START),
      pollIntervalMs: 0,
    }).run(claim());
    expect(log).toContain("cancel");
    expect(result.evalRecovery.jobs[0]).toMatchObject({
      state: "rejected",
    });
    expect(result.evalRecovery.jobs[0]).not.toHaveProperty("error_code");
    expect(result.evaluations[0]!.eval_job_refs[0]!.evidence_manifest_hash).toBeNull();
  });

  test("prepare response loss discovers and cancels the one durable draft without duplicating it", async () => {
    const log: string[] = [];
    const client = new FakeEvalClient(log);
    client.prepareError = new Error("prepare response lost");
    const model = new FakeModel(log);
    model.responses.push(runEval(), finalize());
    const result = await new EvolutionEvaluator(client, model, {
      now: () => Date.parse(START),
      pollIntervalMs: 0,
    }).run(claim());
    expect(client.prepareBodies).toHaveLength(1);
    expect(log).toContain("cancel");
    expect(result.evalRecovery.jobs).toHaveLength(1);
    expect(result.evalRecovery.jobs[0]).toMatchObject({
      eval_job_id: "eval-job-1",
      state: "rejected",
    });
  });

  test("submit response loss recovers the same durable job and does not duplicate or cancel a terminal effect", async () => {
    const log: string[] = [];
    const client = new FakeEvalClient(log);
    client.submitError = new Error("submit response lost");
    const model = new FakeModel(log);
    model.responses.push(runEval(), finalize());
    const result = await new EvolutionEvaluator(client, model, {
      now: () => Date.parse(START),
      pollIntervalMs: 0,
    }).run(claim());
    expect(client.prepareBodies).toHaveLength(1);
    expect(result.evalRecovery.jobs).toHaveLength(1);
    expect(result.evalRecovery.jobs[0]).toMatchObject({ state: "succeeded", evidence_state: "frozen" });
    expect(log).not.toContain("cancel");
  });

  test("three jobs are serial and a fourth run_eval is rejected", async () => {
    const log: string[] = [];
    const client = new FakeEvalClient(log);
    const model = new FakeModel(log);
    model.responses.push(runEval("validate_sources"), runEval("simulate"), runEval("synthesize"), runEval("implement"));
    await expect(new EvolutionEvaluator(client, model, { now: () => Date.parse(START), pollIntervalMs: 0 }).run(claim()))
      .rejects.toBeInstanceOf(EvolutionEvaluatorContractError);
    expect(client.prepareBodies).toHaveLength(3);
    expect(client.recovery.jobs).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      expect(log.indexOf("submit", index === 0 ? 0 : log.indexOf("submit") + 1)).toBeGreaterThan(-1);
    }
  });

  test("unknown/corrupt/unavailable facts force inconclusive, no-op, and null exact refs", async () => {
    for (const kind of ["unknown", "corrupt", "unavailable"] as const) {
      const log: string[] = [];
      const state = kind === "unknown" ? "unknown_effect" : "failed";
      const evidence = kind === "corrupt" ? "corrupt" : kind === "unavailable" ? "unavailable_at_deadline" : "none";
      const job = recoveryJob(1, "app-1", `job-${kind}`, `tool-${kind}`, state, evidence);
      const recovery = { ...emptyRecovery(), unknown_effect_latched_at: kind === "unknown" ? START : null, jobs: [job] };
      const client = new FakeEvalClient(log, recovery);
      const model = new FakeModel(log);
      model.responses.push(finalize("inconclusive", "no_op"));
      const result = await new EvolutionEvaluator(client, model, { now: () => Date.parse(START), pollIntervalMs: 0 }).run(claim());
      expect(result.evaluations[0]!.eval_job_refs).toEqual([{ eval_job_id: `job-${kind}`, tool_run_id: `tool-${kind}`, evidence_manifest_hash: null }]);

      const badClient = new FakeEvalClient([], recovery);
      const badModel = new FakeModel([]);
      badModel.responses.push(finalize("success", "patch"));
      await expect(new EvolutionEvaluator(badClient, badModel, { now: () => Date.parse(START), pollIntervalMs: 0 }).run(claim()))
        .rejects.toBeInstanceOf(EvolutionEvaluatorContractError);
    }
  });

  test("failed/none is safe only for exact never-accepted codes; accepted failures must freeze", async () => {
    const neverAccepted = recoveryJob(1, "app-1", "job-na", "tool-na", "failed", "none");
    const safeClient = new FakeEvalClient([], { ...emptyRecovery(), jobs: [neverAccepted] });
    safeClient.statusErrorCodes.set("job-na", "EVOLUTION_EVAL_NOT_ACCEPTED");
    const safeModel = new FakeModel([]);
    safeModel.responses.push(finalize());
    const safe = await new EvolutionEvaluator(safeClient, safeModel, {
      now: () => Date.parse(START),
      pollIntervalMs: 0,
    }).run(claim());
    expect(safe.evalRecovery.jobs[0]!.evidence_state).toBe("none");

    const acceptedFailure = {
      ...neverAccepted,
      eval_job_id: "job-accepted-failure",
      tool_run_id: "tool-accepted-failure",
    };
    const unsafeClient = new FakeEvalClient([], { ...emptyRecovery(), jobs: [acceptedFailure] });
    unsafeClient.statusErrorCodes.set("job-accepted-failure", "VIVADO_SYNTHESIS_FAILED");
    const unsafeModel = new FakeModel([]);
    unsafeModel.responses.push(finalize());
    await expect(new EvolutionEvaluator(unsafeClient, unsafeModel, {
      now: () => Date.parse(START),
      pollIntervalMs: 0,
      maxRecoveryPolls: 1,
    }).run(claim())).rejects.toMatchObject({
      code: "EVOLUTION_EVAL_RECONCILIATION_REQUIRED",
      suppressCuratorFail: true,
    });
    expect(unsafeClient.log).toContain("freeze");
  });

  test("status deadline drift and recovery clock jumps fail closed without starting a new effect", async () => {
    const failed = recoveryJob(1, "app-1", "job-binding-drift", "tool-binding-drift", "failed", "none");
    const driftClient = new FakeEvalClient([], { ...emptyRecovery(), jobs: [failed] });
    driftClient.statusErrorCodes.set(failed.eval_job_id, "EVOLUTION_EVAL_NOT_ACCEPTED");
    driftClient.statusDeadlineAt = "2026-08-27T02:59:59.000Z";
    await expect(new EvolutionEvaluator(driftClient, new FakeModel([]), {
      now: () => Date.parse(START),
      pollIntervalMs: 0,
    }).run(claim())).rejects.toMatchObject({ suppressCuratorFail: true });

    const log: string[] = [];
    const live = recoveryJob(1, "app-1", "job-live", "tool-live", "running", "none");
    const clockClient = new FakeEvalClient(log, { ...emptyRecovery(), jobs: [live] });
    let now = Date.parse(START);
    let recoveryCalls = 0;
    clockClient.recoverHook = () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) now = Date.parse(DEADLINE) + 1;
    };
    await expect(new EvolutionEvaluator(clockClient, new FakeModel(log), {
      now: () => now,
      pollIntervalMs: 60_000,
    }).run(claim())).rejects.toMatchObject({
      code: "EVOLUTION_EVAL_RECONCILIATION_REQUIRED",
      suppressCuratorFail: true,
    });
    expect(recoveryCalls).toBe(4);
    expect(log).not.toContain("model");
    expect(log).not.toContain("prepare");
  });
});
