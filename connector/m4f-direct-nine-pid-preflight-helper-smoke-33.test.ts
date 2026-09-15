import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate33Payload,
  candidate33Confirmation,
  CANDIDATE33_EVIDENCE_DIRECTORY,
  CANDIDATE33_ID,
  Candidate33Failure,
  executeCandidate33,
  planCandidate33,
  validateCandidate33Output,
  type Candidate33Config,
  type Candidate33Dependencies,
} from "./scripts/m4f-direct-nine-pid-preflight-helper-smoke-33.ts";
import {
  CANDIDATE31_HELPERS,
  CANDIDATE31_HELPER_SHA256,
  CANDIDATE31_HELPERS_COMBINED_SHA256,
} from "./scripts/m4f-direct-attempt2-residue-nine-pid-preflight-31.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const X_SHA256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SOURCE = new URL("./scripts/m4f-direct-nine-pid-preflight-helper-smoke-33.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-nine-pid-preflight-helper-smoke-33.test.ts", import.meta.url).pathname;
const C31_SOURCE = new URL("./scripts/m4f-direct-attempt2-residue-nine-pid-preflight-31.ts", import.meta.url).pathname;
const C31_TEST = new URL("./m4f-direct-attempt2-residue-nine-pid-preflight-31.test.ts", import.meta.url).pathname;
const C32_DIRECTORY = "/private/tmp/m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32-evidence";
const C32_MANIFEST = "/private/tmp/m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32-evidence-manifest.json";
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function processResult(stdout: string | Buffer, stderr = "", status: number | null = 0): RawProcessResult {
  return {
    status, signal: null, errorCode: null,
    stdout: Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function success(change?: (value: Record<string, unknown>) => void): Buffer {
  const value: Record<string, unknown> = {
    s: "r33",
    alias_count: 0,
    function_count: 3,
    hash_null: null,
    hash_x: X_SHA256,
    dummy_row: [
      1, 2, "cmd.exe", "2026-08-31T00:00:00.0000000Z", 0,
      "C:\\Windows\\System32\\cmd.exe", true, 3, ABC_SHA256,
    ],
    deep_count: 12,
    deep_pids: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112],
    deep_terminal: "zero",
    deep_terminal_pid: 0,
    missing_count: 0,
    missing_terminal: "missing_parent",
    missing_terminal_pid: 201,
    cycle_count: 1,
    cycle_terminal: "cycle",
    cycle_terminal_pid: 300,
    invalid_count: 1,
    invalid_terminal: "invalid_edge",
    invalid_terminal_pid: 401,
    stdin_length: 0,
  };
  change?.(value);
  return Buffer.from(JSON.stringify(value) + "\r\n");
}

function failure(run: () => unknown): Candidate33Failure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate33Failure);
    return error as Candidate33Failure;
  }
  throw new Error("expected failure");
}

function runnerFixture() {
  const files = new Map<string, Buffer>();
  for (const path of [SOURCE, TEST_SOURCE, C31_SOURCE, C31_TEST, C32_MANIFEST, TRANSPORT_CONFIG]) {
    files.set(path, readFileSync(path));
  }
  const manifest = JSON.parse(files.get(C32_MANIFEST)!.toString("utf8")) as Record<string, string>;
  for (const name of Object.keys(manifest)) files.set(C32_DIRECTORY + "/" + name, readFileSync(C32_DIRECTORY + "/" + name));
  const config: Candidate33Config = {
    schema: "synthia-m4f-direct-nine-pid-preflight-helper-smoke-33-config.v1",
    probe_id: CANDIDATE33_ID,
    evidence_directory: CANDIDATE33_EVIDENCE_DIRECTORY,
    candidate32_evidence_directory: C32_DIRECTORY,
    candidate32_manifest_path: C32_MANIFEST,
    candidate32_manifest_sha256: sha256(files.get(C32_MANIFEST)!),
    candidate32_record_sha256: manifest["probe-record.json"]!,
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_candidate31_source_sha256: sha256(files.get(C31_SOURCE)!),
    expected_candidate31_test_sha256: sha256(files.get(C31_TEST)!),
  };
  const calls: Array<{ args: readonly string[]; stdin: Buffer }> = [];
  const writes = new Map<string, Buffer>();
  let created = false;
  const dependencies: Candidate33Dependencies = {
    read(path) {
      const value = files.get(path);
      if (!value) throw new Error("missing:" + path);
      return Buffer.from(value);
    },
    entries(path) {
      if (path !== C32_DIRECTORY) throw new Error("directory");
      return Object.keys(manifest).sort();
    },
    spawn(_executable, args, stdin) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin) });
      return args[0] === "-G"
        ? processResult(files.get(C32_DIRECTORY + "/ssh-effective-stdout.raw")!)
        : processResult(success());
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== CANDIDATE33_EVIDENCE_DIRECTORY) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-31T02:00:00.000Z"),
  };
  return { config, dependencies, calls, writes };
}

describe("M4-F Candidate 33 exact three-helper runtime smoke", () => {
  test("embeds only the three exact long-name helpers in source order", () => {
    const built = buildCandidate33Payload();
    expect(built.helperScript).toBe(CANDIDATE31_HELPERS.join(";"));
    expect(built.helperHashes).toEqual([...CANDIDATE31_HELPER_SHA256]);
    expect(built.helperCombinedHash).toBe(CANDIDATE31_HELPERS_COMBINED_SHA256);
    expect(built.smokeScript.match(
      /function\s+(?:Get-SynthiaM4f31Sha256|ConvertTo-SynthiaM4f31ProcessRow|Get-SynthiaM4f31AncestorChain)\s*\(/gu,
    )).toHaveLength(3);
    expect(built.smokeScript).not.toMatch(/function\s+[ARH]\s*\(/u);
  });

  test("uses only in-memory dummy graphs and fits the direct command budget", () => {
    const built = buildCandidate33Payload();
    expect(built.command).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive");
    expect(built.command).toEndWith("\"");
    expect(built.command.length).toBeLessThanOrEqual(7_000);
    expect(built.smokeScript).toContain("$DeepMap=@{}");
    expect(built.smokeScript).toContain("$Index -le 12");
    expect(built.smokeScript).toContain("Get-SynthiaM4f31AncestorChain $DeepMap[100] $DeepMap");
    expect(built.smokeScript).not.toMatch(
      /Get-CimInstance|MSFT_NetTCPConnection|Parser|GZip|ScriptBlock|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado|program_hw|Set-Alias|New-Alias|s='r31'|t='snapshot'/iu,
    );
  });

  test("validates hash, row and all four ancestor terminal behaviors", () => {
    expect(validateCandidate33Output(success())).toEqual({
      status: "exact_helpers_runtime_smoked",
      helper_sha256: [...CANDIDATE31_HELPER_SHA256],
      helpers_combined_sha256: CANDIDATE31_HELPERS_COMBINED_SHA256,
      alias_count: 0,
      function_count: 3,
      deep_ancestor_count: 12,
      terminals: ["zero", "missing_parent", "cycle", "invalid_edge"],
      target_body_invoked: false,
      cim_executed: false,
      stdin_length: 0,
      retry_permitted: false,
    });
  });

  test("rejects any dummy/deep/terminal/alias field drift", () => {
    const changes: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.alias_count = 1; },
      (value) => { value.function_count = 2; },
      (value) => { value.hash_x = "0".repeat(64); },
      (value) => { (value.dummy_row as unknown[])[8] = "0".repeat(64); },
      (value) => { value.deep_count = 11; },
      (value) => { value.deep_pids = [101]; },
      (value) => { value.missing_terminal = "zero"; },
      (value) => { value.cycle_terminal_pid = 301; },
      (value) => { value.invalid_count = 0; },
      (value) => { value.stdin_length = 1; },
    ];
    for (const change of changes) {
      expect(failure(() => validateCandidate33Output(success(change))).detail).toMatchObject({
        code: "M4F_CANDIDATE33_HELPER_SMOKE_REJECTED",
        retry_permitted: false,
        target_body_invoked: false,
        cim_executed: false,
        cleanup_performed: false,
      });
    }
  });

  test("rejects invalid UTF-8, missing newline and extra output", () => {
    expect(failure(() => validateCandidate33Output(Buffer.from([0xff]))).detail.code)
      .toBe("M4F_CANDIDATE33_STDOUT_INVALID");
    expect(failure(() => validateCandidate33Output(Buffer.from("{}"))).detail.code)
      .toBe("M4F_CANDIDATE33_STDOUT_INVALID");
    expect(failure(() => validateCandidate33Output(Buffer.concat([success(), Buffer.from("extra\r\n")]))).detail.code)
      .toBe("M4F_CANDIDATE33_STDOUT_INVALID");
  });

  test("runner binds C32 success and performs one effective audit plus one empty-stdin smoke", () => {
    const value = runnerFixture();
    expect(planCandidate33(value.config, value.dependencies)).toMatchObject({
      status: "planned_not_executed",
      helper_definition_count: 3,
      effective_audit_count: 1,
      remote_attempt_count: 1,
      stdin_length: 0,
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
      cleanup_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
    const confirmation = candidate33Confirmation(value.config, value.dependencies);
    expect(executeCandidate33(value.config, confirmation, value.dependencies)).toMatchObject({
      status: "exact_helpers_runtime_smoked",
      target_body_invoked: false,
      cim_executed: false,
      cleanup_performed: false,
      process_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls[1]!.args).toContain("100.96.223.49");
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.has(CANDIDATE33_EVIDENCE_DIRECTORY + "/probe-record.json")).toBe(true);
  });
});
