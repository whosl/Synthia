import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidate35Payload,
  candidate35Confirmation,
  CANDIDATE34_RECORD_PATH,
  CANDIDATE34_RECORD_SHA256,
  CANDIDATE34_SOURCE_SHA256,
  CANDIDATE34_TEST_SHA256,
  CANDIDATE31_RECORD_PATH,
  CANDIDATE35_TARGETS,
  planCandidate35,
  validateCandidate35Config,
  validateCandidate35MarkerPrefix,
  type Candidate35Config,
} from "./m4f-direct-nine-pid-cleanup-runner-35.ts";
import {
  auditDirectSshEffectiveConfig,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  validateM4fDirectAdmissionConfig,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
} from "./m4f-gate-admission-transport.ts";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const CANDIDATE37_ID = "m4f-direct-nine-pid-cleanup-execution-prod-20260831-37";
export const CANDIDATE35_CONFIG_PATH =
  "/private/tmp/synthia-m4f-direct-nine-pid-cleanup-prod-20260831-35.json";
export const CANDIDATE35_SOURCE_SHA256 =
  "3ca4d422572e14a3d3f1bd5b315a9a68e81f9db5307c8864389529d5b97f89a2";
export const CANDIDATE35_TEST_SHA256 =
  "1a66693cbba3968be33be85c55339a6c55501608923ff011fd79b8ac184fd970";
export const CANDIDATE31_RECORD_SHA256 =
  "4efad9fab8445eeee887e564fe6362f1341f96500f7926b8ddee690ee50fa8aa";
export const CANDIDATE36_CONFIG_PATH =
  "/private/tmp/synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12.json";
export const CANDIDATE36_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12-evidence";
export const CANDIDATE36_RECORD_PATH = CANDIDATE36_EVIDENCE_DIRECTORY + "/gate-record.json";
export const CANDIDATE36_MANIFEST_PATH =
  "/private/tmp/m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12-evidence-manifest.json";
export const CANDIDATE36_SOURCE_SHA256 =
  "720b962118cea04f9abfeb9d2c378f4a790ec5b2e1a7bed76a2d031c875f7e39";
export const CANDIDATE36_TEST_SHA256 =
  "03a0dd1af2b9ba0585665d0e8224539be489cf797c50e619681ead29af4b27cd";
export const TRANSPORT_CONFIG_PATH =
  "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
export const TRANSPORT_CONFIG_SHA256 =
  "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
export const TRANSPORT_SOURCE_SHA256 =
  "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
export const EFFECTIVE_TIMEOUT_MS = 15_000;
export const REMOTE_TIMEOUT_MS = 75_000;

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-cleanup-execution-37.test.ts", import.meta.url));
const C35_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-nine-pid-cleanup-runner-35.ts", import.meta.url));
const C35_TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-cleanup-runner-35.test.ts", import.meta.url));
const C34_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-nine-pid-stale-parent-adjudicator-34.ts", import.meta.url));
const C34_TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-stale-parent-adjudicator-34.test.ts", import.meta.url));
const C36_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-nine-pid-cleanup-parse-helper-gate-36.ts", import.meta.url));
const C36_TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-cleanup-parse-helper-gate-36.test.ts", import.meta.url));
const TRANSPORT_SOURCE_PATH = fileURLToPath(new URL("./m4f-gate-admission-transport.ts", import.meta.url));

export interface Candidate37ExecutionConfig {
  schema: "synthia-m4f-direct-nine-pid-cleanup-execution-37-config.v1";
  execution_id: typeof CANDIDATE37_ID;
  candidate35_config: Candidate35Config;
  candidate35_config_path: typeof CANDIDATE35_CONFIG_PATH;
  candidate35_config_sha256: string;
  candidate35_source_sha256: typeof CANDIDATE35_SOURCE_SHA256;
  candidate35_test_sha256: typeof CANDIDATE35_TEST_SHA256;
  candidate34_record_path: typeof CANDIDATE34_RECORD_PATH;
  candidate34_record_sha256: typeof CANDIDATE34_RECORD_SHA256;
  candidate34_source_sha256: typeof CANDIDATE34_SOURCE_SHA256;
  candidate34_test_sha256: typeof CANDIDATE34_TEST_SHA256;
  candidate31_record_path: typeof CANDIDATE31_RECORD_PATH;
  candidate31_record_sha256: typeof CANDIDATE31_RECORD_SHA256;
  candidate36_config_path: typeof CANDIDATE36_CONFIG_PATH;
  candidate36_config_sha256: string;
  candidate36_evidence_directory: typeof CANDIDATE36_EVIDENCE_DIRECTORY;
  candidate36_record_path: typeof CANDIDATE36_RECORD_PATH;
  candidate36_record_sha256: string;
  candidate36_manifest_path: typeof CANDIDATE36_MANIFEST_PATH;
  candidate36_manifest_sha256: string;
  candidate36_source_sha256: typeof CANDIDATE36_SOURCE_SHA256;
  candidate36_test_sha256: typeof CANDIDATE36_TEST_SHA256;
  transport_config_path: typeof TRANSPORT_CONFIG_PATH;
  transport_config_sha256: typeof TRANSPORT_CONFIG_SHA256;
  transport_source_sha256: typeof TRANSPORT_SOURCE_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  evidence_directory: string;
  effective_timeout_ms: typeof EFFECTIVE_TIMEOUT_MS;
  remote_timeout_ms: typeof REMOTE_TIMEOUT_MS;
}

export interface Candidate37FileFact {
  schema: "synthia-m4f-candidate37-local-file.v1";
  path: string;
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  sha256: string;
}

export interface Candidate37CapturedFile {
  bytes: Buffer;
  fact: Candidate37FileFact;
}

export interface Candidate37Dependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  captureFile(path: string): Candidate37CapturedFile;
  sourceFile(): Candidate37CapturedFile;
  testSourceFile(): Candidate37CapturedFile;
  candidate35SourceFile(): Candidate37CapturedFile;
  candidate35TestFile(): Candidate37CapturedFile;
  candidate34SourceFile(): Candidate37CapturedFile;
  candidate34TestFile(): Candidate37CapturedFile;
  candidate36SourceFile(): Candidate37CapturedFile;
  candidate36TestFile(): Candidate37CapturedFile;
  transportSourceFile(): Candidate37CapturedFile;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidenceDirectory(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate37Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE37_FAILED"));
  }
}

const CONFIG_KEYS = [
  "candidate31_record_path", "candidate31_record_sha256", "candidate34_record_path",
  "candidate34_record_sha256", "candidate34_source_sha256", "candidate34_test_sha256",
  "candidate35_config", "candidate35_config_path", "candidate35_config_sha256",
  "candidate35_source_sha256", "candidate35_test_sha256", "candidate36_config_path",
  "candidate36_config_sha256", "candidate36_evidence_directory", "candidate36_manifest_path",
  "candidate36_manifest_sha256", "candidate36_record_path", "candidate36_record_sha256",
  "candidate36_source_sha256", "candidate36_test_sha256", "effective_timeout_ms",
  "evidence_directory", "execution_id", "expected_source_sha256", "expected_test_sha256",
  "remote_timeout_ms", "schema", "transport_config_path", "transport_config_sha256",
  "transport_source_sha256",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJsonCandidate37(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonCandidate37).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonCandidate37(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value) && resolve(value) === value;
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new Candidate37Failure({
    schema: "synthia-m4f-direct-nine-pid-cleanup-execution-37-failure.v1",
    code,
    stage,
    status: "blocked",
    cleanup_complete: false,
    retry_permitted: false,
    automatic_retry_permitted: false,
    ...extra,
  });
}

export function validateCandidate37Config(value: unknown): Candidate37ExecutionConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-nine-pid-cleanup-execution-37-config.v1"
    || config.execution_id !== CANDIDATE37_ID || !SAFE_ID.test(config.execution_id)
    || config.candidate35_config_path !== CANDIDATE35_CONFIG_PATH
    || typeof config.candidate35_config_sha256 !== "string" || !HASH.test(config.candidate35_config_sha256)
    || config.candidate35_source_sha256 !== CANDIDATE35_SOURCE_SHA256
    || config.candidate35_test_sha256 !== CANDIDATE35_TEST_SHA256
    || config.candidate34_record_path !== CANDIDATE34_RECORD_PATH
    || config.candidate34_record_sha256 !== CANDIDATE34_RECORD_SHA256
    || config.candidate34_source_sha256 !== CANDIDATE34_SOURCE_SHA256
    || config.candidate34_test_sha256 !== CANDIDATE34_TEST_SHA256
    || config.candidate31_record_path !== CANDIDATE31_RECORD_PATH
    || config.candidate31_record_sha256 !== CANDIDATE31_RECORD_SHA256
    || config.candidate36_config_path !== CANDIDATE36_CONFIG_PATH
    || typeof config.candidate36_config_sha256 !== "string" || !HASH.test(config.candidate36_config_sha256)
    || config.candidate36_evidence_directory !== CANDIDATE36_EVIDENCE_DIRECTORY
    || config.candidate36_record_path !== CANDIDATE36_RECORD_PATH
    || typeof config.candidate36_record_sha256 !== "string" || !HASH.test(config.candidate36_record_sha256)
    || config.candidate36_manifest_path !== CANDIDATE36_MANIFEST_PATH
    || typeof config.candidate36_manifest_sha256 !== "string" || !HASH.test(config.candidate36_manifest_sha256)
    || config.candidate36_source_sha256 !== CANDIDATE36_SOURCE_SHA256
    || config.candidate36_test_sha256 !== CANDIDATE36_TEST_SHA256
    || config.transport_config_path !== TRANSPORT_CONFIG_PATH
    || config.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || config.transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_test_sha256 !== "string" || !HASH.test(config.expected_test_sha256)
    || !safePath(config.evidence_directory)
    || config.effective_timeout_ms !== EFFECTIVE_TIMEOUT_MS
    || config.remote_timeout_ms !== REMOTE_TIMEOUT_MS) {
    fail("M4F_CANDIDATE37_CONFIG_INVALID", "config");
  }
  let scriptConfig: Candidate35Config;
  try { scriptConfig = validateCandidate35Config(config.candidate35_config); } catch {
    fail("M4F_CANDIDATE37_C35_CONFIG_INVALID", "config");
  }
  if (scriptConfig.expected_source_sha256 !== CANDIDATE35_SOURCE_SHA256
    || scriptConfig.expected_test_sha256 !== CANDIDATE35_TEST_SHA256
    || scriptConfig.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || scriptConfig.candidate31_record_sha256 !== CANDIDATE31_RECORD_SHA256
    || scriptConfig.candidate34_record_sha256 !== CANDIDATE34_RECORD_SHA256) {
    fail("M4F_CANDIDATE37_C35_BINDING_INVALID", "config");
  }
  return value as Candidate37ExecutionConfig;
}

function decodeJson(bytes: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); } catch {
    fail(code, "local_preflight");
  }
}

function validFile(captured: Candidate37CapturedFile, path: string, expectedHash: string, sealed = false): void {
  const fact = captured.fact;
  if (fact.schema !== "synthia-m4f-candidate37-local-file.v1" || fact.path !== path
    || fact.sha256 !== expectedHash || sha256(captured.bytes) !== expectedHash
    || fact.owner_uid !== process.getuid?.() || fact.link_count !== 1 || fact.size !== captured.bytes.length
    || (sealed && fact.mode !== 0o600)) {
    fail("M4F_CANDIDATE37_INPUT_FILE_INVALID", "local_preflight", { path });
  }
}

function captureExpected(
  capture: () => Candidate37CapturedFile,
  path: string,
  expectedHash: string,
  sealed = false,
): Candidate37CapturedFile {
  let captured: Candidate37CapturedFile;
  try { captured = capture(); } catch { fail("M4F_CANDIDATE37_INPUT_FILE_MISSING", "local_preflight", { path }); }
  validFile(captured, path, expectedHash, sealed);
  return captured;
}

function validateCandidate34Record(bytes: Buffer): void {
  const record = object(decodeJson(bytes, "M4F_CANDIDATE37_C34_RECORD_INVALID"));
  const expectedPids = CANDIDATE35_TARGETS.map((target) => target.pid);
  if (!record || record.schema !== "synthia-m4f-direct-nine-pid-stale-parent-adjudication.v1"
    || record.decision !== "exact_stale_parent_boundary_adjudicated"
    || record.cleanup_derivation_permitted !== true || record.cleanup_execution_permitted !== false
    || record.cleanup_performed !== false || record.remote_execution_performed !== false
    || canonicalJsonCandidate37(record.exact_target_pids) !== canonicalJsonCandidate37(expectedPids)) {
    fail("M4F_CANDIDATE37_C34_RECORD_INVALID", "local_preflight");
  }
}

function contextFingerprint(context: ReturnType<typeof loadContext>): string {
  return sha256(canonicalJsonCandidate37({
    config: context.config,
    input_facts: context.inputFacts,
    transport_inputs: context.transportInputs,
    candidate35_plan: context.candidate35Plan,
    candidate35_confirmation: context.candidate35Confirmation,
    payload: {
      business_script_sha256: context.payload.business_script_sha256,
      business_script_length: context.payload.business_script_length,
      remote_command_sha256: context.payload.remote_command_sha256,
      remote_command_length: context.payload.remote_command_length,
    },
  }) + "\n");
}

function loadContext(rawConfig: unknown, dependencies: Candidate37Dependencies) {
  const config = validateCandidate37Config(rawConfig);
  const expected: Array<[string, string, () => Candidate37CapturedFile, boolean?]> = [
    [SOURCE_PATH, config.expected_source_sha256, dependencies.sourceFile],
    [TEST_PATH, config.expected_test_sha256, dependencies.testSourceFile],
    [C35_SOURCE_PATH, CANDIDATE35_SOURCE_SHA256, dependencies.candidate35SourceFile],
    [C35_TEST_PATH, CANDIDATE35_TEST_SHA256, dependencies.candidate35TestFile],
    [C34_SOURCE_PATH, CANDIDATE34_SOURCE_SHA256, dependencies.candidate34SourceFile],
    [C34_TEST_PATH, CANDIDATE34_TEST_SHA256, dependencies.candidate34TestFile],
    [C36_SOURCE_PATH, CANDIDATE36_SOURCE_SHA256, dependencies.candidate36SourceFile],
    [C36_TEST_PATH, CANDIDATE36_TEST_SHA256, dependencies.candidate36TestFile],
    [TRANSPORT_SOURCE_PATH, TRANSPORT_SOURCE_SHA256, dependencies.transportSourceFile],
    [CANDIDATE35_CONFIG_PATH, config.candidate35_config_sha256,
      () => dependencies.captureFile(CANDIDATE35_CONFIG_PATH), true],
    [CANDIDATE34_RECORD_PATH, CANDIDATE34_RECORD_SHA256,
      () => dependencies.captureFile(CANDIDATE34_RECORD_PATH), true],
    [CANDIDATE31_RECORD_PATH, CANDIDATE31_RECORD_SHA256,
      () => dependencies.captureFile(CANDIDATE31_RECORD_PATH), true],
    [CANDIDATE36_CONFIG_PATH, config.candidate36_config_sha256,
      () => dependencies.captureFile(CANDIDATE36_CONFIG_PATH), true],
    [CANDIDATE36_RECORD_PATH, config.candidate36_record_sha256,
      () => dependencies.captureFile(CANDIDATE36_RECORD_PATH), true],
    [CANDIDATE36_MANIFEST_PATH, config.candidate36_manifest_sha256,
      () => dependencies.captureFile(CANDIDATE36_MANIFEST_PATH), true],
    [TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
      () => dependencies.captureFile(TRANSPORT_CONFIG_PATH), true],
  ];
  const captured = expected.map(([path, hash, capture, sealed]) =>
    captureExpected(capture, path, hash, sealed));
  const byPath = new Map(captured.map((item) => [item.fact.path, item]));
  const scriptFile = byPath.get(CANDIDATE35_CONFIG_PATH)!;
  const decodedScriptConfig = validateCandidate35Config(decodeJson(
    scriptFile.bytes, "M4F_CANDIDATE37_C35_CONFIG_FILE_INVALID",
  ));
  if (canonicalJsonCandidate37(decodedScriptConfig) !== canonicalJsonCandidate37(config.candidate35_config)) {
    fail("M4F_CANDIDATE37_C35_CONFIG_FILE_MISMATCH", "local_preflight");
  }
  validateCandidate34Record(byPath.get(CANDIDATE34_RECORD_PATH)!.bytes);
  const transport = validateM4fDirectAdmissionConfig(decodeJson(
    byPath.get(TRANSPORT_CONFIG_PATH)!.bytes, "M4F_CANDIDATE37_TRANSPORT_CONFIG_INVALID",
  ));
  if (transport.target.host !== config.candidate35_config.target_host
    || transport.target.computer_name !== config.candidate35_config.target_computer
    || transport.target.identity_name !== config.candidate35_config.target_identity_name
    || transport.target.identity_sid !== config.candidate35_config.target_identity_sid
    || transport.target.expected_effective_config_sha256 === null) {
    fail("M4F_CANDIDATE37_TRANSPORT_BINDING_INVALID", "local_preflight");
  }
  const transportInputs = dependencies.transportInputs(transport, "local_preflight");
  const payload = buildCandidate35Payload(decodedScriptConfig);
  const candidate36Record = object(decodeJson(
    byPath.get(CANDIDATE36_RECORD_PATH)!.bytes, "M4F_CANDIDATE37_C36_RECORD_INVALID",
  ));
  const candidate36Result = object(candidate36Record?.gate_result);
  if (!candidate36Record || candidate36Record.gate_id !== "m4f-direct-nine-pid-cleanup-parse-helper-gate-20260901-36-r12"
    || candidate36Record.status !== "exact_target_parse_zero_and_pure_helpers_smoked"
    || candidate36Result?.status !== "exact_target_parse_zero_and_pure_helpers_smoked"
    || candidate36Result.parse_error_count !== 0 || candidate36Result.target_body_invoked !== false
    || candidate36Result.cim_executed !== false || candidate36Result.kill_executed !== false
    || candidate36Result.process_mutation_performed !== false
    || candidate36Result.target_script_sha256 !== payload.business_script_sha256
    || candidate36Result.target_gzip_sha256 !== sha256(payload.compressed_business_script)
    || candidate36Record.target_body_invoked !== false || candidate36Record.cim_executed !== false
    || candidate36Record.kill_executed !== false || candidate36Record.process_mutation_performed !== false
    || candidate36Record.vivado_action_performed !== false || candidate36Record.hardware_action_performed !== false
    || candidate36Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE37_C36_RECORD_INVALID", "local_preflight");
  }
  const candidate36Manifest = object(decodeJson(
    byPath.get(CANDIDATE36_MANIFEST_PATH)!.bytes, "M4F_CANDIDATE37_C36_MANIFEST_INVALID",
  ));
  if (!candidate36Manifest
    || candidate36Manifest["gate-record.json"] !== config.candidate36_record_sha256
    || candidate36Manifest["target-cleanup-script.ps1"] !== payload.business_script_sha256
    || candidate36Manifest["target-cleanup-script.ps1.gz"] !== sha256(payload.compressed_business_script)) {
    fail("M4F_CANDIDATE37_C36_MANIFEST_INVALID", "local_preflight");
  }
  return {
    config,
    scriptConfig: decodedScriptConfig,
    transport,
    payload,
    candidate35Plan: planCandidate35(decodedScriptConfig),
    candidate35Confirmation: candidate35Confirmation(decodedScriptConfig),
    inputFacts: captured.map((item) => item.fact),
    transportInputs,
  };
}

function buildPlan(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-nine-pid-cleanup-execution-37-plan.v1",
    execution_id: context.config.execution_id,
    status: "frozen_not_executed",
    target_host: TARGET_HOST,
    target_pids: CANDIDATE35_TARGETS.map((target) => target.pid),
    context_fingerprint: contextFingerprint(context),
    candidate35_config_sha256: context.config.candidate35_config_sha256,
    candidate35_source_sha256: CANDIDATE35_SOURCE_SHA256,
    candidate35_test_sha256: CANDIDATE35_TEST_SHA256,
    candidate35_plan_sha256: sha256(canonicalJsonCandidate37(context.candidate35Plan) + "\n"),
    candidate35_confirmation_sha256: sha256(context.candidate35Confirmation),
    candidate34_record_sha256: CANDIDATE34_RECORD_SHA256,
    candidate31_record_sha256: CANDIDATE31_RECORD_SHA256,
    candidate36_config_sha256: context.config.candidate36_config_sha256,
    candidate36_record_sha256: context.config.candidate36_record_sha256,
    candidate36_manifest_sha256: context.config.candidate36_manifest_sha256,
    transport_config_sha256: TRANSPORT_CONFIG_SHA256,
    effective_config_sha256: context.transport.target.expected_effective_config_sha256,
    business_script_sha256: context.payload.business_script_sha256,
    remote_command_sha256: context.payload.remote_command_sha256,
    ssh_effective_audit_count: 1,
    remote_attempt_count: 1,
    remote_stdin_length: 0,
    remote_stdin_sha256: EMPTY_SHA256,
    retry_permitted: false,
    automatic_retry_permitted: false,
    effect_ambiguity_policy: "permanent_partial_unknown",
    vivado_action_permitted: false,
    hardware_action_permitted: false,
  };
}

export function planCandidate37(rawConfig: unknown, dependencies: Candidate37Dependencies) {
  return buildPlan(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  const plan = buildPlan(context);
  return [
    "SYNTHIA_M4F_CANDIDATE37_AUTHORIZED_EXACT_NINE_PID_CLEANUP",
    context.config.execution_id,
    sha256(canonicalJsonCandidate37(context.config) + "\n"),
    sha256(canonicalJsonCandidate37(plan) + "\n"),
    contextFingerprint(context),
    context.payload.business_script_sha256,
    context.payload.remote_command_sha256,
    CANDIDATE34_RECORD_SHA256,
    CANDIDATE31_RECORD_SHA256,
    context.config.candidate36_record_sha256,
    TRANSPORT_CONFIG_SHA256,
  ].join(":");
}

export function candidate37Confirmation(rawConfig: unknown, dependencies: Candidate37Dependencies): string {
  return confirmationFor(loadContext(rawConfig, dependencies));
}

function processEvidence(raw: RawProcessResult): Record<string, unknown> {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT",
    outcome_ambiguous: raw.status !== 0 || raw.signal !== null || raw.errorCode !== null,
    stdin_length: 0,
    stdin_sha256: EMPTY_SHA256,
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function summarizeMarkers(stdout: Buffer, config: Candidate35Config) {
  const parsed = validateCandidate35MarkerPrefix(stdout, config);
  const effectStartOrdinals = parsed.markers
    .filter((marker) => marker.phase === "effect_start")
    .map((marker) => Number((marker.payload as Record<string, unknown>).ordinal));
  const effectResultOrdinals = parsed.markers
    .filter((marker) => marker.phase === "effect_result")
    .map((marker) => Number((marker.payload as Record<string, unknown>).ordinal));
  const unmatchedEffectStart = parsed.effect_ambiguity
    || effectStartOrdinals.length > effectResultOrdinals.length;
  return {
    parsed,
    summary: {
      marker_count: parsed.markers.length,
      phases: parsed.markers.map((marker) => marker.phase),
      valid_prefix_length: parsed.valid_prefix_length,
      valid_prefix_sha256: parsed.valid_prefix_sha256,
      trailing_fragment_length: parsed.trailing_fragment_length,
      trailing_fragment_sha256: parsed.trailing_fragment_sha256,
      effect_start_ordinals: effectStartOrdinals,
      effect_result_ordinals: effectResultOrdinals,
      unmatched_effect_start: unmatchedEffectStart,
      complete: parsed.complete,
      retry_permitted: false,
    },
  };
}

function writeEvidence(
  dependencies: Candidate37Dependencies,
  directory: string,
  name: string,
  value: string | Buffer,
): void {
  try {
    dependencies.writeEvidence(directory + "/" + name,
      Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE37_EVIDENCE_WRITE_FAILED", "evidence", { name });
  }
}

function assertNoContextDrift(
  initial: ReturnType<typeof loadContext>,
  observed: ReturnType<typeof loadContext>,
  initialTransport: unknown[],
  observedTransport: unknown[],
  stage: string,
): void {
  if (contextFingerprint(initial) !== contextFingerprint(observed)
    || canonicalJsonCandidate37(initialTransport) !== canonicalJsonCandidate37(observedTransport)) {
    fail("M4F_CANDIDATE37_INPUT_DRIFT", stage);
  }
}

export function executeCandidate37(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate37Dependencies,
): Record<string, unknown> {
  const context = loadContext(rawConfig, dependencies);
  const expectedConfirmation = confirmationFor(context);
  if (confirmation !== expectedConfirmation) {
    fail("M4F_CANDIDATE37_CONFIRMATION_REQUIRED", "local_preflight");
  }
  const directory = context.config.evidence_directory;
  try { dependencies.createEvidenceDirectory(directory); } catch {
    fail("M4F_CANDIDATE37_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  let remote: RawProcessResult | null = null;
  let marker: ReturnType<typeof summarizeMarkers> | null = null;
  let remoteAttempted = false;
  try {
    const plan = buildPlan(context);
    writeEvidence(dependencies, directory, "execution-config.canonical.json",
      canonicalJsonCandidate37(context.config) + "\n");
    writeEvidence(dependencies, directory, "plan.canonical.json",
      canonicalJsonCandidate37(plan) + "\n");
    writeEvidence(dependencies, directory, "confirmation.sha256", sha256(confirmation) + "\n");
    writeEvidence(dependencies, directory, "input-facts-initial.json",
      JSON.stringify(context.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, directory, "transport-inputs-initial.json",
      JSON.stringify(context.transportInputs, null, 2) + "\n");
    writeEvidence(dependencies, directory, "remote-command.json", JSON.stringify({
      length: context.payload.remote_command_length,
      sha256: context.payload.remote_command_sha256,
      stdin_length: 0,
      stdin_sha256: EMPTY_SHA256,
    }, null, 2) + "\n");

    const effective = dependencies.spawn(
      SSH_PATH,
      buildDirectSshEffectiveArguments(context.transport),
      Buffer.alloc(0),
      EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(dependencies, directory, "ssh-effective-stdout.raw", effective.stdout);
    writeEvidence(dependencies, directory, "ssh-effective-stderr.raw", effective.stderr);
    writeEvidence(dependencies, directory, "ssh-effective-process.json",
      JSON.stringify(processEvidence(effective), null, 2) + "\n");
    if (effective.stdout.length > MAX_STREAM_BYTES || effective.stderr.length > MAX_STREAM_BYTES
      || effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0
      || sha256(effective.stdout) !== context.transport.target.expected_effective_config_sha256) {
      fail("M4F_CANDIDATE37_EFFECTIVE_CONFIG_FAILED", "local_preflight");
    }
    auditDirectSshEffectiveConfig(effective.stdout, context.transport);

    const preContext = loadContext(context.config, dependencies);
    const preTransport = dependencies.transportInputs(context.transport, "network");
    writeEvidence(dependencies, directory, "input-facts-pre-remote.json",
      JSON.stringify(preContext.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, directory, "transport-inputs-pre-remote.json",
      JSON.stringify(preTransport, null, 2) + "\n");
    assertNoContextDrift(context, preContext, context.transportInputs, preTransport, "local_preflight");

    remoteAttempted = true;
    remote = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(context.transport), TARGET_HOST, context.payload.remote_command],
      Buffer.alloc(0),
      REMOTE_TIMEOUT_MS,
    );
    writeEvidence(dependencies, directory, "stdout.raw", remote.stdout);
    writeEvidence(dependencies, directory, "stderr.raw", remote.stderr);
    writeEvidence(dependencies, directory, "remote-process.json",
      JSON.stringify(processEvidence(remote), null, 2) + "\n");
    marker = summarizeMarkers(remote.stdout, context.scriptConfig);
    writeEvidence(dependencies, directory, "marker-prefix.raw",
      remote.stdout.subarray(0, marker.parsed.valid_prefix_length));
    writeEvidence(dependencies, directory, "marker-trailing.raw",
      remote.stdout.subarray(marker.parsed.valid_prefix_length));
    writeEvidence(dependencies, directory, "marker-summary.json",
      JSON.stringify(marker.summary, null, 2) + "\n");

    const postContext = loadContext(context.config, dependencies);
    const postTransport = dependencies.transportInputs(context.transport, "network");
    writeEvidence(dependencies, directory, "input-facts-post-remote.json",
      JSON.stringify(postContext.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, directory, "transport-inputs-post-remote.json",
      JSON.stringify(postTransport, null, 2) + "\n");
    assertNoContextDrift(context, postContext, context.transportInputs, postTransport, "network_postflight");

    const cleanProcess = remote.status === 0 && remote.signal === null && remote.errorCode === null;
    if (remote.stdout.length > MAX_STREAM_BYTES || remote.stderr.length > MAX_STREAM_BYTES
      || !cleanProcess || remote.stderr.length !== 0 || !marker.parsed.complete
      || marker.parsed.trailing_fragment_length !== 0) {
      const permanentOutcome = marker.summary.unmatched_effect_start
        ? "permanent_partial_unknown"
        : marker.summary.effect_start_ordinals.length > 0
          ? "permanent_failed_after_confirmed_effects"
          : "permanent_failed_no_effect_marker";
      fail("M4F_CANDIDATE37_REMOTE_NOT_COMPLETE", "network", {
        permanent_outcome: permanentOutcome,
        process: processEvidence(remote),
        marker: marker.summary,
      });
    }
    const record = {
      schema: "synthia-m4f-direct-nine-pid-cleanup-execution-37-record.v1",
      execution_id: context.config.execution_id,
      status: "cleanup_complete",
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(canonicalJsonCandidate37(context.config) + "\n"),
      plan_sha256: sha256(canonicalJsonCandidate37(plan) + "\n"),
      confirmation_sha256: sha256(confirmation),
      context_fingerprint: contextFingerprint(context),
      candidate35_config_sha256: context.config.candidate35_config_sha256,
      candidate34_record_sha256: CANDIDATE34_RECORD_SHA256,
      candidate31_record_sha256: CANDIDATE31_RECORD_SHA256,
      candidate36_record_sha256: context.config.candidate36_record_sha256,
      transport_config_sha256: TRANSPORT_CONFIG_SHA256,
      business_script_sha256: context.payload.business_script_sha256,
      remote_command_sha256: context.payload.remote_command_sha256,
      attempt: 1,
      process: processEvidence(remote),
      marker: marker.summary,
      cleanup_complete: true,
      retry_permitted: false,
      automatic_retry_permitted: false,
    };
    writeEvidence(dependencies, directory, "execution-record.json",
      JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    const base = error instanceof Candidate37Failure ? error.detail : {
      schema: "synthia-m4f-direct-nine-pid-cleanup-execution-37-failure.v1",
      code: "M4F_CANDIDATE37_UNEXPECTED",
      stage: remoteAttempted ? "network" : "local_preflight",
    };
    const unmatched = marker?.summary.unmatched_effect_start === true;
    const detail = {
      ...base,
      ...(unmatched ? { permanent_outcome: "permanent_partial_unknown" } : {}),
      cleanup_complete: false,
      retry_permitted: false,
      automatic_retry_permitted: false,
    };
    try {
      writeEvidence(dependencies, directory, "execution-failure.json", JSON.stringify({
        ...detail,
        execution_id: context.config.execution_id,
        attempt: remoteAttempted ? 1 : 0,
        remote_process: remote === null ? null : processEvidence(remote),
        marker: marker?.summary ?? null,
      }, null, 2) + "\n");
    } catch { /* preserve the primary failure */ }
    throw new Candidate37Failure(detail);
  }
}

function fileFact(path: string, stat: Stats, bytes: Buffer): Candidate37FileFact {
  return {
    schema: "synthia-m4f-candidate37-local-file.v1",
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
  };
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink();
}

export function captureCandidate37LocalFile(path: string): Candidate37CapturedFile {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not_regular");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleBefore = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const handleAfter = fstatSync(descriptor);
    const after = lstatSync(path);
    if (!sameStat(before, handleBefore) || !sameStat(handleBefore, handleAfter)
      || !sameStat(handleAfter, after)) throw new Error("file_drift");
    return { bytes, fact: fileFact(path, handleAfter, bytes) };
  } finally { closeSync(descriptor); }
}

export function createCandidate37EvidenceDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: false });
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o700) throw new Error("evidence_directory_untrusted");
}

export function writeCandidate37Evidence(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, "wx", 0o600);
  try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); }
  chmodSync(path, 0o600);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size !== bytes.length) {
    throw new Error("evidence_file_untrusted");
  }
}

const systemDependencies: Candidate37Dependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_STREAM_BYTES,
      encoding: "buffer",
      windowsHide: true,
    });
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
      stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  captureFile: captureCandidate37LocalFile,
  sourceFile: () => captureCandidate37LocalFile(SOURCE_PATH),
  testSourceFile: () => captureCandidate37LocalFile(TEST_PATH),
  candidate35SourceFile: () => captureCandidate37LocalFile(C35_SOURCE_PATH),
  candidate35TestFile: () => captureCandidate37LocalFile(C35_TEST_PATH),
  candidate34SourceFile: () => captureCandidate37LocalFile(C34_SOURCE_PATH),
  candidate34TestFile: () => captureCandidate37LocalFile(C34_TEST_PATH),
  candidate36SourceFile: () => captureCandidate37LocalFile(C36_SOURCE_PATH),
  candidate36TestFile: () => captureCandidate37LocalFile(C36_TEST_PATH),
  transportSourceFile: () => captureCandidate37LocalFile(TRANSPORT_SOURCE_PATH),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  createEvidenceDirectory: createCandidate37EvidenceDirectory,
  writeEvidence: writeCandidate37Evidence,
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const raw = JSON.parse(readFileSync(args[2]!, "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      process.stdout.write(JSON.stringify(planCandidate37(raw, systemDependencies)) + "\n");
      return;
    }
    if (args.length === 3 && args[0] === "--confirm") {
      process.stdout.write(JSON.stringify({ confirmation: candidate37Confirmation(raw, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate37(raw, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate37Failure ? error.detail : {
      schema: "synthia-m4f-direct-nine-pid-cleanup-execution-37-failure.v1",
      code: "M4F_CANDIDATE37_UNEXPECTED",
      cleanup_complete: false,
      retry_permitted: false,
      automatic_retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
