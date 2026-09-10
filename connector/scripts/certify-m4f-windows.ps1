[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("LaunchPreflight", "StageCeremony", "PostInitialize", "ToolchainImage", "ToolchainAttestation", "ToolchainNegativeChecks", "ToolchainLockStop")]
  [string]$Mode,

  [string]$ReleaseRoot = $PSScriptRoot,
  [string]$ConfigPath,
  [string]$ConfigTemplatePath,
  [string]$Epoch,
  [string]$StagingRoot,
  [string]$GateId,
  [Parameter(Mandatory = $true)]
  [string]$ServiceIdentity,
  [string]$BunPath = "D:\synthia-worker\runtime\bun-1.4.1\bun.exe",
  [string]$PfxPasswordPath,
  [string]$LogRoot,
  [string]$VivadoSourceRoot,
  [string]$VhdxPath,
  [string]$ToolchainMountPath,
  [string]$ToolchainAttestationPath,
  [string]$ToolchainAttestationSha256,
  [string]$ToolchainSemanticProfileSha256,
  [string]$VendorMaterialRoot,
  [string]$ToolchainLockHandoffPath,
  [string]$ToolchainDrainEvidencePath,
  [string]$ToolchainDrainEvidenceSha256,
  [int]$ToolchainValidityMinutes = 240,
  [int]$ToolchainHandoffTimeoutSeconds = 1800,
  [switch]$ConfirmReadOnlyToolchainProbe,
  [switch]$ConfirmCreateToolchainImage,
  [switch]$ConfirmKnownCurrentProvenanceLimitation,
  [switch]$ConfirmToolchainDrainComplete,
  [switch]$ConfirmIsolatedStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$MinimumFreeBytes = 10GB
$ExpectedBunVersion = "1.4.1"
$HashPattern = "^[0-9a-f]{64}$"
$EpochPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
$GateIdPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
$PlaceholderEpoch = "REPLACE_WITH_M4F_DEPLOYMENT_EPOCH"

function Fail([string]$Code, [string]$Detail = "") {
  if ($Detail) { throw "$Code`:$Detail" }
  throw $Code
}

function Require-File([string]$Path, [string]$Name) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail "M4F_FILE_MISSING" $Name
  }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Hash([string]$Actual, [object]$Expected, [string]$Name) {
  $expectedText = [string]$Expected
  if ($expectedText -notmatch $HashPattern -or $Actual -cne $expectedText) {
    Fail "M4F_HASH_MISMATCH" $Name
  }
}

function Read-Json([string]$Path, [string]$Name) {
  Require-File $Path $Name
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { Fail "M4F_JSON_INVALID" $Name }
}

function Require-Property([object]$Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
    Fail "M4F_CONFIG_INVALID" $Name
  }
  return $property.Value
}

function Assert-NoSecretMaterial([string]$Path, [string]$Name) {
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  $patterns = @(
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    '(?i)CF-Access-Client-Secret\s*[:=]\s*[''"]?[A-Za-z0-9._~+/=-]{8,}',
    "(?i)SYNTHIA_WORKER_PFX_PASSWORD\s*=",
    '(?i)[''"](?:password|access_token|client_secret)[''"]\s*:\s*[''"](?!<|REPLACE_)[^''"]+'
  )
  foreach ($pattern in $patterns) {
    if ($text -match $pattern) { Fail "M4F_SECRET_MATERIAL_FOUND" $Name }
  }
}

function Get-FileSystemParent([object]$Item, [string]$Name) {
  if ($Item -is [IO.DirectoryInfo]) { return $Item.Parent }
  if ($Item -is [IO.FileInfo]) { return $Item.Directory }
  Fail "M4F_FILE_SYSTEM_ITEM_INVALID" $Name
}

function Assert-NoReparseAncestor([string]$Path, [string]$Name) {
  $item = Get-Item -LiteralPath $Path -Force
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "M4F_REPARSE_POINT_REJECTED" $Name
    }
    $item = Get-FileSystemParent $item $Name
  }
}

function Get-IdentitySid([object]$Identity, [string]$Name) {
  try {
    return ([Security.Principal.NTAccount]$Identity).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {
    try { return ([Security.Principal.SecurityIdentifier]$Identity).Value }
    catch { Fail "M4F_IDENTITY_INVALID" $Name }
  }
}

function Get-ToolchainVirtualSize([object]$SourceBytes) {
  try { $sourceSize = [uint64]$SourceBytes }
  catch { Fail "M4F_TOOLCHAIN_SIZE_INVALID" }
  $reserve = [uint64](20GB)
  $alignment = [uint64](1MB)
  $maximum = [uint64]::MaxValue
  $maximumBeforeReserve = [uint64]($maximum - $reserve)
  if ($sourceSize -gt $maximumBeforeReserve) { Fail "M4F_TOOLCHAIN_SIZE_OVERFLOW" }
  $minimum = [uint64]($sourceSize + $reserve)
  $remainder = [uint64]($minimum % $alignment)
  if ($remainder -eq 0) { return $minimum }
  $increment = [uint64]($alignment - $remainder)
  if ($minimum -gt [uint64]($maximum - $increment)) { Fail "M4F_TOOLCHAIN_SIZE_OVERFLOW" }
  return [uint64]($minimum + $increment)
}

function Assert-ToolchainImageAdministrativePrincipalFacts([string]$UserSid, [bool]$IsAdministrator) {
  if ($UserSid -ceq "S-1-5-18" -or $IsAdministrator) { return }
  Fail "M4F_TOOLCHAIN_IMAGE_REQUIRES_ADMIN"
}

function Assert-ToolchainImageAdministrativePrincipal {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity -or $null -eq $identity.User) { Fail "M4F_TOOLCHAIN_IMAGE_REQUIRES_ADMIN" }
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Assert-ToolchainImageAdministrativePrincipalFacts $identity.User.Value $isAdministrator
}

function Assert-ToolchainServiceIdentityNonPrivilegedFacts([string]$ServiceSid, [bool]$IsAdministrator = $false) {
  if ($ServiceSid -ceq "S-1-5-18" -or $ServiceSid -ceq "S-1-5-32-544" -or $IsAdministrator) {
    Fail "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED"
  }
}

function Assert-ToolchainServiceIdentityNonPrivileged {
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  $administrators = [ADSI]"WinNT://./Administrators,group"
  $isAdministrator = Test-IdentityNestedInGroup $serviceSid $administrators
  Assert-ToolchainServiceIdentityNonPrivilegedFacts $serviceSid $isAdministrator
}

function Get-WinNtMemberProperty([object]$Member, [string]$Property, [string]$Name) {
  try { return $Member.GetType().InvokeMember($Property, "GetProperty", $null, $Member, $null) }
  catch { Fail "M4F_IDENTITY_INVALID" $Name }
}

function Test-IdentityNestedInGroup([string]$TargetSid, [object]$RootGroup) {
  # WinNT:// exposes both local and domain-backed groups. Traverse the complete
  # membership graph and fail closed if a nested group cannot be resolved;
  # checking only the local group's direct members misses effective admin rights.
  $pending = New-Object Collections.Queue
  try { $rootPath = [string]$RootGroup.Path }
  catch { Fail "M4F_IDENTITY_INVALID" "service_identity_group_path" }
  if ([string]::IsNullOrWhiteSpace($rootPath)) { Fail "M4F_IDENTITY_INVALID" "service_identity_group_path" }
  $pending.Enqueue($rootPath)
  $visited = @{}
  $memberCount = 0
  while ($pending.Count -gt 0) {
    $groupPath = [string]$pending.Dequeue()
    $groupKey = $groupPath.ToLowerInvariant()
    if ($visited.ContainsKey($groupKey)) { continue }
    $visited[$groupKey] = $true
    if ($visited.Count -gt 4096) { Fail "M4F_IDENTITY_GROUP_GRAPH_TOO_LARGE" }
    try { $group = [ADSI]$groupPath }
    catch { Fail "M4F_IDENTITY_GROUP_ENUMERATION_FAILED" $groupPath }
    try { $members = @($group.psbase.Invoke("Members")) }
    catch { Fail "M4F_IDENTITY_GROUP_ENUMERATION_FAILED" $groupPath }
    foreach ($member in $members) {
      $memberCount += 1
      if ($memberCount -gt 65536) { Fail "M4F_IDENTITY_GROUP_GRAPH_TOO_LARGE" }
      try {
        $memberSidBytes = [byte[]](Get-WinNtMemberProperty $member "objectSid" "service_identity_group_sid")
        $memberSid = [Security.Principal.SecurityIdentifier]::new($memberSidBytes, 0).Value
      } catch { Fail "M4F_IDENTITY_INVALID" "service_identity_group_sid" }
      if ($memberSid -ceq $TargetSid) { return $true }
      $memberClass = [string](Get-WinNtMemberProperty $member "Class" "service_identity_group_class")
      if ($memberClass -ceq "Group") {
        $memberPath = [string](Get-WinNtMemberProperty $member "ADsPath" "service_identity_group_path")
        if ([string]::IsNullOrWhiteSpace($memberPath)) { Fail "M4F_IDENTITY_INVALID" "service_identity_group_path" }
        $pending.Enqueue($memberPath)
      }
    }
  }
  return $false
}

function Initialize-AllowedWriterSids {
  $script:AllowedWriterSids = @{}
  # Immutable trust anchors and every ancestor that can replace them are
  # writable only by privileged platform owners. The Worker service SID is
  # deliberately absent; it is granted exact RX on anchors and exact Modify on
  # the five mutable roots by their dedicated ACL builders.
  foreach ($identity in @("S-1-5-18", "S-1-5-32-544", "NT SERVICE\TrustedInstaller")) {
    try { $AllowedWriterSids[(Get-IdentitySid $identity "service_identity")] = $true }
    catch {
      if ($identity -ne "NT SERVICE\TrustedInstaller") { throw }
    }
  }
}

function Test-AceAppliesToCurrentObject([object]$Entry) {
  return (($Entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0)
}

function Test-AceContainsAnyRight([object]$Entry, [object[]]$Rights) {
  foreach ($right in $Rights) {
    if (($Entry.FileSystemRights -band $right) -ne 0) { return $true }
  }
  return $false
}

function Assert-ProtectedObjectAcl([object]$Acl, [string]$Name) {
  if (-not $Acl.AreAccessRulesProtected) { Fail "M4F_ACL_INHERITANCE_ENABLED" $Name }
  $ownerSid = Get-IdentitySid $Acl.Owner $Name
  if (-not $AllowedWriterSids.ContainsKey($ownerSid)) { Fail "M4F_ACL_OWNER_UNTRUSTED" $Name }
  $mutationRights = @(
    [Security.AccessControl.FileSystemRights]::WriteData,
    [Security.AccessControl.FileSystemRights]::AppendData,
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
    [Security.AccessControl.FileSystemRights]::WriteAttributes,
    [Security.AccessControl.FileSystemRights]::Delete,
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  foreach ($entry in $Acl.Access) {
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      (Test-AceContainsAnyRight $entry $mutationRights)) {
      $writerSid = Get-IdentitySid $entry.IdentityReference $Name
      $creatorOwnerTemplate = -not (Test-AceAppliesToCurrentObject $entry) -and $writerSid -ceq "S-1-3-0"
      if ($creatorOwnerTemplate) { continue }
      if (-not $AllowedWriterSids.ContainsKey($writerSid)) { Fail "M4F_ACL_WRITER_UNTRUSTED" $Name }
    }
  }
}

function Assert-ProtectedObject([string]$Path, [string]$Name) {
  Assert-ProtectedObjectAcl (Get-Acl -LiteralPath $Path) $Name
}

function Assert-AncestorAcl([object]$Acl, [string]$Name) {
  $ownerSid = Get-IdentitySid $Acl.Owner $Name
  if (-not $AllowedWriterSids.ContainsKey($ownerSid)) { Fail "M4F_ACL_OWNER_UNTRUSTED" $Name }
  $replacementRights = @(
    [Security.AccessControl.FileSystemRights]::Delete,
    # FILE_DELETE_CHILD: permits deleting/replacing the current path child.
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  foreach ($entry in $Acl.Access) {
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      (Test-AceAppliesToCurrentObject $entry) -and
      (Test-AceContainsAnyRight $entry $replacementRights)) {
      $writerSid = Get-IdentitySid $entry.IdentityReference $Name
      if (-not $AllowedWriterSids.ContainsKey($writerSid)) { Fail "M4F_ACL_ANCESTOR_REPLACE_UNTRUSTED" $Name }
    }
  }
}

function Assert-Ancestor([string]$Path, [string]$Name) {
  Assert-AncestorAcl (Get-Acl -LiteralPath $Path) $Name
}

function Assert-TrustedPath([string]$Path, [string]$Name) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "M4F_REPARSE_POINT_REJECTED" $Name
  }
  Assert-ProtectedObject $item.FullName $Name
  $item = Get-FileSystemParent $item $Name
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "M4F_REPARSE_POINT_REJECTED" $Name }
    Assert-Ancestor $item.FullName $Name
    $item = Get-FileSystemParent $item $Name
  }
}

function Assert-TrustedAncestors([string]$Path, [string]$Name) {
  $item = Get-FileSystemParent (Get-Item -LiteralPath $Path -Force) $Name
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "M4F_REPARSE_POINT_REJECTED" $Name }
    Assert-Ancestor $item.FullName $Name
    $item = Get-FileSystemParent $item $Name
  }
}

function Protect-NewTrustedObject([string]$Path, [string]$Name) {
  Assert-NoReparseAncestor $Path $Name
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = Get-IdentitySid $acl.Owner $Name
  if (-not $AllowedWriterSids.ContainsKey($ownerSid)) { Fail "M4F_ACL_OWNER_UNTRUSTED" $Name }
  $acl.SetAccessRuleProtection($true, $true)
  Set-Acl -LiteralPath $Path -AclObject $acl
  $acl = Get-Acl -LiteralPath $Path
  foreach ($entry in @($acl.Access)) {
    $entrySid = Get-IdentitySid $entry.IdentityReference $Name
    if (-not $AllowedWriterSids.ContainsKey($entrySid)) {
      [void]$acl.RemoveAccessRuleSpecific($entry)
    }
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-TrustedPath $Path $Name
}

function New-MutableRootAcl {
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  $systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $serviceSid = [Security.Principal.SecurityIdentifier]::new((Get-IdentitySid $ServiceIdentity "service_identity"))
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($administratorsSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($principal in @(
    [pscustomobject]@{ sid = $administratorsSid; rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [pscustomobject]@{ sid = $systemSid; rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [pscustomobject]@{ sid = $serviceSid; rights = ([Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Synchronize) }
  )) {
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $principal.sid,
      $principal.rights,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    ))
  }
  return $acl
}

function Assert-MutableRootAcl([object]$Acl, [string]$Name) {
  if (-not $Acl.AreAccessRulesProtected) { Fail "M4F_MUTABLE_ROOT_INHERITANCE_ENABLED" $Name }
  $administratorsSid = "S-1-5-32-544"
  $systemSid = "S-1-5-18"
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  if ((Get-IdentitySid $Acl.Owner $Name) -cne $administratorsSid) { Fail "M4F_MUTABLE_ROOT_OWNER_INVALID" $Name }
  $expected = @{
    $administratorsSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $systemSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $serviceSid = [int64]([Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  }
  if ($expected.Count -ne 3) { Fail "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED" }
  $observed = @{}
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($entry in $Acl.Access) {
    $sid = Get-IdentitySid $entry.IdentityReference $Name
    if (-not $expected.ContainsKey($sid) -or $observed.ContainsKey($sid)) { Fail "M4F_MUTABLE_ROOT_ACE_UNEXPECTED" $Name }
    if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $entry.IsInherited -or
      $entry.InheritanceFlags -ne $inheritance -or $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
      [int64]$entry.FileSystemRights -ne [int64]$expected[$sid]) { Fail "M4F_MUTABLE_ROOT_ACE_INVALID" $Name }
    $observed[$sid] = $true
  }
  if ($observed.Count -ne 3) { Fail "M4F_MUTABLE_ROOT_ACE_MISSING" $Name }
}

function Protect-NewMutableRoot([string]$Path, [string]$Name) {
  Assert-NoReparseAncestor $Path $Name
  Set-Acl -LiteralPath $Path -AclObject (New-MutableRootAcl)
  Assert-MutableRootAcl (Get-Acl -LiteralPath $Path) $Name
  Assert-TrustedAncestors $Path $Name
}

function Assert-MutableRoot([string]$Path, [string]$Name) {
  # Authorized admin Worker identity: the mutable roots keep their frozen
  # LocalService ACL model (see the ceremony builders); the interactive admin
  # reaches them through the Administrators group.
  if ($env:SYNTHIA_M4F_WORKER_IDENTITY_AUTHORIZATION -ceq "I_AUTHORIZE_M4F_ADMIN_WORKER_IDENTITY" -and
    [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    return
  }
  Assert-NoReparseAncestor $Path $Name
  Assert-MutableRootAcl (Get-Acl -LiteralPath $Path) $Name
  Assert-TrustedAncestors $Path $Name
}

function Assert-MutableDescendantDirectory([string]$Path, [string]$Root, [string]$Name) {
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not (Split-Path -Parent $fullPath).Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "M4F_MUTABLE_DESCENDANT_SCOPE_INVALID" $Name
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { Fail "M4F_ROOT_MISSING" $Name }
  $item = Get-Item -LiteralPath $fullPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "M4F_REPARSE_POINT_REJECTED" $Name }
  Assert-MutableRoot $fullRoot ($Name + "_root")
  $acl = Get-Acl -LiteralPath $fullPath
  if ($acl.AreAccessRulesProtected) { Fail "M4F_MUTABLE_DESCENDANT_INHERITANCE_DISABLED" $Name }
  $administratorsSid = "S-1-5-32-544"
  $systemSid = "S-1-5-18"
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  if ((Get-IdentitySid $acl.Owner $Name) -cne $administratorsSid) { Fail "M4F_MUTABLE_DESCENDANT_OWNER_INVALID" $Name }
  $expected = @{
    $administratorsSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $systemSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $serviceSid = [int64]([Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  }
  $observed = @{}
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($entry in $acl.Access) {
    $sid = Get-IdentitySid $entry.IdentityReference $Name
    if (-not $expected.ContainsKey($sid) -or $observed.ContainsKey($sid)) { Fail "M4F_MUTABLE_DESCENDANT_ACE_UNEXPECTED" $Name }
    if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or -not $entry.IsInherited -or
      $entry.InheritanceFlags -ne $inheritance -or $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
      [int64]$entry.FileSystemRights -ne [int64]$expected[$sid]) { Fail "M4F_MUTABLE_DESCENDANT_ACE_INVALID" $Name }
    $observed[$sid] = $true
  }
  if ($observed.Count -ne 3) { Fail "M4F_MUTABLE_DESCENDANT_ACE_MISSING" $Name }
  Assert-LocalFixedNtfsVolume $fullPath $Name
}

function Assert-ToolchainServiceReadOnlyAcl([object]$Acl, [string]$Name) {
  # The explicitly authorized admin Worker identity (service-session Vivado
  # workaround) reaches these objects through the Administrators group; the
  # read-only image volume cannot gain an explicit per-user ACE.
  if ($env:SYNTHIA_M4F_WORKER_IDENTITY_AUTHORIZATION -ceq "I_AUTHORIZE_M4F_ADMIN_WORKER_IDENTITY" -and
    [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    return
  }
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  $readExecute = [Security.AccessControl.FileSystemRights]::ReadAndExecute
  $requiredRights = $readExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
  $mutationRights = @(
    [Security.AccessControl.FileSystemRights]::WriteData,
    [Security.AccessControl.FileSystemRights]::AppendData,
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
    [Security.AccessControl.FileSystemRights]::WriteAttributes,
    [Security.AccessControl.FileSystemRights]::Delete,
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $hasReadExecute = $false
  foreach ($entry in $Acl.Access) {
    if ((Get-IdentitySid $entry.IdentityReference $Name) -cne $serviceSid) { continue }
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
      (Test-AceContainsAnyRight $entry @($requiredRights))) { Fail "M4F_TOOLCHAIN_SERVICE_READ_DENIED" $Name }
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if (Test-AceContainsAnyRight $entry $mutationRights) { Fail "M4F_TOOLCHAIN_SERVICE_WRITE_ALLOWED" $Name }
      $unexpectedRights = ([int64]$entry.FileSystemRights) -band (-bnot ([int64]$requiredRights))
      if ($unexpectedRights -ne 0) { Fail "M4F_TOOLCHAIN_SERVICE_RIGHTS_EXCESSIVE" $Name }
      if ((Test-AceAppliesToCurrentObject $entry) -and
        (($entry.FileSystemRights -band $requiredRights) -eq $requiredRights)) { $hasReadExecute = $true }
    }
  }
  if (-not $hasReadExecute) { Fail "M4F_TOOLCHAIN_SERVICE_READ_EXECUTE_MISSING" $Name }
}

function New-InitializedToolchainVolumeRootAcl([object]$ExistingAcl) {
  if ($null -eq $ExistingAcl) { Fail "M4F_TOOLCHAIN_VOLUME_ROOT_ACL_MISSING" }
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  $systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $serviceSid = [Security.Principal.SecurityIdentifier]::new((Get-IdentitySid $ServiceIdentity "service_identity"))
  if ($serviceSid.Value -ceq $administratorsSid.Value -or $serviceSid.Value -ceq $systemSid.Value) {
    Fail "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED"
  }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($administratorsSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($principal in @(
    [pscustomobject]@{ sid = $administratorsSid; rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [pscustomobject]@{ sid = $systemSid; rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [pscustomobject]@{ sid = $serviceSid; rights = ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize) }
  )) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $principal.sid,
      $principal.rights,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  return $acl
}

function Assert-InitializedToolchainVolumeRootAcl([object]$Acl, [string]$Name) {
  if (-not $Acl.AreAccessRulesProtected) { Fail "M4F_ACL_INHERITANCE_ENABLED" $Name }
  $administratorsSid = "S-1-5-32-544"
  $systemSid = "S-1-5-18"
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  if ((Get-IdentitySid $Acl.Owner $Name) -cne $administratorsSid) { Fail "M4F_TOOLCHAIN_VOLUME_ROOT_OWNER_INVALID" $Name }
  $expected = @{
    $administratorsSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $systemSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $serviceSid = [int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  }
  if ($expected.Count -ne 3) { Fail "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED" }
  $observed = @{}
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($entry in $Acl.Access) {
    $sid = Get-IdentitySid $entry.IdentityReference $Name
    if (-not $expected.ContainsKey($sid)) { Fail "M4F_TOOLCHAIN_VOLUME_ROOT_ACE_UNEXPECTED" $Name }
    if ($observed.ContainsKey($sid)) { Fail "M4F_TOOLCHAIN_VOLUME_ROOT_ACE_DUPLICATE" $Name }
    if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $entry.IsInherited -or
      $entry.InheritanceFlags -ne $inheritance -or $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
      [int64]$entry.FileSystemRights -ne [int64]$expected[$sid]) {
      Fail "M4F_TOOLCHAIN_VOLUME_ROOT_ACE_INVALID" $Name
    }
    $observed[$sid] = $true
  }
  if ($observed.Count -ne 3) { Fail "M4F_TOOLCHAIN_VOLUME_ROOT_ACE_MISSING" $Name }
  Assert-ProtectedObjectAcl $Acl $Name
  Assert-ToolchainServiceReadOnlyAcl $Acl $Name
}

function Get-LogicalDiskVolumeSerialNumber([string]$Path, [string]$Name) {
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
  $deviceId = $root.TrimEnd('\')
  if ($deviceId -notmatch "^[A-Za-z]:$") { Fail "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" $Name }
  $logicalDisks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $deviceId + "'") -ErrorAction Stop)
  if ($logicalDisks.Count -ne 1 -or
    -not ([string]$logicalDisks[0].DeviceID).Equals($deviceId, [StringComparison]::OrdinalIgnoreCase) -or
    [int]$logicalDisks[0].DriveType -ne 3 -or [string]$logicalDisks[0].FileSystem -cne "NTFS" -or
    [string]::IsNullOrWhiteSpace([string]$logicalDisks[0].VolumeSerialNumber)) {
    Fail "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID" $Name
  }
  return [string]$logicalDisks[0].VolumeSerialNumber
}

function Assert-NewToolchainVolumeRootScope([string]$Path, [string]$ExpectedUniqueId, [string]$ExpectedSerialNumber) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ($root -notmatch "^[A-Za-z]:\\$" -or -not $fullPath.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "M4F_TOOLCHAIN_VOLUME_ROOT_SCOPE_INVALID"
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { Fail "M4F_TOOLCHAIN_VOLUME_ROOT_MISSING" }
  Assert-NoReparseAncestor $fullPath "toolchain_volume_root"
  if ([string]::IsNullOrWhiteSpace($ExpectedUniqueId) -or [string]::IsNullOrWhiteSpace($ExpectedSerialNumber)) {
    Fail "M4F_TOOLCHAIN_VOLUME_IDENTITY_INVALID"
  }
  $actualVolume = Get-Volume -DriveLetter $fullPath.Substring(0, 1) -ErrorAction Stop
  $actualSerialNumber = Get-LogicalDiskVolumeSerialNumber $fullPath "toolchain_volume_root"
  if ($null -eq $actualVolume -or [string]$actualVolume.FileSystem -cne "NTFS" -or
    [string]$actualVolume.FileSystemLabel -cne "SynthiaVivado" -or
    [string]$actualVolume.UniqueId -cne $ExpectedUniqueId -or
    $actualSerialNumber -cne $ExpectedSerialNumber) {
    Fail "M4F_TOOLCHAIN_VOLUME_IDENTITY_MISMATCH"
  }
}

function Initialize-NewToolchainVolumeRoot([string]$Path, [string]$ExpectedUniqueId, [string]$ExpectedSerialNumber) {
  Assert-NewToolchainVolumeRootScope $Path $ExpectedUniqueId $ExpectedSerialNumber
  $controlledAcl = New-InitializedToolchainVolumeRootAcl (Get-Acl -LiteralPath $Path)
  Set-Acl -LiteralPath $Path -AclObject $controlledAcl
  Assert-InitializedToolchainVolumeRootAcl (Get-Acl -LiteralPath $Path) "toolchain_volume_root"
  Assert-NewToolchainVolumeRootScope $Path $ExpectedUniqueId $ExpectedSerialNumber
}

function Assert-ToolchainBackingServiceBoundaryAcl([object]$Acl, [string]$Name) {
  Assert-ProtectedObjectAcl $Acl $Name
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  if ((Get-IdentitySid $Acl.Owner $Name) -ceq $serviceSid) {
    Fail "M4F_TOOLCHAIN_SERVICE_OWNER_FORBIDDEN" $Name
  }
  Assert-ToolchainServiceReadOnlyAcl $Acl $Name
}

function Assert-ToolchainBackingServiceBoundary([string]$Path, [string]$Name) {
  Assert-ToolchainBackingServiceBoundaryAcl (Get-Acl -LiteralPath $Path) $Name
}

function Grant-ToolchainServiceReadExecute([string]$Path, [string]$Name) {
  $item = Get-Item -LiteralPath $Path -Force
  $acl = Get-Acl -LiteralPath $item.FullName
  if (-not $acl.AreAccessRulesProtected) { Fail "M4F_ACL_INHERITANCE_ENABLED" $Name }
  $serviceSid = [Security.Principal.SecurityIdentifier]::new((Get-IdentitySid $ServiceIdentity "service_identity"))
  foreach ($entry in @($acl.Access)) {
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      (Get-IdentitySid $entry.IdentityReference $Name) -ceq $serviceSid.Value) {
      [void]$acl.RemoveAccessRuleSpecific($entry)
    }
  }
  $inheritance = if ($item.PSIsContainer) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $serviceSid,
    ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize),
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
  $updated = Get-Acl -LiteralPath $item.FullName
  Assert-ProtectedObjectAcl $updated $Name
  Assert-ToolchainServiceReadOnlyAcl $updated $Name
}

function Protect-NewServiceReadableTrustedObject([string]$Path, [string]$Name) {
  Protect-NewTrustedObject $Path $Name
  Grant-ToolchainServiceReadExecute $Path ($Name + "_service")
  Assert-TrustedPath $Path $Name
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $Path) $Name
}

function New-ToolchainHandoffAckSlotAcl {
  $administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  $systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $serviceSid = [Security.Principal.SecurityIdentifier]::new((Get-IdentitySid $ServiceIdentity "service_identity"))
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($administratorsSid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @(
    [pscustomobject]@{ sid = $administratorsSid; rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [pscustomobject]@{ sid = $systemSid; rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [pscustomobject]@{ sid = $serviceSid; rights = ([Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Synchronize) }
  )) {
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $principal.sid,
      $principal.rights,
      [Security.AccessControl.AccessControlType]::Allow
    ))
  }
  return $acl
}

function Assert-ToolchainHandoffAckSlotAcl([object]$Acl, [string]$Name) {
  if (-not $Acl.AreAccessRulesProtected) { Fail "M4F_TOOLCHAIN_ACK_SLOT_INHERITANCE_ENABLED" $Name }
  $administratorsSid = "S-1-5-32-544"
  $systemSid = "S-1-5-18"
  $serviceSid = Get-IdentitySid $ServiceIdentity "service_identity"
  if ((Get-IdentitySid $Acl.Owner $Name) -cne $administratorsSid) { Fail "M4F_TOOLCHAIN_ACK_SLOT_OWNER_INVALID" $Name }
  $expected = @{
    $administratorsSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $systemSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    $serviceSid = [int64]([Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  }
  $forbiddenServiceRights = @(
    [Security.AccessControl.FileSystemRights]::Delete,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $observed = @{}
  foreach ($entry in $Acl.Access) {
    $sid = Get-IdentitySid $entry.IdentityReference $Name
    if (-not $expected.ContainsKey($sid) -or $observed.ContainsKey($sid)) { Fail "M4F_TOOLCHAIN_ACK_SLOT_ACE_UNEXPECTED" $Name }
    if ($sid -ceq $serviceSid -and (Test-AceContainsAnyRight $entry $forbiddenServiceRights)) {
      Fail "M4F_TOOLCHAIN_ACK_SLOT_FORBIDDEN_RIGHT" $Name
    }
    if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $entry.IsInherited -or
      $entry.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
      $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
      [int64]$entry.FileSystemRights -ne [int64]$expected[$sid]) { Fail "M4F_TOOLCHAIN_ACK_SLOT_ACE_INVALID" $Name }
    $observed[$sid] = $true
  }
  if ($observed.Count -ne 3) { Fail "M4F_TOOLCHAIN_ACK_SLOT_ACE_MISSING" $Name }
}

function Assert-ToolchainHandoffAckPayload(
  [object]$Ack,
  [string]$ExpectedNonce,
  [string]$ExpectedAttestationSha256,
  [string]$Name
) {
  if ($null -eq $Ack) { Fail "M4F_TOOLCHAIN_LOCK_HANDOFF_ACK_INVALID" $Name }
  $keys = @($Ack.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ",") -cne "nonce,schema,vivado_toolchain_attestation_sha256,worker_process_instance_id" -or
    [string]$Ack.schema -cne "synthia-vivado-toolchain-lock-handoff-ack.v1" -or
    [string]$Ack.nonce -cne $ExpectedNonce -or
    [string]$Ack.worker_process_instance_id -cnotmatch "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" -or
    [string]$Ack.vivado_toolchain_attestation_sha256 -cne $ExpectedAttestationSha256) {
    Fail "M4F_TOOLCHAIN_LOCK_HANDOFF_ACK_INVALID" $Name
  }
}

function Initialize-ToolchainHandoffAckSlot([string]$Path, [string]$Name) {
  if (Test-Path -LiteralPath $Path) { Fail "M4F_TOOLCHAIN_ACK_SLOT_ALREADY_EXISTS" $Name }
  [IO.File]::WriteAllBytes($Path, [byte[]]::new(0))
  Set-Acl -LiteralPath $Path -AclObject (New-ToolchainHandoffAckSlotAcl)
  Assert-ToolchainHandoffAckSlotAcl (Get-Acl -LiteralPath $Path) $Name
  Assert-TrustedAncestors $Path $Name
}

# D: may have broad root ACLs. The VHDX compensation model protects the
# dedicated parent and image themselves, then relies on the continuous
# FileShare.Read lock + identity/hash rechecks. Do not reuse this exception for
# release, TLS, config, ledger, spool, staging, or mounted-tree paths.
function Protect-NewToolchainBackingObject([string]$Path, [string]$Name) {
  Assert-NoReparseAncestor $Path $Name
  $parent = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
  Assert-ProtectedObject $parent ($Name + "_parent")
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = Get-IdentitySid $acl.Owner $Name
  if (-not $AllowedWriterSids.ContainsKey($ownerSid)) { Fail "M4F_ACL_OWNER_UNTRUSTED" $Name }
  $acl.SetAccessRuleProtection($true, $true)
  foreach ($entry in @($acl.Access)) {
    $entrySid = Get-IdentitySid $entry.IdentityReference $Name
    if (-not $AllowedWriterSids.ContainsKey($entrySid)) { [void]$acl.RemoveAccessRuleSpecific($entry) }
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-ProtectedObject $Path $Name
}

function Assert-Within([string]$Path, [string]$Parent, [string]$Name) {
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (-not $fullPath.StartsWith($fullParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "M4F_PATH_OUTSIDE_STAGING_ROOT" $Name
  }
}

function Assert-IsolatedStaging([object]$Config) {
  if (-not $StagingRoot -or -not $GateId -or $GateId -notmatch $GateIdPattern) { Fail "M4F_STAGING_IDENTITY_REQUIRED" }
  $fullStaging = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\')
  $expectedStaging = [IO.Path]::GetFullPath(("C:\Windows\Temp\synthia-m4f-" + $GateId)).TrimEnd('\')
  if (-not $fullStaging.Equals($expectedStaging, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $fullStaging) -cne ("synthia-m4f-" + $GateId)) {
    Fail "M4F_STAGING_ROOT_INVALID"
  }
  Assert-LocalNtfsDirectory $fullStaging "staging_root" $true
  Assert-Within $ReleaseRoot $fullStaging "release_root"
  Assert-Within $ConfigPath $fullStaging "config_path"
  foreach ($name in @("workspace_root", "evidence_root", "evolution_eval_ledger_root", "evolution_eval_spool_root", "evolution_eval_log_root")) {
    Assert-Within ([string](Require-Property $Config $name)) $fullStaging $name
  }
  foreach ($name in @("vivado_toolchain_attestation_path", "vivado_toolchain_lock_handoff_path")) {
    Assert-Within ([string](Require-Property $Config $name)) $fullStaging $name
  }
}

function Assert-LocalFixedNtfsVolume([string]$Path, [string]$Name) {
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
  $drive = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $root.TrimEnd('\') + "'")
  if ($null -eq $drive -or [int]$drive.DriveType -ne 3 -or [string]$drive.FileSystem -cne "NTFS") {
    Fail "M4F_ROOT_NOT_LOCAL_FIXED_NTFS" $Name
  }
  if ([uint64]$drive.FreeSpace -lt [uint64]$MinimumFreeBytes) { Fail "M4F_FREE_SPACE_BELOW_10_GIB" $Name }
}

function Assert-LocalNtfsDirectory([string]$Path, [string]$Name, [bool]$MustExist, [string]$AclPolicy = "trusted") {
  if ($AclPolicy -cne "trusted" -and $AclPolicy -cne "mutable_root") { Fail "M4F_ACL_POLICY_INVALID" $Name }
  if (-not [IO.Path]::IsPathRooted($Path)) { Fail "M4F_ROOT_NOT_ABSOLUTE" $Name }
  if (-not (Test-Path -LiteralPath $Path)) {
    if ($MustExist) { Fail "M4F_ROOT_MISSING" $Name }
    $parent = Split-Path -Parent $Path
    while ($parent -and -not (Test-Path -LiteralPath $parent)) { $parent = Split-Path -Parent $parent }
    if (-not $parent) { Fail "M4F_ROOT_PARENT_MISSING" $Name }
    Assert-TrustedPath $parent $Name
  } else {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "M4F_ROOT_NOT_DIRECTORY" $Name }
    if ($AclPolicy -ceq "mutable_root") { Assert-MutableRoot $Path $Name }
    else { Assert-TrustedPath $Path $Name }
  }
  Assert-LocalFixedNtfsVolume $Path $Name
}

function Assert-DistinctRoots([object]$Config) {
  $names = @("workspace_root", "evidence_root", "evolution_eval_ledger_root", "evolution_eval_spool_root", "evolution_eval_log_root")
  $seen = @{}
  foreach ($name in $names) {
    $path = [IO.Path]::GetFullPath([string](Require-Property $Config $name)).TrimEnd('\').ToLowerInvariant()
    foreach ($existing in $seen.Keys) {
      if ($path -eq $existing -or $path.StartsWith($existing + '\') -or $existing.StartsWith($path + '\')) {
        Fail "M4F_ROOTS_NOT_DISTINCT" $name
      }
    }
    $seen[$path] = $true
  }
}

function Write-JsonNoBom([string]$Path, [object]$Value) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 100) + [Environment]::NewLine), $encoding)
}

function Test-PipeClientCanStop([IO.Pipes.NamedPipeServerStream]$Pipe) {
  # The service identity is intentionally allowed to PING this pipe, so the
  # nonce is not a STOP credential. Authorize STOP from the impersonated pipe
  # client token itself; only SYSTEM or an elevated Administrators token may
  # release the ceremony's original FileShare.Read handle.
  $script:ToolchainStopClientAuthorized = $false
  $worker = [IO.Pipes.PipeStreamImpersonationWorker]{
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $script:ToolchainStopClientAuthorized = ($identity.User.Value -ceq "S-1-5-18") -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  try { $Pipe.RunAsClient($worker) }
  catch { return $false }
  return $script:ToolchainStopClientAuthorized
}

function Assert-EmptyOrAbsent([string]$Path, [string]$Name) {
  if (Test-Path -LiteralPath $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "M4F_ROOT_NOT_DIRECTORY" $Name }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -ne 0) { Fail "M4F_ROOT_NOT_EMPTY" $Name }
  }
}

function Resolve-ReleaseFiles {
  $resolvedRoot = [IO.Path]::GetFullPath($ReleaseRoot)
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) { Fail "M4F_RELEASE_ROOT_MISSING" }
  Assert-TrustedPath $resolvedRoot "release_root"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $resolvedRoot) "release_root"
  $script:ManifestPath = Join-Path $resolvedRoot "worker-release.manifest.json"
  $script:BundlePath = Join-Path $resolvedRoot "server.bundle.mjs"
  $script:LauncherPath = Join-Path $resolvedRoot "start-worker-66.cmd"
  $script:CertifierPath = Join-Path $resolvedRoot "certify-m4f-windows.ps1"
  if (-not $ConfigTemplatePath) { $script:ConfigTemplatePath = Join-Path $resolvedRoot "worker-66.config.template.json" }
  $script:Manifest = Read-Json $ManifestPath "release_manifest"
  if ([string]$Manifest.schema -cne "synthia-worker-release-manifest.v1") { Fail "M4F_MANIFEST_SCHEMA_INVALID" }
  if ([string]$Manifest.manifest_hash -notmatch $HashPattern) { Fail "M4F_MANIFEST_HASH_INVALID" }
  Require-File $BundlePath "bundle"
  Require-File $LauncherPath "launcher"
  Require-File $CertifierPath "certifier"
  Require-File $ConfigTemplatePath "config_template"
  $trustedFiles = @{
    bundle = $BundlePath
    launcher = $LauncherPath
    certifier = $CertifierPath
    config_template = $ConfigTemplatePath
    release_manifest = $ManifestPath
  }
  foreach ($pair in $trustedFiles.GetEnumerator()) {
    Assert-TrustedPath ([string]$pair.Value) ([string]$pair.Key)
    Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath ([string]$pair.Value)) ([string]$pair.Key)
  }
  Assert-Hash (Get-Sha256 $BundlePath) $Manifest.bundle.sha256 "bundle"
  if ((Get-Item -LiteralPath $BundlePath).Length -ne [int64]$Manifest.bundle.size_bytes) { Fail "M4F_BUNDLE_SIZE_MISMATCH" }
  Assert-Hash (Get-Sha256 $ConfigTemplatePath) $Manifest.release_files.config_template_sha256 "config_template"
  Assert-Hash (Get-Sha256 $LauncherPath) $Manifest.release_files.launcher_sha256 "launcher"
  Assert-Hash (Get-Sha256 $CertifierPath) $Manifest.release_files.windows_certifier_sha256 "certifier"
  if ([string]$Manifest.expected.sdk_worker_build_hash -cne [string]$Manifest.bundle.sha256) { Fail "M4F_BUILD_IDENTITY_INVALID" }
  if ([string]$Manifest.runtime.kind -cne "bun" -or [string]$Manifest.runtime.version -cne $ExpectedBunVersion -or [string]$Manifest.runtime.executable_name -cne "bun.exe") {
    Fail "M4F_RUNTIME_MANIFEST_INVALID"
  }
  Assert-NoSecretMaterial $ManifestPath "release_manifest"
  Assert-NoSecretMaterial $ConfigTemplatePath "config_template"
}

function Assert-BunRuntime {
  Require-File $BunPath "bun_runtime"
  if (-not [IO.Path]::IsPathRooted($BunPath)) { Fail "M4F_BUN_PATH_NOT_ABSOLUTE" }
  Assert-TrustedPath $BunPath "bun_runtime"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $BunPath) "bun_runtime"
  Assert-Hash (Get-Sha256 $BunPath) $Manifest.runtime.sha256 "bun_runtime"
  $version = (& $BunPath --version 2>$null | Select-Object -First 1).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -cne $ExpectedBunVersion) { Fail "M4F_BUN_VERSION_MISMATCH" $version }
}

function Assert-CanonicalManifest {
  # Bun cannot execute an entry file from a read-only sealed directory (its
  # loader writes a transpile sidecar next to the entry); stage verified
  # copies in a writable temp dir and execute those instead.
  $bunStage = Join-Path ([IO.Path]::GetTempPath()) ("synthia-m4f-bun-stage-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $bunStage | Out-Null
  try {
    $bundleCopy = Join-Path $bunStage "server.bundle.mjs"
    $manifestCopy = Join-Path $bunStage "worker-release.manifest.json"
    Copy-Item -LiteralPath $BundlePath -Destination $bundleCopy
    Copy-Item -LiteralPath $ManifestPath -Destination $manifestCopy
    $output = & $BunPath $bundleCopy --verify-release-manifest $manifestCopy 2>&1
  } finally { Remove-Item -LiteralPath $bunStage -Recurse -Force -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0 -or ([string]($output | Select-Object -Last 1)) -notmatch [regex]::Escape([string]$Manifest.manifest_hash)) {
    Fail "M4F_MANIFEST_CANONICAL_HASH_MISMATCH"
  }
}

function Assert-Config([object]$Config, [bool]$RequireExistingRoots, [bool]$RequireReopen) {
  if ([string](Require-Property $Config "protocol_version") -cne "connector.remote.v1") { Fail "M4F_CONFIG_INVALID" "protocol_version" }
  if ([string](Require-Property $Config "sdk_worker_build_hash") -cne [string]$Manifest.bundle.sha256) { Fail "M4F_CONFIG_INVALID" "sdk_worker_build_hash" }
  $expectedValues = @{
    capability_map_version = [string]$Manifest.expected.capability_map_version
    part_catalog_hash = [string]$Manifest.expected.part_catalog_hash
    toolchain_profile_hash = [string]$Manifest.expected.toolchain_profile_hash
    vivado_part = [string]$Manifest.expected.part
  }
  foreach ($name in $expectedValues.Keys) {
    if ([string](Require-Property $Config $name) -cne $expectedValues[$name]) { Fail "M4F_CONFIG_INVALID" $name }
  }
  $vivadoBinary = [string](Require-Property $Config "vivado_binary")
  Require-File $vivadoBinary "vivado_binary"
  Assert-TrustedPath $vivadoBinary "vivado_binary"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $vivadoBinary) "vivado_binary"
  foreach ($name in @("server_certificate_path", "server_private_key_path", "trusted_client_ca_path")) {
    $tlsPath = [string](Require-Property $Config $name)
    Require-File $tlsPath $name
    Assert-TrustedPath $tlsPath $name
    Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $tlsPath) $name
  }
  $enabledProperty = $Config.PSObject.Properties["evolution_eval_enabled"]
  if ($null -eq $enabledProperty -or $enabledProperty.Value -isnot [bool]) { Fail "M4F_CONFIG_INVALID" "evolution_eval_enabled" }
  if ($enabledProperty.Value) {
    $toolchainAttestationPath = [string](Require-Property $Config "vivado_toolchain_attestation_path")
    $toolchainAttestationSha256 = [string](Require-Property $Config "vivado_toolchain_attestation_sha256")
    Require-File $toolchainAttestationPath "vivado_toolchain_attestation"
    Assert-TrustedPath $toolchainAttestationPath "vivado_toolchain_attestation"
    Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $toolchainAttestationPath) "vivado_toolchain_attestation"
    Assert-Hash (Get-Sha256 $toolchainAttestationPath) $toolchainAttestationSha256 "vivado_toolchain_attestation"
    $toolchainHandoffPath = [string](Require-Property $Config "vivado_toolchain_lock_handoff_path")
    Require-File $toolchainHandoffPath "vivado_toolchain_lock_handoff"
    Assert-TrustedPath $toolchainHandoffPath "vivado_toolchain_lock_handoff"
    Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $toolchainHandoffPath) "vivado_toolchain_lock_handoff"
    $epochValue = [string](Require-Property $Config "evolution_eval_ledger_epoch")
    if ($epochValue -notmatch $EpochPattern -or $epochValue -ceq $PlaceholderEpoch) { Fail "M4F_CONFIG_INVALID" "evolution_eval_ledger_epoch" }
    $modeValue = [string](Require-Property $Config "evolution_eval_ledger_mode")
    if ($RequireReopen -and $modeValue -cne "reopen") { Fail "M4F_CONFIG_REOPEN_REQUIRED" }
    if (-not $RequireReopen -and $modeValue -cne "initialize" -and $modeValue -cne "reopen") { Fail "M4F_CONFIG_INVALID" "evolution_eval_ledger_mode" }
    Assert-DistinctRoots $Config
    foreach ($name in @("workspace_root", "evidence_root", "evolution_eval_ledger_root", "evolution_eval_spool_root", "evolution_eval_log_root")) {
      Assert-LocalNtfsDirectory ([string](Require-Property $Config $name)) $name $RequireExistingRoots "mutable_root"
      if ($RequireExistingRoots) { Assert-MutableRoot ([string](Require-Property $Config $name)) $name }
    }
  }
}

function Get-TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-NtfsFileIdentity([string]$Path, [string]$Name) {
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path)).TrimEnd('\')
  $volume = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $root + "'")
  $fileIdOutput = (& fsutil.exe file queryfileid $Path 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $fileIdOutput -notmatch "(?i)0x[0-9a-f]+") { Fail "M4F_FILE_IDENTITY_UNAVAILABLE" $Name }
  return [pscustomobject]@{
    volume_serial_number = [string]$volume.VolumeSerialNumber
    file_id = [string]$Matches[0].ToLowerInvariant()
  }
}

function Assert-NoReparseOrAlternateStreams([string]$Root, [string]$Name) {
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (-not $rootItem.PSIsContainer) { Fail "M4F_FULL_TREE_ROOT_NOT_DIRECTORY" $Name }
  foreach ($item in @($rootItem) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "M4F_REPARSE_POINT_REJECTED" $Name }
    $streams = @(Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction Stop)
    if ($item.PSIsContainer) {
      if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) { Fail "M4F_ALTERNATE_DATA_STREAM_REJECTED" $Name }
    } elseif ($streams.Count -ne 1 -or [string]$streams[0].Stream -cne ':$DATA') {
      Fail "M4F_ALTERNATE_DATA_STREAM_REJECTED" $Name
    }
  }
}

function Build-FullTreeManifest([string]$Root, [string]$Output, [string]$Name) {
  Assert-NoReparseOrAlternateStreams $Root $Name
  $result = & $BunPath $BundlePath --build-vivado-full-tree-manifest $Root $Output 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output -PathType Leaf)) { Fail "M4F_FULL_TREE_MANIFEST_FAILED" $Name }
  return Read-Json $Output $Name
}

function Invoke-VivadoProbe([string]$Vivado, [string[]]$Arguments, [string]$Name) {
  $output = (& $Vivado @Arguments 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { Fail "M4F_VIVADO_PROBE_FAILED" $Name }
  return $output
}

Initialize-AllowedWriterSids
Resolve-ReleaseFiles
Assert-BunRuntime
Assert-CanonicalManifest

if ($Mode -eq "ToolchainLockStop") {
  if (-not $ConfirmToolchainDrainComplete) { Fail "M4F_TOOLCHAIN_DRAIN_CONFIRMATION_REQUIRED" }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail "M4F_TOOLCHAIN_LOCK_STOP_REQUIRES_ADMIN" }
  Require-File $ToolchainLockHandoffPath "toolchain_lock_handoff"
  Assert-TrustedPath $ToolchainLockHandoffPath "toolchain_lock_handoff"
  $handoff = Read-Json $ToolchainLockHandoffPath "toolchain_lock_handoff"
  if ([string]$handoff.schema -cne "synthia-vivado-toolchain-lock-handoff.v1" -or -not $handoff.pipe_name -or -not $handoff.nonce -or -not $handoff.supervisor_pid -or [string]$handoff.supervisor_start_token -notmatch $HashPattern) { Fail "M4F_TOOLCHAIN_HANDOFF_INVALID" }
  Require-File $ToolchainAttestationPath "vivado_toolchain_attestation"
  Assert-TrustedPath $ToolchainAttestationPath "vivado_toolchain_attestation"
  Assert-Hash (Get-Sha256 $ToolchainAttestationPath) $handoff.vivado_toolchain_attestation_sha256 "vivado_toolchain_attestation"
  $stopAttestation = Read-Json $ToolchainAttestationPath "vivado_toolchain_attestation"
  if ([string]$stopAttestation.schema -cne "synthia-vivado-toolchain-attestation.v1" -or
    [string]$stopAttestation.gate_id -cne $GateId -or
    -not $VhdxPath -or -not ([IO.Path]::GetFullPath([string]$stopAttestation.vhdx.path)).Equals([IO.Path]::GetFullPath($VhdxPath), [StringComparison]::OrdinalIgnoreCase)) { Fail "M4F_TOOLCHAIN_STOP_ATTESTATION_INVALID" }
  Require-File ([string]$stopAttestation.vhdx.path) "toolchain_vhdx"
  Require-File $ToolchainDrainEvidencePath "toolchain_drain_evidence"
  Assert-TrustedPath $ToolchainDrainEvidencePath "toolchain_drain_evidence"
  Assert-Hash (Get-Sha256 $ToolchainDrainEvidencePath) $ToolchainDrainEvidenceSha256 "toolchain_drain_evidence"
  $drain = Read-Json $ToolchainDrainEvidencePath "toolchain_drain_evidence"
  if ([string]$drain.schema -cne "synthia-vivado-toolchain-drain-evidence.v1" -or [string]$drain.gate_id -cne $GateId -or [string]$drain.vivado_toolchain_attestation_sha256 -cne [string]$handoff.vivado_toolchain_attestation_sha256 -or $drain.new_effects_disabled -ne $true -or $drain.worker_listener_stopped -ne $true -or [int]$drain.active_worker_processes -ne 0 -or [int]$drain.active_vivado_processes -ne 0 -or [string]$drain.worker_process_instance_id -notmatch "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" -or [int]$drain.worker_pid -lt 1 -or [string]$drain.worker_start_token -notmatch $HashPattern -or [int]$drain.worker_listener_port -lt 1 -or [int]$drain.worker_listener_port -gt 65535 -or $drain.accepted_effects_terminal -ne $true -or $drain.recovery_retention_converged -ne $true) { Fail "M4F_TOOLCHAIN_DRAIN_EVIDENCE_INVALID" }
  $drainedWorker = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$drain.worker_pid)
  if ($null -ne $drainedWorker) {
    $drainedWorkerToken = Get-TextSha256 (([string]$drainedWorker.ProcessId) + "|" + ([string]$drainedWorker.CreationDate) + "|" + ([string]$drainedWorker.ExecutablePath))
    if ($drainedWorkerToken -ceq [string]$drain.worker_start_token) { Fail "M4F_TOOLCHAIN_WORKER_STILL_RUNNING" }
  }
  if (@(Get-NetTCPConnection -State Listen -LocalPort ([int]$drain.worker_listener_port) -ErrorAction SilentlyContinue).Count -ne 0) { Fail "M4F_TOOLCHAIN_WORKER_LISTENER_STILL_ACTIVE" }
  $supervisorFacts = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$handoff.supervisor_pid)
  if ($null -eq $supervisorFacts -or (Get-TextSha256 (([string]$supervisorFacts.ProcessId) + "|" + ([string]$supervisorFacts.CreationDate) + "|" + ([string]$supervisorFacts.ExecutablePath))) -cne [string]$handoff.supervisor_start_token) { Fail "M4F_TOOLCHAIN_SUPERVISOR_IDENTITY_MISMATCH" }
  $client = New-Object IO.Pipes.NamedPipeClientStream(".", [string]$handoff.pipe_name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Impersonation)
  try {
    $client.Connect(10000)
    $reader = New-Object IO.StreamReader($client, (New-Object Text.UTF8Encoding($false)), $false, 4096, $true)
    $writer = New-Object IO.StreamWriter($client, (New-Object Text.UTF8Encoding($false)), 4096, $true)
    $writer.AutoFlush = $true
    $writer.WriteLine(("STOP|" + [string]$handoff.nonce))
    if ($reader.ReadLine() -cne "STOPPING") { Fail "M4F_TOOLCHAIN_LOCK_STOP_REJECTED" }
  } finally { $client.Dispose() }
  $exitDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $exitDeadline -and $null -ne (Get-Process -Id ([int]$handoff.supervisor_pid) -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 100 }
  if ($null -ne (Get-Process -Id ([int]$handoff.supervisor_pid) -ErrorAction SilentlyContinue)) { Fail "M4F_TOOLCHAIN_SUPERVISOR_STOP_TIMEOUT" }
  Dismount-DiskImage -ImagePath ([string]$stopAttestation.vhdx.path) -ErrorAction Stop
  if ((Get-DiskImage -ImagePath ([string]$stopAttestation.vhdx.path)).Attached) { Fail "M4F_TOOLCHAIN_DETACH_FAILED" }
  [pscustomobject]@{ schema = "synthia-vivado-toolchain-lock-stop.v1"; status = "detached_after_explicit_drain"; attestation_sha256 = [string]$handoff.vivado_toolchain_attestation_sha256; drain_evidence_sha256 = $ToolchainDrainEvidenceSha256; supervisor_pid = [int]$handoff.supervisor_pid } | ConvertTo-Json -Depth 8
  exit 0
}

if ($Mode -eq "ToolchainNegativeChecks") {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail "M4F_NEGATIVE_CHECK_REQUIRES_NON_ADMIN" }
  Require-File $ToolchainAttestationPath "vivado_toolchain_attestation"
  Assert-Hash (Get-Sha256 $ToolchainAttestationPath) $ToolchainAttestationSha256 "vivado_toolchain_attestation"
  $verifyNegativeAttestation = & $BunPath $BundlePath --verify-vivado-toolchain-attestation-file $ToolchainAttestationPath $ToolchainAttestationSha256 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "M4F_TOOLCHAIN_ATTESTATION_INVALID" }
  $negativeAttestation = Read-Json $ToolchainAttestationPath "vivado_toolchain_attestation"
  if ([string]$negativeAttestation.gate_id -cne $GateId -or -not ([IO.Path]::GetFullPath([string]$negativeAttestation.vhdx.path)).Equals([IO.Path]::GetFullPath($VhdxPath), [StringComparison]::OrdinalIgnoreCase)) { Fail "M4F_NEGATIVE_CHECK_BINDING_MISMATCH" }
  Require-File $VhdxPath "toolchain_vhdx"
  $image = Get-DiskImage -ImagePath $VhdxPath
  if (-not $image.Attached) { Fail "M4F_NEGATIVE_CHECK_IMAGE_NOT_ATTACHED" }
  $disk = $image | Get-Disk
  $partition = $disk | Get-Partition | Where-Object { $null -ne $_.DriveLetter } | Select-Object -First 1
  $volume = $partition | Get-Volume
  $logicalVolumeSerialNumber = Get-LogicalDiskVolumeSerialNumber ([string]$partition.DriveLetter + ":\") "negative_check_volume"
  $negativeIdentity = Get-NtfsFileIdentity $VhdxPath "toolchain_vhdx"
  if (-not $disk.IsReadOnly -or [string]$disk.UniqueId -cne [string]$negativeAttestation.attachment.disk.unique_id -or [int]$disk.Number -ne [int]$negativeAttestation.attachment.disk.number -or [int]$partition.PartitionNumber -ne [int]$negativeAttestation.attachment.partition.number -or [string]$volume.UniqueId -cne [string]$negativeAttestation.attachment.volume.guid -or $logicalVolumeSerialNumber -cne [string]$negativeAttestation.attachment.volume.serial_number -or [string]$negativeIdentity.file_id -cne [string]$negativeAttestation.vhdx.file_identity.file_id -or [string]$negativeIdentity.volume_serial_number -cne [string]$negativeAttestation.vhdx.file_identity.volume_serial_number) { Fail "M4F_NEGATIVE_CHECK_BINDING_MISMATCH" }
  $originalMount = ([string]$partition.DriveLetter + ":\")
  $attempts = @(
    [pscustomobject]@{ name = "detach"; action = { Dismount-DiskImage -ImagePath $VhdxPath -ErrorAction Stop } },
    [pscustomobject]@{ name = "remount_readwrite"; action = { Mount-DiskImage -ImagePath $VhdxPath -Access ReadWrite -ErrorAction Stop } },
    [pscustomobject]@{ name = "delete"; action = { Remove-Item -LiteralPath $VhdxPath -Force -ErrorAction Stop } },
    [pscustomobject]@{ name = "rename"; action = { Rename-Item -LiteralPath $VhdxPath -NewName ((Split-Path -Leaf $VhdxPath) + ".forbidden") -ErrorAction Stop } },
    [pscustomobject]@{ name = "replace"; action = { [IO.File]::WriteAllBytes($VhdxPath, [byte[]](0)) } },
    [pscustomobject]@{ name = "mapping"; action = { Remove-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath $originalMount -ErrorAction Stop } }
  )
  $results = @()
  foreach ($attempt in $attempts) {
    $denied = $false
    try { & $attempt.action }
    catch { $denied = $true }
    if (-not $denied) { Fail "M4F_NEGATIVE_CHECK_UNEXPECTEDLY_SUCCEEDED" $attempt.name }
    $results += [pscustomobject]@{ operation = $attempt.name; result = "access_denied" }
  }
  [pscustomobject]@{ schema = "synthia-vivado-toolchain-negative-checks.v1"; status = "passed"; gate_id = $GateId; identity_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; vhdx_path = [IO.Path]::GetFullPath($VhdxPath); vhdx_sha256 = [string]$negativeAttestation.vhdx.sha256; file_identity = $negativeAttestation.vhdx.file_identity; disk = $negativeAttestation.attachment.disk; partition = $negativeAttestation.attachment.partition; volume = $negativeAttestation.attachment.volume; vivado_toolchain_attestation_sha256 = $ToolchainAttestationSha256; results = $results } | ConvertTo-Json -Depth 16
  exit 0
}

if ($Mode -eq "ToolchainImage") {
  if (-not $ConfirmCreateToolchainImage -or -not $StagingRoot -or -not $GateId -or $GateId -notmatch $GateIdPattern) { Fail "M4F_TOOLCHAIN_IMAGE_CONFIRMATION_REQUIRED" }
  if (-not $VivadoSourceRoot -or -not $VhdxPath -or -not $ToolchainMountPath) { Fail "M4F_TOOLCHAIN_PATH_REQUIRED" }
  Assert-ToolchainImageAdministrativePrincipal
  Assert-ToolchainServiceIdentityNonPrivileged
  if (Test-Path -LiteralPath $VhdxPath) { Fail "M4F_TOOLCHAIN_VHDX_ALREADY_EXISTS" }
  $backingParent = Split-Path -Parent ([IO.Path]::GetFullPath($VhdxPath))
  if (-not (Test-Path -LiteralPath $backingParent -PathType Container)) { Fail "M4F_TOOLCHAIN_BACKING_PARENT_MISSING" }
  Assert-ProtectedObject $backingParent "toolchain_backing_parent"
  Assert-NoReparseAncestor $backingParent "toolchain_backing_parent"
  $backingParentAcl = Get-Acl -LiteralPath $backingParent
  if ((Get-IdentitySid $backingParentAcl.Owner "toolchain_backing_parent") -ceq
    (Get-IdentitySid $ServiceIdentity "service_identity")) {
    Fail "M4F_TOOLCHAIN_SERVICE_OWNER_FORBIDDEN" "toolchain_backing_parent"
  }
  Grant-ToolchainServiceReadExecute $backingParent "toolchain_backing_parent_service"
  Assert-ToolchainBackingServiceBoundary $backingParent "toolchain_backing_parent_service"
  $imageWorkRoot = Join-Path ([IO.Path]::GetFullPath($StagingRoot)) ("toolchain-image-" + $GateId)
  if (Test-Path -LiteralPath $imageWorkRoot) { Fail "M4F_TOOLCHAIN_WORK_ALREADY_EXISTS" }
  New-Item -ItemType Directory -Path $imageWorkRoot | Out-Null
  Protect-NewTrustedObject $imageWorkRoot "toolchain_image_work"
  $sourceBeforePath = Join-Path $imageWorkRoot "source-before.json"
  $sourceAfterPath = Join-Path $imageWorkRoot "source-after.json"
  $targetPath = Join-Path $imageWorkRoot "target.json"
  $sourceBefore = Build-FullTreeManifest $VivadoSourceRoot $sourceBeforePath "source_before"
  $virtualSize = Get-ToolchainVirtualSize $sourceBefore.total_bytes
  $requiredHostBytes = $virtualSize
  $hostRoot = [IO.Path]::GetPathRoot($backingParent).TrimEnd('\')
  $hostDrive = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $hostRoot + "'")
  if ($null -eq $hostDrive -or [uint64]$hostDrive.FreeSpace -lt $requiredHostBytes) { Fail "M4F_TOOLCHAIN_HOST_SPACE_INSUFFICIENT" }
  $mountRoot = [IO.Path]::GetFullPath($ToolchainMountPath)
  if ($mountRoot -notmatch "^[A-Za-z]:\\$") { Fail "M4F_TOOLCHAIN_MOUNT_PATH_INVALID" }
  if (Test-Path -LiteralPath $mountRoot) { Fail "M4F_TOOLCHAIN_MOUNT_PATH_IN_USE" }
  if ($null -ne (Get-Command New-VHD -ErrorAction SilentlyContinue)) {
    New-VHD -Path $VhdxPath -Dynamic -SizeBytes $virtualSize | Out-Null
  } else {
    $diskpartPath = Join-Path $imageWorkRoot "create-vhdx.diskpart"
    $maximumMiB = [uint64]([decimal]$virtualSize / [decimal](1MB))
    [IO.File]::WriteAllText($diskpartPath, ('create vdisk file="' + [IO.Path]::GetFullPath($VhdxPath) + '" maximum=' + $maximumMiB + " type=expandable`r`nexit`r`n"), (New-Object Text.ASCIIEncoding))
    & diskpart.exe /s $diskpartPath | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VhdxPath -PathType Leaf)) { Fail "M4F_TOOLCHAIN_VHDX_CREATE_FAILED" }
  }
  Protect-NewToolchainBackingObject $VhdxPath "toolchain_vhdx"
  Grant-ToolchainServiceReadExecute $VhdxPath "toolchain_vhdx_service"
  Assert-ToolchainBackingServiceBoundary $VhdxPath "toolchain_vhdx_service"
  $aclChain = @()
  foreach ($aclPath in @([IO.Path]::GetPathRoot($backingParent), $backingParent, [IO.Path]::GetFullPath($VhdxPath))) {
    $chainAcl = Get-Acl -LiteralPath $aclPath
    $aclChain += [pscustomobject]@{ path = $aclPath; owner_sid = Get-IdentitySid $chainAcl.Owner "toolchain_acl_chain"; protected = [bool]$chainAcl.AreAccessRulesProtected; acl_sha256 = Get-TextSha256 ($chainAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)) }
  }
  $backingAclChainPath = Join-Path $imageWorkRoot "backing-acl-chain.json"
  Write-JsonNoBom $backingAclChainPath ([pscustomobject]@{ schema = "synthia-vivado-toolchain-backing-acl-chain.v1"; entries = $aclChain })
  Protect-NewTrustedObject $backingAclChainPath "toolchain_backing_acl_chain"
  try {
    $mounted = Mount-DiskImage -ImagePath $VhdxPath -Access ReadWrite -PassThru
    $disk = Initialize-Disk -Number (($mounted | Get-Disk).Number) -PartitionStyle GPT -PassThru
    $partition = $disk | New-Partition -UseMaximumSize
    $volume = $partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel "SynthiaVivado" -Confirm:$false
    Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath $mountRoot
    if ([uint64]$volume.SizeRemaining -lt [uint64](10GB)) { Fail "M4F_TOOLCHAIN_GUEST_SPACE_INSUFFICIENT" }
    $formattedVolumeSerialNumber = Get-LogicalDiskVolumeSerialNumber $mountRoot "formatted_toolchain_volume"
    Initialize-NewToolchainVolumeRoot $mountRoot ([string]$volume.UniqueId) $formattedVolumeSerialNumber
    $targetInstallRoot = Join-Path $mountRoot "Vivado"
    New-Item -ItemType Directory -Path $targetInstallRoot | Out-Null
    Protect-NewTrustedObject $targetInstallRoot "toolchain_install_root"
    & robocopy.exe $VivadoSourceRoot $targetInstallRoot /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "M4F_TOOLCHAIN_COPY_FAILED" ([string]$LASTEXITCODE) }
    foreach ($targetItem in @(Get-ChildItem -LiteralPath $mountRoot -Force -Recurse)) { Protect-NewTrustedObject $targetItem.FullName "toolchain_tree_acl" }
    foreach ($targetItem in @((Get-Item -LiteralPath $mountRoot -Force), (Get-Item -LiteralPath $targetInstallRoot -Force)) +
      @(Get-ChildItem -LiteralPath $targetInstallRoot -Force -Recurse)) {
      Grant-ToolchainServiceReadExecute $targetItem.FullName "toolchain_service_read_execute"
    }
    $sourceAfter = Build-FullTreeManifest $VivadoSourceRoot $sourceAfterPath "source_after"
    $target = Build-FullTreeManifest $targetInstallRoot $targetPath "target"
    if ([string]$sourceBefore.canonical_sha256 -cne [string]$sourceAfter.canonical_sha256 -or [string]$sourceBefore.canonical_sha256 -cne [string]$target.canonical_sha256) { Fail "M4F_TOOLCHAIN_FULL_TREE_DRIFT" }
  } finally {
    Dismount-DiskImage -ImagePath $VhdxPath -ErrorAction SilentlyContinue
  }
  $virtualSizeObserved = $virtualSize
  if ($null -ne (Get-Command Get-VHD -ErrorAction SilentlyContinue)) {
    $vhd = Get-VHD -Path $VhdxPath
    if ([string]$vhd.VhdType -cne "Dynamic" -or -not [string]::IsNullOrWhiteSpace([string]$vhd.ParentPath)) { Fail "M4F_TOOLCHAIN_VHDX_TYPE_INVALID" }
    $virtualSizeObserved = [uint64]$vhd.Size
    if ($virtualSizeObserved -ne $virtualSize) { Fail "M4F_TOOLCHAIN_VHDX_SIZE_MISMATCH" }
  }
  [pscustomobject]@{ schema = "synthia-vivado-toolchain-image-ceremony.v1"; status = "detached"; vhdx_path = [IO.Path]::GetFullPath($VhdxPath); virtual_size_bytes = [uint64]$virtualSizeObserved; source_manifest_sha256 = [string]$sourceBefore.canonical_sha256; target_manifest_sha256 = [string]$target.canonical_sha256 } | ConvertTo-Json -Depth 8
  exit 0
}

if ($Mode -eq "ToolchainAttestation") {
  if (-not $ConfirmReadOnlyToolchainProbe -or -not $ConfirmKnownCurrentProvenanceLimitation -or -not $StagingRoot -or -not $GateId -or $GateId -notmatch $GateIdPattern) { Fail "M4F_TOOLCHAIN_CONFIRMATION_REQUIRED" }
  foreach ($requiredPath in @($VivadoSourceRoot, $VhdxPath, $ToolchainMountPath)) {
    if (-not $requiredPath -or -not [IO.Path]::IsPathRooted($requiredPath)) { Fail "M4F_TOOLCHAIN_PATH_REQUIRED" }
  }
  if (-not $ToolchainAttestationPath -or -not $ToolchainSemanticProfileSha256 -or $ToolchainSemanticProfileSha256 -notmatch $HashPattern -or -not $VendorMaterialRoot -or -not $ToolchainLockHandoffPath) { Fail "M4F_TOOLCHAIN_ATTESTATION_ARGUMENT_INVALID" }
  if ($ToolchainValidityMinutes -lt 1 -or $ToolchainValidityMinutes -gt 240) { Fail "M4F_TOOLCHAIN_VALIDITY_INVALID" }
  if ($ToolchainHandoffTimeoutSeconds -lt 60 -or $ToolchainHandoffTimeoutSeconds -gt 14400) { Fail "M4F_TOOLCHAIN_HANDOFF_TIMEOUT_INVALID" }
  if (-not (Test-Path -LiteralPath $VendorMaterialRoot -PathType Container)) { Fail "M4F_TOOLCHAIN_VENDOR_MATERIAL_MISSING" }
  Assert-Within $ToolchainLockHandoffPath $StagingRoot "toolchain_lock_handoff"
  Require-File $VhdxPath "toolchain_vhdx"
  Assert-ToolchainBackingServiceBoundary (Split-Path -Parent $VhdxPath) "toolchain_backing_parent"
  Assert-ToolchainBackingServiceBoundary $VhdxPath "toolchain_vhdx"
  Assert-NoReparseAncestor $VhdxPath "toolchain_vhdx"
  $workRoot = Join-Path ([IO.Path]::GetFullPath($StagingRoot)) ("toolchain-attestation-" + $GateId)
  if (Test-Path -LiteralPath $workRoot) { Fail "M4F_TOOLCHAIN_WORK_ALREADY_EXISTS" }
  New-Item -ItemType Directory -Path $workRoot | Out-Null
  Protect-NewServiceReadableTrustedObject $workRoot "toolchain_work"
  $sourceBeforePath = Join-Path $workRoot "source-before.json"
  $sourceAfterPath = Join-Path $workRoot "source-after.json"
  $targetPath = Join-Path $workRoot "readonly-target.json"
  $sourceBefore = Build-FullTreeManifest $VivadoSourceRoot $sourceBeforePath "source_before"
  $preIdentity = Get-NtfsFileIdentity $VhdxPath "toolchain_vhdx"
  $stream = [IO.File]::Open($VhdxPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $vhdxHash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
    $vhdxSize = $stream.Length
    $image = Mount-DiskImage -ImagePath $VhdxPath -Access ReadOnly -PassThru
    try {
      $disk = $image | Get-Disk
      if (-not $disk.IsReadOnly) { Fail "M4F_TOOLCHAIN_NOT_READ_ONLY" }
      # Drive-letter assignment at volume arrival is asynchronous and is not
      # reliably restored from MountedDevices on this host; poll briefly, then
      # assign the expected letter to the basic-data partition explicitly.
      $partition = $null
      $letterWaitDeadline = [DateTime]::UtcNow.AddSeconds(10)
      while ([DateTime]::UtcNow -lt $letterWaitDeadline) {
        $partition = $disk | Get-Partition | Where-Object { ([string]$_.DriveLetter) -cmatch '^[A-Za-z]$' } | Select-Object -First 1
        if ($null -ne $partition) { break }
        Start-Sleep -Milliseconds 500
      }
      if ($null -eq $partition) {
        $dataPartition = $disk | Get-Partition | Where-Object { $_.GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' } | Select-Object -First 1
        if ($null -ne $dataPartition) {
          try {
            Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $dataPartition.PartitionNumber -AccessPath ([string]$ToolchainMountPath) -ErrorAction Stop
          } catch { }
          Start-Sleep -Seconds 2
          $partition = $disk | Get-Partition | Where-Object { -not [string]::IsNullOrEmpty([string]$_.DriveLetter) } | Select-Object -First 1
        }
      }
      if ($null -eq $partition) { Fail "M4F_TOOLCHAIN_PARTITION_MISSING" }
      $volume = $partition | Get-Volume
      # Resolve the real mount path from the DriveLetter property when
      # present, else from the partition's access paths: on this host the
      # storage stack sets one or the other inconsistently.
      $actualMount = $null
      if (([string]$partition.DriveLetter) -cmatch '^[A-Za-z]$') {
        $actualMount = ([string]$partition.DriveLetter + ":\")
      } else {
        foreach ($accessPath in @($partition.AccessPaths)) {
          if ([string]$accessPath -cmatch '^[A-Za-z]:\\$') { $actualMount = [string]$accessPath; break }
        }
      }
      if ($null -eq $actualMount) { Fail "M4F_TOOLCHAIN_MAPPING_UNRESOLVED" ([string]($partition.AccessPaths -join ';')) }
      if (-not $actualMount.Equals(([IO.Path]::GetFullPath($ToolchainMountPath)), [StringComparison]::OrdinalIgnoreCase)) { Fail "M4F_TOOLCHAIN_MAPPING_MISMATCH" $actualMount }
      if ([string]$volume.FileSystem -cne "NTFS") { Fail "M4F_TOOLCHAIN_VOLUME_INVALID" }
      $logicalVolumeSerialNumber = Get-LogicalDiskVolumeSerialNumber $actualMount "toolchain_attestation_volume"
      $postIdentity = Get-NtfsFileIdentity $VhdxPath "toolchain_vhdx_attached"
      if ($postIdentity.file_id -cne $preIdentity.file_id -or $postIdentity.volume_serial_number -cne $preIdentity.volume_serial_number) { Fail "M4F_TOOLCHAIN_FILE_IDENTITY_DRIFT" }
      $writeProbe = Join-Path $actualMount "synthia-write-probe.tmp"
      try { [IO.File]::WriteAllText($writeProbe, "forbidden"); Fail "M4F_TOOLCHAIN_WRITE_PROBE_SUCCEEDED" }
      catch { if (Test-Path -LiteralPath $writeProbe) { Remove-Item -LiteralPath $writeProbe -Force -ErrorAction SilentlyContinue; Fail "M4F_TOOLCHAIN_WRITE_PROBE_SUCCEEDED" } }
      $sourceAfter = Build-FullTreeManifest $VivadoSourceRoot $sourceAfterPath "source_after"
      $targetInstallRoot = Join-Path $actualMount "Vivado"
      $target = Build-FullTreeManifest $targetInstallRoot $targetPath "readonly_target"
      if ([string]$sourceBefore.canonical_sha256 -cne [string]$sourceAfter.canonical_sha256 -or [string]$sourceBefore.canonical_sha256 -cne [string]$target.canonical_sha256) { Fail "M4F_TOOLCHAIN_FULL_TREE_DRIFT" }
      Assert-ProtectedObject $actualMount "toolchain_volume_root"
      Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $actualMount) "toolchain_volume_root_service"
      foreach ($targetItem in @(Get-ChildItem -LiteralPath $actualMount -Force -Recurse)) {
        Assert-ProtectedObject $targetItem.FullName "toolchain_tree_acl"
      }
      foreach ($targetItem in @((Get-Item -LiteralPath $targetInstallRoot -Force)) +
        @(Get-ChildItem -LiteralPath $targetInstallRoot -Force -Recurse)) {
        Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $targetItem.FullName) "toolchain_tree_service"
      }
      $authenticodeEntries = @()
      $authenticodeCandidates = @(
        @(Get-ChildItem -LiteralPath $actualMount -File -Recurse -ErrorAction Stop | Where-Object { $_.Name -match "^(?i:vivado)\.exe$" })
        @(Get-ChildItem -LiteralPath $VendorMaterialRoot -File -Recurse -ErrorAction Stop | Where-Object { $_.Name -match "^(?i:xsetup|xuninstall)\.exe$" })
      )
      foreach ($candidate in $authenticodeCandidates) {
        $signature = Get-AuthenticodeSignature -LiteralPath $candidate.FullName
        $authenticodeEntries += [pscustomobject]@{ path = [IO.Path]::GetFullPath($candidate.FullName); sha256 = Get-Sha256 $candidate.FullName; status = [string]$signature.Status; signer = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null } }
      }
      $vendorMaterial = @(Get-ChildItem -LiteralPath $VendorMaterialRoot -File -Recurse -ErrorAction Stop | Where-Object { $_.Name -match "^(?i:xinstall.*\.log|install.*\.log|xsetup\.exe|xuninstall\.exe)$" } | ForEach-Object { [pscustomobject]@{ path = [IO.Path]::GetFullPath($_.FullName); sha256 = Get-Sha256 $_.FullName } })
      $validVendorSigner = @($authenticodeEntries | Where-Object { $_.status -ceq "Valid" -and $_.path -match "(?i)(xsetup|xuninstall)\.exe$" -and $_.signer -match "(?i)(Xilinx|Advanced Micro Devices|AMD)" }).Count -gt 0
      if ($authenticodeEntries.Count -lt 1 -or -not $validVendorSigner -or $vendorMaterial.Count -lt 1) { Fail "M4F_TOOLCHAIN_VENDOR_PROVENANCE_INSUFFICIENT" }
      $vivado = Join-Path $actualMount "Vivado\bin\vivado.bat"
      Require-File $vivado "vivado_binary"
      $vivadoExe = Join-Path $actualMount "Vivado\bin\unwrapped\win64.o\vivado.exe"
      $criticalDll = Join-Path $actualMount "Vivado\lib\win64.o\librdi_common.dll"
      $vivadoLoader = Join-Path $actualMount "Vivado\bin\loader.bat"
      $vivadoSetupEnv = Join-Path $actualMount "Vivado\bin\setupEnv.bat"
      Require-File $vivadoExe "vivado_executable"
      Require-File $criticalDll "vivado_critical_dll"
      Require-File $vivadoLoader "vivado_loader"
      Require-File $vivadoSetupEnv "vivado_setup_env"
      $vivadoExeSignature = Get-AuthenticodeSignature -LiteralPath $vivadoExe
      $criticalDllSignature = Get-AuthenticodeSignature -LiteralPath $criticalDll
      $vivadoExeSha256 = Get-Sha256 $vivadoExe
      $criticalDllSha256 = Get-Sha256 $criticalDll
      $vivadoLauncherSignature = Get-AuthenticodeSignature -LiteralPath $vivado
      if ((Get-Sha256 $vivado) -cne "5d97b4c31ca191ca304da1d466857a65470c21ec6e9718f47537a49da40634f7" -or
        (Get-Item -LiteralPath $vivado).Length -ne 1263 -or
        [string]$vivadoLauncherSignature.Status -cne "UnknownError" -or
        (Get-Sha256 $vivadoLoader) -cne "2246f69bc427feb2beeb89a520650a1b926c819e35635305f0009d6958d7c850" -or
        (Get-Item -LiteralPath $vivadoLoader).Length -ne 17776 -or
        (Get-Sha256 $vivadoSetupEnv) -cne "e65045abd16b424d30b7b283d01676a26b5ec7ed8a92dbb173bc6771cb614994" -or
        (Get-Item -LiteralPath $vivadoSetupEnv).Length -ne 12982 -or
        $vivadoExeSha256 -cne "179b24f2214c528c2749f77fc3a7baf7c1578f1a47726ad441052f3a6afcd2aa" -or
        $criticalDllSha256 -cne "933ee02cd71c652e1f4d7c055822684f0416da7028c064a4a7c5c7ecb668f21e" -or
        [string]$vivadoExeSignature.Status -cne "NotSigned" -or
        [string]$criticalDllSignature.Status -cne "NotSigned") { Fail "M4F_TOOLCHAIN_KNOWN_CURRENT_CHAIN_MISMATCH" }
      $criticalChain = @(
        [pscustomobject]@{ role = "launcher"; relative_path = "Vivado/bin/vivado.bat"; path = $vivado; size_bytes = 1263; sha256 = Get-Sha256 $vivado; authenticode_status = [string]$vivadoLauncherSignature.Status; signer = $null },
        [pscustomobject]@{ role = "loader"; relative_path = "Vivado/bin/loader.bat"; path = $vivadoLoader; size_bytes = 17776; sha256 = Get-Sha256 $vivadoLoader; authenticode_status = [string](Get-AuthenticodeSignature -LiteralPath $vivadoLoader).Status; signer = $null },
        [pscustomobject]@{ role = "environment"; relative_path = "Vivado/bin/setupEnv.bat"; path = $vivadoSetupEnv; size_bytes = 12982; sha256 = Get-Sha256 $vivadoSetupEnv; authenticode_status = [string](Get-AuthenticodeSignature -LiteralPath $vivadoSetupEnv).Status; signer = $null },
        [pscustomobject]@{ role = "executable"; relative_path = "Vivado/bin/unwrapped/win64.o/vivado.exe"; path = $vivadoExe; size_bytes = 182784; sha256 = $vivadoExeSha256; authenticode_status = [string]$vivadoExeSignature.Status; signer = $null },
        [pscustomobject]@{ role = "critical_dll"; relative_path = "Vivado/lib/win64.o/librdi_common.dll"; path = $criticalDll; size_bytes = 19415552; sha256 = $criticalDllSha256; authenticode_status = [string]$criticalDllSignature.Status; signer = $null }
      )
      $authenticodeEvidencePath = Join-Path $workRoot "authenticode-evidence.json"
      Write-JsonNoBom $authenticodeEvidencePath ([pscustomobject]@{ schema = "synthia-vivado-authenticode-evidence.v1"; provenance_class = "known-current-installation-snapshot"; reviewer_limitation_confirmed = $true; entries = $authenticodeEntries; critical_chain = $criticalChain; vendor_material = $vendorMaterial })
      $versionOutput = Invoke-VivadoProbe $vivado @("-version") "version"
      if ($versionOutput -notmatch "Vivado v2021\.1" -or $versionOutput -notmatch "SW Build 3247384" -or $versionOutput -notmatch "IP Build 3246043") { Fail "M4F_VIVADO_VERSION_MISMATCH" }
      $probeSource = Join-Path $workRoot "probe.v"
      $probeTcl = Join-Path $workRoot "probe.tcl"
      [IO.File]::WriteAllText($probeSource, "module synthia_probe(input wire a, output wire y); assign y=a; endmodule`n", (New-Object Text.UTF8Encoding($false)))
      $tcl = "puts [join [get_parts xc7k70tfbv676-1] `"\n`"]`nread_verilog {$($probeSource.Replace('\','/'))}`nsynth_design -top synthia_probe -part xc7k70tfbv676-1`nputs SYNTHIA_MINIMAL_SYNTH_PASSED`n"
      [IO.File]::WriteAllText($probeTcl, $tcl, (New-Object Text.UTF8Encoding($false)))
      $probeOutput = Invoke-VivadoProbe $vivado @("-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", $probeTcl) "part_license_synth"
      if ($probeOutput -notmatch "xc7k70tfbv676-1" -or $probeOutput -notmatch "SYNTHIA_MINIMAL_SYNTH_PASSED") { Fail "M4F_VIVADO_SYNTH_PROBE_INCONCLUSIVE" }
      [void]$stream.Seek(0, [IO.SeekOrigin]::Begin)
      $postAttachSha = [Security.Cryptography.SHA256]::Create()
      try { $postAttachHash = ([BitConverter]::ToString($postAttachSha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
      finally { $postAttachSha.Dispose() }
      if ($postAttachHash -cne $vhdxHash -or $stream.Length -ne $vhdxSize) { Fail "M4F_TOOLCHAIN_VHDX_ATTACH_DRIFT" }
      $issued = [DateTime]::UtcNow
      $expires = $issued.AddMinutes($ToolchainValidityMinutes)
      $parentAcl = Get-Acl -LiteralPath (Split-Path -Parent $VhdxPath)
      $draft = [ordered]@{
        schema = "synthia-vivado-toolchain-attestation.v1"; gate_id = $GateId
        issued_at = $issued.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); not_before = $issued.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); expires_at = $expires.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        vhdx = [ordered]@{ path = [IO.Path]::GetFullPath($VhdxPath); sha256 = $vhdxHash; size_bytes = [int64]$vhdxSize; file_identity = $preIdentity; backing_parent = [ordered]@{ path = [IO.Path]::GetFullPath((Split-Path -Parent $VhdxPath)); owner_sid = (Get-IdentitySid $parentAcl.Owner "toolchain_backing_parent"); acl_sha256 = Get-TextSha256 ($parentAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)); protected = $true } }
        attachment = [ordered]@{ image_path = [IO.Path]::GetFullPath($VhdxPath); attached = $true; read_only = $true; disk = [ordered]@{ number = [int]$disk.Number; unique_id = [string]$disk.UniqueId }; partition = [ordered]@{ number = [int]$partition.PartitionNumber; guid = [string]$partition.Guid }; volume = [ordered]@{ guid = [string]$volume.UniqueId; serial_number = $logicalVolumeSerialNumber; file_system = "NTFS"; mount_path = $actualMount; identity_canonical_sha256 = "" }; write_probe = "access_denied"; backing_file_identity = $postIdentity }
        full_tree_manifest = [ordered]@{ schema = "synthia-vivado-full-tree-manifest.v1"; canonical_sha256 = [string]$target.canonical_sha256; entry_count = [int64]$target.entry_count; file_count = [int64]$target.file_count; total_bytes = [int64]$target.total_bytes }
        vivado = [ordered]@{ binary_relative_path = "Vivado/bin/vivado.bat"; version = "2021.1"; sw_build = "3247384"; ip_build = "3246043"; version_probe_stdout_sha256 = Get-TextSha256 $versionOutput; part_catalog_sha256 = Get-TextSha256 $probeOutput; target_part = "xc7k70tfbv676-1"; part_present = $true; part_probe_stdout_sha256 = Get-TextSha256 $probeOutput; license = [ordered]@{ status = "passed"; stdout_sha256 = Get-TextSha256 $probeOutput; exit_code = 0 }; minimal_synth = [ordered]@{ status = "passed"; input_sha256 = Get-Sha256 $probeSource; stdout_sha256 = Get-TextSha256 $probeOutput; exit_code = 0 } }
        toolchain_profile = [ordered]@{ capability_map_version = [string]$Manifest.expected.capability_map_version; semantic_profile_sha256 = $ToolchainSemanticProfileSha256; derived_sha256 = "" }
        canonical_attestation_sha256 = ""
      }
      $draftPath = Join-Path $workRoot "attestation-draft.json"
      Write-JsonNoBom $draftPath $draft
      $finalizeOutput = & $BunPath $BundlePath --finalize-vivado-toolchain-attestation $draftPath $ToolchainAttestationPath 2>&1
      if ($LASTEXITCODE -ne 0) { Fail "M4F_TOOLCHAIN_ATTESTATION_FINALIZE_FAILED" ([string]($finalizeOutput | Select-Object -Last 1)) }
      Protect-NewServiceReadableTrustedObject $ToolchainAttestationPath "vivado_toolchain_attestation"
      $attestationRawSha256 = Get-Sha256 $ToolchainAttestationPath
      $aclChainEvidencePath = Join-Path (Join-Path ([IO.Path]::GetFullPath($StagingRoot)) ("toolchain-image-" + $GateId)) "backing-acl-chain.json"
      Require-File $aclChainEvidencePath "toolchain_backing_acl_chain"
      Assert-TrustedPath $aclChainEvidencePath "toolchain_backing_acl_chain"
      $attestationBindingPath = Join-Path $workRoot "attestation-evidence-binding.json"
      Write-JsonNoBom $attestationBindingPath ([pscustomobject]@{
        schema = "synthia-vivado-toolchain-attestation-evidence-binding.v1"
        gate_id = $GateId
        vhdx_path = [IO.Path]::GetFullPath($VhdxPath)
        vhdx_sha256 = $vhdxHash
        file_identity = $preIdentity
        vivado_toolchain_attestation_sha256 = $attestationRawSha256
        backing_acl_chain_sha256 = Get-Sha256 $aclChainEvidencePath
        authenticode_evidence_sha256 = Get-Sha256 $authenticodeEvidencePath
      })
      Protect-NewTrustedObject $attestationBindingPath "toolchain_attestation_evidence_binding"
      if (Test-Path -LiteralPath $ToolchainLockHandoffPath) { Fail "M4F_TOOLCHAIN_HANDOFF_ALREADY_EXISTS" }
      $handoffNonce = [Guid]::NewGuid().ToString("N")
      $pipeName = "synthia-m4f-" + $GateId + "-" + $attestationRawSha256.Substring(0, 16)
      $supervisorFacts = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)
      if ($null -eq $supervisorFacts) { Fail "M4F_TOOLCHAIN_SUPERVISOR_IDENTITY_UNAVAILABLE" }
      $supervisorStartToken = Get-TextSha256 (([string]$supervisorFacts.ProcessId) + "|" + ([string]$supervisorFacts.CreationDate) + "|" + ([string]$supervisorFacts.ExecutablePath))
      Write-JsonNoBom $ToolchainLockHandoffPath ([pscustomobject]@{ schema = "synthia-vivado-toolchain-lock-handoff.v1"; nonce = $handoffNonce; pipe_name = $pipeName; supervisor_pid = [int]$PID; supervisor_start_token = $supervisorStartToken; vivado_toolchain_attestation_sha256 = $attestationRawSha256; volume_serial_number = [string]$preIdentity.volume_serial_number; file_id = [string]$preIdentity.file_id })
      Protect-NewServiceReadableTrustedObject $ToolchainLockHandoffPath "toolchain_lock_handoff"
      $handoffAckPath = $ToolchainLockHandoffPath + ".ack.json"
      Initialize-ToolchainHandoffAckSlot $handoffAckPath "toolchain_lock_handoff_ack_slot"
      $pipeSecurity = New-Object IO.Pipes.PipeSecurity
      foreach ($sid in @([Security.Principal.SecurityIdentifier]::new((Get-IdentitySid $ServiceIdentity "service_identity")), [Security.Principal.SecurityIdentifier]::new("S-1-5-18"), [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))) {
        $pipeSecurity.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($sid, [IO.Pipes.PipeAccessRights]::ReadWrite, [Security.AccessControl.AccessControlType]::Allow)))
      }
      $firstConnection = $true
      $stopRequested = $false
      while (-not $stopRequested) {
        $pipe = New-Object IO.Pipes.NamedPipeServerStream($pipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, ([IO.Pipes.PipeOptions]::WriteThrough -bor [IO.Pipes.PipeOptions]::Asynchronous), 4096, 4096, $pipeSecurity)
        try {
          if ($firstConnection) {
            $asyncWait = $pipe.BeginWaitForConnection($null, $null)
            if (-not $asyncWait.AsyncWaitHandle.WaitOne($ToolchainHandoffTimeoutSeconds * 1000)) { Fail "M4F_TOOLCHAIN_LOCK_HANDOFF_TIMEOUT" }
            $pipe.EndWaitForConnection($asyncWait)
          } else { $pipe.WaitForConnection() }
          $reader = New-Object IO.StreamReader($pipe, (New-Object Text.UTF8Encoding($false)), $false, 4096, $true)
          $writer = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding($false)), 4096, $true)
          $writer.AutoFlush = $true
          $requestLine = $reader.ReadLine()
          if ($requestLine -ceq ("PING|" + $handoffNonce)) {
            $writer.WriteLine(("HEALTHY|{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}" -f $handoffNonce, $attestationRawSha256, $vhdxHash, $vhdxSize, [string]$preIdentity.volume_serial_number, [string]$preIdentity.file_id, $PID, $supervisorStartToken))
            if ($firstConnection) {
              $ackDeadline = [DateTime]::UtcNow.AddSeconds(30)
              $handoffAck = $null
              while ([DateTime]::UtcNow -lt $ackDeadline) {
                if (Test-Path -LiteralPath $handoffAckPath -PathType Leaf) {
                  try { $ackCandidate = Read-Json $handoffAckPath "toolchain_lock_handoff_ack" } catch { $ackCandidate = $null }
                  if ($null -ne $ackCandidate) {
                    Assert-ToolchainHandoffAckPayload $ackCandidate $handoffNonce $attestationRawSha256 "toolchain_lock_handoff_ack"
                    $handoffAck = $ackCandidate
                    break
                  }
                }
                Start-Sleep -Milliseconds 100
              }
              if ($null -eq $handoffAck) { Fail "M4F_TOOLCHAIN_LOCK_HANDOFF_ACK_MISSING" }
              Protect-NewTrustedObject $handoffAckPath "toolchain_lock_handoff_ack"
              [pscustomobject]@{ schema = "synthia-vivado-toolchain-attestation-ceremony.v1"; status = "holding"; attestation_path = $ToolchainAttestationPath; raw_sha256 = $attestationRawSha256; full_tree_manifest_sha256 = [string]$target.canonical_sha256; worker_process_instance_id = [string]$handoffAck.worker_process_instance_id; lock_handoff = "continuous_same_handle"; nonce = $handoffNonce; pipe_name = $pipeName; supervisor_pid = [int]$PID; supervisor_start_token = $supervisorStartToken; volume_serial_number = [string]$preIdentity.volume_serial_number; file_id = [string]$preIdentity.file_id } | ConvertTo-Json -Depth 8
              $firstConnection = $false
            }
          } elseif ($requestLine -ceq ("STOP|" + $handoffNonce)) {
            if (Test-PipeClientCanStop $pipe) {
              $writer.WriteLine("STOPPING")
              $stopRequested = $true
            } else { $writer.WriteLine("REJECTED") }
          } else { $writer.WriteLine("REJECTED") }
        } finally { if ($null -ne $pipe) { $pipe.Dispose() } }
      }
      exit 0
    } catch {
      Dismount-DiskImage -ImagePath $VhdxPath -ErrorAction SilentlyContinue
      throw
    }
  } finally { $stream.Dispose() }
}

if ($Mode -eq "LaunchPreflight") {
  if (-not $ConfigPath) { Fail "M4F_CONFIG_PATH_REQUIRED" }
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $currentIdentity.User -or $currentIdentity.User.Value -cne
    (Get-IdentitySid $ServiceIdentity "service_identity")) {
    Fail "M4F_SERVICE_IDENTITY_MISMATCH"
  }
  $currentPrincipal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
  # 2026-09-05: the local Vivado loader cannot start under the LocalService
  # session (Xilinx service-session incompatibility). The gate owner explicitly
  # authorized running the 18443 Worker as the interactive admin identity via
  # SYNTHIA_M4F_WORKER_IDENTITY_AUTHORIZATION; every other identity stays
  # fail-closed to the non-privileged service account.
  $adminIdentityAuthorized = $env:SYNTHIA_M4F_WORKER_IDENTITY_AUTHORIZATION -ceq "I_AUTHORIZE_M4F_ADMIN_WORKER_IDENTITY" -and
    $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $adminIdentityAuthorized) {
    Assert-ToolchainServiceIdentityNonPrivilegedFacts $currentIdentity.User.Value `
      ($currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  }
  Require-File $PfxPasswordPath "pfx_password"
  Assert-TrustedPath $PfxPasswordPath "pfx_password"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $PfxPasswordPath) "pfx_password"
  Assert-TrustedPath $ConfigPath "active_config"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $ConfigPath) "active_config"
  $config = Read-Json $ConfigPath "active_config"
  Assert-NoSecretMaterial $ConfigPath "active_config"
  Assert-Config $config $true $true
  $evalEnabled = $config.evolution_eval_enabled -eq $true
  if ($evalEnabled) {
    Assert-IsolatedStaging $config
    if (-not $LogRoot -or
      -not ([IO.Path]::GetFullPath($LogRoot)).Equals(
        [IO.Path]::GetFullPath([string](Require-Property $config "evolution_eval_log_root")),
        [StringComparison]::OrdinalIgnoreCase
      )) { Fail "M4F_LOG_ROOT_BINDING_MISMATCH" }
    Assert-MutableRoot $LogRoot "evolution_eval_log_root"
    $env:SYNTHIA_WORKER_CONFIG_SHA256 = Get-Sha256 $ConfigPath
    $toolchainStage = Join-Path ([IO.Path]::GetTempPath()) ("synthia-m4f-bun-stage-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $toolchainStage | Out-Null
    try {
      $toolchainBundleCopy = Join-Path $toolchainStage "server.bundle.mjs"
      Copy-Item -LiteralPath $BundlePath -Destination $toolchainBundleCopy
      $toolchainOutput = & $BunPath $toolchainBundleCopy --verify-vivado-toolchain-attestation $ConfigPath 2>&1
    } finally { Remove-Item -LiteralPath $toolchainStage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($LASTEXITCODE -ne 0 -or ([string]($toolchainOutput | Select-Object -Last 1)) -notmatch "raw_sha256=") {
      Fail "M4F_TOOLCHAIN_ATTESTATION_INVALID"
    }
  }
  [pscustomobject]@{
    schema = if ($evalEnabled) { "synthia-evolution-eval-launch-preflight.v1" } else { "synthia-generic-worker-launch-preflight.v1" }
    status = if ($evalEnabled) { "passed" } else { "generic_recovery_only" }
    evolution_eval_ready = $evalEnabled
    release_manifest_hash = [string]$Manifest.manifest_hash
    bundle_sha256 = [string]$Manifest.bundle.sha256
    runtime_sha256 = [string]$Manifest.runtime.sha256
    config_sha256 = Get-Sha256 $ConfigPath
    ledger_epoch = if ($evalEnabled) { [string]$config.evolution_eval_ledger_epoch } else { $null }
    vivado_toolchain_attestation_sha256 = if ($evalEnabled) { [string]$config.vivado_toolchain_attestation_sha256 } else { $null }
  } | ConvertTo-Json -Depth 8
  exit 0
}

if ($Mode -eq "StageCeremony") {
  if (-not $ConfirmIsolatedStaging) { Fail "M4F_ISOLATED_STAGING_CONFIRMATION_REQUIRED" }
  if (-not $ConfigPath) { $ConfigPath = $ConfigTemplatePath }
  if (-not $Epoch -or $Epoch -notmatch $EpochPattern -or $Epoch -ceq $PlaceholderEpoch) { Fail "M4F_EPOCH_INVALID" }
  Assert-TrustedPath $ConfigPath "ceremony_template"
  $template = Read-Json $ConfigPath "ceremony_template"
  Assert-NoSecretMaterial $ConfigPath "ceremony_template"
  $template.evolution_eval_enabled = $true
  $template.evolution_eval_ledger_epoch = $Epoch
  $template.evolution_eval_ledger_mode = "initialize"
  Assert-IsolatedStaging $template
  Assert-Config $template $false $false
  $ledgerRoot = [string]$template.evolution_eval_ledger_root
  $spoolRoot = [string]$template.evolution_eval_spool_root
  Assert-EmptyOrAbsent $ledgerRoot "evolution_eval_ledger_root"
  Assert-EmptyOrAbsent $spoolRoot "evolution_eval_spool_root"
  foreach ($name in @("workspace_root", "evidence_root", "evolution_eval_ledger_root", "evolution_eval_spool_root", "evolution_eval_log_root")) {
    $path = [string](Require-Property $template $name)
    if (-not (Test-Path -LiteralPath $path)) {
      New-Item -ItemType Directory -Path $path | Out-Null
      Protect-NewMutableRoot $path $name
    } else {
      Assert-MutableRoot $path $name
    }
    Assert-LocalNtfsDirectory $path $name $true "mutable_root"
  }
  $ceremonyRoot = Join-Path ([IO.Path]::GetFullPath($StagingRoot)) ("ceremony-" + $GateId)
  if (Test-Path -LiteralPath $ceremonyRoot) { Fail "M4F_CEREMONY_ALREADY_EXISTS" }
  New-Item -ItemType Directory -Path $ceremonyRoot | Out-Null
  Protect-NewServiceReadableTrustedObject $ceremonyRoot "ceremony_root"
  $initializePath = Join-Path $ceremonyRoot "worker-66.initialize.json"
  $reopenPath = Join-Path $ceremonyRoot "worker-66.reopen.json"
  Write-JsonNoBom $initializePath $template
  $template.evolution_eval_ledger_mode = "reopen"
  Write-JsonNoBom $reopenPath $template
  Protect-NewServiceReadableTrustedObject $initializePath "initialize_config"
  Protect-NewServiceReadableTrustedObject $reopenPath "reopen_config"
  [pscustomobject]@{
    schema = "synthia-evolution-eval-stage-ceremony.v1"
    status = "staged"
    epoch = $Epoch
    initialize_config = $initializePath
    reopen_config = $reopenPath
    next = "Run the one-shot --initialize-evolution-ledger command, then PostInitialize; never start the service with the initialize config."
  } | ConvertTo-Json -Depth 8
  exit 0
}

if (-not $ConfigPath) { Fail "M4F_CONFIG_PATH_REQUIRED" }
Assert-TrustedPath $ConfigPath "reopen_config"
$reopenConfig = Read-Json $ConfigPath "reopen_config"
Assert-NoSecretMaterial $ConfigPath "reopen_config"
Assert-Config $reopenConfig $true $true
Assert-IsolatedStaging $reopenConfig
$ledgerRoot = [string]$reopenConfig.evolution_eval_ledger_root
$metadataPath = Join-Path $ledgerRoot "ledger.json"
Require-File $metadataPath "ledger_metadata"
# ledger.json is append-mutated by the Worker inside its mutable root; sealing
# it as an immutable trust anchor would contradict the mutable-root contract,
# so verify the enclosing mutable root instead.
Assert-MutableRoot $ledgerRoot "evolution_eval_ledger_root"
$metadata = Read-Json $metadataPath "ledger_metadata"
if ([string]$metadata.schema -cne "evolution-eval-ledger-metadata.v2" -or [string]$metadata.ledger_epoch -cne [string]$reopenConfig.evolution_eval_ledger_epoch) {
  Fail "M4F_LEDGER_METADATA_INVALID"
}
if ([string]$metadata.fact_hash -notmatch $HashPattern) { Fail "M4F_LEDGER_METADATA_HASH_INVALID" }
foreach ($directory in @("facts", "heads", "indexes")) {
  $directoryPath = Join-Path $ledgerRoot $directory
  if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) { Fail "M4F_ROOT_MISSING" ("ledger_" + $directory) }
  Assert-MutableDescendantDirectory $directoryPath $ledgerRoot ("ledger_" + $directory)
}
[pscustomobject]@{
  schema = "synthia-evolution-eval-post-initialize.v1"
  status = "passed"
  ledger_epoch = [string]$metadata.ledger_epoch
  reopen_config = [IO.Path]::GetFullPath($ConfigPath)
  next = "Archive the initialize config and atomically promote this reopen config. Never initialize this epoch again."
} | ConvertTo-Json -Depth 8
