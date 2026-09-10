import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createServerConfig,
  createEnvDepsFactory,
  RuntimeServer,
  serializeTaskFormalInput,
  type ServerConfig,
  type DepsFactory,
  type RuntimeMessageIdempotencyStore,
  type ServerStatus,
} from "./server.ts";
import { CounterScriptedModel } from "./deps.ts";
import { FakeVivadoConnector, successBehavior, alwaysFailBehavior } from "./loop.ts";
import { CoreGovernanceClient, MockGovernanceClient } from "./governance-client.ts";
import { CoreApiConnector } from "./core-api-connector.ts";
import { NoGovernanceClient } from "./types.ts";
import {
  createAgentState,
  saveAgentState,
  loadAgentState,
  deleteAgent,
  loadMessageIdempotencyRecords,
  saveMessageIdempotencyRecords,
} from "./agent-state.ts";
import type { SkillPrompts } from "./skill-loader.ts";
import type { AgentMessage, AgentTool, ChatTurn, ConversationalModel, FreeAgentSession } from "./agent-types.ts";
import type { ImportedMaterialSummary, ProcessStateV1, ProjectInfo } from "./types.ts";
import {
  type EvaluatedGateSubmissionV1,
  type GateEvaluationV1,
  type ProjectReadinessRecordV1,
} from "./formal-flow.ts";
import {
  CoreTaskWorkspaceClient,
  type TaskAuthorizationScope,
  type TaskConversationClient,
  type TaskWorkspaceClient,
} from "./task-workspace-client.ts";
import type { GateId, GateSubmissionState } from "../core/src/domain/enums.ts";
import { sha256Hex } from "../core/src/hashing.ts";
import { GJB_REF_V1_PROFILE } from "../core/src/services/process-profile.ts";

// ---------------------------------------------------------------------------
// Test governance — defaults to in_review so the monitor doesn't prematurely
// auto-resume before the test explicitly approves a gate.
// ---------------------------------------------------------------------------

class TestGovernance extends MockGovernanceClient {
  private defaultPollState: GateSubmissionState = "in_review";

  setDefaultPollState(state: GateSubmissionState): void {
    this.defaultPollState = state;
  }

  override async getGateSubmissionState(
    submissionId: string,
  ): Promise<{ state: GateSubmissionState }> {
    this.polledGates.push(submissionId);
    const state = this.gateStates.get(submissionId) ?? this.defaultPollState;
    return { state };
  }
}

class ProjectInfoGovernance extends TestGovernance {
  readProjectInfoCount = 0;

  constructor(protected readonly info: ProjectInfo) {
    super();
  }

  override async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    this.readProjectInfoCount++;
    return { ...this.info, id: projectId };
  }
}

/**
 * Keeps the pre-project-model server tests on their original compatibility
 * path. Extending NoGovernanceClient deliberately makes Runtime skip the Core
 * project-fact read, while these overrides retain human gate behavior.
 */
class LegacyGateGovernance extends NoGovernanceClient {
  readonly submissions: Array<{
    submissionId: string;
    processInstanceId: string;
    gate: GateId;
    snapshotId: string;
  }> = [];
  readonly polledGates: string[] = [];
  private readonly gateStates = new Map<string, GateSubmissionState>();
  private defaultPollState: GateSubmissionState = "in_review";
  private submitResultState: GateSubmissionState = "in_review";

  setSubmitResult(state: GateSubmissionState): void {
    this.submitResultState = state;
  }

  setGateState(submissionId: string, state: GateSubmissionState): void {
    this.gateStates.set(submissionId, state);
  }

  override async createGateSubmission(input: {
    processInstanceId: string;
    gate: GateId;
    snapshotId: string;
  }): Promise<{ submissionId: string }> {
    const submissionId = `sub-legacy-${crypto.randomUUID()}`;
    this.submissions.push({ submissionId, ...input });
    return { submissionId };
  }

  override async submitGate(): Promise<{ state: GateSubmissionState }> {
    return { state: this.submitResultState };
  }

  override async getGateSubmissionState(
    submissionId: string,
  ): Promise<{ state: GateSubmissionState }> {
    this.polledGates.push(submissionId);
    return { state: this.gateStates.get(submissionId) ?? this.defaultPollState };
  }
}

/** Minimal real-profile fixture for server tests that stop at evaluated G1. */
class EarlyGateProjectInfoGovernance extends ProjectInfoGovernance {
  private activeProjectId = "";

  constructor(info: ProjectInfo, private readonly expectedProcessInstanceId: string) {
    super(info);
  }

  override async getProcessState(projectId: string): Promise<ProcessStateV1> {
    this.activeProjectId = projectId;
    return {
      schema: "process-state.v1",
      projectId,
      processInstanceId: this.expectedProcessInstanceId,
      workVersionId: `wv-${projectId}`,
      profileId: "GJB_REF_V1",
      profileHash: GJB_REF_V1_PROFILE.profileHash,
      currentGate: "G0",
      completed: false,
      readiness: {
        id: `ready-${projectId}`,
        status: "confirmed",
        ready: true,
        readinessHash: sha256Hex(`readiness:${projectId}`),
        targetPart: this.info.targetPart ?? "unassigned",
        boardRef: "unassigned",
        workspaceReady: true,
        dataScopeRecorded: true,
        sourceMaterialsRecorded: true,
        pinConstraintsComplete: false,
        electricalConstraintsComplete: false,
        clockConstraintsComplete: false,
        constraintsComplete: false,
        toolchainProfileHash: sha256Hex("toolchain:test"),
        constraintRevisionIds: [],
        generatedBy: { type: "runtime-test", id: "fixture" },
        confirmedBy: { id: "test-user", at: "2026-08-24T00:00:00.000Z" },
      },
    };
  }

  async listReadiness(): Promise<readonly ProjectReadinessRecordV1[]> {
    const projectId = this.activeProjectId;
    if (!projectId) throw new Error("process state must be read before readiness");
    return [{
      id: `ready-${projectId}`,
      projectId,
      processInstanceId: this.expectedProcessInstanceId,
      workVersionId: `wv-${projectId}`,
      status: "confirmed",
      state: "ready",
      ready: true,
      readinessHash: sha256Hex(`readiness:${projectId}`),
      resultHash: sha256Hex(`readiness-result:${projectId}`),
      engineeringConfig: {},
      engineeringConfigHash: sha256Hex(`engineering-config:${projectId}`),
      targetPart: this.info.targetPart ?? "unassigned",
      boardRef: "unassigned",
      workspaceReady: true,
      dataScopeRecorded: true,
      sourceMaterialsRecorded: true,
      pinConstraintsComplete: false,
      electricalConstraintsComplete: false,
      clockConstraintsComplete: false,
      constraintsComplete: false,
      constraintRevisionIds: [],
      toolchainProfileHash: sha256Hex("toolchain:test"),
      generatedByType: "runtime-test",
      generatedBy: "fixture",
      generatedAt: "2026-08-24T00:00:00.000Z",
      confirmedBy: "test-user",
      confirmedAt: "2026-08-24T00:00:00.000Z",
      checks: [{ code: "workspace.ready", severity: "hard", passed: true, details: {} }],
    }];
  }

  async createGateEvaluation(input: {
    submissionId: string;
    evaluationId: string;
    workVersionId: string;
    expectedSnapshotManifestHash: string;
  }): Promise<GateEvaluationV1> {
    const submission = this.submissions.find((row) => row.submissionId === input.submissionId);
    if (!submission) throw new Error(`missing submission ${input.submissionId}`);
    return {
      id: input.evaluationId,
      projectId: this.activeProjectId,
      gateSubmissionId: input.submissionId,
      workVersionId: input.workVersionId,
      snapshotId: submission.snapshotId,
      snapshotManifestHash: input.expectedSnapshotManifestHash,
      profileHash: GJB_REF_V1_PROFILE.profileHash,
      resultHash: sha256Hex(`evaluation:${input.evaluationId}`),
      passed: true,
      sealedProjectionHash: null,
      deliveryReleaseId: null,
      deliveryReleaseVersion: null,
      supersedesReleaseId: null,
      evaluatedAt: "2026-08-24T00:00:00.000Z",
      items: [{
        id: `item-${input.evaluationId}`,
        checkCode: "snapshot.members_frozen",
        severity: "hard",
        passed: true,
        details: {},
        evidenceRefs: [],
      }],
    };
  }

  async submitEvaluatedGate(input: {
    submissionId: string;
    evaluationId: string;
    resultHash: string;
  }): Promise<EvaluatedGateSubmissionV1> {
    const submission = this.submissions.find((row) => row.submissionId === input.submissionId);
    if (!submission || !["G1", "G2", "G3"].includes(submission.gate)) {
      throw new Error(`missing early-gate submission ${input.submissionId}`);
    }
    const { state } = await this.submitGate(input.submissionId);
    return {
      id: input.submissionId,
      projectId: this.activeProjectId,
      gate: submission.gate as "G1" | "G2" | "G3",
      state: state === "approved" ? "approved" : "in_review",
      gateCheckEvaluationId: input.evaluationId,
      checkResultsHash: input.resultHash,
    };
  }

  async previewFormalInput(): Promise<never> { throw new Error("G4 is not reached by this fixture"); }
  async getFormalInputApproval(): Promise<never> { throw new Error("G4 is not reached by this fixture"); }
  async submitFormalJob(): Promise<never> { throw new Error("G4 is not reached by this fixture"); }
  async getFormalJob(): Promise<never> { throw new Error("G4 is not reached by this fixture"); }
  async freezeFormalEvidence(): Promise<never> { throw new Error("G4 is not reached by this fixture"); }
  async getFormalEvidence(): Promise<never> { throw new Error("G4 is not reached by this fixture"); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_PROMPTS: SkillPrompts = {
  rtl: "", tb: "", xdc: "", repair: "",
  intake: "", behaviorWave: "", architecture: "", registerSpec: "",
};

const PROCESS_FACT_CASES = [
  "processVersionId",
  "processProfileId",
  "processProfileVersion",
  "processProfileName",
] as const;

function projectInfo(overrides: Partial<ProjectInfo>): ProjectInfo {
  return {
    id: "p",
    name: "Project",
    status: "active",
    scope: "",
    dataClassification: "D1",
    targetPart: null,
    standardVersion: "",
    processInstances: [],
    ...overrides,
  };
}

function makeConfig(opts: Partial<ServerConfig> = {}): ServerConfig {
  return {
    skillPrompts: EMPTY_PROMPTS,
    toolModelPolicyHash: sha256Hex("test-policy-v1"),
    defaultPart: "xc7k70tfbv676-1",
    gatePollMs: 50,
    port: 0,
    ...opts,
  };
}

function makeFactory(
  model: unknown,
  connector: unknown,
  governance: unknown,
): DepsFactory {
  return async () => ({ model, connector, governance } as any);
}

const SIDE_TASK_AUTHORIZATION: TaskAuthorizationScope = {
  schema: "task-scope.v1",
  workspace: "isolated",
  read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  write_paths: ["rtl/side-counter.v"],
  run_classes: ["exploratory"],
  can_submit_gates: false,
  can_create_milestones: false,
  can_start_formal_runs: false,
};

const MAIN_TASK_AUTHORIZATION: TaskAuthorizationScope = {
  schema: "task-scope.v1",
  workspace: "project",
  read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  write_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
  run_classes: ["exploratory", "gate_check", "formal"],
  can_submit_gates: true,
  can_create_milestones: true,
  can_start_formal_runs: true,
};

function taskWorkspaceFixture(
  projectId: string,
  taskId: string,
  workspaceId: string,
): TaskWorkspaceClient {
  return {
    projectId,
    taskId,
    workspaceId,
    async listTree() { return []; },
    async readFile() { throw new Error("not used by task creation tests"); },
    async writeFiles() { throw new Error("not used by task creation tests"); },
    async appendEvent(input) {
      return { taskId, eventId: input.eventId, sequence: 1, replayed: false };
    },
    async finalizeResult(input) {
      return {
        resultId: "result-test",
        taskId,
        workspaceId,
        summary: input.summary,
        outputHash: "f".repeat(64),
      };
    },
  };
}

class RecordingConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    return { kind: "text", content: "ok" };
  }
}

class FailOnceConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    if (this.calls.length === 1) throw new Error("temporary model outage");
    return { kind: "text", content: "recovered on the same project agent" };
  }
}

class ToolThenTextConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];
  readonly fullArgument = "x".repeat(3_000);

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    if (this.calls.length === 1) {
      return {
        kind: "tool_calls",
        calls: [{
          toolCallId: "call-side-complete",
          name: "synthia_complete_side_task",
          args: { fullArgument: this.fullArgument },
        }],
        content: null,
      };
    }
    return { kind: "text", content: "ok" };
  }
}

class RecordingLoopModel extends CounterScriptedModel {
  readonly intakeTasks: string[] = [];

  override async generateIntake(task: string) {
    this.intakeTasks.push(task);
    return super.generateIntake(task);
  }
}

class AwaitThenCompleteConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    if (this.calls.length === 1) {
      return { kind: "text", content: "choose option A or B" };
    }
    if (this.calls.length === 2) {
      return {
        kind: "tool_calls",
        calls: [{
          toolCallId: "call-side-complete-after-user",
          name: "synthia_complete_side_task",
          args: {},
        }],
        content: null,
      };
    }
    return { kind: "text", content: "selected option applied" };
  }
}

class BlockingConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    this.started.resolve();
    await this.release.promise;
    return { kind: "text", content: "ok" };
  }
}

class FirstReplyThenBlockingConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];
  readonly followUpStarted = Promise.withResolvers<void>();
  readonly releaseFollowUp = Promise.withResolvers<void>();

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    if (this.calls.length === 1) {
      return { kind: "text", content: "send the follow-up choice" };
    }
    this.followUpStarted.resolve();
    await this.releaseFollowUp.promise;
    return { kind: "text", content: "follow-up applied" };
  }
}

async function saveSessionFixture(
  project: ProjectInfo,
  executionMode: "free" | "engineering",
): Promise<string> {
  const agentId = `agent-server-session-${crypto.randomUUID()}`;
  await saveAgentState(createAgentState({
    agentId,
    task: "historical material feature test",
    part: project.targetPart ?? "",
    projectId: project.id,
    processInstanceId: executionMode === "free" ? `free:${project.id}` : `pi:${project.id}`,
    ...(project.projectType ? { projectType: project.projectType } : {}),
    ...(project.processVersionId !== undefined ? { processVersionId: project.processVersionId } : {}),
    ...(project.processProfileId !== undefined ? { processProfileId: project.processProfileId } : {}),
    ...(project.processProfileName !== undefined ? { processProfileName: project.processProfileName } : {}),
    ...(project.processProfileVersion !== undefined ? { processProfileVersion: project.processProfileVersion } : {}),
    executionMode,
  }));
  createdAgentIds.push(agentId);
  return agentId;
}

function confirmedMaterial(projectId: string, content: string): ImportedMaterialSummary {
  return {
    snapshotId: "imp-runtime-flag",
    fileId: "file-runtime-flag",
    projectId,
    path: "docs/confirmed-reference.md",
    content,
    contentHash: sha256Hex(content),
    status: "confirmed",
    valid: true,
    searchable: true,
  };
}

async function postTask(
  server: RuntimeServer,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${server.url}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const json = await res.json() as { agent_id: string };
  return json.agent_id;
}

async function postTaskRaw(
  server: RuntimeServer,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server.url}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json() as Record<string, unknown>,
  };
}

async function getTask(
  server: RuntimeServer,
  agentId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.url}/tasks/${agentId}`);
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

async function waitForStatus(
  server: RuntimeServer,
  agentId: string,
  statuses: ServerStatus[],
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const body = await getTask(server, agentId);
    lastBody = body;
    if (statuses.includes(body.status as ServerStatus)) return body;
    await Bun.sleep(30);
  }
  throw new Error(
    `timeout waiting for status ${statuses.join("|")} (agent ${agentId}); ` +
      `last status=${String(lastBody?.status)} reason=${String(lastBody?.reason ?? "")}`,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let agentsDir: string;
const createdAgentIds: string[] = [];

beforeEach(async () => {
  agentsDir = await mkdtemp(join(tmpdir(), "synthia-runtime-test-"));
  process.env.SYNTHIA_RUNS_DIR = agentsDir;
});

afterEach(async () => {
  for (const agentId of createdAgentIds) {
    await deleteAgent(agentId).catch(() => {});
  }
  createdAgentIds.length = 0;
  delete process.env.SYNTHIA_RUNS_DIR;
  await rm(agentsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RuntimeServer — historical-material feature configuration", () => {
  test("defaults off and accepts only explicit false values", async () => {
    expect((await createServerConfig({})).historicalMaterialsEnabled).toBe(false);
    expect((await createServerConfig({ SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "0" })).historicalMaterialsEnabled).toBe(false);
    expect((await createServerConfig({ SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "false" })).historicalMaterialsEnabled).toBe(false);
  });

  test("accepts only explicit true values", async () => {
    expect((await createServerConfig({ SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "1" })).historicalMaterialsEnabled).toBe(true);
    expect((await createServerConfig({ SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "true" })).historicalMaterialsEnabled).toBe(true);
  });

  test("rejects ambiguous feature values instead of silently enabling", async () => {
    await expect(createServerConfig({
      SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "TRUE",
    })).rejects.toThrow("SYNTHIA_FEATURE_HISTORICAL_MATERIALS must be exactly one of");
  });
});

describe("RuntimeServer — separated Core capabilities", () => {
  const modelEnv = {
    SYNTHIA_RUNTIME_MODE: "core",
    SYNTHIA_MODEL_URL: "http://model.local/v1",
    SYNTHIA_MODEL_KEY: "model-key",
    SYNTHIA_MODEL_NAME: "model",
    SYNTHIA_CORE_URL: "http://core.local",
  } as const;

  test("side dependencies require only the task token and construct no Core governance client", async () => {
    const factory = createEnvDepsFactory({
      ...modelEnv,
      SYNTHIA_TASK_RUNTIME_TOKEN: "task-runtime-token",
    });
    const deps = await factory({
      projectId: "p-side-capability",
      processInstanceId: "free:p-side-capability",
      projectType: "free",
      taskId: "task-side-capability",
      taskKind: "side",
      workspaceId: "ws-side-capability",
      authorization: SIDE_TASK_AUTHORIZATION,
    });

    expect(deps.governance).toBeInstanceOf(NoGovernanceClient);
    expect(deps.governance).not.toBeInstanceOf(CoreGovernanceClient);
    expect(deps.connector).toBeInstanceOf(CoreApiConnector);
    expect((deps.connector as unknown as { token: string }).token).toBe("task-runtime-token");
    expect((deps.taskWorkspace as unknown as { token: string }).token).toBe("task-runtime-token");
    expect(deps.taskEvents).toBe(deps.taskWorkspace);
  });

  test("main governance and connector use the generic token while callbacks use the task token", async () => {
    const factory = createEnvDepsFactory({
      ...modelEnv,
      SYNTHIA_CORE_TOKEN: "generic-core-token",
      SYNTHIA_TASK_RUNTIME_TOKEN: "task-runtime-token",
    });
    const deps = await factory({
      projectId: "p-main-capability",
      processInstanceId: "free:p-main-capability",
      projectType: "free",
      taskId: "task-main-capability",
      taskKind: "main",
      authorization: MAIN_TASK_AUTHORIZATION,
    });

    expect(deps.governance).toBeInstanceOf(CoreGovernanceClient);
    expect((deps.governance as unknown as { token: string }).token).toBe("generic-core-token");
    expect((deps.governance as unknown as { taskRuntimeToken: string }).taskRuntimeToken)
      .toBe("task-runtime-token");
    expect((deps.governance as unknown as { taskId: string }).taskId)
      .toBe("task-main-capability");
    expect((deps.connector as unknown as { token: string }).token).toBe("generic-core-token");
    expect((deps.taskEvents as unknown as { token: string }).token).toBe("task-runtime-token");
    expect(deps.taskWorkspace).toBeUndefined();
  });
});

describe("RuntimeServer — P4 formal progress projection", () => {
  test("serializes the same preview and persisted Job/evidence facts for list and detail", () => {
    const digest = (value: string) => sha256Hex(value);
    const formal = serializeTaskFormalInput({
      schema: "formal-flow-progress.v1",
      status: "running",
      projectId: "p1",
      gateSubmissionId: "sub-g4",
      workVersionId: "wv-1",
      snapshotId: "snap-4",
      snapshotManifestHash: digest("snapshot"),
      profileHash: digest("profile"),
      readinessId: "ready-1",
      authorizedTaskId: "task-main-1",
      approvalId: "fia-1",
      preview: {
        schema: "formal-input-preview.v1",
        workVersionId: "wv-1",
        snapshotId: "snap-4",
        readinessId: "ready-1",
        authorizedTaskId: "task-main-1",
        prerequisiteBaselineId: "bl-b1",
        targetPart: "xc7k70tfbv676-1",
        toolchainProfileHash: digest("toolchain"),
        constraintsComplete: true,
        purpose: "g4_delivery",
        allowedOperations: ["implement", "simulate", "synthesize", "validate_sources"],
        files: [{
          revisionId: "rev-rtl",
          path: "rtl/top.sv",
          role: "rtl",
          sha256: digest("rtl"),
          sizeBytes: 3,
          storageUri: `content://sha256/${digest("rtl")}`,
        }],
        inputHash: digest("input"),
        previewHash: digest("preview"),
      },
      jobs: {
        validate_sources: {
          jobId: "job-validate",
          state: "succeeded",
          evidenceManifestId: "evidence-validate",
          evidenceManifestHash: digest("evidence"),
        },
      },
    });
    expect(formal).toMatchObject({
      approval_id: "fia-1",
      preview: { input_hash: digest("input") },
      jobs: {
        validate_sources: {
          job_id: "job-validate",
          state: "succeeded",
          evidence_manifest_id: "evidence-validate",
          evidence_manifest_hash: digest("evidence"),
        },
      },
    });
  });
});

describe("RuntimeServer — historical-material session rollout gate", () => {
  test("default-off engineering sessions never query or inject historical material", async () => {
    const project = projectInfo({
      id: "p-history-off",
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
    });
    const governance = new ProjectInfoGovernance(project);
    governance.importedMaterials = [confirmedMaterial(project.id, "MUST-NOT-BE-LOADED")];
    const model = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
      ),
      () => model,
    );
    const agentId = await saveSessionFixture(project, "engineering");

    const session = await (server as unknown as {
      getOrCreateSession(id: string): Promise<FreeAgentSession | null>;
    }).getOrCreateSession(agentId);
    expect(session).not.toBeNull();
    expect(governance.importedMaterialQueries).toHaveLength(0);

    await session!.prompt("actual engineering request").finally(() => deleteAgent(agentId));

    expect(governance.importedMaterialQueries).toHaveLength(0);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.tools.map((tool) => tool.name)).toContain("core_submit_gate");
    expect(model.calls[0]!.messages).toEqual([
      { role: "system", content: expect.not.stringContaining("SYNTHIA_UNTRUSTED_REFERENCE_DATA_V1") },
      { role: "user", content: "actual engineering request" },
    ]);
    expect(model.calls[0]!.messages.some((message) => message.content?.includes("MUST-NOT-BE-LOADED"))).toBe(false);
  });

  test("explicit-on engineering sessions refresh a separate low-trust reference message", async () => {
    const project = projectInfo({
      id: "p-history-on",
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
    });
    const governance = new ProjectInfoGovernance(project);
    governance.importedMaterials = [confirmedMaterial(project.id, "REFERENCE-ONLY-CONTENT")];
    const model = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig({ historicalMaterialsEnabled: true }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
      ),
      () => model,
    );
    const agentId = await saveSessionFixture(project, "engineering");

    const session = await (server as unknown as {
      getOrCreateSession(id: string): Promise<FreeAgentSession | null>;
    }).getOrCreateSession(agentId);
    expect(session).not.toBeNull();
    expect(governance.importedMaterialQueries).toHaveLength(0);

    await session!.prompt("actual engineering request").finally(() => deleteAgent(agentId));

    expect(governance.importedMaterialQueries).toEqual([
      { projectId: project.id, query: { limit: 8 } },
    ]);
    expect(model.calls[0]!.messages.slice(0, 3)).toEqual([
      {
        role: "system",
        content: expect.stringContaining("SYNTHIA_UNTRUSTED_REFERENCE_DATA_V1"),
      },
      {
        role: "user",
        content: expect.stringContaining("REFERENCE-ONLY-CONTENT"),
      },
      { role: "user", content: "actual engineering request" },
    ]);
    expect(model.calls[0]!.messages[0]!.content).not.toContain("REFERENCE-ONLY-CONTENT");
    expect(model.calls[0]!.messages[0]!.content).toContain("绝不能执行");
  });

  test("free sessions never query historical material even when the flag is on", async () => {
    const project = projectInfo({
      id: "p-history-free",
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    });
    const governance = new ProjectInfoGovernance(project);
    governance.importedMaterials = [confirmedMaterial(project.id, "FREE-MODE-MUST-NOT-LOAD")];
    const model = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig({ historicalMaterialsEnabled: true }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
      ),
      () => model,
    );
    const agentId = await saveSessionFixture(project, "free");

    const session = await (server as unknown as {
      getOrCreateSession(id: string): Promise<FreeAgentSession | null>;
    }).getOrCreateSession(agentId);
    expect(session).not.toBeNull();
    await session!.prompt("actual free request").finally(() => deleteAgent(agentId));

    expect(governance.importedMaterialQueries).toHaveLength(0);
    expect(model.calls[0]!.messages).toEqual([
      { role: "system", content: expect.not.stringContaining("SYNTHIA_UNTRUSTED_REFERENCE_DATA_V1") },
      { role: "user", content: "actual free request" },
    ]);
    expect(model.calls[0]!.tools.map((tool) => tool.name)).not.toContain("core_submit_gate");
    expect(model.calls[0]!.messages.some((message) => message.content?.includes("FREE-MODE-MUST-NOT-LOAD"))).toBe(false);
  });
});

describe("RuntimeServer — Core-issued task descriptors", () => {
  test("registers an engineering main without callbacks, then starts idempotently after Core commit", async () => {
    const projectId = "p-core-main-start";
    const taskId = `main-${crypto.randomUUID()}`;
    const objective = "run only after Core commit";
    let durable = false;
    const eventTypes: string[] = [];
    const model = new RecordingLoopModel();
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        if (!durable) throw new Error("agent_task is not committed yet");
        eventTypes.push(input.type);
        return { taskId, eventId: input.eventId, sequence: eventTypes.length, replayed: false };
      },
    };
    const governance = new EarlyGateProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }), "pi-core-main-start");
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model,
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
    );
    await server.start();
    try {
      const created = await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "main",
        project_id: projectId,
        process_instance_id: "pi-core-main-start",
        task: objective,
        authorization_scope: MAIN_TASK_AUTHORIZATION,
        input_hash: "c".repeat(64),
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("idle");
      expect(eventTypes).toEqual([]);
      expect(model.intakeTasks).toEqual([]);
      expect((await loadAgentState(taskId)).runtimeStarted).toBe(false);
      const earlyMessage = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must not bypass start" }),
      });
      expect(earlyMessage.status).toBe(409);
      expect(((await earlyMessage.json()) as { error: { code: string } }).error.code)
        .toBe("task_not_started");
      expect(model.intakeTasks).toEqual([]);

      durable = true;
      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({ started: true, status: "running" });
      const replay = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ started: false, reason: "already_started" });
      expect((await waitForStatus(server, taskId, ["awaiting_approval", "succeeded"])).status)
        .toBe("awaiting_approval");
      expect(model.intakeTasks).toEqual([objective]);
      expect(eventTypes).toContain("status");
      expect((await loadAgentState(taskId)).runtimeStarted).toBe(true);
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("a Core-owned free main crosses one concurrent start barrier and receives its objective once", async () => {
    const projectId = "p-core-free-main-start";
    const taskId = `main-free-${crypto.randomUUID()}`;
    const objective = "inspect the project and report the next decision";
    const model = new RecordingConversationalModel();
    const runningReached = Promise.withResolvers<void>();
    const unblockRunning = Promise.withResolvers<void>();
    let blockFirstRunning = true;
    let eventSequence = 0;
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        eventSequence += 1;
        if (blockFirstRunning && input.type === "status" && input.payload.status === "running") {
          blockFirstRunning = false;
          runningReached.resolve();
          await unblockRunning.promise;
        }
        return { taskId, eventId: input.eventId, sequence: eventSequence, replayed: false };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
      () => model,
    );
    await server.start();
    try {
      const created = await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "main",
        project_id: projectId,
        task: objective,
        authorization_scope: MAIN_TASK_AUTHORIZATION,
        input_hash: "e".repeat(64),
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("idle");
      expect(model.calls).toHaveLength(0);

      const earlyMessage = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must not run before start" }),
      });
      expect(earlyMessage.status).toBe(409);
      expect(model.calls).toHaveLength(0);

      const firstStart = fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      await runningReached.promise;
      const secondStart = fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      await Bun.sleep(20);
      expect(model.calls).toHaveLength(0);
      unblockRunning.resolve();

      const startResponses = await Promise.all([firstStart, secondStart]);
      expect(startResponses.map((response) => response.status)).toEqual([200, 200]);
      const startBodies = await Promise.all(startResponses.map((response) => response.json()));
      expect(startBodies).toEqual([
        expect.objectContaining({ started: true, status: "running" }),
        expect.objectContaining({ started: true, status: "running" }),
      ]);
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status).toBe("awaiting_user");
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]!.messages).toContainEqual({ role: "user", content: objective });
      expect(model.calls[0]!.messages.filter(
        (message) => message.role === "user" && message.content === objective,
      )).toHaveLength(1);
      expect((await loadAgentState(taskId)).runtimeStarted).toBe(true);

      const replay = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(await replay.json()).toMatchObject({ started: false, reason: "already_started" });
      expect(model.calls).toHaveLength(1);
    } finally {
      unblockRunning.resolve();
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("an idempotent message replays one steered response without steering twice", async () => {
    const projectId = "p-core-free-main-steer";
    const taskId = `main-free-steer-${crypto.randomUUID()}`;
    const model = new BlockingConversationalModel();
    let sequence = 0;
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        sequence += 1;
        return { taskId, eventId: input.eventId, sequence, replayed: false };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "main",
        project_id: projectId,
        task: "hold the first turn while Core sends steering",
        authorization_scope: MAIN_TASK_AUTHORIZATION,
        input_hash: "f".repeat(64),
      })).status).toBe(201);
      expect((await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" })).status)
        .toBe(200);
      await model.started.promise;

      const messageKey = `steer-${crypto.randomUUID()}`;
      const sendSteer = () => fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": messageKey,
        },
        body: JSON.stringify({ text: "focus on option A" }),
      });
      const first = await sendSteer();
      const replay = await sendSteer();
      expect(await first.json()).toEqual({ steered: true, status: "running" });
      expect(await replay.json()).toEqual({ steered: true, status: "running" });
      expect(model.calls).toHaveLength(1);
      const detail = await getTask(server, taskId);
      const audit = detail.audit as Array<{ action: string }>;
      expect(audit.filter((event) => event.action === "free_agent_steer")).toHaveLength(1);

      const conflict = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": messageKey,
        },
        body: JSON.stringify({ text: "focus on option B" }),
      });
      expect(conflict.status).toBe(409);
      const afterConflict = await getTask(server, taskId);
      expect((afterConflict.audit as Array<{ action: string }>).filter(
        (event) => event.action === "free_agent_steer",
      )).toHaveLength(1);

      model.release.resolve();
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status).toBe("awaiting_user");
    } finally {
      model.release.resolve();
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("an idempotent Core abort replays once and leaves cancellation persistence to Core", async () => {
    const projectId = "p-core-free-main-abort";
    const taskId = `main-free-abort-${crypto.randomUUID()}`;
    const abortKey = `core-abort-${crypto.randomUUID()}`;
    const model = new BlockingConversationalModel();
    const coreEvents: Array<{ type: string; status?: unknown }> = [];
    let sequence = 0;
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        sequence += 1;
        coreEvents.push({ type: input.type, status: input.payload.status });
        return { taskId, eventId: input.eventId, sequence, replayed: false };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "main",
        project_id: projectId,
        task: "wait until Core cancels this turn",
        authorization_scope: MAIN_TASK_AUTHORIZATION,
        input_hash: "a".repeat(64),
      })).status).toBe(201);
      expect((await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" })).status)
        .toBe(200);
      await model.started.promise;

      const abort = () => fetch(`${server.url}/tasks/${taskId}/abort`, {
        method: "POST",
        headers: { "idempotency-key": abortKey },
      });
      const first = await abort();
      const replay = await abort();
      expect(await first.json()).toEqual({ aborted: true, status: "running" });
      expect(await replay.json()).toEqual({ aborted: true, status: "running" });
      expect(await loadMessageIdempotencyRecords(taskId)).toMatchObject({
        [abortKey]: {
          fingerprint: sha256Hex(JSON.stringify({ operation: "abort" })),
          state: "completed",
          body: { aborted: true, status: "running" },
        },
      });
      const detail = await getTask(server, taskId);
      expect((detail.audit as Array<{ action: string }>).filter(
        (event) => event.action === "free_agent_abort",
      )).toHaveLength(1);

      const crossOperation = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": abortKey,
        },
        body: JSON.stringify({ text: "must not reuse an abort key" }),
      });
      expect(crossOperation.status).toBe(409);

      model.release.resolve();
      await waitForStatus(server, taskId, ["failed"]);
      expect(coreEvents.filter((event) => event.status === "cancelled")).toHaveLength(0);
    } finally {
      model.release.resolve();
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("different idempotency keys serialize into one prompt and one steer", async () => {
    const projectId = "p-core-side-concurrent-keys";
    const taskId = `side-concurrent-keys-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const firstKey = `message-a-${crypto.randomUUID()}`;
    const secondKey = `message-b-${crypto.randomUUID()}`;
    const secondRunningReached = Promise.withResolvers<void>();
    const unblockSecondRunning = Promise.withResolvers<void>();
    let runningEvents = 0;
    let sequence = 0;
    const workspace: TaskWorkspaceClient = {
      ...taskWorkspaceFixture(projectId, taskId, workspaceId),
      async appendEvent(input) {
        sequence += 1;
        if (input.type === "status" && input.payload.status === "running") {
          runningEvents += 1;
          if (runningEvents === 2) {
            secondRunningReached.resolve();
            await unblockSecondRunning.promise;
          }
        }
        return { taskId, eventId: input.eventId, sequence, replayed: false };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const model = new FirstReplyThenBlockingConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-core-side-concurrent-keys",
        workspace_id: workspaceId,
        project_id: projectId,
        task: "ask for the implementation choice",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "8".repeat(64),
      })).status).toBe(201);
      expect((await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" })).status)
        .toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status)
        .toBe("awaiting_user");
      await Bun.sleep(10);
      expect(model.calls).toHaveLength(1);

      const send = (key: string, text: string) => fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ text }),
      });
      const first = send(firstKey, "use option A");
      await secondRunningReached.promise;
      const second = send(secondKey, "also preserve the reset behavior");
      await Bun.sleep(20);
      expect(model.calls).toHaveLength(1);
      expect(Object.keys(await loadMessageIdempotencyRecords(taskId))).toEqual([firstKey]);

      unblockSecondRunning.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(await responses[0]!.json()).toEqual({ accepted: true, status: "running" });
      expect(await responses[1]!.json()).toEqual({ steered: true, status: "running" });
      await model.followUpStarted.promise;
      expect(model.calls).toHaveLength(2);
      const detail = await getTask(server, taskId);
      expect((detail.audit as Array<{ action: string }>).filter(
        (event) => event.action === "free_agent_steer",
      )).toHaveLength(1);
      expect(await loadMessageIdempotencyRecords(taskId)).toMatchObject({
        [firstKey]: { state: "completed", body: { accepted: true } },
        [secondKey]: { state: "completed", body: { steered: true } },
      });

      model.releaseFollowUp.resolve();
      expect((await waitForStatus(server, taskId, ["awaiting_user", "fail_closed"])).status)
        .toBe("awaiting_user");
    } finally {
      unblockSecondRunning.resolve();
      model.releaseFollowUp.resolve();
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("rejects a new prompt while a completed side turn is still sealing", async () => {
    const projectId = "p-core-side-finalizing-turn";
    const taskId = `side-finalizing-turn-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const messageKey = `message-during-finalize-${crypto.randomUUID()}`;
    const finalizeReached = Promise.withResolvers<void>();
    const releaseFinalize = Promise.withResolvers<void>();
    let sequence = 0;
    let finalizeCalls = 0;
    const workspace: TaskWorkspaceClient = {
      ...taskWorkspaceFixture(projectId, taskId, workspaceId),
      async appendEvent(input) {
        sequence += 1;
        return { taskId, eventId: input.eventId, sequence, replayed: false };
      },
      async finalizeResult(input) {
        finalizeCalls += 1;
        finalizeReached.resolve();
        await releaseFinalize.promise;
        return {
          resultId: "result-finalizing-turn",
          taskId,
          workspaceId,
          summary: input.summary,
          outputHash: "f".repeat(64),
        };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const model = new ToolThenTextConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-core-side-finalizing-turn",
        workspace_id: workspaceId,
        project_id: projectId,
        task: "complete this exploration immediately",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "7".repeat(64),
      })).status).toBe(201);
      expect((await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" })).status)
        .toBe(200);
      await finalizeReached.promise;
      expect(model.calls).toHaveLength(2);

      const sendDuringFinalize = () => fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": messageKey,
        },
        body: JSON.stringify({ text: "start another turn" }),
      });
      const rejected = await sendDuringFinalize();
      expect(rejected.status).toBe(409);
      expect(((await rejected.json()) as { error: { code: string } }).error.code)
        .toBe("task_turn_finalizing");
      expect(model.calls).toHaveLength(2);
      expect(finalizeCalls).toBe(1);
      expect((await getTask(server, taskId)).status).not.toBe("fail_closed");
      expect(await loadMessageIdempotencyRecords(taskId)).toEqual({});

      releaseFinalize.resolve();
      expect((await waitForStatus(server, taskId, ["succeeded", "fail_closed"])).status)
        .toBe("succeeded");
      const terminalReplay = await sendDuringFinalize();
      expect(terminalReplay.status).toBe(409);
      expect(((await terminalReplay.json()) as { error: { code: string } }).error.code)
        .toBe("task_terminal");
      expect(model.calls).toHaveLength(2);
      expect(finalizeCalls).toBe(1);
    } finally {
      releaseFinalize.resolve();
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("a completion-ledger write failure leaves a durable intent that restart never prompts again", async () => {
    const projectId = "p-core-side-message-crash";
    const taskId = `side-message-crash-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const blockedMessageKey = `blocked-${crypto.randomUUID()}`;
    const messageKey = `follow-up-${crypto.randomUUID()}`;
    const messageText = "apply the safer option";
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const workspace = taskWorkspaceFixture(projectId, taskId, workspaceId);
    const model = new RecordingConversationalModel();
    let ledgerSaveCalls = 0;
    const failingStore: RuntimeMessageIdempotencyStore = {
      load: loadMessageIdempotencyRecords,
      async save(agentId, records) {
        ledgerSaveCalls += 1;
        if (ledgerSaveCalls === 1) {
          throw new Error("injected intent-ledger write failure");
        }
        if (ledgerSaveCalls === 3) {
          throw new Error("injected completion-ledger write failure");
        }
        await saveMessageIdempotencyRecords(agentId, records);
      },
    };
    const deps: DepsFactory = async () => ({
      model: new CounterScriptedModel(),
      connector: new FakeVivadoConnector({ behavior: successBehavior() }),
      governance,
      taskWorkspace: workspace,
    });
    const server = new RuntimeServer(makeConfig(), deps, () => model, failingStore);
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-core-side-message-crash",
        workspace_id: workspaceId,
        project_id: projectId,
        task: "ask the user which option to apply",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "9".repeat(64),
      })).status).toBe(201);
      expect((await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" })).status)
        .toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status)
        .toBe("awaiting_user");
      expect(model.calls).toHaveLength(1);

      const blockedBeforeDispatch = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": blockedMessageKey,
        },
        body: JSON.stringify({ text: "must stay behind the intent barrier" }),
      });
      expect(blockedBeforeDispatch.status).toBe(500);
      expect(((await blockedBeforeDispatch.json()) as { error: { message: string } }).error.message)
        .toBe("injected intent-ledger write failure");
      expect(model.calls).toHaveLength(1);
      expect(await loadMessageIdempotencyRecords(taskId)).toEqual({});

      const failedCompletionWrite = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": messageKey,
        },
        body: JSON.stringify({ text: messageText }),
      });
      expect(failedCompletionWrite.status).toBe(500);
      expect(await failedCompletionWrite.json()).toEqual({
        error: {
          code: "internal_error",
          message: "injected completion-ledger write failure",
        },
      });
      expect(ledgerSaveCalls).toBe(3);
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status)
        .toBe("awaiting_user");
      // The user message reached the model exactly once before the simulated
      // crash window; only the response-ledger transition failed.
      expect(model.calls).toHaveLength(2);
      expect(model.calls[1]!.messages).toContainEqual({ role: "user", content: messageText });
      expect(await loadMessageIdempotencyRecords(taskId)).toMatchObject({
        [messageKey]: {
          fingerprint: sha256Hex(JSON.stringify({ text: messageText })),
          state: "in_progress",
          status: 409,
          body: { error: { code: "idempotency_in_progress" } },
        },
      });

      await server.stop();
      const replayModel = new RecordingConversationalModel();
      const recoveredServer = new RuntimeServer(makeConfig(), deps, () => replayModel);
      await recoveredServer.start();
      try {
        const replay = await fetch(`${recoveredServer.url}/tasks/${taskId}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": messageKey,
          },
          body: JSON.stringify({ text: `  ${messageText}  ` }),
        });
        expect(replay.status).toBe(409);
        expect(await replay.json()).toEqual({
          error: {
            code: "idempotency_in_progress",
            message:
              "Idempotent message dispatch has an indeterminate prior outcome and will not be repeated",
          },
        });

        const stableReplay = await fetch(`${recoveredServer.url}/tasks/${taskId}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": messageKey,
          },
          body: JSON.stringify({ text: messageText }),
        });
        expect(stableReplay.status).toBe(409);
        expect(((await stableReplay.json()) as { error: { code: string } }).error.code)
          .toBe("idempotency_in_progress");

        const conflictingReplay = await fetch(`${recoveredServer.url}/tasks/${taskId}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": messageKey,
          },
          body: JSON.stringify({ text: "apply a different option" }),
        });
        expect(conflictingReplay.status).toBe(409);
        expect(((await conflictingReplay.json()) as { error: { code: string } }).error.code)
          .toBe("idempotency_conflict");
        expect(replayModel.calls).toHaveLength(0);
      } finally {
        await recoveredServer.stop();
      }
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("creates an engineering side task as an isolated free session and preserves Core input_hash", async () => {
    const projectId = "p-core-side";
    const taskId = `side-${crypto.randomUUID()}`;
    const parentTaskId = "main-core-side";
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const inputHash = "a".repeat(64);
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const workspace = taskWorkspaceFixture(projectId, taskId, workspaceId);
    const conversationalModel = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig({ defaultPart: "must-not-be-invented" }),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => conversationalModel,
    );
    await server.start();
    try {
      const result = await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: parentTaskId,
        workspace_id: workspaceId,
        project_id: projectId,
        task: "explore an alternate counter implementation",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: inputHash,
      });

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        agent_id: taskId,
        task_id: taskId,
        kind: "side",
        parent_task_id: parentTaskId,
        workspace_id: workspaceId,
        input_hash: inputHash,
        status: "idle",
      });

      const detail = await getTask(server, taskId);
      expect(detail).toMatchObject({
        kind: "side",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: inputHash,
        execution_mode: "free",
        project_type: "engineering",
        status: "idle",
      });
      const state = await loadAgentState(taskId);
      expect(state.inputHash).toBe(inputHash);
      expect(state.executionMode).toBe("free");
      expect(state.processInstanceId).toBe(`task:${taskId}`);
      expect(state.part).toBe("");
      expect(conversationalModel.calls).toHaveLength(0);
      const earlyMessage = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must not bypass side-task start" }),
      });
      expect(earlyMessage.status).toBe(409);
      expect(conversationalModel.calls).toHaveLength(0);
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("creates a free-project side task with a task-local execution context", async () => {
    const projectId = "p-free-core-side";
    const taskId = `side-${crypto.randomUUID()}`;
    const parentTaskId = "main-free-core-side";
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const inputHash = "b".repeat(64);
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      targetPart: "xc7k70tfbv676-1",
    }));
    const workspace = taskWorkspaceFixture(projectId, taskId, workspaceId);
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => new RecordingConversationalModel(),
    );
    await server.start();
    try {
      const result = await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: parentTaskId,
        workspace_id: workspaceId,
        project_id: projectId,
        project_type: "free",
        task: "explore a free-project alternative",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: inputHash,
      });

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        agent_id: taskId,
        task_id: taskId,
        kind: "side",
        parent_task_id: parentTaskId,
        workspace_id: workspaceId,
        input_hash: inputHash,
        status: "idle",
      });
      const state = await loadAgentState(taskId);
      expect(state.projectType).toBe("free");
      expect(state.executionMode).toBe("free");
      expect(state.processInstanceId).toBe(`task:${taskId}`);

      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status)
        .toBe("awaiting_user");
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("rejects a formal process instance on a side-task dispatch", async () => {
    const taskId = `side-with-pi-${crypto.randomUUID()}`;
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const result = await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-side-with-pi",
        workspace_id: `ws-${crypto.randomUUID()}`,
        project_id: "p-side-with-pi",
        process_instance_id: "pi-formal-must-not-leak",
        task: "must use a task-local execution context",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "a".repeat(64),
      });

      expect(result.status).toBe(400);
      expect((result.body.error as Record<string, unknown>)["code"]).toBe("task_descriptor_invalid");
      expect(await fetch(`${server.url}/tasks/${taskId}`).then((response) => response.status)).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("persists a side turn, finalizes its Core result, and rejects terminal messages", async () => {
    const projectId = "p-core-side-finalize";
    const taskId = `side-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const events: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];
    const operations: string[] = [];
    const finalized: Array<{ summary: string; tests?: readonly unknown[] }> = [];
    const model = new ToolThenTextConversationalModel();
    const workspace: TaskWorkspaceClient = {
      ...taskWorkspaceFixture(projectId, taskId, workspaceId),
      async appendEvent(input) {
        operations.push(`event:${input.type}`);
        events.push({ type: input.type, payload: input.payload });
        return { taskId, eventId: input.eventId, sequence: events.length, replayed: false };
      },
      async finalizeResult(input) {
        operations.push("finalize");
        finalized.push(input);
        return {
          resultId: "result-finalized",
          taskId,
          workspaceId,
          summary: input.summary,
          outputHash: "f".repeat(64),
        };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-core-side-finalize",
        workspace_id: workspaceId,
        project_id: projectId,
        task: "finish one isolated exploration",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "a".repeat(64),
      })).status).toBe(201);
      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({ started: true, status: "running" });
      expect((await waitForStatus(server, taskId, ["succeeded"])).status).toBe("succeeded");
      expect(finalized).toEqual([{ summary: "ok", tests: [] }]);
      expect(events.map((event) => event.type)).toEqual([
        "status",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      expect(operations).toEqual([
        "event:status",
        "event:tool_call",
        "event:tool_result",
        "event:assistant_message",
        "finalize",
      ]);
      const toolCall = events.find((event) => event.type === "tool_call")!;
      expect(String(toolCall.payload.args).length).toBeGreaterThan(3_000);
      expect(String(toolCall.payload.args)).not.toContain("已截断");
      expect(model.calls[0]!.tools.map((tool) => tool.name)).not.toContain("core_submit_gate");

      const callsBeforeTerminalMessage = model.calls.length;
      const terminalMessage = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "try to revive the completed side task" }),
      });
      expect(terminalMessage.status).toBe(409);
      expect(((await terminalMessage.json()) as { error: { code: string } }).error.code)
        .toBe("task_terminal");
      expect(model.calls).toHaveLength(callsBeforeTerminalMessage);
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("a side reply waits, seals on explicit completion, and rejects terminal replays", async () => {
    const projectId = "p-core-side-awaiting-user";
    const taskId = `side-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const events: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];
    const finalized: string[] = [];
    const model = new AwaitThenCompleteConversationalModel();
    const secondRunningReached = Promise.withResolvers<void>();
    const unblockSecondRunning = Promise.withResolvers<void>();
    let runningStatusCount = 0;
    const workspace: TaskWorkspaceClient = {
      ...taskWorkspaceFixture(projectId, taskId, workspaceId),
      async appendEvent(input) {
        events.push({ type: input.type, payload: input.payload });
        if (input.type === "status" && input.payload.status === "running") {
          runningStatusCount += 1;
          if (runningStatusCount === 2) {
            secondRunningReached.resolve();
            await unblockSecondRunning.promise;
          }
        }
        return { taskId, eventId: input.eventId, sequence: events.length, replayed: false };
      },
      async finalizeResult(input) {
        finalized.push(input.summary);
        return {
          resultId: "must-not-finalize",
          taskId,
          workspaceId,
          summary: input.summary,
          outputHash: "f".repeat(64),
        };
      },
    };
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-core-side-awaiting-user",
        workspace_id: workspaceId,
        project_id: projectId,
        task: "ask before choosing an implementation",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "c".repeat(64),
      })).status).toBe(201);

      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user"])).status).toBe("awaiting_user");
      expect(finalized).toEqual([]);
      expect(events.map((event) => event.type)).toEqual([
        "status",
        "assistant_message",
        "status",
      ]);
      expect((events.at(-1)!.payload as Record<string, unknown>).status).toBe("awaiting_user");
      expect(model.calls[0]!.messages).toContainEqual({
        role: "user",
        content: "ask before choosing an implementation",
      });
      expect(await loadAgentState(taskId)).toMatchObject({
        status: "awaiting_user",
        runtimeStarted: true,
      });

      const messageKey = `side-follow-up-${crypto.randomUUID()}`;
      const firstFollowUp = fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": messageKey,
        },
        body: JSON.stringify({ text: "choose option A" }),
      });
      await secondRunningReached.promise;
      const concurrentReplay = fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": messageKey,
        },
        body: JSON.stringify({ text: "choose option A" }),
      });
      await Bun.sleep(20);
      unblockSecondRunning.resolve();
      const followUpResponses = await Promise.all([firstFollowUp, concurrentReplay]);
      expect(followUpResponses.map((response) => response.status)).toEqual([200, 200]);
      const followUpBodies = await Promise.all(
        followUpResponses.map((response) => response.json() as Promise<Record<string, unknown>>),
      );
      expect(followUpBodies).toEqual([
        { accepted: true, status: "running" },
        { accepted: true, status: "running" },
      ]);
      expect((await waitForStatus(server, taskId, ["succeeded"])).status).toBe("succeeded");
      expect(finalized).toEqual(["selected option applied"]);
      expect(model.calls).toHaveLength(3);
      expect(model.calls[1]!.messages).toContainEqual({ role: "user", content: "choose option A" });
      expect(events.map((event) => event.type)).toEqual([
        "status",
        "assistant_message",
        "status",
        "status",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);

      // Once Core-owned work is terminal, even a previously accepted
      // idempotency key cannot revive it after Runtime restarts.
      await server.stop();
      const replayModel = new RecordingConversationalModel();
      const recoveredServer = new RuntimeServer(
        makeConfig(),
        async ({ taskId: requestedTaskId }) => ({
          model: new CounterScriptedModel(),
          connector: new FakeVivadoConnector({ behavior: successBehavior() }),
          governance,
          ...(requestedTaskId === taskId ? { taskWorkspace: workspace } : {}),
        }),
        () => replayModel,
      );
      await recoveredServer.start();
      try {
        const replay = await fetch(`${recoveredServer.url}/tasks/${taskId}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": messageKey,
          },
          body: JSON.stringify({ text: "  choose option A  " }),
        });
        expect(replay.status).toBe(409);
        expect(((await replay.json()) as { error: { code: string } }).error.code)
          .toBe("task_terminal");
        expect(replayModel.calls).toHaveLength(0);
        expect(finalized).toEqual(["selected option applied"]);

        const conflict = await fetch(`${recoveredServer.url}/tasks/${taskId}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": messageKey,
          },
          body: JSON.stringify({ text: "choose option B" }),
        });
        expect(conflict.status).toBe(409);
        expect(((await conflict.json()) as { error: { code: string } }).error.code)
          .toBe("task_terminal");
        expect(replayModel.calls).toHaveLength(0);
      } finally {
        await recoveredServer.stop();
      }
    } finally {
      unblockSecondRunning.resolve();
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("event 5xx fails closed and never seals a side result", async () => {
    const projectId = "p-core-side-event-failure";
    const taskId = `side-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const model = new ToolThenTextConversationalModel();
    const eventBodies: Array<Record<string, unknown>> = [];
    let resultCalls = 0;
    const workspace = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId,
      taskId,
      workspaceId,
      authorization: SIDE_TASK_AUTHORIZATION,
      retryDelayMs: 0,
      sleep: async () => {},
      fetchImpl: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/result")) {
          resultCalls += 1;
          return new Response(JSON.stringify({ error: { code: "must_not_finalize" } }), { status: 500 });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        eventBodies.push(body);
        // First status succeeds. The tool_call write and its bounded retry fail;
        // the later fail_closed status is allowed through.
        if (eventBodies.length === 2 || eventBodies.length === 3) {
          return new Response(JSON.stringify({
            error: { code: "capability_unavailable", message: "event store unavailable", retryable: true },
          }), { status: 503 });
        }
        return new Response(JSON.stringify({
          data: {
            task_id: taskId,
            event_id: body.event_id,
            sequence: eventBodies.length === 1 ? 1 : 2,
            replayed: false,
          },
        }), { status: 201 });
      }) as typeof fetch,
    });
    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskWorkspace: workspace,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-core-side-event-failure",
        workspace_id: workspaceId,
        project_id: projectId,
        task: "event persistence must be complete",
        authorization_scope: SIDE_TASK_AUTHORIZATION,
        input_hash: "b".repeat(64),
      })).status).toBe(201);
      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["fail_closed"])).status).toBe("fail_closed");
      expect(resultCalls).toBe(0);
      expect(eventBodies).toHaveLength(4);
      expect((eventBodies[0]!.payload as Record<string, unknown>).status).toBe("running");
      expect(eventBodies[1]!.type).toBe("tool_call");
      expect(eventBodies[2]!.event_id).toBe(eventBodies[1]!.event_id);
      expect((eventBodies[3]!.payload as Record<string, unknown>).status).toBe("fail_closed");
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("rejects the legacy side-task authorization shape before creating state", async () => {
    const taskId = `side-old-scope-${crypto.randomUUID()}`;
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const result = await postTaskRaw(server, {
        task_id: taskId,
        task_kind: "side",
        parent_task_id: "main-old-scope",
        workspace_id: "ws-old-scope",
        project_id: "p-old-scope",
        task: "must fail closed",
        authorization_scope: {
          read: ["rtl/**"],
          write_paths: ["rtl/side-counter.v"],
          run_classes: ["exploratory"],
          can_submit_gate: false,
          can_create_milestone: false,
        },
      });

      expect(result.status).toBe(400);
      expect((result.body.error as Record<string, unknown>)["code"]).toBe("task_descriptor_invalid");
      const detail = await fetch(`${server.url}/tasks/${taskId}`);
      expect(detail.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("rejects side-task gate submission and formal-run capabilities", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      for (const capability of ["can_submit_gates", "can_start_formal_runs"] as const) {
        const result = await postTaskRaw(server, {
          task_id: `side-elevated-${capability}-${crypto.randomUUID()}`,
          task_kind: "side",
          parent_task_id: "main-elevated-scope",
          workspace_id: `ws-${crypto.randomUUID()}`,
          project_id: "p-elevated-scope",
          task: `must reject ${capability}`,
          authorization_scope: {
            ...SIDE_TASK_AUTHORIZATION,
            [capability]: true,
          },
        });

        expect(result.status).toBe(409);
        expect((result.body.error as Record<string, unknown>)["code"]).toBe("side_task_scope_invalid");
      }
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — POST /tasks + full chain", () => {
  test("auto-approve (no-governance) agent completes the full stage chain", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p1",
        process_instance_id: "pi-test",
        task: "8位计数器",
      });
      createdAgentIds.push(agentId);
      expect(agentId).toMatch(/^agent-/);

      const body = await waitForStatus(server, agentId, ["succeeded"]);
      expect(body["status"]).toBe("succeeded");
      expect(body["project_id"]).toBe("p1");
      expect(body["task"]).toBe("8位计数器");
    } finally {
      await server.stop();
    }
  });

  test("passes optional project type and process profile fields to deps factory", async () => {
    let capturedFactoryOpts: Parameters<DepsFactory>[0] | undefined;
    const server = new RuntimeServer(
      makeConfig(),
      async (opts) => {
        capturedFactoryOpts = opts;
        return {
          model: new CounterScriptedModel(),
          connector: new FakeVivadoConnector({ behavior: successBehavior() }),
          governance: new NoGovernanceClient(),
        };
      },
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-profile",
        process_instance_id: "pi-profile",
        project_type: "engineering",
        process_version_id: "GJB_REF_V1",
        process_profile_id: "GJB_REF_V1",
        process_profile_name: "GJB 参考流程 v1",
        process_profile_version: "GJB_REF_V1",
        task: "profile passthrough",
        mode: "agent",
      });
      createdAgentIds.push(agentId);

      expect(capturedFactoryOpts).toMatchObject({
        projectId: "p-profile",
        processInstanceId: "pi-profile",
        projectType: "engineering",
        processVersionId: "GJB_REF_V1",
        processProfileId: "GJB_REF_V1",
        processProfileName: "GJB 参考流程 v1",
        processProfileVersion: "GJB_REF_V1",
      });
    } finally {
      await server.stop();
    }
  });

  test("a Core Project Agent preserves engineering facts without starting the governed loop", async () => {
    const gov = new EarlyGateProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: "xc7k70tfbv676-1",
    }), "pi-core-eng");
    const conversationalModel = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
      () => conversationalModel,
    );
    await server.start();
    try {
      const taskId = `project-agent-${crypto.randomUUID()}`;
      const create = await postTaskRaw(server, {
        project_id: "p-core-eng",
        process_instance_id: "pi-core-eng",
        task: "Core says engineering",
        mode: "agent",
        task_id: taskId,
        task_kind: "main",
        execution_intent: "project_agent",
        authorization_scope: MAIN_TASK_AUTHORIZATION,
      });
      expect(create.status).toBe(201);
      createdAgentIds.push(taskId);

      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);

      const body = await waitForStatus(server, taskId, ["awaiting_user", "failed"]);
      expect(body["status"]).toBe("awaiting_user");
      expect(body["execution_mode"]).toBe("engineering");
      expect(body["agent_role"]).toBe("project");
      expect(body["project_type"]).toBe("engineering");
      expect(body["process_version_id"]).toBe("GJB_REF_V1");
      expect(body["awaiting_gate"]).toBeNull();
      expect(gov.submissions).toHaveLength(0);
      expect(gov.readProjectInfoCount).toBeGreaterThan(0);
      expect(conversationalModel.calls).toHaveLength(1);
      expect(conversationalModel.calls[0]!.tools.map((tool) => tool.name)).toContain("core_submit_gate");
    } finally {
      await server.stop();
    }
  });

  test("a Project Agent turn failure stays conversational and the same agent accepts the next turn", async () => {
    const projectId = "p-core-project-turn-recovery";
    const taskId = `project-agent-${crypto.randomUUID()}`;
    const events: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        events.push({ type: input.type, payload: input.payload });
        return {
          taskId,
          eventId: input.eventId,
          sequence: events.length,
          replayed: false,
        };
      },
    };
    const governance = new EarlyGateProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: "xc7k70tfbv676-1",
    }), "pi-project-turn-recovery");
    const model = new FailOnceConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
      () => model,
    );
    await server.start();
    try {
      const create = await postTaskRaw(server, {
        project_id: projectId,
        process_instance_id: "pi-project-turn-recovery",
        task: "first turn may fail",
        mode: "agent",
        task_id: taskId,
        task_kind: "main",
        execution_intent: "project_agent",
        authorization_scope: MAIN_TASK_AUTHORIZATION,
      });
      expect(create.status).toBe(201);
      createdAgentIds.push(taskId);

      const started = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(started.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user", "fail_closed"])).status)
        .toBe("awaiting_user");
      expect(events).toContainEqual({
        type: "assistant_message",
        payload: { text: "[error] temporary model outage" },
      });
      expect(events).toContainEqual({
        type: "status",
        payload: { status: "awaiting_user", reason: "temporary model outage" },
      });
      expect(await loadAgentState(taskId)).toMatchObject({
        agentId: taskId,
        agentRole: "project",
        runtimeStarted: true,
        status: "awaiting_user",
      });

      const followUp = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "retry on this same agent" }),
      });
      expect(followUp.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user", "fail_closed"])).status)
        .toBe("awaiting_user");
      expect(model.calls).toHaveLength(2);
      expect(model.calls[1]!.messages).toContainEqual({
        role: "user",
        content: "retry on this same agent",
      });
      expect(events).toContainEqual({
        type: "assistant_message",
        payload: { text: "recovered on the same project agent" },
      });
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("a Project Agent clears an older callback failure when a later turn reaches Core", async () => {
    const projectId = "p-core-project-callback-recovery";
    const taskId = `project-agent-${crypto.randomUUID()}`;
    let eventCalls = 0;
    const events: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        eventCalls += 1;
        if (eventCalls === 1) throw new Error("temporary Core callback outage");
        events.push({ type: input.type, payload: input.payload });
        return {
          taskId,
          eventId: input.eventId,
          sequence: eventCalls,
          replayed: false,
        };
      },
    };
    const governance = new EarlyGateProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: "xc7k70tfbv676-1",
    }), "pi-project-callback-recovery");
    const model = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
      () => model,
    );
    await server.start();
    try {
      expect((await postTaskRaw(server, {
        project_id: projectId,
        process_instance_id: "pi-project-callback-recovery",
        task: "first callback may fail",
        mode: "agent",
        task_id: taskId,
        task_kind: "main",
        execution_intent: "project_agent",
        authorization_scope: MAIN_TASK_AUTHORIZATION,
      })).status).toBe(201);
      createdAgentIds.push(taskId);

      const start = await fetch(`${server.url}/tasks/${taskId}/start`, { method: "POST" });
      expect(start.status).toBe(503);
      expect((await getTask(server, taskId)).status).toBe("fail_closed");
      expect(model.calls).toHaveLength(0);

      const followUp = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "continue after Core recovers" }),
      });
      expect(followUp.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user", "fail_closed"])).status)
        .toBe("awaiting_user");
      expect(model.calls).toHaveLength(1);
      expect(events).toContainEqual({
        type: "assistant_message",
        payload: { text: "ok" },
      });
      expect(events.at(-1)).toEqual({
        type: "status",
        // Runtime's conversational status is idle; Core projects that durable
        // event to awaiting_user for the Project Agent lifecycle.
        payload: { status: "idle" },
      });
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("unknown Core project_type fails closed before creating an agent", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "research" as unknown as ProjectInfo["projectType"],
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const res = await postTaskRaw(server, {
        project_id: "p-unknown-type",
        process_instance_id: "pi-unknown-type",
        task: "bad type",
        mode: "agent",
      });

      expect(res.status).toBe(409);
      expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_type_unsupported");
    } finally {
      await server.stop();
    }
  });

  test("engineering Core project without a frozen profile fails closed", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const res = await postTaskRaw(server, {
        project_id: "p-missing-profile",
        process_instance_id: "pi-missing-profile",
        task: "missing profile",
        mode: "agent",
      });

      expect(res.status).toBe(409);
      expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_invalid");
    } finally {
      await server.stop();
    }
  });

  test("engineering Core project rejects every missing frozen alias, version, or name", async () => {
    const complete: Partial<ProjectInfo> = {
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
    };
    let current = projectInfo(complete);
    class MutableProjectInfoGovernance extends TestGovernance {
      override async getProjectInfo(projectId: string): Promise<ProjectInfo> {
        return { ...current, id: projectId };
      }
    }
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new MutableProjectInfoGovernance(),
      ),
    );
    await server.start();
    try {
      for (const key of [
        "processVersionId",
        "processProfileId",
        "processProfileVersion",
        "processProfileName",
      ] as const) {
        current = projectInfo({ ...complete, [key]: null });
        const res = await postTaskRaw(server, {
          project_id: `p-missing-${key}`,
          process_instance_id: `pi-missing-${key}`,
          task: `missing ${key}`,
        });
        expect(res.status).toBe(409);
        expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_invalid");
      }
    } finally {
      await server.stop();
    }
  });

  test("complete modern free facts stay free and persist every process field as null", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-free-complete",
        task: "free project",
      });
      createdAgentIds.push(agentId);
      const body = await getTask(server, agentId);
      expect(body["execution_mode"]).toBe("free");
      expect(body["project_type"]).toBe("free");
      expect(body["process_version_id"]).toBeNull();
      expect(body["process_profile_id"]).toBeNull();
      expect(body["process_profile_name"]).toBeNull();
      expect(body["process_profile_version"]).toBeNull();
      expect(body["status"]).toBe("idle");
    } finally {
      await server.stop();
    }
  });

  test("free Core project rejects an attached process instance", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const res = await postTaskRaw(server, {
        project_id: "p-free-with-process",
        process_instance_id: "pi-must-not-be-used",
        task: "free project",
      });
      expect(res.status).toBe(409);
      expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_instance_invalid");
    } finally {
      await server.stop();
    }
  });

  test("free Core project requires every process field to be explicit null", async () => {
    const complete: Partial<ProjectInfo> = {
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    };
    let current = projectInfo(complete);
    class MutableProjectInfoGovernance extends TestGovernance {
      override async getProjectInfo(projectId: string): Promise<ProjectInfo> {
        return { ...current, id: projectId };
      }
    }
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new MutableProjectInfoGovernance(),
      ),
    );
    await server.start();
    try {
      for (const key of PROCESS_FACT_CASES) {
        current = projectInfo({ ...complete, [key]: undefined });
        const res = await postTaskRaw(server, {
          project_id: `p-free-omitted-${key}`,
          task: `invalid omitted free ${key}`,
        });
        expect(res.status).toBe(409);
        expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_invalid");
      }
    } finally {
      await server.stop();
    }
  });

  test("free Core project rejects every non-null process field", async () => {
    const complete: Partial<ProjectInfo> = {
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    };
    let current = projectInfo(complete);
    class MutableProjectInfoGovernance extends TestGovernance {
      override async getProjectInfo(projectId: string): Promise<ProjectInfo> {
        return { ...current, id: projectId };
      }
    }
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new MutableProjectInfoGovernance(),
      ),
    );
    await server.start();
    try {
      const values: Record<(typeof PROCESS_FACT_CASES)[number], string> = {
        processVersionId: "GJB_REF_V1",
        processProfileId: "GJB_REF_V1",
        processProfileVersion: "GJB_REF_V1",
        processProfileName: "GJB 参考流程 v1",
      };
      for (const key of PROCESS_FACT_CASES) {
        current = projectInfo({ ...complete, [key]: values[key] });
        const res = await postTaskRaw(server, {
          project_id: `p-free-${key}`,
          task: `invalid free ${key}`,
        });
        expect(res.status).toBe(409);
        expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_invalid");
      }
    } finally {
      await server.stop();
    }
  });

  test("request process strings conflict with Core explicit nulls", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    const requestKeys: Record<(typeof PROCESS_FACT_CASES)[number], string> = {
      processVersionId: "process_version_id",
      processProfileId: "process_profile_id",
      processProfileVersion: "process_profile_version",
      processProfileName: "process_profile_name",
    };
    await server.start();
    try {
      for (const key of PROCESS_FACT_CASES) {
        const res = await postTaskRaw(server, {
          project_id: `p-free-request-conflict-${key}`,
          project_type: "free",
          task: `conflicting request ${key}`,
          [requestKeys[key]]: key === "processProfileName" ? "GJB 参考流程 v1" : "GJB_REF_V1",
        });
        expect(res.status).toBe(409);
        expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_mismatch");
      }
    } finally {
      await server.stop();
    }
  });

  test("missing Core project_type cannot downgrade a complete GJB binding to free", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const res = await postTaskRaw(server, {
        project_id: "p-gjb-without-type",
        task: "must fail closed",
        mode: "agent",
      });
      expect(res.status).toBe(409);
      expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_type_missing");
    } finally {
      await server.stop();
    }
  });

  test("LEGACY_COMPAT uses the compatibility agent path instead of the GJB reference loop", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "LEGACY_COMPAT",
      processProfileId: "LEGACY_COMPAT",
      processProfileName: "兼容旧流程",
      processProfileVersion: "LEGACY_COMPAT",
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-legacy",
        process_instance_id: "pi-legacy",
        task: "continue legacy project",
      });
      createdAgentIds.push(agentId);
      const body = await getTask(server, agentId);
      expect(body["execution_mode"]).toBe("free");
      expect(body["project_type"]).toBe("engineering");
      expect(body["process_version_id"]).toBe("LEGACY_COMPAT");
      expect(body["status"]).toBe("idle");
    } finally {
      await server.stop();
    }
  });

  test("incomplete LEGACY_COMPAT facts fail closed instead of inferring compatibility", async () => {
    const complete: Partial<ProjectInfo> = {
      projectType: "engineering",
      processVersionId: "LEGACY_COMPAT",
      processProfileId: "LEGACY_COMPAT",
      processProfileName: "兼容旧流程",
      processProfileVersion: "LEGACY_COMPAT",
    };
    let current = projectInfo(complete);
    class MutableProjectInfoGovernance extends TestGovernance {
      override async getProjectInfo(projectId: string): Promise<ProjectInfo> {
        return { ...current, id: projectId };
      }
    }
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new MutableProjectInfoGovernance(),
      ),
    );
    await server.start();
    try {
      for (const key of PROCESS_FACT_CASES) {
        current = projectInfo({ ...complete, [key]: null });
        const res = await postTaskRaw(server, {
          project_id: `p-legacy-missing-${key}`,
          process_instance_id: `pi-legacy-missing-${key}`,
          task: `incomplete legacy ${key}`,
        });
        expect(res.status).toBe(409);
        expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_invalid");
      }
    } finally {
      await server.stop();
    }
  });

  test("modern engineering project with no target part does not inherit SYNTHIA_PART", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: null,
    }));
    const server = new RuntimeServer(
      makeConfig({ defaultPart: "must-not-be-invented" }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-no-part",
        process_instance_id: "pi-no-part",
        task: "engineering without selected device",
      });
      createdAgentIds.push(agentId);
      expect((await loadAgentState(agentId)).part).toBe("");
    } finally {
      await server.stop();
    }
  });

  test("conflicting frozen profile aliases fail closed", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "LEGACY_COMPAT",
      processProfileName: "conflicting flow",
      processProfileVersion: "GJB_REF_V1",
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const res = await postTaskRaw(server, {
        project_id: "p-conflicting-profile",
        process_instance_id: "pi-conflicting-profile",
        task: "bad frozen facts",
      });
      expect(res.status).toBe(409);
      expect((res.body.error as Record<string, unknown>)["code"]).toBe("project_process_profile_conflict");
    } finally {
      await server.stop();
    }
  });

  test("session snapshot reuses the same Core project read used for mode resolution", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    const envKeys = ["SYNTHIA_MODEL_URL", "SYNTHIA_MODEL_KEY", "SYNTHIA_MODEL_NAME"] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.SYNTHIA_MODEL_URL = "http://127.0.0.1:9/v1";
    process.env.SYNTHIA_MODEL_KEY = "test-key";
    process.env.SYNTHIA_MODEL_NAME = "test-model";
    await server.start();
    try {
      const beforeCreate = gov.readProjectInfoCount;
      const agentId = await postTask(server, {
        project_id: "p-session-frozen-facts",
        task: "fixed snapshot facts",
      });
      createdAgentIds.push(agentId);
      expect(gov.readProjectInfoCount - beforeCreate).toBe(1);

      const afterCreate = gov.readProjectInfoCount;
      const session = await (server as unknown as {
        getOrCreateSession(id: string): Promise<unknown>;
      }).getOrCreateSession(agentId);
      expect(session).not.toBeNull();
      // One read resolves this session. buildContextSnapshot must consume that
      // exact ProjectInfo instead of issuing another project read.
      expect(gov.readProjectInfoCount - afterCreate).toBe(1);
    } finally {
      await server.stop();
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("RuntimeServer — GET /tasks/:agentId detail fields", () => {
  test("response includes all required fields with correct shapes", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p1",
        process_instance_id: "pi-detail",
        task: "详细字段测试",
      });
      createdAgentIds.push(agentId);

      const body = await waitForStatus(server, agentId, ["succeeded"]);

      // Required fields
      expect(body["agent_id"]).toBe(agentId);
      expect(body["project_id"]).toBe("p1");
      expect(body["task"]).toBe("详细字段测试");
      expect(body["status"]).toBe("succeeded");
      expect(typeof body["current_stage"]).toBe("string");
      expect(body["awaiting_gate"]).toBeNull();
      expect(Array.isArray(body["audit"])).toBe(true);
      expect(Array.isArray(body["evidence"])).toBe(true);

      // docs entries: {phase, path, artifact_id, revision_id}
      const docs = body["docs"] as Record<string, unknown>[];
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(typeof doc["phase"]).toBe("string");
        expect(typeof doc["path"]).toBe("string");
        expect(typeof doc["artifact_id"]).toBe("string");
        expect(typeof doc["revision_id"]).toBe("string");
      }

      // audit capped at 50
      expect((body["audit"] as unknown[]).length).toBeLessThanOrEqual(50);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — GET /tasks list", () => {
  test("lists all agents with summary fields", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-list",
        process_instance_id: "pi-list",
        task: "列表测试",
      });
      createdAgentIds.push(agentId);
      await waitForStatus(server, agentId, ["succeeded"]);

      const res = await fetch(`${server.url}/tasks`);
      expect(res.status).toBe(200);
      const body = await res.json() as { agents: Record<string, unknown>[] };
      expect(body.agents.length).toBeGreaterThanOrEqual(1);

      const ourAgent = body.agents.find((r) => r.agent_id === agentId);
      expect(ourAgent).toBeDefined();
      expect(ourAgent!["project_id"]).toBe("p-list");
      expect(ourAgent!["status"]).toBe("succeeded");
      expect(typeof ourAgent!["current_stage"]).toBe("string");
      expect(typeof ourAgent!["created_at"]).toBe("string");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — approval auto-resume monitor", () => {
  test("awaiting_approval → approved → auto-resume → succeeded", async () => {
    const gov = new LegacyGateGovernance();
    gov.setSubmitResult("in_review"); // gates pause

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 50 }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-gate",
        process_instance_id: "pi-gate",
        task: "门禁流程测试",
      });
      createdAgentIds.push(agentId);

      // Wait for G1 pause
      await waitForStatus(server, agentId, ["awaiting_approval"]);

      // Approve G1; make subsequent gates auto-approve
      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "approved");
      gov.setSubmitResult("approved");

      // Monitor auto-resumes → full chain completes
      await waitForStatus(server, agentId, ["succeeded"], 20_000);
    } finally {
      await server.stop();
    }
  });

  test("rejected gate → fail_closed terminal", async () => {
    const gov = new LegacyGateGovernance();
    gov.setSubmitResult("in_review");

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 50 }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-reject",
        process_instance_id: "pi-reject",
        task: "拒绝测试",
      });
      createdAgentIds.push(agentId);

      await waitForStatus(server, agentId, ["awaiting_approval"]);

      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "rejected");

      // Monitor detects rejection → fail_closed
      const body = await waitForStatus(server, agentId, ["fail_closed"]);
      expect(body["reason"]).toContain("rejected");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — parallel agents", () => {
  test("two agents execute concurrently and both succeed", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId1 = await postTask(server, {
        project_id: "p-par",
        process_instance_id: "pi-par-1",
        task: "并行任务A",
      });
      createdAgentIds.push(agentId1);

      const agentId2 = await postTask(server, {
        project_id: "p-par",
        process_instance_id: "pi-par-2",
        task: "并行任务B",
      });
      createdAgentIds.push(agentId2);

      // Both should succeed independently
      await waitForStatus(server, agentId1, ["succeeded"], 15_000);
      await waitForStatus(server, agentId2, ["succeeded"], 15_000);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — restart recovery", () => {
  test("running agent on disk is recovered as interrupted", async () => {
    // Seed a agent-state file with status "running" on disk.
    const seedAgentId = "agent-test-recovery-001";
    const seedState = createAgentState({
      agentId: seedAgentId,
      task: "恢复测试",
      part: "xc7k70tfbv676-1",
      projectId: "p-recover",
      processInstanceId: "pi-recover",
    });
    await saveAgentState(seedState);
    createdAgentIds.push(seedAgentId);

    // Start a fresh server — recover() picks up the agent.
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      // The agent should be listed with status "interrupted".
      const body = await getTask(server, seedAgentId);
      expect(body["status"]).toBe("interrupted");
      expect(body["agent_id"]).toBe(seedAgentId);
      expect(body["reason"]).toContain("interrupted");

      // Also visible in the list.
      const listRes = await fetch(`${server.url}/tasks`);
      const listBody = await listRes.json() as { agents: Record<string, unknown>[] };
      const recovered = listBody.agents.find((r) => r.agent_id === seedAgentId);
      expect(recovered).toBeDefined();
      expect(recovered!["status"]).toBe("interrupted");
    } finally {
      await server.stop();
    }
  });

  test("a restarted Core-owned task fails closed, reports Core, and rejects messages", async () => {
    const projectId = "p-core-restart-fail-closed";
    const seedTaskId = `main-core-restart-${crypto.randomUUID()}`;
    const eventPayloads: Array<Readonly<Record<string, unknown>>> = [];
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId: seedTaskId,
      async appendEvent(input) {
        eventPayloads.push(input.payload);
        return {
          taskId: seedTaskId,
          eventId: input.eventId,
          sequence: eventPayloads.length,
          replayed: false,
        };
      },
    };
    const seedState = createAgentState({
      agentId: seedTaskId,
      taskId: seedTaskId,
      taskKind: "main",
      authorization: MAIN_TASK_AUTHORIZATION,
      inputHash: "a".repeat(64),
      taskDescriptorHash: "b".repeat(64),
      task: "must not remain a running zombie after restart",
      part: "",
      projectId,
      processInstanceId: `free:${projectId}`,
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      executionMode: "free",
    });
    await saveAgentState({ ...seedState, runtimeStarted: true });
    createdAgentIds.push(seedTaskId);

    const governance = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
      targetPart: null,
    }));
    const conversationalModel = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      async ({ taskId }) => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        ...(taskId === seedTaskId ? { taskEvents } : {}),
      }),
      () => conversationalModel,
    );
    await server.start();
    try {
      expect(await getTask(server, seedTaskId)).toMatchObject({
        status: "fail_closed",
        terminal_cause: "execution_error",
        reason: "task execution interrupted by Runtime restart",
      });
      expect(await loadAgentState(seedTaskId)).toMatchObject({
        status: "fail_closed",
        runtimeStarted: true,
        terminalCause: "execution_error",
      });
      expect(eventPayloads).toEqual([{
        status: "fail_closed",
        reason: "task execution interrupted by Runtime restart",
      }]);
      const message = await fetch(`${server.url}/tasks/${seedTaskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must not revive after restart" }),
      });
      expect(message.status).toBe(409);
      expect(((await message.json()) as { error: { code: string } }).error.code)
        .toBe("task_terminal");
      expect(conversationalModel.calls).toHaveLength(0);
    } finally {
      await server.stop();
      await deleteAgent(seedTaskId).catch(() => {});
    }
  });

  test("a restarted Project Agent ends only the interrupted turn and remains messageable", async () => {
    const projectId = "p-core-project-restart";
    const taskId = `project-restart-${crypto.randomUUID()}`;
    const base = createAgentState({
      agentId: taskId,
      taskId,
      taskKind: "main",
      agentRole: "project",
      task: "turn interrupted by restart",
      part: "xc7k70tfbv676-1",
      projectId,
      processInstanceId: "pi-project-restart",
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      executionMode: "engineering",
    });
    await saveAgentState({ ...base, runtimeStarted: true, status: "running" });
    const events: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];
    const taskEvents: TaskConversationClient = {
      projectId,
      taskId,
      async appendEvent(input) {
        events.push({ type: input.type, payload: input.payload });
        return { taskId, eventId: input.eventId, sequence: events.length, replayed: false };
      },
    };
    const governance = new EarlyGateProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
      targetPart: "xc7k70tfbv676-1",
    }), "pi-project-restart");
    const model = new RecordingConversationalModel();
    const server = new RuntimeServer(
      makeConfig(),
      async () => ({
        model: new CounterScriptedModel(),
        connector: new FakeVivadoConnector({ behavior: successBehavior() }),
        governance,
        taskEvents,
      }),
      () => model,
    );
    await server.start();
    try {
      const recovered = await getTask(server, taskId);
      expect(recovered.status).toBe("awaiting_user");
      expect(recovered.agent_role).toBe("project");
      expect(events).toContainEqual({
        type: "assistant_message",
        payload: { text: "[error] Project Agent turn was interrupted by Runtime restart" },
      });
      expect(events).toContainEqual({
        type: "status",
        payload: {
          status: "awaiting_user",
          reason: "Project Agent turn was interrupted by Runtime restart",
        },
      });
      expect(await loadAgentState(taskId)).toMatchObject({ status: "awaiting_user" });

      const followUp = await fetch(`${server.url}/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "continue after restart" }),
      });
      expect(followUp.status).toBe(200);
      expect((await waitForStatus(server, taskId, ["awaiting_user", "fail_closed"])).status)
        .toBe("awaiting_user");
      expect(model.calls).toHaveLength(1);
    } finally {
      await server.stop();
      await deleteAgent(taskId).catch(() => {});
    }
  });

  test("recovery refreshes missing project/profile facts from Core", async () => {
    const seedAgentId = "agent-test-core-facts-recovery-001";
    const base = createAgentState({
      agentId: seedAgentId,
      task: "恢复项目事实",
      part: "xc7k70tfbv676-1",
      projectId: "p-recover-facts",
      processInstanceId: "pi-recover-facts",
      executionMode: "free",
    });
    await saveAgentState({ ...base, status: "failed", endedReason: "seed" });
    createdAgentIds.push(seedAgentId);

    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB 参考流程 v1",
      processProfileVersion: "GJB_REF_V1",
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const body = await getTask(server, seedAgentId);
      expect(body["execution_mode"]).toBe("engineering");
      expect(body["project_type"]).toBe("engineering");
      expect(body["process_version_id"]).toBe("GJB_REF_V1");
      expect(body["process_profile_id"]).toBe("GJB_REF_V1");
      expect(gov.readProjectInfoCount).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test("recovery rejects a stored process string when Core freezes that field as null", async () => {
    const seedAgentId = "agent-test-null-fact-conflict-001";
    const base = createAgentState({
      agentId: seedAgentId,
      task: "恢复 null 冲突",
      part: "",
      projectId: "p-recover-null-conflict",
      processInstanceId: "free:p-recover-null-conflict",
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: "stale profile name",
      processProfileVersion: null,
      executionMode: "free",
    });
    await saveAgentState({ ...base, status: "failed", endedReason: "seed" });
    createdAgentIds.push(seedAgentId);

    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "free",
      processVersionId: null,
      processProfileId: null,
      processProfileName: null,
      processProfileVersion: null,
    }));
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks/${seedAgentId}`);
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("旧格式的自由 agent 状态（只有 freeAgentLock）恢复出 awaiting_gate", async () => {
    // 本次修复之前落盘的自由 agent 状态只写了 freeAgentLock，没有 awaitingGate。
    // 直接恢复会得到「等待批准但不知道等哪个门」，前端 shouldFetchSubmission
    // 首句短路 → 审批卡永不出现，阶段条也退回按 current_stage 画成需求阶段。
    const seedAgentId = "agent-test-legacy-lock-001";
    const base = createAgentState({
      agentId: seedAgentId,
      task: "旧格式锁恢复",
      part: "xc7k70tfbv676-1",
      projectId: "p-legacy-lock",
      processInstanceId: "pi-legacy-lock",
    });
    await saveAgentState({
      ...base,
      status: "awaiting_approval",
      freeAgentLock: { gate: "G4", submissionId: "sub-legacy-lock" },
    });
    createdAgentIds.push(seedAgentId);

    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const body = await getTask(server, seedAgentId);
      expect(body["status"]).toBe("awaiting_approval");
      expect(body["awaiting_gate"]).toBe("G4");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — resume endpoint", () => {
  test("POST /tasks/:agentId/resume is idempotent", async () => {
    const gov = new LegacyGateGovernance();
    gov.setSubmitResult("in_review");

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 500 }), // slow monitor so manual resume is tested
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-resume",
        process_instance_id: "pi-resume",
        task: "续跑幂等测试",
      });
      createdAgentIds.push(agentId);

      await waitForStatus(server, agentId, ["awaiting_approval"]);

      // Multiple resume calls should all return {resumed:true}
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${server.url}/tasks/${agentId}/resume`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { resumed: boolean };
        expect(body.resumed).toBe(true);
      }

      // Approve and let monitor auto-resume to completion
      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "approved");
      gov.setSubmitResult("approved");

      await waitForStatus(server, agentId, ["succeeded"], 20_000);
    } finally {
      await server.stop();
    }
  });

  test("resume returns 404 for unknown agent", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks/agent-nonexistent/resume`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — error handling", () => {
  test("GET /tasks/:agentId returns 404 for unknown agent", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks/agent-does-not-exist`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    } finally {
      await server.stop();
    }
  });

  test("POST /tasks returns 400 when task is missing", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "p1", process_instance_id: "pi1" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — resume from execution failure", () => {
  test("infra fail_closed → resume → succeeds from breakpoint stage", async () => {
    // Use no-governance (auto-approve) so the agent reaches tool stages.
    // The connector always fails synthesize → fail_closed (execution_error).
    const gov = new NoGovernanceClient();
    const failConnector = new FakeVivadoConnector({
      behavior: alwaysFailBehavior("synthesize"),
    });
    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 10_000 }), // slow monitor, no interference
      makeFactory(new CounterScriptedModel(), failConnector, gov),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-infra",
        process_instance_id: "pi-infra",
        task: "基础设施故障恢复测试",
      });
      createdAgentIds.push(agentId);

      // Run should fail_closed due to synthesize always failing.
      const failed = await waitForStatus(server, agentId, ["fail_closed", "failed"]);
      expect(failed["status"]).toMatch(/fail_closed|failed/);
      expect(failed["terminal_cause"]).toBe("execution_error");

      // Now swap to a working connector via a new server instance sharing
      // the same .runs/ dir. The failed run is recovered from disk, then
      // resume is called with a healthy connector.
      await server.stop();

      const okConnector = new FakeVivadoConnector({ behavior: successBehavior() });
      const server2 = new RuntimeServer(
        makeConfig({ gatePollMs: 10_000 }),
        makeFactory(new CounterScriptedModel(), okConnector, gov),
      );
      await server2.start();
      try {
        // The recovered agent should be fail_closed (not interrupted — it was
        // already terminal on disk).
        const recovered = await getTask(server2, agentId);
        expect(recovered["status"]).toMatch(/fail_closed|failed/);
        expect(recovered["terminal_cause"]).toBe("execution_error");

        // Resume should be accepted (not 409).
        const resumeRes = await fetch(`${server2.url}/tasks/${agentId}/resume`, {
          method: "POST",
        });
        expect(resumeRes.status).toBe(200);
        const resumeBody = await resumeRes.json() as { resumed: boolean };
        expect(resumeBody.resumed).toBe(true);

        // Run should now succeed with the healthy connector.
        const succeeded = await waitForStatus(server2, agentId, ["succeeded"], 20_000);
        expect(succeeded["status"]).toBe("succeeded");
      } finally {
        await server2.stop();
      }
    } finally {
      // server may already be stopped
      await server.reset().catch(() => {});
    }
  });

  test("gate rejected → resume returns 409 and does not execute", async () => {
    const gov = new LegacyGateGovernance();
    gov.setSubmitResult("in_review");

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 50 }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const agentId = await postTask(server, {
        project_id: "p-gate-rej",
        process_instance_id: "pi-gate-rej",
        task: "门禁拒绝不可恢复测试",
      });
      createdAgentIds.push(agentId);

      // Wait for G1 pause.
      await waitForStatus(server, agentId, ["awaiting_approval"]);

      // Reject G1 → monitor detects → fail_closed with governance_rejected.
      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "rejected");

      const rejected = await waitForStatus(server, agentId, ["fail_closed"]);
      expect(rejected["terminal_cause"]).toBe("governance_rejected");

      // POST resume → 409 not_resumable.
      const resumeRes = await fetch(`${server.url}/tasks/${agentId}/resume`, {
        method: "POST",
      });
      expect(resumeRes.status).toBe(409);
      const body = await resumeRes.json() as { error: { code: string } };
      expect(body.error.code).toBe("not_resumable");

      // Status should remain fail_closed (resume did not trigger execution).
      const stillRejected = await getTask(server, agentId);
      expect(stillRejected["status"]).toBe("fail_closed");
      expect(stillRejected["terminal_cause"]).toBe("governance_rejected");
    } finally {
      await server.stop();
    }
  });
});
