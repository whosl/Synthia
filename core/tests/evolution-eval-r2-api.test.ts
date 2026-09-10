/**
 * Evolution-eval R2 route and PostgreSQL adversarial gate.
 *
 * This suite owns the M4-D submit/status/cancel/evidence and Curator terminal
 * contracts. Connector effects remain an M4-E concern: every HTTP route in
 * this file must only commit Core facts/intents and leave the Connector spy at
 * zero. Trusted Connector outcomes are introduced only through constrained
 * PostgreSQL fixtures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { ConnectorPort } from "../src/api/connector-port.ts";
import { startSynthiaServer } from "../src/api/server.ts";
import type { RuntimeClient } from "../src/api/task-proxy.ts";
import {
  canonicalEvolutionEvalSealedInputProjection,
  evolutionEvalCanonicalHash,
} from "../src/domain/evolution-eval.ts";
import { sha256Hex } from "../src/hashing.ts";
import type { EvolutionEvalConnectorPort } from "../src/services/evolution-eval-connector-port.ts";
import { CoreEvolutionEvalClient } from "../../runtime/evolution-eval-client.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  type ApiHarness,
} from "./support/api-harness.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const hash = (value: string | Uint8Array): string => sha256Hex(value);
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const responseData = (value: unknown): Record<string, unknown> => record(record(value).data);
const responseError = (value: unknown): Record<string, unknown> => record(record(value).error);

interface ClaimableFixture {
  readonly suffix: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly applicationId: string;
  readonly versionId: string;
  readonly sourcePath: string;
  readonly constraintPath?: string;
  readonly sourceCommit: string;
  readonly sourceContent: string;
}

interface ClaimedFixture extends ClaimableFixture {
  readonly leaseToken: string;
  readonly evidenceSnapshotHash: string;
  readonly evalInputRef: string;
  readonly inputManifestHash: string;
  readonly sourceManifestHash: string;
}

interface PreparedFixture {
  readonly evalJobId: string;
  readonly toolRunId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly workspaceManifestHash: string;
}

describe.skipIf(!DATABASE_URL)("Evolution-eval R2 API — real PostgreSQL", () => {
  let harness: ApiHarness;
  let testDatabaseUrl = "";
  let databaseName = "";
  let evaluatorToken = "";
  let curatorToken = "";
  let schedulerToken = "";
  let connectorCalls = 0;

  beforeAll(async () => {
    const base = new URL(DATABASE_URL);
    databaseName = `synthia_eval_r2_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: base.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await admin.query(`ALTER DATABASE ${databaseName} SET search_path TO public, pg_catalog`);
    await admin.end();
    base.pathname = `/${databaseName}`;
    testDatabaseUrl = base.toString();

    // Ephemeral-database-only clock seam. Schema functions and handler SQL use
    // the public function because this database explicitly orders public ahead
    // of pg_catalog. Tests advance time without mutating immutable deadlines.
    const bootstrap = new Client({ connectionString: testDatabaseUrl });
    await bootstrap.connect();
    await bootstrap.query(
      `CREATE TABLE synthia_test_clock (
         singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
         now_value timestamptz
       )`,
    );
    await bootstrap.query(
      "INSERT INTO synthia_test_clock(singleton,now_value) VALUES (true,NULL)",
    );
    await bootstrap.query(
      `CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz
       LANGUAGE sql VOLATILE AS $$
         SELECT COALESCE(
           (SELECT now_value FROM public.synthia_test_clock WHERE singleton=true),
           pg_catalog.clock_timestamp()
         )
       $$`,
    );
    await bootstrap.end();

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
    const connector: ConnectorPort = {
      connectorId: "evolution-eval-r2-spy",
      discover: async () => {
        connectorCalls += 1;
        return { capabilities: [], drift: false };
      },
      submitJob: async (params) => {
        connectorCalls += 1;
        return { jobId: params.jobId, state: "queued" };
      },
      queryStatus: async (_projectId, jobId) => {
        connectorCalls += 1;
        return { jobId, state: "submitted" };
      },
      fetchEvidence: async (_projectId, jobId) => {
        connectorCalls += 1;
        return { jobId, entries: [] };
      },
      fetchEvidenceContent: async (_projectId, _jobId, name) => {
        connectorCalls += 1;
        return {
          name,
          content: "",
          sha256: hash(""),
          truncated: false,
          mediaType: "text/plain",
        };
      },
    };
    harness = await setupApiHarness(testDatabaseUrl, {
      features: { selfEvolution: true, evolutionEvalExecution: true },
      runtimeClient,
      connector,
    });

    const identity = await harness.client.query(
      "SELECT id FROM user_account WHERE uid=$1",
      [harness.ids.serviceUid],
    );
    const userId = String(identity.rows[0]!.id);
    evaluatorToken = randomBytes(32).toString("hex");
    curatorToken = randomBytes(32).toString("hex");
    schedulerToken = randomBytes(32).toString("hex");
    await harness.client.query(
      `INSERT INTO auth_token(token_hash,user_id,scope) VALUES
       ($1,$4,ARRAY['core:evolution-eval']),
       ($2,$4,ARRAY['core:evolution-curator']),
       ($3,$4,ARRAY['core:evolution-scheduler'])`,
      [hash(evaluatorToken), hash(curatorToken), hash(schedulerToken), userId],
    );
  });

  beforeEach(async () => {
    connectorCalls = 0;
    await harness.client.query("UPDATE synthia_test_clock SET now_value=NULL WHERE singleton=true");
    await harness.client.query(
      `TRUNCATE project,curator_run,learned_skill,learning_episode,
                outbox_events,idempotency_records
       RESTART IDENTITY CASCADE`,
    );
    await harness.client.query(
      `UPDATE evolution_settings
          SET learning_paused=false,learned_skills_enabled=true
        WHERE singleton_id='global'`,
    );
  });

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
    if (databaseName) {
      const admin = new Client({ connectionString: DATABASE_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  });

  async function seedClaimable(
    label: string,
    options: {
      readonly scheduled?: boolean;
      readonly sourceXdcContent?: string;
    } = {},
  ): Promise<ClaimableFixture> {
    const suffix = `${label}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const projectId = `project_${suffix}`;
    const parentTaskId = `project_agent_${suffix}`;
    const taskId = `source_task_${suffix}`;
    const workspaceId = `source_workspace_${suffix}`;
    const resultId = `source_result_${suffix}`;
    const episodeId = `episode_${suffix}`;
    const originRunId = `curator_origin_${suffix}`;
    const runId = `curator_eval_${suffix}`;
    const skillId = `skill_${suffix}`;
    const versionId = `version_${suffix}`;
    const skillFileId = `skill_file_${suffix}`;
    const applicationId = `application_${suffix}`;
    const applicationSkillId = `application_skill_${suffix}`;
    const eventId = `event_${suffix}`;
    const sourceFileId = `source_file_${suffix}`;
    const constraintFileId = `constraint_file_${suffix}`;
    const sourcePath = "rtl/top.sv";
    const sourceContent = "module top; endmodule\n";
    const constraintPath = options.sourceXdcContent === undefined
      ? undefined
      : "constraints/top.xdc";
    const sourceCommit = "a".repeat(40);
    const skillContent = "# Timing recovery\n\nUse typed Vivado operations only.\n";
    const eventPayload = {
      tool_call_id: `tool_call_${suffix}`,
      name: "learned_skill_apply",
      args: {
        version_id: versionId,
        local_goal: "synthesize the sealed FPGA snapshot",
        reason_codes: ["matching-failure"],
        role: "primary",
      },
    };

    await harness.client.query("BEGIN");
    try {
      await harness.client.query("SET CONSTRAINTS ALL DEFERRED");
      await harness.client.query(
        `INSERT INTO project
          (id,name,scope,project_type,process_version_id,process_profile_id,
           process_profile_version,process_profile_name,target_part,toolchain_profile_ref,status)
         VALUES ($1,$2,'','free',NULL,NULL,NULL,NULL,'xc7a35tcpg236-1',$3,'active')`,
        [projectId, `Eval ${suffix}`, hash(`toolchain:${suffix}`)],
      );
      await harness.client.query(
        `INSERT INTO role_assignment(id,project_id,actor_type,actor_id,role,permissions)
         VALUES ($1,$2,'service',$3,'evolution-evaluator','{}'::jsonb)`,
        [`role_${suffix}`, projectId, harness.ids.serviceUid],
      );
      await harness.client.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,reason,terminal_request_hash,
           terminal_result,created_by_type,created_by,completed_at)
         VALUES ($1,$2,$3,$1,$1,'version provenance',$4,$5::jsonb,
                 'service',$6,now())`,
        [
          originRunId,
          options.scheduled === true ? "dry_run" : "run",
          options.scheduled === true ? "dry_run_complete" : "completed",
          hash(`origin:${suffix}`),
          JSON.stringify({ schema: "curator-result.v1", run_id: originRunId }),
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,eligible_at,reason,created_by_type,created_by)
         VALUES ($1,'run','queued',$2,$3::text,
                 CASE WHEN $3::text IS NULL THEN now() ELSE NULL END,
                 'R2 route test','service',$4)`,
        [
          runId,
          options.scheduled === true ? "scheduled:initial" : runId,
          options.scheduled === true ? null : runId,
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO learned_skill
          (id,slug,name,summary,applicability_summary,created_by_type,created_by)
         VALUES ($1,$2,'Timing recovery','Recover synthesis failures','FPGA synthesis',
                 'service',$3)`,
        [skillId, `skill-${suffix.replaceAll("_", "-")}`, harness.ids.serviceUid],
      );
      await harness.client.query(
        `INSERT INTO learned_skill_version
          (id,skill_id,version_no,parent_version_id,description,applicability,
           outcome_contract,content_manifest_hash,scanner_version,scan_decision,
           scan_findings,curator_run_id,created_by_type,created_by)
         VALUES ($1,$2,1,NULL,'Typed synthesis recovery','{}'::jsonb,'{}'::jsonb,
                 $3,'test-scanner-v1','pass','[]'::jsonb,$4,'service',$5)`,
        [versionId, skillId, hash(`skill-manifest:${skillContent}`), originRunId, harness.ids.serviceUid],
      );
      await harness.client.query(
        `INSERT INTO learned_skill_version_status(version_id,quality_state)
         VALUES ($1,'active_unproven')`,
        [versionId],
      );
      await harness.client.query(
        `INSERT INTO learned_skill_file
          (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,'SKILL.md','skill_md',NULL,$3,$4,'text/markdown',$5)`,
        [skillFileId, versionId, hash(skillContent), Buffer.byteLength(skillContent), skillContent],
      );
      await harness.client.query(
        "UPDATE learned_skill SET active_version_id=$2 WHERE id=$1",
        [skillId, versionId],
      );
      await harness.client.query(
        `INSERT INTO agent_task
          (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
           process_instance_id,runtime_agent_id,runtime_actor_id,objective,
           authorization_scope,status,input_hash,adoption_state,created_by_type,created_by)
         VALUES ($1,$2,'free','main','project',NULL,NULL,NULL,$1,$3,
                 'project agent','{}'::jsonb,'running',$4,'not_applicable','service',$3)`,
        [parentTaskId, projectId, harness.ids.serviceUid, hash(`parent-input:${suffix}`)],
      );
      await harness.client.query(
        `INSERT INTO agent_task
          (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
           process_instance_id,runtime_agent_id,runtime_actor_id,objective,
           authorization_scope,status,input_hash,output_hash,adoption_state,
           created_by_type,created_by,finished_at)
         VALUES ($1,$2,'free','side','side',$3,$4,NULL,$1,$5,
                 'fix synthesis','{}'::jsonb,'succeeded',$6,$7,'available',
                 'service',$5,now())`,
        [
          taskId,
          projectId,
          parentTaskId,
          workspaceId,
          harness.ids.serviceUid,
          hash(`task-input:${suffix}`),
          hash(`task-output:${suffix}`),
        ],
      );
      await harness.client.query(
        `INSERT INTO task_workspace
          (id,task_id,project_id,state,storage_key,base_commit,base_manifest_hash,
           head_commit,sealed_at)
         VALUES ($1,$2,$3,'sealed',$4,$5,$6,$7,now())`,
        [
          workspaceId,
          taskId,
          projectId,
          `eval-${suffix}`,
          "b".repeat(40),
          hash(`base-manifest:${suffix}`),
          sourceCommit,
        ],
      );
      await harness.client.query(
        `INSERT INTO task_conversation_event
          (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id)
         VALUES ($1,$2,$3,1,'tool_call',$4::jsonb,$5,'service',$6)`,
        [
          eventId,
          projectId,
          taskId,
          JSON.stringify(eventPayload),
          hash(JSON.stringify(eventPayload)),
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO task_workspace_file
          (id,task_id,project_id,workspace_id,path,artifact_type,change_kind,
           base_content_hash,content_hash,content_text,size_bytes,workspace_commit,version)
         VALUES ($1,$2,$3,$4,$5,'hdl','added',NULL,$6,$7,$8,$9,1)`,
        [
          sourceFileId,
          taskId,
          projectId,
          workspaceId,
          sourcePath,
          hash(sourceContent),
          sourceContent,
          Buffer.byteLength(sourceContent),
          sourceCommit,
        ],
      );
      if (constraintPath !== undefined && options.sourceXdcContent !== undefined) {
        await harness.client.query(
          `INSERT INTO task_workspace_file
            (id,task_id,project_id,workspace_id,path,artifact_type,change_kind,
             base_content_hash,content_hash,content_text,size_bytes,workspace_commit,version)
           VALUES ($1,$2,$3,$4,$5,'xdc','added',NULL,$6,$7,$8,$9,1)`,
          [
            constraintFileId,
            taskId,
            projectId,
            workspaceId,
            constraintPath,
            hash(options.sourceXdcContent),
            options.sourceXdcContent,
            Buffer.byteLength(options.sourceXdcContent),
            sourceCommit,
          ],
        );
      }
      await harness.client.query(
        `INSERT INTO task_result
          (id,project_id,task_id,workspace_id,base_commit,result_commit,summary,
           tests,manifest,output_hash,created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'sealed source','[]'::jsonb,$7::jsonb,$8,
                 'service',$9)`,
        [
          resultId,
          projectId,
          taskId,
          workspaceId,
          "b".repeat(40),
          sourceCommit,
          JSON.stringify({
            files: [
              { path: sourcePath, sha256: hash(sourceContent) },
              ...(constraintPath === undefined || options.sourceXdcContent === undefined
                ? []
                : [{ path: constraintPath, sha256: hash(options.sourceXdcContent) }]),
            ],
          }),
          hash(`result:${suffix}`),
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO learning_episode
          (id,project_id,task_id,observation_key,episode_key,end_event_sequence,
           content_hash,outcome_claim,evidence_refs,created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,1,$6,'synthesis fixed','[]'::jsonb,'service',$7)`,
        [
          episodeId,
          projectId,
          taskId,
          `observation:${suffix}`,
          `episode:${suffix}`,
          hash(`episode:${suffix}`),
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO skill_application
          (id,project_id,task_id,observation_key,episode_id,local_goal,state,
           primary_tool_call_id,start_event_sequence,end_event_sequence,outcome_claim,
           human_corrections,evidence_refs,tool_run_refs,closed_at,created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,'synthesize the sealed FPGA snapshot','pending_evaluation',
                 $6,1,1,'synthesis fixed',0,'[]'::jsonb,'[]'::jsonb,now(),'service',$7)`,
        [
          applicationId,
          projectId,
          taskId,
          `observation:${suffix}`,
          episodeId,
          `tool_call_${suffix}`,
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO skill_application_skill
          (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
         VALUES ($1,$2,$3,$4,'primary',$5,'["matching-failure"]'::jsonb)`,
        [applicationSkillId, applicationId, skillId, versionId, `tool_call_${suffix}`],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }

    return {
      suffix,
      projectId,
      taskId,
      runId,
      applicationId,
      versionId,
      sourcePath,
      constraintPath,
      sourceCommit,
      sourceContent,
    };
  }

  async function claimFixture(
    fixture: ClaimableFixture,
    lane: "manual" | "scheduled" = "manual",
  ): Promise<ClaimedFixture> {
    const response = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/claim-${lane}`,
      {
        method: "POST",
        token: curatorToken,
        body: { worker_id: `worker-${fixture.suffix}`, lease_seconds: 900 },
      },
    );
    expect(response.status).toBe(200);
    const run = record(responseData(response.json).run);
    expect(run.run_id).toBe(fixture.runId);
    const bundle = (run.applications as unknown[])
      .map(record)
      .find((candidate) => record(candidate.application).application_id === fixture.applicationId);
    expect(bundle).toBeDefined();
    const evalInput = record(bundle!.eval_input);
    return {
      ...fixture,
      leaseToken: String(run.lease_token),
      evidenceSnapshotHash: String(bundle!.evidence_snapshot_hash),
      evalInputRef: String(evalInput.eval_input_ref),
      inputManifestHash: String(evalInput.input_manifest_hash),
      sourceManifestHash: String(evalInput.source_manifest_hash),
    };
  }

  function prepareBody(claim: ClaimedFixture): Record<string, unknown> {
    return {
      schema: "evolution-eval-prepare.v1",
      curator_lease_token: claim.leaseToken,
      application_id: claim.applicationId,
      evidence_snapshot_hash: claim.evidenceSnapshotHash,
      version_id: claim.versionId,
      eval_input_ref: claim.evalInputRef,
      input_manifest_hash: claim.inputManifestHash,
      operation: "synthesize",
      parameters: {
        operation: "synthesize",
        source_paths: [claim.sourcePath],
        top: "top",
        part: "xc7a35tcpg236-1",
      },
      timeout_ms: 60_000,
    };
  }

  async function prepare(claim: ClaimedFixture, key: string): Promise<PreparedFixture> {
    const response = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": key },
        body: prepareBody(claim),
      },
    );
    expect(response.status).toBe(201);
    const data = responseData(response.json);
    return {
      evalJobId: String(data.eval_job_id),
      toolRunId: String(data.tool_run_id),
      workspaceId: String(data.workspace_id),
      workspaceRevision: Number(data.workspace_revision),
      workspaceManifestHash: String(data.workspace_manifest_hash),
    };
  }

  function jobPath(claim: ClaimedFixture, job: PreparedFixture): string {
    return `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/${job.evalJobId}`;
  }

  function submitBody(
    claim: ClaimedFixture,
    job: PreparedFixture,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schema: "evolution-eval-submit.v1",
      curator_lease_token: claim.leaseToken,
      workspace_id: job.workspaceId,
      expected_workspace_revision: job.workspaceRevision,
      expected_workspace_manifest_hash: job.workspaceManifestHash,
      ...overrides,
    };
  }

  async function submit(
    claim: ClaimedFixture,
    job: PreparedFixture,
    key: string,
    body: Record<string, unknown> = submitBody(claim, job),
  ) {
    return await apiCall(harness.baseUrl, `${jobPath(claim, job)}/submit`, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": key },
      body,
    });
  }

  async function cancel(
    claim: ClaimedFixture,
    job: PreparedFixture,
    key: string,
    reasonCode = "OPERATOR_REQUEST",
  ) {
    return await apiCall(harness.baseUrl, `${jobPath(claim, job)}/cancel`, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": key },
      body: {
        schema: "evolution-eval-cancel.v1",
        curator_lease_token: claim.leaseToken,
        reason_code: reasonCode,
      },
    });
  }

  async function terminalizeSubmitted(evalJobId: string): Promise<void> {
    const jobResult = await harness.client.query(
      `SELECT j.curator_run_id,j.project_id,j.tool_run_id,j.operation,t.correlation_id
         FROM evolution_eval_job j
         JOIN tool_run t ON t.id=j.tool_run_id
        WHERE j.id=$1`,
      [evalJobId],
    );
    const job = jobResult.rows[0]!;
    const transitionAuditId = `audit_transition_${randomUUID()}`;
    const transitionOutboxId = randomUUID();
    const transitionFactId = `transition_${randomUUID()}`;
    const tombstoneAuditId = `audit_tombstone_${randomUUID()}`;
    const tombstoneOutboxId = randomUUID();
    const errorHash = hash(`fixture-tombstone:${evalJobId}`);

    await harness.client.query("BEGIN");
    try {
      const sequenceResult = await harness.client.query(
        `SELECT COALESCE(max(sequence),0)::int AS sequence
           FROM outbox_events
          WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
        [evalJobId],
      );
      const nextSequence = Number(sequenceResult.rows[0]!.sequence) + 1;
      await harness.client.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,from_state,to_state,operation)
         VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,
                 'submitted','rejected',$7)`,
        [
          transitionAuditId,
          job.curator_run_id,
          evalJobId,
          job.project_id,
          harness.ids.serviceUid,
          job.correlation_id,
          job.operation,
        ],
      );
      await harness.client.query(
        `INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
           correlation_id,classification)
         VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.tool_run_transition',$4,
                 $5::jsonb,$6,'D1')`,
        [
          transitionOutboxId,
          evalJobId,
          nextSequence,
          job.project_id,
          JSON.stringify({ from_state: "submitted", to_state: "rejected" }),
          job.correlation_id,
        ],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_transition_fact
          (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
         VALUES ($1,$2,1,'submitted','rejected',$3,$4)`,
        [transitionFactId, evalJobId, transitionAuditId, transitionOutboxId],
      );
      await harness.client.query(
        `UPDATE tool_run
            SET state='rejected',error_code='EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH',end_time=now()
          WHERE id=$1`,
        [job.tool_run_id],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,request_hash,operation,error_code)
         VALUES ($1,$2,$3,$4,'dispatch_tombstone','service',$5,$6,$7,$8,
                 'EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH')`,
        [
          tombstoneAuditId,
          job.curator_run_id,
          evalJobId,
          job.project_id,
          harness.ids.serviceUid,
          job.correlation_id,
          errorHash,
          job.operation,
        ],
      );
      await harness.client.query(
        `INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
           correlation_id,classification)
         VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.dispatch_tombstoned',$4,
                 $5::jsonb,$6,'D1')`,
        [
          tombstoneOutboxId,
          evalJobId,
          nextSequence + 1,
          job.project_id,
          JSON.stringify({ error_hash: errorHash }),
          job.correlation_id,
        ],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_dispatch_tombstone
          (eval_job_id,reason_code,error_hash,audit_event_id,outbox_event_id)
         VALUES ($1,'EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH',$2,$3,$4)`,
        [evalJobId, errorHash, tombstoneAuditId, tombstoneOutboxId],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
  }

  async function advanceAcceptedTerminal(
    jobFixture: PreparedFixture,
    terminalState: "running" | "succeeded" | "failed" | "cancelled" | "timeout" = "succeeded",
  ): Promise<void> {
    const jobResult = await harness.client.query(
      `SELECT j.curator_run_id,j.project_id,j.tool_run_id,j.operation,t.correlation_id,t.state::text
         FROM evolution_eval_job j
         JOIN tool_run t ON t.id=j.tool_run_id
        WHERE j.id=$1`,
      [jobFixture.evalJobId],
    );
    const job = jobResult.rows[0]!;
    expect(job.state).toBe("submitted");
    const dispatch = await harness.client.query(
      "SELECT 1 FROM evolution_eval_dispatch WHERE eval_job_id=$1",
      [jobFixture.evalJobId],
    );
    expect(dispatch.rows).toHaveLength(1);
    const transitions: [string, string][] = [
      ["submitted", "queued"],
      ["queued", "preparing"],
      ["preparing", "running"],
    ];
    if (terminalState !== "running") transitions.push(["running", terminalState]);

    await harness.client.query("BEGIN");
    try {
      const sequenceResult = await harness.client.query(
        `SELECT COALESCE(max(sequence),0)::int AS sequence
           FROM outbox_events
          WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
        [jobFixture.evalJobId],
      );
      let outboxSequence = Number(sequenceResult.rows[0]!.sequence);
      for (const [index, [fromState, toState]] of transitions.entries()) {
        const auditId = `audit_transition_${randomUUID()}`;
        const outboxId = randomUUID();
        const factId = `transition_${randomUUID()}`;
        await harness.client.query(
          `INSERT INTO evolution_eval_audit_event
            (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
             correlation_id,from_state,to_state,operation)
           VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,$7,$8,$9)`,
          [
            auditId,
            job.curator_run_id,
            jobFixture.evalJobId,
            job.project_id,
            harness.ids.serviceUid,
            job.correlation_id,
            fromState,
            toState,
            job.operation,
          ],
        );
        await harness.client.query(
          `INSERT INTO outbox_events
            (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
             correlation_id,classification)
           VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.tool_run_transition',$4,
                   $5::jsonb,$6,'D1')`,
          [
            outboxId,
            jobFixture.evalJobId,
            ++outboxSequence,
            job.project_id,
            JSON.stringify({ from_state: fromState, to_state: toState }),
            job.correlation_id,
          ],
        );
        await harness.client.query(
          `INSERT INTO evolution_eval_transition_fact
            (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [factId, jobFixture.evalJobId, index + 1, fromState, toState, auditId, outboxId],
        );
        await harness.client.query(
          `UPDATE tool_run
              SET state=$2::tool_run_state,
                  start_time=CASE WHEN $2::text='running' THEN now() ELSE start_time END,
                  end_time=CASE WHEN $2::text IN ('succeeded','failed','cancelled','timeout')
                                THEN now() ELSE end_time END
            WHERE id=$1`,
          [jobFixture.toolRunId, toState],
        );
      }
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
  }

  async function appendUnknownEffect(jobFixture: PreparedFixture): Promise<void> {
    const result = await harness.client.query(
      `SELECT j.curator_run_id,j.project_id,j.operation,t.correlation_id,t.state::text
         FROM evolution_eval_job j JOIN tool_run t ON t.id=j.tool_run_id
        WHERE j.id=$1`,
      [jobFixture.evalJobId],
    );
    const job = result.rows[0]!;
    expect(job.state).toBe("running");
    const factHash = hash(`unknown:${jobFixture.evalJobId}`);
    const auditId = `audit_unknown_${randomUUID()}`;
    const outboxId = randomUUID();
    const transitionId = `transition_unknown_${randomUUID()}`;
    const latchedAt = new Date();
    await harness.client.query("BEGIN");
    try {
      const sequenceResult = await harness.client.query(
        `SELECT COALESCE(max(sequence),0)::int AS sequence
           FROM outbox_events
          WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
        [jobFixture.evalJobId],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,from_state,to_state,operation)
         VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,
                 'running','unknown_effect',$7)`,
        [
          auditId,
          job.curator_run_id,
          jobFixture.evalJobId,
          job.project_id,
          harness.ids.serviceUid,
          job.correlation_id,
          job.operation,
        ],
      );
      await harness.client.query(
        `INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
           correlation_id,classification)
         VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.unknown_effect',$4,
                 $5::jsonb,$6,'D1')`,
        [
          outboxId,
          jobFixture.evalJobId,
          Number(sequenceResult.rows[0]!.sequence) + 1,
          job.project_id,
          JSON.stringify({
            from_state: "running",
            to_state: "unknown_effect",
            fact_hash: factHash,
          }),
          job.correlation_id,
        ],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_transition_fact
          (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
         VALUES ($1,$2,4,'running','unknown_effect',$3,$4)`,
        [transitionId, jobFixture.evalJobId, auditId, outboxId],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_unknown_fact
          (eval_job_id,transition_fact_id,audit_event_id,outbox_event_id,fact_hash,latched_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [jobFixture.evalJobId, transitionId, auditId, outboxId, factHash, latchedAt],
      );
      await harness.client.query(
        `UPDATE evolution_eval_run SET unknown_effect_latched_at=$2
          WHERE curator_run_id=$1`,
        [job.curator_run_id, latchedAt],
      );
      await harness.client.query(
        `UPDATE tool_run SET state='unknown_effect',end_time=now() WHERE id=$1`,
        [jobFixture.toolRunId],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
  }

  type EvidenceFactType =
    | "freeze_pending"
    | "frozen"
    | "corrupt"
    | "unavailable_at_deadline"
    | "ack_pending"
    | "acknowledged"
    | "quarantine_pending"
    | "expired"
    | "cleanup_pending"
    | "cleaned";

  interface EvidenceEntryFixture {
    readonly name: string;
    readonly mediaType: "application/json" | "text/plain" | "application/octet-stream";
    readonly artifactClassification: "experimental/evolution_eval" | "evolution_eval_evidence";
    readonly content: Buffer;
  }

  interface EvidenceFactFixture {
    readonly type: EvidenceFactType;
    readonly manifestHash?: string;
    readonly manifest?: Record<string, unknown>;
    readonly errorCode?: string;
    readonly entries?: readonly EvidenceEntryFixture[];
  }

  async function appendEvidenceFacts(
    jobFixture: PreparedFixture,
    fixtures: readonly EvidenceFactFixture[],
  ): Promise<Map<EvidenceFactType, { id: string; factHash: string; manifestHash: string | null }>> {
    const result = await harness.client.query(
      `SELECT j.curator_run_id,j.project_id,j.operation,t.correlation_id
         FROM evolution_eval_job j JOIN tool_run t ON t.id=j.tool_run_id
        WHERE j.id=$1`,
      [jobFixture.evalJobId],
    );
    const job = result.rows[0]!;
    const inserted = new Map<EvidenceFactType, { id: string; factHash: string; manifestHash: string | null }>();
    await harness.client.query("BEGIN");
    try {
      const sequenceResult = await harness.client.query(
        `SELECT COALESCE(max(sequence),0)::int AS sequence
           FROM outbox_events
          WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
        [jobFixture.evalJobId],
      );
      let sequence = Number(sequenceResult.rows[0]!.sequence);
      for (const fixture of fixtures) {
        const factId = `evidence_${fixture.type}_${randomUUID()}`;
        const factHash = hash(`${fixture.type}:${jobFixture.evalJobId}:${randomUUID()}`);
        const auditId = `audit_evidence_${randomUUID()}`;
        const outboxId = randomUUID();
        const manifestHash = fixture.manifestHash ?? null;
        const connectorManifestHash = fixture.type === "frozen"
          ? hash(`connector-manifest:${manifestHash ?? factHash}`)
          : null;
        const entries = fixture.entries ?? [];
        const totalBytes = entries.reduce((total, entry) => total + entry.content.byteLength, 0);
        const outboxEventType = fixture.type === "freeze_pending"
          ? "evolution_eval.evidence.freeze_requested"
          : fixture.type === "ack_pending"
          ? "evolution_eval.evidence.ack_requested"
          : fixture.type === "quarantine_pending"
          ? "evolution_eval.evidence.quarantine_requested"
          : fixture.type === "cleanup_pending"
          ? "evolution_eval.evidence.cleanup_requested"
          : `evolution_eval.evidence.${fixture.type}`;
        const payload: Record<string, unknown> = {
          fact_id: factId,
          fact_type: fixture.type,
          fact_hash: factHash,
        };
        if (manifestHash !== null) payload.manifest_hash = manifestHash;
        if (fixture.errorCode !== undefined) payload.error_code = fixture.errorCode;
        await harness.client.query(
          `INSERT INTO evolution_eval_audit_event
            (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
             correlation_id,request_hash,operation,evidence_manifest_hash,file_count,
             byte_count,error_code)
           VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            auditId,
            job.curator_run_id,
            jobFixture.evalJobId,
            job.project_id,
            `evidence.${fixture.type}`,
            harness.ids.serviceUid,
            job.correlation_id,
            factHash,
            job.operation,
            manifestHash,
            fixture.type === "frozen" ? entries.length : null,
            fixture.type === "frozen" ? totalBytes : null,
            fixture.errorCode ?? null,
          ],
        );
        await harness.client.query(
          `INSERT INTO outbox_events
            (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
             correlation_id,classification)
           VALUES ($1,'evolution_eval_job',$2,$3,$4,$5,$6::jsonb,$7,'D1')`,
          [
            outboxId,
            jobFixture.evalJobId,
            ++sequence,
            outboxEventType,
            job.project_id,
            JSON.stringify(payload),
            job.correlation_id,
          ],
        );
        await harness.client.query(
          `INSERT INTO evolution_eval_evidence_fact
            (id,eval_job_id,fact_type,manifest_hash,connector_manifest_hash,
             error_code,fact_hash,manifest,entry_count,total_bytes,audit_event_id,
             outbox_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
          [
            factId,
            jobFixture.evalJobId,
            fixture.type,
            manifestHash,
            connectorManifestHash,
            fixture.errorCode ?? null,
            factHash,
            fixture.manifest === undefined ? null : JSON.stringify(fixture.manifest),
            entries.length,
            totalBytes,
            auditId,
            outboxId,
          ],
        );
        for (const entry of entries) {
          await harness.client.query(
            `INSERT INTO evolution_eval_evidence_entry
              (id,evidence_fact_id,eval_job_id,name,sha256,size_bytes,media_type,
               artifact_classification,usage_classification,managed_content)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'evolution_eval_only',$9)`,
            [
              `entry_${randomUUID()}`,
              factId,
              jobFixture.evalJobId,
              entry.name,
              hash(entry.content),
              entry.content.byteLength,
              entry.mediaType,
              entry.artifactClassification,
              entry.content,
            ],
          );
        }
        if (fixture.type === "acknowledged") {
          const pending = await harness.client.query<{
            fact_hash: string;
            outbox_event_id: string;
          }>(
            `SELECT fact_hash,outbox_event_id
               FROM evolution_eval_evidence_fact
              WHERE eval_job_id=$1 AND fact_type='ack_pending'`,
            [jobFixture.evalJobId],
          );
          if (pending.rows.length !== 1) {
            throw new Error("expected one ack_pending fact");
          }
          const authorization = pending.rows[0]!;
          const holderId = `r2-retention-fixture-${randomUUID()}`;
          const leaseNonceHash = hash(`r2-retention-lease:${randomUUID()}`);
          await harness.client.query(
            `INSERT INTO evolution_eval_dispatcher_lease
              (event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
               lease_expires_at,attempt_count)
             VALUES ($1,'evolution_eval.evidence.ack_requested',$2,$3,$4,
                     clock_timestamp()+interval '1 minute',1)`,
            [
              authorization.outbox_event_id,
              jobFixture.evalJobId,
              holderId,
              leaseNonceHash,
            ],
          );
          await harness.client.query(
            `INSERT INTO evolution_eval_retention_receipt
              (id,eval_job_id,receipt_type,connector_state,authorization_hash,
               connector_fact_hash,outbox_event_id,holder_id,lease_nonce_hash,
               lease_attempt_count)
             VALUES ($1,$2,'acknowledgement','acknowledged',$3,$4,$5,$6,$7,1)`,
            [
              randomUUID(),
              jobFixture.evalJobId,
              authorization.fact_hash,
              hash(`r2-connector-ack:${randomUUID()}`),
              authorization.outbox_event_id,
              holderId,
              leaseNonceHash,
            ],
          );
        }
        inserted.set(fixture.type, { id: factId, factHash, manifestHash });
      }
      await harness.client.query("COMMIT");
      return inserted;
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
  }

  async function primarySkill(claim: ClaimedFixture): Promise<{
    readonly skillId: string;
    readonly activeVersionId: string;
    readonly controlRevision: number;
  }> {
    const result = await harness.client.query(
      `SELECT skill.id AS skill_id,skill.active_version_id,skill.control_revision
         FROM skill_application_skill applied
         JOIN learned_skill skill ON skill.id=applied.skill_id
        WHERE applied.application_id=$1 AND applied.role='primary'`,
      [claim.applicationId],
    );
    const row = result.rows[0]!;
    return {
      skillId: String(row.skill_id),
      activeVersionId: String(row.active_version_id),
      controlRevision: Number(row.control_revision),
    };
  }

  async function completeCurator(
    claim: ClaimedFixture,
    job: PreparedFixture,
    options: {
      readonly outcome?: "success" | "applicability_failure" | "execution_failure" | "inconclusive";
      readonly evidenceManifestHash?: string | null;
      readonly evalJobRefs?: unknown[];
      readonly remediationAction?: "no_op" | "patch" | "scope_change" | "state_action";
    } = {},
  ) {
    const skill = await primarySkill(claim);
    const action = options.remediationAction ?? "no_op";
    const remediation: Record<string, unknown> = {
      skill_id: skill.skillId,
      expected_active_version_id: skill.activeVersionId,
      expected_control_revision: skill.controlRevision,
      action,
    };
    if (action === "patch" || action === "scope_change") {
      remediation.patch = { summary: "untrusted automatic patch" };
    } else if (action === "state_action") {
      remediation.state_action = { action: "disable" };
    }
    return await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/complete`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: claim.leaseToken,
          evaluator_version: "r2-adversarial-v1",
          evaluations: [{
            application_id: claim.applicationId,
            evidence_snapshot_hash: claim.evidenceSnapshotHash,
            outcome: options.outcome ?? "inconclusive",
            confidence: 0.95,
            reason: "Evidence is constrained by the authoritative evolution-eval facts.",
            evidence_refs: [],
            eval_job_refs: options.evalJobRefs ?? [{
              eval_job_id: job.evalJobId,
              tool_run_id: job.toolRunId,
              evidence_manifest_hash: options.evidenceManifestHash ?? null,
            }],
            supersedes_id: null,
          }],
          remediations: [remediation],
        },
      },
    );
  }

  async function failCurator(claim: ClaimedFixture, retryable = false) {
    return await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/fail`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: claim.leaseToken,
          error_code: "CURATOR_EVALUATION_FAILED",
          retryable,
          details_hash: hash(`failure:${claim.runId}:${retryable}`),
        },
      },
    );
  }

  test("R2-01 strict DTOs and action-scoped idempotency validate lease before replay", async () => {
    const claim = await claimFixture(await seedClaimable("strict-idempotency"));
    const job = await prepare(claim, "r2-strict-prepare");
    const path = jobPath(claim, job);
    const before = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact WHERE eval_job_id=$1) AS evidence,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE curator_run_id=$2 AND eval_job_id=$1) AS idempotency`,
      [job.evalJobId, claim.runId],
    );

    const invalid = await Promise.all([
      apiCall(harness.baseUrl, `${path}/submit`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-invalid-submit" },
        body: { ...submitBody(claim, job), unexpected: true },
      }),
      apiCall(harness.baseUrl, `${path}/status`, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: claim.leaseToken,
          eval_job_id: job.evalJobId,
        },
      }),
      apiCall(harness.baseUrl, `${path}/cancel`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-invalid-cancel" },
        body: {
          schema: "evolution-eval-cancel.v1",
          curator_lease_token: claim.leaseToken,
          reason_code: "operator_request",
        },
      }),
      apiCall(harness.baseUrl, `${path}/evidence`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-invalid-evidence" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "freeze",
          expected_manifest_hash: hash("not-valid-for-freeze"),
        },
      }),
    ]);
    expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(responseError(invalid[0]!.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    expect(responseError(invalid[1]!.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    expect(responseError(invalid[2]!.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    expect(responseError(invalid[3]!.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    const afterInvalid = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact WHERE eval_job_id=$1) AS evidence,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE curator_run_id=$2 AND eval_job_id=$1) AS idempotency`,
      [job.evalJobId, claim.runId],
    );
    expect(afterInvalid.rows[0]).toEqual(before.rows[0]);

    const first = await submit(claim, job, "r2-submit-idempotent");
    expect(first.status).toBe(202);
    expect(responseData(first.json)).toMatchObject({
      schema: "evolution-eval-status.v1",
      eval_job_id: job.evalJobId,
      tool_run_id: job.toolRunId,
      run_class: "evolution_eval",
      state: "submitted",
      replayed: false,
    });
    const replay = await submit(claim, job, "r2-submit-idempotent");
    expect(replay.status).toBe(200);
    expect(responseData(replay.json)).toMatchObject({ eval_job_id: job.evalJobId, replayed: true });
    const changed = await submit(
      claim,
      job,
      "r2-submit-idempotent",
      submitBody(claim, job, { expected_workspace_manifest_hash: hash("different") }),
    );
    expect(changed.status).toBe(409);
    expect(responseError(changed.json).code).toBe("EVOLUTION_EVAL_IDEMPOTENCY_CONFLICT");

    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [claim.runId],
    );
    const reclaimed = await claimFixture(claim);
    const staleReplay = await submit(claim, job, "r2-submit-idempotent");
    expect(staleReplay.status).toBe(409);
    expect(responseError(staleReplay.json).code).toBe("EVOLUTION_LEASE_CONFLICT");
    const currentReplay = await submit(
      reclaimed,
      job,
      "r2-submit-idempotent",
      submitBody(reclaimed, job),
    );
    expect(currentReplay.status).toBe(200);
    expect(responseData(currentReplay.json)).toMatchObject({ eval_job_id: job.evalJobId, replayed: true });
    expect(connectorCalls).toBe(0);
  });

  test("R2-02 submit atomically seals one immutable dispatch and never calls Connector", async () => {
    const claim = await claimFixture(await seedClaimable("submit-seal"));
    const job = await prepare(claim, "r2-submit-seal-prepare");
    const first = await submit(claim, job, "r2-submit-seal");
    expect(first.status).toBe(202);
    expect(responseData(first.json)).toMatchObject({
      eval_job_id: job.evalJobId,
      tool_run_id: job.toolRunId,
      workspace_manifest_hash: job.workspaceManifestHash,
      state: "submitted",
      replayed: false,
    });

    const dispatchBinding = await harness.client.query(
      `SELECT d.*,j.connector_job_id,j.connector_idempotency_key,j.eval_input_ref,
              j.input_manifest_hash,j.operation,j.parameters,i.part,i.toolchain_profile_hash,
              r.manifest
         FROM evolution_eval_dispatch d
         JOIN evolution_eval_job j ON j.id=d.eval_job_id
         JOIN evolution_eval_input i ON i.eval_input_ref=j.eval_input_ref
         JOIN evolution_eval_workspace_revision r
           ON r.workspace_id=d.workspace_id AND r.revision=d.workspace_revision
        WHERE d.eval_job_id=$1`,
      [job.evalJobId],
    );
    const binding = dispatchBinding.rows[0]!;
    const expectedProjectionHash = canonicalEvolutionEvalSealedInputProjection(binding.manifest).sha256;
    expect(binding.sealed_input_projection_hash).toBe(expectedProjectionHash);
    expect(binding.dispatch_request_hash).toBe(evolutionEvalCanonicalHash({
      schema: "evolution-eval-dispatch-request.v1",
      eval_job_id: job.evalJobId,
      connector_job_id: binding.connector_job_id,
      connector_idempotency_key: binding.connector_idempotency_key,
      eval_input_ref: binding.eval_input_ref,
      input_manifest_hash: binding.input_manifest_hash,
      workspace_id: job.workspaceId,
      workspace_revision: job.workspaceRevision,
      workspace_manifest_hash: job.workspaceManifestHash,
      sealed_input_projection_hash: expectedProjectionHash,
      operation: binding.operation,
      parameters: binding.parameters,
      part: binding.part,
      toolchain_profile_hash: binding.toolchain_profile_hash,
      requested_timeout_ms: binding.requested_timeout_ms,
      operation_cap_ms: binding.operation_cap_ms,
      deadline_at: new Date(binding.deadline_at).toISOString(),
      run_class: "evolution_eval",
    }));

    const facts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch d
           WHERE d.eval_job_id=$1 AND d.workspace_id=$2
             AND d.workspace_revision=$3 AND d.workspace_manifest_hash=$4) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_operation_fact f
           WHERE f.eval_job_id=$1 AND f.fact_type='workspace_seal'
             AND f.workspace_revision=$3 AND f.workspace_manifest_hash=$4) AS seals,
         (SELECT count(*)::int FROM evolution_eval_audit_event a
           WHERE a.eval_job_id=$1 AND a.event_type='dispatch_sealed'
             AND a.workspace_manifest_hash=$4) AS dispatch_audits,
         (SELECT count(*)::int FROM evolution_eval_audit_event a
           WHERE a.eval_job_id=$1 AND a.event_type='workspace_sealed'
             AND a.workspace_manifest_hash=$4) AS seal_audits,
         (SELECT count(*)::int FROM outbox_events o
           WHERE o.aggregate_type='evolution_eval_job' AND o.aggregate_id=$1
             AND o.event_type='evolution_eval.dispatch_requested') AS dispatch_outbox,
         (SELECT count(*)::int FROM outbox_events o
           WHERE o.aggregate_type='evolution_eval_job' AND o.aggregate_id=$1
             AND o.event_type='evolution_eval.workspace_sealed') AS seal_outbox,
         (SELECT count(*)::int FROM evolution_eval_idempotency i
           WHERE i.curator_run_id=$5 AND i.eval_job_id=$1 AND i.action='submit'
             AND i.idempotency_key='r2-submit-seal' AND i.completed_at IS NOT NULL) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_job j
           WHERE j.id=$1 AND j.tool_run_id=$6 AND j.workspace_id=$2) AS jobs,
         (SELECT count(*)::int FROM tool_run t
           WHERE t.id=$6 AND t.state='submitted' AND t.run_class='evolution_eval') AS tool_runs,
         (SELECT count(*)::int FROM evolution_eval_workspace_projection p
           WHERE p.workspace_id=$2 AND p.current_revision=$3
             AND p.sealed_at IS NOT NULL AND p.discarded_at IS NULL) AS projections`,
      [
        job.evalJobId,
        job.workspaceId,
        job.workspaceRevision,
        job.workspaceManifestHash,
        claim.runId,
        job.toolRunId,
      ],
    );
    expect(facts.rows[0]).toEqual({
      dispatches: 1,
      seals: 1,
      dispatch_audits: 1,
      seal_audits: 1,
      dispatch_outbox: 1,
      seal_outbox: 1,
      idempotency: 1,
      jobs: 1,
      tool_runs: 1,
      projections: 1,
    });

    const replay = await submit(claim, job, "r2-submit-seal");
    expect(replay.status).toBe(200);
    expect(responseData(replay.json).replayed).toBe(true);
    const sealedWrite = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, job)}/workspace/write`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-write-after-seal" },
        body: {
          schema: "evolution-eval-workspace-write.v1",
          curator_lease_token: claim.leaseToken,
          workspace_id: job.workspaceId,
          expected_workspace_revision: job.workspaceRevision,
          changes: [{ action: "delete", path: claim.sourcePath }],
        },
      },
    );
    expect(sealedWrite.status).toBe(409);
    expect(responseError(sealedWrite.json).code).toBe("EVOLUTION_EVAL_WORKSPACE_SEALED");
    const unchanged = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_operation_fact
           WHERE eval_job_id=$1 AND fact_type='workspace_seal') AS seals,
         (SELECT count(*)::int FROM evolution_eval_workspace_revision WHERE workspace_id=$2) AS revisions`,
      [job.evalJobId, job.workspaceId],
    );
    expect(unchanged.rows[0]).toEqual({ dispatches: 1, seals: 1, revisions: 1 });
    expect(connectorCalls).toBe(0);
  });

  test("R2-02b submit re-scans sealed source XDC and rolls back every dispatch side effect", async () => {
    const maliciousXdc = "exec /usr/bin/id\n";
    const claim = await claimFixture(await seedClaimable("submit-xdc-rescan", {
      sourceXdcContent: maliciousXdc,
    }));
    expect(claim.constraintPath).toBe("constraints/top.xdc");
    const preparedResponse = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-submit-xdc-prepare" },
        body: {
          ...prepareBody(claim),
          operation: "implement",
          parameters: {
            operation: "implement",
            source_paths: [claim.sourcePath],
            constraint_paths: [claim.constraintPath],
            top: "top",
            part: "xc7a35tcpg236-1",
            generate_trial_bitstream: true,
          },
        },
      },
    );
    expect(preparedResponse.status).toBe(201);
    const prepared = responseData(preparedResponse.json);
    const job: PreparedFixture = {
      evalJobId: String(prepared.eval_job_id),
      toolRunId: String(prepared.tool_run_id),
      workspaceId: String(prepared.workspace_id),
      workspaceRevision: Number(prepared.workspace_revision),
      workspaceManifestHash: String(prepared.workspace_manifest_hash),
    };
    const sealedSource = await harness.client.query(
      `SELECT managed_content,sha256,size_bytes,media_type,layer,read_only
         FROM evolution_eval_workspace_file
        WHERE workspace_id=$1 AND revision=$2 AND path=$3`,
      [job.workspaceId, job.workspaceRevision, claim.constraintPath],
    );
    expect(Buffer.from(sealedSource.rows[0]!.managed_content)).toEqual(Buffer.from(maliciousXdc));
    expect(Number(sealedSource.rows[0]!.size_bytes)).toBe(Buffer.byteLength(maliciousXdc));
    expect(sealedSource.rows[0]).toMatchObject({
      sha256: hash(maliciousXdc),
      media_type: "application/x-xdc",
      layer: "source",
      read_only: true,
    });
    const before = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_operation_fact
           WHERE eval_job_id=$1 AND fact_type='workspace_seal') AS seals,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE eval_job_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1) AS outbox,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE curator_run_id=$2 AND eval_job_id=$1 AND action='submit') AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_workspace_projection
           WHERE workspace_id=$3 AND sealed_at IS NOT NULL) AS sealed_projections`,
      [job.evalJobId, claim.runId, job.workspaceId],
    );

    const rejected = await submit(claim, job, "r2-submit-xdc-reject");
    expect(rejected.status).toBe(400);
    const error = responseError(rejected.json);
    expect(error.code).toBe("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    const details = record(error.details);
    expect(details.path).toBe(claim.constraintPath);
    expect(details.finding_codes).toEqual(expect.arrayContaining([
      "XDC_HOST_PATH",
      "TCL_PROCESS_START",
    ]));
    const after = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_operation_fact
           WHERE eval_job_id=$1 AND fact_type='workspace_seal') AS seals,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE eval_job_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1) AS outbox,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE curator_run_id=$2 AND eval_job_id=$1 AND action='submit') AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_workspace_projection
           WHERE workspace_id=$3 AND sealed_at IS NOT NULL) AS sealed_projections`,
      [job.evalJobId, claim.runId, job.workspaceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]).toMatchObject({
      dispatches: 0,
      seals: 0,
      idempotency: 0,
      sealed_projections: 0,
    });
    expect(connectorCalls).toBe(0);
  });

  test("R2-03 cancel tombstone wins against pre-effect dispatch without deleting its facts", async () => {
    const claim = await claimFixture(await seedClaimable("cancel-dispatch"));

    const draft = await prepare(claim, "r2-cancel-draft-prepare");
    const cancelledDraft = await cancel(claim, draft, "r2-cancel-draft");
    expect(cancelledDraft.status).toBe(200);
    expect(responseData(cancelledDraft.json)).toMatchObject({
      eval_job_id: draft.evalJobId,
      state: "rejected",
      error_code: "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH",
      replayed: false,
    });
    const replayedDraft = await cancel(claim, draft, "r2-cancel-draft");
    expect(replayedDraft.status).toBe(200);
    expect(responseData(replayedDraft.json)).toMatchObject({
      state: "rejected",
      replayed: true,
    });
    const draftFacts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT count(*)::int FROM evolution_eval_transition_fact
           WHERE eval_job_id=$1 AND from_state='submitted' AND to_state='rejected') AS transitions,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='dispatch_tombstone') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.dispatch_tombstoned') AS outbox,
         (SELECT state::text FROM tool_run WHERE id=$2) AS state`,
      [draft.evalJobId, draft.toolRunId],
    );
    expect(draftFacts.rows[0]).toEqual({
      dispatches: 0,
      tombstones: 1,
      transitions: 1,
      audits: 1,
      outbox: 1,
      state: "rejected",
    });

    const sealed = await prepare(claim, "r2-cancel-sealed-prepare");
    const submitted = await submit(claim, sealed, "r2-cancel-sealed-submit");
    expect(submitted.status).toBe(202);
    const cancelledSealed = await cancel(claim, sealed, "r2-cancel-sealed");
    expect(cancelledSealed.status).toBe(200);
    expect(responseData(cancelledSealed.json)).toMatchObject({
      state: "rejected",
      error_code: "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH",
    });
    const sealedFacts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.dispatch_requested') AS dispatch_outbox,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.dispatch_tombstoned') AS tombstone_outbox,
         (SELECT count(*)::int FROM evolution_eval_transition_fact
           WHERE eval_job_id=$1 AND from_state='submitted' AND to_state='rejected') AS transitions,
         (SELECT state::text FROM tool_run WHERE id=$2) AS state`,
      [sealed.evalJobId, sealed.toolRunId],
    );
    expect(sealedFacts.rows[0]).toEqual({
      dispatches: 1,
      tombstones: 1,
      dispatch_outbox: 1,
      tombstone_outbox: 1,
      transitions: 1,
      state: "rejected",
    });

    const racing = await prepare(claim, "r2-cancel-race-prepare");
    const race = await Promise.all([
      submit(claim, racing, "r2-cancel-race-submit"),
      cancel(claim, racing, "r2-cancel-race"),
    ]);
    expect(race.every((response) => [200, 202, 409].includes(response.status))).toBe(true);
    const raceFacts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT count(*)::int FROM evolution_eval_transition_fact
           WHERE eval_job_id=$1 AND from_state='submitted' AND to_state='rejected') AS transitions,
         (SELECT state::text FROM tool_run WHERE id=$2) AS state`,
      [racing.evalJobId, racing.toolRunId],
    );
    expect([0, 1]).toContain(raceFacts.rows[0]!.dispatches);
    expect(raceFacts.rows[0]).toMatchObject({
      tombstones: 1,
      transitions: 1,
      state: "rejected",
    });
    if (raceFacts.rows[0]!.dispatches === 1) {
      const dispatchOutbox = await harness.client.query(
        `SELECT count(*)::int AS count FROM outbox_events
          WHERE aggregate_id=$1 AND event_type='evolution_eval.dispatch_requested'`,
        [racing.evalJobId],
      );
      expect(dispatchOutbox.rows[0]!.count).toBe(1);
    }
    expect(connectorCalls).toBe(0);
  });

  test("R2-03b running cancel commits only a durable intent before any external effect", async () => {
    const claim = await claimFixture(await seedClaimable("cancel-running"));
    const job = await prepare(claim, "r2-cancel-running-prepare");
    expect((await submit(claim, job, "r2-cancel-running-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "running");
    const response = await cancel(claim, job, "r2-cancel-running", "OPERATOR_REQUEST");
    expect(response.status).toBe(202);
    expect(responseData(response.json)).toMatchObject({
      eval_job_id: job.evalJobId,
      state: "running",
      reconciliation_state: "not_needed",
    });
    const facts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone
           WHERE eval_job_id=$1 AND reason_code='OPERATOR_REQUEST') AS cancel_intents,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='dispatch_tombstone') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.dispatch_tombstoned') AS outbox,
         (SELECT count(*)::int FROM evolution_eval_transition_fact
           WHERE eval_job_id=$1 AND from_state='running') AS terminal_transitions,
         (SELECT state::text FROM tool_run WHERE id=$2) AS state`,
      [job.evalJobId, job.toolRunId],
    );
    expect(facts.rows[0]).toEqual({
      cancel_intents: 1,
      audits: 1,
      outbox: 1,
      terminal_transitions: 0,
      state: "running",
    });
    const replay = await cancel(claim, job, "r2-cancel-running", "OPERATOR_REQUEST");
    expect(replay.status).toBe(200);
    expect(responseData(replay.json)).toMatchObject({ state: "running", replayed: true });
    const noDuplicate = await harness.client.query(
      `SELECT count(*)::int AS count FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1`,
      [job.evalJobId],
    );
    expect(noDuplicate.rows[0]!.count).toBe(1);
    expect(connectorCalls).toBe(0);
  });

  test("R2-04 status and recover create one reconcile intent while safe closeout remains available", async () => {
    const claim = await claimFixture(await seedClaimable("status-recover"));
    const job = await prepare(claim, "r2-status-prepare");
    const path = jobPath(claim, job);
    const draftStatus = await apiCall(harness.baseUrl, `${path}/status`, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-status-request.v1",
        curator_lease_token: claim.leaseToken,
      },
    });
    expect(draftStatus.status).toBe(200);
    expect(responseData(draftStatus.json)).toMatchObject({
      eval_job_id: job.evalJobId,
      state: "submitted",
      reconciliation_state: "not_needed",
    });
    expect(await submit(claim, job, "r2-status-submit")).toMatchObject({ status: 202 });

    const recoverPath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/recover`;
    const [status, recovered, recoveredAgain] = await Promise.all([
      apiCall(harness.baseUrl, `${path}/status`, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: claim.leaseToken,
        },
      }),
      apiCall(harness.baseUrl, recoverPath, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-recover.v1",
          curator_lease_token: claim.leaseToken,
        },
      }),
      apiCall(harness.baseUrl, recoverPath, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-recover.v1",
          curator_lease_token: claim.leaseToken,
        },
      }),
    ]);
    expect([status.status, recovered.status, recoveredAgain.status]).toEqual([200, 200, 200]);
    expect(responseData(status.json)).toMatchObject({
      state: "submitted",
      reconciliation_state: "required",
    });
    for (const response of [recovered, recoveredAgain]) {
      const jobs = responseData(response.json).jobs as unknown[];
      expect(jobs).toHaveLength(1);
      expect(record(jobs[0])).toMatchObject({
        eval_job_id: job.evalJobId,
        state: "submitted",
        workspace_sealed: true,
        reconciliation_state: "required",
      });
    }
    const reconcile = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_reconcile_fact WHERE eval_job_id=$1) AS facts,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='reconcile_required') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.reconcile_requested') AS outbox`,
      [job.evalJobId],
    );
    expect(reconcile.rows[0]).toEqual({ facts: 1, audits: 1, outbox: 1 });

    const blockedSubmit = await submit(claim, job, "r2-status-resubmit");
    expect(blockedSubmit.status).toBe(409);
    expect(responseError(blockedSubmit.json).code).toBe("EVOLUTION_EVAL_RECONCILIATION_REQUIRED");
    const blockedPrepare = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-status-second-prepare" },
        body: prepareBody(claim),
      },
    );
    expect(blockedPrepare.status).toBe(409);
    expect(responseError(blockedPrepare.json).code).toBe("EVOLUTION_EVAL_RECONCILIATION_REQUIRED");
    const safeRead = await apiCall(harness.baseUrl, `${path}/workspace/read`, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-workspace-read.v1",
        curator_lease_token: claim.leaseToken,
        workspace_id: job.workspaceId,
        workspace_revision: job.workspaceRevision,
        paths: [claim.sourcePath],
      },
    });
    expect(safeRead.status).toBe(200);
    const safeCancel = await cancel(claim, job, "r2-status-safe-cancel");
    expect(safeCancel.status).toBe(200);
    expect(responseData(safeCancel.json)).toMatchObject({ state: "rejected" });
    expect(connectorCalls).toBe(0);
  });

  test("R2-04b recover commits intent, queries Connector outside the transaction, settles, then returns fresh state", async () => {
    const claim = await claimFixture(await seedClaimable("post-commit-recover"));
    const job = await prepare(claim, "post-commit-recover-prepare");
    expect((await submit(claim, job, "post-commit-recover-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "running");
    let queries = 0;
    const unexpected = (name: string): never => { throw new Error(`unexpected ${name}`); };
    const evolutionEvalConnector: EvolutionEvalConnectorPort = {
      async query(binding) {
        queries += 1;
        const committed = await harness.client.query(
          `SELECT job.reconciliation_state,
                  (SELECT count(*)::int FROM evolution_eval_reconcile_fact fact
                    WHERE fact.eval_job_id=job.id) AS facts
             FROM evolution_eval_job job WHERE job.id=$1`,
          [binding.dispatch.eval_job_id],
        );
        expect(committed.rows[0]).toEqual({ reconciliation_state: "required", facts: 1 });
        return {
          schema: "evolution-eval-ledger-query.v1",
          connector_job_id: binding.dispatch.connector_job_id,
          connector_idempotency_key: binding.dispatch.connector_idempotency_key,
          dispatch_request_hash: binding.dispatch_request_hash,
          ledger_epoch: "post-commit-route-test",
          state: "terminal",
          terminal_state: "succeeded",
          process_stopped: true,
          terminal_at: new Date().toISOString(),
          error_code: null,
        };
      },
      async queryOrReserve() { return unexpected("queryOrReserve"); },
      async preflight() { return unexpected("preflight"); },
      async submit() { return unexpected("submit"); },
      async cancel() { return unexpected("cancel"); },
      async fetchEvidenceManifest() { return unexpected("fetchEvidenceManifest"); },
      async fetchEvidenceEntry() { return unexpected("fetchEvidenceEntry"); },
      async acknowledgeEvidence() { return unexpected("acknowledgeEvidence"); },
      async acknowledgeCorrupt() { return unexpected("acknowledgeCorrupt"); },
      async cleanupEvidence() { return unexpected("cleanupEvidence"); },
      async querySpool() { return unexpected("querySpool"); },
    };
    const server = startSynthiaServer(harness.pool, {
      port: 0,
      features: { selfEvolution: true, evolutionEvalExecution: true },
      evolutionEvalConnector,
    });
    try {
      const runtimeClient = new CoreEvolutionEvalClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
        evaluatorToken,
      });
      const recovered = await runtimeClient.recover(claim.runId, claim.leaseToken);
      const recoveredJob = recovered.jobs[0]!;
      expect(recoveredJob).toMatchObject({
        eval_job_id: job.evalJobId,
        state: "succeeded",
        evidence_state: "freeze_pending",
        reconciliation_state: "required",
      });
      expect(recoveredJob).not.toHaveProperty("error_code");
      const status = await runtimeClient.status(
        claim.runId,
        job.evalJobId,
        claim.leaseToken,
      );
      expect(status).toMatchObject({
        eval_job_id: recoveredJob.eval_job_id,
        tool_run_id: recoveredJob.tool_run_id,
        application_id: recoveredJob.application_id,
        version_id: recoveredJob.version_id,
        ordinal: recoveredJob.ordinal,
        operation: recoveredJob.operation,
        state: recoveredJob.state,
        deadline_at: recovered.deadline_at,
        workspace_manifest_hash: recoveredJob.workspace_manifest_hash,
        evidence_state: recoveredJob.evidence_state,
        retention_state: recoveredJob.retention_state,
        reconciliation_state: recoveredJob.reconciliation_state,
      });
      expect(queries).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("R2-05 the absolute deadline rejects drafts and freezes evidence cutoff without moving facts", async () => {
    const firstClaim = await claimFixture(await seedClaimable("deadline-cutoff"));
    const draft = await prepare(firstClaim, "r2-deadline-draft-prepare");
    const deadlineResult = await harness.client.query(
      "SELECT deadline_at FROM evolution_eval_run WHERE curator_run_id=$1",
      [firstClaim.runId],
    );
    const deadline = new Date(deadlineResult.rows[0]!.deadline_at);
    const afterDeadline = new Date(deadline.getTime() + 1_000);
    await harness.client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [afterDeadline],
    );
    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=$2 WHERE id=$1",
      [firstClaim.runId, new Date(afterDeadline.getTime() + 10 * 60 * 1000)],
    );
    const claim = firstClaim;
    const lateSubmit = await submit(claim, draft, "r2-deadline-late-submit");
    expect(lateSubmit.status).toBe(409);
    expect(responseError(lateSubmit.json).code).toBe("EVOLUTION_EVAL_BUDGET_EXHAUSTED");
    const draftStatus = await apiCall(harness.baseUrl, `${jobPath(claim, draft)}/status`, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-status-request.v1",
        curator_lease_token: claim.leaseToken,
      },
    });
    expect(draftStatus.status).toBe(200);
    expect(responseData(draftStatus.json)).toMatchObject({
      state: "rejected",
      error_code: "EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH",
      evidence_state: "none",
    });
    const draftFacts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone
           WHERE eval_job_id=$1 AND reason_code='EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH') AS tombstones,
         (SELECT count(*)::int FROM evolution_eval_transition_fact
           WHERE eval_job_id=$1 AND from_state='submitted' AND to_state='rejected') AS transitions,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE eval_job_id=$1 AND action='submit'
             AND idempotency_key='r2-deadline-late-submit') AS late_idempotency`,
      [draft.evalJobId],
    );
    expect(draftFacts.rows[0]).toEqual({
      dispatches: 0,
      tombstones: 1,
      transitions: 1,
      late_idempotency: 0,
    });

    await harness.client.query("UPDATE synthia_test_clock SET now_value=NULL WHERE singleton=true");
    const unavailable = await prepare(claim, "r2-deadline-unavailable-prepare");
    expect((await submit(claim, unavailable, "r2-deadline-unavailable-submit")).status).toBe(202);
    await advanceAcceptedTerminal(unavailable, "succeeded");
    await harness.client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [new Date(deadline.getTime() + 2_000)],
    );
    const unavailableStatus = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, unavailable)}/status`,
      {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: claim.leaseToken,
        },
      },
    );
    expect(unavailableStatus.status).toBe(200);
    expect(responseData(unavailableStatus.json)).toMatchObject({
      state: "succeeded",
      evidence_state: "unavailable_at_deadline",
    });
    const unavailableFacts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_evidence_fact
           WHERE eval_job_id=$1 AND fact_type='unavailable_at_deadline') AS unavailable,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact
           WHERE eval_job_id=$1 AND fact_type='cleanup_pending') AS cleanup,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='evidence.unavailable_at_deadline') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.evidence.unavailable_at_deadline') AS outbox`,
      [unavailable.evalJobId],
    );
    expect(unavailableFacts.rows[0]).toEqual({ unavailable: 1, cleanup: 1, audits: 1, outbox: 1 });
    const lateFreeze = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, unavailable)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-deadline-late-freeze" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "freeze",
        },
      },
    );
    expect(lateFreeze.status).toBe(409);
    expect(responseError(lateFreeze.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_NOT_READY");
    const noLatePending = await harness.client.query(
      `SELECT count(*)::int AS count FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type='freeze_pending'`,
      [unavailable.evalJobId],
    );
    expect(noLatePending.rows[0]!.count).toBe(0);

    await harness.client.query("UPDATE synthia_test_clock SET now_value=NULL WHERE singleton=true");
    const preserved = await prepare(claim, "r2-deadline-preserved-prepare");
    expect((await submit(claim, preserved, "r2-deadline-preserved-submit")).status).toBe(202);
    await advanceAcceptedTerminal(preserved, "succeeded");
    const freezePending = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, preserved)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-deadline-preserved-freeze" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "freeze",
        },
      },
    );
    expect(freezePending.status).toBe(202);
    const preservedManifest = {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: preserved.evalJobId,
      tool_run_id: preserved.toolRunId,
      entries: [],
    };
    const preservedHash = evolutionEvalCanonicalHash(preservedManifest);
    await appendEvidenceFacts(preserved, [{
      type: "frozen",
      manifestHash: preservedHash,
      manifest: preservedManifest,
      entries: [],
    }]);
    await harness.client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [new Date(deadline.getTime() + 3_000)],
    );
    const preservedStatus = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, preserved)}/status`,
      {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: claim.leaseToken,
        },
      },
    );
    expect(preservedStatus.status).toBe(200);
    expect(responseData(preservedStatus.json)).toMatchObject({
      state: "succeeded",
      evidence_state: "frozen",
      evidence_manifest_hash: preservedHash,
    });
    const preservedConclusions = await harness.client.query(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('frozen','corrupt','unavailable_at_deadline')
        ORDER BY fact_type`,
      [preserved.evalJobId],
    );
    expect(preservedConclusions.rows).toEqual([{ fact_type: "frozen" }]);
    expect(connectorCalls).toBe(0);
  });

  test("R2-06 unknown effect is an atomic immutable run latch and blocks later effect work", async () => {
    const claim = await claimFixture(await seedClaimable("unknown-latch"));
    const job = await prepare(claim, "r2-unknown-prepare");
    expect((await submit(claim, job, "r2-unknown-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "running");
    await appendUnknownEffect(job);

    const facts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_unknown_fact u
           WHERE u.eval_job_id=$1) AS unknown_facts,
         (SELECT count(*)::int FROM evolution_eval_transition_fact t
           WHERE t.eval_job_id=$1 AND t.from_state='running' AND t.to_state='unknown_effect') AS transitions,
         (SELECT count(*)::int FROM evolution_eval_audit_event a
           WHERE a.eval_job_id=$1 AND a.from_state='running' AND a.to_state='unknown_effect') AS audits,
         (SELECT count(*)::int FROM outbox_events o
           WHERE o.aggregate_id=$1 AND o.event_type='evolution_eval.unknown_effect') AS outbox,
         (SELECT count(*)::int FROM evolution_eval_run r
           WHERE r.curator_run_id=$2 AND r.unknown_effect_latched_at IS NOT NULL
             AND r.unknown_effect_origin_txid IS NOT NULL) AS latches,
         (SELECT state::text FROM tool_run WHERE id=$3) AS state`,
      [job.evalJobId, claim.runId, job.toolRunId],
    );
    expect(facts.rows[0]).toEqual({
      unknown_facts: 1,
      transitions: 1,
      audits: 1,
      outbox: 1,
      latches: 1,
      state: "unknown_effect",
    });
    const status = await apiCall(harness.baseUrl, `${jobPath(claim, job)}/status`, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-status-request.v1",
        curator_lease_token: claim.leaseToken,
      },
    });
    expect(status.status).toBe(200);
    expect(responseData(status.json)).toMatchObject({
      state: "unknown_effect",
      evidence_state: "none",
    });
    const frozen = await apiCall(harness.baseUrl, `${jobPath(claim, job)}/evidence`, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-unknown-freeze" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "freeze",
      },
    });
    expect(frozen.status).toBe(409);
    expect(responseError(frozen.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_NOT_READY");
    const laterPrepare = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-unknown-second-prepare" },
        body: prepareBody(claim),
      },
    );
    expect(laterPrepare.status).toBe(409);
    expect(responseError(laterPrepare.json).code).toBe("EVOLUTION_EVAL_RUN_NOT_ACTIVE");
    const rewrite = harness.client.query(
      "UPDATE tool_run SET state='failed' WHERE id=$1",
      [job.toolRunId],
    );
    await expect(rewrite).rejects.toThrow();
    const stillUnknown = await harness.client.query(
      `SELECT t.state::text,r.unknown_effect_latched_at
         FROM tool_run t
         JOIN evolution_eval_job j ON j.tool_run_id=t.id
         JOIN evolution_eval_run r ON r.curator_run_id=j.curator_run_id
        WHERE t.id=$1`,
      [job.toolRunId],
    );
    expect(stillUnknown.rows[0]!.state).toBe("unknown_effect");
    expect(stillUnknown.rows[0]!.unknown_effect_latched_at).not.toBeNull();
    expect(connectorCalls).toBe(0);
  });

  test("R2-07 freeze, Core-copy read and ack use append-only evidence with bit classification", async () => {
    const claim = await claimFixture(await seedClaimable("evidence-valid"));
    const job = await prepare(claim, "r2-evidence-prepare");
    const path = `${jobPath(claim, job)}/evidence`;
    const draftFreeze = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-evidence-draft" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "freeze",
      },
    });
    expect(draftFreeze.status).toBe(409);
    expect(responseError(draftFreeze.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_NOT_READY");
    expect((await submit(claim, job, "r2-evidence-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "succeeded");

    const freeze = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-evidence-freeze" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "freeze",
      },
    });
    expect(freeze.status).toBe(202);
    expect(responseData(freeze.json)).toMatchObject({
      schema: "evolution-eval-evidence-pending.v1",
      eval_job_id: job.evalJobId,
      action: "freeze",
      duty_state: "freeze_pending",
      replayed: false,
    });
    const entries: EvidenceEntryFixture[] = [
      {
        name: "run.log",
        mediaType: "text/plain",
        artifactClassification: "evolution_eval_evidence",
        content: Buffer.from("implementation passed\n"),
      },
      {
        name: "trial.bit",
        mediaType: "application/octet-stream",
        artifactClassification: "experimental/evolution_eval",
        content: Buffer.from([0x42, 0x49, 0x54, 0x00]),
      },
    ];
    const manifestEntries = entries.map((entry) => ({
      name: entry.name,
      sha256: hash(entry.content),
      size_bytes: entry.content.byteLength,
      media_type: entry.mediaType,
      artifact_classification: entry.artifactClassification,
      usage_classification: "evolution_eval_only",
    }));
    const manifest = {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: job.evalJobId,
      tool_run_id: job.toolRunId,
      entries: manifestEntries,
    };
    const manifestHash = evolutionEvalCanonicalHash(manifest);
    const frozenFacts = await appendEvidenceFacts(job, [{
      type: "frozen",
      manifestHash,
      manifest,
      entries,
    }]);
    const frozenFactId = frozenFacts.get("frozen")!.id;

    const freezeAfter = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-evidence-freeze-after" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "freeze",
      },
    });
    expect(freezeAfter.status).toBe(200);
    expect(responseData(freezeAfter.json)).toMatchObject({
      manifest_hash: manifestHash,
      evidence_state: "frozen",
      retention_state: "pending_ack",
      replayed: false,
    });
    const projectedEntries = responseData(freezeAfter.json).entries as unknown[];
    expect(projectedEntries.map(record)).toEqual(manifestEntries);

    const read = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "read",
        name: "trial.bit",
        expected_sha256: hash(entries[1]!.content),
      },
    });
    expect(read.status).toBe(200);
    expect(responseData(read.json)).toEqual({
      schema: "evolution-eval-evidence-content.v1",
      name: "trial.bit",
      sha256: hash(entries[1]!.content),
      size_bytes: entries[1]!.content.byteLength,
      media_type: "application/octet-stream",
      content_base64: entries[1]!.content.toString("base64"),
    });

    const ack = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-evidence-ack" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "ack",
        expected_manifest_hash: manifestHash,
      },
    });
    expect(ack.status).toBe(202);
    expect(responseData(ack.json)).toMatchObject({ duty_state: "ack_pending" });
    await appendEvidenceFacts(job, [{ type: "acknowledged", manifestHash }]);
    const ackAfter = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-evidence-ack-after" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "ack",
        expected_manifest_hash: manifestHash,
      },
    });
    expect(ackAfter.status).toBe(200);
    expect(responseData(ackAfter.json)).toMatchObject({ retention_state: "acknowledged" });

    const invalidBit = harness.client.query(
      `INSERT INTO evolution_eval_evidence_entry
        (id,evidence_fact_id,eval_job_id,name,sha256,size_bytes,media_type,
         artifact_classification,usage_classification,managed_content)
       VALUES ($1,$2,$3,'misclassified.bit',$4,1,'application/octet-stream',
               'evolution_eval_evidence','evolution_eval_only',$5)`,
      [
        `entry_bad_${randomUUID()}`,
        frozenFactId,
        job.evalJobId,
        hash(Buffer.from([0x00])),
        Buffer.from([0x00]),
      ],
    );
    await expect(invalidBit).rejects.toThrow();
    expect(connectorCalls).toBe(0);
  });

  test("R2-08 corrupt evidence requires prior intent and atomic quarantine plus cleanup", async () => {
    const claim = await claimFixture(await seedClaimable("evidence-corrupt"));
    const first = await prepare(claim, "r2-corrupt-first-prepare");
    expect((await submit(claim, first, "r2-corrupt-first-submit")).status).toBe(202);
    await advanceAcceptedTerminal(first, "failed");
    const evidencePath = `${jobPath(claim, first)}/evidence`;
    const pending = await apiCall(harness.baseUrl, evidencePath, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "r2-corrupt-freeze" },
      body: {
        schema: "evolution-eval-evidence.v1",
        curator_lease_token: claim.leaseToken,
        action: "freeze",
      },
    });
    expect(pending.status).toBe(202);

    await expect(appendEvidenceFacts(first, [{
      type: "corrupt",
      errorCode: "EVOLUTION_EVAL_EVIDENCE_CORRUPT",
    }])).rejects.toThrow();
    let corruptCount = await harness.client.query(
      `SELECT count(*)::int AS count FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('corrupt','quarantine_pending','cleanup_pending')`,
      [first.evalJobId],
    );
    expect(corruptCount.rows[0]!.count).toBe(0);
    const legal = await appendEvidenceFacts(first, [
      { type: "corrupt", errorCode: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" },
      { type: "quarantine_pending" },
      { type: "cleanup_pending" },
    ]);
    expect([...legal.keys()]).toEqual(["corrupt", "quarantine_pending", "cleanup_pending"]);
    corruptCount = await harness.client.query(
      `SELECT count(*)::int AS count FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('corrupt','quarantine_pending','cleanup_pending')`,
      [first.evalJobId],
    );
    expect(corruptCount.rows[0]!.count).toBe(3);
    const rawCorrupt = harness.client.query(
      `INSERT INTO evolution_eval_evidence_entry
        (id,evidence_fact_id,eval_job_id,name,sha256,size_bytes,media_type,
         artifact_classification,usage_classification,managed_content)
       VALUES ($1,$2,$3,'corrupt.log',$4,1,'text/plain','evolution_eval_evidence',
               'evolution_eval_only',$5)`,
      [
        `entry_corrupt_${randomUUID()}`,
        legal.get("corrupt")!.id,
        first.evalJobId,
        hash(Buffer.from([0x00])),
        Buffer.from([0x00]),
      ],
    );
    await expect(rawCorrupt).rejects.toThrow();
    const lateFrozenManifest = {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: first.evalJobId,
      tool_run_id: first.toolRunId,
      entries: [],
    };
    await expect(appendEvidenceFacts(first, [{
      type: "frozen",
      manifestHash: evolutionEvalCanonicalHash(lateFrozenManifest),
      manifest: lateFrozenManifest,
      entries: [],
    }])).rejects.toThrow();

    const second = await prepare(claim, "r2-corrupt-second-prepare");
    expect((await submit(claim, second, "r2-corrupt-second-submit")).status).toBe(202);
    await advanceAcceptedTerminal(second, "failed");
    await expect(appendEvidenceFacts(second, [
      { type: "corrupt", errorCode: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" },
      { type: "quarantine_pending" },
      { type: "cleanup_pending" },
    ])).rejects.toThrow();
    await expect(appendEvidenceFacts(second, [
      {
        type: "unavailable_at_deadline",
        errorCode: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE",
      },
      { type: "cleanup_pending" },
    ])).rejects.toThrow();

    const third = await prepare(claim, "r2-corrupt-third-prepare");
    expect((await submit(claim, third, "r2-corrupt-third-submit")).status).toBe(202);
    await advanceAcceptedTerminal(third, "failed");
    await expect(appendEvidenceFacts(third, [
      { type: "freeze_pending" },
      { type: "corrupt", errorCode: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" },
      { type: "quarantine_pending" },
      { type: "cleanup_pending" },
    ])).rejects.toThrow();
    const finalCounts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_evidence_fact WHERE eval_job_id=$1) AS second,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact WHERE eval_job_id=$2) AS third`,
      [second.evalJobId, third.evalJobId],
    );
    expect(finalCounts.rows[0]).toEqual({ second: 0, third: 0 });
    expect(connectorCalls).toBe(0);
  });

  test("R2-08b retention expiry requires an older frozen terminal and same-transaction cleanup", async () => {
    const claim = await claimFixture(await seedClaimable("evidence-expiry"));
    const job = await prepare(claim, "r2-expiry-prepare");
    expect((await submit(claim, job, "r2-expiry-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "succeeded");
    const freeze = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, job)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-expiry-freeze" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "freeze",
        },
      },
    );
    expect(freeze.status).toBe(202);
    const manifest = {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: job.evalJobId,
      tool_run_id: job.toolRunId,
      entries: [],
    };
    const manifestHash = evolutionEvalCanonicalHash(manifest);
    await appendEvidenceFacts(job, [{
      type: "frozen",
      manifestHash,
      manifest,
      entries: [],
    }]);
    await expect(appendEvidenceFacts(job, [
      { type: "expired", manifestHash },
      { type: "cleanup_pending" },
    ])).rejects.toThrow();
    let retention = await harness.client.query(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('frozen','expired','cleanup_pending')
        ORDER BY fact_type`,
      [job.evalJobId],
    );
    expect(retention.rows).toEqual([{ fact_type: "frozen" }]);

    const endTimeResult = await harness.client.query(
      "SELECT end_time FROM tool_run WHERE id=$1",
      [job.toolRunId],
    );
    await harness.client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [new Date(new Date(endTimeResult.rows[0]!.end_time).getTime() + 8 * 24 * 60 * 60 * 1000)],
    );
    await expect(appendEvidenceFacts(job, [{ type: "expired", manifestHash }])).rejects.toThrow();
    await appendEvidenceFacts(job, [
      { type: "expired", manifestHash },
      { type: "cleanup_pending" },
    ]);
    retention = await harness.client.query(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('frozen','expired','cleanup_pending')
        ORDER BY fact_type`,
      [job.evalJobId],
    );
    expect(retention.rows).toEqual([
      { fact_type: "cleanup_pending" },
      { fact_type: "expired" },
      { fact_type: "frozen" },
    ]);
    const fakeNowResult = await harness.client.query(
      "SELECT now_value FROM synthia_test_clock WHERE singleton=true",
    );
    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=$2 WHERE id=$1",
      [
        claim.runId,
        new Date(new Date(fakeNowResult.rows[0]!.now_value).getTime() + 10 * 60 * 1000),
      ],
    );
    const lateAck = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, job)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-expiry-late-ack" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "ack",
          expected_manifest_hash: manifestHash,
        },
      },
    );
    expect(lateAck.status).toBe(409);
    expect(responseError(lateAck.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_NOT_READY");
    const noAckAfterExpiry = await harness.client.query(
      `SELECT count(*)::int AS count FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('ack_pending','acknowledged')`,
      [job.evalJobId],
    );
    expect(noAckAfterExpiry.rows[0]!.count).toBe(0);
    const beforeForgery = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_evidence_fact
           WHERE eval_job_id=$1 AND fact_type IN ('ack_pending','acknowledged')) AS ack_facts,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE eval_job_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1) AS outbox`,
      [job.evalJobId],
    );
    // A pending acknowledgement may already exist when absolute expiry wins.
    // The E3 dispatcher settles that obsolete duty without Connector I/O; the
    // database must permit the durable intent but never an acknowledgement.
    await appendEvidenceFacts(job, [{ type: "ack_pending", manifestHash }]);
    const afterForgery = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_evidence_fact
           WHERE eval_job_id=$1 AND fact_type IN ('ack_pending','acknowledged')) AS ack_facts,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE eval_job_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1) AS outbox`,
      [job.evalJobId],
    );
    expect(afterForgery.rows[0]).toEqual({
      ack_facts: Number(beforeForgery.rows[0]!.ack_facts) + 1,
      audits: Number(beforeForgery.rows[0]!.audits) + 1,
      outbox: Number(beforeForgery.rows[0]!.outbox) + 1,
    });
    const noAcknowledgement = await harness.client.query(
      `SELECT count(*)::int AS count FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type='acknowledged'`,
      [job.evalJobId],
    );
    expect(noAcknowledgement.rows[0]!.count).toBe(0);
    const projected = await apiCall(harness.baseUrl, `${jobPath(claim, job)}/status`, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-status-request.v1",
        curator_lease_token: claim.leaseToken,
      },
    });
    expect(projected.status).toBe(200);
    expect(responseData(projected.json)).toMatchObject({
      evidence_state: "frozen",
      retention_state: "expired",
    });
    expect(connectorCalls).toBe(0);
  });

  test("R2-09a nonterminal and pending evidence prevent Curator termination", async () => {
    const claim = await claimFixture(await seedClaimable("complete-preconditions"));
    const job = await prepare(claim, "r2-preconditions-prepare");
    const incomplete = await completeCurator(claim, job);
    expect(incomplete.status).toBe(409);
    expect(responseError(incomplete.json).code).toBe("EVOLUTION_EVAL_RECONCILIATION_REQUIRED");
    const failIncomplete = await failCurator(claim, false);
    expect(failIncomplete.status).toBe(409);
    expect(responseError(failIncomplete.json).code).toBe("EVOLUTION_EVAL_RECONCILIATION_REQUIRED");
    expect((await submit(claim, job, "r2-preconditions-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "failed");
    const freeze = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, job)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-preconditions-freeze" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "freeze",
        },
      },
    );
    expect(freeze.status).toBe(202);
    const pending = await completeCurator(claim, job);
    expect(pending.status).toBe(409);
    expect(responseError(pending.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_NOT_READY");
    const stillRunning = await harness.client.query(
      `SELECT state,(SELECT count(*)::int FROM curator_evaluation WHERE curator_run_id=$1) AS evaluations
         FROM curator_run WHERE id=$1`,
      [claim.runId],
    );
    expect(stillRunning.rows[0]).toEqual({ state: "running", evaluations: 0 });
    expect(connectorCalls).toBe(0);
  });

  test("R2-09b corrupt and unavailable evidence forbid fail but permit only inconclusive no-op complete", async () => {
    const corruptClaim = await claimFixture(await seedClaimable("complete-corrupt"));
    const corruptJob = await prepare(corruptClaim, "r2-complete-corrupt-prepare");
    expect((await submit(corruptClaim, corruptJob, "r2-complete-corrupt-submit")).status).toBe(202);
    await advanceAcceptedTerminal(corruptJob, "failed");
    const freeze = await apiCall(
      harness.baseUrl,
      `${jobPath(corruptClaim, corruptJob)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-complete-corrupt-freeze" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: corruptClaim.leaseToken,
          action: "freeze",
        },
      },
    );
    expect(freeze.status).toBe(202);
    await appendEvidenceFacts(corruptJob, [
      { type: "corrupt", errorCode: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" },
      { type: "quarantine_pending" },
      { type: "cleanup_pending" },
    ]);
    const corruptFail = await failCurator(corruptClaim, false);
    expect(corruptFail.status).toBe(409);
    expect(responseError(corruptFail.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_REQUIRES_COMPLETE");
    const corruptSuccess = await completeCurator(corruptClaim, corruptJob, { outcome: "success" });
    expect(corruptSuccess.status).toBe(409);
    expect(responseError(corruptSuccess.json).code).toBe("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE");
    const corruptPatch = await completeCurator(corruptClaim, corruptJob, { remediationAction: "state_action" });
    expect(corruptPatch.status).toBe(409);
    expect(responseError(corruptPatch.json).code).toBe("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE");
    expect((await completeCurator(corruptClaim, corruptJob)).status).toBe(200);

    const unavailableClaim = await claimFixture(await seedClaimable("complete-unavailable"));
    const unavailableJob = await prepare(unavailableClaim, "r2-complete-unavailable-prepare");
    expect((await submit(unavailableClaim, unavailableJob, "r2-complete-unavailable-submit")).status).toBe(202);
    await advanceAcceptedTerminal(unavailableJob, "timeout");
    const deadlineResult = await harness.client.query(
      "SELECT deadline_at FROM evolution_eval_run WHERE curator_run_id=$1",
      [unavailableClaim.runId],
    );
    const afterDeadline = new Date(new Date(deadlineResult.rows[0]!.deadline_at).getTime() + 1_000);
    await harness.client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [afterDeadline],
    );
    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=$2 WHERE id=$1",
      [unavailableClaim.runId, new Date(afterDeadline.getTime() + 10 * 60 * 1000)],
    );
    const status = await apiCall(
      harness.baseUrl,
      `${jobPath(unavailableClaim, unavailableJob)}/status`,
      {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: unavailableClaim.leaseToken,
        },
      },
    );
    expect(status.status).toBe(200);
    expect(responseData(status.json).evidence_state).toBe("unavailable_at_deadline");
    const unavailableFail = await failCurator(unavailableClaim, true);
    expect(unavailableFail.status).toBe(409);
    expect(responseError(unavailableFail.json).code).toBe("EVOLUTION_EVAL_EVIDENCE_REQUIRES_COMPLETE");
    expect((await completeCurator(unavailableClaim, unavailableJob)).status).toBe(200);
    expect(connectorCalls).toBe(0);
  });

  test("R2-09c a revived failed Curator run remains evidence-only after its eval budget closed", async () => {
    const firstClaim = await claimFixture(
      await seedClaimable("revived-evidence-only", { scheduled: true }),
      "scheduled",
    );
    const job = await prepare(firstClaim, "r2-revived-prepare");
    expect((await cancel(firstClaim, job, "r2-revived-cancel")).status).toBe(200);
    const failed = await failCurator(firstClaim, false);
    expect(failed.status).toBe(200);
    expect(responseData(failed.json)).toMatchObject({ state: "failed" });
    const closed = await harness.client.query(
      `SELECT c.state,e.completed_at
         FROM curator_run c JOIN evolution_eval_run e ON e.curator_run_id=c.id
        WHERE c.id=$1`,
      [firstClaim.runId],
    );
    expect(closed.rows[0]!.state).toBe("failed");
    expect(closed.rows[0]!.completed_at).not.toBeNull();
    await harness.client.query(
      "UPDATE curator_run SET completed_at=now()-interval '2 minutes' WHERE id=$1",
      [firstClaim.runId],
    );
    const scheduled = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/ensure-scheduled",
      {
        method: "POST",
        token: schedulerToken,
        body: { request_key: "r2-revive-same-generation" },
      },
    );
    expect(scheduled.status).toBe(200);
    expect(responseData(scheduled.json)).toMatchObject({
      state: "queued",
      curator_run_id: firstClaim.runId,
      reason_code: "rematerialized_after_failure",
    });
    const revived = await claimFixture(firstClaim, "scheduled");
    expect(revived.leaseToken).not.toBe(firstClaim.leaseToken);
    expect(revived.evalInputRef).toBe(firstClaim.evalInputRef);
    expect(revived.inputManifestHash).toBe(firstClaim.inputManifestHash);
    const before = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_run WHERE curator_run_id=$1) AS eval_runs,
         (SELECT count(*)::int FROM evolution_eval_run
           WHERE curator_run_id=$1 AND completed_at IS NOT NULL) AS closed_runs,
         (SELECT count(*)::int FROM evolution_eval_input WHERE curator_run_id=$1) AS inputs,
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int FROM evolution_eval_reconcile_fact f
           JOIN evolution_eval_job j ON j.id=f.eval_job_id WHERE j.curator_run_id=$1) AS reconcile,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact f
           JOIN evolution_eval_job j ON j.id=f.eval_job_id WHERE j.curator_run_id=$1) AS evidence,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE curator_run_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$2) AS outbox`,
      [firstClaim.runId, job.evalJobId],
    );
    expect(before.rows[0]).toMatchObject({ eval_runs: 1, closed_runs: 1, inputs: 1, jobs: 1 });

    const path = jobPath(revived, job);
    const responses = await Promise.all([
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${revived.runId}/eval-jobs/prepare`,
        {
          method: "POST",
          token: evaluatorToken,
          headers: { "idempotency-key": "r2-revived-second-prepare" },
          body: prepareBody(revived),
        },
      ),
      apiCall(harness.baseUrl, `${path}/workspace/write`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-revived-write" },
        body: {
          schema: "evolution-eval-workspace-write.v1",
          curator_lease_token: revived.leaseToken,
          workspace_id: job.workspaceId,
          expected_workspace_revision: job.workspaceRevision,
          changes: [{ action: "delete", path: "overlay/closed.sv" }],
        },
      }),
      submit(revived, job, "r2-revived-submit"),
      apiCall(harness.baseUrl, `${path}/status`, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: revived.leaseToken,
        },
      }),
      cancel(revived, job, "r2-revived-cancel-again"),
      apiCall(harness.baseUrl, `${path}/evidence`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-revived-evidence" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: revived.leaseToken,
          action: "freeze",
        },
      }),
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${revived.runId}/eval-jobs/recover`,
        {
          method: "POST",
          token: evaluatorToken,
          body: {
            schema: "evolution-eval-recover.v1",
            curator_lease_token: revived.leaseToken,
          },
        },
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 409, 409, 409, 409]);
    for (const response of responses) {
      expect(responseError(response.json).code).toBe("EVOLUTION_EVAL_RUN_NOT_ACTIVE");
    }
    const after = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_run WHERE curator_run_id=$1) AS eval_runs,
         (SELECT count(*)::int FROM evolution_eval_run
           WHERE curator_run_id=$1 AND completed_at IS NOT NULL) AS closed_runs,
         (SELECT count(*)::int FROM evolution_eval_input WHERE curator_run_id=$1) AS inputs,
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int FROM evolution_eval_reconcile_fact f
           JOIN evolution_eval_job j ON j.id=f.eval_job_id WHERE j.curator_run_id=$1) AS reconcile,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact f
           JOIN evolution_eval_job j ON j.id=f.eval_job_id WHERE j.curator_run_id=$1) AS evidence,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE curator_run_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$2) AS outbox`,
      [firstClaim.runId, job.evalJobId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(connectorCalls).toBe(0);
  });

  test("R2-09 unknown and unusable evidence cannot bypass exhaustive Curator completion", async () => {
    const claim = await claimFixture(await seedClaimable("complete-unknown"));
    const job = await prepare(claim, "r2-complete-prepare");
    expect((await submit(claim, job, "r2-complete-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "running");
    await appendUnknownEffect(job);

    const failed = await failCurator(claim, false);
    expect(failed.status).toBe(409);
    expect(responseError(failed.json).code).toBe("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE");
    const retryFailed = await failCurator(claim, true);
    expect(retryFailed.status).toBe(409);
    expect(responseError(retryFailed.json).code).toBe("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE");
    const successClaim = await completeCurator(claim, job, { outcome: "success" });
    expect(successClaim.status).toBe(409);
    expect(responseError(successClaim.json).code).toBe("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE");
    const patchClaim = await completeCurator(claim, job, { remediationAction: "patch" });
    expect(patchClaim.status).toBe(409);
    expect(responseError(patchClaim.json).code).toBe("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE");
    const missingRefs = await completeCurator(claim, job, { evalJobRefs: [] });
    expect(missingRefs.status).toBe(409);
    expect(responseError(missingRefs.json).code).toBe("EVOLUTION_EVAL_BINDING_CONFLICT");
    const forgedRefs = await completeCurator(claim, job, {
      evalJobRefs: [{
        eval_job_id: `${job.evalJobId}_forged`,
        tool_run_id: job.toolRunId,
        evidence_manifest_hash: null,
      }],
    });
    expect(forgedRefs.status).toBe(409);
    expect(responseError(forgedRefs.json).code).toBe("EVOLUTION_EVAL_BINDING_CONFLICT");
    const before = await harness.client.query(
      `SELECT
         (SELECT state FROM curator_run WHERE id=$1) AS run_state,
         (SELECT count(*)::int FROM curator_evaluation WHERE curator_run_id=$1) AS evaluations,
         (SELECT count(*)::int FROM curator_remediation_audit WHERE curator_run_id=$1) AS remediations,
         (SELECT count(*)::int FROM learned_skill_version v
           WHERE v.curator_run_id=$1) AS versions`,
      [claim.runId],
    );
    expect(before.rows[0]).toEqual({
      run_state: "running",
      evaluations: 0,
      remediations: 0,
      versions: 0,
    });

    const completed = await completeCurator(claim, job);
    expect(completed.status).toBe(200);
    expect(responseData(completed.json)).toMatchObject({
      schema: "curator-result.v1",
      run_id: claim.runId,
      state: "completed",
      replayed: false,
    });
    const committed = await harness.client.query(
      `SELECT
         (SELECT state FROM curator_run WHERE id=$1) AS run_state,
         (SELECT count(*)::int FROM curator_evaluation
           WHERE curator_run_id=$1 AND outcome='inconclusive') AS evaluations,
         (SELECT count(*)::int FROM curator_remediation_audit
           WHERE curator_run_id=$1 AND action='no_op' AND decision='applied') AS remediations,
         (SELECT count(*)::int FROM evolution_eval_run
           WHERE curator_run_id=$1 AND completed_at IS NOT NULL) AS completed_eval_runs`,
      [claim.runId],
    );
    expect(committed.rows[0]).toEqual({
      run_state: "completed",
      evaluations: 1,
      remediations: 1,
      completed_eval_runs: 1,
    });
    const closedStatus = await apiCall(harness.baseUrl, `${jobPath(claim, job)}/status`, {
      method: "POST",
      token: evaluatorToken,
      body: {
        schema: "evolution-eval-status-request.v1",
        curator_lease_token: claim.leaseToken,
      },
    });
    expect(closedStatus.status).toBe(409);
    expect(responseError(closedStatus.json).code).toBe("EVOLUTION_EVAL_RUN_NOT_ACTIVE");
    expect(connectorCalls).toBe(0);
  });

  test("R2-10 completed evaluations expose an ACL-aware immutable trace and no Evaluator backdoor", async () => {
    const claim = await claimFixture(await seedClaimable("trace-projection"));
    const job = await prepare(claim, "r2-trace-prepare");
    expect((await submit(claim, job, "r2-trace-submit")).status).toBe(202);
    await advanceAcceptedTerminal(job, "succeeded");
    const freeze = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, job)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-trace-freeze" },
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "freeze",
        },
      },
    );
    expect(freeze.status).toBe(202);
    const content = Buffer.from("timing met\n");
    const entry: EvidenceEntryFixture = {
      name: "timing.rpt",
      mediaType: "text/plain",
      artifactClassification: "evolution_eval_evidence",
      content,
    };
    const manifest = {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: job.evalJobId,
      tool_run_id: job.toolRunId,
      entries: [{
        name: entry.name,
        sha256: hash(content),
        size_bytes: content.byteLength,
        media_type: entry.mediaType,
        artifact_classification: entry.artifactClassification,
        usage_classification: "evolution_eval_only",
      }],
    };
    const manifestHash = evolutionEvalCanonicalHash(manifest);
    await appendEvidenceFacts(job, [{
      type: "frozen",
      manifestHash,
      manifest,
      entries: [entry],
    }]);
    const completed = await completeCurator(claim, job, {
      outcome: "success",
      evidenceManifestHash: manifestHash,
    });
    expect(completed.status).toBe(200);

    const visible = await apiCall(
      harness.baseUrl,
      `/api/v1/skill-applications/${claim.applicationId}`,
      { method: "GET", token: harness.ids.serviceToken },
    );
    expect(visible.status).toBe(200);
    const visibleData = responseData(visible.json);
    expect(visibleData.project_ref).toBe(claim.projectId);
    const visibleEvaluation = record((visibleData.evaluations as unknown[])[0]);
    const visibleTrace = record((visibleEvaluation.eval_job_refs as unknown[])[0]);
    expect(visibleTrace).toMatchObject({
      eval_job_ref: job.evalJobId,
      tool_run_ref: job.toolRunId,
      operation: "synthesize",
      state: "succeeded",
      workspace_manifest_hash: job.workspaceManifestHash,
      evidence_manifest_hash: manifestHash,
      evidence_state: "frozen",
    });
    expect(record((visibleTrace.evidence_entries as unknown[])[0])).toEqual({
      name: "timing.rpt",
      sha256: hash(content),
      size_bytes: content.byteLength,
      media_type: "text/plain",
      artifact_classification: "evolution_eval_evidence",
      usage_classification: "evolution_eval_only",
    });

    const redacted = await apiCall(
      harness.baseUrl,
      `/api/v1/skill-applications/${claim.applicationId}`,
      { method: "GET", token: harness.ids.readOnlyToken },
    );
    expect(redacted.status).toBe(200);
    const redactedData = responseData(redacted.json);
    expect(redactedData).toMatchObject({
      project_ref: "redacted",
      task_ref: "redacted",
      local_goal: "redacted",
    });
    const redactedEvaluation = record((redactedData.evaluations as unknown[])[0]);
    const redactedTrace = record((redactedEvaluation.eval_job_refs as unknown[])[0]);
    expect(redactedEvaluation.reason).toBe("redacted");
    expect(redactedTrace).toMatchObject({
      eval_job_ref: "redacted",
      tool_run_ref: "redacted",
      operation: "synthesize",
      state: "succeeded",
      evidence_manifest_hash: manifestHash,
    });
    const redactedEntry = record((redactedTrace.evidence_entries as unknown[])[0]);
    expect(redactedEntry.name).toBe("redacted");
    expect(redactedEntry.sha256).toBe(hash(content));

    const historicalRead = await apiCall(
      harness.baseUrl,
      `${jobPath(claim, job)}/evidence`,
      {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-evidence.v1",
          curator_lease_token: claim.leaseToken,
          action: "read",
          name: "timing.rpt",
          expected_sha256: hash(content),
        },
      },
    );
    expect(historicalRead.status).toBe(409);
    expect(responseError(historicalRead.json).code).toBe("EVOLUTION_EVAL_RUN_NOT_ACTIVE");
    expect(connectorCalls).toBe(0);
  });

  test("R2-11 governance routes and authority tables reject evolution-eval provenance twice", async () => {
    const claim = await claimFixture(await seedClaimable("governance-boundary"));
    const job = await prepare(claim, "r2-governance-prepare");
    const forbiddenSubmitBodies = [
      submitBody(claim, job, { run_class: "formal" }),
      submitBody(claim, job, { tcl: "open_hw_manager" }),
      submitBody(claim, job, { program_hw_devices: true }),
      submitBody(claim, job, { formal_input_approval_id: "approval-forged" }),
      submitBody(claim, job, { publish: true, download: true }),
    ];
    for (const [index, body] of forbiddenSubmitBodies.entries()) {
      const response = await submit(claim, job, `r2-governance-submit-${index}`, body);
      expect(response.status).toBe(400);
    }
    const zeroDispatch = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE eval_job_id=$1 AND action='submit') AS idempotency`,
      [job.evalJobId],
    );
    expect(zeroDispatch.rows[0]).toEqual({ dispatches: 0, idempotency: 0 });

    const projectRoutes = await Promise.all([
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/formal-input-approvals`, {
        method: "POST",
        token: evaluatorToken,
        body: { purpose: "g4_delivery" },
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/jobs`, {
        method: "POST",
        token: evaluatorToken,
        body: { run_class_intent: "formal", operation: "implement" },
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/gate-submissions/forged/approve`, {
        method: "POST",
        token: evaluatorToken,
        body: {},
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/tasks/${claim.taskId}/adoptions`, {
        method: "POST",
        token: evaluatorToken,
        body: {},
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/baselines`, {
        method: "GET",
        token: evaluatorToken,
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/bitstreams`, {
        method: "GET",
        token: evaluatorToken,
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${claim.projectId}/hardware/download`, {
        method: "POST",
        token: evaluatorToken,
        body: { tool_run_id: job.toolRunId },
      }),
    ]);
    expect(projectRoutes.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 404]);

    const genericEvidence = harness.client.query(
      `INSERT INTO evidence
        (id,tool_run_id,project_id,artifact_id,uri,sha256,size_bytes,media_type)
       VALUES ($1,$2,$3,$4,'content://forbidden',$4,1,'application/octet-stream')`,
      [`generic_evidence_${randomUUID()}`, job.toolRunId, claim.projectId, hash("generic")],
    );
    await expect(genericEvidence).rejects.toThrow();
    const genericManifest = harness.client.query(
      `INSERT INTO tool_run_evidence_manifest
        (id,project_id,tool_run_id,run_state,operation,run_class,manifest_hash,input_hash,
         toolchain_profile_hash,parser_version,verdicts,entry_count,generated_by_type,
         generated_by,sealed_at,frozen_at)
       SELECT $1,j.project_id,j.tool_run_id,'succeeded',j.operation,'evolution_eval',$2,
              j.input_manifest_hash,input.toolchain_profile_hash,'forbidden','{}'::jsonb,1,
              'service',$3,now(),now()
         FROM evolution_eval_job j
         JOIN evolution_eval_input input ON input.eval_input_ref=j.eval_input_ref
        WHERE j.id=$4`,
      [
        `generic_manifest_${randomUUID()}`,
        hash("manifest"),
        harness.ids.serviceUid,
        job.evalJobId,
      ],
    );
    await expect(genericManifest).rejects.toThrow();
    const forgedFormalBitstream = harness.client.query(
      `INSERT INTO bitstream_result
        (id,project_id,work_version_id,tool_run_id,evidence_manifest_id,
         evidence_manifest_hash,evidence_entry_name,class,formal_input_approval_id,
         snapshot_id,readiness_id,input_hash,engineering_config_hash,
         prerequisite_baseline_id,target_part,toolchain_profile_hash,constraint_hash,
         sha256,size_bytes,storage_uri,generated_by_type,generated_by,generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'trial.bit','formal',$7,$8,$9,$10,$11,$12,
               'xc7a35tcpg236-1',$13,$14,$15,4,'content://forbidden','service',$16,now())`,
      [
        `bitstream_forbidden_${randomUUID()}`,
        claim.projectId,
        `work_forbidden_${randomUUID()}`,
        job.toolRunId,
        `manifest_forbidden_${randomUUID()}`,
        hash("evidence-manifest"),
        `approval_forbidden_${randomUUID()}`,
        `snapshot_forbidden_${randomUUID()}`,
        `readiness_forbidden_${randomUUID()}`,
        claim.inputManifestHash,
        hash("engineering"),
        `baseline_forbidden_${randomUUID()}`,
        hash("toolchain"),
        hash("constraint"),
        hash("bitstream"),
        harness.ids.serviceUid,
      ],
    );
    await expect(forgedFormalBitstream).rejects.toThrow();
    const noAuthorityRows = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evidence WHERE tool_run_id=$1) AS evidence,
         (SELECT count(*)::int FROM tool_run_evidence_manifest WHERE tool_run_id=$1) AS manifests,
         (SELECT count(*)::int FROM bitstream_result WHERE tool_run_id=$1) AS bitstreams`,
      [job.toolRunId],
    );
    expect(noAuthorityRows.rows[0]).toEqual({ evidence: 0, manifests: 0, bitstreams: 0 });
    expect(connectorCalls).toBe(0);
  });

  test("R2-12 route aliases, query content and wrong methods remain nonexistent", async () => {
    const claim = await claimFixture(await seedClaimable("r2-aliases"));
    const job = await prepare(claim, "r2-alias-prepare");
    const path = jobPath(claim, job);
    const requests = [
      apiCall(harness.baseUrl, `${path}/submit?run_class=formal`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "r2-alias-query" },
        body: submitBody(claim, job),
      }),
      apiCall(harness.baseUrl, `${path}/submit`, { method: "GET", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${path}/status`, { method: "GET", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${path}/cancel`, { method: "DELETE", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${path}/evidence`, { method: "PUT", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${path}/evidence/read?name=run.log`, {
        method: "GET",
        token: evaluatorToken,
      }),
      apiCall(harness.baseUrl, `${path}/results`, { method: "GET", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${path}/workspace`, { method: "PATCH", token: evaluatorToken }),
      apiCall(harness.baseUrl, `/api/v1/internal/evolution/eval-jobs/${job.evalJobId}/status`, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: claim.leaseToken,
        },
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([400, 404, 404, 404, 404, 404, 404, 404, 404]);
    expect(responseError(responses[0]!.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    const unchanged = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT count(*)::int FROM evolution_eval_evidence_fact WHERE eval_job_id=$1) AS evidence,
         (SELECT count(*)::int FROM evolution_eval_idempotency
           WHERE eval_job_id=$1 AND action<>'prepare') AS r2_idempotency`,
      [job.evalJobId],
    );
    expect(unchanged.rows[0]).toEqual({ dispatches: 0, tombstones: 0, evidence: 0, r2_idempotency: 0 });
    expect(connectorCalls).toBe(0);
  });
});
