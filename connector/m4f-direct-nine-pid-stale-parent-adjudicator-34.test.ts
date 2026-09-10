import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  adjudicateCandidate31Evidence,
  adjudicateCandidate31Record,
  CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY,
  CANDIDATE32_PRODUCTION_EVIDENCE_DIRECTORY,
  CANDIDATE33_PRODUCTION_EVIDENCE_DIRECTORY,
  Candidate34Failure,
  executeCandidate34,
  type Candidate34Dependencies,
} from "./scripts/m4f-direct-nine-pid-stale-parent-adjudicator-34.ts";

function productionDependencies(): Candidate34Dependencies {
  return {
    read: (path) => readFileSync(path),
    entries: (path) => readdirSync(path).sort(),
  };
}

function record(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY + "/preflight-record.json",
    "utf8",
  )) as Record<string, unknown>;
}

function snapshot(value: Record<string, unknown>): Record<string, unknown> {
  return ((value.preflight_result as Record<string, unknown>).snapshot) as Record<string, unknown>;
}

describe("M4-F Candidate 34 exact stale-parent adjudication", () => {
  test("binds all three immutable evidence sets and permits only cleanup derivation", () => {
    const result = adjudicateCandidate31Evidence(productionDependencies());
    expect(result.source_decision).toBe("observed_blocked");
    expect(result.decision).toBe("exact_stale_parent_boundary_adjudicated");
    expect(result.cleanup_derivation_permitted).toBe(true);
    expect(result.cleanup_execution_permitted).toBe(false);
    expect(result.exact_target_pids).toEqual([
      44768, 56576, 64484, 58908, 67048, 66316, 39016, 48664, 66340,
    ]);
    expect(result.exact_target_rows).toHaveLength(9);
    expect(result.candidate31_record_sha256).toHaveLength(64);
    expect(result.candidate32_record_sha256).toHaveLength(64);
    expect(result.candidate33_record_sha256).toHaveLength(64);
  });

  test("rejects any evidence drift in C31, C32, or C33", () => {
    for (const [directory, name] of [
      [CANDIDATE31_PRODUCTION_EVIDENCE_DIRECTORY, "stdout.raw"],
      [CANDIDATE32_PRODUCTION_EVIDENCE_DIRECTORY, "probe-record.json"],
      [CANDIDATE33_PRODUCTION_EVIDENCE_DIRECTORY, "probe-record.json"],
    ] as const) {
      const base = productionDependencies();
      const dependencies: Candidate34Dependencies = {
        ...base,
        read(path) {
          const bytes = base.read(path);
          return path === directory + "/" + name ? Buffer.concat([bytes, Buffer.from("x")]) : bytes;
        },
      };
      expect(() => adjudicateCandidate31Evidence(dependencies)).toThrow(Candidate34Failure);
    }
  });

  test("accepts only the exact shared PID-reuse boundary", () => {
    const changes: Array<(value: Record<string, unknown>) => void> = [
      (value) => { (snapshot(value).current_chain as unknown[][]).at(-1)![3] = "2026-08-12T22:31:30.7301580Z"; },
      (value) => { (snapshot(value).worker_ancestors as unknown[][]).at(-1)![1] = 1449; },
      (value) => { (snapshot(value).current_chain as unknown[][]).at(-2)![2] = "other.exe"; },
      (value) => { (snapshot(value).worker_ancestors as unknown[][]).at(-3)![0] = 1449; },
      (value) => { snapshot(value).listeners_18443 = [["0.0.0.0", 18443, 13644]]; },
    ];
    for (const change of changes) {
      const value = structuredClone(record());
      change(value);
      expect(() => adjudicateCandidate31Record(value)).toThrow(Candidate34Failure);
    }
  });

  test("writes one immutable local record without authorizing execution", () => {
    const writes = new Map<string, Buffer>();
    const dependencies: Candidate34Dependencies = {
      ...productionDependencies(),
      writeExclusive(path, bytes) {
        if (writes.has(path)) throw new Error("exists");
        writes.set(path, Buffer.from(bytes));
      },
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    };
    const result = executeCandidate34(dependencies);
    expect(result.recorded_at_utc).toBe("2026-08-31T00:00:00.000Z");
    expect(result.cleanup_execution_permitted).toBe(false);
    expect(writes.size).toBe(1);
    expect(() => executeCandidate34(dependencies)).toThrow(Candidate34Failure);
  });
});
