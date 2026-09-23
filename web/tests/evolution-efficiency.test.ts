import { describe, expect, test } from "bun:test";
import { parseEvolutionEfficiency } from "../src/domain/evolution.ts";
import { efficiencyDuration, efficiencySpeedup } from "../src/domain/evolution-display.ts";

const observed = {
  measurement_state: "observed", primary_applications: 9, successful_applications: 4,
  compared_applications: 3, compared_skills: 2,
  baseline_total_ms: 3_600_000, applied_total_ms: 600_000, net_saved_ms: 3_000_000,
  speedup: 6, scope: "all_versions", gap_cap_seconds: 600,
};

describe("evolution efficiency contract", () => {
  test("accepts complete totals and treats older Core as unavailable", () => {
    expect(parseEvolutionEfficiency(observed)).toEqual(observed);
    expect(parseEvolutionEfficiency(undefined)).toBeNull();
    expect(parseEvolutionEfficiency(null)).toBeNull();
  });
  test("negative savings retain their sign and slower speedup", () => {
    expect(parseEvolutionEfficiency({ ...observed, applied_total_ms: 7_200_000, net_saved_ms: -3_600_000, speedup: 0.5 })!.net_saved_ms).toBe(-3_600_000);
  });
  test("rejects inconsistent or invented cumulative savings", () => {
    for (const patch of [
      { net_saved_ms: 999 }, { speedup: 99 }, { compared_applications: 6 },
      { successful_applications: 10 }, { compared_skills: 10 }, { compared_skills: 0 },
      { applied_total_ms: 0 }, { measurement_state: "unknown" }, { scope: "active_version" },
      { compared_applications: 0 },
    ]) expect(() => parseEvolutionEfficiency({ ...observed, ...patch })).toThrow();
  });
  test("no observations leave totals unknown", () => {
    const empty = { ...observed, measurement_state: "unknown", primary_applications: 0, successful_applications: 0, compared_applications: 0, compared_skills: 0, baseline_total_ms: null, applied_total_ms: null, net_saved_ms: null, speedup: null };
    expect(parseEvolutionEfficiency(empty)).toEqual(empty);
    expect(() => parseEvolutionEfficiency({ ...empty, net_saved_ms: 0 })).toThrow();
  });
});

describe("efficiency labels", () => {
  test("formats real hours, zero, unknown and negative durations without false savings", () => {
    expect(efficiencyDuration(3_780_000)).toBe("1 小时 3 分");
    expect(efficiencyDuration(-3_780_000)).toBe("1 小时 3 分");
    expect(efficiencyDuration(0)).toBe("0 秒");
    expect(efficiencyDuration(null)).toBe("待积累");
    expect(efficiencyDuration(400)).toBe("不足 1 秒");
    expect(efficiencyDuration(75_000)).toBe("1 分 15 秒");
    expect(efficiencySpeedup(0.002)).toBe("<0.01×");
    expect(efficiencySpeedup(6.387)).toBe("6.39×");
    expect(efficiencySpeedup(null)).toBe("待积累");
  });
});
