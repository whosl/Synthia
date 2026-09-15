import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
} from "./m4f-bound-jump-transport.ts";
import {
  JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
} from "./invoke-m4f-jump-local-residue-observation-06.ts";
import {
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
  JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
} from "./invoke-m4f-jump-local-residue-parse-gate-06.ts";

const PARSE_PHASE = "jump-local-residue-parse-gate-06:parse";
const JUMP_COMPUTER = "DESKTOP-E380LR7";
const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK_SHA256 = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";
const MASTER_NETWORK_FD = 3;
const MASTER_NETWORK_LOCAL_PORT = 65_322;
const MAX_RETAINED_LOG_BYTES = 1_048_576;

export interface JumpLocalResidueParseEvidence07Result {
  schema: "synthia-m4f-jump-local-residue-parse-evidence-verification-07.v1";
  status: "parsed_not_invoked_verified";
  retained_log_length: number;
  retained_log_sha256: string;
  target_artifact_length: number;
  target_artifact_sha256: string;
  parse_gate_artifact_length: number;
  parse_gate_artifact_sha256: string;
  stdout_framing: "identity_crlf_payload_crlf";
}

function invalid(): never {
  throw new Error("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_07_INVALID");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) invalid();
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function validateIdentity(value: unknown): Record<string, unknown> {
  const identity = record(value);
  exactKeys(identity, ["computer_name", "identity_name", "identity_sid", "schema"]);
  if (identity.schema !== "synthia-m4f-jump-identity.v1"
    || identity.computer_name !== JUMP_COMPUTER
    || identity.identity_name !== JUMP_IDENTITY_NAME
    || identity.identity_sid !== JUMP_IDENTITY_SID) invalid();
  return identity;
}

function validateParsedPayload(value: unknown): Record<string, unknown> {
  const payload = record(value);
  exactKeys(payload, [
    "constructed_ast_type",
    "constructed_extent_character_length",
    "constructed_extent_end_offset",
    "constructed_extent_sha256",
    "constructed_extent_start_offset",
    "constructed_extent_utf8_length",
    "language_mode",
    "parse_error_count",
    "parse_errors",
    "parse_errors_truncated",
    "parser_ast_type",
    "parser_extent_character_length",
    "parser_extent_end_offset",
    "parser_extent_sha256",
    "parser_extent_start_offset",
    "parser_extent_utf8_length",
    "powershell_edition",
    "powershell_version",
    "process_bitness",
    "schema",
    "scriptblock_create_exception",
    "status",
    "target_artifact_length",
    "target_artifact_sha256",
    "target_body_not_invoked",
    "target_scriptblock_constructed",
    "target_source_character_length",
    "target_source_sha256",
    "target_source_utf8_length",
  ]);
  const fullAst = "System.Management.Automation.Language.ScriptBlockAst";
  if (payload.schema !== "synthia-m4f-jump-local-residue-parse-gate.v1"
    || payload.status !== "parsed_not_invoked"
    || payload.target_artifact_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.target_artifact_sha256 !== JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256
    || payload.target_source_character_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.target_source_utf8_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.target_source_sha256 !== JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256
    || payload.powershell_edition !== "Desktop"
    || typeof payload.powershell_version !== "string"
    || !/^5\.1\.\d+\.\d+$/u.test(payload.powershell_version)
    || payload.process_bitness !== 64
    || payload.language_mode !== "FullLanguage"
    || payload.parser_ast_type !== fullAst
    || payload.parser_extent_start_offset !== 0
    || payload.parser_extent_end_offset !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.parser_extent_character_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.parser_extent_utf8_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.parser_extent_sha256 !== JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256
    || payload.parse_error_count !== 0
    || payload.parse_errors_truncated !== false
    || !Array.isArray(payload.parse_errors)
    || payload.parse_errors.length !== 0
    || payload.target_scriptblock_constructed !== true
    || payload.constructed_ast_type !== fullAst
    || payload.constructed_extent_start_offset !== 0
    || payload.constructed_extent_end_offset !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.constructed_extent_character_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.constructed_extent_utf8_length !== JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH
    || payload.constructed_extent_sha256 !== JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256
    || payload.scriptblock_create_exception !== null
    || payload.target_body_not_invoked !== true) invalid();
  return payload;
}

function validateMaster(value: unknown): Record<string, unknown> {
  const master = record(value);
  exactKeys(master, [
    "child_effective_config_sha256",
    "host_key_fingerprint",
    "known_hosts_path",
    "master_effective_config_sha256",
    "master_pid",
    "master_socket",
    "network_connection",
    "network_process",
    "network_sha256",
    "schema",
    "ssh_executable",
  ]);
  if (master.schema !== "synthia-m4f-bound-master-audit.v1"
    || master.master_pid !== 87_062
    || master.master_socket !== "/private/tmp/synthia-m4f-jump.sock"
    || master.known_hosts_path !== "/Users/wenzhuolin/.ssh/known_hosts"
    || master.host_key_fingerprint !== "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8"
    || master.ssh_executable !== "/usr/bin/ssh"
    || master.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256
    || master.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256
    || master.network_sha256 !== MASTER_NETWORK_SHA256) invalid();
  const networkProcess = validateProcessEvidence(master.network_process, true);
  const networkBytes = Buffer.from(networkProcess.stdout_base64 as string, "base64");
  const networkText = networkBytes.toString("utf8");
  const networkMatch = /^p87062\ncssh\nf(\d+)\ntIPv4\nPTCP\nn100\.123\.31\.75:(\d+)->100\.66\.198\.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n$/u
    .exec(networkText);
  if (!networkMatch
    || Buffer.from(networkText, "utf8").equals(networkBytes) !== true
    || createHash("sha256").update(networkBytes).digest("hex") !== MASTER_NETWORK_SHA256
    || Number(networkMatch[1]) !== MASTER_NETWORK_FD
    || Number(networkMatch[2]) !== MASTER_NETWORK_LOCAL_PORT) invalid();
  const connection = record(master.network_connection);
  exactKeys(connection, [
    "fd",
    "local_address",
    "local_port",
    "protocol",
    "remote_address",
    "remote_port",
    "state",
  ]);
  if (connection.fd !== MASTER_NETWORK_FD
    || connection.protocol !== "TCP"
    || connection.local_address !== "100.123.31.75"
    || connection.local_port !== MASTER_NETWORK_LOCAL_PORT
    || connection.remote_address !== "100.66.198.60"
    || connection.remote_port !== 22
    || connection.state !== "ESTABLISHED") invalid();
  return master;
}

function validateProcessEvidence(value: unknown, network: boolean): Record<string, unknown> {
  const processEvidence = record(value);
  exactKeys(processEvidence, [
    "error_code",
    "exit_status",
    "outcome_ambiguous",
    "retry_permitted",
    "signal",
    "stderr_base64",
    "stdout_base64",
    "timed_out",
  ]);
  if (processEvidence.exit_status !== 0
    || processEvidence.signal !== null
    || processEvidence.error_code !== null
    || typeof processEvidence.stdout_base64 !== "string"
    || typeof processEvidence.stderr_base64 !== "string"
    || processEvidence.stderr_base64 !== ""
    || processEvidence.timed_out !== false
    || processEvidence.outcome_ambiguous !== false
    || processEvidence.retry_permitted !== false) invalid();
  if (network) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(processEvidence.stdout_base64)) invalid();
    const decoded = Buffer.from(processEvidence.stdout_base64, "base64");
    if (decoded.toString("base64") !== processEvidence.stdout_base64
      || decoded.length < 1
      || decoded.length > 8_192
      || processEvidence.stdout_base64 === "") invalid();
  }
  return processEvidence;
}

function validateInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  exactKeys(input, [
    "artifact_length",
    "artifact_sha256",
    "receiver_command_length",
    "receiver_command_maximum",
    "receiver_encoded_length",
    "receiver_encoded_sha256",
    "receiver_source_length",
    "receiver_source_sha256",
    "stdin_length",
    "stdin_sha256",
  ]);
  for (const key of [
    "artifact_sha256",
    "receiver_encoded_sha256",
    "receiver_source_sha256",
    "stdin_sha256",
  ]) {
    if (typeof input[key] !== "string" || !/^[0-9a-f]{64}$/u.test(input[key])) invalid();
  }
  for (const key of [
    "artifact_length",
    "receiver_command_length",
    "receiver_command_maximum",
    "receiver_encoded_length",
    "receiver_source_length",
    "stdin_length",
  ]) {
    if (!integer(input[key], 0, 1_048_576)) invalid();
  }
  return input;
}

export function verifyJumpLocalResidueParseEvidence07(
  retainedLog: Buffer | string,
): JumpLocalResidueParseEvidence07Result {
  const bytes = typeof retainedLog === "string"
    ? Buffer.from(retainedLog, "utf8")
    : retainedLog;
  if (bytes.length < 1 || bytes.length > MAX_RETAINED_LOG_BYTES) invalid();
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)
    || !text.endsWith("\n")
    || text.slice(0, -1).includes("\n")
    || text.includes("\r")) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    invalid();
  }
  const envelope = record(parsed);
  exactKeys(envelope, [
    "cause",
    "code",
    "current_stage",
    "observation",
    "retry_permitted",
    "schema",
  ]);
  if (envelope.schema !== "synthia-m4f-jump-local-residue-parse-gate-failure.v1"
    || envelope.code !== "M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID"
    || envelope.current_stage !== "validation"
    || envelope.retry_permitted !== false) invalid();
  const cause = record(envelope.cause);
  exactKeys(cause, [
    "cause",
    "code",
    "current_stage",
    "observation",
    "retry_permitted",
    "schema",
  ]);
  if (cause.schema !== "synthia-m4f-jump-local-residue-parse-gate-failure.v1"
    || cause.code !== "M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_INVALID"
    || cause.current_stage !== "validation"
    || cause.retry_permitted !== false
    || cause.observation !== null
    || cause.cause !== null) invalid();

  const observation = record(envelope.observation);
  exactKeys(observation, [
    "identity",
    "input",
    "master_after",
    "master_before",
    "payload",
    "phase",
    "process",
    "schema",
  ]);
  const identity = validateIdentity(observation.identity);
  const payload = validateParsedPayload(observation.payload);
  const processEvidence = validateProcessEvidence(observation.process, false);
  const input = validateInput(observation.input);
  const before = validateMaster(observation.master_before);
  const after = validateMaster(observation.master_after);
  const expectedStdout = Buffer.from(
    `${JSON.stringify(identity)}\r\n${JSON.stringify(payload)}\r\n`,
    "utf8",
  ).toString("base64");
  const expectedStdin = Buffer.from(
    `${Buffer.from(JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT, "utf8").toString("base64")}\n`,
    "ascii",
  );
  if (observation.schema !== "synthia-m4f-bound-phase.v1"
    || observation.phase !== PARSE_PHASE
    || processEvidence.exit_status !== 0
    || processEvidence.signal !== null
    || processEvidence.error_code !== null
    || processEvidence.stdout_base64 !== expectedStdout
    || processEvidence.stderr_base64 !== ""
    || processEvidence.timed_out !== false
    || processEvidence.outcome_ambiguous !== false
    || processEvidence.retry_permitted !== false
    || input.artifact_length !== JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH
    || input.artifact_sha256 !== JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256
    || input.stdin_length !== expectedStdin.length
    || input.stdin_sha256 !== createHash("sha256").update(expectedStdin).digest("hex")
    || input.receiver_source_length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH
    || input.receiver_source_sha256 !== BOUND_JUMP_RECEIVER_SOURCE_SHA256
    || input.receiver_encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH
    || input.receiver_encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || input.receiver_command_length !== BOUND_JUMP_RECEIVER_COMMAND_LENGTH
    || input.receiver_command_maximum !== 8_192
    || JSON.stringify(before) !== JSON.stringify(after)) invalid();
  return {
    schema: "synthia-m4f-jump-local-residue-parse-evidence-verification-07.v1",
    status: "parsed_not_invoked_verified",
    retained_log_length: bytes.length,
    retained_log_sha256: createHash("sha256").update(bytes).digest("hex"),
    target_artifact_length: JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH,
    target_artifact_sha256: JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256,
    parse_gate_artifact_length: JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_LENGTH,
    parse_gate_artifact_sha256: JUMP_LOCAL_RESIDUE_PARSE_GATE_ARTIFACT_SHA256,
    stdout_framing: "identity_crlf_payload_crlf",
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) invalid();
  process.stdout.write(`${JSON.stringify(verifyJumpLocalResidueParseEvidence07(
    readFileSync(path),
  ))}\n`);
}
