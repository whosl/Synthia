import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidate18Payload,
  validateCandidate18Config,
  validateCandidate18Result,
  type Candidate18Config,
} from "./m4f-direct-six-process-parse-only-18.ts";
import {
  canonicalJson19,
  validateCandidate19ScriptConfig,
} from "./m4f-direct-six-process-cleanup-19.ts";
import { validateM4fDirectAdmissionConfig } from "./m4f-gate-admission-transport.ts";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const EVIDENCE_DIRECTORY = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
const PARSE_ID = "m4f-direct-six-process-parse-only-prod-20260829-18";
export const C18_ADJUDICATION_RECORD_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-record.json";
const C18_SOURCE_SHA256 = "c48fb7edd8e0915786d65d0858fec7032734d6cd12a1db58ec7cb0fb3cd5734d";
const C18_TEST_SHA256 = "b23c108fcb537b862ed7e64b9c010712726331816dab0a18a8b8f5f8d70e739c";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const C18_PARSE_EVIDENCE_HASHES = {
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

const EVIDENCE_NAMES = Object.keys(C18_PARSE_EVIDENCE_HASHES).sort();

export interface C18AdjudicatorStatFact {
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

export interface C18AdjudicatorBoundFile extends Omit<C18AdjudicatorStatFact, "kind" | "symbolic_link"> {
  schema: "synthia-m4f-c18-adjudicator-bound-file.v1";
  path: string;
  sha256: string;
}

export interface C18AdjudicatorBoundDirectory extends Omit<C18AdjudicatorStatFact, "kind" | "symbolic_link" | "size"> {
  schema: "synthia-m4f-c18-adjudicator-bound-directory.v1";
  path: string;
  entries: string[];
}

export interface C18AdjudicatorConfig {
  schema: "synthia-m4f-c18-local-adjudicator-config.v1";
  adjudication_id: string;
  evidence_directory: C18AdjudicatorBoundDirectory;
  evidence_files: Record<string, C18AdjudicatorBoundFile>;
  record_path: string;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
}

export interface C18AdjudicatorFileCapture {
  path_before: C18AdjudicatorStatFact;
  handle_before: C18AdjudicatorStatFact;
  bytes: Buffer;
  handle_after: C18AdjudicatorStatFact;
  path_after: C18AdjudicatorStatFact;
}

export interface C18AdjudicatorDirectoryCapture {
  before: C18AdjudicatorStatFact;
  entries: string[];
  after: C18AdjudicatorStatFact;
}

export interface C18AdjudicatorDependencies {
  captureFile(path: string): C18AdjudicatorFileCapture;
  captureDirectory(path: string): C18AdjudicatorDirectoryCapture;
  sourceBytes(): Buffer;
  testSourceBytes(): Buffer;
  realpath(path: string): string;
  pathExists(path: string): boolean;
  writeExclusive(path: string, bytes: Buffer): void;
  now(): Date;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJsonC18Adjudicator(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonC18Adjudicator).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonC18Adjudicator(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string): never {
  throw new Error(code);
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/u.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameStat(left: C18AdjudicatorStatFact, right: C18AdjudicatorStatFact): boolean {
  return canonicalJsonC18Adjudicator(left) === canonicalJsonC18Adjudicator(right);
}

function statFact(stat: Stats): C18AdjudicatorStatFact {
  return {
    device: stat.dev,
    inode: stat.ino,
    owner_uid: stat.uid,
    mode: stat.mode & 0o777,
    link_count: stat.nlink,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    kind: stat.isDirectory() ? "directory" : "file",
    symbolic_link: stat.isSymbolicLink(),
  };
}

function fileFactKeys(): string[] {
  return [
    "schema", "path", "sha256", "device", "inode", "owner_uid", "mode", "link_count",
    "size", "mtime_ms", "ctime_ms",
  ];
}

function validateBoundFile(value: unknown, name: string): C18AdjudicatorBoundFile {
  const fact = object(value);
  const expectedHash = C18_PARSE_EVIDENCE_HASHES[name as keyof typeof C18_PARSE_EVIDENCE_HASHES];
  if (!fact || !exactKeys(fact, fileFactKeys())
    || fact.schema !== "synthia-m4f-c18-adjudicator-bound-file.v1"
    || fact.path !== `${EVIDENCE_DIRECTORY}/${name}` || fact.sha256 !== expectedHash
    || fact.owner_uid !== 501 || fact.mode !== 0o600 || fact.link_count !== 1
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count, fact.size,
      fact.mtime_ms, fact.ctime_ms].every(finiteNonNegative)) {
    fail("M4F_C18_ADJUDICATOR_CONFIG_INVALID");
  }
  return value as C18AdjudicatorBoundFile;
}

function validateBoundDirectory(value: unknown): C18AdjudicatorBoundDirectory {
  const fact = object(value);
  const keys = [
    "schema", "path", "entries", "device", "inode", "owner_uid", "mode", "link_count",
    "mtime_ms", "ctime_ms",
  ];
  if (!fact || !exactKeys(fact, keys)
    || fact.schema !== "synthia-m4f-c18-adjudicator-bound-directory.v1"
    || fact.path !== EVIDENCE_DIRECTORY || fact.owner_uid !== 501 || fact.mode !== 0o700
    || !finiteNonNegative(fact.link_count) || fact.link_count < 1 || !Array.isArray(fact.entries)
    || canonicalJsonC18Adjudicator(fact.entries) !== canonicalJsonC18Adjudicator(EVIDENCE_NAMES)
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count,
      fact.mtime_ms, fact.ctime_ms].every(finiteNonNegative)) {
    fail("M4F_C18_ADJUDICATOR_CONFIG_INVALID");
  }
  return value as C18AdjudicatorBoundDirectory;
}

export function validateC18AdjudicatorConfig(value: unknown): C18AdjudicatorConfig {
  const config = object(value);
  const keys = [
    "adjudication_id", "evidence_directory", "evidence_files", "expected_source_sha256",
    "expected_test_source_sha256", "record_path", "schema",
  ];
  const files = object(config?.evidence_files);
  if (!config || !exactKeys(config, keys)
    || config.schema !== "synthia-m4f-c18-local-adjudicator-config.v1"
    || typeof config.adjudication_id !== "string" || !SAFE_ID.test(config.adjudication_id)
    || config.record_path !== C18_ADJUDICATION_RECORD_PATH
    || !absolutePath(config.record_path) || resolve(config.record_path) !== config.record_path
    || config.record_path.includes("/../") || String(config.record_path).startsWith(EVIDENCE_DIRECTORY + "/")
    || typeof config.expected_source_sha256 !== "string" || !HASH.test(config.expected_source_sha256)
    || typeof config.expected_test_source_sha256 !== "string" || !HASH.test(config.expected_test_source_sha256)
    || !files || !exactKeys(files, EVIDENCE_NAMES)) fail("M4F_C18_ADJUDICATOR_CONFIG_INVALID");
  validateBoundDirectory(config.evidence_directory);
  for (const name of EVIDENCE_NAMES) validateBoundFile(files[name], name);
  return value as C18AdjudicatorConfig;
}

function assertRecordTarget(
  config: C18AdjudicatorConfig,
  dependencies: C18AdjudicatorDependencies,
): void {
  let parentRealpath: string;
  let evidenceRealpath: string;
  try {
    parentRealpath = dependencies.realpath(dirname(config.record_path));
    evidenceRealpath = dependencies.realpath(EVIDENCE_DIRECTORY);
  } catch {
    fail("M4F_C18_ADJUDICATOR_RECORD_PATH_INVALID");
  }
  if (parentRealpath !== "/private/tmp" || evidenceRealpath !== EVIDENCE_DIRECTORY
    || config.record_path === evidenceRealpath
    || config.record_path.startsWith(evidenceRealpath + "/")
    || dependencies.pathExists(config.record_path)) {
    fail("M4F_C18_ADJUDICATOR_RECORD_PATH_INVALID");
  }
}

function parseJson(bytes: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(code); }
}

function assertCanonicalJson(bytes: Buffer, value: unknown, code: string): void {
  if (!bytes.equals(Buffer.from(canonicalJsonC18Adjudicator(value) + "\n", "utf8"))) fail(code);
}

function expectedEvidenceDirectoryStat(config: C18AdjudicatorConfig): C18AdjudicatorStatFact {
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

function assertEvidenceDirectoryCapture(
  config: C18AdjudicatorConfig,
  capture: C18AdjudicatorDirectoryCapture,
): void {
  const expected = expectedEvidenceDirectoryStat(config);
  const comparable = (fact: C18AdjudicatorStatFact): C18AdjudicatorStatFact => ({ ...fact, size: 0 });
  if (!sameStat(comparable(capture.before), expected)
    || !sameStat(comparable(capture.after), expected)
    || canonicalJsonC18Adjudicator(capture.entries) !== canonicalJsonC18Adjudicator(EVIDENCE_NAMES)) {
    fail("M4F_C18_ADJUDICATOR_EVIDENCE_DIRECTORY_DRIFT");
  }
}

function captureEvidence(
  config: C18AdjudicatorConfig,
  dependencies: C18AdjudicatorDependencies,
): Record<string, Buffer> {
  const directory = dependencies.captureDirectory(EVIDENCE_DIRECTORY);
  assertEvidenceDirectoryCapture(config, directory);
  const result: Record<string, Buffer> = {};
  for (const name of EVIDENCE_NAMES) {
    const expected = config.evidence_files[name]!;
    const capture = dependencies.captureFile(expected.path);
    const expectedStat: C18AdjudicatorStatFact = {
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
      fail("M4F_C18_ADJUDICATOR_EVIDENCE_FILE_DRIFT");
    }
    result[name] = Buffer.from(capture.bytes);
  }
  const after = dependencies.captureDirectory(EVIDENCE_DIRECTORY);
  assertEvidenceDirectoryCapture(config, after);
  return result;
}

const EXPECTED_CLIXML_BODY = "<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><Obj S=\"progress\" RefId=\"0\"><TN RefId=\"0\"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N=\"SourceId\">1</I64><PR N=\"Record\"><AV>正在准备首次使用模块。</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>";

export function parseCandidate18BenignCliXml(bytes: Buffer): Record<string, unknown> {
  const prefix = "#< CLIXML\r\n";
  if (!bytes.subarray(0, Buffer.byteLength(prefix)).equals(Buffer.from(prefix, "ascii"))) {
    fail("M4F_C18_ADJUDICATOR_CLIXML_INVALID");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    fail("M4F_C18_ADJUDICATOR_CLIXML_INVALID");
  }
  if (!text.startsWith(prefix) || text.slice(prefix.length) !== EXPECTED_CLIXML_BODY
    || /<!DOCTYPE|<!ENTITY|<[?]|<!--/iu.test(text)
    || (text.match(/<Obj\s/gu)?.length ?? 0) !== 1
    || (text.match(/S="progress"/gu)?.length ?? 0) !== 1
    || /S="(?:error|warning|verbose|debug|information)"/iu.test(text)) {
    fail("M4F_C18_ADJUDICATOR_CLIXML_INVALID");
  }
  return {
    schema: "synthia-m4f-c18-benign-clixml.v1",
    stream: "progress",
    source_id: 1,
    activity: "正在准备首次使用模块。",
    status: "Completed",
    percent_complete: -1,
    seconds_remaining: -1,
    error_count: 0,
    warning_count: 0,
    verbose_count: 0,
    debug_count: 0,
    information_count: 0,
  };
}

const PROCESS_KEYS = [
  "error_code", "exit_status", "retry_permitted", "signal", "stderr_length", "stderr_sha256",
  "stdin_length", "stdin_sha256", "stdout_length", "stdout_sha256", "timed_out",
] as const;

function validateRemoteProcess(value: unknown): Record<string, unknown> {
  const process = object(value);
  if (!process || !exactKeys(process, PROCESS_KEYS)
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.retry_permitted !== false
    || process.stdin_length !== 6791
    || process.stdin_sha256 !== C18_PARSE_EVIDENCE_HASHES["target-outer-loader.ps1"]
    || process.stdout_length !== 478 || process.stdout_sha256 !== C18_PARSE_EVIDENCE_HASHES["stdout.raw"]
    || process.stderr_length !== 393 || process.stderr_sha256 !== C18_PARSE_EVIDENCE_HASHES["stderr.raw"]) {
    fail("M4F_C18_ADJUDICATOR_REMOTE_PROCESS_INVALID");
  }
  return process;
}

function validateEffectiveProcess(value: unknown): Record<string, unknown> {
  const process = object(value);
  if (!process || !exactKeys(process, PROCESS_KEYS)
    || process.exit_status !== 0 || process.signal !== null || process.error_code !== null
    || process.timed_out !== false || process.retry_permitted !== false
    || process.stdin_length !== 0 || process.stdin_sha256 !== EMPTY_SHA256
    || process.stdout_length !== 4408
    || process.stdout_sha256 !== C18_PARSE_EVIDENCE_HASHES["ssh-effective-stdout.raw"]
    || process.stderr_length !== 0 || process.stderr_sha256 !== EMPTY_SHA256) {
    fail("M4F_C18_ADJUDICATOR_EFFECTIVE_PROCESS_INVALID");
  }
  return process;
}

function validateOriginalFailure(value: unknown, process: Record<string, unknown>): Record<string, unknown> {
  const failure = object(value);
  const keys = [
    "attempt", "business_target_body_not_invoked", "cleanup_performed", "code",
    "file_mutation_performed", "hardware_action_performed", "outer_loader_target_body_not_invoked",
    "parse_id", "process_mutation_performed", "remote_effect_state", "remote_process",
    "retry_permitted", "schema", "stage", "vivado_action_performed",
  ];
  if (!failure || !exactKeys(failure, keys)
    || failure.schema !== "synthia-m4f-candidate18-parse-only-failure.v1"
    || failure.code !== "M4F_CANDIDATE18_REMOTE_PARSE_FAILED" || failure.stage !== "network"
    || failure.remote_effect_state !== "parse_only_unknown" || failure.parse_id !== PARSE_ID
    || failure.attempt !== 1 || failure.business_target_body_not_invoked !== true
    || failure.outer_loader_target_body_not_invoked !== true
    || failure.process_mutation_performed !== false || failure.file_mutation_performed !== false
    || failure.vivado_action_performed !== false || failure.hardware_action_performed !== false
    || failure.cleanup_performed !== false || failure.retry_permitted !== false
    || canonicalJsonC18Adjudicator(failure.remote_process) !== canonicalJsonC18Adjudicator(process)) {
    fail("M4F_C18_ADJUDICATOR_ORIGINAL_FAILURE_INVALID");
  }
  return failure;
}

function requireEqualEvidence(files: Record<string, Buffer>, names: string[], code: string): unknown {
  const first = files[names[0]!]!;
  for (const name of names.slice(1)) if (!files[name]!.equals(first)) fail(code);
  return parseJson(first, code);
}

function validateFacts(value: unknown, schema: string, count: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length !== count) fail(code);
  for (const item of value) {
    const fact = object(item);
    if (!fact || fact.schema !== schema || typeof fact.path !== "string" || !absolutePath(fact.path)
      || typeof fact.sha256 !== "string" || !HASH.test(fact.sha256)
      || fact.link_count !== 1 || ![0o600, 0o644].includes(Number(fact.mode))) fail(code);
  }
  return value;
}

function confirmationHash(config: Candidate18Config, plan: Record<string, unknown>): string {
  const confirmation = [
    "SYNTHIA_M4F_CANDIDATE18_DUAL_WINDOWS_PARSE_ONLY",
    config.parse_id,
    sha256(canonicalJsonC18Adjudicator(config) + "\n"),
    sha256(canonicalJsonC18Adjudicator(plan) + "\n"),
    config.expected_source_sha256,
    config.expected_test_source_sha256,
    config.expected_candidate19_source_sha256,
    config.expected_candidate19_test_source_sha256,
    config.expected_candidate19_doc_sha256,
    config.expected_transport_source_sha256,
  ].join(":");
  return sha256(confirmation);
}

function adjudicateEvidence(
  config: C18AdjudicatorConfig,
  files: Record<string, Buffer>,
  dependencies: C18AdjudicatorDependencies,
  recordCreated: boolean,
): Record<string, unknown> {
  if (sha256(dependencies.sourceBytes()) !== config.expected_source_sha256
    || sha256(dependencies.testSourceBytes()) !== config.expected_test_source_sha256) {
    fail("M4F_C18_ADJUDICATOR_SOURCE_MISMATCH");
  }
  const parseConfigValue = parseJson(files["parse-config.canonical.json"]!, "M4F_C18_ADJUDICATOR_PARSE_CONFIG_INVALID");
  assertCanonicalJson(files["parse-config.canonical.json"]!, parseConfigValue,
    "M4F_C18_ADJUDICATOR_PARSE_CONFIG_INVALID");
  const parseConfig = validateCandidate18Config(parseConfigValue);
  if (parseConfig.parse_id !== PARSE_ID || parseConfig.evidence_directory !== EVIDENCE_DIRECTORY
    || parseConfig.expected_source_sha256 !== C18_SOURCE_SHA256
    || parseConfig.expected_test_source_sha256 !== C18_TEST_SHA256) {
    fail("M4F_C18_ADJUDICATOR_PARSE_CONFIG_INVALID");
  }
  const scriptConfigValue = parseJson(files["candidate19-script-config.raw.json"]!,
    "M4F_C18_ADJUDICATOR_C19_CONFIG_INVALID");
  if (!files["candidate19-script-config.raw.json"]!.equals(
    Buffer.from(canonicalJson19(scriptConfigValue) + "\n", "utf8"),
  )) fail("M4F_C18_ADJUDICATOR_C19_CONFIG_INVALID");
  const scriptConfig = validateCandidate19ScriptConfig(scriptConfigValue);
  const transport = validateM4fDirectAdmissionConfig(parseJson(
    files["transport-config.raw.json"]!, "M4F_C18_ADJUDICATOR_TRANSPORT_CONFIG_INVALID",
  ));
  if (sha256(files["candidate19-script-config.raw.json"]!) !== parseConfig.candidate19_script_config_sha256
    || sha256(files["transport-config.raw.json"]!) !== parseConfig.transport_config_sha256
    || transport.target.host !== "100.96.223.49"
    || transport.target.expected_effective_config_sha256
      !== C18_PARSE_EVIDENCE_HASHES["ssh-effective-stdout.raw"]) {
    fail("M4F_C18_ADJUDICATOR_INPUT_BINDING_INVALID");
  }
  const payload = buildCandidate18Payload(scriptConfig);
  if (!files["target-business-script.ps1"]!.equals(Buffer.from(
    new TextDecoder("utf-8", { fatal: true }).decode(files["target-business-script.ps1"]!), "utf8",
  ))
    || sha256(files["target-business-script.ps1"]!) !== payload.business_script_sha256
    || !files["target-outer-loader.ps1"]!.equals(payload.input)
    || !files["parse-loader.ps1"]!.equals(Buffer.from(payload.loader, "utf8"))) {
    fail("M4F_C18_ADJUDICATOR_PAYLOAD_BINDING_INVALID");
  }
  const planValue = parseJson(files["plan.canonical.json"]!, "M4F_C18_ADJUDICATOR_PLAN_INVALID");
  assertCanonicalJson(files["plan.canonical.json"]!, planValue, "M4F_C18_ADJUDICATOR_PLAN_INVALID");
  const plan = object(planValue);
  if (!plan || plan.schema !== "synthia-m4f-candidate18-parse-only-plan.v1"
    || plan.status !== "planned_not_executed" || plan.parse_id !== PARSE_ID
    || plan.attempt_count !== 1 || plan.parse_target_count !== 2
    || plan.input_sha256 !== payload.input_sha256 || plan.input_length !== payload.input.length
    || plan.loader_sha256 !== payload.loader_sha256 || plan.command_sha256 !== payload.command_sha256
    || plan.command_length !== payload.command.length
    || plan.business_script_sha256 !== payload.business_script_sha256
    || plan.business_script_utf8_length !== payload.business_script_utf8_length
    || plan.outer_loader_sha256 !== payload.outer_loader_sha256
    || plan.outer_loader_utf8_length !== payload.outer_loader_utf8_length
    || plan.business_target_body_not_invoked !== true || plan.outer_loader_target_body_not_invoked !== true
    || plan.process_mutation_performed !== false || plan.file_mutation_performed !== false
    || plan.vivado_action_performed !== false || plan.hardware_action_performed !== false
    || plan.cleanup_performed !== false || plan.retry_permitted !== false) {
    fail("M4F_C18_ADJUDICATOR_PLAN_INVALID");
  }
  const confirmation = new TextDecoder("utf-8", { fatal: true }).decode(files["confirmation.sha256"]!);
  if (confirmation !== confirmationHash(parseConfig, plan) + "\n") {
    fail("M4F_C18_ADJUDICATOR_CONFIRMATION_INVALID");
  }
  const transportFacts = validateFacts(requireEqualEvidence(files, [
    "transport-inputs-initial.json", "transport-inputs-pre-remote.json",
    "transport-inputs-post-remote.json",
  ], "M4F_C18_ADJUDICATOR_TRANSPORT_FACTS_INVALID"),
  "synthia-m4f-direct-local-input.v1", 2, "M4F_C18_ADJUDICATOR_TRANSPORT_FACTS_INVALID");
  const frozenFacts = validateFacts(requireEqualEvidence(files, [
    "frozen-file-facts-initial.json", "frozen-file-facts-pre-remote.json",
    "frozen-file-facts-post-remote.json",
  ], "M4F_C18_ADJUDICATOR_FROZEN_FACTS_INVALID"),
  "synthia-m4f-candidate18-local-file.v1", 12, "M4F_C18_ADJUDICATOR_FROZEN_FACTS_INVALID");
  if (canonicalJsonC18Adjudicator(plan.frozen_file_facts) !== canonicalJsonC18Adjudicator(frozenFacts)) {
    fail("M4F_C18_ADJUDICATOR_FROZEN_FACTS_INVALID");
  }
  const process = validateRemoteProcess(parseJson(
    files["remote-process.json"]!, "M4F_C18_ADJUDICATOR_REMOTE_PROCESS_INVALID",
  ));
  const failure = validateOriginalFailure(parseJson(
    files["parse-failure.json"]!, "M4F_C18_ADJUDICATOR_ORIGINAL_FAILURE_INVALID",
  ), process);
  const effectiveProcess = validateEffectiveProcess(parseJson(
    files["ssh-effective-process.json"]!, "M4F_C18_ADJUDICATOR_EFFECTIVE_PROCESS_INVALID",
  ));
  if (files["ssh-effective-stderr.raw"]!.length !== 0
    || sha256(files["ssh-effective-stdout.raw"]!) !== effectiveProcess.stdout_sha256) {
    fail("M4F_C18_ADJUDICATOR_EFFECTIVE_PROCESS_INVALID");
  }
  const cliXml = parseCandidate18BenignCliXml(files["stderr.raw"]!);
  const result = validateCandidate18Result(files["stdout.raw"]!, payload);
  return {
    schema: "synthia-m4f-c18-local-adjudication-record.v1",
    adjudication_id: config.adjudication_id,
    parse_id: PARSE_ID,
    status: "parse_success_locally_adjudicated",
    original_failure_code: failure.code,
    original_failure_sha256: C18_PARSE_EVIDENCE_HASHES["parse-failure.json"],
    original_failure_preserved: true,
    eligible_for_c19_execution_freeze: true,
    c19_execution_authorized: false,
    cleanup_execution_authorized: false,
    network_authorized: false,
    ssh_authorized: false,
    remote_execution_authorized: false,
    retry_authorized: false,
    cleanup_performed: false,
    source_evidence_mutated: false,
    record_created: recordCreated,
    network_attempted_by_adjudicator: false,
    ssh_attempted_by_adjudicator: false,
    remote_execution_attempted_by_adjudicator: false,
    retry_attempted_by_adjudicator: false,
    recorded_at_utc: dependencies.now().toISOString(),
    evidence_directory: EVIDENCE_DIRECTORY,
    evidence_file_count: EVIDENCE_NAMES.length,
    evidence_exact_file_set: true,
    evidence_hashes: C18_PARSE_EVIDENCE_HASHES,
    config_sha256: sha256(canonicalJsonC18Adjudicator(parseConfig) + "\n"),
    plan_sha256: sha256(files["plan.canonical.json"]!),
    confirmation_sha256: confirmation.trim(),
    candidate19_script_config_sha256: sha256(files["candidate19-script-config.raw.json"]!),
    payload: {
      stdin_length: payload.input.length,
      stdin_sha256: payload.input_sha256,
      loader_sha256: payload.loader_sha256,
      command_sha256: payload.command_sha256,
      business_script_length: payload.business_script_utf8_length,
      business_script_sha256: payload.business_script_sha256,
      outer_loader_length: payload.outer_loader_utf8_length,
      outer_loader_sha256: payload.outer_loader_sha256,
    },
    process,
    cli_xml_adjudication: cliXml,
    parse_result: result,
    transport_facts_sha256: sha256(files["transport-inputs-initial.json"]!),
    transport_fact_count: transportFacts.length,
    frozen_file_facts_sha256: sha256(files["frozen-file-facts-initial.json"]!),
    frozen_file_fact_count: frozenFacts.length,
  };
}

export function planC18LocalAdjudication(
  rawConfig: unknown,
  dependencies: C18AdjudicatorDependencies,
): Record<string, unknown> {
  const config = validateC18AdjudicatorConfig(rawConfig);
  assertRecordTarget(config, dependencies);
  const files = captureEvidence(config, dependencies);
  return adjudicateEvidence(config, files, dependencies, false);
}

function validateWrittenRecord(
  config: C18AdjudicatorConfig,
  expectedBytes: Buffer,
  dependencies: C18AdjudicatorDependencies,
): void {
  let capture: C18AdjudicatorFileCapture;
  try { capture = dependencies.captureFile(config.record_path); } catch {
    fail("M4F_C18_ADJUDICATOR_RECORD_WRITE_INVALID");
  }
  const facts = [capture.path_before, capture.handle_before, capture.handle_after, capture.path_after];
  if (!capture.bytes.equals(expectedBytes) || sha256(capture.bytes) !== sha256(expectedBytes)
    || facts.some((fact) => fact.kind !== "file" || fact.symbolic_link
      || fact.owner_uid !== 501 || fact.mode !== 0o600 || fact.link_count !== 1
      || fact.size !== expectedBytes.length)
    || facts.some((fact) => !sameStat(fact, facts[0]!))) {
    fail("M4F_C18_ADJUDICATOR_RECORD_WRITE_INVALID");
  }
}

export function executeC18LocalAdjudication(
  rawConfig: unknown,
  dependencies: C18AdjudicatorDependencies,
): Record<string, unknown> {
  const config = validateC18AdjudicatorConfig(rawConfig);
  assertRecordTarget(config, dependencies);
  const files = captureEvidence(config, dependencies);
  const record = adjudicateEvidence(config, files, dependencies, true);
  const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
  try { dependencies.writeExclusive(config.record_path, recordBytes); } catch {
    fail("M4F_C18_ADJUDICATOR_RECORD_WRITE_FAILED");
  }
  validateWrittenRecord(config, recordBytes, dependencies);
  assertEvidenceDirectoryCapture(config, dependencies.captureDirectory(EVIDENCE_DIRECTORY));
  return record;
}

function captureFile(path: string): C18AdjudicatorFileCapture {
  const pathBefore = statFact(lstatSync(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleBefore = statFact(fstatSync(fd));
    const bytes = readFileSync(fd);
    const handleAfter = statFact(fstatSync(fd));
    const pathAfter = statFact(lstatSync(path));
    return { path_before: pathBefore, handle_before: handleBefore, bytes, handle_after: handleAfter, path_after: pathAfter };
  } finally { closeSync(fd); }
}

function captureDirectory(path: string): C18AdjudicatorDirectoryCapture {
  const before = statFact(lstatSync(path));
  const entries = readdirSync(path).sort();
  const after = statFact(lstatSync(path));
  return { before, entries, after };
}

const systemDependencies: C18AdjudicatorDependencies = {
  captureFile,
  captureDirectory,
  sourceBytes: () => readFileSync(fileURLToPath(new URL(import.meta.url))),
  testSourceBytes: () => readFileSync(fileURLToPath(
    new URL("../m4f-direct-six-process-parse-adjudicator-18.test.ts", import.meta.url),
  )),
  realpath: (path) => realpathSync(path),
  pathExists: (path) => existsSync(path),
  writeExclusive(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 3 || args[1] !== "--config"
      || !["--plan", "--adjudicate"].includes(args[0]!)) throw new Error("usage");
    const raw = JSON.parse(readFileSync(args[2]!, "utf8"));
    const result = args[0] === "--plan"
      ? planC18LocalAdjudication(raw, systemDependencies)
      : executeC18LocalAdjudication(raw, systemDependencies);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      schema: "synthia-m4f-c18-local-adjudication-failure.v1",
      code: error instanceof Error ? error.message : "M4F_C18_ADJUDICATOR_UNEXPECTED",
      network_attempted: false,
      ssh_attempted: false,
      remote_execution_attempted: false,
      retry_attempted: false,
      cleanup_performed: false,
    }) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
