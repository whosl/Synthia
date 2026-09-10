import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../core/src/hashing.ts";
import {
  FORMAL_G4_ALLOWED_OPERATIONS,
  FORMAL_G4_OPERATIONS,
  EvaluatedGateOrchestrator,
  FormalFlowOrchestrator,
  parseDeliveryRelease,
  parseFormalInputApproval,
  parseFormalInputPreview,
  parseFormalJobBinding,
  parseGateEvaluation,
  parseProjectReadinessRecord,
  type BitstreamResultV1,
  type DeliveryReleaseV1,
  type EvaluatedGateSubmissionV1,
  type FormalFlowClient,
  type FormalG4Operation,
  type FormalInputApprovalV1,
  type FormalInputPreviewV1,
  type FormalJobBindingV1,
  type FrozenEvidenceManifestV1,
  type GateEvaluationV1,
  type ProjectReadinessRecordV1,
} from "./formal-flow.ts";
import { CoreGovernanceClient } from "./governance-client.ts";

const digest = (value: string): string => sha256Hex(value);
const NOW = "2026-08-24T00:00:00.000Z";

function rawPreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "formal-input-preview.v1",
    work_version_id: "wv-1",
    snapshot_id: "snap-4",
    readiness_id: "ready-1",
    authorized_task_id: "task-main-1",
    prerequisite_baseline_id: "bl-b1",
    target_part: "xc7k70tfbv676-1",
    toolchain_profile_hash: digest("toolchain"),
    constraints_complete: true,
    purpose: "g4_delivery",
    allowed_operations: [...FORMAL_G4_ALLOWED_OPERATIONS],
    files: [
      { revision_id: "rev-rtl", path: "rtl/top.sv", role: "rtl", sha256: digest("rtl"), size_bytes: 3, storage_uri: `content://sha256/${digest("rtl")}` },
      { revision_id: "rev-tb", path: "tb/top_tb.sv", role: "tb", sha256: digest("tb"), size_bytes: 2, storage_uri: `content://sha256/${digest("tb")}` },
      { revision_id: "rev-xdc", path: "constr/top.xdc", role: "constraint", sha256: digest("xdc"), size_bytes: 3, storage_uri: `content://sha256/${digest("xdc")}` },
    ],
    input_hash: digest("input"),
    preview_hash: digest("preview"),
    ...overrides,
  };
}

function preview(): FormalInputPreviewV1 {
  return parseFormalInputPreview(rawPreview());
}

function approval(id: string): FormalInputApprovalV1 {
  return parseFormalInputApproval({
    ...rawPreview(),
    id,
    confirmed_by: "human-1",
    confirmed_at: NOW,
  });
}

function evaluation(): GateEvaluationV1 {
  return {
    id: "eval-fixed",
    projectId: "p1",
    gateSubmissionId: "sub-g4",
    workVersionId: "wv-1",
    snapshotId: "snap-4",
    snapshotManifestHash: digest("snapshot"),
    profileHash: digest("profile"),
    resultHash: digest("evaluation"),
    passed: true,
    sealedProjectionHash: digest("candidate"),
    deliveryReleaseId: "rel-1",
    deliveryReleaseVersion: 1,
    supersedesReleaseId: null,
    evaluatedAt: NOW,
    items: [{ id: "item-1", checkCode: "formal_input.confirmed", severity: "hard", passed: true, details: {}, evidenceRefs: [] }],
  };
}

class FakeFormalFlowClient implements FormalFlowClient {
  confirmed?: FormalInputApprovalV1;
  readonly submitted: Array<{ operation: FormalG4Operation; approvalId: string; key: string }> = [];
  readonly frozen: string[] = [];
  readonly jobs = new Map<string, FormalJobBindingV1>();
  readonly evidence = new Map<string, FrozenEvidenceManifestV1>();
  evaluation?: GateEvaluationV1;
  pendingOnce?: FormalG4Operation;
  private pendingUsed = false;

  async prepareReadiness(): Promise<ProjectReadinessRecordV1> { throw new Error("unused"); }
  async confirmReadiness(): Promise<ProjectReadinessRecordV1> { throw new Error("unused"); }
  async listReadiness(): Promise<readonly ProjectReadinessRecordV1[]> { return []; }
  async previewFormalInput(): Promise<FormalInputPreviewV1> { return preview(); }
  async confirmFormalInput(): Promise<FormalInputApprovalV1> { throw new Error("human-only in this test"); }
  async getFormalInputApproval(): Promise<FormalInputApprovalV1> {
    if (!this.confirmed) throw { httpStatus: 404 };
    return this.confirmed;
  }
  async submitFormalJob(operation: FormalG4Operation, approvalId: string, key: string): Promise<FormalJobBindingV1> {
    this.submitted.push({ operation, approvalId, key });
    const state = this.pendingOnce === operation && !this.pendingUsed ? "running" : "succeeded";
    if (state === "running") this.pendingUsed = true;
    const job: FormalJobBindingV1 = {
      jobId: `job-${operation}`,
      state,
      operation,
      runClass: "formal",
      formalInputApprovalId: approvalId,
      inputSnapshotId: "snap-4",
      inputHash: digest("input"),
      toolchainProfileHash: digest("toolchain"),
    };
    this.jobs.set(job.jobId, job);
    return job;
  }
  async getFormalJob(jobId: string): Promise<FormalJobBindingV1> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`missing ${jobId}`);
    if (job.state === "running") {
      const succeeded = { ...job, state: "succeeded" as const };
      this.jobs.set(jobId, succeeded);
      return succeeded;
    }
    return job;
  }
  async freezeFormalEvidence(jobId: string): Promise<FrozenEvidenceManifestV1> {
    this.frozen.push(jobId);
    const job = this.jobs.get(jobId)!;
    const evidence: FrozenEvidenceManifestV1 = {
      schema: "evidence-manifest.v1",
      id: `ev-${job.operation}`,
      jobId,
      projectId: "p1",
      runState: "succeeded",
      operation: job.operation,
      runClass: "formal",
      inputHash: digest("input"),
      toolchainProfileHash: digest("toolchain"),
      manifestHash: digest(`evidence:${job.operation}`),
      frozenAt: NOW,
      verdicts: {},
      entries: [{
        name: `${job.operation}.log`, role: "tool_log", sha256: digest(job.operation), sizeBytes: 1,
        mediaType: "text/plain", storageUri: `content://sha256/${digest(job.operation)}`,
        completeness: "full", corrupt: false, verdict: null,
      }],
    };
    this.evidence.set(jobId, evidence);
    return evidence;
  }
  async getFormalEvidence(jobId: string): Promise<FrozenEvidenceManifestV1> {
    const evidence = this.evidence.get(jobId);
    if (!evidence) throw new Error(`missing evidence ${jobId}`);
    return evidence;
  }
  async createGateEvaluation(input: {
    submissionId: string;
    evaluationId: string;
    workVersionId: string;
    expectedSnapshotManifestHash: string;
  }): Promise<GateEvaluationV1> {
    this.evaluation = { ...evaluation(), id: input.evaluationId };
    return this.evaluation;
  }
  async listGateEvaluations(): Promise<readonly GateEvaluationV1[]> { return this.evaluation ? [this.evaluation] : []; }
  async submitEvaluatedGate(input: { submissionId: string; evaluationId: string; resultHash: string }): Promise<EvaluatedGateSubmissionV1> {
    return {
      id: input.submissionId,
      projectId: "p1",
      gate: "G4",
      state: "in_review",
      gateCheckEvaluationId: input.evaluationId,
      checkResultsHash: input.resultHash,
    };
  }
  async listBitstreams(): Promise<readonly BitstreamResultV1[]> { return []; }
  async listDeliveryReleases(): Promise<readonly DeliveryReleaseV1[]> {
    if (!this.evaluation || !this.confirmed) return [];
    return [{
      id: "rel-1", projectId: "p1", version: 1, supersedesReleaseId: null,
      processVersionId: "GJB_REF_V1", processInstanceId: "pi-1", workVersionId: "wv-1",
      gateSubmissionId: "sub-g4", gateCheckEvaluationId: this.evaluation.id,
      candidateManifestHash: this.evaluation.sealedProjectionHash!, approvalRecordId: "approval-1",
      approvedGateResultId: "agr-1", baselineId: "bl-b2", formalInputApprovalId: this.confirmed.id,
      bitstreamResultId: "bit-1", schemaVersion: "delivery-manifest.v1", manifestHash: digest("release"),
      itemCount: 10, state: "sealed", generatedByType: "system", generatedBy: "core",
      generatedAt: NOW, confirmedBy: "human-1", confirmedAt: NOW, createdAt: NOW, releasedAt: NOW,
    }];
  }
}

describe("P4 strict response parsers", () => {
  test("accepts the frozen preview and rejects weakened/extended inputs", () => {
    expect(parseFormalInputPreview(rawPreview()).allowedOperations).toEqual(FORMAL_G4_ALLOWED_OPERATIONS);
    expect(() => parseFormalInputPreview(rawPreview({ constraints_complete: "true" }))).toThrow("boolean");
    expect(() => parseFormalInputPreview(rawPreview({ allowed_operations: ["implement"] }))).toThrow("four-operation");
    expect(() => parseFormalInputPreview({ ...rawPreview(), extra: true })).toThrow("unexpected or missing");
  });

  test("rejects a formal Job response that Core downgraded or misbound", () => {
    const row = {
      jobId: "job-1", state: "queued", operation: "simulate", runClass: "formal",
      formalInputApprovalId: "fia-1", inputSnapshotId: "snap-4", inputHash: digest("input"),
      toolchainProfileHash: digest("toolchain"),
    };
    expect(parseFormalJobBinding(row).runClass).toBe("formal");
    expect(() => parseFormalJobBinding({ ...row, runClass: "exploratory" })).toThrow("must be formal");
    expect(() => parseFormalJobBinding({ ...row, inputHash: "manifest:job-1" })).toThrow("SHA-256");
  });

  test("G0 confirmed ready does not require complete constraints", () => {
    const raw = {
      id: "ready-1", project_id: "p1", process_instance_id: "pi-1", work_version_id: "wv-1",
      status: "confirmed", state: "ready", ready: true, readiness_hash: digest("ready"), result_hash: digest("result"),
      engineering_config: {}, engineering_config_hash: digest("config"), target_part: "unresolved", board_ref: "board-ref",
      workspace_ready: true, data_scope_recorded: true, source_materials_recorded: true,
      pin_constraints_complete: false, electrical_constraints_complete: false, clock_constraints_complete: false,
      constraints_complete: false, constraint_revision_ids: [], toolchain_profile_hash: digest("toolchain"),
      generated_by_type: "system", generated_by: "core", generated_at: NOW,
      confirmed_by: "human-1", confirmed_at: NOW,
      checks: [{ code: "G0_WORKSPACE_READY", severity: "hard", passed: true, details: {} }],
    };
    expect(parseProjectReadinessRecord(raw, "p1").ready).toBe(true);
    expect(parseProjectReadinessRecord(raw, "p1").constraintsComplete).toBe(false);
  });

  test("requires G4 sealed projection and deterministic release facts as one unit", () => {
    const raw = {
      id: "eval-1", project_id: "p1", gate_submission_id: "sub-g4", work_version_id: "wv-1",
      snapshot_id: "snap-4", snapshot_manifest_hash: digest("snapshot"), profile_hash: digest("profile"),
      result_hash: digest("evaluation"), passed: true, sealed_projection_hash: digest("candidate"),
      delivery_release_id: "rel-1", delivery_release_version: 1, supersedes_release_id: null,
      evaluated_at: NOW,
      items: [{ id: "item-1", check_code: "delivery.manifest_sealed", severity: "hard", passed: true, details: {}, evidence_refs: [] }],
    };
    expect(parseGateEvaluation(raw, "p1").deliveryReleaseId).toBe("rel-1");
    expect(() => parseGateEvaluation({ ...raw, delivery_release_id: null }, "p1"))
      .toThrow("projection facts are incomplete");
    expect(() => parseGateEvaluation({ ...raw, work_version_id: "wv-other" }, "p1").workVersionId)
      .not.toThrow();
  });

  test("sealed delivery must retain confirmation and G4 provenance", () => {
    const raw = {
      id: "rel-1", project_id: "p1", version: 1, supersedes_release_id: null,
      process_version_id: "GJB_REF_V1", process_instance_id: "pi-1", work_version_id: "wv-1",
      gate_submission_id: "sub-g4", gate_check_evaluation_id: "eval-1", candidate_manifest_hash: digest("candidate"),
      approval_record_id: "approval-1", approved_gate_result_id: "agr-1", baseline_id: "bl-b2",
      formal_input_approval_id: "fia-1", bitstream_result_id: "bit-1", schema_version: "delivery-manifest.v1",
      manifest_hash: digest("manifest"), item_count: 10, state: "sealed", generated_by_type: "system",
      generated_by: "core", generated_at: NOW, confirmed_by: "human-1", confirmed_at: NOW,
      created_at: NOW, released_at: NOW,
    };
    expect(parseDeliveryRelease(raw, "p1").state).toBe("sealed");
    expect(() => parseDeliveryRelease({ ...raw, confirmed_by: null, confirmed_at: null }, "p1")).toThrow("missing confirmation");
    expect(() => parseDeliveryRelease({ ...raw, state: "released" }, "p1")).toThrow("must be sealed");
  });
});

describe("P4 durable formal orchestrator", () => {
  test("waits for human input confirmation without starting any Job", async () => {
    const client = new FakeFormalFlowClient();
    const orchestrator = new FormalFlowOrchestrator(client);
    const progress = await orchestrator.initialize({
      projectId: "p1", gateSubmissionId: "sub-g4", workVersionId: "wv-1",
      snapshotId: "snap-4", snapshotManifestHash: digest("snapshot"), readinessId: "ready-1",
      profileHash: digest("profile"),
      authorizedTaskId: "task-main-1",
    });
    const result = await orchestrator.advance(progress);
    expect(result.blockedOn).toBe("input_confirmation");
    expect(client.submitted).toHaveLength(0);
    expect(progress.approvalId).toMatch(/^fia-[0-9a-f]{48}$/);
  });

  test("reattaches a persisted Job after restart and never duplicates the operation", async () => {
    const client = new FakeFormalFlowClient();
    client.pendingOnce = "validate_sources";
    const saved: unknown[] = [];
    const orchestrator = new FormalFlowOrchestrator(client, async (progress) => { saved.push(structuredClone(progress)); });
    let progress = await orchestrator.initialize({
      projectId: "p1", gateSubmissionId: "sub-g4", workVersionId: "wv-1",
      snapshotId: "snap-4", snapshotManifestHash: digest("snapshot"), readinessId: "ready-1",
      profileHash: digest("profile"),
      authorizedTaskId: "task-main-1",
    });
    client.confirmed = approval(progress.approvalId);
    let result = await orchestrator.advance(progress);
    expect(result.blockedOn).toBe("job");
    expect(result.progress.jobs.validate_sources?.jobId).toBe("job-validate_sources");
    expect(client.submitted.filter((call) => call.operation === "validate_sources")).toHaveLength(1);

    // New orchestrator instance = Runtime restart. It polls the stored job id.
    progress = structuredClone(result.progress);
    result = await new FormalFlowOrchestrator(client).advance(progress);
    expect(result.blockedOn).toBe("gate_approval");
    expect(client.submitted.map((call) => call.operation)).toEqual([...FORMAL_G4_OPERATIONS]);
    expect(client.submitted.filter((call) => call.operation === "validate_sources")).toHaveLength(1);
    expect(client.frozen).toEqual(FORMAL_G4_OPERATIONS.map((operation) => `job-${operation}`));
    expect(new Set(client.submitted.map((call) => call.approvalId))).toEqual(new Set([progress.approvalId]));
    expect(new Set(client.submitted.map((call) => call.key)).size).toBe(4);
    expect(saved.length).toBeGreaterThan(1);

    const frozenBeforeReplay = [...client.frozen];
    const replay = await new FormalFlowOrchestrator(client).advance(structuredClone(result.progress));
    expect(replay.blockedOn).toBe("gate_approval");
    expect(client.frozen).toEqual(frozenBeforeReplay);
    expect(client.submitted.map((call) => call.operation)).toEqual([...FORMAL_G4_OPERATIONS]);

    const release = await new FormalFlowOrchestrator(client).verifyReleased(result.progress);
    expect(release.gateSubmissionId).toBe("sub-g4");
    expect(release.candidateManifestHash).toBe(result.progress.evaluation?.sealedProjectionHash);

    const listReleases = client.listDeliveryReleases.bind(client);
    client.listDeliveryReleases = async () => (await listReleases()).map((row) => ({
      ...row,
      id: "rel-unrelated",
    }));
    await expect(new FormalFlowOrchestrator(client).verifyReleased(result.progress))
      .rejects.toMatchObject({ code: "DELIVERY_RELEASE_MISSING" });
  });

  test("fails closed when any formal Job response changes the approved input hash", async () => {
    const client = new FakeFormalFlowClient();
    const original = client.submitFormalJob.bind(client);
    client.submitFormalJob = async (operation, approvalId, key) => ({
      ...await original(operation, approvalId, key),
      inputHash: digest("tampered"),
    });
    const orchestrator = new FormalFlowOrchestrator(client);
    const progress = await orchestrator.initialize({
      projectId: "p1", gateSubmissionId: "sub-g4", workVersionId: "wv-1",
      snapshotId: "snap-4", snapshotManifestHash: digest("snapshot"), readinessId: "ready-1",
      profileHash: digest("profile"),
      authorizedTaskId: "task-main-1",
    });
    client.confirmed = approval(progress.approvalId);
    await expect(orchestrator.advance(progress)).rejects.toMatchObject({ code: "FORMAL_JOB_BINDING_MISMATCH" });
  });
});

describe("P4 Core-evaluated G1-G3 orchestration", () => {
  test("persists the intent, evaluates before submit, and resumes without duplicate writes", async () => {
    const client = new FakeFormalFlowClient();
    const calls: string[] = [];
    client.createGateEvaluation = async (input) => {
      calls.push(`evaluate:${input.evaluationId}`);
      return {
        id: input.evaluationId,
        projectId: "p1",
        gateSubmissionId: input.submissionId,
        workVersionId: input.workVersionId,
        snapshotId: "snap-g2",
        snapshotManifestHash: input.expectedSnapshotManifestHash,
        profileHash: digest("profile"),
        resultHash: digest("g2-evaluation"),
        passed: true,
        sealedProjectionHash: null,
        deliveryReleaseId: null,
        deliveryReleaseVersion: null,
        supersedesReleaseId: null,
        evaluatedAt: NOW,
        items: [{ id: "item-g2", checkCode: "snapshot.members_frozen", severity: "hard", passed: true, details: {}, evidenceRefs: [] }],
      };
    };
    client.submitEvaluatedGate = async (input) => {
      calls.push(`submit:${input.evaluationId}`);
      return {
        id: input.submissionId,
        projectId: "p1",
        gate: "G2",
        state: "in_review",
        gateCheckEvaluationId: input.evaluationId,
        checkResultsHash: input.resultHash,
      };
    };
    const saved: unknown[] = [];
    const orchestrator = new EvaluatedGateOrchestrator(client, async (progress) => {
      saved.push(structuredClone(progress));
    });
    let progress = await orchestrator.initialize({
      gate: "G2",
      projectId: "p1",
      submissionId: "sub-g2",
      workVersionId: "wv-1",
      snapshotId: "snap-g2",
      snapshotManifestHash: digest("snapshot-g2"),
      profileHash: digest("profile"),
    });
    expect(calls).toEqual([]);
    progress = await orchestrator.advance(progress);
    expect(calls.map((call) => call.split(":")[0])).toEqual(["evaluate", "submit"]);
    expect(saved).toHaveLength(3);

    await new EvaluatedGateOrchestrator(client).advance(structuredClone(progress));
    expect(calls.map((call) => call.split(":")[0])).toEqual(["evaluate", "submit"]);
  });

  test("rejects snapshot, work-version, and profile drift before evaluated submit", async () => {
    for (const drift of ["snapshot", "work", "profile"] as const) {
      const client = new FakeFormalFlowClient();
      let submits = 0;
      client.createGateEvaluation = async (input) => ({
        id: input.evaluationId,
        projectId: "p1",
        gateSubmissionId: input.submissionId,
        workVersionId: drift === "work" ? "wv-other" : input.workVersionId,
        snapshotId: "snap-g3",
        snapshotManifestHash: drift === "snapshot" ? digest("other-snapshot") : input.expectedSnapshotManifestHash,
        profileHash: drift === "profile" ? digest("other-profile") : digest("profile"),
        resultHash: digest("g3-evaluation"),
        passed: true,
        sealedProjectionHash: null,
        deliveryReleaseId: null,
        deliveryReleaseVersion: null,
        supersedesReleaseId: null,
        evaluatedAt: NOW,
        items: [{ id: "item-g3", checkCode: "snapshot.members_frozen", severity: "hard", passed: true, details: {}, evidenceRefs: [] }],
      });
      client.submitEvaluatedGate = async (input) => {
        submits++;
        return {
          id: input.submissionId,
          projectId: "p1",
          gate: "G3",
          state: "in_review",
          gateCheckEvaluationId: input.evaluationId,
          checkResultsHash: input.resultHash,
        };
      };
      const orchestrator = new EvaluatedGateOrchestrator(client);
      const progress = await orchestrator.initialize({
        gate: "G3",
        projectId: "p1",
        submissionId: "sub-g3",
        workVersionId: "wv-1",
        snapshotId: "snap-g3",
        snapshotManifestHash: digest("snapshot-g3"),
        profileHash: digest("profile"),
      });
      await expect(orchestrator.advance(progress))
        .rejects.toMatchObject({ code: "GATE_EVALUATION_BINDING_MISMATCH" });
      expect(submits).toBe(0);
    }
  });
});

describe("CoreGovernanceClient P4 HTTP contract", () => {
  test("uses frozen routes, minimal formal Job body, and caller-stable idempotency keys", async () => {
    const calls: Array<{ path: string; method: string; key: string | null; authorization: string | null; taskId: string | null; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        key: new Headers(init?.headers).get("Idempotency-Key"),
        authorization: new Headers(init?.headers).get("Authorization"),
        taskId: new Headers(init?.headers).get("X-Synthia-Task-Id"),
        body,
      });
      let data: unknown;
      if (url.pathname.endsWith("/formal-input-approvals/preview")) {
        data = rawPreview();
      } else if (url.pathname.endsWith("/jobs")) {
        data = {
          jobId: "job-simulate", state: "queued", operation: "simulate", runClass: "formal",
          formalInputApprovalId: "fia-1", inputSnapshotId: "snap-4", inputHash: digest("input"),
          toolchainProfileHash: digest("toolchain"),
        };
      } else if (url.pathname.endsWith("/evidence/freeze")) {
        data = {
          schema: "evidence-manifest.v1", id: "ev-sim", jobId: "job-simulate", projectId: "p1",
          runState: "succeeded", operation: "simulate", runClass: "formal", inputHash: digest("input"),
          toolchainProfileHash: digest("toolchain"), manifestHash: digest("evidence"), frozenAt: NOW,
          verdicts: { passed: true }, entries: [{
            name: "simulate.log", role: "tool_log", sha256: digest("log"), sizeBytes: 3,
            mediaType: "text/plain", storageUri: `content://sha256/${digest("log")}`,
            completeness: "full", corrupt: false, verdict: { passed: true },
          }],
        };
      } else if (url.pathname.endsWith("/evaluations")) {
        data = {
          id: "eval-1", project_id: "p1", gate_submission_id: "sub-g4", work_version_id: "wv-1",
          snapshot_id: "snap-4", snapshot_manifest_hash: digest("snapshot"),
          profile_hash: digest("profile"), result_hash: digest("evaluation"), passed: true,
          sealed_projection_hash: digest("candidate"), delivery_release_id: "rel-1",
          delivery_release_version: 1, supersedes_release_id: null, evaluated_at: NOW,
          items: [{ id: "item-1", check_code: "formal_input.confirmed", severity: "hard", passed: true, details: {}, evidence_refs: [] }],
        };
      } else if (url.pathname.endsWith("/gate-submissions/sub-g4/submit")) {
        data = {
          id: "sub-g4", project_id: "p1", gate: "G4", state: "in_review",
          gate_check_evaluation_id: "eval-1", check_results_hash: digest("evaluation"),
        };
      } else {
        return new Response(JSON.stringify({ error: { code: "not_found", message: "missing", retryable: false } }), { status: 404 });
      }
      return new Response(JSON.stringify({ data, meta: { correlation_id: "corr-1" } }), {
        status: url.pathname.endsWith("/jobs") ? 202 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new CoreGovernanceClient({
      baseUrl: "http://core",
      token: "generic-secret",
      taskRuntimeToken: "task-runtime-secret",
      taskId: "task-main-1",
      projectId: "p1",
      fetchImpl,
    });

    await client.previewFormalInput({ workVersionId: "wv-1", snapshotId: "snap-4", readinessId: "ready-1", authorizedTaskId: "task-main-1" });
    await client.submitFormalJob("simulate", "fia-1", "formal-job-fixed");
    await client.freezeFormalEvidence("job-simulate", "formal-evidence-fixed");
    await client.createGateEvaluation({ submissionId: "sub-g4", evaluationId: "eval-1", workVersionId: "wv-1", expectedSnapshotManifestHash: digest("snapshot") });
    await client.submitEvaluatedGate({ submissionId: "sub-g4", evaluationId: "eval-1", resultHash: digest("evaluation") });

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/projects/p1/formal-input-approvals/preview",
      "/api/v1/projects/p1/jobs",
      "/api/v1/projects/p1/jobs/job-simulate/evidence/freeze",
      "/api/v1/projects/p1/gate-submissions/sub-g4/evaluations",
      "/api/v1/projects/p1/gate-submissions/sub-g4/submit",
    ]);
    expect(calls[1]).toMatchObject({
      key: "formal-job-fixed",
      authorization: "Bearer task-runtime-secret",
      taskId: "task-main-1",
      body: { operation: "simulate", run_class_intent: "formal", formal_input_approval_id: "fia-1" },
    });
    expect(Object.keys(calls[1]!.body as Record<string, unknown>).sort()).toEqual([
      "formal_input_approval_id", "operation", "run_class_intent",
    ]);
    expect(calls[2]).toMatchObject({ key: "formal-evidence-fixed", body: {} });
    expect(calls[0]!.authorization).toBe("Bearer generic-secret");
    expect(calls[2]!.authorization).toBe("Bearer generic-secret");
    expect(calls[3]!.authorization).toBe("Bearer generic-secret");
    expect(calls[4]!.authorization).toBe("Bearer generic-secret");
    expect(calls[3]!.body).toEqual({
      evaluation_id: "eval-1",
      work_version_id: "wv-1",
      expected_snapshot_manifest_hash: digest("snapshot"),
    });
    expect(calls[4]!.body).toEqual({
      gate_check_evaluation_id: "eval-1",
      check_results_hash: digest("evaluation"),
    });
  });

  test("fails closed before formal submit when the dedicated task token is absent", async () => {
    let calls = 0;
    const client = new CoreGovernanceClient({
      baseUrl: "http://core",
      token: "generic-secret",
      projectId: "p1",
      fetchImpl: (async () => {
        calls++;
        throw new Error("must not call Core");
      }) as typeof fetch,
    });
    await expect(client.submitFormalJob("simulate", "fia-1", "formal-job-fixed"))
      .rejects.toMatchObject({ code: "TASK_RUNTIME_TOKEN_REQUIRED" });
    expect(calls).toBe(0);
  });

  test("fails closed before formal submit when the Core-issued task id is absent", async () => {
    let calls = 0;
    const client = new CoreGovernanceClient({
      baseUrl: "http://core",
      token: "generic-secret",
      taskRuntimeToken: "task-runtime-secret",
      projectId: "p1",
      fetchImpl: (async () => {
        calls++;
        throw new Error("must not call Core");
      }) as typeof fetch,
    });
    await expect(client.submitFormalJob("simulate", "fia-1", "formal-job-fixed"))
      .rejects.toMatchObject({ code: "TASK_RUNTIME_TASK_ID_REQUIRED" });
    expect(calls).toBe(0);
  });
});
