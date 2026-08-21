import { describe, expect, test } from "bun:test";
import {
  newAgentId,
  agentStatePath,
  agentMessageIdempotencyPath,
  createAgentState,
  saveAgentState,
  loadAgentState,
  loadMessageIdempotencyRecords,
  saveMessageIdempotencyRecords,
  listAgents,
  deleteAgent,
  STAGE_ORDER,
  nextStage,
  withStage,
  withAwaitingApproval,
  withTerminal,
  withDocArtifact,
  withGateSubmission,
  withGateDecision,
} from "./agent-state.ts";
import type { AgentState, RegisteredRevision } from "./types.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

describe("agent-state persistence", () => {
  test("newAgentId generates agent-<uuid> format", () => {
    const id = newAgentId();
    expect(id).toMatch(/^agent-[0-9a-f-]{36}$/);
  });

  test("createAgentState initializes all fields", () => {
    const state = createAgentState({ agentId: "r1", task: "counter", part: "xc7", projectId: "p1" });
    expect(state.agentId).toBe("r1");
    expect(state.task).toBe("counter");
    expect(state.currentStage).toBe("intake");
    expect(state.status).toBe("running");
    expect(state.docs).toEqual({});
    expect(state.gateSubmissions).toEqual({});
    expect(state.gateDecisions).toEqual({});
  });

  test("save + load round-trips state", async () => {
    const state = createAgentState({ agentId: "r-test-rt", task: "test", part: "xc7", projectId: "p1" });
    const updated = withAwaitingApproval(state, "G1");
    await saveAgentState(updated);
    const loaded = await loadAgentState("r-test-rt");
    expect(loaded.status).toBe("awaiting_approval");
    expect(loaded.awaitingGate).toBe("G1");
    await deleteAgent("r-test-rt");
  });

  test("loadAgentState throws for non-existent agent", async () => {
    await expect(loadAgentState("nonexistent")).rejects.toThrow();
  });

  test("listAgents returns saved agent ids", async () => {
    const state1 = createAgentState({ agentId: "r-list-1", task: "a", part: "p", projectId: "p1" });
    const state2 = createAgentState({ agentId: "r-list-2", task: "b", part: "p", projectId: "p1" });
    await saveAgentState(state1);
    await saveAgentState(state2);
    const agents = await listAgents();
    expect(agents).toContain("r-list-1");
    expect(agents).toContain("r-list-2");
    await deleteAgent("r-list-1");
    await deleteAgent("r-list-2");
  });

  test("message idempotency ledgers persist separately and never appear as agents", async () => {
    const agentId = "r-message-ledger";
    await saveAgentState(createAgentState({
      agentId,
      task: "message ledger",
      part: "p",
      projectId: "p1",
    }));
    await saveMessageIdempotencyRecords(agentId, {
      "message-key": {
        fingerprint: "a".repeat(64),
        state: "completed",
        status: 200,
        body: { accepted: true, status: "running" },
        createdAt: "2026-08-21T00:00:00.000Z",
      },
    });

    expect(await loadMessageIdempotencyRecords(agentId)).toEqual({
      "message-key": {
        fingerprint: "a".repeat(64),
        state: "completed",
        status: 200,
        body: { accepted: true, status: "running" },
        createdAt: "2026-08-21T00:00:00.000Z",
      },
    });
    expect((await listAgents()).filter((id) => id.includes("message-ledger"))).toEqual([agentId]);
    await deleteAgent(agentId);
    expect(await loadMessageIdempotencyRecords(agentId)).toEqual({});
  });

  test("legacy v1 message records without state load as completed", async () => {
    const agentId = "r-message-ledger-v1";
    const path = agentMessageIdempotencyPath(agentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      schema: "runtime-message-idempotency.v1",
      records: {
        "legacy-key": {
          fingerprint: "b".repeat(64),
          status: 200,
          body: { accepted: true, status: "running" },
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    }), "utf8");

    expect(await loadMessageIdempotencyRecords(agentId)).toEqual({
      "legacy-key": {
        fingerprint: "b".repeat(64),
        state: "completed",
        status: 200,
        body: { accepted: true, status: "running" },
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    });
    await deleteAgent(agentId);
  });

  test("deleteAgent is no-op for non-existent", async () => {
    await deleteAgent("does-not-exist"); // should not throw
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

describe("agent-state functional updates", () => {
  const base: AgentState = createAgentState({ agentId: "r1", task: "t", part: "p", projectId: "p1" });

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
