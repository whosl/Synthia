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
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildResidueInventoryScript, type ResidueInventoryConfig } from "./m4f-direct-attempt2-residue-inventory-21.ts";
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
const INVENTORY_CONFIG_PATH =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-21-evidence/inventory-config.canonical.json";
const INVENTORY_CONFIG_SHA256 = "06b71eb82cc9067ffbd9d02ffec26b4f02b2acb7272561e83a772a3300f1992b";
const FAILED_REMOTE_PROCESS_PATH =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-21-evidence/remote-process.json";
const FAILED_REMOTE_PROCESS_SHA256 = "f06464f8f26794cfc83b1187fe71e3f19a40e77cb97370b9b83e53ebc409c00d";
const FAILED_STDERR_PATH =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-21-evidence/stderr.raw";
const FAILED_STDERR_SHA256 = "75f4d4b934ec5a6f1f10afa828c36b8d3474aefe0cab3c0d66dfd270046ef75b";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_SHA256_BASE64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const HASH = /^[0-9a-f]{64}$/u;
const COMMAND_LIMIT = 7_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;

export const CANDIDATE22_ID = "m4f-direct-attempt2-residue-parse-probe-prod-20260830-22";
export const CANDIDATE22_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-parse-probe-prod-20260830-22-evidence";

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-parse-probe-22.test.ts", import.meta.url));
const INVENTORY_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url));
const INVENTORY_TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url));

export interface Candidate22Config {
  schema: "synthia-m4f-direct-attempt2-residue-parse-probe-config.v1";
  probe_id: typeof CANDIDATE22_ID;
  evidence_directory: typeof CANDIDATE22_EVIDENCE_DIRECTORY;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_inventory_source_sha256: string;
  expected_inventory_test_sha256: string;
}

export interface Candidate22Dependencies {
  read(path: string): Buffer;
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate22Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE22_FAILED"));
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
  throw new Candidate22Failure({
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-failure.v1",
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validateCandidate22Config(value: unknown): Candidate22Config {
  const config = object(value);
  const keys = [
    "evidence_directory", "expected_inventory_source_sha256", "expected_inventory_test_sha256",
    "expected_source_sha256", "expected_test_sha256", "probe_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-attempt2-residue-parse-probe-config.v1"
    || config.probe_id !== CANDIDATE22_ID
    || config.evidence_directory !== CANDIDATE22_EVIDENCE_DIRECTORY
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_inventory_source_sha256, config.expected_inventory_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE22_CONFIG_INVALID", "config");
  }
  return value as Candidate22Config;
}

function readExpected(
  dependencies: Candidate22Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE22_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("M4F_CANDIDATE22_INPUT_DRIFT", "local_preflight", { path });
  }
  return bytes;
}

export function buildCandidate22Payload(inventoryConfig: ResidueInventoryConfig) {
  const targetScript = buildResidueInventoryScript(inventoryConfig);
  const targetBytes = Buffer.from(targetScript, "utf8");
  const compressed = gzipSync(targetBytes, { level: 9 });
  const targetHash = sha256(targetBytes);
  const targetHashBase64 = createHash("sha256").update(targetBytes).digest("base64");
  const loader = [
    "$z=[Convert]::FromBase64String('" + compressed.toString("base64") + "')",
    "$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress)",
    "$r=[IO.StreamReader]::new($g)",
    "$x=$r.ReadToEnd()",
    "$u=[Text.Encoding]::UTF8;$q=[Security.Cryptography.SHA256]::Create()",
    "function H($s){[Convert]::ToBase64String($q.ComputeHash($u.GetBytes([string]$s)))}",
    "$t=0;$e=0",
    "$a=[Management.Automation.Language.Parser]::ParseInput($x,[ref]$t,[ref]$e)",
    "Write-Output ('r22|{0}|{1}|{2}|{3}|{4}' -f (H $x),$u.GetByteCount($x),$e.Count,(H ($e.ErrorId -join '|')),$a.GetType().Name)",
  ].join(";");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(loader, "utf16le").toString("base64");
  const forbidden = /ScriptBlock\]::Create|Invoke-Expression|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado|program_hw/iu.test(loader);
  const parserCallCount = loader.match(/Parser\]::ParseInput/gu)?.length ?? 0;
  if (command.length > COMMAND_LIMIT || forbidden || parserCallCount !== 1) {
    fail("M4F_CANDIDATE22_PAYLOAD_INVALID", "config", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      forbidden,
      parser_call_count: parserCallCount,
    });
  }
  return {
    targetScript,
    targetHash,
    targetHashBase64,
    targetLength: targetBytes.length,
    compressedHash: sha256(compressed),
    compressedLength: compressed.length,
    loader,
    loaderHash: sha256(loader),
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

function loadContext(rawConfig: unknown, dependencies: Candidate22Dependencies) {
  const config = validateCandidate22Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, INVENTORY_SOURCE_PATH, config.expected_inventory_source_sha256);
  readExpected(dependencies, INVENTORY_TEST_PATH, config.expected_inventory_test_sha256);
  readExpected(dependencies, FAILED_REMOTE_PROCESS_PATH, FAILED_REMOTE_PROCESS_SHA256);
  readExpected(dependencies, FAILED_STDERR_PATH, FAILED_STDERR_SHA256);
  const inventoryConfig = JSON.parse(readExpected(
    dependencies, INVENTORY_CONFIG_PATH, INVENTORY_CONFIG_SHA256,
  ).toString("utf8")) as ResidueInventoryConfig;
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE22_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, payload: buildCandidate22Payload(inventoryConfig) };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-plan.v1",
    probe_id: CANDIDATE22_ID,
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
    parser_call_count: 1,
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

export function planCandidate22(rawConfig: unknown, dependencies: Candidate22Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE22_EXACT_INVENTORY_PARSE_ONLY",
    CANDIDATE22_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.targetHash,
    context.payload.loaderHash,
    context.payload.commandHash,
  ].join(":");
}

export function candidate22Confirmation(rawConfig: unknown, dependencies: Candidate22Dependencies): string {
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
    fail("M4F_CANDIDATE22_STDOUT_INVALID", "network");
  }
  if (fields.length !== 6 || fields[0] !== "r22"
    || fields[1] !== context.payload.targetHashBase64 || Number(fields[2]) !== context.payload.targetLength
    || fields[3] !== "0" || fields[4] !== EMPTY_SHA256_BASE64 || fields[5] !== "ScriptBlockAst") {
    fail("M4F_CANDIDATE22_PARSE_REJECTED", "network", {
      parse_error_count: fields[3] ?? null,
      parse_error_sha256: fields[4] ?? null,
    });
  }
  return {
    target_script_sha256: fields[1],
    target_script_length: Number(fields[2]),
    parse_error_count: Number(fields[3]),
    parse_error_sha256: fields[4],
    ast_type: fields[5],
    target_body_invoked: false,
    cim_executed: false,
    stdin_length: 0,
  };
}

function write(dependencies: Candidate22Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE22_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate22(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate22Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE22_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE22_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  const plan = planFor(context);
  write(dependencies, context.config.evidence_directory, "probe-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, context.config.evidence_directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, context.config.evidence_directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, context.config.evidence_directory, "target-inventory-script.ps1", context.payload.targetScript);
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
    fail("M4F_CANDIDATE22_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE22_INPUT_DRIFT", "local_preflight");
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
    fail("M4F_CANDIDATE22_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE22_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE22_STDERR_REJECTED", "network");
  const result = validateOutput(remote.stdout, context);
  const record = {
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-record.v1",
    probe_id: CANDIDATE22_ID,
    status: "parsed_not_invoked",
    recorded_at_utc: dependencies.now().toISOString(),
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    parser_result: result,
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

const systemDependencies: Candidate22Dependencies = {
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
      const plan = planCandidate22(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate22Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate22(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate22Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE22_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
