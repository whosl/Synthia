import { describe, expect, test } from "bun:test";
import type { ProcessProfileV1, ProcessStateV1 } from "../src/api/types.ts";
import {
  currentProcessGate,
  deriveProcessGateChain,
  parseAndVerifyProcessProfile,
  parseProcessProfile,
  parseProcessState,
  processProgress,
  ProcessContractError,
} from "../src/domain/process-profile.ts";
import { sha256Hex } from "../src/util/sha256.ts";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, sortKeys(row[key])]));
  }
  return value;
}

async function profileFixture(): Promise<ProcessProfileV1> {
  const body = {
    schema: "process-profile.v1" as const,
    id: "GJB_REF_V1" as const,
    version: "GJB_REF_V1" as const,
    name: "GJB 参考流程 v1",
    nodes: [
      { id: "G0" as const, kind: "gate" as const, ordinal: 0, name: "项目准备", goal: "冻结准备事实", activities: ["prepare_project"], requiredChecks: [{ code: "project.engineering", severity: "hard" as const }], milestoneBaseline: null },
      { id: "G1" as const, kind: "gate" as const, ordinal: 1, name: "需求确认", goal: "确认需求", activities: ["intake"], requiredChecks: [{ code: "artifact.requirements", severity: "hard" as const }], milestoneBaseline: "B0" as const },
      { id: "G2" as const, kind: "gate" as const, ordinal: 2, name: "验证方案", goal: "确认行为", activities: ["behavior_wave"], requiredChecks: [{ code: "artifact.behavior", severity: "hard" as const }], milestoneBaseline: null },
      { id: "G3" as const, kind: "gate" as const, ordinal: 3, name: "设计确认", goal: "确认设计", activities: ["architecture"], requiredChecks: [{ code: "artifact.design", severity: "hard" as const }], milestoneBaseline: "B1" as const },
      { id: "G4" as const, kind: "gate" as const, ordinal: 4, name: "实现与交付", goal: "密封正式交付", activities: ["implement"], requiredChecks: [{ code: "bitstream.formal", severity: "hard" as const }], milestoneBaseline: "B2" as const },
    ],
  };
  return { ...body, profileHash: await sha256Hex(JSON.stringify(sortKeys(body))) };
}

function stateFixture(overrides: Partial<ProcessStateV1> = {}): ProcessStateV1 {
  return {
    schema: "process-state.v1",
    projectId: "p1",
    processInstanceId: "pi-1",
    profileId: "GJB_REF_V1",
    profileHash: "0".repeat(64),
    workVersionId: "wv-1",
    currentGate: "G2",
    completed: false,
    readiness: null,
    ...overrides,
  };
}

describe("process-profile.v1 strict boundary", () => {
  test("accepts one hash-verified Core G0-G4 profile", async () => {
    const profile = await profileFixture();
    expect(await parseAndVerifyProcessProfile(profile)).toEqual(profile);
    expect(profile.nodes.map((node) => node.id)).toEqual(["G0", "G1", "G2", "G3", "G4"]);
  });

  test("rejects extra fields, G5+, duplicate/out-of-order gates, and invalid baselines", async () => {
    const profile = await profileFixture();
    expect(() => parseProcessProfile({ ...profile, legacyNodes: [] })).toThrow(ProcessContractError);
    expect(() => parseProcessProfile({ ...profile, nodes: [...profile.nodes, { ...profile.nodes[4], id: "G5", ordinal: 5 }] })).toThrow(ProcessContractError);
    expect(() => parseProcessProfile({ ...profile, nodes: profile.nodes.map((node, index) => index === 2 ? { ...node, id: "G3" } : node) })).toThrow(ProcessContractError);
    expect(() => parseProcessProfile({ ...profile, nodes: profile.nodes.map((node, index) => index === 3 ? { ...node, milestoneBaseline: "B2" } : node) })).toThrow(ProcessContractError);
  });

  test("tampering any profile fact after hashing fails closed", async () => {
    const profile = await profileFixture();
    await expect(parseAndVerifyProcessProfile({ ...profile, name: "被静默改写" })).rejects.toThrow("流程定义摘要校验失败");
  });
});

describe("process-state.v1 projection", () => {
  test("strictly checks project identity, exact fields, gate domain, and completed=G4", () => {
    const state = stateFixture();
    expect(parseProcessState(state, "p1")).toEqual(state);
    expect(() => parseProcessState(state, "p2")).toThrow("其他项目");
    expect(() => parseProcessState({ ...state, currentGate: "G5" }, "p1")).toThrow("G0-G4");
    expect(() => parseProcessState({ ...state, completed: true }, "p1")).toThrow("完成态");
    expect(() => parseProcessState({ ...state, runtimeStage: "rtl" }, "p1")).toThrow("字段不符合");
  });

  test("loading/current/gated/failed/completed states stay Core-driven", async () => {
    const profile = await profileFixture();
    expect(deriveProcessGateChain(null, null)).toBeNull();

    const current = deriveProcessGateChain(profile, stateFixture({ profileHash: profile.profileHash }));
    expect(current?.map((entry) => entry.status)).toEqual(["done", "done", "current", "pending", "pending"]);
    expect(processProgress(current!)).toEqual({ done: 2, total: 5 });
    expect(currentProcessGate(current)?.node.id).toBe("G2");

    const gated = deriveProcessGateChain(profile, stateFixture({ profileHash: profile.profileHash }), { G2: "in_review" });
    expect(currentProcessGate(gated)?.status).toBe("gated");

    const failed = deriveProcessGateChain(profile, stateFixture({ profileHash: profile.profileHash }), { G2: "rejected" });
    expect(currentProcessGate(failed)?.status).toBe("failed");

    const completed = deriveProcessGateChain(profile, stateFixture({ profileHash: profile.profileHash, currentGate: "G4", completed: true }));
    expect(completed?.every((entry) => entry.status === "done")).toBe(true);
    expect(processProgress(completed!)).toEqual({ done: 5, total: 5 });
  });

  test("profile/state hash mismatch never produces a mixed stage chain", async () => {
    const profile = await profileFixture();
    expect(() => deriveProcessGateChain(profile, stateFixture({ profileHash: "f".repeat(64) }))).toThrow("摘要不一致");
  });
});
