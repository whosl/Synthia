import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  RuntimeServer,
  type ServerConfig,
  type DepsFactory,
  type ServerStatus,
} from "./server.ts";
import { CounterScriptedModel } from "./deps.ts";
import { FakeVivadoConnector, successBehavior, alwaysFailBehavior } from "./loop.ts";
import { MockGovernanceClient } from "./governance-client.ts";
import { NoGovernanceClient } from "./types.ts";
import { createRunState, saveRunState, deleteRun } from "./run-state.ts";
import type { SkillPrompts } from "./skill-loader.ts";
import type { GateSubmissionState } from "../core/src/domain/enums.ts";

// ---------------------------------------------------------------------------
// Test governance — defaults to in_review so the monitor doesn't prematurely
// auto-resume before the test explicitly approves a gate.
// ---------------------------------------------------------------------------

class TestGovernance extends MockGovernanceClient {
  private defaultPollState: GateSubmissionState = "in_review";

  setDefaultPollState(state: GateSubmissionState): void {
    this.defaultPollState = state;
  }

  override async getGateSubmissionState(
    submissionId: string,
  ): Promise<{ state: GateSubmissionState }> {
    this.polledGates.push(submissionId);
    const state = this.gateStates.get(submissionId) ?? this.defaultPollState;
    return { state };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_PROMPTS: SkillPrompts = {
  rtl: "", tb: "", xdc: "", repair: "",
  intake: "", behaviorWave: "", architecture: "", registerSpec: "",
};

function makeConfig(opts: Partial<ServerConfig> = {}): ServerConfig {
  return {
    skillPrompts: EMPTY_PROMPTS,
    toolModelPolicyHash: "test-policy-v1",
    defaultPart: "xc7k70tfbv676-1",
    gatePollMs: 50,
    port: 0,
    ...opts,
  };
}

function makeFactory(
  model: unknown,
  connector: unknown,
  governance: unknown,
): DepsFactory {
  return async () => ({ model, connector, governance } as any);
}

async function postTask(
  server: RuntimeServer,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${server.url}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const json = await res.json() as { run_id: string };
  return json.run_id;
}

async function getTask(
  server: RuntimeServer,
  runId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.url}/tasks/${runId}`);
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

async function waitForStatus(
  server: RuntimeServer,
  runId: string,
  statuses: ServerStatus[],
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getTask(server, runId);
    if (statuses.includes(body.status as ServerStatus)) return body;
    await Bun.sleep(30);
  }
  throw new Error(
    `timeout waiting for status ${statuses.join("|")} (run ${runId})`,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let runsDir: string;
const createdRunIds: string[] = [];

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "synthia-runtime-test-"));
  process.env.SYNTHIA_RUNS_DIR = runsDir;
});

afterAll(async () => {
  for (const runId of createdRunIds) {
    await deleteRun(runId).catch(() => {});
  }
  delete process.env.SYNTHIA_RUNS_DIR;
  await rm(runsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RuntimeServer — POST /tasks + full chain", () => {
  test("auto-approve (no-governance) run completes the full stage chain", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p1",
        process_instance_id: "pi-test",
        task: "8位计数器",
      });
      createdRunIds.push(runId);
      expect(runId).toMatch(/^run-/);

      const body = await waitForStatus(server, runId, ["succeeded"]);
      expect(body["status"]).toBe("succeeded");
      expect(body["project_id"]).toBe("p1");
      expect(body["task"]).toBe("8位计数器");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — GET /tasks/:runId detail fields", () => {
  test("response includes all required fields with correct shapes", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p1",
        process_instance_id: "pi-detail",
        task: "详细字段测试",
      });
      createdRunIds.push(runId);

      const body = await waitForStatus(server, runId, ["succeeded"]);

      // Required fields
      expect(body["run_id"]).toBe(runId);
      expect(body["project_id"]).toBe("p1");
      expect(body["task"]).toBe("详细字段测试");
      expect(body["status"]).toBe("succeeded");
      expect(typeof body["current_stage"]).toBe("string");
      expect(body["awaiting_gate"]).toBeNull();
      expect(Array.isArray(body["audit"])).toBe(true);
      expect(Array.isArray(body["evidence"])).toBe(true);

      // docs entries: {phase, path, artifact_id, revision_id}
      const docs = body["docs"] as Record<string, unknown>[];
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(typeof doc["phase"]).toBe("string");
        expect(typeof doc["path"]).toBe("string");
        expect(typeof doc["artifact_id"]).toBe("string");
        expect(typeof doc["revision_id"]).toBe("string");
      }

      // audit capped at 50
      expect((body["audit"] as unknown[]).length).toBeLessThanOrEqual(50);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — GET /tasks list", () => {
  test("lists all runs with summary fields", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p-list",
        process_instance_id: "pi-list",
        task: "列表测试",
      });
      createdRunIds.push(runId);
      await waitForStatus(server, runId, ["succeeded"]);

      const res = await fetch(`${server.url}/tasks`);
      expect(res.status).toBe(200);
      const body = await res.json() as { runs: Record<string, unknown>[] };
      expect(body.runs.length).toBeGreaterThanOrEqual(1);

      const ourRun = body.runs.find((r) => r.run_id === runId);
      expect(ourRun).toBeDefined();
      expect(ourRun!["project_id"]).toBe("p-list");
      expect(ourRun!["status"]).toBe("succeeded");
      expect(typeof ourRun!["current_stage"]).toBe("string");
      expect(typeof ourRun!["created_at"]).toBe("string");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — approval auto-resume monitor", () => {
  test("awaiting_approval → approved → auto-resume → succeeded", async () => {
    const gov = new TestGovernance();
    gov.setSubmitResult("in_review"); // gates pause

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 50 }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p-gate",
        process_instance_id: "pi-gate",
        task: "门禁流程测试",
      });
      createdRunIds.push(runId);

      // Wait for G1 pause
      await waitForStatus(server, runId, ["awaiting_approval"]);

      // Approve G1; make subsequent gates auto-approve
      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "approved");
      gov.setSubmitResult("approved");

      // Monitor auto-resumes → full chain completes
      await waitForStatus(server, runId, ["succeeded"], 20_000);
    } finally {
      await server.stop();
    }
  });

  test("rejected gate → fail_closed terminal", async () => {
    const gov = new TestGovernance();
    gov.setSubmitResult("in_review");

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 50 }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p-reject",
        process_instance_id: "pi-reject",
        task: "拒绝测试",
      });
      createdRunIds.push(runId);

      await waitForStatus(server, runId, ["awaiting_approval"]);

      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "rejected");

      // Monitor detects rejection → fail_closed
      const body = await waitForStatus(server, runId, ["fail_closed"]);
      expect(body["reason"]).toContain("rejected");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — parallel runs", () => {
  test("two runs execute concurrently and both succeed", async () => {
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId1 = await postTask(server, {
        project_id: "p-par",
        process_instance_id: "pi-par-1",
        task: "并行任务A",
      });
      createdRunIds.push(runId1);

      const runId2 = await postTask(server, {
        project_id: "p-par",
        process_instance_id: "pi-par-2",
        task: "并行任务B",
      });
      createdRunIds.push(runId2);

      // Both should succeed independently
      await waitForStatus(server, runId1, ["succeeded"], 15_000);
      await waitForStatus(server, runId2, ["succeeded"], 15_000);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — restart recovery", () => {
  test("running run on disk is recovered as interrupted", async () => {
    // Seed a run-state file with status "running" on disk.
    const seedRunId = "run-test-recovery-001";
    const seedState = createRunState({
      runId: seedRunId,
      task: "恢复测试",
      part: "xc7k70tfbv676-1",
      projectId: "p-recover",
      processInstanceId: "pi-recover",
    });
    await saveRunState(seedState);
    createdRunIds.push(seedRunId);

    // Start a fresh server — recover() picks up the run.
    const gov = new NoGovernanceClient();
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      // The run should be listed with status "interrupted".
      const body = await getTask(server, seedRunId);
      expect(body["status"]).toBe("interrupted");
      expect(body["run_id"]).toBe(seedRunId);
      expect(body["reason"]).toContain("interrupted");

      // Also visible in the list.
      const listRes = await fetch(`${server.url}/tasks`);
      const listBody = await listRes.json() as { runs: Record<string, unknown>[] };
      const recovered = listBody.runs.find((r) => r.run_id === seedRunId);
      expect(recovered).toBeDefined();
      expect(recovered!["status"]).toBe("interrupted");
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — resume endpoint", () => {
  test("POST /tasks/:runId/resume is idempotent", async () => {
    const gov = new TestGovernance();
    gov.setSubmitResult("in_review");

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 500 }), // slow monitor so manual resume is tested
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p-resume",
        process_instance_id: "pi-resume",
        task: "续跑幂等测试",
      });
      createdRunIds.push(runId);

      await waitForStatus(server, runId, ["awaiting_approval"]);

      // Multiple resume calls should all return {resumed:true}
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${server.url}/tasks/${runId}/resume`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { resumed: boolean };
        expect(body.resumed).toBe(true);
      }

      // Approve and let monitor auto-resume to completion
      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "approved");
      gov.setSubmitResult("approved");

      await waitForStatus(server, runId, ["succeeded"], 20_000);
    } finally {
      await server.stop();
    }
  });

  test("resume returns 404 for unknown run", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks/run-nonexistent/resume`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — error handling", () => {
  test("GET /tasks/:runId returns 404 for unknown run", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks/run-does-not-exist`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    } finally {
      await server.stop();
    }
  });

  test("POST /tasks returns 400 when task is missing", async () => {
    const server = new RuntimeServer(
      makeConfig(),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        new NoGovernanceClient(),
      ),
    );
    await server.start();
    try {
      const res = await fetch(`${server.url}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: "p1", process_instance_id: "pi1" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

describe("RuntimeServer — resume from execution failure", () => {
  test("infra fail_closed → resume → succeeds from breakpoint stage", async () => {
    // Use no-governance (auto-approve) so the run reaches tool stages.
    // The connector always fails synthesize → fail_closed (execution_error).
    const gov = new NoGovernanceClient();
    const failConnector = new FakeVivadoConnector({
      behavior: alwaysFailBehavior("synthesize"),
    });
    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 10_000 }), // slow monitor, no interference
      makeFactory(new CounterScriptedModel(), failConnector, gov),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p-infra",
        process_instance_id: "pi-infra",
        task: "基础设施故障恢复测试",
      });
      createdRunIds.push(runId);

      // Run should fail_closed due to synthesize always failing.
      const failed = await waitForStatus(server, runId, ["fail_closed", "failed"]);
      expect(failed["status"]).toMatch(/fail_closed|failed/);
      expect(failed["terminal_cause"]).toBe("execution_error");

      // Now swap to a working connector via a new server instance sharing
      // the same runs dir. The failed run is recovered from disk, then
      // resume is called with a healthy connector.
      await server.stop();

      const okConnector = new FakeVivadoConnector({ behavior: successBehavior() });
      const server2 = new RuntimeServer(
        makeConfig({ gatePollMs: 10_000 }),
        makeFactory(new CounterScriptedModel(), okConnector, gov),
      );
      await server2.start();
      try {
        // The recovered run should be fail_closed (not interrupted — it was
        // already terminal on disk).
        const recovered = await getTask(server2, runId);
        expect(recovered["status"]).toMatch(/fail_closed|failed/);
        expect(recovered["terminal_cause"]).toBe("execution_error");

        // Resume should be accepted (not 409).
        const resumeRes = await fetch(`${server2.url}/tasks/${runId}/resume`, {
          method: "POST",
        });
        expect(resumeRes.status).toBe(200);
        const resumeBody = await resumeRes.json() as { resumed: boolean };
        expect(resumeBody.resumed).toBe(true);

        // Run should now succeed with the healthy connector.
        const succeeded = await waitForStatus(server2, runId, ["succeeded"], 20_000);
        expect(succeeded["status"]).toBe("succeeded");
      } finally {
        await server2.stop();
      }
    } finally {
      // server may already be stopped
      await server.reset().catch(() => {});
    }
  });

  test("gate rejected → resume returns 409 and does not execute", async () => {
    const gov = new TestGovernance();
    gov.setSubmitResult("in_review");

    const server = new RuntimeServer(
      makeConfig({ gatePollMs: 50 }),
      makeFactory(
        new CounterScriptedModel(),
        new FakeVivadoConnector({ behavior: successBehavior() }),
        gov,
      ),
    );
    await server.start();
    try {
      const runId = await postTask(server, {
        project_id: "p-gate-rej",
        process_instance_id: "pi-gate-rej",
        task: "门禁拒绝不可恢复测试",
      });
      createdRunIds.push(runId);

      // Wait for G1 pause.
      await waitForStatus(server, runId, ["awaiting_approval"]);

      // Reject G1 → monitor detects → fail_closed with governance_rejected.
      const g1Sub = gov.submissions[gov.submissions.length - 1]!.submissionId;
      gov.setGateState(g1Sub, "rejected");

      const rejected = await waitForStatus(server, runId, ["fail_closed"]);
      expect(rejected["terminal_cause"]).toBe("governance_rejected");

      // POST resume → 409 not_resumable.
      const resumeRes = await fetch(`${server.url}/tasks/${runId}/resume`, {
        method: "POST",
      });
      expect(resumeRes.status).toBe(409);
      const body = await resumeRes.json() as { error: { code: string } };
      expect(body.error.code).toBe("not_resumable");

      // Status should remain fail_closed (resume did not trigger execution).
      const stillRejected = await getTask(server, runId);
      expect(stillRejected["status"]).toBe("fail_closed");
      expect(stillRejected["terminal_cause"]).toBe("governance_rejected");
    } finally {
      await server.stop();
    }
  });
});
