import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { FileEvolutionEvalLedger } from "../../connector/evolution-eval-ledger.ts";
import { sha256Hex } from "../src/hashing.ts";
import {
  EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES,
} from "../src/domain/evolution-eval-dispatcher.ts";
import { evolutionEvalCanonicalHash } from "../src/domain/evolution-eval.ts";
import {
  claimNextEvolutionEvalDuty,
  fenceEvolutionEvalDispatch,
  hasCurrentEvolutionEvalDutyLease,
  loadEvolutionEvalClaimedBinding,
  materializeEvolutionEvalDeadlineIntents,
  materializeEvolutionEvalRetentionIntents,
  processEvolutionEvalDuty,
  recordEvolutionEvalLedgerObservation,
  recoverEvolutionEvalEvidenceTemp,
  renewEvolutionEvalDutyLease,
  runEvolutionEvalDispatcherTick,
  settleEvolutionEvalLedgerObservation,
} from "../src/services/evolution-eval-dispatcher.ts";
import {
  evolutionEvalDiscardAuthorizationHash,
  type CoreIssuedEvalBinding,
  type EvalEvidenceCleanupRequestV1,
  type EvalLedgerQuery,
  type EvolutionEvalConnectorPort,
} from "../src/services/evolution-eval-connector-port.ts";
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
const AUTH_SOURCE = readFileSync(
  new URL("../src/api/auth.ts", import.meta.url),
  "utf8",
);
const ROUTER_SOURCE = readFileSync(
  new URL("../src/api/router.ts", import.meta.url),
  "utf8",
);
const DISPATCHER_MIGRATION_SOURCE = readFileSync(
  new URL("../src/db/migrations/0025_evolution_eval_dispatcher.sql", import.meta.url),
  "utf8",
);
const FRESH_SCHEMA_SOURCE = readFileSync(
  new URL("../src/db/schema.sql", import.meta.url),
  "utf8",
);
const ENABLED_FENCE_POLICY = Object.freeze({
  newEffectsEnabled: true,
  rolloutEnabled: true,
  spoolAvailable: true,
});

function databaseUrl(name: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

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
}

interface PreparedFixture {
  readonly evalJobId: string;
  readonly toolRunId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly workspaceManifestHash: string;
}

function ledgerObservation(
  binding: CoreIssuedEvalBinding,
  state: EvalLedgerQuery["state"],
): EvalLedgerQuery {
  const common = {
    schema: "evolution-eval-ledger-query.v1" as const,
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: "adversarial-epoch-1",
  };
  switch (state) {
    case "proven_never_accepted":
      return { ...common, state, replay_permitted: true };
    case "accepted":
      return {
        ...common,
        state,
        execution_state: "running",
        accepted_at: "2026-08-26T08:00:01.000Z",
      };
    case "terminal":
      return {
        ...common,
        state,
        terminal_state: "succeeded",
        process_stopped: true,
        terminal_at: "2026-08-26T08:00:02.000Z",
        error_code: null,
      };
    case "transient_unavailable":
      return {
        ...common,
        state,
        retryable: true,
        error_code: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
      };
    case "ambiguous":
      return {
        ...common,
        state,
        effect_possible: true,
        error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
      };
    case "ledger_corrupt":
      return {
        ...common,
        state,
        replay_permitted: false,
        error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT",
      };
  }
}

function spoolResult(
  binding: CoreIssuedEvalBinding,
  unackedBytes = 0,
): Awaited<ReturnType<EvolutionEvalConnectorPort["querySpool"]>> {
  return {
    schema: "evolution-eval-spool-result.v1",
    binding: structuredClone(binding),
    unackedBytes,
    hardCapBytes: 2_147_483_648,
  };
}

interface ConnectorDoubleOptions {
  readonly calls: string[];
  readonly query: EvolutionEvalConnectorPort["query"];
  readonly queryOrReserve?: EvolutionEvalConnectorPort["queryOrReserve"];
  readonly preflight?: EvolutionEvalConnectorPort["preflight"];
  readonly submit?: EvolutionEvalConnectorPort["submit"];
  readonly cancel?: EvolutionEvalConnectorPort["cancel"];
  readonly querySpool?: EvolutionEvalConnectorPort["querySpool"];
  readonly fetchEvidenceManifest?: EvolutionEvalConnectorPort["fetchEvidenceManifest"];
  readonly fetchEvidenceEntry?: EvolutionEvalConnectorPort["fetchEvidenceEntry"];
  readonly queryRetention?: EvolutionEvalConnectorPort["queryRetention"];
  readonly acknowledgeEvidence?: EvolutionEvalConnectorPort["acknowledgeEvidence"];
  readonly acknowledgeCorrupt?: EvolutionEvalConnectorPort["acknowledgeCorrupt"];
  readonly cleanupEvidence?: EvolutionEvalConnectorPort["cleanupEvidence"];
}

function connectorDouble(options: ConnectorDoubleOptions): EvolutionEvalConnectorPort {
  const unexpected = (operation: string): never => {
    throw new Error(`unexpected Connector ${operation}`);
  };
  return {
    async query(binding) {
      options.calls.push("query");
      return options.query(binding);
    },
    async queryOrReserve(binding) {
      options.calls.push("queryOrReserve");
      return options.queryOrReserve
        ? options.queryOrReserve(binding)
        : options.query(binding);
    },
    async preflight(binding) {
      options.calls.push("preflight");
      return options.preflight ? options.preflight(binding) : unexpected("preflight");
    },
    async submit(binding, input) {
      options.calls.push("submit");
      return options.submit ? options.submit(binding, input) : unexpected("submit");
    },
    async cancel(binding, reason) {
      options.calls.push("cancel");
      return options.cancel ? options.cancel(binding, reason) : unexpected("cancel");
    },
    async fetchEvidenceManifest(binding) {
      options.calls.push("fetchEvidenceManifest");
      return options.fetchEvidenceManifest
        ? options.fetchEvidenceManifest(binding)
        : unexpected("fetchEvidenceManifest");
    },
    async fetchEvidenceEntry(binding, name) {
      options.calls.push("fetchEvidenceEntry");
      return options.fetchEvidenceEntry
        ? options.fetchEvidenceEntry(binding, name)
        : unexpected("fetchEvidenceEntry");
    },
    async queryRetention(binding) {
      options.calls.push("queryRetention");
      return options.queryRetention
        ? options.queryRetention(binding)
        : unexpected("queryRetention");
    },
    async acknowledgeEvidence(request) {
      options.calls.push("acknowledgeEvidence");
      return options.acknowledgeEvidence
        ? options.acknowledgeEvidence(request)
        : unexpected("acknowledgeEvidence");
    },
    async acknowledgeCorrupt(request) {
      options.calls.push("acknowledgeCorrupt");
      return options.acknowledgeCorrupt
        ? options.acknowledgeCorrupt(request)
        : unexpected("acknowledgeCorrupt");
    },
    async cleanupEvidence(request) {
      options.calls.push("cleanupEvidence");
      return options.cleanupEvidence
        ? options.cleanupEvidence(request)
        : unexpected("cleanupEvidence");
    },
    async querySpool(binding) {
      options.calls.push("querySpool");
      return options.querySpool
        ? options.querySpool(binding)
        : spoolResult(binding);
    },
  };
}

describe("evolution-eval dispatcher has no consumer HTTP authority", () => {
  test("keeps the exact existing capability-token set and exposes no dispatcher route or scope", () => {
    const capabilityScopeBlock = AUTH_SOURCE.match(
      /const capabilityScopes = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1] ?? "";
    expect(capabilityScopeBlock).toContain('"core:evolution-eval"');
    expect(capabilityScopeBlock).not.toMatch(/dispatcher|consumer/i);
    expect(ROUTER_SOURCE).not.toMatch(/core:evolution-(?:dispatcher|consumer)/i);
    expect(ROUTER_SOURCE).not.toMatch(/internal\/evolution\/(?:dispatcher|consumer)/i);
  });

  test("keeps migration and fresh-schema dispatcher trust-plane definitions in parity", () => {
    expect(DISPATCHER_MIGRATION_SOURCE).toContain(
      "M4E_0017_REQUIRES_EMPTY_PRE_RELEASE_EVOLUTION_EVAL_DISPATCH",
    );
    expect(DISPATCHER_MIGRATION_SOURCE).toContain(
      "AND EXISTS (SELECT 1 FROM evolution_eval_dispatch)",
    );
    for (const source of [DISPATCHER_MIGRATION_SOURCE, FRESH_SCHEMA_SOURCE]) {
      expect(source).toContain("CREATE TABLE IF NOT EXISTS evolution_eval_dispatcher_lease");
      expect(source).toContain("CREATE TABLE IF NOT EXISTS evolution_eval_connector_observation");
      for (const eventType of EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES) {
        expect(source).toContain(`'${eventType}'`);
      }
      expect(source).toContain("lease_nonce_hash");
      expect(source).not.toMatch(/lease_nonce\s+uuid/);
      expect(source).not.toMatch(/dispatcher_(?:token|secret|password|source_bytes)/i);
    }
  });

  test("rejects an unbounded dispatcher tick before touching storage or Connector state", async () => {
    const unreachableClient = {
      async query(): Promise<never> {
        throw new Error("storage must not be touched");
      },
    } as unknown as Parameters<typeof runEvolutionEvalDispatcherTick>[0];
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async () => {
        throw new Error("Connector must not be touched");
      },
    });
    await expect(runEvolutionEvalDispatcherTick(unreachableClient, connector, {
      holderId: "adversarial-unbounded-tick",
      maxDuties: 101,
    })).rejects.toThrow("maxDuties must be between 1 and 100");
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!DATABASE_URL)("evolution-eval dispatcher PostgreSQL adversarial claim plane", () => {
  const databaseName = `synthia_m4e_dispatch_adversarial_${randomUUID().replaceAll("-", "")}`;
  const testDatabaseUrl = DATABASE_URL ? databaseUrl(databaseName) : "";
  let admin: Client;
  let client: Client;
  let harness: ApiHarness;
  let evaluatorToken = "";
  let curatorToken = "";
  let sequence = 0;

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  async function insertOutbox(options: {
    readonly eventType: string;
    readonly published?: boolean;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly occurredAt?: string;
    readonly connection?: Client;
    readonly aggregateId?: string;
    readonly projectId?: string;
  }): Promise<string> {
    const eventId = randomUUID();
    const ordinal = nextSequence();
    const writer = options.connection ?? client;
    const aggregateId = options.aggregateId ?? `aggregate-${ordinal}`;
    const eventSequence = options.aggregateId
      ? Number((await writer.query(
          `SELECT COALESCE(max(sequence),0)::int+1 AS sequence
             FROM outbox_events
            WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$1`,
          [aggregateId],
        )).rows[0]!.sequence)
      : ordinal;
    await writer.query(
      `INSERT INTO outbox_events
         (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
          headers,correlation_id,causation_id,classification,occurred_at,published_at)
       VALUES ($1,'evolution_eval_job',$2,$3,$4,$5,$6::jsonb,'{}'::jsonb,$7,NULL,'D1',
               COALESCE($8::timestamptz,clock_timestamp()),
               CASE WHEN $9::boolean THEN clock_timestamp() ELSE NULL END)`,
      [
        eventId,
        aggregateId,
        eventSequence,
        options.eventType,
        options.projectId ?? `project-${ordinal}`,
        JSON.stringify(options.payload ?? { fixture: ordinal }),
        `correlation-${ordinal}`,
        options.occurredAt ?? null,
        options.published === true,
      ],
    );
    return eventId;
  }

  async function publish(eventId: string): Promise<void> {
    await client.query(
      `UPDATE outbox_events
          SET published_at=clock_timestamp()
        WHERE event_id=$1 AND published_at IS NULL`,
      [eventId],
    );
  }

  async function seedClaimable(label: string): Promise<ClaimableFixture> {
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
    const sourcePath = "rtl/top.sv";
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

    await client.query("BEGIN");
    try {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO project
          (id,name,scope,project_type,process_version_id,process_profile_id,
           process_profile_version,process_profile_name,target_part,toolchain_profile_ref,status)
         VALUES ($1,$2,'','free',NULL,NULL,NULL,NULL,'xc7a35tcpg236-1',$3,'active')`,
        [projectId, `Eval ${suffix}`, hash(`toolchain:${suffix}`)],
      );
      await client.query(
        `INSERT INTO role_assignment(id,project_id,actor_type,actor_id,role,permissions)
         VALUES ($1,$2,'service',$3,'evolution-evaluator','{}'::jsonb)`,
        [`role_${suffix}`, projectId, harness.ids.serviceUid],
      );
      await client.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,reason,terminal_request_hash,
           terminal_result,created_by_type,created_by,completed_at)
         VALUES ($1,'run','completed',$1,$1,'version provenance',$2,$3::jsonb,
                 'service',$4,clock_timestamp())`,
        [
          originRunId,
          hash(`origin:${suffix}`),
          JSON.stringify({ schema: "curator-result.v1", run_id: originRunId }),
          harness.ids.serviceUid,
        ],
      );
      await client.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by)
         VALUES ($1,'run','queued',$1,$1,'dispatcher adversarial test','service',$2)`,
        [runId, harness.ids.serviceUid],
      );
      await client.query(
        `INSERT INTO learned_skill
          (id,slug,name,summary,applicability_summary,created_by_type,created_by)
         VALUES ($1,$2,'Timing recovery','Recover synthesis failures','FPGA synthesis',
                 'service',$3)`,
        [skillId, `skill-${suffix.replaceAll("_", "-")}`, harness.ids.serviceUid],
      );
      await client.query(
        `INSERT INTO learned_skill_version
          (id,skill_id,version_no,parent_version_id,description,applicability,
           outcome_contract,content_manifest_hash,scanner_version,scan_decision,
           scan_findings,curator_run_id,created_by_type,created_by)
         VALUES ($1,$2,1,NULL,'Typed synthesis recovery','{}'::jsonb,'{}'::jsonb,
                 $3,'test-scanner-v1','pass','[]'::jsonb,$4,'service',$5)`,
        [versionId, skillId, hash(`skill-manifest:${skillContent}`), originRunId, harness.ids.serviceUid],
      );
      await client.query(
        `INSERT INTO learned_skill_version_status(version_id,quality_state)
         VALUES ($1,'active_unproven')`,
        [versionId],
      );
      await client.query(
        `INSERT INTO learned_skill_file
          (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,'SKILL.md','skill_md',NULL,$3,$4,'text/markdown',$5)`,
        [skillFileId, versionId, hash(skillContent), Buffer.byteLength(skillContent), skillContent],
      );
      await client.query(
        "UPDATE learned_skill SET active_version_id=$2 WHERE id=$1",
        [skillId, versionId],
      );
      await client.query(
        `INSERT INTO agent_task
          (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
           process_instance_id,runtime_agent_id,runtime_actor_id,objective,
           authorization_scope,status,input_hash,adoption_state,created_by_type,created_by)
         VALUES ($1,$2,'free','main','project',NULL,NULL,NULL,$1,$3,
                 'project agent','{}'::jsonb,'running',$4,'not_applicable','service',$3)`,
        [parentTaskId, projectId, harness.ids.serviceUid, hash(`parent-input:${suffix}`)],
      );
      await client.query(
        `INSERT INTO agent_task
          (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
           process_instance_id,runtime_agent_id,runtime_actor_id,objective,
           authorization_scope,status,input_hash,output_hash,adoption_state,
           created_by_type,created_by,finished_at)
         VALUES ($1,$2,'free','side','side',$3,$4,NULL,$1,$5,
                 'fix synthesis','{}'::jsonb,'succeeded',$6,$7,'available',
                 'service',$5,clock_timestamp())`,
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
      await client.query(
        `INSERT INTO task_workspace
          (id,task_id,project_id,state,storage_key,base_commit,base_manifest_hash,
           head_commit,sealed_at)
         VALUES ($1,$2,$3,'sealed',$4,$5,$6,$7,clock_timestamp())`,
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
      await client.query(
        `INSERT INTO task_conversation_event
          (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id)
         VALUES ($1,$2,$3,1,'tool_call',$4::jsonb,$5,'service',$6)`,
        [
          `event_${suffix}`,
          projectId,
          taskId,
          JSON.stringify(eventPayload),
          hash(JSON.stringify(eventPayload)),
          harness.ids.serviceUid,
        ],
      );
      await client.query(
        `INSERT INTO task_workspace_file
          (id,task_id,project_id,workspace_id,path,artifact_type,change_kind,
           base_content_hash,content_hash,content_text,size_bytes,workspace_commit,version)
         VALUES ($1,$2,$3,$4,$5,'hdl','added',NULL,$6,$7,$8,$9,1)`,
        [
          `source_file_${suffix}`,
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
      await client.query(
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
      await client.query(
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
      await client.query(
        `INSERT INTO skill_application
          (id,project_id,task_id,observation_key,episode_id,local_goal,state,
           primary_tool_call_id,start_event_sequence,end_event_sequence,outcome_claim,
           human_corrections,evidence_refs,tool_run_refs,closed_at,created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,'synthesize the sealed FPGA snapshot','pending_evaluation',
                 $6,1,1,'synthesis fixed',0,'[]'::jsonb,'[]'::jsonb,clock_timestamp(),'service',$7)`,
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
      await client.query(
        `INSERT INTO skill_application_skill
          (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
         VALUES ($1,$2,$3,$4,'primary',$5,'["matching-failure"]'::jsonb)`,
        [`application_skill_${suffix}`, applicationId, skillId, versionId, `tool_call_${suffix}`],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
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

  async function claimFixture(fixture: ClaimableFixture): Promise<ClaimedFixture> {
    const response = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/claim-manual`,
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
    };
  }

  async function prepareAndSubmit(label: string): Promise<{
    readonly claim: ClaimedFixture;
    readonly job: PreparedFixture;
  }> {
    const claim = await claimFixture(await seedClaimable(label));
    const prepareResponse = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/prepare`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": `${label}-prepare` },
        body: {
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
        },
      },
    );
    expect(prepareResponse.status).toBe(201);
    const prepared = responseData(prepareResponse.json);
    const job: PreparedFixture = {
      evalJobId: String(prepared.eval_job_id),
      toolRunId: String(prepared.tool_run_id),
      workspaceId: String(prepared.workspace_id),
      workspaceRevision: Number(prepared.workspace_revision),
      workspaceManifestHash: String(prepared.workspace_manifest_hash),
    };
    const submitResponse = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${claim.runId}/eval-jobs/${job.evalJobId}/submit`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": `${label}-submit` },
        body: {
          schema: "evolution-eval-submit.v1",
          curator_lease_token: claim.leaseToken,
          workspace_id: job.workspaceId,
          expected_workspace_revision: job.workspaceRevision,
          expected_workspace_manifest_hash: job.workspaceManifestHash,
        },
      },
    );
    expect(submitResponse.status).toBe(202);
    return { claim, job };
  }

  async function prepareFreezeEvidenceDuty(label: string) {
    const fixture = await prepareAndSubmit(label);
    const dispatchLease = await claimDispatch(`dispatcher-${label}-dispatch`);
    const fenced = await fenceEvolutionEvalDispatch(
      client,
      dispatchLease,
      ENABLED_FENCE_POLICY,
    );
    expect(fenced.status).toBe("ready");
    if (fenced.status !== "ready") throw new Error("expected a ready effect fence");
    const terminal = ledgerObservation(fenced.binding, "terminal");
    const recorded = await recordEvolutionEvalLedgerObservation(
      client,
      dispatchLease,
      fenced.binding,
      terminal,
    );
    expect(await settleEvolutionEvalLedgerObservation(
      client,
      dispatchLease,
      fenced.binding,
      recorded,
    )).toMatchObject({ action: "settled", published: true, state: "succeeded" });
    const freezeLease = await claimNextEvolutionEvalDuty(client, {
      holderId: `dispatcher-${label}-freeze`,
      leaseNonce: randomUUID(),
    });
    expect(freezeLease).toMatchObject({
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: fixture.job.evalJobId,
    });
    return {
      ...fixture,
      binding: fenced.binding,
      terminal,
      freezeLease: freezeLease!,
    };
  }

  async function prepareFrozenEvidence(label: string) {
    const fixture = await prepareFreezeEvidenceDuty(label);
    const connectorManifestPreimage = {
      schema: "evolution-eval-connector-evidence-manifest.v1" as const,
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      connector_job_id: fixture.binding.dispatch.connector_job_id,
      dispatch_request_hash: fixture.binding.dispatch_request_hash,
      entries: [],
    };
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async () => fixture.terminal,
      fetchEvidenceManifest: async () => ({
        ...connectorManifestPreimage,
        manifest_hash: evolutionEvalCanonicalHash(connectorManifestPreimage),
      }),
    });
    const tempRoot = await mkdtemp(join(tmpdir(), "synthia-e3-evidence-test-"));
    try {
      expect(await processEvolutionEvalDuty(client, connector, fixture.freezeLease, {
        evidenceTempRoot: tempRoot,
      })).toMatchObject({ outcome: "settled", state: "frozen" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
    expect(calls).toEqual(["fetchEvidenceManifest"]);
    const facts = await client.query(
      `SELECT fact_type,fact_hash,manifest_hash,connector_manifest_hash,outbox_event_id
         FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('frozen','ack_pending')`,
      [fixture.job.evalJobId],
    );
    const byType = new Map(facts.rows.map((row) => [String(row.fact_type), row]));
    expect(byType.has("frozen")).toBe(true);
    expect(byType.has("ack_pending")).toBe(true);
    return {
      ...fixture,
      frozen: byType.get("frozen")!,
      ackPending: byType.get("ack_pending")!,
    };
  }

  async function insertDirectEvidenceFact(options: {
    readonly evalJobId: string;
    readonly factType: "acknowledged" | "cleaned";
    readonly factHash: string;
    readonly manifestHash: string | null;
  }): Promise<void> {
    const context = await client.query(
      `SELECT job.curator_run_id,job.project_id,job.operation,tool.correlation_id
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
        WHERE job.id=$1`,
      [options.evalJobId],
    );
    const row = context.rows[0]!;
    const auditId = `direct_audit_${randomUUID().replaceAll("-", "")}`;
    const factId = `direct_fact_${randomUUID().replaceAll("-", "")}`;
    const outboxId = randomUUID();
    const eventType = `evolution_eval.evidence.${options.factType}`;
    const payload = {
      fact_id: factId,
      fact_type: options.factType,
      fact_hash: options.factHash,
      ...(options.manifestHash === null
        ? {}
        : { manifest_hash: options.manifestHash }),
    };
    await client.query(
      `INSERT INTO evolution_eval_audit_event
        (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
         correlation_id,operation,request_hash,evidence_manifest_hash)
       VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$8,$9,$10)`,
      [
        auditId,
        row.curator_run_id,
        options.evalJobId,
        row.project_id,
        `evidence.${options.factType}`,
        "service:direct-sql-adversary",
        row.correlation_id,
        row.operation,
        options.factHash,
        options.manifestHash,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
         headers,correlation_id,causation_id,classification)
       VALUES ($1,'evolution_eval_job',$2,
         (SELECT COALESCE(max(sequence),0)+1 FROM outbox_events
           WHERE aggregate_type='evolution_eval_job' AND aggregate_id=$2),
         $3,$4,$5::jsonb,'{}'::jsonb,$6,NULL,'D1')`,
      [
        outboxId,
        options.evalJobId,
        eventType,
        row.project_id,
        JSON.stringify(payload),
        row.correlation_id,
      ],
    );
    await client.query(
      `INSERT INTO evolution_eval_evidence_fact
        (id,eval_job_id,fact_type,manifest_hash,fact_hash,audit_event_id,outbox_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        factId,
        options.evalJobId,
        options.factType,
        options.manifestHash,
        options.factHash,
        auditId,
        outboxId,
      ],
    );
  }

  async function claimDispatch(holderId: string) {
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId,
      leaseNonce: randomUUID(),
    });
    expect(lease?.eventType).toBe("evolution_eval.dispatch_requested");
    return lease!;
  }

  async function prepareReconcileDuty(label: string) {
    const fixture = await prepareAndSubmit(label);
    const dispatchLease = await claimDispatch(`dispatcher-${label}-dispatch`);
    const fenced = await fenceEvolutionEvalDispatch(
      client,
      dispatchLease,
      ENABLED_FENCE_POLICY,
    );
    expect(fenced.status).toBe("ready");
    if (fenced.status !== "ready") throw new Error("expected a ready effect fence");
    const transient = await recordEvolutionEvalLedgerObservation(
      client,
      dispatchLease,
      fenced.binding,
      ledgerObservation(fenced.binding, "transient_unavailable"),
    );
    expect(await settleEvolutionEvalLedgerObservation(
      client,
      dispatchLease,
      fenced.binding,
      transient,
    )).toMatchObject({ action: "wait", published: false, state: "running" });
    await publish(dispatchLease.eventId);
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: `dispatcher-${label}-reconcile`,
      leaseNonce: randomUUID(),
    });
    expect(lease).toMatchObject({
      eventType: "evolution_eval.reconcile_requested",
      aggregateId: fixture.job.evalJobId,
    });
    const binding = await loadEvolutionEvalClaimedBinding(client, lease!);
    return { ...fixture, lease: lease!, binding };
  }

  async function prepareTombstoneDuty(label: string) {
    const fixture = await prepareAndSubmit(label);
    const dispatchLease = await claimDispatch(`dispatcher-${label}-dispatch`);
    const fenced = await fenceEvolutionEvalDispatch(
      client,
      dispatchLease,
      ENABLED_FENCE_POLICY,
    );
    expect(fenced.status).toBe("ready");
    if (fenced.status !== "ready") throw new Error("expected a ready effect fence");
    const cancelled = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${fixture.claim.runId}/eval-jobs/${fixture.job.evalJobId}/cancel`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": `${label}-cancel` },
        body: {
          schema: "evolution-eval-cancel.v1",
          curator_lease_token: fixture.claim.leaseToken,
          reason_code: "OPERATOR_REQUEST",
        },
      },
    );
    expect(cancelled.status).toBe(202);
    await publish(dispatchLease.eventId);
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: `dispatcher-${label}-tombstone`,
      leaseNonce: randomUUID(),
    });
    expect(lease).toMatchObject({
      eventType: "evolution_eval.dispatch_tombstoned",
      aggregateId: fixture.job.evalJobId,
    });
    const binding = await loadEvolutionEvalClaimedBinding(client, lease!);
    return { ...fixture, lease: lease!, binding };
  }

  async function prepareDeadlineTombstoneDuty(label: string) {
    const fixture = await prepareAndSubmit(label);
    const dispatchLease = await claimDispatch(`dispatcher-${label}-dispatch`);
    expect(await fenceEvolutionEvalDispatch(
      client,
      dispatchLease,
      ENABLED_FENCE_POLICY,
    )).toMatchObject({ status: "ready", newlyFenced: true });
    await client.query(
      `UPDATE synthia_test_clock
          SET now_value=(
            SELECT run.deadline_at+interval '1 second'
              FROM evolution_eval_run run
             WHERE run.curator_run_id=$1
          )
        WHERE singleton=true`,
      [fixture.claim.runId],
    );
    expect(await materializeEvolutionEvalDeadlineIntents(client, 100)).toBeGreaterThanOrEqual(1);
    const tombstone = await client.query(
      `SELECT reason_code,outbox_event_id FROM evolution_eval_dispatch_tombstone
        WHERE eval_job_id=$1`,
      [fixture.job.evalJobId],
    );
    expect(tombstone.rows[0]).toEqual({
      reason_code: "EVOLUTION_EVAL_DEADLINE_CANCEL_REQUESTED",
      outbox_event_id: expect.any(String),
    });
    await publish(dispatchLease.eventId);
    // The authoritative scanner is intentionally global. Older effect-possible
    // fixtures can acquire their own deadline duties in this same pass; consume
    // those unrelated test duties so this helper claims its exact aggregate.
    await client.query(
      `UPDATE outbox_events SET published_at=clock_timestamp()
        WHERE published_at IS NULL AND event_id<>$1
          AND event_type=ANY($2::text[])`,
      [tombstone.rows[0]!.outbox_event_id, EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES],
    );
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: `dispatcher-${label}-deadline-tombstone`,
      leaseNonce: randomUUID(),
    });
    expect(lease).toMatchObject({
      eventType: "evolution_eval.dispatch_tombstoned",
      aggregateId: fixture.job.evalJobId,
    });
    const binding = await loadEvolutionEvalClaimedBinding(client, lease!);
    return { ...fixture, lease: lease!, binding };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await admin.query(`ALTER DATABASE ${databaseName} SET search_path TO public, pg_catalog`);
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

    harness = await setupApiHarness(testDatabaseUrl, {
      features: { selfEvolution: true, evolutionEvalExecution: true },
    });
    client = harness.client;
    const identity = await client.query(
      "SELECT id FROM user_account WHERE uid=$1",
      [harness.ids.serviceUid],
    );
    const userId = String(identity.rows[0]!.id);
    evaluatorToken = randomBytes(32).toString("hex");
    curatorToken = randomBytes(32).toString("hex");
    await client.query(
      `INSERT INTO auth_token(token_hash,user_id,scope) VALUES
       ($1,$3,ARRAY['core:evolution-eval']),
       ($2,$3,ARRAY['core:evolution-curator'])`,
      [hash(evaluatorToken), hash(curatorToken), userId],
    );
    // These tests isolate the generic dispatch claim plane. Evolution outbox
    // rows normally have same-transaction typed owners, covered by the M4-D
    // invariant suite; disabling only its deferred owner check lets the fixture
    // create all seven event kinds without duplicating every domain aggregate.
    await client.query(
      "ALTER TABLE outbox_events DISABLE TRIGGER evolution_eval_outbox_commit_guard",
    );
  }, 30_000);

  afterEach(async () => {
    await client.query("UPDATE synthia_test_clock SET now_value=NULL WHERE singleton=true");
    await client.query(
      `UPDATE outbox_events
          SET published_at=clock_timestamp()
        WHERE published_at IS NULL AND event_type LIKE 'evolution_eval.%'`,
    );
  }, 30_000);

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  }, 30_000);

  test("claims the exact seven-event allowlist and ignores prefix lookalikes", async () => {
    const expectedIds = new Map<string, string>();
    for (const eventType of EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES) {
      expectedIds.set(eventType, await insertOutbox({ eventType }));
    }
    await insertOutbox({ eventType: "evolution_eval.dispatch_requested.extra" });
    await insertOutbox({ eventType: "tool_run.dispatch_requested" });

    const claimed: string[] = [];
    for (let index = 0; index < EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES.length; index += 1) {
      const lease = await claimNextEvolutionEvalDuty(client, {
        holderId: `dispatcher-${index}`,
        leaseNonce: randomUUID(),
      });
      expect(lease).not.toBeNull();
      expect(lease!.eventId).toBe(expectedIds.get(lease!.eventType));
      claimed.push(lease!.eventType);
    }
    expect(new Set(claimed)).toEqual(new Set(EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES));
    expect(await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-after-allowlist",
      leaseNonce: randomUUID(),
    })).toBeNull();
  });

  test("claims only committed unpublished events", async () => {
    const writer = new Client({ connectionString: testDatabaseUrl });
    await writer.connect();
    try {
      await insertOutbox({
        eventType: "evolution_eval.dispatch_requested",
        published: true,
        occurredAt: "2026-08-26T07:59:00.000Z",
      });
      await insertOutbox({
        eventType: "evolution_eval.dispatch_requested.extra",
        occurredAt: "2026-08-26T07:59:01.000Z",
      });
      const committedId = await insertOutbox({
        eventType: "evolution_eval.dispatch_requested",
        occurredAt: "2026-08-26T07:59:03.000Z",
      });

      await writer.query("BEGIN");
      await insertOutbox({
        connection: writer,
        eventType: "evolution_eval.dispatch_requested",
        occurredAt: "2026-08-26T07:59:02.000Z",
      });

      const lease = await claimNextEvolutionEvalDuty(client, {
        holderId: "dispatcher-committed-only",
        leaseNonce: randomUUID(),
      });
      expect(lease?.eventId).toBe(committedId);
      await writer.query("ROLLBACK");
      await publish(committedId);
      expect(await claimNextEvolutionEvalDuty(client, {
        holderId: "dispatcher-no-more-work",
        leaseNonce: randomUUID(),
      })).toBeNull();
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await writer.end();
    }
  });

  test("commits a content-free lease before returning it to another connection", async () => {
    const secret = "raw-source-and-bearer-must-not-enter-the-lease";
    const eventId = await insertOutbox({
      eventType: "evolution_eval.dispatch_requested",
      payload: {
        dispatch_request_hash: "a".repeat(64),
        forbidden_secret_fixture: secret,
      },
    });
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-commit-observer",
      leaseNonce: randomUUID(),
    });
    expect(lease?.eventId).toBe(eventId);

    const observer = new Client({ connectionString: testDatabaseUrl });
    await observer.connect();
    try {
      const visible = await observer.query(
        `SELECT to_jsonb(lease)::text AS body
           FROM evolution_eval_dispatcher_lease lease
          WHERE event_id=$1`,
        [eventId],
      );
      expect(visible.rows).toHaveLength(1);
      expect(String(visible.rows[0]?.body)).not.toContain(secret);
      expect(String(visible.rows[0]?.body)).not.toContain("forbidden_secret_fixture");
      expect(String(visible.rows[0]?.body)).not.toContain(lease!.leaseNonce);
      expect(String(visible.rows[0]?.body)).toContain(hash(lease!.leaseNonce));
      expect(await hasCurrentEvolutionEvalDutyLease(observer, lease!)).toBe(true);
    } finally {
      await observer.end();
    }
  });

  test("expired reclaim rotates the nonce and permanently rejects the old holder", async () => {
    const eventId = await insertOutbox({
      eventType: "evolution_eval.reconcile_requested",
    });
    const first = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-old-holder",
      leaseMs: 1_000,
      leaseNonce: randomUUID(),
    });
    expect(first?.eventId).toBe(eventId);
    await client.query(
      `UPDATE evolution_eval_dispatcher_lease
          SET lease_expires_at=claimed_at+interval '1 millisecond'
        WHERE event_id=$1`,
      [eventId],
    );
    const second = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-new-holder",
      leaseMs: 30_000,
      leaseNonce: randomUUID(),
    });

    expect(second?.eventId).toBe(eventId);
    expect(second?.leaseNonce).not.toBe(first?.leaseNonce);
    expect(second?.attemptCount).toBe(2);
    expect(await renewEvolutionEvalDutyLease(client, first!)).toBeNull();
    expect(await hasCurrentEvolutionEvalDutyLease(client, first!)).toBe(false);
    expect(await hasCurrentEvolutionEvalDutyLease(client, second!)).toBe(true);
  });

  test("rejects a direct dispatcher lease longer than the five-minute authority cap", async () => {
    const eventId = await insertOutbox({
      eventType: "evolution_eval.reconcile_requested",
    });
    const claimedAt = new Date("2026-08-26T08:00:00.000Z");
    await expect(client.query(
      `INSERT INTO evolution_eval_dispatcher_lease
        (event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
         lease_expires_at,attempt_count,claimed_at,updated_at)
       SELECT event_id,event_type,aggregate_id,'direct-overlong-lease',$2,
              $3::timestamptz,1,$4::timestamptz,$4::timestamptz
         FROM outbox_events WHERE event_id=$1`,
      [
        eventId,
        hash("direct-overlong-lease-nonce"),
        new Date(claimedAt.getTime() + 300_001),
        claimedAt,
      ],
    )).rejects.toThrow();
    const durable = await client.query(
      "SELECT count(*)::int AS count FROM evolution_eval_dispatcher_lease WHERE event_id=$1",
      [eventId],
    );
    expect(durable.rows[0]).toEqual({ count: 0 });
  });

  test("binds temp cleanup ownership to the exact current claim and keeps ownership append-only", async () => {
    const first = await prepareAndSubmit("temp-cleanup-owner-first");
    const second = await prepareAndSubmit("temp-cleanup-owner-second");
    const firstDispatch = await claimDispatch("dispatcher-temp-cleanup-dispatch-first");
    const secondDispatch = await claimDispatch("dispatcher-temp-cleanup-dispatch-second");
    await publish(firstDispatch.eventId);
    await publish(secondDispatch.eventId);
    const firstEventId = await insertOutbox({
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: first.job.evalJobId,
      projectId: first.claim.projectId,
    });
    const secondEventId = await insertOutbox({
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: second.job.evalJobId,
      projectId: second.claim.projectId,
    });
    const firstLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-temp-cleanup-owner-first",
      leaseNonce: randomUUID(),
    });
    const secondLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-temp-cleanup-owner-second",
      leaseNonce: randomUUID(),
    });
    expect(firstLease).toMatchObject({
      eventId: firstEventId,
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: first.job.evalJobId,
    });
    expect(secondLease).toMatchObject({
      eventId: secondEventId,
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: second.job.evalJobId,
    });

    const insertOwner = async (options: {
      readonly evalJobId: string;
      readonly outboxEventId: string;
      readonly leaseNonceHash: string;
      readonly leaseAttemptCount: number;
      readonly ownerId: string;
      readonly pathHash: string;
    }) => client.query(
      `INSERT INTO evolution_eval_temp_cleanup_owner
        (id,eval_job_id,outbox_event_id,lease_nonce_hash,lease_attempt_count,
         owner_id,temp_path_hash,cleanup_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '5 minutes')`,
      [
        randomUUID(),
        options.evalJobId,
        options.outboxEventId,
        options.leaseNonceHash,
        options.leaseAttemptCount,
        options.ownerId,
        options.pathHash,
      ],
    );
    const invalidBindings: PromiseSettledResult<unknown>[] = [];
    for (const options of [
      {
        evalJobId: first.job.evalJobId,
        outboxEventId: firstLease!.eventId,
        leaseNonceHash: hash(firstLease!.leaseNonce),
        leaseAttemptCount: firstLease!.attemptCount,
        ownerId: "not-the-current-holder",
        pathHash: hash("temp-owner-wrong-holder"),
      },
      {
        evalJobId: first.job.evalJobId,
        outboxEventId: firstLease!.eventId,
        leaseNonceHash: hash("stale-or-invented-lease-nonce"),
        leaseAttemptCount: firstLease!.attemptCount,
        ownerId: firstLease!.holderId,
        pathHash: hash("temp-owner-wrong-nonce"),
      },
      {
        evalJobId: second.job.evalJobId,
        outboxEventId: firstLease!.eventId,
        leaseNonceHash: hash(firstLease!.leaseNonce),
        leaseAttemptCount: firstLease!.attemptCount,
        ownerId: firstLease!.holderId,
        pathHash: hash("temp-owner-cross-job"),
      },
    ]) {
      try {
        await insertOwner(options);
        invalidBindings.push({ status: "fulfilled", value: undefined });
      } catch (reason) {
        invalidBindings.push({ status: "rejected", reason });
      }
    }
    expect(invalidBindings.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);

    const validId = randomUUID();
    await client.query(
      `INSERT INTO evolution_eval_temp_cleanup_owner
        (id,eval_job_id,outbox_event_id,lease_nonce_hash,lease_attempt_count,
         owner_id,temp_path_hash,cleanup_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '5 minutes')`,
      [
        validId,
        first.job.evalJobId,
        firstLease!.eventId,
        hash(firstLease!.leaseNonce),
        firstLease!.attemptCount,
        firstLease!.holderId,
        hash("temp-owner-valid"),
      ],
    );
    const mutations: PromiseSettledResult<unknown>[] = [];
    for (const mutation of [
      () => client.query(
        "UPDATE evolution_eval_temp_cleanup_owner SET owner_id='mutated-owner' WHERE id=$1",
        [validId],
      ),
      () => client.query(
        "DELETE FROM evolution_eval_temp_cleanup_owner WHERE id=$1",
        [validId],
      ),
    ]) {
      try {
        await mutation();
        mutations.push({ status: "fulfilled", value: undefined });
      } catch (reason) {
        mutations.push({ status: "rejected", reason });
      }
    }
    expect(mutations.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const durable = await client.query(
      `SELECT eval_job_id,outbox_event_id,lease_nonce_hash,owner_id
         FROM evolution_eval_temp_cleanup_owner WHERE id=$1`,
      [validId],
    );
    expect(durable.rows[0]).toEqual({
      eval_job_id: first.job.evalJobId,
      outbox_event_id: firstLease!.eventId,
      lease_nonce_hash: hash(firstLease!.leaseNonce),
      owner_id: firstLease!.holderId,
    });
  });

  test("tick recovery removes only due hash-owned temp directories after the lease expires", async () => {
    const fixture = await prepareAndSubmit("temp-recovery-tick");
    const dispatchLease = await claimDispatch("dispatcher-temp-recovery-dispatch");
    await publish(dispatchLease.eventId);
    const eventId = await insertOutbox({
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: fixture.job.evalJobId,
      projectId: fixture.claim.projectId,
    });
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-temp-recovery-owner",
      leaseNonce: randomUUID(),
    });
    expect(lease).toMatchObject({ eventId, aggregateId: fixture.job.evalJobId });

    const root = await mkdtemp(join(tmpdir(), "synthia-e3-temp-recovery-"));
    try {
      const canonicalRoot = await realpath(root);
      const ownedPath = await mkdtemp(join(canonicalRoot, "fetch-"));
      const unknownPath = join(canonicalRoot, "fetch-unknown");
      const symlinkPath = join(canonicalRoot, "fetch-symlink");
      await mkdir(unknownPath);
      await writeFile(join(unknownPath, "keep.txt"), "do not delete\n");
      await symlink(unknownPath, symlinkPath);
      const ownerId = randomUUID();
      await client.query(
        `INSERT INTO evolution_eval_temp_cleanup_owner
          (id,eval_job_id,outbox_event_id,lease_nonce_hash,lease_attempt_count,
           owner_id,temp_path_hash,cleanup_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 millisecond')`,
        [
          ownerId,
          fixture.job.evalJobId,
          lease!.eventId,
          hash(lease!.leaseNonce),
          lease!.attemptCount,
          lease!.holderId,
          hash(ownedPath),
        ],
      );
      expect(await recoverEvolutionEvalEvidenceTemp(client, root, 10)).toBe(0);
      expect((await lstat(ownedPath)).isDirectory()).toBe(true);

      const leaseTime = await client.query(
        "SELECT lease_expires_at FROM evolution_eval_dispatcher_lease WHERE event_id=$1",
        [eventId],
      );
      await client.query(
        "UPDATE synthia_test_clock SET now_value=$1::timestamptz+interval '1 second' WHERE singleton=true",
        [leaseTime.rows[0]!.lease_expires_at],
      );
      await publish(eventId);
      const calls: string[] = [];
      const tick = await runEvolutionEvalDispatcherTick(
        client,
        connectorDouble({
          calls,
          query: async () => {
            throw new Error("recovery-only tick must not query Connector");
          },
        }),
        {
          holderId: "dispatcher-temp-recovery-tick",
          maxDuties: 1,
          materializeDeadlines: false,
          materializeRetention: false,
          evidenceTempRoot: root,
        },
      );
      expect(tick).toMatchObject({
        claimed: 0,
        tempDirectoriesRecovered: 1,
      });
      expect(calls).toEqual([]);
      await expect(lstat(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(unknownPath)).isDirectory()).toBe(true);
      expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
      const owner = await client.query(
        "SELECT cleaned_at FROM evolution_eval_temp_cleanup_owner WHERE id=$1",
        [ownerId],
      );
      expect(owner.rows[0]!.cleaned_at).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects direct acknowledged facts or orphan receipts and accepts only the atomic receipt-backed path", async () => {
    const fixture = await prepareFrozenEvidence("retention-ack-receipt-guard");
    const ackLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-retention-ack-receipt-guard",
      leaseNonce: randomUUID(),
    });
    expect(ackLease).toMatchObject({
      eventType: "evolution_eval.evidence.ack_requested",
      aggregateId: fixture.job.evalJobId,
    });
    const manifestHash = String(fixture.frozen.manifest_hash);

    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await insertDirectEvidenceFact({
      evalJobId: fixture.job.evalJobId,
      factType: "acknowledged",
      factHash: hash("direct-acknowledged-without-receipt"),
      manifestHash,
    });
    await expect(client.query("COMMIT")).rejects.toThrow(
      "same-transaction Connector receipt",
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO evolution_eval_retention_receipt
        (id,eval_job_id,receipt_type,connector_state,authorization_hash,
         connector_fact_hash,outbox_event_id,holder_id,lease_nonce_hash,
         lease_attempt_count)
       VALUES ($1,$2,'acknowledgement','acknowledged',$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        fixture.job.evalJobId,
        fixture.ackPending.fact_hash,
        hash("orphan-connector-ack-receipt"),
        ackLease!.eventId,
        ackLease!.holderId,
        hash(ackLease!.leaseNonce),
        ackLease!.attemptCount,
      ],
    );
    await expect(client.query("COMMIT")).rejects.toThrow(
      "same-transaction terminal fact",
    );
    await client.query("ROLLBACK");

    const connectorAckFactHash = hash("connector-ack-receipt");
    const calls: string[] = [];
    const terminal = ledgerObservation(fixture.binding, "terminal");
    expect(await processEvolutionEvalDuty(
      client,
      connectorDouble({
        calls,
        query: async () => terminal,
        queryRetention: async () => ({
          schema: "evolution-eval-retention-result.v1",
          binding: fixture.binding,
          state: "pending_ack",
          retryable: false,
          authorization_kind: null,
          authorization_hash: null,
          connector_fact_hash: null,
          source_authorization_kind: null,
          source_authorization_hash: null,
          source_connector_fact_hash: null,
          physical_deleted: false,
          error_code: null,
        }),
        acknowledgeEvidence: async (request) => ({
          schema: "evolution-eval-retention-result.v1",
          binding: fixture.binding,
          state: "acknowledged",
          retryable: false,
          authorization_kind: "ack",
          authorization_hash: request.core_ack_fact_hash,
          connector_fact_hash: connectorAckFactHash,
          source_authorization_kind: null,
          source_authorization_hash: null,
          source_connector_fact_hash: null,
          physical_deleted: false,
          error_code: null,
        }),
      }),
      ackLease!,
    )).toMatchObject({ outcome: "settled", state: "acknowledged" });
    expect(calls).toEqual(["query", "queryRetention", "acknowledgeEvidence"]);
    const durable = await client.query(
      `SELECT fact.evolution_origin_txid AS fact_xid,
              receipt.evolution_origin_txid AS receipt_xid,
              receipt.authorization_hash,receipt.connector_fact_hash
         FROM evolution_eval_evidence_fact fact
         JOIN evolution_eval_retention_receipt receipt
           ON receipt.eval_job_id=fact.eval_job_id
          AND receipt.receipt_type='acknowledgement'
        WHERE fact.eval_job_id=$1 AND fact.fact_type='acknowledged'`,
      [fixture.job.evalJobId],
    );
    expect(durable.rows[0]).toEqual({
      fact_xid: durable.rows[0]!.fact_xid,
      receipt_xid: durable.rows[0]!.fact_xid,
      authorization_hash: fixture.ackPending.fact_hash,
      connector_fact_hash: connectorAckFactHash,
    });
  });

  test("rejects direct cleaned facts and persists the exact cleanup source chain", async () => {
    const fixture = await prepareFrozenEvidence("retention-cleanup-receipt-guard");
    const ackLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-retention-cleanup-ack",
      leaseNonce: randomUUID(),
    });
    const connectorAckFactHash = hash("cleanup-chain-connector-ack");
    const terminal = ledgerObservation(fixture.binding, "terminal");
    const ackConnector = connectorDouble({
      calls: [],
      query: async () => terminal,
      queryRetention: async () => ({
        schema: "evolution-eval-retention-result.v1",
        binding: fixture.binding,
        state: "pending_ack",
        retryable: false,
        authorization_kind: null,
        authorization_hash: null,
        connector_fact_hash: null,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        physical_deleted: false,
        error_code: null,
      }),
      acknowledgeEvidence: async (request) => ({
        schema: "evolution-eval-retention-result.v1",
        binding: fixture.binding,
        state: "acknowledged",
        retryable: false,
        authorization_kind: "ack",
        authorization_hash: request.core_ack_fact_hash,
        connector_fact_hash: connectorAckFactHash,
        source_authorization_kind: null,
        source_authorization_hash: null,
        source_connector_fact_hash: null,
        physical_deleted: false,
        error_code: null,
      }),
    });
    expect(await processEvolutionEvalDuty(client, ackConnector, ackLease!))
      .toMatchObject({ outcome: "settled", state: "acknowledged" });
    const cleanupLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-retention-cleanup",
      leaseNonce: randomUUID(),
    });
    expect(cleanupLease).toMatchObject({
      eventType: "evolution_eval.evidence.cleanup_requested",
      aggregateId: fixture.job.evalJobId,
    });
    const cleanupPending = (await client.query(
      `SELECT fact_hash FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type='cleanup_pending'`,
      [fixture.job.evalJobId],
    )).rows[0]!;

    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await insertDirectEvidenceFact({
      evalJobId: fixture.job.evalJobId,
      factType: "cleaned",
      factHash: hash("direct-cleaned-without-receipt"),
      manifestHash: null,
    });
    await expect(client.query("COMMIT")).rejects.toThrow(
      "same-transaction Connector receipt",
    );
    await client.query("ROLLBACK");

    const connectorCleanupFactHash = hash("connector-cleanup-receipt");
    const calls: string[] = [];
    expect(await processEvolutionEvalDuty(
      client,
      connectorDouble({
        calls,
        query: async () => terminal,
        queryRetention: async () => ({
          schema: "evolution-eval-retention-result.v1",
          binding: fixture.binding,
          state: "acknowledged",
          retryable: false,
          authorization_kind: "ack",
          authorization_hash: fixture.ackPending.fact_hash,
          connector_fact_hash: connectorAckFactHash,
          source_authorization_kind: null,
          source_authorization_hash: null,
          source_connector_fact_hash: null,
          physical_deleted: false,
          error_code: null,
        }),
        cleanupEvidence: async (request) => ({
          schema: "evolution-eval-retention-result.v1",
          binding: fixture.binding,
          state: "cleaned",
          retryable: false,
          authorization_kind: "cleanup",
          authorization_hash: request.core_cleanup_fact_hash,
          connector_fact_hash: connectorCleanupFactHash,
          source_authorization_kind: "ack",
          source_authorization_hash: fixture.ackPending.fact_hash,
          source_connector_fact_hash: connectorAckFactHash,
          physical_deleted: true,
          error_code: null,
        }),
      }),
      cleanupLease!,
    )).toMatchObject({ outcome: "settled", state: "cleaned" });
    expect(calls).toEqual(["query", "queryRetention", "cleanupEvidence"]);
    const durable = await client.query(
      `SELECT fact.evolution_origin_txid AS fact_xid,
              receipt.evolution_origin_txid AS receipt_xid,
              receipt.authorization_hash,receipt.connector_fact_hash,
              receipt.source_authorization_kind,receipt.source_authorization_hash,
              receipt.source_connector_fact_hash
         FROM evolution_eval_evidence_fact fact
         JOIN evolution_eval_retention_receipt receipt
           ON receipt.eval_job_id=fact.eval_job_id
          AND receipt.receipt_type='cleanup'
        WHERE fact.eval_job_id=$1 AND fact.fact_type='cleaned'`,
      [fixture.job.evalJobId],
    );
    expect(durable.rows[0]).toEqual({
      fact_xid: durable.rows[0]!.fact_xid,
      receipt_xid: durable.rows[0]!.fact_xid,
      authorization_hash: cleanupPending.fact_hash,
      connector_fact_hash: connectorCleanupFactHash,
      source_authorization_kind: "ack",
      source_authorization_hash: fixture.ackPending.fact_hash,
      source_connector_fact_hash: connectorAckFactHash,
    });
  });

  test("turns deterministic remote stream corruption immutable but retries remote unavailability", async () => {
    const run = async (
      label: string,
      remoteCode: "EVIDENCE_CORRUPT" | "REMOTE_UNAVAILABLE",
    ) => {
      const fixture = await prepareFreezeEvidenceDuty(label);
      const declared = new Uint8Array([1, 2, 3]);
      const entries = [{
        name: "report.json",
        sha256: hash(declared),
        size_bytes: declared.byteLength,
        media_type: "application/json" as const,
        artifact_classification: "evolution_eval_evidence" as const,
        usage_classification: "evolution_eval_only" as const,
      }];
      const preimage = {
        schema: "evolution-eval-connector-evidence-manifest.v1" as const,
        eval_job_id: fixture.binding.dispatch.eval_job_id,
        connector_job_id: fixture.binding.dispatch.connector_job_id,
        dispatch_request_hash: fixture.binding.dispatch_request_hash,
        entries,
      };
      const calls: string[] = [];
      const connector = connectorDouble({
        calls,
        query: async () => fixture.terminal,
        fetchEvidenceManifest: async () => ({
          ...preimage,
          manifest_hash: evolutionEvalCanonicalHash(preimage),
        }),
        fetchEvidenceEntry: async () => (async function* () {
          yield declared.subarray(0, 1);
          throw Object.assign(new Error(remoteCode), {
            code: remoteCode,
            retryable: remoteCode === "REMOTE_UNAVAILABLE",
          });
        })(),
      });
      const root = await mkdtemp(join(tmpdir(), "synthia-e3-remote-corrupt-"));
      try {
        const result = await processEvolutionEvalDuty(
          client,
          connector,
          fixture.freezeLease,
          { evidenceTempRoot: root },
        );
        const durable = await client.query(
          `SELECT fact_type,error_code FROM evolution_eval_evidence_fact
            WHERE eval_job_id=$1 ORDER BY fact_type`,
          [fixture.job.evalJobId],
        );
        const event = await client.query(
          "SELECT published_at FROM outbox_events WHERE event_id=$1",
          [fixture.freezeLease.eventId],
        );
        return { fixture, result, durable: durable.rows, event: event.rows[0], calls };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    const corrupt = await run("remote-stream-corrupt", "EVIDENCE_CORRUPT");
    expect(corrupt.result).toMatchObject({ outcome: "settled", state: "corrupt" });
    expect(corrupt.durable).toEqual([
      { fact_type: "cleanup_pending", error_code: null },
      { fact_type: "corrupt", error_code: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" },
      { fact_type: "freeze_pending", error_code: null },
      { fact_type: "quarantine_pending", error_code: null },
    ]);
    expect(corrupt.event!.published_at).not.toBeNull();
    expect(corrupt.calls).toEqual(["fetchEvidenceManifest", "fetchEvidenceEntry"]);
    await client.query(
      `UPDATE outbox_events SET published_at=clock_timestamp()
        WHERE aggregate_id=$1 AND published_at IS NULL`,
      [corrupt.fixture.job.evalJobId],
    );

    const unavailable = await run("remote-stream-unavailable", "REMOTE_UNAVAILABLE");
    expect(unavailable.result).toMatchObject({ outcome: "waiting", state: "succeeded" });
    expect(unavailable.durable).toEqual([
      { fact_type: "freeze_pending", error_code: null },
    ]);
    expect(unavailable.event!.published_at).toBeNull();
    const reconciliation = await client.query(
      "SELECT reconciliation_state FROM evolution_eval_job WHERE id=$1",
      [unavailable.fixture.job.evalJobId],
    );
    expect(reconciliation.rows[0]).toEqual({ reconciliation_state: "not_needed" });
    const projected = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${unavailable.fixture.claim.runId}`
        + `/eval-jobs/${unavailable.fixture.job.evalJobId}/status`,
      {
        method: "POST",
        token: evaluatorToken,
        body: {
          schema: "evolution-eval-status-request.v1",
          curator_lease_token: unavailable.fixture.claim.leaseToken,
        },
      },
    );
    expect(projected.status).toBe(200);
    expect(responseData(projected.json)).toMatchObject({
      evidence_state: "freeze_pending",
      reconciliation_state: "required",
    });
    const fail = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${unavailable.fixture.claim.runId}/fail`,
      {
        method: "POST",
        token: curatorToken,
        body: {
          lease_token: unavailable.fixture.claim.leaseToken,
          error_code: "CURATOR_EVALUATION_FAILED",
          retryable: false,
          details_hash: hash("transport-freeze-fail"),
        },
      },
    );
    expect(fail.status).toBe(409);
    expect(record(record(fail.json).error).code).toBe(
      "EVOLUTION_EVAL_RECONCILIATION_REQUIRED",
    );
  });

  test("query-first absent retention still installs the Core deadline discard fence", async () => {
    const fixture = await prepareDeadlineTombstoneDuty("deadline-absent-retention");
    const accepted = ledgerObservation(fixture.binding, "accepted");
    const terminal = ledgerObservation(fixture.binding, "terminal");
    const cancelConnector = connectorDouble({
      calls: [],
      query: async () => accepted,
      cancel: async () => terminal,
    });
    expect(await processEvolutionEvalDuty(
      client,
      cancelConnector,
      fixture.lease,
    )).toMatchObject({ outcome: "settled", state: "succeeded" });
    expect(await materializeEvolutionEvalDeadlineIntents(client, 100))
      .toBeGreaterThanOrEqual(1);
    await client.query(
      `UPDATE outbox_events SET published_at=clock_timestamp()
        WHERE aggregate_id=$1 AND event_type='evolution_eval.reconcile_requested'
          AND published_at IS NULL`,
      [fixture.job.evalJobId],
    );

    const freezeLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-deadline-absent-freeze-noop",
      leaseNonce: randomUUID(),
    });
    expect(freezeLease).toMatchObject({
      eventType: "evolution_eval.evidence.freeze_requested",
      aggregateId: fixture.job.evalJobId,
    });
    const noCallConnector = connectorDouble({
      calls: [],
      query: async () => {
        throw new Error("unavailable conclusion must close freeze before Connector I/O");
      },
    });
    expect(await processEvolutionEvalDuty(client, noCallConnector, freezeLease!))
      .toMatchObject({ outcome: "settled", state: null });

    const cleanupLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-deadline-absent-cleanup",
      leaseNonce: randomUUID(),
    });
    expect(cleanupLease).toMatchObject({
      eventType: "evolution_eval.evidence.cleanup_requested",
      aggregateId: fixture.job.evalJobId,
    });
    let cleanupRequest: EvalEvidenceCleanupRequestV1 | null = null;
    const connectorCleanupFactHash = hash("deadline-absent-cleanup-receipt");
    expect(await processEvolutionEvalDuty(
      client,
      connectorDouble({
        calls: [],
        query: async () => terminal,
        queryRetention: async () => ({
          schema: "evolution-eval-retention-result.v1",
          binding: fixture.binding,
          state: "absent",
          retryable: false,
          authorization_kind: null,
          authorization_hash: null,
          connector_fact_hash: null,
          source_authorization_kind: null,
          source_authorization_hash: null,
          source_connector_fact_hash: null,
          physical_deleted: false,
          error_code: null,
        }),
        cleanupEvidence: async (request) => {
          cleanupRequest = request;
          if (request.mode !== "core_discard") {
            throw new Error("expected a Core discard request");
          }
          return {
            schema: "evolution-eval-retention-result.v1",
            binding: fixture.binding,
            state: "cleaned",
            retryable: false,
            authorization_kind: "cleanup",
            authorization_hash: request.core_cleanup_fact_hash,
            connector_fact_hash: connectorCleanupFactHash,
            source_authorization_kind: "discard",
            source_authorization_hash: request.discard_authorization_hash,
            source_connector_fact_hash: hash("deadline-absent-discard-receipt"),
            physical_deleted: true,
            error_code: null,
          };
        },
      }),
      cleanupLease!,
    )).toMatchObject({ outcome: "settled", state: "cleaned" });
    expect(cleanupRequest).toMatchObject({
      mode: "core_discard",
      reason: "unavailable_at_deadline",
      core_conclusion_fact_hash: evolutionEvalCanonicalHash({
        schema: "evolution-eval-evidence-deadline.v1",
        eval_job_id: fixture.job.evalJobId,
        deadline_at: fixture.binding.dispatch.deadline_at,
        error_code: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE",
      }),
    });
    expect(cleanupRequest).not.toHaveProperty("core_manifest_hash");
    const facts = await client.query(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type IN ('unavailable_at_deadline','cleaned')
        ORDER BY fact_type`,
      [fixture.job.evalJobId],
    );
    expect(facts.rows).toEqual([
      { fact_type: "cleaned" },
      { fact_type: "unavailable_at_deadline" },
    ]);
  });

  test("late Core absolute cleanup converges after Connector physical expiry", async () => {
    const fixture = await prepareFrozenEvidence("absolute-expiry-late-core-cleanup");
    const terminalTime = await client.query(
      "SELECT end_time FROM tool_run WHERE id=$1",
      [fixture.job.toolRunId],
    );
    const terminalAt = new Date(terminalTime.rows[0]!.end_time);
    await client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [new Date(terminalAt.getTime() + 8 * 24 * 60 * 60 * 1000)],
    );
    expect(await materializeEvolutionEvalRetentionIntents(client, 100))
      .toBeGreaterThanOrEqual(1);

    const obsoleteAckLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-absolute-expiry-obsolete-ack",
      leaseNonce: randomUUID(),
    });
    expect(obsoleteAckLease).toMatchObject({
      eventType: "evolution_eval.evidence.ack_requested",
      aggregateId: fixture.job.evalJobId,
    });
    expect(await processEvolutionEvalDuty(
      client,
      connectorDouble({
        calls: [],
        query: async () => {
          throw new Error("expired Core ack duty must settle before Connector I/O");
        },
      }),
      obsoleteAckLease!,
    )).toMatchObject({ outcome: "settled", state: null });

    const cleanupLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-absolute-expiry-cleanup",
      leaseNonce: randomUUID(),
    });
    expect(cleanupLease).toMatchObject({
      eventType: "evolution_eval.evidence.cleanup_requested",
      aggregateId: fixture.job.evalJobId,
    });
    const expiredFact = (await client.query(
      `SELECT fact_hash FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 AND fact_type='expired'`,
      [fixture.job.evalJobId],
    )).rows[0]!;
    let cleanupRequest: EvalEvidenceCleanupRequestV1 | null = null;
    const terminal = ledgerObservation(fixture.binding, "terminal");
    expect(await processEvolutionEvalDuty(
      client,
      connectorDouble({
        calls: [],
        query: async () => terminal,
        queryRetention: async () => ({
          schema: "evolution-eval-retention-result.v1",
          binding: fixture.binding,
          state: "expired",
          retryable: false,
          authorization_kind: "expiry",
          authorization_hash: hash("connector-expiry-authorization"),
          connector_fact_hash: hash("connector-expiry-receipt"),
          source_authorization_kind: null,
          source_authorization_hash: null,
          source_connector_fact_hash: null,
          physical_deleted: true,
          error_code: null,
        }),
        cleanupEvidence: async (request) => {
          cleanupRequest = request;
          if (request.mode !== "core_discard") {
            throw new Error("expected absolute Core discard");
          }
          return {
            schema: "evolution-eval-retention-result.v1",
            binding: fixture.binding,
            state: "cleaned",
            retryable: false,
            authorization_kind: "cleanup",
            authorization_hash: request.core_cleanup_fact_hash,
            connector_fact_hash: hash("absolute-cleanup-receipt"),
            source_authorization_kind: "discard",
            source_authorization_hash: request.discard_authorization_hash,
            source_connector_fact_hash: hash("absolute-discard-receipt"),
            physical_deleted: true,
            error_code: null,
          };
        },
      }),
      cleanupLease!,
    )).toMatchObject({ outcome: "settled", state: "cleaned" });
    expect(cleanupRequest).toEqual({
      schema: "evolution-eval-evidence-cleanup-request.v1",
      binding: fixture.binding,
      mode: "core_discard",
      reason: "absolute_expiry",
      core_manifest_hash: fixture.frozen.manifest_hash,
      core_conclusion_fact_hash: expiredFact.fact_hash,
      core_cleanup_fact_hash: cleanupRequest!.core_cleanup_fact_hash,
      discard_authorization_hash: evolutionEvalDiscardAuthorizationHash(
        fixture.binding,
        {
          reason: "absolute_expiry",
          connectorManifestHash: String(fixture.frozen.connector_manifest_hash),
          terminalAt: terminalAt.toISOString(),
        },
      ),
    });
  });

  test("claim and lease renewal never publish an event without a durable duty result", async () => {
    const eventId = await insertOutbox({
      eventType: "evolution_eval.evidence.freeze_requested",
    });
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-unsettled",
      leaseNonce: randomUUID(),
    });
    expect(lease?.eventId).toBe(eventId);
    expect(await renewEvolutionEvalDutyLease(client, lease!)).not.toBeNull();
    const event = await client.query(
      "SELECT published_at FROM outbox_events WHERE event_id=$1",
      [eventId],
    );
    expect(event.rows[0]?.published_at).toBeNull();
  });

  test("makes the running fence and all three transition audits visible before a Connector spy can run", async () => {
    const { job } = await prepareAndSubmit("fence-commit-before-rpc");
    const lease = await claimDispatch("dispatcher-fence-commit");
    const fenced = await fenceEvolutionEvalDispatch(client, lease, ENABLED_FENCE_POLICY);
    expect(fenced).toMatchObject({ status: "ready", newlyFenced: true });

    const calls: string[] = [];
    const connectorSpy = async (): Promise<void> => {
      calls.push("query");
      const observer = new Client({ connectionString: testDatabaseUrl });
      await observer.connect();
      try {
        const visible = await observer.query(
          `SELECT tool.state::text AS state,
                  (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                    WHERE fact.eval_job_id=job.id) AS transitions,
                  (SELECT count(*)::int FROM evolution_eval_audit_event audit
                    WHERE audit.eval_job_id=job.id
                      AND audit.event_type='tool_run_transition') AS audits
             FROM evolution_eval_job job
             JOIN tool_run tool ON tool.id=job.tool_run_id
            WHERE job.id=$1`,
          [job.evalJobId],
        );
        expect(visible.rows[0]).toEqual({ state: "running", transitions: 3, audits: 3 });
      } finally {
        await observer.end();
      }
    };
    await connectorSpy();
    expect(calls).toEqual(["query"]);
  });

  test("rejects an expired old attempt and lets only the reclaimed nonce establish the fence", async () => {
    const { job } = await prepareAndSubmit("old-attempt-fence");
    const oldLease = await claimDispatch("dispatcher-old-fence");
    await client.query(
      `UPDATE evolution_eval_dispatcher_lease
          SET lease_expires_at=claimed_at+interval '1 millisecond'
        WHERE event_id=$1`,
      [oldLease.eventId],
    );
    const currentLease = await claimDispatch("dispatcher-current-fence");
    await expect(fenceEvolutionEvalDispatch(client, oldLease, ENABLED_FENCE_POLICY)).rejects.toThrow(
      "EVOLUTION_EVAL_DISPATCHER_LEASE_LOST",
    );
    expect(await fenceEvolutionEvalDispatch(client, currentLease, ENABLED_FENCE_POLICY)).toMatchObject({
      status: "ready",
      newlyFenced: true,
    });
    const state = await client.query(
      `SELECT tool.state::text AS state,
              (SELECT count(*)::int FROM evolution_eval_transition_fact
                WHERE eval_job_id=$1) AS transitions
         FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(state.rows[0]).toEqual({ state: "running", transitions: 3 });
  });

  test("fails closed when the claimed event payload no longer binds the sealed dispatch hash", async () => {
    const { job } = await prepareAndSubmit("event-hash-mismatch");
    const lease = await claimDispatch("dispatcher-event-mismatch");
    await client.query(
      "ALTER TABLE outbox_events DISABLE TRIGGER evolution_eval_outbox_mutation_guard",
    );
    try {
      await client.query(
        "UPDATE outbox_events SET payload=$2::jsonb WHERE event_id=$1",
        [lease.eventId, JSON.stringify({ dispatch_request_hash: "0".repeat(64) })],
      );
    } finally {
      await client.query(
        "ALTER TABLE outbox_events ENABLE TRIGGER evolution_eval_outbox_mutation_guard",
      );
    }
    expect(await fenceEvolutionEvalDispatch(client, lease, ENABLED_FENCE_POLICY)).toEqual({
      status: "no_op",
      reason: "event_mismatch",
    });
    const facts = await client.query(
      `SELECT tool.state::text AS state,
              (SELECT count(*)::int FROM evolution_eval_transition_fact
                WHERE eval_job_id=$1) AS transitions
         FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(facts.rows[0]).toEqual({ state: "submitted", transitions: 0 });
  });

  test("tombstone and fence serialize in both winner orders without a second effect fence", async () => {
    const tombstoneFirst = await prepareAndSubmit("tombstone-first");
    const tombstoneLease = await claimDispatch("dispatcher-tombstone-first");
    const cancelled = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${tombstoneFirst.claim.runId}/eval-jobs/${tombstoneFirst.job.evalJobId}/cancel`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "tombstone-first-cancel" },
        body: {
          schema: "evolution-eval-cancel.v1",
          curator_lease_token: tombstoneFirst.claim.leaseToken,
          reason_code: "OPERATOR_REQUEST",
        },
      },
    );
    expect(cancelled.status).toBe(200);
    expect(await fenceEvolutionEvalDispatch(client, tombstoneLease, ENABLED_FENCE_POLICY)).toEqual({
      status: "no_op",
      reason: "tombstoned",
    });

    // Retire both duties created by the first fixture so claim order for the
    // second fixture does not depend on timestamps from a different job.
    await publish(tombstoneLease.eventId);
    const firstTombstone = await client.query(
      "SELECT outbox_event_id FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1",
      [tombstoneFirst.job.evalJobId],
    );
    expect(firstTombstone.rows).toHaveLength(1);
    await publish(String(firstTombstone.rows[0]!.outbox_event_id));
    const fenceFirst = await prepareAndSubmit("fence-first");
    const fenceLease = await claimDispatch("dispatcher-fence-first");
    expect(await fenceEvolutionEvalDispatch(client, fenceLease, ENABLED_FENCE_POLICY)).toMatchObject({
      status: "ready",
      newlyFenced: true,
    });
    const cancelAfterFence = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${fenceFirst.claim.runId}/eval-jobs/${fenceFirst.job.evalJobId}/cancel`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "fence-first-cancel" },
        body: {
          schema: "evolution-eval-cancel.v1",
          curator_lease_token: fenceFirst.claim.leaseToken,
          reason_code: "OPERATOR_REQUEST",
        },
      },
    );
    expect(cancelAfterFence.status).toBe(202);
    expect(await fenceEvolutionEvalDispatch(client, fenceLease, ENABLED_FENCE_POLICY)).toEqual({
      status: "no_op",
      reason: "tombstoned",
    });
    const states = await client.query(
      `SELECT job.id,tool.state::text AS state,
              (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                WHERE fact.eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
        WHERE job.id=ANY($1::text[]) ORDER BY job.id`,
      [[tombstoneFirst.job.evalJobId, fenceFirst.job.evalJobId]],
    );
    expect(states.rows.map((row) => ({ state: row.state, transitions: row.transitions })))
      .toEqual(expect.arrayContaining([
        { state: "rejected", transitions: 1 },
        { state: "running", transitions: 3 },
      ]));
  });

  test("recovers pre-fence and post-fence crashes by reclaiming the same event identity", async () => {
    const preFence = await prepareAndSubmit("pre-fence-crash");
    const preCrashLease = await claimDispatch("dispatcher-pre-crash");
    await client.query(
      "UPDATE evolution_eval_dispatcher_lease SET lease_expires_at=claimed_at+interval '1 millisecond' WHERE event_id=$1",
      [preCrashLease.eventId],
    );
    const preRecoveryLease = await claimDispatch("dispatcher-pre-recovery");
    expect(await fenceEvolutionEvalDispatch(client, preRecoveryLease, ENABLED_FENCE_POLICY)).toMatchObject({
      status: "ready",
      newlyFenced: true,
    });
    await publish(preRecoveryLease.eventId);

    const postFence = await prepareAndSubmit("post-fence-crash");
    const postCrashLease = await claimDispatch("dispatcher-post-crash");
    expect(await fenceEvolutionEvalDispatch(client, postCrashLease, ENABLED_FENCE_POLICY)).toMatchObject({
      status: "ready",
      newlyFenced: true,
    });
    await client.query(
      "UPDATE evolution_eval_dispatcher_lease SET lease_expires_at=claimed_at+interval '1 millisecond' WHERE event_id=$1",
      [postCrashLease.eventId],
    );
    const postRecoveryLease = await claimDispatch("dispatcher-post-recovery");
    expect(await fenceEvolutionEvalDispatch(client, postRecoveryLease, ENABLED_FENCE_POLICY)).toMatchObject({
      status: "ready",
      newlyFenced: false,
    });
    const facts = await client.query(
      `SELECT eval_job_id,count(*)::int AS count
         FROM evolution_eval_transition_fact
        WHERE eval_job_id=ANY($1::text[])
        GROUP BY eval_job_id ORDER BY eval_job_id`,
      [[preFence.job.evalJobId, postFence.job.evalJobId]],
    );
    expect(facts.rows.map((row) => row.count)).toEqual([3, 3]);
  });

  test("deadline wins before the effect fence and leaves the dispatch unpublished for durable handling", async () => {
    const { job } = await prepareAndSubmit("deadline-before-fence");
    const deadline = await client.query(
      "SELECT deadline_at FROM evolution_eval_job WHERE id=$1",
      [job.evalJobId],
    );
    const afterDeadline = new Date(new Date(deadline.rows[0]!.deadline_at).getTime() + 1_000);
    await client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [afterDeadline],
    );
    const lease = await claimDispatch("dispatcher-deadline");
    // The scanner is intentionally global and may also materialize earlier
    // effect-possible fixtures once this deterministic clock crosses their
    // deadlines. The assertions below prove this fixture was included.
    expect(await materializeEvolutionEvalDeadlineIntents(client)).toBeGreaterThanOrEqual(1);
    expect(await fenceEvolutionEvalDispatch(client, lease, ENABLED_FENCE_POLICY)).toEqual({
      status: "no_op",
      reason: "tombstoned",
    });
    const projection = await client.query(
      `SELECT tool.state::text AS state,outbox.published_at,
              (SELECT count(*)::int FROM evolution_eval_transition_fact
                WHERE eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(projection.rows[0]).toEqual({
      state: "rejected",
      published_at: null,
      transitions: 1,
    });
  });

  test("materializes a running-job tombstone at the exact deadline without guessing terminal state", async () => {
    const { job } = await prepareAndSubmit("running-exact-deadline");
    const initialLease = await claimDispatch("dispatcher-running-exact-deadline-initial");
    expect(await fenceEvolutionEvalDispatch(
      client,
      initialLease,
      ENABLED_FENCE_POLICY,
    )).toMatchObject({ status: "ready", newlyFenced: true });
    await client.query(
      `UPDATE synthia_test_clock
          SET now_value=(
            SELECT run.deadline_at
              FROM evolution_eval_run run
              JOIN evolution_eval_job job ON job.curator_run_id=run.curator_run_id
             WHERE job.id=$1
          )
        WHERE singleton=true`,
      [job.evalJobId],
    );

    expect(await materializeEvolutionEvalDeadlineIntents(client, 100)).toBeGreaterThanOrEqual(1);
    const atBoundary = await client.query(
      `SELECT tool.state::text AS state,job.reconciliation_state,
              run.unknown_effect_latched_at,dispatch_outbox.published_at,
              tombstone_outbox.published_at AS tombstone_published_at,
              (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                WHERE fact.eval_job_id=job.id) AS transitions,
              (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone tombstone
                WHERE tombstone.eval_job_id=job.id) AS tombstones
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events dispatch_outbox ON dispatch_outbox.event_id=dispatch.outbox_event_id
         JOIN evolution_eval_dispatch_tombstone tombstone ON tombstone.eval_job_id=job.id
         JOIN outbox_events tombstone_outbox ON tombstone_outbox.event_id=tombstone.outbox_event_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(atBoundary.rows[0]).toEqual({
      state: "running",
      reconciliation_state: "not_needed",
      unknown_effect_latched_at: null,
      published_at: null,
      tombstone_published_at: null,
      transitions: 3,
      tombstones: 1,
    });

    const recoveryLease = await claimDispatch("dispatcher-running-exact-deadline-recovery");
    expect(recoveryLease).toMatchObject({
      eventId: initialLease.eventId,
      attemptCount: initialLease.attemptCount + 1,
    });
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async () => {
        throw new Error("deadline tombstone must make the stale dispatch a DB-only no-op");
      },
    });
    expect(await processEvolutionEvalDuty(client, connector, recoveryLease, {
      allowNewEffects: true,
      rolloutEnabled: true,
    })).toEqual({
      eventId: recoveryLease.eventId,
      duty: "dispatch",
      outcome: "settled",
      state: "running",
    });
    expect(calls).toEqual([]);
  });

  test("published duties are permanent no-ops and cannot be fenced afterward", async () => {
    const { job } = await prepareAndSubmit("published-before-fence");
    const lease = await claimDispatch("dispatcher-published");
    await publish(lease.eventId);
    expect(await fenceEvolutionEvalDispatch(client, lease, ENABLED_FENCE_POLICY)).toEqual({
      status: "no_op",
      reason: "published",
    });
    const state = await client.query(
      `SELECT tool.state::text AS state,
              (SELECT count(*)::int FROM evolution_eval_transition_fact
                WHERE eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(state.rows[0]).toEqual({ state: "submitted", transitions: 0 });
  });

  const settlementCases = [
    {
      state: "proven_never_accepted",
      fence: false,
      action: "replay",
      published: false,
      projectedState: "submitted",
    },
    {
      state: "accepted",
      fence: true,
      action: "settled",
      published: true,
      projectedState: "running",
    },
    {
      state: "terminal",
      fence: true,
      action: "settled",
      published: true,
      projectedState: "succeeded",
    },
    {
      state: "transient_unavailable",
      fence: true,
      action: "wait",
      published: false,
      projectedState: "running",
    },
    {
      state: "ambiguous",
      fence: true,
      action: "wait",
      published: false,
      projectedState: "running",
    },
    {
      state: "ledger_corrupt",
      fence: true,
      action: "settled",
      published: true,
      projectedState: "unknown_effect",
    },
  ] as const;

  for (const scenario of settlementCases) {
    test(`settles ${scenario.state} with its frozen publication semantics`, async () => {
      const { job } = await prepareAndSubmit(`settle-${scenario.state}`);
      const lease = await claimDispatch(`dispatcher-settle-${scenario.state}`);
      let binding: CoreIssuedEvalBinding;
      if (scenario.fence) {
        const fenced = await fenceEvolutionEvalDispatch(client, lease, ENABLED_FENCE_POLICY);
        expect(fenced.status).toBe("ready");
        if (fenced.status !== "ready") throw new Error("expected a ready effect fence");
        binding = fenced.binding;
      } else {
        binding = await loadEvolutionEvalClaimedBinding(client, lease);
      }
      const observation = ledgerObservation(binding, scenario.state);
      const recorded = await recordEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        observation,
      );
      expect(recorded.replayed).toBe(false);
      const duplicate = await recordEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        observation,
      );
      expect(duplicate).toMatchObject({ id: recorded.id, replayed: true });

      const settled = await settleEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        recorded,
      );
      expect(settled).toMatchObject({
        action: scenario.action,
        published: scenario.published,
        state: scenario.projectedState,
        observationId: recorded.id,
      });
      const durable = await client.query(
        `SELECT tool.state::text AS state,outbox.published_at IS NOT NULL AS published,
                (SELECT count(*)::int FROM evolution_eval_connector_observation observation
                  WHERE observation.eval_job_id=job.id
                    AND observation.outbox_event_id=outbox.event_id) AS observations
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
           JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(durable.rows[0]).toEqual({
        state: scenario.projectedState,
        published: scenario.published,
        observations: 1,
      });
    });
  }

  const reconcileSettlementCases = [
    {
      state: "proven_never_accepted",
      action: "rejected",
      published: true,
      projectedState: "failed",
      reconciliationState: "confirmed",
    },
    {
      state: "accepted",
      action: "settled",
      published: true,
      projectedState: "running",
      reconciliationState: "confirmed",
    },
    {
      state: "terminal",
      action: "settled",
      published: true,
      projectedState: "succeeded",
      reconciliationState: "confirmed",
    },
    {
      state: "transient_unavailable",
      action: "wait",
      published: false,
      projectedState: "running",
      reconciliationState: "required",
    },
    {
      state: "ambiguous",
      action: "wait",
      published: false,
      projectedState: "running",
      reconciliationState: "required",
    },
    {
      state: "ledger_corrupt",
      action: "settled",
      published: true,
      projectedState: "unknown_effect",
      reconciliationState: "confirmed",
    },
  ] as const;

  for (const scenario of reconcileSettlementCases) {
    test(`settles reconcile × ${scenario.state} with the event-specific result`, async () => {
      const { job, lease, binding } = await prepareReconcileDuty(
        `matrix-reconcile-${scenario.state}`,
      );
      const recorded = await recordEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        ledgerObservation(binding, scenario.state),
      );
      expect(await settleEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        recorded,
      )).toMatchObject({
        action: scenario.action,
        published: scenario.published,
        state: scenario.projectedState,
      });
      const projection = await client.query(
        `SELECT tool.state::text AS state,job.reconciliation_state,
                outbox.published_at IS NOT NULL AS published
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN outbox_events outbox ON outbox.event_id=$2
          WHERE job.id=$1`,
        [job.evalJobId, lease.eventId],
      );
      expect(projection.rows[0]).toEqual({
        state: scenario.projectedState,
        reconciliation_state: scenario.reconciliationState,
        published: scenario.published,
      });
    });
  }

  const tombstoneSettlementCases = [
    {
      state: "proven_never_accepted",
      action: "rejected",
      published: true,
      projectedState: "failed",
    },
    {
      state: "accepted",
      action: "cancel",
      published: false,
      projectedState: "running",
    },
    {
      state: "terminal",
      action: "settled",
      published: true,
      projectedState: "succeeded",
    },
    {
      state: "transient_unavailable",
      action: "cancel",
      published: false,
      projectedState: "running",
    },
    {
      state: "ambiguous",
      action: "cancel",
      published: false,
      projectedState: "running",
    },
    {
      state: "ledger_corrupt",
      action: "settled",
      published: true,
      projectedState: "unknown_effect",
    },
  ] as const;

  for (const scenario of tombstoneSettlementCases) {
    test(`settles tombstone × ${scenario.state} with the event-specific result`, async () => {
      const { job, lease, binding } = await prepareTombstoneDuty(
        `matrix-tombstone-${scenario.state}`,
      );
      const recorded = await recordEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        ledgerObservation(binding, scenario.state),
      );
      expect(await settleEvolutionEvalLedgerObservation(
        client,
        lease,
        binding,
        recorded,
      )).toMatchObject({
        action: scenario.action,
        published: scenario.published,
        state: scenario.projectedState,
      });
      const projection = await client.query(
        `SELECT tool.state::text AS state,outbox.published_at IS NOT NULL AS published
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN outbox_events outbox ON outbox.event_id=$2
          WHERE job.id=$1`,
        [job.evalJobId, lease.eventId],
      );
      expect(projection.rows[0]).toEqual({
        state: scenario.projectedState,
        published: scenario.published,
      });
    });
  }

  const processCancelMatrixStates = [
    "accepted",
    "transient_unavailable",
    "ambiguous",
  ] as const;
  for (const initialState of processCancelMatrixStates) {
    for (const cancelState of processCancelMatrixStates) {
      test(`keeps ordinary tombstone cancel uncertainty recoverable for ${initialState} × ${cancelState}`, async () => {
        const label = `ordinary-cancel-matrix-${initialState}-${cancelState}`;
        const { job, lease } = await prepareTombstoneDuty(label);
        const calls: string[] = [];
        const cancelReasons: string[] = [];
        const connector = connectorDouble({
          calls,
          query: async (binding) => ledgerObservation(binding, initialState),
          cancel: async (binding, reason) => {
            cancelReasons.push(reason);
            return ledgerObservation(binding, cancelState);
          },
        });

        expect(await processEvolutionEvalDuty(client, connector, lease)).toEqual({
          eventId: lease.eventId,
          duty: "tombstone",
          outcome: "waiting",
          state: "running",
        });
        expect(calls).toEqual(["query", "cancel"]);
        expect(cancelReasons).toEqual(["tombstoned"]);
        const durable = await client.query(
          `SELECT tool.state::text AS state,job.reconciliation_state,
                  run.unknown_effect_latched_at,outbox.published_at,
                  tombstone.reason_code,
                  (SELECT array_agg(observation.observation_type ORDER BY observation.observation_type)
                     FROM evolution_eval_connector_observation observation
                    WHERE observation.eval_job_id=job.id
                      AND observation.outbox_event_id=outbox.event_id) AS observation_types
             FROM evolution_eval_job job
             JOIN tool_run tool ON tool.id=job.tool_run_id
             JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
             JOIN evolution_eval_dispatch_tombstone tombstone ON tombstone.eval_job_id=job.id
             JOIN outbox_events outbox ON outbox.event_id=tombstone.outbox_event_id
            WHERE job.id=$1`,
          [job.evalJobId],
        );
        const expectedObservationTypes = initialState === cancelState
          ? [initialState]
          : [initialState, cancelState].sort();
        expect(durable.rows[0]).toEqual({
          state: "running",
          reconciliation_state: "required",
          unknown_effect_latched_at: null,
          published_at: null,
          reason_code: "OPERATOR_REQUEST",
          observation_types: expectedObservationTypes,
        });
        await client.query(
          `UPDATE outbox_events SET published_at=clock_timestamp()
            WHERE aggregate_id=$1 AND published_at IS NULL`,
          [job.evalJobId],
        );
      }, 30_000);
    }
  }

  for (const initialState of processCancelMatrixStates) {
    for (const cancelState of processCancelMatrixStates) {
      test(`closes deadline tombstone uncertainty for ${initialState} × ${cancelState}`, async () => {
        const label = `deadline-cancel-matrix-${initialState}-${cancelState}`;
        const { job, lease } = await prepareDeadlineTombstoneDuty(label);
        const calls: string[] = [];
        const cancelReasons: string[] = [];
        const connector = connectorDouble({
          calls,
          query: async (binding) => ledgerObservation(binding, initialState),
          cancel: async (binding, reason) => {
            cancelReasons.push(reason);
            return ledgerObservation(binding, cancelState);
          },
        });

        expect(await processEvolutionEvalDuty(client, connector, lease)).toEqual({
          eventId: lease.eventId,
          duty: "tombstone",
          outcome: "settled",
          state: "unknown_effect",
        });
        expect(calls).toEqual(["query", "cancel"]);
        expect(cancelReasons).toEqual(["deadline"]);
        const durable = await client.query(
          `SELECT tool.state::text AS state,job.reconciliation_state,
                  run.unknown_effect_latched_at,outbox.published_at,
                  tombstone.reason_code,
                  (SELECT array_agg(observation.observation_type ORDER BY observation.observation_type)
                     FROM evolution_eval_connector_observation observation
                    WHERE observation.eval_job_id=job.id
                      AND observation.outbox_event_id=outbox.event_id) AS observation_types
             FROM evolution_eval_job job
             JOIN tool_run tool ON tool.id=job.tool_run_id
             JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
             JOIN evolution_eval_dispatch_tombstone tombstone ON tombstone.eval_job_id=job.id
             JOIN outbox_events outbox ON outbox.event_id=tombstone.outbox_event_id
            WHERE job.id=$1`,
          [job.evalJobId],
        );
        expect(Number.isFinite(Date.parse(
          String(durable.rows[0]!.unknown_effect_latched_at),
        ))).toBe(true);
        expect(durable.rows[0]!.published_at).not.toBeNull();
        const expectedObservationTypes = initialState === cancelState
          ? [initialState]
          : [initialState, cancelState].sort();
        expect(durable.rows[0]).toEqual({
          state: "unknown_effect",
          reconciliation_state: "confirmed",
          unknown_effect_latched_at: durable.rows[0]!.unknown_effect_latched_at,
          published_at: durable.rows[0]!.published_at,
          reason_code: "EVOLUTION_EVAL_DEADLINE_CANCEL_REQUESTED",
          observation_types: expectedObservationTypes,
        });
        await client.query(
          `UPDATE outbox_events SET published_at=clock_timestamp()
            WHERE aggregate_id=$1 AND published_at IS NULL`,
          [job.evalJobId],
        );
        await client.query(
          "UPDATE synthia_test_clock SET now_value=NULL WHERE singleton=true",
        );
      }, 30_000);
    }
  }

  for (const cancelState of processCancelMatrixStates) {
    test(`treats an unpublished operator tombstone as definitive after deadline for ${cancelState}`, async () => {
      const label = `operator-tombstone-after-deadline-${cancelState}`;
      const { claim, job, lease: expiredLease } = await prepareTombstoneDuty(label);
      await client.query(
        `UPDATE synthia_test_clock
            SET now_value=(
              SELECT run.deadline_at+interval '1 second'
                FROM evolution_eval_run run
               WHERE run.curator_run_id=$1
            )
          WHERE singleton=true`,
        [claim.runId],
      );
      const lease = await claimNextEvolutionEvalDuty(client, {
        holderId: `dispatcher-${label}-after-deadline`,
        leaseNonce: randomUUID(),
      });
      expect(lease).toMatchObject({
        eventId: expiredLease.eventId,
        eventType: "evolution_eval.dispatch_tombstoned",
        aggregateId: job.evalJobId,
        attemptCount: expiredLease.attemptCount + 1,
      });
      const calls: string[] = [];
      const cancelReasons: string[] = [];
      const connector = connectorDouble({
        calls,
        query: async (binding) => ledgerObservation(binding, "accepted"),
        cancel: async (binding, reason) => {
          cancelReasons.push(reason);
          return ledgerObservation(binding, cancelState);
        },
      });

      expect(await processEvolutionEvalDuty(client, connector, lease!)).toEqual({
        eventId: lease!.eventId,
        duty: "tombstone",
        outcome: "settled",
        state: "unknown_effect",
      });
      expect(calls).toEqual(["query", "cancel"]);
      expect(cancelReasons).toEqual(["deadline"]);
      const durable = await client.query(
        `SELECT tool.state::text AS state,job.reconciliation_state,
                run.unknown_effect_latched_at,outbox.published_at,
                tombstone.reason_code
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
           JOIN evolution_eval_dispatch_tombstone tombstone ON tombstone.eval_job_id=job.id
           JOIN outbox_events outbox ON outbox.event_id=tombstone.outbox_event_id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(Number.isFinite(Date.parse(
        String(durable.rows[0]!.unknown_effect_latched_at),
      ))).toBe(true);
      expect(durable.rows[0]!.published_at).not.toBeNull();
      expect(durable.rows[0]).toEqual({
        state: "unknown_effect",
        reconciliation_state: "confirmed",
        unknown_effect_latched_at: durable.rows[0]!.unknown_effect_latched_at,
        published_at: durable.rows[0]!.published_at,
        reason_code: "OPERATOR_REQUEST",
      });
      await client.query(
        `UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE aggregate_id=$1 AND published_at IS NULL`,
        [job.evalJobId],
      );
      await client.query(
        "UPDATE synthia_test_clock SET now_value=NULL WHERE singleton=true",
      );
    }, 30_000);
  }

  test("covers all 7 event × 6 ledger-state cells and keeps evidence duties off the ledger RPC path", async () => {
    const states = [
      "proven_never_accepted",
      "accepted",
      "terminal",
      "transient_unavailable",
      "ambiguous",
      "ledger_corrupt",
    ] as const;
    const evidenceEvents = [
      "evolution_eval.evidence.freeze_requested",
      "evolution_eval.evidence.ack_requested",
      "evolution_eval.evidence.quarantine_requested",
      "evolution_eval.evidence.cleanup_requested",
    ] as const;
    const coveredCells = new Set<string>();
    for (const eventType of [
      "evolution_eval.dispatch_requested",
      "evolution_eval.reconcile_requested",
      "evolution_eval.dispatch_tombstoned",
    ] as const) {
      for (const state of states) coveredCells.add(`${eventType}:${state}`);
    }
    for (const eventType of evidenceEvents) {
      for (const state of states) {
        const eventId = await insertOutbox({ eventType });
        const lease = await claimNextEvolutionEvalDuty(client, {
          holderId: `dispatcher-evidence-matrix-${coveredCells.size}`,
          leaseNonce: randomUUID(),
        });
        expect(lease).toMatchObject({ eventId, eventType });
        const calls: string[] = [];
        const connector = connectorDouble({
          calls,
          query: async () => {
            throw new Error(`evidence duty must not query ${state}`);
          },
        });
        const before = await client.query(
          `SELECT
             (SELECT count(*)::int FROM evolution_eval_connector_observation) AS observations,
             (SELECT count(*)::int FROM evolution_eval_transition_fact) AS transitions,
             (SELECT count(*)::int FROM evolution_eval_reconcile_fact) AS reconciliations,
             (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone) AS tombstones,
             (SELECT count(*)::int FROM evolution_eval_evidence_fact) AS evidence_facts,
             (SELECT count(*)::int FROM evolution_eval_audit_event) AS audits,
             (SELECT count(*)::int FROM outbox_events) AS outbox_events,
             (SELECT published_at FROM outbox_events WHERE event_id=$1) AS published_at`,
          [eventId],
        );
        await expect(processEvolutionEvalDuty(client, connector, lease!))
          .rejects.toThrow("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
        expect(calls).toEqual([]);
        const after = await client.query(
          `SELECT
             (SELECT count(*)::int FROM evolution_eval_connector_observation) AS observations,
             (SELECT count(*)::int FROM evolution_eval_transition_fact) AS transitions,
             (SELECT count(*)::int FROM evolution_eval_reconcile_fact) AS reconciliations,
             (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone) AS tombstones,
             (SELECT count(*)::int FROM evolution_eval_evidence_fact) AS evidence_facts,
             (SELECT count(*)::int FROM evolution_eval_audit_event) AS audits,
             (SELECT count(*)::int FROM outbox_events) AS outbox_events,
             (SELECT published_at FROM outbox_events WHERE event_id=$1) AS published_at`,
          [eventId],
        );
        expect(after.rows[0]).toEqual(before.rows[0]);
        expect(after.rows[0]!.published_at).toBeNull();
        coveredCells.add(`${eventType}:${state}`);
        await publish(eventId);
      }
    }
    expect(coveredCells.size).toBe(42);
  });

  test("a reclaimed lease rolls back an old holder settlement and requires a new observation fact", async () => {
    const { job } = await prepareAndSubmit("claim-vs-settle");
    const oldLease = await claimDispatch("dispatcher-stale-settle");
    const fenced = await fenceEvolutionEvalDispatch(client, oldLease, ENABLED_FENCE_POLICY);
    expect(fenced.status).toBe("ready");
    if (fenced.status !== "ready") throw new Error("expected a ready effect fence");
    const observation = ledgerObservation(fenced.binding, "terminal");
    const staleFact = await recordEvolutionEvalLedgerObservation(
      client,
      oldLease,
      fenced.binding,
      observation,
    );
    await client.query(
      `UPDATE evolution_eval_dispatcher_lease
          SET lease_expires_at=claimed_at+interval '1 millisecond'
        WHERE event_id=$1`,
      [oldLease.eventId],
    );
    const currentLease = await claimDispatch("dispatcher-current-settle");

    await expect(settleEvolutionEvalLedgerObservation(
      client,
      oldLease,
      fenced.binding,
      staleFact,
    )).rejects.toThrow("EVOLUTION_EVAL_DISPATCHER_LEASE_LOST");
    const beforeCurrentSettle = await client.query(
      `SELECT tool.state::text AS state,outbox.published_at
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(beforeCurrentSettle.rows[0]).toEqual({ state: "running", published_at: null });

    const currentBinding = await loadEvolutionEvalClaimedBinding(client, currentLease);
    const currentFact = await recordEvolutionEvalLedgerObservation(
      client,
      currentLease,
      currentBinding,
      ledgerObservation(currentBinding, "terminal"),
    );
    expect(currentFact.id).not.toBe(staleFact.id);
    expect(await settleEvolutionEvalLedgerObservation(
      client,
      currentLease,
      currentBinding,
      currentFact,
    )).toMatchObject({ action: "settled", published: true, state: "succeeded" });
    const facts = await client.query(
      `SELECT lease_attempt_count,lease_nonce_hash
         FROM evolution_eval_connector_observation
        WHERE eval_job_id=$1 ORDER BY lease_attempt_count`,
      [job.evalJobId],
    );
    expect(facts.rows).toHaveLength(2);
    expect(facts.rows.map((row) => row.lease_attempt_count)).toEqual([1, 2]);
    expect(facts.rows[0]!.lease_nonce_hash).not.toBe(facts.rows[1]!.lease_nonce_hash);
  });

  test("confirms reconciliation only from the current accepted observation", async () => {
    const { job } = await prepareAndSubmit("reconcile-confirmation");
    const dispatchLease = await claimDispatch("dispatcher-reconcile-dispatch");
    const fenced = await fenceEvolutionEvalDispatch(client, dispatchLease, ENABLED_FENCE_POLICY);
    expect(fenced.status).toBe("ready");
    if (fenced.status !== "ready") throw new Error("expected a ready effect fence");
    const accepted = await recordEvolutionEvalLedgerObservation(
      client,
      dispatchLease,
      fenced.binding,
      ledgerObservation(fenced.binding, "accepted"),
    );
    expect(await settleEvolutionEvalLedgerObservation(
      client,
      dispatchLease,
      fenced.binding,
      accepted,
    )).toMatchObject({ action: "settled", published: true, state: "running" });
    await expect(client.query(
      "UPDATE evolution_eval_job SET reconciliation_state='confirmed' WHERE id=$1",
      [job.evalJobId],
    )).rejects.toThrow("unsupported evolution eval reconciliation transition");

    const reconcileLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-reconcile-query",
      leaseNonce: randomUUID(),
    });
    expect(reconcileLease).toMatchObject({
      eventType: "evolution_eval.reconcile_requested",
      aggregateId: job.evalJobId,
    });
    const binding = await loadEvolutionEvalClaimedBinding(client, reconcileLease!);
    await recordEvolutionEvalLedgerObservation(
      client,
      reconcileLease!,
      binding,
      ledgerObservation(binding, "accepted"),
    );
    await client.query(
      `UPDATE evolution_eval_dispatcher_lease
          SET lease_expires_at=claimed_at+interval '1 millisecond'
        WHERE event_id=$1`,
      [reconcileLease!.eventId],
    );
    await expect(client.query(
      "UPDATE evolution_eval_job SET reconciliation_state='confirmed' WHERE id=$1",
      [job.evalJobId],
    )).rejects.toThrow("unsupported evolution eval reconciliation transition");
    const currentLease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-reconcile-current",
      leaseNonce: randomUUID(),
    });
    expect(currentLease).toMatchObject({
      eventId: reconcileLease!.eventId,
      attemptCount: reconcileLease!.attemptCount + 1,
    });
    const currentBinding = await loadEvolutionEvalClaimedBinding(client, currentLease!);
    const current = await recordEvolutionEvalLedgerObservation(
      client,
      currentLease!,
      currentBinding,
      ledgerObservation(currentBinding, "accepted"),
    );
    expect(await settleEvolutionEvalLedgerObservation(
      client,
      currentLease!,
      currentBinding,
      current,
    )).toMatchObject({ action: "settled", published: true, state: "running" });
    const projection = await client.query(
      `SELECT job.reconciliation_state,outbox.published_at IS NOT NULL AS published
         FROM evolution_eval_job job
         JOIN evolution_eval_reconcile_fact fact ON fact.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=fact.outbox_event_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(projection.rows[0]).toEqual({
      reconciliation_state: "confirmed",
      published: true,
    });
  });

  test("new effects are default-off after query-first and do not preflight or submit", async () => {
    const { job } = await prepareAndSubmit("default-off");
    const lease = await claimDispatch("dispatcher-default-off");
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ({
        ...ledgerObservation(binding, "ambiguous"),
        error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
      }),
      queryOrReserve: async (binding) => ledgerObservation(binding, "proven_never_accepted"),
    });

    expect(await processEvolutionEvalDuty(client, connector, lease)).toEqual({
      eventId: lease.eventId,
      duty: "dispatch",
      outcome: "new_effect_disabled",
      state: "rejected",
    });
    expect(calls).toEqual([]);
    const durable = await client.query(
      `SELECT tool.state::text AS state,outbox.published_at,
              (SELECT count(*)::int FROM evolution_eval_transition_fact
                WHERE eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(durable.rows[0]).toEqual({
      state: "rejected",
      published_at: expect.any(Date),
      transitions: 1,
    });
  });

  test("requires both the new-effects and rollout gates before any Connector observation", async () => {
    const policies = [
      { allowNewEffects: false, rolloutEnabled: true, label: "new-effects-off" },
      { allowNewEffects: true, rolloutEnabled: false, label: "rollout-off" },
    ] as const;
    for (const policy of policies) {
      const { job } = await prepareAndSubmit(`process-gate-${policy.label}`);
      const lease = await claimDispatch(`dispatcher-process-gate-${policy.label}`);
      const calls: string[] = [];
      const connector = connectorDouble({
        calls,
        query: async () => {
          throw new Error(`${policy.label} must reject before ledger observation`);
        },
      });
      expect(await processEvolutionEvalDuty(client, connector, lease, policy)).toEqual({
        eventId: lease.eventId,
        duty: "dispatch",
        outcome: "new_effect_disabled",
        state: "rejected",
      });
      expect(calls).toEqual([]);
      const durable = await client.query(
        `SELECT tool.state::text AS state,outbox.published_at IS NOT NULL AS published,
                (SELECT count(*)::int FROM evolution_eval_connector_observation observation
                  WHERE observation.eval_job_id=job.id) AS observations
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
           JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(durable.rows[0]).toEqual({
        state: "rejected",
        published: true,
        observations: 0,
      });
      await client.query(
        `UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE aggregate_id=$1 AND published_at IS NULL`,
        [job.evalJobId],
      );
    }
  });

  test("a non-NO_PROOF ambiguity stays unpublished and never creates replay proof", async () => {
    const { job } = await prepareAndSubmit("ambiguous-no-replay");
    const lease = await claimDispatch("dispatcher-ambiguous-no-replay");
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ({
        ...ledgerObservation(binding, "ambiguous"),
        error_code: "EVOLUTION_EVAL_LEDGER_STATUS_UNKNOWN",
      }),
      queryOrReserve: async () => {
        throw new Error("non-NO_PROOF ambiguity must never reserve");
      },
    });

    expect(await processEvolutionEvalDuty(client, connector, lease, {
      allowNewEffects: true,
      rolloutEnabled: true,
    })).toEqual({
      eventId: lease.eventId,
      duty: "dispatch",
      outcome: "waiting",
      state: "running",
    });
    expect(calls).toEqual(["query"]);
    const projection = await client.query(
      `SELECT tool.state::text AS state,job.reconciliation_state,
              run.unknown_effect_latched_at,outbox.published_at,
              (SELECT count(*)::int FROM evolution_eval_transition_fact
                WHERE eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
        WHERE job.id=$1`,
      [job.evalJobId],
    );
    expect(projection.rows[0]).toEqual({
      state: "running",
      reconciliation_state: "required",
      unknown_effect_latched_at: null,
      published_at: null,
      transitions: 3,
    });
  });

  test("keeps a sealed dispatch submitted when real preflight reports SPOOL_FULL, then rejects it at deadline", async () => {
    const fixture = await prepareAndSubmit("preflight-spool-full");
    const lease = await claimDispatch("dispatcher-preflight-spool-full");
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ledgerObservation(binding, "proven_never_accepted"),
      preflight: async (binding) => ({
        eligible: false,
        operation: binding.dispatch.operation,
        capability_version: "vivado-fake-1",
        license_available: true,
        unacked_spool_bytes: 2_147_483_648,
        hard_cap_bytes: 2_147_483_648,
        error_code: "EVOLUTION_EVAL_SPOOL_FULL",
      }),
      querySpool: async (binding) => spoolResult(binding),
      submit: async () => {
        throw new Error("spool-full preflight must not submit");
      },
    });

    expect(await processEvolutionEvalDuty(client, connector, lease, {
      allowNewEffects: true,
      rolloutEnabled: true,
    })).toEqual({
      eventId: lease.eventId,
      duty: "dispatch",
      outcome: "waiting",
      state: "submitted",
    });
    expect(calls).toEqual(["query", "preflight", "querySpool"]);
    const waiting = await client.query(
      `SELECT tool.state::text AS state,tool.error_code,
              projection.sealed_at IS NOT NULL AS sealed,
              outbox.published_at,
              (SELECT count(*)::int FROM evolution_eval_transition_fact transition
                WHERE transition.eval_job_id=job.id) AS transitions,
              (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone tombstone
                WHERE tombstone.eval_job_id=job.id) AS tombstones
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_workspace_projection projection
           ON projection.workspace_id=job.workspace_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
        WHERE job.id=$1`,
      [fixture.job.evalJobId],
    );
    expect(waiting.rows[0]).toEqual({
      state: "submitted",
      error_code: null,
      sealed: true,
      published_at: null,
      transitions: 0,
      tombstones: 0,
    });

    await client.query(
      `UPDATE synthia_test_clock
          SET now_value=(
            SELECT deadline_at+interval '1 second'
              FROM evolution_eval_job WHERE id=$1
          )
        WHERE singleton=true`,
      [fixture.job.evalJobId],
    );
    expect(await materializeEvolutionEvalDeadlineIntents(client, 100)).toBeGreaterThanOrEqual(1);
    const recoveryLease = await claimDispatch("dispatcher-preflight-spool-full-deadline");
    const postDeadlineCalls: string[] = [];
    const postDeadlineConnector = connectorDouble({
      calls: postDeadlineCalls,
      query: async () => {
        throw new Error("deadline-rejected dispatch must not query Connector");
      },
    });
    expect(await processEvolutionEvalDuty(
      client,
      postDeadlineConnector,
      recoveryLease,
      { allowNewEffects: true, rolloutEnabled: true },
    )).toEqual({
      eventId: recoveryLease.eventId,
      duty: "dispatch",
      outcome: "settled",
      state: "rejected",
    });
    expect(postDeadlineCalls).toEqual([]);
    const terminal = await client.query(
      `SELECT tool.state::text AS state,tool.error_code,
              outbox.published_at IS NOT NULL AS published,
              tombstone.reason_code,
              (SELECT count(*)::int FROM evolution_eval_transition_fact transition
                WHERE transition.eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
         JOIN evolution_eval_dispatch_tombstone tombstone ON tombstone.eval_job_id=job.id
        WHERE job.id=$1`,
      [fixture.job.evalJobId],
    );
    expect(terminal.rows[0]).toEqual({
      state: "rejected",
      error_code: "EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH",
      published: true,
      reason_code: "EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH",
      transitions: 1,
    });
  });

  test.each([
    ["preflight counter", 2_147_483_648, 0],
    ["spool query counter", 0, 2_147_483_648],
  ] as const)("keeps a sealed dispatch submitted when the %s reaches the hard cap", async (
    label,
    preflightBytes,
    spoolBytes,
  ) => {
    const fixture = await prepareAndSubmit(`spool-cap-${label.replaceAll(" ", "-")}`);
    const lease = await claimDispatch(`dispatcher-spool-cap-${label.replaceAll(" ", "-")}`);
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ledgerObservation(binding, "proven_never_accepted"),
      preflight: async (binding) => ({
        eligible: true,
        operation: binding.dispatch.operation,
        capability_version: "vivado-fake-1",
        license_available: true,
        unacked_spool_bytes: preflightBytes,
        hard_cap_bytes: 2_147_483_648,
        error_code: null,
      }),
      querySpool: async (binding) => spoolResult(binding, spoolBytes),
      submit: async () => {
        throw new Error(`${label} hard cap must not submit`);
      },
    });

    expect(await processEvolutionEvalDuty(client, connector, lease, {
      allowNewEffects: true,
      rolloutEnabled: true,
    })).toMatchObject({ outcome: "waiting", state: "submitted" });
    expect(calls).toEqual(["query", "preflight", "querySpool"]);
    const durable = await client.query(
      `SELECT tool.state::text AS state,outbox.published_at,
              (SELECT count(*)::int FROM evolution_eval_transition_fact transition
                WHERE transition.eval_job_id=job.id) AS transitions,
              (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone tombstone
                WHERE tombstone.eval_job_id=job.id) AS tombstones
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
        WHERE job.id=$1`,
      [fixture.job.evalJobId],
    );
    expect(durable.rows[0]).toEqual({
      state: "submitted",
      published_at: null,
      transitions: 0,
      tombstones: 0,
    });
  });

  test("still terminally rejects a non-spool capability preflight drift", async () => {
    const fixture = await prepareAndSubmit("preflight-capability-drift");
    const lease = await claimDispatch("dispatcher-preflight-capability-drift");
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ledgerObservation(binding, "proven_never_accepted"),
      preflight: async (binding) => ({
        eligible: false,
        operation: binding.dispatch.operation,
        capability_version: "vivado-fake-2",
        license_available: true,
        unacked_spool_bytes: 0,
        hard_cap_bytes: 2_147_483_648,
        error_code: "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
      }),
      querySpool: async (binding) => spoolResult(binding),
      submit: async () => {
        throw new Error("capability drift must reject before submit");
      },
    });

    expect(await processEvolutionEvalDuty(client, connector, lease, {
      allowNewEffects: true,
      rolloutEnabled: true,
    })).toEqual({
      eventId: lease.eventId,
      duty: "dispatch",
      outcome: "settled",
      state: "rejected",
    });
    expect(calls).toEqual(["query", "preflight", "querySpool"]);
    const durable = await client.query(
      `SELECT tool.state::text AS state,tool.error_code,
              outbox.published_at IS NOT NULL AS published,
              tombstone.reason_code,
              (SELECT count(*)::int FROM evolution_eval_transition_fact transition
                WHERE transition.eval_job_id=job.id) AS transitions
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
         JOIN evolution_eval_dispatch_tombstone tombstone ON tombstone.eval_job_id=job.id
        WHERE job.id=$1`,
      [fixture.job.evalJobId],
    );
    expect(durable.rows[0]).toEqual({
      state: "rejected",
      error_code: "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
      published: true,
      reason_code: "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
      transitions: 1,
    });
  });

  test("pins the first healthy ledger epoch and rejects later drift atomically", async () => {
    const { job } = await prepareAndSubmit("ledger-epoch-drift");
    const lease = await claimDispatch("dispatcher-ledger-epoch-drift");
    const binding = await loadEvolutionEvalClaimedBinding(client, lease);
    const first = ledgerObservation(binding, "ambiguous");
    await recordEvolutionEvalLedgerObservation(client, lease, binding, first);
    const drifted = await recordEvolutionEvalLedgerObservation(client, lease, binding, {
      ...first,
      ledger_epoch: "adversarial-epoch-2",
    });
    expect(drifted.observation).toMatchObject({
      state: "ledger_corrupt",
      ledger_epoch: "adversarial-epoch-2",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
    });
    expect(await settleEvolutionEvalLedgerObservation(
      client,
      lease,
      binding,
      drifted,
    )).toMatchObject({
      action: "settled",
      published: true,
      state: "unknown_effect",
    });

    const durable = await client.query(
      `SELECT epoch.ledger_epoch,count(observation.id)::int AS observations,
              max(tool.state::text) AS state
         FROM evolution_eval_connector_ledger_epoch epoch
         JOIN evolution_eval_connector_observation observation
           ON observation.eval_job_id=epoch.eval_job_id
         JOIN evolution_eval_job job ON job.id=epoch.eval_job_id
         JOIN tool_run tool ON tool.id=job.tool_run_id
        WHERE epoch.eval_job_id=$1
        GROUP BY epoch.ledger_epoch`,
      [job.evalJobId],
    );
    expect(durable.rows).toEqual([{
      ledger_epoch: "adversarial-epoch-1",
      observations: 2,
      state: "unknown_effect",
    }]);
  });

  test("checks each effect-fence policy bit and leaves zero transition facts when any bit is false", async () => {
    const policies = [
      { newEffectsEnabled: false, rolloutEnabled: true, spoolAvailable: true },
      { newEffectsEnabled: true, rolloutEnabled: false, spoolAvailable: true },
      { newEffectsEnabled: true, rolloutEnabled: true, spoolAvailable: false },
    ] as const;
    for (const [index, policy] of policies.entries()) {
      const { job } = await prepareAndSubmit(`fence-policy-${index}`);
      const lease = await claimDispatch(`dispatcher-fence-policy-${index}`);
      expect(await fenceEvolutionEvalDispatch(client, lease, policy)).toEqual({
        status: "no_op",
        reason: "policy_blocked",
      });
      const projection = await client.query(
        `SELECT tool.state::text AS state,
                (SELECT count(*)::int FROM evolution_eval_transition_fact
                  WHERE eval_job_id=job.id) AS transitions
           FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(projection.rows[0]).toEqual({ state: "submitted", transitions: 0 });
      await publish(lease.eventId);
    }
  });

  test("rechecks paused policy after reserve and spool preflight before the effect fence", async () => {
    const { job } = await prepareAndSubmit("policy-toctou");
    const lease = await claimDispatch("dispatcher-policy-toctou");
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ledgerObservation(binding, "ambiguous"),
      queryOrReserve: async (binding) => ledgerObservation(binding, "proven_never_accepted"),
      preflight: async (binding) => ({
        eligible: true,
        operation: binding.dispatch.operation,
        capability_version: "vivado-fake-1",
        license_available: true,
        unacked_spool_bytes: 0,
        hard_cap_bytes: 2_147_483_648,
        error_code: null,
      }),
      querySpool: async (binding) => {
        await client.query(
          `UPDATE evolution_settings
              SET learning_paused=true,revision=revision+1,updated_at=clock_timestamp(),
                  updated_by_type='service',updated_by='adversarial-test',
                  update_reason='TOCTOU policy recheck'
            WHERE singleton_id='global'`,
        );
        return spoolResult(binding);
      },
      submit: async () => {
        throw new Error("policy change before fence must prevent submit");
      },
    });
    try {
      expect(await processEvolutionEvalDuty(client, connector, lease, {
        allowNewEffects: true,
        rolloutEnabled: true,
      })).toEqual({
        eventId: lease.eventId,
        duty: "dispatch",
        outcome: "waiting",
        state: "submitted",
      });
      expect(calls).toEqual(["query", "queryOrReserve", "preflight", "querySpool"]);
      const projection = await client.query(
        `SELECT tool.state::text AS state,outbox.published_at,
                (SELECT count(*)::int FROM evolution_eval_transition_fact
                  WHERE eval_job_id=job.id) AS transitions
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
           JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(projection.rows[0]).toEqual({
        state: "submitted",
        published_at: null,
        transitions: 0,
      });
    } finally {
      await client.query(
        `UPDATE evolution_settings
            SET learning_paused=false,revision=revision+1,updated_at=clock_timestamp(),
                updated_by_type='service',updated_by='adversarial-test',
                update_reason='restore after TOCTOU test'
          WHERE singleton_id='global'`,
      );
    }
  });

  test("rechecks every effect gate and durable latch after reservation before submit", async () => {
    const cases = [
      "new_effects",
      "rollout",
      "spool",
      "reconcile",
      "tombstone",
      "unknown_latch",
    ] as const;
    for (const scenario of cases) {
      const fixture = await prepareAndSubmit(`post-reserve-toctou-${scenario}`);
      const lease = await claimDispatch(`dispatcher-post-reserve-toctou-${scenario}`);
      const binding = await loadEvolutionEvalClaimedBinding(client, lease);
      const calls: string[] = [];
      let allowNewEffects = true;
      let rolloutEnabled = true;
      const connector = connectorDouble({
        calls,
        query: async (current) => ({
          ...ledgerObservation(current, "ambiguous"),
          error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
        }),
        queryOrReserve: async (current) => ledgerObservation(current, "proven_never_accepted"),
        preflight: async (current) => ({
          eligible: true,
          operation: current.dispatch.operation,
          capability_version: "vivado-fake-1",
          license_available: true,
          unacked_spool_bytes: 0,
          hard_cap_bytes: 2_147_483_648,
          error_code: null,
        }),
        querySpool: async (binding) => {
          if (scenario === "new_effects") {
            allowNewEffects = false;
          } else if (scenario === "rollout") {
            rolloutEnabled = false;
          } else if (scenario === "reconcile") {
            const observation = await recordEvolutionEvalLedgerObservation(
              client,
              lease,
              binding,
              {
                ...ledgerObservation(binding, "ambiguous"),
                error_code: "EVOLUTION_EVAL_LEDGER_STATUS_UNKNOWN",
              },
            );
            expect(await settleEvolutionEvalLedgerObservation(
              client,
              lease,
              binding,
              observation,
            )).toMatchObject({ action: "wait", published: false, state: "running" });
          } else if (scenario === "tombstone") {
            const cancelled = await apiCall(
              harness.baseUrl,
              `/api/v1/internal/evolution/curator-runs/${fixture.claim.runId}/eval-jobs/${fixture.job.evalJobId}/cancel`,
              {
                method: "POST",
                token: evaluatorToken,
                headers: { "idempotency-key": `post-reserve-toctou-${scenario}-cancel` },
                body: {
                  schema: "evolution-eval-cancel.v1",
                  curator_lease_token: fixture.claim.leaseToken,
                  reason_code: "OPERATOR_REQUEST",
                },
              },
            );
            expect(cancelled.status).toBe(200);
          } else if (scenario === "unknown_latch") {
            const observation = await recordEvolutionEvalLedgerObservation(
              client,
              lease,
              binding,
              ledgerObservation(binding, "ledger_corrupt"),
            );
            expect(await settleEvolutionEvalLedgerObservation(
              client,
              lease,
              binding,
              observation,
            )).toMatchObject({ action: "settled", published: true, state: "unknown_effect" });
          }
          return spoolResult(
            binding,
            scenario === "spool" ? 2_147_483_648 : 0,
          );
        },
        submit: async () => {
          throw new Error(`${scenario} changed after reserve and must prevent submit`);
        },
      });

      const result = await processEvolutionEvalDuty(client, connector, lease, {
        get allowNewEffects() {
          return allowNewEffects;
        },
        get rolloutEnabled() {
          return rolloutEnabled;
        },
        loadSealedInput: async (_connection, current) => ({
          manifest: {
            schema: "evolution-eval-workspace-manifest.v1",
            workspace_id: current.dispatch.workspace_id,
            revision: current.dispatch.workspace_revision,
            files: [],
          },
          files: {
            async *[Symbol.asyncIterator]() {
              return;
            },
          },
        }),
      });
      expect(result.outcome).toBe("waiting");
      expect(calls).toEqual(["query", "queryOrReserve", "preflight", "querySpool"]);
      const projection = await client.query(
        `SELECT tool.state::text AS state,job.reconciliation_state,
                run.unknown_effect_latched_at,
                (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone tombstone
                  WHERE tombstone.eval_job_id=job.id) AS tombstones
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
          WHERE job.id=$1`,
        [fixture.job.evalJobId],
      );
      if (["new_effects", "rollout", "spool"].includes(scenario)) {
        expect(projection.rows[0]).toEqual({
          state: "submitted",
          reconciliation_state: "not_needed",
          unknown_effect_latched_at: null,
          tombstones: 0,
        });
      } else if (scenario === "reconcile") {
        expect(projection.rows[0]).toEqual({
          state: "running",
          reconciliation_state: "required",
          unknown_effect_latched_at: null,
          tombstones: 0,
        });
      } else if (scenario === "tombstone") {
        expect(projection.rows[0]).toEqual({
          state: "rejected",
          reconciliation_state: "not_needed",
          unknown_effect_latched_at: null,
          tombstones: 1,
        });
      } else {
        expect(Number.isFinite(Date.parse(
          String(projection.rows[0]!.unknown_effect_latched_at),
        ))).toBe(true);
        expect(projection.rows[0]).toEqual({
          state: "unknown_effect",
          reconciliation_state: "confirmed",
          unknown_effect_latched_at: projection.rows[0]!.unknown_effect_latched_at,
          tombstones: 0,
        });
      }
      await client.query(
        `UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE aggregate_id=$1 AND published_at IS NULL`,
        [fixture.job.evalJobId],
      );
    }
  });

  test("consumes a pre-effect closed dispatch before any Connector RPC", async () => {
    const fixture = await prepareAndSubmit("pre-rpc-no-op");
    const lease = await claimDispatch("dispatcher-pre-rpc-no-op");
    const cancelled = await apiCall(
      harness.baseUrl,
      `/api/v1/internal/evolution/curator-runs/${fixture.claim.runId}/eval-jobs/${fixture.job.evalJobId}/cancel`,
      {
        method: "POST",
        token: evaluatorToken,
        headers: { "idempotency-key": "pre-rpc-no-op-cancel" },
        body: {
          schema: "evolution-eval-cancel.v1",
          curator_lease_token: fixture.claim.leaseToken,
          reason_code: "OPERATOR_REQUEST",
        },
      },
    );
    expect(cancelled.status).toBe(200);
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async () => {
        throw new Error("closed dispatch must not query Connector");
      },
    });
    expect(await processEvolutionEvalDuty(client, connector, lease, {
      allowNewEffects: true,
      rolloutEnabled: true,
    })).toEqual({
      eventId: lease.eventId,
      duty: "dispatch",
      outcome: "settled",
      state: "rejected",
    });
    expect(calls).toEqual([]);
    const event = await client.query(
      "SELECT published_at IS NOT NULL AS published FROM outbox_events WHERE event_id=$1",
      [lease.eventId],
    );
    expect(event.rows[0]).toEqual({ published: true });
  });

  test("allowing a new effect commits the running fence before submit and publishes only after acceptance", async () => {
    const { job } = await prepareAndSubmit("allowed-effect");
    const lease = await claimDispatch("dispatcher-allowed-effect");
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async (binding) => ({
        ...ledgerObservation(binding, "ambiguous"),
        error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
      }),
      queryOrReserve: async (binding) => ledgerObservation(binding, "proven_never_accepted"),
      preflight: async (binding) => ({
        eligible: true,
        operation: binding.dispatch.operation,
        capability_version: "vivado-fake-1",
        license_available: true,
        unacked_spool_bytes: 0,
        hard_cap_bytes: 2_147_483_648,
        error_code: null,
      }),
      submit: async (binding, input) => {
        expect(input.manifest).toMatchObject({
          workspace_id: binding.dispatch.workspace_id,
          revision: binding.dispatch.workspace_revision,
        });
        const observer = new Client({ connectionString: testDatabaseUrl });
        await observer.connect();
        try {
          const visible = await observer.query(
            `SELECT tool.state::text AS state,
                    (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                      WHERE fact.eval_job_id=job.id) AS transitions,
                    (SELECT count(*)::int FROM evolution_eval_audit_event audit
                      WHERE audit.eval_job_id=job.id
                        AND audit.event_type='tool_run_transition') AS audits,
                    outbox.published_at
               FROM evolution_eval_job job
               JOIN tool_run tool ON tool.id=job.tool_run_id
               JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
               JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
              WHERE job.id=$1`,
            [job.evalJobId],
          );
          expect(visible.rows[0]).toEqual({
            state: "running",
            transitions: 3,
            audits: 3,
            published_at: null,
          });
        } finally {
          await observer.end();
        }
        return ledgerObservation(binding, "accepted");
      },
    });

    const result = await processEvolutionEvalDuty(client, connector, lease, {
      allowNewEffects: true,
      rolloutEnabled: true,
      loadSealedInput: async (_connection, binding) => ({
        manifest: {
          schema: "evolution-eval-workspace-manifest.v1",
          workspace_id: binding.dispatch.workspace_id,
          revision: binding.dispatch.workspace_revision,
          files: [],
        },
        files: {
          async *[Symbol.asyncIterator]() {
            return;
          },
        },
      }),
    });
    expect(result).toEqual({
      eventId: lease.eventId,
      duty: "dispatch",
      outcome: "settled",
      state: "running",
    });
    expect(calls).toEqual([
      "query",
      "queryOrReserve",
      "preflight",
      "querySpool",
      "submit",
    ]);
    const published = await client.query(
      "SELECT published_at IS NOT NULL AS published FROM outbox_events WHERE event_id=$1",
      [lease.eventId],
    );
    expect(published.rows[0]).toEqual({ published: true });
  });

  test("first dispatch integrates through a real durable File ledger without blind replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-core-file-ledger-"));
    try {
      const ledger = await FileEvolutionEvalLedger.initialize({
        root,
        ledgerEpoch: "core-file-ledger-epoch-1",
        now: () => new Date("2026-08-26T08:00:00.000Z"),
      });
      const { job } = await prepareAndSubmit("real-file-ledger-first-dispatch");
      const lease = await claimDispatch("dispatcher-real-file-ledger");
      const issuedBinding = await loadEvolutionEvalClaimedBinding(client, lease);
      const calls: string[] = [];
      const connector = connectorDouble({
        calls,
        query: async (binding) => {
          const absent = await ledger.query(binding);
          expect(absent).toMatchObject({
            state: "ambiguous",
            effect_possible: true,
            error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
          });
          const preFence = await client.query(
            `SELECT tool.state::text AS state,job.reconciliation_state,
                    run.unknown_effect_latched_at,outbox.published_at,
                    (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                      WHERE fact.eval_job_id=job.id) AS transitions
               FROM evolution_eval_job job
               JOIN tool_run tool ON tool.id=job.tool_run_id
               JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
               JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
               JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
              WHERE job.id=$1`,
            [job.evalJobId],
          );
          expect(preFence.rows[0]).toEqual({
            state: "submitted",
            reconciliation_state: "not_needed",
            unknown_effect_latched_at: null,
            published_at: null,
            transitions: 0,
          });
          return absent;
        },
        queryOrReserve: async (binding) => {
          const beforeReservation = await client.query(
            `SELECT tool.state::text AS state,job.reconciliation_state,
                    run.unknown_effect_latched_at,outbox.published_at,
                    (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                      WHERE fact.eval_job_id=job.id) AS transitions,
                    (SELECT count(*)::int FROM evolution_eval_connector_observation observation
                      WHERE observation.eval_job_id=job.id) AS observations
               FROM evolution_eval_job job
               JOIN tool_run tool ON tool.id=job.tool_run_id
               JOIN evolution_eval_run run ON run.curator_run_id=job.curator_run_id
               JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
               JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
              WHERE job.id=$1`,
            [job.evalJobId],
          );
          expect(beforeReservation.rows[0]).toEqual({
            state: "submitted",
            reconciliation_state: "not_needed",
            unknown_effect_latched_at: null,
            published_at: null,
            transitions: 0,
            observations: 1,
          });
          return ledger.queryOrReserve(binding);
        },
        preflight: async (binding) => ({
          eligible: true,
          operation: binding.dispatch.operation,
          capability_version: "file-ledger-fake-v1",
          license_available: true,
          unacked_spool_bytes: 0,
          hard_cap_bytes: 2_147_483_648,
          error_code: null,
        }),
        querySpool: async (binding) => spoolResult(binding),
        submit: async (binding) => {
          expect(await ledger.query(binding)).toMatchObject({
            state: "proven_never_accepted",
            replay_permitted: true,
          });
          const observer = new Client({ connectionString: testDatabaseUrl });
          await observer.connect();
          try {
            const committedFence = await observer.query(
              `SELECT tool.state::text AS state,outbox.published_at,
                      (SELECT count(*)::int FROM evolution_eval_transition_fact fact
                        WHERE fact.eval_job_id=job.id) AS transitions,
                      (SELECT array_agg(observation.observation_type ORDER BY observation.observation_type)
                         FROM evolution_eval_connector_observation observation
                        WHERE observation.eval_job_id=job.id) AS observation_types
                 FROM evolution_eval_job job
                 JOIN tool_run tool ON tool.id=job.tool_run_id
                 JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
                 JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
                WHERE job.id=$1`,
              [job.evalJobId],
            );
            expect(committedFence.rows[0]).toEqual({
              state: "running",
              published_at: null,
              transitions: 3,
              observation_types: ["ambiguous", "proven_never_accepted"],
            });
          } finally {
            await observer.end();
          }
          const accepted = await ledger.markAccepted(binding, {
            executionState: "running",
            acceptedAt: "2026-08-26T08:00:01.000Z",
          });
          expect(accepted.accepted_now).toBe(true);
          expect(accepted.effect_owner_token).toMatch(/^[0-9a-f]{64}$/);
          return accepted.observation;
        },
      });
      expect(await processEvolutionEvalDuty(client, connector, lease, {
        allowNewEffects: true,
        rolloutEnabled: true,
        loadSealedInput: async (_connection, binding) => ({
          manifest: {
            schema: "evolution-eval-workspace-manifest.v1",
            workspace_id: binding.dispatch.workspace_id,
            revision: binding.dispatch.workspace_revision,
            files: [],
          },
          files: {
            async *[Symbol.asyncIterator]() {
              return;
            },
          },
        }),
      })).toEqual({
        eventId: lease.eventId,
        duty: "dispatch",
        outcome: "settled",
        state: "running",
      });
      expect(calls).toEqual([
        "query",
        "queryOrReserve",
        "preflight",
        "querySpool",
        "submit",
      ]);
      expect(await ledger.query(issuedBinding)).toMatchObject({
        state: "accepted",
        execution_state: "running",
      });
      const durable = await client.query(
        `SELECT tool.state::text AS state,outbox.published_at IS NOT NULL AS published,
                epoch.ledger_epoch
           FROM evolution_eval_job job
           JOIN tool_run tool ON tool.id=job.tool_run_id
           JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
           JOIN outbox_events outbox ON outbox.event_id=dispatch.outbox_event_id
           JOIN evolution_eval_connector_ledger_epoch epoch ON epoch.eval_job_id=job.id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(durable.rows[0]).toEqual({
        state: "running",
        published: true,
        ledger_epoch: "core-file-ledger-epoch-1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent tombstone and fence follow one lock order and commit one legal winner", async () => {
    const fixture = await prepareAndSubmit("lock-order-tombstone-fence");
    const lease = await claimDispatch("dispatcher-lock-order-tombstone-fence");
    const fenceClient = new Client({ connectionString: testDatabaseUrl });
    await fenceClient.connect();
    await fenceClient.query("SET lock_timeout='3s'");
    await fenceClient.query("SET statement_timeout='5s'");
    try {
      const [fenceResult, cancelResult] = await Promise.allSettled([
        fenceEvolutionEvalDispatch(fenceClient, lease, ENABLED_FENCE_POLICY),
        apiCall(
          harness.baseUrl,
          `/api/v1/internal/evolution/curator-runs/${fixture.claim.runId}/eval-jobs/${fixture.job.evalJobId}/cancel`,
          {
            method: "POST",
            token: evaluatorToken,
            headers: { "idempotency-key": "lock-order-tombstone-fence-cancel" },
            body: {
              schema: "evolution-eval-cancel.v1",
              curator_lease_token: fixture.claim.leaseToken,
              reason_code: "OPERATOR_REQUEST",
            },
          },
        ),
      ]);
      expect(fenceResult.status).toBe("fulfilled");
      expect(cancelResult.status).toBe("fulfilled");
      if (fenceResult.status !== "fulfilled" || cancelResult.status !== "fulfilled") {
        throw new Error("lock-order race did not complete");
      }
      expect(cancelResult.value.status === 200 || cancelResult.value.status === 202).toBe(true);
      expect(
        fenceResult.value.status === "ready"
        || (fenceResult.value.status === "no_op" && fenceResult.value.reason === "tombstoned"),
      ).toBe(true);
      const projection = await client.query(
        `SELECT tool.state::text AS state,
                (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone
                  WHERE eval_job_id=job.id) AS tombstones,
                (SELECT count(*)::int FROM evolution_eval_transition_fact
                  WHERE eval_job_id=job.id) AS transitions
           FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
          WHERE job.id=$1`,
        [fixture.job.evalJobId],
      );
      expect(projection.rows[0]).toEqual(expect.objectContaining({ tombstones: 1 }));
      expect([
        { state: "rejected", transitions: 1 },
        { state: "running", transitions: 3 },
      ]).toContainEqual({
        state: projection.rows[0]!.state,
        transitions: projection.rows[0]!.transitions,
      });
    } finally {
      await fenceClient.end();
    }
  });

  test("concurrent deadline materialization and fence complete without reverse-lock deadlock", async () => {
    const { job } = await prepareAndSubmit("lock-order-deadline-fence");
    const deadline = await client.query(
      "SELECT deadline_at FROM evolution_eval_job WHERE id=$1",
      [job.evalJobId],
    );
    await client.query(
      "UPDATE synthia_test_clock SET now_value=$1 WHERE singleton=true",
      [new Date(new Date(deadline.rows[0]!.deadline_at).getTime() + 1_000)],
    );
    const lease = await claimDispatch("dispatcher-lock-order-deadline-fence");
    const fenceClient = new Client({ connectionString: testDatabaseUrl });
    const deadlineClient = new Client({ connectionString: testDatabaseUrl });
    await Promise.all([fenceClient.connect(), deadlineClient.connect()]);
    await Promise.all([
      fenceClient.query("SET lock_timeout='3s'"),
      deadlineClient.query("SET lock_timeout='3s'"),
    ]);
    await Promise.all([
      fenceClient.query("SET statement_timeout='5s'"),
      deadlineClient.query("SET statement_timeout='5s'"),
    ]);
    try {
      const [fenceResult, deadlineResult] = await Promise.allSettled([
        fenceEvolutionEvalDispatch(fenceClient, lease, ENABLED_FENCE_POLICY),
        materializeEvolutionEvalDeadlineIntents(deadlineClient, 100),
      ]);
      if (fenceResult.status === "rejected") throw fenceResult.reason;
      if (deadlineResult.status === "rejected") throw deadlineResult.reason;
      expect(fenceResult.status).toBe("fulfilled");
      expect(deadlineResult.status).toBe("fulfilled");
      if (fenceResult.status !== "fulfilled" || deadlineResult.status !== "fulfilled") {
        throw new Error("deadline/fence lock-order race did not complete");
      }
      expect(deadlineResult.value).toBeGreaterThanOrEqual(1);
      expect(fenceResult.value).toEqual(expect.objectContaining({ status: "no_op" }));
      const projection = await client.query(
        `SELECT tool.state::text AS state,
                (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone
                  WHERE eval_job_id=job.id) AS tombstones,
                (SELECT count(*)::int FROM evolution_eval_transition_fact
                  WHERE eval_job_id=job.id) AS transitions
           FROM evolution_eval_job job JOIN tool_run tool ON tool.id=job.tool_run_id
          WHERE job.id=$1`,
        [job.evalJobId],
      );
      expect(projection.rows[0]).toEqual({
        state: "rejected",
        tombstones: 1,
        transitions: 1,
      });
    } finally {
      await Promise.all([fenceClient.end(), deadlineClient.end()]);
    }
  });

  test("a dispatcher tick rejects unowned evidence outbox rows without reaching Connector RPCs", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertOutbox({ eventType: "evolution_eval.evidence.freeze_requested" });
    }
    const calls: string[] = [];
    const connector = connectorDouble({
      calls,
      query: async () => {
        throw new Error("evidence-deferred duties must not query the Connector");
      },
    });
    await expect(runEvolutionEvalDispatcherTick(client, connector, {
      holderId: "dispatcher-bounded-tick",
      maxDuties: 2,
      materializeDeadlines: false,
      materializeRetention: false,
    })).rejects.toThrow("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    expect(calls).toEqual([]);
    const leases = await client.query(
      `SELECT count(*)::int AS count
         FROM evolution_eval_dispatcher_lease
        WHERE holder_id='dispatcher-bounded-tick'`,
    );
    expect(leases.rows[0]).toEqual({ count: 1 });
  });
});
