[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$VerbosePreference = "SilentlyContinue"
$DebugPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"

$syncRoot = "C:\Windows\Temp\synthia-m4f-sync-20260827-03"
$expectedRoot = "C:\"
$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$trustedInstallerSid = ([Security.Principal.NTAccount]"NT SERVICE\TrustedInstaller").Translate(
  [Security.Principal.SecurityIdentifier]
)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
$noPropagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl

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
    Fail "M4F_SYNC_IDENTITY_UNRESOLVED" $Name
  }
}

function Assert-AdministrativePrincipal {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity -or $null -eq $identity.User) {
    Fail "M4F_SYNC_REQUIRES_ADMIN"
  }
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($identity.User.Value -cne $systemSid.Value -and
    -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "M4F_SYNC_REQUIRES_ADMIN"
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

function Assert-TrustedAncestorAcl([object]$Acl, [string]$Path) {
  $trustedSids = @{
    $administratorsSid.Value = $true
    $systemSid.Value = $true
    $trustedInstallerSid.Value = $true
  }
  $ownerSid = Get-Sid $Acl.Owner "ancestor_owner"
  if (-not $trustedSids.ContainsKey($ownerSid)) {
    Fail "M4F_SYNC_ANCESTOR_OWNER_UNTRUSTED" ("{0}|{1}" -f $Path, $ownerSid)
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
        Fail "M4F_SYNC_ANCESTOR_REPLACE_UNTRUSTED" ("{0}|{1}" -f $Path, $writerSid)
      }
    }
  }
}

function Assert-AncestorChain([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($expectedRoot).TrimEnd('\')
  if (-not $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "M4F_SYNC_ANCESTOR_SCOPE_INVALID" $Path
  }
  $current = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  while ($null -ne $current) {
    if ($current -isnot [IO.DirectoryInfo] -or
      (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      Fail "M4F_SYNC_ANCESTOR_INVALID" $current.FullName
    }
    Assert-TrustedAncestorAcl (Get-Acl -LiteralPath $current.FullName) $current.FullName
    if ($current.FullName.TrimEnd('\').Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
      return
    }
    $current = $current.Parent
  }
  Fail "M4F_SYNC_ANCESTOR_INCOMPLETE" $Path
}

function Get-VolumeFacts {
  $logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'")
  if ($logicalDisks.Count -ne 1) { Fail "M4F_SYNC_LOGICAL_DISK_INVALID" }
  $logicalDisk = $logicalDisks[0]
  if ([int]$logicalDisk.DriveType -ne 3 -or
    [string]$logicalDisk.FileSystem -cne "NTFS" -or
    [string]::IsNullOrWhiteSpace([string]$logicalDisk.VolumeSerialNumber)) {
    Fail "M4F_SYNC_LOCAL_FIXED_NTFS_REQUIRED"
  }
  $volume = Get-Volume -DriveLetter C -ErrorAction Stop
  $partition = Get-Partition -DriveLetter C -ErrorAction Stop
  $disk = $partition | Get-Disk -ErrorAction Stop
  if ([string]$volume.FileSystem -cne "NTFS" -or
    [string]$volume.DriveType -cne "Fixed" -or
    [string]::IsNullOrWhiteSpace([string]$volume.UniqueId) -or
    [string]::IsNullOrWhiteSpace([string]$disk.UniqueId) -or
    $disk.IsOffline -or
    -not (@($partition.AccessPaths) -contains $expectedRoot)) {
    Fail "M4F_SYNC_VOLUME_MAPPING_INVALID"
  }
  return [pscustomobject]@{
    logical_volume_serial = [string]$logicalDisk.VolumeSerialNumber
    volume_unique_id = [string]$volume.UniqueId
    volume_serial_number = [string]$logicalDisk.VolumeSerialNumber
    disk_number = [int]$partition.DiskNumber
    partition_number = [int]$partition.PartitionNumber
    disk_unique_id = [string]$disk.UniqueId
  }
}

function Assert-SameVolumeFacts([object]$Before, [object]$After) {
  foreach ($property in @(
      "logical_volume_serial",
      "volume_unique_id",
      "volume_serial_number",
      "disk_number",
      "partition_number",
      "disk_unique_id"
    )) {
    if ([string]$Before.$property -cne [string]$After.$property) {
      Fail "M4F_SYNC_VOLUME_MAPPING_DRIFT" $property
    }
  }
}

function New-SyncRootAcl {
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
  return $acl
}

function Assert-SyncRoot {
  $item = Get-Item -LiteralPath $syncRoot -Force -ErrorAction Stop
  if ($item -isnot [IO.DirectoryInfo] -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail "M4F_SYNC_ROOT_INVALID"
  }
  $streams = @(Get-Item -LiteralPath $syncRoot -Stream * -ErrorAction Stop)
  if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) {
    Fail "M4F_SYNC_ALTERNATE_STREAM"
  }
  if (@(Get-ChildItem -LiteralPath $syncRoot -Force -ErrorAction Stop).Count -ne 0) {
    Fail "M4F_SYNC_NOT_EMPTY"
  }
  $acl = Get-Acl -LiteralPath $syncRoot
  if ((Get-Sid $acl.Owner "sync_owner") -cne $administratorsSid.Value -or
    -not $acl.AreAccessRulesProtected) {
    Fail "M4F_SYNC_BOUNDARY_INVALID"
  }
  $expectedRights = @{
    $administratorsSid.Value = [int64]$fullControl
    $systemSid.Value = [int64]$fullControl
  }
  $rules = @($acl.Access)
  if ($rules.Count -ne $expectedRights.Count) { Fail "M4F_SYNC_ACE_COUNT_INVALID" }
  $seen = @{}
  foreach ($entry in $rules) {
    $sid = Get-Sid $entry.IdentityReference "sync_access_rule"
    if (-not $expectedRights.ContainsKey($sid) -or
      $seen.ContainsKey($sid) -or
      $entry.AccessControlType -ne $allow -or
      $entry.IsInherited -or
      [int64]$entry.FileSystemRights -ne [int64]$expectedRights[$sid] -or
      $entry.InheritanceFlags -ne $inheritance -or
      $entry.PropagationFlags -ne $noPropagation) {
      Fail "M4F_SYNC_ACE_INVALID" $sid
    }
    $seen[$sid] = $true
  }
}

Assert-AdministrativePrincipal
$preVolumeFacts = Get-VolumeFacts
if (Test-Path -LiteralPath $syncRoot) { Fail "M4F_SYNC_ALREADY_EXISTS" }
Assert-AncestorChain (Split-Path -Parent $syncRoot)

# No cleanup is intentional. A post-creation failure leaves evidence in place
# and requires a fresh review; this helper must never be retried.
[void](New-Item -ItemType Directory -Path $syncRoot -ErrorAction Stop)
Set-Acl -LiteralPath $syncRoot -AclObject (New-SyncRootAcl)
Assert-SyncRoot
Assert-AncestorChain $syncRoot
$postVolumeFacts = Get-VolumeFacts
Assert-SameVolumeFacts $preVolumeFacts $postVolumeFacts

$success = [ordered]@{
  schema = "synthia-m4f-sync-root.v1"
  status = "passed"
  sync_root = $syncRoot
  owner_sid = $administratorsSid.Value
  protected = $true
  explicit_ace_count = 2
  empty = $true
  reparse = $false
  alternate_streams = $false
  logical_volume_serial = [string]$postVolumeFacts.logical_volume_serial
  volume_unique_id = [string]$postVolumeFacts.volume_unique_id
  volume_serial_number = [string]$postVolumeFacts.volume_serial_number
  disk_number = [int]$postVolumeFacts.disk_number
  partition_number = [int]$postVolumeFacts.partition_number
  disk_unique_id = [string]$postVolumeFacts.disk_unique_id
}
[Console]::Out.WriteLine(($success | ConvertTo-Json -Compress))
