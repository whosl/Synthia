import { hashPayload } from "../hashing.ts";

export type P4GateId = "G0" | "G1" | "G2" | "G3" | "G4";
export type P4BaselineKind = "B0" | "B1" | "B2";

export interface ProcessProfileCheckV1 {
  readonly code: string;
  readonly severity: "hard" | "advisory";
}

export interface ProcessProfileNodeV1 {
  readonly id: P4GateId;
  readonly kind: "gate";
  readonly ordinal: number;
  readonly name: string;
  readonly goal: string;
  readonly activities: readonly string[];
  readonly requiredChecks: readonly ProcessProfileCheckV1[];
  readonly milestoneBaseline: P4BaselineKind | null;
}

export interface ProcessProfileV1 {
  readonly schema: "process-profile.v1";
  readonly id: "GJB_REF_V1";
  readonly version: "GJB_REF_V1";
  readonly name: "GJB 参考流程 v1";
  readonly nodes: readonly ProcessProfileNodeV1[];
  readonly profileHash: string;
}

const PROFILE_BODY = {
  schema: "process-profile.v1" as const,
  id: "GJB_REF_V1" as const,
  version: "GJB_REF_V1" as const,
  name: "GJB 参考流程 v1" as const,
  nodes: [
    {
      id: "G0" as const,
      kind: "gate" as const,
      ordinal: 0,
      name: "项目准备",
      goal: "记录项目边界、器件与工具准备状态",
      activities: ["prepare_project"],
      requiredChecks: [
        { code: "project.engineering", severity: "hard" as const },
        { code: "process.bound", severity: "hard" as const },
        { code: "data_scope.recorded", severity: "hard" as const },
        { code: "target_part.recorded", severity: "hard" as const },
        { code: "board_status.recorded", severity: "hard" as const },
        { code: "source_materials.recorded", severity: "hard" as const },
        { code: "workspace.ready", severity: "hard" as const },
        { code: "toolchain.bound", severity: "hard" as const },
      ],
      milestoneBaseline: null,
    },
    {
      id: "G1" as const,
      kind: "gate" as const,
      ordinal: 1,
      name: "需求确认",
      goal: "确认需求来源、接口、验收目标与关键风险",
      activities: ["intake"],
      requiredChecks: [
        { code: "artifact.development_requirements", severity: "hard" as const },
        { code: "snapshot.members_frozen", severity: "hard" as const },
      ],
      milestoneBaseline: "B0" as const,
    },
    {
      id: "G2" as const,
      kind: "gate" as const,
      ordinal: 2,
      name: "行为与验证方案",
      goal: "确认功能、时序、异常行为及需求对应的验证方法",
      activities: ["behavior_wave", "verification_plan"],
      requiredChecks: [
        { code: "artifact.behavior_spec", severity: "hard" as const },
        { code: "artifact.verification_method_map", severity: "hard" as const },
        { code: "snapshot.members_frozen", severity: "hard" as const },
      ],
      milestoneBaseline: null,
    },
    {
      id: "G3" as const,
      kind: "gate" as const,
      ordinal: 3,
      name: "设计确认",
      goal: "确认架构、接口、寄存器、时钟复位、约束策略与关键边界",
      activities: ["architecture", "register_spec", "constraint_strategy"],
      requiredChecks: [
        { code: "artifact.architecture_design", severity: "hard" as const },
        { code: "artifact.detailed_design", severity: "hard" as const },
        { code: "artifact.constraint_design", severity: "hard" as const },
        { code: "snapshot.members_frozen", severity: "hard" as const },
      ],
      milestoneBaseline: "B1" as const,
    },
    {
      id: "G4" as const,
      kind: "gate" as const,
      ordinal: 4,
      name: "实现与交付",
      goal: "由同一不可变输入生成、验证并交付可追溯的正式结果",
      activities: ["rtl_build", "validate", "tb", "simulate", "xdc", "implement", "delivery"],
      requiredChecks: [
        { code: "artifact.rtl", severity: "hard" as const },
        { code: "artifact.testbench", severity: "hard" as const },
        { code: "artifact.constraints", severity: "hard" as const },
        { code: "formal_input.confirmed", severity: "hard" as const },
        { code: "constraints.complete", severity: "hard" as const },
        { code: "formal_simulation.succeeded", severity: "hard" as const },
        { code: "formal_implementation.succeeded", severity: "hard" as const },
        { code: "drc.clean", severity: "hard" as const },
        { code: "timing.met", severity: "hard" as const },
        { code: "evidence.frozen", severity: "hard" as const },
        { code: "bitstream.formal", severity: "hard" as const },
        { code: "delivery.manifest_sealed", severity: "hard" as const },
      ],
      milestoneBaseline: "B2" as const,
    },
  ],
};

export const GJB_REF_V1_PROFILE: ProcessProfileV1 = Object.freeze({
  ...PROFILE_BODY,
  profileHash: hashPayload(PROFILE_BODY),
});

export const P4_GATE_ORDER: readonly P4GateId[] = GJB_REF_V1_PROFILE.nodes.map((node) => node.id);

export function isP4Gate(value: unknown): value is P4GateId {
  return typeof value === "string" && P4_GATE_ORDER.includes(value as P4GateId);
}

export function nextP4Gate(gate: P4GateId): P4GateId | null {
  const index = P4_GATE_ORDER.indexOf(gate);
  return index >= 0 && index < P4_GATE_ORDER.length - 1 ? P4_GATE_ORDER[index + 1]! : null;
}
