import { expect, test } from "bun:test";
import { resourcePercent, resourceRows } from "../src/domain/resource-utilization.ts";
import type { ToolSummaryResources } from "../src/api/types.ts";

test("resource presentation separates unknown from zero and preserves fractional use and overage", () => {
  const resources: ToolSummaryResources = { device: "test", design: null, sourceJobId: "job", sourceAt: "", sourceOperation: "implement", reportName: "resources.rpt", metrics: [
    { key: "lut", label: "LUT", sourceLabel: "Slice LUTs", used: 120, available: 100, percent: 120 },
    { key: "ff", label: "FF", sourceLabel: "Register as Flip Flop", used: 0, available: 100, percent: 0 },
    { key: "bram", label: "BRAM", sourceLabel: "Block RAM Tile", used: 0.5, available: 100, percent: 0.5 },
    { key: "dsp", label: "DSP", sourceLabel: "DSPs", used: 5, available: null, percent: null },
  ] };
  const rows = resourceRows(resources);
  expect(rows[0]).toMatchObject({ percentText: "120%", fill: 100, tone: "over" });
  expect(rows[1]).toMatchObject({ percentText: "0%", used: 0 });
  expect(rows[2]).toMatchObject({ percentText: "0.5%", used: 0.5 });
  expect(rows[3]).toMatchObject({ percentText: "—", used: 5 });
  expect(rows[4]).toMatchObject({ percentText: "—", used: null });
  expect(resourceRows(null).every((row) => row.used === null)).toBe(true);
  expect(resourcePercent(0.001)).toBe("<0.01%");
});
