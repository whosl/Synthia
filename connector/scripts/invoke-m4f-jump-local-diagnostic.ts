import { createHash } from "node:crypto";
import {
  BOUND_JUMP_RECEIVER_COMMAND_LENGTH,
  BOUND_JUMP_RECEIVER_ENCODED_SHA256,
  BOUND_JUMP_RECEIVER_SOURCE_SHA256,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  invokeBoundJumpPhase,
  runCeremony,
} from "./m4f-bound-jump-transport.ts";

const CONFIRMATION = "SYNTHIA_M4F_JUMP_LOCAL_DIAGNOSTIC_20260827_04";
const SSH_PATH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const IDENTITY_PATH = "C:\\Users\\Administrator\\.ssh\\id_192.168.31.66";
const JUMP_COMPUTER = "DESKTOP-E380LR7";
const JUMP_IDENTITY_NAME = "desktop-e380lr7\\administrator";
const JUMP_IDENTITY_SID = "S-1-5-21-3442870711-319385569-2277832987-500";
const MASTER_EFFECTIVE_CONFIG_SHA256 = "7868e5c5d245aeabf0c5c5b9ff79ad260e0a0c047dcaa5c15e799d89a0e25fa9";
const CHILD_EFFECTIVE_CONFIG_SHA256 = "26cefa2f7e6a28fc1dd985e0fdeedceb144279aa0ac3372f9b897b95af4391c8";
const MASTER_NETWORK_SHA256 = "02c94dce4f86ac0627bb4d1a960ff8fb1dd6cfc1bcb6f77cfaccb20387c7d6f1";
const TRUSTED_OWNER_SIDS = new Set([
  JUMP_IDENTITY_SID,
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const KEY_TRUSTED_SIDS = new Set([
  JUMP_IDENTITY_SID,
  "S-1-5-18",
  "S-1-5-32-544",
]);
const KEY_UNTRUSTED_FORBIDDEN_MASK = 852_311;
const ANCESTOR_REPLACE_MASK = 852_032;
const LEAF_REPLACE_MASK = 852_310;
const MAX_ACCESS_RULES = 64;
const MAX_EXCEPTION_MESSAGE_BYTES = 8_192;
const MAX_PROBE_STREAM_BYTES = 65_536;
const PROBE_TIMEOUT_MILLISECONDS = 10_000;
const PROBE_STOP_WAIT_MILLISECONDS = 5_000;
const OUTER_TRANSPORT_TIMEOUT_MILLISECONDS = 90_000;

export const JUMP_LOCAL_DIAGNOSTIC_ARTIFACT = String.raw`
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$sshPath = "${SSH_PATH}"
$identityPath = "${IDENTITY_PATH}"
$expectedComputer = "${JUMP_COMPUTER}"
$expectedIdentityName = "${JUMP_IDENTITY_NAME}"
$expectedIdentitySid = "${JUMP_IDENTITY_SID}"
$probeTimeoutMilliseconds = ${PROBE_TIMEOUT_MILLISECONDS}
$probeStopWaitMilliseconds = ${PROBE_STOP_WAIT_MILLISECONDS}
$maxAccessRules = ${MAX_ACCESS_RULES}
$maxExceptionMessageBytes = ${MAX_EXCEPTION_MESSAGE_BYTES}
$maxProbeStreamBytes = ${MAX_PROBE_STREAM_BYTES}
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$trustedInstallerSid = ([Security.Principal.NTAccount]"NT SERVICE\TrustedInstaller").Translate(
  [Security.Principal.SecurityIdentifier]
)
$script:nativeFileIdentityType = $null

function Fail([string]$Code, [string]$Detail = "") {
  if ($Detail) { throw ("{0}:{1}" -f $Code, $Detail) }
  throw $Code
}

function Get-ReadOnlySha256([string]$Path) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-BytesSha256([byte[]]$Bytes) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($Bytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Open-StableFileIdentityHandle([string]$Path) {
  if ($null -eq $script:nativeFileIdentityType) {
    $assemblyName = [Reflection.AssemblyName]::new("SynthiaM4fReadOnlyNative")
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
      $assemblyName,
      [Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $module = $assembly.DefineDynamicModule("SynthiaM4fReadOnlyNative")
    $type = $module.DefineType(
      "SynthiaM4fReadOnlyNativeMethods",
      [Reflection.TypeAttributes]::Public -bor
        [Reflection.TypeAttributes]::Sealed -bor
        [Reflection.TypeAttributes]::Abstract
    )
    $methodAttributes = [Reflection.MethodAttributes]::Public -bor
      [Reflection.MethodAttributes]::Static -bor
      [Reflection.MethodAttributes]::PinvokeImpl
    $createFile = $type.DefinePInvokeMethod(
      "CreateFileW",
      "kernel32.dll",
      $methodAttributes,
      [Reflection.CallingConventions]::Standard,
      [IntPtr],
      [Type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]),
      [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Unicode
    )
    $createFile.SetImplementationFlags(
      $createFile.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig
    )
    $getInformation = $type.DefinePInvokeMethod(
      "GetFileInformationByHandle",
      "kernel32.dll",
      $methodAttributes,
      [Reflection.CallingConventions]::Standard,
      [bool],
      [Type[]]@([IntPtr], [IntPtr]),
      [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Auto
    )
    $getInformation.SetImplementationFlags(
      $getInformation.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig
    )
    $closeHandle = $type.DefinePInvokeMethod(
      "CloseHandle",
      "kernel32.dll",
      $methodAttributes,
      [Reflection.CallingConventions]::Standard,
      [bool],
      [Type[]]@([IntPtr]),
      [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Auto
    )
    $closeHandle.SetImplementationFlags(
      $closeHandle.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig
    )
    $script:nativeFileIdentityType = $type.CreateType()
  }
  $handle = $script:nativeFileIdentityType::CreateFileW(
    $Path,
    [uint32]0,
    [uint32]1,
    [IntPtr]::Zero,
    [uint32]3,
    [uint32]0,
    [IntPtr]::Zero
  )
  if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr]::new(-1)) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_IDENTITY_OPEN_FAILED"
  }
  return $handle
}

function Get-StableFileIdentity([IntPtr]$Handle) {
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    if (-not $script:nativeFileIdentityType::GetFileInformationByHandle($Handle, $buffer)) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_IDENTITY_QUERY_FAILED"
    }
    $bytes = [byte[]]::new(52)
    [Runtime.InteropServices.Marshal]::Copy($buffer, $bytes, 0, $bytes.Length)
    return [ordered]@{
      volume_serial_number = "{0:x8}" -f [BitConverter]::ToUInt32($bytes, 28)
      file_id = "{0:x8}{1:x8}" -f
        [BitConverter]::ToUInt32($bytes, 44),
        [BitConverter]::ToUInt32($bytes, 48)
      hard_link_count = [uint32][BitConverter]::ToUInt32($bytes, 40)
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
}

function Close-StableFileIdentityHandle([IntPtr]$Handle) {
  if ($Handle -ne [IntPtr]::Zero -and
    $Handle -ne [IntPtr]::new(-1) -and
    -not $script:nativeFileIdentityType::CloseHandle($Handle)) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_IDENTITY_CLOSE_FAILED"
  }
}

function Get-CanonicalAccessRules([object]$Acl) {
  $rules = @($Acl.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    ))
  if ($rules.Count -gt $maxAccessRules) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_ACCESS_RULE_BOUND" ([string]$rules.Count)
  }
  $result = @()
  foreach ($rule in $rules) {
    if ($rule.IdentityReference -isnot [Security.Principal.SecurityIdentifier]) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_IDENTITY_UNRESOLVED"
    }
    $result += [pscustomobject][ordered]@{
      sid = [string]$rule.IdentityReference.Value
      access_control_type = [string]$rule.AccessControlType
      file_system_rights = [int64]$rule.FileSystemRights
      inheritance_flags = [int]$rule.InheritanceFlags
      propagation_flags = [int]$rule.PropagationFlags
      is_inherited = [bool]$rule.IsInherited
    }
  }
  $sorted = @($result | Sort-Object sid, access_control_type, file_system_rights, inheritance_flags, propagation_flags, is_inherited)
  $seen = @{}
  $effects = @()
  foreach ($rule in $sorted) {
    $binding = "{0}|{1}|{2}|{3}|{4}|{5}" -f
      $rule.sid,
      $rule.access_control_type,
      $rule.file_system_rights,
      $rule.inheritance_flags,
      $rule.propagation_flags,
      $rule.is_inherited
    if ($seen.ContainsKey($binding)) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_ACCESS_RULE_DUPLICATE"
    }
    foreach ($effect in $effects) {
      if ($effect.sid -ceq $rule.sid -and
        $effect.access_control_type -cne $rule.access_control_type -and
        (($effect.file_system_rights -band $rule.file_system_rights) -ne 0)) {
        Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_ACCESS_RULE_CONFLICT"
      }
    }
    $seen[$binding] = $true
    $effects += $rule
  }
  return $sorted
}

function Assert-NoUntrustedReplace([string]$Path, [bool]$Leaf) {
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  $rules = @(Get-CanonicalAccessRules $acl)
  $trusted = @(
    $expectedIdentitySid,
    $administratorsSid.Value,
    $systemSid.Value,
    $trustedInstallerSid.Value
  )
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner -isnot [Security.Principal.SecurityIdentifier] -or
    -not ($trusted -ccontains $owner.Value)) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_UNTRUSTED_OWNER" $Path
  }
  $ancestorReplaceMask = [int64](
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $leafReplaceMask = [int64](
    $ancestorReplaceMask -bor
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes
  )
  $replaceMask = if ($Leaf) { $leafReplaceMask } else { $ancestorReplaceMask }
  foreach ($rule in $rules) {
    if ($rule.access_control_type -ceq "Allow" -and
      -not ($trusted -ccontains $rule.sid) -and
      (($rule.propagation_flags -band 2) -eq 0) -and
      (($rule.file_system_rights -band $replaceMask) -ne 0)) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_UNTRUSTED_REPLACE" $Path
    }
  }
}

function Get-AncestorFacts([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($root)) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_ANCESTOR_SCOPE"
  }
  $current = Get-Item -LiteralPath (Split-Path -Parent $fullPath) -Force -ErrorAction Stop
  $facts = @()
  while ($null -ne $current) {
    if ($current -isnot [IO.DirectoryInfo] -or
      (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_ANCESTOR_INVALID" $current.FullName
    }
    Assert-NoUntrustedReplace $current.FullName $false
    $acl = Get-Acl -LiteralPath $current.FullName -ErrorAction Stop
    $rules = @(Get-CanonicalAccessRules $acl)
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($owner -isnot [Security.Principal.SecurityIdentifier]) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_IDENTITY_UNRESOLVED"
    }
    $facts += [ordered]@{
      schema = "synthia-m4f-jump-local-ancestor-fact.v1"
      path = [string]$current.FullName
      directory_info = $true
      reparse = $false
      owner_sid = [string]$owner.Value
      access_rules_protected = [bool]$acl.AreAccessRulesProtected
      access_rule_count = [int]$rules.Count
      access_rules = $rules
    }
    if ($current.FullName.TrimEnd('\').Equals(
        $root.TrimEnd('\'),
        [StringComparison]::OrdinalIgnoreCase
      )) {
      return @($facts)
    }
    $current = $current.Parent
  }
  Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_ANCESTOR_INCOMPLETE" $Path
}

function Get-BaseFileFact([string]$Kind, [string]$Path, [int64]$MaximumLength) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_MISSING" $Kind
  }
  $ancestors = @(Get-AncestorFacts $Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item -isnot [IO.FileInfo] -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
    $item.Length -lt 1 -or
    $item.Length -gt $MaximumLength) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_INVALID" $Kind
  }
  if ($item.FullName -cne $Path) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_CANONICAL_PATH_INVALID" $Kind
  }
  return [ordered]@{
    item = $item
    ancestors = $ancestors
  }
}

function Get-SshFact {
  $base = Get-BaseFileFact "ssh_executable" $sshPath 104857600
  $item = $base.item
  Assert-NoUntrustedReplace $sshPath $true
  $acl = Get-Acl -LiteralPath $sshPath -ErrorAction Stop
  $rules = @(Get-CanonicalAccessRules $acl)
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner -isnot [Security.Principal.SecurityIdentifier]) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_IDENTITY_UNRESOLVED"
  }
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($sshPath)
  if ([string]::IsNullOrWhiteSpace([string]$version.FileVersion)) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_FILE_VERSION_INVALID"
  }
  return [ordered]@{
    schema = "synthia-m4f-jump-local-ssh-fact.v1"
    path = $sshPath
    actual_full_name = [string]$item.FullName
    length = [int64]$item.Length
    sha256 = Get-ReadOnlySha256 $sshPath
    file_version = [string]$version.FileVersion
    owner_sid = [string]$owner.Value
    access_rules_protected = [bool]$acl.AreAccessRulesProtected
    access_rule_count = [int]$rules.Count
    access_rules = $rules
    ancestor_count = [int]$base.ancestors.Count
    ancestors = @($base.ancestors)
  }
}

function Get-IdentityFact([IntPtr]$IdentityHandle) {
  $base = Get-BaseFileFact "identity_file" $identityPath 65536
  $item = $base.item
  $acl = Get-Acl -LiteralPath $identityPath -ErrorAction Stop
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  $keyTrusted = @($expectedIdentitySid, $administratorsSid.Value, $systemSid.Value)
  if ($owner -isnot [Security.Principal.SecurityIdentifier] -or
    -not ($keyTrusted -ccontains $owner.Value) -or
    -not $acl.AreAccessRulesProtected) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_KEY_ACL_INVALID"
  }
  $rules = @(Get-CanonicalAccessRules $acl)
  $stableIdentity = Get-StableFileIdentity $IdentityHandle
  if ($stableIdentity.hard_link_count -ne 1) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_KEY_HARD_LINK_INVALID"
  }
  if ($rules.Count -lt 1 -or $rules.Count -gt $keyTrusted.Count) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_KEY_ACL_INVALID"
  }
  $seen = @{}
  $userRead = $false
  $untrustedForbiddenMask = [int64](
    [Security.AccessControl.FileSystemRights]::ReadData -bor
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  foreach ($rule in $rules) {
    if ($rule.access_control_type -ceq "Allow" -and
      -not ($keyTrusted -ccontains $rule.sid) -and
      (($rule.file_system_rights -band $untrustedForbiddenMask) -ne 0)) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_KEY_UNTRUSTED_ACCESS"
    }
    if (-not ($keyTrusted -ccontains $rule.sid) -or
      $seen.ContainsKey($rule.sid) -or
      $rule.access_control_type -cne "Allow" -or
      $rule.is_inherited -or
      $rule.inheritance_flags -ne 0 -or
      $rule.propagation_flags -ne 0 -or
      (($rule.file_system_rights -band [int64][Security.AccessControl.FileSystemRights]::ReadData) -eq 0)) {
      Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_KEY_ACL_INVALID"
    }
    if ($rule.sid -ceq $expectedIdentitySid -and
      (($rule.file_system_rights -band [int64][Security.AccessControl.FileSystemRights]::ReadData) -ne 0)) {
      $userRead = $true
    }
    $seen[$rule.sid] = $true
  }
  if (-not $userRead) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_KEY_USER_READ_REQUIRED"
  }
  return [ordered]@{
    schema = "synthia-m4f-jump-local-key-fact.v1"
    observation_scope = "metadata_and_acl_only"
    path = $identityPath
    actual_full_name = [string]$item.FullName
    length = [int64]$item.Length
    creation_time_utc = $item.CreationTimeUtc.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    last_write_time_utc = $item.LastWriteTimeUtc.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    volume_serial_number = $stableIdentity.volume_serial_number
    file_id = $stableIdentity.file_id
    hard_link_count = [uint32]$stableIdentity.hard_link_count
    owner_sid = [string]$owner.Value
    access_rules_protected = $true
    access_rule_count = [int]$rules.Count
    access_rules = $rules
    ancestor_count = [int]$base.ancestors.Count
    ancestors = @($base.ancestors)
  }
}

function Get-ExceptionFact([Exception]$Exception) {
  $messageBytes = $strictUtf8.GetBytes([string]$Exception.Message)
  if ($messageBytes.Length -gt $maxExceptionMessageBytes) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_EXCEPTION_MESSAGE_BOUND"
  }
  $nativeErrorCode = $null
  if ($Exception -is [ComponentModel.Win32Exception]) {
    $nativeErrorCode = [int]$Exception.NativeErrorCode
  }
  return [ordered]@{
    schema = "synthia-m4f-jump-local-exception.v1"
    type = [string]($Exception.GetType().FullName)
    hresult = [int]$Exception.HResult
    native_error_code = $nativeErrorCode
    message_utf8_length = [int]$messageBytes.Length
    message_utf8_sha256 = Get-BytesSha256 $messageBytes
    message_utf8_base64 = [Convert]::ToBase64String($messageBytes)
  }
}

function Get-StreamFact([IO.MemoryStream]$Stream) {
  $bytes = $Stream.ToArray()
  if ($bytes.Length -gt $maxProbeStreamBytes) {
    Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_STREAM_BOUND"
  }
  return [ordered]@{
    length = [int]$bytes.Length
    sha256 = Get-BytesSha256 $bytes
    base64 = [Convert]::ToBase64String($bytes)
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
  Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_IDENTITY_INVALID"
}

$identityHandle = Open-StableFileIdentityHandle $identityPath
$sshBefore = Get-SshFact
$identityBefore = Get-IdentityFact $identityHandle
$process = $null
$stdoutBuffer = [IO.MemoryStream]::new()
$stderrBuffer = [IO.MemoryStream]::new()
$stdoutChunk = [byte[]]::new(4096)
$stderrChunk = [byte[]]::new(4096)
$stdoutRead = $null
$stderrRead = $null
$stdoutDone = $false
$stderrDone = $false
$started = $false
$probe = $null
try {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $sshPath
  $startInfo.Arguments = "-V"
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw [InvalidOperationException]::new("Process.Start returned false")
  }
  $started = $true
  $process.StandardInput.Close()
  $stdoutRead = $process.StandardOutput.BaseStream.ReadAsync($stdoutChunk, 0, $stdoutChunk.Length)
  $stderrRead = $process.StandardError.BaseStream.ReadAsync($stderrChunk, 0, $stderrChunk.Length)
  $probeClock = [Diagnostics.Stopwatch]::StartNew()
  while (-not ($stdoutDone -and $stderrDone -and $process.HasExited) -and
    $probeClock.ElapsedMilliseconds -lt $probeTimeoutMilliseconds) {
    if (-not $stdoutDone -and $stdoutRead.IsCompleted) {
      $count = [int]$stdoutRead.GetAwaiter().GetResult()
      if ($count -eq 0) { $stdoutDone = $true } else {
        if (($stdoutBuffer.Length + $count) -gt $maxProbeStreamBytes) {
          Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_STREAM_BOUND" "stdout"
        }
        $stdoutBuffer.Write($stdoutChunk, 0, $count)
        $stdoutRead = $process.StandardOutput.BaseStream.ReadAsync($stdoutChunk, 0, $stdoutChunk.Length)
      }
    }
    if (-not $stderrDone -and $stderrRead.IsCompleted) {
      $count = [int]$stderrRead.GetAwaiter().GetResult()
      if ($count -eq 0) { $stderrDone = $true } else {
        if (($stderrBuffer.Length + $count) -gt $maxProbeStreamBytes) {
          Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_STREAM_BOUND" "stderr"
        }
        $stderrBuffer.Write($stderrChunk, 0, $count)
        $stderrRead = $process.StandardError.BaseStream.ReadAsync($stderrChunk, 0, $stderrChunk.Length)
      }
    }
    [Threading.Thread]::Sleep(5)
  }
  $probeClock.Stop()
  if ($process.HasExited -and $stdoutDone -and $stderrDone) {
    $probe = [ordered]@{
      state = "exited"
      ambiguous = $false
      start_call_locally_timed = $false
      start_call_bound = "outer_transport_only"
      outer_transport_timeout_milliseconds = ${OUTER_TRANSPORT_TIMEOUT_MILLISECONDS}
      output_complete = $true
      executable = $sshPath
      arguments = @("-V")
      use_shell_execute = $false
      redirect_standard_input = $true
      redirect_standard_output = $true
      redirect_standard_error = $true
      create_no_window = $true
      timeout_milliseconds = $probeTimeoutMilliseconds
      exit_status = [int]$process.ExitCode
      stdout = Get-StreamFact $stdoutBuffer
      stderr = Get-StreamFact $stderrBuffer
    }
  } else {
    $triggerException = [TimeoutException]::new("ssh -V exceeded the bounded probe interval")
    $killException = $null
    try { $process.Kill() } catch { $killException = $_.Exception }
    $waitException = $null
    $waitForExitResult = $null
    try { $waitForExitResult = [bool]$process.WaitForExit($probeStopWaitMilliseconds) } catch {
      $waitException = $_.Exception
    }
    $terminationConfirmed = $waitForExitResult -eq $true
    if ($terminationConfirmed) {
      $drainClock = [Diagnostics.Stopwatch]::StartNew()
      while (-not ($stdoutDone -and $stderrDone) -and
        $drainClock.ElapsedMilliseconds -lt $probeStopWaitMilliseconds) {
        if (-not $stdoutDone -and $stdoutRead.IsCompleted) {
          $count = [int]$stdoutRead.GetAwaiter().GetResult()
          if ($count -eq 0) { $stdoutDone = $true } else {
            if (($stdoutBuffer.Length + $count) -gt $maxProbeStreamBytes) {
              Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_STREAM_BOUND" "stdout"
            }
            $stdoutBuffer.Write($stdoutChunk, 0, $count)
            $stdoutRead = $process.StandardOutput.BaseStream.ReadAsync($stdoutChunk, 0, $stdoutChunk.Length)
          }
        }
        if (-not $stderrDone -and $stderrRead.IsCompleted) {
          $count = [int]$stderrRead.GetAwaiter().GetResult()
          if ($count -eq 0) { $stderrDone = $true } else {
            if (($stderrBuffer.Length + $count) -gt $maxProbeStreamBytes) {
              Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_STREAM_BOUND" "stderr"
            }
            $stderrBuffer.Write($stderrChunk, 0, $count)
            $stderrRead = $process.StandardError.BaseStream.ReadAsync($stderrChunk, 0, $stderrChunk.Length)
          }
        }
        [Threading.Thread]::Sleep(5)
      }
      $drainClock.Stop()
    }
    if ($terminationConfirmed) {
      $probe = [ordered]@{
        state = "timed_out"
        ambiguous = $true
        start_call_locally_timed = $false
        start_call_bound = "outer_transport_only"
        outer_transport_timeout_milliseconds = ${OUTER_TRANSPORT_TIMEOUT_MILLISECONDS}
        output_complete = [bool]($stdoutDone -and $stderrDone)
        executable = $sshPath
        arguments = @("-V")
        use_shell_execute = $false
        redirect_standard_input = $true
        redirect_standard_output = $true
        redirect_standard_error = $true
        create_no_window = $true
        timeout_milliseconds = $probeTimeoutMilliseconds
        exit_status = [int]$process.ExitCode
        stdout = Get-StreamFact $stdoutBuffer
        stderr = Get-StreamFact $stderrBuffer
        exception = Get-ExceptionFact $triggerException
        kill_attempted = $true
        kill_exception = if ($null -eq $killException) { $null } else { Get-ExceptionFact $killException }
        wait_for_exit_result = $true
        wait_exception = if ($null -eq $waitException) { $null } else { Get-ExceptionFact $waitException }
      }
    } else {
      $probe = [ordered]@{
        state = "termination_unconfirmed"
        ambiguous = $true
        start_call_locally_timed = $false
        start_call_bound = "outer_transport_only"
        outer_transport_timeout_milliseconds = ${OUTER_TRANSPORT_TIMEOUT_MILLISECONDS}
        output_complete = [bool]($stdoutDone -and $stderrDone)
        executable = $sshPath
        arguments = @("-V")
        use_shell_execute = $false
        redirect_standard_input = $true
        redirect_standard_output = $true
        redirect_standard_error = $true
        create_no_window = $true
        timeout_milliseconds = $probeTimeoutMilliseconds
        exit_status = $null
        stdout = Get-StreamFact $stdoutBuffer
        stderr = Get-StreamFact $stderrBuffer
        trigger_exception = Get-ExceptionFact $triggerException
        kill_attempted = $true
        kill_exception = if ($null -eq $killException) { $null } else { Get-ExceptionFact $killException }
        wait_for_exit_result = $waitForExitResult
        wait_exception = if ($null -eq $waitException) { $null } else { Get-ExceptionFact $waitException }
      }
    }
  }
} catch {
  if (-not $started) {
    $probe = [ordered]@{
      state = "start_failed"
      ambiguous = $false
      start_call_locally_timed = $false
      start_call_bound = "outer_transport_only"
      outer_transport_timeout_milliseconds = ${OUTER_TRANSPORT_TIMEOUT_MILLISECONDS}
      executable = $sshPath
      arguments = @("-V")
      use_shell_execute = $false
      redirect_standard_input = $true
      redirect_standard_output = $true
      redirect_standard_error = $true
      create_no_window = $true
      timeout_milliseconds = $probeTimeoutMilliseconds
      exception = Get-ExceptionFact $_.Exception
    }
  } else {
    $triggerException = $_.Exception
    $killException = $null
    try { $process.Kill() } catch { $killException = $_.Exception }
    $waitException = $null
    $waitForExitResult = $null
    try { $waitForExitResult = [bool]$process.WaitForExit($probeStopWaitMilliseconds) } catch {
      $waitException = $_.Exception
    }
    $terminationConfirmed = $waitForExitResult -eq $true
    if ($terminationConfirmed) {
      $probe = [ordered]@{
        state = "timed_out"
        ambiguous = $true
        start_call_locally_timed = $false
        start_call_bound = "outer_transport_only"
        outer_transport_timeout_milliseconds = ${OUTER_TRANSPORT_TIMEOUT_MILLISECONDS}
        output_complete = [bool]($stdoutDone -and $stderrDone)
        executable = $sshPath
        arguments = @("-V")
        use_shell_execute = $false
        redirect_standard_input = $true
        redirect_standard_output = $true
        redirect_standard_error = $true
        create_no_window = $true
        timeout_milliseconds = $probeTimeoutMilliseconds
        exit_status = [int]$process.ExitCode
        stdout = Get-StreamFact $stdoutBuffer
        stderr = Get-StreamFact $stderrBuffer
        exception = Get-ExceptionFact $triggerException
        kill_attempted = $true
        kill_exception = if ($null -eq $killException) { $null } else { Get-ExceptionFact $killException }
        wait_for_exit_result = $true
        wait_exception = if ($null -eq $waitException) { $null } else { Get-ExceptionFact $waitException }
      }
    } else {
      $probe = [ordered]@{
        state = "termination_unconfirmed"
        ambiguous = $true
        start_call_locally_timed = $false
        start_call_bound = "outer_transport_only"
        outer_transport_timeout_milliseconds = ${OUTER_TRANSPORT_TIMEOUT_MILLISECONDS}
        output_complete = [bool]($stdoutDone -and $stderrDone)
        executable = $sshPath
        arguments = @("-V")
        use_shell_execute = $false
        redirect_standard_input = $true
        redirect_standard_output = $true
        redirect_standard_error = $true
        create_no_window = $true
        timeout_milliseconds = $probeTimeoutMilliseconds
        exit_status = $null
        stdout = Get-StreamFact $stdoutBuffer
        stderr = Get-StreamFact $stderrBuffer
        trigger_exception = Get-ExceptionFact $triggerException
        kill_attempted = $true
        kill_exception = if ($null -eq $killException) { $null } else { Get-ExceptionFact $killException }
        wait_for_exit_result = $waitForExitResult
        wait_exception = if ($null -eq $waitException) { $null } else { Get-ExceptionFact $waitException }
      }
    }
  }
} finally {
  if ($null -ne $process) { $process.Dispose() }
  $stdoutBuffer.Dispose()
  $stderrBuffer.Dispose()
}

$sshAfter = Get-SshFact
$identityAfter = Get-IdentityFact $identityHandle
Close-StableFileIdentityHandle $identityHandle
$identityHandle = [IntPtr]::Zero
$sshBeforeJson = $sshBefore | ConvertTo-Json -Depth 8 -Compress
$sshAfterJson = $sshAfter | ConvertTo-Json -Depth 8 -Compress
$identityBeforeJson = $identityBefore | ConvertTo-Json -Depth 8 -Compress
$identityAfterJson = $identityAfter | ConvertTo-Json -Depth 8 -Compress
if ($sshBeforeJson -cne $sshAfterJson -or $identityBeforeJson -cne $identityAfterJson) {
  Fail "M4F_JUMP_LOCAL_DIAGNOSTIC_SSH_DRIFT"
}

[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-jump-local-diagnostic.v1"
  status = "observed"
  jump_identity = [ordered]@{
    schema = "synthia-m4f-jump-local-identity.v1"
    computer_name = [Environment]::MachineName
    identity_name = $identityName
    identity_sid = $identitySid
    administrator = $true
  }
  powershell = [ordered]@{
    schema = "synthia-m4f-jump-local-powershell.v1"
    ps_version = [string]$PSVersionTable.PSVersion
    ps_edition = [string]$PSVersionTable.PSEdition
    process_id = [int]$PID
    process_bitness = if ([Environment]::Is64BitProcess) { 64 } else { 32 }
    os_bitness = if ([Environment]::Is64BitOperatingSystem) { 64 } else { 32 }
  }
  ssh_before = $sshBefore
  ssh_after = $sshAfter
  identity_before = $identityBefore
  identity_after = $identityAfter
  probe = $probe
} | ConvertTo-Json -Depth 8 -Compress))
`;

export const JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH = Buffer.byteLength(
  JUMP_LOCAL_DIAGNOSTIC_ARTIFACT,
  "utf8",
);
export const JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256 = createHash("sha256")
  .update(Buffer.from(JUMP_LOCAL_DIAGNOSTIC_ARTIFACT, "utf8"))
  .digest("hex");
const EXPECTED_ARTIFACT_LENGTH = 29_219;
const EXPECTED_ARTIFACT_SHA256 = "29ddfc2df266b0989f5abbded4955c20b39f9711c182ae566137d827b67a5922";

if (JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_LENGTH !== EXPECTED_ARTIFACT_LENGTH
  || JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_SHA256 !== EXPECTED_ARTIFACT_SHA256) {
  throw new Error("M4F_JUMP_LOCAL_DIAGNOSTIC_ARTIFACT_DRIFT");
}

function failure(
  code: string,
  currentStage: "confirmation" | "transport" | "validation",
  diagnostic: BoundJumpPhaseResult | null,
  cause: Record<string, unknown> | null,
): never {
  throw new CeremonyFailure({
    schema: "synthia-m4f-jump-local-diagnostic-failure.v1",
    code,
    current_stage: currentStage,
    retry_permitted: false,
    diagnostic,
    cause,
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], stage: string): void {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
}

function objectValue(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") >= minimum
    && Buffer.byteLength(value, "utf8") <= maximum;
}

function canonicalBase64(value: unknown, length: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string"
    || !integer(length, 0, maximumBytes)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.length === length && bytes.toString("base64") === value;
}

function validateAccessRules(value: unknown, expectedCount: unknown, stage: string): void {
  if (!Array.isArray(value)
    || !integer(expectedCount, 0, MAX_ACCESS_RULES)
    || value.length !== expectedCount) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
  const seen = new Set<string>();
  const effects: Array<Record<string, unknown>> = [];
  let previousSortKey: string | null = null;
  for (const [index, candidate] of value.entries()) {
    const rule = objectValue(candidate, `${stage}:${index}`);
    exactKeys(rule, [
      "access_control_type",
      "file_system_rights",
      "inheritance_flags",
      "is_inherited",
      "propagation_flags",
      "sid",
    ], `${stage}:${index}`);
    const binding = JSON.stringify(rule);
    const sortKey = JSON.stringify([
      rule.sid,
      rule.access_control_type,
      rule.file_system_rights,
      rule.inheritance_flags,
      rule.propagation_flags,
      rule.is_inherited,
    ]);
    if (seen.has(binding)
      || !boundedString(rule.sid, 4, 184)
      || !/^S-\d(?:-\d+)+$/u.test(rule.sid)
      || (rule.access_control_type !== "Allow" && rule.access_control_type !== "Deny")
      || !integer(rule.file_system_rights, -2_147_483_648, 2_147_483_647)
      || !integer(rule.inheritance_flags, 0, 3)
      || !integer(rule.propagation_flags, 0, 3)
      || typeof rule.is_inherited !== "boolean") {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
        schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
        stage: `${stage}:${index}`,
      });
    }
    if (previousSortKey !== null) {
      const previous = effects.at(-1)!;
      const comparisons = [
        String(previous.sid).localeCompare(String(rule.sid), "en"),
        String(previous.access_control_type).localeCompare(String(rule.access_control_type), "en"),
        Number(previous.file_system_rights) - Number(rule.file_system_rights),
        Number(previous.inheritance_flags) - Number(rule.inheritance_flags),
        Number(previous.propagation_flags) - Number(rule.propagation_flags),
        Number(previous.is_inherited) - Number(rule.is_inherited),
      ];
      const firstDifference = comparisons.find((comparison) => comparison !== 0) ?? 0;
      if (firstDifference > 0) {
        failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
          schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
          stage: `${stage}:${index}:sort`,
        });
      }
    }
    for (const effect of effects) {
      if (effect.sid === rule.sid
        && effect.access_control_type !== rule.access_control_type
        && typeof effect.file_system_rights === "number"
        && typeof rule.file_system_rights === "number"
        && (effect.file_system_rights & rule.file_system_rights) !== 0) {
        failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
          schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
          stage: `${stage}:${index}:conflict`,
        });
      }
    }
    seen.add(binding);
    effects.push(rule);
    previousSortKey = sortKey;
  }
}

function validateTrustedAcl(fact: Record<string, unknown>, leaf: boolean, stage: string): void {
  if (typeof fact.owner_sid !== "string" || !TRUSTED_OWNER_SIDS.has(fact.owner_sid)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage: `${stage}:owner`,
    });
  }
  const replaceMask = leaf ? LEAF_REPLACE_MASK : ANCESTOR_REPLACE_MASK;
  const rules = fact.access_rules as Array<Record<string, unknown>>;
  if (rules.some((rule) => rule.access_control_type === "Allow"
    && typeof rule.sid === "string"
    && !TRUSTED_OWNER_SIDS.has(rule.sid)
    && typeof rule.file_system_rights === "number"
    && typeof rule.propagation_flags === "number"
    && (rule.propagation_flags & 2) === 0
    && (rule.file_system_rights & replaceMask) !== 0)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage: `${stage}:replace-policy`,
    });
  }
}

function expectedAncestorPaths(leafPath: string): string[] {
  const normalized = leafPath.replaceAll("/", "\\");
  const segments = normalized.split("\\");
  if (segments.length < 2 || !/^[A-Za-z]:$/u.test(segments[0]!)) return [];
  const result: string[] = [];
  for (let end = segments.length - 1; end >= 1; end -= 1) {
    result.push(end === 1 ? `${segments[0]}\\` : segments.slice(0, end).join("\\"));
  }
  return result;
}

function validateAncestors(value: unknown, expectedCount: unknown, leafPath: string, stage: string): void {
  if (!Array.isArray(value)
    || !integer(expectedCount, 1, 32)
    || value.length !== expectedCount) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
  const paths = new Set<string>();
  const expectedPaths = expectedAncestorPaths(leafPath);
  if (value.length !== expectedPaths.length) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
  }
  for (const [index, candidate] of value.entries()) {
    const fact = objectValue(candidate, `${stage}:${index}`);
    exactKeys(fact, [
      "access_rule_count",
      "access_rules",
      "access_rules_protected",
      "directory_info",
      "owner_sid",
      "path",
      "reparse",
      "schema",
    ], `${stage}:${index}`);
    if (fact.schema !== "synthia-m4f-jump-local-ancestor-fact.v1"
      || !boundedString(fact.path, 3, 32_767)
      || paths.has(String(fact.path).toLowerCase())
      || String(fact.path).toLowerCase() !== expectedPaths[index]!.toLowerCase()
      || fact.directory_info !== true
      || fact.reparse !== false
      || !boundedString(fact.owner_sid, 4, 184)
      || !/^S-\d(?:-\d+)+$/u.test(fact.owner_sid)
      || typeof fact.access_rules_protected !== "boolean") {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
        schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
        stage: `${stage}:${index}`,
      });
    }
    paths.add(String(fact.path).toLowerCase());
    validateAccessRules(fact.access_rules, fact.access_rule_count, `${stage}:${index}:access_rules`);
    validateTrustedAcl(fact, false, `${stage}:${index}`);
  }
  const last = value[value.length - 1] as Record<string, unknown>;
  if (typeof last.path !== "string" || !/^[A-Za-z]:\\$/u.test(last.path)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage: `${stage}:root`,
    });
  }
}

function validateSshFact(value: unknown, stage: string): Record<string, unknown> {
  const fact = objectValue(value, stage);
  exactKeys(fact, [
    "access_rule_count",
    "access_rules",
    "access_rules_protected",
    "actual_full_name",
    "ancestor_count",
    "ancestors",
    "file_version",
    "length",
    "owner_sid",
    "path",
    "schema",
    "sha256",
  ], stage);
  if (fact.schema !== "synthia-m4f-jump-local-ssh-fact.v1"
    || fact.path !== SSH_PATH
    || fact.actual_full_name !== SSH_PATH
    || !integer(fact.length, 1, 104_857_600)
    || !boundedString(fact.sha256, 64, 64)
    || !/^[0-9a-f]{64}$/u.test(fact.sha256)
    || !boundedString(fact.file_version, 1, 256)
    || !boundedString(fact.owner_sid, 4, 184)
    || !/^S-\d(?:-\d+)+$/u.test(fact.owner_sid)
    || typeof fact.access_rules_protected !== "boolean") {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
  validateAccessRules(fact.access_rules, fact.access_rule_count, `${stage}:access_rules`);
  validateTrustedAcl(fact, true, stage);
  validateAncestors(fact.ancestors, fact.ancestor_count, SSH_PATH, `${stage}:ancestors`);
  return fact;
}

function validateKeyFact(value: unknown, stage: string): Record<string, unknown> {
  const fact = objectValue(value, stage);
  exactKeys(fact, [
    "access_rule_count",
    "access_rules",
    "access_rules_protected",
    "actual_full_name",
    "ancestor_count",
    "ancestors",
    "creation_time_utc",
    "file_id",
    "hard_link_count",
    "last_write_time_utc",
    "length",
    "observation_scope",
    "owner_sid",
    "path",
    "schema",
    "volume_serial_number",
  ], stage);
  if (fact.schema !== "synthia-m4f-jump-local-key-fact.v1"
    || fact.path !== IDENTITY_PATH
    || fact.actual_full_name !== IDENTITY_PATH
    || fact.observation_scope !== "metadata_and_acl_only"
    || !integer(fact.length, 1, 65_536)
    || !boundedString(fact.creation_time_utc, 20, 64)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u.test(fact.creation_time_utc)
    || !boundedString(fact.last_write_time_utc, 20, 64)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u.test(fact.last_write_time_utc)
    || !boundedString(fact.volume_serial_number, 8, 8)
    || !/^[0-9a-f]{8}$/u.test(fact.volume_serial_number)
    || !boundedString(fact.file_id, 16, 16)
    || !/^[0-9a-f]{16}$/u.test(fact.file_id)
    || fact.hard_link_count !== 1
    || typeof fact.owner_sid !== "string"
    || !KEY_TRUSTED_SIDS.has(fact.owner_sid)
    || fact.access_rules_protected !== true
    || !integer(fact.access_rule_count, 1, KEY_TRUSTED_SIDS.size)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage: "identity_file",
    });
  }
  validateAccessRules(fact.access_rules, fact.access_rule_count, `${stage}:access_rules`);
  validateAncestors(fact.ancestors, fact.ancestor_count, IDENTITY_PATH, `${stage}:ancestors`);
  const rules = fact.access_rules as Array<Record<string, unknown>>;
  const seenKeySids = new Set<unknown>();
  if (rules.some((rule) => {
    const untrustedForbidden = rule.access_control_type === "Allow"
      && typeof rule.sid === "string"
      && !KEY_TRUSTED_SIDS.has(rule.sid)
      && typeof rule.file_system_rights === "number"
      && (rule.file_system_rights & KEY_UNTRUSTED_FORBIDDEN_MASK) !== 0;
    const invalid = untrustedForbidden
      || typeof rule.sid !== "string"
      || !KEY_TRUSTED_SIDS.has(rule.sid)
      || seenKeySids.has(rule.sid)
      || rule.access_control_type !== "Allow"
      || rule.is_inherited !== false
      || rule.inheritance_flags !== 0
      || rule.propagation_flags !== 0
      || typeof rule.file_system_rights !== "number";
    seenKeySids.add(rule.sid);
    return invalid;
  }) || !rules.some((rule) => rule.sid === JUMP_IDENTITY_SID
    && typeof rule.file_system_rights === "number"
    && (rule.file_system_rights & 1) !== 0)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage: "identity_file:policy",
    });
  }
  return fact;
}

function validateException(value: unknown, stage: string): void {
  const exception = objectValue(value, stage);
  exactKeys(exception, [
    "hresult",
    "message_utf8_base64",
    "message_utf8_length",
    "message_utf8_sha256",
    "native_error_code",
    "schema",
    "type",
  ], stage);
  if (exception.schema !== "synthia-m4f-jump-local-exception.v1"
    || !boundedString(exception.type, 1, 512)
    || !integer(exception.hresult, -2_147_483_648, 2_147_483_647)
    || (exception.native_error_code !== null
      && !integer(exception.native_error_code, -2_147_483_648, 2_147_483_647))
    || !canonicalBase64(
      exception.message_utf8_base64,
      exception.message_utf8_length,
      MAX_EXCEPTION_MESSAGE_BYTES,
    )
    || !boundedString(exception.message_utf8_sha256, 64, 64)
    || !/^[0-9a-f]{64}$/u.test(exception.message_utf8_sha256)
    || createHash("sha256")
      .update(Buffer.from(exception.message_utf8_base64 as string, "base64"))
      .digest("hex") !== exception.message_utf8_sha256) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
}

function validateNullableException(value: unknown, stage: string): void {
  if (value !== null) validateException(value, stage);
}

function validateStream(value: unknown, stage: string): void {
  const stream = objectValue(value, stage);
  exactKeys(stream, ["base64", "length", "sha256"], stage);
  if (!canonicalBase64(stream.base64, stream.length, MAX_PROBE_STREAM_BYTES)
    || !boundedString(stream.sha256, 64, 64)
    || !/^[0-9a-f]{64}$/u.test(stream.sha256)
    || createHash("sha256").update(Buffer.from(stream.base64 as string, "base64")).digest("hex") !== stream.sha256) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage,
    });
  }
}

function validateProbe(value: unknown): void {
  const probe = objectValue(value, "probe");
  const commonKeys = [
    "ambiguous",
    "arguments",
    "create_no_window",
    "executable",
    "redirect_standard_error",
    "redirect_standard_input",
    "redirect_standard_output",
    "outer_transport_timeout_milliseconds",
    "start_call_bound",
    "start_call_locally_timed",
    "state",
    "timeout_milliseconds",
    "use_shell_execute",
  ];
  const validateCommon = (): void => {
    if (probe.executable !== SSH_PATH
      || !Array.isArray(probe.arguments)
      || probe.arguments.length !== 1
      || probe.arguments[0] !== "-V"
      || probe.use_shell_execute !== false
      || probe.redirect_standard_input !== true
      || probe.redirect_standard_output !== true
      || probe.redirect_standard_error !== true
      || probe.create_no_window !== true
      || probe.start_call_locally_timed !== false
      || probe.start_call_bound !== "outer_transport_only"
      || probe.outer_transport_timeout_milliseconds !== OUTER_TRANSPORT_TIMEOUT_MILLISECONDS
      || probe.timeout_milliseconds !== PROBE_TIMEOUT_MILLISECONDS) {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
        schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
        stage: "probe:launch",
      });
    }
  };
  if (probe.state === "start_failed") {
    exactKeys(probe, [...commonKeys, "exception"], "probe:start_failed");
    validateCommon();
    if (probe.ambiguous !== false) {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
    }
    validateException(probe.exception, "probe:start_failed:exception");
    return;
  }
  if (probe.state === "exited" || probe.state === "timed_out") {
    exactKeys(probe, [
      ...commonKeys,
      ...(probe.state === "timed_out" ? ["exception"] : []),
      "exit_status",
      ...(probe.state === "timed_out" ? [
        "kill_attempted",
        "kill_exception",
      ] : []),
      "output_complete",
      "stderr",
      "stdout",
      ...(probe.state === "timed_out" ? [
        "wait_exception",
        "wait_for_exit_result",
      ] : []),
    ], `probe:${probe.state}`);
    validateCommon();
    if (probe.ambiguous !== (probe.state === "timed_out")
      || (probe.state === "exited" && probe.output_complete !== true)
      || (probe.state === "timed_out" && typeof probe.output_complete !== "boolean")
      || (probe.state === "timed_out" && probe.kill_attempted !== true)
      || (probe.state === "timed_out" && probe.wait_for_exit_result !== true)
      || !integer(probe.exit_status, -2_147_483_648, 2_147_483_647)) {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
    }
    validateStream(probe.stdout, `probe:${probe.state}:stdout`);
    validateStream(probe.stderr, `probe:${probe.state}:stderr`);
    if (probe.state === "timed_out") {
      validateException(probe.exception, "probe:timed_out:exception");
      validateNullableException(probe.kill_exception, "probe:timed_out:kill_exception");
      validateNullableException(probe.wait_exception, "probe:timed_out:wait_exception");
    }
    if (probe.state === "exited") {
      const stdout = Buffer.from((probe.stdout as Record<string, unknown>).base64 as string, "base64");
      const stderr = Buffer.from((probe.stderr as Record<string, unknown>).base64 as string, "base64");
      const versionBytes = Buffer.concat([stdout, stderr]);
      if (probe.exit_status !== 0
        || versionBytes.length < 1
        || versionBytes.length > MAX_PROBE_STREAM_BYTES
        || !/^[\x09\x0a\x0d\x20-\x7e]+$/u.test(versionBytes.toString("latin1"))
        || !/(?:^|\r?\n)OpenSSH_for_Windows_[0-9][0-9A-Za-z._-]*(?:[ ,]|\r?$)/mu.test(
          versionBytes.toString("ascii"),
        )) {
        failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
          schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
          stage: "probe:version",
        });
      }
    }
    return;
  }
  if (probe.state === "termination_unconfirmed") {
    exactKeys(probe, [
      ...commonKeys,
      "exit_status",
      "kill_attempted",
      "kill_exception",
      "output_complete",
      "stderr",
      "stdout",
      "trigger_exception",
      "wait_exception",
      "wait_for_exit_result",
    ], "probe:termination_unconfirmed");
    validateCommon();
    if (probe.ambiguous !== true
      || typeof probe.output_complete !== "boolean"
      || probe.kill_attempted !== true
      || (probe.wait_for_exit_result !== false && probe.wait_for_exit_result !== null)
      || probe.exit_status !== null) {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
    }
    validateStream(probe.stdout, "probe:termination_unconfirmed:stdout");
    validateStream(probe.stderr, "probe:termination_unconfirmed:stderr");
    validateException(probe.trigger_exception, "probe:termination_unconfirmed:trigger_exception");
    validateNullableException(probe.kill_exception, "probe:termination_unconfirmed:kill_exception");
    validateNullableException(probe.wait_exception, "probe:termination_unconfirmed:wait_exception");
    if (probe.wait_for_exit_result === null && probe.wait_exception === null) {
      failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
    }
    return;
  }
  failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
    schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
    stage: "probe:state",
  });
}

function validatePhaseEvidence(diagnostic: BoundJumpPhaseResult): void {
  const identity = objectValue(diagnostic.identity, "phase:identity");
  exactKeys(identity, [
    "computer_name",
    "identity_name",
    "identity_sid",
    "schema",
  ], "phase:identity");
  const masterBefore = diagnostic.master_before;
  const masterAfter = diagnostic.master_after;
  if (diagnostic.schema !== "synthia-m4f-bound-phase.v1"
    || diagnostic.phase !== "jump-local-diagnostic:observe"
    || identity.schema !== "synthia-m4f-jump-identity.v1"
    || identity.computer_name !== JUMP_COMPUTER
    || identity.identity_name !== JUMP_IDENTITY_NAME
    || identity.identity_sid !== JUMP_IDENTITY_SID
    || diagnostic.process.exit_status !== 0
    || diagnostic.process.signal !== null
    || diagnostic.process.error_code !== null
    || diagnostic.process.timed_out !== false
    || diagnostic.process.outcome_ambiguous !== false
    || diagnostic.process.stderr_base64 !== ""
    || diagnostic.process.retry_permitted !== false
    || diagnostic.input.artifact_length !== EXPECTED_ARTIFACT_LENGTH
    || diagnostic.input.artifact_sha256 !== EXPECTED_ARTIFACT_SHA256
    || diagnostic.input.receiver_source_sha256 !== BOUND_JUMP_RECEIVER_SOURCE_SHA256
    || diagnostic.input.receiver_encoded_sha256 !== BOUND_JUMP_RECEIVER_ENCODED_SHA256
    || diagnostic.input.receiver_command_length !== BOUND_JUMP_RECEIVER_COMMAND_LENGTH
    || masterBefore.schema !== "synthia-m4f-bound-master-audit.v1"
    || masterAfter.schema !== "synthia-m4f-bound-master-audit.v1"
    || masterBefore.master_pid !== 87_062
    || masterBefore.master_socket !== "/private/tmp/synthia-m4f-jump.sock"
    || masterBefore.known_hosts_path !== "/Users/wenzhuolin/.ssh/known_hosts"
    || masterBefore.host_key_fingerprint !== "SHA256:I37M/4mZJwdlChfZyay+GSbhTuRKEQthOZW7sHmugh8"
    || masterBefore.ssh_executable !== "/usr/bin/ssh"
    || masterBefore.master_effective_config_sha256 !== MASTER_EFFECTIVE_CONFIG_SHA256
    || masterBefore.child_effective_config_sha256 !== CHILD_EFFECTIVE_CONFIG_SHA256
    || masterBefore.network_sha256 !== MASTER_NETWORK_SHA256
    || JSON.stringify(masterBefore) !== JSON.stringify(masterAfter)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_TRANSPORT_EVIDENCE_INVALID", "validation", null, null);
  }
}

function validatePayload(payload: Record<string, unknown>): void {
  exactKeys(payload, [
    "identity_after",
    "identity_before",
    "jump_identity",
    "powershell",
    "probe",
    "schema",
    "ssh_after",
    "ssh_before",
    "status",
  ], "diagnostic");
  if (payload.schema !== "synthia-m4f-jump-local-diagnostic.v1" || payload.status !== "observed") {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
  }
  const identity = objectValue(payload.jump_identity, "jump_identity");
  exactKeys(identity, ["administrator", "computer_name", "identity_name", "identity_sid", "schema"], "jump_identity");
  if (identity.schema !== "synthia-m4f-jump-local-identity.v1"
    || identity.computer_name !== JUMP_COMPUTER
    || identity.identity_name !== JUMP_IDENTITY_NAME
    || identity.identity_sid !== JUMP_IDENTITY_SID
    || identity.administrator !== true) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
  }
  const powershell = objectValue(payload.powershell, "powershell");
  exactKeys(powershell, ["os_bitness", "process_bitness", "process_id", "ps_edition", "ps_version", "schema"], "powershell");
  if (powershell.schema !== "synthia-m4f-jump-local-powershell.v1"
    || !boundedString(powershell.ps_version, 1, 64)
    || !boundedString(powershell.ps_edition, 1, 64)
    || !integer(powershell.process_id, 1, 2_147_483_647)
    || (powershell.process_bitness !== 32 && powershell.process_bitness !== 64)
    || (powershell.os_bitness !== 32 && powershell.os_bitness !== 64)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
  }
  const before = validateSshFact(payload.ssh_before, "ssh_before");
  const after = validateSshFact(payload.ssh_after, "ssh_after");
  if (before.length !== after.length
    || before.sha256 !== after.sha256
    || before.file_version !== after.file_version) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, null);
  }
  const identityBefore = validateKeyFact(payload.identity_before, "identity_before");
  const identityAfter = validateKeyFact(payload.identity_after, "identity_after");
  if (JSON.stringify(before) !== JSON.stringify(after)
    || JSON.stringify(identityBefore) !== JSON.stringify(identityAfter)) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID", "validation", null, {
      schema: "synthia-m4f-jump-local-diagnostic-validation-cause.v1",
      stage: "file-fact-drift",
    });
  }
  validateProbe(payload.probe);
}

function unexpectedCause(error: unknown): Record<string, unknown> {
  if (error instanceof CeremonyFailure) return error.detail;
  const type = error instanceof Error ? error.name : typeof error;
  const message = Buffer.from(error instanceof Error ? error.message : String(error), "utf8");
  return {
    schema: "synthia-m4f-jump-local-diagnostic-unexpected-cause.v1",
    type: type.slice(0, 512),
    message_utf8_base64: message.subarray(0, 16_384).toString("base64"),
  };
}

export interface JumpLocalDiagnosticDependencies {
  invokePhase(phase: string, artifact: string): BoundJumpPhaseResult;
}

export interface JumpLocalDiagnosticResult {
  schema: "synthia-m4f-jump-local-diagnostic-ceremony.v1";
  status: "observed";
  diagnostic: BoundJumpPhaseResult;
}

const defaultDependencies: JumpLocalDiagnosticDependencies = {
  invokePhase: (phase, artifact) => invokeBoundJumpPhase(phase, artifact),
};

export function runJumpLocalDiagnostic(
  overrides: Partial<JumpLocalDiagnosticDependencies> = {},
): JumpLocalDiagnosticResult {
  if (process.env.SYNTHIA_M4F_JUMP_LOCAL_DIAGNOSTIC_CONFIRMATION !== CONFIRMATION) {
    failure("M4F_JUMP_LOCAL_DIAGNOSTIC_CONFIRMATION_REQUIRED", "confirmation", null, null);
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  let diagnostic: BoundJumpPhaseResult;
  try {
    diagnostic = dependencies.invokePhase(
      "jump-local-diagnostic:observe",
      JUMP_LOCAL_DIAGNOSTIC_ARTIFACT,
    );
  } catch (error) {
    failure(
      "M4F_JUMP_LOCAL_DIAGNOSTIC_TRANSPORT_FAILED",
      "transport",
      null,
      unexpectedCause(error),
    );
  }
  try {
    validatePhaseEvidence(diagnostic);
    validatePayload(diagnostic.payload);
  } catch (error) {
    failure(
      "M4F_JUMP_LOCAL_DIAGNOSTIC_OUTPUT_INVALID",
      "validation",
      diagnostic,
      unexpectedCause(error),
    );
  }
  return {
    schema: "synthia-m4f-jump-local-diagnostic-ceremony.v1",
    status: "observed",
    diagnostic,
  };
}

if (import.meta.main) {
  runCeremony(() => {
    process.stdout.write(`${JSON.stringify(runJumpLocalDiagnostic())}\n`);
  });
}
