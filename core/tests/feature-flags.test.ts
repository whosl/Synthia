import { describe, expect, test } from "bun:test";
import {
  parseBooleanFeatureFlag,
  resolveCoreFeatureFlags,
  resolveEvolutionEvalExecutionPlane,
} from "../src/api/feature-flags.ts";

describe("Core feature flags", () => {
  test("historical materials are explicit opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: {} })).toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" } }))
      .toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "true" } }))
      .toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "0" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "false" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
  });

  test("side tasks are independently opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_SIDE_TASKS: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: true, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({
      env: {
        SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "true",
        SYNTHIA_FEATURE_SIDE_TASKS: "false",
      },
    })).toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
  });

  test("formal delivery is independently opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_FORMAL_DELIVERY: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: true, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({
      env: {
        SYNTHIA_FEATURE_FORMAL_DELIVERY: "true",
        SYNTHIA_FEATURE_SIDE_TASKS: "1",
      },
    })).toEqual({ historicalMaterials: false, sideTasks: true, formalDelivery: true, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
  });

  test("self evolution is independently opt-in", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_SELF_EVOLUTION: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: true, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
  });

  test("evolution eval execution is independently opt-in and defaults off", () => {
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_SELF_EVOLUTION: "1" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: true, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({ env: { SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION: "true" } }))
      .toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: true });
  });

  test("rejects ambiguous environment spellings", () => {
    for (const value of ["TRUE", "yes", "on", " 1", "1 ", "2"]) {
      expect(() => parseBooleanFeatureFlag("FEATURE", value)).toThrow("must be one of");
      expect(() => resolveCoreFeatureFlags({
        env: { SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION: value },
      })).toThrow("must be one of");
    }
  });

  test("typed injection is isolated from ambient environment", () => {
    expect(resolveCoreFeatureFlags({
      features: { historicalMaterials: true },
      env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "invalid" },
    })).toEqual({ historicalMaterials: true, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
    expect(resolveCoreFeatureFlags({
      features: { historicalMaterials: false },
      env: { SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" },
    })).toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: false });
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
    expect(() => resolveCoreFeatureFlags({
      features: { evolutionEvalExecution: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
    expect(() => resolveCoreFeatureFlags({
      features: { evolutionEvalDispatcherHost: "true" as unknown as boolean },
      env: {},
    })).toThrow("must be a boolean");
    expect(resolveCoreFeatureFlags({
      features: { evolutionEvalExecution: true },
      env: { SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION: "invalid" },
    })).toEqual({ historicalMaterials: false, sideTasks: false, formalDelivery: false, selfEvolution: false, evolutionEvalDispatcherHost: false, evolutionEvalExecution: true });
  });

  test("dispatcher host is independently opt-in and defaults off", () => {
    expect(resolveCoreFeatureFlags({
      env: { SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST: "1" },
    })).toEqual({
      historicalMaterials: false,
      sideTasks: false,
      formalDelivery: false,
      selfEvolution: false,
      evolutionEvalDispatcherHost: true,
      evolutionEvalExecution: false,
    });
  });

  test("execution plane fails closed for all host/new/self/Pause combinations", () => {
    for (const dispatcherHostEnabled of [false, true]) {
      for (const allowNewEffects of [false, true]) {
        for (const rolloutEnabled of [false, true]) {
          for (const learningPaused of [false, true]) {
            const resolve = () => resolveEvolutionEvalExecutionPlane({
              evolutionEvalDispatcherHost: dispatcherHostEnabled,
              evolutionEvalExecution: allowNewEffects,
              selfEvolution: rolloutEnabled,
            });
            if (allowNewEffects && (!dispatcherHostEnabled || !rolloutEnabled)) {
              expect(resolve).toThrow("requires");
              continue;
            }
            const plane = resolve();
            expect(plane).toEqual({
              dispatcherHostEnabled,
              allowNewEffects,
              rolloutEnabled,
            });
            expect(
              plane.dispatcherHostEnabled
              && plane.allowNewEffects
              && plane.rolloutEnabled
              && !learningPaused,
            ).toBe(dispatcherHostEnabled && allowNewEffects && rolloutEnabled && !learningPaused);
          }
        }
      }
    }
  });
});
