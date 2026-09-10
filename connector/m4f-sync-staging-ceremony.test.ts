import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  runSyncRootStagingCeremony,
  type SyncRootStagingDependencies,
} from "./scripts/invoke-m4f-sync-root-ceremony.ts";
import {
  CeremonyFailure,
  type BoundJumpCopyResult,
  type BoundJumpPhaseResult,
  type MasterAuditEvidence,
} from "./scripts/m4f-bound-jump-transport.ts";

const scripts = new URL("./scripts/", import.meta.url);

describe("M4-F Mac to jump to target sync-root ceremony", () => {
  test("is confirmation-gated and performs the one-way stages in order", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-ceremony.ts", scripts), "utf8");
    for (const contract of [
      "SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION",
      "M4F_SYNC_STAGING_CONFIRMATION_REQUIRED",
      "runJumpBootstrapCeremony()",
      "copyBoundJumpFiles(localSources, remoteDirectory)",
      'dependencies.invokePhase("sync-staging:seal", buildSealScript())',
      '"sync-staging:execute-once"',
      "M4F_SYNC_STAGING_LOCAL_SOURCE_DRIFT",
    ]) expect(source).toContain(contract);
    const run = source.slice(source.indexOf("export function runSyncRootStagingCeremony"));
    expect(run.indexOf("SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION"))
      .toBeLessThan(run.indexOf("dependencies.verifySource("));
    expect(run.indexOf("dependencies.verifySource("))
      .toBeLessThan(run.indexOf("completed.bootstrap = dependencies.runBootstrap()"));
    expect(run.indexOf("completed.bootstrap = dependencies.runBootstrap()"))
      .toBeLessThan(run.indexOf("completed.copy = dependencies.copyFiles("));
    expect(run.indexOf("completed.copy = dependencies.copyFiles("))
      .toBeLessThan(run.indexOf('dependencies.invokePhase("sync-staging:seal"'));
    expect(run.indexOf('dependencies.invokePhase("sync-staging:seal"'))
      .toBeLessThan(run.indexOf('"sync-staging:execute-once"'));
    expect(source.match(/copyBoundJumpFiles\(/g)).toHaveLength(1);
    expect(source.match(/sync-staging:execute-once/g)).toHaveLength(1);
  });

  test("uploads only the two pinned regular files and seals their exact remote boundary", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-ceremony.ts", scripts), "utf8");
    for (const contract of [
      'const SOURCE_NAME = "create-m4f-sync-root.ps1"',
      'const WRAPPER_NAME = "invoke-m4f-sync-root-on-jump.ps1"',
      "facts.isFile()",
      "facts.isSymbolicLink()",
      "Get-ChildItem -LiteralPath $root -Force",
      "$children.Count -ne 2",
      "M4F_SYNC_STAGING_FILE_SET_INVALID",
      "M4F_SYNC_STAGING_ALTERNATE_STREAM",
      "$acl.SetAccessRuleProtection($true, $false)",
      "M4F_SYNC_STAGING_ACL_COUNT_INVALID",
      "Language.Parser]::ParseFile",
      "M4F_SYNC_STAGING_FILE_HASH_DRIFT",
    ]) expect(source).toContain(contract);
    expect(source).not.toContain("Remove-Item");
    expect(source).not.toContain("ToolchainImage");
    expect(source).not.toContain("Vivado");
    expect(source).not.toContain("hw_server");
  });

  test("pins the final creator and wrapper cascade hashes", async () => {
    const creator = await readFile(new URL("create-m4f-sync-root.ps1", scripts));
    const wrapper = await readFile(new URL("invoke-m4f-sync-root-on-jump.ps1", scripts));
    const ceremony = await readFile(
      new URL("invoke-m4f-sync-root-ceremony.ts", scripts),
      "utf8",
    );
    expect(createHash("sha256").update(creator).digest("hex")).toBe(SOURCE_SHA256);
    expect(createHash("sha256").update(wrapper).digest("hex")).toBe(WRAPPER_SHA256);
    expect(ceremony).toContain(`const SOURCE_SHA256 = "${SOURCE_SHA256}"`);
    expect(ceremony).toContain(`const WRAPPER_SHA256 = "${WRAPPER_SHA256}"`);
  });

  test("rechecks bootstrap-root alternate streams in both seal and execute-once scripts", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-ceremony.ts", scripts), "utf8");
    const sealStart = source.indexOf("function buildSealScript()");
    const executeStart = source.indexOf("function buildExecuteScript()");
    const validationStart = source.indexOf("function validateSeal(");
    const sealScript = source.slice(sealStart, executeStart);
    const executeScript = source.slice(executeStart, validationStart);

    for (const contract of [
      "function Assert-SealRootStreams",
      "Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop",
      "M4F_SYNC_STAGING_ROOT_ALTERNATE_STREAM",
      "Assert-SealRootStreams $root",
      "alternate_streams = $false",
    ]) expect(sealScript).toContain(contract);
    for (const contract of [
      "function Assert-ExecuteRootStreams",
      "Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop",
      "M4F_SYNC_EXECUTE_ROOT_ALTERNATE_STREAM",
      "Assert-ExecuteRootStreams $root",
      '& (Join-Path $root "${WRAPPER_NAME}")',
    ]) expect(executeScript).toContain(contract);

    expect(sealScript.indexOf("Assert-SealRootStreams $root"))
      .toBeLessThan(sealScript.indexOf("$children = @(Get-ChildItem"));
    expect(executeScript.indexOf("Assert-ExecuteRootStreams $root"))
      .toBeLessThan(executeScript.indexOf("$children = @(Get-ChildItem"));
    expect(executeScript.indexOf("Assert-ExecuteRootStreams $root"))
      .toBeLessThan(executeScript.indexOf('& (Join-Path $root "${WRAPPER_NAME}")'));
  });

  test("uses strict CLR file and directory types throughout generated active scripts", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-ceremony.ts", scripts), "utf8");
    expect(source).not.toContain(".PSIsContainer");
    expect(source.match(/\$item -isnot \[IO\.FileInfo\]/g)).toHaveLength(2);
    expect(source.match(/\$rootItem -isnot \[IO\.DirectoryInfo\]/g)).toHaveLength(2);
    for (const guard of [
      "$item -isnot [IO.FileInfo] -or",
      "$rootItem -isnot [IO.DirectoryInfo] -or",
    ]) expect(source).toContain(guard);
    expect(source.match(/\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/g))
      .toHaveLength(2);
    expect(source.match(/\$rootItem\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/g))
      .toHaveLength(2);
  });

  test("strictly validates native nested success output", async () => {
    const source = await readFile(new URL("invoke-m4f-sync-root-ceremony.ts", scripts), "utf8");
    for (const contract of [
      "function exactKeys",
      "function objectValue",
      "typeof value === \"number\" && Number.isInteger(value)",
      'value.schema !== "synthia-m4f-sync-root-ceremony.v1"',
      'execute.schema !== "synthia-m4f-sync-root.v1"',
      "execute.volume_serial_number !== execute.logical_volume_serial",
      "execute.alternate_streams !== false",
    ]) expect(source).toContain(contract);
    expect(source).not.toContain("Number(value");
    expect(source).not.toContain("parseInt(");
  });

  test("rejects before every injectable dependency when confirmation is absent", () => {
    const previous = process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION;
    delete process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION;
    let dependencyCalls = 0;
    const forbidden = () => {
      dependencyCalls += 1;
      throw new Error("confirmation must precede dependencies");
    };
    try {
      const detail = captureFailure(() => runSyncRootStagingCeremony({
        runBootstrap: forbidden,
        copyFiles: forbidden,
        invokePhase: forbidden,
        verifySource: forbidden,
        readLocalFile: forbidden,
      }));
      expect(detail.current_stage).toBe("confirmation");
      expect(detail.retry_permitted).toBe(false);
      expect(detail.invalid_raw_payload).toBeNull();
      expect(detail.completed).toEqual({
        bootstrap: null,
        copy: null,
        seal: null,
        remote: null,
      });
      expect(dependencyCalls).toBe(0);
    } finally {
      if (previous !== undefined) {
        process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION = previous;
      }
    }
  });

  test("retains bootstrap, copy, and raw seal evidence when seal semantics fail", () => {
    withConfirmation(() => {
      const fixtures = ceremonyFixtures();
      const invalidSeal = phase("sync-staging:seal", {
        ...validSealPayload(),
        unsupported: true,
      });
      const calls = { bootstrap: 0, copy: 0, seal: 0, remote: 0 };
      const dependencies = dependenciesFor(fixtures, (name) => {
        if (name === "sync-staging:seal") {
          calls.seal += 1;
          return invalidSeal;
        }
        calls.remote += 1;
        throw new Error("remote stage must not run after invalid seal evidence");
      }, calls);

      const detail = captureFailure(() => runSyncRootStagingCeremony(dependencies));
      expect(Object.keys(detail).sort()).toEqual([
        "cause",
        "code",
        "completed",
        "current_stage",
        "invalid_raw_payload",
        "retry_permitted",
        "schema",
      ]);
      expect(detail.current_stage).toBe("seal");
      expect(detail.retry_permitted).toBe(false);
      expect(detail.invalid_raw_payload).toBe(invalidSeal.payload);
      expect(detail.completed).toEqual({
        bootstrap: fixtures.bootstrap,
        copy: fixtures.copy,
        seal: invalidSeal,
        remote: null,
      });
      expect((detail.completed as Record<string, unknown>).seal).toBe(invalidSeal);
      expect(calls).toEqual({ bootstrap: 1, copy: 1, seal: 1, remote: 0 });
    });
  });

  test("retains all stages and raw remote payload when execute semantics drift", () => {
    withConfirmation(() => {
      const fixtures = ceremonyFixtures();
      const seal = phase("sync-staging:seal", validSealPayload());
      const invalidRemotePayload = validRemotePayload();
      (invalidRemotePayload.execute as Record<string, unknown>).sync_root = "C:\\wrong-root";
      const remote = phase("sync-staging:execute-once", invalidRemotePayload);
      const calls = { bootstrap: 0, copy: 0, seal: 0, remote: 0 };
      const dependencies = dependenciesFor(fixtures, (name) => {
        if (name === "sync-staging:seal") {
          calls.seal += 1;
          return seal;
        }
        calls.remote += 1;
        return remote;
      }, calls);

      const detail = captureFailure(() => runSyncRootStagingCeremony(dependencies));
      expect(detail.current_stage).toBe("remote");
      expect(detail.retry_permitted).toBe(false);
      expect(detail.invalid_raw_payload).toBe(remote.payload);
      expect(detail.completed).toEqual({
        bootstrap: fixtures.bootstrap,
        copy: fixtures.copy,
        seal,
        remote,
      });
      expect((detail.completed as Record<string, unknown>).remote).toBe(remote);
      expect(calls).toEqual({ bootstrap: 1, copy: 1, seal: 1, remote: 1 });
    });
  });

  test("rejects non-empty serial near-miss after one remote effect with no subsequent effect", () => {
    withConfirmation(() => {
      const fixtures = ceremonyFixtures();
      const seal = phase("sync-staging:seal", validSealPayload());
      const invalidRemotePayload = validRemotePayload();
      (invalidRemotePayload.execute as Record<string, unknown>).volume_serial_number = "different";
      const remote = phase("sync-staging:execute-once", invalidRemotePayload);
      const calls = { bootstrap: 0, copy: 0, seal: 0, remote: 0 };
      const phaseOrder: string[] = [];
      const dependencies = dependenciesFor(fixtures, (name) => {
        phaseOrder.push(name);
        if (name === "sync-staging:seal") {
          calls.seal += 1;
          return seal;
        }
        calls.remote += 1;
        return remote;
      }, calls);

      const detail = captureFailure(() => runSyncRootStagingCeremony(dependencies));
      expect(detail.code).toBe("M4F_SYNC_STAGING_OUTPUT_INVALID");
      expect(detail.current_stage).toBe("remote");
      expect(detail.retry_permitted).toBe(false);
      expect(detail.invalid_raw_payload).toBe(remote.payload);
      expect((detail.completed as Record<string, unknown>).remote).toBe(remote);
      expect(phaseOrder).toEqual(["sync-staging:seal", "sync-staging:execute-once"]);
      expect(calls).toEqual({ bootstrap: 1, copy: 1, seal: 1, remote: 1 });
    });
  });
});

const SOURCE_SHA256 = "c4d67fd1b5c8cc4ebd8698486f9377ad0ce374b5d1697816f7bee090b8436a5e";
const WRAPPER_SHA256 = "f2378e0d81b34990253190d5aeeb574adea58674efb660ff07d178865f53fe7b";
const CONFIRMATION = "SYNTHIA_M4F_SYNC_ROOT_20260827_03";
const localBytes = Buffer.from("pinned-local-source", "utf8");

function master(): MasterAuditEvidence {
  return {
    schema: "synthia-m4f-bound-master-audit.v1",
    master_pid: 1,
    master_socket: "/tmp/test.sock",
    known_hosts_path: "/tmp/known_hosts",
    host_key_fingerprint: "SHA256:test",
    ssh_executable: "/usr/bin/ssh",
  };
}

function phase(phaseName: string, payload: Record<string, unknown>): BoundJumpPhaseResult {
  return {
    schema: "synthia-m4f-bound-phase.v1",
    phase: phaseName,
    identity: { schema: "test-identity.v1", status: "passed" },
    payload,
    process: {
      exit_status: 0,
      signal: null,
      error_code: null,
      stdout_base64: Buffer.from(JSON.stringify(payload)).toString("base64"),
      stderr_base64: "",
      timed_out: false,
      outcome_ambiguous: false,
      retry_permitted: false,
    },
    master_before: master(),
    master_after: master(),
  };
}

function validSealPayload(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-sync-staging-seal.v1",
    status: "passed",
    bootstrap_root: "C:\\Windows\\Temp\\synthia-m4f-jump-bootstrap-20260827-03",
    file_count: 2,
    source_sha256: SOURCE_SHA256,
    wrapper_sha256: WRAPPER_SHA256,
    source_token_count: 10,
    wrapper_token_count: 20,
    owner_sid: "S-1-5-32-544",
    protected: true,
    explicit_ace_count_per_file: 2,
    reparse: false,
    alternate_streams: false,
  };
}

function validRemotePayload(): Record<string, unknown> {
  return {
    schema: "synthia-m4f-sync-root-ceremony.v1",
    status: "passed",
    parse: {
      schema: "synthia-m4f-powershell-parse.v1",
      status: "passed",
      source_sha256: SOURCE_SHA256,
      token_count: 10,
      error_count: 0,
    },
    execute: {
      schema: "synthia-m4f-sync-root.v1",
      status: "passed",
      sync_root: "C:\\Windows\\Temp\\synthia-m4f-sync-20260827-03",
      owner_sid: "S-1-5-32-544",
      protected: true,
      explicit_ace_count: 2,
      empty: true,
      reparse: false,
      alternate_streams: false,
      logical_volume_serial: "logical",
      volume_unique_id: "volume-id",
      volume_serial_number: "logical",
      disk_number: 0,
      partition_number: 1,
      disk_unique_id: "disk-id",
    },
  };
}

function ceremonyFixtures(): {
  bootstrap: ReturnType<SyncRootStagingDependencies["runBootstrap"]>;
  copy: BoundJumpCopyResult;
} {
  const bootstrapParse = phase("jump-bootstrap:parse", { status: "passed" });
  const bootstrapExecute = phase("jump-bootstrap:execute", { status: "passed" });
  const identityBefore = phase("copy:identity-before", { status: "passed" });
  const identityAfter = phase("copy:identity-after", { status: "passed" });
  return {
    bootstrap: {
      schema: "synthia-m4f-jump-bootstrap-ceremony.v1",
      status: "passed",
      parse: bootstrapParse,
      execute: bootstrapExecute,
    },
    copy: {
      schema: "synthia-m4f-bound-copy.v1",
      status: "passed",
      remote_directory: "C:\\Windows\\Temp\\synthia-m4f-jump-bootstrap-20260827-03",
      source_count: 2,
      process: identityBefore.process,
      master_before: master(),
      master_after: master(),
      identity_before: identityBefore,
      identity_after: identityAfter,
    },
  };
}

function dependenciesFor(
  fixtures: ReturnType<typeof ceremonyFixtures>,
  invokePhase: SyncRootStagingDependencies["invokePhase"],
  calls: { bootstrap: number; copy: number },
): SyncRootStagingDependencies {
  return {
    runBootstrap: () => {
      calls.bootstrap += 1;
      return fixtures.bootstrap;
    },
    copyFiles: () => {
      calls.copy += 1;
      return fixtures.copy;
    },
    invokePhase,
    verifySource: () => Buffer.from(localBytes),
    readLocalFile: () => Buffer.from(localBytes),
  };
}

function captureFailure(operation: () => unknown): Record<string, unknown> {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CeremonyFailure);
    return (error as CeremonyFailure).detail;
  }
  throw new Error("expected ceremony to fail");
}

function withConfirmation(operation: () => void): void {
  const previous = process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION;
  process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION = CONFIRMATION;
  try {
    operation();
  } finally {
    if (previous === undefined) delete process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION;
    else process.env.SYNTHIA_M4F_SYNC_ROOT_CONFIRMATION = previous;
  }
}
