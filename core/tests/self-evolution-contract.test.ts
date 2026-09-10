import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { authenticate } from "../src/api/auth.ts";
import { ApiError } from "../src/api/errors.ts";
import { errorEnvelope } from "../src/api/envelope.ts";
import { rolloutOffSettingsTransitionAllowed } from "../src/api/self-evolution-handlers.ts";

const migration = readFileSync(
  new URL("../src/db/migrations/0013_self_evolution.sql", import.meta.url),
  "utf8",
);
const evalMigration = readFileSync(
  new URL("../src/db/migrations/0014_evolution_eval.sql", import.meta.url),
  "utf8",
);
const evalHardeningMigration = readFileSync(
  new URL("../src/db/migrations/0015_evolution_eval_r1_hardening.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
const router = readFileSync(new URL("../src/api/router.ts", import.meta.url), "utf8");
const handlers = readFileSync(new URL("../src/api/self-evolution-handlers.ts", import.meta.url), "utf8");

describe("self-evolution v1 static contracts", () => {
  test("0013 and the fresh schema expose the same fact tables", () => {
    for (const table of [
      "evolution_settings",
      "learning_episode",
      "distillation_run",
      "learned_skill",
      "learned_skill_version",
      "learned_skill_version_status",
      "learned_skill_file",
      "learned_skill_lifecycle_event",
      "skill_application",
      "skill_application_skill",
      "curator_run",
      "curator_evaluation",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain("VALUES ('0013_self_evolution')");
    expect(schema).toContain("('0013_self_evolution')");
  });

  test("0014 and fresh schema preserve dedicated evolution-eval facts", () => {
    for (const table of [
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
    ]) {
      expect(evalMigration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const guard of [
      "evolution_eval_run_binding_guard",
      "evolution_eval_workspace_projection_guard",
      "evolution_eval_tool_run_guard",
      "evolution_eval_job_binding_guard",
      "evolution_eval_stable_state_guard",
      "evolution_eval_dispatch_insert_fence_guard",
      "evolution_eval_transition_fence_guard",
      "evolution_eval_outbox_mutation_guard",
      "evolution_eval_operation_commit_guard",
      "evolution_eval_dispatch_tombstone_append_only",
      "evolution_eval_learned_skill_file_commit_guard",
      "evolution_eval_input_version_lock_guard",
      "evolution_eval_learned_skill_file_version_lock_guard",
    ]) {
      expect(evalMigration).toContain(guard);
      expect(schema).toContain(guard);
    }
    expect(evalMigration).toContain("ALTER TYPE run_class ADD VALUE IF NOT EXISTS 'evolution_eval'");
    expect(evalMigration).toContain("deadline_at = budget_started_at + interval '2 hours'");
    expect(evalMigration).toContain("max_jobs = 3");
    expect(evalMigration).toContain("COALESCE(eval_job_id,'')");
    expect(evalMigration).not.toContain("dispatch.created_at>tombstone.created_at");
    expect(schema).not.toContain("dispatch.created_at>tombstone.created_at");
    expect(evalMigration).toContain("OLD.published_at IS NULL AND NEW.published_at IS NOT NULL");
    expect(evalMigration).toContain("previously committed freeze intent");
    expect(evalMigration).toContain("previously committed frozen evidence");
    expect(evalMigration).toContain("run_end_time+interval '7 days'");
    expect(evalMigration).toContain("initial evolution eval projection must be unsealed revision 1");
    for (const sql of [evalMigration, schema]) {
      expect(sql).toContain(
        "translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE \"C\"",
      );
      expect(sql).not.toMatch(/lower\s*\([^)]*path[^)]*\)/i);
      expect(sql).toContain(
        "evolution eval skill input must exactly bind the fixed SkillVersion files",
      );
      expect(sql).toContain(
        "binding.input_manifest->'skill_files' IS DISTINCT FROM actual_skill_files",
      );
      expect(sql).toContain(
        "evolution eval workspace skill layer must exactly match immutable skill input",
      );
      expect(sql).toContain(
        "CREATE CONSTRAINT TRIGGER evolution_eval_learned_skill_file_commit_guard",
      );
      expect(sql).toContain("AFTER INSERT ON learned_skill_file");
      expect(sql).toContain(
        "synthia_validate_evolution_eval_learned_skill_file_commit()",
      );
      expect(sql).toContain(
        "CREATE OR REPLACE FUNCTION synthia_lock_evolution_eval_skill_version()",
      );
      expect(sql).toContain("WHERE skill_version.id=NEW.version_id\n   FOR UPDATE;");
      expect(sql).toContain("BEFORE INSERT ON evolution_eval_input");
      expect(sql).toContain("BEFORE INSERT ON learned_skill_file");
      expect(
        sql.match(/EXECUTE FUNCTION synthia_lock_evolution_eval_skill_version\(\)/g),
      ).toHaveLength(2);
    }
    for (const sql of [evalMigration, schema]) {
      expect(sql).toContain("evolution_eval_evidence_frozen_manifest_idx");
      expect(sql).toContain("ON evolution_eval_evidence_fact(eval_job_id,manifest_hash)");
      expect(sql).toContain("WHERE fact_type='frozen'");
      expect(sql).not.toContain("UNIQUE (eval_job_id,manifest_hash)");
    }
    expect(evalMigration).toContain("VALUES ('0014_evolution_eval')");
  });

  test("0015 and fresh schema preserve typed reconcile intent ownership", () => {
    for (const sql of [evalHardeningMigration, schema]) {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS evolution_eval_reconcile_fact");
      expect(sql).toContain("evolution_eval_reconcile_insert_guard");
      expect(sql).toContain("evolution_eval_job_mutation_guard");
      expect(sql).toContain("evolution_eval_reconcile_commit_guard");
      expect(sql).toContain("evolution_eval_reconcile_append_only");
      expect(sql).toContain("evolution_eval.reconcile_requested");
      expect(sql).toContain("reconcile_required");
      expect(sql).toContain("evolution eval audit must have exactly one typed reverse owner");
      expect(sql).toContain("evolution eval outbox must have exact aggregate/type and one reverse owner");
    }
    expect(evalHardeningMigration).toContain("VALUES ('0015_evolution_eval_r1_hardening')");
    expect(schema).toContain("VALUES ('0015_evolution_eval_r1_hardening')");
  });

  test("immutable facts, one primary, CAS and evidence identity are database-enforced", () => {
    for (const trigger of [
      "learning_episode_append_only",
      "learned_skill_version_append_only",
      "learned_skill_file_append_only",
      "learned_skill_lifecycle_event_append_only",
      "skill_application_skill_append_only",
      "curator_evaluation_append_only",
    ]) {
      expect(migration).toContain(trigger);
      expect(schema).toContain(trigger);
    }
    expect(migration).toContain("UNIQUE (task_id, episode_key)");
    expect(migration).toContain("skill_application_one_primary_idx");
    expect(migration).toContain("UNIQUE (application_id, evidence_snapshot_hash, evaluator_version)");
    expect(migration).toContain("learned_skill_active_version_fk");
    expect(migration).toContain("FOREIGN KEY (version_id, skill_id)");
  });

  test("claim queues and lease reclaim use a bounded crash-safe vocabulary", () => {
    expect(migration).toContain("CHECK (state IN ('queued','running','succeeded','noop','quarantined','failed'))");
    expect(migration).toContain("CHECK (state IN ('queued','running','completed','dry_run_complete','failed'))");
    expect(migration).toContain("CHECK (attempt >= 0)");
  });

  test("freezes Core-owned scheduler generation and disjoint Curator claim routes", () => {
    expect(router).toContain('segments[3] === "ensure-scheduled"');
    expect(router).toContain('segments[3] === "claim-manual"');
    expect(router).toContain('segments[3] === "claim-scheduled"');
    expect(router).not.toContain("claimCuratorRunHandler");
    expect(handlers).toContain('exactFields(body, ["request_key"])');
    expect(handlers).toContain('"scheduled:initial"');
    expect(handlers).toContain('`scheduled:after:${String(lastCompleted.id)}`');
    expect(handlers).not.toContain('exactFields(body, ["schedule_bucket", "eligible_at"])');
  });
});

function authPool(actorType: string, scopes: string[]): Pool {
  return {
    query: async () => ({
      rows: [{
        scope: scopes,
        expires_at: null,
        revoked_at: null,
        user_id: "u-1",
        uid: "worker-1",
        actor_type: actorType,
        status: "active",
      }],
    }),
  } as unknown as Pool;
}

describe("self-evolution singleton capability authentication", () => {
  for (const scope of [
    "core:task-runtime",
    "core:evolution-distiller",
    "core:evolution-curator",
    "core:evolution-scheduler",
    "core:evolution-eval",
  ]) {
    test(`accepts only service singleton ${scope}`, async () => {
      await expect(authenticate(authPool("service", [scope]), "Bearer secret"))
        .resolves.toMatchObject({ actorType: "service", scopes: [scope] });
      for (const invalid of [
        () => authenticate(authPool("service", [scope, "core:read"]), "Bearer secret"),
        () => authenticate(authPool("human", [scope]), "Bearer secret"),
      ]) {
        await expect(invalid()).rejects.toMatchObject({
          code: "EVOLUTION_SCOPE_FORBIDDEN",
          httpStatus: 403,
        });
      }
    });
  }

  test("rejects mixed capability scopes even without a generic scope", async () => {
    await expect(authenticate(authPool("service", [
      "core:evolution-distiller",
      "core:evolution-scheduler",
    ]), "Bearer secret")).rejects.toMatchObject({
      code: "EVOLUTION_SCOPE_FORBIDDEN",
      httpStatus: 403,
    });
  });

  test("rejects duplicate evolution-eval scope before Set normalization", async () => {
    await expect(authenticate(authPool("service", [
      "core:evolution-eval",
      "core:evolution-eval",
    ]), "Bearer secret")).rejects.toMatchObject({
      code: "EVOLUTION_SCOPE_FORBIDDEN",
      httpStatus: 403,
    });
  });

  test("surfaces the stable forbidden code while invalid tokens remain unauthorized", async () => {
    let caught: unknown;
    try {
      await authenticate(authPool("service", ["core:evolution-eval", "core:read"]), "Bearer secret");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(errorEnvelope(caught as ApiError, "corr-scope").error).toMatchObject({
      code: "EVOLUTION_SCOPE_FORBIDDEN",
      message: "EVOLUTION_SCOPE_FORBIDDEN",
      correlation_id: "corr-scope",
    });
    await expect(authenticate(authPool("service", []), null)).rejects.toMatchObject({
      code: "authorization",
      httpStatus: 401,
    });
  });
});

describe("self-evolution rollout-off emergency control", () => {
  test("allows only learned-skills true to false without changing pause", () => {
    expect(rolloutOffSettingsTransitionAllowed(
      { learningPaused: false, learnedSkillsEnabled: true },
      { learningPaused: false, learnedSkillsEnabled: false },
    )).toBe(true);
    expect(rolloutOffSettingsTransitionAllowed(
      { learningPaused: true, learnedSkillsEnabled: true },
      { learningPaused: true, learnedSkillsEnabled: false },
    )).toBe(true);
    expect(rolloutOffSettingsTransitionAllowed(
      { learningPaused: false, learnedSkillsEnabled: true },
      { learningPaused: true, learnedSkillsEnabled: false },
    )).toBe(false);
    expect(rolloutOffSettingsTransitionAllowed(
      { learningPaused: false, learnedSkillsEnabled: false },
      { learningPaused: false, learnedSkillsEnabled: true },
    )).toBe(false);
    expect(rolloutOffSettingsTransitionAllowed(
      { learningPaused: false, learnedSkillsEnabled: false },
      { learningPaused: false, learnedSkillsEnabled: false },
    )).toBe(false);
  });
});
