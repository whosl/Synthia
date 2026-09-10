import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CANDIDATE30_EVIDENCE_DIRECTORY,
  CANDIDATE30_ID,
  CANDIDATE27_EVIDENCE_DIRECTORY,
  CANDIDATE27_MANIFEST,
  CANDIDATE27_MANIFEST_SHA256,
  CANDIDATE27_RECORD_SHA256,
  CANDIDATE28_EVIDENCE_DIRECTORY,
  CANDIDATE28_MANIFEST,
  CANDIDATE28_MANIFEST_SHA256,
  CANDIDATE28_RECORD_SHA256,
  Candidate30Failure,
  buildCandidate30Payload,
  candidate30HasForbiddenMutation,
  candidate30Confirmation,
  executeCandidate30,
  planCandidate30,
  type Candidate30Config,
  type Candidate30Dependencies,
} from "./scripts/m4f-direct-attempt2-residue-inventory-30.ts";
import type { ResidueInventoryConfig } from "./scripts/m4f-direct-attempt2-residue-inventory-21.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-inventory-30.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-attempt2-residue-inventory-30.test.ts", import.meta.url).pathname;
const INVENTORY_SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url).pathname;
const INVENTORY_TEST = new URL("./m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url).pathname;
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const INVENTORY_CONFIG =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-21-evidence/inventory-config.canonical.json";
const EFFECTIVE = CANDIDATE28_EVIDENCE_DIRECTORY + "/ssh-effective-stdout.raw";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function processResult(
  stdout: string | Buffer,
  stderr: string | Buffer = "",
  status: number | null = 0,
  errorCode: string | null = null,
): RawProcessResult {
  return {
    status,
    signal: null,
    errorCode,
    stdout: Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? Buffer.from(stderr) : Buffer.from(stderr),
  };
}

function row(pid: number, ppid: number, name: string, creation: string, root: number | null, excluded: boolean): unknown[] {
  return [pid, ppid, name, creation, 0, true, 100, "a".repeat(64), root, excluded];
}

function inventorySuccess(config: ResidueInventoryConfig): Buffer {
  return Buffer.from([
    { s: "r21", id: config.inventory_id, n: 1, t: "start", z: "observed" },
    {
      s: "r21", id: config.inventory_id, n: 2, t: "snapshot", z: "observed",
      p: {
        window_start: "2026-08-30T14:10:49.0000000Z",
        window_end: "2026-08-30T14:11:19.9990000Z",
        cim_snapshot_count: 1,
        current_pid: 9100,
        diagnostic_root_pid: 9000,
        diagnostic_tree: [
          row(9000, 8000, "sshd.exe", "2026-08-30T14:30:00.0000000Z", 9000, true),
          row(9100, 9000, "powershell.exe", "2026-08-30T14:30:00.2000000Z", 9000, true),
        ],
        candidates: [row(7100, 7000, "powershell.exe", "2026-08-30T14:10:51.0000000Z", 7000, false)],
        protected_worker: row(13644, 2712, "node.exe", "2026-08-14T08:02:31.2903580Z", null, false),
        protected_worker_exact: true,
        listeners: [["0.0.0.0", 8443, 13644]],
        listener_exact: true,
        stdin_length: 0,
      },
    },
    {
      s: "r21", id: config.inventory_id, n: 3, t: "complete", z: "complete",
      p: {
        retry_permitted: false,
        process_mutation_performed: false,
        file_mutation_performed: false,
        vivado_action_performed: false,
        hardware_action_performed: false,
        cleanup_performed: false,
        remote_file_write_performed: false,
        stdin_length: 0,
      },
    },
  ].map((value) => JSON.stringify(value)).join("\r\n") + "\r\n");
}

function fixture() {
  const files = new Map<string, Buffer>();
  for (const path of [SOURCE, TEST_SOURCE, INVENTORY_SOURCE, INVENTORY_TEST, TRANSPORT_CONFIG,
    INVENTORY_CONFIG]) files.set(path, readFileSync(path));
  for (const name of Object.keys(CANDIDATE27_MANIFEST)) {
    const path = CANDIDATE27_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE28_MANIFEST)) {
    const path = CANDIDATE28_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  const inventoryConfig = JSON.parse(files.get(INVENTORY_CONFIG)!.toString("utf8")) as ResidueInventoryConfig;
  const payload = buildCandidate30Payload(inventoryConfig);
  const success = inventorySuccess(inventoryConfig);
  const config: Candidate30Config = {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-30-config.v1",
    inventory_id: CANDIDATE30_ID,
    evidence_directory: CANDIDATE30_EVIDENCE_DIRECTORY,
    candidate27_evidence_directory: CANDIDATE27_EVIDENCE_DIRECTORY,
    candidate27_evidence_manifest_sha256: CANDIDATE27_MANIFEST_SHA256,
    candidate27_record_sha256: CANDIDATE27_RECORD_SHA256,
    candidate28_evidence_directory: CANDIDATE28_EVIDENCE_DIRECTORY,
    candidate28_evidence_manifest_sha256: CANDIDATE28_MANIFEST_SHA256,
    candidate28_record_sha256: CANDIDATE28_RECORD_SHA256,
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_inventory_source_sha256: sha256(files.get(INVENTORY_SOURCE)!),
    expected_inventory_test_sha256: sha256(files.get(INVENTORY_TEST)!),
  };
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }> = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(success);
  let created = false;
  const dependencies: Candidate30Dependencies = {
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    entries(path) {
      if (path === CANDIDATE27_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE27_MANIFEST).sort();
      if (path === CANDIDATE28_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE28_MANIFEST).sort();
      throw new Error("directory");
    },
    spawn(_executable, args, stdin, timeoutMs) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(files.get(EFFECTIVE)!) : remote;
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== CANDIDATE30_EVIDENCE_DIRECTORY) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-30T16:00:00.000Z"),
  };
  return {
    config,
    dependencies,
    calls,
    writes,
    payload,
    setRemote(value: RawProcessResult) { remote = value; },
  };
}

function failure(run: () => unknown): Candidate30Failure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate30Failure);
    return error as Candidate30Failure;
  }
  throw new Error("expected failure");
}

describe("M4-F Candidate 30 read-only inventory", () => {
  test("binds the parse-zero exact script and permits only read-only observation", () => {
    const value = fixture();
    expect(value.payload.command.length).toBeLessThanOrEqual(7_000);
    expect(value.payload.targetScript).toContain("foreach ($p in $a)");
    expect(value.payload.targetScript).toContain("$i -lt 8 -and $q");
    expect(value.payload.targetScript).toContain("D:\\softwares\\Nodejs\\node.exe");
    expect(value.payload.targetScript.match(/ -ieq /gu)).toHaveLength(3);
    expect(value.payload.targetScript).not.toMatch(/foreach\s*\(\$p in\$|\$i-lt|-cieq/u);
    expect(value.payload.targetHash).toBe("31b4c637ce9d1ddbfe3b7438a967b2ef50353fcfeb46ea3f9f2eea3a58f543e2");
    expect(value.payload.targetLength).toBe(3_642);
    expect(value.payload.targetScript).toContain("function Get-SynthiaM4fInventoryHash");
    expect(value.payload.targetScript).toContain("function ConvertTo-SynthiaM4fInventoryRow");
    expect(value.payload.targetScript).toContain("Get-CimInstance Win32_Process");
    expect(candidate30HasForbiddenMutation(
      "$e=[ordered]@{remote_file_write_performed=$false;file_mutation_performed=$false;vivado_action_performed=$false}",
    )).toBe(false);
    expect(candidate30HasForbiddenMutation("$x=1;Out-File result.txt")).toBe(true);
    expect(candidate30HasForbiddenMutation("$x=1;Vivado.exe -mode batch")).toBe(true);
    expect(candidate30HasForbiddenMutation(value.payload.targetScript)).toBe(false);
  });

  test("plans without network and freezes empty stdin plus one attempt", () => {
    const value = fixture();
    expect(planCandidate30(value.config, value.dependencies)).toMatchObject({
      status: "planned_not_executed",
      effective_audit_count: 1,
      remote_attempt_count: 1,
      stdin_length: 0,
      target_body_invocation_permitted: true,
      cim_read_only_execution_permitted: true,
      retry_permitted: false,
      candidate27_evidence_manifest_sha256: CANDIDATE27_MANIFEST_SHA256,
      candidate27_record_sha256: CANDIDATE27_RECORD_SHA256,
      candidate28_evidence_manifest_sha256: CANDIDATE28_MANIFEST_SHA256,
      candidate28_record_sha256: CANDIDATE28_RECORD_SHA256,
    });
    expect(value.calls).toHaveLength(0);
  });

  test("runs one effective audit and one empty-stdin read-only inventory", () => {
    const value = fixture();
    const exact = candidate30Confirmation(value.config, value.dependencies);
    expect(executeCandidate30(value.config, exact, value.dependencies)).toMatchObject({
      status: "observed",
      target_body_invoked: true,
      cim_executed: true,
      inventory_result: {
        candidate_count: 1,
        diagnostic_tree_count: 2,
        protected_worker_exact: true,
        listener_exact: true,
        snapshot: {
          diagnostic_root_pid: 9000,
          diagnostic_tree: [
            [9000, 8000, "sshd.exe", "2026-08-30T14:30:00.0000000Z", 0, true, 100,
              "a".repeat(64), 9000, true],
            [9100, 9000, "powershell.exe", "2026-08-30T14:30:00.2000000Z", 0, true, 100,
              "a".repeat(64), 9000, true],
          ],
          candidates: [
            [7100, 7000, "powershell.exe", "2026-08-30T14:10:51.0000000Z", 0, true, 100,
              "a".repeat(64), 7000, false],
          ],
          protected_worker_exact: true,
          listener_exact: true,
          listeners: [["0.0.0.0", 8443, 13644]],
        },
      },
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.has(CANDIDATE30_EVIDENCE_DIRECTORY + "/inventory-record.json")).toBe(true);
  });

  test("wrong confirmation fails before any spawn", () => {
    const value = fixture();
    const exact = candidate30Confirmation(value.config, value.dependencies);
    expect(failure(() => executeCandidate30(value.config, exact + "x", value.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE30_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
  });

  test("invalid output and remote failures are terminal and never retried", () => {
    const invalid = fixture();
    invalid.setRemote(processResult("{}\r\n"));
    const outputFailure = failure(() => executeCandidate30(
      invalid.config,
      candidate30Confirmation(invalid.config, invalid.dependencies),
      invalid.dependencies,
    ));
    expect(outputFailure.detail).toMatchObject({
      code: "M4F_CANDIDATE30_INVENTORY_OUTPUT_INVALID",
      retry_permitted: false,
      target_body_invoked: "unknown",
      cim_executed: "unknown",
    });
    expect(invalid.calls).toHaveLength(2);

    const remote = fixture();
    remote.setRemote(processResult("", "failure", 1));
    expect(failure(() => executeCandidate30(
      remote.config,
      candidate30Confirmation(remote.config, remote.dependencies),
      remote.dependencies,
    )).detail.code).toBe("M4F_CANDIDATE30_REMOTE_FAILED");
    expect(remote.calls).toHaveLength(2);
  });
});
