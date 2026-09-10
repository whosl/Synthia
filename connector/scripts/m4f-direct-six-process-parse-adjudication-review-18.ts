import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  C18_ADJUDICATION_RECORD_PATH,
  C18_PARSE_EVIDENCE_HASHES,
  canonicalJsonC18Adjudicator,
  planC18LocalAdjudication,
  validateC18AdjudicatorConfig,
  type C18AdjudicatorConfig,
  type C18AdjudicatorDirectoryCapture,
  type C18AdjudicatorFileCapture,
  type C18AdjudicatorStatFact,
} from "./m4f-direct-six-process-parse-adjudicator-18.ts";

const EVIDENCE_DIRECTORY = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
const ADJUDICATOR_CONFIG_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-progress-adjudicator-prod-20260829-18.json";
const ADJUDICATOR_CONFIG_SHA256 = "b88001cb671d6e151cf9d627d844cb983d3e405e63a0f206bde958ed0688e436";
const ADJUDICATOR_SOURCE_PATH = fileURLToPath(new URL("./m4f-direct-six-process-parse-adjudicator-18.ts", import.meta.url));
const ADJUDICATOR_SOURCE_SHA256 = "ac82750d595be8c9b38dc2d1dcd89e56eb761cab14a900b50fb3f3c2b10112f2";
const ADJUDICATOR_TEST_PATH = fileURLToPath(new URL("../m4f-direct-six-process-parse-adjudicator-18.test.ts", import.meta.url));
const ADJUDICATOR_TEST_SHA256 = "9b91d78065cdee7e1ae6337e1fb4c0c8ac4561ba36e36f49757456aed26c38dc";
const ADJUDICATION_RECORD_SHA256 = "1c5ececedf02af5e335273d2bbe97c8eec08db6362b5215d64c1df28d4eb1d25";
const C18_CONFIG_SHA256 = "051077fae982440fecdddc29014f8119da1aa9469cb0cd1836b2cc1e9c2d12ce";
const C18_PLAN_SHA256 = "17285cfc64496a789ef71ae8f618316484136fb8d255e6c21b06d152fd20b9ae";
const C18_SOURCE_SHA256 = "c48fb7edd8e0915786d65d0858fec7032734d6cd12a1db58ec7cb0fb3cd5734d";
const C18_TEST_SHA256 = "b23c108fcb537b862ed7e64b9c010712726331816dab0a18a8b8f5f8d70e739c";
const C19_CONFIG_SHA256 = "be33526bfd69ed606a117af32538f2f18c6fe146f9551588d22e6b3191685b76";
const C19_SOURCE_SHA256 = "a293e4e9af638fdcc5ccf932524105dce9f3fda6651603dd754d30ee478deffd";
const C19_TEST_SHA256 = "86a1449ae3f32ccb6f486c23d7efac5629ceffd9f7b2df714e647d1eb9d0df61";
const C19_DOC_SHA256 = "27eeaafc8d9e099fb766b40c89d7785750231bc0d793d935c314bddd9b5417e8";
const TRANSPORT_SOURCE_SHA256 = "7d85d67480bb58532c8b1c30b80697305a5b470115cbae944c2cf762384ff5df";
const TRANSPORT_CONFIG_SHA256 = "a9836a641902774cd0b57fcde56dd673e7e49703d27a225afb4211da65089ff5";
const BUSINESS_SCRIPT_SHA256 = "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c";
const OUTER_LOADER_SHA256 = "9d6d908becc22a50148db392f2d3245927e4051e4a11f1b3db7591a8dc4ff216";
const COMMAND_SHA256 = "b7b79a43006a4669b1a575d996079885f0dd2a3a9380ef23f6a37f7f0cbc8de7";

export const C18_ADJUDICATION_REVIEW_RECORD_PATH = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-review-record.json";

const EXPECTED_ADJUDICATION_RECORD_STAT: C18AdjudicatorStatFact = {
  device: 16777231,
  inode: 92840741,
  owner_uid: 501,
  mode: 0o600,
  link_count: 1,
  size: 6598,
  mtime_ms: 1788009052972.8196,
  ctime_ms: 1788009052972.8196,
  kind: "file",
  symbolic_link: false,
};

export interface C18AdjudicationReviewDependencies {
  captureFile(path: string): C18AdjudicatorFileCapture;
  captureDirectory(path: string): C18AdjudicatorDirectoryCapture;
  realpath(path: string): string;
  pathExists(path: string): boolean;
  writeExclusive(path: string, bytes: Buffer): void;
  now(): Date;
}

interface CapturedBoundFile {
  bytes: Buffer;
  fact: Record<string, unknown>;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
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

function publicFileFact(path: string, stat: C18AdjudicatorStatFact, hash: string): Record<string, unknown> {
  return {
    schema: "synthia-m4f-c18-adjudication-review-bound-file.v1",
    path,
    device: stat.device,
    inode: stat.inode,
    owner_uid: stat.owner_uid,
    mode: stat.mode,
    link_count: stat.link_count,
    size: stat.size,
    mtime_ms: stat.mtime_ms,
    ctime_ms: stat.ctime_ms,
    sha256: hash,
  };
}

function captureStableFile(
  dependencies: C18AdjudicationReviewDependencies,
  path: string,
  expectedHash: string,
  expectedStat: C18AdjudicatorStatFact | null,
  code: string,
): CapturedBoundFile {
  let capture: C18AdjudicatorFileCapture;
  try { capture = dependencies.captureFile(path); } catch { fail(code); }
  const facts = [capture.path_before, capture.handle_before, capture.handle_after, capture.path_after];
  if (facts.some((fact) => fact.kind !== "file" || fact.symbolic_link || fact.link_count !== 1)
    || facts.some((fact) => !sameStat(fact, facts[0]!))
    || (expectedStat !== null && !facts.every((fact) => sameStat(fact, expectedStat)))
    || sha256(capture.bytes) !== expectedHash || capture.bytes.length !== capture.path_before.size) {
    fail(code);
  }
  return {
    bytes: Buffer.from(capture.bytes),
    fact: publicFileFact(path, capture.path_before, expectedHash),
  };
}

function parseJson(bytes: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(code); }
}

function assertReviewTarget(dependencies: C18AdjudicationReviewDependencies): void {
  let parent: string;
  let evidence: string;
  try {
    parent = dependencies.realpath(dirname(C18_ADJUDICATION_REVIEW_RECORD_PATH));
    evidence = dependencies.realpath(EVIDENCE_DIRECTORY);
  } catch { fail("M4F_C18_ADJUDICATION_REVIEW_RECORD_PATH_INVALID"); }
  if (parent !== "/private/tmp" || evidence !== EVIDENCE_DIRECTORY
    || C18_ADJUDICATION_REVIEW_RECORD_PATH.startsWith(evidence + "/")
    || dependencies.pathExists(C18_ADJUDICATION_REVIEW_RECORD_PATH)) {
    fail("M4F_C18_ADJUDICATION_REVIEW_RECORD_PATH_INVALID");
  }
}

function validateRecordShape(record: Record<string, unknown>): void {
  const keys = [
    "adjudication_id", "candidate19_script_config_sha256", "c19_execution_authorized",
    "cleanup_execution_authorized", "cleanup_performed", "cli_xml_adjudication",
    "config_sha256", "confirmation_sha256", "eligible_for_c19_execution_freeze",
    "evidence_directory", "evidence_exact_file_set", "evidence_file_count", "evidence_hashes",
    "frozen_file_fact_count", "frozen_file_facts_sha256", "network_attempted_by_adjudicator",
    "network_authorized", "original_failure_code", "original_failure_preserved",
    "original_failure_sha256", "parse_id", "parse_result", "payload", "plan_sha256",
    "process", "record_created", "recorded_at_utc", "remote_execution_attempted_by_adjudicator",
    "remote_execution_authorized", "retry_attempted_by_adjudicator", "retry_authorized",
    "schema", "source_evidence_mutated", "ssh_attempted_by_adjudicator", "ssh_authorized",
    "status", "transport_fact_count", "transport_facts_sha256",
  ];
  if (!exactKeys(record, keys)
    || record.schema !== "synthia-m4f-c18-local-adjudication-record.v1"
    || record.adjudication_id !== "m4f-direct-six-process-parse-progress-prod-20260829-18"
    || record.parse_id !== "m4f-direct-six-process-parse-only-prod-20260829-18"
    || record.status !== "parse_success_locally_adjudicated"
    || record.recorded_at_utc !== "2026-08-29T13:10:52.972Z"
    || record.original_failure_code !== "M4F_CANDIDATE18_REMOTE_PARSE_FAILED"
    || record.original_failure_preserved !== true || record.record_created !== true
    || record.eligible_for_c19_execution_freeze !== true
    || record.c19_execution_authorized !== false || record.cleanup_execution_authorized !== false
    || record.network_authorized !== false || record.ssh_authorized !== false
    || record.remote_execution_authorized !== false || record.retry_authorized !== false
    || record.cleanup_performed !== false || record.source_evidence_mutated !== false
    || record.network_attempted_by_adjudicator !== false || record.ssh_attempted_by_adjudicator !== false
    || record.remote_execution_attempted_by_adjudicator !== false
    || record.retry_attempted_by_adjudicator !== false) {
    fail("M4F_C18_ADJUDICATION_REVIEW_RECORD_INVALID");
  }
}

function captureAndReconstruct(
  dependencies: C18AdjudicationReviewDependencies,
): { record: Record<string, unknown>; sourceSnapshot: Record<string, unknown> } {
  const source = captureStableFile(dependencies, ADJUDICATOR_SOURCE_PATH,
    ADJUDICATOR_SOURCE_SHA256, null, "M4F_C18_ADJUDICATION_REVIEW_SOURCE_INVALID");
  const test = captureStableFile(dependencies, ADJUDICATOR_TEST_PATH,
    ADJUDICATOR_TEST_SHA256, null, "M4F_C18_ADJUDICATION_REVIEW_TEST_INVALID");
  const configCapture = captureStableFile(dependencies, ADJUDICATOR_CONFIG_PATH,
    ADJUDICATOR_CONFIG_SHA256, null, "M4F_C18_ADJUDICATION_REVIEW_CONFIG_INVALID");
  const configValue = parseJson(configCapture.bytes, "M4F_C18_ADJUDICATION_REVIEW_CONFIG_INVALID");
  if (!configCapture.bytes.equals(Buffer.from(canonicalJsonC18Adjudicator(configValue) + "\n"))) {
    fail("M4F_C18_ADJUDICATION_REVIEW_CONFIG_INVALID");
  }
  const config = validateC18AdjudicatorConfig(configValue);
  if (config.expected_source_sha256 !== ADJUDICATOR_SOURCE_SHA256
    || config.expected_test_source_sha256 !== ADJUDICATOR_TEST_SHA256
    || config.record_path !== C18_ADJUDICATION_RECORD_PATH) {
    fail("M4F_C18_ADJUDICATION_REVIEW_CONFIG_INVALID");
  }
  const adjudicationCapture = captureStableFile(dependencies, C18_ADJUDICATION_RECORD_PATH,
    ADJUDICATION_RECORD_SHA256, EXPECTED_ADJUDICATION_RECORD_STAT,
    "M4F_C18_ADJUDICATION_REVIEW_RECORD_INVALID");
  const recordValue = parseJson(adjudicationCapture.bytes, "M4F_C18_ADJUDICATION_REVIEW_RECORD_INVALID");
  const record = object(recordValue);
  if (!record || !adjudicationCapture.bytes.equals(Buffer.from(JSON.stringify(record, null, 2) + "\n"))) {
    fail("M4F_C18_ADJUDICATION_REVIEW_RECORD_INVALID");
  }
  validateRecordShape(record);
  const reconstructed = planC18LocalAdjudication(config, {
    captureFile: dependencies.captureFile,
    captureDirectory: dependencies.captureDirectory,
    sourceBytes: () => Buffer.from(source.bytes),
    testSourceBytes: () => Buffer.from(test.bytes),
    realpath: dependencies.realpath,
    pathExists: () => false,
    writeExclusive: () => fail("M4F_C18_ADJUDICATION_REVIEW_UNEXPECTED_WRITE"),
    now: () => new Date(String(record.recorded_at_utc)),
  });
  reconstructed.record_created = true;
  if (canonicalJsonC18Adjudicator(reconstructed) !== canonicalJsonC18Adjudicator(record)) {
    fail("M4F_C18_ADJUDICATION_REVIEW_RECONSTRUCTION_MISMATCH");
  }
  const payload = object(record.payload);
  if (!payload || record.config_sha256 !== C18_CONFIG_SHA256 || record.plan_sha256 !== C18_PLAN_SHA256
    || record.candidate19_script_config_sha256 !== C19_CONFIG_SHA256
    || payload.business_script_sha256 !== BUSINESS_SCRIPT_SHA256
    || payload.outer_loader_sha256 !== OUTER_LOADER_SHA256 || payload.command_sha256 !== COMMAND_SHA256
    || config.evidence_files["parse-config.canonical.json"]?.sha256 !== C18_CONFIG_SHA256
    || config.evidence_files["plan.canonical.json"]?.sha256 !== C18_PLAN_SHA256
    || config.evidence_files["candidate19-script-config.raw.json"]?.sha256 !== C19_CONFIG_SHA256
    || config.evidence_files["transport-config.raw.json"]?.sha256 !== TRANSPORT_CONFIG_SHA256
    || config.evidence_files["target-business-script.ps1"]?.sha256 !== BUSINESS_SCRIPT_SHA256
    || config.evidence_files["target-outer-loader.ps1"]?.sha256 !== OUTER_LOADER_SHA256
    || config.evidence_files["parse-loader.ps1"]?.sha256 !== payload.loader_sha256) {
    fail("M4F_C18_ADJUDICATION_REVIEW_LINEAGE_INVALID");
  }
  const evidenceHashes = object(record.evidence_hashes);
  if (!evidenceHashes || canonicalJsonC18Adjudicator(evidenceHashes)
    !== canonicalJsonC18Adjudicator(C18_PARSE_EVIDENCE_HASHES)
    || record.evidence_file_count !== 21 || record.evidence_exact_file_set !== true) {
    fail("M4F_C18_ADJUDICATION_REVIEW_LINEAGE_INVALID");
  }
  return {
    record,
    sourceSnapshot: {
      adjudication_record: adjudicationCapture.fact,
      adjudicator_config: configCapture.fact,
      adjudicator_source: source.fact,
      adjudicator_test: test.fact,
      evidence_directory: config.evidence_directory,
      evidence_files: config.evidence_files,
    },
  };
}

function buildReviewRecord(
  dependencies: C18AdjudicationReviewDependencies,
  recordCreated: boolean,
): Record<string, unknown> {
  const reviewed = captureAndReconstruct(dependencies);
  return {
    schema: "synthia-m4f-c18-local-adjudication-review-record.v1",
    review_id: "m4f-direct-six-process-parse-progress-review-prod-20260829-18",
    decision: "GO_FOR_C19_EXECUTION_FREEZE_ONLY",
    reviewed_at_utc: dependencies.now().toISOString(),
    review_record_created: recordCreated,
    adjudication: {
      path: C18_ADJUDICATION_RECORD_PATH,
      sha256: ADJUDICATION_RECORD_SHA256,
      status: reviewed.record.status,
      original_failure_preserved: reviewed.record.original_failure_preserved,
    },
    adjudicator_lineage: {
      config_path: ADJUDICATOR_CONFIG_PATH,
      config_sha256: ADJUDICATOR_CONFIG_SHA256,
      source_path: ADJUDICATOR_SOURCE_PATH,
      source_sha256: ADJUDICATOR_SOURCE_SHA256,
      test_path: ADJUDICATOR_TEST_PATH,
      test_sha256: ADJUDICATOR_TEST_SHA256,
    },
    evidence_lineage: {
      directory: EVIDENCE_DIRECTORY,
      exact_file_count: 21,
      exact_file_set: true,
      hashes: C18_PARSE_EVIDENCE_HASHES,
      source_snapshot: reviewed.sourceSnapshot,
      source_snapshot_sha256: sha256(canonicalJsonC18Adjudicator(reviewed.sourceSnapshot) + "\n"),
    },
    c18_lineage: {
      config_sha256: C18_CONFIG_SHA256,
      plan_sha256: C18_PLAN_SHA256,
      source_sha256: C18_SOURCE_SHA256,
      test_sha256: C18_TEST_SHA256,
      parse_status: "parsed_not_invoked",
    },
    c19_lineage: {
      script_config_sha256: C19_CONFIG_SHA256,
      source_sha256: C19_SOURCE_SHA256,
      test_sha256: C19_TEST_SHA256,
      doc_sha256: C19_DOC_SHA256,
      transport_source_sha256: TRANSPORT_SOURCE_SHA256,
      transport_config_sha256: TRANSPORT_CONFIG_SHA256,
      business_script_sha256: BUSINESS_SCRIPT_SHA256,
      outer_loader_sha256: OUTER_LOADER_SHA256,
      command_sha256: COMMAND_SHA256,
    },
    authorization_boundary: {
      c19_execution_config_local_implementation_permitted: true,
      c19_execution_freeze_design_permitted: true,
      c19_execution_authorized: false,
      cleanup_execution_authorized: false,
      network_authorized: false,
      ssh_authorized: false,
      remote_execution_authorized: false,
      retry_authorized: false,
      new_execution_config_required: true,
      new_execution_plan_required: true,
      new_exact_confirmation_required: true,
      old_confirmation_reuse_permitted: false,
      source_evidence_mutated: false,
    },
    review_actions: {
      network_attempted: false,
      ssh_attempted: false,
      remote_execution_attempted: false,
      retry_attempted: false,
      cleanup_performed: false,
    },
  };
}

function validateWrittenReviewRecord(
  dependencies: C18AdjudicationReviewDependencies,
  expectedBytes: Buffer,
): void {
  let capture: C18AdjudicatorFileCapture;
  try { capture = dependencies.captureFile(C18_ADJUDICATION_REVIEW_RECORD_PATH); } catch {
    fail("M4F_C18_ADJUDICATION_REVIEW_WRITE_INVALID");
  }
  const facts = [capture.path_before, capture.handle_before, capture.handle_after, capture.path_after];
  if (!capture.bytes.equals(expectedBytes) || sha256(capture.bytes) !== sha256(expectedBytes)
    || facts.some((fact) => fact.kind !== "file" || fact.symbolic_link || fact.owner_uid !== 501
      || fact.mode !== 0o600 || fact.link_count !== 1 || fact.size !== expectedBytes.length)
    || facts.some((fact) => !sameStat(fact, facts[0]!))) {
    fail("M4F_C18_ADJUDICATION_REVIEW_WRITE_INVALID");
  }
}

export function planC18AdjudicationReview(
  dependencies: C18AdjudicationReviewDependencies,
): Record<string, unknown> {
  assertReviewTarget(dependencies);
  return buildReviewRecord(dependencies, false);
}

export function executeC18AdjudicationReview(
  dependencies: C18AdjudicationReviewDependencies,
): Record<string, unknown> {
  assertReviewTarget(dependencies);
  const initial = buildReviewRecord(dependencies, true);
  const bytes = Buffer.from(JSON.stringify(initial, null, 2) + "\n");
  try { dependencies.writeExclusive(C18_ADJUDICATION_REVIEW_RECORD_PATH, bytes); } catch {
    fail("M4F_C18_ADJUDICATION_REVIEW_WRITE_FAILED");
  }
  validateWrittenReviewRecord(dependencies, bytes);
  const post = captureAndReconstruct(dependencies);
  const initialSnapshot = object(object(initial.evidence_lineage)?.source_snapshot);
  if (!initialSnapshot || sha256(canonicalJsonC18Adjudicator(initialSnapshot) + "\n")
    !== sha256(canonicalJsonC18Adjudicator(post.sourceSnapshot) + "\n")) {
    fail("M4F_C18_ADJUDICATION_REVIEW_SOURCE_DRIFT");
  }
  return initial;
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

const systemDependencies: C18AdjudicationReviewDependencies = {
  captureFile,
  captureDirectory,
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
    if (args.length !== 1 || !["--plan", "--review"].includes(args[0]!)) throw new Error("usage");
    const result = args[0] === "--plan"
      ? planC18AdjudicationReview(systemDependencies)
      : executeC18AdjudicationReview(systemDependencies);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      schema: "synthia-m4f-c18-local-adjudication-review-failure.v1",
      code: error instanceof Error ? error.message : "M4F_C18_ADJUDICATION_REVIEW_UNEXPECTED",
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
