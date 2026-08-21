import { beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import {
  abortAgent,
  adoptSideTask,
  createSideTask,
  getSideTask,
  getSideTaskDiff,
  getSideTaskEvents,
  getSideTaskResult,
  getRevisionContent,
  listArtifacts,
  listRevisions,
  listSideTasks,
  listTasks,
  sendMessage,
} from "../src/api/index.ts";
import {
  buildCreateSideTaskRequest,
  buildSideTaskAdoptionRequest,
} from "../src/domain/side-tasks.ts";
import {
  LIVE_AGENT_ID,
  MOCK_P3_STATE_STORAGE_KEY,
  MOCK_PROJECT_HEAD_COMMIT,
  MOCK_SIDE_TASK_CONTENTS,
  MOCK_SIDE_TASK_DIFFS,
  MOCK_SIDE_TASK_RESULTS,
  MOCK_SIDE_TASKS,
  mockState,
  parseStoredMockP3State,
  restorePersistedMockP3State,
} from "../src/mock/data.ts";
import {
  MOCK_SIDE_TASKS_MODE_KEY,
  mockApiFetch,
} from "../src/mock/server.ts";
import type { AdoptSideTaskRequest } from "../src/api/types.ts";
import { sha256Bytes } from "../src/util/sha256.ts";
import {
  DEEP_SIDE_TASK_PATH,
  INVALID_SIDE_TASK_PATHS,
  sideTaskPaths,
} from "./side-task-contract-vectors.ts";

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await mockApiFetch(input, init);
  if (!response) throw new Error(`unexpected non-mock request: ${String(input)}`);
  return response;
}) as typeof fetch;

const client = createClient({ fetchImpl: mockFetch });

beforeEach(() => {
  mockState.agentBDone = false;
  mockState.sideTasks.p1 = MOCK_SIDE_TASKS.map((task) => ({
    ...task,
    authorization_scope: { ...task.authorization_scope, write_paths: [...task.authorization_scope.write_paths] },
  }));
  mockState.sideTaskResults = Object.fromEntries(
    Object.entries(MOCK_SIDE_TASK_RESULTS).map(([taskId, result]) => [taskId, {
      ...result,
      files: result.files.map((file) => ({ ...file })),
      tests: result.tests.map((row) => ({ ...row })),
    }]),
  );
  mockState.sideTaskDiffs = Object.fromEntries(
    Object.entries(MOCK_SIDE_TASK_DIFFS).map(([taskId, diff]) => [taskId, {
      ...diff,
      files: diff.files.map((file) => ({ ...file })),
    }]),
  );
  mockState.sideTaskAdoptions = {};
  mockState.sideTaskCreateOperations = {};
  mockState.sideTaskEvents = {};
  mockState.sideTaskMessageOperations = {};
  mockState.sideTaskPollCounts = {};
  mockState.projectHeadCommits.p1 = MOCK_PROJECT_HEAD_COMMIT;
  mockState.importArtifacts = {};
  mockState.importRevisions = {};
  mockState.importRevisionContent = {};
});

describe("P3 side-task mock API", () => {
  test("main abort sends an empty JSON command with a required stable idempotency key", async () => {
    const key = `abort-${crypto.randomUUID()}`;
    expect(await abortAgent(client, "p1", LIVE_AGENT_ID, key)).toEqual({
      aborted: true,
      status: "interrupted",
    });
    await expect(client(`/api/v1/projects/p1/tasks/${LIVE_AGENT_ID}/abort`, {
      method: "POST",
      body: {},
    })).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  test("main task list remains independent while side list uses the same frozen route", async () => {
    const main = await listTasks(client, "p1");
    const side = await listSideTasks(client, "p1");
    expect(main.agents.length).toBeGreaterThan(0);
    expect(main.agents.every((task) => task.kind !== "side")).toBe(true);
    expect(side).toHaveLength(MOCK_SIDE_TASKS.length);
    expect(side.every((task) => task.kind === "side")).toBe(true);
    expect(side.map((task) => task.status)).toEqual(expect.arrayContaining(["running", "succeeded", "fail_closed"]));
  });

  test("creates an isolated side task with a trustworthy base commit and safe idempotent replay", async () => {
    const parsed = buildCreateSideTaskRequest({
      parentTaskId: LIVE_AGENT_ID,
      objective: "比较新增寄存器后的关键路径",
      baseCommit: MOCK_PROJECT_HEAD_COMMIT,
      writePathsText: "rtl/pwm_gen.v\ntb/pwm_reg_tb.sv",
    });
    if (!parsed.ok) throw new Error(parsed.message);
    const key = `idem-create-side-${crypto.randomUUID()}`;
    const created = await createSideTask(client, "p1", parsed.request, key);
    expect(created).toMatchObject({
      project_id: "p1",
      kind: "side",
      parent_task_id: LIVE_AGENT_ID,
      status: "queued",
      base_commit: MOCK_PROJECT_HEAD_COMMIT,
      adoption_state: "pending",
      workspace_state: "active",
    });
    expect(created.task_id).not.toBe(LIVE_AGENT_ID);
    expect(await createSideTask(client, "p1", parsed.request, key)).toEqual(created);
    await expect(createSideTask(client, "p1", {
      ...parsed.request,
      objective: "同键异体必须拒绝",
    }, key)).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await listSideTasks(client, "p1")).some((task) => task.task_id === created.task_id)).toBe(true);
  });

  test("mock and Web share Core's 32-path, byte, depth, and controlled-root boundaries", async () => {
    const requestFor = (paths: readonly string[]) => {
      const parsed = buildCreateSideTaskRequest({
        parentTaskId: LIVE_AGENT_ID,
        objective: `验证 ${paths.length} 条授权`,
        baseCommit: MOCK_PROJECT_HEAD_COMMIT,
        writePathsText: paths.join("\n"),
      });
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.request;
    };

    for (const count of [1, 32]) {
      const created = await createSideTask(
        client,
        "p1",
        requestFor(sideTaskPaths(count)),
        `boundary-${count}-${crypto.randomUUID()}`,
      );
      expect(created.authorization_scope.write_paths, String(count)).toHaveLength(count);
    }
    const deep = await createSideTask(
      client,
      "p1",
      requestFor([DEEP_SIDE_TASK_PATH]),
      `deep-${crypto.randomUUID()}`,
    );
    expect(deep.authorization_scope.write_paths).toEqual([DEEP_SIDE_TASK_PATH]);

    const valid = requestFor(["rtl/a.v"]);
    const expectInvalidScope = async (writePaths: readonly string[], extraScope: Record<string, unknown> = {}) => {
      await expect(createSideTask(client, "p1", {
        ...valid,
        authorization_scope: {
          ...valid.authorization_scope,
          ...extraScope,
          write_paths: writePaths,
        },
      }, `invalid-${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 400, code: "validation" });
    };
    await expectInvalidScope(sideTaskPaths(33));
    await expectInvalidScope(["rtl/a.v", "./rtl/a.v"]);
    await expectInvalidScope(["rtl/a.v"], { can_delete_project: false });
    for (const path of INVALID_SIDE_TASK_PATHS) await expectInvalidScope([path]);
  });

  test("reads canonical detail, sealed result, text diff, and conflict metadata", async () => {
    const succeeded = MOCK_SIDE_TASKS.find((task) => task.status === "succeeded")!;
    const detail = await getSideTask(client, "p1", succeeded.task_id);
    const result = await getSideTaskResult(client, "p1", succeeded.task_id);
    const diff = await getSideTaskDiff(client, "p1", succeeded.task_id);
    expect(detail).toMatchObject({ status: "succeeded", adoption_state: "available" });
    expect(result).toMatchObject({ task_id: succeeded.task_id, output_hash: succeeded.output_hash });
    expect(result.tests).toContainEqual(expect.objectContaining({ status: "passed" }));
    for (const file of result.files) {
      const content = MOCK_SIDE_TASK_CONTENTS[succeeded.task_id]?.[file.path];
      expect(content, file.path).toBeDefined();
      expect(sha256Bytes(new TextEncoder().encode(content!)), file.path).toBe(file.result_hash);
      expect(new TextEncoder().encode(content!).byteLength, file.path).toBe(file.size_bytes);
    }
    expect(diff.files).toContainEqual(expect.objectContaining({
      path: "rtl/pwm_gen.v",
      conflict_reason: expect.any(String),
      adopted: false,
    }));
    expect(diff.files).toContainEqual(expect.objectContaining({
      path: "tb/pwm_gen_explore_tb.sv",
      current_target_hash: null,
      conflict_reason: null,
    }));
  });

  test("persists side conversation events and idempotently resumes awaiting_user", async () => {
    const task = MOCK_SIDE_TASKS.find((row) => row.status === "running")!;
    const initial = await getSideTaskEvents(client, "p1", task.task_id);
    expect(initial.task_id).toBe(task.task_id);
    expect(initial.events).toContainEqual(expect.objectContaining({
      event_kind: "user_message",
      payload: expect.objectContaining({ text: task.objective }),
    }));

    const key = `side-message-${crypto.randomUUID()}`;
    expect(await sendMessage(client, "p1", task.task_id, "优先保持接口零拍延迟", key)).toEqual({
      accepted: true,
      status: "running",
    });
    const after = await getSideTaskEvents(client, "p1", task.task_id, initial.next_after);
    expect(after.events.map((event) => event.event_kind)).toEqual([
      "user_message",
      "status",
      "assistant_message",
      "status",
    ]);
    expect(after.events[0]?.payload).toEqual({ text: "优先保持接口零拍延迟" });
    expect(after.events[2]?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining("已收到") }));
    expect(await getSideTask(client, "p1", task.task_id)).toMatchObject({ status: "awaiting_user" });

    const count = (await getSideTaskEvents(client, "p1", task.task_id)).events.length;
    expect(await sendMessage(client, "p1", task.task_id, "优先保持接口零拍延迟", key)).toEqual({
      accepted: true,
      status: "running",
    });
    expect((await getSideTaskEvents(client, "p1", task.task_id)).events).toHaveLength(count);
    await expect(sendMessage(client, "p1", task.task_id, "改成优先时序", key))
      .rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("conflict is batch-atomic; partial adoption creates only selected candidate revisions", async () => {
    const task = MOCK_SIDE_TASKS.find((row) => row.status === "succeeded")!;
    const initial = await getSideTaskDiff(client, "p1", task.task_id);
    const rtl = initial.files.find((file) => file.path === "rtl/pwm_gen.v")!;
    const doc = initial.files.find((file) => file.path === "doc/arch/exploration.md")!;
    const conflictRequest: AdoptSideTaskRequest = {
      adoption_id: `adopt-conflict-${crypto.randomUUID()}`,
      result_id: initial.result_id,
      preview_hash: initial.preview_hash,
      reason: "验证整批冲突",
      files: [rtl, doc].map((file) => ({
        path: file.path,
        expected_base_hash: file.base_hash,
        expected_proposed_hash: file.result_hash,
        expected_target_hash: file.current_target_hash,
      })),
    };
    await expect(adoptSideTask(client, "p1", task.task_id, conflictRequest, conflictRequest.adoption_id))
      .rejects.toMatchObject({ status: 409, code: "SIDE_TASK_TARGET_CONFLICT" });
    expect((await getSideTaskDiff(client, "p1", task.task_id)).files.find((file) => file.path === doc.path)?.adopted).toBe(false);

    const parsed = buildSideTaskAdoptionRequest(
      initial,
      new Set(["tb/pwm_gen_explore_tb.sv"]),
      "采用新增探索 testbench，保留其余文件待定",
      `adopt-partial-${crypto.randomUUID()}`,
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const applied = await adoptSideTask(client, "p1", task.task_id, parsed.request, parsed.request.adoption_id);
    expect(applied).toMatchObject({
      status: "applied",
      adopted_paths: ["tb/pwm_gen_explore_tb.sv"],
      project_commit_before: MOCK_PROJECT_HEAD_COMMIT,
      project_commit_after: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(await adoptSideTask(client, "p1", task.task_id, parsed.request, parsed.request.adoption_id)).toEqual(applied);
    expect(await getSideTask(client, "p1", task.task_id)).toMatchObject({ adoption_state: "partially_adopted" });
    const after = await getSideTaskDiff(client, "p1", task.task_id);
    expect(after.files.find((file) => file.path === "tb/pwm_gen_explore_tb.sv")?.adopted).toBe(true);
    expect(after.files.find((file) => file.path === "doc/arch/exploration.md")?.adopted).toBe(false);

    const artifacts = await listArtifacts(client, "p1");
    const adoptedArtifact = artifacts.find((artifact) =>
      artifact.id.startsWith("side-p1-") && artifact.artifact_type === "TB_SOURCE_SET",
    );
    expect(adoptedArtifact).toBeDefined();
    const adoptedRevisions = await listRevisions(client, "p1", adoptedArtifact!.id);
    expect(adoptedRevisions).toContainEqual(expect.objectContaining({
      state: "candidate",
      content_location: "tb/pwm_gen_explore_tb.sv",
    }));
    const adoptedRevision = adoptedRevisions.find((revision) => revision.content_location === "tb/pwm_gen_explore_tb.sv")!;
    const adoptedContent = await getRevisionContent(client, "p1", adoptedArtifact!.id, adoptedRevision.id);
    expect(adoptedContent.content).toBe(MOCK_SIDE_TASK_CONTENTS[task.task_id]!["tb/pwm_gen_explore_tb.sv"]);
    expect(sha256Bytes(new TextEncoder().encode(adoptedContent.content))).toBe(adoptedContent.content_hash);
    expect(adoptedContent.content_hash).toBe(adoptedRevision.content_hash);
    expect(adoptedContent.content_hash).toBe(initial.files.find((file) => file.path === "tb/pwm_gen_explore_tb.sv")!.result_hash);
    expect(adoptedContent.content).not.toBe(initial.files.find((file) => file.path === "tb/pwm_gen_explore_tb.sv")!.diff);

    const adoptedFile = after.files.find((file) => file.path === "tb/pwm_gen_explore_tb.sv")!;
    const repeatRequest: AdoptSideTaskRequest = {
      adoption_id: `adopt-repeat-${crypto.randomUUID()}`,
      result_id: after.result_id,
      preview_hash: after.preview_hash,
      reason: "不应重复采纳",
      files: [{
        path: adoptedFile.path,
        expected_base_hash: adoptedFile.base_hash,
        expected_proposed_hash: adoptedFile.result_hash,
        expected_target_hash: adoptedFile.current_target_hash,
      }],
    };
    await expect(adoptSideTask(client, "p1", task.task_id, repeatRequest, repeatRequest.adoption_id))
      .rejects.toMatchObject({ status: 409, code: "SIDE_TASK_FILE_ALREADY_ADOPTED" });
  });

  test("versioned mock state restores creation, conversation, partial adoption, and idempotency after reload", async () => {
    const stored = new Map<string, string>();
    const fakeStorage: Storage = {
      get length() { return stored.size; },
      clear: () => stored.clear(),
      getItem: (key) => stored.get(key) ?? null,
      key: (index) => [...stored.keys()][index] ?? null,
      removeItem: (key) => { stored.delete(key); },
      setItem: (key, value) => { stored.set(key, value); },
    };
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
    try {
      const create = buildCreateSideTaskRequest({
        parentTaskId: LIVE_AGENT_ID,
        objective: "刷新后继续比较组合与流水线实现",
        baseCommit: MOCK_PROJECT_HEAD_COMMIT,
        writePathsText: "rtl/pwm_gen.v\ntb/reload_tb.sv",
      });
      if (!create.ok) throw new Error(create.message);
      const createKey = `persist-create-${crypto.randomUUID()}`;
      const created = await createSideTask(client, "p1", create.request, createKey);

      const conversational = MOCK_SIDE_TASKS.find((task) => task.status === "running")!;
      const messageKey = `persist-message-${crypto.randomUUID()}`;
      await getSideTaskEvents(client, "p1", conversational.task_id);
      await sendMessage(client, "p1", conversational.task_id, "刷新后仍保持零拍延迟", messageKey);

      const succeeded = MOCK_SIDE_TASKS.find((task) => task.status === "succeeded")!;
      const diff = await getSideTaskDiff(client, "p1", succeeded.task_id);
      const adoption = buildSideTaskAdoptionRequest(
        diff,
        new Set(["tb/pwm_gen_explore_tb.sv"]),
        "刷新后保留这份候选 testbench",
        `persist-adopt-${crypto.randomUUID()}`,
      );
      if (!adoption.ok) throw new Error(adoption.message);
      const applied = await adoptSideTask(
        client,
        "p1",
        succeeded.task_id,
        adoption.request,
        adoption.request.adoption_id,
      );

      const raw = stored.get(MOCK_P3_STATE_STORAGE_KEY) ?? null;
      const persisted = parseStoredMockP3State(raw);
      expect(persisted).not.toBeNull();
      expect(Object.values(persisted!.sideTaskCreateOperations).some((operation) => operation.result.task_id === created.task_id)).toBe(true);
      expect(persisted!.sideTaskEvents[conversational.task_id]).toContainEqual(expect.objectContaining({
        event_kind: "user_message",
        payload: { text: "刷新后仍保持零拍延迟" },
      }));
      expect(persisted!.sideTaskDiffs[succeeded.task_id]?.files.find((file) => file.path === "tb/pwm_gen_explore_tb.sv")?.adopted).toBe(true);
      expect(Object.values(persisted!.adoptionRevisions).flat()).toContainEqual(expect.objectContaining({
        state: "candidate",
        content_location: "tb/pwm_gen_explore_tb.sv",
      }));

      // Simulate a fresh module graph: discard every mutable P3 field, then hydrate
      // only from the validated localStorage envelope used during a real reload.
      mockState.sideTasks = {
        p1: MOCK_SIDE_TASKS.map((task) => ({
          ...task,
          authorization_scope: { ...task.authorization_scope, write_paths: [...task.authorization_scope.write_paths] },
        })),
      };
      mockState.sideTaskResults = Object.fromEntries(Object.entries(MOCK_SIDE_TASK_RESULTS));
      mockState.sideTaskDiffs = Object.fromEntries(Object.entries(MOCK_SIDE_TASK_DIFFS));
      mockState.sideTaskAdoptions = {};
      mockState.sideTaskCreateOperations = {};
      mockState.sideTaskEvents = {};
      mockState.sideTaskMessageOperations = {};
      mockState.sideTaskPollCounts = {};
      mockState.projectHeadCommits = { p1: MOCK_PROJECT_HEAD_COMMIT };
      mockState.importArtifacts = {};
      mockState.importRevisions = {};
      mockState.importRevisionContent = {};

      expect(restorePersistedMockP3State()).toBe(true);
      expect(await getSideTask(client, "p1", created.task_id)).toEqual(created);
      expect(await getSideTask(client, "p1", conversational.task_id)).toMatchObject({ status: "awaiting_user" });
      expect((await getSideTaskEvents(client, "p1", conversational.task_id)).events).toContainEqual(expect.objectContaining({
        event_kind: "user_message",
        payload: { text: "刷新后仍保持零拍延迟" },
      }));
      expect(await getSideTask(client, "p1", succeeded.task_id)).toMatchObject({ adoption_state: "partially_adopted" });
      expect((await getSideTaskDiff(client, "p1", succeeded.task_id)).files.find((file) => file.path === "tb/pwm_gen_explore_tb.sv")?.adopted).toBe(true);
      expect(mockState.projectHeadCommits.p1).toBe(applied.project_commit_after);

      const adoptedArtifact = (await listArtifacts(client, "p1")).find((artifact) => artifact.artifact_type === "TB_SOURCE_SET");
      expect(adoptedArtifact).toBeDefined();
      const adoptedRevision = (await listRevisions(client, "p1", adoptedArtifact!.id))
        .find((revision) => revision.content_location === "tb/pwm_gen_explore_tb.sv");
      expect(adoptedRevision).toBeDefined();
      expect(await getRevisionContent(client, "p1", adoptedArtifact!.id, adoptedRevision!.id)).toEqual({
        content: MOCK_SIDE_TASK_CONTENTS[succeeded.task_id]!["tb/pwm_gen_explore_tb.sv"],
        content_hash: adoptedRevision!.content_hash,
      });

      // A changed project HEAD or later task status must not invalidate an exact
      // replay whose durable result was already committed before the reload.
      expect(await createSideTask(client, "p1", create.request, createKey)).toEqual(created);
      expect(await sendMessage(client, "p1", conversational.task_id, "刷新后仍保持零拍延迟", messageKey)).toEqual({
        accepted: true,
        status: "running",
      });
      expect(await adoptSideTask(
        client,
        "p1",
        succeeded.task_id,
        adoption.request,
        adoption.request.adoption_id,
      )).toEqual(applied);
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test("version and sealed-content corruption reject the whole persisted P3 graph", async () => {
    expect(parseStoredMockP3State(JSON.stringify({ version: 2, state: {} }))).toBeNull();

    const stored = new Map<string, string>();
    const fakeStorage: Storage = {
      get length() { return stored.size; },
      clear: () => stored.clear(),
      getItem: (key) => stored.get(key) ?? null,
      key: (index) => [...stored.keys()][index] ?? null,
      removeItem: (key) => { stored.delete(key); },
      setItem: (key, value) => { stored.set(key, value); },
    };
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
    try {
      const succeeded = MOCK_SIDE_TASKS.find((task) => task.status === "succeeded")!;
      const diff = await getSideTaskDiff(client, "p1", succeeded.task_id);
      const adoption = buildSideTaskAdoptionRequest(
        diff,
        new Set(["tb/pwm_gen_explore_tb.sv"]),
        "生成可校验的持久化正文",
        `corrupt-adopt-${crypto.randomUUID()}`,
      );
      if (!adoption.ok) throw new Error(adoption.message);
      await adoptSideTask(client, "p1", succeeded.task_id, adoption.request, adoption.request.adoption_id);
      const envelope = JSON.parse(stored.get(MOCK_P3_STATE_STORAGE_KEY)!) as {
        state: { adoptionRevisionContent: Record<string, string> };
      };
      const revisionId = Object.keys(envelope.state.adoptionRevisionContent)[0]!;
      envelope.state.adoptionRevisionContent[revisionId] = "tampered";
      expect(parseStoredMockP3State(JSON.stringify(envelope))).toBeNull();
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test("empty projects and cross-project task ids do not leak side-task facts", async () => {
    expect(await listSideTasks(client, "legacy-p1")).toEqual([]);
    const taskId = MOCK_SIDE_TASKS[0]!.task_id;
    await expect(getSideTask(client, "legacy-p1", taskId)).rejects.toMatchObject({ status: 404 });
    await expect(getSideTaskResult(client, "legacy-p1", taskId)).rejects.toMatchObject({ status: 404 });
  });

  test("feature-off seals side-task writes but keeps existing facts readable", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const fakeStorage = {
      getItem(key: string) {
        return key === MOCK_SIDE_TASKS_MODE_KEY ? "error" : null;
      },
      setItem() {},
      removeItem() {},
      clear() {},
      key() { return null; },
      length: 1,
    } as Storage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage });
    try {
      const tasks = await listSideTasks(client, "p1");
      const succeeded = tasks.find((task) => task.status === "succeeded")!;
      expect(await getSideTask(client, "p1", succeeded.task_id)).toMatchObject({ task_id: succeeded.task_id });
      expect(await getSideTaskResult(client, "p1", succeeded.task_id)).toMatchObject({ task_id: succeeded.task_id });
      const diff = await getSideTaskDiff(client, "p1", succeeded.task_id);

      const create = buildCreateSideTaskRequest({
        parentTaskId: LIVE_AGENT_ID,
        objective: "feature-off 不得创建",
        baseCommit: MOCK_PROJECT_HEAD_COMMIT,
        writePathsText: "rtl/off.v",
      });
      if (!create.ok) throw new Error(create.message);
      await expect(createSideTask(client, "p1", create.request, `off-create-${crypto.randomUUID()}`))
        .rejects.toMatchObject({ status: 503, code: "SIDE_TASKS_UNAVAILABLE" });

      const adoption = buildSideTaskAdoptionRequest(
        diff,
        new Set(["tb/pwm_gen_explore_tb.sv"]),
        "feature-off 不得采纳",
        `off-adopt-${crypto.randomUUID()}`,
      );
      if (!adoption.ok) throw new Error(adoption.message);
      await expect(adoptSideTask(client, "p1", succeeded.task_id, adoption.request, adoption.request.adoption_id))
        .rejects.toMatchObject({ status: 503, code: "SIDE_TASKS_UNAVAILABLE" });
      expect((await listTasks(client, "p1")).agents.length).toBeGreaterThan(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
