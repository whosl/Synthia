/**
 * Synthia Core — Web UI-1 API gaps integration tests (real PostgreSQL)
 *
 * Covers the Core-side contract items the Web UI-1 slice depends on:
 *   1. GET /projects — project list (core:read, created_at descending)
 *   2. GET /projects/:id/gate-submissions?state= — submission list (core:read)
 *   3. GET /projects/:id/artifacts + GET .../revisions — product-library reads
 *   4. POST .../revisions inline content (server-computed content_hash, ≤1MiB,
 *      default content_location) + GET .../content
 *   5. POST .../gate-submissions/:subId/reject (human + project role +
 *      core:approve; in_review→rejected; outbox event carries the reason)
 *
 * Negative coverage: content_hash mismatch → 400, content > 1MiB → 400,
 * content absent → GET .../content 404, and the reject authorization matrix
 * (service → 403, role-less human → 403, missing reason → 400,
 * non in_review → 409).
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
const MAX_CONTENT_BYTES = 1024 * 1024;

describe.skipIf(!DATABASE_URL)("api gaps — Web UI-1 slice (real PostgreSQL)", () => {
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

  function envelopeData(json: unknown): Record<string, unknown> | unknown[] {
    const env = json as { data?: unknown };
    if (!env || typeof env !== "object" || !("data" in env)) throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
    return env.data!;
  }

  function envelopeError(json: unknown): { code: string; message: string } {
    const env = json as { error?: Record<string, unknown> };
    if (!env?.error) throw new Error(`missing error envelope: ${JSON.stringify(json)}`);
    return env.error as { code: string; message: string };
  }

  async function createProject(name?: string, classification = "D2"): Promise<string> {
    const projectId = `proj_${randomUUID()}`;
    const res = await apiCall(baseUrl, "/api/v1/projects", {
      method: "POST",
      body: { id: projectId, name: name ?? `Project ${projectId}`, data_classification: classification },
      token: humanToken,
      headers: { "idempotency-key": `k_proj_${projectId}` },
    });
    if (res.status !== 201) throw new Error(`createProject failed: ${JSON.stringify(res.json)}`);
    return projectId;
  }

  async function createRevision(
    projectId: string,
    artifactId: string,
    revisionId: string,
    body: Record<string, unknown>,
    key?: string,
  ): Promise<{ status: number; json: unknown }> {
    return apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions`, {
      method: "POST",
      body: { id: revisionId, version: 1, ...body },
      token: humanToken,
      headers: { "idempotency-key": key ?? `k_rev_${revisionId}` },
    });
  }

  /**
   * Build the prerequisite graph ending in a gate_submission. Optionally drives
   * it to `in_review`. Seeds the `quality` role for the human unless asked not to
   * (needed for the reject authorization path).
   */
  async function buildSubmissionGraph(
    opts: { gate?: string; seedRole?: boolean; submit?: boolean } = {},
  ): Promise<{ projectId: string; processInstanceId: string; snapshotId: string; submissionId: string; revisionId: string; artifactId: string }> {
    const gate = opts.gate ?? "G2";
    const projectId = await createProject();
    const processInstanceId = `proc_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/process-instances`, {
      method: "POST", body: { id: processInstanceId, gate_profile_version: "flow-v1", current_gate: gate },
      token: humanToken, headers: { "idempotency-key": `k_pi_${projectId}` },
    });

    if (opts.seedRole !== false) {
      await apiCall(baseUrl, `/api/v1/projects/${projectId}/role-assignments`, {
        method: "POST", body: { id: `role_${randomUUID()}`, actor_type: "human", actor_id: humanUid, role: "quality" },
        token: humanToken, headers: { "idempotency-key": `k_role_${projectId}` },
      });
    }

    const artifactId = `art_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    await createRevision(projectId, artifactId, revisionId, {
      content_hash: sha256Hex("content"), content_location: "mem://g",
      artifact_type: "SYSTEM_REQUIREMENTS", title: "Artifact G",
    }, `k_rev_${projectId}`);

    const snapshotId = `snap_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/snapshots`, {
      method: "POST", body: { id: snapshotId, member_revision_ids: [revisionId], tool_model_policy_hash: sha256Hex("policy") },
      token: humanToken, headers: { "idempotency-key": `k_snap_${projectId}` },
    });

    const submissionId = `sub_${randomUUID()}`;
    await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, {
      method: "POST", body: { id: submissionId, process_instance_id: processInstanceId, gate, snapshot_id: snapshotId },
      token: humanToken, headers: { "idempotency-key": `k_sub_${projectId}` },
    });

    if (opts.submit) {
      const s = await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/submit`, {
        method: "POST", body: {}, token: humanToken, headers: { "idempotency-key": `k_submit_${submissionId}` },
      });
      if (s.status !== 200) throw new Error(`submit failed: ${JSON.stringify(s.json)}`);
    }

    return { projectId, processInstanceId, snapshotId, submissionId, revisionId, artifactId };
  }

  /** Create a second gate_submission in an existing project's process/snapshot. */
  async function addSubmission(projectId: string, processInstanceId: string, snapshotId: string, gate: string): Promise<string> {
    const submissionId = `sub_${randomUUID()}`;
    const res = await apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, {
      method: "POST", body: { id: submissionId, process_instance_id: processInstanceId, gate, snapshot_id: snapshotId },
      token: humanToken, headers: { "idempotency-key": `k_sub2_${submissionId}` },
    });
    if (res.status !== 201) throw new Error(`addSubmission failed: ${JSON.stringify(res.json)}`);
    return submissionId;
  }

  // ══ 1. GET /projects ═══════════════════════════════════════════════════════

  describe("GET /projects", () => {
    test("returns contract fields ordered by created_at descending", async () => {
      const a = await createProject("Alpha");
      // Force an earlier created_at so the ordering is observable at second resolution.
      await harness.client.query("UPDATE project SET created_at = now() - interval '2 seconds' WHERE id = $1", [a]);
      const b = await createProject("Bravo");
      const c = await createProject("Charlie");

      const res = await apiCall(baseUrl, "/api/v1/projects", { token: humanToken });
      expect(res.status).toBe(200);
      const rows = envelopeData(res.json) as Record<string, unknown>[];
      const ids = rows.map((r) => r.id);
      // newest first: Charlie, Bravo, Alpha
      expect(ids.indexOf(c)).toBeLessThan(ids.indexOf(b));
      expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));

      for (const r of rows.slice(0, 3)) {
        for (const f of ["id", "name", "status", "data_classification", "created_at"]) {
          expect(f in r).toBe(true);
        }
      }
      const alpha = rows.find((r) => r.id === a)!;
      expect(alpha.status).toBe("active");
      expect(alpha.data_classification).toBe("D2");
    });

    test("read-only token (core:read) can list", async () => {
      await createProject("Solo");
      const res = await apiCall(baseUrl, "/api/v1/projects", { token: readOnlyToken });
      expect(res.status).toBe(200);
      expect((envelopeData(res.json) as unknown[]).length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══ 2. GET /projects/:id/gate-submissions[?state=] ══════════════════════════

  describe("GET /projects/:id/gate-submissions", () => {
    test("state filter returns only matching submissions with contract fields", async () => {
      const g = await buildSubmissionGraph({ submit: true });
      // a second, still-preparing submission in the same project
      await addSubmission(g.projectId, g.processInstanceId, g.snapshotId, "G3");

      const res = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions?state=in_review`, { token: humanToken });
      expect(res.status).toBe(200);
      const rows = envelopeData(res.json) as Record<string, unknown>[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(g.submissionId);
      for (const f of ["id", "gate", "state", "snapshot_id", "process_instance_id", "submitter_id", "submitted_at", "created_at"]) {
        expect(f in rows[0]!).toBe(true);
      }
      expect(rows[0]!.state).toBe("in_review");
    });

    test("omitting state returns all submissions for the project", async () => {
      const g = await buildSubmissionGraph({ submit: true });
      await addSubmission(g.projectId, g.processInstanceId, g.snapshotId, "G3");
      const res = await apiCall(baseUrl, `/api/v1/projects/${g.projectId}/gate-submissions`, { token: humanToken });
      expect(res.status).toBe(200);
      const rows = envelopeData(res.json) as Record<string, unknown>[];
      expect(rows.length).toBe(2);
    });
  });

  // ══ 3. GET /projects/:id/artifacts + .../revisions ══════════════════════════

  describe("product-library reads", () => {
    test("GET artifacts lists containers; GET revisions lists version-desc with title", async () => {
      const projectId = await createProject();
      const artifactId = `art_${randomUUID()}`;
      await createRevision(projectId, artifactId, `rev_${randomUUID()}`, {
        content_hash: sha256Hex("v1"), content_location: "mem://1",
        artifact_type: "ARCHITECTURE_DESIGN", title: "Arch",
      }, `k_v1_${artifactId}`);
      await createRevision(projectId, artifactId, `rev_${randomUUID()}`, {
        version: 2, content_hash: sha256Hex("v2"), content_location: "mem://2",
        artifact_type: "ARCHITECTURE_DESIGN", title: "Arch v2",
      }, `k_v2_${artifactId}`);

      const arts = await apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts`, { token: humanToken });
      expect(arts.status).toBe(200);
      const artRows = envelopeData(arts.json) as Record<string, unknown>[];
      expect(artRows.length).toBe(1);
      for (const f of ["id", "artifact_type", "created_at"]) expect(f in artRows[0]!).toBe(true);
      expect(artRows[0]!.id).toBe(artifactId);

      const revs = await apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions`, { token: humanToken });
      expect(revs.status).toBe(200);
      const revRows = envelopeData(revs.json) as Record<string, unknown>[];
      expect(revRows.length).toBe(2);
      expect(revRows[0]!.version).toBe(2);
      expect(revRows[1]!.version).toBe(1);
      for (const f of ["id", "version", "state", "content_hash", "content_location", "title", "created_at"]) {
        expect(f in revRows[0]!).toBe(true);
      }
      expect(revRows[0]!.title).toBe("Arch v2");
    });
  });

  // ══ 4. inline content (POST) + GET .../content ═════════════════════════════

  describe("inline revision content", () => {
    test("POST content: server computes hash, defaults content_location, persists content", async () => {
      const projectId = await createProject();
      const artifactId = `art_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      const content = "# Heading\n\nCandidate body text.";
      // send content WITHOUT content_hash → server computes it
      const res = await createRevision(projectId, artifactId, revisionId, {
        content, artifact_type: "DEVELOPMENT_REQUIREMENTS", title: "Dev Req",
      });
      expect(res.status).toBe(201);

      const row = await harness.client.query(
        "SELECT content, content_hash, content_location FROM artifact_revision WHERE id = $1",
        [revisionId],
      );
      expect(row.rows[0]!.content).toBe(content);
      expect(row.rows[0]!.content_hash).toBe(sha256Hex(content));
      expect(row.rows[0]!.content_location).toBe(`db://artifact_revision/${revisionId}`);
    });

    test("POST content + matching content_hash is accepted", async () => {
      const projectId = await createProject();
      const artifactId = `art_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      const content = "matched";
      const res = await createRevision(projectId, artifactId, revisionId, {
        content, content_hash: sha256Hex(content),
      });
      expect(res.status).toBe(201);
    });

    test("POST content with mismatched content_hash → 400, nothing persisted", async () => {
      const projectId = await createProject();
      const artifactId = `art_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      const res = await createRevision(projectId, artifactId, revisionId, {
        content: "# doc", content_hash: sha256Hex("different"),
      });
      expect(res.status).toBe(400);
      expect(envelopeError(res.json).code).toBe("validation");
      const n = await harness.client.query("SELECT count(*)::int AS c FROM artifact_revision WHERE id = $1", [revisionId]);
      expect(n.rows[0]!.c).toBe(0);
    });

    test("POST content > 1MiB → 400", async () => {
      const projectId = await createProject();
      const artifactId = `art_${randomUUID()}`;
      const revisionId = `rev_${randomUUID()}`;
      const oversized = "x".repeat(MAX_CONTENT_BYTES + 1);
      const res = await createRevision(projectId, artifactId, revisionId, { content: oversized });
      expect(res.status).toBe(400);
      expect(envelopeError(res.json).code).toBe("validation");
    });

    test("GET .../content returns {content, content_hash}; absent content → 404", async () => {
      const projectId = await createProject();
      const artifactId = `art_${randomUUID()}`;
      const withContent = `rev_${randomUUID()}`;
      const content = "inline payload";
      await createRevision(projectId, artifactId, withContent, { content }, `k_wc_${withContent}`);
      const withoutContent = `rev_${randomUUID()}`;
      await createRevision(projectId, artifactId, withoutContent, {
        version: 2, content_hash: sha256Hex("oob"), content_location: "git://repo/oob.md",
      }, `k_wo_${withoutContent}`);

      const ok = await apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions/${withContent}/content`, { token: humanToken });
      expect(ok.status).toBe(200);
      const okData = envelopeData(ok.json) as Record<string, unknown>;
      expect(okData.content).toBe(content);
      expect(okData.content_hash).toBe(sha256Hex(content));

      const missing = await apiCall(baseUrl, `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions/${withoutContent}/content`, { token: humanToken });
      expect(missing.status).toBe(404);
      expect(envelopeError(missing.json).code).toBe("not_found");
    });
  });

  // ══ 5. POST .../gate-submissions/:subId/reject ═════════════════════════════

  describe("reject gate submission", () => {
    function rejectCall(projectId: string, submissionId: string, body: unknown, key: string, token = humanToken) {
      return apiCall(baseUrl, `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/reject`, {
        method: "POST", body, token, headers: { "idempotency-key": key },
      });
    }

    async function submissionState(submissionId: string): Promise<string> {
      const r = await harness.client.query("SELECT state FROM gate_submission WHERE id = $1", [submissionId]);
      return r.rows[0]!.state as string;
    }

    async function rejectEventPayload(submissionId: string): Promise<Record<string, unknown> | null> {
      const r = await harness.client.query(
        "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2",
        [submissionId, "gate_submission.rejected"],
      );
      if (r.rows.length === 0) return null;
      return r.rows[0]!.payload as Record<string, unknown>;
    }

    test("happy path: in_review → rejected, DB state, outbox event carries reason", async () => {
      const g = await buildSubmissionGraph({ submit: true });
      expect(await submissionState(g.submissionId)).toBe("in_review");

      const res = await rejectCall(g.projectId, g.submissionId, { reason: "Requirements incomplete" }, "k_reject_1");
      expect(res.status).toBe(200);
      const data = envelopeData(res.json) as Record<string, unknown>;
      expect(data.state).toBe("rejected");

      expect(await submissionState(g.submissionId)).toBe("rejected");
      const payload = await rejectEventPayload(g.submissionId);
      expect(payload).not.toBeNull();
      expect(payload!.reason).toBe("Requirements incomplete");
      expect(payload!.state).toBe("rejected");
    });

    test("service identity (no core:approve) → 403", async () => {
      const g = await buildSubmissionGraph({ submit: true });
      const res = await rejectCall(g.projectId, g.submissionId, { reason: "no" }, "k_reject_svc", serviceToken);
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
      expect(await submissionState(g.submissionId)).toBe("in_review");
    });

    test("human without project role → 403", async () => {
      const g = await buildSubmissionGraph({ seedRole: false, submit: true });
      const res = await rejectCall(g.projectId, g.submissionId, { reason: "no" }, "k_reject_norole");
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
      expect(await submissionState(g.submissionId)).toBe("in_review");
    });

    test("missing reason → 400", async () => {
      const g = await buildSubmissionGraph({ submit: true });
      const res = await rejectCall(g.projectId, g.submissionId, {}, "k_reject_noreason");
      expect(res.status).toBe(400);
      expect(envelopeError(res.json).code).toBe("validation");
      expect(await submissionState(g.submissionId)).toBe("in_review");
    });

    test("non in_review submission → 409", async () => {
      const g = await buildSubmissionGraph({ submit: false });
      const res = await rejectCall(g.projectId, g.submissionId, { reason: "early" }, "k_reject_prep");
      expect(res.status).toBe(409);
      expect(envelopeError(res.json).code).toBe("conflict");
      expect(await submissionState(g.submissionId)).toBe("preparing");
    });

    test("reject requires core:approve scope (read-only human token → 403)", async () => {
      const g = await buildSubmissionGraph({ submit: true });
      const res = await rejectCall(g.projectId, g.submissionId, { reason: "x" }, "k_reject_ro", readOnlyToken);
      expect(res.status).toBe(403);
      expect(envelopeError(res.json).code).toBe("authorization");
    });
  });
});

// Explicit, loud marker that the suite did not run when no DB is available.
if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; api-gaps real PostgreSQL tests were not executed", () => {});
}
