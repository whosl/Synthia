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
  INVENTORY_HASH_HELPER,
  INVENTORY_ROW_HELPER,
} from "./m4f-direct-attempt2-residue-inventory-21.ts";
import {
  CANDIDATE25_EVIDENCE_DIRECTORY,
  CANDIDATE25_MANIFEST,
  CANDIDATE25_MANIFEST_SHA256,
  CANDIDATE25_RECORD_SHA256,
} from "./m4f-direct-attempt2-residue-inventory-26.ts";
export {
  CANDIDATE25_EVIDENCE_DIRECTORY,
  CANDIDATE25_MANIFEST,
  CANDIDATE25_MANIFEST_SHA256,
  CANDIDATE25_RECORD_SHA256,
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
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = /^[0-9a-f]{64}$/u;
const COMMAND_LIMIT = 7_000;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 20_000;
const X_SHA256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

export const CANDIDATE27_ID = "m4f-direct-attempt2-residue-helper-smoke-prod-20260830-27";
export const CANDIDATE27_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-helper-smoke-prod-20260830-27-evidence";
export const CANDIDATE26_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-inventory-prod-20260830-26-evidence";
export const CANDIDATE26_MANIFEST_SHA256 =
  "2aea0ad20e98d512a71183b34aed09009c727390c294d2d5c335999d24bdad75";
export const CANDIDATE26_MANIFEST = {
  "confirmation.sha256": "be27c240573b0af866f583daee3049cdf53f295b9b4cdc0437ddb0cd9d190ed3",
  "inventory-config.canonical.json": "4612c6b558f175d4e67a064306484fd5c04e25be7022d46c498c50be27cae368",
  "plan.canonical.json": "38f4d24cacd271622362bb4202beaef7c6d3f63eda2bfbd17717007fbf2324c0",
  "remote-process.json": "86a521ff56197a07b6c7eed3f59991c46f9721a7afd35f3f4aad0550f25e19e6",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": EFFECTIVE_CONFIG_SHA256,
  "stderr.raw": "47bf1c40582fa31dc55dcc0f2dad860d1b7504345146f5c0996015b1ced0028b",
  "stdout.raw": "f4dfd158a7daad7c357f123736812ddf6d89e2a982343c1214d590291b45912e",
  "target-inventory-script.ps1": "6b4b30d6ba96cc62a58fe1049d61522276fd5724930a79159bd0bd9468ac3ded",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const SOURCE_PATH = fileURLToPath(import.meta.url);
const TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-helper-smoke-27.test.ts", import.meta.url));
const INVENTORY_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-attempt2-residue-inventory-21.ts", import.meta.url));
const INVENTORY_TEST_PATH = fileURLToPath(new URL("../m4f-direct-attempt2-residue-inventory-21.test.ts", import.meta.url));

export interface Candidate27Config {
  schema: "synthia-m4f-direct-attempt2-residue-helper-smoke-27-config.v1";
  probe_id: typeof CANDIDATE27_ID;
  evidence_directory: typeof CANDIDATE27_EVIDENCE_DIRECTORY;
  candidate25_evidence_directory: typeof CANDIDATE25_EVIDENCE_DIRECTORY;
  candidate25_evidence_manifest_sha256: typeof CANDIDATE25_MANIFEST_SHA256;
  candidate25_record_sha256: typeof CANDIDATE25_RECORD_SHA256;
  candidate26_evidence_directory: typeof CANDIDATE26_EVIDENCE_DIRECTORY;
  candidate26_evidence_manifest_sha256: typeof CANDIDATE26_MANIFEST_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_inventory_source_sha256: string;
  expected_inventory_test_sha256: string;
}

export interface Candidate27Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidence(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate27Failure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE27_FAILED"));
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
  throw new Candidate27Failure({
    schema: "synthia-m4f-direct-attempt2-residue-helper-smoke-27-failure.v1",
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

export function validateCandidate27Config(value: unknown): Candidate27Config {
  const config = object(value);
  const keys = [
    "candidate25_evidence_directory", "candidate25_evidence_manifest_sha256",
    "candidate25_record_sha256",
    "candidate26_evidence_directory", "candidate26_evidence_manifest_sha256", "evidence_directory",
    "expected_inventory_source_sha256", "expected_inventory_test_sha256",
    "expected_source_sha256", "expected_test_sha256", "probe_id", "schema",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-attempt2-residue-helper-smoke-27-config.v1"
    || config.probe_id !== CANDIDATE27_ID
    || config.evidence_directory !== CANDIDATE27_EVIDENCE_DIRECTORY
    || config.candidate25_evidence_directory !== CANDIDATE25_EVIDENCE_DIRECTORY
    || config.candidate25_evidence_manifest_sha256 !== CANDIDATE25_MANIFEST_SHA256
    || config.candidate25_record_sha256 !== CANDIDATE25_RECORD_SHA256
    || config.candidate26_evidence_directory !== CANDIDATE26_EVIDENCE_DIRECTORY
    || config.candidate26_evidence_manifest_sha256 !== CANDIDATE26_MANIFEST_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_inventory_source_sha256, config.expected_inventory_test_sha256]
      .some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
    fail("M4F_CANDIDATE27_CONFIG_INVALID", "config");
  }
  return value as Candidate27Config;
}

function readExpected(
  dependencies: Candidate27Dependencies,
  path: string,
  expectedSha256: string,
): Buffer {
  let bytes: Buffer;
  try { bytes = dependencies.read(path); } catch {
    fail("M4F_CANDIDATE27_INPUT_MISSING", "local_preflight", { path });
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("M4F_CANDIDATE27_INPUT_DRIFT", "local_preflight", { path });
  }
  return bytes;
}

export function buildCandidate27Payload() {
  const helperScript = [
    INVENTORY_HASH_HELPER,
    INVENTORY_ROW_HELPER,
    "$d=[pscustomobject]@{CommandLine='abc';ProcessId=1;ParentProcessId=2;Name='CMD.EXE'}",
    "$h=Get-SynthiaM4fInventoryHash 'x'",
    "$w=ConvertTo-SynthiaM4fInventoryRow $d 4 $false",
    "@('r27',$h,$w.Count,$w[0],$w[1],$w[2],$w[3],$w[4],$w[5],$w[6],$w[7],$w[8],$w[9])-join'|'",
  ].join(";");
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(helperScript, "utf16le").toString("base64");
  const forbidden = /Invoke-Expression|ScriptBlock|Parser|GZip|ReadToEnd|Get-CimInstance|Stop-Process|\.Kill\s*\(|Set-Content|Out-File|Vivado|program_hw/iu.test(helperScript);
  const helperDefinitionCount = helperScript.match(
    /function\s+(?:Get-SynthiaM4fInventoryHash|ConvertTo-SynthiaM4fInventoryRow)/gu,
  )?.length ?? 0;
  const helperSourceExact = helperScript.startsWith(INVENTORY_HASH_HELPER + ";" + INVENTORY_ROW_HELPER + ";");
  if (command.length > COMMAND_LIMIT || forbidden || helperDefinitionCount !== 2 || !helperSourceExact
    || /function\s+[A-Za-z](?:\s|\()/u.test(helperScript) || /\([A-Za-z]\s+\$/u.test(helperScript)) {
    fail("M4F_CANDIDATE27_PAYLOAD_INVALID", "config", {
      command_length: command.length,
      command_limit: COMMAND_LIMIT,
      forbidden,
      helper_definition_count: helperDefinitionCount,
      helper_source_exact: helperSourceExact,
    });
  }
  return {
    helperScript,
    helperScriptHash: sha256(helperScript),
    helperScriptLength: Buffer.byteLength(helperScript),
    command,
    commandHash: sha256(Buffer.from(command, "ascii")),
  };
}

function loadContext(rawConfig: unknown, dependencies: Candidate27Dependencies) {
  const config = validateCandidate27Config(rawConfig);
  readExpected(dependencies, SOURCE_PATH, config.expected_source_sha256);
  readExpected(dependencies, TEST_PATH, config.expected_test_sha256);
  readExpected(dependencies, INVENTORY_SOURCE_PATH, config.expected_inventory_source_sha256);
  readExpected(dependencies, INVENTORY_TEST_PATH, config.expected_inventory_test_sha256);
  const candidate25Names = Object.keys(CANDIDATE25_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE25_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate25Names)
    || sha256(canonicalJson(CANDIDATE25_MANIFEST) + "\n") !== CANDIDATE25_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE27_CANDIDATE25_EVIDENCE_INVALID", "local_preflight");
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
  const candidate25Parser = object(candidate25Record?.parser_result);
  if (!candidate25Record || candidate25Record.status !== "parsed_not_invoked"
    || candidate25Parser?.parse_error_count !== 0
    || candidate25Parser.ast_type !== "ScriptBlockAst"
    || candidate25Parser.end_block_present !== true
    || candidate25Record.target_body_invoked !== false
    || candidate25Record.cim_executed !== false
    || candidate25Record.retry_permitted !== false) {
    fail("M4F_CANDIDATE27_CANDIDATE25_RECORD_INVALID", "local_preflight");
  }
  const candidate26Names = Object.keys(CANDIDATE26_MANIFEST).sort();
  if (canonicalJson(dependencies.entries(CANDIDATE26_EVIDENCE_DIRECTORY))
    !== canonicalJson(candidate26Names)
    || sha256(canonicalJson(CANDIDATE26_MANIFEST) + "\n") !== CANDIDATE26_MANIFEST_SHA256) {
    fail("M4F_CANDIDATE27_CANDIDATE26_EVIDENCE_INVALID", "local_preflight");
  }
  for (const name of candidate26Names) readExpected(
    dependencies,
    CANDIDATE26_EVIDENCE_DIRECTORY + "/" + name,
    CANDIDATE26_MANIFEST[name as keyof typeof CANDIDATE26_MANIFEST],
  );
  const transport = validateM4fDirectAdmissionConfig(JSON.parse(readExpected(
    dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256,
  ).toString("utf8")));
  if (transport.target.host !== TARGET_HOST
    || transport.target.expected_effective_config_sha256 !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE27_TRANSPORT_INVALID", "local_preflight");
  }
  return { config, transport, payload: buildCandidate27Payload() };
}

function planFor(context: ReturnType<typeof loadContext>) {
  return {
    schema: "synthia-m4f-direct-attempt2-residue-helper-smoke-27-plan.v1",
    probe_id: CANDIDATE27_ID,
    status: "planned_not_executed",
    target_host: TARGET_HOST,
    topology: "one_effective_audit_then_one_direct_ssh_empty_stdin",
    helper_script_sha256: context.payload.helperScriptHash,
    helper_script_length: context.payload.helperScriptLength,
    command_sha256: context.payload.commandHash,
    command_length: context.payload.command.length,
    candidate25_evidence_manifest_sha256: CANDIDATE25_MANIFEST_SHA256,
    candidate25_record_sha256: CANDIDATE25_RECORD_SHA256,
    candidate26_evidence_manifest_sha256: CANDIDATE26_MANIFEST_SHA256,
    parser_call_count: 0,
    helper_definition_count: 2,
    helper_smoke_call_count: 2,
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

export function planCandidate27(rawConfig: unknown, dependencies: Candidate27Dependencies) {
  return planFor(loadContext(rawConfig, dependencies));
}

function confirmationFor(context: ReturnType<typeof loadContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE27_EXACT_HELPER_RUNTIME_SMOKE_READ_ONLY",
    CANDIDATE27_ID,
    sha256(canonicalJson(context.config) + "\n"),
    sha256(canonicalJson(planFor(context)) + "\n"),
    context.payload.helperScriptHash,
    context.payload.commandHash,
  ].join(":");
}

export function candidate27Confirmation(rawConfig: unknown, dependencies: Candidate27Dependencies): string {
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
    fail("M4F_CANDIDATE27_STDOUT_INVALID", "network");
  }
  if (fields.length !== 13 || fields[0] !== "r27" || fields[1] !== X_SHA256
    || fields[2] !== "10" || fields[3] !== "1" || fields[4] !== "2"
    || fields[5] !== "cmd.exe" || fields[6] !== "" || fields[7] !== "0"
    || fields[8] !== "True" || fields[9] !== "3" || fields[10] !== ABC_SHA256
    || fields[11] !== "4" || fields[12] !== "False") {
    fail("M4F_CANDIDATE27_HELPER_SMOKE_REJECTED", "network", {
      field_count: fields.length,
      hash_x: fields[1] ?? null,
      row_count: fields[2] ?? null,
    });
  }
  return {
    helper_script_sha256: context.payload.helperScriptHash,
    helper_definition_count: 2,
    hash_x: fields[1],
    row_count: Number(fields[2]),
    row: {
      pid: Number(fields[3]),
      ppid: Number(fields[4]),
      name: fields[5],
      creation_utc: null,
      session_id: Number(fields[7]),
      command_line_present: true,
      command_line_length: Number(fields[9]),
      command_line_sha256: fields[10],
      root: Number(fields[11]),
      excluded: false,
    },
    target_body_invoked: false,
    cim_executed: false,
    stdin_length: 0,
  };
}

function write(dependencies: Candidate27Dependencies, directory: string, name: string, value: string | Buffer): void {
  try {
    dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value));
  } catch {
    fail("M4F_CANDIDATE27_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

export function executeCandidate27(
  rawConfig: unknown,
  confirmation: string,
  dependencies: Candidate27Dependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  if (confirmation !== confirmationFor(context)) fail("M4F_CANDIDATE27_CONFIRMATION_REQUIRED", "local_preflight");
  const initial = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidence(context.config.evidence_directory); } catch {
    fail("M4F_CANDIDATE27_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  const plan = planFor(context);
  write(dependencies, context.config.evidence_directory, "probe-config.canonical.json", canonicalJson(context.config) + "\n");
  write(dependencies, context.config.evidence_directory, "plan.canonical.json", canonicalJson(plan) + "\n");
  write(dependencies, context.config.evidence_directory, "confirmation.sha256", sha256(confirmation) + "\n");
  write(dependencies, context.config.evidence_directory, "helper-smoke.ps1", context.payload.helperScript);
  write(dependencies, context.config.evidence_directory, "transport-inputs-initial.json", JSON.stringify(initial, null, 2) + "\n");
  const effective = dependencies.spawn(
    SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
  );
  write(dependencies, context.config.evidence_directory, "ssh-effective-stdout.raw", effective.stdout);
  write(dependencies, context.config.evidence_directory, "ssh-effective-stderr.raw", effective.stderr);
  write(dependencies, context.config.evidence_directory, "ssh-effective-process.json", JSON.stringify(processEvidence(effective), null, 2) + "\n");
  if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
    || effective.stderr.length !== 0 || sha256(effective.stdout) !== EFFECTIVE_CONFIG_SHA256) {
    fail("M4F_CANDIDATE27_EFFECTIVE_FAILED", "local_preflight");
  }
  auditDirectSshEffectiveConfig(effective.stdout, context.transport);
  const pre = dependencies.transportInputs(context.transport, "network");
  if (canonicalJson(pre) !== canonicalJson(initial)
    || confirmationFor(loadContext(rawConfig, dependencies)) !== confirmation) {
    fail("M4F_CANDIDATE27_INPUT_DRIFT", "local_preflight");
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
    fail("M4F_CANDIDATE27_POSTFLIGHT_DRIFT", "network_postflight");
  }
  if (remote.status !== 0 || remote.signal !== null || remote.errorCode !== null) {
    fail("M4F_CANDIDATE27_REMOTE_FAILED", "network", processEvidence(remote));
  }
  if (remote.stderr.length !== 0) fail("M4F_CANDIDATE27_STDERR_REJECTED", "network");
  const result = validateOutput(remote.stdout, context);
  const record = {
    schema: "synthia-m4f-direct-attempt2-residue-helper-smoke-27-record.v1",
    probe_id: CANDIDATE27_ID,
    status: "exact_helpers_runtime_smoked",
    recorded_at_utc: dependencies.now().toISOString(),
    helper_script_sha256: context.payload.helperScriptHash,
    helper_script_length: context.payload.helperScriptLength,
    helper_result: result,
    candidate25_evidence_manifest_sha256: CANDIDATE25_MANIFEST_SHA256,
    candidate25_record_sha256: CANDIDATE25_RECORD_SHA256,
    candidate26_evidence_manifest_sha256: CANDIDATE26_MANIFEST_SHA256,
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

const systemDependencies: Candidate27Dependencies = {
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
      const plan = planCandidate27(config, systemDependencies);
      process.stdout.write(JSON.stringify({ plan, confirmation: candidate27Confirmation(config, systemDependencies) }) + "\n");
      return;
    }
    if (args.length === 5 && args[0] === "--execute" && args[3] === "--confirmation") {
      process.stdout.write(JSON.stringify(executeCandidate27(config, args[4]!, systemDependencies)) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate27Failure ? error.detail : {
      code: error instanceof Error ? error.message : "M4F_CANDIDATE27_UNEXPECTED",
      retry_permitted: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
