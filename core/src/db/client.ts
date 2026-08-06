/**
 * Synthia Core — Database connection and migration runner
 *
 * Uses node:pg (works in Bun). Connection from DATABASE_URL env.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_PATH = join(__dirname, "migrations");

export function getClient(): InstanceType<typeof Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL not set. Expected: postgresql://user:pass@host:5432/synthia");
  }
  return new Client({ connectionString }) as InstanceType<typeof Client>;
}

export async function migrate(): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const migrations = readdirSync(MIGRATIONS_PATH).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const migration of migrations) {
      const check = await client.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [migration.replace(/\.sql$/, "")]);
      if (check.rows.length > 0) continue;
      const sql = readFileSync(join(MIGRATIONS_PATH, migration), "utf-8").replace(/^BEGIN;\s*/i, "").replace(/COMMIT;\s*$/i, "");
      await client.query(sql);
    }
    await client.query("COMMIT");
    console.log(`Migration complete: ${migrations.length} numbered migration(s) checked.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

// Entry point when run via `bun run src/db/migrate.ts`
if (import.meta.main) {
  migrate().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
