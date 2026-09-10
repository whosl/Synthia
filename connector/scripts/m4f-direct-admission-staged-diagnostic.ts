import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
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
  type LocalInputFact,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
  validateM4fDirectAdmissionConfig,
} from "./m4f-gate-admission-transport.ts";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const STAGE_TIMEOUT_MS = 60_000;
const MAX_STAGE_COUNT = 23;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export interface M4fDirectStagedDiagnosticConfig {
  schema: "synthia-m4f-direct-staged-diagnostic-config.v1";
  diagnostic_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface StagedDiagnosticDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  now(): Date;
  monotonicMs(): number;
}

export type DiagnosticStageKind =
  | "wrapper_smoke"
  | "identity"
  | "volumes"
  | "acl"
  | "listeners"
  | "processes"
  | "vivado_fact"
  | "bun_fact";

export interface DiagnosticStage {
  stage_id: string;
  kind: DiagnosticStageKind;
  acl_path: string | null;
}

export interface DiagnosticProcessEvidence {
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

export interface DiagnosticStageRecord {
  schema: "synthia-m4f-direct-staged-diagnostic-stage-record.v1";
  diagnostic_id: string;
  stage_id: string;
  kind: DiagnosticStageKind;
  ordinal: number;
  attempt: 1;
  action: "read_only";
  status: "observed" | "unknown";
  output_valid: boolean;
  retry_permitted: false;
  started_at_utc: string;
  finished_at_utc: string;
  elapsed_ms: number;
  script_length: number;
  script_sha256: string;
  wrapper_length: number;
  wrapper_sha256: string;
  remote_command_length: number;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  process: DiagnosticProcessEvidence;
}

export interface DiagnosticAdmissionConfigFact {
  schema: "synthia-m4f-direct-staged-diagnostic-admission-config-fact.v1";
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

export interface StagedDiagnosticRecord {
  schema: "synthia-m4f-direct-staged-diagnostic-record.v1";
  diagnostic_id: string;
  status: "completed" | "completed_with_unknown";
  action: "read_only_staged_diagnostic";
  retry_permitted: false;
  recorded_at_utc: string;
  config_sha256: string;
  admission_config_sha256: string;
  source_sha256: string;
  transport_source_sha256: string;
  effective_config_sha256: string;
  stage_timeout_ms: 60000;
  maximum_remote_elapsed_ms: number;
  continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry";
  planned_stage_count: number;
  attempted_stage_count: number;
  observed_stage_count: number;
  unknown_stage_count: number;
  stage_records: DiagnosticStageRecord[];
  admission_config_before: DiagnosticAdmissionConfigFact;
  admission_config_after: DiagnosticAdmissionConfigFact;
  hardware_action_performed: false;
}

export class StagedDiagnosticFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_DIRECT_STAGED_DIAGNOSTIC_FAILED"));
  }
}

const CONFIG_KEYS = [
  "admission_config_path",
  "admission_config_sha256",
  "diagnostic_id",
  "expected_effective_config_sha256",
  "expected_source_sha256",
  "expected_transport_source_sha256",
  "schema",
] as const;
const STAGE_OUTPUT_KEYS = ["hardware_action_performed", "identity", "observed_at_utc", "payload", "schema", "stage_id"] as const;
const IDENTITY_KEYS = ["computer_name", "identity_name", "identity_sid"] as const;
const VOLUME_KEYS = ["device_id", "drive_type", "file_system", "free_bytes", "size_bytes"] as const;
const ACL_KEYS = ["exists", "owner_sid", "path", "protected", "reparse", "rules"] as const;
const ACL_RULE_KEYS = ["inheritance", "inherited", "propagation", "rights", "sid", "type"] as const;
const LISTENER_KEYS = ["address", "pid", "port"] as const;
const PROCESS_KEYS = ["creation_date", "executable_path", "name", "parent_pid", "pid"] as const;
const FILE_KEYS = ["exists", "file_version", "length", "path", "sha256"] as const;
const SID = /^S-1-(?:[0-9]+-){1,14}[0-9]+$/u;
const WINDOWS_PATH = /^[A-Za-z]:\\[^\r\n]*$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u;
const INHERITANCE_VALUES = new Set([
  "None",
  "ContainerInherit",
  "ObjectInherit",
  "ContainerInherit, ObjectInherit",
  "ObjectInherit, ContainerInherit",
]);
const PROPAGATION_VALUES = new Set([
  "None",
  "NoPropagateInherit",
  "InheritOnly",
  "NoPropagateInherit, InheritOnly",
  "InheritOnly, NoPropagateInherit",
]);

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
  throw new StagedDiagnosticFailure({
    schema: "synthia-m4f-direct-staged-diagnostic-failure.v1",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight" ? "not_started" : "read_only_unknown",
    retry_permitted: false,
    ...extra,
  });
}

function safeLocalPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

export function validateStagedDiagnosticConfig(value: unknown): M4fDirectStagedDiagnosticConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-staged-diagnostic-config.v1"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !safeLocalPath(config.admission_config_path)
    || typeof config.admission_config_sha256 !== "string"
    || !HASH.test(config.admission_config_sha256)
    || typeof config.expected_source_sha256 !== "string"
    || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_transport_source_sha256 !== "string"
    || !HASH.test(config.expected_transport_source_sha256)
    || typeof config.expected_effective_config_sha256 !== "string"
    || !HASH.test(config.expected_effective_config_sha256)) {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_CONFIG_INVALID", "config");
  }
  return value as M4fDirectStagedDiagnosticConfig;
}

function validateDiagnosticSource(
  config: M4fDirectStagedDiagnosticConfig,
  bytes: Buffer,
): string {
  const sourceHash = sha256(bytes);
  if (bytes.length < 1 || bytes.length > MAX_STREAM_BYTES
    || sourceHash !== config.expected_source_sha256) {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_SOURCE_MISMATCH", "local_preflight");
  }
  return sourceHash;
}

function validateTransportSource(
  config: M4fDirectStagedDiagnosticConfig,
  bytes: Buffer,
): string {
  const sourceHash = sha256(bytes);
  if (bytes.length < 1 || bytes.length > MAX_STREAM_BYTES
    || sourceHash !== config.expected_transport_source_sha256) {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_SOURCE_MISMATCH", "local_preflight");
  }
  return sourceHash;
}

function readBoundAdmissionConfig(config: M4fDirectStagedDiagnosticConfig): {
  admission: M4fDirectAdmissionConfig;
  fact: DiagnosticAdmissionConfigFact;
} {
  let stat;
  let bytes: Buffer;
  let fd: number | null = null;
  try {
    const pathBefore = lstatSync(config.admission_config_path);
    fd = openSync(config.admission_config_path, "r");
    const handleBefore = fstatSync(fd);
    bytes = readFileSync(fd);
    const handleAfter = fstatSync(fd);
    const pathAfter = lstatSync(config.admission_config_path);
    if (pathBefore.isSymbolicLink()
      || pathBefore.dev !== handleBefore.dev || pathBefore.ino !== handleBefore.ino
      || handleBefore.dev !== handleAfter.dev || handleBefore.ino !== handleAfter.ino
      || handleBefore.size !== handleAfter.size || handleBefore.mtimeMs !== handleAfter.mtimeMs
      || handleBefore.ctimeMs !== handleAfter.ctimeMs
      || handleAfter.dev !== pathAfter.dev || handleAfter.ino !== pathAfter.ino) {
      fail("M4F_DIRECT_STAGED_DIAGNOSTIC_ADMISSION_CONFIG_UNTRUSTED", "local_preflight");
    }
    stat = handleAfter;
  } catch (error) {
    if (error instanceof StagedDiagnosticFailure) throw error;
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_ADMISSION_CONFIG_UNAVAILABLE", "local_preflight");
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || bytes.length < 1 || bytes.length > MAX_STREAM_BYTES
    || sha256(bytes) !== config.admission_config_sha256) {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_ADMISSION_CONFIG_UNTRUSTED", "local_preflight");
  }
  try {
    const admission = validateM4fDirectAdmissionConfig(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ));
    return {
      admission,
      fact: {
        schema: "synthia-m4f-direct-staged-diagnostic-admission-config-fact.v1",
        path: config.admission_config_path,
        device: stat.dev,
        inode: stat.ino,
        owner_uid: stat.uid,
        mode: 0o600,
        link_count: 1,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        sha256: sha256(bytes),
      },
    };
  } catch {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_ADMISSION_CONFIG_INVALID", "local_preflight");
  }
}

export function buildDiagnosticStages(admission: M4fDirectAdmissionConfig): DiagnosticStage[] {
  const stages: DiagnosticStage[] = [
    { stage_id: "wrapper-smoke", kind: "wrapper_smoke", acl_path: null },
    { stage_id: "identity", kind: "identity", acl_path: null },
    { stage_id: "volumes", kind: "volumes", acl_path: null },
    ...admission.target.acl_paths.map((path, index) => ({
      stage_id: "acl-" + String(index + 1).padStart(2, "0"),
      kind: "acl" as const,
      acl_path: path,
    })),
    { stage_id: "listeners", kind: "listeners", acl_path: null },
    { stage_id: "processes", kind: "processes", acl_path: null },
    { stage_id: "vivado-fact", kind: "vivado_fact", acl_path: null },
    { stage_id: "bun-fact", kind: "bun_fact", acl_path: null },
  ];
  if (stages.length > MAX_STAGE_COUNT) {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_STAGE_COUNT_INVALID", "local_preflight");
  }
  return stages;
}

function psPayload(stage: DiagnosticStage, admission: M4fDirectAdmissionConfig): string {
  return Buffer.from(JSON.stringify({
    stageId: stage.stage_id,
    expectedComputer: admission.target.computer_name,
    expectedIdentityName: admission.target.identity_name,
    expectedIdentitySid: admission.target.identity_sid,
    aclPath: stage.acl_path,
    vivadoPath: admission.target.vivado_executable,
    bunPath: admission.target.bun_executable,
  }), "utf8").toString("base64");
}

export function buildDiagnosticStageScript(
  stage: DiagnosticStage,
  admission: M4fDirectAdmissionConfig,
): string {
  const prefix = [
    "$ErrorActionPreference=\"Stop\"",
    "$ProgressPreference=\"SilentlyContinue\"",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    "$cfg=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\"" + psPayload(stage, admission) + "\"))|ConvertFrom-Json)",
  ];
  const identityPrefix = stage.kind === "wrapper_smoke"
    ? ["$identityFact=$null"]
    : [
      "$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $identityName=$identity.Name.ToLowerInvariant()",
      "if($env:COMPUTERNAME -cne $cfg.expectedComputer -or $identityName -cne $cfg.expectedIdentityName -or $identity.User.Value -cne $cfg.expectedIdentitySid){throw \"M4F_DIRECT_DIAGNOSTIC_IDENTITY_MISMATCH\"}",
      "$identityFact=[ordered]@{computer_name=$env:COMPUTERNAME;identity_name=$identityName;identity_sid=$identity.User.Value}",
    ];
  const body: Record<DiagnosticStageKind, string[]> = {
    wrapper_smoke: ["$payload=[ordered]@{wrapper=\"ok\"}"],
    identity: ["$payload=[ordered]@{identity=$identityFact}"],
    volumes: [
      "$facts=@(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:' OR DeviceID='D:'\"|Sort-Object DeviceID|ForEach-Object{[ordered]@{device_id=$_.DeviceID;drive_type=[int]$_.DriveType;free_bytes=[int64]$_.FreeSpace;size_bytes=[int64]$_.Size;file_system=$_.FileSystem}})",
      "$payload=[ordered]@{volumes=$facts}",
    ],
    acl: [
      "$path=[string]$cfg.aclPath; if(-not(Test-Path -LiteralPath $path)){ $fact=[ordered]@{path=$path;exists=$false;owner_sid=$null;protected=$null;reparse=$null;rules=@()} } else { $item=Get-Item -LiteralPath $path -Force; $acl=Get-Acl -LiteralPath $path; $owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value; $rules=@($acl.Access|ForEach-Object{$sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;[ordered]@{sid=$sid;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inherited=[bool]$_.IsInherited;inheritance=$_.InheritanceFlags.ToString();propagation=$_.PropagationFlags.ToString()}}|Sort-Object sid,type,rights,inherited,inheritance,propagation); $fact=[ordered]@{path=$path;exists=$true;owner_sid=$owner;protected=[bool]$acl.AreAccessRulesProtected;reparse=[bool](($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0);rules=$rules} }",
      "$payload=[ordered]@{acl=$fact}",
    ],
    listeners: [
      "$facts=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -eq 8443 -or $_.LocalPort -eq 18443}|Sort-Object LocalPort,OwningProcess|ForEach-Object{[ordered]@{address=$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess}})",
      "$payload=[ordered]@{listeners=$facts}",
    ],
    processes: [
      "$names=@(\"bun.exe\",\"node.exe\",\"vivado.exe\",\"vivado_lab.exe\",\"hw_server.exe\")",
      "$facts=@(Get-CimInstance Win32_Process|Where-Object{$names -ccontains $_.Name}|Sort-Object ProcessId|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;name=$_.Name;executable_path=$_.ExecutablePath;creation_date=if($null-ne$_.CreationDate){([DateTime]$_.CreationDate).ToUniversalTime().ToString(\"o\")}else{$null}}})",
      "$payload=[ordered]@{processes=$facts}",
    ],
    vivado_fact: [
      "$path=[string]$cfg.vivadoPath; if(-not[IO.File]::Exists($path)){$fact=[ordered]@{path=$path;exists=$false;length=$null;sha256=$null;file_version=$null}}else{$item=Get-Item -LiteralPath $path -Force;$fact=[ordered]@{path=$path;exists=$true;length=[int64]$item.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();file_version=$item.VersionInfo.FileVersion}}",
      "$payload=[ordered]@{vivado=$fact}",
    ],
    bun_fact: [
      "$path=[string]$cfg.bunPath; if(-not[IO.File]::Exists($path)){$fact=[ordered]@{path=$path;exists=$false;length=$null;sha256=$null;file_version=$null}}else{$item=Get-Item -LiteralPath $path -Force;$fact=[ordered]@{path=$path;exists=$true;length=[int64]$item.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();file_version=$item.VersionInfo.FileVersion}}",
      "$payload=[ordered]@{bun=$fact}",
    ],
  };
  return [
    ...prefix,
    ...identityPrefix,
    ...body[stage.kind],
    "$result=[ordered]@{schema=\"synthia-m4f-direct-staged-diagnostic-stage-result.v1\";stage_id=$cfg.stageId;observed_at_utc=[DateTime]::UtcNow.ToString(\"o\");identity=$identityFact;payload=$payload;hardware_action_performed=$false}",
    "$result|ConvertTo-Json -Compress -Depth 12",
    "",
  ].join("\n");
}

function processEvidence(raw: RawProcessResult, stdin: Buffer): DiagnosticProcessEvidence {
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

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" && UTC_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

function validIdentity(value: unknown, admission: M4fDirectAdmissionConfig): boolean {
  const identity = object(value);
  return !!identity && exactKeys(identity, IDENTITY_KEYS)
    && identity.computer_name === admission.target.computer_name
    && identity.identity_name === admission.target.identity_name
    && identity.identity_sid === admission.target.identity_sid;
}

function validVolumes(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const devices = new Set<string>();
  for (const item of value) {
    const fact = object(item);
    if (!fact || !exactKeys(fact, VOLUME_KEYS)
      || (fact.device_id !== "C:" && fact.device_id !== "D:")
      || fact.drive_type !== 3 || !safeInteger(fact.free_bytes)
      || !safeInteger(fact.size_bytes, 1) || fact.free_bytes > fact.size_bytes
      || fact.file_system !== "NTFS") return false;
    devices.add(fact.device_id);
  }
  return devices.size === 2;
}

function validAcl(value: unknown, expectedPath: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, ACL_KEYS) || fact.path !== expectedPath
    || typeof fact.exists !== "boolean" || !Array.isArray(fact.rules)) return false;
  if (!fact.exists) {
    return fact.owner_sid === null && fact.protected === null && fact.reparse === null
      && fact.rules.length === 0;
  }
  if (typeof fact.owner_sid !== "string" || !SID.test(fact.owner_sid)
    || typeof fact.protected !== "boolean" || typeof fact.reparse !== "boolean") return false;
  return fact.rules.every((item) => {
    const rule = object(item);
    return !!rule && exactKeys(rule, ACL_RULE_KEYS)
      && typeof rule.sid === "string" && SID.test(rule.sid)
      && (rule.type === "Allow" || rule.type === "Deny")
      && safeInteger(rule.rights) && typeof rule.inherited === "boolean"
      && typeof rule.inheritance === "string" && INHERITANCE_VALUES.has(rule.inheritance)
      && typeof rule.propagation === "string" && PROPAGATION_VALUES.has(rule.propagation);
  });
}

function validListeners(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    const fact = object(item);
    return !!fact && exactKeys(fact, LISTENER_KEYS)
      && typeof fact.address === "string" && isIP(fact.address) !== 0
      && (fact.port === 8443 || fact.port === 18443) && safeInteger(fact.pid, 1);
  });
}

function validProcesses(value: unknown): boolean {
  const names = ["bun.exe", "node.exe", "vivado.exe", "vivado_lab.exe", "hw_server.exe"];
  return Array.isArray(value) && value.every((item) => {
    const fact = object(item);
    return !!fact && exactKeys(fact, PROCESS_KEYS)
      && safeInteger(fact.pid, 1) && safeInteger(fact.parent_pid)
      && typeof fact.name === "string" && names.includes(fact.name.toLowerCase())
      && (fact.executable_path === null
        || (typeof fact.executable_path === "string" && WINDOWS_PATH.test(fact.executable_path)))
      && (fact.creation_date === null
        || utcTimestamp(fact.creation_date));
  });
}

function validFileFact(value: unknown, expectedPath: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, FILE_KEYS) || fact.path !== expectedPath
    || typeof fact.exists !== "boolean") return false;
  if (!fact.exists) {
    return fact.length === null && fact.sha256 === null && fact.file_version === null;
  }
  return safeInteger(fact.length)
    && typeof fact.sha256 === "string" && HASH.test(fact.sha256)
    && (fact.file_version === null || typeof fact.file_version === "string");
}

function parseStageOutput(
  raw: Buffer,
  stage: DiagnosticStage,
  admission: M4fDirectAdmissionConfig,
): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) return false;
  try {
    const value = object(JSON.parse(lines[0]!));
    const payload = object(value?.payload);
    if (!value || !exactKeys(value, STAGE_OUTPUT_KEYS)
      || value.schema !== "synthia-m4f-direct-staged-diagnostic-stage-result.v1"
      || value.stage_id !== stage.stage_id || value.hardware_action_performed !== false
      || !utcTimestamp(value.observed_at_utc)
      || (stage.kind === "wrapper_smoke"
        ? value.identity !== null
        : !validIdentity(value.identity, admission))
      || !payload) return false;
    const expectedPayloadKey: Record<DiagnosticStageKind, string> = {
      wrapper_smoke: "wrapper",
      identity: "identity",
      volumes: "volumes",
      acl: "acl",
      listeners: "listeners",
      processes: "processes",
      vivado_fact: "vivado",
      bun_fact: "bun",
    };
    if (!exactKeys(payload, [expectedPayloadKey[stage.kind]])) return false;
    if (stage.kind === "wrapper_smoke") return payload.wrapper === "ok";
    if (stage.kind === "identity") return validIdentity(payload.identity, admission);
    if (stage.kind === "volumes") return validVolumes(payload.volumes);
    if (stage.kind === "acl") return validAcl(payload.acl, stage.acl_path!);
    if (stage.kind === "listeners") return validListeners(payload.listeners);
    if (stage.kind === "processes") return validProcesses(payload.processes);
    if (stage.kind === "vivado_fact") {
      return validFileFact(payload.vivado, admission.target.vivado_executable);
    }
    return validFileFact(payload.bun, admission.target.bun_executable);
  } catch {
    return false;
  }
}

export function stagedDiagnosticConfirmation(rawConfig: unknown): string {
  const config = validateStagedDiagnosticConfig(rawConfig);
  const configHash = sha256(Buffer.from(canonicalJson(config) + "\n", "utf8"));
  return "SYNTHIA_M4F_DIRECT_STAGED_READ_ONLY:" + config.diagnostic_id + ":" + configHash;
}

export function planStagedDiagnostic(
  rawConfig: unknown,
  dependencies: Pick<
    StagedDiagnosticDependencies,
    "sourceBytes" | "transportSourceBytes"
  > = systemDependencies,
): Record<string, unknown> {
  const config = validateStagedDiagnosticConfig(rawConfig);
  const sourceHash = validateDiagnosticSource(config, dependencies.sourceBytes());
  const transportSourceHash = validateTransportSource(config, dependencies.transportSourceBytes());
  const bound = readBoundAdmissionConfig(config);
  const admission = bound.admission;
  const stages = buildDiagnosticStages(admission);
  return {
    schema: "synthia-m4f-direct-staged-diagnostic-plan.v1",
    status: "planned_not_executed",
    diagnostic_id: config.diagnostic_id,
    target_host: admission.target.host,
    target_user: admission.target.user,
    target_computer: admission.target.computer_name,
    target_identity_name: admission.target.identity_name,
    target_identity_sid: admission.target.identity_sid,
    stage_timeout_ms: STAGE_TIMEOUT_MS,
    stage_count: stages.length,
    maximum_remote_elapsed_ms: stages.length * STAGE_TIMEOUT_MS,
    continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry",
    source_sha256: sourceHash,
    transport_source_sha256: transportSourceHash,
    expected_effective_config_sha256: config.expected_effective_config_sha256,
    admission_config_fact: bound.fact,
    stages,
    confirmation: stagedDiagnosticConfirmation(config),
    retry_per_stage: false,
    network_attempted: false,
    hardware_action_performed: false,
  };
}

function makeDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: false });
  chmodSync(path, 0o700);
}

function writeEvidence(directory: string, name: string, content: string | Buffer): void {
  const path = directory + "/" + name;
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function recordStagedDiagnostic(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: StagedDiagnosticDependencies = systemDependencies,
): StagedDiagnosticRecord {
  const config = validateStagedDiagnosticConfig(rawConfig);
  if (confirmation !== stagedDiagnosticConfirmation(config)) {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_CONFIRMATION_REQUIRED", "local_preflight");
  }
  const sourceBefore = dependencies.sourceBytes();
  validateDiagnosticSource(config, sourceBefore);
  const transportSourceBefore = dependencies.transportSourceBytes();
  const transportSourceHash = validateTransportSource(config, transportSourceBefore);
  const admissionBoundBefore = readBoundAdmissionConfig(config);
  const admission = admissionBoundBefore.admission;
  const stages = buildDiagnosticStages(admission);
  const initialInputs = captureM4fDirectTransportInputs(admission);
  const absolute = resolve(evidenceDirectory);
  try {
    makeDirectory(absolute);
  } catch {
    fail("M4F_DIRECT_STAGED_DIAGNOSTIC_EVIDENCE_DIRECTORY_INVALID", "local_preflight");
  }
  const stageRecords: DiagnosticStageRecord[] = [];
  let attemptedStageCount = 0;
  let currentStageId: string | null = null;
  let currentStageProcess: DiagnosticProcessEvidence | null = null;
  try {
    writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "stage-plan.json", JSON.stringify(stages, null, 2) + "\n");
    writeEvidence(absolute, "powershell-stdin-wrapper.ps1", M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);

    const effective = dependencies.spawn(
      SSH_PATH,
      buildDirectSshEffectiveArguments(admission),
      Buffer.alloc(0),
      15_000,
    );
    writeEvidence(absolute, "ssh-effective.stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective.stderr.raw", effective.stderr);
    const effectiveProcess = processEvidence(effective, Buffer.alloc(0));
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(effectiveProcess, null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0) {
      fail("M4F_DIRECT_STAGED_DIAGNOSTIC_EFFECTIVE_CONFIG_FAILED", "local_preflight", {
        process: effectiveProcess,
      });
    }
    const effectiveHash = sha256(effective.stdout);
    if (effectiveHash !== config.expected_effective_config_sha256) {
      fail("M4F_DIRECT_STAGED_DIAGNOSTIC_EFFECTIVE_CONFIG_HASH_MISMATCH", "local_preflight", {
        expected_effective_config_sha256: config.expected_effective_config_sha256,
        observed_effective_config_sha256: effectiveHash,
      });
    }
    try {
      auditDirectSshEffectiveConfig(effective.stdout, admission);
    } catch {
      fail("M4F_DIRECT_STAGED_DIAGNOSTIC_EFFECTIVE_CONFIG_MISMATCH", "local_preflight");
    }

    const wrapper = directPowerShellStdinWrapperFact();
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      currentStageId = stage.stage_id;
      const stageDirectory = absolute + "/" + String(index + 1).padStart(2, "0") + "-" + stage.stage_id;
      makeDirectory(stageDirectory);
      const currentSource = dependencies.sourceBytes();
      validateDiagnosticSource(config, currentSource);
      if (!sourceBefore.equals(currentSource)) {
        fail("M4F_DIRECT_STAGED_DIAGNOSTIC_SOURCE_DRIFT", "network", {
          stage_id: stage.stage_id,
        });
      }
      const currentTransportSource = dependencies.transportSourceBytes();
      validateTransportSource(config, currentTransportSource);
      if (!transportSourceBefore.equals(currentTransportSource)) {
        fail("M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_SOURCE_DRIFT", "network", {
          stage_id: stage.stage_id,
        });
      }
      const currentAdmission = readBoundAdmissionConfig(config);
      if (canonicalJson(currentAdmission.fact) !== canonicalJson(admissionBoundBefore.fact)) {
        fail("M4F_DIRECT_STAGED_DIAGNOSTIC_ADMISSION_CONFIG_DRIFT", "network", {
          stage_id: stage.stage_id,
        });
      }
      const before = captureM4fDirectTransportInputs(admission, "network");
      if (canonicalJson(before) !== canonicalJson(initialInputs)) {
        fail("M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_INPUT_DRIFT", "network", {
          stage_id: stage.stage_id,
        });
      }
      const script = Buffer.from(buildDiagnosticStageScript(stage, admission), "ascii");
      writeEvidence(stageDirectory, "stdin.ps1", script);
      const startedAt = dependencies.now();
      const startMs = dependencies.monotonicMs();
      attemptedStageCount += 1;
      const raw = dependencies.spawn(
        SSH_PATH,
        [...buildDirectSshOptions(admission), TARGET_HOST, buildDirectPowerShellStdinCommand()],
        script,
        STAGE_TIMEOUT_MS,
      );
      const elapsedMs = Math.max(0, Math.round(dependencies.monotonicMs() - startMs));
      const finishedAt = dependencies.now();
      const process = processEvidence(raw, script);
      currentStageProcess = process;
      writeEvidence(stageDirectory, "stdout.raw", raw.stdout);
      writeEvidence(stageDirectory, "stderr.raw", raw.stderr);
      const after = captureM4fDirectTransportInputs(admission, "network");
      if (canonicalJson(after) !== canonicalJson(before)) {
        fail("M4F_DIRECT_STAGED_DIAGNOSTIC_TRANSPORT_INPUT_DRIFT", "network", {
          stage_id: stage.stage_id,
        });
      }
      const processOk = raw.status === 0 && raw.signal === null && raw.errorCode === null
        && raw.stderr.length === 0;
      const outputValid = processOk && parseStageOutput(raw.stdout, stage, admission);
      const record: DiagnosticStageRecord = {
        schema: "synthia-m4f-direct-staged-diagnostic-stage-record.v1",
        diagnostic_id: config.diagnostic_id,
        stage_id: stage.stage_id,
        kind: stage.kind,
        ordinal: index + 1,
        attempt: 1,
        action: "read_only",
        status: outputValid ? "observed" : "unknown",
        output_valid: outputValid,
        retry_permitted: false,
        started_at_utc: startedAt.toISOString(),
        finished_at_utc: finishedAt.toISOString(),
        elapsed_ms: elapsedMs,
        script_length: script.length,
        script_sha256: sha256(script),
        wrapper_length: wrapper.source_length,
        wrapper_sha256: wrapper.source_sha256,
        remote_command_length: wrapper.command_length,
        transport_inputs_before: before,
        transport_inputs_after: after,
        process,
      };
      writeEvidence(stageDirectory, "stage-record.json", JSON.stringify(record, null, 2) + "\n");
      stageRecords.push(record);
      currentStageId = null;
      currentStageProcess = null;
    }

    const sourceAfter = dependencies.sourceBytes();
    const transportSourceAfter = dependencies.transportSourceBytes();
    validateTransportSource(config, transportSourceAfter);
    const admissionBoundAfter = readBoundAdmissionConfig(config);
    const finalInputs = captureM4fDirectTransportInputs(admission, "network");
    if (!sourceBefore.equals(sourceAfter)
      || !transportSourceBefore.equals(transportSourceAfter)
      || canonicalJson(initialInputs) !== canonicalJson(finalInputs)
      || canonicalJson(admissionBoundBefore.fact) !== canonicalJson(admissionBoundAfter.fact)) {
      fail("M4F_DIRECT_STAGED_DIAGNOSTIC_LOCAL_INPUT_DRIFT", "network");
    }
    const unknownCount = stageRecords.filter((record) => record.status === "unknown").length;
    const result: StagedDiagnosticRecord = {
      schema: "synthia-m4f-direct-staged-diagnostic-record.v1",
      diagnostic_id: config.diagnostic_id,
      status: unknownCount === 0 ? "completed" : "completed_with_unknown",
      action: "read_only_staged_diagnostic",
      retry_permitted: false,
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(Buffer.from(canonicalJson(config) + "\n", "utf8")),
      admission_config_sha256: config.admission_config_sha256,
      source_sha256: sha256(sourceBefore),
      transport_source_sha256: transportSourceHash,
      effective_config_sha256: effectiveHash,
      stage_timeout_ms: STAGE_TIMEOUT_MS,
      maximum_remote_elapsed_ms: stages.length * STAGE_TIMEOUT_MS,
      continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry",
      planned_stage_count: stages.length,
      attempted_stage_count: attemptedStageCount,
      observed_stage_count: stageRecords.length - unknownCount,
      unknown_stage_count: unknownCount,
      stage_records: stageRecords,
      admission_config_before: admissionBoundBefore.fact,
      admission_config_after: admissionBoundAfter.fact,
      hardware_action_performed: false,
    };
    writeEvidence(absolute, "diagnostic-record.json", JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    const detail = error instanceof StagedDiagnosticFailure
      ? error.detail
      : {
        schema: "synthia-m4f-direct-staged-diagnostic-failure.v1",
        code: "M4F_DIRECT_STAGED_DIAGNOSTIC_UNEXPECTED",
        stage: "unknown",
        remote_effect_state: attemptedStageCount === 0 ? "not_started" : "read_only_unknown",
        retry_permitted: false,
      };
    const frozenFailure = {
      ...detail,
      remote_effect_state: attemptedStageCount === 0
        ? String(detail.remote_effect_state ?? "not_started")
        : "read_only_unknown",
      diagnostic_id: config.diagnostic_id,
      planned_stage_count: stages.length,
      attempted_stage_count: attemptedStageCount,
      completed_stage_count: stageRecords.length,
      current_stage_id: currentStageId,
      current_stage_process: currentStageProcess,
      transport_source_sha256: transportSourceHash,
      continuation_policy: "continue_distinct_stages_after_unknown_no_stage_retry",
      stage_records: stageRecords,
      hardware_action_performed: false,
    };
    try {
      writeEvidence(absolute, "diagnostic-failure.json", JSON.stringify(frozenFailure, null, 2) + "\n");
    } catch {
      // Preserve the original failure. Existing partial 0600 evidence remains.
    }
    throw error;
  }
}

export function spawnBoundedDiagnosticProcess(
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

const systemDependencies: StagedDiagnosticDependencies = {
  spawn: spawnBoundedDiagnosticProcess,
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
      process.stdout.write(JSON.stringify(planStagedDiagnostic(raw)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-read-only" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      const record = recordStagedDiagnostic(raw, args[4]!, args[6]!);
      process.stdout.write(JSON.stringify(record) + "\n");
      return;
    }
    console.error("usage: bun connector/scripts/m4f-direct-admission-staged-diagnostic.ts --plan --config <config.json>");
    console.error("   or: bun connector/scripts/m4f-direct-admission-staged-diagnostic.ts --execute-read-only --config <config.json> --confirmation <exact> --evidence <new-directory>");
    process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof StagedDiagnosticFailure
      ? error.detail
      : { schema: "synthia-m4f-direct-staged-diagnostic-failure.v1", code: "M4F_DIRECT_STAGED_DIAGNOSTIC_UNEXPECTED", stage: "unknown", remote_effect_state: "read_only_unknown", retry_permitted: false };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();

export const M4F_DIRECT_STAGED_DIAGNOSTIC_GUARDS = {
  sshPath: SSH_PATH,
  targetHost: TARGET_HOST,
  stageTimeoutMs: STAGE_TIMEOUT_MS,
  maxStageCount: MAX_STAGE_COUNT,
  keepaliveEnabled: false,
  allowedStageKinds: [
    "wrapper_smoke",
    "identity",
    "volumes",
    "acl",
    "listeners",
    "processes",
    "vivado_fact",
    "bun_fact",
  ] as const,
};
