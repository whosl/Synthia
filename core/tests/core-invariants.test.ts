import { describe, expect, test } from "bun:test";
import type { ApprovalRecord, ApprovedGateResult, Baseline, ConfigurationSnapshot, GateSubmission, RoleAssignment, ToolRun } from "../src/domain/entities.ts";
import { ConflictError, InvariantError, MemoryRepository } from "../src/memory-repository.ts";

const now = "2026-08-06T00:00:00.000Z";
const snapshot: ConfigurationSnapshot = { id: "snap", projectId: "p", memberRevisionIds: ["rev"], traceRelationIds: ["trace"], gateProfileVersion: "1", toolModelPolicyHash: "policy", manifestHash: "manifest", createdAt: now, createdBy: "human-1" };
const submission: GateSubmission = { id: "sub", projectId: "p", processInstanceId: "proc", gate: "G1", snapshotId: snapshot.id, state: "in_review", submitterId: "human-1", checkResults: {}, issues: [], createdAt: now, submittedAt: now };
const role: RoleAssignment = { id: "role", projectId: "p", actorType: "human", actorId: "human-1", role: "quality", permissions: "{}", assignedAt: now };
const approval: ApprovalRecord = { id: "approval", projectId: "p", gateSubmissionId: submission.id, decision: "approve", approverId: "human-1", approverRole: "quality", authorizationBasis: "role", reason: "passed", issues: [], risks: [], waivers: [], checkResultsHash: "check", signedAt: now, signatureMethod: "test", clientAuditDigest: null, approvedGateResultId: "result", createdAt: now };
const result: ApprovedGateResult = { id: "result", projectId: "p", gate: "G1", gateSubmissionId: submission.id, approvalRecordId: approval.id, snapshotId: snapshot.id, createdAt: now };
const baseline: Baseline = { id: "baseline", projectId: "p", kind: "B0", state: "active", approvedGateResultId: result.id, memberRevisionIds: ["rev"], traceRelationIds: ["trace"], manifestHash: "manifest", approvalRecordId: approval.id, createdAt: now, supersededByBaselineId: null };

function governedRepository(): MemoryRepository {
  const repository = new MemoryRepository();
  repository.save("configurationSnapshot", snapshot);
  repository.save("gateSubmission", submission);
  repository.assignRole(role);
  repository.appendApproval(approval, { actorType: "human", actorId: "human-1" });
  repository.appendApprovedGateResult(result);
  repository.appendBaseline(baseline);
  return repository;
}

function run(overrides: Partial<ToolRun> = {}): ToolRun {
  return { id: "run", projectId: "p", operation: "verify", capabilityVersion: "1", runClass: "formal", state: "submitted", inputSnapshotId: "snap", inputManifestHash: "manifest", authorizationContext: { baselineId: "baseline" }, toolchainProfileHash: "tool", connectorId: null, workerId: null, command: null, parameters: null, returnCode: null, startTime: null, endTime: null, correlationId: "corr", createdAt: now, ...overrides };
}

describe("D1 core invariants", () => {
  test("illegal state overwrite is rejected by table-driven machine", () => {
    const repository = new MemoryRepository();
    repository.save("gateSubmission", { ...submission, state: "preparing" });
    expect(() => repository.save("gateSubmission", { ...submission, state: "approved" })).toThrow();
  });

  test("agent and human without project role cannot approve", () => {
    const repository = new MemoryRepository();
    repository.save("gateSubmission", submission);
    expect(() => repository.appendApproval(approval, { actorType: "agent", actorId: "human-1" })).toThrow(InvariantError);
    expect(() => repository.appendApproval(approval, { actorType: "human", actorId: "human-1" })).toThrow(InvariantError);
  });

  test("baseline rejects wrong gate kind and manifest membership", () => {
    const repository = new MemoryRepository();
    repository.save("configurationSnapshot", snapshot);
    repository.save("gateSubmission", submission);
    repository.assignRole(role);
    repository.appendApproval(approval, { actorType: "human", actorId: "human-1" });
    repository.appendApprovedGateResult(result);
    expect(() => repository.appendBaseline({ ...baseline, kind: "B1" })).toThrow(InvariantError);
    expect(() => repository.appendBaseline({ ...baseline, id: "other", manifestHash: "different" })).toThrow(InvariantError);
  });

  test("formal run requires approved input and candidate cannot be formal", () => {
    expect(() => new MemoryRepository().createToolRun(run({ authorizationContext: { candidateSnapshotId: "snap" } }))).toThrow(InvariantError);
    expect(governedRepository().createToolRun(run())).toEqual(run());
  });

  test("unknown_effect is never automatically retried and success creates no approval", () => {
    const repository = governedRepository();
    repository.createToolRun(run({ state: "unknown_effect" }));
    expect(() => repository.retryToolRun("run", run({ id: "retry" }))).toThrow(InvariantError);
    const successful = governedRepository();
    successful.createToolRun(run({ state: "succeeded" }));
    expect(successful.approvalsFor("sub")).toHaveLength(1);
  });

  test("idempotency is scoped and binds canonical request hash", () => {
    const repository = new MemoryRepository();
    const scope = { actorType: "human" as const, actorId: "h", projectId: "p", operation: "create", key: "k" };
    expect(repository.idempotentScoped(scope, { a: 1, b: 2 }, () => "first")).toBe("first");
    expect(repository.idempotentScoped(scope, { b: 2, a: 1 }, () => "second")).toBe("first");
    expect(() => repository.idempotentScoped(scope, { a: 2 }, () => "bad")).toThrow(ConflictError);
    expect(repository.idempotentScoped({ ...scope, projectId: "other" }, { a: 2 }, () => "other")).toBe("other");
  });
});
