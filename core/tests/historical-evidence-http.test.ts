import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteConnectorClient, REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type RemoteTransport } from "../../connector/remote.ts";
import { WorkerRuntime } from "../../connector/worker.ts";
import { RemoteConnectorAdapter } from "../src/api/connector-adapter.ts";
import { sha256Hex } from "../src/hashing.ts";
import { apiCall, setupApiHarness, teardownApiHarness } from "./support/api-harness.ts";

test.skipIf(!process.env.DATABASE_URL)("Core HTTP -> remote adapter -> Worker HTTP reads evicted evidence from the owned frozen manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-history-http-"));
  const projectId = `history-${randomUUID()}`;
  const jobId = `job-${randomUUID()}`;
  const report = "Device : historical-part\n| Site Type | Used | Available | Util% |\n| Slice LUTs | 628 | 1000 | 62.8 |";
  const entry = { name: "resources.rpt", sha256: sha256Hex(report), sizeBytes: Buffer.byteLength(report), mediaType: "text/plain" };
  const endpoint: ConnectorEndpoint = {
    connector_id: "history-http", display_name: "history test", endpoint_url: "https://history-worker.test",
    protocol_version: REMOTE_SCHEMA_VERSION, transport_mode: "direct_https", auth_mode: "mtls",
    tls_trust_ref: "secret://test/trust", tls_client_cert_ref: "secret://test/client",
    project_scope: [projectId], data_classification_scope: ["internal"], allowed_capability_ids: ["implement"],
    toolchain_profile_hash: "profile", worker_labels: { test: "history" }, heartbeat_interval_seconds: 10,
    lease_seconds: 60, max_concurrency: 1, registration_state: "registering",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), audited_by: "test",
  };
  const worker = new WorkerRuntime({ endpoint, workspaceRoot: root, execution: {
    async discover() { return {
      connector_id: endpoint.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION,
      capability_map_version: "1", vivado_version: "test", vivado_patch: "test", part_catalog_hash: "test",
      sdk_worker_build_hash: "test", toolchain_profile_hash: endpoint.toolchain_profile_hash, license_status: "available",
      capabilities: [{ operation: "implement", version: "test", runClasses: ["exploratory"] }],
    }; },
    async execute() { throw new Error("reading historical evidence must never execute a job"); },
  } });
  const calls: { path: string; payload: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const envelope = await request.clone().json();
    calls.push({ path: new URL(request.url).pathname, payload: envelope.payload });
    return worker.handle(request);
  } });
  const transport: RemoteTransport = { async request(path, request) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: request.method, headers: { "content-type": "application/json" }, body: JSON.stringify(request.body),
    });
    return { status: response.status, body: await response.json() };
  } };
  const connector = new RemoteConnectorAdapter((options) => new RemoteConnectorClient({
    endpoint, transport, actor: options.actor, classification: "internal", projectId: options.projectId, allowlist: options.allowlist,
  }), endpoint as unknown as Record<string, unknown>, ["history-worker.test"], {});
  const harness = await setupApiHarness(process.env.DATABASE_URL!, { connector });
  try {
    await mkdir(join(root, jobId, "output"), { recursive: true });
    await writeFile(join(root, jobId, "output", entry.name), report);
    expect((await apiCall(harness.baseUrl, "/api/v1/projects", { method: "POST", token: harness.ids.humanToken,
      headers: { "idempotency-key": randomUUID() }, body: { id: projectId, name: "History", project_type: "free", target_part: "current-part" },
    })).status).toBe(201);
    await harness.client.query(`INSERT INTO tool_run(id,project_id,operation,run_class,state,correlation_id,evidence)
      VALUES($1,$2,'implement','exploratory','succeeded','history',$3::jsonb)`, [jobId, projectId, JSON.stringify({ entries: [entry] })]);
    const path = `/api/v1/projects/${projectId}/jobs/${jobId}/evidence/content?name=${entry.name}`;
    const read = await apiCall(harness.baseUrl, path, { token: harness.ids.humanToken });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ data: { content: report, sha256: entry.sha256, evidenceScope: "unattributed" } });
    const summary = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/tool-summary`, { token: harness.ids.humanToken });
    expect(summary.json).toMatchObject({ data: { resources: null, validationState: "pending",
      history: { runCount: 1, resources: { sourceJobId: jobId, device: "historical-part", metrics: [{ used: 628 }] } } } });
    expect(calls.filter((call) => call.path.endsWith("/content")).some((call) => JSON.stringify(call.payload.archived_entry) === JSON.stringify(entry))).toBeTrue();
    expect(calls.some((call) => call.path === "/jobs/submit")).toBeFalse();
    await writeFile(join(root, jobId, "output", entry.name), "tampered");
    expect((await apiCall(harness.baseUrl, path, { token: harness.ids.humanToken })).status).toBe(404);
  } finally {
    await teardownApiHarness(harness); server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
