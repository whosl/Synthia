import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  CANDIDATE31_TARGETS,
  CANDIDATE31_TARGET_SHA256,
  validateCandidate31Output,
} from "./m4f-direct-attempt2-residue-nine-pid-preflight-31.ts";

export const CANDIDATE34_ID = "m4f-direct-nine-pid-stale-parent-adjudicator-20260831-34";
export const CANDIDATE34_RECORD_PATH =
  "/private/tmp/m4f-direct-nine-pid-stale-parent-adjudication-prod-20260831-34.json";
export const CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-attempt2-residue-nine-pid-preflight-prod-20260830-31-evidence";
export const CANDIDATE31_PRODUCTION_RECORD_SHA256 =
  "4efad9fab8445eeee887e564fe6362f1341f96500f7926b8ddee690ee50fa8aa";
export const CANDIDATE31_PRODUCTION_MANIFEST_SHA256 =
  "f7508773bbd1250692b71ca25140619958aed784182f51ba3e3376b18f9252c3";
export const CANDIDATE31_PRODUCTION_MANIFEST = {
  "confirmation.sha256": "f69c5cce263c6fee3810f42530038c9f1f597d4a331d574aa4962ddda9270687",
  "plan.canonical.json": "62ea1f9aafffd5028ae99e779181c321c07174712dc90c1449957d37ad4da9a7",
  "preflight-config.canonical.json": "edc694e199ed2c370dbc4c5786e49e490317d6e294294e21047dd345c1f1d94c",
  "preflight-record.json": CANDIDATE31_PRODUCTION_RECORD_SHA256,
  "remote-process.json": "3ef72a5520e7b71915e12b48aed6cdd19b173a6d534b644e2eba6dcfd74a5565",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "ssh-effective-stdout.raw": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90",
  "stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "stdout.raw": "fab1b605b331570fed6a59dd91401d5776a031b35dcc8b02c66bb7d05c44b190",
  "target-preflight-script.ps1": CANDIDATE31_TARGET_SHA256,
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

export const CANDIDATE32_PRODUCTION_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-preflight-parse-only-prod-20260831-32-evidence";
export const CANDIDATE32_PRODUCTION_RECORD_SHA256 =
  "46760894e4caada5c5263b3049b39b0bab4a63082a41d8d2367128359cf537a1";
export const CANDIDATE32_PRODUCTION_MANIFEST_SHA256 =
  "2594fb34920c18ef3c69ce97255daf74ef57592f8d518ed2289c494ad77a6dd3";
export const CANDIDATE32_PRODUCTION_MANIFEST = {
  "confirmation.sha256": "019c5d70687f79df9ab3fe8d2d98b6b1773f5bf1ddfb43e993b6c321a32fa643",
  "parser-loader.ps1": "139372f1164b3fd339a5daa251c37ae6d522b431e798fcd6a8f629e7bc761994",
  "plan.canonical.json": "c75947c8557dbe7ecb9aa8308d92c00b23c9d8aa7c46f59ff52a6bb594c920ac",
  "probe-config.canonical.json": "dd30ebcec33f5103e6f2dee580aae540c8195e6b256782ad0272696f8634c3cc",
  "probe-record.json": CANDIDATE32_PRODUCTION_RECORD_SHA256,
  "remote-process.json": "25eb449844b5d2d8cf3aa07c024ef9a51b538a545cfa9d5aac1b9dc580a8e701",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "ssh-effective-stdout.raw": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90",
  "stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "stdout.raw": "d60b21849c6576f66d26b80c82014273c00059c24d42bfdd54ab00da8365e790",
  "target-preflight-script.ps1": CANDIDATE31_TARGET_SHA256,
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

export const CANDIDATE33_PRODUCTION_EVIDENCE_DIRECTORY =
  "/private/tmp/m4f-direct-nine-pid-preflight-helper-smoke-prod-20260831-33-evidence";
export const CANDIDATE33_PRODUCTION_RECORD_SHA256 =
  "f661ef6ec0781c0e92eece616a6df10892303e89a2b24e14dfc16e36dac4aae5";
export const CANDIDATE33_PRODUCTION_MANIFEST_SHA256 =
  "d9ea83acf376f6e8b240dff8705866a9113d78f30e7d16a154960c1353558f86";
export const CANDIDATE33_PRODUCTION_MANIFEST = {
  "confirmation.sha256": "93dec6417be405c44676ff914c61dbdc698123ce4c0d6864e57fdb89c0de5c1a",
  "helper-smoke.ps1": "12ac7b36c0aa8db1ace088b25be98d73788cd748c99ff16d677eab5d21c9960e",
  "plan.canonical.json": "e2f326689e496ddd35c2fd5cd5c420d597b971339d81d84c9ecc7c4cff716efb",
  "probe-config.canonical.json": "3beeb920aec6766707827b3ea227f481090d66e2408ebfc07e0cdb2bacab3f9e",
  "probe-record.json": CANDIDATE33_PRODUCTION_RECORD_SHA256,
  "remote-process.json": "4f1ec285923695bf03bd132f22b282caed8f5a69a44e4ad3973659ff9ef3f4c5",
  "ssh-effective-process.json": "3cfae3c12813a674c8ed76c47860cfd845071baae5b930bb39527a01937ce6ff",
  "ssh-effective-stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "ssh-effective-stdout.raw": "2ec7be3e56e6b6acb1b92651e95ec5ce82551b35fe7d8d5ef5988f6350640d90",
  "stderr.raw": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "stdout.raw": "64e7db211e00d5cc8b76078d3e83770328252e1f3750a7c02a55fc35ae8702c1",
  "transport-inputs-initial.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-post-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
  "transport-inputs-pre-remote.json": "09d8df58e4a63f9d7c60f275c279b887c224b2e9cf9840bc443664af9eecd2f5",
} as const;

type ProcessRow = [number, number, string, string, number, string | null, boolean, number | null, string | null];

export interface Candidate34Dependencies {
  read(path: string): Buffer;
  entries(path: string): string[];
  writeExclusive?(path: string, bytes: Buffer): void;
  now?(): Date;
}

export class Candidate34Failure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new Candidate34Failure(code);
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

function row(value: unknown): ProcessRow | null {
  if (!Array.isArray(value) || value.length !== 9 || !Number.isInteger(value[0])
    || !Number.isInteger(value[1]) || typeof value[2] !== "string" || typeof value[3] !== "string"
    || !Number.isInteger(value[4]) || !(value[5] === null || typeof value[5] === "string")
    || typeof value[6] !== "boolean"
    || !(value[7] === null || Number.isInteger(value[7]))
    || !(value[8] === null || typeof value[8] === "string")) return null;
  return value as ProcessRow;
}

function rows(value: unknown): ProcessRow[] | null {
  if (!Array.isArray(value)) return null;
  const result = value.map(row);
  return result.every((item) => item !== null) ? result as ProcessRow[] : null;
}

function exactRow(left: ProcessRow, right: ProcessRow): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const EXACT_STALE_PARENT: ProcessRow = [
  1204, 1448, "svchost.exe", "2026-08-12T22:31:30.7301590Z", 0,
  "C:\\WINDOWS\\System32\\svchost.exe", true, 80,
  "28badc7dddcdb48483f2880e3982160297bf49c3e21da9939589ebd0503bd8b8",
];
const EXACT_STALE_CHILD: ProcessRow = [
  1304, 1204, "wininit.exe", "2026-08-12T22:31:30.1596200Z", 0,
  null, false, null, null,
];
const EXACT_SHARED_PREFIX: ProcessRow = [
  1448, 1304, "services.exe", "2026-08-12T22:31:30.2114380Z", 0,
  null, false, null, null,
];

function validateEvidenceSet(
  dependencies: Candidate34Dependencies,
  directory: string,
  manifest: Record<string, string>,
  expectedManifestSha256: string,
): void {
  const names = Object.keys(manifest).sort();
  if (sha256(canonicalJson(manifest) + "\n") !== expectedManifestSha256
    || canonicalJson(dependencies.entries(directory)) !== canonicalJson(names)) {
    fail("M4F_C34_EVIDENCE_ENTRY_SET_INVALID");
  }
  for (const name of names) {
    let bytes: Buffer;
    try { bytes = dependencies.read(directory + "/" + name); } catch {
      fail("M4F_C34_EVIDENCE_MISSING");
    }
    if (sha256(bytes) !== manifest[name]) fail("M4F_C34_EVIDENCE_HASH_INVALID");
  }
}

function validateValidPrefix(start: ProcessRow, chain: ProcessRow[], excludedLast: ProcessRow): ProcessRow[] {
  if (chain.length < 2 || !exactRow(chain.at(-1)!, excludedLast)) fail("M4F_C34_STALE_EDGE_SHAPE_INVALID");
  const prefix = chain.slice(0, -1);
  let child = start;
  const seen = new Set<number>([start[0]]);
  for (const parent of prefix) {
    if (child[1] !== parent[0] || seen.has(parent[0]) || parent[3] > child[3]) {
      fail("M4F_C34_VALID_PREFIX_INVALID");
    }
    seen.add(parent[0]);
    child = parent;
  }
  if (child[1] !== excludedLast[0] || excludedLast[3] <= child[3]) {
    fail("M4F_C34_NOT_EXACT_STALE_PARENT_EDGE");
  }
  return prefix;
}

export function adjudicateCandidate31Record(rawRecord: unknown) {
  const record = object(rawRecord);
  const result = object(record?.preflight_result);
  const snapshot = object(result?.snapshot);
  const current = row(snapshot?.current_process);
  const currentChain = rows(snapshot?.current_chain);
  const worker = row(snapshot?.protected_worker);
  const workerAncestors = rows(snapshot?.worker_ancestors);
  const workerDescendants = rows(snapshot?.worker_descendants);
  const diagnosticTree = rows(snapshot?.diagnostic_tree);
  if (!record || !result || !snapshot || !current || !currentChain || !worker
    || !workerAncestors || !workerDescendants || !diagnosticTree) fail("M4F_C34_RECORD_SHAPE_INVALID");
  if (record.schema !== "synthia-m4f-direct-attempt2-residue-nine-pid-preflight-31-record.v1"
    || record.status !== "observed_blocked" || result.status !== "observed_blocked"
    || snapshot.decision !== "observed_blocked" || record.target_script_sha256 !== CANDIDATE31_TARGET_SHA256
    || record.target_script_length !== 10_522 || snapshot.cim_snapshot_count !== 1
    || snapshot.target_count !== 9 || snapshot.stdin_length !== 0
    || result.exact_present_count !== 9 || result.absent_count !== 0
    || result.executable_path_authority !== "captured_this_observation_not_historically_bound"
    || record.target_body_invoked !== true || record.cim_executed !== true
    || record.cleanup_performed !== false || record.process_mutation_performed !== false
    || record.remote_file_write_performed !== false || record.vivado_action_performed !== false
    || record.hardware_action_performed !== false || record.retry_permitted !== false) {
    fail("M4F_C34_BASE_GATES_INVALID");
  }
  if (snapshot.current_chain_terminal !== "invalid_edge" || snapshot.current_chain_terminal_pid !== 1204
    || snapshot.worker_ancestor_terminal !== "invalid_edge" || snapshot.worker_ancestor_terminal_pid !== 1204) {
    fail("M4F_C34_BLOCKER_NOT_EXACT");
  }
  const currentStaleParent = currentChain.at(-1)!;
  const workerStaleParent = workerAncestors.at(-1)!;
  if (!exactRow(currentStaleParent, workerStaleParent)
    || !exactRow(currentStaleParent, EXACT_STALE_PARENT)) {
    fail("M4F_C34_STALE_PARENT_NOT_COMMON");
  }
  const currentPrefix = validateValidPrefix(current, currentChain, currentStaleParent);
  const workerPrefix = validateValidPrefix(worker, workerAncestors, workerStaleParent);
  const currentChild = currentPrefix.at(-1)!;
  const workerChild = workerPrefix.at(-1)!;
  if (!exactRow(currentChild, workerChild) || !exactRow(currentChild, EXACT_STALE_CHILD)
    || !currentPrefix.some((value) => exactRow(value, EXACT_SHARED_PREFIX))
    || !workerPrefix.some((value) => exactRow(value, EXACT_SHARED_PREFIX))) {
    fail("M4F_C34_STALE_CHILD_NOT_COMMON");
  }
  if (snapshot.diagnostic_tree_valid !== true || snapshot.protected_worker_exact !== true
    || snapshot.worker_descendants_valid !== true
    || canonicalJson(snapshot.listeners_8443) !== canonicalJson([["0.0.0.0", 8443, 13644]])
    || !Array.isArray(snapshot.listeners_18443) || snapshot.listeners_18443.length !== 0
    || worker[0] !== 13644 || workerDescendants.length !== 1 || !exactRow(worker, workerDescendants[0]!)) {
    fail("M4F_C34_PROTECTION_GATES_INVALID");
  }
  const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
  const expectedPids = CANDIDATE31_TARGETS.map((target) => target.pid);
  if (targets.length !== 9 || canonicalJson(snapshot.effective_present_set) !== canonicalJson(expectedPids)) {
    fail("M4F_C34_TARGET_SET_INVALID");
  }
  const targetPids = new Set<number>();
  const targetAncestorPids = new Set<number>();
  const exactTargetRows: ProcessRow[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const expected = CANDIDATE31_TARGETS[index]!;
    if (!Array.isArray(target) || target.length !== 8 || target[0] !== expected.ordinal
      || target[1] !== expected.pid || target[2] !== "exact" || target[7] !== "captured_this_observation"
      || !["zero", "missing_parent"].includes(String(target[5]))) fail("M4F_C34_TARGET_NOT_EXACT");
    const actual = row(target[3]);
    const ancestors = rows(target[4]);
    if (!actual || actual[0] !== expected.pid || !ancestors) fail("M4F_C34_TARGET_ROW_INVALID");
    exactTargetRows.push(actual);
    targetPids.add(actual[0]);
    for (const ancestor of ancestors) targetAncestorPids.add(ancestor[0]);
  }
  const diagnosticPids = new Set(diagnosticTree.map((value) => value[0]));
  const currentPrefixPids = new Set([current[0], ...currentPrefix.map((value) => value[0])]);
  const workerPrefixPids = new Set([worker[0], ...workerPrefix.map((value) => value[0])]);
  for (const pid of targetPids) {
    if (diagnosticPids.has(pid) || currentPrefixPids.has(pid) || workerPrefixPids.has(pid)) {
      fail("M4F_C34_TARGET_PREFIX_OVERLAP");
    }
  }
  for (const pid of targetAncestorPids) {
    if (diagnosticPids.has(pid) || pid === worker[0]) fail("M4F_C34_TARGET_ANCESTOR_OVERLAP");
  }
  if (diagnosticPids.has(worker[0]) || currentPrefixPids.has(worker[0])
    || diagnosticPids.has(currentStaleParent[0]) || targetPids.has(currentStaleParent[0])) {
    fail("M4F_C34_PROTECTED_PREFIX_OVERLAP");
  }
  return {
    schema: "synthia-m4f-direct-nine-pid-stale-parent-adjudication.v1",
    adjudication_id: CANDIDATE34_ID,
    source_decision: "observed_blocked",
    decision: "exact_stale_parent_boundary_adjudicated",
    scope: "existing_candidate31_evidence_only",
    exact_target_pids: expectedPids,
    exact_target_rows: exactTargetRows,
    blocker: {
      kind: "common_stale_parent_pid_reuse_invalid_edge",
      child_pid: 1304,
      parent_pid: 1204,
      parent_creation_after_child: true,
      current_terminal: "invalid_edge",
      worker_terminal: "invalid_edge",
    },
    diagnostic_tree_valid: true,
    protected_worker_exact: true,
    listener_8443_exact: true,
    listener_18443_absent: true,
    cleanup_derivation_permitted: true,
    cleanup_execution_permitted: false,
    cleanup_performed: false,
    remote_execution_performed: false,
  };
}

export function adjudicateCandidate31Evidence(dependencies: Candidate34Dependencies) {
  validateEvidenceSet(dependencies, CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY,
    CANDIDATE31_PRODUCTION_MANIFEST, CANDIDATE31_PRODUCTION_MANIFEST_SHA256);
  validateEvidenceSet(dependencies, CANDIDATE32_PRODUCTION_EVIDENCE_DIRECTORY,
    CANDIDATE32_PRODUCTION_MANIFEST, CANDIDATE32_PRODUCTION_MANIFEST_SHA256);
  validateEvidenceSet(dependencies, CANDIDATE33_PRODUCTION_EVIDENCE_DIRECTORY,
    CANDIDATE33_PRODUCTION_MANIFEST, CANDIDATE33_PRODUCTION_MANIFEST_SHA256);
  const recordBytes = dependencies.read(CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY + "/preflight-record.json");
  const stdout = dependencies.read(CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY + "/stdout.raw");
  const validated = validateCandidate31Output(stdout);
  const record = JSON.parse(recordBytes.toString("utf8")) as Record<string, unknown>;
  if (canonicalJson(record.preflight_result) !== canonicalJson(validated)) {
    fail("M4F_C34_RECORD_STDOUT_MISMATCH");
  }
  const candidate32 = object(JSON.parse(dependencies.read(
    CANDIDATE32_PRODUCTION_EVIDENCE_DIRECTORY + "/probe-record.json",
  ).toString("utf8")));
  const candidate32Parse = object(candidate32?.parse_result);
  if (!candidate32 || candidate32.status !== "exact_target_parse_zero"
    || candidate32.target_script_sha256 !== CANDIDATE31_TARGET_SHA256
    || candidate32Parse?.parse_error_count !== 0 || candidate32Parse.ast_type !== "ScriptBlockAst"
    || candidate32Parse.end_block_present !== true || candidate32Parse.target_body_invoked !== false
    || candidate32Parse.cim_executed !== false || candidate32.cleanup_performed !== false
    || candidate32.process_mutation_performed !== false || candidate32.retry_permitted !== false) {
    fail("M4F_C34_CANDIDATE32_RECORD_INVALID");
  }
  const candidate33 = object(JSON.parse(dependencies.read(
    CANDIDATE33_PRODUCTION_EVIDENCE_DIRECTORY + "/probe-record.json",
  ).toString("utf8")));
  const candidate33Result = object(candidate33?.helper_result);
  if (!candidate33 || candidate33.status !== "exact_helpers_runtime_smoked"
    || candidate33Result?.status !== "exact_helpers_runtime_smoked"
    || candidate33Result.alias_count !== 0 || candidate33Result.function_count !== 3
    || candidate33Result.target_body_invoked !== false || candidate33Result.cim_executed !== false
    || candidate33.cleanup_performed !== false || candidate33.process_mutation_performed !== false
    || candidate33.retry_permitted !== false) {
    fail("M4F_C34_CANDIDATE33_RECORD_INVALID");
  }
  return {
    ...adjudicateCandidate31Record(record),
    candidate31_record_sha256: CANDIDATE31_PRODUCTION_RECORD_SHA256,
    candidate31_stdout_sha256: CANDIDATE31_PRODUCTION_MANIFEST["stdout.raw"],
    candidate31_manifest_sha256: CANDIDATE31_PRODUCTION_MANIFEST_SHA256,
    candidate32_record_sha256: CANDIDATE32_PRODUCTION_RECORD_SHA256,
    candidate32_manifest_sha256: CANDIDATE32_PRODUCTION_MANIFEST_SHA256,
    candidate33_record_sha256: CANDIDATE33_PRODUCTION_RECORD_SHA256,
    candidate33_manifest_sha256: CANDIDATE33_PRODUCTION_MANIFEST_SHA256,
  };
}

export function executeCandidate34(dependencies: Candidate34Dependencies) {
  if (!dependencies.writeExclusive || !dependencies.now) fail("M4F_C34_WRITE_DEPENDENCIES_MISSING");
  const adjudication = adjudicateCandidate31Evidence(dependencies);
  const record = {
    ...adjudication,
    recorded_at_utc: dependencies.now().toISOString(),
    record_path: CANDIDATE34_RECORD_PATH,
  };
  try {
    dependencies.writeExclusive(CANDIDATE34_RECORD_PATH, Buffer.from(JSON.stringify(record, null, 2) + "\n"));
  } catch {
    fail("M4F_C34_RECORD_WRITE_FAILED");
  }
  return record;
}

const systemDependencies: Candidate34Dependencies = {
  read: (path) => readFileSync(path),
  entries: (path) => readdirSync(path).sort(),
  writeExclusive(path, bytes) {
    const descriptor = openSync(path, "wx", 0o600);
    try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); }
    chmodSync(path, 0o600);
  },
  now: () => new Date(),
};

if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(executeCandidate34(systemDependencies), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      decision: "blocked",
      code: error instanceof Error ? error.message : "M4F_C34_UNEXPECTED",
      cleanup_performed: false,
      remote_execution_performed: false,
    }) + "\n");
    process.exitCode = 1;
  }
}
