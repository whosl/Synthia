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
  buildResidueInventoryCommand,
  buildResidueInventoryScript,
  validateResidueInventoryOutput,
  type ResidueInventoryConfig,
} from "./m4f-direct-attempt2-residue-inventory-21.ts";
import {
  CANDIDATE27_EVIDENCE_DIRECTORY,
  CANDIDATE27_MANIFEST,
  CANDIDATE27_MANIFEST_SHA256,
  CANDIDATE27_RECORD_SHA256,
} from "./m4f-direct-attempt2-residue-parse-probe-28.ts";
export {
  CANDIDATE27_EVIDENCE_DIRECTORY,
  CANDIDATE27_MANIFEST,
  CANDIDATE27_MANIFEST_SHA256,
  CANDIDATE27_RECORD_SHA256,
};
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
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = /^[0-9a-f]{64}$/u;
const COMMAND_LIMIT = 7_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;
const TARGET_SCRIPT_SHA256 = "31b4c637ce9d1ddbfe3b7438a967b2ef50353fcfeb46ea3f9f2eea3a58f543e2";
const TARGET_SCRIPT_LENGTH = 3_642;
const CANDIDATE27_HELPER_SCRIPT_SHA256 =
  "3f6801930f792f8f800c7fd43fd3ee5d4bcd3c35a1bd52044f9cfec2e5054239";

export const CANDIDATE29_ID = "m4f-direct-attempt2-residue-inventory-prod-20260830-29";
export const CANDIDATE29_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-29-evidence";
export const CANDIDATE28_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-parse-probe-prod-20260830-28-evidence";
export const CANDIDATE28_MANIFEST_SHA256 =
  "0f72a761bf40c92903f20d310722251e7d5f2f72f1b4f56f57e89d5ea53217c4";
export const CANDIDATE28_RECORD_SHA256 =
  "4f2e6d338f901323b15db41d7fa134a854dae55eb196b678c6b659206665eb14";
export const CANDIDATE28_MANIFEST = {
  "confirmation.sha256": "90cc8b7cbc8f85e9d10d8d285de80881ca45b7be8b1dfe5f52e4d51c012e7be6",
  "parser-loader.ps1": "2967e20394b54b4e1fde22b7ce02b94a47ad7faaf1bdffcde12fad70c3905a65",
  "plan.canonical.json": "f03e2559286499a2bcdd8c4f3ded2ac2bd8a7e7d4da08a6569224bf2e29e8dfc",
  "probe-config.canonical.json": "0f69be298e4f94d99bb5b531822f9d8fa9b32b1093411bda3ce72c876adb9cd2",
  "probe-record.json": CANDIDATE28_RECORD_SHA256,
  "remote-process.json": "2b8fd1c645efc5ccc2e869e9d15dcf7591e1478359968034a6941146834e3bed",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_CONFIG_SHA256,
  "stderr.raw": EMPTY_SHA256,
  "stdout.raw": "16981826ec8cb17a3b69026c6462d090f69405104ceb3aa708888b4daf0f9415",
  "target-inventory-script.ps1": TARGET_SCRIPT_SHA256,
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-29.test.ts", import.meta.url));
const INVENTORY_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url));
const INVENTORY_TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url));

export interface Candidate29Config {
  schema: "synthia-m4f-direct-attempt2-residue-inventory-29-config.v1";
  inventory_id: typeof CANDIDATE29_ID;
  evidence_directory: typeof CANDIDATE29_EVIDENCE_DIRECTORY;
  candidate27_evidence_directory: typeof CANDIDATE27_EVIDENCE_DIRECTORY;
  candidate27_evidence_manifest_sha256: typeof CANDIDATE27_MANIFEST_SHA256;
  candidate27_record_sha256: typeof CANDIDATE27_RECORD_SHA256;
  candidate28_evidence_directory: typeof CANDIDATE28_EVIDENCE_DIRECTORY;
  candidate28_evidence_manifest_sha256: typeof CANDIDATE28_MANIFEST_SHA256;
  candidate28_record_sha256: typeof CANDIDATE28_RECORD_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_inventory_source_sha256: string;
  expected_inventory_test_sha256: string;
}

export interface Candidate29Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate29Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE29_FAILED"));
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
  throw new Candidate29Failure({
    schema: "synthia-m4f-direct-attempt2-residue-inventory-29-failure.v1",
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

export function validateCandidate29Config(value: unknown): Candidate29Config {
  const config = object(value);
  const keys = [
    "candidate27_evidence_directory", "candidate27_evidence_manifest_sha256",
    "candidate27_record_sha256", "candidate28_evidence_directory",
    "candidate28_evidence_manifest_sha256", "candidate28_record_sha256", "evidence_directory",
    "expected_inventory_source_sha256", "expected_inventory_test_sha256",
    "expected_source_sha256", "expected_test_sha256", "inventory_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-attempt2-residue-inventory-29-config.v1"
    || config.inventory_id !== CANDIDATE29_ID
    || config.evidence_directory !== CANDIDATE29_EVIDENCE_DIRECTORY
    || config.candidate27_evidence_directory !== CANDIDATE27_EVIDENCE_DIRECTORY
    || config.candidate27_evidence_manifest_sha256 !== CANDIDATE27_MANIFEST_SHA256
    || config.candidate27_record_sha256 !== CANDIDATE27_RECORD_SHA256
    || config.candidate28_evidence_directory !== CANDIDATE28_EVIDENCE_DIRECTORY
    || config.candidate28_evidence_manifest_sha256 !== CANDIDATE28_MANIFEST_SHA256
    || config.candidate28_record_sha256 !== CANDIDATE28_RECORD_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_inventory_source_sha256, config.expected_inventory_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE29_CONFIG_INVALID", "config");
  }
  return value as Candidate29Config;
}

function readExpected(
  dependencies: Candidate29Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE29_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("M4F_CANDIDATE29_INPUT_DRIFT", "local_preflight", { path });
  }
  return bytes;
}

export function buildCandidate29Payload(inventoryConfig: ResidueInventoryConfig) {
  const targetScript = buildResidueInventoryScript(inventoryConfig);
  const targetBytes = Buffer.from(targetScript, "utf8");
  const targetHash = sha256(targetBytes);
  const command = buildResidueInventoryCommand(inventoryConfig);
  const forbidden = candidate29HasForbiddenMutation(targetScript);
  if (targetHash !== TARGET_SCRIPT_SHA256 || targetBytes.length !== TARGET_SCRIPT_LENGTH
    || command.length > COMMAND_LIMIT || forbidden) {
    fail("M4F_CANDIDATE29_PAYLOAD_INVALID", "config", {
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
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

export function candidate29HasForbiddenMutation(script: string): boolean {
  return /(?:^|[;\s])Stop-Process(?:[\s;]|$)|\.Kill\s*\(|(?:^|[;\s])Set-Content(?:[\s;]|$)|(?:^|[;\s])Out-File(?:[\s;]|$)|(?:^|[;\s])Vivado(?:\.exe|\s|;|$)|(?:^|[;\s])program_hw(?:_devices)?(?:[\s;]|$)/iu
    .test(script);
}

function loadContext(rawConfig: unknown, dependencies: Candidate29Dependencies) {
  const config = validateCandidate29Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, INVENTORY_SOURCE_PATH, config.expected_inventory_source_sha256);
  readExpected(dependencies, INVENTORY_TEST_PATH, config.expected_inventory_test_sha256);
  const candidate27Names = Object.keys(CANDIDATE27_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE27_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate27Names)
    || sha256(canonicalJson(CANDIDATE27_MANIFEST) + "\n") !== CANDIDATE27_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE29_CANDIDATE27_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of candidate27Names) readExpected(
    dependencies,
    CANDIDATE27_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE27_MANIFEST[name as keyof typeof CANDIDATE27_MANIFEST],
  );
  const candidate27Record = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE27_EVIDENCE_DIRECTORY + "/probe-record.json",
    CANDIDATE27_RECORD_SHA256,
  ).toString("utf8")));
  const helperResult = object(candidate27Record?.helper_result);
  if (!candidate27Record || candidate27Record.status !== "exact_helpers_runtime_smoked"
    || candidate27Record.helper_script_sha256 !== CANDIDATE27_HELPER_SCRIPT_SHA256
    || helperResult?.helper_definition_count !== 2 || helperResult.row_count !== 10
    || candidate27Record.target_body_invoked !== false || candidate27Record.cim_executed !== false
    || candidate27Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE29_CANDIDATE27_RECORD_INVALID", "local_preflight");
  }
  const candidate28Names = Object.keys(CANDIDATE28_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE28_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate28Names)
    || sha256(canonicalJson(CANDIDATE28_MANIFEST) + "\n") !== CANDIDATE28_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE29_CANDIDATE28_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of candidate28Names) readExpected(
    dependencies,
    CANDIDATE28_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE28_MANIFEST[name as keyof typeof CANDIDATE28_MANIFEST],
  );
  const candidate28Record = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE28_EVIDENCE_DIRECTORY + "/probe-record.json",
    CANDIDATE28_RECORD_SHA256,
  ).toString("utf8")));
  const parserResult = object(candidate28Record?.parser_result);
  if (!candidate28Record || candidate28Record.status !== "parsed_not_invoked"
    || candidate28Record.target_script_sha256 !== TARGET_SCRIPT_SHA256
    || candidate28Record.target_script_length !== TARGET_SCRIPT_LENGTH
    || !parserResult || parserResult.parse_error_count !== 0
    || parserResult.ast_type !== "ScriptBlockAst" || parserResult.end_block_present !== true
    || candidate28Record.target_body_invoked !== false || candidate28Record.cim_executed !== false
    || candidate28Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE29_CANDIDATE28_RECORD_INVALID", "local_preflight");
  }
  const inventoryConfig = JSON.parse(readExpected(
    dependencies, INVENTORY_CONFIG_PATH, INVENTORY_CONFIG_SHA256,
  ).toString("utf8")) as ResidueInventoryConfig;
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE29_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, targetConfig: inventoryConfig, payload: buildCandidate29Payload(inventoryConfig) };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-29-plan.v1",
    inventory_id: CANDIDATE29_ID,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "one_effective_audit_then_one_direct_ssh_empty_stdin",
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    command_sha256: context.payload.commandHash,
    command_length: context.payload.command.length,
    candidate27_evidence_manifest_sha256: CANDIDATE27_MANIFEST_SHA256,
    candidate27_record_sha256: CANDIDATE27_RECORD_SHA256,
    candidate28_evidence_manifest_sha256: CANDIDATE28_MANIFEST_SHA256,
    candidate28_record_sha256: CANDIDATE28_RECORD_SHA256,
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

export function planCandidate29(rawConfig: unknown, dependencies: Candidate29Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE29_EXACT_READ_ONLY_INVENTORY",
    CANDIDATE29_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.targetHash,
    context.payload.commandHash,
    CANDIDATE27_MANIFEST_SHA256,
    CANDIDATE27_RECORD_SHA256,
    CANDIDATE28_MANIFEST_SHA256,
    CANDIDATE28_RECORD_SHA256,
  ].join(":");
}

export function candidate29Confirmation(rawConfig: unknown, dependencies: Candidate29Dependencies): string {
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

function write(dependencies: Candidate29Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE29_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate29(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate29Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE29_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE29_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  const plan = planFor(context);
  write(dependencies, context.config.evidence_directory, "inventory-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, context.config.evidence_directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, context.config.evidence_directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, context.config.evidence_directory, "target-inventory-script.ps1", context.payload.targetScript);
  write(dependencies, context.config.evidence_directory, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
  const effective = dependencies.spawn(
    SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, context.config.evidence_directory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, context.config.evidence_directory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, context.config.evidence_directory, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE29_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE29_INPUT_DRIFT", "local_preflight");
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
    fail("M4F_CANDIDATE29_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE29_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE29_STDERR_REJECTED", "network");
  let result: Record<string, unknown>;
  try {
    result = validateResidueInventoryOutput(remote.stdout, context.targetConfig);
  } catch {
    fail("M4F_CANDIDATE29_INVENTORY_OUTPUT_INVALID", "network");
  }
  const record = {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-29-record.v1",
    inventory_id: CANDIDATE29_ID,
    status: "observed",
    recorded_at_utc: dependencies.now().toISOString(),
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    inventory_result: result,
    candidate27_evidence_manifest_sha256: CANDIDATE27_MANIFEST_SHA256,
    candidate27_record_sha256: CANDIDATE27_RECORD_SHA256,
    candidate28_evidence_manifest_sha256: CANDIDATE28_MANIFEST_SHA256,
    candidate28_record_sha256: CANDIDATE28_RECORD_SHA256,
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
  write(dependencies, context.config.evidence_directory, "inventory-record.json", JSON.stringify(record, null, 2) + "\n");
  return record;
}

const systemDependencies: Candidate29Dependencies = {
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
      const plan = planCandidate29(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate29Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate29(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate29Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE29_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
