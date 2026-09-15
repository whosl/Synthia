import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  auditDirectSshEffectiveConfig,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  validateM4fDirectAdmissionConfig,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
} from "./m4f-gate-admission-transport.ts";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;
const COMMAND_LIMIT = 7_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const EFFECTIVE_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";
const ATTEMPT2_EVIDENCE_DIRECTORY =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-evidence";
const ATTEMPT2_EVIDENCE_MANIFEST_SHA256 = "db311059ed24dba72428975cc3860a959be80bd7d7387a1c78d56fe17db5ab29";
const ATTEMPT2_FAILURE_SHA256 = "a81e8c91d24a1a674af9c35c364c1c32fa2eb1b49daa9fbe71e0961f64d8ce31";
const ATTEMPT2_REMOTE_PROCESS_SHA256 = "8d20059875898e20eda629c315dd7fcda4ef128a2f13a230be1406cb35058bff";
const ATTEMPT2_ADJUDICATION_PATH =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-adjudication.json";
const ATTEMPT2_ADJUDICATION_SHA256 = "2dfab2a61e29b33fbbedb742296467909a8208c4aa9b512e8b39a0fd694bca10";
const ATTEMPT2_REVIEW_PATH =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-attempt2-prod-20260830-20-review.json";
const ATTEMPT2_REVIEW_SHA256 = "ad2ec977f310c0ebe3bd76082a6b3e39cd4da1bc177d2f7060b1df2de1cc6a9f";

export const RESIDUE_INVENTORY_ID = "m4f-direct-attempt2-residue-inventory-prod-20260830-21";
export const RESIDUE_INVENTORY_WINDOW_START = "2026-08-30T14:10:49.000Z";
export const RESIDUE_INVENTORY_WINDOW_END = "2026-08-30T14:11:19.999Z";
export const RESIDUE_INVENTORY_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-21-evidence";

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url));
const TRANSPORT_SOURCE_PATH = fileURLToPath(new URL("./m4f-gate-admission-transport.ts", import.meta.url));

export const ATTEMPT2_EVIDENCE_MANIFEST = {
  "candidate19-script-config.raw.json": "10362a81f6b1d91596b3fa64fcab14d0f6fe49be9674ca97d411493a304a04d4",
  "confirmation.sha256": "68ebab55bd00bd5a41f525c489e245e032c29cf0d9f43771635e9b845bbfb4c0",
  "frozen-file-facts-initial.json": "f7d1bf2f95ad49ef42d89804b39355eeecb1fc7228287085e1a1e931eb78ad34",
  "frozen-file-facts-post-remote.json": "f7d1bf2f95ad49ef42d89804b39355eeecb1fc7228287085e1a1e931eb78ad34",
  "frozen-file-facts-pre-remote.json": "f7d1bf2f95ad49ef42d89804b39355eeecb1fc7228287085e1a1e931eb78ad34",
  "parse-config.canonical.json": "4328ee421289267ceec189224176f9acc23468aa0559dd9d1f2223b54012c6f6",
  "parse-failure.json": ATTEMPT2_FAILURE_SHA256,
  "parse-loader.ps1": "5ba19ece8926ddad4aeabf2869a4f83b67bf618fcfba6a33f8a08bbe263a311b",
  "plan.canonical.json": "c5eddb82f74d410adc42132f36632fa9a30166c003e539b6eadcb60fc34e478f",
  "remote-process.json": ATTEMPT2_REMOTE_PROCESS_SHA256,
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_SHA256,
  "stderr.raw": EMPTY_SHA256,
  "stdout.raw": EMPTY_SHA256,
  "target-business-script.ps1": "55dbf18a08b579f18e5ef79a7fbcccf59bcfee9429c25112537effc8420583ae",
  "target-outer-loader.ps1": "089f5744c1a2d7b145e8b0cc7caefcd015d916b7331fe28a9e369fd37d77f8eb",
  "transport-config.raw.json": TRANSPORT_CONFIG_SHA256,
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

export interface ResidueInventoryConfig {
  schema: "synthia-m4f-direct-attempt2-residue-inventory-config.v1";
  inventory_id: typeof RESIDUE_INVENTORY_ID;
  evidence_directory: typeof RESIDUE_INVENTORY_EVIDENCE_DIRECTORY;
  transport_config_path: typeof TRANSPORT_CONFIG_PATH;
  transport_config_sha256: typeof TRANSPORT_CONFIG_SHA256;
  attempt2_evidence_directory: typeof ATTEMPT2_EVIDENCE_DIRECTORY;
  attempt2_evidence_manifest_sha256: typeof ATTEMPT2_EVIDENCE_MANIFEST_SHA256;
  attempt2_failure_sha256: typeof ATTEMPT2_FAILURE_SHA256;
  attempt2_remote_process_sha256: typeof ATTEMPT2_REMOTE_PROCESS_SHA256;
  attempt2_adjudication_path: typeof ATTEMPT2_ADJUDICATION_PATH;
  attempt2_adjudication_sha256: typeof ATTEMPT2_ADJUDICATION_SHA256;
  attempt2_review_path: typeof ATTEMPT2_REVIEW_PATH;
  attempt2_review_sha256: typeof ATTEMPT2_REVIEW_SHA256;
  window_start_utc: typeof RESIDUE_INVENTORY_WINDOW_START;
  window_end_utc: typeof RESIDUE_INVENTORY_WINDOW_END;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_transport_source_sha256: typeof TRANSPORT_SOURCE_SHA256;
  expected_effective_config_sha256: typeof EFFECTIVE_SHA256;
}

export interface ResidueInventoryDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  read(path: string): Buffer;
  entries(path: string): string[];
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class ResidueInventoryFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_ATTEMPT2_RESIDUE_INVENTORY_FAILED"));
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJsonResidueInventory(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonResidueInventory).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonResidueInventory(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string, stage: string): never {
  throw new ResidueInventoryFailure({
    schema: "synthia-m4f-direct-attempt2-residue-inventory-failure.v1",
    code,
    stage,
    retry_permitted: false,
    stdin_length: 0,
    cleanup_performed: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  });
}

const CONFIG_KEYS = [
  "attempt2_adjudication_path", "attempt2_adjudication_sha256", "attempt2_evidence_directory",
  "attempt2_evidence_manifest_sha256", "attempt2_failure_sha256", "attempt2_remote_process_sha256",
  "attempt2_review_path", "attempt2_review_sha256", "evidence_directory",
  "expected_effective_config_sha256", "expected_source_sha256", "expected_test_source_sha256",
  "expected_transport_source_sha256", "inventory_id", "schema", "transport_config_path",
  "transport_config_sha256", "window_end_utc", "window_start_utc",
] as const;

export function validateResidueInventoryConfig(value: unknown): ResidueInventoryConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-attempt2-residue-inventory-config.v1"
    || config.inventory_id !== RESIDUE_INVENTORY_ID || !SAFE_ID.test(String(config.inventory_id))
    || config.evidence_directory !== RESIDUE_INVENTORY_EVIDENCE_DIRECTORY
    || config.transport_config_path !== TRANSPORT_CONFIG_PATH
    || config.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || config.attempt2_evidence_directory !== ATTEMPT2_EVIDENCE_DIRECTORY
    || config.attempt2_evidence_manifest_sha256 !== ATTEMPT2_EVIDENCE_MANIFEST_SHA256
    || config.attempt2_failure_sha256 !== ATTEMPT2_FAILURE_SHA256
    || config.attempt2_remote_process_sha256 !== ATTEMPT2_REMOTE_PROCESS_SHA256
    || config.attempt2_adjudication_path !== ATTEMPT2_ADJUDICATION_PATH
    || config.attempt2_adjudication_sha256 !== ATTEMPT2_ADJUDICATION_SHA256
    || config.attempt2_review_path !== ATTEMPT2_REVIEW_PATH
    || config.attempt2_review_sha256 !== ATTEMPT2_REVIEW_SHA256
    || config.window_start_utc !== RESIDUE_INVENTORY_WINDOW_START
    || config.window_end_utc !== RESIDUE_INVENTORY_WINDOW_END
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_test_source_sha256 !== "string" || !HASH.test(config.expected_test_source_sha256)
    || config.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || config.expected_effective_config_sha256 !== EFFECTIVE_SHA256) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_CONFIG_INVALID", "config");
  }
  return value as ResidueInventoryConfig;
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export const INVENTORY_HASH_HELPER =
  "function Get-SynthiaM4fInventoryHash($v){if ($null -eq $v){return $null};$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash(([Text.UTF8Encoding]::new($false,$true)).GetBytes([string]$v))) -replace '-','').ToLowerInvariant()}finally{$h.Dispose()}}";
export const INVENTORY_ROW_HELPER =
  "function ConvertTo-SynthiaM4fInventoryRow($p,$root,$x){$q=$p.CommandLine;$c=if ($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null};,@([int]$p.ProcessId,[int]$p.ParentProcessId,$p.Name.ToLowerInvariant(),$c,[int]$p.SessionId,($null -ne $q),$(if ($null -ne $q){([string]$q).Length}else{$null}),$(Get-SynthiaM4fInventoryHash $q),$root,$x)}";

export function buildResidueInventoryScript(rawConfig: unknown): string {
  const config = validateResidueInventoryConfig(rawConfig);
  const start = JSON.stringify({ s: "r21", id: config.inventory_id, n: 1, t: "start", z: "observed" });
  return [
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine(" + psLiteral(start) + ");[Console]::Out.Flush()",
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$id=" + psLiteral(config.inventory_id)
      + ";$ws=[DateTime]::Parse(" + psLiteral(config.window_start_utc) + ").ToUniversalTime();$we=[DateTime]::Parse("
      + psLiteral(config.window_end_utc) + ").ToUniversalTime()",
    INVENTORY_HASH_HELPER,
    INVENTORY_ROW_HELPER,
    "$a=@(Get-CimInstance Win32_Process);$m=@{};foreach ($p in $a){$m[[int]$p.ProcessId]=$p};$cur=$m[[int]$PID];$root=$null;$q=$cur;for ($i=0; $i -lt 8 -and $q; $i++){if ($q.Name -ieq 'sshd.exe'){$root=[int]$q.ProcessId;break};$q=$m[[int]$q.ParentProcessId]};if ($null -eq $root){throw 'DIAG_ROOT'}",
    "$ds=New-Object 'Collections.Generic.HashSet[int]';[void]$ds.Add($root);do{$chg=$false;foreach ($p in $a){if ($ds.Contains([int]$p.ParentProcessId) -and $ds.Add([int]$p.ProcessId)){$chg=$true}}}while ($chg);$diag=@();foreach ($p in $a){if ($ds.Contains([int]$p.ProcessId)){$diag+=,(ConvertTo-SynthiaM4fInventoryRow $p $root $true)}}",
    "$cand=@();foreach ($p in $a){$c=if ($p.CreationDate){$p.CreationDate.ToUniversalTime()}else{$null};if ($c -ge $ws -and $c -le $we -and $p.Name -in @('sshd.exe','powershell.exe','cmd.exe','conhost.exe') -and -not $ds.Contains([int]$p.ProcessId)){$tr=$null;$u=$p;for ($i=0; $i -lt 8 -and $u; $i++){if ($u.Name -ieq 'sshd.exe'){$tr=[int]$u.ProcessId;break};$u=$m[[int]$u.ParentProcessId]};$cand+=,(ConvertTo-SynthiaM4fInventoryRow $p $tr $false)}}",
    "$w=$m[13644];$wr=if ($w){ConvertTo-SynthiaM4fInventoryRow $w $null $false}else{$null};$wx=$null -ne $w -and $w.Name -ieq 'node.exe' -and [int]$w.ParentProcessId -eq 2712 -and $w.ExecutablePath -ceq 'D:\\softwares\\Nodejs\\node.exe' -and $w.CreationDate.ToUniversalTime().ToString('o') -ceq '2026-08-14T08:02:31.2903580Z'",
    "$ls=@();foreach ($n in @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter \"LocalPort=8443 and State=2\")){$ls+=,@($n.LocalAddress,[int]$n.LocalPort,[int]$n.OwningProcess)};$lx=$ls.Count -eq 1 -and $ls[0][0] -ceq '0.0.0.0' -and $ls[0][1] -eq 8443 -and $ls[0][2] -eq 13644",
    "$o=[ordered]@{s='r21';id=$id;n=2;t='snapshot';z='observed';p=[ordered]@{window_start=$ws.ToString('o');window_end=$we.ToString('o');cim_snapshot_count=1;current_pid=[int]$PID;diagnostic_root_pid=$root;diagnostic_tree=$diag;candidates=$cand;protected_worker=$wr;protected_worker_exact=$wx;listeners=$ls;listener_exact=$lx;stdin_length=0}};[Console]::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 8));[Console]::Out.Flush()",
    "$e=[ordered]@{s='r21';id=$id;n=3;t='complete';z='complete';p=[ordered]@{retry_permitted=$false;process_mutation_performed=$false;file_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false;cleanup_performed=$false;remote_file_write_performed=$false;stdin_length=0}};[Console]::Out.WriteLine(($e|ConvertTo-Json -Compress -Depth 4));[Console]::Out.Flush()",
  ].join(";");
}

export function buildResidueInventoryCommand(rawConfig: unknown): string {
  const script = buildResidueInventoryScript(rawConfig);
  const compressed = gzipSync(Buffer.from(script, "utf8"), { level: 9 });
  const loader = "$ErrorActionPreference='Stop';$z=[Convert]::FromBase64String('"
    + compressed.toString("base64")
    + "');$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);&([ScriptBlock]::Create([IO.StreamReader]::new($g,[Text.UTF8Encoding]::new($false,$true)).ReadToEnd()))";
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(loader, "utf16le").toString("base64");
  if (command.length > COMMAND_LIMIT || /ReadToEnd|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado(?:\.exe|\s+-mode)|program_hw/iu.test(script)
    || loader.includes(",0")
    || (loader.match(/\[IO\.Compression\.CompressionMode\]::Decompress/gu)?.length ?? 0) !== 1) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_SCRIPT_INVALID", "config");
  }
  return command;
}

function readExpected(dependencies: ResidueInventoryDependencies, path: string, expected: string): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch { fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_INPUT_MISSING", "local_preflight"); }
  if (sha256(bytes) !== expected) fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_INPUT_DRIFT", "local_preflight");
  return bytes;
}

function loadContext(rawConfig: unknown, dependencies: ResidueInventoryDependencies) {
  const config = validateResidueInventoryConfig(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_source_sha256);
  readExpected(dependencies, TRANSPORT_SOURCE_PATH, TRANSPORT_SOURCE_SHA256);
  const transportBytes = readExpected(dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256);
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(transportBytes.toString("utf8")));
  if (transport.target.host !== TARGET_HOST || transport.target.expected_effective_config_sha256 !== EFFECTIVE_SHA256) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_TRANSPORT_INVALID", "local_preflight");
  }
  const names = Object.keys(ATTEMPT2_EVIDENCE_MANIFEST).sort();
  if (canonicalJsonResidueInventory(dependencies.entries(ATTEMPT2_EVIDENCE_DIRECTORY))
    !== canonicalJsonResidueInventory(names)) fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_EVIDENCE_SET_INVALID", "local_preflight");
  if (sha256(canonicalJsonResidueInventory(ATTEMPT2_EVIDENCE_MANIFEST) + "\n")
    !== ATTEMPT2_EVIDENCE_MANIFEST_SHA256) fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_MANIFEST_INVALID", "local_preflight");
  for (const name of names) readExpected(
    dependencies,
    ATTEMPT2_EVIDENCE_DIRECTORY + "/" + name,
    ATTEMPT2_EVIDENCE_MANIFEST[name as keyof typeof ATTEMPT2_EVIDENCE_MANIFEST],
  );
  readExpected(dependencies, ATTEMPT2_ADJUDICATION_PATH, ATTEMPT2_ADJUDICATION_SHA256);
  readExpected(dependencies, ATTEMPT2_REVIEW_PATH, ATTEMPT2_REVIEW_SHA256);
  const command = buildResidueInventoryCommand(config);
  return { config, transport, command, script: buildResidueInventoryScript(config) };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-plan.v1",
    inventory_id: context.config.inventory_id,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    window_start_utc: RESIDUE_INVENTORY_WINDOW_START,
    window_end_utc: RESIDUE_INVENTORY_WINDOW_END,
    command_length: context.command.length,
    command_sha256: sha256(Buffer.from(context.command, "ascii")),
    script_sha256: sha256(context.script),
    effective_audit_count: 1,
    remote_attempt_count: 1,
    stdin_length: 0,
    retry_permitted: false,
    process_mutation_permitted: false,
    file_mutation_permitted: false,
    remote_file_write_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
    cleanup_permitted: false,
  };
}

export function planResidueInventory(
  rawConfig: unknown,
  dependencies: ResidueInventoryDependencies,
): Record<string, unknown> {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_ATTEMPT2_DIRECT_RESIDUE_INVENTORY_READ_ONLY",
    context.config.inventory_id,
    sha256(canonicalJsonResidueInventory(context.config) + "\n"),
    sha256(canonicalJsonResidueInventory(planFor(context)) + "\n"),
    context.config.expected_source_sha256,
    context.config.expected_test_source_sha256,
    ATTEMPT2_EVIDENCE_MANIFEST_SHA256,
    ATTEMPT2_FAILURE_SHA256,
    ATTEMPT2_REMOTE_PROCESS_SHA256,
    sha256(context.script),
    sha256(Buffer.from(context.command, "ascii")),
  ].join(":");
}

export function residueInventoryConfirmation(
  rawConfig: unknown,
  dependencies: ResidueInventoryDependencies,
): string {
  return confirmationFor(loadContext(rawConfig, dependencies));
}

function processEvidence(raw: RawProcessResult) {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT",
    stdin_length: 0,
    stdin_sha256: EMPTY_SHA256,
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function validRow(value: unknown): boolean {
  return Array.isArray(value) && value.length === 10
    && Number.isSafeInteger(value[0]) && Number(value[0]) > 0
    && Number.isSafeInteger(value[1]) && Number(value[1]) >= 0
    && typeof value[2] === "string" && value[2] === value[2].toLowerCase()
    && (value[3] === null || typeof value[3] === "string")
    && Number.isSafeInteger(value[4]) && Number(value[4]) >= 0
    && typeof value[5] === "boolean"
    && (value[6] === null || Number.isSafeInteger(value[6]))
    && (value[7] === null || typeof value[7] === "string" && HASH.test(value[7]))
    && (value[8] === null || Number.isSafeInteger(value[8]))
    && typeof value[9] === "boolean";
}

export function validateResidueInventoryOutput(
  stdout: Buffer,
  config: ResidueInventoryConfig,
): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(stdout); } catch {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 3) fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
  let values: Record<string, unknown>[];
  try { values = lines.map((line) => JSON.parse(line) as Record<string, unknown>); } catch {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value.s !== "r21" || value.id !== config.inventory_id || value.n !== index + 1) {
      fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
    }
  }
  if (!exactKeys(values[0]!, ["id", "n", "s", "t", "z"])
    || values[0]!.t !== "start" || values[0]!.z !== "observed") {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
  }
  const snapshot = values[1]!;
  const payload = object(snapshot.p);
  const payloadKeys = [
    "candidates", "cim_snapshot_count", "current_pid", "diagnostic_root_pid",
    "diagnostic_tree", "listener_exact", "listeners", "protected_worker",
    "protected_worker_exact", "stdin_length", "window_end", "window_start",
  ];
  if (!exactKeys(snapshot, ["id", "n", "p", "s", "t", "z"])
    || snapshot.t !== "snapshot" || snapshot.z !== "observed" || !payload
    || !exactKeys(payload, payloadKeys) || payload.cim_snapshot_count !== 1
    || payload.stdin_length !== 0 || !Number.isSafeInteger(payload.current_pid)
    || !Number.isSafeInteger(payload.diagnostic_root_pid)
    || !Array.isArray(payload.diagnostic_tree) || !payload.diagnostic_tree.every(validRow)
    || !Array.isArray(payload.candidates) || !payload.candidates.every(validRow)
    || !Array.isArray(payload.listeners) || typeof payload.listener_exact !== "boolean"
    || typeof payload.protected_worker_exact !== "boolean"
    || payload.protected_worker !== null && !validRow(payload.protected_worker)
    || payload.diagnostic_tree.some((row) => (row as unknown[])[9] !== true)
    || payload.candidates.some((row) => (row as unknown[])[9] !== false)
    || payload.candidates.some((row) => (payload.diagnostic_tree as unknown[]).some(
      (diag) => (diag as unknown[])[0] === (row as unknown[])[0],
    ))) fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
  const complete = values[2]!;
  const completion = object(complete.p);
  if (!exactKeys(complete, ["id", "n", "p", "s", "t", "z"])
    || complete.t !== "complete" || complete.z !== "complete" || !completion
    || Object.values(completion).some((value, index) => index === 7 ? value !== 0 : value !== false)) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_OUTPUT_INVALID", "output");
  }
  return {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-result.v1",
    status: "observed",
    inventory_id: config.inventory_id,
    snapshot: payload,
    candidate_count: payload.candidates.length,
    diagnostic_tree_count: payload.diagnostic_tree.length,
    protected_worker_exact: payload.protected_worker_exact,
    listener_exact: payload.listener_exact,
    retry_permitted: false,
    cleanup_performed: false,
  };
}

function write(
  dependencies: ResidueInventoryDependencies,
  directory: string,
  name: string,
  value: string | Buffer,
): void {
  try { dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value)); } catch {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeResidueInventory(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: ResidueInventoryDependencies,
): Record<string, unknown> {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_CONFIRMATION_REQUIRED", "local_preflight");
  if (evidenceDirectory !== context.config.evidence_directory || resolve(evidenceDirectory) !== evidenceDirectory) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_EVIDENCE_PATH_INVALID", "local_preflight");
  }
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(evidenceDirectory); } catch {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  const plan = planFor(context);
  write(dependencies, evidenceDirectory, "inventory-config.canonical.json",
    canonicalJsonResidueInventory(context.config) + "\n");
  write(dependencies, evidenceDirectory, "plan.canonical.json", canonicalJsonResidueInventory(plan) + "\n");
  write(dependencies, evidenceDirectory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, evidenceDirectory, "remote-script.ps1", context.script);
  write(dependencies, evidenceDirectory, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
  const effective = dependencies.spawn(
    SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, evidenceDirectory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, evidenceDirectory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, evidenceDirectory, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_SHA256) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const before = loadContext(context.config, dependencies);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (confirmationFor(before) !== confirmation
    || canonicalJsonResidueInventory(initial) !== canonicalJsonResidueInventory(pre)) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_INPUT_DRIFT", "local_preflight");
  }
  write(dependencies, evidenceDirectory, "transport-inputs-pre-remote.json", JSON.stringify(pre, null, 2) + "\n");
  const remote = dependencies.spawn(
    SSH_PATH,
    [...buildDirectSshOptions(context.transport), TARGET_HOST, context.command],
    Buffer.alloc(0),
    REMOTE_TIMEOUT_MS,
  );
  write(dependencies, evidenceDirectory, "stdout.raw", remote.stdout);
  write(dependencies, evidenceDirectory, "stderr.raw", remote.stderr);
  write(dependencies, evidenceDirectory, "remote-process.json", JSON.stringify(processEvidence(remote), null, 2) + "\n");
  const after = loadContext(context.config, dependencies);
  const post = dependencies.transportInputs(context.transport, "network");
  write(dependencies, evidenceDirectory, "transport-inputs-post-remote.json", JSON.stringify(post, null, 2) + "\n");
  if (confirmationFor(after) !== confirmation
    || canonicalJsonResidueInventory(initial) !== canonicalJsonResidueInventory(post)) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null || remote.stderr.length !== 0) {
    fail("M4F_ATTEMPT2_RESIDUE_INVENTORY_REMOTE_FAILED", "network");
  }
  const result = validateResidueInventoryOutput(remote.stdout, context.config);
  const record = {
    ...result,
    recorded_at_utc: dependencies.now().toISOString(),
    config_sha256: sha256(canonicalJsonResidueInventory(context.config) + "\n"),
    plan_sha256: sha256(canonicalJsonResidueInventory(plan) + "\n"),
    confirmation_sha256: sha256(confirmation),
    process: processEvidence(remote),
    stdin_length: 0,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
  write(dependencies, evidenceDirectory, "inventory-record.json", JSON.stringify(record, null, 2) + "\n");
  return record;
}

const systemDependencies: ResidueInventoryDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
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
  read: (path) => readFileSync(path),
  entries: (path) => readdirSync(path).sort(),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  createEvidence(path) { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); },
  writeEvidence(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    chmodSync(path, 0o600);
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const raw = JSON.parse(readFileSync(args[2]!, "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      const plan = planResidueInventory(raw, systemDependencies);
      process.stdout.write(JSON.stringify({
        ...plan,
        config_sha256: sha256(canonicalJsonResidueInventory(raw) + "\n"),
        plan_sha256: sha256(canonicalJsonResidueInventory(plan) + "\n"),
        confirmation: residueInventoryConfirmation(raw, systemDependencies),
      }) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      process.stdout.write(JSON.stringify(executeResidueInventory(
        raw, args[4]!, args[6]!, systemDependencies,
      )) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof ResidueInventoryFailure ? error.detail : {
      schema: "synthia-m4f-direct-attempt2-residue-inventory-failure.v1",
      code: error instanceof Error ? error.message : "M4F_ATTEMPT2_RESIDUE_INVENTORY_UNEXPECTED",
      retry_permitted: false,
      stdin_length: 0,
      cleanup_performed: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
