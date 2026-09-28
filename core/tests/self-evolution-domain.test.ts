import { describe, expect, test } from "bun:test";
import {
  computeSkillMetrics,
  freshnessState,
  nextQualityState,
  requireInconclusiveBelowThreshold,
  shouldArchiveForInactivity,
  skillVisibility,
} from "../src/domain/self-evolution.ts";

describe("self-evolution domain", () => {
  test("keeps availability, quality and freshness orthogonal", () => {
    expect(skillVisibility({
      enabled: true,
      availabilityState: "available",
      freshnessState: "current",
      qualityState: "active_unproven",
    })).toEqual({ searchable: true, recommended: true, warning: false });
    expect(skillVisibility({
      enabled: true,
      availabilityState: "available",
      freshnessState: "stale",
      qualityState: "active_observed",
    })).toEqual({ searchable: true, recommended: false, warning: true });
    for (const hidden of [
      { enabled: false, availabilityState: "available", qualityState: "active_observed" },
      { enabled: true, availabilityState: "archived", qualityState: "active_observed" },
      { enabled: true, availabilityState: "available", qualityState: "quarantined" },
    ] as const) {
      expect(skillVisibility({ ...hidden, freshnessState: "current" }).searchable).toBe(false);
    }
  });

  test("derives stale and archive thresholds without conflating them", () => {
    const now = "2026-08-26T00:00:00.000Z";
    expect(freshnessState("2026-07-28T00:00:00.001Z", now)).toBe("current");
    expect(freshnessState("2026-07-27T00:00:00.000Z", now)).toBe("stale");
    expect(freshnessState(null, now, "2026-07-27T00:00:00.000Z")).toBe("stale");
    expect(shouldArchiveForInactivity(null, "2026-05-28T00:00:00.001Z", now)).toBe(false);
    expect(shouldArchiveForInactivity(null, "2026-05-28T00:00:00.000Z", now)).toBe(true);
  });

  test("applies failure thresholds and ignores inconclusive evaluations", () => {
    expect(nextQualityState("active_unproven", [
      { outcome: "execution_failure" },
    ])).toBe("needs_review");
    expect(nextQualityState("needs_review", [
      { outcome: "execution_failure" },
      { outcome: "inconclusive" },
      { outcome: "applicability_failure" },
    ])).toBe("degraded");
    expect(nextQualityState("degraded", [
      { outcome: "execution_failure" },
      { outcome: "applicability_failure" },
      { outcome: "execution_failure" },
    ])).toBe("quarantined");
    expect(nextQualityState("active_observed", [], { securityFinding: true })).toBe("quarantined");
  });

  test("recovers degraded quality one attributable success at a time", () => {
    expect(nextQualityState("degraded", [{ outcome: "success" }])).toBe("needs_review");
    expect(nextQualityState("needs_review", [
      { outcome: "success" },
      { outcome: "inconclusive" },
      { outcome: "success" },
    ])).toBe("active_observed");
    expect(nextQualityState("quarantined", [{ outcome: "success" }])).toBe("quarantined");
  });

  test("computes primary-only observational metrics", () => {
    const metrics = computeSkillMetrics([
      { role: "primary", applicationState: "evaluated", outcome: "success", durationMs: 100, humanCorrections: 0, firstSolvedProblemFamily: true },
      { role: "primary", applicationState: "evaluated", outcome: "execution_failure", durationMs: 300, humanCorrections: 2, firstSolvedProblemFamily: false },
      { role: "primary", applicationState: "evaluated", outcome: "inconclusive", durationMs: 200, humanCorrections: 1, firstSolvedProblemFamily: false },
      { role: "primary", applicationState: "pending_evaluation", outcome: null, durationMs: null, humanCorrections: null, firstSolvedProblemFamily: false },
      { role: "supporting", applicationState: "evaluated", outcome: "success", durationMs: 1, humanCorrections: 0 },
    ]);
    expect(metrics).toEqual({
      measurement_state: "observed",
      primary_applied: 4,
      evaluated: 3,
      pending: 1,
      inconclusive: 1,
      success: 1,
      applicability_failure: 0,
      execution_failure: 1,
      success_rate: 0.5,
      median_duration_ms: 200,
      human_corrections: 3,
      first_solved_problem_families: 1,
      baseline_duration_ms: null,
      efficiency_saved_ms: null,
      efficiency_speedup: null,
    });
  });

  test("computes efficiency against the origin-episode baseline from success durations only", () => {
    const observations = [
      { role: "primary", applicationState: "evaluated", outcome: "success", durationMs: 600, humanCorrections: 0 },
      { role: "primary", applicationState: "evaluated", outcome: "success", durationMs: 1_000, humanCorrections: 0 },
      { role: "primary", applicationState: "evaluated", outcome: "execution_failure", durationMs: 9_000, humanCorrections: 0 },
    ] as const;
    // Success median is 600+1000/2 = 800; failures never enter the skill arm.
    expect(computeSkillMetrics([...observations], { durationMs: 5_820_000 })).toMatchObject({
      baseline_duration_ms: 5_820_000,
      efficiency_saved_ms: 5_819_200,
      efficiency_speedup: 7_275,
    });
  });

  test("efficiency stays null without a positive baseline or a success arm", () => {
    const successOnly = [
      { role: "primary", applicationState: "evaluated", outcome: "success", durationMs: 100, humanCorrections: 0 },
    ];
    expect(computeSkillMetrics(successOnly, { durationMs: 0 })).toMatchObject({
      baseline_duration_ms: 0,
      efficiency_saved_ms: null,
      efficiency_speedup: null,
    });
    expect(computeSkillMetrics(successOnly, { durationMs: null })).toMatchObject({
      baseline_duration_ms: null,
      efficiency_saved_ms: null,
      efficiency_speedup: null,
    });
    expect(computeSkillMetrics(successOnly)).toMatchObject({
      baseline_duration_ms: null,
      efficiency_saved_ms: null,
      efficiency_speedup: null,
    });
    const noSuccess = [
      { role: "primary", applicationState: "evaluated", outcome: "inconclusive", durationMs: 100, humanCorrections: 0 },
    ];
    expect(computeSkillMetrics(noSuccess, { durationMs: 1_000 })).toMatchObject({
      baseline_duration_ms: 1_000,
      efficiency_saved_ms: null,
      efficiency_speedup: null,
    });
  });

  test("reports unknown instead of inventing a success rate", () => {
    expect(computeSkillMetrics([
      { role: "primary", applicationState: "evaluated", outcome: "inconclusive", durationMs: 10, humanCorrections: 0 },
    ])).toMatchObject({
      measurement_state: "unknown",
      success_rate: null,
      inconclusive: 1,
      first_solved_problem_families: null,
    });
  });

  test("makes the v1 low-confidence policy explicit", () => {
    expect(requireInconclusiveBelowThreshold("inconclusive", 0.2)).toBe(true);
    expect(requireInconclusiveBelowThreshold("success", 0.69)).toBe(false);
    expect(requireInconclusiveBelowThreshold("success", 0.7)).toBe(true);
    expect(() => requireInconclusiveBelowThreshold("success", 1.1)).toThrow();
  });
});
