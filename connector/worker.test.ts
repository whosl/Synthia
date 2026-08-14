import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../core/src/hashing.ts";
import { REMOTE_SCHEMA_VERSION, type ConnectorEndpoint } from "./remote.ts";
import { type WorkerExecution, type WorkerExecutionResult, WorkerRuntime } from "./worker.ts";
import type { DiscoverySnapshot, JobRequest } from "./index.ts";

const endpoint: ConnectorEndpoint = { connector_id: "worker-test", display_name: "test", endpoint_url: "https://worker.test:8443", protocol_version: REMOTE_SCHEMA_VERSION, transport_mode: "direct_https", auth_mode: "mtls", tls_trust_ref: "secret://trust/1", tls_client_cert_ref: "secret://cert/1", project_scope: ["p1"], data_classification_scope: ["internal"], allowed_capability_ids: ["vivado_synthesize"], toolchain_profile_hash: "profile-a", worker_labels: { env: "test" }, heartbeat_interval_seconds: 10, lease_seconds: 30, max_concurrency: 2, registration_state: "registering", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", audited_by: "svc" };

const discovery: DiscoverySnapshot = { connector_id: "worker-test", connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: "1", vivado_version: "2025.1", vivado_patch: "p", part_catalog_hash: "x", sdk_worker_build_hash: "b", capabilities: [{ operation: "vivado_synthesize", version: "fake-1", runClasses: ["exploratory"] }], toolchain_profile_hash: "profile-a", license_status: "available" };

interface WorkerReply { readonly status: number; readonly payload: unknown; readonly errorCode?: string }
interface ContentReply { readonly name: string; readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string; readonly content_base64: string; readonly truncated: boolean }

let seq = 0;
async function post(rt: WorkerRuntime, path: string, payload: unknown, cap = "0"): Promise<WorkerReply> {
  const envelope = { schema_version: REMOTE_SCHEMA_VERSION, correlation_id: `c-${++seq}`, idempotency_key: `k-${path}-${seq}`, actor: { actor_type: "service", actor_id: "core" }, project_id: "p1", classification: "internal", capability_version: cap, payload };
  const res = await rt.handle(new Request(`https://worker.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }));
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, payload: "payload" in json ? (json as { payload: unknown }).payload : undefined, errorCode: typeof json.error_code === "string" ? json.error_code : undefined };
}

// The Worker runs each job on a detached pump (void this.pump()), so observing
// completion requires letting the event loop process the job's async I/O. This
// yields one turn with no duration — deterministic, not a wall-clock timer.
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

async function waitForEvidence(rt: WorkerRuntime, jobId: string): Promise<void> {
  // /jobs/evidence returns 200 only once run() has sealed job.evidence — which
  // for the worker-result.json path happens AFTER the terminal state is set
  // (mkdir + writeFile sit between). Polling the manifest, not the state,
  // avoids observing a terminal job whose evidence is still being written.
  for (let i = 0; i < 1000; i++) {
    const res = await post(rt, "/jobs/evidence", { job_id: jobId });
    if (res.status === 200) return;
    await tick();
  }
  throw new Error(`evidence for ${jobId} was not sealed`);
}

function runtime(root: string, execute: (request: JobRequest, workspace: string) => Promise<WorkerExecutionResult>): WorkerRuntime {
  const execution: WorkerExecution = { async discover() { return discovery; }, execute };
  return new WorkerRuntime({ endpoint, workspaceRoot: root, execution });
}

async function prime(rt: WorkerRuntime): Promise<void> {
  await post(rt, "/registration", {});
  await post(rt, "/heartbeat", { connector_id: endpoint.connector_id });
}

async function submitJob(rt: WorkerRuntime, jobId: string): Promise<void> {
  const request: JobRequest = { jobId, idempotencyKey: `jk-${jobId}`, projectId: "p1", operation: "vivado_synthesize", runClass: "exploratory", input: "manifest-sha", correlationId: `corr-${jobId}` };
  const submitted = await post(rt, "/jobs/submit", { request }, "fake-1");
  if (submitted.status !== 202) throw new Error(`submit failed: ${submitted.status} ${submitted.errorCode ?? ""}`);
  await waitForEvidence(rt, jobId);
}

describe("worker evidence content endpoint", () => {
  test("returns base64 content that decodes to the artifact and matches the manifest sha256", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-worker-"));
    try {
      const output = JSON.stringify({ stdout: "synth done\n", stderr: "", exitCode: 0, phase: "synthesize" });
      const rt = runtime(root, async () => ({ outcome: "success", output }));
      await prime(rt);
      await submitJob(rt, "job-ok");
      const res = await post(rt, "/jobs/evidence/content", { job_id: "job-ok", name: "worker-result.json" });
      expect(res.status).toBe(200);
      const p = res.payload as ContentReply;
      expect(p.name).toBe("worker-result.json");
      expect(p.sha256).toBe(sha256(output));
      expect(p.sizeBytes).toBe(Buffer.byteLength(output));
      expect(p.mediaType).toBe("application/json");
      expect(p.truncated).toBe(false);
      expect(Buffer.from(p.content_base64, "base64").toString("utf8")).toBe(output);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("404 EVIDENCE_NOT_AVAILABLE when name is not in the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-worker-"));
    try {
      const rt = runtime(root, async () => ({ outcome: "success", output: "{}" }));
      await prime(rt);
      await submitJob(rt, "job-missing");
      const res = await post(rt, "/jobs/evidence/content", { job_id: "job-missing", name: "ghost.txt" });
      expect(res.status).toBe(404);
      expect(res.errorCode).toBe("EVIDENCE_NOT_AVAILABLE");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("404 EVIDENCE_NOT_AVAILABLE rejects path-traversal and separator names before lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-worker-"));
    try {
      const rt = runtime(root, async () => ({ outcome: "success", output: "{}" }));
      await prime(rt);
      await submitJob(rt, "job-traversal");
      for (const name of ["../etc/passwd", "a/b.txt", "a\\b.txt", ".hidden"]) {
        const res = await post(rt, "/jobs/evidence/content", { job_id: "job-traversal", name });
        expect(res.status).toBe(404);
        expect(res.errorCode).toBe("EVIDENCE_NOT_AVAILABLE");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("truncates content over 256KB to head 128KB + omitted marker + tail 128KB", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-worker-"));
    try {
      const content = "x".repeat(300000); // 300KB > 256KB limit
      const rt = runtime(root, async (request, workspace) => {
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(join(workspace, "output", "big.log"), content);
        return { outcome: "success", evidence: { jobId: request.jobId!, entries: [{ name: "big.log", sha256: sha256(content), sizeBytes: Buffer.byteLength(content), mediaType: "text/plain" }] } };
      });
      await prime(rt);
      await submitJob(rt, "job-big");
      const res = await post(rt, "/jobs/evidence/content", { job_id: "job-big", name: "big.log" });
      expect(res.status).toBe(200);
      const p = res.payload as ContentReply;
      expect(p.truncated).toBe(true);
      expect(p.sizeBytes).toBe(300000);
      expect(p.sha256).toBe(sha256(content));
      const decoded = Buffer.from(p.content_base64, "base64").toString("utf8");
      const marker = `\n…[${300000 - 128 * 1024 * 2} bytes omitted]…\n`;
      expect(decoded.length).toBe(128 * 1024 + marker.length + 128 * 1024);
      expect(decoded.startsWith("x".repeat(128 * 1024))).toBe(true);
      expect(decoded.endsWith("x".repeat(128 * 1024))).toBe(true);
      expect(decoded).toContain("37856 bytes omitted");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("422 EVIDENCE_CORRUPT when on-disk content no longer matches the manifest sha256", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-worker-"));
    try {
      const original = "hello world";
      const rt = runtime(root, async (request, workspace) => {
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(join(workspace, "output", "note.txt"), original);
        return { outcome: "success", evidence: { jobId: request.jobId!, entries: [{ name: "note.txt", sha256: sha256(original), sizeBytes: Buffer.byteLength(original), mediaType: "text/plain" }] } };
      });
      await prime(rt);
      await submitJob(rt, "job-corrupt");
      // tamper the artifact on disk after the manifest was sealed
      await writeFile(join(root, "job-corrupt", "output", "note.txt"), "tampered!!");
      const res = await post(rt, "/jobs/evidence/content", { job_id: "job-corrupt", name: "note.txt" });
      expect(res.status).toBe(422);
      expect(res.errorCode).toBe("EVIDENCE_CORRUPT");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("under-limit content (exactly 256KB) is not truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-worker-"));
    try {
      const content = "y".repeat(256 * 1024); // exactly the limit
      const rt = runtime(root, async (request, workspace) => {
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(join(workspace, "output", "edge.log"), content);
        return { outcome: "success", evidence: { jobId: request.jobId!, entries: [{ name: "edge.log", sha256: sha256(content), sizeBytes: 256 * 1024, mediaType: "text/plain" }] } };
      });
      await prime(rt);
      await submitJob(rt, "job-edge");
      const res = await post(rt, "/jobs/evidence/content", { job_id: "job-edge", name: "edge.log" });
      expect(res.status).toBe(200);
      const p = res.payload as ContentReply;
      expect(p.truncated).toBe(false);
      expect(Buffer.from(p.content_base64, "base64").toString("utf8")).toBe(content);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
