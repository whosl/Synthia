import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidate19Payload,
  canonicalJson19,
  parseCandidate19MarkerPrefix,
  validateCandidate19ScriptConfig,
  type Candidate19BuiltPayload,
  type Candidate19ScriptConfig,
} from "./m4f-direct-six-process-cleanup-19.ts";
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
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/u;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const EFFECTIVE_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 50_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const SCRIPT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-cleanup-prod-20260829-19.json";
const SCRIPT_CONFIG_SHA256 = "be33526bfd69ed606a117af32538f2f18c6fe146f9551588d22e6b3191685b76";
const TRANSPORT_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const C18_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18.json";
const C18_CONFIG_SHA256 = "051077fae982440fecdddc29014f8119da1aa9469cb0cd1836b2cc1e9c2d12ce";
const C18_EVIDENCE_DIRECTORY = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
const C18_PLAN_PATH = C18_EVIDENCE_DIRECTORY + "/plan.canonical.json";
const C18_PLAN_SHA256 = "17285cfc64496a789ef71ae8f618316484136fb8d255e6c21b06d152fd20b9ae";
const C18_ADJUDICATION_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-record.json";
const C18_ADJUDICATION_SHA256 = "1c5ececedf02af5e335273d2bbe97c8eec08db6362b5215d64c1df28d4eb1d25";
export const C18_ADJUDICATION_REVIEW_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-review-record.json";
const C18_ADJUDICATION_REVIEW_SHA256 = "edc8166bd16e818785c124fa624e9874b2a0159668423e1c605d87a53798c788";
const C18_ADJUDICATOR_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-progress-adjudicator-prod-20260829-18.json";
const C18_ADJUDICATOR_CONFIG_SHA256 = "b88001cb671d6e151cf9d627d844cb983d3e405e63a0f206bde958ed0688e436";
const C18_REVIEW_SOURCE_SNAPSHOT_SHA256 = "057a0d7092c3f3861615c3dc632416f8382e6673b7a473e6a13cd749ea7833db";
const C18_SOURCE_SHA256 = "c48fb7edd8e0915786d65d0858fec7032734d6cd12a1db58ec7cb0fb3cd5734d";
const C18_TEST_SHA256 = "b23c108fcb537b862ed7e64b9c010712726331816dab0a18a8b8f5f8d70e739c";
const C18_ADJUDICATOR_SOURCE_SHA256 = "ac82750d595be8c9b38dc2d1dcd89e56eb761cab14a900b50fb3f3c2b10112f2";
const C18_ADJUDICATOR_TEST_SHA256 = "9b91d78065cdee7e1ae6337e1fb4c0c8ac4561ba36e36f49757456aed26c38dc";
const C19_SOURCE_SHA256 = "a293e4e9af638fdcc5ccf932524105dce9f3fda6651603dd754d30ee478deffd";
const C19_TEST_SHA256 = "86a1449ae3f32ccb6f486c23d7efac5629ceffd9f7b2df714e647d1eb9d0df61";
const C19_DOC_SHA256 = "27eeaafc8d9e099fb766b40c89d7785750231bc0d793d935c314bddd9b5417e8";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const EXECUTION_SOURCE_PATH = fileURLToPath(import.meta.url);
const EXECUTION_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-execution-19.test.ts", import.meta.url));
const C19_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-cleanup-19.ts", import.meta.url));
const C19_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-cleanup-19.test.ts", import.meta.url));
const C19_DOC_PATH = fileURLToPath(new URL("../M4F-DIRECT-SIX-PROCESS-CLEANUP-18-19.md", import.meta.url));
const C18_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-parse-only-18.ts", import.meta.url));
const C18_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-parse-only-18.test.ts", import.meta.url));
const C18_ADJUDICATOR_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-parse-adjudicator-18.ts", import.meta.url));
const C18_ADJUDICATOR_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-parse-adjudicator-18.test.ts", import.meta.url));
const TRANSPORT_SOURCE_PATH = fileURLToPath(new URL("./m4f-gate-admission-transport.ts", import.meta.url));

export interface Candidate19ExecutionConfig {
  schema: "synthia-m4f-candidate19-execution-config.v1";
  execution_id: string;
  script_config: Candidate19ScriptConfig;
  script_config_path: typeof SCRIPT_CONFIG_PATH;
  script_config_sha256: typeof SCRIPT_CONFIG_SHA256;
  transport_config_path: typeof TRANSPORT_CONFIG_PATH;
  transport_config_sha256: typeof TRANSPORT_CONFIG_SHA256;
  candidate18_config_path: typeof C18_CONFIG_PATH;
  candidate18_config_sha256: typeof C18_CONFIG_SHA256;
  candidate18_evidence_directory: typeof C18_EVIDENCE_DIRECTORY;
  candidate18_plan_path: typeof C18_PLAN_PATH;
  candidate18_plan_sha256: typeof C18_PLAN_SHA256;
  candidate18_evidence_manifest_sha256: string;
  candidate18_source_sha256: typeof C18_SOURCE_SHA256;
  candidate18_test_sha256: typeof C18_TEST_SHA256;
  candidate18_adjudicator_source_sha256: typeof C18_ADJUDICATOR_SOURCE_SHA256;
  candidate18_adjudicator_test_sha256: typeof C18_ADJUDICATOR_TEST_SHA256;
  candidate18_adjudication_record_path: typeof C18_ADJUDICATION_PATH;
  candidate18_adjudication_record_sha256: typeof C18_ADJUDICATION_SHA256;
  candidate18_adjudication_review_path: typeof C18_ADJUDICATION_REVIEW_PATH;
  candidate18_adjudication_review_sha256: typeof C18_ADJUDICATION_REVIEW_SHA256;
  expected_candidate19_source_sha256: typeof C19_SOURCE_SHA256;
  expected_candidate19_test_sha256: typeof C19_TEST_SHA256;
  expected_candidate19_doc_sha256: typeof C19_DOC_SHA256;
  expected_transport_source_sha256: typeof TRANSPORT_SOURCE_SHA256;
  expected_source_sha256: string;
  expected_test_source_sha256: string;
  evidence_directory: string;
  effective_timeout_ms: typeof EFFECTIVE_TIMEOUT_MS;
  remote_timeout_ms: typeof REMOTE_TIMEOUT_MS;
}

export interface Candidate19ExecutionFileFact {
  schema: "synthia-m4f-candidate19-execution-local-file.v1";
  path: string;
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  sha256: string;
}

export interface Candidate19ExecutionCapturedFile {
  bytes: Buffer;
  fact: Candidate19ExecutionFileFact;
}

export interface Candidate19ExecutionAuthorization {
  schema: "synthia-m4f-candidate19-execution-authorization.v1";
  authorization_id: string;
  decision: "AUTHORIZED_FOR_EXACT_C19_EXECUTION";
  authorized_at_utc: string;
  reviewer_role: "independent_f0_execution_reviewer";
  seals: {
    execution_id: string;
    execution_config_sha256: string;
    execution_plan_sha256: string;
    execution_source_sha256: string;
    execution_test_sha256: string;
    c18_review_path: typeof C18_ADJUDICATION_REVIEW_PATH;
    c18_review_sha256: typeof C18_ADJUDICATION_REVIEW_SHA256;
    script_config_sha256: typeof SCRIPT_CONFIG_SHA256;
    transport_config_sha256: typeof TRANSPORT_CONFIG_SHA256;
    business_script_sha256: string;
    outer_loader_sha256: string;
    remote_command_sha256: string;
  };
  authorization_boundary: {
    cleanup_execution_authorized: true;
    network_authorized: true;
    ssh_authorized: true;
    remote_execution_authorized: true;
    retry_authorized: false;
    maximum_effective_audit_count: 1;
    maximum_remote_attempt_count: 1;
    remote_stdin_length: 0;
    hardware_download_authorized: false;
  };
  review_actions: {
    source_evidence_mutated: false;
    network_attempted: false;
    ssh_attempted: false;
    remote_execution_attempted: false;
    cleanup_performed: false;
  };
}

export interface Candidate19ExecutionDirectoryFact {
  path: string;
  device: number;
  inode: number;
  owner_uid: number;
  mode: number;
  link_count: number;
  mtime_ms: number;
  ctime_ms: number;
  entries: string[];
}

export interface Candidate19ExecutionDependencies {
  spawn(executable: string, args: readonly string[], stdin: Buffer, timeoutMs: number): RawProcessResult;
  captureFile(path: string): Candidate19ExecutionCapturedFile;
  captureDirectory(path: string): Candidate19ExecutionDirectoryFact;
  sourceFile(): Candidate19ExecutionCapturedFile;
  testSourceFile(): Candidate19ExecutionCapturedFile;
  candidate19SourceFile(): Candidate19ExecutionCapturedFile;
  candidate19TestSourceFile(): Candidate19ExecutionCapturedFile;
  candidate19DocFile(): Candidate19ExecutionCapturedFile;
  candidate18SourceFile(): Candidate19ExecutionCapturedFile;
  candidate18TestFile(): Candidate19ExecutionCapturedFile;
  candidate18AdjudicatorSourceFile(): Candidate19ExecutionCapturedFile;
  candidate18AdjudicatorTestFile(): Candidate19ExecutionCapturedFile;
  transportSourceFile(): Candidate19ExecutionCapturedFile;
  transportInputs(config: M4fDirectAdmissionConfig, stage: "local_preflight" | "network"): unknown[];
  createEvidenceDirectory(path: string): void;
  writeEvidence(path: string, bytes: Buffer): void;
  now(): Date;
}

export class Candidate19ExecutionFailure extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(String(detail.code ?? "M4F_CANDIDATE19_EXECUTION_FAILED"));
  }
}

const CONFIG_KEYS = [
  "candidate18_adjudication_record_path", "candidate18_adjudication_record_sha256",
  "candidate18_adjudication_review_path", "candidate18_adjudication_review_sha256",
  "candidate18_adjudicator_source_sha256", "candidate18_adjudicator_test_sha256",
  "candidate18_config_path", "candidate18_config_sha256", "candidate18_evidence_directory",
  "candidate18_evidence_manifest_sha256", "candidate18_plan_path", "candidate18_plan_sha256",
  "candidate18_source_sha256", "candidate18_test_sha256", "effective_timeout_ms",
  "evidence_directory", "execution_id", "expected_candidate19_doc_sha256",
  "expected_candidate19_source_sha256", "expected_candidate19_test_sha256", "expected_source_sha256",
  "expected_test_source_sha256", "expected_transport_source_sha256", "remote_timeout_ms", "schema",
  "script_config", "script_config_path", "script_config_sha256", "transport_config_path",
  "transport_config_sha256",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function canonicalJsonCandidate19Execution(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonCandidate19Execution).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonCandidate19Execution(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("/../") && !/[\r\n\0]/u.test(value) && resolve(value) === value;
}

function fail(code: string, stage: string, extra: Record<string, unknown> = {}): never {
  throw new Candidate19ExecutionFailure({
    schema: "synthia-m4f-candidate19-execution-failure.v1",
    code,
    stage,
    retry_permitted: false,
    cleanup_complete: false,
    network_authorized_for_retry: false,
    ...extra,
  });
}

export function validateCandidate19ExecutionConfig(value: unknown): Candidate19ExecutionConfig {
  const config = object(value);
  if (!config || !exactKeys(config, CONFIG_KEYS)
    || config.schema !== "synthia-m4f-candidate19-execution-config.v1"
    || typeof config.execution_id !== "string" || !SAFE_ID.test(config.execution_id)
    || config.script_config_path !== SCRIPT_CONFIG_PATH || config.script_config_sha256 !== SCRIPT_CONFIG_SHA256
    || config.transport_config_path !== TRANSPORT_CONFIG_PATH
    || config.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || config.candidate18_config_path !== C18_CONFIG_PATH
    || config.candidate18_config_sha256 !== C18_CONFIG_SHA256
    || config.candidate18_evidence_directory !== C18_EVIDENCE_DIRECTORY
    || config.candidate18_plan_path !== C18_PLAN_PATH || config.candidate18_plan_sha256 !== C18_PLAN_SHA256
    || config.candidate18_source_sha256 !== C18_SOURCE_SHA256
    || config.candidate18_test_sha256 !== C18_TEST_SHA256
    || config.candidate18_adjudicator_source_sha256 !== C18_ADJUDICATOR_SOURCE_SHA256
    || config.candidate18_adjudicator_test_sha256 !== C18_ADJUDICATOR_TEST_SHA256
    || config.candidate18_adjudication_record_path !== C18_ADJUDICATION_PATH
    || config.candidate18_adjudication_record_sha256 !== C18_ADJUDICATION_SHA256
    || config.candidate18_adjudication_review_path !== C18_ADJUDICATION_REVIEW_PATH
    || config.candidate18_adjudication_review_sha256 !== C18_ADJUDICATION_REVIEW_SHA256
    || config.expected_candidate19_source_sha256 !== C19_SOURCE_SHA256
    || config.expected_candidate19_test_sha256 !== C19_TEST_SHA256
    || config.expected_candidate19_doc_sha256 !== C19_DOC_SHA256
    || config.expected_transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || config.effective_timeout_ms !== EFFECTIVE_TIMEOUT_MS || config.remote_timeout_ms !== REMOTE_TIMEOUT_MS
    || !safePath(config.evidence_directory)
    || [config.candidate18_evidence_manifest_sha256, config.expected_source_sha256,
      config.expected_test_source_sha256]
      .some((item) => typeof item !== "string" || !HASH.test(item))) {
    fail("M4F_CANDIDATE19_EXECUTION_CONFIG_INVALID", "config");
  }
  try { validateCandidate19ScriptConfig(config.script_config); } catch {
    fail("M4F_CANDIDATE19_EXECUTION_CONFIG_INVALID", "config");
  }
  return value as Candidate19ExecutionConfig;
}

function decodeJson(bytes: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    fail(code, "local_preflight");
  }
}

function validFile(captured: Candidate19ExecutionCapturedFile, path: string, expectedHash: string): void {
  const fact = captured?.fact;
  if (!Buffer.isBuffer(captured?.bytes) || !fact
    || fact.schema !== "synthia-m4f-candidate19-execution-local-file.v1"
    || fact.path !== path || fact.sha256 !== expectedHash || sha256(captured.bytes) !== expectedHash
    || fact.owner_uid !== 501 || fact.size !== captured.bytes.length || fact.link_count !== 1
    || ![fact.device, fact.inode, fact.owner_uid, fact.mode, fact.link_count, fact.size,
      fact.mtime_ms, fact.ctime_ms].every((item) => Number.isFinite(item) && item >= 0)
    || ![0o600, 0o644].includes(fact.mode)) fail("M4F_CANDIDATE19_EXECUTION_INPUT_INVALID", "local_preflight");
}

function captureExpected(
  dependencies: Candidate19ExecutionDependencies,
  path: string,
  expectedHash: string,
): Candidate19ExecutionCapturedFile {
  let captured: Candidate19ExecutionCapturedFile;
  try { captured = dependencies.captureFile(path); } catch {
    fail("M4F_CANDIDATE19_EXECUTION_INPUT_MISSING", "local_preflight", { path });
  }
  validFile(captured, path, expectedHash);
  return captured;
}

function validateReview(
  value: unknown,
  config: Candidate19ExecutionConfig,
  record: Record<string, unknown>,
  currentFacts: Map<string, Candidate19ExecutionFileFact>,
  currentDirectory: Candidate19ExecutionDirectoryFact,
): Record<string, unknown> {
  const review = object(value);
  const adjudication = object(review?.adjudication);
  const adjudicator = object(review?.adjudicator_lineage);
  const evidence = object(review?.evidence_lineage);
  const snapshot = object(evidence?.source_snapshot);
  const snapshotFiles = object(snapshot?.evidence_files);
  const snapshotDirectory = object(snapshot?.evidence_directory);
  const c18 = object(review?.c18_lineage);
  const c19 = object(review?.c19_lineage);
  const boundary = object(review?.authorization_boundary);
  const actions = object(review?.review_actions);
  const recordHashes = object(record.evidence_hashes);
  const recordPayload = object(record.payload);
  const keys = [
    "adjudication", "adjudicator_lineage", "authorization_boundary", "c18_lineage",
    "c19_lineage", "decision", "evidence_lineage", "review_actions", "review_id",
    "review_record_created", "reviewed_at_utc", "schema",
  ];
  const boundaryKeys = [
    "c19_execution_authorized", "c19_execution_config_local_implementation_permitted",
    "c19_execution_freeze_design_permitted", "cleanup_execution_authorized",
    "network_authorized", "new_exact_confirmation_required", "new_execution_config_required",
    "new_execution_plan_required", "old_confirmation_reuse_permitted",
    "remote_execution_authorized", "retry_authorized", "source_evidence_mutated", "ssh_authorized",
  ];
  const actionKeys = [
    "cleanup_performed", "network_attempted", "remote_execution_attempted",
    "retry_attempted", "ssh_attempted",
  ];
  const boundFileMatches = (raw: unknown, path: string, hash: string): boolean => {
    const bound = object(raw);
    const current = currentFacts.get(path);
    const boundKeys = [
      "ctime_ms", "device", "inode", "link_count", "mode", "mtime_ms", "owner_uid",
      "path", "schema", "sha256", "size",
    ];
    return Boolean(bound && current && exactKeys(bound, boundKeys)
      && ["synthia-m4f-c18-adjudication-review-bound-file.v1",
        "synthia-m4f-c18-adjudicator-bound-file.v1"].includes(String(bound.schema))
      && bound.path === path && bound.sha256 === hash
      && bound.device === current.device && bound.inode === current.inode
      && bound.owner_uid === current.owner_uid && bound.mode === current.mode
      && bound.link_count === current.link_count && bound.size === current.size
      && bound.mtime_ms === current.mtime_ms && bound.ctime_ms === current.ctime_ms);
  };
  const directoryMatches = Boolean(snapshotDirectory
    && exactKeys(snapshotDirectory, [
      "ctime_ms", "device", "entries", "inode", "link_count", "mode", "mtime_ms",
      "owner_uid", "path", "schema",
    ])
    && snapshotDirectory.schema === "synthia-m4f-c18-adjudicator-bound-directory.v1"
    && snapshotDirectory.path === C18_EVIDENCE_DIRECTORY
    && snapshotDirectory.device === currentDirectory.device
    && snapshotDirectory.inode === currentDirectory.inode
    && snapshotDirectory.owner_uid === currentDirectory.owner_uid
    && snapshotDirectory.mode === currentDirectory.mode
    && snapshotDirectory.link_count === currentDirectory.link_count
    && snapshotDirectory.mtime_ms === currentDirectory.mtime_ms
    && snapshotDirectory.ctime_ms === currentDirectory.ctime_ms
    && canonicalJsonCandidate19Execution(snapshotDirectory.entries)
      === canonicalJsonCandidate19Execution(currentDirectory.entries));
  const evidenceNames = Object.keys(recordHashes ?? {}).sort();
  const snapshotEvidenceValid = Boolean(snapshotFiles && exactKeys(snapshotFiles, evidenceNames)
    && evidenceNames.every((name) => boundFileMatches(
      snapshotFiles[name], `${C18_EVIDENCE_DIRECTORY}/${name}`, String(recordHashes?.[name]),
    )));
  if (!review || !exactKeys(review, keys)
    || review.schema !== "synthia-m4f-c18-local-adjudication-review-record.v1"
    || review.review_id !== "m4f-direct-six-process-parse-progress-review-prod-20260829-18"
    || typeof review.reviewed_at_utc !== "string" || !UTC.test(review.reviewed_at_utc)
    || review.review_record_created !== true
    || review.decision !== "GO_FOR_C19_EXECUTION_FREEZE_ONLY"
    || !adjudication || !exactKeys(adjudication,
      ["original_failure_preserved", "path", "sha256", "status"])
    || adjudication.path !== C18_ADJUDICATION_PATH || adjudication.sha256 !== C18_ADJUDICATION_SHA256
    || adjudication.status !== "parse_success_locally_adjudicated"
    || adjudication.original_failure_preserved !== true
    || !adjudicator || !exactKeys(adjudicator,
      ["config_path", "config_sha256", "source_path", "source_sha256", "test_path", "test_sha256"])
    || adjudicator.config_path !== C18_ADJUDICATOR_CONFIG_PATH
    || adjudicator.config_sha256 !== C18_ADJUDICATOR_CONFIG_SHA256
    || adjudicator.source_path !== C18_ADJUDICATOR_SOURCE_PATH
    || adjudicator.source_sha256 !== C18_ADJUDICATOR_SOURCE_SHA256
    || adjudicator.test_path !== C18_ADJUDICATOR_TEST_PATH
    || adjudicator.test_sha256 !== C18_ADJUDICATOR_TEST_SHA256
    || !evidence || !exactKeys(evidence, [
      "directory", "exact_file_count", "exact_file_set", "hashes", "source_snapshot",
      "source_snapshot_sha256",
    ])
    || evidence.directory !== C18_EVIDENCE_DIRECTORY || evidence.exact_file_count !== 21
    || evidence.exact_file_set !== true || !recordHashes || evidenceNames.length !== 21
    || canonicalJsonCandidate19Execution(evidence.hashes)
      !== canonicalJsonCandidate19Execution(recordHashes)
    || sha256(canonicalJsonCandidate19Execution(recordHashes) + "\n")
      !== config.candidate18_evidence_manifest_sha256
    || !snapshot || !exactKeys(snapshot, [
      "adjudication_record", "adjudicator_config", "adjudicator_source", "adjudicator_test",
      "evidence_directory", "evidence_files",
    ])
    || evidence.source_snapshot_sha256 !== C18_REVIEW_SOURCE_SNAPSHOT_SHA256
    || sha256(canonicalJsonCandidate19Execution(snapshot) + "\n") !== C18_REVIEW_SOURCE_SNAPSHOT_SHA256
    || !boundFileMatches(snapshot.adjudication_record, C18_ADJUDICATION_PATH, C18_ADJUDICATION_SHA256)
    || !boundFileMatches(snapshot.adjudicator_config,
      C18_ADJUDICATOR_CONFIG_PATH, C18_ADJUDICATOR_CONFIG_SHA256)
    || !boundFileMatches(snapshot.adjudicator_source,
      C18_ADJUDICATOR_SOURCE_PATH, C18_ADJUDICATOR_SOURCE_SHA256)
    || !boundFileMatches(snapshot.adjudicator_test,
      C18_ADJUDICATOR_TEST_PATH, C18_ADJUDICATOR_TEST_SHA256)
    || !directoryMatches || !snapshotEvidenceValid
    || !c18 || !exactKeys(c18,
      ["config_sha256", "parse_status", "plan_sha256", "source_sha256", "test_sha256"])
    || c18.config_sha256 !== C18_CONFIG_SHA256 || c18.plan_sha256 !== C18_PLAN_SHA256
    || c18.source_sha256 !== C18_SOURCE_SHA256 || c18.test_sha256 !== C18_TEST_SHA256
    || c18.parse_status !== "parsed_not_invoked"
    || !c19 || !exactKeys(c19, [
      "business_script_sha256", "command_sha256", "doc_sha256", "outer_loader_sha256",
      "script_config_sha256", "source_sha256", "test_sha256", "transport_config_sha256",
      "transport_source_sha256",
    ])
    || c19.script_config_sha256 !== SCRIPT_CONFIG_SHA256 || c19.source_sha256 !== C19_SOURCE_SHA256
    || c19.test_sha256 !== C19_TEST_SHA256 || c19.doc_sha256 !== C19_DOC_SHA256
    || c19.transport_source_sha256 !== TRANSPORT_SOURCE_SHA256
    || c19.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || !recordPayload || c19.business_script_sha256 !== recordPayload.business_script_sha256
    || c19.outer_loader_sha256 !== recordPayload.outer_loader_sha256
    || c19.command_sha256 !== recordPayload.command_sha256
    || !boundary || !exactKeys(boundary, boundaryKeys)
    || boundary.c19_execution_config_local_implementation_permitted !== true
    || boundary.c19_execution_freeze_design_permitted !== true
    || boundary.c19_execution_authorized !== false
    || boundary.cleanup_execution_authorized !== false || boundary.network_authorized !== false
    || boundary.ssh_authorized !== false || boundary.remote_execution_authorized !== false
    || boundary.retry_authorized !== false
    || boundary.new_execution_config_required !== true || boundary.new_execution_plan_required !== true
    || boundary.new_exact_confirmation_required !== true || boundary.old_confirmation_reuse_permitted !== false
    || boundary.source_evidence_mutated !== false
    || !actions || !exactKeys(actions, actionKeys)
    || actions.network_attempted !== false || actions.ssh_attempted !== false
    || actions.remote_execution_attempted !== false || actions.retry_attempted !== false
    || actions.cleanup_performed !== false
    || record.eligible_for_c19_execution_freeze !== true || record.c19_execution_authorized !== false
    || record.cleanup_execution_authorized !== false || record.network_authorized !== false
    || record.ssh_authorized !== false || record.remote_execution_authorized !== false
    || record.retry_authorized !== false) {
    fail("M4F_CANDIDATE19_EXECUTION_REVIEW_INVALID", "local_preflight");
  }
  return review;
}

function validateAdjudicationRecord(
  value: unknown,
  config: Candidate19ExecutionConfig,
): Record<string, unknown> {
  const record = object(value);
  const payload = object(record?.payload);
  const hashes = object(record?.evidence_hashes);
  if (!record || record.schema !== "synthia-m4f-c18-local-adjudication-record.v1"
    || record.status !== "parse_success_locally_adjudicated"
    || record.parse_id !== "m4f-direct-six-process-parse-only-prod-20260829-18"
    || record.original_failure_preserved !== true || record.eligible_for_c19_execution_freeze !== true
    || record.config_sha256 !== C18_CONFIG_SHA256 || record.plan_sha256 !== C18_PLAN_SHA256
    || record.candidate19_script_config_sha256 !== SCRIPT_CONFIG_SHA256
    || record.evidence_directory !== C18_EVIDENCE_DIRECTORY || record.evidence_file_count !== 21
    || record.evidence_exact_file_set !== true || !hashes || Object.keys(hashes).length !== 21
    || sha256(canonicalJsonCandidate19Execution(hashes) + "\n")
      !== config.candidate18_evidence_manifest_sha256
    || !payload || typeof payload.business_script_sha256 !== "string"
    || typeof payload.outer_loader_sha256 !== "string" || typeof payload.command_sha256 !== "string") {
    fail("M4F_CANDIDATE19_EXECUTION_ADJUDICATION_INVALID", "local_preflight");
  }
  return record;
}

function validatePlan(planValue: unknown, payload: Candidate19BuiltPayload): Record<string, unknown> {
  const plan = object(planValue);
  if (!plan || plan.schema !== "synthia-m4f-candidate18-parse-only-plan.v1"
    || plan.status !== "planned_not_executed" || plan.candidate19_script_config_sha256 !== SCRIPT_CONFIG_SHA256
    || plan.business_script_sha256 !== payload.business_script_sha256
    || plan.outer_loader_sha256 !== payload.outer_loader_sha256
    || plan.business_script_utf8_length !== Buffer.byteLength(payload.business_script, "utf8")
    || plan.outer_loader_utf8_length !== Buffer.byteLength(payload.outer_loader, "utf8")
    || plan.parse_target_count !== 2 || plan.business_target_body_not_invoked !== true
    || plan.outer_loader_target_body_not_invoked !== true || plan.cleanup_performed !== false
    || plan.retry_permitted !== false) fail("M4F_CANDIDATE19_EXECUTION_C18_PLAN_INVALID", "local_preflight");
  return plan;
}

function sourceFacts(config: Candidate19ExecutionConfig, dependencies: Candidate19ExecutionDependencies) {
  const facts: Array<[Candidate19ExecutionCapturedFile, string, string]> = [
    [dependencies.sourceFile(), EXECUTION_SOURCE_PATH, config.expected_source_sha256],
    [dependencies.testSourceFile(), EXECUTION_TEST_PATH, config.expected_test_source_sha256],
    [dependencies.candidate19SourceFile(), C19_SOURCE_PATH, C19_SOURCE_SHA256],
    [dependencies.candidate19TestSourceFile(), C19_TEST_PATH, C19_TEST_SHA256],
    [dependencies.candidate19DocFile(), C19_DOC_PATH, C19_DOC_SHA256],
    [dependencies.candidate18SourceFile(), C18_SOURCE_PATH, C18_SOURCE_SHA256],
    [dependencies.candidate18TestFile(), C18_TEST_PATH, C18_TEST_SHA256],
    [dependencies.candidate18AdjudicatorSourceFile(), C18_ADJUDICATOR_SOURCE_PATH, C18_ADJUDICATOR_SOURCE_SHA256],
    [dependencies.candidate18AdjudicatorTestFile(), C18_ADJUDICATOR_TEST_PATH, C18_ADJUDICATOR_TEST_SHA256],
    [dependencies.transportSourceFile(), TRANSPORT_SOURCE_PATH, TRANSPORT_SOURCE_SHA256],
  ];
  for (const [captured, path, expected] of facts) validFile(captured, path, expected);
  return facts.map(([captured]) => captured.fact);
}

function loadContext(rawConfig: unknown, dependencies: Candidate19ExecutionDependencies) {
  const config = validateCandidate19ExecutionConfig(rawConfig);
  const sources = sourceFacts(config, dependencies);
  const scriptFile = captureExpected(dependencies, SCRIPT_CONFIG_PATH, SCRIPT_CONFIG_SHA256);
  const canonicalScript = Buffer.from(canonicalJson19(config.script_config) + "\n", "utf8");
  if (!scriptFile.bytes.equals(canonicalScript)) fail("M4F_CANDIDATE19_EXECUTION_SCRIPT_SPLIT_BRAIN", "local_preflight");
  const scriptConfig = validateCandidate19ScriptConfig(decodeJson(
    scriptFile.bytes, "M4F_CANDIDATE19_EXECUTION_SCRIPT_CONFIG_INVALID",
  ));
  if (canonicalJson19(scriptConfig) !== canonicalJson19(config.script_config)) {
    fail("M4F_CANDIDATE19_EXECUTION_SCRIPT_SPLIT_BRAIN", "local_preflight");
  }
  const transportFile = captureExpected(dependencies, TRANSPORT_CONFIG_PATH, TRANSPORT_CONFIG_SHA256);
  const transport = validateM4fDirectAdmissionConfig(decodeJson(
    transportFile.bytes, "M4F_CANDIDATE19_EXECUTION_TRANSPORT_INVALID",
  ));
  if (transport.target.host !== TARGET_HOST || transport.target.expected_effective_config_sha256 === null
    || transport.target.computer_name !== scriptConfig.target_computer
    || transport.target.identity_name !== scriptConfig.target_identity_name
    || transport.target.identity_sid !== scriptConfig.target_identity_sid) {
    fail("M4F_CANDIDATE19_EXECUTION_TRANSPORT_INVALID", "local_preflight");
  }
  const c18ConfigFile = captureExpected(dependencies, C18_CONFIG_PATH, C18_CONFIG_SHA256);
  const c18Config = object(decodeJson(c18ConfigFile.bytes, "M4F_CANDIDATE19_EXECUTION_C18_CONFIG_INVALID"));
  if (!c18Config || c18Config.candidate19_script_config_sha256 !== SCRIPT_CONFIG_SHA256
    || c18Config.candidate19_script_config_path !== SCRIPT_CONFIG_PATH
    || c18Config.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || c18Config.evidence_directory !== C18_EVIDENCE_DIRECTORY) {
    fail("M4F_CANDIDATE19_EXECUTION_C18_CONFIG_INVALID", "local_preflight");
  }
  const payload = buildCandidate19Payload(scriptConfig);
  const planFile = captureExpected(dependencies, C18_PLAN_PATH, C18_PLAN_SHA256);
  const plan = validatePlan(decodeJson(planFile.bytes, "M4F_CANDIDATE19_EXECUTION_C18_PLAN_INVALID"), payload);
  const adjudicationFile = captureExpected(dependencies, C18_ADJUDICATION_PATH, C18_ADJUDICATION_SHA256);
  const adjudication = validateAdjudicationRecord(decodeJson(
    adjudicationFile.bytes, "M4F_CANDIDATE19_EXECUTION_ADJUDICATION_INVALID",
  ), config);
  const reviewFile = captureExpected(
    dependencies, C18_ADJUDICATION_REVIEW_PATH, C18_ADJUDICATION_REVIEW_SHA256,
  );
  const reviewValue = decodeJson(reviewFile.bytes, "M4F_CANDIDATE19_EXECUTION_REVIEW_INVALID");
  const adjudicatorConfigFile = captureExpected(
    dependencies, C18_ADJUDICATOR_CONFIG_PATH, C18_ADJUDICATOR_CONFIG_SHA256,
  );
  const evidenceHashes = object(adjudication.evidence_hashes)!;
  const directory = dependencies.captureDirectory(C18_EVIDENCE_DIRECTORY);
  const names = Object.keys(evidenceHashes).sort();
  if (directory.path !== C18_EVIDENCE_DIRECTORY || directory.owner_uid !== 501
    || directory.mode !== 0o700 || directory.link_count < 1
    || ![directory.device, directory.inode, directory.owner_uid, directory.mode,
      directory.link_count, directory.mtime_ms, directory.ctime_ms]
      .every((item) => Number.isFinite(item) && item >= 0)
    || canonicalJsonCandidate19Execution(directory.entries)
    !== canonicalJsonCandidate19Execution(names)) fail("M4F_CANDIDATE19_EXECUTION_C18_EVIDENCE_INVALID", "local_preflight");
  const evidenceFacts: Candidate19ExecutionFileFact[] = [];
  for (const name of names) {
    if (name.includes("/") || typeof evidenceHashes[name] !== "string" || !HASH.test(String(evidenceHashes[name]))) {
      fail("M4F_CANDIDATE19_EXECUTION_C18_EVIDENCE_INVALID", "local_preflight");
    }
    evidenceFacts.push(captureExpected(
      dependencies, `${C18_EVIDENCE_DIRECTORY}/${name}`, String(evidenceHashes[name]),
    ).fact);
  }
  const targetBusiness = captureExpected(
    dependencies, C18_EVIDENCE_DIRECTORY + "/target-business-script.ps1", payload.business_script_sha256,
  );
  const targetOuter = captureExpected(
    dependencies, C18_EVIDENCE_DIRECTORY + "/target-outer-loader.ps1", payload.outer_loader_sha256,
  );
  const recordPayload = object(adjudication.payload)!;
  if (!targetBusiness.bytes.equals(Buffer.from(payload.business_script, "utf8"))
    || !targetOuter.bytes.equals(Buffer.from(payload.outer_loader, "utf8"))
    || recordPayload.business_script_length !== Buffer.byteLength(payload.business_script, "utf8")
    || recordPayload.business_script_sha256 !== payload.business_script_sha256
    || recordPayload.outer_loader_length !== Buffer.byteLength(payload.outer_loader, "utf8")
    || recordPayload.outer_loader_sha256 !== payload.outer_loader_sha256
    || recordPayload.command_sha256 !== plan.command_sha256) {
    fail("M4F_CANDIDATE19_EXECUTION_PAYLOAD_DRIFT", "local_preflight");
  }
  const inputFacts = [
    ...sources, scriptFile.fact, transportFile.fact, c18ConfigFile.fact, planFile.fact,
    adjudicationFile.fact, reviewFile.fact, adjudicatorConfigFile.fact, directory, ...evidenceFacts,
  ];
  const currentFacts = new Map(inputFacts
    .filter((fact): fact is Candidate19ExecutionFileFact => "sha256" in fact)
    .map((fact) => [fact.path, fact]));
  const review = validateReview(reviewValue, config, adjudication, currentFacts, directory);
  return { config, scriptConfig, transport, payload, adjudication, review, inputFacts };
}

function contextFingerprint(context: ReturnType<typeof loadContext>): string {
  return sha256(canonicalJsonCandidate19Execution({
    input_facts: context.inputFacts,
    business_script_sha256: context.payload.business_script_sha256,
    outer_loader_sha256: context.payload.outer_loader_sha256,
    remote_command_sha256: context.payload.remote_command_sha256,
  }) + "\n");
}

function buildFreezePlan(context: ReturnType<typeof loadContext>): Record<string, unknown> {
  return {
    schema: "synthia-m4f-candidate19-execution-plan.v1",
    status: "freeze_only_not_authorized",
    execution_id: context.config.execution_id,
    target_host: context.transport.target.host,
    target_computer: context.scriptConfig.target_computer,
    script_config_sha256: SCRIPT_CONFIG_SHA256,
    candidate18_config_sha256: C18_CONFIG_SHA256,
    candidate18_plan_sha256: C18_PLAN_SHA256,
    candidate18_adjudication_record_sha256: C18_ADJUDICATION_SHA256,
    candidate18_adjudication_review_sha256: context.config.candidate18_adjudication_review_sha256,
    candidate18_evidence_manifest_sha256: context.config.candidate18_evidence_manifest_sha256,
    context_fingerprint: contextFingerprint(context),
    business_script_length: Buffer.byteLength(context.payload.business_script, "utf8"),
    business_script_sha256: context.payload.business_script_sha256,
    outer_loader_length: Buffer.byteLength(context.payload.outer_loader, "utf8"),
    outer_loader_sha256: context.payload.outer_loader_sha256,
    remote_command_length: context.payload.remote_command.length,
    remote_command_sha256: context.payload.remote_command_sha256,
    targets: context.scriptConfig.targets,
    protected_worker: context.scriptConfig.protected_worker,
    protected_listeners: context.scriptConfig.protected_listeners,
    effective_timeout_ms: EFFECTIVE_TIMEOUT_MS,
    remote_timeout_ms: REMOTE_TIMEOUT_MS,
    effective_audit_count: 1,
    remote_attempt_count: 1,
    remote_stdin_length: 0,
    c18_review_decision: "GO_FOR_C19_EXECUTION_FREEZE_ONLY",
    execution_authorization_required: true,
    execution_authorized: false,
    exact_confirmation_required: true,
    final_confirmation_issued: false,
    network_attempted: false,
    cleanup_performed: false,
    retry_permitted: false,
  };
}

export function planCandidate19Execution(
  rawConfig: unknown,
  dependencies: Candidate19ExecutionDependencies,
): Record<string, unknown> {
  return buildFreezePlan(loadContext(rawConfig, dependencies));
}

export function candidate19ExecutionAuthorizationPath(rawConfig: unknown): string {
  const config = validateCandidate19ExecutionConfig(rawConfig);
  return `/private/tmp/${config.execution_id}-authorization-record.json`;
}

function validateExecutionAuthorization(
  value: unknown,
  context: ReturnType<typeof loadContext>,
  plan: Record<string, unknown>,
): Candidate19ExecutionAuthorization {
  const authorization = object(value);
  const seals = object(authorization?.seals);
  const boundary = object(authorization?.authorization_boundary);
  const actions = object(authorization?.review_actions);
  const keys = [
    "authorization_boundary", "authorization_id", "authorized_at_utc", "decision",
    "review_actions", "reviewer_role", "schema", "seals",
  ];
  const sealKeys = [
    "business_script_sha256", "c18_review_path", "c18_review_sha256", "execution_config_sha256",
    "execution_id", "execution_plan_sha256", "execution_source_sha256", "execution_test_sha256",
    "outer_loader_sha256", "remote_command_sha256", "script_config_sha256",
    "transport_config_sha256",
  ];
  const boundaryKeys = [
    "cleanup_execution_authorized", "hardware_download_authorized", "maximum_effective_audit_count",
    "maximum_remote_attempt_count", "network_authorized", "remote_execution_authorized",
    "remote_stdin_length", "retry_authorized", "ssh_authorized",
  ];
  const actionKeys = [
    "cleanup_performed", "network_attempted", "remote_execution_attempted",
    "source_evidence_mutated", "ssh_attempted",
  ];
  if (!authorization || !exactKeys(authorization, keys)
    || authorization.schema !== "synthia-m4f-candidate19-execution-authorization.v1"
    || authorization.authorization_id !== `${context.config.execution_id}-f0-authorization`
    || authorization.decision !== "AUTHORIZED_FOR_EXACT_C19_EXECUTION"
    || typeof authorization.authorized_at_utc !== "string" || !UTC.test(authorization.authorized_at_utc)
    || authorization.reviewer_role !== "independent_f0_execution_reviewer"
    || !seals || !exactKeys(seals, sealKeys)
    || seals.execution_id !== context.config.execution_id
    || seals.execution_config_sha256
      !== sha256(canonicalJsonCandidate19Execution(context.config) + "\n")
    || seals.execution_plan_sha256 !== sha256(canonicalJsonCandidate19Execution(plan) + "\n")
    || seals.execution_source_sha256 !== context.config.expected_source_sha256
    || seals.execution_test_sha256 !== context.config.expected_test_source_sha256
    || seals.c18_review_path !== C18_ADJUDICATION_REVIEW_PATH
    || seals.c18_review_sha256 !== C18_ADJUDICATION_REVIEW_SHA256
    || seals.script_config_sha256 !== SCRIPT_CONFIG_SHA256
    || seals.transport_config_sha256 !== TRANSPORT_CONFIG_SHA256
    || seals.business_script_sha256 !== context.payload.business_script_sha256
    || seals.outer_loader_sha256 !== context.payload.outer_loader_sha256
    || seals.remote_command_sha256 !== context.payload.remote_command_sha256
    || !boundary || !exactKeys(boundary, boundaryKeys)
    || boundary.cleanup_execution_authorized !== true || boundary.network_authorized !== true
    || boundary.ssh_authorized !== true || boundary.remote_execution_authorized !== true
    || boundary.retry_authorized !== false || boundary.maximum_effective_audit_count !== 1
    || boundary.maximum_remote_attempt_count !== 1 || boundary.remote_stdin_length !== 0
    || boundary.hardware_download_authorized !== false
    || !actions || !exactKeys(actions, actionKeys)
    || actions.source_evidence_mutated !== false || actions.network_attempted !== false
    || actions.ssh_attempted !== false || actions.remote_execution_attempted !== false
    || actions.cleanup_performed !== false) {
    fail("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID", "local_preflight");
  }
  return value as Candidate19ExecutionAuthorization;
}

function loadExecutionAuthorization(
  context: ReturnType<typeof loadContext>,
  plan: Record<string, unknown>,
  authorizationPath: string,
  authorizationSha256: string,
  dependencies: Candidate19ExecutionDependencies,
) {
  if (authorizationPath !== candidate19ExecutionAuthorizationPath(context.config)
    || !HASH.test(authorizationSha256)) {
    fail("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_REQUIRED", "local_preflight");
  }
  let captured: Candidate19ExecutionCapturedFile;
  try { captured = dependencies.captureFile(authorizationPath); } catch {
    fail("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_MISSING", "local_preflight", {
      path: authorizationPath,
    });
  }
  try { validFile(captured, authorizationPath, authorizationSha256); } catch {
    fail("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID", "local_preflight");
  }
  if (captured.fact.mode !== 0o600) {
    fail("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID", "local_preflight");
  }
  const value = decodeJson(captured.bytes, "M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID");
  if (!captured.bytes.equals(Buffer.from(canonicalJsonCandidate19Execution(value) + "\n"))) {
    fail("M4F_CANDIDATE19_EXECUTION_AUTHORIZATION_INVALID", "local_preflight");
  }
  return {
    value: validateExecutionAuthorization(value, context, plan),
    file: captured,
    sha256: authorizationSha256,
  };
}

function loadAuthorizedContext(
  rawConfig: unknown,
  authorizationPath: string,
  authorizationSha256: string,
  dependencies: Candidate19ExecutionDependencies,
) {
  const context = loadContext(rawConfig, dependencies);
  const plan = buildFreezePlan(context);
  const authorization = loadExecutionAuthorization(
    context, plan, authorizationPath, authorizationSha256, dependencies,
  );
  return { ...context, plan, authorization };
}

function authorizedContextFingerprint(context: ReturnType<typeof loadAuthorizedContext>): string {
  return sha256(canonicalJsonCandidate19Execution({
    freeze_context_fingerprint: contextFingerprint(context),
    execution_plan_sha256: sha256(canonicalJsonCandidate19Execution(context.plan) + "\n"),
    authorization_path: context.authorization.file.fact.path,
    authorization_sha256: context.authorization.sha256,
    authorization_file_fact: context.authorization.file.fact,
  }) + "\n");
}

function confirmationForAuthorizedContext(context: ReturnType<typeof loadAuthorizedContext>): string {
  return [
    "SYNTHIA_M4F_CANDIDATE19_AUTHORIZED_EXACT_SIX_PROCESS_CLEANUP",
    context.config.execution_id,
    sha256(canonicalJsonCandidate19Execution(context.config) + "\n"),
    sha256(canonicalJsonCandidate19Execution(context.plan) + "\n"),
    context.authorization.sha256,
    context.config.expected_source_sha256,
    context.config.expected_test_source_sha256,
    SCRIPT_CONFIG_SHA256,
    context.plan.business_script_sha256,
    context.plan.outer_loader_sha256,
    context.plan.remote_command_sha256,
    C18_ADJUDICATION_SHA256,
    C18_ADJUDICATION_REVIEW_SHA256,
    TRANSPORT_CONFIG_SHA256,
  ].join(":");
}

export function candidate19ExecutionConfirmation(
  rawConfig: unknown,
  authorizationPath: string,
  authorizationSha256: string,
  dependencies: Candidate19ExecutionDependencies,
): string {
  return confirmationForAuthorizedContext(loadAuthorizedContext(
    rawConfig, authorizationPath, authorizationSha256, dependencies,
  ));
}

function processEvidence(raw: RawProcessResult, stdin: Buffer): Record<string, unknown> {
  return {
    exit_status: raw.status,
    signal: raw.signal,
    error_code: raw.errorCode,
    timed_out: raw.errorCode === "ETIMEDOUT",
    outcome_ambiguous: raw.status === null || raw.signal !== null || raw.errorCode !== null,
    stdin_length: stdin.length,
    stdin_sha256: sha256(stdin),
    stdout_length: raw.stdout.length,
    stdout_sha256: sha256(raw.stdout),
    stderr_length: raw.stderr.length,
    stderr_sha256: sha256(raw.stderr),
    retry_permitted: false,
  };
}

function writeEvidence(
  dependencies: Candidate19ExecutionDependencies,
  directory: string,
  name: string,
  value: string | Buffer,
): void {
  try { dependencies.writeEvidence(directory + "/" + name, Buffer.isBuffer(value) ? value : Buffer.from(value)); } catch {
    fail("M4F_CANDIDATE19_EXECUTION_EVIDENCE_WRITE_FAILED", "evidence");
  }
}

function markerSummary(raw: Buffer, config: Candidate19ScriptConfig) {
  const parsed = parseCandidate19MarkerPrefix(raw, config);
  return {
    parsed,
    summary: {
      marker_count: parsed.markers.length,
      phases: parsed.markers.map((marker) => marker.phase),
      valid_prefix_length: parsed.valid_prefix_length,
      valid_prefix_sha256: parsed.valid_prefix_sha256,
      trailing_fragment_length: parsed.trailing_fragment_length,
      trailing_fragment_sha256: parsed.trailing_fragment_sha256,
      effect_start_ordinals: parsed.effect_start_ordinals,
      effect_result_ordinals: parsed.effect_result_ordinals,
      complete: parsed.complete,
    },
  };
}

export function executeCandidate19Execution(
  rawConfig: unknown,
  authorizationPath: string,
  authorizationSha256: string,
  confirmation: string,
  evidenceDirectory: string,
  dependencies: Candidate19ExecutionDependencies,
): Record<string, unknown> {
  const context = loadAuthorizedContext(
    rawConfig, authorizationPath, authorizationSha256, dependencies,
  );
  const expectedConfirmation = confirmationForAuthorizedContext(context);
  if (confirmation !== expectedConfirmation) fail("M4F_CANDIDATE19_EXECUTION_CONFIRMATION_REQUIRED", "local_preflight");
  if (resolve(evidenceDirectory) !== evidenceDirectory
    || evidenceDirectory !== context.config.evidence_directory) {
    fail("M4F_CANDIDATE19_EXECUTION_EVIDENCE_PATH_INVALID", "local_preflight");
  }
  const initialTransport = dependencies.transportInputs(context.transport, "local_preflight");
  try { dependencies.createEvidenceDirectory(evidenceDirectory); } catch {
    fail("M4F_CANDIDATE19_EXECUTION_EVIDENCE_CREATE_FAILED", "local_preflight");
  }
  let remote: RawProcessResult | null = null;
  let marker: ReturnType<typeof markerSummary> | null = null;
  let remoteAttempted = false;
  try {
    const plan = context.plan;
    writeEvidence(dependencies, evidenceDirectory, "execution-config.canonical.json",
      canonicalJsonCandidate19Execution(context.config) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "plan.canonical.json",
      canonicalJsonCandidate19Execution(plan) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "execution-authorization.raw.json",
      context.authorization.file.bytes);
    writeEvidence(dependencies, evidenceDirectory, "execution-authorization-fact.json",
      JSON.stringify(context.authorization.file.fact, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "confirmation.sha256", sha256(confirmation) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "transport-inputs-initial.json",
      JSON.stringify(initialTransport, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "input-facts-initial.json",
      JSON.stringify(context.inputFacts, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "remote-command.json", JSON.stringify({
      length: context.payload.remote_command.length,
      sha256: context.payload.remote_command_sha256,
      stdin_length: 0,
      stdin_sha256: EMPTY_SHA256,
    }, null, 2) + "\n");

    const effective = dependencies.spawn(
      SSH_PATH, buildDirectSshEffectiveArguments(context.transport), Buffer.alloc(0), EFFECTIVE_TIMEOUT_MS,
    );
    writeEvidence(dependencies, evidenceDirectory, "ssh-effective-stdout.raw", effective.stdout);
    writeEvidence(dependencies, evidenceDirectory, "ssh-effective-stderr.raw", effective.stderr);
    writeEvidence(dependencies, evidenceDirectory, "ssh-effective-process.json",
      JSON.stringify(processEvidence(effective, Buffer.alloc(0)), null, 2) + "\n");
    if (effective.status !== 0 || effective.signal !== null || effective.errorCode !== null
      || effective.stderr.length !== 0
      || sha256(effective.stdout) !== context.transport.target.expected_effective_config_sha256) {
      fail("M4F_CANDIDATE19_EXECUTION_EFFECTIVE_CONFIG_FAILED", "local_preflight");
    }
    auditDirectSshEffectiveConfig(effective.stdout, context.transport);

    const preContext = loadAuthorizedContext(
      context.config, authorizationPath, authorizationSha256, dependencies,
    );
    if (authorizedContextFingerprint(preContext) !== authorizedContextFingerprint(context)) {
      fail("M4F_CANDIDATE19_EXECUTION_INPUT_DRIFT", "local_preflight");
    }
    const preTransport = dependencies.transportInputs(context.transport, "network");
    writeEvidence(dependencies, evidenceDirectory, "transport-inputs-pre-remote.json",
      JSON.stringify(preTransport, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "input-facts-pre-remote.json",
      JSON.stringify(preContext.inputFacts, null, 2) + "\n");
    if (canonicalJsonCandidate19Execution(initialTransport)
      !== canonicalJsonCandidate19Execution(preTransport)) {
      fail("M4F_CANDIDATE19_EXECUTION_TRANSPORT_INPUT_DRIFT", "local_preflight");
    }

    remoteAttempted = true;
    remote = dependencies.spawn(
      SSH_PATH,
      [...buildDirectSshOptions(context.transport), TARGET_HOST, context.payload.remote_command],
      Buffer.alloc(0),
      REMOTE_TIMEOUT_MS,
    );
    writeEvidence(dependencies, evidenceDirectory, "stdout.raw", remote.stdout);
    writeEvidence(dependencies, evidenceDirectory, "stderr.raw", remote.stderr);
    writeEvidence(dependencies, evidenceDirectory, "remote-process.json",
      JSON.stringify(processEvidence(remote, Buffer.alloc(0)), null, 2) + "\n");
    marker = markerSummary(remote.stdout, context.scriptConfig);
    writeEvidence(dependencies, evidenceDirectory, "marker-prefix.raw", marker.parsed.valid_prefix);
    writeEvidence(dependencies, evidenceDirectory, "marker-trailing.raw", marker.parsed.trailing_fragment);
    writeEvidence(dependencies, evidenceDirectory, "marker-summary.json",
      JSON.stringify(marker.summary, null, 2) + "\n");

    const postContext = loadAuthorizedContext(
      context.config, authorizationPath, authorizationSha256, dependencies,
    );
    const postTransport = dependencies.transportInputs(context.transport, "network");
    writeEvidence(dependencies, evidenceDirectory, "transport-inputs-post-remote.json",
      JSON.stringify(postTransport, null, 2) + "\n");
    writeEvidence(dependencies, evidenceDirectory, "input-facts-post-remote.json",
      JSON.stringify(postContext.inputFacts, null, 2) + "\n");
    if (authorizedContextFingerprint(postContext) !== authorizedContextFingerprint(context)
      || canonicalJsonCandidate19Execution(initialTransport)
        !== canonicalJsonCandidate19Execution(postTransport)) {
      fail("M4F_CANDIDATE19_EXECUTION_POSTFLIGHT_INPUT_DRIFT", "network_postflight", {
        marker: marker.summary,
      });
    }

    const process = processEvidence(remote, Buffer.alloc(0));
    const cleanProcess = remote.status === 0 && remote.signal === null && remote.errorCode === null;
    if (!cleanProcess || remote.stderr.length !== 0 || !marker.parsed.complete
      || marker.parsed.trailing_fragment_length !== 0) {
      const effectState = marker.parsed.effect_start_ordinals.length > 0
        ? "effects_may_have_occurred" : "no_effect_marker_observed";
      fail("M4F_CANDIDATE19_EXECUTION_PARTIAL_OR_FAILED", "network", {
        effect_state: effectState,
        process,
        marker: marker.summary,
      });
    }
    const record = {
      schema: "synthia-m4f-candidate19-execution-record.v1",
      execution_id: context.config.execution_id,
      status: "cleanup_complete",
      recorded_at_utc: dependencies.now().toISOString(),
      config_sha256: sha256(canonicalJsonCandidate19Execution(context.config) + "\n"),
      plan_sha256: sha256(canonicalJsonCandidate19Execution(plan) + "\n"),
      confirmation_sha256: sha256(confirmation),
      context_fingerprint: authorizedContextFingerprint(context),
      execution_authorization_path: authorizationPath,
      execution_authorization_sha256: authorizationSha256,
      business_script_sha256: context.payload.business_script_sha256,
      outer_loader_sha256: context.payload.outer_loader_sha256,
      remote_command_sha256: context.payload.remote_command_sha256,
      candidate18_adjudication_record_sha256: C18_ADJUDICATION_SHA256,
      candidate18_adjudication_review_sha256: C18_ADJUDICATION_REVIEW_SHA256,
      attempt: 1,
      process,
      marker: marker.summary,
      cleanup_complete: true,
      retry_permitted: false,
    };
    writeEvidence(dependencies, evidenceDirectory, "execution-record.json",
      JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    const baseDetail = error instanceof Candidate19ExecutionFailure ? error.detail : {
      schema: "synthia-m4f-candidate19-execution-failure.v1",
      code: "M4F_CANDIDATE19_EXECUTION_UNEXPECTED",
      stage: remoteAttempted ? "network" : "local_preflight",
      retry_permitted: false,
      cleanup_complete: false,
    };
    const detail = {
      ...baseDetail,
      ...(marker === null ? {} : {
        effect_state: marker.parsed.effect_start_ordinals.length > 0
          ? "effects_may_have_occurred" : "no_effect_marker_observed",
      }),
      retry_permitted: false,
      cleanup_complete: false,
    };
    try {
      writeEvidence(dependencies, evidenceDirectory, "execution-failure.json", JSON.stringify({
        ...detail,
        execution_id: context.config.execution_id,
        attempt: remoteAttempted ? 1 : 0,
        remote_process: remote === null ? null : processEvidence(remote, Buffer.alloc(0)),
        marker: marker?.summary ?? null,
        retry_permitted: false,
        cleanup_complete: false,
      }, null, 2) + "\n");
    } catch { /* preserve primary failure */ }
    throw new Candidate19ExecutionFailure(detail);
  }
}

function fact(path: string, stat: Stats, bytes: Buffer): Candidate19ExecutionFileFact {
  return {
    schema: "synthia-m4f-candidate19-execution-local-file.v1",
    path,
    device: stat.dev,
    inode: stat.ino,
    owner_uid: stat.uid,
    mode: stat.mode & 0o777,
    link_count: stat.nlink,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    sha256: sha256(bytes),
  };
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink();
}

function captureLocalFile(path: string): Candidate19ExecutionCapturedFile {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not_regular");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleBefore = fstatSync(fd);
    const bytes = readFileSync(fd);
    const handleAfter = fstatSync(fd);
    const after = lstatSync(path);
    if (!sameStat(before, handleBefore) || !sameStat(handleBefore, handleAfter)
      || !sameStat(handleAfter, after)) throw new Error("file_drift");
    return { bytes, fact: fact(path, handleAfter, bytes) };
  } finally { closeSync(fd); }
}

function captureLocalDirectory(path: string): Candidate19ExecutionDirectoryFact {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("not_directory");
  const entries = readdirSync(path).sort();
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs) throw new Error("directory_drift");
  return {
    path, device: after.dev, inode: after.ino, owner_uid: after.uid, mode: after.mode & 0o777,
    link_count: after.nlink, mtime_ms: after.mtimeMs, ctime_ms: after.ctimeMs, entries,
  };
}

const systemDependencies: Candidate19ExecutionDependencies = {
  spawn(executable, args, stdin, timeoutMs) {
    const result = spawnSync(executable, args, {
      input: stdin,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_STREAM_BYTES,
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
  captureFile: captureLocalFile,
  captureDirectory: captureLocalDirectory,
  sourceFile: () => captureLocalFile(EXECUTION_SOURCE_PATH),
  testSourceFile: () => captureLocalFile(EXECUTION_TEST_PATH),
  candidate19SourceFile: () => captureLocalFile(C19_SOURCE_PATH),
  candidate19TestSourceFile: () => captureLocalFile(C19_TEST_PATH),
  candidate19DocFile: () => captureLocalFile(C19_DOC_PATH),
  candidate18SourceFile: () => captureLocalFile(C18_SOURCE_PATH),
  candidate18TestFile: () => captureLocalFile(C18_TEST_PATH),
  candidate18AdjudicatorSourceFile: () => captureLocalFile(C18_ADJUDICATOR_SOURCE_PATH),
  candidate18AdjudicatorTestFile: () => captureLocalFile(C18_ADJUDICATOR_TEST_PATH),
  transportSourceFile: () => captureLocalFile(TRANSPORT_SOURCE_PATH),
  transportInputs: (config, stage) => captureM4fDirectTransportInputs(config, stage),
  createEvidenceDirectory(path) { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); },
  writeEvidence(path, bytes) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    chmodSync(path, 0o600);
  },
  now: () => new Date(),
};

function main(): void {
  const args = process.argv.slice(2);
  try {
    if (args.length < 3 || args[1] !== "--config") throw new Error("usage");
    const raw = JSON.parse(readFileSync(args[2]!, "utf8"));
    if (args.length === 3 && args[0] === "--plan") {
      const plan = planCandidate19Execution(raw, systemDependencies);
      process.stdout.write(JSON.stringify({
        ...plan,
        config_sha256: sha256(canonicalJsonCandidate19Execution(raw) + "\n"),
        plan_sha256: sha256(canonicalJsonCandidate19Execution(plan) + "\n"),
        authorization_artifact_path: candidate19ExecutionAuthorizationPath(raw),
        final_confirmation_issued: false,
      }) + "\n");
      return;
    }
    if (args.length === 7 && args[0] === "--confirm"
      && args[3] === "--authorization" && args[5] === "--authorization-sha256") {
      process.stdout.write(JSON.stringify({
        authorization_path: args[4],
        authorization_sha256: args[6],
        confirmation: candidate19ExecutionConfirmation(
          raw, args[4]!, args[6]!, systemDependencies,
        ),
      }) + "\n");
      return;
    }
    if (args.length === 11 && args[0] === "--execute"
      && args[3] === "--authorization" && args[5] === "--authorization-sha256"
      && args[7] === "--confirmation" && args[9] === "--evidence") {
      process.stdout.write(JSON.stringify(executeCandidate19Execution(
        raw, args[4]!, args[6]!, args[8]!, args[10]!, systemDependencies,
      )) + "\n");
      return;
    }
    throw new Error("usage");
  } catch (error) {
    const detail = error instanceof Candidate19ExecutionFailure ? error.detail : {
      schema: "synthia-m4f-candidate19-execution-failure.v1",
      code: "M4F_CANDIDATE19_EXECUTION_UNEXPECTED",
      retry_permitted: false,
      cleanup_complete: false,
    };
    process.stderr.write(JSON.stringify(detail) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
