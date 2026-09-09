import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  C18_PARSE_EVIDENCE_HASHES,
  C18_ADJUDICATION_RECORD_PATH,
  executeC18LocalAdjudication,
  parseCandidate18BenignCliXml,
  planC18LocalAdjudication,
  validateC18AdjudicatorConfig,
  type C18AdjudicatorBoundDirectory,
  type C18AdjudicatorBoundFile,
  type C18AdjudicatorConfig,
  type C18AdjudicatorDependencies,
  type C18AdjudicatorStatFact,
} from "./scripts/m4f-direct-six-process-parse-adjudicator-18.ts";

const EVIDENCE = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
const SOURCE = Buffer.from("c18-adjudicator-source");
const TEST_SOURCE = Buffer.from("c18-adjudicator-test");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function statFact(path: string): C18AdjudicatorStatFact {
  const stat = lstatSync(path);
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

interface Setup {
  config: C18AdjudicatorConfig;
  dependencies: C18AdjudicatorDependencies;
  bytes: Map<string, Buffer>;
  entries: string[];
  writes: Array<{ path: string; bytes: Buffer }>;
}

function setup(): Setup {
  const entries = Object.keys(C18_PARSE_EVIDENCE_HASHES).sort();
  const bytes = new Map<string, Buffer>();
  const evidenceFiles: Record<string, C18AdjudicatorBoundFile> = {};
  for (const name of entries) {
    const path = `${EVIDENCE}/${name}`;
    const content = readFileSync(path);
    expect(hash(content)).toBe(C18_PARSE_EVIDENCE_HASHES[name as keyof typeof C18_PARSE_EVIDENCE_HASHES]);
    bytes.set(path, content);
    const stat = statFact(path);
    evidenceFiles[name] = {
      schema: "synthia-m4f-c18-adjudicator-bound-file.v1",
      path,
      sha256: hash(content),
      device: stat.device,
      inode: stat.inode,
      owner_uid: stat.owner_uid,
      mode: stat.mode,
      link_count: stat.link_count,
      size: stat.size,
      mtime_ms: stat.mtime_ms,
      ctime_ms: stat.ctime_ms,
    };
  }
  const directoryStat = statFact(EVIDENCE);
  const evidenceDirectory: C18AdjudicatorBoundDirectory = {
    schema: "synthia-m4f-c18-adjudicator-bound-directory.v1",
    path: EVIDENCE,
    entries: [...entries],
    device: directoryStat.device,
    inode: directoryStat.inode,
    owner_uid: directoryStat.owner_uid,
    mode: directoryStat.mode,
    link_count: directoryStat.link_count,
    mtime_ms: directoryStat.mtime_ms,
    ctime_ms: directoryStat.ctime_ms,
  };
  const config: C18AdjudicatorConfig = {
    schema: "synthia-m4f-c18-local-adjudicator-config.v1",
    adjudication_id: "c18-local-adjudication-test",
    evidence_directory: evidenceDirectory,
    evidence_files: evidenceFiles,
    record_path: C18_ADJUDICATION_RECORD_PATH,
    expected_source_sha256: hash(SOURCE),
    expected_test_source_sha256: hash(TEST_SOURCE),
  };
  const writes: Setup["writes"] = [];
  let recordCapture: { bytes: Buffer; fact: C18AdjudicatorStatFact } | null = null;
  const dependencies: C18AdjudicatorDependencies = {
    captureFile(path) {
      if (path === config.record_path && recordCapture) {
        const fact = structuredClone(recordCapture.fact);
        return {
          path_before: structuredClone(fact),
          handle_before: structuredClone(fact),
          bytes: Buffer.from(recordCapture.bytes),
          handle_after: structuredClone(fact),
          path_after: structuredClone(fact),
        };
      }
      const content = bytes.get(path);
      const expected = Object.values(config.evidence_files).find((fact) => fact.path === path);
      if (!content || !expected) throw new Error("missing");
      const fact: C18AdjudicatorStatFact = {
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
      return {
        path_before: structuredClone(fact),
        handle_before: structuredClone(fact),
        bytes: Buffer.from(content),
        handle_after: structuredClone(fact),
        path_after: structuredClone(fact),
      };
    },
    captureDirectory() {
      const fact: C18AdjudicatorStatFact = {
        device: evidenceDirectory.device,
        inode: evidenceDirectory.inode,
        owner_uid: evidenceDirectory.owner_uid,
        mode: evidenceDirectory.mode,
        link_count: evidenceDirectory.link_count,
        size: directoryStat.size,
        mtime_ms: evidenceDirectory.mtime_ms,
        ctime_ms: evidenceDirectory.ctime_ms,
        kind: "directory",
        symbolic_link: false,
      };
      return { before: structuredClone(fact), entries: [...entries], after: structuredClone(fact) };
    },
    sourceBytes: () => Buffer.from(SOURCE),
    testSourceBytes: () => Buffer.from(TEST_SOURCE),
    realpath(path) {
      if (path === "/private/tmp") return "/private/tmp";
      if (path === EVIDENCE) return EVIDENCE;
      throw new Error("unexpected realpath");
    },
    pathExists: () => recordCapture !== null,
    writeExclusive(path, content) {
      writes.push({ path, bytes: Buffer.from(content) });
      recordCapture = {
        bytes: Buffer.from(content),
        fact: {
          device: 16777231,
          inode: 123456789,
          owner_uid: 501,
          mode: 0o600,
          link_count: 1,
          size: content.length,
          mtime_ms: 10,
          ctime_ms: 10,
          kind: "file",
          symbolic_link: false,
        },
      };
    },
    now: () => new Date("2026-08-29T13:00:00.000Z"),
  };
  return { config, dependencies, bytes, entries, writes };
}

describe("M4-F Candidate18 local parse evidence adjudicator", () => {
  test("locally adjudicates the preserved failure as a complete two-target parse success", () => {
    const value = setup();
    const record = planC18LocalAdjudication(value.config, value.dependencies);
    expect(record).toMatchObject({
      status: "parse_success_locally_adjudicated",
      original_failure_code: "M4F_CANDIDATE18_REMOTE_PARSE_FAILED",
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
      record_created: false,
      network_attempted_by_adjudicator: false,
      ssh_attempted_by_adjudicator: false,
      remote_execution_attempted_by_adjudicator: false,
      retry_attempted_by_adjudicator: false,
      evidence_file_count: 21,
      evidence_exact_file_set: true,
      transport_fact_count: 2,
      frozen_file_fact_count: 12,
      cli_xml_adjudication: {
        stream: "progress",
        status: "Completed",
        error_count: 0,
        warning_count: 0,
        verbose_count: 0,
        debug_count: 0,
        information_count: 0,
      },
      parse_result: {
        status: "parsed_not_invoked",
        powershell_edition: "Desktop",
        powershell_version: "5.1.26100.9168",
        business: { parse_error_count: 0, parser_end_block_present: true },
        outer_loader: { parse_error_count: 0, parser_end_block_present: true },
      },
    });
    expect(value.writes).toHaveLength(0);
    expect(hash(value.bytes.get(`${EVIDENCE}/parse-failure.json`)!))
      .toBe(C18_PARSE_EVIDENCE_HASHES["parse-failure.json"]);
  });

  test("writes only a new external record when explicitly adjudicating", () => {
    const value = setup();
    const before = new Map([...value.bytes].map(([path, bytes]) => [path, hash(bytes)]));
    const record = executeC18LocalAdjudication(value.config, value.dependencies);
    expect(record.record_created).toBe(true);
    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]!.path).toBe(value.config.record_path);
    expect(JSON.parse(value.writes[0]!.bytes.toString())).toMatchObject({
      eligible_for_c19_execution_freeze: true,
      c19_execution_authorized: false,
      retry_authorized: false,
    });
    for (const [path, bytes] of value.bytes) expect(hash(bytes)).toBe(before.get(path));
  });

  test("accepts only the exact benign Completed progress CLIXML", () => {
    const value = setup();
    const original = value.bytes.get(`${EVIDENCE}/stderr.raw`)!;
    expect(parseCandidate18BenignCliXml(original)).toMatchObject({
      stream: "progress",
      status: "Completed",
    });
    const text = original.toString("utf8");
    const mutations = [
      text.replace('S="progress"', 'S="error"'),
      text.replace("Completed", "Running"),
      text.replace("</Objs>", '<Obj S="warning"></Obj></Objs>'),
      text.replace("正在准备首次使用模块。", "unexpected"),
      text.replace("\r\n", "\n"),
      "\ufeff" + text,
      text + "\n",
      text.replace("<Objs ", "<!DOCTYPE x><Objs "),
    ];
    for (const mutation of mutations) {
      expect(() => parseCandidate18BenignCliXml(Buffer.from(mutation)))
        .toThrow("M4F_C18_ADJUDICATOR_CLIXML_INVALID");
    }
  });

  test("fails closed on every authoritative evidence class mutation", () => {
    for (const name of [
      "parse-config.canonical.json",
      "candidate19-script-config.raw.json",
      "plan.canonical.json",
      "confirmation.sha256",
      "parse-failure.json",
      "remote-process.json",
      "stdout.raw",
      "stderr.raw",
      "transport-inputs-pre-remote.json",
      "frozen-file-facts-post-remote.json",
    ]) {
      const value = setup();
      const path = `${EVIDENCE}/${name}`;
      value.bytes.set(path, Buffer.concat([value.bytes.get(path)!, Buffer.from("x")]));
      expect(() => planC18LocalAdjudication(value.config, value.dependencies))
        .toThrow("M4F_C18_ADJUDICATOR_EVIDENCE_FILE_DRIFT");
    }
  });

  test("rejects directory drift, source drift, config widening, and an in-evidence record path", () => {
    const directory = setup();
    directory.entries.push("unexpected");
    expect(() => planC18LocalAdjudication(directory.config, directory.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_EVIDENCE_DIRECTORY_DRIFT");
    const source = setup();
    source.dependencies.sourceBytes = () => Buffer.from("drift");
    expect(() => planC18LocalAdjudication(source.config, source.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_SOURCE_MISMATCH");
    const extra = setup();
    (extra.config as unknown as Record<string, unknown>).extra = true;
    expect(() => validateC18AdjudicatorConfig(extra.config))
      .toThrow("M4F_C18_ADJUDICATOR_CONFIG_INVALID");
    const record = setup();
    record.config.record_path = `${EVIDENCE}/adjudication.json`;
    expect(() => validateC18AdjudicatorConfig(record.config))
      .toThrow("M4F_C18_ADJUDICATOR_CONFIG_INVALID");
  });

  test("F0 binds the one canonical production record path and rejects unsafe parents and preexistence", () => {
    for (const path of [
      "/private/tmp/../tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-record.json",
      EVIDENCE,
      `${EVIDENCE}/record.json`,
      "/private/tmp/another-record.json",
    ]) {
      const value = setup();
      value.config.record_path = path;
      expect(() => validateC18AdjudicatorConfig(value.config))
        .toThrow("M4F_C18_ADJUDICATOR_CONFIG_INVALID");
    }
    const symlinkParent = setup();
    symlinkParent.dependencies.realpath = (path) => path === "/private/tmp"
      ? "/private/redirected" : EVIDENCE;
    expect(() => planC18LocalAdjudication(symlinkParent.config, symlinkParent.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_RECORD_PATH_INVALID");
    const preexisting = setup();
    preexisting.dependencies.pathExists = () => true;
    expect(() => executeC18LocalAdjudication(preexisting.config, preexisting.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_RECORD_PATH_INVALID");
    expect(preexisting.writes).toHaveLength(0);
  });

  test("F0 rejects write failure, partial write, bad record stat, and post-write evidence drift", () => {
    const writeFailure = setup();
    writeFailure.dependencies.writeExclusive = () => { throw new Error("disk"); };
    expect(() => executeC18LocalAdjudication(writeFailure.config, writeFailure.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_RECORD_WRITE_FAILED");

    const partial = setup();
    const partialBase = partial.dependencies.writeExclusive;
    partial.dependencies.writeExclusive = (path, bytes) => partialBase(path, bytes.subarray(0, -1));
    expect(() => executeC18LocalAdjudication(partial.config, partial.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_RECORD_WRITE_INVALID");

    const badMode = setup();
    const badModeCapture = badMode.dependencies.captureFile;
    badMode.dependencies.captureFile = (path) => {
      const capture = badModeCapture(path);
      if (path === badMode.config.record_path) {
        capture.path_before.mode = 0o644;
        capture.handle_before.mode = 0o644;
        capture.handle_after.mode = 0o644;
        capture.path_after.mode = 0o644;
      }
      return capture;
    };
    expect(() => executeC18LocalAdjudication(badMode.config, badMode.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_RECORD_WRITE_INVALID");

    const postDrift = setup();
    const directoryCapture = postDrift.dependencies.captureDirectory;
    let directoryCalls = 0;
    postDrift.dependencies.captureDirectory = (path) => {
      directoryCalls += 1;
      const capture = directoryCapture(path);
      if (directoryCalls === 3) capture.entries.push("unexpected-after-record");
      return capture;
    };
    expect(() => executeC18LocalAdjudication(postDrift.config, postDrift.dependencies))
      .toThrow("M4F_C18_ADJUDICATOR_EVIDENCE_DIRECTORY_DRIFT");
  });
});
