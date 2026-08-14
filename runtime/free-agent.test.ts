/**
 * Synthia Runtime — free-agent governance tests (spec 001-agent-freedom, batch 1).
 *
 * Covers the four contract items:
 *  1. Gate tools + post-submit system-level lock (hard-block at tool-exec layer).
 *  2. vivado_run job tool (normal / failure / fail-closed).
 *  3. Content-conformity hook blocking off-topic gate submissions.
 *  4. Lock persistence across restart.
 *
 * Plus the baseline free-agent behaviors (idle chat → 0 tool calls; skill chain →
 * candidate registration). Uses a scripted ConversationalModel, MockGovernanceClient
 * (deterministic ids), and FakeVivadoConnector from the existing test doubles.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFreeAgentSession, loadFreeAgentConversation } from "./free-agent.ts";
import { assembleSkillTools } from "./skill-tools.ts";
import { assembleGateTools } from "./gate-tools.ts";
import { assembleVivadoTool } from "./vivado-tool.ts";
import { checkGateConformity, extractTopModule } from "./conformity.ts";
import { MockGovernanceClient } from "./governance-client.ts";
import {
  FakeVivadoConnector,
  successBehavior,
  alwaysFailBehavior,
  unsupportedBehavior,
} from "./loop.ts";
import { loadRunState } from "./run-state.ts";
import type {
  AgentMessage,
  ChatTurn,
  ConversationalModel,
} from "./agent-types.ts";
import type { GovernanceClient, LoopConnector } from "./types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A ConversationalModel that plays back a fixed sequence of ChatTurns. */
class ScriptedModel implements ConversationalModel {
  private readonly turns: readonly ChatTurn[];
  private idx = 0;
  readonly calls: { messages: readonly AgentMessage[]; toolCount: number }[] = [];

  constructor(turns: readonly ChatTurn[]) {
    this.turns = turns;
  }

  async chat(messages: readonly AgentMessage[], tools: readonly { name: string }[]): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], toolCount: tools.length });
    return this.turns[this.idx++] ?? { kind: "text", content: "(script exhausted)" };
  }
}

/** Build a tool_calls turn with a single call. */
function call(toolCallId: string, name: string, args: unknown): ChatTurn {
  return { kind: "tool_calls", calls: [{ toolCallId, name, args }], content: null };
}

/** Build a text turn. */
function txt(content: string): ChatTurn {
  return { kind: "text", content };
}

/** Extract the tool-result content for a given toolCallId from captured calls. */
function toolResultFor(model: ScriptedModel, toolCallId: string): string | undefined {
  for (const c of model.calls) {
    for (const m of c.messages) {
      if (m.role === "tool" && m.toolCallId === toolCallId) return m.content;
    }
  }
  return undefined;
}

function parseJSON(s: string | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Isolation: temp runs dir
// ---------------------------------------------------------------------------

let runsDir: string;
let idCounter = 0;

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "synthia-free-agent-test-"));
  process.env.SYNTHIA_RUNS_DIR = runsDir;
});

afterAll(async () => {
  delete process.env.SYNTHIA_RUNS_DIR;
  await rm(runsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

function makeSession(opts: {
  model: ConversationalModel;
  governance?: GovernanceClient;
  connector?: LoopConnector | null;
  initialGateLock?: { gate: "G1" | "G2" | "G3" | "G4"; submissionId: string };
  processInstanceId?: string;
}) {
  const runId = `run-fa-test-${++idCounter}`;
  const session = createFreeAgentSession(runId, {
    model: opts.model,
    tools: [...assembleSkillTools(), ...assembleGateTools(), assembleVivadoTool()],
    systemPrompt: "test system prompt",
    projectId: "proj-test",
    part: "xc7a100tcsg324-1",
    classification: "internal",
    governance: opts.governance ?? new MockGovernanceClient(),
    connector: opts.connector ?? null,
    ...(opts.processInstanceId ? { processInstanceId: opts.processInstanceId } : {}),
    ...(opts.initialGateLock ? { initialGateLock: opts.initialGateLock } : {}),
    runsDir,
  });
  return { session, runId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("free-agent: idle chat (zero tool calls)", () => {
  test("pure chat produces no tool calls and returns natural-language text", async () => {
    const model = new ScriptedModel([txt("你好！我是 Synthia，可以帮你推进 FPGA 项目或闲聊。")]);
    const { session } = makeSession({ model });

    const reply = await session.prompt("你好，你现在能做什么？");

    expect(reply).toBe("你好！我是 Synthia，可以帮你推进 FPGA 项目或闲聊。");
    expect(model.calls).toHaveLength(1);
    expect(session.status()).toBe("idle");
  });
});

describe("free-agent: skill chain + candidate registration", () => {
  test("skill tool registers a candidate artifact via governance", async () => {
    const gov = new MockGovernanceClient();
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", {
        content: "# UART Transmitter 需求梳理\n任务：设计一个 UART 发射器...",
        filename: "doc/intake/summary.md",
      }),
      txt("已登记 intake 候选制品。"),
    ]);
    const { session } = makeSession({ model, governance: gov });

    const reply = await session.prompt("帮我梳理一下 UART 的需求");

    expect(reply).toBe("已登记 intake 候选制品。");
    expect(gov.registeredArtifacts).toHaveLength(1);
    expect(gov.registeredArtifacts[0]!.artifactType).toBe("DEVELOPMENT_REQUIREMENTS");
    expect(gov.registeredArtifacts[0]!.revisionId).toBe("rev-mock-1");
    expect(session.status()).toBe("idle");
  });

  test("two-skill chain registers two distinct candidate artifacts", async () => {
    const gov = new MockGovernanceClient();
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", {
        content: "# UART Transmitter\nDesign a uart transmitter module.",
        filename: "doc/intake/summary.md",
      }),
      call("tc2", "fpga-architecture", {
        content: "# Architecture\nuart transmitter interface contract with clk and tx pins.",
        filename: "doc/arch/interface_contract.yaml",
      }),
      txt("已完成 intake 与架构设计候选。"),
    ]);
    const { session } = makeSession({ model, governance: gov });

    await session.prompt("推进到架构设计");

    expect(gov.registeredArtifacts).toHaveLength(2);
    expect(gov.registeredArtifacts[0]!.artifactType).toBe("DEVELOPMENT_REQUIREMENTS");
    expect(gov.registeredArtifacts[1]!.artifactType).toBe("ARCHITECTURE_DESIGN");
  });
});

describe("free-agent: gate submission + system-level lock", () => {
  test("core_submit_gate locks the session; skill tools are hard-blocked", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", { content: "UART transmitter requirement", filename: "doc/intake/summary.md" }),
      call("tc2", "core_create_snapshot", { member_revision_ids: ["rev-mock-1"] }),
      call("tc3", "core_submit_gate", { gate: "G1", snapshot_id: "snap-mock-2" }),
      // While locked: a skill tool is hard-blocked at the execution layer.
      call("tc4", "fpga-architecture", { content: "arch doc", filename: "doc/arch/x.yaml" }),
      txt("等待 G1 批准中。"),
    ]);
    const { session } = makeSession({ model, governance: gov });

    const reply = await session.prompt("推进到 G1 并提交审阅");

    expect(reply).toBe("等待 G1 批准中。");
    expect(session.status()).toBe("awaiting_approval");

    // The submit_gate succeeded and locked.
    const submitResult = parseJSON(toolResultFor(model, "tc3"));
    expect(submitResult!.submissionId).toBe("sub-mock-3");
    expect(submitResult!.state).toBe("in_review");
    expect(submitResult!.locked).toBe(true);

    // The skill tool was hard-blocked (NOT executed).
    const blockedResult = parseJSON(toolResultFor(model, "tc4"));
    expect(blockedResult!.error).toBe("gate_locked");
    expect(gov.registeredArtifacts).toHaveLength(1); // only intake, arch was blocked
  });

  test("core_check_gate approved unlocks the session; skill tools resume", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    // getGateSubmissionState defaults to "approved" when not pre-set.
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", { content: "UART requirement", filename: "doc/intake/summary.md" }),
      call("tc2", "core_create_snapshot", { member_revision_ids: ["rev-mock-1"] }),
      call("tc3", "core_submit_gate", { gate: "G1", snapshot_id: "snap-mock-2" }),
      call("tc4", "core_check_gate", { submission_id: "sub-mock-3" }),
      // After unlock: a skill tool succeeds.
      call("tc5", "fpga-architecture", {
        content: "uart arch interface",
        filename: "doc/arch/interface_contract.yaml",
      }),
      txt("G1 已批准，继续推进。"),
    ]);
    const { session } = makeSession({ model, governance: gov });

    await session.prompt("提交 G1，然后查询并继续");

    const checkResult = parseJSON(toolResultFor(model, "tc4"));
    expect(checkResult!.state).toBe("approved");
    expect(checkResult!.locked).toBe(false);

    // Architecture tool succeeded after unlock → 2 artifacts registered.
    expect(gov.registeredArtifacts).toHaveLength(2);
    expect(gov.registeredArtifacts[1]!.artifactType).toBe("ARCHITECTURE_DESIGN");
    expect(session.status()).toBe("idle");
  });

  test("core_check_gate rejected keeps the session locked", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    gov.setGateState("sub-mock-3", "rejected");
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", { content: "requirement", filename: "doc/intake/summary.md" }),
      call("tc2", "core_create_snapshot", { member_revision_ids: ["rev-mock-1"] }),
      call("tc3", "core_submit_gate", { gate: "G1", snapshot_id: "snap-mock-2" }),
      call("tc4", "core_check_gate", { submission_id: "sub-mock-3" }),
      // Still locked: skill tool blocked.
      call("tc5", "fpga-architecture", { content: "arch", filename: "doc/arch/x.yaml" }),
      txt("G1 被驳回，保持锁定。"),
    ]);
    const { session } = makeSession({ model, governance: gov });

    await session.prompt("提交 G1 并查询");

    const checkResult = parseJSON(toolResultFor(model, "tc4"));
    expect(checkResult!.state).toBe("rejected");
    expect(checkResult!.locked).toBe(true);

    const blocked = parseJSON(toolResultFor(model, "tc5"));
    expect(blocked!.error).toBe("gate_locked");
    expect(session.status()).toBe("awaiting_approval");
  });

  test("while locked, vivado_run is also hard-blocked", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", { content: "req", filename: "doc/intake/summary.md" }),
      call("tc2", "core_create_snapshot", { member_revision_ids: ["rev-mock-1"] }),
      call("tc3", "core_submit_gate", { gate: "G1", snapshot_id: "snap-mock-2" }),
      call("tc4", "vivado_run", {
        operation: "validate_sources",
        sources: [{ path: "rtl/x.v", content: "module x(); endmodule" }],
        top: "x",
      }),
      txt("locked, vivado blocked."),
    ]);
    const { session } = makeSession({ model, governance: gov, connector });

    await session.prompt("submit then try vivado");

    const blocked = parseJSON(toolResultFor(model, "tc4"));
    expect(blocked!.error).toBe("gate_locked");
    // Connector was never called.
    expect(connector.callCount("validate_sources")).toBe(0);
    expect(session.status()).toBe("awaiting_approval");
  });
});

describe("free-agent: vivado_run job tool", () => {
  test("succeeds and returns terminal state + evidence list", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new ScriptedModel([
      call("tc1", "vivado_run", {
        operation: "validate_sources",
        sources: [{ path: "rtl/counter.v", content: "module counter(input clk, output [7:0] q); assign q=0; endmodule" }],
        top: "counter",
      }),
      txt("validation succeeded."),
    ]);
    const { session } = makeSession({ model, connector });

    await session.prompt("validate the RTL");

    const result = parseJSON(toolResultFor(model, "tc1"));
    expect(result!.state).toBe("succeeded");
    expect(result!.operation).toBe("validate_sources");
    expect(result!.top).toBe("counter");
    expect(Array.isArray(result!.evidence)).toBe(true);
    expect(result!.jobId).toBeTruthy();
    expect(connector.callCount("validate_sources")).toBe(1);
  });

  test("simulation failure returns errorCode + diagnostics (not fail-closed)", async () => {
    const connector = new FakeVivadoConnector({ behavior: alwaysFailBehavior("simulate") });
    const model = new ScriptedModel([
      call("tc1", "vivado_run", {
        operation: "simulate",
        sources: [{ path: "rtl/c.v", content: "module c(); endmodule" }],
        top: "c",
        testbench: "tb_c",
      }),
      txt("simulation failed, need repair."),
    ]);
    const { session } = makeSession({ model, connector });

    await session.prompt("run simulation");

    const result = parseJSON(toolResultFor(model, "tc1"));
    expect(result!.state).toBe("failed");
    expect(result!.errorCode).toBe("VIVADO_SIMULATION_FAILED");
    expect(result!.stderr).toBeTruthy();
    // Not fail-closed — the model can attempt a repair.
    expect(result!.failClosed).toBeUndefined();
  });

  test("unsupported capability is fail-closed (isError)", async () => {
    const connector = new FakeVivadoConnector({ behavior: unsupportedBehavior() });
    const model = new ScriptedModel([
      call("tc1", "vivado_run", {
        operation: "validate_sources",
        sources: [{ path: "rtl/x.v", content: "module x(); endmodule" }],
        top: "x",
      }),
      txt("fail-closed: binary unavailable."),
    ]);
    const { session } = makeSession({ model, connector });

    await session.prompt("validate");

    const result = parseJSON(toolResultFor(model, "tc1"));
    expect(result!.failClosed).toBe(true);
    expect(result!.errorCode).toBe("BINARY_UNAVAILABLE");
  });

  test("capability drift is fail-closed at the permission gate", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior(), drift: true });
    const model = new ScriptedModel([
      call("tc1", "vivado_run", {
        operation: "synthesize",
        sources: [{ path: "rtl/x.v", content: "module x(); endmodule" }],
        top: "x",
      }),
      txt("drift fail-closed."),
    ]);
    const { session } = makeSession({ model, connector });

    await session.prompt("synthesize");

    const result = parseJSON(toolResultFor(model, "tc1"));
    expect(result!.error).toBe("permission_denied");
    expect(result!.failClosed).toBe(true);
    expect(connector.callCount("synthesize")).toBe(0);
  });

  test("no connector → fail-closed error", async () => {
    const model = new ScriptedModel([
      call("tc1", "vivado_run", {
        operation: "validate_sources",
        sources: [{ path: "rtl/x.v", content: "module x(); endmodule" }],
        top: "x",
      }),
      txt("no connector."),
    ]);
    const { session } = makeSession({ model, connector: null });

    await session.prompt("validate");

    const result = parseJSON(toolResultFor(model, "tc1"));
    expect(result!.error).toBe("no_connector");
  });
});

describe("free-agent: content-conformity gate", () => {
  test("G3 submission with off-topic architecture doc is blocked with diff detail", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const model = new ScriptedModel([
      // Intake: authoritative keyword source — mentions "uart transmitter".
      call("tc1", "fpga-intake", {
        content: "Design a UART transmitter for serial communication at 115200 baud.",
        filename: "doc/intake/summary.md",
      }),
      // Architecture: OFF-TOPIC — mentions none of the task keywords.
      call("tc2", "fpga-architecture", {
        content: "This document describes a cooking recipe for chocolate cake with flour and sugar.",
        filename: "doc/arch/interface_contract.yaml",
      }),
      call("tc3", "core_create_snapshot", { member_revision_ids: ["rev-mock-1", "rev-mock-2"] }),
      call("tc4", "core_submit_gate", { gate: "G3", snapshot_id: "snap-mock-3" }),
      txt("conformity failed; need to rewrite architecture."),
    ]);
    const { session } = makeSession({ model, governance: gov });

    await session.prompt("推进到 G3");

    const result = parseJSON(toolResultFor(model, "tc4"));
    expect(result!.error).toBe("content_conformity_failed");
    expect(result!.gate).toBe("G3");
    expect(Array.isArray(result!.problems)).toBe(true);
    expect(result!.problems.length).toBeGreaterThan(0);
    // No submission created (conformity blocked before createGateSubmission).
    expect(gov.submissions).toHaveLength(0);
    expect(session.status()).toBe("idle"); // not locked
  });

  test("G3 submission with on-topic architecture doc passes conformity", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const model = new ScriptedModel([
      call("tc1", "fpga-intake", {
        content: "Design a UART transmitter for serial communication.",
        filename: "doc/intake/summary.md",
      }),
      call("tc2", "fpga-architecture", {
        content: "UART transmitter architecture: tx_data, clk, tx output port interface contract.",
        filename: "doc/arch/interface_contract.yaml",
      }),
      call("tc3", "core_create_snapshot", { member_revision_ids: ["rev-mock-1", "rev-mock-2"] }),
      call("tc4", "core_submit_gate", { gate: "G3", snapshot_id: "snap-mock-3" }),
      txt("G3 submitted."),
    ]);
    const { session } = makeSession({ model, governance: gov });

    await session.prompt("推进到 G3");

    const result = parseJSON(toolResultFor(model, "tc4"));
    expect(result!.submissionId).toBe("sub-mock-4");
    expect(result!.locked).toBe(true);
    expect(gov.submissions).toHaveLength(1);
    expect(session.status()).toBe("awaiting_approval");
  });
});

describe("free-agent: lock persistence across restart", () => {
  test("locked run-state is restored on session reconstruction", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const modelA = new ScriptedModel([
      call("tc1", "fpga-intake", { content: "req", filename: "doc/intake/summary.md" }),
      call("tc2", "core_create_snapshot", { member_revision_ids: ["rev-mock-1"] }),
      call("tc3", "core_submit_gate", { gate: "G2", snapshot_id: "snap-mock-2" }),
      txt("submitted, awaiting approval."),
    ]);
    const { session: sessionA, runId } = makeSession({ model: modelA, governance: gov });

    await sessionA.prompt("submit to G2");
    expect(sessionA.status()).toBe("awaiting_approval");

    // The persisted run-state carries the lock.
    const state = await loadRunState(runId);
    expect(state.freeAgentLock).toBeDefined();
    expect(state.freeAgentLock!.gate).toBe("G2");
    expect(state.freeAgentLock!.submissionId).toBe("sub-mock-3");

    // Simulate restart: reconstruct the session with the persisted lock.
    const govB = new MockGovernanceClient();
    const modelB = new ScriptedModel([
      // While restored-locked: a skill tool is hard-blocked.
      call("tc1", "fpga-intake", { content: "req", filename: "doc/intake/summary.md" }),
      txt("still locked after restart."),
    ]);
    const { session: sessionB } = makeSession({
      model: modelB,
      governance: govB,
      initialGateLock: { gate: "G2", submissionId: "sub-mock-3" },
    });

    expect(sessionB.status()).toBe("awaiting_approval");

    await sessionB.prompt("continue");

    // Skill tool was hard-blocked despite the fresh session — lock persisted.
    const blocked = parseJSON(toolResultFor(modelB, "tc1"));
    expect(blocked!.error).toBe("gate_locked");
    expect(govB.registeredArtifacts).toHaveLength(0);
  });

  test("conversation sidecar is persisted for resume", async () => {
    const gov = new MockGovernanceClient();
    const model = new ScriptedModel([txt("persisted reply")]);
    const { session, runId } = makeSession({ model, governance: gov });
    await session.prompt("test message");
    const convo = await loadFreeAgentConversation(runId);
    expect(convo).not.toBeNull();
    expect(convo!.messages.length).toBeGreaterThan(0);
    expect(convo!.messages[0]!.role).toBe("system");
  });
});

describe("free-agent: conformity module unit checks", () => {
  test("extractTopModule prefers location-matched module name", () => {
    const content = "module foo(); endmodule\nmodule uart_tx(input clk, output tx); endmodule";
    expect(extractTopModule(content, "rtl/uart_tx.v")).toBe("uart_tx");
  });

  test("checkGateConformity G3 flags off-topic design doc", () => {
    const result = checkGateConformity(
      "G3",
      [
        { artifactType: "ARCHITECTURE_DESIGN", content: "cooking recipe with flour", contentLocation: "doc/arch/x.yaml", title: "arch" },
      ],
      ["uart transmitter serial"],
    );
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]).toContain("topic");
  });

  test("checkGateConformity G3 passes on-topic design doc", () => {
    const result = checkGateConformity(
      "G3",
      [
        { artifactType: "ARCHITECTURE_DESIGN", content: "uart transmitter interface", contentLocation: "doc/arch/x.yaml", title: "arch" },
      ],
      ["uart transmitter"],
    );
    expect(result.ok).toBe(true);
  });

  test("checkGateConformity G4 flags missing top module name + ports in design doc", () => {
    const rtl = "module uart_tx(input clk, output tx, input [7:0] data); endmodule";
    const result = checkGateConformity(
      "G4",
      [
        { artifactType: "RTL_SOURCE_SET", content: rtl, contentLocation: "rtl/uart_tx.v", title: "rtl" },
        { artifactType: "ARCHITECTURE_DESIGN", content: "uart design without the module name", contentLocation: "doc/arch/x.yaml", title: "arch" },
      ],
      ["uart"],
    );
    expect(result.ok).toBe(false);
    // Name + port problems (top module + ports not in arch doc).
    expect(result.problems.some((p) => p.startsWith("name:"))).toBe(true);
    expect(result.problems.some((p) => p.startsWith("port:"))).toBe(true);
  });

  test("checkGateConformity skips non-G3/G4 gates", () => {
    const result = checkGateConformity("G1", [], []);
    expect(result.ok).toBe(true);
  });
});
