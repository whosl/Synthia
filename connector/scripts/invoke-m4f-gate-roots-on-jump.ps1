[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$totalTimeoutMilliseconds = 120000

$sshPath = "C:\Windows\System32\OpenSSH\ssh.exe"
$remoteHelperPath = "C:\Windows\Temp\synthia-m4f-sync-20260827-03\create-m4f-gate-roots.ps1"
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
  "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $remoteHelperPath"
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
if (-not $process.Start()) { throw "M4F_GATE_ROOT_TRANSPORT_START_FAILED" }
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit($totalTimeoutMilliseconds)) {
  try { $process.Kill() } catch {}
  [void]$process.WaitForExit(10000)
  $process.Dispose()
  [Console]::Error.WriteLine("M4F_GATE_ROOT_TRANSPORT_OUTCOME_AMBIGUOUS")
  exit 124
}
$process.WaitForExit()
$standardOutput = $stdoutTask.GetAwaiter().GetResult()
$standardError = $stderrTask.GetAwaiter().GetResult()
$remoteExitCode = $process.ExitCode
$process.Dispose()

if ($remoteExitCode -ne 0) {
  if ($standardError) { [Console]::Error.Write($standardError) }
  if ($standardOutput) { [Console]::Error.Write($standardOutput) }
  exit $remoteExitCode
}
if ($standardError.Length -ne 0) {
  [Console]::Error.Write($standardError)
  throw "M4F_GATE_ROOT_TRANSPORT_STDERR_NOT_EMPTY"
}

$lines = @($standardOutput -split "`r?`n" | Where-Object { $_.Length -ne 0 })
if ($lines.Count -ne 1) { throw "M4F_GATE_ROOT_TRANSPORT_OUTPUT_INVALID" }
try { $result = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
catch { throw "M4F_GATE_ROOT_TRANSPORT_OUTPUT_INVALID" }

$expectedKeys = @(
  "alternate_streams",
  "backing_disk_unique_id",
  "backing_root",
  "backing_volume_serial",
  "backing_volume_unique_id",
  "empty",
  "explicit_ace_count",
  "gate_disk_unique_id",
  "gate_root",
  "gate_volume_serial",
  "gate_volume_unique_id",
  "owner_sid",
  "protected",
  "reparse",
  "schema",
  "service_identity_sid",
  "status"
)
$actualKeys = @($result.PSObject.Properties.Name | Sort-Object)
if (($actualKeys -join "|") -cne ($expectedKeys -join "|")) {
  throw "M4F_GATE_ROOT_TRANSPORT_OUTPUT_INVALID"
}
if ([string]$result.schema -cne "synthia-m4f-gate-roots.v1" -or
  [string]$result.status -cne "passed" -or
  [string]$result.gate_root -cne "C:\Windows\Temp\synthia-m4f-20260827-03" -or
  [string]$result.backing_root -cne "D:\synthia-m4f-toolchain-20260827-03" -or
  [string]$result.owner_sid -cne "S-1-5-32-544" -or
  [string]$result.service_identity_sid -cne "S-1-5-19" -or
  [string]::IsNullOrWhiteSpace([string]$result.gate_volume_serial) -or
  [string]::IsNullOrWhiteSpace([string]$result.backing_volume_serial) -or
  [string]::IsNullOrWhiteSpace([string]$result.gate_volume_unique_id) -or
  [string]::IsNullOrWhiteSpace([string]$result.backing_volume_unique_id) -or
  [string]::IsNullOrWhiteSpace([string]$result.gate_disk_unique_id) -or
  [string]::IsNullOrWhiteSpace([string]$result.backing_disk_unique_id) -or
  $result.protected -ne $true -or
  [int]$result.explicit_ace_count -ne 3 -or
  $result.empty -ne $true -or
  $result.reparse -ne $false -or
  $result.alternate_streams -ne $false) {
  throw "M4F_GATE_ROOT_TRANSPORT_OUTPUT_INVALID"
}

[Console]::Out.WriteLine($lines[0])
exit 0
