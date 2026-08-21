/**
 * PB-003 — project type / process-version integration tests.
 *
 * Requires a real PostgreSQL database through DATABASE_URL. The suite checks
 * committed rows and database triggers rather than mocking SQL calls.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiHarness } from "./support/api-harness.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  truncateDomainTables,
} from "./support/api-harness.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function dataOf(json: unknown): Record<string, any> {
  const envelope = json as { data?: unknown };
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) {
    throw new Error(`missing data envelope: ${JSON.stringify(json)}`);
  }
  return envelope.data as Record<string, any>;
}

function errorOf(json: unknown): { code: string; message: string } {
  const envelope = json as { error?: { code?: unknown; message?: unknown } };
  if (!envelope?.error || typeof envelope.error.code !== "string" || typeof envelope.error.message !== "string") {
    throw new Error(`missing error envelope: ${JSON.stringify(json)}`);
  }
  return envelope.error as { code: string; message: string };
}

describe.skipIf(!DATABASE_URL)("PB-003 project model — real PostgreSQL", () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await setupApiHarness(DATABASE_URL);
  });

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
  });

  async function create(body: Record<string, unknown>, key = `key_${randomUUID()}`) {
    return apiCall(harness.baseUrl, "/api/v1/projects", {
      method: "POST",
      body,
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
    });
  }

  async function copyAsEngineering(
    sourceProjectId: string,
    body: Record<string, unknown>,
    key = `copy_${randomUUID()}`,
  ) {
    return apiCall(harness.baseUrl, `/api/v1/projects/${sourceProjectId}/copy-as-engineering`, {
      method: "POST",
      body,
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
    });
  }

  async function createRevisionFor(projectId: string): Promise<string> {
    const artifactId = `artifact_${randomUUID()}`;
    const revisionId = `revision_${randomUUID()}`;
    const response = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions`,
      {
        method: "POST",
        body: {
          id: revisionId,
          content_hash: `hash_${revisionId}`,
          content_location: `mem://${revisionId}`,
        },
        token: harness.ids.humanToken,
        headers: { "idempotency-key": `revision_${revisionId}` },
      },
    );
    if (response.status !== 201) {
      throw new Error(`create revision failed: ${JSON.stringify(response.json)}`);
    }
    return revisionId;
  }

  test("GET /process-versions exposes GJB_REF_V1 but not LEGACY_COMPAT", async () => {
    const response = await apiCall(harness.baseUrl, "/api/v1/process-versions", {
      token: harness.ids.humanToken,
    });
    expect(response.status).toBe(200);
    const versions = dataOf(response.json) as unknown as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: "GJB_REF_V1",
      profile_id: "GJB_REF_V1",
      version: "GJB_REF_V1",
      name: "GJB 参考流程 v1",
      status: "active",
    });
  });

  test("explicit free project keeps target and process profile genuinely null", async () => {
    const id = `free_${randomUUID()}`;
    const response = await create({ id, name: "Free project", project_type: "free" });
    expect(response.status).toBe(201);
    expect(dataOf(response.json)).toMatchObject({
      id,
      project_type: "free",
      process_version_id: null,
      process_profile_id: null,
      process_profile_version: null,
      process_profile_name: null,
      target_part: null,
      process_instances: [],
    });

    const project = await harness.client.query(
      "SELECT project_type, process_version_id, process_profile_id, target_part FROM project WHERE id=$1",
      [id],
    );
    expect(project.rows[0]).toMatchObject({
      project_type: "free",
      process_version_id: null,
      process_profile_id: null,
      target_part: null,
    });
    const instances = await harness.client.query("SELECT 1 FROM process_instance WHERE project_id=$1", [id]);
    expect(instances.rows).toHaveLength(0);
  });

  test("engineering project may omit target and atomically receives one real G0 instance", async () => {
    const id = `eng_${randomUUID()}`;
    const body = {
      id,
      name: "Engineering project",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
    };
    const response = await create(body);
    expect(response.status).toBe(201);
    const data = dataOf(response.json);
    expect(data).toMatchObject({
      id,
      project_type: "engineering",
      process_version_id: "GJB_REF_V1",
      process_profile_id: "GJB_REF_V1",
      process_profile_version: "GJB_REF_V1",
      process_profile_name: "GJB 参考流程 v1",
      target_part: null,
    });
    expect(data.process_instances).toHaveLength(1);
    expect(data.process_instances[0]).toMatchObject({
      id: `pi_${id}_G0`,
      gate_profile_version: "GJB_REF_V1",
      current_gate: "G0",
    });
    expect(typeof data.process_instances[0].created_at).toBe("string");

    const row = await harness.client.query(
      `SELECT p.target_part, pi.id, pi.gate_profile_version, pi.current_gate, pi.created_at
         FROM project p JOIN process_instance pi ON pi.project_id=p.id WHERE p.id=$1`,
      [id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.target_part).toBeNull();
    expect(new Date(data.process_instances[0].created_at).getTime()).toBe(row.rows[0]!.created_at.getTime());
    const events = await harness.client.query(
      "SELECT event_type FROM outbox_events WHERE project_id=$1 ORDER BY occurred_at, event_id",
      [id],
    );
    expect(events.rows.map((event) => event.event_type).sort()).toEqual(["process.created", "project.created"]);
  });

  test("modern process instances inherit the frozen GJB profile and reject flow-v1", async () => {
    const projectId = `eng_${randomUUID()}`;
    const created = await create({
      id: projectId,
      name: "Modern process binding",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
    });
    expect(created.status).toBe(201);

    const inheritedId = `pi_${randomUUID()}`;
    const inherited = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/process-instances`, {
      method: "POST",
      body: { id: inheritedId, current_gate: "G1" },
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `pi_${inheritedId}` },
    });
    expect(inherited.status).toBe(201);
    expect(dataOf(inherited.json)).toMatchObject({
      id: inheritedId,
      projectId,
      gateProfile: "GJB_REF_V1",
      currentGate: "G1",
    });
    expect((await harness.client.query(
      "SELECT gate_profile_version, current_gate FROM process_instance WHERE id=$1",
      [inheritedId],
    )).rows[0]).toMatchObject({ gate_profile_version: "GJB_REF_V1", current_gate: "G1" });

    const rejectedId = `pi_${randomUUID()}`;
    const rejected = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/process-instances`, {
      method: "POST",
      body: { id: rejectedId, gate_profile_version: "flow-v1", current_gate: "G1" },
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `pi_${rejectedId}` },
    });
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected.json)).toMatchObject({ code: "conflict", message: "PROCESS_PROFILE_IMMUTABLE" });
    expect((await harness.client.query("SELECT 1 FROM process_instance WHERE id=$1", [rejectedId])).rows).toHaveLength(0);
  });

  test("modern snapshots inherit the frozen GJB profile and reject flow-v1", async () => {
    const projectId = `eng_${randomUUID()}`;
    const created = await create({
      id: projectId,
      name: "Modern snapshot binding",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
    });
    expect(created.status).toBe(201);
    const revisionId = await createRevisionFor(projectId);

    const inheritedId = `snapshot_${randomUUID()}`;
    const inherited = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/snapshots`, {
      method: "POST",
      body: {
        id: inheritedId,
        member_revision_ids: [revisionId],
        tool_model_policy_hash: `policy_${inheritedId}`,
      },
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `snapshot_${inheritedId}` },
    });
    expect(inherited.status).toBe(201);
    expect((await harness.client.query(
      "SELECT gate_profile_version FROM configuration_snapshot WHERE id=$1",
      [inheritedId],
    )).rows[0]!.gate_profile_version).toBe("GJB_REF_V1");

    const rejectedId = `snapshot_${randomUUID()}`;
    const rejected = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/snapshots`, {
      method: "POST",
      body: {
        id: rejectedId,
        member_revision_ids: [revisionId],
        gate_profile_version: "flow-v1",
        tool_model_policy_hash: `policy_${rejectedId}`,
      },
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `snapshot_${rejectedId}` },
    });
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected.json)).toMatchObject({ code: "conflict", message: "PROCESS_PROFILE_IMMUTABLE" });
    expect((await harness.client.query(
      "SELECT 1 FROM configuration_snapshot WHERE id=$1",
      [rejectedId],
    )).rows).toHaveLength(0);
  });

  test("modern gate submissions fail closed on mismatched process and snapshot profiles", async () => {
    const projectId = `eng_${randomUUID()}`;
    const created = await create({
      id: projectId,
      name: "Modern submission binding",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
    });
    expect(created.status).toBe(201);
    const validProcessId = dataOf(created.json).process_instances[0].id as string;
    const revisionId = await createRevisionFor(projectId);
    const validSnapshotId = `snapshot_${randomUUID()}`;
    const validSnapshot = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/snapshots`, {
      method: "POST",
      body: {
        id: validSnapshotId,
        member_revision_ids: [revisionId],
        tool_model_policy_hash: `policy_${validSnapshotId}`,
      },
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `snapshot_${validSnapshotId}` },
    });
    expect(validSnapshot.status).toBe(201);

    const validSubmissionId = `submission_valid_${randomUUID()}`;
    const validSubmission = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, {
      method: "POST",
      body: {
        id: validSubmissionId,
        process_instance_id: validProcessId,
        gate: "G0",
        snapshot_id: validSnapshotId,
      },
      token: harness.ids.humanToken,
      headers: { "idempotency-key": `submission_${validSubmissionId}` },
    });
    expect(validSubmission.status).toBe(201);
    expect(dataOf(validSubmission.json)).toMatchObject({ id: validSubmissionId, state: "preparing" });

    const mismatchedProcessId = `pi_wrong_${randomUUID()}`;
    const mismatchedSnapshotId = `snapshot_wrong_${randomUUID()}`;
    await harness.client.query(
      `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
       VALUES ($1,$2,'flow-v1','G0')`,
      [mismatchedProcessId, projectId],
    );
    await harness.client.query(
      `INSERT INTO configuration_snapshot (
         id, project_id, member_revision_ids, gate_profile_version,
         tool_model_policy_hash, manifest_hash, created_by
       ) VALUES ($1,$2,ARRAY[$3]::text[],'flow-v1',$4,$5,$6)`,
      [
        mismatchedSnapshotId,
        projectId,
        revisionId,
        `policy_${mismatchedSnapshotId}`,
        `manifest_${mismatchedSnapshotId}`,
        harness.ids.humanUid,
      ],
    );

    const attempts = [
      {
        id: `submission_wrong_process_${randomUUID()}`,
        process_instance_id: mismatchedProcessId,
        snapshot_id: validSnapshotId,
      },
      {
        id: `submission_wrong_snapshot_${randomUUID()}`,
        process_instance_id: validProcessId,
        snapshot_id: mismatchedSnapshotId,
      },
    ];
    for (const attempt of attempts) {
      const idempotencyKey = `submission_${attempt.id}`;
      const response = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, {
        method: "POST",
        body: { ...attempt, gate: "G0" },
        token: harness.ids.humanToken,
        headers: { "idempotency-key": idempotencyKey },
      });
      expect(response.status).toBe(409);
      expect(errorOf(response.json)).toMatchObject({ code: "conflict", message: "PROCESS_PROFILE_IMMUTABLE" });
      const rolledBack = await harness.client.query(
        `SELECT
           (SELECT count(*)::int FROM gate_submission WHERE id=$1) AS submissions,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS outbox,
           (SELECT count(*)::int FROM idempotency_records
             WHERE project_id=$2 AND operation='create_gate_submission' AND idempotency_key=$3) AS idempotency`,
        [attempt.id, projectId, idempotencyKey],
      );
      expect(rolledBack.rows[0]).toMatchObject({ submissions: 0, outbox: 0, idempotency: 0 });
    }
  });

  test("free and LEGACY_COMPAT projects retain the flow-v1 compatibility default", async () => {
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: "free",
        body: { id: `free_${randomUUID()}`, name: "Free compatibility", project_type: "free" },
      },
      {
        label: "legacy",
        body: { id: `legacy_${randomUUID()}`, name: "Legacy compatibility" },
      },
    ];

    for (const entry of cases) {
      const projectId = entry.body.id as string;
      const created = await create(entry.body);
      expect(created.status).toBe(201);

      const processId = `pi_${entry.label}_${randomUUID()}`;
      const process = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/process-instances`, {
        method: "POST",
        body: { id: processId, current_gate: "G0" },
        token: harness.ids.humanToken,
        headers: { "idempotency-key": `pi_${processId}` },
      });
      expect(process.status).toBe(201);
      expect((await harness.client.query(
        "SELECT gate_profile_version FROM process_instance WHERE id=$1",
        [processId],
      )).rows[0]!.gate_profile_version).toBe("flow-v1");

      const revisionId = await createRevisionFor(projectId);
      const snapshotId = `snapshot_${entry.label}_${randomUUID()}`;
      const snapshot = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/snapshots`, {
        method: "POST",
        body: {
          id: snapshotId,
          member_revision_ids: [revisionId],
          tool_model_policy_hash: `policy_${snapshotId}`,
        },
        token: harness.ids.humanToken,
        headers: { "idempotency-key": `snapshot_${snapshotId}` },
      });
      expect(snapshot.status).toBe(201);
      expect((await harness.client.query(
        "SELECT gate_profile_version FROM configuration_snapshot WHERE id=$1",
        [snapshotId],
      )).rows[0]!.gate_profile_version).toBe("flow-v1");

      const submissionId = `submission_${entry.label}_${randomUUID()}`;
      const submission = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/gate-submissions`, {
        method: "POST",
        body: {
          id: submissionId,
          process_instance_id: processId,
          gate: "G0",
          snapshot_id: snapshotId,
        },
        token: harness.ids.humanToken,
        headers: { "idempotency-key": `submission_${submissionId}` },
      });
      expect(submission.status).toBe(201);
      expect(dataOf(submission.json)).toMatchObject({ id: submissionId, state: "preparing" });
    }
  });

  test("same idempotency key replays the persisted G0 and never duplicates rows or events", async () => {
    const id = `eng_${randomUUID()}`;
    const key = `idem_${randomUUID()}`;
    const body = { id, name: "Replay", project_type: "engineering", process_profile_id: "GJB_REF_V1" };
    const first = await create(body, key);
    const replay = await create(body, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(dataOf(replay.json)).toEqual(dataOf(first.json));

    const instance = await harness.client.query(
      "SELECT id, created_at FROM process_instance WHERE project_id=$1",
      [id],
    );
    expect(instance.rows).toHaveLength(1);
    const replayedG0 = dataOf(replay.json).process_instances[0];
    expect(replayedG0.id).toBe(instance.rows[0]!.id);
    expect(new Date(replayedG0.created_at).getTime()).toBe(instance.rows[0]!.created_at.getTime());
    const events = await harness.client.query("SELECT 1 FROM outbox_events WHERE project_id=$1", [id]);
    expect(events.rows).toHaveLength(2);
  });

  test("same project payload under another key returns the existing real G0", async () => {
    const id = `eng_${randomUUID()}`;
    const body = { id, name: "Existing", project_type: "engineering", process_profile_id: "GJB_REF_V1" };
    const first = await create(body, `first_${randomUUID()}`);
    const second = await create(body, `second_${randomUUID()}`);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstG0 = dataOf(first.json).process_instances[0];
    const secondG0 = dataOf(second.json).process_instances[0];
    expect(secondG0.id).toBe(firstG0.id);
    expect(new Date(secondG0.created_at).getTime()).toBe(new Date(firstG0.created_at).getTime());
    const instances = await harness.client.query("SELECT 1 FROM process_instance WHERE project_id=$1", [id]);
    const events = await harness.client.query("SELECT 1 FROM outbox_events WHERE project_id=$1", [id]);
    expect(instances.rows).toHaveLength(1);
    expect(events.rows).toHaveLength(2);
  });

  test("engineering requires an active profile; free rejects a profile", async () => {
    const missing = await create({
      id: `eng_${randomUUID()}`,
      name: "Missing profile",
      project_type: "engineering",
    });
    expect(missing.status).toBe(400);
    expect(errorOf(missing.json).message).toContain("require process_profile_id");

    const invalid = await create({
      id: `eng_${randomUUID()}`,
      name: "Invalid profile",
      project_type: "engineering",
      process_profile_id: "UNKNOWN_V1",
    });
    expect(invalid.status).toBe(400);

    const freeWithProfile = await create({
      id: `free_${randomUUID()}`,
      name: "Free with profile",
      project_type: "free",
      process_profile_id: "GJB_REF_V1",
    });
    expect(freeWithProfile.status).toBe(400);
    expect(await harness.client.query("SELECT 1 FROM project")).toMatchObject({ rows: [] });
  });

  test("modern requests reject compatibility, unsupported active, empty, and conflicting profiles", async () => {
    await harness.client.query(
      "INSERT INTO process_definition(id,name) VALUES ('OTHER_FLOW','Other flow') ON CONFLICT DO NOTHING",
    );
    await harness.client.query(
      `INSERT INTO process_version(id,profile_id,version,name,status)
       VALUES ('OTHER_FLOW_V1','OTHER_FLOW','v1','Other flow v1','active') ON CONFLICT DO NOTHING`,
    );

    const listed = await apiCall(harness.baseUrl, "/api/v1/process-versions", {
      token: harness.ids.humanToken,
    });
    expect((dataOf(listed.json) as unknown as Array<Record<string, unknown>>).map((row) => row.id)).toEqual([
      "GJB_REF_V1",
    ]);

    for (const body of [
      { id: `eng_${randomUUID()}`, name: "Compatibility", project_type: "engineering", process_profile_id: "LEGACY_COMPAT" },
      { id: `eng_${randomUUID()}`, name: "Unsupported", project_type: "engineering", process_profile_id: "OTHER_FLOW_V1" },
      { id: `free_${randomUUID()}`, name: "Empty", project_type: "free", process_profile_id: "" },
      {
        id: `eng_${randomUUID()}`,
        name: "Conflicting aliases",
        project_type: "engineering",
        process_profile_id: "GJB_REF_V1",
        process_version_id: "OTHER_FLOW_V1",
      },
      {
        id: `eng_${randomUUID()}`,
        name: "Conflicting frozen version",
        project_type: "engineering",
        process_profile_id: "GJB_REF_V1",
        process_profile_version: "OTHER_FLOW_V1",
      },
      {
        id: `eng_${randomUUID()}`,
        name: "Client supplied frozen name",
        project_type: "engineering",
        process_profile_id: "GJB_REF_V1",
        process_profile_name: "GJB 参考流程 v1",
      },
      {
        id: `legacy_${randomUUID()}`,
        name: "Not an old request shape",
        process_profile_version: "GJB_REF_V1",
      },
    ]) {
      const response = await create(body);
      expect(response.status).toBe(400);
    }
    expect((await harness.client.query("SELECT 1 FROM project")).rows).toHaveLength(0);
  });

  test("legacy request shape is marked LEGACY_COMPAT and is not given a new GJB instance", async () => {
    const id = `legacy_${randomUUID()}`;
    const response = await create({ id, name: "Legacy request" });
    expect(response.status).toBe(201);
    expect(dataOf(response.json)).toMatchObject({
      project_type: "engineering",
      process_version_id: "LEGACY_COMPAT",
      process_profile_id: "LEGACY_COMPAT",
      process_profile_version: "LEGACY_COMPAT",
      process_profile_name: "兼容旧流程",
      target_part: "xc7vx690tffg1761-2",
      process_instances: [],
    });
    const instances = await harness.client.query("SELECT 1 FROM process_instance WHERE project_id=$1", [id]);
    expect(instances.rows).toHaveLength(0);
  });

  test("database trigger freezes project type and process binding but permits unrelated edits", async () => {
    const id = `eng_${randomUUID()}`;
    await create({ id, name: "Immutable", project_type: "engineering", process_profile_id: "GJB_REF_V1" });

    await harness.client.query("UPDATE project SET name='Renamed' WHERE id=$1", [id]);
    expect((await harness.client.query("SELECT name FROM project WHERE id=$1", [id])).rows[0]!.name).toBe("Renamed");

    for (const sql of [
      "UPDATE project SET project_type='free' WHERE id=$1",
      "UPDATE project SET process_version_id='LEGACY_COMPAT' WHERE id=$1",
      "UPDATE project SET process_profile_id='LEGACY_COMPAT' WHERE id=$1",
      "UPDATE project SET process_profile_version='LEGACY_COMPAT' WHERE id=$1",
      "UPDATE project SET process_profile_name='changed' WHERE id=$1",
    ]) {
      try {
        await harness.client.query(sql, [id]);
        throw new Error(`expected immutable trigger rejection: ${sql}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("55000");
      }
    }
  });

  test("database check accepts only exact free, GJB_REF_V1, or LEGACY_COMPAT shapes", async () => {
    await harness.client.query(
      "INSERT INTO process_definition(id,name) VALUES ('OTHER_FLOW','Other flow') ON CONFLICT DO NOTHING",
    );
    await harness.client.query(
      `INSERT INTO process_version(id,profile_id,version,name,status)
       VALUES ('OTHER_FLOW_V1','OTHER_FLOW','v1','Other flow v1','active') ON CONFLICT DO NOTHING`,
    );
    for (const sql of [
      "INSERT INTO project(id,name,project_type) VALUES ('invalid_free','invalid free','free')",
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ('invalid_engineering','invalid engineering','engineering',NULL,NULL,NULL,NULL)`,
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ('mixed_aliases','mixed aliases','engineering','GJB_REF_V1','LEGACY_COMPAT','GJB_REF_V1','GJB 参考流程 v1')`,
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ('wrong_version','wrong version','engineering','GJB_REF_V1','GJB_REF_V1','LEGACY_COMPAT','GJB 参考流程 v1')`,
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ('wrong_name','wrong name','engineering','GJB_REF_V1','GJB_REF_V1','GJB_REF_V1','renamed')`,
      `INSERT INTO project(
         id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name
       ) VALUES ('unsupported','unsupported','engineering','OTHER_FLOW_V1','OTHER_FLOW_V1','v1','Other flow v1')`,
    ]) {
      try {
        await harness.client.query(sql);
        throw new Error(`expected process binding check rejection: ${sql}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("23514");
      }
    }
  });

  test("process-version identity is immutable, retirement is one-way, and delete is rejected", async () => {
    for (const sql of [
      "UPDATE process_version SET profile_id='LEGACY_COMPAT' WHERE id='GJB_REF_V1'",
      "UPDATE process_version SET version='v2' WHERE id='GJB_REF_V1'",
      "UPDATE process_version SET name='renamed' WHERE id='GJB_REF_V1'",
      "UPDATE process_version SET status='active' WHERE id='LEGACY_COMPAT'",
      "DELETE FROM process_version WHERE id='GJB_REF_V1'",
    ]) {
      try {
        await harness.client.query(sql);
        throw new Error(`expected immutable process-version rejection: ${sql}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("55000");
      }
    }

    await harness.client.query("BEGIN");
    try {
      await harness.client.query("UPDATE process_version SET status='retired' WHERE id='GJB_REF_V1'");
      expect((await harness.client.query("SELECT status FROM process_version WHERE id='GJB_REF_V1'")).rows[0]!.status).toBe("retired");
    } finally {
      await harness.client.query("ROLLBACK");
    }
  });

  test("workspace failure rolls back the idempotency slot and the same-key retry succeeds", async () => {
    const id = `workspace_failure_${randomUUID()}`;
    const key = `workspace_failure_key_${randomUUID()}`;
    const body = { id, name: "Workspace failure", project_type: "free" };
    const blockedRoot = join(harness.workspacesDir, `not_a_directory_${randomUUID()}`);
    await writeFile(blockedRoot, "blocked", "utf8");
    process.env.SYNTHIA_WORKSPACES_DIR = blockedRoot;
    let failed;
    try {
      failed = await create(body, key);
    } finally {
      process.env.SYNTHIA_WORKSPACES_DIR = harness.workspacesDir;
    }
    expect(failed!.status).toBe(500);
    const afterFailure = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM project WHERE id=$1) AS projects,
         (SELECT count(*)::int FROM idempotency_records WHERE project_id=$1) AS idempotency,
         (SELECT count(*)::int FROM outbox_events WHERE project_id=$1) AS outbox`,
      [id],
    );
    expect(afterFailure.rows[0]).toMatchObject({ projects: 0, idempotency: 0, outbox: 0 });

    const retry = await create(body, key);
    expect(retry.status).toBe(201);
    expect(dataOf(retry.json).id).toBe(id);
  });

  test("copy-as-engineering formalizes free project metadata without copying workspace content", async () => {
    const sourceId = `free_source_${randomUUID()}`;
    const source = await create({
      id: sourceId,
      name: "Free source",
      project_type: "free",
      scope: "source scope",
      data_classification: "D2",
      standard_version: "source-standard",
      target_part: "xc7a100t",
      toolchain_profile_ref: "toolchain/source",
    });
    expect(source.status).toBe(201);
    await writeFile(join(harness.workspacesDir, sourceId, "rtl", "source.v"), "module source; endmodule\n", "utf8");

    const targetId = `formal_${randomUUID()}`;
    const key = `copy_key_${randomUUID()}`;
    const first = await copyAsEngineering(sourceId, { id: targetId, name: "Formal target" }, key);
    expect(first.status).toBe(201);
    const data = dataOf(first.json);
    expect(data).toMatchObject({
      id: targetId,
      name: "Formal target",
      project_type: "engineering",
      process_version_id: "GJB_REF_V1",
      process_profile_id: "GJB_REF_V1",
      process_profile_version: "GJB_REF_V1",
      process_profile_name: "GJB 参考流程 v1",
      target_part: "xc7a100t",
      workspace_content_copied: false,
      source_relation: {
        source_project_id: sourceId,
        target_project_id: targetId,
        relation_kind: "copied_as_engineering",
      },
    });
    expect(data.process_instances).toHaveLength(1);
    expect(data.process_instances[0]).toMatchObject({
      id: `pi_${targetId}_G0`,
      gate_profile_version: "GJB_REF_V1",
      current_gate: "G0",
    });

    const target = await harness.client.query(
      `SELECT scope, data_classification, standard_version, target_part, toolchain_profile_ref
         FROM project WHERE id=$1`,
      [targetId],
    );
    expect(target.rows[0]).toMatchObject({
      scope: "source scope",
      data_classification: "D2",
      standard_version: "source-standard",
      target_part: "xc7a100t",
      toolchain_profile_ref: "toolchain/source",
    });
    await expect(stat(join(harness.workspacesDir, targetId, "rtl", "source.v"))).rejects.toThrow();

    const refreshed = await apiCall(harness.baseUrl, `/api/v1/projects/${targetId}`, {
      token: harness.ids.humanToken,
    });
    expect(dataOf(refreshed.json).source_relation).toMatchObject({
      source_project_id: sourceId,
      target_project_id: targetId,
    });

    const replay = await copyAsEngineering(sourceId, { id: targetId, name: "Formal target" }, key);
    expect(replay.status).toBe(201);
    expect(dataOf(replay.json)).toEqual(data);
    const counts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM project WHERE id=$1) AS projects,
         (SELECT count(*)::int FROM process_instance WHERE project_id=$1) AS instances,
         (SELECT count(*)::int FROM project_source_relation WHERE target_project_id=$1) AS relations,
         (SELECT count(*)::int FROM outbox_events WHERE project_id=$1) AS events`,
      [targetId],
    );
    expect(counts.rows[0]).toMatchObject({ projects: 1, instances: 1, relations: 1, events: 3 });

    const changedReplay = await copyAsEngineering(sourceId, { id: targetId, name: "Different" }, key);
    expect(changedReplay.status).toBe(409);
  });

  test("copy-as-engineering accepts LEGACY_COMPAT but rejects modern engineering sources and process overrides", async () => {
    const legacyId = `legacy_source_${randomUUID()}`;
    expect((await create({ id: legacyId, name: "Legacy source" })).status).toBe(201);
    const legacyCopy = await copyAsEngineering(legacyId, {
      id: `legacy_target_${randomUUID()}`,
      name: "Legacy formalized",
      target_part: null,
    });
    expect(legacyCopy.status).toBe(201);
    expect(dataOf(legacyCopy.json)).toMatchObject({
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
      target_part: null,
    });

    const modernId = `modern_source_${randomUUID()}`;
    expect((await create({
      id: modernId,
      name: "Modern source",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
    })).status).toBe(201);
    const denied = await copyAsEngineering(modernId, {
      id: `modern_target_${randomUUID()}`,
      name: "Must fail",
    });
    expect(denied.status).toBe(409);
    expect(errorOf(denied.json).message).toContain("PROJECT_COPY_SOURCE_NOT_ELIGIBLE");

    const override = await copyAsEngineering(legacyId, {
      id: `override_target_${randomUUID()}`,
      name: "Must fail",
      process_profile_id: "GJB_REF_V1",
    });
    expect(override.status).toBe(400);
  });

  test("migration replay preserves explicit free rows and defaults rolled-back service rows to compatibility", async () => {
    const freeId = `free_replay_${randomUUID()}`;
    await harness.client.query(
      `INSERT INTO project(id,name,project_type,process_version_id,process_profile_id,process_profile_version,process_profile_name)
       VALUES ($1,'explicit free','free',NULL,NULL,NULL,NULL)`,
      [freeId],
    );
    const legacyId = `rollback_${randomUUID()}`;
    await harness.client.query("INSERT INTO project(id,name) VALUES ($1,'rollback legacy')", [legacyId]);
    const migration = readFileSync(new URL("../src/db/migrations/0006_project_type_process_version.sql", import.meta.url), "utf8");
    await harness.client.query(migration);
    await harness.client.query(migration);

    const freeRow = await harness.client.query(
      `SELECT project_type, process_version_id, process_profile_id,
              process_profile_version, process_profile_name
         FROM project WHERE id=$1`,
      [freeId],
    );
    expect(freeRow.rows[0]).toMatchObject({
      project_type: "free",
      process_version_id: null,
      process_profile_id: null,
      process_profile_version: null,
      process_profile_name: null,
    });

    const legacyRow = await harness.client.query(
      `SELECT project_type, process_version_id, process_profile_id,
              process_profile_version, process_profile_name
         FROM project WHERE id=$1`,
      [legacyId],
    );
    expect(legacyRow.rows[0]).toMatchObject({
      project_type: "engineering",
      process_version_id: "LEGACY_COMPAT",
      process_profile_id: "LEGACY_COMPAT",
      process_profile_version: "LEGACY_COMPAT",
      process_profile_name: "兼容旧流程",
    });
    const seeds = await harness.client.query(
      "SELECT id FROM process_version WHERE id IN ('GJB_REF_V1','LEGACY_COMPAT') ORDER BY id",
    );
    expect(seeds.rows.map((seed) => seed.id)).toEqual(["GJB_REF_V1", "LEGACY_COMPAT"]);
  });
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; project-model PostgreSQL tests were not executed", () => {});
}
