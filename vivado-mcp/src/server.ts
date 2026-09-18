import { FastMCP } from "fastmcp";
import { makeAuthenticator, type VivadoMcpAuthSession } from "./auth.ts";
import type { VivadoMcpConfig } from "./config.ts";
import { VivadoTclRunner } from "./runner.ts";
import { registerTools } from "./tools.ts";

export const VIVADO_MCP_SERVER_NAME = "vivado-mcp";
export const VIVADO_MCP_SERVER_VERSION = "1.0.0";
export const VIVADO_MCP_ENDPOINT = "/mcp";

export interface VivadoMcpServerDeps { readonly runner?: VivadoTclRunner }

/** Assemble the FastMCP server. Pure construction — no listener side effects, so tests can start/stop freely. */
export function createServer(config: VivadoMcpConfig, deps: VivadoMcpServerDeps = {}): FastMCP<VivadoMcpAuthSession> {
  const runner = deps.runner ?? new VivadoTclRunner({
    workspaceRoot: config.workspaceRoot,
    binary: config.binary,
    maxConcurrency: config.maxConcurrency,
    scriptMaxBytes: config.scriptMaxBytes,
    outputMaxBytes: config.outputMaxBytes,
  });
  const server = new FastMCP<VivadoMcpAuthSession>({
    name: VIVADO_MCP_SERVER_NAME,
    version: VIVADO_MCP_SERVER_VERSION,
    // Throws VIVADO_MCP_UNAUTHORIZED on a bad/missing Bearer token; the HTTP
    // layer turns that into 401 before any MCP handling. stdio is never used.
    authenticate: makeAuthenticator(config.tokenSha256),
    health: { enabled: true, path: "/health", message: "ok" },
  });
  registerTools(server, runner);
  return server;
}
