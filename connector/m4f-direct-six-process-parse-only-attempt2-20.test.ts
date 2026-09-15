import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  ATTEMPT2_ADJUDICATION_PATH,
  ATTEMPT2_EVIDENCE_DIRECTORY,
  ATTEMPT2_LINEAGE_ID,
  ATTEMPT2_PARSE_CONFIG_PATH,
  ATTEMPT2_REVIEW_PATH,
  Attempt2LineageFailure,
  attempt2LineageConfirmation,
  canonicalJsonAttempt2,
  executeAttempt2Lineage,
  planAttempt2Lineage,
  type Attempt2LineageConfig,
  type Attempt2LineageDependencies,
} from "./scripts/m4f-direct-six-process-parse-only-attempt2-20.ts";
import {
  canonicalJson19,
  type Candidate19ScriptConfig,
} from "./scripts/m4f-direct-six-process-cleanup-19.ts";
import type {
  Candidate18CapturedFile,
  Candidate18Config,
  Candidate18Dependencies,
  Candidate18FileFact,
} from "./scripts/m4f-direct-six-process-parse-only-18.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const SOURCE = new URL("./scripts/m4f-direct-six-process-parse-only-attempt2-20.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-six-process-parse-only-attempt2-20.test.ts", import.meta.url).pathname;
const C18_SOURCE = new URL("./scripts/m4f-direct-six-process-parse-only-18.ts", import.meta.url).pathname;
const C18_TEST = new URL("./m4f-direct-six-process-parse-only-18.test.ts", import.meta.url).pathname;
const C19_SOURCE = new URL("./scripts/m4f-direct-six-process-cleanup-19.ts", import.meta.url).pathname;
const C19_TEST = new URL("./m4f-direct-six-process-cleanup-19.test.ts", import.meta.url).pathname;
const C19_DOC = new URL("./M4F-DIRECT-SIX-PROCESS-CLEANUP-18-19.md", import.meta.url).pathname;
const TRANSPORT_SOURCE = new URL("./scripts/m4f-gate-admission-transport.ts", import.meta.url).pathname;
const OLD_SCRIPT_CONFIG = "/private/tmp/synthia-m4f-direct-six-process-cleanup-prod-20260829-19.json";
const NEW_SCRIPT_CONFIG = "/private/tmp/synthia-m4f-direct-six-process-cleanup-attempt2-prod-20260830-20.json";
const TRANSPORT_CONFIG = "/private/tmp/synthia-m4f-direct-admission-prod-20260828-09.json";
const PROBE_DIRECTORY = "/private/tmp/m4f-direct-six-process-runtime-probe-prod-20260830-20-evidence";
const PROBE_MANIFEST = "/private/tmp/m4f-direct-six-process-runtime-probe-prod-20260830-20-evidence-manifest.json";

interface Fixture {
  config: Attempt2LineageConfig;
  dependencies: Attempt2LineageDependencies;
  files: Map<string, Buffer>;
  innerRuns: Array<{ config: Candidate18Config; confirmation: string; evidence: string }>;
}

function fixture(): Fixture {
  const files = new Map<string, Buffer>();
  const addReal = (path: string): void => { files.set(path, readFileSync(path)); };
  for (const path of [SOURCE, TEST_SOURCE, C18_SOURCE, C18_TEST, C19_SOURCE, C19_TEST,
    C19_DOC, TRANSPORT_SOURCE, TRANSPORT_CONFIG, PROBE_MANIFEST]) addReal(path);
  for (const name of readdirSync(PROBE_DIRECTORY)) addReal(PROBE_DIRECTORY + "/" + name);
  const oldScript = JSON.parse(readFileSync(OLD_SCRIPT_CONFIG, "utf8")) as Candidate19ScriptConfig;
  const scriptConfig: Candidate19ScriptConfig = {
    ...oldScript,
    cleanup_id: "m4f-direct-six-process-cleanup-attempt2-prod-20260830-20",
    expected_source_sha256: sha256(files.get(C19_SOURCE)!),
    expected_test_source_sha256: sha256(files.get(C19_TEST)!),
  };
  const scriptBytes = Buffer.from(canonicalJson19(scriptConfig) + "\n");
  files.set(NEW_SCRIPT_CONFIG, scriptBytes);
  for (const path of [
    scriptConfig.adjudication_record_path,
    scriptConfig.adjudication_review_path,
    scriptConfig.admission_record_path,
    scriptConfig.admission_review_path,
  ]) addReal(path);
  const parseConfig: Candidate18Config = {
    schema: "synthia-m4f-candidate18-parse-only-config.v1",
    parse_id: ATTEMPT2_LINEAGE_ID,
    candidate19_script_config_path: NEW_SCRIPT_CONFIG,
    candidate19_script_config_sha256: sha256(scriptBytes),
    transport_config_path: TRANSPORT_CONFIG,
    transport_config_sha256: sha256(files.get(TRANSPORT_CONFIG)!),
    evidence_directory: ATTEMPT2_EVIDENCE_DIRECTORY,
    expected_source_sha256: sha256(files.get(C18_SOURCE)!),
    expected_test_source_sha256: sha256(files.get(C18_TEST)!),
    expected_candidate19_source_sha256: sha256(files.get(C19_SOURCE)!) as Candidate18Config["expected_candidate19_source_sha256"],
    expected_candidate19_test_source_sha256: sha256(files.get(C19_TEST)!) as Candidate18Config["expected_candidate19_test_source_sha256"],
    expected_candidate19_doc_sha256: sha256(files.get(C19_DOC)!) as Candidate18Config["expected_candidate19_doc_sha256"],
    expected_transport_source_sha256: sha256(files.get(TRANSPORT_SOURCE)!) as Candidate18Config["expected_transport_source_sha256"],
  };
  const parseBytes = Buffer.from(canonicalJsonAttempt2(parseConfig) + "\n");
  files.set(ATTEMPT2_PARSE_CONFIG_PATH, parseBytes);
  const config: Attempt2LineageConfig = {
    schema: "synthia-m4f-candidate18-attempt2-lineage-config.v1",
    lineage_id: ATTEMPT2_LINEAGE_ID,
    parse_config_path: ATTEMPT2_PARSE_CONFIG_PATH,
    parse_config_sha256: sha256(parseBytes),
    parse_config: structuredClone(parseConfig),
    runtime_probe_evidence_directory: PROBE_DIRECTORY,
    runtime_probe_manifest_path: PROBE_MANIFEST,
    runtime_probe_manifest_sha256: sha256(files.get(PROBE_MANIFEST)!) as Attempt2LineageConfig["runtime_probe_manifest_sha256"],
    runtime_probe_record_sha256: sha256(files.get(PROBE_DIRECTORY + "/probe-record.json")!) as Attempt2LineageConfig["runtime_probe_record_sha256"],
    expected_c18_source_sha256: sha256(files.get(C18_SOURCE)!) as Attempt2LineageConfig["expected_c18_source_sha256"],
    expected_c18_test_sha256: sha256(files.get(C18_TEST)!) as Attempt2LineageConfig["expected_c18_test_sha256"],
    expected_c19_source_sha256: sha256(files.get(C19_SOURCE)!) as Attempt2LineageConfig["expected_c19_source_sha256"],
    expected_c19_test_sha256: sha256(files.get(C19_TEST)!) as Attempt2LineageConfig["expected_c19_test_sha256"],
    expected_transport_source_sha256: sha256(files.get(TRANSPORT_SOURCE)!) as Attempt2LineageConfig["expected_transport_source_sha256"],
    expected_source_sha256: sha256(files.get(SOURCE)!),
    expected_test_source_sha256: sha256(files.get(TEST_SOURCE)!),
    adjudication_path: ATTEMPT2_ADJUDICATION_PATH,
    review_path: ATTEMPT2_REVIEW_PATH,
  };
  const capture = (path: string): Candidate18CapturedFile => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("missing:" + path);
    const fact: Candidate18FileFact = {
      schema: "synthia-m4f-candidate18-local-file.v1",
      path,
      device: 1,
      inode: path.length + 100,
      owner_uid: 501,
      mode: 0o600,
      link_count: 1,
      size: bytes.length,
      mtime_ms: 1,
      ctime_ms: 1,
      sha256: sha256(bytes),
    };
    return { bytes: Buffer.from(bytes), fact };
  };
  const inner: Candidate18Dependencies = {
    spawn() { throw new Error("unexpected spawn"); },
    captureFile: capture,
    sourceFile: () => capture(C18_SOURCE),
    testSourceFile: () => capture(C18_TEST),
    candidate19SourceFile: () => capture(C19_SOURCE),
    candidate19TestSourceFile: () => capture(C19_TEST),
    candidate19DocFile: () => capture(C19_DOC),
    transportSourceFile: () => capture(TRANSPORT_SOURCE),
    transportInputs: () => [],
    now: () => new Date("2026-08-30T15:00:00.000Z"),
  };
  const innerRuns: Fixture["innerRuns"] = [];
  const dependencies: Attempt2LineageDependencies = {
    inner,
    runInner(innerConfig, confirmation, evidence) {
      innerRuns.push({ config: structuredClone(innerConfig), confirmation, evidence });
      files.set(evidence + "/parse-record.json", Buffer.from("{}\n"));
      return {
        schema: "synthia-m4f-candidate18-parse-only-record.v1",
        status: "parsed_not_invoked",
        business_target_body_not_invoked: true,
        outer_loader_target_body_not_invoked: true,
        process_mutation_performed: false,
        file_mutation_performed: false,
        vivado_action_performed: false,
        hardware_action_performed: false,
        cleanup_performed: false,
        retry_permitted: false,
      };
    },
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing:" + path);
      return Buffer.from(bytes);
    },
    entries(path) {
      const prefix = path + "/";
      return [...files.keys()].filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)).filter((name) => !name.includes("/")).sort();
    },
    exists: (path) => files.has(path),
    writeExclusive(path, bytes) {
      if (files.has(path)) throw new Error("exists");
      files.set(path, Buffer.from(bytes));
    },
    now: () => new Date("2026-08-30T15:00:00.000Z"),
  };
  return { config, dependencies, files, innerRuns };
}

function failure(run: () => unknown): Attempt2LineageFailure {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(Attempt2LineageFailure);
    return error as Attempt2LineageFailure;
  }
  throw new Error("expected failure");
}

describe("M4-F Candidate 18 attempt2 parse-only lineage", () => {
  test("binds the successful runtime probe and exact C18/C19 sources without running", () => {
    const value = fixture();
    const plan = planAttempt2Lineage(value.config, value.dependencies);
    expect(plan).toMatchObject({
      lineage_id: ATTEMPT2_LINEAGE_ID,
      status: "planned_not_executed",
      runtime_probe_manifest_sha256: "29e9d293190f91285e4237a31d5e19ab705f3d1105f7c4aa8e0ffda57d4026da",
      runtime_probe_record_sha256: "82853ed927ee71661b359dcf397109ed209dca1e4a3d6ab2ee7f28f5251cb70f",
      attempt_count: 1,
      retry_permitted: false,
      target_body_invoked: false,
      cleanup_permitted: false,
      vivado_action_permitted: false,
      hardware_action_permitted: false,
    });
    expect(value.innerRuns).toHaveLength(0);
  });

  test("requires the exact outer confirmation before the inner ceremony", () => {
    const value = fixture();
    const exact = attempt2LineageConfirmation(value.config, value.dependencies);
    expect(exact.split(":")[0]).toBe("SYNTHIA_M4F_CANDIDATE18_ATTEMPT2_EXACT_PARSE_ONLY");
    const error = failure(() => executeAttempt2Lineage(
      value.config, exact + "x", value.dependencies,
    ));
    expect(error.detail.code).toBe("M4F_C18_ATTEMPT2_CONFIRMATION_REQUIRED");
    expect(value.innerRuns).toHaveLength(0);
  });

  test("runs one inner parse and creates fail-closed adjudication plus a non-independent draft", () => {
    const value = fixture();
    const exact = attempt2LineageConfirmation(value.config, value.dependencies);
    const result = executeAttempt2Lineage(value.config, exact, value.dependencies);
    expect(value.innerRuns).toHaveLength(1);
    expect(value.innerRuns[0]!.evidence).toBe(ATTEMPT2_EVIDENCE_DIRECTORY);
    expect(result).toMatchObject({
      decision: "LOCAL_ADJUDICATION_COMPLETE_INDEPENDENT_F0_REVIEW_REQUIRED",
      adjudication_status: "parsed_not_invoked",
      independent_review_completed: false,
      eligible_for_cleanup_freeze: false,
      cleanup_execution_authorized: false,
      network_authorized: false,
      ssh_authorized: false,
      remote_execution_authorized: false,
      retry_authorized: false,
      target_body_invoked: false,
      cleanup_performed: false,
    });
    expect(value.files.has(ATTEMPT2_ADJUDICATION_PATH)).toBe(true);
    expect(value.files.has(ATTEMPT2_REVIEW_PATH)).toBe(true);
  });

  test("runtime probe or parse config tamper blocks before the inner ceremony", () => {
    for (const path of [PROBE_MANIFEST, PROBE_DIRECTORY + "/probe-record.json", ATTEMPT2_PARSE_CONFIG_PATH]) {
      const value = fixture();
      value.files.set(path, Buffer.from("{}\n"));
      const error = failure(() => planAttempt2Lineage(value.config, value.dependencies));
      expect(String(error.detail.code)).toStartWith("M4F_C18_ATTEMPT2_");
      expect(value.innerRuns).toHaveLength(0);
    }
  });

  test("invalid inner result is isolated and never authorizes cleanup", () => {
    const value = fixture();
    value.dependencies.runInner = () => ({ status: "cleanup_complete" });
    const exact = attempt2LineageConfirmation(value.config, value.dependencies);
    const error = failure(() => executeAttempt2Lineage(value.config, exact, value.dependencies));
    expect(error.detail.code).toBe("M4F_C18_ATTEMPT2_PARSE_RESULT_INVALID");
    expect(value.files.has(ATTEMPT2_REVIEW_PATH)).toBe(false);
  });

  test("lineage source has no invocation, kill, Vivado, or hardware commands", () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).not.toMatch(/Invoke-Expression|\.Invoke\s*\(|Stop-Process|Get-CimInstance|\.Kill\s*\(/u);
    expect(source).not.toContain("vivado.bat");
    expect(source).not.toMatch(/program_hw_devices|open_hw_target|write_bitstream/iu);
  });
});
