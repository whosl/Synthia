import type { ProjectType } from "../api/types.ts";

/** 高风险增量只接受明确的字符串 `1`，其它值一律按关闭处理。 */
export function parseExplicitFeatureFlag(value: unknown): boolean {
  return value === "1";
}

export const HISTORICAL_MATERIALS_FEATURE_ENABLED = parseExplicitFeatureFlag(
  import.meta.env.VITE_FEATURE_HISTORICAL_MATERIALS,
);

/** 历史资料库同时受发布开关和工程项目类型约束。 */
export function shouldShowHistoricalMaterials(
  featureEnabled: boolean,
  type: ProjectType | string | null | undefined,
): boolean {
  return featureEnabled && type === "engineering";
}
