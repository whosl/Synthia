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
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = /^[0-9a-f]{64}$/u;
const COMMAND_LIMIT = 7_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;
const TARGET_SCRIPT_SHA256 = "31b4c637ce9d1ddbfe3b7438a967b2ef50353fcfeb46ea3f9f2eea3a58f543e2";
const CANDIDATE27_HELPER_SCRIPT_SHA256 =
  "3f6801930f792f8f800c7fd43fd3ee5d4bcd3c35a1bd52044f9cfec2e5054239";
const X_SHA256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

export const CANDIDATE28_ID = "m4f-direct-attempt2-residue-parse-probe-prod-20260830-28";
export const CANDIDATE28_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-parse-probe-prod-20260830-28-evidence";
export const CANDIDATE27_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-helper-smoke-prod-20260830-27-evidence";
export const CANDIDATE27_MANIFEST_SHA256 =
  "2954135ba44777516575362cd9f7b044121f2955f23d2955b64ab811508ae193";
export const CANDIDATE27_RECORD_SHA256 =
  "146b8aa4f8f45ece7fb5b9ad240e4774d7824e07d3c7a9499f4b717493214bbc";
export const CANDIDATE27_MANIFEST = {
  "confirmation.sha256": "68d215e64898bc3181b85ad1b27059ffce2fadf2745cdb0bc173bc385d602c10",
  "helper-smoke.ps1": CANDIDATE27_HELPER_SCRIPT_SHA256,
  "plan.canonical.json": "d04be7fa471018de6d7817c75465d7e763269b73549aeb068d75fac12ddfa908",
  "probe-config.canonical.json": "cefe96e7be3262d0a9a90517f328478d0b974dbd823a33f28bb3bb9e9d03cf58",
  "probe-record.json": CANDIDATE27_RECORD_SHA256,
  "remote-process.json": "a241a6c7b6bfc9c56f56169976555fd8f35efd9b11bd94a233ed74096d8fd65e",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_CONFIG_SHA256,
  "stderr.raw": EMPTY_SHA256,
  "stdout.raw": "ff42177831e3db782cd9555e9e78c3004b63ea6bed9fe00369bad631db8d28ab",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-parse-probe-28.test.ts", import.meta.url));
const INVENTORY_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url));
const INVENTORY_TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url));

export interface Candidate28Config {
  schema: "synthia-m4f-direct-attempt2-residue-parse-probe-28-config.v1";
  probe_id: typeof CANDIDATE28_ID;
  evidence_directory: typeof CANDIDATE28_EVIDENCE_DIRECTORY;
  candidate27_evidence_directory: typeof CANDIDATE27_EVIDENCE_DIRECTORY;
  candidate27_evidence_manifest_sha256: typeof CANDIDATE27_MANIFEST_SHA256;
  candidate27_record_sha256: typeof CANDIDATE27_RECORD_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_inventory_source_sha256: string;
  expected_inventory_test_sha256: string;
}

export interface Candidate28Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate28Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE28_FAILED"));
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
  throw new Candidate28Failure({
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-28-failure.v1",
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

export function validateCandidate28Config(value: unknown): Candidate28Config {
  const config = object(value);
  const keys = [
    "candidate27_evidence_directory", "candidate27_evidence_manifest_sha256",
    "candidate27_record_sha256", "evidence_directory",
    "expected_inventory_source_sha256", "expected_inventory_test_sha256",
    "expected_source_sha256", "expected_test_sha256", "probe_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-attempt2-residue-parse-probe-28-config.v1"
    || config.probe_id !== CANDIDATE28_ID
    || config.evidence_directory !== CANDIDATE28_EVIDENCE_DIRECTORY
    || config.candidate27_evidence_directory !== CANDIDATE27_EVIDENCE_DIRECTORY
    || config.candidate27_evidence_manifest_sha256 !== CANDIDATE27_MANIFEST_SHA256
    || config.candidate27_record_sha256 !== CANDIDATE27_RECORD_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_inventory_source_sha256, config.expected_inventory_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE28_CONFIG_INVALID", "config");
  }
  return value as Candidate28Config;
}

function readExpected(
  dependencies: Candidate28Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE28_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("M4F_CANDIDATE28_INPUT_DRIFT", "local_preflight", { path });
  }
  return bytes;
}

export function buildCandidate28Payload(inventoryConfig: ResidueInventoryConfig) {
  const targetScript = buildResidueInventoryScript(inventoryConfig);
  const targetBytes = Buffer.from(targetScript, "utf8");
  const compressed = gzipSync(targetBytes, { level: 9 });
  const targetHash = sha256(targetBytes);
  const loader = [
    "$ProgressPreference='SilentlyContinue'",
    "$z=[Convert]::FromBase64String('" + compressed.toString("base64") + "')",
    "$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress)",
    "$r=[IO.StreamReader]::new($g)",
    "$x=$r.ReadToEnd()",
    "$t=$null;$e=$null",
    "$a=[Management.Automation.Language.Parser]::ParseInput($x,[ref]$t,[ref]$e)",
    "Write-Output ('r28|{0}|{1}|{2}|{3}' -f ([Text.Encoding]::UTF8.GetByteCount($x)),$e.Count,$a.GetType().Name,($null -ne $a.EndBlock))",
  ].join(";");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(loader, "utf16le").toString("base64");
  const forbidden = /function\s|SHA256|ScriptBlock\]::Create|Invoke-Expression|Get-CimInstance|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado|program_hw/iu.test(loader);
  const parserCallCount = loader.match(/Parser\]::ParseInput/gu)?.length ?? 0;
  if (command.length > COMMAND_LIMIT || forbidden || parserCallCount !== 1
    || targetHash !== TARGET_SCRIPT_SHA256) {
    fail("M4F_CANDIDATE28_PAYLOAD_INVALID", "config", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      forbidden,
      parser_call_count: parserCallCount,
      target_script_sha256: targetHash,
    });
  }
  return {
    targetScript,
    targetHash,
    targetLength: targetBytes.length,
    compressedHash: sha256(compressed),
    compressedLength: compressed.length,
    loader,
    loaderHash: sha256(loader),
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

function loadContext(rawConfig: unknown, dependencies: Candidate28Dependencies) {
  const config = validateCandidate28Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, INVENTORY_SOURCE_PATH, config.expected_inventory_source_sha256);
  readExpected(dependencies, INVENTORY_TEST_PATH, config.expected_inventory_test_sha256);
  const candidate27Names = Object.keys(CANDIDATE27_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE27_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate27Names)
    || sha256(canonicalJson(CANDIDATE27_MANIFEST) + "\n") !== CANDIDATE27_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE28_CANDIDATE27_EVIDENCE_INVALID", "local_preflight");
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
  const helperRow = object(helperResult?.row);
  if (!candidate27Record || candidate27Record.status !== "exact_helpers_runtime_smoked"
    || candidate27Record.helper_script_sha256 !== CANDIDATE27_HELPER_SCRIPT_SHA256
    || helperResult?.helper_definition_count !== 2 || helperResult.hash_x !== X_SHA256
    || helperResult.row_count !== 10 || helperRow?.pid !== 1 || helperRow.ppid !== 2
    || helperRow.name !== "cmd.exe" || helperRow.creation_utc !== null
    || helperRow.session_id !== 0 || helperRow.command_line_present !== true
    || helperRow.command_line_length !== 3 || helperRow.command_line_sha256 !== ABC_SHA256
    || helperRow.root !== 4 || helperRow.excluded !== false
    || candidate27Record.target_body_invoked !== false || candidate27Record.cim_executed !== false
    || candidate27Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE28_CANDIDATE27_RECORD_INVALID", "local_preflight");
  }
  const inventoryConfig = JSON.parse(readExpected(
    dependencies, INVENTORY_CONFIG_PATH, INVENTORY_CONFIG_SHA256,
  ).toString("utf8")) as ResidueInventoryConfig;
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE28_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, payload: buildCandidate28Payload(inventoryConfig) };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-28-plan.v1",
    probe_id: CANDIDATE28_ID,
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
    candidate27_evidence_manifest_sha256: CANDIDATE27_MANIFEST_SHA256,
    candidate27_record_sha256: CANDIDATE27_RECORD_SHA256,
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

export function planCandidate28(rawConfig: unknown, dependencies: Candidate28Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE28_EXACT_INVENTORY_PARSE_ONLY",
    CANDIDATE28_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.targetHash,
    context.payload.loaderHash,
    context.payload.commandHash,
  ].join(":");
}

export function candidate28Confirmation(rawConfig: unknown, dependencies: Candidate28Dependencies): string {
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
    fail("M4F_CANDIDATE28_STDOUT_INVALID", "network");
  }
  if (fields.length !== 5 || fields[0] !== "r28"
    || Number(fields[1]) !== context.payload.targetLength || fields[2] !== "0"
    || fields[3] !== "ScriptBlockAst" || fields[4] !== "True") {
    fail("M4F_CANDIDATE28_PARSE_REJECTED", "network", {
      parse_error_count: fields[2] ?? null,
      ast_type: fields[3] ?? null,
      end_block_present: fields[4] ?? null,
    });
  }
  return {
    target_script_sha256: context.payload.targetHash,
    target_script_length: Number(fields[1]),
    parse_error_count: Number(fields[2]),
    ast_type: fields[3],
    end_block_present: true,
    target_body_invoked: false,
    cim_executed: false,
    stdin_length: 0,
  };
}

function write(dependencies: Candidate28Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE28_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate28(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate28Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE28_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE28_EVIDENCE_CREATE_FAILED", "local_preflight");
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
    fail("M4F_CANDIDATE28_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE28_INPUT_DRIFT", "local_preflight");
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
    fail("M4F_CANDIDATE28_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE28_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE28_STDERR_REJECTED", "network");
  const result = validateOutput(remote.stdout, context);
  const record = {
    schema: "synthia-m4f-direct-attempt2-residue-parse-probe-28-record.v1",
    probe_id: CANDIDATE28_ID,
    status: "parsed_not_invoked",
    recorded_at_utc: dependencies.now().toISOString(),
    target_script_sha256: context.payload.targetHash,
    target_script_length: context.payload.targetLength,
    parser_result: result,
    candidate27_evidence_manifest_sha256: CANDIDATE27_MANIFEST_SHA256,
    candidate27_record_sha256: CANDIDATE27_RECORD_SHA256,
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

const systemDependencies: Candidate28Dependencies = {
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
      const plan = planCandidate28(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate28Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate28(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate28Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE28_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
