import { hashPayload } from "../core/src/hashing.ts";

export const P4_GATE_IDS = ["G0", "G1", "G2", "G3", "G4"] as const;
export type P4GateId = (typeof P4_GATE_IDS)[number];

export const PROCESS_ACTIVITIES = [
  "prepare_project",
  "intake",
  "behavior_wave",
  "verification_plan",
  "architecture",
  "register_spec",
  "constraint_strategy",
  "rtl_build",
  "validate",
  "tb",
  "simulate",
  "xdc",
  "implement",
  "delivery",
] as const;
export type ProcessActivity = (typeof PROCESS_ACTIVITIES)[number];

export const PROCESS_CHECK_CODES = [
  "project.engineering",
  "process.bound",
  "data_scope.recorded",
  "target_part.recorded",
  "board_status.recorded",
  "source_materials.recorded",
  "workspace.ready",
  "toolchain.bound",
  "artifact.development_requirements",
  "snapshot.members_frozen",
  "artifact.behavior_spec",
  "artifact.verification_method_map",
  "artifact.architecture_design",
  "artifact.detailed_design",
  "artifact.constraint_design",
  "artifact.rtl",
  "artifact.testbench",
  "artifact.constraints",
  "formal_input.confirmed",
  "constraints.complete",
  "formal_simulation.succeeded",
  "formal_implementation.succeeded",
  "drc.clean",
  "timing.met",
  "evidence.frozen",
  "bitstream.formal",
  "delivery.manifest_sealed",
] as const;
export type ProcessCheckCode = (typeof PROCESS_CHECK_CODES)[number];
export type ProcessCheckSeverity = "hard" | "advisory";
export type ProcessBaselineKind = "B0" | "B1" | "B2";

export interface ProcessProfileCheckV1 {
  readonly code: ProcessCheckCode;
  readonly severity: ProcessCheckSeverity;
}

export interface ProcessProfileNodeV1 {
  readonly id: P4GateId;
  readonly kind: "gate";
  readonly ordinal: number;
  readonly name: string;
  readonly goal: string;
  readonly activities: readonly ProcessActivity[];
  readonly requiredChecks: readonly ProcessProfileCheckV1[];
  readonly milestoneBaseline: ProcessBaselineKind | null;
}

export interface ProcessProfileV1 {
  readonly schema: "process-profile.v1";
  readonly id: "GJB_REF_V1";
  readonly version: "GJB_REF_V1";
  readonly name: "GJB 参考流程 v1";
  readonly nodes: readonly ProcessProfileNodeV1[];
  readonly profileHash: string;
}

export interface ProjectProcessBinding {
  readonly projectType?: string;
  readonly processVersionId?: string | null;
  readonly processProfileId?: string | null;
  readonly processProfileVersion?: string | null;
}

export interface ProcessProfileReader {
  readonly getProcessProfile?: (processVersionId: string) => Promise<ProcessProfileV1>;
}

export class ProcessProfileValidationError extends Error {
  constructor(
    message: string,
    readonly code = "PROCESS_PROFILE_INVALID",
  ) {
    super(message);
    this.name = "ProcessProfileValidationError";
  }
}

const ACTIVITY_SET = new Set<string>(PROCESS_ACTIVITIES);
const CHECK_CODE_SET = new Set<string>(PROCESS_CHECK_CODES);
const GATE_SET = new Set<string>(P4_GATE_IDS);
const PROFILE_KEYS = ["id", "name", "nodes", "profileHash", "schema", "version"] as const;
const NODE_KEYS = ["activities", "goal", "id", "kind", "milestoneBaseline", "name", "ordinal", "requiredChecks"] as const;
const CHECK_KEYS = ["code", "severity"] as const;
const PROCESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const EXPECTED_ACTIVITIES: Readonly<Record<P4GateId, readonly ProcessActivity[]>> = {
  G0: ["prepare_project"],
  G1: ["intake"],
  G2: ["behavior_wave", "verification_plan"],
  G3: ["architecture", "register_spec", "constraint_strategy"],
  G4: ["rtl_build", "validate", "tb", "simulate", "xdc", "implement", "delivery"],
};
const EXPECTED_CHECKS: Readonly<Record<P4GateId, readonly ProcessCheckCode[]>> = {
  G0: ["project.engineering", "process.bound", "data_scope.recorded", "target_part.recorded", "board_status.recorded", "source_materials.recorded", "workspace.ready", "toolchain.bound"],
  G1: ["artifact.development_requirements", "snapshot.members_frozen"],
  G2: ["artifact.behavior_spec", "artifact.verification_method_map", "snapshot.members_frozen"],
  G3: ["artifact.architecture_design", "artifact.detailed_design", "artifact.constraint_design", "snapshot.members_frozen"],
  G4: ["artifact.rtl", "artifact.testbench", "artifact.constraints", "formal_input.confirmed", "constraints.complete", "formal_simulation.succeeded", "formal_implementation.succeeded", "drc.clean", "timing.met", "evidence.frozen", "bitstream.formal", "delivery.manifest_sealed"],
};

function invalid(message: string): never {
  throw new ProcessProfileValidationError(message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(row: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(row).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    invalid(`${path} has unexpected or missing fields`);
  }
}

function requireText(value: unknown, path: string, maxBytes = 512): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${path} must be a non-empty string`);
  if (new TextEncoder().encode(value).length > maxBytes || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    invalid(`${path} contains unsafe text`);
  }
  return value;
}

function parseCheck(value: unknown, path: string): ProcessProfileCheckV1 {
  const row = asRecord(value, path);
  requireExactKeys(row, CHECK_KEYS, path);
  const code = requireText(row.code, `${path}.code`, 128);
  if (!CHECK_CODE_SET.has(code)) invalid(`${path}.code is not a known process check`);
  if (row.severity !== "hard" && row.severity !== "advisory") {
    invalid(`${path}.severity must be hard or advisory`);
  }
  return { code: code as ProcessCheckCode, severity: row.severity };
}

function parseNode(value: unknown, index: number): ProcessProfileNodeV1 {
  const path = `profile.nodes[${index}]`;
  const row = asRecord(value, path);
  requireExactKeys(row, NODE_KEYS, path);
  if (typeof row.id !== "string" || !GATE_SET.has(row.id)) invalid(`${path}.id must be one of G0-G4`);
  if (row.id !== P4_GATE_IDS[index]) invalid(`${path}.id must be ${P4_GATE_IDS[index]}`);
  if (row.kind !== "gate") invalid(`${path}.kind must be gate`);
  if (row.ordinal !== index) invalid(`${path}.ordinal must be ${index}`);
  const name = requireText(row.name, `${path}.name`, 256);
  const goal = requireText(row.goal, `${path}.goal`, 1024);

  if (!Array.isArray(row.activities) || row.activities.length === 0) invalid(`${path}.activities must be a non-empty array`);
  const activities = row.activities.map((activity, activityIndex) => {
    if (typeof activity !== "string" || !ACTIVITY_SET.has(activity)) {
      invalid(`${path}.activities[${activityIndex}] is not a known activity`);
    }
    return activity as ProcessActivity;
  });
  if (new Set(activities).size !== activities.length) invalid(`${path}.activities must be unique`);

  if (!Array.isArray(row.requiredChecks) || row.requiredChecks.length === 0) {
    invalid(`${path}.requiredChecks must be a non-empty array`);
  }
  const requiredChecks = row.requiredChecks.map((check, checkIndex) => parseCheck(check, `${path}.requiredChecks[${checkIndex}]`));
  if (new Set(requiredChecks.map((check) => check.code)).size !== requiredChecks.length) {
    invalid(`${path}.requiredChecks codes must be unique within a node`);
  }
  const milestoneBaseline = row.milestoneBaseline;
  if (milestoneBaseline !== null && milestoneBaseline !== "B0" && milestoneBaseline !== "B1" && milestoneBaseline !== "B2") {
    invalid(`${path}.milestoneBaseline is invalid`);
  }
  return {
    id: row.id as P4GateId,
    kind: "gate",
    ordinal: index,
    name,
    goal,
    activities,
    requiredChecks,
    milestoneBaseline,
  };
}

/**
 * Strictly parse the Core-owned `process-profile.v1` contract.
 *
 * The profile hash proves canonical transport integrity, while the semantic
 * checks below prevent a self-consistent but unsupported profile from driving
 * Runtime (for example, a recomputed hash containing G5 or a new activity).
 */
export function parseProcessProfile(
  value: unknown,
  expectedProcessVersionId?: string,
): ProcessProfileV1 {
  const row = asRecord(value, "profile");
  requireExactKeys(row, PROFILE_KEYS, "profile");
  if (typeof row.profileHash !== "string" || !HASH_PATTERN.test(row.profileHash)) {
    invalid("profile.profileHash must be a lowercase SHA-256 digest");
  }
  const { profileHash: _profileHash, ...transportBody } = row;
  if (hashPayload(transportBody) !== row.profileHash) {
    invalid("profile.profileHash does not match the canonical profile body");
  }
  if (row.schema !== "process-profile.v1") invalid("profile.schema must be process-profile.v1");
  const id = requireText(row.id, "profile.id", 128);
  const version = requireText(row.version, "profile.version", 128);
  if (!PROCESS_ID_PATTERN.test(id) || !PROCESS_ID_PATTERN.test(version)) invalid("profile id/version is invalid");
  if (id !== "GJB_REF_V1" || version !== "GJB_REF_V1") invalid("profile.id and profile.version must be GJB_REF_V1");
  if (expectedProcessVersionId !== undefined && id !== expectedProcessVersionId) {
    invalid("profile does not match the requested process version");
  }
  const name = requireText(row.name, "profile.name", 256);
  if (name !== "GJB 参考流程 v1") invalid("profile.name does not match GJB_REF_V1");
  if (!Array.isArray(row.nodes) || row.nodes.length !== P4_GATE_IDS.length) {
    invalid("profile.nodes must contain exactly G0-G4");
  }
  const nodes = row.nodes.map(parseNode);
  const activities = nodes.flatMap((node) => node.activities);
  if (new Set(activities).size !== activities.length) invalid("profile activities must belong to exactly one gate");
  for (const node of nodes) {
    if (node.activities.join("\0") !== EXPECTED_ACTIVITIES[node.id].join("\0")) {
      invalid(`profile.nodes[${node.ordinal}].activities does not match the supported ${node.id} activity set`);
    }
    if (
      node.requiredChecks.map((check) => check.code).join("\0") !== EXPECTED_CHECKS[node.id].join("\0") ||
      node.requiredChecks.some((check) => check.severity !== "hard")
    ) {
      invalid(`profile.nodes[${node.ordinal}].requiredChecks does not match the supported ${node.id} hard-check set`);
    }
  }
  const expectedMilestones: readonly (ProcessBaselineKind | null)[] = [null, "B0", null, "B1", "B2"];
  if (nodes.some((node, index) => node.milestoneBaseline !== expectedMilestones[index])) {
    invalid("profile milestone baselines must be G1/B0, G3/B1, and G4/B2");
  }
  const body = { schema: "process-profile.v1" as const, id: "GJB_REF_V1" as const, version: "GJB_REF_V1" as const, name: "GJB 参考流程 v1" as const, nodes };
  return { ...body, profileHash: row.profileHash };
}

/**
 * Compatibility bridge for project-scoped Runtime callers.
 *
 * Free and explicitly LEGACY_COMPAT projects keep their old read path. A
 * modern engineering project, however, may never fall back to a local stage
 * list or an older mock that cannot expose the Core-owned profile.
 */
export async function loadModernProcessProfile(
  reader: ProcessProfileReader,
  binding: ProjectProcessBinding,
): Promise<ProcessProfileV1 | null> {
  if (binding.projectType !== "engineering") return null;
  const facts = [binding.processVersionId, binding.processProfileId, binding.processProfileVersion];
  if (facts.every((fact) => fact === "LEGACY_COMPAT")) return null;
  if (facts.some((fact) => typeof fact !== "string" || fact.length === 0) || new Set(facts).size !== 1) {
    throw new ProcessProfileValidationError(
      "modern engineering project is missing a consistent frozen process profile",
      "PROCESS_PROFILE_REQUIRED",
    );
  }
  const processVersionId = facts[0] as string;
  if (typeof reader.getProcessProfile !== "function") {
    throw new ProcessProfileValidationError(
      "governance client cannot read the modern process profile",
      "PROCESS_PROFILE_UNAVAILABLE",
    );
  }
  return parseProcessProfile(await reader.getProcessProfile(processVersionId), processVersionId);
}
