import { describe, expect, test } from "bun:test";
import {
  BASELINE_KINDS,
  GATE_TO_BASELINE,
  GATES,
  MILESTONE_GATES,
  currentGate,
  deriveGateLanes,
  isMilestoneGate,
  makeBaselineId,
  submissionToLaneState,
  type GateId,
} from "../src/domain/gates.ts";

describe("里程碑门 → 基线映射（与 core enums 一致）", () => {
  test("G1/G3/G4/G7/G9 → B0/B1/B2/B3/B4", () => {
    expect(GATE_TO_BASELINE).toEqual({ G1: "B0", G3: "B1", G4: "B2", G7: "B3", G9: "B4" });
    expect(MILESTONE_GATES).toEqual(["G1", "G3", "G4", "G7", "G9"]);
    for (const gate of MILESTONE_GATES) {
      expect(isMilestoneGate(gate)).toBe(true);
      expect(BASELINE_KINDS).toContain(GATE_TO_BASELINE[gate]!);
    }
  });

  test("非里程碑门无基线", () => {
    for (const gate of GATES) {
      if (!(MILESTONE_GATES as readonly string[]).includes(gate)) {
        expect(GATE_TO_BASELINE[gate]).toBeUndefined();
      }
    }
  });
});

describe("makeBaselineId", () => {
  test("格式 bl-<gate小写>-<时间戳>", () => {
    expect(makeBaselineId("G3", 1700000000000)).toBe("bl-g3-1700000000000");
    expect(makeBaselineId("G9", 1)).toBe("bl-g9-1");
  });
});

describe("门禁泳道状态推导", () => {
  test("提交状态映射：in_review/submitted/checking=审批中，approved=已批准，rejected=被驳回，preparing/withdrawn=未开始", () => {
    expect(submissionToLaneState("in_review")).toBe("in_review");
    expect(submissionToLaneState("submitted")).toBe("in_review");
    expect(submissionToLaneState("checking")).toBe("in_review");
    expect(submissionToLaneState("approved")).toBe("approved");
    expect(submissionToLaneState("rejected")).toBe("rejected");
    expect(submissionToLaneState("preparing")).toBe("not_started");
    expect(submissionToLaneState("withdrawn")).toBe("not_started");
  });

  test("无提交 = 未开始；同一门取最新提交", () => {
    const lanes = deriveGateLanes([
      { id: "s1", gate: "G1", state: "rejected", created_at: "2026-08-01T00:00:00Z" },
      { id: "s2", gate: "G1", state: "in_review", created_at: "2026-08-02T00:00:00Z" },
      { id: "s3", gate: "G0", state: "approved", created_at: "2026-07-01T00:00:00Z" },
    ]);
    expect(lanes.G0).toBe("approved");
    expect(lanes.G1).toBe("in_review"); // 最新提交覆盖旧的 rejected
    expect(lanes.G2).toBe("not_started");
    expect(lanes.G9).toBe("not_started");
  });

  test("当前门 = 第一个未批准的门；全批准为 null", () => {
    const lanes = deriveGateLanes([
      { id: "s0", gate: "G0", state: "approved", created_at: "2026-07-01T00:00:00Z" },
      { id: "s1", gate: "G1", state: "approved", created_at: "2026-07-02T00:00:00Z" },
      { id: "s2", gate: "G2", state: "rejected", created_at: "2026-07-03T00:00:00Z" },
    ]);
    expect(currentGate(lanes)).toBe("G2");

    const all = deriveGateLanes(
      GATES.map((gate: GateId, i) => ({
        id: `s-${gate}`,
        gate,
        state: "approved",
        created_at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      })),
    );
    expect(currentGate(all)).toBeNull();
  });
});
