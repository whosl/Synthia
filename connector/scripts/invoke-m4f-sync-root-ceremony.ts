import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type BoundJumpCopyResult,
  type BoundJumpPhaseResult,
  CeremonyFailure,
  copyBoundJumpFiles,
  invokeBoundJumpPhase,
  runCeremony,
} from "./m4f-bound-jump-transport.ts";
import { runJumpBootstrapCeremony } from "./invoke-m4f-jump-bootstrap-root.ts";

const CONFIRMATION = "SYNTHIA_M4F_SYNC_ROOT_20260827_03";
const BOOTSTRAP_ROOT = "C:\\Windows\\Temp\\synthia-m4f-jump-bootstrap-20260827-03";
const SYNC_ROOT = "C:\\Windows\\Temp\\synthia-m4f-sync-20260827-03";
const SOURCE_NAME = "create-m4f-sync-root.ps1";
const WRAPPER_NAME = "invoke-m4f-sync-root-on-jump.ps1";
const SOURCE_PATH = resolve(import.meta.dir, SOURCE_NAME);
const WRAPPER_PATH = resolve(import.meta.dir, WRAPPER_NAME);
const SOURCE_SHA256 = "c4d67fd1b5c8cc4ebd8698486f9377ad0ce374b5d1697816f7bee090b8436a5e";
const WRAPPER_SHA256 = "f2378e0d81b34990253190d5aeeb574adea58674efb660ff07d178865f53fe7b";

class StagingValidationError extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "StagingValidationError";
  }
}

function fail(code: string, extra: Record<string, unknown> = {}): never {
  throw new StagingValidationError(code, extra);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], phase: string): void {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) {
    fail("M4F_SYNC_STAGING_OUTPUT_INVALID", { phase });
  }
}

function objectValue(value: unknown, phase: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("M4F_SYNC_STAGING_OUTPUT_INVALID", { phase });
  }
  return value as Record<string, unknown>;
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function verifyLocalSource(path: string, expectedName: string, expectedHash: string): Buffer {
  const facts = lstatSync(path);
  if (!facts.isFile() || facts.isSymbolicLink() || basename(path) !== expectedName) {
    fail("M4F_SYNC_STAGING_LOCAL_SOURCE_INVALID", { name: expectedName });
  }
  const bytes = readFileSync(path);
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    fail("M4F_SYNC_STAGING_LOCAL_SOURCE_HASH_MISMATCH", {
      name: expectedName,
      expected_sha256: expectedHash,
      actual_sha256: actualHash,
    });
  }
  return bytes;
}

function buildSealScript(): string {
  return String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = "${BOOTSTRAP_ROOT}"
$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$allow = [Security.AccessControl.AccessControlType]::Allow
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl
$noneInheritance = [Security.AccessControl.InheritanceFlags]::None
$nonePropagation = [Security.AccessControl.PropagationFlags]::None
$directoryInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
$expected = [ordered]@{
  "${SOURCE_NAME}" = "${SOURCE_SHA256}"
  "${WRAPPER_NAME}" = "${WRAPPER_SHA256}"
}

function Fail([string]$Code, [string]$Detail = "") {
  if ($Detail) { throw ("{0}:{1}" -f $Code, $Detail) }
  throw $Code
}

function Get-Sid([object]$IdentityReference) {
  try {
    if ($IdentityReference -is [Security.Principal.IdentityReference]) {
      return $IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    return ([Security.Principal.NTAccount][string]$IdentityReference).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    Fail "M4F_SYNC_STAGING_IDENTITY_UNRESOLVED"
  }
}

function Get-Sha256([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Assert-ExactAcl([string]$Path, [bool]$Directory) {
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  if ((Get-Sid $acl.Owner) -cne $administratorsSid.Value -or
    -not $acl.AreAccessRulesProtected) {
    Fail "M4F_SYNC_STAGING_ACL_BOUNDARY_INVALID" $Path
  }
  $expectedInheritance = if ($Directory) { $directoryInheritance } else { $noneInheritance }
  $expectedRights = @{
    $administratorsSid.Value = [int64]$fullControl
    $systemSid.Value = [int64]$fullControl
  }
  $rules = @($acl.Access)
  if ($rules.Count -ne 2) { Fail "M4F_SYNC_STAGING_ACL_COUNT_INVALID" $Path }
  $seen = @{}
  foreach ($entry in $rules) {
    $sid = Get-Sid $entry.IdentityReference
    if (-not $expectedRights.ContainsKey($sid) -or
      $seen.ContainsKey($sid) -or
      $entry.AccessControlType -ne $allow -or
      $entry.IsInherited -or
      [int64]$entry.FileSystemRights -ne [int64]$expectedRights[$sid] -or
      $entry.InheritanceFlags -ne $expectedInheritance -or
      $entry.PropagationFlags -ne $nonePropagation) {
      Fail "M4F_SYNC_STAGING_ACL_INVALID" ("{0}|{1}" -f $Path, $sid)
    }
    $seen[$sid] = $true
  }
}

function New-SealedFileAcl {
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($administratorsSid)
  $acl.SetAccessRuleProtection($true, $false)
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $administratorsSid, $fullControl, $noneInheritance, $nonePropagation, $allow
    ))
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $systemSid, $fullControl, $noneInheritance, $nonePropagation, $allow
    ))
  return $acl
}

function Assert-RegularFile([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item -isnot [IO.FileInfo] -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail "M4F_SYNC_STAGING_FILE_INVALID" $Path
  }
  $streams = @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop)
  if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) {
    Fail "M4F_SYNC_STAGING_ALTERNATE_STREAM" $Path
  }
}

function Assert-SealRootStreams([string]$Path) {
  $streams = @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop)
  if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) {
    Fail "M4F_SYNC_STAGING_ROOT_ALTERNATE_STREAM" $Path
  }
}

$rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
if ($rootItem -isnot [IO.DirectoryInfo] -or
  (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  Fail "M4F_SYNC_STAGING_ROOT_INVALID"
}
Assert-ExactAcl $root $true
Assert-SealRootStreams $root
$children = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
if ($children.Count -ne 2) { Fail "M4F_SYNC_STAGING_FILE_SET_INVALID" }
$actualNames = @($children | ForEach-Object { $_.Name } | Sort-Object)
$expectedNames = @($expected.Keys | Sort-Object)
if (($actualNames -join "|") -cne ($expectedNames -join "|")) {
  Fail "M4F_SYNC_STAGING_FILE_SET_INVALID"
}

$tokenCounts = @{}
foreach ($name in $expected.Keys) {
  $path = Join-Path $root $name
  Assert-RegularFile $path
  if ((Get-Sha256 $path) -cne $expected[$name]) {
    Fail "M4F_SYNC_STAGING_FILE_HASH_MISMATCH" $name
  }
  Set-Acl -LiteralPath $path -AclObject (New-SealedFileAcl) -ErrorAction Stop
  Assert-RegularFile $path
  Assert-ExactAcl $path $false
  if ((Get-Sha256 $path) -cne $expected[$name]) {
    Fail "M4F_SYNC_STAGING_FILE_HASH_DRIFT" $name
  }
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $path,
    [ref]$tokens,
    [ref]$parseErrors
  )
  if ($null -eq $parseErrors -or $parseErrors.Count -ne 0 -or
    $null -eq $tokens -or $tokens.Count -lt 1) {
    Fail "M4F_SYNC_STAGING_FILE_PARSE_FAILED" $name
  }
  $tokenCounts[$name] = [int]$tokens.Count
}

[Console]::Out.WriteLine(([ordered]@{
  schema = "synthia-m4f-sync-staging-seal.v1"
  status = "passed"
  bootstrap_root = $root
  file_count = [int]$children.Count
  source_sha256 = [string]$expected["${SOURCE_NAME}"]
  wrapper_sha256 = [string]$expected["${WRAPPER_NAME}"]
  source_token_count = [int]$tokenCounts["${SOURCE_NAME}"]
  wrapper_token_count = [int]$tokenCounts["${WRAPPER_NAME}"]
  owner_sid = $administratorsSid.Value
  protected = $true
  explicit_ace_count_per_file = 2
  reparse = $false
  alternate_streams = $false
} | ConvertTo-Json -Compress))
`;
}

function buildExecuteScript(): string {
  return String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = "${BOOTSTRAP_ROOT}"
$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$allow = [Security.AccessControl.AccessControlType]::Allow
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl
$expected = [ordered]@{
  "${SOURCE_NAME}" = "${SOURCE_SHA256}"
  "${WRAPPER_NAME}" = "${WRAPPER_SHA256}"
}

function Fail([string]$Code, [string]$Detail = "") {
  if ($Detail) { throw ("{0}:{1}" -f $Code, $Detail) }
  throw $Code
}

function Get-Sid([object]$IdentityReference) {
  try {
    if ($IdentityReference -is [Security.Principal.IdentityReference]) {
      return $IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    return ([Security.Principal.NTAccount][string]$IdentityReference).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    Fail "M4F_SYNC_STAGING_IDENTITY_UNRESOLVED"
  }
}

function Get-Sha256([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Assert-ReadyFile([string]$Name) {
  $path = Join-Path $root $Name
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($item -isnot [IO.FileInfo] -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail "M4F_SYNC_STAGING_FILE_INVALID" $Name
  }
  $streams = @(Get-Item -LiteralPath $path -Stream * -ErrorAction Stop)
  if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) {
    Fail "M4F_SYNC_STAGING_ALTERNATE_STREAM" $Name
  }
  if ((Get-Sha256 $path) -cne $expected[$Name]) {
    Fail "M4F_SYNC_STAGING_FILE_HASH_DRIFT" $Name
  }
  $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  if ((Get-Sid $acl.Owner) -cne $administratorsSid.Value -or
    -not $acl.AreAccessRulesProtected) {
    Fail "M4F_SYNC_STAGING_ACL_BOUNDARY_INVALID" $Name
  }
  $expectedRights = @{
    $administratorsSid.Value = [int64]$fullControl
    $systemSid.Value = [int64]$fullControl
  }
  $rules = @($acl.Access)
  if ($rules.Count -ne 2) { Fail "M4F_SYNC_STAGING_ACL_COUNT_INVALID" $Name }
  $seen = @{}
  foreach ($entry in $rules) {
    $sid = Get-Sid $entry.IdentityReference
    if (-not $expectedRights.ContainsKey($sid) -or
      $seen.ContainsKey($sid) -or
      $entry.AccessControlType -ne $allow -or
      $entry.IsInherited -or
      [int64]$entry.FileSystemRights -ne [int64]$expectedRights[$sid] -or
      $entry.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
      $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      Fail "M4F_SYNC_STAGING_ACL_INVALID" ("{0}|{1}" -f $Name, $sid)
    }
    $seen[$sid] = $true
  }
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $path,
    [ref]$tokens,
    [ref]$parseErrors
  )
  if ($null -eq $parseErrors -or $parseErrors.Count -ne 0 -or
    $null -eq $tokens -or $tokens.Count -lt 1) {
    Fail "M4F_SYNC_STAGING_FILE_PARSE_FAILED" $Name
  }
}

function Assert-RootBoundary {
  $acl = Get-Acl -LiteralPath $root -ErrorAction Stop
  if ((Get-Sid $acl.Owner) -cne $administratorsSid.Value -or
    -not $acl.AreAccessRulesProtected) {
    Fail "M4F_SYNC_STAGING_ACL_BOUNDARY_INVALID" $root
  }
  $expectedRights = @{
    $administratorsSid.Value = [int64]$fullControl
    $systemSid.Value = [int64]$fullControl
  }
  $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rules = @($acl.Access)
  if ($rules.Count -ne 2) { Fail "M4F_SYNC_STAGING_ACL_COUNT_INVALID" $root }
  $seen = @{}
  foreach ($entry in $rules) {
    $sid = Get-Sid $entry.IdentityReference
    if (-not $expectedRights.ContainsKey($sid) -or
      $seen.ContainsKey($sid) -or
      $entry.AccessControlType -ne $allow -or
      $entry.IsInherited -or
      [int64]$entry.FileSystemRights -ne [int64]$expectedRights[$sid] -or
      $entry.InheritanceFlags -ne $expectedInheritance -or
      $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      Fail "M4F_SYNC_STAGING_ACL_INVALID" ("{0}|{1}" -f $root, $sid)
    }
    $seen[$sid] = $true
  }
}

function Assert-ExecuteRootStreams([string]$Path) {
  $streams = @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop)
  if (@($streams | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) {
    Fail "M4F_SYNC_EXECUTE_ROOT_ALTERNATE_STREAM" $Path
  }
}

$rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
if ($rootItem -isnot [IO.DirectoryInfo] -or
  (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  Fail "M4F_SYNC_STAGING_ROOT_INVALID"
}
Assert-RootBoundary
Assert-ExecuteRootStreams $root
$children = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
if ($children.Count -ne 2) { Fail "M4F_SYNC_STAGING_FILE_SET_INVALID" }
$actualNames = @($children | ForEach-Object { $_.Name } | Sort-Object)
$expectedNames = @($expected.Keys | Sort-Object)
if (($actualNames -join "|") -cne ($expectedNames -join "|")) {
  Fail "M4F_SYNC_STAGING_FILE_SET_INVALID"
}
foreach ($name in $expected.Keys) { Assert-ReadyFile $name }
& (Join-Path $root "${WRAPPER_NAME}")
`;
}

function validateSeal(value: Record<string, unknown>): void {
  exactKeys(value, [
    "alternate_streams",
    "bootstrap_root",
    "explicit_ace_count_per_file",
    "file_count",
    "owner_sid",
    "protected",
    "reparse",
    "schema",
    "source_sha256",
    "source_token_count",
    "status",
    "wrapper_sha256",
    "wrapper_token_count",
  ], "seal");
  if (value.schema !== "synthia-m4f-sync-staging-seal.v1"
    || value.status !== "passed"
    || value.bootstrap_root !== BOOTSTRAP_ROOT
    || value.source_sha256 !== SOURCE_SHA256
    || value.wrapper_sha256 !== WRAPPER_SHA256
    || value.owner_sid !== "S-1-5-32-544"
    || value.protected !== true
    || value.reparse !== false
    || value.alternate_streams !== false
    || value.file_count !== 2
    || value.explicit_ace_count_per_file !== 2
    || !isInteger(value.source_token_count, 1)
    || !isInteger(value.wrapper_token_count, 1)) {
    fail("M4F_SYNC_STAGING_OUTPUT_INVALID", { phase: "seal" });
  }
}

function validateSyncPayload(value: Record<string, unknown>): void {
  exactKeys(value, ["execute", "parse", "schema", "status"], "sync");
  if (value.schema !== "synthia-m4f-sync-root-ceremony.v1" || value.status !== "passed") {
    fail("M4F_SYNC_STAGING_OUTPUT_INVALID", { phase: "sync" });
  }
  const parse = objectValue(value.parse, "sync:parse");
  exactKeys(parse, ["error_count", "schema", "source_sha256", "status", "token_count"], "sync:parse");
  if (parse.schema !== "synthia-m4f-powershell-parse.v1"
    || parse.status !== "passed"
    || parse.source_sha256 !== SOURCE_SHA256
    || !isInteger(parse.token_count, 1)
    || parse.error_count !== 0) {
    fail("M4F_SYNC_STAGING_OUTPUT_INVALID", { phase: "sync:parse" });
  }
  const execute = objectValue(value.execute, "sync:execute");
  exactKeys(execute, [
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
    "volume_unique_id",
  ], "sync:execute");
  if (execute.schema !== "synthia-m4f-sync-root.v1"
    || execute.status !== "passed"
    || execute.sync_root !== SYNC_ROOT
    || execute.owner_sid !== "S-1-5-32-544"
    || typeof execute.logical_volume_serial !== "string" || execute.logical_volume_serial.length === 0
    || typeof execute.volume_unique_id !== "string" || execute.volume_unique_id.length === 0
    || typeof execute.volume_serial_number !== "string" || execute.volume_serial_number.length === 0
    || execute.volume_serial_number !== execute.logical_volume_serial
    || typeof execute.disk_unique_id !== "string" || execute.disk_unique_id.length === 0
    || !isInteger(execute.disk_number, 0)
    || !isInteger(execute.partition_number, 1)
    || execute.protected !== true
    || execute.explicit_ace_count !== 2
    || execute.empty !== true
    || execute.reparse !== false
    || execute.alternate_streams !== false) {
    fail("M4F_SYNC_STAGING_OUTPUT_INVALID", { phase: "sync:execute" });
  }
}

type SyncStagingStage =
  | "confirmation"
  | "local_preflight"
  | "bootstrap"
  | "copy"
  | "seal"
  | "remote";

type BootstrapResult = ReturnType<typeof runJumpBootstrapCeremony>;

interface CompletedSyncStagingEvidence {
  bootstrap: BootstrapResult | null;
  copy: BoundJumpCopyResult | null;
  seal: BoundJumpPhaseResult | null;
  remote: BoundJumpPhaseResult | null;
}

export interface SyncRootStagingDependencies {
  runBootstrap(): BootstrapResult;
  copyFiles(localSources: readonly string[], remoteDirectory: string): BoundJumpCopyResult;
  invokePhase(phase: string, script: string): BoundJumpPhaseResult;
  verifySource(path: string, expectedName: string, expectedHash: string): Buffer;
  readLocalFile(path: string): Buffer;
}

const defaultDependencies: SyncRootStagingDependencies = {
  runBootstrap: () => runJumpBootstrapCeremony(),
  copyFiles: (localSources, remoteDirectory) => (
    copyBoundJumpFiles(localSources, remoteDirectory)
  ),
  invokePhase: (phase, script) => invokeBoundJumpPhase(phase, script),
  verifySource: verifyLocalSource,
  readLocalFile: (path) => readFileSync(path),
};

function failureCause(error: unknown): Record<string, unknown> {
  if (error instanceof StagingValidationError) {
    return {
      schema: "synthia-m4f-sync-staging-validation-cause.v1",
      code: error.code,
      detail: error.detail,
    };
  }
  if (error instanceof CeremonyFailure) return error.detail;
  return {
    schema: "synthia-m4f-sync-staging-unexpected-cause.v1",
    message: error instanceof Error ? error.message : String(error),
  };
}

function throwStagingFailure(
  error: unknown,
  currentStage: SyncStagingStage,
  completed: CompletedSyncStagingEvidence,
  invalidRawPayload: Record<string, unknown> | null,
): never {
  const cause = failureCause(error);
  const code = typeof cause.code === "string"
    ? cause.code
    : "M4F_SYNC_STAGING_UNEXPECTED_FAILURE";
  throw new CeremonyFailure({
    schema: "synthia-m4f-sync-staging-failure.v1",
    code,
    current_stage: currentStage,
    retry_permitted: false,
    invalid_raw_payload: invalidRawPayload,
    completed: { ...completed },
    cause,
  });
}

export function runSyncRootStagingCeremony(
  overrides: Partial<SyncRootStagingDependencies> = {},
): Record<string, unknown> {
  const completed: CompletedSyncStagingEvidence = {
    bootstrap: null,
    copy: null,
    seal: null,
    remote: null,
  };
  let currentStage: SyncStagingStage = "confirmation";
  let invalidRawPayload: Record<string, unknown> | null = null;

  try {
    if (process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION !== CONFIRMATION) {
      fail("M4F_SYNC_STAGING_CONFIRMATION_REQUIRED");
    }

    const dependencies = { ...defaultDependencies, ...overrides };
    currentStage = "local_preflight";
    const sourceBytes = dependencies.verifySource(
      SOURCE_PATH,
      SOURCE_NAME,
      SOURCE_SHA256,
    );
    const wrapperBytes = dependencies.verifySource(
      WRAPPER_PATH,
      WRAPPER_NAME,
      WRAPPER_SHA256,
    );

    currentStage = "bootstrap";
    completed.bootstrap = dependencies.runBootstrap();

    currentStage = "copy";
    completed.copy = dependencies.copyFiles(
      [SOURCE_PATH, WRAPPER_PATH],
      BOOTSTRAP_ROOT,
    );

    currentStage = "seal";
    completed.seal = dependencies.invokePhase("sync-staging:seal", buildSealScript());
    invalidRawPayload = completed.seal.payload;
    validateSeal(invalidRawPayload);
    invalidRawPayload = null;

    currentStage = "local_preflight";
    if (sha256(sourceBytes) !== sha256(dependencies.readLocalFile(SOURCE_PATH))
      || sha256(wrapperBytes) !== sha256(dependencies.readLocalFile(WRAPPER_PATH))) {
      fail("M4F_SYNC_STAGING_LOCAL_SOURCE_DRIFT");
    }

    currentStage = "remote";
    completed.remote = dependencies.invokePhase(
      "sync-staging:execute-once",
      buildExecuteScript(),
    );
    invalidRawPayload = completed.remote.payload;
    validateSyncPayload(invalidRawPayload);
    invalidRawPayload = null;
  } catch (error) {
    throwStagingFailure(error, currentStage, completed, invalidRawPayload);
  }
  return {
    schema: "synthia-m4f-sync-staging-ceremony.v1",
    status: "passed",
    bootstrap: completed.bootstrap,
    copy: completed.copy,
    seal: completed.seal,
    remote: completed.remote,
  };
}

if (import.meta.main) {
  runCeremony(() => {
    process.stdout.write(`${JSON.stringify(runSyncRootStagingCeremony())}\n`);
  });
}
