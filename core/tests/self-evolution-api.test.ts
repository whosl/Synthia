/** Real PostgreSQL integration gate for Self-Evolution v1. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { startSynthiaServer, type SynthiaServer } from "../src/api/server.ts";
import type { RuntimeClient } from "../src/api/task-proxy.ts";
import { sha256Hex } from "../src/hashing.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  type ApiHarness,
} from "./support/api-harness.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const hash = (value: string): string => sha256Hex(value);
const row = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const data = (value: unknown): Record<string, unknown> => row(row(value).data);

describe.skipIf(!DATABASE_URL)("Self-Evolution v1 — real PostgreSQL API", () => {
  let harness: ApiHarness;
  let testDatabaseUrl = "";
  let databaseName = "";
  let distillerToken = "";
  let curatorToken = "";
  let schedulerToken = "";
  let rolloutOffServer: SynthiaServer | null = null;

  beforeAll(async () => {
    const base = new URL(DATABASE_URL);
    databaseName = `synthia_selfevo_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: base.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await admin.end();
    base.pathname = `/${databaseName}`;
    testDatabaseUrl = base.toString();
    const runtimeClient: RuntimeClient = {
      createTask: async (body) => ({ agent_id: String(body.task_id ?? "unused") }),
      startTask: async () => ({ started: true, status: "running" }),
      listTasks: async () => ({ agents: [] }),
      getTask: async (agentId) => ({
        agent_id: agentId,
        project_id: "unused",
        status: "running",
        kind: "main",
      }),
      sendMessage: async () => ({ accepted: true }),
      abortTask: async () => ({ aborted: true }),
      streamTask: async () => new Response("event: done\ndata: {}\n\n"),
    };
    harness = await setupApiHarness(testDatabaseUrl, {
      features: { selfEvolution: true },
      runtimeClient,
    });

    const identity = await harness.client.query("SELECT id FROM user_account WHERE uid=$1", [harness.ids.serviceUid]);
    const userId = String(identity.rows[0]!.id);
    distillerToken = randomBytes(32).toString("hex");
    curatorToken = randomBytes(32).toString("hex");
    schedulerToken = randomBytes(32).toString("hex");
    await harness.client.query(
      `INSERT INTO auth_token(token_hash,user_id,scope) VALUES
       ($1,$3,ARRAY['core:evolution-distiller']),
       ($2,$3,ARRAY['core:evolution-curator']),
       ($4,$3,ARRAY['core:evolution-scheduler'])`,
      [hash(distillerToken), hash(curatorToken), userId, hash(schedulerToken)],
    );
  });

  afterAll(async () => {
    rolloutOffServer?.stop();
    if (harness) await teardownApiHarness(harness);
    if (databaseName) {
      const admin = new Client({ connectionString: DATABASE_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  });

  async function seedTask(
    suffix: string,
    agentRole: "project" | "run" = "run",
    status: "running" | "awaiting_user" = "running",
    objective = `objective ${suffix}`,
  ): Promise<{ projectId: string; taskId: string }> {
    const projectId = `project_${suffix}`;
    const taskId = `task_${suffix}`;
    await harness.client.query(
      `INSERT INTO project
        (id,name,scope,project_type,process_version_id,process_profile_id,
         process_profile_version,process_profile_name,status)
       VALUES ($1,$2,'','free',NULL,NULL,NULL,NULL,'active')`,
      [projectId, suffix],
    );
    await harness.client.query(
      `INSERT INTO agent_task
        (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
         process_instance_id,runtime_agent_id,runtime_actor_id,objective,
         authorization_scope,status,input_hash,adoption_state,created_by_type,created_by)
       VALUES ($1,$2,'free','main',$3,NULL,NULL,NULL,$1,$4,$5,'{}'::jsonb,$6,$7,
               'not_applicable','service',$4)`,
      [taskId, projectId, agentRole, harness.ids.serviceUid, objective, status, hash(`input:${suffix}`)],
    );
    return { projectId, taskId };
  }

  async function appendTaskEvent(
    projectId: string,
    taskId: string,
    eventId: string,
    eventKind: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/events`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: {
          "idempotency-key": `idem-${eventId}`,
          "x-synthia-task-id": taskId,
        },
        body: { event_id: eventId, event_kind: eventKind, payload },
      },
    );
    expect(response.status).toBe(201);
    return data(response.json);
  }

  async function claimDistiller(): Promise<Record<string, unknown>> {
    // Most API tests exercise leased-run behavior rather than the auto-seal
    // grace window. Runtime enrichment normally makes the row ready; force the
    // equivalent boundary here for terse fixtures that seal via status only.
    await harness.client.query(
      "UPDATE distillation_run SET ready_at=now() WHERE state='queued'",
    );
    const response = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/distillation-runs/claim",
      { method: "POST", token: distillerToken, body: { worker_id: "distiller-test", lease_seconds: 30 } },
    );
    expect(response.status).toBe(200);
    return row(data(response.json).run);
  }

  const noOpDistillation = (leaseToken: string) => ({
    lease_token: leaseToken,
    input_hash: hash("input"),
    model_id: "model-test",
    prompt_hash: hash("prompt"),
    action: "no_op",
    expected_parent_version_id: null,
    expected_control_revision: null,
    skill: null,
  });

  async function seedPendingApplication(
    suffix: string,
    versionId: string,
  ): Promise<string> {
    const { projectId, taskId } = await seedTask(`pending-${suffix}`);
    const args = {
      version_id: versionId,
      local_goal: `goal ${suffix}`,
      reason_codes: [],
      role: "primary",
    };
    await appendTaskEvent(projectId, taskId, `event-apply-${suffix}`, "tool_call", {
      tool_call_id: `call-apply-${suffix}`,
      name: "learned_skill_apply",
      args,
    });
    const application = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": `application-${suffix}`, "x-synthia-task-id": taskId },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: `call-apply-${suffix}`,
          turn_id: null,
          version_id: versionId,
          local_goal: args.local_goal,
          reason_codes: [],
        },
      },
    );
    expect(application.status).toBe(201);
    await appendTaskEvent(projectId, taskId, `event-terminal-${suffix}`, "status", { status: "failed" });
    return String(data(application.json).application_id);
  }

  async function runCuratorRemediation(
    suffix: string,
    applicationId: string,
    remediation: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const runId = `curator-remediation-${suffix}`;
    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by)
       VALUES ($1,'run','queued',$1,$1,'test','service',$2)`,
      [runId, harness.ids.serviceUid],
    );
    const claimResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      { method: "POST", token: curatorToken, body: { worker_id: `worker-${suffix}`, lease_seconds: 60 } },
    );
    const claim = row(data(claimResponse.json).run);
    const bundles = claim.applications as unknown[];
    const bundle = bundles
      .find((item) => row(row(item).application).application_id === applicationId)!;
    expect(bundle).toBeDefined();
    const remediations = new Map<string, Record<string, unknown>>();
    for (const rawBundle of bundles) {
      const summary = row(row(row(rawBundle).primary_version).skill);
      const skillId = String(summary.skill_id);
      remediations.set(skillId, skillId === remediation.skill_id
        ? remediation
        : {
            skill_id: skillId,
            expected_active_version_id: summary.active_version_id,
            expected_control_revision: summary.control_revision,
            action: "no_op",
          });
    }
    const response = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.run_id}/complete`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: claim.lease_token,
          evaluator_version: `curator-${suffix}-v1`,
          evaluations: bundles.map((rawBundle) => ({
            application_id: row(row(rawBundle).application).application_id,
            evidence_snapshot_hash: row(rawBundle).evidence_snapshot_hash,
            outcome: "execution_failure",
            confidence: 0.9,
            reason: `evaluation ${suffix}`,
            evidence_refs: [],
            eval_job_refs: [],
            supersedes_id: null,
          })),
          remediations: [...remediations.values()],
        },
      },
    );
    expect(response.status).toBe(200);
    return data(response.json);
  }

  test("lease reclaim rejects old tokens and terminal completion replays through pause and rollout-off", async () => {
    const { projectId, taskId } = await seedTask("lease");
    await appendTaskEvent(projectId, taskId, "event-terminal-lease", "status", { status: "failed" });
    const episodeCount = await harness.client.query("SELECT count(*)::int AS count FROM learning_episode WHERE task_id=$1", [taskId]);
    expect(episodeCount.rows[0]!.count).toBe(1);

    const first = await claimDistiller();
    expect(row(first.episode).task_ref).toMatch(/^\[REDACTED:TASK_REF:/);
    expect(row(first.episode).task_ref).not.toBe(taskId);
    await harness.client.query(
      "UPDATE distillation_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [first.run_id],
    );
    const second = await claimDistiller();
    expect(second.run_id).toBe(first.run_id);
    expect(second.lease_token).not.toBe(first.lease_token);
    const stale = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${second.run_id}/complete`,
      { method: "POST", token: distillerToken, body: noOpDistillation(String(first.lease_token)) },
    );
    expect(stale.status).toBe(409);
    const completeBody = noOpDistillation(String(second.lease_token));
    const complete = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${second.run_id}/complete`,
      { method: "POST", token: distillerToken, body: completeBody },
    );
    expect(complete.status).toBe(200);

    await harness.client.query("UPDATE evolution_settings SET learning_paused=true WHERE singleton_id='global'");
    const pausedReplay = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${second.run_id}/complete`,
      { method: "POST", token: distillerToken, body: completeBody },
    );
    expect(pausedReplay.status).toBe(200);
    expect(data(pausedReplay.json).replayed).toBe(true);

    rolloutOffServer = startSynthiaServer(harness.pool, { port: 0, features: { selfEvolution: false } });
    const offBase = `http://${rolloutOffServer.hostname}:${rolloutOffServer.port}`;
    const offReplay = await apiCall(
      offBase,
      `/api/v1/internal/evolution/distillation-runs/${second.run_id}/complete`,
      { method: "POST", token: distillerToken, body: completeBody },
    );
    expect(offReplay.status).toBe(200);
    const changed = { ...completeBody, model_id: "different-model" };
    const changedReplay = await apiCall(
      offBase,
      `/api/v1/internal/evolution/distillation-runs/${second.run_id}/complete`,
      { method: "POST", token: distillerToken, body: changed },
    );
    expect(changedReplay.status).toBe(409);
    rolloutOffServer.stop();
    rolloutOffServer = null;
    await harness.client.query("UPDATE evolution_settings SET learning_paused=false WHERE singleton_id='global'");
  });

  test("auto-sealed runs wait for enrichment and keep a stable first-claim cutoff", async () => {
    const { projectId, taskId } = await seedTask("claim-cutoff");
    const terminal = await appendTaskEvent(
      projectId,
      taskId,
      "event-terminal-claim-cutoff",
      "status",
      { status: "failed" },
    );
    const episodeResult = await harness.client.query(
      "SELECT * FROM learning_episode WHERE task_id=$1",
      [taskId],
    );
    const episode = episodeResult.rows[0]!;
    const immediate = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/distillation-runs/claim",
      { method: "POST", token: distillerToken, body: { worker_id: "cutoff-first", lease_seconds: 30 } },
    );
    expect(data(immediate.json).run).toBeNull();

    await harness.client.query(
      "UPDATE distillation_run SET ready_at=now() WHERE episode_id=$1",
      [episode.id],
    );
    const first = await claimDistiller();
    expect(row(first.episode).content_hash).toBe(episode.content_hash);
    const cutoffBefore = await harness.client.query(
      "SELECT input_cutoff_at FROM distillation_run WHERE id=$1",
      [first.run_id],
    );

    const lateHash = hash("late-runtime-enrichment");
    const enriched = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/learning-episodes`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "late-enrichment", "x-synthia-task-id": taskId },
        body: {
          schema: "learning-episode-create.v1",
          observation_key: `task:${taskId}`,
          episode_key: `terminal:${terminal.sequence}`,
          turn_id: null,
          end_event_sequence: terminal.sequence,
          content_hash: lateHash,
          outcome_claim: "late source-derived result",
          tool_event_start_sequence: null,
          tool_event_end_sequence: null,
          evidence_refs: ["evidence_late_private"],
        },
      },
    );
    expect(enriched.status).toBe(201);

    await harness.client.query(
      "UPDATE distillation_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [first.run_id],
    );
    const reclaimed = await claimDistiller();
    expect(reclaimed.run_id).toBe(first.run_id);
    expect(row(reclaimed.episode).content_hash).toBe(episode.content_hash);
    expect(JSON.stringify(reclaimed)).not.toContain("late source-derived result");
    expect(JSON.stringify(reclaimed)).not.toContain("evidence_late_private");
    const cutoffAfter = await harness.client.query(
      "SELECT input_cutoff_at FROM distillation_run WHERE id=$1",
      [first.run_id],
    );
    expect(cutoffAfter.rows[0]!.input_cutoff_at.toISOString())
      .toBe(cutoffBefore.rows[0]!.input_cutoff_at.toISOString());
    const completed = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${reclaimed.run_id}/complete`,
      { method: "POST", token: distillerToken, body: noOpDistillation(String(reclaimed.lease_token)) },
    );
    expect(completed.status).toBe(200);
  });

  test("Core bounded abort seals cancelled episode and distillation atomically", async () => {
    const { projectId, taskId } = await seedTask("abort");
    const aborted = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/abort`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": "bounded-abort" },
        body: { reason: "test bounded abort" },
      },
    );
    expect(aborted.status).toBe(200);
    const sealed = await harness.client.query(
      `SELECT e.episode_key,e.end_event_sequence,d.state,t.status
         FROM learning_episode e
         JOIN distillation_run d ON d.episode_id=e.id
         JOIN agent_task t ON t.id=e.task_id
        WHERE e.task_id=$1`,
      [taskId],
    );
    expect(sealed.rows).toEqual([expect.objectContaining({
      episode_key: expect.stringMatching(/^terminal:/),
      state: "queued",
      status: "cancelled",
    })]);
    const claim = await claimDistiller();
    expect(row(claim.episode).task_ref).toMatch(/^\[REDACTED:TASK_REF:/);
    expect(row(claim.episode).task_ref).not.toBe(taskId);
    const completed = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${claim.run_id}/complete`,
      { method: "POST", token: distillerToken, body: noOpDistillation(String(claim.lease_token)) },
    );
    expect(completed.status).toBe(200);
  });

  test("distillation create activates only fully scanned metadata and patch uses parent/control CAS", async () => {
    const { projectId, taskId } = await seedTask("create");
    await appendTaskEvent(projectId, taskId, "event-terminal-create", "status", { status: "failed" });
    const run = await claimDistiller();
    const createBody = {
      lease_token: run.lease_token,
      input_hash: hash("create-input"),
      model_id: "model-test",
      prompt_hash: hash("create-prompt"),
      action: "create",
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: {
        slug: "timing-diagnosis",
        name: "Timing diagnosis",
        summary: "Diagnose a repeated timing failure",
        description: "Inspect timing reports and explain a reusable corrective workflow.",
        applicability: { summary: "Use for timing failures after synthesis" },
        outcome_contract: { result: "A verified timing diagnosis" },
        files: [{
          path: "SKILL.md",
          kind: "skill_md",
          language: null,
          content: "# Timing diagnosis\n\nInspect timing evidence and verify the result.\n",
        }],
      },
    };
    const created = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${run.run_id}/complete`,
      { method: "POST", token: distillerToken, body: createBody },
    );
    expect(created.status).toBe(200);
    const versionId = String(data(created.json).version_id);
    const skillResult = await harness.client.query("SELECT * FROM learned_skill WHERE active_version_id=$1", [versionId]);
    const skill = skillResult.rows[0]!;
    expect(skill.control_revision).toBe("1");

    const { projectId: p2, taskId: t2 } = await seedTask("cas");
    await appendTaskEvent(p2, t2, "event-terminal-cas", "status", { status: "failed" });
    const patchRun = await claimDistiller();
    const stalePatch = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${patchRun.run_id}/complete`,
      {
        method: "POST",
        token: distillerToken,
        body: {
          ...createBody,
          lease_token: patchRun.lease_token,
          input_hash: hash("patch-input"),
          prompt_hash: hash("patch-prompt"),
          action: "patch",
          expected_parent_version_id: versionId,
          expected_control_revision: 999,
          skill: { ...createBody.skill, skill_id: skill.id },
        },
      },
    );
    expect(stalePatch.status).toBe(409);
  });

  test("a quarantined create can rebuild and activate the same slug", async () => {
    const createBody = (leaseToken: unknown, unsafe: boolean) => ({
      lease_token: leaseToken,
      input_hash: hash(unsafe ? "rebuild-unsafe-input" : "rebuild-safe-input"),
      model_id: "model-test",
      prompt_hash: hash(unsafe ? "rebuild-unsafe-prompt" : "rebuild-safe-prompt"),
      action: "create",
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: {
        slug: "recoverable-candidate",
        name: "Recoverable candidate",
        summary: "A candidate that can be rebuilt",
        description: "Explain a reusable local workflow.",
        applicability: { summary: "Use for a matching synthesis diagnosis" },
        outcome_contract: { result: "A checked diagnosis" },
        files: [
          {
            path: "SKILL.md",
            kind: "skill_md",
            language: null,
            content: "# Recoverable candidate\n\nInspect the report and verify the diagnosis.\n",
          },
          ...(unsafe ? [{
            path: "references/leak.md",
            kind: "reference",
            language: null,
            content: "Read /tmp/customer-private/report.rpt\n",
          }] : []),
        ],
      },
    });

    const firstTask = await seedTask("rebuild-quarantine");
    await appendTaskEvent(
      firstTask.projectId,
      firstTask.taskId,
      "event-terminal-rebuild-quarantine",
      "status",
      { status: "failed" },
    );
    const firstRun = await claimDistiller();
    const quarantined = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${firstRun.run_id}/complete`,
      { method: "POST", token: distillerToken, body: createBody(firstRun.lease_token, true) },
    );
    expect(quarantined.status).toBe(200);
    expect(data(quarantined.json).state).toBe("quarantined");
    const dead = await harness.client.query(
      "SELECT id,name,summary,applicability_summary,active_version_id FROM learned_skill WHERE slug='recoverable-candidate'",
    );
    expect(dead.rows[0]!.active_version_id).toBeNull();
    expect(dead.rows[0]).toMatchObject({
      name: "Quarantined candidate",
      summary: "Candidate failed deterministic scan",
      applicability_summary: "Unavailable pending a passing deterministic scan",
    });

    const secondTask = await seedTask("rebuild-pass");
    await appendTaskEvent(
      secondTask.projectId,
      secondTask.taskId,
      "event-terminal-rebuild-pass",
      "status",
      { status: "failed" },
    );
    const secondRun = await claimDistiller();
    const rebuilt = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${secondRun.run_id}/complete`,
      { method: "POST", token: distillerToken, body: createBody(secondRun.lease_token, false) },
    );
    expect(rebuilt.status).toBe(200);
    expect(data(rebuilt.json).state).toBe("succeeded");
    const recovered = await harness.client.query(
      `SELECT s.id,s.active_version_id,v.version_no
         FROM learned_skill s
         JOIN learned_skill_version v ON v.id=s.active_version_id
        WHERE s.slug='recoverable-candidate'`,
    );
    expect(recovered.rows[0]).toMatchObject({ id: dead.rows[0]!.id, version_no: 2 });
  });

  test("Project status hook seals once and explicit Runtime create replays as immutable enrichment", async () => {
    const freeTextSecrets = [
      "token=super-secret-runtime-token",
      "secret: customer-password-value",
      "Authorization: Basic dXNlcjpwYXNz",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "credential=very-private-credential",
    ];
    const { projectId, taskId } = await seedTask(
      "project-turn",
      "project",
      "running",
      `keep the token budget bounded; ${freeTextSecrets[0]}`,
    );
    await appendTaskEvent(projectId, taskId, "event-old-user", "user_message", {
      turn_id: "old-turn",
      text: "old turn must not leak",
    });
    await appendTaskEvent(projectId, taskId, "event-project-user", "user_message", {
      turn_id: "turn-1",
      text: `diagnose this timing issue; ${freeTextSecrets[1]}`,
    });
    const toolCall = await appendTaskEvent(projectId, taskId, "event-project-tool", "tool_call", {
      turn_id: "turn-1",
      tool_call_id: "project-tool-1",
      name: "inspect_timing",
      args: { report: freeTextSecrets[2] },
    });
    const toolResult = await appendTaskEvent(projectId, taskId, "event-project-result", "tool_result", {
      turn_id: "turn-1",
      tool_call_id: "project-tool-1",
      name: "inspect_timing",
      ok: true,
      result: { slack: -0.2, note: freeTextSecrets[3] },
    });
    await appendTaskEvent(projectId, taskId, "event-project-correction", "user_message", {
      turn_id: "turn-1",
      correction: true,
      text: `use the generated clock; ${freeTextSecrets[4]}`,
    });
    const terminal = await appendTaskEvent(projectId, taskId, "event-project-settled", "status", {
      turn_id: "turn-1",
      status: "awaiting_user",
    });
    const sealed = await harness.client.query("SELECT * FROM learning_episode WHERE task_id=$1", [taskId]);
    expect(sealed.rows).toHaveLength(1);
    const episode = sealed.rows[0]!;
    // Simulate a lost explicit-create response/restart: later task events do
    // not invalidate enrichment of an already Core-sealed boundary.
    await appendTaskEvent(projectId, taskId, "event-next-turn", "user_message", {
      turn_id: "turn-2",
      text: "a later turn has started",
    });
    const enrichmentHash = hash("runtime-enriched-trajectory");
    const body = {
      schema: "learning-episode-create.v1",
      observation_key: "turn:turn-1",
      episode_key: `turn:turn-1:${terminal.sequence}`,
      turn_id: "turn-1",
      end_event_sequence: terminal.sequence,
      content_hash: enrichmentHash,
      outcome_claim: "timing diagnosis produced",
      tool_event_start_sequence: toolCall.sequence,
      tool_event_end_sequence: toolResult.sequence,
      evidence_refs: ["evidence-runtime-enrichment"],
    };
    const explicit = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/learning-episodes`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "episode-explicit", "x-synthia-task-id": taskId },
        body,
      },
    );
    expect(explicit.status).toBe(201);
    expect(data(explicit.json)).toMatchObject({ episode_id: episode.id, replayed: true });
    const enrichment = await harness.client.query(
      "SELECT * FROM learning_episode_enrichment WHERE episode_id=$1",
      [episode.id],
    );
    expect(enrichment.rows).toHaveLength(1);
    expect(enrichment.rows[0]!.content_hash).toBe(enrichmentHash);

    const claimed = await claimDistiller();
    expect(row(claimed.episode)).toMatchObject({ content_hash: enrichmentHash });
    expect(row(claimed.episode).episode_id).not.toBe(episode.id);
    const trajectory = row(claimed.trajectory);
    const serializedClaim = JSON.stringify(claimed);
    expect(serializedClaim).not.toContain("old turn must not leak");
    for (const secret of freeTextSecrets) expect(serializedClaim).not.toContain(secret);
    expect(serializedClaim).toContain("token budget");
    expect((trajectory.tools as unknown[])).toHaveLength(1);
    const complete = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/distillation-runs/${claimed.run_id}/complete`,
      { method: "POST", token: distillerToken, body: noOpDistillation(String(claimed.lease_token)) },
    );
    expect(complete.status).toBe(200);
  });

  test("application args are event-bound, episode settling is once-only, and Curator reservations/audits are isolated", async () => {
    const skillResult = await harness.client.query("SELECT id,active_version_id,control_revision FROM learned_skill WHERE slug='timing-diagnosis'");
    const skill = skillResult.rows[0]!;
    const versionId = String(skill.active_version_id);
    const { projectId, taskId } = await seedTask("application");
    const primaryArgs = {
      version_id: versionId,
      local_goal: "remove timing failure",
      reason_codes: ["matching-failure"],
      role: "primary",
    };
    await appendTaskEvent(projectId, taskId, "event-apply-a", "tool_call", {
      tool_call_id: "call-apply-a",
      name: "learned_skill_apply",
      args: primaryArgs,
    });
    const createApplication = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "application-create-a", "x-synthia-task-id": taskId },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: "call-apply-a",
          turn_id: null,
          version_id: versionId,
          local_goal: primaryArgs.local_goal,
          reason_codes: primaryArgs.reason_codes,
        },
      },
    );
    expect(createApplication.status).toBe(201);
    const applicationA = String(data(createApplication.json).application_id);
    const replay = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "application-create-a", "x-synthia-task-id": taskId },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: "call-apply-a",
          turn_id: null,
          version_id: versionId,
          local_goal: primaryArgs.local_goal,
          reason_codes: primaryArgs.reason_codes,
        },
      },
    );
    expect(data(replay.json).application_id).toBe(applicationA);

    await appendTaskEvent(projectId, taskId, "event-apply-b", "tool_call", {
      tool_call_id: "call-apply-b",
      name: "learned_skill_apply",
      args: { ...primaryArgs, local_goal: "second goal" },
    });
    const badArgs = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "application-bad", "x-synthia-task-id": taskId },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: "call-apply-b",
          turn_id: null,
          version_id: versionId,
          local_goal: "forged goal",
          reason_codes: primaryArgs.reason_codes,
        },
      },
    );
    expect(badArgs.status).toBe(409);
    const appBResponse = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "application-create-b", "x-synthia-task-id": taskId },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: "call-apply-b",
          turn_id: null,
          version_id: versionId,
          local_goal: "second goal",
          reason_codes: primaryArgs.reason_codes,
        },
      },
    );
    const applicationB = String(data(appBResponse.json).application_id);
    const closeArgs = {
      application_id: applicationA,
      outcome_claim: "timing improved",
      human_corrections: 1,
      evidence_refs: ["evidence-private-a"],
      tool_run_refs: ["tool-private-a"],
    };
    const closeEvent = await appendTaskEvent(projectId, taskId, "event-close-a", "tool_call", {
      tool_call_id: "call-close-a",
      name: "learned_skill_close",
      args: closeArgs,
    });
    const closeBody = {
      schema: "skill-application-close.v1",
      end_event_sequence: closeEvent.sequence,
      outcome_claim: closeArgs.outcome_claim,
      human_corrections: closeArgs.human_corrections,
      evidence_refs: closeArgs.evidence_refs,
      tool_run_refs: closeArgs.tool_run_refs,
    };
    const crossApplication = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications/${applicationB}/close`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "close-cross", "x-synthia-task-id": taskId },
        body: closeBody,
      },
    );
    expect(crossApplication.status).toBe(409);
    const closed = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications/${applicationA}/close`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "close-a", "x-synthia-task-id": taskId },
        body: closeBody,
      },
    );
    expect(closed.status).toBe(200);
    const terminal = await appendTaskEvent(projectId, taskId, "event-terminal-application", "status", { status: "failed" });
    const episodes = await harness.client.query("SELECT * FROM learning_episode WHERE task_id=$1", [taskId]);
    expect(episodes.rows).toHaveLength(1);
    expect(Number(episodes.rows[0]!.end_event_sequence)).toBe(Number(terminal.sequence));
    const settled = await harness.client.query(
      `SELECT id,state,closed_at,(SELECT created_at FROM task_conversation_event WHERE task_id=$1 AND sequence=$2) AS terminal_at
         FROM skill_application WHERE task_id=$1 ORDER BY id`,
      [taskId, terminal.sequence],
    );
    expect(settled.rows.every((item) => item.state === "pending_evaluation")).toBe(true);
    expect(new Date(settled.rows.find((item) => item.id === applicationB)!.closed_at).toISOString())
      .toBe(new Date(settled.rows[0]!.terminal_at).toISOString());

    const runIds = ["curator-concurrent-a", "curator-concurrent-b"];
    for (const runId of runIds) {
      await harness.client.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by)
         VALUES ($1,'run','queued',$1,$1,'test','service',$2)`,
        [runId, harness.ids.serviceUid],
      );
    }
    const claims = await Promise.all(runIds.map((_, index) => apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      { method: "POST", token: curatorToken, body: { worker_id: `curator-${index}`, lease_seconds: 60 } },
    )));
    const claimedRuns = claims.map((response) => row(data(response.json).run));
    const claimedIds = claimedRuns.map((claimed) => (claimed.applications as unknown[])
      .map((bundle) => String(row(row(bundle).application).application_id)));
    expect(claimedIds[0]!.filter((id) => claimedIds[1]!.includes(id))).toEqual([]);
    expect(new Set(claimedIds.flat()).size).toBe(2);
    const populated = claimedRuns.find((claimed) => (claimed.applications as unknown[]).length > 0)!;
    const bundles = populated.applications as unknown[];
    expect(bundles).toHaveLength(2);
    const completeBody = {
      lease_token: populated.lease_token,
      evaluator_version: "curator-test-v1",
      evaluations: bundles.map((rawBundle) => {
        const bundle = row(rawBundle);
        return {
          application_id: row(bundle.application).application_id,
          evidence_snapshot_hash: bundle.evidence_snapshot_hash,
          outcome: "success",
          confidence: 0.95,
          reason: "recorded evidence supports the local goal",
          evidence_refs: [],
          eval_job_refs: [],
          supersedes_id: null,
        };
      }),
      remediations: [...new Map(bundles.map((rawBundle) => {
        const summary = row(row(row(rawBundle).primary_version).skill);
        return [String(summary.skill_id), {
          skill_id: summary.skill_id,
          expected_active_version_id: summary.active_version_id,
          expected_control_revision: summary.control_revision,
          action: "no_op",
        }];
      })).values()],
    };
    const incomplete = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${populated.run_id}/complete`,
      {
        method: "POST",
        token: curatorToken,
        body: { ...completeBody, evaluations: completeBody.evaluations.slice(0, 1) },
      },
    );
    expect(incomplete.status).toBe(400);
    const completed = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${populated.run_id}/complete`,
      { method: "POST", token: curatorToken, body: completeBody },
    );
    expect(completed.status).toBe(200);
    const audits = await harness.client.query(
      "SELECT count(*)::int AS count FROM curator_remediation_audit WHERE curator_run_id=$1",
      [populated.run_id],
    );
    expect(audits.rows[0]!.count).toBe(bundles.length);
    expect(JSON.stringify(populated)).not.toContain("evidence-private-a");
    expect(JSON.stringify(populated)).not.toContain("tool-private-a");
    expect(JSON.stringify(populated)).not.toContain("remove timing failure");
    expect(JSON.stringify(populated)).not.toContain("second goal");
    expect(JSON.stringify(populated)).not.toContain("timing improved");

    const crossProjectDetail = await apiCall(
      harness.baseUrl,
      `/api/v1/skill-applications/${applicationA}`,
      { token: harness.ids.serviceToken },
    );
    expect(crossProjectDetail.status).toBe(200);
    const redactedDetail = JSON.stringify(data(crossProjectDetail.json));
    for (const privateValue of [
      projectId,
      taskId,
      `task:${taskId}`,
      "remove timing failure",
      "matching-failure",
      "timing improved",
      "recorded evidence supports the local goal",
      "evidence-private-a",
      "tool-private-a",
    ]) {
      expect(redactedDetail).not.toContain(privateValue);
    }
  });

  test("dry-run returns complete proposals with zero evaluation/version/lifecycle/remediation writes", async () => {
    const skill = (await harness.client.query("SELECT id,active_version_id FROM learned_skill WHERE slug='timing-diagnosis'")).rows[0]!;
    const { projectId, taskId } = await seedTask("dryrun");
    const args = {
      version_id: skill.active_version_id,
      local_goal: "dry run goal",
      reason_codes: [],
      role: "primary",
    };
    await appendTaskEvent(projectId, taskId, "event-apply-dry", "tool_call", {
      tool_call_id: "call-apply-dry",
      name: "learned_skill_apply",
      args,
    });
    const appResponse = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: { "idempotency-key": "application-dry", "x-synthia-task-id": taskId },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: "call-apply-dry",
          turn_id: null,
          version_id: skill.active_version_id,
          local_goal: args.local_goal,
          reason_codes: [],
        },
      },
    );
    const applicationId = String(data(appResponse.json).application_id);
    await appendTaskEvent(projectId, taskId, "event-terminal-dry", "status", { status: "failed" });
    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by)
       VALUES ('curator-dry','dry_run','queued','dry','dry','test','service',$1)`,
      [harness.ids.serviceUid],
    );
    const before = await harness.client.query(
      `SELECT
        (SELECT count(*) FROM curator_evaluation)::int evaluations,
        (SELECT count(*) FROM curator_remediation_audit)::int remediations,
        (SELECT count(*) FROM learned_skill_version)::int versions,
        (SELECT count(*) FROM learned_skill_lifecycle_event)::int lifecycle`,
    );
    const claimResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      { method: "POST", token: curatorToken, body: { worker_id: "curator-dry", lease_seconds: 60 } },
    );
    const claim = row(data(claimResponse.json).run);
    const bundle = (claim.applications as unknown[]).find((item) => row(row(item).application).application_id === applicationId)!;
    const complete = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.run_id}/complete`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: claim.lease_token,
          evaluator_version: "curator-dry-v1",
          evaluations: [{
            application_id: applicationId,
            evidence_snapshot_hash: row(bundle).evidence_snapshot_hash,
            outcome: "inconclusive",
            confidence: 0.4,
            reason: "dry-run proposal",
            evidence_refs: [],
            eval_job_refs: [],
            supersedes_id: null,
          }],
          remediations: [{
            skill_id: skill.id,
            expected_active_version_id: skill.active_version_id,
            expected_control_revision: row(row(row(bundle).primary_version).skill).control_revision,
            action: "no_op",
          }],
        },
      },
    );
    expect(complete.status).toBe(200);
    expect((data(complete.json).proposed_evaluations as unknown[])).toHaveLength(1);
    expect((data(complete.json).proposed_remediations as unknown[])).toHaveLength(1);
    const after = await harness.client.query(
      `SELECT
        (SELECT count(*) FROM curator_evaluation)::int evaluations,
        (SELECT count(*) FROM curator_remediation_audit)::int remediations,
        (SELECT count(*) FROM learned_skill_version)::int versions,
        (SELECT count(*) FROM learned_skill_lifecycle_event)::int lifecycle`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test("Curator patch, scope_change and state_action are real CAS actions while pinning blocks mutation", async () => {
    let skill = (await harness.client.query(
      "SELECT id,active_version_id,control_revision FROM learned_skill WHERE slug='timing-diagnosis'",
    )).rows[0]!;
    const patchApp = await seedPendingApplication("patch", String(skill.active_version_id));
    const patchResult = await runCuratorRemediation("patch", patchApp, {
      skill_id: skill.id,
      expected_active_version_id: skill.active_version_id,
      expected_control_revision: Number(skill.control_revision),
      action: "patch",
      patch: { description: "Inspect timing evidence, verify the fix, and record reusable steps." },
    });
    expect(patchResult.produced_version_ids as unknown[]).toHaveLength(1);
    skill = (await harness.client.query("SELECT * FROM learned_skill WHERE id=$1", [skill.id])).rows[0]!;
    expect(Number(skill.control_revision)).toBe(2);

    const scopeApp = await seedPendingApplication("scope", String(skill.active_version_id));
    const scopeResult = await runCuratorRemediation("scope", scopeApp, {
      skill_id: skill.id,
      expected_active_version_id: skill.active_version_id,
      expected_control_revision: Number(skill.control_revision),
      action: "scope_change",
      patch: { applicability: { summary: "Use only for post-synthesis timing failures" } },
    });
    expect(scopeResult.produced_version_ids as unknown[]).toHaveLength(1);
    skill = (await harness.client.query("SELECT * FROM learned_skill WHERE id=$1", [skill.id])).rows[0]!;
    expect(Number(skill.control_revision)).toBe(3);

    const pinnedApp = await seedPendingApplication("pinned", String(skill.active_version_id));
    await harness.client.query("UPDATE learned_skill SET pinned=true WHERE id=$1", [skill.id]);
    const pinnedResult = await runCuratorRemediation("pinned", pinnedApp, {
      skill_id: skill.id,
      expected_active_version_id: skill.active_version_id,
      expected_control_revision: Number(skill.control_revision),
      action: "state_action",
      state_action: { action: "archive" },
    });
    expect(pinnedResult.skipped_actions as unknown[]).toEqual([expect.objectContaining({ reason: "skill_controlled" })]);
    const stillPinned = (await harness.client.query("SELECT * FROM learned_skill WHERE id=$1", [skill.id])).rows[0]!;
    expect(stillPinned.availability_state).toBe("available");
    expect(Number(stillPinned.control_revision)).toBe(3);

    await harness.client.query("UPDATE learned_skill SET pinned=false WHERE id=$1", [skill.id]);
    const stateApp = await seedPendingApplication("state", String(skill.active_version_id));
    const stateResult = await runCuratorRemediation("state", stateApp, {
      skill_id: skill.id,
      expected_active_version_id: skill.active_version_id,
      expected_control_revision: Number(skill.control_revision),
      action: "state_action",
      state_action: { action: "archive" },
    });
    expect(stateResult.skipped_actions).toEqual([]);
    const archived = (await harness.client.query("SELECT * FROM learned_skill WHERE id=$1", [skill.id])).rows[0]!;
    expect(archived.availability_state).toBe("archived");
    expect(Number(archived.control_revision)).toBe(4);
  });

  test("human Pin/Unpin and Archive/Restore are strict, idempotent CAS controls with agent visibility isolation", async () => {
    const initial = (await harness.client.query(
      `UPDATE learned_skill
          SET enabled=true,pinned=false,availability_state='available'
        WHERE slug='timing-diagnosis'
        RETURNING id,active_version_id,control_revision`,
    )).rows[0]!;
    const skillId = String(initial.id);
    const versionId = String(initial.active_version_id);
    let revision = Number(initial.control_revision);
    const { projectId, taskId } = await seedTask("m5-u1-controls");
    const applyArgs = {
      version_id: versionId,
      local_goal: "verify fixed application survives archive",
      reason_codes: ["m5_u1_control_test"],
      role: "primary",
    };
    await appendTaskEvent(projectId, taskId, "event-m5-u1-apply", "tool_call", {
      tool_call_id: "call-m5-u1-apply",
      name: "learned_skill_apply",
      args: applyArgs,
    });
    const applicationResponse = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: {
          "idempotency-key": "m5-u1-application",
          "x-synthia-task-id": taskId,
        },
        body: {
          schema: "skill-application-create.v1",
          tool_call_id: "call-m5-u1-apply",
          turn_id: null,
          version_id: versionId,
          local_goal: applyArgs.local_goal,
          reason_codes: applyArgs.reason_codes,
        },
      },
    );
    expect(applicationResponse.status).toBe(201);
    const applicationId = String(data(applicationResponse.json).application_id);

    const search = async () => await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/learned-skills/search?q=Timing&limit=50`,
      {
        token: harness.ids.taskRuntimeToken,
        headers: { "x-synthia-task-id": taskId },
      },
    );
    expect((data((await search()).json).items as unknown[]).map((item) => row(item).skill_id)).toContain(skillId);

    const control = async (
      action: "pin" | "unpin" | "disable" | "enable" | "archive" | "restore",
      expectedRevision: number,
      reason: string,
      idempotencyKey: string,
      baseUrl = harness.baseUrl,
      extra: Record<string, unknown> = {},
    ) => await apiCall(baseUrl, `/api/v1/learned-skills/${skillId}/${action}`, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": idempotencyKey },
      body: { expected_control_revision: expectedRevision, reason, ...extra },
    });

    expect((await control("pin", revision, "strict dto", "m5-u1-extra", harness.baseUrl, { extra: true })).status)
      .toBe(400);
    expect((await control("pin", revision, "   ", "m5-u1-empty-reason")).status).toBe(400);
    expect((await apiCall(harness.baseUrl, `/api/v1/learned-skills/${skillId}/pin`, {
      method: "POST",
      token: harness.ids.humanToken,
      body: { expected_control_revision: revision, reason: "missing idempotency key" },
    })).status).toBe(400);

    const pinBodyReason = "lock automated mutation";
    const pinned = await control("pin", revision, pinBodyReason, "m5-u1-pin");
    expect(pinned.status).toBe(200);
    expect(data(pinned.json)).toMatchObject({ pinned: true, control_revision: revision + 1 });
    const pinReplay = await control("pin", revision, pinBodyReason, "m5-u1-pin");
    expect(pinReplay.status).toBe(200);
    expect(data(pinReplay.json)).toEqual(data(pinned.json));
    expect((await control("pin", revision, "same key different body", "m5-u1-pin")).status).toBe(409);
    expect(Number((await harness.client.query(
      `SELECT count(*)::int AS count FROM learned_skill_lifecycle_event
        WHERE skill_id=$1 AND event_type='human_pin' AND reason=$2`,
      [skillId, pinBodyReason],
    )).rows[0]!.count)).toBe(1);
    revision += 1;

    expect((await control("unpin", revision - 1, "stale CAS", "m5-u1-stale")).status).toBe(409);
    const concurrent = await Promise.all([
      control("unpin", revision, "concurrent unpin a", "m5-u1-unpin-a"),
      control("unpin", revision, "concurrent unpin b", "m5-u1-unpin-b"),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    revision += 1;
    expect((await harness.client.query(
      "SELECT pinned,control_revision FROM learned_skill WHERE id=$1",
      [skillId],
    )).rows[0]).toMatchObject({ pinned: false, control_revision: String(revision) });

    const archived = await control("archive", revision, "hide from ordinary agent search", "m5-u1-archive");
    expect(archived.status).toBe(200);
    expect(data(archived.json)).toMatchObject({ availability_state: "archived", control_revision: revision + 1 });
    revision += 1;
    expect((data((await search()).json).items as unknown[]).map((item) => row(item).skill_id)).not.toContain(skillId);

    const fixedView = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/learned-skills/${skillId}/versions/${versionId}`,
      {
        token: harness.ids.taskRuntimeToken,
        headers: { "x-synthia-task-id": taskId },
      },
    );
    expect(fixedView.status).toBe(200);
    const closeArgs = {
      application_id: applicationId,
      outcome_claim: "fixed application remains closable",
      human_corrections: 0,
      evidence_refs: [],
      tool_run_refs: [],
    };
    const closeEvent = await appendTaskEvent(projectId, taskId, "event-m5-u1-close", "tool_call", {
      tool_call_id: "call-m5-u1-close",
      name: "learned_skill_close",
      args: closeArgs,
    });
    const closed = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${projectId}/tasks/${taskId}/skill-applications/${applicationId}/close`,
      {
        method: "POST",
        token: harness.ids.taskRuntimeToken,
        headers: {
          "idempotency-key": "m5-u1-close",
          "x-synthia-task-id": taskId,
        },
        body: {
          schema: "skill-application-close.v1",
          end_event_sequence: closeEvent.sequence,
          outcome_claim: closeArgs.outcome_claim,
          human_corrections: closeArgs.human_corrections,
          evidence_refs: closeArgs.evidence_refs,
          tool_run_refs: closeArgs.tool_run_refs,
        },
      },
    );
    expect(closed.status).toBe(200);

    const restored = await control("restore", revision, "restore ordinary agent search", "m5-u1-restore");
    expect(restored.status).toBe(200);
    expect(data(restored.json)).toMatchObject({ availability_state: "available", control_revision: revision + 1 });
    revision += 1;
    expect((data((await search()).json).items as unknown[]).map((item) => row(item).skill_id)).toContain(skillId);

    rolloutOffServer = startSynthiaServer(harness.pool, { port: 0, features: { selfEvolution: false } });
    const offBase = `http://${rolloutOffServer.hostname}:${rolloutOffServer.port}`;
    for (const [action, key] of [
      ["pin", "m5-u1-off-pin"],
      ["unpin", "m5-u1-off-unpin"],
      ["archive", "m5-u1-off-archive"],
      ["restore", "m5-u1-off-restore"],
    ] as const) {
      expect((await control(action, revision, `rollout off ${action}`, key, offBase)).status).toBe(503);
    }
    const emergencyReason = "rollout-off emergency disable";
    const emergency = await control("disable", revision, emergencyReason, "m5-u1-off-disable", offBase);
    expect(emergency.status).toBe(200);
    expect(data(emergency.json)).toMatchObject({ enabled: false, control_revision: revision + 1 });
    const emergencyReplay = await control("disable", revision, emergencyReason, "m5-u1-off-disable", offBase);
    expect(emergencyReplay.status).toBe(200);
    expect(data(emergencyReplay.json)).toEqual(data(emergency.json));
    revision += 1;
    const lifecycleBeforeRepeat = Number((await harness.client.query(
      "SELECT count(*)::int AS count FROM learned_skill_lifecycle_event WHERE skill_id=$1",
      [skillId],
    )).rows[0]!.count);
    expect((await control("disable", revision, "new request repeat", "m5-u1-off-disable-repeat", offBase)).status)
      .toBe(503);
    expect((await harness.client.query(
      "SELECT enabled,control_revision FROM learned_skill WHERE id=$1",
      [skillId],
    )).rows[0]).toMatchObject({ enabled: false, control_revision: String(revision) });
    expect(Number((await harness.client.query(
      "SELECT count(*)::int AS count FROM learned_skill_lifecycle_event WHERE skill_id=$1",
      [skillId],
    )).rows[0]!.count)).toBe(lifecycleBeforeRepeat);
    rolloutOffServer.stop();
    rolloutOffServer = null;

    const reenabled = await control("enable", revision, "restore fixture after rollout-off test", "m5-u1-enable");
    expect(reenabled.status).toBe(200);
    revision += 1;
    expect(data(reenabled.json)).toMatchObject({ enabled: true, control_revision: revision });
    const lifecycle = await harness.client.query(
      `SELECT event_type,reason FROM learned_skill_lifecycle_event
        WHERE skill_id=$1 AND actor_type='human' ORDER BY created_at,id`,
      [skillId],
    );
    expect(lifecycle.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "human_pin", reason: pinBodyReason }),
      expect.objectContaining({ event_type: "human_unpin" }),
      expect.objectContaining({ event_type: "human_archive", reason: "hide from ordinary agent search" }),
      expect.objectContaining({ event_type: "human_restore", reason: "restore ordinary agent search" }),
      expect.objectContaining({ event_type: "human_disable", reason: emergencyReason }),
      expect.objectContaining({ event_type: "human_enable", reason: "restore fixture after rollout-off test" }),
    ]));
  });

  test("scheduler materialization and manual/scheduled claim lanes are disjoint and Core-qualified", async () => {
    await harness.client.query("BEGIN");
    try {
      await harness.client.query(
        `UPDATE evolution_eval_run eval
            SET completed_at=COALESCE(eval.completed_at,clock_timestamp())
           FROM curator_run run
          WHERE run.id=eval.curator_run_id AND run.state IN ('queued','running')`,
      );
      await harness.client.query(
        `UPDATE curator_run
            SET state='failed',error_code='test_cleanup',details_hash=$1,completed_at=now()
          WHERE state IN ('queued','running')`,
        [hash("scheduled-cleanup")],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
    await harness.client.query("DELETE FROM curator_application_reservation");
    await harness.client.query(
      `DELETE FROM curator_run run
        WHERE run.manual_key IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM evolution_eval_run eval WHERE eval.curator_run_id=run.id
          )`,
    );
    await harness.client.query(
      "UPDATE curator_run SET completed_at=now()-interval '8 days' WHERE state='completed'",
    );
    await harness.client.query(
      "UPDATE skill_application SET state='evaluated' WHERE state='pending_evaluation'",
    );
    const ensureScheduled = async (
      requestKey: string,
      token = schedulerToken,
      extra: Record<string, unknown> = {},
    ) => await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/ensure-scheduled",
      {
        method: "POST",
        token,
        body: { request_key: requestKey, ...extra },
      },
    );

    const oldClaim = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim",
      { method: "POST", token: curatorToken, body: { worker_id: "legacy", lease_seconds: 60 } },
    );
    expect(oldClaim.status).toBe(404);
    const scheduledBeforeEnsure = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-scheduled",
      { method: "POST", token: curatorToken, body: { worker_id: "scheduled-empty", lease_seconds: 60 } },
    );
    expect(data(scheduledBeforeEnsure.json).run).toBeNull();
    expect((await ensureScheduled("scope-denied", curatorToken)).status).toBe(403);
    expect((await ensureScheduled("shape-denied", schedulerToken, { eligible_at: new Date().toISOString() })).status).toBe(400);
    const noPending = await ensureScheduled("host-clock-skew-does-not-matter");
    expect(data(noPending.json)).toMatchObject({ state: "no_work", reason_code: "no_pending_applications" });

    const skill = (await harness.client.query(
      "UPDATE learned_skill SET availability_state='available' WHERE slug='timing-diagnosis' RETURNING id,active_version_id",
    )).rows[0]!;
    await seedPendingApplication("scheduled", String(skill.active_version_id));

    await harness.client.query(
      "UPDATE curator_run SET completed_at=now() WHERE id=(SELECT id FROM curator_run WHERE state='completed' ORDER BY completed_at DESC,id DESC LIMIT 1)",
    );
    const tooEarly = await ensureScheduled("host-thinks-due-but-core-does-not");
    expect(data(tooEarly.json)).toMatchObject({ state: "no_work", reason_code: "not_eligible" });
    await harness.client.query(
      "UPDATE curator_run SET completed_at=now()-interval '8 days' WHERE state='completed'",
    );
    const latestSuccess = await harness.client.query(
      "SELECT id,completed_at FROM curator_run WHERE state='completed' AND mode='run' ORDER BY completed_at DESC,id DESC LIMIT 1",
    );
    const ensured = await Promise.all(
      ["request-a", "request-b"].map((requestKey) => ensureScheduled(requestKey)),
    );
    expect(ensured.every((response) => response.status === 200)).toBe(true);
    const ensuredRows = ensured.map((response) => data(response.json));
    expect(ensuredRows.every((item) => item.state === "queued")).toBe(true);
    expect(new Set(ensuredRows.map((item) => item.curator_run_id)).size).toBe(1);
    expect(new Set(ensuredRows.map((item) => item.schedule_bucket))).toEqual(new Set([
      `scheduled:after:${String(latestSuccess.rows[0]!.id)}`,
    ]));
    expect(new Set(ensuredRows.map((item) => item.eligible_at))).toEqual(new Set([
      new Date(
        new Date(latestSuccess.rows[0]!.completed_at).getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    ]));
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM curator_run WHERE manual_key IS NULL",
    )).rows[0]!.count).toBe(1);

    const manualCreate = await apiCall(
      harness.baseUrl,
      "/api/v1/evolution/curator-runs",
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": "m4-manual-immediate" },
        body: { mode: "run", reason: "manual M4 lane test", manual_key: "m4-manual-immediate" },
      },
    );
    expect(manualCreate.status).toBe(201);
    const manualRunId = String(data(manualCreate.json).curator_run_id);
    expect((await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      { method: "POST", token: schedulerToken, body: { worker_id: "wrong-scope", lease_seconds: 60 } },
    )).status).toBe(403);
    const manualClaimResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      { method: "POST", token: curatorToken, body: { worker_id: "manual-worker", lease_seconds: 60 } },
    );
    const manualClaim = row(data(manualClaimResponse.json).run);
    expect(manualClaim.run_id).toBe(manualRunId);
    const scheduledClaimResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-scheduled",
      { method: "POST", token: curatorToken, body: { worker_id: "scheduled-worker", lease_seconds: 60 } },
    );
    const scheduledClaim = row(data(scheduledClaimResponse.json).run);
    expect(scheduledClaim.run_id).toBe(ensuredRows[0]!.curator_run_id);
    expect(scheduledClaim.run_id).not.toBe(manualClaim.run_id);

    for (const claim of [manualClaim, scheduledClaim]) {
      const failed = await apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${claim.run_id}/fail`,
        {
          method: "POST",
          token: curatorToken,
          body: {
            lease_token: claim.lease_token,
            error_code: "m4_lane_test_complete",
            retryable: false,
            details_hash: hash(`failed:${String(claim.run_id)}`),
          },
        },
      );
      expect(failed.status).toBe(200);
    }
    const backoffA = await ensureScheduled("retry-request-a");
    const backoffB = await ensureScheduled("retry-request-b");
    expect(data(backoffA.json)).toMatchObject({
      state: "no_work",
      curator_run_id: scheduledClaim.run_id,
      reason_code: "retry_backoff",
    });
    expect(data(backoffB.json)).toMatchObject({
      state: "no_work",
      curator_run_id: scheduledClaim.run_id,
      reason_code: "retry_backoff",
    });
    await harness.client.query(
      "UPDATE curator_run SET completed_at=now()-interval '2 hours' WHERE id=$1",
      [scheduledClaim.run_id],
    );
    const failedRetry = await ensureScheduled("retry-after-backoff");
    expect(data(failedRetry.json)).toMatchObject({
      state: "queued",
      curator_run_id: scheduledClaim.run_id,
      reason_code: "rematerialized_after_failure",
    });
    const reclaimedAfterFailure = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-scheduled",
      { method: "POST", token: curatorToken, body: { worker_id: "scheduled-retry", lease_seconds: 60 } },
    );
    const retriedClaim = row(data(reclaimedAfterFailure.json).run);
    expect(retriedClaim.run_id).toBe(scheduledClaim.run_id);
    expect(Number(retriedClaim.attempt)).toBe(Number(scheduledClaim.attempt) + 1);
    const retryFailed = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${retriedClaim.run_id}/fail`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: retriedClaim.lease_token,
          error_code: "m4_retry_fixture_cleanup",
          retryable: false,
          details_hash: hash("m4-retry-fixture-cleanup"),
        },
      },
    );
    expect(retryFailed.status).toBe(200);
    await harness.client.query(
      `UPDATE curator_run
          SET state='completed',terminal_request_hash=$2,terminal_result='{}'::jsonb,
              error_code=NULL,details_hash=NULL,completed_at=now()
        WHERE id=$1`,
      [retriedClaim.run_id, hash("m4-scheduled-completed")],
    );
    const completedAdvancesGeneration = await ensureScheduled("after-scheduled-success");
    expect(data(completedAdvancesGeneration.json)).toMatchObject({
      state: "no_work",
      reason_code: "not_eligible",
      schedule_bucket: `scheduled:after:${String(scheduledClaim.run_id)}`,
    });

    // A completed dry-run is intentionally not a seven-day reset fact.
    const canonicalBeforeDry = data(completedAdvancesGeneration.json);
    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,terminal_request_hash,terminal_result,
         created_by_type,created_by,completed_at)
       VALUES ('curator-m4-dry-fact','dry_run','dry_run_complete','manual:m4-dry-fact','m4-dry-fact',
               'dry fact',$1,'{}'::jsonb,'service',$2,now())`,
      [hash("m4-dry-terminal"), harness.ids.serviceUid],
    );
    const dryDoesNotReset = data((await ensureScheduled("after-dry-run")).json);
    expect(dryDoesNotReset).toMatchObject({
      schedule_bucket: canonicalBeforeDry.schedule_bucket,
      eligible_at: canonicalBeforeDry.eligible_at,
    });

    // A successful manual run is a Core reset fact. No Host timestamp is sent.
    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,terminal_request_hash,terminal_result,
         created_by_type,created_by,completed_at)
       VALUES ('curator-m4-manual-reset','run','completed','manual:m4-reset','m4-reset',
               'manual reset',$1,'{}'::jsonb,'service',$2,now())`,
      [hash("m4-manual-terminal"), harness.ids.serviceUid],
    );
    const manualReset = await ensureScheduled("after-manual-success");
    expect(data(manualReset.json)).toMatchObject({
      state: "no_work",
      reason_code: "not_eligible",
      schedule_bucket: "scheduled:after:curator-m4-manual-reset",
    });
    const stillEmpty = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-scheduled",
      { method: "POST", token: curatorToken, body: { worker_id: "scheduled-still-empty", lease_seconds: 60 } },
    );
    expect(data(stillEmpty.json).run).toBeNull();
  });

  test("failed scheduled runs requalify before reuse and request keys cannot bypass facts", async () => {
    await harness.client.query("BEGIN");
    try {
      await harness.client.query(
        `UPDATE evolution_eval_run eval
            SET completed_at=COALESCE(eval.completed_at,clock_timestamp())
           FROM curator_run run
          WHERE run.id=eval.curator_run_id AND run.state IN ('queued','running')`,
      );
      await harness.client.query(
        `UPDATE curator_run
            SET state='failed',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,
                error_code='m4_cleanup',details_hash=$1,completed_at=now()
          WHERE state IN ('queued','running')`,
        [hash("m4-failed-qualification-cleanup")],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
    await harness.client.query("DELETE FROM curator_application_reservation");
    await harness.client.query(
      `DELETE FROM curator_run run
        WHERE run.manual_key IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM evolution_eval_run eval WHERE eval.curator_run_id=run.id
          )`,
    );
    await harness.client.query("UPDATE curator_run SET completed_at=now()-interval '9 days' WHERE state='completed'");
    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,terminal_request_hash,terminal_result,
         created_by_type,created_by,completed_at)
       VALUES ('curator-m4-generation','run','completed','manual:m4-generation','m4-generation',
               'generation',$1,'{}'::jsonb,'service',$2,now()-interval '8 days')`,
      [hash("m4-generation"), harness.ids.serviceUid],
    );
    const skill = (await harness.client.query(
      "UPDATE learned_skill SET availability_state='available' WHERE slug='timing-diagnosis' RETURNING active_version_id",
    )).rows[0]!;
    await seedPendingApplication(
      "m4-failed-qualification",
      String(skill.active_version_id),
    );
    const ensure = async (requestKey: string, baseUrl = harness.baseUrl) => await apiCall(
      baseUrl,
      "/api/v1/internal/evolution/curator-runs/ensure-scheduled",
      { method: "POST", token: schedulerToken, body: { request_key: requestKey } },
    );
    const materialized = data((await ensure("materialize-failed-fixture")).json);
    const claimResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-scheduled",
      { method: "POST", token: curatorToken, body: { worker_id: "m4-failed-fixture", lease_seconds: 60 } },
    );
    const claim = row(data(claimResponse.json).run);
    expect(claim.run_id).toBe(materialized.curator_run_id);
    const failed = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.run_id}/fail`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: claim.lease_token,
          error_code: "m4_nonretryable",
          retryable: false,
          details_hash: hash("m4_nonretryable"),
        },
      },
    );
    expect(failed.status).toBe(200);
    const stateOfFailed = async () => (await harness.client.query(
      "SELECT state FROM curator_run WHERE id=$1",
      [claim.run_id],
    )).rows[0]!.state;

    expect(data((await ensure("different-key-cannot-bypass-backoff")).json))
      .toMatchObject({ state: "no_work", reason_code: "retry_backoff" });
    expect(await stateOfFailed()).toBe("failed");

    await harness.client.query("UPDATE evolution_settings SET learning_paused=true WHERE singleton_id='global'");
    expect(data((await ensure("paused-cannot-revive")).json))
      .toMatchObject({ state: "no_work", reason_code: "learning_paused" });
    expect(await stateOfFailed()).toBe("failed");
    await harness.client.query("UPDATE evolution_settings SET learning_paused=false WHERE singleton_id='global'");

    rolloutOffServer = startSynthiaServer(harness.pool, { port: 0, features: { selfEvolution: false } });
    const offBase = `http://${rolloutOffServer.hostname}:${rolloutOffServer.port}`;
    expect((await ensure("rollout-off-cannot-revive", offBase)).status).toBe(503);
    expect(await stateOfFailed()).toBe("failed");
    rolloutOffServer.stop();
    rolloutOffServer = null;

    await harness.client.query("UPDATE skill_application SET state='evaluated' WHERE state='pending_evaluation'");
    await harness.client.query(
      "UPDATE curator_run SET completed_at=now()-interval '2 hours' WHERE id=$1",
      [claim.run_id],
    );
    expect(data((await ensure("no-pending-cannot-revive")).json))
      .toMatchObject({ state: "no_work", reason_code: "no_pending_applications" });
    expect(await stateOfFailed()).toBe("failed");
    await seedPendingApplication("m4-failed-requalified", String(skill.active_version_id));

    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by)
       VALUES ('curator-m4-active-blocker','run','queued','manual:m4-active-blocker',
               'm4-active-blocker','active blocker','service',$1)`,
      [harness.ids.serviceUid],
    );
    expect(data((await ensure("active-run-cannot-revive")).json))
      .toMatchObject({ state: "no_work", reason_code: "active_run" });
    expect(await stateOfFailed()).toBe("failed");
    await harness.client.query(
      `UPDATE curator_run SET state='failed',error_code='cleanup',details_hash=$1,completed_at=now()
        WHERE id='curator-m4-active-blocker'`,
      [hash("m4-active-cleanup")],
    );

    await harness.client.query(
      `INSERT INTO curator_run
        (id,mode,state,schedule_bucket,manual_key,reason,terminal_request_hash,terminal_result,
         created_by_type,created_by,completed_at)
       VALUES ('curator-m4-new-success','run','completed','manual:m4-new-success','m4-new-success',
               'new success',$1,'{}'::jsonb,'service',$2,now())`,
      [hash("m4-new-success"), harness.ids.serviceUid],
    );
    expect(data((await ensure("new-success-invalidates-old-cycle")).json)).toMatchObject({
      state: "no_work",
      reason_code: "not_eligible",
      schedule_bucket: "scheduled:after:curator-m4-new-success",
    });
    expect(await stateOfFailed()).toBe("failed");
  });
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; Self-Evolution PostgreSQL API tests were not executed", () => {});
}
