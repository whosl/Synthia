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
export type { ConnectorCapability, EvidenceManifest };

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
export type LoopPhase = "generate_rtl" | "generate_testbench" | "generate_xdc" | "repair";

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

export interface RepairGeneration {
  readonly phase: "repair";
  readonly reasoning: string;
  /** Repaired RTL sources (full replacement). */
  readonly sources: readonly ArtifactFile[];
  /** Repaired testbench, when the failure pointed at the TB. */
  readonly testbench?: ArtifactFile;
}

export type LoopAction = RtlGeneration | TbGeneration | XdcGeneration | RepairGeneration;

/**
 * High-level model interface the loop depends on. Each method wraps one
 * structured LLM call guided by a skill method prompt. Implementations parse a
 * tool-call or strict-JSON response, validate it, and retry once on a malformed
 * response before surfacing a {@link ModelActionError}.
 */
export interface LoopModel {
  generateRtl(task: string, systemPrompt: string): Promise<RtlGeneration>;
  generateTestbench(rtl: readonly ArtifactFile[], topModule: string, systemPrompt: string): Promise<TbGeneration>;
  generateXdc(topModule: string, part: string, systemPrompt: string): Promise<XdcGeneration>;
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
  readonly evidence?: EvidenceManifest;
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
}

// ---------------------------------------------------------------------------
// Audit + results.
// ---------------------------------------------------------------------------

export type AuditCategory = "model" | "tool_call" | "gate" | "loop" | "lifecycle";

export interface AuditEvent {
  readonly ts: string;
  readonly category: AuditCategory;
  readonly phase: LoopPhase | WhitelistedOperation | "loop";
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

export interface LoopResult {
  readonly status: LoopStatus;
  readonly task: string;
  readonly part: string;
  readonly rtl?: RtlGeneration;
  readonly testbench?: TbGeneration;
  readonly xdc?: XdcGeneration;
  readonly evidence: readonly EvidenceSummary[];
  readonly audit: readonly AuditEvent[];
  readonly endedReason?: string;
}
