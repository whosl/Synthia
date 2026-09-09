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
if ($functionStart -lt 0 -or $executionStart -le $functionStart) { throw "ACL_TEST_CERTIFIER_LAYOUT_INVALID" }
Invoke-Expression $source.Substring($functionStart, $executionStart - $functionStart)

$trustedSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$localServiceSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-19")
$untrustedSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545")
$creatorOwnerSid = [Security.Principal.SecurityIdentifier]::new("S-1-3-0")
$script:AllowedWriterSids = @{ $trustedSid.Value = $true; $systemSid.Value = $true }
$script:ServiceIdentity = $trustedSid.Value

function New-TestAcl([bool]$Protected = $true, [object]$Owner = $trustedSid) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($Owner)
  if ($Protected) { $acl.SetAccessRuleProtection($true, $false) }
  return $acl
}

function Add-AllowRule(
  [object]$Acl,
  [object]$Identity,
  [Security.AccessControl.FileSystemRights]$Rights,
  [Security.AccessControl.InheritanceFlags]$Inheritance = [Security.AccessControl.InheritanceFlags]::None,
  [Security.AccessControl.PropagationFlags]$Propagation = [Security.AccessControl.PropagationFlags]::None
) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $Identity,
    $Rights,
    $Inheritance,
    $Propagation,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$Acl.AddAccessRule($rule)
}

function Add-RawAllowReadExecuteWithoutSynchronizeRule(
  [object]$Acl,
  [Security.Principal.SecurityIdentifier]$Identity
) {
  $readExecuteMask = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute
  $synchronizeMask = [int][Security.AccessControl.FileSystemRights]::Synchronize
  if ($readExecuteMask -eq 0 -or ($readExecuteMask -band $synchronizeMask) -ne 0) {
    throw "ACL_TEST_READ_EXECUTE_MASK_INVALID"
  }
  $descriptorBytes = $Acl.GetSecurityDescriptorBinaryForm()
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($descriptorBytes, 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { throw "ACL_TEST_DACL_MISSING" }
  $rawAce = [Security.AccessControl.CommonAce]::new(
    [Security.AccessControl.AceFlags]::None,
    [Security.AccessControl.AceQualifier]::AccessAllowed,
    $readExecuteMask,
    $Identity,
    $false,
    $null
  )
  $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $rawAce)
  $updatedBytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($updatedBytes, 0)
  $Acl.SetSecurityDescriptorBinaryForm($updatedBytes)

  $materialized = $false
  foreach ($entry in $Acl.Access) {
    $observedMask = [int64]$entry.FileSystemRights
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      (Get-IdentitySid $entry.IdentityReference "raw_allow_read_execute") -ceq $Identity.Value -and
      $observedMask -eq [int64]$readExecuteMask -and
      ($observedMask -band [int64]$synchronizeMask) -eq 0) {
      $materialized = $true
    }
  }
  if (-not $materialized) { throw "ACL_TEST_READ_EXECUTE_WITHOUT_SYNCHRONIZE_VECTOR_NOT_MATERIALIZED" }
}

function Add-RawDenySynchronizeRule(
  [object]$Acl,
  [Security.Principal.SecurityIdentifier]$Identity
) {
  $synchronizeMask = [int][Security.AccessControl.FileSystemRights]::Synchronize
  if ($synchronizeMask -ne 0x100000) { throw "ACL_TEST_SYNCHRONIZE_MASK_INVALID" }
  $descriptorBytes = $Acl.GetSecurityDescriptorBinaryForm()
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($descriptorBytes, 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { throw "ACL_TEST_DACL_MISSING" }
  $rawAce = [Security.AccessControl.CommonAce]::new(
    [Security.AccessControl.AceFlags]::None,
    [Security.AccessControl.AceQualifier]::AccessDenied,
    $synchronizeMask,
    $Identity,
    $false,
    $null
  )
  $descriptor.DiscretionaryAcl.InsertAce(0, $rawAce)
  $updatedBytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($updatedBytes, 0)
  $Acl.SetSecurityDescriptorBinaryForm($updatedBytes)

  $materialized = $false
  foreach ($entry in $Acl.Access) {
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
      (Get-IdentitySid $entry.IdentityReference "raw_deny_synchronize") -ceq $Identity.Value -and
      (([int64]$entry.FileSystemRights -band [int64]0x100000) -ne 0)) {
      $materialized = $true
    }
  }
  if (-not $materialized) { throw "ACL_TEST_DENY_SYNCHRONIZE_VECTOR_NOT_MATERIALIZED" }
}

function Expect-Failure([string]$Code, [scriptblock]$Action) {
  try { & $Action }
  catch {
    $message = $_.Exception.Message
    if ($message -ceq $Code -or $message.StartsWith($Code + ":", [StringComparison]::Ordinal)) { return }
    throw
  }
  throw "ACL_TEST_EXPECTED_FAILURE:$Code"
}

Assert-ToolchainImageAdministrativePrincipal
Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-18" $false
Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-21-1-2-3-1001" $true
Expect-Failure "M4F_TOOLCHAIN_IMAGE_REQUIRES_ADMIN" {
  Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-19" $false
}
Expect-Failure "M4F_TOOLCHAIN_IMAGE_REQUIRES_ADMIN" {
  Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-21-1-2-3-1002" $false
}
Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-19"
Expect-Failure "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED" {
  Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-21-1-2-3-1003" $true
}
Expect-Failure "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED" {
  Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-18"
}
Expect-Failure "M4F_TOOLCHAIN_SERVICE_IDENTITY_PRIVILEGED" {
  Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-32-544"
}

$unprotected = New-TestAcl $false
Expect-Failure "M4F_ACL_INHERITANCE_ENABLED" { Assert-ProtectedObjectAcl $unprotected "target" }

$untrustedWriter = New-TestAcl
Add-AllowRule $untrustedWriter $untrustedSid ([Security.AccessControl.FileSystemRights]::WriteData)
Expect-Failure "M4F_ACL_WRITER_UNTRUSTED" { Assert-ProtectedObjectAcl $untrustedWriter "target" }

$inheritOnlyTarget = New-TestAcl
Add-AllowRule $inheritOnlyTarget $creatorOwnerSid `
  ([Security.AccessControl.FileSystemRights]::FullControl) `
  ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) `
  ([Security.AccessControl.PropagationFlags]::InheritOnly)
Assert-ProtectedObjectAcl $inheritOnlyTarget "target"

$untrustedInheritOnlyTarget = New-TestAcl
Add-AllowRule $untrustedInheritOnlyTarget $untrustedSid `
  ([Security.AccessControl.FileSystemRights]::FullControl) `
  ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) `
  ([Security.AccessControl.PropagationFlags]::InheritOnly)
Expect-Failure "M4F_ACL_WRITER_UNTRUSTED" { Assert-ProtectedObjectAcl $untrustedInheritOnlyTarget "target" }

$siblingCreator = New-TestAcl $false
Add-AllowRule $siblingCreator $untrustedSid `
  ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories)
Assert-AncestorAcl $siblingCreator "ancestor"

$inheritOnlyAncestor = New-TestAcl $false
Add-AllowRule $inheritOnlyAncestor $creatorOwnerSid `
  ([Security.AccessControl.FileSystemRights]::FullControl) `
  ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) `
  ([Security.AccessControl.PropagationFlags]::InheritOnly)
Assert-AncestorAcl $inheritOnlyAncestor "ancestor"

$deleteChildAncestor = New-TestAcl $false
Add-AllowRule $deleteChildAncestor $untrustedSid ([Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)
Expect-Failure "M4F_ACL_ANCESTOR_REPLACE_UNTRUSTED" { Assert-AncestorAcl $deleteChildAncestor "ancestor" }

$deleteAncestor = New-TestAcl $false
Add-AllowRule $deleteAncestor $untrustedSid ([Security.AccessControl.FileSystemRights]::Delete)
Expect-Failure "M4F_ACL_ANCESTOR_REPLACE_UNTRUSTED" { Assert-AncestorAcl $deleteAncestor "ancestor" }

$untrustedOwner = New-TestAcl $false $untrustedSid
Expect-Failure "M4F_ACL_OWNER_UNTRUSTED" { Assert-AncestorAcl $untrustedOwner "ancestor" }

$toolchainServiceReadOnly = New-TestAcl
Add-AllowRule $toolchainServiceReadOnly $trustedSid `
  ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
Assert-ToolchainServiceReadOnlyAcl $toolchainServiceReadOnly "toolchain_service_read_only"

$toolchainServiceSynchronizeDenied = New-TestAcl
Add-AllowRule $toolchainServiceSynchronizeDenied $trustedSid `
  ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
Add-RawDenySynchronizeRule $toolchainServiceSynchronizeDenied $trustedSid
Expect-Failure "M4F_TOOLCHAIN_SERVICE_READ_DENIED" {
  Assert-ToolchainServiceReadOnlyAcl $toolchainServiceSynchronizeDenied "toolchain_service_synchronize_denied"
}

$toolchainServiceMissingSynchronize = New-TestAcl
Add-RawAllowReadExecuteWithoutSynchronizeRule $toolchainServiceMissingSynchronize $trustedSid
Expect-Failure "M4F_TOOLCHAIN_SERVICE_READ_EXECUTE_MISSING" {
  Assert-ToolchainServiceReadOnlyAcl $toolchainServiceMissingSynchronize "toolchain_service_missing_synchronize"
}

$toolchainServiceWrite = New-TestAcl
Add-AllowRule $toolchainServiceWrite $trustedSid `
  ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::WriteData)
Expect-Failure "M4F_TOOLCHAIN_SERVICE_WRITE_ALLOWED" {
  Assert-ToolchainServiceReadOnlyAcl $toolchainServiceWrite "toolchain_service_write"
}

$toolchainServiceMissing = New-TestAcl
Expect-Failure "M4F_TOOLCHAIN_SERVICE_READ_EXECUTE_MISSING" {
  Assert-ToolchainServiceReadOnlyAcl $toolchainServiceMissing "toolchain_service_missing"
}

$toolchainBackingReadOnly = New-TestAcl $true $systemSid
Add-AllowRule $toolchainBackingReadOnly $trustedSid `
  ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
Assert-ToolchainBackingServiceBoundaryAcl $toolchainBackingReadOnly "toolchain_backing_read_only"

$toolchainBackingServiceOwned = New-TestAcl $true $trustedSid
Add-AllowRule $toolchainBackingServiceOwned $trustedSid `
  ([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
$script:ServiceIdentity = $trustedSid.Value
Expect-Failure "M4F_TOOLCHAIN_SERVICE_OWNER_FORBIDDEN" {
  Assert-ToolchainBackingServiceBoundaryAcl $toolchainBackingServiceOwned "toolchain_backing_service_owned"
}

$script:ServiceIdentity = $localServiceSid.Value
Initialize-AllowedWriterSids
$serviceOwnedImmutable = New-TestAcl $true $localServiceSid
Expect-Failure "M4F_ACL_OWNER_UNTRUSTED" {
  Assert-ProtectedObjectAcl $serviceOwnedImmutable "service_owned_immutable"
}
$serviceReplaceAncestor = New-TestAcl $false
Add-AllowRule $serviceReplaceAncestor $localServiceSid ([Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)
Expect-Failure "M4F_ACL_ANCESTOR_REPLACE_UNTRUSTED" {
  Assert-AncestorAcl $serviceReplaceAncestor "service_replace_ancestor"
}
$mutableRootAcl = New-MutableRootAcl
Assert-MutableRootAcl $mutableRootAcl "mutable_root"
$mutableRootWithExtraAce = [Security.AccessControl.DirectorySecurity]::new()
$mutableRootWithExtraAce.SetSecurityDescriptorBinaryForm($mutableRootAcl.GetSecurityDescriptorBinaryForm())
Add-AllowRule $mutableRootWithExtraAce $untrustedSid ([Security.AccessControl.FileSystemRights]::Read)
Expect-Failure "M4F_MUTABLE_ROOT_ACE_UNEXPECTED" {
  Assert-MutableRootAcl $mutableRootWithExtraAce "mutable_root_extra_ace"
}
$ackSlotAcl = New-ToolchainHandoffAckSlotAcl
Assert-ToolchainHandoffAckSlotAcl $ackSlotAcl "toolchain_ack_slot"
$ackServiceEntry = @($ackSlotAcl.Access | Where-Object {
  (Get-IdentitySid $_.IdentityReference "toolchain_ack_slot_service") -ceq $localServiceSid.Value
})
if ($ackServiceEntry.Count -ne 1) { throw "ACL_TEST_ACK_SLOT_SERVICE_ACE_MISSING" }
foreach ($requiredRight in @(
  [Security.AccessControl.FileSystemRights]::WriteData,
  [Security.AccessControl.FileSystemRights]::AppendData,
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
  [Security.AccessControl.FileSystemRights]::WriteAttributes
)) {
  if (($ackServiceEntry[0].FileSystemRights -band $requiredRight) -eq 0) {
    throw "ACL_TEST_ACK_SLOT_RPLUS_RIGHT_MISSING"
  }
}
$ackSlotLegacyWriteDataOnly = [Security.AccessControl.FileSecurity]::new()
$ackSlotLegacyWriteDataOnly.SetOwner($trustedSid)
$ackSlotLegacyWriteDataOnly.SetAccessRuleProtection($true, $false)
Add-AllowRule $ackSlotLegacyWriteDataOnly $trustedSid ([Security.AccessControl.FileSystemRights]::FullControl)
Add-AllowRule $ackSlotLegacyWriteDataOnly $systemSid ([Security.AccessControl.FileSystemRights]::FullControl)
Add-AllowRule $ackSlotLegacyWriteDataOnly $localServiceSid `
  ([Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::Synchronize)
Expect-Failure "M4F_TOOLCHAIN_ACK_SLOT_ACE_INVALID" {
  Assert-ToolchainHandoffAckSlotAcl $ackSlotLegacyWriteDataOnly "toolchain_ack_slot_legacy_write_data_only"
}
foreach ($forbiddenRight in @(
  [Security.AccessControl.FileSystemRights]::Delete,
  [Security.AccessControl.FileSystemRights]::ChangePermissions,
  [Security.AccessControl.FileSystemRights]::TakeOwnership
)) {
  $ackSlotWithForbiddenRight = [Security.AccessControl.FileSecurity]::new()
  $ackSlotWithForbiddenRight.SetSecurityDescriptorBinaryForm($ackSlotAcl.GetSecurityDescriptorBinaryForm())
  Add-AllowRule $ackSlotWithForbiddenRight $localServiceSid $forbiddenRight
  Expect-Failure "M4F_TOOLCHAIN_ACK_SLOT_FORBIDDEN_RIGHT" {
    Assert-ToolchainHandoffAckSlotAcl $ackSlotWithForbiddenRight "toolchain_ack_slot_forbidden_right"
  }
}
$ackNonce = "ack-nonce-1"
$ackAttestationSha256 = ("a" * 64)
$validAckPayload = [pscustomobject]@{
  schema = "synthia-vivado-toolchain-lock-handoff-ack.v1"
  nonce = $ackNonce
  worker_process_instance_id = "123e4567-e89b-42d3-a456-426614174000"
  vivado_toolchain_attestation_sha256 = $ackAttestationSha256
}
Assert-ToolchainHandoffAckPayload $validAckPayload $ackNonce $ackAttestationSha256 "toolchain_ack_payload"
Expect-Failure "M4F_TOOLCHAIN_LOCK_HANDOFF_ACK_INVALID" {
  Assert-ToolchainHandoffAckPayload ([pscustomobject]@{
    schema = $validAckPayload.schema
    nonce = $validAckPayload.nonce
    worker_process_instance_id = $validAckPayload.worker_process_instance_id
    vivado_toolchain_attestation_sha256 = $validAckPayload.vivado_toolchain_attestation_sha256
    extra = $true
  }) $ackNonce $ackAttestationSha256 "toolchain_ack_payload_extra_key"
}
foreach ($invalidAckPayload in @(
  [pscustomobject]@{ schema = "wrong"; nonce = $validAckPayload.nonce; worker_process_instance_id = $validAckPayload.worker_process_instance_id; vivado_toolchain_attestation_sha256 = $validAckPayload.vivado_toolchain_attestation_sha256 },
  [pscustomobject]@{ schema = $validAckPayload.schema; nonce = "wrong"; worker_process_instance_id = $validAckPayload.worker_process_instance_id; vivado_toolchain_attestation_sha256 = $validAckPayload.vivado_toolchain_attestation_sha256 },
  [pscustomobject]@{ schema = $validAckPayload.schema; nonce = $validAckPayload.nonce; worker_process_instance_id = "not-a-uuid"; vivado_toolchain_attestation_sha256 = $validAckPayload.vivado_toolchain_attestation_sha256 },
  [pscustomobject]@{ schema = $validAckPayload.schema; nonce = $validAckPayload.nonce; worker_process_instance_id = $validAckPayload.worker_process_instance_id; vivado_toolchain_attestation_sha256 = ("b" * 64) }
)) {
  Expect-Failure "M4F_TOOLCHAIN_LOCK_HANDOFF_ACK_INVALID" {
    Assert-ToolchainHandoffAckPayload $invalidAckPayload $ackNonce $ackAttestationSha256 "toolchain_ack_payload_binding"
  }
}
$untrustedFormattedVolumeAcl = New-TestAcl $false $untrustedSid
Add-AllowRule $untrustedFormattedVolumeAcl $untrustedSid ([Security.AccessControl.FileSystemRights]::FullControl)
$controlledVolumeAcl = New-InitializedToolchainVolumeRootAcl $untrustedFormattedVolumeAcl
Assert-InitializedToolchainVolumeRootAcl $controlledVolumeAcl "controlled_volume_root"

$controlledVolumeBytes = $controlledVolumeAcl.GetSecurityDescriptorBinaryForm()
$volumeAclWithExtraAce = [Security.AccessControl.DirectorySecurity]::new()
$volumeAclWithExtraAce.SetSecurityDescriptorBinaryForm($controlledVolumeBytes)
Add-AllowRule $volumeAclWithExtraAce $untrustedSid ([Security.AccessControl.FileSystemRights]::Read)
Expect-Failure "M4F_TOOLCHAIN_VOLUME_ROOT_ACE_UNEXPECTED" {
  Assert-InitializedToolchainVolumeRootAcl $volumeAclWithExtraAce "volume_root_extra_ace"
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$script:ServiceIdentity = $currentIdentity.Name
Initialize-AllowedWriterSids
$standardPathTarget = Join-Path "C:\Windows\Temp" ("synthia-m4f-acl-test-" + [Guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $standardPathTarget | Out-Null
  Expect-Failure "M4F_TOOLCHAIN_VOLUME_ROOT_SCOPE_INVALID" {
    Assert-NewToolchainVolumeRootScope $standardPathTarget "not-a-volume" "not-a-serial"
  }
  Protect-NewServiceReadableTrustedObject $standardPathTarget "standard_windows_temp_target"
  Assert-TrustedPath $standardPathTarget "standard_windows_temp_target"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $standardPathTarget) "standard_windows_temp_target"
  $standardFileTarget = Join-Path $standardPathTarget "protected-file.txt"
  [IO.File]::WriteAllText($standardFileTarget, "acl-parent-regression", (New-Object Text.UTF8Encoding($false)))
  Protect-NewServiceReadableTrustedObject $standardFileTarget "standard_windows_temp_file"
  Assert-TrustedPath $standardFileTarget "standard_windows_temp_file"
  Assert-ToolchainServiceReadOnlyAcl (Get-Acl -LiteralPath $standardFileTarget) "standard_windows_temp_file"
} finally {
  if (Test-Path -LiteralPath $standardPathTarget) {
    Remove-Item -LiteralPath $standardPathTarget -Recurse -Force
  }
}

[pscustomobject]@{
  schema = "synthia-m4f-certifier-acl-test.v1"
  status = "passed"
  cases = 44
} | ConvertTo-Json -Compress
