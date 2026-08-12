/**
 * Core API 端点函数（路径与字段严格按 Contract）。
 */

import type { ApiClient } from "./client.ts";
import type {
  Artifact,
  ArtifactRevision,
  Baseline,
  GateSubmission,
  GateSubmissionDetail,
  OutboxEvent,
  Project,
  RevisionContent,
} from "./types.ts";

const V1 = "/api/v1";

export function listProjects(client: ApiClient): Promise<Project[]> {
  return client<Project[]>(`${V1}/projects`);
}

export function listGateSubmissions(client: ApiClient, projectId: string, state?: string): Promise<GateSubmission[]> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  return client<GateSubmission[]>(`${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions${query}`);
}

export function getGateSubmission(client: ApiClient, projectId: string, subId: string): Promise<GateSubmissionDetail> {
  return client<GateSubmissionDetail>(
    `${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(subId)}`,
  );
}

export function listBaselines(client: ApiClient, projectId: string): Promise<Baseline[]> {
  return client<Baseline[]>(`${V1}/projects/${encodeURIComponent(projectId)}/baselines`);
}

export function listEvents(client: ApiClient, projectId: string, filter?: { aggregateType?: string; aggregateId?: string }): Promise<OutboxEvent[]> {
  const params = new URLSearchParams();
  if (filter?.aggregateType) params.set("aggregate_type", filter.aggregateType);
  if (filter?.aggregateId) params.set("aggregate_id", filter.aggregateId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return client<OutboxEvent[]>(`${V1}/projects/${encodeURIComponent(projectId)}/events${query}`);
}

export function listArtifacts(client: ApiClient, projectId: string): Promise<Artifact[]> {
  return client<Artifact[]>(`${V1}/projects/${encodeURIComponent(projectId)}/artifacts`);
}

export function listRevisions(client: ApiClient, projectId: string, artifactId: string): Promise<ArtifactRevision[]> {
  return client<ArtifactRevision[]>(
    `${V1}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/revisions`,
  );
}

export function getRevisionContent(client: ApiClient, projectId: string, artifactId: string, revId: string): Promise<RevisionContent> {
  return client<RevisionContent>(
    `${V1}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revId)}/content`,
  );
}

export interface ApproveRequest {
  readonly configuration_snapshot_id: string;
  readonly approved_gate_result_id: string;
  readonly approver_role: string;
  readonly check_results_hash: string;
  readonly signed_at: string;
  readonly signature_method: string;
  readonly reason?: string;
  readonly baseline_id: string | null;
}

/** 批准（里程碑门必须带 baseline_id；写操作必须带 Idempotency-Key）。 */
export function approveGateSubmission(client: ApiClient, projectId: string, subId: string, body: ApproveRequest, idempotencyKey: string): Promise<unknown> {
  return client(`${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(subId)}/approve`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** 驳回（reason 必填非空；非 in_review 服务端返回 409）。 */
export function rejectGateSubmission(client: ApiClient, projectId: string, subId: string, reason: string, idempotencyKey: string): Promise<unknown> {
  return client(`${V1}/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(subId)}/reject`, {
    method: "POST",
    body: { reason },
    headers: { "idempotency-key": idempotencyKey },
  });
}
