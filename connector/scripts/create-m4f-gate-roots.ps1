[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$VerbosePreference = "SilentlyContinue"
$DebugPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"

$gateRoot = "C:\Windows\Temp\synthia-m4f-20260827-03"
$backingRoot = "D:\synthia-m4f-toolchain-20260827-03"
$targetPaths = @($gateRoot, $backingRoot)

$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$serviceSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-19")
$trustedInstallerSid = ([Security.Principal.NTAccount]"NT SERVICE\TrustedInstaller").Translate(
  [Security.Principal.SecurityIdentifier]
)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
$noPropagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl
$readExecuteSynchronize = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
  [Security.AccessControl.FileSystemRights]::Synchronize

function Fail([string]$Code, [string]$Detail = "") {
  if ($Detail) { throw ("{0}:{1}" -f $Code, $Detail) }
  throw $Code
}

function Get-Sid([object]$IdentityReference, [string]$Name) {
  try {
    if ($IdentityReference -is [Security.Principal.IdentityReference]) {
      return $IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    return ([Security.Principal.NTAccount][string]$IdentityReference).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    Fail "M4F_GATE_ROOT_IDENTITY_UNRESOLVED" $Name
  }
}

function Assert-AdministrativePrincipal {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity -or $null -eq $identity.User) {
    Fail "M4F_GATE_ROOT_REQUIRES_ADMIN"
  }
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($identity.User.Value -cne $systemSid.Value -and
    -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "M4F_GATE_ROOT_REQUIRES_ADMIN"
  }
}

function Test-AceContainsAnyRight([object]$Entry, [object[]]$Rights) {
  foreach ($right in $Rights) {
    if (($Entry.FileSystemRights -band $right) -ne 0) { return $true }
  }
  return $false
}

function Test-AceAppliesToCurrentObject([object]$Entry) {
  return ($Entry.PropagationFlags -band
    [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
}

function Assert-StrictStagingAncestorAcl([object]$Acl, [string]$Path) {
  $trustedSids = @{
    $administratorsSid.Value = $true
    $systemSid.Value = $true
    $trustedInstallerSid.Value = $true
  }
  $ownerSid = Get-Sid $Acl.Owner "ancestor_owner"
  if (-not $trustedSids.ContainsKey($ownerSid)) {
    Fail "M4F_GATE_ROOT_ANCESTOR_OWNER_UNTRUSTED" ("{0}|{1}" -f $Path, $ownerSid)
  }
  $replacementRights = @(
    [Security.AccessControl.FileSystemRights]::Delete,
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  foreach ($entry in $Acl.Access) {
    if ($entry.AccessControlType -eq $allow -and
      (Test-AceAppliesToCurrentObject $entry) -and
      (Test-AceContainsAnyRight $entry $replacementRights)) {
      $writerSid = Get-Sid $entry.IdentityReference "ancestor_access_rule"
      if (-not $trustedSids.ContainsKey($writerSid)) {
        Fail "M4F_GATE_ROOT_ANCESTOR_REPLACE_UNTRUSTED" ("{0}|{1}" -f $Path, $writerSid)
      }
    }
  }
}

function Assert-AncestorChain([string]$Path, [string]$ExpectedRoot, [bool]$StrictAcl) {
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($ExpectedRoot).TrimEnd('\')
  if (-not $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "M4F_GATE_ROOT_PARENT_SCOPE_INVALID" $Path
  }
  $current = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  while ($null -ne $current) {
    if (-not $current.PSIsContainer) { Fail "M4F_GATE_ROOT_ANCESTOR_NOT_DIRECTORY" $current.FullName }
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "M4F_GATE_ROOT_ANCESTOR_REPARSE" $current.FullName
    }
    if ($StrictAcl) { Assert-StrictStagingAncestorAcl (Get-Acl -LiteralPath $current.FullName) $current.FullName }
    if ($current.FullName.TrimEnd('\').Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) { return }
    $current = $current.Parent
  }
  Fail "M4F_GATE_ROOT_ANCESTOR_CHAIN_INCOMPLETE" $Path
}

function Get-LocalFixedNtfsFacts([string]$Path, [string]$ExpectedRoot) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $actualRoot = [IO.Path]::GetPathRoot($fullPath)
  if (-not $actualRoot.Equals($ExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "M4F_GATE_ROOT_VOLUME_SCOPE_INVALID" $Path
  }
  $driveLetter = $ExpectedRoot.Substring(0, 1)
  $deviceId = $driveLetter + ":"
  $logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $deviceId + "'"))
  if ($logicalDisks.Count -ne 1) { Fail "M4F_GATE_ROOT_LOGICAL_DISK_INVALID" $deviceId }
  $logicalDisk = $logicalDisks[0]
  if ([int]$logicalDisk.DriveType -ne 3 -or
    [string]$logicalDisk.FileSystem -cne "NTFS" -or
    [string]::IsNullOrWhiteSpace([string]$logicalDisk.VolumeSerialNumber)) {
    Fail "M4F_GATE_ROOT_LOCAL_FIXED_NTFS_REQUIRED" $deviceId
  }
  $volume = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
  $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
  $disk = $partition | Get-Disk -ErrorAction Stop
  if ([string]$volume.FileSystem -cne "NTFS" -or
    [string]$volume.DriveType -cne "Fixed" -or
    [string]::IsNullOrWhiteSpace([string]$volume.UniqueId) -or
    [string]::IsNullOrWhiteSpace([string]$volume.SerialNumber) -or
    [string]::IsNullOrWhiteSpace([string]$disk.UniqueId) -or
    $disk.IsOffline -or
    -not (@($partition.AccessPaths) -contains $ExpectedRoot)) {
    Fail "M4F_GATE_ROOT_VOLUME_MAPPING_INVALID" $deviceId
  }
  return [pscustomobject]@{
    root = $ExpectedRoot
    device_id = $deviceId
    drive_type = [int]$logicalDisk.DriveType
    file_system = [string]$logicalDisk.FileSystem
    logical_volume_serial = [string]$logicalDisk.VolumeSerialNumber
    volume_unique_id = [string]$volume.UniqueId
    volume_serial_number = [string]$volume.SerialNumber
    disk_number = [int]$partition.DiskNumber
    partition_number = [int]$partition.PartitionNumber
    disk_unique_id = [string]$disk.UniqueId
  }
}

function Assert-SameVolumeFacts([object]$Before, [object]$After, [string]$Name) {
  foreach ($property in @(
      "root",
      "device_id",
      "drive_type",
      "file_system",
      "logical_volume_serial",
      "volume_unique_id",
      "volume_serial_number",
      "disk_number",
      "partition_number",
      "disk_unique_id"
    )) {
    if ([string]$Before.$property -cne [string]$After.$property) {
      Fail "M4F_GATE_ROOT_VOLUME_MAPPING_DRIFT" ("{0}|{1}" -f $Name, $property)
    }
  }
}

function New-GateRootAcl {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($administratorsSid)
  $acl.SetAccessRuleProtection($true, $false)
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $administratorsSid,
      $fullControl,
      $inheritance,
      $noPropagation,
      $allow
    ))
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $systemSid,
      $fullControl,
      $inheritance,
      $noPropagation,
      $allow
    ))
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $serviceSid,
      $readExecuteSynchronize,
      $inheritance,
      $noPropagation,
      $allow
    ))
  return $acl
}

function Assert-GateRoot([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { Fail "M4F_GATE_ROOT_NOT_DIRECTORY" $Path }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "M4F_GATE_ROOT_REPARSE" $Path
  }
  $streams = @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop)
  if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) {
    Fail "M4F_GATE_ROOT_ALTERNATE_STREAM" $Path
  }
  if (@(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop).Count -ne 0) {
    Fail "M4F_GATE_ROOT_NOT_EMPTY" $Path
  }

  $acl = Get-Acl -LiteralPath $Path
  if ((Get-Sid $acl.Owner "owner") -cne $administratorsSid.Value) {
    Fail "M4F_GATE_ROOT_OWNER_INVALID" $Path
  }
  if (-not $acl.AreAccessRulesProtected) {
    Fail "M4F_GATE_ROOT_INHERITANCE_ENABLED" $Path
  }

  $expectedRights = @{
    $administratorsSid.Value = [int64]$fullControl
    $systemSid.Value = [int64]$fullControl
    $serviceSid.Value = [int64]$readExecuteSynchronize
  }
  $rules = @($acl.Access)
  if ($rules.Count -ne $expectedRights.Count) {
    Fail "M4F_GATE_ROOT_ACE_COUNT_INVALID" $Path
  }
  $seen = @{}
  foreach ($entry in $rules) {
    $sid = Get-Sid $entry.IdentityReference "access_rule"
    if (-not $expectedRights.ContainsKey($sid) -or $seen.ContainsKey($sid)) {
      Fail "M4F_GATE_ROOT_ACE_PRINCIPAL_INVALID" ("{0}|{1}" -f $Path, $sid)
    }
    if ($entry.AccessControlType -ne $allow -or
      $entry.IsInherited -or
      [int64]$entry.FileSystemRights -ne [int64]$expectedRights[$sid] -or
      $entry.InheritanceFlags -ne $inheritance -or
      $entry.PropagationFlags -ne $noPropagation) {
      Fail "M4F_GATE_ROOT_ACE_INVALID" ("{0}|{1}" -f $Path, $sid)
    }
    $seen[$sid] = $true
  }
}

Assert-AdministrativePrincipal
$preGateVolumeFacts = Get-LocalFixedNtfsFacts $gateRoot "C:\"
$preBackingVolumeFacts = Get-LocalFixedNtfsFacts $backingRoot "D:\"
foreach ($path in $targetPaths) {
  if (Test-Path -LiteralPath $path) { Fail "M4F_GATE_ROOT_ALREADY_EXISTS" $path }
}
Assert-AncestorChain (Split-Path -Parent $gateRoot) "C:\" $true
Assert-AncestorChain (Split-Path -Parent $backingRoot) "D:\" $false

# No cleanup is intentional. Any failure after the first creation preserves
# all residual evidence and requires a fresh review before another attempt.
foreach ($path in $targetPaths) {
  [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
  Set-Acl -LiteralPath $path -AclObject (New-GateRootAcl)
  Assert-GateRoot $path
}
Assert-AncestorChain $gateRoot "C:\" $true
Assert-AncestorChain $backingRoot "D:\" $false
$postGateVolumeFacts = Get-LocalFixedNtfsFacts $gateRoot "C:\"
$postBackingVolumeFacts = Get-LocalFixedNtfsFacts $backingRoot "D:\"
Assert-SameVolumeFacts $preGateVolumeFacts $postGateVolumeFacts "gate_root"
Assert-SameVolumeFacts $preBackingVolumeFacts $postBackingVolumeFacts "backing_root"

$success = [ordered]@{
  schema = "synthia-m4f-gate-roots.v1"
  status = "passed"
  gate_root = $gateRoot
  backing_root = $backingRoot
  owner_sid = $administratorsSid.Value
  service_identity_sid = $serviceSid.Value
  protected = $true
  explicit_ace_count = 3
  empty = $true
  reparse = $false
  alternate_streams = $false
  gate_volume_serial = [string]$postGateVolumeFacts.logical_volume_serial
  backing_volume_serial = [string]$postBackingVolumeFacts.logical_volume_serial
  gate_volume_unique_id = [string]$postGateVolumeFacts.volume_unique_id
  backing_volume_unique_id = [string]$postBackingVolumeFacts.volume_unique_id
  gate_disk_unique_id = [string]$postGateVolumeFacts.disk_unique_id
  backing_disk_unique_id = [string]$postBackingVolumeFacts.disk_unique_id
}
[Console]::Out.WriteLine(($success | ConvertTo-Json -Compress))
