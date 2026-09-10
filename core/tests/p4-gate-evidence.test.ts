import { describe, expect, test } from "bun:test";
import { computeManifestHash, sha256Hex } from "../src/hashing.ts";
import {
  P4_GATE_EVIDENCE_MAX_BYTES,
  P4_GATE_EVIDENCE_MAX_ITEMS,
  evaluateP4GateEvidence,
  type FrozenGateTrace,
  type ManagedGateRevision,
  type P4GateEvidenceInput,
  type P4RequirementAuthority,
  type P4StructuredGateId,
} from "../src/services/p4-gate-evidence.ts";

const PROJECT_ID = "project-evidence";

function revision(revisionId: string, value: unknown, projectId = PROJECT_ID): ManagedGateRevision {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return { revisionId, projectId, bytes, contentHash: sha256Hex(bytes) };
}

function trace(
  id: string,
  sourceRevisionId: string,
  targetRevisionId: string,
  overrides: Partial<FrozenGateTrace> = {},
): FrozenGateTrace {
  return {
    id,
    projectId: PROJECT_ID,
    state: "approved",
    sourceRevisionId,
    sourceProjectId: PROJECT_ID,
    targetRevisionId,
    targetProjectId: PROJECT_ID,
    basis: "Approved engineering trace",
    ...overrides,
  };
}

function input(
  gate: P4StructuredGateId,
  revisions: ManagedGateRevision[],
  traces: FrozenGateTrace[],
  authoritativeRequirements: P4RequirementAuthority | null = null,
): P4GateEvidenceInput {
  return {
    gate,
    projectId: PROJECT_ID,
    snapshotId: `snapshot-${gate.toLowerCase()}`,
    snapshotManifestHash: computeManifestHash(
      revisions.map((item) => ({ id: item.revisionId, sha256: item.contentHash })),
    ),
    memberRevisionIds: revisions.map((item) => item.revisionId),
    revisions,
    traceRelationIds: traces.map((item) => item.id),
    traces,
    authoritativeRequirements,
  };
}

function g1Document(traceRelationIds = ["trace-g1"]): Record<string, unknown> {
  return {
    schema: "p4-gate-evidence.v1",
    gate: "G1",
    requirements: [{
      id: "REQ-1",
      critical: true,
      source: { revisionId: "rev-source", locator: "source-spec §1" },
      interface: { name: "pwm_out", direction: "output", contract: "One-bit PWM output" },
      acceptance: { criterion: "Duty cycle matches the programmed value", method: "Simulation assertion" },
    }],
    risks: [{
      id: "RISK-1",
      critical: true,
      description: "Asynchronous reset release can create metastability",
      disposition: { status: "mitigated", rationale: "Synchronize reset deassertion in every clock domain" },
    }],
    traceRelationIds,
  };
}

function g2Document(traceRelationIds = ["trace-g2"]): Record<string, unknown> {
  return {
    schema: "p4-gate-evidence.v1",
    gate: "G2",
    requirementIds: ["REQ-1"],
    criticalRequirementIds: ["REQ-1"],
    behavior: {
      functional: ["Counter compares against the programmed duty value"],
      performance: ["Sustains one update per input clock"],
      timing: ["Output changes only on a rising clock edge"],
      exceptions: ["Reset drives the output inactive"],
    },
    verificationMappings: [{
      id: "VM-1",
      requirementId: "REQ-1",
      method: "simulation",
      procedure: "Sweep all duty values and sample a full PWM period",
      expected: "Observed high cycles equal the programmed duty value",
    }],
    traceRelationIds,
  };
}

function g3Document(traceRelationIds = ["trace-g3"]): Record<string, unknown> {
  return {
    schema: "p4-gate-evidence.v1",
    gate: "G3",
    architecture: {
      summary: "A counter and comparator implement the PWM datapath",
      components: [{ id: "COMP-PWM", responsibility: "Generate PWM output from duty input" }],
    },
    interfaces: [{ id: "IF-PWM", name: "pwm_out", contract: "Registered active-high output" }],
    registers: [{ id: "REG-DUTY", name: "DUTY", address: "0x00", description: "Eight-bit duty setting" }],
    clocks: [{ id: "CLK-SYS", name: "clk", frequencyHz: 100_000_000, domain: "sys" }],
    resets: [{ id: "RST-SYS", name: "rst_n", kind: "asynchronous", polarity: "active_low", domain: "sys" }],
    cdc: { status: "not_applicable", rationale: "The design has one clock domain" },
    constraintStrategy: {
      pin: "Bind clk, rst_n, and pwm_out to board pins",
      electrical: "Use the board-approved LVCMOS voltage standard",
      timing: "Constrain CLK-SYS to 10 ns and cover all synchronous paths",
    },
    designTrace: [{ id: "DT-1", requirementId: "REQ-1", designElementId: "COMP-PWM", relationId: "trace-g3" }],
    traceRelationIds,
  };
}

function authority(): P4RequirementAuthority {
  return {
    requirementIds: ["REQ-1"],
    criticalRequirementIds: ["REQ-1"],
    frozenRevisionIds: ["rev-g1", "rev-source"],
  };
}

describe("p4-gate-evidence.v1 semantic evaluator", () => {
  test("passes complete G1, G2, and G3 documents without consulting artifact metadata", () => {
    const source = revision("rev-source", "Frozen source material");
    const g1Revision = revision("rev-g1", g1Document());
    const g1 = evaluateP4GateEvidence(input(
      "G1",
      [source, g1Revision],
      [trace("trace-g1", "rev-source", "rev-g1")],
    ));
    expect(g1.checks["artifact.development_requirements"]?.passed).toBe(true);
    expect(g1.checks["snapshot.members_frozen"]?.passed).toBe(true);
    expect(Object.keys(g1.checks).sort()).toEqual([
      "artifact.development_requirements",
      "snapshot.members_frozen",
    ]);
    expect(g1.authority).toEqual(authority());

    const g2Revision = revision("rev-g2", g2Document());
    const g2 = evaluateP4GateEvidence(input(
      "G2",
      [g2Revision],
      [trace("trace-g2", "rev-g1", "rev-g2")],
      authority(),
    ));
    expect(g2.checks["artifact.behavior_spec"]?.passed).toBe(true);
    expect(g2.checks["artifact.verification_method_map"]?.passed).toBe(true);
    expect(g2.checks["snapshot.members_frozen"]?.passed).toBe(true);
    expect(Object.keys(g2.checks).sort()).toEqual([
      "artifact.behavior_spec",
      "artifact.verification_method_map",
      "snapshot.members_frozen",
    ]);

    const g3Revision = revision("rev-g3", g3Document());
    const g3 = evaluateP4GateEvidence(input(
      "G3",
      [g3Revision],
      [trace("trace-g3", "rev-g1", "rev-g3")],
      authority(),
    ));
    expect(g3.checks["artifact.architecture_design"]?.passed).toBe(true);
    expect(g3.checks["artifact.detailed_design"]?.passed).toBe(true);
    expect(g3.checks["artifact.constraint_design"]?.passed).toBe(true);
    expect(g3.checks["snapshot.members_frozen"]?.passed).toBe(true);
    expect(Object.keys(g3.checks).sort()).toEqual([
      "artifact.architecture_design",
      "artifact.constraint_design",
      "artifact.detailed_design",
      "snapshot.members_frozen",
    ]);
  });

  test("rejects empty prose, wrong-gate documents, missing fields, and duplicate ids", () => {
    const emptyDocument = revision("rev-empty", "");
    expect(evaluateP4GateEvidence(input(
      "G1",
      [emptyDocument],
      [trace("trace-g1", "rev-empty", "rev-empty")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);

    const prose = revision("rev-prose", "requirements source interface acceptance risk mitigated");
    expect(evaluateP4GateEvidence(input(
      "G1",
      [prose],
      [trace("trace-g1", "rev-prose", "rev-prose")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);

    const wrongGate = revision("rev-g1", { ...g1Document(), gate: "G2" });
    expect(evaluateP4GateEvidence(input(
      "G1",
      [revision("rev-source", "source"), wrongGate],
      [trace("trace-g1", "rev-source", "rev-g1")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);

    const missingRisks = g1Document();
    delete missingRisks.risks;
    expect(evaluateP4GateEvidence(input(
      "G1",
      [revision("rev-source", "source"), revision("rev-g1", missingRisks)],
      [trace("trace-g1", "rev-source", "rev-g1")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);

    const duplicate = g1Document();
    duplicate.requirements = [
      ...(duplicate.requirements as unknown[]),
      { ...(duplicate.requirements as Record<string, unknown>[])[0] },
    ];
    expect(evaluateP4GateEvidence(input(
      "G1",
      [revision("rev-source", "source"), revision("rev-g1", duplicate)],
      [trace("trace-g1", "rev-source", "rev-g1")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);
  });

  test("rejects an undisposed risk and a document beyond the bounded array contract", () => {
    const undisposed = g1Document();
    (undisposed.risks as Record<string, unknown>[])[0] = {
      ...(undisposed.risks as Record<string, unknown>[])[0],
      disposition: { status: "open", rationale: "not handled" },
    };
    expect(evaluateP4GateEvidence(input(
      "G1",
      [revision("rev-source", "source"), revision("rev-g1", undisposed)],
      [trace("trace-g1", "rev-source", "rev-g1")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);

    const tooMany = g1Document();
    tooMany.risks = Array.from({ length: P4_GATE_EVIDENCE_MAX_ITEMS + 1 }, (_, index) => ({
      id: `RISK-${index}`,
      critical: false,
      description: "bounded risk",
      disposition: { status: "accepted", rationale: "bounded fixture" },
    }));
    expect(evaluateP4GateEvidence(input(
      "G1",
      [revision("rev-source", "source"), revision("rev-g1", tooMany)],
      [trace("trace-g1", "rev-source", "rev-g1")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);

    const oversized = g1Document();
    const requirement = (oversized.requirements as Record<string, unknown>[])[0]!;
    requirement.acceptance = {
      criterion: "x".repeat(P4_GATE_EVIDENCE_MAX_BYTES),
      method: "simulation",
    };
    expect(evaluateP4GateEvidence(input(
      "G1",
      [revision("rev-source", "source"), revision("rev-g1", oversized)],
      [trace("trace-g1", "rev-source", "rev-g1")],
    )).checks["artifact.development_requirements"]?.passed).toBe(false);
  });

  test("rejects G2 when any authoritative critical requirement is unmapped", () => {
    const evidence = g2Document();
    evidence.verificationMappings = [{
      id: "VM-2",
      requirementId: "REQ-2",
      method: "inspection",
      procedure: "Inspect the design",
      expected: "The design is present",
    }];
    evidence.requirementIds = ["REQ-1", "REQ-2"];
    const evaluated = evaluateP4GateEvidence(input(
      "G2",
      [revision("rev-g2", evidence)],
      [trace("trace-g2", "rev-g1", "rev-g2")],
      authority(),
    ));
    expect(evaluated.checks["artifact.behavior_spec"]?.passed).toBe(true);
    expect(evaluated.checks["artifact.verification_method_map"]?.passed).toBe(false);
  });

  test("rejects empty, cross-project, unapproved, or unbound traces", () => {
    const g3Revision = revision("rev-g3", g3Document([]));
    const empty = evaluateP4GateEvidence(input("G3", [g3Revision], [], authority()));
    expect(empty.checks["snapshot.members_frozen"]?.passed).toBe(false);
    expect(empty.checks["artifact.detailed_design"]?.passed).toBe(false);

    const crossProject = trace("trace-g3", "rev-g1", "rev-g3", {
      projectId: "other-project",
      sourceProjectId: "other-project",
    });
    const cross = evaluateP4GateEvidence(input("G3", [revision("rev-g3", g3Document())], [crossProject], authority()));
    expect(cross.checks["snapshot.members_frozen"]?.passed).toBe(false);

    const candidate = trace("trace-g3", "rev-g1", "rev-g3", { state: "candidate" });
    const notFrozen = evaluateP4GateEvidence(input("G3", [revision("rev-g3", g3Document())], [candidate], authority()));
    expect(notFrozen.checks["snapshot.members_frozen"]?.passed).toBe(false);

    const unbound = g3Document(["trace-g3"]);
    (unbound.designTrace as Record<string, unknown>[])[0] = {
      ...(unbound.designTrace as Record<string, unknown>[])[0],
      relationId: "trace-not-frozen",
    };
    const notBound = evaluateP4GateEvidence(input(
      "G3",
      [revision("rev-g3", unbound)],
      [trace("trace-g3", "rev-g1", "rev-g3")],
      authority(),
    ));
    expect(notBound.checks["artifact.detailed_design"]?.passed).toBe(false);

    const unrelatedTarget = evaluateP4GateEvidence(input(
      "G3",
      [revision("rev-g3", g3Document())],
      [trace("trace-g3", "rev-g1", "rev-unrelated")],
      authority(),
    ));
    expect(unrelatedTarget.checks["snapshot.members_frozen"]?.passed).toBe(false);

    const unrelatedSource = evaluateP4GateEvidence(input(
      "G3",
      [revision("rev-g3", g3Document())],
      [trace("trace-g3", "rev-unrelated", "rev-g3")],
      authority(),
    ));
    expect(unrelatedSource.checks["snapshot.members_frozen"]?.passed).toBe(false);
  });

  test("rejects member ownership, byte hash, and snapshot manifest drift", () => {
    const evidenceRevision = revision("rev-g2", g2Document());
    const traceFact = trace("trace-g2", "rev-g1", "rev-g2");

    const crossed = evaluateP4GateEvidence(input(
      "G2",
      [{ ...evidenceRevision, projectId: "other-project" }],
      [traceFact],
      authority(),
    ));
    expect(crossed.checks["snapshot.members_frozen"]?.passed).toBe(false);

    const hashDrift = evaluateP4GateEvidence(input(
      "G2",
      [{ ...evidenceRevision, contentHash: sha256Hex("different bytes") }],
      [traceFact],
      authority(),
    ));
    expect(hashDrift.checks["snapshot.members_frozen"]?.passed).toBe(false);

    const manifestDriftInput = input("G2", [evidenceRevision], [traceFact], authority());
    const manifestDrift = evaluateP4GateEvidence({
      ...manifestDriftInput,
      snapshotManifestHash: sha256Hex("different manifest"),
    });
    expect(manifestDrift.checks["snapshot.members_frozen"]?.passed).toBe(false);
  });
});
