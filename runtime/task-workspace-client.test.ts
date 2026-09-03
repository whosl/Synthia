import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../core/src/hashing.ts";
import {
  CoreTaskClientBase,
  CoreTaskWorkspaceClient,
  TaskWorkspaceClientError,
  type TaskAuthorizationScope,
} from "./task-workspace-client.ts";

const AUTHORIZATION: TaskAuthorizationScope = {
  schema: "task-scope.v1",
  workspace: "isolated",
  read_paths: ["rtl/**", "tb/**"],
  write_paths: ["rtl/counter.v"],
  run_classes: ["exploratory"],
  can_submit_gates: false,
  can_create_milestones: false,
  can_start_formal_runs: false,
};

describe("CoreTaskWorkspaceClient", () => {
  test("main-task event client sends no isolated-workspace header", async () => {
    const client = new CoreTaskClientBase({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId: "project-1",
      taskId: "main-1",
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(
          "http://core.local/api/v1/projects/project-1/tasks/main-1/events",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("x-synthia-task-id")).toBe("main-1");
        expect(headers.get("x-synthia-workspace-id")).toBeNull();
        return new Response(JSON.stringify({
          data: { task_id: "main-1", event_id: "te-main-1", sequence: 2, replayed: false },
        }), { status: 201 });
      }) as typeof fetch,
    });

    await expect(client.appendEvent({
      eventId: "te-main-1",
      type: "status",
      payload: { status: "running" },
    })).resolves.toMatchObject({ taskId: "main-1", sequence: 2 });
  });

  test("writes through the task-scoped route with ownership headers and stable idempotency", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const content = "module counter; endmodule\n";
    const contentHash = sha256Hex(content);
    const client = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId: "project-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      authorization: AUTHORIZATION,
      retryDelayMs: 0,
      sleep: async () => {},
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({
          data: {
            commit: "a".repeat(40),
            committed: ["rtl/counter.v"],
            registered: [{ path: "rtl/counter.v", content_hash: contentHash }],
            unchanged: [],
            isolated: true,
          },
        }), { status: 200 });
      }) as typeof fetch,
    });

    const first = await client.writeFiles({
      files: [{ path: "rtl/counter.v", content }],
      changeReason: "side output",
      artifactType: "RTL_SOURCE_SET",
    });
    const second = await client.writeFiles({
      files: [{ path: "rtl/counter.v", content }],
      changeReason: "side output",
      artifactType: "RTL_SOURCE_SET",
    });

    expect(first).toEqual(second);
    expect(first.registered[0]).toEqual({ path: "rtl/counter.v", contentHash });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(
        "http://core.local/api/v1/projects/project-1/tasks/task-1/workspace/files",
      );
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe("Bearer svc-token");
      expect(headers.get("x-synthia-task-id")).toBe("task-1");
      expect(headers.get("x-synthia-workspace-id")).toBe("ws-task-1");
      expect(headers.get("idempotency-key")).toMatch(/^task-ws-task-1-[0-9a-f]{32}$/);
    }
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe(
      new Headers(calls[1]!.init.headers).get("idempotency-key"),
    );
  });

  test("workspace-write idempotency covers reason, artifact type, and normalized request order", async () => {
    const calls: RequestInit[] = [];
    const client = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId: "project-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      authorization: AUTHORIZATION,
      fetchImpl: (async (_input, init) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({
          data: {
            commit: "a".repeat(40),
            committed: [],
            registered: [],
            unchanged: [],
            isolated: true,
          },
        }), { status: 200 });
      }) as typeof fetch,
    });
    const files = [{ path: "./rtl/counter.v", content: "module counter; endmodule\n" }];

    await client.writeFiles({ files, changeReason: "reason-a", artifactType: "RTL_SOURCE_SET" });
    await client.writeFiles({ files, changeReason: "reason-a", artifactType: "RTL_SOURCE_SET" });
    await client.writeFiles({ files, changeReason: "reason-b", artifactType: "RTL_SOURCE_SET" });
    await client.writeFiles({ files, changeReason: "reason-a", artifactType: "TB_SOURCE_SET" });

    const keys = calls.map((call) => new Headers(call.headers).get("idempotency-key"));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      files: [{ path: "rtl/counter.v", content: "module counter; endmodule\n" }],
      change_reason: "reason-a",
      artifact_type: "RTL_SOURCE_SET",
    });
  });

  test("rejects an out-of-scope write before contacting Core", async () => {
    let fetchCount = 0;
    const client = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId: "project-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      authorization: AUTHORIZATION,
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response();
      }) as typeof fetch,
    });

    await expect(client.writeFiles({
      files: [{ path: "doc/not-authorized.md", content: "x" }],
    })).rejects.toMatchObject({
      name: "TaskWorkspaceClientError",
      code: "SIDE_TASK_PATH_NOT_AUTHORIZED",
    } satisfies Partial<TaskWorkspaceClientError>);
    expect(fetchCount).toBe(0);
  });

  test("reads named bytes only from the same task-scoped route", async () => {
    const content = "module counter; endmodule\n";
    const client = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local/",
      token: "svc-token",
      projectId: "project-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      authorization: AUTHORIZATION,
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(
          "http://core.local/api/v1/projects/project-1/tasks/task-1/workspace/file?path=rtl%2Fcounter.v",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("x-synthia-task-id")).toBe("task-1");
        expect(headers.get("x-synthia-workspace-id")).toBe("ws-task-1");
        return new Response(JSON.stringify({
          data: {
            path: "rtl/counter.v",
            content,
            content_hash: sha256Hex(content),
            commit: "b".repeat(40),
          },
        }), { status: 200 });
      }) as typeof fetch,
    });

    expect(await client.readFile("rtl/counter.v")).toEqual({
      path: "rtl/counter.v",
      encoding: "utf8",
      content,
      contentBase64: null,
      bytes: Buffer.byteLength(content, "utf8"),
      contentHash: sha256Hex(content),
      commit: "b".repeat(40),
    });
  });

  test("round-trips binary workspace files through Base64 with raw-byte hash", async () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const contentBase64 = Buffer.from(bytes).toString("base64");
    const calls: RequestInit[] = [];
    const client = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId: "project-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      authorization: {
        ...AUTHORIZATION,
        read_paths: ["doc/**"],
        write_paths: ["doc/**"],
      },
      fetchImpl: (async (input, init) => {
        calls.push(init ?? {});
        if (String(input).includes("workspace/file?")) {
          return new Response(JSON.stringify({ data: {
            path: "doc/spec.docx",
            encoding: "base64",
            content: null,
            content_base64: contentBase64,
            content_hash: sha256Hex(bytes),
            commit: "c".repeat(40),
          } }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: {
          commit: "c".repeat(40),
          committed: ["doc/spec.docx"],
          registered: [{ path: "doc/spec.docx", content_hash: sha256Hex(bytes) }],
          unchanged: [],
          isolated: true,
        } }), { status: 200 });
      }) as typeof fetch,
    });

    await client.writeFiles({ files: [{ path: "doc/spec.docx", contentBase64 }] });
    expect(JSON.parse(String(calls[0]!.body)).files).toEqual([
      { path: "doc/spec.docx", content_base64: contentBase64 },
    ]);
    expect(await client.readFile("doc/spec.docx")).toMatchObject({
      encoding: "base64",
      content: null,
      contentBase64,
      contentHash: sha256Hex(bytes),
    });
  });

  test("persists complete events and finalizes a sealed result through task routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new CoreTaskWorkspaceClient({
      baseUrl: "http://core.local",
      token: "svc-token",
      projectId: "project-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      authorization: AUTHORIZATION,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url.endsWith("/events")) {
          return new Response(JSON.stringify({
            data: { task_id: "task-1", event_id: "te-event-1", sequence: 2, replayed: false },
          }), { status: 201 });
        }
        return new Response(JSON.stringify({
          data: {
            result_id: "result-1",
            task_id: "task-1",
            workspace_id: "ws-task-1",
            summary: "done",
            output_hash: "f".repeat(64),
          },
        }), { status: 201 });
      }) as typeof fetch,
    });

    expect(await client.appendEvent({
      eventId: "te-event-1",
      type: "assistant_message",
      payload: { text: "done" },
    })).toEqual({ taskId: "task-1", eventId: "te-event-1", sequence: 2, replayed: false });
    expect(await client.finalizeResult({ summary: "done", tests: [] })).toEqual({
      resultId: "result-1",
      taskId: "task-1",
      workspaceId: "ws-task-1",
      summary: "done",
      outputHash: "f".repeat(64),
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://core.local/api/v1/projects/project-1/tasks/task-1/events",
      "http://core.local/api/v1/projects/project-1/tasks/task-1/result",
    ]);
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toMatch(/^task-event-task-1-/);
    expect(new Headers(calls[1]!.init.headers).get("idempotency-key")).toMatch(/^task-result-task-1-/);
  });
});
