import { createHash } from "node:crypto";

export const EVOLUTION_EVAL_RUN_CLASS = "evolution_eval" as const;
export const EVOLUTION_EVAL_DISPATCH_SCHEMA = "evolution-eval-dispatch-request.v1" as const;
export const EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA = "evolution-eval-ledger-query.v1" as const;
export const EVOLUTION_EVAL_OPERATION_CAP_MS = 7_200_000;
export const EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES = 2_147_483_648 as const;
export const EVOLUTION_EVAL_EVIDENCE_LIMITS = Object.freeze({
  entries: 128,
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  quarantineMs: 24 * 60 * 60 * 1000,
  absoluteRetentionMs: 7 * 24 * 60 * 60 * 1000,
});
/** 576 MiB decoded workspace plus worst-case base64 and bounded JSON metadata overhead. */
export const EVOLUTION_EVAL_HTTP_BODY_MAX_BYTES = 850 * 1024 * 1024;
export const EVOLUTION_EVAL_LIMITS = Object.freeze({
  source: Object.freeze({ files: 4096, bytes: 512 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }),
  skill: Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024 }),
  overlay: Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024 }),
  workspace: Object.freeze({ files: 5120, bytes: 576 * 1024 * 1024 }),
});
export const EVOLUTION_EVAL_OPERATIONS = [
  "validate_sources",
  "simulate",
  "synthesize",
  "implement",
] as const;

export type EvolutionEvalOperation = (typeof EVOLUTION_EVAL_OPERATIONS)[number];
export type EvolutionEvalExecutionState = "queued" | "preparing" | "running";
export type EvolutionEvalTerminalState = "succeeded" | "failed" | "cancelled" | "timeout";

export type EvolutionEvalParametersV1 =
  | {
      readonly operation: "validate_sources";
      readonly source_paths: readonly string[];
      readonly top: string | null;
    }
  | {
      readonly operation: "simulate";
      readonly source_paths: readonly string[];
      readonly top: string;
      readonly testbench: string;
    }
  | {
      readonly operation: "synthesize";
      readonly source_paths: readonly string[];
      readonly top: string;
      readonly part: string;
    }
  | {
      readonly operation: "implement";
      readonly source_paths: readonly string[];
      readonly constraint_paths: readonly string[];
      readonly top: string;
      readonly part: string;
      readonly generate_trial_bitstream: boolean;
    };

/**
 * Exact canonical object hashed by Core when it seals an evolution-eval
 * dispatch. Keep this shape in lock-step with Core's
 * `evolution-eval-dispatch-request.v1`; do not add transport-only fields.
 */
export interface EvolutionEvalDispatchRequestV1 {
  readonly schema: typeof EVOLUTION_EVAL_DISPATCH_SCHEMA;
  readonly eval_job_id: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly eval_input_ref: string;
  readonly input_manifest_hash: string;
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly workspace_manifest_hash: string;
  readonly sealed_input_projection_hash: string;
  readonly operation: EvolutionEvalOperation;
  readonly parameters: EvolutionEvalParametersV1;
  readonly part: string | null;
  readonly toolchain_profile_hash: string;
  readonly requested_timeout_ms: number;
  readonly operation_cap_ms: typeof EVOLUTION_EVAL_OPERATION_CAP_MS;
  readonly deadline_at: string;
  readonly run_class: typeof EVOLUTION_EVAL_RUN_CLASS;
}

/** Core-internal binding. `project_id` belongs to the remote envelope, not the dispatch hash. */
export interface CoreIssuedEvalBinding {
  readonly project_id: string;
  readonly dispatch_request_hash: string;
  readonly dispatch: EvolutionEvalDispatchRequestV1;
}

export interface EvolutionEvalWorkspaceManifestFileV1 {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly layer: "source" | "skill" | "overlay";
  readonly read_only: boolean;
}

export interface EvolutionEvalWorkspaceManifestV1 {
  readonly schema: "evolution-eval-workspace-manifest.v1";
  readonly workspace_id: string;
  readonly revision: number;
  readonly files: readonly EvolutionEvalWorkspaceManifestFileV1[];
}

export interface EvolutionEvalSealedFileV1 {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly content_base64: string;
}

export interface EvolutionEvalSealedInputV1 {
  readonly schema: "evolution-eval-sealed-input.v1";
  readonly manifest: EvolutionEvalWorkspaceManifestV1;
  readonly files: readonly EvolutionEvalSealedFileV1[];
}

export type EvolutionEvalRemoteRequestV1 =
  | { readonly schema: "evolution-eval-preflight-request.v1"; readonly binding: CoreIssuedEvalBinding }
  | { readonly schema: "evolution-eval-query-request.v1"; readonly binding: CoreIssuedEvalBinding }
  | { readonly schema: "evolution-eval-reserve-request.v1"; readonly binding: CoreIssuedEvalBinding }
  | { readonly schema: "evolution-eval-submit-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly input: EvolutionEvalSealedInputV1 }
  | { readonly schema: "evolution-eval-cancel-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly reason: "tombstoned" | "deadline" | "shutdown" }
  | { readonly schema: "evolution-eval-spool-query.v1"; readonly binding: CoreIssuedEvalBinding }
  | { readonly schema: "evolution-eval-retention-query-request.v1"; readonly binding: CoreIssuedEvalBinding }
  | { readonly schema: "evolution-eval-evidence-manifest-request.v1"; readonly binding: CoreIssuedEvalBinding }
  | { readonly schema: "evolution-eval-evidence-entry-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly name: string }
  | { readonly schema: "evolution-eval-evidence-ack-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly connector_manifest_hash: string; readonly core_manifest_hash: string; readonly core_ack_fact_hash: string }
  | { readonly schema: "evolution-eval-evidence-corrupt-ack-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly error_fact_hash: string; readonly core_quarantine_fact_hash: string }
  | { readonly schema: "evolution-eval-evidence-cleanup-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly mode: "connector_authorized"; readonly connector_authorization_fact_hash: string; readonly core_cleanup_fact_hash: string }
  | { readonly schema: "evolution-eval-evidence-cleanup-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly mode: "core_discard"; readonly reason: "unavailable_at_deadline"; readonly core_conclusion_fact_hash: string; readonly core_cleanup_fact_hash: string; readonly discard_authorization_hash: string }
  | { readonly schema: "evolution-eval-evidence-cleanup-request.v1"; readonly binding: CoreIssuedEvalBinding; readonly mode: "core_discard"; readonly reason: "absolute_expiry"; readonly core_manifest_hash: string; readonly core_conclusion_fact_hash: string; readonly core_cleanup_fact_hash: string; readonly discard_authorization_hash: string };

export interface EvolutionEvalConnectorEvidenceEntryV1 {
  readonly name: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: "application/json" | "text/plain" | "application/octet-stream";
  readonly artifact_classification: "experimental/evolution_eval" | "evolution_eval_evidence";
  readonly usage_classification: "evolution_eval_only";
}

export interface EvolutionEvalConnectorEvidenceManifestV1 {
  readonly schema: "evolution-eval-connector-evidence-manifest.v1";
  readonly eval_job_id: string;
  readonly connector_job_id: string;
  readonly dispatch_request_hash: string;
  readonly entries: readonly EvolutionEvalConnectorEvidenceEntryV1[];
  readonly manifest_hash: string;
}

export interface EvolutionEvalConnectorEvidenceContentV1 {
  readonly schema: "evolution-eval-connector-evidence-entry.v1";
  readonly eval_job_id: string;
  readonly connector_job_id: string;
  readonly dispatch_request_hash: string;
  readonly name: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: "application/json" | "text/plain" | "application/octet-stream";
  readonly content_base64: string;
}

export interface EvolutionEvalRetentionResultV1 {
  readonly schema: "evolution-eval-retention-result.v1";
  readonly binding: CoreIssuedEvalBinding;
  readonly state: "absent" | "pending_ack" | "acknowledged" | "quarantined" | "discarded" | "cleaned" | "expired" | "transient_unavailable";
  readonly retryable: boolean;
  readonly authorization_kind: "ack" | "quarantine" | "expiry" | "discard" | "cleanup" | null;
  readonly authorization_hash: string | null;
  readonly connector_fact_hash: string | null;
  readonly source_authorization_kind: "ack" | "quarantine" | "expiry" | "discard" | null;
  readonly source_authorization_hash: string | null;
  readonly source_connector_fact_hash: string | null;
  readonly error_code: string | null;
  readonly physical_deleted: boolean;
}

export interface ValidatedEvolutionEvalSealedInput {
  readonly manifest: EvolutionEvalWorkspaceManifestV1;
  readonly files: readonly (Omit<EvolutionEvalSealedFileV1, "content_base64"> & { readonly content: Uint8Array })[];
  readonly projectionHash: string;
}

export interface EvolutionEvalPreflightResultV1 {
  readonly schema: "evolution-eval-preflight-result.v1";
  readonly eligible: boolean;
  readonly operation: EvolutionEvalOperation;
  readonly capability_version: string | null;
  readonly license_available: boolean;
  readonly active_config_sha256: string;
  readonly worker_process_instance_id: string;
  readonly vivado_toolchain_attestation_sha256: string;
  readonly live_mapping_health: "healthy";
  readonly unacked_spool_bytes: number;
  readonly hard_cap_bytes: typeof EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES;
  readonly error_code: string | null;
}

export interface EvolutionEvalSpoolResultV1 {
  readonly schema: "evolution-eval-spool-result.v1";
  readonly binding: CoreIssuedEvalBinding;
  readonly unacked_bytes: number;
  readonly hard_cap_bytes: typeof EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES;
}

interface EvalLedgerQueryBase {
  readonly schema: typeof EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly ledger_epoch: string;
}

export interface EvalLedgerNeverAccepted extends EvalLedgerQueryBase {
  readonly state: "proven_never_accepted";
  readonly replay_permitted: boolean;
}

export interface EvalLedgerAccepted extends EvalLedgerQueryBase {
  readonly state: "accepted";
  readonly execution_state: EvolutionEvalExecutionState;
  readonly accepted_at: string;
}

export interface EvalLedgerTerminal extends EvalLedgerQueryBase {
  readonly state: "terminal";
  readonly terminal_state: EvolutionEvalTerminalState;
  readonly process_stopped: true;
  readonly terminal_at: string;
  readonly error_code: string | null;
}

export interface EvalLedgerTransientUnavailable extends EvalLedgerQueryBase {
  readonly state: "transient_unavailable";
  readonly retryable: true;
  readonly error_code: string;
}

export interface EvalLedgerAmbiguous extends EvalLedgerQueryBase {
  readonly state: "ambiguous";
  readonly effect_possible: true;
  readonly error_code: string;
}

export interface EvalLedgerCorrupt extends EvalLedgerQueryBase {
  readonly state: "ledger_corrupt";
  readonly replay_permitted: false;
  readonly error_code: string;
}

export type EvalLedgerQuery =
  | EvalLedgerNeverAccepted
  | EvalLedgerAccepted
  | EvalLedgerTerminal
  | EvalLedgerTransientUnavailable
  | EvalLedgerAmbiguous
  | EvalLedgerCorrupt;

export interface EvolutionEvalDiscoveryCapability {
  readonly operation: string;
  readonly version: string;
  readonly runClasses: readonly string[];
}

export interface EvolutionEvalDiscoveryPolicyResult {
  readonly eligible: boolean;
  readonly capabilities: Readonly<Partial<Record<EvolutionEvalOperation, EvolutionEvalDiscoveryCapability>>>;
  readonly missing_operations: readonly EvolutionEvalOperation[];
  readonly forbidden_operations: readonly string[];
  readonly version_mismatches: readonly EvolutionEvalOperation[];
}

export class EvolutionEvalProtocolError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "EvolutionEvalProtocolError";
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HDL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;
const PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEDGER_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${label} must be a plain object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail(`${label} contains unsupported fields`);
  const actual = (ownKeys as string[]).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    fail(`${label} has a non-canonical shape`);
  }
}

function fail(message: string, code = "EVOLUTION_EVAL_INVALID_REQUEST"): never {
  throw new EvolutionEvalProtocolError(code, message);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function requireEvolutionEvalNfc(value: string, label = "string"): string {
  if (hasLoneSurrogate(value) || value.normalize("NFC") !== value) fail(`${label} must be valid NFC`);
  return value;
}

function requiredString(value: unknown, label: string, maxBytes = 128): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  requireEvolutionEvalNfc(value, label);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} is not a canonical opaque identifier`);
  }
  return value;
}

function hashString(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be an absolute timestamp`);
  requireEvolutionEvalNfc(value, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || !value.endsWith("Z")) fail(`${label} must be an absolute UTC timestamp`);
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail(`${label} is outside its frozen range`);
  }
  return Number(value);
}

function portablePath(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a path`);
  requireEvolutionEvalNfc(value, label);
  if (!/^[\x00-\x7f]+$/u.test(value) || Buffer.byteLength(value, "utf8") > 512) {
    fail(`${label} is not a portable path`);
  }
  const segments = value.split("/");
  const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
  if (segments.length < 1 || segments.length > 32 || segments.some((segment) => (
    !PATH_SEGMENT_PATTERN.test(segment)
    || /[ .]$/u.test(segment)
    || reservedWindowsName.test(segment)
  ))) {
    fail(`${label} is not a portable path`);
  }
  return value;
}

function portableKey(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function strictBase64(value: unknown, label: string, expectedBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const maximumEncoded = Math.ceil(expectedBytes / 3) * 4;
  if (value.length > maximumEncoded) fail(`${label} exceeds its declared size`, "EVOLUTION_EVAL_RESOURCE_LIMIT");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedBytes || bytes.toString("base64") !== value) fail(`${label} size or encoding differs`);
  return bytes;
}

function extensionMedia(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".v") || lower.endsWith(".vh")) return "text/x-verilog";
  if (lower.endsWith(".sv") || lower.endsWith(".svh")) return "text/x-systemverilog";
  if (lower.endsWith(".xdc")) return "application/x-xdc";
  return undefined;
}

function nonnegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail(`${label} is outside its frozen range`, "EVOLUTION_EVAL_RESOURCE_LIMIT");
  }
  return Number(value);
}

function pathArray(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} has an invalid number of paths`);
  }
  const paths = value.map((item, index) => portablePath(item, `${label}[${index}]`));
  if (new Set(paths.map(portableKey)).size !== paths.length) fail(`${label} contains a portable collision`);
  return paths;
}

function validateParameters(operation: EvolutionEvalOperation, value: unknown): EvolutionEvalParametersV1 {
  const parameters = record(value, "parameters");
  const keys: Readonly<Record<EvolutionEvalOperation, readonly string[]>> = {
    validate_sources: ["operation", "source_paths", "top"],
    simulate: ["operation", "source_paths", "testbench", "top"],
    synthesize: ["operation", "part", "source_paths", "top"],
    implement: ["constraint_paths", "generate_trial_bitstream", "operation", "part", "source_paths", "top"],
  };
  exactKeys(parameters, keys[operation], "parameters");
  if (parameters.operation !== operation) fail("operation and parameters.operation differ");
  const sourcePaths = pathArray(parameters.source_paths, "source_paths", 1, 512);
  for (const path of sourcePaths) {
    if (!/\.(?:v|vh|sv|svh)$/iu.test(path)) fail("source_paths contains a forbidden extension");
  }
  if (operation === "validate_sources") {
    if (parameters.top !== null && (typeof parameters.top !== "string" || !HDL_IDENTIFIER_PATTERN.test(parameters.top))) {
      fail("top is not a valid HDL identifier");
    }
  } else if (typeof parameters.top !== "string" || !HDL_IDENTIFIER_PATTERN.test(parameters.top)) {
    fail("top is not a valid HDL identifier");
  }
  if (operation === "simulate" && (
    typeof parameters.testbench !== "string"
    || !HDL_IDENTIFIER_PATTERN.test(parameters.testbench)
  )) fail("testbench is not a valid HDL identifier");
  if (operation === "synthesize" || operation === "implement") {
    if (typeof parameters.part !== "string" || !PART_PATTERN.test(parameters.part)) fail("part is invalid");
  }
  if (operation === "implement") {
    const constraints = pathArray(parameters.constraint_paths, "constraint_paths", 0, 128);
    if (constraints.some((path) => !/\.xdc$/iu.test(path))) fail("constraint_paths must contain only XDC files");
    if (parameters.generate_trial_bitstream !== true && parameters.generate_trial_bitstream !== false) {
      fail("generate_trial_bitstream must be boolean");
    }
  }
  return structuredClone(parameters) as unknown as EvolutionEvalParametersV1;
}

/** RFC 8785 JSON canonicalization over the strict JSON domain used by Core. */
export function canonicalEvolutionEvalJson(value: unknown): string {
  const encode = (item: unknown, label: string): string => {
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "string") return JSON.stringify(requireEvolutionEvalNfc(item, label));
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail(`${label} is not a finite JSON number`);
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      const encoded: string[] = [];
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item)) fail(`${label} contains an array hole`);
        encoded.push(encode(item[index], `${label}[${index}]`));
      }
      return `[${encoded.join(",")}]`;
    }
    const object = record(item, label);
    const keys = Object.keys(object);
    if (Reflect.ownKeys(object).length !== keys.length) fail(`${label} contains unsupported keys`);
    for (const key of keys) requireEvolutionEvalNfc(key, `${label} key`);
    keys.sort();
    return `{${keys.map((key) => {
      const member = object[key];
      if (member === undefined || typeof member === "function" || typeof member === "symbol" || typeof member === "bigint") {
        fail(`${label}.${key} is not JSON`);
      }
      return `${JSON.stringify(key)}:${encode(member, `${label}.${key}`)}`;
    }).join(",")}}`;
  };
  return encode(value, "$input");
}

export function canonicalEvolutionEvalHash(value: unknown): string {
  return sha256(canonicalEvolutionEvalJson(value));
}

export function computeEvolutionEvalDispatchRequestHash(dispatch: EvolutionEvalDispatchRequestV1): string {
  return canonicalEvolutionEvalHash(dispatch);
}

export function validateCoreIssuedEvalBinding(
  value: unknown,
  expectedProjectId?: string,
): CoreIssuedEvalBinding {
  const binding = record(value, "binding");
  exactKeys(binding, ["dispatch", "dispatch_request_hash", "project_id"], "binding");
  const projectId = requiredString(binding.project_id, "project_id");
  if (expectedProjectId !== undefined && projectId !== requiredString(expectedProjectId, "expected project_id")) {
    fail("binding project_id differs from the remote envelope", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  const requestHash = hashString(binding.dispatch_request_hash, "dispatch_request_hash");
  const dispatch = record(binding.dispatch, "dispatch");
  exactKeys(dispatch, [
    "connector_idempotency_key",
    "connector_job_id",
    "deadline_at",
    "eval_input_ref",
    "eval_job_id",
    "input_manifest_hash",
    "operation",
    "operation_cap_ms",
    "parameters",
    "part",
    "requested_timeout_ms",
    "run_class",
    "schema",
    "sealed_input_projection_hash",
    "toolchain_profile_hash",
    "workspace_id",
    "workspace_manifest_hash",
    "workspace_revision",
  ], "dispatch");
  if (dispatch.schema !== EVOLUTION_EVAL_DISPATCH_SCHEMA || dispatch.run_class !== EVOLUTION_EVAL_RUN_CLASS) {
    fail("dispatch schema or run_class is invalid", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (!EVOLUTION_EVAL_OPERATIONS.includes(dispatch.operation as EvolutionEvalOperation)) {
    fail("dispatch operation is forbidden", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
  }
  const operation = dispatch.operation as EvolutionEvalOperation;
  const canonicalDispatch: EvolutionEvalDispatchRequestV1 = {
    schema: EVOLUTION_EVAL_DISPATCH_SCHEMA,
    eval_job_id: requiredString(dispatch.eval_job_id, "eval_job_id"),
    connector_job_id: requiredString(dispatch.connector_job_id, "connector_job_id"),
    connector_idempotency_key: hashString(dispatch.connector_idempotency_key, "connector_idempotency_key"),
    eval_input_ref: requiredString(dispatch.eval_input_ref, "eval_input_ref"),
    input_manifest_hash: hashString(dispatch.input_manifest_hash, "input_manifest_hash"),
    workspace_id: requiredString(dispatch.workspace_id, "workspace_id"),
    workspace_revision: positiveInteger(dispatch.workspace_revision, "workspace_revision", Number.MAX_SAFE_INTEGER),
    workspace_manifest_hash: hashString(dispatch.workspace_manifest_hash, "workspace_manifest_hash"),
    sealed_input_projection_hash: hashString(dispatch.sealed_input_projection_hash, "sealed_input_projection_hash"),
    operation,
    parameters: validateParameters(operation, dispatch.parameters),
    part: dispatch.part === null ? null : requiredString(dispatch.part, "part"),
    toolchain_profile_hash: hashString(dispatch.toolchain_profile_hash, "toolchain_profile_hash"),
    requested_timeout_ms: positiveInteger(dispatch.requested_timeout_ms, "requested_timeout_ms", EVOLUTION_EVAL_OPERATION_CAP_MS),
    operation_cap_ms: positiveInteger(dispatch.operation_cap_ms, "operation_cap_ms", EVOLUTION_EVAL_OPERATION_CAP_MS) as typeof EVOLUTION_EVAL_OPERATION_CAP_MS,
    deadline_at: timestamp(dispatch.deadline_at, "deadline_at"),
    run_class: EVOLUTION_EVAL_RUN_CLASS,
  };
  if (canonicalDispatch.operation_cap_ms !== EVOLUTION_EVAL_OPERATION_CAP_MS) {
    fail("operation_cap_ms differs from the frozen policy", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (canonicalDispatch.part !== null && !PART_PATTERN.test(canonicalDispatch.part)) {
    fail("dispatch part is invalid", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if ((canonicalDispatch.parameters.operation === "synthesize" || canonicalDispatch.parameters.operation === "implement")
    && canonicalDispatch.part !== canonicalDispatch.parameters.part) {
    fail("dispatch part differs from typed parameters", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (computeEvolutionEvalDispatchRequestHash(canonicalDispatch) !== requestHash) {
    fail("dispatch_request_hash does not bind the canonical dispatch", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  return structuredClone({ project_id: projectId, dispatch_request_hash: requestHash, dispatch: canonicalDispatch });
}

export function evolutionEvalBindingFingerprint(binding: CoreIssuedEvalBinding): string {
  return canonicalEvolutionEvalHash(validateCoreIssuedEvalBinding(binding));
}

function baseQuery(value: Record<string, unknown>, expected: CoreIssuedEvalBinding, expectedEpoch?: string): {
  connector_job_id: string;
  connector_idempotency_key: string;
  dispatch_request_hash: string;
  ledger_epoch: string;
} {
  if (value.schema !== EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA) fail("ledger query schema is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
  const connectorJobId = requiredString(value.connector_job_id, "connector_job_id");
  const connectorKey = hashString(value.connector_idempotency_key, "connector_idempotency_key");
  const dispatchHash = hashString(value.dispatch_request_hash, "dispatch_request_hash");
  const epoch = requiredString(value.ledger_epoch, "ledger_epoch");
  if (!LEDGER_EPOCH_PATTERN.test(epoch)) fail("ledger_epoch is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
  if (
    connectorJobId !== expected.dispatch.connector_job_id
    || connectorKey !== expected.dispatch.connector_idempotency_key
    || dispatchHash !== expected.dispatch_request_hash
    || (expectedEpoch !== undefined && epoch !== expectedEpoch)
  ) fail("ledger observation binding differs", "EVOLUTION_EVAL_BINDING_CONFLICT");
  return {
    connector_job_id: connectorJobId,
    connector_idempotency_key: connectorKey,
    dispatch_request_hash: dispatchHash,
    ledger_epoch: epoch,
  };
}

export function validateEvalLedgerQuery(
  input: unknown,
  expectedBinding: CoreIssuedEvalBinding,
  expectedEpoch?: string,
): EvalLedgerQuery {
  const expected = validateCoreIssuedEvalBinding(expectedBinding);
  const value = record(input, "ledger query");
  const common = [
    "connector_idempotency_key",
    "connector_job_id",
    "dispatch_request_hash",
    "ledger_epoch",
    "schema",
    "state",
  ];
  const base = baseQuery(value, expected, expectedEpoch);
  if (typeof value.state !== "string") fail("ledger state is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
  if (value.state === "proven_never_accepted") {
    exactKeys(value, [...common, "replay_permitted"], "ledger query");
    if (typeof value.replay_permitted !== "boolean") fail("replay_permitted is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, replay_permitted: value.replay_permitted };
  }
  if (value.state === "accepted") {
    exactKeys(value, [...common, "accepted_at", "execution_state"], "ledger query");
    if (!(["queued", "preparing", "running"] as const).includes(value.execution_state as EvolutionEvalExecutionState)) {
      fail("execution_state is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return {
      schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
      ...base,
      state: value.state,
      execution_state: value.execution_state as EvolutionEvalExecutionState,
      accepted_at: timestamp(value.accepted_at, "accepted_at"),
    };
  }
  if (value.state === "terminal") {
    exactKeys(value, [...common, "error_code", "process_stopped", "terminal_at", "terminal_state"], "ledger query");
    if (!(["succeeded", "failed", "cancelled", "timeout"] as const).includes(value.terminal_state as EvolutionEvalTerminalState)) {
      fail("terminal_state is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    if (value.process_stopped !== true) fail("terminal must prove process_stopped", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    if (value.error_code !== null && (typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code))) {
      fail("terminal error_code is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return {
      schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
      ...base,
      state: value.state,
      terminal_state: value.terminal_state as EvolutionEvalTerminalState,
      process_stopped: true,
      terminal_at: timestamp(value.terminal_at, "terminal_at"),
      error_code: value.error_code as string | null,
    };
  }
  if (value.state === "transient_unavailable") {
    exactKeys(value, [...common, "error_code", "retryable"], "ledger query");
    if (value.retryable !== true || typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code)) {
      fail("transient observation is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, retryable: true, error_code: value.error_code };
  }
  if (value.state === "ambiguous") {
    exactKeys(value, [...common, "effect_possible", "error_code"], "ledger query");
    if (value.effect_possible !== true || typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code)) {
      fail("ambiguous observation is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, effect_possible: true, error_code: value.error_code };
  }
  if (value.state === "ledger_corrupt") {
    exactKeys(value, [...common, "error_code", "replay_permitted"], "ledger query");
    if (value.replay_permitted !== false || typeof value.error_code !== "string" || !ERROR_CODE_PATTERN.test(value.error_code)) {
      fail("corrupt observation is invalid", "EVOLUTION_EVAL_LEDGER_CORRUPT");
    }
    return { schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA, ...base, state: value.state, replay_permitted: false, error_code: value.error_code };
  }
  fail("ledger taxonomy is not one of the six frozen states", "EVOLUTION_EVAL_LEDGER_CORRUPT");
}

export function evaluateEvolutionEvalDiscoveryPolicy(
  capabilities: readonly EvolutionEvalDiscoveryCapability[],
  expectedVersion?: string,
): EvolutionEvalDiscoveryPolicyResult {
  if (!Array.isArray(capabilities)) fail("capabilities must be an array", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
  const selected: Partial<Record<EvolutionEvalOperation, EvolutionEvalDiscoveryCapability>> = {};
  const forbidden = new Set<string>();
  const mismatches = new Set<EvolutionEvalOperation>();
  const seenOperations = new Set<string>();
  const knownRunClasses = new Set(["exploratory", "gate_check", "formal", EVOLUTION_EVAL_RUN_CLASS]);
  for (const input of capabilities) {
    const capability = record(input, "capability");
    exactKeys(capability, ["operation", "runClasses", "version"], "capability");
    const operation = requiredString(capability.operation, "capability.operation");
    const version = requiredString(capability.version, "capability.version");
    if (!Array.isArray(capability.runClasses) || capability.runClasses.length === 0) {
      fail("capability.runClasses is invalid", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    const runClasses = capability.runClasses.map((runClass, index) => requiredString(runClass, `runClasses[${index}]`));
    if (new Set(runClasses).size !== runClasses.length || runClasses.some((runClass) => !knownRunClasses.has(runClass))) {
      fail("capability.runClasses contains duplicates", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE");
    }
    if (seenOperations.has(operation)) forbidden.add(operation);
    seenOperations.add(operation);
    const evo = runClasses.includes(EVOLUTION_EVAL_RUN_CLASS);
    if (!EVOLUTION_EVAL_OPERATIONS.includes(operation as EvolutionEvalOperation)) {
      if (evo) forbidden.add(operation);
      continue;
    }
    const typedOperation = operation as EvolutionEvalOperation;
    if (evo) {
      selected[typedOperation] = { operation, version, runClasses: [...runClasses] };
      if (expectedVersion !== undefined && version !== expectedVersion) mismatches.add(typedOperation);
    }
  }
  const missing = EVOLUTION_EVAL_OPERATIONS.filter((operation) => selected[operation] === undefined);
  return Object.freeze({
    eligible: missing.length === 0 && forbidden.size === 0 && mismatches.size === 0,
    capabilities: Object.freeze(structuredClone(selected)),
    missing_operations: Object.freeze(missing),
    forbidden_operations: Object.freeze([...forbidden].sort()),
    version_mismatches: Object.freeze(EVOLUTION_EVAL_OPERATIONS.filter((operation) => mismatches.has(operation))),
  });
}

/**
 * Validates the complete sealed workspace before the Worker creates any file.
 * The returned bytes are detached from the caller and are the only bytes an
 * evolution-eval executor may materialize.
 */
export function validateEvolutionEvalSealedInput(
  input: unknown,
  bindingInput: CoreIssuedEvalBinding,
): ValidatedEvolutionEvalSealedInput {
  const binding = validateCoreIssuedEvalBinding(bindingInput);
  const value = record(input, "sealed input");
  exactKeys(value, ["files", "manifest", "schema"], "sealed input");
  if (value.schema !== "evolution-eval-sealed-input.v1") fail("sealed input schema is invalid");
  const manifestValue = record(value.manifest, "workspace manifest");
  exactKeys(manifestValue, ["files", "revision", "schema", "workspace_id"], "workspace manifest");
  if (manifestValue.schema !== "evolution-eval-workspace-manifest.v1") fail("workspace manifest schema is invalid");
  const workspaceId = requiredString(manifestValue.workspace_id, "workspace_id");
  const revision = positiveInteger(manifestValue.revision, "workspace revision", Number.MAX_SAFE_INTEGER);
  if (workspaceId !== binding.dispatch.workspace_id || revision !== binding.dispatch.workspace_revision) {
    fail("workspace identity differs from dispatch", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  if (!Array.isArray(manifestValue.files) || !Array.isArray(value.files)
    || manifestValue.files.length > EVOLUTION_EVAL_LIMITS.workspace.files) {
    fail("workspace file cardinality differs or exceeds its cap", "EVOLUTION_EVAL_RESOURCE_LIMIT");
  }
  const layerCounts = { source: 0, skill: 0, overlay: 0 };
  const layerBytes = { source: 0, skill: 0, overlay: 0 };
  let workspaceBytes = 0;
  const manifestFiles: EvolutionEvalWorkspaceManifestFileV1[] = [];
  const seen = new Set<string>();
  let previousKey: string | undefined;
  for (let index = 0; index < manifestValue.files.length; index += 1) {
    const file = record(manifestValue.files[index], `manifest.files[${index}]`);
    exactKeys(file, ["layer", "media_type", "path", "read_only", "sha256", "size_bytes"], `manifest.files[${index}]`);
    const path = portablePath(file.path, `manifest.files[${index}].path`);
    const key = portableKey(path);
    if (seen.has(key) || (previousKey !== undefined && previousKey >= key)) fail("manifest paths are not uniquely sorted");
    seen.add(key);
    previousKey = key;
    if (!(file.layer === "source" || file.layer === "overlay")) {
      fail("remote manifest may contain only source/overlay files", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const layer = file.layer;
    if (file.read_only !== (layer !== "overlay")) fail("file read_only differs from its layer");
    if (typeof file.media_type !== "string" || file.media_type.length < 1 || file.media_type.length > 128) fail("file media_type is invalid");
    const size = nonnegativeInteger(file.size_bytes, "file size", EVOLUTION_EVAL_LIMITS[layer].fileBytes);
    layerCounts[layer] += 1;
    layerBytes[layer] += size;
    workspaceBytes += size;
    if (layerCounts[layer] > EVOLUTION_EVAL_LIMITS[layer].files || layerBytes[layer] > EVOLUTION_EVAL_LIMITS[layer].bytes
      || workspaceBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes) {
      fail("workspace exceeds a frozen resource budget", "EVOLUTION_EVAL_RESOURCE_LIMIT");
    }
    if (layer === "overlay" && /\.(?:tcl|py|ts|sh|bat|cmd|ps1)$/iu.test(path)) {
      fail("overlay executable assets are forbidden", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    manifestFiles.push({
      path,
      sha256: hashString(file.sha256, `manifest.files[${index}].sha256`),
      size_bytes: size,
      media_type: file.media_type,
      layer,
      read_only: file.read_only,
    });
  }
  const canonicalManifest: EvolutionEvalWorkspaceManifestV1 = {
    schema: "evolution-eval-workspace-manifest.v1",
    workspace_id: workspaceId,
    revision,
    files: manifestFiles,
  };
  const transportedManifestFiles = manifestFiles;
  if (value.files.length !== transportedManifestFiles.length) {
    fail("sealed bytes must be the exact source/overlay projection", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  const decoded: ValidatedEvolutionEvalSealedInput["files"][number][] = [];
  for (let index = 0; index < value.files.length; index += 1) {
    const file = record(value.files[index], `sealed files[${index}]`);
    exactKeys(file, ["content_base64", "media_type", "path", "sha256", "size_bytes"], `sealed files[${index}]`);
    const manifestFile = transportedManifestFiles[index]!;
    const path = portablePath(file.path, `sealed files[${index}].path`);
    const digest = hashString(file.sha256, `sealed files[${index}].sha256`);
    const size = nonnegativeInteger(file.size_bytes, `sealed files[${index}].size_bytes`, manifestFile.size_bytes);
    if (path !== manifestFile.path || digest !== manifestFile.sha256 || size !== manifestFile.size_bytes
      || file.media_type !== manifestFile.media_type) fail("sealed file differs from manifest", "EVOLUTION_EVAL_BINDING_CONFLICT");
    const content = strictBase64(file.content_base64, `sealed files[${index}].content_base64`, size);
    if (sha256(content) !== digest) fail("sealed file content hash differs", "EVOLUTION_EVAL_BINDING_CONFLICT");
    decoded.push({ path, sha256: digest, size_bytes: size, media_type: manifestFile.media_type, content });
  }
  const parameterPaths = [
    ...binding.dispatch.parameters.source_paths,
    ...(binding.dispatch.parameters.operation === "implement" ? binding.dispatch.parameters.constraint_paths : []),
  ];
  for (const path of parameterPaths) {
    const file = manifestFiles.find((candidate) => portableKey(candidate.path) === portableKey(path));
    if (!file || file.layer === "skill") fail("Vivado input is absent or belongs to the Skill layer", "EVOLUTION_EVAL_BINDING_CONFLICT");
    const expectedMedia = extensionMedia(path);
    if (!expectedMedia || expectedMedia !== file.media_type) fail("Vivado input media type differs from its extension");
    let text: string;
    const transported = decoded.find((candidate) => portableKey(candidate.path) === portableKey(path));
    if (!transported) fail("Vivado input bytes are absent", "EVOLUTION_EVAL_BINDING_CONFLICT");
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(transported.content); }
    catch { fail("Vivado input is not valid UTF-8"); }
    if (!path.toLowerCase().endsWith(".xdc") && (
      /\$(?:system|fopen|fclose|readmemh|readmemb|writememh|writememb)\b/iu.test(text)
      || /\bimport\s*"DPI(?:-C)?"/iu.test(text)
      || /`include\s*["<](?:\/|\\|\.\.)/u.test(text)
    )) fail("Vivado source contains a process or filesystem escape", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
  }
  const projectionHash = canonicalEvolutionEvalHash({
    schema: "evolution-eval-sealed-input-projection.v1",
    manifest: canonicalManifest,
    files: decoded.map(({ path, sha256, size_bytes, media_type }) => ({
      path,
      sha256,
      size_bytes,
      media_type,
    })),
  });
  if (projectionHash !== binding.dispatch.sealed_input_projection_hash) {
    fail("sealed input projection differs from dispatch", "EVOLUTION_EVAL_BINDING_CONFLICT");
  }
  return { manifest: canonicalManifest, files: decoded, projectionHash };
}

export function effectiveEvolutionEvalTimeoutMs(
  bindingInput: CoreIssuedEvalBinding,
  now: Date = new Date(),
): number {
  const binding = validateCoreIssuedEvalBinding(bindingInput);
  const remaining = Date.parse(binding.dispatch.deadline_at) - now.getTime();
  const effective = Math.min(
    binding.dispatch.requested_timeout_ms,
    EVOLUTION_EVAL_OPERATION_CAP_MS,
    remaining,
  );
  if (!Number.isSafeInteger(effective) || effective < 1) {
    fail("the absolute deadline has elapsed", "EVOLUTION_EVAL_TIMEOUT_INVALID");
  }
  return effective;
}

export function evolutionEvalDiscardAuthorizationHash(
  bindingInput: CoreIssuedEvalBinding,
  input: { readonly reason: "unavailable_at_deadline" }
    | { readonly reason: "absolute_expiry"; readonly connectorManifestHash: string; readonly terminalAt: string },
): string {
  const binding = validateCoreIssuedEvalBinding(bindingInput);
  const common = {
    schema: "evolution-eval-evidence-discard-authorization.v1" as const,
    project_id: binding.project_id,
    eval_job_id: binding.dispatch.eval_job_id,
    connector_job_id: binding.dispatch.connector_job_id,
    dispatch_request_hash: binding.dispatch_request_hash,
    reason: input.reason,
  };
  return canonicalEvolutionEvalHash(input.reason === "unavailable_at_deadline"
    ? { ...common, deadline_at: binding.dispatch.deadline_at }
    : {
        ...common,
        connector_manifest_hash: input.connectorManifestHash,
        terminal_at: input.terminalAt,
      });
}

export function validateEvolutionEvalRemoteRequest(
  input: unknown,
  expectedProjectId: string,
): EvolutionEvalRemoteRequestV1 {
  const value = record(input, "evolution-eval request");
  if (typeof value.schema !== "string") fail("request schema is missing");
  const bindingOnly = [
    "evolution-eval-preflight-request.v1",
    "evolution-eval-query-request.v1",
    "evolution-eval-reserve-request.v1",
    "evolution-eval-spool-query.v1",
    "evolution-eval-retention-query-request.v1",
    "evolution-eval-evidence-manifest-request.v1",
  ];
  if (bindingOnly.includes(value.schema)) {
    exactKeys(value, ["binding", "schema"], "evolution-eval request");
    return { schema: value.schema, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) } as EvolutionEvalRemoteRequestV1;
  }
  if (value.schema === "evolution-eval-evidence-entry-request.v1") {
    exactKeys(value, ["binding", "name", "schema"], "evolution-eval request");
    if (typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value.name)) fail("evidence name is invalid");
    return { schema: value.schema, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId), name: value.name };
  }
  if (value.schema === "evolution-eval-evidence-ack-request.v1") {
    exactKeys(value, ["binding", "connector_manifest_hash", "core_ack_fact_hash", "core_manifest_hash", "schema"], "evolution-eval request");
    for (const field of ["connector_manifest_hash", "core_manifest_hash", "core_ack_fact_hash"] as const) {
      if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field] as string)) fail("retention fact hash is invalid");
    }
    return structuredClone({ ...value, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) }) as EvolutionEvalRemoteRequestV1;
  }
  if (value.schema === "evolution-eval-evidence-corrupt-ack-request.v1") {
    exactKeys(value, ["binding", "core_quarantine_fact_hash", "error_fact_hash", "schema"], "evolution-eval request");
    for (const field of ["error_fact_hash", "core_quarantine_fact_hash"] as const) {
      if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field] as string)) fail("retention fact hash is invalid");
    }
    return structuredClone({ ...value, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) }) as EvolutionEvalRemoteRequestV1;
  }
  if (value.schema === "evolution-eval-evidence-cleanup-request.v1") {
    if (value.mode === "connector_authorized") {
      exactKeys(value, ["binding", "connector_authorization_fact_hash", "core_cleanup_fact_hash", "mode", "schema"], "evolution-eval request");
      for (const field of ["connector_authorization_fact_hash", "core_cleanup_fact_hash"] as const) {
        if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field] as string)) fail("retention fact hash is invalid");
      }
    } else if (value.mode === "core_discard") {
      if (value.reason === "unavailable_at_deadline") {
        exactKeys(value, ["binding", "core_cleanup_fact_hash", "core_conclusion_fact_hash", "discard_authorization_hash", "mode", "reason", "schema"], "evolution-eval request");
      } else if (value.reason === "absolute_expiry") {
        exactKeys(value, ["binding", "core_cleanup_fact_hash", "core_conclusion_fact_hash", "core_manifest_hash", "discard_authorization_hash", "mode", "reason", "schema"], "evolution-eval request");
        if (typeof value.core_manifest_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.core_manifest_hash)) fail("retention fact hash is invalid");
      } else fail("discard reason is invalid");
      for (const field of ["core_conclusion_fact_hash", "core_cleanup_fact_hash", "discard_authorization_hash"] as const) {
        if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field] as string)) fail("retention fact hash is invalid");
      }
    } else fail("cleanup mode is invalid");
    return structuredClone({ ...value, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId) }) as EvolutionEvalRemoteRequestV1;
  }
  if (value.schema === "evolution-eval-cancel-request.v1") {
    exactKeys(value, ["binding", "reason", "schema"], "evolution-eval request");
    if (!(value.reason === "tombstoned" || value.reason === "deadline" || value.reason === "shutdown")) fail("cancel reason is invalid");
    return { schema: value.schema, binding: validateCoreIssuedEvalBinding(value.binding, expectedProjectId), reason: value.reason };
  }
  if (value.schema === "evolution-eval-submit-request.v1") {
    exactKeys(value, ["binding", "input", "schema"], "evolution-eval request");
    const binding = validateCoreIssuedEvalBinding(value.binding, expectedProjectId);
    validateEvolutionEvalSealedInput(value.input, binding);
    return structuredClone({ schema: value.schema, binding, input: value.input }) as EvolutionEvalRemoteRequestV1;
  }
  fail("request schema is forbidden", "EVOLUTION_EVAL_OPERATION_FORBIDDEN");
}
