import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildCandidate18Payload,
  validateCandidate18Config,
  validateCandidate18Result,
  type Candidate18Payload,
} from "./m4f-direct-six-process-parse-only-18.ts";
import { validateCandidate19ScriptConfig } from "./m4f-direct-six-process-cleanup-19.ts";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
export const C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY =
  "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
export const C18_PROGRESS_ONLY_SOURCE_PATH = fileURLToPath(import.meta.url);
export const C18_PROGRESS_ONLY_TEST_SOURCE_PATH = fileURLToPath(new URL(
  "../m4f-direct-six-process-progress-only-adjudicator-18.test.ts",
  import.meta.url,
));
const PARSE_ID = "m4f-direct-six-process-parse-only-prod-20260829-18";
const C18_SOURCE_SHA256 = "c48fb7edd8e0915786d65d0858fec7032734d6cd12a1db58ec7cb0fb3cd5734d";
const C18_TEST_SHA256 = "b23c108fcb537b862ed7e64b9c010712726331816dab0a18a8b8f5f8d70e739c";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const C18_PROGRESS_ONLY_EVIDENCE_HASHES = {
  "candidate19-script-config.raw.json": "be33526bfd69ed606a117af32538f2f18c6fe146f9551588d22e6b3191685b76",
  "confirmation.sha256": "2bfe3c8c15a4f74816074a79900f1d146504d420befa56821c6603377286414a",
  "frozen-file-facts-initial.json": "eb80d8b84df21f22ef4ed43d7a352f5eb5b32b99a116fd672dacb46c628b02b3",
  "frozen-file-facts-post-remote.json": "eb80d8b84df21f22ef4ed43d7a352f5eb5b32b99a116fd672dacb46c628b02b3",
  "frozen-file-facts-pre-remote.json": "eb80d8b84df21f22ef4ed43d7a352f5eb5b32b99a116fd672dacb46c628b02b3",
  "parse-config.canonical.json": "051077fae982440fecdddc29014f8119da1aa9469cb0cd1836b2cc1e9c2d12ce",
  "parse-failure.json": "5e5fa1af1105bb6ad68b6f9d1d29165cdcd8081db2f8b11c661512a47a3d3bd1",
  "parse-loader.ps1": "4392f7ab596b1dbc6f7ccf56f6204bd354f074721450d5fd40bb42585a670a80",
  "plan.canonical.json": "17285cfc64496a789ef71ae8f618316484136fb8d255e6c21b06d152fd20b9ae",
  "remote-process.json": "48f99c5fa8fc2dc166072c39db8270a0554fc222ae97d305524d54380e04fa82",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": EMPTY_SHA256,
  "ssh-effective-stdout.raw": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90",
  "stderr.raw": "3b3bb0e26a8ed84cc061107dcbd8fe050bd0c551afc94478665a674375c5a8ae",
  "stdout.raw": "fdd080ab9e7d5b9a8752cbd2986c52231ad54a1d629f26bdb5f58dc27399ed8b",
  "target-business-script.ps1": "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c",
  "target-outer-loader.ps1": "9d6d908becc22a50148db392f2d3245927e4051e4a11f1b3db7591a8dc4ff216",
  "transport-config.raw.json": "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

const EVIDENCE_NAMES = Object.keys(C18_PROGRESS_ONLY_EVIDENCE_HASHES).sort();

export interface C18ProgressOnlyStatFact {
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  kind: "file" | "directory";
  symbolic_link: boolean;
}

export interface C18ProgressOnlyBoundFile
  extends Omit<C18ProgressOnlyStatFact, "kind" | "symbolic_link"> {
  schema: "synthia-m4f-c18-progress-only-bound-file.v1";
  path: string;
  sha256: string;
}

export interface C18ProgressOnlyBoundDirectory
  extends Omit<C18ProgressOnlyStatFact, "kind" | "symbolic_link" | "size"> {
  schema: "synthia-m4f-c18-progress-only-bound-directory.v1";
  path: typeof C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY;
  entries: string[];
}

export interface C18ProgressOnlyBoundImplementationFile
  extends Omit<C18ProgressOnlyStatFact, "kind" | "symbolic_link"> {
  schema: "synthia-m4f-c18-progress-only-bound-implementation-file.v1";
  path: string;
  sha256: string;
}

export interface C18ProgressOnlyConfig {
  schema: "synthia-m4f-c18-progress-only-adjudicator-config.v1";
  adjudication_id: string;
  evidence_directory: C18ProgressOnlyBoundDirectory;
  evidence_files: Record<string, C18ProgressOnlyBoundFile>;
  source_file: C18ProgressOnlyBoundImplementationFile;
  test_source_file: C18ProgressOnlyBoundImplementationFile;
}

export interface C18ProgressOnlyFileCapture {
  path_before: C18ProgressOnlyStatFact;
  handle_before: C18ProgressOnlyStatFact;
  bytes: Buffer;
  handle_after: C18ProgressOnlyStatFact;
  path_after: C18ProgressOnlyStatFact;
}

export interface C18ProgressOnlyDirectoryCapture {
  before: C18ProgressOnlyStatFact;
  entries: string[];
  after: C18ProgressOnlyStatFact;
}

// Deliberately read-only: there is no process, transport, clock, or persistence capability.
export interface Candidate18ProgressOnlyDependencies {
  captureFile(path: string): C18ProgressOnlyFileCapture;
  captureDirectory(path: string): C18ProgressOnlyDirectoryCapture;
}

function fail(code: string): never {
  throw new Error(code);
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

export function canonicalJsonC18ProgressOnly(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonC18ProgressOnly).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonC18ProgressOnly(item))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameStat(left: C18ProgressOnlyStatFact, right: C18ProgressOnlyStatFact): boolean {
  return canonicalJsonC18ProgressOnly(left) === canonicalJsonC18ProgressOnly(right);
}

function expectedDirectoryStat(config: C18ProgressOnlyConfig): C18ProgressOnlyStatFact {
  return {
    device: config.evidence_directory.device,
    inode: config.evidence_directory.inode,
    owner_uid: config.evidence_directory.owner_uid,
    mode: config.evidence_directory.mode,
    link_count: config.evidence_directory.link_count,
    size: 0,
    mtime_ms: config.evidence_directory.mtime_ms,
    ctime_ms: config.evidence_directory.ctime_ms,
    kind: "directory",
    symbolic_link: false,
  };
}

function validateBoundDirectory(value: unknown): C18ProgressOnlyBoundDirectory {
  const directory = object(value);
  const keys = [
    "schema", "path", "entries", "device", "inode", "owner_uid", "mode", "link_count",
    "mtime_ms", "ctime_ms",
  ];
  if (!directory || !exactKeys(directory, keys)
    || directory.schema !== "synthia-m4f-c18-progress-only-bound-directory.v1"
    || directory.path !== C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY
    || directory.owner_uid !== 501 || directory.mode !== 0o700
    || !Array.isArray(directory.entries)
    || canonicalJsonC18ProgressOnly(directory.entries) !== canonicalJsonC18ProgressOnly(EVIDENCE_NAMES)
    || ![directory.device, directory.inode, directory.owner_uid, directory.mode,
      directory.link_count, directory.mtime_ms, directory.ctime_ms].every(finiteNonNegative)
    || Number(directory.link_count) < 1) {
    fail("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
  }
  return value as C18ProgressOnlyBoundDirectory;
}

function validateBoundFile(value: unknown, name: string): C18ProgressOnlyBoundFile {
  const file = object(value);
  const keys = [
    "schema", "path", "sha256", "device", "inode", "owner_uid", "mode", "link_count",
    "size", "mtime_ms", "ctime_ms",
  ];
  const expectedHash = C18_PROGRESS_ONLY_EVIDENCE_HASHES[
    name as keyof typeof C18_PROGRESS_ONLY_EVIDENCE_HASHES
  ];
  if (!file || !exactKeys(file, keys)
    || file.schema !== "synthia-m4f-c18-progress-only-bound-file.v1"
    || file.path !== `${C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY}/${name}`
    || file.sha256 !== expectedHash || file.owner_uid !== 501 || file.mode !== 0o600
    || file.link_count !== 1
    || ![file.device, file.inode, file.owner_uid, file.mode, file.link_count, file.size,
      file.mtime_ms, file.ctime_ms].every(finiteNonNegative)) {
    fail("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
  }
  return value as C18ProgressOnlyBoundFile;
}

function validateBoundImplementationFile(
  value: unknown,
  expectedPath: string,
): C18ProgressOnlyBoundImplementationFile {
  const file = object(value);
  const keys = [
    "schema", "path", "sha256", "device", "inode", "owner_uid", "mode", "link_count",
    "size", "mtime_ms", "ctime_ms",
  ];
  if (!file || !exactKeys(file, keys)
    || file.schema !== "synthia-m4f-c18-progress-only-bound-implementation-file.v1"
    || file.path !== expectedPath || file.owner_uid !== 501 || file.mode !== 0o644
    || file.link_count !== 1 || typeof file.sha256 !== "string" || !HASH.test(file.sha256)
    || ![file.device, file.inode, file.owner_uid, file.mode, file.link_count, file.size,
      file.mtime_ms, file.ctime_ms].every(finiteNonNegative)) {
    fail("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
  }
  return value as C18ProgressOnlyBoundImplementationFile;
}

export function validateCandidate18ProgressOnlyConfig(value: unknown): C18ProgressOnlyConfig {
  const config = object(value);
  const files = object(config?.evidence_files);
  const keys = [
    "schema", "adjudication_id", "evidence_directory", "evidence_files", "source_file",
    "test_source_file",
  ];
  if (!config || !exactKeys(config, keys)
    || config.schema !== "synthia-m4f-c18-progress-only-adjudicator-config.v1"
    || typeof config.adjudication_id !== "string" || !SAFE_ID.test(config.adjudication_id)
    || !files || !exactKeys(files, EVIDENCE_NAMES)) {
    fail("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
  }
  validateBoundDirectory(config.evidence_directory);
  for (const name of EVIDENCE_NAMES) validateBoundFile(files[name], name);
  validateBoundImplementationFile(config.source_file, C18_PROGRESS_ONLY_SOURCE_PATH);
  validateBoundImplementationFile(config.test_source_file, C18_PROGRESS_ONLY_TEST_SOURCE_PATH);
  return value as C18ProgressOnlyConfig;
}

function validateDependencies(value: Candidate18ProgressOnlyDependencies): void {
  const dependencies = object(value);
  if (!dependencies || !exactKeys(dependencies, ["captureDirectory", "captureFile"])
    || typeof dependencies.captureDirectory !== "function"
    || typeof dependencies.captureFile !== "function") {
    fail("M4F_C18_PROGRESS_ONLY_DEPENDENCIES_INVALID");
  }
}

function assertDirectoryCapture(
  config: C18ProgressOnlyConfig,
  capture: C18ProgressOnlyDirectoryCapture,
): void {
  const expected = expectedDirectoryStat(config);
  const comparable = (fact: C18ProgressOnlyStatFact): C18ProgressOnlyStatFact => ({
    ...fact,
    size: 0,
  });
  if (!sameStat(comparable(capture.before), expected)
    || !sameStat(comparable(capture.after), expected)
    || canonicalJsonC18ProgressOnly(capture.entries) !== canonicalJsonC18ProgressOnly(EVIDENCE_NAMES)) {
    fail("M4F_C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY_DRIFT");
  }
}

function captureEvidence(
  config: C18ProgressOnlyConfig,
  dependencies: Candidate18ProgressOnlyDependencies,
): Record<string, Buffer> {
  assertDirectoryCapture(config, dependencies.captureDirectory(C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY));
  const files: Record<string, Buffer> = {};
  for (const name of EVIDENCE_NAMES) {
    const expected = config.evidence_files[name]!;
    const capture = dependencies.captureFile(expected.path);
    const expectedStat: C18ProgressOnlyStatFact = {
      device: expected.device,
      inode: expected.inode,
      owner_uid: expected.owner_uid,
      mode: expected.mode,
      link_count: expected.link_count,
      size: expected.size,
      mtime_ms: expected.mtime_ms,
      ctime_ms: expected.ctime_ms,
      kind: "file",
      symbolic_link: false,
    };
    if (![capture.path_before, capture.handle_before, capture.handle_after, capture.path_after]
      .every((fact) => sameStat(fact, expectedStat))
      || capture.bytes.length !== expected.size || sha256(capture.bytes) !== expected.sha256) {
      fail("M4F_C18_PROGRESS_ONLY_EVIDENCE_FILE_DRIFT");
    }
    files[name] = Buffer.from(capture.bytes);
  }
  assertDirectoryCapture(config, dependencies.captureDirectory(C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY));
  return files;
}

function captureImplementationFile(
  expected: C18ProgressOnlyBoundImplementationFile,
  dependencies: Candidate18ProgressOnlyDependencies,
): Buffer {
  let capture: C18ProgressOnlyFileCapture;
  try {
    capture = dependencies.captureFile(expected.path);
  } catch {
    fail("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");
  }
  const expectedStat: C18ProgressOnlyStatFact = {
    device: expected.device,
    inode: expected.inode,
    owner_uid: expected.owner_uid,
    mode: expected.mode,
    link_count: expected.link_count,
    size: expected.size,
    mtime_ms: expected.mtime_ms,
    ctime_ms: expected.ctime_ms,
    kind: "file",
    symbolic_link: false,
  };
  if (![capture.path_before, capture.handle_before, capture.handle_after, capture.path_after]
    .every((fact) => sameStat(fact, expectedStat))
    || capture.bytes.length !== expected.size || sha256(capture.bytes) !== expected.sha256) {
    fail("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");
  }
  return Buffer.from(capture.bytes);
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
}

function assertCanonicalJson(bytes: Buffer, value: unknown, code: string): void {
  if (!bytes.equals(Buffer.from(canonicalJsonC18ProgressOnly(value) + "\n", "utf8"))) fail(code);
}

const EXPECTED_CLIXML_BODY = "<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><Obj S=\"progress\" RefId=\"0\"><TN RefId=\"0\"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N=\"SourceId\">1</I64><PR N=\"Record\"><AV>正在准备首次使用模块。</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>";

export function validateCandidate18ProgressOnlyCliXml(bytes: Buffer): Record<string, unknown> {
  const prefix = "#< CLIXML\r\n";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("M4F_C18_PROGRESS_ONLY_CLIXML_INVALID");
  }
  const body = text.slice(prefix.length);
  if (!bytes.subarray(0, Buffer.byteLength(prefix)).equals(Buffer.from(prefix, "ascii"))
    || !text.startsWith(prefix) || body !== EXPECTED_CLIXML_BODY
    || /<!DOCTYPE|<!ENTITY|<[?]|<!--/iu.test(text)
    || (body.match(/<Objs(?:\s|>)/gu)?.length ?? 0) !== 1
    || (body.match(/<\/Objs>/gu)?.length ?? 0) !== 1
    || (body.match(/<Obj\s/gu)?.length ?? 0) !== 1
    || (body.match(/S="progress"/gu)?.length ?? 0) !== 1
    || (body.match(/<PR N="Record">/gu)?.length ?? 0) !== 1
    || (body.match(/<AV>正在准备首次使用模块。<\/AV>/gu)?.length ?? 0) !== 1
    || (body.match(/<T>Completed<\/T>/gu)?.length ?? 0) !== 1
    || /S="(?:error|warning|debug|verbose|information)"/iu.test(body)) {
    fail("M4F_C18_PROGRESS_ONLY_CLIXML_INVALID");
  }
  return {
    schema: "synthia-m4f-c18-progress-only-clixml.v1",
    root_count: 1,
    object_count: 1,
    record_count: 1,
    stream: "progress",
    activity: "正在准备首次使用模块。",
    status: "Completed",
    error_count: 0,
    warning_count: 0,
    debug_count: 0,
    verbose_count: 0,
    information_count: 0,
  };
}

const PROCESS_KEYS = [
  "error_code", "exit_status", "retry_permitted", "signal", "stderr_length", "stderr_sha256",
  "stdin_length", "stdin_sha256", "stdout_length", "stdout_sha256", "timed_out",
] as const;

export function validateCandidate18ProgressOnlyRemoteProcess(
  value: unknown,
  stdin: Buffer,
  stdout: Buffer,
  stderr: Buffer,
): Record<string, unknown> {
  const process = object(value);
  if (!process || !exactKeys(process, PROCESS_KEYS)
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.retry_permitted !== false
    || process.stdin_length !== 6791 || process.stdin_length !== stdin.length
    || process.stdin_sha256 !== C18_PROGRESS_ONLY_EVIDENCE_HASHES["target-outer-loader.ps1"]
    || process.stdin_sha256 !== sha256(stdin)
    || process.stdout_length !== 478 || process.stdout_length !== stdout.length
    || process.stdout_sha256 !== C18_PROGRESS_ONLY_EVIDENCE_HASHES["stdout.raw"]
    || process.stdout_sha256 !== sha256(stdout)
    || process.stderr_length !== 393 || process.stderr_length !== stderr.length
    || process.stderr_sha256 !== C18_PROGRESS_ONLY_EVIDENCE_HASHES["stderr.raw"]
    || process.stderr_sha256 !== sha256(stderr)) {
    fail("M4F_C18_PROGRESS_ONLY_REMOTE_PROCESS_INVALID");
  }
  return process;
}

export function validateCandidate18ProgressOnlyOriginalFailure(
  value: unknown,
  process: Record<string, unknown>,
): Record<string, unknown> {
  const failure = object(value);
  const keys = [
    "attempt", "business_target_body_not_invoked", "cleanup_performed", "code",
    "file_mutation_performed", "hardware_action_performed", "outer_loader_target_body_not_invoked",
    "parse_id", "process_mutation_performed", "remote_effect_state", "remote_process",
    "retry_permitted", "schema", "stage", "vivado_action_performed",
  ];
  if (!failure || !exactKeys(failure, keys)
    || failure.schema !== "synthia-m4f-candidate18-parse-only-failure.v1"
    || failure.code !== "M4F_CANDIDATE18_REMOTE_PARSE_FAILED"
    || failure.stage !== "network" || failure.attempt !== 1 || failure.retry_permitted !== false
    || failure.parse_id !== PARSE_ID || failure.remote_effect_state !== "parse_only_unknown"
    || failure.business_target_body_not_invoked !== true
    || failure.outer_loader_target_body_not_invoked !== true
    || failure.process_mutation_performed !== false || failure.file_mutation_performed !== false
    || failure.vivado_action_performed !== false || failure.hardware_action_performed !== false
    || failure.cleanup_performed !== false
    || canonicalJsonC18ProgressOnly(failure.remote_process)
      !== canonicalJsonC18ProgressOnly(process)) {
    fail("M4F_C18_PROGRESS_ONLY_ORIGINAL_FAILURE_INVALID");
  }
  return failure;
}

export function validateCandidate18ProgressOnlyStdout(
  stdout: Buffer,
  payload: Candidate18Payload,
): Record<string, unknown> {
  const result = validateCandidate18Result(stdout, payload);
  const business = object(result.business);
  const outer = object(result.outer_loader);
  if (result.schema !== "synthia-m4f-candidate18-parse-only-result.v1"
    || result.status !== "parsed_not_invoked" || result.powershell_edition !== "Desktop"
    || result.powershell_version !== "5.1.26100.9168"
    || !business || business.parse_error_count !== 0
    || business.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || business.parser_end_block_present !== true || business.target_body_not_invoked !== true
    || !outer || outer.parse_error_count !== 0
    || outer.parser_ast_type !== "System.Management.Automation.Language.ScriptBlockAst"
    || outer.parser_end_block_present !== true || outer.target_body_not_invoked !== true
    || result.process_mutation_performed !== false || result.file_mutation_performed !== false
    || result.vivado_action_performed !== false || result.hardware_action_performed !== false
    || result.cleanup_performed !== false) {
    fail("M4F_C18_PROGRESS_ONLY_STDOUT_INVALID");
  }
  return result;
}

function validatePlan(value: unknown, payload: Candidate18Payload): Record<string, unknown> {
  const plan = object(value);
  if (!plan || plan.schema !== "synthia-m4f-candidate18-parse-only-plan.v1"
    || plan.status !== "planned_not_executed" || plan.parse_id !== PARSE_ID
    || plan.parser_required !== "Windows PowerShell Desktop 5.1"
    || plan.attempt_count !== 1 || plan.parse_target_count !== 2
    || plan.input_length !== payload.input.length || plan.input_sha256 !== payload.input_sha256
    || plan.loader_sha256 !== payload.loader_sha256 || plan.command_sha256 !== payload.command_sha256
    || plan.command_length !== payload.command.length
    || plan.business_script_sha256 !== payload.business_script_sha256
    || plan.business_script_utf8_length !== payload.business_script_utf8_length
    || plan.outer_loader_sha256 !== payload.outer_loader_sha256
    || plan.outer_loader_utf8_length !== payload.outer_loader_utf8_length
    || plan.business_target_body_not_invoked !== true
    || plan.outer_loader_target_body_not_invoked !== true
    || plan.network_attempted !== false || plan.process_mutation_performed !== false
    || plan.file_mutation_performed !== false || plan.vivado_action_performed !== false
    || plan.hardware_action_performed !== false || plan.cleanup_performed !== false
    || plan.retry_permitted !== false) {
    fail("M4F_C18_PROGRESS_ONLY_PLAN_INVALID");
  }
  return plan;
}

function requireEqual(files: Record<string, Buffer>, names: readonly string[], code: string): void {
  const first = files[names[0]!]!;
  for (const name of names.slice(1)) if (!files[name]!.equals(first)) fail(code);
}

export function adjudicateCandidate18ProgressOnly(
  rawConfig: unknown,
  expectedConfigSha256: string,
  dependencies: Candidate18ProgressOnlyDependencies,
): Record<string, unknown> {
  validateDependencies(dependencies);
  const config = validateCandidate18ProgressOnlyConfig(rawConfig);
  const configSha256 = sha256(canonicalJsonC18ProgressOnly(config) + "\n");
  if (!HASH.test(expectedConfigSha256) || configSha256 !== expectedConfigSha256) {
    fail("M4F_C18_PROGRESS_ONLY_CONFIG_HASH_MISMATCH");
  }
  const sourceBytes = captureImplementationFile(config.source_file, dependencies);
  const testSourceBytes = captureImplementationFile(config.test_source_file, dependencies);
  const sourceHash = sha256(sourceBytes);
  const testHash = sha256(testSourceBytes);
  const files = captureEvidence(config, dependencies);

  const parseConfigValue = parseJson(
    files["parse-config.canonical.json"]!,
    "M4F_C18_PROGRESS_ONLY_PARSE_CONFIG_INVALID",
  );
  assertCanonicalJson(
    files["parse-config.canonical.json"]!,
    parseConfigValue,
    "M4F_C18_PROGRESS_ONLY_PARSE_CONFIG_INVALID",
  );
  const parseConfig = validateCandidate18Config(parseConfigValue);
  if (parseConfig.parse_id !== PARSE_ID
    || parseConfig.evidence_directory !== C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY
    || parseConfig.expected_source_sha256 !== C18_SOURCE_SHA256
    || parseConfig.expected_test_source_sha256 !== C18_TEST_SHA256) {
    fail("M4F_C18_PROGRESS_ONLY_PARSE_CONFIG_INVALID");
  }

  const candidate19Value = parseJson(
    files["candidate19-script-config.raw.json"]!,
    "M4F_C18_PROGRESS_ONLY_C19_CONFIG_INVALID",
  );
  assertCanonicalJson(
    files["candidate19-script-config.raw.json"]!,
    candidate19Value,
    "M4F_C18_PROGRESS_ONLY_C19_CONFIG_INVALID",
  );
  const payload = buildCandidate18Payload(validateCandidate19ScriptConfig(candidate19Value));
  if (!files["target-outer-loader.ps1"]!.equals(payload.input)
    || files["target-business-script.ps1"]!.length !== payload.business_script_utf8_length
    || sha256(files["target-business-script.ps1"]!) !== payload.business_script_sha256
    || !files["parse-loader.ps1"]!.equals(Buffer.from(payload.loader, "utf8"))) {
    fail("M4F_C18_PROGRESS_ONLY_PAYLOAD_INVALID");
  }

  const planValue = parseJson(
    files["plan.canonical.json"]!,
    "M4F_C18_PROGRESS_ONLY_PLAN_INVALID",
  );
  assertCanonicalJson(
    files["plan.canonical.json"]!,
    planValue,
    "M4F_C18_PROGRESS_ONLY_PLAN_INVALID",
  );
  validatePlan(planValue, payload);
  requireEqual(files, [
    "frozen-file-facts-initial.json",
    "frozen-file-facts-pre-remote.json",
    "frozen-file-facts-post-remote.json",
  ], "M4F_C18_PROGRESS_ONLY_FROZEN_FACTS_INVALID");
  requireEqual(files, [
    "transport-inputs-initial.json",
    "transport-inputs-pre-remote.json",
    "transport-inputs-post-remote.json",
  ], "M4F_C18_PROGRESS_ONLY_TRANSPORT_FACTS_INVALID");

  const process = validateCandidate18ProgressOnlyRemoteProcess(
    parseJson(files["remote-process.json"]!, "M4F_C18_PROGRESS_ONLY_REMOTE_PROCESS_INVALID"),
    files["target-outer-loader.ps1"]!,
    files["stdout.raw"]!,
    files["stderr.raw"]!,
  );
  const failure = validateCandidate18ProgressOnlyOriginalFailure(
    parseJson(files["parse-failure.json"]!, "M4F_C18_PROGRESS_ONLY_ORIGINAL_FAILURE_INVALID"),
    process,
  );
  const parseResult = validateCandidate18ProgressOnlyStdout(files["stdout.raw"]!, payload);
  const progress = validateCandidate18ProgressOnlyCliXml(files["stderr.raw"]!);
  if (!captureImplementationFile(config.source_file, dependencies).equals(sourceBytes)
    || !captureImplementationFile(config.test_source_file, dependencies).equals(testSourceBytes)) {
    fail("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");
  }

  return {
    schema: "synthia-m4f-c18-progress-only-adjudication.v1",
    adjudication_id: config.adjudication_id,
    parse_id: PARSE_ID,
    status: "parsed_not_invoked_progress_only_adjudicated",
    original_failure_code: failure.code,
    original_failure_preserved: true,
    remote_retry_performed: false,
    network_attempted: false,
    ssh_attempted: false,
    remote_execution_attempted: false,
    cleanup_performed: false,
    source_evidence_mutated: false,
    production_adjudication_record_written: false,
    network_authorized: false,
    ssh_authorized: false,
    remote_execution_authorized: false,
    retry_authorized: false,
    c19_execution_authorized: false,
    cleanup_execution_authorized: false,
    hardware_action_authorized: false,
    process_mutation_performed: false,
    file_mutation_performed: false,
    vivado_action_performed: false,
    hardware_action_performed: false,
    evidence_directory: C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY,
    evidence_file_count: EVIDENCE_NAMES.length,
    evidence_exact_file_set: true,
    bindings: {
      adjudicator_config_sha256: configSha256,
      parse_config_sha256: C18_PROGRESS_ONLY_EVIDENCE_HASHES["parse-config.canonical.json"],
      plan_sha256: C18_PROGRESS_ONLY_EVIDENCE_HASHES["plan.canonical.json"],
      source_sha256: sourceHash,
      test_source_sha256: testHash,
      source_file: config.source_file,
      test_source_file: config.test_source_file,
      stdout_sha256: C18_PROGRESS_ONLY_EVIDENCE_HASHES["stdout.raw"],
      stderr_sha256: C18_PROGRESS_ONLY_EVIDENCE_HASHES["stderr.raw"],
      evidence_hashes: C18_PROGRESS_ONLY_EVIDENCE_HASHES,
    },
    remote_process: process,
    parse_result: parseResult,
    progress_record: progress,
  };
}
