import { createHash } from "node:crypto";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED,
  BOUND_JUMP_RECEIVER_ENCODED_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_LENGTH,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  invokeBoundJumpPhase,
  runCeremony,
} from "./m4f-bound-jump-transport.ts";

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_OBSERVATION_20260827_06";
const JUMP_COMPUTER = "DESKTOP-E380LR7";
const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const SSH_PATH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const MAX_OBSERVED_PROCESSES = 512;
const MAX_RECEIVER_MATCHES = 128;
const MAX_SSH_V_MATCHES = 128;
const MAX_COMMAND_LINE_BYTES = 32_768;
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK_SHA256 = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";

export const JUMP_LOCAL_RESIDUE_ARTIFACT = String.raw`
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$expectedComputer = "${JUMP_COMPUTER}"
$expectedIdentityName = "${JUMP_IDENTITY_NAME}"
$expectedIdentitySid = "${JUMP_IDENTITY_SID}"
$powershellPath = "${POWERSHELL_PATH}"
$sshPath = "${SSH_PATH}"
$maxObservedProcesses = ${MAX_OBSERVED_PROCESSES}
$maxReceiverMatches = ${MAX_RECEIVER_MATCHES}
$maxSshVMatches = ${MAX_SSH_V_MATCHES}
$maxCommandLineBytes = ${MAX_COMMAND_LINE_BYTES}
$snapshotIntervalMilliseconds = 250
$cimTimeoutSeconds = 10
$expectedReceiverEncodedLength = ${BOUND_JUMP_RECEIVER_ENCODED_LENGTH}
$expectedReceiverEncodedSha256 = "${BOUND_JUMP_RECEIVER_ENCODED_SHA256}"
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$strictUnicode = [Text.UnicodeEncoding]::new($false, $false, $true)

function Fail([string]$Code, [string]$Detail = "") {
  if ($Detail) { throw ("{0}:{1}" -f $Code, $Detail) }
  throw $Code
}

function Get-BytesSha256([byte[]]$Bytes) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($Bytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-CommandLineFact([string]$CommandLine, [int]$MaximumBytes, [object]$Utf8) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    Fail "M4F_JUMP_LOCAL_RESIDUE_COMMAND_LINE_MISSING"
  }
  $bytes = $Utf8.GetBytes($CommandLine)
  if ($bytes.Length -lt 1 -or $bytes.Length -gt $MaximumBytes) {
    Fail "M4F_JUMP_LOCAL_RESIDUE_COMMAND_LINE_BOUND"
  }
  return [ordered]@{
    length = [int]$bytes.Length
    sha256 = Get-BytesSha256 $bytes
  }
}

function Get-CreationTimeUtc([object]$CreationDate) {
  if ($CreationDate -isnot [datetime]) {
    Fail "M4F_JUMP_LOCAL_RESIDUE_CREATION_TIME_INVALID"
  }
  return $CreationDate.ToUniversalTime().ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
    [Globalization.CultureInfo]::InvariantCulture
  )
}

function Get-ExceptionFact([Exception]$Exception, [object]$Utf8) {
  $messageBytes = $Utf8.GetBytes([string]$Exception.Message)
  if ($messageBytes.Length -gt 8192) {
    Fail "M4F_JUMP_LOCAL_RESIDUE_EXCEPTION_BOUND"
  }
  return [ordered]@{
    schema = "synthia-m4f-jump-local-residue-exception.v1"
    type = [string]($Exception.GetType().FullName)
    hresult = [int]$Exception.HResult
    message_utf8_length = [int]$messageBytes.Length
    message_utf8_sha256 = Get-BytesSha256 $messageBytes
    message_utf8_base64 = [Convert]::ToBase64String($messageBytes)
  }
}

function Get-BaseProcessFact([object]$Process, [int]$MaximumCommandLineBytes, [object]$Utf8) {
  if ($Process.ProcessId -isnot [uint32] -or
    $Process.ParentProcessId -isnot [uint32] -or
    $Process.ProcessId -lt 1 -or
    [string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath)) {
    Fail "M4F_JUMP_LOCAL_RESIDUE_PROCESS_FACT_INVALID"
  }
  $command = Get-CommandLineFact ([string]$Process.CommandLine) $MaximumCommandLineBytes $Utf8
  return [ordered]@{
    schema = "synthia-m4f-jump-local-process-fact.v1"
    process_id = [uint32]$Process.ProcessId
    parent_process_id = [uint32]$Process.ParentProcessId
    creation_time_utc = Get-CreationTimeUtc $Process.CreationDate
    executable_path = [string]$Process.ExecutablePath
    command_line_utf8_length = [int]$command.length
    command_line_sha256 = [string]$command.sha256
  }
}

function Test-ReceiverCommandLine(
  [string]$CommandLine,
  [string]$PowerShellPath,
  [int]$ExpectedEncodedLength,
  [string]$ExpectedEncodedSha256,
  [object]$Ascii,
  [object]$Unicode
) {
  $suffix = " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
  $prefixes = @(
    "powershell.exe" + $suffix,
    $PowerShellPath + $suffix,
    '"' + $PowerShellPath + '"' + $suffix
  )
  $encoded = $null
  foreach ($prefix in $prefixes) {
    if ($CommandLine.StartsWith($prefix, [StringComparison]::Ordinal)) {
      $encoded = $CommandLine.Substring($prefix.Length)
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($encoded) -or
    $encoded.Contains(" ") -or
    $encoded.Contains([char]9) -or
    $encoded.Contains([char]13) -or
    $encoded.Contains([char]10)) {
    return $false
  }
  $encodedBytes = $Ascii.GetBytes($encoded)
  if ($encodedBytes.Length -ne $ExpectedEncodedLength -or
    (Get-BytesSha256 $encodedBytes) -cne $ExpectedEncodedSha256) {
    return $false
  }
  try {
    $sourceBytes = [Convert]::FromBase64String($encoded)
    if ([Convert]::ToBase64String($sourceBytes) -cne $encoded) { return $false }
    $source = $Unicode.GetString($sourceBytes)
    return $source.Length -gt 0 -and $Unicode.GetBytes($source).Length -eq $sourceBytes.Length
  } catch {
    return $false
  }
}

function Observe-Snapshot(
  [int]$Index,
  [string]$PowerShellPath,
  [string]$SshPath,
  [int]$CurrentPid,
  [int]$MaximumProcesses,
  [int]$MaximumReceivers,
  [int]$MaximumSsh,
  [int]$MaximumCommandLineBytes,
  [int]$TimeoutSeconds,
  [int]$ExpectedEncodedLength,
  [string]$ExpectedEncodedSha256,
  [object]$Utf8,
  [object]$Ascii,
  [object]$Unicode
) {
  $observedAt = [DateTime]::UtcNow
  try {
    $processes = @(Get-CimInstance -Query (
      "SELECT ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine " +
      "FROM Win32_Process WHERE Name='powershell.exe' OR Name='ssh.exe'"
    ) -OperationTimeoutSec $TimeoutSeconds -ErrorAction Stop)
    if ($processes.Count -lt 1 -or $processes.Count -gt $MaximumProcesses) {
      Fail "M4F_JUMP_LOCAL_RESIDUE_PROCESS_CARDINALITY" ([string]$processes.Count)
    }
    $facts = @()
    foreach ($process in $processes) {
      $fact = Get-BaseProcessFact $process $MaximumCommandLineBytes $Utf8
      $facts += [ordered]@{
        fact = $fact
        raw_command_line = [string]$process.CommandLine
        creation = [datetime]$process.CreationDate
      }
    }
    $currentCandidates = @($facts | Where-Object { $_.fact.process_id -eq [uint32]$CurrentPid })
    if ($currentCandidates.Count -ne 1) {
      Fail "M4F_JUMP_LOCAL_RESIDUE_CURRENT_PROCESS_CARDINALITY" ([string]$currentCandidates.Count)
    }
    $current = $currentCandidates[0]
    $currentReceiverCommandValid = Test-ReceiverCommandLine $current.raw_command_line $PowerShellPath $ExpectedEncodedLength $ExpectedEncodedSha256 $Ascii $Unicode
    if ($current.fact.executable_path -cne $PowerShellPath -or
      -not $currentReceiverCommandValid) {
      Fail "M4F_JUMP_LOCAL_RESIDUE_CURRENT_RECEIVER_INVALID"
    }
    $receiverMatches = @()
    $receiverBirth = @{}
    foreach ($candidate in $facts) {
      if ($candidate.fact.process_id -eq [uint32]$CurrentPid) {
        if ($candidate.fact.creation_time_utc -cne $current.fact.creation_time_utc -or
          $candidate.fact.executable_path -cne $current.fact.executable_path -or
          $candidate.fact.command_line_sha256 -cne $current.fact.command_line_sha256) {
          Fail "M4F_JUMP_LOCAL_RESIDUE_SELF_TUPLE_INVALID"
        }
        continue
      }
      if ($candidate.fact.executable_path -ceq $PowerShellPath -and
        $candidate.raw_command_line -ceq $current.raw_command_line) {
        $receiverMatches += $candidate.fact
        $receiverBirth[[string]$candidate.fact.process_id] = $candidate.creation
      }
    }
    if ($receiverMatches.Count -gt $MaximumReceivers) {
      Fail "M4F_JUMP_LOCAL_RESIDUE_RECEIVER_MATCH_BOUND"
    }
    $sshMatches = @()
    $unquotedSshV = $SshPath + " -V"
    $quotedSshV = '"' + $SshPath + '" -V'
    foreach ($candidate in $facts) {
      if ($candidate.fact.executable_path -cne $SshPath) { continue }
      $form = if ($candidate.raw_command_line -ceq $unquotedSshV) {
        "unquoted"
      } elseif ($candidate.raw_command_line -ceq $quotedSshV) {
        "quoted"
      } else {
        Fail "M4F_JUMP_LOCAL_RESIDUE_SSH_COMMAND_NOT_ALLOWLISTED"
      }
      $relation = "unresolved"
      $matchedPid = $null
      if ($candidate.fact.parent_process_id -eq [uint32]$CurrentPid -and
        $current.creation -lt $candidate.creation) {
        $relation = "observer_self"
        $matchedPid = [uint32]$CurrentPid
      } elseif ($receiverBirth.ContainsKey([string]$candidate.fact.parent_process_id) -and
        $receiverBirth[[string]$candidate.fact.parent_process_id] -lt $candidate.creation) {
        $relation = "live_receiver_twin"
        $matchedPid = [uint32]$candidate.fact.parent_process_id
      } elseif ($candidate.fact.parent_process_id -eq [uint32]$CurrentPid -or
        $receiverBirth.ContainsKey([string]$candidate.fact.parent_process_id)) {
        $relation = "pid_reuse_suspected"
        $matchedPid = [uint32]$candidate.fact.parent_process_id
      }
      $sshMatches += [ordered]@{
        schema = "synthia-m4f-jump-local-ssh-v-fact.v1"
        process_id = [uint32]$candidate.fact.process_id
        parent_process_id = [uint32]$candidate.fact.parent_process_id
        creation_time_utc = [string]$candidate.fact.creation_time_utc
        executable_path = [string]$candidate.fact.executable_path
        command_line_utf8_length = [int]$candidate.fact.command_line_utf8_length
        command_line_sha256 = [string]$candidate.fact.command_line_sha256
        command_line_form = $form
        parent_relation = $relation
        matched_receiver_pid = $matchedPid
      }
    }
    if ($sshMatches.Count -gt $MaximumSsh) {
      Fail "M4F_JUMP_LOCAL_RESIDUE_SSH_V_MATCH_BOUND"
    }
    return [ordered]@{
      schema = "synthia-m4f-jump-local-residue-snapshot-internal.v1"
      index = $Index
      status = "complete"
      observation_time_utc = $observedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", [Globalization.CultureInfo]::InvariantCulture)
      observed_process_count = [int]$processes.Count
      current_receiver = $current.fact
      receiver_matches = @($receiverMatches)
      ssh_v_matches = @($sshMatches)
      exception = $null
    }
  } catch {
    return [ordered]@{
      schema = "synthia-m4f-jump-local-residue-snapshot-internal.v1"
      index = $Index
      status = "indeterminate"
      observation_time_utc = $observedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", [Globalization.CultureInfo]::InvariantCulture)
      observed_process_count = $null
      current_receiver = $null
      receiver_matches = @()
      ssh_v_matches = @()
      exception = Get-ExceptionFact $_.Exception $Utf8
    }
  }
}

$windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = [Security.Principal.WindowsPrincipal]::new($windowsIdentity)
$identityName = $windowsIdentity.Name.ToLowerInvariant()
$identitySid = $windowsIdentity.User.Value
$isAdministrator = $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ([Environment]::MachineName -cne $expectedComputer -or
  $identityName -cne $expectedIdentityName -or
  $identitySid -cne $expectedIdentitySid -or
  -not $isAdministrator) {
  Fail "M4F_JUMP_LOCAL_RESIDUE_IDENTITY_INVALID"
}

$ascii = [Text.ASCIIEncoding]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$first = Observe-Snapshot 1 $powershellPath $sshPath $PID $maxObservedProcesses $maxReceiverMatches $maxSshVMatches $maxCommandLineBytes $cimTimeoutSeconds $expectedReceiverEncodedLength $expectedReceiverEncodedSha256 $strictUtf8 $ascii $strictUnicode
$remaining = $snapshotIntervalMilliseconds - [int]$clock.ElapsedMilliseconds
if ($remaining -gt 0) { [Threading.Thread]::Sleep($remaining) }
$second = Observe-Snapshot 2 $powershellPath $sshPath $PID $maxObservedProcesses $maxReceiverMatches $maxSshVMatches $maxCommandLineBytes $cimTimeoutSeconds $expectedReceiverEncodedLength $expectedReceiverEncodedSha256 $strictUtf8 $ascii $strictUnicode
$clock.Stop()
$allSnapshots = @($first, $second)
$completeSnapshots = @($allSnapshots | Where-Object { $_.status -ceq "complete" })
$currentReceiver = if ($completeSnapshots.Count -gt 0) { $completeSnapshots[0].current_receiver } else { $null }
$currentConsistent = $true
foreach ($snapshot in $completeSnapshots) {
  if (($snapshot.current_receiver | ConvertTo-Json -Compress) -cne
    ($currentReceiver | ConvertTo-Json -Compress)) {
    $currentConsistent = $false
  }
}

function Merge-Matches([object[]]$Snapshots, [string]$PropertyName) {
  $bindings = @{}
  $merged = @()
  foreach ($snapshot in $Snapshots) {
    foreach ($fact in @($snapshot.$PropertyName)) {
      $binding = "{0}|{1}|{2}|{3}" -f $fact.process_id, $fact.creation_time_utc, $fact.executable_path, $fact.command_line_sha256
      if (-not $bindings.ContainsKey($binding)) {
        $copy = [ordered]@{}
        foreach ($property in $fact.PSObject.Properties) { $copy[$property.Name] = $property.Value }
        $copy["observed_snapshot_indexes"] = @([int]$snapshot.index)
        $bindings[$binding] = $copy
        $merged += $copy
      } else {
        $bindings[$binding].observed_snapshot_indexes += [int]$snapshot.index
      }
    }
  }
  return @($merged | Sort-Object process_id, creation_time_utc, executable_path, command_line_sha256)
}

$receiverMatches = @(Merge-Matches $completeSnapshots "receiver_matches")
$sshVMatches = @(Merge-Matches $completeSnapshots "ssh_v_matches")
if ($receiverMatches.Count -gt $maxReceiverMatches -or $sshVMatches.Count -gt $maxSshVMatches) {
  Fail "M4F_JUMP_LOCAL_RESIDUE_UNION_BOUND"
}
foreach ($sshFact in $sshVMatches) {
  $sshBirth = [datetime]::ParseExact(
    $sshFact.creation_time_utc,
    "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  )
  $samePidTwin = @($receiverMatches | Where-Object {
    $_.process_id -eq $sshFact.parent_process_id
  })
  $overlappingTwin = @($receiverMatches | Where-Object {
    $_.process_id -eq $sshFact.parent_process_id -and
    @($_.observed_snapshot_indexes | Where-Object {
      $sshFact.observed_snapshot_indexes -contains $_
    }).Count -gt 0
  })
  if ($null -ne $currentReceiver -and
    $sshFact.parent_process_id -eq $currentReceiver.process_id -and
    [datetime]::ParseExact(
      $currentReceiver.creation_time_utc,
      "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    ) -lt $sshBirth) {
    $sshFact.parent_relation = "observer_self"
    $sshFact.matched_receiver_pid = [uint32]$currentReceiver.process_id
  } elseif ($overlappingTwin.Count -eq 1 -and
    [datetime]::ParseExact(
      $overlappingTwin[0].creation_time_utc,
      "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    ) -lt $sshBirth) {
    $sshFact.parent_relation = "live_receiver_twin"
    $sshFact.matched_receiver_pid = [uint32]$overlappingTwin[0].process_id
  } elseif (($null -ne $currentReceiver -and
      $sshFact.parent_process_id -eq $currentReceiver.process_id) -or
    $samePidTwin.Count -gt 0) {
    $sshFact.parent_relation = "pid_reuse_suspected"
    $sshFact.matched_receiver_pid = [uint32]$sshFact.parent_process_id
  } else {
    $sshFact.parent_relation = "unresolved"
    $sshFact.matched_receiver_pid = $null
  }
}
$hasResidue = $receiverMatches.Count -gt 0 -or $sshVMatches.Count -gt 0
$status = if ($hasResidue) {
  "residue_observed"
} elseif ($completeSnapshots.Count -eq 2 -and $currentConsistent) {
  "no_residue_observed"
} else {
  "indeterminate"
}
$snapshotResults = @($allSnapshots | ForEach-Object {
  [ordered]@{
    schema = "synthia-m4f-jump-local-residue-snapshot.v1"
    index = [int]$_.index
    status = [string]$_.status
    observation_time_utc = [string]$_.observation_time_utc
    observed_process_count = $_.observed_process_count
    current_receiver = $_.current_receiver
    receiver_match_count = [int]$_.receiver_matches.Count
    ssh_v_match_count = [int]$_.ssh_v_matches.Count
    exception = $_.exception
  }
})

$output = [ordered]@{
  schema = "synthia-m4f-jump-local-residue-observation.v1"
  status = $status
  observation_finished_utc = [DateTime]::UtcNow.ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
    [Globalization.CultureInfo]::InvariantCulture
  )
  historical_absence_not_proven = $true
  continuous_absence_not_proven = $true
  residue_origin_not_proven = $true
  provider_activation_may_create_processes = $true
  receiver_command_contract = [ordered]@{
    schema = "synthia-m4f-jump-local-receiver-command-contract.v1"
    executable_path = $powershellPath
    argument_prefix = @(
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand"
    )
    encoded_command_length = $expectedReceiverEncodedLength
    encoded_command_sha256 = $expectedReceiverEncodedSha256
  }
  current_receiver = $currentReceiver
  snapshot_interval_milliseconds = $snapshotIntervalMilliseconds
  snapshot_count = 2
  complete_snapshot_count = [int]$completeSnapshots.Count
  snapshots = $snapshotResults
  receiver_match_count = [int]$receiverMatches.Count
  receiver_matches = $receiverMatches
  ssh_v_match_count = [int]$sshVMatches.Count
  ssh_v_matches = $sshVMatches
}
$outputJson = $output | ConvertTo-Json -Depth 7 -Compress
if ($strictUtf8.GetByteCount($outputJson) -gt 1048576) {
  Fail "M4F_JUMP_LOCAL_RESIDUE_OUTPUT_BOUND"
}
[Console]::Out.WriteLine($outputJson)
`;

export function findPowerShell51MultilineCommandInvocationRisks(source: string): number[] {
  const lines = source.split(/\r?\n/u);
  const risks: number[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1]!;
    const commandBeforeNewline = /(?:^|[\s(=!])(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9-]*)\s*$/u
      .test(line)
      && !/^\s*function\s+/iu.test(line);
    const positionalArgumentAfterNewline = /^\s+(?:\$|["']|@\{|@\()/u.test(next);
    if (commandBeforeNewline && positionalArgumentAfterNewline) risks.push(index + 1);
  }
  return risks;
}

export const JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH = Buffer.byteLength(
  JUMP_LOCAL_RESIDUE_ARTIFACT,
  "utf8",
);
export const JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256 = createHash("sha256")
  .update(Buffer.from(JUMP_LOCAL_RESIDUE_ARTIFACT, "utf8"))
  .digest("hex");
const EXPECTED_ARTIFACT_LENGTH = 17_481;
const EXPECTED_ARTIFACT_SHA256 = "c723d9a02308faa0ea1540f8fb32933a2d7da1f7cd0a4ba8f93588a167a03d7a";

if (JUMP_LOCAL_RESIDUE_ARTIFACT_LENGTH !== EXPECTED_ARTIFACT_LENGTH
  || JUMP_LOCAL_RESIDUE_ARTIFACT_SHA256 !== EXPECTED_ARTIFACT_SHA256) {
  throw new Error("M4F_JUMP_LOCAL_RESIDUE_ARTIFACT_DRIFT");
}

function failure(
  code: string,
  stage: "confirmation" | "transport" | "validation",
  observation: BoundJumpPhaseResult | null,
  cause: Record<string, unknown> | null,
): never {
  throw new CeremonyFailure({
    schema: "synthia-m4f-jump-local-residue-failure.v1",
    code,
    current_stage: stage,
    retry_permitted: false,
    observation,
    cause,
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], stage: string): void {
  if (Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-residue-validation-cause.v1",
      stage,
    });
  }
}

function objectValue(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-residue-validation-cause.v1",
      stage,
    });
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function canonicalUtcTicks(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/u.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second, fraction] = match.slice(1).map(Number);
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1
    || hour! > 23 || minute! > 59 || second! > 59) return null;
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day! > monthDays[month! - 1]!) return null;
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(hour!, minute!, second!, 0);
  if (Number.isNaN(date.getTime())) return null;
  return BigInt(date.getTime()) * 10_000n + BigInt(fraction!);
}

function utc(value: unknown): value is string {
  return canonicalUtcTicks(value) !== null;
}

function utcOlder(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left < right;
}

export function classifyFixedPathSshCommandLine(
  executablePath: unknown,
  commandLine: unknown,
): "quoted" | "unquoted" | "indeterminate" | "not_fixed_path" {
  if (executablePath !== SSH_PATH) return "not_fixed_path";
  if (commandLine === `${SSH_PATH} -V`) return "unquoted";
  if (commandLine === `"${SSH_PATH}" -V`) return "quoted";
  return "indeterminate";
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validateException(value: unknown, stage: string): void {
  const exception = objectValue(value, stage);
  exactKeys(exception, [
    "hresult",
    "message_utf8_base64",
    "message_utf8_length",
    "message_utf8_sha256",
    "schema",
    "type",
  ], stage);
  if (exception.schema !== "synthia-m4f-jump-local-residue-exception.v1"
    || typeof exception.type !== "string"
    || Buffer.byteLength(exception.type, "utf8") < 1
    || Buffer.byteLength(exception.type, "utf8") > 512
    || !integer(exception.hresult, -2_147_483_648, 2_147_483_647)
    || !integer(exception.message_utf8_length, 0, 8_192)
    || typeof exception.message_utf8_base64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(exception.message_utf8_base64)
    || !sha256(exception.message_utf8_sha256)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  const bytes = Buffer.from(exception.message_utf8_base64, "base64");
  if (bytes.length !== exception.message_utf8_length
    || bytes.toString("base64") !== exception.message_utf8_base64
    || createHash("sha256").update(bytes).digest("hex") !== exception.message_utf8_sha256) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
}

const PROCESS_KEYS = [
  "command_line_sha256",
  "command_line_utf8_length",
  "creation_time_utc",
  "executable_path",
  "parent_process_id",
  "process_id",
  "schema",
] as const;

function validateProcessFact(
  value: unknown,
  stage: string,
  expectedPath: string,
): Record<string, unknown> {
  const fact = objectValue(value, stage);
  exactKeys(fact, PROCESS_KEYS, stage);
  if (fact.schema !== "synthia-m4f-jump-local-process-fact.v1"
    || !integer(fact.process_id, 1, 4_294_967_295)
    || !integer(fact.parent_process_id, 0, 4_294_967_295)
    || !utc(fact.creation_time_utc)
    || fact.executable_path !== expectedPath
    || !integer(fact.command_line_utf8_length, 1, MAX_COMMAND_LINE_BYTES)
    || !sha256(fact.command_line_sha256)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-residue-validation-cause.v1",
      stage,
    });
  }
  return fact;
}

function validateCurrentReceiverCommand(fact: Record<string, unknown>, stage: string): void {
  const suffix = ` -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${BOUND_JUMP_RECEIVER_ENCODED}`;
  const allowed = [`powershell.exe${suffix}`, `${POWERSHELL_PATH}${suffix}`, `"${POWERSHELL_PATH}"${suffix}`]
    .map((commandLine) => ({
      length: Buffer.byteLength(commandLine, "utf8"),
      sha256: createHash("sha256").update(Buffer.from(commandLine, "utf8")).digest("hex"),
    }));
  if (!allowed.some((candidate) => candidate.length === fact.command_line_utf8_length
    && candidate.sha256 === fact.command_line_sha256)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-residue-validation-cause.v1",
      stage: `${stage}:command_contract`,
    });
  }
}

function validateSortedCompositeUnique(
  facts: Array<Record<string, unknown>>,
  stage: string,
): void {
  let previous: readonly [number, string, string, string] | null = null;
  const seen = new Set<string>();
  for (const [index, fact] of facts.entries()) {
    const current = [
      fact.process_id as number,
      fact.creation_time_utc as string,
      fact.executable_path as string,
      fact.command_line_sha256 as string,
    ] as const;
    const binding = JSON.stringify(current);
    const incorrectlyOrdered = previous !== null && (
      current[0] < previous[0]
      || (current[0] === previous[0] && current[1] < previous[1])
      || (current[0] === previous[0] && current[1] === previous[1] && current[2] < previous[2])
      || (current[0] === previous[0] && current[1] === previous[1]
        && current[2] === previous[2] && current[3] <= previous[3])
    );
    if (seen.has(binding) || incorrectlyOrdered) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, {
        schema: "synthia-m4f-jump-local-residue-validation-cause.v1",
        stage: `${stage}:${index}:order`,
      });
    }
    seen.add(binding);
    previous = current;
  }
}

function validatePayload(payload: Record<string, unknown>): void {
  exactKeys(payload, [
    "complete_snapshot_count",
    "continuous_absence_not_proven",
    "current_receiver",
    "historical_absence_not_proven",
    "observation_finished_utc",
    "provider_activation_may_create_processes",
    "receiver_command_contract",
    "receiver_match_count",
    "receiver_matches",
    "residue_origin_not_proven",
    "schema",
    "snapshot_count",
    "snapshot_interval_milliseconds",
    "snapshots",
    "ssh_v_match_count",
    "ssh_v_matches",
    "status",
  ], "observation");
  if (payload.schema !== "synthia-m4f-jump-local-residue-observation.v1"
    || (payload.status !== "no_residue_observed"
      && payload.status !== "residue_observed"
      && payload.status !== "indeterminate")
    || !utc(payload.observation_finished_utc)
    || payload.historical_absence_not_proven !== true
    || payload.continuous_absence_not_proven !== true
    || payload.residue_origin_not_proven !== true
    || payload.provider_activation_may_create_processes !== true
    || payload.snapshot_interval_milliseconds !== 250
    || payload.snapshot_count !== 2
    || !integer(payload.complete_snapshot_count, 0, 2)
    || !Array.isArray(payload.snapshots)
    || payload.snapshots.length !== 2) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 1_048_576) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  const receiverContract = objectValue(payload.receiver_command_contract, "receiver_command_contract");
  exactKeys(receiverContract, [
    "argument_prefix",
    "encoded_command_length",
    "encoded_command_sha256",
    "executable_path",
    "schema",
  ], "receiver_command_contract");
  if (receiverContract.schema !== "synthia-m4f-jump-local-receiver-command-contract.v1"
    || receiverContract.executable_path !== POWERSHELL_PATH
    || !Array.isArray(receiverContract.argument_prefix)
    || receiverContract.argument_prefix.join("|") !== "-NoLogo|-NoProfile|-NonInteractive|-ExecutionPolicy|Bypass|-EncodedCommand"
    || receiverContract.encoded_command_length !== BOUND_JUMP_RECEIVER_ENCODED_LENGTH
    || receiverContract.encoded_command_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  let completeSnapshots = 0;
  const snapshotRecords: Array<Record<string, unknown>> = [];
  for (const [index, candidate] of payload.snapshots.entries()) {
    const snapshot = objectValue(candidate, `snapshots:${index}`);
    exactKeys(snapshot, [
      "exception",
      "current_receiver",
      "index",
      "observation_time_utc",
      "observed_process_count",
      "receiver_match_count",
      "schema",
      "ssh_v_match_count",
      "status",
    ], `snapshots:${index}`);
    if (snapshot.schema !== "synthia-m4f-jump-local-residue-snapshot.v1"
      || snapshot.index !== index + 1
      || (snapshot.status !== "complete" && snapshot.status !== "indeterminate")
      || !utc(snapshot.observation_time_utc)
      || !integer(snapshot.receiver_match_count, 0, MAX_RECEIVER_MATCHES)
      || !integer(snapshot.ssh_v_match_count, 0, MAX_SSH_V_MATCHES)) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
    }
    if (snapshot.status === "complete") {
      completeSnapshots += 1;
      if (!integer(snapshot.observed_process_count, 1, MAX_OBSERVED_PROCESSES)
        || snapshot.observed_process_count < 1
          + (snapshot.receiver_match_count as number)
          + (snapshot.ssh_v_match_count as number)
        || snapshot.exception !== null
        || snapshot.current_receiver === null) {
        failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
      }
      const snapshotCurrent = validateProcessFact(
        snapshot.current_receiver,
        `snapshots:${index}:current_receiver`,
        POWERSHELL_PATH,
      );
      validateCurrentReceiverCommand(snapshotCurrent, `snapshots:${index}:current_receiver`);
    } else {
      if (snapshot.observed_process_count !== null
        || snapshot.current_receiver !== null
        || snapshot.exception === null) {
        failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
      }
      validateException(snapshot.exception, `snapshots:${index}:exception`);
    }
    snapshotRecords.push(snapshot);
  }
  if (completeSnapshots !== payload.complete_snapshot_count) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  const current = payload.current_receiver === null
    ? null
    : validateProcessFact(payload.current_receiver, "current_receiver", POWERSHELL_PATH);
  if ((completeSnapshots === 0 && current !== null)
    || (completeSnapshots > 0 && current === null)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  if (current !== null) validateCurrentReceiverCommand(current, "current_receiver");
  const currentConsistent = snapshotRecords.every((snapshot) => snapshot.status !== "complete"
    || JSON.stringify(snapshot.current_receiver) === JSON.stringify(current));
  const firstObservationTicks = canonicalUtcTicks(snapshotRecords[0]!.observation_time_utc)!;
  const secondObservationTicks = canonicalUtcTicks(snapshotRecords[1]!.observation_time_utc)!;
  const finishedTicks = canonicalUtcTicks(payload.observation_finished_utc)!;
  if (secondObservationTicks - firstObservationTicks < 2_500_000n
    || finishedTicks < secondObservationTicks) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  if (!Array.isArray(payload.receiver_matches)
    || !integer(payload.receiver_match_count, 0, MAX_RECEIVER_MATCHES)
    || payload.receiver_matches.length !== payload.receiver_match_count) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  const receiverFacts = payload.receiver_matches.map((candidate, index) => {
    const raw = objectValue(candidate, `receiver_matches:${index}`);
    exactKeys(raw, [...PROCESS_KEYS, "observed_snapshot_indexes"], `receiver_matches:${index}`);
    const factForValidation = { ...raw };
    delete factForValidation.observed_snapshot_indexes;
    const fact = validateProcessFact(factForValidation, `receiver_matches:${index}`, POWERSHELL_PATH);
    validateSnapshotIndexes(raw.observed_snapshot_indexes, `receiver_matches:${index}`);
    fact.observed_snapshot_indexes = raw.observed_snapshot_indexes;
    if (current === null
      || (current !== null && fact.process_id === current.process_id)
      || fact.command_line_utf8_length !== current.command_line_utf8_length
      || fact.command_line_sha256 !== current.command_line_sha256) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
    }
    return fact;
  });
  validateSortedCompositeUnique(receiverFacts, "receiver_matches");

  if (!Array.isArray(payload.ssh_v_matches)
    || !integer(payload.ssh_v_match_count, 0, MAX_SSH_V_MATCHES)
    || payload.ssh_v_matches.length !== payload.ssh_v_match_count) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
  const sshFacts = payload.ssh_v_matches.map((candidate, index) => {
    const fact = objectValue(candidate, `ssh_v_matches:${index}`);
    exactKeys(fact, [
      ...PROCESS_KEYS.filter((key) => key !== "schema"),
      "command_line_form",
      "matched_receiver_pid",
      "observed_snapshot_indexes",
      "parent_relation",
      "schema",
    ], `ssh_v_matches:${index}`);
    if (fact.schema !== "synthia-m4f-jump-local-ssh-v-fact.v1"
      || !integer(fact.process_id, 1, 4_294_967_295)
      || (current !== null && fact.process_id === current.process_id)
      || !integer(fact.parent_process_id, 0, 4_294_967_295)
      || !utc(fact.creation_time_utc)
      || fact.executable_path !== SSH_PATH
      || !integer(fact.command_line_utf8_length, 1, MAX_COMMAND_LINE_BYTES)
      || !sha256(fact.command_line_sha256)
      || (fact.command_line_form !== "quoted" && fact.command_line_form !== "unquoted")
      || (fact.parent_relation !== "observer_self"
        && fact.parent_relation !== "live_receiver_twin"
        && fact.parent_relation !== "pid_reuse_suspected"
        && fact.parent_relation !== "unresolved")) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
    }
    validateSnapshotIndexes(fact.observed_snapshot_indexes, `ssh_v_matches:${index}`);
    const commandLine = fact.command_line_form === "quoted"
      ? `"${SSH_PATH}" -V`
      : `${SSH_PATH} -V`;
    const bytes = Buffer.from(commandLine, "utf8");
    if (fact.command_line_utf8_length !== bytes.length
      || fact.command_line_sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
    }
    const currentPid = current?.process_id;
    const indexes = fact.observed_snapshot_indexes as number[];
    const samePidReceivers = receiverFacts.filter(
      (receiver) => receiver.process_id === fact.parent_process_id,
    );
    const overlappingReceivers = samePidReceivers.filter((receiver) =>
      (receiver.observed_snapshot_indexes as number[]).some((snapshot) => indexes.includes(snapshot)));
    const expectedRelation = current !== null
      && fact.parent_process_id === currentPid
      && utcOlder(current.creation_time_utc, fact.creation_time_utc)
      ? "observer_self"
      : overlappingReceivers.length === 1
        && utcOlder(overlappingReceivers[0]!.creation_time_utc, fact.creation_time_utc)
        ? "live_receiver_twin"
        : (current !== null && fact.parent_process_id === currentPid) || samePidReceivers.length > 0
          ? "pid_reuse_suspected"
          : "unresolved";
    const expectedMatched = expectedRelation === "observer_self"
      ? currentPid
      : expectedRelation === "live_receiver_twin" || expectedRelation === "pid_reuse_suspected"
        ? fact.parent_process_id
        : null;
    if (fact.parent_relation !== expectedRelation || fact.matched_receiver_pid !== expectedMatched) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
    }
    return fact;
  });
  validateSortedCompositeUnique(sshFacts, "ssh_v_matches");
  for (const snapshot of snapshotRecords) {
    const snapshotIndex = snapshot.index as number;
    const expectedReceiverCount = snapshot.status === "complete"
      ? receiverFacts.filter((fact) => (fact.observed_snapshot_indexes as number[]).includes(snapshotIndex)).length
      : 0;
    const expectedSshCount = snapshot.status === "complete"
      ? sshFacts.filter((fact) => (fact.observed_snapshot_indexes as number[]).includes(snapshotIndex)).length
      : 0;
    if (snapshot.receiver_match_count !== expectedReceiverCount
      || snapshot.ssh_v_match_count !== expectedSshCount) {
      failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
    }
  }
  const expectedStatus = receiverFacts.length > 0 || sshFacts.length > 0
    ? "residue_observed"
    : completeSnapshots === 2 && currentConsistent
      ? "no_residue_observed"
      : "indeterminate";
  if (payload.status !== expectedStatus) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, null);
  }
}

function validateSnapshotIndexes(value: unknown, stage: string): void {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 2
    || value.some((item, index) => !integer(item, 1, 2)
      || (index > 0 && item <= (value[index - 1] as number)))) {
    failure("M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-residue-validation-cause.v1",
      stage: `${stage}:snapshot_indexes`,
    });
  }
}

function validatePhaseEvidence(observation: BoundJumpPhaseResult): void {
  const identity = objectValue(observation.identity, "phase:identity");
  exactKeys(identity, ["computer_name", "identity_name", "identity_sid", "schema"], "phase:identity");
  const before = observation.master_before;
  const after = observation.master_after;
  const expectedStdin = Buffer.from(`${Buffer.from(JUMP_LOCAL_RESIDUE_ARTIFACT, "utf8").toString("base64")}\n`, "ascii");
  const expectedStdout = Buffer.from(
    `${JSON.stringify(observation.identity)}\n${JSON.stringify(observation.payload)}\n`,
    "utf8",
  ).toString("base64");
  if (observation.schema !== "synthia-m4f-bound-phase.v1"
    || observation.phase !== "jump-local-residue-06:observe"
    || identity.schema !== "synthia-m4f-jump-identity.v1"
    || identity.computer_name !== JUMP_COMPUTER
    || identity.identity_name !== JUMP_IDENTITY_NAME
    || identity.identity_sid !== JUMP_IDENTITY_SID
    || observation.process.exit_status !== 0
    || observation.process.signal !== null
    || observation.process.error_code !== null
    || observation.process.timed_out !== false
    || observation.process.outcome_ambiguous !== false
    || observation.process.stderr_base64 !== ""
    || observation.process.stdout_base64 !== expectedStdout
    || observation.process.retry_permitted !== false
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
    || before.schema !== "synthia-m4f-bound-master-audit.v1"
    || before.master_pid !== 87_062
    || before.master_socket !== "/private/tmp/synthia-m4f-jump.sock"
    || before.known_hosts_path !== "/Users/wenzhuolin/.ssh/known_hosts"
    || before.host_key_fingerprint !== "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8"
    || before.ssh_executable !== "/usr/bin/ssh"
    || before.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256
    || before.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256
    || before.network_sha256 !== MASTER_NETWORK_SHA256
    || JSON.stringify(before) !== JSON.stringify(after)) {
    failure("M4F_JUMP_LOCAL_RESIDUE_EVIDENCE_INVALID", "validation", null, null);
  }
}

function unexpectedCause(error: unknown): Record<string, unknown> {
  if (error instanceof CeremonyFailure) return error.detail;
  const message = Buffer.from(error instanceof Error ? error.message : String(error), "utf8");
  return {
    schema: "synthia-m4f-jump-local-residue-unexpected-cause.v1",
    type: (error instanceof Error ? error.name : typeof error).slice(0, 512),
    message_utf8_base64: message.subarray(0, 16_384).toString("base64"),
  };
}

export interface JumpLocalResidueDependencies {
  invokePhase(phase: string, artifact: string): BoundJumpPhaseResult;
}

export interface JumpLocalResidueResult {
  schema: "synthia-m4f-jump-local-residue-ceremony.v1";
  status: "observed";
  observation: BoundJumpPhaseResult;
}

const defaultDependencies: JumpLocalResidueDependencies = {
  invokePhase: (phase, artifact) => invokeBoundJumpPhase(phase, artifact),
};

export function runJumpLocalResidueObservation(
  overrides: Partial<JumpLocalResidueDependencies> = {},
): JumpLocalResidueResult {
  if (process.env.SYNTHIA_M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION_06 !== CONFIRMATION) {
    failure("M4F_JUMP_LOCAL_RESIDUE_CONFIRMATION_REQUIRED", "confirmation", null, null);
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  let observation: BoundJumpPhaseResult;
  try {
    observation = dependencies.invokePhase("jump-local-residue-06:observe", JUMP_LOCAL_RESIDUE_ARTIFACT);
  } catch (error) {
    failure("M4F_JUMP_LOCAL_RESIDUE_TRANSPORT_FAILED", "transport", null, unexpectedCause(error));
  }
  try {
    validatePhaseEvidence(observation);
    validatePayload(observation.payload);
  } catch (error) {
    failure(
      "M4F_JUMP_LOCAL_RESIDUE_OUTPUT_INVALID",
      "validation",
      observation,
      unexpectedCause(error),
    );
  }
  return {
    schema: "synthia-m4f-jump-local-residue-ceremony.v1",
    status: "observed",
    observation,
  };
}

if (import.meta.main) {
  runCeremony(() => {
    process.stdout.write(`${JSON.stringify(runJumpLocalResidueObservation())}\n`);
  });
}
