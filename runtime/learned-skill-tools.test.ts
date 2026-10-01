import { describe, expect, test } from "bun:test";
import type { AgentTool, ToolExecContext } from "./agent-types.ts";
import type {
  LearnedSkillSearchResult,
  LearnedSkillVersion,
  LearningEpisodeResult,
  SkillApplicationResult,
  TaskEvolutionClient,
} from "./evolution-client.ts";
import { CoreTaskEvolutionClient } from "./evolution-client.ts";
import { assembleLearnedSkillTools } from "./learned-skill-tools.ts";
import { NoGovernanceClient } from "./types.ts";

function tools(): Record<string, AgentTool> {
  return Object.fromEntries(assembleLearnedSkillTools().map(tool => [tool.name, tool]));
}

function fakeClient(overrides: Partial<TaskEvolutionClient> = {}): TaskEvolutionClient {
  return {
    projectId: "project-1",
    taskId: "task-1",
    search: async (): Promise<LearnedSkillSearchResult> => ({ items: [], learnedSkillsEnabled: true }),
    view: async (): Promise<LearnedSkillVersion> => ({
      skillId: "skill-1",
      versionId: "version-1",
      versionNo: 1,
      name: "Skill",
      summary: "Summary",
      description: "Steps",
      applicability: {},
      outcomeContract: {},
      qualityState: "active_unproven",
      contentManifestHash: "a".repeat(64),
      files: [],
    }),
    createApplication: async (): Promise<SkillApplicationResult> => ({
      applicationId: "app-1",
      observationKey: "turn:turn-1",
      episodeId: null,
      state: "open",
      versionId: "version-1",
      role: "primary",
      replayed: false,
    }),
    attachSupportingSkill: async (): Promise<SkillApplicationResult> => ({
      applicationId: "app-1",
      observationKey: "turn:turn-1",
      episodeId: null,
      state: "open",
      versionId: "version-2",
      role: "supporting",
      replayed: false,
    }),
    closeApplication: async (): Promise<SkillApplicationResult> => ({
      applicationId: "app-1",
      observationKey: "turn:turn-1",
      episodeId: null,
      state: "closed_pending_episode",
      replayed: false,
    }),
    createEpisode: async (): Promise<LearningEpisodeResult> => ({
      episodeId: "episode-1",
      observationKey: "turn:turn-1",
      episodeKey: "turn:turn-1:9",
      distillationState: "queued",
      boundApplicationIds: [],
      replayed: false,
    }),
    ...overrides,
  };
}

function context(evolution?: TaskEvolutionClient): ToolExecContext {
  return {
    projectId: "project-1",
    taskId: "task-1",
    taskKind: "main",
    toolCallId: "call-1",
    turnId: "turn-1",
    toolEventSequence: 7,
    evolution,
    governance: new NoGovernanceClient(),
    connector: null,
    part: "",
    classification: "internal",
  };
}

describe("Learned Skill tools", () => {
  test("legacy/unbound sessions fail closed", async () => {
    const result = await tools().learned_skill_search!.execute({ query: "timing" }, context(undefined));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe("missing_task_binding");
  });

  test("view labels every script asset non-executable", async () => {
    const evolution = fakeClient({
      view: async () => ({
        ...await fakeClient().view("skill-1", "version-1"),
        files: [{
          path: "scripts/check.tcl",
          kind: "script",
          language: "tcl",
          sha256: "b".repeat(64),
          sizeBytes: 10,
          mediaType: "text/plain",
          content: "report_timing",
        }],
      }),
    });
    const result = await tools().learned_skill_view!.execute(
      { skill_id: "skill-1", version_id: "version-1" },
      context(evolution),
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content);
    expect(body.files[0]).toMatchObject({ path: "scripts/check.tcl", executable: false });
    expect(body.warning).toContain("不携带 capability");
  });

  test("primary creates the local-goal aggregate with Runtime-owned identities", async () => {
    let captured: unknown;
    const evolution = fakeClient({
      createApplication: async (input) => {
        captured = input;
        return await fakeClient().createApplication(input);
      },
    });
    const result = await tools().learned_skill_apply!.execute({
      version_id: "version-1",
      local_goal: "fix timing",
      reason_codes: ["matching-failure"],
      role: "primary",
    }, context(evolution));
    expect(result.isError).toBeUndefined();
    expect(captured).toMatchObject({
      toolCallId: "call-1",
      turnId: "turn-1",
      versionId: "version-1",
      localGoal: "fix timing",
    });
    expect((captured as { idempotencyKey: string }).idempotencyKey).toStartWith("learned-apply-");
  });

  test("supporting requires an existing application and never creates a second primary", async () => {
    const tool = tools().learned_skill_apply!;
    const missing = await tool.execute({
      version_id: "version-2",
      local_goal: "fix timing",
      reason_codes: [],
      role: "supporting",
    }, context(fakeClient()));
    expect(JSON.parse(missing.content).error).toBe("invalid_application_shape");

    const extra = await tool.execute({
      version_id: "version-2",
      local_goal: "fix timing",
      reason_codes: [],
      role: "primary",
      application_id: "app-1",
    }, context(fakeClient()));
    expect(JSON.parse(extra.content).error).toBe("invalid_application_shape");
  });

  test("close uses the committed tool event sequence and does not claim success", async () => {
    let captured: unknown;
    const evolution = fakeClient({
      closeApplication: async (input) => {
        captured = input;
        return await fakeClient().closeApplication(input);
      },
    });
    const result = await tools().learned_skill_close!.execute({
      application_id: "app-1",
      outcome_claim: "appears fixed",
      human_corrections: 1,
      evidence_refs: ["evidence-1"],
      tool_run_refs: ["run-1"],
    }, context(evolution));
    expect(captured).toMatchObject({ endEventSequence: 7, outcomeClaim: "appears fixed" });
    expect(JSON.parse(result.content).note).toContain("不是权威成功结论");
  });
});


describe("H35 p31 close argument regression", () => {
  for (const applicationId of ["app_189a9157-c97f-44f9-ab23-a377dccea796", "app_ae7e49b8-7d00-44a4-89c6-5f0a2e9597a2"]) {
    for (const shape of ["annotated", "empty", "omitted", "null-claim"]) {
      test(`${applicationId}: ${shape} retains zero through tool and HTTP serialization`, async () => {
        let captured: Record<string, unknown> | undefined;
        const evolution = new CoreTaskEvolutionClient({
          baseUrl: "http://core.test", token: "test-only", projectId: "project-1", taskId: "task-1",
          fetchImpl: (async (url, init) => {
            expect(String(url)).toContain(`/skill-applications/${applicationId}/close`);
            captured = JSON.parse(String(init?.body));
            return Response.json({ data: { schema: "skill-application.v1", application_id: applicationId, state: "closed_pending_episode", replayed: false } });
          }) as typeof fetch,
        });
        const refs = shape === "annotated" ? {
          evidence_refs: ["doc/compile/run_report.md v2 rev-e39d9f32 content sha256 3b665175…（收官）"],
          tool_run_refs: ["job-acc013a2-0dfc-468e-860b-0ea3cd3e4fc2（R28 simulate，PASS=11 FAIL=0）"],
        } : shape === "omitted" ? {} : { evidence_refs: [], tool_run_refs: [] };
        const result = await tools().learned_skill_close!.execute({
          application_id: applicationId, human_corrections: 0,
          outcome_claim: shape === "null-claim" ? null : shape === "annotated" ? "p31 四步验收核证、引用长载荷。".repeat(100) : "p31 四步验收核证", ...refs,
        }, context(evolution));
        expect(result.isError).toBeUndefined();
        expect(captured?.human_corrections).toBe(0);
        expect(captured?.evidence_refs).toEqual(refs.evidence_refs ?? []);
        expect(captured?.tool_run_refs).toEqual(refs.tool_run_refs ?? []);
      });
    }
  }
  test("apply accepts Chinese and annotated reason strings", async () => {
    const result = await tools().learned_skill_apply!.execute({
      version_id: "version-1", local_goal: "验收", role: "primary", reason_codes: ["四步链验收核证", "clock-only XDC 豁免指纹"],
    }, context(fakeClient()));
    expect(result.isError).toBeUndefined();
  });
  test("missing zero, invalid arrays and missing task boundary remain rejected with field diagnostics", async () => {
    for (const patch of [{ human_corrections: undefined }, { human_corrections: false }, { evidence_refs: "[]" }, { tool_run_refs: [0] }]) {
      const result = await tools().learned_skill_close!.execute({
        application_id: "app-1", outcome_claim: null, human_corrections: 0, ...patch,
      }, context(fakeClient()));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).reason).toContain(Object.keys(patch)[0]);
    }
    const result = await tools().learned_skill_close!.execute({ application_id: "app-1", outcome_claim: null, human_corrections: 0 }, { ...context(fakeClient()), toolEventSequence: undefined });
    expect(JSON.parse(result.content).error).toBe("missing_runtime_binding");
  });
});


test("H35 retains production skill_id resolution and omitted apply fields", async () => {
  let applied: unknown;
  const evolution = fakeClient({
    search: async (query, limit) => {
      expect(query).toBe("");
      expect(limit).toBe(100);
      return { learnedSkillsEnabled: true, items: [{ skillId: "skill-1", versionId: "version-1", name: "test", summary: "test", applicabilitySummary: "test", qualityState: "active_unproven", recommended: true }] };
    },
    createApplication: async input => { applied = input; return fakeClient().createApplication(input); },
  });
  const result = await tools().learned_skill_apply!.execute({ skill_id: "skill-1", local_goal: "p31 收官" }, context(evolution));
  expect(result.isError).toBeUndefined();
  expect(applied).toMatchObject({ versionId: "version-1", reasonCodes: [] });
});
