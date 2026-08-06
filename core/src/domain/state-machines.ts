/**
 * Synthia Core — Per-entity state machines (table-driven)
 *
 * Implements SYNTHIA-ARC-002 §5 state transitions.
 * Each machine is a frozen map: { fromState → Set<allowedTargetStates> }.
 * Illegal transitions are rejected at the repository/service layer (fail-closed).
 */

import type {
  ArtifactRevisionState,
  BaselineState,
  GateSubmissionState,
  ToolRunState,
  TraceRelationState,
} from "./enums.ts";

export interface StateMachine<T extends string> {
  readonly transitions: Readonly<Record<T, ReadonlySet<T>>>;
  /** Returns true if `from → to` is a legal transition. */
  canTransition(from: T, to: T): boolean;
  /** Returns true if `state` has no outgoing transitions. */
  isTerminal(state: T): boolean;
  /** Throws on illegal transition. */
  assertTransition(from: T, to: T): void;
}

export class StateTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = "StateTransitionError";
  }
}

function makeMachine<T extends string>(table: Record<T, readonly T[]>): StateMachine<T> {
  const transitions: Record<T, ReadonlySet<T>> = {} as Record<T, ReadonlySet<T>>;
  for (const key of Object.keys(table) as T[]) {
    transitions[key] = new Set(table[key]) as ReadonlySet<T>;
  }
  return {
    transitions,
    canTransition: (from, to) => transitions[from]?.has(to) ?? false,
    isTerminal: (state) => (transitions[state]?.size ?? 0) === 0,
    assertTransition(from: T, to: T): void {
      if (!this.canTransition(from, to)) throw new StateTransitionError(from, to);
    },
  };
}

// ── ArtifactRevision (ARC-002 §5.1) ───────────────────────────────────────────
//
// candidate → in_review → approved
//                      ↘ rejected
// approved → superseded
// approved → invalidated
//
// Rejected revisions create new revisions; they are not mutated in place.

export const artifactRevisionMachine = makeMachine<ArtifactRevisionState>({
  candidate: ["in_review"],
  in_review: ["approved", "rejected"],
  approved: ["superseded", "invalidated"],
  rejected: [], // terminal: create new revision instead
  superseded: [], // terminal
  invalidated: [], // terminal (restoration requires new approval event)
});

// ── GateSubmission (ARC-002 §5.2) ─────────────────────────────────────────────
//
// preparing → submitted → checking → in_review → approved
//                                      ↘ rejected
// preparing/submitted/in_review → withdrawn
//
// Hard-gate failures keep an auditable result and enter `rejected`.
// `approved` and `rejected` are projected from ApprovalRecord.

export const gateSubmissionMachine = makeMachine<GateSubmissionState>({
  preparing: ["submitted", "withdrawn"],
  submitted: ["checking", "withdrawn"],
  checking: ["in_review", "rejected"],
  in_review: ["approved", "rejected", "withdrawn"],
  approved: [], // terminal
  rejected: [], // terminal: snapshot preserved, create new submission
  withdrawn: [], // terminal
});

// ── Baseline (ARC-002 §5.3) ───────────────────────────────────────────────────
//
// Approval event creates `active`.
// active → superseded | invalidated | retired
// No `candidate` state — baselines are only created by approval.

export const baselineMachine = makeMachine<BaselineState>({
  active: ["superseded", "invalidated", "retired"],
  superseded: [],
  invalidated: [],
  retired: [],
});

// ── ToolRun (ARC-002 §5.5, FLOW-006 §5.2) ────────────────────────────────────
//
// submitted → rejected                          (schema/auth/capability/policy fail, no Vivado)
// submitted → queued → preparing → running
//                                      ↘ succeeded | failed | timeout | cancelling
// cancelling → cancelled
// running → lost                                (worker/comms lost, unknown final state)
// running → unknown_effect                      (non-idempotent hardware op, ambiguous)
//
// run_class is orthogonal to state: `succeeded` ≠ gate approved.

export const toolRunMachine = makeMachine<ToolRunState>({
  submitted: ["rejected", "queued"],
  rejected: [],
  queued: ["preparing"],
  preparing: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelling", "timeout", "lost", "unknown_effect"],
  succeeded: [],
  failed: [],
  cancelling: ["cancelled"],
  cancelled: [],
  timeout: [],
  lost: [],
  unknown_effect: [],
});

// ── TraceRelation (ARC-002 §5.6) ──────────────────────────────────────────────
//
// candidate → in_review → approved | rejected
// approved → review_required → approved | superseded | invalidated
//
// review_required: endpoint or basis changed, needs re-judgment.
// invalidated: current relation cannot support new formal conclusions.

export const traceRelationMachine = makeMachine<TraceRelationState>({
  candidate: ["in_review"],
  in_review: ["approved", "rejected"],
  approved: ["review_required", "superseded", "invalidated"],
  review_required: ["approved", "superseded", "invalidated"],
  superseded: [],
  invalidated: [],
  rejected: [],
});


