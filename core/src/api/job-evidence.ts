import type { RequestContext } from "./handlers.ts";
import { ConnectorError, type EvidenceContent, type EvidenceContentOptions, type EvidenceManifest } from "./connector-port.ts";

/** The owning Core row is the durable authority after the worker evicts a job. */
export async function readFrozenJobEvidence(ctx: Pick<RequestContext, "pool">, projectId: string, jobId: string): Promise<EvidenceManifest | null> {
  const result = await ctx.pool.query(
    `SELECT CASE WHEN m.id IS NOT NULL THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object('name',e.name,'sha256',e.sha256,
                'sizeBytes',e.size_bytes,'mediaType',e.media_type) ORDER BY e.name)
                FROM tool_run_evidence_entry e WHERE e.manifest_id=m.id
            ), '[]'::jsonb)
            WHEN jsonb_typeof(t.evidence)='array' THEN t.evidence
            ELSE t.evidence->'entries' END AS frozen_entries
       FROM tool_run t LEFT JOIN tool_run_evidence_manifest m
         ON m.tool_run_id=t.id AND m.project_id=t.project_id
      WHERE t.id=$1 AND t.project_id=$2
        AND t.state IN ('succeeded','failed','cancelled','timeout','lost','unknown_effect')`,
    [jobId, projectId],
  );
  const entries = result.rows[0]?.frozen_entries;
  return Array.isArray(entries) ? { jobId, entries } : null;
}

/** Never accept recovery metadata from the HTTP caller or mutate old job state. */
export async function fetchJobEvidenceContent(ctx: RequestContext, projectId: string, jobId: string, name: string, options?: EvidenceContentOptions): Promise<EvidenceContent> {
  const connector = ctx.connector;
  if (!connector) throw new ConnectorError("CONNECTOR_UNAVAILABLE", "connector not configured");
  try {
    return await connector.fetchEvidenceContent(projectId, jobId, name, options);
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "JOB_NOT_FOUND") throw error;
    const manifest = await readFrozenJobEvidence(ctx, projectId, jobId);
    const entry = manifest?.entries.find((candidate) => candidate.name === name);
    if (!entry) throw error;
    const archivedEntry = { name: entry.name, sha256: entry.sha256, sizeBytes: entry.sizeBytes, mediaType: entry.mediaType };
    const content = await connector.fetchEvidenceContent(projectId, jobId, name, { ...options, archivedEntry });
    if (content.name !== name || content.sha256 !== entry.sha256 || content.mediaType !== entry.mediaType
      || (content.sizeBytes !== undefined && content.sizeBytes !== entry.sizeBytes)) {
      throw new ConnectorError("EVIDENCE_CORRUPT", "archived evidence does not match the frozen manifest");
    }
    return content;
  }
}
