import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { computeEvolutionEfficiency, type EvolutionEfficiencyObservation } from "../src/domain/self-evolution.ts";
import { readEvolutionEfficiency } from "../src/services/evolution-efficiency.ts";

const success = (appliedMs: number | null, skillId = "skill-a", baselineMs: number | null = 1000): EvolutionEfficiencyObservation => ({ skillId, outcome: "success", baselineMs, appliedMs });

describe("cumulative evolution efficiency", () => {
  test("adds actual per-application differences, not median times count", () => {
    const total = computeEvolutionEfficiency([success(100), success(100), success(700)]);
    expect(total.net_saved_ms).toBe(2100);
    expect(total.baseline_total_ms).toBe(3000);
    expect(total.applied_total_ms).toBe(900);
    expect(total.speedup).toBeCloseTo(3000 / 900);
    expect(total.compared_applications).toBe(3);
    expect(total.compared_skills).toBe(1);
  });
  test("includes slower successes as a loss, without clamping or averaging speedups", () => {
    const total = computeEvolutionEfficiency([success(100), success(4000, "skill-b")]);
    expect(total.net_saved_ms).toBe(-2100);
    expect(total.speedup).toBeCloseTo(2000 / 4100);
    expect(total.compared_skills).toBe(2);
  });
  test("failed, pending, inconclusive and incomplete observations cannot claim savings", () => {
    const total = computeEvolutionEfficiency([
      { ...success(100), outcome: "execution_failure" },
      { ...success(100), outcome: "applicability_failure" },
      { ...success(100), outcome: "inconclusive" },
      { ...success(100), outcome: null },
      success(null), success(0), success(100, "b", null), success(100, "b", 0), success(NaN),
    ]);
    expect(total.primary_applications).toBe(9);
    expect(total.successful_applications).toBe(5);
    expect(total.compared_applications).toBe(0);
    expect(total.measurement_state).toBe("unknown");
    expect(total.net_saved_ms).toBeNull();
    expect(total.speedup).toBeNull();
    expect(computeEvolutionEfficiency([]).net_saved_ms).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("efficiency PostgreSQL projection", () => {
  test("counts all versions once, uses latest evaluations, and clips both arms", async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      // Temporary tables isolate the fixture and shadow production names only on this connection.
      await db.query(`
        CREATE TEMP TABLE skill_application (id text,task_id text,start_event_sequence int,end_event_sequence int);
        CREATE TEMP TABLE skill_application_skill (application_id text,skill_id text,version_id text,role text);
        CREATE TEMP TABLE learned_skill_version (id text,skill_id text,version_no int,distillation_run_id text);
        CREATE TEMP TABLE distillation_run (id text,episode_id text);
        CREATE TEMP TABLE learning_episode (id text,task_id text,end_event_sequence int);
        CREATE TEMP TABLE curator_evaluation (id text,application_id text,version_id text,outcome text,supersedes_id text,created_at timestamptz);
        CREATE TEMP TABLE task_conversation_event (task_id text,sequence int,created_at timestamptz);
        INSERT INTO learned_skill_version VALUES ('v1','s1',1,'d1'),('v2','s1',2,'d2'),('v3','s2',1,'missing');
        INSERT INTO distillation_run VALUES ('d1','e1');
        INSERT INTO learning_episode VALUES ('e1','origin',3);
        INSERT INTO skill_application VALUES ('a1','t1',1,3),('a2','t2',1,2),('a3','t3',1,2),('a4','t4',1,2),('a5','t5',1,2),('a6','t6',1,NULL),('a7','t7',1,2);
        INSERT INTO skill_application_skill VALUES ('a1','s1','v1','primary'),('a1','s1','v2','supporting'),('a2','s1','v2','primary'),('a3','s1','v1','primary'),('a4','s1','v2','primary'),('a5','s2','v3','primary'),('a6','s1','v2','primary'),('a7','s1','v1','primary');
        INSERT INTO curator_evaluation VALUES
          ('ce1','a1','v1','success',NULL,now()),
          ('support','a1','v2','success',NULL,now()),
          ('ce2','a2','v2','execution_failure',NULL,now()),
          ('ce3','a2','v2','success','ce2',now()),
          ('ce4','a3','v1','success',NULL,now()),
          ('ce5','a3','v1','inconclusive','ce4',now()),
          ('ce6','a5','v3','success',NULL,now()),
          ('ce7','a7','v1','success',NULL,now());
        INSERT INTO task_conversation_event VALUES
          ('origin',1,'2026-01-01 00:00:00Z'),('origin',2,'2026-01-01 00:01:00Z'),('origin',3,'2026-01-02 00:00:00Z'),('origin',4,'2026-01-03 00:00:00Z'),
          ('t1',1,'2026-01-01 00:00:00Z'),('t1',2,'2026-01-01 00:00:30Z'),('t1',3,'2026-01-02 00:00:00Z'),
          ('t2',1,'2026-01-01 00:00:00Z'),('t2',2,'2026-01-01 00:01:40Z'),
          ('t5',1,'2026-01-01 00:00:00Z'),('t5',2,'2026-01-01 00:00:10Z');
      `);
      const result = await readEvolutionEfficiency(db);
      expect(result).toEqual({
        measurement_state: "observed", primary_applications: 7, successful_applications: 4,
        compared_applications: 2, compared_skills: 1,
        baseline_total_ms: 1_320_000, applied_total_ms: 730_000,
        net_saved_ms: 590_000, speedup: 1_320_000 / 730_000,
        scope: "all_versions", gap_cap_seconds: 600,
      });
    } finally {
      await db.end();
    }
  });
});
