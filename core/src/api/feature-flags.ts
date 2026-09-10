/**
 * Core feature flags.
 *
 * P2 historical-material writes are deliberately opt-in. Read endpoints stay
 * available while the flag is off so operators can inspect already-imported
 * snapshots and retain an audit/rollback path.
 */

export interface CoreFeatureFlags {
  readonly historicalMaterials: boolean;
  /** P3 side-task workspaces and adoption writes. */
  readonly sideTasks: boolean;
  /** P4 formal G0-G4 execution, bitstream classification, and delivery writes. */
  readonly formalDelivery: boolean;
  /** Self-evolution Learned Skill creation, discovery, application, and curation. */
  readonly selfEvolution: boolean;
  /** Runs recovery/retention dispatcher duties; independently default-off. */
  readonly evolutionEvalDispatcherHost: boolean;
  /** Allows new external evolution_eval effects; independently default-off. */
  readonly evolutionEvalExecution: boolean;
}

export interface EvolutionEvalExecutionPlane {
  readonly dispatcherHostEnabled: boolean;
  readonly allowNewEffects: boolean;
  readonly rolloutEnabled: boolean;
}

export interface CoreFeatureFlagOptions {
  /** Per-process overrides, primarily for tests and embedded servers. */
  readonly features?: Readonly<Partial<CoreFeatureFlags>>;
  /** Environment source. Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
}

export const DISABLED_CORE_FEATURE_FLAGS: CoreFeatureFlags = Object.freeze({
  historicalMaterials: false,
  sideTasks: false,
  formalDelivery: false,
  selfEvolution: false,
  evolutionEvalDispatcherHost: false,
  evolutionEvalExecution: false,
});

/** Parse a boolean environment flag without accepting ambiguous spellings. */
export function parseBooleanFeatureFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

/** Resolve Core flags, with typed injection taking precedence over env. */
export function resolveCoreFeatureFlags(options: CoreFeatureFlagOptions = {}): CoreFeatureFlags {
  const injected = options.features?.historicalMaterials;
  if (injected !== undefined && typeof injected !== "boolean") {
    throw new TypeError("features.historicalMaterials must be a boolean");
  }
  const historicalMaterials = injected ?? parseBooleanFeatureFlag(
    "SYNTHIA_FEATURE_HISTORICAL_MATERIALS",
    (options.env ?? process.env).SYNTHIA_FEATURE_HISTORICAL_MATERIALS,
  );
  const injectedSideTasks = options.features?.sideTasks;
  if (injectedSideTasks !== undefined && typeof injectedSideTasks !== "boolean") {
    throw new TypeError("features.sideTasks must be a boolean");
  }
  const sideTasks = injectedSideTasks ?? parseBooleanFeatureFlag(
    "SYNTHIA_FEATURE_SIDE_TASKS",
    (options.env ?? process.env).SYNTHIA_FEATURE_SIDE_TASKS,
  );
  const injectedFormalDelivery = options.features?.formalDelivery;
  if (injectedFormalDelivery !== undefined && typeof injectedFormalDelivery !== "boolean") {
    throw new TypeError("features.formalDelivery must be a boolean");
  }
  const formalDelivery = injectedFormalDelivery ?? parseBooleanFeatureFlag(
    "SYNTHIA_FEATURE_FORMAL_DELIVERY",
    (options.env ?? process.env).SYNTHIA_FEATURE_FORMAL_DELIVERY,
  );
  const injectedSelfEvolution = options.features?.selfEvolution;
  if (injectedSelfEvolution !== undefined && typeof injectedSelfEvolution !== "boolean") {
    throw new TypeError("features.selfEvolution must be a boolean");
  }
  const selfEvolution = injectedSelfEvolution ?? parseBooleanFeatureFlag(
    "SYNTHIA_FEATURE_SELF_EVOLUTION",
    (options.env ?? process.env).SYNTHIA_FEATURE_SELF_EVOLUTION,
  );
  const injectedEvolutionEvalDispatcherHost = options.features?.evolutionEvalDispatcherHost;
  if (
    injectedEvolutionEvalDispatcherHost !== undefined
    && typeof injectedEvolutionEvalDispatcherHost !== "boolean"
  ) {
    throw new TypeError("features.evolutionEvalDispatcherHost must be a boolean");
  }
  const evolutionEvalDispatcherHost = injectedEvolutionEvalDispatcherHost
    ?? parseBooleanFeatureFlag(
      "SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST",
      (options.env ?? process.env).SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST,
    );
  const injectedEvolutionEvalExecution = options.features?.evolutionEvalExecution;
  if (
    injectedEvolutionEvalExecution !== undefined
    && typeof injectedEvolutionEvalExecution !== "boolean"
  ) {
    throw new TypeError("features.evolutionEvalExecution must be a boolean");
  }
  const evolutionEvalExecution = injectedEvolutionEvalExecution ?? parseBooleanFeatureFlag(
    "SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION",
    (options.env ?? process.env).SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION,
  );
  return Object.freeze({
    historicalMaterials,
    sideTasks,
    formalDelivery,
    selfEvolution,
    evolutionEvalDispatcherHost,
    evolutionEvalExecution,
  });
}

/**
 * Resolve the three independent rollout gates used by the dispatcher host.
 *
 * Pause is deliberately absent: it is durable database policy and is checked
 * again by the dispatcher immediately before every new effect. Startup flags
 * cannot cache or override it.
 */
export function resolveEvolutionEvalExecutionPlane(
  flags: Pick<
    CoreFeatureFlags,
    "evolutionEvalDispatcherHost" | "evolutionEvalExecution" | "selfEvolution"
  >,
): EvolutionEvalExecutionPlane {
  const dispatcherHostEnabled = flags.evolutionEvalDispatcherHost;
  const allowNewEffects = flags.evolutionEvalExecution;
  const rolloutEnabled = flags.selfEvolution;
  if (allowNewEffects && !dispatcherHostEnabled) {
    throw new Error(
      "SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION requires "
      + "SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST",
    );
  }
  if (allowNewEffects && !rolloutEnabled) {
    throw new Error(
      "SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION requires "
      + "SYNTHIA_FEATURE_SELF_EVOLUTION",
    );
  }
  return Object.freeze({
    dispatcherHostEnabled,
    allowNewEffects,
    rolloutEnabled,
  });
}
