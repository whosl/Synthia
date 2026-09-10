import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  ATTEMPT1_EVIDENCE_MANIFEST,
  Candidate19RuntimeProbeFailure,
  RUNTIME_PROBE_ID,
  RUNTIME_PROBE_SCRIPT_CONFIG_PATH,
  candidate19RuntimeProbeConfirmation,
  canonicalJsonRuntimeProbe,
  executeCandidate19RuntimeProbe,
  planCandidate19RuntimeProbe,
  type Candidate19RuntimeProbeCapturedFile,
  type Candidate19RuntimeProbeConfig,
  type Candidate19RuntimeProbeDependencies,
  type Candidate19RuntimeProbeFileFact,
} from "./scripts/m4f-direct-six-process-runtime-probe-20.ts";
import type { Candidate19ScriptConfig } from "./scripts/m4f-direct-six-process-cleanup-19.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const OLD_SCRIPT_CONFIG = "/private/tmp/synthia-m4f-direct-six-process-cleanup-prod-20260829-19.json";
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const ATTEMPT1 = "/private/tmp/m4f-direct-six-process-execution-prod-20260829-19-evidence";
const EVIDENCE = "/private/tmp/m4f-direct-six-process-runtime-probe-prod-20260830-20-test-evidence";
const SOURCE = new URL("./scripts/m4f-direct-six-process-runtime-probe-20.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-six-process-runtime-probe-20.test.ts", import.meta.url).pathname;
const C19_SOURCE = new URL("./scripts/m4f-direct-six-process-cleanup-19.ts", import.meta.url).pathname;
const C19_TEST = new URL("./m4f-direct-six-process-cleanup-19.test.ts", import.meta.url).pathname;
const C18_SOURCE = new URL("./scripts/m4f-direct-six-process-parse-only-18.ts", import.meta.url).pathname;
const C18_TEST = new URL("./m4f-direct-six-process-parse-only-18.test.ts", import.meta.url).pathname;
const TRANSPORT_SOURCE = new URL("./scripts/m4f-gate-admission-transport.ts", import.meta.url).pathname;
const EFFECTIVE = ATTEMPT1 + "/ssh-effective-stdout.raw";
const BUSINESS_SHA256 = "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c";
const GZIP_SHA256 = "beb0e6233bdab365c70306a49b7b698104176f8c604f99e9ed28ee015096b924";
const PROBE_SCRIPT_SHA256 = "b0caed671976427e8299079715ab89e135195ff6ce6a86d593e3aaae259f9dd3";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function processResult(
  stdout: string | Buffer,
  stderr: string | Buffer = "",
  status: number | null = 0,
  errorCode: string | null = null,
  signal: NodeJS.Signals | null = null,
): RawProcessResult {
  return {
    status,
    signal,
    errorCode,
    stdout: Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? Buffer.from(stderr) : Buffer.from(stderr),
  };
}

function successStdout(): Buffer {
  return Buffer.from(JSON.stringify({
    s: "c19g2",
    z: "ok",
    e: "Desktop",
    v: "5.1.19041.5608",
    g: "System.IO.Compression.GZipStream",
    h: BUSINESS_SHA256,
    l: 13_856,
    a: "System.Management.Automation.ScriptBlock",
    i: true,
  }) + "\r\n");
}

interface Fixture {
  config: Candidate19RuntimeProbeConfig;
  dependencies: Candidate19RuntimeProbeDependencies;
  files: Map<string, Candidate19RuntimeProbeCapturedFile>;
  calls: Array<{ executable: string; args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  writes: Map<string, Buffer>;
  originalAttemptHashes: Record<string, string>;
  setFile(path: string, bytes: Buffer): void;
  setRemote(result: RawProcessResult): void;
  setTransportDrift(): void;
  setDirectoryEntries(entries: string[]): void;
  failWriteAt(name: string): void;
}

function fixture(): Fixture {
  let inode = 1000;
  const files = new Map<string, Candidate19RuntimeProbeCapturedFile>();
  const addFile = (path: string, bytes: Buffer, mode = 0o600): void => {
    const fact: Candidate19RuntimeProbeFileFact = {
      schema: "synthia-m4f-candidate19-runtime-probe-local-file.v1",
      path,
      device: 1,
      inode: inode++,
      owner_uid: 501,
      mode,
      link_count: 1,
      size: bytes.length,
      mtime_ms: 1,
      ctime_ms: 1,
      sha256: sha256(bytes),
    };
    files.set(path, { bytes: Buffer.from(bytes), fact });
  };
  const addRealFile = (sourcePath: string, exposedPath = sourcePath): void => {
    const bytes = readFileSync(sourcePath);
    const stat = lstatSync(sourcePath);
    files.set(exposedPath, {
      bytes,
      fact: {
        schema: "synthia-m4f-candidate19-runtime-probe-local-file.v1",
        path: exposedPath,
        device: stat.dev,
        inode: stat.ino,
        owner_uid: stat.uid,
        mode: stat.mode & 0o777,
        link_count: 1,
        size: bytes.length,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        sha256: sha256(bytes),
      },
    });
  };
  for (const path of [SOURCE, TEST_SOURCE, C19_SOURCE, C19_TEST, C18_SOURCE, C18_TEST,
    TRANSPORT_SOURCE, TRANSPORT_CONFIG]) addRealFile(path);
  addRealFile(OLD_SCRIPT_CONFIG, RUNTIME_PROBE_SCRIPT_CONFIG_PATH);
  const originalAttemptHashes: Record<string, string> = {};
  for (const name of Object.keys(ATTEMPT1_EVIDENCE_MANIFEST)) {
    const path = ATTEMPT1 + "/" + name;
    addRealFile(path);
    originalAttemptHashes[name] = sha256(files.get(path)!.bytes);
  }

  const scriptConfig = JSON.parse(
    files.get(RUNTIME_PROBE_SCRIPT_CONFIG_PATH)!.bytes.toString(),
  ) as Candidate19ScriptConfig;
  const config: Candidate19RuntimeProbeConfig = {
    schema: "synthia-m4f-candidate19-runtime-probe-config.v1",
    probe_id: RUNTIME_PROBE_ID,
    script_config: structuredClone(scriptConfig),
    script_config_path: RUNTIME_PROBE_SCRIPT_CONFIG_PATH,
    script_config_sha256: sha256(files.get(RUNTIME_PROBE_SCRIPT_CONFIG_PATH)!.bytes) as Candidate19RuntimeProbeConfig["script_config_sha256"],
    transport_config_path: TRANSPORT_CONFIG,
    transport_config_sha256: sha256(files.get(TRANSPORT_CONFIG)!.bytes) as Candidate19RuntimeProbeConfig["transport_config_sha256"],
    attempt1_evidence_directory: ATTEMPT1,
    attempt1_evidence_manifest_sha256: sha256(
      canonicalJsonRuntimeProbe(ATTEMPT1_EVIDENCE_MANIFEST) + "\n",
    ) as Candidate19RuntimeProbeConfig["attempt1_evidence_manifest_sha256"],
    attempt1_failure_sha256: originalAttemptHashes["execution-failure.json"] as Candidate19RuntimeProbeConfig["attempt1_failure_sha256"],
    attempt1_stderr_sha256: originalAttemptHashes["stderr.raw"] as Candidate19RuntimeProbeConfig["attempt1_stderr_sha256"],
    attempt1_remote_process_sha256: originalAttemptHashes["remote-process.json"] as Candidate19RuntimeProbeConfig["attempt1_remote_process_sha256"],
    attempt1_execution_config_sha256: originalAttemptHashes["execution-config.canonical.json"] as Candidate19RuntimeProbeConfig["attempt1_execution_config_sha256"],
    attempt1_plan_sha256: originalAttemptHashes["plan.canonical.json"] as Candidate19RuntimeProbeConfig["attempt1_plan_sha256"],
    expected_c19_source_sha256: sha256(files.get(C19_SOURCE)!.bytes) as Candidate19RuntimeProbeConfig["expected_c19_source_sha256"],
    expected_c19_test_sha256: sha256(files.get(C19_TEST)!.bytes) as Candidate19RuntimeProbeConfig["expected_c19_test_sha256"],
    expected_c18_source_sha256: sha256(files.get(C18_SOURCE)!.bytes) as Candidate19RuntimeProbeConfig["expected_c18_source_sha256"],
    expected_c18_test_sha256: sha256(files.get(C18_TEST)!.bytes) as Candidate19RuntimeProbeConfig["expected_c18_test_sha256"],
    expected_transport_source_sha256: sha256(files.get(TRANSPORT_SOURCE)!.bytes) as Candidate19RuntimeProbeConfig["expected_transport_source_sha256"],
    expected_source_sha256: sha256(files.get(SOURCE)!.bytes),
    expected_test_source_sha256: sha256(files.get(TEST_SOURCE)!.bytes),
    evidence_directory: EVIDENCE,
    effective_timeout_ms: 15_000,
    remote_timeout_ms: 30_000,
  };
  const calls: Fixture["calls"] = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(successStdout());
  let created = false;
  let transportDrift = false;
  let directoryEntries = readdirSync(ATTEMPT1).sort();
  let failWrite = "";
  const dependencies: Candidate19RuntimeProbeDependencies = {
    spawn(executable, args, stdin, timeoutMs) {
      calls.push({ executable, args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G"
        ? processResult(files.get(EFFECTIVE)!.bytes)
        : { ...remote, stdout: Buffer.from(remote.stdout), stderr: Buffer.from(remote.stderr) };
    },
    captureFile(path) {
      const captured = files.get(path);
      if (!captured) throw new Error("missing:" + path);
      return { bytes: Buffer.from(captured.bytes), fact: structuredClone(captured.fact) };
    },
    captureDirectory(path) {
      if (path !== ATTEMPT1) throw new Error("directory");
      return {
        path,
        device: 1,
        inode: 2,
        owner_uid: 501,
        mode: 0o700,
        link_count: 2,
        mtime_ms: 1,
        ctime_ms: 1,
        entries: [...directoryEntries],
      };
    },
    transportInputs: () => [{
      schema: "fixture-transport-input.v1",
      sha256: transportDrift ? "e".repeat(64) : "d".repeat(64),
    }],
    createEvidenceDirectory(path) {
      if (created || path !== config.evidence_directory) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path) || path.endsWith("/" + failWrite)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-30T14:00:00.000Z"),
  };
  return {
    config,
    dependencies,
    files,
    calls,
    writes,
    originalAttemptHashes,
    setFile: addFile,
    setRemote(value) { remote = value; },
    setTransportDrift() { transportDrift = true; },
    setDirectoryEntries(entries) { directoryEntries = [...entries]; },
    failWriteAt(name) { failWrite = name; },
  };
}

function failure(run: () => unknown): Candidate19RuntimeProbeFailure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Candidate19RuntimeProbeFailure);
    return error as Candidate19RuntimeProbeFailure;
  }
  throw new Error("expected failure");
}

function confirmation(value: Fixture): string {
  return candidate19RuntimeProbeConfirmation(value.config, value.dependencies);
}

function execute(value: Fixture, exact = confirmation(value)): Record<string, unknown> {
  return executeCandidate19RuntimeProbe(
    value.config,
    exact,
    value.config.evidence_directory,
    value.dependencies,
  );
}

describe("M4-F Candidate 19 exact runtime probe ceremony", () => {
  test("plans and confirms the exact no-invocation production probe without spawning", () => {
    const value = fixture();
    const plan = planCandidate19RuntimeProbe(value.config, value.dependencies);
    expect(plan).toMatchObject({
      probe_id: RUNTIME_PROBE_ID,
      status: "planned_not_executed",
      topology: "single_ssh_direct_encoded_command_binary_stdin",
      effective_audit_count: 1,
      remote_attempt_count: 1,
      retry_permitted: false,
      probe_command_length: 5034,
      probe_script_sha256: PROBE_SCRIPT_SHA256,
      remote_stdin_length: 4936,
      remote_stdin_sha256: GZIP_SHA256,
      expected_business_length: 13_856,
      expected_business_sha256: BUSINESS_SHA256,
      script_block_created: true,
      target_body_invoked: false,
      business_invocation_permitted: false,
      process_mutation_permitted: false,
      file_mutation_permitted: false,
      vivado_action_permitted: false,
      hardware_action_permitted: false,
    });
    const exact = confirmation(value);
    expect(exact.split(":"))[0]?.toBe("SYNTHIA_M4F_CANDIDATE19_EXACT_RUNTIME_PROBE_ONLY");
    expect(exact.split(":")).toContain(PROBE_SCRIPT_SHA256);
    expect(exact.split(":")).toContain(GZIP_SHA256);
    expect(value.calls).toHaveLength(0);
  });

  test("runs exactly one effective audit and one remote probe with exact binary stdin", () => {
    const value = fixture();
    const record = execute(value);
    expect(record).toMatchObject({
      status: "gzip_constructor_and_decompress_bound",
      attempt: 1,
      script_block_created: true,
      target_body_invoked: false,
      retry_permitted: false,
      cleanup_performed: false,
      process_mutation_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
      probe_result: {
        business_sha256: BUSINESS_SHA256,
        business_length: 13_856,
        target_body_invoked: false,
      },
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls[0]!.stdin).toHaveLength(0);
    expect(value.calls[1]!.stdin).toHaveLength(4936);
    expect(sha256(value.calls[1]!.stdin)).toBe(GZIP_SHA256);
    expect(value.calls[1]!.args.at(-1)).toStartWith("powershell.exe -NoLogo -NoProfile");
    expect(value.writes.has(EVIDENCE + "/probe-record.json")).toBe(true);
    for (const [name, before] of Object.entries(value.originalAttemptHashes)) {
      expect(sha256(value.files.get(ATTEMPT1 + "/" + name)!.bytes)).toBe(before);
    }
  });

  test("requires exact confirmation before any spawn or evidence write", () => {
    const value = fixture();
    const error = failure(() => execute(value, confirmation(value) + "x"));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_RUNTIME_PROBE_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
    expect(value.writes.size).toBe(0);
  });

  test("fails closed on nonempty stderr and cannot make a second remote attempt", () => {
    const value = fixture();
    value.setRemote(processResult(successStdout(), "#< CLIXML progress"));
    const error = failure(() => execute(value));
    expect(error.detail).toMatchObject({
      code: "M4F_CANDIDATE19_RUNTIME_PROBE_STDERR_REJECTED",
      stage: "network",
      retry_permitted: false,
      cleanup_performed: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.writes.get(EVIDENCE + "/stderr.raw")?.toString()).toBe("#< CLIXML progress");
    expect(value.writes.has(EVIDENCE + "/probe-failure.json")).toBe(true);
  });

  test("rejects nonzero, timeout, signal, and malformed stdout without retry", () => {
    const cases: Array<[RawProcessResult, string]> = [
      [processResult("", "failure", 1), "M4F_CANDIDATE19_RUNTIME_PROBE_REMOTE_PROCESS_FAILED"],
      [processResult("", "", null, "ETIMEDOUT"), "M4F_CANDIDATE19_RUNTIME_PROBE_REMOTE_PROCESS_FAILED"],
      [processResult("", "", null, null, "SIGKILL"), "M4F_CANDIDATE19_RUNTIME_PROBE_REMOTE_PROCESS_FAILED"],
      [processResult("{}\r\n"), "M4F_CANDIDATE19_RUNTIME_PROBE_STDOUT_INVALID"],
      [processResult(successStdout().subarray(0, -2)), "M4F_CANDIDATE19_RUNTIME_PROBE_STDOUT_INVALID"],
    ];
    for (const [remote, code] of cases) {
      const value = fixture();
      value.setRemote(remote);
      const error = failure(() => execute(value));
      expect(error.detail.code).toBe(code);
      expect(error.detail.retry_permitted).toBe(false);
      expect(value.calls).toHaveLength(2);
    }
  });

  test("rejects source, ScriptConfig, attempt1, and directory drift before spawn", () => {
    const mutations: Array<(value: Fixture) => void> = [
      (value) => value.setFile(SOURCE, Buffer.from("source drift")),
      (value) => value.setFile(TEST_SOURCE, Buffer.from("test drift")),
      (value) => value.setFile(RUNTIME_PROBE_SCRIPT_CONFIG_PATH, Buffer.from("{}\n")),
      (value) => value.setFile(ATTEMPT1 + "/execution-failure.json", Buffer.from("{}\n")),
      (value) => value.setFile(ATTEMPT1 + "/stderr.raw", Buffer.from("stderr drift")),
      (value) => value.setDirectoryEntries([...Object.keys(ATTEMPT1_EVIDENCE_MANIFEST), "extra"]),
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      const error = failure(() => planCandidate19RuntimeProbe(value.config, value.dependencies));
      expect(String(error.detail.code)).toStartWith("M4F_CANDIDATE19_RUNTIME_PROBE_");
      expect(value.calls).toHaveLength(0);
    }
  });

  test("rejects config and transport drift, preserving the single remote-attempt ceiling", () => {
    const invalid = fixture();
    const changed = structuredClone(invalid.config) as Record<string, unknown>;
    changed.remote_timeout_ms = 30_001;
    expect(failure(() => planCandidate19RuntimeProbe(changed, invalid.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE19_RUNTIME_PROBE_CONFIG_INVALID");
    expect(invalid.calls).toHaveLength(0);

    const drift = fixture();
    const original = drift.dependencies.spawn;
    drift.dependencies.spawn = (executable, args, stdin, timeoutMs) => {
      const result = original(executable, args, stdin, timeoutMs);
      if (args[0] === "-G") drift.setTransportDrift();
      return result;
    };
    const error = failure(() => execute(drift));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_RUNTIME_PROBE_INPUT_DRIFT");
    expect(drift.calls).toHaveLength(1);
  });

  test("evidence write failure is fail-closed and never reaches the remote probe", () => {
    const value = fixture();
    value.failWriteAt("remote-command.json");
    const error = failure(() => execute(value));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_RUNTIME_PROBE_EVIDENCE_WRITE_FAILED");
    expect(value.calls).toHaveLength(0);
  });

  test("ceremony source contains no business invocation, CIM, kill, Vivado, or hardware action", () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).not.toMatch(/Invoke-Expression|\.Invoke\s*\(|Stop-Process|Get-CimInstance|\.Kill\s*\(/u);
    expect(source).not.toContain("vivado.bat");
    expect(source).not.toMatch(/program_hw_devices|open_hw_target|write_bitstream/iu);
    expect(source).toContain("target_body_invoked: false");
    expect(source).toContain("retry_permitted: false");
  });
});
