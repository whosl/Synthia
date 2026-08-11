/**
 * Synthia Core — approval vertical slice integration tests (real PostgreSQL)
 *
 * These tests assert observable DATABASE behavior of the approval slice:
 * authorization (human only, project-scoped role), exact snapshot/hash/member
 * binding, G1/G3/G4/G7/G9 → B0/B1/B2/B3/B4 baseline mapping, G2/G5/G6/G8
 * producing no baseline, transactional rollback on failure, same-request replay
 * returning the cached result, same-key-different-hash stable conflict,
 * concurrency producing neither double approval nor duplicate outbox sequence,
 * and append-only UPDATE/DELETE rejection on governed records.
 *
 * They require a live PostgreSQL instance reachable via DATABASE_URL. When
 * DATABASE_URL is unset, the whole suite is explicitly skipped — skipped tests
 * are NOT counted as passing and are clearly marked as "not executed".
 *
 * No mocks, no SQL-source string assertions: every expectation reads committed
 * rows or relies on a real DB constraint/trigger firing.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyMigrations,
  truncateSlice,
  seedSlice,
  makeApproveInput,
  validRequestHash,
} from "./support/approval-harness.ts";
import {
  approveGateSubmission,
  type ApproveGateSubmissionInput,
  type ApproveGateSubmissionResult,
} from "../src/services/approval.ts";
import { ConflictError, InvariantError } from "../src/memory-repository.ts";
import { withTransaction, type TransactionClient } from "../src/db/repository.ts";

// The entire suite is skipped when no live database is configured. Skipped
// tests do not pass — they are reported as skipped, so a missing DATABASE_URL
// can never masquerade as green.
const DATABASE_URL = process.env.DATABASE_URL ?? "";

/**
 * Create and open a pg Client. `pg` is imported dynamically so the module
 * parses (and describe.skipIf gates) even where `pg` is absent (offline CI);
 * this only runs when DATABASE_URL is present. Used for the shared client and
 * the independent contender connection in the concurrency test.
 */
async function connectClient(): Promise<Client> {
  const { Client: PgClient } = await import("pg");
  const conn = new PgClient({ connectionString: DATABASE_URL });
  await conn.connect();
  return conn;
}

describe.skipIf(!DATABASE_URL)("approval slice — real PostgreSQL behavior", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
    await applyMigrations(client);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await truncateSlice(client);
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  // The service performs NO transaction control itself (by contract): it runs on
  // a checked-out transaction client. A real caller wraps it in one transaction
  // so the idempotency claim, all governed writes, and the outbox append commit
  // atomically — and roll back together on any failure.
  async function approve(conn: Client, input: ApproveGateSubmissionInput): Promise<ApproveGateSubmissionResult> {
    return withTransaction(conn as unknown as TransactionClient, (tx) => approveGateSubmission(tx, input));
  }

  async function countRows(table: string, column: string, projectId: string): Promise<number> {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [projectId]);
    return result.rows[0].n as number;
  }

  // outbox_events.sequence is bigint; node:pg returns bigints as strings, so
  // cast to int here to compare against the service's numeric outboxSequence.
  async function fetchOutbox(projectId: string): Promise<{ sequence: number; aggregate_type: string }[]> {
    const result = await client.query(
      "SELECT sequence::int AS sequence, aggregate_type FROM outbox_events WHERE project_id = $1 ORDER BY sequence",
      [projectId],
    );
    return result.rows as { sequence: number; aggregate_type: string }[];
  }

  // ── 1. authorized human approves a milestone gate ──────────────────────────

  test("authorized human with project role approves G1 and creates B0 baseline + ApprovedGateResult + monotonic outbox", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    const input = makeApproveInput(seed);

    const result = await approve(client, input);

    expect(result.approvalRecordId).toBeTruthy();
    expect(result.approvedGateResultId).toBe(input.approvedGateResultId);
    expect(result.baselineId).toBe(input.baselineId);
    expect(typeof result.outboxSequence).toBe("number");

    // ApprovalRecord committed with exact approver binding.
    const approval = await client.query(
      "SELECT approver_id, approver_role, decision, approved_gate_result_id FROM approval_record WHERE id = $1",
      [result.approvalRecordId],
    );
    expect(approval.rows).toHaveLength(1);
    expect(approval.rows[0].approver_id).toBe(seed.approverId);
    expect(approval.rows[0].approver_role).toBe("quality");
    expect(approval.rows[0].decision).toBe("approve");
    expect(approval.rows[0].approved_gate_result_id).toBe(input.approvedGateResultId);

    // ApprovedGateResult links approval ↔ submission ↔ snapshot.
    const agr = await client.query(
      "SELECT gate, gate_submission_id, approval_record_id, snapshot_id FROM approved_gate_result WHERE id = $1",
      [input.approvedGateResultId],
    );
    expect(agr.rows).toHaveLength(1);
    expect(agr.rows[0].gate).toBe("G1");
    expect(agr.rows[0].gate_submission_id).toBe(seed.gateSubmissionId);
    expect(agr.rows[0].approval_record_id).toBe(result.approvalRecordId);
    expect(agr.rows[0].snapshot_id).toBe(seed.snapshotId);

    // Baseline B0 created, bound to the approved result, snapshot-consistent.
    const baseline = await client.query(
      "SELECT kind, state, approved_gate_result_id, manifest_hash FROM baseline WHERE id = $1",
      [input.baselineId],
    );
    expect(baseline.rows).toHaveLength(1);
    expect(baseline.rows[0].kind).toBe("B0");
    expect(baseline.rows[0].state).toBe("active");
    expect(baseline.rows[0].approved_gate_result_id).toBe(input.approvedGateResultId);
    expect(baseline.rows[0].manifest_hash).toBe(seed.manifestHash);

    // Exactly one monotonic outbox event emitted in the same transaction.
    const outbox = await fetchOutbox(seed.projectId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].sequence).toBe(result.outboxSequence);
  });

  // ── 2. non-human actors are hard-denied (agent / connector / system) ───────

  test.each([
    ["agent"],
    ["connector"],
    ["system"],
  ])("%s actor is rejected at the approval boundary with no committed rows", async (actorType) => {
    const seed = await seedSlice(client, { gate: "G1", actorType, actorId: `actor_${actorType}` });
    const input = makeApproveInput(seed, {
      approver: { actorType: actorType as "human", actorId: seed.approverId },
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: `k_${actorType}` },
    });

    await expect(approve(client, input)).rejects.toThrow(InvariantError);

    expect(await countRows("approval_record", "project_id", seed.projectId)).toBe(0);
    expect(await countRows("approved_gate_result", "project_id", seed.projectId)).toBe(0);
    expect(await countRows("baseline", "project_id", seed.projectId)).toBe(0);
    expect(await fetchOutbox(seed.projectId)).toHaveLength(0);
  });

  // ── 3. human without a matching project role is denied ─────────────────────

  test("human approver id with no role assignment for the project is denied", async () => {
    const seed = await seedSlice(client, { gate: "G1", actorId: "authorized_human" });
    // Override approver to a human who has NO role_assignment row.
    const input = makeApproveInput(seed, {
      approver: { actorType: "human", actorId: "unauthorized_human" },
      idempotency: { actorType: "human", actorId: "unauthorized_human", projectId: seed.projectId, operation: "approve_gate", key: "no_role" },
    });

    await expect(approve(client, input)).rejects.toThrow(InvariantError);
    expect(await countRows("approval_record", "project_id", seed.projectId)).toBe(0);
  });

  // ── 4. cross-project authorization is denied (role in a different project) ─

  test("approver with a role in a different project cannot approve this submission", async () => {
    const seedA = await seedSlice(client, { gate: "G1", actorId: "shared_human", projectId: "projA" });
    // A second project where shared_human genuinely has a role.
    await seedSlice(client, { gate: "G1", actorId: "shared_human", projectId: "projB" });

    const input = makeApproveInput(seedA, {
      approver: { actorType: "human", actorId: "shared_human" },
      idempotency: { actorType: "human", actorId: "shared_human", projectId: seedA.projectId, operation: "approve_gate", key: "cross" },
    });

    // shared_human has a role in projB but NOT in projA's submission context.
    // (seedA assigned the role, so to make this a true cross-project denial we
    // remove projA's role assignment, leaving only projB's.)
    await client.query("DELETE FROM role_assignment WHERE project_id = 'projA'");

    await expect(approve(client, input)).rejects.toThrow(InvariantError);
    expect(await countRows("approval_record", "project_id", "projA")).toBe(0);
  });

  // ── 5. exact snapshot + hash + member binding ───────────────────────────────

  test("approval binds the exact configuration snapshot and manifest hash; a divergent snapshot is rejected", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    // Point the approval at a snapshot id that does not exist for this submission.
    const input = makeApproveInput(seed, {
      configurationSnapshotId: "snap_does_not_exist",
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: "bad_snap" },
    });

    await expect(approve(client, input)).rejects.toThrow(InvariantError);
    expect(await countRows("approved_gate_result", "project_id", seed.projectId)).toBe(0);
  });

  test("a snapshot that exists in the project but belongs to another submission is rejected with no writes", async () => {
    const seed1 = await seedSlice(client, { gate: "G1", projectId: "proj_snap_mismatch" });
    // A second, genuine snapshot in the SAME project (attached to its own submission).
    const seed2 = await seedSlice(client, { gate: "G1", projectId: "proj_snap_mismatch" });

    // Approve seed1's submission but present seed2's snapshot id. The snapshot is
    // real and project-scoped, so it passes the existence + project checks; it is
    // rejected at the submission<->snapshot binding (APPROVAL_PAYLOAD_MISMATCH).
    const input = makeApproveInput(seed1, {
      configurationSnapshotId: seed2.snapshotId,
      idempotency: { actorType: "human", actorId: seed1.approverId, projectId: seed1.projectId, operation: "approve_gate", key: "cross_submission_snapshot" },
    });

    let thrown: unknown;
    try {
      await approve(client, input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvariantError);
    expect((thrown as Error).message).toBe("APPROVAL_PAYLOAD_MISMATCH");

    // Rejection precedes every governed write and rolls back the idempotency
    // claim with the transaction — the project holds zero approval artifacts.
    expect(await countRows("approval_record", "project_id", seed1.projectId)).toBe(0);
    expect(await countRows("approved_gate_result", "project_id", seed1.projectId)).toBe(0);
    expect(await countRows("baseline", "project_id", seed1.projectId)).toBe(0);
    expect(await fetchOutbox(seed1.projectId)).toHaveLength(0);
    const idem = await client.query("SELECT count(*)::int AS n FROM idempotency_records WHERE project_id = $1", [seed1.projectId]);
    expect(idem.rows[0].n).toBe(0);
  });

  // ── 6. G1/G3/G4/G7/G9 produce B0/B1/B2/B3/B4 respectively ──────────────────

  test.each([
    ["G1", "B0"],
    ["G3", "B1"],
    ["G4", "B2"],
    ["G7", "B3"],
    ["G9", "B4"],
  ])("milestone gate %s creates baseline kind %s", async (gate, kind) => {
    const seed = await seedSlice(client, { gate });
    const input = makeApproveInput(seed, {
      baselineId: `bl_${gate}`,
      approvedGateResultId: `agr_${gate}`,
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: `ms_${gate}` },
    });

    const result = await approve(client, input);
    expect(result.baselineId).toBe(`bl_${gate}`);

    const baseline = await client.query("SELECT kind, state FROM baseline WHERE id = $1", [input.baselineId]);
    expect(baseline.rows[0].kind).toBe(kind);
    expect(baseline.rows[0].state).toBe("active");
  });

  // ── 7. non-milestone gates G2/G5/G6/G8 create no baseline ──────────────────

  test.each([
    ["G2"],
    ["G5"],
    ["G6"],
    ["G8"],
  ])("non-milestone gate %s creates ApprovedGateResult but NO baseline", async (gate) => {
    const seed = await seedSlice(client, { gate });
    const input = makeApproveInput(seed, {
      baselineId: null,
      approvedGateResultId: `agr_${gate}`,
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: `nm_${gate}` },
    });

    const result = await approve(client, input);
    expect(result.baselineId).toBeNull();

    const agr = await client.query("SELECT gate FROM approved_gate_result WHERE id = $1", [input.approvedGateResultId]);
    expect(agr.rows[0].gate).toBe(gate);
    expect(await countRows("baseline", "project_id", seed.projectId)).toBe(0);
  });

  // ── 8. a non-milestone gate that supplies a baselineId is rejected ─────────

  test("supplying a baseline for a non-milestone gate is rejected", async () => {
    const seed = await seedSlice(client, { gate: "G2" });
    const input = makeApproveInput(seed, {
      baselineId: "should_not_exist",
      approvedGateResultId: "agr_forbidden_bl",
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: "forbidden_bl" },
    });

    await expect(approve(client, input)).rejects.toThrow(InvariantError);
    expect(await countRows("baseline", "project_id", seed.projectId)).toBe(0);
  });

  // ── 9. a milestone gate that omits the baselineId is rejected ──────────────

  test("omitting the baseline for a milestone gate is rejected", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    const input = makeApproveInput(seed, {
      baselineId: null,
      approvedGateResultId: "agr_missing_bl",
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: "missing_bl" },
    });

    await expect(approve(client, input)).rejects.toThrow(InvariantError);
    expect(await countRows("baseline", "project_id", seed.projectId)).toBe(0);
  });

  // ── 10. transactional rollback on failure leaves nothing committed ─────────

  test("a failed approval leaves no approval_record, no result, no baseline, no outbox event", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    // Force a failure by pointing at a snapshot the submission does not reference.
    const input = makeApproveInput(seed, {
      configurationSnapshotId: "snap_divergent",
      idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key: "rollback_case" },
    });

    await expect(approve(client, input)).rejects.toThrow();

    expect(await countRows("approval_record", "project_id", seed.projectId)).toBe(0);
    expect(await countRows("approved_gate_result", "project_id", seed.projectId)).toBe(0);
    expect(await countRows("baseline", "project_id", seed.projectId)).toBe(0);
    expect(await fetchOutbox(seed.projectId)).toHaveLength(0);
  });

  test("a failure after the ApprovalRecord is appended still rolls back every governed write and the in_progress idempotency claim", async () => {
    // First G1 approval in this project commits an active B0 baseline.
    const seed1 = await seedSlice(client, { gate: "G1", projectId: "proj_rollback_after_write" });
    await approve(client, makeApproveInput(seed1, {
      idempotency: { actorType: "human", actorId: seed1.approverId, projectId: seed1.projectId, operation: "approve_gate", key: "first_g1" },
    }));

    // A second G1 submission in the SAME project: its own snapshot/result are
    // consistent, but creating its baseline inserts another active B0 and hits
    // baseline_unique_active_project_kind -- a failure that occurs AFTER
    // appendApprovalRecord + createApprovedGateResult + the idempotency claim.
    const seed2 = await seedSlice(client, { gate: "G1", projectId: "proj_rollback_after_write" });
    const collide = makeApproveInput(seed2, {
      idempotency: { actorType: "human", actorId: seed2.approverId, projectId: seed2.projectId, operation: "approve_gate", key: "second_g1_collide" },
    });

    await expect(approve(client, collide)).rejects.toThrow();

    // Only the first approval's governed rows survive; the second attempt left
    // nothing -- not even the baseline that failed mid-insert.
    expect(await countRows("approval_record", "project_id", seed1.projectId)).toBe(1);
    expect(await countRows("approved_gate_result", "project_id", seed1.projectId)).toBe(1);
    expect(await countRows("baseline", "project_id", seed1.projectId)).toBe(1);
    expect(await fetchOutbox(seed1.projectId)).toHaveLength(1);

    // The second attempt's approved_gate_result and baseline ids must not exist.
    const agr2 = await client.query("SELECT 1 FROM approved_gate_result WHERE id = $1", [collide.approvedGateResultId]);
    expect(agr2.rows).toHaveLength(0);
    const bl2 = await client.query("SELECT 1 FROM baseline WHERE id = $1", [collide.baselineId]);
    expect(bl2.rows).toHaveLength(0);

    // The in_progress idempotency placeholder for the second attempt rolled back
    // with the transaction -- only the first (completed) claim remains.
    const idem = await client.query(
      "SELECT idempotency_key, status FROM idempotency_records WHERE project_id = $1 ORDER BY idempotency_key",
      [seed1.projectId],
    );
    expect(idem.rows).toHaveLength(1);
    expect(idem.rows[0].idempotency_key).toBe("first_g1");
    expect(idem.rows[0].status).toBe("completed");
  });

  // ── 11. same scope + same request hash replay returns the original result ──

  test("replaying the same idempotency scope and request hash returns the cached result with no new rows", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    const baseInput = makeApproveInput(seed, {
      requestHash: validRequestHash({ a: 1, b: { c: 2 } }),
    });
    // Canonical hash is key-order independent; feed reordered payload to prove it.
    const replayPayload = { b: { c: 2 }, a: 1 };
    const replayInput = makeApproveInput(seed, {
      requestHash: validRequestHash(replayPayload),
      // Same idempotency key as base.
      idempotency: baseInput.idempotency,
    });

    const first = await approve(client, baseInput);
    const replay = await approve(client, replayInput);

    expect(replay.approvalRecordId).toBe(first.approvalRecordId);
    expect(replay.approvedGateResultId).toBe(first.approvedGateResultId);
    expect(replay.baselineId).toBe(first.baselineId);
    expect(replay.outboxSequence).toBe(first.outboxSequence);

    // No duplicate rows — still exactly one of each.
    expect(await countRows("approval_record", "project_id", seed.projectId)).toBe(1);
    expect(await countRows("approved_gate_result", "project_id", seed.projectId)).toBe(1);
    expect(await countRows("baseline", "project_id", seed.projectId)).toBe(1);
    expect(await fetchOutbox(seed.projectId)).toHaveLength(1);
  });

  // ── 12. same idempotency key, different request hash is a stable conflict ──

  test("same idempotency key with a different canonical request hash raises a stable conflict", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    const first = makeApproveInput(seed, { requestHash: validRequestHash({ a: 1 }) });
    await approve(client, first);

    const conflicting = makeApproveInput(seed, {
      requestHash: validRequestHash({ a: 999 }), // different canonical payload
      idempotency: first.idempotency,            // same scope key
    });

    await expect(approve(client, conflicting)).rejects.toThrow(ConflictError);
    // No second approval/result/baseline/outbox.
    expect(await countRows("approval_record", "project_id", seed.projectId)).toBe(1);
    expect(await fetchOutbox(seed.projectId)).toHaveLength(1);
  });

  // ── 13. concurrency: two approvals for the same submission do not double ──

  test("concurrent approvals for the same gate submission cannot both commit an ApprovedGateResult", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    const build = (key: string, resultId: string) =>
      makeApproveInput(seed, {
        approvedGateResultId: resultId,
        baselineId: `bl_${key}`,
        idempotency: { actorType: "human", actorId: seed.approverId, projectId: seed.projectId, operation: "approve_gate", key },
      });

    const a = build("concurrent_a", "agr_concurrent_a");
    const b = build("concurrent_b", "agr_concurrent_b");

    // Use a SECOND independent connection so the two approvals genuinely race
    // on the server instead of serializing on one client's send queue. The
    // DB-level UNIQUE(gate_submission_id) on approved_gate_result — plus any
    // advisory lock the service holds — must ensure only one commits.
    const contender = await connectClient();
    try {
      const settled = await Promise.allSettled([
        approve(client, a),
        approve(contender, b),
      ]);
      const outcomes = settled.map((s) => s.status);

      // Exactly one wins; the other is rejected. Both succeeding would be a
      // contract violation (double approval / duplicate result).
      expect(outcomes.filter((s) => s === "fulfilled").length).toBe(1);
      expect(outcomes.filter((s) => s === "rejected").length).toBe(1);

      // Exactly one ApprovedGateResult row for the submission survived, and
      // at most one active baseline per (project, kind).
      expect(await countRows("approved_gate_result", "project_id", seed.projectId)).toBe(1);
      const activeBaselines = await client.query(
        "SELECT count(*)::int AS n FROM baseline WHERE project_id = $1 AND state = 'active'",
        [seed.projectId],
      );
      expect(activeBaselines.rows[0].n).toBeLessThanOrEqual(1);
    } finally {
      await contender.end();
    }
  });

  // ── 14. append-only: UPDATE and DELETE are rejected on governed records ────

  test("approval_record, approved_gate_result and baseline reject UPDATE and DELETE", async () => {
    const seed = await seedSlice(client, { gate: "G1" });
    const input = makeApproveInput(seed);
    const result = await approve(client, input);

    // UPDATE attempts must fail-closed.
    await expect(client.query("UPDATE approval_record SET reason = 'tampered' WHERE id = $1", [result.approvalRecordId]))
      .rejects.toThrow();
    await expect(client.query("UPDATE approved_gate_result SET gate = 'G9' WHERE id = $1", [input.approvedGateResultId]))
      .rejects.toThrow();
    await expect(client.query("UPDATE baseline SET state = 'retired' WHERE id = $1", [input.baselineId]))
      .rejects.toThrow();

    // DELETE attempts must fail-closed.
    await expect(client.query("DELETE FROM baseline WHERE id = $1", [input.baselineId])).rejects.toThrow();
    await expect(client.query("DELETE FROM approved_gate_result WHERE id = $1", [input.approvedGateResultId])).rejects.toThrow();
    await expect(client.query("DELETE FROM approval_record WHERE id = $1", [result.approvalRecordId])).rejects.toThrow();

    // And the rows are intact (unchanged) after the rejected mutations.
    const untouched = await client.query(
      `SELECT (SELECT count(*) FROM approval_record WHERE id = $1 AND reason <> 'tampered') AS ar,
              (SELECT count(*) FROM approved_gate_result WHERE id = $2 AND gate = 'G1') AS agr,
              (SELECT count(*) FROM baseline WHERE id = $3 AND state = 'active') AS bl`,
      [result.approvalRecordId, input.approvedGateResultId, input.baselineId],
    );
    expect(untouched.rows[0].ar).toBe("1");
    expect(untouched.rows[0].agr).toBe("1");
    expect(untouched.rows[0].bl).toBe("1");
  });

  // ── 15. outbox emits no duplicate sequence numbers per aggregate ───────────

  test("two approvals in one project emit outbox events with distinct, per-aggregate monotonic sequences", async () => {
    // First approval.
    const seed1 = await seedSlice(client, { gate: "G1", projectId: "proj_seq" });
    const r1 = await approve(client, makeApproveInput(seed1, {
      idempotency: { actorType: "human", actorId: seed1.approverId, projectId: "proj_seq", operation: "approve_gate", key: "seq1" },
    }));

    // Second approval — a fresh submission/baseline in the same project.
    const seed2 = await seedSlice(client, { gate: "G3", projectId: "proj_seq" });
    const r2 = await approve(client, makeApproveInput(seed2, {
      idempotency: { actorType: "human", actorId: seed2.approverId, projectId: "proj_seq", operation: "approve_gate", key: "seq2" },
    }));

    // Observe the real committed outbox events for this project and verify the
    // per-aggregate monotonic invariant (UNIQUE(aggregate_type, aggregate_id,
    // sequence)) directly — no assumption about how the service scopes aggregates.
    const events = await client.query(
      "SELECT aggregate_type, aggregate_id, sequence::int AS sequence FROM outbox_events WHERE project_id = $1 ORDER BY occurred_at",
      ["proj_seq"],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(2);

    const byAggregate = new Map<string, number[]>();
    for (const row of events.rows as { aggregate_type: string; aggregate_id: string; sequence: number }[]) {
      const key = `${row.aggregate_type}|${row.aggregate_id}`;
      const list = byAggregate.get(key) ?? [];
      list.push(row.sequence);
      byAggregate.set(key, list);
    }
    for (const [, sequences] of byAggregate) {
      // Within a single aggregate the sequence is strictly increasing...
      const sorted = [...sequences].sort((a, b) => a - b);
      expect(sorted).toEqual(sequences);
      // ...and never repeats (the DB UNIQUE(aggregate_type, aggregate_id,
      // sequence) constraint is the load-bearing guarantee; assert it held).
      expect(new Set(sequences).size).toBe(sequences.length);
    }

    // The two returned sequence numbers themselves are valid positive integers.
    expect(r1.outboxSequence).toBeGreaterThan(0);
    expect(r2.outboxSequence).toBeGreaterThan(0);
  });
});

// Explicit, loud marker that the suite did not run when no DB is available.
// Guarded at module level (NOT describe.skipIf): under DATABASE_URL this block
// is never registered, so the real suite reports 0 skips. Without DATABASE_URL
// it registers exactly one skipped test -- a loud, visible skip, never a
// zero-assertion pass that could masquerade as green. (Previously the guard was
// inverted: skipIf(!!DATABASE_URL) ran the empty marker test under no-DB,
// producing a false pass.)
if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; real PostgreSQL behavior tests were not executed", () => {});
}
