import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { ApiHarness } from "./support/api-harness.ts";
import { apiCall, setupApiHarness, teardownApiHarness, truncateDomainTables } from "./support/api-harness.ts";
import { bindJobConfiguration, lockProjectConfiguration, readJobConfigurationMetadata } from "../src/services/project-configuration.ts";
import type { ConnectorPort, SubmitJobParams } from "../src/api/connector-port.ts";
import { sha256Hex } from "../src/hashing.ts";
import type { RuntimeClient, RuntimeAgentSummary } from "../src/api/task-proxy.ts";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("free project configuration epochs", () => {
  let harness: ApiHarness;
  let projectId: string;
  const submissions: SubmitJobParams[] = [];
  let legacyAgents: RuntimeAgentSummary[] = [];
  const runtime = { async listTasks() { return { agents: legacyAgents }; } } as RuntimeClient;
  const connector: ConnectorPort = {
    connectorId: "configuration-test", async discover() { return { capabilities: [], drift: false }; },
    async submitJob(input) { submissions.push(input); return { jobId: input.jobId, state: "queued" }; },
    async queryStatus(_projectId, jobId) { return { jobId, state: "succeeded" }; },
    async fetchEvidence(_projectId, jobId) { return { jobId, entries: [] }; },
    async fetchEvidenceContent(_projectId, _jobId, name) { return { name, content: "report", sha256: "a".repeat(64), truncated: false, mediaType: "text/plain" }; },
  };
  const data = (response: { json: unknown }) => (response.json as { data: Record<string, any> }).data;

  beforeAll(async () => { harness = await setupApiHarness(databaseUrl!, { connector, runtimeClient: runtime, features: { sideTasks: true } }); });
  afterAll(async () => { if (harness) await teardownApiHarness(harness); });
  beforeEach(async () => {
    await truncateDomainTables(harness.client);
    submissions.length = 0;
    legacyAgents = [];
    projectId = `config-${randomUUID()}`;
    const response = await apiCall(harness.baseUrl, "/api/v1/projects", {
      method: "POST", token: harness.ids.humanToken, headers: { "idempotency-key": randomUUID() },
      body: { id: projectId, name: "Configuration", project_type: "free", target_part: "part-a" },
    });
    expect(response.status).toBe(201);
  });

  const read = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/settings`, { token: harness.ids.humanToken });
  const edit = (body: Record<string, unknown>, token = harness.ids.humanToken, key = randomUUID()) =>
    apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/settings`, {
      method: "PATCH", token, headers: { "idempotency-key": key }, body,
    });

  async function job(state = "submitted", epoch: number | null = 1, chain = "chain-a", operation = "validate_sources"): Promise<string> {
    const jobId = `job-${randomUUID()}`;
    await harness.client.query(`INSERT INTO tool_run(id,project_id,operation,run_class,state,correlation_id,config_epoch,validation_chain_hash)
      VALUES ($1,$2,$3,'exploratory',$4,'test',$5,$6)`, [jobId, projectId, operation, state, epoch, chain]);
    return jobId;
  }

  test("configuration edits advance epochs, same-value saves and display edits do not; returning never revives evidence", async () => {
    expect(data(await read()).history).toHaveLength(1);
    expect(data(await edit({ expected_revision: 1, target_part: "part-b" })).config_epoch).toBe(2);
    expect(data(await edit({ expected_revision: 2, target_part: "part-b" })).settings_revision).toBe(2);
    expect(data(await edit({ expected_revision: 2, name: "Renamed", description: "Description" })).config_epoch).toBe(2);
    expect(data(await edit({ expected_revision: 3, target_part: "part-a" })).config_epoch).toBe(3);
    const settings = data(await read());
    expect(settings.history.map((snapshot: { epoch: number }) => snapshot.epoch)).toEqual([3, 2, 1]);
    await expect(harness.client.query("UPDATE project_configuration SET target_part='forged' WHERE project_id=$1", [projectId])).rejects.toMatchObject({ code: "55000" });
  });

  test("busy and uncertain jobs reject all verification edits but permit display changes", async () => {
    for (const state of ["submitted", "queued", "running", "cancelling", "lost", "unknown_effect"]) {
      const jobId = await job(state);
      const settings = data(await read());
      const rejected = await edit({ expected_revision: settings.settings_revision, target_part: "part-b", name: "Should not save" });
      expect(rejected.status).toBe(409);
      expect(data(await read()).name).not.toBe("Should not save");
      expect((await edit({ expected_revision: settings.settings_revision, name: `Name ${state}` })).status).toBe(200);
      await harness.client.query("UPDATE tool_run SET state='cancelled' WHERE id=$1", [jobId]);
    }
    const current = data(await read());
    expect((await edit({ expected_revision: current.settings_revision, target_part: "part-b" })).status).toBe(200);
  });

  test("permissions, stale edits, invalid devices and paths are rejected", async () => {
    expect((await edit({ expected_revision: 1, target_part: "part-b" }, harness.ids.serviceToken)).status).toBe(403);
    expect((await edit({ expected_revision: 1, target_part: "any" })).status).toBe(400);
    expect((await edit({ expected_revision: 1, constraints: [{ path: "../escape.xdc", content: "" }] })).status).toBe(400);
    expect((await edit({ expected_revision: 1, target_frequency_mhz: -1 })).status).toBe(400);
    expect((await edit({ expected_revision: 1, name: "New" })).status).toBe(200);
    expect((await edit({ expected_revision: 1, name: "Stale" })).status).toBe(409);
  });

  test("ordinary project members can read settings but only an owner can edit", async () => {
    const token = randomUUID();
    await harness.client.query("INSERT INTO auth_token(token_hash,user_id,scope) SELECT $1,id,ARRAY['core:write','core:read'] FROM user_account WHERE uid=$2", [sha256Hex(token), harness.ids.humanUid]);
    expect((await edit({ expected_revision: 1, name: "Owner edit" }, token)).status).toBe(200);
    await harness.client.query("UPDATE role_assignment SET role='reviewer' WHERE project_id=$1 AND actor_id=$2", [projectId, harness.ids.humanUid]);
    expect((await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/settings`, { token })).status).toBe(200);
    expect((await edit({ expected_revision: 2, name: "Forbidden edit" }, token)).status).toBe(403);
    await harness.client.query("DELETE FROM role_assignment WHERE project_id=$1 AND actor_id=$2", [projectId, harness.ids.humanUid]);
    expect((await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/settings`, { token })).status).toBe(404);
  });

  test("job binding resolves defaults and rejects contradictory configuration", async () => {
    await edit({ expected_revision: 1, target_frequency_mhz: 100, constraints: [{ path: "constraints/timing.xdc", content: "create_clock -period 10 [get_ports clk]" }] });
    const sources = [{ path: "top.v", content: "module top; endmodule" }];
    const configuration = await bindJobConfiguration(harness.client, projectId, null, [], sources, "top");
    expect(configuration.part).toBe("part-a");
    expect(configuration.epoch).toBe(2);
    expect(configuration.constraints).toHaveLength(1);
    expect(configuration.chainHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(bindJobConfiguration(harness.client, projectId, "part-b", [], sources, "top")).rejects.toThrow("PROJECT_PART_MISMATCH");
    await expect(bindJobConfiguration(harness.client, projectId, null, [{ path: "constraints/timing.xdc", content: "forged" }], sources, "top")).rejects.toThrow("PROJECT_CONSTRAINTS_MISMATCH");
  });

  test("API submissions bind effective inputs and replay their frozen device after configuration changes", async () => {
    const path = `/api/v1/projects/${projectId}/jobs`;
    const key = randomUUID();
    const submit = () => apiCall(harness.baseUrl, path, { method: "POST", token: harness.ids.humanToken, headers: { "idempotency-key": key },
      body: { operation: "validate_sources", sources: [{ path: "top.v", content: "module top; endmodule" }] } });
    const first = await submit();
    expect(first.status).toBe(201);
    expect(submissions[0]?.parameters.part).toBe("part-a");
    const persisted = (await harness.client.query("SELECT input_manifest_hash,parameters,config_epoch FROM tool_run WHERE id=$1", [data(first).jobId])).rows[0];
    expect(persisted.input_manifest_hash).toBe(submissions[0]?.inputHash);
    expect(persisted.config_epoch).toBe(1);
    await harness.client.query("UPDATE tool_run SET state='succeeded' WHERE id=$1", [data(first).jobId]);
    await edit({ expected_revision: 1, target_part: "part-b" });
    const replay = await submit();
    expect(replay.status).toBe(201);
    expect(data(replay).jobId).toBe(data(first).jobId);
    expect(submissions).toHaveLength(1);
    expect(submissions.at(-1)?.parameters.part).toBe("part-a");
    const report = await apiCall(harness.baseUrl, `${path}/${data(first).jobId}/evidence/content?name=baseline-summary.json`, { token: harness.ids.humanToken });
    expect(data(report)).toMatchObject({ configEpoch: 1, evidenceScope: "historical", configuration: { target_part: "part-a" } });
  });

  test("design fingerprints join RTL-only stages with a simulation testbench and an inferred validate top", async () => {
    const rtl = { path: "rtl/top.v", content: "module top; endmodule" };
    const tb = { path: "tb/top_tb.v", content: "module top_tb; top dut(); initial begin $finish; end endmodule" };
    const validated = await bindJobConfiguration(harness.client, projectId, null, [], [rtl], null);
    const simulation = await bindJobConfiguration(harness.client, projectId, null, [], [rtl, tb], "top");
    expect(validated.chainHash).toBe(simulation.chainHash);
    const changed = await bindJobConfiguration(harness.client, projectId, null, [], [{ ...rtl, content: "module top; wire changed; endmodule" }, tb], "top");
    expect(changed.chainHash).not.toBe(simulation.chainHash);
  });

  test("same-key settings retries do not create another configuration epoch", async () => {
    const key = randomUUID();
    const first = await edit({ expected_revision: 1, target_part: "part-b" }, harness.ids.humanToken, key);
    const replay = await edit({ expected_revision: 1, target_part: "part-b" }, harness.ids.humanToken, key);
    expect(replay.status).toBe(200);
    expect(data(replay).config_epoch).toBe(data(first).config_epoch);
    expect(data(await read()).history).toHaveLength(2);
  });

  test("current summaries cannot mix epochs or independent validation chains", async () => {
    for (const operation of ["validate_sources", "simulate", "synthesize", "implement"]) await job("succeeded", 1, "chain-a", operation);
    const summary = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/tool-summary`, { token: harness.ids.humanToken });
    expect(data(await summary()).validationState).toBe("passed");
    await job("succeeded", 1, "chain-b", "validate_sources");
    expect(data(await summary()).validationState).toBe("pending");
    const settings = data(await read());
    await edit({ expected_revision: settings.settings_revision, target_part: "part-b" });
    const next = data(await summary());
    expect(next.validationState).toBe("pending");
    expect(next.stages.every((stage: { state: string }) => stage.state === "never")).toBe(true);
    const history = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/jobs`, { token: harness.ids.humanToken });
    expect((data(history) as unknown as { evidenceScope: string }[]).every((entry) => entry.evidenceScope === "historical")).toBe(true);
  });

  test("a newer simulation requires downstream stages to be rerun before passing", async () => {
    for (const operation of ["validate_sources", "simulate", "synthesize", "implement"]) await job("succeeded", 1, "chain-a", operation);
    const summary = () => apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/tool-summary`, { token: harness.ids.humanToken });
    expect(data(await summary()).validationState).toBe("passed");
    await job("succeeded", 1, "chain-a", "simulate");
    expect(data(await summary()).validationState).toBe("pending");
    expect(data(await summary()).stages[2].state).toBe("stale");
    await job("succeeded", 1, "chain-a", "synthesize");
    await job("succeeded", 1, "chain-a", "implement");
    expect(data(await summary()).validationState).toBe("passed");
  });

  test("database rejects configuration rewrites and historical job reactivation", async () => {
    const original = await job("succeeded");
    await expect(harness.client.query("UPDATE project SET target_part='part-b' WHERE id=$1", [projectId])).rejects.toMatchObject({ code: "23514" });
    await expect(harness.client.query("UPDATE tool_run SET parameters='{}'::jsonb || '{\"part\":\"forged\"}'::jsonb WHERE id=$1", [original])).rejects.toMatchObject({ code: "55000" });
    await edit({ expected_revision: 1, target_part: "part-b" });
    await expect(harness.client.query("UPDATE tool_run SET state='queued' WHERE id=$1", [original])).rejects.toMatchObject({ code: "23514" });
  });

  test("unknown historical jobs never become current evidence and stale task bindings are rejected", async () => {
    const original = await job("succeeded", null);
    const listed = await apiCall(harness.baseUrl, `/api/v1/projects/${projectId}/jobs`, { token: harness.ids.humanToken });
    expect((data(listed) as unknown as { id: string; evidenceScope: string }[]).find(entry => entry.id === original)?.evidenceScope).toBe("unattributed");
    await expect(bindJobConfiguration(harness.client, projectId, "part-a", [], [], "top", "missing-task")).rejects.toThrow("TASK_CONFIGURATION_STALE");
  });

  test("queued and running Agent turns block editing and bind a new configuration on the next turn", async () => {
    const id = `task-${randomUUID()}`;
    await harness.client.query(`INSERT INTO agent_task(id,project_id,project_type,kind,agent_role,runtime_actor_id,objective,authorization_scope,status,input_hash,created_by_type,created_by)
      VALUES ($1,$2,'free','main','project',$3,'test','{}','queued',$4,'human',$5)`, [id, projectId, harness.ids.serviceUid, "a".repeat(64), harness.ids.humanUid]);
    expect((await edit({ expected_revision: 1, target_part: "part-b" })).status).toBe(409);
    await harness.client.query("UPDATE agent_task SET status='running' WHERE id=$1", [id]);
    expect((await edit({ expected_revision: 1, target_part: "part-b" })).status).toBe(409);
    await harness.client.query("UPDATE agent_task SET status='awaiting_user' WHERE id=$1", [id]);
    expect((await edit({ expected_revision: 1, target_part: "part-b" })).status).toBe(200);
    await harness.client.query("UPDATE agent_task SET status='queued' WHERE id=$1", [id]);
    expect((await harness.client.query("SELECT config_epoch FROM agent_task WHERE id=$1", [id])).rows[0].config_epoch).toBe(2);
    const unknown = await job("succeeded", null);
    expect(await readJobConfigurationMetadata(harness.client, projectId, unknown)).toMatchObject({ evidenceScope: "unattributed", configuration: null });
  });

  test("unregistered legacy Runtime activity also blocks configuration changes", async () => {
    legacyAgents = [{ agent_id: "legacy-active", project_id: projectId, status: "running", kind: "main" } as RuntimeAgentSummary];
    expect(data(await read()).blockers).toContainEqual({ kind: "task", id: "legacy-active", state: "legacy_running" });
    expect((await edit({ expected_revision: 1, target_part: "part-b" })).status).toBe(409);
    expect((await edit({ expected_revision: 1, name: "Display edit" })).status).toBe(200);
    legacyAgents = [];
    expect((await edit({ expected_revision: 2, target_part: "part-b" })).status).toBe(200);
  });

  test("project lock prevents a concurrent configuration edit from passing a job registration", async () => {
    const connection = new Client({ connectionString: databaseUrl });
    await connection.connect();
    try {
      await connection.query("BEGIN");
      await lockProjectConfiguration(connection, projectId);
      const pending = edit({ expected_revision: 1, target_part: "part-b" });
      await connection.query(`INSERT INTO tool_run(id,project_id,operation,run_class,state,correlation_id,config_epoch)
        VALUES ($1,$2,'simulate','exploratory','submitted','test',1)`, [`job-${randomUUID()}`, projectId]);
      await connection.query("COMMIT");
      expect((await pending).status).toBe(409);
      expect(data(await read()).config_epoch).toBe(1);
    } finally { await connection.query("ROLLBACK"); await connection.end(); }
  });
});
