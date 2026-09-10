import { describe, expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import {
  createCuratorRun,
  listLearnedSkills,
  setLearnedSkillArchived,
  setLearnedSkillEnabled,
  setLearnedSkillPinned,
  updateEvolutionSettings,
} from "../src/api/evolution.ts";

const overview = {
  schema: "evolution-overview.v1",
  rollout_enabled: true,
  learning_paused: true,
  learned_skills_enabled: true,
  settings_revision: 4,
  skill_counts: {
    active_unproven: 0,
    active_observed: 0,
    needs_review: 0,
    degraded: 0,
    quarantined: 0,
    archived: 0,
    disabled: 0,
  },
  pending_applications: 0,
  curator: {
    last_run_at: null,
    next_eligible_at: null,
    pending_evaluations: 0,
    schedule_days: 7,
    idle_hours: 2,
    max_vivado_jobs: 3,
    max_duration_minutes: 120,
  },
};

const skill = {
  schema: "learned-skill-summary.v1",
  skill_id: "skill-1",
  slug: "skill-one",
  name: "Skill One",
  summary: "摘要",
  applicability_summary: "Vivado 综合",
  active_version_id: "version-1",
  active_version_no: 1,
  quality_state: "active_unproven",
  freshness_state: "current",
  availability_state: "available",
  enabled: false,
  pinned: false,
  recommended: false,
  control_revision: 2,
  last_used_at: null,
  metrics: {
    measurement_state: "unknown",
    primary_applied: 0,
    evaluated: 0,
    pending: 0,
    inconclusive: 0,
    success: 0,
    applicability_failure: 0,
    execution_failure: 0,
    success_rate: null,
    median_duration_ms: null,
    human_corrections: null,
    first_solved_problem_families: null,
  },
};

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, correlation_id: "test" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("self-evolution v1 API consumer", () => {
  test("encodes list filters without leaking them into a body", async () => {
    let captured = "";
    const client = createClient({
      fetchImpl: (async (input: RequestInfo | URL) => {
        captured = String(input);
        return envelope({ schema: "learned-skill-list.v1", items: [skill], next_cursor: null });
      }) as typeof fetch,
    });
    const result = await listLearnedSkills(client, { status: "active_unproven", cursor: "next token", limit: 25 });
    expect(result.items).toHaveLength(1);
    expect(captured).toBe("/api/v1/learned-skills?status=active_unproven&cursor=next+token&limit=25");
  });

  test("settings sends frozen CAS body plus Idempotency-Key", async () => {
    let captured: RequestInit | undefined;
    const client = createClient({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return envelope(overview);
      }) as typeof fetch,
    });
    const body = {
      learning_paused: true,
      learned_skills_enabled: true,
      expected_revision: 3,
      reason: "维护窗口",
    } as const;
    await updateEvolutionSettings(client, body, "idem-settings");
    expect(new Headers(captured?.headers).get("idempotency-key")).toBe("idem-settings");
    expect(JSON.parse(String(captured?.body))).toEqual(body);
  });

  test("Skill control uses the exact enable route and expected_control_revision", async () => {
    let path = "";
    let captured: RequestInit | undefined;
    const client = createClient({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        path = String(input);
        captured = init;
        return envelope(skill);
      }) as typeof fetch,
    });
    await setLearnedSkillEnabled(client, "skill/unsafe id", true, {
      expected_control_revision: 1,
      reason: "恢复观察",
    }, "idem-skill");
    expect(path).toBe("/api/v1/learned-skills/skill%2Funsafe%20id/enable");
    expect(JSON.parse(String(captured?.body))).toEqual({ expected_control_revision: 1, reason: "恢复观察" });
  });

  test("Pin/Unpin and Archive/Restore expose typed exact routes without an arbitrary action", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createClient({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path: String(input), init });
        return envelope(skill);
      }) as typeof fetch,
    });
    const body = { expected_control_revision: 2, reason: "人工生命周期控制" } as const;
    await setLearnedSkillPinned(client, "skill/unsafe id", true, body, "idem-pin");
    await setLearnedSkillPinned(client, "skill/unsafe id", false, body, "idem-unpin");
    await setLearnedSkillArchived(client, "skill/unsafe id", true, body, "idem-archive");
    await setLearnedSkillArchived(client, "skill/unsafe id", false, body, "idem-restore");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/learned-skills/skill%2Funsafe%20id/pin",
      "/api/v1/learned-skills/skill%2Funsafe%20id/unpin",
      "/api/v1/learned-skills/skill%2Funsafe%20id/archive",
      "/api/v1/learned-skills/skill%2Funsafe%20id/restore",
    ]);
    expect(calls.map((call) => new Headers(call.init?.headers).get("idempotency-key"))).toEqual([
      "idem-pin",
      "idem-unpin",
      "idem-archive",
      "idem-restore",
    ]);
    expect(calls.every((call) => JSON.stringify(JSON.parse(String(call.init?.body))) === JSON.stringify(body))).toBe(true);
  });

  test("manual Curator request keeps manual_key in the frozen DTO", async () => {
    let captured: RequestInit | undefined;
    const client = createClient({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return envelope({
          schema: "curator-run.v1",
          curator_run_id: "curator-1",
          state: "dry_run_complete",
          mode: "dry_run",
          created_at: "2026-08-26T00:00:00.000Z",
        });
      }) as typeof fetch,
    });
    const result = await createCuratorRun(client, {
      mode: "dry_run",
      reason: "先查看计划",
      manual_key: "manual-1",
    }, "idem-curator");
    expect(result.state).toBe("dry_run_complete");
    expect(JSON.parse(String(captured?.body))).toEqual({ mode: "dry_run", reason: "先查看计划", manual_key: "manual-1" });
  });
});
