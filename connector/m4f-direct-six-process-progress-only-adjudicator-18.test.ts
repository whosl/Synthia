import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  buildCandidate18Payload,
  type Candidate18Payload,
} from "./scripts/m4f-direct-six-process-parse-only-18.ts";
import { validateCandidate19ScriptConfig } from "./scripts/m4f-direct-six-process-cleanup-19.ts";
import {
  C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY,
  C18_PROGRESS_ONLY_EVIDENCE_HASHES,
  C18_PROGRESS_ONLY_SOURCE_PATH,
  C18_PROGRESS_ONLY_TEST_SOURCE_PATH,
  adjudicateCandidate18ProgressOnly,
  canonicalJsonC18ProgressOnly,
  validateCandidate18ProgressOnlyCliXml,
  validateCandidate18ProgressOnlyConfig,
  validateCandidate18ProgressOnlyOriginalFailure,
  validateCandidate18ProgressOnlyRemoteProcess,
  validateCandidate18ProgressOnlyStdout,
  type C18ProgressOnlyBoundDirectory,
  type C18ProgressOnlyBoundFile,
  type C18ProgressOnlyBoundImplementationFile,
  type C18ProgressOnlyConfig,
  type C18ProgressOnlyStatFact,
  type Candidate18ProgressOnlyDependencies,
} from "./scripts/m4f-direct-six-process-progress-only-adjudicator-18.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function statFact(path: string): C18ProgressOnlyStatFact {
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
  config: C18ProgressOnlyConfig;
  configSha256: string;
  dependencies: Candidate18ProgressOnlyDependencies;
  bytes: Map<string, Buffer>;
  entries: string[];
}

function setup(): Setup {
  const entries = Object.keys(C18_PROGRESS_ONLY_EVIDENCE_HASHES).sort();
  const bytes = new Map<string, Buffer>();
  const evidenceFiles: Record<string, C18ProgressOnlyBoundFile> = {};
  for (const name of entries) {
    const path = `${C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY}/${name}`;
    const content = readFileSync(path);
    expect(hash(content)).toBe(C18_PROGRESS_ONLY_EVIDENCE_HASHES[
      name as keyof typeof C18_PROGRESS_ONLY_EVIDENCE_HASHES
    ]);
    bytes.set(path, content);
    const stat = statFact(path);
    evidenceFiles[name] = {
      schema: "synthia-m4f-c18-progress-only-bound-file.v1",
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
  const directoryStat = statFact(C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY);
  const directory: C18ProgressOnlyBoundDirectory = {
    schema: "synthia-m4f-c18-progress-only-bound-directory.v1",
    path: C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY,
    entries: [...entries],
    device: directoryStat.device,
    inode: directoryStat.inode,
    owner_uid: directoryStat.owner_uid,
    mode: directoryStat.mode,
    link_count: directoryStat.link_count,
    mtime_ms: directoryStat.mtime_ms,
    ctime_ms: directoryStat.ctime_ms,
  };
  const bindImplementationFile = (path: string): C18ProgressOnlyBoundImplementationFile => {
    const content = readFileSync(path);
    const stat = statFact(path);
    bytes.set(path, content);
    return {
      schema: "synthia-m4f-c18-progress-only-bound-implementation-file.v1",
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
  };
  const config: C18ProgressOnlyConfig = {
    schema: "synthia-m4f-c18-progress-only-adjudicator-config.v1",
    adjudication_id: "candidate18-progress-only-test",
    evidence_directory: directory,
    evidence_files: evidenceFiles,
    source_file: bindImplementationFile(C18_PROGRESS_ONLY_SOURCE_PATH),
    test_source_file: bindImplementationFile(C18_PROGRESS_ONLY_TEST_SOURCE_PATH),
  };
  const dependencies: Candidate18ProgressOnlyDependencies = {
    captureFile(path) {
      const expected = [
        ...Object.values(config.evidence_files),
        config.source_file,
        config.test_source_file,
      ].find((fact) => fact.path === path);
      const content = bytes.get(path);
      if (!expected || !content) throw new Error("missing");
      const fact: C18ProgressOnlyStatFact = {
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
      const fact: C18ProgressOnlyStatFact = {
        device: directory.device,
        inode: directory.inode,
        owner_uid: directory.owner_uid,
        mode: directory.mode,
        link_count: directory.link_count,
        size: directoryStat.size,
        mtime_ms: directory.mtime_ms,
        ctime_ms: directory.ctime_ms,
        kind: "directory",
        symbolic_link: false,
      };
      return {
        before: structuredClone(fact),
        entries: [...entries],
        after: structuredClone(fact),
      };
    },
  };
  return {
    config,
    configSha256: hash(canonicalJsonC18ProgressOnly(config) + "\n"),
    dependencies,
    bytes,
    entries,
  };
}

function adjudicate(value: Setup): Record<string, unknown> {
  return adjudicateCandidate18ProgressOnly(
    value.config,
    value.configSha256,
    value.dependencies,
  );
}

function evidence(name: string): Buffer {
  return readFileSync(`${C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY}/${name}`);
}

function candidate18Payload(): Candidate18Payload {
  const raw = JSON.parse(evidence("candidate19-script-config.raw.json").toString("utf8"));
  return buildCandidate18Payload(validateCandidate19ScriptConfig(raw));
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}

describe("M4-F Candidate18 progress-only adjudicator", () => {
  test("adjudicates the frozen parse result without writes, retries, network, or cleanup", () => {
    const value = setup();
    const before = new Map([...value.bytes].map(([path, bytes]) => [path, hash(bytes)]));
    const result = adjudicate(value);
    expect(result).toMatchObject({
      schema: "synthia-m4f-c18-progress-only-adjudication.v1",
      status: "parsed_not_invoked_progress_only_adjudicated",
      original_failure_code: "M4F_CANDIDATE18_REMOTE_PARSE_FAILED",
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
      evidence_file_count: 21,
      evidence_exact_file_set: true,
      parse_result: {
        status: "parsed_not_invoked",
        powershell_edition: "Desktop",
        powershell_version: "5.1.26100.9168",
        business: {
          parse_error_count: 0,
          parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
          parser_end_block_present: true,
          target_body_not_invoked: true,
        },
        outer_loader: {
          parse_error_count: 0,
          parser_ast_type: "System.Management.Automation.Language.ScriptBlockAst",
          parser_end_block_present: true,
          target_body_not_invoked: true,
        },
      },
      progress_record: {
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
      },
    });
    expect((result.bindings as Record<string, unknown>).adjudicator_config_sha256)
      .toBe(hash(canonicalJsonC18ProgressOnly(value.config) + "\n"));
    for (const [path, bytes] of value.bytes) expect(hash(bytes)).toBe(before.get(path));
  });

  test("calls the strict Candidate18 stdout validator and rejects every result field drift", () => {
    const payload = candidate18Payload();
    const stdout = evidence("stdout.raw");
    expect(validateCandidate18ProgressOnlyStdout(stdout, payload)).toMatchObject({
      status: "parsed_not_invoked",
      powershell_edition: "Desktop",
      powershell_version: "5.1.26100.9168",
    });
    const original = JSON.parse(stdout.toString("utf8")) as Record<string, unknown>;
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.s = "bad"; },
      (value) => { value.z = "no"; },
      (value) => { value.i = "0".repeat(64); },
      (value) => { value.l = 0; },
      (value) => { value.e = "Core"; },
      (value) => { value.v = "5.1.0"; },
      (value) => { (value.b as Record<string, unknown>).h = "0".repeat(64); },
      (value) => { (value.b as Record<string, unknown>).l = 0; },
      (value) => { (value.b as Record<string, unknown>).c = 1; },
      (value) => { (value.b as Record<string, unknown>).a = "OtherAst"; },
      (value) => { (value.b as Record<string, unknown>).n = false; },
      (value) => { (value.b as Record<string, unknown>).i = false; },
      (value) => { (value.o as Record<string, unknown>).h = "0".repeat(64); },
      (value) => { (value.o as Record<string, unknown>).l = 0; },
      (value) => { (value.o as Record<string, unknown>).c = 1; },
      (value) => { (value.o as Record<string, unknown>).a = "OtherAst"; },
      (value) => { (value.o as Record<string, unknown>).n = false; },
      (value) => { (value.o as Record<string, unknown>).i = false; },
      (value) => { delete value.b; },
      (value) => { value.extra = true; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(() => validateCandidate18ProgressOnlyStdout(jsonLine(changed), payload)).toThrow();
    }
  });

  test("accepts exactly one benign Completed progress CLIXML record", () => {
    const stderr = evidence("stderr.raw");
    expect(validateCandidate18ProgressOnlyCliXml(stderr)).toMatchObject({
      stream: "progress",
      activity: "正在准备首次使用模块。",
      status: "Completed",
    });
    const text = stderr.toString("utf8");
    const mutations = [
      text + text.slice("#< CLIXML\r\n".length),
      text.replace("</Objs>", '<Obj S="progress"></Obj></Objs>'),
      text.replace("</PR>", '<PR N="Record"></PR></PR>'),
      ...["error", "warning", "debug", "verbose", "information"].map(
        (stream) => text.replace('S="progress"', `S="${stream}"`),
      ),
      text.replace("正在准备首次使用模块。", "已更改"),
      text.replace("Completed", "Running"),
      "extra" + text,
      text + "extra",
      "\ufeff" + text,
      text.replace("\r\n", "\n"),
      text.replace("<Objs ", "<!DOCTYPE x><Objs "),
      text.replace("<Objs ", "<!ENTITY x 'y'><Objs "),
      text.replace("<Objs ", "<!--x--><Objs "),
      text.replace("<Objs ", "<?x?><Objs "),
    ];
    for (const mutation of mutations) {
      expect(() => validateCandidate18ProgressOnlyCliXml(Buffer.from(mutation, "utf8")))
        .toThrow("M4F_C18_PROGRESS_ONLY_CLIXML_INVALID");
    }
    expect(() => validateCandidate18ProgressOnlyCliXml(Buffer.from([0xff])))
      .toThrow("M4F_C18_PROGRESS_ONLY_CLIXML_INVALID");
  });

  test("rejects every remote-process contract drift", () => {
    const stdin = evidence("target-outer-loader.ps1");
    const stdout = evidence("stdout.raw");
    const stderr = evidence("stderr.raw");
    const original: Record<string, unknown> = JSON.parse(
      evidence("remote-process.json").toString("utf8"),
    );
    expect(validateCandidate18ProgressOnlyRemoteProcess(original, stdin, stdout, stderr))
      .toEqual(original);
    const changes: Record<string, unknown> = {
      exit_status: 1,
      signal: "SIGTERM",
      error_code: "EIO",
      timed_out: true,
      retry_permitted: true,
      stdin_length: 0,
      stdin_sha256: "0".repeat(64),
      stdout_length: 0,
      stdout_sha256: "0".repeat(64),
      stderr_length: 0,
      stderr_sha256: "0".repeat(64),
    };
    for (const [key, changedValue] of Object.entries(changes)) {
      const changed = structuredClone(original);
      changed[key] = changedValue;
      expect(() => validateCandidate18ProgressOnlyRemoteProcess(changed, stdin, stdout, stderr))
        .toThrow("M4F_C18_PROGRESS_ONLY_REMOTE_PROCESS_INVALID");
    }
    expect(() => validateCandidate18ProgressOnlyRemoteProcess(
      { ...original, extra: true }, stdin, stdout, stderr,
    )).toThrow("M4F_C18_PROGRESS_ONLY_REMOTE_PROCESS_INVALID");
  });

  test("preserves the exact original network failure and forbids retry reinterpretation", () => {
    const process: Record<string, unknown> = JSON.parse(
      evidence("remote-process.json").toString("utf8"),
    );
    const original: Record<string, unknown> = JSON.parse(
      evidence("parse-failure.json").toString("utf8"),
    );
    expect(validateCandidate18ProgressOnlyOriginalFailure(original, process)).toEqual(original);
    const mutations: Array<[string, unknown]> = [
      ["code", "OTHER"],
      ["stage", "output_validation"],
      ["attempt", 2],
      ["retry_permitted", true],
      ["remote_effect_state", "not_started"],
      ["cleanup_performed", true],
      ["business_target_body_not_invoked", false],
      ["outer_loader_target_body_not_invoked", false],
    ];
    for (const [key, changedValue] of mutations) {
      const changed = structuredClone(original);
      changed[key] = changedValue;
      expect(() => validateCandidate18ProgressOnlyOriginalFailure(changed, process))
        .toThrow("M4F_C18_PROGRESS_ONLY_ORIGINAL_FAILURE_INVALID");
    }
  });

  test("binds all raw files, plan, parse config, adjudicator config, source, and test bytes", () => {
    for (const name of Object.keys(C18_PROGRESS_ONLY_EVIDENCE_HASHES)) {
      const value = setup();
      const path = `${C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY}/${name}`;
      value.bytes.set(path, Buffer.concat([value.bytes.get(path)!, Buffer.from("x")]));
      expect(() => adjudicate(value))
        .toThrow("M4F_C18_PROGRESS_ONLY_EVIDENCE_FILE_DRIFT");
    }
    const source = setup();
    source.bytes.set(C18_PROGRESS_ONLY_SOURCE_PATH, Buffer.from("drift"));
    expect(() => adjudicate(source))
      .toThrow("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");
    const testSource = setup();
    testSource.bytes.set(C18_PROGRESS_ONLY_TEST_SOURCE_PATH, Buffer.from("drift"));
    expect(() => adjudicate(testSource))
      .toThrow("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");
    const extra = setup();
    (extra.config as unknown as Record<string, unknown>).extra = true;
    expect(() => validateCandidate18ProgressOnlyConfig(extra.config))
      .toThrow("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
    const wrongPath = setup();
    wrongPath.config.source_file.path = "/private/tmp/forged-source.ts";
    expect(() => validateCandidate18ProgressOnlyConfig(wrongPath.config))
      .toThrow("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
    const forged = setup();
    const substitutedSource = Buffer.alloc(forged.config.source_file.size, 0x78);
    forged.bytes.set(C18_PROGRESS_ONLY_SOURCE_PATH, substitutedSource);
    forged.config.source_file.sha256 = hash(substitutedSource);
    expect(() => adjudicate(forged))
      .toThrow("M4F_C18_PROGRESS_ONLY_CONFIG_HASH_MISMATCH");
  });

  test("rejects file stat drift and exact directory-set drift", () => {
    const statDrift = setup();
    const captureFile = statDrift.dependencies.captureFile;
    statDrift.dependencies.captureFile = (path) => {
      const capture = captureFile(path);
      if (path.startsWith(C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY + "/")) {
        capture.handle_after.mtime_ms += 1;
      }
      return capture;
    };
    expect(() => adjudicate(statDrift))
      .toThrow("M4F_C18_PROGRESS_ONLY_EVIDENCE_FILE_DRIFT");

    const sourceStatDrift = setup();
    const captureSource = sourceStatDrift.dependencies.captureFile;
    sourceStatDrift.dependencies.captureFile = (path) => {
      const capture = captureSource(path);
      if (path === C18_PROGRESS_ONLY_SOURCE_PATH) capture.handle_after.mtime_ms += 1;
      return capture;
    };
    expect(() => adjudicate(sourceStatDrift))
      .toThrow("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");

    const testEndDrift = setup();
    const captureTest = testEndDrift.dependencies.captureFile;
    let testCaptureCount = 0;
    testEndDrift.dependencies.captureFile = (path) => {
      const capture = captureTest(path);
      if (path === C18_PROGRESS_ONLY_TEST_SOURCE_PATH) {
        testCaptureCount += 1;
        if (testCaptureCount === 2) capture.path_after.ctime_ms += 1;
      }
      return capture;
    };
    expect(() => adjudicate(testEndDrift))
      .toThrow("M4F_C18_PROGRESS_ONLY_SOURCE_MISMATCH");

    const directoryDrift = setup();
    directoryDrift.entries.push("unexpected");
    expect(() => adjudicate(directoryDrift))
      .toThrow("M4F_C18_PROGRESS_ONLY_EVIDENCE_DIRECTORY_DRIFT");

    const configStatDrift = setup();
    configStatDrift.config.evidence_directory.mode = 0o755;
    expect(() => validateCandidate18ProgressOnlyConfig(configStatDrift.config))
      .toThrow("M4F_C18_PROGRESS_ONLY_CONFIG_INVALID");
  });

  test("dependency surface and source contain no process, network, SSH, or write capability", () => {
    const source = readFileSync(C18_PROGRESS_ONLY_SOURCE_PATH, "utf8");
    const interfaceBody = source.match(
      /export interface Candidate18ProgressOnlyDependencies \{([\s\S]*?)\n\}/u,
    )?.[1] ?? "";
    expect(interfaceBody).not.toMatch(/spawn|exec|network|ssh|write|remove|unlink|rename/iu);
    expect(source).not.toMatch(
      /node:(?:child_process|http|https|net)|\/usr\/bin\/ssh|fetch\s*\(|Bun\.write|writeFileSync|appendFileSync|unlinkSync|persist\s*\(/iu,
    );
    const value = setup();
    (value.dependencies as unknown as Record<string, unknown>).fetch = () => undefined;
    expect(() => adjudicate(value))
      .toThrow("M4F_C18_PROGRESS_ONLY_DEPENDENCIES_INVALID");
  });
});
