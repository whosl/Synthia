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
const TARGET_SCRIPT_SHA256 = "6b4b30d6ba96cc62a58fe1049d61522276fd5724930a79159bd0bd9468ac3ded";

export const CANDIDATE26_ID = "m4f-direct-attempt2-residue-inventory-prod-20260830-26";
export const CANDIDATE26_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-26-evidence";
export const CANDIDATE25_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-parse-probe-prod-20260830-25-evidence";
export const CANDIDATE25_MANIFEST_SHA256 =
  "5275eff19fb3590f9d4d3380de683b86c0d243262bc5ae636d6010665ba92bb6";
export const CANDIDATE25_RECORD_SHA256 =
  "fc4b6226dfcfba9fc2971a7dae6d638bb07c4a733ebc474ec31a13ee585eef3f";
export const CANDIDATE25_MANIFEST = {
  "confirmation.sha256": "91a8c75ee0af4f52a9d69cad1de11ee05da70f7985ceeb463c0dcc50e8768357",
  "parser-loader.ps1": "4b00e61279fe2ef5adfc6d692eaf0f29839b69cb39e1d1d8e0238e01a3a3ae4c",
  "plan.canonical.json": "5cf57d8a919401936334f54fd75c5b867e2fe0aab4d2e1d9725eb34edcbe73ba",
  "probe-config.canonical.json": "bb071d9d6ce4d4237bc0cc3c0952ba7cfa58df0856cc8084bd3b10eacdfd298e",
  "probe-record.json": CANDIDATE25_RECORD_SHA256,
  "remote-process.json": "ba8cb76df17a03157787dafeb54db666a8d46c082f065bdfd14982efab2dfc0d",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_CONFIG_SHA256,
  "stderr.raw": EMPTY_SHA256,
  "stdout.raw": "15a58ff5a0ac618f383c497d58240fe179212a172201b965a3238a80f08940a4",
  "target-inventory-script.ps1": "6b4b30d6ba96cc62a58fe1049d61522276fd5724930a79159bd0bd9468ac3ded",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-26.test.ts", import.meta.url));
const INVENTORY_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url));
const INVENTORY_TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url));

export interface Candidate26Config {
  schema: "synthia-m4f-direct-attempt2-residue-inventory-26-config.v1";
  inventory_id: typeof CANDIDATE26_ID;
  evidence_directory: typeof CANDIDATE26_EVIDENCE_DIRECTORY;
  candidate25_evidence_directory: typeof CANDIDATE25_EVIDENCE_DIRECTORY;
  candidate25_evidence_manifest_sha256: typeof CANDIDATE25_MANIFEST_SHA256;
  candidate25_record_sha256: typeof CANDIDATE25_RECORD_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_inventory_source_sha256: string;
  expected_inventory_test_sha256: string;
}

export interface Candidate26Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate26Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE26_FAILED"));
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
  throw new Candidate26Failure({
    schema: "synthia-m4f-direct-attempt2-residue-inventory-26-failure.v1",
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

export function validateCandidate26Config(value: unknown): Candidate26Config {
  const config = object(value);
  const keys = [
    "candidate25_evidence_directory", "candidate25_evidence_manifest_sha256",
    "candidate25_record_sha256", "evidence_directory",
    "expected_inventory_source_sha256", "expected_inventory_test_sha256",
    "expected_source_sha256", "expected_test_sha256", "inventory_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-attempt2-residue-inventory-26-config.v1"
    || config.inventory_id !== CANDIDATE26_ID
    || config.evidence_directory !== CANDIDATE26_EVIDENCE_DIRECTORY
    || config.candidate25_evidence_directory !== CANDIDATE25_EVIDENCE_DIRECTORY
    || config.candidate25_evidence_manifest_sha256 !== CANDIDATE25_MANIFEST_SHA256
    || config.candidate25_record_sha256 !== CANDIDATE25_RECORD_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_inventory_source_sha256, config.expected_inventory_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE26_CONFIG_INVALID", "config");
  }
  return value as Candidate26Config;
}

function readExpected(
  dependencies: Candidate26Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE26_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("M4F_CANDIDATE26_INPUT_DRIFT", "local_preflight", { path });
  }
  return bytes;
}

export function buildCandidate26Payload(inventoryConfig: ResidueInventoryConfig) {
  const targetScript = buildResidueInventoryScript(inventoryConfig);
  const targetBytes = Buffer.from(targetScript, "utf8");
  const targetHash = sha256(targetBytes);
  const command = buildResidueInventoryCommand(inventoryConfig);
  const forbidden = candidate26HasForbiddenMutation(targetScript);
  if (targetHash !== TARGET_SCRIPT_SHA256 || command.length > COMMAND_LIMIT || forbidden) {
    fail("M4F_CANDIDATE26_PAYLOAD_INVALID", "config", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      forbidden,
      target_script_sha256: targetHash,
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

export function candidate26HasForbiddenMutation(script: string): boolean {
  return /(?:^|[;\s])Stop-Process(?:[\s;]|$)|\.Kill\s*\(|(?:^|[;\s])Set-Content(?:[\s;]|$)|(?:^|[;\s])Out-File(?:[\s;]|$)|(?:^|[;\s])Vivado(?:\.exe|\s|;|$)|(?:^|[;\s])program_hw(?:_devices)?(?:[\s;]|$)/iu
    .test(script);
}

function loadContext(rawConfig: unknown, dependencies: Candidate26Dependencies) {
  const config = validateCandidate26Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, INVENTORY_SOURCE_PATH, config.expected_inventory_source_sha256);
  readExpected(dependencies, INVENTORY_TEST_PATH, config.expected_inventory_test_sha256);
  const candidate25Names = Object.keys(CANDIDATE25_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE25_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate25Names)
    || sha256(canonicalJson(CANDIDATE25_MANIFEST) + "\n") !== CANDIDATE25_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE26_CANDIDATE25_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of candidate25Names) readExpected(
    dependencies,
    CANDIDATE25_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE25_MANIFEST[name as keyof typeof CANDIDATE25_MANIFEST],
  );
  const candidate25Record = object(JSON.parse(readExpected(
    dependencies,
    CANDIDATE25_EVIDENCE_DIRECTORY + "/probe-record.json",
    CANDIDATE25_RECORD_SHA256,
  ).toString("utf8")));
  const parserResult = object(candidate25Record?.parser_result);
  if (!candidate25Record || candidate25Record.status !== "parsed_not_invoked"
    || candidate25Record.target_script_sha256 !== TARGET_SCRIPT_SHA256
    || !parserResult || parserResult.parse_error_count !== 0
    || parserResult.ast_type !== "ScriptBlockAst" || parserResult.end_block_present !== true
    || candidate25Record.target_body_invoked !== false || candidate25Record.cim_executed !== false
    || candidate25Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE26_CANDIDATE25_RECORD_INVALID", "local_preflight");
  }
  const inventoryConfig = JSON.parse(readExpected(
    dependencies, INVENTORY_CONFIG_PATH, INVENTORY_CONFIG_SHA256,
  ).toString("utf8")) as ResidueInventoryConfig;
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE26_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, targetConfig: inventoryConfig, payload: buildCandidate26Payload(inventoryConfig) };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-26-plan.v1",
    inventory_id: CANDIDATE26_ID,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "one_effective_audit_then_one_direct_ssh_empty_stdin",
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    command_sha256: context.payload.commandHash,
    command_length: context.payload.command.length,
    candidate25_evidence_manifest_sha256: CANDIDATE25_MANIFEST_SHA256,
    candidate25_record_sha256: CANDIDATE25_RECORD_SHA256,
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

export function planCandidate26(rawConfig: unknown, dependencies: Candidate26Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE26_EXACT_READ_ONLY_INVENTORY",
    CANDIDATE26_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.targetHash,
    context.payload.commandHash,
    CANDIDATE25_MANIFEST_SHA256,
    CANDIDATE25_RECORD_SHA256,
  ].join(":");
}

export function candidate26Confirmation(rawConfig: unknown, dependencies: Candidate26Dependencies): string {
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

function write(dependencies: Candidate26Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE26_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate26(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate26Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE26_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE26_EVIDENCE_CREATE_FAILED", "local_preflight");
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
    fail("M4F_CANDIDATE26_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE26_INPUT_DRIFT", "local_preflight");
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
    fail("M4F_CANDIDATE26_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE26_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE26_STDERR_REJECTED", "network");
  let result: Record<string, unknown>;
  try {
    result = validateResidueInventoryOutput(remote.stdout, context.targetConfig);
  } catch {
    fail("M4F_CANDIDATE26_INVENTORY_OUTPUT_INVALID", "network");
  }
  const record = {
    schema: "synthia-m4f-direct-attempt2-residue-inventory-26-record.v1",
    inventory_id: CANDIDATE26_ID,
    status: "observed",
    recorded_at_utc: dependencies.now().toISOString(),
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    inventory_result: result,
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

const systemDependencies: Candidate26Dependencies = {
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
      const plan = planCandidate26(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate26Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate26(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate26Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE26_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
