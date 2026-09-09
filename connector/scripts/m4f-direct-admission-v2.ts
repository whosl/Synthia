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
import { buildIdentityResidueFollowupLoader } from "./m4f-direct-identity-residue-followup.ts";
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
const TIMEOUT_MS = 240_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const COMMAND_LENGTH_LIMIT = 6500;
const WINDOWS_CMD_LIMIT = 8191;
const TARGET_ACL_PATHS = [
  "C:\\Windows\\Temp",
  "D:\\synthia-worker",
  "D:\\Xilinx\\Vivado\\2021.1",
] as const;
const TARGET_VIVADO = "D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat";
const TARGET_BUN = "D:\\synthia-worker\\runtime\\bun-1.3.14\\bun.exe";
const HASH = /^[0-9a-f]{64}$/u;
const SID = /^S-1-(?:[0-9]+-){1,14}[0-9]+$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RETIRED_ADMISSION_IDS = new Set([
  "m4f-direct-admission-v2-prod-20260828-01",
  "m4f-direct-admission-v2-prod-20260828-02",
]);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u;

export interface M4fDirectAdmissionV2Config {
  schema: "synthia-m4f-direct-admission-v2-config.v1";
  admission_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  expected_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_loader_source_sha256: string;
}

export interface AdmissionV2Dependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  loaderSourceBytes(): Buffer;
  now(): Date;
  monotonicMs(): number;
}

interface BoundFileFact {
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

interface ProcessEvidence {
  exit_status: number | null;
  signal: string | null;
  error_code: string | null;
  timed_out: boolean;
  outcome_ambiguous: boolean;
  stdin_length: 0;
  stdout_length: number;
  stdout_sha256: string;
  stderr_length: number;
  stderr_sha256: string;
  retry_permitted: false;
}

export interface AdmissionV2Record {
  schema: "synthia-m4f-direct-admission-v2-record.v1";
  admission_id: string;
  status: "observed";
  action: "single_session_admission_snapshot";
  retry_permitted: false;
  recorded_at_utc: string;
  elapsed_ms: number;
  config_sha256: string;
  source_sha256: string;
  transport_source_sha256: string;
  loader_source_sha256: string;
  effective_config_sha256: string;
  remote_script_length: number;
  remote_script_sha256: string;
  remote_compressed_length: number;
  remote_compressed_sha256: string;
  remote_loader_length: number;
  remote_loader_sha256: string;
  remote_command_length: number;
  attempt: 1;
  timeout_ms: 240000;
  stdin_length: 0;
  process: ProcessEvidence;
  transport_inputs_before: LocalInputFact[];
  transport_inputs_after: LocalInputFact[];
  admission_config_before: BoundFileFact;
  admission_config_after: BoundFileFact;
  target_snapshot: Record<string, unknown>;
  hardware_action_performed: false;
  process_termination_performed: false;
}

export class AdmissionV2Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_DIRECT_ADMISSION_V2_FAILED"));
  }
}

const CONFIG_KEYS = [
  "admission_config_path",
  "admission_config_sha256",
  "admission_id",
  "expected_loader_source_sha256",
  "expected_source_sha256",
  "expected_transport_source_sha256",
  "schema",
] as const;
const SNAPSHOT_KEYS = [
  "acl", "bun", "hardware_action_performed", "identity", "listeners",
  "observed_at_utc", "process_termination_performed", "relevant_processes",
  "schema", "vivado", "volumes",
] as const;
const IDENTITY_KEYS = [
  "computer_name", "user_domain", "user_name", "whoami_name", "whoami_sid",
] as const;
const VOLUME_KEYS = ["device_id", "drive_type", "file_system", "free_bytes", "size_bytes"] as const;
const FILE_KEYS = ["exists", "file_version", "length", "path", "sha256"] as const;
const ACL_KEYS = ["exists", "owner_sid", "path", "protected", "reparse", "rules"] as const;
const RULE_KEYS = ["inheritance", "inherited", "propagation", "rights", "sid", "type"] as const;
const LISTENER_KEYS = ["address", "pid", "port"] as const;
const PROCESS_KEYS = ["creation_date", "executable_path", "name", "parent_pid", "pid"] as const;

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
  throw new AdmissionV2Failure({
    schema: "synthia-m4f-direct-admission-v2-failure.v1",
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

export function validateAdmissionV2Config(value: unknown): M4fDirectAdmissionV2Config {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-admission-v2-config.v1"
    || typeof config.admission_id !== "string" || !SAFE_ID.test(config.admission_id)
    || RETIRED_ADMISSION_IDS.has(config.admission_id)
    || !safeLocalPath(config.admission_config_path)
    || typeof config.admission_config_sha256 !== "string" || !HASH.test(config.admission_config_sha256)
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_transport_source_sha256 !== "string"
    || !HASH.test(config.expected_transport_source_sha256)
    || typeof config.expected_loader_source_sha256 !== "string"
    || !HASH.test(config.expected_loader_source_sha256)) {
    fail("M4F_DIRECT_ADMISSION_V2_CONFIG_INVALID", "config");
  }
  return value as M4fDirectAdmissionV2Config;
}

function readBoundAdmissionConfig(config: M4fDirectAdmissionV2Config): {
  admission: M4fDirectAdmissionConfig;
  fact: BoundFileFact;
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
      fail("M4F_DIRECT_ADMISSION_V2_ADMISSION_CONFIG_UNTRUSTED", "local_preflight");
    }
    stat = after;
  } catch (error) {
    if (error instanceof AdmissionV2Failure) throw error;
    fail("M4F_DIRECT_ADMISSION_V2_ADMISSION_CONFIG_UNAVAILABLE", "local_preflight");
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const digest = sha256(bytes);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || bytes.length < 1 || bytes.length > MAX_STREAM_BYTES
    || digest !== config.admission_config_sha256) {
    fail("M4F_DIRECT_ADMISSION_V2_ADMISSION_CONFIG_UNTRUSTED", "local_preflight");
  }
  let admission: M4fDirectAdmissionConfig;
  try {
    admission = validateM4fDirectAdmissionConfig(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ));
  } catch {
    fail("M4F_DIRECT_ADMISSION_V2_ADMISSION_CONFIG_INVALID", "local_preflight");
  }
  if (admission.target.expected_effective_config_sha256 === null) {
    fail("M4F_DIRECT_ADMISSION_V2_EFFECTIVE_CONFIG_HASH_REQUIRED", "local_preflight");
  }
  if (canonicalJson(admission.target.acl_paths) !== canonicalJson(TARGET_ACL_PATHS)
    || admission.target.vivado_executable !== TARGET_VIVADO
    || admission.target.bun_executable !== TARGET_BUN) {
    fail("M4F_DIRECT_ADMISSION_V2_TARGET_LAYOUT_MISMATCH", "local_preflight");
  }
  return {
    admission,
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
}

function validateSources(
  config: M4fDirectAdmissionV2Config,
  dependencies: Pick<AdmissionV2Dependencies, "sourceBytes" | "transportSourceBytes" | "loaderSourceBytes">,
  stage: "local_preflight" | "network" = "local_preflight",
): void {
  const facts: Array<[Buffer, string, string]> = [
    [dependencies.sourceBytes(), config.expected_source_sha256, "SOURCE"],
    [dependencies.transportSourceBytes(), config.expected_transport_source_sha256, "TRANSPORT_SOURCE"],
    [dependencies.loaderSourceBytes(), config.expected_loader_source_sha256, "LOADER_SOURCE"],
  ];
  for (const [bytes, expected, label] of facts) {
    if (bytes.length < 1 || bytes.length > MAX_STREAM_BYTES || sha256(bytes) !== expected) {
      fail("M4F_DIRECT_ADMISSION_V2_" + label + "_MISMATCH", stage);
    }
  }
}

export function buildAdmissionV2Script(admission: M4fDirectAdmissionConfig): string {
  return [
    "$ErrorActionPreference=\"Stop\";[Console]::OutputEncoding=[Text.UTF8Encoding]::new()",
    "$s=\"" + admission.target.identity_sid + "\"",
    "if($env:COMPUTERNAME-cne\"DESKTOP-DVFFB09\"-or$env:USERNAME-ine\"admin\"){throw \"E\"}",
    "$p=\"C:\\Windows\\System32\\whoami.exe\";if($env:SystemRoot-ine\"C:\\Windows\"-or-not[IO.File]::Exists($p)){throw \"P\"}",
    "$r=@(& $p /user /fo csv /nh|?{$_});if($LASTEXITCODE-or$r.Count-ne 1){throw \"X\"}",
    "$w=@(ConvertFrom-Csv -InputObject ($r[0]) -Header n,s);if($w.Count-ne 1-or-not$w.n-or-not$w.s){throw \"C\"};$wn=$w.n.Trim().ToLowerInvariant();$ws=$w.s.Trim()",
    "if($wn-cne\"desktop-dvffb09\\admin\"-or$ws-cne$s){throw \"I\"}",
    "function SFile($x){if(-not[IO.File]::Exists($x)){return [ordered]@{p=$x;e=$false;l=$null;h=$null;v=$null}};$y=Get-Item -LiteralPath $x -Force;[ordered]@{p=$x;e=$true;l=[long]$y.Length;h=(Get-FileHash -LiteralPath $x -Algorithm SHA256).Hash.ToLower();v=$y.VersionInfo.FileVersion}}",
    "function SAcl($x){if(-not(Test-Path -LiteralPath $x)){return [ordered]@{p=$x;e=$false;o=$null;x=$null;y=$null;r=@()}};$y=Get-Item -LiteralPath $x -Force;$z=Get-Acl -LiteralPath $x;$o=([Security.Principal.NTAccount]$z.Owner).Translate([Security.Principal.SecurityIdentifier]).Value;$r=@($z.Access|% -Process {$q=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;[ordered]@{s=$q;t=$_.AccessControlType.ToString();r=[int]$_.FileSystemRights;i=[bool]$_.IsInherited;n=$_.InheritanceFlags.ToString();p=$_.PropagationFlags.ToString()}}|sort -Property s,t,r,i,n,p);[ordered]@{p=$x;e=$true;o=$o;x=[bool]$z.AreAccessRulesProtected;y=[bool](($y.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0);r=$r}}",
    "$d=@(Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DeviceID='C:' OR DeviceID='D:'\"|sort -Property DeviceID|% -Process {[ordered]@{d=$_.DeviceID;t=[int]$_.DriveType;f=[long]$_.FreeSpace;s=[long]$_.Size;y=$_.FileSystem}})",
    "$a=@(@(\"C:\\Windows\\Temp\",\"D:\\synthia-worker\",\"D:\\Xilinx\\Vivado\\2021.1\")|% -Process {SAcl $_})",
    "$l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|? -FilterScript {$_.LocalPort-eq 8443-or$_.LocalPort-eq 18443}|sort -Property LocalPort,OwningProcess|% -Process {[ordered]@{a=$_.LocalAddress;p=[int]$_.LocalPort;i=[int]$_.OwningProcess}})",
    "$m=@(\"bun.exe\",\"node.exe\",\"vivado.exe\",\"vivado_lab.exe\",\"hw_server.exe\");$q=@(Get-CimInstance -ClassName Win32_Process|? -FilterScript {$m-ccontains$_.Name}|sort -Property ProcessId|% -Process {[ordered]@{i=[int]$_.ProcessId;p=[int]$_.ParentProcessId;n=$_.Name;x=$_.ExecutablePath;c=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString(\"o\")}}})",
    "$x=[ordered]@{s=\"s2\";t=[DateTime]::UtcNow.ToString(\"o\");i=[ordered]@{c=$env:COMPUTERNAME;d=$env:USERDOMAIN;u=$env:USERNAME;n=$wn;s=$ws};v=$d;a=$a;l=$l;p=$q;x=SFile \"D:\\Xilinx\\Vivado\\2021.1\\bin\\vivado.bat\";b=SFile \"D:\\synthia-worker\\runtime\\bun-1.3.14\\bun.exe\";h=$false;k=$false};$x|ConvertTo-Json -Compress -Depth 12",
    "",
  ].join("\n");
}

export function buildAdmissionV2Command(admission: M4fDirectAdmissionConfig): {
  script: string;
  compressed: Buffer;
  loader: string;
  command: string;
} {
  const script = buildAdmissionV2Script(admission);
  const { compressed, loader } = buildIdentityResidueFollowupLoader(script);
  const encoded = Buffer.from(loader, "utf16le").toString("base64");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + encoded;
  if (command.length > COMMAND_LENGTH_LIMIT) {
    fail("M4F_DIRECT_ADMISSION_V2_COMMAND_TOO_LONG", "local_preflight", {
      command_length: command.length,
      command_length_limit: COMMAND_LENGTH_LIMIT,
    });
  }
  return { script, compressed, loader, command };
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function signedInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= -2_147_483_648 && value <= 2_147_483_647;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function windowsPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 1024
    && /^[A-Za-z]:\\[^\r\n\0]*$/u.test(value);
}

function validFile(value: unknown, path: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, FILE_KEYS) || fact.path !== path || typeof fact.exists !== "boolean") return false;
  return fact.exists
    ? safeInteger(fact.length) && typeof fact.sha256 === "string" && HASH.test(fact.sha256)
      && (fact.file_version === null || typeof fact.file_version === "string")
    : fact.length === null && fact.sha256 === null && fact.file_version === null;
}

function validAcl(value: unknown, path: string): boolean {
  const fact = object(value);
  if (!fact || !exactKeys(fact, ACL_KEYS) || fact.path !== path || typeof fact.exists !== "boolean"
    || !Array.isArray(fact.rules)) return false;
  if (!fact.exists) return fact.owner_sid === null && fact.protected === null
    && fact.reparse === null && fact.rules.length === 0;
  return typeof fact.owner_sid === "string" && SID.test(fact.owner_sid)
    && typeof fact.protected === "boolean" && typeof fact.reparse === "boolean"
    && fact.rules.every((item) => {
      const rule = object(item);
      return !!rule && exactKeys(rule, RULE_KEYS)
        && typeof rule.sid === "string" && SID.test(rule.sid)
        && (rule.type === "Allow" || rule.type === "Deny") && signedInt32(rule.rights)
        && typeof rule.inherited === "boolean" && typeof rule.inheritance === "string"
        && typeof rule.propagation === "string";
    });
}

export function validateAdmissionV2Snapshot(
  snapshot: Record<string, unknown>,
  admission: M4fDirectAdmissionConfig,
): void {
  const identity = object(snapshot.identity);
  const volumes = Array.isArray(snapshot.volumes) ? snapshot.volumes : null;
  const acl = Array.isArray(snapshot.acl) ? snapshot.acl : null;
  const listeners = Array.isArray(snapshot.listeners) ? snapshot.listeners : null;
  const processes = Array.isArray(snapshot.relevant_processes) ? snapshot.relevant_processes : null;
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)
    || snapshot.schema !== "synthia-m4f-direct-target-admission-snapshot.v2"
    || !utcTimestamp(snapshot.observed_at_utc)
    || !identity || !exactKeys(identity, IDENTITY_KEYS)
    || String(identity.computer_name).toLowerCase() !== admission.target.computer_name.toLowerCase()
    || String(identity.user_name).toLowerCase() !== admission.target.user.toLowerCase()
    || typeof identity.user_domain !== "string" || identity.user_domain.length < 1
    || identity.whoami_name !== admission.target.identity_name
    || identity.whoami_sid !== admission.target.identity_sid
    || snapshot.hardware_action_performed !== false || snapshot.process_termination_performed !== false
    || !volumes || volumes.length !== 2 || !volumes.every((value) => {
      const fact = object(value);
      return !!fact && exactKeys(fact, VOLUME_KEYS)
        && (fact.device_id === "C:" || fact.device_id === "D:")
        && safeInteger(fact.drive_type) && safeInteger(fact.free_bytes) && safeInteger(fact.size_bytes)
        && typeof fact.file_system === "string" && fact.file_system.length > 0;
    }) || new Set(volumes.map((value) => object(value)?.device_id)).size !== 2
    || !acl || acl.length !== admission.target.acl_paths.length
    || !listeners || !listeners.every((value) => {
      const fact = object(value);
      return !!fact && exactKeys(fact, LISTENER_KEYS) && typeof fact.address === "string"
        && fact.address.length > 0
        && (fact.port === 8443 || fact.port === 18443) && safeInteger(fact.pid, 1);
    })
    || !processes || !processes.every((value) => {
      const fact = object(value);
      return !!fact && exactKeys(fact, PROCESS_KEYS) && safeInteger(fact.pid, 1)
        && safeInteger(fact.parent_pid) && typeof fact.name === "string"
        && ["bun.exe", "node.exe", "vivado.exe", "vivado_lab.exe", "hw_server.exe"]
          .includes(fact.name.toLowerCase())
        && (fact.executable_path === null || windowsPath(fact.executable_path))
        && (fact.creation_date === null || utcTimestamp(fact.creation_date));
    })
    || !validFile(snapshot.vivado, admission.target.vivado_executable)
    || !validFile(snapshot.bun, admission.target.bun_executable)) {
    fail("M4F_DIRECT_ADMISSION_V2_SNAPSHOT_INVALID", "output_validation");
  }
  for (let index = 0; index < admission.target.acl_paths.length; index += 1) {
    if (!validAcl(acl[index], admission.target.acl_paths[index]!)) {
      fail("M4F_DIRECT_ADMISSION_V2_SNAPSHOT_INVALID", "output_validation");
    }
  }
}

function compactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (!result || !exactKeys(result, keys)) {
    fail("M4F_DIRECT_ADMISSION_V2_COMPACT_SNAPSHOT_INVALID", "output_validation");
  }
  return result;
}

function compactArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    fail("M4F_DIRECT_ADMISSION_V2_COMPACT_SNAPSHOT_INVALID", "output_validation");
  }
  return value;
}

export function expandAdmissionV2CompactSnapshot(value: unknown): Record<string, unknown> {
  const root = compactObject(value, ["a", "b", "h", "i", "k", "l", "p", "s", "t", "v", "x"]);
  if (root.s !== "s2") {
    fail("M4F_DIRECT_ADMISSION_V2_COMPACT_SNAPSHOT_INVALID", "output_validation");
  }
  const identity = compactObject(root.i, ["c", "d", "n", "s", "u"]);
  const file = (item: unknown): Record<string, unknown> => {
    const fact = compactObject(item, ["e", "h", "l", "p", "v"]);
    return {
      path: fact.p,
      exists: fact.e,
      length: fact.l,
      sha256: fact.h,
      file_version: fact.v,
    };
  };
  return {
    schema: "synthia-m4f-direct-target-admission-snapshot.v2",
    observed_at_utc: root.t,
    identity: {
      computer_name: identity.c,
      user_domain: identity.d,
      user_name: identity.u,
      whoami_name: identity.n,
      whoami_sid: identity.s,
    },
    volumes: compactArray(root.v).map((item) => {
      const fact = compactObject(item, ["d", "f", "s", "t", "y"]);
      return {
        device_id: fact.d,
        drive_type: fact.t,
        free_bytes: fact.f,
        size_bytes: fact.s,
        file_system: fact.y,
      };
    }),
    acl: compactArray(root.a).map((item) => {
      const fact = compactObject(item, ["e", "o", "p", "r", "x", "y"]);
      return {
        path: fact.p,
        exists: fact.e,
        owner_sid: fact.o,
        protected: fact.x,
        reparse: fact.y,
        rules: compactArray(fact.r).map((ruleValue) => {
          const rule = compactObject(ruleValue, ["i", "n", "p", "r", "s", "t"]);
          return {
            sid: rule.s,
            type: rule.t,
            rights: rule.r,
            inherited: rule.i,
            inheritance: rule.n,
            propagation: rule.p,
          };
        }),
      };
    }),
    listeners: compactArray(root.l).map((item) => {
      const fact = compactObject(item, ["a", "i", "p"]);
      return { address: fact.a, port: fact.p, pid: fact.i };
    }),
    relevant_processes: compactArray(root.p).map((item) => {
      const fact = compactObject(item, ["c", "i", "n", "p", "x"]);
      return {
        pid: fact.i,
        parent_pid: fact.p,
        name: fact.n,
        executable_path: fact.x,
        creation_date: fact.c,
      };
    }),
    vivado: file(root.x),
    bun: file(root.b),
    hardware_action_performed: root.h,
    process_termination_performed: root.k,
  };
}

function parseSnapshot(bytes: Buffer): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M4F_DIRECT_ADMISSION_V2_OUTPUT_INVALID", "output_validation");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) fail("M4F_DIRECT_ADMISSION_V2_OUTPUT_INVALID", "output_validation");
  try {
    return expandAdmissionV2CompactSnapshot(JSON.parse(lines[0]!));
  } catch (error) {
    if (error instanceof AdmissionV2Failure) throw error;
    fail("M4F_DIRECT_ADMISSION_V2_OUTPUT_INVALID", "output_validation");
  }
}

function processEvidence(raw: RawProcessResult): ProcessEvidence {
  const timedOut = raw.errorCode === "ETIMEDOUT";
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: timedOut,
    outcome_ambiguous: timedOut || raw.signal !== null || raw.errorCode !== null || raw.status !== 0,
    stdin_length: 0,
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
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

export function admissionV2Confirmation(rawConfig: unknown): string {
  const config = validateAdmissionV2Config(rawConfig);
  return "SYNTHIA_M4F_DIRECT_ADMISSION_V2_SINGLE_READ_ONLY:"
    + config.admission_id + ":" + sha256(Buffer.from(canonicalJson(config) + "\n"));
}

export function planAdmissionV2(
  rawConfig: unknown,
  dependencies: Pick<AdmissionV2Dependencies, "sourceBytes" | "transportSourceBytes" | "loaderSourceBytes"> = systemDependencies,
): Record<string, unknown> {
  const config = validateAdmissionV2Config(rawConfig);
  validateSources(config, dependencies);
  const bound = readBoundAdmissionConfig(config);
  const packed = buildAdmissionV2Command(bound.admission);
  return {
    schema: "synthia-m4f-direct-admission-v2-plan.v1",
    status: "planned_not_executed",
    admission_id: config.admission_id,
    target_host: bound.admission.target.host,
    target_user: bound.admission.target.user,
    target_computer: bound.admission.target.computer_name,
    topology: "single_ssh_direct_compressed_encoded_command_empty_stdin",
    attempt_count: 1,
    timeout_ms: TIMEOUT_MS,
    remote_script_length: Buffer.byteLength(packed.script, "ascii"),
    remote_script_sha256: sha256(Buffer.from(packed.script, "ascii")),
    remote_compressed_length: packed.compressed.length,
    remote_compressed_sha256: sha256(packed.compressed),
    remote_loader_length: Buffer.byteLength(packed.loader, "ascii"),
    remote_loader_sha256: sha256(Buffer.from(packed.loader, "ascii")),
    remote_command_length: packed.command.length,
    remote_command_length_limit: COMMAND_LENGTH_LIMIT,
    windows_cmd_limit: WINDOWS_CMD_LIMIT,
    confirmation: admissionV2Confirmation(config),
    network_attempted: false,
    hardware_action_performed: false,
    process_termination_performed: false,
  };
}

export function recordAdmissionV2(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: AdmissionV2Dependencies = systemDependencies,
): AdmissionV2Record {
  const config = validateAdmissionV2Config(rawConfig);
  if (confirmation !== admissionV2Confirmation(config)) {
    fail("M4F_DIRECT_ADMISSION_V2_CONFIRMATION_REQUIRED", "local_preflight");
  }
  validateSources(config, dependencies);
  const boundBefore = readBoundAdmissionConfig(config);
  const admission = boundBefore.admission;
  const inputsBefore = captureM4fDirectTransportInputs(admission);
  const packed = buildAdmissionV2Command(admission);
  const absolute = resolve(evidenceDirectory);
  try {
    mkdirSync(absolute, { mode: 0o700, recursive: false });
    chmodSync(absolute, 0o700);
  } catch {
    fail("M4F_DIRECT_ADMISSION_V2_EVIDENCE_DIRECTORY_INVALID", "local_preflight");
  }
  let remoteProcess: ProcessEvidence | null = null;
  let admissionConfigAfter: BoundFileFact | null = null;
  let transportInputsAfter: LocalInputFact[] | null = null;
  try {
    writeEvidence(absolute, "admission-v2-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "remote-script.ps1", packed.script);
    writeEvidence(absolute, "remote-loader.ps1", packed.loader);
    writeEvidence(absolute, "remote-payload.gzip", packed.compressed);
    const effective = dependencies.spawn(
      SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(absolute, "ssh-effective.stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective.stderr.raw", effective.stderr);
    const effectiveProcess = processEvidence(effective);
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(effectiveProcess, null, 2) + "\n");
    const effectiveHash = sha256(effective.stdout);
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0
      || effectiveHash !== admission.target.expected_effective_config_sha256) {
      fail("M4F_DIRECT_ADMISSION_V2_EFFECTIVE_CONFIG_FAILED", "local_preflight", {
        process: effectiveProcess,
        observed_effective_config_sha256: effectiveHash,
      });
    }
    try {
      auditDirectSshEffectiveConfig(effective.stdout, admission);
    } catch {
      fail("M4F_DIRECT_ADMISSION_V2_EFFECTIVE_CONFIG_MISMATCH", "local_preflight");
    }
    validateSources(config, dependencies);
    const boundCurrent = readBoundAdmissionConfig(config);
    const inputsCurrent = captureM4fDirectTransportInputs(admission, "network");
    if (canonicalJson(boundBefore.fact) !== canonicalJson(boundCurrent.fact)
      || canonicalJson(inputsBefore) !== canonicalJson(inputsCurrent)) {
      fail("M4F_DIRECT_ADMISSION_V2_LOCAL_INPUT_DRIFT", "network");
    }
    const started = dependencies.monotonicMs();
    const raw = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(admission), TARGET_HOST, packed.command],
      Buffer.alloc(0),
      TIMEOUT_MS,
    );
    const elapsed = Math.max(0, Math.round(dependencies.monotonicMs() - started));
    remoteProcess = processEvidence(raw);
    writeEvidence(absolute, "stdout.raw", raw.stdout);
    writeEvidence(absolute, "stderr.raw", raw.stderr);
    writeEvidence(absolute, "remote-process.json", JSON.stringify(remoteProcess, null, 2) + "\n");
    validateSources(config, dependencies, "network");
    const boundAfter = readBoundAdmissionConfig(config);
    admissionConfigAfter = boundAfter.fact;
    const inputsAfter = captureM4fDirectTransportInputs(admission, "network");
    transportInputsAfter = inputsAfter;
    if (canonicalJson(boundBefore.fact) !== canonicalJson(boundAfter.fact)
      || canonicalJson(inputsBefore) !== canonicalJson(inputsAfter)) {
      fail("M4F_DIRECT_ADMISSION_V2_LOCAL_INPUT_DRIFT", "network", { process: remoteProcess });
    }
    if (raw.status !== 0 || raw.signal !== null || raw.errorCode !== null || raw.stderr.length !== 0) {
      fail("M4F_DIRECT_ADMISSION_V2_TRANSPORT_FAILED", "network", { process: remoteProcess });
    }
    const snapshot = parseSnapshot(raw.stdout);
    validateAdmissionV2Snapshot(snapshot, admission);
    const record: AdmissionV2Record = {
      schema: "synthia-m4f-direct-admission-v2-record.v1",
      admission_id: config.admission_id,
      status: "observed",
      action: "single_session_admission_snapshot",
      retry_permitted: false,
      recorded_at_utc: dependencies.now().toISOString(),
      elapsed_ms: elapsed,
      config_sha256: sha256(Buffer.from(canonicalJson(config) + "\n")),
      source_sha256: config.expected_source_sha256,
      transport_source_sha256: config.expected_transport_source_sha256,
      loader_source_sha256: config.expected_loader_source_sha256,
      effective_config_sha256: effectiveHash,
      remote_script_length: Buffer.byteLength(packed.script, "ascii"),
      remote_script_sha256: sha256(Buffer.from(packed.script, "ascii")),
      remote_compressed_length: packed.compressed.length,
      remote_compressed_sha256: sha256(packed.compressed),
      remote_loader_length: Buffer.byteLength(packed.loader, "ascii"),
      remote_loader_sha256: sha256(Buffer.from(packed.loader, "ascii")),
      remote_command_length: packed.command.length,
      attempt: 1,
      timeout_ms: TIMEOUT_MS,
      stdin_length: 0,
      process: remoteProcess,
      transport_inputs_before: inputsBefore,
      transport_inputs_after: inputsAfter,
      admission_config_before: boundBefore.fact,
      admission_config_after: boundAfter.fact,
      target_snapshot: snapshot,
      hardware_action_performed: false,
      process_termination_performed: false,
    };
    writeEvidence(absolute, "admission-v2-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    const detail = error instanceof AdmissionV2Failure
      ? error.detail
      : {
        schema: "synthia-m4f-direct-admission-v2-failure.v1",
        code: "M4F_DIRECT_ADMISSION_V2_UNEXPECTED",
        stage: "unknown",
        remote_effect_state: remoteProcess === null ? "not_started" : "read_only_unknown",
        retry_permitted: false,
      };
    if (remoteProcess !== null) {
      detail.remote_effect_state = "read_only_unknown";
      if (detail.stage === "local_preflight") detail.stage = "network_postflight";
    }
    try {
      writeEvidence(absolute, "admission-v2-failure.json", JSON.stringify({
        ...detail,
        admission_id: config.admission_id,
        remote_process: remoteProcess,
        transport_inputs_before: inputsBefore,
        transport_inputs_after: transportInputsAfter,
        admission_config_before: boundBefore.fact,
        admission_config_after: admissionConfigAfter,
        hardware_action_performed: false,
        process_termination_performed: false,
      }, null, 2) + "\n");
    } catch {
      // Preserve the original failure and already frozen evidence.
    }
    throw error;
  }
}

export function spawnAdmissionV2Process(
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

const systemDependencies: AdmissionV2Dependencies = {
  spawn: spawnAdmissionV2Process,
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  loaderSourceBytes: () => readFileSync(new URL("./m4f-direct-identity-residue-followup.ts", import.meta.url)),
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length === 3 && args[0] === "--plan" && args[1] === "--config") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(planAdmissionV2(raw)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-read-only" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(recordAdmissionV2(raw, args[4]!, args[6]!)) + "\n");
      return;
    }
    console.error("usage: bun connector/scripts/m4f-direct-admission-v2.ts --plan --config <config.json>");
    console.error("   or: bun connector/scripts/m4f-direct-admission-v2.ts --execute-read-only --config <config.json> --confirmation <exact> --evidence <new-directory>");
    process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof AdmissionV2Failure
      ? error.detail
      : {
        schema: "synthia-m4f-direct-admission-v2-failure.v1",
        code: "M4F_DIRECT_ADMISSION_V2_UNEXPECTED",
        stage: "unknown",
        remote_effect_state: "read_only_unknown",
        retry_permitted: false,
      };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();

export const M4F_DIRECT_ADMISSION_V2_GUARDS = {
  targetHost: TARGET_HOST,
  timeoutMs: TIMEOUT_MS,
  effectiveTimeoutMs: EFFECTIVE_TIMEOUT_MS,
  remoteAttemptCount: 1,
  commandLengthLimit: COMMAND_LENGTH_LIMIT,
  windowsCmdLimit: WINDOWS_CMD_LIMIT,
  topology: "single_ssh_direct_compressed_encoded_command_empty_stdin",
  retryPermitted: false,
  hardwareActionPermitted: false,
  processTerminationPermitted: false,
} as const;
