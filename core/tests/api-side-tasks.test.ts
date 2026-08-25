import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  ConnectorError,
  type ConnectorDiscovery,
  type ConnectorJobSnapshot,
  type ConnectorPort,
  type EvidenceContent,
  type EvidenceManifest,
  type SubmitJobParams,
} from "../src/api/connector-port.ts";
import {
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeAgentDetail,
  type RuntimeListResponse,
} from "../src/api/task-proxy.ts";
import { startSynthiaServer } from "../src/api/server.ts";
import { canonicalRequestHash, sha256Hex } from "../src/hashing.ts";
import { headSha } from "../src/workspace/git.ts";
import { projectWorkspaceDir } from "../src/workspace/paths.ts";
import { writeAndCommit } from "../src/workspace/store.ts";
import { taskWorkspaceDir } from "../src/workspace/task-store.ts";
import {
  apiCall,
  setupApiHarness,
  teardownApiHarness,
  truncateDomainTables,
  type ApiHarness,
} from "./support/api-harness.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

class P3RuntimeFake implements RuntimeClient {
  readonly created: Record<string, unknown>[] = [];
  readonly started: string[] = [];
  readonly listRequests: string[] = [];
  readonly getRequests: string[] = [];
  readonly messages: { taskId: string; text: string; idempotencyKey?: string }[] = [];
  readonly abortRequests: string[] = [];
  readonly abortIdempotencyKeys: Array<string | undefined> = [];
  readonly abortEffects: string[] = [];
  readonly abortResponses = new Map<string, unknown>();
  readonly streamRequests: string[] = [];
  readonly runtimeOnly = new Map<string, RuntimeAgentDetail>();
  listError: RuntimeClientError | null = null;
  getError: RuntimeClientError | null = null;
  startError: RuntimeClientError | null = null;
  messageError: RuntimeClientError | null = null;
  failAbortAfterAcceptOnce = false;
  onCreate: ((body: Record<string, unknown>) => Promise<void>) | null = null;
  onStart: ((taskId: string) => Promise<void>) | null = null;

  reset(): void {
    this.created.length = 0;
    this.started.length = 0;
    this.listRequests.length = 0;
    this.getRequests.length = 0;
    this.messages.length = 0;
    this.abortRequests.length = 0;
    this.abortIdempotencyKeys.length = 0;
    this.abortEffects.length = 0;
    this.abortResponses.clear();
    this.streamRequests.length = 0;
    this.runtimeOnly.clear();
    this.listError = null;
    this.getError = null;
    this.startError = null;
    this.messageError = null;
    this.failAbortAfterAcceptOnce = false;
    this.onCreate = null;
    this.onStart = null;
  }

  async createTask(body: {
    project_id: string;
    task: string;
    task_id?: string;
  } & Record<string, unknown>): Promise<{ agent_id: string }> {
    this.created.push(body);
    if (this.onCreate) await this.onCreate(body);
    return { agent_id: body.task_id ?? `legacy-${randomUUID()}` };
  }

  async startTask(taskId: string): Promise<{ started: boolean; status: "running" }> {
    this.started.push(taskId);
    if (this.onStart) await this.onStart(taskId);
    if (this.startError) throw this.startError;
    return { started: true, status: "running" };
  }

  seedRuntimeOnly(detail: RuntimeAgentDetail): void {
    this.runtimeOnly.set(detail.agent_id, detail);
  }

  async listTasks(projectId: string): Promise<RuntimeListResponse> {
    this.listRequests.push(projectId);
    if (this.listError) throw this.listError;
    const coreBacked = this.created
      .filter((row) => row.project_id === projectId)
      .map((row) => ({
        agent_id: String(row.task_id),
        project_id: String(row.project_id),
        status: "running" as const,
        kind: row.task_kind as "main" | "side",
        parent_task_id: row.parent_task_id as string | undefined,
        workspace_id: row.workspace_id as string | undefined,
      }));
    const legacy = [...this.runtimeOnly.values()]
      .filter((row) => row.project_id === projectId)
      .map((row) => ({
        agent_id: row.agent_id,
        project_id: row.project_id,
        status: row.status,
        current_stage: row.current_stage,
        kind: row.kind,
        parent_task_id: row.parent_task_id,
        workspace_id: row.workspace_id,
      }));
    return { agents: [...coreBacked, ...legacy] };
  }

  async getTask(agentId: string): Promise<RuntimeAgentDetail> {
    this.getRequests.push(agentId);
    if (this.getError) throw this.getError;
    const runtimeOnly = this.runtimeOnly.get(agentId);
    if (runtimeOnly) return runtimeOnly;
    const created = this.created.find((row) => row.task_id === agentId);
    if (!created) {
      throw new RuntimeClientError(404, `agent not found: ${agentId}`, {
        code: "AGENT_NOT_FOUND",
        retryable: false,
      });
    }
    return {
      agent_id: agentId,
      project_id: String(created.project_id),
      status: "running",
      kind: created.task_kind as "main" | "side",
      parent_task_id: created.parent_task_id as string | undefined,
      workspace_id: created.workspace_id as string | undefined,
    };
  }

  async sendMessage(taskId: string, text: string, idempotencyKey?: string): Promise<unknown> {
    this.messages.push({
      taskId,
      text,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (this.messageError) throw this.messageError;
    return { accepted: true };
  }

  async abortTask(taskId: string, idempotencyKey?: string): Promise<unknown> {
    this.abortRequests.push(taskId);
    this.abortIdempotencyKeys.push(idempotencyKey);
    const replayKey = `${taskId}\0${idempotencyKey ?? ""}`;
    const replay = this.abortResponses.get(replayKey);
    if (replay) return replay;
    const response = { aborted: true };
    this.abortEffects.push(taskId);
    this.abortResponses.set(replayKey, response);
    if (this.failAbortAfterAcceptOnce) {
      this.failAbortAfterAcceptOnce = false;
      throw new RuntimeClientError(503, "runtime abort response lost", { retryable: true });
    }
    return response;
  }

  async streamTask(taskId: string): Promise<Response> {
    this.streamRequests.push(taskId);
    return new Response("event: done\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }
}

class P3ConnectorFake implements ConnectorPort {
  readonly connectorId = "p3-fake-connector";
  readonly submissions: SubmitJobParams[] = [];
  readonly accepted = new Map<string, SubmitJobParams>();
  failAfterAcceptOnce = false;

  reset(): void {
    this.submissions.length = 0;
    this.accepted.clear();
    this.failAfterAcceptOnce = false;
  }

  async discover(): Promise<ConnectorDiscovery> {
    return {
      capabilities: [
        { operation: "validate_sources", version: "fake-1", runClasses: ["exploratory"] },
        { operation: "simulate", version: "fake-1", runClasses: ["exploratory"] },
      ],
      drift: false,
    };
  }

  async submitJob(params: SubmitJobParams): Promise<ConnectorJobSnapshot> {
    this.submissions.push(params);
    const accepted = this.accepted.get(params.jobId);
    if (accepted && canonicalRequestHash(accepted) !== canonicalRequestHash(params)) {
      throw new ConnectorError("IDEMPOTENCY_CONFLICT", "same job id received a different request");
    }
    if (!accepted) this.accepted.set(params.jobId, params);
    if (this.failAfterAcceptOnce) {
      this.failAfterAcceptOnce = false;
      throw new ConnectorError("REMOTE_UNAVAILABLE", "response lost after accept", true);
    }
    return { jobId: params.jobId, state: "queued" };
  }

  async queryStatus(_projectId: string, jobId: string): Promise<ConnectorJobSnapshot> {
    return { jobId, state: "succeeded" };
  }

  async fetchEvidence(_projectId: string, jobId: string): Promise<EvidenceManifest> {
    return { jobId, entries: [] };
  }

  async fetchEvidenceContent(_projectId: string, _jobId: string, name: string): Promise<EvidenceContent> {
    return { name, content: "", sha256: "0".repeat(64), truncated: false, mediaType: "text/plain" };
  }
}

describe.skipIf(!DATABASE_URL)("P3 side task API — PostgreSQL + isolated Git clone", () => {
  let harness: ApiHarness;
  let runtime: P3RuntimeFake;
  let connector: P3ConnectorFake;

  beforeAll(async () => {
    runtime = new P3RuntimeFake();
    connector = new P3ConnectorFake();
    harness = await setupApiHarness(DATABASE_URL, {
      features: { sideTasks: true },
      runtimeClient: runtime,
      connector,
    });
  });

  beforeEach(async () => {
    await truncateDomainTables(harness.client);
    runtime.reset();
    connector.reset();
  });

  afterAll(async () => {
    if (harness) await teardownApiHarness(harness);
  });

  async function post(path: string, body: unknown, key = randomUUID(), service = false) {
    return apiCall(harness.baseUrl, path, {
      method: "POST",
      token: service ? harness.ids.serviceToken : harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body,
    });
  }

  function data<T extends Record<string, unknown>>(json: unknown): T {
    const value = json as { data?: T };
    if (!value?.data) throw new Error(`missing data: ${JSON.stringify(json)}`);
    return value.data;
  }

  function error(json: unknown): { code: string; message: string; details: unknown } {
    const value = json as { error?: { code: string; message: string; details: unknown } };
    if (!value?.error) throw new Error(`missing error: ${JSON.stringify(json)}`);
    return value.error;
  }

  async function seedEngineeringWorkspace(): Promise<{ projectId: string; baseCommit: string }> {
    const projectId = `p3-${randomUUID()}`;
    const created = await post("/api/v1/projects", {
      id: projectId,
      name: "P3 integration",
      project_type: "engineering",
      process_profile_id: "GJB_REF_V1",
    });
    expect(created.status).toBe(201);
    const seeded = await post(`/api/v1/projects/${projectId}/workspace/files`, {
      files: [
        { path: "rtl/a.v", content: "module a; assign y = 1'b0; endmodule\n" },
        { path: "rtl/b.v", content: "module b; assign y = 1'b0; endmodule\n" },
      ],
      change_reason: "seed controlled mainline",
    });
    expect(seeded.status).toBe(200);
    const baseCommit = await headSha(projectWorkspaceDir(projectId));
    if (!baseCommit) throw new Error("missing project HEAD");
    return { projectId, baseCommit };
  }

  async function seedProject(): Promise<{
    projectId: string;
    mainTaskId: string;
    baseCommit: string;
  }> {
    const { projectId, baseCommit } = await seedEngineeringWorkspace();
    const main = await post(`/api/v1/projects/${projectId}/tasks`, {
      task: "推进工程主线",
    });
    expect(main.status).toBe(201);
    const mainData = data(main.json);
    const mainTaskId = String(mainData.task_id);
    expect(runtime.created.at(-1)?.input_hash).toBe(mainData.input_hash);
    expect(mainData.input_hash).toMatch(/^[0-9a-f]{64}$/);
    return { projectId, mainTaskId, baseCommit };
  }

  async function createSide(
    seeded: Awaited<ReturnType<typeof seedProject>>,
    writePaths = ["rtl/a.v", "rtl/b.v"],
  ): Promise<Record<string, unknown>> {
    await harness.client.query(
      "UPDATE agent_task SET status='awaiting_user',updated_at=now() WHERE id=$1 AND status='running'",
      [seeded.mainTaskId],
    );
    const response = await post(
      `/api/v1/projects/${seeded.projectId}/tasks`,
      sideCreateBody(seeded, writePaths),
    );
    expect(response.status).toBe(201);
    return data(response.json);
  }

  function sideCreateBody(
    seeded: Awaited<ReturnType<typeof seedProject>>,
    writePaths = ["rtl/a.v", "rtl/b.v"],
  ): Record<string, unknown> {
    return {
      kind: "side",
      parent_task_id: seeded.mainTaskId,
      objective: "比较并修改两个 RTL 文件",
      base_commit: seeded.baseCommit,
      authorization_scope: {
        schema: "task-scope.v1",
        workspace: "isolated",
        read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
        write_paths: writePaths,
        run_classes: ["exploratory"],
        can_submit_gates: false,
        can_create_milestones: false,
        can_start_formal_runs: false,
      },
    };
  }

  function runtimeHeaders(side: Record<string, unknown>, key = randomUUID()): Record<string, string> {
    return {
      authorization: `Bearer ${harness.ids.taskRuntimeToken}`,
      "idempotency-key": key,
      "x-synthia-task-id": String(side.task_id),
      "x-synthia-workspace-id": String(side.workspace_id),
    };
  }

  async function writeAndFinalize(
    seeded: Awaited<ReturnType<typeof seedProject>>,
    side: Record<string, unknown>,
    workspaceFiles: readonly { readonly path: string; readonly content: string }[] = [
      { path: "rtl/a.v", content: "module a; assign y = 1'b1; endmodule\n" },
      { path: "rtl/b.v", content: "module b; assign y = 1'b1; endmodule\n" },
    ],
  ): Promise<Record<string, unknown>> {
    const taskId = String(side.task_id);
    const files = {
      files: workspaceFiles,
      change_reason: "explore alternate constants",
    };
    const key = randomUUID();
    const first = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/workspace/files`,
      { method: "POST", headers: runtimeHeaders(side, key), body: files },
    );
    expect(first.status).toBe(200);
    const replay = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/workspace/files`,
      { method: "POST", headers: runtimeHeaders(side, key), body: files },
    );
    expect(replay.status).toBe(200);
    expect(data(replay.json)).toEqual(data(first.json));

    const finalized = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/result`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: { summary: "两个方案均通过静态检查", tests: [{ name: "lint", status: "passed" }] },
      },
    );
    expect(finalized.status).toBe(201);
    return data(finalized.json);
  }

  async function seedApplyingAdoption(options: {
    readonly expectedTargetHash?: string | null;
    readonly addedPath?: boolean;
  } = {}) {
    const seeded = await seedProject();
    const selectedPath = options.addedPath ? "doc/new-note.md" : "rtl/a.v";
    const side = await createSide(
      seeded,
      options.addedPath ? [selectedPath] : ["rtl/a.v", "rtl/b.v"],
    );
    const result = await writeAndFinalize(
      seeded,
      side,
      options.addedPath
        ? [{ path: selectedPath, content: "new exploration note\n" }]
        : undefined,
    );
    const diff = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/diff`,
      { token: harness.ids.humanToken },
    );
    const preview = data<{
      preview_hash: string;
      files: Array<{
        path: string;
        base_hash: string | null;
        result_hash: string;
        current_target_hash: string | null;
      }>;
    }>(diff.json);
    const selected = preview.files.find((file) => file.path === selectedPath)!;
    const adoptionId = `adopt-${randomUUID()}`;
    const reason = "recover only a proven adoption commit";
    const expectedTargetHash = Object.prototype.hasOwnProperty.call(options, "expectedTargetHash")
      ? options.expectedTargetHash!
      : selected.current_target_hash;
    const files = [{
      path: selected.path,
      expected_base_hash: selected.base_hash,
      expected_proposed_hash: selected.result_hash,
      expected_target_hash: expectedTargetHash,
    }];
    const selectionHash = canonicalRequestHash({
      schema: "task-adoption-selection.v1",
      taskId: side.task_id,
      resultId: result.result_id,
      previewHash: preview.preview_hash,
      files,
    });
    await harness.client.query(
      `INSERT INTO task_adoption
         (id,project_id,task_id,result_id,state,selection_hash,project_commit_before,
          reason,details,created_by_type,created_by,created_at)
       VALUES ($1,$2,$3,$4,'applying',$5,$6,$7,$8::jsonb,'human',$9,now())`,
      [
        adoptionId,
        seeded.projectId,
        side.task_id,
        result.result_id,
        selectionHash,
        seeded.baseCommit,
        reason,
        JSON.stringify({ preview_hash: preview.preview_hash, files }),
        harness.ids.humanUid,
      ],
    );
    return { seeded, side, result, preview, adoptionId, reason, files };
  }

  test("P3 engineering create rejects an active legacy Runtime main before either side writes", async () => {
    const seeded = await seedEngineeringWorkspace();
    const legacyMainId = `legacy-main-${randomUUID()}`;
    runtime.seedRuntimeOnly({
      agent_id: legacyMainId,
      project_id: seeded.projectId,
      status: "idle",
      kind: "main",
    });

    const createdBefore = runtime.created.length;
    const response = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
      task: "不得开启第二条工程主线",
    });
    expect(response.status).toBe(409);
    expect(error(response.json)).toMatchObject({
      code: "conflict",
      message: "ENGINEERING_MAIN_AGENT_EXISTS",
      details: {
        projectId: seeded.projectId,
        taskId: legacyMainId,
        source: "runtime_legacy",
      },
    });
    expect(runtime.created).toHaveLength(createdBefore);
    const coreTasks = await harness.client.query(
      "SELECT id FROM agent_task WHERE project_id=$1",
      [seeded.projectId],
    );
    expect(coreTasks.rows).toHaveLength(0);
  });

  test("P3 engineering main commits before Runtime create and binds before explicit start", async () => {
    const seeded = await seedEngineeringWorkspace();
    let atCreate: Record<string, unknown> | null = null;
    let atStart: Record<string, unknown> | null = null;

    runtime.onCreate = async (body) => {
      const visible = await harness.client.query(
        "SELECT status,runtime_agent_id FROM agent_task WHERE id=$1 AND project_id=$2",
        [body.task_id, seeded.projectId],
      );
      atCreate = visible.rows[0] as Record<string, unknown> | undefined ?? null;
    };
    runtime.onStart = async (taskId) => {
      const bound = await harness.client.query(
        "SELECT status,runtime_agent_id FROM agent_task WHERE id=$1 AND project_id=$2",
        [taskId, seeded.projectId],
      );
      atStart = bound.rows[0] as Record<string, unknown> | undefined ?? null;
    };

    const response = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
      task: "提交 Core 事实后再启动",
    });
    expect(response.status).toBe(201);
    const created = data(response.json);
    expect(atCreate).toMatchObject({ status: "queued", runtime_agent_id: null });
    expect(atStart).toMatchObject({
      status: "queued",
      runtime_agent_id: created.task_id,
    });
    expect(runtime.created.at(-1)).toMatchObject({
      task_id: created.task_id,
      task_kind: "main",
      task: "提交 Core 事实后再启动",
    });
    expect(runtime.started).toEqual([created.task_id]);
    expect(runtime.messages).toEqual([]);
    expect(created.status).toBe("running");
  });

  test("P3 free main dispatches its first objective through register then explicit start", async () => {
    const projectId = `p3-free-${randomUUID()}`;
    const project = await post("/api/v1/projects", {
      id: projectId,
      name: "P3 free objective dispatch",
      project_type: "free",
    });
    expect(project.status).toBe(201);

    const objective = "在自由模式下首次执行这条目标";
    const response = await post(`/api/v1/projects/${projectId}/tasks`, { task: objective });
    expect(response.status).toBe(201);
    const created = data(response.json);
    expect(runtime.created).toEqual([
      expect.objectContaining({
        task_id: created.task_id,
        task_kind: "main",
        project_id: projectId,
        project_type: "free",
        mode: "agent",
        task: objective,
      }),
    ]);
    expect(runtime.started).toEqual([created.task_id]);
    expect(runtime.messages).toEqual([]);

    const event = await harness.client.query(
      `SELECT event_kind,payload
         FROM task_conversation_event
        WHERE project_id=$1 AND task_id=$2
        ORDER BY sequence`,
      [projectId, created.task_id],
    );
    expect(event.rows).toEqual([
      {
        event_kind: "user_message",
        payload: { text: objective, source: "main_task_objective" },
      },
    ]);
  });

  test("P3 main replay repairs a start failure without duplicating Core facts", async () => {
    const seeded = await seedEngineeringWorkspace();
    const key = randomUUID();
    const body = { task: "启动失败后用同一请求补做" };
    runtime.startError = new RuntimeClientError(503, "runtime start unavailable", {
      retryable: true,
    });

    const first = await post(`/api/v1/projects/${seeded.projectId}/tasks`, body, key);
    expect(first.status).toBe(503);
    const afterFailure = await harness.client.query(
      "SELECT id,status,runtime_agent_id FROM agent_task WHERE project_id=$1",
      [seeded.projectId],
    );
    expect(afterFailure.rows).toHaveLength(1);
    expect(afterFailure.rows[0]).toMatchObject({ status: "queued" });
    expect(afterFailure.rows[0].runtime_agent_id).toBe(afterFailure.rows[0].id);

    runtime.startError = null;
    const replay = await post(`/api/v1/projects/${seeded.projectId}/tasks`, body, key);
    expect(replay.status).toBe(201);
    const replayed = data(replay.json);
    expect(replayed.task_id).toBe(afterFailure.rows[0].id);
    expect(replayed.status).toBe("running");
    expect(runtime.created).toHaveLength(2);
    expect(runtime.started).toEqual([replayed.task_id, replayed.task_id]);

    const facts = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM agent_task WHERE project_id=$1) AS tasks,
         (SELECT COUNT(*)::int FROM task_conversation_event WHERE project_id=$1) AS events,
         (SELECT COUNT(*)::int FROM outbox_events WHERE project_id=$1 AND event_type='task.created') AS outbox`,
      [seeded.projectId],
    );
    expect(facts.rows[0]).toMatchObject({ tasks: 1, events: 1, outbox: 1 });
  });

  test("P3 side replay repairs a post-commit start failure without duplicating Core facts", async () => {
    const seeded = await seedProject();
    await harness.client.query(
      "UPDATE agent_task SET status='awaiting_user',updated_at=now() WHERE id=$1 AND status='running'",
      [seeded.mainTaskId],
    );
    const key = randomUUID();
    const body = sideCreateBody(seeded);
    runtime.startError = new RuntimeClientError(503, "runtime side start unavailable", {
      retryable: true,
    });

    const first = await post(`/api/v1/projects/${seeded.projectId}/tasks`, body, key);
    expect(first.status).toBe(503);
    const afterFailure = await harness.client.query(
      `SELECT t.id,t.status,t.runtime_agent_id,t.workspace_id,w.state AS workspace_state
         FROM agent_task t
         JOIN task_workspace w ON w.id=t.workspace_id AND w.task_id=t.id
        WHERE t.project_id=$1 AND t.kind='side'`,
      [seeded.projectId],
    );
    expect(afterFailure.rows).toHaveLength(1);
    expect(afterFailure.rows[0]).toMatchObject({
      status: "queued",
      workspace_state: "active",
    });
    expect(afterFailure.rows[0].runtime_agent_id).toBe(afterFailure.rows[0].id);

    runtime.startError = null;
    const replay = await post(`/api/v1/projects/${seeded.projectId}/tasks`, body, key);
    expect(replay.status).toBe(201);
    const replayed = data(replay.json);
    expect(replayed.task_id).toBe(afterFailure.rows[0].id);
    expect(replayed.status).toBe("running");
    expect(runtime.created.filter((request) => request.task_kind === "side")).toHaveLength(2);
    expect(runtime.started.slice(-2)).toEqual([replayed.task_id, replayed.task_id]);
    expect(runtime.messages).toEqual([]);

    const facts = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM agent_task WHERE project_id=$1 AND kind='side') AS tasks,
         (SELECT COUNT(*)::int FROM task_workspace WHERE project_id=$1 AND task_id=$2) AS workspaces,
         (SELECT COUNT(*)::int FROM task_conversation_event WHERE project_id=$1 AND task_id=$2) AS events,
         (SELECT COUNT(*)::int FROM outbox_events
           WHERE project_id=$1 AND aggregate_id=$2 AND event_type='side_task.created') AS outbox`,
      [seeded.projectId, replayed.task_id],
    );
    expect(facts.rows[0]).toMatchObject({ tasks: 1, workspaces: 1, events: 1, outbox: 1 });
  });

  test("Runtime state written during registration is not overwritten by binding or start bookkeeping", async () => {
    const seeded = await seedEngineeringWorkspace();
    runtime.onCreate = async (body) => {
      await harness.client.query(
        `UPDATE agent_task
            SET status='running',current_stage='runtime_callback',updated_at=now()
          WHERE id=$1 AND project_id=$2`,
        [body.task_id, seeded.projectId],
      );
    };

    const response = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
      task: "保留先到达的 Runtime 状态",
    });
    expect(response.status).toBe(201);
    expect(data(response.json)).toMatchObject({
      status: "running",
    });
    const row = await harness.client.query(
      "SELECT status,current_stage,runtime_agent_id FROM agent_task WHERE project_id=$1",
      [seeded.projectId],
    );
    expect(row.rows[0]).toMatchObject({
      status: "running",
      current_stage: "runtime_callback",
    });
    expect(row.rows[0].runtime_agent_id).toBe(runtime.started[0]);
  });

  test("P3 engineering create ignores Runtime side, unknown kind, and terminal legacy mains", async () => {
    const seeded = await seedEngineeringWorkspace();
    runtime.seedRuntimeOnly({
      agent_id: `legacy-side-${randomUUID()}`,
      project_id: seeded.projectId,
      status: "running",
      kind: "side",
      parent_task_id: `legacy-parent-${randomUUID()}`,
      workspace_id: `legacy-workspace-${randomUUID()}`,
    });
    runtime.seedRuntimeOnly({
      agent_id: `unknown-kind-${randomUUID()}`,
      project_id: seeded.projectId,
      status: "running",
      kind: "unknown" as never,
    });
    runtime.seedRuntimeOnly({
      agent_id: `finished-main-${randomUUID()}`,
      project_id: seeded.projectId,
      status: "succeeded",
      kind: "main",
    });

    const response = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
      task: "建立唯一有效主线",
    });
    expect(response.status).toBe(201);
    expect(runtime.created).toHaveLength(1);
    const coreTasks = await harness.client.query(
      "SELECT id,kind,status FROM agent_task WHERE project_id=$1",
      [seeded.projectId],
    );
    expect(coreTasks.rows).toEqual([
      expect.objectContaining({ kind: "main", status: "running" }),
    ]);
  });

  test("P3 engineering create trusts a terminal Core fact over a stale Runtime handle", async () => {
    const seeded = await seedProject();
    await harness.client.query(
      `UPDATE agent_task
          SET status='failed',finished_at=now(),updated_at=now()
        WHERE id=$1 AND project_id=$2`,
      [seeded.mainTaskId, seeded.projectId],
    );

    const response = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
      task: "前一条主线已由 Core 关闭，建立新主线",
    });
    expect(response.status).toBe(201);
    expect(runtime.created).toHaveLength(2);
    const activeCore = await harness.client.query(
      `SELECT id FROM agent_task
        WHERE project_id=$1 AND kind='main'
          AND status IN ('queued','running','awaiting_user')`,
      [seeded.projectId],
    );
    expect(activeCore.rows).toHaveLength(1);
    expect(activeCore.rows[0].id).not.toBe(seeded.mainTaskId);
  });

  test("main awaiting_user can spawn side; side writes never touch main or revisions", async () => {
    const seeded = await seedProject();
    const revisionBefore = await harness.client.query(
      "SELECT COUNT(*)::int AS count FROM artifact_revision WHERE project_id=$1",
      [seeded.projectId],
    );
    const side = await createSide(seeded);
    expect(side).toMatchObject({
      kind: "side",
      parent_task_id: seeded.mainTaskId,
      status: "running",
      workspace_state: "active",
      adoption_state: "pending",
      base_commit: seeded.baseCommit,
    });
    expect(runtime.created.at(-1)).toMatchObject({
      task_id: side.task_id,
      task_kind: "side",
      parent_task_id: seeded.mainTaskId,
      workspace_id: side.workspace_id,
      mode: "agent",
      input_hash: side.input_hash,
      authorization_scope: {
        schema: "task-scope.v1",
        workspace: "isolated",
        read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
        write_paths: ["rtl/a.v", "rtl/b.v"],
        run_classes: ["exploratory"],
        can_submit_gates: false,
        can_create_milestones: false,
        can_start_formal_runs: false,
      },
    });
    expect(side.authorization_scope).toEqual(runtime.created.at(-1)?.authorization_scope);
    expect(runtime.created.at(-1)?.task).toBe("比较并修改两个 RTL 文件");
    expect(runtime.started.at(-1)).toBe(side.task_id);
    expect(runtime.messages).toEqual([]);

    const isolatedDir = taskWorkspaceDir(seeded.projectId, String(side.workspace_id));
    await mkdir(`${isolatedDir}/sim`, { recursive: true });
    await writeFile(`${isolatedDir}/sim/secret.txt`, "must not be readable\n", "utf8");
    const forbiddenRead = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/file?path=sim%2Fsecret.txt`,
      { headers: runtimeHeaders(side) },
    );
    expect(forbiddenRead.status).toBe(403);
    const filteredTree = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/tree`,
      { headers: runtimeHeaders(side) },
    );
    expect(data<{ files: Array<{ path: string }> }>(filteredTree.json).files.some((file) => file.path === "sim/secret.txt")).toBe(false);

    const wrongScope = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/files`,
      {
        method: "POST",
        headers: runtimeHeaders({ ...side, workspace_id: "wrong" }),
        body: { files: [{ path: "rtl/a.v", content: "bad" }] },
      },
    );
    expect(wrongScope.status).toBe(404);

    await writeAndFinalize(seeded, side);
    const mainA = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/workspace/file?path=rtl%2Fa.v`,
      { token: harness.ids.humanToken },
    );
    expect(data(mainA.json).content).toContain("1'b0");
    expect(await headSha(projectWorkspaceDir(seeded.projectId))).toBe(seeded.baseCommit);
    const revisionAfter = await harness.client.query(
      "SELECT COUNT(*)::int AS count FROM artifact_revision WHERE project_id=$1",
      [seeded.projectId],
    );
    expect(revisionAfter.rows[0].count).toBe(revisionBefore.rows[0].count);

    const detail = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}`,
      { token: harness.ids.humanToken },
    );
    expect(detail.status).toBe(200);
    expect(data(detail.json)).toMatchObject({
      status: "succeeded",
      workspace_state: "sealed",
      adoption_state: "available",
    });
  });

  test("Runtime callbacks require the persisted actor, task, and workspace binding", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const sideTaskId = String(side.task_id);
    const workspaceId = String(side.workspace_id);
    const bindings = await harness.client.query(
      `SELECT id,runtime_agent_id,runtime_actor_id,workspace_id
         FROM agent_task
        WHERE id IN ($1,$2)
        ORDER BY id`,
      [seeded.mainTaskId, sideTaskId],
    );
    expect(bindings.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: seeded.mainTaskId,
        runtime_agent_id: seeded.mainTaskId,
        runtime_actor_id: harness.ids.serviceUid,
        workspace_id: null,
      }),
      expect.objectContaining({
        id: sideTaskId,
        runtime_agent_id: sideTaskId,
        runtime_actor_id: harness.ids.serviceUid,
        workspace_id: workspaceId,
      }),
    ]));
    await expect(harness.client.query(
      "UPDATE agent_task SET runtime_actor_id=$2 WHERE id=$1",
      [sideTaskId, harness.ids.secondServiceUid],
    )).rejects.toThrow("agent task identity/input is immutable");

    const mainCallback = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.ids.taskRuntimeToken}`,
          "idempotency-key": randomUUID(),
          "x-synthia-task-id": seeded.mainTaskId,
        },
        body: {
          event_id: `te-${randomUUID()}`,
          type: "assistant_message",
          payload: { text: "legitimate main Runtime callback" },
        },
      },
    );
    expect(mainCallback.status).toBe(201);

    const sideCallback = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${sideTaskId}/events`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          event_id: `te-${randomUUID()}`,
          type: "assistant_message",
          payload: { text: "legitimate side Runtime callback" },
        },
      },
    );
    expect(sideCallback.status).toBe(201);

    const eventsBeforeAttacks = await harness.client.query(
      "SELECT id FROM task_conversation_event WHERE project_id=$1 ORDER BY task_id,sequence",
      [seeded.projectId],
    );
    const attempts = [
      {
        name: "same actor without the dedicated scope",
        expectedStatus: 403,
        headers: {
          ...runtimeHeaders(side),
          authorization: `Bearer ${harness.ids.genericServiceToken}`,
        },
      },
      {
        name: "second service identity with the dedicated scope",
        expectedStatus: 404,
        headers: {
          ...runtimeHeaders(side),
          authorization: `Bearer ${harness.ids.secondServiceToken}`,
        },
      },
      {
        name: "wrong task header",
        expectedStatus: 404,
        headers: {
          ...runtimeHeaders(side),
          "x-synthia-task-id": seeded.mainTaskId,
        },
      },
      {
        name: "wrong workspace header",
        expectedStatus: 404,
        headers: {
          ...runtimeHeaders(side),
          "x-synthia-workspace-id": `ws-wrong-${randomUUID()}`,
        },
      },
    ];
    for (const attempt of attempts) {
      const response = await apiCall(
        harness.baseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${sideTaskId}/events`,
        {
          method: "POST",
          headers: attempt.headers,
          body: {
            event_id: `te-${randomUUID()}`,
            type: "assistant_message",
            payload: { text: attempt.name },
          },
        },
      );
      expect(response.status, attempt.name).toBe(attempt.expectedStatus);
    }

    const eventsAfterAttacks = await harness.client.query(
      "SELECT id FROM task_conversation_event WHERE project_id=$1 ORDER BY task_id,sequence",
      [seeded.projectId],
    );
    expect(eventsAfterAttacks.rows).toEqual(eventsBeforeAttacks.rows);
  });

  test("task Runtime capability is disjoint from generic Core routes", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const beforeHead = await headSha(projectWorkspaceDir(seeded.projectId));
    const before = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM configuration_snapshot WHERE project_id=$1) AS snapshots,
         (SELECT COUNT(*)::int FROM gate_submission WHERE project_id=$1) AS gates,
         (SELECT COUNT(*)::int FROM tool_run WHERE project_id=$1) AS jobs,
         (SELECT COUNT(*)::int FROM task_conversation_event WHERE project_id=$1) AS events`,
      [seeded.projectId],
    );
    const connectorSubmissions = connector.submissions.length;
    const taskOnlyHeaders = () => ({
      authorization: `Bearer ${harness.ids.taskRuntimeToken}`,
      "idempotency-key": randomUUID(),
      "x-synthia-task-id": String(side.task_id),
      "x-synthia-workspace-id": String(side.workspace_id),
    });

    const genericSurfaceAttacks = [
      {
        path: `/api/v1/projects/${seeded.projectId}/workspace/files`,
        body: { files: [{ path: "rtl/a.v", content: "must not reach main workspace\n" }] },
      },
      {
        path: `/api/v1/projects/${seeded.projectId}/snapshots`,
        body: {
          id: `snap-${randomUUID()}`,
          member_revision_ids: ["rev-forged"],
          tool_model_policy_hash: "forged",
        },
      },
      {
        path: `/api/v1/projects/${seeded.projectId}/gate-submissions`,
        body: {
          id: `sub-${randomUUID()}`,
          process_instance_id: "proc-forged",
          gate: "G1",
          snapshot_id: "snap-forged",
        },
      },
      {
        path: `/api/v1/projects/${seeded.projectId}/jobs`,
        body: {
          operation: "simulate",
          run_class_intent: "formal",
          baseline_id: "baseline-forged",
          sources: [{ path: "rtl/a.v", content: "module a; endmodule\n" }],
          constraints: [],
        },
      },
    ];
    for (const attack of genericSurfaceAttacks) {
      const response = await apiCall(harness.baseUrl, attack.path, {
        method: "POST",
        headers: taskOnlyHeaders(),
        body: attack.body,
      });
      expect(response.status, attack.path).toBe(403);
      expect(error(response.json)).toMatchObject({
        code: "authorization",
        message: "insufficient scope for this operation",
      });
    }

    const taskOnlyRoutes: readonly {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: unknown;
    }[] = [
      {
        method: "GET" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/tree`,
      },
      {
        method: "GET" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/file?path=rtl%2Fa.v`,
      },
      {
        method: "POST" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/files`,
        body: { files: [{ path: "rtl/a.v", content: "must stay isolated\n" }] },
      },
      {
        method: "POST" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/events`,
        body: {
          event_id: `te-${randomUUID()}`,
          type: "assistant_message",
          payload: { text: "must not append" },
        },
      },
      {
        method: "POST" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/result`,
        body: { summary: "must not seal", tests: [] },
      },
      {
        method: "POST" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`,
        body: {
          operation: "simulate",
          sources: [{ path: "rtl/a.v", content: "module a; assign y = 1'b0; endmodule\n" }],
          constraints: [],
        },
      },
      {
        method: "GET" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs/job-forged`,
      },
      {
        method: "GET" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs/job-forged/evidence`,
      },
      {
        method: "GET" as const,
        path: `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs/job-forged/evidence/content?name=run.log`,
      },
    ];
    for (const route of taskOnlyRoutes) {
      const response = await apiCall(harness.baseUrl, route.path, {
        method: route.method,
        headers: {
          ...runtimeHeaders(side),
          authorization: `Bearer ${harness.ids.serviceToken}`,
        },
        ...(route.body ? { body: route.body } : {}),
      });
      expect(response.status, route.path).toBe(403);
      expect(error(response.json)).toMatchObject({
        code: "authorization",
        message: "insufficient scope for this operation",
      });
    }

    for (const token of [
      harness.ids.combinedServiceToken,
      harness.ids.extendedTaskRuntimeToken,
    ]) {
      const invalid = await apiCall(
        harness.baseUrl,
        `/api/v1/projects/${seeded.projectId}`,
        { token },
      );
      expect(invalid.status).toBe(401);
      expect(error(invalid.json).code).toBe("authorization");
    }

    const after = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM configuration_snapshot WHERE project_id=$1) AS snapshots,
         (SELECT COUNT(*)::int FROM gate_submission WHERE project_id=$1) AS gates,
         (SELECT COUNT(*)::int FROM tool_run WHERE project_id=$1) AS jobs,
         (SELECT COUNT(*)::int FROM task_conversation_event WHERE project_id=$1) AS events`,
      [seeded.projectId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(connector.submissions).toHaveLength(connectorSubmissions);
    expect(await headSha(projectWorkspaceDir(seeded.projectId))).toBe(beforeHead);
  });

  test("P3 reads merge Core tasks with legacy Runtime mains without leaking Runtime-only sides", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const legacyId = `legacy-${randomUUID()}`;
    const orphanSideId = `runtime-side-${randomUUID()}`;
    runtime.seedRuntimeOnly({
      agent_id: legacyId,
      project_id: seeded.projectId,
      status: "idle",
      current_stage: "legacy-chat",
      kind: "main",
    });
    runtime.seedRuntimeOnly({
      agent_id: orphanSideId,
      project_id: seeded.projectId,
      status: "running",
      kind: "side",
      parent_task_id: seeded.mainTaskId,
      workspace_id: `runtime-workspace-${randomUUID()}`,
    });

    const listed = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks`,
      { token: harness.ids.humanToken },
    );
    expect(listed.status).toBe(200);
    const agents = data<{ agents: Array<Record<string, unknown>> }>(listed.json).agents;
    expect(agents.filter((task) => task.agent_id === seeded.mainTaskId)).toHaveLength(1);
    expect(agents.filter((task) => task.agent_id === side.task_id)).toHaveLength(1);
    expect(agents.filter((task) => task.agent_id === legacyId)).toEqual([
      expect.objectContaining({ agent_id: legacyId, kind: "main", current_stage: "legacy-chat" }),
    ]);
    expect(agents.some((task) => task.agent_id === orphanSideId)).toBe(false);

    const legacyDetail = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${legacyId}`,
      { token: harness.ids.humanToken },
    );
    expect(legacyDetail.status).toBe(200);
    expect(data(legacyDetail.json)).toMatchObject({
      agent_id: legacyId,
      project_id: seeded.projectId,
      kind: "main",
      current_stage: "legacy-chat",
    });

    const orphanSideDetail = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${orphanSideId}`,
      { token: harness.ids.humanToken },
    );
    expect(orphanSideDetail.status).toBe(404);
    expect(error(orphanSideDetail.json).code).toBe("not_found");
  });

  test("P3 reads keep Core facts during Runtime outage and fail closed without Core truth", async () => {
    const seeded = await seedProject();
    runtime.listError = new RuntimeClientError(503, "runtime unavailable", { retryable: true });

    const listed = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks`,
      { token: harness.ids.humanToken },
    );
    expect(listed.status).toBe(200);
    expect(data<{ agents: Array<Record<string, unknown>> }>(listed.json).agents).toEqual([
      expect.objectContaining({ agent_id: seeded.mainTaskId, kind: "main" }),
    ]);

    runtime.getError = new RuntimeClientError(503, "runtime unavailable", { retryable: true });
    const persisted = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}`,
      { token: harness.ids.humanToken },
    );
    expect(persisted.status).toBe(200);

    const unknown = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/legacy-unknown`,
      { token: harness.ids.humanToken },
    );
    expect(unknown.status).toBe(503);
    expect(error(unknown.json).code).toBe("capability_unavailable");

    const emptyProjectId = `p3-empty-${randomUUID()}`;
    const emptyProject = await post("/api/v1/projects", {
      id: emptyProjectId,
      name: "P3 empty project",
      project_type: "free",
    });
    expect(emptyProject.status).toBe(201);
    const emptyList = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${emptyProjectId}/tasks`,
      { token: harness.ids.humanToken },
    );
    expect(emptyList.status).toBe(503);
    expect(error(emptyList.json).code).toBe("capability_unavailable");
  });

  test("task list, detail, message, abort, and stream require a current project role", async () => {
    const seeded = await seedProject();
    const legacyId = `legacy-${randomUUID()}`;
    runtime.seedRuntimeOnly({
      agent_id: legacyId,
      project_id: seeded.projectId,
      status: "idle",
      kind: "main",
    });

    const taskBefore = await harness.client.query(
      "SELECT status,finished_at,adoption_state FROM agent_task WHERE id=$1 AND project_id=$2",
      [seeded.mainTaskId, seeded.projectId],
    );
    const eventsBefore = await harness.client.query(
      `SELECT sequence,event_kind,payload,payload_hash,actor_type,actor_id
         FROM task_conversation_event
        WHERE task_id=$1 AND project_id=$2
        ORDER BY sequence`,
      [seeded.mainTaskId, seeded.projectId],
    );
    const runtimeBefore = {
      listRequests: [...runtime.listRequests],
      getRequests: [...runtime.getRequests],
      messages: [...runtime.messages],
      abortRequests: [...runtime.abortRequests],
      streamRequests: [...runtime.streamRequests],
    };

    const unauthorizedReads = [
      `/api/v1/projects/${seeded.projectId}/tasks`,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}`,
      `/api/v1/projects/${seeded.projectId}/tasks/${legacyId}`,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/stream`,
      `/api/v1/projects/${seeded.projectId}/tasks/${legacyId}/stream`,
    ];
    for (const path of unauthorizedReads) {
      const response = await apiCall(harness.baseUrl, path, { token: harness.ids.serviceToken });
      expect(response.status, path).toBe(404);
      expect(error(response.json).code, path).toBe("not_found");
    }

    for (const taskId of [seeded.mainTaskId, legacyId]) {
      const messagePath = `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`;
      const message = await apiCall(harness.baseUrl, messagePath, {
        method: "POST",
        token: harness.ids.serviceToken,
        body: { text: "must not reach Runtime" },
      });
      expect(message.status, messagePath).toBe(404);
      expect(error(message.json).code, messagePath).toBe("not_found");

      const abortPath = `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/abort`;
      const abort = await apiCall(harness.baseUrl, abortPath, {
        method: "POST",
        token: harness.ids.serviceToken,
        body: {},
      });
      expect(abort.status, abortPath).toBe(404);
      expect(error(abort.json).code, abortPath).toBe("not_found");
    }

    // Project state is mutable, so even an administrator must not be able to
    // use either write entry while the project is inactive.  The same short
    // transaction that checks the role also re-checks `active`.
    await harness.client.query("UPDATE project SET status='archived' WHERE id=$1", [seeded.projectId]);
    const inactiveMessage = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/message`,
      { method: "POST", token: harness.ids.humanToken, body: { text: "inactive project" } },
    );
    expect(inactiveMessage.status).toBe(409);
    expect(error(inactiveMessage.json)).toMatchObject({ code: "conflict", message: "PROJECT_NOT_ACTIVE" });
    const inactiveAbort = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/abort`,
      { method: "POST", token: harness.ids.humanToken, body: {} },
    );
    expect(inactiveAbort.status).toBe(409);
    expect(error(inactiveAbort.json)).toMatchObject({ code: "conflict", message: "PROJECT_NOT_ACTIVE" });
    await harness.client.query("UPDATE project SET status='active' WHERE id=$1", [seeded.projectId]);

    expect(runtime.listRequests).toEqual(runtimeBefore.listRequests);
    expect(runtime.getRequests).toEqual(runtimeBefore.getRequests);
    expect(runtime.messages).toEqual(runtimeBefore.messages);
    expect(runtime.abortRequests).toEqual(runtimeBefore.abortRequests);
    expect(runtime.streamRequests).toEqual(runtimeBefore.streamRequests);
    const taskAfter = await harness.client.query(
      "SELECT status,finished_at,adoption_state FROM agent_task WHERE id=$1 AND project_id=$2",
      [seeded.mainTaskId, seeded.projectId],
    );
    const eventsAfter = await harness.client.query(
      `SELECT sequence,event_kind,payload,payload_hash,actor_type,actor_id
         FROM task_conversation_event
        WHERE task_id=$1 AND project_id=$2
        ORDER BY sequence`,
      [seeded.mainTaskId, seeded.projectId],
    );
    expect(taskAfter.rows).toEqual(taskBefore.rows);
    expect(eventsAfter.rows).toEqual(eventsBefore.rows);

    // The existing platform-administrator path remains a legitimate control
    // across both Core-owned facts and the legacy Runtime compatibility path.
    const adminList = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks`,
      { token: harness.ids.humanToken },
    );
    expect(adminList.status).toBe(200);
    const adminCoreDetail = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}`,
      { token: harness.ids.humanToken },
    );
    expect(adminCoreDetail.status).toBe(200);
    const adminLegacyDetail = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${legacyId}`,
      { token: harness.ids.humanToken },
    );
    expect(adminLegacyDetail.status).toBe(200);

    const adminMessage = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/message`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": randomUUID() },
        body: { text: "authorized control" },
      },
    );
    expect(adminMessage.status).toBe(200);
    const adminStream = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/stream`,
      { token: harness.ids.humanToken },
    );
    expect(adminStream.status).toBe(200);
    const adminAbort = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/abort`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": randomUUID() },
        body: {},
      },
    );
    expect(adminAbort.status).toBe(200);
    const cancelled = await harness.client.query(
      "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
      [seeded.mainTaskId, seeded.projectId],
    );
    expect(cancelled.rows[0]?.status).toBe("cancelled");
  });

  test("Core-owned abort requires and caches one idempotent Runtime cancellation", async () => {
    const seeded = await seedProject();
    const path = `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/abort`;
    const body = { reason: "operator requested stop" };

    const missingKey = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      body,
    });
    expect(missingKey.status).toBe(400);
    expect(error(missingKey.json).message).toContain("Idempotency-Key");
    expect(runtime.abortRequests).toEqual([]);

    const key = `abort-${randomUUID()}`;
    const first = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body,
    });
    expect(first.status).toBe(200);
    const replay = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body,
    });
    expect(replay.status).toBe(200);
    expect(data(replay.json)).toEqual(data(first.json));
    expect(runtime.abortRequests).toEqual([seeded.mainTaskId]);
    expect(runtime.abortEffects).toEqual([seeded.mainTaskId]);
    expect(runtime.abortIdempotencyKeys[0]).toMatch(/^core-abort-[0-9a-f]{48}$/);

    const conflict = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body: { reason: "different command body" },
    });
    expect(conflict.status).toBe(409);
    expect(error(conflict.json).message).toBe("IDEMPOTENCY_CONFLICT");
    expect(runtime.abortRequests).toEqual([seeded.mainTaskId]);

    const task = await harness.client.query(
      "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
      [seeded.mainTaskId, seeded.projectId],
    );
    expect(task.rows[0]?.status).toBe("cancelled");
    const cancellations = await harness.client.query(
      `SELECT id FROM task_conversation_event
        WHERE task_id=$1 AND project_id=$2
          AND event_kind='status' AND payload->>'status'='cancelled'`,
      [seeded.mainTaskId, seeded.projectId],
    );
    expect(cancellations.rows).toHaveLength(1);
  });

  test("Core-owned abort recovers a lost Runtime response with the same downstream key", async () => {
    const seeded = await seedProject();
    const path = `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/abort`;
    const key = `abort-recover-${randomUUID()}`;
    const body = {};
    runtime.failAbortAfterAcceptOnce = true;

    const lost = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body,
    });
    expect(lost.status).toBe(503);
    expect(runtime.abortEffects).toEqual([seeded.mainTaskId]);
    const afterLost = await harness.client.query(
      `SELECT status,
              (SELECT count(*)::int FROM task_conversation_event
                WHERE task_id=$1 AND event_kind='status' AND payload->>'status'='cancelled') AS cancellations,
              (SELECT count(*)::int FROM idempotency_records
                WHERE project_id=$2 AND operation=$3 AND idempotency_key=$4) AS idempotency
         FROM agent_task WHERE id=$1 AND project_id=$2`,
      [seeded.mainTaskId, seeded.projectId, `abort_core_task:${seeded.mainTaskId}`, key],
    );
    expect(afterLost.rows[0]).toMatchObject({
      status: "running",
      cancellations: 0,
      idempotency: 0,
    });

    const recovered = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body,
    });
    expect(recovered.status).toBe(200);
    expect(runtime.abortRequests).toEqual([seeded.mainTaskId, seeded.mainTaskId]);
    expect(runtime.abortIdempotencyKeys[1]).toBe(runtime.abortIdempotencyKeys[0]);
    expect(runtime.abortEffects).toEqual([seeded.mainTaskId]);

    const replay = await apiCall(harness.baseUrl, path, {
      method: "POST",
      token: harness.ids.humanToken,
      headers: { "idempotency-key": key },
      body,
    });
    expect(replay.status).toBe(200);
    expect(runtime.abortRequests).toHaveLength(2);
    const afterRecovery = await harness.client.query(
      `SELECT status,
              (SELECT count(*)::int FROM task_conversation_event
                WHERE task_id=$1 AND event_kind='status' AND payload->>'status'='cancelled') AS cancellations
         FROM agent_task WHERE id=$1 AND project_id=$2`,
      [seeded.mainTaskId, seeded.projectId],
    );
    expect(afterRecovery.rows[0]).toMatchObject({ status: "cancelled", cancellations: 1 });
  });

  test("Core-owned side messages persist once, retry Runtime with one key, and wait for Runtime status", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const taskId = String(side.task_id);
    const awaiting = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          event_id: `te-${randomUUID()}`,
          type: "status",
          payload: { status: "awaiting_user" },
        },
      },
    );
    expect(awaiting.status).toBe(201);

    const key = randomUUID();
    const body = { text: "请继续比较时序与资源取舍" };
    runtime.messageError = new RuntimeClientError(503, "runtime message unavailable", {
      retryable: true,
    });
    const first = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": key },
        body,
      },
    );
    expect(first.status).toBe(503);

    const afterFailure = await harness.client.query(
      `SELECT t.status,e.sequence,e.event_kind,e.payload,e.actor_type,e.actor_id
         FROM agent_task t
         JOIN task_conversation_event e ON e.task_id=t.id AND e.project_id=t.project_id
        WHERE t.id=$1 AND t.project_id=$2
        ORDER BY e.sequence`,
      [taskId, seeded.projectId],
    );
    expect(afterFailure.rows).toHaveLength(3);
    expect({
      ...afterFailure.rows.at(-1),
      sequence: Number(afterFailure.rows.at(-1)?.sequence),
    }).toMatchObject({
      status: "awaiting_user",
      sequence: 3,
      event_kind: "user_message",
      payload: body,
      actor_type: "human",
      actor_id: harness.ids.humanUid,
    });

    runtime.messageError = null;
    const replay = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": key },
        body,
      },
    );
    expect(replay.status).toBe(200);
    expect(data(replay.json)).toEqual({ accepted: true });
    const deliveryAttempts = runtime.messages.slice(-2);
    expect(deliveryAttempts).toEqual([
      expect.objectContaining({ taskId, text: body.text }),
      expect.objectContaining({ taskId, text: body.text }),
    ]);
    expect(deliveryAttempts[0]?.idempotencyKey).toMatch(/^core-message-[0-9a-f]{48}$/);
    expect(deliveryAttempts[1]?.idempotencyKey).toBe(deliveryAttempts[0]?.idempotencyKey);
    expect(deliveryAttempts[0]?.idempotencyKey).not.toBe(key);

    const changed = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": key },
        body: { text: "same key must not steer a different turn" },
      },
    );
    expect(changed.status).toBe(409);
    expect(error(changed.json)).toMatchObject({
      code: "conflict",
      message: "IDEMPOTENCY_CONFLICT",
    });
    expect(runtime.messages).toHaveLength(2);

    const persisted = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM task_conversation_event
           WHERE task_id=$1 AND project_id=$2 AND event_kind='user_message') AS user_events,
         (SELECT status FROM agent_task WHERE id=$1 AND project_id=$2) AS status,
         (SELECT COUNT(*)::int FROM idempotency_records
           WHERE actor_type='human' AND actor_id=$3 AND project_id=$2
             AND operation=$4 AND idempotency_key=$5 AND status='completed') AS idempotency_rows`,
      [taskId, seeded.projectId, harness.ids.humanUid, `send_core_task_message:${taskId}`, key],
    );
    expect(persisted.rows[0]).toMatchObject({
      user_events: 2,
      status: "awaiting_user",
      idempotency_rows: 1,
    });

    const running = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          event_id: `te-${randomUUID()}`,
          type: "status",
          payload: { status: "running" },
        },
      },
    );
    expect(running.status).toBe(201);
    const advanced = await harness.client.query(
      "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
      [taskId, seeded.projectId],
    );
    expect(advanced.rows[0]?.status).toBe("running");

    await harness.client.query(
      `UPDATE agent_task
          SET status='failed',adoption_state='discarded',finished_at=now(),updated_at=now()
        WHERE id=$1 AND project_id=$2`,
      [taskId, seeded.projectId],
    );
    const terminalReplay = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`,
      {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": key },
        body,
      },
    );
    expect(terminalReplay.status).toBe(409);
    expect(error(terminalReplay.json)).toMatchObject({
      code: "conflict",
      message: "CORE_TASK_NOT_MESSAGEABLE",
      details: { taskId, status: "failed" },
    });
    expect(runtime.messages).toHaveLength(2);
  });

  test("Core-owned messages cannot bypass start or revive terminal tasks", async () => {
    const seeded = await seedProject();
    const blockedStatuses = [
      "queued",
      "succeeded",
      "failed",
      "cancelled",
      "fail_closed",
    ] as const;
    const taskIds: string[] = [];

    for (const status of blockedStatuses) {
      let taskId: string;
      if (status === "queued") {
        await harness.client.query(
          "UPDATE agent_task SET status='awaiting_user',updated_at=now() WHERE id=$1 AND status='running'",
          [seeded.mainTaskId],
        );
        runtime.startError = new RuntimeClientError(503, "leave side task queued", {
          retryable: true,
        });
        const create = await post(
          `/api/v1/projects/${seeded.projectId}/tasks`,
          sideCreateBody(seeded, ["rtl/a.v"]),
        );
        runtime.startError = null;
        expect(create.status).toBe(503);
        taskId = String(runtime.created.at(-1)?.task_id);
      } else {
        const side = await createSide(seeded, ["rtl/a.v"]);
        taskId = String(side.task_id);
        await harness.client.query(
          `UPDATE agent_task
              SET status=$3,
                  adoption_state='discarded',
                  output_hash=CASE WHEN $3='succeeded' THEN $4 ELSE NULL END,
                  finished_at=now(),updated_at=now()
            WHERE id=$1 AND project_id=$2`,
          [taskId, seeded.projectId, status, "f".repeat(64)],
        );
      }
      taskIds.push(taskId);
      const response = await apiCall(
        harness.baseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`,
        {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": randomUUID() },
          body: { text: `must not execute from ${status}` },
        },
      );
      expect(response.status, status).toBe(409);
      expect(error(response.json), status).toMatchObject({
        code: "conflict",
        message: "CORE_TASK_NOT_MESSAGEABLE",
        details: { taskId, status },
      });
    }

    expect(runtime.messages).toEqual([]);
    const facts = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM task_conversation_event
           WHERE task_id=ANY($1::text[]) AND project_id=$2 AND event_kind='user_message') AS user_events,
         (SELECT COUNT(*)::int FROM idempotency_records
           WHERE project_id=$2 AND operation=ANY($3::text[])) AS idempotency_rows`,
      [taskIds, seeded.projectId, taskIds.map((taskId) => `send_core_task_message:${taskId}`)],
    );
    expect(facts.rows[0]).toEqual({ user_events: blockedStatuses.length, idempotency_rows: 0 });
  });

  test("Core-owned main messages cannot bypass start or revive a terminal main", async () => {
    const seeded = await seedEngineeringWorkspace();
    runtime.startError = new RuntimeClientError(503, "leave main queued", {
      retryable: true,
    });
    const create = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
      task: "remain queued for the message barrier test",
    });
    runtime.startError = null;
    expect(create.status).toBe(503);
    const taskId = String(runtime.created.at(-1)?.task_id);

    for (const status of ["queued", "failed"] as const) {
      if (status === "failed") {
        await harness.client.query(
          `UPDATE agent_task
              SET status='failed',finished_at=now(),updated_at=now()
            WHERE id=$1 AND project_id=$2`,
          [taskId, seeded.projectId],
        );
      }
      const response = await apiCall(
        harness.baseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/message`,
        {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": randomUUID() },
          body: { text: `must not execute main from ${status}` },
        },
      );
      expect(response.status, status).toBe(409);
      expect(error(response.json), status).toMatchObject({
        code: "conflict",
        message: "CORE_TASK_NOT_MESSAGEABLE",
        details: { taskId, status },
      });
    }

    expect(runtime.messages).toEqual([]);
    const facts = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM task_conversation_event
           WHERE task_id=$1 AND project_id=$2 AND event_kind='user_message') AS user_events,
         (SELECT COUNT(*)::int FROM idempotency_records
           WHERE project_id=$2 AND operation=$3) AS idempotency_rows`,
      [taskId, seeded.projectId, `send_core_task_message:${taskId}`],
    );
    expect(facts.rows[0]).toEqual({ user_events: 1, idempotency_rows: 0 });
  });

  test("side task authorization rejects legacy fields and governance escalation", async () => {
    const seeded = await seedProject();
    await harness.client.query(
      "UPDATE agent_task SET status='awaiting_user',updated_at=now() WHERE id=$1 AND status='running'",
      [seeded.mainTaskId],
    );
    const runtimeCallsBefore = runtime.created.length;
    const validScope = {
      schema: "task-scope.v1",
      workspace: "isolated",
      read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
      write_paths: ["rtl/a.v"],
      run_classes: ["exploratory"],
      can_submit_gates: false,
      can_create_milestones: false,
      can_start_formal_runs: false,
    };
    const invalidScopes = [
      {
        schema: "task-scope.v1",
        read: "base_snapshot",
        write_paths: ["rtl/a.v"],
        run_classes: ["exploratory"],
      },
      { ...validScope, workspace: "project" },
      { ...validScope, read_paths: ["rtl/**", "tb/**", "doc/**", "sim/**"] },
      { ...validScope, run_classes: ["exploratory", "formal"] },
      { ...validScope, can_submit_gates: true },
      { ...validScope, can_create_milestones: true },
      { ...validScope, can_start_formal_runs: true },
      { ...validScope, write_paths: Array.from({ length: 33 }, (_, index) => `rtl/generated_${index}.v`) },
      { ...validScope, write_paths: ["doc/not-rtl.v"] },
      { ...validScope, write_paths: ["sim/not-a-controlled-result.log"] },
    ];

    for (const authorizationScope of invalidScopes) {
      const response = await post(`/api/v1/projects/${seeded.projectId}/tasks`, {
        kind: "side",
        parent_task_id: seeded.mainTaskId,
        objective: "不能取得正式治理能力",
        base_commit: seeded.baseCommit,
        authorization_scope: authorizationScope,
      });
      expect(response.status).toBe(400);
    }
    expect(runtime.created).toHaveLength(runtimeCallsBefore);
  });

  test("events replay by id and sequence; duplicate result finalization fails closed", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded);
    const taskId = String(side.task_id);
    const eventId = `te-${randomUUID()}`;
    const eventBody = {
      event_id: eventId,
      sequence: 2,
      type: "assistant_message",
      payload: { text: "isolated exploration started" },
    };
    const appended = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events`,
      { method: "POST", headers: runtimeHeaders(side), body: eventBody },
    );
    expect(appended.status).toBe(201);
    expect(data(appended.json)).toMatchObject({ sequence: 2, replayed: false });

    const replayed = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events`,
      { method: "POST", headers: runtimeHeaders(side), body: eventBody },
    );
    expect(replayed.status).toBe(201);
    expect(data(replayed.json)).toMatchObject({ sequence: 2, replayed: true });

    const mismatch = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: { ...eventBody, payload: { text: "different payload" } },
      },
    );
    expect(mismatch.status).toBe(409);

    const sequenceGap = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          event_id: `te-${randomUUID()}`,
          sequence: 4,
          type: "tool_call",
          payload: { name: "rtl-write" },
        },
      },
    );
    expect(sequenceGap.status).toBe(409);

    const events = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/events?after=1`,
      { token: harness.ids.humanToken },
    );
    expect(events.status).toBe(200);
    expect(data<{ events: Array<{ id: string; sequence: number }> }>(events.json).events)
      .toEqual([expect.objectContaining({ id: eventId, sequence: 2 })]);

    await writeAndFinalize(seeded, side);
    const duplicate = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${taskId}/result`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: { summary: "duplicate", tests: [] },
      },
    );
    expect(duplicate.status).toBe(409);
  });

  test("cross-project parents, tasks, and workspace bindings remain undiscoverable", async () => {
    const first = await seedProject();
    const side = await createSide(first, ["rtl/a.v"]);
    const second = await seedProject();
    await harness.client.query(
      "UPDATE agent_task SET status='awaiting_user',updated_at=now() WHERE id=$1 AND status='running'",
      [second.mainTaskId],
    );

    const crossParent = await post(`/api/v1/projects/${second.projectId}/tasks`, {
      kind: "side",
      parent_task_id: first.mainTaskId,
      objective: "must not cross projects",
      base_commit: second.baseCommit,
      authorization_scope: side.authorization_scope,
    });
    expect(crossParent.status).toBe(404);

    for (const path of [
      `/api/v1/projects/${second.projectId}/tasks/${side.task_id}`,
      `/api/v1/projects/${second.projectId}/tasks/${side.task_id}/workspace/tree`,
      `/api/v1/projects/${second.projectId}/tasks/${side.task_id}/workspace/file?path=rtl%2Fa.v`,
    ]) {
      const response = await apiCall(harness.baseUrl, path, {
        token: path.includes("/workspace/") ? undefined : harness.ids.humanToken,
        headers: path.includes("/workspace/") ? runtimeHeaders(side) : undefined,
      });
      expect(response.status, path).toBe(404);
    }
  });

  test("task-scoped jobs use isolated bytes and always submit as exploratory", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const source = "module a; assign y = 1'b0; endmodule\n";
    const key = randomUUID();
    const submitted = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`,
      {
        method: "POST",
        headers: runtimeHeaders(side, key),
        body: {
          operation: "simulate",
          sources: [{ path: "rtl/a.v", content: source }],
          constraints: [],
          top: "a",
          run_class_intent: "formal",
          approved_gate_result_id: "must-be-ignored",
        },
      },
    );
    expect(submitted.status).toBe(201);
    expect(data(submitted.json)).toMatchObject({
      runClass: "exploratory",
      state: "submitted",
      task_id: side.task_id,
      workspace_id: side.workspace_id,
    });
    expect(connector.submissions).toHaveLength(1);
    expect(connector.submissions[0]).toMatchObject({
      projectId: seeded.projectId,
      operation: "simulate",
      runClass: "exploratory",
      parameters: {
        sources: [{ path: "rtl/a.v", content: source }],
        constraints: [],
        top: "a",
      },
    });
    expect(connector.submissions[0]!.approval).toBeUndefined();

    const replay = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`,
      {
        method: "POST",
        headers: runtimeHeaders(side, key),
        body: {
          operation: "simulate",
          sources: [{ path: "rtl/a.v", content: source }],
          constraints: [],
          top: "a",
          run_class_intent: "formal",
          approved_gate_result_id: "must-be-ignored",
        },
      },
    );
    expect(replay.status).toBe(201);
    expect(data(replay.json)).toEqual(data(submitted.json));
    expect(connector.submissions).toHaveLength(1);

    const stale = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          operation: "simulate",
          sources: [{ path: "rtl/a.v", content: "spoofed\n" }],
          constraints: [],
        },
      },
    );
    expect(stale.status).toBe(409);
    expect(connector.submissions).toHaveLength(1);

    const row = await harness.client.query(
      "SELECT run_class,authorization_context,parameters FROM tool_run WHERE id=$1",
      [data(submitted.json).jobId],
    );
    expect(row.rows[0].run_class).toBe("exploratory");
    expect(row.rows[0].authorization_context).toEqual({});
    expect(row.rows[0].parameters).toMatchObject({
      taskId: side.task_id,
      workspaceId: side.workspace_id,
      runClass: "exploratory",
    });

    const jobId = String(data(submitted.json).jobId);
    const status = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs/${jobId}`,
      { headers: runtimeHeaders(side) },
    );
    expect(status.status).toBe(200);
    expect(data(status.json)).toMatchObject({ jobId, state: "succeeded" });

    const evidence = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs/${jobId}/evidence`,
      { headers: runtimeHeaders(side) },
    );
    expect(evidence.status).toBe(200);
    expect(data(evidence.json)).toEqual({ jobId, entries: [] });

    const content = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs/${jobId}/evidence/content?name=run.log`,
      { headers: runtimeHeaders(side) },
    );
    expect(content.status).toBe(200);
    expect(data(content.json)).toMatchObject({
      name: "run.log",
      content: "",
      sha256: "0".repeat(64),
      truncated: false,
      mediaType: "text/plain",
    });
  });

  test("task-scoped job reads conceal wrong actor, task, workspace, and job bindings", async () => {
    const seeded = await seedProject();
    const first = await createSide(seeded, ["rtl/a.v"]);
    const second = await createSide(seeded, ["rtl/a.v"]);
    const source = "module a; assign y = 1'b0; endmodule\n";
    const submitFor = async (side: Record<string, unknown>): Promise<string> => {
      const response = await apiCall(
        harness.baseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`,
        {
          method: "POST",
          headers: runtimeHeaders(side),
          body: {
            operation: "validate_sources",
            sources: [{ path: "rtl/a.v", content: source }],
            constraints: [],
            top: "a",
          },
        },
      );
      expect(response.status).toBe(201);
      return String(data(response.json).jobId);
    };
    const firstJob = await submitFor(first);
    const secondJob = await submitFor(second);
    const firstPath = (jobId: string) =>
      `/api/v1/projects/${seeded.projectId}/tasks/${first.task_id}/jobs/${jobId}`;

    const attempts = [
      {
        name: "job belongs to another task workspace",
        path: firstPath(secondJob),
        headers: runtimeHeaders(first),
      },
      {
        name: "task header does not match the route binding",
        path: firstPath(firstJob),
        headers: {
          ...runtimeHeaders(first),
          "x-synthia-task-id": String(second.task_id),
        },
      },
      {
        name: "workspace header does not match the persisted binding",
        path: firstPath(firstJob),
        headers: {
          ...runtimeHeaders(first),
          "x-synthia-workspace-id": String(second.workspace_id),
        },
      },
      {
        name: "different task Runtime service forges correct headers",
        path: firstPath(firstJob),
        headers: {
          ...runtimeHeaders(first),
          authorization: `Bearer ${harness.ids.secondServiceToken}`,
        },
      },
      {
        name: "unknown job id",
        path: firstPath(`job-${randomUUID()}`),
        headers: runtimeHeaders(first),
      },
    ];
    for (const attempt of attempts) {
      const response = await apiCall(harness.baseUrl, attempt.path, {
        headers: attempt.headers,
      });
      expect(response.status, attempt.name).toBe(404);
      expect(error(response.json).code, attempt.name).toBe("not_found");
    }

    await expect(harness.client.query(
      "UPDATE tool_run SET run_class='formal' WHERE id=$1 AND project_id=$2",
      [firstJob, seeded.projectId],
    )).rejects.toThrow("tool run input binding is immutable");
    const stillTaskBound = await apiCall(harness.baseUrl, firstPath(firstJob), {
      headers: runtimeHeaders(first),
    });
    expect(stillTaskBound.status).toBe(200);
  });

  test("task-scoped job retry reattaches after Connector accepted but lost the response", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const source = "module a; assign y = 1'b0; endmodule\n";
    const key = randomUUID();
    const body = {
      operation: "simulate",
      sources: [{ path: "rtl/a.v", content: source }],
      constraints: [],
      top: "a",
    };
    const path = `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`;
    connector.failAfterAcceptOnce = true;

    const lost = await apiCall(harness.baseUrl, path, {
      method: "POST",
      headers: runtimeHeaders(side, key),
      body,
    });
    expect(lost.status).toBe(503);
    expect(connector.submissions).toHaveLength(1);
    expect(connector.accepted.size).toBe(1);
    const rolledBack = await harness.client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM tool_run WHERE project_id=$1) AS tool_runs,
         (SELECT COUNT(*)::int FROM idempotency_records
           WHERE project_id=$1 AND operation=$2 AND idempotency_key=$3) AS idempotency_rows`,
      [seeded.projectId, `submit_side_task_job:${side.task_id}`, key],
    );
    expect(rolledBack.rows[0]).toEqual({ tool_runs: 0, idempotency_rows: 0 });

    const recovered = await apiCall(harness.baseUrl, path, {
      method: "POST",
      headers: runtimeHeaders(side, key),
      body,
    });
    expect(recovered.status).toBe(201);
    expect(connector.submissions).toHaveLength(2);
    expect(connector.accepted.size).toBe(1);
    expect(connector.submissions[1]).toEqual(connector.submissions[0]);
    const accepted = connector.submissions[0]!;
    expect(accepted.jobId).toBe(data(recovered.json).jobId);
    expect(accepted.idempotencyKey).toMatch(/^side-job-[0-9a-f]{48}$/);
    expect(accepted.idempotencyKey).not.toBe(key);
    expect(accepted.correlationId).toBe(accepted.idempotencyKey);

    const persisted = await harness.client.query(
      "SELECT id,correlation_id FROM tool_run WHERE id=$1 AND project_id=$2",
      [accepted.jobId, seeded.projectId],
    );
    expect(persisted.rows).toEqual([{
      id: accepted.jobId,
      correlation_id: accepted.correlationId,
    }]);
  });

  test("result tests ignore Runtime claims and normalize only task-bound Core tool runs", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded, ["rtl/a.v"]);
    const source = "module a; assign y = 1'b1; endmodule\n";
    const written = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/files`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          files: [{ path: "rtl/a.v", content: source }],
          change_reason: "prepare Core-owned tool evidence",
        },
      },
    );
    expect(written.status).toBe(200);

    const submitJob = async (operation: "simulate" | "validate_sources") => {
      const response = await apiCall(
        harness.baseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/jobs`,
        {
          method: "POST",
          headers: runtimeHeaders(side),
          body: {
            operation,
            sources: [{ path: "rtl/a.v", content: source }],
            constraints: [],
            top: "a",
          },
        },
      );
      expect(response.status).toBe(201);
      return String(data(response.json).jobId);
    };

    const passedJob = await submitJob("validate_sources");
    const failedJob = await submitJob("simulate");
    const activeJob = await submitJob("simulate");
    await harness.client.query(
      `UPDATE tool_run
          SET state=CASE id WHEN $1 THEN 'succeeded'::tool_run_state
                            WHEN $2 THEN 'failed'::tool_run_state
                            WHEN $3 THEN 'running'::tool_run_state
                            ELSE state END,
              error_code=CASE id WHEN $2 THEN 'SIM_ASSERTION' ELSE NULL END
        WHERE id=ANY($4::text[])`,
      [
        passedJob,
        failedJob,
        activeJob,
        [passedJob, failedJob, activeJob],
      ],
    );

    const finalized = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/result`,
      {
        method: "POST",
        headers: runtimeHeaders(side),
        body: {
          summary: "Only Core tool runs are evidence",
          tests: [
            { name: "spoofed-runtime-success", status: "passed", detail: "must be ignored" },
          ],
        },
      },
    );
    expect(finalized.status).toBe(201);
    const result = data<{ tests: Array<Record<string, unknown>>; result_id: string }>(finalized.json);
    expect(result.tests).toHaveLength(3);
    expect(result.tests.some((entry) => entry.name === "spoofed-runtime-success")).toBe(false);
    expect(result.tests).toEqual(expect.arrayContaining([
      {
        name: `validate_sources (${passedJob})`,
        status: "passed",
        detail: "Core tool run state: succeeded",
        job_id: passedJob,
        operation: "validate_sources",
        state: "succeeded",
      },
      {
        name: `simulate (${failedJob})`,
        status: "failed",
        detail: "SIM_ASSERTION",
        job_id: failedJob,
        operation: "simulate",
        state: "failed",
      },
      {
        name: `simulate (${activeJob})`,
        status: "unknown",
        detail: "Core tool run state: running",
        job_id: activeJob,
        operation: "simulate",
        state: "running",
      },
    ]));

    const persisted = await harness.client.query(
      "SELECT tests,manifest FROM task_result WHERE id=$1 AND project_id=$2",
      [result.result_id, seeded.projectId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].tests).toEqual(result.tests);
    expect(persisted.rows[0].manifest.tests).toEqual(result.tests);
  });

  test("feature flag off blocks every P3 write while preserving sealed reads", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded);
    const result = await writeAndFinalize(seeded, side);
    const disabled = startSynthiaServer(harness.pool, {
      port: 0,
      features: { sideTasks: false },
      runtimeClient: runtime,
      runtimeActorId: harness.ids.serviceUid,
      connector,
    });
    const disabledBaseUrl = `http://${disabled.hostname}:${disabled.port}`;
    try {
      for (const path of [
        `/api/v1/projects/${seeded.projectId}/tasks`,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}`,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/result`,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/diff`,
      ]) {
        const read = await apiCall(disabledBaseUrl, path, { token: harness.ids.humanToken });
        expect(read.status, path).toBe(200);
      }

      const create = await apiCall(disabledBaseUrl, `/api/v1/projects/${seeded.projectId}/tasks`, {
        method: "POST",
        token: harness.ids.humanToken,
        headers: { "idempotency-key": randomUUID() },
        body: {
          kind: "side",
          parent_task_id: seeded.mainTaskId,
          objective: "must be disabled",
          base_commit: seeded.baseCommit,
          authorization_scope: side.authorization_scope,
        },
      });
      expect(create.status).toBe(503);

      const mainEvent = await apiCall(
        disabledBaseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${seeded.mainTaskId}/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${harness.ids.taskRuntimeToken}`,
            "idempotency-key": randomUUID(),
            "x-synthia-task-id": seeded.mainTaskId,
          },
          body: {
            event_id: `te-${randomUUID()}`,
            type: "status",
            payload: { status: "running" },
          },
        },
      );
      expect(mainEvent.status).toBe(201);
      const mainStatus = await harness.client.query(
        "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
        [seeded.mainTaskId, seeded.projectId],
      );
      expect(mainStatus.rows[0]?.status).toBe("running");

      const sideEvent = await apiCall(
        disabledBaseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/events`,
        {
          method: "POST",
          headers: runtimeHeaders(side),
          body: {
            event_id: `te-${randomUUID()}`,
            type: "assistant_message",
            payload: { text: "side events remain gated" },
          },
        },
      );
      expect(sideEvent.status).toBe(503);

      const workspaceWrite = await apiCall(
        disabledBaseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/workspace/files`,
        {
          method: "POST",
          headers: runtimeHeaders(side),
          body: { files: [{ path: "rtl/a.v", content: "blocked\n" }] },
        },
      );
      expect(workspaceWrite.status).toBe(503);

      const finalize = await apiCall(
        disabledBaseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/result`,
        {
          method: "POST",
          headers: runtimeHeaders(side),
          body: { summary: "duplicate must be disabled", tests: [] },
        },
      );
      expect(finalize.status).toBe(503);

      const adoption = await apiCall(
        disabledBaseUrl,
        `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
        {
          method: "POST",
          token: harness.ids.humanToken,
          headers: { "idempotency-key": randomUUID() },
          body: {
            adoption_id: `adopt-${randomUUID()}`,
            result_id: result.result_id,
            preview_hash: "0".repeat(64),
            reason: "must be disabled",
            files: [{
              path: "rtl/a.v",
              expected_base_hash: null,
              expected_proposed_hash: "0".repeat(64),
              expected_target_hash: null,
            }],
          },
        },
      );
      expect(adoption.status).toBe(503);
    } finally {
      disabled.stop();
    }
  });

  test("human adopts one selected file as a candidate and duplicate adoption fails closed", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded);
    const result = await writeAndFinalize(seeded, side);
    const diff = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/diff`,
      { token: harness.ids.humanToken },
    );
    expect(diff.status).toBe(200);
    const preview = data<{
      preview_hash: string;
      files: Array<{
        path: string;
        base_hash: string | null;
        result_hash: string;
        current_target_hash: string | null;
        conflict_reason: string | null;
        adopted: boolean;
      }>;
    }>(diff.json);
    expect(preview.files).toHaveLength(2);
    expect(preview.files.every((file) => file.conflict_reason === null && !file.adopted)).toBe(true);
    const a = preview.files.find((file) => file.path === "rtl/a.v")!;
    const adoptionBody = {
      adoption_id: `adopt-${randomUUID()}`,
      result_id: result.result_id,
      preview_hash: preview.preview_hash,
      reason: "人工确认采纳 a.v",
      files: [{
        path: a.path,
        expected_base_hash: a.base_hash,
        expected_proposed_hash: a.result_hash,
        expected_target_hash: a.current_target_hash,
      }],
    };
    const adoptionKey = randomUUID();
    const adopted = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      adoptionBody,
      adoptionKey,
    );
    expect(adopted.status).toBe(201);
    const adoptedData = data(adopted.json);
    expect(adoptedData).toMatchObject({
      status: "applied",
      task_id: side.task_id,
      adopted_paths: ["rtl/a.v"],
    });

    const replay = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      adoptionBody,
      adoptionKey,
    );
    expect(replay.status).toBe(201);
    expect(data(replay.json)).toEqual(adoptedData);

    const changedRequest = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      { ...adoptionBody, reason: "same key must not authorize a changed request" },
      adoptionKey,
    );
    expect(changedRequest.status).toBe(409);
    expect(error(changedRequest.json)).toMatchObject({
      code: "conflict",
      message: "IDEMPOTENCY_CONFLICT",
    });
    const idempotency = await harness.client.query(
      `SELECT status,request_hash,response
         FROM idempotency_records
        WHERE actor_type='human' AND actor_id=$1 AND project_id=$2
          AND operation=$3 AND idempotency_key=$4`,
      [harness.ids.humanUid, seeded.projectId, `adopt_side_task:${side.task_id}`, adoptionKey],
    );
    expect(idempotency.rows).toEqual([
      expect.objectContaining({
        status: "completed",
        request_hash: canonicalRequestHash(adoptionBody),
        response: adoptedData,
      }),
    ]);

    const mainA = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/workspace/file?path=rtl%2Fa.v`,
      { token: harness.ids.humanToken },
    );
    const mainB = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/workspace/file?path=rtl%2Fb.v`,
      { token: harness.ids.humanToken },
    );
    expect(data(mainA.json).content).toContain("1'b1");
    expect(data(mainB.json).content).toContain("1'b0");
    const revisions = await harness.client.query(
      `SELECT a.title,COUNT(*)::int AS count
         FROM artifact_revision ar JOIN artifact a ON a.id=ar.artifact_id
        WHERE ar.project_id=$1 GROUP BY a.title ORDER BY a.title`,
      [seeded.projectId],
    );
    expect(revisions.rows).toEqual([
      { title: "rtl/a.v", count: 2 },
      { title: "rtl/b.v", count: 1 },
    ]);

    const duplicate = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      { ...adoptionBody, adoption_id: `adopt-${randomUUID()}` },
    );
    expect(duplicate.status).toBe(409);
    expect(error(duplicate.json).message).toContain("SIDE_TASK_ADOPTION_CONFLICT");
  });

  test("same-path mainline drift conflicts the whole selected batch", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded);
    const result = await writeAndFinalize(seeded, side);
    const diff = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/diff`,
      { token: harness.ids.humanToken },
    );
    const preview = data<{
      preview_hash: string;
      files: Array<{
        path: string;
        base_hash: string | null;
        result_hash: string;
        current_target_hash: string | null;
      }>;
    }>(diff.json);
    const drift = await post(`/api/v1/projects/${seeded.projectId}/workspace/files`, {
      files: [{ path: "rtl/a.v", content: "module a; assign y = 1'bx; endmodule\n" }],
      change_reason: "concurrent mainline change",
    });
    expect(drift.status).toBe(200);
    const response = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      {
        adoption_id: `adopt-${randomUUID()}`,
        result_id: result.result_id,
        preview_hash: preview.preview_hash,
        reason: "this must conflict atomically",
        files: preview.files.map((file) => ({
          path: file.path,
          expected_base_hash: file.base_hash,
          expected_proposed_hash: file.result_hash,
          expected_target_hash: file.current_target_hash,
        })),
      },
    );
    expect(response.status).toBe(409);
    const mainB = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/workspace/file?path=rtl%2Fb.v`,
      { token: harness.ids.humanToken },
    );
    expect(data(mainB.json).content).toContain("1'b0");
    const adoption = await harness.client.query(
      "SELECT state FROM task_adoption WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
      [side.task_id],
    );
    expect(adoption.rows[0].state).toBe("conflicted");
  });

  test("unselected result-path drift does not block a safe selected-file adoption", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded);
    const result = await writeAndFinalize(seeded, side);
    const diff = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/diff`,
      { token: harness.ids.humanToken },
    );
    const preview = data<{
      preview_hash: string;
      files: Array<{
        path: string;
        base_hash: string | null;
        result_hash: string;
        current_target_hash: string | null;
      }>;
    }>(diff.json);
    const selected = preview.files.find((file) => file.path === "rtl/a.v")!;

    const unrelatedDrift = await post(`/api/v1/projects/${seeded.projectId}/workspace/files`, {
      files: [{ path: "rtl/b.v", content: "module b; assign y = 1'bx; endmodule\n" }],
      change_reason: "change an unselected result path after preview",
    });
    expect(unrelatedDrift.status).toBe(200);

    const adopted = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      {
        adoption_id: `adopt-${randomUUID()}`,
        result_id: result.result_id,
        preview_hash: preview.preview_hash,
        reason: "只采纳仍未变化的 a.v",
        files: [{
          path: selected.path,
          expected_base_hash: selected.base_hash,
          expected_proposed_hash: selected.result_hash,
          expected_target_hash: selected.current_target_hash,
        }],
      },
    );
    expect(adopted.status).toBe(201);
    expect(data(adopted.json)).toMatchObject({
      status: "applied",
      adopted_paths: ["rtl/a.v"],
    });

    const mainA = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/workspace/file?path=rtl%2Fa.v`,
      { token: harness.ids.humanToken },
    );
    const mainB = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/workspace/file?path=rtl%2Fb.v`,
      { token: harness.ids.humanToken },
    );
    expect(data(mainA.json).content).toContain("1'b1");
    expect(data(mainB.json).content).toContain("1'bx");
    const adoption = await harness.client.query(
      "SELECT details FROM task_adoption WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
      [side.task_id],
    );
    expect(adoption.rows[0].details).toMatchObject({
      preview_changed_unselected: true,
      current_preview_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("an applying adoption recovers after Git commit succeeded before DB completion", async () => {
    const seeded = await seedProject();
    const side = await createSide(seeded);
    const result = await writeAndFinalize(seeded, side);
    const diff = await apiCall(
      harness.baseUrl,
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/diff`,
      { token: harness.ids.humanToken },
    );
    const preview = data<{
      preview_hash: string;
      files: Array<{
        path: string;
        base_hash: string | null;
        result_hash: string;
        current_target_hash: string | null;
      }>;
    }>(diff.json);
    const selected = preview.files.find((file) => file.path === "rtl/a.v")!;
    const adoptionId = `adopt-${randomUUID()}`;
    const reason = "recover interrupted adoption";
    const files = [{
      path: selected.path,
      expected_base_hash: selected.base_hash,
      expected_proposed_hash: selected.result_hash,
      expected_target_hash: selected.current_target_hash,
    }];
    const selectionHash = canonicalRequestHash({
      schema: "task-adoption-selection.v1",
      taskId: side.task_id,
      resultId: result.result_id,
      previewHash: preview.preview_hash,
      files,
    });
    await harness.client.query(
      `INSERT INTO task_adoption
         (id,project_id,task_id,result_id,state,selection_hash,project_commit_before,
          reason,details,created_by_type,created_by,created_at)
       VALUES ($1,$2,$3,$4,'applying',$5,$6,$7,$8::jsonb,'human',$9,now())`,
      [
        adoptionId,
        seeded.projectId,
        side.task_id,
        result.result_id,
        selectionHash,
        seeded.baseCommit,
        reason,
        JSON.stringify({ preview_hash: preview.preview_hash, files }),
        harness.ids.humanUid,
      ],
    );
    const committed = await writeAndCommit(
      seeded.projectId,
      [{ path: "rtl/a.v", content: "module a; assign y = 1'b1; endmodule\n" }],
      `interrupted adoption\n\nadoption: ${adoptionId}`,
      { name: "Human Tester", email: "human@test.local" },
    );
    expect(committed.commit).not.toBe(seeded.baseCommit);

    const unrelated = await writeAndCommit(
      seeded.projectId,
      [{ path: "doc/recovery-note.md", content: "unrelated work after the adoption commit\n" }],
      "unrelated commit after interrupted adoption",
      { name: "Human Tester", email: "human@test.local" },
    );
    expect(unrelated.commit).not.toBe(committed.commit);
    expect(await headSha(projectWorkspaceDir(seeded.projectId))).toBe(unrelated.commit);

    const recovered = await post(
      `/api/v1/projects/${seeded.projectId}/tasks/${side.task_id}/adoptions`,
      {
        adoption_id: adoptionId,
        result_id: result.result_id,
        preview_hash: preview.preview_hash,
        reason,
        files,
      },
    );
    expect(recovered.status).toBe(201);
    expect(data(recovered.json)).toMatchObject({
      status: "applied",
      adopted_paths: ["rtl/a.v"],
      project_commit_after: committed.commit,
    });
    const recoveredRows = await harness.client.query(
      `SELECT ta.state,taf.target_revision_id,ar.state AS revision_state
         FROM task_adoption ta
         JOIN task_adoption_file taf ON taf.adoption_id=ta.id
         JOIN artifact_revision ar ON ar.id=taf.target_revision_id
        WHERE ta.id=$1`,
      [adoptionId],
    );
    expect(recoveredRows.rows).toEqual([
      expect.objectContaining({ state: "applied", revision_state: "candidate" }),
    ]);
  });

  test("recovery accepts an adoption commit whose recorded before-commit is an ancestor", async () => {
    const fixture = await seedApplyingAdoption();
    const unrelated = await writeAndCommit(
      fixture.seeded.projectId,
      [{ path: "doc/before-forgery.md", content: "commit inserted after the recorded preimage\n" }],
      "unrelated commit before forged adoption marker",
      { name: "Human Tester", email: "human@test.local" },
    );
    expect(unrelated.commit).not.toBe(fixture.seeded.baseCommit);
    const adoptionCommit = await writeAndCommit(
      fixture.seeded.projectId,
      [{ path: "rtl/a.v", content: "module a; assign y = 1'b1; endmodule\n" }],
      `interrupted adoption after unrelated work\n\nadoption: ${fixture.adoptionId}`,
      { name: "Human Tester", email: "human@test.local" },
    );
    expect(adoptionCommit.commit).not.toBe(unrelated.commit);

    const response = await post(
      `/api/v1/projects/${fixture.seeded.projectId}/tasks/${fixture.side.task_id}/adoptions`,
      {
        adoption_id: fixture.adoptionId,
        result_id: fixture.result.result_id,
        preview_hash: fixture.preview.preview_hash,
        reason: fixture.reason,
        files: fixture.files,
      },
    );
    expect(response.status).toBe(201);
    expect(data(response.json)).toMatchObject({
      status: "applied",
      adopted_paths: ["rtl/a.v"],
      project_commit_before: fixture.seeded.baseCommit,
      project_commit_after: adoptionCommit.commit,
    });
    const adoption = await harness.client.query(
      "SELECT state,project_commit_after FROM task_adoption WHERE id=$1",
      [fixture.adoptionId],
    );
    expect(adoption.rows[0]).toMatchObject({
      state: "applied",
      project_commit_after: adoptionCommit.commit,
    });
    const adoptedFiles = await harness.client.query(
      "SELECT COUNT(*)::int AS count FROM task_adoption_file WHERE adoption_id=$1",
      [fixture.adoptionId],
    );
    expect(adoptedFiles.rows[0].count).toBe(1);
  });

  test("recovery proves an added path was absent from the candidate parent", async () => {
    const fixture = await seedApplyingAdoption({ addedPath: true });
    expect(fixture.files).toEqual([
      expect.objectContaining({
        path: "doc/new-note.md",
        expected_base_hash: null,
        expected_target_hash: null,
      }),
    ]);
    const committed = await writeAndCommit(
      fixture.seeded.projectId,
      [{ path: "doc/new-note.md", content: "new exploration note\n" }],
      `interrupted added-file adoption\n\nadoption: ${fixture.adoptionId}`,
      { name: "Human Tester", email: "human@test.local" },
    );

    const response = await post(
      `/api/v1/projects/${fixture.seeded.projectId}/tasks/${fixture.side.task_id}/adoptions`,
      {
        adoption_id: fixture.adoptionId,
        result_id: fixture.result.result_id,
        preview_hash: fixture.preview.preview_hash,
        reason: fixture.reason,
        files: fixture.files,
      },
    );
    expect(response.status).toBe(201);
    expect(data(response.json)).toMatchObject({
      status: "applied",
      adopted_paths: ["doc/new-note.md"],
      project_commit_after: committed.commit,
    });
  });

  test("an adoption marker whose parent bytes do not match the selected preimage is not recovered", async () => {
    const fixture = await seedApplyingAdoption({
      expectedTargetHash: sha256Hex("not the actual project preimage\n"),
    });
    const forged = await writeAndCommit(
      fixture.seeded.projectId,
      [{ path: "rtl/a.v", content: "module a; assign y = 1'b1; endmodule\n" }],
      `forged preimage marker\n\nadoption: ${fixture.adoptionId}`,
      { name: "Human Tester", email: "human@test.local" },
    );
    expect(forged.commit).not.toBe(fixture.seeded.baseCommit);

    const response = await post(
      `/api/v1/projects/${fixture.seeded.projectId}/tasks/${fixture.side.task_id}/adoptions`,
      {
        adoption_id: fixture.adoptionId,
        result_id: fixture.result.result_id,
        preview_hash: fixture.preview.preview_hash,
        reason: fixture.reason,
        files: fixture.files,
      },
    );
    expect(response.status).toBe(409);
    const adoption = await harness.client.query(
      "SELECT state,project_commit_after FROM task_adoption WHERE id=$1",
      [fixture.adoptionId],
    );
    expect(adoption.rows[0]).toMatchObject({ state: "conflicted", project_commit_after: null });
    const adoptedFiles = await harness.client.query(
      "SELECT COUNT(*)::int AS count FROM task_adoption_file WHERE adoption_id=$1",
      [fixture.adoptionId],
    );
    expect(adoptedFiles.rows[0].count).toBe(0);
  });
});
