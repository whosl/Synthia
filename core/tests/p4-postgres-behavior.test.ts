/**
 * P4 PostgreSQL invariants that cannot be proven by SQL-text assertions.
 *
 * This suite is intentionally destructive to DATABASE_URL: it rebuilds the
 * public schema through 0009, seeds a legacy GJB_REF_V1 project, then applies
 * 0010 and 0011 exactly as the numbered migration runner does. Always point it
 * at a throwaway database created for tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { sha256Hex } from "../src/hashing.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
  "migrations",
);
const PROFILE_HASH = "0f503a9bf66e0226f2242cfeb6d42b51d2172afc8dc2584f230e0e03f33f3c5e";

interface PgErrorLike extends Error {
  code?: string;
  constraint?: string;
}

interface ProjectGraph {
  projectId: string;
  processInstanceId: string;
  workVersionId: string;
  artifactId: string;
  revisionId: string;
  revisionHash: string;
  snapshotId: string;
  snapshotHash: string;
}

interface FormalGraph extends ProjectGraph {
  readinessId: string;
  readinessSequence: number;
  readinessHash: string;
  engineeringConfigHash: string;
  toolchainHash: string;
  constraintHash: string;
  mainTaskId: string;
  b1BaselineId: string;
  formalInputApprovalId: string;
  inputHash: string;
}

interface ReleaseGraph extends FormalGraph {
  releaseId: string;
  releaseVersion: number;
  supersedesReleaseId: string | null;
  g4SubmissionId: string;
  g4EvaluationId: string;
  candidateManifestHash: string;
  approvalRecordId: string;
  approvedGateResultId: string;
  b2BaselineId: string;
  bitstreamResultId: string;
  bitstreamHash: string;
  bitstreamSize: number;
}

interface ReleaseItem {
  id: string;
  category: "rtl" | "tb" | "constraint" | "document" | "run_result" | "raw_evidence" | "confirmation" | "source" | "bitstream";
  path: string;
  source_type: string;
  source_id: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  storage_uri: string;
  provenance: Record<string, unknown>;
}

const hex = (label: string): string => sha256Hex(label);
const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8")
    .replace(/^\s*BEGIN;\s*$/gim, "")
    .replace(/^\s*COMMIT;\s*$/gim, "")
    .trim();
}

async function applyMigrationsThrough(client: Client, finalVersion: string): Promise<void> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of migrations) {
    const version = name.replace(/\.sql$/, "");
    if (version > finalVersion) break;
    const present = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (present.rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(migrationSql(name));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function capturePgFailure(work: () => Promise<unknown>): Promise<PgErrorLike> {
  try {
    await work();
  } catch (error) {
    return error as PgErrorLike;
  }
  throw new Error("expected PostgreSQL operation to fail");
}

async function insertIdentity(
  client: Client,
  actorType: "human" | "service",
  uid: string,
): Promise<void> {
  await client.query(
    `INSERT INTO user_account
       (id, uid, cn, display_name, mail, actor_type, status)
     VALUES ($1,$2,$3,$3,$4,$5,'active')`,
    [id("account"), uid, `${actorType} tester`, `${uid}@test.local`, actorType],
  );
}

async function insertEngineeringProject(
  client: Client,
  prefix: string,
  currentGate: "G0" | "G1" | "G2" | "G3" | "G4" = "G1",
  version = 1,
  origin: "initial" | "change_request" = "initial",
  changeRequestId: string | null = null,
  baseReleaseId: string | null = null,
): Promise<ProjectGraph> {
  const projectId = id(`${prefix}_project`);
  const processInstanceId = id(`${prefix}_process`);
  const workVersionId = id(`${prefix}_work`);
  const artifactId = id(`${prefix}_artifact`);
  const revisionId = id(`${prefix}_revision`);
  const revisionHash = hex(`${prefix}:revision`);
  const snapshotId = id(`${prefix}_snapshot`);
  const snapshotHash = hex(`${prefix}:snapshot`);

  await client.query(
    `INSERT INTO project
       (id, name, scope, data_classification, standard_version, target_part,
        toolchain_profile_ref, status, project_type, process_version_id,
        process_profile_id, process_profile_version, process_profile_name)
     VALUES ($1,$2,'','D1','GB/T 33781-2017','xc7k70tfbv676-1',
             'toolchain-v1','active','engineering','GJB_REF_V1',
             'GJB_REF_V1','GJB_REF_V1','GJB 参考流程 v1')`,
    [projectId, `${prefix} project`],
  );
  await client.query(
    `INSERT INTO process_instance
       (id, project_id, gate_profile_version, current_gate)
     VALUES ($1,$2,'GJB_REF_V1',$3)`,
    [processInstanceId, projectId, currentGate],
  );
  await client.query(
    `INSERT INTO project_work_version
       (id, project_id, process_instance_id, version, origin, change_request_id,
        base_delivery_release_id, start_gate, current_gate, state,
        created_by_type, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'working','system','p4-postgres-test')`,
    [
      workVersionId,
      projectId,
      processInstanceId,
      version,
      origin,
      changeRequestId,
      baseReleaseId,
      origin === "initial" ? "G0" : currentGate,
      currentGate,
    ],
  );
  await client.query(
    `INSERT INTO artifact (id, project_id, artifact_type, title)
     VALUES ($1,$2,'RTL','P4 PostgreSQL fixture')`,
    [artifactId, projectId],
  );
  await client.query(
    `INSERT INTO artifact_revision
       (id, artifact_id, project_id, version, state, content_hash,
        content_location, schema_version, source_ids, data_classification,
        change_reason, created_by, created_by_type, review_ids)
     VALUES ($1,$2,$3,1,'approved',$4,$5,'v1','{}','D1',
             'P4 PostgreSQL fixture',$6,'human','{}')`,
    [revisionId, artifactId, projectId, revisionHash, `content://sha256/${revisionHash}`, HUMAN_UID],
  );
  await client.query(
    `INSERT INTO configuration_snapshot
       (id, project_id, member_revision_ids, trace_relation_ids,
        gate_profile_version, tool_model_policy_hash, manifest_hash, created_by,
        work_version_id)
     VALUES ($1,$2,$3,'{}','GJB_REF_V1',$4,$5,$6,$7)`,
    [snapshotId, projectId, [revisionId], hex(`${prefix}:policy`), snapshotHash, HUMAN_UID, workVersionId],
  );

  return {
    projectId,
    processInstanceId,
    workVersionId,
    artifactId,
    revisionId,
    revisionHash,
    snapshotId,
    snapshotHash,
  };
}

async function insertSubmission(
  client: Client,
  graph: ProjectGraph,
  gate: "G1" | "G2" | "G3" | "G4",
  state: "preparing" | "submitted" | "checking" | "in_review" | "approved" = "checking",
): Promise<string> {
  const submissionId = id(`submission_${gate.toLowerCase()}`);
  await client.query(
    `INSERT INTO gate_submission
       (id, project_id, process_instance_id, gate, snapshot_id, state,
        submitter_id, work_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      submissionId,
      graph.projectId,
      graph.processInstanceId,
      gate,
      graph.snapshotId,
      state,
      HUMAN_UID,
      graph.workVersionId,
    ],
  );
  return submissionId;
}

async function insertEvaluation(
  client: Client,
  graph: ProjectGraph,
  submissionId: string,
  gate: "G1" | "G2" | "G3" | "G4",
  options: {
    evaluationId?: string;
    workVersionId?: string;
    sealedProjection?: Record<string, unknown> | null;
    sealedProjectionHash?: string | null;
  } = {},
): Promise<string> {
  const evaluationId = options.evaluationId ?? id(`evaluation_${gate.toLowerCase()}`);
  const required = await client.query<{ code: string; severity: "hard" | "advisory" }>(
    `SELECT item->>'code' AS code, item->>'severity' AS severity
       FROM process_gate_definition definition,
            LATERAL jsonb_array_elements(definition.required_checks) item
      WHERE definition.process_version_id = 'GJB_REF_V1' AND definition.gate = $1
      ORDER BY item->>'code'`,
    [gate],
  );

  await client.query("BEGIN");
  try {
    for (const check of required.rows) {
      await client.query(
        `INSERT INTO gate_check_item
           (id, project_id, evaluation_id, check_code, check_version,
            severity, passed, status, fact_hash, details, evidence_refs)
         VALUES ($1,$2,$3,$4,'v1',$5,true,'passed',$6,'{}','[]')`,
        [id("check"), graph.projectId, evaluationId, check.code, check.severity, hex(`${evaluationId}:${check.code}`)],
      );
    }
    await client.query(
      `INSERT INTO gate_check_evaluation
         (id, project_id, process_instance_id, work_version_id,
          gate_submission_id, gate, snapshot_id, profile_hash,
          profile_definition_hash, check_set_hash, snapshot_manifest_hash,
          input_fact_hash, result_hash, passed, state, sealed_projection,
          sealed_projection_hash, evaluated_at, evaluator_version,
          generated_by_type, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,true,'passed',
               $13,$14,now(),'p4-postgres-test','system','p4-postgres-test')`,
      [
        evaluationId,
        graph.projectId,
        graph.processInstanceId,
        options.workVersionId ?? graph.workVersionId,
        submissionId,
        gate,
        graph.snapshotId,
        PROFILE_HASH,
        hex(`${evaluationId}:checks`),
        graph.snapshotHash,
        hex(`${evaluationId}:facts`),
        hex(`${evaluationId}:result`),
        options.sealedProjection ? JSON.stringify(options.sealedProjection) : null,
        options.sealedProjectionHash ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return evaluationId;
}

async function insertApprovedMilestone(
  client: Client,
  graph: ProjectGraph,
  gate: "G3" | "G4",
  baselineKind: "B1" | "B2",
  options: {
    submissionId?: string;
    approvalRecordId?: string;
    approvedGateResultId?: string;
    baselineId?: string;
    supersedesBaselineId?: string | null;
  } = {},
): Promise<{
  submissionId: string;
  approvalRecordId: string;
  approvedGateResultId: string;
  baselineId: string;
}> {
  const submissionId = options.submissionId ?? await insertSubmission(client, graph, gate, "approved");
  const approvalRecordId = options.approvalRecordId ?? id(`approval_${gate.toLowerCase()}`);
  const approvedGateResultId = options.approvedGateResultId ?? id(`approved_${gate.toLowerCase()}`);
  const baselineId = options.baselineId ?? id(`baseline_${baselineKind.toLowerCase()}`);

  await client.query(
    `INSERT INTO approval_record
       (id, project_id, gate_submission_id, decision, approver_id,
        approver_role, authorization_basis, reason, issues, risks, waivers,
        check_results_hash, signed_at, signature_method,
        approved_gate_result_id)
     VALUES ($1,$2,$3,'approve',$4,'project_owner','P4 PostgreSQL fixture',
             'approved by test fixture','{}','{}','{}',$5,now(),
             'platform_token',$6)`,
    [approvalRecordId, graph.projectId, submissionId, HUMAN_UID, hex(`${approvalRecordId}:checks`), approvedGateResultId],
  );
  await client.query(
    `INSERT INTO approved_gate_result
       (id, project_id, gate, gate_submission_id, approval_record_id, snapshot_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [approvedGateResultId, graph.projectId, gate, submissionId, approvalRecordId, graph.snapshotId],
  );
  await client.query(
    `INSERT INTO baseline
       (id, project_id, kind, state, approved_gate_result_id,
        member_revision_ids, trace_relation_ids, manifest_hash,
        approval_record_id, supersedes_baseline_id)
     VALUES ($1,$2,$3,'active',$4,$5,'{}',$6,$7,$8)`,
    [
      baselineId,
      graph.projectId,
      baselineKind,
      approvedGateResultId,
      [graph.revisionId],
      graph.snapshotHash,
      approvalRecordId,
      options.supersedesBaselineId ?? null,
    ],
  );
  return { submissionId, approvalRecordId, approvedGateResultId, baselineId };
}

async function insertReadiness(
  client: Client,
  graph: ProjectGraph,
  prefix: string,
  sequence: number,
  supersedesReadinessId: string | null = null,
): Promise<{
  readinessId: string;
  readinessHash: string;
  engineeringConfigHash: string;
  toolchainHash: string;
  constraintHash: string;
}> {
  const readinessId = id(`${prefix}_readiness`);
  const readinessHash = hex(`${prefix}:readiness`);
  const engineeringConfigHash = hex(`${prefix}:engineering-config`);
  const toolchainHash = hex(`${prefix}:toolchain`);
  const constraintHash = hex(`${prefix}:constraints`);
  const config = {
    schema: "engineering-config.v1",
    targetPart: "xc7k70tfbv676-1",
    constraints: { state: "complete", hash: constraintHash },
  };

  await client.query(
    `INSERT INTO project_readiness
       (id, project_id, process_instance_id, process_version_id,
        profile_definition_hash, work_version_id, sequence,
        supersedes_readiness_id, engineering_config, engineering_config_hash,
        source_snapshot_ids, workspace_commit, workspace_manifest_hash,
        check_results, result_hash, state, board_ref, workspace_ready,
        data_scope_recorded, source_materials_recorded,
        pin_constraints_complete, electrical_constraints_complete,
        clock_constraints_complete, constraint_revision_ids,
        toolchain_profile_hash, target_part, readiness_hash,
        generated_by_type, generated_by)
     VALUES ($1,$2,$3,'GJB_REF_V1',$4,$5,$6,$7,$8,$9,'{}',$10,$11,
             '[]',$12,'ready','board-test',true,true,true,true,true,true,$13,
             $14,'xc7k70tfbv676-1',$15,'system','p4-postgres-test')`,
    [
      readinessId,
      graph.projectId,
      graph.processInstanceId,
      PROFILE_HASH,
      graph.workVersionId,
      sequence,
      supersedesReadinessId,
      JSON.stringify(config),
      engineeringConfigHash,
      "a".repeat(40),
      hex(`${prefix}:workspace`),
      hex(`${prefix}:readiness-result`),
      [graph.revisionId],
      toolchainHash,
      readinessHash,
    ],
  );
  await client.query(
    `UPDATE project_readiness
        SET confirmed_by = $2, confirmed_at = now()
      WHERE id = $1`,
    [readinessId, HUMAN_UID],
  );
  return { readinessId, readinessHash, engineeringConfigHash, toolchainHash, constraintHash };
}

async function insertMainTask(client: Client, graph: ProjectGraph, prefix: string): Promise<string> {
  const mainTaskId = id(`${prefix}_main_task`);
  await client.query(
    `INSERT INTO agent_task
       (id, project_id, project_type, kind, process_instance_id,
        runtime_actor_id, objective, authorization_scope, status, input_hash,
        adoption_state, created_by_type, created_by)
     VALUES ($1,$2,'engineering','main',$3,$4,'P4 formal flow','{}',
             'running',$5,'not_applicable','human',$6)`,
    [mainTaskId, graph.projectId, graph.processInstanceId, RUNTIME_UID, hex(`${prefix}:task-input`), HUMAN_UID],
  );
  return mainTaskId;
}

async function insertFormalInputApproval(
  client: Client,
  graph: ProjectGraph,
  facts: {
    readinessId: string;
    engineeringConfigHash: string;
    toolchainHash: string;
    constraintHash: string;
    mainTaskId: string;
    baselineId: string;
  },
  prefix: string,
): Promise<{ formalInputApprovalId: string; inputHash: string }> {
  const formalInputApprovalId = id(`${prefix}_formal_input`);
  const inputHash = hex(`${prefix}:formal-input`);
  const priorContent = await client.query<{ managed_content: Uint8Array }>(
    `SELECT managed_content FROM formal_input_content
      WHERE project_id = $1 AND sha256 = $2`,
    [graph.projectId, graph.revisionHash],
  );
  const revisionBytes = priorContent.rows[0]?.managed_content
    ?? Buffer.from(`${prefix}:revision`, "utf8");
  expect(sha256Hex(revisionBytes)).toBe(graph.revisionHash);
  const authoritativeInputs = [{
    revision_id: graph.revisionId,
    sha256: graph.revisionHash,
    size_bytes: revisionBytes.byteLength,
  }];
  const baseline = await client.query<{ manifest_hash: string }>(
    "SELECT manifest_hash FROM baseline WHERE id = $1 AND project_id = $2",
    [facts.baselineId, graph.projectId],
  );
  const baselineManifestHash = baseline.rows[0]?.manifest_hash;
  if (!baselineManifestHash) throw new Error(`missing B1 baseline ${facts.baselineId}`);
  await client.query(
    `INSERT INTO formal_input_content (project_id, sha256, size_bytes, managed_content)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, sha256) DO NOTHING`,
    [graph.projectId, graph.revisionHash, revisionBytes.byteLength, revisionBytes],
  );
  await client.query(
    `INSERT INTO formal_input_approval
       (id, project_id, process_instance_id, snapshot_id, baseline_id,
        readiness_id, manifest_hash, input_hash, engineering_config_hash,
        baseline_manifest_hash, toolchain_profile_hash, connector_id,
        target_part, constraint_hash, constraints_complete, purpose,
        target_gate, allowed_operations, authorized_task_id,
        runtime_actor_id, input_manifest, preview_hash,
        authoritative_inputs, generated_by_type, generated_by,
        work_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'connector-test',
             'xc7k70tfbv676-1',$12,true,'g4_delivery','G4',$13,$14,$15,
             $16,$17,$18,'system','p4-postgres-test',$19)`,
    [
      formalInputApprovalId,
      graph.projectId,
      graph.processInstanceId,
      graph.snapshotId,
      facts.baselineId,
      facts.readinessId,
      graph.snapshotHash,
      inputHash,
      facts.engineeringConfigHash,
      baselineManifestHash,
      facts.toolchainHash,
      facts.constraintHash,
      ["implement", "simulate", "synthesize", "validate_sources"],
      facts.mainTaskId,
      RUNTIME_UID,
      JSON.stringify({ schema: "formal-input.v1", projectId: graph.projectId }),
      hex(`${prefix}:preview`),
      JSON.stringify(authoritativeInputs),
      graph.workVersionId,
    ],
  );
  await client.query(
    `UPDATE formal_input_approval
        SET confirmed_by = $2, confirmed_at = now()
      WHERE id = $1`,
    [formalInputApprovalId, HUMAN_UID],
  );
  return { formalInputApprovalId, inputHash };
}

async function insertFormalGraph(client: Client, prefix: string): Promise<FormalGraph> {
  const graph = await insertEngineeringProject(client, prefix, "G4");
  const readiness = await insertReadiness(client, graph, prefix, 1);
  const b1 = await insertApprovedMilestone(client, graph, "G3", "B1");
  const mainTaskId = await insertMainTask(client, graph, prefix);
  const approval = await insertFormalInputApproval(client, graph, {
    ...readiness,
    mainTaskId,
    baselineId: b1.baselineId,
  }, prefix);
  return {
    ...graph,
    ...readiness,
    readinessSequence: 1,
    mainTaskId,
    b1BaselineId: b1.baselineId,
    ...approval,
  };
}

async function insertFormalToolRun(
  client: Client,
  graph: FormalGraph,
  operation: "validate_sources" | "simulate" | "synthesize" | "implement",
  runId = id(`formal_${operation}`),
  state: "submitted" | "succeeded" = "submitted",
): Promise<string> {
  await client.query(
    `INSERT INTO tool_run
       (id, project_id, operation, run_class, state, input_snapshot_id,
        input_manifest_hash, authorization_context, toolchain_profile_hash,
        connector_id, parameters, correlation_id, formal_input_approval_id,
        submitted_by_type, submitted_by, input_hash, binding_version)
     VALUES ($1,$2,$3,'formal',$4,$5,$6,'{}',$7,'connector-test','{}',$8,
             $9,'human',$10,$11,'formal-input.v1')`,
    [
      runId,
      graph.projectId,
      operation,
      state,
      graph.snapshotId,
      graph.snapshotHash,
      graph.toolchainHash,
      id("correlation"),
      graph.formalInputApprovalId,
      HUMAN_UID,
      graph.inputHash,
    ],
  );
  return runId;
}

async function insertFormalBitstream(
  client: Client,
  graph: FormalGraph,
  prefix: string,
): Promise<{ bitstreamResultId: string; bitstreamHash: string; bitstreamSize: number }> {
  const runId = await insertFormalToolRun(client, graph, "implement", id(`${prefix}_implement`), "succeeded");
  const manifestId = id(`${prefix}_evidence_manifest`);
  const entryId = id(`${prefix}_bitstream_entry`);
  const bitstreamResultId = id(`${prefix}_bitstream`);
  const name = "synthia.bit";
  const bytes = Buffer.from(`${prefix}:bitstream`, "utf8");
  const bitstreamHash = sha256Hex(bytes);
  const bitstreamSize = bytes.byteLength;
  const evidenceManifestHash = hex(`${name}:${bitstreamHash}:${bitstreamSize}:bitstream`);
  const storageUri = `content://sha256/${bitstreamHash}`;

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO tool_run_evidence_entry
         (id, project_id, manifest_id, tool_run_id, name, role,
          evidence_kind, uri, sha256, size_bytes, media_type,
          completeness, corrupt, managed_content)
       VALUES ($1,$2,$3,$4,$5,'bitstream','bitstream',$6,$7,$8,
               'application/octet-stream','full',false,$9)`,
      [
        entryId,
        graph.projectId,
        manifestId,
        runId,
        name,
        storageUri,
        bitstreamHash,
        bitstreamSize,
        bytes,
      ],
    );
    await client.query(
      `INSERT INTO tool_run_evidence_manifest
         (id, project_id, tool_run_id, run_state, operation, run_class,
          manifest_hash, input_hash, toolchain_profile_hash, parser_version,
          verdicts, entry_count, generated_by_type, generated_by,
          sealed_at, frozen_at)
       VALUES ($1,$2,$3,'succeeded','implement','formal',$4,$5,$6,
               'p4-postgres-test',$7,1,'system','p4-postgres-test',now(),now())`,
      [
        manifestId,
        graph.projectId,
        runId,
        evidenceManifestHash,
        graph.inputHash,
        graph.toolchainHash,
        JSON.stringify({ implementation: { passed: true }, drc: { errorCount: 0 }, timing: { met: true } }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  await client.query(
    `INSERT INTO bitstream_result
       (id, project_id, work_version_id, tool_run_id, evidence_manifest_id,
        evidence_manifest_hash, evidence_entry_name, class,
        formal_input_approval_id, snapshot_id, readiness_id, input_hash,
        engineering_config_hash, prerequisite_baseline_id, target_part,
        toolchain_profile_hash, constraint_hash, sha256, size_bytes,
        storage_uri, generated_by_type, generated_by, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'formal',$8,$9,$10,$11,$12,$13,
             'xc7k70tfbv676-1',$14,$15,$16,$17,$18,'system',
             'p4-postgres-test',now())`,
    [
      bitstreamResultId,
      graph.projectId,
      graph.workVersionId,
      runId,
      manifestId,
      evidenceManifestHash,
      name,
      graph.formalInputApprovalId,
      graph.snapshotId,
      graph.readinessId,
      graph.inputHash,
      graph.engineeringConfigHash,
      graph.b1BaselineId,
      graph.toolchainHash,
      graph.constraintHash,
      bitstreamHash,
      bitstreamSize,
      storageUri,
    ],
  );
  return { bitstreamResultId, bitstreamHash, bitstreamSize };
}

async function prepareReleaseGraph(
  client: Client,
  formal: FormalGraph,
  prefix: string,
  options: {
    releaseVersion?: number;
    supersedesReleaseId?: string | null;
    supersedesB2BaselineId?: string | null;
  } = {},
): Promise<ReleaseGraph> {
  const releaseId = id(`${prefix}_release`);
  const releaseVersion = options.releaseVersion ?? 1;
  const supersedesReleaseId = options.supersedesReleaseId ?? null;
  const approvalRecordId = id(`${prefix}_g4_approval`);
  const approvedGateResultId = id(`${prefix}_g4_result`);
  const b2BaselineId = id(`${prefix}_b2`);
  const g4SubmissionId = await insertSubmission(client, formal, "G4", "in_review");
  const bitstream = await insertFormalBitstream(client, formal, prefix);
  const candidateManifestHash = hex(`${prefix}:delivery-candidate`);
  const projection = {
    schema: "delivery-candidate.v1",
    releaseId,
    releaseVersion,
    workVersionId: formal.workVersionId,
    formalInputApprovalId: formal.formalInputApprovalId,
    bitstreamResultId: bitstream.bitstreamResultId,
    plannedApprovalRecordId: approvalRecordId,
    supersedesReleaseId,
  };
  const g4EvaluationId = await insertEvaluation(client, formal, g4SubmissionId, "G4", {
    sealedProjection: projection,
    sealedProjectionHash: candidateManifestHash,
  });
  await insertApprovedMilestone(client, formal, "G4", "B2", {
    submissionId: g4SubmissionId,
    approvalRecordId,
    approvedGateResultId,
    baselineId: b2BaselineId,
    supersedesBaselineId: options.supersedesB2BaselineId ?? null,
  });
  return {
    ...formal,
    ...bitstream,
    releaseId,
    releaseVersion,
    supersedesReleaseId,
    g4SubmissionId,
    g4EvaluationId,
    candidateManifestHash,
    approvalRecordId,
    approvedGateResultId,
    b2BaselineId,
  };
}

function releaseItems(graph: ReleaseGraph, prefix: string): ReleaseItem[] {
  const ordinary = (
    category: ReleaseItem["category"],
    path: string,
    sourceType: string,
    sourceId: string,
  ): ReleaseItem => {
    const contentHash = hex(`${prefix}:${category}:${path}`);
    return {
      id: id(`${prefix}_item`),
      category,
      path,
      source_type: sourceType,
      source_id: sourceId,
      sha256: contentHash,
      size_bytes: 1,
      media_type: "application/octet-stream",
      storage_uri: `content://sha256/${contentHash}`,
      provenance: { schema: "p4-postgres-fixture.v1" },
    };
  };
  return [
    ordinary("rtl", "rtl/top.sv", "artifact_revision", graph.revisionId),
    ordinary("tb", "tb/top_tb.sv", "artifact_revision", graph.revisionId),
    ordinary("constraint", "prj/constr/top.xdc", "artifact_revision", graph.revisionId),
    ordinary("document", "doc/design.md", "artifact_revision", graph.revisionId),
    ordinary("run_result", "runs/implement.json", "tool_run", graph.bitstreamResultId),
    ordinary("raw_evidence", "evidence/implement.log", "tool_run_evidence_manifest", graph.bitstreamResultId),
    ordinary("confirmation", "confirmations/readiness.json", "project_readiness", graph.readinessId),
    ordinary("confirmation", "confirmations/formal-input.json", "formal_input_approval", graph.formalInputApprovalId),
    ordinary("confirmation", "confirmations/g4-approval.json", "approval_record", graph.approvalRecordId),
    ordinary("source", "sources/revision.json", "artifact_revision", graph.revisionId),
    {
      id: id(`${prefix}_item_bitstream`),
      category: "bitstream",
      path: "bitstream/formal.bit",
      source_type: "bitstream_result",
      source_id: graph.bitstreamResultId,
      sha256: graph.bitstreamHash,
      size_bytes: graph.bitstreamSize,
      media_type: "application/octet-stream",
      storage_uri: `content://sha256/${graph.bitstreamHash}`,
      provenance: { schema: "p4-postgres-fixture.v1" },
    },
  ];
}

function manifestItem(item: ReleaseItem): Omit<ReleaseItem, "id"> {
  const { id: _id, ...manifest } = item;
  return manifest;
}

async function insertDeliveryBundle(
  client: Client,
  graph: ReleaseGraph,
  prefix: string,
  options: {
    omitCategory?: ReleaseItem["category"];
    manifestMismatch?: boolean;
  } = {},
): Promise<ReleaseItem[]> {
  const items = releaseItems(graph, prefix).filter((item) => item.category !== options.omitCategory);
  const manifestItems = items.map(manifestItem);
  if (options.manifestMismatch && manifestItems[0]) {
    manifestItems[0] = { ...manifestItems[0], sha256: hex(`${prefix}:manifest-mismatch`) };
  }
  const manifest = {
    schema: "delivery-manifest.v1",
    project_id: graph.projectId,
    release_id: graph.releaseId,
    version: graph.releaseVersion,
    work_version_id: graph.workVersionId,
    input_hash: graph.inputHash,
    items: manifestItems,
  };

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO delivery_release
         (id, project_id, version, supersedes_release_id, process_version_id,
          process_instance_id, work_version_id, gate_submission_id,
          gate_check_evaluation_id, candidate_manifest_hash,
          approval_record_id, approved_gate_result_id, baseline_id,
          formal_input_approval_id, bitstream_result_id, schema_version,
          manifest, manifest_hash, item_count, state, generated_by_type,
          generated_by, generated_at, confirmed_by, confirmed_at, released_at)
       VALUES ($1,$2,$3,$4,'GJB_REF_V1',$5,$6,$7,$8,$9,$10,$11,$12,$13,
               $14,'delivery-manifest.v1',$15,$16,$17,'sealed','system',
               'p4-postgres-test',now(),$18,now(),now())`,
      [
        graph.releaseId,
        graph.projectId,
        graph.releaseVersion,
        graph.supersedesReleaseId,
        graph.processInstanceId,
        graph.workVersionId,
        graph.g4SubmissionId,
        graph.g4EvaluationId,
        graph.candidateManifestHash,
        graph.approvalRecordId,
        graph.approvedGateResultId,
        graph.b2BaselineId,
        graph.formalInputApprovalId,
        graph.bitstreamResultId,
        JSON.stringify(manifest),
        hex(JSON.stringify(manifest)),
        items.length,
        HUMAN_UID,
      ],
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO delivery_release_item
           (id, project_id, release_id, category, path, source_type,
            source_id, sha256, size_bytes, media_type, storage_uri, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          item.id,
          graph.projectId,
          graph.releaseId,
          item.category,
          item.path,
          item.source_type,
          item.source_id,
          item.sha256,
          item.size_bytes,
          item.media_type,
          item.storage_uri,
          JSON.stringify(item.provenance),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return items;
}

async function prepareChangedFormalGraph(
  client: Client,
  previous: ReleaseGraph,
  prefix: string,
): Promise<FormalGraph & { changeRequestId: string }> {
  await client.query(
    `UPDATE project_work_version
        SET state = 'released', current_gate = 'G4', released_at = now()
      WHERE id = $1`,
    [previous.workVersionId],
  );
  const changeRequestId = id(`${prefix}_change_request`);
  const workVersionId = id(`${prefix}_work`);
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO change_request
         (id, project_id, base_delivery_release_id, project_work_version_id,
          reason, affected_paths, impact_gate, request_hash, state,
          proposed_by_type, proposed_by, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,'P4 follow-up change',$5,'G4',$6,'open',
               'human',$7,$7,now())`,
      [
        changeRequestId,
        previous.projectId,
        previous.releaseId,
        workVersionId,
        ["rtl/top.sv"],
        hex(`${prefix}:change-request`),
        HUMAN_UID,
      ],
    );
    await client.query(
      `INSERT INTO project_work_version
         (id, project_id, process_instance_id, version, origin,
          change_request_id, base_delivery_release_id, start_gate,
          current_gate, state, created_by_type, created_by)
       VALUES ($1,$2,$3,$4,'change_request',$5,$6,'G4','G4','working',
               'human',$7)`,
      [
        workVersionId,
        previous.projectId,
        previous.processInstanceId,
        previous.releaseVersion + 1,
        changeRequestId,
        previous.releaseId,
        HUMAN_UID,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const graph: ProjectGraph = {
    ...previous,
    workVersionId,
    snapshotId: id(`${prefix}_snapshot`),
    snapshotHash: hex(`${prefix}:snapshot`),
  };
  await client.query(
    `INSERT INTO configuration_snapshot
       (id, project_id, member_revision_ids, trace_relation_ids,
        gate_profile_version, tool_model_policy_hash, manifest_hash,
        created_by, work_version_id)
     VALUES ($1,$2,$3,'{}','GJB_REF_V1',$4,$5,$6,$7)`,
    [
      graph.snapshotId,
      graph.projectId,
      [graph.revisionId],
      hex(`${prefix}:policy`),
      graph.snapshotHash,
      HUMAN_UID,
      workVersionId,
    ],
  );
  const readiness = await insertReadiness(
    client,
    graph,
    prefix,
    previous.readinessSequence + 1,
    previous.readinessId,
  );
  const approval = await insertFormalInputApproval(client, graph, {
    ...readiness,
    mainTaskId: previous.mainTaskId,
    baselineId: previous.b1BaselineId,
  }, prefix);
  return {
    ...graph,
    ...readiness,
    readinessSequence: previous.readinessSequence + 1,
    mainTaskId: previous.mainTaskId,
    b1BaselineId: previous.b1BaselineId,
    ...approval,
    changeRequestId,
  };
}

const HUMAN_UID = "p4-postgres-human";
const RUNTIME_UID = "p4-postgres-runtime";
const LEGACY_PROJECT_ID = "p4-legacy-upgrade-project";
const LEGACY_PROCESS_ID = "p4-legacy-upgrade-process";

describe.skipIf(!DATABASE_URL)("P4 — real PostgreSQL behavior", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await applyMigrationsThrough(client, "0009_task_workspaces");

    await client.query(
      `INSERT INTO project
         (id, name, scope, data_classification, standard_version, target_part,
          status, project_type, process_version_id, process_profile_id,
          process_profile_version, process_profile_name)
       VALUES ($1,'legacy P4 upgrade','','D1','GB/T 33781-2017',
               'xc7k70tfbv676-1','active','engineering','GJB_REF_V1',
               'GJB_REF_V1','GJB_REF_V1','GJB 参考流程 v1')`,
      [LEGACY_PROJECT_ID],
    );
    await client.query(
      `INSERT INTO process_instance
         (id, project_id, gate_profile_version, current_gate)
       VALUES ($1,$2,'GJB_REF_V1','G7')`,
      [LEGACY_PROCESS_ID, LEGACY_PROJECT_ID],
    );

    await applyMigrationsThrough(client, "0011_delivery_release");
    await insertIdentity(client, "human", HUMAN_UID);
    await insertIdentity(client, "service", RUNTIME_UID);
  }, 60_000);

  afterAll(async () => {
    if (client) await client.end();
  });

  test("0009→0011 rebuilds legacy GJB_REF_V1 current_gate to G0 without governance success facts", async () => {
    const state = await client.query<{
      current_gate: string;
      start_gate: string;
      work_gate: string;
      work_state: string;
    }>(
      `SELECT process.current_gate::text,
              work.start_gate::text,
              work.current_gate::text AS work_gate,
              work.state AS work_state
         FROM process_instance process
         JOIN project_work_version work
           ON work.process_instance_id = process.id AND work.project_id = process.project_id
        WHERE process.id = $1 AND process.project_id = $2`,
      [LEGACY_PROCESS_ID, LEGACY_PROJECT_ID],
    );
    expect(state.rows).toEqual([{
      current_gate: "G0",
      start_gate: "G0",
      work_gate: "G0",
      work_state: "working",
    }]);

    for (const table of [
      "project_readiness",
      "formal_input_approval",
      "approval_record",
      "approved_gate_result",
      "delivery_release",
    ]) {
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE project_id = $1`,
        [LEGACY_PROJECT_ID],
      );
      expect(count.rows[0]?.count).toBe(0);
    }
  });

  test("snapshot and submission reject crossed work-version ownership", async () => {
    const graph = await insertEngineeringProject(client, "crossed_snapshot", "G1");
    const foreign = await insertEngineeringProject(client, "crossed_snapshot_foreign", "G1");
    const snapshotError = await capturePgFailure(() => client.query(
      `INSERT INTO configuration_snapshot
         (id, project_id, member_revision_ids, trace_relation_ids,
          gate_profile_version, tool_model_policy_hash, manifest_hash,
          created_by, work_version_id)
       VALUES ($1,$2,$3,'{}','GJB_REF_V1',$4,$5,$6,$7)`,
      [
        id("crossed_snapshot_invalid"),
        graph.projectId,
        [graph.revisionId],
        hex("crossed-snapshot-policy"),
        hex("crossed-snapshot-manifest"),
        HUMAN_UID,
        foreign.workVersionId,
      ],
    ));
    expect(snapshotError.code).toBe("23514");
    expect(snapshotError.message).toContain("active project work version");

    await client.query(
      `UPDATE project_work_version
          SET state = 'abandoned', abandoned_at = now()
        WHERE id = $1`,
      [graph.workVersionId],
    );
    const nextWorkVersionId = id("crossed_snapshot_work_2");
    await client.query(
      `INSERT INTO project_work_version
         (id, project_id, process_instance_id, version, origin, start_gate,
          current_gate, state, created_by_type, created_by)
       VALUES ($1,$2,$3,2,'initial','G1','G1','working','system','p4-postgres-test')`,
      [nextWorkVersionId, graph.projectId, graph.processInstanceId],
    );

    const error = await capturePgFailure(() => client.query(
      `INSERT INTO gate_submission
         (id, project_id, process_instance_id, gate, snapshot_id, state,
          submitter_id, work_version_id)
       VALUES ($1,$2,$3,'G1',$4,'checking',$5,$6)`,
      [
        id("crossed_submission"),
        graph.projectId,
        graph.processInstanceId,
        graph.snapshotId,
        HUMAN_UID,
        nextWorkVersionId,
      ],
    ));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("work-version snapshot");
  });

  test("evaluation rejects a work version different from its submission and snapshot", async () => {
    const graph = await insertEngineeringProject(client, "crossed_evaluation", "G1");
    const submissionId = await insertSubmission(client, graph, "G1");
    await client.query(
      `UPDATE project_work_version
          SET state = 'abandoned', abandoned_at = now()
        WHERE id = $1`,
      [graph.workVersionId],
    );
    const nextWorkVersionId = id("crossed_evaluation_work_2");
    await client.query(
      `INSERT INTO project_work_version
         (id, project_id, process_instance_id, version, origin, start_gate,
          current_gate, state, created_by_type, created_by)
       VALUES ($1,$2,$3,2,'initial','G1','G1','working','system','p4-postgres-test')`,
      [nextWorkVersionId, graph.projectId, graph.processInstanceId],
    );

    const error = await capturePgFailure(() => insertEvaluation(
      client,
      graph,
      submissionId,
      "G1",
      { workVersionId: nextWorkVersionId },
    ));
    expect(["23503", "23514"]).toContain(error.code);
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM gate_check_evaluation WHERE gate_submission_id = $1",
      [submissionId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  test("each submission can commit only one immutable evaluation", async () => {
    const graph = await insertEngineeringProject(client, "unique_evaluation", "G1");
    const submissionId = await insertSubmission(client, graph, "G1");
    await insertEvaluation(client, graph, submissionId, "G1");

    const error = await capturePgFailure(() => insertEvaluation(client, graph, submissionId, "G1"));
    expect(error.code).toBe("23505");
    expect(error.constraint).toBe("gate_check_evaluation_one_per_submission_idx");

    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM gate_check_evaluation WHERE gate_submission_id = $1",
      [submissionId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  test("managed formal input bytes enforce digest, size, and append-only storage", async () => {
    const graph = await insertEngineeringProject(client, "managed_input", "G4");
    const bytes = Buffer.from("managed formal bytes", "utf8");
    const digest = sha256Hex(bytes);
    await client.query(
      `INSERT INTO formal_input_content (project_id, sha256, size_bytes, managed_content)
       VALUES ($1,$2,$3,$4)`,
      [graph.projectId, digest, bytes.byteLength, bytes],
    );

    const wrongDigest = await capturePgFailure(() => client.query(
      `INSERT INTO formal_input_content (project_id, sha256, size_bytes, managed_content)
       VALUES ($1,$2,$3,$4)`,
      [graph.projectId, hex("wrong digest"), bytes.byteLength, bytes],
    ));
    expect(wrongDigest.code).toBe("23514");
    const update = await capturePgFailure(() => client.query(
      "UPDATE formal_input_content SET managed_content = $3 WHERE project_id = $1 AND sha256 = $2",
      [graph.projectId, digest, Buffer.from("changed", "utf8")],
    ));
    expect(update.code).toBe("55000");
    const deletion = await capturePgFailure(() => client.query(
      "DELETE FROM formal_input_content WHERE project_id = $1 AND sha256 = $2",
      [graph.projectId, digest],
    ));
    expect(deletion.code).toBe("55000");
  });

  test("concurrent formal ToolRun inserts allow one project+approval+operation winner", async () => {
    const graph = await insertFormalGraph(client, "formal_concurrency");
    const first = new Client({ connectionString: DATABASE_URL });
    const second = new Client({ connectionString: DATABASE_URL });
    await Promise.all([first.connect(), second.connect()]);
    try {
      const attempts = await Promise.allSettled([
        insertFormalToolRun(first, graph, "simulate", id("formal_simulate_a")),
        insertFormalToolRun(second, graph, "simulate", id("formal_simulate_b")),
      ]);
      const fulfilled = attempts.filter((result) => result.status === "fulfilled");
      const rejected = attempts.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]?.reason as PgErrorLike).code).toBe("23505");
      expect((rejected[0]?.reason as PgErrorLike).constraint).toBe("tool_run_one_formal_operation_idx");
    } finally {
      await Promise.all([first.end(), second.end()]);
    }

    const count = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM tool_run
        WHERE project_id = $1 AND formal_input_approval_id = $2
          AND operation = 'simulate' AND binding_version = 'formal-input.v1'`,
      [graph.projectId, graph.formalInputApprovalId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  test("delivery release and items roll back together when a category is missing", async () => {
    const formal = await insertFormalGraph(client, "release_missing_category");
    const graph = await prepareReleaseGraph(client, formal, "release_missing_category");
    const error = await capturePgFailure(() => insertDeliveryBundle(
      client,
      graph,
      "release_missing_category",
      { omitCategory: "document" },
    ));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("item set is incomplete");

    const rows = await client.query<{ releases: number; items: number }>(
      `SELECT
         (SELECT count(*)::int FROM delivery_release WHERE id = $1) AS releases,
         (SELECT count(*)::int FROM delivery_release_item WHERE release_id = $1) AS items`,
      [graph.releaseId],
    );
    expect(rows.rows[0]).toEqual({ releases: 0, items: 0 });
  });

  test("delivery manifest mismatch aborts the release and every item", async () => {
    const formal = await insertFormalGraph(client, "release_manifest_mismatch");
    const graph = await prepareReleaseGraph(client, formal, "release_manifest_mismatch");
    const error = await capturePgFailure(() => insertDeliveryBundle(
      client,
      graph,
      "release_manifest_mismatch",
      { manifestMismatch: true },
    ));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("manifest does not match");

    const rows = await client.query<{ releases: number; items: number }>(
      `SELECT
         (SELECT count(*)::int FROM delivery_release WHERE id = $1) AS releases,
         (SELECT count(*)::int FROM delivery_release_item WHERE release_id = $1) AS items`,
      [graph.releaseId],
    );
    expect(rows.rows[0]).toEqual({ releases: 0, items: 0 });
  });

  test("sealed release and items reject update, delete, and post-commit append", async () => {
    const formal = await insertFormalGraph(client, "release_immutable");
    const graph = await prepareReleaseGraph(client, formal, "release_immutable");
    const items = await insertDeliveryBundle(client, graph, "release_immutable");
    expect(items).toHaveLength(11);

    const committed = await client.query<{ state: string; item_count: number; actual_items: number }>(
      `SELECT release.state, release.item_count,
              count(item.id)::int AS actual_items
         FROM delivery_release release
         JOIN delivery_release_item item
           ON item.release_id = release.id AND item.project_id = release.project_id
        WHERE release.id = $1
        GROUP BY release.id`,
      [graph.releaseId],
    );
    expect(committed.rows[0]).toEqual({ state: "sealed", item_count: 11, actual_items: 11 });

    const appendError = await capturePgFailure(() => client.query(
      `INSERT INTO delivery_release_item
         (id, project_id, release_id, category, path, source_type,
          source_id, sha256, size_bytes, media_type, storage_uri, provenance)
       VALUES ($1,$2,$3,'document','doc/late.md','artifact_revision',$4,$5,1,
               'text/markdown',$6,'{}')`,
      [
        id("late_item"),
        graph.projectId,
        graph.releaseId,
        graph.revisionId,
        hex("late-item"),
        `content://sha256/${hex("late-item")}`,
      ],
    ));
    expect(appendError.code).toBe("55000");

    for (const mutation of [
      () => client.query("UPDATE delivery_release SET generated_by = 'changed' WHERE id = $1", [graph.releaseId]),
      () => client.query("DELETE FROM delivery_release WHERE id = $1", [graph.releaseId]),
      () => client.query("UPDATE delivery_release_item SET path = 'doc/changed.md' WHERE id = $1", [items[0]?.id]),
      () => client.query("DELETE FROM delivery_release_item WHERE id = $1", [items[0]?.id]),
    ]) {
      const error = await capturePgFailure(mutation);
      expect(error.code).toBe("55000");
    }

    const after = await client.query<{ releases: number; items: number }>(
      `SELECT
         (SELECT count(*)::int FROM delivery_release WHERE id = $1) AS releases,
         (SELECT count(*)::int FROM delivery_release_item WHERE release_id = $1) AS items`,
      [graph.releaseId],
    );
    expect(after.rows[0]).toEqual({ releases: 1, items: 11 });
  });

  test("a superseded release remains sealed and cannot anchor a new change request", async () => {
    const firstFormal = await insertFormalGraph(client, "release_history_v1");
    const first = await prepareReleaseGraph(client, firstFormal, "release_history_v1");
    await insertDeliveryBundle(client, first, "release_history_v1");

    const changed = await prepareChangedFormalGraph(client, first, "release_history_v2");
    const second = await prepareReleaseGraph(client, changed, "release_history_v2", {
      releaseVersion: 2,
      supersedesReleaseId: first.releaseId,
      supersedesB2BaselineId: first.b2BaselineId,
    });
    await insertDeliveryBundle(client, second, "release_history_v2");
    await client.query(
      `UPDATE project_work_version
          SET state = 'released', current_gate = 'G4', released_at = now()
        WHERE id = $1`,
      [second.workVersionId],
    );
    await client.query(
      `UPDATE change_request
          SET state = 'released', released_at = now()
        WHERE id = $1`,
      [changed.changeRequestId],
    );

    const history = await client.query<{
      id: string;
      version: number;
      state: string;
      supersedes_release_id: string | null;
    }>(
      `SELECT id, version, state, supersedes_release_id
         FROM delivery_release
        WHERE project_id = $1
        ORDER BY version`,
      [first.projectId],
    );
    expect(history.rows).toEqual([
      { id: first.releaseId, version: 1, state: "sealed", supersedes_release_id: null },
      { id: second.releaseId, version: 2, state: "sealed", supersedes_release_id: first.releaseId },
    ]);

    const error = await capturePgFailure(() => client.query(
      `INSERT INTO change_request
         (id, project_id, base_delivery_release_id, project_work_version_id,
          reason, affected_paths, impact_gate, request_hash, state,
          proposed_by_type, proposed_by, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,'must reject stale release',$5,'G4',$6,'open',
               'human',$7,$7,now())`,
      [
        id("stale_release_change"),
        first.projectId,
        first.releaseId,
        id("uncommitted_work"),
        ["rtl/top.sv"],
        hex("stale-release-change"),
        HUMAN_UID,
      ],
    ));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("latest sealed delivery");
  }, 30_000);
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; P4 PostgreSQL behavior tests were not executed", () => {});
}
