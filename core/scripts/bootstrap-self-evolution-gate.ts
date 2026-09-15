#!/usr/bin/env bun
/**
 * Provision the six identities used by the bounded M4-F Self-Evolution gate.
 *
 * This entry point is deliberately restricted to disposable databases whose
 * name starts with `synthia-selfevo-gate-`. It never stores plaintext tokens;
 * the values are emitted once, after the transaction commits successfully.
 * Re-running the command rotates the five credentials by revoking the earlier
 * active tokens owned by the same gate identities.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sha256Hex } from "../src/hashing.ts";

export const SELF_EVOLUTION_GATE_DATABASE_PREFIX = "synthia-selfevo-gate-";

export interface GateIdentitySpec {
  readonly uid: string;
  readonly cn: string;
  readonly displayName: string;
  readonly mail: string;
  readonly actorType: "human" | "service";
  readonly scopes: readonly string[];
  readonly envVar: string;
}

export const SELF_EVOLUTION_GATE_IDENTITIES: readonly GateIdentitySpec[] = [
  {
    uid: "m4f-gate-admin",
    cn: "M4-F Gate Administrator",
    displayName: "M4-F Gate Administrator",
    mail: "m4f-gate-admin@synthia.local",
    actorType: "human",
    scopes: ["core:admin", "core:write", "core:read", "core:approve"],
    envVar: "SYNTHIA_M4F_E2E_HUMAN_TOKEN",
  },
  {
    uid: "synthia-service",
    cn: "Synthia Core Service",
    displayName: "Synthia Core Service",
    mail: "service@synthia.local",
    actorType: "service",
    scopes: ["core:write", "core:read"],
    envVar: "SYNTHIA_CORE_TOKEN",
  },
  {
    uid: "synthia-runtime",
    cn: "Synthia Task Runtime",
    displayName: "Synthia Task Runtime Service",
    mail: "runtime@synthia.local",
    actorType: "service",
    scopes: ["core:task-runtime"],
    envVar: "SYNTHIA_TASK_RUNTIME_TOKEN",
  },
  {
    uid: "synthia-evolution-distiller",
    cn: "Synthia Evolution Distiller",
    displayName: "Synthia Evolution Distiller Service",
    mail: "evolution-distiller@synthia.local",
    actorType: "service",
    scopes: ["core:evolution-distiller"],
    envVar: "SYNTHIA_EVOLUTION_DISTILLER_TOKEN",
  },
  {
    uid: "synthia-evolution-curator",
    cn: "Synthia Evolution Curator",
    displayName: "Synthia Evolution Curator Service",
    mail: "evolution-curator@synthia.local",
    actorType: "service",
    scopes: ["core:evolution-curator"],
    envVar: "SYNTHIA_EVOLUTION_CURATOR_TOKEN",
  },
  {
    uid: "synthia-evolution-evaluator",
    cn: "Synthia Evolution Evaluator",
    displayName: "Synthia Evolution Evaluator Service",
    mail: "evolution-evaluator@synthia.local",
    actorType: "service",
    scopes: ["core:evolution-eval"],
    envVar: "SYNTHIA_EVOLUTION_EVALUATOR_TOKEN",
  },
] as const;

export interface ProvisionedGateToken {
  readonly envVar: string;
  readonly plaintext: string;
}

interface IdentityRow {
  readonly id: string;
  readonly actor_type: string;
}

interface GateSqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export function gateDatabaseName(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TypeError("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new TypeError("DATABASE_URL must use postgres or postgresql");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (
    !databaseName.startsWith(SELF_EVOLUTION_GATE_DATABASE_PREFIX)
    || databaseName.length === SELF_EVOLUTION_GATE_DATABASE_PREFIX.length
  ) {
    throw new TypeError(
      `DATABASE_URL must name a dedicated ${SELF_EVOLUTION_GATE_DATABASE_PREFIX}* database`,
    );
  }
  return databaseName;
}

export function generateGateToken(): string {
  return `syn_${randomBytes(32).toString("hex")}`;
}

export async function provisionSelfEvolutionGateIdentities(
  client: GateSqlClient,
  generateToken: () => string = generateGateToken,
): Promise<readonly ProvisionedGateToken[]> {
  const provisioned: ProvisionedGateToken[] = [];
  for (const spec of SELF_EVOLUTION_GATE_IDENTITIES) {
    const { rows } = await client.query<IdentityRow>(
      `INSERT INTO user_account
         (id,uid,cn,display_name,member_of,mail,actor_type,status)
       VALUES ($1,$2,$3,$4,'{}',$5,$6,'active')
       ON CONFLICT (uid) DO UPDATE SET
         cn=EXCLUDED.cn,
         display_name=EXCLUDED.display_name,
         mail=EXCLUDED.mail,
         status='active',
         updated_at=now()
       RETURNING id,actor_type`,
      [
        `usr_${randomUUID()}`,
        spec.uid,
        spec.cn,
        spec.displayName,
        spec.mail,
        spec.actorType,
      ],
    );
    const identity = rows[0];
    if (!identity || identity.actor_type !== spec.actorType) {
      throw new Error(`gate identity ${spec.uid} has an incompatible actor type`);
    }

    // A gate rerun is credential rotation, not accumulation. Revoke every old
    // token for the dedicated identity before inserting the replacement.
    await client.query(
      "UPDATE auth_token SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [identity.id],
    );
    const plaintext = generateToken();
    await client.query(
      "INSERT INTO auth_token (token_hash,user_id,scope) VALUES ($1,$2,$3)",
      [sha256Hex(plaintext), identity.id, spec.scopes],
    );
    provisioned.push({ envVar: spec.envVar, plaintext });
  }
  return provisioned;
}

export async function runSelfEvolutionGateBootstrap(
  databaseUrl: string,
): Promise<readonly ProvisionedGateToken[]> {
  gateDatabaseName(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tokens = await provisionSelfEvolutionGateIdentities(client);
    await client.query("COMMIT");
    return tokens;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  runSelfEvolutionGateBootstrap(databaseUrl).then((tokens) => {
    for (const token of tokens) console.log(`${token.envVar}=${token.plaintext}`);
    console.error(
      "Gate bootstrap complete. Store these values now; each plaintext token is shown once.",
    );
  }).catch((error) => {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "BOOTSTRAP_FAILED";
    console.error(`Self-Evolution gate bootstrap failed (${code}).`);
    process.exit(1);
  });
}
