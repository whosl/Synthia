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
  buildAdmissionV2Script,
  validateAdmissionV2Config,
  type M4fDirectAdmissionV2Config,
} from "./m4f-direct-admission-v2.ts";
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
const TIMEOUT_MS = 30_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
const WINDOWS_CMD_LIMIT = 8191;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RETIRED_PARSE_IDS = new Set([
  "m4f-direct-admission-v2-parse-prod-20260828-01",
]);

export interface AdmissionV2ParseOnlyConfig {
  schema: "synthia-m4f-direct-admission-v2-parse-only-config.v1";
  parse_id: string;
  admission_v2_config_path: string;
  admission_v2_config_sha256: string;
  expected_source_sha256: string;
  expected_admission_v2_source_sha256: string;
  expected_transport_source_sha256: string;
}

export interface AdmissionV2ParseOnlyDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  admissionSourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  now(): Date;
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

interface BoundFile {
  bytes: Buffer;
  fact: BoundFileFact;
}

export class AdmissionV2ParseOnlyFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_FAILED"));
  }
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

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new AdmissionV2ParseOnlyFailure({
    schema: "synthia-m4f-direct-admission-v2-parse-only-failure.v1",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight" ? "not_started" : "read_only_unknown",
    retry_permitted: false,
    ...extra,
  });
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

export function validateAdmissionV2ParseOnlyConfig(value: unknown): AdmissionV2ParseOnlyConfig {
  const config = object(value);
  const keys = [
    "admission_v2_config_path", "admission_v2_config_sha256",
    "expected_admission_v2_source_sha256", "expected_source_sha256",
    "expected_transport_source_sha256", "parse_id", "schema",
  ];
  if (!config || !exactKeys(config, keys)
    || config.schema !== "synthia-m4f-direct-admission-v2-parse-only-config.v1"
    || typeof config.parse_id !== "string" || !SAFE_ID.test(config.parse_id)
    || RETIRED_PARSE_IDS.has(config.parse_id)
    || !safePath(config.admission_v2_config_path)
    || typeof config.admission_v2_config_sha256 !== "string" || !HASH.test(config.admission_v2_config_sha256)
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_admission_v2_source_sha256 !== "string"
    || !HASH.test(config.expected_admission_v2_source_sha256)
    || typeof config.expected_transport_source_sha256 !== "string"
    || !HASH.test(config.expected_transport_source_sha256)) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_CONFIG_INVALID", "config");
  }
  return value as AdmissionV2ParseOnlyConfig;
}

function readExact(path: string, expectedHash: string): BoundFile {
  let fd: number | null = null;
  try {
    const pathBefore = lstatSync(path);
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (pathBefore.isSymbolicLink() || !before.isFile() || before.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
      || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.length < 1 || bytes.length > MAX_BYTES || sha256(bytes) !== expectedHash) {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_INPUT_UNTRUSTED", "local_preflight");
    }
    return {
      bytes,
      fact: {
        path,
        device: after.dev,
        inode: after.ino,
        owner_uid: after.uid,
        mode: 0o600,
        link_count: 1,
        size: after.size,
        mtime_ms: after.mtimeMs,
        ctime_ms: after.ctimeMs,
        sha256: expectedHash,
      },
    };
  } catch (error) {
    if (error instanceof AdmissionV2ParseOnlyFailure) throw error;
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_INPUT_UNAVAILABLE", "local_preflight");
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_INPUT_UNAVAILABLE", "local_preflight");
}

function loadInputs(config: AdmissionV2ParseOnlyConfig): {
  wrapper: M4fDirectAdmissionV2Config;
  admission: M4fDirectAdmissionConfig;
  wrapperFact: BoundFileFact;
  admissionFact: BoundFileFact;
} {
  const wrapperFile = readExact(config.admission_v2_config_path, config.admission_v2_config_sha256);
  const wrapper = validateAdmissionV2Config(JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(wrapperFile.bytes)));
  if (wrapper.expected_source_sha256 !== config.expected_admission_v2_source_sha256
    || wrapper.expected_transport_source_sha256 !== config.expected_transport_source_sha256) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_CHAIN_MISMATCH", "local_preflight");
  }
  const admissionFile = readExact(wrapper.admission_config_path, wrapper.admission_config_sha256);
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(admissionFile.bytes)));
  if (admission.target.host !== TARGET_HOST || admission.target.expected_effective_config_sha256 === null) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_TARGET_INVALID", "local_preflight");
  }
  return {
    wrapper,
    admission,
    wrapperFact: wrapperFile.fact,
    admissionFact: admissionFile.fact,
  };
}

function validateSources(config: AdmissionV2ParseOnlyConfig, dependencies: AdmissionV2ParseOnlyDependencies): void {
  for (const [bytes, expected] of [
    [dependencies.sourceBytes(), config.expected_source_sha256],
    [dependencies.admissionSourceBytes(), config.expected_admission_v2_source_sha256],
    [dependencies.transportSourceBytes(), config.expected_transport_source_sha256],
  ] as Array<[Buffer, string]>) {
    if (bytes.length < 1 || bytes.length > MAX_BYTES || sha256(bytes) !== expected) {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_SOURCE_MISMATCH", "local_preflight");
    }
  }
}

export function buildAdmissionV2ParseOnlyCommand(source: string): {
  compressed: Buffer;
  loader: string;
  command: string;
} {
  const compressed = gzipSync(Buffer.from(source, "utf8"), { level: 9 });
  const payload = compressed.toString("base64");
  const loader = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
    + "$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('"
    + payload + "')),[IO.Compression.CompressionMode]0);"
    + "$s=[IO.StreamReader]::new($g).ReadToEnd();$t=$null;$e=$null;"
    + "$a=[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);"
    + "$b=$null;if($e.Count-eq 0){$b=[ScriptBlock]::Create($s)};"
    + "$h=([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))-replace'-','').ToLower();"
    + "$x=[ordered]@{schema='synthia-m4f-direct-admission-v2-parse-only-result.v1';status=$(if($e.Count){'parse_rejected'}else{'parsed_not_invoked'});source_sha256=$h;source_length=[Text.Encoding]::UTF8.GetByteCount($s);parse_error_count=$e.Count;parser_ast_type=$a.GetType().FullName;constructed_ast_type=$(if($b){$b.Ast.GetType().FullName}else{$null});powershell_edition=$PSVersionTable.PSEdition;powershell_version=$PSVersionTable.PSVersion.ToString();target_body_not_invoked=$true;hardware_action_performed=$false;process_termination_performed=$false};"
    + "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$x|ConvertTo-Json -Compress;if($e.Count){exit 2}";
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"&{"
    + loader + "}\"";
  if (command.length > WINDOWS_CMD_LIMIT) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_COMMAND_TOO_LONG", "local_preflight", {
      command_length: command.length,
    });
  }
  return { compressed, loader, command };
}

function parseResult(bytes: Buffer, expectedHash: string, expectedLength: number): Record<string, unknown> {
  let value: Record<string, unknown> | null = null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    value = object(JSON.parse(text));
  } catch {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_OUTPUT_INVALID", "output_validation");
  }
  const keys = [
    "constructed_ast_type", "hardware_action_performed", "parse_error_count", "parser_ast_type",
    "powershell_edition", "powershell_version", "process_termination_performed", "schema",
    "source_length", "source_sha256", "status", "target_body_not_invoked",
  ];
  if (!value || !exactKeys(value, keys)
    || value.schema !== "synthia-m4f-direct-admission-v2-parse-only-result.v1"
    || (value.status !== "parsed_not_invoked" && value.status !== "parse_rejected")
    || value.source_sha256 !== expectedHash || value.source_length !== expectedLength
    || value.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || value.powershell_edition !== "Desktop"
    || typeof value.powershell_version !== "string" || !String(value.powershell_version).startsWith("5.1.")
    || value.target_body_not_invoked !== true || value.hardware_action_performed !== false
    || value.process_termination_performed !== false) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_OUTPUT_INVALID", "output_validation");
  }
  if (value.status === "parsed_not_invoked"
    ? value.parse_error_count !== 0
      || value.constructed_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    : !Number.isSafeInteger(value.parse_error_count) || Number(value.parse_error_count) < 1
      || value.constructed_ast_type !== null) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_OUTPUT_INVALID", "output_validation");
  }
  return value;
}

function processEvidence(raw: RawProcessResult): Record<string, unknown> {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT",
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function writeEvidence(directory: string, name: string, value: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  chmodSync(directory + "/" + name, 0o600);
}

export function admissionV2ParseOnlyConfirmation(rawConfig: unknown): string {
  const config = validateAdmissionV2ParseOnlyConfig(rawConfig);
  return "SYNTHIA_M4F_DIRECT_ADMISSION_V2_WINDOWS_PARSE_ONLY:"
    + config.parse_id + ":" + sha256(canonicalJson(config) + "\n");
}

export function planAdmissionV2ParseOnly(
  rawConfig: unknown,
  dependencies: AdmissionV2ParseOnlyDependencies = systemDependencies,
): Record<string, unknown> {
  const config = validateAdmissionV2ParseOnlyConfig(rawConfig);
  validateSources(config, dependencies);
  const { wrapper, admission, wrapperFact, admissionFact } = loadInputs(config);
  const source = buildAdmissionV2Script(admission);
  const packed = buildAdmissionV2ParseOnlyCommand(source);
  return {
    schema: "synthia-m4f-direct-admission-v2-parse-only-plan.v1",
    status: "planned_not_executed",
    parse_id: config.parse_id,
    admission_id: wrapper.admission_id,
    target_host: admission.target.host,
    target_computer: admission.target.computer_name,
    source_length: Buffer.byteLength(source, "utf8"),
    source_sha256: sha256(source),
    gate_source_sha256: config.expected_source_sha256,
    admission_v2_source_sha256: config.expected_admission_v2_source_sha256,
    transport_source_sha256: config.expected_transport_source_sha256,
    admission_v2_config_fact: wrapperFact,
    base_admission_config_fact: admissionFact,
    compressed_length: packed.compressed.length,
    compressed_sha256: sha256(packed.compressed),
    loader_sha256: sha256(packed.loader),
    command_length: packed.command.length,
    command_sha256: sha256(packed.command),
    timeout_ms: TIMEOUT_MS,
    confirmation: admissionV2ParseOnlyConfirmation(config),
    target_body_not_invoked: true,
    network_attempted: false,
    hardware_action_performed: false,
    process_termination_performed: false,
  };
}

export function executeAdmissionV2ParseOnly(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: AdmissionV2ParseOnlyDependencies = systemDependencies,
): Record<string, unknown> {
  const config = validateAdmissionV2ParseOnlyConfig(rawConfig);
  if (confirmation !== admissionV2ParseOnlyConfirmation(config)) {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_CONFIRMATION_REQUIRED", "local_preflight");
  }
  validateSources(config, dependencies);
  const before = loadInputs(config);
  const { wrapper, admission } = before;
  const source = buildAdmissionV2Script(admission);
  const sourceHash = sha256(source);
  const sourceLength = Buffer.byteLength(source, "utf8");
  const packed = buildAdmissionV2ParseOnlyCommand(source);
  const inputsBefore = captureM4fDirectTransportInputs(admission);
  const absolute = resolve(evidenceDirectory);
  try {
    mkdirSync(absolute, { mode: 0o700, recursive: false });
    chmodSync(absolute, 0o700);
  } catch {
    fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_EVIDENCE_INVALID", "local_preflight");
  }
  let remote: RawProcessResult | null = null;
  let effectiveProcess: Record<string, unknown> | null = null;
  let effectiveConfigSha256: string | null = null;
  let transportInputsAfter: ReturnType<typeof captureM4fDirectTransportInputs> | null = null;
  let wrapperConfigAfter: BoundFileFact | null = null;
  let baseAdmissionConfigAfter: BoundFileFact | null = null;
  try {
    writeEvidence(absolute, "parse-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "target-source.ps1", source);
    writeEvidence(absolute, "parse-loader.ps1", packed.loader);
    const effective = dependencies.spawn(
      SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(absolute, "ssh-effective.stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective.stderr.raw", effective.stderr);
    effectiveProcess = processEvidence(effective);
    effectiveConfigSha256 = sha256(effective.stdout);
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(effectiveProcess, null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0
      || effectiveConfigSha256 !== admission.target.expected_effective_config_sha256) {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_EFFECTIVE_FAILED", "local_preflight");
    }
    auditDirectSshEffectiveConfig(effective.stdout, admission);
    validateSources(config, dependencies);
    const current = loadInputs(config);
    const inputsCurrent = captureM4fDirectTransportInputs(admission, "network");
    if (canonicalJson(before.wrapperFact) !== canonicalJson(current.wrapperFact)
      || canonicalJson(before.admissionFact) !== canonicalJson(current.admissionFact)
      || canonicalJson(inputsBefore) !== canonicalJson(inputsCurrent)) {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_INPUT_DRIFT", "network");
    }
    remote = dependencies.spawn(
      SSH_PATH, [...buildDirectSshOptions(admission), TARGET_HOST, packed.command], Buffer.alloc(0), TIMEOUT_MS,
    );
    writeEvidence(absolute, "stdout.raw", remote.stdout);
    writeEvidence(absolute, "stderr.raw", remote.stderr);
    writeEvidence(absolute, "remote-process.json", JSON.stringify(processEvidence(remote), null, 2) + "\n");
    validateSources(config, dependencies);
    const after = loadInputs(config);
    wrapperConfigAfter = after.wrapperFact;
    baseAdmissionConfigAfter = after.admissionFact;
    const inputsAfter = captureM4fDirectTransportInputs(admission, "network");
    transportInputsAfter = inputsAfter;
    if (canonicalJson(before.wrapperFact) !== canonicalJson(after.wrapperFact)
      || canonicalJson(before.admissionFact) !== canonicalJson(after.admissionFact)
      || canonicalJson(inputsBefore) !== canonicalJson(inputsAfter)) {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_INPUT_DRIFT", "network");
    }
    if (remote.signal !== null || remote.errorCode !== null || remote.stderr.length !== 0
      || (remote.status !== 0 && remote.status !== 2)) {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_TRANSPORT_FAILED", "network");
    }
    const result = parseResult(remote.stdout, sourceHash, sourceLength);
    if (remote.status === 2 && result.status === "parse_rejected") {
      fail("M4F_DIRECT_ADMISSION_V2_TARGET_PARSE_REJECTED", "output_validation", {
        remote_effect_state: "read_only_observed",
        parse_result: result,
      });
    }
    if (remote.status !== 0 || result.status !== "parsed_not_invoked") {
      fail("M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_OUTPUT_INVALID", "output_validation");
    }
    const record = {
      schema: "synthia-m4f-direct-admission-v2-parse-only-record.v1",
      status: "parsed_not_invoked",
      parse_id: config.parse_id,
      admission_id: wrapper.admission_id,
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(canonicalJson(config) + "\n"),
      gate_source_sha256: config.expected_source_sha256,
      admission_v2_source_sha256: config.expected_admission_v2_source_sha256,
      transport_source_sha256: config.expected_transport_source_sha256,
      source_sha256: sourceHash,
      source_length: sourceLength,
      compressed_sha256: sha256(packed.compressed),
      loader_sha256: sha256(packed.loader),
      command_sha256: sha256(packed.command),
      effective_config_sha256: effectiveConfigSha256,
      attempt: 1,
      timeout_ms: TIMEOUT_MS,
      stdin_length: 0,
      effective_process: effectiveProcess,
      transport_inputs_before: inputsBefore,
      transport_inputs_after: inputsAfter,
      admission_v2_config_before: before.wrapperFact,
      admission_v2_config_after: after.wrapperFact,
      base_admission_config_before: before.admissionFact,
      base_admission_config_after: after.admissionFact,
      result,
      process: processEvidence(remote),
      target_body_not_invoked: true,
      hardware_action_performed: false,
      process_termination_performed: false,
      retry_permitted: false,
    };
    writeEvidence(absolute, "parse-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    try {
      const detail = error instanceof AdmissionV2ParseOnlyFailure ? error.detail : {
        schema: "synthia-m4f-direct-admission-v2-parse-only-failure.v1",
        code: "M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_UNEXPECTED",
        stage: remote === null ? "local_preflight" : "network",
        remote_effect_state: remote === null ? "not_started" : "read_only_unknown",
        retry_permitted: false,
      };
      if (remote !== null && detail.remote_effect_state === "not_started") {
        detail.remote_effect_state = "read_only_unknown";
      }
      if (remote !== null && detail.stage === "local_preflight") {
        detail.stage = "network_postflight";
      }
      writeEvidence(absolute, "parse-failure.json", JSON.stringify({
        ...detail,
        parse_id: config.parse_id,
        admission_id: wrapper.admission_id,
        gate_source_sha256: config.expected_source_sha256,
        admission_v2_source_sha256: config.expected_admission_v2_source_sha256,
        transport_source_sha256: config.expected_transport_source_sha256,
        source_sha256: sourceHash,
        source_length: sourceLength,
        config_sha256: sha256(canonicalJson(config) + "\n"),
        compressed_sha256: sha256(packed.compressed),
        loader_sha256: sha256(packed.loader),
        command_sha256: sha256(packed.command),
        effective_config_sha256: effectiveConfigSha256,
        attempt: 1,
        timeout_ms: TIMEOUT_MS,
        stdin_length: 0,
        effective_process: effectiveProcess,
        remote_process: remote === null ? null : processEvidence(remote),
        transport_inputs_before: inputsBefore,
        transport_inputs_after: transportInputsAfter,
        admission_v2_config_before: before.wrapperFact,
        admission_v2_config_after: wrapperConfigAfter,
        base_admission_config_before: before.admissionFact,
        base_admission_config_after: baseAdmissionConfigAfter,
        target_body_not_invoked: true,
        hardware_action_performed: false,
        process_termination_performed: false,
        retry_permitted: false,
      }, null, 2) + "\n");
    } catch {
      // Preserve frozen evidence and the original failure.
    }
    throw error;
  }
}

function spawnProcess(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult {
  const result = spawnSync(executable, args, {
    input: stdin,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BYTES,
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

const systemDependencies: AdmissionV2ParseOnlyDependencies = {
  spawn: spawnProcess,
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  admissionSourceBytes: () => readFileSync(new URL("./m4f-direct-admission-v2.ts", import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length === 3 && args[0] === "--plan" && args[1] === "--config") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(planAdmissionV2ParseOnly(raw)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-parse-only" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
      process.stdout.write(JSON.stringify(executeAdmissionV2ParseOnly(raw, args[4]!, args[6]!)) + "\n");
      return;
    }
    process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof AdmissionV2ParseOnlyFailure ? error.detail : {
      schema: "synthia-m4f-direct-admission-v2-parse-only-failure.v1",
      code: "M4F_DIRECT_ADMISSION_V2_PARSE_ONLY_UNEXPECTED",
      stage: "unknown",
      remote_effect_state: "read_only_unknown",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
