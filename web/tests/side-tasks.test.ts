import { describe, expect, test } from "bun:test";
import {
  SideTaskContractError,
  buildCreateSideTaskRequest,
  buildSideTaskAdoptionRequest,
  formatSideTaskHash,
  isSafeSideTaskWritePath,
  normalizeSideTaskWritePath,
  parseSideTask,
  parseSideTaskConversationPage,
  parseSideTaskDiff,
  parseSideTaskList,
  parseSideTaskResult,
  prepareSideTaskAdoptionAttempt,
  prepareSideTaskCreateAttempt,
  shouldPollSideTasks,
} from "../src/domain/side-tasks.ts";
import {
  parseExplicitFeatureFlag,
  shouldShowSideTasks,
} from "../src/domain/feature-flags.ts";
import {
  DEEP_SIDE_TASK_PATH,
  INVALID_SIDE_TASK_PATHS,
  MAX_BYTES_SIDE_TASK_PATH,
  TOO_DEEP_SIDE_TASK_PATH,
  TOO_MANY_BYTES_SIDE_TASK_PATH,
  VALID_SIDE_TASK_PATHS,
  sideTaskPaths,
} from "./side-task-contract-vectors.ts";

const H = (char: string): string => char.repeat(64);
const C = "a".repeat(40);

const SIDE_TASK = {
  task_id: "side-test-1",
  project_id: "p1",
  kind: "side",
  parent_task_id: "main-test-1",
  workspace_id: "ws-side-test-1",
  objective: "比较两种实现",
  status: "succeeded",
  input_hash: H("1"),
  output_hash: H("2"),
  adoption_state: "available",
  authorization_scope: {
    schema: "task-scope.v1",
    workspace: "isolated",
    read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
    write_paths: ["rtl/a.v", "tb/a_tb.sv"],
    run_classes: ["exploratory"],
    can_submit_gates: false,
    can_create_milestones: false,
    can_start_formal_runs: false,
  },
  base_commit: C,
  base_manifest_hash: H("3"),
  workspace_state: "sealed",
  created_at: "2026-08-21T01:00:00.000Z",
  updated_at: "2026-08-21T01:03:00.000Z",
  finished_at: "2026-08-21T01:03:00.000Z",
  failure_reason: null,
};

const DIFF = {
  task_id: SIDE_TASK.task_id,
  result_id: "result-test-1",
  preview_hash: H("4"),
  files: [
    {
      path: "rtl/a.v",
      change_kind: "modified",
      base_hash: H("5"),
      result_hash: H("6"),
      current_target_hash: H("5"),
      diff: "@@ -1 +1 @@\n-old\n+new",
      conflict_reason: null,
      adopted: false,
    },
    {
      path: "tb/a_tb.sv",
      change_kind: "added",
      base_hash: null,
      result_hash: H("7"),
      current_target_hash: null,
      diff: "@@ -0,0 +1 @@\n+module a_tb; endmodule",
      conflict_reason: "目标路径已存在",
      adopted: false,
    },
  ],
};

describe("P3 side-task domain contract", () => {
  test("feature flag is explicit opt-in for both free and engineering projects", () => {
    expect(parseExplicitFeatureFlag("1")).toBe(true);
    for (const value of [undefined, null, "", "0", "true", true, 1]) {
      expect(parseExplicitFeatureFlag(value)).toBe(false);
    }
    expect(shouldShowSideTasks(true, "engineering")).toBe(true);
    expect(shouldShowSideTasks(true, "free")).toBe(true);
    expect(shouldShowSideTasks(false, "engineering")).toBe(false);
    expect(shouldShowSideTasks(false, "free")).toBe(false);
    expect(shouldShowSideTasks(true, "legacy")).toBe(false);
    expect(shouldShowSideTasks(true, undefined)).toBe(false);
  });

  test("mirrors Core controlled roots plus the 512-byte and 32-segment limits", () => {
    for (const path of VALID_SIDE_TASK_PATHS) {
      expect(isSafeSideTaskWritePath(path), path).toBe(true);
    }
    for (const path of INVALID_SIDE_TASK_PATHS) {
      expect(isSafeSideTaskWritePath(path), path).toBe(false);
    }
    expect(normalizeSideTaskWritePath("./rtl/normalized.v")).toBe("rtl/normalized.v");
    expect(normalizeSideTaskWritePath(DEEP_SIDE_TASK_PATH)).toBe(DEEP_SIDE_TASK_PATH);
    expect(new TextEncoder().encode(MAX_BYTES_SIDE_TASK_PATH).byteLength).toBe(512);
    expect(normalizeSideTaskWritePath(TOO_DEEP_SIDE_TASK_PATH)).toBeNull();
    expect(new TextEncoder().encode(TOO_MANY_BYTES_SIDE_TASK_PATH).byteLength).toBe(515);
    expect(normalizeSideTaskWritePath(TOO_MANY_BYTES_SIDE_TASK_PATH)).toBeNull();
  });

  test("accepts at most 32 write paths and rejects 33 plus normalized duplicates", () => {
    for (const count of [1, 32]) {
      const parsed = buildCreateSideTaskRequest({
        parentTaskId: "main-test-1",
        objective: `授权 ${count} 个文件`,
        baseCommit: C,
        writePathsText: sideTaskPaths(count).join("\n"),
      });
      expect(parsed.ok, String(count)).toBe(true);
      if (parsed.ok) expect(parsed.request.authorization_scope.write_paths).toHaveLength(count);
    }
    expect(buildCreateSideTaskRequest({
      parentTaskId: "main-test-1",
      objective: "授权过多文件",
      baseCommit: C,
      writePathsText: sideTaskPaths(33).join("\n"),
    })).toMatchObject({ ok: false, message: expect.stringContaining("32") });
    expect(buildCreateSideTaskRequest({
      parentTaskId: "main-test-1",
      objective: "规范化后重复",
      baseCommit: C,
      writePathsText: "rtl/a.v\n./rtl/a.v",
    })).toMatchObject({ ok: false, message: expect.stringContaining("重复") });
  });

  test("builds only the frozen task-scope.v1 create request", () => {
    const parsed = buildCreateSideTaskRequest({
      parentTaskId: "main-test-1",
      objective: "  比较两种实现  ",
      baseCommit: C,
      writePathsText: "rtl/a.v\ntb/a_tb.sv",
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        kind: "side",
        parent_task_id: "main-test-1",
        objective: "比较两种实现",
        base_commit: C,
        authorization_scope: {
          schema: "task-scope.v1",
          workspace: "isolated",
          read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
          write_paths: ["rtl/a.v", "tb/a_tb.sv"],
          run_classes: ["exploratory"],
          can_submit_gates: false,
          can_create_milestones: false,
          can_start_formal_runs: false,
        },
      },
    });
    expect(buildCreateSideTaskRequest({
      parentTaskId: "main-test-1",
      objective: "目标",
      baseCommit: null,
      writePathsText: "rtl/a.v",
    })).toMatchObject({ ok: false, message: expect.stringContaining("可信") });
    expect(buildCreateSideTaskRequest({
      parentTaskId: "main-test-1",
      objective: "目标",
      baseCommit: C,
      writePathsText: "rtl/*.v",
    })).toMatchObject({ ok: false, message: expect.stringContaining("通配符") });
  });

  test("strictly parses canonical task/list state and rejects temporary legacy states", () => {
    expect(parseSideTask(SIDE_TASK)).toMatchObject({ task_id: "side-test-1", status: "succeeded" });
    expect(parseSideTaskList({ tasks: [SIDE_TASK] })).toHaveLength(1);
    expect(parseSideTaskList({ agents: [{ kind: "main" }, SIDE_TASK] })).toHaveLength(1);
    for (const status of ["dispatching", "idle", "interrupted", "aborted"]) {
      expect(() => parseSideTask({ ...SIDE_TASK, status })).toThrow(SideTaskContractError);
    }
    expect(() => parseSideTask({ ...SIDE_TASK, adoption_state: "not_adopted" })).toThrow(SideTaskContractError);
    expect(() => parseSideTask({
      ...SIDE_TASK,
      authorization_scope: { ...SIDE_TASK.authorization_scope, write_paths: ["rtl/**"] },
    })).toThrow(SideTaskContractError);
    expect(() => parseSideTask({
      ...SIDE_TASK,
      authorization_scope: { ...SIDE_TASK.authorization_scope, can_delete_project: false },
    })).toThrow(SideTaskContractError);
  });

  test("strictly parses ordered Core conversation events", () => {
    const page = {
      task_id: SIDE_TASK.task_id,
      events: [
        {
          id: "te-1",
          sequence: 1,
          event_kind: "user_message",
          payload: { text: "先比较方案" },
          payload_hash: H("8"),
          actor_type: "human",
          actor_id: "user-1",
          created_at: "2026-08-21T01:00:00.000Z",
        },
        {
          id: "te-2",
          sequence: 2,
          event_kind: "assistant_message",
          payload: { text: "需要确认时序优先级" },
          payload_hash: H("9"),
          actor_type: "service",
          actor_id: "runtime",
          created_at: "2026-08-21T01:01:00.000Z",
        },
      ],
      next_after: 2,
    };
    expect(parseSideTaskConversationPage(page)).toEqual(page);
    expect(() => parseSideTaskConversationPage({
      ...page,
      events: [page.events[1], page.events[0]],
    })).toThrow(SideTaskContractError);
    expect(() => parseSideTaskConversationPage({ ...page, next_after: 1 })).toThrow(SideTaskContractError);
  });

  test("result and diff reject missing hashes, deletion, unsafe paths, and duplicate files", () => {
    const result = {
      result_id: "result-test-1",
      task_id: SIDE_TASK.task_id,
      workspace_id: SIDE_TASK.workspace_id,
      base_commit: C,
      result_commit: "b".repeat(40),
      summary: "探索完成",
      tests: [{ name: "xsim", status: "passed", detail: null }],
      files: [{
        path: "rtl/a.v",
        change_kind: "modified",
        base_hash: H("5"),
        result_hash: H("6"),
        size_bytes: 12,
      }],
      output_hash: H("2"),
      created_at: "2026-08-21T01:03:00.000Z",
    };
    expect(parseSideTaskResult(result).files).toHaveLength(1);
    expect(parseSideTaskDiff(DIFF).files).toHaveLength(2);
    expect(() => parseSideTaskResult({ ...result, files: [{ ...result.files[0], change_kind: "deleted" }] })).toThrow();
    expect(() => parseSideTaskResult({ ...result, files: [{ ...result.files[0], path: "../a.v" }] })).toThrow();
    expect(() => parseSideTaskResult({ ...result, files: [result.files[0], result.files[0]] })).toThrow();
    expect(() => parseSideTaskDiff({ ...DIFF, preview_hash: null })).toThrow();
    expect(() => parseSideTaskDiff({ ...DIFF, files: [{ ...DIFF.files[0], result_hash: undefined }] })).toThrow();
  });

  test("adoption request freezes all preview hashes and blocks conflicts/repeats", () => {
    const diff = parseSideTaskDiff(DIFF);
    const parsed = buildSideTaskAdoptionRequest(diff, new Set(["rtl/a.v"]), "采用时序更稳的实现", "adopt-test-1");
    expect(parsed).toEqual({
      ok: true,
      request: {
        adoption_id: "adopt-test-1",
        result_id: "result-test-1",
        preview_hash: H("4"),
        reason: "采用时序更稳的实现",
        files: [{
          path: "rtl/a.v",
          expected_base_hash: H("5"),
          expected_proposed_hash: H("6"),
          expected_target_hash: H("5"),
        }],
      },
    });
    expect(buildSideTaskAdoptionRequest(diff, new Set(["tb/a_tb.sv"]), "理由", "adopt-test-2"))
      .toMatchObject({ ok: false, message: expect.stringContaining("冲突") });
    expect(buildSideTaskAdoptionRequest(diff, new Set(), "理由", "adopt-test-3"))
      .toMatchObject({ ok: false, message: expect.stringContaining("至少选择") });
    expect(buildSideTaskAdoptionRequest(diff, new Set(["rtl/a.v"]), "", "adopt-test-4"))
      .toMatchObject({ ok: false, message: expect.stringContaining("理由") });
  });

  test("reuses exact create/adoption attempts until the user changes or clears the draft", () => {
    const create = buildCreateSideTaskRequest({
      parentTaskId: "main-test-1",
      objective: "比较实现",
      baseCommit: C,
      writePathsText: "rtl/a.v",
    });
    if (!create.ok) throw new Error(create.message);
    let keyCalls = 0;
    const firstCreate = prepareSideTaskCreateAttempt(null, create.request, () => `create-${++keyCalls}`);
    const retriedCreate = prepareSideTaskCreateAttempt(firstCreate, { ...create.request }, () => `create-${++keyCalls}`);
    expect(retriedCreate).toBe(firstCreate);
    expect(keyCalls).toBe(1);
    const changedCreate = prepareSideTaskCreateAttempt(firstCreate, {
      ...create.request,
      objective: "修改后的目标",
    }, () => `create-${++keyCalls}`);
    expect(changedCreate.idempotencyKey).toBe("create-2");
    const clearedCreate = prepareSideTaskCreateAttempt(null, create.request, () => `create-${++keyCalls}`);
    expect(clearedCreate.idempotencyKey).toBe("create-3");

    const diff = parseSideTaskDiff(DIFF);
    const firstRequest = buildSideTaskAdoptionRequest(diff, new Set(["rtl/a.v"]), "采纳理由", "adopt-first");
    const retryRequest = buildSideTaskAdoptionRequest(diff, new Set(["rtl/a.v"]), "采纳理由", "adopt-retry");
    if (!firstRequest.ok || !retryRequest.ok) throw new Error("adoption fixture invalid");
    const firstAdoption = prepareSideTaskAdoptionAttempt(null, SIDE_TASK.task_id, firstRequest.request);
    const retriedAdoption = prepareSideTaskAdoptionAttempt(firstAdoption, SIDE_TASK.task_id, retryRequest.request);
    expect(retriedAdoption).toBe(firstAdoption);
    expect(retriedAdoption.request.adoption_id).toBe("adopt-first");
    const changedAdoption = prepareSideTaskAdoptionAttempt(firstAdoption, SIDE_TASK.task_id, {
      ...retryRequest.request,
      reason: "修改后的理由",
    });
    expect(changedAdoption.request.adoption_id).toBe("adopt-retry");
  });

  test("polls only active side tasks while the drawer is open", () => {
    expect(shouldPollSideTasks(false, [{ ...SIDE_TASK, status: "running" }])).toBe(false);
    for (const status of ["queued", "running", "awaiting_user"] as const) {
      expect(shouldPollSideTasks(true, [{ ...SIDE_TASK, status }]), status).toBe(true);
    }
    for (const status of ["succeeded", "failed", "cancelled", "fail_closed"] as const) {
      expect(shouldPollSideTasks(true, [{ ...SIDE_TASK, status }]), status).toBe(false);
    }
  });

  test("formats all adoption hashes and names a missing file explicitly", () => {
    expect(formatSideTaskHash(H("a"))).toBe(H("a"));
    expect(formatSideTaskHash(null)).toBe("不存在");
  });
});
