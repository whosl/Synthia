import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate32Payload,
  candidate32Confirmation,
  CANDIDATE32_EVIDENCE_DIRECTORY,
  CANDIDATE32_ID,
  Candidate32Failure,
  executeCandidate32,
  planCandidate32,
  validateCandidate32Config,
  type Candidate32Config,
  type Candidate32Dependencies,
} from "./scripts/m4f-direct-nine-pid-preflight-parse-only-32.ts";
import {
  buildCandidate31Script,
  CANDIDATE17_EVIDENCE_DIRECTORY,
  CANDIDATE17_MANIFEST,
  CANDIDATE17_MANIFEST_SHA256,
  CANDIDATE30_EVIDENCE_DIRECTORY,
  CANDIDATE30_MANIFEST,
  CANDIDATE30_MANIFEST_SHA256,
  CANDIDATE30_RECORD_SHA256,
} from "./scripts/m4f-direct-attempt2-residue-nine-pid-preflight-31.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SOURCE = new URL("./scripts/m4f-direct-nine-pid-preflight-parse-only-32.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-nine-pid-preflight-parse-only-32.test.ts", import.meta.url).pathname;
const CANDIDATE31_SOURCE = new URL(
  "./scripts/m4f-direct-attempt2-residue-nine-pid-preflight-31.ts", import.meta.url,
).pathname;
const CANDIDATE31_TEST = new URL(
  "./m4f-direct-attempt2-residue-nine-pid-preflight-31.test.ts", import.meta.url,
).pathname;
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const EFFECTIVE = CANDIDATE30_EVIDENCE_DIRECTORY + "/ssh-effective-stdout.raw";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function processResult(
  stdout: string | Buffer,
  stderr: string | Buffer = "",
  status: number | null = 0,
  errorCode: string | null = null,
): RawProcessResult {
  return {
    status, signal: null, errorCode,
    stdout: Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? Buffer.from(stderr) : Buffer.from(stderr),
  };
}

function fixture() {
  const files = new Map<string, Buffer>();
  for (const path of [SOURCE, TEST_SOURCE, CANDIDATE31_SOURCE, CANDIDATE31_TEST, TRANSPORT_CONFIG]) {
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE30_MANIFEST)) {
    const path = CANDIDATE30_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  for (const name of Object.keys(CANDIDATE17_MANIFEST)) {
    const path = CANDIDATE17_EVIDENCE_DIRECTORY + "/" + name;
    files.set(path, readFileSync(path));
  }
  const built = buildCandidate32Payload();
  const success = processResult([
    "r32", built.targetLength, 0, "ScriptBlockAst", "True", built.targetHash,
  ].join("|") + "\r\n");
  const config: Candidate32Config = {
    schema: "synthia-m4f-direct-nine-pid-preflight-parse-only-32-config.v1",
    probe_id: CANDIDATE32_ID,
    evidence_directory: CANDIDATE32_EVIDENCE_DIRECTORY,
    candidate30_evidence_directory: CANDIDATE30_EVIDENCE_DIRECTORY,
    candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
    candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
    candidate17_evidence_directory: CANDIDATE17_EVIDENCE_DIRECTORY,
    candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_sha256: sha256(files.get(TEST_SOURCE)!),
    expected_candidate31_source_sha256: sha256(files.get(CANDIDATE31_SOURCE)!),
    expected_candidate31_test_sha256: sha256(files.get(CANDIDATE31_TEST)!),
  };
  const calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }> = [];
  const writes = new Map<string, Buffer>();
  let remote = success;
  let created = false;
  const dependencies: Candidate32Dependencies = {
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    entries(path) {
      if (path === CANDIDATE30_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE30_MANIFEST).sort();
      if (path === CANDIDATE17_EVIDENCE_DIRECTORY) return Object.keys(CANDIDATE17_MANIFEST).sort();
      throw new Error("directory");
    },
    spawn(_executable, args, stdin, timeoutMs) {
      calls.push({ args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G" ? processResult(files.get(EFFECTIVE)!) : remote;
    },
    transportInputs: () => [{ sha256: "a".repeat(64) }],
    createEvidence(path) {
      if (created || path !== CANDIDATE32_EVIDENCE_DIRECTORY) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-31T01:00:00.000Z"),
  };
  return {
    built, config, dependencies, calls, writes,
    setRemote(value: RawProcessResult) { remote = value; },
  };
}

function failure(run: () => unknown): Candidate32Failure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate32Failure);
    return error as Candidate32Failure;
  }
  throw new Error("expected failure");
}

describe("M4-F Candidate 32 exact Candidate31 parse-only", () => {
  test("gzip-binds the exact Candidate31 target and invokes Parser.ParseInput only", () => {
    const value = fixture();
    expect(value.built.targetScript).toBe(buildCandidate31Script());
    expect(value.built.targetHash).toBe(sha256(Buffer.from(buildCandidate31Script(), "utf8")));
    expect(value.built.command.length).toBeLessThanOrEqual(7_000);
    expect(value.built.command).toStartWith("powershell.exe -NoLogo -NoProfile -NonInteractive");
    expect(value.built.command).toEndWith("\"");
    expect(value.built.loader).toContain("[IO.Compression.CompressionMode]::Decompress");
    expect(value.built.loader.match(/Parser\]::ParseInput/gu)).toHaveLength(1);
    expect(value.built.loader).not.toMatch(
      /ScriptBlock\]::Create|Invoke-Expression|Get-CimInstance|MSFT_NetTCPConnection|Stop-Process|Vivado|program_hw|&\s*\$Target/iu,
    );
    expect(value.built.targetScript).toContain("Get-CimInstance Win32_Process");
  });

  test("uses strict config and binds Candidate30 plus Candidate31 source and test", () => {
    const value = fixture();
    expect(validateCandidate32Config(value.config)).toEqual(value.config);
    expect(() => validateCandidate32Config({ ...value.config, unexpected_key: true }))
      .toThrow("M4F_CANDIDATE32_CONFIG_INVALID");
    expect(planCandidate32(value.config, value.dependencies)).toMatchObject({
      status: "planned_not_executed",
      candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
      candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
      candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
      candidate31_source_sha256: value.config.expected_candidate31_source_sha256,
      candidate31_test_sha256: value.config.expected_candidate31_test_sha256,
      parser_call_count: 1,
      effective_audit_count: 1,
      remote_attempt_count: 1,
      stdin_length: 0,
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
      cleanup_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
  });

  test("records one effective audit and one empty-stdin parse-only attempt", () => {
    const value = fixture();
    const confirmation = candidate32Confirmation(value.config, value.dependencies);
    expect(executeCandidate32(value.config, confirmation, value.dependencies)).toMatchObject({
      status: "exact_target_parse_zero",
      parse_result: {
        target_script_sha256: value.built.targetHash,
        target_script_length: value.built.targetLength,
        parse_error_count: 0,
        ast_type: "ScriptBlockAst",
        end_block_present: true,
        target_body_invoked: false,
        cim_executed: false,
        stdin_length: 0,
      },
      target_body_invoked: false,
      cim_executed: false,
      retry_permitted: false,
      cleanup_performed: false,
      process_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls[1]!.args).toContain("100.96.223.49");
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.has(CANDIDATE32_EVIDENCE_DIRECTORY + "/parser-loader.ps1")).toBe(true);
    expect(value.writes.has(CANDIDATE32_EVIDENCE_DIRECTORY + "/probe-record.json")).toBe(true);
  });

  test("rejects parse errors, wrong hashes and extra output without retry", () => {
    const cases = [
      "r32|1|1|ScriptBlockAst|True|" + "0".repeat(64) + "\r\n",
      "r32|1|0|ScriptBlockAst|True|" + "0".repeat(64) + "\r\n",
      "r32|1|0|ScriptBlockAst|True|" + "0".repeat(64) + "\r\nextra\r\n",
    ];
    for (const stdout of cases) {
      const value = fixture();
      value.setRemote(processResult(stdout));
      const confirmation = candidate32Confirmation(value.config, value.dependencies);
      expect(failure(() => executeCandidate32(value.config, confirmation, value.dependencies)).detail)
        .toMatchObject({ retry_permitted: false, target_body_invoked: false, cim_executed: false });
      expect(value.calls).toHaveLength(2);
    }
  });

  test("wrong confirmation and input drift fail before network; remote errors are terminal", () => {
    const wrong = fixture();
    expect(failure(() => executeCandidate32(wrong.config, "wrong", wrong.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE32_CONFIRMATION_REQUIRED");
    expect(wrong.calls).toHaveLength(0);

    const drift = fixture();
    drift.config.expected_candidate31_test_sha256 = "0".repeat(64);
    expect(failure(() => planCandidate32(drift.config, drift.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE32_INPUT_DRIFT");
    expect(drift.calls).toHaveLength(0);

    const remote = fixture();
    remote.setRemote(processResult("", "failed", 1));
    const confirmation = candidate32Confirmation(remote.config, remote.dependencies);
    expect(failure(() => executeCandidate32(remote.config, confirmation, remote.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE32_REMOTE_FAILED");
    expect(remote.calls).toHaveLength(2);
  });
});
