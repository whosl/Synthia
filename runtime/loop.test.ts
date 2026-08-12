import { describe, expect, test } from "bun:test";
import {
  LoopExecutor,
  FakeVivadoConnector,
  successBehavior,
  failOnceThenSucceedBehavior,
  alwaysFailBehavior,
  unsupportedBehavior,
  permissionGate,
  PermissionDeniedError,
  FailClosedError,
  VIVADO_CAPABILITY_VERSION,
  FAKE_CAPABILITIES,
} from "./loop.ts";
import { MockGovernanceClient } from "./governance-client.ts";
import { NoGovernanceClient } from "./types.ts";
import {
  ModelActionError,
  type ArtifactFile,
  type DocGeneration,
  type GovernanceClient,
  type LoopModel,
  type RtlGeneration,
  type RunState,
  type TbGeneration,
  type XdcGeneration,
  type RepairGeneration,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const RTL: ArtifactFile = { path: "counter.v", content: "module counter(input clk,input rst_n,output reg[7:0] c);always@(posedge clk)if(!rst_n)c<=0;else c<=c+1;endmodule\n" };
const TB: ArtifactFile = { path: "tb_counter.v", content: "module tb_counter;reg clk=0;reg rst_n=0;wire[7:0] c;counter d(.clk(clk),.rst_n(rst_n),.c(c));always #5 clk=~clk;initial begin rst_n=0;#20;rst_n=1;repeat(3)@(posedge clk);$display(\"PASS\");$finish;end endmodule\n" };
const XDC: ArtifactFile = { path: "synthia.xdc", content: "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]\nset_property SEVERITY {Warning} [get_drc_checks UCIO-1]\ncreate_clock -period 10 [get_ports clk]\n" };

const DOC_INTAKE: DocGeneration = { phase: "generate_intake", reasoning: "ok", docPath: "doc/intake/summary.md", content: "# Counter 需求梳理摘要\n## Task Summary\n8-bit counter.\n## Acceptance Criteria\nCounts up." };
const DOC_BEHAVIOR: DocGeneration = { phase: "generate_behavior_wave", reasoning: "ok", docPath: "doc/spec/behavior_spec.md", content: "# Behavior Spec\n## Rules\nR1: counter increments on clock." };
const DOC_ARCH: DocGeneration = { phase: "generate_architecture", reasoning: "ok", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\ncounter: top." };
const DOC_REG: DocGeneration = { phase: "generate_register_spec", reasoning: "ok", docPath: "doc/reg/register_map.md", content: "# Register Map\nNo registers for this design." };

/** A complete test model that produces all 8 phase outputs. */
class FullChainModel implements LoopModel {
  readonly repairs: Array<{ stderr: string; attempt: number }> = [];
  private repairResponse: RepairGeneration;

  constructor(opts: { repairResponse?: RepairGeneration } = {}) {
    this.repairResponse = opts.repairResponse ?? { phase: "repair", reasoning: "fixed", sources: [RTL], testbench: TB };
  }

  async generateIntake(): Promise<DocGeneration> { return DOC_INTAKE; }
  async generateBehaviorWave(): Promise<DocGeneration> { return DOC_BEHAVIOR; }
  async generateArchitecture(): Promise<DocGeneration> { return DOC_ARCH; }
  async generateRegisterSpec(): Promise<DocGeneration> { return DOC_REG; }
  async generateRtl(): Promise<RtlGeneration> { return { phase: "generate_rtl", reasoning: "ok", topModule: "counter", sources: [RTL] }; }
  async generateTestbench(): Promise<TbGeneration> { return { phase: "generate_testbench", reasoning: "ok", testbenchModule: "tb_counter", testbench: TB }; }
  async generateXdc(_top: string, _part: string, _sys: string, _allowPin: boolean): Promise<XdcGeneration> { return { phase: "generate_xdc", reasoning: "ok", constraints: [XDC] }; }
  async repair(input: { stderr: string; attempt: number }): Promise<RepairGeneration> {
    this.repairs.push({ stderr: input.stderr, attempt: input.attempt });
    return this.repairResponse;
  }
}

function makeLoop(
  model: LoopModel,
  connector: FakeVivadoConnector,
  opts: {
    maxRepairRounds?: number;
    governance?: GovernanceClient;
  } = {},
) {
  const governance = opts.governance ?? new NoGovernanceClient();
  return new LoopExecutor({
    model, connector, governance,
    skillPrompts: {
      rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill",
      intake: "intake-skill", behaviorWave: "behavior-skill", architecture: "arch-skill", registerSpec: "reg-skill",
    },
    part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
    toolModelPolicyHash: "policy-v1",
    maxRepairRounds: opts.maxRepairRounds,
  });
}

// ---------------------------------------------------------------------------
// Permission gate (unit)
// ---------------------------------------------------------------------------

describe("permissionGate", () => {
  const caps = FAKE_CAPABILITIES;
  test("allows whitelisted operation with matching capability", () => {
    expect(permissionGate("synthesize", false, caps)).toBe(VIVADO_CAPABILITY_VERSION);
    expect(permissionGate("implement", false, caps)).toBe(VIVADO_CAPABILITY_VERSION);
  });
  test("rejects non-whitelisted operation (e.g. raw report_drc / arbitrary tcl op)", () => {
    expect(() => permissionGate("report_drc", false, caps)).toThrow(PermissionDeniedError);
    expect(() => permissionGate("vivado_synthesize", false, caps)).toThrow(PermissionDeniedError);
    expect(() => permissionGate("exec_shell", false, caps)).toThrow(PermissionDeniedError);
  });
  test("fail-closed on capability drift", () => {
    expect(() => permissionGate("synthesize", true, caps)).toThrow(FailClosedError);
  });
  test("fail-closed when capability is not exposed", () => {
    expect(() => permissionGate("implement", false, caps.filter(c => c.operation !== "implement"))).toThrow(FailClosedError);
  });
});

// ---------------------------------------------------------------------------
// Loop scenarios — tool-level (NoGovernanceClient auto-approves all gates)
// ---------------------------------------------------------------------------

describe("LoopExecutor — tool scenarios (no-governance auto-approve)", () => {
  test("normal full flow: intake→…→implement succeeds, all stages run", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("实现一个 8 位计数器");
    expect(result.status).toBe("succeeded");
    expect(result.rtl?.topModule).toBe("counter");
    expect(result.testbench?.testbenchModule).toBe("tb_counter");
    expect(result.xdc?.constraints[0]?.path).toBe("synthia.xdc");
    expect(result.docs?.length).toBe(4);
    // exactly the four versioned operations, no repeats in the happy path
    expect(connector.callCount("validate_sources")).toBe(1);
    expect(connector.callCount("simulate")).toBe(1);
    expect(connector.callCount("synthesize")).toBe(1);
    expect(connector.callCount("implement")).toBe(1);
    expect(result.evidence.map(e => e.operation)).toEqual(["validate_sources", "simulate", "synthesize", "implement"]);
    expect(result.evidence.every(e => e.entries.length > 0)).toBe(true);
  });

  test("simulation failure → repair → re-validate → simulate succeeds", async () => {
    const connector = new FakeVivadoConnector({ behavior: failOnceThenSucceedBehavior("simulate", 1) });
    const model = new FullChainModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("succeeded");
    expect(connector.callCount("simulate")).toBe(2);
    expect(connector.callCount("validate_sources")).toBe(2);
    expect(model.repairs).toHaveLength(1);
    expect(model.repairs[0]!.stderr).toContain("undefined signal");
    expect(model.repairs[0]!.attempt).toBe(1);
  });

  test("repair budget exhausted (3) → fail-closed", async () => {
    const connector = new FakeVivadoConnector({ behavior: alwaysFailBehavior("simulate") });
    const model = new FullChainModel();
    const loop = makeLoop(model, connector, { maxRepairRounds: 3 });
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(connector.callCount("simulate")).toBe(4);
    expect(model.repairs).toHaveLength(3);
    expect(result.endedReason).toContain("repair budget");
    expect(connector.callCount("synthesize")).toBe(0);
    expect(connector.callCount("implement")).toBe(0);
  });

  test("capability drift detected → immediate fail-closed, no further tool calls", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior(), drift: true });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("drift");
    expect(connector.callCount("validate_sources")).toBe(0);
    expect(connector.callCount("simulate")).toBe(0);
  });

  test("mid-flight drift (flipped after validate) → fail-closed before simulate body", async () => {
    const connector = new FakeVivadoConnector({
      behavior: {
        respond: (req) => {
          if (req.operation === "validate_sources") connector.drift = true;
          return successBehavior().respond(req, 0);
        },
      },
    });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(connector.callCount("simulate")).toBe(0);
  });

  test("unsupported (BINARY_UNAVAILABLE) → immediate fail-closed, no retry", async () => {
    const connector = new FakeVivadoConnector({ behavior: unsupportedBehavior() });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("fail-closed");
    expect(connector.callCount("synthesize")).toBe(0);
  });

  test("capability not exposed for implement → fail-closed at implement gate", async () => {
    const caps = FAKE_CAPABILITIES.filter(c => c.operation !== "implement");
    const connector = new FakeVivadoConnector({ behavior: successBehavior(), capabilities: caps });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(connector.callCount("synthesize")).toBe(1);
    expect(connector.callCount("implement")).toBe(0);
    expect(result.endedReason).toContain("implement");
  });

  test("every tool call is audited with input hash + jobId; no raw tcl in audit", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    const toolAudits = result.audit.filter(a => a.category === "tool_call");
    expect(toolAudits.length).toBeGreaterThanOrEqual(4);
    for (const a of toolAudits) {
      expect(a.inputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.jobId).toBeTruthy();
    }
    expect(result.audit.some(a => /read_verilog|synth_design|write_bitstream|create_project|launch_simulation|exec\b|open_project/i.test(a.action))).toBe(false);
  });

  test("non-retryable simulate state (unknown_effect) → fail-closed without repair", async () => {
    const connector = new FakeVivadoConnector({
      behavior: {
        respond: (req) => ({
          status: "unknown_effect" as const, jobId: "job-unknown",
          operation: req.operation, inputSha256: "x",
          errorCode: "UNKNOWN_EFFECT", evidence: { jobId: "job-unknown", entries: [] },
        }),
      },
    });
    const model = new FullChainModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(model.repairs).toHaveLength(0);
  });

  test("implement failed → loop fail_closed (NOT succeeded)", async () => {
    const connector = new FakeVivadoConnector({
      behavior: {
        respond: (req) => {
          if (req.operation === "implement") {
            return {
              status: "failed" as const, jobId: `job-${req.operation}-impl-fail`,
              operation: req.operation, inputSha256: "x",
              stdout: "write_bitstream DRC error", stderr: "ERROR: [Drc 23-20] NSTD-1",
              errorCode: "VIVADO_DRC_FAILED",
              evidence: { jobId: "job-impl-fail", entries: [{ name: "synth.dcp", sha256: "a".repeat(64), sizeBytes: 100, mediaType: "application/octet-stream" }] },
            };
          }
          return successBehavior().respond(req, 0);
        },
      },
    });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("implement");
    expect(result.endedReason).toContain("non-success");
    expect(connector.callCount("implement")).toBe(1);
  });

  test("synthesize failed → loop fail_closed (implement not reached)", async () => {
    const connector = new FakeVivadoConnector({
      behavior: {
        respond: (req) => {
          if (req.operation === "synthesize") {
            return {
              status: "failed" as const, jobId: `job-${req.operation}-synth-fail`,
              operation: req.operation, inputSha256: "x",
              stderr: "ERROR: synth_design failed", errorCode: "VIVADO_SYNTH_FAILED",
              evidence: { jobId: "job-synth-fail", entries: [] },
            };
          }
          return successBehavior().respond(req, 0);
        },
      },
    });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("synthesize");
    expect(connector.callCount("synthesize")).toBe(1);
    expect(connector.callCount("implement")).toBe(0);
  });

  test("model validation failure (illegal file) → ModelActionError → audit records feedback", async () => {
    // Override generateRtl on the FullChainModel to throw a validation error
    const model = new FullChainModel();
    model.generateRtl = async () => {
      const e = new ModelActionError(
        `model produced no valid action for phase generate_rtl: sources.path "doc/spec/behavior_spec.md" must be one of: .v/.sv/.vh. Do NOT include documentation files`,
        "generate_rtl", 2,
      );
      (e as Error & { validationFeedbacks?: string[] }).validationFeedbacks = [
        'sources.path "doc/spec/behavior_spec.md" must be one of: .v/.sv/.vh. Do NOT include documentation files',
      ];
      throw e;
    };
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("failed");
    const feedbacks = result.audit.filter(a => a.action === "validation feedback");
    expect(feedbacks.length).toBeGreaterThanOrEqual(1);
    expect(feedbacks[0]!.detail).toContain(".v");
    expect(feedbacks[0]!.detail).toContain("documentation");
  });
});

// ---------------------------------------------------------------------------
// GJB gate flow — governance + awaiting_approval + resume
// ---------------------------------------------------------------------------

describe("LoopExecutor — GJB gate flow with governance", () => {
  test("G1: loop stops at G1 awaiting approval after intake", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review"); // submit lands in_review, not auto-approved
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });
    const result = await loop.run("计数器");
    // Loop should stop at G1 (awaiting approval)
    expect(result.awaitingGate).toBe("G1");
    expect(result.endedReason).toContain("awaiting");
    expect(result.endedReason).toContain("G1");
    // Only intake doc should have been generated and registered
    expect(gov.registeredArtifacts.length).toBe(1);
    expect(gov.registeredArtifacts[0]!.artifactType).toBe("DEVELOPMENT_REQUIREMENTS");
    // One gate submission created and submitted
    expect(gov.submissions.length).toBe(1);
    expect(gov.submittedGates.length).toBe(1);
    // No tool calls yet (tools only after G3)
    expect(connector.callCount("validate_sources")).toBe(0);
  });

  test("G2: resume from G1 → stops at G2 after behavior_wave", async () => {
    const gov = new MockGovernanceClient();
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });

    // Phase 1: run → stops at G1
    gov.setSubmitResult("in_review");
    const r1 = await loop.run("计数器", {
      runId: "test-run-1",
      runState: {
        runId: "test-run-1", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(r1.awaitingGate).toBe("G1");
    const g1SubmissionId = gov.submissions[0]!.submissionId;

    // Approve G1
    gov.setGateState(g1SubmissionId, "approved");

    // Phase 2: resume → runs behavior_wave → stops at G2
    const r2 = await loop.resume({
      runId: "test-run-1", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
      createdAt: r1.runId!, updatedAt: new Date().toISOString(),
      currentStage: "intake", status: "awaiting_approval", awaitingGate: "G1",
      docs: { intake: { revisionId: "rev-1", artifactId: "art-1", version: 1, contentHash: "h1" } },
      gateSubmissions: { G1: g1SubmissionId },
      gateDecisions: {},
    });
    expect(r2.awaitingGate).toBe("G2");
    expect(gov.registeredArtifacts.length).toBe(2); // intake + behavior_wave
  });

  test("G3: resume from G2 → runs architecture + register_spec → stops at G3", async () => {
    const gov = new MockGovernanceClient();
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });

    // G1 + G2 approved in-state, run to G3
    gov.setSubmitResult("in_review");
    gov.setGateState("sub-mock-1", "approved"); // G1
    const r1 = await loop.run("计数器", {
      runId: "test-g3",
      runState: {
        runId: "test-g3", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "behavior_wave", status: "awaiting_approval", awaitingGate: "G2",
        docs: {
          intake: { revisionId: "rev-1", artifactId: "art-1", version: 1, contentHash: "h1" },
          behavior_wave: { revisionId: "rev-2", artifactId: "art-2", version: 1, contentHash: "h2" },
        },
        gateSubmissions: { G1: "sub-mock-1", G2: "sub-mock-2" },
        gateDecisions: { G1: "approved" },
      },
    });
    // G2 approved → runs architecture + register_spec → stops at G3
    gov.setGateState("sub-mock-2", "approved");
    expect(r1.awaitingGate).toBe("G3");
    // Should have registered architecture + register_spec (plus the 2 from before = 4 total if gov recorded all)
    // But since we're resuming, the new docs are architecture + register_spec
    expect(r1.docs?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("G4: full chain with all gates approved → succeeded", async () => {
    const gov = new MockGovernanceClient();
    // All gates auto-approve on submit
    gov.setSubmitResult("approved");
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });
    const result = await loop.run("计数器", {
      runId: "test-g4-full",
      runState: {
        runId: "test-g4-full", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(result.status).toBe("succeeded");
    // All 4 gates should have been submitted
    expect(gov.submittedGates.length).toBe(4);
    // All stages ran
    expect(result.rtl?.topModule).toBe("counter");
    expect(connector.callCount("implement")).toBe(1);
  });

  test("rejected gate → fail-closed on resume", async () => {
    const gov = new MockGovernanceClient();
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });

    // Run to G1
    gov.setSubmitResult("in_review");
    const r1 = await loop.run("计数器", {
      runId: "test-reject",
      runState: {
        runId: "test-reject", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(r1.awaitingGate).toBe("G1");

    // Reject G1
    const g1Sub = gov.submissions[0]!.submissionId;
    gov.setGateState(g1Sub, "rejected");

    // Resume → fail-closed
    const r2 = await loop.resume({
      runId: "test-reject", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      currentStage: "intake", status: "awaiting_approval", awaitingGate: "G1",
      docs: { intake: { revisionId: "rev-1", artifactId: "art-1", version: 1, contentHash: "h1" } },
      gateSubmissions: { G1: g1Sub },
      gateDecisions: {},
    });
    expect(r2.status).toBe("fail_closed");
    expect(r2.endedReason).toContain("rejected");
    expect(r2.endedReason).toContain("fail-closed");
  });

  test("withdrawn gate → fail-closed on resume", async () => {
    const gov = new MockGovernanceClient();
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });

    gov.setSubmitResult("in_review");
    const r1 = await loop.run("计数器", {
      runId: "test-withdraw",
      runState: {
        runId: "test-withdraw", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(r1.awaitingGate).toBe("G1");

    const g1Sub = gov.submissions[0]!.submissionId;
    gov.setGateState(g1Sub, "withdrawn");

    const r2 = await loop.resume({
      runId: "test-withdraw", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      currentStage: "intake", status: "awaiting_approval", awaitingGate: "G1",
      docs: { intake: { revisionId: "rev-1", artifactId: "art-1", version: 1, contentHash: "h1" } },
      gateSubmissions: { G1: g1Sub },
      gateDecisions: {},
    });
    expect(r2.status).toBe("fail_closed");
    expect(r2.endedReason).toContain("withdrawn");
  });

  test("still in_review on resume → still waiting", async () => {
    const gov = new MockGovernanceClient();
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });

    gov.setSubmitResult("in_review");
    const r1 = await loop.run("计数器", {
      runId: "test-waiting",
      runState: {
        runId: "test-waiting", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(r1.awaitingGate).toBe("G1");

    const g1Sub = gov.submissions[0]!.submissionId;
    gov.setGateState(g1Sub, "in_review"); // still in review

    const r2 = await loop.resume({
      runId: "test-waiting", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      currentStage: "intake", status: "awaiting_approval", awaitingGate: "G1",
      docs: { intake: { revisionId: "rev-1", artifactId: "art-1", version: 1, contentHash: "h1" } },
      gateSubmissions: { G1: g1Sub },
      gateDecisions: {},
    });
    expect(r2.awaitingGate).toBe("G1");
    expect(r2.endedReason).toContain("awaiting");
  });

  test("artifact registration: doc stages register correct artifact types", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("approved"); // auto-approve all
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector, { governance: gov });
    await loop.run("计数器", {
      runId: "test-artifacts",
      runState: {
        runId: "test-artifacts", task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    // Verify artifact types for each doc stage
    const types = gov.registeredArtifacts.map(a => a.artifactType);
    expect(types).toContain("DEVELOPMENT_REQUIREMENTS"); // intake
    expect(types).toContain("DETAILED_DESIGN"); // behavior_wave + register_spec
    expect(types).toContain("ARCHITECTURE_DESIGN"); // architecture
    expect(types).toContain("RTL_SOURCE_SET"); // rtl_build
    // Verify content hashes are present
    for (const a of gov.registeredArtifacts) {
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.contentLocation).toBeTruthy();
    }
    // Verify snapshots were created at each gate
    expect(gov.snapshots.length).toBe(4); // G1, G2, G3, G4
    // G3 snapshot should contain 2 revisions (architecture + register_spec)
    const g3Snap = gov.snapshots[2]!;
    expect(g3Snap.memberRevisionIds.length).toBe(2);
  });

  test("onAwaitingApproval callback fires when loop pauses at gate", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const calls: Array<{ gate: string; submissionId: string; runId: string }> = [];
    const loop = new LoopExecutor({
      model: new FullChainModel(), connector, governance: gov,
      skillPrompts: {
        rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill",
        intake: "intake-skill", behaviorWave: "behavior-skill", architecture: "arch-skill", registerSpec: "reg-skill",
      },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "policy-v1",
      onAwaitingApproval: (gate, submissionId, runId) => calls.push({ gate, submissionId, runId }),
    });
    await loop.run("计数器", { runId: "test-cb" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.gate).toBe("G1");
    expect(calls[0]!.runId).toBe("test-cb");
  });

  test("run-state persistence: G1 pause → save to disk → load → resume round-trip", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("in_review");
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });

    // Capture saved states.
    let savedState: RunState | undefined;
    const runId = "test-persist-rt";

    const loop1 = new LoopExecutor({
      model: new FullChainModel(), connector, governance: gov,
      skillPrompts: {
        rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill",
        intake: "intake-skill", behaviorWave: "behavior-skill", architecture: "arch-skill", registerSpec: "reg-skill",
      },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "policy-v1",
      onStateChange: async (state) => { savedState = state; },
    });

    const r1 = await loop1.run("计数器", {
      runId,
      runState: {
        runId, task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(r1.awaitingGate).toBe("G1");

    // CRITICAL: the saved state must contain the submission id, stage, and doc artifacts.
    expect(savedState).toBeDefined();
    expect(savedState!.status).toBe("awaiting_approval");
    expect(savedState!.awaitingGate).toBe("G1");
    expect(savedState!.currentStage).toBe("intake");
    expect(savedState!.gateSubmissions?.G1).toBeTruthy();
    expect(savedState!.docs?.intake).toBeTruthy();
    expect(savedState!.docs?.intake?.revisionId).toBeTruthy();

    // Simulate loading from disk and resuming.
    const g1Sub = savedState!.gateSubmissions!.G1!;
    gov.setGateState(g1Sub, "approved");

    const loop2 = new LoopExecutor({
      model: new FullChainModel(), connector, governance: gov,
      skillPrompts: {
        rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill",
        intake: "intake-skill", behaviorWave: "behavior-skill", architecture: "arch-skill", registerSpec: "reg-skill",
      },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "policy-v1",
    });
    const r2 = await loop2.resume(savedState!);
    // Should continue past G1 to G2 (behavior_wave registered, stops at G2).
    expect(r2.awaitingGate).toBe("G2");
  });
});
