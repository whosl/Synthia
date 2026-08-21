import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendOutboxEvent, withTransaction, type TransactionClient } from "../src/db/repository.ts";

const migration = readFileSync(new URL("../src/db/migrations/0001_d1_hardening.sql", import.meta.url), "utf8");
const initialMigration = readFileSync(new URL("../src/db/migrations/0000_initial_schema.sql", import.meta.url), "utf8");
const projectHardeningMigration = readFileSync(new URL("../src/db/migrations/0007_project_profile_constraints.sql", import.meta.url), "utf8");
const freshSchema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
describe("PostgreSQL D1 contracts", () => {
  test("initial numbered migration creates fresh core schema", () => {
    expect(initialMigration).toContain("CREATE TABLE IF NOT EXISTS project");
    expect(initialMigration).toContain("CREATE TABLE IF NOT EXISTS approval_record");
    expect(initialMigration).toContain("CREATE TABLE IF NOT EXISTS baseline");
    expect(initialMigration).toContain("INSERT INTO schema_migrations(version) VALUES ('0000_initial_schema')");
  });
  test("numbered migration is repeatable and transactional", () => {
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain("IF NOT EXISTS");
    expect(migration).toContain("ON CONFLICT (version) DO NOTHING");
  });
  test("fresh schema records every migration represented by the snapshot", () => {
    for (const version of [
      "0000_initial_schema",
      "0001_d1_hardening",
      "0002_approval_slice_hardening",
      "0003_identity_and_api",
      "0004_tool_run_evidence",
      "0005_revision_content",
      "0006_project_type_process_version",
      "0007_project_profile_constraints",
      "0008_import_snapshots",
    ]) {
      expect(freshSchema).toContain(`('${version}')`);
    }
  });
  test("numbered migrations preserve fresh-schema ownership constraints and lookup indexes", () => {
    for (const foreignKey of [
      "tool_run_project_id_fkey",
      "evidence_project_id_fkey",
      "trace_relation_project_id_fkey",
    ]) {
      expect(projectHardeningMigration).toContain(foreignKey);
    }
    for (const index of [
      "idx_revision_artifact",
      "idx_revision_project_state",
      "idx_submission_project_gate",
      "idx_approval_submission",
      "idx_baseline_project_kind",
      "idx_toolrun_project",
      "idx_evidence_run",
      "idx_trace_source",
      "idx_trace_target",
      "idx_trace_search",
    ]) {
      expect(projectHardeningMigration).toContain(index);
      expect(freshSchema).toContain(index);
    }
  });
  test("migration append-only table names are guarded", () => {
    expect(migration).toContain("to_regclass('public.baseline')");
    expect(migration).toContain("DROP TRIGGER IF EXISTS baseline_append_only ON baseline");
    expect(migration).toContain("schema_migrations");
  });
  test("outbox enforces per-aggregate monotonic uniqueness", () => {
    expect(migration).toMatch(/UNIQUE\s*\(aggregate_type, aggregate_id, sequence\)/);
    expect(migration).toContain("outbox_events_unpublished_idx");
    expect(appendOutboxEvent.toString()).toContain("pg_advisory_xact_lock");
  });

  test("idempotency binds actor project operation key and request hash", () => {
    expect(migration).toMatch(/PRIMARY KEY\s*\(actor_type, actor_id, project_id, operation, idempotency_key\)/);
    expect(migration).toContain("request_hash text NOT NULL");
  });

  test("approval and baseline are protected from update and delete", () => {
    expect(migration).toContain("approval_records_append_only");
    expect(migration).toContain("baselines_append_only");
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("transaction helper commits or rolls back using one client", async () => {
    const statements: string[] = [];
    const client: TransactionClient = { query: async (text) => { statements.push(text); return { rows: [] }; } };
    await expect(withTransaction(client, async transaction => { expect(transaction).toBe(client); await transaction.query("MUTATE"); return 3; })).resolves.toBe(3);
    expect(statements).toEqual(["BEGIN", "MUTATE", "COMMIT"]);
    statements.length = 0;
    await expect(withTransaction(client, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
