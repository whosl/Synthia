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

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_20260827_08";
const PHASE = "jump-local-receiver-representation-08:diagnose";
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

export const RECEIVER_REPRESENTATION_ARTIFACT = String.raw`
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$expectedComputer = "${JUMP_COMPUTER}"
$expectedIdentityName = "${JUMP_IDENTITY_NAME}"
$expectedIdentitySid = "${JUMP_IDENTITY_SID}"
$powershellPath = "${POWERSHELL_PATH}"
$expectedEncodedLength = ${BOUND_JUMP_RECEIVER_ENCODED_LENGTH}
$expectedEncodedSha256 = "${BOUND_JUMP_RECEIVER_ENCODED_SHA256}"
$maximumCommandBytes = ${MAX_COMMAND_BYTES}
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$strictUnicode = [Text.UnicodeEncoding]::new($false, $false, $true)

function Get-Sha([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-Count([string]$Value, [string]$Marker, [StringComparison]$Comparison) {
  $count = 0
  $offset = 0
  while ($offset -le $Value.Length) {
    $found = $Value.IndexOf($Marker, $offset, $Comparison)
    if ($found -lt 0) { break }
    $count += 1
    $offset = $found + $Marker.Length
  }
  return [int]$count
}

function Classify([string]$Executable, [string]$Command) {
  $executableClass = if ($Executable.Equals($powershellPath, [StringComparison]::Ordinal)) { "ordinal_exact" }
    elseif ($Executable.Equals($powershellPath, [StringComparison]::OrdinalIgnoreCase)) { "case_only" }
    else { "different" }
  $commandBytes = $strictUtf8.GetBytes($Command)
  $commandSha = Get-Sha $commandBytes
  $candidate = if ($commandBytes.Length -eq 3346 -and $commandSha -ceq "${COMMAND_PINS.basename_exact[1]}") { "basename_exact" }
    elseif ($commandBytes.Length -eq 3389 -and $commandSha -ceq "${COMMAND_PINS.fixed_exact[1]}") { "fixed_exact" }
    elseif ($commandBytes.Length -eq 3391 -and $commandSha -ceq "${COMMAND_PINS.quoted_exact[1]}") { "quoted_exact" }
    else { "none" }
  $marker = " -EncodedCommand "
  $exactMarkers = Get-Count $Command $marker ([StringComparison]::Ordinal)
  $ignoreCaseMarkers = Get-Count $Command $marker ([StringComparison]::OrdinalIgnoreCase)
  $markerClass = if ($exactMarkers -eq 1 -and $ignoreCaseMarkers -eq 1) { "exact" }
    elseif ($exactMarkers -eq 0 -and $ignoreCaseMarkers -eq 1) { "case_only" }
    elseif ($ignoreCaseMarkers -eq 0) { "missing" }
    else { "multiple" }
  $prefixClass = "other"
  $token = $null
  if ($ignoreCaseMarkers -eq 1) {
    $markerOffset = $Command.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase)
    $prefix = $Command.Substring(0, $markerOffset)
    $token = $Command.Substring($markerOffset + $marker.Length)
    $tail = " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass"
    $prefixes = @(
      [ordered]@{ name = "basename"; value = "powershell.exe" + $tail },
      [ordered]@{ name = "fixed"; value = $powershellPath + $tail },
      [ordered]@{ name = "quoted"; value = '"' + $powershellPath + '"' + $tail }
    )
    foreach ($item in $prefixes) {
      if ($prefix.Equals([string]$item.value, [StringComparison]::Ordinal)) { $prefixClass = [string]$item.name + "_exact"; break }
      if ($prefix.Equals([string]$item.value, [StringComparison]::OrdinalIgnoreCase)) { $prefixClass = [string]$item.name + "_case_only"; break }
    }
    if ($prefixClass -ceq "other" -and ($prefix.StartsWith("powershell.exe", [StringComparison]::OrdinalIgnoreCase) -or
      $prefix.StartsWith($powershellPath, [StringComparison]::OrdinalIgnoreCase) -or
      $prefix.StartsWith('"' + $powershellPath + '"', [StringComparison]::OrdinalIgnoreCase))) { $prefixClass = "separator_drift" }
  }
  $tokenShape = "missing"
  $lengthMatches = $false
  $shaMatches = $false
  $canonical = $false
  $roundtrip = $false
  if ($null -ne $token -and $token.Length -gt 0) {
    $ascii = $true
    $whitespace = $false
    foreach ($character in $token.ToCharArray()) {
      if ([int][char]$character -gt 127) { $ascii = $false }
      if ([char]::IsWhiteSpace($character)) { $whitespace = $true }
    }
    if (-not $ascii) { $tokenShape = "non_ascii" }
    elseif ($whitespace) { $tokenShape = "whitespace" }
    elseif (-not [Text.RegularExpressions.Regex]::IsMatch($token, '\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z', [Text.RegularExpressions.RegexOptions]::CultureInvariant)) { $tokenShape = "invalid_base64" }
    else {
      $tokenShape = "base64_shape"
      $tokenBytes = [Text.Encoding]::ASCII.GetBytes($token)
      $lengthMatches = $tokenBytes.Length -eq $expectedEncodedLength
      $shaMatches = (Get-Sha $tokenBytes) -ceq $expectedEncodedSha256
      try {
        $decoded = [Convert]::FromBase64String($token)
        $canonical = [Convert]::ToBase64String($decoded) -ceq $token
        if ($canonical) { $source = $strictUnicode.GetString($decoded); $roundtrip = $strictUnicode.GetBytes($source).Length -eq $decoded.Length }
      } catch { $canonical = $false; $roundtrip = $false }
    }
  }
  $stage = if ($executableClass -cne "ordinal_exact") { "executable" }
    elseif ($markerClass -cne "exact") { "marker" }
    elseif ($prefixClass -notin @("basename_exact", "fixed_exact", "quoted_exact")) { "prefix" }
    elseif ($tokenShape -cne "base64_shape") { "token_shape" }
    elseif (-not $lengthMatches) { "encoded_length" }
    elseif (-not $shaMatches) { "encoded_hash" }
    elseif (-not $canonical) { "canonical_base64" }
    elseif (-not $roundtrip) { "utf16le_roundtrip" }
    else { "none" }
  return [ordered]@{
    schema = "synthia-m4f-receiver-representation-classification.v1"
    executable = $executableClass
    command_candidate = $candidate
    marker = $markerClass
    prefix = $prefixClass
    token_shape = $tokenShape
    encoded_length_matches = [bool]$lengthMatches
    encoded_sha256_matches = [bool]$shaMatches
    canonical_base64 = [bool]$canonical
    utf16le_roundtrip = [bool]$roundtrip
    earliest_mismatch_stage = $stage
  }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ([Environment]::MachineName -cne $expectedComputer -or $identity.Name.ToLowerInvariant() -cne $expectedIdentityName -or
  $identity.User.Value -cne $expectedIdentitySid -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "M4F_RECEIVER_REPRESENTATION_IDENTITY_INVALID"
}
$selfPid = [uint32]$PID
if ($selfPid -lt 1) { throw "M4F_RECEIVER_REPRESENTATION_PID_INVALID" }
$queryText = "SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId=" + $selfPid.ToString([Globalization.CultureInfo]::InvariantCulture)
$clock = [Diagnostics.Stopwatch]::StartNew()
$failureCode = $null
$rows = @()
try { $rows = @(Get-CimInstance -Query $queryText -OperationTimeoutSec 10 -ErrorAction Stop) }
catch { $failureCode = "query_failed" }
$clock.Stop()
if ($rows.Count -gt 2) { throw "M4F_RECEIVER_REPRESENTATION_CARDINALITY_BOUND" }
if ($null -eq $failureCode -and $rows.Count -ne 1) { $failureCode = "cardinality" }
$actual = [ordered]@{ schema = "synthia-m4f-receiver-representation-actual.v1"; returned_count = [int]$rows.Count; executable_path = $null; command_present = $false; command_utf8_length = $null; command_sha256 = $null }
$classification = $null
if ($rows.Count -eq 1) {
  $row = $rows[0]
  if ($row.ProcessId -isnot [uint32] -or [uint32]$row.ProcessId -ne $selfPid) { $failureCode = "pid_binding" }
  elseif ($null -eq $row.ExecutablePath -or $null -eq $row.CommandLine) { $failureCode = "missing_property" }
  else {
    $executable = [string]$row.ExecutablePath
    $executableBytes = $strictUtf8.GetBytes($executable)
    if ($executableBytes.Length -lt 1 -or $executableBytes.Length -gt 1024 -or $executable -notmatch '\A[A-Za-z]:\\[^\x00-\x1f\x7f]+\.exe\z') { $failureCode = "unsafe_executable" }
    else {
      $actual.executable_path = $executable
      $command = [string]$row.CommandLine
      $commandBytes = $strictUtf8.GetBytes($command)
      if ($commandBytes.Length -lt 1) { $failureCode = "missing_command" }
      elseif ($commandBytes.Length -gt $maximumCommandBytes) { $failureCode = "command_bound" }
      else {
        $actual.command_present = $true
        $actual.command_utf8_length = [int]$commandBytes.Length
        $actual.command_sha256 = Get-Sha $commandBytes
        $classification = Classify $executable $command
      }
    }
  }
}
$status = if ($null -ne $failureCode) { "indeterminate" } elseif ($classification.earliest_mismatch_stage -ceq "none") { "representation_match" } else { "representation_mismatch" }
$output = [ordered]@{
  schema = "synthia-m4f-current-receiver-representation-diagnostic.v1"
  status = $status
  scope = "current_pid_exact_cim_only"
  residue_state_evaluated = $false
  provider_activation_may_create_processes = $true
  failure_code = $failureCode
  query = [ordered]@{ schema = "synthia-m4f-receiver-representation-query.v1"; returned_count = [int]$rows.Count; elapsed_ticks = [int64]$clock.ElapsedTicks; stopwatch_frequency = [int64][Diagnostics.Stopwatch]::Frequency }
  expected = [ordered]@{
    schema = "synthia-m4f-receiver-representation-expected.v1"
    executable_path = $powershellPath
    encoded_length = $expectedEncodedLength
    encoded_sha256 = $expectedEncodedSha256
    basename_command_length = 3346
    basename_command_sha256 = "${COMMAND_PINS.basename_exact[1]}"
    fixed_command_length = 3389
    fixed_command_sha256 = "${COMMAND_PINS.fixed_exact[1]}"
    quoted_command_length = 3391
    quoted_command_sha256 = "${COMMAND_PINS.quoted_exact[1]}"
  }
  actual = $actual
  classification = $classification
}
$json = $output | ConvertTo-Json -Depth 5 -Compress
if ($strictUtf8.GetByteCount($json) -gt 1048576) { throw "M4F_RECEIVER_REPRESENTATION_OUTPUT_BOUND" }
[Console]::Out.WriteLine($json)
`;

export const RECEIVER_REPRESENTATION_ARTIFACT_LENGTH = Buffer.byteLength(RECEIVER_REPRESENTATION_ARTIFACT, "utf8");
export const RECEIVER_REPRESENTATION_ARTIFACT_SHA256 = createHash("sha256").update(RECEIVER_REPRESENTATION_ARTIFACT).digest("hex");
const EXPECTED_ARTIFACT_LENGTH = 10_044;
const EXPECTED_ARTIFACT_SHA256 = "c5f1205e69c559dd1c20f1a1c03322080acdb2741c53e8e1b2887fc05a96285c";
if (RECEIVER_REPRESENTATION_ARTIFACT_LENGTH !== EXPECTED_ARTIFACT_LENGTH
  || RECEIVER_REPRESENTATION_ARTIFACT_SHA256 !== EXPECTED_ARTIFACT_SHA256) {
  throw new Error("M4F_RECEIVER_REPRESENTATION_ARTIFACT_DRIFT");
}

export function assertReceiverRepresentationArtifactFrozen(length = RECEIVER_REPRESENTATION_ARTIFACT_LENGTH, sha = RECEIVER_REPRESENTATION_ARTIFACT_SHA256): void {
  if (length !== EXPECTED_ARTIFACT_LENGTH || sha !== EXPECTED_ARTIFACT_SHA256) throw new Error("M4F_RECEIVER_REPRESENTATION_ARTIFACT_DRIFT");
}

function failure(code: string, stage: string, observation: BoundJumpPhaseResult | null): never {
  throw new CeremonyFailure({ schema: "synthia-m4f-receiver-representation-failure.v1", code, current_stage: stage, retry_permitted: false, observation, cause: null });
}
function rec(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, expected: readonly string[]): void { if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null); }
function int(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function base64(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= maximumBytes && bytes.toString("base64") === value;
}

const PROCESS_KEYS = ["error_code", "exit_status", "outcome_ambiguous", "retry_permitted", "signal", "stderr_base64", "stdout_base64", "timed_out"] as const;
const INPUT_KEYS = ["artifact_length", "artifact_sha256", "receiver_command_length", "receiver_command_maximum", "receiver_encoded_length", "receiver_encoded_sha256", "receiver_source_length", "receiver_source_sha256", "stdin_length", "stdin_sha256"] as const;
const MASTER_KEYS = ["child_effective_config_sha256", "host_key_fingerprint", "known_hosts_path", "master_effective_config_sha256", "master_pid", "master_socket", "network_connection", "network_process", "network_sha256", "schema", "ssh_executable"] as const;
const CONNECTION_KEYS = ["fd", "local_address", "local_port", "protocol", "remote_address", "remote_port", "state"] as const;

function validateProcess(value: unknown, expectedStdout: string | null): void {
  const process = rec(value);
  keys(process, PROCESS_KEYS);
  if (process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || !base64(process.stdout_base64, 8 * 1024 * 1024) || process.stderr_base64 !== ""
    || process.timed_out !== false || process.outcome_ambiguous !== false || process.retry_permitted !== false
    || (expectedStdout !== null && process.stdout_base64 !== expectedStdout)) failure("M4F_RECEIVER_REPRESENTATION_EVIDENCE_INVALID", "validation", null);
}

function validateMaster(value: unknown): Record<string, unknown> {
  const master = rec(value);
  keys(master, MASTER_KEYS);
  const connection = rec(master.network_connection);
  keys(connection, CONNECTION_KEYS);
  validateProcess(master.network_process, null);
  const networkProcess = rec(master.network_process);
  const networkBytes = Buffer.from(networkProcess.stdout_base64 as string, "base64");
  const networkMatch = /^p87062\ncssh\nf(\d+)\ntIPv4\nPTCP\nn100\.123\.31\.75:(\d+)->100\.66\.198\.60:22\nTST=ESTABLISHED\nTQR=0\nTQS=0\n$/u
    .exec(networkBytes.toString("ascii"));
  const networkFd = Number(networkMatch?.[1]);
  const networkPort = Number(networkMatch?.[2]);
  if (master.schema !== "synthia-m4f-bound-master-audit.v1" || master.master_pid !== 87_062
    || master.master_socket !== "/private/tmp/synthia-m4f-jump.sock" || master.known_hosts_path !== "/Users/wenzhuolin/.ssh/known_hosts"
    || master.host_key_fingerprint !== "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8" || master.ssh_executable !== "/usr/bin/ssh"
    || master.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256 || master.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256
    || master.network_sha256 !== MASTER_NETWORK_SHA256 || createHash("sha256").update(networkBytes).digest("hex") !== master.network_sha256
    || !networkMatch || !int(networkFd, 0, 1_048_575) || connection.fd !== networkFd || connection.protocol !== "TCP"
    || connection.local_address !== "100.123.31.75" || !int(networkPort, 49_152, 65_535) || connection.local_port !== networkPort
    || connection.remote_address !== "100.66.198.60" || connection.remote_port !== 22 || connection.state !== "ESTABLISHED") failure("M4F_RECEIVER_REPRESENTATION_EVIDENCE_INVALID", "validation", null);
  return master;
}

const EXEC = ["ordinal_exact", "case_only", "different"] as const;
const CAND = ["basename_exact", "fixed_exact", "quoted_exact", "none"] as const;
const MARK = ["exact", "case_only", "missing", "multiple"] as const;
const PREFIX = ["basename_exact", "basename_case_only", "fixed_exact", "fixed_case_only", "quoted_exact", "quoted_case_only", "separator_drift", "other"] as const;
const TOKEN = ["missing", "non_ascii", "whitespace", "invalid_base64", "base64_shape"] as const;
const STAGE = ["executable", "marker", "prefix", "token_shape", "encoded_length", "encoded_hash", "canonical_base64", "utf16le_roundtrip", "none"] as const;

function validatePayload(payload: Record<string, unknown>): void {
  keys(payload, ["actual", "classification", "expected", "failure_code", "provider_activation_may_create_processes", "query", "residue_state_evaluated", "schema", "scope", "status"]);
  if (payload.schema !== "synthia-m4f-current-receiver-representation-diagnostic.v1" || !["representation_match", "representation_mismatch", "indeterminate"].includes(payload.status as string)
    || payload.scope !== "current_pid_exact_cim_only" || payload.residue_state_evaluated !== false || payload.provider_activation_may_create_processes !== true
    || (payload.failure_code !== null && !["query_failed", "cardinality", "pid_binding", "missing_property", "unsafe_executable", "missing_command", "command_bound"].includes(payload.failure_code as string))) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  const query = rec(payload.query); keys(query, ["elapsed_ticks", "returned_count", "schema", "stopwatch_frequency"]);
  if (query.schema !== "synthia-m4f-receiver-representation-query.v1" || !int(query.returned_count, 0, 2) || !int(query.elapsed_ticks, 0, Number.MAX_SAFE_INTEGER) || !int(query.stopwatch_frequency, 1, Number.MAX_SAFE_INTEGER)) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  const expected = rec(payload.expected); keys(expected, ["basename_command_length", "basename_command_sha256", "encoded_length", "encoded_sha256", "executable_path", "fixed_command_length", "fixed_command_sha256", "quoted_command_length", "quoted_command_sha256", "schema"]);
  if (expected.schema !== "synthia-m4f-receiver-representation-expected.v1" || expected.executable_path !== POWERSHELL_PATH || expected.encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH || expected.encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || expected.basename_command_length !== COMMAND_PINS.basename_exact[0] || expected.basename_command_sha256 !== COMMAND_PINS.basename_exact[1] || expected.fixed_command_length !== COMMAND_PINS.fixed_exact[0] || expected.fixed_command_sha256 !== COMMAND_PINS.fixed_exact[1]
    || expected.quoted_command_length !== COMMAND_PINS.quoted_exact[0] || expected.quoted_command_sha256 !== COMMAND_PINS.quoted_exact[1]) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  const actual = rec(payload.actual); keys(actual, ["command_present", "command_sha256", "command_utf8_length", "executable_path", "returned_count", "schema"]);
  if (actual.schema !== "synthia-m4f-receiver-representation-actual.v1" || actual.returned_count !== query.returned_count || typeof actual.command_present !== "boolean"
    || (actual.executable_path !== null && (typeof actual.executable_path !== "string" || Buffer.byteLength(actual.executable_path, "utf8") > 1024 || !/^[A-Za-z]:\\[^\u0000-\u001f\u007f]+\.exe$/u.test(actual.executable_path)))) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  if (actual.command_present ? (!int(actual.command_utf8_length, 1, MAX_COMMAND_BYTES) || !hash(actual.command_sha256)) : (actual.command_utf8_length !== null || actual.command_sha256 !== null)) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  if (payload.failure_code !== null) {
    const code = payload.failure_code as string;
    const countMatches = code === "query_failed" ? query.returned_count === 0
      : code === "cardinality" ? query.returned_count === 0 || query.returned_count === 2
        : query.returned_count === 1;
    const executableMatches = ["missing_command", "command_bound"].includes(code)
      ? actual.executable_path !== null : actual.executable_path === null;
    if (payload.status !== "indeterminate" || payload.classification !== null || !countMatches
      || !executableMatches || actual.command_present !== false) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
    return;
  }
  const classification = rec(payload.classification); keys(classification, ["canonical_base64", "command_candidate", "earliest_mismatch_stage", "encoded_length_matches", "encoded_sha256_matches", "executable", "marker", "prefix", "schema", "token_shape", "utf16le_roundtrip"]);
  if (classification.schema !== "synthia-m4f-receiver-representation-classification.v1" || !EXEC.includes(classification.executable as typeof EXEC[number]) || !CAND.includes(classification.command_candidate as typeof CAND[number])
    || !MARK.includes(classification.marker as typeof MARK[number]) || !PREFIX.includes(classification.prefix as typeof PREFIX[number]) || !TOKEN.includes(classification.token_shape as typeof TOKEN[number]) || !STAGE.includes(classification.earliest_mismatch_stage as typeof STAGE[number])
    || ["encoded_length_matches", "encoded_sha256_matches", "canonical_base64", "utf16le_roundtrip"].some((k) => typeof classification[k] !== "boolean")) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  const earliest = classification.executable !== "ordinal_exact" ? "executable" : classification.marker !== "exact" ? "marker" : !["basename_exact", "fixed_exact", "quoted_exact"].includes(classification.prefix as string) ? "prefix"
    : classification.token_shape !== "base64_shape" ? "token_shape" : !classification.encoded_length_matches ? "encoded_length" : !classification.encoded_sha256_matches ? "encoded_hash" : !classification.canonical_base64 ? "canonical_base64" : !classification.utf16le_roundtrip ? "utf16le_roundtrip" : "none";
  if (classification.earliest_mismatch_stage !== earliest || payload.status !== (earliest === "none" ? "representation_match" : "representation_mismatch") || query.returned_count !== 1 || !actual.command_present || actual.executable_path === null) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
  const executable = actual.executable_path as string;
  const executableClass = executable === POWERSHELL_PATH ? "ordinal_exact" : executable.toLowerCase() === POWERSHELL_PATH.toLowerCase() ? "case_only" : "different";
  const commandCandidate = (Object.entries(COMMAND_PINS) as Array<[keyof typeof COMMAND_PINS, readonly [number, string]]>)
    .find(([, pin]) => actual.command_utf8_length === pin[0] && actual.command_sha256 === pin[1])?.[0] ?? "none";
  const candidatePrefix = commandCandidate === "basename_exact" ? "basename_exact" : commandCandidate === "fixed_exact" ? "fixed_exact" : commandCandidate === "quoted_exact" ? "quoted_exact" : null;
  const commandContractExact = classification.marker === "exact"
    && ["basename_exact", "fixed_exact", "quoted_exact"].includes(classification.prefix as string)
    && classification.token_shape === "base64_shape" && classification.encoded_length_matches === true
    && classification.encoded_sha256_matches === true && classification.canonical_base64 === true
    && classification.utf16le_roundtrip === true;
  if (classification.executable !== executableClass || classification.command_candidate !== commandCandidate
    || (candidatePrefix !== null) !== commandContractExact
    || (candidatePrefix !== null && classification.prefix !== candidatePrefix)
    || (classification.token_shape !== "base64_shape" && (classification.encoded_length_matches || classification.encoded_sha256_matches || classification.canonical_base64 || classification.utf16le_roundtrip))
    || (!classification.canonical_base64 && classification.utf16le_roundtrip)
    || (["missing", "multiple"].includes(classification.marker as string) && (classification.prefix !== "other" || classification.token_shape !== "missing" || classification.encoded_length_matches || classification.encoded_sha256_matches || classification.canonical_base64 || classification.utf16le_roundtrip))) failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", null);
}

function validatePhase(observation: BoundJumpPhaseResult): void {
  const phase = rec(observation);
  keys(phase, ["identity", "input", "master_after", "master_before", "payload", "phase", "process", "schema"]);
  const identity = rec(observation.identity);
  keys(identity, ["computer_name", "identity_name", "identity_sid", "schema"]);
  const input = rec(observation.input);
  keys(input, INPUT_KEYS);
  const stdout = Buffer.from(`${JSON.stringify(observation.identity)}\r\n${JSON.stringify(observation.payload)}\r\n`).toString("base64");
  const stdin = Buffer.from(`${Buffer.from(RECEIVER_REPRESENTATION_ARTIFACT).toString("base64")}\n`, "ascii");
  validateProcess(observation.process, stdout);
  const before = validateMaster(observation.master_before);
  const after = validateMaster(observation.master_after);
  if (observation.schema !== "synthia-m4f-bound-phase.v1" || observation.phase !== PHASE || observation.identity.schema !== "synthia-m4f-jump-identity.v1" || observation.identity.computer_name !== JUMP_COMPUTER
    || observation.identity.identity_name !== JUMP_IDENTITY_NAME || observation.identity.identity_sid !== JUMP_IDENTITY_SID
    || observation.input.artifact_length !== EXPECTED_ARTIFACT_LENGTH || observation.input.artifact_sha256 !== EXPECTED_ARTIFACT_SHA256 || observation.input.stdin_length !== stdin.length || observation.input.stdin_sha256 !== createHash("sha256").update(stdin).digest("hex")
    || observation.input.receiver_source_length !== BOUND_JUMP_RECEIVER_SOURCE_LENGTH || observation.input.receiver_source_sha256 !== BOUND_JUMP_RECEIVER_SOURCE_SHA256 || observation.input.receiver_encoded_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH
    || observation.input.receiver_encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256 || observation.input.receiver_command_length !== BOUND_JUMP_RECEIVER_COMMAND_LENGTH || observation.input.receiver_command_maximum !== 8_192
    || JSON.stringify(before) !== JSON.stringify(after)) failure("M4F_RECEIVER_REPRESENTATION_EVIDENCE_INVALID", "validation", null);
}

export interface ReceiverRepresentationDependencies { invokePhase(phase: string, artifact: string): BoundJumpPhaseResult }
const defaults: ReceiverRepresentationDependencies = { invokePhase: (phase, artifact) => invokeBoundJumpPhase(phase, artifact) };
export function runReceiverRepresentationDiagnostic08(overrides: Partial<ReceiverRepresentationDependencies> = {}): { schema: "synthia-m4f-receiver-representation-ceremony.v1"; status: "observed"; observation: BoundJumpPhaseResult } {
  assertReceiverRepresentationArtifactFrozen();
  if (process.env.SYNTHIA_M4F_JUMP_LOCAL_RECEIVER_REPRESENTATION_CONFIRMATION !== CONFIRMATION) failure("M4F_RECEIVER_REPRESENTATION_CONFIRMATION_REQUIRED", "confirmation", null);
  let observation: BoundJumpPhaseResult;
  try { observation = { ...defaults, ...overrides }.invokePhase(PHASE, RECEIVER_REPRESENTATION_ARTIFACT); } catch { failure("M4F_RECEIVER_REPRESENTATION_TRANSPORT_FAILED", "transport", null); }
  try { validatePhase(observation); validatePayload(observation.payload); } catch { failure("M4F_RECEIVER_REPRESENTATION_OUTPUT_INVALID", "validation", observation); }
  return { schema: "synthia-m4f-receiver-representation-ceremony.v1", status: "observed", observation };
}
if (import.meta.main) runCeremony(() => process.stdout.write(`${JSON.stringify(runReceiverRepresentationDiagnostic08())}\n`));
