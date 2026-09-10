[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CertifierPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$source = (Get-Content -LiteralPath $CertifierPath -Raw -Encoding UTF8).Replace("`r`n", "`n")
$functionStart = $source.IndexOf("function Fail")
$executionStart = $source.IndexOf("`nInitialize-AllowedWriterSids`nResolve-ReleaseFiles")
if ($functionStart -lt 0 -or $executionStart -le $functionStart) { throw "VOLUME_TEST_CERTIFIER_LAYOUT_INVALID" }
Invoke-Expression $source.Substring($functionStart, $executionStart - $functionStart)

$script:LogicalDiskFixtures = @()
$script:ObservedClassName = $null
$script:ObservedFilter = $null

function Get-CimInstance {
  [CmdletBinding()]
  param(
    [Parameter(Position = 0)]
    [string]$ClassName,
    [string]$Filter
  )
  $script:ObservedClassName = $ClassName
  $script:ObservedFilter = $Filter
  return $script:LogicalDiskFixtures
}

function New-LogicalDisk(
  [string]$DeviceId = "V:",
  [int]$DriveType = 3,
  [string]$FileSystem = "NTFS",
  [AllowEmptyString()]
  [string]$VolumeSerialNumber = "A1B2-C3D4"
) {
  return [pscustomobject]@{
    DeviceID = $DeviceId
    DriveType = $DriveType
    FileSystem = $FileSystem
    VolumeSerialNumber = $VolumeSerialNumber
  }
}

function Expect-Failure([string]$Code, [scriptblock]$Action) {
  try { & $Action }
  catch {
    $message = $_.Exception.Message
    if ($message -ceq $Code -or $message.StartsWith($Code + ":", [StringComparison]::Ordinal)) { return }
    throw
  }
  throw "VOLUME_TEST_EXPECTED_FAILURE:$Code"
}

$script:LogicalDiskFixtures = @(New-LogicalDisk)
$serial = Get-LogicalDiskVolumeSerialNumber "V:\" "valid"
if ($serial -cne "A1B2-C3D4" -or $script:ObservedClassName -cne "Win32_LogicalDisk" -or
  $script:ObservedFilter -cne "DeviceID='V:'") {
  throw "VOLUME_TEST_VALID_BINDING_FAILED"
}

$script:LogicalDiskFixtures = @()
Expect-Failure "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" {
  Get-LogicalDiskVolumeSerialNumber "V:\" "missing"
}
$script:LogicalDiskFixtures = @((New-LogicalDisk), (New-LogicalDisk))
Expect-Failure "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" {
  Get-LogicalDiskVolumeSerialNumber "V:\" "duplicate"
}
$script:LogicalDiskFixtures = @(New-LogicalDisk -DeviceId "W:")
Expect-Failure "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" {
  Get-LogicalDiskVolumeSerialNumber "V:\" "wrong_device"
}
$script:LogicalDiskFixtures = @(New-LogicalDisk -DriveType 4)
Expect-Failure "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" {
  Get-LogicalDiskVolumeSerialNumber "V:\" "remote_drive"
}
$script:LogicalDiskFixtures = @(New-LogicalDisk -VolumeSerialNumber "")
Expect-Failure "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" {
  Get-LogicalDiskVolumeSerialNumber "V:\" "empty_serial"
}

[pscustomobject]@{
  schema = "synthia-m4f-certifier-volume-serial-test.v1"
  status = "passed"
  source = "Win32_LogicalDisk.VolumeSerialNumber"
  cases = 6
} | ConvertTo-Json -Compress
