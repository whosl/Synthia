import { expect, test } from "bun:test";
import {
  GJB_REF_V1_ID,
  GJB_REF_V1_NAME,
  isLegacyCompatProject,
  LEGACY_COMPAT_NAME,
  processVersionText,
  projectType,
  projectTypeText,
  validateCreateProject,
} from "../src/domain/project.ts";

test("工程项目必须选择流程版本，自由项目只校验名称", () => {
  expect(validateCreateProject({ name: "", projectType: null, processProfileId: "", targetPart: "", availableProcessProfileIds: [] })).toBe("请选择项目类型。");
  expect(validateCreateProject({ name: "", projectType: "free", processProfileId: "", targetPart: "", availableProcessProfileIds: [] })).toBe("请填写项目名称。");
  expect(validateCreateProject({ name: "自由探索", projectType: "free", processProfileId: "", targetPart: "", availableProcessProfileIds: [] })).toBeNull();
  expect(validateCreateProject({ name: "工程", projectType: "engineering", processProfileId: "", targetPart: "", availableProcessProfileIds: [GJB_REF_V1_ID] })).toBe("工程项目必须选择流程版本。");
  expect(validateCreateProject({ name: "工程", projectType: "engineering", processProfileId: GJB_REF_V1_ID, targetPart: "", availableProcessProfileIds: [GJB_REF_V1_ID] })).toBeNull();
});

test("Core 流程注册表为空或未取得时工程创建 fail closed", () => {
  expect(validateCreateProject({
    name: "工程",
    projectType: "engineering",
    processProfileId: GJB_REF_V1_ID,
    targetPart: "",
    availableProcessProfileIds: [],
  })).toBe("所选流程版本当前不可用，请重新加载。");
});

test("项目类型与流程版本为缺失的旧字段提供可读默认", () => {
  expect(projectType({})).toBe("engineering");
  expect(projectTypeText(projectType({ project_type: "free" }))).toBe("自由项目");
  expect(processVersionText({ process_profile_id: GJB_REF_V1_ID })).toBe(GJB_REF_V1_NAME);
  expect(processVersionText({ process_profile_name: "自定义流程", process_profile_version: "v2" })).toBe("自定义流程 · v2");
  expect(processVersionText({})).toBe(LEGACY_COMPAT_NAME);
  expect(processVersionText({ process_profile_id: "LEGACY_COMPAT", process_profile_name: GJB_REF_V1_NAME })).toBe(LEGACY_COMPAT_NAME);
  expect(processVersionText({ project_type: "free" })).toBe("—");
  expect(isLegacyCompatProject({ process_profile_id: "LEGACY_COMPAT" })).toBe(true);
  expect(isLegacyCompatProject({})).toBe(true);
  expect(isLegacyCompatProject({ project_type: "free" })).toBe(false);
  expect(isLegacyCompatProject({ project_type: "engineering", process_profile_id: GJB_REF_V1_ID })).toBe(false);
});
