import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate18Payload,
  candidate18Confirmation,
  executeCandidate18,
  lintCandidate18Loader,
  planCandidate18,
  planCandidate18Envelope,
  validateCandidate18Result,
  validateCandidate18OuterInput,
  type Candidate18Config,
  type Candidate18CapturedFile,
  type Candidate18Dependencies,
  type Candidate18Payload,
} from "./scripts/m4f-direct-six-process-parse-only-18.ts";
import {
  buildCandidate19Payload,
  CANDIDATE19_LISTENERS,
  CANDIDATE19_TARGETS,
  CANDIDATE19_WORKER,
  type Candidate19ScriptConfig,
} from "./scripts/m4f-direct-six-process-cleanup-19.ts";
import { admission, effective, processResult } from "./m4f-direct-residue-ownership-16-17-fixture.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const C19_SOURCE_SHA256 = "17575ea5c61199697bd83b44fc9b6e7c6fbe4cb732341de4644eeae278cbf964";
const C19_TEST_SHA256 = "a61c2f18345afd2d06ca5352208538d1a4f4202573deb232babfbc301e7b8afb";
const C19_DOC_SHA256 = "27eeaafc8d9e099fb766b40c89d7785750231bc0d793d935c314bddd9b5417e8";
const TRANSPORT_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const ADJUDICATION_PATH = "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-progress-adjudication-record.json";
const ADJUDICATION_REVIEW_PATH = "/private/tmp/synthia-m4f-direct-residue-ownership-candidate17-progress-adjudication-evidence-review-record.json";
const ADMISSION_PATH = "/private/tmp/synthia-m4f-direct-admission-v2-prod-20260828-03-evidence/admission-v2-record.json";
const ADMISSION_REVIEW_PATH = "/private/tmp/synthia-m4f-direct-admission-v2-prod-20260828-03-protection-baseline-review-record.json";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function captured(path: string, bytes: Buffer): Candidate18CapturedFile {
  return {
    bytes: Buffer.from(bytes),
    fact: {
      schema: "synthia-m4f-candidate18-local-file.v1",
      path,
      device: 1,
      inode: [...Buffer.from(path)].reduce((sum, item) => sum + item, 1),
      owner_uid: 501,
      mode: 0o600,
      link_count: 1,
      size: bytes.length,
      mtime_ms: 1,
      ctime_ms: 1,
      sha256: hash(bytes),
    },
  };
}

function targetConfig(): Candidate19ScriptConfig {
  return {
    schema: "synthia-m4f-candidate19-script-config.v1",
    cleanup_id: "candidate19-for-parse-18",
    target_computer: "DESKTOP-DVFFB09",
    target_identity_name: "desktop-dvffb09\\admin",
    target_identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001",
    adjudication_record_path: ADJUDICATION_PATH,
    adjudication_record_sha256: "f575dae6bafa812de57cf3d82d1b920ec96bc74e6c7ad2e0fedbac018b27f3a7",
    adjudication_review_path: ADJUDICATION_REVIEW_PATH,
    adjudication_review_sha256: "9cd47bff11c7c8c635c23411cd5d966079b6387c69e3139e8c2a47e85d303447",
    observation_semantic_sha256: "269ac2c43af54fee3c7aa1e9d49e1848bb8bf310f10a3165182f7b6773e6f1b3",
    admission_record_path: ADMISSION_PATH,
    admission_record_sha256: "856edffdde9094c95e76aba062b8919c47b44cdeaae60a388cba11b3f7b5657e",
    admission_review_path: ADMISSION_REVIEW_PATH,
    admission_review_sha256: "4628ad24fb22fedf4d3989ec9482be79ea3316a18b3b76b3a52328d61c369150",
    targets: structuredClone(CANDIDATE19_TARGETS),
    protected_worker: structuredClone(CANDIDATE19_WORKER),
    protected_listeners: structuredClone(CANDIDATE19_LISTENERS),
    effect_wait_ms: 5_000,
    remote_deadline_seconds: 35,
    expected_source_sha256: C19_SOURCE_SHA256,
    expected_test_source_sha256: C19_TEST_SHA256,
    expected_transport_source_sha256: TRANSPORT_SHA256,
  };
}

interface Setup {
  config: Candidate18Config;
  target: Candidate19ScriptConfig;
  dependencies: Candidate18Dependencies;
  calls: Array<{ args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  setRemote(result: RawProcessResult): void;
}

function setup(): Setup {
  const target = targetConfig();
  const targetBytes = Buffer.from(JSON.stringify(target));
  const transportBytes = Buffer.from(JSON.stringify(admission));
  const source = Buffer.from("candidate18-source");
  const testSource = Buffer.from("candidate18-test");
  const c19Source = readFileSync(new URL("./scripts/m4f-direct-six-process-cleanup-19.ts", import.meta.url));
  const c19Test = readFileSync(new URL("./m4f-direct-six-process-cleanup-19.test.ts", import.meta.url));
  const c19Doc = readFileSync(new URL("./M4F-DIRECT-SIX-PROCESS-CLEANUP-18-19.md", import.meta.url));
  const transportSource = readFileSync(new URL("./scripts/m4f-gate-admission-transport.ts", import.meta.url));
  const adjudication = readFileSync(ADJUDICATION_PATH);
  const adjudicationReview = readFileSync(ADJUDICATION_REVIEW_PATH);
  const admissionRecord = readFileSync(ADMISSION_PATH);
  const admissionReview = readFileSync(ADMISSION_REVIEW_PATH);
  expect(hash(c19Source)).toBe(C19_SOURCE_SHA256);
  expect(hash(c19Test)).toBe(C19_TEST_SHA256);
  expect(hash(c19Doc)).toBe(C19_DOC_SHA256);
  expect(hash(transportSource)).toBe(TRANSPORT_SHA256);
  expect(hash(adjudication)).toBe(target.adjudication_record_sha256);
  expect(hash(adjudicationReview)).toBe(target.adjudication_review_sha256);
  expect(hash(admissionRecord)).toBe(target.admission_record_sha256);
  expect(hash(admissionReview)).toBe(target.admission_review_sha256);
  const config: Candidate18Config = {
    schema: "synthia-m4f-candidate18-parse-only-config.v1",
    parse_id: "candidate18-test",
    candidate19_script_config_path: "/tmp/c19-script.json",
    candidate19_script_config_sha256: hash(targetBytes),
    transport_config_path: "/tmp/direct-transport.json",
    transport_config_sha256: hash(transportBytes),
    evidence_directory: "/tmp/c18-evidence",
    expected_source_sha256: hash(source),
    expected_test_source_sha256: hash(testSource),
    expected_candidate19_source_sha256: C19_SOURCE_SHA256,
    expected_candidate19_test_source_sha256: C19_TEST_SHA256,
    expected_candidate19_doc_sha256: C19_DOC_SHA256,
    expected_transport_source_sha256: TRANSPORT_SHA256,
  };
  const frozen = new Map([
    [config.candidate19_script_config_path, targetBytes],
    [config.transport_config_path, transportBytes],
    [target.adjudication_record_path, adjudication],
    [target.adjudication_review_path, adjudicationReview],
    [target.admission_record_path, admissionRecord],
    [target.admission_review_path, admissionReview],
  ]);
  const calls: Setup["calls"] = [];
  let remote = processResult("");
  const dependencies: Candidate18Dependencies = {
    spawn(_executable, args, stdin, timeoutMs) {
      calls.push({ args, stdin: Buffer.from(stdin), timeoutMs });
      return calls.length === 1 ? processResult(effective) : remote;
    },
    captureFile(path) {
      const value = frozen.get(path);
      if (!value) throw new Error("missing frozen input");
      return captured(path, value);
    },
    sourceFile: () => captured("/repo/c18.ts", source),
    testSourceFile: () => captured("/repo/c18.test.ts", testSource),
    candidate19SourceFile: () => captured("/repo/c19.ts", c19Source),
    candidate19TestSourceFile: () => captured("/repo/c19.test.ts", c19Test),
    candidate19DocFile: () => captured("/repo/c19.md", c19Doc),
    transportSourceFile: () => captured("/repo/transport.ts", transportSource),
    transportInputs: () => [],
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  };
  return { config, target, dependencies, calls, setRemote: (value) => { remote = value; } };
}

function result(payload: Candidate18Payload, mutate?: (value: Record<string, unknown>) => void): Buffer {
  const target = (hashValue: string, length: number) => ({
    h: hashValue,
    l: length,
    c: 0,
    a: "System.Management.Automation.Language.ScriptBlockAst",
    n: true,
    i: true,
  });
  const value: Record<string, unknown> = {
    s: "c18p1",
    z: "ok",
    i: payload.input_sha256,
    l: payload.input.length,
    e: "Desktop",
    v: "5.1.19041.5608",
    b: target(payload.business_script_sha256, payload.business_script_utf8_length),
    o: target(payload.outer_loader_sha256, payload.outer_loader_utf8_length),
  };
  mutate?.(value);
  return Buffer.from(JSON.stringify(value) + "\r\n");
}

describe("M4-F Candidate 18 dual WinPS 5.1 parse-only gate", () => {
  test("builds one bounded command that only parses both exact stdin targets", () => {
    const value = setup();
    const payload = buildCandidate18Payload(value.target);
    expect(payload.command.length).toBeLessThanOrEqual(7_000);
    expect(payload.command.length).toBeLessThanOrEqual(8_191);
    expect(payload.input).toEqual(Buffer.from(payload.input.toString("ascii"), "ascii"));
    expect(payload.input.toString("utf8")).toBe(buildCandidate19Payload(value.target).outer_loader);
    expect(payload.input.toString("utf8")).not.toContain(",0)");
    expect(payload.input.toString("utf8")).toContain(
      "[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress)",
    );
    expect(payload.input.at(-1)).not.toBe(0x0a);
    const encoded = payload.command.split(" -EncodedCommand ")[1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(payload.loader);
    expect(payload.loader.match(/\[Management\.Automation\.Language\.Parser\]::ParseInput/gu)).toHaveLength(2);
    for (const forbidden of [
      "ScriptBlock]::Create", "Invoke-Expression", "&", ".Kill(", "Stop-Process", "Get-Process",
      "Get-CimInstance", "Get-CimClass", "MSFT_NetTCPConnection", "Win32_Process", "Vivado",
      "Set-Content", "Out-File", "New-Item", "[IO.File]",
    ]) expect(payload.loader).not.toContain(forbidden);
    expect(payload.loader).toContain("function Get-SynC18Hash");
    expect(payload.loader).not.toContain(",0)");
    expect(payload.loader).toContain(
      "[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress)",
    );
    expect(payload.loader).not.toMatch(/function\s+(?:h|hash|sha|sha256)\b/iu);
    expect(() => lintCandidate18Loader(payload.loader)).not.toThrow();
    const longest = targetConfig();
    longest.cleanup_id = "a".repeat(96);
    expect(buildCandidate18Payload(longest).command.length).toBeLessThanOrEqual(7_000);
  });

  test("binds outer to its one canonical gzip and strictly decoded business script", () => {
    const value = setup();
    const payload = buildCandidate18Payload(value.target);
    expect(() => validateCandidate18OuterInput(payload.input, value.target)).not.toThrow();
    const mutations = [
      Buffer.concat([Buffer.from("x"), payload.input.subarray(1)]),
      Buffer.concat([payload.input.subarray(0, -1), Buffer.from("x")]),
      Buffer.concat([payload.input, payload.input]),
      Buffer.concat([payload.input.subarray(0, 80), Buffer.from("!"), payload.input.subarray(81)]),
      payload.input.subarray(0, -1),
      Buffer.concat([payload.input, Buffer.from("=")]),
    ];
    for (const mutation of mutations) {
      expect(() => validateCandidate18OuterInput(mutation, value.target))
        .toThrow("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
    }
    const changed = structuredClone(value.target);
    changed.cleanup_id = "candidate19-for-parse-18-drift";
    expect(() => validateCandidate18OuterInput(payload.input, changed))
      .toThrow("M4F_CANDIDATE18_OUTER_INPUT_INVALID");
  });

  test("rejects forbidden wrapper primitives and all frozen lineage drift", () => {
    for (const value of [
      "[ScriptBlock]::Create('x')",
      "Invoke-Expression 'x'",
      "& $x",
      "$p.Kill()",
      "Get-CimInstance Win32_Process",
      "Set-Content x y",
    ]) expect(() => lintCandidate18Loader(value)).toThrow("M4F_CANDIDATE18_LOADER_INVALID");
    const cases = [
      (value: Setup) => { value.config.expected_candidate19_source_sha256 = "0".repeat(64) as never; },
      (value: Setup) => { value.config.expected_candidate19_doc_sha256 = "0".repeat(64) as never; },
      (value: Setup) => { value.config.expected_transport_source_sha256 = "0".repeat(64) as never; },
      (value: Setup) => { value.config.candidate19_script_config_sha256 = "0".repeat(64); },
    ];
    for (const change of cases) {
      const value = setup();
      change(value);
      expect(() => planCandidate18(value.config, value.dependencies)).toThrow();
    }
    for (const lineagePath of [
      ADJUDICATION_PATH, ADJUDICATION_REVIEW_PATH, ADMISSION_PATH, ADMISSION_REVIEW_PATH,
    ]) {
      const missing = setup();
      const captureMissing = missing.dependencies.captureFile;
      missing.dependencies.captureFile = (path) => {
        if (path === lineagePath) throw new Error("missing");
        return captureMissing(path);
      };
      expect(() => planCandidate18(missing.config, missing.dependencies)).toThrow();
      const drift = setup();
      const captureDrift = drift.dependencies.captureFile;
      drift.dependencies.captureFile = (path) => {
        const value = captureDrift(path);
        return path === lineagePath ? captured(path, Buffer.concat([value.bytes, Buffer.from("x")])) : value;
      };
      expect(() => planCandidate18(drift.config, drift.dependencies)).toThrow();
    }
  });

  test("plans an inert two-target ceremony and binds its exact confirmation", () => {
    const value = setup();
    const plan = planCandidate18(value.config, value.dependencies);
    const envelope = planCandidate18Envelope(value.config, value.dependencies);
    expect(plan).toMatchObject({
      status: "planned_not_executed",
      target_host: "100.96.223.49",
      parse_target_count: 2,
      parser_required: "Windows PowerShell Desktop 5.1",
      business_target_body_not_invoked: true,
      outer_loader_target_body_not_invoked: true,
      network_attempted: false,
      process_mutation_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
      cleanup_performed: false,
      retry_permitted: false,
    });
    expect(Number(plan.input_length)).toBeGreaterThan(6_000);
    expect(Number(plan.command_length)).toBeLessThanOrEqual(7_000);
    expect(envelope.confirmation).toBe(candidate18Confirmation(value.config, value.dependencies));
  });

  test("strictly validates both independent zero-error ScriptBlockAst results", () => {
    const value = setup();
    const payload = buildCandidate18Payload(value.target);
    expect(validateCandidate18Result(result(payload), payload).status).toBe("parsed_not_invoked");
    const mutations = [
      (output: Record<string, unknown>) => { (output.b as Record<string, unknown>).c = 1; },
      (output: Record<string, unknown>) => { (output.o as Record<string, unknown>).n = false; },
      (output: Record<string, unknown>) => { (output.b as Record<string, unknown>).a = "Ast"; },
      (output: Record<string, unknown>) => { (output.o as Record<string, unknown>).i = false; },
      (output: Record<string, unknown>) => { output.i = "0".repeat(64); },
      (output: Record<string, unknown>) => { output.e = "Core"; },
    ];
    for (const mutate of mutations) {
      expect(() => validateCandidate18Result(result(payload, mutate), payload))
        .toThrow("M4F_CANDIDATE18_OUTPUT_INVALID");
    }
    expect(() => validateCandidate18Result(Buffer.concat([result(payload), Buffer.from("tail")]), payload))
      .toThrow("M4F_CANDIDATE18_OUTPUT_INVALID");
  });

  test("executes exactly one effective audit and one stdin parse-only attempt", () => {
    const value = setup();
    const payload = buildCandidate18Payload(value.target);
    value.setRemote(processResult(result(payload)));
    const directory = mkdtempSync(join(tmpdir(), "synthia-c18-"));
    rmSync(directory, { recursive: true });
    value.config.evidence_directory = directory;
    try {
      const confirmation = candidate18Confirmation(value.config, value.dependencies);
      const record = executeCandidate18(
        value.config, confirmation, directory, value.dependencies,
      );
      expect(record).toMatchObject({
        status: "parsed_not_invoked",
        attempt: 1,
        business_target_body_not_invoked: true,
        outer_loader_target_body_not_invoked: true,
        process_mutation_performed: false,
        file_mutation_performed: false,
        vivado_action_performed: false,
        hardware_action_performed: false,
        cleanup_performed: false,
        retry_permitted: false,
      });
      expect(value.calls).toHaveLength(2);
      expect(value.calls[0]!.stdin).toHaveLength(0);
      expect(value.calls[1]!.stdin).toEqual(payload.input);
      expect(value.calls[1]!.args.at(-1)).toBe(payload.command);
      expect(readFileSync(directory + "/target-business-script.ps1", "utf8"))
        .toBe(buildCandidate19Payload(value.target).business_script);
      expect(readFileSync(directory + "/target-outer-loader.ps1", "utf8"))
        .toBe(payload.input.toString("utf8"));
      expect(readFileSync(directory + "/confirmation.sha256", "utf8")).toBe(hash(confirmation) + "\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on transport ambiguity without claiming either target invocation", () => {
    const value = setup();
    value.setRemote({
      status: null,
      signal: "SIGKILL",
      errorCode: "ETIMEDOUT",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const directory = mkdtempSync(join(tmpdir(), "synthia-c18-fail-"));
    rmSync(directory, { recursive: true });
    value.config.evidence_directory = directory;
    try {
      expect(() => executeCandidate18(
        value.config,
        candidate18Confirmation(value.config, value.dependencies),
        directory,
        value.dependencies,
      )).toThrow("M4F_CANDIDATE18_REMOTE_PARSE_FAILED");
      expect(JSON.parse(readFileSync(directory + "/parse-failure.json", "utf8"))).toMatchObject({
        business_target_body_not_invoked: true,
        outer_loader_target_body_not_invoked: true,
        process_mutation_performed: false,
        file_mutation_performed: false,
        vivado_action_performed: false,
        hardware_action_performed: false,
        cleanup_performed: false,
        retry_permitted: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
