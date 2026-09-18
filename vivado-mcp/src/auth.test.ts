import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { extractBearerToken, makeAuthenticator, verifyToken } from "./auth.ts";

const TOKEN = "secret-token-0123456789abcdef";
const DIGEST = createHash("sha256").update(TOKEN, "utf8").digest();

function requestWithAuthorization(header?: string): IncomingMessage {
  return { headers: header === undefined ? {} : { authorization: header } } as unknown as IncomingMessage;
}

describe("extractBearerToken", () => {
  test("accepts exact Bearer scheme only", () => {
    expect(extractBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abcdef")).toBeNull();
    expect(extractBearerToken("bearer lowercase")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer  ")).toBeNull();
    expect(extractBearerToken(`Bearer ${TOKEN} extra`)).toBeNull();
  });
});

describe("verifyToken", () => {
  test("accepts only the exact token", () => {
    expect(verifyToken(TOKEN, DIGEST)).toBe(true);
    expect(verifyToken(`${TOKEN}x`, DIGEST)).toBe(false);
    expect(verifyToken(TOKEN.slice(0, -1), DIGEST)).toBe(false);
    expect(verifyToken("", DIGEST)).toBe(false);
    expect(verifyToken(null, DIGEST)).toBe(false);
  });
});

describe("makeAuthenticator", () => {
  const authenticate = makeAuthenticator(DIGEST);

  test("resolves the session for the exact token", async () => {
    await expect(authenticate(requestWithAuthorization(`Bearer ${TOKEN}`))).resolves.toEqual({ ok: true });
  });

  test("throws VIVADO_MCP_UNAUTHORIZED otherwise", async () => {
    await expect(authenticate(requestWithAuthorization(undefined))).rejects.toThrow("VIVADO_MCP_UNAUTHORIZED");
    await expect(authenticate(requestWithAuthorization("Bearer wrong-token"))).rejects.toThrow("VIVADO_MCP_UNAUTHORIZED");
  });
});
