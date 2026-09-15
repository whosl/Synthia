import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const scripts = new URL("./scripts/", import.meta.url);

describe("M4-F fixed Gate-root helper", () => {
  test("binds local fixed NTFS volumes, full ancestor chains, and exact targets", async () => {
    const source = await readFile(new URL("create-m4f-gate-roots.ps1", scripts), "utf8");
    expect(source).toContain('$gateRoot = "C:\\Windows\\Temp\\synthia-m4f-20260827-03"');
    expect(source).toContain('$backingRoot = "D:\\synthia-m4f-toolchain-20260827-03"');
    expect(source).toContain('$serviceSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-19")');
    expect(source).toContain("Get-CimInstance Win32_LogicalDisk");
    expect(source).toContain("[int]$logicalDisk.DriveType -ne 3");
    expect(source).toContain('[string]$logicalDisk.FileSystem -cne "NTFS"');
    expect(source).toContain('[string]$volume.DriveType -cne "Fixed"');
    expect(source).toContain("function Assert-AncestorChain");
    expect(source).toContain("M4F_GATE_ROOT_ANCESTOR_REPARSE");
    expect(source).toContain("function Assert-StrictStagingAncestorAcl");
    expect(source).toContain("M4F_GATE_ROOT_ANCESTOR_REPLACE_UNTRUSTED");
    expect(source).toContain("function Assert-SameVolumeFacts");
    expect(source).toContain("M4F_GATE_ROOT_VOLUME_MAPPING_DRIFT");
    expect(source.indexOf("Assert-AdministrativePrincipal"))
      .toBeLessThan(source.indexOf("[void](New-Item -ItemType Directory"));
    expect(source.indexOf("if (Test-Path -LiteralPath $path)"))
      .toBeLessThan(source.indexOf("[void](New-Item -ItemType Directory"));
    expect(source.indexOf("$postGateVolumeFacts = Get-LocalFixedNtfsFacts"))
      .toBeGreaterThan(source.indexOf("[void](New-Item -ItemType Directory"));
    expect(source).not.toContain("Remove-Item");
  });

  test("bounds transport and requires exit, stderr, and exact JSON success", async () => {
    const source = await readFile(new URL("invoke-m4f-gate-roots-on-jump.ps1", scripts), "utf8");
    for (const contract of [
      '"-o BatchMode=yes"',
      '"-o ConnectTimeout=15"',
      '"-o ConnectionAttempts=1"',
      '"-o ServerAliveInterval=10"',
      '"-o ServerAliveCountMax=2"',
      "$process.WaitForExit($totalTimeoutMilliseconds)",
      "$process.Kill()",
      "M4F_GATE_ROOT_TRANSPORT_OUTCOME_AMBIGUOUS",
      "$remoteExitCode -ne 0",
      "$standardError.Length -ne 0",
      "$lines.Count -ne 1",
      "M4F_GATE_ROOT_TRANSPORT_OUTPUT_INVALID",
    ]) expect(source).toContain(contract);
    expect(source.indexOf("$remoteExitCode -ne 0"))
      .toBeLessThan(source.indexOf("$standardError.Length -ne 0"));
    expect(source.indexOf("$standardError.Length -ne 0"))
      .toBeLessThan(source.indexOf("$lines.Count -ne 1"));
  });
});
