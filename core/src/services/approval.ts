/**
 * Synthia Core — Gate approval vertical slice (PostgreSQL)
 *
 * Atomic approve-gate use case: within ONE checked-out transaction client it
 *   1. claims an idempotency slot (replay / conflict-detection),
 *   2. authorizes a natural human via an active project RoleAssignment,
 *   3. validates Submission / Snapshot / approval-content consistency,
 *   4. appends an ApprovalRecord (append-only, approved_gate_result_id pre-set),
 *   5. creates an ApprovedGateResult,
 *   6. selectively creates the correct Baseline for milestone gates (G1/G3/G4/G7/G9),
 *   7. transitions the GateSubmission to 'approved',
 *   8. appends a monotonic Outbox event,
 *   9. marks the idempotency slot completed with the cached response.
 *
 * Failure at any step rolls back the whole transaction — no half-approval.
 * Revocation is intentionally NOT part of this slice; approvals are append-only
 * and a revocation would be a new approval/decision event, never an UPDATE.
 */

import { randomUUID } from "node:crypto";
import { sha256Hex } from "../hashing.ts";
import type { DataClassification, GateId } from "../domain/enums.ts";
import { GATE_TO_BASELINE, isMilestoneGate } from "../domain/enums.ts";
import type { ApproverActor, IdempotencyScope } from "../domain/entities.ts";
import { gateSubmissionMachine } from "../domain/state-machines.ts";
import { ConflictError, InvariantError } from "../memory-repository.ts";
import {
  appendApprovalRecord,
  appendOutboxEventInTx,
  claimIdempotencySlot,
  completeIdempotencySlot,
  createApprovedGateResult,
  findRoleAssignment,
  lockConfigurationSnapshot,
  lockGateSubmission,
  type TransactionClient,
} from "../db/repository.ts";

// ── Public input / output types ───────────────────────────────────────────────

export interface ApproveGateSubmissionInput {
  readonly projectId: string;
  readonly gateSubmissionId: string;
  readonly configurationSnapshotId: string;
  readonly approver: ApproverActor;
  readonly approvalContent: {
    readonly decision: "approve";
    readonly approverRole: string;
    readonly authorizationBasis: string;
    readonly reason: string;
    readonly issues: readonly string[];
    readonly risks: readonly string[];
    readonly waivers: readonly string[];
    readonly checkResultsHash: string;
    readonly signedAt: string;
    readonly signatureMethod: string;
    readonly clientAuditDigest: string | null;
  };
  /** Caller-provided IDs for the new approved_gate_result (and baseline when applicable). */
  readonly approvedGateResultId: string;
  /**
   * Baseline ID. MUST be non-null for milestone gates G1/G3/G4/G7/G9 and null
   * for all other gates (G0/G2/G5/G6/G8 create no baseline).
   */
  readonly baselineId: string | null;
  readonly idempotency: IdempotencyScope;
  /** Canonical sha256 hex of the request payload; differing hash = stable conflict. */
  readonly requestHash: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly classification: DataClassification;
}

export interface ApproveGateSubmissionResult {
  readonly approvalRecordId: string;
  readonly approvedGateResultId: string;
  readonly baselineId: string | null;
  readonly outboxSequence: number;
}

const APPROVE_GATE_OPERATION = "approve_gate";

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Approve a gate submission atomically. `client` must be a live, checked-out
 * transaction client (the caller is responsible for BEGIN/COMMIT — this function
 * performs NO transaction control so all writes share the same transaction).
 *
 * On idempotent replay (same scope + same requestHash) the original result is
 * returned with no new writes. On same-key-different-hash a ConflictError is
 * thrown. Every failure path throws before any committed state mutation.
 */
export async function approveGateSubmission(
  client: TransactionClient,
  input: ApproveGateSubmissionInput,
): Promise<ApproveGateSubmissionResult> {
  validateInputShape(input);

  // 1. Authorize: only a natural human with an active project RoleAssignment may approve.
  if (input.approver.actorType !== "human") {
    throw new InvariantError("APPROVAL_AUTHORIZATION_DENIED");
  }
  if (input.idempotency.actorType !== "human") {
    throw new InvariantError("APPROVAL_AUTHORIZATION_DENIED");
  }
  if (input.approver.actorId !== input.idempotency.actorId) {
    throw new InvariantError("APPROVAL_AUTHORIZATION_DENIED");
  }
  if (input.idempotency.projectId !== input.projectId) {
    throw new InvariantError("APPROVAL_AUTHORIZATION_DENIED");
  }
  if (input.idempotency.operation !== APPROVE_GATE_OPERATION) {
    throw new InvariantError("APPROVAL_AUTHORIZATION_DENIED");
  }

  const role = await findRoleAssignment(
    client,
    input.projectId,
    "human",
    input.approver.actorId,
    input.approvalContent.approverRole,
  );
  if (!role) {
    throw new InvariantError("APPROVAL_AUTHORIZATION_DENIED");
  }

  // 2. Idempotency claim (after auth, so unauthorized replays still fail-closed first).
  const claim = await claimIdempotencySlot(client, input.idempotency, input.requestHash);
  if (!claim.owned) {
    if (!claim.existing) {
      throw new InvariantError("IDEMPOTENCY_UNEXPECTED_STATE");
    }
    if (claim.existing.requestHash !== input.requestHash) {
      throw new ConflictError("IDEMPOTENCY_CONFLICT");
    }
    if (claim.existing.status !== "completed") {
      throw new InvariantError("IDEMPOTENCY_UNEXPECTED_STATE");
    }
    return decodeIdempotencyResponse(claim.existing.response);
  }

  // From here every throw must surface a clear, stable code; the transaction rolls back.
  const result = await performApproval(client, input);

  await completeIdempotencySlot(client, input.idempotency, input.requestHash, result);

  return result;
}

// ── Internal: the actual approval work ───────────────────────────────────────

async function performApproval(
  client: TransactionClient,
  input: ApproveGateSubmissionInput,
): Promise<ApproveGateSubmissionResult> {
  // 3. Lock + read submission and snapshot for consistency validation.
  const submission = await lockGateSubmission(client, input.gateSubmissionId);
  if (!submission) throw new InvariantError("GATE_SUBMISSION_NOT_FOUND");

  if (submission.projectId !== input.projectId) {
    throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  }

  const snapshot = await lockConfigurationSnapshot(client, input.configurationSnapshotId);
  if (!snapshot) throw new InvariantError("CONFIGURATION_SNAPSHOT_NOT_FOUND");

  if (snapshot.projectId !== input.projectId) {
    throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  }

  // Cross-link: submission.snapshotId must equal the submitted configuration snapshot.
  if (submission.snapshotId !== input.configurationSnapshotId) {
    throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  }

  // Submission must be in a reviewable state.
  if (!gateSubmissionMachine.canTransition(submission.state as never, "approved" as never)) {
    throw new InvariantError("GATE_SUBMISSION_NOT_REVIEWABLE");
  }

  const gate = submission.gate as GateId;

  // Baseline presence rules: milestone gates require a baseline, others forbid one.
  const milestone = isMilestoneGate(gate);
  if (milestone && input.baselineId == null) {
    throw new InvariantError("BASELINE_REQUIRED_FOR_MILESTONE");
  }
  if (!milestone && input.baselineId != null) {
    throw new InvariantError("BASELINE_FORBIDDEN_FOR_NON_MILESTONE");
  }

  // 4. Append ApprovalRecord (approved_gate_result_id pre-set → approved_gate_result follows).
  await appendApprovalRecord(client, {
    id: approvalRecordId(input),
    projectId: input.projectId,
    gateSubmissionId: input.gateSubmissionId,
    decision: input.approvalContent.decision,
    approverId: input.approver.actorId,
    approverRole: input.approvalContent.approverRole,
    authorizationBasis: input.approvalContent.authorizationBasis,
    reason: input.approvalContent.reason,
    issues: [...input.approvalContent.issues],
    risks: [...input.approvalContent.risks],
    waivers: [...input.approvalContent.waivers],
    checkResultsHash: input.approvalContent.checkResultsHash,
    signedAt: input.approvalContent.signedAt,
    signatureMethod: input.approvalContent.signatureMethod,
    clientAuditDigest: input.approvalContent.clientAuditDigest,
    approvedGateResultId: input.approvedGateResultId,
  });

  // 5. Create ApprovedGateResult.
  await createApprovedGateResult(client, {
    id: input.approvedGateResultId,
    projectId: input.projectId,
    gate,
    gateSubmissionId: input.gateSubmissionId,
    approvalRecordId: approvalRecordId(input),
    snapshotId: input.configurationSnapshotId,
  });

  // 6. Selectively create Baseline for milestone gates.
  if (milestone && input.baselineId != null) {
    const kind = GATE_TO_BASELINE[gate];
    if (!kind) throw new InvariantError("BASELINE_GATE_KIND_MISMATCH");
    await createBaselineLinked(client, {
      id: input.baselineId,
      projectId: input.projectId,
      kind,
      state: "active",
      approvedGateResultId: input.approvedGateResultId,
      memberRevisionIds: [...snapshot.memberRevisionIds],
      traceRelationIds: [...snapshot.traceRelationIds],
      manifestHash: snapshot.manifestHash,
      approvalRecordId: approvalRecordId(input),
    });
  }

  // 7. Transition submission → approved (FOR UPDATE already holds the row lock).
  await transitionSubmissionToApproved(client, input.gateSubmissionId, submission.state);

  // 8. Append monotonic Outbox event on the SAME transaction client.
  const outboxSequence = await appendOutboxEventInTx(client, {
    aggregateType: "approved_gate_result",
    aggregateId: input.approvedGateResultId,
    eventId: outboxEventId(),
    eventType: "gate.approved",
    projectId: input.projectId,
    payload: approvalEventPayload(input, gate, milestone ? input.baselineId : null),
    correlationId: input.correlationId,
    causationId: input.causationId,
    classification: input.classification,
  });

  return {
    approvalRecordId: approvalRecordId(input),
    approvedGateResultId: input.approvedGateResultId,
    baselineId: milestone ? input.baselineId : null,
    outboxSequence,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function approvalRecordId(input: ApproveGateSubmissionInput): string {
  // Derived deterministically from requestHash + gateSubmissionId so that:
  //  - replays of the SAME logical op (same key + submission + hash) get the same ID, and
  //  - different submissions with identical payload templates no longer collide on PK.
  const digest = sha256Hex(`${input.requestHash}:${input.gateSubmissionId}`);
  return `apr_${digest.slice(0, 32)}`;
}

function outboxEventId(): string {
  // outbox_events.event_id is uuid; idempotent replay is prevented upstream so a
  // fresh UUID per logical insert is safe and never duplicated.
  return randomUUID();
}

function approvalEventPayload(
  input: ApproveGateSubmissionInput,
  gate: GateId,
  baselineId: string | null,
): unknown {
  return {
    gate,
    projectId: input.projectId,
    gateSubmissionId: input.gateSubmissionId,
    configurationSnapshotId: input.configurationSnapshotId,
    approvalRecordId: approvalRecordId(input),
    approvedGateResultId: input.approvedGateResultId,
    baselineId,
    approver: input.approver,
    approverRole: input.approvalContent.approverRole,
    decision: input.approvalContent.decision,
    signedAt: input.approvalContent.signedAt,
    checkResultsHash: input.approvalContent.checkResultsHash,
  };
}

async function transitionSubmissionToApproved(
  client: TransactionClient,
  submissionId: string,
  expectedFrom: string,
): Promise<void> {
  // The row was locked FOR UPDATE in lockGateSubmission; assertTransition already
  // validated the transition. Use a guarded conditional UPDATE so a concurrent
  // state mutation between read and write is caught rather than silently clobbered.
  gateSubmissionMachine.assertTransition(expectedFrom as never, "approved" as never);
  const updated = await client.query(
    "UPDATE gate_submission SET state = 'approved' WHERE id = $1 AND state = $2",
    [submissionId, expectedFrom],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new InvariantError("STATE_TRANSITION_CONFLICT");
  }
}

interface BaselineLink {
  id: string;
  projectId: string;
  kind: string;
  state: "active";
  approvedGateResultId: string;
  memberRevisionIds: string[];
  traceRelationIds: string[];
  manifestHash: string;
  approvalRecordId: string;
}

/**
 * Create a baseline that is fully cross-linked to its approved_gate_result,
 * approval_record, gate_submission and configuration_snapshot. All four must
 * agree on projectId, gate→kind mapping, snapshot membership and manifest hash.
 * Mirrors the invariants enforced by MemoryRepository.appendBaseline and the
 * existing createBaseline, but operates on a transaction client and throws
 * InvariantError with stable codes for auditability.
 */
async function createBaselineLinked(
  client: TransactionClient,
  bl: BaselineLink,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT agr.project_id AS result_project, agr.gate, agr.gate_submission_id,
            agr.approval_record_id, agr.snapshot_id,
            ar.project_id AS approval_project, ar.decision, ar.gate_submission_id AS approval_submission,
            gs.project_id AS submission_project, gs.gate AS submission_gate, gs.snapshot_id AS submission_snapshot,
            s.project_id AS snapshot_project, s.manifest_hash, s.member_revision_ids, s.trace_relation_ids
       FROM approved_gate_result agr
       JOIN approval_record ar ON ar.id = agr.approval_record_id
       JOIN gate_submission gs ON gs.id = agr.gate_submission_id
       JOIN configuration_snapshot s ON s.id = agr.snapshot_id
      WHERE agr.id = $1 AND agr.project_id = $2 AND agr.approval_record_id = $3
      FOR UPDATE`,
    [bl.approvedGateResultId, bl.projectId, bl.approvalRecordId],
  );
  if (rows.length !== 1) throw new InvariantError("BASELINE_LINK_NOT_FOUND");
  const row = rows[0] as Record<string, unknown>;

  const gate = row.gate as string;
  const expectedKind = GATE_TO_BASELINE[gate];
  if (!expectedKind || expectedKind !== bl.kind) {
    throw new InvariantError("BASELINE_GATE_KIND_MISMATCH");
  }

  if (row.decision !== "approve") throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.result_project !== bl.projectId) throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.approval_project !== bl.projectId) throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.submission_project !== bl.projectId) throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.snapshot_project !== bl.projectId) throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.approval_submission !== row.gate_submission_id) throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.submission_gate !== gate) throw new InvariantError("BASELINE_LINK_MISMATCH");
  if (row.submission_snapshot !== row.snapshot_id) throw new InvariantError("BASELINE_LINK_MISMATCH");

  const dbManifest = row.manifest_hash as string;
  const dbMembers = row.member_revision_ids as string[];
  const dbTraces = row.trace_relation_ids as string[];
  if (dbManifest !== bl.manifestHash) throw new InvariantError("BASELINE_MANIFEST_MISMATCH");
  if (!sameSet(dbMembers, bl.memberRevisionIds)) throw new InvariantError("BASELINE_MANIFEST_MISMATCH");
  if (!sameSet(dbTraces, bl.traceRelationIds)) throw new InvariantError("BASELINE_MANIFEST_MISMATCH");

  await client.query(
    `INSERT INTO baseline
       (id, project_id, kind, state, approved_gate_result_id, member_revision_ids,
        trace_relation_ids, manifest_hash, approval_record_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [bl.id, bl.projectId, bl.kind, bl.state, bl.approvedGateResultId,
     bl.memberRevisionIds, bl.traceRelationIds, bl.manifestHash, bl.approvalRecordId],
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, i) => value === [...right].sort()[i]);
}

/** Normalize a cached idempotency response for replay.
 *  node:pg parses jsonb to objects, but some drivers (e.g. Bun.sql) return a JSON
 *  string. Parse defensively so replay always yields the original result object. */
function decodeIdempotencyResponse(response: unknown): ApproveGateSubmissionResult {
  if (typeof response === "string") {
    try {
      return JSON.parse(response) as ApproveGateSubmissionResult;
    } catch {
      throw new InvariantError("IDEMPOTENCY_UNEXPECTED_STATE");
    }
  }
  return response as ApproveGateSubmissionResult;
}

function validateInputShape(input: ApproveGateSubmissionInput): void {
  if (!input.projectId) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  if (!input.gateSubmissionId) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  if (!input.configurationSnapshotId) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  if (input.approvalContent.decision !== "approve") {
    throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  }
  if (!input.approvalContent.checkResultsHash) {
    throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
    throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  }
  if (!input.approvedGateResultId) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  if (!input.correlationId) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  if (!input.approvalContent.signedAt) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
  if (!input.approvalContent.signatureMethod) throw new InvariantError("APPROVAL_PAYLOAD_MISMATCH");
}
