import { describe, expect, test } from "bun:test";
import { getProjectToolSummaryHandler } from "../src/api/tool-summary.ts";
import { readResourceSummary } from "../src/api/resource-summary.ts";
import type { RequestContext } from "../src/api/handlers.ts";

const report = "Device : xc7-test\n| Site Type | Used | Available | Util% |\n| Slice LUTs | 50 | 100 | 50 |";
function context(options: { authorized?: boolean; source?: boolean; fail?: boolean; truncated?: boolean; content?: string } = {}) {
  let reads = 0;
  const queries: { sql: string; params: unknown[] }[] = [];
  const ctx = {
    params: { projectId: "p1" },
    identity: { scopes: ["core:read"], actorType: "human", actorId: "reader" },
    pool: { async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("SELECT id FROM project")) return { rows: [{ id: "p1" }] };
      if (sql.includes("role_assignment")) return { rows: options.authorized === false ? [] : [{ allowed: 1 }] };
      if (sql.includes("COALESCE(end_time, created_at)")) return { rows: options.source === false ? [] : [{ job_id: `job-${params[0]}`, operation: "implement", at: new Date("2026-09-27T00:00:00Z") }] };
      return { rows: [] };
    } },
    connector: { async fetchEvidenceContent(projectId: string, jobId: string, name: string, opts: unknown) {
      reads++;
      expect(jobId).toBe(`job-${projectId}`);
      expect(name).toBe("resources.rpt");
      expect(opts).toEqual({ requireFull: true });
      if (options.fail) throw new Error("upstream unavailable");
      return { content: options.content ?? report, truncated: options.truncated ?? false };
    } },
  } as unknown as RequestContext;
  return { ctx, queries, reads: () => reads };
}

describe("project resource summary", () => {
  test("project authorization precedes report reads", async () => {
    const c = context({ authorized: false });
    await expect(getProjectToolSummaryHandler(c.ctx)).rejects.toThrow();
    expect(c.reads()).toBe(0);
    expect(c.queries).toHaveLength(2);
  });
  test("authorized summary includes report provenance and device capacity", async () => {
    const c = context();
    const result = await getProjectToolSummaryHandler(c.ctx);
    expect(result.data).toMatchObject({ resources: { sourceJobId: "job-p1", device: "xc7-test", sourceOperation: "implement", metrics: [{ key: "lut", used: 50, available: 100, percent: 50 }] } });
    const query = c.queries.find((q) => q.sql.includes("COALESCE(end_time, created_at)"))!;
    expect(query.params).toEqual(["p1"]);
    expect(query.sql).toContain("state = 'succeeded'");
    expect(query.sql).toContain("ORDER BY created_at DESC, id DESC LIMIT 1");
  });
  test("coalesces concurrent reads and separates project scopes", async () => {
    const c = context();
    await Promise.all([readResourceSummary(c.ctx, "p1"), readResourceSummary(c.ctx, "p1")]);
    expect(c.reads()).toBe(1);
    await readResourceSummary(c.ctx, "p2");
    expect(c.reads()).toBe(2);
  });
  test("no report is unknown, connector failures do not break other summary data", async () => {
    const empty = context({ source: false });
    expect((await getProjectToolSummaryHandler(empty.ctx)).data).toMatchObject({ resources: null });
    expect(empty.reads()).toBe(0);
    for (const options of [{ fail: true }, { truncated: true }, { content: "not a report" }]) {
      const c = context(options);
      const result = await getProjectToolSummaryHandler(c.ctx);
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ resources: null });
      expect((result.data as { resourcesError: string }).resourcesError).toBeTruthy();
      await readResourceSummary(c.ctx, "p1");
      expect(c.reads()).toBe(1);
    }
  });
});
