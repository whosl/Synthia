/**
 * Synthia Core — D1 Smoke Test: State Machines & Domain Invariants
 *
 * No external dependencies (no pg, no npm registry needed).
 * Validates ARC-002 §5 state transitions and §6 core invariants.
 * Run: bun test
 */

import { describe, expect, test } from "bun:test";
import {
  artifactRevisionMachine,
  gateSubmissionMachine,
  baselineMachine,
  toolRunMachine,
  traceRelationMachine,
  StateTransitionError,
} from "../src/domain/state-machines.ts";
import { GATE_TO_BASELINE, MILESTONE_GATES, isMilestoneGate } from "../src/domain/enums.ts";

// ── ArtifactRevision (ARC-002 §5.1) ───────────────────────────────────────────

describe("ArtifactRevision state machine", () => {
  test("candidate → in_review → approved", () => {
    expect(artifactRevisionMachine.canTransition("candidate", "in_review")).toBe(true);
    expect(artifactRevisionMachine.canTransition("in_review", "approved")).toBe(true);
  });

  test("candidate → approved is illegal (must go through in_review)", () => {
    expect(artifactRevisionMachine.canTransition("candidate", "approved")).toBe(false);
  });

  test("approved → superseded/invalidated only", () => {
    expect(artifactRevisionMachine.canTransition("approved", "superseded")).toBe(true);
    expect(artifactRevisionMachine.canTransition("approved", "invalidated")).toBe(true);
    expect(artifactRevisionMachine.canTransition("approved", "candidate")).toBe(false);
  });

  test("rejected/superseded/invalidated are terminal", () => {
    for (const terminal of ["rejected", "superseded", "invalidated"] as const) {
      expect(artifactRevisionMachine.isTerminal(terminal)).toBe(true);
    }
  });

  test("assertTransition throws on illegal path", () => {
    expect(() => artifactRevisionMachine.assertTransition("candidate", "approved")).toThrow(StateTransitionError);
  });
});

// ── GateSubmission (ARC-002 §5.2) ─────────────────────────────────────────────

describe("GateSubmission state machine", () => {
  test("full happy path: preparing → submitted → checking → in_review → approved", () => {
    expect(gateSubmissionMachine.canTransition("preparing", "submitted")).toBe(true);
    expect(gateSubmissionMachine.canTransition("submitted", "checking")).toBe(true);
    expect(gateSubmissionMachine.canTransition("checking", "in_review")).toBe(true);
    expect(gateSubmissionMachine.canTransition("in_review", "approved")).toBe(true);
  });

  test("hard-gate failure: checking → rejected", () => {
    expect(gateSubmissionMachine.canTransition("checking", "rejected")).toBe(true);
    expect(gateSubmissionMachine.canTransition("checking", "approved")).toBe(false); // must pass through in_review
  });

  test("withdrawal from preparing/submitted/in_review", () => {
    expect(gateSubmissionMachine.canTransition("preparing", "withdrawn")).toBe(true);
    expect(gateSubmissionMachine.canTransition("submitted", "withdrawn")).toBe(true);
    expect(gateSubmissionMachine.canTransition("in_review", "withdrawn")).toBe(true);
  });

  test("approved/rejected/withdrawn are terminal", () => {
    for (const terminal of ["approved", "rejected", "withdrawn"] as const) {
      expect(gateSubmissionMachine.isTerminal(terminal)).toBe(true);
    }
  });
});

// ── Baseline (ARC-002 §5.3) ───────────────────────────────────────────────────

describe("Baseline state machine", () => {
  test("active → superseded/invalidated/retired only", () => {
    expect(baselineMachine.canTransition("active", "superseded")).toBe(true);
    expect(baselineMachine.canTransition("active", "invalidated")).toBe(true);
    expect(baselineMachine.canTransition("active", "retired")).toBe(true);
  });

  test("no candidate state exists", () => {
    expect("candidate" in baselineMachine.transitions).toBe(false);
  });

  test("all non-active states are terminal", () => {
    for (const terminal of ["superseded", "invalidated", "retired"] as const) {
      expect(baselineMachine.isTerminal(terminal)).toBe(true);
    }
  });
});

// ── ToolRun (ARC-002 §5.5, FLOW-006 §5.2) ────────────────────────────────────

describe("ToolRun state machine", () => {
  test("happy path: submitted → queued → preparing → running → succeeded", () => {
    expect(toolRunMachine.canTransition("submitted", "queued")).toBe(true);
    expect(toolRunMachine.canTransition("queued", "preparing")).toBe(true);
    expect(toolRunMachine.canTransition("preparing", "running")).toBe(true);
    expect(toolRunMachine.canTransition("running", "succeeded")).toBe(true);
  });

  test("rejection at submission (no Vivado touched)", () => {
    expect(toolRunMachine.canTransition("submitted", "rejected")).toBe(true);
    expect(toolRunMachine.canTransition("submitted", "running")).toBe(false);
  });

  test("running can reach all terminal states", () => {
    for (const terminal of ["succeeded", "failed", "timeout", "lost", "unknown_effect"] as const) {
      expect(toolRunMachine.canTransition("running", terminal)).toBe(true);
    }
  });

  test("cancelling → cancelled only", () => {
    expect(toolRunMachine.canTransition("cancelling", "cancelled")).toBe(true);
    expect(toolRunMachine.canTransition("cancelling", "succeeded")).toBe(false);
  });

  test("all terminal states are terminal", () => {
    for (const terminal of ["rejected", "succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"] as const) {
      expect(toolRunMachine.isTerminal(terminal)).toBe(true);
    }
  });
});

// ── TraceRelation (ARC-002 §5.6) ──────────────────────────────────────────────

describe("TraceRelation state machine", () => {
  test("candidate → in_review → approved", () => {
    expect(traceRelationMachine.canTransition("candidate", "in_review")).toBe(true);
    expect(traceRelationMachine.canTransition("in_review", "approved")).toBe(true);
  });

  test("approved → review_required (endpoint changed)", () => {
    expect(traceRelationMachine.canTransition("approved", "review_required")).toBe(true);
  });

  test("review_required → approved/superseded/invalidated", () => {
    expect(traceRelationMachine.canTransition("review_required", "approved")).toBe(true);
    expect(traceRelationMachine.canTransition("review_required", "superseded")).toBe(true);
    expect(traceRelationMachine.canTransition("review_required", "invalidated")).toBe(true);
  });
});

// ── Gate/Baseline mapping (FLOW-001 §6) ───────────────────────────────────────

describe("Gate to Baseline mapping", () => {
  test("only 5 milestone gates", () => {
    expect(MILESTONE_GATES).toEqual(["G1", "G3", "G4", "G7", "G9"]);
  });

  test("G1→B0, G3→B1, G4→B2, G7→B3, G9→B4", () => {
    expect(GATE_TO_BASELINE["G1"]).toBe("B0");
    expect(GATE_TO_BASELINE["G3"]).toBe("B1");
    expect(GATE_TO_BASELINE["G4"]).toBe("B2");
    expect(GATE_TO_BASELINE["G7"]).toBe("B3");
    expect(GATE_TO_BASELINE["G9"]).toBe("B4");
  });

  test("non-milestone gates do not create baselines", () => {
    expect(isMilestoneGate("G2")).toBe(false);
    expect(isMilestoneGate("G5")).toBe(false);
    expect(isMilestoneGate("G6")).toBe(false);
    expect(isMilestoneGate("G8")).toBe(false);
    expect(isMilestoneGate("G0")).toBe(false);
  });

  test("milestone gates detected", () => {
    for (const g of MILESTONE_GATES) {
      expect(isMilestoneGate(g)).toBe(true);
    }
  });
});

// ── Core invariants (ARC-002 §6) ──────────────────────────────────────────────

describe("Core invariants", () => {
  test("toolRun succeeded ≠ gate approved (orthogonal concepts)", () => {
    // ToolRun 'succeeded' and GateSubmission 'approved' are different machines
    // with no cross-reference. This test exists to guard against future coupling.
    expect(toolRunMachine.canTransition("succeeded", "failed")).toBe(false);
    expect(gateSubmissionMachine.canTransition("approved", "rejected")).toBe(false);
  });

  test("baseline cannot be created in non-active state", () => {
    // The repository layer rejects this; the machine has no 'candidate' state.
    expect(baselineMachine.transitions["active"]).toBeDefined();
    expect(baselineMachine.transitions["candidate"]).toBeUndefined();
  });
});
