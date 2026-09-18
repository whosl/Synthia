import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** fastmcp session-auth payload; FastMCPSessionAuth requires an index signature. */
export interface VivadoMcpAuthSession { readonly ok: true; [key: string]: unknown }

/** Extract the token from an `Authorization: Bearer <token>` header, strictly. */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? match[1]! : null;
}

/**
 * Constant-time token check. Both sides are hashed to fixed 32-byte digests so
 * timingSafeEqual length requirements hold and no length information leaks; a
 * missing token is compared against the empty-string digest so the compare
 * always runs.
 */
export function verifyToken(present: string | null, expectedSha256: Buffer): boolean {
  const digest = createHash("sha256").update(present ?? "", "utf8").digest();
  return timingSafeEqual(digest, expectedSha256);
}

/**
 * fastmcp `authenticate` callback for the HTTP Stream transport. Throws
 * VIVADO_MCP_UNAUTHORIZED on any missing/mismatched token — mcp-proxy converts
 * the throw into a 401 before any MCP handling. Only HTTP requests can carry
 * the header; there is no stdio code path in this server.
 */
export function makeAuthenticator(expectedSha256: Buffer): (request: IncomingMessage) => Promise<VivadoMcpAuthSession> {
  return async (request: IncomingMessage): Promise<VivadoMcpAuthSession> => {
    const token = extractBearerToken(request.headers.authorization);
    if (!verifyToken(token, expectedSha256)) throw new Error("VIVADO_MCP_UNAUTHORIZED");
    return { ok: true };
  };
}
