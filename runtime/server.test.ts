import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createServerConfig,
  RuntimeServer,
  type ServerConfig,
  type DepsFactory,
  type ServerStatus,
} from "./server.ts";
import { CounterScriptedModel } from "./deps.ts";
import { FakeVivadoConnector, successBehavior, alwaysFailBehavior } from "./loop.ts";
import { MockGovernanceClient } from "./governance-client.ts";
import { NoGovernanceClient } from "./types.ts";
import { createAgentState, saveAgentState, loadAgentState, deleteAgent } from "./agent-state.ts";
import type { SkillPrompts } from "./skill-loader.ts";
import type { AgentMessage, AgentTool, ChatTurn, ConversationalModel, FreeAgentSession } from "./agent-types.ts";
import type { ImportedMaterialSummary, ProjectInfo } from "./types.ts";
import type { GateSubmissionState } from "../core/src/domain/enums.ts";
import { sha256Hex } from "../core/src/hashing.ts";

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

  constructor(private readonly info: ProjectInfo) {
    super();
  }

  override async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    this.readProjectInfoCount++;
    return { ...this.info, id: projectId };
  }
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
    toolModelPolicyHash: "test-policy-v1",
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

class RecordingConversationalModel implements ConversationalModel {
  readonly calls: Array<{ messages: readonly AgentMessage[]; tools: readonly AgentTool[] }> = [];

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    return { kind: "text", content: "ok" };
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
  while (Date.now() < deadline) {
    const body = await getTask(server, agentId);
    if (statuses.includes(body.status as ServerStatus)) return body;
    await Bun.sleep(30);
  }
  throw new Error(
    `timeout waiting for status ${statuses.join("|")} (agent ${agentId})`,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let agentsDir: string;
const createdAgentIds: string[] = [];

beforeAll(async () => {
  agentsDir = await mkdtemp(join(tmpdir(), "synthia-runtime-test-"));
  process.env.SYNTHIA_RUNS_DIR = agentsDir;
});

afterAll(async () => {
  for (const agentId of createdAgentIds) {
    await deleteAgent(agentId).catch(() => {});
  }
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

describe("RuntimeServer — historical-material session rollout gate", () => {
  test("default-off engineering sessions never query or inject historical material", async () => {
    const project = projectInfo({
      id: "p-history-off",
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
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
      processProfileName: "GJB reference flow",
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
    expect(model.calls[0]!.messages.some((message) => message.content?.includes("FREE-MODE-MUST-NOT-LOAD"))).toBe(false);
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
        process_profile_name: "GJB reference flow",
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
        processProfileName: "GJB reference flow",
        processProfileVersion: "GJB_REF_V1",
      });
    } finally {
      await server.stop();
    }
  });

  test("Core engineering project facts override mode=agent and run the governed loop", async () => {
    const gov = new ProjectInfoGovernance(projectInfo({
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
      processProfileVersion: "GJB_REF_V1",
      targetPart: "xc7k70tfbv676-1",
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
        project_id: "p-core-eng",
        process_instance_id: "pi-core-eng",
        task: "Core says engineering",
        mode: "agent",
      });
      createdAgentIds.push(agentId);

      const body = await waitForStatus(server, agentId, ["awaiting_approval", "succeeded"]);
      expect(body["execution_mode"]).toBe("engineering");
      expect(body["project_type"]).toBe("engineering");
      expect(body["process_version_id"]).toBe("GJB_REF_V1");
      expect(gov.readProjectInfoCount).toBeGreaterThan(0);
    } finally {
      await server.stop();
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
      processProfileName: "GJB reference flow",
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
        processProfileName: "GJB reference flow",
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
          [requestKeys[key]]: key === "processProfileName" ? "GJB reference flow" : "GJB_REF_V1",
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
      processProfileName: "GJB reference flow",
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
    const gov = new TestGovernance();
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
    const gov = new TestGovernance();
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
      processProfileName: "GJB reference flow",
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
    const gov = new TestGovernance();
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
    const gov = new TestGovernance();
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
