import { describe, expect, test } from "bun:test";
import {
  newRunId,
  runStatePath,
  createRunState,
  saveRunState,
  loadRunState,
  listRuns,
  deleteRun,
  STAGE_ORDER,
  nextStage,
  withStage,
  withAwaitingApproval,
  withTerminal,
  withDocArtifact,
  withGateSubmission,
  withGateDecision,
} from "./run-state.ts";
import type { RunState, RegisteredRevision } from "./types.ts";
import { join } from "node:path";

describe("run-state persistence", () => {
  test("newRunId generates run-<uuid> format", () => {
    const id = newRunId();
    expect(id).toMatch(/^run-[0-9a-f-]{36}$/);
  });

  test("createRunState initializes all fields", () => {
    const state = createRunState({ runId: "r1", task: "counter", part: "xc7", projectId: "p1" });
    expect(state.runId).toBe("r1");
    expect(state.task).toBe("counter");
    expect(state.currentStage).toBe("intake");
    expect(state.status).toBe("running");
    expect(state.docs).toEqual({});
    expect(state.gateSubmissions).toEqual({});
    expect(state.gateDecisions).toEqual({});
  });

  test("save + load round-trips state", async () => {
    const state = createRunState({ runId: "r-test-rt", task: "test", part: "xc7", projectId: "p1" });
    const updated = withAwaitingApproval(state, "G1");
    await saveRunState(updated);
    const loaded = await loadRunState("r-test-rt");
    expect(loaded.status).toBe("awaiting_approval");
    expect(loaded.awaitingGate).toBe("G1");
    await deleteRun("r-test-rt");
  });

  test("loadRunState throws for non-existent run", async () => {
    await expect(loadRunState("nonexistent")).rejects.toThrow();
  });

  test("listRuns returns saved run ids", async () => {
    const state1 = createRunState({ runId: "r-list-1", task: "a", part: "p", projectId: "p1" });
    const state2 = createRunState({ runId: "r-list-2", task: "b", part: "p", projectId: "p1" });
    await saveRunState(state1);
    await saveRunState(state2);
    const runs = await listRuns();
    expect(runs).toContain("r-list-1");
    expect(runs).toContain("r-list-2");
    await deleteRun("r-list-1");
    await deleteRun("r-list-2");
  });

  test("deleteRun is no-op for non-existent", async () => {
    await deleteRun("does-not-exist"); // should not throw
  });
});

describe("stage ordering", () => {
  test("STAGE_ORDER has 11 stages", () => {
    expect(STAGE_ORDER.length).toBe(11);
  });

  test("STAGE_ORDER starts with intake and ends with implement", () => {
    expect(STAGE_ORDER[0]).toBe("intake");
    expect(STAGE_ORDER[STAGE_ORDER.length - 1]).toBe("implement");
  });

  test("nextStage returns the following stage", () => {
    expect(nextStage("intake")).toBe("behavior_wave");
    expect(nextStage("architecture")).toBe("register_spec");
    expect(nextStage("rtl_build")).toBe("validate");
  });

  test("nextStage returns undefined for the last stage", () => {
    expect(nextStage("implement")).toBeUndefined();
  });
});

describe("run-state functional updates", () => {
  const base: RunState = createRunState({ runId: "r1", task: "t", part: "p", projectId: "p1" });

  test("withStage updates currentStage and status", () => {
    const s = withStage(base, "rtl_build");
    expect(s.currentStage).toBe("rtl_build");
    expect(s.status).toBe("running");
  });

  test("withAwaitingApproval sets awaitingGate", () => {
    const s = withAwaitingApproval(base, "G2");
    expect(s.status).toBe("awaiting_approval");
    expect(s.awaitingGate).toBe("G2");
  });

  test("withTerminal sets terminal status and clears awaitingGate", () => {
    const s1 = withAwaitingApproval(base, "G1");
    const s2 = withTerminal(s1, "succeeded", "done");
    expect(s2.status).toBe("succeeded");
    expect(s2.awaitingGate).toBeUndefined();
    expect(s2.endedReason).toBe("done");
  });

  test("withDocArtifact adds a revision for a stage", () => {
    const rev: RegisteredRevision = { revisionId: "rev-1", artifactId: "art-1", version: 1, contentHash: "h" };
    const s = withDocArtifact(base, "intake", rev);
    expect(s.docs?.intake?.revisionId).toBe("rev-1");
  });

  test("withGateSubmission records submission id", () => {
    const s = withGateSubmission(base, "G1", "sub-1");
    expect(s.gateSubmissions?.G1).toBe("sub-1");
  });

  test("withGateDecision records decision", () => {
    const s = withGateDecision(base, "G1", "approved");
    expect(s.gateDecisions?.G1).toBe("approved");
  });
});
