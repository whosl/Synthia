import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { ApiHarness } from "./support/api-harness.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  truncateDomainTables,
} from "./support/api-harness.ts";
import { sha256Hex } from "../src/hashing.ts";
import { writeAndCommit } from "../src/workspace/store.ts";
import { git, listTree } from "../src/workspace/git.ts";
import { projectWorkspaceDir } from "../src/workspace/paths.ts";
import { startSynthiaServer } from "../src/api/server.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function dataOf(json: unknown): any {
  if (!json || typeof json !== "object" || !("data" in json)) throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
  return (json as { data: unknown }).data;
}

function errorOf(json: unknown): any {
  if (!json || typeof json !== "object" || !("error" in json)) throw new Error(`missing error envelope: ${JSON.stringify(json)}`);
  return (json as { error: unknown }).error;
}

describe.skipIf(!DATABASE_URL)("P2 import snapshots API — real PostgreSQL", () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await setupApiHarness(DATABASE_URL, {
      features: { historicalMaterials: true },
    });
  });

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
  });

  async function createProject(
    projectType: "free" | "engineering" = "engineering",
    classification = "D1",
  ): Promise<string> {
    const id = `p_${randomUUID()}`;
    const response = await apiCall(harness.baseUrl, "/api/v1/projects", {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `create_${id}` },
      body: {
        id,
        name: id,
        project_type: projectType,
        data_classification: classification,
        ...(projectType === "engineering" ? { process_profile_id: "GJB_REF_V1" } : {}),
      },
    });
    expect(response.status).toBe(201);
    return id;
  }

  async function mintScopedHumanToken(): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const user = await harness.client.query("SELECT id FROM user_account WHERE uid=$1", [harness.ids.humanUid]);
    await harness.client.query(
      "INSERT INTO auth_token(token_hash,user_id,scope) VALUES ($1,$2,$3)",
      [sha256Hex(token), user.rows[0]!.id, ["core:read", "core:write", "core:approve"]],
    );
    return token;
  }

  async function grantProjectRole(projectId: string): Promise<void> {
    await harness.client.query(
      `INSERT INTO role_assignment(id,project_id,actor_type,actor_id,role,permissions)
       VALUES ($1,$2,'human',$3,'engineer','{}'::jsonb)`,
      [`role_${randomUUID()}`, projectId, harness.ids.humanUid],
    );
  }

  async function importFiles(projectId: string, files: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
    const id = String(overrides.id ?? `imp_${randomUUID()}`);
    const key = String(overrides.key ?? `import_${randomUUID()}`);
    const response = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body: {
        id,
        source_kind: "local_directory",
        source_name: "legacy material",
        files,
        ...overrides,
        key: undefined,
      },
    });
    return { id, key, response };
  }

  async function decide(projectId: string, snapshotId: string, action: "confirm" | "deny", body: Record<string, unknown> = {}) {
    return apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${snapshotId}/${action}`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `${action}_${randomUUID()}` },
      body,
    });
  }

  test("import → pending → confirmed → searchable → copied candidate, with idempotent replay", async () => {
    const projectId = await createProject("engineering", "D4");
    const files = [
      { path: "rtl/pwm.v", content: "module pwm; endmodule\n", media_type: "text/x-verilog" },
      { path: "doc/readme.md", content: "PWM historical notes\n" },
    ];
    const id = `imp_${randomUUID()}`;
    const key = `import_${randomUUID()}`;
    const first = await importFiles(projectId, files, { id, key });
    expect(first.response.status).toBe(201);
    expect(dataOf(first.response.json)).toMatchObject({
      id,
      project_id: projectId,
      status: "pending_confirmation",
      valid: true,
      searchable: false,
    });
    expect(dataOf(first.response.json).files).toHaveLength(2);

    const replay = await importFiles(projectId, files, { id, key });
    expect(replay.response.status).toBe(201);
    expect(dataOf(replay.response.json)).toEqual(dataOf(first.response.json));
    expect((await harness.client.query("SELECT count(*)::int AS n FROM import_snapshot WHERE id=$1", [id])).rows[0]!.n).toBe(1);

    const conflictingReplay = await importFiles(projectId, [
      { path: "rtl/pwm.v", content: "module forged; endmodule\n" },
    ], { id, key });
    expect(conflictingReplay.response.status).toBe(409);

    const before = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/search?q=pwm&include_content=true`, {
      token: harness.ids.humanToken,
    });
    expect(dataOf(before.json)).toMatchObject({ items: [], total: 0 });

    const confirmed = await decide(projectId, id, "confirm", { reason: "source checked" });
    expect(confirmed.status).toBe(200);
    expect(dataOf(confirmed.json)).toMatchObject({ status: "confirmed", valid: true, searchable: true });

    const search = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/search?q=pwm&include_content=true`, {
      token: harness.ids.humanToken,
    });
    expect(search.status).toBe(200);
    const hits = dataOf(search.json);
    expect(hits.total).toBe(2);
    expect(hits.items.every((item: any) => item.project_id === projectId && item.status === "confirmed" && item.valid && item.searchable)).toBe(true);
    expect(hits.items.some((item: any) => item.content?.includes("module pwm"))).toBe(true);

    const selectedFile = dataOf(confirmed.json).files.find((file: any) => file.path === "rtl/pwm.v");
    for (const invalidName of ["candidate\nforged", "候".repeat(86)]) {
      const invalidNameResponse = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${id}/copy`, {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": `copy_invalid_name_${randomUUID()}` },
        body: { id: `copy_${randomUUID()}`, name: invalidName, file_ids: [selectedFile.id] },
      });
      expect(invalidNameResponse.status).toBe(400);
      expect(errorOf(invalidNameResponse.json).code).toBe("validation");
    }
    const invalidType = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${id}/copy`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `copy_invalid_type_${randomUUID()}` },
      body: { id: `copy_${randomUUID()}`, name: "invalid", artifact_type: "HISTORICAL_MATERIAL", file_ids: [selectedFile.id] },
    });
    expect(invalidType.status).toBe(400);
    expect(errorOf(invalidType.json).code).toBe("validation");
    expect((await harness.client.query("SELECT count(*)::int AS n FROM artifact_revision WHERE project_id=$1", [projectId])).rows[0]!.n).toBe(0);

    const copyId = `copy_${randomUUID()}`;
    const copyKey = `copy_${randomUUID()}`;
    const copyBody = { id: copyId, name: "PWM candidate", artifact_type: "RTL_SOURCE_SET", file_ids: [selectedFile.id] };
    const copy = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${id}/copy`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": copyKey },
      body: copyBody,
    });
    expect(copy.status).toBe(201);
    const copyData = dataOf(copy.json);
    const revisionId = copyData.revision_ids[0];
    expect(copyData).toMatchObject({ id: copyId, project_id: projectId, snapshot_id: id, candidate: true });
    expect(copyData.revision_ids).toEqual([revisionId]);
    expect(revisionId).toMatch(/^import_rev_[0-9a-f]{48}$/);
    expect(revisionId).not.toBe(copyId);
    expect(copyData.copied_files[0]).toMatchObject({ file_id: selectedFile.id, revision_id: revisionId, version: 1 });
    const revision = await harness.client.query(
      "SELECT state, content, data_classification, source_ids FROM artifact_revision WHERE id=$1",
      [revisionId],
    );
    expect(revision.rows[0]).toMatchObject({ state: "candidate", content: "module pwm; endmodule\n", data_classification: "D4", source_ids: [id, selectedFile.id] });
    expect((await harness.client.query("SELECT count(*)::int AS n FROM import_source_relation WHERE target_revision_id=$1", [revisionId])).rows[0]!.n).toBe(1);
    expect((await harness.client.query("SELECT classification FROM outbox_events WHERE aggregate_id=$1", [revisionId])).rows[0]!.classification).toBe("D4");

    const copyReplay = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${id}/copy`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": copyKey },
      body: copyBody,
    });
    expect(copyReplay.status).toBe(201);
    expect(dataOf(copyReplay.json)).toEqual(dataOf(copy.json));
    expect((await harness.client.query("SELECT count(*)::int AS n FROM artifact_revision WHERE id=$1", [revisionId])).rows[0]!.n).toBe(1);

    // A new logical copy is allowed and creates v2; idempotency prevents only
    // replay of the same logical request.
    const secondCopyId = `copy_${randomUUID()}`;
    const second = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${id}/copy`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `copy_${randomUUID()}` },
      body: { id: secondCopyId, name: "PWM candidate v2", artifact_type: "RTL_SOURCE_SET", file_ids: [selectedFile.id] },
    });
    expect(second.status).toBe(201);
    expect(dataOf(second.json).copied_files[0].version).toBe(2);
    expect(dataOf(second.json).revision_ids[0]).not.toBe(revisionId);
  });

  test("completed P2 replays re-check target authorization and active state before returning cached responses", async () => {
    const projectId = await createProject();
    const token = await mintScopedHumanToken();
    await grantProjectRole(projectId);

    const createBody = {
      id: `imp_${randomUUID()}`,
      source_kind: "local_directory",
      source_name: "replay authorization",
      files: [{ path: "doc/replay.md", content: "replay authorization material" }],
    };
    const createKey = `create_${randomUUID()}`;
    const createRequest = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots`, {
      method: "POST",
      token,
      headers: { "idempotency-key": createKey },
      body: createBody,
    });
    const created = await createRequest();
    expect(created.status).toBe(201);
    const fileId = dataOf(created.json).files[0].id;

    const confirmKey = `confirm_${randomUUID()}`;
    const confirmRequest = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${createBody.id}/confirm`, {
      method: "POST",
      token,
      headers: { "idempotency-key": confirmKey },
      body: { reason: "checked" },
    });
    expect((await confirmRequest()).status).toBe(200);

    const copyKey = `copy_${randomUUID()}`;
    const copyBody = { id: `copy_${randomUUID()}`, name: "Replay candidate", file_ids: [fileId] };
    const copyRequest = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${createBody.id}/copy`, {
      method: "POST",
      token,
      headers: { "idempotency-key": copyKey },
      body: copyBody,
    });
    expect((await copyRequest()).status).toBe(201);

    const deniedBody = {
      id: `imp_${randomUUID()}`,
      source_kind: "local_directory",
      source_name: "denied replay authorization",
      files: [{ path: "doc/denied.md", content: "denied material" }],
    };
    const deniedCreate = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots`, {
      method: "POST",
      token,
      headers: { "idempotency-key": `create_${randomUUID()}` },
      body: deniedBody,
    });
    expect(deniedCreate.status).toBe(201);
    const denyKey = `deny_${randomUUID()}`;
    const denyRequest = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${deniedBody.id}/deny`, {
      method: "POST",
      token,
      headers: { "idempotency-key": denyKey },
      body: { reason: "not applicable" },
    });
    expect((await denyRequest()).status).toBe(200);

    const writeCounts = async () => (await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM import_snapshot WHERE project_id=$1) AS snapshots,
         (SELECT count(*)::int FROM artifact_revision WHERE project_id=$1) AS revisions,
         (SELECT count(*)::int FROM import_audit_event WHERE project_id=$1) AS audits,
         (SELECT count(*)::int FROM idempotency_records WHERE project_id=$1) AS idempotency`,
      [projectId],
    )).rows[0];
    const beforeRevocation = await writeCounts();

    await harness.client.query(
      "DELETE FROM role_assignment WHERE project_id=$1 AND actor_type='human' AND actor_id=$2",
      [projectId, harness.ids.humanUid],
    );
    for (const replay of [createRequest, confirmRequest, copyRequest, denyRequest]) {
      const response = await replay();
      expect(response.status).toBe(404);
      expect(errorOf(response.json).code).toBe("not_found");
    }
    expect(await writeCounts()).toEqual(beforeRevocation);

    await grantProjectRole(projectId);
    await harness.client.query("UPDATE project SET status='archived' WHERE id=$1", [projectId]);
    for (const replay of [createRequest, confirmRequest, copyRequest, denyRequest]) {
      const response = await replay();
      expect(response.status).toBe(409);
      expect(errorOf(response.json).message).toContain("PROJECT_NOT_ACTIVE");
    }
    expect(await writeCounts()).toEqual(beforeRevocation);
  });

  test("project-source create replay re-checks source authorization and active state", async () => {
    const target = await createProject();
    const source = await createProject("free");
    const token = await mintScopedHumanToken();
    await grantProjectRole(target);
    await grantProjectRole(source);
    const committed = await writeAndCommit(source, [
      { path: "doc/source.md", content: "source authorization material\n" },
    ], "source authorization", {
      name: "Tester",
      email: "tester@example.invalid",
    });
    expect(committed.commit).not.toBeNull();

    const body = {
      id: `imp_${randomUUID()}`,
      source_kind: "project",
      source_project_id: source,
      source_name: "authorized source",
      commit: committed.commit,
    };
    const key = `project_${randomUUID()}`;
    const request = () => apiCall(harness.baseUrl, `/api/v1/projects/${target}/import-snapshots`, {
      method: "POST",
      token,
      headers: { "idempotency-key": key },
      body,
    });
    expect((await request()).status).toBe(201);

    await harness.client.query(
      "DELETE FROM role_assignment WHERE project_id=$1 AND actor_type='human' AND actor_id=$2",
      [source, harness.ids.humanUid],
    );
    const revoked = await request();
    expect(revoked.status).toBe(404);
    expect(errorOf(revoked.json).code).toBe("not_found");

    await grantProjectRole(source);
    await harness.client.query("UPDATE project SET status='archived' WHERE id=$1", [source]);
    const archived = await request();
    expect(archived.status).toBe(409);
    expect(errorOf(archived.json).message).toContain("SOURCE_PROJECT_NOT_ACTIVE");
    expect((await harness.client.query(
      "SELECT count(*)::int AS n FROM import_snapshot WHERE id=$1 AND project_id=$2",
      [body.id, target],
    )).rows[0]!.n).toBe(1);
  });

  test("feature flag disables writes while preserving read-only inspection", async () => {
    const projectId = await createProject();
    const imported = await importFiles(projectId, [{ path: "doc/flag.md", content: "flagged material" }]);
    expect(imported.response.status).toBe(201);

    const disabledServer = startSynthiaServer(harness.pool, {
      port: 0,
      features: { historicalMaterials: false },
    });
    const disabledUrl = `http://${disabledServer.hostname}:${disabledServer.port}`;
    try {
      const writes = [
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots`, {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": `disabled_create_${randomUUID()}` },
          body: {
            id: `imp_${randomUUID()}`,
            source_kind: "local_directory",
            files: [{ path: "doc/new.md", content: "new" }],
          },
        }),
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}/confirm`, {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": `disabled_confirm_${randomUUID()}` },
          body: {},
        }),
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}/deny`, {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": `disabled_deny_${randomUUID()}` },
          body: {},
        }),
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}/copy`, {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": `disabled_copy_${randomUUID()}` },
          body: { id: `copy_${randomUUID()}`, name: "disabled", file_ids: [`${imported.id}_file_1`] },
        }),
      ];
      for (const response of await Promise.all(writes)) {
        expect(response.status).toBe(503);
        expect(errorOf(response.json)).toMatchObject({
          code: "capability_unavailable",
          retryable: true,
          details: { feature: "historical_materials" },
        });
      }

      const [list, detail, search] = await Promise.all([
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots`, { token: harness.ids.humanToken }),
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}`, { token: harness.ids.humanToken }),
        apiCall(disabledUrl, `/api/v1/projects/${projectId}/import-snapshots/search?q=flag`, { token: harness.ids.humanToken }),
      ]);
      expect(list.status).toBe(200);
      expect(detail.status).toBe(200);
      expect(search.status).toBe(200);
    } finally {
      disabledServer.stop();
    }
  });

  test("deny is human-only, audited, and never searchable", async () => {
    const projectId = await createProject();
    const imported = await importFiles(projectId, [{ path: "doc/x.md", content: "secretless notes" }]);
    expect(imported.response.status).toBe(201);

    const service = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}/deny`, {
      method: "POST",
      token: harness.ids.serviceToken,
      headers: { "idempotency-key": `deny_${randomUUID()}` },
      body: {},
    });
    expect(service.status).toBe(403);

    const denied = await decide(projectId, imported.id, "deny");
    expect(denied.status).toBe(200);
    expect(dataOf(denied.json)).toMatchObject({ status: "denied", valid: true, searchable: false, denial_reason: null });
    expect(typeof dataOf(denied.json).denied_at).toBe("string");
    const search = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/search?q=notes`, { token: harness.ids.humanToken });
    expect(dataOf(search.json)).toMatchObject({ items: [], total: 0 });
    expect((await harness.client.query("SELECT action FROM import_audit_event WHERE snapshot_id=$1 ORDER BY created_at", [imported.id])).rows.map((row) => row.action)).toEqual(["imported", "denied"]);
  });

  test("non-admin identities need an explicit target-project role for every P2 route", async () => {
    const projectId = await createProject();
    const imported = await importFiles(projectId, [{ path: "doc/x.md", content: "x" }]);
    expect(imported.response.status).toBe(201);
    const token = randomBytes(32).toString("hex");
    const userId = `usr_${randomUUID()}`;
    const userUid = `human_no_role_${randomUUID()}`;
    await harness.client.query(
      `INSERT INTO user_account(id,uid,cn,display_name,mail,actor_type,status)
       VALUES ($1,$2,'No Role Tester','No Role Tester',$3,'human','active')`,
      [userId, userUid, `${userUid}@test.local`],
    );
    await harness.client.query(
      "INSERT INTO auth_token(token_hash,user_id,scope) VALUES ($1,$2,$3)",
      [sha256Hex(token), userId, ["core:read", "core:write", "core:approve"]],
    );

    const detail = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}`, { token });
    expect(detail.status).toBe(404);
    const create = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots`, {
      method: "POST",
      token,
      headers: { "idempotency-key": `no_role_${randomUUID()}` },
      body: { id: `imp_${randomUUID()}`, source_kind: "local_directory", files: [{ path: "doc/y.md", content: "y" }] },
    });
    expect(create.status).toBe(404);
    const confirm = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots/${imported.id}/confirm`, {
      method: "POST",
      token,
      headers: { "idempotency-key": `no_role_${randomUUID()}` },
      body: {},
    });
    expect(confirm.status).toBe(404);
  });

  test("source project existence and inactive state stay hidden without a source role", async () => {
    const target = await createProject();
    const source = await createProject("free");
    await harness.client.query("UPDATE project SET status='archived' WHERE id=$1", [source]);

    const token = randomBytes(32).toString("hex");
    const user = await harness.client.query("SELECT id FROM user_account WHERE uid=$1", [harness.ids.humanUid]);
    await harness.client.query(
      "INSERT INTO auth_token(token_hash,user_id,scope) VALUES ($1,$2,$3)",
      [sha256Hex(token), user.rows[0]!.id, ["core:read", "core:write"]],
    );
    await harness.client.query(
      `INSERT INTO role_assignment(id,project_id,actor_type,actor_id,role,permissions)
       VALUES ($1,$2,'human',$3,'engineer','{}'::jsonb)`,
      [`role_${randomUUID()}`, target, harness.ids.humanUid],
    );

    const response = await apiCall(harness.baseUrl, `/api/v1/projects/${target}/import-snapshots`, {
      method: "POST",
      token,
      headers: { "idempotency-key": `hidden_source_${randomUUID()}` },
      body: {
        id: `imp_${randomUUID()}`,
        source_kind: "project",
        source_project_id: source,
      },
    });
    expect(response.status).toBe(404);
  });

  test("snapshot reads/copies are target-project scoped and expired material fails closed", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const imported = await importFiles(projectA, [{ path: "doc/x.md", content: "x" }]);
    expect(imported.response.status).toBe(201);
    expect((await apiCall(harness.baseUrl, `/api/v1/projects/${projectB}/import-snapshots/${imported.id}`, { token: harness.ids.humanToken })).status).toBe(404);
    const crossCopy = await apiCall(harness.baseUrl, `/api/v1/projects/${projectB}/import-snapshots/${imported.id}/copy`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `cross_${randomUUID()}` },
      body: { id: `copy_${randomUUID()}`, name: "bad", file_ids: [`${imported.id}_file_1`] },
    });
    expect(crossCopy.status).toBe(404);

    const expired = await importFiles(projectA, [{ path: "doc/old.md", content: "old" }], {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(expired.response.status).toBe(201);
    const confirm = await decide(projectA, expired.id, "confirm");
    expect(confirm.status).toBe(409);

    // URL resource identity is part of the idempotency operation. The same key
    // and body on two snapshots must resolve both, never replay A for B.
    const one = await importFiles(projectA, [{ path: "doc/one.md", content: "one" }]);
    const two = await importFiles(projectA, [{ path: "doc/two.md", content: "two" }]);
    const sharedKey = `confirm_shared_${randomUUID()}`;
    for (const snapshotId of [one.id, two.id]) {
      const response = await apiCall(harness.baseUrl, `/api/v1/projects/${projectA}/import-snapshots/${snapshotId}/confirm`, {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": sharedKey },
        body: {},
      });
      expect(response.status).toBe(200);
      expect(dataOf(response.json).id).toBe(snapshotId);
    }
    expect((await harness.client.query(
      "SELECT count(*)::int AS n FROM import_snapshot WHERE id=ANY($1::text[]) AND status='confirmed'",
      [[one.id, two.id]],
    )).rows[0]!.n).toBe(2);
  });

  test("project sources bind to an authorized commit manifest and classification cannot downgrade", async () => {
    const source = await createProject("free", "D2");
    const target = await createProject("engineering", "D2");
    const outcome = await writeAndCommit(source, [{ path: "rtl/source.v", content: "module source; endmodule\n" }], "source", {
      name: "Tester",
      email: "tester@example.invalid",
    });
    expect(outcome.commit).not.toBeNull();
    expect(await listTree(projectWorkspaceDir(source), outcome.commit!)).toContain("sim/.gitkeep");

    const id = `imp_${randomUUID()}`;
    const exact = await apiCall(harness.baseUrl, `/api/v1/projects/${target}/import-snapshots`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `project_${randomUUID()}` },
      body: {
        id,
        source_kind: "project",
        source_project_id: source,
        source_name: "source project",
        commit: outcome.commit,
        files: [{ path: "rtl/source.v", content: "module source; endmodule\n" }],
      },
    });
    expect(exact.status).toBe(201);
    expect(dataOf(exact.json)).toMatchObject({ source_project_id: source, source_commit: outcome.commit });

    const ambiguousCommitLength = await apiCall(harness.baseUrl, `/api/v1/projects/${target}/import-snapshots`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `project_${randomUUID()}` },
      body: {
        id: `imp_${randomUUID()}`,
        source_kind: "project",
        source_project_id: source,
        commit: "a".repeat(41),
      },
    });
    expect(ambiguousCommitLength.status).toBe(400);
    expect(errorOf(ambiguousCommitLength.json).message).toContain("40 or 64");

    const mismatch = await apiCall(harness.baseUrl, `/api/v1/projects/${target}/import-snapshots`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `project_${randomUUID()}` },
      body: {
        id: `imp_${randomUUID()}`,
        source_kind: "project",
        source_project_id: source,
        commit: outcome.commit,
        files: [{ path: "rtl/source.v", content: "forged" }],
      },
    });
    expect(mismatch.status).toBe(400);

    // A committed workspace placeholder is harmless, but a force-added
    // simulation result is never reference material.
    const sourceDir = projectWorkspaceDir(source);
    await Bun.write(`${sourceDir}/sim/wave.vcd`, "simulated waveform\n");
    await git(sourceDir, ["add", "-f", "--", "sim/wave.vcd"]);
    await git(sourceDir, ["commit", "--no-verify", "--quiet", "-m", "forced simulation output"]);
    const commitWithSimulation = (await git(sourceDir, ["rev-parse", "HEAD"])).trim();
    const simulation = await apiCall(harness.baseUrl, `/api/v1/projects/${target}/import-snapshots`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `project_${randomUUID()}` },
      body: {
        id: `imp_${randomUUID()}`,
        source_kind: "project",
        source_project_id: source,
        commit: commitWithSimulation,
      },
    });
    expect(simulation.status).toBe(400);
    expect(errorOf(simulation.json).message).toContain("simulation output");

    const lowTarget = await createProject("engineering", "D1");
    const downgrade = await apiCall(harness.baseUrl, `/api/v1/projects/${lowTarget}/import-snapshots`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `project_${randomUUID()}` },
      body: { id: `imp_${randomUUID()}`, source_kind: "project", source_project_id: source, commit: outcome.commit },
    });
    expect(downgrade.status).toBe(403);
    expect(errorOf(downgrade.json).message).toContain("SOURCE_CLASSIFICATION_EXCEEDS_TARGET");
  });

  test("input failures are transactional and raw ZIP payloads are rejected", async () => {
    const projectId = await createProject();
    for (const body of [
      { id: `imp_${randomUUID()}`, source_kind: "local_directory", files: [{ path: "../escape", content: "x" }] },
      { id: `imp_${randomUUID()}`, source_kind: "local_directory", files: [{ path: ".env", content: "TOKEN=x" }] },
      { id: `imp_${randomUUID()}`, source_kind: "zip", archive_base64: "UEsDBA==", files: [{ path: "doc/x.md", content: "x" }] },
      { id: `imp_${randomUUID()}`, source_kind: "local_directory", files: [{ path: "sim/run.log", content: "x" }] },
      { id: `imp_${randomUUID()}`, source_kind: "local_directory", expires_at: 123, files: [{ path: "doc/x.md", content: "x" }] },
      { id: `imp_${randomUUID()}`, source_kind: "local_directory", source_name: "legacy\nforged", files: [{ path: "doc/x.md", content: "x" }] },
    ]) {
      const response = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/import-snapshots`, {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": `bad_${randomUUID()}` },
        body,
      });
      expect(response.status).toBe(400);
    }
    expect((await harness.client.query("SELECT count(*)::int AS n FROM import_snapshot WHERE project_id=$1", [projectId])).rows[0]!.n).toBe(0);

    const whitespaceName = await importFiles(projectId, [{ path: "doc/ok.md", content: "ok" }], {
      source_name: "   ",
    });
    expect(whitespaceName.response.status).toBe(201);
    expect(dataOf(whitespaceName.response.json).source_name).toBe("local_directory");
  });

  test("database freezes source/decision/audit rows and composite ownership", async () => {
    const projectId = await createProject();
    const otherProject = await createProject();
    const imported = await importFiles(projectId, [{ path: "doc/x.md", content: "x" }]);
    expect(imported.response.status).toBe(201);

    for (const sql of [
      "UPDATE import_snapshot SET source_hash=$2 WHERE id=$1",
      "UPDATE import_snapshot SET status=status WHERE id=$1",
      "DELETE FROM import_snapshot WHERE id=$1",
      "UPDATE import_source SET source_name='changed' WHERE snapshot_id=$1",
      "UPDATE import_file_entry SET path='doc/changed.md' WHERE snapshot_id=$1",
      "UPDATE import_audit_event SET details='{}'::jsonb WHERE snapshot_id=$1",
    ]) {
      try {
        await harness.client.query(sql, sql.includes("$2") ? [imported.id, sha256Hex("changed")] : [imported.id]);
        throw new Error(`expected immutable rejection: ${sql}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("55000");
      }
    }

    const fileId = `${imported.id}_file_1`;
    await expect(harness.client.query(
      `INSERT INTO import_audit_event(id,project_id,snapshot_id,entry_id,action,actor_type,actor_id)
       VALUES ($1,$2,$3,$4,'copied','human','forger')`,
      [`audit_${randomUUID()}`, otherProject, imported.id, fileId],
    )).rejects.toMatchObject({ code: "23503" });
  });
});
