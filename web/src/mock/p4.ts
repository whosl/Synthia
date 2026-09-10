import type {
  Artifact,
  ArtifactRevision,
  BitstreamResultV1,
  ChangeRequestV1,
  DeliveryManifestV1,
  DeliveryReleaseContentV1,
  DeliveryReleaseDetailV1,
  EngineeringConfigV1,
  FormalInputApprovalV1,
  FormalInputPreviewV1,
  FormalJobBindingV1,
  FormalOperationV1,
  GateCheckEvaluationV1,
  GateSubmissionDetail,
  JobEvidenceManifest,
  P4GateId,
  ProcessProfileV1,
  ProcessReadinessV1,
  ProjectDetail,
  ProjectReadinessRecord,
  ProjectWorkVersionV1,
  TaskFormalJobStateV1,
  TaskFormalInputState,
} from "../api/types.ts";
import { sha256Bytes } from "../util/sha256.ts";

/**
 * Contract-faithful offline P4 backend.
 *
 * This is intentionally stateful: browser QA must prove that G0 confirmation,
 * formal input, G4 approval, sealed delivery, and change requests survive a
 * full page reload. Production decisions still live in Core; this module only
 * makes the same HTTP contract exercisable in `dev:mock`.
 */

export const MOCK_P4_STATE_STORAGE_KEY = "synthia.mock.p4-state.v1";
const MOCK_P4_STATE_VERSION = 1;
const PROFILE_HASH = "0f503a9bf66e0226f2242cfeb6d42b51d2172afc8dc2584f230e0e03f33f3c5e";
const TOOLCHAIN_PROFILE_HASH = "b43699c293a2d0cbaf0478f8330d0e401a29f9e31f7a845e564607f986e414f4";

export const MOCK_P4_PROFILE: ProcessProfileV1 = {
  schema: "process-profile.v1",
  id: "GJB_REF_V1",
  version: "GJB_REF_V1",
  name: "GJB 参考流程 v1",
  nodes: [
    {
      id: "G0",
      kind: "gate",
      ordinal: 0,
      name: "项目准备",
      goal: "记录项目边界、器件与工具准备状态",
      activities: ["prepare_project"],
      requiredChecks: [
        { code: "project.engineering", severity: "hard" },
        { code: "process.bound", severity: "hard" },
        { code: "data_scope.recorded", severity: "hard" },
        { code: "target_part.recorded", severity: "hard" },
        { code: "board_status.recorded", severity: "hard" },
        { code: "source_materials.recorded", severity: "hard" },
        { code: "workspace.ready", severity: "hard" },
        { code: "toolchain.bound", severity: "hard" },
      ],
      milestoneBaseline: null,
    },
    {
      id: "G1",
      kind: "gate",
      ordinal: 1,
      name: "需求确认",
      goal: "确认需求来源、接口、验收目标与关键风险",
      activities: ["intake"],
      requiredChecks: [
        { code: "artifact.development_requirements", severity: "hard" },
        { code: "snapshot.members_frozen", severity: "hard" },
      ],
      milestoneBaseline: "B0",
    },
    {
      id: "G2",
      kind: "gate",
      ordinal: 2,
      name: "行为与验证方案",
      goal: "确认功能、时序、异常行为及需求对应的验证方法",
      activities: ["behavior_wave", "verification_plan"],
      requiredChecks: [
        { code: "artifact.behavior_spec", severity: "hard" },
        { code: "artifact.verification_method_map", severity: "hard" },
        { code: "snapshot.members_frozen", severity: "hard" },
      ],
      milestoneBaseline: null,
    },
    {
      id: "G3",
      kind: "gate",
      ordinal: 3,
      name: "设计确认",
      goal: "确认架构、接口、寄存器、时钟复位、约束策略与关键边界",
      activities: ["architecture", "register_spec", "constraint_strategy"],
      requiredChecks: [
        { code: "artifact.architecture_design", severity: "hard" },
        { code: "artifact.detailed_design", severity: "hard" },
        { code: "artifact.constraint_design", severity: "hard" },
        { code: "snapshot.members_frozen", severity: "hard" },
      ],
      milestoneBaseline: "B1",
    },
    {
      id: "G4",
      kind: "gate",
      ordinal: 4,
      name: "实现与交付",
      goal: "由同一不可变输入生成、验证并交付可追溯的正式结果",
      activities: ["rtl_build", "validate", "tb", "simulate", "xdc", "implement", "delivery"],
      requiredChecks: [
        { code: "artifact.rtl", severity: "hard" },
        { code: "artifact.testbench", severity: "hard" },
        { code: "artifact.constraints", severity: "hard" },
        { code: "formal_input.confirmed", severity: "hard" },
        { code: "constraints.complete", severity: "hard" },
        { code: "formal_simulation.succeeded", severity: "hard" },
        { code: "formal_implementation.succeeded", severity: "hard" },
        { code: "drc.clean", severity: "hard" },
        { code: "timing.met", severity: "hard" },
        { code: "evidence.frozen", severity: "hard" },
        { code: "bitstream.formal", severity: "hard" },
        { code: "delivery.manifest_sealed", severity: "hard" },
      ],
      milestoneBaseline: "B2",
    },
  ],
  profileHash: PROFILE_HASH,
};

const XDC_CONTENT = [
  "set_property PACKAGE_PIN AB10 [get_ports clk]",
  "set_property IOSTANDARD LVCMOS33 [get_ports clk]",
  "create_clock -period 10.000 -name sys_clk [get_ports clk]",
  "set_property PACKAGE_PIN AC8 [get_ports pwm_out]",
  "set_property IOSTANDARD LVCMOS33 [get_ports pwm_out]",
  "",
].join("\n");

const RELEASE_CONTENT: Readonly<Record<string, { readonly content: string; readonly mediaType: string }>> = {
  "rtl/pwm.sv": {
    content: "module pwm(input logic clk, rst_n, input logic [7:0] duty, output logic pwm_out);\n  logic [7:0] count;\n  always_ff @(posedge clk or negedge rst_n) if (!rst_n) count <= '0; else count <= count + 1'b1;\n  assign pwm_out = count < duty;\nendmodule\n",
    mediaType: "text/plain",
  },
  "tb/pwm_tb.sv": {
    content: "module pwm_tb; initial begin $display(\"formal simulation PASS\"); #100 $finish; end endmodule\n",
    mediaType: "text/plain",
  },
  "prj/constr/top.xdc": { content: XDC_CONTENT, mediaType: "text/plain" },
  "docs/delivery.md": { content: "# Synthia P4 mock delivery\n\nSame immutable input, evidence, and formal bitstream.\n", mediaType: "text/markdown" },
  "results/formal-run.json": { content: "{\"validate\":\"passed\",\"simulate\":\"passed\",\"synthesize\":\"passed\",\"implement\":\"passed\"}\n", mediaType: "application/json" },
  "evidence/implementation.json": { content: "{\"drcErrors\":0,\"worstSlackNs\":0.214,\"routedCheckpoint\":true,\"bitstream\":true}\n", mediaType: "application/json" },
  "confirmations/formal-input.json": { content: "{\"purpose\":\"g4_delivery\",\"confirmedBy\":\"mock-user\"}\n", mediaType: "application/json" },
  "sources/provenance.json": { content: "{\"snapshot\":\"G4\",\"sourcePolicy\":\"confirmed-only\"}\n", mediaType: "application/json" },
  "build/synthia.formal.bit": { content: "SYNTHIA-P4-MOCK-FORMAL-BITSTREAM\u0000v1\n", mediaType: "application/octet-stream" },
};

const CATEGORY_BY_PATH: Readonly<Record<string, DeliveryManifestV1["items"][number]["category"]>> = {
  "rtl/pwm.sv": "rtl",
  "tb/pwm_tb.sv": "tb",
  "prj/constr/top.xdc": "constraint",
  "docs/delivery.md": "document",
  "results/formal-run.json": "run_result",
  "evidence/implementation.json": "raw_evidence",
  "confirmations/formal-input.json": "confirmation",
  "sources/provenance.json": "source",
  "build/synthia.formal.bit": "bitstream",
};

interface StoredOperation {
  readonly requestHash: string;
  readonly status: number;
  readonly data: unknown;
}

interface MockP4ProjectState {
  readonly projectId: string;
  readonly processInstanceId: string;
  currentGate: P4GateId;
  completed: boolean;
  activeWorkVersionId: string;
  currentReadinessId: string | null;
  readinessRows: ProjectReadinessRecord[];
  workVersions: Record<string, ProjectWorkVersionV1>;
  submissions: GateSubmissionDetail[];
  evaluations: Record<string, GateCheckEvaluationV1[]>;
  preview: FormalInputPreviewV1 | null;
  plannedApprovalId: string | null;
  approval: FormalInputApprovalV1 | null;
  approvals: Record<string, FormalInputApprovalV1>;
  formalStatus: TaskFormalInputState["status"] | null;
  formalJobs: Partial<Record<FormalOperationV1, TaskFormalJobStateV1>>;
  bitstreams: BitstreamResultV1[];
  releases: Record<string, DeliveryReleaseDetailV1>;
  manifests: Record<string, DeliveryManifestV1>;
  changeRequests: ChangeRequestV1[];
  operations: Record<string, StoredOperation>;
}

interface StoredEnvelope {
  readonly version: typeof MOCK_P4_STATE_VERSION;
  readonly projects: Record<string, MockP4ProjectState>;
}

let states: Record<string, MockP4ProjectState> = restoreEnvelope()?.projects ?? {};

function digest(value: string): string {
  return sha256Bytes(new TextEncoder().encode(value));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function restoreEnvelope(): StoredEnvelope | null {
  const raw = browserStorage()?.getItem(MOCK_P4_STATE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredEnvelope;
    if (parsed.version !== MOCK_P4_STATE_VERSION || !parsed.projects || typeof parsed.projects !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    browserStorage()?.setItem(MOCK_P4_STATE_STORAGE_KEY, JSON.stringify({ version: MOCK_P4_STATE_VERSION, projects: states }));
  } catch {
    // Browser QA must still be usable if storage is unavailable or full.
  }
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${digest(seed).slice(0, 24)}`;
}

function initialState(project: ProjectDetail): MockP4ProjectState {
  const now = new Date().toISOString();
  const processInstanceId = project.process_instances.find((row) => row.gate_profile_version === "GJB_REF_V1")?.id
    ?? stableId("pi", project.id);
  const workVersionId = stableId("wv", `${project.id}\0initial`);
  return {
    projectId: project.id,
    processInstanceId,
    currentGate: "G0",
    completed: false,
    activeWorkVersionId: workVersionId,
    currentReadinessId: null,
    readinessRows: [],
    workVersions: {
      [workVersionId]: {
        id: workVersionId,
        project_id: project.id,
        process_instance_id: processInstanceId,
        version: 1,
        origin: "initial",
        change_request_id: null,
        base_delivery_release_id: null,
        start_gate: "G0",
        current_gate: "G0",
        state: "working",
        created_at: now,
        released_at: null,
      },
    },
    submissions: [],
    evaluations: {},
    preview: null,
    plannedApprovalId: null,
    approval: null,
    approvals: {},
    formalStatus: null,
    formalJobs: {},
    bitstreams: [],
    releases: {},
    manifests: {},
    changeRequests: [],
    operations: {},
  };
}

function stateFor(project: ProjectDetail): MockP4ProjectState {
  const state = states[project.id] ?? (states[project.id] = initialState(project));
  if (!state.approvals) {
    state.approvals = state.approval ? { [state.approval.id]: state.approval } : {};
  }
  return state;
}

export function resetMockP4State(projectId?: string): void {
  if (projectId) delete states[projectId];
  else states = {};
  persist();
}

export function restorePersistedMockP4State(): boolean {
  const restored = restoreEnvelope();
  if (!restored) return false;
  states = restored.projects;
  return true;
}

export function mockP4WorkspaceManifestHash(projectId: string): string {
  return digest(`workspace-manifest.v1\0${projectId}\0registered`);
}

export function mockP4Artifact(projectId: string): Artifact {
  return {
    id: stableId("art-p4-xdc", projectId),
    artifact_type: "XDC_CANDIDATE",
    created_at: "2026-08-24T00:00:00.000Z",
  };
}

export function mockP4ArtifactRevision(projectId: string): ArtifactRevision {
  return {
    id: stableId("rev-p4-xdc", projectId),
    version: 1,
    state: "approved",
    content_hash: digest(XDC_CONTENT),
    content_location: "prj/constr/top.xdc",
    title: "P4 正式约束候选",
    created_at: "2026-08-24T00:00:00.000Z",
  };
}

export function mockP4ArtifactContent(projectId: string, revisionId: string): string | null {
  return revisionId === mockP4ArtifactRevision(projectId).id ? XDC_CONTENT : null;
}

function processReadiness(row: ProjectReadinessRecord | undefined): ProcessReadinessV1 | null {
  if (!row) return null;
  const confirmed = row.status === "confirmed" && typeof row.confirmed_by === "string" && typeof row.confirmed_at === "string";
  return {
    id: row.id,
    status: confirmed ? "confirmed" : "draft",
    ready: confirmed && row.state === "ready",
    readinessHash: row.readiness_hash ?? row.result_hash ?? digest(row.id),
    targetPart: row.target_part ?? "missing",
    boardRef: row.board_ref ?? "missing",
    workspaceReady: row.workspace_ready === true,
    dataScopeRecorded: row.data_scope_recorded === true,
    sourceMaterialsRecorded: row.source_materials_recorded === true,
    pinConstraintsComplete: row.pin_constraints_complete === true,
    electricalConstraintsComplete: row.electrical_constraints_complete === true,
    clockConstraintsComplete: row.clock_constraints_complete === true,
    constraintsComplete: row.constraints_complete === true,
    toolchainProfileHash: row.toolchain_profile_hash ?? TOOLCHAIN_PROFILE_HASH,
    constraintRevisionIds: row.constraint_revision_ids ?? [],
    generatedBy: { type: "service", id: "mock-core" },
    confirmedBy: confirmed ? { id: row.confirmed_by!, at: row.confirmed_at! } : null,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, correlation_id: `mock-p4-${Date.now().toString(36)}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    error: { code, message, retryable: false, details: null, correlation_id: "mock-p4" },
  }), { status, headers: { "content-type": "application/json" } });
}

function operation(
  state: MockP4ProjectState,
  scope: string,
  key: string | null,
  body: unknown,
  apply: () => { readonly data: unknown; readonly status?: number },
): Response {
  if (!key) return failure(400, "IDEMPOTENCY_KEY_REQUIRED", "P4 写操作必须带 Idempotency-Key");
  const requestHash = digest(canonical(body));
  const existing = state.operations[`${scope}\0${key}`];
  if (existing) {
    return existing.requestHash === requestHash
      ? response(clone(existing.data), existing.status)
      : failure(409, "IDEMPOTENCY_KEY_REUSED", "同一幂等键不能用于不同请求");
  }
  const result = apply();
  const status = result.status ?? 200;
  state.operations[`${scope}\0${key}`] = { requestHash, status, data: clone(result.data) };
  persist();
  return response(result.data, status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function completeConstraints(config: EngineeringConfigV1, projectId: string): boolean {
  const constraintId = mockP4ArtifactRevision(projectId).id;
  return ([config.constraints.pin, config.constraints.electrical, config.constraints.clock] as const)
    .every((constraint) => (
      constraint.state === "complete"
      && constraint.revisionIds.length > 0
      && constraint.revisionIds.every((revisionId) => revisionId === constraintId)
    ));
}

function buildPreview(state: MockP4ProjectState, readiness: ProjectReadinessRecord, taskId: string): FormalInputPreviewV1 {
  const snapshotId = stableId("snap-g4", `${state.projectId}\0${state.activeWorkVersionId}`);
  const inputs = [
    { revision_id: stableId("rev", `${state.projectId}\0constraint`), path: "prj/constr/top.xdc", role: "constraint" },
    { revision_id: stableId("rev", `${state.projectId}\0rtl`), path: "rtl/pwm.sv", role: "rtl" },
    { revision_id: stableId("rev", `${state.projectId}\0tb`), path: "tb/pwm_tb.sv", role: "tb" },
  ].map((file) => {
    const entry = RELEASE_CONTENT[file.path]!;
    const bytes = new TextEncoder().encode(entry.content);
    const sha256 = digest(entry.content);
    return {
      ...file,
      sha256,
      size_bytes: bytes.byteLength,
      storage_uri: `content://sha256/${sha256}`,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const inputHash = digest(canonical({
    schema: "formal-input.v1",
    projectId: state.projectId,
    workVersionId: state.activeWorkVersionId,
    snapshotId,
    readinessId: readiness.id,
    files: inputs,
  }));
  const previewBody = {
    schema: "formal-input-preview.v1" as const,
    work_version_id: state.activeWorkVersionId,
    snapshot_id: snapshotId,
    readiness_id: readiness.id,
    authorized_task_id: taskId,
    prerequisite_baseline_id: stableId("bl-b1", state.activeWorkVersionId),
    target_part: readiness.target_part ?? "missing",
    toolchain_profile_hash: TOOLCHAIN_PROFILE_HASH,
    constraints_complete: true,
    purpose: "g4_delivery" as const,
    allowed_operations: ["implement", "simulate", "synthesize", "validate_sources"],
    files: inputs,
    input_hash: inputHash,
  };
  return { ...previewBody, preview_hash: digest(canonical(previewBody)) };
}

function seedG4(state: MockP4ProjectState, readiness: ProjectReadinessRecord, taskId: string): void {
  const now = new Date().toISOString();
  const work = state.workVersions[state.activeWorkVersionId]!;
  state.currentGate = "G4";
  state.workVersions[state.activeWorkVersionId] = { ...work, current_gate: "G4" };
  const prior = (["G1", "G2", "G3"] as const).map((gate, index): GateSubmissionDetail => ({
    id: stableId(`sub-${gate.toLowerCase()}`, state.activeWorkVersionId),
    project_id: state.projectId,
    work_version_id: state.activeWorkVersionId,
    gate,
    state: "approved",
    snapshot_id: stableId(`snap-${gate.toLowerCase()}`, state.activeWorkVersionId),
    process_instance_id: state.processInstanceId,
    submitter_id: "mock-runtime",
    submitted_at: new Date(Date.now() - (3 - index) * 1_000).toISOString(),
    created_at: new Date(Date.now() - (4 - index) * 1_000).toISOString(),
    check_results: [],
    issues: [],
  }));
  state.preview = buildPreview(state, readiness, taskId);
  state.plannedApprovalId = stableId("fia", `${state.projectId}\0${state.preview.preview_hash}\0${taskId}`);
  state.formalStatus = "awaiting_input_confirmation";
  state.formalJobs = {};
  const g4: GateSubmissionDetail = {
    id: stableId("sub-g4", state.activeWorkVersionId),
    project_id: state.projectId,
    work_version_id: state.activeWorkVersionId,
    gate: "G4",
    state: "checking",
    snapshot_id: state.preview.snapshot_id,
    process_instance_id: state.processInstanceId,
    submitter_id: "mock-runtime",
    submitted_at: null,
    created_at: now,
    check_results: [],
    issues: [],
  };
  state.submissions = [...prior, g4, ...state.submissions.filter((row) => row.gate === "G4" && row.snapshot_id !== g4.snapshot_id)];
}

function releaseItems(state: MockP4ProjectState, releaseId: string): DeliveryManifestV1["items"] {
  return Object.keys(RELEASE_CONTENT).sort().map((path) => {
    const entry = RELEASE_CONTENT[path]!;
    const bytes = new TextEncoder().encode(entry.content);
    return {
      id: stableId("dri", `${releaseId}\0${path}`),
      category: CATEGORY_BY_PATH[path]!,
      path,
      source_type: path.startsWith("build/") ? "bitstream_result" : "sealed_projection",
      source_id: path.startsWith("build/") ? state.bitstreams[0]?.id ?? stableId("bit", releaseId) : releaseId,
      sha256: digest(entry.content),
      size_bytes: bytes.byteLength,
      media_type: entry.mediaType,
    };
  });
}

function candidateManifest(state: MockP4ProjectState, releaseId: string, version: number): DeliveryManifestV1 {
  const body = {
    schema: "delivery-manifest.v1" as const,
    project_id: state.projectId,
    release_id: releaseId,
    version,
    work_version_id: state.activeWorkVersionId,
    input_hash: state.approval?.input_hash ?? state.preview?.input_hash ?? digest("missing-formal-input"),
    items: releaseItems(state, releaseId),
  };
  return { ...body, manifest_hash: digest(canonical(body)) };
}

function completeFormalRuns(state: MockP4ProjectState, approval: FormalInputApprovalV1): void {
  const now = new Date().toISOString();
  const operations: readonly FormalOperationV1[] = ["validate_sources", "simulate", "synthesize", "implement"];
  state.formalJobs = Object.fromEntries(operations.map((operationName) => {
    const jobId = stableId("job", `${state.projectId}\0${approval.id}\0${operationName}`);
    return [operationName, {
      job_id: jobId,
      state: "succeeded",
      evidence_manifest_id: stableId("evm", jobId),
      evidence_manifest_hash: digest(`evidence\0${jobId}\0${approval.input_hash}`),
    }];
  }));
  state.formalStatus = "awaiting_gate_approval";
  const bitstreamContent = RELEASE_CONTENT["build/synthia.formal.bit"]!.content;
  const bitstream: BitstreamResultV1 = {
    id: stableId("bit", `${state.projectId}\0${state.activeWorkVersionId}`),
    project_id: state.projectId,
    work_version_id: state.activeWorkVersionId,
    tool_run_id: state.formalJobs.implement!.job_id,
    class: "formal",
    formal_input_approval_id: approval.id,
    snapshot_id: approval.snapshot_id,
    input_hash: approval.input_hash,
    target_part: approval.target_part,
    sha256: digest(bitstreamContent),
    size_bytes: new TextEncoder().encode(bitstreamContent).byteLength,
    generated_at: now,
  };
  state.bitstreams = [bitstream, ...state.bitstreams.filter((row) => row.work_version_id !== state.activeWorkVersionId)];
  const submission = state.submissions.find((row) => row.gate === "G4" && row.snapshot_id === approval.snapshot_id)!;
  const version = Object.keys(state.releases).length + 1;
  const releaseId = stableId("rel", `${state.projectId}\0${version}\0${state.activeWorkVersionId}`);
  const manifest = candidateManifest(state, releaseId, version);
  const resultHash = digest(canonical(MOCK_P4_PROFILE.nodes.find((node) => node.id === "G4")!.requiredChecks));
  const evaluation: GateCheckEvaluationV1 = {
    id: stableId("eval-g4", state.activeWorkVersionId),
    project_id: state.projectId,
    work_version_id: state.activeWorkVersionId,
    gate_submission_id: submission.id,
    snapshot_id: submission.snapshot_id,
    profile_hash: PROFILE_HASH,
    result_hash: resultHash,
    passed: true,
    sealed_projection_hash: manifest.manifest_hash,
    delivery_release_id: releaseId,
    delivery_release_version: version,
    supersedes_release_id: Object.values(state.releases).sort((a, b) => b.version - a.version)[0]?.id ?? null,
    evaluated_at: now,
    items: MOCK_P4_PROFILE.nodes.find((node) => node.id === "G4")!.requiredChecks.map((check, index) => ({
      id: stableId("gci", `${submission.id}\0${check.code}`),
      check_code: check.code,
      severity: check.severity,
      passed: true,
      details: { verifiedBy: "mock-core", ordinal: index },
      evidence_refs: [{ type: "formal_input_approval", id: approval.id }],
    })),
  };
  state.evaluations[submission.id] = [evaluation];
  const at = state.submissions.indexOf(submission);
  state.submissions[at] = {
    ...submission,
    state: "in_review",
    submitted_at: now,
    check_results: evaluation.items,
  };
  const work = state.workVersions[state.activeWorkVersionId]!;
  state.workVersions[state.activeWorkVersionId] = { ...work, state: "in_review" };
}

function createRelease(state: MockP4ProjectState, evaluation: GateCheckEvaluationV1): DeliveryReleaseDetailV1 {
  const now = new Date().toISOString();
  const manifest = candidateManifest(state, evaluation.delivery_release_id!, evaluation.delivery_release_version!);
  const release: DeliveryReleaseDetailV1 = {
    id: evaluation.delivery_release_id!,
    project_id: state.projectId,
    version: evaluation.delivery_release_version!,
    supersedes_release_id: evaluation.supersedes_release_id,
    work_version_id: state.activeWorkVersionId,
    manifest_hash: manifest.manifest_hash,
    item_count: manifest.items.length,
    state: "sealed",
    confirmed_by: "mock-user",
    released_at: now,
    formal_input_approval_id: state.approval!.id,
    bitstream_result_id: state.bitstreams[0]!.id,
    gate_check_evaluation_id: evaluation.id,
    candidate_manifest_hash: evaluation.sealed_projection_hash!,
    items: manifest.items,
  };
  state.releases[release.id] = release;
  state.manifests[release.id] = manifest;
  state.completed = true;
  state.currentGate = "G4";
  const work = state.workVersions[state.activeWorkVersionId]!;
  state.workVersions[state.activeWorkVersionId] = { ...work, current_gate: "G4", state: "released", released_at: now };
  state.changeRequests = state.changeRequests.map((change) => (
    change.project_work_version_id === state.activeWorkVersionId ? { ...change, state: "released" } : change
  ));
  return release;
}

function evidence(jobId: string): JobEvidenceManifest {
  const content = `{"jobId":"${jobId}","result":"passed"}\n`;
  return {
    jobId,
    entries: [{
      name: "worker-result.json",
      sha256: digest(content),
      sizeBytes: new TextEncoder().encode(content).byteLength,
      mediaType: "application/json",
    }],
  };
}

export interface MockP4TaskOverlay {
  readonly status: string;
  readonly awaitingGate: string | null;
  readonly formalInput: TaskFormalInputState | null;
}

export function mockP4TaskOverlay(project: ProjectDetail): MockP4TaskOverlay | null {
  if (project.process_profile_id !== "GJB_REF_V1") return null;
  const state = stateFor(project);
  const formalInput = state.preview && state.plannedApprovalId && state.formalStatus
    ? {
        status: state.formalStatus,
        approval_id: state.plannedApprovalId,
        preview: state.preview,
        jobs: state.formalJobs,
      } satisfies TaskFormalInputState
    : null;
  const awaiting = state.submissions.some((row) => row.gate === "G4" && row.state === "in_review");
  const awaitingChangedWork = state.changeRequests.some((change) => change.state === "open")
    && state.preview === null;
  return {
    status: state.completed || awaitingChangedWork ? "succeeded" : awaiting ? "awaiting_approval" : "running",
    awaitingGate: awaiting ? "G4" : null,
    formalInput,
  };
}

export interface MockP4RouteInput {
  readonly project: ProjectDetail;
  readonly mainTaskId: string | null;
  readonly rest: readonly string[];
  readonly method: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly searchParams: URLSearchParams;
}

export function routeMockP4(input: MockP4RouteInput): Response | null {
  if (input.project.process_profile_id !== "GJB_REF_V1") return null;
  const { project, rest, method, body, headers, searchParams } = input;
  const state = stateFor(project);
  const key = headers.get("idempotency-key");

  if (rest.length === 1 && rest[0] === "process-state" && method === "GET") {
    const readiness = state.currentReadinessId
      ? processReadiness(state.readinessRows.find((row) => row.id === state.currentReadinessId))
      : null;
    return response({
      schema: "process-state.v1",
      projectId: project.id,
      processInstanceId: state.processInstanceId,
      profileId: "GJB_REF_V1",
      profileHash: PROFILE_HASH,
      workVersionId: state.activeWorkVersionId,
      currentGate: state.currentGate,
      completed: state.completed,
      readiness,
    });
  }

  if (rest[0] === "readiness") {
    if (rest.length === 1 && method === "GET") return response(state.readinessRows);
    if (rest.length === 1 && method === "POST") {
      const request = asRecord(body);
      if (!request || typeof request.id !== "string" || typeof request.work_version_id !== "string") {
        return failure(400, "validation", "readiness 标识和 work version 必填");
      }
      if (request.work_version_id !== state.activeWorkVersionId) return failure(409, "WORK_VERSION_INACTIVE", "工作版本不是 Core 当前 active 版本");
      const config = request.engineering_config as EngineeringConfigV1 | undefined;
      if (!config || config.schema !== "engineering-config.v1") return failure(400, "validation", "engineering_config.v1 必填");
      const expectedManifest = mockP4WorkspaceManifestHash(project.id);
      const workspaceCommit = typeof request.workspace_expected_commit === "string" ? request.workspace_expected_commit : "";
      const workspaceReady = request.workspace_manifest_hash === expectedManifest && workspaceCommit.length > 0;
      const constraintsComplete = completeConstraints(config, project.id);
      const sourceIds = Array.isArray(request.source_snapshot_ids) ? request.source_snapshot_ids.filter((value): value is string => typeof value === "string") : [];
      const checks = [
        ["G0_PROFILE_BOUND", true],
        ["G0_SCOPE_RECORDED", Boolean(config.dataScope.description)],
        ["G0_ENGINEERING_CONFIG_RECORDED", true],
        ["G0_SOURCES_RECORDED", Array.isArray(request.source_snapshot_ids)],
        ["G0_WORKSPACE_READY", workspaceReady],
      ] as const;
      const row: ProjectReadinessRecord = {
        id: request.id,
        project_id: project.id,
        process_instance_id: state.processInstanceId,
        process_version_id: "GJB_REF_V1",
        profile_definition_hash: PROFILE_HASH,
        work_version_id: state.activeWorkVersionId,
        sequence: state.readinessRows.length + 1,
        supersedes_readiness_id: state.readinessRows[0]?.id ?? null,
        engineering_config: config,
        engineering_config_hash: digest(canonical(config)),
        source_snapshot_ids: sourceIds,
        workspace_commit: workspaceCommit,
        workspace_manifest_hash: expectedManifest,
        check_results: checks.map(([code, passed]) => ({ code, severity: "hard", passed, details: {} })),
        checks: checks.map(([code, passed]) => ({ code, severity: "hard", passed, details: {} })),
        state: checks.every(([, passed]) => passed) ? "ready" : "blocked",
        status: "draft",
        ready: false,
        constraints_complete: constraintsComplete,
        target_part: config.targetPart.value,
        board_ref: config.board.ref,
        workspace_ready: workspaceReady,
        data_scope_recorded: Boolean(config.dataScope.description),
        source_materials_recorded: true,
        pin_constraints_complete: config.constraints.pin.state === "complete" && config.constraints.pin.revisionIds.length > 0,
        electrical_constraints_complete: config.constraints.electrical.state === "complete" && config.constraints.electrical.revisionIds.length > 0,
        clock_constraints_complete: config.constraints.clock.state === "complete" && config.constraints.clock.revisionIds.length > 0,
        constraint_revision_ids: [...new Set([
          ...config.constraints.pin.revisionIds,
          ...config.constraints.electrical.revisionIds,
          ...config.constraints.clock.revisionIds,
        ])],
        toolchain_profile_hash: TOOLCHAIN_PROFILE_HASH,
        confirmed_by: null,
        confirmed_at: null,
        result_hash: digest(canonical(checks)),
        readiness_hash: digest(canonical({ config, sourceIds, expectedManifest, checks })),
        created_at: new Date().toISOString(),
      };
      return operation(state, "create-readiness", key, body, () => {
        if (state.readinessRows.some((candidate) => candidate.id === row.id)) throw new Error("duplicate readiness id");
        state.readinessRows.unshift(row);
        return { data: row, status: 201 };
      });
    }
    if (rest.length === 3 && rest[2] === "confirm" && method === "POST") {
      const row = state.readinessRows.find((candidate) => candidate.id === rest[1]);
      if (!row) return failure(404, "not_found", "readiness 不存在");
      if (row.state !== "ready") return failure(409, "READINESS_BLOCKED", "hard checks 未通过");
      const request = asRecord(body);
      if (!request || typeof request.reason !== "string" || !request.reason.trim()) return failure(400, "validation", "确认理由必填");
      return operation(state, `confirm-readiness:${row.id}`, key, body, () => {
        const now = new Date().toISOString();
        const confirmed: ProjectReadinessRecord = {
          ...row,
          status: "confirmed",
          ready: true,
          confirmed_by: "mock-user",
          confirmed_at: now,
        };
        state.readinessRows[state.readinessRows.indexOf(row)] = confirmed;
        state.currentReadinessId = confirmed.id;
        state.currentGate = "G1";
        const work = state.workVersions[state.activeWorkVersionId]!;
        state.workVersions[state.activeWorkVersionId] = { ...work, current_gate: "G1" };
        if (confirmed.constraints_complete && input.mainTaskId) seedG4(state, confirmed, input.mainTaskId);
        return { data: confirmed };
      });
    }
    return null;
  }

  if (rest[0] === "formal-input-approvals") {
    if (rest.length === 2 && rest[1] === "preview" && method === "POST") {
      if (!state.preview) return failure(409, "FORMAL_INPUT_G4_REQUIRED", "G4 不可预览");
      const request = asRecord(body);
      if (!request
        || request.work_version_id !== state.preview.work_version_id
        || request.snapshot_id !== state.preview.snapshot_id
        || request.readiness_id !== state.preview.readiness_id
        || request.authorized_task_id !== state.preview.authorized_task_id) {
        return failure(409, "FORMAL_INPUT_BINDING_MISMATCH", "预览绑定与 Core 当前事实不一致");
      }
      return operation(state, "preview-formal-input", key, body, () => ({ data: state.preview! }));
    }
    if (rest.length === 1 && method === "POST") {
      if (!state.preview || !state.plannedApprovalId) return failure(409, "FORMAL_INPUT_PREVIEW_REQUIRED", "请先生成正式输入预览");
      const request = asRecord(body);
      if (!request
        || request.id !== state.plannedApprovalId
        || request.preview_hash !== state.preview.preview_hash
        || request.work_version_id !== state.preview.work_version_id
        || request.snapshot_id !== state.preview.snapshot_id
        || request.readiness_id !== state.preview.readiness_id
        || request.authorized_task_id !== state.preview.authorized_task_id
        || request.purpose !== "g4_delivery") {
        return failure(409, "FORMAL_INPUT_PREVIEW_CHANGED", "正式输入事实已经变化");
      }
      return operation(state, "confirm-formal-input", key, body, () => {
        const approval: FormalInputApprovalV1 = {
          ...state.preview!,
          id: state.plannedApprovalId!,
          confirmed_by: "mock-user",
          confirmed_at: new Date().toISOString(),
        };
        state.approval = approval;
        state.approvals[approval.id] = approval;
        completeFormalRuns(state, approval);
        return { data: approval, status: 201 };
      });
    }
    if (rest.length === 2 && method === "GET") {
      return state.approvals[rest[1]!]
        ? response(state.approvals[rest[1]!]!)
        : failure(404, "not_found", "formal input approval 不存在");
    }
    return null;
  }

  if (rest[0] === "jobs") {
    if (rest.length === 1 && method === "GET") {
      return response(Object.entries(state.formalJobs).map(([operationName, job]) => ({
        id: job!.job_id,
        operation: operationName,
        runClass: "formal",
        state: job!.state,
        startTime: null,
        endTime: null,
      })));
    }
    if (rest.length === 1 && method === "POST") {
      const request = asRecord(body);
      const operationName = request?.operation as FormalOperationV1 | undefined;
      if (!state.approval || request?.formal_input_approval_id !== state.approval.id || !operationName || !state.formalJobs[operationName]) {
        return failure(409, "FORMAL_JOB_BINDING_MISMATCH", "formal job 必须绑定当前确认输入");
      }
      const job = state.formalJobs[operationName]!;
      const binding: FormalJobBindingV1 = {
        jobId: job.job_id,
        state: job.state,
        operation: operationName,
        runClass: "formal",
        formalInputApprovalId: state.approval.id,
        inputSnapshotId: state.approval.snapshot_id,
        inputHash: state.approval.input_hash,
        toolchainProfileHash: state.approval.toolchain_profile_hash,
      };
      return operation(state, `formal-job:${operationName}`, key, body, () => ({ data: binding, status: 201 }));
    }
    if (rest.length >= 3 && rest[2] === "evidence") {
      const known = Object.values(state.formalJobs).some((job) => job?.job_id === rest[1]);
      if (!known) return null;
      if (rest.length === 4 && rest[3] === "freeze" && method === "POST") {
        return operation(state, `freeze-evidence:${rest[1]}`, key, body, () => ({ data: evidence(rest[1]!) }));
      }
      if (rest.length === 3 && method === "GET") return response(evidence(rest[1]!));
      if (rest.length === 4 && rest[3] === "content" && method === "GET") {
        const content = `{"jobId":"${rest[1]}","result":"passed"}\n`;
        return response({
          name: "worker-result.json",
          content,
          sha256: digest(content),
          truncated: false,
          mediaType: "application/json",
        });
      }
    }
    return null;
  }

  if (rest.length === 1 && rest[0] === "bitstreams" && method === "GET") return response(state.bitstreams);

  if (rest[0] === "gate-submissions") {
    if (rest.length === 1 && method === "GET") {
      const requestedState = searchParams.get("state");
      return response(requestedState ? state.submissions.filter((row) => row.state === requestedState) : state.submissions);
    }
    const submission = state.submissions.find((row) => row.id === rest[1]);
    if (!submission) return failure(404, "not_found", "gate submission 不存在");
    if (rest.length === 2 && method === "GET") return response(submission);
    if (rest.length === 3 && rest[2] === "evaluations" && method === "GET") return response(state.evaluations[submission.id] ?? []);
    if (rest.length === 3 && rest[2] === "approve" && method === "POST") {
      const evaluation = state.evaluations[submission.id]?.[0];
      const request = asRecord(body);
      if (submission.state !== "in_review" || !evaluation || !request
        || request.gate_check_evaluation_id !== evaluation.id
        || request.check_results_hash !== evaluation.result_hash
        || request.candidate_manifest_hash !== evaluation.sealed_projection_hash
        || request.delivery_release_id !== evaluation.delivery_release_id) {
        return failure(409, "GATE_APPROVAL_BINDING_MISMATCH", "批准事实与 sealed G4 evaluation 不一致");
      }
      return operation(state, `approve-gate:${submission.id}`, key, body, () => {
        const release = createRelease(state, evaluation);
        const at = state.submissions.indexOf(submission);
        state.submissions[at] = { ...submission, state: "approved" };
        return { data: { approved: true, release, baseline_id: request.baseline_id }, status: 201 };
      });
    }
    if (rest.length === 3 && rest[2] === "reject" && method === "POST") {
      const request = asRecord(body);
      if (submission.state !== "in_review" || typeof request?.reason !== "string" || !request.reason.trim()) {
        return failure(409, "GATE_REJECTION_INVALID", "只能用非空理由驳回待审提交");
      }
      return operation(state, `reject-gate:${submission.id}`, key, body, () => {
        const at = state.submissions.indexOf(submission);
        state.submissions[at] = { ...submission, state: "rejected", issues: [request.reason as string] };
        return { data: { rejected: true } };
      });
    }
    return null;
  }

  if (rest[0] === "delivery-releases") {
    const releases = Object.values(state.releases).sort((left, right) => right.version - left.version);
    if (rest.length === 1 && method === "GET") {
      return response(releases.map(({ items: _items, formal_input_approval_id: _fia, bitstream_result_id: _bit, gate_check_evaluation_id: _evaluation, candidate_manifest_hash: _candidate, ...summary }) => summary));
    }
    const release = state.releases[rest[1]!];
    if (!release) return failure(404, "not_found", "delivery release 不存在");
    if (rest.length === 2 && method === "GET") return response(release);
    if (rest.length === 3 && rest[2] === "manifest" && method === "GET") return response(state.manifests[release.id]);
    if (rest.length === 3 && rest[2] === "content" && method === "GET") {
      const path = searchParams.get("path") ?? "";
      const item = release.items.find((candidate) => candidate.path === path);
      const stored = RELEASE_CONTENT[path];
      if (!item || !stored) return failure(404, "not_found", "密封交付条目不存在");
      const content: DeliveryReleaseContentV1 = {
        path,
        content: stored.content,
        encoding: "utf8",
        media_type: stored.mediaType,
        sha256: item.sha256,
        file_name: path.split("/").at(-1) ?? "delivery-item",
      };
      return response(content);
    }
    return null;
  }

  if (rest[0] === "change-requests") {
    if (rest.length === 1 && method === "GET") return response(state.changeRequests);
    if (rest.length === 1 && method === "POST") {
      const request = asRecord(body);
      const latestRelease = Object.values(state.releases).sort((left, right) => right.version - left.version)[0];
      const impactGate = request?.impact_gate as P4GateId | undefined;
      if (!latestRelease || !request || typeof request.id !== "string" || typeof request.work_version_id !== "string"
        || request.base_delivery_release_id !== latestRelease.id || !impactGate || impactGate === "G0"
        || typeof request.reason !== "string" || !request.reason.trim() || !Array.isArray(request.affected_paths)
        || state.changeRequests.some((change) => change.state === "open")) {
        return failure(409, "CHANGE_REQUEST_INVALID", "变更必须基于最新 release，且项目不能已有进行中变更");
      }
      return operation(state, "create-change-request", key, body, () => {
        const now = new Date().toISOString();
        const workVersion: ProjectWorkVersionV1 = {
          id: request.work_version_id as string,
          project_id: project.id,
          process_instance_id: state.processInstanceId,
          version: latestRelease.version + 1,
          origin: "change_request",
          change_request_id: request.id as string,
          base_delivery_release_id: latestRelease.id,
          start_gate: impactGate,
          current_gate: impactGate,
          state: "working",
          created_at: now,
          released_at: null,
        };
        const change: ChangeRequestV1 = {
          id: request.id as string,
          project_id: project.id,
          base_delivery_release_id: latestRelease.id,
          project_work_version_id: workVersion.id,
          reason: request.reason as string,
          affected_paths: (request.affected_paths as unknown[]).filter((path): path is string => typeof path === "string"),
          impact_gate: impactGate as Exclude<P4GateId, "G0">,
          state: "open",
          confirmed_by: "mock-user",
          confirmed_at: now,
        };
        state.workVersions[workVersion.id] = workVersion;
        state.activeWorkVersionId = workVersion.id;
        state.currentGate = impactGate;
        state.completed = false;
        state.currentReadinessId = null;
        state.preview = null;
        state.plannedApprovalId = null;
        state.approval = null;
        state.formalStatus = null;
        state.formalJobs = {};
        state.changeRequests.unshift(change);
        return { data: change, status: 201 };
      });
    }
    if (rest.length === 3 && rest[2] === "withdraw" && method === "POST") {
      const change = state.changeRequests.find((candidate) => candidate.id === rest[1]);
      if (!change || change.state !== "open") return failure(409, "CHANGE_REQUEST_NOT_OPEN", "只有进行中的变更可以撤回");
      return operation(state, `withdraw-change-request:${change.id}`, key, body, () => {
        const at = state.changeRequests.indexOf(change);
        const withdrawn: ChangeRequestV1 = { ...change, state: "withdrawn" };
        state.changeRequests[at] = withdrawn;
        const work = state.workVersions[change.project_work_version_id]!;
        state.workVersions[work.id] = { ...work, state: "abandoned" };
        const latestRelease = Object.values(state.releases).sort((left, right) => right.version - left.version)[0]!;
        state.activeWorkVersionId = latestRelease.work_version_id;
        state.currentGate = "G4";
        state.completed = true;
        state.currentReadinessId = state.readinessRows.find((row) => row.work_version_id === latestRelease.work_version_id && row.status === "confirmed")?.id ?? null;
        return { data: withdrawn };
      });
    }
    return null;
  }

  if (rest.length === 2 && rest[0] === "work-versions" && method === "GET") {
    return state.workVersions[rest[1]!]
      ? response(state.workVersions[rest[1]!]!)
      : failure(404, "not_found", "work version 不存在");
  }

  if (rest.length === 1 && rest[0] === "events" && method === "GET") {
    const snapshotId = searchParams.get("aggregate_id");
    const submission = state.submissions.find((row) => row.snapshot_id === snapshotId);
    return response(submission ? [{
      event_type: "snapshot.created",
      payload: {
        id: submission.snapshot_id,
        projectId: project.id,
        manifestHash: digest(`snapshot\0${submission.snapshot_id}`),
        memberRevisionIds: state.preview?.files.map((file) => file.revision_id) ?? [],
      },
    }] : []);
  }

  return null;
}
