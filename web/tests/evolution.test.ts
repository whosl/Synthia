import { describe, expect, test } from "bun:test";
import {
  EvolutionContractError,
  canControlLearnedSkill,
  canRunCurator,
  canToggleLearnedSkill,
  canToggleLearnedSkills,
  canToggleLearning,
  controlReasonError,
  currentEvaluationIds,
  freezeWriteAttempt,
  parseEvolutionOverview,
  parseLearnedSkillSummary,
  parseSkillApplicationDetail,
  successRateText,
} from "../src/domain/evolution.ts";
import type { SkillApplicationEvaluationV1, SkillMetricsV1 } from "../src/api/evolution.ts";

const HASH = "a".repeat(64);

function unknownMetrics(): SkillMetricsV1 {
  return {
    measurement_state: "unknown",
    primary_applied: 1,
    evaluated: 0,
    pending: 1,
    inconclusive: 0,
    success: 0,
    applicability_failure: 0,
    execution_failure: 0,
    success_rate: null,
    median_duration_ms: null,
    human_corrections: null,
    first_solved_problem_families: null,
  };
}

function overview(): unknown {
  return {
    schema: "evolution-overview.v1",
    rollout_enabled: true,
    learning_paused: false,
    learned_skills_enabled: true,
    settings_revision: 3,
    skill_counts: {
      active_unproven: 1,
      active_observed: 2,
      needs_review: 0,
      degraded: 0,
      quarantined: 0,
      archived: 0,
      disabled: 0,
    },
    pending_applications: 1,
    curator: {
      last_run_at: null,
      next_eligible_at: "2026-08-26T00:00:00.000Z",
      pending_evaluations: 1,
      schedule_days: 7,
      idle_hours: 2,
      max_vivado_jobs: 3,
      max_duration_minutes: 120,
    },
  };
}

function learnedSkill(metrics: SkillMetricsV1): unknown {
  return {
    schema: "learned-skill-summary.v1",
    skill_id: "skill-1",
    slug: "skill-1",
    name: "Skill",
    summary: "summary",
    applicability_summary: "Vivado",
    active_version_id: "version-1",
    active_version_no: 1,
    quality_state: "active_observed",
    freshness_state: "current",
    availability_state: "available",
    enabled: true,
    pinned: false,
    recommended: true,
    control_revision: 1,
    last_used_at: null,
    metrics,
  };
}

function application(evaluations: unknown[]): unknown {
  return {
    schema: "skill-application-detail.v1",
    application_id: "app-1",
    project_ref: "redacted",
    task_ref: "redacted",
    observation_key: "obs-1",
    episode_ref: "redacted",
    local_goal: "消除重复驱动错误",
    state: "evaluated",
    started_at: "2026-08-25T00:00:00.000Z",
    closed_at: "2026-08-25T00:10:00.000Z",
    duration_ms: 600_000,
    human_corrections: 0,
    outcome_claim: null,
    skills: [{
      skill_id: "skill-1",
      version_id: "version-1",
      role: "primary",
      reason_codes: ["matching_error_family"],
    }],
    evidence_summary: { visible: 0, redacted: 1, refs: [] },
    evaluations,
  };
}

function evaluation(id: string, at: string, supersedes: string | null): unknown {
  return {
    evaluation_id: id,
    outcome: "success",
    confidence: 0.9,
    reason: "原局部问题已消失。",
    evidence_summary: { visible: 0, redacted: 1, hashes: [HASH] },
    supersedes_id: supersedes,
    evaluator_type: "curator",
    evaluator_version: "curator-v1",
    created_at: at,
  };
}

describe("self-evolution v1 domain contract", () => {
  test("accepts the frozen scheduler constants and rejects silent drift", () => {
    expect(parseEvolutionOverview(overview()).curator).toMatchObject({
      schedule_days: 7,
      idle_hours: 2,
      max_vivado_jobs: 3,
      max_duration_minutes: 120,
    });
    const drifted = structuredClone(overview()) as { curator: { schedule_days: number } };
    drifted.curator.schedule_days = 1;
    expect(() => parseEvolutionOverview(drifted)).toThrow(EvolutionContractError);
  });

  test("unknown metrics remain unknown and never manufacture a success rate", () => {
    const parsed = parseLearnedSkillSummary(learnedSkill(unknownMetrics()));
    expect(successRateText(parsed.metrics)).toBe("提升未知");
    expect(parsed.metrics.first_solved_problem_families).toBeNull();
    expect(() => parseLearnedSkillSummary(learnedSkill({ ...unknownMetrics(), success_rate: 1 })))
      .toThrow("unknown measurement");
  });

  test("metrics fail closed on inconsistent observed totals and rates", () => {
    const observed: SkillMetricsV1 = {
      ...unknownMetrics(),
      measurement_state: "observed",
      primary_applied: 8,
      evaluated: 6,
      pending: 2,
      inconclusive: 1,
      success: 4,
      applicability_failure: 1,
      success_rate: 0.8,
      median_duration_ms: 10,
      human_corrections: 0,
    };
    expect(parseLearnedSkillSummary(learnedSkill(observed)).metrics.success_rate).toBe(0.8);
    expect(() => parseLearnedSkillSummary(learnedSkill({ ...observed, success_rate: null })))
      .toThrow("observed measurement");
    expect(() => parseLearnedSkillSummary(learnedSkill({ ...observed, evaluated: 5 })))
      .toThrow("canonical outcome counts");
    expect(() => parseLearnedSkillSummary(learnedSkill({ ...observed, success_rate: 0.5 })))
      .toThrow("success_rate does not match");
    expect(() => parseLearnedSkillSummary(learnedSkill({
      ...observed,
      measurement_state: "unknown",
      evaluated: 1,
      inconclusive: 1,
      success: 0,
      applicability_failure: 0,
      execution_failure: 0,
      success_rate: 0,
    }))).toThrow("unknown measurement");
  });

  test("rollout-off exposes only one-way emergency disable actions", () => {
    const disabled = parseEvolutionOverview({ ...overview() as object, rollout_enabled: false });
    expect(canToggleLearning(disabled)).toBe(false);
    expect(canRunCurator(disabled)).toBe(false);
    expect(canToggleLearnedSkills(disabled)).toBe(true);
    expect(canToggleLearnedSkill(false, true)).toBe(true);
    expect(canToggleLearnedSkill(false, false)).toBe(false);
    expect(canToggleLearnedSkills({ ...disabled, learned_skills_enabled: false })).toBe(false);
    expect(canControlLearnedSkill(false, true, "disable")).toBe(true);
    expect(canControlLearnedSkill(false, false, "disable")).toBe(false);
    for (const action of ["enable", "pin", "unpin", "archive", "restore"] as const) {
      expect(canControlLearnedSkill(false, true, action)).toBe(false);
    }
    for (const action of ["enable", "disable", "pin", "unpin", "archive", "restore"] as const) {
      expect(canControlLearnedSkill(true, false, action)).toBe(true);
    }
  });

  test("application detail preserves stable append-only evaluation order", () => {
    const parsed = parseSkillApplicationDetail(application([
      evaluation("eval-a", "2026-08-25T01:00:00.000Z", null),
      evaluation("eval-b", "2026-08-25T02:00:00.000Z", "eval-a"),
    ]));
    expect(parsed.evaluations.map((item) => item.evaluation_id)).toEqual(["eval-a", "eval-b"]);
    expect([...currentEvaluationIds(parsed.evaluations)]).toEqual(["eval-b"]);

    expect(() => parseSkillApplicationDetail(application([
      evaluation("eval-b", "2026-08-25T02:00:00.000Z", "eval-a"),
      evaluation("eval-a", "2026-08-25T01:00:00.000Z", null),
    ]))).toThrow("stably ascending");
  });

  test("current evaluation calculation keeps non-superseded branches visible", () => {
    const rows = [
      evaluation("a", "2026-08-25T01:00:00.000Z", null),
      evaluation("b", "2026-08-25T02:00:00.000Z", "a"),
      evaluation("c", "2026-08-25T03:00:00.000Z", null),
    ] as SkillApplicationEvaluationV1[];
    expect([...currentEvaluationIds(rows)]).toEqual(["b", "c"]);
  });

  test("failed write retries retain the exact body and idempotency key", () => {
    const body = { expected_revision: 3, reason: "维护", learning_paused: true };
    const first = freezeWriteAttempt(null, JSON.stringify(body), body);
    const replayed = freezeWriteAttempt(first, JSON.stringify(body), { ...body });
    expect(replayed).toBe(first);
    expect(replayed.idempotencyKey).toBe(first.idempotencyKey);

    const changed = freezeWriteAttempt(first, "changed", { ...body, reason: "另一个意图" });
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(controlReasonError("   ")).toContain("原因");
  });
});
