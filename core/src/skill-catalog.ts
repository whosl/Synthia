/**
 * Synthia Core — Skill Catalog (synthia.skill-pack.v1)
 *
 * Minimal Core-side contract for registering and validating versioned task
 * methods / assets ("skills"). A skill is a declarative descriptor consumed by
 * the Agent Runtime: it describes what a task method needs and produces, but it
 * is NOT an executor, NOT a plugin, NOT a database source of truth, and NOT a
 * direct Connector / MCP / Tcl entry point (SYNTHIA-ARC-005 §6.2 corrected:
 * Skill is a versioned task method/asset, registered and validated by Core and
 * consumed by Runtime against a frozen TaskPackage).
 *
 * Invariants enforced here are fail-closed and structural — they cannot be
 * bypassed by descriptor content:
 *   - A skill/agent may never declare approve/baseline/publish/hardware_write.
 *     This reuses policy.ts AGENT_FORBIDDEN_OPERATIONS verbatim so the two
 *     modules can never diverge; it does NOT redefine existing RBAC semantics.
 *   - Every execution capability must be a KNOWN, VERSIONED Connector capability
 *     of the form `<version>:<operation>` (e.g. vivado-batch-1:synthesize).
 *     Free-text Tcl entry points (execute_tcl, execute_tcl(any_string),
 *     vivado_raw_tcl) and MCP-generated names (mcp__*) are rejected.
 *   - required_permissions must be declared (non-empty) and bounded to the
 *     agent-allowed set; undeclared capability is denied, never granted.
 *
 * This module exports types and PURE validators only. It does not execute
 * skills, does not call Connectors, does not run Tcl, and does not persist
 * state. Runtime consumes a validated descriptor; Core remains the engineering
 * source of truth (SYNTHIA-ARC-001 §3, SYNTHIA-ARC-002 §6 invariants 1-2).
 */

import type { ArtifactType, GateId } from "./domain/enums.ts";
import type { Permission } from "./policy.ts";
import { AGENT_FORBIDDEN_OPERATIONS } from "./policy.ts";

// ── Schema identity ─────────────────────────────────────────────────────────

export type SkillSchemaVersion = "synthia.skill-pack.v1";

/** Canonical schema version tag carried by every descriptor and pack. */
export const SKILL_SCHEMA_VERSION = "synthia.skill-pack.v1" as const satisfies SkillSchemaVersion;

// ── Permission envelope (reuses policy.ts, does not redefine it) ─────────────

/**
 * Permissions a skill/agent is permitted to DECLARE in a descriptor. This is the
 * agent operation envelope from policy.ts (the P0–P3 additive union), expressed
 * as a fixed allow-set. The structured RBAC engine in policy.ts remains the
 * runtime authority; this only bounds what a descriptor may REQUEST.
 */
export const SKILL_ALLOWED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "read",
  "candidate_write",
  "tool_submit",
]);

/**
 * Permissions no skill/agent may ever declare, regardless of descriptor content.
 * Aliased directly from policy.ts so the canonical human/accountability gate set
 * (approve/baseline/publish/hardware_write) can never drift between modules.
 */
export const SKILL_FORBIDDEN_PERMISSIONS: ReadonlySet<Permission> = AGENT_FORBIDDEN_OPERATIONS;

// ── Connector capability registry ───────────────────────────────────────────
//
// Core's authoritative mirror of the connector's frozen capability surface.
// The dependency direction is core ← connector (connector imports core, not the
// reverse), so Core keeps its own sanctioned registry: the connector DECLARES
// capabilities and Core DECIDES which are real. Add a version here ONLY when a
// connector capability is actually implemented and contracted — never
// speculatively. Mirrors connector/vivado.ts VIVADO_CAPABILITIES /
// VIVADO_CAPABILITY_VERSION for vivado-batch-1.

export interface KnownCapabilityVersion {
  /** Connector capability version, e.g. "vivado-batch-1". */
  readonly version: string;
  /** Frozen operation set for this version. */
  readonly operations: readonly string[];
}

export const KNOWN_CAPABILITY_VERSIONS: readonly KnownCapabilityVersion[] = [
  {
    version: "vivado-batch-1",
    operations: [
      "discover_toolchain",
      "query_parts",
      "validate_sources",
      "simulate",
      "synthesize",
      "report_drc",
      "report_sta",
      "report_resources",
    ],
  },
];

// ── Capability id parsing & matching ────────────────────────────────────────

const CAPABILITY_VERSION_RE = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_OPERATION_RE = /^[a-z][a-z0-9_]*$/;
const MCP_NAME_RE = /^mcp__/i;

/**
 * Substrings that mark a capability reference as a free-text execution entry
 * rather than a versioned Connector operation. None of the frozen
 * vivado-batch-1 operations contain any of these tokens, so this never rejects
 * a legitimate capability.
 */
const FORBIDDEN_CAPABILITY_TOKENS = [
  "tcl",
  "exec",
  "shell",
  "eval",
  "spawn",
  "system",
] as const;

export interface ParsedCapabilityId {
  readonly version: string;
  readonly operation: string;
}

/**
 * Parse a capability id of the form `<version>:<operation>`
 * (e.g. `vivado-batch-1:synthesize`). Returns null for anything that is not a
 * structurally versioned capability reference — including bare operation names,
 * MCP-generated names, and free-text Tcl entry points.
 *
 * Rejects (returns null):
 *   - "synthesize"            — unversioned bare operation
 *   - "vivado-batch-1"        — missing operation
 *   - "mcp__vivado_synthesize"— MCP-generated name
 *   - "execute_tcl"           — free-text Tcl entry point
 *   - "execute_tcl(any_string)" — contains parens / forbidden token
 *   - "vivado_raw_tcl"        — forbidden token
 */
export function parseCapabilityId(capabilityId: string): ParsedCapabilityId | null {
  if (typeof capabilityId !== "string" || capabilityId.length === 0) return null;
  if (MCP_NAME_RE.test(capabilityId)) return null;
  const idx = capabilityId.indexOf(":");
  if (idx <= 0 || idx === capabilityId.length - 1) return null;
  // Reject multiple colons / stray fragments — exactly one version:operation pair.
  if (capabilityId.indexOf(":", idx + 1) !== -1) return null;
  const version = capabilityId.slice(0, idx);
  const operation = capabilityId.slice(idx + 1);
  if (!CAPABILITY_VERSION_RE.test(version)) return null;
  if (!CAPABILITY_OPERATION_RE.test(operation)) return null;
  // Reject free-text execution entry points (execute_tcl, vivado_raw_tcl, ...):
  // none of the frozen vivado-batch-1 operations contain these tokens.
  const lowered = operation.toLowerCase();
  if (FORBIDDEN_CAPABILITY_TOKENS.some((token) => lowered.includes(token))) return null;
  return { version, operation };
}

/** True when a parsed capability is present in a KNOWN capability version. */
export function isKnownCapability(parsed: ParsedCapabilityId): boolean {
  const known = KNOWN_CAPABILITY_VERSIONS.find((kv) => kv.version === parsed.version);
  return known !== undefined && known.operations.includes(parsed.operation);
}

/** Convenience: parse + known check in one call. */
export function isKnownCapabilityId(capabilityId: string): boolean {
  const parsed = parseCapabilityId(capabilityId);
  return parsed !== null && isKnownCapability(parsed);
}

// ── Descriptor types ────────────────────────────────────────────────────────

/**
 * Status a skill DECLARES for its direct output. A skill only ever authors
 * candidate / diagnostic material; `approved`/`rejected` are Core
 * ArtifactRevisionState outcomes driven by human gates, never by a skill
 * (SYNTHIA-ARC-002 §6 invariants 1-2). This prevents a candidate being passed
 * off as an approved conclusion.
 */
export type SkillOutputStatus = "candidate" | "diagnostic";

/** Failure semantics a descriptor may request — none confer approval power. */
export type SkillFailurePolicy =
  | "fail_closed"
  | "fallback_candidate"
  | "defer_to_human";

export interface SkillOutputSpec {
  readonly artifact_type: ArtifactType;
  /** Declared status of the revision the skill authors. */
  readonly declared_status: SkillOutputStatus;
  readonly description: string;
}

/**
 * Declarative descriptor for a versioned task method/asset. All fields are
 * descriptive metadata consumed at planning time; none execute anything.
 *
 * inputs / preconditions / evidence are descriptive string arrays: what the
 * skill reads, what must hold before it runs, and what evidence it must
 * produce/attach. outputs are typed objects because Core needs artifact_type
 * and declared_status to enforce the candidate/diagnostic boundary.
 */
export interface SkillDescriptor {
  /** Stable identifier (lowercase, words separated by - or _). */
  readonly skill_id: string;
  readonly schema_version: SkillSchemaVersion;
  /** Descriptor version (semver-ish, e.g. "1.0.0"). */
  readonly version: string;
  /** Target workflow phase — a canonical Synthia gate (G0-G9). */
  readonly phase: GateId;
  readonly purpose: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly SkillOutputSpec[];
  readonly preconditions: readonly string[];
  /** Permissions the task method needs; bounded to SKILL_ALLOWED_PERMISSIONS. */
  readonly required_permissions: readonly Permission[];
  /** Versioned Connector capability ids (vivado-batch-1:<op>). May be empty. */
  readonly required_capabilities: readonly string[];
  readonly evidence: readonly string[];
  readonly failure_policy: SkillFailurePolicy;
}

export interface SkillPack {
  readonly schema_version: SkillSchemaVersion;
  readonly pack_id: string;
  readonly version: string;
  readonly skills: readonly SkillDescriptor[];
}

// ── Frozen reference tables for value validation ────────────────────────────

const KNOWN_GATE_IDS: Record<string, true> = {
  G0: true, G1: true, G2: true, G3: true, G4: true,
  G5: true, G6: true, G7: true, G8: true, G9: true,
};

// Mirror of ArtifactType (domain/enums.ts). Kept as a runtime table because the
// enum is a type union with no emitted array; validated here so a descriptor
// cannot claim to produce an artifact type Core does not recognize.
const KNOWN_ARTIFACT_TYPES: Record<string, true> = {
  SOURCE_PACKAGE: true, PROJECT_PROFILE: true, TAILORING_RECORD: true, FEASIBILITY_RISK_REPORT: true,
  DEVELOPMENT_REQUIREMENTS: true, SYSTEM_REQUIREMENTS: true, OPEN_QUESTION_SET: true,
  PLDS_SRS: true, DERIVED_REQUIREMENT_SET: true, REQUIREMENT_TRACE: true, VERIFICATION_METHOD_MAP: true,
  ARCHITECTURE_DESIGN: true, DETAILED_DESIGN: true, CONSTRAINT_DESIGN: true, DESIGN_TRACE: true,
  DESIGN_REVIEW: true,
  RTL_SOURCE_SET: true, TB_SOURCE_SET: true, XDC_CANDIDATE: true, CODE_TRACE: true, CODE_REVIEW: true,
  STATIC_REPORT_SET: true, BUILD_MANIFEST: true,
  TOOLCHAIN_PROFILE: true, TOOL_RUN: true, SYNTH_RESULT: true, IMPLEMENT_RESULT: true,
  DRC_REPORT: true, STA_REPORT: true, POWER_REPORT: true,
  CONFIRMATION_TEST_PLAN: true, TEST_SPECIFICATION: true, TEST_RUN: true, COVERAGE_REPORT: true,
  CONFIRMATION_TEST_REPORT: true, BITSTREAM_PACKAGE: true, HARDWARE_TEST_RECORD: true,
  CONFIG_AUDIT: true, USER_MANUAL: true, DEVELOPMENT_SUMMARY: true, RELEASE_PACKAGE: true,
  CONFIGURATION_SNAPSHOT: true, GATE_SUBMISSION: true, APPROVAL_RECORD: true,
  APPROVED_GATE_RESULT: true, BASELINE: true, WAIVER: true, ISSUE_RISK_DECISION: true,
  TASK_HANDOFF: true, KNOWLEDGE_ENTRY: true,
};

const SKILL_ID_RE = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PACK_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

// ── Validation result ───────────────────────────────────────────────────────

export interface SkillValidationOk {
  readonly valid: true;
  readonly descriptor: SkillDescriptor;
}
export interface SkillValidationError {
  readonly valid: false;
  readonly errors: readonly string[];
}
export type SkillValidationResult = SkillValidationOk | SkillValidationError;

export interface SkillPackValidationOk {
  readonly valid: true;
  readonly pack: SkillPack;
}
export interface SkillPackValidationError {
  readonly valid: false;
  readonly errors: readonly string[];
}
export type SkillPackValidationResult =
  | SkillPackValidationOk
  | SkillPackValidationError;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validatePermissionSet(
  permissions: readonly Permission[],
  errors: string[],
  path: string,
): void {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    // Empty permissions is fail-closed: a skill must declare what it needs, and
    // undeclared capability is denied, never granted.
    errors.push(`${path}: must declare at least one permission (fail-closed)`);
    return;
  }
  for (const permission of permissions) {
    if (SKILL_FORBIDDEN_PERMISSIONS.has(permission)) {
      errors.push(
        `${path}: skill must not declare forbidden permission "${permission}"`,
      );
    } else if (!SKILL_ALLOWED_PERMISSIONS.has(permission)) {
      errors.push(`${path}: permission "${permission}" is outside the agent-allowed set`);
    }
  }
}

function validateCapabilityRefs(
  capabilities: readonly string[],
  errors: string[],
  path: string,
): void {
  if (!Array.isArray(capabilities)) {
    errors.push(`${path}: must be an array of capability ids`);
    return;
  }
  capabilities.forEach((capabilityId, index) => {
    const parsed = parseCapabilityId(capabilityId);
    if (parsed === null) {
      // Covers MCP names, bare operations, free-text Tcl, and malformed ids.
      errors.push(
        `${path}[${index}]: "${capabilityId}" is not a versioned Connector capability id (<version>:<operation>)`,
      );
      return;
    }
    if (!isKnownCapability(parsed)) {
      errors.push(
        `${path}[${index}]: "${capabilityId}" is not a known/implemented capability`,
      );
    }
  });
}

// ── Descriptor validator (pure, fail-closed) ────────────────────────────────

/**
 * Validate a SkillDescriptor against the synthia.skill-pack.v1 contract.
 * Pure: no side effects, no I/O. Fail-closed: any unrecognized capability,
 * forbidden/arbitrary permission, free-text Tcl entry, or missing Core boundary
 * yields valid=false with collected errors rather than throwing or defaulting
 * to success.
 */
export function validateSkill(descriptor: SkillDescriptor): SkillValidationResult {
  const errors: string[] = [];

  if (!descriptor || typeof descriptor !== "object") {
    return { valid: false, errors: ["descriptor: must be an object"] };
  }

  // schema_version
  if (descriptor.schema_version !== SKILL_SCHEMA_VERSION) {
    errors.push(
      `schema_version: expected "${SKILL_SCHEMA_VERSION}", got "${descriptor.schema_version}"`,
    );
  }

  // skill_id
  if (!isNonEmptyString(descriptor.skill_id) || !SKILL_ID_RE.test(descriptor.skill_id)) {
    errors.push("skill_id: must be a stable lowercase identifier (e.g. \"rtl-candidate-author\")");
  }

  // version
  if (!isNonEmptyString(descriptor.version) || !VERSION_RE.test(descriptor.version)) {
    errors.push("version: must be a semantic version (MAJOR.MINOR.PATCH)");
  }

  // phase
  if (!isNonEmptyString(descriptor.phase) || !(descriptor.phase in KNOWN_GATE_IDS)) {
    errors.push("phase: must be a canonical Synthia gate id (G0-G9)");
  }

  // purpose
  if (!isNonEmptyString(descriptor.purpose)) {
    errors.push("purpose: must be a non-empty string");
  }

  // inputs — descriptive string array (what the skill reads)
  if (!Array.isArray(descriptor.inputs)) {
    errors.push("inputs: must be an array");
  } else {
    descriptor.inputs.forEach((input, index) => {
      if (!isNonEmptyString(input)) {
        errors.push(`inputs[${index}]: must be a non-empty string`);
      }
    });
  }

  // outputs — a skill must declare at least one output
  if (!Array.isArray(descriptor.outputs) || descriptor.outputs.length === 0) {
    errors.push("outputs: must declare at least one output");
  } else {
    descriptor.outputs.forEach((output, index) => {
      const path = `outputs[${index}]`;
      if (!output || typeof output !== "object") {
        errors.push(`${path}: must be an object`);
        return;
      }
      if (
        !isNonEmptyString(output.artifact_type) ||
        !(output.artifact_type in KNOWN_ARTIFACT_TYPES)
      ) {
        errors.push(`${path}.artifact_type: unknown artifact type "${output.artifact_type}"`);
      }
      if (output.declared_status !== "candidate" && output.declared_status !== "diagnostic") {
        errors.push(
          `${path}.declared_status: must be "candidate" or "diagnostic" (skills cannot declare approved/rejected)`,
        );
      }
      if (!isNonEmptyString(output.description)) {
        errors.push(`${path}.description: must be a non-empty string`);
      }
    });
  }

  // preconditions
  if (!Array.isArray(descriptor.preconditions)) {
    errors.push("preconditions: must be an array");
  } else {
    descriptor.preconditions.forEach((precondition, index) => {
      if (!isNonEmptyString(precondition)) {
        errors.push(`preconditions[${index}]: must be a non-empty string`);
      }
    });
  }

  // required_permissions — non-empty, bounded to agent-allowed set
  validatePermissionSet(
    Array.isArray(descriptor.required_permissions) ? descriptor.required_permissions : [],
    errors,
    "required_permissions",
  );

  // required_capabilities — every ref must be a known versioned capability
  validateCapabilityRefs(
    Array.isArray(descriptor.required_capabilities) ? descriptor.required_capabilities : [],
    errors,
    "required_capabilities",
  );

  // evidence — descriptive string array; at least one requirement
  // (evidence-chain discipline)
  if (!Array.isArray(descriptor.evidence) || descriptor.evidence.length === 0) {
    errors.push("evidence: must declare at least one evidence requirement");
  } else {
    descriptor.evidence.forEach((entry, index) => {
      if (!isNonEmptyString(entry)) {
        errors.push(`evidence[${index}]: must be a non-empty string`);
      }
    });
  }

  // failure_policy
  if (
    descriptor.failure_policy !== "fail_closed" &&
    descriptor.failure_policy !== "fallback_candidate" &&
    descriptor.failure_policy !== "defer_to_human"
  ) {
    errors.push("failure_policy: must be fail_closed | fallback_candidate | defer_to_human");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, descriptor };
}

/**
 * Throwing variant of {@link validateSkill}. Use at registration boundaries
 * where an invalid descriptor must abort the operation rather than be handled.
 */
export function assertValidSkill(descriptor: SkillDescriptor): void {
  const result = validateSkill(descriptor);
  if (!result.valid) {
    throw new Error(`SKILL_DESCRIPTOR_INVALID: ${result.errors.join("; ")}`);
  }
}

// ── Pack validator ──────────────────────────────────────────────────────────

/**
 * Validate a SkillPack: schema/pack identity plus every contained descriptor,
 * rejecting duplicate skill_ids. Pure and fail-closed.
 */
export function validateSkillPack(pack: SkillPack): SkillPackValidationResult {
  const errors: string[] = [];

  if (!pack || typeof pack !== "object") {
    return { valid: false, errors: ["pack: must be an object"] };
  }

  if (pack.schema_version !== SKILL_SCHEMA_VERSION) {
    errors.push(
      `schema_version: expected "${SKILL_SCHEMA_VERSION}", got "${pack.schema_version}"`,
    );
  }

  if (!isNonEmptyString(pack.pack_id) || !PACK_ID_RE.test(pack.pack_id)) {
    errors.push("pack_id: must be a dotted reverse-domain identifier (e.g. \"synthia.fpga\")");
  }

  if (!isNonEmptyString(pack.version) || !VERSION_RE.test(pack.version)) {
    errors.push("version: must be a semantic version (MAJOR.MINOR.PATCH)");
  }

  if (!Array.isArray(pack.skills) || pack.skills.length === 0) {
    errors.push("skills: pack must declare at least one skill");
  } else {
    const seen = new Set<string>();
    pack.skills.forEach((descriptor, index) => {
      const result = validateSkill(descriptor);
      if (!result.valid) {
        for (const message of result.errors) {
          errors.push(`skills[${index}].${message}`);
        }
      }
      if (isNonEmptyString(descriptor?.skill_id)) {
        if (seen.has(descriptor.skill_id)) {
          errors.push(`skills[${index}]: duplicate skill_id "${descriptor.skill_id}"`);
        }
        seen.add(descriptor.skill_id);
      }
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, pack };
}

/** Throwing variant of {@link validateSkillPack}. */
export function assertValidSkillPack(pack: SkillPack): void {
  const result = validateSkillPack(pack);
  if (!result.valid) {
    throw new Error(`SKILL_PACK_INVALID: ${result.errors.join("; ")}`);
  }
}
