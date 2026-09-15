import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const scripts = new URL("./scripts/", import.meta.url);

describe("M4-F fixed sync-root bootstrap", () => {
  test("reproduces the rejected compact operator form and enforces unambiguous operators", async () => {
    const rejected = 'while($null-ne$current){if(-not$current.PSIsContainer-or(($current.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0))';
    const ambiguousOperator = /(?:-not|-or|-and|-eq|-ne|-band|-bor)(?=\$|\[)/;
    expect(ambiguousOperator.test(rejected)).toBe(true);

    const source = await readFile(new URL("create-m4f-sync-root.ps1", scripts), "utf8");
    expect(ambiguousOperator.test(source)).toBe(false);
    expect(source).toContain("while ($null -ne $current)");
    expect(source.match(/\$current -isnot \[IO\.DirectoryInfo\]/g)).toHaveLength(1);
    expect(source).toContain("($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0");
    expect(source.match(/\$item -isnot \[IO\.DirectoryInfo\]/g)).toHaveLength(1);
    expect(source).not.toContain(".PSIsContainer");
  });

  test("binds admin, fixed NTFS, ancestors, exact ACL, ADS, and identity before writing", async () => {
    const source = await readFile(new URL("create-m4f-sync-root.ps1", scripts), "utf8");
    for (const contract of [
      '$syncRoot = "C:\\Windows\\Temp\\synthia-m4f-sync-20260827-03"',
      "function Assert-AdministrativePrincipal",
      "Get-CimInstance Win32_LogicalDisk",
      "M4F_SYNC_LOCAL_FIXED_NTFS_REQUIRED",
      "function Assert-AncestorChain",
      "M4F_SYNC_ANCESTOR_REPLACE_UNTRUSTED",
      "function Assert-SameVolumeFacts",
      "M4F_SYNC_VOLUME_MAPPING_DRIFT",
      "$acl.SetAccessRuleProtection($true, $false)",
      "M4F_SYNC_ALTERNATE_STREAM",
      "M4F_SYNC_ACE_COUNT_INVALID",
    ]) expect(source).toContain(contract);
    const write = source.indexOf("[void](New-Item -ItemType Directory");
    expect(source.indexOf("Assert-AdministrativePrincipal")).toBeLessThan(write);
    expect(source.indexOf("if (Test-Path -LiteralPath $syncRoot)")).toBeLessThan(write);
    expect(source.indexOf("Assert-AncestorChain (Split-Path -Parent $syncRoot)")).toBeLessThan(write);
    expect(source.indexOf("$preVolumeFacts = Get-VolumeFacts")).toBeLessThan(write);
    expect(source.indexOf("Assert-SameVolumeFacts $preVolumeFacts $postVolumeFacts")).toBeGreaterThan(write);
    expect(source).not.toContain("Remove-Item");
    expect(source).not.toContain("D:\\synthia-m4f-toolchain-20260827-03");
    expect(source).not.toContain("ToolchainImage");
    expect(source).not.toContain("Vivado");
  });

  test("binds both creator volume serial fields only to Win32_LogicalDisk", async () => {
    for (const name of [
      "create-m4f-jump-bootstrap-root.ps1",
      "create-m4f-sync-root.ps1",
    ]) {
      const source = await readFile(new URL(name, scripts), "utf8");
      expect(source).not.toContain("$volume.SerialNumber");
      expect(source).toContain(
        "logical_volume_serial = [string]$logicalDisk.VolumeSerialNumber",
      );
      expect(source).toContain(
        "volume_serial_number = [string]$logicalDisk.VolumeSerialNumber",
      );
      expect(source).toContain("volume_unique_id = [string]$volume.UniqueId");
      expect(source).toContain("disk_number = [int]$partition.DiskNumber");
      expect(source).toContain("partition_number = [int]$partition.PartitionNumber");
      expect(source).toContain("disk_unique_id = [string]$disk.UniqueId");
    }
  });

  test("wrapper pins the exact updated sync creator bytes", async () => {
    const creator = await readFile(new URL("create-m4f-sync-root.ps1", scripts));
    const wrapper = await readFile(
      new URL("invoke-m4f-sync-root-on-jump.ps1", scripts),
      "utf8",
    );
    const digest = createHash("sha256").update(creator).digest("hex");
    expect(digest).toBe("c4d67fd1b5c8cc4ebd8698486f9377ad0ce374b5d1697816f7bee090b8436a5e");
    expect(wrapper).toContain(`$expectedSourceSha256 = "${digest}"`);
  });

  test("transport gives parse and execute independent bounded processes", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-on-jump.ps1", scripts), "utf8");
    for (const contract of [
      "M4F_SYNC_TRANSPORT_SOURCE_HASH_MISMATCH",
      "Language.Parser]::ParseFile",
      "M4F_SYNC_TRANSPORT_SOURCE_PARSE_FAILED",
      "Language.Parser]::ParseInput",
      '"create-m4f-sync-root.ps1"',
      "synthia-m4f-powershell-parse.v1",
      "$phaseTimeoutMilliseconds = 120000",
      'Invoke-BoundedRemotePhase $parseCommand "parse" $phaseTimeoutMilliseconds',
      'Invoke-BoundedRemotePhase $executeCommand "execute" $phaseTimeoutMilliseconds',
      '"-o BatchMode=yes"',
      '"-o ConnectTimeout=15"',
      '"-o ConnectionAttempts=1"',
      '"-o ServerAliveInterval=10"',
      '"-o ServerAliveCountMax=2"',
      "$process.WaitForExit($TimeoutMilliseconds)",
      "$process.Kill()",
      "$process.WaitForExit(10000)",
      "M4F_SYNC_TRANSPORT_OUTCOME_AMBIGUOUS",
      "$Outcome.exit_status -ne 0",
      "$Outcome.stderr_bytes.Length -ne 0",
      "M4F_SYNC_TRANSPORT_OUTPUT_INVALID",
    ]) expect(source).toContain(contract);
    expect(source.indexOf("$Outcome.exit_status -ne 0"))
      .toBeLessThan(source.indexOf("$Outcome.stderr_bytes.Length -ne 0"));
    expect(source.indexOf('Invoke-BoundedRemotePhase $parseCommand "parse"'))
      .toBeLessThan(source.indexOf('Invoke-BoundedRemotePhase $executeCommand "execute"'));
    expect(source.match(/Invoke-BoundedRemotePhase /g)).toHaveLength(2);
    expect(source).not.toContain("$totalTimeoutMilliseconds");
    expect(source).not.toContain("scp.exe");
  });

  test("preserves failed phase bytes in one exact structured envelope", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-on-jump.ps1", scripts), "utf8");
    for (const contract of [
      "$process.StandardOutput.BaseStream.CopyToAsync($stdoutBuffer)",
      "$process.StandardError.BaseStream.CopyToAsync($stderrBuffer)",
      'schema = "synthia-m4f-sync-remote-phase-failure.v1"',
      "stdout_base64 = [Convert]::ToBase64String($Outcome.stdout_bytes)",
      "stderr_base64 = [Convert]::ToBase64String($Outcome.stderr_bytes)",
      "exit_status = $Outcome.exit_status",
      "signal = $Outcome.signal",
      "timeout = $Outcome.timeout",
      "ambiguous = $Outcome.ambiguous",
      '$Outcome.exit_status.GetType() -ne [int]',
      '[Console]::Error.Write($json + "`n")',
    ]) expect(source).toContain(contract);

    const failureBlock = source.match(/\$failure = \[ordered\]@\{([\s\S]*?)\n  \}/)?.[1] ?? "";
    expect([...failureBlock.matchAll(/^    ([a-z0-9_]+) =/gm)].map(match => match[1])).toEqual([
      "schema",
      "phase",
      "failure_code",
      "stdout_base64",
      "stderr_base64",
      "exit_status",
      "signal",
      "timeout",
      "ambiguous",
    ]);
    expect(source).not.toContain("[Console]::Error.Write($standardOutput)");
    expect(source).not.toContain("[Console]::Error.Write($standardError)");
  });

  test("accepts only one non-empty JSON line and validates native JSON types without casts", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-on-jump.ps1", scripts), "utf8");
    for (const contract of [
      '$output.EndsWith("`r`n")',
      '$output.EndsWith("`n")',
      '$line.Length -eq 0',
      '$line.Contains("`r")',
      '$line.Contains("`n")',
      "$Value.GetType() -ne [pscustomobject]",
      "$Value.GetType() -ne [string]",
      "$Value.GetType() -ne [bool]",
      "$Value.GetType() -ne [int]",
      "$Value.GetType() -ne [long]",
      'schema = "synthia-m4f-sync-root-ceremony.v1"',
      'status = "passed"',
      "$result.volume_serial_number -cne $result.logical_volume_serial",
      "parse = $parseResult",
      "execute = $result",
    ]) expect(source).toContain(contract);
    expect(source).not.toContain("Where-Object { $_.Length -ne 0 }");
    expect(source).not.toMatch(/\[(?:string|int|bool)\]\$parseResult\./);
    expect(source).not.toMatch(/\[(?:string|int|bool)\]\$result\./);
    expect(source).not.toContain(" -as ");
    expect(source.indexOf("$result.volume_serial_number -cne $result.logical_volume_serial"))
      .toBeLessThan(source.lastIndexOf('[Console]::Out.WriteLine(([ordered]@{'));
  });
});
