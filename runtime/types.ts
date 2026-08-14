/**
 * Synthia Runtime — shared types for the minimal task loop.
 *
 * The loop orchestrates: LLM (generates RTL/TB/XDC candidates) → Connector
 * (versioned vivado-batch-1 capabilities: validate_sources / simulate /
 * synthesize / implement). These types define the seams between those
 * components so the loop can be driven by a mock model + fake connector in
 * tests and by the real OpenAI-compatible client + Cloudflare remote connector
 * in production.
 */

// Re-exported connector primitives so runtime modules depend on a single source.
import type { ConnectorCapability, EvidenceManifest } from "../connector/index.ts";
import { sha256Hex } from "../core/src/hashing.ts";

/** A generated source / constraint artifact (path + content + optional media type). */
export interface ArtifactFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType?: string;
}

// ---------------------------------------------------------------------------
// Model side — what the loop asks the LLM to produce.
// ---------------------------------------------------------------------------

/** Phase tag for a single LLM action (also the JSON action discriminator). */
export type LoopPhase =
  | "generate_rtl"
  | "generate_testbench"
  | "generate_xdc"
  | "repair"
  | "generate_intake"
  | "generate_behavior_wave"
  | "generate_architecture"
  | "generate_register_spec";

export interface RtlGeneration {
  readonly phase: "generate_rtl";
  readonly reasoning: string;
  readonly topModule: string;
  readonly sources: readonly ArtifactFile[];
}

export interface TbGeneration {
  readonly phase: "generate_testbench";
  readonly reasoning: string;
  readonly testbenchModule: string;
  readonly testbench: ArtifactFile;
}

export interface XdcGeneration {
  readonly phase: "generate_xdc";
  readonly reasoning: string;
  readonly constraints: readonly ArtifactFile[];
}

/** A named upstream artifact section injected into downstream stage prompts. */
export interface UpstreamSection {
  readonly label: string;
  readonly content: string;
}
/** Ordered upstream artifacts rendered into a prompt as a dedicated section. */
export type UpstreamArtifacts = readonly UpstreamSection[];

/** A specification/design document produced by a doc-generation phase. */
export interface DocGeneration {
  readonly phase: "generate_intake" | "generate_behavior_wave" | "generate_architecture" | "generate_register_spec";
  readonly reasoning: string;
  /** Output path, e.g. doc/intake/summary.md. */
  readonly docPath: string;
  /** Full markdown content. */
  readonly content: string;
}

export interface RepairGeneration {
  readonly phase: "repair";
  readonly reasoning: string;
  /** Repaired RTL sources (full replacement). */
  readonly sources: readonly ArtifactFile[];
  /** Repaired testbench, when the failure pointed at the TB. */
  readonly testbench?: ArtifactFile;
}

export interface LoopModel {
  generateRtl(task: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<RtlGeneration>;
  generateTestbench(rtl: readonly ArtifactFile[], topModule: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<TbGeneration>;
  generateXdc(topModule: string, part: string, systemPrompt: string, allowPinAssignments: boolean, upstream?: UpstreamArtifacts): Promise<XdcGeneration>;
  repair(input: {
    sources: readonly ArtifactFile[];
    testbench?: ArtifactFile;
    topModule: string;
    testbenchModule?: string;
    stderr: string;
    stdout?: string;
    attempt: number;
    systemPrompt: string;
  }): Promise<RepairGeneration>;
  generateIntake(task: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration>;
  generateBehaviorWave(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration>;
  generateArchitecture(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration>;
  generateRegisterSpec(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration>;
}

/** Thrown when the model cannot produce a valid action within the retry budget. */
export class ModelActionError extends Error {
  constructor(message: string, readonly phase: LoopPhase, readonly attempts: number) {
    super(message);
    this.name = "ModelActionError";
  }
}

// ---------------------------------------------------------------------------
// Connector side — versioned vivado-batch-1 capability calls.
// ---------------------------------------------------------------------------

/** Whitelisted vivado operations the loop is permitted to invoke. */
export const WHITELISTED_OPERATIONS = ["validate_sources", "simulate", "synthesize", "implement"] as const;
export type WhitelistedOperation = (typeof WHITELISTED_OPERATIONS)[number];

export interface VivadoSubmission {
  readonly operation: WhitelistedOperation;
  readonly runClass: "exploratory";
  readonly projectId: string;
  readonly sources: readonly ArtifactFile[];
  readonly top: string;
  readonly part: string;
  /** testbench module name (simulate only). */
  readonly testbench?: string;
  /** XDC constraints (implement only). */
  readonly constraints?: readonly ArtifactFile[];
  readonly timeoutMs?: number;
}

export interface VivadoResult {
  readonly status: "succeeded" | "failed" | "timeout" | "lost" | "unsupported" | "unknown_effect";
  readonly jobId: string;
  readonly operation: WhitelistedOperation;
  readonly inputSha256: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly errorCode?: string;
  readonly evidence?: EvidenceManifest;
}

/** Decoded content of a single evidence artifact (from Core evidence/content endpoint). */
export interface EvidenceContent {
  readonly content: string;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly mediaType: string;
}

/**
 * Loop-facing connector abstraction. Both the fake (tests) and the Cloudflare
 * remote adapter (production) satisfy this. The loop never sends raw Tcl; it
 * only issues these versioned capability calls.
 */
export interface LoopConnector {
  readonly id: string;
  /** True once capability drift has been detected — the loop fails closed. */
  readonly drift: boolean;
  /** Returns the connector's declared capabilities (operation + version). */
  discover(): Promise<readonly ConnectorCapability[]>;
  /** Submit a vivado operation and resolve to a terminal result + evidence. */
  submit(request: VivadoSubmission): Promise<VivadoResult>;
  /** Fetch the decoded content of a named evidence artifact for a terminal job. */
  fetchEvidenceContent(jobId: string, name: string): Promise<EvidenceContent>;
}

// ---------------------------------------------------------------------------
// Audit + results.
// ---------------------------------------------------------------------------

export type AuditCategory = "model" | "tool_call" | "gate" | "loop" | "lifecycle" | "governance";

export interface AuditEvent {
  readonly ts: string;
  readonly seq: number;
  readonly category: AuditCategory;
  readonly phase: LoopPhase | WhitelistedOperation | "loop" | "governance" | "gate_review";
  readonly action: string;
  readonly inputSha256?: string;
  readonly jobId?: string;
  readonly result?: "ok" | "failed" | "fail_closed";
  readonly errorCode?: string;
  readonly detail?: string;
}

export interface EvidenceSummary {
  readonly jobId: string;
  readonly operation: WhitelistedOperation;
  readonly status: VivadoResult["status"];
  readonly inputSha256: string;
  readonly entries: ReadonlyArray<{ name: string; sha256: string; sizeBytes: number; mediaType: string }>;
}

export type LoopStatus = "succeeded" | "failed" | "fail_closed";

/** Structured cause for terminal failure (drives resume eligibility). */
export type TerminalCause = "governance_rejected" | "execution_error";

export interface LoopResult {
  readonly status: LoopStatus;
  readonly task: string;
  readonly part: string;
  readonly rtl?: RtlGeneration;
  readonly testbench?: TbGeneration;
  readonly xdc?: XdcGeneration;
  readonly docs?: ReadonlyArray<DocGeneration>;
  readonly evidence: readonly EvidenceSummary[];
  readonly audit: readonly AuditEvent[];
  readonly endedReason?: string;
  readonly runId?: string;
  /** Structured cause when status is failed/fail_closed (drives resume). */
  readonly terminalCause?: TerminalCause;
}

// ---------------------------------------------------------------------------
// Governance + GJB gate flow.
// ---------------------------------------------------------------------------

import type { ArtifactRevisionState, ArtifactType, GateId, GateSubmissionState } from "../core/src/domain/enums.ts";
export type { ArtifactRevisionState, ArtifactType, GateId, GateSubmissionState };

/** GJB gates in the runtime stage chain. */
export const GJB_GATES = ["G1", "G2", "G3", "G4"] as const;
export type GjbGate = (typeof GJB_GATES)[number];

/** Stages of the runtime phase chain, in execution order. */
export type StageId =
  | "intake"
  | "behavior_wave"
  | "architecture"
  | "register_spec"
  | "rtl_build"
  | "validate"
  | "tb"
  | "simulate"
  | "xdc"
  | "synthesize"
  | "implement";

/** Gate placement: which stages run before reaching each gate. */
export const GATE_AFTER_STAGE: Readonly<Record<GjbGate, StageId>> = {
  G1: "intake",
  G2: "behavior_wave",
  G3: "register_spec",
  G4: "implement",
};

/** A registered candidate revision returned by Core. */
export interface RegisteredRevision {
  readonly revisionId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  /** Doc path or artifact location (populated by the loop for display). */
  readonly contentLocation?: string;
}

/** Read-only project overview (GET /api/v1/projects/:projectId). */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly scope: string;
  readonly dataClassification: string;
  readonly targetPart: string;
  readonly standardVersion: string;
  /** Process instances on this project (current_gate hints the milestone). */
  readonly processInstances: readonly {
    readonly id: string;
    readonly currentGate: string;
    readonly gateProfileVersion: string;
  }[];
}

/** A gate submission row (GET /projects/:projectId/gate-submissions[?state=]). */
export interface GateSubmissionSummary {
  readonly id: string;
  readonly gate: GateId;
  readonly state: GateSubmissionState;
  readonly snapshotId: string;
  readonly processInstanceId: string;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}

/** An artifact container row (GET /projects/:projectId/artifacts). */
export interface ArtifactSummary {
  readonly id: string;
  readonly artifactType: ArtifactType;
  readonly createdAt: string;
}

/** An artifact revision row (GET .../artifacts/:artifactId/revisions; version desc). */
export interface ArtifactRevisionSummary {
  readonly id: string;
  readonly version: number;
  readonly state: ArtifactRevisionState;
  readonly contentHash: string;
  readonly contentLocation: string;
  readonly title: string;
  readonly createdAt: string;
}

/** An outbox event row (GET /projects/:projectId/events); payload intentionally omitted. */
export interface ProjectEventSummary {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly occurredAt: string;
}

/** A Core API governance client the loop calls to register artifacts and manage gates. */
export interface GovernanceClient {
  /** Register a candidate ArtifactRevision for the given artifact.
   *  `version` must be strictly greater than the artifact's current revision
   *  version (1 for the first, 2+ for repairs/re-registrations). */
  registerCandidateArtifact(input: {
    artifactId: string;
    artifactType: ArtifactType;
    title: string;
    content: string;
    contentLocation: string;
    changeReason?: string;
    version: number;
  }): Promise<RegisteredRevision>;
  /** Create a ConfigurationSnapshot freezing the given revisions. */
  createSnapshot(input: {
    memberRevisionIds: readonly string[];
    toolModelPolicyHash: string;
  }): Promise<{ snapshotId: string }>;
  /** Create a GateSubmission (state=preparing) and return its id. */
  createGateSubmission(input: {
    processInstanceId: string;
    gate: GateId;
    snapshotId: string;
  }): Promise<{ submissionId: string }>;
  /** Submit a gate submission for review (preparing→in_review). */
  submitGate(submissionId: string): Promise<{ state: GateSubmissionState }>;
  /** Get the current state of a gate submission (poll for approval). */
  getGateSubmissionState(submissionId: string): Promise<{ state: GateSubmissionState }>;
  /** Read-only project overview (meta + process instances). */
  getProjectInfo(projectId: string): Promise<ProjectInfo>;
  /** List gate submissions for a project; optional state filter. */
  listGateSubmissions(projectId: string, state?: GateSubmissionState): Promise<readonly GateSubmissionSummary[]>;
  /** List artifact containers in a project. */
  listArtifacts(projectId: string): Promise<readonly ArtifactSummary[]>;
  /** List revisions of an artifact (version descending). */
  listRevisions(projectId: string, artifactId: string): Promise<readonly ArtifactRevisionSummary[]>;
  /** List recent outbox events for a project (most recent first, bounded by limit). */
  listEvents(projectId: string, limit?: number): Promise<readonly ProjectEventSummary[]>;
}

/** A no-op governance client for --no-governance mode (dev/debug only). */
export class NoGovernanceClient implements GovernanceClient {
  private counter = 0;
  private nextId(prefix: string): string {
    return `${prefix}-nogov-${++this.counter}`;
  }
  async registerCandidateArtifact(input: { content: string; version: number }): Promise<RegisteredRevision> {
    return {
      revisionId: this.nextId("rev"),
      artifactId: this.nextId("art"),
      version: input.version,
      contentHash: sha256Hex(input.content),
    };
  }
  async createSnapshot(): Promise<{ snapshotId: string }> {
    return { snapshotId: this.nextId("snap") };
  }
  async createGateSubmission(): Promise<{ submissionId: string }> {
    return { submissionId: this.nextId("sub") };
  }
  async submitGate(): Promise<{ state: GateSubmissionState }> {
    return { state: "approved" as GateSubmissionState };
  }
  async getGateSubmissionState(): Promise<{ state: GateSubmissionState }> {
    return { state: "approved" as GateSubmissionState };
  }
  async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    return {
      id: projectId,
      name: projectId,
      status: "active",
      scope: "",
      dataClassification: "UNCLASSIFIED",
      targetPart: "",
      standardVersion: "",
      processInstances: [],
    };
  }
  async listGateSubmissions(): Promise<readonly GateSubmissionSummary[]> {
    return [];
  }
  async listArtifacts(): Promise<readonly ArtifactSummary[]> {
    return [];
  }
  async listRevisions(): Promise<readonly ArtifactRevisionSummary[]> {
    return [];
  }
  async listEvents(): Promise<readonly ProjectEventSummary[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Run-state persistence.
// ---------------------------------------------------------------------------
export interface RunState {
  readonly runId: string;
  readonly task: string;
  readonly part: string;
  readonly projectId: string;
  /** Process instance id for gate-submission governance (server-injected). */
  readonly processInstanceId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Current stage being executed or next to execute on resume. */
  readonly currentStage: StageId;
  /** Gate currently awaiting approval (when status is awaiting_approval). */
  readonly awaitingGate?: GateId;
  /** Loop status: running / paused awaiting approval / terminal. */
  readonly status: "running" | "awaiting_approval" | "succeeded" | "failed" | "fail_closed";
  /** Registered doc artifacts keyed by stage. */
  readonly docs?: Readonly<Partial<Record<StageId, RegisteredRevision>>>;
  /** Registered RTL revision (rtl_build stage). */
  readonly rtlRevision?: RegisteredRevision;
  /** Persisted RTL sources so tool stages can resume without re-calling the model. */
  readonly rtlArtifacts?: { readonly topModule: string; readonly sources: readonly ArtifactFile[] };
  /** Persisted testbench so simulate stage can resume. */
  readonly tbArtifacts?: { readonly testbenchModule: string; readonly testbench: ArtifactFile };
  /** Persisted XDC constraints so implement stage can resume. */
  readonly xdcArtifacts?: { readonly constraints: readonly ArtifactFile[] };
  /** Map of gate → submission id for polling on resume. */
  readonly gateSubmissions?: Readonly<Partial<Record<GateId, string>>>;
  /** Gate decisions: approved / rejected / withdrawn. */
  readonly gateDecisions?: Readonly<Partial<Record<GateId, "approved" | "rejected" | "withdrawn">>>;
  readonly endedReason?: string;
  /** Structured cause for terminal failure (drives resume eligibility). */
  readonly terminalCause?: TerminalCause;
  /**
   * 自由 Agent 门禁锁定：core_submit_gate 成功后置位，core_check_gate approved
   * 或 unlockGate 清除。持久化进 run-state，重启后仍锁定（会话恢复时据此置位）。
   */
  readonly freeAgentLock?: { readonly gate: GateId; readonly submissionId: string };
}
