import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
const TARGET_HOST = "100.96.223.49";
const LOCAL_TIMEOUT_MS = 25_000;
const REMOTE_DEADLINE_SECONDS = 15;
const WINDOWS_COMMAND_LIMIT = 8191;
const COMMAND_LENGTH_LIMIT = 6000;
const RESERVED_COMMAND_CHARACTERS = WINDOWS_COMMAND_LIMIT - COMMAND_LENGTH_LIMIT;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OBSERVED_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/u;

export const ENCODED_DIAGNOSTIC_STAGES = [
  "start",
  "native_processes",
  "target_existence",
  "complete",
] as const;

type EncodedStage = typeof ENCODED_DIAGNOSTIC_STAGES[number];

export interface M4fGateRootsEncodedDiagnosticConfig {
  schema: "synthia-m4f-direct-gate-roots-encoded-diagnostic-config.v1";
  diagnostic_id: string;
  gate_id: string;
  admission_config_path: string;
  admission_config_sha256: string;
  candidate09_diagnostic_sha256: string;
  candidate09_started_at_utc: string;
  candidate09_ended_at_utc: string;
  candidate10_remote_process_sha256: string;
  candidate10_started_at_utc: string;
  candidate10_ended_at_utc: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_transport_source_sha256: string;
  expected_effective_config_sha256: string;
}

export interface EncodedDiagnosticDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  testSourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  admissionConfigBytes(path: string): Buffer;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): LocalInputFact[];
  now(): Date;
}

export interface EncodedMarker {
  schema: "synthia-m4f-direct-gate-roots-encoded-marker.v1";
  diagnostic_id: string;
  ordinal: number;
  stage: EncodedStage;
  phase: "start" | "begin" | "end" | "complete";
  status: "started" | "observed" | "unknown" | "complete";
  payload: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface EncodedDiagnosticResult {
  process: RawProcessResult;
  markers: EncodedMarker[];
  status: "observed" | "partial_unknown";
  stdin_length: 0;
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
}

const CONFIG_KEYS = [
  "admission_config_path", "admission_config_sha256", "candidate09_diagnostic_sha256",
  "candidate09_ended_at_utc", "candidate09_started_at_utc", "candidate10_ended_at_utc",
  "candidate10_remote_process_sha256", "candidate10_started_at_utc", "diagnostic_id",
  "expected_effective_config_sha256", "expected_source_sha256", "expected_test_source_sha256",
  "expected_transport_source_sha256", "gate_id", "schema",
] as const;
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
  return typeof value === "string" && CANONICAL_UTC.test(value) && new Date(value).toISOString() === value;
}

function safePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validObservedUtc(value: unknown): value is string {
  return typeof value === "string" && OBSERVED_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

export function validateEncodedDiagnosticConfig(value: unknown): M4fGateRootsEncodedDiagnosticConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-gate-roots-encoded-diagnostic-config.v1"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || typeof config.gate_id !== "string" || !SAFE_ID.test(config.gate_id)
    || typeof config.admission_config_path !== "string" || !config.admission_config_path.startsWith("/")
    || /[\r\n\0]/u.test(config.admission_config_path)
    || !validUtc(config.candidate09_started_at_utc) || !validUtc(config.candidate09_ended_at_utc)
    || !validUtc(config.candidate10_started_at_utc) || !validUtc(config.candidate10_ended_at_utc)
    || config.candidate09_started_at_utc >= config.candidate09_ended_at_utc
    || config.candidate10_started_at_utc >= config.candidate10_ended_at_utc
    || [
      config.admission_config_sha256, config.candidate09_diagnostic_sha256,
      config.candidate10_remote_process_sha256, config.expected_source_sha256,
      config.expected_test_source_sha256, config.expected_transport_source_sha256,
      config.expected_effective_config_sha256,
    ].some((item) => typeof item !== "string" || !HASH.test(item))) {
    throw new Error("M4F_GATE_ROOTS_ENCODED_CONFIG_INVALID");
  }
  return value as M4fGateRootsEncodedDiagnosticConfig;
}

export function buildEncodedDiagnosticScript(rawConfig: unknown): string {
  const config = validateEncodedDiagnosticConfig(rawConfig);
  const gateRoot = "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id;
  const backingRoot = "D:\\synthia-m4f-toolchain-" + config.gate_id;
  const start = JSON.stringify({
    schema: "synthia-m4f-direct-gate-roots-encoded-marker.v1",
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
    "$ErrorActionPreference=\"Stop\";$ProgressPreference=\"SilentlyContinue\";$d=[DateTime]::UtcNow.AddSeconds(" + REMOTE_DEADLINE_SECONDS + ");$o=1;$id=" + psLiteral(config.diagnostic_id),
    "$g=" + psLiteral(gateRoot) + ";$b=" + psLiteral(backingRoot) + ";$a=[DateTimeOffset]::Parse(" + psLiteral(config.candidate09_started_at_utc) + ").UtcDateTime;$z=[DateTimeOffset]::Parse(" + psLiteral(config.candidate09_ended_at_utc) + ").UtcDateTime;$c=[DateTimeOffset]::Parse(" + psLiteral(config.candidate10_started_at_utc) + ").UtcDateTime;$x=[DateTimeOffset]::Parse(" + psLiteral(config.candidate10_ended_at_utc) + ").UtcDateTime",
    "function E($n,$p,$s,$v,$e){$script:o++;$m=[ordered]@{schema=\"synthia-m4f-direct-gate-roots-encoded-marker.v1\";diagnostic_id=$id;ordinal=$script:o;stage=$n;phase=$p;status=$s;payload=$v;error=$e};[Console]::Out.WriteLine(($m|ConvertTo-Json -Compress -Depth 8));[Console]::Out.Flush()}",
    "function S($n,$q){E $n begin started @{} $null;if([DateTime]::UtcNow-ge$d){E $n end unknown $null @{code=\"DEADLINE\"};return};try{E $n end observed (&$q) $null}catch{E $n end unknown $null @{type=$_.Exception.GetType().FullName}}}",
    "S \"native_processes\" {$r=@(Get-Process powershell,sshd,conhost -EA SilentlyContinue|? Id -ne $PID|%{$t=$null;try{$t=$_.StartTime.ToUniversalTime()}catch{};[ordered]@{pid=[int]$_.Id;name=$_.ProcessName.ToLowerInvariant();start_token=if($t){$t.ToString(\"o\")};candidate09_window=[bool]($t-and$t-ge$a-and$t-le$z);candidate10_window=[bool]($t-and$t-ge$c-and$t-le$x)}}|sort pid);[ordered]@{current_pid=[int]$PID;command_line_returned=$false;rows=$r}}",
    "S \"target_existence\" {[ordered]@{gate_path=$g;gate_exists=[bool](Test-Path -LiteralPath $g);backing_path=$b;backing_exists=[bool](Test-Path -LiteralPath $b)}}",
    "E \"complete\" complete complete @{remote_deadline=\"cooperative_15_seconds\";stdin_length=0;process_mutation_performed=$false;file_mutation_performed=$false;acl_mutation_performed=$false;service_mutation_performed=$false;vivado_action_performed=$false;hardware_action_performed=$false} $null",
    "",
  ].join("\n");
}

export function buildEncodedDiagnosticCommand(rawConfig: unknown): string {
  const script = buildEncodedDiagnosticScript(rawConfig);
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(script, "utf16le").toString("base64");
  if (command.length > COMMAND_LENGTH_LIMIT) throw new Error("M4F_GATE_ROOTS_ENCODED_COMMAND_TOO_LONG");
  return command;
}

export function encodedDiagnosticConfigSha256(rawConfig: unknown): string {
  return sha256(Buffer.from(canonicalJson(validateEncodedDiagnosticConfig(rawConfig)) + "\n"));
}

export function encodedDiagnosticPlan(rawConfig: unknown, rawAdmission: unknown): Record<string, unknown> {
  const config = validateEncodedDiagnosticConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  const script = Buffer.from(buildEncodedDiagnosticScript(config), "utf8");
  const command = buildEncodedDiagnosticCommand(config);
  return {
    schema: "synthia-m4f-direct-gate-roots-encoded-diagnostic-plan.v1",
    diagnostic_id: config.diagnostic_id,
    gate_id: config.gate_id,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    stages: [...ENCODED_DIAGNOSTIC_STAGES],
    attempt_count: 1,
    retry_permitted: false,
    local_timeout_ms: LOCAL_TIMEOUT_MS,
    local_timeout_kill_signal: "SIGKILL",
    remote_cooperative_deadline_seconds: REMOTE_DEADLINE_SECONDS,
    stdin_length: 0,
    remote_script_length: script.length,
    remote_script_sha256: sha256(script),
    remote_command_length: command.length,
    remote_command_length_limit: COMMAND_LENGTH_LIMIT,
    windows_command_limit: WINDOWS_COMMAND_LIMIT,
    reserved_command_characters: RESERVED_COMMAND_CHARACTERS,
    first_remote_action: "write_and_flush_start_marker",
    forbidden_wrappers: ["Console.In.ReadToEnd", "ScriptBlock.Create", "gzip"],
    target_host: admission.target.host,
    target_user: admission.target.user,
    network_attempted: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
  };
}

export function encodedDiagnosticPlanSha256(rawConfig: unknown, rawAdmission: unknown): string {
  return sha256(Buffer.from(canonicalJson(encodedDiagnosticPlan(rawConfig, rawAdmission)) + "\n"));
}

export function encodedDiagnosticConfirmation(rawConfig: unknown, rawAdmission: unknown): string {
  const config = validateEncodedDiagnosticConfig(rawConfig);
  return [
    "SYNTHIA_M4F_DIRECT_GATE_ROOTS_ENCODED_READ_ONLY",
    config.diagnostic_id,
    encodedDiagnosticConfigSha256(config),
    encodedDiagnosticPlanSha256(config, rawAdmission),
    config.expected_source_sha256,
    config.expected_test_source_sha256,
  ].join(":");
}

function validObservedPayload(
  stage: EncodedStage,
  value: unknown,
  config: M4fGateRootsEncodedDiagnosticConfig,
): boolean {
  const payload = object(value);
  if (!payload) return false;
  if (stage === "start") {
    return exactKeys(payload, ["direct_encoded_entry"]) && payload.direct_encoded_entry === true;
  }
  if (stage === "native_processes") {
    if (!exactKeys(payload, ["command_line_returned", "current_pid", "rows"])
      || payload.command_line_returned !== false || !safePid(payload.current_pid)
      || !Array.isArray(payload.rows) || payload.rows.length > 512) return false;
    const pids = new Set<number>();
    for (const item of payload.rows) {
      const row = object(item);
      if (!row || !exactKeys(row, [
        "candidate09_window", "candidate10_window", "name", "pid", "start_token",
      ]) || !safePid(row.pid) || pids.has(row.pid) || row.pid === payload.current_pid
        || !["powershell", "sshd", "conhost"].includes(String(row.name))
        || (row.start_token !== null && !validObservedUtc(row.start_token))
        || typeof row.candidate09_window !== "boolean"
        || typeof row.candidate10_window !== "boolean") return false;
      const startMs = row.start_token === null ? null : Date.parse(String(row.start_token));
      const expected09 = startMs !== null
        && startMs >= Date.parse(config.candidate09_started_at_utc)
        && startMs <= Date.parse(config.candidate09_ended_at_utc);
      const expected10 = startMs !== null
        && startMs >= Date.parse(config.candidate10_started_at_utc)
        && startMs <= Date.parse(config.candidate10_ended_at_utc);
      if (row.candidate09_window !== expected09 || row.candidate10_window !== expected10) return false;
      pids.add(row.pid);
    }
    return true;
  }
  if (stage === "target_existence") {
    return exactKeys(payload, ["backing_exists", "backing_path", "gate_exists", "gate_path"])
      && payload.gate_path === "C:\\Windows\\Temp\\synthia-m4f-" + config.gate_id
      && payload.backing_path === "D:\\synthia-m4f-toolchain-" + config.gate_id
      && typeof payload.gate_exists === "boolean" && typeof payload.backing_exists === "boolean";
  }
  if (stage === "complete") {
    return exactKeys(payload, [
      "acl_mutation_performed", "file_mutation_performed", "hardware_action_performed",
      "process_mutation_performed", "remote_deadline", "service_mutation_performed",
      "stdin_length", "vivado_action_performed",
    ]) && payload.remote_deadline === "cooperative_15_seconds" && payload.stdin_length === 0
      && payload.process_mutation_performed === false && payload.file_mutation_performed === false
      && payload.acl_mutation_performed === false && payload.service_mutation_performed === false
      && payload.vivado_action_performed === false && payload.hardware_action_performed === false;
  }
  return false;
}

function validUnknownError(value: unknown): boolean {
  const error = object(value);
  return !!error && (exactKeys(error, ["code"]) && error.code === "DEADLINE"
    || exactKeys(error, ["type"]) && typeof error.type === "string"
      && error.type.length > 0 && error.type.length <= 256);
}

export function parseEncodedMarkers(bytes: Buffer, rawConfig: unknown): EncodedMarker[] {
  const config = validateEncodedDiagnosticConfig(rawConfig);
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  const lines = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, lastNewline + 1)).split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const markers: EncodedMarker[] = [];
  const expected = [
    ["start", "start", "observed"],
    ["native_processes", "begin", "started"],
    ["native_processes", "end", null],
    ["target_existence", "begin", "started"],
    ["target_existence", "end", null],
    ["complete", "complete", "complete"],
  ] as const;
  for (const line of lines) {
    let marker: Record<string, unknown> | null = null;
    try { marker = object(JSON.parse(line)); } catch { /* invalid below */ }
    const rule = expected[markers.length];
    if (!marker || !rule || !exactKeys(marker, MARKER_KEYS)
      || marker.schema !== "synthia-m4f-direct-gate-roots-encoded-marker.v1"
      || marker.diagnostic_id !== config.diagnostic_id || marker.ordinal !== markers.length + 1
      || marker.stage !== rule[0] || marker.phase !== rule[1]
      || (rule[2] === null
        ? marker.status !== "observed" && marker.status !== "unknown"
        : marker.status !== rule[2])) {
      throw new Error("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    }
    if (marker.phase === "begin") {
      if (!object(marker.payload) || !exactKeys(marker.payload as Record<string, unknown>, [])
        || marker.error !== null) throw new Error("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    } else if (marker.status === "unknown") {
      if (marker.payload !== null || !validUnknownError(marker.error)) {
        throw new Error("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
      }
    } else if (marker.error !== null || !validObservedPayload(marker.stage as EncodedStage, marker.payload, config)) {
      throw new Error("M4F_GATE_ROOTS_ENCODED_MARKER_INVALID");
    }
    markers.push(marker as unknown as EncodedMarker);
  }
  return markers;
}

function validateSources(config: M4fGateRootsEncodedDiagnosticConfig, dependencies: EncodedDiagnosticDependencies): void {
  if (sha256(dependencies.sourceBytes()) !== config.expected_source_sha256
    || sha256(dependencies.testSourceBytes()) !== config.expected_test_source_sha256
    || sha256(dependencies.transportSourceBytes()) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_GATE_ROOTS_ENCODED_SOURCE_MISMATCH");
  }
}

export function executeEncodedDiagnostic(
  rawConfig: unknown,
  rawAdmission: unknown,
  confirmation: string,
  dependencies: EncodedDiagnosticDependencies,
): EncodedDiagnosticResult {
  const config = validateEncodedDiagnosticConfig(rawConfig);
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  if (confirmation !== encodedDiagnosticConfirmation(config, admission)) throw new Error("M4F_GATE_ROOTS_ENCODED_CONFIRMATION_REQUIRED");
  validateSources(config, dependencies);
  const inputs = dependencies.transportInputs(admission, "local_preflight");
  const effective = dependencies.spawn(SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), 15_000);
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) throw new Error("M4F_GATE_ROOTS_ENCODED_EFFECTIVE_CONFIG_FAILED");
  auditDirectSshEffectiveConfig(effective.stdout, admission);
  if (sha256(effective.stdout) !== config.expected_effective_config_sha256) throw new Error("M4F_GATE_ROOTS_ENCODED_EFFECTIVE_CONFIG_MISMATCH");
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) throw new Error("M4F_GATE_ROOTS_ENCODED_TRANSPORT_INPUT_DRIFT");
  const raw = dependencies.spawn(
    SSH_PATH,
    [...buildDirectSshOptions(admission), TARGET_HOST, buildEncodedDiagnosticCommand(config)],
    Buffer.alloc(0),
    LOCAL_TIMEOUT_MS,
  );
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) throw new Error("M4F_GATE_ROOTS_ENCODED_TRANSPORT_INPUT_DRIFT");
  const lastNewline = raw.stdout.lastIndexOf(0x0a);
  const trailingFragment = lastNewline < 0 ? raw.stdout : raw.stdout.subarray(lastNewline + 1);
  const markers = parseEncodedMarkers(raw.stdout, config);
  const allObserved = markers.length === 6 && markers.every((marker) => marker.status !== "unknown");
  const processOk = raw.status === 0 && raw.signal === null && raw.errorCode === null && raw.stderr.length === 0;
  return {
    process: raw,
    markers,
    status: allObserved && processOk && trailingFragment.length === 0 ? "observed" : "partial_unknown",
    stdin_length: 0,
    trailing_fragment_length: trailingFragment.length,
    trailing_fragment_sha256: sha256(trailingFragment),
  };
}

function writeEvidence(directory: string, name: string, content: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
  chmodSync(directory + "/" + name, 0o600);
}

export function recordEncodedDiagnostic(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: EncodedDiagnosticDependencies,
): EncodedDiagnosticResult {
  const config = validateEncodedDiagnosticConfig(rawConfig);
  const admissionBytes = dependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) throw new Error("M4F_GATE_ROOTS_ENCODED_ADMISSION_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  if (confirmation !== encodedDiagnosticConfirmation(config, admission)) throw new Error("M4F_GATE_ROOTS_ENCODED_CONFIRMATION_REQUIRED");
  validateSources(config, dependencies);
  const absolute = resolve(evidenceDirectory);
  try { mkdirSync(absolute, { mode: 0o700, recursive: false }); chmodSync(absolute, 0o700); } catch { throw new Error("M4F_GATE_ROOTS_ENCODED_EVIDENCE_DIRECTORY_INVALID"); }
  const startedAt = dependencies.now();
  let attemptCount = 0;
  let transportCaptureCount = 0;
  const command = buildEncodedDiagnosticCommand(config);
  writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
  writeEvidence(absolute, "admission-config.raw.json", admissionBytes);
  writeEvidence(absolute, "remote-script.ps1", buildEncodedDiagnosticScript(config));
  writeEvidence(absolute, "remote-command.json", JSON.stringify({
    schema: "synthia-m4f-direct-gate-roots-encoded-command.v1",
    command_length: command.length,
    command_sha256: sha256(Buffer.from(command, "ascii")),
    stdin_length: 0,
    attempt_count: 1,
  }, null, 2) + "\n");
  const wrapped: EncodedDiagnosticDependencies = {
    ...dependencies,
    spawn(executable, args, stdin, timeoutMs) {
      const processStartedAt = dependencies.now();
      const label = args[0] === "-G" ? "ssh-effective" : "remote";
      if (label === "remote") attemptCount += 1;
      const result = dependencies.spawn(executable, args, stdin, timeoutMs);
      const processEndedAt = dependencies.now();
      writeEvidence(absolute, label + "-stdout.raw", result.stdout);
      writeEvidence(absolute, label + "-stderr.raw", result.stderr);
      writeEvidence(absolute, label + "-process.json", JSON.stringify({
        attempt_count: label === "remote" ? attemptCount : 0,
        started_at_utc: processStartedAt.toISOString(),
        ended_at_utc: processEndedAt.toISOString(),
        exit_status: result.status, signal: result.signal, error_code: result.errorCode,
        timed_out: result.errorCode === "ETIMEDOUT", stdin_length: stdin.length,
        stdin_sha256: sha256(stdin), stdout_length: result.stdout.length,
        stdout_sha256: sha256(result.stdout), stderr_length: result.stderr.length,
        stderr_sha256: sha256(result.stderr), retry_permitted: false,
      }, null, 2) + "\n");
      return result;
    },
    transportInputs(admissionConfig, stage) {
      const facts = dependencies.transportInputs(admissionConfig, stage);
      const label = ["initial", "pre_remote", "post_remote"][transportCaptureCount];
      if (!label) throw new Error("M4F_GATE_ROOTS_ENCODED_TRANSPORT_CAPTURE_OVERFLOW");
      transportCaptureCount += 1;
      writeEvidence(absolute, "transport-inputs-" + label + ".json", JSON.stringify(facts, null, 2) + "\n");
      return facts;
    },
  };
  try {
    const result = executeEncodedDiagnostic(config, admission, confirmation, wrapped);
    const endedAt = dependencies.now();
    writeEvidence(absolute, "markers.json", JSON.stringify(result.markers, null, 2) + "\n");
    writeEvidence(absolute, "result.json", JSON.stringify({
      schema: "synthia-m4f-direct-gate-roots-encoded-result.v1",
      diagnostic_id: config.diagnostic_id, gate_id: config.gate_id, status: result.status,
      attempt_count: attemptCount, started_at_utc: startedAt.toISOString(), ended_at_utc: endedAt.toISOString(),
      marker_count: result.markers.length, stdin_length: 0, retry_permitted: false,
      trailing_fragment_length: result.trailing_fragment_length,
      trailing_fragment_sha256: result.trailing_fragment_sha256,
    }, null, 2) + "\n");
    return result;
  } catch (error) {
    try { writeEvidence(absolute, "failure.json", JSON.stringify({
      schema: "synthia-m4f-direct-gate-roots-encoded-failure.v1",
      error: error instanceof Error ? error.message : "UNKNOWN",
      attempt_count: attemptCount, started_at_utc: startedAt.toISOString(),
      ended_at_utc: dependencies.now().toISOString(), stdin_length: 0, retry_permitted: false,
    }, null, 2) + "\n"); } catch { /* preserve primary error */ }
    throw error;
  }
}

const systemDependencies: EncodedDiagnosticDependencies = {
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
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  testSourceBytes: () => readFileSync(new URL("../m4f-direct-gate-roots-encoded-diagnostic.test.ts", import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
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
  const config = validateEncodedDiagnosticConfig(JSON.parse(readFileSync(args[2]!, "utf8")));
  if (executing) {
    const result = recordEncodedDiagnostic(config, args[4]!, args[6]!, systemDependencies);
    process.stdout.write(JSON.stringify({ diagnostic_id: config.diagnostic_id, status: result.status, marker_count: result.markers.length, retry_permitted: false }) + "\n");
    return;
  }
  validateSources(config, systemDependencies);
  const admissionBytes = systemDependencies.admissionConfigBytes(config.admission_config_path);
  if (sha256(admissionBytes) !== config.admission_config_sha256) throw new Error("M4F_GATE_ROOTS_ENCODED_ADMISSION_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  process.stdout.write(JSON.stringify({
    ...encodedDiagnosticPlan(config, admission),
    config_sha256: encodedDiagnosticConfigSha256(config),
    plan_sha256: encodedDiagnosticPlanSha256(config, admission),
    confirmation: encodedDiagnosticConfirmation(config, admission),
  }) + "\n");
}

if (import.meta.main) main();
