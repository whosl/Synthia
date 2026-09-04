import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../core/src/hashing.ts";
import type { ConnectorCapability, EvidenceManifest, Job, JobRequest } from "./index.ts";
import { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_ENTRY_BYTES, MAX_EVIDENCE_TOTAL_BYTES, REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type ConnectorRegistration, type DataClassification, type DiscoverySnapshot, type RemoteEnvelope } from "./remote.ts";

export interface WorkerExecutionResult {
  outcome?: "success" | "failure" | "timeout" | "lost" | "unknown_effect";
  output?: string;
  evidence?: EvidenceManifest;
  error_code?: string;
  stdout?: string;
  stderr?: string;
}
export interface WorkerExecution { discover(): Promise<DiscoverySnapshot>; execute(request: JobRequest, workspace: string): Promise<WorkerExecutionResult>; }
export interface WorkerRuntimeOptions { endpoint: ConnectorEndpoint; workspaceRoot: string; execution?: WorkerExecution; now?: () => Date; }
const terminal = new Set<Job["state"]>(["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"]);
const idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const classes: readonly DataClassification[] = ["public", "internal", "confidential", "restricted"];
const MAX_CONTENT_BYTES = 256 * 1024;
const CONTENT_WINDOW_BYTES = 128 * 1024;
const evidenceNameRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const unavailableExecution: WorkerExecution = {
  async discover() { return { connector_id: "unavailable", connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: "none", vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: "unavailable", sdk_worker_build_hash: "unavailable", capabilities: [], toolchain_profile_hash: "unavailable", license_status: "unknown", unsupported: ["vivado_discovery", "vivado_execution"] }; },
  async execute() { return { outcome: "failure", error_code: "UNSUPPORTED_VIVADO" }; },
};
function good(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0; }
function responseError(code: string, message: string, status: number): Response { return Response.json({ error_code: code, message }, { status }); }
function copy<T>(v: T): T { return structuredClone(v); }

export class WorkerRuntime {
  private readonly endpoint: ConnectorEndpoint; private readonly root: string; private readonly execution: WorkerExecution; private readonly clock: () => Date;
  private registration?: ConnectorRegistration; private discovery?: DiscoverySnapshot; private active = 0; private leaseExpiresAt?: number;
  private readonly jobs = new Map<string, Job>(); private readonly jobBindings = new Map<string, { projectId: string; classification: DataClassification }>(); private readonly keys = new Map<string, { fingerprint: string; status: number; body: RemoteEnvelope<unknown> }>(); private readonly pending: string[] = [];
  /** H8: registry snapshot reload — resolves once the on-disk job registry
   *  (if any) has been merged; every request awaits it so post-restart
   *  queries cannot race the restore. */
  private readonly restorePromise: Promise<void>;
  constructor(o: WorkerRuntimeOptions) { this.endpoint = copy(o.endpoint); this.root = o.workspaceRoot; this.execution = o.execution ?? unavailableExecution; this.clock = o.now ?? (() => new Date()); if (!idRe.test(this.endpoint.connector_id) || this.endpoint.protocol_version !== REMOTE_SCHEMA_VERSION || this.endpoint.max_concurrency < 1) throw new Error("CONFIG_INVALID"); this.restorePromise = this.restoreRegistry(); }
  private registryPath(): string { return join(this.root, "jobs-registry.json"); }
  /** Persist the in-memory job registry so a worker restart does not orphan
   *  every historical job's evidence API (files stay on disk; the manifest
   *  only lived in memory). Non-terminal jobs at snapshot time are reloaded
   *  as "lost" — the process died mid-run, so their state is unknowable.
   *  Idempotency keys are deliberately NOT persisted: replay-after-restart
   *  is a stronger contract than the snapshot's recency. */
  /** Serialized last-writer-wins: concurrent snapshots (submit + terminal)
   *  must not let an older state overwrite a newer one on disk. */
  private snapshotChain: Promise<void> = Promise.resolve();
  private snapshotRegistry(): Promise<void> {
    this.snapshotChain = this.snapshotChain.then(() => this.writeSnapshot());
    return this.snapshotChain;
  }
  private async writeSnapshot(): Promise<void> {
    try {
      const snapshot = { schema: "synthia-worker-jobs-registry.v1", jobs: [...this.jobs.values()], bindings: [...this.jobBindings.entries()] };
      await mkdir(this.root, { recursive: true });
      await writeFile(this.registryPath(), JSON.stringify(snapshot), "utf8");
    } catch { /* best-effort persistence */ }
  }
  private async restoreRegistry(): Promise<void> { try { const raw = await readFile(this.registryPath(), "utf8"); const parsed = JSON.parse(raw) as { jobs?: unknown; bindings?: unknown }; if (!Array.isArray(parsed.jobs) || !Array.isArray(parsed.bindings)) return; for (const job of parsed.jobs) { if (!job || typeof job !== "object" || typeof (job as Job).id !== "string") continue; const restored = copy(job as Job); if (!terminal.has(restored.state)) restored.state = "lost"; this.jobs.set(restored.id, restored); } for (const [id, binding] of parsed.bindings) { if (typeof id === "string" && binding && typeof binding === "object" && typeof binding.projectId === "string") this.jobBindings.set(id, binding as { projectId: string; classification: DataClassification }); } } catch { /* missing/corrupt snapshot → fresh registry */ } }
  private discoveryReady(): boolean { return this.discovery?.license_status === "available" && this.discovery.capabilities.length > 0 && this.discovery.unsupported?.length === undefined; }
  private hasDrift(discovery: DiscoverySnapshot): boolean { return discovery.connector_protocol_version !== this.endpoint.protocol_version || discovery.toolchain_profile_hash !== this.endpoint.toolchain_profile_hash || (this.endpoint.expected_capability_map_version !== undefined && discovery.capability_map_version !== this.endpoint.expected_capability_map_version) || (this.endpoint.expected_part_catalog_hash !== undefined && discovery.part_catalog_hash !== this.endpoint.expected_part_catalog_hash) || (this.endpoint.expected_sdk_worker_build_hash !== undefined && discovery.sdk_worker_build_hash !== this.endpoint.expected_sdk_worker_build_hash) || discovery.license_status !== "available"; }

  async handle(request: Request): Promise<Response> {
    await this.restorePromise;
    if (request.method !== "POST") return responseError("METHOD_NOT_ALLOWED", "POST required", 405);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return responseError("UNSUPPORTED_MEDIA_TYPE", "application/json required", 415);
    let e: RemoteEnvelope<unknown>; try { e = await request.json() as RemoteEnvelope<unknown>; } catch { return responseError("INVALID_JSON", "request body must be JSON", 400); }
    const invalid = this.validateEnvelope(e); if (invalid) return invalid;
    const fingerprint = sha256(JSON.stringify({ ...e, correlation_id: undefined }));
    const key = `${e.project_id}:${e.classification}:${e.actor.actor_type}:${e.actor.actor_id}:${e.idempotency_key}`;
    const prior = this.keys.get(key); if (prior) return prior.fingerprint === fingerprint ? Response.json(prior.body, { status: prior.status }) : responseError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", 409);
    try { const out = await this.route(new URL(request.url).pathname, e); this.keys.set(key, { fingerprint, status: out.status, body: out.body }); return this.ok(out.body, out.status); }
    catch (cause) { const code = cause instanceof Error ? cause.message : "WORKER_ERROR"; const status = code === "JOB_NOT_FOUND" || code === "EVIDENCE_NOT_AVAILABLE" || code === "NOT_FOUND" ? 404 : code === "EVIDENCE_CORRUPT" ? 422 : code === "EVIDENCE_LIMIT_EXCEEDED" ? 413 : code === "UNSUPPORTED_VIVADO" ? 501 : code === "IDEMPOTENCY_CONFLICT" ? 409 : code === "PROJECT_NOT_ALLOWED" || code === "CLASSIFICATION_NOT_ALLOWED" ? 403 : 400; return responseError(code, code, status); }
  }

  private validateEnvelope(v: unknown): Response | undefined { if (!v || typeof v !== "object") return responseError("INVALID_ENVELOPE", "object required", 400); const e = v as Partial<RemoteEnvelope<unknown>>; if (e.schema_version !== REMOTE_SCHEMA_VERSION) return responseError("UNSUPPORTED_PROTOCOL", "connector.remote.v1 required", 400); if (!good(e.correlation_id) || !good(e.idempotency_key) || !good(e.project_id) || !good(e.capability_version)) return responseError("INVALID_ENVELOPE", "required envelope fields are missing", 400); if (!e.actor || (e.actor.actor_type !== "user" && e.actor.actor_type !== "service") || !good(e.actor.actor_id)) return responseError("INVALID_ENVELOPE", "actor is invalid", 400); if (!classes.includes(e.classification as DataClassification)) return responseError("INVALID_ENVELOPE", "classification is invalid", 400); if (!this.endpoint.project_scope.includes(e.project_id)) return responseError("PROJECT_NOT_ALLOWED", "PROJECT_NOT_ALLOWED", 403); if (!this.endpoint.data_classification_scope.includes(e.classification as DataClassification)) return responseError("CLASSIFICATION_NOT_ALLOWED", "CLASSIFICATION_NOT_ALLOWED", 403); return undefined; }
  private async route(path: string, e: RemoteEnvelope<unknown>): Promise<{ status: number; body: RemoteEnvelope<unknown> }> {
    const p = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload as Record<string, any> : {};
    if (path === "/registration") { if (this.endpoint.registration_state === "revoked") throw new Error("ENDPOINT_REVOKED"); this.registration = { ...copy(this.endpoint), registration_state: "approved" }; return { status: 200, body: this.envelope(e, this.registration) }; }
    if (path === "/discover") { this.discovery = await this.execution.discover(); return { status: 200, body: this.envelope(e, this.discovery) }; }
    if (path === "/heartbeat") { if (!this.registration) throw new Error("NOT_REGISTERED"); if (this.endpoint.registration_state === "revoked") throw new Error("ENDPOINT_REVOKED"); if (!this.discovery) this.discovery = await this.execution.discover(); const now = this.clock(); const drift = this.hasDrift(this.discovery); const ready = this.discoveryReady() && !drift; this.leaseExpiresAt = now.getTime() + this.endpoint.lease_seconds * 1000; this.registration = { ...this.registration, registration_state: ready ? "ready" : "degraded", discovered: copy(this.discovery), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(this.leaseExpiresAt).toISOString(), capability_drift: drift }; return { status: 200, body: this.envelope(e, this.registration) }; }
    if (path === "/jobs/submit") { if (this.leaseExpiresAt !== undefined && this.clock().getTime() >= this.leaseExpiresAt) { this.registration = this.registration ? { ...this.registration, registration_state: "offline" } : this.registration; throw new Error("LEASE_EXPIRED"); } return this.submit(e, p.request as JobRequest, p.approval as Record<string, unknown> | undefined); }
    const jobId = p.job_id; if (!good(jobId)) throw new Error("INVALID_JOB_ID"); const job = this.jobs.get(jobId); const binding = this.jobBindings.get(jobId); if (!job || !binding || binding.projectId !== e.project_id || binding.classification !== e.classification) throw new Error("JOB_NOT_FOUND");
    if (path === "/jobs/status") return { status: 200, body: this.envelope(e, copy(job)) };
    if (path === "/jobs/cancel") { if (!terminal.has(job.state)) { job.state = "cancelled"; void this.snapshotRegistry(); } return { status: 200, body: this.envelope(e, copy(job)) }; }
    if (path === "/jobs/evidence") { if (!job.evidence) throw new Error("EVIDENCE_NOT_AVAILABLE"); this.assertEvidenceLimits(job.evidence); return { status: 200, body: this.envelope(e, copy(job.evidence)) }; }
    if (path === "/jobs/evidence/content") { const name = p.name; if (typeof name !== "string" || !evidenceNameRe.test(name)) throw new Error("EVIDENCE_NOT_AVAILABLE"); return this.evidenceContent(e, job, name, p.complete === true); }
    throw new Error("NOT_FOUND");
  }
  private submit(e: RemoteEnvelope<unknown>, request: JobRequest, approval?: Record<string, unknown>): { status: number; body: RemoteEnvelope<unknown> } { const capability = this.discovery?.capabilities.find(c => c.operation === request?.operation); if (!this.registration || this.registration.registration_state !== "ready" || this.registration.capability_drift === true) throw new Error("ENDPOINT_NOT_APPROVED"); if (!request || request.projectId !== e.project_id || !good(request.idempotencyKey) || !good(request.operation) || !good(request.input) || !good(request.correlationId)) throw new Error("INVALID_JOB_REQUEST"); if (!this.endpoint.allowed_capability_ids.includes(request.operation) || !capability || capability.version !== e.capability_version || !capability.runClasses.includes(request.runClass)) throw new Error("CAPABILITY_UNAVAILABLE"); if (request.runClass === "gate_check" && !good(approval?.gateSubmissionId)) throw new Error("GATE_SUBMISSION_REQUIRED"); if (request.runClass === "formal" && (approval?.inputApproved !== true || (!good(approval?.baselineId) && !good(approval?.approvedGateResultId)))) throw new Error("FORMAL_GATE_REQUIRED"); if (request.runClass === "formal" && request.input.startsWith("candidate:")) throw new Error("CANDIDATE_FORMAL_REJECTED"); const jobId = request.jobId ?? `job-${crypto.randomUUID()}`; if (!idRe.test(jobId)) throw new Error("INVALID_JOB_ID"); const fingerprint = sha256(JSON.stringify(request)); const old = this.jobs.get(jobId); if (old) { const binding = this.jobBindings.get(jobId); if (!binding || binding.projectId !== e.project_id || binding.classification !== e.classification) throw new Error("JOB_NOT_FOUND"); if (sha256(JSON.stringify(old.request)) !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT"); return { status: 200, body: this.envelope(e, copy(old)) }; } const job: Job = { id: jobId, request: { ...request, jobId }, state: "submitted", inputSha256: sha256(request.input) }; this.jobs.set(jobId, job); this.jobBindings.set(jobId, { projectId: e.project_id, classification: e.classification }); this.pending.push(jobId); void this.snapshotRegistry(); void this.pump(); return { status: 202, body: this.envelope(e, copy(job)) }; }
  private async pump(): Promise<void> { while (this.active < this.endpoint.max_concurrency && this.pending.length) { const jobId = this.pending.shift()!; const job = this.jobs.get(jobId); if (!job || terminal.has(job.state)) continue; this.active++; void this.run(job).finally(() => { this.active--; void this.pump(); }); } }
  private async run(job: Job): Promise<void> {
    const workspace = join(this.root, job.id);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "request-input.txt"), job.request.input, "utf8");
      job.state = "preparing";
      job.state = "running";
      const result = await this.execution.execute(copy(job.request), workspace);
      if (this.jobs.get(job.id)?.state === "cancelled") return;
      job.state = result.outcome === "success" ? "succeeded" : result.outcome === "timeout" ? "timeout" : result.outcome === "lost" ? "lost" : result.outcome === "unknown_effect" ? "unknown_effect" : "failed";
      if (result.error_code) job.errorCode = result.error_code;
      if (result.output !== undefined) {
        job.outputSha256 = sha256(result.output);
        const outputPath = join(workspace, "output", "worker-result.json");
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(outputPath, result.output, "utf8");
        const outputEntry = { name: "worker-result.json", uri: `workspace://${job.id}/output/worker-result.json`, sha256: job.outputSha256, sizeBytes: new TextEncoder().encode(result.output).byteLength, mediaType: "application/json" };
        job.evidence = { jobId: job.id, entries: [...(result.evidence?.entries ?? []), outputEntry] };
      } else if (result.evidence) job.evidence = result.evidence;
      // Terminal transitions persist before run() settles — a crash right
      // after completion must not reload the job as non-terminal/lost.
      await this.snapshotRegistry();
    } catch {
      if (this.jobs.get(job.id)?.state === "cancelled") return;
      job.state = "failed";
      if (!job.errorCode) job.errorCode = "WORKER_EXECUTION_ERROR";
    }
  }
  private async evidenceContent(e: RemoteEnvelope<unknown>, job: Job, name: string, complete = false): Promise<{ status: number; body: RemoteEnvelope<unknown> }> {
    if (!job.evidence) throw new Error("EVIDENCE_NOT_AVAILABLE");
    this.assertEvidenceLimits(job.evidence);
    const entry = job.evidence.entries.find(x => x.name === name);
    if (!entry) throw new Error("EVIDENCE_NOT_AVAILABLE");
    const filePath = join(this.root, job.id, "output", name);
    let buf: Buffer;
    try { const details = await stat(filePath); if (details.size > MAX_EVIDENCE_ENTRY_BYTES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); if (!details.isFile() || details.size !== entry.sizeBytes) throw new Error("EVIDENCE_CORRUPT"); buf = await readFile(filePath) as Buffer; } catch (error) { if (error instanceof Error && error.message === "EVIDENCE_LIMIT_EXCEEDED") throw error; throw new Error("EVIDENCE_CORRUPT"); }
    if (sha256(buf) !== entry.sha256) throw new Error("EVIDENCE_CORRUPT");
    let contentBytes: Uint8Array = buf;
    let truncated = false;
    if (!complete && buf.byteLength > MAX_CONTENT_BYTES) {
      truncated = true;
      const omitted = buf.byteLength - CONTENT_WINDOW_BYTES * 2;
      contentBytes = Buffer.concat([buf.subarray(0, CONTENT_WINDOW_BYTES), Buffer.from(`\n…[${omitted} bytes omitted]…\n`, "utf8"), buf.subarray(buf.byteLength - CONTENT_WINDOW_BYTES)]);
    }
    return { status: 200, body: this.envelope(e, { name: entry.name, sha256: entry.sha256, sizeBytes: buf.byteLength, mediaType: entry.mediaType, content_base64: Buffer.from(contentBytes).toString("base64"), truncated }) };
  }
  private assertEvidenceLimits(manifest: EvidenceManifest): void { if (manifest.entries.length > MAX_EVIDENCE_ENTRIES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); let total = 0; for (const entry of manifest.entries) { if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_EVIDENCE_ENTRY_BYTES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); total += entry.sizeBytes; if (!Number.isSafeInteger(total) || total > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("EVIDENCE_LIMIT_EXCEEDED"); } }
  private envelope<T>(e: RemoteEnvelope<unknown>, payload: T): RemoteEnvelope<T> { return { schema_version: REMOTE_SCHEMA_VERSION, correlation_id: e.correlation_id, causation_id: e.correlation_id, idempotency_key: e.idempotency_key, actor: e.actor, project_id: e.project_id, classification: e.classification, capability_version: e.capability_version, payload }; }
  private jobIdFrom(v: unknown): string { return v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : "worker"; }
  private ok<T>(body: RemoteEnvelope<T>, status: number): Response { return Response.json(body, { status }); }
}
export function createWorkerHandler(options: WorkerRuntimeOptions): (request: Request) => Promise<Response> { const runtime = new WorkerRuntime(options); return runtime.handle.bind(runtime); }
