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

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const TARGET_COMPUTER = "DESKTOP-DVFFB09";
const TARGET_USER = "admin";
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const ADMISSION_NETWORK_TIMEOUT_MS = 240_000;
const SERVER_ALIVE_INTERVAL_SECONDS = 0;
const SERVER_ALIVE_COUNT_MAX = 4;
const HASH = /^[0-9a-f]{64}$/u;
const SID = /^S-1-(?:[0-9]+-){1,14}[0-9]+$/u;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const WINDOWS_PATH = /^[A-Za-z]:\\[^\r\n]*$/u;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;

export const M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE = [
  "$ErrorActionPreference=\"Stop\"",
  "$ProgressPreference=\"SilentlyContinue\"",
  "$InformationPreference=\"SilentlyContinue\"",
  "$VerbosePreference=\"SilentlyContinue\"",
  "$DebugPreference=\"SilentlyContinue\"",
  "$WarningPreference=\"SilentlyContinue\"",
  "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
  "$s=[Console]::In.ReadToEnd()",
  "if([string]::IsNullOrEmpty($s)){throw \"M4F_DIRECT_STDIN_EMPTY\"}",
  "& ([ScriptBlock]::Create($s))",
  "",
].join("\n");

export interface M4fDirectAdmissionConfig {
  schema: "synthia-m4f-direct-admission-config.v1";
  gate_id: string;
  target: {
    host: "100.96.223.49";
    port: 22;
    user: "admin";
    computer_name: "DESKTOP-DVFFB09";
    identity_name: string;
    identity_sid: string;
    identity_file: string;
    known_hosts_file: string;
    known_hosts_host_token: "100.96.223.49";
    host_key_fingerprint: string;
    expected_effective_config_sha256: string | null;
    acl_paths: string[];
    vivado_executable: string;
    bun_executable: string;
  };
}

export interface RawProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface M4fDirectAdmissionDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  now(): Date;
}

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

export interface LocalInputFact {
  schema: "synthia-m4f-direct-local-input.v1";
  label: "identity_file" | "known_hosts_file";
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

export interface M4fDirectAdmissionResult {
  schema: "synthia-m4f-direct-admission-record.v1";
  gate_id: string;
  action: "admission_snapshot";
  status: "observed";
  retry_permitted: false;
  recorded_at_utc: string;
  config_sha256: string;
  source_sha256: string;
  remote_wrapper_length: number;
  remote_wrapper_sha256: string;
  remote_command_length: number;
  effective_config_sha256: string;
  target_binding: {
    host: "100.96.223.49";
    port: 22;
    user: "admin";
    computer_name: "DESKTOP-DVFFB09";
    identity_name: string;
    identity_sid: string;
    host_key_fingerprint: string;
  };
  local_inputs_before: LocalInputFact[];
  local_inputs_after: LocalInputFact[];
  target_snapshot: Record<string, unknown>;
  process: ProcessEvidence;
}

export class M4fDirectAdmissionFailure extends Error {
  constructor(
    readonly detail: Record<string, unknown>,
    readonly rawSshStderr: Buffer | null = null,
  ) {
    super(String(detail.code ?? "M4F_DIRECT_ADMISSION_FAILED"));
  }
}

const CONFIG_KEYS = ["gate_id", "schema", "target"] as const;
const TARGET_KEYS = ["acl_paths", "bun_executable", "computer_name", "expected_effective_config_sha256", "host", "host_key_fingerprint", "identity_file", "identity_name", "identity_sid", "known_hosts_file", "known_hosts_host_token", "port", "user", "vivado_executable"] as const;
const SNAPSHOT_KEYS = ["acl", "bun", "hardware_action_performed", "identity", "listeners", "observed_at_utc", "relevant_processes", "schema", "stage_elapsed_ms", "vivado", "volumes"] as const;
const STAGE_ELAPSED_KEYS = ["acl_ms", "bun_ms", "identity_ms", "listeners_ms", "relevant_processes_ms", "total_before_json_ms", "vivado_ms", "volumes_ms"] as const;
const IDENTITY_KEYS = ["computer_name", "identity_name", "identity_sid"] as const;
const VOLUME_KEYS = ["device_id", "drive_type", "file_system", "free_bytes", "size_bytes"] as const;
const FILE_FACT_KEYS = ["exists", "file_version", "length", "path", "sha256"] as const;
const ACL_FACT_KEYS = ["exists", "owner_sid", "path", "protected", "reparse", "rules"] as const;
const ACL_RULE_KEYS = ["inheritance", "inherited", "propagation", "rights", "sid", "type"] as const;
const LISTENER_KEYS = ["address", "pid", "port"] as const;
const PROCESS_KEYS = ["creation_date", "executable_path", "name", "parent_pid", "pid"] as const;

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new M4fDirectAdmissionFailure({
    schema: "synthia-m4f-direct-admission-failure.v1",
    code,
    stage,
    effect_state: stage === "config" || stage === "local_preflight" ? "not_started" : "unknown",
    retry_permitted: false,
    ...extra,
  });
}

function failWithRawSshStderr(
  code: string,
  stage: string,
  process: ProcessEvidence,
  rawStderr: Buffer,
  extra: Record<string, unknown> = {},
): never {
  const bounded = Buffer.from(rawStderr);
  if (bounded.length > MAX_STREAM_BYTES
    || bounded.length !== process.stderr_length
    || sha256(bounded) !== process.stderr_sha256) {
    fail("M4F_DIRECT_ADMISSION_STDERR_BINDING_INVALID", stage, { process, ...extra });
  }
  throw new M4fDirectAdmissionFailure({
    schema: "synthia-m4f-direct-admission-failure.v1",
    code,
    stage,
    effect_state: stage === "config" || stage === "local_preflight" ? "not_started" : "unknown",
    retry_permitted: false,
    process,
    ...extra,
  }, bounded);
}

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

function safePath(value: unknown, windows: boolean): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 1024 || /[\r\n\0]/u.test(value)) return false;
  return windows ? WINDOWS_PATH.test(value) : value.startsWith("/") && !value.includes("/../");
}

export function validateM4fDirectAdmissionConfig(value: unknown): M4fDirectAdmissionConfig {
  const config = object(value);
  const target = object(config?.target);
  if (!config || !target || !exactKeys(config, CONFIG_KEYS) || !exactKeys(target, TARGET_KEYS)
    || config.schema !== "synthia-m4f-direct-admission-config.v1"
    || typeof config.gate_id !== "string" || !SAFE_NAME.test(config.gate_id)
    || target.host !== TARGET_HOST || target.port !== 22
    || target.user !== TARGET_USER || target.computer_name !== TARGET_COMPUTER
    || target.identity_name !== "desktop-dvffb09\\admin"
    || !SID.test(String(target.identity_sid))
    || !safePath(target.identity_file, false) || !safePath(target.known_hosts_file, false)
    || target.identity_file === target.known_hosts_file
    || target.known_hosts_host_token !== TARGET_HOST
    || !FINGERPRINT.test(String(target.host_key_fingerprint))
    || (target.expected_effective_config_sha256 !== null
      && !HASH.test(String(target.expected_effective_config_sha256)))
    || !Array.isArray(target.acl_paths) || target.acl_paths.length < 1 || target.acl_paths.length > 16
    || target.acl_paths.some((path) => !safePath(path, true))
    || new Set(target.acl_paths.map((path) => String(path).toLowerCase())).size !== target.acl_paths.length
    || !safePath(target.vivado_executable, true) || !safePath(target.bun_executable, true)) {
    fail("M4F_DIRECT_ADMISSION_CONFIG_INVALID", "config");
  }
  return value as M4fDirectAdmissionConfig;
}

function localInputCapture(
  path: string,
  label: LocalInputFact["label"],
  stage: "local_preflight" | "network" = "local_preflight",
): { fact: LocalInputFact; bytes: Buffer } {
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
      fail("M4F_DIRECT_ADMISSION_LOCAL_INPUT_UNTRUSTED", stage, { label });
    }
    stat = handleAfter;
  } catch (error) {
    if (error instanceof M4fDirectAdmissionFailure) throw error;
    fail("M4F_DIRECT_ADMISSION_LOCAL_INPUT_UNAVAILABLE", stage, { label });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || bytes.length < 1) {
    fail("M4F_DIRECT_ADMISSION_LOCAL_INPUT_UNTRUSTED", stage, { label });
  }
  return {
    fact: {
      schema: "synthia-m4f-direct-local-input.v1",
      label,
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
    },
    bytes,
  };
}

function parseKnownHost(
  bytes: Buffer,
  token: string,
  fingerprint: string,
  stage: "local_preflight" | "network" = "local_preflight",
): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M4F_DIRECT_ADMISSION_KNOWN_HOSTS_INVALID", stage);
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || lines[0]?.trim() !== lines[0]
    || lines[0]?.startsWith("@") || lines[0]?.startsWith("|1|")) {
    fail("M4F_DIRECT_ADMISSION_KNOWN_HOSTS_INVALID", stage);
  }
  const parts = lines[0]!.split(/[ \t]+/u);
  if (parts.length !== 3 || parts[0] !== token || !/^ssh-(?:ed25519|rsa)$/u.test(parts[1]!)
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(parts[2]!)) {
    fail("M4F_DIRECT_ADMISSION_KNOWN_HOSTS_INVALID", stage);
  }
  const key = Buffer.from(parts[2]!, "base64");
  const observed = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/u, "");
  if (key.length < 32 || observed !== fingerprint) {
    fail("M4F_DIRECT_ADMISSION_HOST_KEY_MISMATCH", stage);
  }
}

export function captureM4fDirectTransportInputs(
  rawConfig: unknown,
  stage: "local_preflight" | "network" = "local_preflight",
): LocalInputFact[] {
  const config = validateM4fDirectAdmissionConfig(rawConfig);
  const identity = localInputCapture(config.target.identity_file, "identity_file", stage);
  const knownHosts = localInputCapture(config.target.known_hosts_file, "known_hosts_file", stage);
  parseKnownHost(
    knownHosts.bytes,
    config.target.known_hosts_host_token,
    config.target.host_key_fingerprint,
    stage,
  );
  return [identity.fact, knownHosts.fact];
}

export function buildDirectSshOptions(config: M4fDirectAdmissionConfig): string[] {
  return [
    "-T", "-F", "/dev/null",
    "-o", "HostName=" + TARGET_HOST,
    "-o", "Port=22",
    "-o", "User=" + TARGET_USER,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=" + SERVER_ALIVE_INTERVAL_SECONDS,
    "-o", "ServerAliveCountMax=" + SERVER_ALIVE_COUNT_MAX,
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "IdentityAgent=none",
    "-o", "IdentityFile=" + config.target.identity_file,
    "-o", "IdentitiesOnly=yes",
    "-o", "PubkeyAuthentication=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ChallengeResponseAuthentication=no",
    "-o", "GSSAPIAuthentication=no",
    "-o", "HostbasedAuthentication=no",
    "-o", "PreferredAuthentications=publickey",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=" + config.target.known_hosts_file,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "ControlMaster=no",
    "-o", "ControlPersist=no",
    "-o", "WarnWeakCrypto=no",
  ];
}

export function directPowerShellStdinWrapperFact(): {
  source_length: number;
  source_sha256: string;
  command_length: number;
} {
  const bytes = Buffer.from(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE, "ascii");
  const encoded = Buffer.from(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE, "utf16le")
    .toString("base64");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + encoded;
  return {
    source_length: bytes.length,
    source_sha256: sha256(bytes),
    command_length: command.length,
  };
}

export function buildDirectPowerShellStdinCommand(): string {
  const encoded = Buffer.from(M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE, "utf16le")
    .toString("base64");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + encoded;
  if (command.length >= 8191) {
    throw new Error("M4F_DIRECT_POWERSHELL_WRAPPER_TOO_LONG");
  }
  return command;
}

export function buildDirectSshArguments(config: M4fDirectAdmissionConfig): string[] {
  return [
    ...buildDirectSshOptions(config),
    TARGET_HOST,
    buildDirectPowerShellStdinCommand(),
  ];
}

export function buildDirectSshEffectiveArguments(config: M4fDirectAdmissionConfig): string[] {
  return ["-G", ...buildDirectSshOptions(config), TARGET_HOST];
}

function expectedEffective(config: M4fDirectAdmissionConfig): Record<string, string> {
  return {
    hostname: TARGET_HOST,
    user: TARGET_USER,
    port: "22",
    batchmode: "yes",
    connecttimeout: "15",
    connectionattempts: "1",
    serveraliveinterval: String(SERVER_ALIVE_INTERVAL_SECONDS),
    serveralivecountmax: String(SERVER_ALIVE_COUNT_MAX),
    numberofpasswordprompts: "0",
    identityagent: "none",
    identitiesonly: "yes",
    pubkeyauthentication: "true",
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    gssapiauthentication: "no",
    hostbasedauthentication: "no",
    preferredauthentications: "publickey",
    stricthostkeychecking: "true",
    forwardagent: "no",
    clearallforwardings: "yes",
    permitlocalcommand: "no",
    controlmaster: "false",
    controlpersist: "no",
    warnweakcrypto: "no",
    requesttty: "false",
    identityfile: config.target.identity_file,
    userknownhostsfile: config.target.known_hosts_file,
    globalknownhostsfile: "/dev/null",
  };
}

export function auditDirectSshEffectiveConfig(
  bytes: Buffer,
  config: M4fDirectAdmissionConfig,
): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_INVALID", "local_preflight");
  }
  const values = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf(" ");
    if (separator < 1) fail("M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_INVALID", "local_preflight");
    const key = line.slice(0, separator).toLowerCase();
    values.set(key, [...(values.get(key) ?? []), line.slice(separator + 1)]);
  }
  for (const [key, value] of Object.entries(expectedEffective(config))) {
    const observed = values.get(key);
    if (!observed || observed.length !== 1 || observed[0]?.toLowerCase() !== value.toLowerCase()) {
      fail("M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_MISMATCH", "local_preflight", { option: key });
    }
  }
  for (const forbidden of ["proxycommand", "proxyjump"]) {
    if (values.has(forbidden)) {
      fail("M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_MISMATCH", "local_preflight", {
        option: forbidden,
      });
    }
  }
}

export function buildTargetAdmissionScript(config: M4fDirectAdmissionConfig): string {
  const payload = Buffer.from(JSON.stringify({
    expectedComputer: TARGET_COMPUTER,
    expectedIdentityName: config.target.identity_name,
    expectedIdentitySid: config.target.identity_sid,
    aclPaths: config.target.acl_paths,
    vivado: config.target.vivado_executable,
    bun: config.target.bun_executable,
  }), "utf8").toString("base64");
  return [
    "$ErrorActionPreference = \"Stop\"",
    "$ProgressPreference = \"SilentlyContinue\"",
    "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)",
    "$cfg = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\"" + payload + "\")) | ConvertFrom-Json)",
    "$total=[Diagnostics.Stopwatch]::StartNew(); $timings=[ordered]@{}; $phase=[Diagnostics.Stopwatch]::StartNew()",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$identityName = $identity.Name.ToLowerInvariant()",
    "if ($env:COMPUTERNAME -cne $cfg.expectedComputer -or $identityName -cne $cfg.expectedIdentityName -or $identity.User.Value -cne $cfg.expectedIdentitySid) { throw \"M4F_DIRECT_TARGET_IDENTITY_MISMATCH\" }",
    "$timings.identity_ms=[int64]$phase.ElapsedMilliseconds",
    "function File-Fact([string]$Path) {",
    "  if (-not [IO.File]::Exists($Path)) { return [ordered]@{ path=$Path; exists=$false; length=$null; sha256=$null; file_version=$null } }",
    "  $item=Get-Item -LiteralPath $Path -Force",
    "  return [ordered]@{ path=$Path; exists=$true; length=[int64]$item.Length; sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant(); file_version=$item.VersionInfo.FileVersion }",
    "}",
    "function Acl-Fact([string]$Path) {",
    "  if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ path=$Path; exists=$false; owner_sid=$null; protected=$null; reparse=$null; rules=@() } }",
    "  $item=Get-Item -LiteralPath $Path -Force; $acl=Get-Acl -LiteralPath $Path",
    "  $ownerSid=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value",
    "  $rules=@($acl.Access | ForEach-Object { $sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; [ordered]@{ sid=$sid; type=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights; inherited=[bool]$_.IsInherited; inheritance=$_.InheritanceFlags.ToString(); propagation=$_.PropagationFlags.ToString() } } | Sort-Object sid,type,rights,inherited,inheritance,propagation)",
    "  return [ordered]@{ path=$Path; exists=$true; owner_sid=$ownerSid; protected=[bool]$acl.AreAccessRulesProtected; reparse=[bool](($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); rules=$rules }",
    "}",
    "$phase=[Diagnostics.Stopwatch]::StartNew(); $volumes=@(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:' OR DeviceID='D:'\" | Sort-Object DeviceID | ForEach-Object { [ordered]@{ device_id=$_.DeviceID; drive_type=[int]$_.DriveType; free_bytes=[int64]$_.FreeSpace; size_bytes=[int64]$_.Size; file_system=$_.FileSystem } }); $timings.volumes_ms=[int64]$phase.ElapsedMilliseconds",
    "$phase=[Diagnostics.Stopwatch]::StartNew(); $aclFacts=@($cfg.aclPaths | ForEach-Object { Acl-Fact ([string]$_) }); $timings.acl_ms=[int64]$phase.ElapsedMilliseconds",
    "$phase=[Diagnostics.Stopwatch]::StartNew(); $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 8443 -or $_.LocalPort -eq 18443 } | Sort-Object LocalPort,OwningProcess | ForEach-Object { [ordered]@{ address=$_.LocalAddress; port=[int]$_.LocalPort; pid=[int]$_.OwningProcess } }); $timings.listeners_ms=[int64]$phase.ElapsedMilliseconds",
    "$names=@(\"bun.exe\",\"node.exe\",\"vivado.exe\",\"vivado_lab.exe\",\"hw_server.exe\")",
    "$phase=[Diagnostics.Stopwatch]::StartNew(); $processes=@(Get-CimInstance Win32_Process | Where-Object { $names -ccontains $_.Name } | Sort-Object ProcessId | ForEach-Object { [ordered]@{ pid=[int]$_.ProcessId; parent_pid=[int]$_.ParentProcessId; name=$_.Name; executable_path=$_.ExecutablePath; creation_date=if ($null -ne $_.CreationDate) { ([DateTime]$_.CreationDate).ToUniversalTime().ToString(\"o\") } else { $null } } }); $timings.relevant_processes_ms=[int64]$phase.ElapsedMilliseconds",
    "$phase=[Diagnostics.Stopwatch]::StartNew(); $vivadoFact=File-Fact ([string]$cfg.vivado); $timings.vivado_ms=[int64]$phase.ElapsedMilliseconds",
    "$phase=[Diagnostics.Stopwatch]::StartNew(); $bunFact=File-Fact ([string]$cfg.bun); $timings.bun_ms=[int64]$phase.ElapsedMilliseconds; $timings.total_before_json_ms=[int64]$total.ElapsedMilliseconds",
    "$result=[ordered]@{ schema=\"synthia-m4f-direct-target-admission-snapshot.v1\"; observed_at_utc=[DateTime]::UtcNow.ToString(\"o\"); identity=[ordered]@{ computer_name=$env:COMPUTERNAME; identity_name=$identityName; identity_sid=$identity.User.Value }; volumes=$volumes; acl=$aclFacts; listeners=$listeners; relevant_processes=$processes; vivado=$vivadoFact; bun=$bunFact; stage_elapsed_ms=$timings; hardware_action_performed=$false }",
    "$result | ConvertTo-Json -Compress -Depth 12",
    "",
  ].join("\n");
}

function processEvidence(result: RawProcessResult, stdin: Buffer = Buffer.alloc(0)): ProcessEvidence {
  const timedOut = result.errorCode === "ETIMEDOUT";
  return {
    exit_status: result.status,
    signal: result.signal,
    error_code: result.errorCode,
    timed_out: timedOut,
    outcome_ambiguous: timedOut || result.signal !== null || result.errorCode !== null || result.status !== 0,
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: result.stdout.length,
    stdout_sha256: sha256(result.stdout),
    stderr_length: result.stderr.length,
    stderr_sha256: sha256(result.stderr),
    retry_permitted: false,
  };
}

function parseSingleJson(bytes: Buffer): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M4F_DIRECT_ADMISSION_OUTPUT_INVALID", "output_validation");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) fail("M4F_DIRECT_ADMISSION_OUTPUT_INVALID", "output_validation");
  try {
    const parsed = object(JSON.parse(lines[0]!));
    if (!parsed) fail("M4F_DIRECT_ADMISSION_OUTPUT_INVALID", "output_validation");
    return parsed;
  } catch (error) {
    if (error instanceof M4fDirectAdmissionFailure) throw error;
    fail("M4F_DIRECT_ADMISSION_OUTPUT_INVALID", "output_validation");
  }
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function validFileFact(value: unknown, expectedPath: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, FILE_FACT_KEYS) || fact.path !== expectedPath
    || typeof fact.exists !== "boolean") return false;
  if (fact.exists === false) {
    return fact.length === null && fact.sha256 === null && fact.file_version === null;
  }
  return safeInteger(fact.length)
    && typeof fact.sha256 === "string" && HASH.test(fact.sha256)
    && (fact.file_version === null || typeof fact.file_version === "string");
}

function validAclFact(value: unknown, expectedPath: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, ACL_FACT_KEYS) || fact.path !== expectedPath
    || typeof fact.exists !== "boolean" || !Array.isArray(fact.rules)) return false;
  if (fact.exists === false) {
    return fact.owner_sid === null && fact.protected === null && fact.reparse === null
      && fact.rules.length === 0;
  }
  if (typeof fact.owner_sid !== "string" || !SID.test(fact.owner_sid)
    || typeof fact.protected !== "boolean" || typeof fact.reparse !== "boolean") return false;
  return fact.rules.every((value) => {
    const rule = object(value);
    return !!rule && exactKeys(rule, ACL_RULE_KEYS)
      && typeof rule.sid === "string" && SID.test(rule.sid)
      && (rule.type === "Allow" || rule.type === "Deny")
      && safeInteger(rule.rights)
      && typeof rule.inherited === "boolean"
      && typeof rule.inheritance === "string"
      && typeof rule.propagation === "string";
  });
}

function validVolumeFact(value: unknown): boolean {
  const fact = object(value);
  return !!fact && exactKeys(fact, VOLUME_KEYS)
    && (fact.device_id === "C:" || fact.device_id === "D:")
    && safeInteger(fact.drive_type)
    && safeInteger(fact.free_bytes)
    && safeInteger(fact.size_bytes)
    && typeof fact.file_system === "string" && fact.file_system.length > 0;
}

function validListener(value: unknown): boolean {
  const listener = object(value);
  return !!listener && exactKeys(listener, LISTENER_KEYS)
    && typeof listener.address === "string" && listener.address.length > 0
    && (listener.port === 8443 || listener.port === 18443)
    && safeInteger(listener.pid, 1);
}

function validProcess(value: unknown): boolean {
  const process = object(value);
  return !!process && exactKeys(process, PROCESS_KEYS)
    && safeInteger(process.pid, 1) && safeInteger(process.parent_pid)
    && typeof process.name === "string"
    && ["bun.exe", "node.exe", "vivado.exe", "vivado_lab.exe", "hw_server.exe"].includes(process.name.toLowerCase())
    && (process.executable_path === null || safePath(process.executable_path, true))
    && (process.creation_date === null || isoTimestamp(process.creation_date));
}

function validateSnapshot(snapshot: Record<string, unknown>, config: M4fDirectAdmissionConfig): void {
  const identity = object(snapshot.identity);
  const acl = Array.isArray(snapshot.acl) ? snapshot.acl : null;
  const volumes = Array.isArray(snapshot.volumes) ? snapshot.volumes : null;
  const listeners = Array.isArray(snapshot.listeners) ? snapshot.listeners : null;
  const processes = Array.isArray(snapshot.relevant_processes) ? snapshot.relevant_processes : null;
  const stageElapsed = object(snapshot.stage_elapsed_ms);
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)
    || snapshot.schema !== "synthia-m4f-direct-target-admission-snapshot.v1"
    || !isoTimestamp(snapshot.observed_at_utc)
    || !identity || !exactKeys(identity, IDENTITY_KEYS)
    || identity.computer_name !== TARGET_COMPUTER
    || identity.identity_name !== config.target.identity_name
    || identity.identity_sid !== config.target.identity_sid
    || snapshot.hardware_action_performed !== false
    || !volumes || volumes.length !== 2 || !volumes.every(validVolumeFact)
    || new Set(volumes.map((value) => object(value)?.device_id)).size !== 2
    || !acl || acl.length !== config.target.acl_paths.length
    || !listeners || !listeners.every(validListener)
    || !processes || !processes.every(validProcess)
    || !validFileFact(snapshot.vivado, config.target.vivado_executable)
    || !validFileFact(snapshot.bun, config.target.bun_executable)
    || !stageElapsed || !exactKeys(stageElapsed, STAGE_ELAPSED_KEYS)
    || Object.values(stageElapsed).some((value) => !safeInteger(value))) {
    fail("M4F_DIRECT_ADMISSION_SNAPSHOT_INVALID", "output_validation");
  }
  for (let index = 0; index < config.target.acl_paths.length; index += 1) {
    if (!validAclFact(acl[index], config.target.acl_paths[index]!)) {
      fail("M4F_DIRECT_ADMISSION_SNAPSHOT_INVALID", "output_validation");
    }
  }
}

export function executeM4fDirectAdmission(
  rawConfig: unknown,
  dependencies: M4fDirectAdmissionDependencies = systemDependencies,
): {
  result: M4fDirectAdmissionResult;
  effectiveConfig: Buffer;
  rawSnapshot: Buffer;
  canonicalConfig: Buffer;
  transportStdin: Buffer;
} {
  const config = validateM4fDirectAdmissionConfig(rawConfig);
  const sourceBefore = dependencies.sourceBytes();
  const canonicalConfig = Buffer.from(canonicalJson(config) + "\n", "utf8");
  const diagnosticBinding = {
    config_sha256: sha256(canonicalConfig),
    source_sha256: sha256(sourceBefore),
  };
  const before = captureM4fDirectTransportInputs(config);

  const effective = dependencies.spawn(
    SSH_PATH,
    buildDirectSshEffectiveArguments(config),
    Buffer.alloc(0),
    15_000,
  );
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) {
    const effectiveProcess = processEvidence(effective);
    failWithRawSshStderr(
      "M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_FAILED",
      "local_preflight",
      effectiveProcess,
      effective.stderr,
    );
  }
  auditDirectSshEffectiveConfig(effective.stdout, config);
  const effectiveHash = sha256(effective.stdout);
  if (config.target.expected_effective_config_sha256 !== null
    && effectiveHash !== config.target.expected_effective_config_sha256) {
    fail("M4F_DIRECT_ADMISSION_EFFECTIVE_CONFIG_HASH_MISMATCH", "local_preflight");
  }

  const transportStdin = Buffer.from(buildTargetAdmissionScript(config), "ascii");
  const raw = dependencies.spawn(
    SSH_PATH,
    buildDirectSshArguments(config),
    transportStdin,
    ADMISSION_NETWORK_TIMEOUT_MS,
  );
  const process = processEvidence(raw, transportStdin);
  const sourceAfter = dependencies.sourceBytes();
  const after = captureM4fDirectTransportInputs(config, "network");
  if (canonicalJson(before) !== canonicalJson(after)) {
    fail("M4F_DIRECT_ADMISSION_LOCAL_INPUT_DRIFT", "network", { process, ...diagnosticBinding });
  }
  if (!sourceBefore.equals(sourceAfter)) {
    fail("M4F_DIRECT_ADMISSION_SOURCE_DRIFT", "network", { process, ...diagnosticBinding });
  }
  if (raw.status !== 0 || raw.signal !== null || raw.errorCode !== null || raw.stderr.length !== 0) {
    failWithRawSshStderr(
      "M4F_DIRECT_ADMISSION_TRANSPORT_FAILED",
      "network",
      process,
      raw.stderr,
      diagnosticBinding,
    );
  }
  let snapshot: Record<string, unknown>;
  try {
    snapshot = parseSingleJson(raw.stdout);
    validateSnapshot(snapshot, config);
  } catch (error) {
    if (error instanceof M4fDirectAdmissionFailure) {
      throw new M4fDirectAdmissionFailure({
        ...error.detail,
        process,
        ...diagnosticBinding,
      });
    }
    throw error;
  }
  const result: M4fDirectAdmissionResult = {
    schema: "synthia-m4f-direct-admission-record.v1",
    gate_id: config.gate_id,
    action: "admission_snapshot",
    status: "observed",
    retry_permitted: false,
    recorded_at_utc: dependencies.now().toISOString(),
    config_sha256: diagnosticBinding.config_sha256,
    source_sha256: diagnosticBinding.source_sha256,
    remote_wrapper_length: directPowerShellStdinWrapperFact().source_length,
    remote_wrapper_sha256: directPowerShellStdinWrapperFact().source_sha256,
    remote_command_length: directPowerShellStdinWrapperFact().command_length,
    effective_config_sha256: effectiveHash,
    target_binding: {
      host: TARGET_HOST,
      port: 22,
      user: TARGET_USER,
      computer_name: TARGET_COMPUTER,
      identity_name: config.target.identity_name,
      identity_sid: config.target.identity_sid,
      host_key_fingerprint: config.target.host_key_fingerprint,
    },
    local_inputs_before: before,
    local_inputs_after: after,
    target_snapshot: snapshot,
    process,
  };
  return {
    result,
    effectiveConfig: effective.stdout,
    rawSnapshot: raw.stdout,
    canonicalConfig,
    transportStdin,
  };
}

export function recordM4fDirectAdmission(
  rawConfig: unknown,
  evidenceDirectory: string,
  dependencies: M4fDirectAdmissionDependencies = systemDependencies,
): M4fDirectAdmissionResult {
  const absolute = resolve(evidenceDirectory);
  try {
    mkdirSync(absolute, { mode: 0o700, recursive: false });
    chmodSync(absolute, 0o700);
  } catch {
    fail("M4F_DIRECT_ADMISSION_EVIDENCE_DIRECTORY_INVALID", "local_preflight");
  }
  function writeEvidence(name: string, content: string | Buffer): void {
    const path = absolute + "/" + name;
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
  }
  let evidence;
  try {
    evidence = executeM4fDirectAdmission(rawConfig, dependencies);
  } catch (error) {
    const detail = error instanceof M4fDirectAdmissionFailure
      ? error.detail
      : { schema: "synthia-m4f-direct-admission-failure.v1", code: "M4F_DIRECT_ADMISSION_UNEXPECTED", stage: "unknown", effect_state: "unknown", retry_permitted: false };
    writeEvidence("admission-failure.json", JSON.stringify(detail, null, 2) + "\n");
    if (error instanceof M4fDirectAdmissionFailure && error.rawSshStderr !== null) {
      const process = object(error.detail.process);
      if (!process
        || process.stderr_length !== error.rawSshStderr.length
        || process.stderr_sha256 !== sha256(error.rawSshStderr)) {
        throw new M4fDirectAdmissionFailure({
          schema: "synthia-m4f-direct-admission-failure.v1",
          code: "M4F_DIRECT_ADMISSION_STDERR_BINDING_INVALID",
          stage: "evidence",
          effect_state: "unknown",
          retry_permitted: false,
        });
      }
      writeEvidence("ssh-stderr.raw", error.rawSshStderr);
    }
    throw error;
  }
  writeEvidence("admission-record.json", JSON.stringify(evidence.result, null, 2) + "\n");
  writeEvidence("admission-config.canonical.json", evidence.canonicalConfig);
  writeEvidence("direct-ssh-effective-config.txt", evidence.effectiveConfig);
  writeEvidence("powershell-stdin-wrapper.ps1", M4F_DIRECT_POWERSHELL_STDIN_WRAPPER_SOURCE);
  writeEvidence("target-admission-stdin.ps1", evidence.transportStdin);
  writeEvidence("target-admission-snapshot.json", evidence.rawSnapshot);
  return evidence.result;
}

const systemDependencies: M4fDirectAdmissionDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
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
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== "--execute-admission" || args[1] !== "--config" || args[3] !== "--evidence") {
    console.error("usage: bun connector/scripts/m4f-gate-admission-transport.ts --execute-admission --config <direct-config.json> --evidence <new-directory>");
    process.exitCode = 64;
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
    process.stdout.write(JSON.stringify(recordM4fDirectAdmission(raw, args[4]!)) + "\n");
  } catch (error) {
    const detail = error instanceof M4fDirectAdmissionFailure
      ? error.detail
      : { schema: "synthia-m4f-direct-admission-failure.v1", code: "M4F_DIRECT_ADMISSION_UNEXPECTED", stage: "unknown", effect_state: "unknown", retry_permitted: false };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();

export const M4F_DIRECT_ADMISSION_GUARDS = {
  sshPath: SSH_PATH,
  targetHost: TARGET_HOST,
  targetComputer: TARGET_COMPUTER,
  allowedAction: "admission_snapshot" as const,
  networkTimeoutMs: ADMISSION_NETWORK_TIMEOUT_MS,
  serverAliveIntervalSeconds: SERVER_ALIVE_INTERVAL_SECONDS,
  serverAliveCountMax: SERVER_ALIVE_COUNT_MAX,
  serverAliveEnabled: SERVER_ALIVE_INTERVAL_SECONDS > 0,
  powerShellStdinWrapper: directPowerShellStdinWrapperFact(),
};
