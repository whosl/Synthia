/**
 * Destructive P4 migration acceptance test.
 *
 * This suite rebuilds the public schema several times and therefore must only
 * run against a dedicated one-shot database. It proves that the checked-in
 * fresh-install snapshot and the production numbered migration runner converge
 * on the same P4 catalog, and that rerunning the migration runner does not
 * duplicate profile/backfill facts or drift the catalog.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrate } from "../src/db/client.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FRESH_SCHEMA = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

const P4_RELATIONS = [
  "baseline",
  "bitstream_result",
  "change_request",
  "configuration_snapshot",
  "delivery_release",
  "delivery_release_item",
  "formal_input_approval",
  "formal_input_content",
  "gate_check_evaluation",
  "gate_check_item",
  "gate_submission",
  "process_gate_definition",
  "project_readiness",
  "project_work_version",
  "tool_run",
  "tool_run_evidence_entry",
  "tool_run_evidence_manifest",
] as const;

const P4_ENUMS = [
  "actor_type",
  "baseline_kind",
  "baseline_state",
  "gate_id",
  "run_class",
  "tool_run_state",
] as const;

interface CatalogSnapshot {
  readonly relations: readonly Record<string, unknown>[];
  readonly columns: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly triggers: readonly Record<string, unknown>[];
  readonly triggerFunctions: readonly Record<string, unknown>[];
  readonly enums: readonly Record<string, unknown>[];
  readonly processProfile: readonly Record<string, unknown>[];
  readonly processVersion: readonly Record<string, unknown>[];
  readonly migrations: readonly Record<string, unknown>[];
}

async function resetPublicSchema(client: Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query("SET search_path TO public");
}

async function applyFreshSchema(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(FRESH_SCHEMA);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function catalogSnapshot(client: Client): Promise<CatalogSnapshot> {
  const relations = await client.query(
    `SELECT relation.relname AS relation,
            relation.relkind,
            relation.relpersistence
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname`,
    [P4_RELATIONS],
  );
  const columns = await client.query(
    `SELECT relation.relname AS relation,
            attribute.attname AS column_name,
            format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
            attribute.attnotnull AS not_null,
            attribute.attidentity AS identity_kind,
            attribute.attgenerated AS generated_kind,
            pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
       LEFT JOIN pg_attrdef default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attname`,
    [P4_RELATIONS],
  );
  const constraints = await client.query(
    `SELECT relation.relname AS relation,
            constraint_row.conname AS constraint_name,
            constraint_row.contype AS constraint_type,
            constraint_row.condeferrable AS deferrable,
            constraint_row.condeferred AS initially_deferred,
            constraint_row.convalidated AS validated,
            pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, constraint_row.conname`,
    [P4_RELATIONS],
  );
  const indexes = await client.query(
    `SELECT relation.relname AS relation,
            index_relation.relname AS index_name,
            index_row.indisprimary AS is_primary,
            index_row.indisunique AS is_unique,
            index_row.indisvalid AS is_valid,
            pg_get_indexdef(index_relation.oid) AS definition
       FROM pg_index index_row
       JOIN pg_class relation ON relation.oid = index_row.indrelid
       JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, index_relation.relname`,
    [P4_RELATIONS],
  );
  const triggers = await client.query(
    `SELECT relation.relname AS relation,
            trigger_row.tgname AS trigger_name,
            trigger_row.tgenabled AS enabled,
            function_row.proname AS function_name,
            pg_get_triggerdef(trigger_row.oid, true) AS definition
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND NOT trigger_row.tgisinternal
      ORDER BY relation.relname, trigger_row.tgname`,
    [P4_RELATIONS],
  );
  const triggerFunctions = await client.query(
    `SELECT DISTINCT function_row.proname AS function_name,
            pg_get_function_identity_arguments(function_row.oid) AS arguments,
            pg_get_function_result(function_row.oid) AS result,
            function_row.provolatile AS volatility,
            pg_get_functiondef(function_row.oid) AS definition
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND NOT trigger_row.tgisinternal
      ORDER BY function_row.proname,
               pg_get_function_identity_arguments(function_row.oid)`,
    [P4_RELATIONS],
  );
  const enums = await client.query(
    `SELECT type_row.typname AS enum_name,
            enum_row.enumsortorder::float8 AS sort_order,
            enum_row.enumlabel AS value
       FROM pg_type type_row
       JOIN pg_namespace namespace ON namespace.oid = type_row.typnamespace
       JOIN pg_enum enum_row ON enum_row.enumtypid = type_row.oid
      WHERE namespace.nspname = 'public'
        AND type_row.typname = ANY($1::text[])
      ORDER BY type_row.typname, enum_row.enumsortorder`,
    [P4_ENUMS],
  );
  const processProfile = await client.query(
    `SELECT process_version_id,
            gate::text,
            ordinal,
            name,
            goal,
            activities::text,
            required_checks::text,
            milestone_baseline::text,
            profile_hash
       FROM process_gate_definition
      WHERE process_version_id = 'GJB_REF_V1'
      ORDER BY ordinal`,
  );
  const processVersion = await client.query(
    `SELECT definition.id,
            definition.name,
            definition.description,
            version.profile_id,
            version.version,
            version.name AS version_name,
            version.status
       FROM process_definition definition
       JOIN process_version version ON version.profile_id = definition.id
      WHERE definition.id = 'GJB_REF_V1'
        AND version.id = 'GJB_REF_V1'`,
  );
  const migrations = await client.query(
    `SELECT version
       FROM schema_migrations
      WHERE version <= '0011_delivery_release'
      ORDER BY version`,
  );

  return {
    relations: relations.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    triggerFunctions: triggerFunctions.rows,
    enums: enums.rows,
    processProfile: processProfile.rows,
    processVersion: processVersion.rows,
    migrations: migrations.rows,
  };
}

function expectEquivalent(actual: CatalogSnapshot, expected: CatalogSnapshot): void {
  for (const key of Object.keys(expected) as Array<keyof CatalogSnapshot>) {
    expect(actual[key], `P4 catalog component differs: ${key}`).toEqual(expected[key]);
  }
}

async function seedUpgradeProject(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO project
       (id, name, scope, data_classification, standard_version, target_part,
        status, project_type, process_version_id, process_profile_id,
        process_profile_version, process_profile_name)
     VALUES
       ('p4-migration-reapply-project', 'P4 migration reapply', '', 'D1',
        'GB/T 33781-2017', 'xc7k70tfbv676-1', 'active', 'engineering',
        'GJB_REF_V1', 'GJB_REF_V1', 'GJB_REF_V1', 'GJB 参考流程 v1')`,
  );
  await client.query(
    `INSERT INTO process_instance (id, project_id, gate_profile_version, current_gate)
     VALUES ('p4-migration-reapply-process', 'p4-migration-reapply-project',
             'GJB_REF_V1', 'G7')`,
  );
}

async function reapplyFacts(client: Client): Promise<Record<string, unknown>> {
  const profile = await client.query(
    `SELECT count(*)::int AS count,
            count(DISTINCT gate)::int AS distinct_gates,
            count(DISTINCT ordinal)::int AS distinct_ordinals,
            count(DISTINCT profile_hash)::int AS distinct_hashes
       FROM process_gate_definition
      WHERE process_version_id = 'GJB_REF_V1'`,
  );
  const workVersions = await client.query(
    `SELECT id,
            project_id,
            process_instance_id,
            version,
            origin,
            start_gate::text,
            current_gate::text,
            state,
            created_by_type::text,
            created_by
       FROM project_work_version
      WHERE project_id = 'p4-migration-reapply-project'
      ORDER BY version, id`,
  );
  const process = await client.query(
    `SELECT id, current_gate::text
       FROM process_instance
      WHERE project_id = 'p4-migration-reapply-project'
      ORDER BY id`,
  );
  const governanceCounts = await client.query(
    `SELECT
       (SELECT count(*)::int FROM project_readiness
         WHERE project_id = 'p4-migration-reapply-project') AS readiness,
       (SELECT count(*)::int FROM approved_gate_result
         WHERE project_id = 'p4-migration-reapply-project') AS approved_results,
       (SELECT count(*)::int FROM baseline
         WHERE project_id = 'p4-migration-reapply-project') AS baselines,
       (SELECT count(*)::int FROM delivery_release
         WHERE project_id = 'p4-migration-reapply-project') AS releases`,
  );
  const migrationRows = await client.query(
    `SELECT version, count(*)::int AS count
       FROM schema_migrations
      WHERE version IN ('0010_process_gate_checks', '0011_delivery_release')
      GROUP BY version
      ORDER BY version`,
  );
  return {
    profile: profile.rows,
    workVersions: workVersions.rows,
    process: process.rows,
    governanceCounts: governanceCounts.rows,
    migrationRows: migrationRows.rows,
  };
}

describe.skipIf(!DATABASE_URL)("P4 — fresh schema and numbered migration equivalence", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  test("schema.sql, 0000→0011, and repeated runner application converge without seed drift", async () => {
    await resetPublicSchema(client);
    await applyFreshSchema(client);
    const fresh = await catalogSnapshot(client);
    expect(fresh.processProfile).toHaveLength(5);
    expect(fresh.migrations).toHaveLength(12);

    await resetPublicSchema(client);
    await migrate();
    const numbered = await catalogSnapshot(client);
    expectEquivalent(numbered, fresh);

    // A normal production re-run sees every schema_migrations row and must be
    // a pure no-op, including profile seed cardinality and trigger definitions.
    await migrate();
    expectEquivalent(await catalogSnapshot(client), numbered);

    // Force the runner to execute 0010/0011 again. The first forced pass also
    // exercises 0011's deterministic legacy-project work-version backfill.
    // A second forced pass must neither duplicate that fact nor create any
    // readiness/approval/baseline/release success fact.
    await seedUpgradeProject(client);
    await client.query(
      `DELETE FROM schema_migrations
        WHERE version IN ('0010_process_gate_checks', '0011_delivery_release')`,
    );
    await migrate();
    const firstReapplyCatalog = await catalogSnapshot(client);
    const firstReapplyFacts = await reapplyFacts(client);
    expectEquivalent(firstReapplyCatalog, numbered);
    expect(firstReapplyFacts).toMatchObject({
      profile: [{ count: 5, distinct_gates: 5, distinct_ordinals: 5, distinct_hashes: 1 }],
      governanceCounts: [{ readiness: 0, approved_results: 0, baselines: 0, releases: 0 }],
      migrationRows: [
        { version: "0010_process_gate_checks", count: 1 },
        { version: "0011_delivery_release", count: 1 },
      ],
    });
    expect((firstReapplyFacts.workVersions as unknown[])).toHaveLength(1);

    await client.query(
      `DELETE FROM schema_migrations
        WHERE version IN ('0010_process_gate_checks', '0011_delivery_release')`,
    );
    await migrate();
    expectEquivalent(await catalogSnapshot(client), firstReapplyCatalog);
    expect(await reapplyFacts(client)).toEqual(firstReapplyFacts);
  }, 120_000);
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; destructive P4 migration equivalence was not executed", () => {});
}
