/**
 * Synthia Core — Jobs list API integration tests (real PostgreSQL)
 *
 * Exercises GET /projects/:id/jobs (the run-history list behind the unified
 * project page) end to end against a live database and a real Bun.serve API.
 * The endpoint is a pure DB read (no Connector round-trip), so runs are seeded
 * directly in `tool_run` and every assertion observes committed rows or the
 * HTTP response derived from them.
 *
 * Coverage:
 *   - empty project → 200 {data: []}
 *   - field mapping (camelCase, errorCode omitted when NULL, nullable times)
 *   - ordering: newest effective start first; NULL start_time → created_at
 *   - cross-project isolation
 *   - default limit 100 (120 seeded runs) and explicit ?limit=
 *   - invalid limit (0 / non-integer) → 400 validation
 *   - missing project → 404
 *   - token lacking core:read → 403
 *
 * Requires DATABASE_URL. When unset the whole suite is explicitly skipped —
 * skipped tests never count as passing (no fake green).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { sha256Hex } from "../src/hashing.ts";
import { applyMigrations } from "./support/approval-harness.ts";
import { bootstrapIdentities, truncateDomainTables, type BootstrapIdentities } from "./support/api-harness.ts";
import { startSynthiaServer, type SynthiaServer } from "../src/api/server.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// ─── harness ─────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)("jobs list API — real PostgreSQL", () => {
  let client: Client;
  let pool: Pool;
  let server: SynthiaServer;
  let baseUrl: string;
  let ids: BootstrapIdentities;

  beforeAll(async () => {
    const { Client: PgClient, Pool: PgPool } = await import("pg");
    client = new PgClient({ connectionString: DATABASE_URL }) as Client;
    await client.connect();
    await applyMigrations(client);
    ids = await bootstrapIdentities(client);
    await truncateDomainTables(client);
    // No Connector needed: the list endpoint must never contact it.
    pool = new PgPool({ connectionString: DATABASE_URL, max: 4 }) as unknown as Pool;
    server = startSynthiaServer(pool, { port: 0 });
    baseUrl = `http://${server.hostname}:${server.port}`;
  });

  afterAll(async () => {
    if (server) server.stop();
    if (pool) await pool.end();
    if (client) await client.end();
  });

  beforeEach(async () => {
    await truncateDomainTables(client);
  });

  // ─── helpers ────────────────────────────────────────────────────────────────

  async function callApi(path: string, opts: { method?: string; token?: string | null } = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined && opts.token !== null) headers["authorization"] = `Bearer ${opts.token}`;
    const response = await fetch(`${baseUrl}${path}`, { method: opts.method ?? "GET", headers });
    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: response.status, json };
  }

  function envelopeData(json: unknown): Record<string, unknown>[] {
    const env = json as { data?: Record<string, unknown>[] };
    if (!env || typeof env !== "object" || !("data" in env)) throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
    return env.data!;
  }

  function envelopeError(json: unknown): { code: string; retryable: boolean; details: unknown; correlation_id: string } {
    const env = json as { error?: Record<string, unknown> };
    if (!env?.error) throw new Error(`missing error envelope: ${JSON.stringify(json)}`);
    return env.error as { code: string; retryable: boolean; details: unknown; correlation_id: string };
  }

  async function createProject(pid?: string): Promise<string> {
    const id = pid ?? `proj_${randomUUID()}`;
    await client.query("INSERT INTO project (id, name) VALUES ($1, $2)", [id, `Project ${id}`]);
    return id;
  }

  interface SeedRun {
    operation?: string;
    runClass?: string;
    state?: string;
    errorCode?: string | null;
    startTime?: Date | null;
    endTime?: Date | null;
    createdAt?: Date;
  }

  /** Seed one tool_run row directly (defaults mirror POST /jobs committed shape). */
  async function seedRun(projectId: string, opts: SeedRun = {}): Promise<string> {
    const id = `job_${randomUUID()}`;
    await client.query(
      `INSERT INTO tool_run (id, project_id, operation, run_class, state, error_code, start_time, end_time, correlation_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        projectId,
        opts.operation ?? "simulate",
        opts.runClass ?? "exploratory",
        opts.state ?? "succeeded",
        opts.errorCode ?? null,
        opts.startTime ?? null,
        opts.endTime ?? null,
        `corr_${randomUUID()}`,
        opts.createdAt ?? new Date(),
      ],
    );
    return id;
  }

  /** Mint a token whose scope lacks core:read (scope-guard test). */
  async function mintTokenWithoutRead(): Promise<string> {
    const token = randomBytes(24).toString("hex");
    const { rows } = await client.query(
      `INSERT INTO auth_token (token_hash, user_id, scope)
       SELECT $1, id, $3::text[] FROM user_account WHERE uid = $2 RETURNING user_id`,
      [sha256Hex(token), ids.humanUid, ["core:write"]],
    );
    if (rows.length === 0) throw new Error("failed to mint token without core:read");
    return token;
  }

  // ══ list: shape & ordering ═════════════════════════════════════════════════

  test("project with no runs → 200 {data: []}", async () => {
    const pid = await createProject();
    const res = await callApi(`/api/v1/projects/${pid}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    expect(envelopeData(res.json)).toEqual([]);
  });

  test("field mapping: camelCase, errorCode omitted when NULL, nullable times", async () => {
    const pid = await createProject();
    const start = new Date("2026-01-02T03:04:05.678Z");
    const end = new Date("2026-01-02T03:05:05.678Z");
    const failedId = await seedRun(pid, {
      operation: "synthesize",
      runClass: "formal",
      state: "failed",
      errorCode: "VIVADO_SYNTH_ERROR",
      startTime: start,
      endTime: end,
    });
    const okId = await seedRun(pid, { state: "running", startTime: start, endTime: null });

    const res = await callApi(`/api/v1/projects/${pid}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    const rows = envelopeData(res.json);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const failed = byId.get(failedId)!;
    expect(failed.operation).toBe("synthesize");
    expect(failed.runClass).toBe("formal");
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("VIVADO_SYNTH_ERROR");
    expect(new Date(failed.startTime as string).getTime()).toBe(start.getTime());
    expect(new Date(failed.endTime as string).getTime()).toBe(end.getTime());

    // Non-error, non-terminal run: errorCode key absent, endTime null.
    const ok = byId.get(okId)!;
    expect(ok.state).toBe("running");
    expect("errorCode" in ok).toBe(false);
    expect(ok.endTime).toBeNull();
  });

  test("ordering: multiple runs returned newest start_time first", async () => {
    const pid = await createProject();
    const oldest = await seedRun(pid, { startTime: new Date("2026-01-01T00:00:00Z"), endTime: new Date("2026-01-01T00:01:00Z") });
    const newest = await seedRun(pid, { startTime: new Date("2026-01-03T00:00:00Z"), endTime: new Date("2026-01-03T00:01:00Z") });
    const middle = await seedRun(pid, { startTime: new Date("2026-01-02T00:00:00Z"), endTime: new Date("2026-01-02T00:01:00Z") });

    const res = await callApi(`/api/v1/projects/${pid}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    const rows = envelopeData(res.json);
    expect(rows.map((r) => r.id)).toEqual([newest, middle, oldest]);
  });

  test("NULL start_time falls back to created_at (POST /jobs rows have no start_time)", async () => {
    const pid = await createProject();
    // Explicit old start_time vs a NULL start_time row created later.
    const startedOld = await seedRun(pid, { startTime: new Date("2025-12-01T00:00:00Z") });
    const createdLater = await seedRun(pid, { startTime: null, createdAt: new Date(Date.now() + 60_000) });

    const res = await callApi(`/api/v1/projects/${pid}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    const rows = envelopeData(res.json);
    expect(rows.map((r) => r.id)).toEqual([createdLater, startedOld]);
    expect(rows[1]!.startTime).not.toBeNull();
    // The never-started row still reports its (null) start_time, not the fallback.
    expect(rows[0]!.startTime).toBeNull();
  });

  // ══ isolation & limits ══════════════════════════════════════════════════════

  test("cross-project isolation: only the requested project's runs", async () => {
    const pidA = await createProject();
    const pidB = await createProject();
    const a1 = await seedRun(pidA, { startTime: new Date("2026-02-01T00:00:00Z") });
    const a2 = await seedRun(pidA, { startTime: new Date("2026-02-02T00:00:00Z") });
    await seedRun(pidB, { startTime: new Date("2026-02-03T00:00:00Z") });
    await seedRun(pidB, { startTime: new Date("2026-02-04T00:00:00Z") });

    const res = await callApi(`/api/v1/projects/${pidA}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    const rows = envelopeData(res.json);
    expect(rows.map((r) => r.id).sort()).toEqual([a1, a2].sort());
    expect(rows.every((r) => r.id !== undefined)).toBe(true);
  });

  test("default limit is 100 (120 seeded runs → 100 newest returned)", async () => {
    const pid = await createProject();
    // g=1..120, start_time = now() - g minutes → g=1 is the newest.
    await client.query(
      `INSERT INTO tool_run (id, project_id, operation, run_class, state, error_code, start_time, correlation_id)
       SELECT 'job_bulk_' || lpad(g::text, 3, '0'), $1, 'simulate', 'exploratory',
              CASE WHEN g % 3 = 0 THEN 'failed' ELSE 'succeeded' END::tool_run_state,
              CASE WHEN g % 3 = 0 THEN 'BULK_ERROR' END,
              now() - (g || ' minutes')::interval, 'corr_bulk'
         FROM generate_series(1, 120) AS g`,
      [pid],
    );

    const res = await callApi(`/api/v1/projects/${pid}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    const rows = envelopeData(res.json);
    expect(rows).toHaveLength(100);
    // The 100 newest by effective start: bulk 1..100, newest first.
    expect(rows[0]!.id).toBe("job_bulk_001");
    expect(rows[99]!.id).toBe("job_bulk_100");
    // Seeded error codes survive the mapping (every 3rd run failed).
    expect(rows.filter((r) => r.errorCode === "BULK_ERROR").length).toBe(33);
  });

  test("explicit ?limit=2 returns the 2 newest runs", async () => {
    const pid = await createProject();
    for (let g = 1; g <= 5; g++) {
      await seedRun(pid, { startTime: new Date(Date.UTC(2026, 0, g)) });
    }

    const res = await callApi(`/api/v1/projects/${pid}/jobs?limit=2`, { token: ids.humanToken });
    expect(res.status).toBe(200);
    const rows = envelopeData(res.json);
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0]!.startTime as string).getUTCDate()).toBe(5);
    expect(new Date(rows[1]!.startTime as string).getUTCDate()).toBe(4);
  });

  test("invalid limit (0, non-integer) → 400 validation", async () => {
    const pid = await createProject();
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await callApi(`/api/v1/projects/${pid}/jobs?limit=${bad}`, { token: ids.humanToken });
      expect(res.status).toBe(400);
      expect(envelopeError(res.json).code).toBe("validation");
    }
  });

  // ══ errors & scope ══════════════════════════════════════════════════════════

  test("missing project → 404 not_found", async () => {
    const res = await callApi(`/api/v1/projects/proj_${randomUUID()}/jobs`, { token: ids.humanToken });
    expect(res.status).toBe(404);
    expect(envelopeError(res.json).code).toBe("not_found");
  });

  test("token without core:read → 403 authorization", async () => {
    const pid = await createProject();
    await seedRun(pid);
    const token = await mintTokenWithoutRead();
    const res = await callApi(`/api/v1/projects/${pid}/jobs`, { token });
    expect(res.status).toBe(403);
    expect(envelopeError(res.json).code).toBe("authorization");
  });
});
