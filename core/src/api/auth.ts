/**
 * Synthia Core API — Bearer token authentication (IF-001 first slice, Q-011)
 *
 * Resolves the requester identity from the `Authorization: Bearer <token>`
 * header ONLY. The plaintext token is SHA-256 hashed and matched against
 * `auth_token.token_hash`; the plaintext is never stored or logged. Expired,
 * revoked, unknown and malformed tokens, plus non-active identities, all
 * surface as a single 401 so the API never leaks token lifecycle state.
 *
 * The resolved identity is the sole source of the requester's `actorType` and
 * `actorId` (= `user_account.uid`). Handlers MUST NOT accept actor identity
 * from a request body.
 */

import type { Pool } from "pg";
import { sha256Hex } from "../hashing.ts";
import { unauthorizedError } from "./errors.ts";

/** The two identity actor types that may hold a platform token. */
export type IdentityActorType = "human" | "service";

export interface AuthenticatedIdentity {
  /** human | service, resolved from user_account.actor_type via the token. */
  readonly actorType: IdentityActorType;
  /** Login identity = user_account.uid (LDAP uid). */
  readonly actorId: string;
  /** Internal stable id = user_account.id. */
  readonly userId: string;
  /** Permission scopes attached to the token. */
  readonly scopes: readonly string[];
}

interface TokenLookupRow {
  scope: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  user_id: string;
  uid: string;
  actor_type: string;
  status: string;
}

/**
 * Authenticate a request. Throws `unauthorizedError` (→ 401) for any token
 * failure. Returns the resolved identity on success.
 */
export async function authenticate(pool: Pool, authorization: string | null): Promise<AuthenticatedIdentity> {
  if (!authorization) throw unauthorizedError("missing bearer token");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw unauthorizedError("malformed authorization header");
  const token = match[1]!.trim();
  if (!token) throw unauthorizedError("malformed authorization header");

  // Hash the plaintext bearer token; only the hash is ever compared or stored.
  const tokenHash = sha256Hex(token);

  const { rows } = await pool.query<TokenLookupRow>(
    `SELECT t.scope, t.expires_at, t.revoked_at,
            u.id AS user_id, u.uid, u.actor_type, u.status
       FROM auth_token t
       JOIN user_account u ON u.id = t.user_id
      WHERE t.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );

  if (rows.length === 0) throw unauthorizedError("unknown token");
  const row = rows[0]!;

  if (row.revoked_at !== null) throw unauthorizedError("token revoked");
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) {
    throw unauthorizedError("token expired");
  }
  if (row.status !== "active") throw unauthorizedError("identity not active");

  // Only human / service identities are provisioned with tokens. Any other
  // actor_type reaching here is a data error — fail closed as unauthorized.
  if (row.actor_type !== "human" && row.actor_type !== "service") {
    throw unauthorizedError("identity actor type not permitted for API access");
  }

  return {
    actorType: row.actor_type as IdentityActorType,
    actorId: row.uid,
    userId: row.user_id,
    scopes: row.scope ?? [],
  };
}
