/**
 * Synthia Core — API slice integration test harness (real PostgreSQL)
 *
 * Applies migrations, provisions platform identities + tokens (plaintext kept
 * in-process, only SHA-256 hashes persisted), and starts the real Bun.serve
 * API against a pg Pool. Domain tables are truncated between tests while the
 * identity tables (user_account / auth_token) are preserved so tokens stay
 * valid for the whole suite.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { sha256Hex } from "../../src/hashing.ts";
import { startSynthiaServer, type SynthiaServer } from "../../src/api/server.ts";
import { applyMigrations } from "./approval-harness.ts";

/** Domain tables wiped per test (identity tables are intentionally NOT here). */
const DOMAIN_TABLES = [
  "baseline",
  "approved_gate_result",
  "approval_record",
  "gate_submission",
  "configuration_snapshot",
  "artifact_revision",
  "trace_relation",
  "artifact",
  "role_assignment",
  "process_instance",
  "tool_run",
  "evidence",
  "outbox_events",
  "idempotency_records",
  "project",
] as const;

export interface BootstrapIdentities {
  humanUid: string;
  serviceUid: string;
  humanToken: string;
  serviceToken: string;
  readOnlyToken: string;
  revokedToken: string;
  expiredToken: string;
}

function mintToken(): string {
  return randomBytes(32).toString("hex");
}

/** Insert human + service identities with tokens; also a revoked + expired token. */
export async function bootstrapIdentities(client: Client): Promise<BootstrapIdentities> {
  const humanUid = `human_${randomUUID()}`;
  const serviceUid = `svc_${randomUUID()}`;
  const humanId = `usr_${randomUUID()}`;
  const serviceId = `usr_${randomUUID()}`;

  await client.query(
    `INSERT INTO user_account (id, uid, cn, display_name, mail, actor_type, status)
     VALUES ($1,$2,'Human Tester','Human Tester','human@test.local','human','active')`,
    [humanId, humanUid],
  );
  await client.query(
    `INSERT INTO user_account (id, uid, cn, display_name, mail, actor_type, status)
     VALUES ($1,$2,'Service Tester','Service Tester','svc@test.local','service','active')`,
    [serviceId, serviceUid],
  );

  const humanToken = mintToken();
  const serviceToken = mintToken();
  const readOnlyToken = mintToken();
  const revokedToken = mintToken();
  const expiredToken = mintToken();

  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(humanToken), humanId, ["core:admin", "core:write", "core:read", "core:approve"]],
  );
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(serviceToken), serviceId, ["core:write", "core:read"]],
  );
  // read-only token (human, only core:read — used for scope-guard tests)
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(readOnlyToken), humanId, ["core:read"]],
  );
  // revoked token (same human, already revoked)
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope, revoked_at) VALUES ($1,$2,$3, now())`,
    [sha256Hex(revokedToken), humanId, ["core:read"]],
  );
  // expired token (expiry in the past)
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope, expires_at) VALUES ($1,$2,$3, now() - interval '1 hour')`,
    [sha256Hex(expiredToken), humanId, ["core:read"]],
  );

  return { humanUid, serviceUid, humanToken, serviceToken, readOnlyToken, revokedToken, expiredToken };
}

/** Wipe domain tables (identity tables survive so tokens stay valid). */
export async function truncateDomainTables(client: Client): Promise<void> {
  const list = DOMAIN_TABLES.map((t) => `"${t}"`).join(", ");
  await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export interface ApiHarness {
  server: SynthiaServer;
  baseUrl: string;
  pool: Pool;
  client: Client;
  ids: BootstrapIdentities;
}

export async function setupApiHarness(connectionString: string): Promise<ApiHarness> {
  const { Client: PgClient, Pool } = await import("pg");
  const client = new PgClient({ connectionString }) as Client;
  // Dynamic import mirrors approval-slice.test.ts: the module must parse even
  // where `pg` is absent (offline); describe.skipIf(!DATABASE_URL) gates runs.
  await client.connect();
  await applyMigrations(client);
  const ids = await bootstrapIdentities(client);
  await truncateDomainTables(client);

  const pool = new Pool({ connectionString, max: 4 });
  const server = startSynthiaServer(pool, { port: 0 });
  const baseUrl = `http://${server.hostname}:${server.port}`;

  return { server, baseUrl, pool, client, ids };
}

export async function teardownApiHarness(harness: ApiHarness): Promise<void> {
  harness.server.stop();
  await harness.pool.end();
  await harness.client.end();
}

export interface ApiCallOpts {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

/** Perform an authenticated API call and return { status, json }. */
export async function apiCall(baseUrl: string, path: string, opts: ApiCallOpts = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
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
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, json, headers: response.headers };
}
