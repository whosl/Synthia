import { describe, expect, test } from "bun:test";
import {
  parseBooleanFeatureFlag,
  resolveCoreFeatureFlags,
} from "../src/api/feature-flags.ts";

describe("Core feature flags", () => {
  test("historical materials are explicit opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: {} })).toEqual({ historicalMaterials: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "" } })).toEqual({ historicalMaterials: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" } })).toEqual({ historicalMaterials: true });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "true" } })).toEqual({ historicalMaterials: true });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "0" } })).toEqual({ historicalMaterials: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "false" } })).toEqual({ historicalMaterials: false });
  });

  test("rejects ambiguous environment spellings", () => {
    for (const value of ["TRUE", "yes", "on", " 1", "1 ", "2"]) {
      expect(() => parseBooleanFeatureFlag("FEATURE", value)).toThrow("must be one of");
    }
  });

  test("typed injection is isolated from ambient environment", () => {
    expect(resolveCoreFeatureFlags({
      features: { historicalMaterials: true },
      env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "invalid" },
    })).toEqual({ historicalMaterials: true });
    expect(resolveCoreFeatureFlags({
      features: { historicalMaterials: false },
      env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" },
    })).toEqual({ historicalMaterials: false });
    expect(() => resolveCoreFeatureFlags({
      features: { historicalMaterials: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
  });
});
