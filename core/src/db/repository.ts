/**
 * Synthia Core — Repository layer
 *
 * CRUD + state-transition-aware updates for domain entities.
 * State transitions validated against state-machines.ts before any DB write (fail-closed).
 * Implements ARC-002 §6 core invariants where enforceable at data layer.
 */

import type { Client } from "pg";
import { artifactRevisionMachine, gateSubmissionMachine, baselineMachine, toolRunMachine, traceRelationMachine } from "../domain/state-machines.ts";
import type { ArtifactRevision, ArtifactRevisionState, Baseline, ConfigurationSnapshot, Evidence, GateSubmission, GateSubmissionState, ToolRun, TraceRelation } from "../domain/entities.ts";

// ── ArtifactRevision ──────────────────────────────────────────────────────────

export async function createRevision(client: Client, rev: ArtifactRevision): Promise<void> {
  await client.query(
    `INSERT INTO artifact_revision
       (id, artifact_id, project_id, version, state, parent_revision_id,
        content_hash, content_location, schema_version, source_ids,
        data_classification, tool_model_provenance, change_reason,
        created_by, created_by_type, review_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [rev.id, rev.artifactId, rev.projectId, rev.version, rev.state,
     rev.parentRevisionId, rev.contentHash, rev.contentLocation, rev.schemaVersion,
     rev.sourceIds, rev.dataClassification, JSON.stringify(rev.toolModelProvenance),
     rev.changeReason, rev.createdBy, rev.createdByType, rev.reviewIds],
  );
}

export async function transitionRevisionState(
  client: Client,
  revisionId: string,
  to: ArtifactRevisionState,
): Promise<void> {
  const { rows } = await client.query<{ state: ArtifactRevisionState }>(
    "SELECT state FROM artifact_revision WHERE id = $1 FOR UPDATE",
    [revisionId],
  );
  if (rows.length === 0) throw new Error(`Revision not found: ${revisionId}`);
  const from = rows[0].state;
  artifactRevisionMachine.assertTransition(from, to);
  await client.query(
    "UPDATE artifact_revision SET state = $1 WHERE id = $2",
    [to, revisionId],
  );
}

// ── ConfigurationSnapshot (immutable once created) ────────────────────────────

export async function createSnapshot(client: Client, snap: ConfigurationSnapshot): Promise<void> {
  await client.query(
    `INSERT INTO configuration_snapshot
       (id, project_id, member_revision_ids, trace_relation_ids,
        gate_profile_version, tool_model_policy_hash, manifest_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [snap.id, snap.projectId, snap.memberRevisionIds, snap.traceRelationIds,
     snap.gateProfileVersion, snap.toolModelPolicyHash, snap.manifestHash, snap.createdBy],
  );
}

export async function getSnapshot(client: Client, id: string): Promise<ConfigurationSnapshot | null> {
  const { rows } = await client.query(
    `SELECT * FROM configuration_snapshot WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, projectId: r.project_id,
    memberRevisionIds: r.member_revision_ids,
    traceRelationIds: r.trace_relation_ids,
    gateProfileVersion: r.gate_profile_version,
    toolModelPolicyHash: r.tool_model_policy_hash,
    manifestHash: r.manifest_hash,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  };
}

// ── GateSubmission ────────────────────────────────────────────────────────────

export async function createSubmission(client: Client, sub: GateSubmission): Promise<void> {
  if (sub.state !== "preparing") throw new Error("Submission must start preparing");
  await client.query(
    `INSERT INTO gate_submission
       (id, project_id, process_instance_id, gate, snapshot_id, state, submitter_id)
     VALUES ($1,$2,$3,$4,$5,'preparing',$6)`,
    [sub.id, sub.projectId, sub.processInstanceId, sub.gate, sub.snapshotId, sub.submitterId],
  );
}

export async function transitionSubmissionState(
  client: Client,
  submissionId: string,
  to: GateSubmissionState,
): Promise<void> {
  const { rows } = await client.query<{ state: GateSubmissionState }>(
    "SELECT state FROM gate_submission WHERE id = $1 FOR UPDATE",
    [submissionId],
  );
  if (rows.length === 0) throw new Error(`Submission not found: ${submissionId}`);
  const from = rows[0].state;
  gateSubmissionMachine.assertTransition(from, to);
  const updated = await client.query("UPDATE gate_submission SET state = $1 WHERE id = $2 AND state = $3", [to, submissionId, from]);
  if ((updated.rowCount ?? 0) !== 1) throw new Error("STATE_TRANSITION_CONFLICT");
}

// ── Baseline ──────────────────────────────────────────────────────────────────

export async function createBaseline(client: Client, bl: Baseline): Promise<void> {
  if (bl.state !== "active") throw new Error(`Baseline must start 'active', got: ${bl.state}`);
  const { rows } = await client.query(
    `SELECT agr.project_id AS result_project, agr.gate, agr.gate_submission_id, agr.approval_record_id, agr.snapshot_id,
            ar.project_id AS approval_project, ar.decision, gs.project_id AS submission_project, gs.gate AS submission_gate,
            gs.snapshot_id AS submission_snapshot, s.project_id AS snapshot_project, s.manifest_hash, s.member_revision_ids, s.trace_relation_ids
       FROM approved_gate_result agr
       JOIN approval_record ar ON ar.id = agr.approval_record_id
       JOIN gate_submission gs ON gs.id = agr.gate_submission_id
       JOIN configuration_snapshot s ON s.id = agr.snapshot_id
      WHERE agr.id = $1 AND agr.project_id = $2 AND agr.approval_record_id = $3 AND ar.gate_submission_id = agr.gate_submission_id
      FOR UPDATE`, [bl.approvedGateResultId, bl.projectId, bl.approvalRecordId]);
  if (rows.length !== 1) throw new Error("BASELINE_LINK_NOT_FOUND");
  const row = rows[0];
  const expectedKind: Record<string, string> = { G1: "B0", G3: "B1", G4: "B2", G7: "B3", G9: "B4" };
  if (row.decision !== "approve" || row.result_project !== bl.projectId || row.approval_project !== bl.projectId || row.submission_project !== bl.projectId || row.snapshot_project !== bl.projectId || row.submission_gate !== row.gate || row.submission_snapshot !== row.snapshot_id || expectedKind[row.gate] !== bl.kind || row.manifest_hash !== bl.manifestHash || JSON.stringify([...row.member_revision_ids].sort()) !== JSON.stringify([...bl.memberRevisionIds].sort()) || JSON.stringify([...row.trace_relation_ids].sort()) !== JSON.stringify([...bl.traceRelationIds].sort())) throw new Error("BASELINE_LINK_MISMATCH");
  await client.query(
    `INSERT INTO baseline (id, project_id, kind, state, approved_gate_result_id, member_revision_ids, trace_relation_ids, manifest_hash, approval_record_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [bl.id, bl.projectId, bl.kind, bl.state, bl.approvedGateResultId, bl.memberRevisionIds, bl.traceRelationIds, bl.manifestHash, bl.approvalRecordId],
  );
}

// ── ToolRun ───────────────────────────────────────────────────────────────────

export async function createToolRun(client: Client, run: ToolRun): Promise<void> {
  if (run.runClass === "formal") {
    const context = run.authorizationContext;
    if (!context || typeof context !== "object" || !("baselineId" in context || "approvedGateResultId" in context) || ("candidateSnapshotId" in context)) throw new Error("FORMAL_RUN_REQUIRES_APPROVED_INPUT");
    const baselineId = "baselineId" in context && typeof context.baselineId === "string" ? context.baselineId : null;
    const resultId = "approvedGateResultId" in context && typeof context.approvedGateResultId === "string" ? context.approvedGateResultId : null;
    const check = await client.query(`SELECT 1 FROM approved_gate_result agr LEFT JOIN baseline b ON b.approved_gate_result_id = agr.id AND b.state = 'active' WHERE agr.id = COALESCE($1, (SELECT approved_gate_result_id FROM baseline WHERE id = $2 AND state = 'active')) AND agr.project_id = $3`, [resultId, baselineId, run.projectId]);
    if (check.rows.length !== 1) throw new Error("FORMAL_RUN_REQUIRES_APPROVED_INPUT");
  }
  if (run.state === "unknown_effect") throw new Error("UNKNOWN_EFFECT_REQUIRES_HUMAN_RESOLUTION");
  await client.query(
    `INSERT INTO tool_run (id, project_id, operation, capability_version, run_class, state, input_snapshot_id, input_manifest_hash, authorization_context, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [run.id, run.projectId, run.operation, run.capabilityVersion, run.runClass, run.state, run.inputSnapshotId, run.inputManifestHash, JSON.stringify(run.authorizationContext), run.correlationId],
  );
}

export async function transitionToolRunState(
  client: Client,
  runId: string,
  to: ToolRun["state"],
): Promise<void> {
  const { rows } = await client.query<{ state: ToolRun["state"] }>(
    "SELECT state FROM tool_run WHERE id = $1 FOR UPDATE",
    [runId],
  );
  if (rows.length === 0) throw new Error(`ToolRun not found: ${runId}`);
  const from = rows[0].state;
  toolRunMachine.assertTransition(from, to);
  const updated = await client.query("UPDATE tool_run SET state = $1 WHERE id = $2 AND state = $3", [to, runId, from]);
  if ((updated.rowCount ?? 0) !== 1) throw new Error("STATE_TRANSITION_CONFLICT");
}

// ── Evidence ──────────────────────────────────────────────────────────────────

export async function registerEvidence(client: Client, ev: Evidence): Promise<void> {
  // Object acceptance protocol step 5: Core registers in metadata transaction (ARC-004 §3)
  await client.query(
    `INSERT INTO evidence
       (id, tool_run_id, project_id, artifact_id, uri, sha256,
        size_bytes, media_type, completeness, orphaned, corrupt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [ev.id, ev.toolRunId, ev.projectId, ev.artifactId, ev.uri, ev.sha256,
     ev.sizeBytes, ev.mediaType, ev.completeness, ev.orphaned, ev.corrupt],
  );
}

// ── TraceRelation ─────────────────────────────────────────────────────────────

export async function createTraceRelation(client: Client, rel: TraceRelation): Promise<void> {
  await client.query(
    `INSERT INTO trace_relation
       (id, project_id, source_type, source_id, target_type, target_id,
        relation_kind, state, basis, data_classification, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [rel.id, rel.projectId, rel.sourceType, rel.sourceId,
     rel.targetType, rel.targetId, rel.relationKind, rel.state,
     rel.basis, rel.dataClassification, rel.createdBy],
  );
}

export async function getForwardTrace(client: Client, projectId: string, sourceId: string): Promise<TraceRelation[]> {
  const { rows } = await client.query(
    `SELECT * FROM trace_relation
     WHERE project_id = $1 AND source_id = $2 AND state IN ('approved','review_required')
     ORDER BY created_at`,
    [projectId, sourceId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string, projectId: r.project_id as string,
    sourceType: r.source_type as string, sourceId: r.source_id as string,
    targetType: r.target_type as string, targetId: r.target_id as string,
    relationKind: r.relation_kind as string, state: r.state as TraceRelation["state"],
    basis: r.basis as string, dataClassification: r.data_classification as TraceRelation["dataClassification"],
    createdBy: r.created_by as string, createdAt: (r.created_at as Date).toISOString(),
  }));
}

export async function getReverseTrace(client: Client, projectId: string, targetId: string): Promise<TraceRelation[]> {
  const { rows } = await client.query(
    `SELECT * FROM trace_relation
     WHERE project_id = $1 AND target_id = $2 AND state IN ('approved','review_required')
     ORDER BY created_at`,
    [projectId, targetId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string, projectId: r.project_id as string,
    sourceType: r.source_type as string, sourceId: r.source_id as string,
    targetType: r.target_type as string, targetId: r.target_id as string,
    relationKind: r.relation_kind as string, state: r.state as TraceRelation["state"],
    basis: r.basis as string, dataClassification: r.data_classification as TraceRelation["dataClassification"],
    createdBy: r.created_by as string, createdAt: (r.created_at as Date).toISOString(),
  }));
}

export interface TransactionClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** Every operation in callback receives the same checked-out client. */
export async function withTransaction<T>(client: TransactionClient, work: (transaction: TransactionClient) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
/** Append an outbox event in a single transaction; advisory lock and sequence allocation share the same transaction. */
export async function appendOutboxEvent(client: TransactionClient, event: OutboxEventInput): Promise<number> {
  return withTransaction(client, async transaction => {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${event.aggregateType}:${event.aggregateId}`]);
    const sequenceResult = await transaction.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM outbox_events WHERE aggregate_type = $1 AND aggregate_id = $2", [event.aggregateType, event.aggregateId]);
    const row = sequenceResult.rows[0];
    if (!row || typeof row !== "object" || !("sequence" in row) || (typeof row.sequence !== "number" && typeof row.sequence !== "string")) throw new Error("OUTBOX_SEQUENCE_ALLOCATION_FAILED");
    const sequence = Number(row.sequence);
    await transaction.query(
      `INSERT INTO outbox_events(event_id, aggregate_type, aggregate_id, sequence, event_type, project_id, payload, headers, correlation_id, causation_id, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [event.eventId, event.aggregateType, event.aggregateId, sequence, event.eventType, event.projectId, JSON.stringify(event.payload), JSON.stringify(event.headers ?? {}), event.correlationId, event.causationId ?? null, event.classification],
    );
    return sequence;
  });
}
