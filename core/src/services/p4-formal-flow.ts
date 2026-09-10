import { hashPayload, sha256Hex, stableStringify } from "../hashing.ts";
import { parseGitLocation, validateWorkspacePath } from "../workspace/paths.ts";

export const FORMAL_OPERATIONS = [
  "implement",
  "simulate",
  "synthesize",
  "validate_sources",
] as const;

export type FormalOperation = (typeof FORMAL_OPERATIONS)[number];

export interface EngineeringConstraintClassV1 {
  readonly state: "complete" | "partial" | "missing";
  readonly revisionIds: readonly string[];
}

export interface EngineeringConfigV1 {
  readonly schema: "engineering-config.v1";
  readonly targetPart: {
    readonly value: string | null;
    readonly state: "identified" | "missing";
  };
  readonly board: {
    readonly ref: string | null;
    readonly state: "identified" | "missing";
  };
  readonly constraints: {
    readonly pin: EngineeringConstraintClassV1;
    readonly electrical: EngineeringConstraintClassV1;
    readonly clock: EngineeringConstraintClassV1;
  };
  readonly dataScope: {
    readonly classification: string;
    readonly description: string;
  };
  readonly sourcePolicy: {
    readonly confirmedOnly: true;
  };
}

export class P4ValidationError extends Error {
  constructor(message: string, readonly details: unknown = null) {
    super(message);
    this.name = "P4ValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new P4ValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new P4ValidationError(`${path} has unexpected or missing fields`, { actual, expected: wanted });
  }
}

function nonEmptyString(value: unknown, path: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new P4ValidationError(`${path} must be a non-empty string${nullable ? " or null" : ""}`);
  }
  if (/\u0000|[\u0001-\u001f\u007f]/u.test(value)) {
    throw new P4ValidationError(`${path} contains control characters`);
  }
  return value;
}

function uniqueStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new P4ValidationError(`${path} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new P4ValidationError(`${path} must not contain duplicates`);
  }
  return [...value].sort();
}

function parseConstraintClass(value: unknown, path: string): EngineeringConstraintClassV1 {
  const row = record(value, path);
  exactKeys(row, ["revisionIds", "state"], path);
  if (row.state !== "complete" && row.state !== "partial" && row.state !== "missing") {
    throw new P4ValidationError(`${path}.state must be complete, partial, or missing`);
  }
  const revisionIds = uniqueStringArray(row.revisionIds, `${path}.revisionIds`);
  if (row.state === "complete" && revisionIds.length === 0) {
    throw new P4ValidationError(`${path}.revisionIds must be non-empty when state is complete`);
  }
  if (row.state === "missing" && revisionIds.length !== 0) {
    throw new P4ValidationError(`${path}.revisionIds must be empty when state is missing`);
  }
  return { state: row.state, revisionIds };
}

/** Parse the frozen engineering-config.v1 shape without trusting derived booleans. */
export function parseEngineeringConfig(value: unknown): EngineeringConfigV1 {
  const row = record(value, "engineering_config");
  exactKeys(row, ["board", "constraints", "dataScope", "schema", "sourcePolicy", "targetPart"], "engineering_config");
  if (row.schema !== "engineering-config.v1") {
    throw new P4ValidationError("engineering_config.schema must be engineering-config.v1");
  }

  const target = record(row.targetPart, "engineering_config.targetPart");
  exactKeys(target, ["state", "value"], "engineering_config.targetPart");
  if (target.state !== "identified" && target.state !== "missing") {
    throw new P4ValidationError("engineering_config.targetPart.state is invalid");
  }
  const targetValue = nonEmptyString(target.value, "engineering_config.targetPart.value", true);
  if ((target.state === "identified") !== (targetValue !== null)) {
    throw new P4ValidationError("engineering_config.targetPart value disagrees with state");
  }

  const board = record(row.board, "engineering_config.board");
  exactKeys(board, ["ref", "state"], "engineering_config.board");
  if (board.state !== "identified" && board.state !== "missing") {
    throw new P4ValidationError("engineering_config.board.state is invalid");
  }
  const boardRef = nonEmptyString(board.ref, "engineering_config.board.ref", true);
  if ((board.state === "identified") !== (boardRef !== null)) {
    throw new P4ValidationError("engineering_config.board ref disagrees with state");
  }

  const constraints = record(row.constraints, "engineering_config.constraints");
  exactKeys(constraints, ["clock", "electrical", "pin"], "engineering_config.constraints");
  const parsedConstraints = {
    pin: parseConstraintClass(constraints.pin, "engineering_config.constraints.pin"),
    electrical: parseConstraintClass(constraints.electrical, "engineering_config.constraints.electrical"),
    clock: parseConstraintClass(constraints.clock, "engineering_config.constraints.clock"),
  };

  const dataScope = record(row.dataScope, "engineering_config.dataScope");
  exactKeys(dataScope, ["classification", "description"], "engineering_config.dataScope");
  const classification = nonEmptyString(dataScope.classification, "engineering_config.dataScope.classification")!;
  const description = nonEmptyString(dataScope.description, "engineering_config.dataScope.description")!;
  if (!new Set(["D1", "D2", "D3", "D4", "UNCLASSIFIED"]).has(classification)) {
    throw new P4ValidationError("engineering_config.dataScope.classification is invalid");
  }

  const sourcePolicy = record(row.sourcePolicy, "engineering_config.sourcePolicy");
  exactKeys(sourcePolicy, ["confirmedOnly"], "engineering_config.sourcePolicy");
  if (sourcePolicy.confirmedOnly !== true) {
    throw new P4ValidationError("engineering_config.sourcePolicy.confirmedOnly must be true");
  }

  return {
    schema: "engineering-config.v1",
    targetPart: { value: targetValue, state: target.state },
    board: { ref: boardRef, state: board.state },
    constraints: parsedConstraints,
    dataScope: { classification, description },
    sourcePolicy: { confirmedOnly: true },
  };
}

export function engineeringConfigFacts(config: EngineeringConfigV1): {
  readonly configHash: string;
  readonly constraintsComplete: boolean;
  readonly constraintRevisionIds: readonly string[];
  readonly constraintHash: string;
} {
  const constraintRevisionIds = [...new Set([
    ...config.constraints.pin.revisionIds,
    ...config.constraints.electrical.revisionIds,
    ...config.constraints.clock.revisionIds,
  ])].sort();
  const constraintsComplete = (
    config.constraints.pin.state === "complete"
    && config.constraints.electrical.state === "complete"
    && config.constraints.clock.state === "complete"
  );
  return {
    configHash: hashPayload(config),
    constraintsComplete,
    constraintRevisionIds,
    constraintHash: hashPayload({
      schema: "constraint-binding.v1",
      pin: config.constraints.pin,
      electrical: config.constraints.electrical,
      clock: config.constraints.clock,
    }),
  };
}

export interface FormalInputFileV1 {
  readonly revision_id: string;
  readonly path: string;
  readonly role: "rtl" | "tb" | "constraint" | "document";
  readonly sha256: string;
  readonly size_bytes: number;
  readonly storage_uri: string;
}

const FORBIDDEN_FORMAL_PATH_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".idea",
  ".vscode",
  "cache",
  "coverage",
  "dist",
  "node_modules",
]);
const FORBIDDEN_FORMAL_BASENAMES = /^(?:\.env(?:\..*)?|credentials|id_(?:dsa|ecdsa|ed25519|rsa)|known_hosts|\.netrc|\.npmrc)$/i;
const FORBIDDEN_FORMAL_EXTENSIONS = /\.(?:cer|crt|der|jks|key|keystore|p12|pfx|pem)$/i;
const FORBIDDEN_FORMAL_CONTENT = /-----BEGIN (?:[A-Z0-9 ]+ )?(?:PRIVATE KEY|CERTIFICATE)-----|OPENSSH PRIVATE KEY|AWS_SECRET_ACCESS_KEY\s*[:=]/i;

/** Reject caches and credential material before bytes enter a formal bundle. */
export function validateFormalInputContent(path: string, text: string): void {
  const normalized = validateWorkspacePath(path);
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (
    segments.some((segment) => FORBIDDEN_FORMAL_PATH_SEGMENTS.has(segment.toLowerCase()))
    || FORBIDDEN_FORMAL_BASENAMES.test(basename)
    || FORBIDDEN_FORMAL_EXTENSIONS.test(basename)
    || FORBIDDEN_FORMAL_CONTENT.test(text)
  ) {
    throw new P4ValidationError("formal input contains cache, secret, or certificate material", {
      path: normalized,
    });
  }
}

export type XdcConstraintKind = "pin" | "electrical" | "clock";

/**
 * Prove the smallest category-specific XDC fact used by G0 readiness.
 *
 * This is intentionally a fail-closed lexical check, not a Tcl evaluator. Full
 * constraint semantics still belong to the governed Vivado run; G0 only needs
 * to ensure that a human declaration of `complete` is backed by at least one
 * active command of the corresponding kind. Comment-only markers never count.
 */
export function hasXdcConstraintFact(text: string, kind: XdcConstraintKind): boolean {
  const commands = text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/u, "").trim())
    .filter((line) => line.length > 0);

  if (kind === "clock") {
    return commands.some((command) => /\bcreate_(?:generated_)?clock\b/i.test(command));
  }
  const property = kind === "pin" ? /\bPACKAGE_PIN\b/i : /\bIOSTANDARD\b/i;
  return commands.some((command) => /\bset_property\b/i.test(command) && property.test(command));
}

export function formalRoleForArtifactType(type: string): FormalInputFileV1["role"] {
  if (type === "RTL_SOURCE_SET") return "rtl";
  if (type === "TB_SOURCE_SET") return "tb";
  if (type === "XDC_CANDIDATE" || type === "CONSTRAINT_DESIGN") return "constraint";
  return "document";
}

/** Resolve only governed workspace-relative paths; DB/mem/tmp URIs never enter a formal bundle. */
export function formalPath(contentLocation: string): string {
  const git = parseGitLocation(contentLocation);
  return validateWorkspacePath(git?.path ?? contentLocation);
}

export interface FormalInputManifestV1 {
  readonly schema: "formal-input.v1";
  readonly projectId: string;
  readonly processVersionId: "GJB_REF_V1";
  readonly workVersionId: string;
  readonly targetGate: "G4";
  readonly purpose: "g4_delivery";
  readonly configurationSnapshot: { readonly id: string; readonly manifestHash: string };
  readonly prerequisiteBaseline: { readonly id: string; readonly kind: "B1"; readonly manifestHash: string };
  readonly readiness: { readonly id: string; readonly engineeringConfigHash: string };
  readonly targetPart: string;
  readonly toolchain: { readonly connectorId: string; readonly profileHash: string };
  readonly allowedOperations: readonly FormalOperation[];
  readonly files: readonly FormalInputFileV1[];
}

export function buildFormalInputManifest(input: Omit<FormalInputManifestV1, "schema" | "processVersionId" | "targetGate" | "purpose" | "allowedOperations" | "files"> & {
  readonly files: readonly FormalInputFileV1[];
}): FormalInputManifestV1 {
  const files = [...input.files].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new P4ValidationError("formal input files must be non-empty with unique paths");
  }
  return {
    schema: "formal-input.v1",
    projectId: input.projectId,
    processVersionId: "GJB_REF_V1",
    workVersionId: input.workVersionId,
    targetGate: "G4",
    purpose: "g4_delivery",
    configurationSnapshot: input.configurationSnapshot,
    prerequisiteBaseline: input.prerequisiteBaseline,
    readiness: input.readiness,
    targetPart: input.targetPart,
    toolchain: input.toolchain,
    allowedOperations: FORMAL_OPERATIONS,
    files,
  };
}

export function buildFormalPreview(input: {
  readonly manifest: FormalInputManifestV1;
  readonly readinessId: string;
  readonly authorizedTaskId: string;
  readonly toolchainProfileHash: string;
  readonly constraintsComplete: boolean;
}): Record<string, unknown> {
  const inputHash = hashPayload(input.manifest);
  const body = {
    schema: "formal-input-preview.v1" as const,
    work_version_id: input.manifest.workVersionId,
    snapshot_id: input.manifest.configurationSnapshot.id,
    readiness_id: input.readinessId,
    authorized_task_id: input.authorizedTaskId,
    prerequisite_baseline_id: input.manifest.prerequisiteBaseline.id,
    target_part: input.manifest.targetPart,
    toolchain_profile_hash: input.toolchainProfileHash,
    constraints_complete: input.constraintsComplete,
    purpose: "g4_delivery" as const,
    allowed_operations: FORMAL_OPERATIONS,
    files: input.manifest.files,
    input_hash: inputHash,
  };
  return { ...body, preview_hash: hashPayload(body) };
}

export type EvidenceKind =
  | "rtl"
  | "testbench"
  | "constraint"
  | "simulation"
  | "synthesis"
  | "implementation"
  | "drc"
  | "timing"
  | "bitstream"
  | "log"
  | "report"
  | "document"
  | "confirmation"
  | "source_version"
  | "other";

export function validateEvidenceName(name: string): string {
  if (
    name.length === 0
    || name.length > 512
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    || name.startsWith("/")
    || name.includes("\\")
    || name.includes("\0")
    || name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new P4ValidationError("evidence entry name is unsafe", { name });
  }
  return name;
}

export function evidenceKind(name: string): EvidenceKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".bit")) return "bitstream";
  if (/(^|\/)drc(?:[._-]|$)/.test(lower)) return "drc";
  if (/(^|\/)(?:sta|timing)(?:[._-]|$)/.test(lower)) return "timing";
  if (/synth\.dcp$/.test(lower)) return "synthesis";
  if (/routed\.dcp$/.test(lower)) return "implementation";
  if (/simulation[_-]result|simulate[_-]result/.test(lower)) return "simulation";
  if (/synthesis[_-]result|resources?\.rpt$/.test(lower)) return "synthesis";
  if (/implementation[_-]result/.test(lower) || /routed\.dcp$/.test(lower)) return "implementation";
  if (/\.log$|stdout|stderr|run\.tcl$/.test(lower)) return "log";
  if (/\.rpt$/.test(lower)) return "report";
  if (/input.*manifest|request-input/.test(lower)) return "source_version";
  return "other";
}

export function evidenceRole(name: string, kind: EvidenceKind): string {
  const lower = name.toLowerCase();
  if (kind === "bitstream") return "bitstream";
  if (kind === "drc") return "drc_report";
  if (kind === "timing") return "timing_report";
  if (/validation[_-]result\.json$/.test(lower)) return "validation_result";
  if (kind === "simulation") return "simulation_result";
  if (/resources?\.rpt$/.test(lower)) return "utilization_report";
  if (kind === "synthesis") return lower.endsWith(".dcp") ? "synth_checkpoint" : "synthesis_result";
  if (kind === "implementation") return lower.endsWith(".dcp") ? "routed_checkpoint" : "implementation_result";
  if (lower === "run.tcl" || lower.endsWith("/run.tcl")) return "run_script";
  if (/stdout/i.test(name)) return "stdout_log";
  if (/stderr/i.test(name)) return "stderr_log";
  if (/(^|\/)tool\.log$|vivado\.log$/i.test(name)) return "tool_log";
  if (kind === "source_version") return "input_manifest";
  return kind === "log" ? "tool_log" : "raw_evidence";
}

export interface DrcVerdictV1 {
  readonly determined: boolean;
  readonly errorCount: number | null;
  readonly clean: boolean;
}

export function parseDrcReport(text: string): DrcVerdictV1 {
  const finished = text.match(/DRC finished with\s+(\d+)\s+Errors?/i);
  if (finished) {
    const errorCount = Number(finished[1]);
    return { determined: true, errorCount, clean: errorCount === 0 };
  }
  const explicit = [...text.matchAll(/^\|\s*[^|]+\|\s*Error\s*\|[^|]*\|\s*(\d+)\s*\|\s*$/gim)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const violations = text.match(/Violations found:\s*(\d+)/i);
  if (violations) {
    const total = Number(violations[1]);
    if (explicit > 0) return { determined: true, errorCount: explicit, clean: false };
    if (total === 0) return { determined: true, errorCount: 0, clean: true };
    // Non-zero violations with no severity summary cannot prove that none are errors.
    return { determined: false, errorCount: null, clean: false };
  }
  if (/^\S+#\d+\s+Error\s*$/im.test(text)) {
    return { determined: true, errorCount: Math.max(explicit, 1), clean: false };
  }
  return { determined: false, errorCount: null, clean: false };
}

export interface TimingVerdictV1 {
  readonly determined: boolean;
  readonly met: boolean;
  readonly worstSlack: number | null;
  readonly coveredClocks: readonly string[];
}

export function parseTimingReport(text: string): TimingVerdictV1 {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => /\bWNS\(ns\)/.test(line) && /\bTNS\(ns\)/.test(line));
  let worstSlack: number | null = null;
  if (header >= 0) {
    for (const line of lines.slice(header + 1, header + 9)) {
      const values = line.trim().split(/\s+/);
      if (values.length >= 2 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(values[0] ?? "")) {
        worstSlack = Number(values[0]);
        break;
      }
    }
  }
  const coveredClocks = [...new Set([
    ...[...text.matchAll(/^\s*(?:Clock|Path Group)\s*:\s*([^\s].*?)\s*$/gim)].map((match) => match[1]!.trim()),
    // Clock Summary table rows carry TWO trailing numbers (period + frequency),
    // so the row must not be anchored to a single trailing value.
    ...[...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_./:-]*)\s+\{[^}]*\}\s+[\d.]+/gm)].map((match) => match[1]!),
  ])].sort();
  const explicitlyMet = /All user specified timing constraints are met\./i.test(text);
  const explicitlyFailed = /timing constraints are not met/i.test(text) || /Slack\s*\(VIOLATED\)/i.test(text);
  const unconstrained = /(?:unconstrained paths?|no clocks? found|no timing constraints?)/i.test(text);
  if (explicitlyFailed || (worstSlack !== null && worstSlack < 0)) {
    return { determined: true, met: false, worstSlack, coveredClocks };
  }
  if (explicitlyMet && worstSlack !== null && !unconstrained) {
    return {
      determined: true,
      met: true,
      worstSlack,
      coveredClocks,
    };
  }
  return { determined: false, met: false, worstSlack, coveredClocks };
}

/** Extract the clock names the governed XDC asks timing analysis to cover. */
export function expectedClockNames(xdc: string): readonly string[] {
  const clocks = new Set<string>();
  for (const rawLine of xdc.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!/\bcreate_clock\b/.test(line)) continue;
    const named = line.match(/(?:^|\s)-name\s+(?:\{([^}]+)\}|"([^"]+)"|([^\s\]]+))/);
    const port = line.match(/\[get_ports\s+(?:\{([^}]+)\}|"([^"]+)"|([^\]\s]+))/);
    const value = named?.[1] ?? named?.[2] ?? named?.[3]
      ?? port?.[1] ?? port?.[2] ?? port?.[3];
    if (value?.trim()) clocks.add(value.trim());
  }
  return [...clocks].sort();
}

export function parseSimulationLog(text: string): { readonly determined: boolean; readonly passed: boolean } {
  const begin = text.indexOf("SIMULATOR_OUTPUT_BEGIN");
  const end = text.lastIndexOf("SIMULATOR_OUTPUT_END");
  const region = begin >= 0 && end > begin
    ? text.slice(begin + "SIMULATOR_OUTPUT_BEGIN".length, end)
    : text;
  if (/\bFatal:/i.test(region) || /\$fatal/i.test(region) || /^\s*FAIL\b/im.test(region)) {
    return { determined: true, passed: false };
  }
  if (/\bPASS\b/.test(region) && /SIMULATION_OK|PHASE_EXIT_CODE=0/.test(text)) {
    return { determined: true, passed: true };
  }
  return { determined: false, passed: false };
}

export interface FrozenEvidenceCandidate {
  readonly name: string;
  readonly role: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly verdict: Readonly<Record<string, unknown>> | null;
}

function textEntry(entries: readonly FrozenEvidenceCandidate[], predicate: (entry: FrozenEvidenceCandidate) => boolean): string | null {
  const entry = entries.find(predicate);
  if (!entry) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
  } catch {
    return null;
  }
}

function resultEvidence(
  entries: readonly FrozenEvidenceCandidate[],
  role: string,
  schema: string,
): { readonly determined: boolean; readonly passed: boolean } {
  const text = textEntry(entries, (entry) => entry.role === role);
  if (text === null) return { determined: false, passed: false };
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { determined: false, passed: false };
    }
    const row = value as Record<string, unknown>;
    const determined = row.schema === schema
      && typeof row.passed === "boolean"
      && typeof row.status === "string"
      && typeof row.exitCode === "number"
      && Number.isInteger(row.exitCode)
      && typeof row.timedOut === "boolean";
    return {
      determined,
      passed: determined
        && row.passed === true
        && row.status === "succeeded"
        && row.exitCode === 0
        && row.timedOut === false,
    };
  } catch {
    return { determined: false, passed: false };
  }
}

/** Core-owned, versioned interpretation. Unknown/missing facts remain false. */
export function evidenceVerdicts(
  operation: FormalOperation,
  entries: readonly FrozenEvidenceCandidate[],
): Record<string, unknown> {
  const common = {
    inputManifest: entries.some((entry) => entry.role === "input_manifest"),
    runScript: entries.some((entry) => entry.role === "run_script"),
    stdout: entries.some((entry) => entry.role === "stdout_log"),
    stderr: entries.some((entry) => entry.role === "stderr_log"),
    toolLog: entries.some((entry) => entry.role === "tool_log"),
  };
  const stdout = textEntry(entries, (entry) => entry.role === "stdout_log") ?? "";
  if (operation === "validate_sources") {
    const result = resultEvidence(entries, "validation_result", "validate_sources-result.v1");
    const marker = /(?:^|\r?\n)SOURCE_VALIDATION_OK(?:\r?\n|$)/.test(stdout);
    const validation = {
      determined: result.determined && marker,
      passed: result.passed && marker,
    };
    return { parserVersion: "p4-evidence-parser.v1", common, validation };
  }
  if (operation === "simulate") {
    const raw = parseSimulationLog(stdout);
    const result = resultEvidence(entries, "simulation_result", "simulate-result.v1");
    return {
      parserVersion: "p4-evidence-parser.v1",
      common,
      simulation: {
        determined: raw.determined && result.determined,
        passed: raw.passed && result.passed,
      },
    };
  }
  if (operation === "synthesize") {
    const result = resultEvidence(entries, "synthesis_result", "synthesize-result.v1");
    const utilization = entries.some((entry) => entry.role === "utilization_report");
    return {
      parserVersion: "p4-evidence-parser.v1",
      common,
      synthesis: {
        determined: result.determined && utilization,
        passed: result.passed && utilization,
        result: result.determined,
        utilizationReport: utilization,
      },
    };
  }
  const drcText = textEntry(entries, (entry) => entry.kind === "drc");
  const timingText = textEntry(entries, (entry) => entry.kind === "timing");
  const result = resultEvidence(entries, "implementation_result", "implement-result.v1");
  const required = [
    "implementation_result",
    "synth_checkpoint",
    "drc_report",
    "timing_report",
    "utilization_report",
    "routed_checkpoint",
    "bitstream",
  ] as const;
  const present = new Set(entries.map((entry) => entry.role));
  const complete = result.passed && required.every((role) => present.has(role));
  return {
    parserVersion: "p4-evidence-parser.v1",
    common,
    implementation: {
      determined: result.determined && required.every((role) => present.has(role)),
      passed: complete,
      requiredEntries: Object.fromEntries(required.map((role) => [role, present.has(role)])),
    },
    drc: drcText === null ? { determined: false, errorCount: null, clean: false } : parseDrcReport(drcText),
    timing: timingText === null ? { determined: false, met: false, worstSlack: null, coveredClocks: [] } : parseTimingReport(timingText),
  };
}

export function evidenceManifestHash(entries: readonly FrozenEvidenceCandidate[]): string {
  const line = [...entries]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map((entry) => `${entry.name}:${entry.sha256}:${entry.sizeBytes}:${entry.kind}`)
    .join("\n");
  return sha256Hex(line);
}

export function inlineJsonItem(value: unknown): { readonly uri: string; readonly sha256: string; readonly sizeBytes: number } {
  const bytes = new TextEncoder().encode(stableStringify(value));
  return {
    uri: `data:application/json;base64,${Buffer.from(bytes).toString("base64")}`,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
  };
}
