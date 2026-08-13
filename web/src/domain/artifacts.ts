/**
 * 产物类型 → GJB 正式文档名 / 中文分组（spec ui-redesign-v2 §3 统一维护）。
 *
 * FPGA 按 PLDS 管理，适用 GB/T 33781-2017；产物库每条对应一份 GJB 正式文档。
 * 未映射类型显示中文通用名「工程文档」——英文类型枚举不得出现在 UI。
 */

// ─── GJB 正式文档名（v2 §3 表）────────────────────────────────────────

export const ARTIFACT_DOC_NAMES: Readonly<Record<string, string>> = {
  DEVELOPMENT_REQUIREMENTS: "研制（开发）技术要求",
  SYSTEM_REQUIREMENTS: "系统需求规格说明",
  PLDS_SRS: "PLDS 需求规格说明",
  ARCHITECTURE_DESIGN: "PLDS 结构设计说明",
  DETAILED_DESIGN: "PLDS 详细设计说明",
  CONSTRAINT_DESIGN: "PLDS 接口与约束设计说明（草案）",
  XDC_CANDIDATE: "PLDS 接口与约束设计说明（草案）",
  RTL_SOURCE_SET: "PLDS 源代码（RTL）",
  TB_SOURCE_SET: "PLDS 验证环境源代码",
  SYNTH_RESULT: "综合报告",
  IMPLEMENT_RESULT: "布局布线（实现）报告",
  DRC_REPORT: "设计规则检查（DRC）报告",
  STA_REPORT: "静态时序分析报告",
  POWER_REPORT: "功耗分析报告",
  BITSTREAM_PACKAGE: "PLDS 码流（固化）包",
};

/** 产物类型 → UI 展示名（未映射类型 → 「工程文档」）。 */
export function artifactDocName(artifactType: string): string {
  return ARTIFACT_DOC_NAMES[artifactType] ?? "工程文档";
}

// ─── 工作台 docs phase → GJB 文档名（runtime 登记关系镜像）───────────────

const PHASE_DOC_NAMES: Readonly<Record<string, string>> = {
  intake: ARTIFACT_DOC_NAMES.DEVELOPMENT_REQUIREMENTS!,
  behavior_wave: ARTIFACT_DOC_NAMES.DETAILED_DESIGN!,
  architecture: ARTIFACT_DOC_NAMES.ARCHITECTURE_DESIGN!,
  register_spec: ARTIFACT_DOC_NAMES.DETAILED_DESIGN!,
  rtl: ARTIFACT_DOC_NAMES.RTL_SOURCE_SET!,
  rtl_build: ARTIFACT_DOC_NAMES.RTL_SOURCE_SET!,
  tb: ARTIFACT_DOC_NAMES.TB_SOURCE_SET!,
  xdc: ARTIFACT_DOC_NAMES.XDC_CANDIDATE!,
};

/** 任务产物 phase → UI 展示名（未知 phase → 「工程文档」）。 */
export function phaseDocName(phase: string): string {
  return PHASE_DOC_NAMES[phase] ?? "工程文档";
}

// ─── 产物中文分组 ──────────────────────────────────────────────────────

/** 产物类型 → 中文分组（未列出的治理/内部类型归「其他」）。 */
const ARTIFACT_TYPE_GROUP: Readonly<Record<string, string>> = {
  DEVELOPMENT_REQUIREMENTS: "需求",
  SYSTEM_REQUIREMENTS: "需求",
  OPEN_QUESTION_SET: "需求",
  PLDS_SRS: "行为",
  DERIVED_REQUIREMENT_SET: "行为",
  REQUIREMENT_TRACE: "行为",
  VERIFICATION_METHOD_MAP: "行为",
  DETAILED_DESIGN: "行为",
  ARCHITECTURE_DESIGN: "架构",
  CONSTRAINT_DESIGN: "架构",
  DESIGN_TRACE: "架构",
  DESIGN_REVIEW: "架构",
  RTL_SOURCE_SET: "RTL",
  TB_SOURCE_SET: "RTL",
  CODE_TRACE: "RTL",
  CODE_REVIEW: "RTL",
  XDC_CANDIDATE: "约束",
};

/** 产物类型 → 中文分组名（未知类型归「其他」，不显示英文枚举）。 */
export function artifactGroupName(artifactType: string): string {
  return ARTIFACT_TYPE_GROUP[artifactType] ?? "其他";
}

/** 分组显示顺序。 */
export const ARTIFACT_GROUP_ORDER: readonly string[] = [
  "需求", "行为", "架构", "RTL", "约束", "其他",
];
