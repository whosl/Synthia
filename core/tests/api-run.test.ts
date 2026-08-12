/**
 * Synthia Core — Run / Job API integration tests (real PostgreSQL + fake Connector)
 *
 * Exercises the Core↔Connector run/Job slice (SYNTHIA-IF-002) end to end against
 * a live database and a real Bun.serve API, with an in-process programmable
 * fake Connector injected via `startSynthiaServer({ connector })`. Every
 * assertion observes committed database state — no SQL-string matching.
 *
 * Coverage:
 *   - POST /jobs happy path: 201 envelope + tool_run row + outbox event
 *   - idempotent replay returns the same jobId (one row, one event)
 *   - same key / different payload → 409 conflict
 *   - run_class adjudication matrix: exploratory (no context), gate_check
 *     (frozen submission / missing → 403 / not-frozen → 403), formal (approved
 *     result / missing → 403 / not-found → 403)
 *   - GET /jobs/:id status: unknown → 404; live refresh persists state/outputs
 *   - GET /jobs/:id/evidence: non-terminal → 404; terminal → manifest frozen on
 *     the row; connector "no evidence" → 404
 *   - Connector drift on submit → 503 (retryable), row rolled back
 *   - validation: missing Idempotency-Key / invalid operation → 400
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
  ConnectorError,
  type ConnectorDiscovery,
  type ConnectorJobSnapshot,
  type ConnectorPort,
  type EvidenceManifest,
  type SubmitJobParams,
} from "../src/api/connector-port.ts";
import { RemoteConnectorAdapter } from "../src/api/connector-adapter.ts";
import type { ToolRunState } from "../src/domain/enums.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// ─── fake connector ──────────────────────────────────────────────────────────

const FAKE_CAPABILITIES = [
  { operation: "validate_sources", version: "fake-1", runClasses: ["exploratory", "gate_check", "formal"] },
  { operation: "simulate", version: "fake-1", runClasses: ["exploratory", "gate_check", "formal"] },
  { operation: "synthesize", version: "fake-1", runClasses: ["exploratory", "gate_check", "formal"] },
  { operation: "implement", version: "fake-1", runClasses: ["exploratory", "gate_check", "formal"] },
];

interface FakeJob {
  state: ToolRunState;
  outputSha256?: string;
  errorCode?: string;
  evidence?: EvidenceManifest;
}

/** Programmable in-process Connector. submit/query/evidence can be driven per test. */
class FakeConnector implements ConnectorPort {
  readonly connectorId = "fake-connector";
  private readonly jobs = new Map<string, FakeJob>();
  /** Set to make the next submitJob throw (e.g. CAPABILITY_DRIFT → 503). */
  submitError: ConnectorError | null = null;
  /** When set, queryStatus defers to this instead of the stored job. */
  statusOverride: ((jobId: string) => ConnectorJobSnapshot) | null = null;
  /** When set, fetchEvidence defers to this; return null to mean "no evidence". */
  evidenceOverride: ((jobId: string) => EvidenceManifest | null) | null = null;
  /** Captures the last submit parameters (for assertion). */
  lastSubmit: SubmitJobParams | null = null;
  submitCount = 0;
  /** When true, submitJob simulates the Worker's VIVADO_PARAMETERS_REQUIRED
   *  rejection: params.parameters must be a non-empty object. */
  validateParameters = true;
  /** Simulates a one-shot lease expiry: the next submitJob throws
   *  LEASE_EXPIRED, subsequent calls recover (adapter reconnect path). */
  leaseExpireNext = false;

  reset(): void {
    this.jobs.clear();
    this.submitError = null;
    this.statusOverride = null;
    this.evidenceOverride = null;
    this.lastSubmit = null;
    this.submitCount = 0;
    this.validateParameters = true;
    this.leaseExpireNext = false;
  }

  async discover(): Promise<ConnectorDiscovery> {
    return { capabilities: FAKE_CAPABILITIES, drift: false };
  }

  async submitJob(params: SubmitJobParams): Promise<ConnectorJobSnapshot> {
    this.submitCount += 1;
    this.lastSubmit = params;
    if (this.submitError) throw this.submitError;
    // Simulate the real Worker (server.ts:45-46): request.parameters must be a
    // non-empty object, else the Job is rejected with VIVADO_PARAMETERS_REQUIRED.
    if (this.validateParameters) {
      const p = params.parameters as unknown;
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        throw new ConnectorError("VIVADO_PARAMETERS_REQUIRED", "parameters must be a non-empty object");
      }
    }
    // One-shot lease expiry simulation: first call after the flag is set throws,
    // the adapter (if wrapping this fake) or a retry then recovers.
    if (this.leaseExpireNext) {
      this.leaseExpireNext = false;
      throw new ConnectorError("LEASE_EXPIRED", "lease expired", true);
    }
    // Job accepted by the Connector; stays non-terminal until a status poll.
    this.jobs.set(params.jobId, { state: "queued" });
    return { jobId: params.jobId, state: "queued" };
  }

  async queryStatus(_projectId: string, jobId: string): Promise<ConnectorJobSnapshot> {
    if (this.statusOverride) return this.statusOverride(jobId);
    const job = this.jobs.get(jobId);
    if (!job) throw new ConnectorError("JOB_NOT_FOUND", "job not found");
    return { jobId, state: job.state, outputSha256: job.outputSha256, errorCode: job.errorCode };
  }

  async fetchEvidence(_projectId: string, jobId: string): Promise<EvidenceManifest> {
    if (this.evidenceOverride) {
      const m = this.evidenceOverride(jobId);
      if (!m) throw new ConnectorError("EVIDENCE_NOT_AVAILABLE", "evidence not available");
      return m;
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new ConnectorError("JOB_NOT_FOUND", "job not found");
    if (job.evidence) return job.evidence;
    return {
      jobId,
      entries: [{ name: "result.txt", sha256: "a".repeat(64), sizeBytes: 42, mediaType: "text/plain" }],
    };
  }

  /** Drive a job to a terminal state with optional output/error (test helper). */
  setJob(jobId: string, patch: Partial<FakeJob>): void {
    const prev = this.jobs.get(jobId) ?? { state: "queued" as ToolRunState };
    this.jobs.set(jobId, { ...prev, ...patch });
  }
}

// ─── harness ─────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)("run/job API — real PostgreSQL + fake Connector", () => {
  let client: Client;
  let pool: Pool;
  let server: SynthiaServer;
  let baseUrl: string;
  let ids: BootstrapIdentities;
  let fake: FakeConnector;

  beforeAll(async () => {
    const { Client: PgClient, Pool: PgPool } = await import("pg");
    client = new PgClient({ connectionString: DATABASE_URL }) as Client;
    await client.connect();
    await applyMigrations(client);
    ids = await bootstrapIdentities(client);
    await truncateDomainTables(client);
    pool = new PgPool({ connectionString: DATABASE_URL, max: 4 }) as unknown as Pool;
    fake = new FakeConnector();
    server = startSynthiaServer(pool, { port: 0, connector: fake });
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

  function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${token}`, ...extra };
  }

  function envelopeData(json: unknown): Record<string, unknown> {
    const env = json as { data?: Record<string, unknown> };
    if (!env || typeof env !== "object" || !("data" in env)) throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
    return env.data!;
  }

  function envelopeError(json: unknown): { code: string; retryable: boolean; details: unknown; correlation_id: string } {
    const env = json as { error?: Record<string, unknown> };
    if (!env?.error) throw new Error(`missing error envelope: ${JSON.stringify(json)}`);
    return env.error as { code: string; retryable: boolean; details: unknown; correlation_id: string };
  }

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

  async function createProject(pid?: string): Promise<string> {
    const id = pid ?? `proj_${randomUUID()}`;
    await client.query("INSERT INTO project (id, name) VALUES ($1, $2)", [id, `Project ${id}`]);
    return id;
  }

  /** Seed a gate_submission in a chosen state; returns its id. */
  async function seedGateSubmission(projectId: string, state: string): Promise<string> {
    const piId = `pi_${randomUUID()}`;
    const snapId = `snap_${randomUUID()}`;
    const subId = `sub_${randomUUID()}`;
    await client.query(
      "INSERT INTO process_instance (id, project_id, gate_profile_version) VALUES ($1,$2,'flow-v1')",
      [piId, projectId],
    );
    await client.query(
      `INSERT INTO configuration_snapshot (id, project_id, member_revision_ids, gate_profile_version, tool_model_policy_hash, manifest_hash, created_by)
       VALUES ($1,$2,'{}','flow-v1','policy-hash','manifest-hash','seeder')`,
      [snapId, projectId],
    );
    await client.query(
      `INSERT INTO gate_submission (id, project_id, process_instance_id, gate, snapshot_id, state, submitter_id)
       VALUES ($1,$2,$3,'G1',$4,$5,'seeder')`,
      [subId, projectId, piId, snapId, state],
    );
    return subId;
  }

  /** Seed the full approval chain and return an approved_gate_result id (formal auth context). */
  async function seedApprovedGateResult(projectId: string): Promise<string> {
    const subId = await seedGateSubmission(projectId, "approved");
    const agrId = `agr_${randomUUID()}`;
    const snapId = (await client.query("SELECT snapshot_id FROM gate_submission WHERE id = $1", [subId])).rows[0]!.snapshot_id as string;
    const arId = `ar_${randomUUID()}`;
    const checkHash = `sha:${randomUUID()}`;
    await client.query(
      `INSERT INTO approval_record (id, project_id, gate_submission_id, decision, approver_id, approver_role,
            authorization_basis, reason, check_results_hash, signed_at, approved_gate_result_id)
       VALUES ($1,$2,$3,'approve','seeder','quality','role-bound','ok',$4,now(),$5)`,
      [arId, projectId, subId, checkHash, agrId],
    );
    await client.query(
      `INSERT INTO approved_gate_result (id, project_id, gate, gate_submission_id, approval_record_id, snapshot_id)
       VALUES ($1,$2,'G1',$3,$4,$5)`,
      [agrId, projectId, subId, arId, snapId],
    );
    return agrId;
  }

  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      operation: "synthesize",
      sources: [{ path: "top.v", content: "module top; endmodule" }],
      top: "top",
      part: "xc7k70tfbv676-1",
      timeout_ms: 60000,
      ...overrides,
    };
  }

  async function toolRunRow(jobId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await client.query("SELECT * FROM tool_run WHERE id = $1", [jobId]);
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  async function outboxFor(jobId: string): Promise<{ event_type: string; payload: unknown }[]> {
    const { rows } = await client.query("SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1", [jobId]);
    return rows as { event_type: string; payload: unknown }[];
  }

  // ══ POST /jobs — submission ════════════════════════════════════════════════

  describe("POST /projects/:id/jobs", () => {
    test("happy path: 201 with jobId/runClass/state, tool_run row + outbox event committed, Connector received the job", async () => {
      const pid = await createProject();
      const key = `k_${randomUUID()}`;
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST",
        token: ids.humanToken,
        headers: { "idempotency-key": key },
        body: validBody(),
      });
      expect(res.status).toBe(201);
      const data = envelopeData(res.json);
      expect(data.state).toBe("submitted");
      expect(data.runClass).toBe("exploratory");
      expect(typeof data.jobId).toBe("string");
      expect((data.jobId as string).startsWith("job-")).toBe(true);

      const jobId = data.jobId as string;
      // DB: tool_run committed in submitted state with manifest hash + parameters + connector id.
      const row = await toolRunRow(jobId);
      expect(row).not.toBeNull();
      expect(row!.state).toBe("submitted");
      expect(row!.run_class).toBe("exploratory");
      expect(row!.operation).toBe("synthesize");
      expect(row!.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.connector_id).toBe("fake-connector");
      const params = row!.parameters as Record<string, unknown>;
      expect(params.operation).toBe("synthesize");
      expect(params.runClass).toBe("exploratory");
      expect(params.jobId).toBe(jobId);
      expect(Array.isArray(params.sources)).toBe(true);
      expect(row!.authorization_context).toEqual({}); // exploratory → empty

      // outbox: tool_run.submitted emitted with the jobId.
      const events = await outboxFor(jobId);
      expect(events.some((e) => e.event_type === "tool_run.submitted")).toBe(true);

      // Connector: submitJob invoked exactly once with the generated jobId + params.
      expect(fake.submitCount).toBe(1);
      expect(fake.lastSubmit!.jobId).toBe(jobId);
      expect(fake.lastSubmit!.operation).toBe("synthesize");
      expect(fake.lastSubmit!.runClass).toBe("exploratory");
    });

    test("idempotent replay with same key + same body returns the same jobId (one row, one event, Connector called once)", async () => {
      const pid = await createProject();
      const key = `k_${randomUUID()}`;
      const body = validBody();
      const first = await callApi(`/api/v1/projects/${pid}/jobs`, { method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body });
      expect(first.status).toBe(201);
      const jobId = envelopeData(first.json).jobId as string;

      const second = await callApi(`/api/v1/projects/${pid}/jobs`, { method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body });
      expect(second.status).toBe(201);
      expect(envelopeData(second.json).jobId).toBe(jobId);

      // Exactly one tool_run row + one outbox event; Connector submitJob ran once.
      expect(await toolRunRow(jobId)).not.toBeNull();
      const { rows } = await client.query("SELECT count(*)::int AS n FROM tool_run WHERE id = $1", [jobId]);
      expect(rows[0]!.n).toBe(1);
      const ev = await outboxFor(jobId);
      expect(ev.filter((e) => e.event_type === "tool_run.submitted")).toHaveLength(1);
      expect(fake.submitCount).toBe(1);
    });

    test("same key + different payload → 409 conflict", async () => {
      const pid = await createProject();
      const key = `k_${randomUUID()}`;
      const first = await callApi(`/api/v1/projects/${pid}/jobs`, { method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body: validBody() });
      expect(first.status).toBe(201);

      const conflict = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST",
        token: ids.humanToken,
        headers: { "idempotency-key": key },
        body: validBody({ operation: "simulate" }),
      });
      expect(conflict.status).toBe(409);
      expect(envelopeError(conflict.json).code).toBe("conflict");
    });

    test("missing Idempotency-Key → 400 validation", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, { method: "POST", token: ids.humanToken, body: validBody() });
      expect(res.status).toBe(400);
      expect(envelopeError(res.json).code).toBe("validation");
    });

    test("invalid operation → 400 validation", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST",
        token: ids.humanToken,
        headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ operation: "not_a_real_op" }),
      });
      expect(res.status).toBe(400);
      expect(envelopeError(res.json).code).toBe("validation");
    });

    test("read-only token cannot submit (missing core:write) → 403", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST",
        token: ids.readOnlyToken,
        headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody(),
      });
      expect(res.status).toBe(403);
    });

    // ── run_class adjudication matrix ───────────────────────────────────────

    test("no run_class_intent / no authorization context → exploratory", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` }, body: validBody(),
      });
      expect(res.status).toBe(201);
      expect(envelopeData(res.json).runClass).toBe("exploratory");
    });

    test("gate_check with a frozen submission → runClass gate_check", async () => {
      const pid = await createProject();
      const subId = await seedGateSubmission(pid, "submitted");
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ run_class_intent: "gate_check", gate_submission_id: subId }),
      });
      expect(res.status).toBe(201);
      const data = envelopeData(res.json);
      expect(data.runClass).toBe("gate_check");
      const row = await toolRunRow(data.jobId as string);
      expect(row!.authorization_context).toEqual({ gateSubmissionId: subId });
    });

    test("gate_check missing submission → 403 authorization, no row", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ run_class_intent: "gate_check" }),
      });
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
      const { rows } = await client.query("SELECT count(*)::int AS n FROM tool_run WHERE project_id = $1", [pid]);
      expect(rows[0]!.n).toBe(0);
    });

    test("gate_check with a non-frozen (preparing) submission → 403", async () => {
      const pid = await createProject();
      const subId = await seedGateSubmission(pid, "preparing");
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ run_class_intent: "gate_check", gate_submission_id: subId }),
      });
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
    });

    test("formal with an approved gate result → runClass formal", async () => {
      const pid = await createProject();
      const agrId = await seedApprovedGateResult(pid);
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ run_class_intent: "formal", approved_gate_result_id: agrId }),
      });
      expect(res.status).toBe(201);
      const data = envelopeData(res.json);
      expect(data.runClass).toBe("formal");
      const row = await toolRunRow(data.jobId as string);
      expect(row!.authorization_context).toEqual({ approvedGateResultId: agrId });
    });

    test("formal missing approval context → 403 authorization, no row", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ run_class_intent: "formal" }),
      });
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
      const { rows } = await client.query("SELECT count(*)::int AS n FROM tool_run WHERE project_id = $1", [pid]);
      expect(rows[0]!.n).toBe(0);
    });

    test("formal with a non-existent approved_gate_result_id → 403", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` },
        body: validBody({ run_class_intent: "formal", approved_gate_result_id: `agr_missing_${randomUUID()}` }),
      });
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
    });

    test("Connector drift on submit → 503 capability_unavailable (retryable), row rolled back; same-key retry then succeeds", async () => {
      const pid = await createProject();
      const key = `k_${randomUUID()}`;
      fake.submitError = new ConnectorError("CAPABILITY_DRIFT", "drift");
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body: validBody(),
      });
      expect(res.status).toBe(503);
      const err = envelopeError(res.json);
      expect(err.code).toBe("capability_unavailable");
      expect(err.retryable).toBe(true);
      // No tool_run, no outbox event, idempotency slot released.
      const { rows } = await client.query("SELECT count(*)::int AS n FROM tool_run WHERE project_id = $1", [pid]);
      expect(rows[0]!.n).toBe(0);
      const ev = await client.query("SELECT count(*)::int AS n FROM outbox_events WHERE project_id = $1", [pid]);
      expect(ev.rows[0]!.n).toBe(0);

      // Retry with the SAME key now succeeds — the rollback released the slot.
      fake.submitError = null;
      const retry = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": key }, body: validBody(),
      });
      expect(retry.status).toBe(201);
    });

    test("parameters shape validated by fake (simulates Worker VIVADO_PARAMETERS_REQUIRED)", async () => {
      const pid = await createProject();
      // Normal submit works and the fake validates parameters is a non-empty object.
      const ok = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k1_${randomUUID()}` }, body: validBody(),
      });
      expect(ok.status).toBe(201);
      expect(fake.lastSubmit!.parameters).toBeTruthy();
      expect(typeof fake.lastSubmit!.parameters).toBe("object");

      // If the fake's parameter validation is strict, an empty parameters would
      // be rejected — this confirms the handler always sends a valid shape.
      const sources = fake.lastSubmit!.parameters.sources;
      expect(Array.isArray(sources)).toBe(true);
    });
  });

  // ══ GET /jobs/:jobId — status ══════════════════════════════════════════════

  describe("GET /projects/:id/jobs/:jobId", () => {
    async function submitJob(pid: string): Promise<string> {
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` }, body: validBody(),
      });
      return envelopeData(res.json).jobId as string;
    }

    test("unknown jobId → 404 not_found", async () => {
      const pid = await createProject();
      const res = await callApi(`/api/v1/projects/${pid}/jobs/job-does-not-exist`, { token: ids.humanToken });
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });

    test("live status refresh persists state + output_sha256 + end_time", async () => {
      const pid = await createProject();
      const jobId = await submitJob(pid);
      const outputSha = "b".repeat(64);
      fake.setJob(jobId, { state: "succeeded", outputSha256: outputSha });

      const res = await callApi(`/api/v1/projects/${pid}/jobs/${jobId}`, { token: ids.humanToken });
      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      expect(data.state).toBe("succeeded");
      expect(data.outputSha256).toBe(outputSha);

      const row = await toolRunRow(jobId);
      expect(row!.state).toBe("succeeded");
      expect(row!.output_sha256).toBe(outputSha);
      expect(row!.end_time).not.toBeNull();
    });

    test("failed terminal state persists error_code", async () => {
      const pid = await createProject();
      const jobId = await submitJob(pid);
      fake.setJob(jobId, { state: "failed", errorCode: "VIVADO_SYNTH_ERROR" });
      const res = await callApi(`/api/v1/projects/${pid}/jobs/${jobId}`, { token: ids.humanToken });
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).errorCode).toBe("VIVADO_SYNTH_ERROR");
      const row = await toolRunRow(jobId);
      expect(row!.error_code).toBe("VIVADO_SYNTH_ERROR");
    });
  });

  // ══ GET /jobs/:jobId/evidence — evidence ════════════════════════════════════

  describe("GET /projects/:id/jobs/:jobId/evidence", () => {
    async function submitJob(pid: string): Promise<string> {
      const res = await callApi(`/api/v1/projects/${pid}/jobs`, {
        method: "POST", token: ids.humanToken, headers: { "idempotency-key": `k_${randomUUID()}` }, body: validBody(),
      });
      return envelopeData(res.json).jobId as string;
    }

    test("non-terminal job (status refresh still non-terminal) → 404 not_found", async () => {
      const pid = await createProject();
      const jobId = await submitJob(pid);
      // Connector still reports queued → evidence unavailable.
      const res = await callApi(`/api/v1/projects/${pid}/jobs/${jobId}/evidence`, { token: ids.humanToken });
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });

    test("terminal job → 200 manifest, frozen on tool_run.evidence", async () => {
      const pid = await createProject();
      const jobId = await submitJob(pid);
      const outputSha = "c".repeat(64);
      fake.setJob(jobId, { state: "succeeded", outputSha256: outputSha });

      const res = await callApi(`/api/v1/projects/${pid}/jobs/${jobId}/evidence`, { token: ids.humanToken });
      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      expect(data.jobId).toBe(jobId);
      expect(Array.isArray(data.entries)).toBe(true);
      const entry = (data.entries as Record<string, unknown>[])[0]!;
      expect(entry.name).toBe("result.txt");
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);

      const row = await toolRunRow(jobId);
      const ev = row!.evidence as { jobId: string; entries: unknown[] } | null;
      expect(ev).not.toBeNull();
      expect(ev!.jobId).toBe(jobId);
      expect(ev!.entries.length).toBeGreaterThan(0);
    });

    test("terminal job but Connector reports no evidence → 404 not_found", async () => {
      const pid = await createProject();
      const jobId = await submitJob(pid);
      fake.setJob(jobId, { state: "failed", errorCode: "HARD_ERROR" });
      fake.evidenceOverride = () => null; // Connector has no evidence for this job.

      const res = await callApi(`/api/v1/projects/${pid}/jobs/${jobId}/evidence`, { token: ids.humanToken });
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });
  });

  // ─── connector contract ─────────────────────────────────────────────────────

  test("fake connector discover() advertises the 4 run operations", async () => {
    const d = await fake.discover();
    expect(d.capabilities.map((c) => c.operation).sort()).toEqual(["implement", "simulate", "synthesize", "validate_sources"]);
  });
});

// ══ Adapter-level: lease reconnect + parameters mapping (no DB) ══════════════

/** Mock RemoteClientLike whose methods are driven per-test. */
class MockRemoteClient {
  state = "approved";
  hasCapabilityDrift = false;
  submitCalls = 0;
  heartbeatCalls = 0;
  /** Queue of errors for submit; each consumed in order. Empty = success. */
  submitErrors: Error[] = [];
  /** When set, heartbeat throws this once then clears. */
  heartbeatError: Error | null = null;
  lastRequest: Record<string, unknown> | null = null;
  lastApproval: unknown = undefined;

  async register() { this.state = "ready"; return { registration_state: "ready" }; }
  async heartbeat() {
    this.heartbeatCalls += 1;
    if (this.heartbeatError) { const e = this.heartbeatError; this.heartbeatError = null; throw e; }
    this.state = "ready";
    return { registration_state: "ready" };
  }
  async discover() { return { capabilities: FAKE_CAPABILITIES, toolchain_profile_hash: "h" }; }
  async submit(req: Record<string, unknown>, approval?: unknown) {
    this.submitCalls += 1;
    this.lastRequest = req;
    this.lastApproval = approval;
    if (this.submitErrors.length > 0) throw this.submitErrors.shift()!;
    return { id: req.jobId as string, state: "queued" as ToolRunState };
  }
  async status(id: string) { return { id, state: "queued" as ToolRunState }; }
  async evidence(id: string) { return { jobId: id, entries: [{ name: "r.txt", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "text/plain" }] }; }
}

/** Build a MockRemoteError with a `code` property (mimics RemoteConnectorError). */
function remoteError(code: string, retryable = false): Error {
  const e = new Error(code) as Error & { code: string; retryable: boolean };
  e.name = "RemoteConnectorError";
  e.code = code;
  e.retryable = retryable;
  return e;
}

describe("RemoteConnectorAdapter — lease reconnect + parameters mapping", () => {
  const makeAdapter = (client: MockRemoteClient) => {
    return new RemoteConnectorAdapter(
      () => client, // factory returns the same mock instance
      { connector_id: "mock-66" },
      ["connect.wenzhuolin.xyz"],
      {},
    );
  };

  const baseParams = (overrides: Partial<SubmitJobParams> = {}): SubmitJobParams => ({
    jobId: "job-test-1",
    projectId: "p1",
    operation: "synthesize",
    runClass: "exploratory",
    idempotencyKey: "key-1",
    correlationId: "corr-1",
    actor: { actorType: "service", actorId: "core" },
    parameters: { sources: [{ path: "top.v", content: "module top; endmodule" }], top: "top", part: "xc7k70t", constraints: [] },
    ...overrides,
  });

  test("submitJob maps parameters correctly: input=manifest:jobId, parameters repeats operation/jobId/projectId/runClass + sources", async () => {
    const mock = new MockRemoteClient();
    const adapter = makeAdapter(mock);
    await adapter.submitJob(baseParams());
    expect(mock.submitCalls).toBe(1);
    expect(mock.lastRequest!.input).toBe("manifest:job-test-1");
    const params = mock.lastRequest!.parameters as Record<string, unknown>;
    expect(params.operation).toBe("synthesize");
    expect(params.jobId).toBe("job-test-1");
    expect(params.projectId).toBe("p1");
    expect(params.runClass).toBe("exploratory");
    expect(Array.isArray(params.sources)).toBe(true);
  });

  test("submitJob with exploratory omits approval", async () => {
    const mock = new MockRemoteClient();
    const adapter = makeAdapter(mock);
    await adapter.submitJob(baseParams({ runClass: "exploratory" }));
    expect(mock.lastApproval).toBeUndefined();
  });

  test("submitJob with gate_check forwards gateSubmissionId as approval", async () => {
    const mock = new MockRemoteClient();
    const adapter = makeAdapter(mock);
    await adapter.submitJob(baseParams({ runClass: "gate_check", approval: { gateSubmissionId: "sub-1" } }));
    const approval = mock.lastApproval as { gateSubmissionId: string };
    expect(approval.gateSubmissionId).toBe("sub-1");
  });

  test("submitJob with formal forwards inputApproved + baselineId", async () => {
    const mock = new MockRemoteClient();
    const adapter = makeAdapter(mock);
    await adapter.submitJob(baseParams({ runClass: "formal", approval: { baselineId: "bl-1" } }));
    const approval = mock.lastApproval as { inputApproved: boolean; baselineId: string; projectId: string };
    expect(approval.inputApproved).toBe(true);
    expect(approval.baselineId).toBe("bl-1");
    expect(approval.projectId).toBe("p1");
  });

  test("LEASE_EXPIRED on submit triggers reconnect (fresh client) and retry succeeds", async () => {
    const mock = new MockRemoteClient();
    mock.submitErrors.push(remoteError("LEASE_EXPIRED", true));
    const adapter = makeAdapter(mock);
    // First submit throws LEASE_EXPIRED → adapter rebuilds client → retries → succeeds.
    const result = await adapter.submitJob(baseParams());
    expect(result.state).toBe("queued");
    expect(mock.submitCalls).toBe(2); // initial + retry
  });

  test("LEASE_EXPIRED on proactive heartbeat triggers reconnect, then operation proceeds", async () => {
    const mock = new MockRemoteClient();
    const adapter = makeAdapter(mock);
    // Prime first (register+heartbeat+discover) — no error.
    await adapter.submitJob(baseParams({ jobId: "job-a" }));
    expect(mock.submitCalls).toBe(1);
    // Second op: proactive heartbeat throws LEASE_EXPIRED → adapter re-primes
    // (register+heartbeat+discover on a fresh client) → submit retries.
    mock.heartbeatError = remoteError("LEASE_EXPIRED", true);
    const result = await adapter.submitJob(baseParams({ jobId: "job-b", idempotencyKey: "key-b" }));
    expect(result.state).toBe("queued");
    expect(mock.submitCalls).toBe(2); // first + second (after reconnect)
    expect(mock.heartbeatCalls).toBeGreaterThanOrEqual(3); // prime + failed + re-prime
  });

  test("capability drift after reconnect is fail-closed (no submit)", async () => {
    const mock = new MockRemoteClient();
    const adapter = makeAdapter(mock);
    // Prime the adapter first (clean state).
    await adapter.submitJob(baseParams({ jobId: "job-a" }));

    // Now arrange: proactive heartbeat succeeds, but the submit itself throws
    // LEASE_EXPIRED. The reconnect rebuilds and calls discover — set drift so
    // that discover path sees CAPABILITY_DRIFT and fails closed.
    mock.submitErrors.push(remoteError("LEASE_EXPIRED", true));
    mock.heartbeatError = null;
    const origDiscover = mock.discover.bind(mock);
    let reconnectDiscover = false;
    mock.discover = async () => {
      const d = await origDiscover();
      if (reconnectDiscover) mock.hasCapabilityDrift = true;
      return d;
    };
    // The reconnect path calls register → heartbeat → discover. Mark the
    // NEXT discover call (the reconnect one) to set drift.
    reconnectDiscover = true;
    let caught: ConnectorError | null = null;
    try {
      await adapter.submitJob(baseParams({ jobId: "job-b", idempotencyKey: "key-b" }));
    } catch (e) {
      caught = e as ConnectorError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("CAPABILITY_DRIFT");
  });
});
