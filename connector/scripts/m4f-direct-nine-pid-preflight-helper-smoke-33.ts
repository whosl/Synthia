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
import {
  CANDIDATE31_HELPERS,
  CANDIDATE31_HELPER_SHA256,
  CANDIDATE31_HELPERS_COMBINED_SHA256,
  CANDIDATE31_TARGET_SHA256,
} from "./m4f-direct-attempt2-residue-nine-pid-preflight-31.ts";
import {
  auditDirectSshEffectiveConfig,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  validateM4fDirectAdmissionConfig,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
} from "./m4f-gate-admission-transport.ts";

const COMMAND_LIMIT = 7_000;
const HASH = /^[0-9a-f]{64}$/u;
const X_SHA256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const EFFECTIVE_CONFIG_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";
const CANDIDATE32_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32-evidence";
const CANDIDATE32_MANIFEST_PATH =
  "/private/tmp/m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32-evidence-manifest.json";
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;

export const CANDIDATE33_ID = "m4f-direct-nine-pid-preflight-helper-smoke-prod-20260831-33";
export const CANDIDATE33_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-preflight-helper-smoke-prod-20260831-33-evidence";
const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-preflight-helper-smoke-33.test.ts", import.meta.url));
const CANDIDATE31_SOURCE_PATH = fileURLToPath(
  new URL("./m4f-direct-attempt2-residue-nine-pid-preflight-31.ts", import.meta.url),
);
const CANDIDATE31_TEST_PATH = fileURLToPath(
  new URL("../m4f-direct-attempt2-residue-nine-pid-preflight-31.test.ts", import.meta.url),
);

export interface Candidate33Config {
  schema: "synthia-m4f-direct-nine-pid-preflight-helper-smoke-33-config.v1";
  probe_id: typeof CANDIDATE33_ID;
  evidence_directory: typeof CANDIDATE33_EVIDENCE_DIRECTORY;
  candidate32_evidence_directory: typeof CANDIDATE32_EVIDENCE_DIRECTORY;
  candidate32_manifest_path: typeof CANDIDATE32_MANIFEST_PATH;
  candidate32_manifest_sha256: string;
  candidate32_record_sha256: string;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_candidate31_source_sha256: string;
  expected_candidate31_test_sha256: string;
}

export interface Candidate33Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export class Candidate33Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE33_FAILED"));
  }
}

function fail(code: string, extra: Record<string, unknown> = {}): never {
  throw new Candidate33Failure({
    schema: "synthia-m4f-direct-nine-pid-preflight-helper-smoke-33-failure.v1",
    code,
    retry_permitted: false,
    target_body_invoked: false,
    cim_executed: false,
    cleanup_performed: false,
    process_mutation_performed: false,
    remote_file_write_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    ...extra,
  });
}

export function buildCandidate33Payload() {
  const helperScript = CANDIDATE31_HELPERS.join(";");
  const helperHashes = CANDIDATE31_HELPERS.map((helper) => sha256(helper));
  const smokeScript = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    helperScript,
    "$AliasCount=@(Get-Alias -Definition Get-SynthiaM4f31Sha256,ConvertTo-SynthiaM4f31ProcessRow,Get-SynthiaM4f31AncestorChain -ErrorAction SilentlyContinue).Count",
    "$FunctionCount=@(Get-Command Get-SynthiaM4f31Sha256,ConvertTo-SynthiaM4f31ProcessRow,Get-SynthiaM4f31AncestorChain -CommandType Function).Count",
    "$Dummy=[pscustomobject]@{ProcessId=1;ParentProcessId=2;Name='CMD.EXE';CreationDate=[DateTime]::ParseExact('2026-08-31T00:00:00.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\Windows\\System32\\cmd.exe';CommandLine='abc'}",
    "$DummyRow=ConvertTo-SynthiaM4f31ProcessRow $Dummy",
    "$DeepMap=@{};for ($Index=0; $Index -le 12; $Index++){$PidValue=100+$Index;$ParentValue=if ($Index -eq 12){0}else{$PidValue+1};$DeepMap[$PidValue]=[pscustomobject]@{ProcessId=$PidValue;ParentProcessId=$ParentValue;Name=('p{0}.exe' -f $Index);CreationDate=[DateTime]::ParseExact(('2026-08-30T00:00:{0}.0000000Z' -f (12-$Index).ToString('00')),'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath=('C:\\p{0}.exe' -f $Index);CommandLine=('p{0}' -f $Index)}}",
    "$Deep=Get-SynthiaM4f31AncestorChain $DeepMap[100] $DeepMap",
    "$MissingProcess=[pscustomobject]@{ProcessId=200;ParentProcessId=201;Name='missing.exe';CreationDate=[DateTime]::ParseExact('2026-08-30T00:00:00.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\missing.exe';CommandLine='missing'}",
    "$Missing=Get-SynthiaM4f31AncestorChain $MissingProcess @{}",
    "$CycleMap=@{};$CycleMap[300]=[pscustomobject]@{ProcessId=300;ParentProcessId=301;Name='c0.exe';CreationDate=[DateTime]::ParseExact('2026-08-30T00:00:01.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\c0.exe';CommandLine='c0'};$CycleMap[301]=[pscustomobject]@{ProcessId=301;ParentProcessId=300;Name='c1.exe';CreationDate=[DateTime]::ParseExact('2026-08-30T00:00:00.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\c1.exe';CommandLine='c1'}",
    "$Cycle=Get-SynthiaM4f31AncestorChain $CycleMap[300] $CycleMap",
    "$InvalidMap=@{};$InvalidMap[401]=[pscustomobject]@{ProcessId=401;ParentProcessId=0;Name='newer.exe';CreationDate=[DateTime]::ParseExact('2026-08-31T00:00:01.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\newer.exe';CommandLine='newer'};$InvalidProcess=[pscustomobject]@{ProcessId=400;ParentProcessId=401;Name='older.exe';CreationDate=[DateTime]::ParseExact('2026-08-31T00:00:00.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\older.exe';CommandLine='older'}",
    "$Invalid=Get-SynthiaM4f31AncestorChain $InvalidProcess $InvalidMap",
    "$Result=[ordered]@{s='r33';alias_count=$AliasCount;function_count=$FunctionCount;hash_null=(Get-SynthiaM4f31Sha256 $null);hash_x=(Get-SynthiaM4f31Sha256 'x');dummy_row=$DummyRow;deep_count=@($Deep.r).Count;deep_pids=@($Deep.r|ForEach-Object{[int]$_[0]});deep_terminal=$Deep.t;deep_terminal_pid=[int]$Deep.p;missing_count=@($Missing.r).Count;missing_terminal=$Missing.t;missing_terminal_pid=[int]$Missing.p;cycle_count=@($Cycle.r).Count;cycle_terminal=$Cycle.t;cycle_terminal_pid=[int]$Cycle.p;invalid_count=@($Invalid.r).Count;invalid_terminal=$Invalid.t;invalid_terminal_pid=[int]$Invalid.p;stdin_length=0}",
    "[Console]::Out.WriteLine(($Result|ConvertTo-Json -Compress -Depth 6))",
  ].join(";");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \""
    + smokeScript + "\"";
  const definitionCount = smokeScript.match(/function\s+(?:Get-SynthiaM4f31Sha256|ConvertTo-SynthiaM4f31ProcessRow|Get-SynthiaM4f31AncestorChain)\s*\(/gu)?.length ?? 0;
  const forbidden = /Get-CimInstance|MSFT_NetTCPConnection|Parser|GZip|ScriptBlock|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado|program_hw|Set-Alias|New-Alias|s='r31'|t='snapshot'/iu.test(smokeScript);
  if (command.length > COMMAND_LIMIT || command.includes('""') || definitionCount !== 3 || forbidden
    || helperHashes.some((hash, index) => hash !== CANDIDATE31_HELPER_SHA256[index])
    || sha256(helperScript) !== CANDIDATE31_HELPERS_COMBINED_SHA256) {
    fail("M4F_CANDIDATE33_PAYLOAD_INVALID", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      definition_count: definitionCount,
      forbidden,
    });
  }
  return {
    helperScript,
    helperHashes,
    helperCombinedHash: sha256(helperScript),
    smokeScript,
    smokeScriptHash: sha256(smokeScript),
    smokeScriptLength: Buffer.byteLength(smokeScript),
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validateCandidate33Output(stdout: Buffer) {
  let value: Record<string, unknown> | null;
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(stdout);
    if (!text.endsWith("\n") || text.trim().split(/\r?\n/u).length !== 1) throw new Error("shape");
    value = object(JSON.parse(text));
  } catch {
    fail("M4F_CANDIDATE33_STDOUT_INVALID");
  }
  const keys = [
    "alias_count", "cycle_count", "cycle_terminal", "cycle_terminal_pid", "deep_count",
    "deep_pids", "deep_terminal", "deep_terminal_pid", "dummy_row", "function_count",
    "hash_null", "hash_x", "invalid_count", "invalid_terminal", "invalid_terminal_pid",
    "missing_count", "missing_terminal", "missing_terminal_pid", "s", "stdin_length",
  ];
  const dummy = Array.isArray(value?.dummy_row) ? value.dummy_row : [];
  const expectedDeepPids = Array.from({ length: 12 }, (_unused, index) => 101 + index);
  if (!value || Object.keys(value).sort().join("|") !== keys.sort().join("|")
    || value.s !== "r33" || value.alias_count !== 0 || value.function_count !== 3
    || value.hash_null !== null || value.hash_x !== X_SHA256
    || dummy.length !== 9 || dummy[0] !== 1 || dummy[1] !== 2 || dummy[2] !== "cmd.exe"
    || dummy[3] !== "2026-08-31T00:00:00.0000000Z" || dummy[4] !== 0
    || dummy[5] !== "C:\\Windows\\System32\\cmd.exe" || dummy[6] !== true
    || dummy[7] !== 3 || dummy[8] !== ABC_SHA256
    || value.deep_count !== 12 || JSON.stringify(value.deep_pids) !== JSON.stringify(expectedDeepPids)
    || value.deep_terminal !== "zero" || value.deep_terminal_pid !== 0
    || value.missing_count !== 0 || value.missing_terminal !== "missing_parent" || value.missing_terminal_pid !== 201
    || value.cycle_count !== 1 || value.cycle_terminal !== "cycle" || value.cycle_terminal_pid !== 300
    || value.invalid_count !== 1 || value.invalid_terminal !== "invalid_edge" || value.invalid_terminal_pid !== 401
    || value.stdin_length !== 0) {
    fail("M4F_CANDIDATE33_HELPER_SMOKE_REJECTED");
  }
  return {
    status: "exact_helpers_runtime_smoked",
    helper_sha256: [...CANDIDATE31_HELPER_SHA256],
    helpers_combined_sha256: CANDIDATE31_HELPERS_COMBINED_SHA256,
    alias_count: 0,
    function_count: 3,
    deep_ancestor_count: 12,
    terminals: ["zero", "missing_parent", "cycle", "invalid_edge"],
    target_body_invoked: false,
    cim_executed: false,
    stdin_length: 0,
    retry_permitted: false,
  };
}

export function validateCandidate33Hash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
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

export function validateCandidate33Config(value: unknown): Candidate33Config {
  const config = object(value);
  const keys = [
    "candidate32_evidence_directory", "candidate32_manifest_path", "candidate32_manifest_sha256",
    "candidate32_record_sha256", "evidence_directory", "expected_candidate31_source_sha256",
    "expected_candidate31_test_sha256", "expected_source_sha256", "expected_test_sha256",
    "probe_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-nine-pid-preflight-helper-smoke-33-config.v1"
    || config.probe_id !== CANDIDATE33_ID || config.evidence_directory !== CANDIDATE33_EVIDENCE_DIRECTORY
    || config.candidate32_evidence_directory !== CANDIDATE32_EVIDENCE_DIRECTORY
    || config.candidate32_manifest_path !== CANDIDATE32_MANIFEST_PATH
    || [config.candidate32_manifest_sha256, config.candidate32_record_sha256,
      config.expected_source_sha256, config.expected_test_sha256,
      config.expected_candidate31_source_sha256, config.expected_candidate31_test_sha256]
      .some((hash) => !validateCandidate33Hash(hash))) {
    fail("M4F_CANDIDATE33_CONFIG_INVALID");
  }
  return value as Candidate33Config;
}

function readExpected(
  dependencies: Candidate33Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE33_INPUT_MISSING", { path });
  }
  if (sha256(bytes) !== expectedSha256) fail("M4F_CANDIDATE33_INPUT_DRIFT", { path });
  return bytes;
}

function loadContext(rawConfig: unknown, dependencies: Candidate33Dependencies) {
  const config = validateCandidate33Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, CANDIDATE31_SOURCE_PATH, config.expected_candidate31_source_sha256);
  readExpected(dependencies, CANDIDATE31_TEST_PATH, config.expected_candidate31_test_sha256);
  const manifest = object(JSON.parse(readExpected(
    dependencies, CANDIDATE32_MANIFEST_PATH, config.candidate32_manifest_sha256,
  ).toString("utf8")));
  if (!manifest || Object.values(manifest).some((hash) => !validateCandidate33Hash(hash))
    || canonicalJson(dependencies.entries(CANDIDATE32_EVIDENCE_DIRECTORY))
      !== canonicalJson(Object.keys(manifest).sort())
    || manifest["probe-record.json"] !== config.candidate32_record_sha256) {
    fail("M4F_CANDIDATE33_CANDIDATE32_MANIFEST_INVALID");
  }
  for (const [name, expected] of Object.entries(manifest)) {
    readExpected(dependencies, CANDIDATE32_EVIDENCE_DIRECTORY + "/" + name, String(expected));
  }
  const candidate32Record = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE32_EVIDENCE_DIRECTORY + "/probe-record.json",
    config.candidate32_record_sha256,
  ).toString("utf8")));
  const parseResult = object(candidate32Record?.parse_result);
  if (!candidate32Record || candidate32Record.status !== "exact_target_parse_zero"
    || candidate32Record.target_script_sha256 !== CANDIDATE31_TARGET_SHA256
    || parseResult?.target_script_sha256 !== CANDIDATE31_TARGET_SHA256
    || parseResult.parse_error_count !== 0 || parseResult.ast_type !== "ScriptBlockAst"
    || parseResult.end_block_present !== true || parseResult.target_body_invoked !== false
    || parseResult.cim_executed !== false || parseResult.stdin_length !== 0
    || canonicalJson(candidate32Record.helper_contract_sha256) !== canonicalJson(CANDIDATE31_HELPER_SHA256)
    || candidate32Record.helpers_combined_contract_sha256 !== CANDIDATE31_HELPERS_COMBINED_SHA256
    || candidate32Record.target_body_invoked !== false || candidate32Record.cim_executed !== false
    || candidate32Record.cleanup_performed !== false || candidate32Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE33_CANDIDATE32_RECORD_INVALID");
  }
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE33_TRANSPORT_INVALID");
  }
  return { config, transport, payload: buildCandidate33Payload() };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-nine-pid-preflight-helper-smoke-33-plan.v1",
    probe_id: CANDIDATE33_ID,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "one_effective_audit_then_one_direct_ssh_empty_stdin",
    helper_sha256: [...CANDIDATE31_HELPER_SHA256],
    helpers_combined_sha256: CANDIDATE31_HELPERS_COMBINED_SHA256,
    smoke_script_sha256: context.payload.smokeScriptHash,
    smoke_script_length: context.payload.smokeScriptLength,
    command_sha256: context.payload.commandHash,
    command_length: context.payload.command.length,
    candidate32_manifest_sha256: context.config.candidate32_manifest_sha256,
    candidate32_record_sha256: context.config.candidate32_record_sha256,
    helper_definition_count: 3,
    helper_runtime_smoke_count: 7,
    effective_audit_count: 1,
    remote_attempt_count: 1,
    stdin_length: 0,
    target_body_invoked: false,
    cim_executed: false,
    retry_permitted: false,
    cleanup_permitted: false,
    process_mutation_permitted: false,
    remote_file_write_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
  };
}

export function planCandidate33(rawConfig: unknown, dependencies: Candidate33Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE33_EXACT_THREE_HELPER_RUNTIME_SMOKE",
    CANDIDATE33_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.smokeScriptHash,
    context.payload.commandHash,
    context.config.candidate32_manifest_sha256,
    context.config.candidate32_record_sha256,
  ].join(":");
}

export function candidate33Confirmation(rawConfig: unknown, dependencies: Candidate33Dependencies): string {
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

function write(dependencies: Candidate33Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE33_EVIDENCE_WRITE_FAILED");
  }
}

export function executeCandidate33(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate33Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE33_CONFIRMATION_REQUIRED");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE33_EVIDENCE_CREATE_FAILED");
  }
  const plan = planFor(context);
  write(dependencies, context.config.evidence_directory, "probe-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, context.config.evidence_directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, context.config.evidence_directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, context.config.evidence_directory, "helper-smoke.ps1", context.payload.smokeScript);
  write(dependencies, context.config.evidence_directory, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
  const effective = dependencies.spawn(
    SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, context.config.evidence_directory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, context.config.evidence_directory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, context.config.evidence_directory, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE33_EFFECTIVE_FAILED");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE33_INPUT_DRIFT");
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
    fail("M4F_CANDIDATE33_POSTFLIGHT_DRIFT");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE33_REMOTE_FAILED", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE33_STDERR_REJECTED");
  const helperResult = validateCandidate33Output(remote.stdout);
  const record = {
    schema: "synthia-m4f-direct-nine-pid-preflight-helper-smoke-33-record.v1",
    probe_id: CANDIDATE33_ID,
    status: "exact_helpers_runtime_smoked",
    recorded_at_utc: dependencies.now().toISOString(),
    helper_result: helperResult,
    smoke_script_sha256: context.payload.smokeScriptHash,
    candidate32_manifest_sha256: context.config.candidate32_manifest_sha256,
    candidate32_record_sha256: context.config.candidate32_record_sha256,
    process: processEvidence(remote),
    target_body_invoked: false,
    cim_executed: false,
    cleanup_performed: false,
    process_mutation_performed: false,
    remote_file_write_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    retry_permitted: false,
  };
  write(dependencies, context.config.evidence_directory, "probe-record.json", JSON.stringify(record, null, 2) + "\n");
  return record;
}

const systemDependencies: Candidate33Dependencies = {
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
      const plan = planCandidate33(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate33Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate33(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate33Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE33_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
