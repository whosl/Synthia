import type { RequestContext } from "./handlers.ts";
import type { ConnectorPort } from "./connector-port.ts";
import { parseResourceUtilization, type ResourceUtilization } from "../services/resource-utilization.ts";

export interface ToolSummaryResources extends ResourceUtilization {
  readonly sourceJobId: string;
  readonly sourceOperation: "synthesize" | "implement" | "report_resources";
  readonly sourceAt: string;
  readonly reportName: string;
}

type Result = { resources: ToolSummaryResources | null; resourcesError?: string };
// Cache immutable evidence results, coalesce polls, and retry failures after 15 seconds.
// Bounded and per connector: no credentials or raw report bodies retained.
const caches = new WeakMap<ConnectorPort, Map<string, { expires: number; result: Promise<Result> }>>();

/** Caller must authorize project access before invoking this read. */
export async function readResourceSummary(ctx: RequestContext, projectId: string): Promise<Result> {
  const source = await ctx.pool.query(
    `SELECT id AS job_id, operation, COALESCE(end_time, created_at) AS at FROM tool_run
      WHERE project_id = $1 AND state = 'succeeded'
        AND operation IN ('synthesize', 'implement', 'report_resources')
        AND (evidence::jsonb->'entries' @> '[{"name":"resources.rpt"}]'::jsonb
          OR evidence::jsonb @> '[{"name":"resources.rpt"}]'::jsonb)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId],
  );
  const row = source.rows[0] as { job_id: string; operation: ToolSummaryResources["sourceOperation"]; at: Date } | undefined;
  if (!row) return { resources: null };
  const connector = ctx.connector;
  if (!connector) return { resources: null, resourcesError: "unavailable" };
  let cache = caches.get(connector);
  if (!cache) { cache = new Map(); caches.set(connector, cache); }
  const key = JSON.stringify([projectId, row.job_id]);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  const entry = { expires: Date.now() + 300_000, result: Promise.resolve<Result>({ resources: null }) };
  entry.result = (async (): Promise<Result> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const evidence = await Promise.race([
        connector.fetchEvidenceContent(projectId, row.job_id, "resources.rpt", { requireFull: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("resource report timeout")), 5_000); }),
      ]);
      if (evidence.truncated) return { resources: null, resourcesError: "truncated_report" };
      const parsed = parseResourceUtilization(evidence.content);
      if (!parsed.metrics.length) return { resources: null, resourcesError: "unrecognized_report" };
      return { resources: { ...parsed, sourceJobId: row.job_id, sourceOperation: row.operation, sourceAt: row.at.toISOString(), reportName: "resources.rpt" } };
    } catch {
      return { resources: null, resourcesError: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  })().then((result) => {
    entry.expires = Date.now() + (result.resources ? 300_000 : 15_000);
    return result;
  });
  cache.set(key, entry);
  return entry.result;
}
