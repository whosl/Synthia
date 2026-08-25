import { computeManifestHash, sha256Hex } from "../hashing.ts";

export const P4_GATE_EVIDENCE_SCHEMA = "p4-gate-evidence.v1" as const;
export const P4_GATE_EVIDENCE_MAX_BYTES = 256 * 1024;
export const P4_GATE_EVIDENCE_MAX_ITEMS = 128;

export type P4StructuredGateId = "G1" | "G2" | "G3";

export interface ManagedGateRevision {
  readonly revisionId: string;
  readonly projectId: string;
  readonly contentHash: string;
  readonly bytes: string | null;
}

export interface FrozenGateTrace {
  readonly id: string;
  readonly projectId: string;
  readonly state: string;
  readonly sourceRevisionId: string;
  readonly sourceProjectId: string | null;
  readonly targetRevisionId: string;
  readonly targetProjectId: string | null;
  readonly basis: string;
}

export interface P4RequirementAuthority {
  readonly requirementIds: readonly string[];
  readonly criticalRequirementIds: readonly string[];
  /** Frozen B0 member revisions from which the authority was derived. */
  readonly frozenRevisionIds: readonly string[];
}

export interface P4GateEvidenceCheck {
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
  readonly evidenceRefs: readonly { readonly type: string; readonly id: string }[];
}

export interface P4GateEvidenceEvaluation {
  readonly checks: Readonly<Record<string, P4GateEvidenceCheck>>;
  readonly authority: P4RequirementAuthority | null;
  readonly evidenceRevisionId: string | null;
}

export interface P4GateEvidenceInput {
  readonly gate: P4StructuredGateId;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly snapshotManifestHash: string;
  readonly memberRevisionIds: readonly string[];
  readonly revisions: readonly ManagedGateRevision[];
  readonly traceRelationIds: readonly string[];
  readonly traces: readonly FrozenGateTrace[];
  readonly authoritativeRequirements?: P4RequirementAuthority | null;
}

interface G1Requirement {
  readonly id: string;
  readonly critical: boolean;
  readonly sourceRevisionId: string;
}

interface G1Evidence {
  readonly gate: "G1";
  readonly requirements: readonly G1Requirement[];
  readonly riskCount: number;
  readonly traceRelationIds: readonly string[];
}

interface G2Evidence {
  readonly gate: "G2";
  readonly requirementIds: readonly string[];
  readonly criticalRequirementIds: readonly string[];
  readonly mappedRequirementIds: readonly string[];
  readonly behaviorCounts: {
    readonly functional: number;
    readonly performance: number;
    readonly timing: number;
    readonly exceptions: number;
  };
  readonly traceRelationIds: readonly string[];
}

interface G3Evidence {
  readonly gate: "G3";
  readonly componentIds: readonly string[];
  readonly designElementIds: readonly string[];
  readonly tracedRequirementIds: readonly string[];
  readonly traceRelationIds: readonly string[];
  readonly designTraceRelationIds: readonly string[];
  readonly cdcStatus: "addressed" | "not_applicable";
}

type ParsedEvidence = G1Evidence | G2Evidence | G3Evidence;

class GateEvidenceValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "GateEvidenceValidationError";
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GateEvidenceValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new GateEvidenceValidationError(path, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function stringValue(value: unknown, path: string, maxLength = 4096): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /\u0000|[\u0001-\u001f\u007f]/u.test(value)
  ) {
    throw new GateEvidenceValidationError(path, `must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function idValue(value: unknown, path: string): string {
  const id = stringValue(value, path, 128);
  if (!SAFE_ID.test(id)) throw new GateEvidenceValidationError(path, "must be a safe identifier");
  return id;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new GateEvidenceValidationError(path, "must be a boolean");
  return value;
}

function boundedArray(value: unknown, path: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value)) throw new GateEvidenceValidationError(path, "must be an array");
  if ((!allowEmpty && value.length === 0) || value.length > P4_GATE_EVIDENCE_MAX_ITEMS) {
    throw new GateEvidenceValidationError(
      path,
      `must contain ${allowEmpty ? "0" : "1"}-${P4_GATE_EVIDENCE_MAX_ITEMS} items`,
    );
  }
  return value;
}

function uniqueIds(values: readonly string[], path: string): string[] {
  if (new Set(values).size !== values.length) {
    throw new GateEvidenceValidationError(path, "must not contain duplicate ids");
  }
  return [...values];
}

function idArray(value: unknown, path: string): string[] {
  return uniqueIds(
    boundedArray(value, path).map((item, index) => idValue(item, `${path}[${index}]`)),
    path,
  );
}

function objectArray(value: unknown, path: string): Record<string, unknown>[] {
  return boundedArray(value, path).map((item, index) => objectValue(item, `${path}[${index}]`));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new GateEvidenceValidationError(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireUniqueObjectIds(values: readonly Record<string, unknown>[], path: string): string[] {
  return uniqueIds(values.map((value, index) => idValue(value.id, `${path}[${index}].id`)), path);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function parseG1(row: Record<string, unknown>, memberRevisionIds: readonly string[]): G1Evidence {
  exactKeys(row, ["gate", "requirements", "risks", "schema", "traceRelationIds"], "evidence");
  const requirements = objectArray(row.requirements, "evidence.requirements");
  requireUniqueObjectIds(requirements, "evidence.requirements");
  const parsedRequirements = requirements.map((requirement, index): G1Requirement => {
    const path = `evidence.requirements[${index}]`;
    exactKeys(requirement, ["acceptance", "critical", "id", "interface", "source"], path);
    const source = objectValue(requirement.source, `${path}.source`);
    exactKeys(source, ["locator", "revisionId"], `${path}.source`);
    const sourceRevisionId = idValue(source.revisionId, `${path}.source.revisionId`);
    stringValue(source.locator, `${path}.source.locator`);
    if (!memberRevisionIds.includes(sourceRevisionId)) {
      throw new GateEvidenceValidationError(`${path}.source.revisionId`, "must name a frozen snapshot member");
    }
    const contract = objectValue(requirement.interface, `${path}.interface`);
    exactKeys(contract, ["contract", "direction", "name"], `${path}.interface`);
    stringValue(contract.name, `${path}.interface.name`, 256);
    enumValue(contract.direction, ["input", "output", "bidirectional"] as const, `${path}.interface.direction`);
    stringValue(contract.contract, `${path}.interface.contract`);
    const acceptance = objectValue(requirement.acceptance, `${path}.acceptance`);
    exactKeys(acceptance, ["criterion", "method"], `${path}.acceptance`);
    stringValue(acceptance.criterion, `${path}.acceptance.criterion`);
    stringValue(acceptance.method, `${path}.acceptance.method`, 512);
    return {
      id: idValue(requirement.id, `${path}.id`),
      critical: booleanValue(requirement.critical, `${path}.critical`),
      sourceRevisionId,
    };
  });

  const risks = objectArray(row.risks, "evidence.risks");
  requireUniqueObjectIds(risks, "evidence.risks");
  risks.forEach((risk, index) => {
    const path = `evidence.risks[${index}]`;
    exactKeys(risk, ["critical", "description", "disposition", "id"], path);
    idValue(risk.id, `${path}.id`);
    booleanValue(risk.critical, `${path}.critical`);
    stringValue(risk.description, `${path}.description`);
    const disposition = objectValue(risk.disposition, `${path}.disposition`);
    exactKeys(disposition, ["rationale", "status"], `${path}.disposition`);
    enumValue(
      disposition.status,
      ["accepted", "avoided", "mitigated", "transferred"] as const,
      `${path}.disposition.status`,
    );
    stringValue(disposition.rationale, `${path}.disposition.rationale`);
  });
  return {
    gate: "G1",
    requirements: parsedRequirements,
    riskCount: risks.length,
    traceRelationIds: idArray(row.traceRelationIds, "evidence.traceRelationIds"),
  };
}

function parseG2(row: Record<string, unknown>): G2Evidence {
  exactKeys(
    row,
    ["behavior", "criticalRequirementIds", "gate", "requirementIds", "schema", "traceRelationIds", "verificationMappings"],
    "evidence",
  );
  const behavior = objectValue(row.behavior, "evidence.behavior");
  exactKeys(behavior, ["exceptions", "functional", "performance", "timing"], "evidence.behavior");
  const behaviorCounts = {
    functional: boundedArray(behavior.functional, "evidence.behavior.functional").map((item, index) => stringValue(item, `evidence.behavior.functional[${index}]`)).length,
    performance: boundedArray(behavior.performance, "evidence.behavior.performance").map((item, index) => stringValue(item, `evidence.behavior.performance[${index}]`)).length,
    timing: boundedArray(behavior.timing, "evidence.behavior.timing").map((item, index) => stringValue(item, `evidence.behavior.timing[${index}]`)).length,
    exceptions: boundedArray(behavior.exceptions, "evidence.behavior.exceptions").map((item, index) => stringValue(item, `evidence.behavior.exceptions[${index}]`)).length,
  };
  const mappings = objectArray(row.verificationMappings, "evidence.verificationMappings");
  requireUniqueObjectIds(mappings, "evidence.verificationMappings");
  const mappedRequirementIds = mappings.map((mapping, index) => {
    const path = `evidence.verificationMappings[${index}]`;
    exactKeys(mapping, ["expected", "id", "method", "procedure", "requirementId"], path);
    idValue(mapping.id, `${path}.id`);
    enumValue(mapping.method, ["analysis", "inspection", "simulation", "test"] as const, `${path}.method`);
    stringValue(mapping.procedure, `${path}.procedure`);
    stringValue(mapping.expected, `${path}.expected`);
    return idValue(mapping.requirementId, `${path}.requirementId`);
  });
  const requirementIds = idArray(row.requirementIds, "evidence.requirementIds");
  const criticalRequirementIds = idArray(row.criticalRequirementIds, "evidence.criticalRequirementIds");
  if (criticalRequirementIds.some((id) => !requirementIds.includes(id))) {
    throw new GateEvidenceValidationError("evidence.criticalRequirementIds", "must be a subset of requirementIds");
  }
  if (mappedRequirementIds.some((id) => !requirementIds.includes(id))) {
    throw new GateEvidenceValidationError("evidence.verificationMappings", "contains a requirementId outside requirementIds");
  }
  return {
    gate: "G2",
    requirementIds,
    criticalRequirementIds,
    mappedRequirementIds,
    behaviorCounts,
    traceRelationIds: idArray(row.traceRelationIds, "evidence.traceRelationIds"),
  };
}

function parseG3(row: Record<string, unknown>): G3Evidence {
  exactKeys(
    row,
    ["architecture", "cdc", "clocks", "constraintStrategy", "designTrace", "gate", "interfaces", "registers", "resets", "schema", "traceRelationIds"],
    "evidence",
  );
  const architecture = objectValue(row.architecture, "evidence.architecture");
  exactKeys(architecture, ["components", "summary"], "evidence.architecture");
  stringValue(architecture.summary, "evidence.architecture.summary");
  const components = objectArray(architecture.components, "evidence.architecture.components");
  const componentIds = requireUniqueObjectIds(components, "evidence.architecture.components");
  components.forEach((component, index) => {
    const path = `evidence.architecture.components[${index}]`;
    exactKeys(component, ["id", "responsibility"], path);
    stringValue(component.responsibility, `${path}.responsibility`);
  });

  const interfaces = objectArray(row.interfaces, "evidence.interfaces");
  const interfaceIds = requireUniqueObjectIds(interfaces, "evidence.interfaces");
  interfaces.forEach((contract, index) => {
    const path = `evidence.interfaces[${index}]`;
    exactKeys(contract, ["contract", "id", "name"], path);
    stringValue(contract.name, `${path}.name`, 256);
    stringValue(contract.contract, `${path}.contract`);
  });

  const registers = objectArray(row.registers, "evidence.registers");
  const registerIds = requireUniqueObjectIds(registers, "evidence.registers");
  registers.forEach((register, index) => {
    const path = `evidence.registers[${index}]`;
    exactKeys(register, ["address", "description", "id", "name"], path);
    stringValue(register.name, `${path}.name`, 256);
    stringValue(register.address, `${path}.address`, 128);
    stringValue(register.description, `${path}.description`);
  });

  const clocks = objectArray(row.clocks, "evidence.clocks");
  const clockIds = requireUniqueObjectIds(clocks, "evidence.clocks");
  clocks.forEach((clock, index) => {
    const path = `evidence.clocks[${index}]`;
    exactKeys(clock, ["domain", "frequencyHz", "id", "name"], path);
    stringValue(clock.name, `${path}.name`, 256);
    stringValue(clock.domain, `${path}.domain`, 256);
    if (typeof clock.frequencyHz !== "number" || !Number.isSafeInteger(clock.frequencyHz) || clock.frequencyHz <= 0 || clock.frequencyHz > 1_000_000_000_000) {
      throw new GateEvidenceValidationError(`${path}.frequencyHz`, "must be a positive integer no greater than 1 THz");
    }
  });

  const resets = objectArray(row.resets, "evidence.resets");
  const resetIds = requireUniqueObjectIds(resets, "evidence.resets");
  resets.forEach((reset, index) => {
    const path = `evidence.resets[${index}]`;
    exactKeys(reset, ["domain", "id", "kind", "name", "polarity"], path);
    stringValue(reset.name, `${path}.name`, 256);
    stringValue(reset.domain, `${path}.domain`, 256);
    enumValue(reset.kind, ["asynchronous", "synchronous"] as const, `${path}.kind`);
    enumValue(reset.polarity, ["active_high", "active_low"] as const, `${path}.polarity`);
  });

  const cdc = objectValue(row.cdc, "evidence.cdc");
  const cdcStatus = enumValue(cdc.status, ["addressed", "not_applicable"] as const, "evidence.cdc.status");
  if (cdcStatus === "addressed") {
    exactKeys(cdc, ["crossings", "status"], "evidence.cdc");
    const crossings = objectArray(cdc.crossings, "evidence.cdc.crossings");
    requireUniqueObjectIds(crossings, "evidence.cdc.crossings");
    crossings.forEach((crossing, index) => {
      const path = `evidence.cdc.crossings[${index}]`;
      exactKeys(crossing, ["id", "sourceClockId", "strategy", "targetClockId"], path);
      const sourceClockId = idValue(crossing.sourceClockId, `${path}.sourceClockId`);
      const targetClockId = idValue(crossing.targetClockId, `${path}.targetClockId`);
      if (!clockIds.includes(sourceClockId) || !clockIds.includes(targetClockId)) {
        throw new GateEvidenceValidationError(path, "must reference declared clocks");
      }
      stringValue(crossing.strategy, `${path}.strategy`);
    });
  } else {
    exactKeys(cdc, ["rationale", "status"], "evidence.cdc");
    stringValue(cdc.rationale, "evidence.cdc.rationale");
  }

  const constraintStrategy = objectValue(row.constraintStrategy, "evidence.constraintStrategy");
  exactKeys(constraintStrategy, ["electrical", "pin", "timing"], "evidence.constraintStrategy");
  stringValue(constraintStrategy.pin, "evidence.constraintStrategy.pin");
  stringValue(constraintStrategy.electrical, "evidence.constraintStrategy.electrical");
  stringValue(constraintStrategy.timing, "evidence.constraintStrategy.timing");

  const designElementIds = uniqueIds(
    [...componentIds, ...interfaceIds, ...registerIds, ...clockIds, ...resetIds],
    "evidence design element ids",
  );
  const designTrace = objectArray(row.designTrace, "evidence.designTrace");
  requireUniqueObjectIds(designTrace, "evidence.designTrace");
  const tracedRequirementIds: string[] = [];
  const designTraceRelationIds: string[] = [];
  designTrace.forEach((trace, index) => {
    const path = `evidence.designTrace[${index}]`;
    exactKeys(trace, ["designElementId", "id", "relationId", "requirementId"], path);
    idValue(trace.id, `${path}.id`);
    const designElementId = idValue(trace.designElementId, `${path}.designElementId`);
    if (!designElementIds.includes(designElementId)) {
      throw new GateEvidenceValidationError(`${path}.designElementId`, "must reference a declared design element");
    }
    tracedRequirementIds.push(idValue(trace.requirementId, `${path}.requirementId`));
    designTraceRelationIds.push(idValue(trace.relationId, `${path}.relationId`));
  });
  return {
    gate: "G3",
    componentIds,
    designElementIds,
    tracedRequirementIds,
    traceRelationIds: idArray(row.traceRelationIds, "evidence.traceRelationIds"),
    designTraceRelationIds,
    cdcStatus,
  };
}

function parseEvidence(
  value: unknown,
  gate: P4StructuredGateId,
  memberRevisionIds: readonly string[],
): ParsedEvidence {
  const row = objectValue(value, "evidence");
  if (row.schema !== P4_GATE_EVIDENCE_SCHEMA) {
    throw new GateEvidenceValidationError("evidence.schema", `must be ${P4_GATE_EVIDENCE_SCHEMA}`);
  }
  if (row.gate !== gate) {
    throw new GateEvidenceValidationError("evidence.gate", `must exactly match ${gate}`);
  }
  if (gate === "G1") return parseG1(row, memberRevisionIds);
  if (gate === "G2") return parseG2(row);
  return parseG3(row);
}

function evidenceDocument(
  input: P4GateEvidenceInput,
): { readonly parsed: ParsedEvidence | null; readonly revisionId: string | null; readonly errors: readonly string[] } {
  const candidates: { revisionId: string; value: unknown }[] = [];
  const errors: string[] = [];
  for (const revision of input.revisions) {
    if (revision.projectId !== input.projectId || revision.bytes === null) continue;
    const size = Buffer.byteLength(revision.bytes, "utf8");
    if (size === 0) {
      errors.push(`${revision.revisionId}: empty revision bytes`);
      continue;
    }
    if (size > P4_GATE_EVIDENCE_MAX_BYTES) {
      errors.push(`${revision.revisionId}: exceeds ${P4_GATE_EVIDENCE_MAX_BYTES} bytes`);
      continue;
    }
    try {
      const value: unknown = JSON.parse(revision.bytes);
      if (
        value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as Record<string, unknown>).schema === P4_GATE_EVIDENCE_SCHEMA
      ) {
        candidates.push({ revisionId: revision.revisionId, value });
      }
    } catch {
      // Non-evidence snapshot members may be arbitrary source bytes. They do
      // not become evidence merely because they happen to be text.
    }
  }
  if (candidates.length !== 1) {
    errors.push(`expected exactly one ${P4_GATE_EVIDENCE_SCHEMA} document, found ${candidates.length}`);
    return { parsed: null, revisionId: null, errors };
  }
  const candidate = candidates[0]!;
  try {
    return {
      parsed: parseEvidence(candidate.value, input.gate, input.memberRevisionIds),
      revisionId: candidate.revisionId,
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "evidence document is invalid");
    return { parsed: null, revisionId: candidate.revisionId, errors };
  }
}

function frozenFacts(input: P4GateEvidenceInput): {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly actualManifestHash: string | null;
} {
  const errors: string[] = [];
  if (input.memberRevisionIds.length === 0 || new Set(input.memberRevisionIds).size !== input.memberRevisionIds.length) {
    errors.push("snapshot member ids must be non-empty and unique");
  }
  const byRevisionId = new Map(input.revisions.map((revision) => [revision.revisionId, revision]));
  if (byRevisionId.size !== input.memberRevisionIds.length) {
    errors.push("snapshot member revisions did not resolve exactly once");
  }
  const manifestMembers: { id: string; sha256: string }[] = [];
  for (const revisionId of input.memberRevisionIds) {
    const revision = byRevisionId.get(revisionId);
    if (!revision) {
      errors.push(`${revisionId}: revision is unresolved`);
      continue;
    }
    if (revision.projectId !== input.projectId) errors.push(`${revisionId}: revision belongs to another project`);
    if (!SHA256.test(revision.contentHash)) errors.push(`${revisionId}: content hash is malformed`);
    if (revision.bytes === null) {
      errors.push(`${revisionId}: managed revision bytes are unavailable`);
    } else if (sha256Hex(revision.bytes) !== revision.contentHash) {
      errors.push(`${revisionId}: managed revision bytes do not match content hash`);
    }
    manifestMembers.push({ id: revisionId, sha256: revision.contentHash });
  }
  const actualManifestHash = manifestMembers.length === input.memberRevisionIds.length
    ? computeManifestHash(manifestMembers)
    : null;
  if (actualManifestHash !== input.snapshotManifestHash) {
    errors.push("snapshot manifest hash does not match frozen member hashes");
  }

  if (input.traceRelationIds.length === 0 || new Set(input.traceRelationIds).size !== input.traceRelationIds.length) {
    errors.push("snapshot trace ids must be non-empty and unique");
  }
  const byTraceId = new Map(input.traces.map((trace) => [trace.id, trace]));
  if (byTraceId.size !== input.traceRelationIds.length) {
    errors.push("snapshot trace relations did not resolve exactly once");
  }
  for (const traceId of input.traceRelationIds) {
    const trace = byTraceId.get(traceId);
    if (!trace) {
      errors.push(`${traceId}: trace is unresolved`);
      continue;
    }
    if (trace.projectId !== input.projectId) errors.push(`${traceId}: trace belongs to another project`);
    if (trace.state !== "approved") errors.push(`${traceId}: trace is not approved`);
    if (trace.sourceProjectId !== input.projectId || trace.targetProjectId !== input.projectId) {
      errors.push(`${traceId}: trace endpoint belongs to another project or is unresolved`);
    }
    if (trace.basis.trim().length === 0) errors.push(`${traceId}: trace basis is empty`);
  }
  return { passed: errors.length === 0, errors, actualManifestHash };
}

function check(
  passed: boolean,
  details: Record<string, unknown>,
  revisionId: string | null,
  traceIds: readonly string[] = [],
): P4GateEvidenceCheck {
  return {
    passed,
    details,
    evidenceRefs: [
      ...(revisionId ? [{ type: "artifact_revision", id: revisionId }] : []),
      ...traceIds.map((id) => ({ type: "trace_relation", id })),
    ],
  };
}

/**
 * Evaluate G1-G3 only from immutable snapshot facts and managed revision bytes.
 * Artifact type, title, path, and prose keywords are deliberately absent from
 * the input contract so they cannot accidentally become acceptance criteria.
 */
export function evaluateP4GateEvidence(input: P4GateEvidenceInput): P4GateEvidenceEvaluation {
  const frozen = frozenFacts(input);
  const document = evidenceDocument(input);
  const parsed = document.parsed;
  const traceIdsMatch = parsed !== null && sameStringSet(parsed.traceRelationIds, input.traceRelationIds);
  const frozenTraceIds = new Set(input.traceRelationIds);
  const boundTraces = input.traces.filter((trace) => frozenTraceIds.has(trace.id));
  const expectedTraceSources = parsed?.gate === "G1"
    ? [...new Set(parsed.requirements.map((requirement) => requirement.sourceRevisionId))].sort()
    : [...(input.authoritativeRequirements?.frozenRevisionIds ?? [])].sort();
  const observedTraceSources = [...new Set(boundTraces.map((trace) => trace.sourceRevisionId))].sort();
  const traceTargetsEvidence = document.revisionId !== null
    && boundTraces.length > 0
    && boundTraces.every((trace) => trace.targetRevisionId === document.revisionId);
  const traceSourcesFrozen = expectedTraceSources.length > 0
    && observedTraceSources.every((revisionId) => expectedTraceSources.includes(revisionId));
  const requirementSourcesTraced = parsed?.gate !== "G1"
    || expectedTraceSources.every((revisionId) => observedTraceSources.includes(revisionId));
  const traceEndpointsBound = traceTargetsEvidence && traceSourcesFrozen && requirementSourcesTraced;
  const baseDetails = {
    schema: P4_GATE_EVIDENCE_SCHEMA,
    gate: input.gate,
    evidenceRevisionId: document.revisionId,
    errors: document.errors,
  };
  const checks: Record<string, P4GateEvidenceCheck> = {
    "snapshot.members_frozen": check(
      frozen.passed && traceIdsMatch && traceEndpointsBound,
      {
        snapshotId: input.snapshotId,
        snapshotManifestHash: input.snapshotManifestHash,
        actualManifestHash: frozen.actualManifestHash,
        memberCount: input.memberRevisionIds.length,
        resolvedMemberCount: input.revisions.length,
        traceCount: input.traceRelationIds.length,
        resolvedTraceCount: input.traces.length,
        traceIdsMatchEvidence: traceIdsMatch,
        traceTargetsEvidence,
        traceSourcesFrozen,
        requirementSourcesTraced,
        expectedTraceSourceRevisionIds: expectedTraceSources,
        observedTraceSourceRevisionIds: observedTraceSources,
        errors: [
          ...frozen.errors,
          ...(parsed !== null && !traceIdsMatch ? ["evidence trace ids do not match snapshot trace ids"] : []),
          ...(parsed !== null && !traceTargetsEvidence ? ["every frozen trace must target the evidence revision"] : []),
          ...(parsed !== null && !traceSourcesFrozen ? ["every frozen trace source must belong to the authoritative frozen revisions"] : []),
          ...(parsed?.gate === "G1" && !requirementSourcesTraced ? ["every requirement source revision must be covered by a frozen trace"] : []),
        ],
      },
      document.revisionId,
      input.traceRelationIds,
    ),
  };
  let authority: P4RequirementAuthority | null = null;

  if (input.gate === "G1") {
    const g1 = parsed?.gate === "G1" ? parsed : null;
    const sourceRevisionIds = g1?.requirements.map((requirement) => requirement.sourceRevisionId).sort() ?? [];
    const revisionsById = new Map(input.revisions.map((revision) => [revision.revisionId, revision]));
    const sourceMaterialsPresent = document.revisionId !== null
      && sourceRevisionIds.length > 0
      && sourceRevisionIds.every((revisionId) => {
        const source = revisionsById.get(revisionId);
        return revisionId !== document.revisionId
          && source?.projectId === input.projectId
          && source.bytes !== null
          && source.bytes.trim().length > 0;
      });
    authority = g1 ? {
      requirementIds: g1.requirements.map((requirement) => requirement.id).sort(),
      criticalRequirementIds: g1.requirements.filter((requirement) => requirement.critical).map((requirement) => requirement.id).sort(),
      frozenRevisionIds: [...input.memberRevisionIds].sort(),
    } : null;
    checks["artifact.development_requirements"] = check(
      g1 !== null && sourceMaterialsPresent,
      {
        ...baseDetails,
        requirementIds: authority?.requirementIds ?? [],
        criticalRequirementIds: authority?.criticalRequirementIds ?? [],
        riskCount: g1?.riskCount ?? 0,
        sourceRevisionIds,
        sourceMaterialsPresent,
      },
      document.revisionId,
    );
  } else if (input.gate === "G2") {
    const g2 = parsed?.gate === "G2" ? parsed : null;
    const authoritative = input.authoritativeRequirements ?? null;
    const requirementSetMatches = g2 !== null && authoritative !== null
      && sameStringSet(g2.requirementIds, authoritative.requirementIds);
    const criticalSetMatches = g2 !== null && authoritative !== null
      && sameStringSet(g2.criticalRequirementIds, authoritative.criticalRequirementIds);
    const missingCriticalMappings = authoritative === null || g2 === null
      ? authoritative?.criticalRequirementIds ?? []
      : authoritative.criticalRequirementIds.filter((id) => !g2.mappedRequirementIds.includes(id));
    checks["artifact.behavior_spec"] = check(
      g2 !== null,
      { ...baseDetails, behaviorCounts: g2?.behaviorCounts ?? null },
      document.revisionId,
    );
    checks["artifact.verification_method_map"] = check(
      g2 !== null
        && authoritative !== null
        && requirementSetMatches
        && criticalSetMatches
        && missingCriticalMappings.length === 0,
      {
        ...baseDetails,
        authoritativeRequirementIds: authoritative?.requirementIds ?? [],
        authoritativeCriticalRequirementIds: authoritative?.criticalRequirementIds ?? [],
        declaredRequirementIds: g2?.requirementIds ?? [],
        declaredCriticalRequirementIds: g2?.criticalRequirementIds ?? [],
        mappedRequirementIds: g2?.mappedRequirementIds ?? [],
        requirementSetMatches,
        criticalSetMatches,
        missingCriticalMappings,
      },
      document.revisionId,
    );
  } else {
    const g3 = parsed?.gate === "G3" ? parsed : null;
    const authoritative = input.authoritativeRequirements ?? null;
    const missingDesignTrace = authoritative === null || g3 === null
      ? authoritative?.criticalRequirementIds ?? []
      : authoritative.criticalRequirementIds.filter((id) => !g3.tracedRequirementIds.includes(id));
    const unknownRequirements = g3 === null || authoritative === null
      ? []
      : g3.tracedRequirementIds.filter((id) => !authoritative.requirementIds.includes(id));
    const unknownRelations = g3 === null
      ? []
      : g3.designTraceRelationIds.filter((id) => !input.traceRelationIds.includes(id));
    checks["artifact.architecture_design"] = check(
      g3 !== null,
      {
        ...baseDetails,
        componentIds: g3?.componentIds ?? [],
        designElementCount: g3?.designElementIds.length ?? 0,
      },
      document.revisionId,
    );
    checks["artifact.detailed_design"] = check(
      g3 !== null
        && authoritative !== null
        && missingDesignTrace.length === 0
        && unknownRequirements.length === 0
        && unknownRelations.length === 0,
      {
        ...baseDetails,
        cdcStatus: g3?.cdcStatus ?? null,
        authoritativeCriticalRequirementIds: authoritative?.criticalRequirementIds ?? [],
        tracedRequirementIds: g3?.tracedRequirementIds ?? [],
        missingDesignTrace,
        unknownRequirements,
        unknownRelations,
      },
      document.revisionId,
      g3?.designTraceRelationIds ?? [],
    );
    checks["artifact.constraint_design"] = check(
      g3 !== null,
      { ...baseDetails, constraintStrategyDefined: g3 !== null },
      document.revisionId,
    );
  }
  return { checks, authority, evidenceRevisionId: document.revisionId };
}
