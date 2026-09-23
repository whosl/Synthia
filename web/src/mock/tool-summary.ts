import type { TaskAgentDetail, ToolSummary, ToolSummaryStage } from "../api/types.ts";
import { buildRecordJobs } from "../domain/records.ts";

/** Summarize only evidence already visible in mock task records. */
export function mockToolSummary(projectId: string, details: readonly TaskAgentDetail[]): ToolSummary {
  const jobs = [...new Map(details.flatMap(buildRecordJobs).map((job) => [job.jobId, job])).values()]
    .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  const operations: ToolSummaryStage["operation"][] = ["validate_sources", "simulate", "synthesize", "implement", "report_sta"];
  const bitstream = jobs.find((job) => job.operation === "implement" && job.ok && job.entries.some((entry) => entry.name === "synthia.bit"));
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    stages: operations.map((operation) => {
      const matches = jobs.filter((job) => job.operation === operation);
      return {
        operation,
        state: matches[0]?.status ?? "never",
        lastJobId: matches[0]?.jobId ?? null,
        lastAt: matches[0]?.ts ?? null,
        succeeded: matches.filter((job) => job.ok).length,
        failed: matches.filter((job) => ["failed", "timeout", "lost", "unknown_effect"].includes(job.status)).length,
      };
    }),
    bitstream: { generated: !!bitstream, jobId: bitstream?.jobId ?? null, at: bitstream?.ts ?? null },
    // The mock evidence endpoint does not retain raw sta.rpt bytes.
    timing: null,
  };
}
