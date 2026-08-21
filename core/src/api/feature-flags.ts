/**
 * Core feature flags.
 *
 * P2 historical-material writes are deliberately opt-in. Read endpoints stay
 * available while the flag is off so operators can inspect already-imported
 * snapshots and retain an audit/rollback path.
 */

export interface CoreFeatureFlags {
  readonly historicalMaterials: boolean;
}

export interface CoreFeatureFlagOptions {
  /** Per-process overrides, primarily for tests and embedded servers. */
  readonly features?: Readonly<Partial<CoreFeatureFlags>>;
  /** Environment source. Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
}

export const DISABLED_CORE_FEATURE_FLAGS: CoreFeatureFlags = Object.freeze({
  historicalMaterials: false,
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
  return Object.freeze({ historicalMaterials });
}
