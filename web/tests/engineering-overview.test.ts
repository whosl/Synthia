import { describe, expect, test } from "bun:test";
import type { ToolSummary } from "../src/api/types.ts";
import { overviewMetrics, overviewStages, overviewState } from "../src/domain/engineering-overview.ts";
import { mockAgentDetail, mockAgents } from "../src/mock/data.ts";
import { mockToolSummary } from "../src/mock/tool-summary.ts";

function summary(stages: ToolSummary["stages"] = []): ToolSummary {
  return {
    projectId: "project",
    generatedAt: "2026-09-23T00:00:00Z",
    stages,
    bitstream: { generated: false, jobId: null, at: null },
    timing: null,
  };
}

describe("engineering overview evidence", () => {
  test("historical metrics and lifetime counts remain visible without passing current checks", () => {
    const timing = { wns: 0.591, tns: 0, whs: 0.042, status: "met" as const, clocks: ["clk"], sourceJobId: "old-job", parsedAt: "2026-10-01T00:00:00Z" };
    const resources = { device: "old-part", design: "old-design", sourceJobId: "old-job", sourceOperation: "implement" as const, sourceAt: timing.parsedAt, reportName: "resources.rpt", configEpoch: null, metrics: [] };
    const data: ToolSummary = { ...summary(), configEpoch: 2, validationState: "pending", history: {
      runCount: 90, succeeded: 37, failed: 40, timing, timingSource: { configEpoch: null, at: timing.parsedAt }, resources,
    } };
    expect(overviewMetrics(data)).toMatchObject({ timing, resources, timingHistorical: true, resourcesHistorical: true, runCount: 90 });
    expect(overviewStages(data).every((stage) => stage.state === "idle")).toBeTrue();
    const current = { ...timing, sourceJobId: "current-job", wns: -1, status: "failed" as const };
    expect(overviewMetrics({ ...data, timing: current, resources })).toMatchObject({ timing: current, timingHistorical: false, resourcesHistorical: false });
    expect(overviewMetrics(null)).toMatchObject({ timing: null, resources: null, runCount: null });
  });
  test("unavailable data differs from an available project with no runs", () => {
    expect(overviewStages(null).every((stage) => stage.state === "unknown")).toBeTrue();
    expect(overviewStages(summary()).every((stage) => stage.state === "idle")).toBeTrue();
  });

  test("a latest failure remains a failure despite historical successes", () => {
    const stages = overviewStages(summary([{
      operation: "simulate", state: "failed", succeeded: 12, failed: 1,
      lastJobId: "failed-job", lastAt: "2026-09-23T00:00:00Z",
    }]));
    const simulation = stages.find((stage) => stage.key === "simulate")!;
    expect(simulation.state).toBe("failed");
    expect(simulation.succeeded).toBe(12);
    expect(simulation.jobId).toBe("failed-job");
    expect(stages.filter((stage) => stage.state === "passed")).toHaveLength(0);
  });

  test("pending, incomplete and unknown outcomes never count as passed", () => {
    for (const state of ["submitted", "queued", "preparing", "running", "cancelling"]) {
      expect(overviewState(state)).toBe("running");
    }
    for (const state of ["failed", "timeout", "lost", "unknown_effect", "rejected"]) {
      expect(overviewState(state)).toBe("failed");
    }
    expect(overviewState("cancelled")).toBe("stopped");
    expect(overviewState("future-status")).toBe("unknown");
    expect(overviewState("succeeded")).toBe("passed");
  });

  test("STA or bitstream evidence does not imply the four checks passed", () => {
    const data = summary([{
      operation: "report_sta", state: "succeeded", succeeded: 1, failed: 0,
      lastJobId: "sta-job", lastAt: null,
    }]);
    expect(overviewStages({ ...data, bitstream: { generated: true, jobId: "bitstream-job", at: null } })
      .every((stage) => stage.state === "idle")).toBeTrue();
  });

  test("mock aggregation deduplicates jobs shared across runs and isolates empty projects", () => {
    const detail = mockAgentDetail(mockAgents()[0]!.agent_id)!;
    const single = mockToolSummary("p1", [detail]);
    const duplicate = mockToolSummary("p1", [detail, detail]);
    expect(duplicate.stages).toEqual(single.stages);
    expect(single.stages.some((stage) => stage.succeeded > 0)).toBeTrue();
    expect(mockToolSummary("new-project", []).stages.every((stage) => stage.state === "never")).toBeTrue();
    expect(single.timing).toBeNull();
  });
});
