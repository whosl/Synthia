import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrate } from "../src/db/client.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const MIGRATION = readFileSync(
  new URL("../src/db/migrations/0026_evidence_authority_classification.sql", import.meta.url),
  "utf8",
);
const FRESH_SCHEMA = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
const P4_HANDLERS = readFileSync(new URL("../src/api/p4-handlers.ts", import.meta.url), "utf8");

function databaseUrl(name: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function capturePgFailure(action: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await action();
  } catch (error) {
    return {
      code: typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  throw new Error("expected PostgreSQL operation to fail");
}

describe("evidence authority classification contracts", () => {
  test("fresh and migrated schemas install the same independent authority guards", () => {
    for (const sql of [MIGRATION, FRESH_SCHEMA]) {
      expect(sql).toContain("artifact_classification text NOT NULL");
      expect(sql).toContain("usage_classification text NOT NULL");
      expect(sql).toContain("tool_run_evidence_classification_guard");
      expect(sql).toContain("bitstream_result_classification_guard");
      expect(sql).toContain("delivery_release_item_classification_guard");
      expect(sql).toContain("delivery_release_classification_guard");
      expect(sql).toContain("0026_evidence_authority_classification");
    }
  });

  test("G4, release, delivery, and content selectors require both authority dimensions", () => {
    const formalRunPredicates = P4_HANDLERS.match(/run\.run_class = 'formal'/g) ?? [];
    const artifactPredicates = P4_HANDLERS.match(/artifact_classification = 'tool_run_evidence'/g) ?? [];
    const usagePredicates = P4_HANDLERS.match(/usage_classification = 'run_class_governed'/g) ?? [];
    expect(formalRunPredicates.length).toBeGreaterThanOrEqual(4);
    expect(artifactPredicates.length).toBeGreaterThanOrEqual(4);
    expect(usagePredicates.length).toBeGreaterThanOrEqual(4);
    expect(P4_HANDLERS).toContain("artifactClassification: bitstream.artifact_classification");
    expect(P4_HANDLERS).toContain("usageClassification: bitstream.usage_classification");
    expect(P4_HANDLERS).toContain("artifactClassification: entry.artifact_classification");
    expect(P4_HANDLERS).toContain("usageClassification: entry.usage_classification");
  });
});

describe.skipIf(!DATABASE_URL)("evidence authority classification — real PostgreSQL", () => {
  const databaseName = `synthia_evidence_authority_${randomUUID().replaceAll("-", "")}`;
  let admin: Client;
  let client: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl(databaseName);
    try {
      await migrate();
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    client = new Client({ connectionString: databaseUrl(databaseName) });
    await client.connect();
    await client.query(
      `INSERT INTO project
         (id,name,scope,project_type,process_version_id,process_profile_id,
          process_profile_version,process_profile_name,status)
       VALUES ('classification-project','classification test','','free',NULL,NULL,NULL,NULL,'active')`,
    );
    await client.query(
      `INSERT INTO tool_run
         (id,project_id,operation,run_class,state,authorization_context,correlation_id)
       VALUES ('classification-formal-run','classification-project','implement','formal',
               'succeeded','{}'::jsonb,'classification-formal')`,
    );

    // This malformed source fact exists only to prove that the second
    // classification dimension rejects spoofed formal authority.  The normal
    // deferred eval binding triggers are disabled solely for this fixture.
    await client.query("ALTER TABLE tool_run DISABLE TRIGGER evolution_eval_tool_run_guard");
    await client.query("ALTER TABLE tool_run DISABLE TRIGGER evolution_eval_tool_run_commit_guard");
    await client.query(
      `INSERT INTO tool_run
         (id,project_id,operation,run_class,state,authorization_context,correlation_id)
       VALUES ('classification-eval-run','classification-project','implement','evolution_eval',
               'submitted','{}'::jsonb,'classification-eval')`,
    );
    await client.query("ALTER TABLE tool_run ENABLE TRIGGER evolution_eval_tool_run_guard");
    await client.query("ALTER TABLE tool_run ENABLE TRIGGER evolution_eval_tool_run_commit_guard");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  test("formal run plus eval classifications is rejected", async () => {
    const failure = await capturePgFailure(() => client.query(
      `INSERT INTO tool_run_evidence_entry
         (id,project_id,manifest_id,tool_run_id,name,role,evidence_kind,uri,
          sha256,size_bytes,media_type,artifact_classification,usage_classification,
          managed_content)
       VALUES ('classification-formal-eval-entry','classification-project','missing-manifest',
               'classification-formal-run','formal-eval.bit','bitstream','bitstream',
               'content://formal-eval',repeat('0',64),0,'application/octet-stream',
               'experimental/evolution_eval','evolution_eval_only',''::bytea)`,
    ));
    expect(failure.code).toBe("23514");
    expect(failure.message).toContain("generic evidence requires a non-evolution classification");
  });

  test("evolution-eval run plus spoofed formal classifications is rejected", async () => {
    const failure = await capturePgFailure(() => client.query(
      `INSERT INTO tool_run_evidence_entry
         (id,project_id,manifest_id,tool_run_id,name,role,evidence_kind,uri,
          sha256,size_bytes,media_type,artifact_classification,usage_classification,
          managed_content)
       VALUES ('classification-eval-formal-entry','classification-project','missing-manifest',
               'classification-eval-run','eval-formal.bit','bitstream','bitstream',
               'content://eval-formal',repeat('0',64),0,'application/octet-stream',
               'tool_run_evidence','run_class_governed',''::bytea)`,
    ));
    expect(failure.code).toBe("23514");
    expect(failure.message).toMatch(/evolution eval|non-evolution classification/);
  });

  test("delivery run-result authority rejects an evolution-eval ToolRun", async () => {
    const failure = await capturePgFailure(() => client.query(
      `INSERT INTO delivery_release_item
         (id,project_id,release_id,category,path,source_type,source_id,sha256,
          size_bytes,media_type,storage_uri,provenance)
       VALUES ('classification-eval-delivery-item','classification-project','missing-release',
               'run_result','results/eval.json','tool_run','classification-eval-run',
               repeat('0',64),0,'application/json','content://eval-run','{}'::jsonb)`,
    ));
    expect(failure.code).toBe("23514");
    expect(failure.message).toContain("delivery run result requires a formal ToolRun");
  });

  test("formal selectors independently exclude a malformed eval-classified row", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "ALTER TABLE tool_run_evidence_entry DISABLE TRIGGER tool_run_evidence_classification_guard",
      );
      await client.query(
        `INSERT INTO tool_run_evidence_entry
           (id,project_id,manifest_id,tool_run_id,name,role,evidence_kind,uri,
            sha256,size_bytes,media_type,artifact_classification,usage_classification,
            managed_content)
         VALUES ('classification-injected-entry','classification-project','injected-manifest',
                 'classification-formal-run','injected.bit','bitstream','bitstream',
                 'content://injected','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                 0,'application/octet-stream',
                 'experimental/evolution_eval','evolution_eval_only',''::bytea)`,
      );
      const selected = await client.query(
        `SELECT evidence.id
           FROM tool_run_evidence_entry evidence
           JOIN tool_run run
             ON run.id=evidence.tool_run_id AND run.project_id=evidence.project_id
          WHERE evidence.id='classification-injected-entry'
            AND run.run_class='formal'
            AND evidence.artifact_classification='tool_run_evidence'
            AND evidence.usage_classification='run_class_governed'`,
      );
      expect(selected.rowCount).toBe(0);
      const deliveryFailure = await capturePgFailure(() => client.query(
        `INSERT INTO delivery_release_item
           (id,project_id,release_id,category,path,source_type,source_id,sha256,
            size_bytes,media_type,storage_uri,provenance)
         VALUES ('classification-injected-delivery-item','classification-project','missing-release',
                 'raw_evidence','evidence/injected.bit','tool_run_evidence_entry',
                 'classification-injected-entry',repeat('0',64),0,
                 'application/octet-stream','content://injected','{}'::jsonb)`,
      ));
      expect(deliveryFailure.code).toBe("23514");
      expect(deliveryFailure.message).toContain(
        "delivery evidence requires formal non-evolution classification",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

if (!DATABASE_URL) {
  test.skip("SKIPPED: DATABASE_URL is not set; evidence authority PostgreSQL tests were not executed", () => {});
}
