import { describe, expect, test } from "bun:test";
import { hashPayload } from "../src/hashing.ts";
import {
  GJB_REF_V1_PROFILE,
  P4_GATE_ORDER,
  isP4Gate,
  nextP4Gate,
} from "../src/services/process-profile.ts";

describe("P4 process profile", () => {
  test("freezes the personal engineering flow to G0 through G4", () => {
    expect(P4_GATE_ORDER).toEqual(["G0", "G1", "G2", "G3", "G4"]);
    expect(GJB_REF_V1_PROFILE.nodes.map((node) => node.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(GJB_REF_V1_PROFILE.nodes.flatMap((node) => node.activities)).toEqual([
      "prepare_project",
      "intake",
      "behavior_wave",
      "verification_plan",
      "architecture",
      "register_spec",
      "constraint_strategy",
      "rtl_build",
      "validate",
      "tb",
      "simulate",
      "xdc",
      "implement",
      "delivery",
    ]);
    expect(GJB_REF_V1_PROFILE.nodes.some((node) => /^G[5-9]$/.test(node.id))).toBe(false);
  });

  test("publishes a canonical profile hash that excludes the hash field itself", () => {
    const { profileHash, ...body } = GJB_REF_V1_PROFILE;
    expect(profileHash).toBe(hashPayload(body));
    expect(profileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("G4 exposes every formal hard stop", () => {
    const g4 = GJB_REF_V1_PROFILE.nodes.find((node) => node.id === "G4")!;
    const codes = g4.requiredChecks.map((check) => check.code);
    expect(codes).toEqual(expect.arrayContaining([
      "artifact.rtl",
      "artifact.testbench",
      "artifact.constraints",
      "formal_input.confirmed",
      "constraints.complete",
      "formal_simulation.succeeded",
      "formal_implementation.succeeded",
      "drc.clean",
      "timing.met",
      "evidence.frozen",
      "bitstream.formal",
      "delivery.manifest_sealed",
    ]));
    expect(g4.requiredChecks.every((check) => check.severity === "hard")).toBe(true);
    expect(g4.milestoneBaseline).toBe("B2");
  });

  test("gate helpers never admit legacy G5-G9 into the v1 flow", () => {
    expect(isP4Gate("G0")).toBe(true);
    expect(isP4Gate("G4")).toBe(true);
    expect(isP4Gate("G5")).toBe(false);
    expect(nextP4Gate("G0")).toBe("G1");
    expect(nextP4Gate("G3")).toBe("G4");
    expect(nextP4Gate("G4")).toBeNull();
  });
});
