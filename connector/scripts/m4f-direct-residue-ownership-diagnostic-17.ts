import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildResidueOwnership15Script,
  deriveOwnership15Observation,
  parseOwnership15Markers,
  validateResidueOwnership15Config,
  type Ownership15Marker,
  type Ownership15Observation,
  type ResidueOwnership15Config,
} from "./m4f-direct-residue-ownership-diagnostic-15.ts";
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
import { buildResidueOwnershipParseCommand } from "./m4f-residue-ownership-16-17-parse-loader.ts";

const SSH_PATH = "/usr/bin/ssh";
const LOCAL_TIMEOUT_MS = 25_000;
const COMMAND_LENGTH_LIMIT = 7_000;
const WINDOWS_COMMAND_LIMIT = 8_191;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PREDECESSOR_REMOTE_COMMAND_LENGTH = 6_618;
const PREDECESSOR_REMOTE_COMMAND_SHA256 = "9243ff7238cd47b3ccaddbb7a5462d57a3be1a3faa95fdca90933a999e5327e9";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const C15_STDERR_SHA256 = "c501cd736e6774b1608ca7df1fb29b2c6e1c2472ca0de643f5d8ec33a012cb41";
const EFFECTIVE_CONFIG_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";

const C15_EVIDENCE_FILES = [
  "admission-config.raw.json", "confirmation.sha256", "diagnostic-config.canonical.json", "markers.json",
  "observation.json", "plan.canonical.json", "remote-command.json", "remote-process.json", "remote-script.ps1",
  "remote-stderr.raw", "remote-stdout.raw", "result.json", "ssh-effective-process.json",
  "ssh-effective-stderr.raw", "ssh-effective-stdout.raw", "transport-inputs-initial.json",
  "transport-inputs-post_remote.json", "transport-inputs-pre_remote.json",
] as const;

export interface Candidate15FailureBinding {
  config_path: string;
  config_sha256: string;
  plan_path: string;
  plan_sha256: string;
  confirmation_path: string;
  confirmation_sha256: string;
  review_record_path: string;
  review_record_sha256: string;
  evidence_directory: string;
  failure_code: "powershell_parser_missing_in_separator";
  files: Record<string, string>;
}

export type Candidate17ScriptConfig = Omit<
  ResidueOwnership15Config,
  "schema" | "expected_source_sha256" | "expected_test_source_sha256"
> & {
  schema: "synthia-m4f-candidate17-script-config.v1";
  candidate15_failure: Candidate15FailureBinding;
  expected_candidate15_source_sha256: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
};

const C16_PARSE_FILES = [
  "confirmation.sha256", "parse-config.canonical.json", "parse-loader.ps1", "parse-record.json", "plan.canonical.json",
  "remote-process.json", "ssh-effective-process.json", "ssh-effective-stderr.raw", "ssh-effective-stdout.raw",
  "stderr.raw", "stdout.raw", "target-script.ps1", "transport-inputs-initial.json",
  "transport-inputs-post_remote.json", "transport-inputs-pre_remote.json",
] as const;

export interface Candidate16ParseSuccessBinding {
  parse_config_path: string;
  parse_config_sha256: string;
  evidence_directory: string;
  target_script_sha256: string;
  target_command_sha256: string;
  files: Record<string, string>;
}

export interface ResidueOwnership17Config {
  schema: "synthia-m4f-direct-residue-ownership-config.v6";
  diagnostic_id: string;
  evidence_directory: string;
  script_config_sha256: string;
  script_config: Candidate17ScriptConfig;
  candidate16_parse_success: Candidate16ParseSuccessBinding;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
}

export interface Ownership17Dependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  sourceBytes(): Buffer;
  testSourceBytes(): Buffer;
  candidate15SourceBytes(): Buffer;
  candidate16SourceBytes(): Buffer;
  candidate16TestSourceBytes(): Buffer;
  parseLoaderSourceBytes(): Buffer;
  transportSourceBytes(): Buffer;
  frozenBytes(path: string): Buffer;
  admissionConfigBytes(path: string): Buffer;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): LocalInputFact[];
  now(): Date;
}

export interface Ownership17Result {
  process: RawProcessResult;
  markers: Ownership15Marker[];
  observation: Ownership15Observation | null;
  status: "ownership_observed" | "partial_unknown";
  trailing_fragment_length: number;
  trailing_fragment_sha256: string;
}

const V4_KEYS = [
  "admission_config_path", "admission_config_sha256", "attempt_windows", "candidate12", "candidate14_failure",
  "candidate15_failure", "cmd_bindings", "diagnostic_id", "evidence_directory",
  "expected_candidate15_source_sha256", "expected_effective_config_sha256", "expected_source_sha256",
  "expected_test_source_sha256", "expected_transport_source_sha256", "expected_wrapper_decoded_utf8_sha256",
  "known_double_space_wrapper_command_sha256", "raw_command_hashes", "schema", "targets",
] as const;
const C15_FAILURE_KEYS = [
  "config_path", "config_sha256", "confirmation_path", "confirmation_sha256", "evidence_directory", "failure_code",
  "files", "plan_path", "plan_sha256", "review_record_path", "review_record_sha256",
] as const;
const ACTUAL_KEYS = [
  "candidate16_parse_success", "diagnostic_id", "evidence_directory", "expected_source_sha256",
  "expected_test_source_sha256", "schema", "script_config", "script_config_sha256",
] as const;
const PARSE_KEYS = [
  "evidence_directory", "files", "parse_config_path", "parse_config_sha256", "target_command_sha256",
  "target_script_sha256",
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

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/u.test(value);
}

function predecessorConfig(config: Candidate17ScriptConfig): ResidueOwnership15Config {
  const { candidate15_failure: _failure, expected_candidate15_source_sha256: _source, ...rest } = config;
  return {
    ...rest,
    schema: "synthia-m4f-direct-residue-ownership-config.v3",
  } as ResidueOwnership15Config;
}

export function validateCandidate17ScriptConfig(value: unknown): Candidate17ScriptConfig {
  const config = object(value);
  const failure = object(config?.candidate15_failure);
  const files = object(failure?.files);
  if (!config || !exactKeys(config, V4_KEYS)
    || config.schema !== "synthia-m4f-candidate17-script-config.v1"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !failure || !exactKeys(failure, C15_FAILURE_KEYS)
    || !absolutePath(failure.config_path) || !absolutePath(failure.plan_path)
    || !absolutePath(failure.confirmation_path) || !absolutePath(failure.review_record_path)
    || !absolutePath(failure.evidence_directory)
    || failure.failure_code !== "powershell_parser_missing_in_separator"
    || !files || !exactKeys(files, C15_EVIDENCE_FILES)
    || [failure.config_sha256, failure.plan_sha256, failure.confirmation_sha256,
      failure.review_record_sha256, ...Object.values(files), config.expected_candidate15_source_sha256,
      config.expected_source_sha256, config.expected_test_source_sha256]
      .some((item) => typeof item !== "string" || !HASH.test(item))) {
    throw new Error("M4F_RESIDUE_17_CONFIG_INVALID");
  }
  try {
    validateResidueOwnership15Config(predecessorConfig(value as Candidate17ScriptConfig));
  } catch {
    throw new Error("M4F_RESIDUE_17_CONFIG_INVALID");
  }
  return value as Candidate17ScriptConfig;
}

export function validateResidueOwnership17Config(value: unknown): ResidueOwnership17Config {
  const config = object(value);
  const parse = object(config?.candidate16_parse_success);
  const files = object(parse?.files);
  if (!config || !exactKeys(config, ACTUAL_KEYS)
    || config.schema !== "synthia-m4f-direct-residue-ownership-config.v6"
    || typeof config.diagnostic_id !== "string" || !SAFE_ID.test(config.diagnostic_id)
    || !absolutePath(config.evidence_directory)
    || !parse || !exactKeys(parse, PARSE_KEYS) || !absolutePath(parse.parse_config_path)
    || !absolutePath(parse.evidence_directory) || !files || !exactKeys(files, C16_PARSE_FILES)
    || [config.script_config_sha256, config.expected_source_sha256, config.expected_test_source_sha256,
      parse.parse_config_sha256, parse.target_script_sha256, parse.target_command_sha256,
      ...Object.values(files)].some((item) => typeof item !== "string" || !HASH.test(item))) {
    throw new Error("M4F_RESIDUE_17_CONFIG_INVALID");
  }
  const script = validateCandidate17ScriptConfig(config.script_config);
  if (script.diagnostic_id !== config.diagnostic_id || script.evidence_directory !== config.evidence_directory
    || config.expected_source_sha256 !== script.expected_source_sha256
    || config.expected_test_source_sha256 !== script.expected_test_source_sha256
    || sha256(Buffer.from(canonicalJson(script) + "\n")) !== config.script_config_sha256) {
    throw new Error("M4F_RESIDUE_17_CONFIG_INVALID");
  }
  return value as ResidueOwnership17Config;
}

function replaceExact(source: string, before: string, after: string, count: number): string {
  const pieces = source.split(before);
  if (pieces.length - 1 !== count) throw new Error("M4F_RESIDUE_17_PREDECESSOR_SHAPE_DRIFT");
  return pieces.join(after);
}

export function lintCandidate17PowerShellSyntax(script: string): void {
  const operators = "eq|ne|in|and|cmatch|ceq|ge";
  if (script.includes("foreach($i in$want)")
    || new RegExp("[^\\s]-(?:" + operators + ")\\b", "iu").test(script)
    || new RegExp("-(?:" + operators + ")[^\\s]", "iu").test(script)) {
    throw new Error("M4F_RESIDUE_17_POWERSHELL_TOKEN_BOUNDARY_INVALID");
  }
  const foreachForms = script.match(/foreach\s*\([^\r\n{}]*\)/gu) ?? [];
  if (foreachForms.length !== 1 || foreachForms[0] !== "foreach ($i in $want)") {
    throw new Error("M4F_RESIDUE_17_POWERSHELL_FOREACH_GRAMMAR_INVALID");
  }
  const stack: string[] = [];
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    const next = script[index + 1];
    if (quote === "single") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === "`") index += 1;
      else if (char === "\"") quote = null;
      continue;
    }
    if (char === "'") { quote = "single"; continue; }
    if (char === "\"") { quote = "double"; continue; }
    if ("({[".includes(char)) stack.push(char);
    if (")}]".includes(char)) {
      const expected = char === ")" ? "(" : char === "}" ? "{" : "[";
      if (stack.pop() !== expected) throw new Error("M4F_RESIDUE_17_POWERSHELL_DELIMITER_INVALID");
    }
  }
  if (quote !== null || stack.length !== 0) throw new Error("M4F_RESIDUE_17_POWERSHELL_DELIMITER_INVALID");
}

export function buildResidueOwnership17Script(rawConfig: unknown): string {
  const config = validateCandidate17ScriptConfig(rawConfig);
  let script = buildResidueOwnership15Script(predecessorConfig(config));
  script = replaceExact(script, "foreach($i in$want)", "foreach ($i in $want)", 1);
  script = replaceExact(script, "$_.ProcessId-ne0", "$_.ProcessId -ne 0", 1);
  script = replaceExact(script, "$_.ProcessId-in$ids", "$_.ProcessId -in $ids", 1);
  script = replaceExact(script, ").Count-ne4", ").Count -ne 4", 1);
  script = replaceExact(script, "$_.ProcessId-in$cmd", "$_.ProcessId -in $cmd", 1);
  script = replaceExact(script, "$_.ProcessId-eq$i", "$_.ProcessId -eq $i", 1);
  script = replaceExact(script, "$x.Count-ne1", "$x.Count -ne 1", 1);
  script = replaceExact(script, "$i-in$ids", "$i -in $ids", 1);
  script = replaceExact(script, "$i-in$ps", "$i -in $ps", 1);
  script = replaceExact(script, "$null-ne$q", "$null -ne $q", 2);
  script = replaceExact(script, "$q-and$q-cmatch'", "$q -and $q -cmatch '", 1);
  script = replaceExact(script, "-ceq$Matches[1]", " -ceq $Matches[1]", 1);
  script = replaceExact(script, "UtcNow-ge$dl", "UtcNow -ge $dl", 1);
  lintCandidate17PowerShellSyntax(script);
  return script;
}

export function buildResidueOwnership17Command(rawConfig: unknown): string {
  const script = buildResidueOwnership17Script(rawConfig);
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(script, "utf16le").toString("base64");
  if (command.length > COMMAND_LENGTH_LIMIT) throw new Error("M4F_RESIDUE_17_COMMAND_TOO_LONG");
  if (Buffer.from(command.slice(command.lastIndexOf(" ") + 1), "base64").toString("utf16le") !== script) {
    throw new Error("M4F_RESIDUE_17_COMMAND_ROUNDTRIP_INVALID");
  }
  return command;
}

export function candidate17ScriptConfigSha256(rawConfig: unknown): string {
  return sha256(Buffer.from(canonicalJson(validateCandidate17ScriptConfig(rawConfig)) + "\n"));
}

export function residueOwnership17Plan(rawConfig: unknown, rawAdmission: unknown): Record<string, unknown> {
  const config = validateResidueOwnership17Config(rawConfig);
  const target = config.script_config;
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  const script = Buffer.from(buildResidueOwnership17Script(target), "utf8");
  const command = buildResidueOwnership17Command(target);
  return {
    schema: "synthia-m4f-direct-residue-ownership-plan.v6",
    diagnostic_id: config.diagnostic_id,
    lineage: "candidate17_after_candidate16_windows_powershell_5_1_parse_success",
    script_config_sha256: config.script_config_sha256,
    candidate15_failure: target.candidate15_failure,
    candidate16_parse_success: config.candidate16_parse_success,
    evidence_directory: config.evidence_directory,
    topology: "single_ssh_direct_encoded_command_empty_stdin",
    syntax_gate: "candidate17_static_token_and_balanced_delimiter_v1",
    corrected_foreach_grammar: "foreach ($i in $want)",
    attempt_count: 1,
    retry_permitted: false,
    local_timeout_ms: LOCAL_TIMEOUT_MS,
    local_timeout_kill_signal: "SIGKILL",
    remote_cooperative_deadline_seconds: 15,
    stdin_length: 0,
    cim_snapshot_count: 1,
    get_process_target_count: 4,
    get_process_target_count_basis: "static_proof_four_unique_target_ids_cmd_ids_disjoint_and_guarded_branch",
    full_graph_projection: "pid_parent_edges_only",
    detailed_object_count_maximum: 6,
    pid_zero_excluded: true,
    closure_row_limit: 32,
    wrapper_spacing: "exactly_two_ascii_spaces_after_executable_only",
    wrapper_known_command_sha256: target.known_double_space_wrapper_command_sha256,
    remote_script_length: script.length,
    remote_script_sha256: sha256(script),
    remote_command_length: command.length,
    remote_command_sha256: sha256(Buffer.from(command, "ascii")),
    remote_command_length_limit: COMMAND_LENGTH_LIMIT,
    windows_command_limit: WINDOWS_COMMAND_LIMIT,
    first_remote_action: "write_and_flush_start_marker",
    raw_command_line_returned: false,
    raw_command_stored: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    cleanup_performed: false,
    cleanup_derivation_permitted: false,
    cleanup_requires_separate_authorization: true,
    vivado_action_performed: false,
    hardware_action_performed: false,
    target_host: admission.target.host,
    target_user: admission.target.user,
    network_attempted: false,
  };
}

export function residueOwnership17PlanSha256(rawConfig: unknown, rawAdmission: unknown): string {
  return sha256(Buffer.from(canonicalJson(residueOwnership17Plan(rawConfig, rawAdmission)) + "\n"));
}

export function residueOwnership17Confirmation(rawConfig: unknown, rawAdmission: unknown): string {
  const config = validateResidueOwnership17Config(rawConfig);
  return [
    "SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_17_READ_ONLY", config.diagnostic_id,
    sha256(Buffer.from(canonicalJson(config) + "\n")), residueOwnership17PlanSha256(config, rawAdmission),
    config.expected_source_sha256, config.expected_test_source_sha256,
  ].join(":");
}

function validateCandidate15Failure(config: Candidate17ScriptConfig, dependencies: Ownership17Dependencies): void {
  const failure = config.candidate15_failure;
  const production = config.diagnostic_id === "m4f-direct-residue-ownership-prod-20260829-17";
  const bound: Array<[string, string]> = [
    [failure.config_path, failure.config_sha256], [failure.plan_path, failure.plan_sha256],
    [failure.confirmation_path, failure.confirmation_sha256],
    [failure.review_record_path, failure.review_record_sha256],
    ...C15_EVIDENCE_FILES.map((name): [string, string] => [failure.evidence_directory + "/" + name, failure.files[name]!]),
  ];
  for (const [path, expected] of bound) {
    if (sha256(dependencies.frozenBytes(path)) !== expected) {
      throw new Error("M4F_RESIDUE_17_FROZEN_INPUT_MISMATCH");
    }
  }
  const predecessor = object(JSON.parse(dependencies.frozenBytes(failure.config_path).toString("utf8")));
  const canonical = object(JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/diagnostic-config.canonical.json",
  ).toString("utf8")));
  const result = object(JSON.parse(dependencies.frozenBytes(failure.evidence_directory + "/result.json").toString("utf8")));
  const remote = object(JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/remote-process.json",
  ).toString("utf8")));
  const command = object(JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/remote-command.json",
  ).toString("utf8")));
  const markers = JSON.parse(dependencies.frozenBytes(failure.evidence_directory + "/markers.json").toString("utf8"));
  const observation = JSON.parse(dependencies.frozenBytes(failure.evidence_directory + "/observation.json").toString("utf8"));
  const stdout = dependencies.frozenBytes(failure.evidence_directory + "/remote-stdout.raw");
  const stderr = dependencies.frozenBytes(failure.evidence_directory + "/remote-stderr.raw");
  const oldScript = dependencies.frozenBytes(failure.evidence_directory + "/remote-script.ps1").toString("utf8");
  const effective = object(JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/ssh-effective-process.json",
  ).toString("utf8")));
  const effectiveStdout = dependencies.frozenBytes(failure.evidence_directory + "/ssh-effective-stdout.raw");
  const transportInitial = JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/transport-inputs-initial.json",
  ).toString("utf8"));
  const transportPre = JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/transport-inputs-pre_remote.json",
  ).toString("utf8"));
  const transportPost = JSON.parse(dependencies.frozenBytes(
    failure.evidence_directory + "/transport-inputs-post_remote.json",
  ).toString("utf8"));
  if (!predecessor || predecessor.schema !== "synthia-m4f-direct-residue-ownership-config.v3"
    || predecessor.diagnostic_id !== "m4f-direct-residue-ownership-prod-20260829-15"
    || !canonical || canonical.diagnostic_id !== predecessor.diagnostic_id
    || !result || result.status !== "partial_unknown"
    || canonicalJson(result.reasons) !== canonicalJson(["snapshot_unavailable"])
    || result.attempt_count !== 1 || result.stdin_length !== 0 || result.marker_count !== 0
    || result.trailing_fragment_length !== 0 || result.trailing_fragment_sha256 !== EMPTY_SHA256
    || result.retry_permitted !== false || result.cleanup_performed !== false
    || result.cleanup_derivation_permitted !== false
    || !Array.isArray(markers) || markers.length !== 0 || observation !== null
    || !remote || remote.attempt_count !== 1 || remote.exit_status !== 1 || remote.signal !== null
    || remote.error_code !== null || remote.stdin_length !== 0 || remote.stdin_sha256 !== EMPTY_SHA256
    || remote.stdout_length !== 0 || remote.stdout_sha256 !== EMPTY_SHA256
    || remote.stderr_length !== 1912 || stderr.length !== 1912
    || remote.stderr_sha256 !== failure.files["remote-stderr.raw"]
    || sha256(stderr) !== failure.files["remote-stderr.raw"]
    || production && (remote.stderr_sha256 !== C15_STDERR_SHA256 || sha256(stderr) !== C15_STDERR_SHA256)
    || remote.retry_permitted !== false || stdout.length !== 0
    || !command || command.length !== PREDECESSOR_REMOTE_COMMAND_LENGTH
    || command.sha256 !== PREDECESSOR_REMOTE_COMMAND_SHA256 || command.stdin_length !== 0
    || command.attempt_count !== 1 || command.raw_command_stored !== false
    || (oldScript.match(/foreach\(\$i in\$want\)/gu) ?? []).length !== 1
    || oldScript.includes("foreach($i in $want)")
    || !stderr.toString("utf8").includes("MissingInInForeach")
    || !effective || effective.exit_status !== 0 || effective.signal !== null || effective.error_code !== null
    || effective.stdin_length !== 0 || effective.stderr_length !== 0
    || effective.stdout_sha256 !== sha256(effectiveStdout)
    || production && (effective.stdout_sha256 !== EFFECTIVE_CONFIG_SHA256
      || sha256(effectiveStdout) !== EFFECTIVE_CONFIG_SHA256)
    || canonicalJson(transportInitial) !== canonicalJson(transportPre)
    || canonicalJson(transportInitial) !== canonicalJson(transportPost)) {
    throw new Error("M4F_RESIDUE_17_CANDIDATE15_FAILURE_SEMANTIC_MISMATCH");
  }
}

export function validateCandidate17ScriptFrozenInputs(config: Candidate17ScriptConfig, dependencies: Ownership17Dependencies): void {
  validateCandidate15Failure(config, dependencies);
  if (sha256(dependencies.candidate15SourceBytes()) !== config.expected_candidate15_source_sha256
    || sha256(dependencies.sourceBytes()) !== config.expected_source_sha256
    || sha256(dependencies.testSourceBytes()) !== config.expected_test_source_sha256
    || sha256(dependencies.transportSourceBytes()) !== config.expected_transport_source_sha256) {
    throw new Error("M4F_RESIDUE_17_SOURCE_MISMATCH");
  }
}

function validateCandidate16ParseSuccess(
  config: ResidueOwnership17Config,
  dependencies: Ownership17Dependencies,
): void {
  const binding = config.candidate16_parse_success;
  const parseConfigBytes = dependencies.frozenBytes(binding.parse_config_path);
  if (sha256(parseConfigBytes) !== binding.parse_config_sha256) {
    throw new Error("M4F_RESIDUE_17_PARSE_INPUT_MISMATCH");
  }
  for (const name of C16_PARSE_FILES) {
    if (sha256(dependencies.frozenBytes(binding.evidence_directory + "/" + name)) !== binding.files[name]) {
      throw new Error("M4F_RESIDUE_17_PARSE_INPUT_MISMATCH");
    }
  }
  const evidence = (name: string): Buffer => dependencies.frozenBytes(binding.evidence_directory + "/" + name);
  const record = object(JSON.parse(evidence("parse-record.json").toString("utf8")));
  const result = object(record?.result);
  const process = object(record?.process);
  const remoteProcess = object(JSON.parse(evidence("remote-process.json").toString("utf8")));
  const parseConfig = object(JSON.parse(parseConfigBytes.toString("utf8")));
  const parseConfigCanonical = evidence("parse-config.canonical.json");
  const planBytes = evidence("plan.canonical.json");
  const plan = object(JSON.parse(planBytes.toString("utf8")));
  const targetScript = buildResidueOwnership17Script(config.script_config);
  const targetCommand = buildResidueOwnership17Command(config.script_config);
  const targetScriptHash = sha256(targetScript);
  const targetCommandHash = sha256(Buffer.from(targetCommand, "ascii"));
  const targetScriptBytes = evidence("target-script.ps1");
  const packed = buildResidueOwnershipParseCommand(targetScript, targetCommandHash);
  const loaderBytes = evidence("parse-loader.ps1");
  const stdoutBytes = evidence("stdout.raw");
  const stderrBytes = evidence("stderr.raw");
  const effectiveStdout = evidence("ssh-effective-stdout.raw");
  const effectiveStderr = evidence("ssh-effective-stderr.raw");
  const effectiveProcess = object(JSON.parse(evidence("ssh-effective-process.json").toString("utf8")));
  const transportInitial = JSON.parse(evidence("transport-inputs-initial.json").toString("utf8"));
  const transportPre = JSON.parse(evidence("transport-inputs-pre_remote.json").toString("utf8"));
  const transportPost = JSON.parse(evidence("transport-inputs-post_remote.json").toString("utf8"));
  const admissionBytes = dependencies.admissionConfigBytes(config.script_config.admission_config_path);
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  const expectedPlan = parseConfig ? {
    schema: "synthia-m4f-direct-residue-ownership-parse-plan.v1",
    status: "planned_not_executed",
    parse_id: parseConfig.parse_id,
    target_host: admission.target.host,
    target_computer: admission.target.computer_name,
    target_script_sha256: targetScriptHash,
    target_script_length: Buffer.byteLength(targetScript, "utf8"),
    target_command_sha256: targetCommandHash,
    target_command_length: targetCommand.length,
    compressed_sha256: sha256(packed.compressed),
    loader_sha256: sha256(packed.loader),
    parse_command_sha256: sha256(packed.command),
    parse_command_length: packed.command.length,
    attempt_count: 1,
    retry_permitted: false,
    stdin_length: 0,
    effective_timeout_ms: 15_000,
    remote_timeout_ms: 30_000,
    timeout_ms: 30_000,
    parser_required: "Windows PowerShell Desktop 5.1",
    target_body_not_invoked: true,
    network_attempted: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    cleanup_performed: false,
  } : null;
  const confirmation = parseConfig && expectedPlan ? [
    "SYNTHIA_M4F_DIRECT_RESIDUE_OWNERSHIP_16_WINDOWS_PARSE_ONLY", parseConfig.parse_id,
    sha256(canonicalJson(parseConfig) + "\n"), sha256(canonicalJson(expectedPlan) + "\n"),
    parseConfig.expected_source_sha256, parseConfig.expected_test_source_sha256,
    parseConfig.expected_candidate17_source_sha256, config.script_config.expected_test_source_sha256,
    parseConfig.expected_parse_loader_source_sha256,
  ].join(":") : "";
  const resultFromStdout = object(JSON.parse(stdoutBytes.toString("utf8").trim()));
  const processKeys = [
    "error_code", "exit_status", "retry_permitted", "signal", "stderr_length", "stderr_sha256",
    "stdin_length", "stdout_length", "stdout_sha256", "timed_out",
  ];
  const resultKeys = [
    "cleanup_performed", "file_mutation_performed", "hardware_action_performed",
    "parse_error_count", "parser_ast_type", "parser_end_block_present", "powershell_edition", "powershell_version",
    "process_mutation_performed", "schema", "status", "target_body_not_invoked", "target_command_sha256",
    "target_script_length", "target_script_sha256", "vivado_action_performed",
  ];
  const recordKeys = [
    "attempt", "candidate17_script_config_sha256", "cleanup_performed", "compressed_sha256",
    "config_sha256", "confirmation_sha256", "effective_config_sha256", "file_mutation_performed",
    "hardware_action_performed", "loader_sha256", "parse_command_sha256", "parse_id", "process",
    "process_mutation_performed", "recorded_at_utc", "result", "retry_permitted", "schema", "status",
    "stdin_length", "target_body_not_invoked", "target_command_length", "target_command_sha256",
    "target_script_length", "target_script_sha256", "timeout_ms", "vivado_action_performed",
  ];
  if (!record || record.schema !== "synthia-m4f-direct-residue-ownership-parse-record.v1"
    || !exactKeys(record, recordKeys)
    || record.status !== "parsed_not_invoked" || record.attempt !== 1 || record.stdin_length !== 0
    || record.timeout_ms !== 30_000
    || typeof record.recorded_at_utc !== "string" || Number.isNaN(Date.parse(record.recorded_at_utc))
    || !parseConfig || !exactKeys(parseConfig, [
      "candidate17_script_config_path", "candidate17_script_config_sha256", "evidence_directory",
      "expected_candidate17_source_sha256", "expected_parse_loader_source_sha256", "expected_source_sha256",
      "expected_test_source_sha256",
      "parse_id", "schema",
    ])
    || parseConfig.schema !== "synthia-m4f-direct-residue-ownership-parse-config.v1"
    || typeof parseConfig.parse_id !== "string" || !SAFE_ID.test(parseConfig.parse_id)
    || parseConfig.evidence_directory !== binding.evidence_directory
    || parseConfig.expected_candidate17_source_sha256 !== config.expected_source_sha256
    || typeof parseConfig.candidate17_script_config_path !== "string"
    || !absolutePath(parseConfig.candidate17_script_config_path)
    || typeof parseConfig.candidate17_script_config_sha256 !== "string"
    || !HASH.test(parseConfig.candidate17_script_config_sha256)
    || typeof parseConfig.expected_source_sha256 !== "string" || !HASH.test(parseConfig.expected_source_sha256)
    || typeof parseConfig.expected_test_source_sha256 !== "string" || !HASH.test(parseConfig.expected_test_source_sha256)
    || typeof parseConfig.expected_parse_loader_source_sha256 !== "string"
    || !HASH.test(parseConfig.expected_parse_loader_source_sha256)
    || sha256(dependencies.candidate16SourceBytes()) !== parseConfig.expected_source_sha256
    || sha256(dependencies.candidate16TestSourceBytes()) !== parseConfig.expected_test_source_sha256
    || sha256(dependencies.parseLoaderSourceBytes()) !== parseConfig.expected_parse_loader_source_sha256
    || sha256(dependencies.frozenBytes(parseConfig.candidate17_script_config_path))
      !== parseConfig.candidate17_script_config_sha256
    || canonicalJson(JSON.parse(dependencies.frozenBytes(parseConfig.candidate17_script_config_path).toString("utf8")))
      !== canonicalJson(config.script_config)
    || !parseConfigCanonical.equals(Buffer.from(canonicalJson(parseConfig) + "\n"))
    || sha256(admissionBytes) !== config.script_config.admission_config_sha256
    || !expectedPlan || !plan || canonicalJson(plan) !== canonicalJson(expectedPlan)
    || !planBytes.equals(Buffer.from(canonicalJson(expectedPlan) + "\n"))
    || evidence("confirmation.sha256").toString("ascii") !== sha256(confirmation) + "\n"
    || record.config_sha256 !== sha256(canonicalJson(parseConfig) + "\n")
    || record.confirmation_sha256 !== sha256(confirmation)
    || record.parse_id !== parseConfig.parse_id
    || record.candidate17_script_config_sha256 !== parseConfig.candidate17_script_config_sha256
    || record.retry_permitted !== false || record.target_body_not_invoked !== true
    || record.process_mutation_performed !== false || record.file_mutation_performed !== false
    || record.vivado_action_performed !== false || record.hardware_action_performed !== false
    || record.cleanup_performed !== false || record.target_script_sha256 !== targetScriptHash
    || record.target_script_length !== Buffer.byteLength(targetScript, "utf8")
    || record.target_command_sha256 !== targetCommandHash || record.target_command_length !== targetCommand.length
    || record.compressed_sha256 !== sha256(packed.compressed)
    || binding.target_script_sha256 !== targetScriptHash
    || binding.target_command_sha256 !== targetCommandHash
    || !targetScriptBytes.equals(Buffer.from(targetScript, "utf8"))
    || !loaderBytes.equals(Buffer.from(packed.loader, "utf8"))
    || record.loader_sha256 !== sha256(packed.loader) || record.parse_command_sha256 !== sha256(packed.command)
    || !result || !exactKeys(result, resultKeys)
    || !resultFromStdout || canonicalJson(resultFromStdout) !== canonicalJson(result)
    || result.status !== "parsed_not_invoked" || result.parse_error_count !== 0
    || result.schema !== "synthia-m4f-direct-residue-ownership-parse-result.v1"
    || result.target_script_sha256 !== targetScriptHash
    || result.target_script_length !== Buffer.byteLength(targetScript, "utf8")
    || result.target_command_sha256 !== targetCommandHash
    || result.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || result.parser_end_block_present !== true
    || result.powershell_edition !== "Desktop" || typeof result.powershell_version !== "string"
    || !result.powershell_version.startsWith("5.1.") || result.target_body_not_invoked !== true
    || result.process_mutation_performed !== false || result.file_mutation_performed !== false
    || result.vivado_action_performed !== false || result.hardware_action_performed !== false
    || result.cleanup_performed !== false
    || !process || !exactKeys(process, processKeys)
    || !remoteProcess || !exactKeys(remoteProcess, processKeys)
    || canonicalJson(remoteProcess) !== canonicalJson(process)
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.stderr_length !== 0 || process.stdin_length !== 0
    || process.stdout_length !== stdoutBytes.length || process.stdout_sha256 !== sha256(stdoutBytes)
    || process.stderr_sha256 !== sha256(stderrBytes) || stderrBytes.length !== 0
    || process.retry_permitted !== false
    || !effectiveProcess || !exactKeys(effectiveProcess, processKeys)
    || effectiveProcess.exit_status !== 0 || effectiveProcess.signal !== null
    || effectiveProcess.error_code !== null || effectiveProcess.timed_out !== false
    || effectiveProcess.stdin_length !== 0 || effectiveProcess.stdout_length !== effectiveStdout.length
    || effectiveProcess.stdout_sha256 !== sha256(effectiveStdout)
    || effectiveProcess.stderr_length !== effectiveStderr.length
    || effectiveProcess.stderr_sha256 !== sha256(effectiveStderr) || effectiveStderr.length !== 0
    || effectiveProcess.retry_permitted !== false
    || record.effective_config_sha256 !== sha256(effectiveStdout)
    || sha256(effectiveStdout) !== config.script_config.expected_effective_config_sha256
    || !Array.isArray(transportInitial) || !Array.isArray(transportPre) || !Array.isArray(transportPost)
    || canonicalJson(transportInitial) !== canonicalJson(transportPre)
    || canonicalJson(transportInitial) !== canonicalJson(transportPost)) {
    throw new Error("M4F_RESIDUE_17_PARSE_SUCCESS_SEMANTIC_MISMATCH");
  }
  auditDirectSshEffectiveConfig(effectiveStdout, admission);
}

export function executeResidueOwnership17(
  rawConfig: unknown,
  rawAdmission: unknown,
  confirmation: string,
  dependencies: Ownership17Dependencies,
): Ownership17Result {
  const config = validateResidueOwnership17Config(rawConfig);
  const target = config.script_config;
  const admission = validateM4fDirectAdmissionConfig(rawAdmission);
  if (confirmation !== residueOwnership17Confirmation(config, admission)) {
    throw new Error("M4F_RESIDUE_17_CONFIRMATION_REQUIRED");
  }
  validateCandidate17ScriptFrozenInputs(target, dependencies);
  validateCandidate16ParseSuccess(config, dependencies);
  const inputs = dependencies.transportInputs(admission, "local_preflight");
  const effective = dependencies.spawn(SSH_PATH, buildDirectSshEffectiveArguments(admission), Buffer.alloc(0), 15_000);
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null || effective.stderr.length !== 0) {
    throw new Error("M4F_RESIDUE_17_EFFECTIVE_CONFIG_FAILED");
  }
  auditDirectSshEffectiveConfig(effective.stdout, admission);
  if (sha256(effective.stdout) !== target.expected_effective_config_sha256) {
    throw new Error("M4F_RESIDUE_17_EFFECTIVE_CONFIG_MISMATCH");
  }
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) {
    throw new Error("M4F_RESIDUE_17_TRANSPORT_INPUT_DRIFT");
  }
  const raw = dependencies.spawn(SSH_PATH, [
    ...buildDirectSshOptions(admission), admission.target.host, buildResidueOwnership17Command(target),
  ], Buffer.alloc(0), LOCAL_TIMEOUT_MS);
  if (canonicalJson(inputs) !== canonicalJson(dependencies.transportInputs(admission, "network"))) {
    throw new Error("M4F_RESIDUE_17_TRANSPORT_INPUT_DRIFT");
  }
  const lastNewline = raw.stdout.lastIndexOf(0x0a);
  const tail = lastNewline < 0 ? raw.stdout : raw.stdout.subarray(lastNewline + 1);
  const predecessor = predecessorConfig(target);
  const markers = parseOwnership15Markers(raw.stdout, predecessor);
  const observation = deriveOwnership15Observation(markers, predecessor);
  const processOk = raw.status === 0 && raw.signal === null && raw.errorCode === null && raw.stderr.length === 0;
  const complete = markers.length === 4 && markers.every((marker) => marker.status !== "unknown") && tail.length === 0;
  return {
    process: raw,
    markers,
    observation,
    status: processOk && complete && observation !== null && observation.reasons.length === 0
      ? "ownership_observed" : "partial_unknown",
    trailing_fragment_length: tail.length,
    trailing_fragment_sha256: sha256(tail),
  };
}

function writeEvidence(directory: string, name: string, value: string | Buffer): void {
  const fd = openSync(directory + "/" + name, "wx", 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  chmodSync(directory + "/" + name, 0o600);
}

export function recordResidueOwnership17(
  rawConfig: unknown,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: Ownership17Dependencies,
): Ownership17Result {
  const config = validateResidueOwnership17Config(rawConfig);
  const target = config.script_config;
  const admissionBytes = dependencies.admissionConfigBytes(target.admission_config_path);
  if (sha256(admissionBytes) !== target.admission_config_sha256) throw new Error("M4F_RESIDUE_17_ADMISSION_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  if (confirmation !== residueOwnership17Confirmation(config, admission)) {
    throw new Error("M4F_RESIDUE_17_CONFIRMATION_REQUIRED");
  }
  validateCandidate17ScriptFrozenInputs(target, dependencies);
  validateCandidate16ParseSuccess(config, dependencies);
  const absolute = resolve(evidenceDirectory);
  if (absolute !== resolve(config.evidence_directory)) throw new Error("M4F_RESIDUE_17_EVIDENCE_PATH_MISMATCH");
  try { mkdirSync(absolute, { mode: 0o700 }); chmodSync(absolute, 0o700); } catch {
    throw new Error("M4F_RESIDUE_17_EVIDENCE_INVALID");
  }
  const startedAt = dependencies.now();
  let attemptCount = 0;
  let transportCount = 0;
  writeEvidence(absolute, "diagnostic-config.canonical.json", canonicalJson(config) + "\n");
  writeEvidence(absolute, "admission-config.raw.json", admissionBytes);
  writeEvidence(absolute, "plan.canonical.json", canonicalJson(residueOwnership17Plan(config, admission)) + "\n");
  writeEvidence(absolute, "confirmation.sha256", sha256(confirmation) + "\n");
  writeEvidence(absolute, "remote-script.ps1", buildResidueOwnership17Script(target));
  const command = buildResidueOwnership17Command(target);
  writeEvidence(absolute, "remote-command.json", JSON.stringify({
    length: command.length, sha256: sha256(Buffer.from(command, "ascii")), stdin_length: 0,
    attempt_count: 1, raw_command_stored: false,
  }, null, 2) + "\n");
  const wrapped: Ownership17Dependencies = {
    ...dependencies,
    spawn(executable, args, stdin, timeoutMs) {
      const label = args[0] === "-G" ? "ssh-effective" : "remote";
      if (label === "remote") attemptCount += 1;
      const processStarted = dependencies.now();
      const result = dependencies.spawn(executable, args, stdin, timeoutMs);
      const processEnded = dependencies.now();
      writeEvidence(absolute, label + "-stdout.raw", result.stdout);
      writeEvidence(absolute, label + "-stderr.raw", result.stderr);
      writeEvidence(absolute, label + "-process.json", JSON.stringify({
        attempt_count: label === "remote" ? attemptCount : 0,
        started_at_utc: processStarted.toISOString(), ended_at_utc: processEnded.toISOString(),
        exit_status: result.status, signal: result.signal, error_code: result.errorCode,
        stdin_length: stdin.length, stdin_sha256: sha256(stdin), stdout_length: result.stdout.length,
        stdout_sha256: sha256(result.stdout), stderr_length: result.stderr.length,
        stderr_sha256: sha256(result.stderr), retry_permitted: false,
      }, null, 2) + "\n");
      return result;
    },
    transportInputs(admissionConfig, stage) {
      const facts = dependencies.transportInputs(admissionConfig, stage);
      const label = ["initial", "pre_remote", "post_remote"][transportCount++];
      if (!label) throw new Error("M4F_RESIDUE_17_TRANSPORT_CAPTURE_OVERFLOW");
      writeEvidence(absolute, "transport-inputs-" + label + ".json", JSON.stringify(facts, null, 2) + "\n");
      return facts;
    },
  };
  try {
    const result = executeResidueOwnership17(config, admission, confirmation, wrapped);
    writeEvidence(absolute, "markers.json", JSON.stringify(result.markers, null, 2) + "\n");
    writeEvidence(absolute, "observation.json", JSON.stringify(result.observation, null, 2) + "\n");
    writeEvidence(absolute, "result.json", JSON.stringify({
      schema: "synthia-m4f-direct-residue-ownership-result.v6", diagnostic_id: config.diagnostic_id,
      status: result.status, reasons: result.observation?.reasons ?? ["snapshot_unavailable"],
      attempt_count: attemptCount, started_at_utc: startedAt.toISOString(), ended_at_utc: dependencies.now().toISOString(),
      stdin_length: 0, marker_count: result.markers.length,
      trailing_fragment_length: result.trailing_fragment_length,
      trailing_fragment_sha256: result.trailing_fragment_sha256, retry_permitted: false,
      cleanup_performed: false, cleanup_derivation_permitted: false,
    }, null, 2) + "\n");
    return result;
  } catch (error) {
    try {
      writeEvidence(absolute, "failure.json", JSON.stringify({
        error: error instanceof Error ? error.message : "UNKNOWN", attempt_count: attemptCount,
        started_at_utc: startedAt.toISOString(), ended_at_utc: dependencies.now().toISOString(),
        stdin_length: 0, retry_permitted: false, cleanup_performed: false,
        cleanup_derivation_permitted: false,
      }, null, 2) + "\n");
    } catch { /* preserve primary error */ }
    throw error;
  }
}

const systemDependencies: Ownership17Dependencies = {
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
  sourceBytes: () => readFileSync(new URL(import.meta.url)),
  testSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-17.test.ts", import.meta.url)),
  candidate15SourceBytes: () => readFileSync(new URL("./m4f-direct-residue-ownership-diagnostic-15.ts", import.meta.url)),
  candidate16SourceBytes: () => readFileSync(new URL("./m4f-direct-residue-ownership-diagnostic-16.ts", import.meta.url)),
  candidate16TestSourceBytes: () => readFileSync(new URL("../m4f-direct-residue-ownership-diagnostic-16.test.ts", import.meta.url)),
  parseLoaderSourceBytes: () => readFileSync(new URL("./m4f-residue-ownership-16-17-parse-loader.ts", import.meta.url)),
  transportSourceBytes: () => readFileSync(new URL("./m4f-gate-admission-transport.ts", import.meta.url)),
  frozenBytes: (path) => readFileSync(path),
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
  const config = validateResidueOwnership17Config(JSON.parse(readFileSync(args[2]!, "utf8")));
  if (executing) {
    const result = recordResidueOwnership17(config, args[4]!, args[6]!, systemDependencies);
    process.stdout.write(JSON.stringify({
      diagnostic_id: config.diagnostic_id, status: result.status,
      reasons: result.observation?.reasons ?? ["snapshot_unavailable"], marker_count: result.markers.length,
      retry_permitted: false, cleanup_performed: false, cleanup_derivation_permitted: false,
    }) + "\n");
    return;
  }
  validateCandidate17ScriptFrozenInputs(config.script_config, systemDependencies);
  validateCandidate16ParseSuccess(config, systemDependencies);
  const admissionBytes = systemDependencies.admissionConfigBytes(config.script_config.admission_config_path);
  if (sha256(admissionBytes) !== config.script_config.admission_config_sha256) throw new Error("M4F_RESIDUE_17_ADMISSION_MISMATCH");
  const admission = validateM4fDirectAdmissionConfig(JSON.parse(admissionBytes.toString("utf8")));
  process.stdout.write(JSON.stringify({
    ...residueOwnership17Plan(config, admission), config_sha256: sha256(Buffer.from(canonicalJson(config) + "\n")),
    plan_sha256: residueOwnership17PlanSha256(config, admission),
    confirmation: residueOwnership17Confirmation(config, admission),
  }) + "\n");
}

if (import.meta.main) main();
