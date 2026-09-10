import type {
  EvolutionEvalEvidenceManifestEntryV1,
  EvolutionEvalOperation,
  EvolutionEvalParametersV1,
  EvolutionEvalWorkspaceManifestV1,
} from "../domain/evolution-eval.ts";
import { evolutionEvalCanonicalHash } from "../domain/evolution-eval.ts";

export interface EvalEvidenceConnectorManifestV1 {
  readonly schema: "evolution-eval-connector-evidence-manifest.v1";
  readonly eval_job_id: string;
  readonly connector_job_id: string;
  readonly dispatch_request_hash: string;
  readonly entries: readonly EvolutionEvalEvidenceManifestEntryV1[];
  readonly manifest_hash: string;
}

export interface EvolutionEvalDispatchRequestV1 {
  readonly schema: "evolution-eval-dispatch-request.v1";
  readonly eval_job_id: string;
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly eval_input_ref: string;
  readonly input_manifest_hash: string;
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly workspace_manifest_hash: string;
  readonly sealed_input_projection_hash: string;
  readonly operation: EvolutionEvalOperation;
  readonly parameters: EvolutionEvalParametersV1;
  readonly part: string | null;
  readonly toolchain_profile_hash: string;
  readonly requested_timeout_ms: number;
  readonly operation_cap_ms: 7_200_000;
  readonly deadline_at: string;
  readonly run_class: "evolution_eval";
}

export interface CoreIssuedEvalBinding {
  readonly project_id: string;
  readonly dispatch_request_hash: string;
  readonly dispatch: EvolutionEvalDispatchRequestV1;
}

export type EvolutionEvalDiscardAuthorizationInput =
  | {
      readonly reason: "unavailable_at_deadline";
    }
  | {
      readonly reason: "absolute_expiry";
      readonly connectorManifestHash: string;
      readonly terminalAt: string;
    };

/**
 * Shared Core/Connector authorization for deleting evidence that never gained
 * a Connector ack/quarantine receipt. Keep this preimage byte-for-byte aligned
 * with the Connector implementation so it can authenticate Core's discard
 * request without trusting the opaque Core conclusion hash.
 */
export function evolutionEvalDiscardAuthorizationHash(
  binding: CoreIssuedEvalBinding,
  input: EvolutionEvalDiscardAuthorizationInput,
): string {
  const common = {
    schema: "evolution-eval-evidence-discard-authorization.v1" as const,
    project_id: binding.project_id,
    eval_job_id: binding.dispatch.eval_job_id,
    connector_job_id: binding.dispatch.connector_job_id,
    dispatch_request_hash: binding.dispatch_request_hash,
    reason: input.reason,
  };
  return evolutionEvalCanonicalHash(input.reason === "unavailable_at_deadline"
    ? { ...common, deadline_at: binding.dispatch.deadline_at }
    : {
        ...common,
        connector_manifest_hash: input.connectorManifestHash,
        terminal_at: input.terminalAt,
      });
}

interface EvalLedgerQueryBase {
  readonly schema: "evolution-eval-ledger-query.v1";
  readonly connector_job_id: string;
  readonly connector_idempotency_key: string;
  readonly dispatch_request_hash: string;
  readonly ledger_epoch: string;
}

export type EvalLedgerQuery =
  | (EvalLedgerQueryBase & {
      readonly state: "proven_never_accepted";
      readonly replay_permitted: boolean;
    })
  | (EvalLedgerQueryBase & {
      readonly state: "accepted";
      readonly execution_state: "queued" | "preparing" | "running";
      readonly accepted_at: string;
    })
  | (EvalLedgerQueryBase & {
      readonly state: "terminal";
      readonly terminal_state: "succeeded" | "failed" | "cancelled" | "timeout";
      readonly process_stopped: true;
      readonly terminal_at: string;
      readonly error_code: string | null;
    })
  | (EvalLedgerQueryBase & {
      readonly state: "transient_unavailable";
      readonly retryable: true;
      readonly error_code: string;
    })
  | (EvalLedgerQueryBase & {
      readonly state: "ambiguous";
      readonly effect_possible: true;
      readonly error_code: string;
    })
  | (EvalLedgerQueryBase & {
      readonly state: "ledger_corrupt";
      readonly replay_permitted: false;
      readonly error_code: string;
    });

export interface EvalPreflight {
  readonly eligible: boolean;
  readonly operation: EvolutionEvalOperation;
  readonly capability_version: string | null;
  readonly license_available: boolean;
  readonly unacked_spool_bytes: number;
  readonly hard_cap_bytes: 2_147_483_648;
  readonly error_code: string | null;
}

export interface SealedEvalInput {
  readonly manifest: EvolutionEvalWorkspaceManifestV1;
  readonly files: AsyncIterable<{
    readonly path: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly media_type: string;
    readonly content: AsyncIterable<Uint8Array>;
  }>;
}

export type EvalCancelReason = "tombstoned" | "deadline" | "shutdown";

export interface EvalEvidenceAckRequestV1 {
  readonly schema: "evolution-eval-evidence-ack-request.v1";
  readonly binding: CoreIssuedEvalBinding;
  readonly connector_manifest_hash: string;
  readonly core_manifest_hash: string;
  readonly core_ack_fact_hash: string;
}

export interface EvalEvidenceCorruptAckRequestV1 {
  readonly schema: "evolution-eval-evidence-corrupt-ack-request.v1";
  readonly binding: CoreIssuedEvalBinding;
  readonly error_fact_hash: string;
  readonly core_quarantine_fact_hash: string;
}

export type EvalEvidenceCleanupRequestV1 =
  | {
      readonly schema: "evolution-eval-evidence-cleanup-request.v1";
      readonly binding: CoreIssuedEvalBinding;
      readonly mode: "connector_authorized";
      readonly connector_authorization_fact_hash: string;
      readonly core_cleanup_fact_hash: string;
    }
  | {
      readonly schema: "evolution-eval-evidence-cleanup-request.v1";
      readonly binding: CoreIssuedEvalBinding;
      readonly mode: "core_discard";
      readonly reason: "unavailable_at_deadline";
      readonly core_conclusion_fact_hash: string;
      readonly core_cleanup_fact_hash: string;
      readonly discard_authorization_hash: string;
    }
  | {
      readonly schema: "evolution-eval-evidence-cleanup-request.v1";
      readonly binding: CoreIssuedEvalBinding;
      readonly mode: "core_discard";
      readonly reason: "absolute_expiry";
      readonly core_manifest_hash: string;
      readonly core_conclusion_fact_hash: string;
      readonly core_cleanup_fact_hash: string;
      readonly discard_authorization_hash: string;
    };

export interface EvalRetentionResult {
  readonly schema: "evolution-eval-retention-result.v1";
  readonly binding: CoreIssuedEvalBinding;
  readonly state: "absent" | "pending_ack" | "acknowledged" | "quarantined" | "discarded" | "cleaned" | "expired" | "transient_unavailable";
  readonly retryable: boolean;
  readonly authorization_kind: null | "ack" | "quarantine" | "expiry" | "discard" | "cleanup";
  readonly authorization_hash: string | null;
  readonly connector_fact_hash: string | null;
  readonly source_authorization_kind: null | "ack" | "quarantine" | "expiry" | "discard";
  readonly source_authorization_hash: string | null;
  readonly source_connector_fact_hash: string | null;
  readonly physical_deleted: boolean;
  readonly error_code: string | null;
}

export interface EvolutionEvalConnectorPort {
  preflight(binding: CoreIssuedEvalBinding): Promise<EvalPreflight>;
  query(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery>;
  /** Atomically creates or returns the durable same-ID reservation proof. */
  queryOrReserve(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery>;
  submit(binding: CoreIssuedEvalBinding, input: SealedEvalInput): Promise<EvalLedgerQuery>;
  cancel(binding: CoreIssuedEvalBinding, reason: EvalCancelReason): Promise<EvalLedgerQuery>;
  fetchEvidenceManifest(binding: CoreIssuedEvalBinding): Promise<EvalEvidenceConnectorManifestV1>;
  fetchEvidenceEntry(binding: CoreIssuedEvalBinding, name: string): Promise<AsyncIterable<Uint8Array>>;
  queryRetention(binding: CoreIssuedEvalBinding): Promise<EvalRetentionResult>;
  acknowledgeEvidence(request: EvalEvidenceAckRequestV1): Promise<EvalRetentionResult>;
  acknowledgeCorrupt(request: EvalEvidenceCorruptAckRequestV1): Promise<EvalRetentionResult>;
  cleanupEvidence(request: EvalEvidenceCleanupRequestV1): Promise<EvalRetentionResult>;
  querySpool(binding: CoreIssuedEvalBinding): Promise<{
    readonly schema: "evolution-eval-spool-result.v1";
    readonly binding: CoreIssuedEvalBinding;
    readonly unackedBytes: number;
    readonly hardCapBytes: 2_147_483_648;
  }>;
}
