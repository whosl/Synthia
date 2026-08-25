import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../core/src/hashing.ts";
import { GJB_REF_V1_PROFILE } from "../core/src/services/process-profile.ts";
import { CounterScriptedModel } from "./deps.ts";
import {
  FORMAL_G4_ALLOWED_OPERATIONS,
  FORMAL_G4_OPERATIONS,
  parseFormalInputApproval,
  parseFormalInputPreview,
  type DeliveryReleaseV1,
  type EvaluatedGateSubmissionV1,
  type FormalG4Operation,
  type FormalInputApprovalV1,
  type FormalInputPreviewV1,
  type FormalJobBindingV1,
  type FrozenEvidenceManifestV1,
  type GateEvaluationV1,
  type ProjectReadinessRecordV1,
} from "./formal-flow.ts";
import { MockGovernanceClient } from "./governance-client.ts";
import { FakeVivadoConnector, LoopExecutor, successBehavior } from "./loop.ts";
import type { AgentState, ProcessStateV1 } from "./types.ts";

const hash = (value: string): string => sha256Hex(value);
const NOW = "2026-08-24T00:00:00.000Z";

class P4Governance extends MockGovernanceClient {
  confirmed?: FormalInputApprovalV1;
  readonly formalSubmits: FormalG4Operation[] = [];
  readonly frozenJobs: string[] = [];
  readonly evidenceByJob = new Map<string, FrozenEvidenceManifestV1>();
  releaseListCalls = 0;
  evaluation?: GateEvaluationV1;
  gateState: "in_review" | "approved" = "in_review";

  constructor(readonly currentGate: "G1" | "G2" | "G3" | "G4" = "G4") {
    super();
  }

  override async getProcessState(projectId: string): Promise<ProcessStateV1> {
    return {
      schema: "process-state.v1", projectId, processInstanceId: "pi-1", workVersionId: "wv-1", profileId: "GJB_REF_V1",
      profileHash: GJB_REF_V1_PROFILE.profileHash, currentGate: this.currentGate,
      completed: this.currentGate === "G4" && this.gateState === "approved",
      readiness: {
        id: "ready-1", status: "confirmed", ready: true, readinessHash: hash("ready"),
        targetPart: "xc7k70tfbv676-1", boardRef: "board-kc705-v1", workspaceReady: true,
        dataScopeRecorded: true, sourceMaterialsRecorded: true, pinConstraintsComplete: true,
        electricalConstraintsComplete: true, clockConstraintsComplete: true, constraintsComplete: true,
        toolchainProfileHash: hash("toolchain"), constraintRevisionIds: ["rev-xdc"],
        generatedBy: { type: "system", id: "core" }, confirmedBy: { id: "human-1", at: NOW },
      },
    };
  }

  async listReadiness(): Promise<readonly ProjectReadinessRecordV1[]> {
    return [{
      id: "ready-1", projectId: "p1", processInstanceId: "pi-1", workVersionId: "wv-1",
      status: "confirmed", state: "ready", ready: true, readinessHash: hash("ready"), resultHash: hash("result"),
      engineeringConfig: {}, engineeringConfigHash: hash("config"), targetPart: "xc7k70tfbv676-1",
      boardRef: "board-kc705-v1", workspaceReady: true, dataScopeRecorded: true, sourceMaterialsRecorded: true,
      pinConstraintsComplete: true, electricalConstraintsComplete: true, clockConstraintsComplete: true,
      constraintsComplete: true, constraintRevisionIds: ["rev-xdc"], toolchainProfileHash: hash("toolchain"),
      generatedByType: "system", generatedBy: "core", generatedAt: NOW, confirmedBy: "human-1",
      confirmedAt: NOW, checks: [{ code: "G0_WORKSPACE_READY", severity: "hard", passed: true, details: {} }],
    }];
  }

  async previewFormalInput(input: { workVersionId: string; snapshotId: string; readinessId: string; authorizedTaskId: string }): Promise<FormalInputPreviewV1> {
    const revisions = this.registeredArtifacts.filter((artifact) => ["RTL_SOURCE_SET", "TB_SOURCE_SET", "XDC_CANDIDATE"].includes(artifact.artifactType));
    return parseFormalInputPreview({
      schema: "formal-input-preview.v1", work_version_id: input.workVersionId, snapshot_id: input.snapshotId,
      readiness_id: input.readinessId, authorized_task_id: input.authorizedTaskId,
      prerequisite_baseline_id: "bl-b1", target_part: "xc7k70tfbv676-1",
      toolchain_profile_hash: hash("toolchain"), constraints_complete: true, purpose: "g4_delivery",
      allowed_operations: [...FORMAL_G4_ALLOWED_OPERATIONS],
      files: revisions.map((revision) => ({
        revision_id: revision.revisionId,
        path: revision.contentLocation,
        role: revision.artifactType === "RTL_SOURCE_SET" ? "rtl" : revision.artifactType === "TB_SOURCE_SET" ? "tb" : "constraint",
        sha256: revision.contentHash,
        size_bytes: 1,
        storage_uri: `content://sha256/${revision.contentHash}`,
      })),
      input_hash: hash("formal-input"), preview_hash: hash("formal-preview"),
    });
  }

  async getFormalInputApproval(id: string): Promise<FormalInputApprovalV1> {
    if (!this.confirmed) throw { httpStatus: 404 };
    expect(this.confirmed.id).toBe(id);
    return this.confirmed;
  }

  async submitFormalJob(operation: FormalG4Operation, approvalId: string): Promise<FormalJobBindingV1> {
    this.formalSubmits.push(operation);
    return this.job(operation, approvalId);
  }

  async getFormalJob(jobId: string): Promise<FormalJobBindingV1> {
    const operation = jobId.slice("formal-job-".length) as FormalG4Operation;
    return this.job(operation, this.confirmed!.id);
  }

  private job(operation: FormalG4Operation, approvalId: string): FormalJobBindingV1 {
    return {
      jobId: `formal-job-${operation}`, state: "succeeded", operation, runClass: "formal",
      formalInputApprovalId: approvalId, inputSnapshotId: this.confirmed!.snapshotId,
      inputHash: this.confirmed!.inputHash, toolchainProfileHash: this.confirmed!.toolchainProfileHash,
    };
  }

  async freezeFormalEvidence(jobId: string): Promise<FrozenEvidenceManifestV1> {
    this.frozenJobs.push(jobId);
    const operation = jobId.slice("formal-job-".length) as FormalG4Operation;
    const evidence: FrozenEvidenceManifestV1 = {
      schema: "evidence-manifest.v1", id: `evidence-${operation}`, jobId, projectId: "p1",
      runState: "succeeded", operation, runClass: "formal", inputHash: this.confirmed!.inputHash,
      toolchainProfileHash: this.confirmed!.toolchainProfileHash, manifestHash: hash(`evidence:${operation}`),
      frozenAt: NOW, verdicts: {}, entries: [{
        name: `${operation}.log`, role: "tool_log", sha256: hash(operation), sizeBytes: 1,
        mediaType: "text/plain", storageUri: `content://sha256/${hash(operation)}`,
        completeness: "full", corrupt: false, verdict: null,
      }],
    };
    this.evidenceByJob.set(jobId, evidence);
    return evidence;
  }

  async getFormalEvidence(jobId: string): Promise<FrozenEvidenceManifestV1> {
    const evidence = this.evidenceByJob.get(jobId);
    if (!evidence) throw new Error(`missing evidence ${jobId}`);
    return evidence;
  }

  async createGateEvaluation(input: {
    submissionId: string;
    evaluationId: string;
    workVersionId: string;
    expectedSnapshotManifestHash: string;
  }): Promise<GateEvaluationV1> {
    this.evaluation = {
      id: input.evaluationId, projectId: "p1", gateSubmissionId: input.submissionId,
      workVersionId: "wv-1", snapshotId: this.confirmed!.snapshotId,
      snapshotManifestHash: this.snapshots.at(-1)!.manifestHash,
      profileHash: GJB_REF_V1_PROFILE.profileHash,
      resultHash: hash("evaluation"), passed: true, sealedProjectionHash: hash("candidate"), evaluatedAt: NOW,
      deliveryReleaseId: "rel-1", deliveryReleaseVersion: 1, supersedesReleaseId: null,
      items: [{ id: "item-1", checkCode: "delivery.manifest_sealed", severity: "hard", passed: true, details: {}, evidenceRefs: [] }],
    };
    return this.evaluation;
  }

  async submitEvaluatedGate(input: { submissionId: string; evaluationId: string; resultHash: string }): Promise<EvaluatedGateSubmissionV1> {
    this.gateStates.set(input.submissionId, "in_review");
    return { id: input.submissionId, projectId: "p1", gate: "G4", state: "in_review", gateCheckEvaluationId: input.evaluationId, checkResultsHash: input.resultHash };
  }

  override async getGateSubmissionState(): Promise<{ state: "in_review" | "approved" }> {
    return { state: this.gateState };
  }

  async listDeliveryReleases(): Promise<readonly DeliveryReleaseV1[]> {
    this.releaseListCalls++;
    if (this.gateState !== "approved" || !this.evaluation || !this.confirmed) return [];
    return [{
      id: "rel-1", projectId: "p1", version: 1, supersedesReleaseId: null,
      processVersionId: "GJB_REF_V1", processInstanceId: "pi-1", workVersionId: "wv-1",
      gateSubmissionId: this.evaluation.gateSubmissionId, gateCheckEvaluationId: this.evaluation.id,
      candidateManifestHash: this.evaluation.sealedProjectionHash!, approvalRecordId: "approval-1",
      approvedGateResultId: "agr-1", baselineId: "bl-b2", formalInputApprovalId: this.confirmed.id,
      bitstreamResultId: "bit-1", schemaVersion: "delivery-manifest.v1", manifestHash: hash("release"),
      itemCount: 10, state: "sealed", generatedByType: "system", generatedBy: "core",
      generatedAt: NOW, confirmedBy: "human-1", confirmedAt: NOW, createdAt: NOW, releasedAt: NOW,
    }];
  }
}

class P4EarlyGateGovernance extends P4Governance {
  readonly evaluationCalls: Array<{
    submissionId: string;
    evaluationId: string;
    workVersionId: string;
    expectedSnapshotManifestHash: string;
  }> = [];
  readonly evaluatedSubmits: string[] = [];
  legacySubmitCalls = 0;

  override async submitGate(): Promise<{ state: "in_review" }> {
    this.legacySubmitCalls++;
    return { state: "in_review" };
  }

  override async createGateEvaluation(input: {
    submissionId: string;
    evaluationId: string;
    workVersionId: string;
    expectedSnapshotManifestHash: string;
  }): Promise<GateEvaluationV1> {
    this.evaluationCalls.push(input);
    const submission = this.submissions.find((row) => row.submissionId === input.submissionId)!;
    return {
      id: input.evaluationId,
      projectId: "p1",
      gateSubmissionId: input.submissionId,
      workVersionId: input.workVersionId,
      snapshotId: submission.snapshotId,
      snapshotManifestHash: input.expectedSnapshotManifestHash,
      profileHash: GJB_REF_V1_PROFILE.profileHash,
      resultHash: hash(`evaluation:${submission.gate}`),
      passed: true,
      sealedProjectionHash: null,
      deliveryReleaseId: null,
      deliveryReleaseVersion: null,
      supersedesReleaseId: null,
      evaluatedAt: NOW,
      items: [{ id: `item-${submission.gate}`, checkCode: "snapshot.members_frozen", severity: "hard", passed: true, details: {}, evidenceRefs: [] }],
    };
  }

  override async submitEvaluatedGate(input: {
    submissionId: string;
    evaluationId: string;
    resultHash: string;
  }): Promise<EvaluatedGateSubmissionV1> {
    this.evaluatedSubmits.push(input.evaluationId);
    const submission = this.submissions.find((row) => row.submissionId === input.submissionId)!;
    this.gateStates.set(input.submissionId, "in_review");
    return {
      id: input.submissionId,
      projectId: "p1",
      gate: submission.gate as "G1" | "G2" | "G3",
      state: "in_review",
      gateCheckEvaluationId: input.evaluationId,
      checkResultsHash: input.resultHash,
    };
  }
}

function initialState(): AgentState {
  return {
    agentId: "task-main-1", taskId: "task-main-1", taskKind: "main", task: "计数器",
    part: "xc7k70tfbv676-1", projectId: "p1", projectType: "engineering",
    processVersionId: "GJB_REF_V1", processProfileId: "GJB_REF_V1",
    processProfileName: "GJB 参考流程 v1", processProfileVersion: "GJB_REF_V1",
    executionMode: "engineering", processInstanceId: "pi-1", createdAt: NOW, updatedAt: NOW,
    currentStage: "intake", status: "running", docs: {}, gateSubmissions: {}, gateDecisions: {},
  };
}

function loop(gov: P4Governance, connector: FakeVivadoConnector, stateSink: (state: AgentState) => void): LoopExecutor {
  return new LoopExecutor({
    model: new CounterScriptedModel(), connector, governance: gov,
    skillPrompts: { rtl: "", tb: "", xdc: "", repair: "", intake: "", behaviorWave: "", architecture: "", registerSpec: "" },
    part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1", toolModelPolicyHash: hash("policy"),
    onStateChange: async (state) => stateSink(structuredClone(state)),
  });
}

describe("LoopExecutor P4 formal G4 integration", () => {
  test("fails before model, Connector, or Core writes when the modern policy hash is malformed", async () => {
    const gov = new P4Governance("G1");
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    let saved = initialState();
    const executor = new LoopExecutor({
      model: new CounterScriptedModel(), connector, governance: gov,
      skillPrompts: { rtl: "", tb: "", xdc: "", repair: "", intake: "", behaviorWave: "", architecture: "", registerSpec: "" },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "synthia-policy-v1",
      onStateChange: async (state) => { saved = structuredClone(state); },
    });
    const result = await executor.run("计数器", { agentId: saved.agentId, agentState: saved });
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("64-character lowercase SHA-256");
    expect(gov.registeredArtifacts).toHaveLength(0);
    expect(gov.snapshots).toHaveLength(0);
    expect(connector.callCount("validate_sources")).toBe(0);
  });

  test("routes modern G1-G3 through Core evaluation before review and never calls legacy submit", async () => {
    for (const gate of ["G1", "G2", "G3"] as const) {
      const gov = new P4EarlyGateGovernance(gate);
      const connector = new FakeVivadoConnector({ behavior: successBehavior() });
      let saved = initialState();
      const result = await loop(gov, connector, (state) => { saved = state; }).run("计数器", {
        agentId: saved.agentId,
        agentState: saved,
      });
      expect(result.awaitingGate).toBe(gate);
      expect(gov.evaluationCalls).toHaveLength(1);
      expect(gov.evaluatedSubmits).toEqual([gov.evaluationCalls[0]!.evaluationId]);
      expect(gov.legacySubmitCalls).toBe(0);
      expect(gov.evaluationCalls[0]).toMatchObject({
        workVersionId: "wv-1",
        expectedSnapshotManifestHash: gov.snapshots[0]!.manifestHash,
      });
      expect(saved.evaluatedGateFlows?.[gate]?.submitted?.state).toBe("in_review");
    }
  });

  test("persists preview, resumes four same-input formal jobs, evaluates, and verifies release", async () => {
    const gov = new P4Governance();
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    let saved = initialState();

    const first = await loop(gov, connector, (state) => { saved = state; }).run("计数器", {
      agentId: saved.agentId,
      agentState: saved,
    });
    expect(first.awaitingGate).toBe("G4");
    expect(saved.formalFlow?.status).toBe("awaiting_input_confirmation");
    expect(gov.formalSubmits).toHaveLength(0);
    expect(gov.snapshots).toHaveLength(1);
    const snapshotTypes = gov.snapshots[0]!.memberRevisionIds.map((revisionId) =>
      gov.registeredArtifacts.find((artifact) => artifact.revisionId === revisionId)!.artifactType);
    expect(snapshotTypes).toEqual(["RTL_SOURCE_SET", "TB_SOURCE_SET", "XDC_CANDIDATE"]);

    const formal = saved.formalFlow!;
    gov.confirmed = parseFormalInputApproval({
      schema: formal.preview.schema, work_version_id: formal.preview.workVersionId,
      snapshot_id: formal.preview.snapshotId, readiness_id: formal.preview.readinessId,
      authorized_task_id: formal.preview.authorizedTaskId,
      prerequisite_baseline_id: formal.preview.prerequisiteBaselineId, target_part: formal.preview.targetPart,
      toolchain_profile_hash: formal.preview.toolchainProfileHash, constraints_complete: formal.preview.constraintsComplete,
      purpose: formal.preview.purpose, allowed_operations: [...formal.preview.allowedOperations],
      files: formal.preview.files.map((file) => ({ revision_id: file.revisionId, path: file.path, role: file.role, sha256: file.sha256, size_bytes: file.sizeBytes, storage_uri: file.storageUri })),
      input_hash: formal.preview.inputHash, preview_hash: formal.preview.previewHash,
      id: formal.approvalId, confirmed_by: "human-1", confirmed_at: NOW,
    });

    const second = await loop(gov, connector, (state) => { saved = state; }).resume(saved);
    expect(second.endedReason).toContain("G4");
    expect(second.awaitingGate).toBe("G4");
    expect(saved.formalFlow?.status).toBe("awaiting_gate_approval");
    expect(gov.formalSubmits).toEqual([...FORMAL_G4_OPERATIONS]);
    expect(gov.frozenJobs).toEqual(FORMAL_G4_OPERATIONS.map((operation) => `formal-job-${operation}`));

    gov.gateState = "approved";
    const third = await loop(gov, connector, (state) => { saved = state; }).resume(saved);
    expect(third.status).toBe("succeeded");
    expect(third.endedReason).toContain("already completed");
    expect(gov.releaseListCalls).toBe(1);
    // Candidate exploratory calls ran once; formal calls went exclusively through Core.
    expect(connector.callCount("implement")).toBe(1);
  });
});
