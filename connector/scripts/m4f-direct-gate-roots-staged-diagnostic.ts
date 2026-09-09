import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE,
  auditDirectSshEffectiveConfig,
  buildDirectPowerShellStdinCommand,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  type LocalInputFact,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
  validateM4fDirectAdmissionConfig,
} from "./m4f-gate-admission-transport.ts";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LOCAL_DEADLINE_MS = 30_000;
const REMOTE_COOPERATIVE_DEADLINE_SECONDS = 20;
const TARGET_HOST = "100.96.223.49";
const STAGES = [
  "identity",
  "start_observation",
  "volume_c",
  "volume_d",
  "target_existence",
  "ancestors_gate",
  "ancestors_backing",
  "root_acl_template",
  "stream_probe",
  "end_observation",
] as const;

export interface M4fGateRootsStagedDiagnosticConfig {
  schema: "synthia-m4f-direct-gate-roots-staged-diagnostic-config.v1";
  diagnostic_id: string;
  gate_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  candidate09_diagnostic_sha256: string;
  candidate09_started_at_utc: string;
  candidate09_ended_at_utc: string;
  expected_gate_roots_source_sha256: string;
  expected_diagnostic_source_sha256: string;
  expected_test_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface StagedDiagnosticDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  testSourceBytes(): Buffer;
  gateRootsSourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): LocalInputFact[];
}

export interface StagedRecordDependencies extends StagedDiagnosticDependencies {
  admissionConfigBytes(path: string): Buffer;
}

interface StagedExecutionObserver {
  transportInputs(label: "initial" | "pre_remote" | "post_remote", facts: LocalInputFact[]): void;
  effective(process: RawProcessResult): void;
  remotePrepared(script: Buffer): void;
  remote(process: RawProcessResult): void;
  markers(markers: StagedMarker[]): void;
}

export interface StagedMarker {
  schema: "synthia-m4f-direct-gate-roots-staged-marker.v1";
  diagnostic_id: string;
  ordinal: number;
  stage: typeof STAGES[number] | "complete";
  phase: "begin" | "end" | "complete";
  status: "started" | "observed" | "failed" | "complete";
  observed_at_utc: string;
  payload: Record<string, unknown> | null;
  error: string | null;
}

export interface StagedExecutionResult {
  process: RawProcessResult;
  markers: StagedMarker[];
  complete: boolean;
  remote_state: "observed" | "partial_unknown";
}

interface StagedProcessEvidence {
  exit_status: number | null;
  signal: string | null;
  error_code: string | null;
  timed_out: boolean;
  stdin_length: number;
  stdin_sha256: string;
  stdout_length: number;
  stdout_sha256: string;
  stderr_length: number;
  stderr_sha256: string;
  retry_permitted: false;
}

const CONFIG_KEYS = [
  "admission_config_path",
  "admission_config_sha256",
  "candidate09_diagnostic_sha256",
  "candidate09_ended_at_utc",
  "candidate09_started_at_utc",
  "diagnostic_id",
  "expected_diagnostic_source_sha256",
  "expected_effective_config_sha256",
  "expected_gate_roots_source_sha256",
  "expected_test_source_sha256",
  "expected_transport_source_sha256",
  "gate_id",
  "schema",
] as const;
const MARKER_KEYS = [
  "diagnostic_id", "error", "observed_at_utc", "ordinal", "payload", "phase",
  "schema", "stage", "status",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function processEvidence(process: RawProcessResult, stdin: Buffer): StagedProcessEvidence {
  return {
    exit_status: process.status,
    signal: process.signal,
    error_code: process.errorCode,
    timed_out: process.errorCode === "ETIMEDOUT",
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: process.stdout.length,
    stdout_sha256: sha256(process.stdout),
    stderr_length: process.stderr.length,
    stderr_sha256: sha256(process.stderr),
    retry_permitted: false,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function isCanonicalUtc(value: unknown): value is string {
  return typeof value === "string"
    && CANONICAL_UTC.test(value)
    && new Date(value).toISOString() === value;
}

export function validateGateRootsStagedDiagnosticConfig(value: unknown): M4fGateRootsStagedDiagnosticConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-gate-roots-staged-diagnostic-config.v1"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || typeof config.gate_id !== "string" || !SAFE_ID.test(config.gate_id)
    || typeof config.admission_config_path !== "string" || !config.admission_config_path.startsWith("/")
    || /[\r\n\0]/u.test(config.admission_config_path)
    || !isCanonicalUtc(config.candidate09_started_at_utc)
    || !isCanonicalUtc(config.candidate09_ended_at_utc)
    || config.candidate09_started_at_utc >= config.candidate09_ended_at_utc
    || [
      config.admission_config_sha256,
      config.candidate09_diagnostic_sha256,
      config.expected_gate_roots_source_sha256,
      config.expected_diagnostic_source_sha256,
      config.expected_test_source_sha256,
      config.expected_transport_source_sha256,
      config.expected_effective_config_sha256,
    ].some((item) => typeof item !== "string" || !HASH.test(item))) {
    throw new Error("M4F_GATE_ROOTS_STAGED_CONFIG_INVALID");
  }
  return value as M4fGateRootsStagedDiagnosticConfig;
}

export function buildGateRootsStagedRemoteScript(
  rawConfig: unknown,
  rawAdmission: unknown,
): string {
  const config = validateGateRootsStagedDiagnosticConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  const gateRoot = "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id;
  const backingRoot = "D:\\synthia-m4f-toolchain-" + config.gate_id;
  const wrapperCommand = buildDirectPowerShellStdinCommand();
  const wrapperTail = wrapperCommand.slice("powershell.exe".length);
  const wrapperHashes = [
    sha256(wrapperCommand.toLowerCase()),
    sha256(('"powershell.exe"' + wrapperTail).toLowerCase()),
  ];
  return [
    "Set-StrictMode -Version Latest",
    "$ErrorActionPreference=\"Stop\"; $ProgressPreference=\"SilentlyContinue\"; $WarningPreference=\"SilentlyContinue\"",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "$diagnosticId=" + psLiteral(config.diagnostic_id),
    "$gateRoot=" + psLiteral(gateRoot) + "; $backingRoot=" + psLiteral(backingRoot),
    "$expectedComputer=" + psLiteral(admission.target.computer_name) + "; $expectedIdentityName=" + psLiteral(admission.target.identity_name) + "; $expectedIdentitySid=" + psLiteral(admission.target.identity_sid),
    "$candidate09DiagnosticSha256=" + psLiteral(config.candidate09_diagnostic_sha256),
    "$candidate09StartedAtUtc=[DateTimeOffset]::Parse(" + psLiteral(config.candidate09_started_at_utc) + ").UtcDateTime; $candidate09EndedAtUtc=[DateTimeOffset]::Parse(" + psLiteral(config.candidate09_ended_at_utc) + ").UtcDateTime",
    "$candidate09WrapperHashes=@(" + wrapperHashes.map(psLiteral).join(",") + ")",
    "$remoteDeadline=[DateTime]::UtcNow.AddSeconds(" + REMOTE_COOPERATIVE_DEADLINE_SECONDS + ")",
    "$ordinal=0; $failedStageCount=0",
    "function Hash-Text([string]$Value) { if ($null -eq $Value) { return $null }; $sha=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())))).Replace(\"-\",\"\").ToLowerInvariant() } finally { $sha.Dispose() } }",
    "function Emit([string]$Stage,[string]$Phase,[string]$Status,[object]$Payload,[string]$Error) { $script:ordinal+=1; $marker=[ordered]@{schema=\"synthia-m4f-direct-gate-roots-staged-marker.v1\";diagnostic_id=$diagnosticId;ordinal=$script:ordinal;stage=$Stage;phase=$Phase;status=$Status;observed_at_utc=[DateTime]::UtcNow.ToString(\"o\");payload=$Payload;error=$Error};[Console]::Out.WriteLine(($marker|ConvertTo-Json -Compress -Depth 14));[Console]::Out.Flush() }",
    "function Check-Deadline { if ([DateTime]::UtcNow -ge $remoteDeadline) { throw \"M4F_GATE_ROOTS_STAGED_REMOTE_DEADLINE\" } }",
    "function Stage([string]$Name,[scriptblock]$Action) { Emit $Name \"begin\" \"started\" ([ordered]@{remote_deadline_utc=$remoteDeadline.ToString(\"o\");remote_self_deadline=\"cooperative_boundary_only\";synchronous_call_cancellation=\"UNKNOWN\"}) $null; try { Check-Deadline; $value=& $Action; Check-Deadline; Emit $Name \"end\" \"observed\" $value $null; return $value } catch { $message=$_.Exception.Message; Emit $Name \"end\" \"failed\" ([ordered]@{remote_self_deadline=\"cooperative_boundary_only\";synchronous_call_cancellation=\"UNKNOWN\"}) $message; if ($message -ceq \"M4F_GATE_ROOTS_STAGED_REMOTE_DEADLINE\") { throw }; $script:failedStageCount+=1; return $null } }",
    "function Process-Observation { $rows=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='conhost.exe' OR Name='sshd.exe'\" -ErrorAction Stop | ForEach-Object { $commandHash=Hash-Text ([string]$_.CommandLine);$created=if($null -eq $_.CreationDate){$null}else{([DateTime]$_.CreationDate).ToUniversalTime()}; [ordered]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;name=([string]$_.Name).ToLowerInvariant();start_token=if($null -eq $created){$null}else{$created.ToString(\"o\")};command_line_present=-not [string]::IsNullOrEmpty([string]$_.CommandLine);command_line_sha256=$commandHash;candidate09_wrapper_hash_match=[bool]($null -ne $commandHash -and $candidate09WrapperHashes -ccontains $commandHash);candidate09_start_window_match=[bool]($null -ne $created -and $created -ge $candidate09StartedAtUtc -and $created -le $candidate09EndedAtUtc);current_diagnostic=[bool]([int]$_.ProcessId -eq $PID)} } | Sort-Object pid); $possiblePowerShellPids=@($rows|Where-Object{$_.name -ceq \"powershell.exe\" -and $_.candidate09_start_window_match -and -not $_.current_diagnostic}|ForEach-Object{$_.pid}); $possiblePowerShellParentPids=@($rows|Where-Object{$possiblePowerShellPids -contains $_.pid}|ForEach-Object{$_.parent_pid}); $facts=@($rows|ForEach-Object{ $possible=[bool](($_.name -ceq \"powershell.exe\" -and $possiblePowerShellPids -contains $_.pid) -or ($_.name -ceq \"conhost.exe\" -and $possiblePowerShellPids -contains $_.parent_pid) -or ($_.name -ceq \"sshd.exe\" -and $possiblePowerShellParentPids -contains $_.pid)); [ordered]@{pid=$_.pid;parent_pid=$_.parent_pid;name=$_.name;start_token=$_.start_token;command_line_present=$_.command_line_present;command_line_sha256=$_.command_line_sha256;candidate09_wrapper_hash_match=$_.candidate09_wrapper_hash_match;candidate09_start_window_match=$_.candidate09_start_window_match;candidate09_possible=$possible;current_diagnostic=$_.current_diagnostic}}); return [ordered]@{candidate09_diagnostic_sha256=$candidate09DiagnosticSha256;candidate09_started_at_utc=$candidate09StartedAtUtc.ToString(\"o\");candidate09_ended_at_utc=$candidate09EndedAtUtc.ToString(\"o\");candidate09_attribution=\"possible_not_proven\";candidate09_primary_match=\"powershell_start_window_plus_parent_child_chain\";wrapper_hash_role=\"supporting_not_required\";rows=$facts;candidate09_possible_count=@($facts|Where-Object{$_.candidate09_possible}).Count;raw_command_line_returned=$false} }",
    "function Volume-Fact([string]$Root,[int64]$MinimumFree) { $device=$Root.TrimEnd('\\'); $logical=@(Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='\"+$device+\"'\") -ErrorAction Stop); if ($logical.Count -ne 1 -or [int]$logical[0].DriveType -ne 3 -or [string]$logical[0].FileSystem -cne \"NTFS\" -or [int64]$logical[0].FreeSpace -lt $MinimumFree -or [string]::IsNullOrWhiteSpace([string]$logical[0].VolumeSerialNumber)) { throw \"M4F_GATE_ROOTS_STAGED_VOLUME_INVALID\" }; $volume=Get-Volume -DriveLetter $device.Substring(0,1) -ErrorAction Stop; $partition=Get-Partition -DriveLetter $device.Substring(0,1) -ErrorAction Stop; $disk=$partition|Get-Disk; return [ordered]@{root=$Root;device_id=$device;free_bytes=[int64]$logical[0].FreeSpace;logical_volume_serial=[string]$logical[0].VolumeSerialNumber;volume_unique_id=[string]$volume.UniqueId;disk_number=[int]$partition.DiskNumber;partition_number=[int]$partition.PartitionNumber;disk_unique_id=[string]$disk.UniqueId} }",
    "$administratorsSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-32-544\");$systemSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-18\");$serviceSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-19\");$trustedInstallerSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464\")",
    "function Ancestors([string]$Path,[string]$Root,[bool]$StrictAcl) { $current=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force; $facts=@(); while($null -ne $current){if(-not($current -is [IO.DirectoryInfo])-or(($current.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0)){throw \"M4F_GATE_ROOTS_STAGED_ANCESTOR_TYPE_INVALID\"};$acl=Get-Acl -LiteralPath $current.FullName;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]);if(-not($owner -is [Security.Principal.SecurityIdentifier])){throw \"M4F_GATE_ROOTS_STAGED_OWNER_SID_INVALID\"};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{if(-not($_.IdentityReference -is [Security.Principal.SecurityIdentifier])){throw \"M4F_GATE_ROOTS_STAGED_RULE_SID_INVALID\"};[ordered]@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString();inherited=[bool]$_.IsInherited}});$facts+=,[ordered]@{path=$current.FullName;owner_sid=$owner.Value;strict_acl=$StrictAcl;rules=$rules};if($current.FullName.TrimEnd('\\').Equals($Root.TrimEnd('\\'),[StringComparison]::OrdinalIgnoreCase)){$facts;return};$current=$current.Parent};throw \"M4F_GATE_ROOTS_STAGED_ANCESTOR_CHAIN_INCOMPLETE\" }",
    "function Root-Acl { $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($administratorsSid);$acl.SetAccessRuleProtection($true,$false);$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit-bor[Security.AccessControl.InheritanceFlags]::ObjectInherit;$none=[Security.AccessControl.PropagationFlags]::None;$allow=[Security.AccessControl.AccessControlType]::Allow;[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administratorsSid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$none,$allow));[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$none,$allow));$rx=[Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize;[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid,$rx,$inherit,$none,$allow));return $acl }",
    "$identityFact=Stage \"identity\" { $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$identityName=$identity.Name.ToLowerInvariant();$identitySid=$identity.User.Value;if($env:COMPUTERNAME -cne $expectedComputer -or $identityName -cne $expectedIdentityName -or $identitySid -cne $expectedIdentitySid){throw \"M4F_GATE_ROOTS_STAGED_IDENTITY_INVALID\"};return [ordered]@{computer_name=$env:COMPUTERNAME;identity_name=$identityName;identity_sid=$identitySid} }",
    "if($null -eq $identityFact){throw \"M4F_GATE_ROOTS_STAGED_IDENTITY_STAGE_FAILED\"}",
    "$startObservation=Stage \"start_observation\" { Process-Observation }",
    "$volumeC=Stage \"volume_c\" { Volume-Fact \"C:\\\" 10737418240 }",
    "$volumeD=Stage \"volume_d\" { Volume-Fact \"D:\\\" 21474836480 }",
    "$existence=Stage \"target_existence\" { [ordered]@{gate_path_exists=[bool](Test-Path -LiteralPath $gateRoot);backing_path_exists=[bool](Test-Path -LiteralPath $backingRoot)} }",
    "[object[]]$gateAncestors=Stage \"ancestors_gate\" { [object[]]$facts=@(Ancestors ([IO.Path]::GetDirectoryName($gateRoot)) \"C:\\\" $true);return [ordered]@{runtime_type=$facts.GetType().FullName;count=$facts.Count;facts=$facts} }",
    "[object[]]$backingAncestors=Stage \"ancestors_backing\" { [object[]]$facts=@(Ancestors ([IO.Path]::GetDirectoryName($backingRoot)) \"D:\\\" $false);return [ordered]@{runtime_type=$facts.GetType().FullName;count=$facts.Count;facts=$facts} }",
    "$aclTemplate=Stage \"root_acl_template\" { $acl=Root-Acl;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]);$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{[ordered]@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights}});return [ordered]@{owner_sid=$owner.Value;protected=[bool]$acl.AreAccessRulesProtected;rule_count=$rules.Count;rules=$rules} }",
    "$streams=Stage \"stream_probe\" { $rows=@(Get-Item -LiteralPath \"C:\\Windows\\Temp\" -Stream * -ErrorAction Stop|ForEach-Object{[ordered]@{file_name=[string]$_.FileName;stream=[string]$_.Stream;length=[int64]$_.Length}});return [ordered]@{count=$rows.Count;rows=$rows} }",
    "$endObservation=Stage \"end_observation\" { Process-Observation }",
    "Emit \"complete\" \"complete\" \"complete\" ([ordered]@{failed_stage_count=$failedStageCount;ordinary_stage_failure_policy=\"continue_distinct_stages\";remote_self_deadline=\"cooperative_boundary_only\";synchronous_call_cancellation=\"UNKNOWN\";local_transport_timeout_may_leave_remote=\"UNKNOWN\";process_mutation_performed=$false;service_mutation_performed=$false;file_mutation_performed=$false;acl_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false}) $null",
    "",
  ].join("\n");
}

export function stagedDiagnosticConfigSha256(rawConfig: unknown): string {
  return sha256(Buffer.from(canonicalJson(validateGateRootsStagedDiagnosticConfig(rawConfig)) + "\n"));
}

export function stagedDiagnosticPlan(
  rawConfig: unknown,
  rawAdmission: unknown,
): Record<string, unknown> {
  const config = validateGateRootsStagedDiagnosticConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  const remote = Buffer.from(buildGateRootsStagedRemoteScript(config, admission), "ascii");
  return {
    schema: "synthia-m4f-direct-gate-roots-staged-diagnostic-plan.v1",
    diagnostic_id: config.diagnostic_id,
    gate_id: config.gate_id,
    action: "single_attempt_read_only_staged_diagnostic",
    target_host: admission.target.host,
    target_user: admission.target.user,
    target_computer: admission.target.computer_name,
    stages: [...STAGES],
    remote_script_length: remote.length,
    remote_script_sha256: sha256(remote),
    local_deadline_ms: LOCAL_DEADLINE_MS,
    remote_cooperative_deadline_seconds: REMOTE_COOPERATIVE_DEADLINE_SECONDS,
    maximum_attempts: 1,
    retry_permitted: false,
    partial_markers_accepted: true,
    raw_command_line_returned: false,
    remote_synchronous_call_cancellation: "UNKNOWN",
    local_timeout_may_leave_remote_process: "UNKNOWN",
    network_attempted: false,
  };
}

export function stagedDiagnosticPlanSha256(rawConfig: unknown, rawAdmission: unknown): string {
  return sha256(Buffer.from(canonicalJson(stagedDiagnosticPlan(rawConfig, rawAdmission)) + "\n"));
}

export function stagedDiagnosticConfirmation(rawConfig: unknown, rawAdmission: unknown): string {
  const config = validateGateRootsStagedDiagnosticConfig(rawConfig);
  return [
    "SYNTHIA_M4F_DIRECT_GATE_ROOTS_STAGED_READ_ONLY",
    config.diagnostic_id,
    stagedDiagnosticConfigSha256(config),
    stagedDiagnosticPlanSha256(config, rawAdmission),
    config.expected_diagnostic_source_sha256,
    config.expected_test_source_sha256,
  ].join(":");
}

export function parseStagedMarkers(bytes: Buffer, diagnosticId: string): StagedMarker[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rawLines = text.split(/\r?\n/u);
  const completeLines = rawLines.slice(0, rawLines.length - 1);
  const markers: StagedMarker[] = [];
  let stageIndex = 0;
  let awaitingEnd = false;
  for (const line of completeLines) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
    }
    const marker = object(parsed);
    const phaseStatusValid = marker?.phase === "begin" && marker.status === "started"
      || marker?.phase === "end" && (marker.status === "observed" || marker.status === "failed")
      || marker?.phase === "complete" && marker.status === "complete";
    if (!marker || !exactKeys(marker, MARKER_KEYS)
      || marker.schema !== "synthia-m4f-direct-gate-roots-staged-marker.v1"
      || marker.diagnostic_id !== diagnosticId
      || marker.ordinal !== markers.length + 1
      || typeof marker.stage !== "string" || ![...STAGES, "complete"].includes(marker.stage as never)
      || !phaseStatusValid
      || typeof marker.observed_at_utc !== "string"
      || (marker.payload !== null && !object(marker.payload))
      || (marker.error !== null && typeof marker.error !== "string")) {
      throw new Error("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
    }
    if (marker.phase === "begin") {
      if (awaitingEnd || marker.stage !== STAGES[stageIndex]) {
        throw new Error("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
      }
      awaitingEnd = true;
    } else if (marker.phase === "end") {
      if (!awaitingEnd || marker.stage !== STAGES[stageIndex]) {
        throw new Error("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
      }
      awaitingEnd = false;
      stageIndex += 1;
    } else if (marker.stage !== "complete" || awaitingEnd || stageIndex !== STAGES.length) {
      throw new Error("M4F_GATE_ROOTS_STAGED_MARKER_INVALID");
    }
    markers.push(marker as unknown as StagedMarker);
  }
  return markers;
}

export function executeStagedDiagnostic(
  rawConfig: unknown,
  rawAdmission: unknown,
  confirmation: string,
  dependencies: StagedDiagnosticDependencies,
  observer: Partial<StagedExecutionObserver> = {},
): StagedExecutionResult {
  const config = validateGateRootsStagedDiagnosticConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  if (confirmation !== stagedDiagnosticConfirmation(config, admission)) throw new Error("M4F_GATE_ROOTS_STAGED_CONFIRMATION_REQUIRED");
  if (sha256(dependencies.sourceBytes()) !== config.expected_diagnostic_source_sha256
    || sha256(dependencies.testSourceBytes()) !== config.expected_test_source_sha256
    || sha256(dependencies.gateRootsSourceBytes()) !== config.expected_gate_roots_source_sha256
    || sha256(dependencies.transportSourceBytes()) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_GATE_ROOTS_STAGED_SOURCE_MISMATCH");
  }
  const initialInputs = dependencies.transportInputs(admission, "local_preflight");
  observer.transportInputs?.("initial", initialInputs);
  const effective = dependencies.spawn("/usr/bin/ssh", buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), 15_000);
  observer.effective?.(effective);
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) throw new Error("M4F_GATE_ROOTS_STAGED_EFFECTIVE_CONFIG_FAILED");
  auditDirectSshEffectiveConfig(effective.stdout, admission);
  if (sha256(effective.stdout) !== config.expected_effective_config_sha256) throw new Error("M4F_GATE_ROOTS_STAGED_EFFECTIVE_CONFIG_MISMATCH");
  const preRemoteInputs = dependencies.transportInputs(admission, "network");
  observer.transportInputs?.("pre_remote", preRemoteInputs);
  if (canonicalJson(initialInputs) !== canonicalJson(preRemoteInputs)) {
    throw new Error("M4F_GATE_ROOTS_STAGED_TRANSPORT_INPUT_DRIFT");
  }
  const remote = Buffer.from(buildGateRootsStagedRemoteScript(config, admission), "ascii");
  observer.remotePrepared?.(remote);
  const raw = dependencies.spawn("/usr/bin/ssh", [
    ...buildDirectSshOptions(admission),
    TARGET_HOST,
    buildDirectPowerShellStdinCommand(),
  ], remote, LOCAL_DEADLINE_MS);
  observer.remote?.(raw);
  const postRemoteInputs = dependencies.transportInputs(admission, "network");
  observer.transportInputs?.("post_remote", postRemoteInputs);
  if (canonicalJson(initialInputs) !== canonicalJson(postRemoteInputs)) {
    throw new Error("M4F_GATE_ROOTS_STAGED_TRANSPORT_INPUT_DRIFT");
  }
  const markers = parseStagedMarkers(raw.stdout, config.diagnostic_id);
  observer.markers?.(markers);
  const allStagesObserved = markers.filter((marker) => marker.phase === "end").length === STAGES.length
    && markers.every((marker) => marker.phase !== "end" || marker.status === "observed");
  const complete = allStagesObserved && markers.length === STAGES.length * 2 + 1
    && markers.at(-1)?.stage === "complete"
    && markers.at(-1)?.phase === "complete"
    && markers.at(-1)?.status === "complete"
    && raw.status === 0 && raw.signal === null && raw.errorCode === null && raw.stderr.length === 0;
  return {
    process: raw,
    markers,
    complete,
    remote_state: complete ? "observed" : "partial_unknown",
  };
}

function makeEvidenceDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: false });
  chmodSync(path, 0o700);
}

function writeEvidence(directory: string, name: string, content: string | Buffer): void {
  const path = directory + "/" + name;
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "M4F_GATE_ROOTS_STAGED_UNEXPECTED";
}

export function recordStagedDiagnostic(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: StagedRecordDependencies,
): StagedExecutionResult {
  const config = validateGateRootsStagedDiagnosticConfig(rawConfig);
  const admissionBytes = dependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) {
    throw new Error("M4F_GATE_ROOTS_STAGED_ADMISSION_CONFIG_MISMATCH");
  }
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  if (confirmation !== stagedDiagnosticConfirmation(config, admission)) {
    throw new Error("M4F_GATE_ROOTS_STAGED_CONFIRMATION_REQUIRED");
  }
  const sourceBytes = dependencies.sourceBytes();
  const testSourceBytes = dependencies.testSourceBytes();
  const gateRootsSourceBytes = dependencies.gateRootsSourceBytes();
  const transportSourceBytes = dependencies.transportSourceBytes();
  if (sha256(sourceBytes) !== config.expected_diagnostic_source_sha256
    || sha256(testSourceBytes) !== config.expected_test_source_sha256
    || sha256(gateRootsSourceBytes) !== config.expected_gate_roots_source_sha256
    || sha256(transportSourceBytes) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_GATE_ROOTS_STAGED_SOURCE_MISMATCH");
  }
  const absolute = resolve(evidenceDirectory);
  try {
    makeEvidenceDirectory(absolute);
  } catch {
    throw new Error("M4F_GATE_ROOTS_STAGED_EVIDENCE_DIRECTORY_INVALID");
  }
  let effectiveProcess: RawProcessResult | null = null;
  let remoteProcess: RawProcessResult | null = null;
  let remoteScript: Buffer | null = null;
  let parsedMarkers: StagedMarker[] | null = null;
  const bestEffortWrite = (name: string, content: string | Buffer): void => {
    try {
      writeEvidence(absolute, name, content);
    } catch {
      // Never replace the authoritative diagnostic error with an evidence-write error.
    }
  };
  try {
    writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "admission-config.raw.json", admissionBytes);
    writeEvidence(absolute, "source-hashes.json", JSON.stringify({
      schema: "synthia-m4f-direct-gate-roots-staged-source-hashes.v1",
      config_canonical_sha256: stagedDiagnosticConfigSha256(config),
      admission_config_sha256: sha256(admissionBytes),
      diagnostic_source_sha256: sha256(sourceBytes),
      diagnostic_test_source_sha256: sha256(testSourceBytes),
      gate_roots_source_sha256: sha256(gateRootsSourceBytes),
      transport_source_sha256: sha256(transportSourceBytes),
      expected_effective_config_sha256: config.expected_effective_config_sha256,
      candidate09_diagnostic_sha256: config.candidate09_diagnostic_sha256,
      candidate09_started_at_utc: config.candidate09_started_at_utc,
      candidate09_ended_at_utc: config.candidate09_ended_at_utc,
    }, null, 2) + "\n");
    writeEvidence(absolute, "powershell-stdin-wrapper.ps1", M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);
    const result = executeStagedDiagnostic(config, admission, confirmation, dependencies, {
      transportInputs(label, facts) {
        writeEvidence(absolute, "transport-inputs-" + label + ".json", JSON.stringify(facts, null, 2) + "\n");
      },
      effective(process) {
        effectiveProcess = process;
        writeEvidence(absolute, "ssh-effective.stdout.raw", process.stdout);
        writeEvidence(absolute, "ssh-effective.stderr.raw", process.stderr);
        writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(
          processEvidence(process, Buffer.alloc(0)), null, 2,
        ) + "\n");
        writeEvidence(absolute, "ssh-effective-hashes.json", JSON.stringify({
          schema: "synthia-m4f-direct-gate-roots-staged-effective-hashes.v1",
          expected_effective_config_sha256: config.expected_effective_config_sha256,
          observed_effective_config_sha256: sha256(process.stdout),
        }, null, 2) + "\n");
      },
      remotePrepared(script) {
        remoteScript = script;
        writeEvidence(absolute, "remote-script.ps1", script);
      },
      remote(process) {
        remoteProcess = process;
        writeEvidence(absolute, "remote-stdout.raw", process.stdout);
        writeEvidence(absolute, "remote-stderr.raw", process.stderr);
        writeEvidence(absolute, "remote-process.json", JSON.stringify(
          processEvidence(process, remoteScript ?? Buffer.alloc(0)), null, 2,
        ) + "\n");
      },
      markers(markers) {
        parsedMarkers = markers;
        writeEvidence(absolute, "markers.json", JSON.stringify(markers, null, 2) + "\n");
      },
    });
    writeEvidence(absolute, "result.json", JSON.stringify({
      schema: "synthia-m4f-direct-gate-roots-staged-result.v1",
      diagnostic_id: config.diagnostic_id,
      gate_id: config.gate_id,
      complete: result.complete,
      remote_state: result.remote_state,
      marker_count: result.markers.length,
      retry_permitted: false,
    }, null, 2) + "\n");
    return result;
  } catch (error) {
    const failedRemoteProcess = remoteProcess as RawProcessResult | null;
    if (failedRemoteProcess !== null && parsedMarkers === null) {
      try {
        parsedMarkers = parseStagedMarkers(failedRemoteProcess.stdout, config.diagnostic_id);
        bestEffortWrite("markers.json", JSON.stringify(parsedMarkers, null, 2) + "\n");
      } catch (parseError) {
        bestEffortWrite("marker-parse-failure.json", JSON.stringify({
          schema: "synthia-m4f-direct-gate-roots-staged-marker-parse-failure.v1",
          error: errorMessage(parseError),
        }, null, 2) + "\n");
      }
    }
    bestEffortWrite("failure.json", JSON.stringify({
      schema: "synthia-m4f-direct-gate-roots-staged-failure.v1",
      error: errorMessage(error),
      effective_config_observed: effectiveProcess !== null,
      remote_attempted: remoteProcess !== null,
      remote_script_frozen: remoteScript !== null,
      marker_count: parsedMarkers?.length ?? 0,
      retry_permitted: false,
    }, null, 2) + "\n");
    throw error;
  }
}

const systemDependencies: StagedRecordDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer",
      windowsHide: true,
    });
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
      stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  testSourceBytes: () => readFileSync(new URL("../m4f-direct-gate-roots-staged-diagnostic.test.ts", import.meta.url)),
  gateRootsSourceBytes: () => readFileSync(new URL("./m4f-direct-gate-roots.ts", import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  admissionConfigBytes: (path) => readFileSync(path),
};

function main(): void {
  const args = process.argv.slice(2);
  const planning = args.length === 3 && args[0] === "--plan" && args[1] === "--config";
  const executing = args.length === 7 && args[0] === "--execute-read-only"
    && args[1] === "--config" && args[3] === "--confirmation" && args[5] === "--evidence-dir";
  if (!planning && !executing) {
    process.stderr.write([
      "usage:",
      "  bun connector/scripts/m4f-direct-gate-roots-staged-diagnostic.ts --plan --config <config.json>",
      "  bun connector/scripts/m4f-direct-gate-roots-staged-diagnostic.ts --execute-read-only --config <config.json> --confirmation <exact> --evidence-dir <new-directory>",
      "",
    ].join("\n"));
    process.exitCode = 64;
    return;
  }
  const config = validateGateRootsStagedDiagnosticConfig(JSON.parse(readFileSync(args[2]!, "utf8")));
  if (executing) {
    const result = recordStagedDiagnostic(config, args[4]!, args[6]!, systemDependencies);
    process.stdout.write(JSON.stringify({
      schema: "synthia-m4f-direct-gate-roots-staged-cli-result.v1",
      diagnostic_id: config.diagnostic_id,
      gate_id: config.gate_id,
      complete: result.complete,
      remote_state: result.remote_state,
      marker_count: result.markers.length,
      retry_permitted: false,
    }) + "\n");
    return;
  }
  if (sha256(systemDependencies.sourceBytes()) !== config.expected_diagnostic_source_sha256
    || sha256(systemDependencies.testSourceBytes()) !== config.expected_test_source_sha256
    || sha256(systemDependencies.gateRootsSourceBytes()) !== config.expected_gate_roots_source_sha256
    || sha256(systemDependencies.transportSourceBytes()) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_GATE_ROOTS_STAGED_SOURCE_MISMATCH");
  }
  const admissionBytes = readFileSync(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) throw new Error("M4F_GATE_ROOTS_STAGED_ADMISSION_CONFIG_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  const plan = stagedDiagnosticPlan(config, admission);
  process.stdout.write(JSON.stringify({
    ...plan,
    config_sha256: stagedDiagnosticConfigSha256(config),
    plan_sha256: stagedDiagnosticPlanSha256(config, admission),
    confirmation: stagedDiagnosticConfirmation(config, admission),
  }) + "\n");
}

if (import.meta.main) main();
