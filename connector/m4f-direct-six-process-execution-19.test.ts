import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  C18_ADJUDICATION_REVIEW_PATH,
  Candidate19ExecutionFailure,
  candidate19ExecutionAuthorizationPath,
  candidate19ExecutionConfirmation,
  canonicalJsonCandidate19Execution,
  executeCandidate19Execution,
  planCandidate19Execution,
  type Candidate19ExecutionCapturedFile,
  type Candidate19ExecutionConfig,
  type Candidate19ExecutionDependencies,
  type Candidate19ExecutionFileFact,
  type Candidate19ExecutionAuthorization,
} from "./scripts/m4f-direct-six-process-execution-19.ts";
import {
  buildCandidate19Payload,
  candidate19StartToken,
  type Candidate19ScriptConfig,
} from "./scripts/m4f-direct-six-process-cleanup-19.ts";
import type { RawProcessResult } from "./scripts/m4f-gate-admission-transport.ts";

const SCRIPT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-cleanup-prod-20260829-19.json";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const C18_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18.json";
const C18_EVIDENCE = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
const C18_PLAN_PATH = C18_EVIDENCE + "/plan.canonical.json";
const C18_ADJUDICATION_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-record.json";
const C18_ADJUDICATOR_CONFIG = "/private/tmp/synthia-m4f-direct-six-process-parse-progress-adjudicator-prod-20260829-18.json";
const C18_REVIEW_SHA256 = "edc8166bd16e818785c124fa624e9874b2a0159668423e1c605d87a53798c788";
const C18_SOURCE = new URL("./scripts/m4f-direct-six-process-parse-only-18.ts", import.meta.url).pathname;
const C18_TEST = new URL("./m4f-direct-six-process-parse-only-18.test.ts", import.meta.url).pathname;
const C18_ADJUDICATOR_SOURCE = new URL("./scripts/m4f-direct-six-process-parse-adjudicator-18.ts", import.meta.url).pathname;
const C18_ADJUDICATOR_TEST = new URL("./m4f-direct-six-process-parse-adjudicator-18.test.ts", import.meta.url).pathname;
const C19_SOURCE = new URL("./scripts/m4f-direct-six-process-cleanup-19.ts", import.meta.url).pathname;
const C19_TEST = new URL("./m4f-direct-six-process-cleanup-19.test.ts", import.meta.url).pathname;
const C19_DOC = new URL("./M4F-DIRECT-SIX-PROCESS-CLEANUP-18-19.md", import.meta.url).pathname;
const TRANSPORT_SOURCE = new URL("./scripts/m4f-gate-admission-transport.ts", import.meta.url).pathname;
const EXECUTION_SOURCE = new URL("./scripts/m4f-direct-six-process-execution-19.ts", import.meta.url).pathname;
const EXECUTION_TEST = new URL("./m4f-direct-six-process-execution-19.test.ts", import.meta.url).pathname;
const EFFECTIVE = C18_EVIDENCE + "/ssh-effective-stdout.raw";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

function marker(
  config: Candidate19ScriptConfig,
  phase: string,
  status: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema: "synthia-m4f-candidate19-marker.v1",
    cleanup_id: config.cleanup_id,
    phase,
    status,
    observed_at_utc: "2026-08-29T14:00:00.0000000Z",
    payload,
  };
}

function completeMarkers(config: Candidate19ScriptConfig): Record<string, unknown>[] {
  const currentPid = 900;
  const runtimeHash = "a".repeat(64);
  const protection = {
    cores: [
      {
        pid: 4,
        parent_pid: 0,
        name: "system",
        creation_utc: "2026-08-01T00:00:00.0000000Z",
        session_id: 0,
        command_sha256: "c".repeat(64),
      },
      {
        pid: currentPid,
        parent_pid: 4,
        name: "powershell.exe",
        creation_utc: "2026-08-29T14:00:00.0000000Z",
        session_id: 0,
        command_sha256: "b".repeat(64),
      },
      {
        pid: config.protected_worker.pid,
        parent_pid: config.protected_worker.parent_pid,
        name: config.protected_worker.name,
        creation_utc: config.protected_worker.creation_utc,
        session_id: 0,
        command_sha256: runtimeHash,
      },
    ],
    listeners: structuredClone(config.protected_listeners),
    worker_raw_handle: "1234",
    worker_runtime_command_sha256: runtimeHash,
  };
  const protectionSha256 = sha256(JSON.stringify(protection));
  const markers: Record<string, unknown>[] = [
    marker(config, "start", "observed", {
      current_pid: currentPid,
      target_count: 6,
      observation_semantic_sha256: config.observation_semantic_sha256,
      admission_record_sha256: config.admission_record_sha256,
    }),
    marker(config, "preflight", "observed", {
      target_count: 6,
      retained_handle_count: 6,
      protection,
      protection_sha256: protectionSha256,
    }),
  ];
  for (const target of config.targets) {
    markers.push(marker(config, "effect_start", "started", {
      ordinal: target.ordinal,
      candidate: target.candidate,
      role: target.role,
      pid: target.pid,
      start_token: candidate19StartToken(target),
      raw_handle: String(2000 + target.ordinal),
      protection_sha256: protectionSha256,
    }));
    markers.push(marker(config, "effect_result", "observed", {
      ordinal: target.ordinal,
      pid: target.pid,
      effect: "same_process_instance_kill_completed",
      has_exited: true,
      start_token: candidate19StartToken(target),
    }));
  }
  markers.push(marker(config, "postflight", "observed", {
    resolved_count: 6,
    protection_sha256: protectionSha256,
  }));
  markers.push(marker(config, "complete", "complete", {
    cleanup_completed: true,
    resolved_count: 6,
    retry_permitted: false,
  }));
  return markers;
}

function markerStream(markers: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(markers.map((value) => JSON.stringify(value) + "\r\n").join(""));
}

function cloneCapture(value: Candidate19ExecutionCapturedFile): Candidate19ExecutionCapturedFile {
  return { bytes: Buffer.from(value.bytes), fact: structuredClone(value.fact) };
}

interface Fixture {
  config: Candidate19ExecutionConfig;
  scriptConfig: Candidate19ScriptConfig;
  dependencies: Candidate19ExecutionDependencies;
  files: Map<string, Candidate19ExecutionCapturedFile>;
  calls: Array<{ executable: string; args: readonly string[]; stdin: Buffer; timeoutMs: number }>;
  writes: Map<string, Buffer>;
  authorizationPath: string;
  authorizationSha256: string;
  setFile(path: string, bytes: Buffer): void;
  setRemote(result: RawProcessResult): void;
}

function fixture(): Fixture {
  let inode = 1000;
  const files = new Map<string, Candidate19ExecutionCapturedFile>();
  const addFile = (path: string, bytes: Buffer, mode = 0o600): void => {
    const fact: Candidate19ExecutionFileFact = {
      schema: "synthia-m4f-candidate19-execution-local-file.v1",
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
  const addRealFile = (path: string): void => {
    const bytes = readFileSync(path);
    const stat = lstatSync(path);
    files.set(path, {
      bytes,
      fact: {
        schema: "synthia-m4f-candidate19-execution-local-file.v1",
        path,
        device: stat.dev,
        inode: stat.ino,
        owner_uid: stat.uid,
        mode: stat.mode & 0o777,
        link_count: stat.nlink,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        sha256: sha256(bytes),
      },
    });
  };
  for (const path of [SCRIPT_CONFIG_PATH, TRANSPORT_CONFIG_PATH, C18_CONFIG_PATH,
    C18_ADJUDICATION_PATH, C18_ADJUDICATOR_CONFIG, C18_ADJUDICATION_REVIEW_PATH,
    C18_SOURCE, C18_TEST, C18_ADJUDICATOR_SOURCE,
    C18_ADJUDICATOR_TEST, C19_SOURCE, C19_TEST, C19_DOC, TRANSPORT_SOURCE,
    EXECUTION_SOURCE, EXECUTION_TEST]) {
    addRealFile(path);
  }
  const adjudication = JSON.parse(files.get(C18_ADJUDICATION_PATH)!.bytes.toString()) as Record<string, unknown>;
  const evidenceHashes = adjudication.evidence_hashes as Record<string, string>;
  for (const name of Object.keys(evidenceHashes)) {
    const path = C18_EVIDENCE + "/" + name;
    if (!files.has(path)) addRealFile(path);
  }
  const evidenceManifestSha256 = sha256(canonicalJsonCandidate19Execution(evidenceHashes) + "\n");
  const reviewBytes = files.get(C18_ADJUDICATION_REVIEW_PATH)!.bytes;

  const executionSource = files.get(EXECUTION_SOURCE)!.bytes;
  const executionTest = files.get(EXECUTION_TEST)!.bytes;
  const scriptConfig = JSON.parse(files.get(SCRIPT_CONFIG_PATH)!.bytes.toString()) as Candidate19ScriptConfig;
  const config: Candidate19ExecutionConfig = {
    schema: "synthia-m4f-candidate19-execution-config.v1",
    execution_id: "m4f-candidate19-execution-fixture",
    script_config: structuredClone(scriptConfig),
    script_config_path: SCRIPT_CONFIG_PATH,
    script_config_sha256: sha256(files.get(SCRIPT_CONFIG_PATH)!.bytes) as Candidate19ExecutionConfig["script_config_sha256"],
    transport_config_path: TRANSPORT_CONFIG_PATH,
    transport_config_sha256: sha256(files.get(TRANSPORT_CONFIG_PATH)!.bytes) as Candidate19ExecutionConfig["transport_config_sha256"],
    candidate18_config_path: C18_CONFIG_PATH,
    candidate18_config_sha256: sha256(files.get(C18_CONFIG_PATH)!.bytes) as Candidate19ExecutionConfig["candidate18_config_sha256"],
    candidate18_evidence_directory: C18_EVIDENCE,
    candidate18_plan_path: C18_PLAN_PATH,
    candidate18_plan_sha256: sha256(files.get(C18_PLAN_PATH)!.bytes) as Candidate19ExecutionConfig["candidate18_plan_sha256"],
    candidate18_evidence_manifest_sha256: evidenceManifestSha256,
    candidate18_source_sha256: sha256(files.get(C18_SOURCE)!.bytes) as Candidate19ExecutionConfig["candidate18_source_sha256"],
    candidate18_test_sha256: sha256(files.get(C18_TEST)!.bytes) as Candidate19ExecutionConfig["candidate18_test_sha256"],
    candidate18_adjudicator_source_sha256: sha256(files.get(C18_ADJUDICATOR_SOURCE)!.bytes) as Candidate19ExecutionConfig["candidate18_adjudicator_source_sha256"],
    candidate18_adjudicator_test_sha256: sha256(files.get(C18_ADJUDICATOR_TEST)!.bytes) as Candidate19ExecutionConfig["candidate18_adjudicator_test_sha256"],
    candidate18_adjudication_record_path: C18_ADJUDICATION_PATH,
    candidate18_adjudication_record_sha256: sha256(files.get(C18_ADJUDICATION_PATH)!.bytes) as Candidate19ExecutionConfig["candidate18_adjudication_record_sha256"],
    candidate18_adjudication_review_path: C18_ADJUDICATION_REVIEW_PATH,
    candidate18_adjudication_review_sha256: C18_REVIEW_SHA256,
    expected_candidate19_source_sha256: sha256(files.get(C19_SOURCE)!.bytes) as Candidate19ExecutionConfig["expected_candidate19_source_sha256"],
    expected_candidate19_test_sha256: sha256(files.get(C19_TEST)!.bytes) as Candidate19ExecutionConfig["expected_candidate19_test_sha256"],
    expected_candidate19_doc_sha256: sha256(files.get(C19_DOC)!.bytes) as Candidate19ExecutionConfig["expected_candidate19_doc_sha256"],
    expected_transport_source_sha256: sha256(files.get(TRANSPORT_SOURCE)!.bytes) as Candidate19ExecutionConfig["expected_transport_source_sha256"],
    expected_source_sha256: sha256(executionSource),
    expected_test_source_sha256: sha256(executionTest),
    evidence_directory: "/private/tmp/m4f-candidate19-execution-fixture-evidence",
    effective_timeout_ms: 15_000,
    remote_timeout_ms: 50_000,
  };
  const authorizationPath = candidate19ExecutionAuthorizationPath(config);
  const calls: Fixture["calls"] = [];
  const writes = new Map<string, Buffer>();
  let remote = processResult(markerStream(completeMarkers(scriptConfig)));
  let created = false;
  const source = (path: string): Candidate19ExecutionCapturedFile => {
    const value = files.get(path);
    if (!value) throw new Error("missing:" + path);
    return cloneCapture(value);
  };
  const dependencies: Candidate19ExecutionDependencies = {
    spawn(executable, args, stdin, timeoutMs) {
      calls.push({ executable, args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      return args[0] === "-G"
        ? processResult(files.get(EFFECTIVE)!.bytes)
        : { ...remote, stdout: Buffer.from(remote.stdout), stderr: Buffer.from(remote.stderr) };
    },
    captureFile: source,
    captureDirectory(path) {
      if (path !== C18_EVIDENCE) throw new Error("directory");
      const stat = lstatSync(path);
      return {
        path,
        device: stat.dev,
        inode: stat.ino,
        owner_uid: stat.uid,
        mode: stat.mode & 0o777,
        link_count: stat.nlink,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        entries: Object.keys(evidenceHashes).sort(),
      };
    },
    sourceFile: () => source(EXECUTION_SOURCE),
    testSourceFile: () => source(EXECUTION_TEST),
    candidate19SourceFile: () => source(C19_SOURCE),
    candidate19TestSourceFile: () => source(C19_TEST),
    candidate19DocFile: () => source(C19_DOC),
    candidate18SourceFile: () => source(C18_SOURCE),
    candidate18TestFile: () => source(C18_TEST),
    candidate18AdjudicatorSourceFile: () => source(C18_ADJUDICATOR_SOURCE),
    candidate18AdjudicatorTestFile: () => source(C18_ADJUDICATOR_TEST),
    transportSourceFile: () => source(TRANSPORT_SOURCE),
    transportInputs: () => [{ schema: "fixture-transport-input.v1", sha256: "d".repeat(64) }],
    createEvidenceDirectory(path) {
      if (created || path !== config.evidence_directory) throw new Error("create");
      created = true;
    },
    writeEvidence(path, bytes) {
      if (!created || writes.has(path)) throw new Error("write");
      writes.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-29T14:30:00.000Z"),
  };
  const payload = buildCandidate19Payload(scriptConfig);
  const plan = planCandidate19Execution(config, dependencies);
  const authorization: Candidate19ExecutionAuthorization = {
    schema: "synthia-m4f-candidate19-execution-authorization.v1",
    authorization_id: `${config.execution_id}-f0-authorization`,
    decision: "AUTHORIZED_FOR_EXACT_C19_EXECUTION",
    authorized_at_utc: "2026-08-29T14:20:00.000Z",
    reviewer_role: "independent_f0_execution_reviewer",
    seals: {
      execution_id: config.execution_id,
      execution_config_sha256: sha256(canonicalJsonCandidate19Execution(config) + "\n"),
      execution_plan_sha256: sha256(canonicalJsonCandidate19Execution(plan) + "\n"),
      execution_source_sha256: config.expected_source_sha256,
      execution_test_sha256: config.expected_test_source_sha256,
      c18_review_path: C18_ADJUDICATION_REVIEW_PATH,
      c18_review_sha256: C18_REVIEW_SHA256,
      script_config_sha256: config.script_config_sha256,
      transport_config_sha256: config.transport_config_sha256,
      business_script_sha256: payload.business_script_sha256,
      outer_loader_sha256: payload.outer_loader_sha256,
      remote_command_sha256: payload.remote_command_sha256,
    },
    authorization_boundary: {
      cleanup_execution_authorized: true,
      network_authorized: true,
      ssh_authorized: true,
      remote_execution_authorized: true,
      retry_authorized: false,
      maximum_effective_audit_count: 1,
      maximum_remote_attempt_count: 1,
      remote_stdin_length: 0,
      hardware_download_authorized: false,
    },
    review_actions: {
      source_evidence_mutated: false,
      network_attempted: false,
      ssh_attempted: false,
      remote_execution_attempted: false,
      cleanup_performed: false,
    },
  };
  const authorizationBytes = Buffer.from(canonicalJsonCandidate19Execution(authorization) + "\n");
  addFile(authorizationPath, authorizationBytes);
  const authorizationSha256 = sha256(authorizationBytes);
  return {
    config,
    scriptConfig,
    dependencies,
    files,
    calls,
    writes,
    authorizationPath,
    authorizationSha256,
    setFile: addFile,
    setRemote(value) { remote = value; },
  };
}

function failure(run: () => unknown): Candidate19ExecutionFailure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Candidate19ExecutionFailure);
    return error as Candidate19ExecutionFailure;
  }
  throw new Error("expected failure");
}

function exactConfirmation(value: Fixture): string {
  return candidate19ExecutionConfirmation(
    value.config,
    value.authorizationPath,
    value.authorizationSha256,
    value.dependencies,
  );
}

function executeFixture(value: Fixture, confirmation: string): Record<string, unknown> {
  return executeCandidate19Execution(
    value.config,
    value.authorizationPath,
    value.authorizationSha256,
    confirmation,
    value.config.evidence_directory,
    value.dependencies,
  );
}

function mutateAuthorization(
  value: Fixture,
  mutate: (authorization: Record<string, any>) => void,
): void {
  const authorization = JSON.parse(value.files.get(value.authorizationPath)!.bytes.toString());
  mutate(authorization);
  const bytes = Buffer.from(canonicalJsonCandidate19Execution(authorization) + "\n");
  value.setFile(value.authorizationPath, bytes);
  value.authorizationSha256 = sha256(bytes);
}

describe("M4-F Candidate 19 execution layer", () => {
  test("rebuilds the exact frozen payload and plans one audited zero-stdin attempt", () => {
    const value = fixture();
    const payload = buildCandidate19Payload(value.scriptConfig);
    const plan = planCandidate19Execution(value.config, value.dependencies);
    expect(plan).toMatchObject({
      status: "freeze_only_not_authorized",
      business_script_sha256: payload.business_script_sha256,
      outer_loader_sha256: payload.outer_loader_sha256,
      remote_command_sha256: payload.remote_command_sha256,
      remote_command_length: payload.remote_command.length,
      effective_audit_count: 1,
      remote_attempt_count: 1,
      remote_stdin_length: 0,
      c18_review_decision: "GO_FOR_C19_EXECUTION_FREEZE_ONLY",
      execution_authorization_required: true,
      execution_authorized: false,
      exact_confirmation_required: true,
      final_confirmation_issued: false,
      network_attempted: false,
      cleanup_performed: false,
      retry_permitted: false,
    });
    expect(payload.remote_command.length).toBeLessThanOrEqual(7_000);
    expect("confirmation" in plan).toBe(false);
    expect(value.calls).toHaveLength(0);

    const splitBrain = structuredClone(value.config);
    splitBrain.script_config.cleanup_id = "m4f-candidate19-valid-but-different";
    expect(failure(() => planCandidate19Execution(splitBrain, value.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE19_EXECUTION_SCRIPT_SPLIT_BRAIN");
  });

  test("reads the exact formal C18 review and fails closed when it is absent or drifted", () => {
    const value = fixture();
    const formalBytes = readFileSync(C18_ADJUDICATION_REVIEW_PATH);
    const formal = JSON.parse(formalBytes.toString());
    expect(sha256(formalBytes)).toBe(C18_REVIEW_SHA256);
    expect(value.files.get(C18_ADJUDICATION_REVIEW_PATH)!.bytes).toEqual(formalBytes);
    expect(formal).toMatchObject({
      schema: "synthia-m4f-c18-local-adjudication-review-record.v1",
      decision: "GO_FOR_C19_EXECUTION_FREEZE_ONLY",
      evidence_lineage: { exact_file_count: 21, exact_file_set: true },
      authorization_boundary: {
        c19_execution_authorized: false,
        cleanup_execution_authorized: false,
        network_authorized: false,
        ssh_authorized: false,
        remote_execution_authorized: false,
        retry_authorized: false,
      },
    });
    expect(planCandidate19Execution(value.config, value.dependencies)).toMatchObject({
      candidate18_adjudication_review_sha256: C18_REVIEW_SHA256,
      execution_authorized: false,
    });
    value.files.delete(C18_ADJUDICATION_REVIEW_PATH);
    const error = failure(() => planCandidate19Execution(value.config, value.dependencies));
    expect(error.detail).toMatchObject({
      code: "M4F_CANDIDATE19_EXECUTION_INPUT_MISSING",
      stage: "local_preflight",
      path: C18_ADJUDICATION_REVIEW_PATH,
      retry_permitted: false,
    });
    expect(value.calls).toHaveLength(0);
    const drift = fixture();
    drift.files.get(C18_ADJUDICATION_REVIEW_PATH)!.bytes = Buffer.from("drift");
    expect(failure(() => planCandidate19Execution(drift.config, drift.dependencies)).detail.code)
      .toBe("M4F_CANDIDATE19_EXECUTION_INPUT_INVALID");
    expect(drift.calls).toHaveLength(0);
  });

  test("freeze-only review cannot spawn without a sealed C19 authorization", () => {
    const value = fixture();
    value.files.delete(value.authorizationPath);
    const error = failure(() => executeCandidate19Execution(
      value.config,
      value.authorizationPath,
      value.authorizationSha256,
      "not-a-confirmation",
      value.config.evidence_directory,
      value.dependencies,
    ));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_MISSING");
    expect(value.calls).toHaveLength(0);
    expect(value.writes.size).toBe(0);
  });

  test("requires authorization-bound exact confirmation before any process spawn", () => {
    const value = fixture();
    const confirmation = exactConfirmation(value);
    expect(confirmation.split(":")[0])
      .toBe("SYNTHIA_M4F_CANDIDATE19_AUTHORIZED_EXACT_SIX_PROCESS_CLEANUP");
    expect(confirmation.split(":")).toContain(value.authorizationSha256);
    const error = failure(() => executeFixture(value, confirmation + "x"));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
    expect(value.writes.size).toBe(0);
  });

  test("rejects missing, forged, or lineage-drifted C19 authorization before spawn", () => {
    const mutations: Array<(authorization: Record<string, any>) => void> = [
      (authorization) => { authorization.decision = "FREEZE_ONLY"; },
      (authorization) => { authorization.authorization_boundary.cleanup_execution_authorized = false; },
      (authorization) => { authorization.authorization_boundary.network_authorized = false; },
      (authorization) => { authorization.authorization_boundary.ssh_authorized = false; },
      (authorization) => { authorization.authorization_boundary.remote_execution_authorized = false; },
      (authorization) => { authorization.authorization_boundary.retry_authorized = true; },
      (authorization) => { authorization.authorization_boundary.maximum_remote_attempt_count = 2; },
      (authorization) => { authorization.authorization_boundary.remote_stdin_length = 1; },
      (authorization) => { authorization.authorization_boundary.hardware_download_authorized = true; },
      (authorization) => { authorization.seals.execution_config_sha256 = "0".repeat(64); },
      (authorization) => { authorization.seals.execution_plan_sha256 = "0".repeat(64); },
      (authorization) => { authorization.seals.execution_source_sha256 = "0".repeat(64); },
      (authorization) => { authorization.seals.execution_test_sha256 = "0".repeat(64); },
      (authorization) => { authorization.seals.c18_review_sha256 = "0".repeat(64); },
      (authorization) => { authorization.seals.remote_command_sha256 = "0".repeat(64); },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutateAuthorization(value, mutate);
      const error = failure(() => candidate19ExecutionConfirmation(
        value.config,
        value.authorizationPath,
        value.authorizationSha256,
        value.dependencies,
      ));
      expect(error.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID");
      expect(value.calls).toHaveLength(0);
    }

    const wrongHash = fixture();
    const error = failure(() => executeCandidate19Execution(
      wrongHash.config,
      wrongHash.authorizationPath,
      "0".repeat(64),
      "irrelevant",
      wrongHash.config.evidence_directory,
      wrongHash.dependencies,
    ));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID");
    expect(wrongHash.calls).toHaveLength(0);

    const wrongPath = fixture();
    const pathError = failure(() => executeCandidate19Execution(
      wrongPath.config,
      "/private/tmp/wrong-authorization.json",
      wrongPath.authorizationSha256,
      "irrelevant",
      wrongPath.config.evidence_directory,
      wrongPath.dependencies,
    ));
    expect(pathError.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_REQUIRED");
    expect(wrongPath.calls).toHaveLength(0);
  });

  test("rejects confirmation containing the wrong authorization SHA before spawn", () => {
    const value = fixture();
    const exact = exactConfirmation(value);
    const wrong = exact.replace(value.authorizationSha256, "f".repeat(64));
    expect(wrong).not.toBe(exact);
    const error = failure(() => executeFixture(value, wrong));
    expect(error.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_CONFIRMATION_REQUIRED");
    expect(value.calls).toHaveLength(0);
  });

  test("executes exactly one effective audit and one zero-stdin SSH command on a complete stream", () => {
    const value = fixture();
    const payload = buildCandidate19Payload(value.scriptConfig);
    const confirmation = exactConfirmation(value);
    const record = executeFixture(value, confirmation);
    expect(record).toMatchObject({
      status: "cleanup_complete",
      attempt: 1,
      cleanup_complete: true,
      retry_permitted: false,
      remote_command_sha256: payload.remote_command_sha256,
      process: { stdin_length: 0, stdin_sha256: EMPTY_SHA256, retry_permitted: false },
      marker: { complete: true, effect_start_ordinals: [1, 2, 3, 4, 5, 6] },
    });
    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]).toMatchObject({ executable: "/usr/bin/ssh", timeoutMs: 15_000 });
    expect(value.calls[0]!.args[0]).toBe("-G");
    expect(value.calls[1]).toMatchObject({ executable: "/usr/bin/ssh", timeoutMs: 50_000 });
    expect(value.calls[1]!.args.at(-2)).toBe("100.96.223.49");
    expect(value.calls[1]!.args.at(-1)).toBe(payload.remote_command);
    expect(value.calls.every((call) => call.stdin.length === 0)).toBe(true);
    expect(value.writes.get(value.config.evidence_directory + "/stdout.raw"))
      .toEqual(markerStream(completeMarkers(value.scriptConfig)));
    expect(value.writes.get(value.config.evidence_directory + "/marker-prefix.raw"))
      .toEqual(markerStream(completeMarkers(value.scriptConfig)));
    expect(value.writes.get(value.config.evidence_directory + "/marker-trailing.raw"))
      .toEqual(Buffer.alloc(0));
    expect(JSON.parse(value.writes.get(value.config.evidence_directory + "/marker-summary.json")!.toString()))
      .toMatchObject({ complete: true, trailing_fragment_length: 0 });
    expect(value.writes.has(value.config.evidence_directory + "/execution-record.json")).toBe(true);
    expect(value.writes.get(value.config.evidence_directory + "/execution-authorization.raw.json"))
      .toEqual(value.files.get(value.authorizationPath)!.bytes);
  });

  test("preserves timeout evidence, marks observed effects ambiguous, and never retries", () => {
    const value = fixture();
    const partial = markerStream(completeMarkers(value.scriptConfig).slice(0, 3));
    value.setRemote(processResult(partial, "", null, "ETIMEDOUT"));
    const confirmation = exactConfirmation(value);
    const error = failure(() => executeFixture(value, confirmation));
    expect(error.detail).toMatchObject({
      code: "M4F_CANDIDATE19_EXECUTION_PARTIAL_OR_FAILED",
      stage: "network",
      effect_state: "effects_may_have_occurred",
      retry_permitted: false,
      process: { timed_out: true, retry_permitted: false },
    });
    expect(value.calls).toHaveLength(2);
    expect(value.writes.get(value.config.evidence_directory + "/stdout.raw")).toEqual(partial);
    const failureRecord = JSON.parse(
      value.writes.get(value.config.evidence_directory + "/execution-failure.json")!.toString(),
    );
    expect(failureRecord).toMatchObject({
      attempt: 1,
      retry_permitted: false,
      cleanup_complete: false,
      marker: { effect_start_ordinals: [1], effect_result_ordinals: [] },
      remote_process: { timed_out: true },
    });
  });

  test("treats effect_start without its result as effects-may-have-occurred even on clean exit", () => {
    const value = fixture();
    value.setRemote(processResult(markerStream(completeMarkers(value.scriptConfig).slice(0, 3))));
    const confirmation = exactConfirmation(value);
    const error = failure(() => executeFixture(value, confirmation));
    expect(error.detail).toMatchObject({
      code: "M4F_CANDIDATE19_EXECUTION_PARTIAL_OR_FAILED",
      effect_state: "effects_may_have_occurred",
      retry_permitted: false,
      marker: { effect_start_ordinals: [1], effect_result_ordinals: [], complete: false },
    });
    expect(value.calls).toHaveLength(2);
  });

  test("records a thrown remote transport as attempt one and does not retry", () => {
    const value = fixture();
    const spawn = value.dependencies.spawn;
    value.dependencies.spawn = (executable, args, stdin, timeoutMs) => {
      if (args[0] === "-G") return spawn(executable, args, stdin, timeoutMs);
      value.calls.push({ executable, args: [...args], stdin: Buffer.from(stdin), timeoutMs });
      throw new Error("transport threw");
    };
    const confirmation = exactConfirmation(value);
    const error = failure(() => executeFixture(value, confirmation));
    expect(error.detail).toMatchObject({
      code: "M4F_CANDIDATE19_EXECUTION_UNEXPECTED",
      stage: "network",
      retry_permitted: false,
      cleanup_complete: false,
    });
    expect(value.calls).toHaveLength(2);
    const record = JSON.parse(
      value.writes.get(value.config.evidence_directory + "/execution-failure.json")!.toString(),
    );
    expect(record).toMatchObject({ attempt: 1, remote_process: null, retry_permitted: false });
  });

  test("rejects invalid marker tails, stderr, and nonzero exit while preserving raw streams", () => {
    const cases: RawProcessResult[] = [
      processResult(Buffer.concat([
        markerStream(completeMarkers(fixture().scriptConfig)),
        Buffer.from([0xff, 0x00, 0x0a]),
      ])),
      processResult(markerStream(completeMarkers(fixture().scriptConfig)), "unexpected stderr"),
      processResult(markerStream(completeMarkers(fixture().scriptConfig)), "", 1),
    ];
    for (const [index, remote] of cases.entries()) {
      const value = fixture();
      value.setRemote(remote);
      const confirmation = exactConfirmation(value);
      const error = failure(() => executeFixture(value, confirmation));
      expect(error.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_PARTIAL_OR_FAILED");
      expect(error.detail.retry_permitted).toBe(false);
      expect(value.calls).toHaveLength(2);
      expect(value.writes.get(value.config.evidence_directory + "/stdout.raw")).toEqual(remote.stdout);
      expect(value.writes.get(value.config.evidence_directory + "/stderr.raw")).toEqual(remote.stderr);
      if (index === 0) {
        expect(value.writes.get(value.config.evidence_directory + "/marker-prefix.raw"))
          .toEqual(markerStream(completeMarkers(value.scriptConfig)));
        expect(value.writes.get(value.config.evidence_directory + "/marker-trailing.raw"))
          .toEqual(Buffer.from([0xff, 0x00, 0x0a]));
      }
    }
  });

  test("blocks transport and bound-input drift after the effective audit without a remote attempt", () => {
    const transport = fixture();
    let transportCapture = 0;
    transport.dependencies.transportInputs = () => [{ capture: transportCapture++ }];
    const transportConfirmation = exactConfirmation(transport);
    transportCapture = 0;
    const transportError = failure(() => executeFixture(transport, transportConfirmation));
    expect(transportError.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_TRANSPORT_INPUT_DRIFT");
    expect(transport.calls).toHaveLength(1);

    const input = fixture();
    const sourceFile = input.dependencies.sourceFile;
    input.dependencies.sourceFile = () => {
      const captured = sourceFile();
      if (input.calls.length > 0) captured.fact.mtime_ms += 1;
      return captured;
    };
    const inputConfirmation = exactConfirmation(input);
    const inputError = failure(() => executeFixture(input, inputConfirmation));
    expect(inputError.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID");
    expect(input.calls).toHaveLength(1);

    const directory = fixture();
    const captureDirectory = directory.dependencies.captureDirectory;
    directory.dependencies.captureDirectory = (path) => {
      const captured = captureDirectory(path);
      if (directory.calls.length > 0) captured.inode += 1;
      return captured;
    };
    const directoryConfirmation = exactConfirmation(directory);
    const directoryError = failure(() => executeFixture(directory, directoryConfirmation));
    expect(directoryError.detail.code).toBe("M4F_CANDIDATE19_EXECUTION_REVIEW_INVALID");
    expect(directory.calls).toHaveLength(1);
  });

  test("fails closed on source, test, review, evidence, and C18 business/outer byte drift", () => {
    const cases: Array<(value: Fixture) => void> = [
      (value) => {
        value.files.get(EXECUTION_SOURCE)!.bytes = Buffer.from("drift");
      },
      (value) => {
        value.files.get(C19_TEST)!.bytes = Buffer.from("drift");
      },
      (value) => {
        value.files.get(C18_ADJUDICATION_REVIEW_PATH)!.bytes = Buffer.from("drift");
      },
      (value) => {
        value.files.get(C18_EVIDENCE + "/stdout.raw")!.bytes = Buffer.from("drift");
      },
      (value) => {
        value.files.get(C18_EVIDENCE + "/target-business-script.ps1")!.bytes = Buffer.from("drift");
      },
      (value) => {
        value.files.get(C18_EVIDENCE + "/target-outer-loader.ps1")!.bytes = Buffer.from("drift");
      },
    ];
    for (const mutate of cases) {
      const value = fixture();
      mutate(value);
      expect(failure(() => planCandidate19Execution(value.config, value.dependencies)).detail.code)
        .toBe("M4F_CANDIDATE19_EXECUTION_INPUT_INVALID");
      expect(value.calls).toHaveLength(0);
    }
  });

  test("rejects a replaced or permission-drifted C18 evidence directory", () => {
    for (const mutate of [
      (directory: Record<string, unknown>) => { directory.path = "/private/tmp/replaced"; },
      (directory: Record<string, unknown>) => { directory.mode = 0o755; },
      (directory: Record<string, unknown>) => { directory.owner_uid = 0; },
    ]) {
      const value = fixture();
      const capture = value.dependencies.captureDirectory;
      value.dependencies.captureDirectory = (path) => {
        const directory = capture(path) as unknown as Record<string, unknown>;
        mutate(directory);
        return directory as unknown as ReturnType<typeof capture>;
      };
      expect(failure(() => planCandidate19Execution(value.config, value.dependencies)).detail.code)
        .toBe("M4F_CANDIDATE19_EXECUTION_C18_EVIDENCE_INVALID");
    }
  });

  test("reports evidence-write failure without retry after preserving remote raw bytes", () => {
    const value = fixture();
    const write = value.dependencies.writeEvidence;
    value.dependencies.writeEvidence = (path, bytes) => {
      if (path.endsWith("/marker-summary.json")) throw new Error("disk full");
      write(path, bytes);
    };
    const confirmation = exactConfirmation(value);
    const error = failure(() => executeFixture(value, confirmation));
    expect(error.detail).toMatchObject({
      code: "M4F_CANDIDATE19_EXECUTION_EVIDENCE_WRITE_FAILED",
      stage: "evidence",
      effect_state: "effects_may_have_occurred",
      retry_permitted: false,
      cleanup_complete: false,
    });
    expect(value.calls).toHaveLength(2);
    expect(value.writes.has(value.config.evidence_directory + "/stdout.raw")).toBe(true);
    expect(value.writes.has(value.config.evidence_directory + "/stderr.raw")).toBe(true);
    expect(value.writes.has(value.config.evidence_directory + "/marker-prefix.raw")).toBe(true);
  });

  test("fixture is bound to the exact 21-file C18 evidence set", () => {
    expect(readdirSync(C18_EVIDENCE).sort()).toHaveLength(21);
    const value = fixture();
    const record = JSON.parse(value.files.get(C18_ADJUDICATION_PATH)!.bytes.toString());
    expect(Object.keys(record.evidence_hashes).sort()).toEqual(readdirSync(C18_EVIDENCE).sort());
  });
});
