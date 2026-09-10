import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  runJumpBootstrapCeremony,
} from "./scripts/invoke-m4f-jump-bootstrap-root.ts";
import {
  CeremonyFailure,
  type BoundJumpPhaseResult,
} from "./scripts/m4f-bound-jump-transport.ts";

const scripts = new URL("./scripts/", import.meta.url);

describe("M4-F fixed jump bootstrap root", () => {
  test("creates only the exact empty Admin/System boundary after fixed-NTFS checks", async () => {
    const source = await readFile(new URL("create-m4f-jump-bootstrap-root.ps1", scripts), "utf8");
    for (const contract of [
      '$bootstrapRoot = "C:\\Windows\\Temp\\synthia-m4f-jump-bootstrap-20260827-03"',
      "function Assert-AdministrativePrincipal",
      "Get-CimInstance Win32_LogicalDisk",
      "M4F_JUMP_BOOTSTRAP_LOCAL_FIXED_NTFS_REQUIRED",
      "function Assert-AncestorChain",
      "M4F_JUMP_BOOTSTRAP_ANCESTOR_REPLACE_UNTRUSTED",
      "function Assert-SameVolumeFacts",
      "logical_volume_serial = [string]$logicalDisk.VolumeSerialNumber",
      "volume_serial_number = [string]$logicalDisk.VolumeSerialNumber",
      "$acl.SetAccessRuleProtection($true, $false)",
      "M4F_JUMP_BOOTSTRAP_ALTERNATE_STREAM",
      "M4F_JUMP_BOOTSTRAP_ACE_COUNT_INVALID",
    ]) expect(source).toContain(contract);
    const write = source.indexOf("[void](New-Item -ItemType Directory");
    expect(source.indexOf("Assert-AdministrativePrincipal")).toBeLessThan(write);
    expect(source.indexOf("if (Test-Path -LiteralPath $bootstrapRoot)")).toBeLessThan(write);
    expect(source.indexOf("Assert-AncestorChain (Split-Path -Parent $bootstrapRoot)")).toBeLessThan(write);
    expect(source.indexOf("$preVolumeFacts = Get-VolumeFacts")).toBeLessThan(write);
    expect(source.indexOf("Assert-SameVolumeFacts $preVolumeFacts $postVolumeFacts")).toBeGreaterThan(write);
    expect(source).not.toContain("$volume.SerialNumber");
    expect(source.indexOf("[string]$logicalDisk.FileSystem -cne \"NTFS\"")).toBeLessThan(write);
    expect(source.indexOf("[string]$volume.FileSystem -cne \"NTFS\"")).toBeLessThan(write);
    expect(source.indexOf("[string]$volume.DriveType -cne \"Fixed\"")).toBeLessThan(write);
    expect(source.indexOf("[string]$volume.UniqueId")).toBeLessThan(write);
    expect(source.indexOf("logical_volume_serial = [string]$logicalDisk.VolumeSerialNumber"))
      .toBeLessThan(source.indexOf("volume_serial_number = [string]$logicalDisk.VolumeSerialNumber"));
    expect(source.match(/\$current -isnot \[IO\.DirectoryInfo\]/g)).toHaveLength(1);
    expect(source.match(/\$item -isnot \[IO\.DirectoryInfo\]/g)).toHaveLength(1);
    expect(source).not.toContain(".PSIsContainer");
    expect(source).not.toContain("Remove-Item");
    expect(source).not.toContain("192.168.31.66");
    expect(source).not.toContain("ToolchainImage");
    expect(source).not.toContain("Vivado");
  });

  test("is import-safe and delegates ParseInput then execute to the injected bound transport", async () => {
    const source = await readFile(new URL("invoke-m4f-jump-bootstrap-root.ts", scripts), "utf8");
    for (const contract of [
      "Language.Parser]::ParseInput",
      "export function runJumpBootstrapCeremony(",
      'invoke("jump-bootstrap:parse", parserHarness)',
      'invoke("jump-bootstrap:execute", sourceBytes.toString("utf8"))',
      "if (import.meta.main)",
      "exactKeys(\n    parse",
      "exactKeys(execute, [",
    ]) expect(source).toContain(contract);
    expect(source.indexOf('invoke("jump-bootstrap:parse", parserHarness)'))
      .toBeLessThan(source.indexOf('invoke("jump-bootstrap:execute", sourceBytes.toString("utf8"))'));

    const phases: string[] = [];
    const invokedScripts: string[] = [];
    const result = runJumpBootstrapCeremony((phase, script) => {
      phases.push(phase);
      invokedScripts.push(script);
      expect(script.length).toBeGreaterThan(0);
      const payload = phase.endsWith(":parse")
        ? {
          schema: "synthia-m4f-powershell-parse.v1",
          status: "passed",
          source_sha256: "56a20e05580b25022466187a58ecb5840134f11c0a78e5655e7ba5dd771799c5",
          token_count: 1,
          error_count: 0,
        }
        : {
          schema: "synthia-m4f-jump-bootstrap-root.v1",
          status: "passed",
          bootstrap_root: "C:\\Windows\\Temp\\synthia-m4f-jump-bootstrap-20260827-03",
          owner_sid: "S-1-5-32-544",
          logical_volume_serial: "logical-serial",
          volume_unique_id: "volume-id",
          volume_serial_number: "logical-serial",
          disk_number: 0,
          partition_number: 1,
          disk_unique_id: "disk-id",
          protected: true,
          explicit_ace_count: 2,
          empty: true,
          reparse: false,
          alternate_streams: false,
        };
      return { phase, payload } as BoundJumpPhaseResult;
    });
    expect(phases).toEqual(["jump-bootstrap:parse", "jump-bootstrap:execute"]);
    expect(result.schema).toBe("synthia-m4f-jump-bootstrap-ceremony.v1");
    expect(result.status).toBe("passed");
    expect(invokedScripts[1]).toStartWith("[CmdletBinding()]\nparam()\n");
    const exactArtifact = invokedScripts[0]!.match(/FromBase64String\("([A-Za-z0-9+/=]+)"\)/u);
    expect(exactArtifact).not.toBeNull();
    expect(Buffer.from(exactArtifact![1]!, "base64").toString("utf8")).toBe(invokedScripts[1]);

    const mismatchedSerials = {
      ...result.execute,
      payload: { ...result.execute.payload, volume_serial_number: "different-source" },
    };
    let serialSourceError: CeremonyFailure | undefined;
    try {
      runJumpBootstrapCeremony((phase) => phase.endsWith(":parse")
        ? result.parse
        : mismatchedSerials);
    } catch (error) {
      serialSourceError = error as CeremonyFailure;
    }
    expect(serialSourceError).toBeInstanceOf(CeremonyFailure);
    expect(serialSourceError!.detail.code).toBe("M4F_JUMP_BOOTSTRAP_OUTPUT_INVALID");
    expect(serialSourceError!.detail.execute).toBe(mismatchedSerials);

    const executeTransportFailure = new CeremonyFailure({
      schema: "synthia-m4f-bound-transport-failure.v1",
      code: "M4F_BOUND_PHASE_OUTCOME_AMBIGUOUS",
      process: { stdout_base64: "cGFydGlhbA==", stderr_base64: "", signal: "SIGTERM", status: null },
    });
    let transportError: CeremonyFailure | undefined;
    try {
      runJumpBootstrapCeremony((phase) => {
        if (phase.endsWith(":parse")) return result.parse;
        throw executeTransportFailure;
      });
    } catch (error) {
      transportError = error as CeremonyFailure;
    }
    expect(transportError).toBeInstanceOf(CeremonyFailure);
    expect(transportError!.detail.parse).toBe(result.parse);
    expect(transportError!.detail.execute_failure).toBe(executeTransportFailure.detail);

    const invalidExecute = {
      ...result.execute,
      payload: { ...result.execute.payload, status: "failed" },
    };
    let semanticError: CeremonyFailure | undefined;
    try {
      runJumpBootstrapCeremony((phase) => phase.endsWith(":parse")
        ? result.parse
        : invalidExecute);
    } catch (error) {
      semanticError = error as CeremonyFailure;
    }
    expect(semanticError).toBeInstanceOf(CeremonyFailure);
    expect(semanticError!.detail.parse).toBe(result.parse);
    expect(semanticError!.detail.execute).toBe(invalidExecute);
  });
});
