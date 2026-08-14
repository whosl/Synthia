/**
 * Synthia Core API — Connector port (IF-002 run/connector slice)
 *
 * Core's own abstraction over the remote Connector. The API handlers depend on
 * THIS interface only — never on `connector/*` directly — so the run/Job slice
 * is fully testable with an in-process fake and the heavy Connector client code
 * is isolated to the production adapter (`connector-adapter.ts`).
 *
 * Core is multi-project; the Connector client is single-project-scoped, so every
 * port method carries the `projectId` it acts on and the adapter fans out to a
 * per-project client. The fake ignores `projectId` (one fake serves all).
 */

import type { RunClass, ToolRunState } from "../domain/enums.ts";

// ─── submission input ────────────────────────────────────────────────────────

/** A source or constraint file attached to a Job submission. */
export interface SourceInput {
  readonly path: string;
  readonly content: string;
  readonly mediaType?: string;
}

/** Structured Job parameters — the body fields Core forwards to the Connector. */
export interface JobParameters {
  readonly sources: readonly SourceInput[];
  readonly top?: string;
  readonly testbench?: string;
  readonly part?: string;
  readonly constraints: readonly SourceInput[];
  readonly timeoutMs?: number;
}

/**
 * Authorization context the adapter forwards to the Connector so its client-side
 * gate_check/formal guards pass (remote.ts submit() requires these). Mirrors the
 * runtime's ApprovalContext shape without depending on connector/remote.ts.
 */
export interface ConnectorApproval {
  readonly gateSubmissionId?: string;
  readonly approvedGateResultId?: string;
  readonly baselineId?: string;
}

export interface SubmitJobParams {
  readonly jobId: string;
  readonly projectId: string;
  readonly operation: string;
  readonly runClass: RunClass;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly actor: { readonly actorType: string; readonly actorId: string };
  readonly parameters: JobParameters;
  /** Authorization context for gate_check/formal runs (undefined for exploratory). */
  readonly approval?: ConnectorApproval;
}

// ─── connector results ───────────────────────────────────────────────────────

/** Snapshot of a Connector Job's execution state at a point in time. */
export interface ConnectorJobSnapshot {
  readonly jobId: string;
  readonly state: ToolRunState;
  readonly outputSha256?: string;
  readonly errorCode?: string;
}

export interface EvidenceEntry {
  readonly name: string;
  readonly uri?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
}

export interface EvidenceManifest {
  readonly jobId: string;
  readonly entries: readonly EvidenceEntry[];
}

/** Decoded content payload of a single evidence artifact for a terminal Job. */
export interface EvidenceContent {
  readonly name: string;
  /** UTF-8 decoded content (may be truncated for large artifacts). */
  readonly content: string;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly mediaType: string;
}

export interface DiscoveredCapability {
  readonly operation: string;
  readonly version: string;
  readonly runClasses: readonly string[];
}

export interface ConnectorDiscovery {
  readonly capabilities: readonly DiscoveredCapability[];
  readonly drift: boolean;
}

// ─── port ────────────────────────────────────────────────────────────────────

/**
 * The operations Core performs against a Connector. Every method may throw
 * {@link ConnectorError}; the handler layer maps those to stable API errors.
 */
export interface ConnectorPort {
  /** A stable identifier for the Connector (persisted on `tool_run.connector_id`). */
  readonly connectorId: string;
  /** Discover capabilities / detect drift for a project scope. */
  discover(projectId: string): Promise<ConnectorDiscovery>;
  /** Submit a Job. Surfaces drift/lease/capability rejection by throwing. */
  submitJob(params: SubmitJobParams): Promise<ConnectorJobSnapshot>;
  /** Query the current execution state of a Job. */
  queryStatus(projectId: string, jobId: string): Promise<ConnectorJobSnapshot>;
  /** Fetch the frozen evidence manifest for a terminal Job. */
  fetchEvidence(projectId: string, jobId: string): Promise<EvidenceManifest>;
  /** Fetch the decoded content of a single evidence artifact for a terminal Job. */
  fetchEvidenceContent(projectId: string, jobId: string, name: string): Promise<EvidenceContent>;
}

// ─── error model ─────────────────────────────────────────────────────────────

/**
 * Failure reported by (or mapped from) the Connector. `code` is the stable
 * connector error vocabulary (e.g. `CAPABILITY_DRIFT`, `LEASE_EXPIRED`,
 * `JOB_NOT_FOUND`); `retryable` flags transient failures.
 */
export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: string, message?: string, retryable = false) {
    super(message ?? code);
    this.name = "ConnectorError";
    this.retryable = retryable;
  }
}

/** Codes that mean the Connector cannot currently serve the capability → 503. */
export const CAPABILITY_UNAVAILABLE_CODES: Record<string, true> = {
  CAPABILITY_DRIFT: true,
  CAPABILITY_UNAVAILABLE: true,
  CAPABILITY_UNSUPPORTED: true,
  LEASE_EXPIRED: true,
  ENDPOINT_NOT_APPROVED: true,
  ENDPOINT_REVOKED: true,
  PROJECT_SCOPE_MISMATCH: true,
  PROJECT_NOT_ALLOWED: true,
  CLASSIFICATION_NOT_ALLOWED: true,
  LICENSE_UNAVAILABLE: true,
  REMOTE_UNAVAILABLE: true,
  COMPATIBILITY_REJECTED: true,
  UNSUPPORTED_PROTOCOL: true,
  UNSUPPORTED_TRANSPORT: true,
  UNSUPPORTED_AUTH: true,
  INSECURE_ENDPOINT: true,
  ENDPOINT_NOT_ALLOWLISTED: true,
};

/** Codes that mean the referenced Job / evidence does not exist → 404. */
export const CONNECTOR_NOT_FOUND_CODES: Record<string, true> = {
  JOB_NOT_FOUND: true,
  EVIDENCE_NOT_AVAILABLE: true,
  EVIDENCE_CORRUPT: true,
};
