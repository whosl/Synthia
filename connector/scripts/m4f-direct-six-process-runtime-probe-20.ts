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
  readdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidate19GzipBindingProbe,
  canonicalJson19,
  validateCandidate19GzipBindingProbeResult,
  validateCandidate19ScriptConfig,
  type Candidate19ScriptConfig,
} from "./m4f-direct-six-process-cleanup-19.ts";
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
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 30_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const RUNTIME_PROBE_ID = "m4f-direct-six-process-runtime-probe-prod-20260830-20";
export const RUNTIME_PROBE_SCRIPT_CONFIG_PATH =
  "/private/tmp/synthia-m4f-direct-six-process-cleanup-v2-prod-20260830-20.json";
const SCRIPT_CONFIG_SHA256 = "be33526bfd69ed606a117af32538f2f18c6fe146f9551588d22e6b3191685b76";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const EXPECTED_EFFECTIVE_CONFIG_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";
const ATTEMPT1_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-six-process-execution-prod-20260829-19-evidence";
const ATTEMPT1_MANIFEST_SHA256 = "6ec0fa1374a3ac0c9d4301af340575a524de30fa1ddd939cb9675d21a39ee7ab";
const ATTEMPT1_FAILURE_SHA256 = "d94c496481f40ba10350e064cdecd3705a6508c507a1a9b3916759a9ec7e87cc";
const ATTEMPT1_STDERR_SHA256 = "9be4ad8649d740aab1e52ae01c54b3b94950f8403f8d8763bc4445b41c8ca19e";
const ATTEMPT1_REMOTE_PROCESS_SHA256 = "445aede4cabd315e5b2cebceb6660b1d5d53a6a0f4eb945aaf088e1dff0b66b4";
const ATTEMPT1_EXECUTION_CONFIG_SHA256 = "bdb81d3aaf1b598a60a05aa8ee711eef3bf66b817bd73891ad9ed7e86f0e1513";
const ATTEMPT1_PLAN_SHA256 = "9c6602b3a23e7a2b3a040e01cc6f1418ba977bebb3b2347df28c1280adfd05a8";
const C19_SOURCE_SHA256 = "17575ea5c61199697bd83b44fc9b6e7c6fbe4cb732341de4644eeae278cbf964";
const C19_TEST_SHA256 = "a61c2f18345afd2d06ca5352208538d1a4f4202573deb232babfbc301e7b8afb";
const C18_SOURCE_SHA256 = "8af29b1ca7920fece2ecbc678e0ef78f7e4170b15b02503bf8e34c4c15bb1f74";
const C18_TEST_SHA256 = "a4455da5701b76bc6f2091beb7b43f7b93934e3b47e9e46d420c1d908bee96d4";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-runtime-probe-20.test.ts", import.meta.url));
const C19_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-cleanup-19.ts", import.meta.url));
const C19_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-cleanup-19.test.ts", import.meta.url));
const C18_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-parse-only-18.ts", import.meta.url));
const C18_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-parse-only-18.test.ts", import.meta.url));
const TRANSPORT_SOURCE_PATH = fileURLToPath(new URL("./m4f-gate-admission-transport.ts", import.meta.url));

export const ATTEMPT1_EVIDENCE_MANIFEST = {
  "confirmation.sha256": "d22fbbbc17d18128667e1bd2e622541272be3aadcc58f9a9d81eb5a25f6d40d6",
  "execution-authorization-fact.json": "6d44235ed594c3b5f188b01d0bfdd8792483419e16e0d8355742985caf5ba074",
  "execution-authorization.raw.json": "99cc6860707b05ae302038f4020eec423b8881d3ed42644608ed6e4468f2cd12",
  "execution-config.canonical.json": ATTEMPT1_EXECUTION_CONFIG_SHA256,
  "execution-failure.json": ATTEMPT1_FAILURE_SHA256,
  "input-facts-initial.json": "7507303a86de2bb5268131583795402e921d3bf8a973282f55b102b084223a10",
  "input-facts-post-remote.json": "7507303a86de2bb5268131583795402e921d3bf8a973282f55b102b084223a10",
  "input-facts-pre-remote.json": "7507303a86de2bb5268131583795402e921d3bf8a973282f55b102b084223a10",
  "marker-prefix.raw": EMPTY_SHA256,
  "marker-summary.json": "d7a3ecbcf46f2d4151a3dde18ec50b11bc94ba20085d83d819d31c9545c1c21d",
  "marker-trailing.raw": EMPTY_SHA256,
  "plan.canonical.json": ATTEMPT1_PLAN_SHA256,
  "remote-command.json": "455a12626b0be6eba20477cbbb585c0cf01f52f024a17b14b2c5ffa7c20c4225",
  "remote-process.json": ATTEMPT1_REMOTE_PROCESS_SHA256,
  "ssh-effective-process.json": "a19bf21c19054ccff10759bc6ac0d596ea7fa5fb75c5327cd378c714358c7256",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EXPECTED_EFFECTIVE_CONFIG_SHA256,
  "stderr.raw": ATTEMPT1_STDERR_SHA256,
  "stdout.raw": EMPTY_SHA256,
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

export interface Candidate19RuntimeProbeConfig {
  schema: "synthia-m4f-candidate19-runtime-probe-config.v1";
  probe_id: typeof RUNTIME_PROBE_ID;
  script_config: Candidate19ScriptConfig;
  script_config_path: typeof RUNTIME_PROBE_SCRIPT_CONFIG_PATH;
  script_config_sha256: typeof SCRIPT_CONFIG_SHA256;
  transport_config_path: typeof TRANSPORT_CONFIG_PATH;
  transport_config_sha256: typeof TRANSPORT_CONFIG_SHA256;
  attempt1_evidence_directory: typeof ATTEMPT1_EVIDENCE_DIRECTORY;
  attempt1_evidence_manifest_sha256: typeof ATTEMPT1_MANIFEST_SHA256;
  attempt1_failure_sha256: typeof ATTEMPT1_FAILURE_SHA256;
  attempt1_stderr_sha256: typeof ATTEMPT1_STDERR_SHA256;
  attempt1_remote_process_sha256: typeof ATTEMPT1_REMOTE_PROCESS_SHA256;
  attempt1_execution_config_sha256: typeof ATTEMPT1_EXECUTION_CONFIG_SHA256;
  attempt1_plan_sha256: typeof ATTEMPT1_PLAN_SHA256;
  expected_c19_source_sha256: typeof C19_SOURCE_SHA256;
  expected_c19_test_sha256: typeof C19_TEST_SHA256;
  expected_c18_source_sha256: typeof C18_SOURCE_SHA256;
  expected_c18_test_sha256: typeof C18_TEST_SHA256;
  expected_transport_source_sha256: typeof TRANSPORT_SOURCE_SHA256;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  evidence_directory: string;
  effective_timeout_ms: typeof EFFECTIVE_TIMEOUT_MS;
  remote_timeout_ms: typeof REMOTE_TIMEOUT_MS;
}

export interface Candidate19RuntimeProbeFileFact {
  schema: "synthia-m4f-candidate19-runtime-probe-local-file.v1";
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

export interface Candidate19RuntimeProbeCapturedFile {
  bytes: Buffer;
  fact: Candidate19RuntimeProbeFileFact;
}

export interface Candidate19RuntimeProbeDirectoryFact {
  path: string;
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  mtime_ms: number;
  ctime_ms: number;
  entries: string[];
}

export interface Candidate19RuntimeProbeDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  captureFile(path: string): Candidate19RuntimeProbeCapturedFile;
  captureDirectory(path: string): Candidate19RuntimeProbeDirectoryFact;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidenceDirectory(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate19RuntimeProbeFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE19_RUNTIME_PROBE_FAILED"));
  }
}

const CONFIG_KEYS = [
  "attempt1_evidence_directory", "attempt1_evidence_manifest_sha256",
  "attempt1_execution_config_sha256", "attempt1_failure_sha256", "attempt1_plan_sha256",
  "attempt1_remote_process_sha256", "attempt1_stderr_sha256", "effective_timeout_ms",
  "evidence_directory", "expected_c18_source_sha256", "expected_c18_test_sha256",
  "expected_c19_source_sha256", "expected_c19_test_sha256", "expected_source_sha256",
  "expected_test_source_sha256", "expected_transport_source_sha256", "probe_id",
  "remote_timeout_ms", "schema", "script_config", "script_config_path",
  "script_config_sha256", "transport_config_path", "transport_config_sha256",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJsonRuntimeProbe(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonRuntimeProbe).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonRuntimeProbe(item)).join(",") + "}";
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
  throw new Candidate19RuntimeProbeFailure({
    schema: "synthia-m4f-candidate19-runtime-probe-failure.v1",
    code,
    stage,
    effect_state: "no_business_invocation_permitted",
    retry_permitted: false,
    cleanup_performed: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    ...extra,
  });
}

export function validateCandidate19RuntimeProbeConfig(
  value: unknown,
): Candidate19RuntimeProbeConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-candidate19-runtime-probe-config.v1"
    || config.probe_id !== RUNTIME_PROBE_ID || !SAFE_ID.test(String(config.probe_id))
    || config.script_config_path !== RUNTIME_PROBE_SCRIPT_CONFIG_PATH
    || config.script_config_sha256 !== SCRIPT_CONFIG_SHA256
    || config.transport_config_path !== TRANSPORT_CONFIG_PATH
    || config.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || config.attempt1_evidence_directory !== ATTEMPT1_EVIDENCE_DIRECTORY
    || config.attempt1_evidence_manifest_sha256 !== ATTEMPT1_MANIFEST_SHA256
    || config.attempt1_failure_sha256 !== ATTEMPT1_FAILURE_SHA256
    || config.attempt1_stderr_sha256 !== ATTEMPT1_STDERR_SHA256
    || config.attempt1_remote_process_sha256 !== ATTEMPT1_REMOTE_PROCESS_SHA256
    || config.attempt1_execution_config_sha256 !== ATTEMPT1_EXECUTION_CONFIG_SHA256
    || config.attempt1_plan_sha256 !== ATTEMPT1_PLAN_SHA256
    || config.expected_c19_source_sha256 !== C19_SOURCE_SHA256
    || config.expected_c19_test_sha256 !== C19_TEST_SHA256
    || config.expected_c18_source_sha256 !== C18_SOURCE_SHA256
    || config.expected_c18_test_sha256 !== C18_TEST_SHA256
    || config.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_test_source_sha256 !== "string" || !HASH.test(config.expected_test_source_sha256)
    || !safePath(config.evidence_directory)
    || config.evidence_directory === ATTEMPT1_EVIDENCE_DIRECTORY
    || config.effective_timeout_ms !== EFFECTIVE_TIMEOUT_MS
    || config.remote_timeout_ms !== REMOTE_TIMEOUT_MS) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_CONFIG_INVALID", "config");
  }
  try { validateCandidate19ScriptConfig(config.script_config); } catch {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_CONFIG_INVALID", "config");
  }
  return value as Candidate19RuntimeProbeConfig;
}

function decodeJson(bytes: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    fail(code, "local_preflight");
  }
}

function validateFile(
  captured: Candidate19RuntimeProbeCapturedFile,
  path: string,
  expectedSha256: string,
): void {
  const fact = captured?.fact;
  if (!Buffer.isBuffer(captured?.bytes) || !fact
    || fact.schema !== "synthia-m4f-candidate19-runtime-probe-local-file.v1"
    || fact.path !== path || fact.sha256 !== expectedSha256
    || sha256(captured.bytes) !== expectedSha256 || fact.size !== captured.bytes.length
    || fact.link_count !== 1 || ![0o600, 0o644].includes(fact.mode)
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count, fact.size,
      fact.mtime_ms, fact.ctime_ms].every((item) => Number.isFinite(item) && item >= 0)) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_INPUT_INVALID", "local_preflight", { path });
  }
}

function captureExpected(
  dependencies: Candidate19RuntimeProbeDependencies,
  path: string,
  expectedSha256: string,
): Candidate19RuntimeProbeCapturedFile {
  let captured: Candidate19RuntimeProbeCapturedFile;
  try { captured = dependencies.captureFile(path); } catch {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_INPUT_MISSING", "local_preflight", { path });
  }
  validateFile(captured, path, expectedSha256);
  return captured;
}

function validateAttempt1Failure(bytes: Buffer): void {
  const failure = object(decodeJson(bytes, "M4F_CANDIDATE19_RUNTIME_PROBE_ATTEMPT1_INVALID"));
  const process = object(failure?.remote_process);
  const marker = object(failure?.marker);
  if (!failure || failure.schema !== "synthia-m4f-candidate19-execution-failure.v1"
    || failure.code !== "M4F_CANDIDATE19_EXECUTION_PARTIAL_OR_FAILED"
    || failure.stage !== "network" || failure.attempt !== 1 || failure.retry_permitted !== false
    || failure.effect_state !== "no_effect_marker_observed" || failure.cleanup_complete !== false
    || !process || process.exit_status !== 1 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.outcome_ambiguous !== false
    || process.stdout_length !== 0 || process.stdout_sha256 !== EMPTY_SHA256
    || process.stderr_length !== 383 || process.stderr_sha256 !== ATTEMPT1_STDERR_SHA256
    || !marker || marker.marker_count !== 0 || marker.complete !== false
    || !Array.isArray(marker.effect_start_ordinals) || marker.effect_start_ordinals.length !== 0
    || !Array.isArray(marker.effect_result_ordinals) || marker.effect_result_ordinals.length !== 0) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_ATTEMPT1_INVALID", "local_preflight");
  }
}

function sourceBindings(
  config: Candidate19RuntimeProbeConfig,
  dependencies: Candidate19RuntimeProbeDependencies,
): Candidate19RuntimeProbeFileFact[] {
  const bindings: Array<[string, string]> = [
    [SOURCE_PATH, config.expected_source_sha256],
    [TEST_PATH, config.expected_test_source_sha256],
    [C19_SOURCE_PATH, C19_SOURCE_SHA256],
    [C19_TEST_PATH, C19_TEST_SHA256],
    [C18_SOURCE_PATH, C18_SOURCE_SHA256],
    [C18_TEST_PATH, C18_TEST_SHA256],
    [TRANSPORT_SOURCE_PATH, TRANSPORT_SOURCE_SHA256],
  ];
  return bindings.map(([path, hash]) => captureExpected(dependencies, path, hash).fact);
}

function attempt1Bindings(dependencies: Candidate19RuntimeProbeDependencies) {
  const directoryBefore = dependencies.captureDirectory(ATTEMPT1_EVIDENCE_DIRECTORY);
  const names = Object.keys(ATTEMPT1_EVIDENCE_MANIFEST).sort();
  if (directoryBefore.path !== ATTEMPT1_EVIDENCE_DIRECTORY
    || canonicalJsonRuntimeProbe(directoryBefore.entries) !== canonicalJsonRuntimeProbe(names)) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_ATTEMPT1_DIRECTORY_INVALID", "local_preflight");
  }
  const facts = names.map((name) => captureExpected(
    dependencies,
    ATTEMPT1_EVIDENCE_DIRECTORY + "/" + name,
    ATTEMPT1_EVIDENCE_MANIFEST[name as keyof typeof ATTEMPT1_EVIDENCE_MANIFEST],
  ).fact);
  if (sha256(canonicalJsonRuntimeProbe(ATTEMPT1_EVIDENCE_MANIFEST) + "\n")
    !== ATTEMPT1_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_ATTEMPT1_MANIFEST_INVALID", "local_preflight");
  }
  validateAttempt1Failure(captureExpected(
    dependencies,
    ATTEMPT1_EVIDENCE_DIRECTORY + "/execution-failure.json",
    ATTEMPT1_FAILURE_SHA256,
  ).bytes);
  const directoryAfter = dependencies.captureDirectory(ATTEMPT1_EVIDENCE_DIRECTORY);
  if (canonicalJsonRuntimeProbe(directoryAfter) !== canonicalJsonRuntimeProbe(directoryBefore)) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_ATTEMPT1_DRIFT", "local_preflight");
  }
  return { directory: directoryAfter, facts };
}

function loadContext(
  rawConfig: unknown,
  dependencies: Candidate19RuntimeProbeDependencies,
) {
  const config = validateCandidate19RuntimeProbeConfig(rawConfig);
  const sources = sourceBindings(config, dependencies);
  const scriptFile = captureExpected(dependencies, RUNTIME_PROBE_SCRIPT_CONFIG_PATH, SCRIPT_CONFIG_SHA256);
  const canonicalScript = Buffer.from(canonicalJson19(config.script_config) + "\n");
  if (!scriptFile.bytes.equals(canonicalScript)) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_SCRIPT_CONFIG_SPLIT_BRAIN", "local_preflight");
  }
  const scriptConfig = validateCandidate19ScriptConfig(decodeJson(
    scriptFile.bytes, "M4F_CANDIDATE19_RUNTIME_PROBE_SCRIPT_CONFIG_INVALID",
  ));
  if (canonicalJson19(scriptConfig) !== canonicalJson19(config.script_config)) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_SCRIPT_CONFIG_SPLIT_BRAIN", "local_preflight");
  }
  const transportFile = captureExpected(dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256);
  const transport = validateM4fDirectAdmissionConfig(decodeJson(
    transportFile.bytes, "M4F_CANDIDATE19_RUNTIME_PROBE_TRANSPORT_INVALID",
  ));
  if (transport.target.host !== TARGET_HOST || transport.target.user !== "admin"
    || transport.target.computer_name !== scriptConfig.target_computer
    || transport.target.identity_name !== scriptConfig.target_identity_name
    || transport.target.identity_sid !== scriptConfig.target_identity_sid
    || transport.target.expected_effective_config_sha256 !== EXPECTED_EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_TRANSPORT_INVALID", "local_preflight");
  }
  const attempt1 = attempt1Bindings(dependencies);
  const probe = buildCandidate19GzipBindingProbe(scriptConfig);
  return {
    config,
    scriptConfig,
    transport,
    probe,
    inputFacts: [...sources, scriptFile.fact, transportFile.fact, ...attempt1.facts],
    attempt1Directory: attempt1.directory,
  };
}

function buildPlan(context: ReturnType<typeof loadContext>) {
  const probe = context.probe;
  return {
    schema: "synthia-m4f-candidate19-runtime-probe-plan.v1",
    probe_id: context.config.probe_id,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "single_ssh_direct_encoded_command_binary_stdin",
    script_config_path: RUNTIME_PROBE_SCRIPT_CONFIG_PATH,
    script_config_sha256: SCRIPT_CONFIG_SHA256,
    transport_config_path: TRANSPORT_CONFIG_PATH,
    transport_config_sha256: TRANSPORT_CONFIG_SHA256,
    attempt1_evidence_directory: ATTEMPT1_EVIDENCE_DIRECTORY,
    attempt1_evidence_manifest_sha256: ATTEMPT1_MANIFEST_SHA256,
    attempt1_failure_sha256: ATTEMPT1_FAILURE_SHA256,
    effective_audit_count: 1,
    remote_attempt_count: 1,
    retry_permitted: false,
    probe_command_length: probe.command_length,
    probe_command_sha256: sha256(Buffer.from(probe.command, "ascii")),
    probe_script_sha256: probe.script_sha256,
    remote_stdin_length: probe.stdin_length,
    remote_stdin_sha256: probe.stdin_sha256,
    expected_business_length: probe.expected_business_length,
    expected_business_sha256: probe.expected_business_sha256,
    script_block_created: true,
    target_body_invoked: false,
    business_invocation_permitted: false,
    cim_query_permitted: false,
    process_mutation_permitted: false,
    file_mutation_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
  };
}

function contextFingerprint(context: ReturnType<typeof loadContext>): string {
  return sha256(canonicalJsonRuntimeProbe({
    config: context.config,
    plan: buildPlan(context),
    input_facts: context.inputFacts,
    attempt1_directory: context.attempt1Directory,
    transport_inputs: context.transport,
  }) + "\n");
}

export function planCandidate19RuntimeProbe(
  rawConfig: unknown,
  dependencies: Candidate19RuntimeProbeDependencies,
): Record<string, unknown> {
  return buildPlan(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  const plan = buildPlan(context);
  return [
    "SYNTHIA_M4F_CANDIDATE19_EXACT_RUNTIME_PROBE_ONLY",
    context.config.probe_id,
    sha256(canonicalJsonRuntimeProbe(context.config) + "\n"),
    sha256(canonicalJsonRuntimeProbe(plan) + "\n"),
    context.config.expected_source_sha256,
    context.config.expected_test_source_sha256,
    SCRIPT_CONFIG_SHA256,
    TRANSPORT_CONFIG_SHA256,
    ATTEMPT1_MANIFEST_SHA256,
    context.probe.script_sha256,
    sha256(Buffer.from(context.probe.command, "ascii")),
    context.probe.stdin_sha256,
    context.probe.expected_business_sha256,
  ].join(":");
}

export function candidate19RuntimeProbeConfirmation(
  rawConfig: unknown,
  dependencies: Candidate19RuntimeProbeDependencies,
): string {
  return confirmationFor(loadContext(rawConfig, dependencies));
}

function processEvidence(raw: RawProcessResult, stdin: Buffer) {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT",
    outcome_ambiguous: raw.status === null || raw.signal !== null || raw.errorCode !== null,
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function writeEvidence(
  dependencies: Candidate19RuntimeProbeDependencies,
  directory: string,
  name: string,
  value: string | Buffer,
): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate19RuntimeProbe(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: Candidate19RuntimeProbeDependencies,
): Record<string, unknown> {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_CONFIRMATION_REQUIRED", "local_preflight");
  }
  if (evidenceDirectory !== context.config.evidence_directory || resolve(evidenceDirectory) !== evidenceDirectory) {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_EVIDENCE_PATH_INVALID", "local_preflight");
  }
  const initialTransport = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidenceDirectory(evidenceDirectory); } catch {
    fail("M4F_CANDIDATE19_RUNTIME_PROBE_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  let remote: RawProcessResult | null = null;
  let remoteAttempted = false;
  try {
    const plan = buildPlan(context);
    writeEvidence(dependencies, evidenceDirectory, "probe-config.canonical.json",
      canonicalJsonRuntimeProbe(context.config) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "plan.canonical.json",
      canonicalJsonRuntimeProbe(plan) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "confirmation.sha256", sha256(confirmation) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "attempt1-manifest.canonical.json",
      canonicalJsonRuntimeProbe(ATTEMPT1_EVIDENCE_MANIFEST) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "input-facts-initial.json",
      JSON.stringify(context.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "transport-inputs-initial.json",
      JSON.stringify(initialTransport, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "remote-command.json", JSON.stringify({
      command_length: context.probe.command_length,
      command_sha256: sha256(Buffer.from(context.probe.command, "ascii")),
      script_sha256: context.probe.script_sha256,
      stdin_length: context.probe.stdin_length,
      stdin_sha256: context.probe.stdin_sha256,
    }, null, 2) + "\n");

    const effective = dependencies.spawn(
      SSH_PATH,
      buildDirectSshEffectiveArguments(context.transport),
      Buffer.alloc(0),
      EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(dependencies, evidenceDirectory, "ssh-effective-stdout.raw", effective.stdout);
    writeEvidence(dependencies, evidenceDirectory, "ssh-effective-stderr.raw", effective.stderr);
    writeEvidence(dependencies, evidenceDirectory, "ssh-effective-process.json",
      JSON.stringify(processEvidence(effective, Buffer.alloc(0)), null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0 || sha256(effective.stdout) !== EXPECTED_EFFECTIVE_CONFIG_SHA256) {
      fail("M4F_CANDIDATE19_RUNTIME_PROBE_EFFECTIVE_CONFIG_FAILED", "local_preflight");
    }
    auditDirectSshEffectiveConfig(effective.stdout, context.transport);

    const beforeRemote = loadContext(context.config, dependencies);
    const beforeRemoteTransport = dependencies.transportInputs(context.transport, "network");
    if (contextFingerprint(beforeRemote) !== contextFingerprint(context)
      || canonicalJsonRuntimeProbe(initialTransport) !== canonicalJsonRuntimeProbe(beforeRemoteTransport)) {
      fail("M4F_CANDIDATE19_RUNTIME_PROBE_INPUT_DRIFT", "local_preflight");
    }
    writeEvidence(dependencies, evidenceDirectory, "input-facts-pre-remote.json",
      JSON.stringify(beforeRemote.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "transport-inputs-pre-remote.json",
      JSON.stringify(beforeRemoteTransport, null, 2) + "\n");

    remoteAttempted = true;
    remote = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(context.transport), TARGET_HOST, context.probe.command],
      context.probe.stdin,
      REMOTE_TIMEOUT_MS,
    );
    writeEvidence(dependencies, evidenceDirectory, "stdout.raw", remote.stdout);
    writeEvidence(dependencies, evidenceDirectory, "stderr.raw", remote.stderr);
    writeEvidence(dependencies, evidenceDirectory, "remote-process.json",
      JSON.stringify(processEvidence(remote, context.probe.stdin), null, 2) + "\n");

    const afterRemote = loadContext(context.config, dependencies);
    const afterRemoteTransport = dependencies.transportInputs(context.transport, "network");
    writeEvidence(dependencies, evidenceDirectory, "input-facts-post-remote.json",
      JSON.stringify(afterRemote.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "transport-inputs-post-remote.json",
      JSON.stringify(afterRemoteTransport, null, 2) + "\n");
    if (contextFingerprint(afterRemote) !== contextFingerprint(context)
      || canonicalJsonRuntimeProbe(initialTransport) !== canonicalJsonRuntimeProbe(afterRemoteTransport)) {
      fail("M4F_CANDIDATE19_RUNTIME_PROBE_POSTFLIGHT_INPUT_DRIFT", "network_postflight");
    }

    if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
      fail("M4F_CANDIDATE19_RUNTIME_PROBE_REMOTE_PROCESS_FAILED", "network", {
        process: processEvidence(remote, context.probe.stdin),
      });
    }
    if (remote.stderr.length !== 0) {
      fail("M4F_CANDIDATE19_RUNTIME_PROBE_STDERR_REJECTED", "network", {
        process: processEvidence(remote, context.probe.stdin),
      });
    }
    let probeResult: Record<string, unknown>;
    try {
      probeResult = validateCandidate19GzipBindingProbeResult(remote.stdout, context.probe);
    } catch {
      fail("M4F_CANDIDATE19_RUNTIME_PROBE_STDOUT_INVALID", "network", {
        process: processEvidence(remote, context.probe.stdin),
      });
    }
    const record = {
      schema: "synthia-m4f-candidate19-runtime-probe-record.v1",
      probe_id: context.config.probe_id,
      status: "gzip_constructor_and_decompress_bound",
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(canonicalJsonRuntimeProbe(context.config) + "\n"),
      plan_sha256: sha256(canonicalJsonRuntimeProbe(plan) + "\n"),
      confirmation_sha256: sha256(confirmation),
      context_fingerprint: contextFingerprint(context),
      attempt: 1,
      process: processEvidence(remote, context.probe.stdin),
      probe_result: probeResult,
      script_block_created: true,
      target_body_invoked: false,
      retry_permitted: false,
      cleanup_performed: false,
      process_mutation_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
    };
    writeEvidence(dependencies, evidenceDirectory, "probe-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    const detail = error instanceof Candidate19RuntimeProbeFailure ? error.detail : {
      schema: "synthia-m4f-candidate19-runtime-probe-failure.v1",
      code: "M4F_CANDIDATE19_RUNTIME_PROBE_UNEXPECTED",
      stage: remoteAttempted ? "network" : "local_preflight",
      effect_state: "no_business_invocation_permitted",
      retry_permitted: false,
      cleanup_performed: false,
      process_mutation_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
    };
    try {
      writeEvidence(dependencies, evidenceDirectory, "probe-failure.json", JSON.stringify({
        ...detail,
        probe_id: context.config.probe_id,
        attempt: remoteAttempted ? 1 : 0,
        remote_process: remote === null ? null : processEvidence(remote, context.probe.stdin),
        retry_permitted: false,
      }, null, 2) + "\n");
    } catch { /* Preserve the primary failure. */ }
    throw new Candidate19RuntimeProbeFailure(detail);
  }
}

function fact(path: string, stat: Stats, bytes: Buffer): Candidate19RuntimeProbeFileFact {
  return {
    schema: "synthia-m4f-candidate19-runtime-probe-local-file.v1",
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

function captureLocalFile(path: string): Candidate19RuntimeProbeCapturedFile {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not_regular");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleBefore = fstatSync(fd);
    const bytes = readFileSync(fd);
    const handleAfter = fstatSync(fd);
    const after = lstatSync(path);
    if (!sameStat(before, handleBefore) || !sameStat(handleBefore, handleAfter)
      || !sameStat(handleAfter, after)) throw new Error("file_drift");
    return { bytes, fact: fact(path, handleAfter, bytes) };
  } finally { closeSync(fd); }
}

function captureLocalDirectory(path: string): Candidate19RuntimeProbeDirectoryFact {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("not_directory");
  const entries = readdirSync(path).sort();
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs) throw new Error("directory_drift");
  return {
    path,
    device: after.dev,
    inode: after.ino,
    owner_uid: after.uid,
    mode: after.mode & 0o777,
    link_count: after.nlink,
    mtime_ms: after.mtimeMs,
    ctime_ms: after.ctimeMs,
    entries,
  };
}

const systemDependencies: Candidate19RuntimeProbeDependencies = {
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
  captureFile: captureLocalFile,
  captureDirectory: captureLocalDirectory,
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  createEvidenceDirectory(path) { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); },
  writeEvidence(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    chmodSync(path, 0o600);
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const raw = JSON.parse(readFileSync(args[2]!, "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      const plan = planCandidate19RuntimeProbe(raw, systemDependencies);
      process.stdout.write(JSON.stringify({
        ...plan,
        config_sha256: sha256(canonicalJsonRuntimeProbe(raw) + "\n"),
        plan_sha256: sha256(canonicalJsonRuntimeProbe(plan) + "\n"),
        final_confirmation_issued: false,
      }) + "\n");
      return;
    }
    if (args.length === 3 && args[0] === "--confirm") {
      process.stdout.write(JSON.stringify({
        confirmation: candidate19RuntimeProbeConfirmation(raw, systemDependencies),
      }) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      process.stdout.write(JSON.stringify(executeCandidate19RuntimeProbe(
        raw, args[4]!, args[6]!, systemDependencies,
      )) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate19RuntimeProbeFailure ? error.detail : {
      schema: "synthia-m4f-candidate19-runtime-probe-failure.v1",
      code: "M4F_CANDIDATE19_RUNTIME_PROBE_UNEXPECTED",
      effect_state: "no_business_invocation_permitted",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
