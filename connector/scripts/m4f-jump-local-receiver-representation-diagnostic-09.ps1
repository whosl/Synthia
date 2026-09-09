
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$expectedComputer = "DESKTOP-E380LR7"
$expectedIdentityName = "desktop-e380lr7\administrator"
$expectedIdentitySid = "S-1-5-21-3442870711-319385569-2277832987-500"
$powershellPath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
$expectedEncodedLength = 3256
$expectedEncodedSha256 = "ec4bb477e8e7bd0c08551837b21ad90e06aaa3bab11e95b44cef5dee0b6a22bb"
$maximumCommandBytes = 8192
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
  $candidate = if ($commandBytes.Length -eq 3346 -and $commandSha -ceq "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2") { "basename_exact" }
    elseif ($commandBytes.Length -eq 3389 -and $commandSha -ceq "a0d79d8992e881d114cd4f70e6b916978e372160fb06e3a2bd781bdeb20d074f") { "fixed_exact" }
    elseif ($commandBytes.Length -eq 3391 -and $commandSha -ceq "21521202d8b45084d75ec2d797b1214e41da760efcbe93e340b68ca2fb3fd251") { "quoted_exact" }
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
  schema = "synthia-m4f-current-receiver-representation-diagnostic-09.v1"
  predecessor_attempt = [ordered]@{ schema = "synthia-m4f-predecessor-effect-09.v1"; attempt = "_08"; effect_state = "unknown"; queried = $false; cleanup_attempted = $false }
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
    basename_command_sha256 = "facefc9fa05a87804412bd8ab6cff5364a35c84f10413454d308c16f42fc9dc2"
    fixed_command_length = 3389
    fixed_command_sha256 = "a0d79d8992e881d114cd4f70e6b916978e372160fb06e3a2bd781bdeb20d074f"
    quoted_command_length = 3391
    quoted_command_sha256 = "21521202d8b45084d75ec2d797b1214e41da760efcbe93e340b68ca2fb3fd251"
  }
  actual = $actual
  classification = $classification
}
$json = $output | ConvertTo-Json -Depth 5 -Compress
if ($strictUtf8.GetByteCount($json) -gt 1048576) { throw "M4F_RECEIVER_REPRESENTATION_OUTPUT_BOUND" }
[Console]::Out.WriteLine($json)
