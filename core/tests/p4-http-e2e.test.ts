/**
 * P4 real-transport integration: Runtime client -> Core HTTP -> Connector HTTP.
 *
 * This deliberately does not inject an in-process ConnectorPort fake. Core uses
 * the production RemoteConnectorAdapter, which talks through the remote
 * envelope protocol to a WorkerRuntime listening on a real ephemeral port. The
 * only fake is the Vivado execution itself; it writes the same complete evidence
 * set a governed batch run would expose.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteConnectorAdapter } from "../src/api/connector-adapter.ts";
import { sha256Hex } from "../src/hashing.ts";
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
import {
  REMOTE_SCHEMA_VERSION,
  RemoteConnectorClient,
  RemoteConnectorError,
  type ConnectorEndpoint,
  type DiscoverySnapshot,
  type RemoteEnvelope,
  type RemoteResponse,
  type RemoteTransport,
} from "../../connector/remote.ts";
import type { JobRequest } from "../../connector/index.ts";
import {
  WorkerRuntime,
  type WorkerExecution,
  type WorkerExecutionResult,
} from "../../connector/worker.ts";
import { workerRequestBindingMatches } from "../../connector/server.ts";
import { CoreGovernanceClient, GovernanceError } from "../../runtime/governance-client.ts";
import {
  FORMAL_G4_OPERATIONS,
  type FormalG4Operation,
  type FormalJobBindingV1,
} from "../../runtime/formal-flow.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const TARGET_PART = "xc7k70tfbv676-1";
const TOOLCHAIN_HASH = "0f503a9bf66e0226f2242cfeb6d42b51d2172afc8dc2584f230e0e03f33f3c5e";
const SUCCESS_PROJECT_ID = "p4-http-success";
const INCOMPLETE_PROJECT_ID = "p4-http-incomplete";
const REPLAY_PROJECT_ID = "p4-http-replay";
const EVIDENCE_PROJECT_ID = "p4-http-evidence";
const AUTH_PROJECT_ID = "p4-http-auth";
const AUTH_OTHER_PROJECT_ID = "p4-http-auth-other";
const BASELINE_PROJECT_ID = "p4-http-baseline";
const TOOLCHAIN_PROJECT_ID = "p4-http-toolchain";
const CONNECTOR_ID = "p4-http-worker";
const CAPABILITY_VERSION = "p4-http.v1";

const OPERATIONS = [...FORMAL_G4_OPERATIONS] as FormalG4Operation[];

const ENDPOINT: ConnectorEndpoint = {
  connector_id: CONNECTOR_ID,
  display_name: "P4 HTTP fixture",
  endpoint_url: "https://p4-worker.test",
  protocol_version: REMOTE_SCHEMA_VERSION,
  transport_mode: "direct_https",
  auth_mode: "mtls",
  tls_trust_ref: "secret://trust/p4-http-test",
  tls_client_cert_ref: "secret://cert/p4-http-test",
  project_scope: [
    SUCCESS_PROJECT_ID,
    INCOMPLETE_PROJECT_ID,
    REPLAY_PROJECT_ID,
    EVIDENCE_PROJECT_ID,
    AUTH_PROJECT_ID,
    AUTH_OTHER_PROJECT_ID,
    BASELINE_PROJECT_ID,
    TOOLCHAIN_PROJECT_ID,
  ],
  data_classification_scope: ["internal"],
  allowed_capability_ids: OPERATIONS,
  toolchain_profile_hash: TOOLCHAIN_HASH,
  worker_labels: { fixture: "p4-http-e2e" },
  heartbeat_interval_seconds: 5,
  lease_seconds: 60,
  max_concurrency: 4,
  registration_state: "registering",
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
  audited_by: "p4-http-e2e",
  expected_capability_map_version: "p4-http-capabilities.v1",
  expected_part_catalog_hash: "p4-http-parts.v1",
  expected_sdk_worker_build_hash: "p4-http-worker.v1",
};

interface RecordedWorkerCall {
  readonly path: string;
  readonly envelope: RemoteEnvelope<unknown>;
}

interface ExtendedJobRequest extends JobRequest {
  readonly parameters?: Record<string, unknown>;
}

interface WorkerFaults {
  dropNextSubmitResponse: boolean;
  discoveryToolchainHash: string;
}

interface FixtureProject {
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly workVersionId: string;
  readonly taskId: string;
  readonly readinessId: string;
  readonly readiness: Record<string, any>;
  readonly g4SnapshotId: string;
  readonly g4SnapshotHash: string;
  readonly revisions: Readonly<Record<string, string>>;
}

class WorkerHttpTransport implements RemoteTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly faults: WorkerFaults,
  ) {}

  async request(
    path: string,
    request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown> },
  ): Promise<RemoteResponse<unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: request.method,
      headers: request.body === undefined ? undefined : { "content-type": "application/json" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const text = await response.text();
    const result: RemoteResponse<unknown> = {
      status: response.status,
      body: text.length > 0
        ? JSON.parse(text) as RemoteResponse<unknown>["body"]
        : { error_code: "REMOTE_PROTOCOL_ERROR" },
    };
    if (path === "/jobs/submit" && this.faults.dropNextSubmitResponse) {
      this.faults.dropNextSubmitResponse = false;
      throw new RemoteConnectorError(
        "REMOTE_UNAVAILABLE",
        "fixture dropped the accepted Connector response",
        true,
      );
    }
    return result;
  }
}

function discovery(toolchainProfileHash = TOOLCHAIN_HASH): DiscoverySnapshot {
  return {
    connector_id: CONNECTOR_ID,
    connector_protocol_version: REMOTE_SCHEMA_VERSION,
    capability_map_version: "p4-http-capabilities.v1",
    vivado_version: "2021.1",
    vivado_patch: "3247384",
    part_catalog_hash: "p4-http-parts.v1",
    sdk_worker_build_hash: "p4-http-worker.v1",
    capabilities: OPERATIONS.map((operation) => ({
      operation,
      version: CAPABILITY_VERSION,
      runClasses: ["exploratory", "formal"],
    })),
    toolchain_profile_hash: toolchainProfileHash,
    license_status: "available",
  };
}

function resultEvidence(schema: string): string {
  return JSON.stringify({
    schema,
    passed: true,
    status: "succeeded",
    exitCode: 0,
    timedOut: false,
  });
}

async function executeFixture(
  request: JobRequest,
  workspace: string,
): Promise<WorkerExecutionResult> {
  const extended = request as ExtendedJobRequest;
  const parameters = extended.parameters;
  if (!parameters || !workerRequestBindingMatches(request, parameters, TOOLCHAIN_HASH)) {
    return {
      outcome: "failure",
      error_code: "FORMAL_BINDING_MISMATCH",
      output: JSON.stringify({
        status: "rejected",
        jobId: request.jobId ?? "worker",
        errorCode: "FORMAL_BINDING_MISMATCH",
      }),
      evidence: { jobId: request.jobId ?? "worker", entries: [] },
    };
  }

  const jobId = request.jobId ?? "worker";
  const sources = Array.isArray(parameters.sources)
    ? parameters.sources as Array<{ path: string; content: string; mediaType?: string }>
    : [];
  const constraints = Array.isArray(parameters.constraints)
    ? parameters.constraints as Array<{ path: string; content: string; mediaType?: string }>
    : [];
  const member = (entry: { path: string; content: string; mediaType?: string }) => {
    const bytes = new TextEncoder().encode(entry.content);
    return {
      path: entry.path,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: entry.mediaType ?? "application/octet-stream",
    };
  };
  const byUtf8Path = (left: { path: string }, right: { path: string }) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  );
  const inputManifest = {
    schema: "vivado-input-manifest.v1",
    jobId,
    projectId: request.projectId,
    operation: request.operation,
    runClass: request.runClass,
    inputHash: request.input,
    toolchainHash: parameters.toolchainHash,
    top: parameters.top ?? null,
    testbench: request.operation === "simulate" ? parameters.testbench ?? null : null,
    part: request.operation === "synthesize" || request.operation === "implement"
      ? parameters.part ?? null
      : null,
    sources: sources.map(member).sort(byUtf8Path),
    constraints: constraints.map(member).sort(byUtf8Path),
  };

  const entries: Array<{ name: string; content: string | Uint8Array; mediaType: string }> = [
    { name: "input-manifest.json", content: JSON.stringify(inputManifest), mediaType: "application/json" },
    { name: "run.tcl", content: "# governed HTTP fixture run\n", mediaType: "text/plain" },
    { name: "stderr.log", content: "", mediaType: "text/plain" },
    { name: "tool.log", content: "Vivado HTTP fixture log\n", mediaType: "text/plain" },
  ];
  if (request.operation === "validate_sources") {
    entries.push(
      { name: "stdout.log", content: "SOURCE_VALIDATION_OK\n", mediaType: "text/plain" },
      {
        name: "validation_result.json",
        content: resultEvidence("validate_sources-result.v1"),
        mediaType: "application/json",
      },
    );
  } else if (request.operation === "simulate") {
    entries.push(
      {
        name: "stdout.log",
        content: "SIMULATOR_OUTPUT_BEGIN\nPASS\nSIMULATOR_OUTPUT_END\nSIMULATION_OK\nPHASE_EXIT_CODE=0\n",
        mediaType: "text/plain",
      },
      {
        name: "simulation_result.json",
        content: resultEvidence("simulate-result.v1"),
        mediaType: "application/json",
      },
    );
  } else if (request.operation === "synthesize") {
    entries.push(
      { name: "stdout.log", content: "synthesis complete\n", mediaType: "text/plain" },
      {
        name: "synthesis_result.json",
        content: resultEvidence("synthesize-result.v1"),
        mediaType: "application/json",
      },
      { name: "resources.rpt", content: "LUT 1\n", mediaType: "text/plain" },
    );
  } else {
    entries.push(
      { name: "stdout.log", content: "implementation complete\n", mediaType: "text/plain" },
      {
        name: "implementation_result.json",
        content: resultEvidence("implement-result.v1"),
        mediaType: "application/json",
      },
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

  const outputDir = join(workspace, "output");
  await mkdir(outputDir, { recursive: true });
  const manifestEntries = [];
  for (const entry of entries) {
    const bytes = typeof entry.content === "string"
      ? new TextEncoder().encode(entry.content)
      : entry.content;
    await writeFile(join(outputDir, entry.name), bytes);
    manifestEntries.push({
      name: entry.name,
      uri: `workspace://${jobId}/output/${entry.name}`,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: entry.mediaType,
    });
  }
  return {
    outcome: "success",
    output: JSON.stringify({
      schema: "worker-result.v1",
      jobId,
      projectId: request.projectId,
      operation: request.operation,
      runClass: request.runClass,
      status: "succeeded",
      inputHash: request.input,
      toolchainHash: parameters.toolchainHash,
    }),
    evidence: { jobId, entries: manifestEntries },
  };
}

function envelopeData(json: unknown): Record<string, any> {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`invalid envelope: ${JSON.stringify(json)}`);
  }
  const data = (json as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`invalid data: ${JSON.stringify(json)}`);
  }
  return data as Record<string, any>;
}

function envelopeArray(json: unknown): Record<string, any>[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`invalid envelope: ${JSON.stringify(json)}`);
  }
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error(`invalid list: ${JSON.stringify(json)}`);
  return data as Record<string, any>[];
}

describe.skipIf(!DATABASE_URL)("P4 Runtime -> Core -> Connector real HTTP", () => {
  let harness: ApiHarness;
  let workerServer: ReturnType<typeof Bun.serve>;
  let workerRoot: string;
  let worker: WorkerRuntime;
  let execution: WorkerExecution;
  const workerCalls: RecordedWorkerCall[] = [];
  const executionCounts = new Map<string, number>();
  const workerFaults: WorkerFaults = {
    dropNextSubmitResponse: false,
    discoveryToolchainHash: TOOLCHAIN_HASH,
  };

  beforeAll(async () => {
    workerRoot = await mkdtemp(join(tmpdir(), "synthia-p4-http-worker-"));
    execution = {
      async discover() { return discovery(workerFaults.discoveryToolchainHash); },
      async execute(request, workspace) {
        const jobId = request.jobId ?? "worker";
        executionCounts.set(jobId, (executionCounts.get(jobId) ?? 0) + 1);
        return executeFixture(request, workspace);
      },
    };
    worker = new WorkerRuntime({ endpoint: ENDPOINT, workspaceRoot: workerRoot, execution });
    workerServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const envelope = await request.clone().json() as RemoteEnvelope<unknown>;
        workerCalls.push({ path: new URL(request.url).pathname, envelope });
        return worker.handle(request);
      },
    });
    const workerUrl = `http://${workerServer.hostname}:${workerServer.port}`;
    const adapter = new RemoteConnectorAdapter(
      (options) => new RemoteConnectorClient({
        endpoint: options.endpoint as unknown as ConnectorEndpoint,
        transport: new WorkerHttpTransport(workerUrl, workerFaults),
        actor: options.actor,
        classification: options.classification as "internal",
        projectId: options.projectId,
        allowlist: options.allowlist,
      }),
      ENDPOINT as unknown as Record<string, unknown>,
      ["p4-worker.test"],
      {},
    );
    harness = await setupApiHarness(DATABASE_URL, {
      features: { formalDelivery: true },
      connector: adapter,
    });
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
    workerCalls.length = 0;
    executionCounts.clear();
    workerFaults.dropNextSubmitResponse = false;
    workerFaults.discoveryToolchainHash = TOOLCHAIN_HASH;
    // Registration, discovery, leases, jobs, and downstream idempotency belong
    // to one Connector process. Recreate that process for each scenario so a
    // deliberate drift fault cannot leak into the next independent test.
    worker = new WorkerRuntime({ endpoint: ENDPOINT, workspaceRoot: workerRoot, execution });
  });

  afterAll(async () => {
    await teardownApiHarness(harness);
    workerServer.stop(true);
    await rm(workerRoot, { recursive: true, force: true });
  });

  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    key = `idem-${randomUUID()}`,
  ) {
    return apiCall(harness.baseUrl, path, {
      method,
      body,
      token: harness.ids.humanToken,
      headers: method === "GET" ? {} : { "idempotency-key": key },
    });
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

  async function createBareModernProject(projectId: string, name: string): Promise<void> {
    const created = await call("/api/v1/projects", "POST", {
      id: projectId,
      name,
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
      target_part: TARGET_PART,
      toolchain_profile_ref: TOOLCHAIN_HASH,
    });
    if (created.status !== 201) throw new Error(`project: ${JSON.stringify(created.json)}`);
  }

  async function createRevision(
    projectId: string,
    id: string,
    artifactType: string,
    path: string,
    content: string,
  ): Promise<void> {
    const response = await call(
      `/api/v1/projects/${projectId}/artifacts/art-${id}/revisions`,
      "POST",
      {
        id,
        artifact_type: artifactType,
        title: path,
        content,
        content_location: path,
      },
    );
    if (response.status !== 201) {
      throw new Error(`revision ${id}: ${JSON.stringify(response.json)}`);
    }
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
      basis: "P4 structured HTTP gate evidence fixture",
      data_classification: "D1",
    });
    if (response.status !== 201) throw new Error(`trace ${id}: ${JSON.stringify(response.json)}`);
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
    tag: string;
    workVersionId: string;
    processInstanceId: string;
    gate: "G1" | "G2" | "G3";
    snapshotId: string;
    snapshotHash: string;
    baselineId: string | null;
  }): Promise<void> {
    const suffix = `${input.tag}-${input.gate.toLowerCase()}`;
    const submissionId = `sub-${suffix}`;
    const evaluationId = `eval-${suffix}`;
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
        approved_gate_result_id: `agr-${suffix}`,
        approver_role: "quality",
        check_results_hash: evaluation.result_hash,
        signed_at: new Date().toISOString(),
        signature_method: "platform_token",
        reason: `${input.gate} HTTP fixture approved`,
        baseline_id: input.baselineId,
        gate_check_evaluation_id: evaluationId,
      },
    );
    if (approved.status !== 200) throw new Error(`gate approve: ${JSON.stringify(approved.json)}`);
  }

  async function prepareProjectThroughG3(
    projectId: string,
    tag: string,
    constraintsComplete: boolean,
  ): Promise<FixtureProject> {
    const created = await call("/api/v1/projects", "POST", {
      id: projectId,
      name: `P4 HTTP ${tag}`,
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
      target_part: TARGET_PART,
      toolchain_profile_ref: TOOLCHAIN_HASH,
    });
    expect(created.status).toBe(201);
    const role = await call(`/api/v1/projects/${projectId}/role-assignments`, "POST", {
      id: `role-${tag}`,
      actor_type: "human",
      actor_id: harness.ids.humanUid,
      role: "quality",
    });
    expect(role.status).toBe(201);

    const stateResponse = await call(`/api/v1/projects/${projectId}/process-state`);
    const state = envelopeData(stateResponse.json);
    const processInstanceId = String(state.processInstanceId);
    const workVersionId = String(state.workVersionId);
    const revisions = {
      source: `rev-${tag}-source-package`,
      requirements: `rev-${tag}-requirements`,
      behavior: `rev-${tag}-behavior`,
      architecture: `rev-${tag}-architecture`,
      detail: `rev-${tag}-detail`,
      constraintDesign: `rev-${tag}-constraint-design`,
      rtl: `rev-${tag}-rtl`,
      tb: `rev-${tag}-tb`,
      xdc: `rev-${tag}-xdc`,
    };
    const traces = {
      g1: `trace-${tag}-g1-evidence`,
      g2: `trace-${tag}-g2-evidence`,
      g3: `trace-${tag}-g3-evidence`,
    };
    await createRevision(projectId, revisions.source, "SOURCE_PACKAGE", "doc/source-package.txt", "PWM source requirement package v1\n");
    await createRevision(projectId, revisions.requirements, "DEVELOPMENT_REQUIREMENTS", "doc/requirements.json", g1GateEvidence({ sourceRevisionId: revisions.source, traceRelationId: traces.g1 }));
    await createRevision(projectId, revisions.behavior, "PLDS_SRS", "doc/behavior.json", g2GateEvidence({ traceRelationId: traces.g2 }));
    await createRevision(projectId, revisions.architecture, "ARCHITECTURE_DESIGN", "doc/architecture.json", g3GateEvidence({ traceRelationId: traces.g3 }));
    await createRevision(projectId, revisions.detail, "DETAILED_DESIGN", "doc/detail.md", "# Detailed design\n");
    await createRevision(projectId, revisions.constraintDesign, "CONSTRAINT_DESIGN", "doc/constraints.md", "# Constraint strategy\n");
    await createRevision(projectId, revisions.rtl, "RTL_SOURCE_SET", "rtl/top.sv", "module top(input logic clk); endmodule\n");
    await createRevision(projectId, revisions.tb, "TB_SOURCE_SET", "tb/top_tb.sv", "module top_tb; initial begin $display(\"PASS\"); end endmodule\n");
    await createRevision(projectId, revisions.xdc, "XDC_CANDIDATE", "prj/constr/top.xdc", "set_property PACKAGE_PIN W5 [get_ports clk]\nset_property IOSTANDARD LVCMOS33 [get_ports clk]\ncreate_clock -name clk -period 10 [get_ports clk]\n");
    await createApprovedTrace(projectId, traces.g1, revisions.source, revisions.requirements);
    await createApprovedTrace(projectId, traces.g2, revisions.requirements, revisions.behavior);
    await createApprovedTrace(projectId, traces.g3, revisions.requirements, revisions.architecture);

    const profileResponse = await call("/api/v1/process-versions/GJB_REF_V1/profile");
    const profile = envelopeData(profileResponse.json);
    expect(profile.profileHash).toBe(TOOLCHAIN_HASH);
    const treeResponse = await call(`/api/v1/projects/${projectId}/workspace/tree`);
    const tree = envelopeData(treeResponse.json);
    const readinessId = `ready-${tag}`;
    const readinessResponse = await call(`/api/v1/projects/${projectId}/readiness`, "POST", {
      id: readinessId,
      work_version_id: workVersionId,
      reason: `P4 HTTP ${tag} readiness`,
      source_snapshot_ids: [],
      workspace_expected_commit: tree.head_commit,
      workspace_manifest_hash: tree.workspace_manifest_hash,
      engineering_config: {
        schema: "engineering-config.v1",
        targetPart: { value: TARGET_PART, state: "identified" },
        board: { ref: "board-kc705-v1", state: "identified" },
        constraints: {
          pin: { state: "complete", revisionIds: [revisions.xdc] },
          electrical: constraintsComplete
            ? { state: "complete", revisionIds: [revisions.xdc] }
            : { state: "missing", revisionIds: [] },
          clock: { state: "complete", revisionIds: [revisions.xdc] },
        },
        dataScope: { classification: "D1", description: "P4 controlled HTTP fixture" },
        sourcePolicy: { confirmedOnly: true },
      },
    });
    if (readinessResponse.status !== 201) {
      throw new Error(`readiness: ${JSON.stringify(readinessResponse.json)}`);
    }
    const confirmedResponse = await call(
      `/api/v1/projects/${projectId}/readiness/${readinessId}/confirm`,
      "POST",
      { reason: "human confirms HTTP fixture" },
    );
    if (confirmedResponse.status !== 200) {
      throw new Error(`confirm readiness: ${JSON.stringify(confirmedResponse.json)}`);
    }
    const readiness = envelopeData(confirmedResponse.json);
    expect(readiness.ready).toBe(true);
    expect(readiness.constraints_complete).toBe(constraintsComplete);

    const g1Id = `snap-${tag}-g1`;
    const g1 = await createSnapshot(projectId, workVersionId, g1Id, [revisions.source, revisions.requirements], profile.profileHash, [traces.g1]);
    await passGate({ projectId, tag, workVersionId, processInstanceId, gate: "G1", snapshotId: g1Id, snapshotHash: g1.manifestHash, baselineId: `bl-${tag}-b0` });
    const g2Id = `snap-${tag}-g2`;
    const g2 = await createSnapshot(projectId, workVersionId, g2Id, [revisions.behavior], profile.profileHash, [traces.g2]);
    await passGate({ projectId, tag, workVersionId, processInstanceId, gate: "G2", snapshotId: g2Id, snapshotHash: g2.manifestHash, baselineId: null });
    const g3Id = `snap-${tag}-g3`;
    const g3 = await createSnapshot(projectId, workVersionId, g3Id, [revisions.architecture, revisions.detail, revisions.constraintDesign], profile.profileHash, [traces.g3]);
    await passGate({ projectId, tag, workVersionId, processInstanceId, gate: "G3", snapshotId: g3Id, snapshotHash: g3.manifestHash, baselineId: `bl-${tag}-b1` });

    const g4SnapshotId = `snap-${tag}-g4`;
    const g4 = await createSnapshot(projectId, workVersionId, g4SnapshotId, [revisions.rtl, revisions.tb, revisions.xdc], profile.profileHash);
    const taskId = `task-${tag}-main`;
    await harness.client.query(
      `INSERT INTO agent_task
        (id, project_id, project_type, kind, process_instance_id,
         runtime_actor_id, objective, authorization_scope, status, input_hash,
         adoption_state, created_by_type, created_by)
       VALUES ($1,$2,'engineering','main',$3,$4,$5,'{}'::jsonb,
               'running',$6,'not_applicable','human',$7)`,
      [
        taskId,
        projectId,
        processInstanceId,
        harness.ids.serviceUid,
        `P4 HTTP ${tag}`,
        sha256Hex(`task:${taskId}`),
        harness.ids.humanUid,
      ],
    );
    return {
      projectId,
      processInstanceId,
      workVersionId,
      taskId,
      readinessId,
      readiness,
      g4SnapshotId,
      g4SnapshotHash: String(g4.manifestHash),
      revisions,
    };
  }

  function runtimeClient(project: FixtureProject): CoreGovernanceClient {
    return new CoreGovernanceClient({
      baseUrl: harness.baseUrl,
      token: harness.ids.serviceToken,
      taskRuntimeToken: harness.ids.taskRuntimeToken,
      taskId: project.taskId,
      projectId: project.projectId,
      processInstanceId: project.processInstanceId,
      retryDelayMs: 0,
    });
  }

  async function confirmFormalInput(
    project: FixtureProject,
    approvalId: string,
  ): Promise<{
    readonly runtime: CoreGovernanceClient;
    readonly preview: Awaited<ReturnType<CoreGovernanceClient["previewFormalInput"]>>;
  }> {
    const runtime = runtimeClient(project);
    const preview = await runtime.previewFormalInput({
      workVersionId: project.workVersionId,
      snapshotId: project.g4SnapshotId,
      readinessId: project.readinessId,
      authorizedTaskId: project.taskId,
    });
    const approvalResponse = await call(`/api/v1/projects/${project.projectId}/formal-input-approvals`, "POST", {
      id: approvalId,
      work_version_id: project.workVersionId,
      snapshot_id: project.g4SnapshotId,
      readiness_id: project.readinessId,
      authorized_task_id: project.taskId,
      purpose: "g4_delivery",
      preview_hash: preview.previewHash,
    });
    if (approvalResponse.status !== 201) {
      throw new Error(`formal approval: ${JSON.stringify(approvalResponse.json)}`);
    }
    return { runtime, preview };
  }

  async function waitForFormalJob(
    client: CoreGovernanceClient,
    initial: FormalJobBindingV1,
  ): Promise<FormalJobBindingV1> {
    let job = initial;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await client.getFormalJob(initial.jobId);
      if (["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect", "rejected"].includes(job.state)) {
        return job;
      }
      await Bun.sleep(5);
    }
    throw new Error(`formal job did not become terminal: ${initial.jobId}`);
  }

  async function waitForApiJob(projectId: string, jobId: string): Promise<Record<string, any>> {
    let job: Record<string, any> = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await call(`/api/v1/projects/${projectId}/jobs/${jobId}`);
      if (response.status !== 200) throw new Error(`job status: ${JSON.stringify(response.json)}`);
      job = envelopeData(response.json);
      if (["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect", "rejected"].includes(job.state)) {
        return job;
      }
      await Bun.sleep(5);
    }
    throw new Error(`job did not become terminal: ${jobId}`);
  }

  test("seals G4 after four same-input formal jobs across both HTTP boundaries", async () => {
    const project = await prepareProjectThroughG3(SUCCESS_PROJECT_ID, "success", true);
    const runtime = runtimeClient(project);
    const preview = await runtime.previewFormalInput({
      workVersionId: project.workVersionId,
      snapshotId: project.g4SnapshotId,
      readinessId: project.readinessId,
      authorizedTaskId: project.taskId,
    });
    expect(preview.toolchainProfileHash).toBe(TOOLCHAIN_HASH);
    expect(preview.constraintsComplete).toBe(true);
    const approvalId = "fia-http-success";
    const approvalResponse = await call(`/api/v1/projects/${project.projectId}/formal-input-approvals`, "POST", {
      id: approvalId,
      work_version_id: project.workVersionId,
      snapshot_id: project.g4SnapshotId,
      readiness_id: project.readinessId,
      authorized_task_id: project.taskId,
      purpose: "g4_delivery",
      preview_hash: preview.previewHash,
    });
    if (approvalResponse.status !== 201) {
      throw new Error(`formal approval: ${JSON.stringify(approvalResponse.json)}`);
    }
    const approval = await runtime.getFormalInputApproval(approvalId);
    expect(approval.inputHash).toBe(preview.inputHash);

    const jobs: FormalJobBindingV1[] = [];
    for (const operation of OPERATIONS) {
      const submitted = await runtime.submitFormalJob(
        operation,
        approvalId,
        `runtime-http-${approvalId}-${operation}`,
      );
      const terminal = await waitForFormalJob(runtime, submitted);
      expect(terminal.state).toBe("succeeded");
      const frozen = await runtime.freezeFormalEvidence(
        terminal.jobId,
        `runtime-http-freeze-${terminal.jobId}`,
      );
      expect(frozen.runState).toBe("succeeded");
      expect(frozen.inputHash).toBe(preview.inputHash);
      expect(frozen.entries.length).toBeGreaterThan(0);
      jobs.push(terminal);
    }
    expect(new Set(jobs.map((job) => job.inputHash))).toEqual(new Set([preview.inputHash]));
    expect(new Set(jobs.map((job) => job.toolchainProfileHash))).toEqual(new Set([TOOLCHAIN_HASH]));
    expect(jobs.map((job) => job.operation)).toEqual(OPERATIONS);

    const submitCalls = workerCalls.filter((entry) => entry.path === "/jobs/submit");
    expect(submitCalls).toHaveLength(4);
    const seenOperations: string[] = [];
    for (const entry of submitCalls) {
      expect(entry.envelope.actor).toEqual({ actor_type: "service", actor_id: "synthia-core" });
      expect(entry.envelope.project_id).toBe(project.projectId);
      const payload = entry.envelope.payload as {
        request: ExtendedJobRequest;
        approval: Record<string, unknown>;
      };
      const request = payload.request;
      const parameters = request.parameters!;
      expect(request.runClass).toBe("formal");
      expect(request.input).toBe(preview.inputHash);
      expect(request.projectId).toBe(project.projectId);
      expect(request.jobId).toBeString();
      expect(parameters.jobId).toBe(request.jobId);
      expect(parameters.projectId).toBe(request.projectId);
      expect(parameters.operation).toBe(request.operation);
      expect(parameters.runClass).toBe(request.runClass);
      expect(parameters.inputHash).toBe(request.input);
      expect(parameters.toolchainHash).toBe(TOOLCHAIN_HASH);
      expect(payload.approval).toMatchObject({
        inputApproved: true,
        projectId: project.projectId,
        baselineId: "bl-success-b1",
      });
      seenOperations.push(request.operation);
    }
    expect(seenOperations).toEqual(OPERATIONS);

    const persisted = await harness.client.query(
      `SELECT id, operation, input_hash, toolchain_profile_hash, correlation_id,
              submitted_by_type, submitted_by
         FROM tool_run
        WHERE project_id = $1 AND binding_version = 'formal-input.v1'
        ORDER BY CASE operation
          WHEN 'validate_sources' THEN 1 WHEN 'simulate' THEN 2
          WHEN 'synthesize' THEN 3 WHEN 'implement' THEN 4 END`,
      [project.projectId],
    );
    expect(persisted.rows).toHaveLength(4);
    expect(new Set(persisted.rows.map((row) => row.input_hash))).toEqual(new Set([preview.inputHash]));
    expect(new Set(persisted.rows.map((row) => row.toolchain_profile_hash))).toEqual(new Set([TOOLCHAIN_HASH]));
    expect(new Set(persisted.rows.map((row) => row.submitted_by_type))).toEqual(new Set(["service"]));
    expect(new Set(persisted.rows.map((row) => row.submitted_by))).toEqual(new Set([harness.ids.serviceUid]));
    for (const row of persisted.rows) {
      const callForJob = submitCalls.find((entry) => (
        entry.envelope.payload as { request: ExtendedJobRequest }
      ).request.jobId === row.id);
      expect(callForJob).toBeDefined();
      expect((callForJob!.envelope.payload as { request: ExtendedJobRequest }).request.correlationId).toBe(row.correlation_id);
    }

    const submissionId = "sub-success-g4";
    const gateSubmission = await call(`/api/v1/projects/${project.projectId}/gate-submissions`, "POST", {
      id: submissionId,
      process_instance_id: project.processInstanceId,
      work_version_id: project.workVersionId,
      gate: "G4",
      snapshot_id: project.g4SnapshotId,
    });
    expect(gateSubmission.status).toBe(201);
    const evaluation = await runtime.createGateEvaluation({
      submissionId,
      evaluationId: "eval-success-g4",
      workVersionId: project.workVersionId,
      expectedSnapshotManifestHash: project.g4SnapshotHash,
    });
    expect(evaluation.passed).toBe(true);
    expect(evaluation.deliveryReleaseId).toBeString();
    await runtime.submitEvaluatedGate({
      submissionId,
      evaluationId: evaluation.id,
      resultHash: evaluation.resultHash,
    });
    const approvalBody = {
      configuration_snapshot_id: project.g4SnapshotId,
      approved_gate_result_id: "agr-success-g4",
      approver_role: "quality",
      check_results_hash: evaluation.resultHash,
      signed_at: new Date().toISOString(),
      signature_method: "platform_token",
      authorization_basis: "P4 HTTP fixture role",
      reason: "formal HTTP delivery accepted",
      issues: [],
      risks: [],
      waivers: [],
      baseline_id: "bl-success-b2",
      gate_check_evaluation_id: evaluation.id,
      candidate_manifest_hash: evaluation.sealedProjectionHash,
      delivery_release_id: evaluation.deliveryReleaseId,
    };
    const approvalPath = `/api/v1/projects/${project.projectId}/gate-submissions/${submissionId}/approve`;
    const approved = await call(approvalPath, "POST", approvalBody, "approve-success-g4");
    if (approved.status !== 200) throw new Error(`G4 approve: ${JSON.stringify(approved.json)}`);
    const replayed = await call(approvalPath, "POST", approvalBody, "approve-success-g4");
    expect(replayed.status).toBe(200);
    expect(envelopeData(replayed.json)).toEqual(envelopeData(approved.json));
    const secondScope = await call(approvalPath, "POST", approvalBody, "approve-success-g4-another-scope");
    expect(secondScope.status).toBe(409);
    const releases = await runtime.listDeliveryReleases();
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      id: evaluation.deliveryReleaseId,
      workVersionId: project.workVersionId,
      state: "sealed",
      version: 1,
    });
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM delivery_release WHERE project_id = $1",
      [project.projectId],
    )).rows[0].count).toBe(1);
  }, 30_000);

  test("reattaches the same Connector job when the accepted response is lost", async () => {
    const project = await prepareProjectThroughG3(REPLAY_PROJECT_ID, "replay", true);
    const { runtime, preview } = await confirmFormalInput(project, "fia-http-replay");
    workerFaults.dropNextSubmitResponse = true;
    const submitted = await runtime.submitFormalJob(
      "validate_sources",
      "fia-http-replay",
      "runtime-http-replay-validate",
    );
    const terminal = await waitForFormalJob(runtime, submitted);
    expect(terminal).toMatchObject({
      state: "succeeded",
      operation: "validate_sources",
      inputHash: preview.inputHash,
      toolchainProfileHash: TOOLCHAIN_HASH,
    });
    const submitCalls = workerCalls.filter((entry) => entry.path === "/jobs/submit");
    expect(submitCalls).toHaveLength(2);
    const requests = submitCalls.map((entry) => (
      entry.envelope.payload as { request: ExtendedJobRequest }
    ).request);
    expect(new Set(requests.map((request) => request.jobId))).toEqual(new Set([terminal.jobId]));
    expect(new Set(requests.map((request) => request.idempotencyKey))).toEqual(new Set([
      `p4-formal:${project.projectId}:fia-http-replay:validate_sources`,
    ]));
    expect(new Set(requests.map((request) => request.correlationId)).size).toBe(1);
    expect(executionCounts.get(terminal.jobId)).toBe(1);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run WHERE id = $1",
      [terminal.jobId],
    )).rows[0].count).toBe(1);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'tool_run.submitted'",
      [terminal.jobId],
    )).rows[0].count).toBe(1);
  }, 30_000);

  test("rejects tampered and divergent evidence without re-executing the job", async () => {
    const project = await prepareProjectThroughG3(EVIDENCE_PROJECT_ID, "evidence", true);
    const { runtime } = await confirmFormalInput(project, "fia-http-evidence");
    const submitted = await runtime.submitFormalJob(
      "implement",
      "fia-http-evidence",
      "runtime-http-evidence-implement",
    );
    const terminal = await waitForFormalJob(runtime, submitted);
    expect(terminal.state).toBe("succeeded");
    const bitstreamPath = join(workerRoot, terminal.jobId, "output", "formal.bit");
    const originalBitstream = await readFile(bitstreamPath);
    await writeFile(bitstreamPath, new Uint8Array([99, 98, 97]));
    try {
      await expect(runtime.freezeFormalEvidence(
        terminal.jobId,
        `runtime-http-freeze-tampered-${terminal.jobId}`,
      )).rejects.toMatchObject({
        name: "GovernanceError",
        message: "EVIDENCE_CORRUPT",
      });
    } finally {
      await writeFile(bitstreamPath, originalBitstream);
    }
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run_evidence_manifest WHERE tool_run_id = $1",
      [terminal.jobId],
    )).rows[0].count).toBe(0);

    const frozen = await runtime.freezeFormalEvidence(
      terminal.jobId,
      `runtime-http-freeze-restored-${terminal.jobId}`,
    );
    expect(frozen.runState).toBe("succeeded");
    await expect(runtime.freezeFormalEvidence(
      terminal.jobId,
      `runtime-http-freeze-divergent-${terminal.jobId}`,
      "f".repeat(64),
    )).rejects.toMatchObject({
      name: "GovernanceError",
      code: "conflict",
      httpStatus: 409,
      message: "EVIDENCE_MANIFEST_DIVERGED",
    });
    expect(executionCounts.get(terminal.jobId)).toBe(1);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run_evidence_manifest WHERE tool_run_id = $1",
      [terminal.jobId],
    )).rows[0].count).toBe(1);
  }, 30_000);

  test("fails closed for generic, side-shaped, other-runtime, and cross-project credentials", async () => {
    const project = await prepareProjectThroughG3(AUTH_PROJECT_ID, "auth", true);
    const { runtime } = await confirmFormalInput(project, "fia-http-auth");
    await createBareModernProject(AUTH_OTHER_PROJECT_ID, "P4 HTTP auth other project");
    const body = {
      operation: "validate_sources",
      run_class_intent: "formal",
      formal_input_approval_id: "fia-http-auth",
    };
    const path = `/api/v1/projects/${project.projectId}/jobs`;
    const generic = await callAs(
      harness.ids.genericServiceToken,
      path,
      "POST",
      body,
      "auth-generic",
    );
    expect(generic.status).toBe(403);
    const otherRuntime = await callAs(
      harness.ids.secondServiceToken,
      path,
      "POST",
      body,
      "auth-other-runtime",
    );
    expect(otherRuntime.status).toBe(404);
    const combinedScope = await callAs(
      harness.ids.combinedServiceToken,
      path,
      "POST",
      body,
      "auth-combined-scope",
    );
    expect(combinedScope.status).toBe(401);
    const crossProject = await callAs(
      harness.ids.taskRuntimeToken,
      `/api/v1/projects/${AUTH_OTHER_PROJECT_ID}/jobs`,
      "POST",
      body,
      "auth-cross-project",
    );
    expect(crossProject.status).toBe(404);
    expect(workerCalls.filter((entry) => entry.path === "/jobs/submit")).toHaveLength(0);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run WHERE run_class = 'formal'",
    )).rows[0].count).toBe(0);

    const missingTaskHeader = await callAs(
      harness.ids.taskRuntimeToken,
      path,
      "POST",
      body,
      "auth-missing-task-header",
    );
    expect(missingTaskHeader.status).toBe(403);
    const wrongTaskHeader = await callAs(
      harness.ids.taskRuntimeToken,
      path,
      "POST",
      body,
      "auth-wrong-task-header",
      "task-other-main",
    );
    expect(wrongTaskHeader.status).toBe(403);
    expect(workerCalls.filter((entry) => entry.path === "/jobs/submit")).toHaveLength(0);

    const valid = await runtime.submitFormalJob(
      "validate_sources",
      "fia-http-auth",
      "auth-bound-runtime",
    );
    const terminal = await waitForFormalJob(runtime, valid);
    expect(terminal.state).toBe("succeeded");
    expect(workerCalls.filter((entry) => entry.path === "/jobs/submit")).toHaveLength(1);
  }, 30_000);

  test("invalidates a frozen formal approval when its active B1 baseline drifts", async () => {
    const project = await prepareProjectThroughG3(BASELINE_PROJECT_ID, "baseline", true);
    const { runtime } = await confirmFormalInput(project, "fia-http-baseline");
    await harness.client.query("BEGIN");
    try {
      await harness.client.query(
        `INSERT INTO gate_submission
          (id, project_id, process_instance_id, gate, snapshot_id, state,
           submitter_id, check_results, issues, created_at, submitted_at,
           work_version_id)
         SELECT $1, project_id, process_instance_id, gate, snapshot_id, 'approved',
                submitter_id, check_results, issues, now(), now(), work_version_id
           FROM gate_submission WHERE id = $2 AND project_id = $3`,
        ["sub-baseline-g3-successor", "sub-baseline-g3", project.projectId],
      );
      await harness.client.query(
        `INSERT INTO approval_record
          (id, project_id, gate_submission_id, decision, approver_id,
           approver_role, authorization_basis, reason, issues, risks, waivers,
           check_results_hash, signed_at, signature_method, client_audit_digest,
           approved_gate_result_id, created_at)
         SELECT $1, a.project_id, $2, a.decision, a.approver_id,
                a.approver_role, a.authorization_basis, 'successor B1 fixture',
                a.issues, a.risks, a.waivers, a.check_results_hash, now(),
                a.signature_method, a.client_audit_digest, $3, now()
           FROM approval_record a
           JOIN baseline b ON b.approval_record_id = a.id
          WHERE b.id = $4 AND b.project_id = $5`,
        [
          "apr-baseline-g3-successor",
          "sub-baseline-g3-successor",
          "agr-baseline-g3-successor",
          "bl-baseline-b1",
          project.projectId,
        ],
      );
      await harness.client.query(
        `INSERT INTO approved_gate_result
          (id, project_id, gate, gate_submission_id, approval_record_id,
           snapshot_id, created_at)
         SELECT $1, project_id, gate, $2, $3, snapshot_id, now()
           FROM approved_gate_result WHERE id = $4 AND project_id = $5`,
        [
          "agr-baseline-g3-successor",
          "sub-baseline-g3-successor",
          "apr-baseline-g3-successor",
          "agr-baseline-g3",
          project.projectId,
        ],
      );
      await harness.client.query(
        `INSERT INTO baseline
          (id, project_id, kind, state, approved_gate_result_id,
           member_revision_ids, trace_relation_ids, manifest_hash,
           approval_record_id, supersedes_baseline_id)
         SELECT $1, project_id, kind, 'active', $2,
                member_revision_ids, trace_relation_ids, manifest_hash,
                $3, id
           FROM baseline WHERE id = $4 AND project_id = $5`,
        [
          "bl-baseline-b1-successor",
          "agr-baseline-g3-successor",
          "apr-baseline-g3-successor",
          "bl-baseline-b1",
          project.projectId,
        ],
      );
      await harness.client.query("COMMIT");
    } catch (error) {
      await harness.client.query("ROLLBACK");
      throw error;
    }
    await expect(runtime.submitFormalJob(
      "validate_sources",
      "fia-http-baseline",
      "runtime-http-baseline-drift",
    )).rejects.toMatchObject({
      name: "GovernanceError",
      code: "conflict",
      httpStatus: 409,
      message: "FORMAL_INPUT_APPROVAL_INACTIVE",
    });
    expect(workerCalls.filter((entry) => entry.path === "/jobs/submit")).toHaveLength(0);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run WHERE project_id = $1 AND run_class = 'formal'",
      [project.projectId],
    )).rows[0].count).toBe(0);
  }, 30_000);

  test("fails closed on Connector discovery toolchain drift before formal submit", async () => {
    const project = await prepareProjectThroughG3(TOOLCHAIN_PROJECT_ID, "toolchain", true);
    const { runtime } = await confirmFormalInput(project, "fia-http-toolchain");
    workerFaults.discoveryToolchainHash = sha256Hex("drifted-p4-http-toolchain");
    try {
      await expect(runtime.submitFormalJob(
        "validate_sources",
        "fia-http-toolchain",
        "runtime-http-toolchain-drift",
      )).rejects.toMatchObject({
        name: "GovernanceError",
        code: "capability_unavailable",
        httpStatus: 503,
      });
    } finally {
      workerFaults.discoveryToolchainHash = TOOLCHAIN_HASH;
    }
    expect(workerCalls.filter((entry) => entry.path === "/jobs/submit")).toHaveLength(0);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run WHERE project_id = $1 AND run_class = 'formal'",
      [project.projectId],
    )).rows[0].count).toBe(0);
  }, 30_000);

  test("confirmed incomplete constraints stay exploratory/trial and formal preview fails closed", async () => {
    const project = await prepareProjectThroughG3(INCOMPLETE_PROJECT_ID, "incomplete", false);
    expect(project.readiness).toMatchObject({
      status: "confirmed",
      state: "ready",
      ready: true,
      constraints_complete: false,
      electrical_constraints_complete: false,
    });
    const runtime = runtimeClient(project);
    try {
      await runtime.previewFormalInput({
        workVersionId: project.workVersionId,
        snapshotId: project.g4SnapshotId,
        readinessId: project.readinessId,
        authorizedTaskId: project.taskId,
      });
      throw new Error("formal preview unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceError);
      expect(error).toMatchObject({
        code: "conflict",
        httpStatus: 409,
        message: "FORMAL_INPUT_COMPLETE_READINESS_REQUIRED",
        retryable: false,
      });
    }
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM formal_input_approval WHERE project_id = $1",
      [project.projectId],
    )).rows[0].count).toBe(0);

    const exploratoryResponse = await call(`/api/v1/projects/${project.projectId}/jobs`, "POST", {
      operation: "implement",
      run_class_intent: "exploratory",
      sources: [{ path: "rtl/top.sv", content: "module top(input logic clk); endmodule\n" }],
      top: "top",
      part: TARGET_PART,
      constraints: [],
    }, "incomplete-exploratory-implement");
    if (exploratoryResponse.status !== 201) {
      throw new Error(`exploratory implement: ${JSON.stringify(exploratoryResponse.json)}`);
    }
    const exploratory = envelopeData(exploratoryResponse.json);
    expect(exploratory.runClass).toBe("exploratory");
    const terminal = await waitForApiJob(project.projectId, exploratory.jobId);
    expect(terminal.state).toBe("succeeded");
    const frozenResponse = await call(
      `/api/v1/projects/${project.projectId}/jobs/${exploratory.jobId}/evidence/freeze`,
      "POST",
      {},
      `freeze-${exploratory.jobId}`,
    );
    if (frozenResponse.status !== 201) {
      throw new Error(`freeze exploratory: ${JSON.stringify(frozenResponse.json)}`);
    }
    expect(envelopeData(frozenResponse.json)).toMatchObject({
      jobId: exploratory.jobId,
      runClass: "exploratory",
      runState: "succeeded",
    });
    const bitstreamsResponse = await call(`/api/v1/projects/${project.projectId}/bitstreams`);
    const bitstreams = envelopeArray(bitstreamsResponse.json);
    expect(bitstreams).toHaveLength(1);
    expect(bitstreams[0]).toMatchObject({
      tool_run_id: exploratory.jobId,
      class: "trial",
      formal_input_approval_id: null,
      readiness_id: null,
    });

    const jobSubmits = workerCalls.filter((entry) => entry.path === "/jobs/submit");
    expect(jobSubmits).toHaveLength(1);
    const payload = jobSubmits[0]!.envelope.payload as {
      request: ExtendedJobRequest;
      approval?: unknown;
    };
    expect(payload.request).toMatchObject({
      jobId: exploratory.jobId,
      projectId: project.projectId,
      operation: "implement",
      runClass: "exploratory",
    });
    expect(payload.request.parameters).toMatchObject({
      jobId: exploratory.jobId,
      projectId: project.projectId,
      operation: "implement",
      runClass: "exploratory",
      inputHash: payload.request.input,
      toolchainHash: TOOLCHAIN_HASH,
    });
    expect(payload.approval).toBeUndefined();
    expect(jobSubmits.some((entry) => (
      entry.envelope.payload as { request: ExtendedJobRequest }
    ).request.runClass === "formal")).toBe(false);
    expect((await harness.client.query(
      "SELECT count(*)::int AS count FROM tool_run WHERE project_id = $1 AND run_class = 'formal'",
      [project.projectId],
    )).rows[0].count).toBe(0);
  }, 30_000);
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; P4 real HTTP tests were not executed", () => {});
}
