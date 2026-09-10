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
const COMMAND_LENGTH_LIMIT = 7_000;
const WINDOWS_COMMAND_LIMIT = 8_191;
const CLOSURE_ROW_LIMIT = 32;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/u;
const UTC_100NS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
const POWERSHELL_COMMAND_SHA256 = "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc";
const CONHOST_COMMAND_SHA256 = "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51";
const CMD_COMMAND_SHA256 = "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e";
const WRAPPER_DECODED_SHA256 = "21ea7ae211c4433bced41512d6b54d37b259a7700ae3dffe63147c6ab5178407";
const WRAPPER_ARGUMENTS = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ";
type Candidate = "candidate09" | "candidate10";
type Role = "powershell" | "conhost";

export interface Residue15Target {
  candidate: Candidate;
  role: Role;
  pid: number;
  name: "powershell.exe" | "conhost.exe";
  creation_utc: string;
}

export interface AttemptWindow {
  candidate: Candidate;
  started_at_utc: string;
  ended_at_utc: string;
}

export interface Candidate12Binding {
  raw_config_path: string;
  raw_config_sha256: string;
  evidence_directory: string;
  canonical_config_sha256: string;
  result_sha256: string;
  markers_sha256: string;
  raw_stdout_sha256: string;
  remote_process_sha256: string;
}

export interface Candidate14FailureBinding {
  config_path: string;
  config_sha256: string;
  evidence_directory: string;
  failure_code: "parser_failure";
  failure_error: "M4F_RESIDUE_OWNERSHIP_MARKER_INVALID";
  attempt_count: 1;
  files: Record<string, string>;
}

export interface RawCommandHashBinding {
  powershell: typeof POWERSHELL_COMMAND_SHA256;
  conhost: typeof CONHOST_COMMAND_SHA256;
  cmd: typeof CMD_COMMAND_SHA256;
}

export interface Cmd15Binding {
  candidate: Candidate;
  pid: number;
  parent_pid: number;
  name: "cmd.exe";
  creation_utc: string;
  session_id: number;
}

export interface ResidueOwnership15Config {
  schema: "synthia-m4f-direct-residue-ownership-config.v3";
  diagnostic_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  evidence_directory: string;
  candidate12: Candidate12Binding;
  candidate14_failure: Candidate14FailureBinding;
  raw_command_hashes: RawCommandHashBinding;
  cmd_bindings: Cmd15Binding[];
  attempt_windows: AttemptWindow[];
  targets: Residue15Target[];
  expected_wrapper_decoded_utf8_sha256: string;
  known_double_space_wrapper_command_sha256: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface Ownership15Dependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  testSourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  frozenBytes(path: string): Buffer;
  admissionConfigBytes(path: string): Buffer;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): LocalInputFact[];
  now(): Date;
}

export interface Ownership15Marker {
  schema: "synthia-m4f-r15.v1";
  diagnostic_id: string;
  ordinal: number;
  stage: "start" | "snapshot" | "complete";
  phase: "start" | "begin" | "end" | "complete";
  status: "started" | "observed" | "unknown" | "complete";
  payload: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

interface ProcessEdge {
  pid: number;
  parentPid: number;
}

interface DetailFact {
  pid: number;
  parentPid: number;
  name: string;
  cimCreationUtc: string | null;
  sessionId: number;
  commandLineSha256: string | null;
  getProcessId: number | null;
  getProcessName: string | null;
  getProcessHasExited: boolean | null;
  getProcessCreationUtc: string | null;
  wrapperShapeExact: boolean | null;
  wrapperCanonicalUtf16le: boolean | null;
  wrapperDecodedUtf8Sha256: string | null;
  wrapperCommandSha256: string | null;
}

interface Snapshot15 {
  edges: ProcessEdge[];
  details: DetailFact[];
}

export interface Target15Observation {
  candidate: Candidate;
  role: Role;
  expected_pid: number;
  expected_creation_utc: string;
  exists: boolean;
  name_exact: boolean;
  get_process_exists: boolean;
  get_process_id_exact: boolean;
  get_process_name_exact: boolean;
  get_process_has_exited: boolean | null;
  get_process_creation_utc: string | null;
  get_process_creation_exact: boolean;
  cim_creation_utc: string | null;
  cim_microseconds_match: boolean;
  command_line_hash_exact: boolean;
  session_id: number | null;
  parent_pid: number | null;
  wrapper_full_proof: boolean | null;
  classification: "missing" | "unattributed" | "candidate09_10_stdin_wrapper" | "candidate_console_peer";
}

export interface Candidate15Observation {
  candidate: Candidate;
  ownership_mode: "orphaned_session_residue_cmd_present" | "orphaned_session_residue_cmd_naturally_exited" | null;
  cmd_pid: number | null;
  cmd_creation_utc: string | null;
  cmd_parent_pid: number | null;
  cmd_parent_missing: boolean;
  same_session: boolean;
  attempt_window_match: boolean;
  cmd_earlier_than_children: boolean;
  unknown_descendant: boolean;
  closure_overflow: boolean;
  current_cmd_state: "present" | "naturally_exited" | "invalid_or_reused";
  cleanup_derivation_permitted: false;
}

export interface Ownership15Observation {
  targets: Target15Observation[];
  candidates: Candidate15Observation[];
  cross_candidate_connected: boolean;
  reasons: string[];
}

export interface Ownership15Result {
  process: RawProcessResult;
  markers: Ownership15Marker[];
  observation: Ownership15Observation | null;
  status: "ownership_observed" | "partial_unknown";
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
}

const CONFIG_KEYS = [
  "admission_config_path", "admission_config_sha256", "attempt_windows", "candidate12",
  "candidate14_failure", "diagnostic_id", "evidence_directory", "expected_effective_config_sha256",
  "expected_source_sha256", "expected_test_source_sha256", "expected_transport_source_sha256",
  "expected_wrapper_decoded_utf8_sha256", "known_double_space_wrapper_command_sha256", "raw_command_hashes",
  "cmd_bindings", "schema", "targets",
] as const;
const C12_KEYS = [
  "canonical_config_sha256", "evidence_directory", "markers_sha256", "raw_config_path",
  "raw_config_sha256", "raw_stdout_sha256", "remote_process_sha256", "result_sha256",
] as const;
const C14_KEYS = [
  "attempt_count", "config_path", "config_sha256", "evidence_directory", "failure_code", "failure_error", "files",
] as const;
const C14_FILE_KEYS = [
  "admission-config.raw.json", "confirmation.sha256", "diagnostic-config.canonical.json", "failure.json",
  "plan.canonical.json", "remote-command.json", "remote-process.json", "remote-script.ps1",
  "remote-stderr.raw", "remote-stdout.raw", "ssh-effective-process.json", "ssh-effective-stderr.raw",
  "ssh-effective-stdout.raw", "transport-inputs-initial.json", "transport-inputs-post_remote.json",
  "transport-inputs-pre_remote.json",
] as const;
const WINDOW_KEYS = ["candidate", "ended_at_utc", "started_at_utc"] as const;
const TARGET_KEYS = ["candidate", "creation_utc", "name", "pid", "role"] as const;
const HASH_BINDING_KEYS = ["cmd", "conhost", "powershell"] as const;
const CMD_BINDING_KEYS = ["candidate", "creation_utc", "name", "parent_pid", "pid", "session_id"] as const;
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
  if (!match) throw new Error("M4F_RESIDUE_15_TIMESTAMP_INVALID");
  return match[1]! + "." + match[2]!.padEnd(7, "0") + "Z";
}

function microsecondUtc(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,7})Z$/u.exec(value);
  if (!match) throw new Error("M4F_RESIDUE_15_TIMESTAMP_INVALID");
  return match[1]! + "." + match[2]!.padEnd(7, "0").slice(0, 6) + "Z";
}

function cimCorrelatesWithHandle(cimValue: string, handleValue: string): boolean {
  if (!UTC_100NS.test(cimValue) || !UTC_100NS.test(handleValue)) return false;
  const cimFraction = cimValue.slice(-8, -1);
  const handleFraction = handleValue.slice(-8, -1);
  return cimFraction.endsWith("0") && cimValue.slice(0, -2) === handleValue.slice(0, -2)
    && cimFraction.slice(0, 6) === handleFraction.slice(0, 6);
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

export function hasExactCandidate15WrapperShape(commandLine: string): boolean {
  const prefix = "powershell.exe  " + WRAPPER_ARGUMENTS;
  if (!commandLine.startsWith(prefix)) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(commandLine.slice(prefix.length));
}

export function validateResidueOwnership15Config(value: unknown): ResidueOwnership15Config {
  const config = object(value);
  const c12 = object(config?.candidate12);
  const c14 = object(config?.candidate14_failure);
  const files = object(c14?.files);
  const rawHashes = object(config?.raw_command_hashes);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-residue-ownership-config.v3"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !absolutePath(config.admission_config_path) || !absolutePath(config.evidence_directory)
    || !c12 || !exactKeys(c12, C12_KEYS) || !absolutePath(c12.raw_config_path)
    || !absolutePath(c12.evidence_directory)
    || !c14 || !exactKeys(c14, C14_KEYS) || !absolutePath(c14.config_path)
    || !absolutePath(c14.evidence_directory) || c14.failure_code !== "parser_failure"
    || c14.failure_error !== "M4F_RESIDUE_OWNERSHIP_MARKER_INVALID" || c14.attempt_count !== 1
    || !files || !exactKeys(files, C14_FILE_KEYS)
    || !rawHashes || !exactKeys(rawHashes, HASH_BINDING_KEYS)
    || rawHashes.powershell !== POWERSHELL_COMMAND_SHA256
    || rawHashes.conhost !== CONHOST_COMMAND_SHA256 || rawHashes.cmd !== CMD_COMMAND_SHA256
    || !Array.isArray(config.attempt_windows) || config.attempt_windows.length !== 2
    || !Array.isArray(config.cmd_bindings) || config.cmd_bindings.length !== 2
    || !Array.isArray(config.targets) || config.targets.length !== 4
    || config.expected_wrapper_decoded_utf8_sha256 !== WRAPPER_DECODED_SHA256
    || config.known_double_space_wrapper_command_sha256 !== POWERSHELL_COMMAND_SHA256
    || [
      config.admission_config_sha256, c12.raw_config_sha256, c12.canonical_config_sha256,
      c12.result_sha256, c12.markers_sha256, c12.raw_stdout_sha256, c12.remote_process_sha256,
      c14.config_sha256, ...Object.values(files), config.expected_wrapper_decoded_utf8_sha256,
      config.known_double_space_wrapper_command_sha256, config.expected_source_sha256,
      config.expected_test_source_sha256, config.expected_transport_source_sha256,
      config.expected_effective_config_sha256,
    ].some((item) => typeof item !== "string" || !HASH.test(item))) {
    throw new Error("M4F_RESIDUE_15_CONFIG_INVALID");
  }
  const expectedTargets: Array<[Candidate, Role, string, number, string]> = [
    ["candidate09", "powershell", "powershell.exe", 44768, "2026-08-28T16:25:51.0137884Z"],
    ["candidate09", "conhost", "conhost.exe", 64484, "2026-08-28T16:25:50.9908927Z"],
    ["candidate10", "powershell", "powershell.exe", 58908, "2026-08-28T17:12:52.5233863Z"],
    ["candidate10", "conhost", "conhost.exe", 66316, "2026-08-28T17:12:52.5009297Z"],
  ];
  const pids = new Set<number>();
  for (let index = 0; index < config.targets.length; index += 1) {
    const target = object(config.targets[index]);
    const expected = expectedTargets[index]!;
    if (!target || !exactKeys(target, TARGET_KEYS) || target.candidate !== expected[0]
      || target.role !== expected[1] || target.name !== expected[2] || !safePid(target.pid)
      || target.pid !== expected[3] || target.creation_utc !== expected[4]
      || pids.has(target.pid) || !validUtc(target.creation_utc)) {
      throw new Error("M4F_RESIDUE_15_CONFIG_INVALID");
    }
    pids.add(target.pid);
  }
  for (let index = 0; index < config.attempt_windows.length; index += 1) {
    const window = object(config.attempt_windows[index]);
    const candidate = index === 0 ? "candidate09" : "candidate10";
    if (!window || !exactKeys(window, WINDOW_KEYS) || window.candidate !== candidate
      || !validUtc(window.started_at_utc) || !validUtc(window.ended_at_utc)
      || comparableUtc(window.started_at_utc) >= comparableUtc(window.ended_at_utc)) {
      throw new Error("M4F_RESIDUE_15_CONFIG_INVALID");
    }
  }
  const expectedCmds: Array<[Candidate, number, number, string]> = [
    ["candidate09", 56576, 6100, "2026-08-28T16:25:50.9870650Z"],
    ["candidate10", 67048, 24260, "2026-08-28T17:12:52.4952390Z"],
  ];
  for (let index = 0; index < config.cmd_bindings.length; index += 1) {
    const binding = object(config.cmd_bindings[index]);
    const expected = expectedCmds[index]!;
    if (!binding || !exactKeys(binding, CMD_BINDING_KEYS) || binding.candidate !== expected[0]
      || binding.pid !== expected[1] || binding.parent_pid !== expected[2] || binding.name !== "cmd.exe"
      || binding.session_id !== 0 || binding.creation_utc !== expected[3] || !validUtc(binding.creation_utc)) {
      throw new Error("M4F_RESIDUE_15_CONFIG_INVALID");
    }
  }
  return value as ResidueOwnership15Config;
}

export function buildResidueOwnership15Script(rawConfig: unknown): string {
  const config = validateResidueOwnership15Config(rawConfig);
  const ids = config.targets.map((target) => target.pid).join(",");
  const powershellIds = config.targets.filter((target) => target.role === "powershell")
    .map((target) => target.pid).join(",");
  const cmdIds = config.cmd_bindings.map((binding) => binding.pid).join(",");
  const start = JSON.stringify({
    schema: "synthia-m4f-r15.v1", diagnostic_id: config.diagnostic_id,
    ordinal: 1, stage: "start", phase: "start", status: "observed",
    payload: { de: 1 }, error: null,
  });
  return [
    "[Console]::WriteLine(" + psLiteral(start) + ");[Console]::Out.Flush()",
    "$ErrorActionPreference=\"Stop\";$id="
      + psLiteral(config.diagnostic_id) + ";$o=1;$dl=[DateTime]::UtcNow.AddSeconds(15);$ids=@(" + ids
      + ");$ps=@(" + powershellIds + ");$cmd=@(" + cmdIds + ")",
    "function Z15($v){$h=[Security.Cryptography.SHA256Managed]::new();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$v)))).Replace(\"-\",\"\").ToLower()}finally{$h.Dispose()}}",
    "function E($n,$p,$s,$v,$e){$script:o++;[Console]::WriteLine(([ordered]@{schema=\"synthia-m4f-r15.v1\";diagnostic_id=$id;ordinal=$script:o;stage=$n;phase=$p;status=$s;payload=$v;error=$e}|ConvertTo-Json -C -D 8));[Console]::Out.Flush()}",
    "E \"snapshot\" begin started @{} $null",
    "$st=\"c\";try{$a=@(Get-CimInstance Win32_Process);$e=@($a|?{$_.ProcessId-ne0}|%{,@([int]$_.ProcessId,[int]$_.ParentProcessId)});if(@($a|?{$_.ProcessId-in$ids}).Count-ne4){throw 4};$want=$ids+@($a|?{$_.ProcessId-in$cmd}|% ProcessId);$d=@();$st=\"g\";foreach($i in$want){$x=@($a|?{$_.ProcessId-eq$i});if($x.Count-ne1){throw 1};$p=$x[0];$c=if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString(\"o\")};$q=$p.CommandLine;$rh=if($null-ne$q){Z15 $q};$gi=$gn=$gh=$gt=$null;if($i-in$ids){$z=Get-Process -Id $i -EA Stop;$gi=[int]$z.Id;$gn=$z.ProcessName+\".exe\";$gh=[bool]$z.HasExited;$gt=$z.StartTime.ToUniversalTime().ToString(\"o\")};$sh=$bc=$dh=$null;if($i-in$ps){$sh=$bc=$false;if($null-ne$q-and$q-cmatch'\\Apowershell\\.exe[ ][ ]-NoLogo[ ]-NoProfile[ ]-NonInteractive[ ]-ExecutionPolicy[ ]Bypass[ ]-EncodedCommand[ ]([A-Za-z0-9+/]+={0,2})\\z'){$sh=$true;try{$b=[Convert]::FromBase64String($Matches[1]);$u=[Text.UnicodeEncoding]::new(0,0,1);$v=$u.GetString($b);$bc=[Convert]::ToBase64String($u.GetBytes($v))-ceq$Matches[1];if($bc){$dh=Z15 $v}}catch{}}};$d+=,@([int]$p.ProcessId,[int]$p.ParentProcessId,$p.Name.ToLower(),$c,[int]$p.SessionId,$rh,$gi,$gn,$gh,$gt,$sh,$bc,$dh)};$st=\"d\";if([DateTime]::UtcNow-ge$dl){throw 2};$st=\"e\";E \"snapshot\" end observed @{cc=1;n=$e.Count;e=$e;d=$d;rl=$false} $null}catch{$t=$_.Exception.GetType().FullName;E \"snapshot\" end unknown $null @{code=$st;type=$t;error_sha256=Z15 ($st+\"|\"+$t+\"|\"+$_.FullyQualifiedErrorId)}}",
    "E \"complete\" complete complete @{rd=15;si=0;pm=0;fm=0;am=0;sm=0;va=0;ha=0;cp=0;cd=0} $null",
    "",
  ].join("\n");
}

export function buildResidueOwnership15Command(rawConfig: unknown): string {
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(buildResidueOwnership15Script(rawConfig), "utf16le").toString("base64");
  if (command.length > COMMAND_LENGTH_LIMIT) throw new Error("M4F_RESIDUE_15_COMMAND_TOO_LONG");
  return command;
}

export function residueOwnership15ConfigSha256(rawConfig: unknown): string {
  return sha256(Buffer.from(canonicalJson(validateResidueOwnership15Config(rawConfig)) + "\n"));
}

export function residueOwnership15Plan(rawConfig: unknown, rawAdmission: unknown): Record<string, unknown> {
  const config = validateResidueOwnership15Config(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  const script = Buffer.from(buildResidueOwnership15Script(config), "utf8");
  const command = buildResidueOwnership15Command(config);
  return {
    schema: "synthia-m4f-direct-residue-ownership-plan.v3",
    diagnostic_id: config.diagnostic_id,
    lineage: "candidate15_after_candidate14_parser_failure",
    candidate12: config.candidate12,
    candidate14_failure: config.candidate14_failure,
    attempt_windows: config.attempt_windows,
    target_bindings: config.targets,
    evidence_directory: config.evidence_directory,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    attempt_count: 1,
    retry_permitted: false,
    local_timeout_ms: LOCAL_TIMEOUT_MS,
    local_timeout_kill_signal: "SIGKILL",
    remote_cooperative_deadline_seconds: 15,
    stdin_length: 0,
    cim_snapshot_count: 1,
    get_process_target_count: 4,
    full_graph_projection: "pid_parent_edges_only",
    detailed_object_count_maximum: 6,
    pid_zero_excluded: true,
    closure_row_limit: CLOSURE_ROW_LIMIT,
    wrapper_spacing: "exactly_two_ascii_spaces_after_executable_only",
    wrapper_known_command_sha256: config.known_double_space_wrapper_command_sha256,
    remote_script_length: script.length,
    remote_script_sha256: sha256(script),
    remote_command_length: command.length,
    remote_command_sha256: sha256(Buffer.from(command, "ascii")),
    remote_command_length_limit: COMMAND_LENGTH_LIMIT,
    windows_command_limit: WINDOWS_COMMAND_LIMIT,
    first_remote_action: "write_and_flush_start_marker",
    raw_command_line_returned: false,
    raw_command_stored: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    cleanup_performed: false,
    cleanup_derivation_permitted: false,
    cleanup_requires_separate_authorization: true,
    vivado_action_performed: false,
    hardware_action_performed: false,
    target_host: admission.target.host,
    target_user: admission.target.user,
    network_attempted: false,
  };
}

export function residueOwnership15PlanSha256(rawConfig: unknown, rawAdmission: unknown): string {
  return sha256(Buffer.from(canonicalJson(residueOwnership15Plan(rawConfig, rawAdmission)) + "\n"));
}

export function residueOwnership15Confirmation(rawConfig: unknown, rawAdmission: unknown): string {
  const config = validateResidueOwnership15Config(rawConfig);
  return [
    "SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_15_READ_ONLY", config.diagnostic_id,
    residueOwnership15ConfigSha256(config), residueOwnership15PlanSha256(config, rawAdmission),
    config.expected_source_sha256, config.expected_test_source_sha256,
  ].join(":");
}

function parseSnapshot15(value: unknown, config: ResidueOwnership15Config): Snapshot15 | null {
  const payload = object(value);
  if (!payload || !exactKeys(payload, ["cc", "d", "e", "n", "rl"]) || payload.cc !== 1
    || payload.rl !== false || !safeInteger(payload.n) || !Array.isArray(payload.e)
    || payload.n !== payload.e.length || !Array.isArray(payload.d)
    || payload.d.length < 4 || payload.d.length > 6) return null;
  const edges: ProcessEdge[] = [];
  const edgePids = new Set<number>();
  for (const row of payload.e) {
    if (!Array.isArray(row) || row.length !== 2 || !safePid(row[0]) || edgePids.has(row[0])
      || !safeInteger(row[1])) return null;
    edgePids.add(row[0]);
    edges.push({ pid: row[0], parentPid: row[1] });
  }
  const details: DetailFact[] = [];
  const detailPids = new Set<number>();
  for (const row of payload.d) {
    if (!Array.isArray(row) || row.length !== 13 || !safePid(row[0]) || detailPids.has(row[0])
      || !safeInteger(row[1]) || typeof row[2] !== "string" || row[2] !== row[2].toLowerCase()
      || row[2].length < 1 || row[2].length > 260 || row[3] !== null && !validUtc(row[3])
      || !safeInteger(row[4]) || row[5] !== null && (typeof row[5] !== "string" || !HASH.test(row[5]))
      || row[6] !== null && !safePid(row[6]) || row[7] !== null && typeof row[7] !== "string"
      || row[8] !== null && typeof row[8] !== "boolean" || row[9] !== null && !validUtc(row[9])
      || row[10] !== null && typeof row[10] !== "boolean" || row[11] !== null && typeof row[11] !== "boolean"
      || row[12] !== null && (typeof row[12] !== "string" || !HASH.test(row[12]))) return null;
    const target = config.targets.find((item) => item.pid === row[0]);
    const cmd = config.cmd_bindings.find((item) => item.pid === row[0]);
    if (target) {
      if (row[5] === null || row[6] === null || typeof row[7] !== "string"
        || typeof row[8] !== "boolean" || row[9] === null) return null;
      if (target.role === "powershell") {
        if (typeof row[10] !== "boolean" || typeof row[11] !== "boolean"
          || (!row[10] || !row[11]) && row[12] !== null) return null;
      } else if (row[10] !== null || row[11] !== null || row[12] !== null) return null;
    } else if (!cmd || row[5] === null || row.slice(6).some((item) => item !== null)) return null;
    if (!edgePids.has(row[0])) return null;
    detailPids.add(row[0]);
    details.push({
      pid: row[0], parentPid: row[1], name: row[2], cimCreationUtc: row[3], sessionId: row[4],
      commandLineSha256: row[5], getProcessId: row[6], getProcessName: row[7],
      getProcessHasExited: row[8], getProcessCreationUtc: row[9], wrapperShapeExact: row[10],
      wrapperCanonicalUtf16le: row[11], wrapperDecodedUtf8Sha256: row[12],
      wrapperCommandSha256: row[5],
    });
  }
  const targetPids = new Set(config.targets.map((target) => target.pid));
  if (![...targetPids].every((pid) => detailPids.has(pid))) return null;
  const cmdPids = new Set(config.cmd_bindings.map((binding) => binding.pid));
  if ([...detailPids].some((pid) => !targetPids.has(pid) && !cmdPids.has(pid))) return null;
  const edgeParents = new Map(edges.map((edge) => [edge.pid, edge.parentPid]));
  if (details.some((detail) => edgeParents.get(detail.pid) !== detail.parentPid)
    || [...cmdPids].some((pid) => edgePids.has(pid) !== detailPids.has(pid))) return null;
  return { edges, details };
}

function validCompletePayload(value: unknown): boolean {
  const payload = object(value);
  return !!payload && exactKeys(payload, ["am", "cd", "cp", "fm", "ha", "pm", "rd", "si", "sm", "va"])
    && payload.rd === 15 && ["am", "cd", "cp", "fm", "ha", "pm", "si", "sm", "va"]
      .every((key) => payload[key] === 0);
}

export function parseOwnership15Markers(bytes: Buffer, rawConfig: unknown): Ownership15Marker[] {
  const config = validateResidueOwnership15Config(rawConfig);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  const lines = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, lastNewline + 1))
    .split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const rules = [
    ["start", "start", "observed"], ["snapshot", "begin", "started"],
    ["snapshot", "end", null], ["complete", "complete", "complete"],
  ] as const;
  const markers: Ownership15Marker[] = [];
  for (const line of lines) {
    let marker: Record<string, unknown> | null = null;
    try { marker = object(JSON.parse(line)); } catch { /* rejected below */ }
    const rule = rules[markers.length];
    if (!marker || !rule || !exactKeys(marker, MARKER_KEYS)
      || marker.schema !== "synthia-m4f-r15.v1"
      || marker.diagnostic_id !== config.diagnostic_id || marker.ordinal !== markers.length + 1
      || marker.stage !== rule[0] || marker.phase !== rule[1]
      || (rule[2] === null ? marker.status !== "observed" && marker.status !== "unknown" : marker.status !== rule[2])) {
      throw new Error("M4F_RESIDUE_15_MARKER_INVALID");
    }
    if (marker.phase === "begin") {
      if (!object(marker.payload) || Object.keys(marker.payload as object).length !== 0 || marker.error !== null) {
        throw new Error("M4F_RESIDUE_15_MARKER_INVALID");
      }
    } else if (marker.status === "unknown") {
      const error = object(marker.error);
      if (marker.payload !== null || !error || !exactKeys(error, ["code", "error_sha256", "type"])
        || !["c", "g", "d", "e"].includes(String(error.code)) || typeof error.type !== "string"
        || error.type.length < 1 || error.type.length > 256 || typeof error.error_sha256 !== "string"
        || !HASH.test(error.error_sha256)) throw new Error("M4F_RESIDUE_15_MARKER_INVALID");
    } else if (marker.stage === "start") {
      const payload = object(marker.payload);
      if (!payload || !exactKeys(payload, ["de"]) || payload.de !== 1
        || marker.error !== null) throw new Error("M4F_RESIDUE_15_MARKER_INVALID");
    } else if (marker.stage === "snapshot") {
      if (marker.error !== null || !parseSnapshot15(marker.payload, config)) {
        throw new Error("M4F_RESIDUE_15_MARKER_INVALID");
      }
    } else if (marker.error !== null || !validCompletePayload(marker.payload)) {
      throw new Error("M4F_RESIDUE_15_MARKER_INVALID");
    }
    markers.push(marker as unknown as Ownership15Marker);
  }
  return markers;
}

function descendants(root: number, children: Map<number, number[]>): { pids: Set<number>; overflow: boolean } {
  const pids = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (pids.has(child) || child === root) continue;
      pids.add(child);
      if (pids.size > CLOSURE_ROW_LIMIT) return { pids, overflow: true };
      queue.push(child);
    }
  }
  return { pids, overflow: false };
}

function validateCandidate14Semantics(config: ResidueOwnership15Config, dependencies: Ownership15Dependencies): void {
  const rawConfig = object(JSON.parse(dependencies.frozenBytes(config.candidate14_failure.config_path).toString("utf8")));
  const canonicalConfig = object(JSON.parse(dependencies.frozenBytes(
    config.candidate14_failure.evidence_directory + "/diagnostic-config.canonical.json",
  ).toString("utf8")));
  if (!rawConfig || !canonicalConfig || typeof rawConfig.diagnostic_id !== "string"
    || canonicalConfig.diagnostic_id !== rawConfig.diagnostic_id) {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
  const failure = object(JSON.parse(dependencies.frozenBytes(
    config.candidate14_failure.evidence_directory + "/failure.json",
  ).toString("utf8")));
  const process = object(JSON.parse(dependencies.frozenBytes(
    config.candidate14_failure.evidence_directory + "/remote-process.json",
  ).toString("utf8")));
  if (!failure || failure.error !== config.candidate14_failure.failure_error || failure.attempt_count !== 1
    || failure.stdin_length !== 0 || failure.retry_permitted !== false
    || failure.cleanup_derivation_permitted !== false || !process || process.attempt_count !== 1
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.stdin_length !== 0 || process.stderr_length !== 0 || process.retry_permitted !== false) {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
  const stdout = dependencies.frozenBytes(config.candidate14_failure.evidence_directory + "/remote-stdout.raw");
  let lines: string[];
  try {
    lines = new TextDecoder("utf8", { fatal: true }).decode(stdout).split(/\r?\n/u);
  } catch {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 4) throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  const markers: Record<string, unknown>[] = [];
  try {
    for (const line of lines) {
      const marker = object(JSON.parse(line));
      if (!marker) throw new Error("marker");
      markers.push(marker);
    }
  } catch {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
  const expectedStages = [["start", "start"], ["snapshot", "begin"], ["snapshot", "end"], ["complete", "complete"]];
  if (markers.some((marker, index) => marker.schema !== "synthia-m4f-residue-owner-marker.v2"
    || marker.diagnostic_id !== rawConfig.diagnostic_id || marker.ordinal !== index + 1
    || marker.stage !== expectedStages[index]![0] || marker.phase !== expectedStages[index]![1])
    || markers[0]!.status !== "observed" || markers[1]!.status !== "started"
    || markers[2]!.status !== "observed" || markers[3]!.status !== "complete") {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
  const payload = object(markers[2]!.payload);
  if (!payload || payload.cc !== 1 || payload.rl !== false || !Array.isArray(payload.r)
    || payload.n !== payload.r.length || !Array.isArray(payload.w)) {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
  const rows = new Map<number, unknown[]>();
  for (const rawRow of payload.r) {
    if (!Array.isArray(rawRow) || rawRow.length !== 8 || !safeInteger(rawRow[0]) || rows.has(rawRow[0])
      || !safeInteger(rawRow[1]) || typeof rawRow[2] !== "string" || rawRow[3] !== null && !validUtc(rawRow[3])
      || !safeInteger(rawRow[4]) || typeof rawRow[5] !== "boolean"
      || rawRow[6] !== null && !safeInteger(rawRow[6])
      || rawRow[7] !== null && (typeof rawRow[7] !== "string" || !HASH.test(rawRow[7]))) {
      throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
    }
    rows.set(rawRow[0], rawRow);
  }
  if (!rows.has(0)) throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  for (const candidate of ["candidate09", "candidate10"] as const) {
    const cmd = config.cmd_bindings.find((item) => item.candidate === candidate)!;
    const boundTargets = config.targets.filter((item) => item.candidate === candidate);
    const cmdRow = rows.get(cmd.pid);
    if (!cmdRow || cmdRow[1] !== cmd.parent_pid || cmdRow[2] !== cmd.name
      || cmdRow[3] !== cmd.creation_utc || cmdRow[4] !== cmd.session_id || cmdRow[5] !== true
      || !safeInteger(cmdRow[6]) || cmdRow[7] !== config.raw_command_hashes.cmd || rows.has(cmd.parent_pid)) {
      throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
    }
    for (const target of boundTargets) {
      const row = rows.get(target.pid);
      const expectedHash = target.role === "powershell"
        ? config.raw_command_hashes.powershell : config.raw_command_hashes.conhost;
      if (!row || row[1] !== cmd.pid || row[2] !== target.name
        || row[3] !== microsecondUtc(target.creation_utc).replace("Z", "0Z")
        || row[4] !== cmd.session_id || row[5] !== true || !safeInteger(row[6]) || row[7] !== expectedHash) {
        throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
      }
    }
    const directChildren = [...rows.values()].filter((row) => row[1] === cmd.pid).map((row) => row[0]).sort();
    const expectedChildren = boundTargets.map((item) => item.pid).sort();
    if (canonicalJson(directChildren) !== canonicalJson(expectedChildren)
      || boundTargets.some((target) => [...rows.values()].some((row) => row[1] === target.pid))) {
      throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
    }
  }
  const wrappers = payload.w;
  const expectedPowerShellPids = config.targets.filter((item) => item.role === "powershell").map((item) => item.pid).sort();
  const wrapperPids: number[] = [];
  for (const row of wrappers) {
    if (!Array.isArray(row) || row.length !== 4 || !safePid(row[0]) || row[1] !== false
      || row[2] !== false || row[3] !== null) {
      throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
    }
    wrapperPids.push(row[0]);
  }
  if (canonicalJson(wrapperPids.sort()) !== canonicalJson(expectedPowerShellPids)) {
    throw new Error("M4F_RESIDUE_15_CANDIDATE14_SEMANTIC_MISMATCH");
  }
}

export function deriveOwnership15Observation(
  markers: Ownership15Marker[],
  rawConfig: unknown,
): Ownership15Observation | null {
  const config = validateResidueOwnership15Config(rawConfig);
  const marker = markers.find((item) => item.stage === "snapshot" && item.phase === "end");
  if (!marker || marker.status !== "observed") return null;
  const snapshot = parseSnapshot15(marker.payload, config);
  if (!snapshot) return null;
  const details = new Map(snapshot.details.map((detail) => [detail.pid, detail]));
  const edgePids = new Set(snapshot.edges.map((edge) => edge.pid));
  const children = new Map<number, number[]>();
  for (const edge of snapshot.edges) {
    const rows = children.get(edge.parentPid) ?? [];
    rows.push(edge.pid);
    children.set(edge.parentPid, rows);
  }
  const reasons = new Set<string>();
  const targets: Target15Observation[] = config.targets.map((binding) => {
    const detail = details.get(binding.pid);
    const exists = !!detail;
    const nameExact = detail?.name === binding.name;
    const gpExists = detail?.getProcessId !== null && detail?.getProcessId !== undefined;
    const gpIdExact = detail?.getProcessId === binding.pid;
    const gpNameExact = detail?.getProcessName === binding.name;
    const gpHasExited = detail?.getProcessHasExited ?? null;
    const gpCreationExact = detail?.getProcessCreationUtc === binding.creation_utc;
    const cimMicrosecondsMatch = !!detail?.cimCreationUtc
      && cimCorrelatesWithHandle(detail.cimCreationUtc, binding.creation_utc);
    const expectedCommandHash = binding.role === "powershell"
      ? config.raw_command_hashes.powershell : config.raw_command_hashes.conhost;
    const rawCommandExact = detail?.commandLineSha256 === expectedCommandHash;
    const wrapperFull = binding.role === "powershell" ? !!detail
      && detail.wrapperShapeExact === true && detail.wrapperCanonicalUtf16le === true
      && detail.wrapperDecodedUtf8Sha256 === config.expected_wrapper_decoded_utf8_sha256
      && rawCommandExact : null;
    const prefix = binding.candidate + "_" + binding.role + "_";
    if (!exists) reasons.add(prefix + "missing");
    if (exists && !nameExact) reasons.add(prefix + "name_mismatch");
    if (exists && !gpExists) reasons.add(prefix + "get_process_missing");
    if (gpExists && !gpIdExact) reasons.add(prefix + "get_process_id_mismatch");
    if (gpExists && !gpNameExact) reasons.add(prefix + "get_process_name_mismatch");
    if (gpExists && gpHasExited !== false) reasons.add(prefix + "get_process_exited_or_unknown");
    if (gpExists && !gpCreationExact) reasons.add(prefix + "get_process_creation_mismatch");
    if (exists && !cimMicrosecondsMatch) reasons.add(prefix + "cim_microseconds_mismatch");
    if (exists && !rawCommandExact) reasons.add(prefix + "raw_command_hash_mismatch");
    if (binding.role === "powershell" && !wrapperFull) reasons.add(binding.candidate + "_wrapper_not_proven");
    return {
      candidate: binding.candidate, role: binding.role, expected_pid: binding.pid,
      expected_creation_utc: binding.creation_utc, exists, name_exact: nameExact,
      get_process_exists: gpExists, get_process_id_exact: gpIdExact, get_process_name_exact: gpNameExact,
      get_process_has_exited: gpHasExited,
      get_process_creation_utc: detail?.getProcessCreationUtc ?? null,
      get_process_creation_exact: gpCreationExact, cim_creation_utc: detail?.cimCreationUtc ?? null,
      cim_microseconds_match: cimMicrosecondsMatch, command_line_hash_exact: rawCommandExact,
      session_id: detail?.sessionId ?? null,
      parent_pid: detail?.parentPid ?? null, wrapper_full_proof: wrapperFull,
      classification: exists ? "unattributed" : "missing",
    };
  });
  const candidates: Candidate15Observation[] = [];
  const candidateClosures = new Map<Candidate, Set<number>>();
  const provisional = new Map<Candidate, boolean>();
  for (const candidate of ["candidate09", "candidate10"] as const) {
    const window = config.attempt_windows.find((item) => item.candidate === candidate)!;
    const binding = config.cmd_bindings.find((item) => item.candidate === candidate)!;
    const power = targets.find((item) => item.candidate === candidate && item.role === "powershell")!;
    const conhost = targets.find((item) => item.candidate === candidate && item.role === "conhost")!;
    const parentSame = power.parent_pid === binding.pid && conhost.parent_pid === binding.pid;
    const cmd = details.get(binding.pid);
    const cmdInGraph = edgePids.has(binding.pid);
    const cmdExact = !!cmd && cmdInGraph && cmd.name === binding.name && cmd.parentPid === binding.parent_pid
      && cmd.cimCreationUtc === binding.creation_utc && cmd.sessionId === binding.session_id
      && cmd.commandLineSha256 === config.raw_command_hashes.cmd;
    const cmdState = cmdExact ? "present" : !cmd && !cmdInGraph ? "naturally_exited" : "invalid_or_reused";
    const sameSession = power.session_id !== null && power.session_id === conhost.session_id
      && power.session_id === binding.session_id && (!cmd || power.session_id === cmd.sessionId);
    const attemptWindowMatch = comparableUtc(binding.creation_utc) >= comparableUtc(window.started_at_utc)
      && comparableUtc(binding.creation_utc) <= comparableUtc(window.ended_at_utc);
    const cmdEarlier = !!power.get_process_creation_utc && !!conhost.get_process_creation_utc
      && comparableUtc(binding.creation_utc) < comparableUtc(power.get_process_creation_utc)
      && comparableUtc(binding.creation_utc) < comparableUtc(conhost.get_process_creation_utc);
    const cmdParentMissing = binding.parent_pid > 0 && !edgePids.has(binding.parent_pid);
    const closure = new Set<number>([
      binding.pid, binding.parent_pid, power.expected_pid, conhost.expected_pid,
    ]);
    candidateClosures.set(candidate, closure);
    const walked = descendants(binding.pid, children);
    const knownChildren = new Set([power.expected_pid, conhost.expected_pid]);
    const targetWalks = [descendants(power.expected_pid, children), descendants(conhost.expected_pid, children)];
    const childSetExact = walked.pids.size === knownChildren.size
      && [...walked.pids].every((pid) => knownChildren.has(pid));
    const unknownDescendant = !childSetExact || targetWalks.some((item) => item.pids.size > 0);
    const overflow = walked.overflow || targetWalks.some((item) => item.overflow);
    if (!parentSame) reasons.add(candidate + "_parent_mismatch");
    if (cmdState === "invalid_or_reused") reasons.add(candidate + "_cmd_identity_invalid_or_reused");
    if (!sameSession) reasons.add(candidate + "_session_mismatch");
    if (!attemptWindowMatch) reasons.add(candidate + "_cmd_outside_attempt_window");
    if (!cmdEarlier) reasons.add(candidate + "_cmd_not_earlier_than_children");
    if (!cmdParentMissing) reasons.add(candidate + "_cmd_upstream_not_missing");
    if (unknownDescendant) reasons.add(candidate + "_unknown_descendant");
    if (overflow) reasons.add(candidate + "_closure_overflow");
    const targetExact = power.exists && power.name_exact && power.get_process_exists
      && power.get_process_id_exact && power.get_process_name_exact && power.get_process_has_exited === false
      && power.get_process_creation_exact && power.cim_microseconds_match
      && power.command_line_hash_exact && power.wrapper_full_proof === true
      && conhost.exists && conhost.name_exact
      && conhost.get_process_exists && conhost.get_process_id_exact && conhost.get_process_name_exact
      && conhost.get_process_has_exited === false && conhost.get_process_creation_exact
      && conhost.cim_microseconds_match && conhost.command_line_hash_exact;
    const owned = targetExact && parentSame && cmdState !== "invalid_or_reused" && sameSession
      && attemptWindowMatch && cmdEarlier && cmdParentMissing && !unknownDescendant && !overflow;
    provisional.set(candidate, owned);
    candidates.push({
      candidate, ownership_mode: null, cmd_pid: binding.pid,
      cmd_creation_utc: binding.creation_utc, cmd_parent_pid: binding.parent_pid,
      cmd_parent_missing: cmdParentMissing, same_session: sameSession,
      attempt_window_match: attemptWindowMatch, cmd_earlier_than_children: cmdEarlier,
      unknown_descendant: unknownDescendant, closure_overflow: overflow,
      current_cmd_state: cmdState, cleanup_derivation_permitted: false,
    });
  }
  const left = candidateClosures.get("candidate09")!;
  const right = candidateClosures.get("candidate10")!;
  const crossCandidateConnected = [...left].some((pid) => right.has(pid));
  if (crossCandidateConnected) reasons.add("cross_candidate_connected");
  if (!crossCandidateConnected) {
    for (const candidate of ["candidate09", "candidate10"] as const) {
      if (!provisional.get(candidate)) continue;
      const power = targets.find((item) => item.candidate === candidate && item.role === "powershell")!;
      const conhost = targets.find((item) => item.candidate === candidate && item.role === "conhost")!;
      const observation = candidates.find((item) => item.candidate === candidate)!;
      power.classification = "candidate09_10_stdin_wrapper";
      conhost.classification = "candidate_console_peer";
      observation.ownership_mode = observation.current_cmd_state === "present"
        ? "orphaned_session_residue_cmd_present" : "orphaned_session_residue_cmd_naturally_exited";
    }
  }
  return { targets, candidates, cross_candidate_connected: crossCandidateConnected, reasons: [...reasons].sort() };
}

function validateFrozenInputs(config: ResidueOwnership15Config, dependencies: Ownership15Dependencies): void {
  const c12 = config.candidate12;
  const c14 = config.candidate14_failure;
  const inputs: Array<[string, string]> = [
    [c12.raw_config_path, c12.raw_config_sha256],
    [c12.evidence_directory + "/diagnostic-config.canonical.json", c12.canonical_config_sha256],
    [c12.evidence_directory + "/result.json", c12.result_sha256],
    [c12.evidence_directory + "/markers.json", c12.markers_sha256],
    [c12.evidence_directory + "/remote-stdout.raw", c12.raw_stdout_sha256],
    [c12.evidence_directory + "/remote-process.json", c12.remote_process_sha256],
    [c14.config_path, c14.config_sha256],
    ...C14_FILE_KEYS.map((name): [string, string] => [c14.evidence_directory + "/" + name, c14.files[name]!]),
  ];
  for (const [path, expected] of inputs) {
    if (sha256(dependencies.frozenBytes(path)) !== expected) throw new Error("M4F_RESIDUE_15_FROZEN_INPUT_MISMATCH");
  }
  const c12Config = object(JSON.parse(dependencies.frozenBytes(c12.raw_config_path).toString("utf8")));
  if (!c12Config || config.attempt_windows[0]!.started_at_utc !== c12Config.candidate09_started_at_utc
    || config.attempt_windows[0]!.ended_at_utc !== c12Config.candidate09_ended_at_utc
    || config.attempt_windows[1]!.started_at_utc !== c12Config.candidate10_started_at_utc
    || config.attempt_windows[1]!.ended_at_utc !== c12Config.candidate10_ended_at_utc) {
    throw new Error("M4F_RESIDUE_15_ATTEMPT_WINDOW_MISMATCH");
  }
  validateCandidate14Semantics(config, dependencies);
  if (sha256(dependencies.sourceBytes()) !== config.expected_source_sha256
    || sha256(dependencies.testSourceBytes()) !== config.expected_test_source_sha256
    || sha256(dependencies.transportSourceBytes()) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_RESIDUE_15_SOURCE_MISMATCH");
  }
}

export function executeResidueOwnership15(
  rawConfig: unknown,
  rawAdmission: unknown,
  confirmation: string,
  dependencies: Ownership15Dependencies,
): Ownership15Result {
  const config = validateResidueOwnership15Config(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  if (confirmation !== residueOwnership15Confirmation(config, admission)) {
    throw new Error("M4F_RESIDUE_15_CONFIRMATION_REQUIRED");
  }
  validateFrozenInputs(config, dependencies);
  const inputs = dependencies.transportInputs(admission, "local_preflight");
  const effective = dependencies.spawn(SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), 15_000);
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) {
    throw new Error("M4F_RESIDUE_15_EFFECTIVE_CONFIG_FAILED");
  }
  auditDirectSshEffectiveConfig(effective.stdout, admission);
  if (sha256(effective.stdout) !== config.expected_effective_config_sha256) {
    throw new Error("M4F_RESIDUE_15_EFFECTIVE_CONFIG_MISMATCH");
  }
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) {
    throw new Error("M4F_RESIDUE_15_TRANSPORT_INPUT_DRIFT");
  }
  const raw = dependencies.spawn(SSH_PATH, [
    ...buildDirectSshOptions(admission), admission.target.host, buildResidueOwnership15Command(config),
  ], Buffer.alloc(0), LOCAL_TIMEOUT_MS);
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) {
    throw new Error("M4F_RESIDUE_15_TRANSPORT_INPUT_DRIFT");
  }
  const lastNewline = raw.stdout.lastIndexOf(0x0a);
  const tail = lastNewline < 0 ? raw.stdout : raw.stdout.subarray(lastNewline + 1);
  const markers = parseOwnership15Markers(raw.stdout, config);
  const observation = deriveOwnership15Observation(markers, config);
  const processOk = raw.status === 0 && raw.signal === null && raw.errorCode === null && raw.stderr.length === 0;
  const complete = markers.length === 4 && markers.every((marker) => marker.status !== "unknown") && tail.length === 0;
  return {
    process: raw, markers, observation,
    status: processOk && complete && observation !== null && observation.reasons.length === 0
      ? "ownership_observed" : "partial_unknown",
    trailing_fragment_length: tail.length, trailing_fragment_sha256: sha256(tail),
  };
}

function writeEvidence(directory: string, name: string, value: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  chmodSync(directory + "/" + name, 0o600);
}

export function recordResidueOwnership15(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: Ownership15Dependencies,
): Ownership15Result {
  const config = validateResidueOwnership15Config(rawConfig);
  const admissionBytes = dependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) throw new Error("M4F_RESIDUE_15_ADMISSION_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  if (confirmation !== residueOwnership15Confirmation(config, admission)) {
    throw new Error("M4F_RESIDUE_15_CONFIRMATION_REQUIRED");
  }
  validateFrozenInputs(config, dependencies);
  const absolute = resolve(evidenceDirectory);
  if (absolute !== resolve(config.evidence_directory)) throw new Error("M4F_RESIDUE_15_EVIDENCE_PATH_MISMATCH");
  try { mkdirSync(absolute, { mode: 0o700 }); chmodSync(absolute, 0o700); } catch {
    throw new Error("M4F_RESIDUE_15_EVIDENCE_INVALID");
  }
  const startedAt = dependencies.now();
  let attemptCount = 0;
  let transportCount = 0;
  writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
  writeEvidence(absolute, "admission-config.raw.json", admissionBytes);
  writeEvidence(absolute, "plan.canonical.json", canonicalJson(residueOwnership15Plan(config, admission)) + "\n");
  writeEvidence(absolute, "confirmation.sha256", sha256(confirmation) + "\n");
  writeEvidence(absolute, "remote-script.ps1", buildResidueOwnership15Script(config));
  const command = buildResidueOwnership15Command(config);
  writeEvidence(absolute, "remote-command.json", JSON.stringify({
    length: command.length, sha256: sha256(Buffer.from(command, "ascii")), stdin_length: 0,
    attempt_count: 1, raw_command_stored: false,
  }, null, 2) + "\n");
  const wrapped: Ownership15Dependencies = {
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
      if (!label) throw new Error("M4F_RESIDUE_15_TRANSPORT_CAPTURE_OVERFLOW");
      writeEvidence(absolute, "transport-inputs-" + label + ".json", JSON.stringify(facts, null, 2) + "\n");
      return facts;
    },
  };
  try {
    const result = executeResidueOwnership15(config, admission, confirmation, wrapped);
    writeEvidence(absolute, "markers.json", JSON.stringify(result.markers, null, 2) + "\n");
    writeEvidence(absolute, "observation.json", JSON.stringify(result.observation, null, 2) + "\n");
    writeEvidence(absolute, "result.json", JSON.stringify({
      schema: "synthia-m4f-direct-residue-ownership-result.v3", diagnostic_id: config.diagnostic_id,
      status: result.status, reasons: result.observation?.reasons ?? ["snapshot_unavailable"],
      attempt_count: attemptCount, started_at_utc: startedAt.toISOString(),
      ended_at_utc: dependencies.now().toISOString(), stdin_length: 0,
      marker_count: result.markers.length, trailing_fragment_length: result.trailing_fragment_length,
      trailing_fragment_sha256: result.trailing_fragment_sha256, retry_permitted: false,
      cleanup_performed: false, cleanup_derivation_permitted: false,
    }, null, 2) + "\n");
    return result;
  } catch (error) {
    try {
      writeEvidence(absolute, "failure.json", JSON.stringify({
        error: error instanceof Error ? error.message : "UNKNOWN", attempt_count: attemptCount,
        started_at_utc: startedAt.toISOString(), ended_at_utc: dependencies.now().toISOString(),
        stdin_length: 0, retry_permitted: false, cleanup_performed: false,
      }, null, 2) + "\n");
    } catch { /* preserve primary error */ }
    throw error;
  }
}

const systemDependencies: Ownership15Dependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer", windowsHide: true,
    });
    return {
      status: result.status, signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)), stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  testSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-15.test.ts", import.meta.url)),
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
  const config = validateResidueOwnership15Config(JSON.parse(readFileSync(args[2]!, "utf8")));
  if (executing) {
    const result = recordResidueOwnership15(config, args[4]!, args[6]!, systemDependencies);
    process.stdout.write(JSON.stringify({
      diagnostic_id: config.diagnostic_id, status: result.status,
      reasons: result.observation?.reasons ?? ["snapshot_unavailable"], marker_count: result.markers.length,
      retry_permitted: false, cleanup_performed: false,
    }) + "\n");
    return;
  }
  validateFrozenInputs(config, systemDependencies);
  const admissionBytes = systemDependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) throw new Error("M4F_RESIDUE_15_ADMISSION_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  process.stdout.write(JSON.stringify({
    ...residueOwnership15Plan(config, admission), config_sha256: residueOwnership15ConfigSha256(config),
    plan_sha256: residueOwnership15PlanSha256(config, admission),
    confirmation: residueOwnership15Confirmation(config, admission),
  }) + "\n");
}

if (import.meta.main) main();
