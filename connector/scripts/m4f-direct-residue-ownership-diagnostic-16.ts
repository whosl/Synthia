import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildResidueOwnership17Command,
  buildResidueOwnership17Script,
  validateCandidate17ScriptConfig,
  validateCandidate17ScriptFrozenInputs,
  type Candidate17ScriptConfig,
  type Ownership17Dependencies,
} from "./m4f-direct-residue-ownership-diagnostic-17.ts";
import {
  auditDirectSshEffectiveConfig,
  buildDirectSshEffectiveArguments,
  buildDirectSshOptions,
  captureM4fDirectTransportInputs,
  type M4fDirectAdmissionConfig,
  type RawProcessResult,
  validateM4fDirectAdmissionConfig,
} from "./m4f-gate-admission-transport.ts";
import {
  buildResidueOwnershipParseCommand,
  lintResidueOwnershipParseLoader,
} from "./m4f-residue-ownership-16-17-parse-loader.ts";

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 30_000;
const WINDOWS_COMMAND_LIMIT = 8_191;
const PARSE_COMMAND_LIMIT = 7_000;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export interface ResidueOwnership16ParseConfig {
  schema: "synthia-m4f-direct-residue-ownership-parse-config.v1";
  parse_id: string;
  candidate17_script_config_path: string;
  candidate17_script_config_sha256: string;
  evidence_directory: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  expected_candidate17_source_sha256: string;
  expected_parse_loader_source_sha256: string;
}

export interface Ownership16ParseDependencies extends Ownership17Dependencies {
  parseSourceBytes(): Buffer;
  parseTestSourceBytes(): Buffer;
}

export class Ownership16ParseFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_RESIDUE_16_PARSE_FAILED"));
  }
}

const CONFIG_KEYS = [
  "candidate17_script_config_path", "candidate17_script_config_sha256", "evidence_directory",
  "expected_candidate17_source_sha256", "expected_parse_loader_source_sha256", "expected_source_sha256",
  "expected_test_source_sha256",
  "parse_id", "schema",
] as const;

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
  throw new Ownership16ParseFailure({
    schema: "synthia-m4f-direct-residue-ownership-parse-failure.v1",
    code,
    stage,
    remote_effect_state: stage === "config" || stage === "local_preflight"
      ? "not_started" : "parse_only_unknown",
    retry_permitted: false,
    target_body_not_invoked: true,
    ...extra,
  });
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value);
}

export function validateResidueOwnership16ParseConfig(value: unknown): ResidueOwnership16ParseConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-direct-residue-ownership-parse-config.v1"
    || typeof config.parse_id !== "string" || !SAFE_ID.test(config.parse_id)
    || !safePath(config.candidate17_script_config_path) || !safePath(config.evidence_directory)
    || [config.candidate17_script_config_sha256, config.expected_source_sha256,
      config.expected_test_source_sha256, config.expected_candidate17_source_sha256,
      config.expected_parse_loader_source_sha256]
      .some((item) => typeof item !== "string" || !HASH.test(item))) {
    fail("M4F_RESIDUE_16_PARSE_CONFIG_INVALID", "config");
  }
  return value as ResidueOwnership16ParseConfig;
}

function loadTarget(
  config: ResidueOwnership16ParseConfig,
  dependencies: Ownership16ParseDependencies,
): Candidate17ScriptConfig {
  const bytes = dependencies.frozenBytes(config.candidate17_script_config_path);
  if (sha256(bytes) !== config.candidate17_script_config_sha256) {
    fail("M4F_RESIDUE_16_TARGET_CONFIG_MISMATCH", "local_preflight");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); } catch {
    fail("M4F_RESIDUE_16_TARGET_CONFIG_INVALID", "local_preflight");
  }
  const target = validateCandidate17ScriptConfig(value);
  validateCandidate17ScriptFrozenInputs(target, dependencies);
  return target;
}

function validateSources(config: ResidueOwnership16ParseConfig, dependencies: Ownership16ParseDependencies): void {
  if (sha256(dependencies.parseSourceBytes()) !== config.expected_source_sha256
    || sha256(dependencies.parseTestSourceBytes()) !== config.expected_test_source_sha256
    || sha256(dependencies.sourceBytes()) !== config.expected_candidate17_source_sha256
    || sha256(dependencies.parseLoaderSourceBytes()) !== config.expected_parse_loader_source_sha256) {
    fail("M4F_RESIDUE_16_SOURCE_MISMATCH", "local_preflight");
  }
}

export function buildResidueOwnership16ParseCommand(source: string, targetCommandSha256: string): {
  compressed: Buffer;
  loader: string;
  command: string;
} {
  try {
    const result = buildResidueOwnershipParseCommand(source, targetCommandSha256);
    if (result.command.length > PARSE_COMMAND_LIMIT || result.command.length > WINDOWS_COMMAND_LIMIT) {
      fail("M4F_RESIDUE_16_PARSE_COMMAND_TOO_LONG", "local_preflight", { command_length: result.command.length });
    }
    return result;
  } catch (error) {
    if (error instanceof Ownership16ParseFailure) throw error;
    fail("M4F_RESIDUE_16_PARSE_COMMAND_INVALID", "local_preflight");
  }
}

export function lintResidueOwnership16ParseLoader(loader: string): void {
  try {
    lintResidueOwnershipParseLoader(loader);
  } catch {
    fail("M4F_RESIDUE_16_LOADER_TOKEN_BOUNDARY_INVALID", "local_preflight");
  }
}

function parseResult(
  bytes: Buffer,
  expectedScriptHash: string,
  expectedScriptLength: number,
  expectedCommandHash: string,
): Record<string, unknown> {
  let value: Record<string, unknown> | null = null;
  try { value = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes).trim())); } catch {
    fail("M4F_RESIDUE_16_PARSE_OUTPUT_INVALID", "output_validation");
  }
  const keys = [
    "cleanup_performed", "file_mutation_performed", "hardware_action_performed",
    "parse_error_count", "parser_ast_type", "parser_end_block_present", "powershell_edition", "powershell_version",
    "process_mutation_performed", "schema", "status", "target_body_not_invoked", "target_command_sha256",
    "target_script_length", "target_script_sha256", "vivado_action_performed",
  ];
  if (!value || !exactKeys(value, keys)
    || value.schema !== "synthia-m4f-direct-residue-ownership-parse-result.v1"
    || value.target_script_sha256 !== expectedScriptHash || value.target_script_length !== expectedScriptLength
    || value.target_command_sha256 !== expectedCommandHash
    || value.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || value.parser_end_block_present !== true
    || value.powershell_edition !== "Desktop" || typeof value.powershell_version !== "string"
    || !value.powershell_version.startsWith("5.1.") || value.target_body_not_invoked !== true
    || value.process_mutation_performed !== false || value.file_mutation_performed !== false
    || value.vivado_action_performed !== false || value.hardware_action_performed !== false
    || value.cleanup_performed !== false) {
    fail("M4F_RESIDUE_16_PARSE_OUTPUT_INVALID", "output_validation");
  }
  if (value.status === "parsed_not_invoked") {
    if (value.parse_error_count !== 0) {
      fail("M4F_RESIDUE_16_PARSE_OUTPUT_INVALID", "output_validation");
    }
  } else if (value.status === "parse_rejected") {
    if (!Number.isSafeInteger(value.parse_error_count) || Number(value.parse_error_count) < 1) {
      fail("M4F_RESIDUE_16_PARSE_OUTPUT_INVALID", "output_validation");
    }
  } else {
    fail("M4F_RESIDUE_16_PARSE_OUTPUT_INVALID", "output_validation");
  }
  return value;
}

function processEvidence(raw: RawProcessResult): Record<string, unknown> {
  return {
    exit_status: raw.status, signal: raw.signal, error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT", stdin_length: 0, stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout), stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr), retry_permitted: false,
  };
}

function writeEvidence(directory: string, name: string, value: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  chmodSync(directory + "/" + name, 0o600);
}

export function residueOwnership16ParseConfirmation(
  rawConfig: unknown,
  dependencies: Ownership16ParseDependencies,
): string {
  const config = validateResidueOwnership16ParseConfig(rawConfig);
  const target = loadTarget(config, dependencies);
  const plan = planResidueOwnership16Parse(config, dependencies);
  return [
    "SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_16_WINDOWS_PARSE_ONLY", config.parse_id,
    sha256(canonicalJson(config) + "\n"), sha256(canonicalJson(plan) + "\n"),
    config.expected_source_sha256, config.expected_test_source_sha256,
    config.expected_candidate17_source_sha256, target.expected_test_source_sha256,
    config.expected_parse_loader_source_sha256,
  ].join(":");
}

export function planResidueOwnership16Parse(
  rawConfig: unknown,
  dependencies: Ownership16ParseDependencies,
): Record<string, unknown> {
  const config = validateResidueOwnership16ParseConfig(rawConfig);
  validateSources(config, dependencies);
  const target = loadTarget(config, dependencies);
  const admissionBytes = dependencies.admissionConfigBytes(target.admission_config_path);
  if (sha256(admissionBytes) !== target.admission_config_sha256) fail("M4F_RESIDUE_16_ADMISSION_MISMATCH", "local_preflight");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  const script = buildResidueOwnership17Script(target);
  const targetCommand = buildResidueOwnership17Command(target);
  const packed = buildResidueOwnership16ParseCommand(script, sha256(Buffer.from(targetCommand, "ascii")));
  return {
    schema: "synthia-m4f-direct-residue-ownership-parse-plan.v1",
    status: "planned_not_executed",
    parse_id: config.parse_id,
    target_host: admission.target.host,
    target_computer: admission.target.computer_name,
    target_script_sha256: sha256(script),
    target_script_length: Buffer.byteLength(script, "utf8"),
    target_command_sha256: sha256(Buffer.from(targetCommand, "ascii")),
    target_command_length: targetCommand.length,
    compressed_sha256: sha256(packed.compressed),
    loader_sha256: sha256(packed.loader),
    parse_command_sha256: sha256(packed.command),
    parse_command_length: packed.command.length,
    attempt_count: 1,
    retry_permitted: false,
    stdin_length: 0,
    effective_timeout_ms: EFFECTIVE_TIMEOUT_MS,
    remote_timeout_ms: REMOTE_TIMEOUT_MS,
    timeout_ms: REMOTE_TIMEOUT_MS,
    parser_required: "Windows PowerShell Desktop 5.1",
    target_body_not_invoked: true,
    network_attempted: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
  };
}

export function planResidueOwnership16ParseEnvelope(
  rawConfig: unknown,
  dependencies: Ownership16ParseDependencies,
): Record<string, unknown> {
  const config = validateResidueOwnership16ParseConfig(rawConfig);
  const plan = planResidueOwnership16Parse(config, dependencies);
  return {
    ...plan,
    config_sha256: sha256(canonicalJson(config) + "\n"),
    plan_sha256: sha256(canonicalJson(plan) + "\n"),
    confirmation: residueOwnership16ParseConfirmation(config, dependencies),
  };
}

export function executeResidueOwnership16Parse(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: Ownership16ParseDependencies,
): Record<string, unknown> {
  const config = validateResidueOwnership16ParseConfig(rawConfig);
  if (confirmation !== residueOwnership16ParseConfirmation(config, dependencies)) {
    fail("M4F_RESIDUE_16_PARSE_CONFIRMATION_REQUIRED", "local_preflight");
  }
  validateSources(config, dependencies);
  const target = loadTarget(config, dependencies);
  const admissionBytes = dependencies.admissionConfigBytes(target.admission_config_path);
  if (sha256(admissionBytes) !== target.admission_config_sha256) fail("M4F_RESIDUE_16_ADMISSION_MISMATCH", "local_preflight");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  if (admission.target.host !== TARGET_HOST) fail("M4F_RESIDUE_16_TARGET_INVALID", "local_preflight");
  const script = buildResidueOwnership17Script(target);
  const targetCommand = buildResidueOwnership17Command(target);
  const targetScriptHash = sha256(script);
  const targetCommandHash = sha256(Buffer.from(targetCommand, "ascii"));
  const packed = buildResidueOwnership16ParseCommand(script, targetCommandHash);
  const before = dependencies.transportInputs(admission, "local_preflight");
  const absolute = resolve(evidenceDirectory);
  if (absolute !== resolve(config.evidence_directory)) fail("M4F_RESIDUE_16_EVIDENCE_PATH_MISMATCH", "local_preflight");
  try { mkdirSync(absolute, { mode: 0o700 }); chmodSync(absolute, 0o700); } catch {
    fail("M4F_RESIDUE_16_EVIDENCE_INVALID", "local_preflight");
  }
  let remote: RawProcessResult | null = null;
  try {
    writeEvidence(absolute, "parse-config.canonical.json", canonicalJson(config) + "\n");
    writeEvidence(absolute, "confirmation.sha256", sha256(confirmation) + "\n");
    writeEvidence(absolute, "target-script.ps1", script);
    writeEvidence(absolute, "parse-loader.ps1", packed.loader);
    writeEvidence(absolute, "plan.canonical.json", canonicalJson(planResidueOwnership16Parse(config, dependencies)) + "\n");
    writeEvidence(absolute, "transport-inputs-initial.json", JSON.stringify(before, null, 2) + "\n");
    const effective = dependencies.spawn(
      SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(absolute, "ssh-effective-stdout.raw", effective.stdout);
    writeEvidence(absolute, "ssh-effective-stderr.raw", effective.stderr);
    writeEvidence(absolute, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0 || sha256(effective.stdout) !== target.expected_effective_config_sha256) {
      fail("M4F_RESIDUE_16_EFFECTIVE_FAILED", "local_preflight");
    }
    auditDirectSshEffectiveConfig(effective.stdout, admission);
    validateSources(config, dependencies);
    loadTarget(config, dependencies);
    const preRemote = dependencies.transportInputs(admission, "network");
    writeEvidence(absolute, "transport-inputs-pre_remote.json", JSON.stringify(preRemote, null, 2) + "\n");
    if (canonicalJson(before) !== canonicalJson(preRemote)) {
      fail("M4F_RESIDUE_16_INPUT_DRIFT", "network");
    }
    remote = dependencies.spawn(
      SSH_PATH, [...buildDirectSshOptions(admission), TARGET_HOST, packed.command], Buffer.alloc(0), REMOTE_TIMEOUT_MS,
    );
    writeEvidence(absolute, "stdout.raw", remote.stdout);
    writeEvidence(absolute, "stderr.raw", remote.stderr);
    writeEvidence(absolute, "remote-process.json", JSON.stringify(processEvidence(remote), null, 2) + "\n");
    validateSources(config, dependencies);
    loadTarget(config, dependencies);
    const postRemote = dependencies.transportInputs(admission, "network");
    writeEvidence(absolute, "transport-inputs-post_remote.json", JSON.stringify(postRemote, null, 2) + "\n");
    if (canonicalJson(before) !== canonicalJson(postRemote)) {
      fail("M4F_RESIDUE_16_INPUT_DRIFT", "network_postflight");
    }
    if (remote.signal !== null || remote.errorCode !== null || remote.stderr.length !== 0
      || (remote.status !== 0 && remote.status !== 2)) fail("M4F_RESIDUE_16_TRANSPORT_FAILED", "network");
    const result = parseResult(remote.stdout, targetScriptHash, Buffer.byteLength(script, "utf8"), targetCommandHash);
    if (remote.status === 2 && result.status === "parse_rejected") {
      fail("M4F_RESIDUE_16_TARGET_PARSE_REJECTED", "output_validation", {
        remote_effect_state: "parse_only_observed", parse_result: result,
      });
    }
    if (remote.status !== 0 || result.status !== "parsed_not_invoked") {
      fail("M4F_RESIDUE_16_PARSE_OUTPUT_INVALID", "output_validation");
    }
    const record = {
      schema: "synthia-m4f-direct-residue-ownership-parse-record.v1",
      status: "parsed_not_invoked",
      parse_id: config.parse_id,
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(canonicalJson(config) + "\n"),
      confirmation_sha256: sha256(confirmation),
      candidate17_script_config_sha256: config.candidate17_script_config_sha256,
      target_script_sha256: targetScriptHash,
      target_script_length: Buffer.byteLength(script, "utf8"),
      target_command_sha256: targetCommandHash,
      target_command_length: targetCommand.length,
      compressed_sha256: sha256(packed.compressed),
      loader_sha256: sha256(packed.loader),
      parse_command_sha256: sha256(packed.command),
      effective_config_sha256: sha256(effective.stdout),
      attempt: 1,
      timeout_ms: REMOTE_TIMEOUT_MS,
      stdin_length: 0,
      result,
      process: processEvidence(remote),
      target_body_not_invoked: true,
      process_mutation_performed: false,
      file_mutation_performed: false,
      vivado_action_performed: false,
      hardware_action_performed: false,
      cleanup_performed: false,
      retry_permitted: false,
    };
    writeEvidence(absolute, "parse-record.json", JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    try {
      const detail = error instanceof Ownership16ParseFailure ? error.detail : {
        schema: "synthia-m4f-direct-residue-ownership-parse-failure.v1",
        code: "M4F_RESIDUE_16_PARSE_UNEXPECTED", stage: remote === null ? "local_preflight" : "network",
        remote_effect_state: remote === null ? "not_started" : "parse_only_unknown",
        retry_permitted: false, target_body_not_invoked: true,
      };
      writeEvidence(absolute, "parse-failure.json", JSON.stringify({
        ...detail, parse_id: config.parse_id, target_script_sha256: targetScriptHash,
        target_command_sha256: targetCommandHash, attempt: remote === null ? 0 : 1,
        stdin_length: 0, remote_process: remote === null ? null : processEvidence(remote),
        process_mutation_performed: false, file_mutation_performed: false,
        vivado_action_performed: false, hardware_action_performed: false, cleanup_performed: false,
      }, null, 2) + "\n");
    } catch { /* preserve primary failure */ }
    throw error;
  }
}

const systemDependencies: Ownership16ParseDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer", windowsHide: true,
    });
    return {
      status: result.status, signal: result.signal,
      errorCode: result.error && "code" in result.error ? String(result.error.code) : null,
      stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)), stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    };
  },
  sourceBytes: () => readFileSync(new URL("./m4f-direct-residue-ownership-diagnostic-17.ts", import.meta.url)),
  testSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-17.test.ts", import.meta.url)),
  candidate15SourceBytes: () => readFileSync(new URL("./m4f-direct-residue-ownership-diagnostic-15.ts", import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  parseSourceBytes: () => readFileSync(new URL(import.meta.url)),
  parseTestSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-16.test.ts", import.meta.url)),
  candidate16SourceBytes: () => readFileSync(new URL(import.meta.url)),
  candidate16TestSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-16.test.ts", import.meta.url)),
  parseLoaderSourceBytes: () => readFileSync(new URL("./m4f-residue-ownership-16-17-parse-loader.ts", import.meta.url)),
  frozenBytes: (path) => readFileSync(path),
  admissionConfigBytes: (path) => readFileSync(path),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    const raw = JSON.parse(readFileSync(resolve(args[2]!), "utf8"));
    if (args.length === 3 && args[0] === "--plan" && args[1] === "--config") {
      process.stdout.write(JSON.stringify(planResidueOwnership16ParseEnvelope(raw, systemDependencies)) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--execute-parse-only" && args[1] === "--config"
      && args[3] === "--confirmation" && args[5] === "--evidence") {
      process.stdout.write(JSON.stringify(executeResidueOwnership16Parse(
        raw, args[4]!, args[6]!, systemDependencies,
      )) + "\n");
      return;
    }
    process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof Ownership16ParseFailure ? error.detail : {
      schema: "synthia-m4f-direct-residue-ownership-parse-failure.v1",
      code: "M4F_RESIDUE_16_PARSE_UNEXPECTED", stage: "unknown",
      remote_effect_state: "parse_only_unknown", retry_permitted: false, target_body_not_invoked: true,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
