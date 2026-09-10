import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrate } from "../src/db/client.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FRESH_SCHEMA = readFileSync(
  new URL("../src/db/schema.sql", import.meta.url),
  "utf8",
);
const EVAL_TABLES = [
  "outbox_events",
  "evolution_eval_run",
  "evolution_eval_input",
  "evolution_eval_input_file",
  "evolution_eval_input_skill_file",
  "evolution_eval_job",
  "evolution_eval_workspace",
  "evolution_eval_workspace_revision",
  "evolution_eval_workspace_file",
  "evolution_eval_workspace_projection",
  "evolution_eval_dispatch",
  "evolution_eval_dispatch_tombstone",
  "evolution_eval_evidence_fact",
  "evolution_eval_evidence_entry",
  "evolution_eval_idempotency",
  "evolution_eval_audit_event",
  "evolution_eval_transition_fact",
  "evolution_eval_unknown_fact",
  "evolution_eval_operation_fact",
  "evolution_eval_reconcile_fact",
  "evolution_eval_dispatcher_lease",
  "evolution_eval_connector_observation",
  "evolution_eval_connector_ledger_epoch",
  "evolution_eval_temp_cleanup_owner",
  "evolution_eval_canary_binding",
] as const;

interface SchemaSnapshot {
  readonly columns: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly triggers: readonly Record<string, unknown>[];
  readonly functions: readonly Record<string, unknown>[];
  readonly runClass: readonly string[];
  readonly migrations: readonly string[];
}

function databaseUrl(name: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function snapshot(client: Client): Promise<SchemaSnapshot> {
  const columns = await client.query(
    `SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[])
      ORDER BY table_name,ordinal_position`,
    [EVAL_TABLES],
  );
  const constraints = await client.query(
    `SELECT c.relname AS table_name,con.conname,con.contype,
            pg_get_constraintdef(con.oid,true) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      ORDER BY c.relname,con.conname`,
    [EVAL_TABLES],
  );
  const indexes = await client.query(
    `SELECT tablename,indexname,replace(indexdef,'public.','') AS definition
       FROM pg_indexes
      WHERE schemaname='public' AND tablename=ANY($1::text[])
      ORDER BY tablename,indexname`,
    [EVAL_TABLES],
  );
  const triggers = await client.query(
    `SELECT c.relname AS table_name,t.tgname,
            replace(pg_get_triggerdef(t.oid,true),'public.','') AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
        AND (c.relname=ANY($1::text[]) OR (c.relname='tool_run' AND t.tgname LIKE 'evolution_eval_%'))
      ORDER BY c.relname,t.tgname`,
    [EVAL_TABLES],
  );
  const runClass = await client.query(
    `SELECT e.enumlabel
       FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
       JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' AND t.typname='run_class'
      ORDER BY e.enumsortorder`,
  );
  const functions = await client.query(
    `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
            regexp_replace(p.prosrc,'[[:space:]]','','g') AS normalized_body
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'synthia%eval%'
      ORDER BY p.proname,arguments`,
  );
  const migrations = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    functions: functions.rows,
    runClass: runClass.rows.map((row) => String(row.enumlabel)),
    migrations: migrations.rows.map((row) => String(row.version)),
  };
}

describe.skipIf(!DATABASE_URL)("evolution-eval PostgreSQL migration parity", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const migratedName = `synthia_m4d_migrated_${suffix}`;
  const freshName = `synthia_m4d_fresh_${suffix}`;
  const failureName = `synthia_m4d_failure_${suffix}`;
  let admin: Client;
  let migrated: Client;
  let fresh: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${migratedName}`);
    await admin.query(`CREATE DATABASE ${freshName}`);
    migrated = new Client({ connectionString: databaseUrl(migratedName) });
    fresh = new Client({ connectionString: databaseUrl(freshName) });
    await migrated.connect();
    await fresh.connect();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl(migratedName);
    try {
      await migrate();
      await migrate();
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await fresh.query(FRESH_SCHEMA);
  }, 120_000);

  afterAll(async () => {
    await migrated?.end();
    await fresh?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${migratedName} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${freshName} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  test("0019 and fresh schema converge structurally", async () => {
    const migratedSnapshot = await snapshot(migrated);
    const freshSnapshot = await snapshot(fresh);
    expect(migratedSnapshot).toEqual(freshSnapshot);
    expect(migratedSnapshot.runClass).toEqual([
      "exploratory",
      "gate_check",
      "formal",
      "evolution_eval",
    ]);
    expect(migratedSnapshot.migrations.at(-1)).toBe("0034_evolution_eval_canary_binding");
    expect(migratedSnapshot.triggers.some((row) => row.tgname === "evolution_eval_stable_state_guard"))
      .toBe(true);
  }, 30_000);

  test("PostgreSQL uses the frozen ASCII portable-path corpus", async () => {
    const result = await migrated.query(
      `SELECT value,synthia_is_evolution_eval_portable_path(value) AS accepted,
              translate(value,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') AS portable_key
         FROM unnest($1::text[]) value ORDER BY value COLLATE "C"`,
      [[
        "rtl/top.sv",
        "RTL/Top.SV",
        "rtl/console.v",
        "rtl/com10.sv",
        "rtl/中文.sv",
        "rtl/İ.sv",
        "rtl/😀.sv",
        "rtl/.hidden.sv",
        "CON.v",
        "rtl/PRN.sv",
        "rtl/AUX.xdc",
        "rtl/NUL.v",
        "rtl/COM1.v",
        "dir/LPT1.sv",
        "rtl/com9.test.sv",
        "rtl/lpt9.v",
        "rtl/foo./top.sv",
      ]],
    );
    const byValue = new Map(result.rows.map((row) => [String(row.value), row]));
    expect(byValue.get("rtl/top.sv")?.accepted).toBe(true);
    expect(byValue.get("RTL/Top.SV")?.portable_key).toBe("rtl/top.sv");
    expect(byValue.get("rtl/console.v")?.accepted).toBe(true);
    expect(byValue.get("rtl/com10.sv")?.accepted).toBe(true);
    for (const value of [
      "rtl/中文.sv",
      "rtl/İ.sv",
      "rtl/😀.sv",
      "rtl/.hidden.sv",
      "CON.v",
      "rtl/PRN.sv",
      "rtl/AUX.xdc",
      "rtl/NUL.v",
      "rtl/COM1.v",
      "dir/LPT1.sv",
      "rtl/com9.test.sv",
      "rtl/lpt9.v",
      "rtl/foo./top.sv",
    ]) {
      expect(byValue.get(value)?.accepted).toBe(false);
    }

    const extensions = await migrated.query(
      `SELECT 'rtl/top.sv' ~* $1 AS source_sv,
              'constraints/top.xdc' ~* $2 AS constraint_xdc,
              'rtl/top.tcl' ~* $1 AS source_tcl`,
      ["\\.(v|vh|sv|svh)$", "\\.xdc$"],
    );
    expect(extensions.rows[0]).toEqual({
      source_sv: true,
      constraint_xdc: true,
      source_tcl: false,
    });

    const eventPrefixes = await migrated.query(
      `SELECT 'evolution_eval.job_prepared' ~ $1 AS valid_event,
              'evolution_evalxjob_prepared' ~ $1 AS invalid_prefix`,
      ["^evolution_eval\\."],
    );
    expect(eventPrefixes.rows[0]).toEqual({
      valid_event: true,
      invalid_prefix: false,
    });
  });

  test("commits a legal prepare/revision/projection operation-fact fixture", async () => {
    await migrated.query("BEGIN");
    try {
      await migrated.query(
        `INSERT INTO user_account (id,uid,actor_type)
           VALUES ('op-identity','op-service','service');

         INSERT INTO project
           (id,name,scope,project_type,process_version_id,process_profile_id,
            process_profile_version,process_profile_name,status)
           VALUES ('op-project','Operation fact smoke','','free',NULL,NULL,NULL,NULL,'active');

         INSERT INTO agent_task
           (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,
            process_instance_id,runtime_agent_id,runtime_actor_id,objective,
            authorization_scope,status,input_hash,adoption_state,created_by_type,created_by)
           VALUES ('op-task','op-project','free','main','run',NULL,NULL,NULL,
                   'op-task','op-service','operation fact smoke','{}'::jsonb,
                   'running',repeat('0',64),'not_applicable','system','op-service');

         INSERT INTO task_conversation_event
           (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id)
           VALUES ('op-conversation','op-project','op-task',1,'tool_call',
                   '{"name":"learned_skill_apply","tool_call_id":"op-call"}'::jsonb,
                   repeat('9',64),'agent','op-task');

         INSERT INTO curator_run
           (id,mode,state,schedule_bucket,manual_key,eligible_at,reason,attempt,
            worker_id,lease_token,lease_expires_at,created_by_type,created_by)
           VALUES ('op-curator','run','running','op-bucket',NULL,now(),
                   'operation fact smoke',1,'op-worker','op-lease',
                   now()+interval '1 day','system','op-worker');

         INSERT INTO evolution_eval_run
           (curator_run_id,budget_started_at,deadline_at,created_at)
           VALUES ('op-curator',now(),now()+interval '2 hours',now());

         INSERT INTO learned_skill
           (id,slug,name,summary,applicability_summary,created_by_type,created_by)
           VALUES ('op-skill','op-skill','Operation fact','summary','FPGA synthesis',
                   'system','op-worker');

         INSERT INTO learned_skill_version
           (id,skill_id,version_no,parent_version_id,description,applicability,
            outcome_contract,content_manifest_hash,scanner_version,scan_decision,
            scan_findings,curator_run_id,created_by_type,created_by)
           VALUES ('op-version','op-skill',1,NULL,'operation fact version','{}'::jsonb,
                   '{}'::jsonb,repeat('5',64),'scanner-v1','pass','[]'::jsonb,
                   'op-curator','system','op-worker');

         INSERT INTO learned_skill_version_status (version_id,quality_state)
           VALUES ('op-version','active_unproven');

         INSERT INTO skill_application
           (id,project_id,task_id,observation_key,episode_id,local_goal,state,
            primary_tool_call_id,start_event_sequence,evidence_refs,tool_run_refs,
            created_by_type,created_by)
           VALUES ('op-application','op-project','op-task','op-observation',NULL,
                   'operation fact smoke','open','op-call',1,'[]'::jsonb,'[]'::jsonb,
                   'agent','op-task');

         INSERT INTO skill_application_skill
           (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
           VALUES ('op-application-skill','op-application','op-skill','op-version',
                   'primary','op-primary-call','[]'::jsonb);

         INSERT INTO curator_application_reservation (curator_run_id,application_id)
           VALUES ('op-curator','op-application');

         INSERT INTO evolution_eval_input
           (eval_input_ref,curator_run_id,application_id,project_id,version_id,
            evidence_snapshot_hash,input_manifest_hash,source_commit,
            source_manifest_hash,allowed_operations,trial_bitstream_allowed,part,
            toolchain_profile_hash,input_manifest)
           VALUES (
             'op-input','op-curator','op-application','op-project','op-version',
             repeat('1',64),repeat('2',64),repeat('a',40),repeat('3',64),
             ARRAY['synthesize'],false,'xc7a35tcpg236-1',repeat('4',64),
             jsonb_build_object(
               'schema','evolution-eval-input-manifest.v1',
               'eval_input_ref','op-input','curator_run_id','op-curator',
               'application_id','op-application','project_id','op-project',
               'version_id','op-version','evidence_snapshot_hash',repeat('1',64),
               'source_commit',repeat('a',40),'source_manifest_hash',repeat('3',64),
               'allowed_operations',to_jsonb(ARRAY['synthesize']::text[]),
               'trial_bitstream_allowed',false,'part','xc7a35tcpg236-1',
               'toolchain_profile_hash',repeat('4',64),
               'skill_files','[]'::jsonb,
               'files',jsonb_build_array(jsonb_build_object(
                 'path','rtl/top.sv',
                 'sha256',encode(digest(convert_to('module top; endmodule','UTF8'),'sha256'),'hex'),
                 'size_bytes',octet_length(convert_to('module top; endmodule','UTF8')),
                 'media_type','text/x-systemverilog'
               ))
             )
           );

         INSERT INTO evolution_eval_input_file
           (eval_input_ref,path,sha256,size_bytes,media_type,managed_content)
           VALUES (
             'op-input','rtl/top.sv',
             encode(digest(convert_to('module top; endmodule','UTF8'),'sha256'),'hex'),
             octet_length(convert_to('module top; endmodule','UTF8')),
             'text/x-systemverilog',convert_to('module top; endmodule','UTF8')
           );

         INSERT INTO tool_run
           (id,project_id,operation,run_class,state,authorization_context,
            input_manifest_hash,toolchain_profile_hash,parameters,correlation_id)
           VALUES ('op-tool-run','op-project','synthesize','evolution_eval','submitted',
                   '{}'::jsonb,repeat('2',64),repeat('4',64),
                   '{"operation":"synthesize","source_paths":["rtl/top.sv"],"top":"top","part":"xc7a35tcpg236-1"}'::jsonb,
                   'op-correlation');

         INSERT INTO evolution_eval_job
           (id,curator_run_id,application_id,project_id,version_id,eval_input_ref,
            input_manifest_hash,evidence_snapshot_hash,tool_run_id,workspace_id,
            connector_job_id,connector_idempotency_key,request_key,prepare_request_hash,
            ordinal,operation,parameters,requested_timeout_ms,effective_timeout_ms,deadline_at)
           VALUES ('op-job','op-curator','op-application','op-project','op-version','op-input',
                   repeat('2',64),repeat('1',64),'op-tool-run','op-workspace',
                   'op-connector-job',repeat('6',64),'op-request',repeat('7',64),1,
                   'synthesize',
                   '{"operation":"synthesize","source_paths":["rtl/top.sv"],"top":"top","part":"xc7a35tcpg236-1"}'::jsonb,
                   60000,60000,now()+interval '2 hours');

         INSERT INTO evolution_eval_workspace
           (id,eval_job_id,eval_input_ref,source_commit,input_manifest_hash,source_manifest_hash)
           VALUES ('op-workspace','op-job','op-input',repeat('a',40),repeat('2',64),repeat('3',64));

         INSERT INTO evolution_eval_workspace_revision
           (workspace_id,revision,manifest,manifest_hash,file_count,total_bytes,
            source_files,source_bytes,skill_files,skill_bytes,overlay_files,overlay_bytes)
           VALUES (
             'op-workspace',1,
             jsonb_build_object(
               'schema','evolution-eval-workspace-manifest.v1',
               'workspace_id','op-workspace','revision',1,
               'files',jsonb_build_array(jsonb_build_object(
                 'path','rtl/top.sv',
                 'sha256',encode(digest(convert_to('module top; endmodule','UTF8'),'sha256'),'hex'),
                 'size_bytes',octet_length(convert_to('module top; endmodule','UTF8')),
                 'media_type','text/x-systemverilog','layer','source','read_only',true
               ))
             ),
             repeat('8',64),1,octet_length(convert_to('module top; endmodule','UTF8')),
             1,octet_length(convert_to('module top; endmodule','UTF8')),0,0,0,0
           );

         INSERT INTO evolution_eval_workspace_file
           (workspace_id,revision,path,sha256,size_bytes,media_type,layer,read_only,managed_content)
           VALUES (
             'op-workspace',1,'rtl/top.sv',
             encode(digest(convert_to('module top; endmodule','UTF8'),'sha256'),'hex'),
             octet_length(convert_to('module top; endmodule','UTF8')),
             'text/x-systemverilog','source',true,convert_to('module top; endmodule','UTF8')
           );

         INSERT INTO evolution_eval_workspace_projection (workspace_id,current_revision)
           VALUES ('op-workspace',1);

         INSERT INTO evolution_eval_audit_event
           (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
            correlation_id,request_hash,operation,workspace_manifest_hash,file_count,byte_count)
           VALUES
             ('op-audit-prepare','op-curator','op-job','op-project','eval_job.prepared',
              'service','op-evaluator','op-correlation',repeat('7',64),'synthesize',repeat('8',64),
              1,octet_length(convert_to('module top; endmodule','UTF8'))),
             ('op-audit-revision','op-curator','op-job','op-project','workspace_revision',
              'service','op-evaluator','op-correlation',NULL,'synthesize',repeat('8',64),
              1,octet_length(convert_to('module top; endmodule','UTF8'))),
             ('op-audit-projection','op-curator','op-job','op-project','workspace_projection',
              'service','op-evaluator','op-correlation',NULL,'synthesize',repeat('8',64),
              1,octet_length(convert_to('module top; endmodule','UTF8')));

         INSERT INTO outbox_events
           (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
            headers,correlation_id,causation_id,classification)
           VALUES
             ('00000000-0000-4000-8000-000000000001','evolution_eval_job','op-job',1,
              'evolution_eval.job_prepared','op-project',jsonb_build_object(
                'fact_id','op-fact-prepare','prepare_request_hash',repeat('7',64),
                'input_manifest_hash',repeat('2',64),'workspace_manifest_hash',repeat('8',64)
              ),'{}'::jsonb,'op-correlation',NULL,'D1'),
             ('00000000-0000-4000-8000-000000000002','evolution_eval_job','op-job',2,
              'evolution_eval.workspace_revision','op-project',jsonb_build_object(
                'fact_id','op-fact-revision','workspace_id','op-workspace','revision',1,
                'workspace_manifest_hash',repeat('8',64),'file_count',1,
                'byte_count',octet_length(convert_to('module top; endmodule','UTF8'))
              ),'{}'::jsonb,'op-correlation',NULL,'D1'),
             ('00000000-0000-4000-8000-000000000003','evolution_eval_job','op-job',3,
              'evolution_eval.workspace_projection','op-project',jsonb_build_object(
                'fact_id','op-fact-projection','workspace_id','op-workspace','revision',1,
                'workspace_manifest_hash',repeat('8',64),'file_count',1,
                'byte_count',octet_length(convert_to('module top; endmodule','UTF8'))
              ),'{}'::jsonb,'op-correlation',NULL,'D1');

         INSERT INTO evolution_eval_operation_fact
           (id,eval_job_id,fact_type,workspace_id,workspace_revision,
            workspace_manifest_hash,audit_event_id,outbox_event_id)
           VALUES
             ('op-fact-prepare','op-job','prepare',NULL,NULL,NULL,
              'op-audit-prepare','00000000-0000-4000-8000-000000000001'),
             ('op-fact-revision','op-job','workspace_revision','op-workspace',1,repeat('8',64),
              'op-audit-revision','00000000-0000-4000-8000-000000000002'),
             ('op-fact-projection','op-job','workspace_projection','op-workspace',1,repeat('8',64),
              'op-audit-projection','00000000-0000-4000-8000-000000000003');`,
      );
      await migrated.query("COMMIT");
    } catch (error) {
      await migrated.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const result = await migrated.query(
      `SELECT synthia_assert_evolution_eval_operation_facts('op-job'),
              count(*)::integer AS operation_fact_count
         FROM evolution_eval_operation_fact
        WHERE eval_job_id='op-job'`,
    );
    expect(result.rows[0]?.operation_fact_count).toBe(3);
  }, 30_000);

  test("production runner preserves a migration failure, rolls back, and recovers", async () => {
    await admin.query(`CREATE DATABASE ${failureName}`);
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl(failureName);
    try {
      let captured: unknown;
      try {
        await migrate({
          transformMigration: (name, sql) => name === "0029_evolution_eval.sql"
            ? sql.replace(
              /COMMIT;\s*$/,
              "SELECT synthia_injected_migration_failure();\n\nCOMMIT;\n",
            )
            : sql,
        });
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toContain("synthia_injected_migration_failure");

      const probe = new Client({ connectionString: databaseUrl(failureName) });
      await probe.connect();
      const rolledBack = await probe.query(
        `SELECT to_regclass('public.evolution_eval_run') AS eval_table,
                EXISTS (SELECT 1 FROM schema_migrations
                         WHERE version='0029_evolution_eval') AS marker,
                EXISTS (
                  SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                   WHERE t.typname='run_class' AND e.enumlabel='evolution_eval'
                ) AS enum_value`,
      );
      expect(rolledBack.rows[0]).toEqual({
        eval_table: null,
        marker: false,
        enum_value: false,
      });
      await probe.end();

      await migrate();
      const recovered = new Client({ connectionString: databaseUrl(failureName) });
      await recovered.connect();
      const marker = await recovered.query(
        "SELECT version FROM schema_migrations WHERE version='0029_evolution_eval'",
      );
      expect(marker.rowCount).toBe(1);
      await recovered.end();
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await admin.query(`DROP DATABASE IF EXISTS ${failureName} WITH (FORCE)`);
    }
  }, 120_000);
});
