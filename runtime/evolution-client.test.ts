import { describe, expect, test } from "bun:test";
import { CoreTaskEvolutionClient, EvolutionClientError } from "./evolution-client.ts";

const HASH = "a".repeat(64);

function client(fetchImpl: typeof fetch): CoreTaskEvolutionClient {
  return new CoreTaskEvolutionClient({
    baseUrl: "http://core.local/",
    token: "task.token/+opaque",
    projectId: "project-1",
    taskId: "task-1",
    fetchImpl,
    retryDelayMs: 0,
    sleep: async () => {},
  });
}

describe("CoreTaskEvolutionClient", () => {
  test("search stays on the task-bound route and parses the frozen DTO", async () => {
    const result = await client((async (input, init) => {
      expect(String(input)).toBe(
        "http://core.local/api/v1/projects/project-1/tasks/task-1/learned-skills/search?q=timing&limit=3",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer task.token/+opaque");
      expect(headers.get("x-synthia-task-id")).toBe("task-1");
      return Response.json({ data: {
        schema: "learned-skill-search.v1",
        learned_skills_enabled: true,
        items: [{
          skill_id: "skill-1",
          version_id: "version-1",
          name: "Timing repair",
          summary: "Repair generated clocks",
          applicability_summary: "Vivado timing",
          quality_state: "active_unproven",
          recommended: true,
        }],
      } });
    }) as typeof fetch).search("timing", 3);

    expect(result).toEqual({
      learnedSkillsEnabled: true,
      items: [{
        skillId: "skill-1",
        versionId: "version-1",
        name: "Timing repair",
        summary: "Repair generated clocks",
        applicabilitySummary: "Vivado timing",
        qualityState: "active_unproven",
        recommended: true,
      }],
    });
  });

  test("view rejects a cross-version response and never executes assets", async () => {
    const evolution = client((async () => Response.json({ data: {
      schema: "learned-skill-version.v1",
      skill: { skill_id: "skill-1", name: "Skill", summary: "summary" },
      version: {
        version_id: "different-version",
        version_no: 1,
        description: "desc",
        applicability: {},
        outcome_contract: {},
        quality_state: "active_unproven",
        content_manifest_hash: HASH,
        files: [],
      },
    } })) as typeof fetch);
    await expect(evolution.view("skill-1", "version-1")).rejects.toMatchObject({
      code: "evolution_contract_error",
    } satisfies Partial<EvolutionClientError>);
  });

  test("create application sends turn and stable caller idempotency facts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const evolution = client((async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ data: {
        schema: "skill-application.v1",
        application_id: "app-1",
        observation_key: "turn:turn-1",
        episode_id: null,
        state: "open",
        version_id: "version-1",
        role: "primary",
        replayed: false,
      } });
    }) as typeof fetch);

    await evolution.createApplication({
      toolCallId: "call-1",
      turnId: "turn-1",
      versionId: "version-1",
      localGoal: "fix timing",
      reasonCodes: ["matching-failure"],
      idempotencyKey: "learned-apply-1",
    });
    expect(calls[0]!.url).toEndWith("/tasks/task-1/skill-applications");
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe("learned-apply-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      schema: "skill-application-create.v1",
      tool_call_id: "call-1",
      turn_id: "turn-1",
      version_id: "version-1",
      local_goal: "fix timing",
      reason_codes: ["matching-failure"],
    });
  });

  test("episode response carries atomic application binding", async () => {
    const evolution = client((async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        observation_key: "turn:turn-1",
        episode_key: "turn:turn-1:9",
        end_event_sequence: 9,
      });
      return Response.json({ data: {
        schema: "learning-episode.v1",
        episode_id: "episode-1",
        observation_key: "turn:turn-1",
        episode_key: "turn:turn-1:9",
        distillation_state: "queued",
        bound_application_ids: ["app-1"],
        replayed: false,
      } });
    }) as typeof fetch);
    await expect(evolution.createEpisode({
      observationKey: "turn:turn-1",
      episodeKey: "turn:turn-1:9",
      turnId: "turn-1",
      endEventSequence: 9,
      contentHash: HASH,
      outcomeClaim: "fixed",
      toolEventStartSequence: 2,
      toolEventEndSequence: 7,
      evidenceRefs: ["evidence-1"],
      idempotencyKey: "episode-1",
    })).resolves.toMatchObject({ boundApplicationIds: ["app-1"] });
  });

  test("close parses the frozen minimal response without invented binding fields", async () => {
    const client = new CoreTaskEvolutionClient({
      baseUrl: "http://core.local",
      token: "task-token",
      projectId: "project-1",
      taskId: "task-1",
      fetchImpl: async () => Response.json({ data: {
        schema: "skill-application.v1",
        application_id: "application-1",
        state: "pending_evaluation",
        replayed: false,
      } }),
    });

    expect(await client.closeApplication({
      applicationId: "application-1",
      endEventSequence: 12,
      outcomeClaim: null,
      humanCorrections: 0,
      evidenceRefs: [],
      toolRunRefs: [],
      idempotencyKey: "close-1",
    })).toEqual({
      applicationId: "application-1",
      state: "pending_evaluation",
      replayed: false,
    });
  });

  test("stable Core error is not retried", async () => {
    let calls = 0;
    const evolution = client((async () => {
      calls += 1;
      return Response.json({ error: {
        code: "LEARNED_SKILLS_DISABLED",
        message: "disabled",
        retryable: false,
      } }, { status: 409 });
    }) as typeof fetch);
    await expect(evolution.search("x")).rejects.toMatchObject({
      code: "LEARNED_SKILLS_DISABLED",
      httpStatus: 409,
    } satisfies Partial<EvolutionClientError>);
    expect(calls).toBe(1);
  });
});
