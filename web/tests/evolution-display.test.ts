import { describe, expect, test } from "bun:test";
import type { LearnedSkillSummaryV1, SkillMetricsV1 } from "../src/api/evolution.ts";
import { skillDisplayName, skillOutcomeSegments, skillVisualState } from "../src/domain/evolution-display.ts";

describe("evolution visual evidence", () => {
  test("disabled and archived skills do not appear as currently observed capabilities", () => {
    const skill = { enabled: true, availability_state: "available", quality_state: "active_observed" } as LearnedSkillSummaryV1;
    expect(skillVisualState(skill)).toBe("observed");
    expect(skillVisualState({ ...skill, enabled: false })).toBe("inactive");
    expect(skillVisualState({ ...skill, availability_state: "archived" })).toBe("inactive");
    expect(skillVisualState({ ...skill, quality_state: "quarantined" })).toBe("attention");
    expect(skillVisualState({ ...skill, quality_state: null })).toBe("unproven");
  });

  test("pending and inconclusive evidence remain separate from successful outcomes", () => {
    const metrics = { success: 2, applicability_failure: 1, execution_failure: 2, inconclusive: 4, pending: 5 } as SkillMetricsV1;
    const segments = skillOutcomeSegments(metrics);
    expect(segments.map(({ key, count }) => [key, count])).toEqual([
      ["success", 2], ["failure", 3], ["inconclusive", 4], ["pending", 5],
    ]);
  });

  test("short titles remove appended detail but retain names with no prefix", () => {
    expect(skillDisplayName("时序优化（多轮验证与报告证据）")).toBe("时序优化");
    expect(skillDisplayName("Timing (details)")).toBe("Timing");
    expect(skillDisplayName("（未命名）")).toBe("（未命名）");
    expect(skillDisplayName("时序优化")).toBe("时序优化");
  });
});
