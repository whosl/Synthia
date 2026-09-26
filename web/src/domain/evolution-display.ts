import type { LearnedSkillSummaryV1, SkillMetricsV1 } from "../api/evolution.ts";

/** Presentation-only short name; the full original remains available in details. */
export function skillDisplayName(name: string): string {
  const prefix = name.split(/[（(]/, 1)[0]?.trim();
  return prefix || name;
}

export function skillVisualState(skill: LearnedSkillSummaryV1): "observed" | "attention" | "unproven" | "inactive" {
  if (!skill.enabled || skill.availability_state === "archived") return "inactive";
  if (skill.quality_state === "active_observed") return "observed";
  if (["needs_review", "degraded", "quarantined"].includes(skill.quality_state ?? "")) return "attention";
  return "unproven";
}

/** Outcome counts are disjoint; pending/inconclusive never count as success. */
export function skillOutcomeSegments(metrics: SkillMetricsV1) {
  return [
    { key: "success", label: "目标解决", count: metrics.success },
    { key: "failure", label: "未解决", count: metrics.applicability_failure + metrics.execution_failure },
    { key: "inconclusive", label: "证据不足", count: metrics.inconclusive },
    { key: "pending", label: "待评价", count: metrics.pending },
  ];
}

/** Compact human duration; negative deltas are labelled separately, never formatted as negative ms. */
export function efficiencyDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "待积累";
  const seconds = Math.round(Math.abs(value) / 1000);
  if (seconds === 0) return value === 0 ? "0 秒" : "不足 1 秒";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function efficiencySpeedup(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "待积累";
  if (value < 0.01) return "<0.01×";
  return `${Number(value.toFixed(2))}×`;
}
