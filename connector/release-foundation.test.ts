import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalEvolutionEvalHash } from "./evolution-eval.ts";
import type { WorkerReleaseManifestV1 } from "./scripts/build-worker-release.ts";

const connectorRoot = import.meta.dir;

async function text(path: string): Promise<string> {
  return readFile(join(connectorRoot, path), "utf8");
}

describe("M4-F Worker release foundation", () => {
  test("tracked config binds the exact bundle and is a disabled reopen template", async () => {
    const bytes = await readFile(join(connectorRoot, "server.bundle.mjs"));
    const config = JSON.parse(await text("worker-66.config.json")) as Record<string, unknown>;
    expect(config.sdk_worker_build_hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(config.evolution_eval_enabled).toBe(false);
    expect(config.evolution_eval_ledger_mode).toBe("reopen");
    expect(config.evolution_eval_ledger_epoch).toBe("REPLACE_WITH_M4F_DEPLOYMENT_EPOCH");
    expect(new Set([
      config.workspace_root,
      config.evidence_root,
      config.evolution_eval_ledger_root,
      config.evolution_eval_spool_root,
      config.evolution_eval_log_root,
    ]).size).toBe(5);
  });

  test("tracked bundle contains the frozen evolution-eval ledger and retention markers", async () => {
    const bundle = await text("server.bundle.mjs");
    for (const marker of [
      "evolution-eval-ledger-metadata.v2",
      "evolution-eval-evidence-purged.v1",
      "physical_deleted",
      "--initialize-evolution-ledger",
      "--verify-evolution-ledger",
      "validate_sources",
      "simulate",
      "synthesize",
      "implement",
    ]) expect(bundle).toContain(marker);
  });

  test("launcher is pinned to Bun and completes preflight before reading the secret", async () => {
    const launcher = await text("start-worker-66.cmd");
    expect(launcher).toContain('SYNTHIA_WORKER_ROOT=D:\\synthia-worker');
    expect(launcher).toContain('SYNTHIA_WORKER_BUN=%SYNTHIA_WORKER_ROOT%\\runtime\\bun-1.3.14\\bun.exe');
    expect(launcher.toLowerCase()).not.toContain("node.exe");
    expect(launcher).toContain("SYNTHIA_WORKER_VERIFY_BUNDLE=1");
    expect(launcher).toContain("SYNTHIA_WORKER_CONFIG_SHA256");
    expect(launcher).toContain("SYNTHIA_WORKER_SERVICE_IDENTITY");
    expect(launcher).toContain("SYNTHIA_WORKER_LOG_ROOT");
    expect(launcher).toContain("SYNTHIA_WORKER_LAUNCH_FAILED:BUN_MISSING");
    expect(launcher).toContain("SYNTHIA_WORKER_LAUNCH_FAILED:CERTIFIER_PREFLIGHT_FAILED");
    expect(launcher).not.toContain('>>"%WORKER_ROOT%');
    expect(launcher).toContain('>>"%SYNTHIA_WORKER_LOG_ROOT%\\worker.log"');
    expect(launcher).toContain('-StagingRoot "%SYNTHIA_M4F_STAGING_ROOT%"');
    expect(launcher).toContain('-GateId "%SYNTHIA_M4F_GATE_ID%"');
    expect(launcher).toContain('-PfxPasswordPath "%PFX_PASSWORD_FILE%"');
    expect(launcher).toContain('"%~1"=="preflight-only"');
    expect(launcher).toContain("-Mode LaunchPreflight");
    expect(launcher.indexOf("-Mode LaunchPreflight")).toBeLessThan(launcher.indexOf("set /p SYNTHIA_WORKER_PFX_PASSWORD"));
  });

  test("Windows certifier separates stage, post-initialize, and launch modes", async () => {
    const certifier = await text("scripts/certify-m4f-windows.ps1");
    const server = await text("server.ts");
    expect(certifier).toContain('ValidateSet("LaunchPreflight", "StageCeremony", "PostInitialize", "ToolchainImage", "ToolchainAttestation", "ToolchainNegativeChecks", "ToolchainLockStop")');
    expect(certifier).toContain("New-VHD -Path $VhdxPath -Dynamic");
    expect(certifier).toContain('$targetInstallRoot = Join-Path $mountRoot "Vivado"');
    expect(certifier).toContain("robocopy.exe $VivadoSourceRoot $targetInstallRoot");
    expect(certifier).toContain('$targetInstallRoot = Join-Path $actualMount "Vivado"');
    expect(certifier).toContain('Build-FullTreeManifest $targetInstallRoot $targetPath "readonly_target"');
    expect(certifier).toContain("function Test-PipeClientCanStop");
    expect(certifier).toContain("$Pipe.RunAsClient($worker)");
    expect(certifier).toContain("if (Test-PipeClientCanStop $pipe)");
    expect(certifier).toContain(String.raw`Vivado\bin\unwrapped\win64.o\vivado.exe`);
    expect(certifier).toContain(String.raw`Vivado\lib\win64.o\librdi_common.dll`);
    expect(certifier).not.toContain('Filter "*rdi*common*.dll"');
    expect(certifier).toContain("179b24f2214c528c2749f777fc3a7baf7c1578f1a47726ad441052f3a6afcd2aa");
    expect(certifier).toContain("933ee02cd71c652e1f4d7c055822684f0416da7028c064a4a7c5c7ecb668f21e");
    expect(certifier).toContain('Status -cne "NotSigned"');
    expect(certifier).toContain('$rootItem = Get-Item -LiteralPath $Root -Force');
    expect(certifier).toContain('foreach ($item in @($rootItem) + @(Get-ChildItem');
    expect(certifier).toContain('Protect-NewTrustedObject $backingAclChainPath "toolchain_backing_acl_chain"');
    expect(certifier).toContain("M4F_TOOLCHAIN_WORKER_LISTENER_STILL_ACTIVE");
    expect(certifier.indexOf('Read-Json $ToolchainAttestationPath "vivado_toolchain_attestation"'))
      .toBeLessThan(certifier.indexOf('$writer.WriteLine(("STOP|"'));
    expect(certifier).toContain("M4F_TOOLCHAIN_STOP_ATTESTATION_INVALID");
    expect(certifier).toContain("function Grant-ToolchainServiceReadExecute");
    expect(certifier).toContain("M4F_TOOLCHAIN_SERVICE_READ_EXECUTE_MISSING");
    expect(certifier).toContain("M4F_TOOLCHAIN_SERVICE_WRITE_ALLOWED");
    expect(certifier).toContain("M4F_TOOLCHAIN_SERVICE_RIGHTS_EXCESSIVE");
    expect(certifier).toContain("M4F_TOOLCHAIN_SERVICE_OWNER_FORBIDDEN");
    expect(certifier).toContain("function Assert-ToolchainImageAdministrativePrincipalFacts");
    expect(certifier).toContain("function Assert-ToolchainImageAdministrativePrincipal");
    expect(certifier).toContain("M4F_TOOLCHAIN_IMAGE_REQUIRES_ADMIN");
    expect(certifier).toContain("function Assert-ToolchainServiceIdentityNonPrivilegedFacts");
    expect(certifier).toContain("function Assert-ToolchainServiceIdentityNonPrivileged");
    expect(certifier).toContain("function Test-IdentityNestedInGroup");
    expect(certifier).toContain("M4F_IDENTITY_GROUP_ENUMERATION_FAILED");
    expect(certifier).toContain("M4F_IDENTITY_GROUP_GRAPH_TOO_LARGE");
    expect(certifier).not.toContain('@($administrators.psbase.Invoke("Members"))');
    expect(certifier).toContain("function New-MutableRootAcl");
    expect(certifier).toContain("function Assert-MutableRootAcl");
    expect(certifier).toContain("function Protect-NewMutableRoot");
    expect(certifier).toContain("function Assert-TrustedAncestors");
    expect(certifier).toContain("function Protect-NewServiceReadableTrustedObject");
    expect(certifier).toContain("function Initialize-ToolchainHandoffAckSlot");
    expect(certifier).toContain("M4F_TOOLCHAIN_ACK_SLOT_ACE_INVALID");
    expect(certifier).toContain("M4F_MUTABLE_ROOT_ACE_UNEXPECTED");
    expect(certifier).toContain("M4F_LOG_ROOT_BINDING_MISMATCH");
    expect(certifier).toContain('Assert-LocalNtfsDirectory $path $name $true "mutable_root"');
    expect(certifier).toContain("function Assert-MutableDescendantDirectory");
    expect(certifier).toContain('"evolution_eval_log_root"');
    expect(certifier).toContain("function Initialize-NewToolchainVolumeRoot");
    expect(certifier).toContain("function Assert-NewToolchainVolumeRootScope");
    expect(certifier).toContain("function New-InitializedToolchainVolumeRootAcl");
    expect(certifier).toContain("function Assert-InitializedToolchainVolumeRootAcl");
    expect(certifier).toContain("M4F_TOOLCHAIN_VOLUME_ROOT_SCOPE_INVALID");
    expect(certifier).toContain("M4F_TOOLCHAIN_VOLUME_ROOT_ACE_UNEXPECTED");
    expect(certifier).toContain("function Get-LogicalDiskVolumeSerialNumber");
    expect(certifier).toContain("Get-CimInstance -ClassName Win32_LogicalDisk -Filter");
    expect(certifier).toContain("[string]$logicalDisks[0].VolumeSerialNumber");
    expect(certifier).toContain('$formattedVolumeSerialNumber = Get-LogicalDiskVolumeSerialNumber $mountRoot "formatted_toolchain_volume"');
    expect(certifier).toContain("Initialize-NewToolchainVolumeRoot $mountRoot ([string]$volume.UniqueId) $formattedVolumeSerialNumber");
    expect(certifier).toContain('$logicalVolumeSerialNumber = Get-LogicalDiskVolumeSerialNumber $actualMount "toolchain_attestation_volume"');
    expect(certifier).toContain("serial_number = $logicalVolumeSerialNumber");
    expect(certifier).not.toMatch(/\$[A-Za-z][A-Za-z0-9]*\.SerialNumber\b/u);
    expect(certifier).not.toContain('Protect-NewTrustedObject $mountRoot "toolchain_volume_root"');
    const toolchainImage = certifier.slice(
      certifier.indexOf('if ($Mode -eq "ToolchainImage")'),
      certifier.indexOf('if ($Mode -eq "ToolchainAttestation")'),
    );
    const administrativeGate = toolchainImage.indexOf("Assert-ToolchainImageAdministrativePrincipal");
    const serviceIdentityGate = toolchainImage.indexOf("Assert-ToolchainServiceIdentityNonPrivileged");
    expect(administrativeGate).toBeGreaterThan(toolchainImage.indexOf("M4F_TOOLCHAIN_PATH_REQUIRED"));
    expect(serviceIdentityGate).toBeGreaterThan(administrativeGate);
    for (const sideEffect of [
      "Test-Path -LiteralPath $VhdxPath",
      "Get-Acl -LiteralPath $backingParent",
      'Grant-ToolchainServiceReadExecute $backingParent',
      "New-Item -ItemType Directory -Path $imageWorkRoot",
      "Build-FullTreeManifest $VivadoSourceRoot",
      "New-VHD -Path $VhdxPath",
      "Mount-DiskImage -ImagePath $VhdxPath -Access ReadWrite",
      "Format-Volume -FileSystem NTFS",
    ]) {
      expect(administrativeGate).toBeLessThan(toolchainImage.indexOf(sideEffect));
      expect(serviceIdentityGate).toBeLessThan(toolchainImage.indexOf(sideEffect));
    }
    expect(certifier).toContain('Grant-ToolchainServiceReadExecute $backingParent "toolchain_backing_parent_service"');
    expect(certifier).toContain('Grant-ToolchainServiceReadExecute $VhdxPath "toolchain_vhdx_service"');
    expect(certifier).toContain('Assert-ToolchainBackingServiceBoundary $VhdxPath "toolchain_vhdx"');
    expect(certifier).toContain('Grant-ToolchainServiceReadExecute $targetItem.FullName "toolchain_service_read_execute"');
    expect(certifier).toContain('[IO.FileShare]::Read');
    expect(certifier).toContain('Mount-DiskImage -ImagePath $VhdxPath -Access ReadOnly');
    expect(certifier).toContain("M4F_TOOLCHAIN_FULL_TREE_DRIFT");
    expect(certifier).toContain("SYNTHIA_MINIMAL_SYNTH_PASSED");
    expect(certifier).toContain("M4F_NEGATIVE_CHECK_UNEXPECTEDLY_SUCCEEDED");
    expect(certifier).toContain("M4F_TOOLCHAIN_VENDOR_PROVENANCE_INSUFFICIENT");
    expect(certifier).toContain("SizeRemaining -lt [uint64](10GB)");
    expect(certifier).toContain("function Get-ToolchainVirtualSize");
    expect(certifier).toContain("M4F_TOOLCHAIN_SIZE_INVALID");
    expect(certifier).toContain("M4F_TOOLCHAIN_SIZE_OVERFLOW");
    expect(certifier).toContain("M4F_TOOLCHAIN_VHDX_SIZE_MISMATCH");
    expect(certifier).toContain("$virtualSize = Get-ToolchainVirtualSize $sourceBefore.total_bytes");
    expect(certifier).toContain("$requiredHostBytes = $virtualSize");
    expect(certifier).toContain("New-VHD -Path $VhdxPath -Dynamic -SizeBytes $virtualSize");
    expect(certifier).toContain("$maximumMiB = [uint64]([decimal]$virtualSize / [decimal](1MB))");
    expect(certifier).not.toContain("[Math]::Ceiling([double]$virtualSize");
    expect(certifier).toContain("M4F_ISOLATED_STAGING_CONFIRMATION_REQUIRED");
    expect(certifier).toContain("M4F_CONFIG_REOPEN_REQUIRED");
    expect(certifier).toContain("M4F_REPARSE_POINT_REJECTED");
    expect(certifier).toContain("function Get-FileSystemParent");
    expect(certifier).toContain("if ($Item -is [IO.DirectoryInfo]) { return $Item.Parent }");
    expect(certifier).toContain("if ($Item -is [IO.FileInfo]) { return $Item.Directory }");
    expect(certifier).toContain("M4F_FILE_SYSTEM_ITEM_INVALID");
    expect(certifier).not.toContain("$item = $item.Parent");
    expect(certifier).not.toContain("$null -eq $item.Parent");
    expect(certifier).toContain("M4F_FREE_SPACE_BELOW_10_GIB");
    expect(certifier).toContain("M4F_PATH_OUTSIDE_STAGING_ROOT");
    expect(certifier).toContain('C:\\Windows\\Temp\\synthia-m4f-');
    expect(certifier).toContain("M4F_STAGING_ROOT_INVALID");
    expect(certifier).toContain("M4F_ACL_INHERITANCE_ENABLED");
    expect(certifier).toContain("M4F_ACL_WRITER_UNTRUSTED");
    expect(certifier).toContain("M4F_ACL_ANCESTOR_REPLACE_UNTRUSTED");
    expect(certifier).toContain("PropagationFlags]::InheritOnly");
    expect(certifier).toContain("Protect-NewTrustedObject");
    const objectAcl = certifier.slice(
      certifier.indexOf("function Assert-ProtectedObjectAcl"),
      certifier.indexOf("function Assert-ProtectedObject("),
    );
    expect(objectAcl).toContain("AreAccessRulesProtected");
    expect(objectAcl).toContain("M4F_ACL_INHERITANCE_ENABLED");
    expect(objectAcl).toContain("WriteData");
    expect(objectAcl).toContain("WriteAttributes");
    const ancestorAcl = certifier.slice(
      certifier.indexOf("function Assert-AncestorAcl"),
      certifier.indexOf("function Assert-Ancestor("),
    );
    expect(ancestorAcl).toContain("DeleteSubdirectoriesAndFiles");
    expect(ancestorAcl).toContain("ChangePermissions");
    expect(ancestorAcl).not.toContain("WriteData");
    expect(ancestorAcl).not.toContain("AppendData");
    expect(ancestorAcl).not.toContain("WriteAttributes");
    expect(certifier).toContain('Assert-TrustedPath $vivadoBinary "vivado_binary"');
    expect(certifier).toContain('Assert-TrustedPath $tlsPath $name');
    expect(certifier).toContain('Assert-TrustedPath $PfxPasswordPath "pfx_password"');
    for (const right of ["Delete", "DeleteSubdirectoriesAndFiles", "ChangePermissions", "TakeOwnership"]) {
      expect(certifier).toContain(`[Security.AccessControl.FileSystemRights]::${right}`);
    }
    expect(certifier).toContain("synthia-generic-worker-launch-preflight.v1");
    expect(certifier).toContain('"generic_recovery_only"');
    expect(certifier).toContain("evolution_eval_ready = $evalEnabled");
    expect(certifier).toContain("--verify-release-manifest");
    expect(certifier).toContain("[string]$StagingRoot");
    expect(certifier).toContain("[string]$GateId");
    expect(certifier).toContain('$GateIdPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"');
    expect(certifier).toContain("$GateId -notmatch $GateIdPattern");
    const launchPreflight = certifier.slice(
      certifier.indexOf('if ($Mode -eq "LaunchPreflight")'),
      certifier.indexOf('if ($Mode -eq "StageCeremony")'),
    );
    expect(launchPreflight).toContain('if ($evalEnabled) {\n    Assert-IsolatedStaging $config');
    expect(launchPreflight).toContain("--verify-vivado-toolchain-attestation");
    expect(launchPreflight).toContain("M4F_SERVICE_IDENTITY_MISMATCH");
    expect(launchPreflight.indexOf("M4F_SERVICE_IDENTITY_MISMATCH"))
      .toBeLessThan(launchPreflight.indexOf('Require-File $PfxPasswordPath "pfx_password"'));
    expect(launchPreflight.indexOf('if ($evalEnabled) { Assert-IsolatedStaging $config }'))
      .toBeLessThan(launchPreflight.indexOf("synthia-evolution-eval-launch-preflight.v1"));
    expect(launchPreflight).toContain('else { "synthia-generic-worker-launch-preflight.v1" }');
    expect(certifier).not.toMatch(/(?:Start-Process|server\.bundle\.mjs\s+--initialize)/);
    expect(certifier).not.toContain('Protect-NewTrustedObject $directoryPath ("ledger_" + $directory)');
    expect(server).toContain('const handle = await open(ackPath, "r+")');
    expect(server).toContain("await handle.truncate(0)");
    expect(server).toContain("await handle.sync()");
    expect(server).not.toContain("rename(temporary, ackPath)");
    const ackSlotAcl = certifier.slice(
      certifier.indexOf("function New-ToolchainHandoffAckSlotAcl"),
      certifier.indexOf("function Initialize-ToolchainHandoffAckSlot"),
    );
    expect(ackSlotAcl).toContain("[Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Synchronize");
    for (const right of ["Delete", "ChangePermissions", "TakeOwnership"]) {
      expect(ackSlotAcl).toContain(`[Security.AccessControl.FileSystemRights]::${right}`);
    }
    expect(ackSlotAcl).toContain("M4F_TOOLCHAIN_ACK_SLOT_FORBIDDEN_RIGHT");
    expect(ackSlotAcl).toContain("function Assert-ToolchainHandoffAckPayload");
    expect(ackSlotAcl).toContain('"nonce,schema,vivado_toolchain_attestation_sha256,worker_process_instance_id"');
    expect(ackSlotAcl).toContain('"synthia-vivado-toolchain-lock-handoff-ack.v1"');
    expect(ackSlotAcl).toContain("worker_process_instance_id -cnotmatch");
    expect(ackSlotAcl).toContain("vivado_toolchain_attestation_sha256 -cne $ExpectedAttestationSha256");
    expect(ackSlotAcl).toContain("M4F_TOOLCHAIN_LOCK_HANDOFF_ACK_INVALID");
    expect(certifier).toContain("Assert-ToolchainHandoffAckPayload $ackCandidate $handoffNonce $attestationRawSha256");
  });

  test("Windows certifier ACL threat model passes its native access-rule cases", () => {
    if (process.platform !== "win32") return;
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(connectorRoot, "scripts/certify-m4f-windows-acl.test.ps1"),
      "-CertifierPath",
      join(connectorRoot, "scripts/certify-m4f-windows.ps1"),
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      schema: "synthia-m4f-certifier-acl-test.v1",
      status: "passed",
      cases: 44,
    });
  });

  test("Windows PowerShell 5.1 parses the complete certifier, not a function slice", () => {
    if (process.platform !== "win32") return;
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(connectorRoot, "scripts/certify-m4f-windows-parse.test.ps1"),
      "-CertifierPath",
      join(connectorRoot, "scripts/certify-m4f-windows.ps1"),
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      schema: "synthia-m4f-certifier-full-parse-test.v1",
      status: "passed",
      parser: "System.Management.Automation.Language.Parser.ParseFile",
    });
  });

  test("Windows PowerShell 5.1 proves aligned overflow-safe VHDX sizing", () => {
    if (process.platform !== "win32") return;
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(connectorRoot, "scripts/certify-m4f-windows-sizing.test.ps1"),
      "-CertifierPath",
      join(connectorRoot, "scripts/certify-m4f-windows.ps1"),
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      schema: "synthia-m4f-certifier-sizing-test.v1",
      status: "passed",
      alignment_bytes: 1048576,
      reserve_bytes: 21474836480,
      cases: 6,
    });
  });

  test("Windows PowerShell 5.1 binds volume serials to Win32_LogicalDisk", () => {
    if (process.platform !== "win32") return;
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(connectorRoot, "scripts/certify-m4f-windows-volume.test.ps1"),
      "-CertifierPath",
      join(connectorRoot, "scripts/certify-m4f-windows.ps1"),
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      schema: "synthia-m4f-certifier-volume-serial-test.v1",
      status: "passed",
      source: "Win32_LogicalDisk.VolumeSerialNumber",
      cases: 6,
    });
  });

  test("Windows PowerShell sources retain the 5.1 parser surface", async () => {
    const sources = await Promise.all([
      text("scripts/certify-m4f-windows.ps1"),
      text("scripts/certify-m4f-windows-acl.test.ps1"),
      text("scripts/certify-m4f-windows-parse.test.ps1"),
      text("scripts/certify-m4f-windows-sizing.test.ps1"),
      text("scripts/certify-m4f-windows-volume.test.ps1"),
    ]);
    for (const source of sources) {
      // Windows PowerShell 5.1 cannot continue an expression when a binary
      // operator starts the next physical line; PowerShell 7 accepts it.
      expect(source).not.toMatch(/^\s+-(?:and|or|xor)\b/m);
      for (const powerShell7Only of [
        /\?\?/,
        /&&/,
        /\|\|/,
        /ForEach-Object\s+-Parallel/,
        /ConvertFrom-Json[^\n]*-AsHashtable/,
        /\bJoin-String\b/,
        /\bGet-Error\b/,
      ]) expect(source).not.toMatch(powerShell7Only);
    }
    expect(sources[0]).toContain('`"\\n`"');
    expect(sources[0]).not.toContain('\\"\\\\n\\"');
    expect(sources[2]).toContain("[System.Management.Automation.Language.Parser]::ParseFile(");
    expect(sources[2]).toContain('throw ("CERTIFIER_FULL_PARSE_FAILED:');
    expect(sources[3]).toContain('$observedSource = [uint64]::Parse("80403135352")');
    expect(sources[3]).toContain('$observedExpected = [uint64]::Parse("101878595584")');
    expect(sources[3]).toContain('$safeLargeSource = [uint64]::Parse("18446744052233666560")');
    expect(sources[3]).toContain('Expect-Failure "M4F_TOOLCHAIN_SIZE_OVERFLOW"');
    expect(sources[3]).toContain('Expect-Failure "M4F_TOOLCHAIN_SIZE_INVALID"');
    expect(sources[4]).toContain("Get-LogicalDiskVolumeSerialNumber");
    expect(sources[4]).toContain('Expect-Failure "M4F_TOOLCHAIN_LOGICAL_DISK_IDENTITY_INVALID"');
    const aclTest = sources[1]!;
    const expectFailure = aclTest.slice(
      aclTest.indexOf("function Expect-Failure"),
      aclTest.indexOf("Assert-ToolchainImageAdministrativePrincipal\n"),
    );
    expect(expectFailure).toContain("$message -ceq $Code");
    expect(expectFailure).toContain('$message.StartsWith($Code + ":", [StringComparison]::Ordinal)');
    expect(aclTest).toContain("Assert-ToolchainImageAdministrativePrincipal\n");
    expect(aclTest).toContain('[IO.File]::WriteAllText($standardFileTarget, "acl-parent-regression"');
    expect(aclTest).toContain('Protect-NewServiceReadableTrustedObject $standardFileTarget "standard_windows_temp_file"');
    expect(aclTest).toContain('Assert-TrustedPath $standardFileTarget "standard_windows_temp_file"');
    expect(aclTest).toContain("$untrustedFormattedVolumeAcl = New-TestAcl $false $untrustedSid");
    expect(aclTest).toContain("$controlledVolumeAcl = New-InitializedToolchainVolumeRootAcl $untrustedFormattedVolumeAcl");
    expect(aclTest).toContain('Expect-Failure "M4F_TOOLCHAIN_VOLUME_ROOT_ACE_UNEXPECTED"');
    expect(aclTest).toContain('Expect-Failure "M4F_TOOLCHAIN_VOLUME_ROOT_SCOPE_INVALID"');
    expect(aclTest).toContain('Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-18" $false');
    expect(aclTest).toContain('Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-21-1-2-3-1001" $true');
    expect(aclTest).toContain('Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-19" $false');
    expect(aclTest).toContain('Assert-ToolchainImageAdministrativePrincipalFacts "S-1-5-21-1-2-3-1002" $false');
    expect(aclTest).toContain('Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-19"');
    expect(aclTest).toContain('Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-18"');
    expect(aclTest).toContain('Assert-ToolchainServiceIdentityNonPrivilegedFacts "S-1-5-32-544"');
    expect(aclTest).toContain('$serviceOwnedImmutable = New-TestAcl $true $localServiceSid');
    expect(aclTest).toContain('$serviceReplaceAncestor = New-TestAcl $false');
    expect(aclTest).toContain("$ackSlotAcl = New-ToolchainHandoffAckSlotAcl");
    expect(aclTest).toContain("ACL_TEST_ACK_SLOT_RPLUS_RIGHT_MISSING");
    expect(aclTest).toContain("$ackSlotLegacyWriteDataOnly");
    expect(aclTest).toContain("M4F_TOOLCHAIN_ACK_SLOT_FORBIDDEN_RIGHT");
    expect(aclTest).toContain("M4F_TOOLCHAIN_ACK_SLOT_ACE_INVALID");
    expect(aclTest).toContain("$validAckPayload");
    expect(aclTest).toContain("toolchain_ack_payload_extra_key");
    expect(aclTest).toContain("toolchain_ack_payload_binding");
    expect(aclTest).toContain("cases = 44");
    const rawAllowHelper = aclTest.slice(
      aclTest.indexOf("function Add-RawAllowReadExecuteWithoutSynchronizeRule"),
      aclTest.indexOf("function Add-RawDenySynchronizeRule"),
    );
    expect(rawAllowHelper).toContain("[Security.AccessControl.RawSecurityDescriptor]::new");
    expect(rawAllowHelper).toContain("[Security.AccessControl.CommonAce]::new");
    expect(rawAllowHelper).toContain("[Security.AccessControl.AceQualifier]::AccessAllowed");
    expect(rawAllowHelper).toContain('throw "ACL_TEST_READ_EXECUTE_MASK_INVALID"');
    expect(rawAllowHelper).toContain('throw "ACL_TEST_READ_EXECUTE_WITHOUT_SYNCHRONIZE_VECTOR_NOT_MATERIALIZED"');
    expect(rawAllowHelper).toContain("$observedMask -eq [int64]$readExecuteMask");
    expect(rawAllowHelper).toContain("($observedMask -band [int64]$synchronizeMask) -eq 0");
    expect(rawAllowHelper).not.toContain("[Security.AccessControl.FileSystemAccessRule]::new");
    expect(aclTest).toContain("Add-RawAllowReadExecuteWithoutSynchronizeRule $toolchainServiceMissingSynchronize $trustedSid");
    const rawDenyHelper = aclTest.slice(
      aclTest.indexOf("function Add-RawDenySynchronizeRule"),
      aclTest.indexOf("function Expect-Failure"),
    );
    expect(rawDenyHelper).toContain("[Security.AccessControl.RawSecurityDescriptor]::new");
    expect(rawDenyHelper).toContain("[Security.AccessControl.CommonAce]::new");
    expect(rawDenyHelper).toContain("[Security.AccessControl.AceQualifier]::AccessDenied");
    expect(rawDenyHelper).toContain('if ($synchronizeMask -ne 0x100000) { throw "ACL_TEST_SYNCHRONIZE_MASK_INVALID" }');
    expect(rawDenyHelper).toContain('throw "ACL_TEST_DENY_SYNCHRONIZE_VECTOR_NOT_MATERIALIZED"');
    expect(rawDenyHelper).toContain("$descriptor.DiscretionaryAcl.InsertAce(0, $rawAce)");
    expect(rawDenyHelper).not.toContain("[Security.AccessControl.FileSystemAccessRule]::new");
    const serviceAclAssertion = sources[0]!.slice(
      sources[0]!.indexOf("function Assert-ToolchainServiceReadOnlyAcl"),
      sources[0]!.indexOf("function Assert-ToolchainBackingServiceBoundaryAcl"),
    );
    expect(serviceAclAssertion).toContain("Test-AceContainsAnyRight $entry @($requiredRights)");
  });

  test("release builder emits an external immutable template and a two-build parity check", async () => {
    const builder = await text("scripts/build-worker-release.ts");
    expect(builder).toContain('"worker-66.config.template.json"');
    expect(builder).toContain("RELEASE_DOUBLE_BUILD_MISMATCH");
    expect(builder).toContain("RELEASE_OUTPUT_ALREADY_EXISTS");
    expect(builder).toContain("RELEASE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
    expect(builder).toContain("canonicalEvolutionEvalHash(body)");
    expect(builder).toContain('version: "1.3.14"');
    expect(builder).toContain('"--porcelain=v1", "-z", "--untracked-files=all"');
    expect(builder).toContain("RELEASE_SOURCE_CHANGED_DURING_SNAPSHOT");
    expect(builder).toContain("RELEASE_METAFILE_INPUT_DRIFT");
    expect(builder).toContain("git_status_sha256");
    expect(builder).not.toContain('join(args.output, "worker-66.config.json")');
  });

  test("release builder emits a canonical provenance-bound manifest from a frozen snapshot", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "synthia-m4f-release-test-"));
    try {
      const output = join(temporary, "release");
      const result = spawnSync(process.execPath, [
        join(connectorRoot, "scripts/build-worker-release.ts"),
        "--output",
        output,
        "--allow-dirty",
        "--allow-non-windows",
      ], { cwd: join(connectorRoot, ".."), encoding: "utf8" });
      expect(result.status).toBe(0);
      const manifest = JSON.parse(await readFile(join(output, "worker-release.manifest.json"), "utf8")) as WorkerReleaseManifestV1;
      expect(["clean", "dirty"]).toContain(manifest.source_state);
      expect(manifest.git_status_sha256).toMatch(/^[0-9a-f]{64}$/);
      const sourcePaths = manifest.sources.map((source: { path: string }) => source.path);
      expect(sourcePaths).toEqual([...sourcePaths].sort());
      expect(sourcePaths).toContain("connector/server.ts");
      expect(sourcePaths).toContain("bun.lock");
      expect(sourcePaths).toContain("package.json");
      const bundleBytes = await readFile(join(output, "server.bundle.mjs"));
      expect(manifest.bundle.sha256).toBe(createHash("sha256").update(bundleBytes).digest("hex"));
      const { manifest_hash: manifestHash, ...body } = manifest;
      expect(manifestHash).toBe(canonicalEvolutionEvalHash(body));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
