import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  auditDirectSshEffectiveConfig,
  buildDirectPowerShellStdinCommand,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  directPowerShellStdinWrapperFact,
  M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE,
  type M4fDirectAdmissionConfig,
  type LocalInputFact,
  validateM4fDirectAdmissionConfig,
} from "./m4f-gate-admission-transport.ts";
import {
  validateAdmissionV2Config,
  validateAdmissionV2Snapshot,
  type M4fDirectAdmissionV2Config,
} from "./m4f-direct-admission-v2.ts";

const SSH_PATH = "/usr/bin/ssh";
const HASH = /^[0-9a-f]{64}$/u;
const SID = /^S-1-(?:[0-9]+-){1,14}[0-9]+$/u;
const GATE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const MAX_BYTES = 8 * 1024 * 1024;
const TEN_GIB = 10 * 1024 * 1024 * 1024;
const LOCAL_SERVICE_SID = "S-1-5-19";

interface M4fDirectGateRootsConfigBase {
  gate_id: string;
  service_identity_sid: string;
  minimum_gate_free_bytes: number;
  minimum_backing_free_bytes: number;
  admission_config_path: string;
  admission_config_sha256: string;
  admission_record_path: string;
  admission_record_sha256: string;
  admission_approval_path: string;
  admission_approval_sha256: string;
}

export interface M4fDirectGateRootsConfigV1 extends M4fDirectGateRootsConfigBase {
  schema: "synthia-m4f-direct-gate-roots-config.v1";
}

export interface M4fDirectGateRootsConfigV2 extends M4fDirectGateRootsConfigBase {
  schema: "synthia-m4f-direct-gate-roots-config.v2";
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_admission_v2_source_sha256: string;
  expected_wrapper_source_sha256: string;
  expected_remote_script_sha256: string;
}

export interface M4fDirectGateRootsConfigV3 extends M4fDirectGateRootsConfigBase {
  schema: "synthia-m4f-direct-gate-roots-config.v3";
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_admission_v2_source_sha256: string;
  expected_wrapper_source_sha256: string;
  expected_remote_script_sha256: string;
  roots_approval_path: string;
  roots_approval_sha256: string;
}

export type M4fDirectGateRootsConfig =
  | M4fDirectGateRootsConfigV1
  | M4fDirectGateRootsConfigV2
  | M4fDirectGateRootsConfigV3;

export interface M4fDirectGateRootsApproval {
  schema: "synthia-m4f-direct-gate-roots-approval.v1";
  decision: "approved";
  gate_id: string;
  reviewer: string;
  approved_at_utc: string;
  roots_review_config_sha256: string;
  gate_roots_source_sha256: string;
  gate_roots_transport_source_sha256: string;
  admission_v2_validator_source_sha256: string;
  gate_roots_wrapper_source_sha256: string;
  gate_roots_remote_script_sha256: string;
  effect_binding_sha256: string;
  target_host: "100.96.223.49";
  target_user: "admin";
  target_computer: "DESKTOP-DVFFB09";
  target_identity_name: string;
  target_identity_sid: string;
}

export interface M4fDirectAdmissionApproval {
  schema: "synthia-m4f-direct-admission-approval.v1";
  decision: "approved";
  gate_id: string;
  reviewer: string;
  approved_at_utc: string;
  admission_config_sha256: string;
  admission_record_sha256: string;
  effective_config_sha256: string;
  target_host: "100.96.223.49";
  target_computer: "DESKTOP-DVFFB09";
}

export interface M4fDirectAdmissionV2Approval {
  schema: "synthia-m4f-direct-admission-v2-approval.v1";
  decision: "approved";
  gate_id: string;
  admission_id: string;
  reviewer: string;
  approved_at_utc: string;
  admission_v2_config_sha256: string;
  admission_v2_config_canonical_sha256: string;
  base_admission_config_sha256: string;
  admission_record_sha256: string;
  effective_config_sha256: string;
  source_sha256: string;
  transport_source_sha256: string;
  loader_source_sha256: string;
  remote_script_sha256: string;
  remote_compressed_sha256: string;
  remote_loader_sha256: string;
  target_host: "100.96.223.49";
  target_user: "admin";
  target_computer: "DESKTOP-DVFFB09";
  target_identity_name: string;
  target_identity_sid: string;
  host_key_fingerprint: string;
}

export interface RawProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DirectGateRootsDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  admissionV2SourceBytes(): Buffer;
  now(): Date;
}

interface DirectGateRootsRecordBase {
  gate_id: string;
  status: "created";
  retry_permitted: false;
  recorded_at_utc: string;
  confirmation_sha256: string;
  config_sha256: string;
  source_sha256: string;
  remote_script_sha256: string;
  remote_wrapper_length: number;
  remote_wrapper_sha256: string;
  remote_command_length: number;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  admission_config_sha256: string;
  admission_record_sha256: string;
  admission_approval_sha256: string;
  effective_config_sha256: string;
  gate_root: string;
  backing_root: string;
  process: ProcessEvidence;
  remote_result: Record<string, unknown>;
}

export interface DirectGateRootsRecordV1 extends DirectGateRootsRecordBase {
  schema: "synthia-m4f-direct-gate-roots-record.v1";
}

export interface DirectGateRootsRecordV2 extends DirectGateRootsRecordBase {
  schema: "synthia-m4f-direct-gate-roots-record.v2";
  admission_contract: "direct_admission_v2";
  admission_id: string;
  admission_v2_config_sha256: string;
  admission_v2_config_canonical_sha256: string;
  base_admission_config_sha256: string;
  gate_roots_transport_source_sha256: string;
  admission_v2_validator_source_sha256: string;
}

export interface DirectGateRootsRecordV3 extends DirectGateRootsRecordBase {
  schema: "synthia-m4f-direct-gate-roots-record.v3";
  admission_contract: "direct_admission_v2";
  admission_id: string;
  admission_v2_config_sha256: string;
  admission_v2_config_canonical_sha256: string;
  base_admission_config_sha256: string;
  gate_roots_transport_source_sha256: string;
  admission_v2_validator_source_sha256: string;
  roots_review_config_sha256: string;
  roots_approval_sha256: string;
}

export type DirectGateRootsRecord =
  | DirectGateRootsRecordV1
  | DirectGateRootsRecordV2
  | DirectGateRootsRecordV3;

export interface ProcessEvidence {
  exit_status: number | null;
  signal: string | null;
  error_code: string | null;
  timed_out: boolean;
  outcome_ambiguous: boolean;
  stdin_length: number;
  stdin_sha256: string;
  stdout_length: number;
  stdout_sha256: string;
  stderr_length: number;
  stderr_sha256: string;
  retry_permitted: false;
}

export interface RemoteWriteAttemptEvidence {
  schema: "synthia-m4f-direct-gate-roots-remote-attempt.v1";
  started: true;
  process_result_returned: boolean;
  raw_stdout_captured: boolean;
  raw_stderr_captured: boolean;
}

export interface DirectGateRootsFailureEvidence {
  effectiveConfig?: Buffer;
  remoteScript?: Buffer;
  rawStdout?: Buffer;
  rawStderr?: Buffer;
  process?: ProcessEvidence;
  remoteAttempt?: RemoteWriteAttemptEvidence;
}

export class DirectGateRootsFailure extends Error {
  constructor(
    readonly detail: Record<string, unknown>,
    readonly evidence: DirectGateRootsFailureEvidence = {},
  ) {
    super(String(detail.code ?? "M4F_DIRECT_GATE_ROOTS_FAILED"));
  }
}

const CONFIG_V1_KEYS = ["admission_approval_path", "admission_approval_sha256", "admission_config_path", "admission_config_sha256", "admission_record_path", "admission_record_sha256", "gate_id", "minimum_backing_free_bytes", "minimum_gate_free_bytes", "schema", "service_identity_sid"] as const;
const CONFIG_V2_KEYS = [
  ...CONFIG_V1_KEYS,
  "expected_admission_v2_source_sha256", "expected_remote_script_sha256",
  "expected_source_sha256", "expected_transport_source_sha256", "expected_wrapper_source_sha256",
] as const;
const CONFIG_V3_KEYS = [
  ...CONFIG_V2_KEYS,
  "roots_approval_path", "roots_approval_sha256",
] as const;
const ROOTS_APPROVAL_KEYS = [
  "admission_v2_validator_source_sha256", "approved_at_utc", "decision", "effect_binding_sha256",
  "gate_id", "gate_roots_remote_script_sha256", "gate_roots_source_sha256",
  "gate_roots_transport_source_sha256", "gate_roots_wrapper_source_sha256", "reviewer",
  "roots_review_config_sha256", "schema", "target_computer", "target_host", "target_identity_name",
  "target_identity_sid", "target_user",
] as const;
const APPROVAL_KEYS = ["admission_config_sha256", "admission_record_sha256", "approved_at_utc", "decision", "effective_config_sha256", "gate_id", "reviewer", "schema", "target_computer", "target_host"] as const;
const ADMISSION_RECORD_KEYS = ["action", "config_sha256", "effective_config_sha256", "gate_id", "local_inputs_after", "local_inputs_before", "process", "recorded_at_utc", "remote_command_length", "remote_wrapper_length", "remote_wrapper_sha256", "retry_permitted", "schema", "source_sha256", "status", "target_binding", "target_snapshot"] as const;
const V2_APPROVAL_KEYS = [
  "admission_id", "admission_record_sha256", "admission_v2_config_canonical_sha256",
  "admission_v2_config_sha256", "approved_at_utc", "base_admission_config_sha256", "decision",
  "effective_config_sha256", "gate_id", "host_key_fingerprint", "loader_source_sha256",
  "remote_compressed_sha256", "remote_loader_sha256", "remote_script_sha256", "reviewer", "schema",
  "source_sha256", "target_computer", "target_host", "target_identity_name", "target_identity_sid",
  "target_user", "transport_source_sha256",
] as const;
const V2_ADMISSION_RECORD_KEYS = [
  "action", "admission_config_after", "admission_config_before", "admission_id", "attempt",
  "config_sha256", "effective_config_sha256", "elapsed_ms", "hardware_action_performed",
  "loader_source_sha256", "process", "process_termination_performed", "recorded_at_utc",
  "remote_command_length", "remote_compressed_length", "remote_compressed_sha256",
  "remote_loader_length", "remote_loader_sha256", "remote_script_length", "remote_script_sha256",
  "retry_permitted", "schema", "source_sha256", "status", "stdin_length", "target_snapshot",
  "timeout_ms", "transport_inputs_after", "transport_inputs_before", "transport_source_sha256",
] as const;
const V2_BOUND_FILE_KEYS = [
  "ctime_ms", "device", "inode", "link_count", "mode", "mtime_ms", "owner_uid", "path", "sha256", "size",
] as const;
const V2_PROCESS_KEYS = [
  "error_code", "exit_status", "outcome_ambiguous", "retry_permitted", "signal", "stderr_length",
  "stderr_sha256", "stdin_length", "stdout_length", "stdout_sha256", "timed_out",
] as const;
const LOCAL_INPUT_KEYS = ["ctime_ms", "device", "inode", "label", "link_count", "mode", "mtime_ms", "owner_uid", "path", "schema", "sha256", "size"] as const;
const RESULT_V1_KEYS = ["backing_ancestors_after", "backing_ancestors_before", "backing_root", "backing_root_fact", "backing_volume_after", "backing_volume_before", "confirmation_sha256", "created_count", "gate_ancestors_after", "gate_ancestors_before", "gate_id", "gate_root", "gate_root_fact", "gate_volume_after", "gate_volume_before", "identity", "no_cleanup", "schema", "status"] as const;
const RESULT_V2_KEYS = ["backing_ancestors_after", "backing_ancestors_before", "backing_root", "backing_root_fact", "backing_volume_after", "backing_volume_before", "created_count", "effect_binding_sha256", "gate_ancestors_after", "gate_ancestors_before", "gate_id", "gate_root", "gate_root_fact", "gate_volume_after", "gate_volume_before", "identity", "no_cleanup", "schema", "status"] as const;
const IDENTITY_KEYS = ["computer_name", "identity_name", "identity_sid"] as const;
const VOLUME_KEYS = ["device_id", "disk_number", "disk_unique_id", "drive_type", "file_system", "free_bytes", "logical_volume_serial", "partition_number", "root", "volume_serial_number", "volume_unique_id"] as const;
const ROOT_FACT_KEYS = ["alternate_streams", "empty", "explicit_ace_count", "owner_sid", "path", "protected", "reparse", "rules"] as const;
const ROOT_RULE_KEYS = ["rights", "sid"] as const;
const ANCESTOR_KEYS = ["acl_protected", "owner_sid", "path", "reparse", "rules", "strict_acl"] as const;
const ANCESTOR_RULE_KEYS = ["applies_to_current", "inheritance", "inherited", "propagation", "rights", "sid", "type"] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new DirectGateRootsFailure({
    schema: "synthia-m4f-direct-gate-roots-failure.v1",
    code,
    stage,
    remote_write_state: stage === "config" || stage === "local_preflight" ? "not_started" : "unknown",
    retry_permitted: false,
    cleanup_permitted: false,
    ...extra,
  });
}

function safeLocalPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

export function validateDirectGateRootsConfig(value: unknown): M4fDirectGateRootsConfig {
  const config = object(value);
  const schemaValid = config?.schema === "synthia-m4f-direct-gate-roots-config.v1"
    || config?.schema === "synthia-m4f-direct-gate-roots-config.v2"
    || config?.schema === "synthia-m4f-direct-gate-roots-config.v3";
  const keysValid = config?.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? exactKeys(config, CONFIG_V1_KEYS)
    : config?.schema === "synthia-m4f-direct-gate-roots-config.v2"
      ? exactKeys(config, CONFIG_V2_KEYS)
      : config?.schema === "synthia-m4f-direct-gate-roots-config.v3"
        ? exactKeys(config, CONFIG_V3_KEYS)
        : false;
  const currentHashesValid = config?.schema === "synthia-m4f-direct-gate-roots-config.v1"
    || [
      config?.expected_source_sha256,
      config?.expected_transport_source_sha256,
      config?.expected_admission_v2_source_sha256,
      config?.expected_wrapper_source_sha256,
      config?.expected_remote_script_sha256,
    ].every((value) => typeof value === "string" && HASH.test(value));
  const rootsApprovalValid = config?.schema !== "synthia-m4f-direct-gate-roots-config.v3"
    || (safeLocalPath(config.roots_approval_path)
      && HASH.test(String(config.roots_approval_sha256))
      && ![
        config.admission_config_path,
        config.admission_record_path,
        config.admission_approval_path,
      ].includes(config.roots_approval_path));
  const serviceIdentityValid = config?.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? SID.test(String(config.service_identity_sid))
      && !["S-1-5-18", "S-1-5-32-544"].includes(String(config.service_identity_sid))
    : config?.service_identity_sid === LOCAL_SERVICE_SID;
  if (!config || !schemaValid || !keysValid || !currentHashesValid || !rootsApprovalValid
    || typeof config.gate_id !== "string" || !GATE_ID.test(config.gate_id)
    || !serviceIdentityValid
    || !Number.isSafeInteger(config.minimum_gate_free_bytes)
    || Number(config.minimum_gate_free_bytes) < TEN_GIB
    || !Number.isSafeInteger(config.minimum_backing_free_bytes)
    || Number(config.minimum_backing_free_bytes) < TEN_GIB
    || !safeLocalPath(config.admission_config_path)
    || !safeLocalPath(config.admission_record_path)
    || !safeLocalPath(config.admission_approval_path)
    || new Set([
      config.admission_config_path,
      config.admission_record_path,
      config.admission_approval_path,
    ]).size !== 3
    || !HASH.test(String(config.admission_config_sha256))
    || !HASH.test(String(config.admission_record_sha256))
    || !HASH.test(String(config.admission_approval_sha256))) {
    fail("M4F_DIRECT_GATE_ROOTS_CONFIG_INVALID", "config");
  }
  return value as M4fDirectGateRootsConfig;
}

function readBoundJson(
  path: string,
  expectedHash: string,
  label: string,
  stage: "local_preflight" | "remote_write" = "local_preflight",
): Record<string, unknown> {
  let stat;
  let bytes: Buffer;
  let fd: number | null = null;
  try {
    const pathBefore = lstatSync(path);
    fd = openSync(path, "r");
    const handleBefore = fstatSync(fd);
    bytes = readFileSync(fd);
    const handleAfter = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (pathBefore.isSymbolicLink()
      || pathBefore.dev !== handleBefore.dev || pathBefore.ino !== handleBefore.ino
      || handleBefore.dev !== handleAfter.dev || handleBefore.ino !== handleAfter.ino
      || handleBefore.size !== handleAfter.size || handleBefore.mtimeMs !== handleAfter.mtimeMs
      || handleBefore.ctimeMs !== handleAfter.ctimeMs
      || handleAfter.dev !== pathAfter.dev || handleAfter.ino !== pathAfter.ino) {
      fail("M4F_DIRECT_GATE_ROOTS_INPUT_UNTRUSTED", stage, { label });
    }
    stat = handleAfter;
  } catch (error) {
    if (error instanceof DirectGateRootsFailure) throw error;
    fail("M4F_DIRECT_GATE_ROOTS_INPUT_UNAVAILABLE", stage, { label });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || sha256(bytes) !== expectedHash || bytes.length > MAX_BYTES) {
    fail("M4F_DIRECT_GATE_ROOTS_INPUT_UNTRUSTED", stage, { label });
  }
  try {
    const parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!parsed) fail("M4F_DIRECT_GATE_ROOTS_INPUT_INVALID", stage, { label });
    return parsed;
  } catch (error) {
    if (error instanceof DirectGateRootsFailure) throw error;
    fail("M4F_DIRECT_GATE_ROOTS_INPUT_INVALID", stage, { label });
  }
}

export function directGateRootsConfigSha256(rawConfig: unknown): string {
  const config = validateDirectGateRootsConfig(rawConfig);
  return sha256(Buffer.from(canonicalJson(config) + "\n", "utf8"));
}

export function directGateRootsReviewConfigSha256(rawConfig: unknown): string {
  const config = validateDirectGateRootsConfig(rawConfig);
  if (config.schema !== "synthia-m4f-direct-gate-roots-config.v3") {
    fail("M4F_DIRECT_GATE_ROOTS_REVIEW_CONFIG_REQUIRES_V3", "config");
  }
  const { roots_approval_path: _path, roots_approval_sha256: _sha256, ...reviewConfig } = config;
  return sha256(Buffer.from(canonicalJson(reviewConfig) + "\n", "utf8"));
}

export function directGateRootsConfirmation(rawConfig: unknown): string {
  const config = validateDirectGateRootsConfig(rawConfig);
  const prefix = "SYNTHIA_M4F_DIRECT_GATE_ROOTS_CREATE:"
    + config.gate_id + ":"
    + config.admission_approval_sha256 + ":";
  return config.schema === "synthia-m4f-direct-gate-roots-config.v3"
    ? prefix + config.roots_approval_sha256 + ":" + directGateRootsConfigSha256(config)
    : prefix + directGateRootsConfigSha256(config);
}

interface BoundAdmission {
  admissionConfig: M4fDirectAdmissionConfig;
  admissionRecord: Record<string, unknown>;
  approval: M4fDirectAdmissionApproval | M4fDirectAdmissionV2Approval;
  transportFacts: LocalInputFact[];
  admissionContract: "v1" | "v2";
  admissionId: string | null;
  baseAdmissionConfigSha256: string;
  admissionConfigCanonicalSha256: string;
}

interface ExecutionTcbBinding {
  sourceBytes: Buffer;
  sourceSha256: string;
  transportSourceSha256: string | null;
  admissionV2SourceSha256: string | null;
  wrapperSourceSha256: string;
  effectBindingSha256: string;
  remoteScript: Buffer;
  remoteScriptSha256: string;
}

function bindExecutionTcb(
  config: M4fDirectGateRootsConfig,
  bound: BoundAdmission,
  confirmationHash: string,
  dependencies: DirectGateRootsDependencies,
): ExecutionTcbBinding {
  let sourceBytes: Buffer;
  let transportSourceBytes: Buffer | null = null;
  let admissionV2SourceBytes: Buffer | null = null;
  try {
    sourceBytes = dependencies.sourceBytes();
    if (config.schema !== "synthia-m4f-direct-gate-roots-config.v1") {
      transportSourceBytes = dependencies.transportSourceBytes();
      admissionV2SourceBytes = dependencies.admissionV2SourceBytes();
    }
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_EXECUTION_TCB_UNAVAILABLE", "local_preflight");
  }
  const effectBindingSha256 = directGateRootsEffectBindingSha256(config, bound.admissionConfig);
  const remoteScript = Buffer.from(
    buildDirectGateRootsRemoteScript(
      config,
      bound.admissionConfig,
      config.schema === "synthia-m4f-direct-gate-roots-config.v1"
        ? confirmationHash
        : effectBindingSha256,
    ),
    "ascii",
  );
  const binding: ExecutionTcbBinding = {
    sourceBytes,
    sourceSha256: sha256(sourceBytes),
    transportSourceSha256: transportSourceBytes === null ? null : sha256(transportSourceBytes),
    admissionV2SourceSha256: admissionV2SourceBytes === null ? null : sha256(admissionV2SourceBytes),
    wrapperSourceSha256: directPowerShellStdinWrapperFact().source_sha256,
    effectBindingSha256,
    remoteScript,
    remoteScriptSha256: sha256(remoteScript),
  };
  if (config.schema !== "synthia-m4f-direct-gate-roots-config.v1") {
    if (bound.admissionContract !== "v2") {
      fail("M4F_DIRECT_GATE_ROOTS_EXECUTION_TCB_MISMATCH", "local_preflight");
    }
    const approval = bound.approval as M4fDirectAdmissionV2Approval;
    if (binding.sourceSha256 !== config.expected_source_sha256
      || binding.transportSourceSha256 !== config.expected_transport_source_sha256
      || binding.transportSourceSha256 !== approval.transport_source_sha256
      || binding.admissionV2SourceSha256 !== config.expected_admission_v2_source_sha256
      || binding.admissionV2SourceSha256 !== approval.source_sha256
      || binding.wrapperSourceSha256 !== config.expected_wrapper_source_sha256
      || binding.remoteScriptSha256 !== config.expected_remote_script_sha256) {
      fail("M4F_DIRECT_GATE_ROOTS_EXECUTION_TCB_MISMATCH", "local_preflight", {
        expected_source_sha256: config.expected_source_sha256,
        observed_source_sha256: binding.sourceSha256,
        expected_transport_source_sha256: config.expected_transport_source_sha256,
        observed_transport_source_sha256: binding.transportSourceSha256,
        expected_admission_v2_source_sha256: config.expected_admission_v2_source_sha256,
        observed_admission_v2_source_sha256: binding.admissionV2SourceSha256,
        expected_wrapper_source_sha256: config.expected_wrapper_source_sha256,
        observed_wrapper_source_sha256: binding.wrapperSourceSha256,
        expected_remote_script_sha256: config.expected_remote_script_sha256,
        observed_remote_script_sha256: binding.remoteScriptSha256,
      });
    }
  }
  return binding;
}

interface BoundRootsApproval {
  approval: M4fDirectGateRootsApproval;
  reviewConfigSha256: string;
}

function bindRootsApproval(
  config: M4fDirectGateRootsConfigV3,
  bound: BoundAdmission,
  executionTcb: ExecutionTcbBinding,
  stage: "local_preflight" | "remote_write" = "local_preflight",
): BoundRootsApproval {
  const raw = readBoundJson(
    config.roots_approval_path,
    config.roots_approval_sha256,
    "roots_approval",
    stage,
  );
  const reviewConfigSha256 = directGateRootsReviewConfigSha256(config);
  const admissionReviewer = (bound.approval as M4fDirectAdmissionV2Approval).reviewer;
  if (!exactKeys(raw, ROOTS_APPROVAL_KEYS)
    || raw.schema !== "synthia-m4f-direct-gate-roots-approval.v1"
    || raw.decision !== "approved"
    || raw.gate_id !== config.gate_id
    || typeof raw.reviewer !== "string" || raw.reviewer.length < 1 || raw.reviewer.length > 128
    || /[\r\n\0]/u.test(raw.reviewer)
    || raw.reviewer.normalize("NFKC").trim().toLocaleLowerCase("en-US")
      === admissionReviewer.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    || typeof raw.approved_at_utc !== "string" || Number.isNaN(Date.parse(raw.approved_at_utc))
    || raw.roots_review_config_sha256 !== reviewConfigSha256
    || raw.gate_roots_source_sha256 !== executionTcb.sourceSha256
    || raw.gate_roots_transport_source_sha256 !== executionTcb.transportSourceSha256
    || raw.admission_v2_validator_source_sha256 !== executionTcb.admissionV2SourceSha256
    || raw.gate_roots_wrapper_source_sha256 !== executionTcb.wrapperSourceSha256
    || raw.gate_roots_remote_script_sha256 !== executionTcb.remoteScriptSha256
    || raw.effect_binding_sha256 !== executionTcb.effectBindingSha256
    || raw.target_host !== bound.admissionConfig.target.host
    || raw.target_user !== bound.admissionConfig.target.user
    || raw.target_computer !== bound.admissionConfig.target.computer_name
    || raw.target_identity_name !== bound.admissionConfig.target.identity_name
    || raw.target_identity_sid !== bound.admissionConfig.target.identity_sid) {
    fail("M4F_DIRECT_GATE_ROOTS_APPROVAL_INVALID", stage);
  }
  return {
    approval: raw as unknown as M4fDirectGateRootsApproval,
    reviewConfigSha256,
  };
}

function validLocalInputFact(value: unknown, label: LocalInputFact["label"], path: string): boolean {
  const fact = object(value);
  return !!fact && exactKeys(fact, LOCAL_INPUT_KEYS)
    && fact.schema === "synthia-m4f-direct-local-input.v1"
    && fact.label === label && fact.path === path
    && safeInteger(fact.device) && safeInteger(fact.inode)
    && safeInteger(fact.owner_uid) && fact.mode === 0o600 && fact.link_count === 1
    && safeInteger(fact.size, 1)
    && typeof fact.mtime_ms === "number" && Number.isFinite(fact.mtime_ms)
    && typeof fact.ctime_ms === "number" && Number.isFinite(fact.ctime_ms)
    && typeof fact.sha256 === "string" && HASH.test(fact.sha256);
}

function admissionTransportFacts(
  value: unknown,
  config: M4fDirectAdmissionConfig,
  stage: "local_preflight" | "remote_write",
): LocalInputFact[] {
  if (!Array.isArray(value) || value.length !== 2
    || !validLocalInputFact(value[0], "identity_file", config.target.identity_file)
    || !validLocalInputFact(value[1], "known_hosts_file", config.target.known_hosts_file)) {
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_TRANSPORT_FACTS_INVALID", stage);
  }
  return value as LocalInputFact[];
}

function sameTransportFacts(left: LocalInputFact[], right: LocalInputFact[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function captureBoundTransportInputs(
  admission: M4fDirectAdmissionConfig,
  stage: "local_preflight" | "remote_write",
): LocalInputFact[] {
  try {
    return captureM4fDirectTransportInputs(
      admission,
      stage === "local_preflight" ? "local_preflight" : "network",
    );
  } catch (error) {
    const underlying = error !== null && typeof error === "object" && "detail" in error
      ? (error as { detail: unknown }).detail
      : null;
    fail("M4F_DIRECT_GATE_ROOTS_TRANSPORT_INPUT_INVALID", stage, { underlying });
  }
}

function bindAdmissionV1(
  config: M4fDirectGateRootsConfig,
  rawAdmissionConfig: Record<string, unknown>,
  admissionRecord: Record<string, unknown>,
  rawApproval: Record<string, unknown>,
  stage: "local_preflight" | "remote_write",
): BoundAdmission {
  let admissionConfig: M4fDirectAdmissionConfig;
  try {
    admissionConfig = validateM4fDirectAdmissionConfig(rawAdmissionConfig);
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_CONFIG_INVALID", stage);
  }
  if (!exactKeys(rawApproval, APPROVAL_KEYS)
    || rawApproval.schema !== "synthia-m4f-direct-admission-approval.v1"
    || rawApproval.decision !== "approved"
    || rawApproval.gate_id !== config.gate_id
    || typeof rawApproval.reviewer !== "string" || rawApproval.reviewer.length < 1
    || typeof rawApproval.approved_at_utc !== "string"
    || Number.isNaN(Date.parse(rawApproval.approved_at_utc))
    || rawApproval.admission_config_sha256 !== config.admission_config_sha256
    || rawApproval.admission_record_sha256 !== config.admission_record_sha256
    || !HASH.test(String(rawApproval.effective_config_sha256))
    || rawApproval.target_host !== "100.96.223.49"
    || rawApproval.target_computer !== "DESKTOP-DVFFB09") {
    fail("M4F_DIRECT_GATE_ROOTS_APPROVAL_INVALID", stage);
  }
  const approval = rawApproval as unknown as M4fDirectAdmissionApproval;
  const binding = object(admissionRecord.target_binding);
  const wrapperFact = directPowerShellStdinWrapperFact();
  if (!exactKeys(admissionRecord, ADMISSION_RECORD_KEYS)
    || admissionRecord.schema !== "synthia-m4f-direct-admission-record.v1"
    || admissionRecord.gate_id !== config.gate_id
    || admissionRecord.status !== "observed"
    || admissionRecord.retry_permitted !== false
    || admissionRecord.config_sha256 !== config.admission_config_sha256
    || admissionRecord.effective_config_sha256 !== approval.effective_config_sha256
    || admissionRecord.remote_wrapper_length !== wrapperFact.source_length
    || admissionRecord.remote_wrapper_sha256 !== wrapperFact.source_sha256
    || admissionRecord.remote_command_length !== wrapperFact.command_length
    || !binding || binding.host !== "100.96.223.49" || binding.port !== 22
    || binding.user !== "admin" || binding.computer_name !== "DESKTOP-DVFFB09"
    || binding.identity_name !== admissionConfig.target.identity_name
    || binding.identity_sid !== admissionConfig.target.identity_sid
    || binding.host_key_fingerprint !== admissionConfig.target.host_key_fingerprint) {
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_BINDING_INVALID", stage);
  }
  const transportFacts = admissionTransportFacts(admissionRecord.local_inputs_after, admissionConfig, stage);
  return {
    admissionConfig,
    admissionRecord,
    approval,
    transportFacts,
    admissionContract: "v1",
    admissionId: null,
    baseAdmissionConfigSha256: config.admission_config_sha256,
    admissionConfigCanonicalSha256: config.admission_config_sha256,
  };
}

function validV2BoundFile(
  value: unknown,
  path: string,
  expectedSha256: string,
): boolean {
  const fact = object(value);
  return !!fact && exactKeys(fact, V2_BOUND_FILE_KEYS)
    && fact.path === path && fact.sha256 === expectedSha256
    && safeInteger(fact.device) && safeInteger(fact.inode) && safeInteger(fact.owner_uid)
    && fact.mode === 0o600 && fact.link_count === 1 && safeInteger(fact.size, 1)
    && typeof fact.mtime_ms === "number" && Number.isFinite(fact.mtime_ms)
    && typeof fact.ctime_ms === "number" && Number.isFinite(fact.ctime_ms);
}

function validV2Process(value: unknown): boolean {
  const process = object(value);
  return !!process && exactKeys(process, V2_PROCESS_KEYS)
    && process.exit_status === 0 && process.signal === null && process.error_code === null
    && process.timed_out === false && process.outcome_ambiguous === false
    && process.stdin_length === 0 && safeInteger(process.stdout_length, 1)
    && typeof process.stdout_sha256 === "string" && HASH.test(process.stdout_sha256)
    && process.stderr_length === 0 && typeof process.stderr_sha256 === "string"
    && HASH.test(process.stderr_sha256) && process.retry_permitted === false;
}

function bindAdmissionV2(
  config: M4fDirectGateRootsConfig,
  rawV2Config: Record<string, unknown>,
  admissionRecord: Record<string, unknown>,
  rawApproval: Record<string, unknown>,
  stage: "local_preflight" | "remote_write",
): BoundAdmission {
  let v2Config: M4fDirectAdmissionV2Config;
  try {
    v2Config = validateAdmissionV2Config(rawV2Config);
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_V2_CONFIG_INVALID", stage);
  }
  const rawBaseConfig = readBoundJson(
    v2Config.admission_config_path,
    v2Config.admission_config_sha256,
    "base_admission_config",
    stage,
  );
  let admissionConfig: M4fDirectAdmissionConfig;
  try {
    admissionConfig = validateM4fDirectAdmissionConfig(rawBaseConfig);
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_BASE_ADMISSION_CONFIG_INVALID", stage);
  }
  const v2CanonicalSha256 = sha256(Buffer.from(canonicalJson(v2Config) + "\n", "utf8"));
  const hashValues = [
    rawApproval.admission_v2_config_sha256,
    rawApproval.admission_v2_config_canonical_sha256,
    rawApproval.base_admission_config_sha256,
    rawApproval.admission_record_sha256,
    rawApproval.effective_config_sha256,
    rawApproval.source_sha256,
    rawApproval.transport_source_sha256,
    rawApproval.loader_source_sha256,
    rawApproval.remote_script_sha256,
    rawApproval.remote_compressed_sha256,
    rawApproval.remote_loader_sha256,
  ];
  if (!exactKeys(rawApproval, V2_APPROVAL_KEYS)
    || rawApproval.schema !== "synthia-m4f-direct-admission-v2-approval.v1"
    || rawApproval.decision !== "approved" || rawApproval.gate_id !== config.gate_id
    || rawApproval.admission_id !== v2Config.admission_id
    || typeof rawApproval.reviewer !== "string" || rawApproval.reviewer.length < 1
    || typeof rawApproval.approved_at_utc !== "string"
    || Number.isNaN(Date.parse(rawApproval.approved_at_utc))
    || !hashValues.every((value) => typeof value === "string" && HASH.test(value))
    || rawApproval.admission_v2_config_sha256 !== config.admission_config_sha256
    || rawApproval.admission_v2_config_canonical_sha256 !== v2CanonicalSha256
    || rawApproval.base_admission_config_sha256 !== v2Config.admission_config_sha256
    || rawApproval.admission_record_sha256 !== config.admission_record_sha256
    || rawApproval.effective_config_sha256 !== admissionConfig.target.expected_effective_config_sha256
    || rawApproval.source_sha256 !== v2Config.expected_source_sha256
    || rawApproval.transport_source_sha256 !== v2Config.expected_transport_source_sha256
    || rawApproval.loader_source_sha256 !== v2Config.expected_loader_source_sha256
    || rawApproval.target_host !== admissionConfig.target.host
    || rawApproval.target_user !== admissionConfig.target.user
    || rawApproval.target_computer !== admissionConfig.target.computer_name
    || rawApproval.target_identity_name !== admissionConfig.target.identity_name
    || rawApproval.target_identity_sid !== admissionConfig.target.identity_sid
    || rawApproval.host_key_fingerprint !== admissionConfig.target.host_key_fingerprint) {
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_V2_APPROVAL_INVALID", stage);
  }
  const beforeFact = admissionRecord.admission_config_before;
  const afterFact = admissionRecord.admission_config_after;
  const transportBefore = admissionTransportFacts(
    admissionRecord.transport_inputs_before,
    admissionConfig,
    stage,
  );
  const transportAfter = admissionTransportFacts(
    admissionRecord.transport_inputs_after,
    admissionConfig,
    stage,
  );
  if (!exactKeys(admissionRecord, V2_ADMISSION_RECORD_KEYS)
    || admissionRecord.schema !== "synthia-m4f-direct-admission-v2-record.v1"
    || admissionRecord.admission_id !== v2Config.admission_id
    || admissionRecord.status !== "observed"
    || admissionRecord.action !== "single_session_admission_snapshot"
    || admissionRecord.retry_permitted !== false
    || typeof admissionRecord.recorded_at_utc !== "string"
    || Number.isNaN(Date.parse(admissionRecord.recorded_at_utc))
    || !safeInteger(admissionRecord.elapsed_ms)
    || admissionRecord.config_sha256 !== v2CanonicalSha256
    || admissionRecord.source_sha256 !== v2Config.expected_source_sha256
    || admissionRecord.transport_source_sha256 !== v2Config.expected_transport_source_sha256
    || admissionRecord.loader_source_sha256 !== v2Config.expected_loader_source_sha256
    || admissionRecord.effective_config_sha256 !== rawApproval.effective_config_sha256
    || !safeInteger(admissionRecord.remote_script_length, 1)
    || admissionRecord.remote_script_sha256 !== rawApproval.remote_script_sha256
    || !safeInteger(admissionRecord.remote_compressed_length, 1)
    || admissionRecord.remote_compressed_sha256 !== rawApproval.remote_compressed_sha256
    || !safeInteger(admissionRecord.remote_loader_length, 1)
    || admissionRecord.remote_loader_sha256 !== rawApproval.remote_loader_sha256
    || !safeInteger(admissionRecord.remote_command_length, 1)
    || Number(admissionRecord.remote_command_length) > 6500
    || admissionRecord.attempt !== 1 || admissionRecord.timeout_ms !== 240000
    || admissionRecord.stdin_length !== 0 || !validV2Process(admissionRecord.process)
    || !validV2BoundFile(beforeFact, v2Config.admission_config_path, v2Config.admission_config_sha256)
    || !validV2BoundFile(afterFact, v2Config.admission_config_path, v2Config.admission_config_sha256)
    || canonicalJson(beforeFact) !== canonicalJson(afterFact)
    || !sameTransportFacts(transportBefore, transportAfter)
    || admissionRecord.hardware_action_performed !== false
    || admissionRecord.process_termination_performed !== false) {
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_V2_BINDING_INVALID", stage);
  }
  try {
    const snapshot = object(admissionRecord.target_snapshot);
    if (!snapshot) fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_V2_SNAPSHOT_INVALID", stage);
    validateAdmissionV2Snapshot(snapshot, admissionConfig);
  } catch (error) {
    if (error instanceof DirectGateRootsFailure) throw error;
    fail("M4F_DIRECT_GATE_ROOTS_ADMISSION_V2_SNAPSHOT_INVALID", stage);
  }
  return {
    admissionConfig,
    admissionRecord,
    approval: rawApproval as unknown as M4fDirectAdmissionV2Approval,
    transportFacts: transportAfter,
    admissionContract: "v2",
    admissionId: v2Config.admission_id,
    baseAdmissionConfigSha256: v2Config.admission_config_sha256,
    admissionConfigCanonicalSha256: v2CanonicalSha256,
  };
}

function bindAdmission(
  config: M4fDirectGateRootsConfig,
  stage: "local_preflight" | "remote_write" = "local_preflight",
): BoundAdmission {
  const rawAdmissionConfig = readBoundJson(
    config.admission_config_path,
    config.admission_config_sha256,
    "admission_config",
    stage,
  );
  const admissionRecord = readBoundJson(
    config.admission_record_path,
    config.admission_record_sha256,
    "admission_record",
    stage,
  );
  const rawApproval = readBoundJson(
    config.admission_approval_path,
    config.admission_approval_sha256,
    "admission_approval",
    stage,
  );
  return config.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? bindAdmissionV1(config, rawAdmissionConfig, admissionRecord, rawApproval, stage)
    : bindAdmissionV2(config, rawAdmissionConfig, admissionRecord, rawApproval, stage);
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function directGateRootsEffectBindingSha256(
  rawConfig: unknown,
  admission: M4fDirectAdmissionConfig,
): string {
  const config = validateDirectGateRootsConfig(rawConfig);
  return sha256(Buffer.from(canonicalJson({
    schema: "synthia-m4f-direct-gate-roots-effect-binding.v1",
    gate_id: config.gate_id,
    gate_root: "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id,
    backing_root: "D:\\synthia-m4f-toolchain-" + config.gate_id,
    service_identity_sid: config.service_identity_sid,
    minimum_gate_free_bytes: config.minimum_gate_free_bytes,
    minimum_backing_free_bytes: config.minimum_backing_free_bytes,
    target_computer: admission.target.computer_name,
    target_identity_name: admission.target.identity_name,
    target_identity_sid: admission.target.identity_sid,
  }) + "\n", "utf8"));
}

export function buildDirectGateRootsRemoteScript(
  config: M4fDirectGateRootsConfig,
  admission: M4fDirectAdmissionConfig,
  remoteBindingSha256: string,
): string {
  const gateRoot = "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id;
  const backingRoot = "D:\\synthia-m4f-toolchain-" + config.gate_id;
  const bindingVariable = config.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? "$confirmationSha256=" + psLiteral(remoteBindingSha256)
    : "$effectBindingSha256=" + psLiteral(remoteBindingSha256);
  const resultBinding = config.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? "schema=\"synthia-m4f-direct-gate-roots-result.v1\"; status=\"created\"; gate_id=$gateId; confirmation_sha256=$confirmationSha256"
    : "schema=\"synthia-m4f-direct-gate-roots-result.v2\"; status=\"created\"; gate_id=$gateId; effect_binding_sha256=$effectBindingSha256";
  const serviceIdentityCheck = config.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? "if ($serviceSid.Value -ceq $administratorsSid.Value -or $serviceSid.Value -ceq $systemSid.Value) { throw \"M4F_DIRECT_GATE_ROOTS_SERVICE_IDENTITY_INVALID\" }"
    : "if ($serviceSid.Value -cne \"" + LOCAL_SERVICE_SID + "\") { throw \"M4F_DIRECT_GATE_ROOTS_SERVICE_IDENTITY_INVALID\" }";
  return [
    "Set-StrictMode -Version Latest",
    "$ErrorActionPreference=\"Stop\"; $ProgressPreference=\"SilentlyContinue\"; $WarningPreference=\"SilentlyContinue\"",
    "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)",
    "$gateId=" + psLiteral(config.gate_id),
    "$gateRoot=" + psLiteral(gateRoot),
    "$backingRoot=" + psLiteral(backingRoot),
    "$serviceSid=[Security.Principal.SecurityIdentifier]::new(" + psLiteral(config.service_identity_sid) + ")",
    "$expectedComputer=" + psLiteral(admission.target.computer_name),
    "$expectedIdentityName=" + psLiteral(admission.target.identity_name),
    "$expectedIdentitySid=" + psLiteral(admission.target.identity_sid),
    bindingVariable,
    "$minimumGateFree=[int64]" + config.minimum_gate_free_bytes,
    "$minimumBackingFree=[int64]" + config.minimum_backing_free_bytes,
    "$administratorsSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-32-544\"); $systemSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-18\"); $trustedInstallerSid=[Security.Principal.SecurityIdentifier]::new(\"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464\")",
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[Security.Principal.WindowsPrincipal]::new($identity); $identityName=$identity.Name.ToLowerInvariant()",
    "if ($env:COMPUTERNAME -cne $expectedComputer -or $identityName -cne $expectedIdentityName -or $identity.User.Value -cne $expectedIdentitySid -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw \"M4F_DIRECT_GATE_ROOTS_ADMIN_IDENTITY_INVALID\" }",
    serviceIdentityCheck,
    "function Volume-Fact([string]$Path,[string]$ExpectedRoot,[int64]$MinimumFree) { $full=[IO.Path]::GetFullPath($Path); $root=[IO.Path]::GetPathRoot($full); if (-not $root.Equals($ExpectedRoot,[StringComparison]::OrdinalIgnoreCase)) { throw \"M4F_DIRECT_GATE_ROOTS_VOLUME_SCOPE_INVALID\" }; $letter=$ExpectedRoot.Substring(0,1); $logical=@(Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='\"+$letter+\":'\")); if ($logical.Count -ne 1 -or [int]$logical[0].DriveType -ne 3 -or [string]$logical[0].FileSystem -cne \"NTFS\" -or [int64]$logical[0].FreeSpace -lt $MinimumFree -or [string]::IsNullOrWhiteSpace([string]$logical[0].VolumeSerialNumber)) { throw \"M4F_DIRECT_GATE_ROOTS_LOCAL_FIXED_NTFS_REQUIRED\" }; $volume=Get-Volume -DriveLetter $letter; $partition=Get-Partition -DriveLetter $letter; $disk=$partition | Get-Disk; if ([string]$volume.FileSystem -cne \"NTFS\" -or [string]$volume.DriveType -cne \"Fixed\" -or [string]::IsNullOrWhiteSpace([string]$volume.UniqueId) -or [string]::IsNullOrWhiteSpace([string]$disk.UniqueId) -or $disk.IsOffline -or -not (@($partition.AccessPaths) -contains $ExpectedRoot)) { throw \"M4F_DIRECT_GATE_ROOTS_VOLUME_MAPPING_INVALID\" }; return [ordered]@{ root=$ExpectedRoot; device_id=$letter+\":\"; drive_type=[int]$logical[0].DriveType; file_system=[string]$logical[0].FileSystem; free_bytes=[int64]$logical[0].FreeSpace; logical_volume_serial=[string]$logical[0].VolumeSerialNumber; volume_unique_id=[string]$volume.UniqueId; volume_serial_number=[string]$logical[0].VolumeSerialNumber; disk_number=[int]$partition.DiskNumber; partition_number=[int]$partition.PartitionNumber; disk_unique_id=[string]$disk.UniqueId } }",
    "function Ancestors([string]$Path,[string]$Root,[bool]$StrictAcl) { $current=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force; $facts=@(); while ($null -ne $current) { $reparse=[bool](($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); if (-not ($current -is [IO.DirectoryInfo]) -or $reparse) { throw \"M4F_DIRECT_GATE_ROOTS_ANCESTOR_TYPE_INVALID\" }; $acl=Get-Acl -LiteralPath $current.FullName; $ownerReference=$acl.GetOwner([Security.Principal.SecurityIdentifier]); if (-not ($ownerReference -is [Security.Principal.SecurityIdentifier])) { throw \"M4F_DIRECT_GATE_ROOTS_ANCESTOR_OWNER_SID_INVALID\" }; $owner=$ownerReference.Value; $trusted=@($administratorsSid.Value,$systemSid.Value,$trustedInstallerSid.Value); if ($StrictAcl -and -not ($trusted -ccontains $owner)) { throw \"M4F_DIRECT_GATE_ROOTS_ANCESTOR_OWNER_UNTRUSTED\" }; $nativeRules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); $rules=@($nativeRules | ForEach-Object { if (-not ($_.IdentityReference -is [Security.Principal.SecurityIdentifier])) { throw \"M4F_DIRECT_GATE_ROOTS_ANCESTOR_RULE_SID_INVALID\" }; $sid=$_.IdentityReference.Value; $rights=[int]$_.FileSystemRights; $applies=(($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0); if ($StrictAcl -and -not ($trusted -ccontains $sid) -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $applies -and (($rights -band 852032) -ne 0)) { throw \"M4F_DIRECT_GATE_ROOTS_ANCESTOR_REPLACE_UNTRUSTED\" }; [ordered]@{ sid=$sid; type=$_.AccessControlType.ToString(); rights=$rights; inherited=[bool]$_.IsInherited; inheritance=$_.InheritanceFlags.ToString(); propagation=$_.PropagationFlags.ToString(); applies_to_current=[bool]$applies } } | Sort-Object sid,type,rights,inherited,inheritance,propagation,applies_to_current); $facts+=,[ordered]@{ path=$current.FullName; owner_sid=$owner; reparse=$false; acl_protected=[bool]$acl.AreAccessRulesProtected; strict_acl=[bool]$StrictAcl; rules=$rules }; if ($current.FullName.TrimEnd('\\').Equals($Root.TrimEnd('\\'),[StringComparison]::OrdinalIgnoreCase)) { $facts; return }; $current=$current.Parent }; throw \"M4F_DIRECT_GATE_ROOTS_ANCESTOR_CHAIN_INCOMPLETE\" }",
    "function Root-Acl { $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($administratorsSid); $acl.SetAccessRuleProtection($true,$false); $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit; $none=[Security.AccessControl.PropagationFlags]::None; $allow=[Security.AccessControl.AccessControlType]::Allow; [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administratorsSid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$none,$allow)); [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$none,$allow)); $rx=[Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize; [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid,$rx,$inherit,$none,$allow)); return $acl }",
    "function Root-Fact([string]$Path) { $item=Get-Item -LiteralPath $Path -Force; if (-not ($item -is [IO.DirectoryInfo]) -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or @(Get-ChildItem -LiteralPath $Path -Force).Count -ne 0 -or @(Get-Item -LiteralPath $Path -Stream * | Where-Object { [string]$_.Stream -cne ':$DATA' }).Count -ne 0) { throw \"M4F_DIRECT_GATE_ROOTS_ROOT_OBJECT_INVALID\" }; $acl=Get-Acl -LiteralPath $Path; $ownerReference=$acl.GetOwner([Security.Principal.SecurityIdentifier]); if (-not ($ownerReference -is [Security.Principal.SecurityIdentifier]) -or $ownerReference.Value -cne $administratorsSid.Value -or -not $acl.AreAccessRulesProtected) { throw \"M4F_DIRECT_GATE_ROOTS_ROOT_ACL_INVALID\" }; $expected=@{}; $expected[$administratorsSid.Value]=[int64][Security.AccessControl.FileSystemRights]::FullControl; $expected[$systemSid.Value]=[int64][Security.AccessControl.FileSystemRights]::FullControl; $expected[$serviceSid.Value]=[int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize); $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if ($rules.Count -ne 3) { throw \"M4F_DIRECT_GATE_ROOTS_ROOT_ACE_COUNT_INVALID\" }; $facts=@($rules | ForEach-Object { if (-not ($_.IdentityReference -is [Security.Principal.SecurityIdentifier])) { throw \"M4F_DIRECT_GATE_ROOTS_ROOT_RULE_SID_INVALID\" }; $sid=$_.IdentityReference.Value; if (-not $expected.ContainsKey($sid) -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $_.IsInherited -or [int64]$_.FileSystemRights -ne $expected[$sid] -or $_.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw \"M4F_DIRECT_GATE_ROOTS_ROOT_ACE_INVALID\" }; [ordered]@{ sid=$sid; rights=[int64]$_.FileSystemRights } } | Sort-Object sid); return [ordered]@{ path=$Path; owner_sid=$ownerReference.Value; protected=$true; explicit_ace_count=3; empty=$true; reparse=$false; alternate_streams=$false; rules=$facts } }",
    "$gateVolumeBefore=Volume-Fact $gateRoot \"C:\\\" $minimumGateFree; $backingVolumeBefore=Volume-Fact $backingRoot \"D:\\\" $minimumBackingFree",
    "if (Test-Path -LiteralPath $gateRoot) { throw \"M4F_DIRECT_GATE_ROOTS_ALREADY_EXISTS_GATE\" }; if (Test-Path -LiteralPath $backingRoot) { throw \"M4F_DIRECT_GATE_ROOTS_ALREADY_EXISTS_BACKING\" }",
    "[object[]]$gateAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($gateRoot)) \"C:\\\" $true); [object[]]$backingAncestorsBefore=@(Ancestors ([IO.Path]::GetDirectoryName($backingRoot)) \"D:\\\" $false)",
    "# No cleanup is intentional. Partial creation is evidence and requires a new reviewed gate id.",
    "[void](New-Item -ItemType Directory -Path $gateRoot -ErrorAction Stop); Set-Acl -LiteralPath $gateRoot -AclObject (Root-Acl); $gateFact=Root-Fact $gateRoot",
    "[void](New-Item -ItemType Directory -Path $backingRoot -ErrorAction Stop); Set-Acl -LiteralPath $backingRoot -AclObject (Root-Acl); $backingFact=Root-Fact $backingRoot",
    "[object[]]$gateAncestorsAfter=@(Ancestors $gateRoot \"C:\\\" $true); [object[]]$backingAncestorsAfter=@(Ancestors $backingRoot \"D:\\\" $false); $gateVolumeAfter=Volume-Fact $gateRoot \"C:\\\" $minimumGateFree; $backingVolumeAfter=Volume-Fact $backingRoot \"D:\\\" $minimumBackingFree",
    "foreach ($pair in @(@($gateVolumeBefore,$gateVolumeAfter),@($backingVolumeBefore,$backingVolumeAfter))) { foreach ($name in @(\"root\",\"device_id\",\"drive_type\",\"file_system\",\"logical_volume_serial\",\"volume_unique_id\",\"volume_serial_number\",\"disk_number\",\"partition_number\",\"disk_unique_id\")) { if ([string]$pair[0].$name -cne [string]$pair[1].$name) { throw \"M4F_DIRECT_GATE_ROOTS_VOLUME_MAPPING_DRIFT\" } } }",
    "$result=[ordered]@{ " + resultBinding + "; identity=[ordered]@{ computer_name=$env:COMPUTERNAME; identity_name=$identityName; identity_sid=$identity.User.Value }; gate_root=$gateRoot; backing_root=$backingRoot; created_count=2; no_cleanup=$true; gate_root_fact=$gateFact; backing_root_fact=$backingFact; gate_volume_before=$gateVolumeBefore; gate_volume_after=$gateVolumeAfter; backing_volume_before=$backingVolumeBefore; backing_volume_after=$backingVolumeAfter; gate_ancestors_before=$gateAncestorsBefore; gate_ancestors_after=$gateAncestorsAfter; backing_ancestors_before=$backingAncestorsBefore; backing_ancestors_after=$backingAncestorsAfter }",
    "$result | ConvertTo-Json -Compress -Depth 14",
    "",
  ].join("\n");
}

function processEvidence(raw: RawProcessResult, stdin: Buffer = Buffer.alloc(0)): ProcessEvidence {
  const timedOut = raw.errorCode === "ETIMEDOUT";
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: timedOut,
    outcome_ambiguous: timedOut || raw.signal !== null || raw.errorCode !== null || raw.status !== 0,
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function parseResult(
  bytes: Buffer,
  config: M4fDirectGateRootsConfig,
  admission: M4fDirectAdmissionConfig,
  remoteBindingHash: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID", "output_validation");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) fail("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID", "output_validation");
  let result: Record<string, unknown>;
  try {
    const parsed = object(JSON.parse(lines[0]!));
    if (!parsed) fail("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID", "output_validation");
    result = parsed;
  } catch (error) {
    if (error instanceof DirectGateRootsFailure) throw error;
    fail("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID", "output_validation");
  }
  const identity = object(result.identity);
  const gateRoot = "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id;
  const backingRoot = "D:\\synthia-m4f-toolchain-" + config.gate_id;
  const resultBindingValid = config.schema === "synthia-m4f-direct-gate-roots-config.v1"
    ? exactKeys(result, RESULT_V1_KEYS)
      && result.schema === "synthia-m4f-direct-gate-roots-result.v1"
      && result.confirmation_sha256 === remoteBindingHash
    : exactKeys(result, RESULT_V2_KEYS)
      && result.schema === "synthia-m4f-direct-gate-roots-result.v2"
      && result.effect_binding_sha256 === remoteBindingHash;
  if (!resultBindingValid
    || result.status !== "created" || result.gate_id !== config.gate_id
    || result.gate_root !== gateRoot || result.backing_root !== backingRoot
    || result.created_count !== 2 || result.no_cleanup !== true
    || !identity || !exactKeys(identity, IDENTITY_KEYS)
    || identity.computer_name !== admission.target.computer_name
    || identity.identity_name !== admission.target.identity_name
    || identity.identity_sid !== admission.target.identity_sid
    || !validRootFact(result.gate_root_fact, gateRoot, config.service_identity_sid)
    || !validRootFact(result.backing_root_fact, backingRoot, config.service_identity_sid)
    || !validAncestors(result.gate_ancestors_before, true, "C:\\Windows\\Temp")
    || !validAncestors(result.gate_ancestors_after, true, gateRoot)
    || !validAncestors(result.backing_ancestors_before, false, "D:\\")
    || !validAncestors(result.backing_ancestors_after, false, backingRoot)
    || !validVolumeFact(result.gate_volume_before, "C:\\")
    || !validVolumeFact(result.gate_volume_after, "C:\\")
    || !validVolumeFact(result.backing_volume_before, "D:\\")
    || !validVolumeFact(result.backing_volume_after, "D:\\")
    || !sameVolumeIdentity(result.gate_volume_before, result.gate_volume_after)
    || !sameVolumeIdentity(result.backing_volume_before, result.backing_volume_after)) {
    fail("M4F_DIRECT_GATE_ROOTS_OUTPUT_INVALID", "output_validation");
  }
  return result;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function signedInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= -2_147_483_648 && value <= 2_147_483_647;
}

function validVolumeFact(value: unknown, root: "C:\\" | "D:\\"): boolean {
  const fact = object(value);
  return !!fact && exactKeys(fact, VOLUME_KEYS)
    && fact.root === root && fact.device_id === root.slice(0, 2)
    && fact.drive_type === 3 && fact.file_system === "NTFS"
    && safeInteger(fact.free_bytes)
    && typeof fact.logical_volume_serial === "string" && fact.logical_volume_serial.length > 0
    && typeof fact.volume_unique_id === "string" && fact.volume_unique_id.length > 0
    && typeof fact.volume_serial_number === "string" && fact.volume_serial_number.length > 0
    && fact.volume_serial_number === fact.logical_volume_serial
    && safeInteger(fact.disk_number) && safeInteger(fact.partition_number, 1)
    && typeof fact.disk_unique_id === "string" && fact.disk_unique_id.length > 0;
}

function sameVolumeIdentity(before: unknown, after: unknown): boolean {
  const left = object(before);
  const right = object(after);
  if (!left || !right) return false;
  return [
    "root", "device_id", "drive_type", "file_system", "logical_volume_serial",
    "volume_unique_id", "volume_serial_number", "disk_number", "partition_number", "disk_unique_id",
  ].every((key) => left[key] === right[key]);
}

function validRootFact(value: unknown, path: string, serviceSid: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, ROOT_FACT_KEYS)
    || fact.path !== path || fact.owner_sid !== "S-1-5-32-544"
    || fact.protected !== true || fact.explicit_ace_count !== 3
    || fact.empty !== true || fact.reparse !== false || fact.alternate_streams !== false
    || !Array.isArray(fact.rules) || fact.rules.length !== 3) return false;
  const expected = new Map<string, number>([
    ["S-1-5-32-544", 2032127],
    ["S-1-5-18", 2032127],
    [serviceSid, 1179817],
  ]);
  for (const value of fact.rules) {
    const rule = object(value);
    if (!rule || !exactKeys(rule, ROOT_RULE_KEYS) || typeof rule.sid !== "string"
      || expected.get(rule.sid) !== rule.rights) return false;
    expected.delete(rule.sid);
  }
  return expected.size === 0;
}

function validAncestors(value: unknown, strictAcl: boolean, expectedFirst: string): boolean {
  if (!Array.isArray(value) || value.length < 1) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const fact = object(value[index]);
    if (!fact || !exactKeys(fact, ANCESTOR_KEYS)
      || typeof fact.path !== "string" || (index === 0 && fact.path !== expectedFirst)
      || seen.has(fact.path.toLowerCase()) || typeof fact.owner_sid !== "string"
      || !SID.test(fact.owner_sid) || fact.reparse !== false
      || typeof fact.acl_protected !== "boolean" || fact.strict_acl !== strictAcl
      || !Array.isArray(fact.rules)) return false;
    seen.add(fact.path.toLowerCase());
    for (const value of fact.rules) {
      const rule = object(value);
      if (!rule || !exactKeys(rule, ANCESTOR_RULE_KEYS)
        || typeof rule.sid !== "string" || !SID.test(rule.sid)
        || (rule.type !== "Allow" && rule.type !== "Deny")
        || !signedInt32(rule.rights) || typeof rule.inherited !== "boolean"
        || typeof rule.inheritance !== "string" || typeof rule.propagation !== "string"
        || typeof rule.applies_to_current !== "boolean") return false;
    }
  }
  return true;
}

function throwRemoteWriteFailure(
  error: unknown,
  diagnosticBinding: Record<string, unknown>,
  effectiveConfig: Buffer,
  remoteScript: Buffer,
  raw?: RawProcessResult,
): never {
  const process = raw ? processEvidence(raw, remoteScript) : undefined;
  const remoteAttempt: RemoteWriteAttemptEvidence = {
    schema: "synthia-m4f-direct-gate-roots-remote-attempt.v1",
    started: true,
    process_result_returned: raw !== undefined,
    raw_stdout_captured: raw !== undefined,
    raw_stderr_captured: raw !== undefined,
  };
  const originalDetail = error instanceof DirectGateRootsFailure
    ? error.detail
    : {
      schema: "synthia-m4f-direct-gate-roots-failure.v1",
      code: raw
        ? "M4F_DIRECT_GATE_ROOTS_UNEXPECTED"
        : "M4F_DIRECT_GATE_ROOTS_TRANSPORT_INVOCATION_FAILED",
      stage: "remote_write",
      remote_write_state: "unknown",
      retry_permitted: false,
      cleanup_permitted: false,
    };
  throw new DirectGateRootsFailure({
    ...originalDetail,
    ...(process ? { process } : {}),
    remote_attempt: remoteAttempt,
    ...diagnosticBinding,
  }, {
    ...(error instanceof DirectGateRootsFailure ? error.evidence : {}),
    effectiveConfig: Buffer.from(effectiveConfig),
    remoteScript: Buffer.from(remoteScript),
    ...(raw ? {
      rawStdout: Buffer.from(raw.stdout),
      rawStderr: Buffer.from(raw.stderr),
      process,
    } : {}),
    remoteAttempt,
  });
}

export function executeDirectGateRoots(
  rawConfig: unknown,
  confirmation: string,
  dependencies: DirectGateRootsDependencies = systemDependencies,
): { record: DirectGateRootsRecord; effectiveConfig: Buffer; rawResult: Buffer; remoteScript: Buffer } {
  const config = validateDirectGateRootsConfig(rawConfig);
  const configBytes = Buffer.from(canonicalJson(config) + "\n", "utf8");
  const expectedConfirmation = directGateRootsConfirmation(config);
  if (confirmation !== expectedConfirmation) {
    fail("M4F_DIRECT_GATE_ROOTS_CONFIRMATION_REQUIRED", "local_preflight");
  }
  if (config.schema !== "synthia-m4f-direct-gate-roots-config.v3") {
    fail("M4F_DIRECT_GATE_ROOTS_LEGACY_EXECUTION_FORBIDDEN", "local_preflight");
  }
  const bound = bindAdmission(config);
  const approvedTransportInputs = bound.transportFacts;
  const transportInputsBefore = captureBoundTransportInputs(bound.admissionConfig, "local_preflight");
  if (!sameTransportFacts(approvedTransportInputs, transportInputsBefore)) {
    fail("M4F_DIRECT_GATE_ROOTS_TRANSPORT_INPUT_DRIFT", "local_preflight");
  }
  const confirmationHash = sha256(confirmation);
  const executionTcb = bindExecutionTcb(config, bound, confirmationHash, dependencies);
  const rootsApproval = bindRootsApproval(config, bound, executionTcb);
  const sourceBefore = executionTcb.sourceBytes;
  const diagnosticBinding = {
    config_sha256: sha256(configBytes),
    source_sha256: executionTcb.sourceSha256,
  };
  const effective = dependencies.spawn(
    SSH_PATH,
    buildDirectSshEffectiveArguments(bound.admissionConfig),
    Buffer.alloc(0),
    15_000,
  );
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) {
    fail("M4F_DIRECT_GATE_ROOTS_EFFECTIVE_CONFIG_FAILED", "local_preflight", { process: processEvidence(effective) });
  }
  try {
    auditDirectSshEffectiveConfig(effective.stdout, bound.admissionConfig);
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_EFFECTIVE_CONFIG_MISMATCH", "local_preflight");
  }
  const effectiveHash = sha256(effective.stdout);
  if (effectiveHash !== bound.approval.effective_config_sha256) {
    fail("M4F_DIRECT_GATE_ROOTS_EFFECTIVE_CONFIG_HASH_MISMATCH", "local_preflight");
  }
  const remoteScript = executionTcb.remoteScript;
  const args = [
    ...buildDirectSshOptions(bound.admissionConfig),
    "100.96.223.49",
    buildDirectPowerShellStdinCommand(),
  ];
  let raw: RawProcessResult;
  try {
    raw = dependencies.spawn(SSH_PATH, args, remoteScript, 120_000);
  } catch (error) {
    throwRemoteWriteFailure(
      error,
      diagnosticBinding,
      effective.stdout,
      remoteScript,
    );
  }
  const process = processEvidence(raw, remoteScript);
  let transportInputsAfter: LocalInputFact[];
  let result: Record<string, unknown>;
  try {
    const sourceAfter = dependencies.sourceBytes();
    transportInputsAfter = captureBoundTransportInputs(bound.admissionConfig, "remote_write");
    if (!sameTransportFacts(transportInputsBefore, transportInputsAfter)
      || !sameTransportFacts(approvedTransportInputs, transportInputsAfter)) {
      fail("M4F_DIRECT_GATE_ROOTS_TRANSPORT_INPUT_DRIFT", "remote_write");
    }
    const rebound = bindAdmission(config, "remote_write");
    bindRootsApproval(config, rebound, executionTcb, "remote_write");
    if (!sourceBefore.equals(sourceAfter)) {
      fail("M4F_DIRECT_GATE_ROOTS_SOURCE_DRIFT", "remote_write");
    }
    if (raw.status !== 0 || raw.signal !== null || raw.errorCode !== null || raw.stderr.length !== 0) {
      fail("M4F_DIRECT_GATE_ROOTS_TRANSPORT_FAILED", "remote_write");
    }
    result = parseResult(
      raw.stdout,
      config,
      bound.admissionConfig,
      executionTcb.effectBindingSha256,
    );
  } catch (error) {
    throwRemoteWriteFailure(
      error,
      diagnosticBinding,
      effective.stdout,
      remoteScript,
      raw,
    );
  }
  const recordBase: DirectGateRootsRecordBase = {
    gate_id: config.gate_id,
    status: "created",
    retry_permitted: false,
    recorded_at_utc: dependencies.now().toISOString(),
    confirmation_sha256: confirmationHash,
    config_sha256: diagnosticBinding.config_sha256,
    source_sha256: diagnosticBinding.source_sha256,
    remote_script_sha256: sha256(remoteScript),
    remote_wrapper_length: directPowerShellStdinWrapperFact().source_length,
    remote_wrapper_sha256: directPowerShellStdinWrapperFact().source_sha256,
    remote_command_length: directPowerShellStdinWrapperFact().command_length,
    transport_inputs_before: transportInputsBefore,
    transport_inputs_after: transportInputsAfter,
    admission_config_sha256: config.admission_config_sha256,
    admission_record_sha256: config.admission_record_sha256,
    admission_approval_sha256: config.admission_approval_sha256,
    effective_config_sha256: effectiveHash,
    gate_root: String(result.gate_root),
    backing_root: String(result.backing_root),
    process,
    remote_result: result,
  };
  const record: DirectGateRootsRecord = {
    schema: "synthia-m4f-direct-gate-roots-record.v3",
    ...recordBase,
    admission_contract: "direct_admission_v2",
    admission_id: bound.admissionId!,
    admission_v2_config_sha256: config.admission_config_sha256,
    admission_v2_config_canonical_sha256: bound.admissionConfigCanonicalSha256,
    base_admission_config_sha256: bound.baseAdmissionConfigSha256,
    gate_roots_transport_source_sha256: executionTcb.transportSourceSha256!,
    admission_v2_validator_source_sha256: executionTcb.admissionV2SourceSha256!,
    roots_review_config_sha256: rootsApproval.reviewConfigSha256,
    roots_approval_sha256: config.roots_approval_sha256,
  };
  return {
    record,
    effectiveConfig: effective.stdout,
    rawResult: raw.stdout,
    remoteScript,
  };
}

export function recordDirectGateRoots(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: DirectGateRootsDependencies = systemDependencies,
): DirectGateRootsRecord {
  const config = validateDirectGateRootsConfig(rawConfig);
  if (confirmation !== directGateRootsConfirmation(config)) {
    fail("M4F_DIRECT_GATE_ROOTS_CONFIRMATION_REQUIRED", "local_preflight");
  }
  if (config.schema !== "synthia-m4f-direct-gate-roots-config.v3") {
    fail("M4F_DIRECT_GATE_ROOTS_LEGACY_EXECUTION_FORBIDDEN", "local_preflight");
  }
  const absolute = resolve(evidenceDirectory);
  try {
    mkdirSync(absolute, { mode: 0o700, recursive: false });
    chmodSync(absolute, 0o700);
  } catch {
    fail("M4F_DIRECT_GATE_ROOTS_EVIDENCE_DIRECTORY_INVALID", "local_preflight");
  }
  function write(name: string, content: string | Buffer): void {
    const path = absolute + "/" + name;
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    chmodSync(path, 0o600);
  }
  function bestEffortWrite(name: string, content: string | Buffer): void {
    try {
      write(name, content);
    } catch {
      // The original execution failure remains authoritative. Evidence capture
      // is intentionally best-effort and must never replace or mask it.
    }
  }
  try {
    const evidence = executeDirectGateRoots(config, confirmation, dependencies);
    write("gate-roots-record.json", JSON.stringify(evidence.record, null, 2) + "\n");
    write("direct-ssh-effective-config.txt", evidence.effectiveConfig);
    write("powershell-stdin-wrapper.ps1", M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);
    write("remote-gate-roots-script.ps1", evidence.remoteScript);
    write("remote-gate-roots-result.json", evidence.rawResult);
    return evidence.record;
  } catch (error) {
    const detail = error instanceof DirectGateRootsFailure
      ? error.detail
      : { schema: "synthia-m4f-direct-gate-roots-failure.v1", code: "M4F_DIRECT_GATE_ROOTS_UNEXPECTED", stage: "unknown", remote_write_state: "unknown", retry_permitted: false, cleanup_permitted: false };
    const failureEvidence = error instanceof DirectGateRootsFailure ? error.evidence : {};
    bestEffortWrite("gate-roots-failure.json", JSON.stringify(detail, null, 2) + "\n");
    if (failureEvidence.remoteAttempt) {
      bestEffortWrite(
        "remote-write-attempt.json",
        JSON.stringify(failureEvidence.remoteAttempt, null, 2) + "\n",
      );
      bestEffortWrite(
        "powershell-stdin-wrapper.ps1",
        M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE,
      );
    }
    if (failureEvidence.effectiveConfig !== undefined) {
      bestEffortWrite("direct-ssh-effective-config.txt", failureEvidence.effectiveConfig);
    }
    if (failureEvidence.remoteScript !== undefined) {
      bestEffortWrite("remote-gate-roots-script.ps1", failureEvidence.remoteScript);
    }
    if (failureEvidence.rawStdout !== undefined) {
      bestEffortWrite("remote-gate-roots-stdout.bin", failureEvidence.rawStdout);
    }
    if (failureEvidence.rawStderr !== undefined) {
      bestEffortWrite("remote-gate-roots-stderr.bin", failureEvidence.rawStderr);
    }
    if (failureEvidence.process !== undefined) {
      bestEffortWrite(
        "remote-gate-roots-process.json",
        JSON.stringify(failureEvidence.process, null, 2) + "\n",
      );
    }
    throw error;
  }
}

export function planDirectGateRoots(
  rawConfig: unknown,
  dependencies: DirectGateRootsDependencies = systemDependencies,
): Record<string, unknown> {
  const config = validateDirectGateRootsConfig(rawConfig);
  const bound = bindAdmission(config);
  const configSha256 = directGateRootsConfigSha256(config);
  const plan = {
    schema: "synthia-m4f-direct-gate-roots-plan.v1",
    status: "planned_not_executed",
    gate_id: config.gate_id,
    target_host: bound.admissionConfig.target.host,
    target_computer: bound.admissionConfig.target.computer_name,
    gate_root: "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id,
    backing_root: "D:\\synthia-m4f-toolchain-" + config.gate_id,
    config_sha256: configSha256,
    service_identity_sid: config.service_identity_sid,
    minimum_gate_free_bytes: config.minimum_gate_free_bytes,
    minimum_backing_free_bytes: config.minimum_backing_free_bytes,
    admission_config_sha256: config.admission_config_sha256,
    admission_record_sha256: config.admission_record_sha256,
    admission_approval_sha256: config.admission_approval_sha256,
    confirmation: directGateRootsConfirmation(config),
    no_cleanup: true,
    network_attempted: false,
    remote_write_started: false,
  };
  return bound.admissionContract === "v1"
    ? plan
    : (() => {
      const executionTcb = bindExecutionTcb(
        config,
        bound,
        sha256(directGateRootsConfirmation(config)),
        dependencies,
      );
      const currentPlan = {
        ...plan,
        admission_contract: config.schema === "synthia-m4f-direct-gate-roots-config.v3" ? "v3" : "v2",
        admission_id: bound.admissionId,
        base_admission_config_sha256: bound.baseAdmissionConfigSha256,
        admission_config_canonical_sha256: bound.admissionConfigCanonicalSha256,
        gate_roots_source_sha256: executionTcb.sourceSha256,
        gate_roots_transport_source_sha256: executionTcb.transportSourceSha256,
        admission_v2_validator_source_sha256: executionTcb.admissionV2SourceSha256,
        gate_roots_wrapper_source_sha256: executionTcb.wrapperSourceSha256,
        effect_binding_sha256: executionTcb.effectBindingSha256,
        gate_roots_remote_script_sha256: executionTcb.remoteScriptSha256,
      };
      if (config.schema !== "synthia-m4f-direct-gate-roots-config.v3") return currentPlan;
      const rootsApproval = bindRootsApproval(config, bound, executionTcb);
      return {
        ...currentPlan,
        roots_review_config_sha256: rootsApproval.reviewConfigSha256,
        roots_approval_sha256: config.roots_approval_sha256,
        roots_approval_reviewer: rootsApproval.approval.reviewer,
        roots_approved_at_utc: rootsApproval.approval.approved_at_utc,
        execution_authorized: true,
      };
    })();
}

const systemDependencies: DirectGateRootsDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
      maxBuffer: MAX_BYTES,
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
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  admissionV2SourceBytes: () => readFileSync(new URL("./m4f-direct-admission-v2.ts", import.meta.url)),
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length === 3 && args[0] === "--plan" && args[1] === "--config") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(planDirectGateRoots(raw)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-create" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      const record = recordDirectGateRoots(raw, args[4]!, args[6]!);
      process.stdout.write(JSON.stringify(record) + "\n");
      return;
    }
    console.error("usage: bun connector/scripts/m4f-direct-gate-roots.ts --plan --config <config.json>");
    console.error("   or: bun connector/scripts/m4f-direct-gate-roots.ts --execute-create --config <config.json> --confirmation <exact> --evidence <new-directory>");
    process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof DirectGateRootsFailure
      ? error.detail
      : { schema: "synthia-m4f-direct-gate-roots-failure.v1", code: "M4F_DIRECT_GATE_ROOTS_UNEXPECTED", stage: "unknown", remote_write_state: "unknown", retry_permitted: false, cleanup_permitted: false };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
