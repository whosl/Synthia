import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendOutboxEvent, withTransaction, type TransactionClient } from "../src/db/repository.ts";

const migration = readFileSync(new URL("../src/db/migrations/0001_d1_hardening.sql", import.meta.url), "utf8");
const initialMigration = readFileSync(new URL("../src/db/migrations/0000_initial_schema.sql", import.meta.url), "utf8");
const projectHardeningMigration = readFileSync(new URL("../src/db/migrations/0007_project_profile_constraints.sql", import.meta.url), "utf8");
const taskWorkspacesMigration = readFileSync(new URL("../src/db/migrations/0009_task_workspaces.sql", import.meta.url), "utf8");
const processGateChecksMigration = readFileSync(new URL("../src/db/migrations/0010_process_gate_checks.sql", import.meta.url), "utf8");
const deliveryReleaseMigration = readFileSync(new URL("../src/db/migrations/0011_delivery_release.sql", import.meta.url), "utf8");
const projectAgentsMigration = readFileSync(new URL("../src/db/migrations/0012_project_agents.sql", import.meta.url), "utf8");
const binaryWorkspaceMigration = readFileSync(new URL("../src/db/migrations/0013_binary_workspace_documents.sql", import.meta.url), "utf8");
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
      "0009_task_workspaces",
      "0010_process_gate_checks",
      "0011_delivery_release",
      "0012_project_agents",
      "0013_binary_workspace_documents",
    ]) {
      expect(freshSchema).toContain(`('${version}')`);
    }
  });
  test("binary workspace documents preserve raw-byte identity in migration and fresh schema", () => {
    for (const sql of [binaryWorkspaceMigration, freshSchema]) {
      expect(sql).toContain("content_encoding");
      expect(sql).toContain("content_base64");
      expect(sql).toContain("task_workspace_file_content_digest");
      expect(sql).toContain("decode(content_base64");
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
  test("P3 task workspace tables are present in migration and fresh schema", () => {
    for (const table of [
      "task_workspace",
      "agent_task",
      "task_conversation_event",
      "task_workspace_file",
      "task_result",
      "task_adoption",
      "task_adoption_file",
    ]) {
      const ddl = `CREATE TABLE IF NOT EXISTS ${table}`;
      expect(taskWorkspacesMigration).toContain(ddl);
      expect(freshSchema).toContain(ddl);
    }
  });
  test("P3 task ownership and lifecycle constraints match the fresh schema", () => {
    expect(taskWorkspacesMigration).toContain("agent_task_one_active_engineering_main_idx");
    for (const sql of [taskWorkspacesMigration, freshSchema]) {
      expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBeGreaterThanOrEqual(2);
      expect(sql).toMatch(/UNIQUE\s*\(task_id, output_hash\)/);
      expect(sql).toContain("FOREIGN KEY (project_id, project_type)");
      expect(sql).toContain("FOREIGN KEY (parent_task_id, project_id)");
      expect(sql).toContain("FOREIGN KEY (workspace_id, id, project_id)");
      expect(sql).toContain("FOREIGN KEY (task_id, id, project_id)");
      expect(sql).toContain("FOREIGN KEY (workspace_file_id, task_id, project_id, path, source_content_hash)");
      expect(sql).toContain("FOREIGN KEY (target_revision_id, target_artifact_id, project_id)");
      expect(sql).toContain("agent_task_parent_guard");
      expect(sql).toContain("task_workspace_state_guard");
      expect(sql).toContain("agent_task_state_guard");
      expect(sql).toContain("task_adoption_state_guard");
      expect(sql).toContain("runtime_actor_id");
      expect(sql).toMatch(/OLD\.runtime_actor_id IS DISTINCT FROM NEW\.runtime_actor_id/);
    }
    for (const sql of [projectAgentsMigration, freshSchema]) {
      expect(sql).toContain("agent_task_one_project_agent_idx");
      expect(sql).toContain("agent_task_one_active_engineering_run_idx");
      expect(sql).toContain("agent_role");
    }
    expect(taskWorkspacesMigration).toContain("CONSTRAINT agent_task_runtime_actor_fk REFERENCES user_account(uid)");
    expect(freshSchema).toContain("agent_task_runtime_actor_fk");
  });
  test("P3 immutable facts have append-only guards in migration and fresh schema", () => {
    for (const sql of [taskWorkspacesMigration, freshSchema]) {
      for (const trigger of [
        "task_conversation_event_append_only",
        "task_workspace_file_append_only",
        "task_result_append_only",
        "task_adoption_file_append_only",
      ]) {
        expect(sql).toContain(trigger);
      }
    }
  });
  test("P4 numbered migrations and fresh schema preserve the same sealed-release boundary", () => {
    for (const sql of [processGateChecksMigration, freshSchema]) {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS formal_input_content");
      expect(sql).toContain("formal_input_content_append_only");
      expect(sql).toContain("managed formal input bytes do not match sha256");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS formal_input_approval");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS tool_run_evidence_manifest");
      expect(sql).toContain("tool_run_evidence_manifest_append_only");
    }
    for (const sql of [deliveryReleaseMigration, freshSchema]) {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS delivery_release");
      expect(sql).toMatch(/state\s+text NOT NULL DEFAULT 'sealed'[\s\S]*CHECK \(state = 'sealed'\)/);
      expect(sql).toContain("delivery_release_append_only");
      expect(sql).toContain("delivery_release_item_append_only");
      expect(sql).toContain("delivery_release_complete_guard");
      expect(sql).toContain("newer.version > r.version");
      expect(sql).toContain("change request must bind the latest sealed delivery");
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
