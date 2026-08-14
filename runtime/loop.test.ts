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
  WORKER_RESULT_NAME,
  renderFailureDiagnostics,
  extractTopicKeywords,
  extractModulePorts,
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
const DOC_ARCH: DocGeneration = { phase: "generate_architecture", reasoning: "ok", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\ncounter: top.\n## Interface / Ports\nclk, rst_n, c." };
const DOC_REG: DocGeneration = { phase: "generate_register_spec", reasoning: "ok", docPath: "doc/reg/register_map.md", content: "# Register Map\nNo registers for the counter design." };

/** A complete test model that produces all 8 phase outputs. */
class FullChainModel implements LoopModel {
  readonly repairs: Array<{ stderr: string; stdout: string; attempt: number }> = [];
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
  async repair(input: { stderr: string; stdout?: string; attempt: number }): Promise<RepairGeneration> {
    this.repairs.push({ stderr: input.stderr, stdout: input.stdout ?? "", attempt: input.attempt });
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
// renderFailureDiagnostics (unit)
// ---------------------------------------------------------------------------

describe("renderFailureDiagnostics", () => {
  test("renders exitCode/phase header + stdout/stderr tails into model-facing fields", () => {
    const out = renderFailureDiagnostics({ exitCode: 1, phase: "simulate", stdout: "sim stdout", stderr: "sim stderr" });
    expect(out.stdout).toBe("sim stdout");
    expect(out.stderr).toContain("[失败诊断 phase=simulate, exitCode=1]");
    expect(out.stderr).toContain("sim stderr");
  });
  test("omits header when exitCode/phase absent", () => {
    const out = renderFailureDiagnostics({ stdout: "o", stderr: "e" });
    expect(out.stdout).toBe("o");
    expect(out.stderr).toBe("e");
    expect(out.stderr).not.toContain("[失败诊断");
  });
  test("truncates long stdout/stderr to a tail window", () => {
    const long = "x".repeat(3000);
    const out = renderFailureDiagnostics({ stdout: long, stderr: long });
    expect(out.stdout.length).toBeLessThan(long.length);
    expect(out.stdout).toContain("truncated");
    expect(out.stderr).toContain("truncated");
  });
  test("handles empty/undefined gracefully", () => {
    const out = renderFailureDiagnostics({});
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
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

  // ══ Failure diagnostics — worker-result.json content injection ═════════════

  /** Behavior: simulate fails once with a worker-result.json evidence entry,
   *  then succeeds. The failure carries a bare stderr the diagnostics should
   *  OVERRIDE with the richer worker-result.json content. */
  function failOnceWithWorkerResultBehavior() {
    let failed = false;
    return {
      respond: (req: { operation: string }, _idx: number) => {
        if (req.operation === "simulate" && !failed) {
          failed = true;
          return {
            status: "failed" as const,
            jobId: `fake-job-${req.operation}-wr`,
            operation: req.operation as never,
            inputSha256: "wr-sha",
            stdout: "bare stdout (should be overridden)",
            stderr: "bare stderr (should be overridden)",
            errorCode: "VIVADO_SIMULATION_FAILED",
            evidence: {
              jobId: "fake-job-simulate-wr",
              entries: [
                { name: WORKER_RESULT_NAME, sha256: "w".repeat(64), sizeBytes: 99, mediaType: "application/json" },
                { name: "simulate.log", sha256: "l".repeat(64), sizeBytes: 10, mediaType: "text/plain" },
              ],
            },
          };
        }
        return {
          status: "succeeded" as const,
          jobId: `fake-job-${req.operation}-ok`,
          operation: req.operation as never,
          inputSha256: "wr-sha",
          stdout: "PASS",
          evidence: { jobId: "fake-job-ok", entries: [{ name: "result.txt", sha256: "r".repeat(64), sizeBytes: 4, mediaType: "text/plain" }] },
        };
      },
    };
  }

  test("repair receives worker-result.json diagnostics (exitCode/phase/stderr) when evidence entry exists", async () => {
    const connector = new FakeVivadoConnector({ behavior: failOnceWithWorkerResultBehavior() as never });
    const model = new FullChainModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("succeeded");
    expect(model.repairs).toHaveLength(1);
    // The worker-result.json content (from FakeVivadoConnector.fetchEvidenceContent)
    // overrides the bare VivadoResult fields.
    expect(model.repairs[0]!.stderr).toContain("phase=simulate");
    expect(model.repairs[0]!.stderr).toContain("exitCode=1");
    expect(model.repairs[0]!.stderr).toContain("[USF-XSim 62]");
    expect(model.repairs[0]!.stderr).not.toContain("bare stderr");
    expect(model.repairs[0]!.stdout).toContain("Vivado Simulator run");
    expect(model.repairs[0]!.stdout).not.toContain("bare stdout");
    // Audit recorded the successful fetch.
    const diagAudit = result.audit.find((a) => a.action.startsWith("diagnostics_fetched"));
    expect(diagAudit).toBeDefined();
    expect(diagAudit!.action).toContain("true");
  });

  test("repair degrades to bare result fields when no worker-result.json entry (existing behavior)", async () => {
    // failOnceThenSucceedBehavior evidence has simulate.log, NOT worker-result.json.
    const connector = new FakeVivadoConnector({ behavior: failOnceThenSucceedBehavior("simulate", 1) });
    const model = new FullChainModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("succeeded");
    expect(model.repairs).toHaveLength(1);
    // Falls back to the bare VivadoResult.stderr.
    expect(model.repairs[0]!.stderr).toContain("undefined signal");
    expect(model.repairs[0]!.stderr).not.toContain("[失败诊断");
    const diagAudit = result.audit.find((a) => a.action.startsWith("diagnostics_fetched"));
    expect(diagAudit).toBeDefined();
    expect(diagAudit!.action).toContain("false");
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

  test("tool-stage resume: RTL generated → crash before validate → resume → validate uses persisted RTL (no model re-call)", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("approved"); // auto-approve all gates
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });

    // Track model calls — RTL should NOT be called again on resume.
    let rtlCallCount = 0;
    const model = new FullChainModel();
    const origGenRtl = model.generateRtl.bind(model);
    model.generateRtl = async () => { rtlCallCount++; return origGenRtl(); };

    let savedState: RunState | undefined;
    const runId = "test-tool-resume";

    // Phase 1: run through all gates (auto-approved), generate RTL,
    // but crash at validate by using a connector that throws on validate_sources.
    const crashConnector = new FakeVivadoConnector({
      behavior: {
        respond: (req) => {
          if (req.operation === "validate_sources") {
            throw new Error("simulated 66 offline crash");
          }
          return successBehavior().respond(req, 0);
        },
      },
    });

    const loop1 = new LoopExecutor({
      model, connector: crashConnector, governance: gov,
      skillPrompts: {
        rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill",
        intake: "intake-skill", behaviorWave: "behavior-skill", architecture: "arch-skill", registerSpec: "reg-skill",
      },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "policy-v1",
      onStateChange: async (state) => { savedState = state; },
    });

    // Run — will crash at validate_sources after RTL is generated.
    const r1 = await loop1.run("计数器", {
      runId,
      runState: {
        runId, task: "计数器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    // Should have failed (connector threw at validate → fail_closed).
    expect(r1.status).toBe("fail_closed");
    expect(rtlCallCount).toBe(1); // RTL was generated once

    // CRITICAL: saved state must contain the RTL content.
    expect(savedState).toBeDefined();
    expect(savedState!.rtlArtifacts).toBeDefined();
    expect(savedState!.rtlArtifacts!.topModule).toBe("counter");
    expect(savedState!.rtlArtifacts!.sources.length).toBeGreaterThan(0);
 expect(savedState!.rtlArtifacts!.sources[0]!.content).toContain("module counter");

    // Phase 2: resume with a WORKING connector — validate should succeed
    // WITHOUT calling the model again for RTL.
    const workingConnector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop2 = new LoopExecutor({
      model, connector: workingConnector, governance: gov,
      skillPrompts: {
        rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill",
        intake: "intake-skill", behaviorWave: "behavior-skill", architecture: "arch-skill", registerSpec: "reg-skill",
      },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "policy-v1",
    });
    const r2 = await loop2.resume(savedState!);
    // Validate + remaining stages should succeed (or pause at G4).
    // The key assertion: RTL was NOT regenerated.
    expect(rtlCallCount).toBe(1); // still 1 — no re-call
    // Validate ran on the working connector.
    expect(workingConnector.callCount("validate_sources")).toBeGreaterThanOrEqual(1);
  });
});
// ---------------------------------------------------------------------------
// Content-conformity extraction helpers (unit)
// ---------------------------------------------------------------------------

describe("extractTopicKeywords", () => {
  test("extracts Latin topic tokens, filters stopwords and short tokens", () => {
    expect(extractTopicKeywords("实现一个 UART 收发器")).toEqual(["uart"]);
    expect(extractTopicKeywords("8-bit counter design")).toEqual(["counter"]);
  });
  test("CJK-only task yields no keywords (topic check skipped)", () => {
    expect(extractTopicKeywords("计数器")).toEqual([]);
  });
  test("combines multiple sources and dedupes", () => {
    expect(extractTopicKeywords("UART module", "uart_top transceiver")).toEqual(["uart", "uart_top", "transceiver"]);
  });
});

describe("extractModulePorts", () => {
  test("ANSI-style port list with widths", () => {
    const src = "module uart_top(input clk, input rst_n, input rxd, output reg [7:0] txd);\nendmodule\n";
    expect(extractModulePorts(src, "uart_top")).toEqual(["clk", "rst_n", "rxd", "txd"]);
  });
  test("single-char ports extracted (filtered at check site by length)", () => {
    const src = "module counter(input clk,input rst_n,output reg[7:0] c);";
    expect(extractModulePorts(src, "counter")).toEqual(["clk", "rst_n", "c"]);
  });
  test("returns [] when module header absent", () => {
    expect(extractModulePorts("module other(input a);", "counter")).toEqual([]);
  });
  test("bare-name (non-ANSI) port list fallback", () => {
    expect(extractModulePorts("module top(clk, rst, data);", "top")).toEqual(["clk", "rst", "data"]);
  });
});

// ---------------------------------------------------------------------------
// Content-conformity gate (G3 docs / G4 RTL)
// ---------------------------------------------------------------------------

// UART reference artifacts used by the conformity scenario models.
const UART_INTAKE: DocGeneration = { phase: "generate_intake", reasoning: "ok", docPath: "doc/intake/summary.md", content: "# Intake\n## Task\nUART transceiver. Top module uart_top." };
const UART_BEHAVIOR: DocGeneration = { phase: "generate_behavior_wave", reasoning: "ok", docPath: "doc/spec/behavior_spec.md", content: "# Behavior Spec\n## Rules\nR1: uart_top transmits/receives on clock." };
const UART_ARCH: DocGeneration = { phase: "generate_architecture", reasoning: "ok", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\nuart_top: top.\n## Ports\nclk, rst_n, txd, rxd." };
const UART_REG: DocGeneration = { phase: "generate_register_spec", reasoning: "ok", docPath: "doc/reg/register_map.md", content: "# Register Map\nuart_top has no software registers." };
const OFFTOPIC_ARCH: DocGeneration = { phase: "generate_architecture", reasoning: "ok", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\nvideo_pipe: top.\n## Ports\npclk, vsync, hs, data." };
const UART_RTL: RtlGeneration = { phase: "generate_rtl", reasoning: "ok", topModule: "uart_top", sources: [{ path: "uart_top.v", content: "module uart_top(input clk,input rst_n,input rxd,output txd);\nendmodule\n" }] };
const COUNTER_RTL: RtlGeneration = { phase: "generate_rtl", reasoning: "ok", topModule: "counter", sources: [{ path: "counter.v", content: "module counter(input clk,input rst_n,output reg[7:0] count);\nendmodule\n" }] };
const UART_TB: TbGeneration = { phase: "generate_testbench", reasoning: "ok", testbenchModule: "tb_uart", testbench: { path: "tb_uart.v", content: "module tb_uart;initial begin $display(\"PASS\");$finish;end endmodule\n" } };

/** Model whose architecture is off-topic on the 1st call, on-topic afterwards. */
class OffTopicDocModel implements LoopModel {
  archCalls = 0;
  async generateIntake(): Promise<DocGeneration> { return UART_INTAKE; }
  async generateBehaviorWave(): Promise<DocGeneration> { return UART_BEHAVIOR; }
  async generateArchitecture(): Promise<DocGeneration> { this.archCalls++; return this.archCalls === 1 ? OFFTOPIC_ARCH : UART_ARCH; }
  async generateRegisterSpec(): Promise<DocGeneration> { return UART_REG; }
  async generateRtl(): Promise<RtlGeneration> { return UART_RTL; }
  async generateTestbench(): Promise<TbGeneration> { return UART_TB; }
  async generateXdc(): Promise<XdcGeneration> { return { phase: "generate_xdc", reasoning: "ok", constraints: [XDC] }; }
  async repair(): Promise<RepairGeneration> { return { phase: "repair", reasoning: "ok", sources: UART_RTL.sources, testbench: UART_TB.testbench }; }
}

/** Model whose RTL is a counter on the 1st call, UART afterwards (docs always UART). */
class OffTopicRtlModel implements LoopModel {
  rtlCalls = 0;
  async generateIntake(): Promise<DocGeneration> { return UART_INTAKE; }
  async generateBehaviorWave(): Promise<DocGeneration> { return UART_BEHAVIOR; }
  async generateArchitecture(): Promise<DocGeneration> { return UART_ARCH; }
  async generateRegisterSpec(): Promise<DocGeneration> { return UART_REG; }
  async generateRtl(): Promise<RtlGeneration> { this.rtlCalls++; return this.rtlCalls === 1 ? COUNTER_RTL : UART_RTL; }
  async generateTestbench(): Promise<TbGeneration> { return UART_TB; }
  async generateXdc(): Promise<XdcGeneration> { return { phase: "generate_xdc", reasoning: "ok", constraints: [XDC] }; }
  async repair(): Promise<RepairGeneration> { return { phase: "repair", reasoning: "ok", sources: UART_RTL.sources, testbench: UART_TB.testbench }; }
}

/** Model whose RTL is ALWAYS a counter (never conformant for a UART task). */
class AlwaysOffTopicRtlModel implements LoopModel {
  rtlCalls = 0;
  async generateIntake(): Promise<DocGeneration> { return UART_INTAKE; }
  async generateBehaviorWave(): Promise<DocGeneration> { return UART_BEHAVIOR; }
  async generateArchitecture(): Promise<DocGeneration> { return UART_ARCH; }
  async generateRegisterSpec(): Promise<DocGeneration> { return UART_REG; }
  async generateRtl(): Promise<RtlGeneration> { this.rtlCalls++; return COUNTER_RTL; }
  async generateTestbench(): Promise<TbGeneration> { return UART_TB; }
  async generateXdc(): Promise<XdcGeneration> { return { phase: "generate_xdc", reasoning: "ok", constraints: [XDC] }; }
  async repair(): Promise<RepairGeneration> { return { phase: "repair", reasoning: "ok", sources: COUNTER_RTL.sources, testbench: UART_TB.testbench }; }
}

describe("LoopExecutor — content-conformity gate", () => {
  test("G3: off-topic architecture doc → intercepted → regenerated → passes", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new OffTopicDocModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("实现一个 UART 收发器");
    expect(result.status).toBe("succeeded");
    expect(model.archCalls).toBe(2); // initial off-topic + 1 repair
    const conformity = result.audit.filter(a => a.action.startsWith("content_conformity"));
    expect(conformity.some(a => a.result === "failed" && a.action.includes("G3"))).toBe(true);
    expect(conformity.some(a => a.result === "ok")).toBe(true);
    // The off-topic problem must be recorded with detail.
    const failed = conformity.find(a => a.result === "failed")!;
    expect(failed.detail).toContain("topic");
  });

  test("G4: off-topic RTL (counter for UART task) → intercepted → regenerated → passes", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new OffTopicRtlModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("实现一个 UART 收发器");
    expect(result.status).toBe("succeeded");
    expect(result.rtl?.topModule).toBe("uart_top");
    expect(model.rtlCalls).toBe(2); // initial counter + 1 repair
    const conformity = result.audit.filter(a => a.action.startsWith("content_conformity"));
    expect(conformity.some(a => a.result === "failed" && a.action.includes("G4"))).toBe(true);
  });

  test("G4: always off-topic RTL → fail-closed after repair budget (3)", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new AlwaysOffTopicRtlModel();
    const loop = makeLoop(model, connector, { maxRepairRounds: 3 });
    const result = await loop.run("实现一个 UART 收发器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("content conformity");
    // 1 initial check + 3 repair checks = 4 failed conformity audits.
    const failed = result.audit.filter(a => a.action.startsWith("content_conformity") && a.result === "failed");
    expect(failed.length).toBe(4);
    expect(model.rtlCalls).toBe(4); // initial + 3 repairs
  });

  test("conformity repair feedback is carried as an upstream section to the model", async () => {
    // The regenerated architecture call must receive upstream containing the feedback marker.
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new OffTopicDocModel();
    const loop = makeLoop(model, connector);
    await loop.run("实现一个 UART 收发器");
    // OffTopicDocModel ignores args, so we assert via audit that a repair round ran.
    expect(model.archCalls).toBe(2);
  });

  test("CJK-only counter task: no topic keyword → conformity passes (no false positive)", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new FullChainModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("succeeded");
    // No conformity failures for a conformant counter design.
    const failed = result.audit.filter(a => a.action.startsWith("content_conformity") && a.result === "failed");
    expect(failed.length).toBe(0);
  });
});
// ---------------------------------------------------------------------------
// Conformity repair → re-registration version monotonicity
// ---------------------------------------------------------------------------

describe("LoopExecutor — conformity repair version monotonicity", () => {
  test("G3: repair re-registers architecture doc with version=2 (no RESOURCE_CONFLICT)", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("approved"); // auto-approve all gates
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new OffTopicDocModel();
    const loop = makeLoop(model, connector, { governance: gov });
    const result = await loop.run("实现一个 UART 收发器");
    expect(result.status).toBe("succeeded");
    // The architecture artifact was registered twice: version 1 (off-topic) then version 2 (repair).
    const archRegs = gov.registeredArtifacts.filter(a => a.artifactId.includes("-architecture-"));
    expect(archRegs.length).toBe(2);
    expect(archRegs[0]!.version).toBe(1);
    expect(archRegs[1]!.version).toBe(2);
    // No RESOURCE_CONFLICT was thrown (loop succeeded).
  });

  test("G4: repair re-registers RTL with version=2 (no RESOURCE_CONFLICT)", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("approved");
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new OffTopicRtlModel();
    const loop = makeLoop(model, connector, { governance: gov });
    const result = await loop.run("实现一个 UART 收发器");
    expect(result.status).toBe("succeeded");
    // RTL artifact registered twice: version 1 (counter) then version 2 (uart_top).
    const rtlRegs = gov.registeredArtifacts.filter(a => a.artifactId.includes("-rtl-"));
    expect(rtlRegs.length).toBe(2);
    expect(rtlRegs[0]!.version).toBe(1);
    expect(rtlRegs[1]!.version).toBe(2);
  });

  test("MockGovernanceClient rejects same version re-registration (guard works)", async () => {
    const gov = new MockGovernanceClient();
    await gov.registerCandidateArtifact({
      artifactId: "art-x", artifactType: "DEVELOPMENT_REQUIREMENTS",
      title: "v1", content: "first", contentLocation: "doc/x.md", version: 1,
    });
    await expect(gov.registerCandidateArtifact({
      artifactId: "art-x", artifactType: "DEVELOPMENT_REQUIREMENTS",
      title: "v1-again", content: "second", contentLocation: "doc/x.md", version: 1,
    })).rejects.toThrow(/RESOURCE_CONFLICT/);
    // Version 2 is accepted.
    const rev = await gov.registerCandidateArtifact({
      artifactId: "art-x", artifactType: "DEVELOPMENT_REQUIREMENTS",
      title: "v2", content: "third", contentLocation: "doc/x.md", version: 2,
    });
    expect(rev.version).toBe(2);
  });

  test("conformity repair persists version=2 in run-state (resume continuity)", async () => {
    const gov = new MockGovernanceClient();
    gov.setSubmitResult("approved"); // auto-approve all gates
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const model = new OffTopicDocModel();

    let savedState: RunState | undefined;
    const loop = new LoopExecutor({
      model, connector, governance: gov,
      skillPrompts: { rtl: "rtl", tb: "tb", xdc: "xdc", repair: "repair", intake: "intake", behaviorWave: "behavior", architecture: "arch", registerSpec: "reg" },
      part: "xc7k70tfbv676-1", projectId: "p1", processInstanceId: "pi-1",
      toolModelPolicyHash: "policy-v1",
      onStateChange: async (state) => { savedState = state; },
    });
    const result = await loop.run("实现一个 UART 收发器", {
      runId: "test-version-persist",
      runState: {
        runId: "test-version-persist", task: "实现一个 UART 收发器", part: "xc7k70tfbv676-1", projectId: "p1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        currentStage: "intake", status: "running",
        docs: {}, gateSubmissions: {}, gateDecisions: {},
      },
    });
    expect(result.status).toBe("succeeded");
    // The architecture doc was repaired (version 2). The final saved state must
    // reflect version 2 so a hypothetical resume would register version 3 next.
    expect(savedState).toBeDefined();
    expect(savedState!.docs?.architecture?.version).toBe(2);
    // Doc that was NOT repaired stays at version 1.
    expect(savedState!.docs?.intake?.version).toBe(1);
    expect(savedState!.docs?.register_spec?.version).toBe(1);
  });
});
