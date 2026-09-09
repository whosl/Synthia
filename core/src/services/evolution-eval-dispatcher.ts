import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  EVOLUTION_EVAL_LIMITS,
  canonicalEvolutionEvalEvidenceManifest,
  evolutionEvalCanonicalHash,
  validateEvolutionEvalParameters,
  type EvolutionEvalOperation,
} from "../domain/evolution-eval.ts";
import {
  EVOLUTION_EVAL_DISPATCHER_DEFAULT_LEASE_MS,
  EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES,
  evolutionEvalDispatcherDutyForEvent,
  isEvolutionEvalDefinitiveCancelBoundary,
  isEvolutionEvalDispatcherEventType,
  requireEvolutionEvalDispatcherLeaseMs,
  type EvolutionEvalDispatcherLease,
} from "../domain/evolution-eval-dispatcher.ts";
import {
  appendOutboxEventInTx,
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import type {
  CoreIssuedEvalBinding,
  EvalEvidenceAckRequestV1,
  EvalEvidenceCleanupRequestV1,
  EvalEvidenceCorruptAckRequestV1,
  EvalPreflight,
  EvalEvidenceConnectorManifestV1,
  EvalLedgerQuery,
  EvalRetentionResult,
  EvolutionEvalConnectorPort,
  EvolutionEvalDispatchRequestV1,
  SealedEvalInput,
} from "./evolution-eval-connector-port.ts";
import { evolutionEvalDiscardAuthorizationHash } from "./evolution-eval-connector-port.ts";
import { loadEvolutionEvalSealedInput } from "./evolution-eval-sealed-input.ts";

type Row = Record<string, unknown>;

export interface EvolutionEvalDispatcherClaimOptions {
  readonly holderId: string;
  readonly leaseMs?: number;
  readonly leaseNonce?: string;
}

export const EVOLUTION_EVAL_DISPATCHER_ACTOR_ID =
  "service:synthia-core-evolution-eval-dispatcher";
export const EVOLUTION_EVAL_EVIDENCE_TEMP_ROOT = join(
  tmpdir(),
  "synthia-evolution-eval-evidence-v1",
);

export type EvolutionEvalDispatchFenceResult =
  | {
      readonly status: "ready";
      readonly binding: CoreIssuedEvalBinding;
      readonly newlyFenced: boolean;
    }
  | {
      readonly status: "no_op";
      readonly reason:
        | "published"
        | "tombstoned"
        | "terminal"
        | "event_mismatch"
        | "policy_blocked";
    };

export interface EvolutionEvalDispatchFencePolicy {
  readonly newEffectsEnabled: boolean;
  readonly rolloutEnabled: boolean;
  readonly spoolAvailable: boolean;
}

export class EvolutionEvalDispatcherLeaseLostError extends Error {
  constructor() {
    super("EVOLUTION_EVAL_DISPATCHER_LEASE_LOST");
    this.name = "EvolutionEvalDispatcherLeaseLostError";
  }
}

export class EvolutionEvalConnectorObservationError extends Error {
  constructor(message = "EVOLUTION_EVAL_CONNECTOR_OBSERVATION_INVALID") {
    super(message);
    this.name = "EvolutionEvalConnectorObservationError";
  }
}

export class EvolutionEvalEvidenceCorruptError extends Error {
  constructor(message = "EVOLUTION_EVAL_EVIDENCE_CORRUPT") {
    super(message);
    this.name = "EvolutionEvalEvidenceCorruptError";
  }
}

export function evolutionEvalEvidenceCorruptionCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = String((error as Error & { readonly code: unknown }).code);
  if (code === "EVIDENCE_LIMIT_EXCEEDED") {
    return "EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED";
  }
  if (code === "EVIDENCE_CORRUPT" || code === "COMPATIBILITY_REJECTED") {
    return "EVOLUTION_EVAL_EVIDENCE_CORRUPT";
  }
  return null;
}

export interface VerifiedEvolutionEvalEvidenceManifest {
  readonly connectorManifest: EvalEvidenceConnectorManifestV1;
  readonly coreManifest: ReturnType<typeof canonicalEvolutionEvalEvidenceManifest>["manifest"];
  readonly coreManifestHash: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

function plain(value: unknown): value is Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Row, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  const sortedExpected = [...expected].sort();
  return keys.every((key) => typeof key === "string")
    && keys.length === sortedExpected.length
    && (keys as string[]).sort().every((key, index) => key === sortedExpected[index]);
}

function requireOpaqueId(value: string, label: string): string {
  const length = Buffer.byteLength(value, "utf8");
  if (length < 1 || length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a 1-128 byte opaque identifier`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is not a timestamp`);
  return date.toISOString();
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.endsWith("Z")
    && Number.isFinite(Date.parse(value));
}

function leaseNonceHash(leaseNonce: string): string {
  return createHash("sha256").update(leaseNonce, "utf8").digest("hex");
}

export function validateEvolutionEvalEvidenceConnectorManifest(
  binding: CoreIssuedEvalBinding,
  toolRunId: string,
  input: unknown,
): VerifiedEvolutionEvalEvidenceManifest {
  if (!plain(input) || !exactKeys(input, [
    "schema",
    "eval_job_id",
    "connector_job_id",
    "dispatch_request_hash",
    "entries",
    "manifest_hash",
  ])) {
    throw new EvolutionEvalEvidenceCorruptError();
  }
  if (
    input.schema !== "evolution-eval-connector-evidence-manifest.v1"
    || input.eval_job_id !== binding.dispatch.eval_job_id
    || input.connector_job_id !== binding.dispatch.connector_job_id
    || input.dispatch_request_hash !== binding.dispatch_request_hash
    || typeof input.manifest_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(input.manifest_hash)
    || !Array.isArray(input.entries)
  ) {
    throw new EvolutionEvalEvidenceCorruptError();
  }
  let canonicalCore: ReturnType<typeof canonicalEvolutionEvalEvidenceManifest>;
  try {
    canonicalCore = canonicalEvolutionEvalEvidenceManifest({
      schema: "evolution-eval-evidence-manifest.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      tool_run_id: toolRunId,
      entries: input.entries,
    });
  } catch {
    throw new EvolutionEvalEvidenceCorruptError();
  }
  if (!sameCanonicalValue(input.entries, canonicalCore.manifest.entries)) {
    throw new EvolutionEvalEvidenceCorruptError(
      "EVOLUTION_EVAL_EVIDENCE_CANONICAL_DRIFT",
    );
  }
  const connectorPreimage = {
    schema: "evolution-eval-connector-evidence-manifest.v1",
    eval_job_id: binding.dispatch.eval_job_id,
    connector_job_id: binding.dispatch.connector_job_id,
    dispatch_request_hash: binding.dispatch_request_hash,
    entries: canonicalCore.manifest.entries,
  };
  if (evolutionEvalCanonicalHash(connectorPreimage) !== input.manifest_hash) {
    throw new EvolutionEvalEvidenceCorruptError(
      "EVOLUTION_EVAL_EVIDENCE_MANIFEST_HASH_MISMATCH",
    );
  }
  return {
    connectorManifest: structuredClone(input) as unknown as EvalEvidenceConnectorManifestV1,
    coreManifest: canonicalCore.manifest,
    coreManifestHash: canonicalCore.sha256,
  };
}

export function validateEvolutionEvalLedgerObservation(
  binding: CoreIssuedEvalBinding,
  input: unknown,
): EvalLedgerQuery {
  if (!plain(input) || typeof input.state !== "string") {
    throw new EvolutionEvalConnectorObservationError();
  }
  const common = [
    "schema",
    "state",
    "connector_job_id",
    "connector_idempotency_key",
    "dispatch_request_hash",
    "ledger_epoch",
  ] as const;
  const extraByState: Readonly<Record<string, readonly string[]>> = {
    proven_never_accepted: ["replay_permitted"],
    accepted: ["execution_state", "accepted_at"],
    terminal: ["terminal_state", "process_stopped", "terminal_at", "error_code"],
    transient_unavailable: ["retryable", "error_code"],
    ambiguous: ["effect_possible", "error_code"],
    ledger_corrupt: ["replay_permitted", "error_code"],
  };
  const extras = extraByState[input.state];
  if (!extras || !exactKeys(input, [...common, ...extras])) {
    throw new EvolutionEvalConnectorObservationError();
  }
  if (
    input.schema !== "evolution-eval-ledger-query.v1"
    || input.connector_job_id !== binding.dispatch.connector_job_id
    || input.connector_idempotency_key !== binding.dispatch.connector_idempotency_key
    || input.dispatch_request_hash !== binding.dispatch_request_hash
    || typeof input.ledger_epoch !== "string"
    || Buffer.byteLength(input.ledger_epoch, "utf8") < 1
    || Buffer.byteLength(input.ledger_epoch, "utf8") > 128
    || /[\u0000-\u001f\u007f]/u.test(input.ledger_epoch)
  ) {
    throw new EvolutionEvalConnectorObservationError("EVOLUTION_EVAL_CONNECTOR_BINDING_CONFLICT");
  }
  if (
    (input.state === "proven_never_accepted" && typeof input.replay_permitted !== "boolean")
    || (input.state === "accepted" && (
      !(["queued", "preparing", "running"] as const).includes(input.execution_state as never)
      || !validTimestamp(input.accepted_at)
    ))
    || (input.state === "terminal" && (
      !(["succeeded", "failed", "cancelled", "timeout"] as const).includes(input.terminal_state as never)
      || input.process_stopped !== true
      || !validTimestamp(input.terminal_at)
      || !(input.error_code === null || (
        typeof input.error_code === "string" && ERROR_CODE.test(input.error_code)
      ))
    ))
    || (input.state === "transient_unavailable" && (
      input.retryable !== true
      || typeof input.error_code !== "string"
      || !ERROR_CODE.test(input.error_code)
    ))
    || (input.state === "ambiguous" && (
      input.effect_possible !== true
      || typeof input.error_code !== "string"
      || !ERROR_CODE.test(input.error_code)
    ))
    || (input.state === "ledger_corrupt" && (
      input.replay_permitted !== false
      || typeof input.error_code !== "string"
      || !ERROR_CODE.test(input.error_code)
    ))
  ) {
    throw new EvolutionEvalConnectorObservationError();
  }
  return structuredClone(input) as unknown as EvalLedgerQuery;
}

function parseLease(row: Row, leaseNonce: string): EvolutionEvalDispatcherLease {
  const eventType = String(row.event_type);
  if (!isEvolutionEvalDispatcherEventType(eventType)) {
    throw new Error("EVOLUTION_EVAL_DISPATCHER_EVENT_NOT_ALLOWED");
  }
  const duty = evolutionEvalDispatcherDutyForEvent(eventType);
  if (!duty) throw new Error("EVOLUTION_EVAL_DISPATCHER_EVENT_NOT_ALLOWED");
  const attemptCount = Number(row.attempt_count);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error("EVOLUTION_EVAL_DISPATCHER_LEASE_CORRUPT");
  }
  return {
    eventId: String(row.event_id),
    eventType,
    duty,
    aggregateId: String(row.aggregate_id),
    holderId: String(row.holder_id),
    leaseNonce,
    leaseExpiresAt: iso(row.lease_expires_at, "lease_expires_at"),
    attemptCount,
  };
}

/**
 * Claims exactly one unpublished dispatcher duty.
 *
 * The transaction touches only the outbox row and dispatcher lease. It is
 * committed before the caller can issue a Connector RPC, so this helper must
 * never be moved inside a run/job state transaction.
 */
export async function claimNextEvolutionEvalDuty(
  client: TransactionClient,
  options: EvolutionEvalDispatcherClaimOptions,
): Promise<EvolutionEvalDispatcherLease | null> {
  const holderId = requireOpaqueId(options.holderId, "holderId");
  const leaseMs = requireEvolutionEvalDispatcherLeaseMs(
    options.leaseMs ?? EVOLUTION_EVAL_DISPATCHER_DEFAULT_LEASE_MS,
  );
  const leaseNonce = options.leaseNonce ?? randomUUID();
  if (!UUID.test(leaseNonce)) throw new TypeError("leaseNonce must be a UUID");
  const nonceHash = leaseNonceHash(leaseNonce);

  return withTransaction(client, async (tx) => {
    const result = await tx.query(
      `WITH candidate AS (
         SELECT o.event_id,o.event_type,o.aggregate_id
           FROM outbox_events o
          WHERE o.published_at IS NULL
            AND o.event_type=ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_dispatcher_lease active
               WHERE active.event_id=o.event_id
                 AND active.lease_expires_at>clock_timestamp()
            )
          ORDER BY o.occurred_at,o.event_id
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1
       ), claimed AS (
         INSERT INTO evolution_eval_dispatcher_lease
           (event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
            lease_expires_at,attempt_count,claimed_at,updated_at)
         SELECT event_id,event_type,aggregate_id,$2,$3,
                clock_timestamp()+($4::int * interval '1 millisecond'),
                1,clock_timestamp(),clock_timestamp()
           FROM candidate
         ON CONFLICT (event_id) DO UPDATE
           SET event_type=EXCLUDED.event_type,
               aggregate_id=EXCLUDED.aggregate_id,
               holder_id=EXCLUDED.holder_id,
               lease_nonce_hash=EXCLUDED.lease_nonce_hash,
               lease_expires_at=EXCLUDED.lease_expires_at,
               attempt_count=evolution_eval_dispatcher_lease.attempt_count+1,
               claimed_at=clock_timestamp(),
               updated_at=clock_timestamp()
         WHERE evolution_eval_dispatcher_lease.lease_expires_at<=clock_timestamp()
         RETURNING event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
                   lease_expires_at,attempt_count
       )
       SELECT * FROM claimed`,
      [EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES, holderId, nonceHash, leaseMs],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? parseLease(row, leaseNonce) : null;
  });
}

/**
 * Claims one unpublished reconciliation duty for a specific Curator run.
 * API recovery uses this after its intent transaction commits, so it cannot
 * accidentally query a different run or perform an RPC while holding DB
 * locks. The ordinary dispatcher may race this claim; SKIP LOCKED makes the
 * winner authoritative and the loser observes the durable required state.
 */
export async function claimEvolutionEvalReconcileDutyForRun(
  client: TransactionClient,
  runId: string,
  options: EvolutionEvalDispatcherClaimOptions,
): Promise<EvolutionEvalDispatcherLease | null> {
  requireOpaqueId(runId, "runId");
  const holderId = requireOpaqueId(options.holderId, "holderId");
  const leaseMs = requireEvolutionEvalDispatcherLeaseMs(
    options.leaseMs ?? EVOLUTION_EVAL_DISPATCHER_DEFAULT_LEASE_MS,
  );
  const leaseNonce = options.leaseNonce ?? randomUUID();
  if (!UUID.test(leaseNonce)) throw new TypeError("leaseNonce must be a UUID");
  const nonceHash = leaseNonceHash(leaseNonce);
  return withTransaction(client, async (tx) => {
    const result = await tx.query(
      `WITH candidate AS (
         SELECT outbox.event_id,outbox.event_type,outbox.aggregate_id
           FROM outbox_events outbox
           JOIN evolution_eval_job job ON job.id=outbox.aggregate_id
          WHERE job.curator_run_id=$1
            AND outbox.published_at IS NULL
            AND outbox.event_type='evolution_eval.reconcile_requested'
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_dispatcher_lease active
               WHERE active.event_id=outbox.event_id
                 AND active.lease_expires_at>clock_timestamp()
            )
          ORDER BY outbox.occurred_at,outbox.event_id
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT 1
       ), claimed AS (
         INSERT INTO evolution_eval_dispatcher_lease
           (event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
            lease_expires_at,attempt_count,claimed_at,updated_at)
         SELECT event_id,event_type,aggregate_id,$2,$3,
                clock_timestamp()+($4::int * interval '1 millisecond'),
                1,clock_timestamp(),clock_timestamp()
           FROM candidate
         ON CONFLICT (event_id) DO UPDATE
           SET event_type=EXCLUDED.event_type,
               aggregate_id=EXCLUDED.aggregate_id,
               holder_id=EXCLUDED.holder_id,
               lease_nonce_hash=EXCLUDED.lease_nonce_hash,
               lease_expires_at=EXCLUDED.lease_expires_at,
               attempt_count=evolution_eval_dispatcher_lease.attempt_count+1,
               claimed_at=clock_timestamp(),
               updated_at=clock_timestamp()
         WHERE evolution_eval_dispatcher_lease.lease_expires_at<=clock_timestamp()
         RETURNING event_id,event_type,aggregate_id,holder_id,lease_nonce_hash,
                   lease_expires_at,attempt_count
       )
       SELECT * FROM claimed`,
      [runId, holderId, nonceHash, leaseMs],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? parseLease(row, leaseNonce) : null;
  });
}

export async function renewEvolutionEvalDutyLease(
  client: TransactionClient,
  lease: Pick<EvolutionEvalDispatcherLease, "eventId" | "holderId" | "leaseNonce">,
  leaseMs = EVOLUTION_EVAL_DISPATCHER_DEFAULT_LEASE_MS,
): Promise<string | null> {
  const duration = requireEvolutionEvalDispatcherLeaseMs(leaseMs);
  const result = await client.query(
    `UPDATE evolution_eval_dispatcher_lease
        SET lease_expires_at=clock_timestamp()+($4::int * interval '1 millisecond'),
            updated_at=clock_timestamp()
      WHERE event_id=$1 AND holder_id=$2 AND lease_nonce_hash=$3
        AND lease_expires_at>clock_timestamp()
      RETURNING lease_expires_at`,
    [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), duration],
  );
  const row = result.rows[0] as Row | undefined;
  return row ? iso(row.lease_expires_at, "lease_expires_at") : null;
}

export async function hasCurrentEvolutionEvalDutyLease(
  client: TransactionClient,
  lease: Pick<EvolutionEvalDispatcherLease, "eventId" | "holderId" | "leaseNonce">,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM evolution_eval_dispatcher_lease
      WHERE event_id=$1 AND holder_id=$2 AND lease_nonce_hash=$3
        AND lease_expires_at>clock_timestamp()`,
    [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce)],
  );
  return result.rows.length === 1;
}

function factId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function dispatchRequest(row: Row): EvolutionEvalDispatchRequestV1 {
  const operation = String(row.operation) as EvolutionEvalOperation;
  const parameters = validateEvolutionEvalParameters(operation, row.parameters);
  const request: EvolutionEvalDispatchRequestV1 = {
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: String(row.eval_job_id),
    connector_job_id: String(row.connector_job_id),
    connector_idempotency_key: String(row.connector_idempotency_key),
    eval_input_ref: String(row.eval_input_ref),
    input_manifest_hash: String(row.input_manifest_hash),
    workspace_id: String(row.workspace_id),
    workspace_revision: Number(row.workspace_revision),
    workspace_manifest_hash: String(row.workspace_manifest_hash),
    sealed_input_projection_hash: String(row.sealed_input_projection_hash),
    operation,
    parameters,
    part: row.part === null ? null : String(row.part),
    toolchain_profile_hash: String(row.toolchain_profile_hash),
    requested_timeout_ms: Number(row.requested_timeout_ms),
    operation_cap_ms: 7_200_000,
    deadline_at: iso(row.deadline_at, "deadline_at"),
    run_class: "evolution_eval",
  };
  if (
    Number(row.operation_cap_ms) !== EVOLUTION_EVAL_LIMITS.operationCapMs
    || !/^[0-9a-f]{64}$/.test(request.sealed_input_projection_hash)
    || !Number.isSafeInteger(request.workspace_revision)
    || request.workspace_revision < 1
    || !Number.isSafeInteger(request.requested_timeout_ms)
  ) {
    throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_CORRUPT");
  }
  return request;
}

function bindingFromRow(row: Row): CoreIssuedEvalBinding {
  const dispatch = dispatchRequest(row);
  const dispatchRequestHash = String(row.dispatch_request_hash);
  if (evolutionEvalCanonicalHash(dispatch) !== dispatchRequestHash) {
    throw new Error("EVOLUTION_EVAL_DISPATCH_HASH_MISMATCH");
  }
  return {
    project_id: String(row.project_id),
    dispatch_request_hash: dispatchRequestHash,
    dispatch,
  };
}

async function appendTransition(
  tx: TransactionClient,
  job: Row,
  fromState: "submitted" | "queued" | "preparing" | "running" | "cancelling",
  toState: "rejected" | "queued" | "preparing" | "running" | "succeeded" | "failed" | "cancelling" | "cancelled" | "timeout" | "unknown_effect",
  sequence: number,
  terminal: { readonly errorCode: string | null; readonly endTime: string | null } | null = null,
): Promise<void> {
  const auditId = factId("eea");
  const transitionId = factId("eetf");
  const outboxId = randomUUID();
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,from_state,to_state,operation)
     VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,$7,$8,$9)`,
    [
      auditId,
      job.curator_run_id,
      job.eval_job_id,
      job.project_id,
      EVOLUTION_EVAL_DISPATCHER_ACTOR_ID,
      job.correlation_id,
      fromState,
      toState,
      job.operation,
    ],
  );
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.eval_job_id),
    eventType: "evolution_eval.tool_run_transition",
    projectId: String(job.project_id),
    payload: { from_state: fromState, to_state: toState },
    headers: {},
    correlationId: String(job.correlation_id),
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_transition_fact
      (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [transitionId, job.eval_job_id, sequence, fromState, toState, auditId, outboxId],
  );
  const terminalState = ["rejected", "succeeded", "failed", "cancelled", "timeout"]
    .includes(toState);
  if (terminalState !== (terminal !== null)) {
    throw new Error("EVOLUTION_EVAL_TERMINAL_TRANSITION_METADATA_MISMATCH");
  }
  const updated = await tx.query(
    `UPDATE tool_run
        SET state=$2,
            error_code=CASE WHEN $4::boolean THEN $5 ELSE error_code END,
            end_time=CASE WHEN $4::boolean
              THEN COALESCE($6::timestamptz,clock_timestamp()) ELSE end_time END
      WHERE id=$1 AND state=$3 RETURNING id`,
    [
      job.tool_run_id,
      toState,
      fromState,
      terminalState,
      terminal?.errorCode ?? null,
      terminal?.endTime ?? null,
    ],
  );
  if (updated.rows.length !== 1) throw new Error("EVOLUTION_EVAL_DISPATCH_FENCE_CAS_LOST");
}

async function lockDispatchRows(
  tx: TransactionClient,
  evalJobId: string,
  options: { readonly allowMissingDispatch?: boolean } = {},
): Promise<Row | null> {
  const lookup = await tx.query(
    "SELECT curator_run_id,tool_run_id FROM evolution_eval_job WHERE id=$1",
    [evalJobId],
  );
  const lookupRow = lookup.rows[0] as Row | undefined;
  if (!lookupRow) return null;
  const curatorRunId = lookupRow.curator_run_id;
  const toolRunId = lookupRow.tool_run_id;
  const curatorResult = await tx.query(
    "SELECT id,state::text,mode FROM curator_run WHERE id=$1 FOR UPDATE",
    [curatorRunId],
  );
  if (curatorResult.rows.length !== 1) return null;
  const evalRunResult = await tx.query(
    `SELECT curator_run_id,deadline_at,deadline_at>clock_timestamp() AS deadline_valid,
            unknown_effect_latched_at,completed_at
       FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE`,
    [curatorRunId],
  );
  if (evalRunResult.rows.length !== 1) return null;
  const jobResult = await tx.query(
    `SELECT id AS eval_job_id,curator_run_id,project_id,tool_run_id,
            connector_job_id,connector_idempotency_key,eval_input_ref,
            input_manifest_hash,operation,parameters,reconciliation_state,deadline_at
       FROM evolution_eval_job WHERE id=$1 FOR UPDATE`,
    [evalJobId],
  );
  const job = jobResult.rows[0] as Row | undefined;
  if (!job) return null;
  const toolResult = await tx.query(
    "SELECT id,state::text,correlation_id,error_code,end_time FROM tool_run WHERE id=$1 FOR UPDATE",
    [toolRunId],
  );
  const tool = toolResult.rows[0] as Row | undefined;
  if (!tool) return null;

  // Facts follow the fixed lock order only after curator/run/job/tool rows.
  const dispatchResult = await tx.query(
    `SELECT eval_job_id,workspace_id,workspace_revision,workspace_manifest_hash,
            sealed_input_projection_hash,dispatch_request_hash,
            requested_timeout_ms,operation_cap_ms,deadline_at
       FROM evolution_eval_dispatch WHERE eval_job_id=$1 FOR UPDATE`,
    [evalJobId],
  );
  const dispatch = dispatchResult.rows[0] as Row | undefined;
  const tombstoneResult = await tx.query(
    `SELECT eval_job_id,reason_code
       FROM evolution_eval_dispatch_tombstone
      WHERE eval_job_id=$1 FOR UPDATE`,
    [evalJobId],
  );
  await tx.query(
    "SELECT id FROM evolution_eval_transition_fact WHERE eval_job_id=$1 ORDER BY transition_sequence FOR UPDATE",
    [evalJobId],
  );
  await tx.query(
    "SELECT id FROM evolution_eval_reconcile_fact WHERE eval_job_id=$1 ORDER BY reconciliation_sequence FOR UPDATE",
    [evalJobId],
  );
  await tx.query(
    "SELECT id FROM evolution_eval_evidence_fact WHERE eval_job_id=$1 ORDER BY created_at,id FOR UPDATE",
    [evalJobId],
  );
  await tx.query(
    "SELECT eval_job_id FROM evolution_eval_connector_ledger_epoch WHERE eval_job_id=$1 FOR UPDATE",
    [evalJobId],
  );
  if (!dispatch) {
    if (!options.allowMissingDispatch) return null;
    return {
      ...job,
      state: tool.state,
      correlation_id: tool.correlation_id,
      tool_error_code: tool.error_code,
      tool_end_time: tool.end_time,
      curator_state: (curatorResult.rows[0] as Row).state,
      curator_mode: (curatorResult.rows[0] as Row).mode,
      run_deadline_at: (evalRunResult.rows[0] as Row).deadline_at,
      deadline_valid: (evalRunResult.rows[0] as Row).deadline_valid,
      unknown_effect_latched_at: (evalRunResult.rows[0] as Row).unknown_effect_latched_at,
      eval_run_completed_at: (evalRunResult.rows[0] as Row).completed_at,
      has_dispatch: false,
      has_tombstone: tombstoneResult.rows.length > 0,
      tombstone_reason_code: (tombstoneResult.rows[0] as Row | undefined)?.reason_code ?? null,
    };
  }
  return {
    ...job,
    ...dispatch,
    state: tool.state,
    correlation_id: tool.correlation_id,
    tool_error_code: tool.error_code,
    tool_end_time: tool.end_time,
    curator_state: (curatorResult.rows[0] as Row).state,
    curator_mode: (curatorResult.rows[0] as Row).mode,
    run_deadline_at: (evalRunResult.rows[0] as Row).deadline_at,
    deadline_valid: (evalRunResult.rows[0] as Row).deadline_valid,
    unknown_effect_latched_at: (evalRunResult.rows[0] as Row).unknown_effect_latched_at,
    eval_run_completed_at: (evalRunResult.rows[0] as Row).completed_at,
    has_dispatch: true,
    has_tombstone: tombstoneResult.rows.length > 0,
    tombstone_reason_code: (tombstoneResult.rows[0] as Row | undefined)?.reason_code ?? null,
  };
}

async function hydrateEvolutionEvalDispatchBindingRows(
  tx: TransactionClient,
  job: Row,
): Promise<Row> {
  if (job.has_dispatch !== true) {
    throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
  }
  const inputResult = await tx.query(
    "SELECT part,toolchain_profile_hash FROM evolution_eval_input WHERE eval_input_ref=$1",
    [job.eval_input_ref],
  );
  const revisionResult = await tx.query(
    `SELECT file_count,total_bytes FROM evolution_eval_workspace_revision
      WHERE workspace_id=$1 AND revision=$2`,
    [job.workspace_id, job.workspace_revision],
  );
  const input = inputResult.rows[0] as Row | undefined;
  const revision = revisionResult.rows[0] as Row | undefined;
  if (!input || !revision) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_CORRUPT");
  return {
    ...job,
    part: input.part,
    toolchain_profile_hash: input.toolchain_profile_hash,
    workspace_file_count: revision.file_count,
    workspace_total_bytes: revision.total_bytes,
  };
}

/**
 * Establishes the submitted -> running post-commit fence without calling the
 * Connector. All three transient transitions are facts in one transaction;
 * only the final stable projection can commit.
 */
export async function fenceEvolutionEvalDispatch(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  policy: EvolutionEvalDispatchFencePolicy = {
    newEffectsEnabled: false,
    rolloutEnabled: false,
    spoolAvailable: false,
  },
): Promise<EvolutionEvalDispatchFenceResult> {
  if (lease.eventType !== "evolution_eval.dispatch_requested" || lease.duty !== "dispatch") {
    return { status: "no_op", reason: "event_mismatch" };
  }
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) return { status: "no_op", reason: "terminal" } as const;
    const tombstone = await tx.query(
      "SELECT 1 FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1",
      [lease.aggregateId],
    );
    const settings = await tx.query(
      "SELECT learning_paused FROM evolution_settings WHERE singleton_id='global' FOR SHARE",
    );
    const learningPaused = (settings.rows[0] as Row | undefined)?.learning_paused;
    const currentLease = await tx.query(
      `SELECT lease.attempt_count,outbox.published_at,outbox.event_type,
              outbox.aggregate_id,outbox.payload
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (claimed.published_at !== null) return { status: "no_op", reason: "published" } as const;
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
      || typeof claimed.payload !== "object"
      || claimed.payload === null
      || (claimed.payload as Row).dispatch_request_hash !== job.dispatch_request_hash
    ) {
      return { status: "no_op", reason: "event_mismatch" } as const;
    }
    if (tombstone.rows.length > 0) return { status: "no_op", reason: "tombstoned" } as const;
    if (
      policy.newEffectsEnabled !== true
      || policy.rolloutEnabled !== true
      || policy.spoolAvailable !== true
      || learningPaused !== false
      || job.curator_state !== "running"
      || job.curator_mode !== "run"
      || job.eval_run_completed_at !== null
      || job.deadline_valid !== true
      || job.unknown_effect_latched_at !== null
    ) {
      console.error("[m4f-diagnostic] fence policy_blocked:", JSON.stringify({
        newEffects: policy.newEffectsEnabled, rollout: policy.rolloutEnabled, spool: policy.spoolAvailable,
        learningPaused, curator_state: job.curator_state, curator_mode: job.curator_mode,
        eval_run_completed_at: job.eval_run_completed_at, deadline_valid: job.deadline_valid,
        unknown_effect_latched_at: job.unknown_effect_latched_at, reconciliation: job.reconciliation_state,
        job_state: job.state,
      }));
      return { status: "no_op", reason: "policy_blocked" } as const;
    }
    const binding = bindingFromRow(
      await hydrateEvolutionEvalDispatchBindingRows(tx, job),
    );
    if (job.state === "running") {
      return { status: "ready", binding, newlyFenced: false } as const;
    }
    if (job.state !== "submitted") return { status: "no_op", reason: "terminal" } as const;
    if (job.reconciliation_state === "required") {
      // The dispatch path holds a never-accepted ledger proof (replay was
      // permitted), so the stale recovery projection is confirmed here
      // instead of deadlocking the submit behind a reconcile duty.
      await confirmDispatcherReconciliation(tx, job);
    }
    const sequenceResult = await tx.query(
      `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
         FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
      [lease.aggregateId],
    );
    let sequence = Number((sequenceResult.rows[0] as Row | undefined)?.sequence);
    if (sequence !== 1) throw new Error("EVOLUTION_EVAL_DISPATCH_TRANSITION_CHAIN_CORRUPT");
    await appendTransition(tx, job, "submitted", "queued", sequence++);
    await appendTransition(tx, job, "queued", "preparing", sequence++);
    await appendTransition(tx, job, "preparing", "running", sequence);
    await tx.query(
      "UPDATE tool_run SET start_time=COALESCE(start_time,clock_timestamp()) WHERE id=$1 AND state='running'",
      [job.tool_run_id],
    );
    return { status: "ready", binding, newlyFenced: true } as const;
  });
}

export async function loadEvolutionEvalClaimedBinding(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
): Promise<CoreIssuedEvalBinding> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const currentLease = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.published_at !== null
      || claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    return bindingFromRow(await hydrateEvolutionEvalDispatchBindingRows(tx, job));
  });
}

export type EvolutionEvalClaimedDutyInspection =
  | {
      readonly status: "ready";
      readonly binding: CoreIssuedEvalBinding;
      readonly state: string;
      readonly learningPaused: boolean;
      readonly requiresConservativeProjection: boolean;
      readonly cancelReason: "tombstoned" | "deadline" | null;
      readonly definitiveCancelBoundary: boolean;
    }
  | {
      readonly status: "no_op";
      readonly state: string;
      readonly reason: "published" | "pre_effect_closed" | "terminal";
    };

/**
 * Performs the mandatory DB-only no-op fence before any Connector call or
 * sealed-input load. It also consumes obsolete dispatch/tombstone duties in
 * the same locked transaction.
 */
export async function inspectEvolutionEvalClaimedDuty(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
): Promise<EvolutionEvalClaimedDutyInspection> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId, {
      allowMissingDispatch: lease.duty === "tombstone",
    });
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const settings = await tx.query(
      "SELECT learning_paused FROM evolution_settings WHERE singleton_id='global' FOR SHARE",
    );
    const learningPaused = (settings.rows[0] as Row | undefined)?.learning_paused;
    if (typeof learningPaused !== "boolean") {
      throw new Error("EVOLUTION_EVAL_SETTINGS_NOT_FOUND");
    }
    const currentLease = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    if (claimed.published_at !== null) {
      return { status: "no_op", state: String(job.state), reason: "published" };
    }

    const publishNoOp = async (
      reason: "pre_effect_closed" | "terminal",
    ): Promise<EvolutionEvalClaimedDutyInspection> => {
      const published = await tx.query(
        `UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE event_id=$1 AND published_at IS NULL RETURNING event_id`,
        [lease.eventId],
      );
      if (published.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();
      return { status: "no_op", state: String(job.state), reason };
    };
    const terminal = [
      "rejected",
      "succeeded",
      "failed",
      "cancelled",
      "timeout",
      "unknown_effect",
    ].includes(String(job.state));

    if (lease.duty === "dispatch") {
      if (terminal || job.has_tombstone === true) {
        return publishNoOp(terminal ? "terminal" : "pre_effect_closed");
      }
      if (job.has_dispatch !== true) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
        );
      }
    } else if (lease.duty === "reconcile") {
      if (job.reconciliation_state !== "required") {
        return publishNoOp("terminal");
      }
      if (job.has_dispatch !== true) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
        );
      }
    } else if (lease.duty === "tombstone") {
      if (terminal) return publishNoOp("terminal");
      if (job.has_dispatch !== true) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
        );
      }
    } else {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }

    const hydrated = await hydrateEvolutionEvalDispatchBindingRows(tx, job);
    const storedCancelReason = typeof job.tombstone_reason_code === "string"
      && job.tombstone_reason_code.startsWith("EVOLUTION_EVAL_DEADLINE_")
      ? "deadline"
      : job.has_tombstone === true ? "tombstoned" : null;
    const definitiveCancelBoundary = isEvolutionEvalDefinitiveCancelBoundary(
      storedCancelReason,
      job.deadline_valid === true,
    );
    return {
      status: "ready",
      binding: bindingFromRow(hydrated),
      state: String(job.state),
      learningPaused,
      requiresConservativeProjection: job.reconciliation_state === "required"
        || await hasDurableEffectPossibleObservation(tx, String(job.eval_job_id)),
      cancelReason: definitiveCancelBoundary ? "deadline" : storedCancelReason,
      definitiveCancelBoundary,
    };
  });
}

export interface RecordedEvolutionEvalObservation {
  readonly id: string;
  readonly observationHash: string;
  readonly observation: EvalLedgerQuery;
  readonly replayed: boolean;
}

function isEvolutionEvalLedgerDuty(
  lease: EvolutionEvalDispatcherLease,
): boolean {
  return lease.duty === "dispatch"
    || lease.duty === "reconcile"
    || lease.duty === "tombstone";
}

async function hasDurableEffectPossibleObservation(
  tx: TransactionClient,
  evalJobId: string,
): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1
       FROM evolution_eval_connector_observation
      WHERE eval_job_id=$1
        AND (
          observation_type IN ('accepted','terminal','ledger_corrupt')
          OR observation_type='ambiguous'
        )
      LIMIT 1`,
    [evalJobId],
  );
  return result.rows.length === 1;
}

async function appendDispatcherReconcileIntent(
  tx: TransactionClient,
  job: Row,
): Promise<boolean> {
  if (job.reconciliation_state === "required") return false;
  const sequenceResult = await tx.query(
    `SELECT COALESCE(max(reconciliation_sequence),0)::int+1 AS sequence
       FROM evolution_eval_reconcile_fact WHERE eval_job_id=$1`,
    [job.eval_job_id],
  );
  const sequence = Number((sequenceResult.rows[0] as Row | undefined)?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("EVOLUTION_EVAL_RECONCILE_SEQUENCE_CORRUPT");
  }
  const requestHash = evolutionEvalCanonicalHash({
    schema: "evolution-eval-reconcile-intent.v1",
    eval_job_id: job.eval_job_id,
    connector_job_id: job.connector_job_id,
    connector_idempotency_key: job.connector_idempotency_key,
    reconciliation_sequence: sequence,
    workspace_id: job.workspace_id,
    workspace_revision: Number(job.workspace_revision),
    workspace_manifest_hash: job.workspace_manifest_hash,
  });
  const reconcileFactId = factId("eerf");
  const auditId = factId("eea");
  const outboxId = randomUUID();
  await tx.query(
    `INSERT INTO evolution_eval_reconcile_fact
      (id,eval_job_id,reconciliation_sequence,reconcile_request_hash,
       workspace_id,workspace_revision,workspace_manifest_hash,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      reconcileFactId,
      job.eval_job_id,
      sequence,
      requestHash,
      job.workspace_id,
      Number(job.workspace_revision),
      job.workspace_manifest_hash,
      auditId,
      outboxId,
    ],
  );
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,request_hash,operation,workspace_manifest_hash,file_count,byte_count)
     VALUES ($1,$2,$3,$4,'reconcile_required','service',$5,$6,$7,$8,$9,$10,$11)`,
    [
      auditId,
      job.curator_run_id,
      job.eval_job_id,
      job.project_id,
      EVOLUTION_EVAL_DISPATCHER_ACTOR_ID,
      job.correlation_id,
      requestHash,
      job.operation,
      job.workspace_manifest_hash,
      Number(job.workspace_file_count),
      Number(job.workspace_total_bytes),
    ],
  );
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.eval_job_id),
    eventType: "evolution_eval.reconcile_requested",
    projectId: String(job.project_id),
    payload: {
      fact_id: reconcileFactId,
      reconcile_request_hash: requestHash,
      reconciliation_sequence: sequence,
      connector_job_id: job.connector_job_id,
      connector_idempotency_key: job.connector_idempotency_key,
      workspace_id: job.workspace_id,
      workspace_revision: Number(job.workspace_revision),
      workspace_manifest_hash: job.workspace_manifest_hash,
    },
    headers: {},
    correlationId: String(job.correlation_id),
    classification: "D1",
  });
  await tx.query(
    "UPDATE evolution_eval_job SET reconciliation_state='required' WHERE id=$1",
    [job.eval_job_id],
  );
  job.reconciliation_state = "required";
  return true;
}

/**
 * Persists a typed Connector observation under the exact current lease
 * attempt. A reclaimed attempt writes a new fact even when the remote payload
 * is identical, so an older holder's observation can never be reused as the
 * current settle proof.
 */
export async function recordEvolutionEvalLedgerObservation(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  suppliedBinding: CoreIssuedEvalBinding,
  input: unknown,
): Promise<RecordedEvolutionEvalObservation> {
  if (!isEvolutionEvalLedgerDuty(lease)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_LEDGER_OBSERVATION_FORBIDDEN_FOR_DUTY",
    );
  }
  const suppliedObservation = validateEvolutionEvalLedgerObservation(suppliedBinding, input);
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const hydratedJob = await hydrateEvolutionEvalDispatchBindingRows(tx, job);
    const authoritativeBinding = bindingFromRow(hydratedJob);
    if (
      evolutionEvalCanonicalHash(authoritativeBinding)
      !== evolutionEvalCanonicalHash(suppliedBinding)
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_CONNECTOR_BINDING_CONFLICT",
      );
    }
    const pinnedEpochResult = await tx.query(
      "SELECT ledger_epoch FROM evolution_eval_connector_ledger_epoch WHERE eval_job_id=$1",
      [lease.aggregateId],
    );
    const pinnedEpoch = (pinnedEpochResult.rows[0] as Row | undefined)?.ledger_epoch;
    const observation: EvalLedgerQuery = typeof pinnedEpoch === "string"
      && suppliedObservation.ledger_epoch !== pinnedEpoch
      ? {
          schema: "evolution-eval-ledger-query.v1",
          state: "ledger_corrupt",
          connector_job_id: suppliedBinding.dispatch.connector_job_id,
          connector_idempotency_key: suppliedBinding.dispatch.connector_idempotency_key,
          dispatch_request_hash: suppliedBinding.dispatch_request_hash,
          ledger_epoch: suppliedObservation.ledger_epoch,
          replay_permitted: false,
          error_code: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
        }
      : suppliedObservation;
    const observationHash = evolutionEvalCanonicalHash(observation);
    const currentLease = await tx.query(
      `SELECT lease.attempt_count,outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
          AND outbox.published_at IS NULL
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    const observationId = randomUUID();
    const inserted = await tx.query(
      `INSERT INTO evolution_eval_connector_observation
        (id,eval_job_id,outbox_event_id,holder_id,lease_nonce_hash,lease_attempt_count,
         observation_type,connector_job_id,connector_idempotency_key,
         dispatch_request_hash,ledger_epoch,observation,observation_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (outbox_event_id,lease_nonce_hash,observation_hash) DO NOTHING
       RETURNING id`,
      [
        observationId,
        lease.aggregateId,
        lease.eventId,
        lease.holderId,
        leaseNonceHash(lease.leaseNonce),
        lease.attemptCount,
        observation.state,
        observation.connector_job_id,
        observation.connector_idempotency_key,
        observation.dispatch_request_hash,
        observation.ledger_epoch,
        JSON.stringify(observation),
        observationHash,
      ],
    );
    const insertedRow = inserted.rows[0] as Row | undefined;
    if (insertedRow) {
      return {
        id: String(insertedRow.id),
        observationHash,
        observation,
        replayed: false,
      };
    }
    const existing = await tx.query(
      `SELECT id FROM evolution_eval_connector_observation
        WHERE outbox_event_id=$1 AND lease_nonce_hash=$2 AND observation_hash=$3
          AND lease_attempt_count=$4 AND holder_id=$5`,
      [lease.eventId, leaseNonceHash(lease.leaseNonce), observationHash, lease.attemptCount, lease.holderId],
    );
    const existingRow = existing.rows[0] as Row | undefined;
    if (!existingRow) throw new EvolutionEvalDispatcherLeaseLostError();
    return {
      id: String(existingRow.id),
      observationHash,
      observation,
      replayed: true,
    };
  });
}

async function appendDispatcherTombstone(
  tx: TransactionClient,
  job: Row,
  reasonCode: string,
  errorHash: string,
): Promise<boolean> {
  const existing = await tx.query(
    "SELECT 1 FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=$1",
    [job.eval_job_id],
  );
  if (existing.rows.length > 0) return false;
  const auditId = factId("eea");
  const outboxId = randomUUID();
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,request_hash,operation,error_code)
     VALUES ($1,$2,$3,$4,'dispatch_tombstone','service',$5,$6,$7,$8,$9)`,
    [
      auditId,
      job.curator_run_id,
      job.eval_job_id,
      job.project_id,
      EVOLUTION_EVAL_DISPATCHER_ACTOR_ID,
      job.correlation_id,
      errorHash,
      job.operation,
      reasonCode,
    ],
  );
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.eval_job_id),
    eventType: "evolution_eval.dispatch_tombstoned",
    projectId: String(job.project_id),
    payload: { error_hash: errorHash },
    headers: {},
    correlationId: String(job.correlation_id),
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_dispatch_tombstone
      (eval_job_id,reason_code,error_hash,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [job.eval_job_id, reasonCode, errorHash, auditId, outboxId],
  );
  return true;
}

async function publishConfirmedPreEffectTombstoneDuty(
  tx: TransactionClient,
  evalJobId: string,
): Promise<void> {
  const published = await tx.query(
    `UPDATE outbox_events
        SET published_at=clock_timestamp()
      WHERE event_id=(
        SELECT outbox_event_id
          FROM evolution_eval_dispatch_tombstone
         WHERE eval_job_id=$1
      )
        AND published_at IS NULL
      RETURNING event_id`,
    [evalJobId],
  );
  if (published.rows.length !== 1) {
    throw new Error("EVOLUTION_EVAL_PRE_EFFECT_TOMBSTONE_PUBLICATION_CONFLICT");
  }
}

async function appendDispatcherEvidenceFact(
  tx: TransactionClient,
  job: Row,
  factType:
    | "freeze_pending"
    | "frozen"
    | "corrupt"
    | "unavailable_at_deadline"
    | "ack_pending"
    | "acknowledged"
    | "quarantine_pending"
    | "expired"
    | "cleanup_pending"
    | "cleaned",
  options: {
    readonly factHash: string;
    readonly manifestHash?: string;
    readonly connectorManifestHash?: string;
    readonly manifest?: unknown;
    readonly entryCount?: number;
    readonly totalBytes?: number;
    readonly errorCode?: string;
  },
): Promise<string> {
  const factIdValue = factId("eeef");
  const auditId = factId("eea");
  const outboxId = randomUUID();
  const eventType = factType === "freeze_pending"
    ? "evolution_eval.evidence.freeze_requested"
    : factType === "ack_pending"
    ? "evolution_eval.evidence.ack_requested"
    : factType === "quarantine_pending"
    ? "evolution_eval.evidence.quarantine_requested"
    : factType === "cleanup_pending"
    ? "evolution_eval.evidence.cleanup_requested"
    : `evolution_eval.evidence.${factType}`;
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,request_hash,operation,evidence_manifest_hash,file_count,
       byte_count,error_code)
     VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      auditId,
      job.curator_run_id,
      job.eval_job_id,
      job.project_id,
      `evidence.${factType}`,
      EVOLUTION_EVAL_DISPATCHER_ACTOR_ID,
      job.correlation_id,
      options.factHash,
      job.operation,
      options.manifestHash ?? null,
      options.entryCount ?? null,
      options.totalBytes ?? null,
      options.errorCode ?? null,
    ],
  );
  const payload: Row = {
    fact_id: factIdValue,
    fact_type: factType,
    fact_hash: options.factHash,
  };
  if (options.manifestHash !== undefined) payload.manifest_hash = options.manifestHash;
  if (options.errorCode !== undefined) payload.error_code = options.errorCode;
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.eval_job_id),
    eventType,
    projectId: String(job.project_id),
    payload,
    headers: {},
    correlationId: String(job.correlation_id),
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_evidence_fact
      (id,eval_job_id,fact_type,manifest_hash,error_code,fact_hash,manifest,
       connector_manifest_hash,entry_count,total_bytes,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
    [
      factIdValue,
      job.eval_job_id,
      factType,
      options.manifestHash ?? null,
      options.errorCode ?? null,
      options.factHash,
      options.manifest === undefined ? null : JSON.stringify(options.manifest),
      options.connectorManifestHash ?? null,
      options.entryCount ?? 0,
      options.totalBytes ?? 0,
      auditId,
      outboxId,
    ],
  );
  return factIdValue;
}

async function transitionDispatcherTerminal(
  tx: TransactionClient,
  job: Row,
  observation: Extract<EvalLedgerQuery, { readonly state: "terminal" }>,
  observationHash: string,
): Promise<boolean> {
  const currentState = String(job.state);
  if (currentState === observation.terminal_state) return false;
  if (currentState !== "running") {
    throw new Error("EVOLUTION_EVAL_TERMINAL_OBSERVATION_STATE_CONFLICT");
  }
  const sequenceResult = await tx.query(
    `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
       FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
    [job.eval_job_id],
  );
  let sequence = Number((sequenceResult.rows[0] as Row | undefined)?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("EVOLUTION_EVAL_DISPATCH_TRANSITION_CHAIN_CORRUPT");
  }
  if (observation.terminal_state === "cancelled") {
    await appendTransition(tx, job, "running", "cancelling", sequence++);
    await appendTransition(tx, job, "cancelling", "cancelled", sequence, {
      errorCode: observation.error_code,
      endTime: observation.terminal_at,
    });
  } else {
    await appendTransition(tx, job, "running", observation.terminal_state, sequence, {
      errorCode: observation.error_code,
      endTime: observation.terminal_at,
    });
  }
  const freezeExisting = await tx.query(
    "SELECT 1 FROM evolution_eval_evidence_fact WHERE eval_job_id=$1 AND fact_type='freeze_pending'",
    [job.eval_job_id],
  );
  if (freezeExisting.rows.length === 0) {
    const freezeHash = evolutionEvalCanonicalHash({
      schema: "evolution-eval-evidence-freeze-intent.v1",
      eval_job_id: job.eval_job_id,
      connector_observation_hash: observationHash,
    });
    await appendDispatcherEvidenceFact(tx, job, "freeze_pending", {
      factHash: freezeHash,
    });
  }
  job.state = observation.terminal_state;
  return true;
}

async function transitionDispatcherNotAccepted(
  tx: TransactionClient,
  job: Row,
): Promise<void> {
  const errorCode = "EVOLUTION_EVAL_NOT_ACCEPTED";
  const sequenceResult = await tx.query(
    `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
       FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
    [job.eval_job_id],
  );
  const sequence = Number((sequenceResult.rows[0] as Row | undefined)?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("EVOLUTION_EVAL_DISPATCH_TRANSITION_CHAIN_CORRUPT");
  }
  if (job.state === "submitted") {
    const errorHash = evolutionEvalCanonicalHash({
      schema: "evolution-eval-dispatch-tombstone.v1",
      eval_job_id: job.eval_job_id,
      reason_code: errorCode,
    });
    await appendDispatcherTombstone(tx, job, errorCode, errorHash);
    await appendTransition(tx, job, "submitted", "rejected", sequence, {
      errorCode,
      endTime: null,
    });
    await publishConfirmedPreEffectTombstoneDuty(tx, String(job.eval_job_id));
    job.state = "rejected";
    return;
  }
  if (job.state === "running") {
    await appendTransition(tx, job, "running", "failed", sequence, {
      errorCode,
      endTime: null,
    });
    job.state = "failed";
    return;
  }
  if (!["rejected", "failed"].includes(String(job.state))) {
    throw new Error("EVOLUTION_EVAL_NOT_ACCEPTED_STATE_CONFLICT");
  }
}

async function confirmDispatcherReconciliation(
  tx: TransactionClient,
  job: Row,
): Promise<void> {
  if (job.reconciliation_state !== "required") return;
  const confirmed = await tx.query(
    `UPDATE evolution_eval_job SET reconciliation_state='confirmed'
      WHERE id=$1 AND reconciliation_state='required'
      RETURNING id`,
    [job.eval_job_id],
  );
  if (confirmed.rows.length !== 1) {
    throw new Error("EVOLUTION_EVAL_RECONCILIATION_CONFIRMATION_CONFLICT");
  }
  job.reconciliation_state = "confirmed";
}

async function transitionDispatcherUnknownEffect(
  tx: TransactionClient,
  job: Row,
  observationHash: string,
  errorCode: string,
): Promise<boolean> {
  if (job.state === "unknown_effect") return false;
  if (job.state !== "running") {
    throw new Error("EVOLUTION_EVAL_UNKNOWN_EFFECT_STATE_CONFLICT");
  }
  const sequenceResult = await tx.query(
    `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
       FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
    [job.eval_job_id],
  );
  const sequence = Number((sequenceResult.rows[0] as Row | undefined)?.sequence);
  const transitionId = factId("eetf");
  const auditId = factId("eea");
  const outboxId = randomUUID();
  const latchedResult = await tx.query("SELECT clock_timestamp() AS latched_at");
  const latchedAt = (latchedResult.rows[0] as Row).latched_at;
  const factHash = evolutionEvalCanonicalHash({
    schema: "evolution-eval-unknown-effect.v1",
    eval_job_id: job.eval_job_id,
    connector_observation_hash: observationHash,
    error_code: errorCode,
  });
  await tx.query(
    `INSERT INTO evolution_eval_audit_event
      (id,curator_run_id,eval_job_id,project_id,event_type,actor_type,actor_id,
       correlation_id,from_state,to_state,operation)
     VALUES ($1,$2,$3,$4,'tool_run_transition','service',$5,$6,'running','unknown_effect',$7)`,
    [
      auditId,
      job.curator_run_id,
      job.eval_job_id,
      job.project_id,
      EVOLUTION_EVAL_DISPATCHER_ACTOR_ID,
      job.correlation_id,
      job.operation,
    ],
  );
  await appendOutboxEventInTx(tx, {
    eventId: outboxId,
    aggregateType: "evolution_eval_job",
    aggregateId: String(job.eval_job_id),
    eventType: "evolution_eval.unknown_effect",
    projectId: String(job.project_id),
    payload: { from_state: "running", to_state: "unknown_effect", fact_hash: factHash },
    headers: {},
    correlationId: String(job.correlation_id),
    classification: "D1",
  });
  await tx.query(
    `INSERT INTO evolution_eval_transition_fact
      (id,eval_job_id,transition_sequence,from_state,to_state,audit_event_id,outbox_event_id)
     VALUES ($1,$2,$3,'running','unknown_effect',$4,$5)`,
    [transitionId, job.eval_job_id, sequence, auditId, outboxId],
  );
  await tx.query(
    `INSERT INTO evolution_eval_unknown_fact
      (eval_job_id,transition_fact_id,audit_event_id,outbox_event_id,fact_hash,latched_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [job.eval_job_id, transitionId, auditId, outboxId, factHash, latchedAt],
  );
  const latched = await tx.query(
    `UPDATE evolution_eval_run SET unknown_effect_latched_at=$2
      WHERE curator_run_id=$1 AND unknown_effect_latched_at IS NULL
      RETURNING curator_run_id`,
    [job.curator_run_id, latchedAt],
  );
  if (latched.rows.length !== 1) throw new Error("EVOLUTION_EVAL_UNKNOWN_EFFECT_LATCH_CONFLICT");
  const updated = await tx.query(
    `UPDATE tool_run
        SET state='unknown_effect',error_code=$2,end_time=clock_timestamp()
      WHERE id=$1 AND state='running'
      RETURNING id`,
    [job.tool_run_id, errorCode],
  );
  if (updated.rows.length !== 1) throw new Error("EVOLUTION_EVAL_UNKNOWN_EFFECT_CAS_LOST");
  job.state = "unknown_effect";
  return true;
}

async function materializeEvolutionEvalRunDeadline(
  client: TransactionClient,
  curatorRunId: string,
): Promise<boolean> {
  return withTransaction(client, async (tx) => {
    const curator = await tx.query("SELECT id FROM curator_run WHERE id=$1 FOR UPDATE", [curatorRunId]);
    if (curator.rows.length === 0) return false;
    const runResult = await tx.query(
      `SELECT curator_run_id,deadline_at<=clock_timestamp() AS expired
         FROM evolution_eval_run WHERE curator_run_id=$1 FOR UPDATE`,
      [curatorRunId],
    );
    if ((runResult.rows[0] as Row | undefined)?.expired !== true) return false;
    // The run lock freezes the job set. Enumerate IDs first, then acquire each
    // job/tool/fact group through the one fixed lock helper in ordinal order;
    // a combined FOR UPDATE over job+tool lets PostgreSQL choose an unsafe
    // cross-table acquisition order under concurrent cancel/fence work.
    const jobsResult = await tx.query(
      `SELECT job.id AS eval_job_id
         FROM evolution_eval_job job
        WHERE job.curator_run_id=$1
        ORDER BY job.ordinal`,
      [curatorRunId],
    );
    let changed = false;
    for (const candidate of jobsResult.rows as Row[]) {
      let job = await lockDispatchRows(
        tx,
        String(candidate.eval_job_id),
        { allowMissingDispatch: true },
      );
      if (!job) continue;
      let state = String(job.state);
      if (
        state === "submitted"
        && (
          job.reconciliation_state === "required"
          || await hasDurableEffectPossibleObservation(tx, String(job.eval_job_id))
        )
      ) {
        job = await hydrateEvolutionEvalDispatchBindingRows(tx, job);
        await establishConservativeEffectPossibleProjection(tx, job);
        await appendDispatcherReconcileIntent(tx, job);
        state = "running";
      }
      if (state === "submitted") {
        const reasonCode = "EVOLUTION_EVAL_DEADLINE_BEFORE_DISPATCH";
        const errorHash = evolutionEvalCanonicalHash({
          schema: "evolution-eval-dispatch-tombstone.v1",
          eval_job_id: job.eval_job_id,
          reason_code: reasonCode,
        });
        const inserted = await appendDispatcherTombstone(tx, job, reasonCode, errorHash);
        if (inserted) {
          const sequenceResult = await tx.query(
            `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
               FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
            [job.eval_job_id],
          );
          const sequence = Number((sequenceResult.rows[0] as Row).sequence);
          await appendTransition(tx, job, "submitted", "rejected", sequence, {
            errorCode: reasonCode,
            endTime: null,
          });
          await publishConfirmedPreEffectTombstoneDuty(
            tx,
            String(job.eval_job_id),
          );
          changed = true;
        }
      } else if (state === "running") {
        const reasonCode = "EVOLUTION_EVAL_DEADLINE_CANCEL_REQUESTED";
        const errorHash = evolutionEvalCanonicalHash({
          schema: "evolution-eval-deadline-cancel.v1",
          eval_job_id: job.eval_job_id,
          deadline_at: iso(job.deadline_at, "deadline_at"),
        });
        changed = await appendDispatcherTombstone(tx, job, reasonCode, errorHash) || changed;
      } else if (
        ["succeeded", "failed", "cancelled", "timeout"].includes(state)
        && !(
          state === "failed"
          && job.tool_error_code === "EVOLUTION_EVAL_NOT_ACCEPTED"
        )
      ) {
        const facts = await tx.query(
          "SELECT fact_type FROM evolution_eval_evidence_fact WHERE eval_job_id=$1",
          [job.eval_job_id],
        );
        const types = new Set((facts.rows as Row[]).map((row) => String(row.fact_type)));
        if (!types.has("frozen") && !types.has("corrupt") && !types.has("unavailable_at_deadline")) {
          const errorCode = "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE";
          const unavailableHash = evolutionEvalCanonicalHash({
            schema: "evolution-eval-evidence-deadline.v1",
            eval_job_id: job.eval_job_id,
            deadline_at: iso(job.deadline_at, "deadline_at"),
            error_code: errorCode,
          });
          await appendDispatcherEvidenceFact(
            tx,
            job,
            "unavailable_at_deadline",
            { factHash: unavailableHash, errorCode },
          );
          const cleanupHash = evolutionEvalCanonicalHash({
            schema: "evolution-eval-evidence-cleanup.v1",
            eval_job_id: job.eval_job_id,
            cause_fact_hash: unavailableHash,
          });
          await appendDispatcherEvidenceFact(tx, job, "cleanup_pending", {
            factHash: cleanupHash,
          });
          if (job.reconciliation_state === "required") {
            await tx.query(
              `UPDATE evolution_eval_job SET reconciliation_state='confirmed'
                WHERE id=$1 AND reconciliation_state='required'`,
              [job.eval_job_id],
            );
          }
          changed = true;
        }
      }
    }
    return changed;
  });
}

/**
 * The deadline scanner creates only existing tombstone/evidence intents. It
 * never performs a Connector RPC and never creates a new eval job.
 */
export async function materializeEvolutionEvalDeadlineIntents(
  client: TransactionClient,
  limit = 10,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("deadline scan limit must be between 1 and 100");
  }
  const candidates = await client.query(
    `SELECT run.curator_run_id
       FROM evolution_eval_run run
      WHERE run.deadline_at<=clock_timestamp()
        AND EXISTS (
          SELECT 1 FROM evolution_eval_job job
          JOIN tool_run tool ON tool.id=job.tool_run_id
          WHERE job.curator_run_id=run.curator_run_id
            AND (
              (
                tool.state='submitted'
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM evolution_eval_dispatch dispatch
                     WHERE dispatch.eval_job_id=job.id
                  )
                  OR EXISTS (
                    SELECT 1
                      FROM evolution_eval_dispatch dispatch
                      JOIN outbox_events dispatch_outbox
                        ON dispatch_outbox.event_id=dispatch.outbox_event_id
                     WHERE dispatch.eval_job_id=job.id
                       AND dispatch_outbox.aggregate_type='evolution_eval_job'
                       AND dispatch_outbox.aggregate_id=job.id
                       AND dispatch_outbox.event_type='evolution_eval.dispatch_requested'
                       AND dispatch_outbox.payload=jsonb_build_object(
                         'dispatch_request_hash',dispatch.dispatch_request_hash
                       )
                  )
                )
              )
              OR tool.state='running'
              OR (
                tool.state IN ('succeeded','failed','cancelled','timeout')
                AND NOT (
                  tool.state='failed'
                  AND tool.error_code='EVOLUTION_EVAL_NOT_ACCEPTED'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evolution_eval_evidence_fact fact
                   WHERE fact.eval_job_id=job.id
                     AND fact.fact_type IN ('frozen','corrupt','unavailable_at_deadline')
                )
              )
            )
        )
      ORDER BY run.deadline_at,run.curator_run_id
      LIMIT $1`,
    [limit],
  );
  let materialized = 0;
  for (const row of candidates.rows as Row[]) {
    const changed = await materializeEvolutionEvalRunDeadline(client, String(row.curator_run_id));
    if (changed) {
      materialized += 1;
    }
  }
  return materialized;
}

async function materializeEvolutionEvalJobRetentionIntents(
  client: TransactionClient,
  evalJobId: string,
): Promise<boolean> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, evalJobId);
    if (!job) return false;
    const factsResult = await tx.query(
      `SELECT fact_type,manifest_hash,fact_hash,created_at
         FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1`,
      [evalJobId],
    );
    const facts = new Map(
      (factsResult.rows as Row[]).map((fact) => [String(fact.fact_type), fact]),
    );
    const frozen = facts.get("frozen");
    if (!frozen) return false;
    const terminalResult = await tx.query(
      `SELECT end_time,clock_timestamp()>=end_time+interval '7 days' AS expired
         FROM tool_run WHERE id=$1`,
      [job.tool_run_id],
    );
    const terminal = terminalResult.rows[0] as Row | undefined;
    if (!terminal || terminal.end_time === null) return false;
    if (
      terminal.expired === true
      && !facts.has("acknowledged")
      && !facts.has("expired")
    ) {
      const expiredHash = evolutionEvalCanonicalHash({
        schema: "evolution-eval-evidence-expired.v1",
        eval_job_id: job.eval_job_id,
        manifest_hash: frozen.manifest_hash,
        terminal_at: iso(terminal.end_time, "end_time"),
      });
      await appendDispatcherEvidenceFact(tx, job, "expired", {
        factHash: expiredHash,
        manifestHash: String(frozen.manifest_hash),
      });
      await appendDispatcherEvidenceFact(tx, job, "cleanup_pending", {
        factHash: evolutionEvalCanonicalHash({
          schema: "evolution-eval-evidence-cleanup.v1",
          eval_job_id: job.eval_job_id,
          cause_fact_hash: expiredHash,
        }),
      });
      return true;
    }
    if (
      !facts.has("ack_pending")
      && !facts.has("acknowledged")
      && !facts.has("expired")
    ) {
      await appendDispatcherEvidenceFact(tx, job, "ack_pending", {
        factHash: evolutionEvalCanonicalHash({
          schema: "evolution-eval-evidence-ack-intent.v1",
          eval_job_id: job.eval_job_id,
          manifest_hash: frozen.manifest_hash,
        }),
        manifestHash: String(frozen.manifest_hash),
      });
      return true;
    }
    if (facts.has("acknowledged") && !facts.has("cleanup_pending")) {
      await appendDispatcherEvidenceFact(tx, job, "cleanup_pending", {
        factHash: evolutionEvalCanonicalHash({
          schema: "evolution-eval-evidence-cleanup.v1",
          eval_job_id: job.eval_job_id,
          cause_fact_hash: facts.get("acknowledged")?.fact_hash,
        }),
      });
      return true;
    }
    return false;
  });
}

/** Materializes run-independent ack, absolute-expiry and cleanup duties. */
export async function materializeEvolutionEvalRetentionIntents(
  client: TransactionClient,
  limit = 10,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("retention scan limit must be between 1 and 100");
  }
  const candidates = await client.query(
    `SELECT job.id
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_evidence_fact frozen
         ON frozen.eval_job_id=job.id AND frozen.fact_type='frozen'
      WHERE tool.state IN ('succeeded','failed','cancelled','timeout')
        AND (
          NOT EXISTS (
            SELECT 1 FROM evolution_eval_evidence_fact terminal
             WHERE terminal.eval_job_id=job.id
               AND terminal.fact_type IN ('ack_pending','acknowledged','expired')
          )
          OR (
            tool.end_time IS NOT NULL
            AND tool.end_time+interval '7 days'<=clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_evidence_fact terminal
               WHERE terminal.eval_job_id=job.id
                 AND terminal.fact_type IN ('acknowledged','expired')
            )
          )
          OR (
            EXISTS (
              SELECT 1 FROM evolution_eval_evidence_fact acknowledged
               WHERE acknowledged.eval_job_id=job.id
                 AND acknowledged.fact_type='acknowledged'
            )
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_evidence_fact cleanup
               WHERE cleanup.eval_job_id=job.id
                 AND cleanup.fact_type='cleanup_pending'
            )
          )
        )
      ORDER BY tool.end_time,job.id
      LIMIT $1`,
    [limit],
  );
  let materialized = 0;
  for (const row of candidates.rows as Row[]) {
    if (await materializeEvolutionEvalJobRetentionIntents(client, String(row.id))) {
      materialized += 1;
    }
  }
  return materialized;
}

export type EvolutionEvalSettleAction =
  | "replay"
  | "cancel"
  | "wait"
  | "settled"
  | "rejected";

export interface EvolutionEvalSettleResult {
  readonly action: EvolutionEvalSettleAction;
  readonly published: boolean;
  readonly state: string;
  readonly observationId: string;
}

async function establishConservativeEffectPossibleProjection(
  tx: TransactionClient,
  job: Row,
): Promise<void> {
  if (job.state === "running") return;
  if (job.state !== "submitted") {
    throw new Error("EVOLUTION_EVAL_DISPATCH_FENCE_STATE_CONFLICT");
  }
  const sequenceResult = await tx.query(
    `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
       FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
    [job.eval_job_id],
  );
  let sequence = Number((sequenceResult.rows[0] as Row | undefined)?.sequence);
  if (sequence !== 1) throw new Error("EVOLUTION_EVAL_DISPATCH_TRANSITION_CHAIN_CORRUPT");
  await appendTransition(tx, job, "submitted", "queued", sequence++);
  await appendTransition(tx, job, "queued", "preparing", sequence++);
  await appendTransition(tx, job, "preparing", "running", sequence);
  await tx.query(
    "UPDATE tool_run SET start_time=COALESCE(start_time,clock_timestamp()) WHERE id=$1 AND state='running'",
    [job.tool_run_id],
  );
  job.state = "running";
}

function requiresConservativeEffectPossibleProjection(
  observation: EvalLedgerQuery,
): boolean {
  return observation.state === "ledger_corrupt"
    || (
      observation.state === "ambiguous"
      && observation.error_code !== "EVOLUTION_EVAL_LEDGER_NO_PROOF"
    );
}

/**
 * A corrupt ledger, or an ambiguity that is stronger than the Connector's
 * exact "no reservation proof yet" response, means an external effect may
 * already exist even when Core has not committed its ordinary dispatch
 * fence. Persist that conservative projection in its own transaction before
 * any unknown-effect latch transaction. This deliberately does not authorize
 * or submit a new effect; it only makes recovery/deadline handling truthful.
 *
 * Keeping this transaction separate is security-critical. The run origin
 * guard must continue to reject a submitted -> queued effect fact created in
 * the same transaction as an unknown-effect latch. A crash between the two
 * transactions leaves a recoverable running + reconciliation-required job,
 * never a submitted draft that the deadline scanner could reject as
 * definitely unexecuted.
 */
async function establishConservativeEffectPossibleProjectionForObservation(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  binding: CoreIssuedEvalBinding,
  recorded: RecordedEvolutionEvalObservation,
): Promise<void> {
  if (!isEvolutionEvalLedgerDuty(lease)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_LEDGER_OBSERVATION_FORBIDDEN_FOR_DUTY",
    );
  }
  await withTransaction(client, async (tx) => {
    const lockedJob = await lockDispatchRows(tx, lease.aggregateId);
    const job = lockedJob
      ? await hydrateEvolutionEvalDispatchBindingRows(tx, lockedJob)
      : null;
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const authoritativeBinding = bindingFromRow(job);
    if (
      evolutionEvalCanonicalHash(authoritativeBinding)
      !== evolutionEvalCanonicalHash(binding)
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_CONNECTOR_BINDING_CONFLICT",
      );
    }
    const fact = await tx.query(
      `SELECT id FROM evolution_eval_connector_observation
        WHERE id=$1 AND eval_job_id=$2 AND outbox_event_id=$3
          AND holder_id=$4 AND lease_nonce_hash=$5 AND lease_attempt_count=$6
          AND observation_hash=$7 AND observation_type=$8`,
      [
        recorded.id,
        lease.aggregateId,
        lease.eventId,
        lease.holderId,
        leaseNonceHash(lease.leaseNonce),
        lease.attemptCount,
        recorded.observationHash,
        recorded.observation.state,
      ],
    );
    if (fact.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();

    if (job.state === "submitted") {
      await establishConservativeEffectPossibleProjection(tx, job);
      await appendDispatcherReconcileIntent(tx, job);
    } else if (job.state === "running") {
      await appendDispatcherReconcileIntent(tx, job);
    } else if (job.state !== "unknown_effect") {
      throw new Error("EVOLUTION_EVAL_EFFECT_POSSIBLE_OBSERVATION_STATE_CONFLICT");
    }

    // Lease/outbox are intentionally locked last, after all run/job/fact
    // rows, so claim/reclaim never introduces the reverse lock order.
    const currentLease = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
          AND outbox.published_at IS NULL
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
  });
}

/**
 * Re-establishes the conservative projection after a crash left only a prior
 * append-only observation (possibly from an expired lease attempt) or an
 * unresolved reconcile intent. The prior fact is evidence that this is not a
 * fresh unexecuted draft; only the newly claimed lease may advance Core's
 * projection, and it is fenced last in the fixed lock order.
 */
async function establishConservativeEffectPossibleProjectionForRecovery(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  binding: CoreIssuedEvalBinding,
): Promise<void> {
  if (!isEvolutionEvalLedgerDuty(lease)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_LEDGER_OBSERVATION_FORBIDDEN_FOR_DUTY",
    );
  }
  await withTransaction(client, async (tx) => {
    const lockedJob = await lockDispatchRows(tx, lease.aggregateId);
    const job = lockedJob
      ? await hydrateEvolutionEvalDispatchBindingRows(tx, lockedJob)
      : null;
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    if (
      evolutionEvalCanonicalHash(bindingFromRow(job))
      !== evolutionEvalCanonicalHash(binding)
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_CONNECTOR_BINDING_CONFLICT",
      );
    }
    const durableEffectPossible = job.reconciliation_state === "required"
      || await hasDurableEffectPossibleObservation(tx, String(job.eval_job_id));
    if (!durableEffectPossible) {
      throw new Error("EVOLUTION_EVAL_CONSERVATIVE_PROJECTION_PROOF_MISSING");
    }
    if (job.state === "submitted") {
      await establishConservativeEffectPossibleProjection(tx, job);
      await appendDispatcherReconcileIntent(tx, job);
    } else if (job.state === "running") {
      await appendDispatcherReconcileIntent(tx, job);
    } else if (job.state !== "unknown_effect") {
      throw new Error("EVOLUTION_EVAL_EFFECT_POSSIBLE_OBSERVATION_STATE_CONFLICT");
    }

    const currentLease = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
          AND outbox.published_at IS NULL
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
  });
}

/**
 * Applies one already-recorded observation. The current event/holder/nonce/
 * attempt is fenced again after all authoritative rows are locked; stale
 * holders roll back every Core state change.
 */
export async function settleEvolutionEvalLedgerObservation(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  binding: CoreIssuedEvalBinding,
  recorded: RecordedEvolutionEvalObservation,
  options: {
    readonly definitiveBoundary?: boolean;
    readonly replayAllowed?: boolean;
  } = {},
): Promise<EvolutionEvalSettleResult> {
  if (!isEvolutionEvalLedgerDuty(lease)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_LEDGER_OBSERVATION_FORBIDDEN_FOR_DUTY",
    );
  }
  const observation = validateEvolutionEvalLedgerObservation(binding, recorded.observation);
  if (evolutionEvalCanonicalHash(observation) !== recorded.observationHash) {
    throw new EvolutionEvalConnectorObservationError();
  }
  if (requiresConservativeEffectPossibleProjection(observation)) {
    await establishConservativeEffectPossibleProjectionForObservation(
      client,
      lease,
      binding,
      recorded,
    );
  }
  return withTransaction(client, async (tx) => {
    const lockedJob = await lockDispatchRows(tx, lease.aggregateId);
    const job = lockedJob
      ? await hydrateEvolutionEvalDispatchBindingRows(tx, lockedJob)
      : null;
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const authoritativeBinding = bindingFromRow(job);
    if (
      evolutionEvalCanonicalHash(authoritativeBinding)
      !== evolutionEvalCanonicalHash(binding)
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_CONNECTOR_BINDING_CONFLICT",
      );
    }
    const fact = await tx.query(
      `SELECT id FROM evolution_eval_connector_observation
        WHERE id=$1 AND eval_job_id=$2 AND outbox_event_id=$3
          AND holder_id=$4 AND lease_nonce_hash=$5 AND lease_attempt_count=$6
          AND observation_hash=$7 AND observation_type=$8`,
      [
        recorded.id,
        lease.aggregateId,
        lease.eventId,
        lease.holderId,
        leaseNonceHash(lease.leaseNonce),
        lease.attemptCount,
        recorded.observationHash,
        observation.state,
      ],
    );
    if (fact.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();

    let action: EvolutionEvalSettleAction = "wait";
    let publish = false;
    if (
      options.definitiveBoundary === true
      && lease.eventType === "evolution_eval.dispatch_tombstoned"
      && ["accepted", "transient_unavailable", "ambiguous"].includes(observation.state)
    ) {
      const errorCode = observation.state === "transient_unavailable"
          || observation.state === "ambiguous"
        ? observation.error_code
        : "EVOLUTION_EVAL_PROCESS_STOP_UNCONFIRMED";
      await transitionDispatcherUnknownEffect(
        tx,
        job,
        recorded.observationHash,
        errorCode,
      );
      await confirmDispatcherReconciliation(tx, job);
      action = "settled";
      publish = true;
    } else if (observation.state === "proven_never_accepted") {
      if (
        lease.eventType === "evolution_eval.dispatch_requested"
        && observation.replay_permitted
        && options.replayAllowed !== false
      ) {
        action = "replay";
      } else if (
        lease.eventType === "evolution_eval.reconcile_requested"
        && observation.replay_permitted === true
        && job.reconciliation_state === "required"
        && ["submitted", "running"].includes(String(job.state))
      ) {
        // A reconcile duty that observes never-accepted on a job whose
        // dispatch has not completed must not reject it: the reservation
        // proves no effect, and the pending dispatch duty still owns the
        // submit. Confirm the reconciliation and leave the job to it.
        await confirmDispatcherReconciliation(tx, job);
        action = "wait";
      } else {
        await transitionDispatcherNotAccepted(tx, job);
        await confirmDispatcherReconciliation(tx, job);
        action = "rejected";
        publish = true;
      }
    } else if (observation.state === "accepted") {
      if (job.state !== "running") {
        throw new Error("EVOLUTION_EVAL_ACCEPTED_OBSERVATION_STATE_CONFLICT");
      }
      await appendDispatcherReconcileIntent(tx, job);
      if (lease.eventType === "evolution_eval.dispatch_requested") {
        action = "settled";
        publish = true;
      } else if (lease.eventType === "evolution_eval.reconcile_requested") {
        await confirmDispatcherReconciliation(tx, job);
        action = "settled";
        publish = true;
      } else if (lease.eventType === "evolution_eval.dispatch_tombstoned") {
        action = "cancel";
      }
    } else if (observation.state === "terminal") {
      await transitionDispatcherTerminal(tx, job, observation, recorded.observationHash);
      if (
        job.reconciliation_state === "required"
      ) {
        await confirmDispatcherReconciliation(tx, job);
      }
      action = "settled";
      publish = true;
    } else if (observation.state === "transient_unavailable") {
      await appendDispatcherReconcileIntent(tx, job);
      action = lease.eventType === "evolution_eval.dispatch_tombstoned"
        && job.state === "running"
        ? "cancel"
        : "wait";
    } else if (observation.state === "ledger_corrupt") {
      await transitionDispatcherUnknownEffect(tx, job, recorded.observationHash, observation.error_code);
      await confirmDispatcherReconciliation(tx, job);
      action = "settled";
      publish = true;
    } else if (
      job.state === "running"
      && lease.eventType === "evolution_eval.dispatch_tombstoned"
      && options.definitiveBoundary === true
    ) {
      await transitionDispatcherUnknownEffect(tx, job, recorded.observationHash, observation.error_code);
      await confirmDispatcherReconciliation(tx, job);
      action = "settled";
      publish = true;
    } else {
      if (
        !(observation.state === "ambiguous"
          && observation.error_code === "EVOLUTION_EVAL_LEDGER_NO_PROOF"
          && lease.eventType === "evolution_eval.dispatch_requested"
          && job.state === "submitted")
      ) {
        await appendDispatcherReconcileIntent(tx, job);
      }
      action = lease.eventType === "evolution_eval.dispatch_tombstoned"
        && job.state === "running"
        && observation.state === "ambiguous"
        ? "cancel"
        : "wait";
    }

    const currentLease = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    if (publish && claimed.published_at === null) {
      const published = await tx.query(
        `UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE event_id=$1 AND published_at IS NULL RETURNING event_id`,
        [lease.eventId],
      );
      if (published.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();
    }
    return {
      action,
      published: publish,
      state: String(job.state),
      observationId: recorded.id,
    };
  });
}

export interface EvolutionEvalProcessDutyOptions {
  readonly allowNewEffects?: boolean;
  readonly rolloutEnabled?: boolean;
  readonly evidenceTempRoot?: string;
  readonly loadSealedInput?: (
    client: TransactionClient,
    binding: CoreIssuedEvalBinding,
  ) => Promise<SealedEvalInput>;
}

export interface EvolutionEvalProcessDutyResult {
  readonly eventId: string;
  readonly duty: EvolutionEvalDispatcherLease["duty"];
  readonly outcome:
    | "settled"
      | "waiting"
      | "new_effect_disabled"
      | "evidence_deferred";
  readonly state: string | null;
}

interface EvolutionEvalEvidenceDutyInspection {
  readonly binding: CoreIssuedEvalBinding;
  readonly toolRunId: string;
  readonly state: string;
  readonly authorizationHash: string;
  readonly coreManifestHash: string | null;
  readonly connectorManifestHash: string | null;
  readonly corruptErrorFactHash: string | null;
  readonly cleanup:
    | {
        readonly mode: "connector_authorized";
        readonly connectorAuthorizationKind: "ack" | "quarantine";
        readonly connectorAuthorizationHash: string;
        readonly connectorAuthorizationFactHash: string;
      }
    | {
        readonly mode: "core_discard";
        readonly reason: "unavailable_at_deadline" | "absolute_expiry";
        readonly coreConclusionFactHash: string;
        readonly discardAuthorizationHash: string;
      }
    | null;
}

const EVIDENCE_FACT_BY_DUTY = Object.freeze({
  freeze_evidence: "freeze_pending",
  ack_evidence: "ack_pending",
  quarantine_evidence: "quarantine_pending",
  cleanup_evidence: "cleanup_pending",
} as const);

function isEvolutionEvalEvidenceDuty(
  duty: EvolutionEvalDispatcherLease["duty"],
): duty is keyof typeof EVIDENCE_FACT_BY_DUTY {
  return Object.hasOwn(EVIDENCE_FACT_BY_DUTY, duty);
}

async function inspectEvolutionEvalEvidenceDuty(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
): Promise<EvolutionEvalEvidenceDutyInspection | null> {
  if (!isEvolutionEvalEvidenceDuty(lease.duty)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
    );
  }
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const claimedResult = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id,
              fact.fact_type,fact.fact_hash,fact.manifest_hash
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
         JOIN evolution_eval_evidence_fact fact ON fact.outbox_event_id=outbox.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
        FOR UPDATE OF lease,outbox,fact`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = claimedResult.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== lease.eventType
      || claimed.aggregate_id !== lease.aggregateId
      || claimed.fact_type !== EVIDENCE_FACT_BY_DUTY[
        lease.duty as keyof typeof EVIDENCE_FACT_BY_DUTY
      ]
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    if (claimed.published_at !== null) return null;
    const factsResult = await tx.query(
      `SELECT fact_type,fact_hash,manifest_hash,connector_manifest_hash,outbox_event_id
         FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1`,
      [job.eval_job_id],
    );
    const facts = new Map(
      (factsResult.rows as Row[]).map((fact) => [String(fact.fact_type), fact]),
    );
    const receiptsResult = await tx.query(
      `SELECT receipt_type,authorization_hash,connector_fact_hash
         FROM evolution_eval_retention_receipt WHERE eval_job_id=$1`,
      [job.eval_job_id],
    );
    const receipts = new Map(
      (receiptsResult.rows as Row[]).map((receipt) => [
        String(receipt.receipt_type),
        receipt,
      ]),
    );
    const publishNoOp = async (): Promise<null> => {
      const published = await tx.query(
        `UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE event_id=$1 AND published_at IS NULL RETURNING event_id`,
        [lease.eventId],
      );
      if (published.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();
      return null;
    };
    if (lease.duty === "freeze_evidence") {
      if (
        facts.has("frozen")
        || facts.has("corrupt")
        || facts.has("unavailable_at_deadline")
      ) return publishNoOp();
      if (
        job.deadline_valid !== true
        || !["succeeded", "failed", "cancelled", "timeout"].includes(String(job.state))
        || (
          job.state === "failed"
          && job.tool_error_code === "EVOLUTION_EVAL_NOT_ACCEPTED"
        )
      ) return null;
    } else if (lease.duty === "ack_evidence") {
      if (facts.has("acknowledged") || facts.has("expired")) return publishNoOp();
      if (!facts.has("frozen") || claimed.manifest_hash !== facts.get("frozen")?.manifest_hash) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_EVIDENCE_ACK_BINDING_CONFLICT",
        );
      }
    } else if (lease.duty === "quarantine_evidence") {
      if (!facts.has("corrupt")) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_EVIDENCE_QUARANTINE_BINDING_CONFLICT",
        );
      }
    } else {
      if (facts.has("cleaned")) return publishNoOp();
      const corrupt = facts.get("corrupt");
      if (corrupt) {
        const quarantine = facts.get("quarantine_pending");
        if (!quarantine) {
          throw new EvolutionEvalConnectorObservationError(
            "EVOLUTION_EVAL_EVIDENCE_CLEANUP_BINDING_CONFLICT",
          );
        }
        const quarantinePublished = await tx.query(
          "SELECT published_at FROM outbox_events WHERE event_id=$1",
          [quarantine.outbox_event_id],
        );
        if ((quarantinePublished.rows[0] as Row | undefined)?.published_at === null) {
          return null;
        }
      }
      if (!(
        facts.has("acknowledged")
        || facts.has("corrupt")
        || facts.has("unavailable_at_deadline")
        || facts.has("expired")
      )) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_EVIDENCE_CLEANUP_BINDING_CONFLICT",
        );
      }
    }
    const hydrated = await hydrateEvolutionEvalDispatchBindingRows(tx, job);
    const frozen = facts.get("frozen");
    const corrupt = facts.get("corrupt");
    const unavailable = facts.get("unavailable_at_deadline");
    const expired = facts.get("expired");
    const connectorAuthorizationReceipt = receipts.get("acknowledgement")
      ?? receipts.get("quarantine");
    if (
      expired
      && (
        !frozen
        || frozen.manifest_hash === null
        || frozen.connector_manifest_hash === null
        || job.tool_end_time === null
      )
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_EVIDENCE_CLEANUP_BINDING_CONFLICT",
      );
    }
    const binding = bindingFromRow(hydrated);
    const cleanup = lease.duty !== "cleanup_evidence"
      ? null
      : connectorAuthorizationReceipt
      ? {
          mode: "connector_authorized" as const,
          connectorAuthorizationKind: (
            connectorAuthorizationReceipt.receipt_type === "acknowledgement"
              ? "ack"
              : "quarantine"
          ) as "ack" | "quarantine",
          connectorAuthorizationHash: String(
            connectorAuthorizationReceipt.authorization_hash,
          ),
          connectorAuthorizationFactHash: String(
            connectorAuthorizationReceipt.connector_fact_hash,
          ),
        }
      : unavailable
      ? {
          mode: "core_discard" as const,
          reason: "unavailable_at_deadline" as const,
          coreConclusionFactHash: String(unavailable.fact_hash),
          discardAuthorizationHash: evolutionEvalDiscardAuthorizationHash(
            binding,
            { reason: "unavailable_at_deadline" },
          ),
        }
      : expired
      ? {
          mode: "core_discard" as const,
          reason: "absolute_expiry" as const,
          coreConclusionFactHash: String(expired.fact_hash),
          discardAuthorizationHash: evolutionEvalDiscardAuthorizationHash(
            binding,
            {
              reason: "absolute_expiry",
              connectorManifestHash: String(frozen!.connector_manifest_hash),
              terminalAt: iso(job.tool_end_time, "tool_end_time"),
            },
          ),
        }
      : null;
    if (lease.duty === "cleanup_evidence" && cleanup === null) return null;
    return {
      binding,
      toolRunId: String(job.tool_run_id),
      state: String(job.state),
      authorizationHash: String(claimed.fact_hash),
      coreManifestHash: frozen ? String(frozen.manifest_hash) : null,
      connectorManifestHash: frozen ? String(frozen.connector_manifest_hash) : null,
      corruptErrorFactHash: corrupt ? String(corrupt.fact_hash) : null,
      cleanup,
    };
  });
}

interface FetchedEvolutionEvalEvidence {
  readonly verified: VerifiedEvolutionEvalEvidenceManifest;
  readonly entries: readonly {
    readonly metadata: VerifiedEvolutionEvalEvidenceManifest["coreManifest"]["entries"][number];
    readonly path: string;
  }[];
}

async function registerEvolutionEvalTempOwner(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  tempPath: string,
): Promise<{ readonly ownerId: string; readonly tempPathHash: string }> {
  const ownerId = randomUUID();
  const tempPathHash = createHash("sha256").update(tempPath, "utf8").digest("hex");
  await withTransaction(client, async (tx) => {
    const current = await tx.query(
      `SELECT 1
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
          AND outbox.published_at IS NULL
          AND outbox.event_type='evolution_eval.evidence.freeze_requested'
          AND outbox.aggregate_id=$5
        FOR UPDATE OF lease,outbox`,
      [
        lease.eventId,
        lease.holderId,
        leaseNonceHash(lease.leaseNonce),
        lease.attemptCount,
        lease.aggregateId,
      ],
    );
    if (current.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();
    await tx.query(
      `INSERT INTO evolution_eval_temp_cleanup_owner
        (id,eval_job_id,outbox_event_id,lease_nonce_hash,lease_attempt_count,
         owner_id,temp_path_hash,cleanup_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '15 minutes')`,
      [
        ownerId,
        lease.aggregateId,
        lease.eventId,
        leaseNonceHash(lease.leaseNonce),
        lease.attemptCount,
        lease.holderId,
        tempPathHash,
      ],
    );
  });
  return { ownerId, tempPathHash };
}

async function requireEvolutionEvalEvidenceTempRoot(root: string): Promise<string> {
  const normalized = resolve(root);
  await mkdir(normalized, { recursive: true, mode: 0o700 });
  const [resolved, stat] = await Promise.all([realpath(normalized), lstat(normalized)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("EVOLUTION_EVAL_EVIDENCE_TEMP_ROOT_INVALID");
  }
  // macOS exposes tmpdir() through /var while realpath resolves /private/var.
  // The dedicated root itself must not be a symlink, but canonicalizing its
  // parents keeps ownership hashes stable across creation and recovery.
  return resolved;
}

async function cleanupEvolutionEvalTempOwner(
  client: TransactionClient,
  ownerId: string,
  root: string,
  tempPath: string,
): Promise<void> {
  await cleanupEvolutionEvalTempPath(root, tempPath);
  await client.query(
    `UPDATE evolution_eval_temp_cleanup_owner
        SET cleaned_at=clock_timestamp()
      WHERE id=$1 AND cleaned_at IS NULL`,
    [ownerId],
  );
}

async function cleanupEvolutionEvalTempPath(
  root: string,
  tempPath: string,
): Promise<void> {
  const normalizedRoot = await requireEvolutionEvalEvidenceTempRoot(root);
  const normalizedPath = resolve(tempPath);
  if (
    dirname(normalizedPath) !== normalizedRoot
    || !/^fetch-[A-Za-z0-9_-]+$/u.test(normalizedPath.slice(normalizedRoot.length + 1))
  ) {
    throw new Error("EVOLUTION_EVAL_EVIDENCE_TEMP_PATH_INVALID");
  }
  const stat = await lstat(normalizedPath).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink() || (stat !== null && !stat.isDirectory())) {
    throw new Error("EVOLUTION_EVAL_EVIDENCE_TEMP_PATH_INVALID");
  }
  await rm(tempPath, { recursive: true, force: true });
}

/**
 * Removes only due, hash-owned directories directly under the dedicated root.
 * Unknown entries and symbolic links are intentionally retained fail-closed.
 */
export async function recoverEvolutionEvalEvidenceTemp(
  client: TransactionClient,
  root = EVOLUTION_EVAL_EVIDENCE_TEMP_ROOT,
  limit = 32,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("evidence temp recovery limit must be between 1 and 100");
  }
  const normalizedRoot = await requireEvolutionEvalEvidenceTempRoot(root);
  const dueResult = await client.query(
    `SELECT owner.id,owner.temp_path_hash
       FROM evolution_eval_temp_cleanup_owner owner
       JOIN evolution_eval_dispatcher_lease lease
         ON lease.event_id=owner.outbox_event_id
        AND lease.lease_nonce_hash=owner.lease_nonce_hash
        AND lease.attempt_count=owner.lease_attempt_count
      WHERE owner.cleaned_at IS NULL
        AND owner.cleanup_after<=clock_timestamp()
        AND lease.lease_expires_at<=clock_timestamp()
      ORDER BY owner.cleanup_after,owner.id
      LIMIT $1`,
    [limit],
  );
  const due = new Map(
    (dueResult.rows as Row[]).map((row) => [String(row.temp_path_hash), String(row.id)]),
  );
  if (due.size === 0) return 0;
  const children = await readdir(normalizedRoot, { withFileTypes: true });
  let cleaned = 0;
  for (const child of children) {
    if (cleaned >= limit) break;
    if (
      !child.isDirectory()
      || child.isSymbolicLink()
      || !/^fetch-[A-Za-z0-9_-]+$/u.test(child.name)
    ) continue;
    const path = resolve(normalizedRoot, child.name);
    if (dirname(path) !== normalizedRoot) continue;
    const hash = createHash("sha256").update(path, "utf8").digest("hex");
    const ownerId = due.get(hash);
    if (!ownerId) continue;
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const removed = await withTransaction(client, async (tx) => {
      const locked = await tx.query(
        `SELECT owner.id
           FROM evolution_eval_temp_cleanup_owner owner
           JOIN evolution_eval_dispatcher_lease lease
             ON lease.event_id=owner.outbox_event_id
            AND lease.lease_nonce_hash=owner.lease_nonce_hash
            AND lease.attempt_count=owner.lease_attempt_count
          WHERE owner.id=$1 AND owner.temp_path_hash=$2
            AND owner.cleaned_at IS NULL
            AND owner.cleanup_after<=clock_timestamp()
            AND lease.lease_expires_at<=clock_timestamp()
          FOR UPDATE OF owner,lease`,
        [ownerId, hash],
      );
      if (locked.rows.length !== 1) return false;
      const lockedStat = await lstat(path);
      if (!lockedStat.isDirectory() || lockedStat.isSymbolicLink()) return false;
      await rm(path, { recursive: true, force: false });
      const marked = await tx.query(
        `UPDATE evolution_eval_temp_cleanup_owner
            SET cleaned_at=clock_timestamp()
          WHERE id=$1 AND cleaned_at IS NULL RETURNING id`,
        [ownerId],
      );
      return marked.rows.length === 1;
    });
    if (removed) cleaned += 1;
  }
  return cleaned;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten < 1) throw new Error("evidence temp write made no progress");
    offset += result.bytesWritten;
  }
}

async function fetchEvolutionEvalEvidenceToTemp(
  client: TransactionClient,
  connector: EvolutionEvalConnectorPort,
  lease: EvolutionEvalDispatcherLease,
  inspection: EvolutionEvalEvidenceDutyInspection,
  tempPath: string,
): Promise<FetchedEvolutionEvalEvidence> {
  const remoteManifest = await connector.fetchEvidenceManifest(inspection.binding);
  const verified = validateEvolutionEvalEvidenceConnectorManifest(
    inspection.binding,
    inspection.toolRunId,
    remoteManifest,
  );
  const tempEntries: Array<{
    readonly metadata: VerifiedEvolutionEvalEvidenceManifest["coreManifest"]["entries"][number];
    readonly path: string;
  }> = [];
  let actualTotalBytes = 0;
  for (let index = 0; index < verified.coreManifest.entries.length; index += 1) {
    const metadata = verified.coreManifest.entries[index]!;
    await renewEvolutionEvalDutyLease(client, lease);
    const content = await connector.fetchEvidenceEntry(inspection.binding, metadata.name);
    if (
      content === null
      || typeof content !== "object"
      || !(Symbol.asyncIterator in content)
    ) {
      throw new EvolutionEvalEvidenceCorruptError(
        "EVOLUTION_EVAL_EVIDENCE_ENTRY_STREAM_INVALID",
      );
    }
    const path = join(tempPath, `${index.toString().padStart(3, "0")}.entry`);
    const handle = await open(path, "wx", 0o600);
    const digest = createHash("sha256");
    let actualBytes = 0;
    try {
      for await (const rawChunk of content) {
        if (!(rawChunk instanceof Uint8Array)) {
          throw new EvolutionEvalEvidenceCorruptError(
            "EVOLUTION_EVAL_EVIDENCE_ENTRY_STREAM_INVALID",
          );
        }
        const chunk = Buffer.from(rawChunk);
        actualBytes += chunk.byteLength;
        actualTotalBytes += chunk.byteLength;
        if (
          actualBytes > metadata.size_bytes
          || actualBytes > EVOLUTION_EVAL_LIMITS.evidence.entryBytes
          || actualTotalBytes > EVOLUTION_EVAL_LIMITS.evidence.bytes
        ) {
          throw new EvolutionEvalEvidenceCorruptError(
            "EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED",
          );
        }
        digest.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (actualBytes !== metadata.size_bytes) {
      throw new EvolutionEvalEvidenceCorruptError(
        "EVOLUTION_EVAL_EVIDENCE_PARTIAL",
      );
    }
    if (digest.digest("hex") !== metadata.sha256) {
      throw new EvolutionEvalEvidenceCorruptError(
        "EVOLUTION_EVAL_EVIDENCE_ENTRY_HASH_MISMATCH",
      );
    }
    tempEntries.push({ metadata, path });
  }
  const declaredTotal = verified.coreManifest.entries.reduce(
    (sum, entry) => sum + entry.size_bytes,
    0,
  );
  if (actualTotalBytes !== declaredTotal) {
    throw new EvolutionEvalEvidenceCorruptError(
      "EVOLUTION_EVAL_EVIDENCE_PARTIAL",
    );
  }
  return { verified, entries: tempEntries };
}

export function validateEvolutionEvalRetentionResult(
  binding: CoreIssuedEvalBinding,
  expectedAuthorizationHash: string | null | undefined,
  input: unknown,
): EvalRetentionResult {
  if (!plain(input) || !exactKeys(input, [
    "schema",
    "binding",
    "state",
    "retryable",
    "authorization_kind",
    "authorization_hash",
    "connector_fact_hash",
    "source_authorization_kind",
    "source_authorization_hash",
    "source_connector_fact_hash",
    "physical_deleted",
    "error_code",
  ])) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
    );
  }
  if (
    input.schema !== "evolution-eval-retention-result.v1"
    || !sameCanonicalValue(input.binding, binding)
    || !["absent", "pending_ack", "acknowledged", "quarantined", "discarded", "cleaned", "expired", "transient_unavailable"]
      .includes(String(input.state))
    || typeof input.retryable !== "boolean"
    || !(input.authorization_kind === null || [
      "ack",
      "quarantine",
      "expiry",
      "discard",
      "cleanup",
    ].includes(String(input.authorization_kind)))
    || !(input.authorization_hash === null || (
      typeof input.authorization_hash === "string"
      && /^[0-9a-f]{64}$/.test(input.authorization_hash)
    ))
    || (
      expectedAuthorizationHash !== undefined
      && input.authorization_hash !== expectedAuthorizationHash
    )
    || !(input.connector_fact_hash === null || (
      typeof input.connector_fact_hash === "string"
      && /^[0-9a-f]{64}$/.test(input.connector_fact_hash)
    ))
    || !(input.source_authorization_kind === null || [
      "ack",
      "quarantine",
      "expiry",
      "discard",
    ].includes(String(input.source_authorization_kind)))
    || !(input.source_authorization_hash === null || (
      typeof input.source_authorization_hash === "string"
      && /^[0-9a-f]{64}$/.test(input.source_authorization_hash)
    ))
    || !(input.source_connector_fact_hash === null || (
      typeof input.source_connector_fact_hash === "string"
      && /^[0-9a-f]{64}$/.test(input.source_connector_fact_hash)
    ))
    || typeof input.physical_deleted !== "boolean"
    || !(input.error_code === null || (
      typeof input.error_code === "string" && ERROR_CODE.test(input.error_code)
    ))
    || (input.state === "transient_unavailable") !== (input.retryable === true)
    || (input.state === "transient_unavailable") !== (input.error_code !== null)
    || (["acknowledged", "quarantined", "discarded", "cleaned", "expired"].includes(String(input.state))
      && input.connector_fact_hash === null)
    || ((input.authorization_hash === null) !== (input.authorization_kind === null))
    || (
      ["absent", "pending_ack", "transient_unavailable"].includes(String(input.state))
      && (
        input.authorization_kind !== null
        || input.authorization_hash !== null
        || input.connector_fact_hash !== null
      )
    )
    || (["absent", "pending_ack"].includes(String(input.state))
      && input.physical_deleted !== false)
    || (input.state === "cleaned" && input.authorization_kind !== "cleanup")
    || (input.state === "cleaned" && input.physical_deleted !== true)
    || (
      input.state === "cleaned"
      && (
        input.source_authorization_kind === null
        || input.source_authorization_hash === null
        || input.source_connector_fact_hash === null
      )
    )
    || (
      input.state !== "cleaned"
      && (
        input.source_authorization_kind !== null
        || input.source_authorization_hash !== null
        || input.source_connector_fact_hash !== null
      )
    )
  ) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
    );
  }
  return structuredClone(input) as unknown as EvalRetentionResult;
}

async function lockCurrentEvidenceLease(
  tx: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
): Promise<Row> {
  const current = await tx.query(
    `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id,
            fact.fact_type,fact.fact_hash,fact.manifest_hash
       FROM evolution_eval_dispatcher_lease lease
       JOIN outbox_events outbox ON outbox.event_id=lease.event_id
       JOIN evolution_eval_evidence_fact fact ON fact.outbox_event_id=outbox.event_id
      WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
        AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
      FOR UPDATE OF lease,outbox,fact`,
    [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
  );
  const row = current.rows[0] as Row | undefined;
  if (!row) throw new EvolutionEvalDispatcherLeaseLostError();
  if (
    row.published_at !== null
    || row.event_type !== lease.eventType
    || row.aggregate_id !== lease.aggregateId
    || !isEvolutionEvalEvidenceDuty(lease.duty)
    || row.fact_type !== EVIDENCE_FACT_BY_DUTY[lease.duty]
  ) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
    );
  }
  return row;
}

async function publishCurrentEvolutionEvalDuty(
  tx: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
): Promise<void> {
  const published = await tx.query(
    `UPDATE outbox_events SET published_at=clock_timestamp()
      WHERE event_id=$1 AND published_at IS NULL RETURNING event_id`,
    [lease.eventId],
  );
  if (published.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();
}

async function markEvolutionEvalEvidenceTransportRequired(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
): Promise<void> {
  await withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    await lockCurrentEvidenceLease(tx, lease);
    const conclusion = await tx.query(
      `SELECT 1 FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1
          AND fact_type IN ('frozen','corrupt','unavailable_at_deadline')`,
      [job.eval_job_id],
    );
    // The freeze outbox is itself the durable retry intent after terminal.
    // Execution reconciliation facts are constrained to in-flight jobs and
    // must never be forged for an already terminal ToolRun.
    if (
      conclusion.rows.length === 0
      && job.deadline_valid === true
      && job.state === "running"
    ) {
      await appendDispatcherReconcileIntent(tx, job);
    }
  });
}

async function freezeEvolutionEvalEvidence(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  inspection: EvolutionEvalEvidenceDutyInspection,
  fetched: FetchedEvolutionEvalEvidence,
): Promise<boolean> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    await lockCurrentEvidenceLease(tx, lease);
    const conclusion = await tx.query(
      `SELECT fact_type,manifest_hash FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1
          AND fact_type IN ('frozen','corrupt','unavailable_at_deadline')`,
      [job.eval_job_id],
    );
    if (conclusion.rows.length > 0) {
      await publishCurrentEvolutionEvalDuty(tx, lease);
      return false;
    }
    if (job.deadline_valid !== true) return false;
    const currentBinding = bindingFromRow(
      await hydrateEvolutionEvalDispatchBindingRows(tx, job),
    );
    if (
      !sameCanonicalValue(currentBinding, inspection.binding)
      || fetched.verified.coreManifest.eval_job_id !== job.eval_job_id
      || fetched.verified.coreManifest.tool_run_id !== job.tool_run_id
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_EVIDENCE_BINDING_CONFLICT",
      );
    }
    const entryCount = fetched.entries.length;
    const totalBytes = fetched.entries.reduce(
      (sum, entry) => sum + entry.metadata.size_bytes,
      0,
    );
    const frozenFactHash = evolutionEvalCanonicalHash({
      schema: "evolution-eval-evidence-frozen-fact.v1",
      eval_job_id: job.eval_job_id,
      core_manifest_hash: fetched.verified.coreManifestHash,
      connector_manifest_hash: fetched.verified.connectorManifest.manifest_hash,
    });
    const frozenFactId = await appendDispatcherEvidenceFact(tx, job, "frozen", {
      factHash: frozenFactHash,
      manifestHash: fetched.verified.coreManifestHash,
      connectorManifestHash: fetched.verified.connectorManifest.manifest_hash,
      manifest: fetched.verified.coreManifest,
      entryCount,
      totalBytes,
    });
    for (const entry of fetched.entries) {
      const content = await readFile(entry.path);
      if (
        content.byteLength !== entry.metadata.size_bytes
        || createHash("sha256").update(content).digest("hex") !== entry.metadata.sha256
      ) {
        throw new EvolutionEvalEvidenceCorruptError(
          "EVOLUTION_EVAL_EVIDENCE_TEMP_DRIFT",
        );
      }
      await tx.query(
        `INSERT INTO evolution_eval_evidence_entry
          (id,evidence_fact_id,eval_job_id,name,sha256,size_bytes,media_type,
           artifact_classification,usage_classification,managed_content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          factId("eeee"),
          frozenFactId,
          job.eval_job_id,
          entry.metadata.name,
          entry.metadata.sha256,
          entry.metadata.size_bytes,
          entry.metadata.media_type,
          entry.metadata.artifact_classification,
          entry.metadata.usage_classification,
          content,
        ],
      );
    }
    if (job.reconciliation_state === "required") {
      await tx.query(
        `UPDATE evolution_eval_job SET reconciliation_state='confirmed'
          WHERE id=$1 AND reconciliation_state='required'`,
        [job.eval_job_id],
      );
    }
    await publishCurrentEvolutionEvalDuty(tx, lease);
    return true;
  });
}

async function corruptEvolutionEvalEvidence(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  reason: string,
): Promise<boolean> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    await lockCurrentEvidenceLease(tx, lease);
    const conclusion = await tx.query(
      `SELECT fact_type FROM evolution_eval_evidence_fact
        WHERE eval_job_id=$1
          AND fact_type IN ('frozen','corrupt','unavailable_at_deadline')`,
      [job.eval_job_id],
    );
    if (conclusion.rows.length > 0) {
      await publishCurrentEvolutionEvalDuty(tx, lease);
      return false;
    }
    if (job.deadline_valid !== true) return false;
    const errorCode = "EVOLUTION_EVAL_EVIDENCE_CORRUPT";
    const errorFactHash = evolutionEvalCanonicalHash({
      schema: "evolution-eval-evidence-corrupt-fact.v1",
      eval_job_id: job.eval_job_id,
      dispatch_request_hash: job.dispatch_request_hash,
      freeze_event_id: lease.eventId,
      error_code: errorCode,
      reason_code: ERROR_CODE.test(reason) ? reason : errorCode,
    });
    await appendDispatcherEvidenceFact(tx, job, "corrupt", {
      factHash: errorFactHash,
      errorCode,
    });
    await appendDispatcherEvidenceFact(tx, job, "quarantine_pending", {
      factHash: evolutionEvalCanonicalHash({
        schema: "evolution-eval-evidence-quarantine-intent.v1",
        eval_job_id: job.eval_job_id,
        error_fact_hash: errorFactHash,
      }),
    });
    await appendDispatcherEvidenceFact(tx, job, "cleanup_pending", {
      factHash: evolutionEvalCanonicalHash({
        schema: "evolution-eval-evidence-cleanup.v1",
        eval_job_id: job.eval_job_id,
        cause_fact_hash: errorFactHash,
      }),
    });
    if (job.reconciliation_state === "required") {
      await tx.query(
        `UPDATE evolution_eval_job SET reconciliation_state='confirmed'
          WHERE id=$1 AND reconciliation_state='required'`,
        [job.eval_job_id],
      );
    }
    await publishCurrentEvolutionEvalDuty(tx, lease);
    return true;
  });
}

async function settleEvolutionEvalRetentionDuty(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  result: EvalRetentionResult,
): Promise<string> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const claimed = await lockCurrentEvidenceLease(tx, lease);
    const factsResult = await tx.query(
      `SELECT fact_type,manifest_hash,fact_hash
         FROM evolution_eval_evidence_fact WHERE eval_job_id=$1`,
      [job.eval_job_id],
    );
    const facts = new Map(
      (factsResult.rows as Row[]).map((fact) => [String(fact.fact_type), fact]),
    );
    const insertReceipt = async (
      receiptType: "acknowledgement" | "quarantine" | "cleanup",
    ): Promise<void> => {
      if (result.authorization_hash === null || result.connector_fact_hash === null) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
        );
      }
      const inserted = await tx.query(
        `INSERT INTO evolution_eval_retention_receipt
          (id,eval_job_id,receipt_type,connector_state,authorization_hash,
           connector_fact_hash,source_authorization_kind,source_authorization_hash,
           source_connector_fact_hash,outbox_event_id,holder_id,lease_nonce_hash,
           lease_attempt_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          randomUUID(),
          job.eval_job_id,
          receiptType,
          result.state,
          result.authorization_hash,
          result.connector_fact_hash,
          result.source_authorization_kind,
          result.source_authorization_hash,
          result.source_connector_fact_hash,
          lease.eventId,
          lease.holderId,
          leaseNonceHash(lease.leaseNonce),
          lease.attemptCount,
        ],
      );
      if (inserted.rows.length !== 1) {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_RETENTION_RECEIPT_CONFLICT",
        );
      }
    };
    if (lease.duty === "ack_evidence") {
      if (facts.has("expired")) {
        await publishCurrentEvolutionEvalDuty(tx, lease);
        return "expired";
      }
      if (result.state !== "acknowledged") {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
        );
      }
      if (!facts.has("acknowledged")) {
        const manifestHash = String(claimed.manifest_hash);
        await insertReceipt("acknowledgement");
        await appendDispatcherEvidenceFact(tx, job, "acknowledged", {
          factHash: evolutionEvalCanonicalHash({
            schema: "evolution-eval-evidence-acknowledged.v1",
            eval_job_id: job.eval_job_id,
            manifest_hash: manifestHash,
            connector_fact_hash: result.connector_fact_hash,
          }),
          manifestHash,
        });
      }
    } else if (lease.duty === "quarantine_evidence") {
      if (result.state !== "quarantined" && result.state !== "cleaned") {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
        );
      }
      await insertReceipt("quarantine");
    } else if (lease.duty === "cleanup_evidence") {
      if (result.state !== "cleaned") {
        throw new EvolutionEvalConnectorObservationError(
          "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
        );
      }
      if (!facts.has("cleaned")) {
        await insertReceipt("cleanup");
        await appendDispatcherEvidenceFact(tx, job, "cleaned", {
          factHash: evolutionEvalCanonicalHash({
            schema: "evolution-eval-evidence-cleaned.v1",
            eval_job_id: job.eval_job_id,
            connector_fact_hash: result.connector_fact_hash,
          }),
        });
      }
    } else {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    await publishCurrentEvolutionEvalDuty(tx, lease);
    return result.state;
  });
}

async function processEvolutionEvalEvidenceDuty(
  client: TransactionClient,
  connector: EvolutionEvalConnectorPort,
  lease: EvolutionEvalDispatcherLease,
  options: EvolutionEvalProcessDutyOptions,
): Promise<EvolutionEvalProcessDutyResult> {
  const inspection = await inspectEvolutionEvalEvidenceDuty(client, lease);
  if (!inspection) {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "settled",
      state: null,
    };
  }
  if (lease.duty === "freeze_evidence") {
    const root = await requireEvolutionEvalEvidenceTempRoot(
      options.evidenceTempRoot ?? EVOLUTION_EVAL_EVIDENCE_TEMP_ROOT,
    );
    const tempPath = await mkdtemp(join(root, "fetch-"));
    let owner: Awaited<ReturnType<typeof registerEvolutionEvalTempOwner>>;
    try {
      owner = await registerEvolutionEvalTempOwner(client, lease, tempPath);
    } catch (error) {
      await cleanupEvolutionEvalTempPath(root, tempPath).catch(() => undefined);
      throw error;
    }
    try {
      let fetched: FetchedEvolutionEvalEvidence;
      try {
        fetched = await fetchEvolutionEvalEvidenceToTemp(
          client,
          connector,
          lease,
          inspection,
          tempPath,
        );
      } catch (error) {
        const corruptionCode = error instanceof EvolutionEvalEvidenceCorruptError
          ? error.message
          : evolutionEvalEvidenceCorruptionCode(error);
        if (corruptionCode !== null) {
          const changed = await corruptEvolutionEvalEvidence(
            client,
            lease,
            corruptionCode,
          );
          return {
            eventId: lease.eventId,
            duty: lease.duty,
            outcome: changed ? "settled" : "waiting",
            state: changed ? "corrupt" : inspection.state,
          };
        }
        await markEvolutionEvalEvidenceTransportRequired(client, lease);
        return {
          eventId: lease.eventId,
          duty: lease.duty,
          outcome: "waiting",
          state: inspection.state,
        };
      }
      let frozen: boolean;
      try {
        frozen = await freezeEvolutionEvalEvidence(
          client,
          lease,
          inspection,
          fetched,
        );
      } catch (error) {
        if (!(error instanceof EvolutionEvalEvidenceCorruptError)) throw error;
        const changed = await corruptEvolutionEvalEvidence(
          client,
          lease,
          error.message,
        );
        return {
          eventId: lease.eventId,
          duty: lease.duty,
          outcome: changed ? "settled" : "waiting",
          state: changed ? "corrupt" : inspection.state,
        };
      }
      if (frozen) {
        await materializeEvolutionEvalJobRetentionIntents(client, lease.aggregateId);
      }
      return {
        eventId: lease.eventId,
        duty: lease.duty,
        outcome: frozen ? "settled" : "waiting",
        state: frozen ? "frozen" : inspection.state,
      };
    } finally {
      await cleanupEvolutionEvalTempOwner(client, owner.ownerId, root, tempPath);
    }
  }

  let ledger: EvalLedgerQuery;
  let queriedRetention: EvalRetentionResult;
  try {
    ledger = validateEvolutionEvalLedgerObservation(
      inspection.binding,
      await connector.query(inspection.binding),
    );
    queriedRetention = validateEvolutionEvalRetentionResult(
      inspection.binding,
      undefined,
      await connector.queryRetention(inspection.binding),
    );
  } catch {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "waiting",
      state: inspection.state,
    };
  }
  if (lease.duty === "ack_evidence" && ledger.state !== "terminal") {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "waiting",
      state: inspection.state,
    };
  }
  const expectedAuthorizationKind = lease.duty === "ack_evidence"
    ? "ack"
    : lease.duty === "quarantine_evidence"
    ? "quarantine"
    : inspection.cleanup?.mode === "core_discard"
      ? inspection.cleanup.reason === "absolute_expiry" ? "expiry" : "discard"
      : "cleanup";
  const queryMatchesAuthorization = lease.duty !== "cleanup_evidence"
    ? queriedRetention.authorization_hash === inspection.authorizationHash
      && queriedRetention.authorization_kind === expectedAuthorizationKind
    : inspection.cleanup?.mode === "core_discard"
      ? (
          queriedRetention.state === "cleaned"
          && queriedRetention.authorization_kind === "cleanup"
          && queriedRetention.authorization_hash === inspection.authorizationHash
          && queriedRetention.source_authorization_kind === "discard"
          && queriedRetention.source_authorization_hash
            === inspection.cleanup.discardAuthorizationHash
        ) || (
          queriedRetention.state === "discarded"
          && queriedRetention.authorization_kind === "discard"
          && queriedRetention.authorization_hash
            === inspection.cleanup.discardAuthorizationHash
        )
      : queriedRetention.authorization_hash === inspection.authorizationHash
        && queriedRetention.authorization_kind === "cleanup"
        && queriedRetention.source_authorization_kind
          === inspection.cleanup?.connectorAuthorizationKind
        && queriedRetention.source_authorization_hash
          === inspection.cleanup?.connectorAuthorizationHash
        && queriedRetention.source_connector_fact_hash
          === inspection.cleanup?.connectorAuthorizationFactHash;
  if (
    queryMatchesAuthorization
    && (
      (lease.duty === "ack_evidence" && queriedRetention.state === "acknowledged")
      || (lease.duty === "quarantine_evidence" && queriedRetention.state === "quarantined")
      || (lease.duty === "cleanup_evidence"
        && queriedRetention.state === "cleaned")
    )
  ) {
    const state = await settleEvolutionEvalRetentionDuty(
      client,
      lease,
      queriedRetention,
    );
    if (lease.duty === "ack_evidence") {
      await materializeEvolutionEvalJobRetentionIntents(client, lease.aggregateId);
    }
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "settled",
      state,
    };
  }
  if (queriedRetention.state === "transient_unavailable") {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "waiting",
      state: inspection.state,
    };
  }
  let rawResult: unknown;
  try {
    if (lease.duty === "ack_evidence") {
      const request: EvalEvidenceAckRequestV1 = {
        schema: "evolution-eval-evidence-ack-request.v1",
        binding: inspection.binding,
        connector_manifest_hash: inspection.connectorManifestHash!,
        core_manifest_hash: inspection.coreManifestHash!,
        core_ack_fact_hash: inspection.authorizationHash,
      };
      rawResult = await connector.acknowledgeEvidence(request);
    } else if (lease.duty === "quarantine_evidence") {
      const request: EvalEvidenceCorruptAckRequestV1 = {
        schema: "evolution-eval-evidence-corrupt-ack-request.v1",
        binding: inspection.binding,
        error_fact_hash: inspection.corruptErrorFactHash!,
        core_quarantine_fact_hash: inspection.authorizationHash,
      };
      rawResult = await connector.acknowledgeCorrupt(request);
    } else {
      const cleanup = inspection.cleanup!;
      const request: EvalEvidenceCleanupRequestV1 = cleanup.mode === "connector_authorized"
        ? {
            schema: "evolution-eval-evidence-cleanup-request.v1",
            binding: inspection.binding,
            mode: "connector_authorized",
            connector_authorization_fact_hash:
              cleanup.connectorAuthorizationFactHash,
            core_cleanup_fact_hash: inspection.authorizationHash,
          }
        : cleanup.reason === "absolute_expiry"
          ? {
              schema: "evolution-eval-evidence-cleanup-request.v1",
              binding: inspection.binding,
              mode: "core_discard",
              reason: cleanup.reason,
              core_manifest_hash: inspection.coreManifestHash!,
              core_conclusion_fact_hash: cleanup.coreConclusionFactHash,
              core_cleanup_fact_hash: inspection.authorizationHash,
              discard_authorization_hash: cleanup.discardAuthorizationHash,
            }
          : {
              schema: "evolution-eval-evidence-cleanup-request.v1",
              binding: inspection.binding,
              mode: "core_discard",
              reason: cleanup.reason,
              core_conclusion_fact_hash: cleanup.coreConclusionFactHash,
              core_cleanup_fact_hash: inspection.authorizationHash,
              discard_authorization_hash: cleanup.discardAuthorizationHash,
            };
      rawResult = await connector.cleanupEvidence(request);
    }
  } catch {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "waiting",
      state: inspection.state,
    };
  }
  const result = validateEvolutionEvalRetentionResult(
    inspection.binding,
    undefined,
    rawResult,
  );
  const resultMatchesAuthorization = lease.duty !== "cleanup_evidence"
    ? result.authorization_hash === inspection.authorizationHash
      && result.authorization_kind === expectedAuthorizationKind
    : inspection.cleanup?.mode === "core_discard"
      ? (
          result.state === "cleaned"
          && result.authorization_kind === "cleanup"
          && result.authorization_hash === inspection.authorizationHash
          && result.source_authorization_kind === "discard"
          && result.source_authorization_hash
            === inspection.cleanup.discardAuthorizationHash
        ) || (
          result.state === "discarded"
          && result.authorization_kind === "discard"
          && result.authorization_hash === inspection.cleanup.discardAuthorizationHash
        )
      : result.authorization_hash === inspection.authorizationHash
        && result.authorization_kind === "cleanup"
        && result.source_authorization_kind
          === inspection.cleanup?.connectorAuthorizationKind
        && result.source_authorization_hash
          === inspection.cleanup?.connectorAuthorizationHash
        && result.source_connector_fact_hash
          === inspection.cleanup?.connectorAuthorizationFactHash;
  if (!resultMatchesAuthorization && result.state !== "transient_unavailable") {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_RETENTION_RESULT_INVALID",
    );
  }
  if (
    result.state === "transient_unavailable"
    || result.state === "discarded"
    || result.state === "expired"
    || result.state === "pending_ack"
  ) {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "waiting",
      state: inspection.state,
    };
  }
  const state = await settleEvolutionEvalRetentionDuty(client, lease, result);
  if (lease.duty === "ack_evidence") {
    await materializeEvolutionEvalJobRetentionIntents(client, lease.aggregateId);
  }
  return {
    eventId: lease.eventId,
    duty: lease.duty,
    outcome: "settled",
    state,
  };
}

async function rejectEvolutionEvalDispatchBeforeEffect(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  reasonCode:
    | "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH"
    | "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
): Promise<string> {
  return withTransaction(client, async (tx) => {
    const job = await lockDispatchRows(tx, lease.aggregateId);
    if (!job) throw new Error("EVOLUTION_EVAL_DISPATCH_BINDING_NOT_FOUND");
    const currentLease = await tx.query(
      `SELECT outbox.published_at,outbox.event_type,outbox.aggregate_id
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
        WHERE lease.event_id=$1 AND lease.holder_id=$2 AND lease.lease_nonce_hash=$3
          AND lease.attempt_count=$4 AND lease.lease_expires_at>clock_timestamp()
        FOR UPDATE OF lease,outbox`,
      [lease.eventId, lease.holderId, leaseNonceHash(lease.leaseNonce), lease.attemptCount],
    );
    const claimed = currentLease.rows[0] as Row | undefined;
    if (!claimed) throw new EvolutionEvalDispatcherLeaseLostError();
    if (
      claimed.event_type !== "evolution_eval.dispatch_requested"
      || claimed.aggregate_id !== lease.aggregateId
    ) {
      throw new EvolutionEvalConnectorObservationError(
        "EVOLUTION_EVAL_DISPATCHER_EVENT_MISMATCH",
      );
    }
    if (claimed.published_at !== null) return String(job.state);
    if (job.state === "submitted" && job.has_tombstone !== true) {
      const errorHash = evolutionEvalCanonicalHash({
        schema: "evolution-eval-dispatch-tombstone.v1",
        eval_job_id: job.eval_job_id,
        reason_code: reasonCode,
      });
      await appendDispatcherTombstone(tx, job, reasonCode, errorHash);
      const sequenceResult = await tx.query(
        `SELECT COALESCE(max(transition_sequence),0)::int+1 AS sequence
           FROM evolution_eval_transition_fact WHERE eval_job_id=$1`,
        [job.eval_job_id],
      );
      await appendTransition(
        tx,
        job,
        "submitted",
        "rejected",
        Number((sequenceResult.rows[0] as Row).sequence),
        { errorCode: reasonCode, endTime: null },
      );
      await publishConfirmedPreEffectTombstoneDuty(tx, String(job.eval_job_id));
      job.state = "rejected";
    }
    if (job.state !== "rejected") {
      throw new Error("EVOLUTION_EVAL_PRE_EFFECT_REJECTION_STATE_CONFLICT");
    }
    const published = await tx.query(
      `UPDATE outbox_events SET published_at=clock_timestamp()
        WHERE event_id=$1 AND published_at IS NULL RETURNING event_id`,
      [lease.eventId],
    );
    if (published.rows.length !== 1) throw new EvolutionEvalDispatcherLeaseLostError();
    return String(job.state);
  });
}

async function observeAndSettle(
  client: TransactionClient,
  lease: EvolutionEvalDispatcherLease,
  binding: CoreIssuedEvalBinding,
  input: unknown,
  options: {
    readonly definitiveBoundary?: boolean;
    readonly replayAllowed?: boolean;
  } = {},
): Promise<EvolutionEvalSettleResult> {
  const recorded = await recordEvolutionEvalLedgerObservation(
    client,
    lease,
    binding,
    input,
  );
  return settleEvolutionEvalLedgerObservation(client, lease, binding, recorded, options);
}

/** Executes at most one claimed duty; every Connector await occurs outside a DB transaction. */
export async function processEvolutionEvalDuty(
  client: TransactionClient,
  connector: EvolutionEvalConnectorPort,
  lease: EvolutionEvalDispatcherLease,
  options: EvolutionEvalProcessDutyOptions = {},
): Promise<EvolutionEvalProcessDutyResult> {
  if (
    lease.duty === "freeze_evidence"
    || lease.duty === "ack_evidence"
    || lease.duty === "quarantine_evidence"
    || lease.duty === "cleanup_evidence"
  ) {
    return processEvolutionEvalEvidenceDuty(client, connector, lease, options);
  }
  const inspection = await inspectEvolutionEvalClaimedDuty(client, lease);
  if (inspection.status === "no_op") {
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "settled",
      state: inspection.state,
    };
  }
  const binding = inspection.binding;
  let inspectedState = inspection.state;
  if (
    lease.duty === "dispatch"
    && inspectedState === "submitted"
    && inspection.requiresConservativeProjection
  ) {
    await establishConservativeEffectPossibleProjectionForRecovery(
      client,
      lease,
      binding,
    );
    inspectedState = "running";
  }
  const replayAllowed = options.allowNewEffects === true
    && options.rolloutEnabled === true
    && !inspection.learningPaused;
  if (
    lease.duty === "dispatch"
    && inspectedState === "submitted"
    && !replayAllowed
  ) {
    const state = await rejectEvolutionEvalDispatchBeforeEffect(
      client,
      lease,
      "EVOLUTION_EVAL_CANCELLED_BEFORE_DISPATCH",
    );
    return {
      eventId: lease.eventId,
      duty: lease.duty,
      outcome: "new_effect_disabled",
      state,
    };
  }
  let queried = validateEvolutionEvalLedgerObservation(
    binding,
    await connector.query(binding),
  );
  let settled = await observeAndSettle(client, lease, binding, queried, {
    replayAllowed,
  });
  if (
    lease.duty === "dispatch"
    && queried.state === "ambiguous"
    && queried.error_code === "EVOLUTION_EVAL_LEDGER_NO_PROOF"
  ) {
    queried = validateEvolutionEvalLedgerObservation(
      binding,
      await connector.queryOrReserve(binding),
    );
    settled = await observeAndSettle(client, lease, binding, queried, {
      replayAllowed,
    });
  }

  console.error("[m4f-diagnostic] settled action:", settled.action, "duty:", lease.duty);
  if (settled.action === "cancel") {
    const cancelled = await connector.cancel(
      binding,
      inspection.cancelReason ?? (lease.duty === "tombstone" ? "tombstoned" : "shutdown"),
    );
    settled = await observeAndSettle(client, lease, binding, cancelled, {
      definitiveBoundary: inspection.definitiveCancelBoundary,
    });
  } else if (settled.action === "replay" && lease.duty === "dispatch") {
    try {
    const preflight = validateEvolutionEvalPreflight(
      binding,
      await connector.preflight(binding),
    );
    const spool = validateEvolutionEvalSpool(
      binding,
      await connector.querySpool(binding),
    );
    const preflightSpoolFull = preflight.error_code === "EVOLUTION_EVAL_SPOOL_FULL"
      || preflight.unacked_spool_bytes >= preflight.hard_cap_bytes;
    const spoolAvailable = !preflightSpoolFull
      && spool.unackedBytes < spool.hardCapBytes;
    if (!spoolAvailable) {
      console.error("[m4f-diagnostic] replay waiting: spool unavailable", JSON.stringify({ preflightError: preflight.error_code, unacked: preflight.unacked_spool_bytes, spoolUnacked: spool.unackedBytes }));
      return {
        eventId: lease.eventId,
        duty: lease.duty,
        outcome: "waiting",
        state: settled.state,
      };
    }
    if (!preflight.eligible || !preflight.license_available) {
      const state = await rejectEvolutionEvalDispatchBeforeEffect(
        client,
        lease,
        "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
      );
      return {
        eventId: lease.eventId,
        duty: lease.duty,
        outcome: "settled",
        state,
      };
    }
    const fenced = await fenceEvolutionEvalDispatch(client, lease, {
      newEffectsEnabled: options.allowNewEffects === true,
      rolloutEnabled: options.rolloutEnabled === true,
      spoolAvailable,
    });
    if (fenced.status !== "ready") {
      console.error("[m4f-diagnostic] replay waiting: fence", JSON.stringify(fenced));
      return {
        eventId: lease.eventId,
        duty: lease.duty,
        outcome: "waiting",
        state: settled.state,
      };
    }
    const sealedInput = await (options.loadSealedInput ?? loadEvolutionEvalSealedInput)(
      client,
      fenced.binding,
    );
    console.error("[m4f-diagnostic] submitting eval job", fenced.binding.dispatch.eval_job_id,
      "profile", fenced.binding.dispatch.toolchain_profile_hash,
      "deadline", fenced.binding.dispatch.deadline_at,
      "manifest_files", sealedInput.manifest.files.length);
    let submitted: Awaited<ReturnType<EvolutionEvalConnectorPort["submit"]>>;
    try {
      submitted = await connector.submit(fenced.binding, sealedInput);
      console.error("[m4f-diagnostic] eval submit returned", JSON.stringify(submitted).slice(0, 300));
    } catch (error) {
      console.error("[m4f-diagnostic] eval submit rejected:", error instanceof Error ? error.message : error);
      throw error;
    }
    settled = await observeAndSettle(client, lease, fenced.binding, submitted);
    } catch (replayError) {
      console.error("[m4f-diagnostic] replay branch failed:", replayError instanceof Error ? replayError.message : replayError);
      throw replayError;
    }
  }

  return {
    eventId: lease.eventId,
    duty: lease.duty,
    outcome: settled.published ? "settled" : "waiting",
    state: settled.state,
  };
}

export function validateEvolutionEvalPreflight(
  binding: CoreIssuedEvalBinding,
  input: unknown,
): EvalPreflight {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_CONNECTOR_PREFLIGHT_INVALID",
    );
  }
  const row = input as Record<string, unknown>;
  const expected = [
    "capability_version",
    "eligible",
    "error_code",
    "hard_cap_bytes",
    "license_available",
    "operation",
    "unacked_spool_bytes",
  ].sort();
  const actual = Object.keys(row).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || row.operation !== binding.dispatch.operation
    || typeof row.eligible !== "boolean"
    || typeof row.license_available !== "boolean"
    || (row.capability_version !== null && typeof row.capability_version !== "string")
    || (row.error_code !== null && typeof row.error_code !== "string")
    || !Number.isSafeInteger(row.unacked_spool_bytes)
    || Number(row.unacked_spool_bytes) < 0
    || row.hard_cap_bytes !== EVOLUTION_EVAL_LIMITS.connectorUnackedSpoolBytes
    || ((row.eligible !== true || row.license_available !== true) && row.error_code === null)
  ) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_CONNECTOR_PREFLIGHT_INVALID",
    );
  }
  return input as EvalPreflight;
}

export function validateEvolutionEvalSpool(
  binding: CoreIssuedEvalBinding,
  input: unknown,
): Awaited<ReturnType<EvolutionEvalConnectorPort["querySpool"]>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_CONNECTOR_SPOOL_INVALID",
    );
  }
  const row = input as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [
    "binding",
    "hardCapBytes",
    "schema",
    "unackedBytes",
  ].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || row.schema !== "evolution-eval-spool-result.v1"
    || !sameCanonicalValue(row.binding, binding)
    || !Number.isSafeInteger(row.unackedBytes)
    || Number(row.unackedBytes) < 0
    || row.hardCapBytes !== EVOLUTION_EVAL_LIMITS.connectorUnackedSpoolBytes
  ) {
    throw new EvolutionEvalConnectorObservationError(
      "EVOLUTION_EVAL_CONNECTOR_SPOOL_INVALID",
    );
  }
  return input as Awaited<ReturnType<EvolutionEvalConnectorPort["querySpool"]>>;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  try {
    return evolutionEvalCanonicalHash(left) === evolutionEvalCanonicalHash(right);
  } catch {
    return false;
  }
}

export interface EvolutionEvalDispatcherTickOptions extends EvolutionEvalProcessDutyOptions {
  readonly holderId: string;
  readonly maxDuties?: number;
  readonly leaseMs?: number;
  readonly materializeDeadlines?: boolean;
  readonly materializeRetention?: boolean;
  readonly recoverEvidenceTemp?: boolean;
}

export interface EvolutionEvalDispatcherTickResult {
  readonly claimed: number;
  readonly deadlineRunsMaterialized: number;
  readonly retentionJobsMaterialized: number;
  readonly tempDirectoriesRecovered: number;
  readonly results: readonly EvolutionEvalProcessDutyResult[];
}

/** A bounded, caller-scheduled tick; it never installs an unbounded timer. */
export async function runEvolutionEvalDispatcherTick(
  client: TransactionClient,
  connector: EvolutionEvalConnectorPort,
  options: EvolutionEvalDispatcherTickOptions,
): Promise<EvolutionEvalDispatcherTickResult> {
  const maxDuties = options.maxDuties ?? 10;
  if (!Number.isSafeInteger(maxDuties) || maxDuties < 1 || maxDuties > 100) {
    throw new TypeError("maxDuties must be between 1 and 100");
  }
  const tempDirectoriesRecovered = options.recoverEvidenceTemp === false
    ? 0
    : await recoverEvolutionEvalEvidenceTemp(
        client,
        options.evidenceTempRoot ?? EVOLUTION_EVAL_EVIDENCE_TEMP_ROOT,
        maxDuties,
      );
  const deadlineRunsMaterialized = options.materializeDeadlines === false
    ? 0
    : await materializeEvolutionEvalDeadlineIntents(client, maxDuties);
  const retentionJobsMaterialized = options.materializeRetention === false
    ? 0
    : await materializeEvolutionEvalRetentionIntents(client, maxDuties);
  const results: EvolutionEvalProcessDutyResult[] = [];
  for (let index = 0; index < maxDuties; index += 1) {
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: options.holderId,
      leaseMs: options.leaseMs,
    });
    if (!lease) break;
    results.push(await processEvolutionEvalDuty(client, connector, lease, options));
  }
  return {
    claimed: results.length,
    deadlineRunsMaterialized,
    retentionJobsMaterialized,
    tempDirectoriesRecovered,
    results,
  };
}
