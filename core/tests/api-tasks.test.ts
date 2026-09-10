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
 *   - POST /projects/:id/tasks happy path: 201 { agentId }; default process
 *     instance lazily created (pi-default:<projectId>); outbox event appended
 *   - explicit process_instance_id validated for ownership (not in project → 404)
 *   - GET /projects/:id/tasks list filtered to the project
 *   - GET /projects/:id/tasks/:agentId happy path; cross-project agent → 404
 *   - Runtime unreachable / timeout → 503 capability_unavailable (retryable)
 *   - Runtime 404 passthrough → not_found
 *   - idempotent replay (same Idempotency-Key) returns the same agentId without
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
  type RuntimeAgentDetail,
} from "../src/api/task-proxy.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// ─── fake runtime ────────────────────────────────────────────────────────────

interface StoredAgent {
  agentId: string;
  projectId: string;
  processInstanceId?: string;
  task: string;
  part?: string;
  status: RuntimeAgentDetail["status"];
  detail: RuntimeAgentDetail;
}

/**
 * Programmable in-process Runtime. createTask/listTasks/getTask can be driven
 * per-test, including forced failures (createError / getError) and reachability
 * simulation (unreachable / timeoutMs).
 */
class FakeRuntimeClient implements RuntimeClient {
  private readonly agents = new Map<string, StoredAgent>();
  /** Set to make the next createTask reject (e.g. → 503 / 404). */
  createError: RuntimeClientError | null = null;
  /** Set to make the next getTask reject. */
  getError: RuntimeClientError | null = null;
  /** When set, createTask rejects with a network-style 503 RuntimeClientError. */
  unreachable = false;
  createCount = 0;
  /** Captures the last forwarded createTask body. */
  lastCreate: {
    project_id: string;
    process_instance_id?: string;
    task: string;
    part?: string;
    mode?: "agent";
    project_type?: string;
    process_version_id?: string | null;
    process_profile_id?: string | null;
    process_profile_name?: string | null;
    process_profile_version?: string | null;
    input_hash?: string;
  } | null = null;

  reset(): void {
    this.agents.clear();
    this.createError = null;
    this.getError = null;
    this.unreachable = false;
    this.createCount = 0;
    this.lastCreate = null;
  }

  async createTask(body: {
    project_id: string;
    process_instance_id?: string;
    task: string;
    part?: string;
    mode?: "agent";
    project_type?: string;
    process_version_id?: string | null;
    process_profile_id?: string | null;
    process_profile_name?: string | null;
    process_profile_version?: string | null;
    input_hash?: string;
  }): Promise<RuntimeCreateResponse> {
    this.createCount += 1;
    this.lastCreate = body;
    if (this.unreachable) throw new RuntimeClientError(503, "runtime unreachable", { retryable: true });
    if (this.createError) throw this.createError;
    const agentId = `agent-${randomUUID()}`;
    const detail: RuntimeAgentDetail = {
      agent_id: agentId,
      project_id: body.project_id,
      kind: "main",
      status: "running",
      current_stage: "intake",
      docs: [
        { phase: "intake", path: "docs/intake.md", artifact_id: "art-intake", revision_id: `rev-${randomUUID()}` },
      ],
      audit: [{ ts: new Date().toISOString(), seq: 1, category: "lifecycle", action: "started", result: "ok" }],
    };
    this.agents.set(agentId, {
      agentId,
      projectId: body.project_id,
      processInstanceId: body.process_instance_id,
      task: body.task,
      part: body.part,
      status: "running",
      detail,
    });
    return { agent_id: agentId };
  }

  async startTask(agentId: string): Promise<{ started: boolean; status: "running" }> {
    const run = this.agents.get(agentId);
    if (!run) {
      throw new RuntimeClientError(404, `agent not found: ${agentId}`, {
        code: "AGENT_NOT_FOUND",
        retryable: false,
      });
    }
    run.status = "running";
    run.detail = { ...run.detail, status: "running" };
    return { started: true, status: "running" };
  }

  async listTasks(projectId: string): Promise<RuntimeListResponse> {
    const agents = [...this.agents.values()]
      .filter((r) => r.projectId === projectId)
      .map((r) => ({
        agent_id: r.agentId,
        project_id: r.projectId,
        status: r.status,
        kind: "main" as const,
        current_stage: r.detail.current_stage,
        awaiting_gate: r.detail.awaiting_gate,
        created_at: "2026-01-01T00:00:00Z",
      }));
    return { agents };
  }

  async getTask(agentId: string): Promise<RuntimeAgentDetail> {
    if (this.getError) throw this.getError;
    const run = this.agents.get(agentId);
    if (!run) throw new RuntimeClientError(404, `agent not found: ${agentId}`, { code: "AGENT_NOT_FOUND", retryable: false });
    return run.detail;
  }

  /** Drive a run to a terminal state with optional reason (test helper). */
  setAgent(agentId: string, patch: Partial<RuntimeAgentDetail>): void {
    const run = this.agents.get(agentId);
    if (!run) return;
    run.detail = { ...run.detail, ...patch };
    if (patch.status) run.status = patch.status;
  }

  /** Canned SSE body served by streamTask (per-test). */
  streamBody: string | null = null;
  /** When set, streamTask rejects (→ mapped error). */
  streamError: RuntimeClientError | null = null;

  async streamTask(_agentId: string): Promise<Response> {
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
    server = startSynthiaServer(pool, {
      port: 0,
      runtimeClient: fake,
      runtimeActorId: ids.serviceUid,
    });
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

  async function createEngineeringProject(pid?: string): Promise<string> {
    const id = pid ?? `eng_${randomUUID()}`;
    await client.query(
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ($1,$2,'engineering','GJB_REF_V1','GJB_REF_V1','GJB_REF_V1','GJB 参考流程 v1')`,
      [id, `Engineering ${id}`],
    );
    await client.query(
      `INSERT INTO process_instance(id,project_id,gate_profile_version,current_gate)
       VALUES ($1,$2,'GJB_REF_V1','G0')`,
      [`pi_${id}_G0`, id],
    );
    return id;
  }

  async function seedProcessInstance(projectId: string, pid?: string): Promise<string> {
    const id = pid ?? `pi_${randomUUID()}`;
    await client.query("INSERT INTO process_instance (id, project_id, gate_profile_version) VALUES ($1,$2,'flow-v1')", [id, projectId]);
    return id;
  }

  // ─── POST happy path ────────────────────────────────────────────────────────

  test("POST /tasks: 201 {agentId}; lazily creates default process instance + outbox event", async () => {
    const projectId = await createProject();

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "设计一个 4 位加法器", part: "xc7vx690tffg1761-2" },
    });

    expect(status).toBe(201);
    const data = envelopeData(json);
    expect(typeof data.agentId).toBe("string");
    expect((data.agentId as string).startsWith("agent-")).toBe(true);

    // Legacy-shaped rows are explicitly labelled with the compatibility
    // profile when their historical default process instance is provisioned.
    const piRow = await client.query("SELECT id, gate_profile_version, current_gate FROM process_instance WHERE project_id = $1", [projectId]);
    expect(piRow.rows.length).toBe(1);
    const pi = piRow.rows[0] as Record<string, unknown>;
    expect(pi.id).toBe(`pi-default:${projectId}`);
    expect(pi.gate_profile_version).toBe("LEGACY_COMPAT");
    expect(pi.current_gate).toBe("G0");

    // The forwarded body injected project_id + process_instance_id.
    expect(fake.lastCreate).not.toBeNull();
    expect(fake.lastCreate!.project_id).toBe(projectId);
    expect(fake.lastCreate!.process_instance_id).toBe(`pi-default:${projectId}`);
    expect(fake.lastCreate!.task).toBe("设计一个 4 位加法器");
    expect(fake.lastCreate!.part).toBe("xc7vx690tffg1761-2");

    // Outbox event appended (observability).
    const outboxRow = await client.query("SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1", [data.agentId]);
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

  test("POST /tasks routes exact free, modern engineering, and LEGACY_COMPAT bindings distinctly", async () => {
    const freeId = `free_${randomUUID()}`;
    await client.query(
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ($1,$2,'free',NULL,NULL,NULL,NULL)`,
      [freeId, `Free ${freeId}`],
    );
    const free = await callApi(`/api/v1/projects/${freeId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `free-${randomUUID()}` },
      body: { task: "free agent" },
    });
    expect(free.status).toBe(201);
    expect(fake.lastCreate).toMatchObject({
      project_id: freeId,
      project_type: "free",
      mode: "agent",
    });
    expect(fake.lastCreate!.process_instance_id).toBeUndefined();
    expect(fake.lastCreate!.process_profile_id).toBeUndefined();

    fake.reset();
    const modernId = await createEngineeringProject();
    const modern = await callApi(`/api/v1/projects/${modernId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `modern-${randomUUID()}` },
      body: { task: "governed mainline", mode: "agent" },
    });
    expect(modern.status).toBe(201);
    expect(fake.lastCreate).toMatchObject({
      project_id: modernId,
      project_type: "engineering",
      process_version_id: "GJB_REF_V1",
      process_profile_id: "GJB_REF_V1",
      process_profile_version: "GJB_REF_V1",
      process_profile_name: "GJB 参考流程 v1",
    });
    expect(fake.lastCreate!.mode).toBeUndefined();

    fake.reset();
    const legacyId = await createProject();
    const legacy = await callApi(`/api/v1/projects/${legacyId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `legacy-${randomUUID()}` },
      body: { task: "compatibility path" },
    });
    expect(legacy.status).toBe(201);
    expect(fake.lastCreate).toMatchObject({
      project_id: legacyId,
      project_type: "engineering",
      process_version_id: "LEGACY_COMPAT",
      process_profile_id: "LEGACY_COMPAT",
      process_profile_version: "LEGACY_COMPAT",
      process_profile_name: "兼容旧流程",
      mode: "agent",
    });
  });

  test("POST /tasks rejects partial, mismatched, and unsupported stored bindings before Runtime", async () => {
    await client.query("ALTER TABLE project DROP CONSTRAINT project_process_binding_check");
    try {
      await client.query(
        "INSERT INTO process_definition(id,name) VALUES ('OTHER_FLOW','Other flow') ON CONFLICT DO NOTHING",
      );
      await client.query(
        `INSERT INTO process_version(id,profile_id,version,name,status)
         VALUES ('OTHER_FLOW_V1','OTHER_FLOW','v1','Other flow v1','active') ON CONFLICT DO NOTHING`,
      );
      const rows = [
        {
          id: `partial_${randomUUID()}`,
          values: ["GJB_REF_V1", "GJB_REF_V1", null, "GJB 参考流程 v1"],
        },
        {
          id: `mismatch_${randomUUID()}`,
          values: ["GJB_REF_V1", "LEGACY_COMPAT", "GJB_REF_V1", "GJB 参考流程 v1"],
        },
        {
          id: `other_${randomUUID()}`,
          values: ["OTHER_FLOW_V1", "OTHER_FLOW_V1", "v1", "Other flow v1"],
        },
      ];
      for (const row of rows) {
        await client.query(
          `INSERT INTO project(
             id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
           ) VALUES ($1,$2,'engineering',$3,$4,$5,$6)`,
          [row.id, `Corrupt ${row.id}`, ...row.values],
        );
        const response = await callApi(`/api/v1/projects/${row.id}/tasks`, {
          method: "POST",
          token: ids.humanToken,
          headers: { "idempotency-key": `corrupt-${randomUUID()}` },
          body: { task: "must fail closed" },
        });
        expect(response.status).toBe(409);
        expect(envelopeError(response.json).message).toContain("PROJECT_PROCESS_BINDING_INVALID");
      }
      expect(fake.createCount).toBe(0);
    } finally {
      await client.query("DELETE FROM project WHERE id LIKE 'partial_%' OR id LIKE 'mismatch_%' OR id LIKE 'other_%'");
      await client.query(
        `ALTER TABLE project ADD CONSTRAINT project_process_binding_check CHECK (
          (
            project_type = 'free'
            AND process_version_id IS NULL
            AND process_profile_id IS NULL
            AND process_profile_version IS NULL
            AND process_profile_name IS NULL
          )
          OR
          (
            project_type = 'engineering'
            AND process_version_id IS NOT NULL
            AND process_profile_id IS NOT NULL
            AND process_profile_version IS NOT NULL
            AND process_profile_name IS NOT NULL
            AND (
              (
                process_version_id = 'GJB_REF_V1'
                AND process_profile_id = 'GJB_REF_V1'
                AND process_profile_version = 'GJB_REF_V1'
                AND process_profile_name = 'GJB 参考流程 v1'
              )
              OR
              (
                process_version_id = 'LEGACY_COMPAT'
                AND process_profile_id = 'LEGACY_COMPAT'
                AND process_profile_version = 'LEGACY_COMPAT'
                AND process_profile_name = '兼容旧流程'
              )
            )
          )
        )`,
      );
    }
  });

  test("POST /tasks: engineering project rejects a second formal main agent", async () => {
    const projectId = await createEngineeringProject();
    const first = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `first-${randomUUID()}` },
      body: { task: "first formal main agent" },
    });
    expect(first.status).toBe(201);

    const second = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `second-${randomUUID()}` },
      body: { task: "second formal main agent" },
    });
    expect(second.status).toBe(409);
    expect(envelopeError(second.json).message).toContain("ENGINEERING_MAIN_AGENT_EXISTS");
    expect(fake.createCount).toBe(1);
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
    const agentId = (envelopeData(create.json).agentId as string);
    // Seed a run belonging to otherProject directly in the fake.
    await fake.createTask({ project_id: otherProject, process_instance_id: "pi-x", task: "项目 B 的任务" });

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks`, { token: ids.humanToken });
    expect(status).toBe(200);
    const data = envelopeData(json);
    expect(Array.isArray(data.agents)).toBe(true);
    expect((data.agents as unknown[]).length).toBe(1);
    const only = (data.agents as Record<string, unknown>[])[0]!;
    expect(only.agent_id).toBe(agentId);
    expect(only.project_id).toBe(projectId);
  });

  test("GET /tasks/:agentId: detail with docs (artifact_id + revision_id passed through)", async () => {
    const projectId = await createProject();
    const create = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "查看详情" },
    });
    const agentId = envelopeData(create.json).agentId as string;

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${agentId}`, { token: ids.humanToken });
    expect(status).toBe(200);
    const data = envelopeData(json);
    expect(data.agent_id).toBe(agentId);
    expect(data.project_id).toBe(projectId);
    expect(data.status).toBe("running");
    const docs = data.docs as Record<string, unknown>[];
    expect(docs.length).toBe(1);
    expect(typeof docs[0]!.artifact_id).toBe("string");
    expect(typeof docs[0]!.revision_id).toBe("string");
    expect(docs[0]!.path).toBe("docs/intake.md");
  });

  test("GET /tasks/:agentId: cross-project agent → 404 (project_id mismatch)", async () => {
    const projectId = await createProject();
    const otherProject = await createProject();
    // Create a run under otherProject.
    const create = await callApi(`/api/v1/projects/${otherProject}/tasks`, {
      method: "POST",
      token: ids.humanToken,
      headers: { "idempotency-key": `idem-${randomUUID()}` },
      body: { task: "别的项目的 run" },
    });
    const agentId = envelopeData(create.json).agentId as string;

    // Ask for it under projectId → must not leak.
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${agentId}`, { token: ids.humanToken });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
  });

  test("GET /tasks/:agentId: Runtime reports unknown run → 404 passthrough", async () => {
    const projectId = await createProject();
    fake.getError = new RuntimeClientError(404, "agent not found: ghost", { code: "AGENT_NOT_FOUND", retryable: false });
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/agent-ghost`, { token: ids.humanToken });
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
    const agentId = envelopeData(create.json).agentId as string;
    fake.setAgent(agentId, { status: "failed", reason: "simulate 阶段超时" });

    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${agentId}`, { token: ids.humanToken });
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
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/agent-any`, { token: ids.humanToken });
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

  test("idempotent replay returns same agentId without re-contacting Runtime", async () => {
    const projectId = await createProject();
    const key = `idem-${randomUUID()}`;
    const body = { task: "幂等任务" };

    const first = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body,
    });
    expect(first.status).toBe(201);
    const firstAgentId = envelopeData(first.json).agentId as string;
    expect(fake.createCount).toBe(1);

    const second = await callApi(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body,
    });
    expect(second.status).toBe(201);
    const secondAgentId = envelopeData(second.json).agentId as string;
    expect(secondAgentId).toBe(firstAgentId);
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
      method: "POST", token: ids.genericServiceToken, headers: { "idempotency-key": `idem-${randomUUID()}` }, body: { task: "服务身份创建任务" },
    });
    expect(status).toBe(201);
    expect(typeof envelopeData(json).agentId).toBe("string");
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

  test("GET .../tasks/:agentId/stream passes Runtime SSE through verbatim (no envelope)", async () => {
    const projectId = await createProject();
    const { agent_id: agentId } = await fake.createTask({ project_id: projectId, process_instance_id: "pi-x", task: "sse" });
    fake.streamBody = [
      `event: status\nid: 1\ndata: {"status":"running","ts":"t1"}\n\n`,
      `event: part\nid: 2\ndata: {"part":{"kind":"text","id":"sp-1","state":"streaming","text":"","ts":"t2"}}\n\n`,
      `event: delta\nid: 3\ndata: {"partId":"sp-1","text":"你好"}\n\n`,
      `event: done\nid: 4\ndata: {"reply":"你好","status":"idle","ts":"t4"}\n\n`,
    ].join("");

    const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/tasks/${agentId}/stream`, {
      headers: { authorization: `Bearer ${ids.humanToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    // Verbatim upstream bytes: no JSON envelope wrapping.
    expect(body).toBe(fake.streamBody);
  });

  test("stream cross-project agent → 404 (ownership enforced before piping)", async () => {
    const projectIdA = await createProject();
    const projectIdB = await createProject();
    const { agent_id: agentId } = await fake.createTask({ project_id: projectIdA, process_instance_id: "pi-x", task: "sse" });
    fake.streamBody = "event: status\nid: 1\ndata: {}\n\n";
    const { status, json } = await callApi(`/api/v1/projects/${projectIdB}/tasks/${agentId}/stream`, { token: ids.humanToken });
    expect(status).toBe(404);
    expect(envelopeError(json).code).toBe("not_found");
  });

  test("stream Runtime unreachable → 503 capability_unavailable", async () => {
    const projectId = await createProject();
    const { agent_id: agentId } = await fake.createTask({ project_id: projectId, process_instance_id: "pi-x", task: "sse" });
    fake.streamError = new RuntimeClientError(503, "runtime unreachable", { retryable: true });
    const { status, json } = await callApi(`/api/v1/projects/${projectId}/tasks/${agentId}/stream`, { token: ids.humanToken });
    expect(status).toBe(503);
    expect(envelopeError(json).code).toBe("capability_unavailable");
    expect(envelopeError(json).retryable).toBe(true);
  });

  test("stream unknown run → 404 passthrough", async () => {
    const projectId = await createProject();
    fake.streamBody = "";
    const { status } = await callApi(`/api/v1/projects/${projectId}/tasks/agent-nope/stream`, { token: ids.humanToken });
    expect(status).toBe(404);
  });
});
