/**
 * Synthia Core — gate submission lifecycle integration tests (real PostgreSQL)
 *
 * Exercises the submit / withdraw / GET endpoints for the GJB gate flow:
 *   - submit drives preparing → in_review via the legal state-machine pipeline,
 *     records submitted_at, and appends a gate_submission.submitted_for_review
 *     outbox event;
 *   - withdraw is a single direct edge to withdrawn (legal from
 *     preparing/submitted/in_review, not from checking) with its own event;
 *   - GET returns the current state for approval-result polling;
 *   - idempotency: same-key replay, already-in-review no-op (different key),
 *     and same-key-different-body conflict;
 *   - illegal-transition matrix (approved/withdrawn/checking → 409), including a
 *     real G1 approval driving a submission to `approved` before re-submitting;
 *   - 404 (missing / cross-project submission / missing project) and the
 *     coarse scope guard (readOnly token lacking core:write → 403).
 *
 * Requires DATABASE_URL. When unset the whole suite is explicitly skipped —
 * skipped tests never count as passing (no fake green). Every expectation reads
 * committed rows or relies on a real DB constraint.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../src/hashing.ts";
import type { ApiHarness } from "./support/api-harness.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  truncateDomainTables,
} from "./support/api-harness.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

describe.skipIf(!DATABASE_URL)("gate flow — real PostgreSQL behavior", () => {
  let harness: ApiHarness;
  let baseUrl: string;
  let humanToken: string;
  let serviceToken: string;
  let humanUid: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    harness = await setupApiHarness(DATABASE_URL);
    baseUrl = harness.baseUrl;
    humanToken = harness.ids.humanToken;
    serviceToken = harness.ids.serviceToken;
    humanUid = harness.ids.humanUid;
    readOnlyToken = harness.ids.readOnlyToken;
  });

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
  });

  // ── helpers ────────────────────────────────────────────────────────────────

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

  async function countRows(table: string, where: string, values: unknown[]): Promise<number> {
    const r = await harness.client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
    return r.rows[0]!.n as number;
  }

  async function submissionState(submissionId: string): Promise<string> {
    const r = await harness.client.query("SELECT state FROM gate_submission WHERE id = $1", [submissionId]);
    return r.rows[0]!.state as string;
  }

  async function countOutbox(submissionId: string, eventType: string): Promise<number> {
    return countRows("outbox_events", "aggregate_id = $1 AND event_type = $2", [submissionId, eventType]);
  }

  /** POST .../submit helper. */
  function submitCall(projectId: string, submissionId: string, key: string, token = humanToken, body: unknown = {}) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/submit`, {
      method: "POST", body, token, headers: { "idempotency-key": key },
    });
  }

  function withdrawCall(projectId: string, submissionId: string, key: string, token = humanToken) {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/withdraw`, {
      method: "POST", body: {}, token, headers: { "idempotency-key": key },
    });
  }

  /**
   * Build the prerequisite graph ending in a gate_submission in state `preparing`
   * (project + process instance + revision + snapshot + submission). Optionally
   * seeds the `quality` role for the human (needed only for the approval path).
   */
  async function buildSubmissionGraph(
    gate: string,
    opts: { seedRole?: boolean } = {},
  ): Promise<{ projectId: string; processInstanceId: string; snapshotId: string; submissionId: string; revisionId: string }> {
    const projectId = `proj_${randomUUID()}`;
    const res = await apiCall(baseUrl, "/api/v1/projects", { method: "POST", body: { id: projectId, name: `Project ${projectId}` }, token: humanToken, headers: { "idempotency-key": `k_proj_${projectId}` } });
    if (res.status !== 201) throw new Error(`createProject failed: ${JSON.stringify(res.json)}`);

    const processInstanceId = `proc_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/process-instances`, { method: "POST", body: { id: processInstanceId, gate_profile_version: "flow-v1", current_gate: gate }, token: humanToken, headers: { "idempotency-key": `k_pi_${projectId}` } });

    if (opts.seedRole !== false) {
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/role-assignments`, { method: "POST", body: { id: `role_${randomUUID()}`, actor_type: "human", actor_id: humanUid, role: "quality" }, token: humanToken, headers: { "idempotency-key": `k_role_${projectId}` } });
    }

    const aid = `art_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${aid}/revisions`, { method: "POST", body: { id: revisionId, version: 1, content_hash: sha256Hex("content"), content_location: "mem://g" }, token: humanToken, headers: { "idempotency-key": `k_rev_${projectId}` } });

    const snapshotId = `snap_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/snapshots`, { method: "POST", body: { id: snapshotId, member_revision_ids: [revisionId], tool_model_policy_hash: sha256Hex("policy") }, token: humanToken, headers: { "idempotency-key": `k_snap_${projectId}` } });

    const submissionId = `sub_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, { method: "POST", body: { id: submissionId, process_instance_id: processInstanceId, gate, snapshot_id: snapshotId }, token: humanToken, headers: { "idempotency-key": `k_sub_${projectId}` } });

    return { projectId, processInstanceId, snapshotId, submissionId, revisionId };
  }

  /** Drive a submission all the way through a real G1 approval to state `approved`. */
  async function approveToApproved(graph: { projectId: string; submissionId: string; snapshotId: string }): Promise<void> {
    const agrId = `agr_${randomUUID()}`;
    const blId = `bl_${randomUUID()}`;
    const res = await apiCall(baseUrl, `/api/v1/projects/${graph.projectId}/gate-submissions/${graph.submissionId}/approve`, {
      method: "POST",
      body: { configuration_snapshot_id: graph.snapshotId, approved_gate_result_id: agrId, baseline_id: blId, check_results_hash: sha256Hex("checks"), signed_at: new Date().toISOString() },
      token: humanToken,
      headers: { "idempotency-key": `k_approve_${graph.submissionId}` },
    });
    if (res.status !== 200) throw new Error(`approve failed: ${JSON.stringify(res.json)}`);
  }

  // ══ 1. SUBMIT HAPPY PATH ═══════════════════════════════════════════════════

  describe("submit happy path", () => {
    test("preparing → in_review: DB state, submitted_at, outbox event", async () => {
      const g = await buildSubmissionGraph("G2");

      // before: preparing, no submitted_at
      const before = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions/${g.submissionId}`, { token: humanToken });
      expect(before.status).toBe(200);
      expect(envelopeData(before.json).state).toBe("preparing");
      expect(envelopeData(before.json).submitted_at).toBeNull();

      const res = await submitCall(g.projectId, g.submissionId, "k_submit_1");
      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      expect(data.state).toBe("in_review");
      expect(data.id).toBe(g.submissionId);
      expect(data.project_id).toBe(g.projectId);
      expect(data.submitted_at).not.toBeNull();

      // committed DB state
      expect(await submissionState(g.submissionId)).toBe("in_review");
      const row = await harness.client.query("SELECT state, submitted_at, submitter_id FROM gate_submission WHERE id = $1", [g.submissionId]);
      expect(row.rows[0]!.state).toBe("in_review");
      expect(row.rows[0]!.submitted_at).not.toBeNull();
      expect(row.rows[0]!.submitter_id).toBe(humanUid);

      // outbox event
      expect(await countOutbox(g.submissionId, "gate_submission.submitted_for_review")).toBe(1);
    });

    test("service identity (core:write) can submit", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await submitCall(g.projectId, g.submissionId, "k_submit_svc", serviceToken);
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).state).toBe("in_review");
      expect(await submissionState(g.submissionId)).toBe("in_review");
    });
  });

  // ══ 2. GET FIELD COMPLETENESS ══════════════════════════════════════════════

  describe("GET gate-submission", () => {
    test("returns all contract fields after submit", async () => {
      const g = await buildSubmissionGraph("G2");
      await submitCall(g.projectId, g.submissionId, "k_get");
      const res = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions/${g.submissionId}`, { token: humanToken });
      expect(res.status).toBe(200);
      const data = envelopeData(res.json);
      for (const field of ["id", "project_id", "process_instance_id", "gate", "snapshot_id", "state", "submitter_id", "check_results", "issues", "submitted_at", "created_at"]) {
        expect(field in data).toBe(true);
      }
      expect(data.state).toBe("in_review");
      expect(data.gate).toBe("G2");
    });

    test("read-only token can GET (core:read)", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions/${g.submissionId}`, { token: readOnlyToken });
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).state).toBe("preparing");
    });
  });

  // ══ 3. WITHDRAW HAPPY PATH ═════════════════════════════════════════════════

  describe("withdraw happy path", () => {
    test("in_review → withdrawn: DB state + outbox event", async () => {
      const g = await buildSubmissionGraph("G2");
      await submitCall(g.projectId, g.submissionId, "k_w_sub");
      expect(await submissionState(g.submissionId)).toBe("in_review");

      const res = await withdrawCall(g.projectId, g.submissionId, "k_wd_1");
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).state).toBe("withdrawn");
      expect(await submissionState(g.submissionId)).toBe("withdrawn");
      expect(await countOutbox(g.submissionId, "gate_submission.withdrawn")).toBe(1);
    });

    test("preparing → withdrawn is legal (direct edge)", async () => {
      const g = await buildSubmissionGraph("G2");
      // still preparing — withdraw without submitting first
      const res = await withdrawCall(g.projectId, g.submissionId, "k_wd_prep");
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).state).toBe("withdrawn");
      expect(await submissionState(g.submissionId)).toBe("withdrawn");
    });
  });

  // ══ 4. IDEMPOTENCY ═════════════════════════════════════════════════════════

  describe("idempotency", () => {
    test("submit same key replays stored response, no duplicate event", async () => {
      const g = await buildSubmissionGraph("G2");
      const first = await submitCall(g.projectId, g.submissionId, "k_replay");
      expect(first.status).toBe(200);
      const second = await submitCall(g.projectId, g.submissionId, "k_replay");
      expect(second.status).toBe(200);
      expect(envelopeData(second.json)).toEqual(envelopeData(first.json));
      expect(await countOutbox(g.submissionId, "gate_submission.submitted_for_review")).toBe(1);
    });

    test("submit already in_review with a different key is a no-op (200, no new event)", async () => {
      const g = await buildSubmissionGraph("G2");
      const a = await submitCall(g.projectId, g.submissionId, "k_diff_a");
      expect(a.status).toBe(200);
      const b = await submitCall(g.projectId, g.submissionId, "k_diff_b");
      expect(b.status).toBe(200);
      expect(envelopeData(b.json).state).toBe("in_review");
      // no-op path emits no additional event
      expect(await countOutbox(g.submissionId, "gate_submission.submitted_for_review")).toBe(1);
      expect(await submissionState(g.submissionId)).toBe("in_review");
    });

    test("submit same key + different body → 409 conflict", async () => {
      const g = await buildSubmissionGraph("G2");
      await submitCall(g.projectId, g.submissionId, "k_conflict", humanToken, {});
      const dup = await submitCall(g.projectId, g.submissionId, "k_conflict", humanToken, { unexpected: 1 });
      expect(dup.status).toBe(409);
      expect(envelopeError(dup.json).code).toBe("conflict");
    });

    test("withdraw already withdrawn is idempotent (different key, no new event)", async () => {
      const g = await buildSubmissionGraph("G2");
      await submitCall(g.projectId, g.submissionId, "k_wd_idem_sub");
      await withdrawCall(g.projectId, g.submissionId, "k_wd_idem_1");
      const again = await withdrawCall(g.projectId, g.submissionId, "k_wd_idem_2");
      expect(again.status).toBe(200);
      expect(envelopeData(again.json).state).toBe("withdrawn");
      expect(await countOutbox(g.submissionId, "gate_submission.withdrawn")).toBe(1);
    });

    test("submit / withdraw require Idempotency-Key → 400 validation", async () => {
      const g = await buildSubmissionGraph("G2");
      const s = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions/${g.submissionId}/submit`, { method: "POST", body: {}, token: humanToken });
      expect(s.status).toBe(400);
      expect(envelopeError(s.json).code).toBe("validation");
      const w = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions/${g.submissionId}/withdraw`, { method: "POST", body: {}, token: humanToken });
      expect(w.status).toBe(400);
      expect(envelopeError(w.json).code).toBe("validation");
    });
  });

  // ══ 5. ILLEGAL TRANSITION MATRIX (state machine is authoritative) ══════════

  describe("illegal-transition matrix (409 conflict)", () => {
    test("approved → submit yields 409 (after a real G1 approval)", async () => {
      const g = await buildSubmissionGraph("G1", { seedRole: true });
      await submitCall(g.projectId, g.submissionId, "k_approved_sub");
      expect(await submissionState(g.submissionId)).toBe("in_review");
      await approveToApproved(g);
      expect(await submissionState(g.submissionId)).toBe("approved");

      const res = await submitCall(g.projectId, g.submissionId, "k_approved_resubmit");
      expect(res.status).toBe(409);
      expect(envelopeError(res.json).code).toBe("conflict");
      // state unchanged
      expect(await submissionState(g.submissionId)).toBe("approved");
    });

    test("approved → withdraw yields 409", async () => {
      const g = await buildSubmissionGraph("G1", { seedRole: true });
      await submitCall(g.projectId, g.submissionId, "k_approved_wd_sub");
      await approveToApproved(g);
      const res = await withdrawCall(g.projectId, g.submissionId, "k_approved_wd");
      expect(res.status).toBe(409);
      expect(envelopeError(res.json).code).toBe("conflict");
    });

    test("withdrawn → submit yields 409", async () => {
      const g = await buildSubmissionGraph("G2");
      await withdrawCall(g.projectId, g.submissionId, "k_w_then_s_wd");
      expect(await submissionState(g.submissionId)).toBe("withdrawn");
      const res = await submitCall(g.projectId, g.submissionId, "k_w_then_s_sub");
      expect(res.status).toBe(409);
      expect(envelopeError(res.json).code).toBe("conflict");
    });

    test("checking → withdraw yields 409 (no direct machine edge)", async () => {
      const g = await buildSubmissionGraph("G2");
      // checking is an intermediate state; place it directly (as the harness does
      // for in_review) to exercise the handler's machine check at the boundary.
      await harness.client.query("UPDATE gate_submission SET state = 'checking' WHERE id = $1", [g.submissionId]);
      const res = await withdrawCall(g.projectId, g.submissionId, "k_checking_wd");
      expect(res.status).toBe(409);
      expect(envelopeError(res.json).code).toBe("conflict");
      expect(await submissionState(g.submissionId)).toBe("checking");
    });

    test("checking → submit drives forward to in_review (pipeline traversal)", async () => {
      const g = await buildSubmissionGraph("G2");
      await harness.client.query("UPDATE gate_submission SET state = 'checking' WHERE id = $1", [g.submissionId]);
      const res = await submitCall(g.projectId, g.submissionId, "k_checking_sub");
      expect(res.status).toBe(200);
      expect(envelopeData(res.json).state).toBe("in_review");
      expect(await submissionState(g.submissionId)).toBe("in_review");
      expect(await countOutbox(g.submissionId, "gate_submission.submitted_for_review")).toBe(1);
    });

    test("rejected → submit yields 409", async () => {
      const g = await buildSubmissionGraph("G2");
      await harness.client.query("UPDATE gate_submission SET state = 'rejected' WHERE id = $1", [g.submissionId]);
      const res = await submitCall(g.projectId, g.submissionId, "k_rejected_sub");
      expect(res.status).toBe(409);
      expect(envelopeError(res.json).code).toBe("conflict");
    });
  });

  // ══ 6. NOT FOUND (404) ═════════════════════════════════════════════════════

  describe("not found (404)", () => {
    test("submit unknown submission → 404", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await submitCall(g.projectId, "sub_does_not_exist", "k_404_sub");
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });

    test("submit existing submission under wrong project → 404", async () => {
      const a = await buildSubmissionGraph("G2");
      const b = await buildSubmissionGraph("G2");
      const res = await submitCall(b.projectId, a.submissionId, "k_404_xproj");
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
      // the real owner is untouched
      expect(await submissionState(a.submissionId)).toBe("preparing");
    });

    test("submit under unknown project → 404", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await submitCall("proj_does_not_exist", g.submissionId, "k_404_proj");
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });

    test("GET unknown submission → 404", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions/sub_ghost`, { token: humanToken });
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });

    test("withdraw unknown submission → 404", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await withdrawCall(g.projectId, "sub_does_not_exist", "k_404_wd");
      expect(res.status).toBe(404);
      expect(envelopeError(res.json).code).toBe("not_found");
    });
  });

  // ══ 7. SCOPE GUARD (403) ═══════════════════════════════════════════════════

  describe("scope guard (missing core:write → 403)", () => {
    test("read-only token cannot submit → 403, no state change", async () => {
      const g = await buildSubmissionGraph("G2");
      const res = await submitCall(g.projectId, g.submissionId, "k_ro_submit", readOnlyToken);
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
      expect(await submissionState(g.submissionId)).toBe("preparing");
    });

    test("read-only token cannot withdraw → 403, no state change", async () => {
      const g = await buildSubmissionGraph("G2");
      await submitCall(g.projectId, g.submissionId, "k_ro_wd_sub");
      const res = await withdrawCall(g.projectId, g.submissionId, "k_ro_wd", readOnlyToken);
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
      expect(await submissionState(g.submissionId)).toBe("in_review");
    });
  });
});

// Explicit, loud marker that the suite did not run when no DB is available.
if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; gate-flow real PostgreSQL tests were not executed", () => {});
}
