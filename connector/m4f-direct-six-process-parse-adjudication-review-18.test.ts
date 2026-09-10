import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  C18_ADJUDICATION_REVIEW_RECORD_PATH,
  executeC18AdjudicationReview,
  planC18AdjudicationReview,
  type C18AdjudicationReviewDependencies,
} from "./scripts/m4f-direct-six-process-parse-adjudication-review-18.ts";
import type {
  C18AdjudicatorDirectoryCapture,
  C18AdjudicatorFileCapture,
  C18AdjudicatorStatFact,
} from "./scripts/m4f-direct-six-process-parse-adjudicator-18.ts";

const EVIDENCE = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-evidence";
const ADJUDICATION = "/private/tmp/synthia-m4f-direct-six-process-parse-only-prod-20260829-18-progress-adjudication-record.json";
const CONFIG = "/private/tmp/synthia-m4f-direct-six-process-parse-progress-adjudicator-prod-20260829-18.json";
const SOURCE = new URL("./scripts/m4f-direct-six-process-parse-adjudicator-18.ts", import.meta.url).pathname;
const TEST_SOURCE = new URL("./m4f-direct-six-process-parse-adjudicator-18.test.ts", import.meta.url).pathname;

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
  dependencies: C18AdjudicationReviewDependencies;
  files: Map<string, { bytes: Buffer; fact: C18AdjudicatorStatFact }>;
  evidenceEntries: string[];
  writes: Array<{ path: string; bytes: Buffer }>;
}

function setup(): Setup {
  const paths = [CONFIG, SOURCE, TEST_SOURCE, ADJUDICATION,
    ...readdirSync(EVIDENCE).sort().map((name) => `${EVIDENCE}/${name}`)];
  const files = new Map(paths.map((path) => [path, { bytes: readFileSync(path), fact: statFact(path) }]));
  const evidenceEntries = readdirSync(EVIDENCE).sort();
  const evidenceFact = statFact(EVIDENCE);
  const writes: Setup["writes"] = [];
  let output: { bytes: Buffer; fact: C18AdjudicatorStatFact } | null = null;
  const dependencies: C18AdjudicationReviewDependencies = {
    captureFile(path): C18AdjudicatorFileCapture {
      const value = path === C18_ADJUDICATION_REVIEW_RECORD_PATH ? output : files.get(path);
      if (!value) throw new Error("missing");
      const fact = structuredClone(value.fact);
      return {
        path_before: structuredClone(fact),
        handle_before: structuredClone(fact),
        bytes: Buffer.from(value.bytes),
        handle_after: structuredClone(fact),
        path_after: structuredClone(fact),
      };
    },
    captureDirectory(path): C18AdjudicatorDirectoryCapture {
      if (path !== EVIDENCE) throw new Error("directory");
      return {
        before: structuredClone(evidenceFact),
        entries: [...evidenceEntries],
        after: structuredClone(evidenceFact),
      };
    },
    realpath(path) {
      if (path === "/private/tmp") return "/private/tmp";
      if (path === EVIDENCE) return EVIDENCE;
      throw new Error("realpath");
    },
    pathExists: () => output !== null,
    writeExclusive(path, bytes) {
      if (output !== null) throw new Error("exists");
      writes.push({ path, bytes: Buffer.from(bytes) });
      output = {
        bytes: Buffer.from(bytes),
        fact: {
          device: 16777231,
          inode: 77777777,
          owner_uid: 501,
          mode: 0o600,
          link_count: 1,
          size: bytes.length,
          mtime_ms: 20,
          ctime_ms: 20,
          kind: "file",
          symbolic_link: false,
        },
      };
    },
    now: () => new Date("2026-08-29T13:20:00.000Z"),
  };
  return { dependencies, files, evidenceEntries, writes };
}

describe("M4-F C18 local adjudication formal review", () => {
  test("reconstructs the exact adjudication and emits only execution-freeze eligibility", () => {
    const value = setup();
    const review = planC18AdjudicationReview(value.dependencies);
    expect(review).toMatchObject({
      decision: "GO_FOR_C19_EXECUTION_FREEZE_ONLY",
      review_record_created: false,
      adjudication: {
        path: ADJUDICATION,
        sha256: "1c5ececedf02af5e335273d2bbe97c8eec08db6362b5215d64c1df28d4eb1d25",
        status: "parse_success_locally_adjudicated",
        original_failure_preserved: true,
      },
      evidence_lineage: { exact_file_count: 21, exact_file_set: true },
      c18_lineage: {
        config_sha256: "051077fae982440fecdddc29014f8119da1aa9469cb0cd1836b2cc1e9c2d12ce",
        plan_sha256: "17285cfc64496a789ef71ae8f618316484136fb8d255e6c21b06d152fd20b9ae",
        parse_status: "parsed_not_invoked",
      },
      c19_lineage: {
        script_config_sha256: "be33526bfd69ed606a117af32538f2f18c6fe146f9551588d22e6b3191685b76",
        business_script_sha256: "fbfdfd670107f1cf438635b82bd396e20d8fe24d41b8009a93aa21023566ea4c",
        outer_loader_sha256: "9d6d908becc22a50148db392f2d3245927e4051e4a11f1b3db7591a8dc4ff216",
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
    });
    expect(value.writes).toHaveLength(0);
  });

  test("creates exactly one external 0600 review record and preserves all sources", () => {
    const value = setup();
    const before = new Map([...value.files].map(([path, item]) => [path, hash(item.bytes)]));
    const review = executeC18AdjudicationReview(value.dependencies);
    expect(review.review_record_created).toBe(true);
    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]!.path).toBe(C18_ADJUDICATION_REVIEW_RECORD_PATH);
    expect(JSON.parse(value.writes[0]!.bytes.toString())).toMatchObject({
      decision: "GO_FOR_C19_EXECUTION_FREEZE_ONLY",
      authorization_boundary: { c19_execution_authorized: false, network_authorized: false },
    });
    for (const [path, item] of value.files) expect(hash(item.bytes)).toBe(before.get(path));
    expect(value.evidenceEntries).toHaveLength(21);
  });

  test("fails closed on adjudication, config, source, test, or evidence mutation", () => {
    for (const path of [ADJUDICATION, CONFIG, SOURCE, TEST_SOURCE, `${EVIDENCE}/stdout.raw`]) {
      const value = setup();
      const item = value.files.get(path)!;
      item.bytes = Buffer.concat([item.bytes, Buffer.from("x")]);
      expect(() => planC18AdjudicationReview(value.dependencies)).toThrow();
    }
    const directory = setup();
    directory.evidenceEntries.push("extra");
    expect(() => planC18AdjudicationReview(directory.dependencies)).toThrow();
  });

  test("rejects unsafe parent, preexisting output, partial writes, bad mode, and post-source drift", () => {
    const parent = setup();
    parent.dependencies.realpath = (path) => path === "/private/tmp" ? "/private/redirected" : EVIDENCE;
    expect(() => planC18AdjudicationReview(parent.dependencies))
      .toThrow("M4F_C18_ADJUDICATION_REVIEW_RECORD_PATH_INVALID");

    const preexisting = setup();
    preexisting.dependencies.pathExists = () => true;
    expect(() => executeC18AdjudicationReview(preexisting.dependencies))
      .toThrow("M4F_C18_ADJUDICATION_REVIEW_RECORD_PATH_INVALID");

    const partial = setup();
    const write = partial.dependencies.writeExclusive;
    partial.dependencies.writeExclusive = (path, bytes) => write(path, bytes.subarray(0, -1));
    expect(() => executeC18AdjudicationReview(partial.dependencies))
      .toThrow("M4F_C18_ADJUDICATION_REVIEW_WRITE_INVALID");

    const badMode = setup();
    const capture = badMode.dependencies.captureFile;
    badMode.dependencies.captureFile = (path) => {
      const result = capture(path);
      if (path === C18_ADJUDICATION_REVIEW_RECORD_PATH) {
        for (const fact of [result.path_before, result.handle_before, result.handle_after, result.path_after]) {
          fact.mode = 0o644;
        }
      }
      return result;
    };
    expect(() => executeC18AdjudicationReview(badMode.dependencies))
      .toThrow("M4F_C18_ADJUDICATION_REVIEW_WRITE_INVALID");

    const drift = setup();
    const directoryCapture = drift.dependencies.captureDirectory;
    let calls = 0;
    drift.dependencies.captureDirectory = (path) => {
      calls += 1;
      const result = directoryCapture(path);
    if (calls >= 3) result.entries.push("post-write-drift");
      return result;
    };
    expect(() => executeC18AdjudicationReview(drift.dependencies)).toThrow();
  });
});
