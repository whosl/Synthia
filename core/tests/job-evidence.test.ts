import { describe, expect, test } from "bun:test";
import { fetchJobEvidenceContent } from "../src/api/job-evidence.ts";
import { getJobEvidenceHandler } from "../src/api/handlers.ts";
import type { RequestContext } from "../src/api/handlers.ts";
import { ConnectorError, type EvidenceContentOptions } from "../src/api/connector-port.ts";
import { sha256Hex } from "../src/hashing.ts";

const content = "historical report";
const entry = { name: "resources.rpt", sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content), mediaType: "text/plain" };
function context(options: { entries?: unknown; code?: string; mismatch?: boolean; state?: string } = {}) {
  const reads: (EvidenceContentOptions | undefined)[] = [];
  const queries: string[] = [];
  const ctx = {
    params: { projectId: "p1", jobId: "old-job" },
    pool: { async query(sql: string, params: unknown[]) {
      queries.push(sql);
      if (sql.includes("SELECT state")) return { rows: [{ state: options.state ?? "succeeded" }] };
      if (sql.includes("AS frozen_entries")) {
        expect(params).toEqual(["old-job", "p1"]);
        expect(sql).toContain("t.project_id=$2");
        expect(sql).toContain("t.state IN");
        return { rows: [{ frozen_entries: options.entries === undefined ? [entry] : options.entries }] };
      }
      return { rows: [] };
    } },
    connector: {
      async fetchEvidenceContent(_project: string, _job: string, _name: string, opts?: EvidenceContentOptions) {
        reads.push(opts);
        if (!opts?.archivedEntry) throw new ConnectorError(options.code ?? "JOB_NOT_FOUND");
        return { ...entry, sha256: options.mismatch ? "0".repeat(64) : entry.sha256, content, truncated: false };
      },
      async queryStatus() { return { state: "running" }; },
      async fetchEvidence() { throw new Error("must use frozen manifest"); },
    },
  } as unknown as RequestContext;
  return { ctx, reads, queries };
}

describe("Core historical evidence authority", () => {
  test("evicted jobs retry from the owned frozen entry, preserving paging/full options", async () => {
    for (const options of [{ range: { offset: 5, limit: 20 } }, { requireFull: true }]) {
      const c = context();
      expect((await fetchJobEvidenceContent(c.ctx, "p1", "old-job", entry.name, options)).content).toBe(content);
      expect(c.reads).toEqual([options, { ...options, archivedEntry: entry }]);
      expect(c.queries.every((sql) => !/UPDATE|INSERT|DELETE/.test(sql))).toBeTrue();
    }
  });
  test("no frozen entry, a foreign job, or an unlisted filename never enables archive reads", async () => {
    for (const entries of [null, [], [{ ...entry, name: "other.rpt" }]]) {
      const c = context({ entries });
      await expect(fetchJobEvidenceContent(c.ctx, "p1", "old-job", entry.name)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
      expect(c.reads).toHaveLength(1);
    }
  });
  test("corrupt evidence and connector outages do not trigger fallback", async () => {
    for (const code of ["EVIDENCE_CORRUPT", "EVIDENCE_NOT_AVAILABLE", "CONNECTOR_UNAVAILABLE"]) {
      const c = context({ code });
      await expect(fetchJobEvidenceContent(c.ctx, "p1", "old-job", entry.name)).rejects.toMatchObject({ code });
      expect(c.queries).toHaveLength(0);
      expect(c.reads).toHaveLength(1);
    }
    const c = context({ mismatch: true });
    await expect(fetchJobEvidenceContent(c.ctx, "p1", "old-job", entry.name)).rejects.toMatchObject({ code: "EVIDENCE_CORRUPT" });
  });
  test("frozen terminal manifests remain readable with no connector configured", async () => {
    const c = context();
    const result = await getJobEvidenceHandler({ ...c.ctx, connector: undefined });
    expect(result.data).toEqual({ jobId: "old-job", entries: [entry] });
    expect(c.reads).toHaveLength(0);
  });
  test("a running job cannot serve its manifest as terminal evidence", async () => {
    const c = context({ state: "running" });
    await expect(getJobEvidenceHandler(c.ctx)).rejects.toThrow("job not terminal");
    expect(c.queries.some((sql) => sql.includes("AS frozen_entries"))).toBeFalse();
  });
});
