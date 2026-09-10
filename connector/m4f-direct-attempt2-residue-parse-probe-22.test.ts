import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CANDIDATE22_EVIDENCE_DIRECTORY,
  CANDIDATE22_ID,
  Candidate22Failure,
  buildCandidate22Payload,
  candidate22Confirmation,
  executeCandidate22,
  planCandidate22,
  type Candidate22Config,
  type Candidate22Dependencies,
} from "./scripts/m4f-direct-attempt2-residue-parse-probe-22.ts";
import type { ResidueInventoryConfig } from "./scripts/m4f-direct-attempt2-residue-inventory-21.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-parse-probe-22.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-attempt2-residue-parse-probe-22.test.ts", import.meta.url).pathname;
const INVENTORY_SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url).pathname;
const INVENTORY_TEST = new URL("./m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url).pathname;
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const FAILED_EVIDENCE = "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-21-evidence";
const INVENTORY_CONFIG = FAILED_EVIDENCE + "/inventory-config.canonical.json";
const EFFECTIVE = FAILED_EVIDENCE + "/ssh-effective-stdout.raw";
const REMOTE_PROCESS = FAILED_EVIDENCE + "/remote-process.json";
const STDERR = FAILED_EVIDENCE + "/stderr.raw";
const EMPTY_SHA256_BASE64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
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
  for (const path of [SOURCE, TEST_SOURCE, INVENTORY_SOURCE, INVENTORY_TEST, TRANSPORT_CONFIG,
    INVENTORY_CONFIG, EFFECTIVE, REMOTE_PROCESS, STDERR]) files.set(path, readFileSync(path));
  const inventoryConfig = JSON.parse(files.get(INVENTORY_CONFIG)!.toString("utf8")) as ResidueInventoryConfig;
  const payload = buildCandidate22Payload(inventoryConfig);
  const success = Buffer.from([
    "r22", payload.targetHashBase64, payload.targetLength, 0, EMPTY_SHA256_BASE64, "ScriptBlockAst",
  ].join("|") + "\r\n");
  const config: Candidate22Config = {
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-config.v1",
    probe_id: CANDIDATE22_ID,
    evidence_directory: CANDIDATE22_EVIDENCE_DIRECTORY,
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_inventory_source_sha256: sha256(files.get(INVENTORY_SOURCE)!),
    expected_inventory_test_sha256: sha256(files.get(INVENTORY_TEST)!),
  };
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }> = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(success);
  let created = false;
  const dependencies: Candidate22Dependencies = {
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    spawn(_executable, args, stdin, timeoutMs) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(files.get(EFFECTIVE)!) : remote;
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== CANDIDATE22_EVIDENCE_DIRECTORY) throw new Error("create");
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

function failure(run: () => unknown): Candidate22Failure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate22Failure);
    return error as Candidate22Failure;
  }
  throw new Error("expected failure");
}

describe("M4-F Candidate 22 exact inventory parse probe", () => {
  test("embeds the corrected exact script and only parses it", () => {
    const value = fixture();
    expect(value.payload.command.length).toBeLessThanOrEqual(7_000);
    expect(value.payload.targetScript).toContain("foreach ($p in $a)");
    expect(value.payload.targetScript).toContain("$i -lt 8 -and $q");
    expect(value.payload.targetScript).toContain("D:\\softwares\\Nodejs\\node.exe");
    expect(value.payload.targetScript).not.toMatch(/foreach\s*\(\$p in\$|\$i-lt|\$q\.Name-cieq/u);
    expect(value.payload.loader.match(/Parser\]::ParseInput/gu)).toHaveLength(1);
    expect(value.payload.loader).not.toMatch(/ScriptBlock\]::Create|Invoke-Expression|Get-CimInstance|Stop-Process|Vivado|program_hw/iu);
  });

  test("plans without network and freezes empty stdin plus one attempt", () => {
    const value = fixture();
    expect(planCandidate22(value.config, value.dependencies)).toMatchObject({
      status: "planned_not_executed",
      parser_call_count: 1,
      remote_attempt_count: 1,
      stdin_length: 0,
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
  });

  test("runs one effective audit and one empty-stdin parse probe", () => {
    const value = fixture();
    const exact = candidate22Confirmation(value.config, value.dependencies);
    expect(executeCandidate22(value.config, exact, value.dependencies)).toMatchObject({
      status: "parsed_not_invoked",
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.has(CANDIDATE22_EVIDENCE_DIRECTORY + "/probe-record.json")).toBe(true);
  });

  test("wrong confirmation fails before any spawn", () => {
    const value = fixture();
    const exact = candidate22Confirmation(value.config, value.dependencies);
    expect(failure(() => executeCandidate22(value.config, exact + "x", value.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE22_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
  });

  test("parse errors and remote failures are terminal and never retried", () => {
    const parseError = fixture();
    parseError.setRemote(processResult([
      "r22", parseError.payload.targetHashBase64, parseError.payload.targetLength, 1,
      "uKq9pQ9h1q5hWrYzv2lf7M5YnnrM1V4hn6T3B2JwW8s=", "ScriptBlockAst",
    ].join("|") + "\r\n"));
    const parseFailure = failure(() => executeCandidate22(
      parseError.config,
      candidate22Confirmation(parseError.config, parseError.dependencies),
      parseError.dependencies,
    ));
    expect(parseFailure.detail).toMatchObject({
      code: "M4F_CANDIDATE22_PARSE_REJECTED",
      retry_permitted: false,
      target_body_invoked: false,
      cim_executed: false,
    });
    expect(parseError.calls).toHaveLength(2);

    const remote = fixture();
    remote.setRemote(processResult("", "failure", 1));
    expect(failure(() => executeCandidate22(
      remote.config,
      candidate22Confirmation(remote.config, remote.dependencies),
      remote.dependencies,
    )).detail.code).toBe("M4F_CANDIDATE22_REMOTE_FAILED");
    expect(remote.calls).toHaveLength(2);
  });
});
