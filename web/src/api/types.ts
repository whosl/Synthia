/**
 * Synthia Core API 契约类型（字段与 Contract 一致，不得私改）。
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly data_classification: string;
  readonly created_at: string;
}

export interface GateSubmission {
  readonly id: string;
  readonly gate: string;
  readonly state: string;
  readonly snapshot_id: string;
  readonly process_instance_id: string;
  readonly submitter_id: string;
  readonly submitted_at: string | null;
  readonly created_at: string;
}

/** GET /projects/:id/gate-submissions/:subId 返回的完整提交（含检查结果与问题）。 */
export interface GateSubmissionDetail extends GateSubmission {
  readonly project_id: string;
  readonly check_results: unknown;
  readonly issues: readonly string[];
}

export interface Baseline {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly state: string;
  readonly approved_gate_result_id: string;
  readonly member_revision_ids: readonly string[];
  readonly created_at: string;
  readonly superseded_by_baseline_id: string | null;
}

export interface OutboxEvent {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly payload: unknown;
  readonly correlation_id: string;
  readonly classification: string;
  readonly occurred_at: string;
}

export interface Artifact {
  readonly id: string;
  readonly artifact_type: string;
  readonly created_at: string;
}

export interface ArtifactRevision {
  readonly id: string;
  readonly version: number;
  readonly state: string;
  readonly content_hash: string;
  readonly content_location: string;
  readonly title?: string | null;
  readonly created_at: string;
}

export interface RevisionContent {
  readonly content: string;
  readonly content_hash: string;
}

/** snapshot.created 事件 payload（解析快照成员修订）。 */
export interface SnapshotCreatedPayload {
  readonly id: string;
  readonly projectId: string;
  readonly manifestHash: string;
  readonly memberRevisionIds: readonly string[];
}
