import { describe, expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import type {
  GateSubmission,
  Project,
  TaskAgentSummary,
} from "../src/api/types.ts";
import {
  activeMainTasks,
  filterProjects,
  loadProjectOverview,
  pendingReviews,
} from "../src/domain/project-overview.ts";
import { loginDestination, viewKey } from "../src/domain/navigation.ts";
import { prepareWriteAttempt } from "../src/domain/write-attempt.ts";
import { MOCK_PROJECT } from "../src/mock/data.ts";
import { MOCK_P4_PROFILE } from "../src/mock/p4.ts";

const engineering: Project = { ...MOCK_PROJECT, id: "engineering" };
const free: Project = {
  ...MOCK_PROJECT,
  id: "free",
  name: "自由实验",
  project_type: "free",
  process_profile_id: null,
  process_version_id: null,
};
const submission: GateSubmission = {
  id: "sub-1",
  gate: "G2",
  state: "in_review",
  snapshot_id: "snap",
  process_instance_id: "pi",
  work_version_id: "wv",
  submitter_id: "reviewer",
  submitted_at: null,
  created_at: "2026-09-05T10:00:00Z",
};
const task = {
  agent_id: "main-task",
  kind: "main",
  status: "running",
  created_at: "2026-09-04T10:00:00Z",
} as TaskAgentSummary;

function clientFor(
  overrides: Record<string, unknown> = {},
  failures: readonly string[] = [],
) {
  const calls: string[] = [];
  const facts: Record<string, unknown> = {
    "/api/v1/projects": [engineering, free],
    "/api/v1/projects/engineering/gate-submissions": [submission],
    "/api/v1/projects/engineering/tasks": {
      agents: [task, { ...task, agent_id: "side-task", kind: "side" }],
    },
    "/api/v1/projects/free/tasks": { agents: [] },
    "/api/v1/process-versions/GJB_REF_V1/profile": MOCK_P4_PROFILE,
    "/api/v1/projects/engineering/process-state": {
      schema: "process-state.v1",
      projectId: "engineering",
      processInstanceId: "pi",
      profileId: "GJB_REF_V1",
      profileHash: MOCK_P4_PROFILE.profileHash,
      workVersionId: "wv",
      currentGate: "G4",
      completed: true,
      readiness: null,
    },
    ...overrides,
  };
  const client = createClient({
    fetchImpl: (async (path) => {
      const key = String(path);
      calls.push(key);
      if (failures.includes(key))
        return new Response(
          JSON.stringify({
            error: {
              code: "forbidden",
              message: "unavailable",
              retryable: false,
              correlation_id: "test",
            },
          }),
          { status: 403 },
        );
      if (!(key in facts)) throw new Error(`Unexpected request: ${key}`);
      return new Response(JSON.stringify({ data: facts[key] }));
    }) as typeof fetch,
  });
  return { client, calls };
}

describe("project overview business flow", () => {
  test("uses verified Core G0-G4 completion, not a legacy submission-derived stage", async () => {
    const { client, calls } = clientFor();
    const rows = await loadProjectOverview(client);
    const row = rows.find((row) => row.project.id === "engineering")!;
    expect(row.stage).toBe("实现与交付已完成");
    expect(row.progress).toEqual({ done: 5, total: 5 });
    expect(row.issues).toEqual([]);
    expect(pendingReviews(rows)[0]!.title).toBe(MOCK_P4_PROFILE.nodes[2]!.name);
    expect(
      calls.some(
        (call) =>
          call.includes("free/gate-submissions") ||
          call.includes("free/process-state"),
      ),
    ).toBe(false);
    expect(activeMainTasks(rows).map((item) => item.task.agent_id)).toEqual([
      "main-task",
    ]);
  });

  test("one inaccessible approval endpoint keeps other facts and projects usable", async () => {
    const { client } = clientFor({}, [
      "/api/v1/projects/engineering/gate-submissions",
    ]);
    const rows = await loadProjectOverview(client);
    expect(rows).toHaveLength(2);
    expect(activeMainTasks(rows)).toHaveLength(1);
    expect(
      rows
        .find((row) => row.project.id === "engineering")!
        .issues.map((issue) => issue.label),
    ).toEqual(["待审批记录"]);
    expect(rows.find((row) => row.project.id === "free")!.issues).toEqual([]);
  });

  test("task failure cannot erase a known pending approval", async () => {
    const { client } = clientFor({}, ["/api/v1/projects/engineering/tasks"]);
    const rows = await loadProjectOverview(client);
    expect(pendingReviews(rows)).toHaveLength(1);
    expect(rows[0]!.issues.map((issue) => issue.label)).toContain("任务状态");
  });

  test("profile mismatch is an unknown state rather than made-up progress", async () => {
    const { client } = clientFor({
      "/api/v1/process-versions/GJB_REF_V1/profile": {
        ...MOCK_P4_PROFILE,
        name: "tampered",
      },
    });
    const rows = await loadProjectOverview(client);
    const row = rows.find((row) => row.project.id === "engineering")!;
    expect(row.stage).toBe("流程状态暂不可用");
    expect(row.progress).toBeNull();
    expect(row.issues.map((issue) => issue.label)).toContain("正式流程状态");
    expect(pendingReviews(rows)).toHaveLength(1);
    expect(pendingReviews(rows)[0]!.title).toBe("G2 · 阶段审查");
  });

  test("top-level list failure remains a failure", async () => {
    const { client } = clientFor({}, ["/api/v1/projects"]);
    await expect(loadProjectOverview(client)).rejects.toThrow();
  });

  test("search and type filters combine and can be cleared", async () => {
    const { client } = clientFor();
    const rows = await loadProjectOverview(client);
    expect(
      filterProjects(rows, " 自由 ", "free").map((row) => row.project.id),
    ).toEqual(["free"]);
    expect(filterProjects(rows, "自由", "engineering")).toHaveLength(0);
    expect(filterProjects(rows, "XC7K", "engineering")).toHaveLength(1);
    expect(filterProjects(rows, "", "all")).toHaveLength(2);
  });
});

describe("create retries and authentication return paths", () => {
  test("an uncertain create retry freezes the ID, body, and idempotency key together", () => {
    let generated = 0;
    const build = () => ({ id: `project-${++generated}`, name: "Test" });
    const first = prepareWriteAttempt(null, "same form", build);
    const retry = prepareWriteAttempt(first, "same form", build);
    expect(retry).toBe(first);
    expect(generated).toBe(1);
    const edited = prepareWriteAttempt(first, "edited form", build);
    expect(edited.key).not.toBe(first.key);
    expect(edited.body.id).not.toBe(first.body.id);
  });

  test("authentication preserves a local approval or task deep link", () => {
    expect(loginDestination("/projects/p1?sub=review-1")).toBe(
      "/projects/p1?sub=review-1",
    );
    expect(loginDestination("/projects/p1?run=task-1")).toBe(
      "/projects/p1?run=task-1",
    );
    for (const path of [
      "//example.com",
      "https://example.com",
      "/login",
      "/projects\\evil",
      ["/projects"],
    ]) {
      expect(loginDestination(path)).toBe("/projects");
    }
  });

  test("query-only navigation keeps the same mounted workspace", () => {
    expect(viewKey({ path: "/projects/p1" })).toBe("/projects/p1");
    expect(viewKey({ path: "/projects/p2" })).not.toBe(
      viewKey({ path: "/projects/p1" }),
    );
  });
});
