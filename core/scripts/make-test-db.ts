#!/usr/bin/env bun
/**
 * Create (or recreate) a throwaway database and apply every migration in order.
 *
 * Why this exists: `tests/support/api-harness.ts` opens with
 * `TRUNCATE <every domain table> RESTART IDENTITY CASCADE`, so pointing
 * DATABASE_URL at the working `synthia` database while running the DB-backed
 * suites destroys the live project data. This gives those suites their own
 * database to wreck.
 *
 *   DATABASE_URL=postgres://... bun run core/scripts/make-test-db.ts [dbname]
 *
 * Prints the scratch DATABASE_URL on stdout (credentials included — it is the
 * same local credentials the caller already supplied).
 */
import { Client } from "pg";
import { migrate } from "../src/db/client.ts";

const source = process.env.DATABASE_URL;
if (!source) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const target = process.argv[2] ?? "synthia_test";
if (!/^[a-z][a-z0-9_]*$/.test(target)) {
  console.error(`refusing unsafe database name: ${target}`);
  process.exit(1);
}

const url = new URL(source);
const liveDb = url.pathname.replace(/^\//, "");
if (target === liveDb) {
  console.error(`refusing to drop the database DATABASE_URL points at (${liveDb})`);
  process.exit(1);
}

const admin = new Client({ connectionString: new URL("/postgres", url).toString() });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${target}"`);
await admin.query(`CREATE DATABASE "${target}"`);
await admin.end();

const targetUrl = new URL(`/${target}`, url).toString();

// Reuse the production runner rather than replaying the .sql files by hand: it
// creates `schema_migrations` first (every migration ends with an INSERT into
// it, so applying them without that table fails with 42P01) and strips the
// per-file BEGIN/COMMIT so the whole sequence lands in one transaction.
process.env.DATABASE_URL = targetUrl;
await migrate();

console.log(targetUrl);
