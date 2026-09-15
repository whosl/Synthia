import { createHash } from "node:crypto";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  invokeBoundJumpPhase,
  runCeremony,
} from "./m4f-bound-jump-transport.ts";
import {
  RECEIVER_REPRESENTATION_ARTIFACT,
  RECEIVER_REPRESENTATION_ARTIFACT_LENGTH,
  RECEIVER_REPRESENTATION_ARTIFACT_SHA256,
} from "./invoke-m4f-jump-local-receiver-representation-diagnostic-08.ts";

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_20260827_08";
const PHASE = "jump-local-receiver-representation-parse-gate-08:parse";
const JUMP_COMPUTER = "DESKTOP-E380LR7";
const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK_SHA256 = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";
const MAX_PARSE_ERRORS = 32;
const MAX_PARSE_ERROR_COUNT = 128;
const MAX_PARSE_MESSAGE_BYTES = 8_192;
const TARGET_SOURCE_CHARACTER_LENGTH = RECEIVER_REPRESENTATION_ARTIFACT.length;

const TARGET_BASE64 = Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT, "utf8").toString("base64");

export const RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT = String.raw`
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$targetBase64 = "${TARGET_BASE64}"
$expectedTargetLength = ${RECEIVER_REPRESENTATION_ARTIFACT_LENGTH}
$expectedTargetSha256 = "${RECEIVER_REPRESENTATION_ARTIFACT_SHA256}"
$maximumParseErrors = ${MAX_PARSE_ERRORS}
$maximumParseErrorCount = ${MAX_PARSE_ERROR_COUNT}
$maximumMessageBytes = ${MAX_PARSE_MESSAGE_BYTES}
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-BytesSha256([byte[]]$Bytes) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($Bytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-MessageFact([string]$Message) {
  $bytes = $strictUtf8.GetBytes($Message)
  if ($bytes.Length -gt $maximumMessageBytes) {
    throw "M4F_JUMP_LOCAL_RESIDUE_PARSE_MESSAGE_BOUND"
  }
  return [ordered]@{
    length = [int]$bytes.Length
    sha256 = Get-BytesSha256 $bytes
  }
}

function Get-ExceptionFact([Exception]$Exception) {
  $message = Get-MessageFact ([string]$Exception.Message)
  return [ordered]@{
    schema = "synthia-m4f-jump-local-residue-parse-exception.v1"
    type = [string]$Exception.GetType().FullName
    hresult = [int]$Exception.HResult
    message_utf8_length = [int]$message.length
    message_utf8_sha256 = [string]$message.sha256
  }
}

$targetBytes = [Convert]::FromBase64String($targetBase64)
if ([Convert]::ToBase64String($targetBytes) -cne $targetBase64 -or
  $targetBytes.Length -ne $expectedTargetLength -or
  (Get-BytesSha256 $targetBytes) -cne $expectedTargetSha256) {
  throw "M4F_JUMP_LOCAL_RESIDUE_PARSE_TARGET_INVALID"
}
$targetSource = $strictUtf8.GetString($targetBytes)
if ($strictUtf8.GetBytes($targetSource).Length -ne $targetBytes.Length) {
  throw "M4F_JUMP_LOCAL_RESIDUE_PARSE_TARGET_UTF8_INVALID"
}

$tokens = $null
$parseErrors = $null
$parsedTarget = [System.Management.Automation.Language.Parser]::ParseInput($targetSource, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt $maximumParseErrorCount) {
  throw "M4F_JUMP_LOCAL_RESIDUE_PARSE_ERROR_CARDINALITY"
}
$parsedExtentText = [string]$parsedTarget.Extent.Text
$parsedExtentBytes = $strictUtf8.GetBytes($parsedExtentText)
$parseErrorFacts = @()
foreach ($parseError in @($parseErrors | Select-Object -First $maximumParseErrors)) {
  $message = Get-MessageFact ([string]$parseError.Message)
  $parseErrorFacts += [ordered]@{
    schema = "synthia-m4f-jump-local-residue-parse-error.v1"
    error_id = [string]$parseError.ErrorId
    message_utf8_length = [int]$message.length
    message_utf8_sha256 = [string]$message.sha256
    start_offset = [int]$parseError.Extent.StartOffset
    end_offset = [int]$parseError.Extent.EndOffset
  }
}

$constructedTarget = $null
$scriptBlockCreateException = $null
try {
  $constructedTarget = [ScriptBlock]::Create($targetSource)
} catch {
  $scriptBlockCreateException = Get-ExceptionFact $_.Exception
}
$targetScriptblockConstructed = $null -ne $constructedTarget
$constructedAstType = $null
$constructedExtentStartOffset = $null
$constructedExtentEndOffset = $null
$constructedExtentCharacterLength = $null
$constructedExtentUtf8Length = $null
$constructedExtentSha256 = $null
if ($targetScriptblockConstructed) {
  $constructedExtentText = [string]$constructedTarget.Ast.Extent.Text
  $constructedExtentBytes = $strictUtf8.GetBytes($constructedExtentText)
  $constructedAstType = [string]$constructedTarget.Ast.GetType().FullName
  $constructedExtentStartOffset = [int]$constructedTarget.Ast.Extent.StartOffset
  $constructedExtentEndOffset = [int]$constructedTarget.Ast.Extent.EndOffset
  $constructedExtentCharacterLength = [int]$constructedExtentText.Length
  $constructedExtentUtf8Length = [int]$constructedExtentBytes.Length
  $constructedExtentSha256 = Get-BytesSha256 $constructedExtentBytes
}
$status = if ($parseErrors.Count -eq 0 -and $targetScriptblockConstructed) {
  "parsed_not_invoked"
} else {
  "parse_rejected"
}
$output = [ordered]@{
  schema = "synthia-m4f-jump-local-residue-parse-gate.v1"
  status = $status
  target_artifact_length = $expectedTargetLength
  target_artifact_sha256 = $expectedTargetSha256
  target_source_character_length = [int]$targetSource.Length
  target_source_utf8_length = [int]$targetBytes.Length
  target_source_sha256 = Get-BytesSha256 $targetBytes
  powershell_edition = [string]$PSVersionTable.PSEdition
  powershell_version = [string]$PSVersionTable.PSVersion.ToString()
  process_bitness = [int]([IntPtr]::Size * 8)
  language_mode = [string]$ExecutionContext.SessionState.LanguageMode
  parser_ast_type = [string]$parsedTarget.GetType().FullName
  parser_extent_start_offset = [int]$parsedTarget.Extent.StartOffset
  parser_extent_end_offset = [int]$parsedTarget.Extent.EndOffset
  parser_extent_character_length = [int]$parsedExtentText.Length
  parser_extent_utf8_length = [int]$parsedExtentBytes.Length
  parser_extent_sha256 = Get-BytesSha256 $parsedExtentBytes
  parse_error_count = [int]$parseErrors.Count
  parse_errors_truncated = [bool]($parseErrors.Count -gt $parseErrorFacts.Count)
  parse_errors = @($parseErrorFacts)
  target_scriptblock_constructed = [bool]$targetScriptblockConstructed
  constructed_ast_type = $constructedAstType
  constructed_extent_start_offset = $constructedExtentStartOffset
  constructed_extent_end_offset = $constructedExtentEndOffset
  constructed_extent_character_length = $constructedExtentCharacterLength
  constructed_extent_utf8_length = $constructedExtentUtf8Length
  constructed_extent_sha256 = $constructedExtentSha256
  scriptblock_create_exception = $scriptBlockCreateException
  target_body_not_invoked = $true
}
$json = $output | ConvertTo-Json -Depth 5 -Compress
if ($strictUtf8.GetByteCount($json) -gt 1048576) {
  throw "M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_BOUND"
}
[Console]::Out.WriteLine($json)
`;

export const RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH = Buffer.byteLength(
  RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT,
  "utf8",
);
export const RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256 = createHash("sha256")
  .update(Buffer.from(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT, "utf8"))
  .digest("hex");
const EXPECTED_ARTIFACT_LENGTH = 19_236;
const EXPECTED_ARTIFACT_SHA256 = "3241f48af99b1710619bf9874d34a1b36ab3f1649d36cebf8cbe1c1bfc4c0a35";

if (RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH !== EXPECTED_ARTIFACT_LENGTH
  || RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256 !== EXPECTED_ARTIFACT_SHA256) {
  throw new Error("M4F_RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_DRIFT");
}

export function assertReceiverRepresentationParseGateArtifactFrozen(
  length = RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_LENGTH,
  hash = RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_SHA256,
): void {
  if (length !== EXPECTED_ARTIFACT_LENGTH || hash !== EXPECTED_ARTIFACT_SHA256) {
    throw new Error("M4F_RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT_DRIFT");
  }
}

function failure(
  code: string,
  stage: "confirmation" | "transport" | "validation",
  observation: BoundJumpPhaseResult | null,
  cause: Record<string, unknown> | null,
): never {
  throw new CeremonyFailure({
    schema: "synthia-m4f-jump-local-residue-parse-gate-failure.v1",
    code,
    current_stage: stage,
    retry_permitted: false,
    observation,
    cause,
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function base64(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= maximumBytes && bytes.toString("base64") === value;
}

const PROCESS_KEYS = [
  "error_code", "exit_status", "outcome_ambiguous", "retry_permitted", "signal",
  "stderr_base64", "stdout_base64", "timed_out",
] as const;
const INPUT_KEYS = [
  "artifact_length", "artifact_sha256", "receiver_command_length", "receiver_command_maximum",
  "receiver_encoded_length", "receiver_encoded_sha256", "receiver_source_length",
  "receiver_source_sha256", "stdin_length", "stdin_sha256",
] as const;
const MASTER_KEYS = [
  "child_effective_config_sha256", "host_key_fingerprint", "known_hosts_path",
  "master_effective_config_sha256", "master_pid", "master_socket", "network_connection",
  "network_process", "network_sha256", "schema", "ssh_executable",
] as const;
const CONNECTION_KEYS = [
  "fd", "local_address", "local_port", "protocol", "remote_address", "remote_port", "state",
] as const;

function validateProcess(value: unknown, expectedStdout: string | null): void {
  const process = objectValue(value);
  exactKeys(process, PROCESS_KEYS);
  if (process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || !base64(process.stdout_base64, 8 * 1024 * 1024) || process.stderr_base64 !== ""
    || process.timed_out !== false || process.outcome_ambiguous !== false || process.retry_permitted !== false
    || (expectedStdout !== null && process.stdout_base64 !== expectedStdout)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_INVALID", "validation", null, null);
  }
}

function validateMaster(value: unknown): Record<string, unknown> {
  const master = objectValue(value);
  exactKeys(master, MASTER_KEYS);
  const connection = objectValue(master.network_connection);
  exactKeys(connection, CONNECTION_KEYS);
  validateProcess(master.network_process, null);
  const networkProcess = objectValue(master.network_process);
  const networkBytes = Buffer.from(networkProcess.stdout_base64 as string, "base64");
  const networkMatch = /^p87062\ncssh\nf(\d+)\ntIPv4\nPTCP\nn100\.123\.31\.75:(\d+)->100\.66\.198\.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n$/u
    .exec(networkBytes.toString("ascii"));
  const networkFd = Number(networkMatch?.[1]);
  const networkPort = Number(networkMatch?.[2]);
  if (master.schema !== "synthia-m4f-bound-master-audit.v1"
    || master.master_pid !== 87_062
    || master.master_socket !== "/private/tmp/synthia-m4f-jump.sock"
    || master.known_hosts_path !== "/Users/wenzhuolin/.ssh/known_hosts"
    || master.host_key_fingerprint !== "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8"
    || master.ssh_executable !== "/usr/bin/ssh"
    || master.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256
    || master.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256
    || master.network_sha256 !== MASTER_NETWORK_SHA256
    || createHash("sha256").update(networkBytes).digest("hex") !== master.network_sha256
    || !networkMatch
    || !integer(networkFd, 0, 1_048_575)
    || connection.fd !== networkFd
    || connection.protocol !== "TCP"
    || connection.local_address !== "100.123.31.75"
    || !integer(networkPort, 49_152, 65_535)
    || connection.local_port !== networkPort
    || connection.remote_address !== "100.66.198.60"
    || connection.remote_port !== 22
    || connection.state !== "ESTABLISHED") {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_INVALID", "validation", null, null);
  }
  return master;
}

function validateMessage(
  value: Record<string, unknown>,
  lengthKey: string,
  hashKey: string,
): void {
  if (!integer(value[lengthKey], 0, MAX_PARSE_MESSAGE_BYTES)
    || !sha256(value[hashKey])) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
}

function validateException(value: unknown): void {
  const exception = objectValue(value);
  exactKeys(exception, [
    "hresult",
    "message_utf8_length",
    "message_utf8_sha256",
    "schema",
    "type",
  ]);
  if (exception.schema !== "synthia-m4f-jump-local-residue-parse-exception.v1"
    || typeof exception.type !== "string"
    || Buffer.byteLength(exception.type, "utf8") < 1
    || Buffer.byteLength(exception.type, "utf8") > 512
    || !/^[A-Za-z_][A-Za-z0-9_.+`]*Exception$/u.test(exception.type)
    || !integer(exception.hresult, -2_147_483_648, 2_147_483_647)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
  validateMessage(exception, "message_utf8_length", "message_utf8_sha256");
}

function validatePayload(
  payload: Record<string, unknown>,
): "parsed_not_invoked" | "parse_rejected" {
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
  if (payload.schema !== "synthia-m4f-jump-local-residue-parse-gate.v1"
    || (payload.status !== "parsed_not_invoked" && payload.status !== "parse_rejected")
    || payload.target_artifact_length !== RECEIVER_REPRESENTATION_ARTIFACT_LENGTH
    || payload.target_artifact_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_SHA256
    || payload.target_source_character_length !== TARGET_SOURCE_CHARACTER_LENGTH
    || payload.target_source_utf8_length !== RECEIVER_REPRESENTATION_ARTIFACT_LENGTH
    || payload.target_source_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_SHA256
    || payload.powershell_edition !== "Desktop"
    || typeof payload.powershell_version !== "string"
    || !/^5\.1\.\d+\.\d+$/u.test(payload.powershell_version)
    || payload.process_bitness !== 64
    || payload.language_mode !== "FullLanguage"
    || payload.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || payload.parser_extent_start_offset !== 0
    || payload.parser_extent_end_offset !== TARGET_SOURCE_CHARACTER_LENGTH
    || payload.parser_extent_character_length !== TARGET_SOURCE_CHARACTER_LENGTH
    || payload.parser_extent_utf8_length !== RECEIVER_REPRESENTATION_ARTIFACT_LENGTH
    || payload.parser_extent_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_SHA256
    || !integer(payload.parse_error_count, 0, MAX_PARSE_ERROR_COUNT)
    || typeof payload.parse_errors_truncated !== "boolean"
    || !Array.isArray(payload.parse_errors)
    || payload.parse_errors.length > MAX_PARSE_ERRORS
    || typeof payload.target_scriptblock_constructed !== "boolean"
    || payload.target_body_not_invoked !== true) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
  for (const candidate of payload.parse_errors) {
    const parseError = objectValue(candidate);
    exactKeys(parseError, [
      "end_offset",
      "error_id",
      "message_utf8_length",
      "message_utf8_sha256",
      "schema",
      "start_offset",
    ]);
    if (parseError.schema !== "synthia-m4f-jump-local-residue-parse-error.v1"
      || typeof parseError.error_id !== "string"
      || Buffer.byteLength(parseError.error_id, "utf8") < 1
      || Buffer.byteLength(parseError.error_id, "utf8") > 128
      || !/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(parseError.error_id)
      || !integer(parseError.start_offset, 0, TARGET_SOURCE_CHARACTER_LENGTH)
      || !integer(parseError.end_offset, parseError.start_offset, TARGET_SOURCE_CHARACTER_LENGTH)) {
      failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
    }
    validateMessage(parseError, "message_utf8_length", "message_utf8_sha256");
  }
  const expectedEvidenceCount = Math.min(payload.parse_error_count, MAX_PARSE_ERRORS);
  if (payload.parse_errors.length !== expectedEvidenceCount
    || payload.parse_errors_truncated !== (payload.parse_error_count > MAX_PARSE_ERRORS)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
  if (payload.target_scriptblock_constructed) {
    if (payload.scriptblock_create_exception !== null
      || payload.constructed_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
      || payload.constructed_extent_start_offset !== 0
      || payload.constructed_extent_end_offset !== TARGET_SOURCE_CHARACTER_LENGTH
      || payload.constructed_extent_character_length !== TARGET_SOURCE_CHARACTER_LENGTH
      || payload.constructed_extent_utf8_length !== RECEIVER_REPRESENTATION_ARTIFACT_LENGTH
      || payload.constructed_extent_sha256 !== RECEIVER_REPRESENTATION_ARTIFACT_SHA256) {
      failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
    }
  } else {
    if (payload.scriptblock_create_exception === null
      || payload.constructed_ast_type !== null
      || payload.constructed_extent_start_offset !== null
      || payload.constructed_extent_end_offset !== null
      || payload.constructed_extent_character_length !== null
      || payload.constructed_extent_utf8_length !== null
      || payload.constructed_extent_sha256 !== null) {
      failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
    }
    validateException(payload.scriptblock_create_exception);
  }
  const expectedStatus = payload.parse_error_count === 0 && payload.target_scriptblock_constructed
    ? "parsed_not_invoked"
    : "parse_rejected";
  if (payload.status !== expectedStatus) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID", "validation", null, null);
  }
  return expectedStatus;
}

function validatePhaseEvidence(observation: BoundJumpPhaseResult): void {
  const phase = objectValue(observation);
  exactKeys(phase, ["identity", "input", "master_after", "master_before", "payload", "phase", "process", "schema"]);
  const identity = objectValue(observation.identity);
  exactKeys(identity, ["computer_name", "identity_name", "identity_sid", "schema"]);
  const input = objectValue(observation.input);
  exactKeys(input, INPUT_KEYS);
  const expectedStdin = Buffer.from(
    `${Buffer.from(RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT, "utf8").toString("base64")}\n`,
    "ascii",
  );
  const expectedStdout = Buffer.from(
    `${JSON.stringify(observation.identity)}\r\n${JSON.stringify(observation.payload)}\r\n`,
    "utf8",
  ).toString("base64");
  validateProcess(observation.process, expectedStdout);
  const before = validateMaster(observation.master_before);
  const after = validateMaster(observation.master_after);
  if (observation.schema !== "synthia-m4f-bound-phase.v1"
    || observation.phase !== PHASE
    || identity.schema !== "synthia-m4f-jump-identity.v1"
    || identity.computer_name !== JUMP_COMPUTER
    || identity.identity_name !== JUMP_IDENTITY_NAME
    || identity.identity_sid !== JUMP_IDENTITY_SID
    || observation.input.artifact_length !== EXPECTED_ARTIFACT_LENGTH
    || observation.input.artifact_sha256 !== EXPECTED_ARTIFACT_SHA256
    || observation.input.stdin_length !== expectedStdin.length
    || observation.input.stdin_sha256 !== createHash("sha256").update(expectedStdin).digest("hex")
    || observation.input.receiver_source_length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH
    || observation.input.receiver_source_sha256 !== BOUND_JUMP_RECEIVER_SOURCE_SHA256
    || observation.input.receiver_encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH
    || observation.input.receiver_encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || observation.input.receiver_command_length !== BOUND_JUMP_RECEIVER_COMMAND_LENGTH
    || observation.input.receiver_command_maximum !== 8_192
    || JSON.stringify(before) !== JSON.stringify(after)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_EVIDENCE_INVALID", "validation", null, null);
  }
}

export interface ReceiverRepresentationParseGateDependencies {
  invokePhase(phase: string, artifact: string): BoundJumpPhaseResult;
}

export interface ReceiverRepresentationParseGateResult {
  schema: "synthia-m4f-jump-local-residue-parse-gate-ceremony.v1";
  status: "parsed_not_invoked";
  observation: BoundJumpPhaseResult;
}

const defaultDependencies: ReceiverRepresentationParseGateDependencies = {
  invokePhase: (phase, artifact) => invokeBoundJumpPhase(phase, artifact),
};

export function runReceiverRepresentationParseGate08(
  overrides: Partial<ReceiverRepresentationParseGateDependencies> = {},
): ReceiverRepresentationParseGateResult {
  assertReceiverRepresentationParseGateArtifactFrozen();
  if (process.env.SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_PARSE_GATE_CONFIRMATION !== CONFIRMATION) {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_CONFIRMATION_REQUIRED", "confirmation", null, null);
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  let observation: BoundJumpPhaseResult;
  try {
    observation = dependencies.invokePhase(PHASE, RECEIVER_REPRESENTATION_PARSE_GATE_ARTIFACT);
  } catch {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_TRANSPORT_FAILED", "transport", null, null);
  }
  let parseStatus: "parsed_not_invoked" | "parse_rejected";
  try {
    validatePhaseEvidence(observation);
    parseStatus = validatePayload(observation.payload);
  } catch {
    failure(
      "M4F_JUMP_LOCAL_RESIDUE_PARSE_OUTPUT_INVALID",
      "validation",
      observation,
      null,
    );
  }
  if (parseStatus === "parse_rejected") {
    failure("M4F_JUMP_LOCAL_RESIDUE_PARSE_REJECTED", "validation", observation, null);
  }
  return {
    schema: "synthia-m4f-jump-local-residue-parse-gate-ceremony.v1",
    status: "parsed_not_invoked",
    observation,
  };
}

if (import.meta.main) {
  runCeremony(() => {
    process.stdout.write(`${JSON.stringify(runReceiverRepresentationParseGate08())}\n`);
  });
}
