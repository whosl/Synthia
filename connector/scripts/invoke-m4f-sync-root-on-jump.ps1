[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$phaseTimeoutMilliseconds = 120000
$sshPath = "C:\Windows\System32\OpenSSH\ssh.exe"
$sourcePath = "C:\Windows\Temp\synthia-m4f-jump-bootstrap-20260827-03\create-m4f-sync-root.ps1"
$expectedSourceSha256 = "c4d67fd1b5c8cc4ebd8698486f9377ad0ce374b5d1697816f7bee090b8436a5e"
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)

$sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash($sourceBytes)
  $actualSourceSha256 = [BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
if ($actualSourceSha256 -cne $expectedSourceSha256) {
  throw "M4F_SYNC_TRANSPORT_SOURCE_HASH_MISMATCH"
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  $sourcePath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($null -eq $parseErrors -or $parseErrors.Count -ne 0 -or
  $null -eq $tokens -or $tokens.Count -lt 1) {
  throw "M4F_SYNC_TRANSPORT_SOURCE_PARSE_FAILED"
}

function New-RemotePhaseOutcome(
  [string]$Phase,
  [byte[]]$StdoutBytes,
  [byte[]]$StderrBytes,
  [AllowNull()][object]$ExitStatus,
  [AllowNull()][string]$Signal,
  [bool]$Timeout,
  [bool]$Ambiguous,
  [bool]$Started
) {
  if ($null -ne $ExitStatus -and $ExitStatus.GetType() -ne [int]) {
    throw "M4F_SYNC_TRANSPORT_INTERNAL_EXIT_STATUS_TYPE"
  }
  return [pscustomobject][ordered]@{
    phase = $Phase
    stdout_bytes = $StdoutBytes
    stderr_bytes = $StderrBytes
    exit_status = $ExitStatus
    signal = $Signal
    timeout = $Timeout
    ambiguous = $Ambiguous
    started = $Started
  }
}

function Write-RemotePhaseFailure(
  [pscustomobject]$Outcome,
  [string]$FailureCode
) {
  if ($null -ne $Outcome.exit_status -and $Outcome.exit_status.GetType() -ne [int]) {
    throw "M4F_SYNC_TRANSPORT_INTERNAL_EXIT_STATUS_TYPE"
  }
  $failure = [ordered]@{
    schema = "synthia-m4f-sync-remote-phase-failure.v1"
    phase = $Outcome.phase
    failure_code = $FailureCode
    stdout_base64 = [Convert]::ToBase64String($Outcome.stdout_bytes)
    stderr_base64 = [Convert]::ToBase64String($Outcome.stderr_bytes)
    exit_status = $Outcome.exit_status
    signal = $Outcome.signal
    timeout = $Outcome.timeout
    ambiguous = $Outcome.ambiguous
  }
  $json = $failure | ConvertTo-Json -Compress
  if ($json.Contains("`r") -or $json.Contains("`n")) {
    throw "M4F_SYNC_TRANSPORT_INTERNAL_FAILURE_ENVELOPE_INVALID"
  }
  [Console]::Error.Write($json + "`n")
}

function Stop-RemotePhase(
  [pscustomobject]$Outcome,
  [string]$FailureCode,
  [int]$LocalExitStatus
) {
  Write-RemotePhaseFailure $Outcome $FailureCode
  exit $LocalExitStatus
}

function Invoke-BoundedRemotePhase(
  [string]$EncodedCommand,
  [ValidateSet("parse", "execute")][string]$Phase,
  [int]$TimeoutMilliseconds
) {
  $arguments = @(
    "-T",
    "-i C:\Users\Administrator\.ssh\id_192.168.31.66",
    "-o BatchMode=yes",
    "-o ConnectTimeout=15",
    "-o ConnectionAttempts=1",
    "-o ServerAliveInterval=10",
    "-o ServerAliveCountMax=2",
    "-o IdentitiesOnly=yes",
    "-o StrictHostKeyChecking=yes",
    "-o PasswordAuthentication=no",
    "-o KbdInteractiveAuthentication=no",
    "-o PreferredAuthentications=publickey",
    "-o ForwardAgent=no",
    "admin@192.168.31.66",
    "powershell.exe -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $EncodedCommand"
  ) -join " "

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $sshPath
  $startInfo.Arguments = $arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      $process.Dispose()
      return New-RemotePhaseOutcome $Phase ([byte[]]::new(0)) ([byte[]]::new(0)) `
        $null $null $false $false $false
    }
  } catch {
    $process.Dispose()
    return New-RemotePhaseOutcome $Phase ([byte[]]::new(0)) ([byte[]]::new(0)) `
      $null $null $false $false $false
  }

  $stdoutBuffer = [IO.MemoryStream]::new()
  $stderrBuffer = [IO.MemoryStream]::new()
  $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutBuffer)
  $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrBuffer)
  $timedOut = -not $process.WaitForExit($TimeoutMilliseconds)
  $terminated = $true
  if ($timedOut) {
    try { $process.Kill() } catch {}
    $terminated = $process.WaitForExit(10000)
    if (-not $terminated) {
      try { $process.StandardOutput.BaseStream.Dispose() } catch {}
      try { $process.StandardError.BaseStream.Dispose() } catch {}
    }
  }
  if ($terminated) {
    $stdoutTask.GetAwaiter().GetResult()
    $stderrTask.GetAwaiter().GetResult()
  } else {
    try { [void]$stdoutTask.Wait(1000) } catch {}
    try { [void]$stderrTask.Wait(1000) } catch {}
  }
  $stdoutBytes = $stdoutBuffer.ToArray()
  $stderrBytes = $stderrBuffer.ToArray()
  $exitStatus = if ($timedOut) { $null } else { $process.ExitCode }
  $process.Dispose()
  $stdoutBuffer.Dispose()
  $stderrBuffer.Dispose()

  return New-RemotePhaseOutcome $Phase $stdoutBytes $stderrBytes $exitStatus `
    $null $timedOut $timedOut $true
}

function Assert-SuccessfulRemotePhase([pscustomobject]$Outcome) {
  if (-not $Outcome.started) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_START_FAILED" 125
  }
  if ($Outcome.timeout) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTCOME_AMBIGUOUS" 124
  }
  if ($null -eq $Outcome.exit_status -or $Outcome.exit_status.GetType() -ne [int]) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_EXIT_STATUS_INVALID" 125
  }
  if ($Outcome.exit_status -ne 0) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_REMOTE_EXIT_NONZERO" $Outcome.exit_status
  }
  if ($Outcome.stderr_bytes.Length -ne 0) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_STDERR_NOT_EMPTY" 1
  }
}

function Read-ExactJsonLine([pscustomobject]$Outcome) {
  Assert-SuccessfulRemotePhase $Outcome
  try {
    $output = $strictUtf8.GetString($Outcome.stdout_bytes)
  } catch {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_STDOUT_NOT_UTF8" 1
  }

  if ($output.EndsWith("`r`n")) {
    $line = $output.Substring(0, $output.Length - 2)
  } elseif ($output.EndsWith("`n")) {
    $line = $output.Substring(0, $output.Length - 1)
  } else {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
  if ($line.Length -eq 0 -or $line.Contains("`r") -or $line.Contains("`n")) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
  try {
    return $line | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
}

function Assert-JsonExactObject(
  [AllowNull()][object]$Value,
  [string[]]$ExpectedKeys,
  [pscustomobject]$Outcome
) {
  if ($null -eq $Value -or $Value.GetType() -ne [pscustomobject]) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
  $actualKeys = @($Value.PSObject.Properties.Name | Sort-Object)
  $sortedExpectedKeys = @($ExpectedKeys | Sort-Object)
  if (($actualKeys -join "|") -cne ($sortedExpectedKeys -join "|")) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
}

function Assert-JsonString(
  [AllowNull()][object]$Value,
  [pscustomobject]$Outcome
) {
  if ($null -eq $Value -or $Value.GetType() -ne [string]) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
}

function Assert-JsonNonEmptyString(
  [AllowNull()][object]$Value,
  [pscustomobject]$Outcome
) {
  Assert-JsonString $Value $Outcome
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
}

function Assert-JsonBoolean(
  [AllowNull()][object]$Value,
  [pscustomobject]$Outcome
) {
  if ($null -eq $Value -or $Value.GetType() -ne [bool]) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
}

function Assert-JsonInteger(
  [AllowNull()][object]$Value,
  [pscustomobject]$Outcome
) {
  if ($null -eq $Value -or
    ($Value.GetType() -ne [int] -and $Value.GetType() -ne [long])) {
    Stop-RemotePhase $Outcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
  }
}

$source = [Text.UTF8Encoding]::new($false, $true).GetString($sourceBytes)
$sourceBase64 = [Convert]::ToBase64String($sourceBytes)
$parserHarness = @"
`$ErrorActionPreference = "Stop"
`$ProgressPreference = "SilentlyContinue"
`$sourceBytes = [Convert]::FromBase64String("$sourceBase64")
`$source = [Text.UTF8Encoding]::new(`$false, `$true).GetString(`$sourceBytes)
`$tokens = `$null
`$parseErrors = `$null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  `$source,
  "create-m4f-sync-root.ps1",
  [ref]`$tokens,
  [ref]`$parseErrors
)
`$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  `$hashBytes = `$sha256.ComputeHash(`$sourceBytes)
  `$hash = [BitConverter]::ToString(`$hashBytes).Replace("-", "").ToLowerInvariant()
} finally { `$sha256.Dispose() }
[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-powershell-parse.v1"
  status = "passed"
  source_sha256 = `$hash
  token_count = [int]`$tokens.Count
  error_count = [int]`$parseErrors.Count
} | ConvertTo-Json -Compress))
if (`$null -eq `$parseErrors -or `$parseErrors.Count -ne 0 -or
  `$null -eq `$tokens -or `$tokens.Count -lt 1) { exit 1 }
exit 0
"@
$parseCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parserHarness))
$parseOutcome = Invoke-BoundedRemotePhase $parseCommand "parse" $phaseTimeoutMilliseconds
$parseResult = Read-ExactJsonLine $parseOutcome
$expectedParseKeys = @("error_count", "schema", "source_sha256", "status", "token_count")
Assert-JsonExactObject $parseResult $expectedParseKeys $parseOutcome
Assert-JsonString $parseResult.schema $parseOutcome
Assert-JsonString $parseResult.status $parseOutcome
Assert-JsonString $parseResult.source_sha256 $parseOutcome
Assert-JsonInteger $parseResult.token_count $parseOutcome
Assert-JsonInteger $parseResult.error_count $parseOutcome
if ($parseResult.schema -cne "synthia-m4f-powershell-parse.v1" -or
  $parseResult.status -cne "passed" -or
  $parseResult.source_sha256 -cne $expectedSourceSha256 -or
  $parseResult.token_count -lt 1 -or
  $parseResult.error_count -ne 0) {
  Stop-RemotePhase $parseOutcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
}

$executeCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
$executeOutcome = Invoke-BoundedRemotePhase $executeCommand "execute" $phaseTimeoutMilliseconds
$result = Read-ExactJsonLine $executeOutcome

$expectedKeys = @(
  "alternate_streams",
  "disk_number",
  "disk_unique_id",
  "empty",
  "explicit_ace_count",
  "logical_volume_serial",
  "owner_sid",
  "partition_number",
  "protected",
  "reparse",
  "schema",
  "status",
  "sync_root",
  "volume_serial_number",
  "volume_unique_id"
)
Assert-JsonExactObject $result $expectedKeys $executeOutcome
foreach ($property in @("schema", "status", "sync_root", "owner_sid")) {
  Assert-JsonString $result.$property $executeOutcome
}
foreach ($property in @(
  "logical_volume_serial",
  "volume_unique_id",
  "volume_serial_number",
  "disk_unique_id"
)) {
  Assert-JsonNonEmptyString $result.$property $executeOutcome
}
foreach ($property in @("disk_number", "partition_number", "explicit_ace_count")) {
  Assert-JsonInteger $result.$property $executeOutcome
}
foreach ($property in @("protected", "empty", "reparse", "alternate_streams")) {
  Assert-JsonBoolean $result.$property $executeOutcome
}
if ($result.schema -cne "synthia-m4f-sync-root.v1" -or
  $result.status -cne "passed" -or
  $result.sync_root -cne "C:\Windows\Temp\synthia-m4f-sync-20260827-03" -or
  $result.owner_sid -cne "S-1-5-32-544" -or
  $result.volume_serial_number -cne $result.logical_volume_serial -or
  $result.disk_number -lt 0 -or
  $result.partition_number -lt 1 -or
  $result.protected -ne $true -or
  $result.explicit_ace_count -ne 2 -or
  $result.empty -ne $true -or
  $result.reparse -ne $false -or
  $result.alternate_streams -ne $false) {
  Stop-RemotePhase $executeOutcome "M4F_SYNC_TRANSPORT_OUTPUT_INVALID" 1
}

[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-sync-root-ceremony.v1"
  status = "passed"
  parse = $parseResult
  execute = $result
} | ConvertTo-Json -Compress))
exit 0
