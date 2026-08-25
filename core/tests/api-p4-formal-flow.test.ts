import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ToolRunState } from "../src/domain/enums.ts";
import { sha256Hex } from "../src/hashing.ts";
import type {
  ConnectorDiscovery,
  ConnectorJobSnapshot,
  ConnectorPort,
  EvidenceContent,
  EvidenceManifest,
  SubmitJobParams,
} from "../src/api/connector-port.ts";
import { routeApi } from "../src/api/router.ts";
import { DISABLED_CORE_FEATURE_FLAGS } from "../src/api/feature-flags.ts";
import { installP4ProjectMutationLockTestHook } from "../src/api/p4-write-guard.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  truncateDomainTables,
  type ApiHarness,
} from "./support/api-harness.ts";
import {
  g1GateEvidence,
  g2GateEvidence,
  g3GateEvidence,
} from "./support/p4-gate-evidence-fixture.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const TOOLCHAIN_HASH = sha256Hex("p4-test-toolchain");
const TARGET_PART = "xc7k70tfbv676-1";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface StoredEvidence {
  readonly manifest: EvidenceManifest;
  readonly content: ReadonlyMap<string, EvidenceContent>;
}

class FormalConnector implements ConnectorPort {
  readonly connectorId = "p4-test-connector";
  readonly submissions = new Map<string, SubmitJobParams>();
  readonly downstreamKeys = new Map<string, string>();
  submitCalls = 0;
  queryStatusCalls = 0;
  discoveryOverride: ConnectorDiscovery | Error | undefined;

  async discover(): Promise<ConnectorDiscovery> {
    if (this.discoveryOverride instanceof Error) throw this.discoveryOverride;
    if (this.discoveryOverride) return this.discoveryOverride;
    return {
      drift: false,
      toolchainProfileHash: TOOLCHAIN_HASH,
      capabilities: ["validate_sources", "simulate", "synthesize", "implement"].map((operation) => ({
        operation,
        version: "p4-test.v1",
        runClasses: ["exploratory", "formal"],
      })),
    };
  }

  async submitJob(params: SubmitJobParams): Promise<ConnectorJobSnapshot> {
    const fingerprint = JSON.stringify({
      jobId: params.jobId,
      projectId: params.projectId,
      operation: params.operation,
      runClass: params.runClass,
      correlationId: params.correlationId,
      inputHash: params.inputHash,
      toolchainProfileHash: params.toolchainProfileHash,
      parameters: params.parameters,
    });
    const prior = this.downstreamKeys.get(params.idempotencyKey);
    if (prior !== undefined && prior !== fingerprint) throw new Error("downstream idempotency conflict");
    if (prior === undefined) {
      this.submitCalls += 1;
      this.downstreamKeys.set(params.idempotencyKey, fingerprint);
      this.submissions.set(params.jobId, params);
    }
    return { jobId: params.jobId, state: "queued" };
  }

  async queryStatus(_projectId: string, jobId: string): Promise<ConnectorJobSnapshot> {
    this.queryStatusCalls += 1;
    if (!this.submissions.has(jobId)) throw new Error(`unknown job: ${jobId}`);
    return { jobId, state: "succeeded" as ToolRunState, outputSha256: sha256Hex(`output:${jobId}`) };
  }

  private evidence(jobId: string): StoredEvidence {
    const submission = this.submissions.get(jobId);
    if (!submission) throw new Error(`unknown job: ${jobId}`);
    const byUtf8Path = (left: { path: string }, right: { path: string }) => Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    );
    const member = (entry: { path: string; content: string; mediaType?: string }) => {
      const bytes = new TextEncoder().encode(entry.content);
      return {
        path: entry.path,
        sha256: sha256Hex(bytes),
        sizeBytes: bytes.byteLength,
        mediaType: entry.mediaType ?? "application/octet-stream",
      };
    };
    const inputManifest = {
      schema: "vivado-input-manifest.v1",
      jobId,
      projectId: submission.projectId,
      operation: submission.operation,
      runClass: submission.runClass,
      inputHash: submission.inputHash,
      toolchainHash: submission.toolchainProfileHash,
      top: submission.parameters.top ?? null,
      testbench: submission.operation === "simulate" ? submission.parameters.testbench ?? null : null,
      part: submission.operation === "synthesize" || submission.operation === "implement"
        ? submission.parameters.part ?? null
        : null,
      sources: submission.parameters.sources.map(member).sort(byUtf8Path),
      constraints: submission.parameters.constraints.map(member).sort(byUtf8Path),
    };
    const result = (schema: string) => JSON.stringify({
      schema,
      passed: true,
      status: "succeeded",
      exitCode: 0,
      timedOut: false,
    });
    const entries: Array<{ name: string; content: string | Uint8Array; mediaType: string }> = [
      { name: "input-manifest.json", content: JSON.stringify(inputManifest), mediaType: "application/json" },
      { name: "run.tcl", content: "# governed test run\n", mediaType: "text/plain" },
      { name: "stderr.log", content: "", mediaType: "text/plain" },
      { name: "tool.log", content: "Vivado test tool log\n", mediaType: "text/plain" },
    ];
    if (submission.operation === "validate_sources") {
      entries.push(
        { name: "stdout.log", content: "SOURCE_VALIDATION_OK\n", mediaType: "text/plain" },
        { name: "validation_result.json", content: result("validate_sources-result.v1"), mediaType: "application/json" },
      );
    } else if (submission.operation === "simulate") {
      entries.push(
        {
          name: "stdout.log",
          content: "SIMULATOR_OUTPUT_BEGIN\nPASS\nSIMULATOR_OUTPUT_END\nSIMULATION_OK\nPHASE_EXIT_CODE=0\n",
          mediaType: "text/plain",
        },
        { name: "simulation_result.json", content: result("simulate-result.v1"), mediaType: "application/json" },
      );
    } else if (submission.operation === "synthesize") {
      entries.push(
        { name: "stdout.log", content: "synthesis complete\n", mediaType: "text/plain" },
        { name: "synthesis_result.json", content: result("synthesize-result.v1"), mediaType: "application/json" },
        { name: "resources.rpt", content: "LUT 1\n", mediaType: "text/plain" },
      );
    } else {
      entries.push(
        { name: "stdout.log", content: "implementation complete\n", mediaType: "text/plain" },
        { name: "implementation_result.json", content: result("implement-result.v1"), mediaType: "application/json" },
        { name: "synth.dcp", content: new Uint8Array([1, 2, 3]), mediaType: "application/octet-stream" },
        { name: "drc.rpt", content: "DRC finished with 0 Errors\n", mediaType: "text/plain" },
        {
          name: "timing.rpt",
          content: "Clock : clk\nWNS(ns) TNS(ns)\n0.125 0.000\nAll user specified timing constraints are met.\n",
          mediaType: "text/plain",
        },
        { name: "resources.rpt", content: "LUT 1\n", mediaType: "text/plain" },
        { name: "routed.dcp", content: new Uint8Array([4, 5, 6]), mediaType: "application/octet-stream" },
        { name: "formal.bit", content: new Uint8Array([7, 8, 9, 10]), mediaType: "application/octet-stream" },
      );
    }
    const content = new Map<string, EvidenceContent>();
    const manifestEntries = entries.map((entry) => {
      const bytes = typeof entry.content === "string"
        ? new TextEncoder().encode(entry.content)
        : entry.content;
      const text = typeof entry.content === "string" ? entry.content : "";
      const sha256 = sha256Hex(bytes);
      content.set(entry.name, {
        name: entry.name,
        content: text,
        bytes,
        sha256,
        truncated: false,
        mediaType: entry.mediaType,
      });
      return { name: entry.name, sha256, sizeBytes: bytes.byteLength, mediaType: entry.mediaType };
    });
    return { manifest: { jobId, entries: manifestEntries }, content };
  }

  async fetchEvidence(_projectId: string, jobId: string): Promise<EvidenceManifest> {
    return this.evidence(jobId).manifest;
  }

  async fetchEvidenceContent(
    _projectId: string,
    jobId: string,
    name: string,
  ): Promise<EvidenceContent> {
    const content = this.evidence(jobId).content.get(name);
    if (!content) throw new Error(`missing evidence: ${name}`);
    return content;
  }
}

function envelopeData(json: unknown): Record<string, any> {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid envelope");
  const value = (json as Record<string, unknown>).data;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid data: ${JSON.stringify(json)}`);
  return value as Record<string, any>;
}

function envelopeArray(json: unknown): Record<string, any>[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid envelope");
  const value = (json as Record<string, unknown>).data;
  if (!Array.isArray(value)) throw new Error(`invalid list data: ${JSON.stringify(json)}`);
  return value as Record<string, any>[];
}

describe.skipIf(!DATABASE_URL)("P4 formal flow API — real PostgreSQL", () => {
  let harness: ApiHarness;
  let connector: FormalConnector;

  beforeAll(async () => {
    connector = new FormalConnector();
    harness = await setupApiHarness(DATABASE_URL, {
      features: { formalDelivery: true },
      connector,
    });
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
    connector.submissions.clear();
    connector.downstreamKeys.clear();
    connector.submitCalls = 0;
    connector.queryStatusCalls = 0;
    connector.discoveryOverride = undefined;
  });

  afterAll(async () => {
    await teardownApiHarness(harness);
  });

  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    key = `idem-${randomUUID()}`,
  ) {
    return callAs(harness.ids.humanToken, path, method, body, key);
  }

  async function callAs(
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
    key = `idem-${randomUUID()}`,
    taskId?: string,
  ) {
    return apiCall(harness.baseUrl, path, {
      method,
      body,
      token,
      headers: {
        ...(method === "GET" ? {} : { "idempotency-key": key }),
        ...(taskId ? { "x-synthia-task-id": taskId } : {}),
      },
    });
  }

  async function createModernProject(projectId: string): Promise<void> {
    const created = await call("/api/v1/projects", "POST", {
      id: projectId,
      name: "P4 API fixture",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
      target_part: TARGET_PART,
      toolchain_profile_ref: TOOLCHAIN_HASH,
    });
    expect(created.status).toBe(201);
    const role = await call(`/api/v1/projects/${projectId}/role-assignments`, "POST", {
      id: `role-${projectId}`,
      actor_type: "human",
      actor_id: harness.ids.humanUid,
      role: "quality",
    });
    expect(role.status).toBe(201);
  }

  async function createRevision(
    projectId: string,
    id: string,
    artifactType: string,
    path: string,
    content: string,
  ): Promise<void> {
    const response = await call(`/api/v1/projects/${projectId}/artifacts/art-${id}/revisions`, "POST", {
      id,
      artifact_type: artifactType,
      title: path,
      content,
      content_location: path,
    });
    if (response.status !== 201) throw new Error(`revision ${id}: ${JSON.stringify(response.json)}`);
  }

  async function createApprovedTrace(
    projectId: string,
    id: string,
    sourceRevisionId: string,
    targetRevisionId: string,
  ): Promise<void> {
    const response = await call(`/api/v1/projects/${projectId}/trace-relations`, "POST", {
      id,
      source_type: "artifact_revision",
      source_id: sourceRevisionId,
      target_type: "artifact_revision",
      target_id: targetRevisionId,
      relation_kind: "traces_to",
      state: "approved",
      basis: "P4 structured gate evidence fixture",
      data_classification: "D1",
    });
    if (response.status !== 201) throw new Error(`trace ${id}: ${JSON.stringify(response.json)}`);
  }

  async function readinessBody(
    projectId: string,
    workVersionId: string,
    readinessId: string,
    constraints: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tree = await call(`/api/v1/projects/${projectId}/workspace/tree`);
    const workspace = envelopeData(tree.json);
    return {
      id: readinessId,
      work_version_id: workVersionId,
      reason: "P4 test readiness",
      source_snapshot_ids: [],
      workspace_expected_commit: workspace.head_commit,
      workspace_manifest_hash: workspace.workspace_manifest_hash,
      engineering_config: {
        schema: "engineering-config.v1",
        targetPart: { value: TARGET_PART, state: "identified" },
        board: { ref: "board-kc705-v1", state: "identified" },
        constraints,
        dataScope: { classification: "D1", description: "P4 controlled fixture" },
        sourcePolicy: { confirmedOnly: true },
      },
    };
  }

  async function prepareReadiness(
    projectId: string,
    workVersionId: string,
    readinessId: string,
    xdcRevisionId: string,
  ): Promise<Record<string, any>> {
    const body = await readinessBody(projectId, workVersionId, readinessId, {
      pin: { state: "complete", revisionIds: [xdcRevisionId] },
      electrical: { state: "complete", revisionIds: [xdcRevisionId] },
      clock: { state: "complete", revisionIds: [xdcRevisionId] },
    });
    const prepared = await call(`/api/v1/projects/${projectId}/readiness`, "POST", body);
    if (prepared.status !== 201) throw new Error(`readiness: ${JSON.stringify(prepared.json)}`);
    const confirmed = await call(`/api/v1/projects/${projectId}/readiness/${readinessId}/confirm`, "POST", {
      reason: "human confirms fixture",
    });
    if (confirmed.status !== 200) throw new Error(`confirm readiness: ${JSON.stringify(confirmed.json)}`);
    return envelopeData(confirmed.json);
  }

  async function createSnapshot(
    projectId: string,
    workVersionId: string,
    snapshotId: string,
    revisionIds: string[],
    profileHash: string,
    traceRelationIds: string[] = [],
  ): Promise<Record<string, any>> {
    const response = await call(`/api/v1/projects/${projectId}/snapshots`, "POST", {
      id: snapshotId,
      work_version_id: workVersionId,
      member_revision_ids: revisionIds,
      trace_relation_ids: traceRelationIds,
      gate_profile_version: "GJB_REF_V1",
      tool_model_policy_hash: profileHash,
    });
    if (response.status !== 201) throw new Error(`snapshot: ${JSON.stringify(response.json)}`);
    return envelopeData(response.json);
  }

  async function passGate(input: {
    projectId: string;
    workVersionId: string;
    processInstanceId: string;
    gate: "G1" | "G2" | "G3";
    snapshotId: string;
    snapshotHash: string;
    baselineId: string | null;
  }): Promise<void> {
    const submissionId = `sub-${input.gate.toLowerCase()}-${input.workVersionId}`;
    const evaluationId = `eval-${input.gate.toLowerCase()}-${input.workVersionId}`;
    const submission = await call(`/api/v1/projects/${input.projectId}/gate-submissions`, "POST", {
      id: submissionId,
      process_instance_id: input.processInstanceId,
      work_version_id: input.workVersionId,
      gate: input.gate,
      snapshot_id: input.snapshotId,
    });
    if (submission.status !== 201) throw new Error(`submission: ${JSON.stringify(submission.json)}`);
    const evaluated = await call(
      `/api/v1/projects/${input.projectId}/gate-submissions/${submissionId}/evaluations`,
      "POST",
      {
        evaluation_id: evaluationId,
        work_version_id: input.workVersionId,
        expected_snapshot_manifest_hash: input.snapshotHash,
      },
    );
    if (evaluated.status !== 201) throw new Error(`evaluation: ${JSON.stringify(evaluated.json)}`);
    const evaluation = envelopeData(evaluated.json);
    expect(evaluation.passed).toBe(true);
    const submitted = await call(
      `/api/v1/projects/${input.projectId}/gate-submissions/${submissionId}/submit`,
      "POST",
      { gate_check_evaluation_id: evaluationId, check_results_hash: evaluation.result_hash },
    );
    if (submitted.status !== 200) throw new Error(`gate submit: ${JSON.stringify(submitted.json)}`);
    const approved = await call(
      `/api/v1/projects/${input.projectId}/gate-submissions/${submissionId}/approve`,
      "POST",
      {
        configuration_snapshot_id: input.snapshotId,
        approved_gate_result_id: `agr-${input.gate.toLowerCase()}-${input.workVersionId}`,
        approver_role: "quality",
        check_results_hash: evaluation.result_hash,
        signed_at: new Date().toISOString(),
        signature_method: "platform_token",
        reason: `${input.gate} fixture approved`,
        baseline_id: input.baselineId,
        gate_check_evaluation_id: evaluationId,
      },
    );
    if (approved.status !== 200) throw new Error(`gate approve: ${JSON.stringify(approved.json)}`);
  }

  async function createMainTask(projectId: string, processInstanceId: string, taskId: string): Promise<void> {
    await harness.client.query(
      `INSERT INTO agent_task
        (id, project_id, project_type, kind, process_instance_id,
         runtime_actor_id, objective, authorization_scope, status, input_hash,
         adoption_state, created_by_type, created_by)
       VALUES ($1,$2,'engineering','main',$3,$4,'P4 fixture task','{}'::jsonb,
               'running',$5,'not_applicable','human',$6)`,
      [taskId, projectId, processInstanceId, harness.ids.serviceUid, sha256Hex(`task:${taskId}`), harness.ids.humanUid],
    );
  }

  async function runFormalJobs(projectId: string, approvalId: string): Promise<Record<string, string>> {
    const jobs: Record<string, string> = {};
    for (const operation of ["validate_sources", "simulate", "synthesize", "implement"] as const) {
      const submitted = await call(`/api/v1/projects/${projectId}/jobs`, "POST", {
        operation,
        run_class_intent: "formal",
        formal_input_approval_id: approvalId,
      }, `formal-${approvalId}-${operation}`);
      if (submitted.status !== 201) throw new Error(`formal ${operation}: ${JSON.stringify(submitted.json)}`);
      const job = envelopeData(submitted.json);
      jobs[operation] = job.jobId;
      const status = await call(`/api/v1/projects/${projectId}/jobs/${job.jobId}`);
      if (status.status !== 200 || envelopeData(status.json).state !== "succeeded") {
        throw new Error(`formal status ${operation}: ${JSON.stringify(status.json)}`);
      }
      const frozen = await call(
        `/api/v1/projects/${projectId}/jobs/${job.jobId}/evidence/freeze`,
        "POST",
        {},
        `freeze-${job.jobId}`,
      );
      if (frozen.status !== 201) throw new Error(`freeze ${operation}: ${JSON.stringify(frozen.json)}`);
      const replayedFreeze = await call(
        `/api/v1/projects/${projectId}/jobs/${job.jobId}/evidence/freeze`,
        "POST",
        {},
        `freeze-${job.jobId}`,
      );
      expect(replayedFreeze.status).toBe(201);
      expect(envelopeData(replayedFreeze.json)).toEqual(envelopeData(frozen.json));
      if (operation === "validate_sources") {
        const divergent = await call(
          `/api/v1/projects/${projectId}/jobs/${job.jobId}/evidence/freeze`,
          "POST",
          { manifest_hash: "f".repeat(64) },
          `freeze-divergent-${job.jobId}`,
        );
        expect(divergent.status).toBe(409);
        const audit = await harness.client.query(
          `SELECT event_type, payload FROM outbox_events
            WHERE project_id = $1 AND aggregate_type = 'tool_run'
              AND aggregate_id = $2 AND event_type = 'tool_run.evidence_rejected'`,
          [projectId, job.jobId],
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]?.payload).toMatchObject({
          jobId: job.jobId,
          projectId,
          reason: "EVIDENCE_MANIFEST_DIVERGED",
        });
      }
    }
    return jobs;
  }

  test("feature-off modern G4 never falls back to the legacy approval path", async () => {
    const projectId = `p4-off-${randomUUID()}`;
    await createModernProject(projectId);
    const request = new Request(
      `http://local/api/v1/projects/${projectId}/gate-submissions/missing/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.ids.humanToken}`,
          "content-type": "application/json",
          "idempotency-key": "feature-off-approve",
        },
        body: JSON.stringify({}),
      },
    );
    const response = await routeApi(
      request,
      harness.pool,
      connector,
      undefined,
      DISABLED_CORE_FEATURE_FLAGS,
      harness.ids.serviceUid,
    );
    expect(response.status).toBe(503);
    expect((await harness.client.query("SELECT count(*)::int AS count FROM approved_gate_result WHERE project_id=$1", [projectId])).rows[0].count).toBe(0);
  });

  test("P4 project ACL reflects roles, admin authority, and active Runtime binding without enumeration", async () => {
    const projectId = `p4-acl-${randomUUID()}`;
    await createModernProject(projectId);

    const hiddenWithoutRole = await callAs(
      harness.ids.serviceToken,
      `/api/v1/projects/${projectId}/process-state`,
    );
    expect(hiddenWithoutRole.status).toBe(404);
    expect((hiddenWithoutRole.json as any).error).toMatchObject({
      code: "not_found",
      message: `project not found: ${projectId}`,
    });

    const serviceRole = await call(`/api/v1/projects/${projectId}/role-assignments`, "POST", {
      id: `role-service-${projectId}`,
      actor_type: "service",
      actor_id: harness.ids.serviceUid,
      role: "engineer",
    });
    expect(serviceRole.status).toBe(201);
    expect((await callAs(
      harness.ids.serviceToken,
      `/api/v1/projects/${projectId}/process-state`,
    )).status).toBe(200);

    await harness.client.query(
      "DELETE FROM role_assignment WHERE project_id=$1 AND actor_type='service' AND actor_id=$2",
      [projectId, harness.ids.serviceUid],
    );
    expect((await callAs(
      harness.ids.serviceToken,
      `/api/v1/projects/${projectId}/process-state`,
    )).status).toBe(404);

    await harness.client.query(
      "DELETE FROM role_assignment WHERE project_id=$1 AND actor_type='human' AND actor_id=$2",
      [projectId, harness.ids.humanUid],
    );
    expect((await call(`/api/v1/projects/${projectId}/process-state`)).status).toBe(200);

    const exactFormalBody = {
      formal_input_approval_id: "missing-approval",
      operation: "implement",
      run_class_intent: "formal",
    };
    expect((await callAs(
      harness.ids.taskRuntimeToken,
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      exactFormalBody,
      "runtime-unbound-project",
    )).status).toBe(404);

    const process = await harness.client.query(
      "SELECT id FROM process_instance WHERE project_id=$1 ORDER BY created_at, id LIMIT 1",
      [projectId],
    );
    const processInstanceId = (process.rows[0] as { id: string }).id;
    await createMainTask(projectId, processInstanceId, "task-acl-runtime");
    const visibleThroughActiveBinding = await callAs(
      harness.ids.taskRuntimeToken,
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      exactFormalBody,
      "runtime-active-project",
    );
    // The coarse tenant boundary passed; the existing formal-approval binding
    // check remains authoritative and rejects the missing approval as conflict.
    expect(visibleThroughActiveBinding.status).toBe(409);
    expect((visibleThroughActiveBinding.json as any).error).toMatchObject({
      code: "conflict",
      message: "FORMAL_INPUT_APPROVAL_INACTIVE",
    });

    await harness.client.query(
      `UPDATE agent_task
          SET status='failed', finished_at=now(), updated_at=now()
        WHERE id='task-acl-runtime' AND project_id=$1`,
      [projectId],
    );
    expect((await callAs(
      harness.ids.taskRuntimeToken,
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      exactFormalBody,
      "runtime-terminal-project",
    )).status).toBe(404);
  });

  test("G0 readiness records every unavailable or untrustworthy discovery as an unconfirmable hard fail", async () => {
    const validCapabilities = ["validate_sources", "simulate", "synthesize", "implement"].map((operation) => ({
      operation,
      version: "p4-test.v1",
      runClasses: ["exploratory", "formal"],
    }));
    const cases: Array<{
      readonly label: string;
      readonly expectedStatus: string;
      readonly discovery: ConnectorDiscovery | Error | null;
    }> = [
      { label: "missing", expectedStatus: "missing", discovery: null },
      { label: "throws", expectedStatus: "failed", discovery: Object.assign(new Error("offline"), { code: "DISCOVERY_OFFLINE" }) },
      { label: "drift", expectedStatus: "drift", discovery: { drift: true, toolchainProfileHash: TOOLCHAIN_HASH, capabilities: validCapabilities } },
      { label: "empty", expectedStatus: "invalid_hash", discovery: { drift: false, toolchainProfileHash: "", capabilities: validCapabilities } },
      { label: "invalid", expectedStatus: "invalid_hash", discovery: { drift: false, toolchainProfileHash: "not-a-sha256", capabilities: validCapabilities } },
    ];

    for (const scenario of cases) {
      const tag = `${scenario.label}-${randomUUID()}`;
      const projectId = `p4-g0-tool-${tag}`;
      const revisionId = `rev-g0-tool-${tag}`;
      const readinessId = `ready-g0-tool-${tag}`;
      await createModernProject(projectId);
      const state = envelopeData((await call(`/api/v1/projects/${projectId}/process-state`)).json);
      await createRevision(
        projectId,
        revisionId,
        "XDC_CANDIDATE",
        "prj/constr/top.xdc",
        "set_property PACKAGE_PIN W5 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]\ncreate_clock -period 10 [get_ports clk]\n",
      );
      const body = await readinessBody(projectId, String(state.workVersionId), readinessId, {
        pin: { state: "complete", revisionIds: [revisionId] },
        electrical: { state: "complete", revisionIds: [revisionId] },
        clock: { state: "complete", revisionIds: [revisionId] },
      });

      let status: number;
      let json: unknown;
      if (scenario.discovery === null) {
        const response = await routeApi(
          new Request(`http://local/api/v1/projects/${projectId}/readiness`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${harness.ids.humanToken}`,
              "content-type": "application/json",
              "idempotency-key": `g0-tool-${tag}`,
            },
            body: JSON.stringify(body),
          }),
          harness.pool,
          undefined,
          undefined,
          { ...DISABLED_CORE_FEATURE_FLAGS, formalDelivery: true },
          harness.ids.serviceUid,
        );
        status = response.status;
        json = await response.json();
      } else {
        connector.discoveryOverride = scenario.discovery;
        const response = await call(
          `/api/v1/projects/${projectId}/readiness`,
          "POST",
          body,
          `g0-tool-${tag}`,
        );
        status = response.status;
        json = response.json;
      }

      expect(status).toBe(201);
      const readiness = envelopeData(json);
      expect(readiness).toMatchObject({ state: "blocked", ready: false, toolchain_profile_hash: null });
      expect(readiness.checks.find((check: any) => check.code === "toolchain.bound")).toMatchObject({
        severity: "hard",
        passed: false,
        details: { status: scenario.expectedStatus },
      });
      expect((await harness.client.query(
        "SELECT toolchain_profile_hash FROM project_readiness WHERE id=$1 AND project_id=$2",
        [readinessId, projectId],
      )).rows[0].toolchain_profile_hash).toBeNull();
      expect((await call(
        `/api/v1/projects/${projectId}/readiness/${readinessId}/confirm`,
        "POST",
        { reason: "must not confirm an unbound toolchain" },
      )).status).toBe(409);
      connector.discoveryOverride = undefined;
    }
  });

  test("G0 verifies complete XDC bytes and category facts while partial/missing stays honest", async () => {
    async function prepareScenario(input: {
      readonly label: string;
      readonly path: string;
      readonly content: string;
      readonly constraints: Record<string, unknown>;
      readonly corruptArchive?: boolean;
    }): Promise<{ projectId: string; readinessId: string; readiness: Record<string, any> }> {
      const tag = `${input.label}-${randomUUID()}`;
      const projectId = `p4-g0-xdc-${tag}`;
      const revisionId = `rev-g0-xdc-${tag}`;
      const readinessId = `ready-g0-xdc-${tag}`;
      await createModernProject(projectId);
      const state = envelopeData((await call(`/api/v1/projects/${projectId}/process-state`)).json);
      await createRevision(projectId, revisionId, "XDC_CANDIDATE", input.path, input.content);
      if (input.corruptArchive) {
        await harness.client.query(
          "UPDATE artifact_revision SET content = $1 WHERE id = $2 AND project_id = $3",
          [`${input.content}# changed after hash\n`, revisionId, projectId],
        );
      }
      const replaceId = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map((item) => item === "$REV" ? revisionId : replaceId(item));
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceId(item)]));
        }
        return value;
      };
      const body = await readinessBody(
        projectId,
        String(state.workVersionId),
        readinessId,
        replaceId(input.constraints) as Record<string, unknown>,
      );
      const response = await call(`/api/v1/projects/${projectId}/readiness`, "POST", body);
      expect(response.status).toBe(201);
      return { projectId, readinessId, readiness: envelopeData(response.json) };
    }

    const semantic = await prepareScenario({
      label: "semantic",
      path: "prj/constr/semantic.xdc",
      content: "create_clock -period 10 [get_ports clk]\n",
      constraints: {
        pin: { state: "complete", revisionIds: ["$REV"] },
        electrical: { state: "complete", revisionIds: ["$REV"] },
        clock: { state: "complete", revisionIds: ["$REV"] },
      },
    });
    expect(semantic.readiness).toMatchObject({
      state: "blocked",
      pin_constraints_complete: false,
      electrical_constraints_complete: false,
      clock_constraints_complete: true,
    });
    expect(semantic.readiness.checks.find((check: any) => check.code === "constraints.pin.complete")).toMatchObject({
      passed: false,
      details: { integrityPassed: true, semanticFactPresent: false },
    });
    expect(semantic.readiness.checks.find((check: any) => check.code === "constraints.clock.complete")).toMatchObject({ passed: true });

    const corrupt = await prepareScenario({
      label: "corrupt",
      path: "prj/constr/corrupt.xdc",
      content: "set_property PACKAGE_PIN W5 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]\ncreate_clock -period 10 [get_ports clk]\n",
      corruptArchive: true,
      constraints: {
        pin: { state: "complete", revisionIds: ["$REV"] },
        electrical: { state: "complete", revisionIds: ["$REV"] },
        clock: { state: "complete", revisionIds: ["$REV"] },
      },
    });
    expect(corrupt.readiness.state).toBe("blocked");
    expect(corrupt.readiness.checks.find((check: any) => check.code === "constraints.pin.complete")).toMatchObject({
      passed: false,
      details: { integrityPassed: false, issues: [{ issue: "CONTENT_HASH_MISMATCH" }] },
    });

    const certificate = await prepareScenario({
      label: "certificate",
      path: "prj/constr/signing.pem",
      content: "-----BEGIN CERTIFICATE-----\nnot-allowed\n-----END CERTIFICATE-----\nset_property PACKAGE_PIN W5 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]\ncreate_clock -period 10 [get_ports clk]\n",
      constraints: {
        pin: { state: "complete", revisionIds: ["$REV"] },
        electrical: { state: "complete", revisionIds: ["$REV"] },
        clock: { state: "complete", revisionIds: ["$REV"] },
      },
    });
    expect(certificate.readiness.state).toBe("blocked");
    expect(certificate.readiness.checks.find((check: any) => check.code === "constraints.pin.complete")).toMatchObject({
      passed: false,
      details: { issues: [{ issue: "FORBIDDEN_OR_INVALID_CONTENT" }] },
    });

    const partial = await prepareScenario({
      label: "partial",
      path: "prj/constr/partial.xdc",
      content: "# constraints are intentionally incomplete\n",
      constraints: {
        pin: { state: "partial", revisionIds: ["$REV"] },
        electrical: { state: "missing", revisionIds: [] },
        clock: { state: "missing", revisionIds: [] },
      },
    });
    expect(partial.readiness).toMatchObject({
      state: "ready",
      constraints_complete: false,
      pin_constraints_complete: false,
      electrical_constraints_complete: false,
      clock_constraints_complete: false,
      toolchain_profile_hash: TOOLCHAIN_HASH,
    });
    expect(partial.readiness.checks.filter((check: any) => check.code.startsWith("constraints.")))
      .toEqual(expect.arrayContaining([expect.objectContaining({ passed: true })]));
    expect((await call(
      `/api/v1/projects/${partial.projectId}/readiness/${partial.readinessId}/confirm`,
      "POST",
      { reason: "partial constraints are honestly recorded at G0" },
    )).status).toBe(200);
  });

  test("readiness confirmation loses cleanly when a workspace writer holds the project lock first", async () => {
    const tag = randomUUID();
    const projectId = `p4-readiness-race-${tag}`;
    const revisionId = `rev-readiness-race-${tag}`;
    const readinessId = `ready-readiness-race-${tag}`;
    const confirmKey = `confirm-readiness-race-${tag}`;
    await createModernProject(projectId);
    const state = envelopeData((await call(`/api/v1/projects/${projectId}/process-state`)).json);
    await createRevision(
      projectId,
      revisionId,
      "XDC_CANDIDATE",
      "prj/constr/race.xdc",
      "# intentionally partial constraints\n",
    );
    const readiness = await call(
      `/api/v1/projects/${projectId}/readiness`,
      "POST",
      await readinessBody(projectId, String(state.workVersionId), readinessId, {
        pin: { state: "partial", revisionIds: [revisionId] },
        electrical: { state: "missing", revisionIds: [] },
        clock: { state: "missing", revisionIds: [] },
      }),
    );
    expect(readiness.status).toBe(201);
    expect(envelopeData(readiness.json).state).toBe("ready");

    const writerHasLock = deferred();
    const releaseWriter = deferred();
    const confirmReachedLock = deferred();
    const removeWriterHook = installP4ProjectMutationLockTestHook(
      projectId,
      "workspace.put",
      "afterAcquire",
      async () => {
        writerHasLock.resolve();
        await releaseWriter.promise;
      },
    );
    const removeConfirmHook = installP4ProjectMutationLockTestHook(
      projectId,
      "readiness.confirm",
      "beforeAcquire",
      () => confirmReachedLock.resolve(),
    );
    try {
      const writer = call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
        path: "doc/race-after-readiness.md",
        content: "workspace changed before confirmation\n",
      });
      await writerHasLock.promise;
      const confirmation = call(
        `/api/v1/projects/${projectId}/readiness/${readinessId}/confirm`,
        "POST",
        { reason: "must revalidate the frozen workspace" },
        confirmKey,
      );
      await confirmReachedLock.promise;
      releaseWriter.resolve();
      const [writerResponse, confirmResponse] = await Promise.all([writer, confirmation]);
      expect(writerResponse.status).toBe(200);
      expect(confirmResponse.status).toBe(409);
      expect((confirmResponse.json as any).error.details).toMatchObject({
        pending: ["doc/race-after-readiness.md"],
      });

      const replay = await call(
        `/api/v1/projects/${projectId}/readiness/${readinessId}/confirm`,
        "POST",
        { reason: "must revalidate the frozen workspace" },
        confirmKey,
      );
      expect(replay.status).toBe(409);
      const persisted = await harness.client.query(
        `SELECT confirmed_by, confirmed_at
           FROM project_readiness WHERE id = $1 AND project_id = $2`,
        [readinessId, projectId],
      );
      expect(persisted.rows[0]).toMatchObject({ confirmed_by: null, confirmed_at: null });
      expect(envelopeData((await call(`/api/v1/projects/${projectId}/process-state`)).json))
        .toMatchObject({ currentGate: "G0", completed: false });
      expect((await harness.client.query(
        `SELECT count(*)::int AS count FROM outbox_events
          WHERE project_id = $1 AND event_type = 'project.readiness_confirmed'`,
        [projectId],
      )).rows[0].count).toBe(0);
      expect((await harness.client.query(
        `SELECT count(*)::int AS count FROM idempotency_records
          WHERE project_id = $1 AND operation = 'confirm_p4_readiness'
            AND idempotency_key = $2`,
        [projectId, confirmKey],
      )).rows[0].count).toBe(0);
    } finally {
      releaseWriter.resolve();
      removeWriterHook();
      removeConfirmHook();
    }
  });

  test("G0→G4 seals immutable releases, survives concurrent approval, and supersedes through change control", async () => {
    const projectId = `p4-${randomUUID()}`;
    const processInstanceId = `pi_${projectId}_G0`;
    const revisions = {
      source: "rev-source-package",
      requirements: "rev-requirements",
      behavior: "rev-behavior",
      architecture: "rev-architecture",
      detail: "rev-detail",
      constraintDesign: "rev-constraint-design",
      rtl: "rev-rtl",
      tb: "rev-tb",
      xdc: "rev-xdc",
    };
    const traces = {
      g1: "trace-g1-evidence",
      g2: "trace-g2-evidence",
      g3: "trace-g3-evidence",
    };
    await createModernProject(projectId);
    const initialProcessState = await call(`/api/v1/projects/${projectId}/process-state`);
    expect(initialProcessState.status).toBe(200);
    const initialState = envelopeData(initialProcessState.json);
    const workVersionId = String(initialState.workVersionId);
    expect(workVersionId).toMatch(/^wv_[0-9a-f]{40}$/);
    expect(initialState).toMatchObject({
      schema: "process-state.v1",
      projectId,
      processInstanceId,
      workVersionId,
      currentGate: "G0",
      completed: false,
    });
    await createRevision(projectId, revisions.source, "SOURCE_PACKAGE", "doc/source-package.txt", "PWM source requirement package v1\n");
    await createRevision(projectId, revisions.requirements, "DEVELOPMENT_REQUIREMENTS", "doc/requirements.json", g1GateEvidence({ sourceRevisionId: revisions.source, traceRelationId: traces.g1 }));
    await createRevision(projectId, revisions.behavior, "PLDS_SRS", "doc/behavior.json", g2GateEvidence({ traceRelationId: traces.g2 }));
    await createRevision(projectId, revisions.architecture, "ARCHITECTURE_DESIGN", "doc/architecture.json", g3GateEvidence({ traceRelationId: traces.g3 }));
    await createRevision(projectId, revisions.detail, "DETAILED_DESIGN", "doc/detail.md", "# Detailed design\n");
    await createRevision(projectId, revisions.constraintDesign, "CONSTRAINT_DESIGN", "doc/constraints.md", "# Constraint strategy\n");
    await createRevision(projectId, revisions.rtl, "RTL_SOURCE_SET", "rtl/top.sv", "module top(input logic clk); endmodule\n");
    await createRevision(projectId, revisions.tb, "TB_SOURCE_SET", "tb/top_tb.sv", "module top_tb; endmodule\n");
    await createRevision(projectId, revisions.xdc, "XDC_CANDIDATE", "prj/constr/top.xdc", "set_property PACKAGE_PIN W5 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]\ncreate_clock -name clk -period 10 [get_ports clk]\n");
    await createApprovedTrace(projectId, traces.g1, revisions.source, revisions.requirements);
    await createApprovedTrace(projectId, traces.g2, revisions.requirements, revisions.behavior);
    await createApprovedTrace(projectId, traces.g3, revisions.requirements, revisions.architecture);
    const mutationMarkerPath = "doc/project-mutation-marker.md";
    const mutationMarkerOriginal = "project mutation marker v1\n";
    const mutationMarkerChanged = "project mutation marker v2\n";
    const markerWrite = await call(`/api/v1/projects/${projectId}/workspace/files`, "POST", {
      files: [{ path: mutationMarkerPath, content: mutationMarkerOriginal }],
      change_reason: "seed deterministic P4 mutation races",
    }, "seed-project-mutation-marker");
    expect(markerWrite.status).toBe(200);

    const profileResponse = await call("/api/v1/process-versions/GJB_REF_V1/profile");
    expect(profileResponse.status).toBe(200);
    const profile = envelopeData(profileResponse.json);
    const readiness = await prepareReadiness(projectId, workVersionId, "ready-p4-1", revisions.xdc);
    expect(readiness.ready).toBe(true);

    const g1 = await createSnapshot(projectId, workVersionId, "snap-g1", [revisions.source, revisions.requirements], profile.profileHash, [traces.g1]);
    await passGate({ projectId, workVersionId, processInstanceId, gate: "G1", snapshotId: "snap-g1", snapshotHash: g1.manifestHash, baselineId: "bl-b0-1" });
    const g2 = await createSnapshot(projectId, workVersionId, "snap-g2", [revisions.behavior], profile.profileHash, [traces.g2]);
    await passGate({ projectId, workVersionId, processInstanceId, gate: "G2", snapshotId: "snap-g2", snapshotHash: g2.manifestHash, baselineId: null });
    const g3 = await createSnapshot(projectId, workVersionId, "snap-g3", [revisions.architecture, revisions.detail, revisions.constraintDesign], profile.profileHash, [traces.g3]);
    await passGate({ projectId, workVersionId, processInstanceId, gate: "G3", snapshotId: "snap-g3", snapshotHash: g3.manifestHash, baselineId: "bl-b1-1" });

    const g4 = await createSnapshot(projectId, workVersionId, "snap-g4", [revisions.rtl, revisions.tb, revisions.xdc], profile.profileHash);
    await createMainTask(projectId, processInstanceId, "task-main-p4");
    const previewResponse = await call(`/api/v1/projects/${projectId}/formal-input-approvals/preview`, "POST", {
      work_version_id: workVersionId,
      snapshot_id: "snap-g4",
      readiness_id: "ready-p4-1",
      authorized_task_id: "task-main-p4",
    });
    if (previewResponse.status !== 200) throw new Error(`preview: ${JSON.stringify(previewResponse.json)}`);
    const preview = envelopeData(previewResponse.json);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM formal_input_content WHERE project_id=$1",
      [projectId],
    )).rows[0].count).toBe(0);
    const approvalResponse = await call(`/api/v1/projects/${projectId}/formal-input-approvals`, "POST", {
      id: "fia-p4-1",
      work_version_id: workVersionId,
      snapshot_id: "snap-g4",
      readiness_id: "ready-p4-1",
      authorized_task_id: "task-main-p4",
      purpose: "g4_delivery",
      preview_hash: preview.preview_hash,
    }, "confirm-fia-p4-1");
    if (approvalResponse.status !== 201) throw new Error(`formal approval: ${JSON.stringify(approvalResponse.json)}`);
    const replayedApprovalResponse = await call(`/api/v1/projects/${projectId}/formal-input-approvals`, "POST", {
      id: "fia-p4-1",
      work_version_id: workVersionId,
      snapshot_id: "snap-g4",
      readiness_id: "ready-p4-1",
      authorized_task_id: "task-main-p4",
      purpose: "g4_delivery",
      preview_hash: preview.preview_hash,
    }, "confirm-fia-p4-1");
    expect(replayedApprovalResponse.status).toBe(201);
    expect(envelopeData(replayedApprovalResponse.json)).toEqual(envelopeData(approvalResponse.json));
    const managedInputRows = await harness.client.query(
      `SELECT sha256, size_bytes,
              encode(digest(managed_content, 'sha256'), 'hex') AS actual_sha256
         FROM formal_input_content WHERE project_id=$1 ORDER BY sha256`,
      [projectId],
    );
    expect(managedInputRows.rows).toHaveLength(preview.files.length);
    expect(managedInputRows.rows.every((row) => (
      row.sha256 === row.actual_sha256 && Number(row.size_bytes) > 0
    ))).toBe(true);

    // The approval owns immutable bytes. Corrupting the mutable source row
    // after confirmation must not alter Connector parameters or downloads.
    const tamperedRtl = "module tampered; endmodule\n";
    await harness.client.query(
      `UPDATE artifact_revision SET content=$1, content_hash=$2
        WHERE id=$3 AND project_id=$4`,
      [tamperedRtl, sha256Hex(tamperedRtl), revisions.rtl, projectId],
    );

    const firstFormalBody = {
      operation: "validate_sources",
      run_class_intent: "formal",
      formal_input_approval_id: "fia-p4-1",
    };
    const genericService = await callAs(
      harness.ids.genericServiceToken,
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      firstFormalBody,
      "generic-service-formal",
    );
    expect(genericService.status).toBe(403);
    const otherRuntime = await callAs(
      harness.ids.secondServiceToken,
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      firstFormalBody,
      "other-runtime-formal",
    );
    expect(otherRuntime.status).toBe(404);
    expect((otherRuntime.json as any).error).toMatchObject({
      code: "not_found",
      message: `project not found: ${projectId}`,
    });
    const boundRuntime = await callAs(
      harness.ids.taskRuntimeToken,
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      firstFormalBody,
      "bound-runtime-formal",
      "task-main-p4",
    );
    expect(boundRuntime.status).toBe(201);
    const boundJob = envelopeData(boundRuntime.json);
    expect(boundJob.formalInputApprovalId).toBe("fia-p4-1");
    expect(boundJob.runClass).toBe("formal");
    expect(connector.submitCalls).toBe(1);
    const submittedBinding = connector.submissions.get(String(boundJob.jobId));
    expect(submittedBinding?.parameters.sources.some((source) => (
      source.path === "rtl/top.sv" && source.content === "module top(input logic clk); endmodule\n"
    ))).toBe(true);
    expect(submittedBinding?.parameters.sources.some((source) => source.content === tamperedRtl)).toBe(false);
    const persistedBeforeDisabledRead = (await harness.client.query(
      `SELECT state::text,error_code,output_sha256,end_time,xmin::text AS row_version
         FROM tool_run WHERE id=$1 AND project_id=$2`,
      [boundJob.jobId, projectId],
    )).rows[0];
    const statusCallsBeforeDisabledRead = connector.queryStatusCalls;
    const disabledRead = await routeApi(
      new Request(`http://local/api/v1/projects/${projectId}/jobs/${boundJob.jobId}`, {
        headers: { authorization: `Bearer ${harness.ids.humanToken}` },
      }),
      harness.pool,
      connector,
      undefined,
      DISABLED_CORE_FEATURE_FLAGS,
      harness.ids.serviceUid,
    );
    expect(disabledRead.status).toBe(200);
    expect(envelopeData(await disabledRead.json()).state).toBe("submitted");
    expect(connector.queryStatusCalls).toBe(statusCallsBeforeDisabledRead);
    expect((await harness.client.query(
      `SELECT state::text,error_code,output_sha256,end_time,xmin::text AS row_version
         FROM tool_run WHERE id=$1 AND project_id=$2`,
      [boundJob.jobId, projectId],
    )).rows[0]).toEqual(persistedBeforeDisabledRead);
    const attachedByHuman = await call(
      `/api/v1/projects/${projectId}/jobs`,
      "POST",
      firstFormalBody,
      "human-attach-formal",
    );
    expect(attachedByHuman.status).toBe(201);
    expect(envelopeData(attachedByHuman.json).jobId).toBe(boundJob.jobId);
    expect(connector.submitCalls).toBe(1);
    const formalJobs = await runFormalJobs(projectId, "fia-p4-1");

    // Writer-first evaluation: the writer owns the common lock, leaves a
    // dirty workspace, and the waiting G4 evaluation records a hard failure
    // instead of sealing a candidate from mixed facts.
    const raceEvaluationSubmissionId = "sub-g4-writer-first-eval";
    const raceEvaluationId = "eval-g4-writer-first";
    expect((await call(`/api/v1/projects/${projectId}/gate-submissions`, "POST", {
      id: raceEvaluationSubmissionId,
      process_instance_id: processInstanceId,
      work_version_id: workVersionId,
      gate: "G4",
      snapshot_id: "snap-g4",
    })).status).toBe(201);
    const evaluationWriterHasLock = deferred();
    const releaseEvaluationWriter = deferred();
    const evaluationReachedLock = deferred();
    installP4ProjectMutationLockTestHook(
      projectId,
      "workspace.put",
      "afterAcquire",
      async () => {
        evaluationWriterHasLock.resolve();
        await releaseEvaluationWriter.promise;
      },
    );
    installP4ProjectMutationLockTestHook(
      projectId,
      "g4.evaluate",
      "beforeAcquire",
      () => evaluationReachedLock.resolve(),
    );
    const writerFirstEvaluationWrite = call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
      path: mutationMarkerPath,
      content: mutationMarkerChanged,
    });
    await evaluationWriterHasLock.promise;
    const writerFirstEvaluation = call(
      `/api/v1/projects/${projectId}/gate-submissions/${raceEvaluationSubmissionId}/evaluations`,
      "POST",
      {
        evaluation_id: raceEvaluationId,
        work_version_id: workVersionId,
        expected_snapshot_manifest_hash: g4.manifestHash,
      },
      "writer-first-g4-evaluation",
    );
    await evaluationReachedLock.promise;
    releaseEvaluationWriter.resolve();
    const [writerFirstEvaluationWriteResponse, writerFirstEvaluationResponse] = await Promise.all([
      writerFirstEvaluationWrite,
      writerFirstEvaluation,
    ]);
    expect(writerFirstEvaluationWriteResponse.status).toBe(200);
    expect(writerFirstEvaluationResponse.status).toBe(201);
    const rejectedEvaluation = envelopeData(writerFirstEvaluationResponse.json);
    expect(rejectedEvaluation).toMatchObject({
      passed: false,
      sealed_projection_hash: null,
    });
    expect(rejectedEvaluation.items.find((item: any) => (
      item.check_code === "delivery.manifest_sealed"
    ))).toMatchObject({
      passed: false,
      details: { workspace: { pending: [mutationMarkerPath] } },
    });
    expect(envelopeData((await call(
      `/api/v1/projects/${projectId}/gate-submissions/${raceEvaluationSubmissionId}`,
    )).json).state).toBe("rejected");
    expect((await call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
      path: mutationMarkerPath,
      content: mutationMarkerOriginal,
    })).status).toBe(200);
    expect(envelopeData((await call(
      `/api/v1/projects/${projectId}/workspace/tree`,
    )).json).pending_count).toBe(0);

    const submissionId = "sub-g4-wv1";
    const evaluationId = "eval-g4-wv1";
    expect((await harness.client.query("SELECT count(*)::int AS count FROM delivery_release WHERE project_id=$1", [projectId])).rows[0].count).toBe(0);
    const submission = await call(`/api/v1/projects/${projectId}/gate-submissions`, "POST", {
      id: submissionId,
      process_instance_id: processInstanceId,
      work_version_id: workVersionId,
      gate: "G4",
      snapshot_id: "snap-g4",
    });
    if (submission.status !== 201) throw new Error(`G4 submission: ${JSON.stringify(submission.json)}`);
    const submissionListResponse = await call(`/api/v1/projects/${projectId}/gate-submissions`);
    expect(submissionListResponse.status).toBe(200);
    const submissionList = (submissionListResponse.json as { data: Record<string, unknown>[] }).data;
    const listedSubmission = submissionList.find((candidate) => candidate.id === submissionId);
    expect(listedSubmission?.work_version_id).toBe(workVersionId);
    const submissionDetailResponse = await call(`/api/v1/projects/${projectId}/gate-submissions/${submissionId}`);
    expect(submissionDetailResponse.status).toBe(200);
    expect(envelopeData(submissionDetailResponse.json).work_version_id).toBe(workVersionId);
    // Evaluation-first: a waiting writer cannot alter the facts being sealed.
    // Once evaluation commits, the writer may proceed; submit must then reject
    // the now-stale projection until the worktree is restored.
    const evaluationHasLock = deferred();
    const releaseEvaluation = deferred();
    const postEvaluationWriterReachedLock = deferred();
    installP4ProjectMutationLockTestHook(
      projectId,
      "g4.evaluate",
      "afterAcquire",
      async () => {
        evaluationHasLock.resolve();
        await releaseEvaluation.promise;
      },
    );
    installP4ProjectMutationLockTestHook(
      projectId,
      "workspace.put",
      "beforeAcquire",
      () => postEvaluationWriterReachedLock.resolve(),
    );
    const evaluationRequest = call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/evaluations`,
      "POST",
      {
        evaluation_id: evaluationId,
        work_version_id: workVersionId,
        expected_snapshot_manifest_hash: g4.manifestHash,
      },
      "evaluation-first-g4",
    );
    await evaluationHasLock.promise;
    const postEvaluationWriter = call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
      path: mutationMarkerPath,
      content: mutationMarkerChanged,
    });
    await postEvaluationWriterReachedLock.promise;
    releaseEvaluation.resolve();
    const [evaluationResponse, postEvaluationWriterResponse] = await Promise.all([
      evaluationRequest,
      postEvaluationWriter,
    ]);
    expect(postEvaluationWriterResponse.status).toBe(200);
    if (evaluationResponse.status !== 201) throw new Error(`G4 evaluation: ${JSON.stringify(evaluationResponse.json)}`);
    const evaluation = envelopeData(evaluationResponse.json);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.work_version_id).toBe(workVersionId);
    expect(evaluation.snapshot_manifest_hash).toBe(g4.manifestHash);
    expect(evaluation.delivery_release_id).toBeString();
    expect(evaluation.delivery_release_version).toBe(1);
    expect(evaluation.supersedes_release_id).toBeNull();
    expect((await harness.client.query("SELECT count(*)::int AS count FROM delivery_release WHERE project_id=$1", [projectId])).rows[0].count).toBe(0);
    const staleSubmit = await call(`/api/v1/projects/${projectId}/gate-submissions/${submissionId}/submit`, "POST", {
      gate_check_evaluation_id: evaluationId,
      check_results_hash: evaluation.result_hash,
    }, "submit-stale-after-writer");
    expect(staleSubmit.status).toBe(409);
    expect((staleSubmit.json as any).error).toMatchObject({
      code: "conflict",
      message: "G4_SEALED_PROJECTION_CHANGED",
    });
    expect((await harness.client.query(
      `SELECT count(*)::int AS count FROM idempotency_records
        WHERE project_id = $1 AND operation = 'submit_p4_gate_submission'
          AND idempotency_key = 'submit-stale-after-writer'`,
      [projectId],
    )).rows[0].count).toBe(0);
    expect((await call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
      path: mutationMarkerPath,
      content: mutationMarkerOriginal,
    })).status).toBe(200);

    // Submit-first: the transition and its revalidation are atomic with
    // respect to the writer. The writer lands only afterwards, so approval
    // must catch the resulting drift before release.
    const submitHasLock = deferred();
    const releaseSubmit = deferred();
    const postSubmitWriterReachedLock = deferred();
    installP4ProjectMutationLockTestHook(
      projectId,
      "g4.submit",
      "afterAcquire",
      async () => {
        submitHasLock.resolve();
        await releaseSubmit.promise;
      },
    );
    installP4ProjectMutationLockTestHook(
      projectId,
      "workspace.put",
      "beforeAcquire",
      () => postSubmitWriterReachedLock.resolve(),
    );
    const submitRequest = call(`/api/v1/projects/${projectId}/gate-submissions/${submissionId}/submit`, "POST", {
      gate_check_evaluation_id: evaluationId,
      check_results_hash: evaluation.result_hash,
    }, "submit-first-g4");
    await submitHasLock.promise;
    const postSubmitWriter = call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
      path: mutationMarkerPath,
      content: mutationMarkerChanged,
    });
    await postSubmitWriterReachedLock.promise;
    releaseSubmit.resolve();
    const [submitted, postSubmitWriterResponse] = await Promise.all([
      submitRequest,
      postSubmitWriter,
    ]);
    expect(postSubmitWriterResponse.status).toBe(200);
    expect(submitted.status).toBe(200);
    expect((await harness.client.query("SELECT count(*)::int AS count FROM delivery_release WHERE project_id=$1", [projectId])).rows[0].count).toBe(0);
    const g4ApprovalBody = {
      configuration_snapshot_id: "snap-g4",
      approved_gate_result_id: "agr-g4-wv1",
      approver_role: "quality",
      check_results_hash: evaluation.result_hash,
      signed_at: new Date().toISOString(),
      signature_method: "platform_token",
      authorization_basis: "P4 fixture role",
      reason: "formal delivery accepted",
      issues: [],
      risks: [],
      waivers: [],
      baseline_id: "bl-b2-1",
      gate_check_evaluation_id: evaluationId,
      candidate_manifest_hash: evaluation.sealed_projection_hash,
      delivery_release_id: evaluation.delivery_release_id,
    };
    const staleApproval = await call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/approve`,
      "POST",
      g4ApprovalBody,
      "approve-writer-first-stale",
    );
    expect(staleApproval.status).toBe(409);
    expect((staleApproval.json as any).error).toMatchObject({
      code: "conflict",
      message: "G4_SEALED_PROJECTION_CHANGED",
    });
    expect((await harness.client.query(
      `SELECT
         (SELECT count(*)::int FROM approval_record WHERE project_id = $1
           AND gate_submission_id = $2) AS approvals,
         (SELECT count(*)::int FROM baseline WHERE project_id = $1
           AND kind = 'B2') AS b2,
         (SELECT count(*)::int FROM delivery_release WHERE project_id = $1) AS releases,
         (SELECT count(*)::int FROM idempotency_records WHERE project_id = $1
           AND operation = 'approve_p4_gate'
           AND idempotency_key = 'approve-writer-first-stale') AS idempotency`,
      [projectId, submissionId],
    )).rows[0]).toMatchObject({ approvals: 0, b2: 0, releases: 0, idempotency: 0 });
    expect((await call(`/api/v1/projects/${projectId}/workspace/file`, "PUT", {
      path: mutationMarkerPath,
      content: mutationMarkerOriginal,
    })).status).toBe(200);
    expect(envelopeData((await call(
      `/api/v1/projects/${projectId}/workspace/tree`,
    )).json).pending_count).toBe(0);
    const workspaceBeforeRelease = envelopeData((await call(
      `/api/v1/projects/${projectId}/workspace/tree`,
    )).json);
    const approvalHasLock = deferred();
    const releaseApproval = deferred();
    const writerReachedLock = deferred();
    const removeApprovalHook = installP4ProjectMutationLockTestHook(
      projectId,
      "g4.approve",
      "afterAcquire",
      async () => {
        approvalHasLock.resolve();
        await releaseApproval.promise;
      },
    );
    const removeWriterHook = installP4ProjectMutationLockTestHook(
      projectId,
      "workspace.files",
      "beforeAcquire",
      () => writerReachedLock.resolve(),
    );
    const firstApproval = call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/approve`,
      "POST",
      g4ApprovalBody,
      "approve-g4-wv1-a",
    );
    await approvalHasLock.promise;
    const losingWriter = call(
      `/api/v1/projects/${projectId}/workspace/files`,
      "POST",
      {
        files: [{
          path: "rtl/must-not-land-after-release.sv",
          content: "module must_not_land; endmodule\n",
        }],
        change_reason: "concurrent release loser",
      },
      "workspace-loses-to-release",
    );
    await writerReachedLock.promise;
    const secondApproval = call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/approve`,
      "POST",
      g4ApprovalBody,
      "approve-g4-wv1-b",
    );
    releaseApproval.resolve();
    const [firstApprovalResponse, secondApprovalResponse, writerResponse] = await Promise.all([
      firstApproval,
      secondApproval,
      losingWriter,
    ]);
    removeApprovalHook();
    removeWriterHook();
    const concurrentApprovals = [firstApprovalResponse, secondApprovalResponse];
    expect(writerResponse.status).toBe(409);
    expect((writerResponse.json as any).error.details).toMatchObject({
      currentDeliveryReleaseId: evaluation.delivery_release_id,
    });
    const workspaceAfterRelease = envelopeData((await call(
      `/api/v1/projects/${projectId}/workspace/tree`,
    )).json);
    expect(workspaceAfterRelease).toEqual(workspaceBeforeRelease);
    expect((await harness.client.query(
      `SELECT count(*)::int AS count FROM artifact_revision ar
        JOIN artifact a ON a.id = ar.artifact_id AND a.project_id = ar.project_id
       WHERE ar.project_id = $1 AND a.title = 'rtl/must-not-land-after-release.sv'`,
      [projectId],
    )).rows[0].count).toBe(0);
    expect((await harness.client.query(
      `SELECT count(*)::int AS count FROM idempotency_records
        WHERE project_id = $1 AND operation = 'write_workspace_files'
          AND idempotency_key = 'workspace-loses-to-release'`,
      [projectId],
    )).rows[0].count).toBe(0);
    expect(concurrentApprovals.map((response) => response.status).sort()).toEqual([200, 409]);
    const winningApprovalIndex = concurrentApprovals.findIndex((response) => response.status === 200);
    const approved = concurrentApprovals[winningApprovalIndex]!;
    const winningApprovalKey = winningApprovalIndex === 0
      ? "approve-g4-wv1-a"
      : "approve-g4-wv1-b";

    const replayedApproval = await call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/approve`,
      "POST",
      g4ApprovalBody,
      winningApprovalKey,
    );
    expect(replayedApproval.status).toBe(200);
    expect(envelopeData(replayedApproval.json)).toEqual(envelopeData(approved.json));
    const divergentReplay = await call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionId}/approve`,
      "POST",
      { ...g4ApprovalBody, reason: "different approval facts" },
      winningApprovalKey,
    );
    expect(divergentReplay.status).toBe(409);
    const releasedProcessState = await call(`/api/v1/projects/${projectId}/process-state`);
    expect(envelopeData(releasedProcessState.json)).toMatchObject({
      processInstanceId,
      workVersionId,
      currentGate: "G4",
      completed: true,
    });

    const releaseRows = await harness.client.query(
      "SELECT id, state, item_count, manifest, manifest_hash FROM delivery_release WHERE project_id=$1",
      [projectId],
    );
    expect(releaseRows.rows).toHaveLength(1);
    expect(releaseRows.rows[0].id).toBe(evaluation.delivery_release_id);
    expect(releaseRows.rows[0].state).toBe("sealed");
    const itemRows = await harness.client.query(
      "SELECT category, path, storage_uri, provenance FROM delivery_release_item WHERE project_id=$1 AND release_id=$2 ORDER BY category,path",
      [projectId, evaluation.delivery_release_id],
    );
    expect(itemRows.rows.length).toBe(releaseRows.rows[0].item_count);
    expect((releaseRows.rows[0].manifest as { items: unknown[] }).items).toHaveLength(itemRows.rows.length);
    expect(new Set(itemRows.rows.map((row) => row.category))).toEqual(new Set([
      "rtl", "tb", "constraint", "document", "run_result", "raw_evidence", "confirmation", "source", "bitstream",
    ]));
    expect(itemRows.rows.filter((row) => row.path === "confirmations/gate-approval.json")).toHaveLength(1);
    expect(itemRows.rows.every((row) => typeof row.storage_uri === "string" && row.provenance !== null)).toBe(true);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM baseline WHERE project_id=$1 AND kind='B2'",
      [projectId],
    )).rows[0].count).toBe(1);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE project_id=$1 AND aggregate_id=$2 AND event_type='delivery.release_sealed'",
      [projectId, evaluation.delivery_release_id],
    )).rows[0].count).toBe(1);

    const immutableChecks = [
      () => harness.client.query("UPDATE delivery_release SET generated_by='tampered' WHERE id=$1", [evaluation.delivery_release_id]),
      () => harness.client.query("DELETE FROM delivery_release WHERE id=$1", [evaluation.delivery_release_id]),
      () => harness.client.query("UPDATE delivery_release_item SET path='tampered' WHERE release_id=$1", [evaluation.delivery_release_id]),
      () => harness.client.query("DELETE FROM delivery_release_item WHERE release_id=$1", [evaluation.delivery_release_id]),
      () => harness.client.query(
        `INSERT INTO delivery_release_item
          (id,project_id,release_id,category,path,source_type,source_id,sha256,size_bytes,media_type,storage_uri,provenance)
         VALUES ('late-item',$1,$2,'document','doc/late.txt','artifact_revision',$3,$4,0,'text/plain','data:text/plain;base64,','{}')`,
        [projectId, evaluation.delivery_release_id, revisions.detail, sha256Hex("")],
      ),
    ];
    for (const check of immutableChecks) await expect(check()).rejects.toThrow();

    const manifestResponse = await call(`/api/v1/projects/${projectId}/delivery-releases/${evaluation.delivery_release_id}/manifest`);
    expect(manifestResponse.status).toBe(200);
    const manifest = envelopeData(manifestResponse.json);
    expect(manifest.items.every((item: Record<string, unknown>) => typeof item.storage_uri === "string" && item.provenance !== undefined)).toBe(true);
    const contentResponse = await call(
      `/api/v1/projects/${projectId}/delivery-releases/${evaluation.delivery_release_id}/content?path=${encodeURIComponent("bitstream/formal-synthia.bit")}`,
    );
    expect(contentResponse.status).toBe(200);
    expect(envelopeData(contentResponse.json).encoding).toBe("base64");

    expect(connector.submitCalls).toBe(4);
    const cachedFreezeAfterRelease = await call(
      `/api/v1/projects/${projectId}/jobs/${formalJobs.implement}/evidence/freeze`,
      "POST",
      {},
      `freeze-${formalJobs.implement}`,
    );
    expect(cachedFreezeAfterRelease.status).toBe(409);
    const cachedAfterRelease = await call(`/api/v1/projects/${projectId}/jobs`, "POST", {
      operation: "implement",
      run_class_intent: "formal",
      formal_input_approval_id: "fia-p4-1",
    }, "formal-fia-p4-1-implement");
    expect(cachedAfterRelease.status).toBe(409);
    const attached = await call(`/api/v1/projects/${projectId}/jobs`, "POST", {
      operation: "implement",
      run_class_intent: "formal",
      formal_input_approval_id: "fia-p4-1",
    }, "another-http-key");
    expect(attached.status).toBe(409);
    // The work version is released, so dynamic authorization correctly rejects
    // a new HTTP scope instead of leaking a cached success; no second execution
    // can be created regardless.
    expect(connector.submitCalls).toBe(4);

    const blockedRevision = await call(
      `/api/v1/projects/${projectId}/artifacts/art-post-release/revisions`,
      "POST",
      {
        id: "rev-post-release-blocked",
        artifact_type: "RTL_SOURCE_SET",
        title: "rtl/post-release.sv",
        content: "module post_release; endmodule\n",
        content_location: "rtl/post-release.sv",
      },
      "post-release-revision-blocked",
    );
    expect(blockedRevision.status).toBe(409);
    const blockedWorkspaceWrite = await call(
      `/api/v1/projects/${projectId}/workspace/file`,
      "PUT",
      { path: "rtl/blocked-after-release.sv", content: "module blocked; endmodule\n" },
      "post-release-workspace-blocked",
    );
    expect(blockedWorkspaceWrite.status).toBe(409);
    const absentBlockedFile = await call(
      `/api/v1/projects/${projectId}/workspace/file?path=${encodeURIComponent("rtl/blocked-after-release.sv")}`,
    );
    expect(absentBlockedFile.status).toBe(404);

    const changeBody = {
      id: "cr-p4-2",
      work_version_id: "wv-p4-2",
      base_delivery_release_id: evaluation.delivery_release_id,
      reason: "Revise the released top-level RTL",
      affected_paths: ["rtl/top.sv"],
      impact_gate: "G2",
    };
    const change = await call(
      `/api/v1/projects/${projectId}/change-requests`,
      "POST",
      changeBody,
      "create-cr-p4-2",
    );
    if (change.status !== 201) throw new Error(`create change request: ${JSON.stringify(change.json)}`);
    expect(envelopeData(change.json)).toMatchObject({
      id: "cr-p4-2",
      project_work_version_id: "wv-p4-2",
      base_delivery_release_id: evaluation.delivery_release_id,
      impact_gate: "G2",
      state: "open",
    });
    const replayedChange = await call(
      `/api/v1/projects/${projectId}/change-requests`,
      "POST",
      changeBody,
      "create-cr-p4-2",
    );
    expect(replayedChange.status).toBe(201);
    expect(envelopeData(replayedChange.json)).toEqual(envelopeData(change.json));

    const workVersion = await call(`/api/v1/projects/${projectId}/work-versions/wv-p4-2`);
    expect(workVersion.status).toBe(200);
    expect(envelopeData(workVersion.json)).toMatchObject({
      id: "wv-p4-2",
      version: 2,
      origin: "change_request",
      change_request_id: "cr-p4-2",
      base_delivery_release_id: evaluation.delivery_release_id,
      start_gate: "G2",
      current_gate: "G2",
      state: "working",
    });
    const changedProcessState = await call(`/api/v1/projects/${projectId}/process-state`);
    expect(envelopeData(changedProcessState.json)).toMatchObject({
      processInstanceId,
      workVersionId: "wv-p4-2",
      currentGate: "G2",
      completed: false,
    });
    const competingChange = await call(
      `/api/v1/projects/${projectId}/change-requests`,
      "POST",
      { ...changeBody, id: "cr-p4-competing", work_version_id: "wv-p4-competing" },
      "create-competing-cr",
    );
    expect(competingChange.status).toBe(409);

    const revisionsV2 = {
      behavior: "rev-behavior-v2",
      architecture: "rev-architecture-v2",
      detail: "rev-detail-v2",
      constraintDesign: "rev-constraint-design-v2",
      rtl: "rev-rtl-v2",
      tb: "rev-tb-v2",
      xdc: "rev-xdc-v2",
    };
    const tracesV2 = {
      g2: "trace-g2-evidence-v2",
      g3: "trace-g3-evidence-v2",
    };
    await createRevision(projectId, revisionsV2.behavior, "PLDS_SRS", "doc/behavior-v2.json", g2GateEvidence({ traceRelationId: tracesV2.g2 }));
    await createRevision(projectId, revisionsV2.architecture, "ARCHITECTURE_DESIGN", "doc/architecture-v2.json", g3GateEvidence({ traceRelationId: tracesV2.g3 }));
    await createRevision(projectId, revisionsV2.detail, "DETAILED_DESIGN", "doc/detail-v2.md", "# Detailed design v2\n");
    await createRevision(projectId, revisionsV2.constraintDesign, "CONSTRAINT_DESIGN", "doc/constraints-v2.md", "# Constraint strategy v2\n");
    await createRevision(projectId, revisionsV2.rtl, "RTL_SOURCE_SET", "rtl/top.sv", "module top(input logic clk); logic revised; endmodule\n");
    await createRevision(projectId, revisionsV2.tb, "TB_SOURCE_SET", "tb/top_tb.sv", "module top_tb; // v2 verification\nendmodule\n");
    await createRevision(projectId, revisionsV2.xdc, "XDC_CANDIDATE", "prj/constr/top.xdc", "set_property PACKAGE_PIN W5 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]\ncreate_clock -name clk -period 10 [get_ports clk]\n");
    await createApprovedTrace(projectId, tracesV2.g2, revisions.requirements, revisionsV2.behavior);
    await createApprovedTrace(projectId, tracesV2.g3, revisions.requirements, revisionsV2.architecture);

    const readinessV2 = await prepareReadiness(projectId, "wv-p4-2", "ready-p4-2", revisionsV2.xdc);
    expect(readinessV2).toMatchObject({ ready: true, work_version_id: "wv-p4-2" });
    const g2v2 = await createSnapshot(
      projectId,
      "wv-p4-2",
      "snap-g2-v2",
      [revisionsV2.behavior],
      profile.profileHash,
      [tracesV2.g2],
    );
    await passGate({
      projectId,
      workVersionId: "wv-p4-2",
      processInstanceId,
      gate: "G2",
      snapshotId: "snap-g2-v2",
      snapshotHash: g2v2.manifestHash,
      baselineId: null,
    });
    const g3v2 = await createSnapshot(
      projectId,
      "wv-p4-2",
      "snap-g3-v2",
      [revisionsV2.architecture, revisionsV2.detail, revisionsV2.constraintDesign],
      profile.profileHash,
      [tracesV2.g3],
    );
    await passGate({
      projectId,
      workVersionId: "wv-p4-2",
      processInstanceId,
      gate: "G3",
      snapshotId: "snap-g3-v2",
      snapshotHash: g3v2.manifestHash,
      baselineId: "bl-b1-2",
    });
    const g4v2 = await createSnapshot(
      projectId,
      "wv-p4-2",
      "snap-g4-v2",
      [revisionsV2.rtl, revisionsV2.tb, revisionsV2.xdc],
      profile.profileHash,
    );
    const previewV2Response = await call(
      `/api/v1/projects/${projectId}/formal-input-approvals/preview`,
      "POST",
      {
        work_version_id: "wv-p4-2",
        snapshot_id: "snap-g4-v2",
        readiness_id: "ready-p4-2",
        authorized_task_id: "task-main-p4",
      },
    );
    if (previewV2Response.status !== 200) {
      throw new Error(`preview v2: ${JSON.stringify(previewV2Response.json)}`);
    }
    const previewV2 = envelopeData(previewV2Response.json);
    const approvalV2Response = await call(
      `/api/v1/projects/${projectId}/formal-input-approvals`,
      "POST",
      {
        id: "fia-p4-2",
        work_version_id: "wv-p4-2",
        snapshot_id: "snap-g4-v2",
        readiness_id: "ready-p4-2",
        authorized_task_id: "task-main-p4",
        purpose: "g4_delivery",
        preview_hash: previewV2.preview_hash,
      },
      "confirm-fia-p4-2",
    );
    if (approvalV2Response.status !== 201) {
      throw new Error(`formal approval v2: ${JSON.stringify(approvalV2Response.json)}`);
    }
    await runFormalJobs(projectId, "fia-p4-2");

    const submissionV2Id = "sub-g4-wv2";
    const evaluationV2Id = "eval-g4-wv2";
    const submissionV2 = await call(`/api/v1/projects/${projectId}/gate-submissions`, "POST", {
      id: submissionV2Id,
      process_instance_id: processInstanceId,
      work_version_id: "wv-p4-2",
      gate: "G4",
      snapshot_id: "snap-g4-v2",
    });
    if (submissionV2.status !== 201) {
      throw new Error(`G4 v2 submission: ${JSON.stringify(submissionV2.json)}`);
    }
    const evaluationV2Response = await call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionV2Id}/evaluations`,
      "POST",
      {
        evaluation_id: evaluationV2Id,
        work_version_id: "wv-p4-2",
        expected_snapshot_manifest_hash: g4v2.manifestHash,
      },
    );
    if (evaluationV2Response.status !== 201) {
      throw new Error(`G4 v2 evaluation: ${JSON.stringify(evaluationV2Response.json)}`);
    }
    const evaluationV2 = envelopeData(evaluationV2Response.json);
    expect(evaluationV2).toMatchObject({
      passed: true,
      work_version_id: "wv-p4-2",
      delivery_release_version: 2,
      supersedes_release_id: evaluation.delivery_release_id,
    });
    const submittedV2 = await call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionV2Id}/submit`,
      "POST",
      {
        gate_check_evaluation_id: evaluationV2Id,
        check_results_hash: evaluationV2.result_hash,
      },
    );
    if (submittedV2.status !== 200) {
      throw new Error(`G4 v2 submit: ${JSON.stringify(submittedV2.json)}`);
    }
    const approvedV2 = await call(
      `/api/v1/projects/${projectId}/gate-submissions/${submissionV2Id}/approve`,
      "POST",
      {
        configuration_snapshot_id: "snap-g4-v2",
        approved_gate_result_id: "agr-g4-wv2",
        approver_role: "quality",
        check_results_hash: evaluationV2.result_hash,
        signed_at: new Date().toISOString(),
        signature_method: "platform_token",
        authorization_basis: "P4 fixture role",
        reason: "formal delivery v2 accepted",
        issues: [],
        risks: [],
        waivers: [],
        baseline_id: "bl-b2-2",
        gate_check_evaluation_id: evaluationV2Id,
        candidate_manifest_hash: evaluationV2.sealed_projection_hash,
        delivery_release_id: evaluationV2.delivery_release_id,
      },
      "approve-g4-wv2",
    );
    if (approvedV2.status !== 200) {
      throw new Error(`G4 v2 approve: ${JSON.stringify(approvedV2.json)}`);
    }

    const releaseChain = await harness.client.query(
      `SELECT id, version, supersedes_release_id, work_version_id, manifest_hash,
              item_count, state
         FROM delivery_release WHERE project_id=$1 ORDER BY version`,
      [projectId],
    );
    expect(releaseChain.rows).toEqual([
      {
        id: evaluation.delivery_release_id,
        version: 1,
        supersedes_release_id: null,
        work_version_id: workVersionId,
        manifest_hash: releaseRows.rows[0].manifest_hash,
        item_count: releaseRows.rows[0].item_count,
        state: "sealed",
      },
      {
        id: evaluationV2.delivery_release_id,
        version: 2,
        supersedes_release_id: evaluation.delivery_release_id,
        work_version_id: "wv-p4-2",
        manifest_hash: expect.any(String),
        item_count: expect.any(Number),
        state: "sealed",
      },
    ]);
    expect(releaseChain.rows[1].manifest_hash).not.toBe(releaseRows.rows[0].manifest_hash);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM delivery_release_item WHERE project_id=$1",
      [projectId],
    )).rows[0].count).toBe(
      Number(releaseChain.rows[0].item_count) + Number(releaseChain.rows[1].item_count),
    );
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE project_id=$1 AND event_type='delivery.release_sealed'",
      [projectId],
    )).rows[0].count).toBe(2);
    expect((await harness.client.query(
      "SELECT state FROM change_request WHERE id='cr-p4-2' AND project_id=$1",
      [projectId],
    )).rows[0].state).toBe("released");
    expect((await harness.client.query(
      `SELECT gate::text
         FROM gate_submission
        WHERE project_id=$1 AND work_version_id='wv-p4-2'
        ORDER BY substring(gate::text FROM 2)::integer`,
      [projectId],
    )).rows).toEqual([{ gate: "G2" }, { gate: "G3" }, { gate: "G4" }]);
    expect((await harness.client.query(
      `SELECT id, kind::text, state, supersedes_baseline_id, superseded_by_baseline_id
         FROM baseline WHERE project_id=$1 AND kind IN ('B1','B2') ORDER BY kind, created_at, id`,
      [projectId],
    )).rows).toEqual([
      {
        id: "bl-b1-1",
        kind: "B1",
        state: "superseded",
        supersedes_baseline_id: null,
        superseded_by_baseline_id: "bl-b1-2",
      },
      {
        id: "bl-b1-2",
        kind: "B1",
        state: "active",
        supersedes_baseline_id: "bl-b1-1",
        superseded_by_baseline_id: null,
      },
      {
        id: "bl-b2-1",
        kind: "B2",
        state: "superseded",
        supersedes_baseline_id: null,
        superseded_by_baseline_id: "bl-b2-2",
      },
      {
        id: "bl-b2-2",
        kind: "B2",
        state: "active",
        supersedes_baseline_id: "bl-b2-1",
        superseded_by_baseline_id: null,
      },
    ]);
    expect(envelopeData((await call(`/api/v1/projects/${projectId}/process-state`)).json)).toMatchObject({
      processInstanceId,
      workVersionId: "wv-p4-2",
      currentGate: "G4",
      completed: true,
    });
    expect(connector.submitCalls).toBe(8);
    const originalManifestAfterV2 = await call(
      `/api/v1/projects/${projectId}/delivery-releases/${evaluation.delivery_release_id}/manifest`,
    );
    expect(originalManifestAfterV2.status).toBe(200);
    expect(envelopeData(originalManifestAfterV2.json).manifest_hash).toBe(releaseRows.rows[0].manifest_hash);

    const withdrawOnlyChangeBody = {
      id: "cr-p4-3",
      work_version_id: "wv-p4-3",
      base_delivery_release_id: evaluationV2.delivery_release_id,
      reason: "Open then withdraw a follow-up documentation change",
      affected_paths: ["doc/detail-v2.md"],
      impact_gate: "G3",
    };
    const withdrawOnlyChange = await call(
      `/api/v1/projects/${projectId}/change-requests`,
      "POST",
      withdrawOnlyChangeBody,
      "create-cr-p4-3",
    );
    if (withdrawOnlyChange.status !== 201) {
      throw new Error(`create withdraw-only change request: ${JSON.stringify(withdrawOnlyChange.json)}`);
    }
    const withdrawn = await call(
      `/api/v1/projects/${projectId}/change-requests/cr-p4-3/withdraw`,
      "POST",
      { reason: "Fixture withdrawal" },
      "withdraw-cr-p4-3",
    );
    if (withdrawn.status !== 200) throw new Error(`withdraw change request: ${JSON.stringify(withdrawn.json)}`);
    expect(envelopeData(withdrawn.json).state).toBe("withdrawn");
    const replayedWithdrawal = await call(
      `/api/v1/projects/${projectId}/change-requests/cr-p4-3/withdraw`,
      "POST",
      { reason: "Fixture withdrawal" },
      "withdraw-cr-p4-3",
    );
    expect(replayedWithdrawal.status).toBe(200);
    expect(envelopeData(replayedWithdrawal.json)).toEqual(envelopeData(withdrawn.json));
    const abandonedWork = await call(`/api/v1/projects/${projectId}/work-versions/wv-p4-3`);
    expect(envelopeData(abandonedWork.json).state).toBe("abandoned");
    const withdrawnProcessState = await call(`/api/v1/projects/${projectId}/process-state`);
    expect(envelopeData(withdrawnProcessState.json)).toMatchObject({
      processInstanceId,
      workVersionId: "wv-p4-2",
      currentGate: "G4",
      completed: true,
    });
    const changeEvents = await harness.client.query(
      `SELECT event_type, count(*)::int AS count
         FROM outbox_events WHERE aggregate_id = 'cr-p4-3'
        GROUP BY event_type ORDER BY event_type`,
    );
    expect(changeEvents.rows).toEqual([
      { event_type: "change_request.opened", count: 1 },
      { event_type: "change_request.withdrawn", count: 1 },
    ]);

    const blockedAfterWithdrawal = await call(
      `/api/v1/projects/${projectId}/artifacts/art-post-release/revisions`,
      "POST",
      {
        id: "rev-post-withdrawal-blocked",
        artifact_type: "RTL_SOURCE_SET",
        title: "rtl/post-withdrawal.sv",
        content: "module post_withdrawal; endmodule\n",
        content_location: "rtl/post-withdrawal.sv",
      },
      "post-withdrawal-revision-blocked",
    );
    expect(blockedAfterWithdrawal.status).toBe(409);
  });
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; P4 PostgreSQL API tests were not executed", () => {});
}
