#!/usr/bin/env bun
/**
 * Synthia Core — bootstrap initial platform identities (IF-001 first slice)
 *
 * Creates the first human admin and a platform service account, each with one
 * random bearer token. The token PLAINTEXT is printed exactly once to stdout;
 * only its SHA-256 hash is persisted in `auth_token`. Re-runnable: existing
 * users are upserted; each run mints a fresh token (revoke old tokens manually
 * via SQL when rotating).
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run core/scripts/bootstrap-admin.ts
 *
 * Output: two lines like
 *   ADMIN_TOKEN=syn_<64 hex>
 *   SERVICE_TOKEN=syn_<64 hex>
 */

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sha256Hex } from "../src/hashing.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Expected: postgres://user:pass@host:5432/synthia");
  process.exit(1);
}

function generateToken(): string {
  // 32 random bytes (256 bits) hex-encoded, prefixed for readability. The auth
  // layer hashes the entire string; the prefix is cosmetic.
  return `syn_${randomBytes(32).toString("hex")}`;
}

interface IdentitySpec {
  uid: string;
  cn: string;
  displayName: string;
  mail: string;
  actorType: "human" | "service";
  scopes: readonly string[];
  envVar: string;
}

const IDENTITIES: readonly IdentitySpec[] = [
  {
    uid: "admin",
    cn: "Administrator",
    displayName: "Platform Administrator",
    mail: "admin@synthia.local",
    actorType: "human",
    scopes: ["core:admin", "core:write", "core:read", "core:approve"],
    envVar: "ADMIN_TOKEN",
  },
  {
    uid: "synthia-service",
    cn: "Synthia Service",
    displayName: "Platform Service Account",
    mail: "service@synthia.local",
    actorType: "service",
    scopes: ["core:write", "core:read"],
    envVar: "SERVICE_TOKEN",
  },
];

async function provisionIdentity(client: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }, spec: IdentitySpec): Promise<string> {
  // Upsert the user; RETURNING yields the stable id whether inserted or updated.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO user_account (id, uid, cn, display_name, member_of, mail, actor_type, status)
     VALUES ($1,$2,$3,$4,'{}',$5,$6,'active')
     ON CONFLICT (uid) DO UPDATE SET cn = EXCLUDED.cn, display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id`,
    [`usr_${randomUUID()}`, spec.uid, spec.cn, spec.displayName, spec.mail, spec.actorType],
  );
  const userId = rows[0]!.id;

  const plaintext = generateToken();
  const tokenHash = sha256Hex(plaintext);
  await client.query(
    `INSERT INTO auth_token (token_hash, user_id, scope)
     VALUES ($1,$2,$3)`,
    [tokenHash, userId, spec.scopes],
  );
  return plaintext;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    for (const spec of IDENTITIES) {
      const plaintext = await provisionIdentity(client, spec);
      // Plaintext printed exactly once; nothing persistent stores or logs it.
      console.log(`${spec.envVar}=${plaintext}`);
      console.error(`  provisioned ${spec.actorType} identity uid='${spec.uid}' scopes=[${spec.scopes.join(", ")}]`);
    }
    console.error("Bootstrap complete. Store the tokens now — they will not be shown again.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
