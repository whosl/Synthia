import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
const COMMAND_LIMIT = 7_000;
const ADJUDICATION_SHA256 = "f575dae6bafa812de57cf3d82d1b920ec96bc74e6c7ad2e0fedbac018b27f3a7";
const ADJUDICATION_REVIEW_SHA256 = "9cd47bff11c7c8c635c23411cd5d966079b6387c69e3139e8c2a47e85d303447";
const OBSERVATION_SEMANTIC_SHA256 = "269ac2c43af54fee3c7aa1e9d49e1848bb8bf310f10a3165182f7b6773e6f1b3";
const ADMISSION_RECORD_SHA256 = "856edffdde9094c95e76aba062b8919c47b44cdeaae60a388cba11b3f7b5657e";
const ADMISSION_REVIEW_SHA256 = "4628ad24fb22fedf4d3989ec9482be79ea3316a18b3b76b3a52328d61c369150";
const POWERSHELL_SHA256 = "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc";
const CMD_SHA256 = "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e";
const CONHOST_SHA256 = "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51";

export type Candidate19Candidate = "candidate09" | "candidate10";
export type Candidate19Role = "powershell" | "cmd" | "conhost";

export interface Candidate19Target {
  ordinal: number;
  candidate: Candidate19Candidate;
  role: Candidate19Role;
  pid: number;
  parent_pid: number;
  name: "powershell.exe" | "cmd.exe" | "conhost.exe";
  creation_utc: string;
  session_id: 0;
  command_sha256: string;
  natural_exit_after_ordinal: 1 | 4 | null;
}

export interface Candidate19WorkerBinding {
  pid: 13644;
  parent_pid: 2712;
  name: "node.exe";
  executable_path: "D:\\softwares\\Nodejs\\node.exe";
  creation_utc: "2026-08-14T08:02:31.2903580Z";
}

export interface Candidate19ListenerBinding {
  local_address: "0.0.0.0";
  local_port: 8443;
  owning_pid: 13644;
}

export interface Candidate19ScriptConfig {
  schema: "synthia-m4f-candidate19-script-config.v1";
  cleanup_id: string;
  target_computer: "DESKTOP-DVFFB09";
  target_identity_name: "desktop-dvffb09\\admin";
  target_identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001";
  adjudication_record_path: string;
  adjudication_record_sha256: typeof ADJUDICATION_SHA256;
  adjudication_review_path: string;
  adjudication_review_sha256: typeof ADJUDICATION_REVIEW_SHA256;
  observation_semantic_sha256: typeof OBSERVATION_SEMANTIC_SHA256;
  admission_record_path: string;
  admission_record_sha256: typeof ADMISSION_RECORD_SHA256;
  admission_review_path: string;
  admission_review_sha256: typeof ADMISSION_REVIEW_SHA256;
  targets: Candidate19Target[];
  protected_worker: Candidate19WorkerBinding;
  protected_listeners: Candidate19ListenerBinding[];
  effect_wait_ms: number;
  remote_deadline_seconds: number;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_transport_source_sha256: string;
}

export interface Candidate19BuiltPayload {
  business_script: string;
  compressed_business_script: Buffer;
  outer_loader: string;
  remote_command: string;
  business_script_sha256: string;
  outer_loader_sha256: string;
  remote_command_sha256: string;
}

export interface Candidate19GzipBindingProbe {
  schema: "synthia-m4f-candidate19-gzip-binding-probe-plan.v1";
  probe_id: "m4f-candidate19-gzip-binding-probe-v2";
  status: "planned_not_executed";
  stdin: Buffer;
  stdin_length: 4936;
  stdin_sha256: "beb0e6233bdab365c70306a49b7b698104176f8c604f99e9ed28ee015096b924";
  script: string;
  command: string;
  command_length: number;
  script_sha256: string;
  expected_business_sha256: "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c";
  expected_business_length: 13856;
  target_body_embedded: false;
  script_block_created: true;
  target_body_invoked: false;
  network_attempted: false;
  ssh_attempted: false;
  remote_execution_attempted: false;
  process_mutation_performed: false;
  file_mutation_performed: false;
  cleanup_performed: false;
}

export interface Candidate19Marker {
  schema: "synthia-m4f-candidate19-marker.v1";
  cleanup_id: string;
  phase: "start" | "preflight" | "effect_start" | "effect_result" | "natural_exit"
    | "postflight" | "complete" | "failure";
  status: "observed" | "started" | "complete" | "partial_unknown";
  observed_at_utc: string;
  payload: Record<string, unknown>;
}

export interface Candidate19MarkerPrefix {
  markers: Candidate19Marker[];
  valid_prefix: Buffer;
  trailing_fragment: Buffer;
  valid_prefix_length: number;
  valid_prefix_sha256: string;
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
  effect_start_ordinals: number[];
  effect_result_ordinals: number[];
  complete: boolean;
}

const CONFIG_KEYS = [
  "adjudication_record_path", "adjudication_record_sha256", "adjudication_review_path",
  "adjudication_review_sha256", "admission_record_path", "admission_record_sha256",
  "admission_review_path", "admission_review_sha256", "cleanup_id", "effect_wait_ms", "expected_source_sha256",
  "expected_test_source_sha256", "expected_transport_source_sha256", "observation_semantic_sha256",
  "protected_listeners", "protected_worker", "remote_deadline_seconds", "schema", "target_computer", "target_identity_name",
  "target_identity_sid", "targets",
] as const;
const TARGET_KEYS = [
  "candidate", "command_sha256", "creation_utc", "name", "natural_exit_after_ordinal",
  "ordinal", "parent_pid", "pid", "role", "session_id",
] as const;
const WORKER_KEYS = ["creation_utc", "executable_path", "name", "parent_pid", "pid"] as const;
const LISTENER_KEYS = ["local_address", "local_port", "owning_pid"] as const;
const MARKER_KEYS = ["cleanup_id", "observed_at_utc", "payload", "phase", "schema", "status"] as const;
const CORE_KEYS = ["command_sha256", "creation_utc", "name", "parent_pid", "pid", "session_id"] as const;
const PROTECTION_KEYS = [
  "cores", "listeners", "worker_raw_handle", "worker_runtime_command_sha256",
] as const;

export const CANDIDATE19_WORKER: Candidate19WorkerBinding = {
  pid: 13644, parent_pid: 2712, name: "node.exe",
  executable_path: "D:\\softwares\\Nodejs\\node.exe",
  creation_utc: "2026-08-14T08:02:31.2903580Z",
};

export const CANDIDATE19_LISTENERS: Candidate19ListenerBinding[] = [{
  local_address: "0.0.0.0", local_port: 8443, owning_pid: 13644,
}];

export const CANDIDATE19_TARGETS: Candidate19Target[] = [
  {
    ordinal: 1, candidate: "candidate09", role: "powershell", pid: 44768, parent_pid: 56576,
    name: "powershell.exe", creation_utc: "2026-08-28T16:25:51.0137884Z", session_id: 0,
    command_sha256: POWERSHELL_SHA256, natural_exit_after_ordinal: null,
  },
  {
    ordinal: 2, candidate: "candidate09", role: "cmd", pid: 56576, parent_pid: 6100,
    name: "cmd.exe", creation_utc: "2026-08-28T16:25:50.9870650Z", session_id: 0,
    command_sha256: CMD_SHA256, natural_exit_after_ordinal: 1,
  },
  {
    ordinal: 3, candidate: "candidate09", role: "conhost", pid: 64484, parent_pid: 56576,
    name: "conhost.exe", creation_utc: "2026-08-28T16:25:50.9908927Z", session_id: 0,
    command_sha256: CONHOST_SHA256, natural_exit_after_ordinal: 1,
  },
  {
    ordinal: 4, candidate: "candidate10", role: "powershell", pid: 58908, parent_pid: 67048,
    name: "powershell.exe", creation_utc: "2026-08-28T17:12:52.5233863Z", session_id: 0,
    command_sha256: POWERSHELL_SHA256, natural_exit_after_ordinal: null,
  },
  {
    ordinal: 5, candidate: "candidate10", role: "cmd", pid: 67048, parent_pid: 24260,
    name: "cmd.exe", creation_utc: "2026-08-28T17:12:52.4952390Z", session_id: 0,
    command_sha256: CMD_SHA256, natural_exit_after_ordinal: 4,
  },
  {
    ordinal: 6, candidate: "candidate10", role: "conhost", pid: 66316, parent_pid: 67048,
    name: "conhost.exe", creation_utc: "2026-08-28T17:12:52.5009297Z", session_id: 0,
    command_sha256: CONHOST_SHA256, natural_exit_after_ordinal: 4,
  },
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJson19(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson19).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson19(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/u.test(value);
}

function fail(): never {
  throw new Error("M4F_CANDIDATE19_SCRIPT_CONFIG_INVALID");
}

export function validateCandidate19ScriptConfig(value: unknown): Candidate19ScriptConfig {
  const config = object(value);
  const worker = object(config?.protected_worker);
  const listener = Array.isArray(config?.protected_listeners) && config.protected_listeners.length === 1
    ? object(config.protected_listeners[0]) : null;
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-candidate19-script-config.v1"
    || typeof config.cleanup_id !== "string" || !SAFE_ID.test(config.cleanup_id)
    || config.target_computer !== "DESKTOP-DVFFB09"
    || config.target_identity_name !== "desktop-dvffb09\\admin"
    || config.target_identity_sid !== "S-1-5-21-2561815994-3878748218-1101284459-1001"
    || !absolutePath(config.adjudication_record_path) || !absolutePath(config.adjudication_review_path)
    || !absolutePath(config.admission_record_path) || !absolutePath(config.admission_review_path)
    || config.adjudication_record_sha256 !== ADJUDICATION_SHA256
    || config.adjudication_review_sha256 !== ADJUDICATION_REVIEW_SHA256
    || config.observation_semantic_sha256 !== OBSERVATION_SEMANTIC_SHA256
    || config.admission_record_sha256 !== ADMISSION_RECORD_SHA256
    || config.admission_review_sha256 !== ADMISSION_REVIEW_SHA256
    || !Array.isArray(config.targets) || config.targets.length !== 6
    || !worker || !exactKeys(worker, WORKER_KEYS)
    || canonicalJson19(worker) !== canonicalJson19(CANDIDATE19_WORKER)
    || !listener || !exactKeys(listener, LISTENER_KEYS)
    || canonicalJson19(listener) !== canonicalJson19(CANDIDATE19_LISTENERS[0])
    || config.effect_wait_ms !== 5_000 || config.remote_deadline_seconds !== 35
    || [config.expected_source_sha256, config.expected_test_source_sha256,
      config.expected_transport_source_sha256].some((item) => typeof item !== "string" || !HASH.test(item))) fail();
  for (let index = 0; index < CANDIDATE19_TARGETS.length; index += 1) {
    const target = object(config.targets[index]);
    const expected = CANDIDATE19_TARGETS[index]!;
    if (!target || !exactKeys(target, TARGET_KEYS) || canonicalJson19(target) !== canonicalJson19(expected)
      || !UTC.test(String(target.creation_utc))) fail();
  }
  return value as Candidate19ScriptConfig;
}

export function candidate19StartToken(target: Candidate19Target): string {
  return sha256([
    target.ordinal, target.candidate, target.role, target.pid, target.parent_pid, target.name,
    target.creation_utc, target.session_id, target.command_sha256,
  ].join("|"));
}

function remotePlan(config: Candidate19ScriptConfig): Record<string, unknown> {
  return {
    i: config.cleanup_id,
    c: config.target_computer,
    n: config.target_identity_name,
    s: config.target_identity_sid,
    d: config.remote_deadline_seconds,
    w: config.effect_wait_ms,
    o: config.observation_semantic_sha256,
    a: config.admission_record_sha256,
    t: config.targets.map((target) => [
      target.ordinal, target.candidate, target.role, target.pid, target.parent_pid, target.name,
      target.creation_utc, target.session_id, target.command_sha256,
      target.natural_exit_after_ordinal, candidate19StartToken(target),
    ]),
    p: [
      config.protected_worker.pid, config.protected_worker.parent_pid, config.protected_worker.name,
      config.protected_worker.executable_path, config.protected_worker.creation_utc,
    ],
    l: config.protected_listeners.map((listener) => [
      listener.local_address, listener.local_port, listener.owning_pid,
    ]),
  };
}

export function buildCandidate19BusinessScript(rawConfig: unknown): string {
  const config = validateCandidate19ScriptConfig(rawConfig);
  const encoded = Buffer.from(JSON.stringify(remotePlan(config)), "utf8").toString("base64");
  const source = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `$SynthiaM4fCandidate19Config=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json)`,
    "$SynthiaM4fCandidate19Deadline=[DateTime]::UtcNow.AddSeconds([int]$SynthiaM4fCandidate19Config.d)",
    "$SynthiaM4fCandidate19States=New-Object Collections.Generic.List[object];$SynthiaM4fCandidate19Retained=New-Object Collections.Generic.List[object];$SynthiaM4fCandidate19Protected=@{};$SynthiaM4fCandidate19PowerResults=@{}",
    "$SynthiaM4fCandidate19WorkerProcess=$null;$SynthiaM4fCandidate19WorkerSafeHandle=$null;$SynthiaM4fCandidate19WorkerAddRef=$false;$SynthiaM4fCandidate19Phase='before_start';$SynthiaM4fCandidate19EffectResultPending=$false",
    "function Write-SynthiaM4fCandidate19Marker([string]$Phase,[string]$Status,[object]$Payload){$SynthiaM4fCandidate19Marker=[ordered]@{schema='synthia-m4f-candidate19-marker.v1';cleanup_id=$SynthiaM4fCandidate19Config.i;phase=$Phase;status=$Status;observed_at_utc=[DateTime]::UtcNow.ToString('o');payload=$Payload};[Console]::Out.WriteLine(($SynthiaM4fCandidate19Marker|ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush()}",
    "function Get-SynthiaM4fCandidate19Sha256([string]$Value){([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) -replace '-','').ToLowerInvariant()}",
    "function Get-SynthiaM4fCandidate19NormalizedTicks([DateTime]$Value){$SynthiaM4fCandidate19Ticks=$Value.ToUniversalTime().Ticks;[long]($SynthiaM4fCandidate19Ticks-($SynthiaM4fCandidate19Ticks%10))}",
    "function Get-SynthiaM4fCandidate19ProcessCore([object]$ProcessRow){$SynthiaM4fCandidate19Creation=$ProcessRow.CreationDate.ToUniversalTime().ToString('o');$SynthiaM4fCandidate19Name=$ProcessRow.Name.ToLowerInvariant();$SynthiaM4fCandidate19CommandHash=Get-SynthiaM4fCandidate19Sha256 ([string]$ProcessRow.CommandLine);[ordered]@{pid=[int]$ProcessRow.ProcessId;parent_pid=[int]$ProcessRow.ParentProcessId;name=$SynthiaM4fCandidate19Name;creation_utc=$SynthiaM4fCandidate19Creation;session_id=[int]$ProcessRow.SessionId;command_sha256=$SynthiaM4fCandidate19CommandHash}}",
    "function Test-SynthiaM4fCandidate19TargetCore([object]$Core,[object]$Target){$Core.pid -eq [int]$Target[3] -and $Core.parent_pid -eq [int]$Target[4] -and $Core.name -ceq [string]$Target[5] -and $Core.creation_utc -ceq [string]$Target[6] -and $Core.session_id -eq [int]$Target[7] -and $Core.command_sha256 -ceq [string]$Target[8]}",
    "function Get-SynthiaM4fCandidate19SnapshotByPid(){$SynthiaM4fCandidate19Snapshot=@(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop);$SynthiaM4fCandidate19ByPid=@{};foreach($SynthiaM4fCandidate19Row in $SynthiaM4fCandidate19Snapshot){$SynthiaM4fCandidate19ByPid[[int]$SynthiaM4fCandidate19Row.ProcessId]=$SynthiaM4fCandidate19Row};[ordered]@{rows=$SynthiaM4fCandidate19Snapshot;by_pid=$SynthiaM4fCandidate19ByPid}}",
    "function Get-SynthiaM4fCandidate19Listeners(){$SynthiaM4fCandidate19Rows=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'LocalPort = 8443 AND State = 2' -ErrorAction Stop|Sort-Object LocalAddress,LocalPort,OwningProcess);@($SynthiaM4fCandidate19Rows|ForEach-Object{[ordered]@{local_address=[string]$_.LocalAddress;local_port=[int]$_.LocalPort;owning_pid=[int]$_.OwningProcess}})}",
    "function Test-SynthiaM4fCandidate19Protection([object]$ByPid){if($SynthiaM4fCandidate19WorkerProcess.HasExited -or $SynthiaM4fCandidate19WorkerSafeHandle.IsInvalid -or $SynthiaM4fCandidate19WorkerSafeHandle.IsClosed -or [string]$SynthiaM4fCandidate19WorkerSafeHandle.DangerousGetHandle().ToInt64() -cne [string]$SynthiaM4fCandidate19WorkerRawHandle -or (Get-SynthiaM4fCandidate19NormalizedTicks $SynthiaM4fCandidate19WorkerProcess.StartTime) -ne (Get-SynthiaM4fCandidate19NormalizedTicks ([DateTime][string]$SynthiaM4fCandidate19Config.p[4]))){return $false};foreach($SynthiaM4fCandidate19ProtectedKey in $SynthiaM4fCandidate19Protected.Keys){$SynthiaM4fCandidate19ProtectedRow=$ByPid[[int]$SynthiaM4fCandidate19ProtectedKey];if($null -eq $SynthiaM4fCandidate19ProtectedRow -or ((Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19ProtectedRow|ConvertTo-Json -Compress) -cne [string]$SynthiaM4fCandidate19Protected[$SynthiaM4fCandidate19ProtectedKey])){return $false}};$SynthiaM4fCandidate19Listeners=@(Get-SynthiaM4fCandidate19Listeners);return (($SynthiaM4fCandidate19Listeners|ConvertTo-Json -Compress) -ceq (@([ordered]@{local_address=[string]$SynthiaM4fCandidate19Config.l[0][0];local_port=[int]$SynthiaM4fCandidate19Config.l[0][1];owning_pid=[int]$SynthiaM4fCandidate19Config.l[0][2]})|ConvertTo-Json -Compress))}",
    "try{",
    "$SynthiaM4fCandidate19Phase='start';Write-SynthiaM4fCandidate19Marker 'start' 'observed' ([ordered]@{current_pid=$PID;target_count=6;observation_semantic_sha256=$SynthiaM4fCandidate19Config.o;admission_record_sha256=$SynthiaM4fCandidate19Config.a})",
    "$SynthiaM4fCandidate19Identity=[Security.Principal.WindowsIdentity]::GetCurrent();if($env:COMPUTERNAME -cne $SynthiaM4fCandidate19Config.c -or $SynthiaM4fCandidate19Identity.Name.ToLowerInvariant() -cne $SynthiaM4fCandidate19Config.n -or $SynthiaM4fCandidate19Identity.User.Value -cne $SynthiaM4fCandidate19Config.s){throw 'IDENTITY'}",
    "$SynthiaM4fCandidate19Phase='preflight_snapshot';$SynthiaM4fCandidate19SnapshotResult=Get-SynthiaM4fCandidate19SnapshotByPid;$SynthiaM4fCandidate19All=$SynthiaM4fCandidate19SnapshotResult.rows;$SynthiaM4fCandidate19ByPid=$SynthiaM4fCandidate19SnapshotResult.by_pid",
    "$SynthiaM4fCandidate19AncestorPid=[int]$PID;$SynthiaM4fCandidate19AncestorSeen=@{};while($SynthiaM4fCandidate19AncestorPid -gt 0){if($SynthiaM4fCandidate19AncestorSeen.ContainsKey($SynthiaM4fCandidate19AncestorPid) -or -not $SynthiaM4fCandidate19ByPid.ContainsKey($SynthiaM4fCandidate19AncestorPid)){throw 'ANCESTOR_CHAIN'};$SynthiaM4fCandidate19AncestorSeen[$SynthiaM4fCandidate19AncestorPid]=$true;$SynthiaM4fCandidate19AncestorCore=Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19ByPid[$SynthiaM4fCandidate19AncestorPid];$SynthiaM4fCandidate19Protected[$SynthiaM4fCandidate19AncestorPid]=$SynthiaM4fCandidate19AncestorCore|ConvertTo-Json -Compress;$SynthiaM4fCandidate19AncestorPid=[int]$SynthiaM4fCandidate19AncestorCore.parent_pid}",
    "foreach($SynthiaM4fCandidate19SshdRow in $SynthiaM4fCandidate19All){if($SynthiaM4fCandidate19SshdRow.Name -ieq 'sshd.exe'){$SynthiaM4fCandidate19SshdCore=Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19SshdRow;$SynthiaM4fCandidate19Protected[[int]$SynthiaM4fCandidate19SshdCore.pid]=$SynthiaM4fCandidate19SshdCore|ConvertTo-Json -Compress}}",
    "$SynthiaM4fCandidate19WorkerRow=$SynthiaM4fCandidate19ByPid[[int]$SynthiaM4fCandidate19Config.p[0]];if($null -eq $SynthiaM4fCandidate19WorkerRow -or $null -eq $SynthiaM4fCandidate19WorkerRow.CommandLine){throw 'WORKER_MISSING'};if([int]$SynthiaM4fCandidate19WorkerRow.ParentProcessId -ne [int]$SynthiaM4fCandidate19Config.p[1] -or $SynthiaM4fCandidate19WorkerRow.Name.ToLowerInvariant() -cne [string]$SynthiaM4fCandidate19Config.p[2] -or [string]$SynthiaM4fCandidate19WorkerRow.ExecutablePath -cne [string]$SynthiaM4fCandidate19Config.p[3] -or $SynthiaM4fCandidate19WorkerRow.CreationDate.ToUniversalTime().ToString('o') -cne [string]$SynthiaM4fCandidate19Config.p[4]){throw 'WORKER_IDENTITY'};$SynthiaM4fCandidate19WorkerCore=Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19WorkerRow;$SynthiaM4fCandidate19WorkerRuntimeCommandSha256=$SynthiaM4fCandidate19WorkerCore.command_sha256",
    "$SynthiaM4fCandidate19WorkerProcess=[Diagnostics.Process]::GetProcessById([int]$SynthiaM4fCandidate19Config.p[0]);$SynthiaM4fCandidate19WorkerSafeHandle=$SynthiaM4fCandidate19WorkerProcess.SafeHandle;if($SynthiaM4fCandidate19WorkerSafeHandle.IsInvalid -or $SynthiaM4fCandidate19WorkerSafeHandle.IsClosed){throw 'WORKER_HANDLE'};$SynthiaM4fCandidate19WorkerSafeHandle.DangerousAddRef([ref]$SynthiaM4fCandidate19WorkerAddRef);$SynthiaM4fCandidate19WorkerRawHandle=$SynthiaM4fCandidate19WorkerSafeHandle.DangerousGetHandle().ToInt64();if($SynthiaM4fCandidate19WorkerProcess.HasExited -or (Get-SynthiaM4fCandidate19NormalizedTicks $SynthiaM4fCandidate19WorkerProcess.StartTime) -ne (Get-SynthiaM4fCandidate19NormalizedTicks ([DateTime][string]$SynthiaM4fCandidate19Config.p[4]))){throw 'WORKER_HANDLE_IDENTITY'};$SynthiaM4fCandidate19Protected[[int]$SynthiaM4fCandidate19Config.p[0]]=$SynthiaM4fCandidate19WorkerCore|ConvertTo-Json -Compress",
    "foreach($SynthiaM4fCandidate19Target in $SynthiaM4fCandidate19Config.t){$SynthiaM4fCandidate19TargetPid=[int]$SynthiaM4fCandidate19Target[3];if($SynthiaM4fCandidate19Protected.ContainsKey($SynthiaM4fCandidate19TargetPid) -or $SynthiaM4fCandidate19Protected.ContainsKey([int]$SynthiaM4fCandidate19Target[4])){throw 'TARGET_PROTECTED_EDGE'};$SynthiaM4fCandidate19TargetRow=$SynthiaM4fCandidate19ByPid[$SynthiaM4fCandidate19TargetPid];if($null -eq $SynthiaM4fCandidate19TargetRow){throw 'TARGET_MISSING'};$SynthiaM4fCandidate19TargetCore=Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19TargetRow;if(-not (Test-SynthiaM4fCandidate19TargetCore $SynthiaM4fCandidate19TargetCore $SynthiaM4fCandidate19Target)){throw 'TARGET_CORE'};$SynthiaM4fCandidate19Process=[Diagnostics.Process]::GetProcessById($SynthiaM4fCandidate19TargetPid);$SynthiaM4fCandidate19SafeHandle=$SynthiaM4fCandidate19Process.SafeHandle;if($SynthiaM4fCandidate19SafeHandle.IsInvalid -or $SynthiaM4fCandidate19SafeHandle.IsClosed){throw 'TARGET_HANDLE'};$SynthiaM4fCandidate19State=[pscustomobject]@{target=$SynthiaM4fCandidate19Target;process=$SynthiaM4fCandidate19Process;safe_handle=$SynthiaM4fCandidate19SafeHandle;raw_handle=$null;add_ref=$false;effect_start=$false;effect_result=$false};$SynthiaM4fCandidate19Retained.Add($SynthiaM4fCandidate19State);$SynthiaM4fCandidate19AddRef=$false;try{$SynthiaM4fCandidate19SafeHandle.DangerousAddRef([ref]$SynthiaM4fCandidate19AddRef)}finally{if($SynthiaM4fCandidate19AddRef){$SynthiaM4fCandidate19State.add_ref=$true}};$SynthiaM4fCandidate19State.raw_handle=[string]$SynthiaM4fCandidate19SafeHandle.DangerousGetHandle().ToInt64();if($SynthiaM4fCandidate19Process.Id -ne $SynthiaM4fCandidate19TargetPid -or $SynthiaM4fCandidate19Process.ProcessName+'.exe' -cne [string]$SynthiaM4fCandidate19Target[5] -or $SynthiaM4fCandidate19Process.HasExited -or (Get-SynthiaM4fCandidate19NormalizedTicks $SynthiaM4fCandidate19Process.StartTime) -ne (Get-SynthiaM4fCandidate19NormalizedTicks ([DateTime][string]$SynthiaM4fCandidate19Target[6]))){throw 'TARGET_HANDLE_IDENTITY'};$SynthiaM4fCandidate19States.Add($SynthiaM4fCandidate19State)}",
    "if($SynthiaM4fCandidate19States.Count -ne 6 -or $SynthiaM4fCandidate19Retained.Count -ne 6 -or $SynthiaM4fCandidate19ByPid.ContainsKey(6100) -or $SynthiaM4fCandidate19ByPid.ContainsKey(24260)){throw 'TARGET_OR_EXTERNAL_PARENT_REUSE'};foreach($SynthiaM4fCandidate19Target in $SynthiaM4fCandidate19Config.t){$SynthiaM4fCandidate19Ordinal=[int]$SynthiaM4fCandidate19Target[0];$SynthiaM4fCandidate19Children=@($SynthiaM4fCandidate19All|Where-Object{$_.ParentProcessId -eq [int]$SynthiaM4fCandidate19Target[3]}|ForEach-Object{[int]$_.ProcessId}|Sort-Object);$SynthiaM4fCandidate19ExpectedChildren=if($SynthiaM4fCandidate19Ordinal -eq 2){@([int]$SynthiaM4fCandidate19Config.t[0][3],[int]$SynthiaM4fCandidate19Config.t[2][3])}elseif($SynthiaM4fCandidate19Ordinal -eq 5){@([int]$SynthiaM4fCandidate19Config.t[3][3],[int]$SynthiaM4fCandidate19Config.t[5][3])}else{@()};if(($SynthiaM4fCandidate19Children|ConvertTo-Json -Compress) -cne ($SynthiaM4fCandidate19ExpectedChildren|Sort-Object|ConvertTo-Json -Compress)){throw 'TREE_CLOSURE'}}",
    "if(-not (Test-SynthiaM4fCandidate19Protection $SynthiaM4fCandidate19ByPid)){throw 'PREFLIGHT_PROTECTION'};$SynthiaM4fCandidate19Cores=@($SynthiaM4fCandidate19Protected.Keys|Sort-Object{[int]$_}|ForEach-Object{Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19ByPid[[int]$_]});$SynthiaM4fCandidate19Listeners=@(Get-SynthiaM4fCandidate19Listeners);$SynthiaM4fCandidate19Protection=[ordered]@{cores=$SynthiaM4fCandidate19Cores;listeners=$SynthiaM4fCandidate19Listeners;worker_raw_handle=[string]$SynthiaM4fCandidate19WorkerRawHandle;worker_runtime_command_sha256=$SynthiaM4fCandidate19WorkerRuntimeCommandSha256};$SynthiaM4fCandidate19ProtectionSha256=Get-SynthiaM4fCandidate19Sha256 ($SynthiaM4fCandidate19Protection|ConvertTo-Json -Compress -Depth 8);$SynthiaM4fCandidate19Phase='preflight_complete';Write-SynthiaM4fCandidate19Marker 'preflight' 'observed' ([ordered]@{target_count=6;retained_handle_count=6;protection=$SynthiaM4fCandidate19Protection;protection_sha256=$SynthiaM4fCandidate19ProtectionSha256})",
    "foreach($SynthiaM4fCandidate19State in $SynthiaM4fCandidate19States){if([DateTime]::UtcNow -ge $SynthiaM4fCandidate19Deadline){throw 'DEADLINE'};$SynthiaM4fCandidate19Target=$SynthiaM4fCandidate19State.target;$SynthiaM4fCandidate19Ordinal=[int]$SynthiaM4fCandidate19Target[0];$SynthiaM4fCandidate19Pid=[int]$SynthiaM4fCandidate19Target[3];$SynthiaM4fCandidate19Phase='before_effect_'+$SynthiaM4fCandidate19Ordinal;$SynthiaM4fCandidate19CurrentSnapshot=Get-SynthiaM4fCandidate19SnapshotByPid;$SynthiaM4fCandidate19CurrentByPid=$SynthiaM4fCandidate19CurrentSnapshot.by_pid;if(-not (Test-SynthiaM4fCandidate19Protection $SynthiaM4fCandidate19CurrentByPid)){throw 'PROTECTION_DRIFT'};foreach($SynthiaM4fCandidate19CheckState in $SynthiaM4fCandidate19States){if(-not $SynthiaM4fCandidate19CheckState.add_ref -or $SynthiaM4fCandidate19CheckState.safe_handle.IsInvalid -or $SynthiaM4fCandidate19CheckState.safe_handle.IsClosed -or [string]$SynthiaM4fCandidate19CheckState.safe_handle.DangerousGetHandle().ToInt64() -cne [string]$SynthiaM4fCandidate19CheckState.raw_handle -or (Get-SynthiaM4fCandidate19NormalizedTicks $SynthiaM4fCandidate19CheckState.process.StartTime) -ne (Get-SynthiaM4fCandidate19NormalizedTicks ([DateTime][string]$SynthiaM4fCandidate19CheckState.target[6]))){throw 'RETAINED_HANDLE_DRIFT'}};if($SynthiaM4fCandidate19Ordinal -le 3){foreach($SynthiaM4fCandidate19OtherState in $SynthiaM4fCandidate19States){if([string]$SynthiaM4fCandidate19OtherState.target[1] -eq 'candidate10' -and $SynthiaM4fCandidate19OtherState.process.HasExited){throw 'OTHER_TREE_EXITED'}}};if($SynthiaM4fCandidate19Ordinal -eq 4 -and ($SynthiaM4fCandidate19States[4].process.HasExited -or $SynthiaM4fCandidate19States[5].process.HasExited)){throw 'CANDIDATE10_PEER_EXITED'}",
    "if($SynthiaM4fCandidate19State.process.HasExited){$SynthiaM4fCandidate19NaturalAfter=$SynthiaM4fCandidate19Target[9];if($SynthiaM4fCandidate19CurrentByPid.ContainsKey($SynthiaM4fCandidate19Pid)){throw 'PID_REUSE'};if($null -eq $SynthiaM4fCandidate19NaturalAfter -or -not $SynthiaM4fCandidate19PowerResults[[string]$SynthiaM4fCandidate19Target[1]]){throw 'UNEXPECTED_NATURAL_EXIT'};Write-SynthiaM4fCandidate19Marker 'natural_exit' 'observed' ([ordered]@{ordinal=$SynthiaM4fCandidate19Ordinal;pid=$SynthiaM4fCandidate19Pid;after_ordinal=[int]$SynthiaM4fCandidate19NaturalAfter;start_token=[string]$SynthiaM4fCandidate19Target[10];raw_handle=[string]$SynthiaM4fCandidate19State.raw_handle;protection_sha256=$SynthiaM4fCandidate19ProtectionSha256});continue}",
    "$SynthiaM4fCandidate19CurrentRow=$SynthiaM4fCandidate19CurrentByPid[$SynthiaM4fCandidate19Pid];if($null -eq $SynthiaM4fCandidate19CurrentRow){throw 'HANDLE_LIVE_CIM_MISSING'};$SynthiaM4fCandidate19CurrentCore=Get-SynthiaM4fCandidate19ProcessCore $SynthiaM4fCandidate19CurrentRow;if(-not (Test-SynthiaM4fCandidate19TargetCore $SynthiaM4fCandidate19CurrentCore $SynthiaM4fCandidate19Target) -or $SynthiaM4fCandidate19State.safe_handle.IsInvalid -or $SynthiaM4fCandidate19State.safe_handle.IsClosed -or [string]$SynthiaM4fCandidate19State.safe_handle.DangerousGetHandle().ToInt64() -cne [string]$SynthiaM4fCandidate19State.raw_handle -or $SynthiaM4fCandidate19State.process.HasExited){throw 'PRE_EFFECT_IDENTITY'}",
    "$SynthiaM4fCandidate19EffectStartPayload=[ordered]@{ordinal=$SynthiaM4fCandidate19Ordinal;candidate=[string]$SynthiaM4fCandidate19Target[1];role=[string]$SynthiaM4fCandidate19Target[2];pid=$SynthiaM4fCandidate19Pid;start_token=[string]$SynthiaM4fCandidate19Target[10];raw_handle=[string]$SynthiaM4fCandidate19State.raw_handle;protection_sha256=$SynthiaM4fCandidate19ProtectionSha256};$SynthiaM4fCandidate19Phase='effect_start_'+$SynthiaM4fCandidate19Ordinal;$SynthiaM4fCandidate19EffectResultPending=$true;$SynthiaM4fCandidate19State.effect_start=$true",
    "Write-SynthiaM4fCandidate19Marker 'effect_start' 'started' $SynthiaM4fCandidate19EffectStartPayload",
    "$SynthiaM4fCandidate19State.process.Kill()",
    "if(-not $SynthiaM4fCandidate19State.process.WaitForExit([int]$SynthiaM4fCandidate19Config.w) -or -not $SynthiaM4fCandidate19State.process.HasExited){throw 'WAIT_TIMEOUT'};$SynthiaM4fCandidate19State.effect_result=$true;if([string]$SynthiaM4fCandidate19Target[2] -eq 'powershell'){$SynthiaM4fCandidate19PowerResults[[string]$SynthiaM4fCandidate19Target[1]]=$true};$SynthiaM4fCandidate19Phase='effect_result_'+$SynthiaM4fCandidate19Ordinal;Write-SynthiaM4fCandidate19Marker 'effect_result' 'observed' ([ordered]@{ordinal=$SynthiaM4fCandidate19Ordinal;pid=$SynthiaM4fCandidate19Pid;effect='same_process_instance_kill_completed';has_exited=$true;start_token=[string]$SynthiaM4fCandidate19Target[10]});$SynthiaM4fCandidate19EffectResultPending=$false}",
    "$SynthiaM4fCandidate19Phase='postflight';$SynthiaM4fCandidate19Post=Get-SynthiaM4fCandidate19SnapshotByPid;$SynthiaM4fCandidate19PostByPid=$SynthiaM4fCandidate19Post.by_pid;foreach($SynthiaM4fCandidate19State in $SynthiaM4fCandidate19States){if(-not $SynthiaM4fCandidate19State.process.HasExited -or $SynthiaM4fCandidate19PostByPid.ContainsKey([int]$SynthiaM4fCandidate19State.target[3])){throw 'POSTFLIGHT_TARGET_OR_REUSE'}};if(-not (Test-SynthiaM4fCandidate19Protection $SynthiaM4fCandidate19PostByPid)){throw 'POSTFLIGHT_PROTECTION'};Write-SynthiaM4fCandidate19Marker 'postflight' 'observed' ([ordered]@{resolved_count=6;protection_sha256=$SynthiaM4fCandidate19ProtectionSha256});Write-SynthiaM4fCandidate19Marker 'complete' 'complete' ([ordered]@{cleanup_completed=$true;resolved_count=6;retry_permitted=$false})",
    "}catch{$SynthiaM4fCandidate19ErrorType=$_.Exception.GetType().FullName;try{Write-SynthiaM4fCandidate19Marker 'failure' 'partial_unknown' ([ordered]@{phase=$SynthiaM4fCandidate19Phase;error_type=$SynthiaM4fCandidate19ErrorType;effect_result_pending=$SynthiaM4fCandidate19EffectResultPending;retry_permitted=$false})}catch{};throw}finally{foreach($SynthiaM4fCandidate19State in $SynthiaM4fCandidate19Retained){if($SynthiaM4fCandidate19State.add_ref){try{$SynthiaM4fCandidate19State.safe_handle.DangerousRelease();$SynthiaM4fCandidate19State.add_ref=$false}catch{}}};if($SynthiaM4fCandidate19WorkerAddRef){try{$SynthiaM4fCandidate19WorkerSafeHandle.DangerousRelease();$SynthiaM4fCandidate19WorkerAddRef=$false}catch{}}}",
    "",
  ].join("\n");
  const variables = [...new Set(source.match(/\$SynthiaM4fCandidate19[A-Za-z0-9]+/gu) ?? [])];
  return variables.reduce((result, variable, index) =>
    result.replaceAll(variable, `$S19v${index}`), source);
}

export function buildCandidate19Payload(rawConfig: unknown): Candidate19BuiltPayload {
  const businessScript = buildCandidate19BusinessScript(rawConfig);
  const compressed = gzipSync(Buffer.from(businessScript, "utf8"), { level: 9 });
  const payload = compressed.toString("base64");
  const outerLoader = "$ErrorActionPreference='Stop';"
    + "$z=[Convert]::FromBase64String('" + payload + "');"
    + "$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);"
    + "&([ScriptBlock]::Create([IO.StreamReader]::new($g).ReadToEnd()))";
  if (outerLoader.includes(",0)")
    || (outerLoader.match(/\[IO\.Compression\.CompressionMode\]::Decompress/gu)?.length ?? 0) !== 1) {
    throw new Error("M4F_CANDIDATE19_OUTER_LOADER_INVALID");
  }
  const remoteCommand = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& { "
    + outerLoader + " }\"";
  if (remoteCommand.length > COMMAND_LIMIT) throw new Error("M4F_CANDIDATE19_REMOTE_COMMAND_TOO_LONG");
  return {
    business_script: businessScript,
    compressed_business_script: compressed,
    outer_loader: outerLoader,
    remote_command: remoteCommand,
    business_script_sha256: sha256(businessScript),
    outer_loader_sha256: sha256(outerLoader),
    remote_command_sha256: sha256(Buffer.from(remoteCommand, "ascii")),
  };
}

const PRODUCTION_GZIP_SHA256 = "beb0e6233bdab365c70306a49b7b698104176f8c604f99e9ed28ee015096b924";
const PRODUCTION_GZIP_LENGTH = 4936;
const PRODUCTION_BUSINESS_SHA256 = "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c";
const PRODUCTION_BUSINESS_LENGTH = 13856;

export function buildCandidate19GzipBindingProbe(rawConfig: unknown): Candidate19GzipBindingProbe {
  const payload = buildCandidate19Payload(rawConfig);
  const stdin = Buffer.from(payload.compressed_business_script);
  if (stdin.length !== PRODUCTION_GZIP_LENGTH || sha256(stdin) !== PRODUCTION_GZIP_SHA256
    || Buffer.byteLength(payload.business_script, "utf8") !== PRODUCTION_BUSINESS_LENGTH
    || payload.business_script_sha256 !== PRODUCTION_BUSINESS_SHA256) {
    throw new Error("M4F_CANDIDATE19_GZIP_BINDING_PROBE_PAYLOAD_MISMATCH");
  }
  const script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
    + `$S19i=[Console]::OpenStandardInput();[byte[]]$S19z=New-Object byte[] ${PRODUCTION_GZIP_LENGTH};$S19p=0;`
    + "while($S19p -lt $S19z.Length){$S19n=$S19i.Read($S19z,$S19p,$S19z.Length-$S19p);if($S19n -le 0){throw 'STDIN_EOF'};$S19p+=$S19n};if($S19i.ReadByte() -ne -1){throw 'STDIN_TAIL'};"
    + "$S19zh=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($S19z)) -replace '-','').ToLowerInvariant();"
    + `if($S19zh -cne '${PRODUCTION_GZIP_SHA256}'){throw 'STDIN_HASH'};`
    + "$S19m=[IO.MemoryStream]::new($S19z);"
    + "$S19g=[IO.Compression.GZipStream]::new($S19m,[IO.Compression.CompressionMode]::Decompress);"
    + "$S19gt=$S19g.GetType().FullName;if($S19gt -cne 'System.IO.Compression.GZipStream'){throw 'GZIP_TYPE'};"
    + "$S19d=[IO.MemoryStream]::new();$S19g.CopyTo($S19d);$S19g.Dispose();$S19m.Dispose();$S19b=$S19d.ToArray();$S19d.Dispose();"
    + "$S19h=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($S19b)) -replace '-','').ToLowerInvariant();"
    + `if($S19b.Length -ne ${PRODUCTION_BUSINESS_LENGTH} -or $S19h -cne '${PRODUCTION_BUSINESS_SHA256}'){throw 'BUSINESS_BYTES'};`
    + "$S19u=[Text.UTF8Encoding]::new($false,$true);$S19t=$S19u.GetString($S19b);$S19q=$S19u.GetBytes($S19t);"
    + "if($S19q.Length -ne $S19b.Length -or ([Convert]::ToBase64String($S19q) -cne [Convert]::ToBase64String($S19b))){throw 'UTF8_ROUNDTRIP'};"
    + "$S19s=[ScriptBlock]::Create($S19t);$S19a=$S19s.GetType().FullName;if($S19a -cne 'System.Management.Automation.ScriptBlock'){throw 'SCRIPTBLOCK_TYPE'};"
    + "$S19o=[ordered]@{s='c19g2';z='ok';e=$PSVersionTable.PSEdition;v=$PSVersionTable.PSVersion.ToString();g=$S19gt;h=$S19h;l=$S19b.Length;a=$S19a;i=$true};"
    + "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine(($S19o|ConvertTo-Json -Compress));[Console]::Out.Flush()";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + encoded;
  if (script.includes(",0)")
    || (script.match(/\[IO\.Compression\.CompressionMode\]::Decompress/gu)?.length ?? 0) !== 1
    || (script.match(/\[ScriptBlock\]::Create/gu)?.length ?? 0) !== 1
    || /Invoke-Expression|\.Invoke\s*\(|&\s*\$S19s|\.Kill\s*\(|Stop-Process|Get-CimInstance|MSFT_NetTCPConnection/iu.test(script)
    || command.length > COMMAND_LIMIT) {
    throw new Error("M4F_CANDIDATE19_GZIP_BINDING_PROBE_INVALID");
  }
  return {
    schema: "synthia-m4f-candidate19-gzip-binding-probe-plan.v1",
    probe_id: "m4f-candidate19-gzip-binding-probe-v2",
    status: "planned_not_executed",
    stdin,
    stdin_length: PRODUCTION_GZIP_LENGTH,
    stdin_sha256: PRODUCTION_GZIP_SHA256,
    script,
    command,
    command_length: command.length,
    script_sha256: sha256(script),
    expected_business_sha256: PRODUCTION_BUSINESS_SHA256,
    expected_business_length: PRODUCTION_BUSINESS_LENGTH,
    target_body_embedded: false,
    script_block_created: true,
    target_body_invoked: false,
    network_attempted: false,
    ssh_attempted: false,
    remote_execution_attempted: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    cleanup_performed: false,
  };
}

export function validateCandidate19GzipBindingProbeResult(
  stdout: Buffer,
  probe: Candidate19GzipBindingProbe,
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new Error("M4F_CANDIDATE19_GZIP_BINDING_PROBE_RESULT_INVALID");
  }
  if (!(text.endsWith("\r\n") || text.endsWith("\n"))) {
    throw new Error("M4F_CANDIDATE19_GZIP_BINDING_PROBE_RESULT_INVALID");
  }
  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.slice(0, -1);
  if (line.includes("\r") || line.includes("\n")) {
    throw new Error("M4F_CANDIDATE19_GZIP_BINDING_PROBE_RESULT_INVALID");
  }
  let result: Record<string, unknown> | null = null;
  try {
    result = object(JSON.parse(line));
  } catch {
    // Rejected below.
  }
  if (!result || !exactKeys(result, ["a", "e", "g", "h", "i", "l", "s", "v", "z"])
    || result.s !== "c19g2" || result.z !== "ok" || result.e !== "Desktop"
    || typeof result.v !== "string" || !result.v.startsWith("5.1.")
    || result.g !== "System.IO.Compression.GZipStream"
    || result.h !== probe.expected_business_sha256 || result.l !== probe.expected_business_length
    || result.a !== "System.Management.Automation.ScriptBlock" || result.i !== true) {
    throw new Error("M4F_CANDIDATE19_GZIP_BINDING_PROBE_RESULT_INVALID");
  }
  return {
    schema: "synthia-m4f-candidate19-gzip-binding-probe-result.v1",
    status: "gzip_constructor_and_decompress_bound",
    powershell_edition: result.e,
    powershell_version: result.v,
    gzip_stream_type: result.g,
    business_sha256: result.h,
    business_length: result.l,
    script_block_type: result.a,
    script_block_created: true,
    target_body_invoked: false,
    network_attempted: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    cleanup_performed: false,
  };
}

export function candidate19ScriptConfigSha256(rawConfig: unknown): string {
  return sha256(canonicalJson19(validateCandidate19ScriptConfig(rawConfig)) + "\n");
}

function exactPayload(marker: Candidate19Marker, keys: readonly string[]): Record<string, unknown> | null {
  return exactKeys(marker.payload, keys) ? marker.payload : null;
}

function validProtection19(
  value: unknown,
  config: Candidate19ScriptConfig,
  currentPid: number | null,
): string | null {
  const protection = object(value);
  if (!protection || !exactKeys(protection, PROTECTION_KEYS)
    || !Array.isArray(protection.cores) || protection.cores.length < 1
    || !Array.isArray(protection.listeners) || protection.listeners.length !== 1
    || typeof protection.worker_raw_handle !== "string" || !/^-?\d+$/u.test(protection.worker_raw_handle)
    || typeof protection.worker_runtime_command_sha256 !== "string"
    || !HASH.test(protection.worker_runtime_command_sha256)) return null;
  let previousPid = 0;
  const cores: Record<string, unknown>[] = [];
  for (const item of protection.cores) {
    const core = object(item);
    if (!core || !exactKeys(core, CORE_KEYS) || !Number.isSafeInteger(core.pid)
      || Number(core.pid) <= previousPid || !Number.isSafeInteger(core.parent_pid)
      || Number(core.parent_pid) < 0 || typeof core.name !== "string"
      || core.name !== core.name.toLowerCase() || typeof core.creation_utc !== "string"
      || !UTC.test(core.creation_utc) || !Number.isSafeInteger(core.session_id)
      || Number(core.session_id) < 0 || typeof core.command_sha256 !== "string"
      || !HASH.test(core.command_sha256)) return null;
    previousPid = Number(core.pid);
    cores.push(core);
  }
  const listener = object(protection.listeners[0]);
  if (!listener || !exactKeys(listener, LISTENER_KEYS)
    || canonicalJson19(listener) !== canonicalJson19(CANDIDATE19_LISTENERS[0])) return null;
  const workerCores = cores.filter((core) => core.pid === config.protected_worker.pid);
  const workerCore = workerCores[0];
  if (workerCores.length !== 1 || !workerCore
    || workerCore.parent_pid !== config.protected_worker.parent_pid
    || workerCore.name !== config.protected_worker.name
    || workerCore.creation_utc !== config.protected_worker.creation_utc
    || workerCore.command_sha256 !== protection.worker_runtime_command_sha256
    || currentPid === null || cores.filter((core) => core.pid === currentPid).length !== 1) return null;
  const coreByPid = new Map(cores.map((core) => [Number(core.pid), core]));
  const forbiddenAncestry = new Set([
    config.protected_worker.pid,
    ...config.targets.map((target) => target.pid),
  ]);
  const ancestrySeen = new Set<number>();
  let ancestryPid = currentPid;
  while (ancestryPid > 0) {
    if (ancestrySeen.has(ancestryPid) || forbiddenAncestry.has(ancestryPid)) return null;
    const ancestryCore = coreByPid.get(ancestryPid);
    if (!ancestryCore) return null;
    ancestrySeen.add(ancestryPid);
    ancestryPid = Number(ancestryCore.parent_pid);
  }
  const base = {
    cores,
    listeners: [listener],
    worker_raw_handle: protection.worker_raw_handle,
    worker_runtime_command_sha256: protection.worker_runtime_command_sha256,
  };
  const observed = sha256(JSON.stringify(base));
  return observed;
}

interface MarkerState19 {
  stage: "start" | "preflight" | "targets" | "postflight" | "complete" | "terminal";
  ordinal: number;
  awaitingResult: boolean;
  baseline: string | null;
  powerResults: Set<number>;
  currentPid: number | null;
}

function validCandidate19Marker(
  value: unknown,
  config: Candidate19ScriptConfig,
  state: MarkerState19,
): Candidate19Marker | null {
  const marker = object(value);
  if (!marker || !exactKeys(marker, MARKER_KEYS)
    || marker.schema !== "synthia-m4f-candidate19-marker.v1"
    || marker.cleanup_id !== config.cleanup_id || typeof marker.observed_at_utc !== "string"
    || !UTC.test(marker.observed_at_utc) || Number.isNaN(Date.parse(marker.observed_at_utc))
    || !object(marker.payload)
    || typeof marker.phase !== "string" || typeof marker.status !== "string") return null;
  const typed = marker as unknown as Candidate19Marker;
  if (typed.phase === "failure") {
    const payload = exactPayload(typed, [
      "effect_result_pending", "error_type", "phase", "retry_permitted",
    ]);
    if (state.stage === "terminal" || typed.status !== "partial_unknown" || !payload
      || typeof payload.effect_result_pending !== "boolean" || typeof payload.error_type !== "string"
      || typeof payload.phase !== "string" || payload.retry_permitted !== false
      || payload.effect_result_pending !== state.awaitingResult
      || !validCandidate19FailurePhase(String(payload.phase), state)) return null;
    state.stage = "terminal";
    return typed;
  }
  if (state.stage === "start") {
    const payload = exactPayload(typed, [
      "admission_record_sha256", "current_pid", "observation_semantic_sha256", "target_count",
    ]);
    if (typed.phase !== "start" || typed.status !== "observed" || !payload
      || !Number.isSafeInteger(payload.current_pid) || Number(payload.current_pid) < 1
      || Number(payload.current_pid) === config.protected_worker.pid
      || config.targets.some((target) => target.pid === payload.current_pid)
      || payload.target_count !== 6
      || payload.observation_semantic_sha256 !== config.observation_semantic_sha256
      || payload.admission_record_sha256 !== config.admission_record_sha256) return null;
    state.stage = "preflight";
    state.currentPid = Number(payload.current_pid);
    return typed;
  }
  if (state.stage === "preflight") {
    const payload = exactPayload(typed, [
      "protection", "protection_sha256", "retained_handle_count", "target_count",
    ]);
    const baseline = payload ? validProtection19(payload.protection, config, state.currentPid) : null;
    if (typed.phase !== "preflight" || typed.status !== "observed" || !payload
      || payload.target_count !== 6 || payload.retained_handle_count !== 6 || baseline === null
      || payload.protection_sha256 !== baseline) return null;
    state.baseline = baseline;
    state.stage = "targets";
    return typed;
  }
  if (state.stage === "targets") {
    const target = config.targets[state.ordinal - 1];
    if (!target || state.baseline === null) return null;
    if (typed.phase === "effect_start") {
      const payload = exactPayload(typed, [
        "candidate", "ordinal", "pid", "protection_sha256", "raw_handle", "role", "start_token",
      ]);
      if (state.awaitingResult || typed.status !== "started" || !payload
        || payload.ordinal !== target.ordinal || payload.candidate !== target.candidate
        || payload.role !== target.role || payload.pid !== target.pid
        || payload.start_token !== candidate19StartToken(target)
        || typeof payload.raw_handle !== "string" || !/^-?\d+$/u.test(payload.raw_handle)
        || payload.protection_sha256 !== state.baseline) return null;
      state.awaitingResult = true;
      return typed;
    }
    if (typed.phase === "effect_result") {
      const payload = exactPayload(typed, ["effect", "has_exited", "ordinal", "pid", "start_token"]);
      if (!state.awaitingResult || typed.status !== "observed" || !payload
        || payload.ordinal !== target.ordinal || payload.pid !== target.pid
        || payload.effect !== "same_process_instance_kill_completed" || payload.has_exited !== true
        || payload.start_token !== candidate19StartToken(target)) return null;
      if (target.role === "powershell") state.powerResults.add(target.ordinal);
      state.awaitingResult = false;
      state.ordinal += 1;
      if (state.ordinal === 7) state.stage = "postflight";
      return typed;
    }
    if (typed.phase === "natural_exit") {
      const payload = exactPayload(typed, [
        "after_ordinal", "ordinal", "pid", "protection_sha256", "raw_handle", "start_token",
      ]);
      if (state.awaitingResult || target.role === "powershell" || typed.status !== "observed" || !payload
        || payload.ordinal !== target.ordinal || payload.pid !== target.pid
        || payload.after_ordinal !== target.natural_exit_after_ordinal
        || !state.powerResults.has(Number(target.natural_exit_after_ordinal))
        || payload.start_token !== candidate19StartToken(target)
        || typeof payload.raw_handle !== "string" || !/^-?\d+$/u.test(payload.raw_handle)
        || payload.protection_sha256 !== state.baseline) return null;
      state.ordinal += 1;
      if (state.ordinal === 7) state.stage = "postflight";
      return typed;
    }
    return null;
  }
  if (state.stage === "postflight") {
    const payload = exactPayload(typed, ["protection_sha256", "resolved_count"]);
    if (typed.phase !== "postflight" || typed.status !== "observed" || !payload
      || payload.resolved_count !== 6 || payload.protection_sha256 !== state.baseline) return null;
    state.stage = "complete";
    return typed;
  }
  if (state.stage === "complete") {
    const payload = exactPayload(typed, ["cleanup_completed", "resolved_count", "retry_permitted"]);
    if (typed.phase !== "complete" || typed.status !== "complete" || !payload
      || payload.cleanup_completed !== true || payload.resolved_count !== 6
      || payload.retry_permitted !== false) return null;
    state.stage = "terminal";
    return typed;
  }
  return null;
}

function validCandidate19FailurePhase(phase: string, state: MarkerState19): boolean {
  if (state.awaitingResult) {
    return phase === `effect_start_${state.ordinal}` || phase === `effect_result_${state.ordinal}`;
  }
  if (state.stage === "start") return phase === "start";
  if (state.stage === "preflight") {
    return phase === "start" || phase === "preflight_snapshot" || phase === "preflight_complete";
  }
  if (state.stage === "targets") {
    return phase === `before_effect_${state.ordinal}`
      || state.ordinal === 1 && phase === "preflight_complete"
      || state.ordinal > 1 && phase === `effect_result_${state.ordinal - 1}`;
  }
  if (state.stage === "postflight") return phase === "effect_result_6" || phase === "postflight";
  return state.stage === "complete" && phase === "postflight";
}

export function parseCandidate19MarkerPrefix(
  stdout: Buffer,
  rawConfig: unknown,
): Candidate19MarkerPrefix {
  const config = validateCandidate19ScriptConfig(rawConfig);
  const markers: Candidate19Marker[] = [];
  const state: MarkerState19 = {
    stage: "start", ordinal: 1, awaitingResult: false, baseline: null, powerResults: new Set(),
    currentPid: null,
  };
  let cursor = 0;
  while (cursor < stdout.length && state.stage !== "terminal") {
    const newline = stdout.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const end = newline > cursor && stdout[newline - 1] === 0x0d ? newline - 1 : newline;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout.subarray(cursor, end)));
    } catch {
      break;
    }
    const marker = validCandidate19Marker(value, config, state);
    if (!marker) break;
    markers.push(marker);
    cursor = newline + 1;
  }
  const validPrefix = Buffer.from(stdout.subarray(0, cursor));
  const trailingFragment = Buffer.from(stdout.subarray(cursor));
  return {
    markers,
    valid_prefix: validPrefix,
    trailing_fragment: trailingFragment,
    valid_prefix_length: validPrefix.length,
    valid_prefix_sha256: sha256(validPrefix),
    trailing_fragment_length: trailingFragment.length,
    trailing_fragment_sha256: sha256(trailingFragment),
    effect_start_ordinals: markers.filter((marker) => marker.phase === "effect_start")
      .map((marker) => Number(marker.payload.ordinal)),
    effect_result_ordinals: markers.filter((marker) => marker.phase === "effect_result")
      .map((marker) => Number(marker.payload.ordinal)),
    complete: trailingFragment.length === 0 && markers.at(-1)?.phase === "complete",
  };
}
