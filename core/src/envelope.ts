/**
 * Synthia Core — Command / Query / Event / Error envelopes
 *
 * Fixes the service-boundary interaction semantics of SYNTHIA-IF-001:
 *  - §2: commands carry identity, project, expected version and idempotency key;
 *         queries select an explicit configuration view.
 *  - §6: events describe facts already happened, keyed by event_id for idempotency.
 *  - §7: errors carry a stable code, retryability, and objective detail references.
 *
 * All envelopes are immutable value objects (readonly fields).
 */

import type { ActorType, DataClassification } from "./domain/enums.ts";

// ── Actor ────────────────────────────────────────────────────────────────────

export interface Actor {
  readonly actorType: ActorType;
  readonly actorId: string;
  /** Project role (project/design/verification/quality/...); null for system/connector. */
  readonly role: string | null;
}

/** Construct an actor value. */
export function actor(
  actorType: ActorType,
  actorId: string,
  role: string | null = null,
): Actor {
  return { actorType, actorId, role };
}

// ── Command envelope (IF-001 §2) ─────────────────────────────────────────────
//
// Commands express a permissioned state-change request. They MUST carry:
//   identity (actor), project, expected version (optimistic concurrency),
//   and an idempotency key (commandId).

export interface CommandEnvelope<TPayload> {
  /** Idempotency key; replaying the same key is a no-op. */
  readonly commandId: string;
  /** End-to-end correlation id; defaults to commandId when omitted. */
  readonly correlationId: string;
  /** Event/command that caused this one; null for originators. */
  readonly causationId: string | null;
  readonly actor: Actor;
  readonly projectId: string;
  /** Optimistic-concurrency guard (ARC-002 §7); null when not applicable. */
  readonly expectedVersion: number | null;
  readonly classification: DataClassification;
  readonly payload: TPayload;
}

export function makeCommand<TPayload>(args: {
  commandId: string;
  correlationId?: string;
  causationId?: string | null;
  actor: Actor;
  projectId: string;
  expectedVersion?: number | null;
  classification: DataClassification;
  payload: TPayload;
}): CommandEnvelope<TPayload> {
  return {
    commandId: args.commandId,
    correlationId: args.correlationId ?? args.commandId,
    causationId: args.causationId ?? null,
    actor: args.actor,
    projectId: args.projectId,
    expectedVersion: args.expectedVersion ?? null,
    classification: args.classification,
    payload: args.payload,
  };
}

// ── Query envelope & view (IF-001 §2) ────────────────────────────────────────
//
// Queries only return a configuration view the caller is authorized to see, and
// MUST name either the candidate workspace or an approved baseline — never mix
// the latest workspace with historical approved versions (ARC-002 §6 invariant 10).

export type QueryView =
  | { readonly kind: "candidate"; readonly workspaceId: string }
  | { readonly kind: "baseline"; readonly baselineId: string }
  | { readonly kind: "snapshot"; readonly snapshotId: string };

export interface QueryEnvelope {
  readonly queryId: string;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly projectId: string;
  readonly view: QueryView;
  readonly classification: DataClassification;
}

export function makeQuery(args: {
  queryId: string;
  correlationId?: string;
  actor: Actor;
  projectId: string;
  view: QueryView;
  classification: DataClassification;
}): QueryEnvelope {
  return {
    queryId: args.queryId,
    correlationId: args.correlationId ?? args.queryId,
    actor: args.actor,
    projectId: args.projectId,
    view: args.view,
    classification: args.classification,
  };
}

// ── Event envelope (IF-001 §6) ───────────────────────────────────────────────
//
// Events describe facts already happened and are appended monotonically per
// aggregate (sequence). Consumers dedupe by event_id and detect loss/reorder by
// sequence. payload_hash binds the payload immutably.

export interface EventEnvelope<TPayload> {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Monotonic per-aggregate sequence; gaps signal loss/reorder. */
  readonly sequence: number;
  readonly projectId: string;
  readonly occurredAt: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly classification: DataClassification;
  readonly payloadHash: string;
  readonly payload: TPayload;
}

// ── Error model (IF-001 §7) ──────────────────────────────────────────────────
//
// Stable error codes; retryability flag; objective detail reference instead of a
// natural-language model explanation as the sole basis.

export type ErrorCode =
  | "validation"
  | "authorization"
  | "conflict"
  | "capability_unavailable"
  | "resource_locked"
  | "tool_failure"
  | "output_incomplete"
  | "timeout"
  | "cancelled"
  | "worker_lost"
  | "unknown_effect"
  | "evidence_corrupt";

export interface ErrorDetail {
  readonly code: ErrorCode;
  /** Stable, objective message (not a model explanation). */
  readonly message: string;
  /** Whether a retry with the same request is semantically safe. */
  readonly retryable: boolean;
  /** Objective reference (artifact id, run id, log ref); never null-as-explanation. */
  readonly detailsRef: string | null;
}

export interface ResponseError {
  readonly error: ErrorDetail;
  readonly correlationId: string;
  readonly commandId: string | null;
  readonly causationId: string | null;
  /** Data classification propagated from the originating envelope (IF-001 §7). */
  readonly classification: DataClassification;
}

export function makeError(args: {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  detailsRef?: string | null;
  correlationId: string;
  commandId?: string | null;
  causationId?: string | null;
  /** Classification propagated from the originating command/query (IF-001 §7). */
  classification?: DataClassification;
}): ResponseError {
  return {
    error: {
      code: args.code,
      message: args.message,
      retryable: args.retryable ?? false,
      detailsRef: args.detailsRef ?? null,
    },
    correlationId: args.correlationId,
    commandId: args.commandId ?? null,
    causationId: args.causationId ?? null,
    classification: args.classification ?? "UNCLASSIFIED",
  };
}

/** Stable, non-retryable conflict error (optimistic-version / duplicate-key). */
export function conflictError(
  message: string,
  correlationId: string,
  commandId: string | null = null,
  classification: DataClassification = "UNCLASSIFIED",
): ResponseError {
  return makeError({
    code: "conflict",
    message,
    retryable: false,
    correlationId,
    commandId,
    classification,
  });
}

/** Stable authorization error (RBAC / restricted operation by agent). */
export function authorizationError(
  message: string,
  correlationId: string,
  commandId: string | null = null,
  classification: DataClassification = "UNCLASSIFIED",
): ResponseError {
  return makeError({
    code: "authorization",
    message,
    retryable: false,
    correlationId,
    commandId,
    classification,
  });
}
export function error(code: string, category: string, message: string, correlationId: string, retryable = false): { ok: false; error: ErrorDetail & { code: string; category: string; classification: DataClassification } } {
  return { ok: false, error: { code: code as ErrorCode, category, retryable, message, correlationId, detailsRef: null, commandId: null, classification: "UNCLASSIFIED" } };
}
