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
import { ModelActionError, type ArtifactFile, type LoopModel, type RtlGeneration, type TbGeneration, type XdcGeneration, type RepairGeneration } from "./types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const RTL: ArtifactFile = { path: "counter.v", content: "module counter(input clk,input rst_n,output reg[7:0] c);always@(posedge clk)if(!rst_n)c<=0;else c<=c+1;endmodule\n" };
const TB: ArtifactFile = { path: "tb_counter.v", content: "module tb_counter;reg clk=0;reg rst_n=0;wire[7:0] c;counter d(.clk(clk),.rst_n(rst_n),.c(c));always #5 clk=~clk;initial begin rst_n=0;#20;rst_n=1;repeat(3)@(posedge clk);$display(\"PASS\");$finish;end endmodule\n" };
const XDC: ArtifactFile = { path: "synthia.xdc", content: "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]\nset_property SEVERITY {Warning} [get_drc_checks UCIO-1]\ncreate_clock -period 10 [get_ports clk]\n" };

/** Records every repair invocation so tests can assert diagnostic hand-off. */
class RecordingModel implements LoopModel {
  readonly repairs: Array<{ stderr: string; attempt: number }> = [];
  private repairResponse: RepairGeneration;
  constructor(opts: { repairResponse?: RepairGeneration } = {}) {
    this.repairResponse = opts.repairResponse ?? { phase: "repair", reasoning: "fixed", sources: [RTL], testbench: TB };
  }
  async generateRtl(): Promise<RtlGeneration> { return { phase: "generate_rtl", reasoning: "ok", topModule: "counter", sources: [RTL] }; }
  async generateTestbench(): Promise<TbGeneration> { return { phase: "generate_testbench", reasoning: "ok", testbenchModule: "tb_counter", testbench: TB }; }
  async generateXdc(_top: string, _part: string, _sys: string, _allowPin: boolean): Promise<XdcGeneration> { return { phase: "generate_xdc", reasoning: "ok", constraints: [XDC] }; }
  async repair(input: { stderr: string; attempt: number }): Promise<RepairGeneration> {
    this.repairs.push({ stderr: input.stderr, attempt: input.attempt });
    return this.repairResponse;
  }
}

function makeLoop(model: LoopModel, connector: FakeVivadoConnector, maxRepairRounds = 3) {
  return new LoopExecutor({
    model, connector,
    skillPrompts: { rtl: "rtl-skill", tb: "tb-skill", xdc: "xdc-skill", repair: "repair-skill" },
    part: "xc7k70tfbv676-1", projectId: "p1", maxRepairRounds,
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
// Loop scenarios
// ---------------------------------------------------------------------------

describe("LoopExecutor", () => {
  test("normal full flow: rtl→validate→tb→simulate→xdc→synthesize→implement succeeds", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("实现一个 8 位计数器");
    expect(result.status).toBe("succeeded");
    expect(result.rtl?.topModule).toBe("counter");
    expect(result.testbench?.testbenchModule).toBe("tb_counter");
    expect(result.xdc?.constraints[0]?.path).toBe("synthia.xdc");
    // exactly the four versioned operations, no repeats in the happy path
    expect(connector.callCount("validate_sources")).toBe(1);
    expect(connector.callCount("simulate")).toBe(1);
    expect(connector.callCount("synthesize")).toBe(1);
    expect(connector.callCount("implement")).toBe(1);
    // evidence manifest aggregates all four jobs
    expect(result.evidence.map(e => e.operation)).toEqual(["validate_sources", "simulate", "synthesize", "implement"]);
    expect(result.evidence.every(e => e.entries.length > 0)).toBe(true);
  });

  test("simulation failure → repair → re-validate → simulate succeeds", async () => {
    const connector = new FakeVivadoConnector({ behavior: failOnceThenSucceedBehavior("simulate", 1) });
    const model = new RecordingModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("succeeded");
    expect(connector.callCount("simulate")).toBe(2); // failed then succeeded
    expect(connector.callCount("validate_sources")).toBe(2); // initial + post-repair
    expect(model.repairs).toHaveLength(1);
    // the model received the real simulator stderr from the failed run
    expect(model.repairs[0]!.stderr).toContain("undefined signal");
    expect(model.repairs[0]!.attempt).toBe(1);
  });

  test("repair budget exhausted (3) → fail-closed", async () => {
    const connector = new FakeVivadoConnector({ behavior: alwaysFailBehavior("simulate") });
    const model = new RecordingModel();
    const loop = makeLoop(model, connector, 3);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    // initial + 3 repair rounds = 4 simulate attempts
    expect(connector.callCount("simulate")).toBe(4);
    expect(model.repairs).toHaveLength(3);
    expect(result.endedReason).toContain("repair budget");
    // synthesize / implement never reached
    expect(connector.callCount("synthesize")).toBe(0);
    expect(connector.callCount("implement")).toBe(0);
  });

  test("capability drift detected → immediate fail-closed, no further tool calls", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior(), drift: true });
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("drift");
    // the gate fires before the first tool submit, so nothing executes
    expect(connector.callCount("validate_sources")).toBe(0);
    expect(connector.callCount("simulate")).toBe(0);
    expect(connector.callCount("synthesize")).toBe(0);
    expect(connector.callCount("implement")).toBe(0);
  });

  test("mid-flight drift (flipped after validate) → fail-closed before simulate body", async () => {
    const connector = new FakeVivadoConnector({
      behavior: {
        respond: (req) => {
          // flip drift as a side effect of the first operation completing
          if (req.operation === "validate_sources") connector.drift = true;
          return successBehavior().respond(req, 0);
        },
      },
    });
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(connector.callCount("simulate")).toBe(0);
    expect(connector.callCount("synthesize")).toBe(0);
  });

  test("unsupported (BINARY_UNAVAILABLE) → immediate fail-closed, no retry", async () => {
    const connector = new FakeVivadoConnector({ behavior: unsupportedBehavior() });
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("fail-closed");
    // unsupported surfaces on validate_sources (first op) → nothing after
    expect(connector.callCount("synthesize")).toBe(0);
  });

  test("capability not exposed for implement → fail-closed at implement gate", async () => {
    const caps = FAKE_CAPABILITIES.filter(c => c.operation !== "implement");
    const connector = new FakeVivadoConnector({ behavior: successBehavior(), capabilities: caps });
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(connector.callCount("synthesize")).toBe(1);
    expect(connector.callCount("implement")).toBe(0);
    expect(result.endedReason).toContain("implement");
  });

  test("every tool call is audited with input hash + jobId; no raw tcl in audit", async () => {
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    const toolAudits = result.audit.filter(a => a.category === "tool_call");
    expect(toolAudits.length).toBeGreaterThanOrEqual(4);
    for (const a of toolAudits) {
      expect(a.inputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.jobId).toBeTruthy();
    }
    // no audit entry contains tcl-ish content
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
    const model = new RecordingModel();
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(model.repairs).toHaveLength(0); // unknown_effect must NOT trigger repair
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
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    // CRITICAL: implement failed must NOT be treated as success
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
    const loop = makeLoop(new RecordingModel(), connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("fail_closed");
    expect(result.endedReason).toContain("synthesize");
    expect(connector.callCount("synthesize")).toBe(1);
    expect(connector.callCount("implement")).toBe(0); // implement not reached
  });

  test("model validation failure (illegal file) → ModelActionError → audit records feedback", async () => {
    // Model that always fails RTL validation with an illegal file type
    const model: LoopModel = {
      ...new RecordingModel(),
      async generateRtl() {
        const e = new ModelActionError(
          `model produced no valid action for phase generate_rtl: sources.path "doc/spec/behavior_spec.md" must be one of: .v/.sv/.vh. Do NOT include documentation files`,
          "generate_rtl", 2,
        );
        (e as Error & { validationFeedbacks?: string[] }).validationFeedbacks = [
          'sources.path "doc/spec/behavior_spec.md" must be one of: .v/.sv/.vh. Do NOT include documentation files',
        ];
        throw e;
      },
    };
    const connector = new FakeVivadoConnector({ behavior: successBehavior() });
    const loop = makeLoop(model, connector);
    const result = await loop.run("计数器");
    expect(result.status).toBe("failed");
    // Audit contains the validation feedback event
    const feedbacks = result.audit.filter(a => a.action === "validation feedback");
    expect(feedbacks.length).toBeGreaterThanOrEqual(1);
    expect(feedbacks[0]!.detail).toContain(".v");
    expect(feedbacks[0]!.detail).toContain("documentation");
  });
});
