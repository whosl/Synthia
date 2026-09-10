/**
 * Pure self-evolution domain rules.
 *
 * Learned-Skill lifecycle is deliberately orthogonal: Skill controls,
 * immutable version quality, and derived freshness are separate dimensions.
 * This module has no persistence or model dependency, so handlers, workers,
 * and tests share one deterministic interpretation of the frozen v1 contract.
 */

export const QUALITY_STATES = [
  "active_unproven",
  "active_observed",
  "needs_review",
  "degraded",
  "quarantined",
] as const;
export type QualityState = (typeof QUALITY_STATES)[number];

export const AVAILABILITY_STATES = ["available", "archived"] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export type FreshnessState = "current" | "stale";
export type MeasurementState = "unknown" | "observed";

export const EVALUATION_OUTCOMES = [
  "success",
  "applicability_failure",
  "execution_failure",
  "inconclusive",
] as const;
export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];

export type ApplicationState =
  | "open"
  | "closed_pending_episode"
  | "pending_evaluation"
  | "evaluated";

/** v1's explicit low-confidence boundary; never hide this in a model prompt. */
export const CURATOR_ATTRIBUTION_CONFIDENCE_THRESHOLD_V1 = 0.7;

export function requireInconclusiveBelowThreshold(
  outcome: EvaluationOutcome,
  confidence: number,
): boolean {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError("curator confidence must be between 0 and 1");
  }
  return confidence >= CURATOR_ATTRIBUTION_CONFIDENCE_THRESHOLD_V1
    || outcome === "inconclusive";
}

export interface SkillVisibilityInput {
  readonly enabled: boolean;
  readonly availabilityState: AvailabilityState;
  readonly freshnessState: FreshnessState;
  readonly qualityState: QualityState | null;
}

export interface SkillVisibility {
  readonly searchable: boolean;
  readonly recommended: boolean;
  readonly warning: boolean;
}

const RECOMMENDED_QUALITY = new Set<QualityState>([
  "active_unproven",
  "active_observed",
]);

/** Ordinary-agent visibility matrix from self-evolution-v1 section 7. */
export function skillVisibility(input: SkillVisibilityInput): SkillVisibility {
  if (
    !input.enabled ||
    input.availabilityState === "archived" ||
    input.qualityState === null ||
    input.qualityState === "quarantined"
  ) {
    return { searchable: false, recommended: false, warning: true };
  }
  const recommended =
    input.freshnessState === "current" &&
    RECOMMENDED_QUALITY.has(input.qualityState);
  return { searchable: true, recommended, warning: !recommended };
}

export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export function freshnessState(
  lastUsedAt: string | Date | null,
  now: string | Date = new Date(),
  createdAt?: string | Date,
): FreshnessState {
  if (lastUsedAt === null && createdAt === undefined) return "current";
  const last = new Date(lastUsedAt ?? createdAt!).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(last) || !Number.isFinite(current)) {
    throw new TypeError("freshness timestamps must be valid ISO-8601 values");
  }
  return current - last >= STALE_AFTER_MS ? "stale" : "current";
}

export function shouldArchiveForInactivity(
  lastUsedAt: string | Date | null,
  createdAt: string | Date,
  now: string | Date = new Date(),
): boolean {
  const reference = new Date(lastUsedAt ?? createdAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(reference) || !Number.isFinite(current)) {
    throw new TypeError("archive timestamps must be valid ISO-8601 values");
  }
  return current - reference >= ARCHIVE_AFTER_MS;
}

export interface LifecycleEvaluation {
  readonly outcome: EvaluationOutcome;
}

/**
 * Determine the next quality projection after an immutable evaluation.
 * `history` is chronological and includes the new evaluation. Inconclusive
 * observations are removed before streak/window calculations, so they neither
 * count as failures nor break an attributable streak.
 */
export function nextQualityState(
  current: QualityState,
  history: readonly LifecycleEvaluation[],
  options: { readonly securityFinding?: boolean } = {},
): QualityState {
  if (options.securityFinding) return "quarantined";
  if (current === "quarantined") return current;

  const attributable = history
    .map((item) => item.outcome)
    .filter((outcome) => outcome !== "inconclusive");
  const latest = attributable.at(-1);
  if (!latest) return current;

  if (latest === "success") {
    if (current === "degraded") return "needs_review";
    if (current === "needs_review") return "active_observed";
    return "active_observed";
  }

  const isFailure = (outcome: EvaluationOutcome): boolean =>
    outcome === "applicability_failure" || outcome === "execution_failure";
  let consecutiveFailures = 0;
  for (let index = attributable.length - 1; index >= 0; index -= 1) {
    if (!isFailure(attributable[index]!)) break;
    consecutiveFailures += 1;
  }
  const recentFiveFailures = attributable.slice(-5).filter(isFailure).length;
  if (consecutiveFailures >= 3 || recentFiveFailures >= 3) return "quarantined";
  if (consecutiveFailures >= 2) return "degraded";
  return "needs_review";
}

export interface SkillMetricObservation {
  /** Only primary applications are included in version metrics. */
  readonly role: "primary" | "supporting";
  readonly applicationState: ApplicationState;
  readonly outcome: EvaluationOutcome | null;
  readonly durationMs: number | null;
  readonly humanCorrections: number | null;
  readonly firstSolvedProblemFamily?: boolean;
}

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
  /** null until problem-family identity is backed by an explicit Core fact. */
  readonly first_solved_problem_families: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Observation-only metrics; pending/inconclusive never enter the denominator. */
export function computeSkillMetrics(
  observations: readonly SkillMetricObservation[],
): SkillMetricsV1 {
  const primary = observations.filter((item) => item.role === "primary");
  const success = primary.filter((item) => item.outcome === "success").length;
  const applicabilityFailure = primary.filter(
    (item) => item.outcome === "applicability_failure",
  ).length;
  const executionFailure = primary.filter(
    (item) => item.outcome === "execution_failure",
  ).length;
  const inconclusive = primary.filter((item) => item.outcome === "inconclusive").length;
  const evaluated = primary.filter((item) => item.outcome !== null).length;
  const pending = primary.filter(
    (item) => item.applicationState !== "evaluated" || item.outcome === null,
  ).length;
  const denominator = success + applicabilityFailure + executionFailure;
  const durations = primary
    .filter((item) => item.outcome !== null)
    .map((item) => item.durationMs)
    .filter((value): value is number => value !== null && value >= 0);
  const correctionValues = primary
    .filter((item) => item.outcome !== null)
    .map((item) => item.humanCorrections)
    .filter((value): value is number => value !== null && value >= 0);
  const hasCompleteProblemFamilyFacts = primary.length > 0
    && primary.every((item) => typeof item.firstSolvedProblemFamily === "boolean");

  return {
    measurement_state: denominator > 0 ? "observed" : "unknown",
    primary_applied: primary.length,
    evaluated,
    pending,
    inconclusive,
    success,
    applicability_failure: applicabilityFailure,
    execution_failure: executionFailure,
    success_rate: denominator > 0 ? success / denominator : null,
    median_duration_ms: median(durations),
    human_corrections:
      correctionValues.length > 0
        ? correctionValues.reduce((sum, value) => sum + value, 0)
        : null,
    first_solved_problem_families: hasCompleteProblemFamilyFacts
      ? primary.filter(
        (item) => item.outcome === "success" && item.firstSolvedProblemFamily === true,
      ).length
      : null,
  };
}
