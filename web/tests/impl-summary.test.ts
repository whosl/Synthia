import { describe, expect, test } from "bun:test";
import { formatNs, implCells, implChipText, implProgressText, timingStatusTone } from "../src/domain/impl-summary.ts";
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

function stage(operation: "validate_sources" | "simulate" | "synthesize" | "implement" | "report_sta", state: string, ok = 0, fail = 0) {
  return { operation, state, lastJobId: null, lastAt: null, succeeded: ok, failed: fail };
}

describe("implCells", () => {
  test("六行齐全：四阶段 + 码流 + STA；未开始时全部 never", () => {
    const cells = implCells(summary());
    expect(cells.map(c => c.key)).toEqual(["validate", "simulate", "synthesize", "implement", "bitstream", "sta"]);
    expect(cells.every(c => c.state === "never")).toBeTrue();
  });

  test("真实形态（p15）：四阶段 succeeded、码流未生成按 never 展示", () => {
    const cells = implCells(summary({
      stages: [
        stage("validate_sources", "succeeded", 2, 0),
        stage("simulate", "succeeded", 1, 5),
        stage("synthesize", "succeeded", 1, 0),
        stage("implement", "succeeded", 3, 1),
      ],
    }));
    expect(cells.filter(c => c.key !== "bitstream" && c.key !== "sta").every(c => c.state === "succeeded")).toBeTrue();
    expect(cells[4]!.state).toBe("never"); // 探索流没要码流：不是失败，是未生成
    expect(cells[1]!.detail).toBe("1✓/5✗");
  });

  test("码流生成后 bitstream 为 succeeded；STA 行跟随 report_sta 计数", () => {
    const cells = implCells(summary({
      bitstream: { generated: true, jobId: "j1", at: "x" },
      stages: [stage("report_sta", "failed", 0, 2)],
    }));
    expect(cells[4]!.state).toBe("succeeded");
    expect(cells[5]!.state).toBe("failed");
    expect(cells[5]!.detail).toBe("0✓/2✗");
  });

  test("旧 Core 没有 report_sta 阶段时 STA 行回退 never（向前兼容）", () => {
    const cells = implCells(summary({
      stages: [stage("validate_sources", "succeeded", 1, 0)],
    }));
    expect(cells[5]!.key).toBe("sta");
    expect(cells[5]!.state).toBe("never");
  });
});

describe("implProgressText", () => {
  test("未开始 / 推进到某格 / 全通过", () => {
    expect(implProgressText(summary())).toBe("尚未开始物理实现");
    expect(implProgressText(summary({ stages: [stage("validate_sources", "succeeded", 1, 0)] }))).toBe("推进到：代码校验");
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

  test("STA 不参与管线归纳：只跑了 STA 也不算推进", () => {
    expect(implProgressText(summary({ stages: [stage("report_sta", "succeeded", 1, 0)] }))).toBe("尚未开始物理实现");
  });
});

describe("implChipText", () => {
  test("未开始 / 成功计数 / 失败计数", () => {
    expect(implChipText(summary())).toBe("未开始");
    expect(implChipText(summary({ stages: [stage("implement", "succeeded", 4, 0)] }))).toBe("布局布线 4✓");
    expect(implChipText(summary({ stages: [stage("simulate", "failed", 0, 4)] }))).toBe("仿真 4✗");
  });

  test("最深到达格优先；未产出码流不算到达（探索流）；STA 不参与最深归纳", () => {
    const p4 = summary({
      stages: [
        stage("validate_sources", "succeeded", 6, 0),
        stage("simulate", "failed", 5, 1),
        stage("synthesize", "failed", 5, 2),
        stage("implement", "succeeded", 4, 0),
      ],
    });
    expect(implChipText(p4)).toBe("布局布线 4✓");
    expect(implChipText(summary({ stages: [stage("report_sta", "succeeded", 2, 0)] }))).toBe("未开始");
  });

  test("formal 码流生成后 chip 显示码流 ✓；运行中显示运行中", () => {
    const formal = summary({
      stages: [stage("implement", "succeeded", 4, 0)],
      bitstream: { generated: true, jobId: "j", at: "t" },
    });
    expect(implChipText(formal)).toBe("码流 ✓");
    expect(implChipText(summary({ stages: [stage("synthesize", "running", 0, 0)] }))).toBe("综合 · 运行中");
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
