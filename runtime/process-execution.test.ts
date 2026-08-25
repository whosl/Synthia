import { describe, expect, test } from "bun:test";
import { GJB_REF_V1_PROFILE } from "../core/src/services/process-profile.ts";
import { sha256Hex } from "../core/src/hashing.ts";
import { parseProcessProfile } from "./process-profile.ts";
import {
  assertModernProcessReady,
  assertModernToolModelPolicyHash,
  buildRuntimeProcessPlan,
  firstStageForGate,
  stageAfterGate,
} from "./process-execution.ts";
import type { ProcessStateV1 } from "./types.ts";

const profile = parseProcessProfile(structuredClone(GJB_REF_V1_PROFILE));

function state(overrides: Partial<ProcessStateV1> = {}): ProcessStateV1 {
  return {
    schema: "process-state.v1",
    projectId: "p1",
    processInstanceId: "pi1",
    workVersionId: "wv-1",
    profileId: "GJB_REF_V1",
    profileHash: profile.profileHash,
    currentGate: "G0",
    completed: false,
    readiness: {
      id: "ready-1",
      status: "confirmed",
      ready: true,
      readinessHash: sha256Hex("ready"),
      targetPart: "xc7k70tfbv676-1",
      boardRef: "board-kc705-v1",
      workspaceReady: true,
      dataScopeRecorded: true,
      sourceMaterialsRecorded: true,
      pinConstraintsComplete: false,
      electricalConstraintsComplete: false,
      clockConstraintsComplete: false,
      constraintsComplete: false,
      toolchainProfileHash: sha256Hex("toolchain"),
      constraintRevisionIds: [],
      generatedBy: { type: "runtime", id: "runtime-1" },
      confirmedBy: { id: "human-1", at: "2026-08-24T00:00:00.000Z" },
    },
    ...overrides,
  };
}

describe("profile-driven Runtime execution plan", () => {
  test("derives the complete G0-G4 chain and gate boundaries from the profile", () => {
    const plan = buildRuntimeProcessPlan(profile);
    expect(plan.stages).toEqual([
      "intake",
      "behavior_wave",
      "architecture",
      "register_spec",
      "rtl_build",
      "validate",
      "tb",
      "simulate",
      "xdc",
      "synthesize",
      "implement",
    ]);
    expect(plan.gateAfterStage).toEqual({
      intake: "G1",
      behavior_wave: "G2",
      register_spec: "G3",
      implement: "G4",
    });
    expect(firstStageForGate(plan, "G3")).toBe("architecture");
    expect(stageAfterGate(plan, "G3")).toBe("rtl_build");
    expect(stageAfterGate(plan, "G4")).toBeUndefined();
  });
});

describe("G0 readiness barrier", () => {
  test("requires a lowercase SHA-256 tool/model policy binding for modern execution", () => {
    expect(() => assertModernToolModelPolicyHash(sha256Hex("policy"))).not.toThrow();
    expect(() => assertModernToolModelPolicyHash("synthia-policy-v1"))
      .toThrow("64-character lowercase SHA-256");
    expect(() => assertModernToolModelPolicyHash(sha256Hex("policy").toUpperCase()))
      .toThrow("lowercase SHA-256");
  });

  test("allows confirmed ready even when formal G4 constraints are incomplete", () => {
    expect(() => assertModernProcessReady({
      state: state(), profile, projectId: "p1", processInstanceId: "pi1",
    })).not.toThrow();
  });

  test("fails closed unless readiness is both confirmed and ready", () => {
    for (const readiness of [
      null,
      { ...state().readiness!, status: "draft" as const, ready: true, confirmedBy: null },
      { ...state().readiness!, ready: false },
    ]) {
      expect(() => assertModernProcessReady({
        state: state({ readiness }), profile, projectId: "p1", processInstanceId: "pi1",
      })).toThrow("confirmed and ready");
    }
  });

  test("rejects profile drift and cross-process projections", () => {
    expect(() => assertModernProcessReady({
      state: state({ profileHash: sha256Hex("other") }),
      profile,
      projectId: "p1",
      processInstanceId: "pi1",
    })).toThrow("frozen process profile");
    expect(() => assertModernProcessReady({
      state: state(), profile, projectId: "p1", processInstanceId: "pi-other",
    })).toThrow("does not belong");
  });
});
