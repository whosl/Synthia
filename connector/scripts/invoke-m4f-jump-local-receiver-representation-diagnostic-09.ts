import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  runCeremony,
} from "./m4f-bound-jump-transport.ts";
import {
  invokeBoundJumpPhase09,
  redactSuccessfulPhase09,
  type BoundJumpFailureDetail09,
  type BoundJumpTransport09Dependencies,
} from "./m4f-bound-jump-transport-09.ts";

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_09";
const PHASE = "jump-local-receiver-representation-09:diagnose";
const JUMP_COMPUTER = "DESKTOP-E380LR7";
const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const MAX_COMMAND_BYTES = 8_192;
const COMMAND_PINS = {
  basename_exact: [3_346, "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2"],
  fixed_exact: [3_389, "a0d79d8992e881d114cd4f70e6b916978e372160fb06e3a2bd781bdeb20d074f"],
  quoted_exact: [3_391, "21521202d8b45084d75ec2d797b1214e41da760efcbe93e340b68ca2fb3fd251"],
} as const;
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK_SHA256 = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";

export const RECEIVER_REPRESENTATION_ARTIFACT_09 = readFileSync(
  new URL("./m4f-jump-local-receiver-representation-diagnostic-09.ps1", import.meta.url),
  "utf8",
);
export const RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH = Buffer.byteLength(RECEIVER_REPRESENTATION_ARTIFACT_09, "utf8");
export const RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256 = createHash("sha256").update(RECEIVER_REPRESENTATION_ARTIFACT_09).digest("hex");
const EXPECTED_ARTIFACT_LENGTH = 10_222;
const EXPECTED_ARTIFACT_SHA256 = "76633aaa8a00850501a92d92696b301bd6631d245777c58d943489dce4adfef9";
if (RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH !== EXPECTED_ARTIFACT_LENGTH
  || RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256 !== EXPECTED_ARTIFACT_SHA256) {
  throw new Error("M4F_RECEIVER_REPRESENTATION_09_ARTIFACT_DRIFT");
}

export function assertReceiverRepresentationArtifact09Frozen(length = RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH, sha = RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256): void {
  if (length !== EXPECTED_ARTIFACT_LENGTH || sha !== EXPECTED_ARTIFACT_SHA256) throw new Error("M4F_RECEIVER_REPRESENTATION_09_ARTIFACT_DRIFT");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) return null;
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function invalidPayload(): never { throw new Error("receiver representation payload invalid"); }
function diagnosticFailure(code: string, stage: "confirmation" | "transport" | "validation", transportFailure: BoundJumpFailureDetail09 | null, redactedObservation: unknown): never {
  throw new CeremonyFailure({
    schema: "synthia-m4f-receiver-representation-failure-09.v1",
    code,
    phase: PHASE,
    current_stage: stage,
    predecessor_effect_state: "unknown",
    retry_permitted: false,
    transport_failure: transportFailure,
    redacted_observation: redactedObservation,
  });
}

const EXEC = ["ordinal_exact", "case_only", "different"] as const;
const CAND = ["basename_exact", "fixed_exact", "quoted_exact", "none"] as const;
const MARK = ["exact", "case_only", "missing", "multiple"] as const;
const PREFIX = ["basename_exact", "basename_case_only", "fixed_exact", "fixed_case_only", "quoted_exact", "quoted_case_only", "separator_drift", "other"] as const;
const TOKEN = ["missing", "non_ascii", "whitespace", "invalid_base64", "base64_shape"] as const;
const STAGE = ["executable", "marker", "prefix", "token_shape", "encoded_length", "encoded_hash", "canonical_base64", "utf16le_roundtrip", "none"] as const;

function validatePayload09(payload: Record<string, unknown>): Record<string, unknown> {
  if (record(payload) !== payload) invalidPayload();
  if (!exactKeys(payload, ["actual", "classification", "expected", "failure_code", "predecessor_attempt", "provider_activation_may_create_processes", "query", "residue_state_evaluated", "schema", "scope", "status"])) throw new Error("payload keys");
  const predecessor = record(payload.predecessor_attempt);
  if (!predecessor || !exactKeys(predecessor, ["attempt", "cleanup_attempted", "effect_state", "queried", "schema"])
    || predecessor.schema !== "synthia-m4f-predecessor-effect-09.v1" || predecessor.attempt !== "_08"
    || predecessor.effect_state !== "unknown" || predecessor.queried !== false || predecessor.cleanup_attempted !== false) throw new Error("predecessor invalid");
  if (payload.schema !== "synthia-m4f-current-receiver-representation-diagnostic-09.v1"
    || !["representation_match", "representation_mismatch", "indeterminate"].includes(payload.status as string)
    || payload.scope !== "current_pid_exact_cim_only" || payload.residue_state_evaluated !== false
    || payload.provider_activation_may_create_processes !== true
    || (payload.failure_code !== null && !["query_failed", "cardinality", "pid_binding", "missing_property", "unsafe_executable", "missing_command", "command_bound"].includes(payload.failure_code as string))) invalidPayload();
  const query = record(payload.query);
  if (!query || !exactKeys(query, ["elapsed_ticks", "returned_count", "schema", "stopwatch_frequency"])
    || query.schema !== "synthia-m4f-receiver-representation-query.v1" || !integer(query.returned_count, 0, 2)
    || !integer(query.elapsed_ticks, 0, Number.MAX_SAFE_INTEGER) || !integer(query.stopwatch_frequency, 1, Number.MAX_SAFE_INTEGER)) invalidPayload();
  const expected = record(payload.expected);
  if (!expected || !exactKeys(expected, ["basename_command_length", "basename_command_sha256", "encoded_length", "encoded_sha256", "executable_path", "fixed_command_length", "fixed_command_sha256", "quoted_command_length", "quoted_command_sha256", "schema"])
    || expected.schema !== "synthia-m4f-receiver-representation-expected.v1" || expected.executable_path !== POWERSHELL_PATH
    || expected.encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH || expected.encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || expected.basename_command_length !== COMMAND_PINS.basename_exact[0] || expected.basename_command_sha256 !== COMMAND_PINS.basename_exact[1]
    || expected.fixed_command_length !== COMMAND_PINS.fixed_exact[0] || expected.fixed_command_sha256 !== COMMAND_PINS.fixed_exact[1]
    || expected.quoted_command_length !== COMMAND_PINS.quoted_exact[0] || expected.quoted_command_sha256 !== COMMAND_PINS.quoted_exact[1]) invalidPayload();
  const actual = record(payload.actual);
  if (!actual || !exactKeys(actual, ["command_present", "command_sha256", "command_utf8_length", "executable_path", "returned_count", "schema"])
    || actual.schema !== "synthia-m4f-receiver-representation-actual.v1" || actual.returned_count !== query.returned_count
    || typeof actual.command_present !== "boolean"
    || (actual.executable_path !== null && (typeof actual.executable_path !== "string" || Buffer.byteLength(actual.executable_path, "utf8") > 1_024 || !/^[A-Za-z]:\\[^\u0000-\u001f\u007f]+\.exe$/u.test(actual.executable_path)))
    || (actual.command_present ? (!integer(actual.command_utf8_length, 1, MAX_COMMAND_BYTES) || !hash(actual.command_sha256)) : (actual.command_utf8_length !== null || actual.command_sha256 !== null))) invalidPayload();
  if (payload.failure_code !== null) {
    const code = payload.failure_code as string;
    const countMatches = code === "query_failed" ? query.returned_count === 0
      : code === "cardinality" ? query.returned_count === 0 || query.returned_count === 2 : query.returned_count === 1;
    const executableMatches = ["missing_command", "command_bound"].includes(code) ? actual.executable_path !== null : actual.executable_path === null;
    if (payload.status !== "indeterminate" || payload.classification !== null || !countMatches || !executableMatches || actual.command_present !== false) invalidPayload();
    return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  }
  const classification = record(payload.classification);
  if (!classification || !exactKeys(classification, ["canonical_base64", "command_candidate", "earliest_mismatch_stage", "encoded_length_matches", "encoded_sha256_matches", "executable", "marker", "prefix", "schema", "token_shape", "utf16le_roundtrip"])
    || classification.schema !== "synthia-m4f-receiver-representation-classification.v1"
    || !EXEC.includes(classification.executable as typeof EXEC[number]) || !CAND.includes(classification.command_candidate as typeof CAND[number])
    || !MARK.includes(classification.marker as typeof MARK[number]) || !PREFIX.includes(classification.prefix as typeof PREFIX[number])
    || !TOKEN.includes(classification.token_shape as typeof TOKEN[number]) || !STAGE.includes(classification.earliest_mismatch_stage as typeof STAGE[number])
    || ["encoded_length_matches", "encoded_sha256_matches", "canonical_base64", "utf16le_roundtrip"].some((key) => typeof classification[key] !== "boolean")) invalidPayload();
  const earliest = classification.executable !== "ordinal_exact" ? "executable" : classification.marker !== "exact" ? "marker"
    : !["basename_exact", "fixed_exact", "quoted_exact"].includes(classification.prefix as string) ? "prefix"
      : classification.token_shape !== "base64_shape" ? "token_shape" : !classification.encoded_length_matches ? "encoded_length"
        : !classification.encoded_sha256_matches ? "encoded_hash" : !classification.canonical_base64 ? "canonical_base64"
          : !classification.utf16le_roundtrip ? "utf16le_roundtrip" : "none";
  if (classification.earliest_mismatch_stage !== earliest || payload.status !== (earliest === "none" ? "representation_match" : "representation_mismatch")
    || query.returned_count !== 1 || !actual.command_present || actual.executable_path === null) invalidPayload();
  const executable = actual.executable_path as string;
  const executableClass = executable === POWERSHELL_PATH ? "ordinal_exact" : executable.toLowerCase() === POWERSHELL_PATH.toLowerCase() ? "case_only" : "different";
  const commandCandidate = (Object.entries(COMMAND_PINS) as Array<[keyof typeof COMMAND_PINS, readonly [number, string]]>)
    .find(([, pin]) => actual.command_utf8_length === pin[0] && actual.command_sha256 === pin[1])?.[0] ?? "none";
  const candidatePrefix = commandCandidate === "basename_exact" ? "basename_exact" : commandCandidate === "fixed_exact" ? "fixed_exact" : commandCandidate === "quoted_exact" ? "quoted_exact" : null;
  const commandContractExact = classification.marker === "exact" && ["basename_exact", "fixed_exact", "quoted_exact"].includes(classification.prefix as string)
    && classification.token_shape === "base64_shape" && classification.encoded_length_matches === true && classification.encoded_sha256_matches === true
    && classification.canonical_base64 === true && classification.utf16le_roundtrip === true;
  if (classification.executable !== executableClass || classification.command_candidate !== commandCandidate
    || (candidatePrefix !== null) !== commandContractExact || (candidatePrefix !== null && classification.prefix !== candidatePrefix)
    || (classification.token_shape !== "base64_shape" && (classification.encoded_length_matches || classification.encoded_sha256_matches || classification.canonical_base64 || classification.utf16le_roundtrip))
    || (!classification.canonical_base64 && classification.utf16le_roundtrip)
    || (["missing", "multiple"].includes(classification.marker as string) && (classification.prefix !== "other" || classification.token_shape !== "missing"
      || classification.encoded_length_matches || classification.encoded_sha256_matches || classification.canonical_base64 || classification.utf16le_roundtrip))) invalidPayload();
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function validatePhase09(observation: BoundJumpPhaseResult) {
  const redacted = redactSuccessfulPhase09(observation);
  const phase = record(observation);
  const identity = record(observation.identity);
  if (!phase || !exactKeys(phase, ["identity", "input", "master_after", "master_before", "payload", "phase", "process", "schema"])
    || !identity || !exactKeys(identity, ["computer_name", "identity_name", "identity_sid", "schema"])
    || observation.schema !== "synthia-m4f-bound-phase.v1" || observation.phase !== PHASE
    || identity.schema !== "synthia-m4f-jump-identity.v1" || identity.computer_name !== JUMP_COMPUTER
    || identity.identity_name !== JUMP_IDENTITY_NAME || identity.identity_sid !== JUMP_IDENTITY_SID) throw new Error("identity invalid");
  const expectedStdin = Buffer.from(`${Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT_09, "utf8").toString("base64")}\n`, "ascii");
  if (redacted.process.exit_status !== 0 || redacted.process.signal !== null || redacted.process.error_code !== null
    || redacted.process.stderr_length !== 0 || redacted.process.timed_out || redacted.process.outcome_ambiguous
    || redacted.input.artifact_length !== EXPECTED_ARTIFACT_LENGTH || redacted.input.artifact_sha256 !== EXPECTED_ARTIFACT_SHA256
    || redacted.input.stdin_length !== expectedStdin.length || redacted.input.stdin_sha256 !== createHash("sha256").update(expectedStdin).digest("hex")
    || redacted.input.receiver_source_length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH || redacted.input.receiver_source_sha256 !== BOUND_JUMP_RECEIVER_SOURCE_SHA256
    || redacted.input.receiver_encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH || redacted.input.receiver_encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || redacted.input.receiver_command_length !== BOUND_JUMP_RECEIVER_COMMAND_LENGTH || redacted.input.receiver_command_maximum !== 8_192
    || redacted.master_before.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256 || redacted.master_before.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256
    || redacted.master_before.network_sha256 !== MASTER_NETWORK_SHA256 || JSON.stringify(redacted.master_before) !== JSON.stringify(redacted.master_after)) throw new Error("evidence invalid");
  const payload = validatePayload09(observation.payload);
  const safeIdentity = { schema: "synthia-m4f-jump-identity.v1", computer_name: JUMP_COMPUTER, identity_name: JUMP_IDENTITY_NAME, identity_sid: JUMP_IDENTITY_SID };
  const expectedStdout = Buffer.from(`${JSON.stringify(safeIdentity)}\r\n${JSON.stringify(payload)}\r\n`, "utf8");
  if (redacted.process.stdout_length !== expectedStdout.length || redacted.process.stdout_sha256 !== createHash("sha256").update(expectedStdout).digest("hex")) throw new Error("stdout framing invalid");
  return {
    ...redacted,
    identity: safeIdentity,
    payload,
  };
}

export interface ReceiverRepresentation09Dependencies extends BoundJumpTransport09Dependencies {}
export function runReceiverRepresentationDiagnostic09(overrides: Partial<ReceiverRepresentation09Dependencies> = {}) {
  assertReceiverRepresentationArtifact09Frozen();
  if (process.env.SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION_09 !== CONFIRMATION) diagnosticFailure("M4F_RECEIVER_REPRESENTATION_09_CONFIRMATION_REQUIRED", "confirmation", null, null);
  let observation: BoundJumpPhaseResult;
  try { observation = invokeBoundJumpPhase09(PHASE, RECEIVER_REPRESENTATION_ARTIFACT_09, overrides); }
  catch (error) {
    const detail = error instanceof CeremonyFailure && error.detail.schema === "synthia-m4f-bound-phase-failure-09.v1" ? error.detail as unknown as BoundJumpFailureDetail09 : null;
    diagnosticFailure("M4F_RECEIVER_REPRESENTATION_09_TRANSPORT_FAILED", "transport", detail, null);
  }
  try {
    const redacted = validatePhase09(observation);
    return { schema: "synthia-m4f-receiver-representation-ceremony-09.v1" as const, status: "observed" as const, predecessor_effect_state: "unknown" as const, retry_permitted: false as const, observation: redacted };
  } catch {
    let redacted: unknown = null;
    try { redacted = redactSuccessfulPhase09(observation); } catch { /* fail closed without raw observation */ }
    diagnosticFailure("M4F_RECEIVER_REPRESENTATION_09_OUTPUT_INVALID", "validation", null, redacted);
  }
}

if (import.meta.main) runCeremony(() => process.stdout.write(`${JSON.stringify(runReceiverRepresentationDiagnostic09())}\n`));
