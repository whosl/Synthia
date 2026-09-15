import { describe, expect, test } from "bun:test";
import {
  parseBooleanFeatureFlag,
  resolveCoreFeatureFlags,
} from "../src/api/feature-flags.ts";

describe("Core feature flags", () => {
  test("historical materials are explicit opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: {} })).toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" } }))
      .toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "true" } }))
      .toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "0" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "false" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false });
  });

  test("side tasks are independently opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_SIDE_TASKS: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: true, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({
      env: {
        SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "true",
        SYNTHIA_FEATURE_SIDE_TASKS: "false",
      },
    })).toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false });
  });

  test("formal delivery is independently opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_FORMAL_DELIVERY: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: true, selfEvolution: false });
    expect(resolveCoreFeatureFlags({
      env: {
        SYNTHIA_FEATURE_FORMAL_DELIVERY: "true",
        SYNTHIA_FEATURE_SIDE_TASKS: "1",
      },
    })).toEqual({ historicalMaterials: false, sideTasks: true, formalDelivery: true, selfEvolution: false });
  });

  test("self evolution is independently opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_SELF_EVOLUTION: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: true });
  });



  test("rejects ambiguous environment spellings", () => {
    for (const value of ["TRUE", "yes", "on", " 1", "1 ", "2"]) {
      expect(() => parseBooleanFeatureFlag("FEATURE", value)).toThrow("must be one of");
      expect(() => resolveCoreFeatureFlags({
        env: { SYNTHIA_FEATURE_SELF_EVOLUTION: value },
      })).toThrow("must be one of");
    }
  });

  test("typed injection is isolated from ambient environment", () => {
    expect(resolveCoreFeatureFlags({
      features: { historicalMaterials: true },
      env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "invalid" },
    })).toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(resolveCoreFeatureFlags({
      features: { historicalMaterials: false },
      env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" },
    })).toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false });
    expect(() => resolveCoreFeatureFlags({
      features: { historicalMaterials: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
    expect(() => resolveCoreFeatureFlags({
      features: { sideTasks: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
    expect(() => resolveCoreFeatureFlags({
      features: { formalDelivery: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
    expect(() => resolveCoreFeatureFlags({
      features: { selfEvolution: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
  });
});
