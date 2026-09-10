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
const TIMEOUT_MS = 30_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const WINDOWS_CMD_LIMIT = 8191;
const COMMAND_LENGTH_LIMIT = 6500;
const OPENSSH_CMD_PREFIX_RESERVE = WINDOWS_CMD_LIMIT - COMMAND_LENGTH_LIMIT;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const WINDOWS_PATH = /^[A-Za-z]:\\[^\r\n]*$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u;

export const FOLLOWUP_PHASES = [
  "start",
  "env-identity",
  "processes-native",
  "cim-system-snapshot",
  "openssh-events",
  "whoami-user",
  "windows-identity",
  "complete",
] as const;

export type FollowupPhase = typeof FOLLOWUP_PHASES[number];

export interface M4fDirectIdentityResidueFollowupConfig {
  schema: "synthia-m4f-direct-identity-residue-followup-config.v2";
  diagnostic_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface FollowupDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  now(): Date;
  monotonicMs(): number;
}

export interface AdmissionConfigFact {
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

export interface FollowupProcessEvidence {
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

export interface FollowupMarker {
  ordinal: number;
  phase: FollowupPhase;
  status: "observed" | "unknown";
  observed_at_utc: string;
  payload: Record<string, unknown> | null;
  error: {
    type: string;
    hresult: number;
    category: string;
    fqid_sha256: string;
    message_sha256: string;
  } | null;
}

export interface FollowupRecord {
  schema: "synthia-m4f-direct-identity-residue-followup-record.v2";
  diagnostic_id: string;
  status: "observed" | "unknown";
  action: "single_session_read_only_identity_residue_followup";
  retry_permitted: false;
  recorded_at_utc: string;
  elapsed_ms: number;
  config_sha256: string;
  source_sha256: string;
  transport_source_sha256: string;
  effective_config_sha256: string;
  remote_script_length: number;
  remote_script_sha256: string;
  remote_payload_encoding: "gzip_base64_utf8";
  remote_compressed_length: number;
  remote_compressed_sha256: string;
  remote_loader_length: number;
  remote_loader_sha256: string;
  remote_command_length: number;
  attempt: 1;
  timeout_ms: 30000;
  stdin_length: 0;
  marker_count: number;
  last_marker_phase: FollowupPhase | null;
  markers: FollowupMarker[];
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
  stdout_truncated_line: boolean;
  process: FollowupProcessEvidence;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  admission_config_before: AdmissionConfigFact;
  admission_config_after: AdmissionConfigFact;
  hardware_action_performed: false;
  process_termination_performed: false;
}

export class IdentityResidueFollowupFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_FAILED"));
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
const MARKER_KEYS = [
  "error",
  "observed_at_utc",
  "ordinal",
  "payload",
  "phase",
  "status",
] as const;
const PROCESS_NAMES = ["sshd.exe", "powershell.exe", "conhost.exe"];

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

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" && UTC_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new IdentityResidueFollowupFailure({
    schema: "synthia-m4f-direct-identity-residue-followup-failure.v2",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight"
      ? "not_started"
      : "read_only_unknown",
    retry_permitted: false,
    ...extra,
  });
}

function safeLocalPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

export function validateIdentityResidueFollowupConfig(
  value: unknown,
): M4fDirectIdentityResidueFollowupConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-identity-residue-followup-config.v2"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !safeLocalPath(config.admission_config_path)
    || typeof config.admission_config_sha256 !== "string" || !HASH.test(config.admission_config_sha256)
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_transport_source_sha256 !== "string"
    || !HASH.test(config.expected_transport_source_sha256)
    || typeof config.expected_effective_config_sha256 !== "string"
    || !HASH.test(config.expected_effective_config_sha256)) {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_CONFIG_INVALID", "config");
  }
  return value as M4fDirectIdentityResidueFollowupConfig;
}

function readBoundAdmissionConfig(config: M4fDirectIdentityResidueFollowupConfig): {
  admission: M4fDirectAdmissionConfig;
  fact: AdmissionConfigFact;
} {
  let fd: number | null = null;
  let stat;
  let bytes: Buffer;
  try {
    const pathBefore = lstatSync(config.admission_config_path);
    fd = openSync(config.admission_config_path, "r");
    const before = fstatSync(fd);
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(config.admission_config_path);
    if (pathBefore.isSymbolicLink()
      || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino) {
      fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_ADMISSION_CONFIG_UNTRUSTED", "local_preflight");
    }
    stat = after;
  } catch (error) {
    if (error instanceof IdentityResidueFollowupFailure) throw error;
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_ADMISSION_CONFIG_UNAVAILABLE", "local_preflight");
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const digest = sha256(bytes);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || bytes.length < 1 || bytes.length > MAX_STREAM_BYTES || digest !== config.admission_config_sha256) {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_ADMISSION_CONFIG_UNTRUSTED", "local_preflight");
  }
  try {
    return {
      admission: validateM4fDirectAdmissionConfig(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      )),
      fact: {
        path: config.admission_config_path,
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
  } catch {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_ADMISSION_CONFIG_INVALID", "local_preflight");
  }
}

function validateSources(
  config: M4fDirectIdentityResidueFollowupConfig,
  dependencies: Pick<FollowupDependencies, "sourceBytes" | "transportSourceBytes">,
): { source: Buffer; transport: Buffer } {
  const source = dependencies.sourceBytes();
  const transport = dependencies.transportSourceBytes();
  if (source.length < 1 || source.length > MAX_STREAM_BYTES
    || sha256(source) !== config.expected_source_sha256) {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_SOURCE_MISMATCH", "local_preflight");
  }
  if (transport.length < 1 || transport.length > MAX_STREAM_BYTES
    || sha256(transport) !== config.expected_transport_source_sha256) {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_TRANSPORT_SOURCE_MISMATCH", "local_preflight");
  }
  return { source, transport };
}

export function buildIdentityResidueFollowupScript(): string {
  return [
    "$ErrorActionPreference=\"Stop\";[Console]::OutputEncoding=[Text.UTF8Encoding]::new()",
    "function SynthiaHash($s){([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s)))-replace\"-\",\"\").ToLower()}",
    "function E($o,$n,$s,$d,$e){$x=[ordered]@{ordinal=$o;phase=$n;status=$s;observed_at_utc=[DateTime]::UtcNow.ToString(\"o\");payload=$d;error=$e};[Console]::Out.WriteLine(($x|ConvertTo-Json -Compress -Depth 7));[Console]::Out.Flush()}",
    "function P($o,$n,$b){try{E $o $n observed (& $b) $null}catch{E $o $n unknown $null ([ordered]@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;category=[string]$_.CategoryInfo.Category;fqid_sha256=SynthiaHash $_.FullyQualifiedErrorId;message_sha256=SynthiaHash $_.Exception.Message})}}",
    "P 1 \"start\" {[ordered]@{current_pid=[int]$PID}}",
    "P 2 \"env-identity\" {[ordered]@{computer_name=$env:COMPUTERNAME;user_domain=$env:USERDOMAIN;user_name=$env:USERNAME}}",
    "P 3 \"processes-native\" {$p=@(Get-Process sshd,powershell,conhost -EA SilentlyContinue);[ordered]@{sshd_count=@($p|? ProcessName -eq sshd).Count;powershell_count=@($p|? ProcessName -eq powershell).Count;conhost_count=@($p|? ProcessName -eq conhost).Count}}",
    "P 4 \"cim-system-snapshot\" {$f=@((Get-CimInstance -ClassName Win32_Process -Filter \"Name='sshd.exe' OR Name='powershell.exe' OR Name='conhost.exe'\")|sort -Property ProcessId|% -Process {$q=$_.CommandLine;$h=$null;if(-not [string]::IsNullOrWhiteSpace([string]$q)){$h=SynthiaHash $q};[ordered]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;name=$_.Name.ToLower();created=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString(\"o\")};command_sha256=$h;class=if($_.ProcessId-eq$PID){\"current\"}elseif($_.Name-eq\"sshd.exe\"){\"sshd\"}else{\"session\"}}});$o=Get-CimInstance -ClassName Win32_OperatingSystem;$s=Get-Service -Name sshd;[ordered]@{current_pid=$PID;processes=$f;resource=[ordered]@{free_kib=[long]$o.FreePhysicalMemory;total_kib=[long]$o.TotalVisibleMemorySize;process_count=[int]$o.NumberOfProcesses};sshd_service=[ordered]@{exists=$true;status=[string]$s.Status;start_type=[string]$s.StartType}}}",
    "P 5 \"openssh-events\" {$e=@((Get-WinEvent -LogName \"OpenSSH/Operational\" -MaxEvents 16)|sort -Property RecordId);$v=@($e|% -Process {[string]$_.RecordId+\"|\"+$_.Id+\"|\"+[int]$_.Level+\"|\"+$_.TimeCreated.ToUniversalTime().ToString(\"o\")});[ordered]@{count=$e.Count;first_id=if($e.Count){[long]$e[0].RecordId};last_id=if($e.Count){[long]$e[-1].RecordId};sha256=SynthiaHash ($v-join\"`n\")}}",
    "P 6 \"whoami-user\" {$p=\"C:\\Windows\\System32\\whoami.exe\";if($env:SystemRoot-ine\"C:\\Windows\"-or-not[IO.File]::Exists($p)){throw \"W_PATH\"};$r=@(& $p /user /fo csv /nh|?{$_});if($LASTEXITCODE-or$r.Count-ne 1){throw \"W_EXEC\"};$q=@(ConvertFrom-Csv -InputObject ($r[0]) -Header n,s);if($q.Count-ne 1-or-not$q.n-or-not$q.s){throw \"W_CSV\"};[ordered]@{exit_status=0;identity_name=$q.n.Trim().ToLowerInvariant();identity_sid=$q.s.Trim()}}",
    "P 7 \"windows-identity\" {$i=[Security.Principal.WindowsIdentity]::GetCurrent();[ordered]@{identity_name=$i.Name.ToLowerInvariant();identity_sid=$i.User.Value}}",
    "P 8 \"complete\" {[ordered]@{complete=$true}}",
    "",
  ].join("\n");
}

export function buildIdentityResidueFollowupLoader(script = buildIdentityResidueFollowupScript()): {
  compressed: Buffer;
  loader: string;
} {
  const compressed = gzipSync(Buffer.from(script, "utf8"), { level: 9 });
  const payload = compressed.toString("base64");
  const loader = "$ProgressPreference=\"SilentlyContinue\";\"Information\",\"Verbose\",\"Debug\",\"Warning\"|%{sv ($_+\"Preference\") $ProgressPreference};$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String(\"" + payload
    + "\")),[IO.Compression.CompressionMode]0);&([ScriptBlock]::Create([IO.StreamReader]::new($g).ReadToEnd()))";
  return { compressed, loader };
}

export function buildIdentityResidueFollowupCommand(script = buildIdentityResidueFollowupScript()): string {
  const { loader } = buildIdentityResidueFollowupLoader(script);
  const encoded = Buffer.from(loader, "utf16le").toString("base64");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + encoded;
  if (command.length > COMMAND_LENGTH_LIMIT) {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_COMMAND_TOO_LONG", "local_preflight", {
      command_length: command.length,
      command_length_limit: COMMAND_LENGTH_LIMIT,
      reserved_prefix_characters: OPENSSH_CMD_PREFIX_RESERVE,
    });
  }
  return command;
}

function validProcessList(value: unknown, cim: boolean): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 512) return false;
  const pids = new Set<number>();
  for (const item of value) {
    const fact = object(item);
    const keys = cim
      ? ["class", "command_sha256", "created", "name", "parent_pid", "pid"]
      : [];
    if (!fact || !exactKeys(fact, keys) || !safeInteger(fact.pid, 1) || pids.has(fact.pid)
      || !PROCESS_NAMES.includes(String(fact.name).toLowerCase())) return false;
    pids.add(fact.pid);
    if (cim) {
      if (!safeInteger(fact.parent_pid)
        || (fact.created !== null && !utcTimestamp(fact.created))
        || (fact.command_sha256 !== null
          && (typeof fact.command_sha256 !== "string" || !HASH.test(fact.command_sha256)))
        || (fact.class !== "current" && fact.class !== "sshd" && fact.class !== "session")) return false;
    }
  }
  return true;
}

function validObservedPayload(
  phase: FollowupPhase,
  value: unknown,
  admission: M4fDirectAdmissionConfig,
): value is Record<string, unknown> {
  const payload = object(value);
  if (!payload) return false;
  if (phase === "start") {
    return exactKeys(payload, ["current_pid"]) && safeInteger(payload.current_pid, 1);
  }
  if (phase === "env-identity") {
    const [, user] = admission.target.identity_name.split("\\");
    return exactKeys(payload, ["computer_name", "user_domain", "user_name"])
      && typeof payload.computer_name === "string"
      && payload.computer_name.toLowerCase() === admission.target.computer_name.toLowerCase()
      && typeof payload.user_domain === "string"
      && payload.user_domain.length > 0 && payload.user_domain.length <= 256
      && typeof payload.user_name === "string" && payload.user_name.toLowerCase() === user;
  }
  if (phase === "processes-native") {
    return exactKeys(payload, ["conhost_count", "powershell_count", "sshd_count"])
      && safeInteger(payload.conhost_count) && safeInteger(payload.powershell_count, 1)
      && safeInteger(payload.sshd_count, 1);
  }
  if (phase === "cim-system-snapshot") {
    const resource = object(payload.resource);
    const service = object(payload.sshd_service);
    return exactKeys(payload, ["current_pid", "processes", "resource", "sshd_service"])
      && safeInteger(payload.current_pid, 1) && validProcessList(payload.processes, true)
      && (payload.processes as Array<Record<string, unknown>>)
        .some((fact) => fact.class === "current" && fact.pid === payload.current_pid && fact.name === "powershell.exe")
      && !!resource && exactKeys(resource, ["free_kib", "process_count", "total_kib"])
      && safeInteger(resource.free_kib) && safeInteger(resource.total_kib, 1)
      && resource.free_kib <= resource.total_kib && safeInteger(resource.process_count, 1)
      && !!service && exactKeys(service, ["exists", "start_type", "status"])
      && typeof service.exists === "boolean"
      && (service.exists
        ? typeof service.status === "string" && service.status.length > 0
          && typeof service.start_type === "string" && service.start_type.length > 0
        : service.status === null && service.start_type === null);
  }
  if (phase === "openssh-events") {
    const count = payload.count;
    return exactKeys(payload, ["count", "first_id", "last_id", "sha256"])
      && safeInteger(count) && count <= 16 && typeof payload.sha256 === "string" && HASH.test(payload.sha256)
      && (count === 0
        ? payload.first_id === null && payload.last_id === null
        : safeInteger(payload.first_id, 1) && safeInteger(payload.last_id, 1)
          && payload.first_id <= payload.last_id);
  }
  if (phase === "whoami-user") {
    return exactKeys(payload, ["exit_status", "identity_name", "identity_sid"])
      && payload.exit_status === 0
      && payload.identity_name === admission.target.identity_name
      && payload.identity_sid === admission.target.identity_sid;
  }
  if (phase === "windows-identity") {
    return exactKeys(payload, ["identity_name", "identity_sid"])
      && payload.identity_name === admission.target.identity_name
      && payload.identity_sid === admission.target.identity_sid;
  }
  return exactKeys(payload, ["complete"]) && payload.complete === true;
}

export function parseIdentityResidueMarkers(
  raw: Buffer,
  _admission: M4fDirectAdmissionConfig,
): FollowupMarker[] | null {
  const lastNewline = raw.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  const completePrefix = raw.subarray(0, lastNewline + 1);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(completePrefix);
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > FOLLOWUP_PHASES.length) return null;
  const markers: FollowupMarker[] = [];
  try {
    for (let index = 0; index < lines.length; index += 1) {
      const value = object(JSON.parse(lines[index]!));
      const expectedPhase = FOLLOWUP_PHASES[index]!;
      if (!value || !exactKeys(value, MARKER_KEYS)
        || value.ordinal !== index + 1 || value.phase !== expectedPhase
        || (value.status !== "observed" && value.status !== "unknown")
        || !utcTimestamp(value.observed_at_utc)) return null;
      if (value.status === "observed") {
        if (value.error !== null || !object(value.payload)) return null;
      } else {
        const error = object(value.error);
        if (value.payload !== null || !error || !exactKeys(error, [
          "category", "fqid_sha256", "hresult", "message_sha256", "type",
        ])
          || typeof error.type !== "string" || error.type.length < 1 || error.type.length > 256
          || typeof error.category !== "string"
          || error.category.length < 1 || error.category.length > 64
          || typeof error.fqid_sha256 !== "string" || !HASH.test(error.fqid_sha256)
          || typeof error.message_sha256 !== "string" || !HASH.test(error.message_sha256)
          || typeof error.hresult !== "number" || !Number.isSafeInteger(error.hresult)) return null;
      }
      markers.push(value as unknown as FollowupMarker);
    }
  } catch {
    return null;
  }
  return markers;
}

function processEvidence(raw: RawProcessResult): FollowupProcessEvidence {
  const timedOut = raw.errorCode === "ETIMEDOUT";
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: timedOut,
    outcome_ambiguous: timedOut || raw.signal !== null || raw.errorCode !== null || raw.status !== 0,
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

export function identityResidueFollowupConfirmation(rawConfig: unknown): string {
  const config = validateIdentityResidueFollowupConfig(rawConfig);
  return "SYNTHIA_M4F_DIRECT_IDENTITY_RESIDUE_SINGLE_READ_ONLY:"
    + config.diagnostic_id + ":" + sha256(Buffer.from(canonicalJson(config) + "\n", "utf8"));
}

export function planIdentityResidueFollowup(
  rawConfig: unknown,
  dependencies: Pick<FollowupDependencies, "sourceBytes" | "transportSourceBytes"> = systemDependencies,
): Record<string, unknown> {
  const config = validateIdentityResidueFollowupConfig(rawConfig);
  validateSources(config, dependencies);
  const bound = readBoundAdmissionConfig(config);
  const script = Buffer.from(buildIdentityResidueFollowupScript(), "ascii");
  const packed = buildIdentityResidueFollowupLoader(script.toString("ascii"));
  const command = buildIdentityResidueFollowupCommand(script.toString("ascii"));
  return {
    schema: "synthia-m4f-direct-identity-residue-followup-plan.v2",
    status: "planned_not_executed",
    diagnostic_id: config.diagnostic_id,
    target_host: bound.admission.target.host,
    target_user: bound.admission.target.user,
    target_computer: bound.admission.target.computer_name,
    target_identity_name: bound.admission.target.identity_name,
    target_identity_sid: bound.admission.target.identity_sid,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    phase_order: FOLLOWUP_PHASES,
    attempt_count: 1,
    timeout_ms: TIMEOUT_MS,
    maximum_remote_elapsed_ms: TIMEOUT_MS,
    remote_script_length: script.length,
    remote_script_sha256: sha256(script),
    remote_payload_encoding: "gzip_base64_utf8",
    remote_compressed_length: packed.compressed.length,
    remote_compressed_sha256: sha256(packed.compressed),
    remote_loader_length: Buffer.byteLength(packed.loader, "ascii"),
    remote_loader_sha256: sha256(Buffer.from(packed.loader, "ascii")),
    remote_command_length: command.length,
    remote_command_length_limit: COMMAND_LENGTH_LIMIT,
    windows_cmd_limit: WINDOWS_CMD_LIMIT,
    reserved_prefix_characters: OPENSSH_CMD_PREFIX_RESERVE,
    admission_config_fact: bound.fact,
    confirmation: identityResidueFollowupConfirmation(config),
    network_attempted: false,
    hardware_action_performed: false,
    process_termination_performed: false,
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

export function recordIdentityResidueFollowup(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: FollowupDependencies = systemDependencies,
): FollowupRecord {
  const config = validateIdentityResidueFollowupConfig(rawConfig);
  if (confirmation !== identityResidueFollowupConfirmation(config)) {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_CONFIRMATION_REQUIRED", "local_preflight");
  }
  const sourcesBefore = validateSources(config, dependencies);
  const boundBefore = readBoundAdmissionConfig(config);
  const admission = boundBefore.admission;
  const inputsBefore = captureM4fDirectTransportInputs(admission);
  const script = Buffer.from(buildIdentityResidueFollowupScript(), "ascii");
  const packed = buildIdentityResidueFollowupLoader(script.toString("ascii"));
  const command = buildIdentityResidueFollowupCommand(script.toString("ascii"));
  const absolute = resolve(evidenceDirectory);
  try {
    makeDirectory(absolute);
  } catch {
    fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_EVIDENCE_DIRECTORY_INVALID", "local_preflight");
  }
  let remoteProcess: FollowupProcessEvidence | null = null;
  try {
    writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "remote-script.ps1", script);
    writeEvidence(absolute, "remote-loader.ps1", packed.loader);
    writeEvidence(absolute, "remote-payload.gzip", packed.compressed);
    const effective = dependencies.spawn(SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), 15_000);
    writeEvidence(absolute, "ssh-effective.stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective.stderr.raw", effective.stderr);
    const effectiveProcess = processEvidence(effective);
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(effectiveProcess, null, 2) + "\n");
    const effectiveHash = sha256(effective.stdout);
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0 || effectiveHash !== config.expected_effective_config_sha256) {
      fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_EFFECTIVE_CONFIG_FAILED", "local_preflight", {
        process: effectiveProcess,
        observed_effective_config_sha256: effectiveHash,
      });
    }
    try {
      auditDirectSshEffectiveConfig(effective.stdout, admission);
    } catch {
      fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_EFFECTIVE_CONFIG_MISMATCH", "local_preflight");
    }
    const sourcesCurrent = validateSources(config, dependencies);
    const boundCurrent = readBoundAdmissionConfig(config);
    const inputsCurrent = captureM4fDirectTransportInputs(admission, "network");
    if (!sourcesBefore.source.equals(sourcesCurrent.source)
      || !sourcesBefore.transport.equals(sourcesCurrent.transport)
      || canonicalJson(boundBefore.fact) !== canonicalJson(boundCurrent.fact)
      || canonicalJson(inputsBefore) !== canonicalJson(inputsCurrent)) {
      fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_LOCAL_INPUT_DRIFT", "network");
    }
    const startedMs = dependencies.monotonicMs();
    const raw = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(admission), TARGET_HOST, command],
      Buffer.alloc(0),
      TIMEOUT_MS,
    );
    const elapsedMs = Math.max(0, Math.round(dependencies.monotonicMs() - startedMs));
    remoteProcess = processEvidence(raw);
    writeEvidence(absolute, "stdout.raw", raw.stdout);
    writeEvidence(absolute, "stderr.raw", raw.stderr);
    writeEvidence(absolute, "remote-process.json", JSON.stringify(remoteProcess, null, 2) + "\n");
    const sourcesAfter = validateSources(config, dependencies);
    const boundAfter = readBoundAdmissionConfig(config);
    const inputsAfter = captureM4fDirectTransportInputs(admission, "network");
    if (!sourcesBefore.source.equals(sourcesAfter.source)
      || !sourcesBefore.transport.equals(sourcesAfter.transport)
      || canonicalJson(boundBefore.fact) !== canonicalJson(boundAfter.fact)
      || canonicalJson(inputsBefore) !== canonicalJson(inputsAfter)) {
      fail("M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_LOCAL_INPUT_DRIFT", "network");
    }
    const markers = parseIdentityResidueMarkers(raw.stdout, admission);
    const lastNewline = raw.stdout.lastIndexOf(0x0a);
    const trailingFragment = lastNewline < 0
      ? raw.stdout
      : raw.stdout.subarray(lastNewline + 1);
    const processOk = raw.status === 0 && raw.signal === null && raw.errorCode === null
      && raw.stderr.length === 0;
    const outputComplete = markers !== null && markers.length === FOLLOWUP_PHASES.length
      && markers.every((marker) => marker.status === "observed")
      && markers.every((marker) => validObservedPayload(marker.phase, marker.payload, admission))
      && trailingFragment.length === 0;
    const result: FollowupRecord = {
      schema: "synthia-m4f-direct-identity-residue-followup-record.v2",
      diagnostic_id: config.diagnostic_id,
      status: processOk && outputComplete ? "observed" : "unknown",
      action: "single_session_read_only_identity_residue_followup",
      retry_permitted: false,
      recorded_at_utc: dependencies.now().toISOString(),
      elapsed_ms: elapsedMs,
      config_sha256: sha256(Buffer.from(canonicalJson(config) + "\n", "utf8")),
      source_sha256: config.expected_source_sha256,
      transport_source_sha256: config.expected_transport_source_sha256,
      effective_config_sha256: effectiveHash,
      remote_script_length: script.length,
      remote_script_sha256: sha256(script),
      remote_payload_encoding: "gzip_base64_utf8",
      remote_compressed_length: packed.compressed.length,
      remote_compressed_sha256: sha256(packed.compressed),
      remote_loader_length: Buffer.byteLength(packed.loader, "ascii"),
      remote_loader_sha256: sha256(Buffer.from(packed.loader, "ascii")),
      remote_command_length: command.length,
      attempt: 1,
      timeout_ms: TIMEOUT_MS,
      stdin_length: 0,
      marker_count: markers?.length ?? 0,
      last_marker_phase: markers?.at(-1)?.phase ?? null,
      markers: markers ?? [],
      trailing_fragment_length: trailingFragment.length,
      trailing_fragment_sha256: sha256(trailingFragment),
      stdout_truncated_line: trailingFragment.length > 0,
      process: remoteProcess,
      transport_inputs_before: inputsBefore,
      transport_inputs_after: inputsAfter,
      admission_config_before: boundBefore.fact,
      admission_config_after: boundAfter.fact,
      hardware_action_performed: false,
      process_termination_performed: false,
    };
    writeEvidence(absolute, "diagnostic-record.json", JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    const detail = error instanceof IdentityResidueFollowupFailure
      ? error.detail
      : {
        schema: "synthia-m4f-direct-identity-residue-followup-failure.v2",
        code: "M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_UNEXPECTED",
        stage: "unknown",
        remote_effect_state: remoteProcess === null ? "not_started" : "read_only_unknown",
        retry_permitted: false,
      };
    try {
      writeEvidence(absolute, "diagnostic-failure.json", JSON.stringify({
        ...detail,
        diagnostic_id: config.diagnostic_id,
        remote_process: remoteProcess,
        source_sha256: config.expected_source_sha256,
        transport_source_sha256: config.expected_transport_source_sha256,
        admission_config_before: boundBefore.fact,
        hardware_action_performed: false,
        process_termination_performed: false,
      }, null, 2) + "\n");
    } catch {
      // Preserve the original failure and any already frozen evidence.
    }
    throw error;
  }
}

export function spawnBoundedFollowupProcess(
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

const systemDependencies: FollowupDependencies = {
  spawn: spawnBoundedFollowupProcess,
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
      process.stdout.write(JSON.stringify(planIdentityResidueFollowup(raw)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-read-only" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(recordIdentityResidueFollowup(raw, args[4]!, args[6]!)) + "\n");
      return;
    }
    console.error("usage: bun connector/scripts/m4f-direct-identity-residue-followup.ts --plan --config <config.json>");
    console.error("   or: bun connector/scripts/m4f-direct-identity-residue-followup.ts --execute-read-only --config <config.json> --confirmation <exact> --evidence <new-directory>");
    process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof IdentityResidueFollowupFailure
      ? error.detail
      : {
        schema: "synthia-m4f-direct-identity-residue-followup-failure.v2",
        code: "M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_UNEXPECTED",
        stage: "unknown",
        remote_effect_state: "read_only_unknown",
        retry_permitted: false,
      };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();

export const M4F_DIRECT_IDENTITY_RESIDUE_FOLLOWUP_GUARDS = {
  targetHost: TARGET_HOST,
  timeoutMs: TIMEOUT_MS,
  remoteAttemptCount: 1,
  maximumRemoteElapsedMs: TIMEOUT_MS,
  windowsCmdLimit: WINDOWS_CMD_LIMIT,
  commandLengthLimit: COMMAND_LENGTH_LIMIT,
  reservedPrefixCharacters: OPENSSH_CMD_PREFIX_RESERVE,
  topology: "single_ssh_direct_encoded_command_empty_stdin",
  keepaliveEnabled: false,
  hardwareActionPermitted: false,
  processTerminationPermitted: false,
} as const;
