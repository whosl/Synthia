import { expect, test } from "bun:test";
import { HttpRuntimeClient } from "../src/api/task-proxy.ts";

test("HttpRuntimeClient forwards Core input_hash unchanged", async () => {
  const inputHash = "a".repeat(64);
  let received: Record<string, unknown> | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received = await request.json() as Record<string, unknown>;
      return Response.json({ agent_id: "task-contract" });
    },
  });

  try {
    const runtime = new HttpRuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await runtime.createTask({
      project_id: "project-contract",
      task: "verify task input identity",
      task_id: "task-contract",
      task_kind: "main",
      input_hash: inputHash,
    });

    expect(received?.input_hash).toBe(inputHash);
  } finally {
    server.stop(true);
  }
});

test("HttpRuntimeClient starts the encoded Core task id", async () => {
  let receivedPath = "";
  let receivedMethod = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      receivedPath = url.pathname;
      receivedMethod = request.method;
      return Response.json({ started: true, status: "running" });
    },
  });

  try {
    const runtime = new HttpRuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const response = await runtime.startTask("task/with space");

    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/tasks/task%2Fwith%20space/start");
    expect(response).toEqual({ started: true, status: "running" });
  } finally {
    server.stop(true);
  }
});

test("HttpRuntimeClient forwards the Core message idempotency key", async () => {
  let receivedPath = "";
  let receivedKey: string | null = null;
  let receivedBody: unknown = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      receivedPath = new URL(request.url).pathname;
      receivedKey = request.headers.get("idempotency-key");
      receivedBody = await request.json();
      return Response.json({ accepted: true, status: "running" });
    },
  });

  try {
    const runtime = new HttpRuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const response = await runtime.sendMessage(
      "side/with space",
      "continue the exploration",
      "message-idem-1",
    );

    expect(receivedPath).toBe("/tasks/side%2Fwith%20space/message");
    expect(receivedKey).toBe("message-idem-1");
    expect(receivedBody).toEqual({ text: "continue the exploration" });
    expect(response).toEqual({ accepted: true, status: "running" });
  } finally {
    server.stop(true);
  }
});

test("HttpRuntimeClient forwards the Core abort idempotency key without a body", async () => {
  let receivedPath = "";
  let receivedKey: string | null = null;
  let receivedBody = "unexpected";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      receivedPath = new URL(request.url).pathname;
      receivedKey = request.headers.get("idempotency-key");
      receivedBody = await request.text();
      return Response.json({ aborted: true, status: "running" });
    },
  });

  try {
    const runtime = new HttpRuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const response = await runtime.abortTask("side/with space", "abort-idem-1");

    expect(receivedPath).toBe("/tasks/side%2Fwith%20space/abort");
    expect(receivedKey).toBe("abort-idem-1");
    expect(receivedBody).toBe("");
    expect(response).toEqual({ aborted: true, status: "running" });
  } finally {
    server.stop(true);
  }
});
