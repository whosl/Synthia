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
import { basename, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  auditDirectSshEffectiveConfig,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  type LocalInputFact,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
  validateM4fDirectAdmissionConfig,
} from "./m4f-gate-admission-transport.ts";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const TIMEOUT_MS = 45_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const WINDOWS_COMMAND_LIMIT = 8191;
const REMOTE_COMMAND_LIMIT = 7800;
const SPAWN_LAG_MS = 15_000;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u;
const CIM_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}0Z$/u;
const DOTNET_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/u;
const WINDOWS_CIM_TICKS_PER_MICROSECOND = 10;
const DOTNET_MAX_TICKS = 3_155_378_975_999_999_999n;
const TARGET_NAMES = ["powershell.exe", "conhost.exe"] as const;
const EXPECTED_TARGET_COUNT = 16;
const PERMANENTLY_RETIRED_CEREMONY_IDS = [
  "m4f-direct-residue-cleanup-prod-20260828-01",
  "m4f-direct-residue-cleanup-prod-20260828-02",
] as const;
const PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS = [
  "m4f-direct-handle-start-prod-20260828-01",
] as const;
const FOLLOWUP_PHASES = [
  "start",
  "env-identity",
  "processes-native",
  "cim-system-snapshot",
  "openssh-events",
  "whoami-user",
  "windows-identity",
  "complete",
] as const;
const STAGED_STAGE_IDS = [
  "wrapper-smoke",
  "identity",
  "volumes",
  "acl-01",
  "acl-02",
  "acl-03",
  "listeners",
  "processes",
  "vivado-fact",
  "bun-fact",
] as const;
const TIMED_OUT_STAGE_IDS = [
  "identity",
  "volumes",
  "acl-01",
  "acl-02",
  "acl-03",
  "listeners",
  "vivado-fact",
  "bun-fact",
] as const;

type JsonObject = Record<string, unknown>;

export interface M4fDirectResidueCleanupConfigV1 {
  schema: "synthia-m4f-direct-residue-cleanup-config.v1";
  ceremony_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  residue_record_path: string;
  residue_record_sha256: string;
  staged_record_path: string;
  staged_record_sha256: string;
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface M4fDirectResidueCleanupConfigV2 {
  schema: "synthia-m4f-direct-residue-cleanup-config.v2";
  ceremony_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  residue_record_path: string;
  residue_record_sha256: string;
  staged_record_path: string;
  staged_record_sha256: string;
  handle_start_diagnostic_record_path: string;
  handle_start_diagnostic_record_sha256: string;
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export type M4fDirectResidueCleanupConfig =
  | M4fDirectResidueCleanupConfigV1
  | M4fDirectResidueCleanupConfigV2;

export interface M4fDirectHandleStartDiagnosticConfig {
  schema: "synthia-m4f-direct-handle-start-diagnostic-config.v1";
  diagnostic_id: string;
  cleanup_plan_path: string;
  cleanup_plan_sha256: string;
  admission_config_path: string;
  admission_config_sha256: string;
  consumed_evidence_root: string;
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface BoundFileFact {
  path: string;
  device: number;
  inode: number;
  owner_uid: number;
  mode: 384;
  link_count: 1;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  sha256: string;
}

export interface CleanupTarget {
  ordinal: number;
  stage_id: string;
  stage_started_at_utc: string;
  stage_script_sha256: string;
  pid: number;
  parent_pid: number;
  peer_pid: number;
  name: typeof TARGET_NAMES[number];
  creation_utc: string;
  command_sha256: string;
  process_class: "session";
  start_token_sha256: string;
}

export interface ProtectedProcess {
  pid: number;
  name: string;
  creation_utc: string | null;
  reason: string;
}

export interface ResidueCleanupPlanV1 {
  schema: "synthia-m4f-direct-residue-cleanup-plan.v1";
  status: "planned_not_executed";
  ceremony_id: string;
  target_host: string;
  target_user: string;
  target_computer: string;
  target_identity_name: string;
  target_identity_sid: string;
  source_sha256: string;
  transport_source_sha256: string;
  effective_config_sha256: string;
  residue_record_sha256: string;
  staged_record_sha256: string;
  target_count: 16;
  targets: CleanupTarget[];
  protected_processes: ProtectedProcess[];
  effect: {
    operation: "terminate_exact_handles_or_accept_preflight_bound_conhost_exit";
    ordering: readonly ["powershell.exe", "conhost.exe"];
    process_api: "System.Diagnostics.Process_handle_bound_Kill";
    allowed_target_effects: {
      "powershell.exe": readonly ["terminated_exact_handle"];
      "conhost.exe": readonly ["terminated_exact_handle", "exited_after_preflight"];
    };
    all_targets_must_match_before_first_effect: true;
    revalidate_start_token_immediately_before_each_effect: true;
    stop_after_first_effect_failure: true;
    maximum_remote_attempts: 1;
    timeout_ms: 45000;
    service_mutation_permitted: false;
    file_mutation_permitted: false;
    vivado_permitted: false;
    hardware_action_permitted: false;
  };
  recovery: {
    resumable: false;
    automatic_restart_permitted: false;
    statement: string;
  };
  plan_sha256: string;
  confirmation: string;
  network_attempted: false;
  process_termination_performed: false;
  hardware_action_performed: false;
}

export interface HandleStartCleanupBinding {
  record_path: string;
  record_sha256: string;
  record_file_fact: BoundFileFact;
  diagnostic_id: string;
  diagnostic_plan_sha256: string;
  diagnostic_cleanup_plan_sha256: string;
  cleanup_semantic_sha256: string;
  target_core_sha256: string;
  identity: {
    computer: string;
    name: string;
    sid: string;
  };
  transport_inputs_sha256: string;
  bound_inputs_sha256: string;
  ordinal_one: {
    pid: number;
    cim_utc_ticks: string;
    handle_utc_ticks: string;
    tick_delta: string;
    normalized_cim_utc_ticks: string;
    normalized_handle_utc_ticks: string;
    floor_10_ticks_equal: true;
  };
  pid_13644_exists: true;
  process_termination_performed: false;
  file_mutation_performed: false;
  vivado_action_performed: false;
  hardware_action_performed: false;
}

export interface ResidueCleanupPlanV2 extends Omit<ResidueCleanupPlanV1, "schema"> {
  schema: "synthia-m4f-direct-residue-cleanup-plan.v2";
  handle_start_diagnostic: HandleStartCleanupBinding;
}

export type ResidueCleanupPlan = ResidueCleanupPlanV1 | ResidueCleanupPlanV2;

type PlanCoreV1 = Omit<ResidueCleanupPlanV1, "plan_sha256" | "confirmation">;
type PlanCoreV2 = Omit<ResidueCleanupPlanV2, "plan_sha256" | "confirmation">;

export interface HandleStartDiagnosticPlan {
  schema: "synthia-m4f-direct-handle-start-diagnostic-plan.v1";
  status: "planned_not_executed";
  diagnostic_id: string;
  cleanup_ceremony_id: string;
  cleanup_plan_sha256: string;
  cleanup_plan_file_sha256: string;
  admission_config_sha256: string;
  consumed_evidence_root: string;
  consumed_evidence_root_device: number;
  consumed_evidence_root_inode: number;
  target_host: string;
  target_user: string;
  target_computer: string;
  target_identity_name: string;
  target_identity_sid: string;
  source_sha256: string;
  transport_source_sha256: string;
  effective_config_sha256: string;
  target_count: 16;
  targets: CleanupTarget[];
  effect: {
    operation: "observe_handle_start_ticks_read_only";
    ordinal_one_only_handle_open: true;
    maximum_remote_attempts: 1;
    timeout_ms: 45000;
    process_termination_permitted: false;
    service_mutation_permitted: false;
    file_mutation_permitted: false;
    vivado_permitted: false;
    hardware_action_permitted: false;
  };
  plan_sha256: string;
  confirmation: string;
  network_attempted: false;
  process_termination_performed: false;
  hardware_action_performed: false;
}

interface HandleStartDiagnosticPlanCore extends Omit<
  HandleStartDiagnosticPlan,
  "plan_sha256" | "confirmation"
> {}

export interface HandleStartDiagnosticRecord {
  schema: "synthia-m4f-direct-handle-start-diagnostic-record.v1";
  diagnostic_id: string;
  status: "observed" | "unknown";
  action: "observe_handle_start_ticks_read_only";
  plan_sha256: string;
  cleanup_plan_sha256: string;
  confirmation_sha256: string;
  attempt: 1;
  timeout_ms: 45000;
  recorded_at_utc: string;
  elapsed_ms: number;
  observation: JsonObject | null;
  process: CleanupProcessEvidence;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  bound_files_before: BoundFileFact[];
  bound_files_after: BoundFileFact[];
  process_termination_performed: false;
  file_mutation_performed: false;
  vivado_action_performed: false;
  hardware_action_performed: false;
  retry_permitted: false;
}

export interface CleanupDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  now(): Date;
  monotonicMs(): number;
}

export interface CleanupProcessEvidence {
  exit_status: number | null;
  signal: string | null;
  error_code: string | null;
  timed_out: boolean;
  outcome_ambiguous: boolean;
  stdout_length: number;
  stdout_sha256: string;
  stderr_length: number;
  stderr_sha256: string;
  retry_permitted: false;
}

export interface CleanupMarker {
  phase: "start" | "pre-identity" | "preflight" | "target" | "postflight" | "post-identity" | "complete";
  status: "observed" | "unknown";
  observed_at_utc: string;
  payload: JsonObject;
}

export interface ResidueCleanupRecord {
  schema: "synthia-m4f-direct-residue-cleanup-record.v1";
  ceremony_id: string;
  status: "completed" | "unknown";
  action: "resolve_exact_diagnostic_residue";
  plan_sha256: string;
  confirmation_sha256: string;
  attempt: 1;
  timeout_ms: 45000;
  recorded_at_utc: string;
  elapsed_ms: number;
  markers: CleanupMarker[];
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
  stdout_truncated_line: boolean;
  process: CleanupProcessEvidence;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  bound_files_before: BoundFileFact[];
  bound_files_after: BoundFileFact[];
  process_termination_state: "performed" | "not_performed" | "unknown";
  kill_performed_pids: number[];
  already_exited_pids: number[];
  resolved_target_pids: number[];
  hardware_action_performed: false;
  retry_permitted: false;
}

export interface CleanupMarkerPrefix {
  markers: CleanupMarker[] | null;
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
  stdout_truncated_line: boolean;
}

export interface CleanupEffectClassification {
  attribution_valid: boolean;
  explicit_no_effect: boolean;
  kill_performed_pids: number[];
  already_exited_pids: number[];
  resolved_target_pids: number[];
}

export class ResidueCleanupFailure extends Error {
  constructor(readonly detail: JsonObject) {
    super(String(detail.code ?? "M4F_DIRECT_RESIDUE_CLEANUP_FAILED"));
  }
}

export class HandleStartDiagnosticFailure extends Error {
  constructor(readonly detail: JsonObject) {
    super(String(detail.code ?? "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_FAILED"));
  }
}

const CONFIG_KEYS = [
  "admission_config_path",
  "admission_config_sha256",
  "ceremony_id",
  "expected_effective_config_sha256",
  "expected_source_sha256",
  "expected_transport_source_sha256",
  "residue_record_path",
  "residue_record_sha256",
  "schema",
  "staged_record_path",
  "staged_record_sha256",
] as const;

const CONFIG_V2_KEYS = [
  "admission_config_path",
  "admission_config_sha256",
  "ceremony_id",
  "expected_effective_config_sha256",
  "expected_source_sha256",
  "expected_transport_source_sha256",
  "handle_start_diagnostic_record_path",
  "handle_start_diagnostic_record_sha256",
  "residue_record_path",
  "residue_record_sha256",
  "schema",
  "staged_record_path",
  "staged_record_sha256",
] as const;

const HANDLE_START_DIAGNOSTIC_CONFIG_KEYS = [
  "admission_config_path",
  "admission_config_sha256",
  "cleanup_plan_path",
  "cleanup_plan_sha256",
  "consumed_evidence_root",
  "diagnostic_id",
  "expected_effective_config_sha256",
  "expected_source_sha256",
  "expected_transport_source_sha256",
  "schema",
] as const;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function cimUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && CIM_UTC_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

export function normalizeWindowsUtcTicksToCimPrecision(utcTicks: bigint): bigint {
  if (utcTicks < 0n || utcTicks > DOTNET_MAX_TICKS) {
    throw new RangeError("UTC ticks are outside the System.DateTime range");
  }
  const quantum = BigInt(WINDOWS_CIM_TICKS_PER_MICROSECOND);
  return utcTicks - (utcTicks % quantum);
}

export function parseDotNetUtcIsoToTicks(value: string): bigint {
  const match = DOTNET_UTC_TIMESTAMP.exec(value);
  if (!match) throw new RangeError("invalid System.DateTime UTC round-trip timestamp");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = Number(match[7]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12
    || day < 1 || day > monthDays[month - 1]!
    || hour < 0 || hour > 23 || minute < 0 || minute > 59
    || second < 0 || second > 59 || fraction < 0 || fraction > 9_999_999) {
    throw new RangeError("timestamp is outside the System.DateTime range");
  }
  const priorYear = year - 1;
  const daysBeforeYear = 365 * priorYear + Math.floor(priorYear / 4)
    - Math.floor(priorYear / 100) + Math.floor(priorYear / 400);
  const daysBeforeMonth = monthDays.slice(0, month - 1)
    .reduce((total, days) => total + days, 0);
  const days = BigInt(daysBeforeYear + daysBeforeMonth + day - 1);
  const seconds = ((days * 24n + BigInt(hour)) * 60n + BigInt(minute)) * 60n
    + BigInt(second);
  const ticks = seconds * 10_000_000n + BigInt(fraction);
  if (ticks < 0n || ticks > DOTNET_MAX_TICKS) {
    throw new RangeError("timestamp is outside the System.DateTime range");
  }
  return ticks;
}

function safeLocalPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

function captureConsumedEvidenceRoot(path: string): { device: number; inode: number } {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o700 || stat.nlink < 1) {
      diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CONSUMED_ROOT_UNTRUSTED", "local_preflight", {
        path,
      });
    }
    return { device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (error instanceof HandleStartDiagnosticFailure) throw error;
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CONSUMED_ROOT_UNAVAILABLE", "local_preflight", {
      path,
    });
  }
}

function assertHandleStartDiagnosticIdUnconsumed(
  config: M4fDirectHandleStartDiagnosticConfig,
): void {
  const consumedPath = resolve(config.consumed_evidence_root, config.diagnostic_id);
  try {
    lstatSync(consumedPath);
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_ID_CONSUMED", "local_preflight", {
      diagnostic_id: config.diagnostic_id,
      consumed_evidence_path: consumedPath,
    });
  } catch (error) {
    if (error instanceof HandleStartDiagnosticFailure) throw error;
    if (error !== null && typeof error === "object" && "code" in error
      && error.code === "ENOENT") return;
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CONSUMPTION_STATE_UNKNOWN", "local_preflight", {
      diagnostic_id: config.diagnostic_id,
    });
  }
}

function fail(code: string, stage: string, extra: JsonObject = {}): never {
  throw new ResidueCleanupFailure({
    schema: "synthia-m4f-direct-residue-cleanup-failure.v1",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight"
      ? "not_started"
      : "unknown",
    retry_permitted: false,
    ...extra,
  });
}

function diagnosticFail(code: string, stage: string, extra: JsonObject = {}): never {
  throw new HandleStartDiagnosticFailure({
    schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight"
      ? "not_started"
      : "unknown",
    retry_permitted: false,
    ...extra,
  });
}

function assertCeremonyIdNotRetired(ceremonyId: string, stage: "config" | "local_preflight"): void {
  if (PERMANENTLY_RETIRED_CEREMONY_IDS.some((retiredId) => retiredId === ceremonyId)) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_CEREMONY_ID_RETIRED", stage, {
      ceremony_id: ceremonyId,
      retirement_reason: "consumed_attempt_with_unknown_result",
    });
  }
}

export function validateResidueCleanupConfig(value: unknown): M4fDirectResidueCleanupConfig {
  const config = object(value);
  const v1 = config?.schema === "synthia-m4f-direct-residue-cleanup-config.v1"
    && exactKeys(config, CONFIG_KEYS);
  const v2 = config?.schema === "synthia-m4f-direct-residue-cleanup-config.v2"
    && exactKeys(config, CONFIG_V2_KEYS);
  if (!config || (!v1 && !v2)
    || typeof config.ceremony_id !== "string" || !SAFE_ID.test(config.ceremony_id)
    || !safeLocalPath(config.admission_config_path)
    || !safeLocalPath(config.residue_record_path)
    || !safeLocalPath(config.staged_record_path)
    || (v2 && (!safeLocalPath(config.handle_start_diagnostic_record_path)
      || typeof config.handle_start_diagnostic_record_sha256 !== "string"
      || !HASH.test(config.handle_start_diagnostic_record_sha256)))
    || ![config.admission_config_sha256, config.residue_record_sha256,
      config.staged_record_sha256, config.expected_source_sha256,
      config.expected_transport_source_sha256, config.expected_effective_config_sha256]
      .every((digest) => typeof digest === "string" && HASH.test(digest))) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_CONFIG_INVALID", "config");
  }
  assertCeremonyIdNotRetired(config.ceremony_id as string, "config");
  return value as M4fDirectResidueCleanupConfig;
}

export function validateHandleStartDiagnosticConfig(
  value: unknown,
): M4fDirectHandleStartDiagnosticConfig {
  const config = object(value);
  if (!config || !exactKeys(config, HANDLE_START_DIAGNOSTIC_CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-handle-start-diagnostic-config.v1"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !safeLocalPath(config.cleanup_plan_path) || !safeLocalPath(config.admission_config_path)
    || !safeLocalPath(config.consumed_evidence_root)
    || ![config.cleanup_plan_sha256, config.admission_config_sha256,
      config.expected_source_sha256, config.expected_transport_source_sha256,
      config.expected_effective_config_sha256]
      .every((digest) => typeof digest === "string" && HASH.test(digest))) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CONFIG_INVALID", "config");
  }
  if (PERMANENTLY_RETIRED_CEREMONY_IDS.includes(
    config.diagnostic_id as typeof PERMANENTLY_RETIRED_CEREMONY_IDS[number],
  ) || PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS.includes(
    config.diagnostic_id as typeof PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS[number],
  )) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_ID_RESERVED", "config", {
      diagnostic_id: config.diagnostic_id,
      reason: PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS.includes(
        config.diagnostic_id as typeof PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS[number],
      ) ? "permanently_retired_diagnostic_id" : "permanently_retired_cleanup_id",
    });
  }
  return value as M4fDirectHandleStartDiagnosticConfig;
}

function readBoundFile(path: string, expectedSha256: string): { bytes: Buffer; fact: BoundFileFact } {
  let fd: number | null = null;
  let stat;
  let bytes: Buffer;
  try {
    const pathBefore = lstatSync(path);
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (pathBefore.isSymbolicLink()
      || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_BOUND_FILE_DRIFT", "local_preflight", { path });
    }
    stat = after;
  } catch (error) {
    if (error instanceof ResidueCleanupFailure) throw error;
    fail("M4F_DIRECT_RESIDUE_CLEANUP_BOUND_FILE_UNAVAILABLE", "local_preflight", { path });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const digest = sha256(bytes);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || bytes.length < 1 || bytes.length > MAX_STREAM_BYTES || digest !== expectedSha256) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_BOUND_FILE_UNTRUSTED", "local_preflight", { path });
  }
  return {
    bytes,
    fact: {
      path,
      device: stat.dev,
      inode: stat.ino,
      owner_uid: stat.uid,
      mode: 0o600,
      link_count: 1,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      sha256: digest,
    },
  };
}

function parseBoundJson(bound: { bytes: Buffer; fact: BoundFileFact }, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bound.bytes));
  } catch {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_BOUND_JSON_INVALID", "local_preflight", { label });
  }
}

function processStartToken(process: {
  pid: number;
  parent_pid: number;
  name: string;
  creation_utc: string;
  command_sha256: string;
  process_class: string;
}): string {
  return sha256([
    process.pid,
    process.parent_pid,
    process.name,
    process.creation_utc,
    process.command_sha256,
    process.process_class,
  ].join("|"));
}

function validateFrozenCleanupPlan(value: unknown): ResidueCleanupPlanV1 {
  const plan = object(value);
  const targets = Array.isArray(plan?.targets) ? plan.targets.map(object) : [];
  const protectedProcesses = Array.isArray(plan?.protected_processes)
    ? plan.protected_processes.map(object)
    : [];
  const topKeys = [
    "ceremony_id", "confirmation", "effective_config_sha256", "effect",
    "hardware_action_performed", "network_attempted", "plan_sha256",
    "process_termination_performed", "protected_processes", "recovery",
    "residue_record_sha256", "schema", "source_sha256", "staged_record_sha256",
    "status", "target_computer", "target_count", "target_host", "target_identity_name",
    "target_identity_sid", "target_user", "targets", "transport_source_sha256",
  ];
  if (!plan || !exactKeys(plan, topKeys)
    || plan.schema !== "synthia-m4f-direct-residue-cleanup-plan.v1"
    || plan.status !== "planned_not_executed"
    || typeof plan.ceremony_id !== "string" || !SAFE_ID.test(plan.ceremony_id)
    || plan.target_host !== TARGET_HOST || typeof plan.target_user !== "string"
    || typeof plan.target_computer !== "string" || typeof plan.target_identity_name !== "string"
    || typeof plan.target_identity_sid !== "string" || plan.target_count !== EXPECTED_TARGET_COUNT
    || targets.length !== EXPECTED_TARGET_COUNT || targets.some((target) => !target)
    || ![plan.source_sha256, plan.transport_source_sha256, plan.effective_config_sha256,
      plan.residue_record_sha256, plan.staged_record_sha256, plan.plan_sha256]
      .every((digest) => typeof digest === "string" && HASH.test(digest))
    || typeof plan.confirmation !== "string" || plan.network_attempted !== false
    || plan.process_termination_performed !== false || plan.hardware_action_performed !== false
    || !protectedProcesses.some((process) => process?.pid === 13644)) {
    fail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CLEANUP_PLAN_INVALID", "local_preflight");
  }
  const usedPids = new Set<number>();
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    const expectedName = index < EXPECTED_TARGET_COUNT / 2 ? "powershell.exe" : "conhost.exe";
    if (!exactKeys(target, [
      "command_sha256", "creation_utc", "name", "ordinal", "parent_pid", "peer_pid",
      "pid", "process_class", "stage_id", "stage_script_sha256", "stage_started_at_utc",
      "start_token_sha256",
    ]) || target.ordinal !== index + 1 || !safeInteger(target.pid, 1)
      || usedPids.has(target.pid) || !safeInteger(target.parent_pid) || !safeInteger(target.peer_pid, 1)
      || target.name !== expectedName || !cimUtcTimestamp(target.creation_utc)
      || typeof target.command_sha256 !== "string" || !HASH.test(target.command_sha256)
      || target.process_class !== "session" || typeof target.stage_id !== "string"
      || !utcTimestamp(target.stage_started_at_utc)
      || typeof target.stage_script_sha256 !== "string" || !HASH.test(target.stage_script_sha256)
      || typeof target.start_token_sha256 !== "string"
      || target.start_token_sha256 !== processStartToken(target as unknown as CleanupTarget)) {
      fail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_TARGET_INVALID", "local_preflight", {
        ordinal: index + 1,
      });
    }
    usedPids.add(target.pid as number);
  }
  for (const target of targets) {
    const peer = targets.find((candidate) => candidate?.pid === target!.peer_pid);
    if (!peer || peer.parent_pid !== target!.parent_pid || peer.peer_pid !== target!.pid
      || peer.name === target!.name) {
      fail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_PEER_INVALID", "local_preflight");
    }
  }
  const core = { ...plan };
  delete core.plan_sha256;
  delete core.confirmation;
  if (sha256(Buffer.from(canonicalJson(core) + "\n", "utf8")) !== plan.plan_sha256
    || plan.confirmation !== cleanupConfirmation(
      plan.ceremony_id as string,
      plan.plan_sha256 as string,
      EXPECTED_TARGET_COUNT,
    )) {
    fail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CLEANUP_PLAN_BINDING_INVALID", "local_preflight");
  }
  return value as ResidueCleanupPlanV1;
}

function validResidueProcessList(value: unknown): value is JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 512) return false;
  const pids = new Set<number>();
  for (const raw of value) {
    const fact = object(raw);
    if (!fact || !exactKeys(fact, ["class", "command_sha256", "created", "name", "parent_pid", "pid"])
      || !safeInteger(fact.pid, 1) || pids.has(fact.pid)
      || !safeInteger(fact.parent_pid) || typeof fact.name !== "string"
      || !["sshd.exe", "powershell.exe", "conhost.exe"].includes(fact.name)
      || (fact.created !== null && !utcTimestamp(fact.created))
      || (fact.command_sha256 !== null
        && (typeof fact.command_sha256 !== "string" || !HASH.test(fact.command_sha256)))
      || (fact.class !== "session" && fact.class !== "sshd" && fact.class !== "current")) {
      return false;
    }
    pids.add(fact.pid);
  }
  return true;
}

function requireProcessFacts(
  residueRecord: unknown,
  admission: M4fDirectAdmissionConfig,
): {
  currentPid: number;
  processes: JsonObject[];
} {
  const record = object(residueRecord);
  const process = object(record?.process);
  if (!record || record.schema !== "synthia-m4f-direct-identity-residue-followup-record.v2"
    || record.status !== "observed" || record.hardware_action_performed !== false
    || record.process_termination_performed !== false || record.marker_count !== 8
    || record.last_marker_phase !== "complete" || record.trailing_fragment_length !== 0
    || record.trailing_fragment_sha256 !== sha256(Buffer.alloc(0))
    || record.stdout_truncated_line !== false || record.attempt !== 1
    || record.retry_permitted !== false || !Array.isArray(record.markers)
    || record.markers.length !== FOLLOWUP_PHASES.length || !process
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.outcome_ambiguous !== false
    || !safeInteger(process.stdout_length, 1)
    || typeof process.stdout_sha256 !== "string" || !HASH.test(process.stdout_sha256)
    || process.stderr_length !== 0
    || typeof process.stderr_sha256 !== "string" || !HASH.test(process.stderr_sha256)
    || process.retry_permitted !== false) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_RESIDUE_RECORD_NOT_OBSERVED", "local_preflight");
  }
  for (let index = 0; index < FOLLOWUP_PHASES.length; index += 1) {
    const marker = object(record.markers[index]);
    if (!marker || !exactKeys(marker, ["error", "observed_at_utc", "ordinal", "payload", "phase", "status"])
      || marker.ordinal !== index + 1 || marker.phase !== FOLLOWUP_PHASES[index]
      || marker.status !== "observed" || marker.error !== null
      || !utcTimestamp(marker.observed_at_utc) || !object(marker.payload)) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_RESIDUE_MARKERS_INVALID", "local_preflight");
    }
  }
  const cimPayload = object(object(record.markers[3])?.payload);
  const resource = object(cimPayload?.resource);
  const service = object(cimPayload?.sshd_service);
  if (!cimPayload || !exactKeys(cimPayload, ["current_pid", "processes", "resource", "sshd_service"])
    || !safeInteger(cimPayload.current_pid, 1) || !validResidueProcessList(cimPayload.processes)
    || !resource || !exactKeys(resource, ["free_kib", "process_count", "total_kib"])
    || !safeInteger(resource.free_kib) || !safeInteger(resource.total_kib, 1)
    || resource.free_kib > resource.total_kib || !safeInteger(resource.process_count, 1)
    || !service || !exactKeys(service, ["exists", "start_type", "status"])
    || typeof service.exists !== "boolean"
    || (service.exists
      ? typeof service.status !== "string" || service.status.length < 1
        || typeof service.start_type !== "string" || service.start_type.length < 1
      : service.status !== null || service.start_type !== null)) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_RESIDUE_PROCESS_SNAPSHOT_INVALID", "local_preflight");
  }
  const processes = cimPayload.processes;
  if (!processes.some((fact) => fact.pid === cimPayload.current_pid
    && fact.class === "current" && fact.name === "powershell.exe")) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_RESIDUE_CURRENT_PROCESS_MISSING", "local_preflight");
  }
  const whoami = object(object(record.markers[5])?.payload);
  const windowsIdentity = object(object(record.markers[6])?.payload);
  const complete = object(object(record.markers[7])?.payload);
  if (!whoami || !exactKeys(whoami, ["exit_status", "identity_name", "identity_sid"])
    || whoami.exit_status !== 0 || whoami.identity_name !== admission.target.identity_name
    || whoami.identity_sid !== admission.target.identity_sid
    || !windowsIdentity || !exactKeys(windowsIdentity, ["identity_name", "identity_sid"])
    || windowsIdentity.identity_name !== admission.target.identity_name
    || windowsIdentity.identity_sid !== admission.target.identity_sid
    || !complete || !exactKeys(complete, ["complete"]) || complete.complete !== true) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_RESIDUE_IDENTITY_INVALID", "local_preflight");
  }
  return { currentPid: cimPayload.current_pid, processes };
}

function requireTimedOutStages(stagedRecord: unknown): JsonObject[] {
  const record = object(stagedRecord);
  if (!record || record.schema !== "synthia-m4f-direct-staged-diagnostic-record.v1"
    || record.status !== "completed_with_unknown" || record.hardware_action_performed !== false
    || record.planned_stage_count !== 10 || record.attempted_stage_count !== 10
    || record.observed_stage_count !== 2
    || record.unknown_stage_count !== 8 || !Array.isArray(record.stage_records)
    || record.stage_records.length !== 10) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_STAGED_RECORD_INVALID", "local_preflight");
  }
  const stages: JsonObject[] = [];
  for (let index = 0; index < STAGED_STAGE_IDS.length; index += 1) {
    const stage = object(record.stage_records[index]);
    const stageId = STAGED_STAGE_IDS[index]!;
    const shouldTimeOut = TIMED_OUT_STAGE_IDS.includes(stageId as typeof TIMED_OUT_STAGE_IDS[number]);
    if (!stage || stage.stage_id !== stageId || stage.ordinal !== index + 1
      || stage.attempt !== 1 || stage.retry_permitted !== false
      || !utcTimestamp(stage.started_at_utc) || !utcTimestamp(stage.finished_at_utc)
      || typeof stage.script_sha256 !== "string" || !HASH.test(stage.script_sha256)
      || (shouldTimeOut
        ? stage.status !== "unknown" || stage.output_valid !== false
        : stage.status !== "observed" || stage.output_valid !== true)) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_STAGE_SET_INVALID", "local_preflight", { stage_id: stageId });
    }
    if (!shouldTimeOut) continue;
    const process = object(stage.process);
    if (!process || process.timed_out !== true || process.outcome_ambiguous !== true
      || process.error_code !== "ETIMEDOUT" || process.signal !== "SIGKILL"
      || process.stdout_length !== 0 || process.stderr_length !== 0
      || process.retry_permitted !== false) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_TIMEOUT_STAGE_INVALID", "local_preflight", {
        stage_id: stage.stage_id,
      });
    }
    stages.push(stage);
  }
  return stages;
}

function protectedProcesses(processes: JsonObject[], currentPid: number, stagedRecord: unknown): ProtectedProcess[] {
  const protectedFacts: ProtectedProcess[] = processes
    .filter((fact) => fact.class === "sshd" || fact.pid === currentPid)
    .map((fact) => ({
      pid: fact.pid as number,
      name: fact.name as string,
      creation_utc: fact.created as string | null,
      reason: fact.pid === currentPid
        ? "prod04-observer-process"
        : fact.parent_pid === 1448
          ? "normal-openssh-service-root"
          : "sshd-not-proven-to-belong-to-staged-timeouts",
    }));
  const staged = object(stagedRecord);
  const stageRecords = Array.isArray(staged?.stage_records) ? staged.stage_records : [];
  const processStage = stageRecords.find((raw) => object(raw)?.stage_id === "processes");
  const outputPath = object(processStage)?.stage_id === "processes" ? "08-processes/stdout.raw" : null;
  protectedFacts.push({
    pid: 13644,
    name: "node.exe",
    creation_utc: "2026-08-14T08:02:31.2903580Z",
    reason: outputPath
      ? "old-port-8443-worker-explicitly-out-of-scope"
      : "protected-node-explicitly-out-of-scope",
  });
  return protectedFacts.sort((left, right) => left.pid - right.pid);
}

export function deriveResidueCleanupPlan(
  config: M4fDirectResidueCleanupConfig,
  admission: M4fDirectAdmissionConfig,
  residueRecord: unknown,
  stagedRecord: unknown,
): ResidueCleanupPlanV1 {
  assertCeremonyIdNotRetired(config.ceremony_id, "local_preflight");
  if (admission.target.host !== TARGET_HOST) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_TARGET_HOST_MISMATCH", "local_preflight");
  }
  const { currentPid, processes } = requireProcessFacts(residueRecord, admission);
  const stages = requireTimedOutStages(stagedRecord);
  const targets: CleanupTarget[] = [];
  const usedPids = new Set<number>();
  for (const stage of stages) {
    const startedMs = Date.parse(stage.started_at_utc as string);
    const candidates = processes.filter((fact) => {
      if (fact.class !== "session" || !TARGET_NAMES.includes(fact.name as typeof TARGET_NAMES[number])
        || !cimUtcTimestamp(fact.created) || typeof fact.command_sha256 !== "string") return false;
      const createdMs = Date.parse(fact.created);
      return createdMs >= startedMs && createdMs <= startedMs + SPAWN_LAG_MS;
    });
    if (candidates.length !== 2
      || candidates.filter((fact) => fact.name === "powershell.exe").length !== 1
      || candidates.filter((fact) => fact.name === "conhost.exe").length !== 1
      || candidates[0]!.parent_pid !== candidates[1]!.parent_pid
      || candidates.some((fact) => usedPids.has(fact.pid as number))) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_STAGE_TARGET_AMBIGUOUS", "local_preflight", {
        stage_id: stage.stage_id,
        candidate_count: candidates.length,
      });
    }
    for (const fact of candidates.sort((left, right) => String(right.name).localeCompare(String(left.name)))) {
      const peer = candidates.find((candidate) => candidate.pid !== fact.pid)!;
      const base = {
        pid: fact.pid as number,
        parent_pid: fact.parent_pid as number,
        name: fact.name as typeof TARGET_NAMES[number],
        creation_utc: fact.created as string,
        command_sha256: fact.command_sha256 as string,
        process_class: "session" as const,
      };
      usedPids.add(base.pid);
      targets.push({
        ordinal: 0,
        stage_id: stage.stage_id as string,
        stage_started_at_utc: stage.started_at_utc as string,
        stage_script_sha256: stage.script_sha256 as string,
        ...base,
        peer_pid: peer.pid as number,
        start_token_sha256: processStartToken(base),
      });
    }
  }
  targets.sort((left, right) => {
    const order = TARGET_NAMES.indexOf(left.name) - TARGET_NAMES.indexOf(right.name);
    return order || left.creation_utc.localeCompare(right.creation_utc) || left.pid - right.pid;
  });
  targets.forEach((target, index) => {
    target.ordinal = index + 1;
  });
  const powerShellHashes = new Set(targets
    .filter((target) => target.name === "powershell.exe").map((target) => target.command_sha256));
  const conhostHashes = new Set(targets
    .filter((target) => target.name === "conhost.exe").map((target) => target.command_sha256));
  if (targets.length !== EXPECTED_TARGET_COUNT || powerShellHashes.size !== 1 || conhostHashes.size !== 1
    || targets.some((target) => target.pid === currentPid || target.pid === 13644)
    || targets.some((target) => processes.some((fact) => fact.pid === target.pid && fact.class === "sshd"))) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_EXACT_TARGET_SET_INVALID", "local_preflight");
  }
  const core: PlanCoreV1 = {
    schema: "synthia-m4f-direct-residue-cleanup-plan.v1",
    status: "planned_not_executed",
    ceremony_id: config.ceremony_id,
    target_host: admission.target.host,
    target_user: admission.target.user,
    target_computer: admission.target.computer_name,
    target_identity_name: admission.target.identity_name,
    target_identity_sid: admission.target.identity_sid,
    source_sha256: config.expected_source_sha256,
    transport_source_sha256: config.expected_transport_source_sha256,
    effective_config_sha256: config.expected_effective_config_sha256,
    residue_record_sha256: config.residue_record_sha256,
    staged_record_sha256: config.staged_record_sha256,
    target_count: EXPECTED_TARGET_COUNT,
    targets,
    protected_processes: protectedProcesses(processes, currentPid, stagedRecord),
    effect: {
      operation: "terminate_exact_handles_or_accept_preflight_bound_conhost_exit",
      ordering: ["powershell.exe", "conhost.exe"],
      process_api: "System.Diagnostics.Process_handle_bound_Kill",
      allowed_target_effects: {
        "powershell.exe": ["terminated_exact_handle"],
        "conhost.exe": ["terminated_exact_handle", "exited_after_preflight"],
      },
      all_targets_must_match_before_first_effect: true,
      revalidate_start_token_immediately_before_each_effect: true,
      stop_after_first_effect_failure: true,
      maximum_remote_attempts: 1,
      timeout_ms: TIMEOUT_MS,
      service_mutation_permitted: false,
      file_mutation_permitted: false,
      vivado_permitted: false,
      hardware_action_permitted: false,
    },
    recovery: {
      resumable: false,
      automatic_restart_permitted: false,
      statement: "Terminated processes cannot be resumed; recovery would require explicitly starting new sessions, which this ceremony forbids.",
    },
    network_attempted: false,
    process_termination_performed: false,
    hardware_action_performed: false,
  };
  const planSha256 = sha256(Buffer.from(canonicalJson(core) + "\n", "utf8"));
  return {
    ...core,
    plan_sha256: planSha256,
    confirmation: cleanupConfirmation(config.ceremony_id, planSha256, targets.length),
  };
}

function validLocalInputFact(value: unknown): value is LocalInputFact {
  const fact = object(value);
  return !!fact && exactKeys(fact, [
    "ctime_ms", "device", "inode", "label", "link_count", "mode", "mtime_ms",
    "owner_uid", "path", "schema", "sha256", "size",
  ]) && fact.schema === "synthia-m4f-direct-local-input.v1"
    && (fact.label === "identity_file" || fact.label === "known_hosts_file")
    && safeLocalPath(fact.path) && safeInteger(fact.device) && safeInteger(fact.inode)
    && safeInteger(fact.owner_uid) && safeInteger(fact.mode) && fact.link_count === 1
    && safeInteger(fact.size, 1) && typeof fact.mtime_ms === "number"
    && Number.isFinite(fact.mtime_ms) && typeof fact.ctime_ms === "number"
    && Number.isFinite(fact.ctime_ms) && typeof fact.sha256 === "string" && HASH.test(fact.sha256);
}

function validBoundFileFact(value: unknown): value is BoundFileFact {
  const fact = object(value);
  return !!fact && exactKeys(fact, [
    "ctime_ms", "device", "inode", "link_count", "mode", "mtime_ms", "owner_uid",
    "path", "sha256", "size",
  ]) && safeLocalPath(fact.path) && safeInteger(fact.device) && safeInteger(fact.inode)
    && safeInteger(fact.owner_uid) && fact.mode === 0o600 && fact.link_count === 1
    && safeInteger(fact.size, 1) && typeof fact.mtime_ms === "number"
    && Number.isFinite(fact.mtime_ms) && typeof fact.ctime_ms === "number"
    && Number.isFinite(fact.ctime_ms) && typeof fact.sha256 === "string" && HASH.test(fact.sha256);
}

function cleanupTargetCore(target: CleanupTarget): JsonObject {
  return {
    ordinal: target.ordinal,
    pid: target.pid,
    parent_pid: target.parent_pid,
    name: target.name,
    creation_utc: target.creation_utc,
    command_sha256: target.command_sha256,
    process_class: target.process_class,
  };
}

function cleanupTargetCoreSha256(targets: CleanupTarget[]): string {
  return sha256(Buffer.from(canonicalJson(targets.map(cleanupTargetCore)) + "\n", "utf8"));
}

function cleanupSemanticSha256(plan: ResidueCleanupPlanV1): string {
  return sha256(Buffer.from(canonicalJson({
    target_host: plan.target_host,
    target_user: plan.target_user,
    target_computer: plan.target_computer,
    target_identity_name: plan.target_identity_name,
    target_identity_sid: plan.target_identity_sid,
    target_count: plan.target_count,
    targets: plan.targets,
    protected_processes: plan.protected_processes,
    effect: plan.effect,
    recovery: plan.recovery,
  }) + "\n", "utf8"));
}

function validateHandleStartRecordBinding(
  config: M4fDirectResidueCleanupConfigV2,
  admission: M4fDirectAdmissionConfig,
  cleanupPlan: ResidueCleanupPlanV1,
  recordValue: unknown,
  recordFact: BoundFileFact,
): HandleStartCleanupBinding {
  const record = object(recordValue);
  const process = object(record?.process);
  const observation = object(record?.observation);
  const identity = object(observation?.identity);
  const ordinalOne = object(observation?.ordinal_one);
  const expected = object(observation?.ordinal_one_expected);
  const cim = object(ordinalOne?.cim);
  const handle = object(ordinalOne?.handle);
  const protection = object(observation?.protection);
  const worker = object(protection?.pid_13644);
  const sshd = Array.isArray(protection?.sshd) ? protection.sshd.map(object) : null;
  const targets = Array.isArray(observation?.targets) ? observation.targets.map(object) : [];
  const transportsBefore = Array.isArray(record?.transport_inputs_before)
    ? record.transport_inputs_before : [];
  const transportsAfter = Array.isArray(record?.transport_inputs_after)
    ? record.transport_inputs_after : [];
  const boundBefore = Array.isArray(record?.bound_files_before) ? record.bound_files_before : [];
  const boundAfter = Array.isArray(record?.bound_files_after) ? record.bound_files_after : [];
  if (!record || !exactKeys(record, [
    "action", "attempt", "bound_files_after", "bound_files_before", "cleanup_plan_sha256",
    "confirmation_sha256", "diagnostic_id", "elapsed_ms", "file_mutation_performed",
    "hardware_action_performed", "observation", "plan_sha256", "process",
    "process_termination_performed", "recorded_at_utc", "retry_permitted", "schema", "status",
    "timeout_ms", "transport_inputs_after", "transport_inputs_before", "vivado_action_performed",
  ]) || record.schema !== "synthia-m4f-direct-handle-start-diagnostic-record.v1"
    || record.status !== "observed" || record.action !== "observe_handle_start_ticks_read_only"
    || typeof record.diagnostic_id !== "string" || !SAFE_ID.test(record.diagnostic_id)
    || PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS.includes(
      record.diagnostic_id as typeof PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS[number]
    ) || typeof record.plan_sha256 !== "string" || !HASH.test(record.plan_sha256)
    || typeof record.cleanup_plan_sha256 !== "string" || !HASH.test(record.cleanup_plan_sha256)
    || typeof record.confirmation_sha256 !== "string" || !HASH.test(record.confirmation_sha256)
    || record.confirmation_sha256 !== sha256(handleStartDiagnosticConfirmation(
      record.diagnostic_id as string,
      record.plan_sha256 as string,
      EXPECTED_TARGET_COUNT,
    ))
    || record.attempt !== 1 || record.timeout_ms !== TIMEOUT_MS
    || !utcTimestamp(record.recorded_at_utc) || !safeInteger(record.elapsed_ms)
    || record.process_termination_performed !== false || record.file_mutation_performed !== false
    || record.vivado_action_performed !== false || record.hardware_action_performed !== false
    || record.retry_permitted !== false || !process || !exactKeys(process, [
      "error_code", "exit_status", "outcome_ambiguous", "retry_permitted", "signal",
      "stderr_length", "stderr_sha256", "stdout_length", "stdout_sha256", "timed_out",
    ]) || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.outcome_ambiguous !== false
    || !safeInteger(process.stdout_length, 1) || typeof process.stdout_sha256 !== "string"
    || !HASH.test(process.stdout_sha256) || process.stderr_length !== 0
    || process.stderr_sha256 !== sha256(Buffer.alloc(0)) || process.retry_permitted !== false) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_RECORD_NOT_OBSERVED", "local_preflight");
  }
  if (!observation || !exactKeys(observation, [
    "cleanup_plan_sha256", "current_pid", "diagnostic_id", "diagnostic_plan_sha256",
    "file_mutation_performed", "hardware_action_performed", "identity", "ordinal_one",
    "ordinal_one_expected", "process_termination_performed", "protection", "schema", "targets",
    "vivado_action_performed",
  ]) || observation.schema !== "synthia-m4f-direct-handle-start-observation.v1"
    || observation.diagnostic_id !== record.diagnostic_id
    || observation.diagnostic_plan_sha256 !== record.plan_sha256
    || observation.cleanup_plan_sha256 !== record.cleanup_plan_sha256
    || !safeInteger(observation.current_pid, 1) || cleanupPlan.targets.some(
      (target) => target.pid === observation.current_pid
    ) || observation.current_pid === 13644 || !identity || !exactKeys(identity, ["computer", "name", "sid"])
    || identity.computer !== admission.target.computer_name
    || identity.name !== admission.target.identity_name || identity.sid !== admission.target.identity_sid
    || observation.process_termination_performed !== false || observation.file_mutation_performed !== false
    || observation.vivado_action_performed !== false || observation.hardware_action_performed !== false
    || !protection || !exactKeys(protection, ["pid_13644", "sshd"]) || !worker
    || !exactKeys(worker, ["creation_utc", "exists", "name", "pid"])
    || worker.pid !== 13644 || worker.exists !== true || typeof worker.name !== "string"
    || (worker.creation_utc !== null && !utcTimestamp(worker.creation_utc)) || !sshd
    || sshd.some((row) => !row || !exactKeys(row, ["name", "parent_pid", "pid"])
      || row.name !== "sshd.exe" || !safeInteger(row.pid, 1) || !safeInteger(row.parent_pid))) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_OBSERVATION_INVALID", "local_preflight");
  }
  if (targets.length !== EXPECTED_TARGET_COUNT || targets.some((row, index) => {
    const target = cleanupPlan.targets[index]!;
    return !row || !exactKeys(row, [
      "command_sha256", "core_match", "creation_utc", "creation_utc_ticks", "exists",
      "expected_pid", "name", "ordinal", "parent_pid", "pid", "process_class",
    ]) || row.ordinal !== target.ordinal || row.expected_pid !== target.pid || row.exists !== true
      || row.pid !== target.pid || row.parent_pid !== target.parent_pid || row.name !== target.name
      || row.creation_utc !== target.creation_utc
      || parseDecimalTicks(row.creation_utc_ticks) !== parsedIsoTicks(target.creation_utc)
      || row.command_sha256 !== target.command_sha256 || row.process_class !== target.process_class
      || row.core_match !== true;
  })) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_TARGET_DRIFT", "local_preflight");
  }
  const first = cleanupPlan.targets[0]!;
  if (!expected || !exactKeys(expected, [
    "command_sha256", "creation_utc", "name", "ordinal", "parent_pid", "peer_pid", "pid",
    "start_token",
  ]) || expected.ordinal !== first.ordinal || expected.pid !== first.pid
    || expected.parent_pid !== first.parent_pid || expected.peer_pid !== first.peer_pid
    || expected.name !== first.name || expected.creation_utc !== first.creation_utc
    || expected.command_sha256 !== first.command_sha256 || expected.start_token !== first.start_token_sha256
    || !ordinalOne || !exactKeys(ordinalOne, ["cim", "handle"]) || !cim
    || canonicalJson(cim) !== canonicalJson(targets[0]) || !handle || !exactKeys(handle, [
      "available", "expected_cim_utc_ticks", "has_exited", "id", "normalized_cim_utc_ticks",
      "normalized_equal", "normalized_handle_utc_ticks", "start_time_utc", "start_time_utc_ticks",
      "tick_delta",
    ]) || handle.available !== true || handle.id !== first.pid || handle.has_exited !== false
    || handle.normalized_equal !== true) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_ORDINAL_ONE_INVALID", "local_preflight");
  }
  const expectedTicks = parsedIsoTicks(first.creation_utc);
  const handleIsoTicks = typeof handle.start_time_utc === "string"
    ? parsedIsoTicks(handle.start_time_utc) : null;
  const handleTicks = parseDecimalTicks(handle.start_time_utc_ticks);
  const reportedExpected = parseDecimalTicks(handle.expected_cim_utc_ticks);
  const delta = parseDecimalTicks(handle.tick_delta, true);
  const normalizedCim = parseDecimalTicks(handle.normalized_cim_utc_ticks);
  const normalizedHandle = parseDecimalTicks(handle.normalized_handle_utc_ticks);
  if (expectedTicks === null || handleIsoTicks === null || handleTicks === null
    || reportedExpected !== expectedTicks || handleIsoTicks !== handleTicks
    || delta !== handleTicks - expectedTicks || delta < -9n || delta > 9n
    || normalizedCim !== normalizeWindowsUtcTicksToCimPrecision(expectedTicks)
    || normalizedHandle !== normalizeWindowsUtcTicksToCimPrecision(handleTicks)
    || normalizedCim !== normalizedHandle) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_TIME_MISMATCH", "local_preflight");
  }
  if (transportsBefore.length !== 2 || transportsBefore.some((fact) => !validLocalInputFact(fact))
    || canonicalJson(transportsBefore) !== canonicalJson(transportsAfter)
    || canonicalJson(transportsBefore) !== canonicalJson(captureM4fDirectTransportInputs(admission))) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_TRANSPORT_DRIFT", "local_preflight");
  }
  if (boundBefore.length !== 2 || boundBefore.some((fact) => !validBoundFileFact(fact))
    || canonicalJson(boundBefore) !== canonicalJson(boundAfter)
    || new Set(boundBefore.map((fact) => object(fact)?.path)).size !== 2
    || !boundBefore.some((fact) => object(fact)?.path === config.admission_config_path
      && object(fact)?.sha256 === config.admission_config_sha256)) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_BOUND_INPUT_INVALID", "local_preflight");
  }
  const currentBoundFiles = boundBefore.map((fact) => {
    const expectedFact = fact as BoundFileFact;
    return readBoundFile(expectedFact.path, expectedFact.sha256);
  });
  if (canonicalJson(boundBefore) !== canonicalJson(currentBoundFiles.map((bound) => bound.fact))) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_BOUND_INPUT_DRIFT", "local_preflight");
  }
  const frozenCleanupBound = currentBoundFiles.find(
    (bound) => bound.fact.path !== config.admission_config_path,
  );
  if (!frozenCleanupBound) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_CLEANUP_PLAN_REQUIRED", "local_preflight");
  }
  const frozenCleanupPlan = validateFrozenCleanupPlan(
    parseBoundJson(frozenCleanupBound, "diagnostic-cleanup-plan"),
  );
  if (frozenCleanupPlan.plan_sha256 !== record.cleanup_plan_sha256
    || cleanupTargetCoreSha256(frozenCleanupPlan.targets) !== cleanupTargetCoreSha256(cleanupPlan.targets)
    || cleanupSemanticSha256(frozenCleanupPlan) !== cleanupSemanticSha256(cleanupPlan)
    || frozenCleanupPlan.target_host !== admission.target.host
    || frozenCleanupPlan.target_user !== admission.target.user
    || frozenCleanupPlan.target_computer !== admission.target.computer_name
    || frozenCleanupPlan.target_identity_name !== admission.target.identity_name
    || frozenCleanupPlan.target_identity_sid !== admission.target.identity_sid
    || frozenCleanupPlan.transport_source_sha256 !== config.expected_transport_source_sha256
    || frozenCleanupPlan.effective_config_sha256 !== config.expected_effective_config_sha256) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_CLEANUP_PLAN_MISMATCH", "local_preflight");
  }
  return {
    record_path: config.handle_start_diagnostic_record_path,
    record_sha256: recordFact.sha256,
    record_file_fact: structuredClone(recordFact),
    diagnostic_id: record.diagnostic_id as string,
    diagnostic_plan_sha256: record.plan_sha256 as string,
    diagnostic_cleanup_plan_sha256: record.cleanup_plan_sha256 as string,
    cleanup_semantic_sha256: cleanupSemanticSha256(cleanupPlan),
    target_core_sha256: cleanupTargetCoreSha256(cleanupPlan.targets),
    identity: {
      computer: identity.computer as string,
      name: identity.name as string,
      sid: identity.sid as string,
    },
    transport_inputs_sha256: sha256(Buffer.from(canonicalJson(transportsBefore) + "\n", "utf8")),
    bound_inputs_sha256: sha256(Buffer.from(canonicalJson(boundBefore) + "\n", "utf8")),
    ordinal_one: {
      pid: first.pid,
      cim_utc_ticks: String(expectedTicks),
      handle_utc_ticks: String(handleTicks),
      tick_delta: String(delta),
      normalized_cim_utc_ticks: String(normalizedCim),
      normalized_handle_utc_ticks: String(normalizedHandle),
      floor_10_ticks_equal: true,
    },
    pid_13644_exists: true,
    process_termination_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
}

function deriveResidueCleanupPlanV2(
  config: M4fDirectResidueCleanupConfigV2,
  admission: M4fDirectAdmissionConfig,
  residueRecord: unknown,
  stagedRecord: unknown,
  diagnosticRecord: unknown,
  diagnosticRecordFact: BoundFileFact,
): ResidueCleanupPlanV2 {
  const legacy = deriveResidueCleanupPlan(config, admission, residueRecord, stagedRecord);
  const handleStartBinding = validateHandleStartRecordBinding(
    config,
    admission,
    legacy,
    diagnosticRecord,
    diagnosticRecordFact,
  );
  const core: PlanCoreV2 = {
    ...legacy,
    schema: "synthia-m4f-direct-residue-cleanup-plan.v2",
    handle_start_diagnostic: handleStartBinding,
  };
  delete (core as Partial<ResidueCleanupPlanV2>).plan_sha256;
  delete (core as Partial<ResidueCleanupPlanV2>).confirmation;
  const planSha256 = sha256(Buffer.from(canonicalJson(core) + "\n", "utf8"));
  return {
    ...core,
    plan_sha256: planSha256,
    confirmation: cleanupConfirmation(config.ceremony_id, planSha256, EXPECTED_TARGET_COUNT),
  };
}

function loadPlanInputs(config: M4fDirectResidueCleanupConfig): {
  admission: M4fDirectAdmissionConfig;
  residue: unknown;
  staged: unknown;
  diagnostic: unknown | null;
  diagnosticFact: BoundFileFact | null;
  facts: BoundFileFact[];
} {
  const admission = readBoundFile(config.admission_config_path, config.admission_config_sha256);
  const residue = readBoundFile(config.residue_record_path, config.residue_record_sha256);
  const staged = readBoundFile(config.staged_record_path, config.staged_record_sha256);
  const diagnostic = config.schema === "synthia-m4f-direct-residue-cleanup-config.v2"
    ? readBoundFile(
      config.handle_start_diagnostic_record_path,
      config.handle_start_diagnostic_record_sha256,
    ) : null;
  return {
    admission: validateM4fDirectAdmissionConfig(parseBoundJson(admission, "admission")),
    residue: parseBoundJson(residue, "residue"),
    staged: parseBoundJson(staged, "staged"),
    diagnostic: diagnostic === null ? null : parseBoundJson(diagnostic, "handle-start-diagnostic"),
    diagnosticFact: diagnostic?.fact ?? null,
    facts: [admission.fact, residue.fact, staged.fact, ...(diagnostic ? [diagnostic.fact] : [])],
  };
}

function deriveLoadedResidueCleanupPlan(
  config: M4fDirectResidueCleanupConfig,
  inputs: ReturnType<typeof loadPlanInputs>,
): ResidueCleanupPlan {
  if (config.schema === "synthia-m4f-direct-residue-cleanup-config.v1") {
    return deriveResidueCleanupPlan(config, inputs.admission, inputs.residue, inputs.staged);
  }
  if (inputs.diagnostic === null || inputs.diagnosticFact === null) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_RECORD_REQUIRED", "local_preflight");
  }
  return deriveResidueCleanupPlanV2(
    config,
    inputs.admission,
    inputs.residue,
    inputs.staged,
    inputs.diagnostic,
    inputs.diagnosticFact,
  );
}

function validateSources(
  config: Pick<
    M4fDirectResidueCleanupConfig,
    "expected_source_sha256" | "expected_transport_source_sha256"
  >,
  dependencies: CleanupDependencies,
): void {
  const source = dependencies.sourceBytes();
  const transport = dependencies.transportSourceBytes();
  if (source.length < 1 || source.length > MAX_STREAM_BYTES
    || sha256(source) !== config.expected_source_sha256) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_SOURCE_MISMATCH", "local_preflight");
  }
  if (transport.length < 1 || transport.length > MAX_STREAM_BYTES
    || sha256(transport) !== config.expected_transport_source_sha256) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_TRANSPORT_SOURCE_MISMATCH", "local_preflight");
  }
}

function validateHandleStartDiagnosticSources(
  config: M4fDirectHandleStartDiagnosticConfig,
  dependencies: CleanupDependencies,
): void {
  const source = dependencies.sourceBytes();
  const transport = dependencies.transportSourceBytes();
  if (source.length < 1 || source.length > MAX_STREAM_BYTES
    || sha256(source) !== config.expected_source_sha256) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_SOURCE_MISMATCH", "local_preflight");
  }
  if (transport.length < 1 || transport.length > MAX_STREAM_BYTES
    || sha256(transport) !== config.expected_transport_source_sha256) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_TRANSPORT_SOURCE_MISMATCH", "local_preflight");
  }
}

function captureHandleStartDiagnosticTransportInputs(
  admission: M4fDirectAdmissionConfig,
  stage: "local_preflight" | "network" = "local_preflight",
): LocalInputFact[] {
  try {
    return captureM4fDirectTransportInputs(admission, stage === "network" ? "network" : undefined);
  } catch (error) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_TRANSPORT_INPUT_INVALID", stage, {
      cause: error instanceof Error ? error.constructor.name : "unknown",
    });
  }
}

export function planResidueCleanup(
  rawConfig: unknown,
  dependencies: CleanupDependencies = systemDependencies,
): ResidueCleanupPlan {
  const config = validateResidueCleanupConfig(rawConfig);
  validateSources(config, dependencies);
  const inputs = loadPlanInputs(config);
  return deriveLoadedResidueCleanupPlan(config, inputs);
}

function loadHandleStartDiagnosticInputs(config: M4fDirectHandleStartDiagnosticConfig): {
  admission: M4fDirectAdmissionConfig;
  cleanupPlan: ResidueCleanupPlan;
  facts: BoundFileFact[];
} {
  let admission: ReturnType<typeof readBoundFile>;
  let cleanupPlan: ReturnType<typeof readBoundFile>;
  let admitted: M4fDirectAdmissionConfig;
  let frozenPlan: ResidueCleanupPlan;
  try {
    admission = readBoundFile(config.admission_config_path, config.admission_config_sha256);
    cleanupPlan = readBoundFile(config.cleanup_plan_path, config.cleanup_plan_sha256);
    admitted = validateM4fDirectAdmissionConfig(parseBoundJson(admission, "admission"));
    frozenPlan = validateFrozenCleanupPlan(parseBoundJson(cleanupPlan, "cleanup-plan"));
  } catch (error) {
    if (error instanceof HandleStartDiagnosticFailure) throw error;
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_BOUND_INPUT_INVALID", "local_preflight", {
      cause_code: error instanceof ResidueCleanupFailure ? error.detail.code : "unknown",
    });
  }
  if (frozenPlan.target_host !== admitted.target.host
    || frozenPlan.target_user !== admitted.target.user
    || frozenPlan.target_computer !== admitted.target.computer_name
    || frozenPlan.target_identity_name !== admitted.target.identity_name
    || frozenPlan.target_identity_sid !== admitted.target.identity_sid
    || frozenPlan.transport_source_sha256 !== config.expected_transport_source_sha256
    || frozenPlan.effective_config_sha256 !== config.expected_effective_config_sha256) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_IDENTITY_BINDING_INVALID", "local_preflight");
  }
  return { admission: admitted, cleanupPlan: frozenPlan, facts: [admission.fact, cleanupPlan.fact] };
}

export function handleStartDiagnosticConfirmation(
  diagnosticId: string,
  planSha256: string,
  targetCount: number,
): string {
  return `SYNTHIA_M4F_OBSERVE_HANDLE_START_TICKS_READ_ONLY:${diagnosticId}:${planSha256}:${targetCount}`;
}

function deriveHandleStartDiagnosticPlan(
  config: M4fDirectHandleStartDiagnosticConfig,
  admission: M4fDirectAdmissionConfig,
  cleanupPlan: ResidueCleanupPlan,
  consumedRoot: { device: number; inode: number },
): HandleStartDiagnosticPlan {
  if (config.diagnostic_id === cleanupPlan.ceremony_id
    || PERMANENTLY_RETIRED_CEREMONY_IDS.includes(
      config.diagnostic_id as typeof PERMANENTLY_RETIRED_CEREMONY_IDS[number],
    ) || PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS.includes(
      config.diagnostic_id as typeof PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS[number],
    )) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_ID_RESERVED", "local_preflight", {
      diagnostic_id: config.diagnostic_id,
      cleanup_ceremony_id: cleanupPlan.ceremony_id,
    });
  }
  const core: HandleStartDiagnosticPlanCore = {
    schema: "synthia-m4f-direct-handle-start-diagnostic-plan.v1",
    status: "planned_not_executed",
    diagnostic_id: config.diagnostic_id,
    cleanup_ceremony_id: cleanupPlan.ceremony_id,
    cleanup_plan_sha256: cleanupPlan.plan_sha256,
    cleanup_plan_file_sha256: config.cleanup_plan_sha256,
    admission_config_sha256: config.admission_config_sha256,
    consumed_evidence_root: config.consumed_evidence_root,
    consumed_evidence_root_device: consumedRoot.device,
    consumed_evidence_root_inode: consumedRoot.inode,
    target_host: admission.target.host,
    target_user: admission.target.user,
    target_computer: admission.target.computer_name,
    target_identity_name: admission.target.identity_name,
    target_identity_sid: admission.target.identity_sid,
    source_sha256: config.expected_source_sha256,
    transport_source_sha256: config.expected_transport_source_sha256,
    effective_config_sha256: config.expected_effective_config_sha256,
    target_count: EXPECTED_TARGET_COUNT,
    targets: structuredClone(cleanupPlan.targets),
    effect: {
      operation: "observe_handle_start_ticks_read_only",
      ordinal_one_only_handle_open: true,
      maximum_remote_attempts: 1,
      timeout_ms: TIMEOUT_MS,
      process_termination_permitted: false,
      service_mutation_permitted: false,
      file_mutation_permitted: false,
      vivado_permitted: false,
      hardware_action_permitted: false,
    },
    network_attempted: false,
    process_termination_performed: false,
    hardware_action_performed: false,
  };
  const planSha256 = sha256(Buffer.from(canonicalJson(core) + "\n", "utf8"));
  return {
    ...core,
    plan_sha256: planSha256,
    confirmation: handleStartDiagnosticConfirmation(
      config.diagnostic_id,
      planSha256,
      EXPECTED_TARGET_COUNT,
    ),
  };
}

export function planHandleStartDiagnostic(
  rawConfig: unknown,
  dependencies: CleanupDependencies = systemDependencies,
): HandleStartDiagnosticPlan {
  const config = validateHandleStartDiagnosticConfig(rawConfig);
  validateHandleStartDiagnosticSources(config, dependencies);
  const inputs = loadHandleStartDiagnosticInputs(config);
  const consumedRoot = captureConsumedEvidenceRoot(config.consumed_evidence_root);
  assertHandleStartDiagnosticIdUnconsumed(config);
  return deriveHandleStartDiagnosticPlan(config, inputs.admission, inputs.cleanupPlan, consumedRoot);
}

export function assertHandleStartDiagnosticConfirmation(
  plan: HandleStartDiagnosticPlan,
  confirmation: string,
): void {
  if (confirmation !== plan.confirmation) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_CONFIRMATION_REQUIRED", "local_preflight");
  }
}

export function cleanupConfirmation(ceremonyId: string, planSha256: string, targetCount: number): string {
  return "SYNTHIA_M4F_RESOLVE_EXACT_DIAGNOSTIC_RESIDUE_ALLOW_PREFLIGHT_BOUND_CONHOST_EXIT:"
    + `${ceremonyId}:${planSha256}:${targetCount}`;
}

export function assertResidueCleanupConfirmation(
  plan: ResidueCleanupPlan,
  confirmation: string,
): void {
  if (confirmation !== plan.confirmation) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_CONFIRMATION_REQUIRED", "local_preflight");
  }
}

function remotePlan(plan: ResidueCleanupPlan): JsonObject {
  const commandHashes = [
    plan.targets.find((target) => target.name === "powershell.exe")!.command_sha256,
    plan.targets.find((target) => target.name === "conhost.exe")!.command_sha256,
  ];
  return {
    q: plan.plan_sha256,
    c: plan.target_computer,
    n: plan.target_identity_name,
    s: plan.target_identity_sid,
    h: commandHashes,
    t: plan.targets.map((target) => [
      target.ordinal,
      target.pid,
      target.parent_pid,
      target.peer_pid,
      target.name === "powershell.exe" ? 0 : 1,
      target.creation_utc,
    ]),
    p: plan.protected_processes.map((process) => process.pid),
  };
}

export function buildResidueCleanupRemoteScript(plan: ResidueCleanupPlan): string {
  const encodedPlan = Buffer.from(JSON.stringify(remotePlan(plan)), "utf8").toString("base64");
  return [
    "$ErrorActionPreference=\"Stop\";[Console]::OutputEncoding=[Text.UTF8Encoding]::new()",
    `$c=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\"${encodedPlan}\"))|ConvertFrom-Json)`,
    "function SynthiaHash($s){([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s)))-replace\"-\",\"\").ToLower()}",
    "function E($p,$s,$d){$x=[ordered]@{phase=$p;status=$s;observed_at_utc=[DateTime]::UtcNow.ToString(\"o\");payload=$d};[Console]::Out.WriteLine(($x|ConvertTo-Json -Compress -Depth 6));[Console]::Out.Flush()}",
    "function I(){ $i=[Security.Principal.WindowsIdentity]::GetCurrent();[ordered]@{computer=$env:COMPUTERNAME;name=$i.Name.ToLowerInvariant();sid=$i.User.Value} }",
    "function T($t){$n=@(\"powershell.exe\",\"conhost.exe\")[[int]$t[4]];$h=[string]$c.h[[int]$t[4]];SynthiaHash ([string]$t[1]+\"|\"+$t[2]+\"|\"+$n+\"|\"+$t[5]+\"|\"+$h+\"|session\")}",
    `function U($d){$u=([datetime]$d).ToUniversalTime();[long]($u.Ticks-($u.Ticks%${WINDOWS_CIM_TICKS_PER_MICROSECOND}))}`,
    "function F($x){$d=$x.CreationDate.ToUniversalTime().ToString(\"o\");$n=$x.Name.ToLowerInvariant();$h=SynthiaHash ([string]$x.CommandLine);$k=if($x.ProcessId-eq$PID){\"current\"}elseif($n-eq\"sshd.exe\"){\"sshd\"}else{\"session\"};$z=[string]$x.ProcessId+\"|\"+$x.ParentProcessId+\"|\"+$n+\"|\"+$d+\"|\"+$h+\"|\"+$k;@([int]$x.ProcessId,[int]$x.ParentProcessId,$n,$d,$h,$k,(SynthiaHash $z))}",
    "E start observed ([ordered]@{current_pid=$PID;target_count=$c.t.Count;plan_sha256=$c.q})",
    "$a=I;if($a.computer-ine$c.c-or$a.name-ine$c.n-or$a.sid-ne$c.s){E pre-identity unknown $a;throw \"IDENTITY\"};E pre-identity observed $a",
    "$all=@(Get-CimInstance Win32_Process);$by=@{};$all|%{$by[[int]$_.ProcessId]=$_};$anc=@{};$p=[int]$PID;while($p-and$by.ContainsKey($p)-and-not$anc.ContainsKey($p)){$anc[$p]=$true;$p=[int]$by[$p].ParentProcessId}",
    "$seen=@{};$bad=@();foreach($t in $c.t){$i=[int]$t[1];if($seen[$i]-or$anc[$i]-or$c.p-contains$i-or-not$by[$i]){$bad+=$i;continue};$seen[$i]=1;$f=F $by[$i];$n=@(\"powershell.exe\",\"conhost.exe\")[[int]$t[4]];if($f[1]-ne[int]$t[2]-or$f[2]-cne$n-or$f[3]-cne[string]$t[5]-or$f[4]-cne[string]$c.h[[int]$t[4]]-or$f[5]-cne\"session\"-or-not$by[[int]$t[3]]-or[long]$by[[int]$t[3]].ParentProcessId-ne[int]$t[2]){$bad+=$i}}",
    "if($bad.Count){E preflight unknown ([ordered]@{mismatch_pids=@($bad|sort -Unique)});throw \"PREFLIGHT\"};E preflight observed ([ordered]@{matched=$c.t.Count})",
    "$kill=@();$exit=@();$resolved=@();foreach($t in $c.t){$i=[int]$t[1];$x=Get-CimInstance Win32_Process -Filter (\"ProcessId=\"+$i);if(-not$x){if([int]$t[4]-eq1){$exit+=$i;$resolved+=$i;E target observed ([ordered]@{ordinal=[int]$t[0];pid=$i;start_token=(T $t);effect=\"exited_after_preflight\"});continue};E target unknown ([ordered]@{ordinal=[int]$t[0];pid=$i;effect=\"none_missing_after_preflight\"});throw \"MISSING\"};$f=F $x;$n=@(\"powershell.exe\",\"conhost.exe\")[[int]$t[4]];if($f[1]-ne[int]$t[2]-or$f[2]-cne$n-or$f[3]-cne[string]$t[5]-or$f[4]-cne[string]$c.h[[int]$t[4]]-or$f[5]-cne\"session\"){E target unknown ([ordered]@{ordinal=[int]$t[0];pid=$i;effect=\"none_token_changed\"});throw \"TOKEN\"};$p=[Diagnostics.Process]::GetProcessById($i);if((U $p.StartTime)-ne(U ([string]$t[5]))){E target unknown ([ordered]@{ordinal=[int]$t[0];pid=$i;effect=\"none_handle_start_changed\"});throw \"HANDLE\"};$p.Kill();if(-not$p.WaitForExit(5000)){throw \"WAIT\"};$kill+=$i;$resolved+=$i;E target observed ([ordered]@{ordinal=[int]$t[0];pid=$i;start_token=$f[6];effect=\"terminated_exact_handle\"})}",
    "$left=@();foreach($t in $c.t){if(Get-CimInstance Win32_Process -Filter (\"ProcessId=\"+[int]$t[1])){$left+=[int]$t[1]}};if($left.Count){E postflight unknown ([ordered]@{residue_pids=$left});throw \"POST\"};E postflight observed ([ordered]@{residue_pids=@();kill_performed_pids=$kill;already_exited_pids=$exit;resolved_target_pids=$resolved})",
    "$z=I;if($z.computer-ine$c.c-or$z.name-ine$c.n-or$z.sid-ne$c.s){E post-identity unknown $z;throw \"IDENTITY_POST\"};E post-identity observed $z;E complete observed ([ordered]@{complete=$true;resolved_count=$resolved.Count;kill_performed_count=$kill.Count;already_exited_count=$exit.Count})",
    "",
  ].join("\n");
}

export function buildResidueCleanupRemoteCommand(plan: ResidueCleanupPlan): {
  script: string;
  compressed: Buffer;
  loader: string;
  command: string;
} {
  const script = buildResidueCleanupRemoteScript(plan);
  const compressed = gzipSync(Buffer.from(script, "utf8"), { level: 9 });
  const payload = compressed.toString("base64");
  const loader = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('"
    + payload + "')),[IO.Compression.CompressionMode]0);&([ScriptBlock]::Create([IO.StreamReader]::new($g).ReadToEnd()))";
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"&{"
    + loader + "}\"";
  if (command.length > REMOTE_COMMAND_LIMIT) {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_COMMAND_TOO_LONG", "local_preflight", {
      command_length: command.length,
      command_length_limit: REMOTE_COMMAND_LIMIT,
    });
  }
  return { script, compressed, loader, command };
}

function handleStartDiagnosticRemotePlan(plan: HandleStartDiagnosticPlan): JsonObject {
  return {
    q: plan.plan_sha256,
    d: plan.diagnostic_id,
    c: plan.cleanup_plan_sha256,
    computer: plan.target_computer,
    identity_name: plan.target_identity_name,
    identity_sid: plan.target_identity_sid,
    t: plan.targets.map((target) => [
      target.ordinal,
      target.pid,
      target.parent_pid,
      target.peer_pid,
      target.name,
      target.creation_utc,
      target.command_sha256,
      target.start_token_sha256,
    ]),
  };
}

export function buildHandleStartDiagnosticRemoteScript(plan: HandleStartDiagnosticPlan): string {
  const encodedPlan = Buffer.from(JSON.stringify(handleStartDiagnosticRemotePlan(plan)), "utf8")
    .toString("base64");
  return [
    "$ErrorActionPreference=\"Stop\";[Console]::OutputEncoding=[Text.UTF8Encoding]::new()",
    `$c=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedPlan}"))|ConvertFrom-Json)`,
    "function Invoke-SynthiaM4fHandleStartDiagnosticSha256Exact($s){([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s)))-replace\"-\",\"\").ToLower()}",
    "$wi=[Security.Principal.WindowsIdentity]::GetCurrent();$identity=[ordered]@{computer=$env:COMPUTERNAME;name=$wi.Name.ToLowerInvariant();sid=$wi.User.Value}",
    "$all=@(Get-CimInstance Win32_Process);$by=@{};$all|%{$by[[int]$_.ProcessId]=$_};$rows=@();foreach($t in $c.t){$x=$by[[int]$t[1]];if($null-eq$x){$rows+=,[ordered]@{ordinal=[int]$t[0];expected_pid=[int]$t[1];exists=$false};continue};$cu=$x.CreationDate.ToUniversalTime();$n=$x.Name.ToLowerInvariant();$ch=Invoke-SynthiaM4fHandleStartDiagnosticSha256Exact ([string]$x.CommandLine);$cl=if($x.ProcessId-eq$PID){\"current\"}elseif($n-eq\"sshd.exe\"){\"sshd\"}else{\"session\"};$ok=([int]$x.ProcessId-eq[int]$t[1]-and[int]$x.ParentProcessId-eq[int]$t[2]-and$n-ceq[string]$t[4]-and$cu.ToString(\"o\")-ceq[string]$t[5]-and$ch-ceq[string]$t[6]-and$cl-ceq\"session\");$rows+=,[ordered]@{ordinal=[int]$t[0];expected_pid=[int]$t[1];exists=$true;pid=[int]$x.ProcessId;parent_pid=[int]$x.ParentProcessId;name=$n;creation_utc=$cu.ToString(\"o\");creation_utc_ticks=[string]$cu.Ticks;command_sha256=$ch;process_class=$cl;core_match=$ok}}",
    "$t1=$c.t[0];$r1=$rows[0];$handle=$null;if($r1.exists){try{$p=[Diagnostics.Process]::GetProcessById([int]$t1[1]);$hx=$p.HasExited;$hs=$p.StartTime.ToUniversalTime();$ct=([datetime][string]$t1[5]).ToUniversalTime().Ticks;$handle=[ordered]@{available=$true;id=[int]$p.Id;has_exited=[bool]$hx;start_time_utc=$hs.ToString(\"o\");start_time_utc_ticks=[string]$hs.Ticks;expected_cim_utc_ticks=[string]$ct;tick_delta=[string]([long]$hs.Ticks-[long]$ct);normalized_handle_utc_ticks=[string]([long]$hs.Ticks-([long]$hs.Ticks%10));normalized_cim_utc_ticks=[string]([long]$ct-([long]$ct%10));normalized_equal=(([long]$hs.Ticks-([long]$hs.Ticks%10))-eq([long]$ct-([long]$ct%10)))}}catch{$handle=[ordered]@{available=$false;error_type=$_.Exception.GetType().FullName}}}else{$handle=[ordered]@{available=$false;error_type=\"cim_target_missing\"}}",
    "$w=$by[13644];$worker=if($null-eq$w){[ordered]@{pid=13644;exists=$false}}else{[ordered]@{pid=13644;exists=$true;name=$w.Name.ToLowerInvariant();creation_utc=if($w.CreationDate){$w.CreationDate.ToUniversalTime().ToString(\"o\")}}};$sshd=@($all|?{$_.Name-ieq\"sshd.exe\"}|sort ProcessId|%{[ordered]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;name=$_.Name.ToLowerInvariant()}})",
    "$expected=[ordered]@{ordinal=[int]$t1[0];pid=[int]$t1[1];parent_pid=[int]$t1[2];peer_pid=[int]$t1[3];name=[string]$t1[4];creation_utc=[string]$t1[5];command_sha256=[string]$t1[6];start_token=[string]$t1[7]}",
    "$o=[ordered]@{schema=\"synthia-m4f-direct-handle-start-observation.v1\";diagnostic_id=$c.d;diagnostic_plan_sha256=$c.q;cleanup_plan_sha256=$c.c;current_pid=$PID;identity=$identity;ordinal_one_expected=$expected;ordinal_one=[ordered]@{cim=$r1;handle=$handle};targets=$rows;protection=[ordered]@{pid_13644=$worker;sshd=$sshd};process_termination_performed=$false;file_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false};[Console]::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 8));[Console]::Out.Flush()",
    "",
  ].join("\n");
}

export function buildHandleStartDiagnosticRemoteCommand(plan: HandleStartDiagnosticPlan): {
  script: string;
  compressed: Buffer;
  loader: string;
  command: string;
} {
  const script = buildHandleStartDiagnosticRemoteScript(plan);
  const compressed = gzipSync(Buffer.from(script, "utf8"), { level: 9 });
  const payload = compressed.toString("base64");
  const loader = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('"
    + payload + "')),[IO.Compression.CompressionMode]0);&([ScriptBlock]::Create([IO.StreamReader]::new($g).ReadToEnd()))";
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"&{"
    + loader + "}\"";
  if (command.length > REMOTE_COMMAND_LIMIT) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_COMMAND_TOO_LONG", "local_preflight", {
      command_length: command.length,
      command_length_limit: REMOTE_COMMAND_LIMIT,
    });
  }
  return { script, compressed, loader, command };
}

function decimalTicks(value: unknown, signed = false): boolean {
  return typeof value === "string" && (signed ? /^-?\d+$/u : /^\d+$/u).test(value)
    && value.length <= 20;
}

function parseDecimalTicks(value: unknown, signed = false): bigint | null {
  if (!decimalTicks(value, signed)) return null;
  try {
    const ticks = BigInt(value as string);
    if (!signed && (ticks < 0n || ticks > DOTNET_MAX_TICKS)) return null;
    return ticks;
  } catch {
    return null;
  }
}

function parsedIsoTicks(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  try {
    return parseDotNetUtcIsoToTicks(value);
  } catch {
    return null;
  }
}

function validDiagnosticTargetRow(value: JsonObject, expected: CleanupTarget): boolean {
  if (value.ordinal !== expected.ordinal || value.expected_pid !== expected.pid
    || typeof value.exists !== "boolean") return false;
  if (value.exists === false) return exactKeys(value, ["exists", "expected_pid", "ordinal"]);
  const isoTicks = parsedIsoTicks(value.creation_utc);
  const reportedTicks = parseDecimalTicks(value.creation_utc_ticks);
  const expectedCoreMatch = value.pid === expected.pid && value.parent_pid === expected.parent_pid
    && value.name === expected.name && value.creation_utc === expected.creation_utc
    && value.command_sha256 === expected.command_sha256 && value.process_class === "session";
  return exactKeys(value, [
    "command_sha256", "core_match", "creation_utc", "creation_utc_ticks", "exists",
    "expected_pid", "name", "ordinal", "parent_pid", "pid", "process_class",
  ]) && value.pid === expected.pid && safeInteger(value.parent_pid)
    && typeof value.name === "string" && isoTicks !== null && reportedTicks === isoTicks
    && typeof value.command_sha256 === "string"
    && HASH.test(value.command_sha256) && typeof value.process_class === "string"
    && value.core_match === expectedCoreMatch;
}

export function validHandleStartDiagnosticOutput(
  value: unknown,
  plan: HandleStartDiagnosticPlan,
): value is JsonObject {
  const output = object(value);
  const identity = object(output?.identity);
  const expected = object(output?.ordinal_one_expected);
  const ordinalOne = object(output?.ordinal_one);
  const cim = object(ordinalOne?.cim);
  const handle = object(ordinalOne?.handle);
  const protection = object(output?.protection);
  const worker = object(protection?.pid_13644);
  const targets = Array.isArray(output?.targets) ? output.targets.map(object) : [];
  const sshd = Array.isArray(protection?.sshd) ? protection.sshd.map(object) : [];
  const first = plan.targets[0]!;
  const expectedTicks = parsedIsoTicks(first.creation_utc);
  if (!output || !exactKeys(output, [
    "cleanup_plan_sha256", "current_pid", "diagnostic_id", "diagnostic_plan_sha256",
    "file_mutation_performed", "hardware_action_performed", "identity", "ordinal_one",
    "ordinal_one_expected", "process_termination_performed", "protection", "schema", "targets",
    "vivado_action_performed",
  ]) || output.schema !== "synthia-m4f-direct-handle-start-observation.v1"
    || output.diagnostic_id !== plan.diagnostic_id
    || output.diagnostic_plan_sha256 !== plan.plan_sha256
    || output.cleanup_plan_sha256 !== plan.cleanup_plan_sha256
    || !safeInteger(output.current_pid, 1) || !identity
    || !exactKeys(identity, ["computer", "name", "sid"])
    || identity.computer !== plan.target_computer || identity.name !== plan.target_identity_name
    || identity.sid !== plan.target_identity_sid || !expected
    || !exactKeys(expected, [
      "command_sha256", "creation_utc", "name", "ordinal", "parent_pid", "peer_pid", "pid",
      "start_token",
    ]) || !ordinalOne || !exactKeys(ordinalOne, ["cim", "handle"]) || !cim || !handle
    || expected.ordinal !== 1 || expected.pid !== first.pid || expected.parent_pid !== first.parent_pid
    || expected.peer_pid !== first.peer_pid || expected.name !== first.name
    || expected.creation_utc !== first.creation_utc
    || expected.command_sha256 !== first.command_sha256
    || expected.start_token !== first.start_token_sha256
    || targets.length !== EXPECTED_TARGET_COUNT || targets.some((row, index) => !row
      || !validDiagnosticTargetRow(row, plan.targets[index]!))
    || canonicalJson(cim) !== canonicalJson(targets[0])
    || typeof handle.available !== "boolean" || !protection
    || !exactKeys(protection, ["pid_13644", "sshd"]) || !worker
    || worker.pid !== 13644 || typeof worker.exists !== "boolean"
    || sshd.some((row) => !row || !exactKeys(row, ["name", "parent_pid", "pid"])
      || !safeInteger(row.pid, 1) || !safeInteger(row.parent_pid) || row.name !== "sshd.exe")
    || output.process_termination_performed !== false || output.file_mutation_performed !== false
    || output.vivado_action_performed !== false || output.hardware_action_performed !== false) return false;
  if (worker.exists === false && !exactKeys(worker, ["exists", "pid"])) return false;
  if (worker.exists === true && (!exactKeys(worker, ["creation_utc", "exists", "name", "pid"])
    || typeof worker.name !== "string" || (worker.creation_utc !== null
      && !utcTimestamp(worker.creation_utc)))) return false;
  if (handle.available !== true || cim.exists !== true || cim.core_match !== true
    || expectedTicks === null || !exactKeys(handle, [
    "available", "expected_cim_utc_ticks", "has_exited", "id", "normalized_cim_utc_ticks",
    "normalized_equal", "normalized_handle_utc_ticks", "start_time_utc", "start_time_utc_ticks",
    "tick_delta",
  ]) || handle.id !== first.pid || handle.id !== cim.pid || handle.has_exited !== false) return false;
  const handleIsoTicks = parsedIsoTicks(handle.start_time_utc);
  const handleTicks = parseDecimalTicks(handle.start_time_utc_ticks);
  const reportedExpectedTicks = parseDecimalTicks(handle.expected_cim_utc_ticks);
  const tickDelta = parseDecimalTicks(handle.tick_delta, true);
  const normalizedHandleTicks = parseDecimalTicks(handle.normalized_handle_utc_ticks);
  const normalizedCimTicks = parseDecimalTicks(handle.normalized_cim_utc_ticks);
  if (handleIsoTicks === null || handleTicks !== handleIsoTicks
    || reportedExpectedTicks !== expectedTicks || tickDelta !== handleTicks - expectedTicks
    || normalizedHandleTicks !== normalizeWindowsUtcTicksToCimPrecision(handleTicks)
    || normalizedCimTicks !== normalizeWindowsUtcTicksToCimPrecision(expectedTicks)) return false;
  const calculatedEqual = normalizedHandleTicks === normalizedCimTicks;
  if (handle.normalized_equal !== calculatedEqual || !calculatedEqual) return false;
  return true;
}

export function parseCleanupMarkerPrefix(raw: Buffer): CleanupMarkerPrefix {
  const lastNewline = raw.lastIndexOf(0x0a);
  const completePrefix = lastNewline < 0 ? Buffer.alloc(0) : raw.subarray(0, lastNewline + 1);
  const trailingFragment = lastNewline < 0 ? raw : raw.subarray(lastNewline + 1);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(completePrefix);
  } catch {
    return {
      markers: null,
      trailing_fragment_length: trailingFragment.length,
      trailing_fragment_sha256: sha256(trailingFragment),
      stdout_truncated_line: trailingFragment.length > 0,
    };
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const markers: CleanupMarker[] = [];
  try {
    for (const line of lines) {
      const marker = object(JSON.parse(line));
      if (!marker || !exactKeys(marker, ["observed_at_utc", "payload", "phase", "status"])
        || !["start", "pre-identity", "preflight", "target", "postflight", "post-identity", "complete"]
          .includes(String(marker.phase))
        || (marker.status !== "observed" && marker.status !== "unknown")
        || !utcTimestamp(marker.observed_at_utc) || !object(marker.payload)) {
        return {
          markers: null,
          trailing_fragment_length: trailingFragment.length,
          trailing_fragment_sha256: sha256(trailingFragment),
          stdout_truncated_line: trailingFragment.length > 0,
        };
      }
      markers.push(marker as unknown as CleanupMarker);
    }
  } catch {
    return {
      markers: null,
      trailing_fragment_length: trailingFragment.length,
      trailing_fragment_sha256: sha256(trailingFragment),
      stdout_truncated_line: trailingFragment.length > 0,
    };
  }
  return {
    markers,
    trailing_fragment_length: trailingFragment.length,
    trailing_fragment_sha256: sha256(trailingFragment),
    stdout_truncated_line: trailingFragment.length > 0,
  };
}

export function parseCleanupMarkers(raw: Buffer): CleanupMarker[] | null {
  return parseCleanupMarkerPrefix(raw).markers;
}

function exactNumberSet(value: unknown, expected: number[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item) => safeInteger(item, 1))
    && [...value].sort((left, right) => left - right)
      .every((item, index) => item === [...expected].sort((left, right) => left - right)[index]);
}

export function validCleanupOutput(
  markers: CleanupMarker[],
  plan: ResidueCleanupPlan,
): boolean {
  if (markers.length !== EXPECTED_TARGET_COUNT + 6) return false;
  const phases = markers.map((marker) => marker.phase);
  if (phases[0] !== "start" || phases[1] !== "pre-identity" || phases[2] !== "preflight"
    || phases.slice(3, 3 + EXPECTED_TARGET_COUNT).some((phase) => phase !== "target")
    || phases.at(-3) !== "postflight" || phases.at(-2) !== "post-identity"
    || phases.at(-1) !== "complete" || markers.some((marker) => marker.status !== "observed")) {
    return false;
  }
  const start = markers[0]!.payload;
  const preIdentity = markers[1]!.payload;
  const preflight = markers[2]!.payload;
  const postflight = markers.at(-3)!.payload;
  const postIdentity = markers.at(-2)!.payload;
  const complete = markers.at(-1)!.payload;
  if (!exactKeys(start, ["current_pid", "plan_sha256", "target_count"])
    || !exactKeys(preIdentity, ["computer", "name", "sid"])
    || !exactKeys(preflight, ["matched"])
    || !exactKeys(postflight, [
      "already_exited_pids",
      "kill_performed_pids",
      "residue_pids",
      "resolved_target_pids",
    ])
    || !exactKeys(postIdentity, ["computer", "name", "sid"])
    || !exactKeys(complete, [
      "already_exited_count",
      "complete",
      "kill_performed_count",
      "resolved_count",
    ])
    || !safeInteger(start.current_pid, 1) || start.target_count !== EXPECTED_TARGET_COUNT
    || start.plan_sha256 !== plan.plan_sha256 || preflight.matched !== EXPECTED_TARGET_COUNT
    || preIdentity.computer !== plan.target_computer
    || preIdentity.name !== plan.target_identity_name || preIdentity.sid !== plan.target_identity_sid
    || postIdentity.computer !== plan.target_computer
    || postIdentity.name !== plan.target_identity_name || postIdentity.sid !== plan.target_identity_sid
    || complete.complete !== true || complete.resolved_count !== EXPECTED_TARGET_COUNT
    || !Array.isArray(postflight.residue_pids) || postflight.residue_pids.length !== 0) return false;
  const expectedPids = plan.targets.map((target) => target.pid);
  const effects = classifyPartialCleanupEffects(markers, plan);
  return effects.attribution_valid && effects.resolved_target_pids.length === EXPECTED_TARGET_COUNT
    && exactNumberSet(postflight.kill_performed_pids, effects.kill_performed_pids)
    && exactNumberSet(postflight.already_exited_pids, effects.already_exited_pids)
    && exactNumberSet(postflight.resolved_target_pids, expectedPids)
    && complete.kill_performed_count === effects.kill_performed_pids.length
    && complete.already_exited_count === effects.already_exited_pids.length;
}

export function classifyPartialCleanupEffects(
  markers: CleanupMarker[],
  plan: ResidueCleanupPlan,
): CleanupEffectClassification {
  const invalid = (): CleanupEffectClassification => ({
    attribution_valid: false,
    explicit_no_effect: false,
    kill_performed_pids: [],
    already_exited_pids: [],
    resolved_target_pids: [],
  });
  const empty = (explicitNoEffect = false): CleanupEffectClassification => ({
    attribution_valid: true,
    explicit_no_effect: explicitNoEffect,
    kill_performed_pids: [],
    already_exited_pids: [],
    resolved_target_pids: [],
  });
  if (markers.length === 0) return empty();
  const start = markers[0];
  if (!start || start.phase !== "start" || start.status !== "observed"
    || !exactKeys(start.payload, ["current_pid", "plan_sha256", "target_count"])
    || !safeInteger(start.payload.current_pid, 1)
    || start.payload.plan_sha256 !== plan.plan_sha256
    || start.payload.target_count !== EXPECTED_TARGET_COUNT) return invalid();
  if (markers.length === 1) return empty();
  const preIdentity = markers[1];
  if (!preIdentity || preIdentity.phase !== "pre-identity") return invalid();
  if (preIdentity.status === "unknown") return markers.length === 2 ? empty(true) : invalid();
  if (preIdentity.status !== "observed"
    || !exactKeys(preIdentity.payload, ["computer", "name", "sid"])
    || preIdentity.payload.computer !== plan.target_computer
    || preIdentity.payload.name !== plan.target_identity_name
    || preIdentity.payload.sid !== plan.target_identity_sid) return invalid();
  if (markers.length === 2) return empty();
  const preflight = markers[2];
  if (!preflight || preflight.phase !== "preflight") return invalid();
  if (preflight.status === "unknown") return markers.length === 3 ? empty(true) : invalid();
  if (preflight.status !== "observed" || !exactKeys(preflight.payload, ["matched"])
    || preflight.payload.matched !== EXPECTED_TARGET_COUNT) return invalid();

  const killPerformedPids: number[] = [];
  const alreadyExitedPids: number[] = [];
  let markerIndex = 3;
  let targetIndex = 0;
  while (markerIndex < markers.length && markers[markerIndex]!.phase === "target") {
    const marker = markers[markerIndex]!;
    const target = plan.targets[targetIndex];
    if (!target) return invalid();
    if (marker.status === "unknown") {
      if (markerIndex !== markers.length - 1
        || !exactKeys(marker.payload, ["effect", "ordinal", "pid"])
        || marker.payload.ordinal !== target.ordinal || marker.payload.pid !== target.pid
        || !["none_missing_after_preflight", "none_token_changed", "none_handle_start_changed"]
          .includes(String(marker.payload.effect))) return invalid();
      return {
        attribution_valid: true,
        explicit_no_effect: false,
        kill_performed_pids: killPerformedPids,
        already_exited_pids: alreadyExitedPids,
        resolved_target_pids: [...killPerformedPids, ...alreadyExitedPids],
      };
    }
    const effect = marker.payload.effect;
    if (marker.status !== "observed"
      || !exactKeys(marker.payload, ["effect", "ordinal", "pid", "start_token"])
      || marker.payload.ordinal !== target.ordinal || marker.payload.pid !== target.pid
      || marker.payload.start_token !== target.start_token_sha256
      || (effect !== "terminated_exact_handle"
        && !(target.name === "conhost.exe" && effect === "exited_after_preflight"))) return invalid();
    if (effect === "terminated_exact_handle") killPerformedPids.push(target.pid);
    else alreadyExitedPids.push(target.pid);
    markerIndex += 1;
    targetIndex += 1;
  }
  if (markerIndex < markers.length) {
    if (targetIndex !== EXPECTED_TARGET_COUNT
      || markers.length - markerIndex > 3) return invalid();
    const finalPhases = ["postflight", "post-identity", "complete"] as const;
    for (let index = markerIndex; index < markers.length; index += 1) {
      if (markers[index]!.phase !== finalPhases[index - markerIndex]) return invalid();
    }
  }
  return {
    attribution_valid: true,
    explicit_no_effect: false,
    kill_performed_pids: killPerformedPids,
    already_exited_pids: alreadyExitedPids,
    resolved_target_pids: [...killPerformedPids, ...alreadyExitedPids],
  };
}

function processEvidence(raw: RawProcessResult): CleanupProcessEvidence {
  const timedOut = raw.errorCode === "ETIMEDOUT";
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: timedOut,
    outcome_ambiguous: timedOut || raw.status !== 0 || raw.signal !== null || raw.errorCode !== null,
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function makeDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: false });
  chmodSync(path, 0o700);
}

function writeEvidence(directory: string, name: string, content: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(directory + "/" + name, 0o600);
}

function parseHandleStartDiagnosticOutput(raw: Buffer): unknown {
  if (raw.length < 2 || raw.at(-1) !== 0x0a) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return null;
  }
  const lines = text.trimEnd().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0]!.length < 2) return null;
  try {
    return JSON.parse(lines[0]!);
  } catch {
    return null;
  }
}

export function executeHandleStartDiagnostic(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: CleanupDependencies = systemDependencies,
): HandleStartDiagnosticRecord {
  const config = validateHandleStartDiagnosticConfig(rawConfig);
  validateHandleStartDiagnosticSources(config, dependencies);
  const inputsBefore = loadHandleStartDiagnosticInputs(config);
  const consumedRootBefore = captureConsumedEvidenceRoot(config.consumed_evidence_root);
  assertHandleStartDiagnosticIdUnconsumed(config);
  const plan = deriveHandleStartDiagnosticPlan(
    config,
    inputsBefore.admission,
    inputsBefore.cleanupPlan,
    consumedRootBefore,
  );
  assertHandleStartDiagnosticConfirmation(plan, confirmation);
  const packed = buildHandleStartDiagnosticRemoteCommand(plan);
  const transportBefore = captureHandleStartDiagnosticTransportInputs(inputsBefore.admission);
  const absolute = resolve(evidenceDirectory);
  const expectedEvidenceDirectory = resolve(config.consumed_evidence_root, config.diagnostic_id);
  if (absolute !== expectedEvidenceDirectory) {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_EVIDENCE_PATH_MISMATCH", "local_preflight", {
      expected_path: expectedEvidenceDirectory,
    });
  }
  try {
    makeDirectory(absolute);
  } catch {
    diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_ID_CONSUMED", "local_preflight", {
      diagnostic_id: config.diagnostic_id,
      consumed_evidence_path: expectedEvidenceDirectory,
    });
  }
  let remoteAttempted = false;
  let remoteProcess: CleanupProcessEvidence | null = null;
  let observation: JsonObject | null = null;
  try {
    writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "diagnostic-plan.json", JSON.stringify(plan, null, 2) + "\n");
    writeEvidence(absolute, "remote-script.ps1", packed.script);
    writeEvidence(absolute, "remote-loader.ps1", packed.loader);
    writeEvidence(absolute, "remote-payload.gzip", packed.compressed);
    const effective = dependencies.spawn(
      SSH_PATH,
      buildDirectSshEffectiveArguments(inputsBefore.admission),
      Buffer.alloc(0),
      15_000,
    );
    const effectiveFact = processEvidence(effective);
    writeEvidence(absolute, "ssh-effective.stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective.stderr.raw", effective.stderr);
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(effectiveFact, null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0
      || sha256(effective.stdout) !== config.expected_effective_config_sha256) {
      diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_EFFECTIVE_CONFIG_FAILED", "local_preflight");
    }
    try {
      auditDirectSshEffectiveConfig(effective.stdout, inputsBefore.admission);
    } catch {
      diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_EFFECTIVE_CONFIG_MISMATCH", "local_preflight");
    }
    validateHandleStartDiagnosticSources(config, dependencies);
    const inputsCurrent = loadHandleStartDiagnosticInputs(config);
    const consumedRootCurrent = captureConsumedEvidenceRoot(config.consumed_evidence_root);
    const currentPlan = deriveHandleStartDiagnosticPlan(
      config,
      inputsCurrent.admission,
      inputsCurrent.cleanupPlan,
      consumedRootCurrent,
    );
    const transportCurrent = captureHandleStartDiagnosticTransportInputs(inputsBefore.admission, "network");
    if (canonicalJson(inputsBefore.facts) !== canonicalJson(inputsCurrent.facts)
      || currentPlan.plan_sha256 !== plan.plan_sha256
      || canonicalJson(transportBefore) !== canonicalJson(transportCurrent)) {
      diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_LOCAL_INPUT_DRIFT", "network");
    }
    const startedMs = dependencies.monotonicMs();
    remoteAttempted = true;
    const raw = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(inputsBefore.admission), TARGET_HOST, packed.command],
      Buffer.alloc(0),
      TIMEOUT_MS,
    );
    const elapsedMs = Math.max(0, Math.round(dependencies.monotonicMs() - startedMs));
    remoteProcess = processEvidence(raw);
    const parsed = parseHandleStartDiagnosticOutput(raw.stdout);
    observation = validHandleStartDiagnosticOutput(parsed, plan) ? parsed : null;
    writeEvidence(absolute, "stdout.raw", raw.stdout);
    writeEvidence(absolute, "stderr.raw", raw.stderr);
    writeEvidence(absolute, "remote-process.json", JSON.stringify(remoteProcess, null, 2) + "\n");
    validateHandleStartDiagnosticSources(config, dependencies);
    const inputsAfter = loadHandleStartDiagnosticInputs(config);
    const consumedRootAfter = captureConsumedEvidenceRoot(config.consumed_evidence_root);
    const afterPlan = deriveHandleStartDiagnosticPlan(
      config,
      inputsAfter.admission,
      inputsAfter.cleanupPlan,
      consumedRootAfter,
    );
    const transportAfter = captureHandleStartDiagnosticTransportInputs(inputsBefore.admission, "network");
    if (canonicalJson(inputsBefore.facts) !== canonicalJson(inputsAfter.facts)
      || afterPlan.plan_sha256 !== plan.plan_sha256
      || canonicalJson(transportBefore) !== canonicalJson(transportAfter)) {
      diagnosticFail("M4F_DIRECT_HANDLE_START_DIAGNOSTIC_LOCAL_INPUT_DRIFT", "network");
    }
    const observed = raw.status === 0 && raw.signal === null && raw.errorCode === null
      && raw.stderr.length === 0 && observation !== null;
    const record: HandleStartDiagnosticRecord = {
      schema: "synthia-m4f-direct-handle-start-diagnostic-record.v1",
      diagnostic_id: config.diagnostic_id,
      status: observed ? "observed" : "unknown",
      action: "observe_handle_start_ticks_read_only",
      plan_sha256: plan.plan_sha256,
      cleanup_plan_sha256: plan.cleanup_plan_sha256,
      confirmation_sha256: sha256(confirmation),
      attempt: 1,
      timeout_ms: TIMEOUT_MS,
      recorded_at_utc: dependencies.now().toISOString(),
      elapsed_ms: elapsedMs,
      observation,
      process: remoteProcess,
      transport_inputs_before: transportBefore,
      transport_inputs_after: transportAfter,
      bound_files_before: inputsBefore.facts,
      bound_files_after: inputsAfter.facts,
      process_termination_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
      retry_permitted: false,
    };
    writeEvidence(absolute, "diagnostic-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    const originalDetail = error instanceof HandleStartDiagnosticFailure ? error.detail : {
      schema: "synthia-m4f-direct-handle-start-diagnostic-failure.v1",
      code: "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_UNEXPECTED",
      stage: "unknown",
      retry_permitted: false,
    };
    const detail = {
      ...originalDetail,
      remote_effect_state: remoteAttempted ? "read_only_attempted" : "not_started",
    };
    try {
      writeEvidence(absolute, "diagnostic-failure.json", JSON.stringify({
        ...detail,
        diagnostic_id: config.diagnostic_id,
        plan_sha256: plan.plan_sha256,
        remote_process: remoteProcess,
        observation,
        process_termination_performed: false,
        file_mutation_performed: false,
        vivado_action_performed: false,
        hardware_action_performed: false,
        retry_permitted: false,
      }, null, 2) + "\n");
    } catch {
      // Preserve the original failure and every immutable evidence file already written.
    }
    throw new HandleStartDiagnosticFailure(detail);
  }
}

export function executeResidueCleanup(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: CleanupDependencies = systemDependencies,
): ResidueCleanupRecord {
  const config = validateResidueCleanupConfig(rawConfig);
  if (config.schema !== "synthia-m4f-direct-residue-cleanup-config.v2") {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_HANDLE_START_RECORD_REQUIRED", "config", {
      required_schema: "synthia-m4f-direct-residue-cleanup-config.v2",
    });
  }
  validateSources(config, dependencies);
  const inputsBefore = loadPlanInputs(config);
  const plan = deriveLoadedResidueCleanupPlan(config, inputsBefore);
  assertResidueCleanupConfirmation(plan, confirmation);
  const packed = buildResidueCleanupRemoteCommand(plan);
  const transportBefore = captureM4fDirectTransportInputs(inputsBefore.admission);
  const absolute = resolve(evidenceDirectory);
  try {
    makeDirectory(absolute);
  } catch {
    fail("M4F_DIRECT_RESIDUE_CLEANUP_EVIDENCE_DIRECTORY_INVALID", "local_preflight");
  }
  let remoteProcess: CleanupProcessEvidence | null = null;
  let remoteAttempted = false;
  let remoteMarkerPrefix: CleanupMarkerPrefix = {
    markers: [],
    trailing_fragment_length: 0,
    trailing_fragment_sha256: sha256(Buffer.alloc(0)),
    stdout_truncated_line: false,
  };
  let remoteEffects: CleanupEffectClassification = {
    attribution_valid: true,
    explicit_no_effect: false,
    kill_performed_pids: [],
    already_exited_pids: [],
    resolved_target_pids: [],
  };
  try {
    writeEvidence(absolute, "cleanup-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "cleanup-plan.json", JSON.stringify(plan, null, 2) + "\n");
    writeEvidence(absolute, "remote-script.ps1", packed.script);
    writeEvidence(absolute, "remote-loader.ps1", packed.loader);
    writeEvidence(absolute, "remote-payload.gzip", packed.compressed);
    const effective = dependencies.spawn(
      SSH_PATH,
      buildDirectSshEffectiveArguments(inputsBefore.admission),
      Buffer.alloc(0),
      15_000,
    );
    const effectiveFact = processEvidence(effective);
    writeEvidence(absolute, "ssh-effective.stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective.stderr.raw", effective.stderr);
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(effectiveFact, null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0 || sha256(effective.stdout) !== config.expected_effective_config_sha256) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_EFFECTIVE_CONFIG_FAILED", "local_preflight");
    }
    try {
      auditDirectSshEffectiveConfig(effective.stdout, inputsBefore.admission);
    } catch {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_EFFECTIVE_CONFIG_MISMATCH", "local_preflight");
    }
    validateSources(config, dependencies);
    const inputsCurrent = loadPlanInputs(config);
    const currentPlan = deriveLoadedResidueCleanupPlan(config, inputsCurrent);
    const transportCurrent = captureM4fDirectTransportInputs(inputsBefore.admission, "network");
    if (canonicalJson(inputsBefore.facts) !== canonicalJson(inputsCurrent.facts)
      || currentPlan.plan_sha256 !== plan.plan_sha256
      || canonicalJson(transportBefore) !== canonicalJson(transportCurrent)) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_LOCAL_INPUT_DRIFT", "network");
    }
    const startedMs = dependencies.monotonicMs();
    remoteAttempted = true;
    const raw = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(inputsBefore.admission), TARGET_HOST, packed.command],
      Buffer.alloc(0),
      TIMEOUT_MS,
    );
    const elapsedMs = Math.max(0, Math.round(dependencies.monotonicMs() - startedMs));
    remoteProcess = processEvidence(raw);
    remoteMarkerPrefix = parseCleanupMarkerPrefix(raw.stdout);
    remoteEffects = remoteMarkerPrefix.markers === null
      ? {
        attribution_valid: false,
        explicit_no_effect: false,
        kill_performed_pids: [],
        already_exited_pids: [],
        resolved_target_pids: [],
      }
      : classifyPartialCleanupEffects(remoteMarkerPrefix.markers, plan);
    writeEvidence(absolute, "stdout.raw", raw.stdout);
    writeEvidence(absolute, "stderr.raw", raw.stderr);
    writeEvidence(absolute, "remote-process.json", JSON.stringify(remoteProcess, null, 2) + "\n");
    validateSources(config, dependencies);
    const inputsAfter = loadPlanInputs(config);
    const afterPlan = deriveLoadedResidueCleanupPlan(config, inputsAfter);
    const transportAfter = captureM4fDirectTransportInputs(inputsBefore.admission, "network");
    if (canonicalJson(inputsBefore.facts) !== canonicalJson(inputsAfter.facts)
      || afterPlan.plan_sha256 !== plan.plan_sha256
      || canonicalJson(transportBefore) !== canonicalJson(transportAfter)) {
      fail("M4F_DIRECT_RESIDUE_CLEANUP_LOCAL_INPUT_DRIFT", "network");
    }
    const markers = remoteMarkerPrefix.markers ?? [];
    const complete = raw.status === 0 && raw.signal === null && raw.errorCode === null
      && raw.stderr.length === 0 && remoteMarkerPrefix.trailing_fragment_length === 0
      && validCleanupOutput(markers, plan);
    const record: ResidueCleanupRecord = {
      schema: "synthia-m4f-direct-residue-cleanup-record.v1",
      ceremony_id: config.ceremony_id,
      status: complete ? "completed" : "unknown",
      action: "resolve_exact_diagnostic_residue",
      plan_sha256: plan.plan_sha256,
      confirmation_sha256: sha256(confirmation),
      attempt: 1,
      timeout_ms: TIMEOUT_MS,
      recorded_at_utc: dependencies.now().toISOString(),
      elapsed_ms: elapsedMs,
      markers,
      trailing_fragment_length: remoteMarkerPrefix.trailing_fragment_length,
      trailing_fragment_sha256: remoteMarkerPrefix.trailing_fragment_sha256,
      stdout_truncated_line: remoteMarkerPrefix.stdout_truncated_line,
      process: remoteProcess,
      transport_inputs_before: transportBefore,
      transport_inputs_after: transportAfter,
      bound_files_before: inputsBefore.facts,
      bound_files_after: inputsAfter.facts,
      process_termination_state: complete
        ? "performed"
        : remoteEffects.explicit_no_effect ? "not_performed" : "unknown",
      kill_performed_pids: remoteEffects.attribution_valid
        ? remoteEffects.kill_performed_pids
        : [],
      already_exited_pids: remoteEffects.attribution_valid
        ? remoteEffects.already_exited_pids
        : [],
      resolved_target_pids: remoteEffects.attribution_valid
        ? remoteEffects.resolved_target_pids
        : [],
      hardware_action_performed: false,
      retry_permitted: false,
    };
    writeEvidence(absolute, "cleanup-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    const originalDetail = error instanceof ResidueCleanupFailure ? error.detail : {
      schema: "synthia-m4f-direct-residue-cleanup-failure.v1",
      code: "M4F_DIRECT_RESIDUE_CLEANUP_UNEXPECTED",
      stage: "unknown",
      retry_permitted: false,
    };
    const detail = {
      ...originalDetail,
      remote_effect_state: remoteAttempted ? "partial_or_unknown" : "not_started",
    };
    try {
      writeEvidence(absolute, "cleanup-failure.json", JSON.stringify({
        ...detail,
        ceremony_id: config.ceremony_id,
        plan_sha256: plan.plan_sha256,
        remote_process: remoteProcess,
        markers: remoteMarkerPrefix.markers ?? [],
        marker_parse_valid: remoteMarkerPrefix.markers !== null,
        trailing_fragment_length: remoteMarkerPrefix.trailing_fragment_length,
        trailing_fragment_sha256: remoteMarkerPrefix.trailing_fragment_sha256,
        stdout_truncated_line: remoteMarkerPrefix.stdout_truncated_line,
        effect_attribution_valid: remoteEffects.attribution_valid,
        kill_performed_pids: remoteEffects.attribution_valid
          ? remoteEffects.kill_performed_pids
          : [],
        already_exited_pids: remoteEffects.attribution_valid
          ? remoteEffects.already_exited_pids
          : [],
        resolved_target_pids: remoteEffects.attribution_valid
          ? remoteEffects.resolved_target_pids
          : [],
        process_termination_state: remoteAttempted ? "unknown" : "not_performed",
        hardware_action_performed: false,
      }, null, 2) + "\n");
    } catch {
      // Preserve the original failure and any immutable evidence already written.
    }
    throw new ResidueCleanupFailure(detail);
  }
}

export function spawnBoundedCleanupProcess(
  executable: string,
  args: readonly string[],
  stdin: Buffer,
  timeoutMs: number,
): RawProcessResult {
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
}

const systemDependencies: CleanupDependencies = {
  spawn: spawnBoundedCleanupProcess,
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length === 3 && args[0] === "--plan" && args[1] === "--config") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(planResidueCleanup(raw), null, 2) + "\n");
      return;
    }
    if (args.length === 3 && args[0] === "--plan-handle-start-diagnostic"
      && args[1] === "--config") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(planHandleStartDiagnostic(raw), null, 2) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-cleanup" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(executeResidueCleanup(raw, args[4]!, args[6]!), null, 2) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-handle-start-diagnostic"
      && args[1] === "--config" && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(
        executeHandleStartDiagnostic(raw, args[4]!, args[6]!),
        null,
        2,
      ) + "\n");
      return;
    }
    console.error(`usage: bun ${basename(import.meta.path)} --plan --config <config.json>`);
    console.error(`   or: bun ${basename(import.meta.path)} --execute-cleanup --config <config.json> --confirmation <exact> --evidence <new-directory>`);
    console.error(`   or: bun ${basename(import.meta.path)} --plan-handle-start-diagnostic --config <config.json>`);
    console.error(`   or: bun ${basename(import.meta.path)} --execute-handle-start-diagnostic --config <config.json> --confirmation <exact> --evidence <new-directory>`);
    process.exitCode = 64;
  } catch (error) {
    const diagnosticMode = args[0] === "--plan-handle-start-diagnostic"
      || args[0] === "--execute-handle-start-diagnostic";
    const detail = error instanceof ResidueCleanupFailure || error instanceof HandleStartDiagnosticFailure
      ? error.detail : {
      schema: diagnosticMode
        ? "synthia-m4f-direct-handle-start-diagnostic-failure.v1"
        : "synthia-m4f-direct-residue-cleanup-failure.v1",
      code: diagnosticMode
        ? "M4F_DIRECT_HANDLE_START_DIAGNOSTIC_UNEXPECTED"
        : "M4F_DIRECT_RESIDUE_CLEANUP_UNEXPECTED",
      stage: "unknown",
      remote_effect_state: "unknown",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();

export const M4F_DIRECT_RESIDUE_CLEANUP_GUARDS = {
  targetHost: TARGET_HOST,
  exactTargetCount: EXPECTED_TARGET_COUNT,
  allowedTargetNames: TARGET_NAMES,
  permanentlyRetiredCeremonyIds: PERMANENTLY_RETIRED_CEREMONY_IDS,
  spawnLagMs: SPAWN_LAG_MS,
  windowsCimTicksPerMicrosecond: WINDOWS_CIM_TICKS_PER_MICROSECOND,
  handleStartDiagnosticMaximumRemoteAttempts: 1,
  permanentlyRetiredHandleStartDiagnosticIds: PERMANENTLY_RETIRED_HANDLE_START_DIAGNOSTIC_IDS,
  handleStartDiagnosticProcessTerminationPermitted: false,
  handleStartDiagnosticFileMutationPermitted: false,
  timeoutMs: TIMEOUT_MS,
  maximumRemoteAttempts: 1,
  remoteCommandLimit: REMOTE_COMMAND_LIMIT,
  windowsCommandLimit: WINDOWS_COMMAND_LIMIT,
  emptyStdin: true,
  normalSshdTerminationPermitted: false,
  nodeTerminationPermitted: false,
  serviceMutationPermitted: false,
  fileMutationPermitted: false,
  vivadoPermitted: false,
  hardwareActionPermitted: false,
} as const;
