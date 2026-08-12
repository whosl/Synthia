/**
 * Synthia Core — Domain Entities
 *
 * Maps to SYNTHIA-ARC-002 §2 (domain object families) and §4 (snapshot/submission/approval/baseline flow).
 * Fields follow SYNTHIA-FLOW-002 §2 (common metadata) and §3 (object family states).
 * These are plain data types — no methods, no ORM. State transitions go through state-machines.ts.
 */

import type {
  ApprovalDecision,
  ArtifactRevisionState,
  ArtifactType,
  ActorType,
  BaselineKind,
  BaselineState,
  DataClassification,
  GateId,
  GateSubmissionState,
  RunClass,
  ToolRunState,
  TraceRelationState,
} from "./enums.ts";

// ── Project & Process (ARC-002 §2 row 1) ──────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  scope: string;
  dataClassification: DataClassification;
  standardVersion: string;       // e.g. "GB/T 33781-2017"
  targetPart: string;            // e.g. "xc7vx690tffg1761-2" (Q-002)
  toolchainProfileRef: string | null;
  createdAt: string;             // ISO 8601
  status: "active" | "archived";
}

export interface ProcessInstance {
  id: string;
  projectId: string;
  gateProfileVersion: string;
  currentGate: GateId;
  createdAt: string;
}

export interface RoleAssignment {
  id: string;
  projectId: string;
  actorType: ActorType;
  actorId: string;               // human user id or agent service identity
  role: string;                  // project/design/verification/quality/config/standards/safety/hardware
  permissions: string;           // JSON: allowed P-levels per operation class
  assignedAt: string;
}

// ── Content (ARC-002 §2 row 2, §3 container/member granularity) ───────────────

export interface Artifact {
  id: string;                    // project-unique, non-reusable (FLOW-002 §2)
  projectId: string;
  artifactType: ArtifactType;
  title: string;
  createdAt: string;
}

export interface ArtifactRevision {
  id: string;                    // revision UUID
  artifactId: string;
  projectId: string;
  version: number;               // monotonic within artifact
  state: ArtifactRevisionState;
  parentRevisionId: string | null;
  contentHash: string;           // SHA-256 of content (FLOW-002 §2)
  contentLocation: string;       // git ref, DB jsonb, or object storage URI
  content: string | null;        // inline content when stored in DB; null when out-of-band
  schemaVersion: string;
  sourceIds: string[];           // source artifact/requirement/decision/run IDs
  dataClassification: DataClassification;
  toolModelProvenance: object | null; // model/prompt/kb/tool version when AI-generated
  changeReason: string;
  createdBy: string;             // actor id
  createdByType: ActorType;
  createdAt: string;
  reviewIds: string[];           // review/issue/waiver/approval record IDs
}

// ── Configuration & Governance (ARC-002 §2 row 3-4, §4) ───────────────────────

export interface ConfigurationSnapshot {
  id: string;
  projectId: string;
  memberRevisionIds: string[];   // frozen list of artifact revision IDs
  traceRelationIds: string[];    // frozen trace relation IDs
  gateProfileVersion: string;
  toolModelPolicyHash: string;
  manifestHash: string;          // sorted-normalized manifest hash (ARC-004 §6)
  createdAt: string;
  createdBy: string;
}

export interface GateSubmission {
  id: string;
  projectId: string;
  processInstanceId: string;
  gate: GateId;
  snapshotId: string;            // frozen ConfigurationSnapshot being submitted
  state: GateSubmissionState;
  submitterId: string;
  checkResults: object | null;   // deterministic check output
  issues: string[];              // open issue/risk IDs
  createdAt: string;
  submittedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  projectId: string;
  gateSubmissionId: string;
  decision: ApprovalDecision;
  approverId: string;            // individual human identity (never agent/connector)
  approverRole: string;
  authorizationBasis: string;    // why this person can approve
  reason: string;
  issues: string[];
  risks: string[];
  waivers: string[];
  checkResultsHash: string;
  signedAt: string;              // timestamp
  signatureMethod: string;       // how signed
  clientAuditDigest: string | null;
  approvedGateResultId: string | null; // set when decision=approve
  createdAt: string;
}

export interface ApprovedGateResult {
  id: string;
  projectId: string;
  gate: GateId;
  gateSubmissionId: string;
  approvalRecordId: string;
  snapshotId: string;
  createdAt: string;
}

export interface Baseline {
  id: string;
  projectId: string;
  kind: BaselineKind;            // B0-B4
  state: BaselineState;
  approvedGateResultId: string;
  memberRevisionIds: string[];
  traceRelationIds: string[];
  manifestHash: string;
  approvalRecordId: string;
  createdAt: string;
  supersededByBaselineId: string | null;
}

// ── Execution (ARC-002 §2 row 5) ──────────────────────────────────────────────

export interface ToolRun {
  id: string;
  projectId: string;
  operation: string;             // e.g. "vivado_synthesize"
  capabilityVersion: string;
  runClass: RunClass;
  state: ToolRunState;
  inputSnapshotId: string | null;
  inputManifestHash: string | null;
  authorizationContext: object;  // GateSubmission ID, Baseline ID, or exploratory
  toolchainProfileHash: string | null;
  connectorId: string | null;
  workerId: string | null;
  command: string | null;
  parameters: object | null;
  returnCode: number | null;
  startTime: string | null;
  endTime: string | null;
  correlationId: string;
  createdAt: string;
}

export interface Evidence {
  id: string;
  toolRunId: string;
  projectId: string;
  artifactId: string;            // object storage key = SHA-256
  uri: string;                   // MinIO path (S3-compatible)
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  completeness: "full" | "partial";
  orphaned: boolean;
  corrupt: boolean;
  createdAt: string;
}

// ── Trace (ARC-002 §2 row 6) ──────────────────────────────────────────────────

export interface TraceRelation {
  id: string;
  projectId: string;
  sourceType: string;            // "requirement" | "design" | "rtl" | "test" | "evidence" | "bitstream"
  sourceId: string;              // artifact revision ID
  targetType: string;
  targetId: string;             // artifact revision ID
  relationKind: string;          // "satisfies" | "implements" | "verifies" | "traces_to"
  state: TraceRelationState;
  basis: string;                 // why this relation exists
  dataClassification: DataClassification;
  createdBy: string;
  createdAt: string;
}

// ── Approval & idempotency (ARC-002 §6 invariants) ────────────────────────────

/**
 * Structured actor submitting an approval. Only `human` actors may approve;
 * agents/connectors/system are hard-denied at the repository boundary.
 */
export interface ApproverActor {
  actorType: ActorType;
  actorId: string;
}

/**
 * Structured idempotency scope. Two operations with the same scope key are
 * the same logical operation; a differing requestHash under the same key is a
 * stable conflict (ARC-002 §6).
 */
export interface IdempotencyScope {
  actorType: ActorType;
  actorId: string;
  projectId: string;
  operation: string;
  key: string;
}

/**
 * Stored idempotency record: the scope key, the canonical payload hash, and
 * the cached result payload so replays return the original answer.
 */
export interface IdempotencyRecord {
  scopeKey: string;
  requestHash: string;
  result: unknown;
}
