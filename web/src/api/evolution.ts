/**
 * Self-evolution v1 API consumer.
 *
 * This module intentionally stays separate from api/index.ts and api/types.ts: the
 * evolution contract is independently versioned and the Web only talks to Core.
 */
import type { ApiClient } from "./client.ts";
import {
  parseCuratorRun,
  parseEvolutionOverview,
  parseLearnedSkillDetail,
  parseLearnedSkillList,
  parseLearnedSkillSummary,
  parseLearnedSkillVersion,
  parseSkillApplicationDetail,
  parseSkillApplicationList,
} from "../domain/evolution.ts";

const V1 = "/api/v1";

export type QualityState =
  | "active_unproven"
  | "active_observed"
  | "needs_review"
  | "degraded"
  | "quarantined";

export type AvailabilityState = "available" | "archived";
export type MeasurementState = "unknown" | "observed";
export type EvaluationOutcome =
  | "success"
  | "applicability_failure"
  | "execution_failure"
  | "inconclusive";

export interface SkillMetricsV1 {
  readonly measurement_state: MeasurementState;
  readonly primary_applied: number;
  readonly evaluated: number;
  readonly pending: number;
  readonly inconclusive: number;
  readonly success: number;
  readonly applicability_failure: number;
  readonly execution_failure: number;
  readonly success_rate: number | null;
  readonly median_duration_ms: number | null;
  readonly human_corrections: number | null;
  readonly first_solved_problem_families: number | null;
}

export interface LearnedSkillSummaryV1 {
  readonly schema: "learned-skill-summary.v1";
  readonly skill_id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly applicability_summary: string;
  readonly active_version_id: string | null;
  readonly active_version_no: number | null;
  readonly quality_state: QualityState | null;
  readonly freshness_state: "current" | "stale";
  readonly availability_state: AvailabilityState;
  readonly enabled: boolean;
  readonly pinned: boolean;
  readonly recommended: boolean;
  readonly control_revision: number;
  readonly last_used_at: string | null;
  readonly metrics: SkillMetricsV1;
}

export interface EvolutionOverviewV1 {
  readonly schema: "evolution-overview.v1";
  readonly rollout_enabled: boolean;
  readonly learning_paused: boolean;
  readonly learned_skills_enabled: boolean;
  readonly settings_revision: number;
  readonly skill_counts: Readonly<Record<QualityState | "archived" | "disabled", number>>;
  readonly pending_applications: number;
  readonly curator: {
    readonly last_run_at: string | null;
    readonly next_eligible_at: string | null;
    readonly pending_evaluations: number;
    readonly schedule_days: 7;
    readonly idle_hours: 2;
    readonly max_vivado_jobs: 3;
    readonly max_duration_minutes: 120;
  };
}

export interface LearnedSkillListV1 {
  readonly schema: "learned-skill-list.v1";
  readonly items: readonly LearnedSkillSummaryV1[];
  readonly next_cursor: string | null;
}

export interface LearnedSkillVersionSummaryV1 {
  readonly version_id: string;
  readonly version_no: number;
  readonly parent_version_id: string | null;
  readonly quality_state: QualityState;
  readonly content_manifest_hash: string;
  readonly created_at: string;
}

export interface LearnedSkillDetailV1 extends LearnedSkillSummaryV1 {
  readonly versions: readonly LearnedSkillVersionSummaryV1[];
  readonly source_summary: {
    readonly distillation_run_id: string;
    readonly source_count: number;
    readonly visible_source_count: number;
  };
}

export interface LearnedSkillFileV1 {
  readonly path: string;
  readonly kind: string;
  readonly language: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly content: string;
}

export interface LearnedSkillVersionV1 {
  readonly schema: "learned-skill-version.v1";
  readonly skill: LearnedSkillSummaryV1;
  readonly version: {
    readonly version_id: string;
    readonly version_no: number;
    readonly parent_version_id: string | null;
    readonly quality_state: QualityState;
    readonly description: string;
    readonly applicability: unknown;
    readonly outcome_contract: unknown;
    readonly content_manifest_hash: string;
    readonly created_at: string;
    readonly files: readonly LearnedSkillFileV1[];
    readonly scan: {
      readonly scanner_version: string;
      readonly decision: string;
      readonly findings: readonly unknown[];
    };
  };
}

export type SkillApplicationState =
  | "open"
  | "closed_pending_episode"
  | "pending_evaluation"
  | "evaluated";

export interface SkillApplicationListItemV1 {
  readonly application_id: string;
  readonly project_ref: string | "redacted";
  readonly task_ref: string | "redacted";
  readonly local_goal: string;
  readonly state: SkillApplicationState;
  readonly started_at: string;
  readonly closed_at: string | null;
  readonly duration_ms: number | null;
  readonly human_corrections: number | null;
  readonly outcome_claim: string | null;
  readonly skills: readonly {
    readonly version_id: string;
    readonly role: "primary" | "supporting";
  }[];
  readonly current_evaluation: {
    readonly evaluation_id: string;
    readonly outcome: EvaluationOutcome;
    readonly confidence: number;
    readonly created_at: string;
  } | null;
}

export interface SkillApplicationListV1 {
  readonly schema: "skill-application-list.v1";
  readonly items: readonly SkillApplicationListItemV1[];
  readonly next_cursor: string | null;
}

export interface SkillApplicationEvaluationV1 {
  readonly evaluation_id: string;
  readonly outcome: EvaluationOutcome;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence_summary: {
    readonly visible: number;
    readonly redacted: number;
    readonly hashes: readonly string[];
  };
  readonly supersedes_id: string | null;
  readonly evaluator_type: "curator" | "human";
  readonly evaluator_version: string;
  readonly created_at: string;
}

export interface SkillApplicationDetailV1 {
  readonly schema: "skill-application-detail.v1";
  readonly application_id: string;
  readonly project_ref: string | "redacted";
  readonly task_ref: string | "redacted";
  readonly observation_key: string;
  readonly episode_ref: string | null | "redacted";
  readonly local_goal: string;
  readonly state: SkillApplicationState;
  readonly started_at: string;
  readonly closed_at: string | null;
  readonly duration_ms: number | null;
  readonly human_corrections: number | null;
  readonly outcome_claim: string | null;
  readonly skills: readonly {
    readonly skill_id: string;
    readonly version_id: string;
    readonly role: "primary" | "supporting";
    readonly reason_codes: readonly string[];
  }[];
  readonly evidence_summary: {
    readonly visible: number;
    readonly redacted: number;
    readonly refs: readonly { readonly type: string; readonly id: string; readonly hash: string }[];
  };
  readonly evaluations: readonly SkillApplicationEvaluationV1[];
}

export interface UpdateEvolutionSettingsRequestV1 {
  readonly learning_paused: boolean;
  readonly learned_skills_enabled: boolean;
  readonly expected_revision: number;
  readonly reason: string;
}

export interface SkillControlRequestV1 {
  readonly expected_control_revision: number;
  readonly reason: string;
}

export type LearnedSkillControlAction =
  | "pin"
  | "unpin"
  | "disable"
  | "enable"
  | "archive"
  | "restore";

export interface CreateCuratorRunRequestV1 {
  readonly mode: "run" | "dry_run";
  readonly reason: string;
  readonly manual_key: string;
}

export interface CuratorRunV1 {
  readonly schema: "curator-run.v1";
  readonly curator_run_id: string;
  readonly state: "queued" | "dry_run_complete";
  readonly mode: "run" | "dry_run";
  readonly created_at: string;
}

export interface LearnedSkillListQuery {
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SkillApplicationListQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

function pageQuery(query: LearnedSkillListQuery | SkillApplicationListQuery = {}): string {
  const params = new URLSearchParams();
  if ("status" in query && query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function getEvolutionOverview(client: ApiClient): Promise<EvolutionOverviewV1> {
  return client<unknown>(`${V1}/evolution/overview`).then(parseEvolutionOverview);
}

export function listLearnedSkills(
  client: ApiClient,
  query: LearnedSkillListQuery = {},
): Promise<LearnedSkillListV1> {
  return client<unknown>(`${V1}/learned-skills${pageQuery(query)}`).then(parseLearnedSkillList);
}

export function getLearnedSkill(client: ApiClient, skillId: string): Promise<LearnedSkillDetailV1> {
  return client<unknown>(`${V1}/learned-skills/${encodeURIComponent(skillId)}`).then(parseLearnedSkillDetail);
}

export function getLearnedSkillVersion(
  client: ApiClient,
  skillId: string,
  versionId: string,
): Promise<LearnedSkillVersionV1> {
  return client<unknown>(
    `${V1}/learned-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}`,
  ).then(parseLearnedSkillVersion);
}

export function listSkillApplications(
  client: ApiClient,
  skillId: string,
  query: SkillApplicationListQuery = {},
): Promise<SkillApplicationListV1> {
  return client<unknown>(
    `${V1}/learned-skills/${encodeURIComponent(skillId)}/applications${pageQuery(query)}`,
  ).then(parseSkillApplicationList);
}

export function getSkillApplication(
  client: ApiClient,
  applicationId: string,
): Promise<SkillApplicationDetailV1> {
  return client<unknown>(
    `${V1}/skill-applications/${encodeURIComponent(applicationId)}`,
  ).then(parseSkillApplicationDetail);
}

export function updateEvolutionSettings(
  client: ApiClient,
  body: UpdateEvolutionSettingsRequestV1,
  idempotencyKey: string,
): Promise<EvolutionOverviewV1> {
  return client<unknown>(`${V1}/evolution/settings`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  }).then(parseEvolutionOverview);
}

export function createCuratorRun(
  client: ApiClient,
  body: CreateCuratorRunRequestV1,
  idempotencyKey: string,
): Promise<CuratorRunV1> {
  return client<unknown>(`${V1}/evolution/curator-runs`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  }).then(parseCuratorRun);
}

function controlLearnedSkill(
  client: ApiClient,
  skillId: string,
  action: LearnedSkillControlAction,
  body: SkillControlRequestV1,
  idempotencyKey: string,
): Promise<LearnedSkillSummaryV1> {
  return client<unknown>(`${V1}/learned-skills/${encodeURIComponent(skillId)}/${action}`, {
    method: "POST",
    body,
    headers: { "idempotency-key": idempotencyKey },
  }).then(parseLearnedSkillSummary);
}

export function setLearnedSkillEnabled(
  client: ApiClient,
  skillId: string,
  enabled: boolean,
  body: SkillControlRequestV1,
  idempotencyKey: string,
): Promise<LearnedSkillSummaryV1> {
  return controlLearnedSkill(client, skillId, enabled ? "enable" : "disable", body, idempotencyKey);
}

export function setLearnedSkillPinned(
  client: ApiClient,
  skillId: string,
  pinned: boolean,
  body: SkillControlRequestV1,
  idempotencyKey: string,
): Promise<LearnedSkillSummaryV1> {
  return controlLearnedSkill(client, skillId, pinned ? "pin" : "unpin", body, idempotencyKey);
}

export function setLearnedSkillArchived(
  client: ApiClient,
  skillId: string,
  archived: boolean,
  body: SkillControlRequestV1,
  idempotencyKey: string,
): Promise<LearnedSkillSummaryV1> {
  return controlLearnedSkill(client, skillId, archived ? "archive" : "restore", body, idempotencyKey);
}
