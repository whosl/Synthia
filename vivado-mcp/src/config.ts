import { createHash } from "node:crypto";

export interface VivadoMcpConfig {
  readonly host: string;
  readonly port: number;
  /** sha256 of VIVADO_MCP_TOKEN — the raw token never lives in config or logs. */
  readonly tokenSha256: Buffer;
  readonly workspaceRoot: string;
  readonly binary: string;
  readonly maxConcurrency: number;
  readonly scriptMaxBytes: number;
  readonly outputMaxBytes: number;
}

export const VIVADO_MCP_DEFAULT_PORT = 8450;
export const VIVADO_MCP_DEFAULT_HOST = "127.0.0.1";
export const VIVADO_MCP_DEFAULT_BINARY = "vivado";
export const VIVADO_MCP_DEFAULT_WORKSPACE_ROOT = "./vivado-mcp-workspaces";
export const VIVADO_MCP_DEFAULT_MAX_CONCURRENCY = 1;
export const VIVADO_MCP_DEFAULT_SCRIPT_MAX_BYTES = 1024 * 1024;
export const VIVADO_MCP_DEFAULT_OUTPUT_MAX_BYTES = 200 * 1024;
const TOKEN_MAX_BYTES = 4096;

export class VivadoMcpConfigError extends Error {
  constructor(readonly code: string) {
    super(`VIVADO_MCP_LAUNCH_FAILED:${code}`);
    this.name = "VivadoMcpConfigError";
  }
}

function fail(code: string): never { throw new VivadoMcpConfigError(code); }

function requiredToken(env: Record<string, string | undefined>): string {
  const raw = env.VIVADO_MCP_TOKEN;
  if (raw === undefined) fail("TOKEN_MISSING");
  if (raw === "") fail("TOKEN_EMPTY");
  if (Buffer.byteLength(raw, "utf8") > TOKEN_MAX_BYTES) fail("TOKEN_TOO_LONG");
  if (/[\0\r\n]/u.test(raw)) fail("TOKEN_INVALID");
  return raw;
}

function host(env: Record<string, string | undefined>): string {
  const raw = env.VIVADO_MCP_HOST ?? VIVADO_MCP_DEFAULT_HOST;
  // Hostnames, IPv4, and bracketed/bare IPv6 literals only — no spaces or URL syntax.
  if (!/^[A-Za-z0-9.:[\]-]{1,253}$/.test(raw)) fail("INVALID_HOST");
  return raw;
}

function port(env: Record<string, string | undefined>): number {
  const raw = env.VIVADO_MCP_PORT;
  if (raw === undefined || raw === "") return VIVADO_MCP_DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) fail("INVALID_PORT");
  const value = Number(raw);
  if (value < 1 || value > 65535) fail("INVALID_PORT");
  return value;
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,10}$/.test(raw)) fail(`INVALID_${name.replace(/^VIVADO_MCP_/, "").toLowerCase().toUpperCase()}`);
  const value = Number(raw);
  if (value < 1 || value > max) fail(`INVALID_${name.replace(/^VIVADO_MCP_/, "").toLowerCase().toUpperCase()}`);
  return value;
}

function nonEmpty(env: Record<string, string | undefined>, name: string, fallback: string, maxBytes: number): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (Buffer.byteLength(raw, "utf8") > maxBytes || /[\0\r\n]/u.test(raw)) fail(`INVALID_${name.replace(/^VIVADO_MCP_/, "").toLowerCase().toUpperCase()}`);
  return raw;
}

/** Parse and validate the vivado-mcp environment. Fails closed on any bad value. */
export function parseConfig(env: Record<string, string | undefined> = process.env): VivadoMcpConfig {
  const token = requiredToken(env);
  return {
    host: host(env),
    port: port(env),
    tokenSha256: createHash("sha256").update(token, "utf8").digest(),
    workspaceRoot: nonEmpty(env, "VIVADO_MCP_WORKSPACE_ROOT", VIVADO_MCP_DEFAULT_WORKSPACE_ROOT, 4096),
    binary: nonEmpty(env, "VIVADO_BINARY", VIVADO_MCP_DEFAULT_BINARY, 1024),
    maxConcurrency: positiveInt(env, "VIVADO_MCP_MAX_CONCURRENCY", VIVADO_MCP_DEFAULT_MAX_CONCURRENCY, 64),
    scriptMaxBytes: positiveInt(env, "VIVADO_MCP_SCRIPT_MAX_BYTES", VIVADO_MCP_DEFAULT_SCRIPT_MAX_BYTES, 64 * 1024 * 1024),
    outputMaxBytes: positiveInt(env, "VIVADO_MCP_OUTPUT_MAX_BYTES", VIVADO_MCP_DEFAULT_OUTPUT_MAX_BYTES, 64 * 1024 * 1024),
  };
}
