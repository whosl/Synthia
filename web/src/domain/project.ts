import type { Project, ProjectType as ApiProjectType } from "../api/types.ts";

export type ProjectType = ApiProjectType;

export const GJB_REF_V1_ID = "GJB_REF_V1";
export const GJB_REF_V1_NAME = "GJB 参考流程 v1";
export const LEGACY_COMPAT_ID = "LEGACY_COMPAT";
export const LEGACY_COMPAT_NAME = "兼容旧流程";

/**
 * 新字段缺失通常意味着迁移前的项目，而不是自由项目。按工程兼容项
 * 展示可以保留其历史阶段和流程信息；未知值也按工程处理，避免把旧
 * 工程误当成自由项目而隐藏治理状态。
 */
export function projectType(project: { readonly project_type?: string | null }): ProjectType {
  return project.project_type === "free" ? "free" : "engineering";
}

export function projectTypeText(type: ProjectType): string {
  return type === "free" ? "自由项目" : "工程项目";
}

export function isLegacyCompatProject(project: {
  readonly project_type?: string | null;
  readonly process_profile_id?: string | null;
  readonly process_version_id?: string | null;
}): boolean {
  if (project.project_type === "free") return false;
  const id = project.process_profile_id ?? project.process_version_id;
  return id === LEGACY_COMPAT_ID || !id;
}

export function processVersionText(project: {
  readonly project_type?: Project["project_type"] | null;
  readonly process_profile_name?: string | null;
  readonly process_profile_version?: string | null;
  readonly process_profile_id?: string | null;
  readonly process_version_id?: string | null;
}): string {
  // An explicitly free project has no process by design.  A missing type is
  // the legacy shape and is intentionally handled as LEGACY_COMPAT below.
  if (project.project_type === "free") return "—";
  const id = project.process_profile_id ?? project.process_version_id;
  // Never let a stale display snapshot make a compatibility project look like
  // the current GJB reference flow.
  if (id === LEGACY_COMPAT_ID) return LEGACY_COMPAT_NAME;
  if (project.process_profile_name) {
    return project.process_profile_version && !project.process_profile_name.endsWith(project.process_profile_version)
      ? `${project.process_profile_name} · ${project.process_profile_version}`
      : project.process_profile_name;
  }
  if (id === GJB_REF_V1_ID) return GJB_REF_V1_NAME;
  if (!id) return LEGACY_COMPAT_NAME;
  return id;
}

export interface CreateProjectForm {
  readonly name: string;
  readonly projectType: ProjectType | null;
  readonly processProfileId: string;
  readonly targetPart: string;
  readonly availableProcessProfileIds: readonly string[];
}

export function validateCreateProject(form: CreateProjectForm): string | null {
  if (!form.projectType) return "请选择项目类型。";
  if (!form.name.trim()) return "请填写项目名称。";
  if (form.projectType === "engineering") {
    const selected = form.processProfileId.trim();
    if (!selected) return "工程项目必须选择流程版本。";
    if (!form.availableProcessProfileIds.includes(selected)) return "所选流程版本当前不可用，请重新加载。";
  }
  return null;
}
