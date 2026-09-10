import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  adjudicateC17Locally,
  adjudicatePowerShellProgressClixml,
  canonicalJson,
  createProductionAdjudicatorConfig,
  deriveOwnershipObservation,
  localAdjudicatorConfirmation,
  parseOwnershipMarkers,
  recordC17LocalAdjudication,
  type BoundFileFact,
  type LocalAdjudicatorConfig,
  type LocalAdjudicatorDependencies,
  type StatFact,
} from "./scripts/m4f-direct-residue-ownership-c17-local-adjudicator.ts";

const EVIDENCE = "/private/tmp/synthia-m4f-direct-residue-ownership-prod-20260829-17-evidence";
const RECORD = "/private/tmp/synthia-m4f-c17-local-adjudication-test-record.json";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function statFromFact(fact: BoundFileFact): StatFact {
  return {
    device: fact.device, inode: fact.inode, owner_uid: fact.owner_uid, mode: fact.mode,
    link_count: fact.link_count, size: fact.size, mtime_ms: fact.mtime_ms, ctime_ms: fact.ctime_ms,
    kind: "file", symbolic_link: false,
  };
}

function dependencies(
  config: LocalAdjudicatorConfig,
  overrides = new Map<string, Buffer>(),
): { deps: LocalAdjudicatorDependencies; writes: Buffer[]; captures: string[] } {
  const facts = new Map<string, BoundFileFact>();
  for (const fact of Object.values(config.evidence_files)) facts.set(fact.path, structuredClone(fact));
  for (const fact of Object.values(config.lineage)) facts.set(fact.path, structuredClone(fact));
  const writes: Buffer[] = [];
  const captures: string[] = [];
  const deps: LocalAdjudicatorDependencies = {
    captureFile(path) {
      captures.push(path);
      const fact = facts.get(path)!;
      const stat = statFromFact(fact);
      const bytes = overrides.get(path) ?? readFileSync(path);
      return { path_before: stat, handle_before: stat, bytes, handle_after: stat, path_after: stat };
    },
    captureDirectory(path) {
      captures.push(path);
      const fact = config.evidence_directory;
      const stat: StatFact = {
        device: fact.device, inode: fact.inode, owner_uid: fact.owner_uid, mode: fact.mode,
        link_count: fact.link_count, size: 0, mtime_ms: fact.mtime_ms, ctime_ms: fact.ctime_ms,
        kind: "directory", symbolic_link: false,
      };
      return { before: stat, entries: [...fact.entries], after: stat };
    },
    writeExclusive(_path, bytes) { writes.push(bytes); },
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  };
  return { deps, writes, captures };
}

function productionConfig(): LocalAdjudicatorConfig {
  return createProductionAdjudicatorConfig("m4f-c17-local-adjudication-test", RECORD);
}

describe("M4-F Candidate-17 one-shot local adjudicator", () => {
  test("accepts the exact real 810-byte CP936 progress-only CLIXML and independently rebuilds stdout ownership", () => {
    const stderr = readFileSync(EVIDENCE + "/remote-stderr.raw");
    const stdout = readFileSync(EVIDENCE + "/remote-stdout.raw");
    const actual = JSON.parse(readFileSync(EVIDENCE + "/diagnostic-config.canonical.json", "utf8"));
    expect(stderr.length).toBe(810);
    expect(adjudicatePowerShellProgressClixml(stderr)).toMatchObject({
      classification: "powershell_progress_clixml_only",
      encoding: "CP936_GBK_FATAL_EXACT_ROUNDTRIP",
      object_count: 3,
      forbidden_stream_count: 0,
    });
    const markers = parseOwnershipMarkers(stdout, actual.script_config);
    const observation = deriveOwnershipObservation(markers, actual.script_config);
    expect(markers.map((marker) => marker.status)).toEqual(["observed", "started", "observed", "complete"]);
    expect(observation.reasons).toEqual([]);
    expect(observation.targets).toHaveLength(4);
    expect(observation.candidates).toHaveLength(2);
    expect(observation.candidates.every((candidate) => candidate.cleanup_derivation_permitted === false)).toBeTrue();
  });

  test("adjudicates the complete frozen production set without network, SSH, cleanup, or evidence mutation", () => {
    const config = productionConfig();
    const setup = dependencies(config);
    const before = sha256(readFileSync(EVIDENCE + "/result.json"));
    const record = adjudicateC17Locally(config, setup.deps);
    expect(record).toMatchObject({
      status: "progress_only_transport_adjudicated",
      original_status: "partial_unknown",
      original_cleanup_derivation_permitted: false,
      eligible_for_separate_cleanup_freeze: true,
      cleanup_execution_authorized: false,
      cleanup_performed: false,
      network_attempted: false,
      ssh_attempted: false,
      remote_execution_attempted: false,
    });
    expect(record.process_adjudication.stderr_was_only_false_process_ok_predicate).toBeTrue();
    expect(record.stdout_adjudication.owned_target_identities).toHaveLength(4);
    expect(record.stdout_adjudication.owned_cmd_identities).toHaveLength(2);
    expect(record.stdout_adjudication.observation_semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.writes).toHaveLength(0);
    expect(sha256(readFileSync(EVIDENCE + "/result.json"))).toBe(before);
  });

  test("rejects stream, tag, attribute, count, text, encoding, error, warning, extra-object, and tail drift", () => {
    const original = readFileSync(EVIDENCE + "/remote-stderr.raw");
    const mutations: Buffer[] = [];
    for (const [before, after] of [
      ["progress", "warningx"], ["<Obj", "<Err"], ["RefId", "BadRef"],
      ["Completed", "Failedxxx"], ["正在准备首次使用模块。", "正在准备再次使用模块。"],
    ] as const) {
      const bytes = Buffer.from(original);
      const index = bytes.indexOf(Buffer.from(before, before.startsWith("正") ? "utf8" : "ascii"));
      if (index >= 0) Buffer.from(after, before.startsWith("正") ? "utf8" : "ascii").copy(bytes, index);
      else bytes[Math.floor(bytes.length / 2)]! ^= 1;
      mutations.push(bytes);
    }
    mutations.push(Buffer.concat([original, Buffer.from("tail")]));
    const badEncoding = Buffer.from(original);
    badEncoding[0x100] = 0xff;
    mutations.push(badEncoding);
    const extraObject = Buffer.from(original);
    extraObject[extraObject.indexOf(Buffer.from("</Objs>"))] = 0x20;
    mutations.push(extraObject);
    for (const bytes of mutations) {
      expect(() => adjudicatePowerShellProgressClixml(bytes)).toThrow();
    }
  });

  test("rejects stdout marker/tail drift and observation/process drift even when the proposed fact hash is synchronized", () => {
    for (const name of ["remote-stdout.raw", "observation.json", "remote-process.json"] as const) {
      const config = productionConfig();
      const path = config.evidence_files[name]!.path;
      const bytes = Buffer.concat([readFileSync(path), Buffer.from("drift")]);
      config.evidence_files[name]!.sha256 = sha256(bytes);
      const setup = dependencies(config, new Map([[path, bytes]]));
      expect(() => adjudicateC17Locally(config, setup.deps)).toThrow("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
      expect(setup.captures).toHaveLength(0);
      expect(setup.writes).toHaveLength(0);
    }
  });

  test("rejects file identity, source lineage, and exact-file-set drift before any output write", () => {
    const config = productionConfig();
    const setup = dependencies(config);
    config.evidence_files["result.json"]!.inode += 1;
    expect(() => adjudicateC17Locally(config, setup.deps)).toThrow("M4F_C17_ADJUDICATOR_BOUND_FILE_DRIFT");
    expect(setup.writes).toHaveLength(0);

    const lineageConfig = productionConfig();
    const lineagePath = lineageConfig.lineage.candidate17_source!.path;
    const lineageSetup = dependencies(lineageConfig, new Map([[lineagePath, Buffer.from("drift")]]));
    expect(() => adjudicateC17Locally(lineageConfig, lineageSetup.deps)).toThrow("M4F_C17_ADJUDICATOR_BOUND_FILE_DRIFT");
    expect(lineageSetup.writes).toHaveLength(0);

    const setConfig = productionConfig();
    setConfig.evidence_directory.entries = [...setConfig.evidence_directory.entries, "extra"].sort();
    const setSetup = dependencies(setConfig);
    expect(() => adjudicateC17Locally(setConfig, setSetup.deps)).toThrow("M4F_C17_ADJUDICATOR_CONFIG_INVALID");
    expect(setSetup.captures).toHaveLength(0);
  });

  test("requires the separately bound exact local confirmation and writes only the new record", () => {
    const config = productionConfig();
    const setup = dependencies(config);
    expect(() => recordC17LocalAdjudication(config, "wrong", setup.deps))
      .toThrow("M4F_C17_ADJUDICATOR_CONFIRMATION_REQUIRED");
    expect(setup.writes).toHaveLength(0);
    const record = recordC17LocalAdjudication(config, localAdjudicatorConfirmation(config), setup.deps);
    expect(setup.writes).toHaveLength(1);
    expect(JSON.parse(setup.writes[0]!.toString("utf8"))).toEqual(JSON.parse(canonicalJson(record)));
    expect(record.cleanup_execution_authorized).toBeFalse();
  });
});
