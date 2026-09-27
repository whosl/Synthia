import { describe, expect, test } from "bun:test";
import { parseResourceUtilization } from "../src/services/resource-utilization.ts";
import { VIVADO_FIXTURE } from "../../web/src/mock/vivado-fixture.ts";

describe("Vivado resource report", () => {
  test("parses a captured real-device report with matching capacity and provenance", () => {
    const texts: string[] = [];
    function collect(value: unknown) {
      if (typeof value === "string" && value.includes("| Slice LUTs")) texts.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    }
    collect(VIVADO_FIXTURE);
    expect(texts.length).toBeGreaterThan(0);
    const report = parseResourceUtilization(texts[0]!);
    expect(report.device).toContain("7k70t");
    const lut = report.metrics.find((m) => m.key === "lut")!;
    expect(lut.available).toBe(41000);
    expect(lut.percent).toBe(lut.used / 41000 * 100);
    expect(report.metrics.find((m) => m.key === "bram")?.available).toBe(135);
    expect(report.metrics.find((m) => m.key === "dsp")?.available).toBe(240);
  });

  test("handles UltraScale columns, fractional BRAM and FF bank capacity without summing subrows", () => {
    const report = parseResourceUtilization(`Device : xczu-test
| Site Type | Used | Fixed | Prohibited | Available | Util% |
| CLB LUTs* | 1,234 | 0 | 0 | 10,000 | 12.34 |
| LUT as Logic | 1,000 | 0 | 0 | 10,000 | 10 |
| CLB Registers | 251 | 0 | 0 | 20,000 | 1.25 |
| Register as Flip Flop | 250 | 0 | | | |
| Register as Latch | 1 | 0 | | | |
| Block RAM Tile | 0.5 | 0 | 0 | 100 | 0.50 |
| DSPs | 0 | 0 | 0 | 200 | 0 |
| Ref Name | Used | Functional Category |
| CLB LUTs | 9000 | LUT |`);
    expect(report.metrics.find((m) => m.key === "lut")?.used).toBe(1234);
    expect(report.metrics.find((m) => m.key === "ff")).toMatchObject({ used: 250, available: 20000, percent: 1.25 });
    expect(report.metrics.find((m) => m.key === "bram")?.percent).toBe(0.5);
    expect(report.metrics.find((m) => m.key === "dsp")?.percent).toBe(0);
    expect(report.metrics.some((m) => m.key === "io")).toBe(false);
  });

  test("unknown capacities remain null, zero is valid usage and overage is uncapped", () => {
    const report = parseResourceUtilization(`| Site Type | Available | Used | Util% |
| Slice LUTs | 100 | 120 | 120 |
| Slice Registers | N/A | 0 | N/A |
| Block RAM Tile | 0 | 0 | N/A |
| DSPs | 200 | -1 | N/A |`);
    expect(report.metrics[0]?.percent).toBe(120);
    expect(report.metrics.find((m) => m.key === "ff")).toMatchObject({ used: 0, available: null, percent: null });
    expect(report.metrics.find((m) => m.key === "bram")?.percent).toBeNull();
    expect(report.metrics.some((m) => m.key === "dsp")).toBe(false);
    expect(parseResourceUtilization("no report").metrics).toEqual([]);
  });
});
