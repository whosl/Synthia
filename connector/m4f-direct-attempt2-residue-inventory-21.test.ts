import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  ATTEMPT2_EVIDENCE_MANIFEST,
  RESIDUE_INVENTORY_EVIDENCE_DIRECTORY,
  RESIDUE_INVENTORY_ID,
  RESIDUE_INVENTORY_WINDOW_END,
  RESIDUE_INVENTORY_WINDOW_START,
  ResidueInventoryFailure,
  buildResidueInventoryCommand,
  buildResidueInventoryScript,
  executeResidueInventory,
  planResidueInventory,
  residueInventoryConfirmation,
  validateResidueInventoryOutput,
  type ResidueInventoryConfig,
  type ResidueInventoryDependencies,
} from "./scripts/m4f-direct-attempt2-residue-inventory-21.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url).pathname;
const TRANSPORT_SOURCE = new URL("./scripts/m4f-gate-admission-transport.ts", import.meta.url).pathname;
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const ATTEMPT2_EVIDENCE = "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-evidence";
const ADJUDICATION = "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-adjudication.json";
const REVIEW = "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-review.json";
const EFFECTIVE = ATTEMPT2_EVIDENCE + "/ssh-effective-stdout.raw";
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

function row(
  pid: number,
  ppid: number,
  name: string,
  creation: string,
  root: number | null,
  excluded: boolean,
): unknown[] {
  return [pid, ppid, name, creation, 0, true, 100, "a".repeat(64), root, excluded];
}

function stdout(config: ResidueInventoryConfig): Buffer {
  const values = [
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
          row(9050, 9000, "cmd.exe", "2026-08-30T14:30:00.1000000Z", 9000, true),
          row(9100, 9050, "powershell.exe", "2026-08-30T14:30:00.2000000Z", 9000, true),
          row(9150, 9050, "conhost.exe", "2026-08-30T14:30:00.1500000Z", 9000, true),
        ],
        candidates: [
          row(7000, 6000, "sshd.exe", "2026-08-30T14:10:50.0000000Z", 7000, false),
          row(7100, 7050, "powershell.exe", "2026-08-30T14:10:51.0000000Z", 7000, false),
        ],
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
  ];
  return Buffer.from(values.map((value) => JSON.stringify(value)).join("\r\n") + "\r\n");
}

interface Fixture {
  config: ResidueInventoryConfig;
  dependencies: ResidueInventoryDependencies;
  files: Map<string, Buffer>;
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeout: number }>;
  writes: Map<string, Buffer>;
  setRemote(result: RawProcessResult): void;
}

function fixture(): Fixture {
  const files = new Map<string, Buffer>();
  for (const path of [SOURCE, TEST_SOURCE, TRANSPORT_SOURCE, TRANSPORT_CONFIG, ADJUDICATION, REVIEW]) {
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(ATTEMPT2_EVIDENCE_MANIFEST)) {
    files.set(ATTEMPT2_EVIDENCE + "/" + name, readFileSync(ATTEMPT2_EVIDENCE + "/" + name));
  }
  const config: ResidueInventoryConfig = {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-config.v1",
    inventory_id: RESIDUE_INVENTORY_ID,
    evidence_directory: RESIDUE_INVENTORY_EVIDENCE_DIRECTORY,
    transport_config_path: TRANSPORT_CONFIG,
    transport_config_sha256: sha256(files.get(TRANSPORT_CONFIG)!) as ResidueInventoryConfig["transport_config_sha256"],
    attempt2_evidence_directory: ATTEMPT2_EVIDENCE,
    attempt2_evidence_manifest_sha256: sha256(
      JSON.stringify(ATTEMPT2_EVIDENCE_MANIFEST, Object.keys(ATTEMPT2_EVIDENCE_MANIFEST).sort()) + "\n",
    ) as ResidueInventoryConfig["attempt2_evidence_manifest_sha256"],
    attempt2_failure_sha256: sha256(files.get(ATTEMPT2_EVIDENCE + "/parse-failure.json")!) as ResidueInventoryConfig["attempt2_failure_sha256"],
    attempt2_remote_process_sha256: sha256(files.get(ATTEMPT2_EVIDENCE + "/remote-process.json")!) as ResidueInventoryConfig["attempt2_remote_process_sha256"],
    attempt2_adjudication_path: ADJUDICATION,
    attempt2_adjudication_sha256: sha256(files.get(ADJUDICATION)!) as ResidueInventoryConfig["attempt2_adjudication_sha256"],
    attempt2_review_path: REVIEW,
    attempt2_review_sha256: sha256(files.get(REVIEW)!) as ResidueInventoryConfig["attempt2_review_sha256"],
    window_start_utc: RESIDUE_INVENTORY_WINDOW_START,
    window_end_utc: RESIDUE_INVENTORY_WINDOW_END,
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_source_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_transport_source_sha256: sha256(files.get(TRANSPORT_SOURCE)!) as ResidueInventoryConfig["expected_transport_source_sha256"],
    expected_effective_config_sha256: sha256(files.get(EFFECTIVE)!) as ResidueInventoryConfig["expected_effective_config_sha256"],
  };
  const calls: Fixture["calls"] = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(stdout(config));
  let created = false;
  const dependencies: ResidueInventoryDependencies = {
    spawn(_executable, args, stdin, timeout) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin), timeout });
      return args[0] === "-G" ? processResult(files.get(EFFECTIVE)!) : remote;
    },
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    entries(path) {
      if (path !== ATTEMPT2_EVIDENCE) throw new Error("directory");
      return Object.keys(ATTEMPT2_EVIDENCE_MANIFEST).sort();
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== config.evidence_directory) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-30T14:40:00.000Z"),
  };
  return {
    config,
    dependencies,
    files,
    calls,
    writes,
    setRemote(value) { remote = value; },
  };
}

function failure(run: () => unknown): ResidueInventoryFailure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(ResidueInventoryFailure);
    return error as ResidueInventoryFailure;
  }
  throw new Error("expected failure");
}

describe("attempt2 direct residue inventory", () => {
  test("builds a bounded zero-stdin read-only command with early start flush", () => {
    const value = fixture();
    const script = buildResidueInventoryScript(value.config);
    const command = buildResidueInventoryCommand(value.config);
    const plan = planResidueInventory(value.config, value.dependencies);
    expect(command.length).toBeLessThanOrEqual(7000);
    expect(script.indexOf("[Console]::Out.Flush()")).toBeLessThan(script.indexOf("Get-CimInstance"));
    expect(script.match(/ -ieq /gu)).toHaveLength(3);
    expect(script).not.toContain("-cieq");
    expect(script).toContain("function Get-SynthiaM4fInventoryHash");
    expect(script).toContain("function ConvertTo-SynthiaM4fInventoryRow");
    expect(script).not.toMatch(/function\s+[A-Za-z](?:\s|\()/u);
    expect(script).not.toMatch(/\([A-Za-z]\s+\$/u);
    expect(script).not.toMatch(/ReadToEnd|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado(?:\.exe|\s+-mode)|program_hw/iu);
    expect(plan).toMatchObject({
      effective_audit_count: 1,
      remote_attempt_count: 1,
      stdin_length: 0,
      retry_permitted: false,
      cleanup_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
  });

  test("strictly separates diagnostic tree from window candidates", () => {
    const value = fixture();
    const result = validateResidueInventoryOutput(stdout(value.config), value.config);
    expect(result).toMatchObject({
      status: "observed",
      candidate_count: 2,
      diagnostic_tree_count: 4,
      protected_worker_exact: true,
      listener_exact: true,
    });
  });

  test("executes one effective audit and one empty-stdin inventory", () => {
    const value = fixture();
    const confirmation = residueInventoryConfirmation(value.config, value.dependencies);
    const record = executeResidueInventory(
      value.config, confirmation, value.config.evidence_directory, value.dependencies,
    );
    expect(record).toMatchObject({ status: "observed", stdin_length: 0, cleanup_performed: false });
    expect(value.calls).toHaveLength(2);
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.calls[1]!.timeout).toBe(20_000);
    expect(value.writes.has(value.config.evidence_directory + "/inventory-record.json")).toBe(true);
  });

  test("tamper and wrong confirmation fail before remote execution", () => {
    const value = fixture();
    const confirmation = residueInventoryConfirmation(value.config, value.dependencies);
    expect(failure(() => executeResidueInventory(
      value.config, confirmation + "x", value.config.evidence_directory, value.dependencies,
    )).detail.code).toBe("M4F_ATTEMPT2_RESIDUE_INVENTORY_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
    const drift = fixture();
    drift.files.set(ATTEMPT2_EVIDENCE + "/parse-failure.json", Buffer.from("{}\n"));
    expect(failure(() => planResidueInventory(drift.config, drift.dependencies)).detail.code)
      .toBe("M4F_ATTEMPT2_RESIDUE_INVENTORY_INPUT_DRIFT");
    expect(drift.calls).toHaveLength(0);
  });

  test("remote timeout fails closed without retry", () => {
    const value = fixture();
    value.setRemote(processResult("", "", null, "ETIMEDOUT"));
    const confirmation = residueInventoryConfirmation(value.config, value.dependencies);
    const error = failure(() => executeResidueInventory(
      value.config, confirmation, value.config.evidence_directory, value.dependencies,
    ));
    expect(error.detail).toMatchObject({
      code: "M4F_ATTEMPT2_RESIDUE_INVENTORY_REMOTE_FAILED",
      retry_permitted: false,
      cleanup_performed: false,
    });
    expect(value.calls).toHaveLength(2);
  });
});
