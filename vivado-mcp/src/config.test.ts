import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseConfig, VivadoMcpConfigError } from "./config.ts";

const BASE_ENV = { VIVADO_MCP_TOKEN: "unit-test-token" };

describe("parseConfig", () => {
  test("applies defaults", () => {
    const config = parseConfig({ ...BASE_ENV });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8450);
    expect(config.binary).toBe("vivado");
    expect(config.workspaceRoot).toBe("./vivado-mcp-workspaces");
    expect(config.maxConcurrency).toBe(1);
    expect(config.scriptMaxBytes).toBe(1024 * 1024);
    expect(config.outputMaxBytes).toBe(200 * 1024);
  });

  test("stores only the token digest", () => {
    const config = parseConfig({ ...BASE_ENV });
    expect(Buffer.isBuffer(config.tokenSha256)).toBe(true);
    expect(config.tokenSha256.equals(createHash("sha256").update("unit-test-token").digest())).toBe(true);
    expect(JSON.stringify(config)).not.toContain("unit-test-token");
  });

  test("accepts overrides", () => {
    const config = parseConfig({
      ...BASE_ENV,
      VIVADO_MCP_HOST: "0.0.0.0",
      VIVADO_MCP_PORT: "9000",
      VIVADO_BINARY: "C:/Xilinx/Vivado/2021.1/bin/vivado.bat",
      VIVADO_MCP_WORKSPACE_ROOT: "D:/synthia-mcp/ws",
      VIVADO_MCP_MAX_CONCURRENCY: "2",
      VIVADO_MCP_SCRIPT_MAX_BYTES: "2048",
      VIVADO_MCP_OUTPUT_MAX_BYTES: "4096",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.binary).toBe("C:/Xilinx/Vivado/2021.1/bin/vivado.bat");
    expect(config.workspaceRoot).toBe("D:/synthia-mcp/ws");
    expect(config.maxConcurrency).toBe(2);
    expect(config.scriptMaxBytes).toBe(2048);
    expect(config.outputMaxBytes).toBe(4096);
  });

  test("fails closed on a missing or empty token", () => {
    expect(() => parseConfig({})).toThrow(VivadoMcpConfigError);
    expect(() => parseConfig({})).toThrow("VIVADO_MCP_LAUNCH_FAILED:TOKEN_MISSING");
    expect(() => parseConfig({ VIVADO_MCP_TOKEN: "" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:TOKEN_EMPTY");
  });

  test("fails closed on malformed values", () => {
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_PORT: "nope" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_PORT");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_PORT: "0" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_PORT");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_PORT: "65536" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_PORT");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_HOST: "bad host" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_HOST");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_MAX_CONCURRENCY: "0" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_MAX_CONCURRENCY");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_SCRIPT_MAX_BYTES: "0" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_SCRIPT_MAX_BYTES");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_OUTPUT_MAX_BYTES: "x" })).toThrow("VIVADO_MCP_LAUNCH_FAILED:INVALID_OUTPUT_MAX_BYTES");
    expect(() => parseConfig({ ...BASE_ENV, VIVADO_MCP_TOKEN: "t".repeat(4097) })).toThrow("VIVADO_MCP_LAUNCH_FAILED:TOKEN_TOO_LONG");
  });
});
