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
import {
  RECEIVER_REPRESENTATION_ARTIFACT_09,
  RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH,
  RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256,
} from "./invoke-m4f-jump-local-receiver-representation-diagnostic-09.ts";

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_20260827_09";
const PHASE = "jump-local-receiver-representation-parse-gate-09:parse";
const JUMP_COMPUTER = "DESKTOP-E380LR7";
const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK_SHA256 = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";

export const RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09 = readFileSync(
  new URL("./m4f-jump-local-receiver-representation-parse-gate-09.ps1", import.meta.url),
  "utf8",
);
export const RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_LENGTH = Buffer.byteLength(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09, "utf8");
export const RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_SHA256 = createHash("sha256").update(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09).digest("hex");
const EXPECTED_ARTIFACT_LENGTH = 19_540;
const EXPECTED_ARTIFACT_SHA256 = "892525d449f666bea9a3dd246b7a0ffa590d26147e14ec0a2c7b575e67727bac";
if (RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_LENGTH !== EXPECTED_ARTIFACT_LENGTH
  || RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_SHA256 !== EXPECTED_ARTIFACT_SHA256) {
  throw new Error("M4F_RECEIVER_REPRESENTATION_PARSE_09_ARTIFACT_DRIFT");
}

export function assertReceiverRepresentationParseGate09Frozen(length = RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_LENGTH, sha = RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09_SHA256): void {
  if (length !== EXPECTED_ARTIFACT_LENGTH || sha !== EXPECTED_ARTIFACT_SHA256) throw new Error("M4F_RECEIVER_REPRESENTATION_PARSE_09_ARTIFACT_DRIFT");
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) return null;
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).sort().join("|") === [...expected].sort().join("|"); }
function parseFailure(code: string, stage: "confirmation" | "transport" | "validation", transportFailure: BoundJumpFailureDetail09 | null, redactedObservation: unknown): never {
  throw new CeremonyFailure({ schema: "synthia-m4f-receiver-representation-parse-failure-09.v1", code, phase: PHASE, current_stage: stage, predecessor_effect_state: "unknown", retry_permitted: false, transport_failure: transportFailure, redacted_observation: redactedObservation });
}

const PAYLOAD_KEYS = ["constructed_ast_type", "constructed_extent_character_length", "constructed_extent_end_offset", "constructed_extent_sha256", "constructed_extent_start_offset", "constructed_extent_utf8_length", "language_mode", "parse_error_count", "parse_errors", "parse_errors_truncated", "parser_ast_type", "parser_extent_character_length", "parser_extent_end_offset", "parser_extent_sha256", "parser_extent_start_offset", "parser_extent_utf8_length", "powershell_edition", "powershell_version", "process_bitness", "schema", "scriptblock_create_exception", "status", "target_artifact_length", "target_artifact_sha256", "target_body_not_invoked", "target_scriptblock_constructed", "target_source_character_length", "target_source_sha256", "target_source_utf8_length"] as const;
function validatePayload09(payload: Record<string, unknown>): Record<string, unknown> {
  if (record(payload) !== payload || !exactKeys(payload, PAYLOAD_KEYS)
    || payload.schema !== "synthia-m4f-receiver-representation-parse-09-gate.v1"
    || payload.status !== "parsed_not_invoked"
    || payload.target_artifact_length !== RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH
    || payload.target_artifact_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256
    || payload.target_source_character_length !== RECEIVER_REPRESENTATION_ARTIFACT_09.length
    || payload.target_source_utf8_length !== RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH
    || payload.target_source_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256
    || payload.powershell_edition !== "Desktop" || typeof payload.powershell_version !== "string" || !/^5\.1\.\d+\.\d+$/u.test(payload.powershell_version)
    || payload.process_bitness !== 64 || payload.language_mode !== "FullLanguage"
    || payload.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || payload.parser_extent_start_offset !== 0 || payload.parser_extent_end_offset !== RECEIVER_REPRESENTATION_ARTIFACT_09.length
    || payload.parser_extent_character_length !== RECEIVER_REPRESENTATION_ARTIFACT_09.length || payload.parser_extent_utf8_length !== RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH
    || payload.parser_extent_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256 || payload.parse_error_count !== 0
    || payload.parse_errors_truncated !== false || !Array.isArray(payload.parse_errors) || payload.parse_errors.length !== 0
    || payload.target_scriptblock_constructed !== true || payload.constructed_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || payload.constructed_extent_start_offset !== 0 || payload.constructed_extent_end_offset !== RECEIVER_REPRESENTATION_ARTIFACT_09.length
    || payload.constructed_extent_character_length !== RECEIVER_REPRESENTATION_ARTIFACT_09.length || payload.constructed_extent_utf8_length !== RECEIVER_REPRESENTATION_ARTIFACT_09_LENGTH
    || payload.constructed_extent_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_09_SHA256 || payload.scriptblock_create_exception !== null
    || payload.target_body_not_invoked !== true) throw new Error("parse output invalid");
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function validatePhase09(observation: BoundJumpPhaseResult) {
  const redacted = redactSuccessfulPhase09(observation);
  const phase = record(observation);
  const identity = record(observation.identity);
  if (!phase || !exactKeys(phase, ["identity", "input", "master_after", "master_before", "payload", "phase", "process", "schema"])
    || !identity || !exactKeys(identity, ["computer_name", "identity_name", "identity_sid", "schema"])
    || observation.schema !== "synthia-m4f-bound-phase.v1" || observation.phase !== PHASE
    || identity.schema !== "synthia-m4f-jump-identity.v1" || identity.computer_name !== JUMP_COMPUTER || identity.identity_name !== JUMP_IDENTITY_NAME || identity.identity_sid !== JUMP_IDENTITY_SID) throw new Error("identity invalid");
  const expectedStdin = Buffer.from(`${Buffer.from(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09, "utf8").toString("base64")}\n`, "ascii");
  if (redacted.process.exit_status !== 0 || redacted.process.signal !== null || redacted.process.error_code !== null || redacted.process.stderr_length !== 0 || redacted.process.timed_out || redacted.process.outcome_ambiguous
    || redacted.input.artifact_length !== EXPECTED_ARTIFACT_LENGTH || redacted.input.artifact_sha256 !== EXPECTED_ARTIFACT_SHA256 || redacted.input.stdin_length !== expectedStdin.length || redacted.input.stdin_sha256 !== createHash("sha256").update(expectedStdin).digest("hex")
    || redacted.input.receiver_source_length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH || redacted.input.receiver_source_sha256 !== BOUND_JUMP_RECEIVER_SOURCE_SHA256 || redacted.input.receiver_encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH || redacted.input.receiver_encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || redacted.input.receiver_command_length !== BOUND_JUMP_RECEIVER_COMMAND_LENGTH || redacted.input.receiver_command_maximum !== 8_192
    || redacted.master_before.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256 || redacted.master_before.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256 || redacted.master_before.network_sha256 !== MASTER_NETWORK_SHA256
    || JSON.stringify(redacted.master_before) !== JSON.stringify(redacted.master_after)) throw new Error("evidence invalid");
  const payload = validatePayload09(observation.payload);
  const safeIdentity = { schema: "synthia-m4f-jump-identity.v1", computer_name: JUMP_COMPUTER, identity_name: JUMP_IDENTITY_NAME, identity_sid: JUMP_IDENTITY_SID };
  const expectedStdout = Buffer.from(`${JSON.stringify(safeIdentity)}\r\n${JSON.stringify(payload)}\r\n`, "utf8");
  if (redacted.process.stdout_length !== expectedStdout.length || redacted.process.stdout_sha256 !== createHash("sha256").update(expectedStdout).digest("hex")) throw new Error("stdout invalid");
  return redacted;
}

export interface ReceiverRepresentationParseGate09Dependencies extends BoundJumpTransport09Dependencies {}
export function runReceiverRepresentationParseGate09(overrides: Partial<ReceiverRepresentationParseGate09Dependencies> = {}) {
  assertReceiverRepresentationParseGate09Frozen();
  if (process.env.SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION_09 !== CONFIRMATION) parseFailure("M4F_RECEIVER_REPRESENTATION_PARSE_09_CONFIRMATION_REQUIRED", "confirmation", null, null);
  let observation: BoundJumpPhaseResult;
  try { observation = invokeBoundJumpPhase09(PHASE, RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_09, overrides); }
  catch (error) {
    const detail = error instanceof CeremonyFailure && error.detail.schema === "synthia-m4f-bound-phase-failure-09.v1" ? error.detail as unknown as BoundJumpFailureDetail09 : null;
    parseFailure("M4F_RECEIVER_REPRESENTATION_PARSE_09_TRANSPORT_FAILED", "transport", detail, null);
  }
  try {
    const redacted = validatePhase09(observation);
    return { schema: "synthia-m4f-receiver-representation-parse-ceremony-09.v1" as const, status: "parsed_not_invoked" as const, predecessor_effect_state: "unknown" as const, retry_permitted: false as const, observation: redacted };
  } catch {
    let redacted: unknown = null;
    try { redacted = redactSuccessfulPhase09(observation); } catch { /* no raw fallback */ }
    parseFailure("M4F_RECEIVER_REPRESENTATION_PARSE_09_OUTPUT_INVALID", "validation", null, redacted);
  }
}
if (import.meta.main) runCeremony(() => process.stdout.write(`${JSON.stringify(runReceiverRepresentationParseGate09())}\n`));
