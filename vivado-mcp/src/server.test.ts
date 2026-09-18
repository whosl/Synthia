import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CommandRunner } from "../../connector/vivado.ts";
import type { FastMCP } from "fastmcp";
import { VIVADO_MCP_DONE_SENTINEL, VivadoTclRunner } from "./runner.ts";
import { getFreePort } from "./files.ts";
import type { VivadoMcpAuthSession } from "./auth.ts";
import { VIVADO_MCP_ENDPOINT, createServer } from "./server.ts";

const TOKEN = "integration-token-abcdef0123456789";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN, "utf8").digest();
const workspaceRoot = mkdtempSync(join(tmpdir(), "vivado-mcp-http-"));
const fakeRunner: CommandRunner = async () => ({ exitCode: 0, stdout: `Y.2021.1\n${VIVADO_MCP_DONE_SENTINEL}\n`, stderr: "" });
const runner = new VivadoTclRunner({ workspaceRoot, commandRunner: fakeRunner });
let server: FastMCP<VivadoMcpAuthSession>;
let baseUrl = "";

interface JsonRpcResponse { jsonrpc?: string; id?: number; result?: unknown; error?: { code?: number; message?: string } }

/** POST one JSON-RPC message; parses both plain-JSON and SSE-framed responses. */
async function rpc(method: string, params?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: JsonRpcResponse | JsonRpcResponse[] | null }> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${VIVADO_MCP_ENDPOINT}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await response.text();
  let body: JsonRpcResponse | JsonRpcResponse[] | null = null;
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    body = JSON.parse(text);
  } else {
    const frames = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean);
    if (frames.length === 1) body = JSON.parse(frames[0]!);
    else if (frames.length > 1) body = frames.map(frame => JSON.parse(frame));
  }
  return { status: response.status, body };
}

beforeAll(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = createServer(
    { host: "127.0.0.1", port, tokenSha256: TOKEN_SHA256, workspaceRoot, binary: "vivado", maxConcurrency: 1, scriptMaxBytes: 1024 * 1024, outputMaxBytes: 200 * 1024 },
    { runner },
  );
  await server.start({ transportType: "httpStream", httpStream: { host: "127.0.0.1", port, endpoint: VIVADO_MCP_ENDPOINT, stateless: true } });
});

afterAll(async () => {
  await server.stop();
});

describe("vivado-mcp HTTP server", () => {
  test("health endpoint answers without auth", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  test("rejects MCP requests without a token", async () => {
    const missing = await rpc("tools/list", undefined, null);
    expect(missing.status).toBe(401);
  });

  test("rejects MCP requests with a wrong token", async () => {
    const wrong = await rpc("tools/list", undefined, "definitely-not-the-token");
    expect(wrong.status).toBe(401);
  });

  test("lists all five tools with the right token", async () => {
    const response = await rpc("tools/list");
    expect(response.status).toBe(200);
    const body = response.body as JsonRpcResponse;
    const tools = (body.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    expect(tools.map(tool => tool.name).sort()).toEqual(["list_parts", "list_workspace_files", "read_workspace_file", "run_tcl", "vivado_version"]);
  });

  test("answers initialize with server metadata", async () => {
    const response = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(response.status).toBe(200);
    const info = (response.body as JsonRpcResponse).result as { serverInfo?: { name?: string } } | undefined;
    expect(info?.serverInfo?.name).toBe("vivado-mcp");
  });

  test("executes tools/call run_tcl through the injected runner", async () => {
    const response = await rpc("tools/call", { name: "run_tcl", arguments: { script: "puts [version -short]" } });
    expect(response.status).toBe(200);
    const result = (response.body as JsonRpcResponse).result as { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
    expect(result?.isError).toBeFalsy();
    const text = result?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { status: string; stdout: string; workspace: string };
    expect(parsed.status).toBe("succeeded");
    expect(parsed.stdout).toContain("Y.2021.1");
    expect(parsed.workspace).toMatch(/^ws-[0-9a-f]{16}$/);
  });

  test("surfaces bad tool calls without crashing the server", async () => {
    const badPattern = await rpc("tools/call", { name: "list_parts", arguments: { pattern: "bad pattern!" } });
    expect([200, 400]).toContain(badPattern.status);
    const unknownTool = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
    expect(unknownTool.status).toBe(200);
    const stillAlive = await rpc("tools/list");
    expect(stillAlive.status).toBe(200);
  });
});
