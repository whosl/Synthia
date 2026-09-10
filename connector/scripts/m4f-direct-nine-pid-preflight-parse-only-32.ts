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
  buildCandidate31Script,
  CANDIDATE17_EVIDENCE_DIRECTORY,
  CANDIDATE17_MANIFEST,
  CANDIDATE17_MANIFEST_SHA256,
  CANDIDATE31_GZIP_LENGTH,
  CANDIDATE31_GZIP_SHA256,
  CANDIDATE31_HELPER_SHA256,
  CANDIDATE31_HELPERS_COMBINED_SHA256,
  CANDIDATE31_TARGET_LENGTH,
  CANDIDATE31_TARGET_SHA256,
  CANDIDATE30_EVIDENCE_DIRECTORY,
  CANDIDATE30_MANIFEST,
  CANDIDATE30_MANIFEST_SHA256,
  CANDIDATE30_RECORD_SHA256,
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

const SSH_PATH = "/usr/bin/ssh";
const TARGET_HOST = "100.96.223.49";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const EFFECTIVE_CONFIG_SHA256 = "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = /^[0-9a-f]{64}$/u;
const COMMAND_LIMIT = 7_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;

export const CANDIDATE32_ID = "m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32";
export const CANDIDATE32_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32-evidence";

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-nine-pid-preflight-parse-only-32.test.ts", import.meta.url));
const CANDIDATE31_SOURCE_PATH = fileURLToPath(
  new URL("./m4f-direct-attempt2-residue-nine-pid-preflight-31.ts", import.meta.url),
);
const CANDIDATE31_TEST_PATH = fileURLToPath(
  new URL("../m4f-direct-attempt2-residue-nine-pid-preflight-31.test.ts", import.meta.url),
);

export interface Candidate32Config {
  schema: "synthia-m4f-direct-nine-pid-preflight-parse-only-32-config.v1";
  probe_id: typeof CANDIDATE32_ID;
  evidence_directory: typeof CANDIDATE32_EVIDENCE_DIRECTORY;
  candidate30_evidence_directory: typeof CANDIDATE30_EVIDENCE_DIRECTORY;
  candidate30_evidence_manifest_sha256: typeof CANDIDATE30_MANIFEST_SHA256;
  candidate30_record_sha256: typeof CANDIDATE30_RECORD_SHA256;
  candidate17_evidence_directory: typeof CANDIDATE17_EVIDENCE_DIRECTORY;
  candidate17_evidence_manifest_sha256: typeof CANDIDATE17_MANIFEST_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_candidate31_source_sha256: string;
  expected_candidate31_test_sha256: string;
}

export interface Candidate32Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate32Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE32_FAILED"));
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new Candidate32Failure({
    schema: "synthia-m4f-direct-nine-pid-preflight-parse-only-32-failure.v1",
    code,
    stage,
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

export function validateCandidate32Config(value: unknown): Candidate32Config {
  const config = object(value);
  const keys = [
    "candidate17_evidence_directory", "candidate17_evidence_manifest_sha256",
    "candidate30_evidence_directory", "candidate30_evidence_manifest_sha256",
    "candidate30_record_sha256", "evidence_directory", "expected_candidate31_source_sha256",
    "expected_candidate31_test_sha256", "expected_source_sha256", "expected_test_sha256",
    "probe_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-nine-pid-preflight-parse-only-32-config.v1"
    || config.probe_id !== CANDIDATE32_ID
    || config.evidence_directory !== CANDIDATE32_EVIDENCE_DIRECTORY
    || config.candidate30_evidence_directory !== CANDIDATE30_EVIDENCE_DIRECTORY
    || config.candidate30_evidence_manifest_sha256 !== CANDIDATE30_MANIFEST_SHA256
    || config.candidate30_record_sha256 !== CANDIDATE30_RECORD_SHA256
    || config.candidate17_evidence_directory !== CANDIDATE17_EVIDENCE_DIRECTORY
    || config.candidate17_evidence_manifest_sha256 !== CANDIDATE17_MANIFEST_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_candidate31_source_sha256, config.expected_candidate31_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE32_CONFIG_INVALID", "config");
  }
  return value as Candidate32Config;
}

function readExpected(
  dependencies: Candidate32Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE32_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) fail("M4F_CANDIDATE32_INPUT_DRIFT", "local_preflight", { path });
  return bytes;
}

export function buildCandidate32Payload() {
  const targetScript = buildCandidate31Script();
  const targetBytes = Buffer.from(targetScript, "utf8");
  const compressed = gzipSync(targetBytes, { level: 9 });
  const loader = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$Compressed=[Convert]::FromBase64String('" + compressed.toString("base64") + "')",
    "$Gzip=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($Compressed),[IO.Compression.CompressionMode]::Decompress)",
    "$Reader=[IO.StreamReader]::new($Gzip,[Text.UTF8Encoding]::new($false,$true))",
    "$Target=$Reader.ReadToEnd()",
    "$Tokens=$null",
    "$Errors=$null",
    "$Ast=[Management.Automation.Language.Parser]::ParseInput($Target,[ref]$Tokens,[ref]$Errors)",
    "[Console]::Out.WriteLine(('r32|{0}|{1}|{2}|{3}|{4}' -f ([Text.Encoding]::UTF8.GetByteCount($Target)),$Errors.Count,$Ast.GetType().Name,($null -ne $Ast.EndBlock),'" + sha256(targetBytes) + "'))",
  ].join(";");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \""
    + loader + "\"";
  const parserCallCount = loader.match(/Parser\]::ParseInput/gu)?.length ?? 0;
  const forbidden = /ScriptBlock\]::Create|Invoke-Expression|Get-CimInstance|MSFT_NetTCPConnection|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado|program_hw|&\s*\$Target/iu.test(loader);
  if (command.length > COMMAND_LIMIT || parserCallCount !== 1 || forbidden
    || targetBytes.length !== CANDIDATE31_TARGET_LENGTH || sha256(targetBytes) !== CANDIDATE31_TARGET_SHA256
    || compressed.length !== CANDIDATE31_GZIP_LENGTH || sha256(compressed) !== CANDIDATE31_GZIP_SHA256) {
    fail("M4F_CANDIDATE32_PAYLOAD_INVALID", "config", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      parser_call_count: parserCallCount,
      forbidden,
    });
  }
  return {
    targetScript,
    targetHash: sha256(targetBytes),
    targetLength: targetBytes.length,
    compressedHash: sha256(compressed),
    compressedLength: compressed.length,
    loader,
    loaderHash: sha256(loader),
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

function validateCandidate30Evidence(dependencies: Candidate32Dependencies): void {
  const names = Object.keys(CANDIDATE30_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE30_EVIDENCE_DIRECTORY)) !== canonicalJson(names)
    || sha256(canonicalJson(CANDIDATE30_MANIFEST) + "\n") !== CANDIDATE30_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE32_CANDIDATE30_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of names) readExpected(
    dependencies,
    CANDIDATE30_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE30_MANIFEST[name as keyof typeof CANDIDATE30_MANIFEST],
  );
  const record = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE30_EVIDENCE_DIRECTORY + "/inventory-record.json",
    CANDIDATE30_RECORD_SHA256,
  ).toString("utf8")));
  const result = object(record?.inventory_result);
  const snapshot = object(result?.snapshot);
  if (!record || record.status !== "observed" || result?.status !== "observed"
    || result.candidate_count !== 3 || !Array.isArray(snapshot?.candidates) || snapshot.candidates.length !== 3
    || result.protected_worker_exact !== true || result.listener_exact !== true
    || record.cleanup_performed !== false || record.retry_permitted !== false) {
    fail("M4F_CANDIDATE32_CANDIDATE30_RECORD_INVALID", "local_preflight");
  }
}

function validateCandidate17Evidence(dependencies: Candidate32Dependencies): void {
  const names = Object.keys(CANDIDATE17_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE17_EVIDENCE_DIRECTORY)) !== canonicalJson(names)
    || sha256(canonicalJson(CANDIDATE17_MANIFEST) + "\n") !== CANDIDATE17_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE32_CANDIDATE17_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of names) readExpected(
    dependencies,
    CANDIDATE17_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE17_MANIFEST[name as keyof typeof CANDIDATE17_MANIFEST],
  );
  const observation = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE17_EVIDENCE_DIRECTORY + "/observation.json",
    CANDIDATE17_MANIFEST["observation.json"],
  ).toString("utf8")));
  if (!observation || !Array.isArray(observation.targets) || observation.targets.length !== 4
    || !Array.isArray(observation.candidates) || observation.candidates.length !== 2
    || observation.targets.some((value) => object(value)?.cim_microseconds_match !== true)
    || observation.candidates.some((value) => object(value)?.current_cmd_state !== "present")) {
    fail("M4F_CANDIDATE32_CANDIDATE17_OBSERVATION_INVALID", "local_preflight");
  }
}

function loadContext(rawConfig: unknown, dependencies: Candidate32Dependencies) {
  const config = validateCandidate32Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, CANDIDATE31_SOURCE_PATH, config.expected_candidate31_source_sha256);
  readExpected(dependencies, CANDIDATE31_TEST_PATH, config.expected_candidate31_test_sha256);
  validateCandidate30Evidence(dependencies);
  validateCandidate17Evidence(dependencies);
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE32_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, payload: buildCandidate32Payload() };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-nine-pid-preflight-parse-only-32-plan.v1",
    probe_id: CANDIDATE32_ID,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "one_effective_audit_then_one_direct_ssh_empty_stdin",
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    gzip_sha256: context.payload.compressedHash,
    gzip_length: context.payload.compressedLength,
    loader_sha256: context.payload.loaderHash,
    command_sha256: context.payload.commandHash,
    command_length: context.payload.command.length,
    candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
    candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
    candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
    candidate31_source_sha256: context.config.expected_candidate31_source_sha256,
    candidate31_test_sha256: context.config.expected_candidate31_test_sha256,
    target_contract_sha256: CANDIDATE31_TARGET_SHA256,
    gzip_contract_sha256: CANDIDATE31_GZIP_SHA256,
    helper_contract_sha256: CANDIDATE31_HELPER_SHA256,
    helpers_combined_contract_sha256: CANDIDATE31_HELPERS_COMBINED_SHA256,
    parser_call_count: 1,
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

export function planCandidate32(rawConfig: unknown, dependencies: Candidate32Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE32_EXACT_NINE_PID_PREFLIGHT_PARSE_ONLY",
    CANDIDATE32_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.targetHash,
    context.payload.loaderHash,
    context.payload.commandHash,
    CANDIDATE30_MANIFEST_SHA256,
    CANDIDATE30_RECORD_SHA256,
    CANDIDATE17_MANIFEST_SHA256,
  ].join(":");
}

export function candidate32Confirmation(rawConfig: unknown, dependencies: Candidate32Dependencies): string {
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

function validateOutput(stdout: Buffer, context: ReturnType<typeof loadContext>) {
  let fields: string[];
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(stdout);
    if (!text.endsWith("\n") || text.trim().split(/\r?\n/u).length !== 1) throw new Error("shape");
    fields = text.trim().split("|");
  } catch {
    fail("M4F_CANDIDATE32_STDOUT_INVALID", "network");
  }
  if (fields.length !== 6 || fields[0] !== "r32"
    || Number(fields[1]) !== context.payload.targetLength || fields[2] !== "0"
    || fields[3] !== "ScriptBlockAst" || fields[4] !== "True"
    || fields[5] !== context.payload.targetHash) {
    fail("M4F_CANDIDATE32_PARSE_REJECTED", "network", {
      parse_error_count: fields[2] ?? null,
      ast_type: fields[3] ?? null,
      end_block_present: fields[4] ?? null,
      observed_target_sha256: fields[5] ?? null,
    });
  }
  return {
    target_script_sha256: context.payload.targetHash,
    target_script_length: Number(fields[1]),
    parse_error_count: 0,
    ast_type: "ScriptBlockAst",
    end_block_present: true,
    target_body_invoked: false,
    cim_executed: false,
    stdin_length: 0,
  };
}

function write(dependencies: Candidate32Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE32_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate32(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate32Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE32_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE32_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  const plan = planFor(context);
  write(dependencies, context.config.evidence_directory, "probe-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, context.config.evidence_directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, context.config.evidence_directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, context.config.evidence_directory, "target-preflight-script.ps1", context.payload.targetScript);
  write(dependencies, context.config.evidence_directory, "parser-loader.ps1", context.payload.loader);
  write(dependencies, context.config.evidence_directory, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
  const effective = dependencies.spawn(
    SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, context.config.evidence_directory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, context.config.evidence_directory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, context.config.evidence_directory, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE32_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE32_INPUT_DRIFT", "local_preflight");
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
    fail("M4F_CANDIDATE32_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE32_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE32_STDERR_REJECTED", "network");
  const parseResult = validateOutput(remote.stdout, context);
  const record = {
    schema: "synthia-m4f-direct-nine-pid-preflight-parse-only-32-record.v1",
    probe_id: CANDIDATE32_ID,
    status: "exact_target_parse_zero",
    recorded_at_utc: dependencies.now().toISOString(),
    parse_result: parseResult,
    target_script_sha256: context.payload.targetHash,
    candidate30_evidence_manifest_sha256: CANDIDATE30_MANIFEST_SHA256,
    candidate30_record_sha256: CANDIDATE30_RECORD_SHA256,
    candidate17_evidence_manifest_sha256: CANDIDATE17_MANIFEST_SHA256,
    candidate31_source_sha256: context.config.expected_candidate31_source_sha256,
    candidate31_test_sha256: context.config.expected_candidate31_test_sha256,
    target_contract_sha256: CANDIDATE31_TARGET_SHA256,
    gzip_contract_sha256: CANDIDATE31_GZIP_SHA256,
    helper_contract_sha256: CANDIDATE31_HELPER_SHA256,
    helpers_combined_contract_sha256: CANDIDATE31_HELPERS_COMBINED_SHA256,
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

const systemDependencies: Candidate32Dependencies = {
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
      const plan = planCandidate32(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate32Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate32(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate32Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE32_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
