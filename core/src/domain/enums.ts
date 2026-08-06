/**
 * Synthia Core — Domain Enums
 *
 * Maps 1:1 to SYNTHIA-ARC-002 (Domain and State Model) §5 (per-entity state machines)
 * and SYNTHIA-FLOW-001 §4 (gate flow G0–G9, baselines B0–B4).
 */

// ── Gates (SYNTHIA-FLOW-001 §4) ──────────────────────────────────────────────

export type GateId = "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";

export const MILESTONE_GATES: readonly GateId[] = ["G1", "G3", "G4", "G7", "G9"] as const;
export const isMilestoneGate = (g: GateId): boolean => MILESTONE_GATES.includes(g as never);

// ── Baselines (SYNTHIA-FLOW-001 §6) ───────────────────────────────────────────

export type BaselineKind = "B0" | "B1" | "B2" | "B3" | "B4";

export const GATE_TO_BASELINE: Readonly<Record<string, BaselineKind>> = {
  G1: "B0",
  G3: "B1",
  G4: "B2",
  G7: "B3",
  G9: "B4",
};

// ── ArtifactRevision state (ARC-002 §5.1) ─────────────────────────────────────

export type ArtifactRevisionState =
  | "candidate"
  | "in_review"
  | "approved"
  | "rejected"
  | "superseded"
  | "invalidated";

// ── GateSubmission state (ARC-002 §5.2) ───────────────────────────────────────

export type GateSubmissionState =
  | "preparing"
  | "submitted"
  | "checking"
  | "in_review"
  | "approved"
  | "rejected"
  | "withdrawn";

// ── Baseline state (ARC-002 §5.3) ─────────────────────────────────────────────

export type BaselineState = "active" | "superseded" | "invalidated" | "retired";

// ── ToolRun state (ARC-002 §5.5) ──────────────────────────────────────────────

export type ToolRunState =
  | "submitted"
  | "rejected"
  | "queued"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "timeout"
  | "lost"
  | "unknown_effect";

// ── run_class (FLOW-006 §5, ARC-002 §5.5) ─────────────────────────────────────

export type RunClass = "exploratory" | "gate_check" | "formal";

// ── TraceRelation state (ARC-002 §5.6) ────────────────────────────────────────

export type TraceRelationState =
  | "candidate"
  | "in_review"
  | "approved"
  | "rejected"
  | "review_required"
  | "superseded"
  | "invalidated";

// ── Approval decision types (ARC-002 §5.4, FLOW-003 §2) ───────────────────────

export type ApprovalDecision =
  | "approve"
  | "reject"
  | "approve_with_actions"
  | "request_changes"
  | "revoke"
  | "confirm_no_impact"
  | "accept_waiver";

// ── Artifact types (FLOW-002 §4) ──────────────────────────────────────────────

export type ArtifactType =
  // G0/G1
  | "SOURCE_PACKAGE"
  | "PROJECT_PROFILE"
  | "TAILORING_RECORD"
  | "FEASIBILITY_RISK_REPORT"
  | "DEVELOPMENT_REQUIREMENTS"
  | "SYSTEM_REQUIREMENTS"
  | "OPEN_QUESTION_SET"
  // G2
  | "PLDS_SRS"
  | "DERIVED_REQUIREMENT_SET"
  | "REQUIREMENT_TRACE"
  | "VERIFICATION_METHOD_MAP"
  // G3
  | "ARCHITECTURE_DESIGN"
  | "DETAILED_DESIGN"
  | "CONSTRAINT_DESIGN"
  | "DESIGN_TRACE"
  | "DESIGN_REVIEW"
  // G4
  | "RTL_SOURCE_SET"
  | "TB_SOURCE_SET"
  | "XDC_CANDIDATE"
  | "CODE_TRACE"
  | "CODE_REVIEW"
  | "STATIC_REPORT_SET"
  | "BUILD_MANIFEST"
  // G5/G6
  | "TOOLCHAIN_PROFILE"
  | "TOOL_RUN"
  | "SYNTH_RESULT"
  | "IMPLEMENT_RESULT"
  | "DRC_REPORT"
  | "STA_REPORT"
  | "POWER_REPORT"
  // G7-G9
  | "CONFIRMATION_TEST_PLAN"
  | "TEST_SPECIFICATION"
  | "TEST_RUN"
  | "COVERAGE_REPORT"
  | "CONFIRMATION_TEST_REPORT"
  | "BITSTREAM_PACKAGE"
  | "HARDWARE_TEST_RECORD"
  | "CONFIG_AUDIT"
  | "USER_MANUAL"
  | "DEVELOPMENT_SUMMARY"
  | "RELEASE_PACKAGE"
  // Governance / config
  | "CONFIGURATION_SNAPSHOT"
  | "GATE_SUBMISSION"
  | "APPROVAL_RECORD"
  | "APPROVED_GATE_RESULT"
  | "BASELINE"
  | "WAIVER"
  | "ISSUE_RISK_DECISION"
  | "TASK_HANDOFF"
  | "KNOWLEDGE_ENTRY";

// ── Actor types ───────────────────────────────────────────────────────────────

export type ActorType = "human" | "agent" | "connector" | "system";

// ── Data classification (Q-006 decision: reserved, formal level TBD) ──────────

export type DataClassification = "D1" | "D2" | "D3" | "D4" | "UNCLASSIFIED";
