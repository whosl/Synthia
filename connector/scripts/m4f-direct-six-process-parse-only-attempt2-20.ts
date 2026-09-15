import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Candidate18Failure,
  buildCandidate18Payload,
  candidate18Confirmation,
  executeCandidate18,
  planCandidate18,
  validateCandidate18Config,
  validateCandidate18Result,
  type Candidate18CapturedFile,
  type Candidate18Config,
  type Candidate18Dependencies,
  type Candidate18FileFact,
} from "./m4f-direct-six-process-parse-only-18.ts";
import {
  validateCandidate19ScriptConfig,
} from "./m4f-direct-six-process-cleanup-19.ts";
import { parseCandidate18BenignCliXml } from "./m4f-direct-six-process-parse-adjudicator-18.ts";
import {
  captureM4fDirectTransportInputs,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
} from "./m4f-gate-admission-transport.ts";
import { spawnSync } from "node:child_process";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
export const ATTEMPT2_LINEAGE_ID = "m4f-direct-six-process-parse-only-attempt2-prod-20260830-20";
export const ATTEMPT2_PARSE_CONFIG_PATH =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20.json";
export const ATTEMPT2_EVIDENCE_DIRECTORY =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-evidence";
export const ATTEMPT2_ADJUDICATION_PATH =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-adjudication.json";
export const ATTEMPT2_REVIEW_PATH =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-review.json";
const RUNTIME_PROBE_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-six-process-runtime-probe-prod-20260830-20-evidence";
const RUNTIME_PROBE_MANIFEST_PATH =
  "/private/tmp/m4f-direct-six-process-runtime-probe-prod-20260830-20-evidence-manifest.json";
const RUNTIME_PROBE_MANIFEST_SHA256 = "29e9d293190f91285e4237a31d5e19ab705f3d1105f7c4aa8e0ffda57d4026da";
const RUNTIME_PROBE_RECORD_SHA256 = "82853ed927ee71661b359dcf397109ed209dca1e4a3d6ab2ee7f28f5251cb70f";
const C18_SOURCE_SHA256 = "8af29b1ca7920fece2ecbc678e0ef78f7e4170b15b02503bf8e34c4c15bb1f74";
const C18_TEST_SHA256 = "a4455da5701b76bc6f2091beb7b43f7b93934e3b47e9e46d420c1d908bee96d4";
const C19_SOURCE_SHA256 = "17575ea5c61199697bd83b44fc9b6e7c6fbe4cb732341de4644eeae278cbf964";
const C19_TEST_SHA256 = "a61c2f18345afd2d06ca5352208538d1a4f4202573deb232babfbc301e7b8afb";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-parse-only-attempt2-20.test.ts", import.meta.url));
const C18_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-parse-only-18.ts", import.meta.url));
const C18_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-parse-only-18.test.ts", import.meta.url));
const C19_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-cleanup-19.ts", import.meta.url));
const C19_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-cleanup-19.test.ts", import.meta.url));
const C19_DOC_PATH = fileURLToPath(new URL("../M4F-DIRECT-SIX-PROCESS-CLEANUP-18-19.md", import.meta.url));
const TRANSPORT_SOURCE_PATH = fileURLToPath(new URL("./m4f-gate-admission-transport.ts", import.meta.url));

const RUNTIME_PROBE_MANIFEST = {
  "attempt1-manifest.canonical.json": "6ec0fa1374a3ac0c9d4301af340575a524de30fa1ddd939cb9675d21a39ee7ab",
  "confirmation.sha256": "6ba84f5794edf65861b38fec9a7b33662fddb1b1935a3e2590799836f672f037",
  "input-facts-initial.json": "3790809e70f27cb03f4a985ef6884f8ca5096515bee647f4b805619e6b2e9071",
  "input-facts-post-remote.json": "3790809e70f27cb03f4a985ef6884f8ca5096515bee647f4b805619e6b2e9071",
  "input-facts-pre-remote.json": "3790809e70f27cb03f4a985ef6884f8ca5096515bee647f4b805619e6b2e9071",
  "plan.canonical.json": "252e4374d732a93df21b04f7a4d3ee98bc1198cde13527e39a4b8d4249964862",
  "probe-config.canonical.json": "66c4a394258352460b66f28388b47c862739d93b1fb88eee1528afee674ff1ec",
  "probe-record.json": RUNTIME_PROBE_RECORD_SHA256,
  "remote-command.json": "2953414526ff07312e475035ba00257f0732033970ac095922dd9dbee2ef0889",
  "remote-process.json": "82fa799a535e0bacc78e88017267ed8c07368b1f48389d927593dee427ff1a74",
  "ssh-effective-process.json": "a19bf21c19054ccff10759bc6ac0d596ea7fa5fb75c5327cd378c714358c7256",
  "ssh-effective-stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "ssh-effective-stdout.raw": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90",
  "stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "stdout.raw": "1b1320e6aa5b807475461db39536a498cd67f13b27f9be3770f79bc312922671",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

export interface Attempt2LineageConfig {
  schema: "synthia-m4f-candidate18-attempt2-lineage-config.v1";
  lineage_id: typeof ATTEMPT2_LINEAGE_ID;
  parse_config_path: typeof ATTEMPT2_PARSE_CONFIG_PATH;
  parse_config_sha256: string;
  parse_config: Candidate18Config;
  runtime_probe_evidence_directory: typeof RUNTIME_PROBE_EVIDENCE_DIRECTORY;
  runtime_probe_manifest_path: typeof RUNTIME_PROBE_MANIFEST_PATH;
  runtime_probe_manifest_sha256: typeof RUNTIME_PROBE_MANIFEST_SHA256;
  runtime_probe_record_sha256: typeof RUNTIME_PROBE_RECORD_SHA256;
  expected_c18_source_sha256: typeof C18_SOURCE_SHA256;
  expected_c18_test_sha256: typeof C18_TEST_SHA256;
  expected_c19_source_sha256: typeof C19_SOURCE_SHA256;
  expected_c19_test_sha256: typeof C19_TEST_SHA256;
  expected_transport_source_sha256: typeof TRANSPORT_SOURCE_SHA256;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  adjudication_path: typeof ATTEMPT2_ADJUDICATION_PATH;
  review_path: typeof ATTEMPT2_REVIEW_PATH;
}

export interface Attempt2LineageDependencies {
  inner: Candidate18Dependencies;
  runInner(
    config: Candidate18Config,
    confirmation: string,
    evidenceDirectory: string,
    dependencies: Candidate18Dependencies,
  ): Record<string, unknown>;
  read(path: string): Buffer;
  entries(path: string): string[];
  exists(path: string): boolean;
  writeExclusive(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Attempt2LineageFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE18_ATTEMPT2_FAILED"));
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function canonicalJsonAttempt2(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonAttempt2).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonAttempt2(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string, stage: string): never {
  throw new Attempt2LineageFailure({
    schema: "synthia-m4f-candidate18-attempt2-lineage-failure.v1",
    code,
    stage,
    retry_permitted: false,
    target_body_invoked: false,
    cleanup_performed: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  });
}

export function validateAttempt2LineageConfig(value: unknown): Attempt2LineageConfig {
  const config = object(value);
  const keys = [
    "adjudication_path", "expected_c18_source_sha256", "expected_c18_test_sha256",
    "expected_c19_source_sha256", "expected_c19_test_sha256", "expected_source_sha256",
    "expected_test_source_sha256", "expected_transport_source_sha256", "lineage_id",
    "parse_config", "parse_config_path", "parse_config_sha256", "review_path",
    "runtime_probe_evidence_directory", "runtime_probe_manifest_path",
    "runtime_probe_manifest_sha256", "runtime_probe_record_sha256", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-candidate18-attempt2-lineage-config.v1"
    || config.lineage_id !== ATTEMPT2_LINEAGE_ID || !SAFE_ID.test(String(config.lineage_id))
    || config.parse_config_path !== ATTEMPT2_PARSE_CONFIG_PATH
    || typeof config.parse_config_sha256 !== "string" || !HASH.test(config.parse_config_sha256)
    || config.runtime_probe_evidence_directory !== RUNTIME_PROBE_EVIDENCE_DIRECTORY
    || config.runtime_probe_manifest_path !== RUNTIME_PROBE_MANIFEST_PATH
    || config.runtime_probe_manifest_sha256 !== RUNTIME_PROBE_MANIFEST_SHA256
    || config.runtime_probe_record_sha256 !== RUNTIME_PROBE_RECORD_SHA256
    || config.expected_c18_source_sha256 !== C18_SOURCE_SHA256
    || config.expected_c18_test_sha256 !== C18_TEST_SHA256
    || config.expected_c19_source_sha256 !== C19_SOURCE_SHA256
    || config.expected_c19_test_sha256 !== C19_TEST_SHA256
    || config.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_test_source_sha256 !== "string" || !HASH.test(config.expected_test_source_sha256)
    || config.adjudication_path !== ATTEMPT2_ADJUDICATION_PATH
    || config.review_path !== ATTEMPT2_REVIEW_PATH) fail("M4F_C18_ATTEMPT2_CONFIG_INVALID", "config");
  const parseConfig = validateCandidate18Config(config.parse_config);
  if (parseConfig.parse_id !== ATTEMPT2_LINEAGE_ID
    || parseConfig.evidence_directory !== ATTEMPT2_EVIDENCE_DIRECTORY
    || parseConfig.expected_source_sha256 !== C18_SOURCE_SHA256
    || parseConfig.expected_test_source_sha256 !== C18_TEST_SHA256) {
    fail("M4F_C18_ATTEMPT2_PARSE_CONFIG_INVALID", "config");
  }
  return value as Attempt2LineageConfig;
}

function readExpected(dependencies: Attempt2LineageDependencies, path: string, hash: string): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch { fail("M4F_C18_ATTEMPT2_INPUT_MISSING", "local_preflight"); }
  if (sha256(bytes) !== hash) fail("M4F_C18_ATTEMPT2_INPUT_DRIFT", "local_preflight");
  return bytes;
}

function loadContext(rawConfig: unknown, dependencies: Attempt2LineageDependencies) {
  const config = validateAttempt2LineageConfig(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_source_sha256);
  readExpected(dependencies, C18_SOURCE_PATH, C18_SOURCE_SHA256);
  readExpected(dependencies, C18_TEST_PATH, C18_TEST_SHA256);
  readExpected(dependencies, C19_SOURCE_PATH, C19_SOURCE_SHA256);
  readExpected(dependencies, C19_TEST_PATH, C19_TEST_SHA256);
  readExpected(dependencies, TRANSPORT_SOURCE_PATH, TRANSPORT_SOURCE_SHA256);
  const parseConfigBytes = readExpected(dependencies, ATTEMPT2_PARSE_CONFIG_PATH, config.parse_config_sha256);
  if (!parseConfigBytes.equals(Buffer.from(canonicalJsonAttempt2(config.parse_config) + "\n"))) {
    fail("M4F_C18_ATTEMPT2_PARSE_CONFIG_SPLIT_BRAIN", "local_preflight");
  }
  const manifestBytes = readExpected(
    dependencies, RUNTIME_PROBE_MANIFEST_PATH, RUNTIME_PROBE_MANIFEST_SHA256,
  );
  if (!manifestBytes.equals(Buffer.from(canonicalJsonAttempt2(RUNTIME_PROBE_MANIFEST) + "\n"))) {
    fail("M4F_C18_ATTEMPT2_RUNTIME_PROBE_MANIFEST_INVALID", "local_preflight");
  }
  const names = Object.keys(RUNTIME_PROBE_MANIFEST).sort();
  if (canonicalJsonAttempt2(dependencies.entries(RUNTIME_PROBE_EVIDENCE_DIRECTORY))
    !== canonicalJsonAttempt2(names)) fail("M4F_C18_ATTEMPT2_RUNTIME_PROBE_DIRECTORY_INVALID", "local_preflight");
  for (const name of names) readExpected(
    dependencies,
    RUNTIME_PROBE_EVIDENCE_DIRECTORY + "/" + name,
    RUNTIME_PROBE_MANIFEST[name as keyof typeof RUNTIME_PROBE_MANIFEST],
  );
  const probeRecord = object(JSON.parse(readExpected(
    dependencies,
    RUNTIME_PROBE_EVIDENCE_DIRECTORY + "/probe-record.json",
    RUNTIME_PROBE_RECORD_SHA256,
  ).toString("utf8")));
  if (!probeRecord || probeRecord.status !== "gzip_constructor_and_decompress_bound"
    || probeRecord.attempt !== 1 || probeRecord.target_body_invoked !== false
    || probeRecord.cleanup_performed !== false || probeRecord.process_mutation_performed !== false
    || probeRecord.file_mutation_performed !== false || probeRecord.vivado_action_performed !== false
    || probeRecord.hardware_action_performed !== false || probeRecord.retry_permitted !== false) {
    fail("M4F_C18_ATTEMPT2_RUNTIME_PROBE_RECORD_INVALID", "local_preflight");
  }
  const innerPlan = planCandidate18(config.parse_config, dependencies.inner);
  return { config, innerPlan };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-candidate18-attempt2-lineage-plan.v1",
    lineage_id: context.config.lineage_id,
    status: "planned_not_executed",
    parse_config_sha256: context.config.parse_config_sha256,
    inner_plan_sha256: sha256(canonicalJsonAttempt2(context.innerPlan) + "\n"),
    runtime_probe_manifest_sha256: RUNTIME_PROBE_MANIFEST_SHA256,
    runtime_probe_record_sha256: RUNTIME_PROBE_RECORD_SHA256,
    attempt_count: 1,
    retry_permitted: false,
    parse_target_count: 2,
    target_body_invoked: false,
    cleanup_permitted: false,
    process_mutation_permitted: false,
    file_mutation_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
    adjudication_path: ATTEMPT2_ADJUDICATION_PATH,
    review_path: ATTEMPT2_REVIEW_PATH,
  };
}

export function planAttempt2Lineage(
  rawConfig: unknown,
  dependencies: Attempt2LineageDependencies,
): Record<string, unknown> {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE18_ATTEMPT2_EXACT_PARSE_ONLY",
    context.config.lineage_id,
    sha256(canonicalJsonAttempt2(context.config) + "\n"),
    sha256(canonicalJsonAttempt2(planFor(context)) + "\n"),
    context.config.parse_config_sha256,
    RUNTIME_PROBE_MANIFEST_SHA256,
    RUNTIME_PROBE_RECORD_SHA256,
    C18_SOURCE_SHA256,
    C18_TEST_SHA256,
    C19_SOURCE_SHA256,
    C19_TEST_SHA256,
    context.config.expected_source_sha256,
    context.config.expected_test_source_sha256,
  ].join(":");
}

export function attempt2LineageConfirmation(
  rawConfig: unknown,
  dependencies: Attempt2LineageDependencies,
): string {
  return confirmationFor(loadContext(rawConfig, dependencies));
}

function evidenceManifest(dependencies: Attempt2LineageDependencies): Record<string, string> {
  const names = dependencies.entries(ATTEMPT2_EVIDENCE_DIRECTORY).sort();
  const manifest: Record<string, string> = {};
  for (const name of names) manifest[name] = sha256(dependencies.read(ATTEMPT2_EVIDENCE_DIRECTORY + "/" + name));
  return manifest;
}

function writeRecord(
  dependencies: Attempt2LineageDependencies,
  path: string,
  value: Record<string, unknown>,
): string {
  const bytes = Buffer.from(canonicalJsonAttempt2(value) + "\n");
  try { dependencies.writeExclusive(path, bytes); } catch { fail("M4F_C18_ATTEMPT2_RECORD_WRITE_FAILED", "adjudication"); }
  if (!dependencies.read(path).equals(bytes)) fail("M4F_C18_ATTEMPT2_RECORD_WRITE_INVALID", "adjudication");
  return sha256(bytes);
}

export function executeAttempt2Lineage(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Attempt2LineageDependencies,
): Record<string, unknown> {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_C18_ATTEMPT2_CONFIRMATION_REQUIRED", "local_preflight");
  if (dependencies.exists(ATTEMPT2_ADJUDICATION_PATH) || dependencies.exists(ATTEMPT2_REVIEW_PATH)) {
    fail("M4F_C18_ATTEMPT2_RECORD_TARGET_EXISTS", "local_preflight");
  }
  const innerConfirmation = candidate18Confirmation(context.config.parse_config, dependencies.inner);
  let result: Record<string, unknown> | null = null;
  let originalFailure: Record<string, unknown> | null = null;
  let cliXml: Record<string, unknown> | null = null;
  try {
    result = dependencies.runInner(
      context.config.parse_config,
      innerConfirmation,
      ATTEMPT2_EVIDENCE_DIRECTORY,
      dependencies.inner,
    );
  } catch (error) {
    if (!(error instanceof Candidate18Failure)
      || error.detail.code !== "M4F_CANDIDATE18_REMOTE_PARSE_FAILED") throw error;
    originalFailure = error.detail;
    const scriptConfig = validateCandidate19ScriptConfig(JSON.parse(dependencies.read(
      context.config.parse_config.candidate19_script_config_path,
    ).toString("utf8")));
    const payload = buildCandidate18Payload(scriptConfig);
    result = {
      ...validateCandidate18Result(
      dependencies.read(ATTEMPT2_EVIDENCE_DIRECTORY + "/stdout.raw"),
      payload,
      ),
      business_target_body_not_invoked: true,
      outer_loader_target_body_not_invoked: true,
      retry_permitted: false,
    };
    cliXml = parseCandidate18BenignCliXml(
      dependencies.read(ATTEMPT2_EVIDENCE_DIRECTORY + "/stderr.raw"),
    );
  }
  if (!result || result.status !== "parsed_not_invoked"
    || result.business_target_body_not_invoked !== true
    || result.outer_loader_target_body_not_invoked !== true
    || result.cleanup_performed !== false || result.process_mutation_performed !== false
    || result.file_mutation_performed !== false || result.vivado_action_performed !== false
    || result.hardware_action_performed !== false || result.retry_permitted !== false) {
    fail("M4F_C18_ATTEMPT2_PARSE_RESULT_INVALID", "adjudication");
  }
  const after = loadContext(context.config, dependencies);
  if (confirmationFor(after) !== confirmation) fail("M4F_C18_ATTEMPT2_POSTFLIGHT_DRIFT", "network_postflight");
  const manifest = evidenceManifest(dependencies);
  const manifestSha256 = sha256(canonicalJsonAttempt2(manifest) + "\n");
  const adjudication = {
    schema: "synthia-m4f-candidate18-attempt2-adjudication.v1",
    lineage_id: context.config.lineage_id,
    status: originalFailure === null ? "parsed_not_invoked" : "parse_success_locally_adjudicated",
    recorded_at_utc: dependencies.now().toISOString(),
    lineage_config_sha256: sha256(canonicalJsonAttempt2(context.config) + "\n"),
    lineage_plan_sha256: sha256(canonicalJsonAttempt2(planFor(context)) + "\n"),
    parse_config_sha256: context.config.parse_config_sha256,
    runtime_probe_manifest_sha256: RUNTIME_PROBE_MANIFEST_SHA256,
    runtime_probe_record_sha256: RUNTIME_PROBE_RECORD_SHA256,
    evidence_directory: ATTEMPT2_EVIDENCE_DIRECTORY,
    evidence_manifest: manifest,
    evidence_manifest_sha256: manifestSha256,
    parse_result: result,
    original_failure_preserved: originalFailure !== null,
    original_failure: originalFailure,
    cli_xml_adjudication: cliXml,
    target_body_invoked: false,
    cleanup_performed: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    retry_permitted: false,
  };
  const adjudicationSha256 = writeRecord(dependencies, ATTEMPT2_ADJUDICATION_PATH, adjudication);
  const review = {
    schema: "synthia-m4f-candidate18-attempt2-local-review-draft.v1",
    review_id: context.config.lineage_id + "-local-review-draft",
    reviewed_at_utc: dependencies.now().toISOString(),
    decision: "LOCAL_ADJUDICATION_COMPLETE_INDEPENDENT_F0_REVIEW_REQUIRED",
    adjudication_path: ATTEMPT2_ADJUDICATION_PATH,
    adjudication_sha256: adjudicationSha256,
    runtime_probe_manifest_sha256: RUNTIME_PROBE_MANIFEST_SHA256,
    evidence_manifest_sha256: manifestSha256,
    parse_status: adjudication.status,
    independent_review_completed: false,
    eligible_for_cleanup_freeze: false,
    cleanup_execution_authorized: false,
    network_authorized: false,
    ssh_authorized: false,
    remote_execution_authorized: false,
    retry_authorized: false,
    target_body_invoked: false,
    cleanup_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
  const reviewSha256 = writeRecord(dependencies, ATTEMPT2_REVIEW_PATH, review);
  return {
    ...review,
    review_sha256: reviewSha256,
    adjudication_status: adjudication.status,
    parse_result: result,
  };
}

function fileFact(path: string, stat: Stats, bytes: Buffer): Candidate18FileFact {
  return {
    schema: "synthia-m4f-candidate18-local-file.v1",
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

function captureFile(path: string): Candidate18CapturedFile {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not_regular");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hb = fstatSync(fd);
    const bytes = readFileSync(fd);
    const ha = fstatSync(fd);
    const after = lstatSync(path);
    const same = [hb, ha, after].every((stat) => stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs);
    if (!same) throw new Error("file_drift");
    return { bytes, fact: fileFact(path, ha, bytes) };
  } finally { closeSync(fd); }
}

const innerDependencies: Candidate18Dependencies = {
  spawn(executable, args, stdin, timeoutMs): RawProcessResult {
    const result = spawnSync(executable, args, {
      input: stdin, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer", windowsHide: true,
    });
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
      stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  captureFile,
  sourceFile: () => captureFile(C18_SOURCE_PATH),
  testSourceFile: () => captureFile(C18_TEST_PATH),
  candidate19SourceFile: () => captureFile(C19_SOURCE_PATH),
  candidate19TestSourceFile: () => captureFile(C19_TEST_PATH),
  candidate19DocFile: () => captureFile(C19_DOC_PATH),
  transportSourceFile: () => captureFile(TRANSPORT_SOURCE_PATH),
  transportInputs: (config: M4fDirectAdmissionConfig, stage) => captureM4fDirectTransportInputs(config, stage),
  now: () => new Date(),
};

const systemDependencies: Attempt2LineageDependencies = {
  inner: innerDependencies,
  runInner: executeCandidate18,
  read: (path) => readFileSync(path),
  entries: (path) => readdirSync(path).sort(),
  exists: (path) => existsSync(path),
  writeExclusive(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      const plan = planAttempt2Lineage(raw, systemDependencies);
      process.stdout.write(JSON.stringify({
        ...plan,
        config_sha256: sha256(canonicalJsonAttempt2(raw) + "\n"),
        plan_sha256: sha256(canonicalJsonAttempt2(plan) + "\n"),
        confirmation: attempt2LineageConfirmation(raw, systemDependencies),
      }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeAttempt2Lineage(
        raw, args[4]!, systemDependencies,
      )) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Attempt2LineageFailure ? error.detail : {
      schema: "synthia-m4f-candidate18-attempt2-lineage-failure.v1",
      code: error instanceof Error ? error.message : "M4F_C18_ATTEMPT2_UNEXPECTED",
      retry_permitted: false,
      target_body_invoked: false,
      cleanup_performed: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
