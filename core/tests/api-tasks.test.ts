/**
 * Synthia Core — Task proxy API integration tests (real PostgreSQL + fake Runtime)
 *
 * Exercises the Core↔Runtime task-workbench slice (UI-2) end to end against a
 * live database and a real Bun.serve API, with an in-process programmable fake
 * Runtime injected via `startSynthiaServer({ runtimeClient })`. Task truth lives
 * in the Runtime; Core only forwards + validates project ownership, so every
 * assertion observes either committed DB state (the lazily-provisioned process
 * instance / outbox event) or the forwarded/faked Runtime response.
 *
 * Coverage:
 *   - POST /projects/:id/tasks happy path: 201 { runId }; default process
 *     instance lazily created (pi-default:<projectId>); outbox event appended
 *   - explicit process_instance_id validated for ownership (not in project → 404)
 *   - GET /projects/:id/tasks list filtered to the project
 *   - GET /projects/:id/tasks/:runId happy path; cross-project run → 404
 *   - Runtime unreachable / timeout → 503 capability_unavailable (retryable)
 *   - Runtime 404 passthrough → not_found
 *   - idempotent replay (same Idempotency-Key) returns the same runId without
 *     re-contacting the Runtime; same key + different body → 409
 *   - Runtime not configured → 503 capability_unavailable
 *   - auth: missing scope (read-only token on POST) → 403
 *
 * Requires DATABASE_URL. When unset the whole suite is explicitly skipped —
 * skipped tests never count as passing (no fake green).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { applyMigrations } from "./support/approval-harness.ts";
import { bootstrapIdentities, truncateDomainTables, type BootstrapIdentities } from "./support/api-harness.ts";
import { startSynthiaServer, type SynthiaServer } from "../src/api/server.ts";
import {
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeCreateResponse,
  type RuntimeListResponse,
  type RuntimeRunDetail,
} from "../src/api/task-proxy.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// ─── fake runtime ────────────────────────────────────────────────────────────

interface StoredRun {
  runId: string;
  projectId: string;
  processInstanceId: string;
  task: string;
  part?: string;
  status: RuntimeRunDetail["status"];
  detail: RuntimeRunDetail;
}

/**
 * Programmable in-process Runtime. createTask/listTasks/getTask can be driven
 * per-test, including forced failures (createError / getError) and reachability
 * simulation (unreachable / timeoutMs).
 */
class FakeRuntimeClient implements RuntimeClient {
  private readonly runs = new Map<string, StoredRun>();
  /** Set to make the next createTask reject (e.g. → 503 / 404). */
  createError: RuntimeClientError | null = null;
  /** Set to make the next getTask reject. */
  getError: RuntimeClientError | null = null;
  /** When set, createTask rejects with a network-style 503 RuntimeClientError. */
  unreachable = false;
  createCount = 0;
  /** Captures the last forwarded createTask body. */
  lastCreate: { project_id: string; process_instance_id: string; task: string; part?: string } | null = null;

  reset(): void {
    this.runs.clear();
    this.createError = null;
    this.getError = null;
    this.unreachable = false;
    this.createCount = 0;
    this.lastCreate = null;
  }

  async createTask(body: {
    project_id: string;
    process_instance_id: string;
    task: string;
    part?: string;
  }): Promise<RuntimeCreateResponse> {
    this.createCount += 1;
    this.lastCreate = body;
    if (this.unreachable) throw new RuntimeClientError(503, "runtime unreachable", { retryable: true });
    if (this.createError) throw this.createError;
    const runId = `run-${randomUUID()}`;
    const detail: RuntimeRunDetail = {
      run_id: runId,
      project_id: body.project_id,
      status: "running",
      current_stage: "intake",
      docs: [
        { phase: "intake", path: "docs/intake.md", artifact_id: "art-intake", revision_id: `rev-${randomUUID()}` },
      ],
      audit: [{ ts: new Date().toISOString(), seq: 1, category: "lifecycle", action: "started", result: "ok" }],
    };
    this.runs.set(runId, {
      runId,
      projectId: body.project_id,
      processInstanceId: body.process_instance_id,
      task: body.task,
      part: body.part,
      status: "running",
      detail,
    });
    return { run_id: runId };
  }

  async listTasks(projectId: string): Promise<RuntimeListResponse> {
    const runs = [...this.runs.values()]
      .filter((r) => r.projectId === projectId)
      .map((r) => ({
        run_id: r.runId,
        project_id: r.projectId,
        status: r.status,
        current_stage: r.detail.current_stage,
        awaiting_gate: r.detail.awaiting_gate,
        created_at: "2026-01-01T00:00:00Z",
      }));
    return { runs };
  }

  async getTask(runId: string): Promise<RuntimeRunDetail> {
    if (this.getError) throw this.getError;
    const run = this.runs.get(runId);
    if (!run) throw new RuntimeClientError(404, `run not found: ${runId}`, { code: "RUN_NOT_FOUND", retryable: false });
    return run.detail;
  }

  /** Drive a run to a terminal state with optional reason (test helper). */
  setRun(runId: string, patch: Partial<RuntimeRunDetail>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.detail = { ...run.detail, ...patch };
    if (patch.status) run.status = patch.status;
  }

  /** Canned SSE body served by streamTask (per-test). */
  streamBody: string | null = null;
  /** When set, streamTask rejects (→ mapped error). */
  streamError: RuntimeClientError | null = null;

  async streamTask(_runId: string): Promise<Response> {
    if (this.streamError) throw this.streamError;
    if (this.streamBody === null) throw new RuntimeClientError(503, "runtime unreachable", { retryable: true });
    return new Response(this.streamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
}

// ─── harness ─────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)("task proxy API — real PostgreSQL + fake Runtime", () => {
  let client: Client;
  let pool: Pool;
  let server: SynthiaServer;
  let baseUrl: string;
  let ids: BootstrapIdentities;
  let fake: FakeRuntimeClient;

  beforeAll(async () => {
    const { Client: PgClient, Pool: PgPool } = await import("pg");
    client = new PgClient({ connectionString: DATABASE_URL }) as Client;
    await client.connect();
    await applyMigrations(client);
    ids = await bootstrapIdentities(client);
    await truncateDomainTables(client);
    pool = new PgPool({ connectionString: DATABASE_URL, max: 4 }) as unknown as Pool;
    fake = new FakeRuntimeClient();
    server = startSynthiaServer(pool, { port: 0, runtimeClient: fake });
    baseUrl = `http://${server.hostname}:${server.port}`;
  });

  afterAll(async () => {
    if (server) server.stop();
    if (pool) await pool.end();
    if (client) await client.end();
  });

  beforeEach(async () => {
    await truncateDomainTables(client);
    fake.reset();
  });

  // ─── helpers ────────────────────────────────────────────────────────────────

  async function callApi(path: string, opts: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined && opts.token !== null) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: response.status, json };
  }

  function envelopeData(json: unknown): Record<string, unknown> {
    const env = json as { data?: Record<string, unknown> };
    if (!env || typeof env !== "object" || !("data" in env)) throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
    return env.data!;
  }

  function envelopeError(json: unknown): { code: string; retryable: boolean; details: unknown; correlation_id: string; message: string } {
    const env = json as { error?: Record<string, unknown> };
    if (!env?.error) throw new Error(`missing error envelope: ${JSON.stringify(json)}`);
    return env.error as { code: string; retryable: boolean; details: unknown; correlation_id: string; message: string };
  }

  async function createProject(pid?: string): Promise<string> {
    const id = pid ?? `proj_${randomUUID()}`;
    await client.query("INSERT INTO project (id, name) VALUES ($1, $2)", [id, `Project ${id}`]);
    return id;
  }

  async function seedProcessInstance(projectId: string, pid?: string): Promise<string> {
    const id = pid ?? `pi_${randomUUID()}`;
    await client.query("INSERT INTO process_instance (id, project_id, gate_profile_version) VALUES ($1,$2,'flow-v1')", [id, projectId]);
    return id;
  }

  // ─── POST happy path ────────────────────────────────────────────────────────

  test("POST /tasks: 201 {runId}; lazily creates default process instance + outbox event", async () => {
    const projectId = await createProject();

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "设计一个 4 位加法器", part: "xc7vx690tffg1761-2" },
    });

    expect(status).toBe(201);
    const data = envelopeData(json);
    expect(typeof data.runId).toBe("string");
    expect((data.runId as string).startsWith("run-")).toBe(true);

    // Default process instance lazily provisioned (pi-default:<projectId>).
    const piRow = await client.query("SELECT id, gate_profile_version, current_gate FROM process_instance WHERE project_id = $1", [projectId]);
    expect(piRow.rows.length).toBe(1);
    const pi = piRow.rows[0] as Record<string, unknown>;
    expect(pi.id).toBe(`pi-default:${projectId}`);
    expect(pi.gate_profile_version).toBe("flow-v1");
    expect(pi.current_gate).toBe("G0");

    // The forwarded body injected project_id + process_instance_id.
    expect(fake.lastCreate).not.toBeNull();
    expect(fake.lastCreate!.project_id).toBe(projectId);
    expect(fake.lastCreate!.process_instance_id).toBe(`pi-default:${projectId}`);
    expect(fake.lastCreate!.task).toBe("设计一个 4 位加法器");
    expect(fake.lastCreate!.part).toBe("xc7vx690tffg1761-2");

    // Outbox event appended (observability).
    const outboxRow = await client.query("SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1", [data.runId]);
    expect(outboxRow.rows.length).toBe(1);
    expect((outboxRow.rows[0] as Record<string, unknown>).event_type).toBe("task.forwarded");
  });

  test("POST /tasks without part: forwards part=undefined", async () => {
    const projectId = await createProject();
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "只给 task 不给 part" },
    });
    expect(status).toBe(201);
    envelopeData(json);
    expect(fake.lastCreate!.part).toBeUndefined();
  });

  test("POST /tasks: reuses an existing process instance instead of creating pi-default", async () => {
    const projectId = await createProject();
    const existingPi = await seedProcessInstance(projectId);

    const { status } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "已有流程实例" },
    });
    expect(status).toBe(201);

    // The pre-existing instance is reused; no pi-default created.
    const piRow = await client.query("SELECT id FROM process_instance WHERE project_id = $1", [projectId]);
    expect(piRow.rows.length).toBe(1);
    expect((piRow.rows[0] as Record<string, unknown>).id).toBe(existingPi);
    expect(fake.lastCreate!.process_instance_id).toBe(existingPi);
  });

  test("POST /tasks: explicit process_instance_id not in project → 404", async () => {
    const projectId = await createProject();
    const otherProject = await createProject();
    const foreignPi = await seedProcessInstance(otherProject);

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "盗用别的项目的流程实例", process_instance_id: foreignPi },
    });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
    // Runtime never contacted.
    expect(fake.createCount).toBe(0);
  });

  test("POST /tasks: unknown project → 404 (no Runtime contact)", async () => {
    const { status, json } = await callApi(`/api/v1/projects/proj_does_not_exist/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "项目不存在" },
    });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
    expect(fake.createCount).toBe(0);
  });

  test("POST /tasks: missing task field → 400", async () => {
    const projectId = await createProject();
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { part: "xc7vx690tffg1761-2" },
    });
    expect(status).toBe(400);
    expect(envelopeError(json).code).toBe("validation");
  });

  test("POST /tasks: missing Idempotency-Key → 400", async () => {
    const projectId = await createProject();
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      body: { task: "缺幂等键" },
    });
    expect(status).toBe(400);
    expect(envelopeError(json).code).toBe("validation");
  });

  // ─── GET list / detail ───────────────────────────────────────────────────────

  test("GET /tasks: list filtered to project", async () => {
    const projectId = await createProject();
    const otherProject = await createProject();

    // Create a run in projectId.
    const create = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "项目 A 的任务" },
    });
    const runId = (envelopeData(create.json).runId as string);
    // Seed a run belonging to otherProject directly in the fake.
    await fake.createTask({ project_id: otherProject, process_instance_id: "pi-x", task: "项目 B 的任务" });

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, { token: ids.humanToken });
    expect(status).toBe(200);
    const data = envelopeData(json);
    expect(Array.isArray(data.runs)).toBe(true);
    expect((data.runs as unknown[]).length).toBe(1);
    const only = (data.runs as Record<string, unknown>[])[0]!;
    expect(only.run_id).toBe(runId);
    expect(only.project_id).toBe(projectId);
  });

  test("GET /tasks/:runId: detail with docs (artifact_id + revision_id passed through)", async () => {
    const projectId = await createProject();
    const create = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "查看详情" },
    });
    const runId = envelopeData(create.json).runId as string;

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${runId}`, { token: ids.humanToken });
    expect(status).toBe(200);
    const data = envelopeData(json);
    expect(data.run_id).toBe(runId);
    expect(data.project_id).toBe(projectId);
    expect(data.status).toBe("running");
    const docs = data.docs as Record<string, unknown>[];
    expect(docs.length).toBe(1);
    expect(typeof docs[0]!.artifact_id).toBe("string");
    expect(typeof docs[0]!.revision_id).toBe("string");
    expect(docs[0]!.path).toBe("docs/intake.md");
  });

  test("GET /tasks/:runId: cross-project run → 404 (project_id mismatch)", async () => {
    const projectId = await createProject();
    const otherProject = await createProject();
    // Create a run under otherProject.
    const create = await callApi(`/api/v1/projects/${otherProject}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "别的项目的 run" },
    });
    const runId = envelopeData(create.json).runId as string;

    // Ask for it under projectId → must not leak.
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${runId}`, { token: ids.humanToken });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
  });

  test("GET /tasks/:runId: Runtime reports unknown run → 404 passthrough", async () => {
    const projectId = await createProject();
    fake.getError = new RuntimeClientError(404, "run not found: ghost", { code: "RUN_NOT_FOUND", retryable: false });
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/run-ghost`, { token: ids.humanToken });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
  });

  test("failed run surfaces reason", async () => {
    const projectId = await createProject();
    const create = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "会失败的任务" },
    });
    const runId = envelopeData(create.json).runId as string;
    fake.setRun(runId, { status: "failed", reason: "simulate 阶段超时" });

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${runId}`, { token: ids.humanToken });
    expect(status).toBe(200);
    const data = envelopeData(json);
    expect(data.status).toBe("failed");
    expect(data.reason).toBe("simulate 阶段超时");
  });

  // ─── Runtime 503 / timeout mapping ────────────────────────────────────────────

  test("Runtime unreachable on POST → 503 capability_unavailable (retryable)", async () => {
    const projectId = await createProject();
    fake.unreachable = true;
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "Runtime 挂了" },
    });
    expect(status).toBe(503);
    const err = envelopeError(json);
    expect(err.code).toBe("capability_unavailable");
    expect(err.retryable).toBe(true);
  });

  test("Runtime 5xx on POST → 503 capability_unavailable (retryable)", async () => {
    const projectId = await createProject();
    fake.createError = new RuntimeClientError(502, "bad gateway", { retryable: true });
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "Runtime 5xx" },
    });
    expect(status).toBe(503);
    expect(envelopeError(json).code).toBe("capability_unavailable");
  });

  test("Runtime 503 on GET → 503 capability_unavailable", async () => {
    const projectId = await createProject();
    fake.getError = new RuntimeClientError(503, "runtime overloaded", { retryable: true });
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/run-any`, { token: ids.humanToken });
    expect(status).toBe(503);
    expect(envelopeError(json).code).toBe("capability_unavailable");
  });

  // ─── Runtime not configured ──────────────────────────────────────────────────

  test("Runtime not configured → 503 capability_unavailable", async () => {
    // A dedicated server whose default client factory yields undefined
    // (SYNTHIA_RUNTIME_URL="none" disables the Runtime). Task endpoints must
    // fail closed with 503 capability_unavailable.
    const projectId = await createProject();
    const prev = process.env.SYNTHIA_RUNTIME_URL;
    process.env.SYNTHIA_RUNTIME_URL = "none";
    const offline = startSynthiaServer(pool, { port: 0 });
    try {
      const response = await fetch(`http://${offline.hostname}:${offline.port}/api/v1/projects/${projectId}/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ids.humanToken}`,
          "idempotency-key": `idem-${randomUUID()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ task: "未配置 Runtime" }),
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect((body.error as Record<string, unknown>).code).toBe("capability_unavailable");
    } finally {
      offline.stop();
      if (prev === undefined) delete process.env.SYNTHIA_RUNTIME_URL;
      else process.env.SYNTHIA_RUNTIME_URL = prev;
    }
  });

  // ─── idempotency ──────────────────────────────────────────────────────────────

  test("idempotent replay returns same runId without re-contacting Runtime", async () => {
    const projectId = await createProject();
    const key = `idem-${randomUUID()}`;
    const body = { task: "幂等任务" };

    const first = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body,
    });
    expect(first.status).toBe(201);
    const firstRunId = envelopeData(first.json).runId as string;
    expect(fake.createCount).toBe(1);

    const second = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body,
    });
    expect(second.status).toBe(201);
    const secondRunId = envelopeData(second.json).runId as string;
    expect(secondRunId).toBe(firstRunId);
    // Runtime was NOT contacted again.
    expect(fake.createCount).toBe(1);
  });

  test("same key + different body → 409 conflict", async () => {
    const projectId = await createProject();
    const key = `idem-${randomUUID()}`;

    const first = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body: { task: "第一个任务" },
    });
    expect(first.status).toBe(201);

    const second = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body: { task: "不同的任务" },
    });
    expect(second.status).toBe(409);
    expect(envelopeError(second.json).code).toBe("conflict");
  });

  // ─── auth / scope ─────────────────────────────────────────────────────────────

  test("read-only token on POST → 403", async () => {
    const projectId = await createProject();
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.readOnlyToken, headers: { "idempotency-key": `idem-${randomUUID()}` }, body: { task: "无写权限" },
    });
    expect(status).toBe(403);
    expect(envelopeError(json).code).toBe("authorization");
  });

  test("service token (core:write + core:read) can POST", async () => {
    const projectId = await createProject();
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.serviceToken, headers: { "idempotency-key": `idem-${randomUUID()}` }, body: { task: "服务身份创建任务" },
    });
    expect(status).toBe(201);
    expect(typeof envelopeData(json).runId).toBe("string");
  });

  test("missing auth → 401", async () => {
    const projectId = await createProject();
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: null, headers: { "idempotency-key": `idem-${randomUUID()}` }, body: { task: "无 token" },
    });
    expect(status).toBe(401);
    expect(envelopeError(json).code).toBe("authorization");
  });

  // ─── SSE stream pass-through ────────────────────────────────────────────────

  test("GET .../tasks/:runId/stream passes Runtime SSE through verbatim (no envelope)", async () => {
    const projectId = await createProject();
    const { run_id: runId } = await fake.createTask({ project_id: projectId, process_instance_id: "pi-x", task: "sse" });
    fake.streamBody = [
      `event: status\nid: 1\ndata: {"status":"running","ts":"t1"}\n\n`,
      `event: part\nid: 2\ndata: {"part":{"kind":"text","id":"sp-1","state":"streaming","text":"","ts":"t2"}}\n\n`,
      `event: delta\nid: 3\ndata: {"partId":"sp-1","text":"你好"}\n\n`,
      `event: done\nid: 4\ndata: {"reply":"你好","status":"idle","ts":"t4"}\n\n`,
    ].join("");

    const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/tasks/${runId}/stream`, {
      headers: { authorization: `Bearer ${ids.humanToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    // Verbatim upstream bytes: no JSON envelope wrapping.
    expect(body).toBe(fake.streamBody);
  });

  test("stream cross-project run → 404 (ownership enforced before piping)", async () => {
    const projectIdA = await createProject();
    const projectIdB = await createProject();
    const { run_id: runId } = await fake.createTask({ project_id: projectIdA, process_instance_id: "pi-x", task: "sse" });
    fake.streamBody = "event: status\nid: 1\ndata: {}\n\n";
    const { status, json } = await callApi(`/api/v1/projects/${projectIdB}/tasks/${runId}/stream`, { token: ids.humanToken });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
  });

  test("stream Runtime unreachable → 503 capability_unavailable", async () => {
    const projectId = await createProject();
    const { run_id: runId } = await fake.createTask({ project_id: projectId, process_instance_id: "pi-x", task: "sse" });
    fake.streamError = new RuntimeClientError(503, "runtime unreachable", { retryable: true });
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${runId}/stream`, { token: ids.humanToken });
    expect(status).toBe(503);
    expect(envelopeError(json).code).toBe("capability_unavailable");
    expect(envelopeError(json).retryable).toBe(true);
  });

  test("stream unknown run → 404 passthrough", async () => {
    const projectId = await createProject();
    fake.streamBody = "";
    const { status } = await callApi(`/api/v1/projects/${projectId}/tasks/run-nope/stream`, { token: ids.humanToken });
    expect(status).toBe(404);
  });
});
