export function g1GateEvidence(input: {
  readonly sourceRevisionId: string;
  readonly traceRelationId: string;
}): string {
  return JSON.stringify({
    schema: "p4-gate-evidence.v1",
    gate: "G1",
    requirements: [{
      id: "REQ-PWM-001",
      critical: true,
      source: { revisionId: input.sourceRevisionId, locator: "source-package §1 PWM behavior" },
      interface: { name: "pwm_out", direction: "output", contract: "Registered one-bit PWM output" },
      acceptance: { criterion: "High-cycle count matches the programmed duty value", method: "Exhaustive simulation assertion" },
    }],
    risks: [{
      id: "RISK-RESET-001",
      critical: true,
      description: "Asynchronous reset release can metastabilize the PWM state",
      disposition: { status: "mitigated", rationale: "Synchronize reset deassertion inside the system clock domain" },
    }],
    traceRelationIds: [input.traceRelationId],
  });
}

export function g2GateEvidence(input: { readonly traceRelationId: string }): string {
  return JSON.stringify({
    schema: "p4-gate-evidence.v1",
    gate: "G2",
    requirementIds: ["REQ-PWM-001"],
    criticalRequirementIds: ["REQ-PWM-001"],
    behavior: {
      functional: ["An eight-bit counter is compared with the programmed duty value"],
      performance: ["The datapath accepts one duty update per system clock"],
      timing: ["The PWM output changes only on a rising system-clock edge"],
      exceptions: ["Reset clears the counter and drives the PWM output inactive"],
    },
    verificationMappings: [{
      id: "VM-PWM-001",
      requirementId: "REQ-PWM-001",
      method: "simulation",
      procedure: "Sweep every duty value and observe a complete 256-cycle period",
      expected: "The number of high cycles equals the programmed duty value",
    }],
    traceRelationIds: [input.traceRelationId],
  });
}

export function g3GateEvidence(input: { readonly traceRelationId: string }): string {
  return JSON.stringify({
    schema: "p4-gate-evidence.v1",
    gate: "G3",
    architecture: {
      summary: "A counter and comparator implement the PWM datapath",
      components: [{ id: "COMP-PWM", responsibility: "Generate PWM output from the duty input" }],
    },
    interfaces: [{ id: "IF-PWM", name: "pwm_out", contract: "Registered active-high output" }],
    registers: [{ id: "REG-DUTY", name: "DUTY", address: "0x00", description: "Eight-bit duty setting" }],
    clocks: [{ id: "CLK-SYS", name: "clk", frequencyHz: 100_000_000, domain: "sys" }],
    resets: [{ id: "RST-SYS", name: "rst_n", kind: "asynchronous", polarity: "active_low", domain: "sys" }],
    cdc: { status: "not_applicable", rationale: "The design uses only the system clock domain" },
    constraintStrategy: {
      pin: "Bind clk, rst_n, and pwm_out to reviewed board pins",
      electrical: "Use the board-approved LVCMOS voltage standard",
      timing: "Constrain CLK-SYS to 10 ns and cover all synchronous paths",
    },
    designTrace: [{
      id: "DT-PWM-001",
      requirementId: "REQ-PWM-001",
      designElementId: "COMP-PWM",
      relationId: input.traceRelationId,
    }],
    traceRelationIds: [input.traceRelationId],
  });
}
