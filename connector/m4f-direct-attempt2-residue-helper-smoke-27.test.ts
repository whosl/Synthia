import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CANDIDATE27_EVIDENCE_DIRECTORY,
  CANDIDATE27_ID,
  CANDIDATE25_EVIDENCE_DIRECTORY,
  CANDIDATE25_MANIFEST,
  CANDIDATE25_MANIFEST_SHA256,
  CANDIDATE25_RECORD_SHA256,
  CANDIDATE26_EVIDENCE_DIRECTORY,
  CANDIDATE26_MANIFEST,
  CANDIDATE26_MANIFEST_SHA256,
  Candidate27Failure,
  buildCandidate27Payload,
  candidate27Confirmation,
  executeCandidate27,
  planCandidate27,
  type Candidate27Config,
  type Candidate27Dependencies,
} from "./scripts/m4f-direct-attempt2-residue-helper-smoke-27.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-helper-smoke-27.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-attempt2-residue-helper-smoke-27.test.ts", import.meta.url).pathname;
const INVENTORY_SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url).pathname;
const INVENTORY_TEST = new URL("./m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url).pathname;
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const EFFECTIVE = CANDIDATE26_EVIDENCE_DIRECTORY + "/ssh-effective-stdout.raw";
const X_SHA256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
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

function fixture() {
  const files = new Map<string, Buffer>();
  for (const path of [SOURCE, TEST_SOURCE, INVENTORY_SOURCE, INVENTORY_TEST, TRANSPORT_CONFIG]) {
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE25_MANIFEST)) {
    const path = CANDIDATE25_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE26_MANIFEST)) {
    const path = CANDIDATE26_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  const payload = buildCandidate27Payload();
  const success = Buffer.from([
    "r27", X_SHA256, 10, 1, 2, "cmd.exe", "", 0, "True", 3, ABC_SHA256, 4, "False",
  ].join("|") + "\r\n");
  const config: Candidate27Config = {
    schema: "synthia-m4f-direct-attempt2-residue-helper-smoke-27-config.v1",
    probe_id: CANDIDATE27_ID,
    evidence_directory: CANDIDATE27_EVIDENCE_DIRECTORY,
    candidate25_evidence_directory: CANDIDATE25_EVIDENCE_DIRECTORY,
    candidate25_evidence_manifest_sha256: CANDIDATE25_MANIFEST_SHA256,
    candidate25_record_sha256: CANDIDATE25_RECORD_SHA256,
    candidate26_evidence_directory: CANDIDATE26_EVIDENCE_DIRECTORY,
    candidate26_evidence_manifest_sha256: CANDIDATE26_MANIFEST_SHA256,
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_inventory_source_sha256: sha256(files.get(INVENTORY_SOURCE)!),
    expected_inventory_test_sha256: sha256(files.get(INVENTORY_TEST)!),
  };
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }> = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(success);
  let created = false;
  const dependencies: Candidate27Dependencies = {
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    entries(path) {
      if (path === CANDIDATE25_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE25_MANIFEST).sort();
      if (path === CANDIDATE26_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE26_MANIFEST).sort();
      throw new Error("directory");
    },
    spawn(_executable, args, stdin, timeoutMs) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(files.get(EFFECTIVE)!) : remote;
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== CANDIDATE27_EVIDENCE_DIRECTORY) throw new Error("create");
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

function failure(run: () => unknown): Candidate27Failure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate27Failure);
    return error as Candidate27Failure;
  }
  throw new Error("expected failure");
}

describe("M4-F Candidate 27 exact helper runtime smoke", () => {
  test("runs only the two exact source helpers and never embeds or invokes the target body", () => {
    const value = fixture();
    expect(value.payload.command.length).toBeLessThanOrEqual(7_000);
    expect(value.payload.helperScript.match(
      /function\s+(?:Get-SynthiaM4fInventoryHash|ConvertTo-SynthiaM4fInventoryRow)/gu,
    )).toHaveLength(2);
    expect(value.payload.helperScript).toContain("Get-SynthiaM4fInventoryHash 'x'");
    expect(value.payload.helperScript).toContain("ConvertTo-SynthiaM4fInventoryRow $d 4 $false");
    expect(value.payload.helperScript).not.toMatch(
      /Parser|GZip|ReadToEnd|ScriptBlock|Get-CimInstance|Stop-Process|Vivado|program_hw/iu,
    );
    expect(value.payload.helperScript).not.toContain("foreach ($p in $a)");
  });

  test("plans without network and freezes empty stdin plus one attempt", () => {
    const value = fixture();
    expect(planCandidate27(value.config, value.dependencies)).toMatchObject({
      status: "planned_not_executed",
      parser_call_count: 0,
      helper_definition_count: 2,
      helper_smoke_call_count: 2,
      remote_attempt_count: 1,
      stdin_length: 0,
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
  });

  test("runs one effective audit and one empty-stdin helper smoke", () => {
    const value = fixture();
    const exact = candidate27Confirmation(value.config, value.dependencies);
    expect(executeCandidate27(value.config, exact, value.dependencies)).toMatchObject({
      status: "exact_helpers_runtime_smoked",
      helper_result: {
        hash_x: X_SHA256,
        row_count: 10,
        row: {
          pid: 1,
          ppid: 2,
          name: "cmd.exe",
          creation_utc: null,
          session_id: 0,
          command_line_present: true,
          command_line_length: 3,
          command_line_sha256: ABC_SHA256,
          root: 4,
          excluded: false,
        },
      },
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.has(CANDIDATE27_EVIDENCE_DIRECTORY + "/helper-smoke.ps1")).toBe(true);
    expect(value.writes.has(CANDIDATE27_EVIDENCE_DIRECTORY + "/probe-record.json")).toBe(true);
  });

  test("wrong confirmation fails before any spawn", () => {
    const value = fixture();
    const exact = candidate27Confirmation(value.config, value.dependencies);
    expect(failure(() => executeCandidate27(value.config, exact + "x", value.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE27_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
  });

  test("invalid helper output and remote failures are terminal and never retried", () => {
    const parseError = fixture();
    parseError.setRemote(processResult("r27|bad|10|1|2|cmd.exe||0|True|3|bad|4|False\r\n"));
    const parseFailure = failure(() => executeCandidate27(
      parseError.config,
      candidate27Confirmation(parseError.config, parseError.dependencies),
      parseError.dependencies,
    ));
    expect(parseFailure.detail).toMatchObject({
      code: "M4F_CANDIDATE27_HELPER_SMOKE_REJECTED",
      retry_permitted: false,
      target_body_invoked: false,
      cim_executed: false,
    });
    expect(parseError.calls).toHaveLength(2);

    const remote = fixture();
    remote.setRemote(processResult("", "failure", 1));
    expect(failure(() => executeCandidate27(
      remote.config,
      candidate27Confirmation(remote.config, remote.dependencies),
      remote.dependencies,
    )).detail.code).toBe("M4F_CANDIDATE27_REMOTE_FAILED");
    expect(remote.calls).toHaveLength(2);
  });
});
