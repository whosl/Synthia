import type {
  CuratorRunV1,
  EvaluationOutcome,
  EvolutionOverviewV1,
  LearnedSkillDetailV1,
  LearnedSkillFileV1,
  LearnedSkillListV1,
  LearnedSkillSummaryV1,
  LearnedSkillVersionSummaryV1,
  LearnedSkillVersionV1,
  MeasurementState,
  QualityState,
  SkillApplicationDetailV1,
  SkillApplicationEvaluationV1,
  SkillApplicationListItemV1,
  SkillApplicationListV1,
  SkillApplicationState,
  SkillMetricsV1,
  LearnedSkillControlAction,
} from "../api/evolution.ts";

export class EvolutionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionContractError";
  }
}

const QUALITY_STATES = new Set<QualityState>([
  "active_unproven",
  "active_observed",
  "needs_review",
  "degraded",
  "quarantined",
]);
const MEASUREMENT_STATES = new Set<MeasurementState>(["unknown", "observed"]);
const EVALUATION_OUTCOMES = new Set<EvaluationOutcome>([
  "success",
  "applicability_failure",
  "execution_failure",
  "inconclusive",
]);
const APPLICATION_STATES = new Set<SkillApplicationState>([
  "open",
  "closed_pending_episode",
  "pending_evaluation",
  "evaluated",
]);
const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvolutionContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvolutionContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new EvolutionContractError(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EvolutionContractError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return integer(value, label);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EvolutionContractError(`${label} must be a finite number`);
  }
  return value;
}

function isoTime(value: unknown, label: string): string {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result))) throw new EvolutionContractError(`${label} must be ISO-8601`);
  return result;
}

function nullableIsoTime(value: unknown, label: string): string | null {
  if (value === null) return null;
  return isoTime(value, label);
}

function hash(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new EvolutionContractError(`${label} must be lowercase SHA-256`);
  return result;
}

function oneOf<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new EvolutionContractError(`${label} is not canonical`);
  }
  return value as T;
}

function exactNumber(value: unknown, expected: number, label: string): typeof expected {
  if (value !== expected) throw new EvolutionContractError(`${label} must be ${expected}`);
  return expected;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new EvolutionContractError(`${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function parseMetrics(value: unknown, label: string): SkillMetricsV1 {
  const row = record(value, label);
  const measurementState = oneOf(row.measurement_state, MEASUREMENT_STATES, `${label}.measurement_state`);
  const successRate = row.success_rate === null ? null : number(row.success_rate, `${label}.success_rate`);
  if (successRate !== null && (successRate < 0 || successRate > 1)) {
    throw new EvolutionContractError(`${label}.success_rate must be between 0 and 1`);
  }
  const metrics: SkillMetricsV1 = {
    measurement_state: measurementState,
    primary_applied: integer(row.primary_applied, `${label}.primary_applied`),
    evaluated: integer(row.evaluated, `${label}.evaluated`),
    pending: integer(row.pending, `${label}.pending`),
    inconclusive: integer(row.inconclusive, `${label}.inconclusive`),
    success: integer(row.success, `${label}.success`),
    applicability_failure: integer(row.applicability_failure, `${label}.applicability_failure`),
    execution_failure: integer(row.execution_failure, `${label}.execution_failure`),
    success_rate: successRate,
    median_duration_ms: nullableInteger(row.median_duration_ms, `${label}.median_duration_ms`),
    human_corrections: nullableInteger(row.human_corrections, `${label}.human_corrections`),
    first_solved_problem_families: nullableInteger(
      row.first_solved_problem_families,
      `${label}.first_solved_problem_families`,
    ),
  };
  if (measurementState === "unknown" && successRate !== null) {
    throw new EvolutionContractError(`${label}.unknown measurement cannot expose success_rate`);
  }
  if (measurementState === "observed" && successRate === null) {
    throw new EvolutionContractError(`${label}.observed measurement must expose success_rate`);
  }
  const evaluated = metrics.success
    + metrics.applicability_failure
    + metrics.execution_failure
    + metrics.inconclusive;
  if (metrics.evaluated !== evaluated) {
    throw new EvolutionContractError(`${label}.evaluated does not match canonical outcome counts`);
  }
  const deterministic = metrics.success + metrics.applicability_failure + metrics.execution_failure;
  if (deterministic === 0) {
    if (successRate !== null) {
      throw new EvolutionContractError(`${label}.success_rate must be null without deterministic outcomes`);
    }
  } else {
    const expectedRate = metrics.success / deterministic;
    if (successRate === null || Math.abs(successRate - expectedRate) > 1e-12) {
      throw new EvolutionContractError(`${label}.success_rate does not match canonical outcome counts`);
    }
  }
  return metrics;
}

/** Rollout-off keeps read access and only permits one-way emergency disable operations. */
export function canToggleLearning(overview: EvolutionOverviewV1): boolean {
  return overview.rollout_enabled;
}

export function canToggleLearnedSkills(overview: EvolutionOverviewV1): boolean {
  return overview.rollout_enabled || overview.learned_skills_enabled;
}

export function canRunCurator(overview: EvolutionOverviewV1): boolean {
  return overview.rollout_enabled;
}

export function canToggleLearnedSkill(rolloutEnabled: boolean, skillEnabled: boolean): boolean {
  return rolloutEnabled || skillEnabled;
}

/** Rollout-off exposes exactly the enabled -> disabled emergency edge. */
export function canControlLearnedSkill(
  rolloutEnabled: boolean,
  skillEnabled: boolean,
  action: LearnedSkillControlAction,
): boolean {
  return rolloutEnabled || (action === "disable" && skillEnabled);
}

export function parseLearnedSkillSummary(value: unknown, label = "learned skill"): LearnedSkillSummaryV1 {
  const row = record(value, label);
  if (row.schema !== "learned-skill-summary.v1") {
    throw new EvolutionContractError(`${label}.schema must be learned-skill-summary.v1`);
  }
  const qualityState = row.quality_state === null
    ? null
    : oneOf(row.quality_state, QUALITY_STATES, `${label}.quality_state`);
  if (row.freshness_state !== "current" && row.freshness_state !== "stale") {
    throw new EvolutionContractError(`${label}.freshness_state is not canonical`);
  }
  if (row.availability_state !== "available" && row.availability_state !== "archived") {
    throw new EvolutionContractError(`${label}.availability_state is not canonical`);
  }
  return {
    schema: "learned-skill-summary.v1",
    skill_id: string(row.skill_id, `${label}.skill_id`),
    slug: string(row.slug, `${label}.slug`),
    name: string(row.name, `${label}.name`),
    summary: string(row.summary, `${label}.summary`),
    applicability_summary: string(row.applicability_summary, `${label}.applicability_summary`),
    active_version_id: nullableString(row.active_version_id, `${label}.active_version_id`),
    active_version_no: nullableInteger(row.active_version_no, `${label}.active_version_no`),
    quality_state: qualityState,
    freshness_state: row.freshness_state,
    availability_state: row.availability_state,
    enabled: boolean(row.enabled, `${label}.enabled`),
    pinned: boolean(row.pinned, `${label}.pinned`),
    recommended: boolean(row.recommended, `${label}.recommended`),
    control_revision: integer(row.control_revision, `${label}.control_revision`),
    last_used_at: nullableIsoTime(row.last_used_at, `${label}.last_used_at`),
    metrics: parseMetrics(row.metrics, `${label}.metrics`),
  };
}

export function parseEvolutionOverview(value: unknown): EvolutionOverviewV1 {
  const row = record(value, "evolution overview");
  if (row.schema !== "evolution-overview.v1") {
    throw new EvolutionContractError("evolution overview schema is not v1");
  }
  const counts = record(row.skill_counts, "evolution overview.skill_counts");
  const skillCounts = {} as Record<QualityState | "archived" | "disabled", number>;
  for (const key of [...QUALITY_STATES, "archived", "disabled"] as const) {
    skillCounts[key] = integer(counts[key], `evolution overview.skill_counts.${key}`);
  }
  const curator = record(row.curator, "evolution overview.curator");
  return {
    schema: "evolution-overview.v1",
    rollout_enabled: boolean(row.rollout_enabled, "evolution overview.rollout_enabled"),
    learning_paused: boolean(row.learning_paused, "evolution overview.learning_paused"),
    learned_skills_enabled: boolean(row.learned_skills_enabled, "evolution overview.learned_skills_enabled"),
    settings_revision: integer(row.settings_revision, "evolution overview.settings_revision"),
    skill_counts: skillCounts,
    pending_applications: integer(row.pending_applications, "evolution overview.pending_applications"),
    curator: {
      last_run_at: nullableIsoTime(curator.last_run_at, "evolution overview.curator.last_run_at"),
      next_eligible_at: nullableIsoTime(curator.next_eligible_at, "evolution overview.curator.next_eligible_at"),
      pending_evaluations: integer(curator.pending_evaluations, "evolution overview.curator.pending_evaluations"),
      schedule_days: exactNumber(curator.schedule_days, 7, "evolution overview.curator.schedule_days") as 7,
      idle_hours: exactNumber(curator.idle_hours, 2, "evolution overview.curator.idle_hours") as 2,
      max_vivado_jobs: exactNumber(curator.max_vivado_jobs, 3, "evolution overview.curator.max_vivado_jobs") as 3,
      max_duration_minutes: exactNumber(
        curator.max_duration_minutes,
        120,
        "evolution overview.curator.max_duration_minutes",
      ) as 120,
    },
  };
}

export function parseLearnedSkillList(value: unknown): LearnedSkillListV1 {
  const row = record(value, "learned skill list");
  if (row.schema !== "learned-skill-list.v1" || !Array.isArray(row.items)) {
    throw new EvolutionContractError("learned skill list is not v1");
  }
  return {
    schema: "learned-skill-list.v1",
    items: row.items.map((item, index) => parseLearnedSkillSummary(item, `learned skill list.items[${index}]`)),
    next_cursor: nullableString(row.next_cursor, "learned skill list.next_cursor"),
  };
}

function parseVersionSummary(value: unknown, label: string): LearnedSkillVersionSummaryV1 {
  const row = record(value, label);
  return {
    version_id: string(row.version_id, `${label}.version_id`),
    version_no: integer(row.version_no, `${label}.version_no`),
    parent_version_id: nullableString(row.parent_version_id, `${label}.parent_version_id`),
    quality_state: oneOf(row.quality_state, QUALITY_STATES, `${label}.quality_state`),
    content_manifest_hash: hash(row.content_manifest_hash, `${label}.content_manifest_hash`),
    created_at: isoTime(row.created_at, `${label}.created_at`),
  };
}

export function parseLearnedSkillDetail(value: unknown): LearnedSkillDetailV1 {
  const row = record(value, "learned skill detail");
  const summary = parseLearnedSkillSummary(row, "learned skill detail");
  if (!Array.isArray(row.versions)) throw new EvolutionContractError("learned skill detail.versions must be an array");
  const source = record(row.source_summary, "learned skill detail.source_summary");
  return {
    ...summary,
    versions: row.versions.map((item, index) => parseVersionSummary(item, `learned skill detail.versions[${index}]`)),
    source_summary: {
      distillation_run_id: string(source.distillation_run_id, "learned skill detail.source_summary.distillation_run_id"),
      source_count: integer(source.source_count, "learned skill detail.source_summary.source_count"),
      visible_source_count: integer(
        source.visible_source_count,
        "learned skill detail.source_summary.visible_source_count",
      ),
    },
  };
}

function parseFile(value: unknown, label: string): LearnedSkillFileV1 {
  const row = record(value, label);
  return {
    path: string(row.path, `${label}.path`),
    kind: string(row.kind, `${label}.kind`),
    language: nullableString(row.language, `${label}.language`),
    sha256: hash(row.sha256, `${label}.sha256`),
    size_bytes: integer(row.size_bytes, `${label}.size_bytes`),
    media_type: string(row.media_type, `${label}.media_type`),
    content: typeof row.content === "string"
      ? row.content
      : (() => { throw new EvolutionContractError(`${label}.content must be a string`); })(),
  };
}

export function parseLearnedSkillVersion(value: unknown): LearnedSkillVersionV1 {
  const row = record(value, "learned skill version");
  if (row.schema !== "learned-skill-version.v1") {
    throw new EvolutionContractError("learned skill version schema is not v1");
  }
  const version = record(row.version, "learned skill version.version");
  if (!Array.isArray(version.files)) throw new EvolutionContractError("learned skill version.files must be an array");
  const scan = record(version.scan, "learned skill version.scan");
  if (!Array.isArray(scan.findings)) throw new EvolutionContractError("learned skill version.scan.findings must be an array");
  return {
    schema: "learned-skill-version.v1",
    skill: parseLearnedSkillSummary(row.skill, "learned skill version.skill"),
    version: {
      version_id: string(version.version_id, "learned skill version.version_id"),
      version_no: integer(version.version_no, "learned skill version.version_no"),
      parent_version_id: nullableString(version.parent_version_id, "learned skill version.parent_version_id"),
      quality_state: oneOf(version.quality_state, QUALITY_STATES, "learned skill version.quality_state"),
      description: string(version.description, "learned skill version.description"),
      applicability: version.applicability,
      outcome_contract: version.outcome_contract,
      content_manifest_hash: hash(version.content_manifest_hash, "learned skill version.content_manifest_hash"),
      created_at: isoTime(version.created_at, "learned skill version.created_at"),
      files: version.files.map((item, index) => parseFile(item, `learned skill version.files[${index}]`)),
      scan: {
        scanner_version: string(scan.scanner_version, "learned skill version.scan.scanner_version"),
        decision: string(scan.decision, "learned skill version.scan.decision"),
        findings: scan.findings,
      },
    },
  };
}

function parseApplicationState(value: unknown, label: string): SkillApplicationState {
  return oneOf(value, APPLICATION_STATES, label);
}

function parseEvaluationOutcome(value: unknown, label: string): EvaluationOutcome {
  return oneOf(value, EVALUATION_OUTCOMES, label);
}

function parseApplicationListItem(value: unknown, label: string): SkillApplicationListItemV1 {
  const row = record(value, label);
  if (!Array.isArray(row.skills)) throw new EvolutionContractError(`${label}.skills must be an array`);
  const current = row.current_evaluation === null ? null : record(row.current_evaluation, `${label}.current_evaluation`);
  return {
    application_id: string(row.application_id, `${label}.application_id`),
    project_ref: string(row.project_ref, `${label}.project_ref`),
    task_ref: string(row.task_ref, `${label}.task_ref`),
    local_goal: string(row.local_goal, `${label}.local_goal`),
    state: parseApplicationState(row.state, `${label}.state`),
    started_at: isoTime(row.started_at, `${label}.started_at`),
    closed_at: nullableIsoTime(row.closed_at, `${label}.closed_at`),
    duration_ms: nullableInteger(row.duration_ms, `${label}.duration_ms`),
    human_corrections: nullableInteger(row.human_corrections, `${label}.human_corrections`),
    outcome_claim: nullableString(row.outcome_claim, `${label}.outcome_claim`),
    skills: row.skills.map((item, index) => {
      const skill = record(item, `${label}.skills[${index}]`);
      if (skill.role !== "primary" && skill.role !== "supporting") {
        throw new EvolutionContractError(`${label}.skills[${index}].role is not canonical`);
      }
      return {
        version_id: string(skill.version_id, `${label}.skills[${index}].version_id`),
        role: skill.role,
      };
    }),
    current_evaluation: current === null ? null : {
      evaluation_id: string(current.evaluation_id, `${label}.current_evaluation.evaluation_id`),
      outcome: parseEvaluationOutcome(current.outcome, `${label}.current_evaluation.outcome`),
      confidence: number(current.confidence, `${label}.current_evaluation.confidence`),
      created_at: isoTime(current.created_at, `${label}.current_evaluation.created_at`),
    },
  };
}

export function parseSkillApplicationList(value: unknown): SkillApplicationListV1 {
  const row = record(value, "skill application list");
  if (row.schema !== "skill-application-list.v1" || !Array.isArray(row.items)) {
    throw new EvolutionContractError("skill application list is not v1");
  }
  return {
    schema: "skill-application-list.v1",
    items: row.items.map((item, index) => parseApplicationListItem(item, `skill application list.items[${index}]`)),
    next_cursor: nullableString(row.next_cursor, "skill application list.next_cursor"),
  };
}

function parseEvaluation(value: unknown, label: string): SkillApplicationEvaluationV1 {
  const row = record(value, label);
  const evidence = record(row.evidence_summary, `${label}.evidence_summary`);
  if (row.evaluator_type !== "curator" && row.evaluator_type !== "human") {
    throw new EvolutionContractError(`${label}.evaluator_type is not canonical`);
  }
  return {
    evaluation_id: string(row.evaluation_id, `${label}.evaluation_id`),
    outcome: parseEvaluationOutcome(row.outcome, `${label}.outcome`),
    confidence: number(row.confidence, `${label}.confidence`),
    reason: string(row.reason, `${label}.reason`),
    evidence_summary: {
      visible: integer(evidence.visible, `${label}.evidence_summary.visible`),
      redacted: integer(evidence.redacted, `${label}.evidence_summary.redacted`),
      hashes: stringArray(evidence.hashes, `${label}.evidence_summary.hashes`).map((item, index) =>
        hash(item, `${label}.evidence_summary.hashes[${index}]`)),
    },
    supersedes_id: nullableString(row.supersedes_id, `${label}.supersedes_id`),
    evaluator_type: row.evaluator_type,
    evaluator_version: string(row.evaluator_version, `${label}.evaluator_version`),
    created_at: isoTime(row.created_at, `${label}.created_at`),
  };
}

export function parseSkillApplicationDetail(value: unknown): SkillApplicationDetailV1 {
  const row = record(value, "skill application detail");
  if (row.schema !== "skill-application-detail.v1") {
    throw new EvolutionContractError("skill application detail schema is not v1");
  }
  if (!Array.isArray(row.skills) || !Array.isArray(row.evaluations)) {
    throw new EvolutionContractError("skill application detail lists are malformed");
  }
  const evidence = record(row.evidence_summary, "skill application detail.evidence_summary");
  if (!Array.isArray(evidence.refs)) throw new EvolutionContractError("skill application detail.evidence refs must be an array");
  const evaluations = row.evaluations.map((item, index) =>
    parseEvaluation(item, `skill application detail.evaluations[${index}]`));
  for (let index = 1; index < evaluations.length; index += 1) {
    const previous = evaluations[index - 1]!;
    const current = evaluations[index]!;
    if (
      current.created_at < previous.created_at
      || (current.created_at === previous.created_at && current.evaluation_id <= previous.evaluation_id)
    ) {
      throw new EvolutionContractError("skill application evaluations must be stably ascending");
    }
  }
  return {
    schema: "skill-application-detail.v1",
    application_id: string(row.application_id, "skill application detail.application_id"),
    project_ref: string(row.project_ref, "skill application detail.project_ref"),
    task_ref: string(row.task_ref, "skill application detail.task_ref"),
    observation_key: string(row.observation_key, "skill application detail.observation_key"),
    episode_ref: row.episode_ref === null ? null : string(row.episode_ref, "skill application detail.episode_ref"),
    local_goal: string(row.local_goal, "skill application detail.local_goal"),
    state: parseApplicationState(row.state, "skill application detail.state"),
    started_at: isoTime(row.started_at, "skill application detail.started_at"),
    closed_at: nullableIsoTime(row.closed_at, "skill application detail.closed_at"),
    duration_ms: nullableInteger(row.duration_ms, "skill application detail.duration_ms"),
    human_corrections: nullableInteger(row.human_corrections, "skill application detail.human_corrections"),
    outcome_claim: nullableString(row.outcome_claim, "skill application detail.outcome_claim"),
    skills: row.skills.map((item, index) => {
      const skill = record(item, `skill application detail.skills[${index}]`);
      if (skill.role !== "primary" && skill.role !== "supporting") {
        throw new EvolutionContractError(`skill application detail.skills[${index}].role is not canonical`);
      }
      return {
        skill_id: string(skill.skill_id, `skill application detail.skills[${index}].skill_id`),
        version_id: string(skill.version_id, `skill application detail.skills[${index}].version_id`),
        role: skill.role,
        reason_codes: stringArray(skill.reason_codes, `skill application detail.skills[${index}].reason_codes`),
      };
    }),
    evidence_summary: {
      visible: integer(evidence.visible, "skill application detail.evidence_summary.visible"),
      redacted: integer(evidence.redacted, "skill application detail.evidence_summary.redacted"),
      refs: evidence.refs.map((item, index) => {
        const ref = record(item, `skill application detail.evidence_summary.refs[${index}]`);
        return {
          type: string(ref.type, `skill application detail.evidence_summary.refs[${index}].type`),
          id: string(ref.id, `skill application detail.evidence_summary.refs[${index}].id`),
          hash: hash(ref.hash, `skill application detail.evidence_summary.refs[${index}].hash`),
        };
      }),
    },
    evaluations,
  };
}

export function parseCuratorRun(value: unknown): CuratorRunV1 {
  const row = record(value, "curator run");
  if (row.schema !== "curator-run.v1") throw new EvolutionContractError("curator run schema is not v1");
  if (row.mode !== "run" && row.mode !== "dry_run") throw new EvolutionContractError("curator run mode is invalid");
  if (row.state !== "queued" && row.state !== "dry_run_complete") {
    throw new EvolutionContractError("curator run state is invalid");
  }
  return {
    schema: "curator-run.v1",
    curator_run_id: string(row.curator_run_id, "curator run.curator_run_id"),
    state: row.state,
    mode: row.mode,
    created_at: isoTime(row.created_at, "curator run.created_at"),
  };
}

export const QUALITY_STATE_TEXT: Readonly<Record<QualityState, string>> = {
  active_unproven: "可用 · 待观察",
  active_observed: "已观察",
  needs_review: "需要复核",
  degraded: "已降级",
  quarantined: "已隔离",
};

export const QUALITY_STATE_TONE: Readonly<Record<QualityState, "neutral" | "ok" | "warn" | "danger" | "info">> = {
  active_unproven: "info",
  active_observed: "ok",
  needs_review: "warn",
  degraded: "warn",
  quarantined: "danger",
};

export const EVALUATION_OUTCOME_TEXT: Readonly<Record<EvaluationOutcome, string>> = {
  success: "局部目标成功",
  applicability_failure: "适用性失败",
  execution_failure: "执行失败",
  inconclusive: "证据不足",
};

export const APPLICATION_STATE_TEXT: Readonly<Record<SkillApplicationState, string>> = {
  open: "应用中",
  closed_pending_episode: "等待任务片段归档",
  pending_evaluation: "待 Curator 评价",
  evaluated: "已评价",
};

export function formatEvolutionTime(value: string | null): string {
  if (!value) return "尚无";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatEvolutionDuration(value: number | null): string {
  if (value === null) return "未知";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} 秒`;
  return `${(value / 60_000).toFixed(1)} 分钟`;
}

export function successRateText(metrics: SkillMetricsV1): string {
  if (metrics.measurement_state === "unknown" || metrics.success_rate === null) return "提升未知";
  return `${Math.round(metrics.success_rate * 100)}%`;
}

export function currentEvaluationIds(evaluations: readonly SkillApplicationEvaluationV1[]): ReadonlySet<string> {
  const superseded = new Set(evaluations.flatMap((evaluation) =>
    evaluation.supersedes_id ? [evaluation.supersedes_id] : []));
  return new Set(evaluations.filter((evaluation) => !superseded.has(evaluation.evaluation_id)).map(
    (evaluation) => evaluation.evaluation_id,
  ));
}

export interface FrozenWriteAttempt<T> {
  readonly signature: string;
  readonly idempotencyKey: string;
  readonly body: T;
}

/** Preserve the exact body and key across a failed retry; changed intent gets a new key. */
export function freezeWriteAttempt<T>(
  previous: FrozenWriteAttempt<T> | null,
  signature: string,
  body: T,
): FrozenWriteAttempt<T> {
  return previous?.signature === signature
    ? previous
    : { signature, idempotencyKey: crypto.randomUUID(), body };
}

export function controlReasonError(reason: string): string | null {
  return reason.trim().length > 0 ? null : "请填写本次控制操作的原因。";
}
