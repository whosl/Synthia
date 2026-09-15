/**
 * Adversarial PostgreSQL invariants for the frozen evolution-eval v1 contract.
 *
 * These tests intentionally exercise committed database behavior through the
 * production migration runner. They do not inspect migration source text.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { migrate } from "../src/db/client.ts";
import {
  canonicalEvolutionEvalSealedInputProjection,
  portableEvolutionEvalPath,
  portablePathKey,
} from "../src/domain/evolution-eval.ts";
import { sha256Hex } from "../src/hashing.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const hash = (value: string | Uint8Array): string => sha256Hex(value);

interface EvalFixture {
  readonly suffix: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly curatorRunId: string;
  readonly applicationId: string;
  readonly primaryVersionId: string;
  readonly supportingVersionId: string;
  readonly inputVersionId: string;
  readonly evalInputRef: string;
  readonly toolRunId: string;
  readonly evalJobId: string;
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly revisionOneHash: string;
  readonly deadlineAt: Date;
}

interface FixtureOptions {
  readonly initialRevision?: number;
  readonly inputRole?: "primary" | "supporting";
  readonly skillFileBinding?: "empty" | "valid" | "missing" | "forged" | "extra" | "workspace_drift";
  readonly sourcePath?: string;
  readonly budgetStartedAt?: Date;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly omitOperationFact?: "prepare" | "workspace_revision" | "workspace_projection";
  readonly operationFactOptions?: Readonly<Partial<Record<
    "prepare" | "workspace_revision" | "workspace_projection",
    {
      readonly audit?: boolean;
      readonly outbox?: boolean;
      readonly payloadExtra?: Readonly<Record<string, unknown>>;
      readonly headers?: Readonly<Record<string, unknown>>;
      readonly projectId?: string;
      readonly correlationId?: string;
    }
  >>>;
}

let sequence = 0;
let outboxSequence = 1_000;

function unique(label: string): string {
  sequence += 1;
  return `${label}_${sequence}_${randomUUID().replaceAll("-", "")}`;
}

function nextOutboxSequence(): number {
  outboxSequence += 1;
  return outboxSequence;
}

interface OperationFactContext {
  readonly suffix: string;
  readonly curatorRunId: string;
  readonly evalJobId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly inputManifestHash: string;
  readonly prepareRequestHash: string;
}

async function insertOperationFact(
  client: Client,
  context: OperationFactContext,
  factType: "prepare" | "workspace_revision" | "workspace_projection" | "workspace_seal",
  revision: number,
  manifestHash: string,
  fileCount: number,
  byteCount: number,
  options: {
    readonly audit?: boolean;
    readonly outbox?: boolean;
    readonly payloadExtra?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, unknown>>;
    readonly projectId?: string;
    readonly correlationId?: string;
  } = {},
): Promise<{ readonly factId: string; readonly auditId: string; readonly outboxId: string }> {
  const factId = unique(`operation_${factType}`);
  const auditId = unique(`audit_${factType}`);
  const outboxId = randomUUID();
  const auditType = factType === "prepare"
    ? "eval_job.prepared"
    : factType === "workspace_seal"
      ? "workspace_sealed"
      : factType;
  const eventType = factType === "prepare"
    ? "evolution_eval.job_prepared"
    : factType === "workspace_seal"
      ? "evolution_eval.workspace_sealed"
      : `evolution_eval.${factType}`;
  const basePayload = factType === "prepare"
    ? {
      fact_id: factId,
      prepare_request_hash: context.prepareRequestHash,
      input_manifest_hash: context.inputManifestHash,
      workspace_manifest_hash: manifestHash,
    }
    : {
      fact_id: factId,
      workspace_id: context.workspaceId,
      revision,
      workspace_manifest_hash: manifestHash,
      file_count: fileCount,
      byte_count: byteCount,
    };
  const payload = { ...basePayload, ...options.payloadExtra };
  if (options.audit !== false) {
    await client.query(
      `INSERT INTO evolution_eval_audit_event
         (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
          correlation_id,request_hash,operation,workspace_manifest_hash,file_count,byte_count)
       VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$8,'synthesize',$9,$10,$11)`,
      [
        auditId,
        context.curatorRunId,
        context.evalJobId,
        context.projectId,
        auditType,
        `evaluator_${context.suffix}`,
        `correlation_${context.suffix}`,
        factType === "prepare" ? context.prepareRequestHash : null,
        manifestHash,
        fileCount,
        byteCount,
      ],
    );
  }
  if (options.outbox !== false) {
    await client.query(
      `INSERT INTO outbox_events
         (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
          headers,correlation_id,causation_id,classification)
       VALUES ($1,'evolution_eval_job',$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,NULL,'D1')`,
      [
        outboxId,
        context.evalJobId,
        nextOutboxSequence(),
        eventType,
        options.projectId ?? context.projectId,
        JSON.stringify(payload),
        JSON.stringify(options.headers ?? {}),
        options.correlationId ?? `correlation_${context.suffix}`,
      ],
    );
  }
  await client.query(
    `INSERT INTO evolution_eval_operation_fact
       (id,eval_job_id,fact_type,workspace_id,workspace_revision,
        workspace_manifest_hash,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      factId,
      context.evalJobId,
      factType,
      factType === "prepare" ? null : context.workspaceId,
      factType === "prepare" ? null : revision,
      factType === "prepare" ? null : manifestHash,
      auditId,
      outboxId,
    ],
  );
  return { factId, auditId, outboxId };
}

function databaseUrl(name: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function transaction(
  client: Client,
  work: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function transactionWasRejected(
  client: Client,
  work: () => Promise<void>,
): Promise<boolean> {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
    return false;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return true;
  }
}

async function rejectedConstraint(
  client: Client,
  work: () => Promise<void>,
): Promise<string | null> {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return (error as { readonly constraint?: string }).constraint ?? null;
  }
}

async function insertFixture(
  client: Client,
  options: FixtureOptions = {},
): Promise<EvalFixture> {
  const suffix = unique("fixture");
  const projectId = `project_${suffix}`;
  const taskId = `task_${suffix}`;
  const serviceUid = `service_${suffix}`;
  const curatorRunId = `curator_${suffix}`;
  const skillId = `skill_${suffix}`;
  const primaryVersionId = `version_primary_${suffix}`;
  const supportingVersionId = `version_supporting_${suffix}`;
  const applicationId = `application_${suffix}`;
  const evalInputRef = `input_${suffix}`;
  const toolRunId = `toolrun_${suffix}`;
  const evalJobId = `evaljob_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const initialRevision = options.initialRevision ?? 1;
  const sourcePath = options.sourcePath ?? "rtl/top.sv";
  const inputVersionId = options.inputRole === "supporting"
    ? supportingVersionId
    : primaryVersionId;
  const budgetStartedAt = options.budgetStartedAt ?? new Date();
  const deadlineAt = new Date(budgetStartedAt.getTime() + 2 * 60 * 60 * 1000);
  const source = Buffer.from("module top; endmodule\n", "utf8");
  const sourceHash = hash(source);
  const skillFileBinding = options.skillFileBinding ?? "empty";
  const skillPath = "SKILL.md";
  const skillContent = "# Synthesis guidance\n";
  const skillHash = hash(skillContent);
  const forgedSkillContent = "# Forged guidance\n";
  const forgedSkillHash = hash(forgedSkillContent);
  const extraSkillPath = "references/extra.md";
  const extraSkillContent = "# Unbound supporting file\n";
  const extraSkillHash = hash(extraSkillContent);
  const inputSkillFiles = skillFileBinding === "empty" || skillFileBinding === "missing"
    ? []
    : [
      {
        learnedSkillFileId: `skill_file_primary_${suffix}`,
        path: skillPath,
        kind: "skill_md",
        language: null,
        sha256: skillFileBinding === "forged" ? forgedSkillHash : skillHash,
        size_bytes: Buffer.byteLength(
          skillFileBinding === "forged" ? forgedSkillContent : skillContent,
          "utf8",
        ),
        media_type: "text/markdown",
        content: skillFileBinding === "forged" ? forgedSkillContent : skillContent,
      },
      ...skillFileBinding === "extra" ? [{
        learnedSkillFileId: `skill_file_supporting_${suffix}`,
        path: extraSkillPath,
        kind: "reference",
        language: null,
        sha256: extraSkillHash,
        size_bytes: Buffer.byteLength(extraSkillContent, "utf8"),
        media_type: "text/markdown",
        content: extraSkillContent,
      }] : [],
    ];
  const skillManifestFiles = inputSkillFiles.map((file) => ({
    path: file.path,
    kind: file.kind,
    language: file.language,
    sha256: file.sha256,
    size_bytes: file.size_bytes,
    media_type: file.media_type,
  }));
  const workspaceSkillFiles = inputSkillFiles.map((file) => {
    const drifted = skillFileBinding === "workspace_drift"
      ? `${file.content}drift\n`
      : file.content;
    return {
      path: file.path,
      sha256: hash(drifted),
      size_bytes: Buffer.byteLength(drifted, "utf8"),
      media_type: file.media_type,
      layer: "skill",
      read_only: true,
      content: Buffer.from(drifted, "utf8"),
    };
  });
  const workspaceManifestFiles = [
    {
      path: sourcePath,
      sha256: sourceHash,
      size_bytes: source.length,
      media_type: "text/x-systemverilog",
      layer: "source",
      read_only: true,
    },
    ...workspaceSkillFiles.map(({ content: _content, ...file }) => file),
  ].sort((left, right) => {
    const leftKey = portablePathKey(left.path);
    const rightKey = portablePathKey(right.path);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  const skillBytes = workspaceSkillFiles.reduce((total, file) => total + file.size_bytes, 0);
  const revisionOneHash = hash(`workspace:${suffix}:${initialRevision}`);
  const inputManifest = {
    schema: "evolution-eval-input-manifest.v1",
    eval_input_ref: evalInputRef,
    curator_run_id: curatorRunId,
    application_id: applicationId,
    project_id: projectId,
    version_id: inputVersionId,
    evidence_snapshot_hash: hash(`evidence:${suffix}`),
    source_commit: "a".repeat(40),
    source_manifest_hash: hash(`source-manifest:${suffix}`),
    allowed_operations: ["synthesize"],
    trial_bitstream_allowed: false,
    part: "xc7a35tcpg236-1",
    toolchain_profile_hash: hash(`toolchain:${suffix}`),
    files: [{
      path: sourcePath,
      sha256: sourceHash,
      size_bytes: source.length,
      media_type: "text/x-systemverilog",
    }],
    skill_files: skillManifestFiles,
  };
  const parameters = options.parameters ?? {
    operation: "synthesize",
    source_paths: [sourcePath],
    top: "top",
    part: "xc7a35tcpg236-1",
  };

  await client.query(
    `INSERT INTO user_account (id,uid,actor_type)
     VALUES ($1,$2,'service')`,
    [`identity_${suffix}`, serviceUid],
  );
  await client.query(
    `INSERT INTO project
       (id,name,scope,project_type,process_version_id,process_profile_id,
        process_profile_version,process_profile_name,status)
     VALUES ($1,$2,'','free',NULL,NULL,NULL,NULL,'active')`,
    [projectId, suffix],
  );
  await client.query(
    `INSERT INTO agent_task
       (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
        process_instance_id,runtime_agent_id,runtime_actor_id,objective,
        authorization_scope,status,input_hash,adoption_state,created_by_type,created_by)
     VALUES ($1,$2,'free','main','run',NULL,NULL,NULL,$1,$3,$4,
             '{}'::jsonb,'running',$5,'not_applicable','system',$3)`,
    [taskId, projectId, serviceUid, `evaluate ${suffix}`, hash(`task:${suffix}`)],
  );
  await client.query(
    `INSERT INTO task_conversation_event
       (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id)
     VALUES ($1,$2,$3,1,'tool_call',$4::jsonb,$5,'agent',$6)`,
    [
      `event_${suffix}`,
      projectId,
      taskId,
      JSON.stringify({ name: "learned_skill_apply", tool_call_id: `call_${suffix}` }),
      hash(`event:${suffix}`),
      taskId,
    ],
  );
  await client.query(
    `INSERT INTO curator_run
       (id,mode,state,schedule_bucket,manual_key,eligible_at,reason,attempt,
        worker_id,lease_token,lease_expires_at,created_by_type,created_by)
     VALUES ($1,'run','running',$2,NULL,now(),$3,1,$4,$5,now()+interval '1 day','system',$4)`,
    [
      curatorRunId,
      `bucket_${suffix}`,
      `evaluate ${suffix}`,
      `curator_worker_${suffix}`,
      `lease_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_run
       (curator_run_id,budget_started_at,deadline_at,created_at)
     VALUES ($1,$2,$3,$2)`,
    [curatorRunId, budgetStartedAt, deadlineAt],
  );
  await client.query(
    `INSERT INTO learned_skill
       (id,slug,name,summary,applicability_summary,created_by_type,created_by)
     VALUES ($1,$2,$3,$4,$5,'system',$6)`,
    [
      skillId,
      `skill-${sequence}-${randomUUID().slice(0, 8)}`,
      `Skill ${suffix}`,
      "summary",
      "FPGA synthesis",
      `curator_worker_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO learned_skill_version
       (id,skill_id,version_no,parent_version_id,description,applicability,
        outcome_contract,content_manifest_hash,scanner_version,scan_decision,
        scan_findings,curator_run_id,created_by_type,created_by)
     VALUES
       ($1,$3,1,NULL,'primary','{}'::jsonb,'{}'::jsonb,$4,'scanner-v1','pass','[]'::jsonb,$6,'system',$7),
       ($2,$3,2,$1,'supporting','{}'::jsonb,'{}'::jsonb,$5,'scanner-v1','pass','[]'::jsonb,$6,'system',$7)`,
    [
      primaryVersionId,
      supportingVersionId,
      skillId,
      hash(`primary:${suffix}`),
      hash(`supporting:${suffix}`),
      curatorRunId,
      `curator_worker_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO learned_skill_version_status (version_id,quality_state)
     VALUES ($1,'active_unproven'),($2,'active_unproven')`,
    [primaryVersionId, supportingVersionId],
  );
  if (skillFileBinding !== "empty") {
    await client.query(
      `INSERT INTO learned_skill_file
         (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
       VALUES ($1,$2,$3,'skill_md',NULL,$4,$5,'text/markdown',$6)`,
      [
        `skill_file_primary_${suffix}`,
        primaryVersionId,
        skillPath,
        skillHash,
        Buffer.byteLength(skillContent, "utf8"),
        skillContent,
      ],
    );
  }
  if (skillFileBinding === "extra") {
    await client.query(
      `INSERT INTO learned_skill_file
         (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
       VALUES ($1,$2,$3,'reference',NULL,$4,$5,'text/markdown',$6)`,
      [
        `skill_file_supporting_${suffix}`,
        supportingVersionId,
        extraSkillPath,
        extraSkillHash,
        Buffer.byteLength(extraSkillContent, "utf8"),
        extraSkillContent,
      ],
    );
  }
  await client.query(
    `INSERT INTO skill_application
       (id,project_id,task_id,observation_key,episode_id,local_goal,state,
        primary_tool_call_id,start_event_sequence,evidence_refs,tool_run_refs,
        created_by_type,created_by)
     VALUES ($1,$2,$3,$4,NULL,$5,'open',$6,1,'[]'::jsonb,'[]'::jsonb,'agent',$3)`,
    [
      applicationId,
      projectId,
      taskId,
      `observation_${suffix}`,
      `goal ${suffix}`,
      `call_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO skill_application_skill
       (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
     VALUES
       ($1,$3,$4,$5,'primary',$7,'[]'::jsonb),
       ($2,$3,$4,$6,'supporting',$8,'[]'::jsonb)`,
    [
      `application_skill_primary_${suffix}`,
      `application_skill_supporting_${suffix}`,
      applicationId,
      skillId,
      primaryVersionId,
      supportingVersionId,
      `call_primary_${suffix}`,
      `call_supporting_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO curator_application_reservation (curator_run_id,application_id)
     VALUES ($1,$2)`,
    [curatorRunId, applicationId],
  );
  await client.query(
    `INSERT INTO evolution_eval_input
       (eval_input_ref,curator_run_id,application_id,project_id,version_id,
        evidence_snapshot_hash,input_manifest_hash,source_commit,
        source_manifest_hash,allowed_operations,trial_bitstream_allowed,part,
        toolchain_profile_hash,input_manifest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ARRAY['synthesize'],false,$10,$11,$12::jsonb)`,
    [
      evalInputRef,
      curatorRunId,
      applicationId,
      projectId,
      inputVersionId,
      hash(`evidence:${suffix}`),
      hash(`input-manifest:${suffix}`),
      "a".repeat(40),
      hash(`source-manifest:${suffix}`),
      "xc7a35tcpg236-1",
      hash(`toolchain:${suffix}`),
      JSON.stringify(inputManifest),
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_input_file
       (eval_input_ref,path,sha256,size_bytes,media_type,managed_content)
     VALUES ($1,$2,$3,$4,'text/x-systemverilog',$5)`,
    [evalInputRef, sourcePath, sourceHash, source.length, source],
  );
  for (const skillFile of inputSkillFiles) {
    await client.query(
      `INSERT INTO evolution_eval_input_skill_file
         (eval_input_ref,version_id,learned_skill_file_id,path,kind,language,
          sha256,size_bytes,media_type,content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        evalInputRef,
        inputVersionId,
        skillFile.learnedSkillFileId,
        skillFile.path,
        skillFile.kind,
        skillFile.language,
        skillFile.sha256,
        skillFile.size_bytes,
        skillFile.media_type,
        skillFile.content,
      ],
    );
  }
  await client.query(
    `INSERT INTO tool_run
       (id,project_id,operation,run_class,state,authorization_context,
        input_manifest_hash,toolchain_profile_hash,parameters,correlation_id)
     VALUES ($1,$2,'synthesize','evolution_eval','submitted','{}'::jsonb,$3,$4,$5::jsonb,$6)`,
    [
      toolRunId,
      projectId,
      hash(`input-manifest:${suffix}`),
      hash(`toolchain:${suffix}`),
      JSON.stringify(parameters),
      `correlation_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_job
       (id,curator_run_id,application_id,project_id,version_id,eval_input_ref,
        input_manifest_hash,evidence_snapshot_hash,tool_run_id,workspace_id,
        connector_job_id,connector_idempotency_key,request_key,prepare_request_hash,
        ordinal,operation,parameters,requested_timeout_ms,effective_timeout_ms,deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,
             'synthesize',$15::jsonb,60000,60000,$16)`,
    [
      evalJobId,
      curatorRunId,
      applicationId,
      projectId,
      inputVersionId,
      evalInputRef,
      hash(`input-manifest:${suffix}`),
      hash(`evidence:${suffix}`),
      toolRunId,
      workspaceId,
      `connector_job_${suffix}`,
      hash(`connector-key:${suffix}`),
      `request_${suffix}`,
      hash(`prepare:${suffix}`),
      JSON.stringify(parameters),
      deadlineAt,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace
       (id,eval_job_id,eval_input_ref,source_commit,input_manifest_hash,source_manifest_hash)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      workspaceId,
      evalJobId,
      evalInputRef,
      "a".repeat(40),
      hash(`input-manifest:${suffix}`),
      hash(`source-manifest:${suffix}`),
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace_revision
       (workspace_id,revision,manifest,manifest_hash,file_count,total_bytes,
        source_files,source_bytes,skill_files,skill_bytes,overlay_files,overlay_bytes)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,1,$7,$8,$9,0,0)`,
    [
      workspaceId,
      initialRevision,
      JSON.stringify({
        schema: "evolution-eval-workspace-manifest.v1",
        workspace_id: workspaceId,
        revision: initialRevision,
        files: workspaceManifestFiles,
      }),
      revisionOneHash,
      workspaceManifestFiles.length,
      source.length + skillBytes,
      source.length,
      workspaceSkillFiles.length,
      skillBytes,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace_file
       (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
     VALUES ($1,$2,$3,$4,$5,'text/x-systemverilog','source',true,$6)`,
    [workspaceId, initialRevision, sourcePath, sourceHash, source.length, source],
  );
  for (const skillFile of workspaceSkillFiles) {
    await client.query(
      `INSERT INTO evolution_eval_workspace_file
         (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
       VALUES ($1,$2,$3,$4,$5,$6,'skill',true,$7)`,
      [
        workspaceId,
        initialRevision,
        skillFile.path,
        skillFile.sha256,
        skillFile.size_bytes,
        skillFile.media_type,
        skillFile.content,
      ],
    );
  }
  await client.query(
    `INSERT INTO evolution_eval_workspace_projection (workspace_id,current_revision)
     VALUES ($1,$2)`,
    [workspaceId, initialRevision],
  );
  const operationContext: OperationFactContext = {
    suffix,
    curatorRunId,
    evalJobId,
    projectId,
    workspaceId,
    inputManifestHash: hash(`input-manifest:${suffix}`),
    prepareRequestHash: hash(`prepare:${suffix}`),
  };
  for (const factType of ["prepare", "workspace_revision", "workspace_projection"] as const) {
    if (options.omitOperationFact === factType) continue;
    await insertOperationFact(
      client,
      operationContext,
      factType,
      initialRevision,
      revisionOneHash,
      workspaceManifestFiles.length,
      source.length + skillBytes,
      options.operationFactOptions?.[factType],
    );
  }

  return {
    suffix,
    projectId,
    taskId,
    curatorRunId,
    applicationId,
    primaryVersionId,
    supportingVersionId,
    inputVersionId,
    evalInputRef,
    toolRunId,
    evalJobId,
    workspaceId,
    sourcePath,
    revisionOneHash,
    deadlineAt,
  };
}

async function createFixture(
  client: Client,
  options: FixtureOptions = {},
): Promise<EvalFixture> {
  let fixture: EvalFixture | undefined;
  await transaction(client, async () => {
    fixture = await insertFixture(client, options);
  });
  return fixture!;
}

async function insertNextJobForRun(
  client: Client,
  prior: EvalFixture,
  ordinal: 2 | 3,
  versionId = prior.primaryVersionId,
): Promise<EvalFixture> {
  const suffix = unique(`fixture_ordinal_${ordinal}`);
  const applicationId = `application_${suffix}`;
  const evalInputRef = `input_${suffix}`;
  const toolRunId = `toolrun_${suffix}`;
  const evalJobId = `evaljob_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const inputManifestHash = hash(`input-manifest:${suffix}`);
  const prepareRequestHash = hash(`prepare:${suffix}`);
  const connectorJobId = `connector_job_${suffix}`;
  const connectorIdempotencyKey = hash(`connector-key:${suffix}`);
  const requestKey = `request_${suffix}`;
  const correlationId = `correlation_${suffix}`;

  await client.query(
    `INSERT INTO skill_application
       (id,project_id,task_id,observation_key,episode_id,local_goal,state,
        primary_tool_call_id,start_event_sequence,evidence_refs,tool_run_refs,
        created_by_type,created_by)
     VALUES ($1,$2,$3,$4,NULL,$5,'open',$6,1,'[]'::jsonb,'[]'::jsonb,'agent',$3)`,
    [
      applicationId,
      prior.projectId,
      prior.taskId,
      `observation_${suffix}`,
      `goal ${suffix}`,
      `call_${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO skill_application_skill
       (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
     SELECT $1,$2,v.skill_id,v.id,'primary',$3,'[]'::jsonb
       FROM learned_skill_version v
      WHERE v.id=$4`,
    [
      `application_skill_primary_${suffix}`,
      applicationId,
      `call_primary_${suffix}`,
      versionId,
    ],
  );
  await client.query(
    `INSERT INTO curator_application_reservation (curator_run_id,application_id)
     VALUES ($1,$2)`,
    [prior.curatorRunId, applicationId],
  );
  await client.query(
    `INSERT INTO evolution_eval_input
       (eval_input_ref,curator_run_id,application_id,project_id,version_id,
        evidence_snapshot_hash,input_manifest_hash,source_commit,
        source_manifest_hash,allowed_operations,trial_bitstream_allowed,part,
        toolchain_profile_hash,input_manifest)
     SELECT $1,i.curator_run_id,$2,i.project_id,$3,
            i.evidence_snapshot_hash,$4,i.source_commit,
            i.source_manifest_hash,i.allowed_operations,i.trial_bitstream_allowed,i.part,
            i.toolchain_profile_hash,
            i.input_manifest || jsonb_build_object(
              'eval_input_ref',$1::text,
              'application_id',$2::text,
              'version_id',$3::text
            )
       FROM evolution_eval_input i
      WHERE i.eval_input_ref=$5`,
    [evalInputRef, applicationId, versionId, inputManifestHash, prior.evalInputRef],
  );
  await client.query(
    `INSERT INTO evolution_eval_input_file
       (eval_input_ref,path,sha256,size_bytes,media_type,managed_content)
     SELECT $1,path,sha256,size_bytes,media_type,managed_content
       FROM evolution_eval_input_file
      WHERE eval_input_ref=$2`,
    [evalInputRef, prior.evalInputRef],
  );
  await client.query(
    `INSERT INTO evolution_eval_input_skill_file
       (eval_input_ref,version_id,learned_skill_file_id,path,kind,language,
        sha256,size_bytes,media_type,content)
     SELECT $1,version_id,learned_skill_file_id,path,kind,language,
            sha256,size_bytes,media_type,content
       FROM evolution_eval_input_skill_file
      WHERE eval_input_ref=$2 AND version_id=$3`,
    [evalInputRef, prior.evalInputRef, versionId],
  );
  await client.query(
    `INSERT INTO tool_run
       (id,project_id,operation,run_class,state,authorization_context,
        input_manifest_hash,toolchain_profile_hash,parameters,correlation_id)
     SELECT $1,r.project_id,r.operation,'evolution_eval','submitted',r.authorization_context,
            $2,r.toolchain_profile_hash,r.parameters,$3
       FROM tool_run r
      WHERE r.id=$4`,
    [toolRunId, inputManifestHash, correlationId, prior.toolRunId],
  );
  await client.query(
    `INSERT INTO evolution_eval_job
       (id,curator_run_id,application_id,project_id,version_id,eval_input_ref,
        input_manifest_hash,evidence_snapshot_hash,tool_run_id,workspace_id,
        connector_job_id,connector_idempotency_key,request_key,prepare_request_hash,
        ordinal,operation,parameters,requested_timeout_ms,effective_timeout_ms,deadline_at)
     SELECT $1,j.curator_run_id,$2,j.project_id,$3,$4,
            $5,j.evidence_snapshot_hash,$6,$7,$8,$9,$10,$11,$12,
            j.operation,j.parameters,j.requested_timeout_ms,j.effective_timeout_ms,j.deadline_at
       FROM evolution_eval_job j
      WHERE j.id=$13`,
    [
      evalJobId,
      applicationId,
      versionId,
      evalInputRef,
      inputManifestHash,
      toolRunId,
      workspaceId,
      connectorJobId,
      connectorIdempotencyKey,
      requestKey,
      prepareRequestHash,
      ordinal,
      prior.evalJobId,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace
       (id,eval_job_id,eval_input_ref,source_commit,input_manifest_hash,source_manifest_hash)
     SELECT $1,$2,$3,w.source_commit,$4,w.source_manifest_hash
       FROM evolution_eval_workspace w
      WHERE w.id=$5`,
    [workspaceId, evalJobId, evalInputRef, inputManifestHash, prior.workspaceId],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace_revision
       (workspace_id,revision,manifest,manifest_hash,file_count,total_bytes,
        source_files,source_bytes,skill_files,skill_bytes,overlay_files,overlay_bytes)
     SELECT $1,r.revision,
            r.manifest || jsonb_build_object('workspace_id',$1::text),
            r.manifest_hash,r.file_count,r.total_bytes,
            r.source_files,r.source_bytes,r.skill_files,r.skill_bytes,
            r.overlay_files,r.overlay_bytes
       FROM evolution_eval_workspace_revision r
      WHERE r.workspace_id=$2 AND r.revision=1`,
    [workspaceId, prior.workspaceId],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace_file
       (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
     SELECT $1,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content
       FROM evolution_eval_workspace_file
      WHERE workspace_id=$2 AND revision=1`,
    [workspaceId, prior.workspaceId],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace_projection (workspace_id,current_revision)
     VALUES ($1,1)`,
    [workspaceId],
  );

  const revision = await client.query<{
    manifest_hash: string;
    file_count: number;
    total_bytes: string;
  }>(
    `SELECT manifest_hash,file_count,total_bytes::text
       FROM evolution_eval_workspace_revision
      WHERE workspace_id=$1 AND revision=1`,
    [workspaceId],
  );
  const revisionOneHash = revision.rows[0]!.manifest_hash;
  const operationContext: OperationFactContext = {
    suffix,
    curatorRunId: prior.curatorRunId,
    evalJobId,
    projectId: prior.projectId,
    workspaceId,
    inputManifestHash,
    prepareRequestHash,
  };
  for (const factType of ["prepare", "workspace_revision", "workspace_projection"] as const) {
    await insertOperationFact(
      client,
      operationContext,
      factType,
      1,
      revisionOneHash,
      revision.rows[0]!.file_count,
      Number(revision.rows[0]!.total_bytes),
    );
  }

  return {
    suffix,
    projectId: prior.projectId,
    taskId: prior.taskId,
    curatorRunId: prior.curatorRunId,
    applicationId,
    primaryVersionId: versionId,
    supportingVersionId: prior.supportingVersionId,
    inputVersionId: versionId,
    evalInputRef,
    toolRunId,
    evalJobId,
    workspaceId,
    sourcePath: prior.sourcePath,
    revisionOneHash,
    deadlineAt: prior.deadlineAt,
  };
}

function operationContextFor(fixture: EvalFixture): OperationFactContext {
  return {
    suffix: fixture.suffix,
    curatorRunId: fixture.curatorRunId,
    evalJobId: fixture.evalJobId,
    projectId: fixture.projectId,
    workspaceId: fixture.workspaceId,
    inputManifestHash: hash(`input-manifest:${fixture.suffix}`),
    prepareRequestHash: hash(`prepare:${fixture.suffix}`),
  };
}

interface TransitionOptions {
  readonly audit?: boolean;
  readonly outbox?: boolean;
  readonly fact?: boolean;
  readonly label?: string;
  readonly unknownFactHash?: string;
}

async function insertTransitionFacts(
  client: Client,
  fixture: EvalFixture,
  fromState: string,
  toState: string,
  transitionSequence: number,
  options: TransitionOptions = {},
): Promise<{ readonly auditId: string; readonly outboxId: string; readonly factId: string }> {
  const label = options.label ?? `${fromState}_${toState}`;
  const auditId = unique(`audit_${label}`);
  const outboxId = randomUUID();
  const factId = unique(`transition_${label}`);
  const eventType = toState === "unknown_effect"
    ? "evolution_eval.unknown_effect"
    : "evolution_eval.tool_run_transition";
  const payload: Record<string, string> = {
    from_state: fromState,
    to_state: toState,
  };
  if (options.unknownFactHash) payload.fact_hash = options.unknownFactHash;

  if (options.audit !== false) {
    await client.query(
      `INSERT INTO evolution_eval_audit_event
         (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
          correlation_id,from_state,to_state,operation)
       VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,$7,$8,'synthesize')`,
      [
        auditId,
        fixture.curatorRunId,
        fixture.evalJobId,
        fixture.projectId,
        `evaluator_${fixture.suffix}`,
        `correlation_${fixture.suffix}`,
        fromState,
        toState,
      ],
    );
  }
  if (options.outbox !== false) {
    await client.query(
      `INSERT INTO outbox_events
         (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
          correlation_id,classification)
       VALUES ($1,'evolution_eval_job',$2,$3,$4,$5,$6::jsonb,$7,'D1')`,
      [
        outboxId,
        fixture.evalJobId,
        nextOutboxSequence(),
        eventType,
        fixture.projectId,
        JSON.stringify(payload),
        `correlation_${fixture.suffix}`,
      ],
    );
  }
  if (options.fact !== false) {
    await client.query(
      `INSERT INTO evolution_eval_transition_fact
         (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [factId, fixture.evalJobId, transitionSequence, fromState, toState, auditId, outboxId],
    );
  }
  return { auditId, outboxId, factId };
}

async function advanceToRunningInCurrentTransaction(
  client: Client,
  fixture: EvalFixture,
): Promise<void> {
  const dispatch = await client.query(
    "SELECT 1 FROM evolution_eval_dispatch WHERE eval_job_id=$1",
    [fixture.evalJobId],
  );
  if (dispatch.rowCount === 0) await insertDispatch(client, fixture);
  const edges = [
    ["submitted", "queued"],
    ["queued", "preparing"],
    ["preparing", "running"],
  ] as const;
  for (const [index, [fromState, toState]] of edges.entries()) {
    await insertTransitionFacts(client, fixture, fromState, toState, index + 1);
    await client.query("UPDATE tool_run SET state=$2 WHERE id=$1", [fixture.toolRunId, toState]);
  }
}

async function advanceToRunning(client: Client, fixture: EvalFixture): Promise<void> {
  await transaction(client, async () => {
    await advanceToRunningInCurrentTransaction(client, fixture);
  });
}

async function advanceToSucceeded(
  client: Client,
  fixture: EvalFixture,
  endTime: Date = new Date(),
): Promise<void> {
  await advanceToRunning(client, fixture);
  await transaction(client, async () => {
    await insertTransitionFacts(client, fixture, "running", "succeeded", 4);
    await client.query(
      "UPDATE tool_run SET state='succeeded',end_time=$2 WHERE id=$1",
      [fixture.toolRunId, endTime],
    );
  });
}

async function advanceToUnknown(client: Client, fixture: EvalFixture): Promise<void> {
  await advanceToRunning(client, fixture);
  await transaction(client, async () => {
    await advanceRunningToUnknownInCurrentTransaction(client, fixture);
  });
}

async function advanceRunningToUnknownInCurrentTransaction(
  client: Client,
  fixture: EvalFixture,
): Promise<void> {
  const factHash = hash(`unknown:${fixture.suffix}`);
  const latchedAt = new Date();
  const transition = await insertTransitionFacts(
    client,
    fixture,
    "running",
    "unknown_effect",
    4,
    { unknownFactHash: factHash },
  );
  await client.query(
    "UPDATE evolution_eval_run SET unknown_effect_latched_at=$2 WHERE curator_run_id=$1",
    [fixture.curatorRunId, latchedAt],
  );
  await client.query(
    `INSERT INTO evolution_eval_unknown_fact
       (eval_job_id,transition_fact_id,audit_event_id,outbox_event_id,fact_hash,latched_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      fixture.evalJobId,
      transition.factId,
      transition.auditId,
      transition.outboxId,
      factHash,
      latchedAt,
    ],
  );
  await client.query(
    "UPDATE tool_run SET state='unknown_effect',end_time=now() WHERE id=$1",
    [fixture.toolRunId],
  );
}

async function insertRevision(
  client: Client,
  fixture: EvalFixture,
  revision: number,
  options: {
    readonly declaredFiles?: number;
    readonly declaredBytes?: number;
    readonly omitSource?: boolean;
    readonly omitOperationFact?: "workspace_revision" | "workspace_projection";
    readonly operationFactOptions?: Readonly<Partial<Record<
      "workspace_revision" | "workspace_projection",
      {
        readonly audit?: boolean;
        readonly outbox?: boolean;
        readonly payloadExtra?: Readonly<Record<string, unknown>>;
        readonly headers?: Readonly<Record<string, unknown>>;
      }
    >>>;
  } = {},
): Promise<string> {
  const content = Buffer.from(`revision ${revision}\n`, "utf8");
  const contentHash = hash(content);
  const source = Buffer.from("module top; endmodule\n", "utf8");
  const sourceHash = hash(source);
  const manifestHash = hash(`workspace:${fixture.suffix}:${revision}`);
  const sourceFiles = options.omitSource ? 0 : 1;
  const sourceBytes = options.omitSource ? 0 : source.length;
  const declaredFiles = options.declaredFiles ?? sourceFiles + 1;
  const declaredBytes = options.declaredBytes ?? sourceBytes + content.length;
  const manifestFiles = [
    {
      path: `generated/revision-${revision}.sv`,
      sha256: contentHash,
      size_bytes: content.length,
      media_type: "text/x-systemverilog",
      layer: "overlay",
      read_only: false,
    },
    ...options.omitSource ? [] : [{
      path: fixture.sourcePath,
      sha256: sourceHash,
      size_bytes: source.length,
      media_type: "text/x-systemverilog",
      layer: "source",
      read_only: true,
    }],
  ];
  await client.query(
    `INSERT INTO evolution_eval_workspace_revision
       (workspace_id,revision,manifest,manifest_hash,file_count,total_bytes,
        source_files,source_bytes,skill_files,skill_bytes,overlay_files,overlay_bytes)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,0,0,$9,$10)`,
    [
      fixture.workspaceId,
      revision,
      JSON.stringify({
        schema: "evolution-eval-workspace-manifest.v1",
        workspace_id: fixture.workspaceId,
        revision,
        files: manifestFiles,
      }),
      manifestHash,
      declaredFiles,
      declaredBytes,
      sourceFiles,
      sourceBytes,
      declaredFiles - sourceFiles,
      declaredBytes - sourceBytes,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_workspace_file
       (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
     VALUES ($1,$2,$3,$4,$5,'text/x-systemverilog','overlay',false,$6)`,
    [
      fixture.workspaceId,
      revision,
      `generated/revision-${revision}.sv`,
      contentHash,
      content.length,
      content,
    ],
  );
  if (!options.omitSource) {
    await client.query(
      `INSERT INTO evolution_eval_workspace_file
         (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
       VALUES ($1,$2,$3,$4,$5,'text/x-systemverilog','source',true,$6)`,
      [fixture.workspaceId, revision, fixture.sourcePath, sourceHash, source.length, source],
    );
  }
  for (const factType of ["workspace_revision", "workspace_projection"] as const) {
    if (options.omitOperationFact === factType) continue;
    await insertOperationFact(
      client,
      operationContextFor(fixture),
      factType,
      revision,
      manifestHash,
      declaredFiles,
      declaredBytes,
      options.operationFactOptions?.[factType],
    );
  }
  return manifestHash;
}

async function insertDispatch(
  client: Client,
  fixture: EvalFixture,
  revision = 1,
  manifestHash = fixture.revisionOneHash,
  seal = true,
  operationFact = true,
): Promise<void> {
  const auditId = unique("dispatch_audit");
  const outboxId = randomUUID();
  const dispatchRequestHash = hash(`dispatch:${fixture.suffix}`);
  const revisionResult = await client.query(
    `SELECT manifest
       FROM evolution_eval_workspace_revision
      WHERE workspace_id=$1 AND revision=$2`,
    [fixture.workspaceId, revision],
  );
  const sealedInputProjectionHash = canonicalEvolutionEvalSealedInputProjection(
    revisionResult.rows[0]!.manifest,
  ).sha256;
  await client.query(
    `INSERT INTO evolution_eval_audit_event
       (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
        correlation_id,request_hash,operation,workspace_manifest_hash)
     VALUES ($1,$2,$3,$4,'dispatch_sealed','service',$5,$6,$7,'synthesize',$8)`,
    [
      auditId,
      fixture.curatorRunId,
      fixture.evalJobId,
      fixture.projectId,
      `evaluator_${fixture.suffix}`,
      `correlation_${fixture.suffix}`,
      dispatchRequestHash,
      manifestHash,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
       (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
        correlation_id,classification)
     VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.dispatch_requested',$4,
             $5::jsonb,$6,'D1')`,
    [
      outboxId,
      fixture.evalJobId,
      nextOutboxSequence(),
      fixture.projectId,
      JSON.stringify({ dispatch_request_hash: dispatchRequestHash }),
      `correlation_${fixture.suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_dispatch
       (eval_job_id,workspace_id,workspace_revision,workspace_manifest_hash,
        sealed_input_projection_hash,dispatch_request_hash,requested_timeout_ms,deadline_at,
        audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,60000,$7,$8,$9)`,
    [
      fixture.evalJobId,
      fixture.workspaceId,
      revision,
      manifestHash,
      sealedInputProjectionHash,
      dispatchRequestHash,
      fixture.deadlineAt,
      auditId,
      outboxId,
    ],
  );
  if (seal) {
    await client.query(
      "UPDATE evolution_eval_workspace_projection SET sealed_at=now(),updated_at=now() WHERE workspace_id=$1",
      [fixture.workspaceId],
    );
    const revisionFacts = await client.query<{ file_count: number; total_bytes: string }>(
      `SELECT file_count,total_bytes::text
         FROM evolution_eval_workspace_revision
        WHERE workspace_id=$1 AND revision=$2`,
      [fixture.workspaceId, revision],
    );
    if (operationFact) {
      await insertOperationFact(
        client,
        operationContextFor(fixture),
        "workspace_seal",
        revision,
        manifestHash,
        Number(revisionFacts.rows[0]?.file_count ?? 0),
        Number(revisionFacts.rows[0]?.total_bytes ?? 0),
      );
    }
  }
}

async function insertTombstone(client: Client, fixture: EvalFixture): Promise<void> {
  const reasonCode = "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH";
  const errorHash = hash(`tombstone:${fixture.suffix}`);
  const auditId = unique("tombstone_audit");
  const outboxId = randomUUID();
  await insertTransitionFacts(client, fixture, "submitted", "rejected", 1);
  await client.query(
    "UPDATE tool_run SET state='rejected',error_code=$2,end_time=now() WHERE id=$1",
    [fixture.toolRunId, reasonCode],
  );
  await client.query(
    `INSERT INTO evolution_eval_audit_event
       (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
        correlation_id,request_hash,operation,error_code)
     VALUES ($1,$2,$3,$4,'dispatch_tombstone','service',$5,$6,$7,'synthesize',$8)`,
    [
      auditId,
      fixture.curatorRunId,
      fixture.evalJobId,
      fixture.projectId,
      `evaluator_${fixture.suffix}`,
      `correlation_${fixture.suffix}`,
      errorHash,
      reasonCode,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
       (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
        correlation_id,classification)
     VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.dispatch_tombstoned',$4,
             $5::jsonb,$6,'D1')`,
    [
      outboxId,
      fixture.evalJobId,
      nextOutboxSequence(),
      fixture.projectId,
      JSON.stringify({ error_hash: errorHash }),
      `correlation_${fixture.suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO evolution_eval_dispatch_tombstone
       (eval_job_id,reason_code,error_hash,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [fixture.evalJobId, reasonCode, errorHash, auditId, outboxId],
  );
}

async function insertEvidenceFact(
  client: Client,
  fixture: EvalFixture,
  factType: string,
  manifestHash: string | null = null,
  options: {
    readonly audit?: boolean;
    readonly outbox?: boolean;
    readonly errorCode?: string | null;
    readonly manifest?: Readonly<Record<string, unknown>> | null;
    readonly entryCount?: number;
    readonly totalBytes?: number;
  } = {},
): Promise<string> {
  const id = unique(`evidence_${factType}`);
  const errorCode = options.errorCode !== undefined
    ? options.errorCode
    : factType === "corrupt"
      ? "EVOLUTION_EVAL_EVIDENCE_CORRUPT"
      : factType === "unavailable_at_deadline"
        ? "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE"
        : null;
  const effectiveManifestHash = manifestHash ?? (
    factType === "frozen" || factType === "ack_pending" || factType === "acknowledged"
      || factType === "expired"
      ? hash(`manifest:${fixture.suffix}`)
      : null
  );
  const factHash = hash(`fact:${id}`);
  const connectorManifestHash = factType === "frozen"
    ? hash(`connector-manifest:${id}`)
    : null;
  const auditId = unique(`audit_evidence_${factType}`);
  const outboxId = randomUUID();
  const manifest = options.manifest !== undefined
    ? options.manifest
    : factType === "frozen"
      ? {
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: fixture.evalJobId,
      tool_run_id: fixture.toolRunId,
      entries: [],
      }
      : null;
  const entryCount = options.entryCount ?? 0;
  const totalBytes = options.totalBytes ?? 0;
  const eventTypeByFact: Readonly<Record<string, string>> = {
    freeze_pending: "evolution_eval.evidence.freeze_requested",
    frozen: "evolution_eval.evidence.frozen",
    corrupt: "evolution_eval.evidence.corrupt",
    unavailable_at_deadline: "evolution_eval.evidence.unavailable_at_deadline",
    ack_pending: "evolution_eval.evidence.ack_requested",
    acknowledged: "evolution_eval.evidence.acknowledged",
    quarantine_pending: "evolution_eval.evidence.quarantine_requested",
    expired: "evolution_eval.evidence.expired",
    cleanup_pending: "evolution_eval.evidence.cleanup_requested",
    cleaned: "evolution_eval.evidence.cleaned",
  };
  if (options.audit !== false) {
    await client.query(
      `INSERT INTO evolution_eval_audit_event
         (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
          correlation_id,request_hash,operation,evidence_manifest_hash,
          file_count,byte_count,error_code)
       VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$8,'synthesize',$9,$10,$11,$12)`,
      [
        auditId,
        fixture.curatorRunId,
        fixture.evalJobId,
        fixture.projectId,
        `evidence.${factType}`,
        `evaluator_${fixture.suffix}`,
        `correlation_${fixture.suffix}`,
        factHash,
        effectiveManifestHash,
        factType === "frozen" ? entryCount : null,
        factType === "frozen" ? totalBytes : null,
        errorCode,
      ],
    );
  }
  if (options.outbox !== false) {
    const payload: Record<string, string> = {
      fact_id: id,
      fact_type: factType,
      fact_hash: factHash,
    };
    if (effectiveManifestHash !== null) payload.manifest_hash = effectiveManifestHash;
    if (errorCode !== null) payload.error_code = errorCode;
    await client.query(
      `INSERT INTO outbox_events
         (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
          headers,correlation_id,causation_id,classification)
       VALUES ($1,'evolution_eval_job',$2,$3,$4,$5,$6::jsonb,'{}'::jsonb,$7,NULL,'D1')`,
      [
        outboxId,
        fixture.evalJobId,
        nextOutboxSequence(),
        eventTypeByFact[factType],
        fixture.projectId,
        JSON.stringify(payload),
        `correlation_${fixture.suffix}`,
      ],
    );
  }
  await client.query(
    `INSERT INTO evolution_eval_evidence_fact
       (id,eval_job_id,fact_type,manifest_hash,connector_manifest_hash,error_code,
        fact_hash,manifest,entry_count,total_bytes,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
    [
      id,
      fixture.evalJobId,
      factType,
      effectiveManifestHash,
      connectorManifestHash,
      errorCode,
      factHash,
      manifest === null ? null : JSON.stringify(manifest),
      entryCount,
      totalBytes,
      auditId,
      outboxId,
    ],
  );
  return id;
}

async function insertRetentionTerminalFact(
  client: Client,
  fixture: EvalFixture,
  factType: "acknowledged" | "cleaned",
): Promise<string> {
  const receiptType = factType === "acknowledged" ? "acknowledgement" : "cleanup";
  const pendingFactType = factType === "acknowledged" ? "ack_pending" : "cleanup_pending";
  const connectorState = factType === "acknowledged" ? "acknowledged" : "cleaned";
  const eventType = factType === "acknowledged"
    ? "evolution_eval.evidence.ack_requested"
    : "evolution_eval.evidence.cleanup_requested";
  const pending = await client.query<{
    fact_hash: string;
    outbox_event_id: string;
    manifest_hash: string | null;
  }>(
    `SELECT fact_hash,outbox_event_id,manifest_hash
       FROM evolution_eval_evidence_fact
      WHERE eval_job_id=$1 AND fact_type=$2`,
    [fixture.evalJobId, pendingFactType],
  );
  if (pending.rows.length !== 1) {
    throw new Error(`expected one ${pendingFactType} fact`);
  }
  const authorization = pending.rows[0]!;
  const holderId = `retention-fixture-${fixture.suffix}`.slice(0, 128);
  const leaseNonceHash = hash(`retention-lease:${factType}:${fixture.suffix}`);
  await client.query(
    `INSERT INTO evolution_eval_dispatcher_lease
       (event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
        lease_expires_at,attempt_count)
     VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '1 minute',1)`,
    [
      authorization.outbox_event_id,
      eventType,
      fixture.evalJobId,
      holderId,
      leaseNonceHash,
    ],
  );
  const source = factType === "cleaned"
    ? (await client.query<{
      authorization_hash: string;
      connector_fact_hash: string;
    }>(
      `SELECT authorization_hash,connector_fact_hash
         FROM evolution_eval_retention_receipt
        WHERE eval_job_id=$1 AND receipt_type='acknowledgement'`,
      [fixture.evalJobId],
    )).rows[0]
    : undefined;
  if (factType === "cleaned" && source === undefined) {
    throw new Error("expected acknowledgement receipt before cleanup");
  }
  const terminalFactId = await insertEvidenceFact(
    client,
    fixture,
    factType,
    factType === "acknowledged" ? authorization.manifest_hash : null,
  );
  await client.query(
    `INSERT INTO evolution_eval_retention_receipt
       (id,eval_job_id,receipt_type,connector_state,authorization_hash,
        connector_fact_hash,source_authorization_kind,source_authorization_hash,
        source_connector_fact_hash,outbox_event_id,holder_id,lease_nonce_hash,
        lease_attempt_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)`,
    [
      randomUUID(),
      fixture.evalJobId,
      receiptType,
      connectorState,
      authorization.fact_hash,
      hash(`connector-retention:${factType}:${fixture.suffix}`),
      source === undefined ? null : "ack",
      source?.authorization_hash ?? null,
      source?.connector_fact_hash ?? null,
      authorization.outbox_event_id,
      holderId,
      leaseNonceHash,
    ],
  );
  return terminalFactId;
}

async function insertEvidenceEntry(
  client: Client,
  fixture: EvalFixture,
  factId: string,
  name: string,
  content = Buffer.alloc(0),
): Promise<void> {
  await client.query(
    `INSERT INTO evolution_eval_evidence_entry
       (id,evidence_fact_id,eval_job_id,name,sha256,size_bytes,media_type,
        artifact_classification,usage_classification,managed_content)
     VALUES ($1,$2,$3,$4,$5,$6,'application/octet-stream',
             'evolution_eval_evidence','evolution_eval_only',$7)`,
    [unique("entry"), factId, fixture.evalJobId, name, hash(content), content.length, content],
  );
}

async function freezeEmptyEvidence(client: Client, fixture: EvalFixture): Promise<string> {
  await transaction(client, async () => {
    await insertEvidenceFact(client, fixture, "freeze_pending");
  });
  let frozenId = "";
  await transaction(client, async () => {
    frozenId = await insertEvidenceFact(client, fixture, "frozen");
  });
  return frozenId;
}

describe("evolution-eval portable path parity", () => {
  test.each([
    "rtl/top.sv",
    "constraints/board-1.xdc",
    "generated/trial_01/report.rpt",
  ])("TypeScript accepts the portable ASCII path %s", (path) => {
    expect(portableEvolutionEvalPath(path)).toBe(path);
  });

  test.each([
    "rtl/\u4e3b\u63a7.sv",
    "rtl/\u0130.sv",
    "rtl/emoji-\ud83d\ude80.sv",
    "rtl/e\u0301.sv",
    "CON.v",
    "rtl/PRN.sv",
    "rtl/AUX.xdc",
    "rtl/NUL.v",
    "rtl/COM1.v",
    "dir/LPT1.sv",
    "rtl/com9.test.sv",
    "rtl/lpt9.v",
    "rtl/foo./top.sv",
  ])("TypeScript rejects the non-portable path %s", (path) => {
    expect(() => portableEvolutionEvalPath(path)).toThrow();
  });

  test("TypeScript uses deterministic ASCII case-folded portable keys", () => {
    expect(portablePathKey("RTL/Top.SV")).toBe(portablePathKey("rtl/top.sv"));
  });
});

describe.skipIf(!DATABASE_URL)("evolution-eval PostgreSQL adversarial invariants", () => {
  const databaseName = `synthia_m4d_invariants_${randomUUID().replaceAll("-", "")}`;
  const testDatabaseUrl = DATABASE_URL ? databaseUrl(databaseName) : "";
  let admin: Client;
  let client: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);

    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDatabaseUrl;
    try {
      await migrate();
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }

    client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  test("production migrate() creates the fresh evolution-eval schema", async () => {
    const result = await client.query(
      `SELECT version FROM schema_migrations
        WHERE version='0029_evolution_eval'`,
    );
    expect(result.rowCount).toBe(1);
  });

  test("ASCII portable folding remains deterministic under an available ICU collation", async () => {
    const available = await client.query<{ qualified_name: string }>(
      `SELECT format('%I.%I',n.nspname,c.collname) AS qualified_name
         FROM pg_collation c
         JOIN pg_namespace n ON n.oid=c.collnamespace
        WHERE c.collprovider='i'
          AND c.collname NOT IN ('default','C','POSIX')
        ORDER BY c.oid
        LIMIT 1`,
    );
    if (available.rowCount === 0) return;

    const corpus = [
      "RTL/Top.SV",
      "rtl/top.sv",
      "Constraints/BOARD-1.XDC",
      "generated/TRIAL_01/report.RPT",
      "A0/Z9._-",
    ];
    const folded = await client.query<{ path: string; portable_key: string }>(
      `SELECT path,
              translate(path COLLATE ${available.rows[0]!.qualified_name},
                        'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                        'abcdefghijklmnopqrstuvwxyz') COLLATE "C" AS portable_key
         FROM unnest($1::text[]) WITH ORDINALITY AS corpus(path,ordinal)
        ORDER BY ordinal`,
      [corpus],
    );
    expect(folded.rows).toEqual(corpus.map((path) => ({
      path,
      portable_key: portablePathKey(path),
    })));
  });

  test("rejects an orphan submitted evolution_eval ToolRun", async () => {
    const suffix = unique("orphan_submitted");
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO project
           (id,name,scope,project_type,process_version_id,process_profile_id,
            process_profile_version,process_profile_name,status)
         VALUES ($1,$1,'','free',NULL,NULL,NULL,NULL,'active')`,
        [`project_${suffix}`],
      );
      await client.query(
        `INSERT INTO tool_run (id,project_id,operation,run_class,state,correlation_id)
         VALUES ($1,$2,'synthesize','evolution_eval','submitted',$3)`,
        [`toolrun_${suffix}`, `project_${suffix}`, `correlation_${suffix}`],
      );
    });
    expect(rejected).toBe(true);
  });

  test("rejects a direct terminal evolution_eval ToolRun insert", async () => {
    const suffix = unique("direct_terminal");
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO project
           (id,name,scope,project_type,process_version_id,process_profile_id,
            process_profile_version,process_profile_name,status)
         VALUES ($1,$1,'','free',NULL,NULL,NULL,NULL,'active')`,
        [`project_${suffix}`],
      );
      await client.query(
        `INSERT INTO tool_run (id,project_id,operation,run_class,state,correlation_id)
         VALUES ($1,$2,'synthesize','evolution_eval','succeeded',$3)`,
        [`toolrun_${suffix}`, `project_${suffix}`, `correlation_${suffix}`],
      );
    });
    expect(rejected).toBe(true);
  });

  test("accepts one complete initial submitted binding graph with an empty Skill file set", async () => {
    const fixture = await createFixture(client);
    const result = await client.query(
      `SELECT r.state::text,w.current_revision,a.event_type,
              (SELECT count(*)::int FROM evolution_eval_input_skill_file
                WHERE eval_input_ref=j.eval_input_ref) AS input_skill_files,
              (SELECT count(*)::int FROM evolution_eval_workspace_file
                WHERE workspace_id=j.workspace_id AND revision=1 AND layer='skill')
                AS workspace_skill_files
         FROM tool_run r
         JOIN evolution_eval_job j ON j.tool_run_id=r.id
         JOIN evolution_eval_workspace_projection w ON w.workspace_id=j.workspace_id
         JOIN evolution_eval_audit_event a ON a.eval_job_id=j.id
        WHERE j.id=$1 AND a.event_type='eval_job.prepared'`,
      [fixture.evalJobId],
    );
    expect(result.rows).toEqual([{
      state: "submitted",
      current_revision: 1,
      event_type: "eval_job.prepared",
      input_skill_files: 0,
      workspace_skill_files: 0,
    }]);
  });

  test("accepts same-transaction SkillVersion files plus exact input and workspace binding", async () => {
    const fixture = await createFixture(client, { skillFileBinding: "valid" });
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM learned_skill_file WHERE version_id=$2) AS learned_files,
         (SELECT count(*)::int FROM evolution_eval_input_skill_file
           WHERE eval_input_ref=$3) AS input_files,
         (SELECT count(*)::int FROM evolution_eval_workspace_file
           WHERE workspace_id=$1 AND revision=1 AND layer='skill') AS workspace_files`,
      [fixture.workspaceId, fixture.primaryVersionId, fixture.evalInputRef],
    );
    expect(result.rows).toEqual([{
      learned_files: 1,
      input_files: 1,
      workspace_files: 1,
    }]);
  });

  test("rejects a late Skill file after an eval input and workspace already fixed the version", async () => {
    const fixture = await createFixture(client);
    const content = "# Late mutation\n";
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO learned_skill_file
           (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,'SKILL.md','skill_md',NULL,$3,$4,'text/markdown',$5)`,
        [
          unique("late_bound_skill_file"),
          fixture.primaryVersionId,
          hash(content),
          Buffer.byteLength(content, "utf8"),
          content,
        ],
      );
    });
    expect(rejected).toBe(true);
  });

  test("allows a late Skill file for an ordinary version with no eval input", async () => {
    const fixture = await createFixture(client);
    const content = "# Supporting guidance\n";
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO learned_skill_file
           (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,'SKILL.md','skill_md',NULL,$3,$4,'text/markdown',$5)`,
        [
          unique("unbound_skill_file"),
          fixture.supportingVersionId,
          hash(content),
          Buffer.byteLength(content, "utf8"),
          content,
        ],
      );
    });
    expect(rejected).toBe(false);

    const result = await client.query<{ file_count: number }>(
      "SELECT count(*)::int AS file_count FROM learned_skill_file WHERE version_id=$1",
      [fixture.supportingVersionId],
    );
    expect(result.rows[0]?.file_count).toBe(1);
  });

  async function skillFileInputRace(
    fixture: EvalFixture,
    first: "input" | "file",
  ): Promise<{
    readonly successes: number;
    readonly errorCodes: readonly string[];
    readonly learnedFiles: number;
    readonly evalInputs: number;
    readonly inputSkillFiles: number;
    readonly manifestSkillFiles: number;
    readonly workspaceSkillFiles: number;
    readonly exactSetDrift: boolean;
  }> {
    const firstClient = new Client({ connectionString: testDatabaseUrl });
    const secondClient = new Client({ connectionString: testDatabaseUrl });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    const versionId = fixture.supportingVersionId;
    const content = "# Concurrent Skill file\n";
    let successes = 0;
    const errorCodes: string[] = [];

    const errorCode = (error: unknown): string => (
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code ?? "unknown")
        : "unknown"
    );
    const insertFile = async (target: Client): Promise<void> => {
      await target.query(
        `INSERT INTO learned_skill_file
           (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,'SKILL.md','skill_md',NULL,$3,$4,'text/markdown',$5)`,
        [
          unique("racing_skill_file"),
          versionId,
          hash(content),
          Buffer.byteLength(content, "utf8"),
          content,
        ],
      );
    };
    const insertInput = async (target: Client): Promise<void> => {
      await insertNextJobForRun(target, fixture, 2, versionId);
    };

    try {
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await firstClient.query("SET LOCAL statement_timeout='15s'");
      await secondClient.query("SET LOCAL statement_timeout='15s'");
      await firstClient.query(
        "SELECT id FROM learned_skill_version WHERE id=$1 FOR UPDATE",
        [versionId],
      );

      // Promise creation is the barrier. The second transaction is visibly
      // queued on the same SkillVersion before the first mutates or commits;
      // no timing sleep participates in either winner order.
      const secondLock = secondClient.query(
        "SELECT id FROM learned_skill_version WHERE id=$1 FOR UPDATE",
        [versionId],
      );

      try {
        if (first === "input") await insertInput(firstClient);
        else await insertFile(firstClient);
        await firstClient.query("COMMIT");
        successes += 1;
      } catch (error) {
        errorCodes.push(errorCode(error));
        await firstClient.query("ROLLBACK").catch(() => undefined);
      }

      try {
        await secondLock;
        if (first === "input") await insertFile(secondClient);
        else await insertInput(secondClient);
        await secondClient.query("COMMIT");
        successes += 1;
      } catch (error) {
        errorCodes.push(errorCode(error));
        await secondClient.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }

    const result = await client.query<{
      learned_files: number;
      eval_inputs: number;
      input_skill_files: number;
      manifest_skill_files: number;
      workspace_skill_files: number;
      exact_set_drift: boolean;
    }>(
      `WITH counts AS (
         SELECT
           (SELECT count(*)::int
              FROM learned_skill_file f
             WHERE f.version_id=$1) AS learned_files,
           (SELECT count(*)::int
              FROM evolution_eval_input i
             WHERE i.version_id=$1) AS eval_inputs,
           (SELECT count(*)::int
              FROM evolution_eval_input_skill_file f
              JOIN evolution_eval_input i ON i.eval_input_ref=f.eval_input_ref
             WHERE i.version_id=$1) AS input_skill_files,
           (SELECT COALESCE(sum(jsonb_array_length(i.input_manifest->'skill_files')),0)::int
              FROM evolution_eval_input i
             WHERE i.version_id=$1) AS manifest_skill_files,
           (SELECT count(*)::int
              FROM evolution_eval_workspace_file f
              JOIN evolution_eval_workspace w ON w.id=f.workspace_id
              JOIN evolution_eval_input i ON i.eval_input_ref=w.eval_input_ref
             WHERE i.version_id=$1 AND f.layer='skill') AS workspace_skill_files
       )
       SELECT *,
              eval_inputs>0 AND (
                learned_files<>input_skill_files
                OR input_skill_files<>manifest_skill_files
                OR input_skill_files<>workspace_skill_files
              ) AS exact_set_drift
         FROM counts`,
      [versionId],
    );
    const row = result.rows[0]!;
    return {
      successes,
      errorCodes,
      learnedFiles: Number(row.learned_files),
      evalInputs: Number(row.eval_inputs),
      inputSkillFiles: Number(row.input_skill_files),
      manifestSkillFiles: Number(row.manifest_skill_files),
      workspaceSkillFiles: Number(row.workspace_skill_files),
      exactSetDrift: row.exact_set_drift,
    };
  }

  test.each(["input", "file"] as const)(
    "serializes the Skill exact-set race when %s locks the version first",
    async (first) => {
      const fixture = await createFixture(client);
      await advanceToSucceeded(client, fixture);
      const race = await skillFileInputRace(fixture, first);

      expect(race.errorCodes).not.toContain("40P01");
      expect(race.errorCodes).not.toContain("57014");
      expect(race.successes).toBeLessThanOrEqual(1);
      expect(race.successes).toBe(1);
      expect(race.exactSetDrift).toBe(false);
      expect(race.inputSkillFiles).toBe(0);
      expect(race.manifestSkillFiles).toBe(0);
      expect(race.workspaceSkillFiles).toBe(0);
      expect(race.evalInputs).toBe(first === "input" ? 1 : 0);
      expect(race.learnedFiles).toBe(first === "file" ? 1 : 0);
    },
    30_000,
  );

  test.each(["missing", "forged", "extra"] as const)(
    "rejects a %s Skill file binding",
    async (skillFileBinding) => {
      const rejected = await transactionWasRejected(client, async () => {
        await insertFixture(client, { skillFileBinding });
      });
      expect(rejected).toBe(true);
    },
  );

  test("rejects drift between the immutable Skill input and workspace skill layer", async () => {
    const rejected = await transactionWasRejected(client, async () => {
      await insertFixture(client, { skillFileBinding: "workspace_drift" });
    });
    expect(rejected).toBe(true);
  });

  test.each(["prepare", "workspace_revision", "workspace_projection"] as const)(
    "rejects an initial graph missing its %s operation fact",
    async (omitOperationFact) => {
      const rejected = await transactionWasRejected(client, async () => {
        await insertFixture(client, { omitOperationFact });
      });
      expect(rejected).toBe(true);
    },
  );

  test.each(["audit", "outbox"] as const)(
    "rejects a prepare fact missing its exact %s",
    async (missing) => {
      const rejected = await transactionWasRejected(client, async () => {
        await insertFixture(client, {
          operationFactOptions: {
            prepare: {
              audit: missing !== "audit",
              outbox: missing !== "outbox",
            },
          },
        });
      });
      expect(rejected).toBe(true);
    },
  );

  test("rejects a preseeded operation audit without a typed owner", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_audit_event
           (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
            correlation_id,operation,workspace_manifest_hash,file_count,byte_count)
         VALUES ($1,$2,$3,$4,'workspace_revision','service',$5,$6,
                 'synthesize',$7,1,1)`,
        [
          unique("orphan_operation_audit"),
          fixture.curatorRunId,
          fixture.evalJobId,
          fixture.projectId,
          `evaluator_${fixture.suffix}`,
          `correlation_${fixture.suffix}`,
          fixture.revisionOneHash,
        ],
      );
    });
    expect(rejected).toBe(true);
  });

  test("rejects a preseeded eval outbox without a typed owner", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO outbox_events
           (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
            headers,correlation_id,causation_id,classification)
         VALUES ($1,'evolution_eval_job',$2,$3,'evolution_eval.workspace_revision',$4,
                 '{}'::jsonb,'{}'::jsonb,$5,NULL,'D1')`,
        [
          randomUUID(),
          fixture.evalJobId,
          nextOutboxSequence(),
          fixture.projectId,
          `correlation_${fixture.suffix}`,
        ],
      );
    });
    expect(rejected).toBe(true);
  });

  test.each([
    ["wrong project", { projectId: "wrong-project" }],
    ["wrong correlation", { correlationId: "wrong-correlation" }],
    ["extra payload field", { payloadExtra: { secret: "must-not-persist" } }],
    ["non-empty headers", { headers: { authorization: "Bearer secret" } }],
  ] as const)("rejects a prepare outbox with %s", async (_label, prepareOptions) => {
    const rejected = await transactionWasRejected(client, async () => {
      await insertFixture(client, {
        operationFactOptions: { prepare: prepareOptions },
      });
    });
    expect(rejected).toBe(true);
  });

  test("rejects rev1 + rev2 + initial projection 2 in the prepare transaction", async () => {
    const rejected = await transactionWasRejected(client, async () => {
      const fixture = await insertFixture(client);
      await insertRevision(client, fixture, 2);
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
    });
    expect(rejected).toBe(true);
  });

  test("accepts submitted -> queued -> preparing -> running only as one audited transaction", async () => {
    const fixture = await createFixture(client);
    await transaction(client, async () => {
      await advanceToRunningInCurrentTransaction(client, fixture);
    });
    const result = await client.query("SELECT state::text FROM tool_run WHERE id=$1", [fixture.toolRunId]);
    expect(result.rows[0]?.state).toBe("running");
  });

  test.each(["queued", "preparing", "cancelling"] as const)(
    "rejects %s as a committed stable evolution_eval state",
    async (stableState) => {
      const fixture = await createFixture(client);
      const rejected = await transactionWasRejected(client, async () => {
        await insertDispatch(client, fixture);
        if (stableState === "queued") {
          await insertTransitionFacts(client, fixture, "submitted", "queued", 1);
          await client.query("UPDATE tool_run SET state='queued' WHERE id=$1", [fixture.toolRunId]);
          return;
        }
        await insertTransitionFacts(client, fixture, "submitted", "queued", 1);
        await client.query("UPDATE tool_run SET state='queued' WHERE id=$1", [fixture.toolRunId]);
        await insertTransitionFacts(client, fixture, "queued", "preparing", 2);
        await client.query("UPDATE tool_run SET state='preparing' WHERE id=$1", [fixture.toolRunId]);
        if (stableState === "cancelling") {
          await insertTransitionFacts(client, fixture, "preparing", "running", 3);
          await client.query("UPDATE tool_run SET state='running' WHERE id=$1", [fixture.toolRunId]);
          await insertTransitionFacts(client, fixture, "running", "cancelling", 4);
          await client.query("UPDATE tool_run SET state='cancelling' WHERE id=$1", [fixture.toolRunId]);
        }
      });
      expect(rejected).toBe(true);
    },
  );

  test("rejects a transition with a missing per-edge audit", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertDispatch(client, fixture);
      await insertTransitionFacts(client, fixture, "submitted", "queued", 1);
      await client.query("UPDATE tool_run SET state='queued' WHERE id=$1", [fixture.toolRunId]);
      await insertTransitionFacts(client, fixture, "queued", "preparing", 2);
      await client.query("UPDATE tool_run SET state='preparing' WHERE id=$1", [fixture.toolRunId]);
      await insertTransitionFacts(client, fixture, "preparing", "running", 3, { audit: false });
      await client.query("UPDATE tool_run SET state='running' WHERE id=$1", [fixture.toolRunId]);
    });
    expect(rejected).toBe(true);
  });

  test("rejects duplicate audits for one transition edge", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertDispatch(client, fixture);
      await insertTransitionFacts(client, fixture, "submitted", "queued", 1, {
        label: "duplicate_one",
      });
      await insertTransitionFacts(client, fixture, "submitted", "queued", 1, {
        label: "duplicate_two",
        fact: false,
        outbox: false,
      });
      await client.query("UPDATE tool_run SET state='queued' WHERE id=$1", [fixture.toolRunId]);
      await insertTransitionFacts(client, fixture, "queued", "preparing", 2);
      await client.query("UPDATE tool_run SET state='preparing' WHERE id=$1", [fixture.toolRunId]);
      await insertTransitionFacts(client, fixture, "preparing", "running", 3);
      await client.query("UPDATE tool_run SET state='running' WHERE id=$1", [fixture.toolRunId]);
    });
    expect(rejected).toBe(true);
  });

  test("does not let a preseeded audit authorize a future transition", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertTransitionFacts(client, fixture, "submitted", "queued", 1, {
        label: "preseeded",
        fact: false,
        outbox: false,
      });
    });
    expect(rejected).toBe(true);
  });

  test("does not let a previously generic outbox mutate into an eval transition", async () => {
    const fixture = await createFixture(client);
    const preseededOutboxId = randomUUID();
    await transaction(client, async () => {
      await client.query(
        `INSERT INTO outbox_events
           (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
            headers,correlation_id,causation_id,classification)
         VALUES ($1,'generic',$2,$3,'generic.event',$4,$5::jsonb,'{}'::jsonb,$6,NULL,'D1')`,
        [
          preseededOutboxId,
          fixture.evalJobId,
          nextOutboxSequence(),
          fixture.projectId,
          JSON.stringify({ from_state: "submitted", to_state: "queued" }),
          `correlation_${fixture.suffix}`,
        ],
      );
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertDispatch(client, fixture);
      const auditId = unique("generic_to_eval_audit");
      await client.query(
        `INSERT INTO evolution_eval_audit_event
           (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
            correlation_id,from_state,to_state,operation)
         VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,
                 'submitted','queued','synthesize')`,
        [
          auditId,
          fixture.curatorRunId,
          fixture.evalJobId,
          fixture.projectId,
          `evaluator_${fixture.suffix}`,
          `correlation_${fixture.suffix}`,
        ],
      );
      await client.query(
        `UPDATE outbox_events
            SET aggregate_type='evolution_eval_job',
                event_type='evolution_eval.tool_run_transition'
          WHERE event_id=$1`,
        [preseededOutboxId],
      );
      await client.query(
        `INSERT INTO evolution_eval_transition_fact
           (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
         VALUES ($1,$2,1,'submitted','queued',$3,$4)`,
        [unique("generic_to_eval_fact"), fixture.evalJobId, auditId, preseededOutboxId],
      );
      await client.query("UPDATE tool_run SET state='queued' WHERE id=$1", [fixture.toolRunId]);
      await insertTransitionFacts(client, fixture, "queued", "preparing", 2);
      await client.query("UPDATE tool_run SET state='preparing' WHERE id=$1", [fixture.toolRunId]);
      await insertTransitionFacts(client, fixture, "preparing", "running", 3);
      await client.query("UPDATE tool_run SET state='running' WHERE id=$1", [fixture.toolRunId]);
    });
    expect(rejected).toBe(true);
  });

  test.each([
    ["aggregate", "aggregate_type='generic'"],
    ["event type", "event_type='generic.event'"],
    ["project", "project_id='wrong-project'"],
    ["correlation", "correlation_id='wrong-correlation'"],
    ["payload", "payload=payload||'{\"secret\":\"value\"}'::jsonb"],
    ["headers", "headers='{\"authorization\":\"Bearer secret\"}'::jsonb"],
    ["causation", "causation_id='unexpected-cause'"],
    ["classification", "classification='D2'"],
    ["sequence", "sequence=sequence+100000"],
    ["occurred_at", "occurred_at=occurred_at+interval '1 second'"],
  ] as const)("freezes the %s of a bound eval outbox", async (_label, mutation) => {
    const fixture = await createFixture(client);
    const event = await client.query<{ outbox_event_id: string }>(
      `SELECT outbox_event_id::text FROM evolution_eval_operation_fact
        WHERE eval_job_id=$1 AND fact_type='prepare'`,
      [fixture.evalJobId],
    );
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `UPDATE outbox_events SET ${mutation} WHERE event_id=$1`,
        [event.rows[0]!.outbox_event_id],
      );
    });
    expect(rejected).toBe(true);
  });

  test("allows published_at once and freezes it afterward", async () => {
    const fixture = await createFixture(client);
    const event = await client.query<{ outbox_event_id: string }>(
      `SELECT outbox_event_id::text FROM evolution_eval_operation_fact
        WHERE eval_job_id=$1 AND fact_type='prepare'`,
      [fixture.evalJobId],
    );
    const eventId = event.rows[0]!.outbox_event_id;
    await transaction(client, async () => {
      await client.query("UPDATE outbox_events SET published_at=now() WHERE event_id=$1", [eventId]);
    });
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        "UPDATE outbox_events SET published_at=published_at+interval '1 second' WHERE event_id=$1",
        [eventId],
      );
    });
    expect(rejected).toBe(true);
  });

  test("rejects deleting a bound eval outbox", async () => {
    const fixture = await createFixture(client);
    const event = await client.query<{ outbox_event_id: string }>(
      `SELECT outbox_event_id::text FROM evolution_eval_operation_fact
        WHERE eval_job_id=$1 AND fact_type='prepare'`,
      [fixture.evalJobId],
    );
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        "DELETE FROM outbox_events WHERE event_id=$1",
        [event.rows[0]!.outbox_event_id],
      );
    });
    expect(rejected).toBe(true);
  });

  test.each(["tool_run", "latch", "audit", "outbox"] as const)(
    "rejects an unknown_effect atomic set missing %s",
    async (missing) => {
      const fixture = await createFixture(client);
      await advanceToRunning(client, fixture);
      const rejected = await transactionWasRejected(client, async () => {
        const factHash = hash(`unknown:${fixture.suffix}`);
        const latchedAt = new Date();
        const transition = await insertTransitionFacts(
          client,
          fixture,
          "running",
          "unknown_effect",
          4,
          {
            audit: missing !== "audit",
            outbox: missing !== "outbox",
            unknownFactHash: factHash,
          },
        );
        if (missing !== "latch") {
          await client.query(
            "UPDATE evolution_eval_run SET unknown_effect_latched_at=$2 WHERE curator_run_id=$1",
            [fixture.curatorRunId, latchedAt],
          );
        }
        await client.query(
          `INSERT INTO evolution_eval_unknown_fact
             (eval_job_id,transition_fact_id,audit_event_id,outbox_event_id,fact_hash,latched_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            fixture.evalJobId,
            transition.factId,
            transition.auditId,
            transition.outboxId,
            factHash,
            latchedAt,
          ],
        );
        if (missing !== "tool_run") {
          await client.query(
            "UPDATE tool_run SET state='unknown_effect',end_time=now() WHERE id=$1",
            [fixture.toolRunId],
          );
        }
      });
      expect(rejected).toBe(true);
    },
  );

  test("does not let old latch/audit/outbox facts authorize a new unknown_effect transition", async () => {
    const fixture = await createFixture(client);
    await advanceToRunning(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        "UPDATE evolution_eval_run SET unknown_effect_latched_at=now() WHERE curator_run_id=$1",
        [fixture.curatorRunId],
      );
      await insertTransitionFacts(client, fixture, "running", "unknown_effect", 4, {
        label: "preseeded_unknown",
        fact: false,
        unknownFactHash: hash(`preseeded:${fixture.suffix}`),
      });
    });
    expect(rejected).toBe(true);
  });

  test.each(["prepare", "dispatch", "effect"] as const)(
    "rejects ordinal 2 %s after unknown_effect is latched",
    async (action) => {
      const fixture = await createFixture(client);
      await advanceToUnknown(client, fixture);
      const rejected = await transactionWasRejected(client, async () => {
        const next = await insertNextJobForRun(client, fixture, 2);
        if (action === "dispatch" || action === "effect") {
          await insertDispatch(client, next);
        }
        if (action === "effect") {
          await advanceToRunningInCurrentTransaction(client, next);
        }
      });
      expect(rejected).toBe(true);
    },
  );

  async function unknownNextJobRace(
    fixture: EvalFixture,
    first: "unknown" | "next_job",
    nextAction: "prepare" | "dispatch",
  ): Promise<{
    readonly successes: number;
    readonly jobs: number;
    readonly laterDispatches: number;
    readonly state: string;
    readonly latched: boolean;
  }> {
    const firstClient = new Client({ connectionString: testDatabaseUrl });
    const secondClient = new Client({ connectionString: testDatabaseUrl });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    let successes = 0;
    try {
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await firstClient.query(
        "SELECT curator_run_id FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
        [fixture.curatorRunId],
      );

      // Queue the second contender on the first authoritative lock in the
      // EvalRun -> job -> ToolRun order. Promise creation is the barrier; no
      // timing sleep is involved.
      const secondLock = secondClient.query(
        "SELECT curator_run_id FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE",
        [fixture.curatorRunId],
      );

      try {
        if (first === "unknown") {
          await advanceRunningToUnknownInCurrentTransaction(firstClient, fixture);
        } else {
          const next = await insertNextJobForRun(firstClient, fixture, 2);
          if (nextAction === "dispatch") await insertDispatch(firstClient, next);
        }
        await firstClient.query("COMMIT");
        successes += 1;
      } catch {
        await firstClient.query("ROLLBACK").catch(() => undefined);
      }

      try {
        await secondLock;
        if (first === "unknown") {
          const next = await insertNextJobForRun(secondClient, fixture, 2);
          if (nextAction === "dispatch") await insertDispatch(secondClient, next);
        } else {
          await advanceRunningToUnknownInCurrentTransaction(secondClient, fixture);
        }
        await secondClient.query("COMMIT");
        successes += 1;
      } catch {
        await secondClient.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }

    const result = await client.query<{
      jobs: number;
      later_dispatches: number;
      state: string;
      unknown_effect_latched_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_job WHERE curator_run_id=$1) AS jobs,
         (SELECT count(*)::int
            FROM evolution_eval_dispatch d
            JOIN evolution_eval_job j ON j.id=d.eval_job_id
           WHERE j.curator_run_id=$1 AND j.ordinal>1) AS later_dispatches,
         (SELECT state::text FROM tool_run WHERE id=$2) AS state,
         (SELECT unknown_effect_latched_at
            FROM evolution_eval_run WHERE curator_run_id=$1) AS unknown_effect_latched_at`,
      [fixture.curatorRunId, fixture.toolRunId],
    );
    return {
      successes,
      jobs: Number(result.rows[0]?.jobs ?? 0),
      laterDispatches: Number(result.rows[0]?.later_dispatches ?? 0),
      state: String(result.rows[0]?.state ?? ""),
      latched: result.rows[0]?.unknown_effect_latched_at !== null,
    };
  }

  test.each([
    ["unknown", "prepare"],
    ["next_job", "prepare"],
    ["unknown", "dispatch"],
    ["next_job", "dispatch"],
  ] as const)(
    "serializes unknown_effect when %s takes the run locks first against ordinal 2 %s",
    async (first, nextAction) => {
      const fixture = await createFixture(client);
      await advanceToRunning(client, fixture);
      const race = await unknownNextJobRace(fixture, first, nextAction);
      expect(race.successes).toBe(1);
      expect(race.jobs).toBe(1);
      expect(race.laterDispatches).toBe(0);
      expect(race.state).toBe("unknown_effect");
      expect(race.latched).toBe(true);
    },
  );

  test("requires eval input and job version binding to the application primary", async () => {
    const rejected = await transactionWasRejected(client, async () => {
      await insertFixture(client, { inputRole: "supporting" });
    });
    expect(rejected).toBe(true);
  });

  test.each([
    ["empty object", {}],
    ["operation mismatch", {
      operation: "simulate",
      source_paths: ["rtl/top.sv"],
      top: "top",
      part: "xc7a35tcpg236-1",
    }],
    ["raw command field", {
      operation: "synthesize",
      source_paths: ["rtl/top.sv"],
      top: "top",
      part: "xc7a35tcpg236-1",
      raw_tcl: "open_hw; program_hw_devices",
    }],
    ["part drift", {
      operation: "synthesize",
      source_paths: ["rtl/top.sv"],
      top: "top",
      part: "xc7z020clg400-1",
    }],
    ["portable case collision", {
      operation: "synthesize",
      source_paths: ["rtl/top.sv", "RTL/TOP.SV"],
      top: "top",
      part: "xc7a35tcpg236-1",
    }],
  ] as const)("rejects synthesize parameters with %s", async (_label, parameters) => {
    const rejected = await transactionWasRejected(client, async () => {
      await insertFixture(client, { parameters });
    });
    expect(rejected).toBe(true);
  });

  test("allows a future overlay source path at prepare time", async () => {
    const fixture = await createFixture(client, {
      parameters: {
        operation: "synthesize",
        source_paths: ["generated/future.sv"],
        top: "top",
        part: "xc7a35tcpg236-1",
      },
    });
    expect(fixture.evalJobId).toStartWith("evaljob_");
  });

  test("requires the initial workspace revision to be exactly 1", async () => {
    const rejected = await transactionWasRejected(client, async () => {
      await insertFixture(client, { initialRevision: 2 });
    });
    expect(rejected).toBe(true);
  });

  test("accepts an ASCII-only path in both input and workspace facts", async () => {
    const fixture = await createFixture(client, { sourcePath: "rtl/main_top-01.sv" });
    const result = await client.query(
      `SELECT i.path AS input_path,w.path AS workspace_path
         FROM evolution_eval_input_file i
         JOIN evolution_eval_workspace_file w ON w.path=i.path
        WHERE i.eval_input_ref=$1 AND w.workspace_id=$2`,
      [fixture.evalInputRef, fixture.workspaceId],
    );
    expect(result.rows).toEqual([{
      input_path: "rtl/main_top-01.sv",
      workspace_path: "rtl/main_top-01.sv",
    }]);
  });

  test.each([
    "CON.v",
    "rtl/PRN.sv",
    "rtl/AUX.xdc",
    "rtl/NUL.v",
    "rtl/COM1.v",
    "dir/LPT1.sv",
    "rtl/com9.test.sv",
    "rtl/lpt9.v",
    "rtl/foo./top.sv",
  ])("PostgreSQL portable-path helper rejects Windows alias path %s", async (path) => {
    const result = await client.query<{ accepted: boolean }>(
      "SELECT synthia_is_evolution_eval_portable_path($1) AS accepted",
      [path],
    );
    expect(result.rows[0]?.accepted).toBe(false);
  });

  test("named PostgreSQL checks guard every durable path-bearing eval fact", async () => {
    const fixture = await createFixture(client, { skillFileBinding: "valid" });
    const content = Buffer.from("module alias_name; endmodule\n", "utf8");
    const contentHash = hash(content);

    const inputConstraint = await rejectedConstraint(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_input_file
           (eval_input_ref,path,sha256,size_bytes,media_type,managed_content)
         VALUES ($1,'CON.v',$2,$3,'text/x-verilog',$4)`,
        [fixture.evalInputRef, contentHash, content.length, content],
      );
    });
    expect(inputConstraint).toBe("evolution_eval_input_file_portable_path_check");

    const workspaceConstraint = await rejectedConstraint(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_workspace_file
           (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
         VALUES ($1,1,'dir/LPT1.sv',$2,$3,'text/x-systemverilog','overlay',false,$4)`,
        [fixture.workspaceId, contentHash, content.length, content],
      );
    });
    expect(workspaceConstraint).toBe("evolution_eval_workspace_file_portable_path_check");

    const skillContent = "# Alias guidance\n";
    const skillConstraint = await rejectedConstraint(client, async () => {
      const skillFileId = unique("reserved_skill_file");
      await client.query(
        `INSERT INTO learned_skill_file
           (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,'references/CON.md','reference',NULL,$3,$4,'text/markdown',$5)`,
        [
          skillFileId,
          fixture.primaryVersionId,
          hash(skillContent),
          Buffer.byteLength(skillContent, "utf8"),
          skillContent,
        ],
      );
      await client.query(
        `INSERT INTO evolution_eval_input_skill_file
           (eval_input_ref,version_id,learned_skill_file_id,path,kind,language,
            sha256,size_bytes,media_type,content)
         VALUES ($1,$2,$3,'references/CON.md','reference',NULL,$4,$5,'text/markdown',$6)`,
        [
          fixture.evalInputRef,
          fixture.primaryVersionId,
          skillFileId,
          hash(skillContent),
          Buffer.byteLength(skillContent, "utf8"),
          skillContent,
        ],
      );
    });
    expect(skillConstraint).toBe("evolution_eval_input_skill_file_portable_path_check");
  });

  test.each([
    ["source_paths", {
      operation: "synthesize",
      source_paths: ["rtl/CON.v"],
      top: "top",
      part: "xc7a35tcpg236-1",
    }],
    ["constraint_paths", {
      operation: "synthesize",
      source_paths: ["rtl/top.sv"],
      constraint_paths: ["constraints/AUX.xdc"],
      top: "top",
      part: "xc7a35tcpg236-1",
    }],
  ] as const)("job named check rejects non-portable %s before deferred validation", async (_label, parameters) => {
    const constraint = await rejectedConstraint(client, async () => {
      await insertFixture(client, { parameters });
    });
    expect(constraint).toBe("evolution_eval_job_parameter_paths_portable_check");
  });

  test.each([
    "rtl/\u4e3b\u63a7.sv",
    "rtl/\u0130.sv",
    "rtl/emoji-\ud83d\ude80.sv",
    "rtl/\u00e9.sv",
  ])("PostgreSQL rejects the non-ASCII path %s", async (sourcePath) => {
    const rejected = await transactionWasRejected(client, async () => {
      await insertFixture(client, { sourcePath });
    });
    expect(rejected).toBe(true);
  });

  test("PostgreSQL rejects ASCII case collisions in input and workspace paths", async () => {
    const fixture = await createFixture(client);
    const content = Buffer.from("module top; endmodule\n", "utf8");
    const inputRejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_input_file
           (eval_input_ref,path,sha256,size_bytes,media_type,managed_content)
         VALUES ($1,'RTL/TOP.SV',$2,$3,'text/x-systemverilog',$4)`,
        [fixture.evalInputRef, hash(content), content.length, content],
      );
    });
    const workspaceRejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_workspace_file
           (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
         VALUES ($1,1,'RTL/TOP.SV',$2,$3,'text/x-systemverilog','source',true,$4)`,
        [fixture.workspaceId, hash(content), content.length, content],
      );
    });
    expect(inputRejected).toBe(true);
    expect(workspaceRejected).toBe(true);
  });

  test("rejects a gap in append-only workspace revisions", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertRevision(client, fixture, 3);
    });
    expect(rejected).toBe(true);
  });

  test.each(["workspace_revision", "workspace_projection"] as const)(
    "rejects revision 2 missing its %s fact",
    async (omitOperationFact) => {
      const fixture = await createFixture(client);
      const rejected = await transactionWasRejected(client, async () => {
        await insertRevision(client, fixture, 2, { omitOperationFact });
        await client.query(
          "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
          [fixture.workspaceId],
        );
      });
      expect(rejected).toBe(true);
    },
  );

  test.each(["audit", "outbox"] as const)(
    "rejects revision 2 with a workspace revision fact missing %s",
    async (missing) => {
      const fixture = await createFixture(client);
      const rejected = await transactionWasRejected(client, async () => {
        await insertRevision(client, fixture, 2, {
          operationFactOptions: {
            workspace_revision: {
              audit: missing !== "audit",
              outbox: missing !== "outbox",
            },
          },
        });
        await client.query(
          "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
          [fixture.workspaceId],
        );
      });
      expect(rejected).toBe(true);
    },
  );

  test("rejects revision 2 without an atomic projection advance", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertRevision(client, fixture, 2);
    });
    expect(rejected).toBe(true);
  });

  test("rejects a seal missing its workspace_seal operation fact", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertDispatch(client, fixture, 1, fixture.revisionOneHash, true, false);
    });
    expect(rejected).toBe(true);
  });

  test("checks workspace manifest counters and byte totals against file rows", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertRevision(client, fixture, 2, { declaredFiles: 2, declaredBytes: 999 });
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
    });
    expect(rejected).toBe(true);
  });

  test("allows projection +1 but rejects projection rollback", async () => {
    const fixture = await createFixture(client);
    await transaction(client, async () => {
      await insertRevision(client, fixture, 2);
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
    });
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=1,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
    });
    expect(rejected).toBe(true);
  });

  test("does not advance a workspace revision after seal", async () => {
    const fixture = await createFixture(client);
    await transaction(client, async () => {
      const revisionTwoHash = await insertRevision(client, fixture, 2);
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
      await insertDispatch(client, fixture, 2, revisionTwoHash);
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertRevision(client, fixture, 3);
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=3,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
    });
    expect(rejected).toBe(true);
  });

  test("rejects dispatch from an unsealed workspace", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertDispatch(client, fixture, 1, fixture.revisionOneHash, false);
    });
    expect(rejected).toBe(true);
  });

  test("requires dispatch to reference the sealed current revision and hash", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertRevision(client, fixture, 2);
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
      await insertDispatch(client, fixture, 1, fixture.revisionOneHash);
    });
    expect(rejected).toBe(true);
  });

  test("requires every source parameter path to exist in the sealed workspace", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      const revisionTwoHash = await insertRevision(client, fixture, 2, { omitSource: true });
      await client.query(
        "UPDATE evolution_eval_workspace_projection SET current_revision=2,updated_at=now() WHERE workspace_id=$1",
        [fixture.workspaceId],
      );
      await insertDispatch(client, fixture, 2, revisionTwoHash);
    });
    expect(rejected).toBe(true);
  });

  async function dispatchTombstoneRace(
    fixture: EvalFixture,
    first: "dispatcher" | "cancel",
  ): Promise<{
    readonly successes: number;
    readonly totalFacts: number;
    readonly state: string;
    readonly rpcReady: boolean;
  }> {
    const firstClient = new Client({ connectionString: testDatabaseUrl });
    const secondClient = new Client({ connectionString: testDatabaseUrl });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    let successes = 0;
    try {
      // Fix transaction-start order as well as lock order. PostgreSQL now() is
      // transaction-scoped, so a timestamp-based fence must not be able to
      // reverse the authoritative row-lock winner.
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await firstClient.query("SELECT id FROM evolution_eval_job WHERE id=$1 FOR UPDATE", [fixture.evalJobId]);

      // Promise creation is the barrier: connection two is queued on the same
      // authoritative row before connection one commits. No timing sleep is used.
      const secondLock = secondClient.query(
        "SELECT id FROM evolution_eval_job WHERE id=$1 FOR UPDATE",
        [fixture.evalJobId],
      );
      try {
        if (first === "dispatcher") {
          await advanceToRunningInCurrentTransaction(firstClient, fixture);
        } else {
          await insertTombstone(firstClient, fixture);
        }
        await firstClient.query("COMMIT");
        successes += 1;
      } catch {
        await firstClient.query("ROLLBACK").catch(() => undefined);
      }

      try {
        await secondLock;
        if (first === "dispatcher") await insertTombstone(secondClient, fixture);
        else await advanceToRunningInCurrentTransaction(secondClient, fixture);
        await secondClient.query("COMMIT");
        successes += 1;
      } catch {
        await secondClient.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM evolution_eval_dispatch WHERE eval_job_id=$1) AS dispatches,
         (SELECT count(*)::int FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1) AS tombstones,
         (SELECT state::text FROM tool_run WHERE id=$2) AS state`,
      [fixture.evalJobId, fixture.toolRunId],
    );
    const dispatches = Number(result.rows[0]?.dispatches ?? 0);
    const tombstones = Number(result.rows[0]?.tombstones ?? 0);
    const state = String(result.rows[0]?.state ?? "");
    return {
      successes,
      totalFacts: dispatches + tombstones,
      state,
      rpcReady: dispatches === 1 && tombstones === 0 && state === "running",
    };
  }

  test.each(["dispatcher", "cancel"] as const)(
    "serializes the post-dispatch effect/cancel fence when %s takes the job lock first",
    async (first) => {
      const fixture = await createFixture(client);
      await transaction(client, async () => {
        await insertDispatch(client, fixture);
      });
      const race = await dispatchTombstoneRace(fixture, first);
      expect(race.successes).toBe(1);
      expect(race.totalFacts).toBe(first === "dispatcher" ? 1 : 2);
      expect(race.state).toBe(first === "dispatcher" ? "running" : "rejected");
      expect(race.rpcReady).toBe(first === "dispatcher");
    },
  );

  test("rejects freeze_pending before an accepted terminal job", async () => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects freeze_pending for a pre-dispatch rejected job", async () => {
    const fixture = await createFixture(client);
    await transaction(client, async () => {
      await insertTombstone(client, fixture);
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects freeze_pending for an unknown_effect job", async () => {
    const fixture = await createFixture(client);
    await advanceToUnknown(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects frozen evidence without a previously committed freeze intent", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "frozen");
    });
    expect(rejected).toBe(true);
  });

  test("rejects freeze_pending and frozen in the same transaction", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
      await insertEvidenceFact(client, fixture, "frozen");
    });
    expect(rejected).toBe(true);
  });

  test.each(["audit", "outbox"] as const)(
    "rejects a frozen evidence fact missing its exact %s",
    async (missing) => {
      const fixture = await createFixture(client);
      await advanceToSucceeded(client, fixture);
      await transaction(client, async () => {
        await insertEvidenceFact(client, fixture, "freeze_pending");
      });
      const rejected = await transactionWasRejected(client, async () => {
        await insertEvidenceFact(client, fixture, "frozen", null, {
          audit: missing !== "audit",
          outbox: missing !== "outbox",
        });
      });
      expect(rejected).toBe(true);
    },
  );

  test("allows only one immutable evidence conclusion", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await freezeEmptyEvidence(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "corrupt");
      await insertEvidenceFact(client, fixture, "quarantine_pending");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("requires every evidence entry to belong to the frozen conclusion", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await freezeEmptyEvidence(client, fixture);
    let retentionFactId = "";
    await transaction(client, async () => {
      retentionFactId = await insertEvidenceFact(client, fixture, "ack_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceEntry(client, fixture, retentionFactId, "timing.bin");
    });
    expect(rejected).toBe(true);
  });

  test("rejects frozen and ack_pending in the same transaction", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "frozen");
      await insertEvidenceFact(client, fixture, "ack_pending");
    });
    expect(rejected).toBe(true);
  });

  test("accepts ack_pending only after frozen evidence committed", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await freezeEmptyEvidence(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "ack_pending");
    });
    expect(rejected).toBe(false);
  });

  test("rejects ack_pending and acknowledged in the same transaction", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await freezeEmptyEvidence(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "ack_pending");
      await insertEvidenceFact(client, fixture, "acknowledged");
    });
    expect(rejected).toBe(true);
  });

  test("accepts the acknowledged cleanup_pending cleaned chain", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await freezeEmptyEvidence(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "ack_pending");
    });
    await transaction(client, async () => {
      await insertRetentionTerminalFact(client, fixture, "acknowledged");
    });
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    await transaction(client, async () => {
      await insertRetentionTerminalFact(client, fixture, "cleaned");
    });
    const result = await client.query<{ fact_type: string }>(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1 ORDER BY created_at,id`,
      [fixture.evalJobId],
    );
    expect(result.rows.map((row) => row.fact_type)).toContain("cleaned");
  });

  test("rejects corrupt evidence without an atomic cleanup intent", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "corrupt");
      await insertEvidenceFact(client, fixture, "quarantine_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects corrupt evidence without a previously committed freeze intent", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "corrupt");
      await insertEvidenceFact(client, fixture, "quarantine_pending");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects freeze_pending and corrupt in the same transaction", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
      await insertEvidenceFact(client, fixture, "corrupt");
      await insertEvidenceFact(client, fixture, "quarantine_pending");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("accepts corrupt with atomic quarantine and cleanup intents", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "corrupt");
      await insertEvidenceFact(client, fixture, "quarantine_pending");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(false);
  });

  test("rejects unavailable_at_deadline before the Core deadline", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "unavailable_at_deadline");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("accepts unavailable_at_deadline with atomic cleanup after deadline", async () => {
    const fixture = await createFixture(client, {
      budgetStartedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "unavailable_at_deadline");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(false);
  });

  test("rejects expired evidence before terminal plus seven days", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "expired");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("accepts expired with atomic cleanup after terminal plus seven days", async () => {
    const fixture = await createFixture(client, {
      budgetStartedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    await advanceToSucceeded(client, fixture, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await freezeEmptyEvidence(client, fixture);
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "expired");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(false);
  });

  test("rejects expired evidence without a frozen conclusion", async () => {
    const fixture = await createFixture(client, {
      budgetStartedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    await advanceToSucceeded(client, fixture, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "expired");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects frozen and expired evidence in the same transaction", async () => {
    const fixture = await createFixture(client, {
      budgetStartedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    await advanceToSucceeded(client, fixture, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "frozen");
      await insertEvidenceFact(client, fixture, "expired");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("rejects expired evidence after Connector acknowledgement", async () => {
    const fixture = await createFixture(client, {
      budgetStartedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    await advanceToSucceeded(client, fixture, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await freezeEmptyEvidence(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "ack_pending");
    });
    await transaction(client, async () => {
      await insertRetentionTerminalFact(client, fixture, "acknowledged");
    });
    const rejected = await transactionWasRejected(client, async () => {
      await insertEvidenceFact(client, fixture, "expired");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    expect(rejected).toBe(true);
  });

  test("enforces at most 128 entries in one frozen evidence manifest", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      const entries = Array.from({ length: 129 }, (_, index) => ({
        name: `entry-${index}.bin`,
        sha256: hash(Buffer.alloc(0)),
        size_bytes: 0,
        media_type: "application/octet-stream",
        artifact_classification: "evolution_eval_evidence",
        usage_classification: "evolution_eval_only",
      }));
      const frozenFactId = await insertEvidenceFact(client, fixture, "frozen", null, {
        manifest: {
          schema: "evolution-eval-evidence-manifest.v1",
          eval_job_id: fixture.evalJobId,
          tool_run_id: fixture.toolRunId,
          entries,
        },
        entryCount: 128,
      });
      for (let index = 0; index < 129; index += 1) {
        await insertEvidenceEntry(client, fixture, frozenFactId, `entry-${index}.bin`);
      }
    });
    expect(rejected).toBe(true);
  });

  test("enforces the 256 MiB total evidence limit", async () => {
    const fixture = await createFixture(client);
    await advanceToSucceeded(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "freeze_pending");
    });
    const rejected = await transactionWasRejected(client, async () => {
      const sizes = [
        64 * 1024 * 1024,
        64 * 1024 * 1024,
        64 * 1024 * 1024,
        64 * 1024 * 1024,
        1,
      ];
      const entries = sizes.map((size, index) => ({
        name: `large-${index}.bin`,
        sha256: size === 1
          ? "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"
          : "3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351",
        size_bytes: size,
        media_type: "application/octet-stream",
        artifact_classification: "evolution_eval_evidence",
        usage_classification: "evolution_eval_only",
      }));
      const frozenFactId = await insertEvidenceFact(client, fixture, "frozen", null, {
        manifest: {
          schema: "evolution-eval-evidence-manifest.v1",
          eval_job_id: fixture.evalJobId,
          tool_run_id: fixture.toolRunId,
          entries,
        },
        entryCount: 5,
        totalBytes: 268435456,
      });
      for (let index = 0; index < sizes.length; index += 1) {
        const size = sizes[index]!;
        const name = `large-${index}.bin`;
      await client.query(
        `WITH content AS (SELECT decode(repeat('00',$5),'hex') AS bytes)
         INSERT INTO evolution_eval_evidence_entry
           (id,evidence_fact_id,eval_job_id,name,sha256,size_bytes,media_type,
            artifact_classification,usage_classification,managed_content)
         SELECT $1,$2,$3,$4,encode(digest(bytes,'sha256'),'hex'),octet_length(bytes),
                'application/octet-stream','evolution_eval_evidence',
                'evolution_eval_only',bytes
           FROM content`,
        [unique("large_entry"), frozenFactId, fixture.evalJobId, name, size],
      );
      }
    });
    expect(rejected).toBe(true);
  }, 180_000);

  test("retention facts cannot replace a frozen evidence conclusion", async () => {
    const fixture = await createFixture(client, {
      budgetStartedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    await advanceToSucceeded(client, fixture, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await freezeEmptyEvidence(client, fixture);
    await transaction(client, async () => {
      await insertEvidenceFact(client, fixture, "expired");
      await insertEvidenceFact(client, fixture, "cleanup_pending");
    });
    const result = await client.query(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1
          AND fact_type IN ('frozen','corrupt','unavailable_at_deadline')`,
      [fixture.evalJobId],
    );
    expect(result.rows.map((item) => item.fact_type)).toEqual(["frozen"]);
  });

  test("idempotency scope/action/key/request identity is immutable", async () => {
    const fixture = await createFixture(client);
    const id = unique("idempotency");
    await transaction(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_idempotency
           (id,scope,curator_run_id,eval_job_id,action,idempotency_key,request_hash)
         VALUES ($1,'core:evolution-eval',$2,$3,'prepare',$4,$5)`,
        [id, fixture.curatorRunId, fixture.evalJobId, `key_${fixture.suffix}`, hash("request-one")],
      );
    });
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `UPDATE evolution_eval_idempotency
            SET action='submit',idempotency_key=$2,request_hash=$3
          WHERE id=$1`,
        [id, `different_${fixture.suffix}`, hash("request-two")],
      );
    });
    expect(rejected).toBe(true);
  });

  test.each(["mutate", "reopen"] as const)(
    "completed idempotency records cannot %s",
    async (action) => {
      const fixture = await createFixture(client);
      const id = unique("completed_idempotency");
      await transaction(client, async () => {
        await client.query(
          `INSERT INTO evolution_eval_idempotency
             (id,scope,curator_run_id,eval_job_id,action,idempotency_key,request_hash,
              response_status,response,completed_at)
           VALUES ($1,'core:evolution-eval',$2,$3,'prepare',$4,$5,201,$6::jsonb,now())`,
          [
            id,
            fixture.curatorRunId,
            fixture.evalJobId,
            `key_${fixture.suffix}`,
            hash("request"),
            JSON.stringify({ eval_job_id: fixture.evalJobId }),
          ],
        );
      });
      const rejected = await transactionWasRejected(client, async () => {
        if (action === "mutate") {
          await client.query(
            "UPDATE evolution_eval_idempotency SET response=$2::jsonb WHERE id=$1",
            [id, JSON.stringify({ eval_job_id: "different" })],
          );
        } else {
          await client.query(
            `UPDATE evolution_eval_idempotency
                SET response_status=NULL,response=NULL,completed_at=NULL
              WHERE id=$1`,
            [id],
          );
        }
      });
      expect(rejected).toBe(true);
    },
  );

  test.each([
    ["lease token", { curator_lease_token: "lease-secret-value" }],
    ["service secret", { service_secret: "secret-value" }],
    ["raw bytes", { content_base64: "c2VjcmV0IHNvdXJjZQ==" }],
    ["raw log", { raw_log: "Vivado log contents" }],
    ["absolute Host path", { host_path: "/var/tmp/synthia/eval/top.sv" }],
  ] as const)("rejects unsafe %s in evolution-eval audit details", async (_label, details) => {
    const fixture = await createFixture(client);
    const rejected = await transactionWasRejected(client, async () => {
      await client.query(
        `INSERT INTO evolution_eval_audit_event
           (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
            correlation_id,details)
         VALUES ($1,$2,$3,$4,'unsafe.audit','service',$5,$6,$7::jsonb)`,
        [
          unique("unsafe_audit"),
          fixture.curatorRunId,
          fixture.evalJobId,
          fixture.projectId,
          `evaluator_${fixture.suffix}`,
          `correlation_${fixture.suffix}`,
          JSON.stringify(details),
        ],
      );
    });
    expect(rejected).toBe(true);
  });
});
