import { describe, expect, test } from "bun:test";
import { deriveStageChain, STAGE_CHAIN, type StageChainNode } from "../src/domain/tasks.ts";
import {
  currentStageSummary,
  EXEC_MILESTONE_GATES,
  FPGA_FULL_PROFILE,
  gateNode,
  overallProgress,
  PROCESS_PROFILES,
  segmentAllNodeIds,
  segmentIndexOf,
  segmentProgress,
  segmentStatus,
  STAGE_SEGMENTS,
} from "../src/domain/process-profile.ts";

describe("ProcessProfile", () => {
  test("第一轮只有 fpga-full 一套，nodes 等于 STAGE_CHAIN（15 节点）", () => {
    expect(PROCESS_PROFILES.map((p) => p.id)).toEqual(["fpga-full"]);
    expect(FPGA_FULL_PROFILE.id).toBe("fpga-full");
    expect(FPGA_FULL_PROFILE.nodes).toBe(STAGE_CHAIN);
    expect(FPGA_FULL_PROFILE.nodes.length).toBe(15);
  });
});

describe("里程碑门约束", () => {
  test("执行链里程碑门只有 G1/G3/G4，不含 gates.ts 的 G7/G9", () => {
    expect(EXEC_MILESTONE_GATES).toEqual(["G1", "G3", "G4"]);
    expect(EXEC_MILESTONE_GATES).not.toContain("G7" as never);
    expect(EXEC_MILESTONE_GATES).not.toContain("G9" as never);
  });

  test("普通门 G2 不是段终点（不在 EXEC_MILESTONE_GATES 中），但出现在段2的中间节点里", () => {
    expect(EXEC_MILESTONE_GATES).not.toContain("G2" as never);
    expect(STAGE_SEGMENTS[1]!.middleNodeIds).toContain("G2");
  });

  test("gateNode 返回 STAGE_CHAIN 里的门节点对象", () => {
    expect(gateNode("G1").name).toBeTruthy();
    expect(gateNode("G1").kind).toBe("gate");
    expect(gateNode("G3").id).toBe("G3");
    expect(gateNode("G4").id).toBe("G4");
  });
});

describe("三段切分（spec §3.1 表格）", () => {
  test("段1：中间节点 intake，终点 G1", () => {
    const seg = STAGE_SEGMENTS[0]!;
    expect(seg.index).toBe(1);
    expect(seg.middleNodeIds).toEqual(["intake"]);
    expect(seg.gateId).toBe("G1");
  });

  test("段2：中间节点 behavior_wave/G2/architecture/register_spec，终点 G3", () => {
    const seg = STAGE_SEGMENTS[1]!;
    expect(seg.index).toBe(2);
    expect(seg.middleNodeIds).toEqual(["behavior_wave", "G2", "architecture", "register_spec"]);
    expect(seg.gateId).toBe("G3");
  });

  test("段3：中间节点 rtl/validate/tb/simulate/xdc/synthesize/implement，终点 G4", () => {
    const seg = STAGE_SEGMENTS[2]!;
    expect(seg.index).toBe(3);
    expect(seg.middleNodeIds).toEqual([
      "rtl", "validate", "tb", "simulate", "xdc", "synthesize", "implement",
    ]);
    expect(seg.gateId).toBe("G4");
  });

  test("三段合并（含终点门）恰好覆盖全部 15 个节点，顺序与 STAGE_CHAIN 一致，无遗漏无重复", () => {
    const merged = STAGE_SEGMENTS.flatMap((s) => segmentAllNodeIds(s));
    expect(merged).toEqual(STAGE_CHAIN.map((n) => n.id));
  });

  test("segmentIndexOf：段内任意节点（含终点门）都能定位到正确段序号", () => {
    expect(segmentIndexOf("intake")).toBe(1);
    expect(segmentIndexOf("G1")).toBe(1);
    expect(segmentIndexOf("behavior_wave")).toBe(2);
    expect(segmentIndexOf("G2")).toBe(2);
    expect(segmentIndexOf("register_spec")).toBe(2);
    expect(segmentIndexOf("G3")).toBe(2);
    expect(segmentIndexOf("rtl")).toBe(3);
    expect(segmentIndexOf("implement")).toBe(3);
    expect(segmentIndexOf("G4")).toBe(3);
  });
});

// ─── 进度推导 ───────────────────────────────────────────────────────────

function chainFor(currentStage: string | null, status = "running", awaitingGate: string | null = null): StageChainNode[] {
  return deriveStageChain({ status, current_stage: currentStage, awaiting_gate: awaitingGate });
}

describe("segmentProgress / segmentStatus", () => {
  test("running 在 architecture：段2 进度 2/4（behavior_wave、G2 完成，architecture 进行中，register_spec 未开始）", () => {
    const chain = chainFor("architecture");
    const progress = segmentProgress(STAGE_SEGMENTS[1]!, chain);
    expect(progress).toEqual({ done: 2, total: 4, label: "设计" });
    expect(segmentStatus(STAGE_SEGMENTS[1]!, chain)).toBe("running");
  });

  test("running 在 architecture：段1 已全部完成（1/1），状态 done", () => {
    const chain = chainFor("architecture");
    expect(segmentProgress(STAGE_SEGMENTS[0]!, chain)).toEqual({ done: 1, total: 1, label: "需求" });
    expect(segmentStatus(STAGE_SEGMENTS[0]!, chain)).toBe("done");
  });

  test("running 在 architecture：段3 尚未开始（0/7），状态 pending", () => {
    const chain = chainFor("architecture");
    expect(segmentProgress(STAGE_SEGMENTS[2]!, chain)).toEqual({ done: 0, total: 7, label: "实现" });
    expect(segmentStatus(STAGE_SEGMENTS[2]!, chain)).toBe("pending");
  });

  test("running 在 synthesize：段3 进度 5/7（spec 示例「设计 3/4」同类场景，验证「实现 5/7」）", () => {
    const chain = chainFor("synthesize");
    const progress = segmentProgress(STAGE_SEGMENTS[2]!, chain);
    expect(progress).toEqual({ done: 5, total: 7, label: "实现" });
    expect(segmentStatus(STAGE_SEGMENTS[2]!, chain)).toBe("running");
  });

  test("awaiting_approval 在 G3：段2 中间节点全完成（4/4），但整段状态为 waiting（终点门等待批准）", () => {
    const chain = chainFor("register_spec", "awaiting_approval", "G3");
    expect(segmentProgress(STAGE_SEGMENTS[1]!, chain)).toEqual({ done: 4, total: 4, label: "设计" });
    expect(segmentStatus(STAGE_SEGMENTS[1]!, chain)).toBe("waiting");
  });

  test("failed 在 rtl：段3 状态为 failed（即使部分节点 done）", () => {
    const chain = chainFor("rtl", "failed");
    expect(segmentStatus(STAGE_SEGMENTS[2]!, chain)).toBe("failed");
  });

  test("succeeded：全部段状态 done，进度满格", () => {
    const chain = chainFor(null, "succeeded");
    for (const seg of STAGE_SEGMENTS) {
      expect(segmentStatus(seg, chain)).toBe("done");
      const progress = segmentProgress(seg, chain);
      expect(progress.done).toBe(progress.total);
    }
  });

  test("current_stage 为 null 且非终态：全部段 pending，进度 0", () => {
    const chain = chainFor(null, "interrupted");
    for (const seg of STAGE_SEGMENTS) {
      expect(segmentStatus(seg, chain)).toBe("pending");
      expect(segmentProgress(seg, chain).done).toBe(0);
    }
  });
});

describe("overallProgress", () => {
  test("running 在 synthesize：12/15（intake..xdc 12 个节点已完成，synthesize 本身进行中不计入）", () => {
    const chain = chainFor("synthesize");
    expect(overallProgress(chain)).toEqual({ done: 12, total: 15 });
  });

  test("succeeded：15/15", () => {
    expect(overallProgress(chainFor(null, "succeeded"))).toEqual({ done: 15, total: 15 });
  });

  test("全部未开始：0/15", () => {
    expect(overallProgress(chainFor(null, "interrupted"))).toEqual({ done: 0, total: 15 });
  });
});

// ─── 移动端摘要 ─────────────────────────────────────────────────────────

describe("currentStageSummary（移动端一行摘要）", () => {
  test("chain 为 null（尚无 run）：返回 null", () => {
    expect(currentStageSummary(null)).toBeNull();
  });

  test("running 在 rtl：③ RTL 生成 · running · 8/15", () => {
    const chain = chainFor("rtl");
    const summary = currentStageSummary(chain);
    expect(summary).not.toBeNull();
    expect(summary!.segmentIndex).toBe(3);
    expect(summary!.node.id).toBe("rtl");
    expect(summary!.status).toBe("running");
    expect(summary!.done).toBe(7);
    expect(summary!.total).toBe(15);
  });

  test("awaiting_approval 在 G1：① 需求解析（活跃节点是等待批准的门本身）", () => {
    const chain = chainFor("intake", "awaiting_approval", "G1");
    const summary = currentStageSummary(chain);
    expect(summary!.segmentIndex).toBe(1);
    expect(summary!.node.id).toBe("G1");
    expect(summary!.status).toBe("waiting");
  });

  test("failed 在 validate：段3 · failed", () => {
    const chain = chainFor("validate", "failed");
    const summary = currentStageSummary(chain);
    expect(summary!.segmentIndex).toBe(3);
    expect(summary!.node.id).toBe("validate");
    expect(summary!.status).toBe("failed");
  });

  test("succeeded：无活跃节点，退化取最后一个已完成节点 G4，段3", () => {
    const chain = chainFor(null, "succeeded");
    const summary = currentStageSummary(chain);
    expect(summary!.node.id).toBe("G4");
    expect(summary!.status).toBe("done");
    expect(summary!.segmentIndex).toBe(3);
    expect(summary!.done).toBe(15);
    expect(summary!.total).toBe(15);
  });

  test("全部未开始：退化取第一个节点 intake，段1，进度 0/15", () => {
    const chain = chainFor(null, "interrupted");
    const summary = currentStageSummary(chain);
    expect(summary!.node.id).toBe("intake");
    expect(summary!.status).toBe("pending");
    expect(summary!.segmentIndex).toBe(1);
    expect(summary!.done).toBe(0);
  });
});
