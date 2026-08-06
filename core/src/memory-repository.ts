import type {
  ApprovalRecord,
  ApprovedGateResult,
  ArtifactRevision,
  Baseline,
  ConfigurationSnapshot,
  Evidence,
  GateSubmission,
  Project,
  RoleAssignment,
  ToolRun,
  TraceRelation,
} from "./domain/entities.ts";
import type { ActorType } from "./domain/enums.ts";
import { GATE_TO_BASELINE } from "./domain/enums.ts";
import {
  artifactRevisionMachine,
  baselineMachine,
  gateSubmissionMachine,
  toolRunMachine,
  traceRelationMachine,
} from "./domain/state-machines.ts";
import { canonicalRequestHash } from "./hashing.ts";

export type CoreEntity = Project | ArtifactRevision | ConfigurationSnapshot | GateSubmission | ApprovalRecord | ApprovedGateResult | Baseline | ToolRun | Evidence | TraceRelation;
export class ConflictError extends Error { constructor(message: string) { super(message); this.name = "ConflictError"; } }
export class InvariantError extends Error { constructor(message: string) { super(message); this.name = "InvariantError"; } }

export interface ApprovalActor { actorType: ActorType; actorId: string }
export interface IdempotencyScope extends ApprovalActor { projectId: string; operation: string; key: string }
interface IdempotencyRecord { hash: string; value: unknown }

const entityMachine: Record<string, { assertTransition(from: never, to: never): void } | undefined> = {
  artifactRevision: artifactRevisionMachine,
  gateSubmission: gateSubmissionMachine,
  baseline: baselineMachine,
  toolRun: toolRunMachine,
  traceRelation: traceRelationMachine,
};

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, i) => value === [...right].sort()[i]);
}

export class MemoryRepository {
  private readonly tables = new Map<string, Map<string, CoreEntity>>();
  private readonly approvals: ApprovalRecord[] = [];
  private readonly baselines: Baseline[] = [];
  private readonly roles: RoleAssignment[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  private table(type: string): Map<string, CoreEntity> {
    let table = this.tables.get(type);
    if (!table) { table = new Map(); this.tables.set(type, table); }
    return table;
  }

  save<T extends CoreEntity>(type: string, entity: T, expectedVersion?: number): T {
    if (type === "approval" || type === "approvalRecord" || type === "baseline") {
      throw new InvariantError("APPEND_ONLY_ENTITY_REQUIRES_APPEND_API");
    }
    const table = this.table(type);
    const current = table.get(entity.id) as (T & { version?: number; state?: string }) | undefined;
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) throw new ConflictError("OPTIMISTIC_VERSION_CONFLICT");
    if (current?.state !== undefined && "state" in entity && current.state !== entity.state) {
      const machine = entityMachine[type];
      if (!machine) throw new InvariantError("STATE_MACHINE_NOT_REGISTERED");
      machine.assertTransition(current.state as never, entity.state as never);
    }
    const stored = structuredClone(entity) as T & { version?: number };
    if (current && "version" in stored && "version" in current) stored.version = (current.version ?? 0) + 1;
    table.set(entity.id, stored);
    return structuredClone(stored);
  }

  get<T extends CoreEntity>(type: string, id: string): T | null {
    const value = this.table(type).get(id);
    return value ? structuredClone(value as T) : null;
  }
  list<T extends CoreEntity>(type: string): T[] { return [...this.table(type).values()].map(value => structuredClone(value as T)); }

  assignRole(assignment: RoleAssignment): RoleAssignment {
    this.roles.push(structuredClone(assignment));
    return structuredClone(assignment);
  }

  appendApproval(record: ApprovalRecord, actor?: ApprovalActor): ApprovalRecord {
    if (!actor || actor.actorType !== "human" || actor.actorId !== record.approverId) throw new InvariantError("HUMAN_APPROVER_REQUIRED");
    const submission = this.get<GateSubmission>("gateSubmission", record.gateSubmissionId);
    if (!submission || submission.projectId !== record.projectId) throw new InvariantError("APPROVAL_SUBMISSION_MISMATCH");
    const validRole = this.roles.some(role => role.projectId === record.projectId && role.actorType === "human" && role.actorId === actor.actorId && role.role === record.approverRole);
    if (!validRole) throw new InvariantError("VALID_ROLE_ASSIGNMENT_REQUIRED");
    if (this.approvals.some(item => item.id === record.id)) throw new ConflictError("APPROVAL_APPEND_CONFLICT");
    this.approvals.push(structuredClone(record));
    return structuredClone(record);
  }

  appendApprovedGateResult(result: ApprovedGateResult): ApprovedGateResult {
    const approval = this.approvals.find(item => item.id === result.approvalRecordId);
    const submission = this.get<GateSubmission>("gateSubmission", result.gateSubmissionId);
    if (!approval || approval.decision !== "approve" || approval.gateSubmissionId !== result.gateSubmissionId || approval.projectId !== result.projectId) throw new InvariantError("APPROVED_RESULT_REQUIRES_APPROVAL");
    if (!submission || submission.projectId !== result.projectId || submission.gate !== result.gate || submission.snapshotId !== result.snapshotId) throw new InvariantError("APPROVED_RESULT_LINK_MISMATCH");
    if (this.get<ApprovedGateResult>("approvedGateResult", result.id)) throw new ConflictError("APPROVED_RESULT_APPEND_CONFLICT");
    const stored = structuredClone(result);
    this.table("approvedGateResult").set(result.id, stored);
    return structuredClone(stored);
  }

  appendBaseline(baseline: Baseline): Baseline {
    if (baseline.state !== "active") throw new InvariantError("BASELINE_MUST_START_ACTIVE");
    const result = this.get<ApprovedGateResult>("approvedGateResult", baseline.approvedGateResultId);
    const approval = this.approvals.find(item => item.id === baseline.approvalRecordId);
    const submission = result && this.get<GateSubmission>("gateSubmission", result.gateSubmissionId);
    const snapshot = result && this.get<ConfigurationSnapshot>("configurationSnapshot", result.snapshotId);
    if (!result || !approval || !submission || !snapshot) throw new InvariantError("BASELINE_LINK_NOT_FOUND");
    if (result.projectId !== baseline.projectId || approval.projectId !== baseline.projectId || submission.projectId !== baseline.projectId || snapshot.projectId !== baseline.projectId) throw new InvariantError("BASELINE_PROJECT_MISMATCH");
    if (result.approvalRecordId !== approval.id || result.gateSubmissionId !== submission.id || approval.gateSubmissionId !== submission.id || result.snapshotId !== snapshot.id || submission.snapshotId !== snapshot.id) throw new InvariantError("BASELINE_LINK_MISMATCH");
    if (GATE_TO_BASELINE[result.gate] !== baseline.kind) throw new InvariantError("BASELINE_GATE_KIND_MISMATCH");
    if (baseline.manifestHash !== snapshot.manifestHash || !sameSet(baseline.memberRevisionIds, snapshot.memberRevisionIds) || !sameSet(baseline.traceRelationIds, snapshot.traceRelationIds)) throw new InvariantError("BASELINE_MANIFEST_MISMATCH");
    if (this.baselines.some(item => item.id === baseline.id)) throw new ConflictError("BASELINE_APPEND_CONFLICT");
    this.baselines.push(structuredClone(baseline));
    return structuredClone(baseline);
  }

  createToolRun(run: ToolRun): ToolRun {
    if (run.runClass === "formal") {
      const context = run.authorizationContext as { baselineId?: string; approvedGateResultId?: string };
      const baseline = context.baselineId ? this.baselines.find(item => item.id === context.baselineId) : undefined;
      const result = context.approvedGateResultId ? this.get<ApprovedGateResult>("approvedGateResult", context.approvedGateResultId) : baseline ? this.get<ApprovedGateResult>("approvedGateResult", baseline.approvedGateResultId) : null;
      if (!result || result.projectId !== run.projectId || (baseline && (baseline.projectId !== run.projectId || baseline.state !== "active"))) throw new InvariantError("FORMAL_RUN_REQUIRES_APPROVED_INPUT");
      if (!baseline && !context.approvedGateResultId) throw new InvariantError("FORMAL_RUN_REQUIRES_APPROVED_INPUT");
    }
    return this.save("toolRun", run);
  }

  retryToolRun(runId: string, replacement: ToolRun): ToolRun {
    const previous = this.get<ToolRun>("toolRun", runId);
    if (!previous) throw new InvariantError("TOOL_RUN_NOT_FOUND");
    if (previous.state === "unknown_effect") throw new InvariantError("UNKNOWN_EFFECT_REQUIRES_HUMAN_RESOLUTION");
    return this.createToolRun(replacement);
  }

  approvalsFor(submissionId: string): ApprovalRecord[] { return this.approvals.filter(item => item.gateSubmissionId === submissionId).map(structuredClone); }
  baselinesFor(projectId: string): Baseline[] { return this.baselines.filter(item => item.projectId === projectId).map(structuredClone); }

  idempotent<T>(key: string, action: () => T): T {
    return this.idempotentScoped({ actorType: "system", actorId: "legacy", projectId: "legacy", operation: "legacy", key }, null, action);
  }

  idempotentScoped<T>(scope: IdempotencyScope, payload: unknown, action: () => T): T {
    const key = [scope.actorType, scope.actorId, scope.projectId, scope.operation, scope.key].join("\u001f");
    const hash = canonicalRequestHash(payload);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.hash !== hash) throw new ConflictError("IDEMPOTENCY_PAYLOAD_CONFLICT");
      return structuredClone(existing.value as T);
    }
    const value = action();
    this.idempotency.set(key, { hash, value: structuredClone(value) });
    return value;
  }
}
