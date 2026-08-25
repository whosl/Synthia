import type { ProjectType } from "../api/types.ts";

/** 高风险增量只接受明确的字符串 `1`，其它值一律按关闭处理。 */
export function parseExplicitFeatureFlag(value: unknown): boolean {
  return value === "1";
}

export const HISTORICAL_MATERIALS_FEATURE_ENABLED = parseExplicitFeatureFlag(
  import.meta.env.VITE_FEATURE_HISTORICAL_MATERIALS,
);

export const SIDE_TASKS_FEATURE_ENABLED = parseExplicitFeatureFlag(
  import.meta.env.VITE_FEATURE_SIDE_TASKS,
);

export const FORMAL_DELIVERY_FEATURE_ENABLED = parseExplicitFeatureFlag(
  import.meta.env.VITE_FEATURE_FORMAL_DELIVERY,
);

/** 历史资料库同时受发布开关和工程项目类型约束。 */
export function shouldShowHistoricalMaterials(
  featureEnabled: boolean,
  type: ProjectType | string | null | undefined,
): boolean {
  return featureEnabled && type === "engineering";
}

/** 探索任务对自由/工程项目都可见；未知旧类型仍 fail closed。 */
export function shouldShowSideTasks(
  featureEnabled: boolean,
  type: ProjectType | string | null | undefined,
): boolean {
  return featureEnabled && (type === "engineering" || type === "free");
}

/** P4 write surface is only exposed for its immutable engineering profile. */
export function shouldShowFormalDelivery(
  featureEnabled: boolean,
  type: ProjectType | string | null | undefined,
  processVersionId: string | null | undefined,
): boolean {
  return featureEnabled && type === "engineering" && processVersionId === "GJB_REF_V1";
}
