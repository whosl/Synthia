import type { ToolRunState } from "../core/src/domain/enums.ts";
import { sha256, stableId } from "../core/src/hashing.ts";

export type JobOutcome = "success" | "failure" | "cancel" | "timeout" | "lost" | "unknown_effect";
export interface ConnectorCapability { operation: string; version: string; runClasses: readonly string[]; }
export interface JobRequest { jobId?: string; idempotencyKey: string; projectId: string; operation: string; runClass: "exploratory" | "gate_check" | "formal"; input: string; correlationId: string; outcome?: JobOutcome; }
export interface Job { id: string; request: JobRequest; state: ToolRunState; inputSha256: string; outputSha256?: string; evidence?: EvidenceManifest; }
export interface EvidenceManifest { jobId: string; entries: { name: string; sha256: string; sizeBytes: number; mediaType: string }[]; }
const states: Record<JobOutcome, ToolRunState> = { success: "succeeded", failure: "failed", cancel: "cancelled", timeout: "timeout", lost: "lost", unknown_effect: "unknown_effect" };
export class FakeConnector {
  private jobs = new Map<string, Job>();
  discover(): ConnectorCapability[] { return [{ operation: "vivado_synthesize", version: "fake-1", runClasses: ["exploratory", "gate_check", "formal"] }, { operation: "vivado_validate_sources", version: "fake-1", runClasses: ["exploratory", "gate_check"] }]; }
  async submit(request: JobRequest): Promise<Job> { const id = request.jobId ?? stableId("job"); const existing = this.jobs.get(id); if (existing) return structuredClone(existing); const job: Job = { id, request: { ...request, jobId: id }, state: "queued", inputSha256: sha256(request.input) }; this.jobs.set(id, job); await Promise.resolve(); job.state = "preparing"; if (request.outcome) job.state = states[request.outcome]; else job.state = "succeeded"; if (job.state === "succeeded") { const output = `fake-output:${id}`; job.outputSha256 = sha256(output); job.evidence = { jobId: id, entries: [{ name: "result.txt", sha256: job.outputSha256, sizeBytes: output.length, mediaType: "text/plain" }] }; } return structuredClone(job); }
  status(id: string): Job { const job = this.jobs.get(id); if (!job) throw new Error("JOB_NOT_FOUND"); return structuredClone(job); }
  cancel(id: string): Job { const job = this.jobs.get(id); if (!job) throw new Error("JOB_NOT_FOUND"); if (["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"].includes(job.state)) return structuredClone(job); job.state = "cancelled"; return structuredClone(job); }
  evidence(id: string): EvidenceManifest { const job = this.status(id); if (!job.evidence) throw new Error("EVIDENCE_NOT_AVAILABLE"); return structuredClone(job.evidence); }
}
export class McpConnectorFacade { constructor(private readonly connector: FakeConnector) {} discover() { return this.connector.discover(); } submit(request: JobRequest) { return this.connector.submit(request); } status(id: string) { return this.connector.status(id); } cancel(id: string) { return this.connector.cancel(id); } evidence(id: string) { return this.connector.evidence(id); } proposeTcl(proposal: { commands: readonly string[]; purpose: string }): never { if (!proposal.commands.length || proposal.commands.some(c => /(^|\s)(exec|open_project|write_bitstream|program_hw|source)\b/i.test(c))) throw new Error("TCL_POLICY_REJECTED"); throw new Error("TCL_PROPOSAL_REQUIRES_REVIEW"); } }
export * from "./vivado.ts";
export * from "./remote.ts";
export * from "./worker.ts";
