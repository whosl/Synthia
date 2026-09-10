import { describe, expect, test } from "bun:test";
import { formatNs, implCells, implProgressText, timingStatusTone } from "../src/domain/impl-summary.ts";
import type { ToolSummary } from "../src/api/types.ts";

function summary(partial: Partial<ToolSummary> = {}): ToolSummary {
  return {
    projectId: "p-test",
    generatedAt: "2026-09-10T00:00:00Z",
    stages: [],
    bitstream: { generated: false, jobId: null, at: null },
    timing: null,
    ...partial,
  };
}

function stage(operation: "validate_sources" | "simulate" | "synthesize" | "implement", state: string, ok = 0, fail = 0) {
  return { operation, state, lastJobId: null, lastAt: null, succeeded: ok, failed: fail };
}

describe("implCells", () => {
  test("五格齐全：四阶段 + 码流；未开始时全部 never", () => {
    const cells = implCells(summary());
    expect(cells.map(c => c.key)).toEqual(["validate", "simulate", "synthesize", "implement", "bitstream"]);
    expect(cells.every(c => c.state === "never")).toBeTrue();
  });

  test("真实形态（p15）：四阶段 succeeded、码流因探索流未生成", () => {
    const cells = implCells(summary({
      stages: [
        stage("validate_sources", "succeeded", 2, 0),
        stage("simulate", "succeeded", 1, 5),
        stage("synthesize", "succeeded", 1, 0),
        stage("implement", "succeeded", 3, 1),
      ],
    }));
    expect(cells.filter(c => c.key !== "bitstream").every(c => c.state === "succeeded")).toBeTrue();
    expect(cells[4]!.state).toBe("failed"); // 有实现但无码流 → failed 态（探索流语义）
    expect(cells[1]!.detail).toBe("1✓/5✗");
  });

  test("formal 码流生成后 bitstream 为 succeeded", () => {
    const cells = implCells(summary({ bitstream: { generated: true, jobId: "j1", at: "x" } }));
    expect(cells[4]!.state).toBe("succeeded");
  });
});

describe("implProgressText", () => {
  test("未开始 / 推进到某格 / 全通过", () => {
    expect(implProgressText(summary())).toBe("尚未开始物理实现");
    expect(implProgressText(summary({ stages: [stage("validate_sources", "succeeded", 1, 0)] }))).toBe("推进到：源校验");
    const full = summary({
      stages: [
        stage("validate_sources", "succeeded"),
        stage("simulate", "succeeded"),
        stage("synthesize", "succeeded"),
        stage("implement", "succeeded"),
      ] as never,
      bitstream: { generated: true, jobId: "j", at: "t" },
    });
    expect(implProgressText(full)).toBe("全流程通过（含码流）");
  });
});

describe("timing 语义", () => {
  test("tone 与 formatNs", () => {
    expect(timingStatusTone("met")).toBe("ok");
    expect(timingStatusTone("failed")).toBe("bad");
    expect(timingStatusTone("unconstrained")).toBe("muted");
    expect(timingStatusTone("unknown")).toBe("muted");
    expect(formatNs(null)).toBe("—");
    expect(formatNs(4.98)).toBe("+4.98");
    expect(formatNs(-0.1234)).toBe("-0.123");
    expect(formatNs(0)).toBe("0");
  });
});
