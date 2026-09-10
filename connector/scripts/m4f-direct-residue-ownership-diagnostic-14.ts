import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
const LOCAL_TIMEOUT_MS = 25_000;
const WINDOWS_COMMAND_LIMIT = 8191;
const COMMAND_LENGTH_LIMIT = 7000;
const CLOSURE_DEPTH_LIMIT = 8;
const CLOSURE_ROW_LIMIT = 32;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/u;
type Candidate = "candidate09" | "candidate10";
type Role = "powershell" | "conhost";

export const OWNERSHIP_STAGES = ["start", "snapshot", "complete"] as const;

export interface ResidueTargetBinding {
  candidate: Candidate;
  role: Role;
  pid: number;
  name: "powershell.exe" | "conhost.exe";
  creation_utc: string;
}

export interface Candidate12Lineage {
  raw_config_path: string;
  raw_config_sha256: string;
  evidence_directory: string;
  canonical_config_sha256: string;
  result_sha256: string;
  markers_sha256: string;
  raw_stdout_sha256: string;
  remote_process_sha256: string;
}

export interface Candidate13FailureLineage {
  config_path: string;
  config_sha256: string;
  evidence_directory: string;
  canonical_config_sha256: string;
  result_sha256: string;
  markers_sha256: string;
  raw_stdout_sha256: string;
  remote_process_sha256: string;
  failure_code: "parameter_binding_validation";
}

export interface ResidueOwnershipConfig {
  schema: "synthia-m4f-direct-residue-ownership-config.v2";
  diagnostic_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  evidence_directory: string;
  candidate12: Candidate12Lineage;
  candidate13_failure: Candidate13FailureLineage;
  targets: ResidueTargetBinding[];
  expected_wrapper_decoded_utf8_sha256: string;
  known_unquoted_wrapper_command_sha256: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface OwnershipDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  testSourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  frozenBytes(path: string): Buffer;
  admissionConfigBytes(path: string): Buffer;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): LocalInputFact[];
  now(): Date;
}

export interface OwnershipMarker {
  schema: "synthia-m4f-residue-owner-marker.v2";
  diagnostic_id: string;
  ordinal: number;
  stage: "start" | "snapshot" | "complete";
  phase: "start" | "begin" | "end" | "complete";
  status: "started" | "observed" | "unknown" | "complete";
  payload: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

interface ProcessFact {
  pid: number;
  parentPid: number;
  name: string;
  creationUtc: string | null;
  sessionId: number;
  commandLineReadable: boolean;
  commandLineLength: number | null;
  commandLineSha256: string | null;
}

interface Snapshot {
  processes: ProcessFact[];
  wrappers: WrapperProof[];
}

interface WrapperProof {
  pid: number;
  commandShapeExact: boolean;
  canonicalUtf16le: boolean;
  decodedUtf8Sha256: string | null;
}

export interface TargetObservation {
  candidate: Candidate;
  role: Role;
  expected_pid: number;
  expected_creation: string;
  exists: boolean;
  pid: number | null;
  name: string | null;
  creation_utc: string | null;
  parent_pid: number | null;
  parent_exists: boolean;
  parent_name: string | null;
  parent_creation_utc: string | null;
  session_id: number | null;
  command_line_readable: boolean | null;
  command_line_length: number | null;
  command_line_sha256: string | null;
  classification: "missing" | "pid_reused" | "name_mismatch" | "unattributed"
    | "candidate09_10_stdin_wrapper" | "candidate_console_peer";
}

export interface ClosureRow {
  pid: number;
  name: string;
  creation_utc: string | null;
  parent_pid: number;
  parent_creation_utc: string | null;
  session_id: number;
  command_line_readable: boolean;
  command_line_length: number | null;
  command_line_sha256: string | null;
  classification: string;
}

export interface CandidateObservation {
  candidate: Candidate;
  nearest_common_sshd: { pid: number; creation_utc: string } | null;
  same_session: boolean;
  pair_tree_connected: boolean;
  child_count: number;
  descendants: ClosureRow[];
  closure: ClosureRow[];
  closure_max_depth: number;
  closure_overflow: boolean;
  unknown_descendant: boolean;
}

export interface OwnershipObservation {
  targets: TargetObservation[];
  candidates: CandidateObservation[];
  cross_candidate_connected: boolean;
  reasons: string[];
}

export interface OwnershipResult {
  process: RawProcessResult;
  markers: OwnershipMarker[];
  observation: OwnershipObservation | null;
  status: "observed" | "partial_unknown";
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
}

const CONFIG_KEYS = [
  "admission_config_path", "admission_config_sha256", "candidate12", "candidate13_failure", "diagnostic_id",
  "evidence_directory",
  "expected_effective_config_sha256", "expected_source_sha256", "expected_test_source_sha256",
  "expected_transport_source_sha256", "expected_wrapper_decoded_utf8_sha256",
  "known_unquoted_wrapper_command_sha256", "schema", "targets",
] as const;
const LINEAGE_KEYS = [
  "canonical_config_sha256", "evidence_directory", "markers_sha256", "raw_config_path",
  "raw_config_sha256", "raw_stdout_sha256", "remote_process_sha256", "result_sha256",
] as const;
const FAILURE_LINEAGE_KEYS = [
  "canonical_config_sha256", "config_path", "config_sha256", "evidence_directory", "failure_code",
  "markers_sha256", "raw_stdout_sha256", "remote_process_sha256", "result_sha256",
] as const;
const TARGET_KEYS = ["candidate", "creation_utc", "name", "pid", "role"] as const;
const MARKER_KEYS = ["diagnostic_id", "error", "ordinal", "payload", "phase", "schema", "stage", "status"] as const;

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

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function validUtc(value: unknown): value is string {
  return typeof value === "string" && UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function comparableUtc(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,7})Z$/u.exec(value);
  if (!match) throw new Error("M4F_RESIDUE_OWNERSHIP_TIMESTAMP_INVALID");
  return match[1]! + "." + match[2]!.padEnd(7, "0") + "Z";
}

function safePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/u.test(value);
}

export function validateResidueOwnershipConfig(value: unknown): ResidueOwnershipConfig {
  const config = object(value);
  const lineage = object(config?.candidate12);
  const failure = object(config?.candidate13_failure);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-residue-ownership-config.v2"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !absolutePath(config.admission_config_path) || !absolutePath(config.evidence_directory)
    || !lineage || !exactKeys(lineage, LINEAGE_KEYS)
    || !absolutePath(lineage.raw_config_path) || !absolutePath(lineage.evidence_directory)
    || !failure || !exactKeys(failure, FAILURE_LINEAGE_KEYS)
    || !absolutePath(failure.config_path) || !absolutePath(failure.evidence_directory)
    || failure.failure_code !== "parameter_binding_validation"
    || [
      config.admission_config_sha256, lineage.raw_config_sha256, lineage.canonical_config_sha256,
      lineage.result_sha256, lineage.markers_sha256, lineage.raw_stdout_sha256,
      lineage.remote_process_sha256, failure.config_sha256, failure.canonical_config_sha256,
      failure.result_sha256, failure.markers_sha256, failure.raw_stdout_sha256,
      failure.remote_process_sha256,
      config.expected_wrapper_decoded_utf8_sha256,
      config.known_unquoted_wrapper_command_sha256, config.expected_source_sha256,
      config.expected_test_source_sha256, config.expected_transport_source_sha256,
      config.expected_effective_config_sha256,
    ].some((item) => typeof item !== "string" || !HASH.test(item))
    || !Array.isArray(config.targets) || config.targets.length !== 4) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_CONFIG_INVALID");
  }
  const expected: Array<[Candidate, Role, string]> = [
    ["candidate09", "powershell", "powershell.exe"],
    ["candidate09", "conhost", "conhost.exe"],
    ["candidate10", "powershell", "powershell.exe"],
    ["candidate10", "conhost", "conhost.exe"],
  ];
  const pids = new Set<number>();
  for (let index = 0; index < config.targets.length; index += 1) {
    const target = object(config.targets[index]);
    const binding = expected[index]!;
    if (!target || !exactKeys(target, TARGET_KEYS)
      || target.candidate !== binding[0] || target.role !== binding[1] || target.name !== binding[2]
      || !safePid(target.pid) || pids.has(target.pid) || !validUtc(target.creation_utc)) {
      throw new Error("M4F_RESIDUE_OWNERSHIP_CONFIG_INVALID");
    }
    pids.add(target.pid);
  }
  return value as ResidueOwnershipConfig;
}

export function buildResidueOwnershipScript(rawConfig: unknown): string {
  const config = validateResidueOwnershipConfig(rawConfig);
  const start = JSON.stringify({
    schema: "synthia-m4f-residue-owner-marker.v2",
    diagnostic_id: config.diagnostic_id,
    ordinal: 1,
    stage: "start",
    phase: "start",
    status: "observed",
    payload: { direct_encoded_entry: true },
    error: null,
  });
  return [
    "[Console]::Out.WriteLine(" + psLiteral(start) + ");[Console]::Out.Flush()",
    "$ErrorActionPreference=\"Stop\";$ProgressPreference=\"SilentlyContinue\";$id=" + psLiteral(config.diagnostic_id) + ";$o=1;$d=[DateTime]::UtcNow.AddSeconds(15)",
    "function Get-SynthiaHash{param([AllowNull()][object]$Value);if($null-eq$Value){return $null};$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash(([Text.UTF8Encoding]::new($false,$true)).GetBytes([string]$Value)))).Replace(\"-\",\"\").ToLowerInvariant()}finally{$h.Dispose()}}",
    "function E($n,$p,$s,$v,$e){$script:o++;$m=[ordered]@{schema=\"synthia-m4f-residue-owner-marker.v2\";diagnostic_id=$id;ordinal=$script:o;stage=$n;phase=$p;status=$s;payload=$v;error=$e};[Console]::Out.WriteLine(($m|ConvertTo-Json -Compress -Depth 8));[Console]::Out.Flush()}",
    "E \"snapshot\" begin started @{} $null",
    "$g=\"c\";try{$all=@(Get-CimInstance Win32_Process);$g=\"r\";$r=@();$w=@();foreach($p in $all){$q=$p.CommandLine;$v=$null-ne$q;$l=$null;$x=$null;if($v){$l=([string]$q).Length;$x=Get-SynthiaHash -Value ([string]$q)};$c=if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString(\"o\")};$r+=,@([int]$p.ProcessId,[int]$p.ParentProcessId,$p.Name.ToLowerInvariant(),$c,[int]$p.SessionId,$v,$l,$x);if($p.ProcessId-in@(" + config.targets.filter((target) => target.role === "powershell").map((target) => target.pid).join(",") + ")){$m=$false;$k=$false;$z=$null;if($v-and$q-cmatch'^powershell\\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/]+={0,2})$'){$m=$true;try{$e=$Matches[1];$b=[Convert]::FromBase64String($e);if($b.Length%2-eq0){$u=[Text.UnicodeEncoding]::new($false,$false,$true);$t=$u.GetString($b);$k=[Convert]::ToBase64String($u.GetBytes($t))-ceq$e;if($k){$z=Get-SynthiaHash -Value $t}}}catch{}};$w+=,@([int]$p.ProcessId,$m,$k,$z)}};$g=\"d\";if([DateTime]::UtcNow-ge$d){throw \"DEADLINE\"};$g=\"e\";E \"snapshot\" end observed @{cc=1;n=$all.Count;r=$r;w=$w;rl=$false} $null}catch{$t=$_.Exception.GetType().FullName;$z=Get-SynthiaHash -Value ($g+\"|\"+$t+\"|\"+$_.FullyQualifiedErrorId);E \"snapshot\" end unknown $null @{code=$g;type=$t;error_sha256=$z}}",
    "E \"complete\" complete complete @{remote_deadline=\"cooperative_15_seconds\";stdin_length=0;process_mutation_performed=$false;file_mutation_performed=$false;acl_mutation_performed=$false;service_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false;cleanup_derivation_performed=$false} $null",
    "",
  ].join("\n");
}

export function buildResidueOwnershipCommand(rawConfig: unknown): string {
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(buildResidueOwnershipScript(rawConfig), "utf16le").toString("base64");
  if (command.length > COMMAND_LENGTH_LIMIT) throw new Error("M4F_RESIDUE_OWNERSHIP_COMMAND_TOO_LONG");
  return command;
}

export function residueOwnershipConfigSha256(rawConfig: unknown): string {
  return sha256(Buffer.from(canonicalJson(validateResidueOwnershipConfig(rawConfig)) + "\n"));
}

export function residueOwnershipPlan(rawConfig: unknown, rawAdmission: unknown): Record<string, unknown> {
  const config = validateResidueOwnershipConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  const script = Buffer.from(buildResidueOwnershipScript(config), "utf8");
  const command = buildResidueOwnershipCommand(config);
  return {
    schema: "synthia-m4f-direct-residue-ownership-plan.v2",
    diagnostic_id: config.diagnostic_id,
    lineage: "candidate14_after_candidate13_failure",
    candidate12: config.candidate12,
    candidate13_failure: config.candidate13_failure,
    evidence_directory: config.evidence_directory,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    stages: [...OWNERSHIP_STAGES],
    target_bindings: config.targets,
    attempt_count: 1,
    retry_permitted: false,
    local_timeout_ms: LOCAL_TIMEOUT_MS,
    local_timeout_kill_signal: "SIGKILL",
    remote_cooperative_deadline_seconds: 15,
    stdin_length: 0,
    cim_snapshot_count: 1,
    closure_depth_limit: CLOSURE_DEPTH_LIMIT,
    closure_row_limit: CLOSURE_ROW_LIMIT,
    remote_script_length: script.length,
    remote_script_sha256: sha256(script),
    remote_utf16le_length: Buffer.byteLength(buildResidueOwnershipScript(config), "utf16le"),
    remote_base64_length: command.length - command.lastIndexOf(" ") - 1,
    remote_command_length: command.length,
    remote_command_sha256: sha256(Buffer.from(command, "ascii")),
    remote_command_length_limit: COMMAND_LENGTH_LIMIT,
    windows_command_limit: WINDOWS_COMMAND_LIMIT,
    reserved_command_characters: WINDOWS_COMMAND_LIMIT - COMMAND_LENGTH_LIMIT,
    first_remote_action: "write_and_flush_start_marker",
    raw_command_line_returned: false,
    forbidden_wrappers: ["gzip", "Console.In.ReadToEnd", "ScriptBlock.Create"],
    target_host: admission.target.host,
    target_user: admission.target.user,
    network_attempted: false,
    cleanup_performed: false,
    cleanup_derivation_permitted: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
}

export function residueOwnershipPlanSha256(rawConfig: unknown, rawAdmission: unknown): string {
  return sha256(Buffer.from(canonicalJson(residueOwnershipPlan(rawConfig, rawAdmission)) + "\n"));
}

export function residueOwnershipConfirmation(rawConfig: unknown, rawAdmission: unknown): string {
  const config = validateResidueOwnershipConfig(rawConfig);
  return [
    "SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_14_READ_ONLY",
    config.diagnostic_id,
    residueOwnershipConfigSha256(config),
    residueOwnershipPlanSha256(config, rawAdmission),
    config.expected_source_sha256,
    config.expected_test_source_sha256,
  ].join(":");
}

function parseSnapshot(value: unknown, config: ResidueOwnershipConfig): Snapshot | null {
  const payload = object(value);
  if (!payload || !exactKeys(payload, ["cc", "n", "r", "rl", "w"])
    || payload.cc !== 1 || payload.rl !== false || !safeInteger(payload.n)
    || !Array.isArray(payload.r) || payload.r.length !== payload.n || !Array.isArray(payload.w)) return null;
  const processes: ProcessFact[] = [];
  const pids = new Set<number>();
  for (const row of payload.r) {
    if (!Array.isArray(row) || row.length !== 8 || !safePid(row[0]) || pids.has(row[0])
      || !safeInteger(row[1]) || typeof row[2] !== "string" || row[2].length < 1 || row[2].length > 260
      || row[2] !== row[2].toLowerCase() || row[3] !== null && !validUtc(row[3])
      || !safeInteger(row[4]) || typeof row[5] !== "boolean"
      || row[6] !== null && !safeInteger(row[6])
      || row[7] !== null && (typeof row[7] !== "string" || !HASH.test(row[7]))
      || row[5] === false && (row[6] !== null || row[7] !== null)
      || row[5] === true && (row[6] === null || row[7] === null)) return null;
    pids.add(row[0]);
    processes.push({
      pid: row[0], parentPid: row[1], name: row[2], creationUtc: row[3], sessionId: row[4],
      commandLineReadable: row[5], commandLineLength: row[6], commandLineSha256: row[7],
    });
  }
  const wrappers: WrapperProof[] = [];
  const wrapperPids = new Set<number>();
  for (const row of payload.w) {
    if (!Array.isArray(row) || row.length !== 4 || !safePid(row[0]) || wrapperPids.has(row[0])
      || typeof row[1] !== "boolean" || typeof row[2] !== "boolean"
      || row[3] !== null && (typeof row[3] !== "string" || !HASH.test(row[3]))
      || (!row[1] || !row[2]) && row[3] !== null) return null;
    wrapperPids.add(row[0]);
    wrappers.push({
      pid: row[0], commandShapeExact: row[1], canonicalUtf16le: row[2], decodedUtf8Sha256: row[3],
    });
  }
  const expectedWrapperPids = config.targets
    .filter((target) => target.role === "powershell")
    .map((target) => target.pid)
    .sort((left, right) => left - right);
  if (wrappers.length !== expectedWrapperPids.length
    || [...wrapperPids].sort((left, right) => left - right)
      .some((pid, index) => pid !== expectedWrapperPids[index])) return null;
  return { processes, wrappers };
}

function validPayload(
  stage: OwnershipMarker["stage"],
  value: unknown,
  config: ResidueOwnershipConfig,
): boolean {
  const payload = object(value);
  if (!payload) return false;
  if (stage === "start") return exactKeys(payload, ["direct_encoded_entry"]) && payload.direct_encoded_entry === true;
  if (stage === "snapshot") return parseSnapshot(payload, config) !== null;
  return exactKeys(payload, [
    "acl_mutation_performed", "cleanup_derivation_performed", "file_mutation_performed",
    "hardware_action_performed", "process_mutation_performed", "remote_deadline",
    "service_mutation_performed", "stdin_length", "vivado_action_performed",
  ]) && payload.remote_deadline === "cooperative_15_seconds" && payload.stdin_length === 0
    && payload.process_mutation_performed === false && payload.file_mutation_performed === false
    && payload.acl_mutation_performed === false && payload.service_mutation_performed === false
    && payload.vivado_action_performed === false && payload.hardware_action_performed === false
    && payload.cleanup_derivation_performed === false;
}

export function parseOwnershipMarkers(bytes: Buffer, rawConfig: unknown): OwnershipMarker[] {
  const config = validateResidueOwnershipConfig(rawConfig);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  const lines = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, lastNewline + 1)).split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const rules = [
    ["start", "start", "observed"], ["snapshot", "begin", "started"],
    ["snapshot", "end", null], ["complete", "complete", "complete"],
  ] as const;
  const markers: OwnershipMarker[] = [];
  for (const line of lines) {
    let marker: Record<string, unknown> | null = null;
    try { marker = object(JSON.parse(line)); } catch { /* rejected below */ }
    const rule = rules[markers.length];
    if (!marker || !rule || !exactKeys(marker, MARKER_KEYS)
      || marker.schema !== "synthia-m4f-residue-owner-marker.v2"
      || marker.diagnostic_id !== config.diagnostic_id || marker.ordinal !== markers.length + 1
      || marker.stage !== rule[0] || marker.phase !== rule[1]
      || (rule[2] === null ? marker.status !== "observed" && marker.status !== "unknown" : marker.status !== rule[2])) {
      throw new Error("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
    }
    if (marker.phase === "begin") {
      if (!object(marker.payload) || Object.keys(marker.payload as object).length !== 0 || marker.error !== null) {
        throw new Error("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
      }
    } else if (marker.status === "unknown") {
      const error = object(marker.error);
      if (marker.payload !== null || !error || !exactKeys(error, ["code", "error_sha256", "type"])
        || !["c", "r", "d", "e"].includes(String(error.code))
        || typeof error.type !== "string" || error.type.length < 1 || error.type.length > 256
        || typeof error.error_sha256 !== "string" || !HASH.test(error.error_sha256)) {
        throw new Error("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
      }
    } else if (marker.error !== null
      || !validPayload(marker.stage as OwnershipMarker["stage"], marker.payload, config)) {
      throw new Error("M4F_RESIDUE_OWNERSHIP_MARKER_INVALID");
    }
    markers.push(marker as unknown as OwnershipMarker);
  }
  return markers;
}

function targetObservation(binding: ResidueTargetBinding, byPid: Map<number, ProcessFact>): TargetObservation {
  const fact = byPid.get(binding.pid);
  if (!fact) {
    return {
      candidate: binding.candidate, role: binding.role, expected_pid: binding.pid,
      expected_creation: binding.creation_utc, exists: false, pid: null, name: null, creation_utc: null,
      parent_pid: null, parent_exists: false, parent_name: null, parent_creation_utc: null,
      session_id: null, command_line_readable: null, command_line_length: null,
      command_line_sha256: null, classification: "missing",
    };
  }
  const parent = byPid.get(fact.parentPid);
  return {
    candidate: binding.candidate, role: binding.role, expected_pid: binding.pid,
    expected_creation: binding.creation_utc, exists: true, pid: fact.pid, name: fact.name,
    creation_utc: fact.creationUtc, parent_pid: fact.parentPid, parent_exists: !!parent,
    parent_name: parent?.name ?? null, parent_creation_utc: parent?.creationUtc ?? null,
    session_id: fact.sessionId, command_line_readable: fact.commandLineReadable,
    command_line_length: fact.commandLineLength,
    command_line_sha256: fact.commandLineSha256,
    classification: fact.creationUtc !== binding.creation_utc
      ? "pid_reused"
      : fact.name !== binding.name ? "name_mismatch" : "unattributed",
  };
}

interface Walk {
  ancestors: Map<number, number>;
  descendants: Map<number, number>;
  overflow: boolean;
  cycle: boolean;
  parentMissing: boolean;
  parentLater: boolean;
}

function walk(rootPid: number, byPid: Map<number, ProcessFact>, children: Map<number, ProcessFact[]>): Walk {
  const ancestors = new Map<number, number>();
  const descendants = new Map<number, number>();
  let overflow = false;
  let cycle = false;
  let parentMissing = false;
  let parentLater = false;
  let current = byPid.get(rootPid);
  for (let depth = 0; current; depth += 1) {
    if (ancestors.has(current.pid)) { cycle = true; break; }
    ancestors.set(current.pid, depth);
    if (current.parentPid === 0) break;
    const parent = byPid.get(current.parentPid);
    if (!parent) { parentMissing = true; break; }
    if (!current.creationUtc || !parent.creationUtc
      || comparableUtc(parent.creationUtc) > comparableUtc(current.creationUtc)) {
      parentLater = true;
    }
    if (depth >= CLOSURE_DEPTH_LIMIT) { overflow = true; break; }
    current = parent;
  }
  const queue: Array<[number, number]> = [[rootPid, 0]];
  const visited = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const [pid, depth] = queue.shift()!;
    const rows = children.get(pid) ?? [];
    if (depth >= CLOSURE_DEPTH_LIMIT && rows.length > 0) { overflow = true; continue; }
    for (const child of rows) {
      if (visited.has(child.pid)) { cycle = true; continue; }
      visited.add(child.pid);
      descendants.set(child.pid, depth + 1);
      queue.push([child.pid, depth + 1]);
      if (descendants.size > CLOSURE_ROW_LIMIT) overflow = true;
    }
  }
  return { ancestors, descendants, overflow, cycle, parentMissing, parentLater };
}

function closureRow(fact: ProcessFact, byPid: Map<number, ProcessFact>, classification: string): ClosureRow {
  return {
    pid: fact.pid, name: fact.name, creation_utc: fact.creationUtc, parent_pid: fact.parentPid,
    parent_creation_utc: byPid.get(fact.parentPid)?.creationUtc ?? null, session_id: fact.sessionId,
    command_line_readable: fact.commandLineReadable, command_line_length: fact.commandLineLength,
    command_line_sha256: fact.commandLineSha256, classification,
  };
}

export function deriveOwnershipObservation(markers: OwnershipMarker[], rawConfig: unknown): OwnershipObservation | null {
  const config = validateResidueOwnershipConfig(rawConfig);
  const marker = markers.find((item) => item.stage === "snapshot" && item.phase === "end");
  if (!marker || marker.status !== "observed") return null;
  const snapshot = parseSnapshot(marker.payload, config);
  if (!snapshot) return null;
  const byPid = new Map(snapshot.processes.map((fact) => [fact.pid, fact]));
  const proofByPid = new Map(snapshot.wrappers.map((proof) => [proof.pid, proof]));
  const children = new Map<number, ProcessFact[]>();
  for (const fact of snapshot.processes) {
    const rows = children.get(fact.parentPid) ?? [];
    rows.push(fact);
    children.set(fact.parentPid, rows);
  }
  const reasons = new Set<string>();
  const targets = config.targets.map((binding) => targetObservation(binding, byPid));
  for (const target of targets) {
    if (target.classification !== "unattributed") reasons.add(target.candidate + "_" + target.role + "_" + target.classification);
    if (target.exists && !target.parent_exists) reasons.add(target.candidate + "_" + target.role + "_parent_missing");
    if (target.command_line_readable !== true || target.command_line_sha256 === null) {
      reasons.add(target.candidate + "_" + target.role + "_command_line_unavailable");
    }
  }
  for (const binding of config.targets.filter((target) => target.role === "powershell")) {
    const target = targets.find((item) => item.candidate === binding.candidate && item.role === "powershell")!;
    const proof = proofByPid.get(binding.pid);
    const fullProof = proof?.commandShapeExact === true && proof.canonicalUtf16le === true
      && proof.decodedUtf8Sha256 === config.expected_wrapper_decoded_utf8_sha256;
    if (target.classification === "unattributed" && fullProof) {
      target.classification = "candidate09_10_stdin_wrapper";
    } else if (target.classification === "unattributed") {
      reasons.add(binding.candidate + "_wrapper_not_proven");
    }
    if (target.command_line_sha256 === config.known_unquoted_wrapper_command_sha256 && !fullProof) {
      reasons.add(binding.candidate + "_raw_hash_only");
    }
  }
  const candidates: CandidateObservation[] = [];
  const boundedTrees = new Map<Candidate, Set<number>>();
  for (const candidate of ["candidate09", "candidate10"] as const) {
    const bindings = config.targets.filter((target) => target.candidate === candidate);
    const power = bindings.find((target) => target.role === "powershell")!;
    const conhost = bindings.find((target) => target.role === "conhost")!;
    const powerWalk = walk(power.pid, byPid, children);
    const conhostWalk = walk(conhost.pid, byPid, children);
    const common = [...powerWalk.ancestors.entries()]
      .filter(([pid]) => conhostWalk.ancestors.has(pid) && byPid.get(pid)?.name === "sshd.exe")
      .sort((left, right) => left[1] + conhostWalk.ancestors.get(left[0])!
        - right[1] - conhostWalk.ancestors.get(right[0])!);
    const nearestDistance = common.length > 0
      ? common[0]![1] + conhostWalk.ancestors.get(common[0]![0])!
      : null;
    const nearestCommon = nearestDistance === null
      ? []
      : common.filter(([pid, depth]) => depth + conhostWalk.ancestors.get(pid)! === nearestDistance);
    const nearestFact = nearestCommon.length === 1 ? byPid.get(nearestCommon[0]![0]) : undefined;
    const nearest = nearestFact?.creationUtc ? { pid: nearestFact.pid, creation_utc: nearestFact.creationUtc } : null;
    const powerTarget = targets.find((target) => target.candidate === candidate && target.role === "powershell")!;
    const conhostTarget = targets.find((target) => target.candidate === candidate && target.role === "conhost")!;
    const sameSession = powerTarget.session_id !== null && powerTarget.session_id === conhostTarget.session_id;
    const connected = nearest !== null;
    if (conhostTarget.classification === "unattributed"
      && powerTarget.classification === "candidate09_10_stdin_wrapper" && sameSession && connected) {
      conhostTarget.classification = "candidate_console_peer";
    } else if (conhostTarget.classification === "unattributed") {
      reasons.add(candidate + "_console_peer_not_proven");
    }
    if (!sameSession) reasons.add(candidate + "_session_mismatch");
    if (!connected) reasons.add(candidate + "_pair_tree_disconnected");
    if (nearestCommon.length > 1) reasons.add(candidate + "_sshd_ancestor_ambiguous");
    const allIds = new Set<number>([
      ...powerWalk.ancestors.keys(), ...conhostWalk.ancestors.keys(),
      ...powerWalk.descendants.keys(), ...conhostWalk.descendants.keys(),
    ]);
    const descendantIds = new Set<number>([...powerWalk.descendants.keys(), ...conhostWalk.descendants.keys()]);
    const unknownDescendant = [...descendantIds].some((pid) => pid !== power.pid && pid !== conhost.pid);
    const overflow = powerWalk.overflow || conhostWalk.overflow || allIds.size > CLOSURE_ROW_LIMIT;
    if (overflow) reasons.add(candidate + "_closure_overflow");
    if (powerWalk.cycle || conhostWalk.cycle) reasons.add(candidate + "_cycle");
    if (powerWalk.parentMissing || conhostWalk.parentMissing) reasons.add(candidate + "_parent_missing");
    if (powerWalk.parentLater || conhostWalk.parentLater) reasons.add(candidate + "_parent_later_than_child");
    if (unknownDescendant) reasons.add(candidate + "_unknown_descendant");
    const classes = new Map(bindings.map((binding) => [
      binding.pid,
      targets.find((target) => target.candidate === candidate && target.role === binding.role)!.classification,
    ]));
    const makeRow = (pid: number): ClosureRow[] => {
      const fact = byPid.get(pid);
      if (!fact) return [];
      return [closureRow(fact, byPid, classes.get(pid)
        ?? (fact.name === "sshd.exe" ? "sshd_ancestor" : descendantIds.has(pid) ? "descendant" : "ancestor"))];
    };
    const closure = [...allIds].sort((left, right) => left - right).slice(0, CLOSURE_ROW_LIMIT).flatMap(makeRow);
    const descendants = [...descendantIds].sort((left, right) => left - right).slice(0, CLOSURE_ROW_LIMIT).flatMap(makeRow);
    const bounded = new Set<number>();
    if (nearest) {
      for (const [pid, depth] of powerWalk.ancestors) {
        bounded.add(pid);
        if (pid === nearest.pid || depth >= CLOSURE_DEPTH_LIMIT) break;
      }
      for (const [pid, depth] of conhostWalk.ancestors) {
        bounded.add(pid);
        if (pid === nearest.pid || depth >= CLOSURE_DEPTH_LIMIT) break;
      }
    }
    boundedTrees.set(candidate, bounded);
    candidates.push({
      candidate, nearest_common_sshd: nearest, same_session: sameSession, pair_tree_connected: connected,
      child_count: (children.get(power.pid)?.length ?? 0) + (children.get(conhost.pid)?.length ?? 0),
      descendants, closure, closure_max_depth: CLOSURE_DEPTH_LIMIT, closure_overflow: overflow,
      unknown_descendant: unknownDescendant,
    });
  }
  const crossCandidateConnected = [...boundedTrees.get("candidate09")!]
    .some((pid) => boundedTrees.get("candidate10")!.has(pid));
  if (crossCandidateConnected) reasons.add("cross_candidate_connected");
  return { targets, candidates, cross_candidate_connected: crossCandidateConnected, reasons: [...reasons].sort() };
}

function validateFrozenInputs(config: ResidueOwnershipConfig, dependencies: OwnershipDependencies): void {
  const lineage = config.candidate12;
  const failure = config.candidate13_failure;
  const inputs: Array<[string, string]> = [
    [lineage.raw_config_path, lineage.raw_config_sha256],
    [lineage.evidence_directory + "/diagnostic-config.canonical.json", lineage.canonical_config_sha256],
    [lineage.evidence_directory + "/result.json", lineage.result_sha256],
    [lineage.evidence_directory + "/markers.json", lineage.markers_sha256],
    [lineage.evidence_directory + "/remote-stdout.raw", lineage.raw_stdout_sha256],
    [lineage.evidence_directory + "/remote-process.json", lineage.remote_process_sha256],
    [failure.config_path, failure.config_sha256],
    [failure.evidence_directory + "/diagnostic-config.canonical.json", failure.canonical_config_sha256],
    [failure.evidence_directory + "/result.json", failure.result_sha256],
    [failure.evidence_directory + "/markers.json", failure.markers_sha256],
    [failure.evidence_directory + "/remote-stdout.raw", failure.raw_stdout_sha256],
    [failure.evidence_directory + "/remote-process.json", failure.remote_process_sha256],
  ];
  for (const [path, expected] of inputs) {
    if (sha256(dependencies.frozenBytes(path)) !== expected) {
      throw new Error("M4F_RESIDUE_OWNERSHIP_FROZEN_INPUT_MISMATCH");
    }
  }
  if (sha256(dependencies.sourceBytes()) !== config.expected_source_sha256
    || sha256(dependencies.testSourceBytes()) !== config.expected_test_source_sha256
    || sha256(dependencies.transportSourceBytes()) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_SOURCE_MISMATCH");
  }
}

export function executeResidueOwnership(
  rawConfig: unknown,
  rawAdmission: unknown,
  confirmation: string,
  dependencies: OwnershipDependencies,
): OwnershipResult {
  const config = validateResidueOwnershipConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  if (confirmation !== residueOwnershipConfirmation(config, admission)) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_CONFIRMATION_REQUIRED");
  }
  validateFrozenInputs(config, dependencies);
  const inputs = dependencies.transportInputs(admission, "local_preflight");
  const effective = dependencies.spawn(SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), 15_000);
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_EFFECTIVE_CONFIG_FAILED");
  }
  auditDirectSshEffectiveConfig(effective.stdout, admission);
  if (sha256(effective.stdout) !== config.expected_effective_config_sha256) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_EFFECTIVE_CONFIG_MISMATCH");
  }
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_TRANSPORT_INPUT_DRIFT");
  }
  const raw = dependencies.spawn(SSH_PATH, [
    ...buildDirectSshOptions(admission), admission.target.host, buildResidueOwnershipCommand(config),
  ], Buffer.alloc(0), LOCAL_TIMEOUT_MS);
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_TRANSPORT_INPUT_DRIFT");
  }
  const lastNewline = raw.stdout.lastIndexOf(0x0a);
  const tail = lastNewline < 0 ? raw.stdout : raw.stdout.subarray(lastNewline + 1);
  const markers = parseOwnershipMarkers(raw.stdout, config);
  const observation = deriveOwnershipObservation(markers, config);
  const processOk = raw.status === 0 && raw.signal === null && raw.errorCode === null && raw.stderr.length === 0;
  const complete = markers.length === 4 && markers.every((marker) => marker.status !== "unknown") && tail.length === 0;
  return {
    process: raw, markers, observation,
    status: processOk && complete && observation !== null && observation.reasons.length === 0
      ? "observed" : "partial_unknown",
    trailing_fragment_length: tail.length,
    trailing_fragment_sha256: sha256(tail),
  };
}

function writeEvidence(directory: string, name: string, value: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  chmodSync(directory + "/" + name, 0o600);
}

export function recordResidueOwnership(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: OwnershipDependencies,
): OwnershipResult {
  const config = validateResidueOwnershipConfig(rawConfig);
  const admissionBytes = dependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_ADMISSION_MISMATCH");
  }
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  if (confirmation !== residueOwnershipConfirmation(config, admission)) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_CONFIRMATION_REQUIRED");
  }
  validateFrozenInputs(config, dependencies);
  const absolute = resolve(evidenceDirectory);
  if (absolute !== resolve(config.evidence_directory)) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_EVIDENCE_PATH_MISMATCH");
  }
  try { mkdirSync(absolute, { mode: 0o700 }); chmodSync(absolute, 0o700); } catch {
    throw new Error("M4F_RESIDUE_OWNERSHIP_EVIDENCE_INVALID");
  }
  const startedAt = dependencies.now();
  let attemptCount = 0;
  let transportCount = 0;
  writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
  writeEvidence(absolute, "admission-config.raw.json", admissionBytes);
  writeEvidence(absolute, "plan.canonical.json", canonicalJson(residueOwnershipPlan(config, admission)) + "\n");
  writeEvidence(absolute, "confirmation.sha256", sha256(confirmation) + "\n");
  writeEvidence(absolute, "remote-script.ps1", buildResidueOwnershipScript(config));
  const command = buildResidueOwnershipCommand(config);
  writeEvidence(absolute, "remote-command.json", JSON.stringify({
    length: command.length, sha256: sha256(Buffer.from(command, "ascii")), stdin_length: 0,
    attempt_count: 1, raw_command_stored: false,
  }, null, 2) + "\n");
  const wrapped: OwnershipDependencies = {
    ...dependencies,
    spawn(executable, args, stdin, timeoutMs) {
      const label = args[0] === "-G" ? "ssh-effective" : "remote";
      if (label === "remote") attemptCount += 1;
      const processStarted = dependencies.now();
      const result = dependencies.spawn(executable, args, stdin, timeoutMs);
      const processEnded = dependencies.now();
      writeEvidence(absolute, label + "-stdout.raw", result.stdout);
      writeEvidence(absolute, label + "-stderr.raw", result.stderr);
      writeEvidence(absolute, label + "-process.json", JSON.stringify({
        attempt_count: label === "remote" ? attemptCount : 0,
        started_at_utc: processStarted.toISOString(), ended_at_utc: processEnded.toISOString(),
        exit_status: result.status, signal: result.signal, error_code: result.errorCode,
        stdin_length: stdin.length, stdin_sha256: sha256(stdin), stdout_length: result.stdout.length,
        stdout_sha256: sha256(result.stdout), stderr_length: result.stderr.length,
        stderr_sha256: sha256(result.stderr), retry_permitted: false,
      }, null, 2) + "\n");
      return result;
    },
    transportInputs(admissionConfig, stage) {
      const facts = dependencies.transportInputs(admissionConfig, stage);
      const label = ["initial", "pre_remote", "post_remote"][transportCount++];
      if (!label) throw new Error("M4F_RESIDUE_OWNERSHIP_TRANSPORT_CAPTURE_OVERFLOW");
      writeEvidence(absolute, "transport-inputs-" + label + ".json", JSON.stringify(facts, null, 2) + "\n");
      return facts;
    },
  };
  try {
    const result = executeResidueOwnership(config, admission, confirmation, wrapped);
    writeEvidence(absolute, "markers.json", JSON.stringify(result.markers, null, 2) + "\n");
    writeEvidence(absolute, "observation.json", JSON.stringify(result.observation, null, 2) + "\n");
    writeEvidence(absolute, "result.json", JSON.stringify({
      schema: "synthia-m4f-direct-residue-ownership-result.v2",
      diagnostic_id: config.diagnostic_id, status: result.status,
      reasons: result.observation?.reasons ?? ["snapshot_unavailable"], attempt_count: attemptCount,
      started_at_utc: startedAt.toISOString(), ended_at_utc: dependencies.now().toISOString(),
      stdin_length: 0, marker_count: result.markers.length,
      trailing_fragment_length: result.trailing_fragment_length,
      trailing_fragment_sha256: result.trailing_fragment_sha256, retry_permitted: false,
      cleanup_derivation_permitted: false,
    }, null, 2) + "\n");
    return result;
  } catch (error) {
    try {
      writeEvidence(absolute, "failure.json", JSON.stringify({
        error: error instanceof Error ? error.message : "UNKNOWN", attempt_count: attemptCount,
        started_at_utc: startedAt.toISOString(), ended_at_utc: dependencies.now().toISOString(),
        stdin_length: 0, retry_permitted: false, cleanup_derivation_permitted: false,
      }, null, 2) + "\n");
    } catch { /* preserve primary error */ }
    throw error;
  }
}

const systemDependencies: OwnershipDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer", windowsHide: true,
    });
    return {
      status: result.status, signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
      stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  testSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-14.test.ts", import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  frozenBytes: (path) => readFileSync(path),
  admissionConfigBytes: (path) => readFileSync(path),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  const planning = args.length === 3 && args[0] === "--plan" && args[1] === "--config";
  const executing = args.length === 7 && args[0] === "--execute-read-only" && args[1] === "--config"
    && args[3] === "--confirmation" && args[5] === "--evidence-dir";
  if (!planning && !executing) {
    process.stderr.write("usage: --plan --config <path> | --execute-read-only --config <path> --confirmation <exact> --evidence-dir <new>\n");
    process.exitCode = 64;
    return;
  }
  const config = validateResidueOwnershipConfig(JSON.parse(readFileSync(args[2]!, "utf8")));
  if (executing) {
    const result = recordResidueOwnership(config, args[4]!, args[6]!, systemDependencies);
    process.stdout.write(JSON.stringify({
      diagnostic_id: config.diagnostic_id, status: result.status,
      reasons: result.observation?.reasons ?? ["snapshot_unavailable"],
      marker_count: result.markers.length, retry_permitted: false, cleanup_derivation_permitted: false,
    }) + "\n");
    return;
  }
  validateFrozenInputs(config, systemDependencies);
  const admissionBytes = systemDependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) {
    throw new Error("M4F_RESIDUE_OWNERSHIP_ADMISSION_MISMATCH");
  }
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  process.stdout.write(JSON.stringify({
    ...residueOwnershipPlan(config, admission), config_sha256: residueOwnershipConfigSha256(config),
    plan_sha256: residueOwnershipPlanSha256(config, admission),
    confirmation: residueOwnershipConfirmation(config, admission),
  }) + "\n");
}

if (import.meta.main) main();
