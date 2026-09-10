import { beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "../src/api/client.ts";
import {
  createCuratorRun,
  getEvolutionOverview,
  getSkillApplication,
  listLearnedSkills,
  listSkillApplications,
  setLearnedSkillArchived,
  setLearnedSkillEnabled,
  setLearnedSkillPinned,
  updateEvolutionSettings,
} from "../src/api/evolution.ts";
import { mockApiFetch } from "../src/mock/server.ts";
import { resetMockEvolutionState } from "../src/mock/evolution.ts";

const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await mockApiFetch(input, init);
  if (!response) throw new Error(`unexpected non-mock request: ${String(input)}`);
  return response;
}) as typeof fetch;

const client = createClient({ fetchImpl: fetchMock });

const disabledFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), "http://mock.local");
  url.searchParams.set("mockEvolution", "disabled");
  return fetchMock(url, init);
}) as typeof fetch;

const disabledClient = createClient({ fetchImpl: disabledFetch });

beforeEach(() => resetMockEvolutionState());

describe("self-evolution mock follows the frozen Core contract", () => {
  test("overview, observed metrics, and unknown metrics are all represented", async () => {
    const [overview, list] = await Promise.all([
      getEvolutionOverview(client),
      listLearnedSkills(client),
    ]);
    expect(overview.curator).toMatchObject({ schedule_days: 7, idle_hours: 2, max_vivado_jobs: 3 });
    expect(list.items.find((skill) => skill.skill_id === "skill-multiple-driver")?.metrics.measurement_state).toBe("observed");
    expect(list.items.find((skill) => skill.skill_id === "skill-xdc-clock")?.metrics).toMatchObject({
      measurement_state: "unknown",
      success_rate: null,
      first_solved_problem_families: null,
    });
    expect(list.items.find((skill) => skill.skill_id === "skill-multiple-driver")?.metrics
      .first_solved_problem_families).toBeNull();
  });

  test("settings and Skill controls enforce CAS while preserving idempotent replay", async () => {
    const body = {
      learning_paused: true,
      learned_skills_enabled: true,
      expected_revision: 3,
      reason: "测试暂停",
    } as const;
    const first = await updateEvolutionSettings(client, body, "settings-key");
    const replayed = await updateEvolutionSettings(client, body, "settings-key");
    expect(replayed).toEqual(first);
    expect(first.settings_revision).toBe(4);

    await expect(updateEvolutionSettings(client, { ...body, reason: "同键异体" }, "settings-key"))
      .rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });

    const disabled = await setLearnedSkillEnabled(client, "skill-multiple-driver", false, {
      expected_control_revision: 4,
      reason: "隔离观察",
    }, "skill-key");
    expect(disabled).toMatchObject({ enabled: false, control_revision: 5 });
    await expect(setLearnedSkillEnabled(client, "skill-multiple-driver", true, {
      expected_control_revision: 4,
      reason: "旧 revision",
    }, "another-key")).rejects.toMatchObject({ status: 409, code: "EVOLUTION_CAS_CONFLICT" });
  });

  test("application detail exposes the complete append-only supersede chain", async () => {
    const detail = await getSkillApplication(client, "application-41");
    expect(detail.evaluations).toHaveLength(2);
    expect(detail.evaluations[1]).toMatchObject({
      outcome: "success",
      supersedes_id: detail.evaluations[0]!.evaluation_id,
      evaluator_type: "human",
    });
    const redacted = await getSkillApplication(client, "application-42");
    expect(redacted).toMatchObject({ project_ref: "redacted", task_ref: "redacted" });
    expect(redacted.evidence_summary.refs).toEqual([]);
  });

  test("Pin/Unpin and Archive/Restore update the CAS projection and preserve idempotency", async () => {
    const pinBody = { expected_control_revision: 4, reason: "锁定自动修改" } as const;
    const pinned = await setLearnedSkillPinned(client, "skill-multiple-driver", true, pinBody, "pin-key");
    expect(pinned).toMatchObject({ pinned: true, control_revision: 5 });
    expect(await setLearnedSkillPinned(client, "skill-multiple-driver", true, pinBody, "pin-key")).toEqual(pinned);
    await expect(setLearnedSkillPinned(client, "skill-multiple-driver", true, {
      ...pinBody,
      reason: "同键异体",
    }, "pin-key")).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });

    const unpinned = await setLearnedSkillPinned(client, "skill-multiple-driver", false, {
      expected_control_revision: 5,
      reason: "重新开放自动治理",
    }, "unpin-key");
    expect(unpinned).toMatchObject({ pinned: false, control_revision: 6 });
    const archived = await setLearnedSkillArchived(client, "skill-multiple-driver", true, {
      expected_control_revision: 6,
      reason: "从普通搜索隐藏",
    }, "archive-key");
    expect(archived).toMatchObject({ availability_state: "archived", recommended: false, control_revision: 7 });
    expect((await listLearnedSkills(client, { status: "archived" })).items.map((skill) => skill.skill_id))
      .toContain("skill-multiple-driver");
    const restored = await setLearnedSkillArchived(client, "skill-multiple-driver", false, {
      expected_control_revision: 7,
      reason: "恢复普通搜索可见性",
    }, "restore-key");
    expect(restored).toMatchObject({ availability_state: "available", recommended: true, control_revision: 8 });
  });

  test("Skill control mock rejects extra DTO fields, missing reason, missing key, and stale CAS", async () => {
    const raw = async (body: unknown, headers: HeadersInit = { "idempotency-key": "strict-key" }) => {
      const response = await mockApiFetch("http://mock.local/api/v1/learned-skills/skill-multiple-driver/pin", {
        method: "POST",
        headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
        body: JSON.stringify(body),
      });
      if (!response) throw new Error("missing mock response");
      return response;
    };
    expect((await raw({ expected_control_revision: 4, reason: "严格", extra: true })).status).toBe(400);
    expect((await raw({ expected_control_revision: 4, reason: "   " })).status).toBe(400);
    expect((await raw({ expected_control_revision: 4, reason: "缺幂等键" }, {})).status).toBe(400);
    expect((await raw({ expected_control_revision: 999, reason: "旧 revision" }, {
      "idempotency-key": "stale-key",
    })).status).toBe(409);
  });

  test("Curator run and dry-run return their distinct canonical states", async () => {
    const run = await createCuratorRun(client, { mode: "run", reason: "立即评价", manual_key: "manual-run" }, "run-key");
    const dryRun = await createCuratorRun(client, { mode: "dry_run", reason: "先看计划", manual_key: "manual-dry" }, "dry-key");
    expect(run.state).toBe("queued");
    expect(dryRun.state).toBe("dry_run_complete");
  });

  test("rollout-off permits only global and per-Skill emergency disable", async () => {
    expect((await getEvolutionOverview(disabledClient)).rollout_enabled).toBe(false);

    await expect(updateEvolutionSettings(disabledClient, {
      learning_paused: true,
      learned_skills_enabled: true,
      expected_revision: 3,
      reason: "尝试暂停",
    }, "disabled-pause")).rejects.toMatchObject({ status: 503, code: "EVOLUTION_DISABLED" });
    await expect(createCuratorRun(disabledClient, {
      mode: "dry_run",
      reason: "尝试补评",
      manual_key: "disabled-curator",
    }, "disabled-curator")).rejects.toMatchObject({ status: 503, code: "EVOLUTION_DISABLED" });

    const emergency = await updateEvolutionSettings(disabledClient, {
      learning_paused: false,
      learned_skills_enabled: false,
      expected_revision: 3,
      reason: "紧急停止 Learned Skills",
    }, "emergency-global-disable");
    expect(emergency).toMatchObject({ rollout_enabled: false, learned_skills_enabled: false, settings_revision: 4 });
    await expect(updateEvolutionSettings(disabledClient, {
      learning_paused: false,
      learned_skills_enabled: true,
      expected_revision: 4,
      reason: "尝试恢复",
    }, "disabled-global-enable")).rejects.toMatchObject({ status: 503, code: "EVOLUTION_DISABLED" });

    const disabled = await setLearnedSkillEnabled(disabledClient, "skill-multiple-driver", false, {
      expected_control_revision: 4,
      reason: "紧急隔离单项 Skill",
    }, "emergency-skill-disable");
    expect(disabled).toMatchObject({ enabled: false, control_revision: 5 });
    expect(await setLearnedSkillEnabled(disabledClient, "skill-multiple-driver", false, {
      expected_control_revision: 4,
      reason: "紧急隔离单项 Skill",
    }, "emergency-skill-disable")).toEqual(disabled);
    await expect(setLearnedSkillEnabled(disabledClient, "skill-multiple-driver", false, {
      expected_control_revision: 5,
      reason: "新请求重复禁用",
    }, "emergency-skill-disable-again")).rejects.toMatchObject({ status: 503, code: "EVOLUTION_DISABLED" });
    await expect(setLearnedSkillEnabled(disabledClient, "skill-multiple-driver", true, {
      expected_control_revision: 5,
      reason: "尝试恢复 Skill",
    }, "disabled-skill-enable")).rejects.toMatchObject({ status: 503, code: "EVOLUTION_DISABLED" });
    const forbiddenControls = [
      () => setLearnedSkillPinned(disabledClient, "skill-xdc-clock", true, {
        expected_control_revision: 1,
        reason: "尝试 Pin",
      }, "disabled-pin"),
      () => setLearnedSkillPinned(disabledClient, "skill-xdc-clock", false, {
        expected_control_revision: 1,
        reason: "尝试 Unpin",
      }, "disabled-unpin"),
      () => setLearnedSkillArchived(disabledClient, "skill-xdc-clock", true, {
        expected_control_revision: 1,
        reason: "尝试 Archive",
      }, "disabled-archive"),
      () => setLearnedSkillArchived(disabledClient, "skill-xdc-clock", false, {
        expected_control_revision: 1,
        reason: "尝试 Restore",
      }, "disabled-restore"),
    ];
    for (const attempt of forbiddenControls) {
      await expect(attempt()).rejects.toMatchObject({ status: 503, code: "EVOLUTION_DISABLED" });
    }
  });

  test("list cursors expose truncation instead of silently hiding remaining rows", async () => {
    const skillPage = await listLearnedSkills(client, { limit: 1 });
    expect(skillPage).toMatchObject({ items: [{ skill_id: "skill-multiple-driver" }] });
    expect(skillPage.next_cursor).toBe("mock-skill-1");
    const nextSkillPage = await listLearnedSkills(client, { limit: 1, cursor: skillPage.next_cursor! });
    expect(nextSkillPage.items[0]?.skill_id).toBe("skill-xdc-clock");

    const applicationPage = await listSkillApplications(client, "skill-multiple-driver", { limit: 1 });
    expect(applicationPage.next_cursor).toBe("mock-application-1");
  });
});
