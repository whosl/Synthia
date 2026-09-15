import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  M4F_E2E_EXECUTION_AUTHORIZATION,
  M4F_E2E_DIRECT_ENDPOINT_ORIGIN,
  M4F_E2E_FAILURE_JOB_TIMEOUT_MS,
  M4F_E2E_RUNTIME_FIXTURE_ASSERTION,
  M4fScenarioModel,
  assertCertificationBudget,
  assertFailureQuarantineNegativeProof,
  assertM4fServiceReadiness,
  assertScenarioAudit,
  assertM4fE2eExecutionAuthorized,
  executeM4fEffectsAfterLiveCertification,
  reconstructQualityLifecycle,
  requiredCertificationRemainingMs,
  resolveM4fE2eConfig,
  retentionConverged,
  type M4fE2eScenario,
  type ScenarioApplication,
  type ScenarioAudit,
  type ScenarioDeposition,
} from "../scripts/run-self-evolution-m4f-e2e.ts";
import {
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
  evolutionEvalCanonicalHash,
  type EvolutionEvalWorkspaceManifestV1,
} from "../src/domain/evolution-eval.ts";
import { scanLearnedSkillPackage } from "../src/services/learned-skill-scan.ts";

const H1 = "1".repeat(64);
const TARGET_PART = "xc7k70tfbv676-1";
const TOOLCHAIN_PROFILE_HASH = "2".repeat(64);
const LEDGER_EPOCH = "ledger-epoch-test-1";
const CERTIFICATION = {
  ledgerEpoch: LEDGER_EPOCH,
  targetPart: TARGET_PART,
  toolchainProfileHash: TOOLCHAIN_PROFILE_HASH,
} as const;
const READINESS_CONFIG = {
  gateId: "gate-test-1",
  projectId: "project-1",
  targetPart: TARGET_PART,
} as const;

function readinessCertification() {
  return {
    certification_hash: H1,
    expires_at: "2026-08-28T12:00:00.000Z",
    endpoint: {
      origin: M4F_E2E_DIRECT_ENDPOINT_ORIGIN,
      connector_id: "connector-1",
    },
    worker_process_instance_id: "worker-instance-1",
    ledger: { epoch: LEDGER_EPOCH },
    active_config_sha256: "3".repeat(64),
    remote: {
      toolchain_profile_hash: TOOLCHAIN_PROFILE_HASH,
      part: TARGET_PART,
    },
    toolchain_attestation: { raw_sha256: "4".repeat(64) },
  } as never;
}

function readinessInput() {
  const certification = readinessCertification() as Record<string, unknown>;
  const endpoint = certification.endpoint as Record<string, unknown>;
  const ledger = certification.ledger as Record<string, unknown>;
  const remote = certification.remote as Record<string, unknown>;
  const attestation = certification.toolchain_attestation as Record<string, unknown>;
  return {
    overview: {
      schema: "evolution-overview.v1",
      rollout_enabled: true,
      learning_paused: false,
      learned_skills_enabled: true,
    },
    coreReadiness: {
      schema: "synthia-m4f-core-readiness.v1",
      ready: true,
      dispatcher_host_enabled: true,
      new_effects_enabled: true,
      rollout_enabled: true,
      connector_configured: true,
      certification: {
        gate_id: READINESS_CONFIG.gateId,
        certification_hash: certification.certification_hash,
        expires_at: certification.expires_at,
        endpoint_origin: endpoint.origin,
        project_id: READINESS_CONFIG.projectId,
        connector_id: endpoint.connector_id,
        worker_process_instance_id: certification.worker_process_instance_id,
        ledger_epoch: ledger.epoch,
        active_config_sha256: certification.active_config_sha256,
      },
    },
    project: {
      id: READINESS_CONFIG.projectId,
      project_type: "free",
      target_part: TARGET_PART,
      toolchain_profile_ref: remote.toolchain_profile_hash,
      status: "active",
    },
    runtime: { agents: [] },
    connectorConfig: {
      connector_id: endpoint.connector_id,
      transport_mode: "direct_https",
      auth_mode: "mtls",
      tls_trust_ref: "cert://m4f-direct/trust",
      tls_client_cert_ref: "cert://m4f-direct/client",
      evolution_eval_enabled: true,
      evolution_eval_ledger_mode: "reopen",
      evolution_eval_ledger_epoch: ledger.epoch,
      project_scope: [READINESS_CONFIG.projectId],
      toolchain_profile_hash: remote.toolchain_profile_hash,
      vivado_part: TARGET_PART,
      vivado_toolchain_attestation_sha256: attestation.raw_sha256,
    },
  };
}
const BASE_ENV = {
  DATABASE_URL: "postgres://gate:gate@127.0.0.1:5432/synthia-selfevo-gate-test",
  SYNTHIA_M4F_GATE_ID: "gate-test-1",
  SYNTHIA_M4F_E2E_RUN_ID: "run-test-1",
  SYNTHIA_M4F_E2E_HUMAN_TOKEN: "human-token",
  SYNTHIA_TASK_RUNTIME_TOKEN: "task-token",
  SYNTHIA_EVOLUTION_DISTILLER_TOKEN: "distiller-token",
  SYNTHIA_EVOLUTION_CURATOR_TOKEN: "curator-token",
  SYNTHIA_EVOLUTION_EVALUATOR_TOKEN: "evaluator-token",
} as const;

function request(purpose: "distillation" | "curation", input: unknown) {
  return {
    purpose,
    systemPrompt: "fixture",
    userPrompt: JSON.stringify(input),
    maxOutputBytes: 1_000_000,
  } as const;
}

function application(index: number) {
  return {
    application: { application_id: `app-${index}` },
    primary_version: { skill: { skill_id: "skill-1" } },
    evidence: [{ id: `evidence-${index}`, sha256: H1 }],
  };
}

function curatorInput(
  count: number,
  jobApplications: readonly string[] = [],
  jobState: "succeeded" | "failed" = "succeeded",
) {
  return {
    allowed_actions: jobApplications.length < count ? ["run_eval", "finalize"] : ["finalize"],
    applications: Array.from({ length: count }, (_, index) => application(index + 1)),
    eval_recovery: {
      jobs: jobApplications.map((applicationId, index) => ({
        application_id: applicationId,
        eval_job_id: `job-${index + 1}`,
        tool_run_id: `tool-${index + 1}`,
        version_id: "version-1",
        ordinal: index + 1,
        operation: "synthesize",
        state: jobState,
        workspace_id: `eval-workspace-${index + 1}`,
        workspace_revision: 1,
        workspace_manifest_hash: H1,
        workspace_sealed: true,
        evidence_state: "frozen",
        retention_state: "pending_ack",
        evidence_manifest_hash: H1,
        reconciliation_state: "not_needed",
      })),
    },
  };
}

function deposition(): ScenarioDeposition {
  return {
    taskId: "deposition-task-1",
    workspaceId: "deposition-workspace-1",
    resultId: "deposition-result-1",
  };
}

function expectedApplications(count: number): ScenarioApplication[] {
  return Array.from({ length: count }, (_, index) => ({
    applicationId: `app-${index + 1}`,
    taskId: `application-task-${index + 1}`,
    workspaceId: `application-workspace-${index + 1}`,
    resultId: `application-result-${index + 1}`,
    evidenceRef: `evidence-${index + 1}`,
  }));
}

function scenarioAudit(scenario: M4fE2eScenario): ScenarioAudit {
  const count = scenario === "success" ? 1 : 3;
  const outcome = scenario === "success" ? "success" : "execution_failure";
  const toolState = scenario === "success" ? "succeeded" : "failed";
  const qualityState = scenario === "success" ? "active_observed" : "quarantined";
  const applicationIds = Array.from({ length: count }, (_, index) => `app-${index + 1}`);
  const lifecycleEdges = scenario === "success"
    ? [["active_unproven", "active_observed"]]
    : [
        ["active_unproven", "needs_review"],
        ["needs_review", "degraded"],
        ["degraded", "quarantined"],
      ];
  const evalJobs = applicationIds.map((applicationId, index) => {
    const jobId = `job-${index + 1}`;
    const workspaceId = `workspace-${index + 1}`;
    const workspaceManifest: EvolutionEvalWorkspaceManifestV1 = {
      schema: "evolution-eval-workspace-manifest.v1",
      workspace_id: workspaceId,
      revision: 1,
      files: [{
        path: "rtl/top.sv",
        sha256: H1,
        size_bytes: 42,
        media_type: "text/x-systemverilog",
        layer: "source",
        read_only: true,
      }],
    };
    const workspaceManifestHash = canonicalEvolutionEvalWorkspaceManifest(
      workspaceManifest,
    ).sha256;
    const sealedProjectionHash = canonicalEvolutionEvalSealedInputProjection(
      workspaceManifest,
    ).sha256;
    const parameters = {
      operation: "synthesize",
      source_paths: ["rtl/top.sv"],
      top: "top",
      part: TARGET_PART,
    };
    const deadline = "2026-08-28T08:00:00.000Z";
    const connectorJobId = `connector-job-${index + 1}`;
    const synthesisResult = {
      schema: "synthesize-result.v1",
      passed: scenario === "success",
      status: toolState,
      exitCode: scenario === "success" ? 0 : 1,
      timedOut: false,
    };
    const synthesisResultContent = JSON.stringify(synthesisResult, null, 2);
    const synthesisResultHash = createHash("sha256").update(synthesisResultContent).digest("hex");
    const frozenManifest = {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: jobId,
      tool_run_id: `tool-${index + 1}`,
      entries: [{
        name: "synthesis-result.json",
        sha256: synthesisResultHash,
        size_bytes: Buffer.byteLength(synthesisResultContent),
        media_type: "application/json",
        artifact_classification: "evolution_eval_evidence",
        usage_classification: "evolution_eval_only",
      }],
    } as const;
    const evidenceManifestHash = evolutionEvalCanonicalHash(frozenManifest);
    const dispatchRequestHash = evolutionEvalCanonicalHash({
      schema: "evolution-eval-dispatch-request.v1",
      eval_job_id: jobId,
      connector_job_id: connectorJobId,
      connector_idempotency_key: H1,
      eval_input_ref: `eval-input-${index + 1}`,
      input_manifest_hash: H1,
      workspace_id: workspaceId,
      workspace_revision: 1,
      workspace_manifest_hash: workspaceManifestHash,
      sealed_input_projection_hash: sealedProjectionHash,
      operation: "synthesize",
      parameters,
      part: TARGET_PART,
      toolchain_profile_hash: TOOLCHAIN_PROFILE_HASH,
      requested_timeout_ms: 600_000,
      operation_cap_ms: 7_200_000,
      deadline_at: deadline,
      run_class: "evolution_eval",
    });
    return {
      id: jobId,
      curator_run_id: "curator-1",
      application_id: applicationId,
      tool_run_id: `tool-${index + 1}`,
      connector_job_id: connectorJobId,
      connector_idempotency_key: H1,
      eval_input_ref: `eval-input-${index + 1}`,
      input_manifest_hash: H1,
      ordinal: index + 1,
      operation: "synthesize",
      parameters,
      requested_timeout_ms: 600_000,
      deadline_at: deadline,
      state: toolState,
      error_code: null,
      tool_operation: "synthesize",
      tool_run_class: "evolution_eval",
      tool_project_id: "project-1",
      tool_input_manifest_hash: H1,
      tool_toolchain_profile_hash: TOOLCHAIN_PROFILE_HASH,
      evidence_manifest_hash: evidenceManifestHash,
      frozen_manifest: frozenManifest,
      workspace_id: workspaceId,
      workspace_input_manifest_hash: H1,
      workspace_source_commit: "a".repeat(40),
      workspace_source_manifest_hash: H1,
      eval_input_manifest_hash: H1,
      eval_source_commit: "a".repeat(40),
      eval_source_manifest_hash: H1,
      eval_part: TARGET_PART,
      eval_toolchain_profile_hash: TOOLCHAIN_PROFILE_HASH,
      dispatch_workspace_id: workspaceId,
      workspace_revision: 1,
      workspace_manifest_hash: workspaceManifestHash,
      dispatch_workspace_manifest_hash: workspaceManifestHash,
      sealed_input_projection_hash: sealedProjectionHash,
      dispatch_request_hash: dispatchRequestHash,
      current_revision: 1,
      workspace_sealed_at: "2026-08-28T07:00:00.000Z",
      workspace_manifest: workspaceManifest,
      ledger_epoch: LEDGER_EPOCH,
      dispatch_audit_request_hash: dispatchRequestHash,
      dispatch_outbox_payload: { dispatch_request_hash: dispatchRequestHash },
      dispatch_outbox_published: true,
    };
  });
  const connectorObservations = evalJobs.map((job) => {
    const observation = {
      schema: "evolution-eval-ledger-query.v1",
      state: "terminal",
      connector_job_id: job.connector_job_id,
      connector_idempotency_key: job.connector_idempotency_key,
      dispatch_request_hash: job.dispatch_request_hash,
      ledger_epoch: LEDGER_EPOCH,
      terminal_state: toolState,
      process_stopped: true,
      terminal_at: "2026-08-28T07:30:00.000Z",
      error_code: null,
    };
    return {
      eval_job_id: job.id,
      observation_type: "terminal",
      connector_job_id: job.connector_job_id,
      connector_idempotency_key: job.connector_idempotency_key,
      dispatch_request_hash: job.dispatch_request_hash,
      ledger_epoch: LEDGER_EPOCH,
      observation,
      observation_hash: evolutionEvalCanonicalHash(observation),
    };
  });
  return {
    project: {
      id: "project-1",
      target_part: TARGET_PART,
      toolchain_profile_ref: TOOLCHAIN_PROFILE_HASH,
    },
    skill: { id: "skill-1" },
    version: {
      id: "version-1",
      quality_state: qualityState,
      distillation_run_id: "distillation-1",
    },
    sourceDistillation: {
      distillation_run_id: "distillation-1",
      run_id: "distillation-1",
      run_state: "succeeded",
      run_episode_id: "deposition-episode-1",
      episode_id: "deposition-episode-1",
      project_id: "project-1",
      task_id: "deposition-task-1",
      evidence_refs: [{ type: "task_result", id: "deposition-result-1", hash: H1 }],
      result_id: "deposition-result-1",
      workspace_id: "deposition-workspace-1",
      output_hash: H1,
    },
    applications: applicationIds.map((id, index) => ({
      id,
      project_id: "project-1",
      task_id: `application-task-${index + 1}`,
      workspace_id: `application-workspace-${index + 1}`,
      result_id: `application-result-${index + 1}`,
      state: "evaluated",
      episode_id: `application-episode-${index + 1}`,
      human_corrections: 0,
    })),
    curatorRuns: [{ id: "curator-1", mode: "run", state: "completed" }],
    evaluations: applicationIds.map((applicationId, index) => ({
      id: `evaluation-${index + 1}`,
      curator_run_id: "curator-1",
      application_id: applicationId,
      outcome,
      eval_job_refs: [{
        eval_job_id: `job-${index + 1}`,
        tool_run_id: `tool-${index + 1}`,
        evidence_manifest_hash: evalJobs[index]!.evidence_manifest_hash,
      }],
    })),
    evalJobs,
    connectorObservations,
    evidenceFacts: applicationIds.map((_, index) => ({
      eval_job_id: `job-${index + 1}`,
      fact_type: "frozen",
      manifest_hash: evalJobs[index]!.evidence_manifest_hash,
      manifest: evalJobs[index]!.frozen_manifest,
      connector_manifest_hash: H1,
      fact_hash: H1,
      entry_count: 1,
      total_bytes: Number((evalJobs[index]!.frozen_manifest as {
        entries: Array<{ size_bytes: number }>;
      }).entries[0]!.size_bytes),
    })).flatMap((frozen) => [
      frozen,
      ...["ack_pending", "acknowledged", "cleanup_pending", "cleaned"].map((factType) => ({
        eval_job_id: frozen.eval_job_id,
        fact_type: factType,
        fact_hash: H1,
      })),
    ]),
    evidenceEntries: evalJobs.map((job) => {
      const manifest = job.frozen_manifest as { entries: Array<Record<string, unknown>> };
      const entry = manifest.entries[0]!;
      return {
        eval_job_id: job.id,
        ...entry,
        content_text: JSON.stringify({
          schema: "synthesize-result.v1",
          passed: scenario === "success",
          status: toolState,
          exitCode: scenario === "success" ? 0 : 1,
          timedOut: false,
        }, null, 2),
      };
    }),
    retentionReceipts: evalJobs.flatMap((job) => [{
      eval_job_id: job.id,
      receipt_type: "acknowledgement",
      connector_state: "acknowledged",
      authorization_hash: H1,
      connector_fact_hash: H1,
    }, {
      eval_job_id: job.id,
      receipt_type: "cleanup",
      connector_state: "cleaned",
      authorization_hash: H1,
      connector_fact_hash: H1,
    }]),
    lifecycleEvents: lifecycleEdges.map(([from, to], index) => ({
      id: `lifecycle-${index + 1}`,
      event_type: "quality_evaluated",
      from_projection: { quality_state: from },
      to_projection: { quality_state: to },
    })),
  };
}

describe("M4-F Self-Evolution E2E runner", () => {
  test("quarantine negative proof requires search/apply rejection and no new execution identities", () => {
    const before = {
      evalJobs: [{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }],
      dispatches: [{ eval_job_id: "job-1" }, { eval_job_id: "job-2" }, { eval_job_id: "job-3" }],
      toolRuns: [{ id: "tool-1" }, { id: "tool-2" }, { id: "tool-3" }],
      connectorObservations: [{ id: "observation-1", observation_hash: H1 }],
    };
    const valid = {
      versionId: "version-1",
      searchVersionIds: ["version-other"],
      rejection: {
        code: "conflict",
        httpStatus: 409,
        retryable: false,
        message: "SKILL_NOT_AVAILABLE",
      },
      before,
      after: structuredClone(before),
    };
    expect(() => assertFailureQuarantineNegativeProof(valid)).not.toThrow();
    expect(() => assertFailureQuarantineNegativeProof({
      ...valid,
      searchVersionIds: ["version-1"],
    })).toThrow("remained visible");
    expect(() => assertFailureQuarantineNegativeProof({
      ...valid,
      rejection: { ...valid.rejection, message: "SKILL_VERSION_NOT_ACTIVE" },
    })).toThrow("SKILL_NOT_AVAILABLE");
    expect(() => assertFailureQuarantineNegativeProof({
      ...valid,
      after: { ...valid.after, evalJobs: [...valid.after.evalJobs, { id: "job-4" }] },
    })).toThrow("created or changed evalJobs");
    expect(() => assertFailureQuarantineNegativeProof({
      ...valid,
      after: {
        ...valid.after,
        connectorObservations: [
          ...valid.after.connectorObservations,
          { id: "observation-2", observation_hash: H1 },
        ],
      },
    })).toThrow("created or changed connectorObservations");
  });

  test.each([
    ["Worker unavailable", "REMOTE_UNAVAILABLE"],
    ["mapping unhealthy", "PROJECT_SCOPE_MISMATCH"],
    ["ledger epoch drift", "LEDGER_EPOCH_MISMATCH"],
  ])("live certification blocks all business facts when %s", async (_label, code) => {
    let businessFacts = 0;
    const fetchImpl = (async () => new Response(JSON.stringify({
      schema: "synthia-envelope.v1",
      error: { code: "capability_unavailable", details: { code } },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(executeM4fEffectsAfterLiveCertification({
      coreBaseUrl: "http://127.0.0.1:8787",
      humanToken: "human-token",
      gateId: READINESS_CONFIG.gateId,
      certificationHash: H1,
      projectId: READINESS_CONFIG.projectId,
      endpointOrigin: M4F_E2E_DIRECT_ENDPOINT_ORIGIN,
      connectorId: "connector-1",
      workerProcessInstanceId: "worker-instance-1",
      ledgerEpoch: LEDGER_EPOCH,
    }, fetchImpl, async () => {
      businessFacts += 1;
    })).rejects.toThrow("POST /api/v1/evolution/m4f-live-certification failed");
    expect(businessFacts).toBe(0);
  });

  test("defaults to read-only preflight and rejects a non-Gate database", () => {
    const config = resolveM4fE2eConfig(BASE_ENV);
    expect(config).toMatchObject({
      mode: "preflight",
      scenario: "success",
      projectId: null,
      executionAuthorized: false,
      exclusiveWorkersAsserted: false,
      certification: null,
    });
    expect(config.jobTimeoutMs).toBe(180_000);
    expect(() => resolveM4fE2eConfig({
      ...BASE_ENV,
      DATABASE_URL: "postgres://gate:gate@127.0.0.1:5432/synthia",
    })).toThrow("synthia-selfevo-gate-");
  });

  test("failure fixture fixes a short timeout and certification budget covers every serial dispatch", () => {
    const failure = resolveM4fE2eConfig({
      ...BASE_ENV,
      SYNTHIA_M4F_E2E_SCENARIO: "failure-quarantine",
    });
    expect(failure.jobTimeoutMs).toBe(M4F_E2E_FAILURE_JOB_TIMEOUT_MS);
    expect(requiredCertificationRemainingMs(failure)).toBe(
      3 * M4F_E2E_FAILURE_JOB_TIMEOUT_MS + 30_000 + 120_000,
    );
    expect(() => resolveM4fE2eConfig({
      ...BASE_ENV,
      SYNTHIA_M4F_E2E_SCENARIO: "failure-quarantine",
      SYNTHIA_M4F_E2E_JOB_TIMEOUT_MS: "600000",
    })).toThrow("fixes SYNTHIA_M4F_E2E_JOB_TIMEOUT_MS");
    expect(() => assertCertificationBudget(
      failure,
      { expires_at: new Date(Date.now() + 300_000).toISOString() },
    )).toThrow("serial M4-F scenario");
    expect(() => assertCertificationBudget(
      failure,
      { expires_at: new Date(Date.now() + 550_000).toISOString() },
    )).not.toThrow();
  });

  test("new effects require the exact authorization, exclusive workers, B v2, and output", () => {
    const noAuthorization = resolveM4fE2eConfig({
      ...BASE_ENV,
      SYNTHIA_M4F_E2E_MODE: "execute",
    });
    expect(() => assertM4fE2eExecutionAuthorized(noAuthorization))
      .toThrow("SYNTHIA_M4F_E2E_EFFECTS_AUTHORIZATION");

    const noExclusiveWorkers = resolveM4fE2eConfig({
      ...BASE_ENV,
      SYNTHIA_M4F_E2E_MODE: "execute",
      SYNTHIA_M4F_E2E_EFFECTS_AUTHORIZATION: M4F_E2E_EXECUTION_AUTHORIZATION,
    });
    expect(() => assertM4fE2eExecutionAuthorized(noExclusiveWorkers))
      .toThrow("SYNTHIA_M4F_E2E_EXCLUSIVE_WORKERS=1");

    const noCertification = resolveM4fE2eConfig({
      ...BASE_ENV,
      SYNTHIA_M4F_E2E_MODE: "execute",
      SYNTHIA_M4F_E2E_EFFECTS_AUTHORIZATION: M4F_E2E_EXECUTION_AUTHORIZATION,
      SYNTHIA_M4F_E2E_EXCLUSIVE_WORKERS: "1",
      SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME: M4F_E2E_RUNTIME_FIXTURE_ASSERTION,
    });
    expect(() => assertM4fE2eExecutionAuthorized(noCertification))
      .toThrow("B v2");
  });

  test("deterministic Distiller output passes the production Skill scanner", async () => {
    const model = new M4fScenarioModel("success", "run-test-1", "xc7k70tfbv676-1");
    const output = await model.generateJson(request("distillation", {
      trajectory: { objective: "Resolve a reusable Vivado synthesis diagnosis and record the bounded method." },
    })) as Record<string, unknown>;
    expect(output.action).toBe("create");
    const skill = output.skill as Record<string, unknown>;
    const scan = scanLearnedSkillPackage(skill.files as never[], {
      name: String(skill.name),
      summary: String(skill.summary),
      description: String(skill.description),
      applicability: skill.applicability,
      outcomeContract: skill.outcome_contract,
    });
    expect(scan).toMatchObject({ decision: "pass", findings: [] });
  });

  test("success scenario issues one typed synthesis then an attributable success", async () => {
    const model = new M4fScenarioModel("success", "run-test-1", "xc7k70tfbv676-1");
    const first = await model.generateJson(request("curation", curatorInput(1))) as Record<string, unknown>;
    expect(first).toEqual({
      action: "run_eval",
      application_id: "app-1",
      operation: "synthesize",
      parameters: {
        operation: "synthesize",
        source_paths: ["rtl/top.sv"],
        top: "top",
        part: "xc7k70tfbv676-1",
      },
      timeout_ms: 600_000,
      workspace_changes: [],
    });
    const final = await model.generateJson(
      request("curation", curatorInput(1, ["app-1"])),
    ) as Record<string, unknown>;
    expect(final.action).toBe("finalize");
    expect(final.evaluations).toEqual([expect.objectContaining({
      application_id: "app-1",
      outcome: "success",
      confidence: 0.99,
      evidence_refs: ["evidence-1"],
    })]);
    expect(final.remediations).toEqual([{ skill_id: "skill-1", action: "no_op" }]);
  });

  test("failure scenario consumes three independent jobs before failure-threshold evaluation", async () => {
    const model = new M4fScenarioModel(
      "failure-quarantine",
      "run-test-1",
      "xc7k70tfbv676-1",
    );
    const jobs: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const decision = await model.generateJson(
        request("curation", curatorInput(3, jobs, "failed")),
      ) as Record<string, unknown>;
      expect(decision).toMatchObject({
        action: "run_eval",
        application_id: `app-${index}`,
        operation: "synthesize",
      });
      jobs.push(`app-${index}`);
    }
    const final = await model.generateJson(
      request("curation", curatorInput(3, jobs, "failed")),
    ) as Record<string, unknown>;
    expect(final.action).toBe("finalize");
    expect(final.evaluations).toEqual(Array.from({ length: 3 }, (_, index) => expect.objectContaining({
      application_id: `app-${index + 1}`,
      outcome: "execution_failure",
      confidence: 0.99,
      evidence_refs: [`evidence-${index + 1}`],
    })));
    expect(final.remediations).toEqual([{ skill_id: "skill-1", action: "no_op" }]);
  });

  test("Curator refuses to finalize before every application has a matching frozen terminal result", async () => {
    const model = new M4fScenarioModel("success", "run-test-1", TARGET_PART);
    await expect(model.generateJson(
      request("curation", curatorInput(1, ["app-1"], "failed")),
    )).rejects.toThrow("matching frozen synthesis result");

    const noFrozen = curatorInput(1, ["app-1"]);
    (noFrozen.eval_recovery.jobs[0] as { evidence_state: string }).evidence_state = "freeze_pending";
    await expect(model.generateJson(request("curation", noFrozen)))
      .rejects.toThrow("matching frozen synthesis result");

    await expect(model.generateJson(
      request("curation", curatorInput(1, ["app-1", "app-extra"])),
    )).rejects.toThrow("closed-set eval job");
  });

  test("service preflight binds Core, Runtime, Connector, project, and B v2 exactly", () => {
    const certification = readinessCertification();
    const input = readinessInput();
    expect(assertM4fServiceReadiness(READINESS_CONFIG, certification, input))
      .toMatchObject({
        core_ready: true,
        runtime_ready: true,
        connector_ready: true,
        effective_new_effects: true,
        certification_hash: H1,
        endpoint_origin: M4F_E2E_DIRECT_ENDPOINT_ORIGIN,
        project_scope: [READINESS_CONFIG.projectId],
      });

    expect(() => assertM4fServiceReadiness(READINESS_CONFIG, certification, {
      ...input,
      coreReadiness: {
        ...input.coreReadiness,
        certification: {
          ...input.coreReadiness.certification,
          certification_hash: "5".repeat(64),
        },
      },
    })).toThrow("exact effective M4-F B v2");
    const wrongEndpointCertification = {
      ...(certification as unknown as Record<string, unknown>),
      endpoint: {
        ...((certification as unknown as Record<string, unknown>).endpoint as Record<string, unknown>),
        origin: "https://connect.wenzhuolin.xyz",
      },
    } as never;
    expect(() => assertM4fServiceReadiness(
      READINESS_CONFIG,
      wrongEndpointCertification,
      {
        ...input,
        coreReadiness: {
          ...input.coreReadiness,
          certification: {
            ...input.coreReadiness.certification,
            endpoint_origin: "https://connect.wenzhuolin.xyz",
          },
        },
      },
    )).toThrow("authorized 18443 direct-mTLS origin");
    expect(() => assertM4fServiceReadiness(READINESS_CONFIG, certification, {
      ...input,
      coreReadiness: {
        ...input.coreReadiness,
        certification: {
          ...input.coreReadiness.certification,
          endpoint_origin: "https://100.96.223.49:8443",
        },
      },
    })).toThrow("exact effective M4-F B v2");
    expect(() => assertM4fServiceReadiness(READINESS_CONFIG, certification, {
      ...input,
      runtime: { agents: [{ id: "stale-task" }] },
    })).toThrow("fresh runs directory is not empty");
    expect(() => assertM4fServiceReadiness(READINESS_CONFIG, certification, {
      ...input,
      connectorConfig: {
        ...input.connectorConfig,
        project_scope: [READINESS_CONFIG.projectId, "project-2"],
      },
    })).toThrow("single certified canary project scope");
    expect(() => assertM4fServiceReadiness(READINESS_CONFIG, certification, {
      ...input,
      coreReadiness: { ...input.coreReadiness, new_effects_enabled: false },
    })).toThrow("exact effective M4-F B v2");
  });

  test("retention requires the complete acknowledgement and cleanup chain", () => {
    const audit = scenarioAudit("success");
    const complete = {
      jobIds: audit.evalJobs.map((job) => String(job.id)),
      facts: audit.evidenceFacts,
      receipts: audit.retentionReceipts,
    };
    expect(retentionConverged(complete)).toBe(true);
    expect(retentionConverged({
      ...complete,
      facts: complete.facts.filter((fact) => fact.fact_type !== "acknowledged"),
    })).toBe(false);
    expect(retentionConverged({
      ...complete,
      receipts: complete.receipts.filter((receipt) => receipt.receipt_type !== "cleanup"),
    })).toBe(false);
    expect(retentionConverged({
      ...complete,
      receipts: [...complete.receipts, complete.receipts[0]!],
    })).toBe(false);

    expect(() => assertScenarioAudit({
      ...audit,
      retentionReceipts: audit.retentionReceipts.filter(
        (receipt) => receipt.receipt_type !== "acknowledgement",
      ),
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow("acknowledgement/cleanup retention did not converge");
  });

  test("final audit proves exact success and three-step quarantine bindings", () => {
    expect(() => assertScenarioAudit(
      scenarioAudit("success"),
      "success",
      deposition(),
      expectedApplications(1),
      "curator-1",
      CERTIFICATION,
    ))
      .not.toThrow();
    expect(() => assertScenarioAudit(
      scenarioAudit("failure-quarantine"),
      "failure-quarantine",
      deposition(),
      expectedApplications(3),
      "curator-1",
      CERTIFICATION,
    )).not.toThrow();

    const wrongSourceEpisode = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongSourceEpisode,
      sourceDistillation: {
        ...wrongSourceEpisode.sourceDistillation,
        episode_id: "unrelated-episode",
      },
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow("exact deposition task result");

    const wrongSourceTask = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongSourceTask,
      sourceDistillation: {
        ...wrongSourceTask.sourceDistillation,
        task_id: "unrelated-task",
      },
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow("exact deposition task result");

    const wrongSourceResult = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongSourceResult,
      sourceDistillation: {
        ...wrongSourceResult.sourceDistillation,
        result_id: "unrelated-result",
      },
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow("exact deposition task result");

    const wrongApplicationTask = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongApplicationTask,
      applications: [{
        ...wrongApplicationTask.applications[0],
        task_id: "unrelated-task",
      }],
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow(/application tasks|exact evaluated task result/);

    const duplicateApplicationTask = scenarioAudit("failure-quarantine");
    expect(() => assertScenarioAudit({
      ...duplicateApplicationTask,
      applications: duplicateApplicationTask.applications.map((application, index) => ({
        ...application,
        task_id: index === 1 ? "application-task-1" : application.task_id,
      })),
    }, "failure-quarantine", deposition(), expectedApplications(3), "curator-1", CERTIFICATION))
      .toThrow(/application tasks|exact evaluated task result/);

    const missingDegraded = scenarioAudit("failure-quarantine");
    expect(() => assertScenarioAudit(
      { ...missingDegraded, lifecycleEvents: missingDegraded.lifecycleEvents.slice(0, 2) },
      "failure-quarantine",
      deposition(),
      expectedApplications(3),
      "curator-1",
      CERTIFICATION,
    )).toThrow("Skill quality lifecycle transitions");

    const reorderedLifecycle = scenarioAudit("failure-quarantine");
    expect(() => assertScenarioAudit({
      ...reorderedLifecycle,
      lifecycleEvents: [...reorderedLifecycle.lifecycleEvents].reverse(),
    }, "failure-quarantine", deposition(), expectedApplications(3), "curator-1", CERTIFICATION))
      .not.toThrow();

    expect(() => reconstructQualityLifecycle([
      ...reorderedLifecycle.lifecycleEvents,
      {
        id: "lifecycle-branch",
        event_type: "quality_evaluated",
        from_projection: { quality_state: "needs_review" },
        to_projection: { quality_state: "quarantined" },
      },
    ])).toThrow("branch from one state");
    expect(() => reconstructQualityLifecycle([
      {
        id: "lifecycle-disconnected",
        event_type: "quality_evaluated",
        from_projection: { quality_state: "needs_review" },
        to_projection: { quality_state: "degraded" },
      },
    ])).toThrow("disconnected");
    expect(() => reconstructQualityLifecycle([
      {
        id: "lifecycle-cycle-1",
        event_type: "quality_evaluated",
        from_projection: { quality_state: "active_unproven" },
        to_projection: { quality_state: "needs_review" },
      },
      {
        id: "lifecycle-cycle-2",
        event_type: "quality_evaluated",
        from_projection: { quality_state: "needs_review" },
        to_projection: { quality_state: "active_unproven" },
      },
    ])).toThrow("contain a cycle");

    const infrastructureFailure = scenarioAudit("failure-quarantine");
    expect(() => assertScenarioAudit({
      ...infrastructureFailure,
      evalJobs: infrastructureFailure.evalJobs.map((job, index) => ({
        ...job,
        error_code: index === 0 ? "VIVADO_LICENSE_UNAVAILABLE" : job.error_code,
      })),
    }, "failure-quarantine", deposition(), expectedApplications(3), "curator-1", CERTIFICATION))
      .toThrow("scenario job operation");

    const timedOutSynthesisEvidence = scenarioAudit("failure-quarantine");
    expect(() => assertScenarioAudit({
      ...timedOutSynthesisEvidence,
      evidenceEntries: timedOutSynthesisEvidence.evidenceEntries.map((entry, index) => index === 0
        ? {
            ...entry,
            content_text: JSON.stringify({
              schema: "synthesize-result.v1",
              passed: false,
              status: "failed",
              exitCode: 1,
              timedOut: true,
            }),
          }
        : entry),
    }, "failure-quarantine", deposition(), expectedApplications(3), "curator-1", CERTIFICATION))
      .toThrow("exact Vivado synthesis result");

    const wrongRef = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongRef,
      evaluations: [{ ...wrongRef.evaluations[0], eval_job_refs: [] }],
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow("exact frozen Vivado job reference");

    const wrongEpoch = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongEpoch,
      connectorObservations: wrongEpoch.connectorObservations.map((observation) => ({
        ...observation,
        ledger_epoch: "unrelated-ledger-epoch",
      })),
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow("outside the certified job binding");

    const wrongDispatch = scenarioAudit("success");
    expect(() => assertScenarioAudit({
      ...wrongDispatch,
      evalJobs: wrongDispatch.evalJobs.map((job) => ({
        ...job,
        dispatch_request_hash: "3".repeat(64),
      })),
    }, "success", deposition(), expectedApplications(1), "curator-1", CERTIFICATION))
      .toThrow(/dispatch\/workspace|dispatch request hash/);

    const noTerminal = scenarioAudit("failure-quarantine");
    expect(() => assertScenarioAudit({
      ...noTerminal,
      connectorObservations: noTerminal.connectorObservations.map((observation) => {
        const terminal = observation.observation as Record<string, unknown>;
        const accepted = {
          schema: "evolution-eval-ledger-query.v1",
          state: "accepted",
          connector_job_id: terminal.connector_job_id,
          connector_idempotency_key: terminal.connector_idempotency_key,
          dispatch_request_hash: terminal.dispatch_request_hash,
          ledger_epoch: terminal.ledger_epoch,
          execution_state: "running",
          accepted_at: "2026-08-28T07:15:00.000Z",
        };
        return {
          ...observation,
          observation_type: "accepted",
          observation: accepted,
          observation_hash: evolutionEvalCanonicalHash(accepted),
        };
      }),
    }, "failure-quarantine", deposition(), expectedApplications(3), "curator-1", CERTIFICATION))
      .toThrow("process-stopped terminal");
  });

  test("runner contains no direct database mutations or direct Connector/Vivado adapter", async () => {
    const source = await readFile(
      new URL("../scripts/run-self-evolution-m4f-e2e.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/u);
    expect(source).not.toContain("../../connector/");
    expect(source).not.toContain("evolutionEvalSubmit");
    expect(source).not.toContain("evolutionEvalReserve");
    expect(source).not.toMatch(/\b(?:Bun\.spawn|child_process|execFile|spawnSync)\b/u);
    expect(source).toContain("BEGIN TRANSACTION READ ONLY");
    expect(source).toContain("CoreTaskEvolutionClient");
    expect(source).toContain("DistillerWorker");
    expect(source).toContain("CuratorWorker");
    expect(source).toContain("EvolutionEvaluator");
  });
});
