/**
 * Synthia Core — approval-slice integration test harness
 *
 * Real PostgreSQL behavior harness for the approval vertical slice tests.
 * Applies the numbered migrations exactly as `migrate()` would (sorted, guarded
 * by schema_migrations), seeds the prerequisite governed graph, and offers
 * canonical helpers that mirror the locked ApproveGateSubmissionInput contract.
 *
 * No mocks, no SQL-text assertions — every check observes committed DB state.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { sha256Hex, hashPayload } from "../../src/hashing.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_PATH = join(__dirname, "..", "..", "src", "db", "migrations");

/** Tables touched by the approval slice, in FK-safe order for truncation. */
const SLICE_TABLES = [
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

/**
 * Apply every numbered migration under src/db/migrations, in lexical order,
 * guarded by schema_migrations — identical semantics to src/db/client.ts
 * `migrate()`. Migration files wrap their own BEGIN/COMMIT; we strip the outer
 * transaction markers the same way the production runner does so each file
 * executes within the caller's transaction.
 */
export async function applyMigrations(client: Client): Promise<void> {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrations = readdirSync(MIGRATIONS_PATH)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const version = migration.replace(/\.sql$/, "");
    const present = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (present.rows.length > 0) continue;
    const raw = readFileSync(join(MIGRATIONS_PATH, migration), "utf-8");
    const sql = raw.replace(/^BEGIN;\s*/i, "").replace(/COMMIT;\s*$/i, "").trim();
    await client.query(sql);
  }
}

/** Wipe every slice table so each test starts from a pristine DB. */
export async function truncateSlice(client: Client): Promise<void> {
  if (SLICE_TABLES.length === 0) return;
  const list = SLICE_TABLES.map((t) => `"${t}"`).join(", ");
  await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/** Fixed deterministic seed data for the standard G1 milestone scenario. */
export interface SeedIds {
  readonly projectId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly snapshotId: string;
  readonly processInstanceId: string;
  readonly gateSubmissionId: string;
  readonly roleAssignmentId: string;
  readonly approverId: string;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly checkResultsHash: string;
}


/** Insert the prerequisite governed graph a valid approval needs. */
export async function seedSlice(
  client: Client,
  overrides: {
    readonly projectId?: string;
    readonly gate?: string;
    readonly actorType?: string;
    readonly actorId?: string;
    readonly role?: string;
    readonly manifestMembers?: readonly { id: string; sha256: string }[];
  } = {},
): Promise<SeedIds> {
  const projectId = overrides.projectId ?? `proj_${randomUUID()}`;
  const artifactId = `art_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  const snapshotId = `snap_${randomUUID()}`;
  const processInstanceId = `proc_${randomUUID()}`;
  const gateSubmissionId = `sub_${randomUUID()}`;
  const roleAssignmentId = `role_${randomUUID()}`;
  const approverId = overrides.actorId ?? `human_${randomUUID()}`;
  const gate = overrides.gate ?? "G1";

  const contentHash = sha256Hex("member-content");
  const members = overrides.manifestMembers ?? [{ id: revisionId, sha256: contentHash }];
  // Manifest hash is the sorted-normalized digest of the snapshot members
  // (computeManifestHash in src/hashing.ts). Baseline creation must bind to the
  // same manifest hash the snapshot recorded.
  const manifestHash = sha256Hex(
    [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((m) => `${m.id}:${m.sha256}`).join("\n"),
  );
  const checkResultsHash = sha256Hex("deterministic-check-results");

  // `project` is inserted idempotently so a test can seed multiple submissions
  // under one explicit projectId without a PK clash; every other entity stays a
  // bare INSERT so a genuine duplicate (a real bug) still surfaces.
  await client.query(
    `INSERT INTO project (id, name, scope, data_classification, standard_version, target_part, status)
     VALUES ($1,$2,$3,'D1','GB/T 33781-2017','xc7vx690tffg1761-2','active')
     ON CONFLICT (id) DO NOTHING`,
    [projectId, `Project ${projectId}`, ""],
  );
  await client.query(
    `INSERT INTO artifact (id, project_id, artifact_type, title) VALUES ($1,$2,'SYSTEM_REQUIREMENTS','Seed requirements')`,
    [artifactId, projectId],
  );
  await client.query(
    `INSERT INTO artifact_revision
       (id, artifact_id, project_id, version, state, parent_revision_id, content_hash, content_location,
        schema_version, source_ids, data_classification, tool_model_provenance, change_reason,
        created_by, created_by_type, review_ids)
     VALUES ($1,$2,$3,1,'approved',NULL,$4,'memory://seed','v1','{}','D1',NULL,'seed',$5,'human','{}')`,
    [revisionId, artifactId, projectId, contentHash, approverId],
  );
  await client.query(
    `INSERT INTO configuration_snapshot
       (id, project_id, member_revision_ids, trace_relation_ids, gate_profile_version,
        tool_model_policy_hash, manifest_hash, created_by)
     VALUES ($1,$2,$3,$4,'flow-v1', $5, $6, $7)`,
    [snapshotId, projectId, members.map((m) => m.id), [], sha256Hex("policy"), manifestHash, approverId],
  );
  await client.query(
    `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate) VALUES ($1,$2,'flow-v1', $3)`,
    [processInstanceId, projectId, gate],
  );
  await client.query(
    `INSERT INTO gate_submission (id, project_id, process_instance_id, gate, snapshot_id, state, submitter_id)
     VALUES ($1,$2,$3,$4,$5,'in_review', $6)`,
    [gateSubmissionId, projectId, processInstanceId, gate, snapshotId, approverId],
  );
  await client.query(
    `INSERT INTO role_assignment (id, project_id, actor_type, actor_id, role, permissions)
     VALUES ($1,$2,$3,$4,$5,'{}')`,
    [roleAssignmentId, projectId, overrides.actorType ?? "human", approverId, overrides.role ?? "quality"],
  );

  return {
    projectId, artifactId, revisionId, snapshotId, processInstanceId, gateSubmissionId, roleAssignmentId,
    approverId, contentHash, manifestHash, checkResultsHash,
  };
}

/** Canonical approval content for a positive G1 decision. */
export interface ApprovalContentInput {
  readonly approverRole: string;
  readonly authorizationBasis: string;
  readonly reason: string;
  readonly issues?: readonly string[];
  readonly risks?: readonly string[];
  readonly waivers?: readonly string[];
  readonly checkResultsHash: string;
  readonly signedAt: string;
  readonly signatureMethod: string;
  readonly clientAuditDigest: string | null;
}

export interface ApproveInput {
  readonly projectId: string;
  readonly gateSubmissionId: string;
  readonly configurationSnapshotId: string;
  readonly approver: { actorType: "human"; actorId: string };
  readonly approvalContent: ApprovalContentInput & { decision: "approve" };
  readonly approvedGateResultId: string;
  readonly baselineId: string | null;
  readonly idempotency: {
    actorType: "human";
    actorId: string;
    projectId: string;
    operation: "approve_gate";
    key: string;
  };
  readonly requestHash: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly classification: string;
}

/** Build a canonical ApproveGateSubmissionInput payload, with optional overrides. */
export function makeApproveInput(
  seed: SeedIds,
  overrides: Partial<ApproveInput> & { gate?: string; baselineId?: string | null } = {},
): ApproveInput {
  const baselineId = overrides.baselineId !== undefined ? overrides.baselineId : `bl_${randomUUID()}`;
  const approvedGateResultId = overrides.approvedGateResultId ?? `agr_${randomUUID()}`;
  const approverId = overrides.approver?.actorId ?? seed.approverId;
  const idempotencyKey = overrides.idempotency?.key ?? `idem_${randomUUID()}`;
  const base: ApproveInput = {
    projectId: seed.projectId,
    gateSubmissionId: seed.gateSubmissionId,
    configurationSnapshotId: seed.snapshotId,
    approver: { actorType: "human", actorId: approverId },
    approvalContent: {
      decision: "approve",
      approverRole: "quality",
      authorizationBasis: "role-bound approval",
      reason: "all checks pass",
      issues: [],
      risks: [],
      waivers: [],
      checkResultsHash: seed.checkResultsHash,
      signedAt: new Date("2026-08-11T00:00:00Z").toISOString(),
      signatureMethod: "platform_token",
      clientAuditDigest: null,
    },
    approvedGateResultId,
    baselineId,
    idempotency: {
      actorType: "human",
      actorId: approverId,
      projectId: seed.projectId,
      operation: "approve_gate",
      key: idempotencyKey,
    },
    requestHash: hashPayload({ canonical: true }),
    correlationId: `corr_${randomUUID()}`,
    causationId: null,
    classification: "D1",
  };
  return { ...base, ...overrides, approvalContent: { ...base.approvalContent, ...overrides.approvalContent } } as ApproveInput;
}

/** A 64-char lowercase-hex sha256, matching idempotency_records.request_hash CHECK. */
export function validRequestHash(payload: unknown = { ok: true }): string {
  return hashPayload(payload);
}

