import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  validateCandidate19ScriptConfig,
} from "./m4f-direct-six-process-cleanup-19.ts";
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
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const EFFECTIVE_CONFIG_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";
const ORIGINAL_SIX_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-cleanup-prod-20260829-19.json";
const ORIGINAL_SIX_CONFIG_SHA256 = "be33526bfd69ed606a117af32538f2f18c6fe146f9551588d22e6b3191685b76";
export const CANDIDATE17_EVIDENCE_DIRECTORY =
  "/private/tmp/synthia-m4f-direct-residue-ownership-prod-20260829-17-evidence";
export const CANDIDATE17_MANIFEST_SHA256 =
  "21adbd5ac7f9d006f157bf931a9698bfb0f3daf4a40050731de4fa16558b7747";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = /^[0-9a-f]{64}$/u;
const COMMAND_LIMIT = 7_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;
const POWERSHELL_SHA256 = "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc";
const CMD_SHA256 = "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e";
const CONHOST_SHA256 = "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51";
const WORKER_COMMAND_SHA256 = "e5d000e033425243c23868bbede8cbd67d09872e5379c05cf6b8371ef175998f";
export const CANDIDATE31_TARGET_LENGTH = 10_522;
export const CANDIDATE31_TARGET_SHA256 = "76cdb5a5f5e33b82910185a41248da6d4d9804282e087167ec6c9a9e1274e401";
export const CANDIDATE31_GZIP_LENGTH = 3_200;
export const CANDIDATE31_GZIP_SHA256 = "fb2ba0755eac907cc458d5917974f229bc0193ebf3f4b4eb063dc8f5d497e601";
export const CANDIDATE31_HELPER_SHA256 = [
  "a2fb932c2a83735a5b9c2a529e447993f10894cb48aa4b5fcc70f3b7360e302d",
  "2800974305f221c42eecb0d5b0d911cc9e6c53b6d6e13c633d266746939739ec",
  "1339f61c7445ce8fe696087021be49be2a448f5ac1cf65cadf9b7abc5a27851b",
] as const;
export const CANDIDATE31_HELPERS_COMBINED_SHA256 =
  "af038b4c88e0cba905115d5b6a5042af291a87d9951f792ece8a5b8231ec2e64";
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;

export const CANDIDATE31_ID = "m4f-direct-attempt2-residue-nine-pid-preflight-prod-20260830-31";
export const CANDIDATE31_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-nine-pid-preflight-prod-20260830-31-evidence";
export const CANDIDATE30_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-30-evidence";
export const CANDIDATE30_MANIFEST_SHA256 =
  "ae3ded49c82fc0f4b7ee8505ef5579665c2f8f58eef0db561e74040a20018bfb";
export const CANDIDATE30_RECORD_SHA256 =
  "b710170dc5b2f448aea0731c5933762ffe13f01290d372b99c08d8e2609d0f81";
export const CANDIDATE30_MANIFEST = {
  "confirmation.sha256": "f091657a1d8a4e95184fdd802cc71383c726b89642c4725817d0af625bb07abb",
  "inventory-config.canonical.json": "55c1062dab0e556a4b64f20b6f241f7f0517a9dd5c130d77838affd30cdacc9b",
  "inventory-record.json": CANDIDATE30_RECORD_SHA256,
  "plan.canonical.json": "9abfa9a216b666e2f77b437adc02fcc8b4961371c9c01eb16c556dbfef8e5165",
  "remote-process.json": "a8b22c244f8a5c140e288a8b74a1857a4b878b5c8321e9842cc430c425165489",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_CONFIG_SHA256,
  "stderr.raw": EMPTY_SHA256,
  "stdout.raw": "3ef5c8f203868aa791347d7d0e74be628471b80e282baf97c1e17ff41a096528",
  "target-inventory-script.ps1": "31b4c637ce9d1ddbfe3b7438a967b2ef50353fcfeb46ea3f9f2eea3a58f543e2",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;
export const CANDIDATE17_MANIFEST = {
  "admission-config.raw.json": "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5",
  "confirmation.sha256": "53b0926f8aeeaf0b8469e5a7226f2bc0c2cbe6b0754bf594d1d74dc3fadd5e7b",
  "diagnostic-config.canonical.json": "b8c44874644aa34918d538b5cc4dff56f342cd2db293e034a3baa5ce158fc3ad",
  "markers.json": "e07606c030ce6a947fc6589b7e45614cfa9d100588e35e13b7dd942c2dcfc97f",
  "observation.json": "bfb868f5894f5cc76a359876a15ce69fa8aa9925de314e4138f59d20751412b7",
  "plan.canonical.json": "97e4999f2aef46a591b7d1e25d078493adfb32e0cef91d42cb7ddb009d48029d",
  "remote-command.json": "decde722c5e8d3868ca8db3ffd7c7939849d7f831877beed45be849dccbf7acf",
  "remote-process.json": "690a82707e5bc439c1a0ceb45fc9756ad3bc1f92d6784cd2ec1bd0eb9100f6f8",
  "remote-script.ps1": "bc251afa48e8850bdeedd4849603980df65b1de1756d4accf89ec11cdd5c6b57",
  "remote-stderr.raw": "52958a8c061c159decb31dd53806e87dfd41443c208ce951f236d40e05185588",
  "remote-stdout.raw": "1e8fca53ae9271300ca86190f8ca97a3df6258c3dd64a17b942598ace819f3c5",
  "result.json": "8b22d1fe0c1f366475d9a9230c5024fafbb48e858cffe338eaf4d368957dcd50",
  "ssh-effective-process.json": "2d34fe118bf672d91fd797101435aba4edf7c5dea2238babe17253c4c5747159",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_CONFIG_SHA256,
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post_remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre_remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-nine-pid-preflight-31.test.ts", import.meta.url));
const SIX_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-cleanup-19.ts", import.meta.url));
const SIX_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-cleanup-19.test.ts", import.meta.url));

export interface Candidate31Target {
  ordinal: number;
  lineage: "candidate09" | "candidate10" | "attempt2";
  role: "powershell" | "cmd" | "conhost";
  pid: number;
  parent_pid: number;
  name: "powershell.exe" | "cmd.exe" | "conhost.exe";
  creation_utc: string;
  session_id: 0;
  command_length: number | null;
  command_sha256: string;
}

export const CANDIDATE31_TARGETS: readonly Candidate31Target[] = [
  { ordinal: 1, lineage: "candidate09", role: "powershell", pid: 44768, parent_pid: 56576,
    name: "powershell.exe", creation_utc: "2026-08-28T16:25:51.0137880Z", session_id: 0,
    command_length: null, command_sha256: POWERSHELL_SHA256 },
  { ordinal: 2, lineage: "candidate09", role: "cmd", pid: 56576, parent_pid: 6100,
    name: "cmd.exe", creation_utc: "2026-08-28T16:25:50.9870650Z", session_id: 0,
    command_length: null, command_sha256: CMD_SHA256 },
  { ordinal: 3, lineage: "candidate09", role: "conhost", pid: 64484, parent_pid: 56576,
    name: "conhost.exe", creation_utc: "2026-08-28T16:25:50.9908920Z", session_id: 0,
    command_length: null, command_sha256: CONHOST_SHA256 },
  { ordinal: 4, lineage: "candidate10", role: "powershell", pid: 58908, parent_pid: 67048,
    name: "powershell.exe", creation_utc: "2026-08-28T17:12:52.5233860Z", session_id: 0,
    command_length: null, command_sha256: POWERSHELL_SHA256 },
  { ordinal: 5, lineage: "candidate10", role: "cmd", pid: 67048, parent_pid: 24260,
    name: "cmd.exe", creation_utc: "2026-08-28T17:12:52.4952390Z", session_id: 0,
    command_length: null, command_sha256: CMD_SHA256 },
  { ordinal: 6, lineage: "candidate10", role: "conhost", pid: 66316, parent_pid: 67048,
    name: "conhost.exe", creation_utc: "2026-08-28T17:12:52.5009290Z", session_id: 0,
    command_length: null, command_sha256: CONHOST_SHA256 },
  { ordinal: 7, lineage: "attempt2", role: "powershell", pid: 39016, parent_pid: 48664,
    name: "powershell.exe", creation_utc: "2026-08-30T14:10:50.2348230Z", session_id: 0,
    command_length: 6839,
    command_sha256: "bdb85e6efc55c06db037273b95bad470bad22c42dbdae3b551595914a2fb1d3a" },
  { ordinal: 8, lineage: "attempt2", role: "cmd", pid: 48664, parent_pid: 62912,
    name: "cmd.exe", creation_utc: "2026-08-30T14:10:50.2066440Z", session_id: 0,
    command_length: 6873,
    command_sha256: "cbf2ee2b15ffc9fcc16611caec46e45565d5169ccb3a100f596e8f11da5b0651" },
  { ordinal: 9, lineage: "attempt2", role: "conhost", pid: 66340, parent_pid: 48664,
    name: "conhost.exe", creation_utc: "2026-08-30T14:10:50.2104140Z", session_id: 0,
    command_length: 39, command_sha256: CONHOST_SHA256 },
] as const;

export interface Candidate31Config {
  schema: "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-config.v1";
  preflight_id: typeof CANDIDATE31_ID;
  evidence_directory: typeof CANDIDATE31_EVIDENCE_DIRECTORY;
  candidate30_evidence_directory: typeof CANDIDATE30_EVIDENCE_DIRECTORY;
  candidate30_evidence_manifest_sha256: typeof CANDIDATE30_MANIFEST_SHA256;
  candidate30_record_sha256: typeof CANDIDATE30_RECORD_SHA256;
  candidate17_evidence_directory: typeof CANDIDATE17_EVIDENCE_DIRECTORY;
  candidate17_evidence_manifest_sha256: typeof CANDIDATE17_MANIFEST_SHA256;
  original_six_config_path: typeof ORIGINAL_SIX_CONFIG_PATH;
  original_six_config_sha256: typeof ORIGINAL_SIX_CONFIG_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_six_source_sha256: string;
  expected_six_test_sha256: string;
}

export interface Candidate31Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate31Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE31_FAILED"));
  }
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
  const notStarted = stage === "config" || stage === "local_preflight" || stage === "evidence";
  throw new Candidate31Failure({
    schema: "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-failure.v1",
    code,
    stage,
    retry_permitted: false,
    target_body_invoked: notStarted ? false : "unknown",
    cim_executed: notStarted ? false : "unknown",
    cleanup_performed: false,
    process_mutation_performed: false,
    remote_file_write_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    ...extra,
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validateCandidate31Config(value: unknown): Candidate31Config {
  const config = object(value);
  const keys = [
    "candidate17_evidence_directory", "candidate17_evidence_manifest_sha256",
    "candidate30_evidence_directory", "candidate30_evidence_manifest_sha256",
    "candidate30_record_sha256", "evidence_directory",
    "expected_six_source_sha256", "expected_six_test_sha256",
    "expected_source_sha256", "expected_test_sha256", "original_six_config_path",
    "original_six_config_sha256", "preflight_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-config.v1"
    || config.preflight_id !== CANDIDATE31_ID
    || config.evidence_directory !== CANDIDATE31_EVIDENCE_DIRECTORY
    || config.candidate30_evidence_directory !== CANDIDATE30_EVIDENCE_DIRECTORY
    || config.candidate30_evidence_manifest_sha256 !== CANDIDATE30_MANIFEST_SHA256
    || config.candidate30_record_sha256 !== CANDIDATE30_RECORD_SHA256
    || config.candidate17_evidence_directory !== CANDIDATE17_EVIDENCE_DIRECTORY
    || config.candidate17_evidence_manifest_sha256 !== CANDIDATE17_MANIFEST_SHA256
    || config.original_six_config_path !== ORIGINAL_SIX_CONFIG_PATH
    || config.original_six_config_sha256 !== ORIGINAL_SIX_CONFIG_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_six_source_sha256, config.expected_six_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE31_CONFIG_INVALID", "config");
  }
  return value as Candidate31Config;
}

function readExpected(
  dependencies: Candidate31Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE31_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("M4F_CANDIDATE31_INPUT_DRIFT", "local_preflight", { path });
  }
  return bytes;
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export const CANDIDATE31_HELPERS = [
  "function Get-SynthiaM4f31Sha256($Value){if ($null -eq $Value){return $null};$Bytes=[Text.Encoding]::UTF8.GetBytes([string]$Value);$Hasher=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$Hasher.Dispose()}}",
  "function ConvertTo-SynthiaM4f31ProcessRow($Process){$Command=$Process.CommandLine;$Executable=if ($null -eq $Process.ExecutablePath){$null}else{[string]$Process.ExecutablePath};$Created=if ($Process.CreationDate){$Process.CreationDate.ToUniversalTime().ToString('o')}else{$null};,@([int]$Process.ProcessId,[int]$Process.ParentProcessId,$Process.Name.ToLowerInvariant(),$Created,[int]$Process.SessionId,$Executable,($null -ne $Command),$(if ($null -ne $Command){([string]$Command).Length}else{$null}),$(Get-SynthiaM4f31Sha256 $Command))}",
  "function Get-SynthiaM4f31AncestorChain($Process,$ProcessMap){$Rows=@();$Seen=New-Object 'Collections.Generic.HashSet[int]';[void]$Seen.Add([int]$Process.ProcessId);$Current=$Process;while ($true){$ParentPid=[int]$Current.ParentProcessId;if ($ParentPid -eq 0){return [ordered]@{r=$Rows;t='zero';p=0}};if (-not $Seen.Add($ParentPid)){return [ordered]@{r=$Rows;t='cycle';p=$ParentPid}};$Parent=$ProcessMap[$ParentPid];if ($null -eq $Parent){return [ordered]@{r=$Rows;t='missing_parent';p=$ParentPid}};$ParentRow=ConvertTo-SynthiaM4f31ProcessRow $Parent;$Rows+=,$ParentRow;if ($Parent.CreationDate -gt $Current.CreationDate){return [ordered]@{r=$Rows;t='invalid_edge';p=$ParentPid}};$Current=$Parent}}",
] as const;

export function buildCandidate31Script(): string {
  const targets = CANDIDATE31_TARGETS.map((target) => ({
    o: target.ordinal,
    l: target.lineage,
    r: target.role,
    p: target.pid,
    q: target.parent_pid,
    n: target.name,
    c: target.creation_utc,
    s: target.session_id,
    z: target.command_length,
    h: target.command_sha256,
  }));
  const start = JSON.stringify({ s: "r31", id: CANDIDATE31_ID, n: 1, t: "start", z: "observed" });
  return [
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine("
      + psLiteral(start) + ");[Console]::Out.Flush()",
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$id=" + psLiteral(CANDIDATE31_ID),
    ...CANDIDATE31_HELPERS,
    "$Processes=@(Get-CimInstance Win32_Process);$ProcessMap=@{};foreach ($Process in $Processes){$ProcessPid=[int]$Process.ProcessId;if ($ProcessMap.ContainsKey($ProcessPid)){throw 'DUPLICATE_PID'};$ProcessMap[$ProcessPid]=$Process}",
    "$CurrentProcess=$ProcessMap[[int]$PID];if ($null -eq $CurrentProcess){throw 'CURRENT_MISSING'};$CurrentRow=ConvertTo-SynthiaM4f31ProcessRow $CurrentProcess;$CurrentChain=Get-SynthiaM4f31AncestorChain $CurrentProcess $ProcessMap;$DiagnosticRoot=$null;foreach ($Row in @(,$CurrentRow)+@($CurrentChain.r)){if ($Row[2] -ceq 'sshd.exe'){$DiagnosticRoot=[int]$Row[0];break}};if ($null -eq $DiagnosticRoot){throw 'DIAG_ROOT'}",
    "$DiagnosticSet=New-Object 'Collections.Generic.HashSet[int]';[void]$DiagnosticSet.Add($DiagnosticRoot);$DiagnosticValid=$true;do{$Changed=$false;foreach ($Process in $Processes){$ProcessPid=[int]$Process.ProcessId;$Parent=$ProcessMap[[int]$Process.ParentProcessId];if ($DiagnosticSet.Contains([int]$Process.ParentProcessId) -and -not $DiagnosticSet.Contains($ProcessPid)){if ($null -eq $Parent -or $Parent.CreationDate -gt $Process.CreationDate){$DiagnosticValid=$false}else{[void]$DiagnosticSet.Add($ProcessPid);$Changed=$true}}}}while ($Changed);$DiagnosticTree=@();foreach ($ProcessPid in @($DiagnosticSet|Sort-Object)){$DiagnosticTree+=,(ConvertTo-SynthiaM4f31ProcessRow $ProcessMap[$ProcessPid])}",
    "$Worker=$ProcessMap[13644];$WorkerRow=if ($null -eq $Worker){$null}else{ConvertTo-SynthiaM4f31ProcessRow $Worker};$WorkerExact=$null -ne $WorkerRow -and $WorkerRow[1] -eq 2712 -and $WorkerRow[2] -ceq 'node.exe' -and $WorkerRow[3] -ceq '2026-08-14T08:02:31.2903580Z' -and $WorkerRow[4] -eq 0 -and $WorkerRow[5] -ceq 'D:\\softwares\\Nodejs\\node.exe' -and $WorkerRow[6] -eq $true -and $WorkerRow[7] -eq 66 -and $WorkerRow[8] -ceq '" + WORKER_COMMAND_SHA256 + "';$WorkerChain=if ($null -eq $Worker){[ordered]@{r=@();t='missing_parent';p=13644}}else{Get-SynthiaM4f31AncestorChain $Worker $ProcessMap}",
    "$WorkerAncestorSet=New-Object 'Collections.Generic.HashSet[int]';foreach ($Row in $WorkerChain.r){[void]$WorkerAncestorSet.Add([int]$Row[0])};$WorkerDescendantSet=New-Object 'Collections.Generic.HashSet[int]';$WorkerDescendantsValid=$null -ne $Worker;if ($WorkerDescendantsValid){[void]$WorkerDescendantSet.Add(13644);do{$Changed=$false;foreach ($Process in $Processes){$ProcessPid=[int]$Process.ProcessId;$Parent=$ProcessMap[[int]$Process.ParentProcessId];if ($WorkerDescendantSet.Contains([int]$Process.ParentProcessId) -and -not $WorkerDescendantSet.Contains($ProcessPid)){if ($null -eq $Parent -or $Parent.CreationDate -gt $Process.CreationDate){$WorkerDescendantsValid=$false}else{[void]$WorkerDescendantSet.Add($ProcessPid);$Changed=$true}}}}while ($Changed)};$WorkerDescendants=@();foreach ($ProcessPid in @($WorkerDescendantSet|Sort-Object)){$WorkerDescendants+=,(ConvertTo-SynthiaM4f31ProcessRow $ProcessMap[$ProcessPid])}",
    "$CurrentSet=New-Object 'Collections.Generic.HashSet[int]';[void]$CurrentSet.Add([int]$PID);foreach ($Row in $CurrentChain.r){[void]$CurrentSet.Add([int]$Row[0])};$Targets=ConvertFrom-Json " + psLiteral(JSON.stringify(targets)) + ";$ObservedTargets=@();$EffectivePresentSet=@();$TargetsValid=$true;foreach ($Target in $Targets){$Process=$ProcessMap[[int]$Target.p];if ($null -eq $Process){$ObservedTargets+=,@([int]$Target.o,[int]$Target.p,'absent',$null,@(),'absent',0,'not_observed');continue};$Row=ConvertTo-SynthiaM4f31ProcessRow $Process;$Chain=Get-SynthiaM4f31AncestorChain $Process $ProcessMap;$ExecutableExact=$null -ne $Row[5] -and [IO.Path]::GetFileName([string]$Row[5]).ToLowerInvariant() -ceq [string]$Target.n;$LengthExact=$null -eq $Target.z -or $Row[7] -eq [int]$Target.z;$ChainUsable=$Chain.t -ceq 'zero' -or $Chain.t -ceq 'missing_parent';$ChainPids=@($Chain.r|ForEach-Object{[int]$_[0]});$RelationshipExact=-not $DiagnosticSet.Contains([int]$Target.p) -and -not $CurrentSet.Contains([int]$Target.p) -and -not $WorkerAncestorSet.Contains([int]$Target.p) -and -not $WorkerDescendantSet.Contains([int]$Target.p) -and -not ($ChainPids -contains 13644) -and [int]$Target.p -ne $DiagnosticRoot -and -not ($ChainPids -contains $DiagnosticRoot);$TargetExact=$Row[1] -eq [int]$Target.q -and $Row[2] -ceq [string]$Target.n -and $Row[3] -ceq [string]$Target.c -and $Row[4] -eq [int]$Target.s -and $Row[6] -eq $true -and $LengthExact -and $Row[8] -ceq [string]$Target.h -and $ExecutableExact -and $RelationshipExact -and $ChainUsable;$TargetState=if ($TargetExact){'exact'}else{'mismatch'};if ($TargetExact){$EffectivePresentSet+=[int]$Target.p}else{$TargetsValid=$false};$ObservedTargets+=,@([int]$Target.o,[int]$Target.p,$TargetState,$Row,@($Chain.r),$Chain.t,[int]$Chain.p,'captured_this_observation')}",
    "$Connections=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter \"State=2\");$Listeners8443=@();$Listeners18443=@();foreach ($Connection in $Connections){$Listener=@([string]$Connection.LocalAddress,[int]$Connection.LocalPort,[int]$Connection.OwningProcess);if ($Listener[1] -eq 8443){$Listeners8443+=,$Listener}elseif ($Listener[1] -eq 18443){$Listeners18443+=,$Listener}};$Listener8443Exact=$Listeners8443.Count -eq 1 -and $Listeners8443[0][0] -ceq '0.0.0.0' -and $Listeners8443[0][2] -eq 13644;$Listener18443Absent=$Listeners18443.Count -eq 0;$PreflightExact=$TargetsValid -and $WorkerExact -and $CurrentChain.t -ceq 'zero' -and $DiagnosticValid -and $WorkerChain.t -ceq 'zero' -and $WorkerDescendantsValid -and $Listener8443Exact -and $Listener18443Absent;$Decision=if ($PreflightExact){'observed'}else{'observed_blocked'}",
    "$Snapshot=[ordered]@{s='r31';id=$id;n=2;t='snapshot';z=$Decision;p=[ordered]@{cim_snapshot_count=1;target_count=9;current_process=$CurrentRow;current_chain=@($CurrentChain.r);current_chain_terminal=$CurrentChain.t;current_chain_terminal_pid=[int]$CurrentChain.p;targets=$ObservedTargets;effective_present_set=$EffectivePresentSet;diagnostic_root_pid=$DiagnosticRoot;diagnostic_tree=$DiagnosticTree;diagnostic_tree_valid=$DiagnosticValid;protected_worker=$WorkerRow;protected_worker_exact=$WorkerExact;worker_ancestors=@($WorkerChain.r);worker_ancestor_terminal=$WorkerChain.t;worker_ancestor_terminal_pid=[int]$WorkerChain.p;worker_descendants=$WorkerDescendants;worker_descendants_valid=$WorkerDescendantsValid;listeners_8443=$Listeners8443;listeners_18443=$Listeners18443;stdin_length=0;decision=$Decision}};[Console]::Out.WriteLine(($Snapshot|ConvertTo-Json -Compress -Depth 16));[Console]::Out.Flush()",
    "$e=[ordered]@{s='r31';id=$id;n=3;t='complete';z='complete';p=[ordered]@{retry_permitted=$false;process_mutation_performed=$false;file_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false;cleanup_performed=$false;remote_file_write_performed=$false;stdin_length=0}};[Console]::Out.WriteLine(($e|ConvertTo-Json -Compress -Depth 4));[Console]::Out.Flush()",
  ].join(";");
}

export function buildCandidate31Payload() {
  const targetScript = buildCandidate31Script();
  const targetBytes = Buffer.from(targetScript, "utf8");
  const targetHash = sha256(targetBytes);
  const compressed = gzipSync(targetBytes, { level: 9 });
  const loader = "$ErrorActionPreference='Stop';$z=[Convert]::FromBase64String('"
    + compressed.toString("base64")
    + "');$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);&([ScriptBlock]::Create([IO.StreamReader]::new($g,[Text.UTF8Encoding]::new($false,$true)).ReadToEnd()))";
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \""
    + loader + "\"";
  const forbidden = candidate31HasForbiddenMutation(targetScript);
  const helperHashes = CANDIDATE31_HELPERS.map((helper) => sha256(helper));
  if (command.length > COMMAND_LIMIT || forbidden || targetScript.match(/Get-CimInstance Win32_Process/gu)?.length !== 1
    || targetScript.match(/MSFT_NetTCPConnection/gu)?.length !== 1
    || targetBytes.length !== CANDIDATE31_TARGET_LENGTH || targetHash !== CANDIDATE31_TARGET_SHA256
    || compressed.length !== CANDIDATE31_GZIP_LENGTH || sha256(compressed) !== CANDIDATE31_GZIP_SHA256
    || canonicalJson(helperHashes) !== canonicalJson(CANDIDATE31_HELPER_SHA256)
    || sha256(CANDIDATE31_HELPERS.join(";")) !== CANDIDATE31_HELPERS_COMBINED_SHA256) {
    fail("M4F_CANDIDATE31_PAYLOAD_INVALID", "config", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      forbidden,
      target_script_sha256: targetHash,
      target_script_length: targetBytes.length,
    });
  }
  return {
    targetScript,
    targetHash,
    targetLength: targetBytes.length,
    compressedHash: sha256(compressed),
    compressedLength: compressed.length,
    loader,
    loaderHash: sha256(loader),
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

export function candidate31HasForbiddenMutation(script: string): boolean {
  return /(?:^|[;\s])Stop-Process(?:[\s;]|$)|\.Kill\s*\(|(?:^|[;\s])Set-Content(?:[\s;]|$)|(?:^|[;\s])Out-File(?:[\s;]|$)|(?:^|[;\s])Vivado(?:\.exe|\s|;|$)|(?:^|[;\s])program_hw(?:_devices)?(?:[\s;]|$)/iu
    .test(script);
}

type Candidate31ProcessRow = [number, number, string, string, number, string | null,
  boolean, number | null, string | null];

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function processRow(value: unknown): Candidate31ProcessRow | null {
  if (!Array.isArray(value) || value.length !== 9
    || !Number.isInteger(value[0]) || Number(value[0]) <= 0
    || !Number.isInteger(value[1]) || Number(value[1]) < 0
    || typeof value[2] !== "string" || value[2].length === 0 || value[2] !== value[2].toLowerCase()
    || typeof value[3] !== "string" || !UTC.test(value[3])
    || !Number.isInteger(value[4]) || Number(value[4]) < 0
    || !(value[5] === null || (typeof value[5] === "string" && value[5].length > 0))
    || typeof value[6] !== "boolean") return null;
  if (value[6] === true) {
    if (!Number.isInteger(value[7]) || Number(value[7]) < 0
      || typeof value[8] !== "string" || !HASH.test(value[8])) return null;
  } else if (value[7] !== null || value[8] !== null) return null;
  return value as Candidate31ProcessRow;
}

function rows(value: unknown): Candidate31ProcessRow[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(processRow);
  return parsed.every((row) => row !== null) ? parsed as Candidate31ProcessRow[] : null;
}

function chainIsInternallyValid(
  start: Candidate31ProcessRow,
  chain: Candidate31ProcessRow[],
  terminal: unknown,
  terminalPid: unknown,
): boolean {
  if (!Number.isInteger(terminalPid) || !["zero", "missing_parent", "cycle", "invalid_edge"].includes(String(terminal))) {
    return false;
  }
  const seen = new Set<number>([start[0]]);
  let child = start;
  for (let index = 0; index < chain.length; index += 1) {
    const parent = chain[index]!;
    if (parent[0] !== child[1] || seen.has(parent[0])) return false;
    seen.add(parent[0]);
    const invalidEdge = parent[3] > child[3];
    if (invalidEdge !== (terminal === "invalid_edge" && index === chain.length - 1)) return false;
    child = parent;
  }
  if (terminal === "zero") return terminalPid === 0 && child[1] === 0;
  if (terminal === "missing_parent") return terminalPid === child[1] && child[1] > 0;
  if (terminal === "cycle") return terminalPid === child[1] && seen.has(Number(terminalPid));
  return terminal === "invalid_edge" && chain.length > 0 && terminalPid === chain.at(-1)![0];
}

function descendantsAreValid(rootPid: number, value: Candidate31ProcessRow[]): boolean {
  const map = new Map(value.map((row) => [row[0], row]));
  if (!map.has(rootPid) || map.size !== value.length) return false;
  for (const row of value) {
    if (row[0] === rootPid) continue;
    const seen = new Set<number>([row[0]]);
    let current = row;
    while (current[0] !== rootPid) {
      const parent = map.get(current[1]);
      if (!parent || seen.has(parent[0]) || parent[3] > current[3]) return false;
      seen.add(parent[0]);
      current = parent;
    }
  }
  return true;
}

function expectedTargetIdentity(row: Candidate31ProcessRow, target: Candidate31Target): boolean {
  const executableName = typeof row[5] === "string" ? row[5].split(/[\\/]/u).at(-1)?.toLowerCase() : null;
  return row[0] === target.pid && row[1] === target.parent_pid && row[2] === target.name
    && row[3] === target.creation_utc && row[4] === target.session_id && row[6] === true
    && (target.command_length === null ? Number.isInteger(row[7]) && Number(row[7]) >= 0 : row[7] === target.command_length)
    && row[8] === target.command_sha256 && executableName === target.name;
}

function listeners(value: unknown, port: number): [string, number, number][] | null {
  if (!Array.isArray(value)) return null;
  const result: [string, number, number][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== "string"
      || item[1] !== port || !Number.isInteger(item[2]) || Number(item[2]) <= 0) return null;
    result.push(item as [string, number, number]);
  }
  return result;
}

export function validateCandidate31Output(stdout: Buffer): Record<string, unknown> {
  const text = stdout.toString("utf8");
  if (!/\r?\n$/u.test(text)) throw new Error("candidate31 output framing");
  const lines = text.replace(/\r?\n$/u, "").split(/\r?\n/u);
  if (lines.length !== 3 || lines.some((line) => line.length === 0)) throw new Error("candidate31 output count");
  const values = lines.map((line) => JSON.parse(line) as unknown);
  const start = object(values[0]);
  const snapshot = object(values[1]);
  const complete = object(values[2]);
  if (!start || !exactKeys(start, ["id", "n", "s", "t", "z"])
    || start.s !== "r31" || start.id !== CANDIDATE31_ID || start.n !== 1
    || start.t !== "start" || start.z !== "observed") throw new Error("candidate31 start");
  if (!snapshot || !exactKeys(snapshot, ["id", "n", "p", "s", "t", "z"])
    || snapshot.s !== "r31" || snapshot.id !== CANDIDATE31_ID || snapshot.n !== 2
    || snapshot.t !== "snapshot" || !["observed", "observed_blocked"].includes(String(snapshot.z))) {
    throw new Error("candidate31 snapshot");
  }
  const payload = object(snapshot.p);
  const payloadKeys = [
    "cim_snapshot_count", "current_chain", "current_chain_terminal", "current_chain_terminal_pid",
    "current_process", "decision", "diagnostic_root_pid", "diagnostic_tree", "diagnostic_tree_valid",
    "effective_present_set", "listeners_18443", "listeners_8443", "protected_worker",
    "protected_worker_exact", "stdin_length", "target_count", "targets", "worker_ancestor_terminal",
    "worker_ancestor_terminal_pid", "worker_ancestors", "worker_descendants", "worker_descendants_valid",
  ];
  if (!payload || !exactKeys(payload, payloadKeys) || payload.cim_snapshot_count !== 1
    || payload.target_count !== 9 || payload.stdin_length !== 0
    || payload.decision !== snapshot.z || typeof payload.diagnostic_tree_valid !== "boolean"
    || typeof payload.protected_worker_exact !== "boolean" || typeof payload.worker_descendants_valid !== "boolean") {
    throw new Error("candidate31 payload");
  }
  const current = processRow(payload.current_process);
  const currentChain = rows(payload.current_chain);
  const diagnosticTree = rows(payload.diagnostic_tree);
  const worker = processRow(payload.protected_worker);
  const workerAncestors = rows(payload.worker_ancestors);
  const workerDescendants = rows(payload.worker_descendants);
  if (!current || !currentChain || !diagnosticTree || !workerAncestors || !workerDescendants
    || !chainIsInternallyValid(current, currentChain, payload.current_chain_terminal, payload.current_chain_terminal_pid)
    || !Number.isInteger(payload.diagnostic_root_pid)) throw new Error("candidate31 process graph");
  const rootPid = Number(payload.diagnostic_root_pid);
  const currentAndAncestors = [current, ...currentChain];
  const nearestSshd = currentAndAncestors.find((row) => row[2] === "sshd.exe");
  const diagnosticValid = nearestSshd?.[0] === rootPid && descendantsAreValid(rootPid, diagnosticTree)
    && diagnosticTree.some((row) => row[0] === current[0]);
  if (payload.diagnostic_tree_valid !== diagnosticValid) throw new Error("candidate31 diagnostic tree");
  const workerExpected = worker !== null && worker[0] === 13644 && worker[1] === 2712
    && worker[2] === "node.exe" && worker[3] === "2026-08-14T08:02:31.2903580Z" && worker[4] === 0
    && worker[5] === "D:\\softwares\\Nodejs\\node.exe" && worker[6] === true && worker[7] === 66
    && worker[8] === WORKER_COMMAND_SHA256;
  if (payload.protected_worker_exact !== workerExpected || !worker
    || !chainIsInternallyValid(worker, workerAncestors, payload.worker_ancestor_terminal,
      payload.worker_ancestor_terminal_pid)) throw new Error("candidate31 worker");
  const workerDescendantsValid = descendantsAreValid(13644, workerDescendants);
  if (payload.worker_descendants_valid !== workerDescendantsValid) throw new Error("candidate31 worker descendants");
  const globalRows = new Map<number, Candidate31ProcessRow>();
  const registerRows = (values: Candidate31ProcessRow[]): void => {
    for (const row of values) {
      const previous = globalRows.get(row[0]);
      if (previous && canonicalJson(previous) !== canonicalJson(row)) {
        throw new Error("candidate31 inconsistent process row");
      }
      globalRows.set(row[0], row);
    }
  };
  registerRows([current, ...currentChain, ...diagnosticTree, worker, ...workerAncestors, ...workerDescendants]);
  const targetValues = Array.isArray(payload.targets) ? payload.targets : null;
  if (!targetValues || targetValues.length !== CANDIDATE31_TARGETS.length) throw new Error("candidate31 targets");
  const diagnosticPids = new Set(diagnosticTree.map((row) => row[0]));
  const currentPids = new Set(currentAndAncestors.map((row) => row[0]));
  const workerAncestorPids = new Set(workerAncestors.map((row) => row[0]));
  const workerDescendantPids = new Set(workerDescendants.map((row) => row[0]));
  const exactPids: number[] = [];
  let targetsValid = true;
  for (let index = 0; index < CANDIDATE31_TARGETS.length; index += 1) {
    const target = CANDIDATE31_TARGETS[index]!;
    const observed = targetValues[index];
    if (!Array.isArray(observed) || observed.length !== 8 || observed[0] !== target.ordinal || observed[1] !== target.pid) {
      throw new Error("candidate31 target order");
    }
    if (observed[2] === "absent") {
      if (observed[3] !== null || !Array.isArray(observed[4]) || observed[4].length !== 0
        || observed[5] !== "absent" || observed[6] !== 0 || observed[7] !== "not_observed") {
        throw new Error("candidate31 absent target");
      }
      continue;
    }
    const actual = processRow(observed[3]);
    const ancestorRows = rows(observed[4]);
    if (!actual || actual[0] !== target.pid || observed[7] !== "captured_this_observation"
      || !ancestorRows || !chainIsInternallyValid(actual, ancestorRows, observed[5], observed[6])) {
      throw new Error("candidate31 present target");
    }
    registerRows([actual, ...ancestorRows]);
    const relationshipExact = !diagnosticPids.has(target.pid) && !currentPids.has(target.pid)
      && !workerAncestorPids.has(target.pid) && !workerDescendantPids.has(target.pid)
      && !ancestorRows.some((row) => row[0] === 13644)
      && target.pid !== rootPid && !ancestorRows.some((row) => row[0] === rootPid);
    const exact = expectedTargetIdentity(actual, target) && relationshipExact
      && (observed[5] === "zero" || observed[5] === "missing_parent");
    if (observed[2] !== (exact ? "exact" : "mismatch")) throw new Error("candidate31 target state");
    if (exact) exactPids.push(target.pid); else targetsValid = false;
  }
  if (!Array.isArray(payload.effective_present_set)
    || canonicalJson(payload.effective_present_set) !== canonicalJson(exactPids)) {
    throw new Error("candidate31 effective set");
  }
  const listeners8443 = listeners(payload.listeners_8443, 8443);
  const listeners18443 = listeners(payload.listeners_18443, 18443);
  if (!listeners8443 || !listeners18443) throw new Error("candidate31 listeners");
  const listenerExact = canonicalJson(listeners8443) === canonicalJson([["0.0.0.0", 8443, 13644]])
    && listeners18443.length === 0;
  const observed = targetsValid && workerExpected && payload.current_chain_terminal === "zero"
    && diagnosticValid && payload.worker_ancestor_terminal === "zero" && workerDescendantsValid && listenerExact;
  if (payload.decision !== (observed ? "observed" : "observed_blocked")) throw new Error("candidate31 decision");
  const completePayload = object(complete?.p);
  const completeKeys = [
    "cleanup_performed", "file_mutation_performed", "hardware_action_performed",
    "process_mutation_performed", "remote_file_write_performed", "retry_permitted",
    "stdin_length", "vivado_action_performed",
  ];
  if (!complete || !exactKeys(complete, ["id", "n", "p", "s", "t", "z"])
    || complete.s !== "r31" || complete.id !== CANDIDATE31_ID || complete.n !== 3
    || complete.t !== "complete" || complete.z !== "complete" || !completePayload
    || !exactKeys(completePayload, completeKeys) || completePayload.stdin_length !== 0
    || completePayload.cleanup_performed !== false || completePayload.file_mutation_performed !== false
    || completePayload.hardware_action_performed !== false || completePayload.process_mutation_performed !== false
    || completePayload.remote_file_write_performed !== false || completePayload.retry_permitted !== false
    || completePayload.vivado_action_performed !== false) throw new Error("candidate31 complete");
  return {
    schema: "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-result.v1",
    status: payload.decision,
    preflight_id: CANDIDATE31_ID,
    snapshot: payload,
    exact_present_count: exactPids.length,
    absent_count: CANDIDATE31_TARGETS.length - targetValues.filter((value) => Array.isArray(value) && value[2] !== "absent").length,
    executable_path_authority: "captured_this_observation_not_historically_bound",
    captured_executable_paths: targetValues
      .filter((value) => Array.isArray(value) && value[2] !== "absent")
      .map((value) => [value[1], Array.isArray(value[3]) ? value[3][5] : null]),
    retry_permitted: false,
    cleanup_performed: false,
  };
}

function loadContext(rawConfig: unknown, dependencies: Candidate31Dependencies) {
  const config = validateCandidate31Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, SIX_SOURCE_PATH, config.expected_six_source_sha256);
  readExpected(dependencies, SIX_TEST_PATH, config.expected_six_test_sha256);
  const originalSix = validateCandidate19ScriptConfig(JSON.parse(readExpected(
    dependencies, ORIGINAL_SIX_CONFIG_PATH, ORIGINAL_SIX_CONFIG_SHA256,
  ).toString("utf8")));
  const candidate17Names = Object.keys(CANDIDATE17_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE17_EVIDENCE_DIRECTORY))
      !== canonicalJson(candidate17Names)
    || sha256(canonicalJson(CANDIDATE17_MANIFEST) + "\n") !== CANDIDATE17_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE31_CANDIDATE17_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of candidate17Names) readExpected(
    dependencies,
    CANDIDATE17_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE17_MANIFEST[name as keyof typeof CANDIDATE17_MANIFEST],
  );
  const candidate17Observation = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE17_EVIDENCE_DIRECTORY + "/observation.json",
    CANDIDATE17_MANIFEST["observation.json"],
  ).toString("utf8")));
  const observedTargets = Array.isArray(candidate17Observation?.targets) ? candidate17Observation.targets : [];
  const observedCandidates = Array.isArray(candidate17Observation?.candidates) ? candidate17Observation.candidates : [];
  const dualTimeByPid = new Map<number, [string, string]>();
  for (const value of observedTargets) {
    const target = object(value);
    if (!target || target.exists !== true || target.name_exact !== true
      || target.get_process_creation_exact !== true || target.cim_microseconds_match !== true
      || target.command_line_hash_exact !== true || !Number.isInteger(target.expected_pid)
      || typeof target.expected_creation_utc !== "string" || typeof target.cim_creation_utc !== "string") {
      fail("M4F_CANDIDATE31_CANDIDATE17_OBSERVATION_INVALID", "local_preflight");
    }
    dualTimeByPid.set(Number(target.expected_pid), [target.expected_creation_utc, target.cim_creation_utc]);
  }
  for (const value of observedCandidates) {
    const candidate = object(value);
    if (!candidate || candidate.current_cmd_state !== "present"
      || candidate.ownership_mode !== "orphaned_session_residue_cmd_present"
      || candidate.cmd_parent_missing !== true || !Number.isInteger(candidate.cmd_pid)
      || typeof candidate.cmd_creation_utc !== "string") {
      fail("M4F_CANDIDATE31_CANDIDATE17_OBSERVATION_INVALID", "local_preflight");
    }
    dualTimeByPid.set(Number(candidate.cmd_pid), [candidate.cmd_creation_utc, candidate.cmd_creation_utc]);
  }
  const expectedDualTimes = originalSix.targets.map((target, index) => {
    const candidate31 = CANDIDATE31_TARGETS[index]!;
    return [target.pid, target.creation_utc, candidate31.creation_utc];
  });
  const observedDualTimes = expectedDualTimes.map(([pid]) => {
    const dual = dualTimeByPid.get(Number(pid));
    return dual ? [pid, dual[0], dual[1]] : null;
  });
  if (canonicalJson(observedDualTimes) !== canonicalJson(expectedDualTimes)) {
    fail("M4F_CANDIDATE31_CANDIDATE17_DUAL_TIME_INVALID", "local_preflight");
  }
  const frozenSix = CANDIDATE31_TARGETS.slice(0, 6).map((target) => ({
    candidate: target.lineage,
    command_sha256: target.command_sha256,
    creation_utc: target.creation_utc,
    name: target.name,
    parent_pid: target.parent_pid,
    pid: target.pid,
    role: target.role,
    session_id: target.session_id,
  }));
  const sourceSix = originalSix.targets.map((target) => ({
    candidate: target.candidate,
    command_sha256: target.command_sha256,
    creation_utc: CANDIDATE31_TARGETS.find((candidate) => candidate.pid === target.pid)?.creation_utc,
    name: target.name,
    parent_pid: target.parent_pid,
    pid: target.pid,
    role: target.role,
    session_id: target.session_id,
  }));
  if (canonicalJson(frozenSix) !== canonicalJson(sourceSix)) {
    fail("M4F_CANDIDATE31_ORIGINAL_SIX_INVALID", "local_preflight");
  }
  const candidate30Names = Object.keys(CANDIDATE30_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE30_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate30Names)
    || sha256(canonicalJson(CANDIDATE30_MANIFEST) + "\n") !== CANDIDATE30_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE31_CANDIDATE30_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of candidate30Names) readExpected(
    dependencies,
    CANDIDATE30_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE30_MANIFEST[name as keyof typeof CANDIDATE30_MANIFEST],
  );
  const candidate30Record = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE30_EVIDENCE_DIRECTORY + "/inventory-record.json",
    CANDIDATE30_RECORD_SHA256,
  ).toString("utf8")));
  const inventoryResult = object(candidate30Record?.inventory_result);
  const snapshot = object(inventoryResult?.snapshot);
  const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  const frozenAttempt2 = CANDIDATE31_TARGETS.slice(6).map((target) => [
    target.pid, target.parent_pid, target.name, target.creation_utc, target.session_id,
    true, target.command_length, target.command_sha256, null, false,
  ]).sort((left, right) => Number(left[0]) - Number(right[0]));
  const sortedCandidates = [...candidates].sort((left, right) => {
    const leftRow = Array.isArray(left) ? left : [];
    const rightRow = Array.isArray(right) ? right : [];
    return Number(leftRow[0]) - Number(rightRow[0]);
  });
  if (!candidate30Record || candidate30Record.status !== "observed"
    || inventoryResult?.status !== "observed" || inventoryResult.candidate_count !== 3
    || canonicalJson(sortedCandidates) !== canonicalJson(frozenAttempt2)
    || inventoryResult.protected_worker_exact !== true || inventoryResult.listener_exact !== true
    || candidate30Record.cleanup_performed !== false || candidate30Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE31_CANDIDATE30_RECORD_INVALID", "local_preflight");
  }
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE31_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, originalSix, dualTimeTuples: expectedDualTimes, payload: buildCandidate31Payload() };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-plan.v1",
    preflight_id: CANDIDATE31_ID,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "one_effective_audit_then_one_direct_ssh_empty_stdin",
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    command_sha256: context.payload.commandHash,
    command_length: context.payload.command.length,
    candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
    candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
    candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
    original_six_dual_time_tuples: context.dualTimeTuples,
    original_six_config_sha256: ORIGINAL_SIX_CONFIG_SHA256,
    six_source_sha256: context.config.expected_six_source_sha256,
    six_test_sha256: context.config.expected_six_test_sha256,
    effective_audit_count: 1,
    remote_attempt_count: 1,
    stdin_length: 0,
    target_body_invocation_permitted: true,
    cim_read_only_execution_permitted: true,
    retry_permitted: false,
    cleanup_permitted: false,
    process_mutation_permitted: false,
    remote_file_write_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
  };
}

export function planCandidate31(rawConfig: unknown, dependencies: Candidate31Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE31_NINE_PID_READ_ONLY_PREFLIGHT",
    CANDIDATE31_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.targetHash,
    context.payload.commandHash,
    CANDIDATE30_MANIFEST_SHA256,
    CANDIDATE30_RECORD_SHA256,
    CANDIDATE17_MANIFEST_SHA256,
    ORIGINAL_SIX_CONFIG_SHA256,
    context.config.expected_six_source_sha256,
    context.config.expected_six_test_sha256,
  ].join(":");
}

export function candidate31Confirmation(rawConfig: unknown, dependencies: Candidate31Dependencies): string {
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

function write(dependencies: Candidate31Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE31_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate31(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate31Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE31_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE31_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  const plan = planFor(context);
  write(dependencies, context.config.evidence_directory, "preflight-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, context.config.evidence_directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, context.config.evidence_directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, context.config.evidence_directory, "target-preflight-script.ps1", context.payload.targetScript);
  write(dependencies, context.config.evidence_directory, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
  const effective = dependencies.spawn(
    SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, context.config.evidence_directory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, context.config.evidence_directory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, context.config.evidence_directory, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE31_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE31_INPUT_DRIFT", "local_preflight");
  }
  write(dependencies, context.config.evidence_directory, "transport-inputs-pre-remote.json", JSON.stringify(pre, null, 2) + "\n");
  const remote = dependencies.spawn(
    SSH_PATH,
    [...buildDirectSshOptions(context.transport), TARGET_HOST, context.payload.command],
    Buffer.alloc(0),
    REMOTE_TIMEOUT_MS,
  );
  write(dependencies, context.config.evidence_directory, "stdout.raw", remote.stdout);
  write(dependencies, context.config.evidence_directory, "stderr.raw", remote.stderr);
  write(dependencies, context.config.evidence_directory, "remote-process.json", JSON.stringify(processEvidence(remote), null, 2) + "\n");
  const post = dependencies.transportInputs(context.transport, "network");
  write(dependencies, context.config.evidence_directory, "transport-inputs-post-remote.json", JSON.stringify(post, null, 2) + "\n");
  if (canonicalJson(post) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE31_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE31_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE31_STDERR_REJECTED", "network");
  let result: Record<string, unknown>;
  try {
    result = validateCandidate31Output(remote.stdout);
  } catch {
    fail("M4F_CANDIDATE31_PREFLIGHT_OUTPUT_INVALID", "network");
  }
  const record = {
    schema: "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-record.v1",
    preflight_id: CANDIDATE31_ID,
    status: result.status,
    recorded_at_utc: dependencies.now().toISOString(),
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    preflight_result: result,
    candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
    candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
    candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
    original_six_dual_time_tuples: context.dualTimeTuples,
    original_six_config_sha256: ORIGINAL_SIX_CONFIG_SHA256,
    six_source_sha256: context.config.expected_six_source_sha256,
    six_test_sha256: context.config.expected_six_test_sha256,
    process: processEvidence(remote),
    target_body_invoked: true,
    cim_executed: true,
    cleanup_performed: false,
    process_mutation_performed: false,
    remote_file_write_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    retry_permitted: false,
  };
  write(dependencies, context.config.evidence_directory, "preflight-record.json", JSON.stringify(record, null, 2) + "\n");
  return record;
}

const systemDependencies: Candidate31Dependencies = {
  read: (path) => readFileSync(path),
  entries: (path) => readdirSync(path).sort(),
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
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[1] !== "--config") throw new Error("usage");
    const config = JSON.parse(readFileSync(args[2]!, "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      const plan = planCandidate31(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate31Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate31(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate31Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE31_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
