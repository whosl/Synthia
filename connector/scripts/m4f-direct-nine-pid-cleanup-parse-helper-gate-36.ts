import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  buildCandidate35BusinessScript,
  buildCandidate35Payload,
  validateCandidate35Config,
  type Candidate35Config,
} from "./m4f-direct-nine-pid-cleanup-runner-35.ts";
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
const PURE_HELPER_NAMES = [
  "Get-SynthiaM4f35Sha256",
  "Get-SynthiaM4f35MicrosecondTicks",
  "ConvertTo-SynthiaM4f35ProcessRow",
  "Get-SynthiaM4f35AncestorChain",
  "Test-SynthiaM4f35StaleBoundary",
  "Test-SynthiaM4f35TargetExact",
] as const;

export const CANDIDATE36_ID = "m4f-direct-nine-pid-cleanup-parse-helper-gate-20260901-36-r12";
export const CANDIDATE36_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12-evidence";
export const CANDIDATE36_MANIFEST_PATH =
  "/private/tmp/m4f-direct-nine-pid-cleanup-parse-helper-gate-prod-20260901-36-r12-evidence-manifest.json";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const EFFECTIVE_CONFIG_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;
const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-cleanup-parse-helper-gate-36.test.ts", import.meta.url));
const C35_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-nine-pid-cleanup-runner-35.ts", import.meta.url));
const C35_TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-cleanup-runner-35.test.ts", import.meta.url));

export interface Candidate36BuiltPayload {
  targetScript: string;
  targetScriptSha256: string;
  targetScriptLength: number;
  targetGzip: Buffer;
  targetGzipSha256: string;
  helperScript: string;
  helperSha256: string[];
  parseStdin: Buffer;
  parseStdinSha256: string;
  parseScript: string;
  parseCommand: string;
  parseCommandSha256: string;
  helperSmokeScript: string;
  helperSmokeScriptSha256: string;
  compressedHelperSmokeScript: Buffer;
  helperLoader: string;
  helperCommand: string;
  helperCommandSha256: string;
}

export interface Candidate36GateConfig {
  candidate35_config: Candidate35Config;
  gate_id: typeof CANDIDATE36_ID;
  evidence_directory: typeof CANDIDATE36_EVIDENCE_DIRECTORY;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_candidate35_source_sha256: string;
  expected_candidate35_test_sha256: string;
}

export interface Candidate36GateDependencies {
  read(path: string): Buffer;
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error("M4F_CANDIDATE36_HELPER_MISSING");
  const opening = source.indexOf("{", start);
  if (opening < 0) throw new Error("M4F_CANDIDATE36_HELPER_INVALID");
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let cursor = opening; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "`") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        if (source[cursor + 1] === quote) cursor += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  throw new Error("M4F_CANDIDATE36_HELPER_INVALID");
}

export function buildCandidate36Payload(rawConfig: Candidate35Config): Candidate36BuiltPayload {
  const targetScript = buildCandidate35BusinessScript(rawConfig);
  const candidate35Payload = buildCandidate35Payload(rawConfig);
  const targetBytes = Buffer.from(targetScript, "utf8");
  if (!gunzipSync(candidate35Payload.compressed_business_script).equals(targetBytes)) {
    throw new Error("M4F_CANDIDATE36_TARGET_GZIP_MISMATCH");
  }
  const helpers = PURE_HELPER_NAMES.map((name) => extractFunction(targetScript, name));
  const helperScript = helpers.join("\n");
  const forbidden = /Get-CimInstance|MSFT_NetTCPConnection|\.Kill\s*\(|Stop-Process|taskkill|Vivado|hw_server|vivado_lab|open_hw|program_hw|write_cfgmem/iu;
  if (forbidden.test(helperScript)) throw new Error("M4F_CANDIDATE36_HELPER_UNSAFE");

  const targetHash = sha256(targetBytes);
  const targetGzipHash = sha256(candidate35Payload.compressed_business_script);
  const targetGzipLength = candidate35Payload.compressed_business_script.length;
  const parseScript = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    `$i=[Console]::OpenStandardInput();[byte[]]$z=New-Object byte[] ${targetGzipLength};$p=0;while($p-lt$z.Length){$n=$i.Read($z,$p,$z.Length-$p);if($n-le0){throw'STDIN_EOF'};$p+=$n};if($i.ReadByte()-ne-1){throw'STDIN_TAIL'}`,
    "$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);$m=[IO.MemoryStream]::new();$g.CopyTo($m);$gt=$g.GetType().FullName;$g.Dispose();$b=$m.ToArray();$m.Dispose()",
    "$zh=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($z))-replace '-','').ToLowerInvariant();$h=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($b))-replace '-','').ToLowerInvariant()",
    `$u=[Text.UTF8Encoding]::new($false,$true);$s=$u.GetString($b);if($b.Length-ne${targetBytes.length}-or$h-cne'${targetHash}'-or$zh-cne'${targetGzipHash}'-or[Convert]::ToBase64String($u.GetBytes($s))-cne[Convert]::ToBase64String($b)){throw'BYTES'}`,
    "$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e)",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine(('r36p|'+$b.Length+'|'+$e.Count+'|'+$a.GetType().Name+'|'+($null-ne$a.EndBlock)+'|'+$h+'|'+$zh+'|'+$gt));[Console]::Out.Flush()",
  ].join(";");
  const parseCommand = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& { "
    + parseScript + " }\"";
  if (parseCommand.length > COMMAND_LIMIT || (parseScript.match(/Parser\]::ParseInput/gu)?.length ?? 0) !== 1
    || /ScriptBlock\]::Create|Invoke-Expression|Get-CimInstance|MSFT_NetTCPConnection|\.Kill\s*\(|Stop-Process|taskkill/iu.test(parseScript)) {
    throw new Error("M4F_CANDIDATE36_PARSE_PROBE_INVALID");
  }

  const helperSmokeScript = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    helperScript,
    "$x=Get-SynthiaM4f35Sha256 'x';$ti=[DateTime]::ParseExact('2026-08-31T00:00:00.1234567Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);$mt=Get-SynthiaM4f35MicrosecondTicks $ti",
    "$d=[pscustomobject]@{ProcessId=1;ParentProcessId=2;Name='CMD.EXE';CreationDate=[DateTime]::ParseExact('2026-08-31T00:00:00.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\Windows\\System32\\cmd.exe';CommandLine='abc'};$dr=ConvertTo-SynthiaM4f35ProcessRow $d",
    "$dm=@{};for($i=100;$i-le112;$i+=1){$p=if($i-eq112){0}else{$i+1};$dm[$i]=[pscustomobject]@{ProcessId=$i;ParentProcessId=$p;Name='node.exe';CreationDate=$ti;SessionId=0;ExecutablePath='C:\\node.exe';CommandLine='n'}};$deep=Get-SynthiaM4f35AncestorChain 100 $dm",
    "$mm=@{200=[pscustomobject]@{ProcessId=200;ParentProcessId=201;Name='node.exe';CreationDate=$ti;SessionId=0;ExecutablePath='C:\\node.exe';CommandLine='n'}};$missing=Get-SynthiaM4f35AncestorChain 200 $mm",
    "$cm=@{300=[pscustomobject]@{ProcessId=300;ParentProcessId=300;Name='node.exe';CreationDate=$ti;SessionId=0;ExecutablePath='C:\\node.exe';CommandLine='n'}};$cycle=Get-SynthiaM4f35AncestorChain 300 $cm",
    "$im=@{400=[pscustomobject]@{ProcessId=400;ParentProcessId=401;Name='node.exe';CreationDate=[DateTime]::ParseExact('2026-08-31T00:00:00.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\node.exe';CommandLine='n'};401=[pscustomobject]@{ProcessId=401;ParentProcessId=0;Name='node.exe';CreationDate=[DateTime]::ParseExact('2026-08-31T00:00:01.0000000Z','o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);SessionId=0;ExecutablePath='C:\\node.exe';CommandLine='n'}};$invalid=Get-SynthiaM4f35AncestorChain 400 $im",
    "$st=[ordered]@{terminal='invalid_edge';pid=1204;rows=@(@(1448,1304,'services.exe','2026-08-12T22:31:30.2114380Z',0,$null,$false,$null,$null),@(1304,1204,'wininit.exe','2026-08-12T22:31:30.1596200Z',0,$null,$false,$null,$null),@(1204,1448,'svchost.exe','2026-08-12T22:31:30.7301590Z',0,'C:\\WINDOWS\\System32\\svchost.exe',$true,80,'28badc7dddcdb48483f2880e3982160297bf49c3e21da9939589ebd0503bd8b8'))};$se=Test-SynthiaM4f35StaleBoundary $st",
    "$ta=@(1,1,'cmd',1,2,'cmd.exe','2026-08-31T00:00:00.0000000Z',0,'C:\\Windows\\System32\\cmd.exe',3,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');$te=Test-SynthiaM4f35TargetExact $d $ta",
    "$r=[ordered]@{s='r36h';powershell_edition=$PSVersionTable.PSEdition;powershell_version=$PSVersionTable.PSVersion.ToString();helper_count=6;hash_x=$x;micro_ticks=$mt;dummy_row=$dr;deep_count=@($deep.rows).Count;deep_terminal=$deep.terminal;deep_terminal_pid=$deep.pid;missing_count=@($missing.rows).Count;missing_terminal=$missing.terminal;missing_terminal_pid=$missing.pid;cycle_count=@($cycle.rows).Count;cycle_terminal=$cycle.terminal;cycle_terminal_pid=$cycle.pid;invalid_count=@($invalid.rows).Count;invalid_terminal=$invalid.terminal;invalid_terminal_pid=$invalid.pid;stale_exact=$se;target_exact=$te;target_body_invoked=$false;cim_executed=$false;kill_executed=$false;stdin_length=0};[Console]::Out.WriteLine(($r|ConvertTo-Json -Compress -Depth 10));[Console]::Out.Flush()",
  ].join(";");
  if (forbidden.test(helperSmokeScript) || /Parser|s='r35'|snapshot|Write-SynthiaM4f35Marker/iu.test(helperSmokeScript)) {
    throw new Error("M4F_CANDIDATE36_HELPER_PROBE_INVALID");
  }
  const compressedHelperSmokeScript = gzipSync(Buffer.from(helperSmokeScript, "utf8"), { level: 9 });
  const helperLoader = "$ErrorActionPreference='Stop';$z=[Convert]::FromBase64String('"
    + compressedHelperSmokeScript.toString("base64")
    + "');$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);&([ScriptBlock]::Create([IO.StreamReader]::new($g,[Text.UTF8Encoding]::new($false,$true)).ReadToEnd()))";
  const helperCommand = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& { "
    + helperLoader + " }\"";
  if (helperCommand.length > COMMAND_LIMIT) throw new Error("M4F_CANDIDATE36_HELPER_COMMAND_TOO_LONG");
  return {
    targetScript,
    targetScriptSha256: targetHash,
    targetScriptLength: targetBytes.length,
    targetGzip: Buffer.from(candidate35Payload.compressed_business_script),
    targetGzipSha256: targetGzipHash,
    helperScript,
    helperSha256: helpers.map(sha256),
    parseStdin: Buffer.from(candidate35Payload.compressed_business_script),
    parseStdinSha256: targetGzipHash,
    parseScript,
    parseCommand,
    parseCommandSha256: sha256(Buffer.from(parseCommand, "ascii")),
    helperSmokeScript,
    helperSmokeScriptSha256: sha256(helperSmokeScript),
    compressedHelperSmokeScript,
    helperLoader,
    helperCommand,
    helperCommandSha256: sha256(Buffer.from(helperCommand, "ascii")),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
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

export function validateCandidate36ParseOutput(stdout: Buffer, built: Candidate36BuiltPayload) {
  let text: string;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(stdout); }
  catch { throw new Error("M4F_CANDIDATE36_PARSE_STDOUT_INVALID"); }
  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : "";
  const fields = line.split("|");
  if (!line || line.includes("\r") || line.includes("\n") || fields.length !== 8
    || fields[0] !== "r36p" || Number(fields[1]) !== built.targetScriptLength || fields[2] !== "0"
    || fields[3] !== "ScriptBlockAst" || fields[4] !== "True" || fields[5] !== built.targetScriptSha256
    || fields[6] !== built.targetGzipSha256 || fields[7] !== "System.IO.Compression.GZipStream") {
    throw new Error("M4F_CANDIDATE36_PARSE_RESULT_REJECTED");
  }
  return { parse_error_count: 0, ast_type: "ScriptBlockAst", end_block_present: true };
}

export function validateCandidate36HelperOutput(stdout: Buffer) {
  let value: Record<string, unknown> | null = null;
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(stdout);
    if (!text.endsWith("\n") || text.trim().split(/\r?\n/u).length !== 1) throw new Error("shape");
    value = object(JSON.parse(text));
  } catch {
    throw new Error("M4F_CANDIDATE36_HELPER_STDOUT_INVALID");
  }
  const keys = [
    "cim_executed", "cycle_count", "cycle_terminal", "cycle_terminal_pid", "deep_count",
    "deep_terminal", "deep_terminal_pid", "dummy_row", "hash_x", "helper_count", "invalid_count",
    "invalid_terminal", "invalid_terminal_pid", "kill_executed", "micro_ticks", "missing_count",
    "missing_terminal", "missing_terminal_pid", "powershell_edition", "powershell_version", "s",
    "stale_exact", "stdin_length", "target_body_invoked", "target_exact",
  ];
  const dummy = Array.isArray(value?.dummy_row) ? value.dummy_row : [];
  if (!value || Object.keys(value).sort().join("|") !== keys.sort().join("|")
    || value.s !== "r36h" || value.powershell_edition !== "Desktop"
    || typeof value.powershell_version !== "string" || !value.powershell_version.startsWith("5.1.")
    || value.helper_count !== 6
    || value.hash_x !== "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
    || value.micro_ticks !== 639237312001234560
    || dummy.length !== 9 || dummy[0] !== 1 || dummy[1] !== 2 || dummy[2] !== "cmd.exe"
    || dummy[3] !== "2026-08-31T00:00:00.0000000Z" || dummy[4] !== 0
    || dummy[5] !== "C:\\Windows\\System32\\cmd.exe" || dummy[6] !== true || dummy[7] !== 3
    || dummy[8] !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    || value.deep_count !== 12 || value.deep_terminal !== "zero" || value.deep_terminal_pid !== 0
    || value.missing_count !== 0 || value.missing_terminal !== "missing_parent" || value.missing_terminal_pid !== 201
    || value.cycle_count !== 1 || value.cycle_terminal !== "cycle" || value.cycle_terminal_pid !== 300
    || value.invalid_count !== 1 || value.invalid_terminal !== "invalid_edge" || value.invalid_terminal_pid !== 401
    || value.stale_exact !== true || value.target_exact !== true || value.target_body_invoked !== false
    || value.cim_executed !== false || value.kill_executed !== false || value.stdin_length !== 0) {
    throw new Error("M4F_CANDIDATE36_HELPER_RESULT_REJECTED");
  }
  return { helper_count: 6, target_body_invoked: false, cim_executed: false, kill_executed: false };
}

export function validateCandidate36Output(
  parseStdout: Buffer,
  helperStdout: Buffer,
  built: Candidate36BuiltPayload,
) {
  validateCandidate36ParseOutput(parseStdout, built);
  validateCandidate36HelperOutput(helperStdout);
  return {
    schema: "synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-36-result.v1",
    status: "exact_target_parse_zero_and_pure_helpers_smoked",
    target_script_sha256: built.targetScriptSha256,
    target_gzip_sha256: built.targetGzipSha256,
    parse_stdin_length: built.parseStdin.length,
    parse_stdin_sha256: built.parseStdinSha256,
    helper_stdin_length: 0,
    helper_sha256: [...built.helperSha256],
    parse_error_count: 0,
    target_body_invoked: false,
    cim_executed: false,
    kill_executed: false,
    process_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
}

export function planCandidate36(rawConfig: Candidate35Config) {
  const built = buildCandidate36Payload(rawConfig);
  return {
    schema: "synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-36-plan.v1",
    gate_id: CANDIDATE36_ID,
    status: "planned_not_executed",
    target_script_sha256: built.targetScriptSha256,
    target_script_length: built.targetScriptLength,
    target_gzip_sha256: built.targetGzipSha256,
    parse_stdin_length: built.parseStdin.length,
    parse_stdin_sha256: built.parseStdinSha256,
    helper_stdin_length: 0,
    helper_sha256: [...built.helperSha256],
    helper_definition_count: 6,
    parser_call_count: 1,
    remote_probe_count: 2,
    target_body_invoked: false,
    cim_executed: false,
    kill_executed: false,
    process_mutation_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
  };
}

export class Candidate36GateFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE36_GATE_FAILED"));
  }
}

function failGate(code: string, extra: Record<string, unknown> = {}): never {
  throw new Candidate36GateFailure({
    schema: "synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-36-failure.v1",
    code,
    retry_permitted: false,
    target_body_invoked: false,
    cim_executed: false,
    kill_executed: false,
    process_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    ...extra,
  });
}

export function validateCandidate36GateConfig(value: unknown): Candidate36GateConfig {
  const config = object(value);
  const candidate35 = object(config?.candidate35_config);
  const keys = [
    "candidate35_config", "evidence_directory",
    "expected_candidate35_source_sha256", "expected_candidate35_test_sha256", "expected_source_sha256",
    "expected_test_sha256", "expected_transport_source_sha256", "gate_id",
    "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-36-config.v1"
    || config.gate_id !== CANDIDATE36_ID
    || config.evidence_directory !== CANDIDATE36_EVIDENCE_DIRECTORY
    || candidate35?.target_host !== TARGET_HOST
    || [config.expected_candidate35_source_sha256, config.expected_candidate35_test_sha256,
      config.expected_source_sha256, config.expected_test_sha256]
      .some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash))) {
    failGate("M4F_CANDIDATE36_GATE_CONFIG_INVALID");
  }
  validateCandidate35Config(candidate35);
  return value as Candidate36GateConfig;
}

function readExpected(
  dependencies: Candidate36GateDependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    failGate("M4F_CANDIDATE36_GATE_INPUT_MISSING", { path });
  }
  if (sha256(bytes) !== expectedSha256) failGate("M4F_CANDIDATE36_GATE_INPUT_DRIFT", { path });
  return bytes;
}

function loadGateContext(
  rawConfig: unknown,
  dependencies: Candidate36GateDependencies,
) {
  const config = validateCandidate36GateConfig(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, C35_SOURCE_PATH, config.expected_candidate35_source_sha256);
  readExpected(dependencies, C35_TEST_PATH, config.expected_candidate35_test_sha256);
  readExpected(dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256);
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(
    readExpected(dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256).toString("utf8"),
  ));
  if (transport.target.host !== TARGET_HOST
    || transport.target.computer_name !== config.candidate35_config.target_computer
    || transport.target.identity_name !== config.candidate35_config.target_identity_name
    || transport.target.identity_sid !== config.candidate35_config.target_identity_sid
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    failGate("M4F_CANDIDATE36_GATE_TRANSPORT_INVALID");
  }
  return {
    config,
    transport,
    payload: buildCandidate36Payload(config.candidate35_config),
    transportInputs: dependencies.transportInputs(transport, "local_preflight"),
  };
}

export function candidate36Confirmation(rawConfig: unknown, dependencies: Candidate36GateDependencies) {
  const context = loadGateContext(rawConfig, dependencies);
  const plan = planCandidate36(context.config.candidate35_config);
  return [
    "SYNTHIA_M4F_CANDIDATE36_EXACT_PARSE_HELPER_GATE",
    CANDIDATE36_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(plan) + "\n"),
    context.payload.targetScriptSha256,
    context.payload.targetGzipSha256,
    context.payload.parseCommandSha256,
    context.payload.helperCommandSha256,
    TRANSPORT_CONFIG_SHA256,
  ].join(":");
}

function processEvidence(raw: RawProcessResult, stdin: Buffer): Record<string, unknown> {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function write(
  dependencies: Candidate36GateDependencies,
  directory: string,
  name: string,
  value: string | Buffer,
): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    failGate("M4F_CANDIDATE36_GATE_EVIDENCE_WRITE_FAILED", { name });
  }
}

export function executeCandidate36Gate(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate36GateDependencies,
) {
  const context = loadGateContext(rawConfig, dependencies);
  if (confirmation !== candidate36Confirmation(rawConfig, dependencies)) {
    failGate("M4F_CANDIDATE36_GATE_CONFIRMATION_REQUIRED");
  }
  const directory = context.config.evidence_directory;
  try { dependencies.createEvidence(directory); } catch {
    failGate("M4F_CANDIDATE36_GATE_EVIDENCE_CREATE_FAILED");
  }
  const plan = planCandidate36(context.config.candidate35_config);
  write(dependencies, directory, "gate-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, directory, "target-cleanup-script.ps1", context.payload.targetScript);
  write(dependencies, directory, "target-cleanup-script.ps1.gz", context.payload.targetGzip);
  write(dependencies, directory, "parse-loader.ps1", context.payload.parseScript);
  write(dependencies, directory, "helper-smoke.ps1", context.payload.helperSmokeScript);
  write(dependencies, directory, "transport-inputs-initial.json", JSON.stringify(context.transportInputs, null, 2) + "\n");

  const effective = dependencies.spawn(
    SSH_PATH,
    buildDirectSshEffectiveArguments(context.transport),
    Buffer.alloc(0),
    EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, directory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, directory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, directory, "ssh-effective-process.json",
    JSON.stringify(processEvidence(effective, Buffer.alloc(0)), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_CONFIG_SHA256) {
    failGate("M4F_CANDIDATE36_GATE_EFFECTIVE_FAILED");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);

  const pre = dependencies.transportInputs(context.transport, "network");
  write(dependencies, directory, "transport-inputs-pre-remote.json", JSON.stringify(pre, null, 2) + "\n");
  if (canonicalJson(pre) !== canonicalJson(context.transportInputs)
    || confirmation !== candidate36Confirmation(rawConfig, dependencies)) {
    failGate("M4F_CANDIDATE36_GATE_INPUT_DRIFT");
  }

  const parse = dependencies.spawn(
    SSH_PATH,
    [...buildDirectSshOptions(context.transport), TARGET_HOST, context.payload.parseCommand],
    context.payload.parseStdin,
    REMOTE_TIMEOUT_MS,
  );
  write(dependencies, directory, "parse-stdout.raw", parse.stdout);
  write(dependencies, directory, "parse-stderr.raw", parse.stderr);
  write(dependencies, directory, "parse-remote-process.json",
    JSON.stringify(processEvidence(parse, context.payload.parseStdin), null, 2) + "\n");

  const helper = dependencies.spawn(
    SSH_PATH,
    [...buildDirectSshOptions(context.transport), TARGET_HOST, context.payload.helperCommand],
    Buffer.alloc(0),
    REMOTE_TIMEOUT_MS,
  );
  write(dependencies, directory, "helper-stdout.raw", helper.stdout);
  write(dependencies, directory, "helper-stderr.raw", helper.stderr);
  write(dependencies, directory, "helper-remote-process.json",
    JSON.stringify(processEvidence(helper, Buffer.alloc(0)), null, 2) + "\n");

  const post = dependencies.transportInputs(context.transport, "network");
  write(dependencies, directory, "transport-inputs-post-remote.json", JSON.stringify(post, null, 2) + "\n");
  if (canonicalJson(post) !== canonicalJson(context.transportInputs)
    || confirmation !== candidate36Confirmation(rawConfig, dependencies)) {
    failGate("M4F_CANDIDATE36_GATE_POSTFLIGHT_DRIFT");
  }
  if (parse.status !== 0 || parse.signal !== null || parse.errorCode !== null || parse.stderr.length !== 0
    || helper.status !== 0 || helper.signal !== null || helper.errorCode !== null || helper.stderr.length !== 0) {
    failGate("M4F_CANDIDATE36_GATE_REMOTE_FAILED");
  }
  const result = validateCandidate36Output(parse.stdout, helper.stdout, context.payload);
  const record = {
    schema: "synthia-m4f-direct-nine-pid-cleanup-parse-helper-gate-36-record.v1",
    gate_id: CANDIDATE36_ID,
    status: "exact_target_parse_zero_and_pure_helpers_smoked",
    recorded_at_utc: dependencies.now().toISOString(),
    gate_result: result,
    parse_process: processEvidence(parse, context.payload.parseStdin),
    helper_process: processEvidence(helper, Buffer.alloc(0)),
    target_body_invoked: false,
    cim_executed: false,
    kill_executed: false,
    process_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    retry_permitted: false,
  };
  write(dependencies, directory, "gate-record.json", JSON.stringify(record, null, 2) + "\n");
  const manifest = {
    "confirmation.sha256": sha256(confirmation),
    "gate-config.canonical.json": sha256(canonicalJson(context.config) + "\n"),
    "gate-record.json": sha256(JSON.stringify(record, null, 2) + "\n"),
    "helper-remote-process.json": sha256(JSON.stringify(processEvidence(helper, Buffer.alloc(0)), null, 2) + "\n"),
    "helper-smoke.ps1": sha256(context.payload.helperSmokeScript),
    "helper-stderr.raw": sha256(helper.stderr),
    "helper-stdout.raw": sha256(helper.stdout),
    "parse-loader.ps1": sha256(context.payload.parseScript),
    "parse-remote-process.json": sha256(JSON.stringify(processEvidence(parse, context.payload.parseStdin), null, 2) + "\n"),
    "parse-stderr.raw": sha256(parse.stderr),
    "parse-stdout.raw": sha256(parse.stdout),
    "plan.canonical.json": sha256(canonicalJson(plan) + "\n"),
    "ssh-effective-process.json": sha256(JSON.stringify(processEvidence(effective, Buffer.alloc(0)), null, 2) + "\n"),
    "ssh-effective-stderr.raw": sha256(effective.stderr),
    "ssh-effective-stdout.raw": sha256(effective.stdout),
    "target-cleanup-script.ps1": context.payload.targetScriptSha256,
    "target-cleanup-script.ps1.gz": context.payload.targetGzipSha256,
    "transport-inputs-initial.json": sha256(JSON.stringify(context.transportInputs, null, 2) + "\n"),
    "transport-inputs-post-remote.json": sha256(JSON.stringify(post, null, 2) + "\n"),
    "transport-inputs-pre-remote.json": sha256(JSON.stringify(pre, null, 2) + "\n"),
  } as const;
  try {
    dependencies.writeEvidence(CANDIDATE36_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  } catch {
    failGate("M4F_CANDIDATE36_GATE_MANIFEST_WRITE_FAILED");
  }
  return { ...record, manifest_path: CANDIDATE36_MANIFEST_PATH };
}

const systemDependencies: Candidate36GateDependencies = {
  read: (path) => readFileSync(path),
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
  createEvidence(path) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  },
  writeEvidence(path, bytes) {
    const descriptor = openSync(path, "wx", 0o600);
    try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); }
    chmodSync(path, 0o600);
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const config = JSON.parse(readFileSync(args[2]!, "utf8"));
    if (args.length === 3 && args[0] === "--confirm") {
      process.stdout.write(JSON.stringify({
        confirmation: candidate36Confirmation(config, systemDependencies),
      }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate36Gate(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate36GateFailure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE36_GATE_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
