import { describe, expect, test } from "bun:test";
import type { AgentTool, ToolExecContext } from "./agent-types.ts";
import type {
  LearnedSkillSearchResult,
  LearnedSkillVersion,
  LearningEpisodeResult,
  SkillApplicationResult,
  TaskEvolutionClient,
} from "./evolution-client.ts";
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
