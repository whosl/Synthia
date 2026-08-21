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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, Pool } from "pg";
import { sha256Hex } from "../../src/hashing.ts";
import {
  startSynthiaServer,
  type SynthiaServer,
  type SynthiaServerOptions,
} from "../../src/api/server.ts";
import { applyMigrations } from "./approval-harness.ts";

/** Domain tables wiped per test (identity tables are intentionally NOT here). */
const DOMAIN_TABLES = [
  "task_adoption_file",
  "task_adoption",
  "task_result",
  "task_workspace_file",
  "task_conversation_event",
  "task_workspace",
  "agent_task",
  "import_audit_event",
  "import_source_relation",
  "import_file_entry",
  "import_source",
  "import_snapshot",
  "project_source_relation",
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
  secondServiceUid: string;
  humanToken: string;
  /** Ordinary Core service credential (read/write only). */
  serviceToken: string;
  /** Task-bound Runtime callback credential (singleton task-runtime scope). */
  taskRuntimeToken: string;
  genericServiceToken: string;
  secondServiceToken: string;
  /** Historical invalid shape: generic and task-runtime scopes combined. */
  combinedServiceToken: string;
  /** Invalid shape proving task-runtime rejects even an unknown extra scope. */
  extendedTaskRuntimeToken: string;
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
  const secondServiceUid = `svc_other_${randomUUID()}`;
  const humanId = `usr_${randomUUID()}`;
  const serviceId = `usr_${randomUUID()}`;
  const secondServiceId = `usr_${randomUUID()}`;

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
  await client.query(
    `INSERT INTO user_account (id, uid, cn, display_name, mail, actor_type, status)
     VALUES ($1,$2,'Second Service','Second Service','svc-other@test.local','service','active')`,
    [secondServiceId, secondServiceUid],
  );

  const humanToken = mintToken();
  const serviceToken = mintToken();
  const taskRuntimeToken = mintToken();
  const genericServiceToken = mintToken();
  const secondServiceToken = mintToken();
  const combinedServiceToken = mintToken();
  const extendedTaskRuntimeToken = mintToken();
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
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(taskRuntimeToken), serviceId, ["core:task-runtime"]],
  );
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(genericServiceToken), serviceId, ["core:write", "core:read"]],
  );
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(secondServiceToken), secondServiceId, ["core:task-runtime"]],
  );
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(combinedServiceToken), serviceId, ["core:write", "core:read", "core:task-runtime"]],
  );
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope) VALUES ($1,$2,$3)`,
    [sha256Hex(extendedTaskRuntimeToken), serviceId, ["core:task-runtime", "custom:unexpected"]],
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

  return {
    humanUid,
    serviceUid,
    secondServiceUid,
    humanToken,
    serviceToken,
    taskRuntimeToken,
    genericServiceToken,
    secondServiceToken,
    combinedServiceToken,
    extendedTaskRuntimeToken,
    readOnlyToken,
    revokedToken,
    expiredToken,
  };
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
  /** 本次测试的工作区根目录（临时目录，teardown 时删除）。 */
  workspacesDir: string;
  /** setup 之前的 SYNTHIA_WORKSPACES_DIR，teardown 时还原。 */
  previousWorkspacesDir: string | undefined;
}

export interface ApiHarnessOptions {
  readonly features?: SynthiaServerOptions["features"];
  readonly runtimeClient?: SynthiaServerOptions["runtimeClient"];
  readonly connector?: SynthiaServerOptions["connector"];
  readonly runtimeActorId?: string;
}

export async function setupApiHarness(
  connectionString: string,
  options: ApiHarnessOptions = {},
): Promise<ApiHarness> {
  const { Client: PgClient, Pool } = await import("pg");
  const client = new PgClient({ connectionString }) as Client;
  // Dynamic import mirrors approval-slice.test.ts: the module must parse even
  // where `pg` is absent (offline); describe.skipIf(!DATABASE_URL) gates runs.
  await client.connect();
  await applyMigrations(client);
  const ids = await bootstrapIdentities(client);
  await truncateDomainTables(client);

  // 建项目会在磁盘上建真实工作区；不隔离的话测试会往 ~/.synthia/workspaces 里堆垃圾。
  const previousWorkspacesDir = process.env.SYNTHIA_WORKSPACES_DIR;
  const workspacesDir = await mkdtemp(join(tmpdir(), "synthia-test-ws-"));
  process.env.SYNTHIA_WORKSPACES_DIR = workspacesDir;

  const pool = new Pool({ connectionString, max: 4 });
  const server = startSynthiaServer(pool, {
    port: 0,
    features: options.features,
    runtimeClient: options.runtimeClient,
    runtimeActorId: options.runtimeActorId ?? ids.serviceUid,
    connector: options.connector,
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;

  return { server, baseUrl, pool, client, ids, workspacesDir, previousWorkspacesDir };
}

export async function teardownApiHarness(harness: ApiHarness): Promise<void> {
  harness.server.stop();
  await harness.pool.end();
  await harness.client.end();
  if (harness.previousWorkspacesDir === undefined) delete process.env.SYNTHIA_WORKSPACES_DIR;
  else process.env.SYNTHIA_WORKSPACES_DIR = harness.previousWorkspacesDir;
  await rm(harness.workspacesDir, { recursive: true, force: true });
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
