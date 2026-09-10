import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES,
  evolutionEvalDispatcherDutyForEvent,
  isEvolutionEvalDefinitiveCancelBoundary,
  mayReplayEvolutionEvalDispatch,
  requireEvolutionEvalDispatcherLeaseMs,
} from "../src/domain/evolution-eval-dispatcher.ts";
import {
  claimNextEvolutionEvalDuty,
  evolutionEvalEvidenceCorruptionCode,
  hasCurrentEvolutionEvalDutyLease,
  renewEvolutionEvalDutyLease,
  validateEvolutionEvalLedgerObservation,
  validateEvolutionEvalEvidenceConnectorManifest,
  validateEvolutionEvalRetentionResult,
  validateEvolutionEvalSpool,
} from "../src/services/evolution-eval-dispatcher.ts";
import {
  canonicalEvolutionEvalEvidenceManifest,
  evolutionEvalCanonicalHash,
} from "../src/domain/evolution-eval.ts";
import type { TransactionClient } from "../src/db/repository.ts";
import {
  evolutionEvalDiscardAuthorizationHash,
  type CoreIssuedEvalBinding,
} from "../src/services/evolution-eval-connector-port.ts";

const migration = readFileSync(
  new URL("../src/db/migrations/0032_evolution_eval_dispatcher.sql", import.meta.url),
  "utf8",
);

const binding: CoreIssuedEvalBinding = {
  project_id: "project-1",
  dispatch_request_hash: "a".repeat(64),
  dispatch: {
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: "eej-1",
    connector_job_id: "connector-job-1",
    connector_idempotency_key: "b".repeat(64),
    eval_input_ref: "input-1",
    input_manifest_hash: "c".repeat(64),
    workspace_id: "workspace-1",
    workspace_revision: 1,
    workspace_manifest_hash: "d".repeat(64),
    sealed_input_projection_hash: "f".repeat(64),
    operation: "validate_sources",
    parameters: { operation: "validate_sources", source_paths: ["rtl/top.sv"], top: "top" },
    part: null,
    toolchain_profile_hash: "e".repeat(64),
    requested_timeout_ms: 60_000,
    operation_cap_ms: 7_200_000,
    deadline_at: "2026-08-26T02:00:00.000Z",
    run_class: "evolution_eval",
  },
};

function ledgerBase(state: string): Record<string, unknown> {
  return {
    schema: "evolution-eval-ledger-query.v1",
    state,
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: "epoch-1",
  };
}

describe("evolution-eval dispatcher trust plane", () => {
  test("routes only the exact frozen outbox allowlist", () => {
    expect(EVOLUTION_EVAL_DISPATCHER_EVENT_TYPES).toHaveLength(7);
    expect(evolutionEvalDispatcherDutyForEvent("evolution_eval.dispatch_requested"))
      .toBe("dispatch");
    expect(evolutionEvalDispatcherDutyForEvent("evolution_eval.evidence.cleanup_requested"))
      .toBe("cleanup_evidence");
    expect(evolutionEvalDispatcherDutyForEvent("evolution_eval.dispatch_requested.extra"))
      .toBeNull();
    expect(evolutionEvalDispatcherDutyForEvent("tool_run.dispatch_requested"))
      .toBeNull();
  });

  test("same-ID replay requires the positive durable ledger proof", () => {
    expect(mayReplayEvolutionEvalDispatch("proven_never_accepted", true)).toBe(true);
    expect(mayReplayEvolutionEvalDispatch("proven_never_accepted", false)).toBe(false);
    for (const state of [
      "accepted",
      "terminal",
      "transient_unavailable",
      "ambiguous",
      "ledger_corrupt",
    ] as const) {
      expect(mayReplayEvolutionEvalDispatch(state, true)).toBe(false);
    }
  });

  test("deadline cancel or the DB-authoritative deadline crossing is a definitive boundary", () => {
    expect(isEvolutionEvalDefinitiveCancelBoundary("deadline", true)).toBe(true);
    expect(isEvolutionEvalDefinitiveCancelBoundary("tombstoned", true)).toBe(false);
    expect(isEvolutionEvalDefinitiveCancelBoundary(null, true)).toBe(false);
    expect(isEvolutionEvalDefinitiveCancelBoundary("tombstoned", false)).toBe(true);
    expect(isEvolutionEvalDefinitiveCancelBoundary(null, false)).toBe(true);
  });

  test("validates every strict ledger state and rejects binding/shape drift", () => {
    const observations = [
      { ...ledgerBase("proven_never_accepted"), replay_permitted: true },
      { ...ledgerBase("accepted"), execution_state: "running", accepted_at: "2026-08-26T00:00:00.000Z" },
      {
        ...ledgerBase("terminal"),
        terminal_state: "succeeded",
        process_stopped: true,
        terminal_at: "2026-08-26T00:01:00.000Z",
        error_code: null,
      },
      { ...ledgerBase("transient_unavailable"), retryable: true, error_code: "LEDGER_BUSY" },
      { ...ledgerBase("ambiguous"), effect_possible: true, error_code: "QUERY_AMBIGUOUS" },
      { ...ledgerBase("ledger_corrupt"), replay_permitted: false, error_code: "LEDGER_CORRUPT" },
    ];
    for (const observation of observations) {
      expect(validateEvolutionEvalLedgerObservation(binding, observation).state)
        .toBe((observation as Record<string, unknown>).state);
    }
    expect(() => validateEvolutionEvalLedgerObservation(binding, {
      ...observations[0],
      connector_job_id: "other-job",
    })).toThrow("EVOLUTION_EVAL_CONNECTOR_BINDING_CONFLICT");
    expect(() => validateEvolutionEvalLedgerObservation(binding, {
      ...observations[0],
      unexpected: true,
    })).toThrow();
    expect(() => validateEvolutionEvalLedgerObservation(binding, {
      ...ledgerBase("ledger_corrupt"),
      replay_permitted: true,
      error_code: "LEDGER_CORRUPT",
    })).toThrow();
  });

  test("accepts only a full exact spool binding echo", () => {
    const valid = {
      schema: "evolution-eval-spool-result.v1",
      binding: structuredClone(binding),
      unackedBytes: 0,
      hardCapBytes: 2_147_483_648,
    } as const;
    expect(validateEvolutionEvalSpool(binding, valid)).toEqual(valid);
    for (const mutate of [
      (copy: CoreIssuedEvalBinding) => ({ ...copy, project_id: "other-project" }),
      (copy: CoreIssuedEvalBinding) => ({
        ...copy,
        dispatch: { ...copy.dispatch, connector_job_id: "other-job" },
      }),
      (copy: CoreIssuedEvalBinding) => ({
        ...copy,
        dispatch: { ...copy.dispatch, connector_idempotency_key: "f".repeat(64) },
      }),
      (copy: CoreIssuedEvalBinding) => ({
        ...copy,
        dispatch_request_hash: "f".repeat(64),
      }),
      (copy: CoreIssuedEvalBinding) => ({
        ...copy,
        dispatch: { ...copy.dispatch, input_manifest_hash: "f".repeat(64) },
      }),
      (copy: CoreIssuedEvalBinding) => ({
        ...copy,
        dispatch: { ...copy.dispatch, workspace_manifest_hash: "f".repeat(64) },
      }),
    ]) {
      expect(() => validateEvolutionEvalSpool(binding, {
        ...valid,
        binding: mutate(structuredClone(binding)),
      })).toThrow("EVOLUTION_EVAL_CONNECTOR_SPOOL_INVALID");
    }
    expect(() => validateEvolutionEvalSpool(binding, { ...valid, schema: "wrong" }))
      .toThrow("EVOLUTION_EVAL_CONNECTOR_SPOOL_INVALID");
    expect(() => validateEvolutionEvalSpool(binding, { ...valid, extra: true }))
      .toThrow("EVOLUTION_EVAL_CONNECTOR_SPOOL_INVALID");
  });

  test("keeps Connector and Core evidence hashes distinct while binding every identity", () => {
    const entries = [{
      name: "design.bit",
      sha256: "9".repeat(64),
      size_bytes: 7,
      media_type: "application/octet-stream",
      artifact_classification: "experimental/evolution_eval",
      usage_classification: "evolution_eval_only",
    }] as const;
    const connectorPreimage = {
      schema: "evolution-eval-connector-evidence-manifest.v1",
      eval_job_id: binding.dispatch.eval_job_id,
      connector_job_id: binding.dispatch.connector_job_id,
      dispatch_request_hash: binding.dispatch_request_hash,
      entries,
    } as const;
    const remote = {
      ...connectorPreimage,
      manifest_hash: evolutionEvalCanonicalHash(connectorPreimage),
    };
    const verified = validateEvolutionEvalEvidenceConnectorManifest(
      binding,
      "tool-run-1",
      remote,
    );
    expect(verified.connectorManifest.manifest_hash).toBe(remote.manifest_hash);
    expect(verified.coreManifestHash).toBe(
      canonicalEvolutionEvalEvidenceManifest({
        schema: "evolution-eval-evidence-manifest.v1",
        eval_job_id: binding.dispatch.eval_job_id,
        tool_run_id: "tool-run-1",
        entries,
      }).sha256,
    );
    expect(verified.coreManifestHash).not.toBe(remote.manifest_hash);
    for (const drift of [
      { ...remote, eval_job_id: "other-job" },
      { ...remote, connector_job_id: "other-connector-job" },
      { ...remote, dispatch_request_hash: "0".repeat(64) },
      { ...remote, manifest_hash: "0".repeat(64) },
      { ...remote, unexpected: true },
    ]) {
      expect(() => validateEvolutionEvalEvidenceConnectorManifest(
        binding,
        "tool-run-1",
        drift,
      )).toThrow();
    }
  });

  test("separates Core retention authorization from the Connector receipt", () => {
    const authorizationHash = "7".repeat(64);
    const connectorFactHash = "8".repeat(64);
    const result = {
      schema: "evolution-eval-retention-result.v1",
      binding: structuredClone(binding),
      state: "acknowledged",
      retryable: false,
      authorization_kind: "ack",
      authorization_hash: authorizationHash,
      connector_fact_hash: connectorFactHash,
      source_authorization_kind: null,
      source_authorization_hash: null,
      source_connector_fact_hash: null,
      physical_deleted: false,
      error_code: null,
    } as const;
    expect(validateEvolutionEvalRetentionResult(
      binding,
      authorizationHash,
      result,
    )).toEqual(result);
    expect(connectorFactHash).not.toBe(authorizationHash);
    expect(() => validateEvolutionEvalRetentionResult(binding, "6".repeat(64), result))
      .toThrow("EVOLUTION_EVAL_RETENTION_RESULT_INVALID");
    expect(() => validateEvolutionEvalRetentionResult(binding, authorizationHash, {
      ...result,
      binding: { ...binding, project_id: "other-project" },
    })).toThrow("EVOLUTION_EVAL_RETENTION_RESULT_INVALID");
    const absent = {
      ...result,
      state: "absent",
      authorization_kind: null,
      authorization_hash: null,
      connector_fact_hash: null,
    } as const;
    expect(validateEvolutionEvalRetentionResult(binding, undefined, absent)).toEqual(absent);
    expect(() => validateEvolutionEvalRetentionResult(binding, undefined, {
      ...absent,
      physical_deleted: true,
    })).toThrow("EVOLUTION_EVAL_RETENTION_RESULT_INVALID");
    expect(() => validateEvolutionEvalRetentionResult(binding, undefined, {
      ...result,
      state: "cleaned",
      authorization_kind: "cleanup",
      physical_deleted: true,
    })).toThrow("EVOLUTION_EVAL_RETENTION_RESULT_INVALID");
  });

  test("freezes the shared Core/Connector discard authorization vectors", () => {
    const boundBinding = {
      ...binding,
      dispatch_request_hash: evolutionEvalCanonicalHash(binding.dispatch),
    };
    expect(evolutionEvalDiscardAuthorizationHash(boundBinding, {
      reason: "unavailable_at_deadline",
    })).toBe("abad2ebc1c87a69bc682a7f0e22de64303a75ba540bc4b2398819e811d4c4e5d");
    expect(evolutionEvalDiscardAuthorizationHash(boundBinding, {
      reason: "absolute_expiry",
      connectorManifestHash: "9".repeat(64),
      terminalAt: "2026-08-19T01:00:00.000Z",
    })).toBe("06ea86b2ba6f398cceb30c0f2c93885c47818eca08079b14e229145a94e1b813");
    expect(evolutionEvalDiscardAuthorizationHash(
      { ...boundBinding, project_id: "other-project" },
      { reason: "unavailable_at_deadline" },
    )).not.toBe("abad2ebc1c87a69bc682a7f0e22de64303a75ba540bc4b2398819e811d4c4e5d");
  });

  test("classifies only deterministic remote evidence failures as immutable corruption", () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(evolutionEvalEvidenceCorruptionCode(coded("EVIDENCE_CORRUPT")))
      .toBe("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    expect(evolutionEvalEvidenceCorruptionCode(coded("COMPATIBILITY_REJECTED")))
      .toBe("EVOLUTION_EVAL_EVIDENCE_CORRUPT");
    expect(evolutionEvalEvidenceCorruptionCode(coded("EVIDENCE_LIMIT_EXCEEDED")))
      .toBe("EVOLUTION_EVAL_EVIDENCE_LIMIT_EXCEEDED");
    expect(evolutionEvalEvidenceCorruptionCode(coded("REMOTE_UNAVAILABLE"))).toBeNull();
    expect(evolutionEvalEvidenceCorruptionCode(coded("TIMEOUT"))).toBeNull();
    expect(evolutionEvalEvidenceCorruptionCode(new DOMException("aborted", "AbortError")))
      .toBeNull();
  });

  test("bounds leases and freezes reclaim identity in the migration", () => {
    expect(requireEvolutionEvalDispatcherLeaseMs(30_000)).toBe(30_000);
    expect(() => requireEvolutionEvalDispatcherLeaseMs(999)).toThrow();
    expect(() => requireEvolutionEvalDispatcherLeaseMs(300_001)).toThrow();
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS evolution_eval_dispatcher_lease");
    expect(migration).toContain("UNIQUE (event_id,lease_nonce_hash)");
    expect(migration).not.toMatch(/lease_nonce\s+uuid/);
    expect(migration).toContain("UNIQUE (outbox_event_id,lease_nonce_hash,observation_hash)");
    expect(migration).toContain("connector observations are append-only");
    expect(migration).toContain(
      "synthia_validate_evolution_eval_retention_receipt_terminal",
    );
    expect(migration).toContain("receipt.connector_state='cleaned'");
    expect(migration).toContain("0032_evolution_eval_dispatcher");
  });

  test("claim commits before returning and uses SKIP LOCKED reclaim fencing", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client: TransactionClient = {
      async query(text, values) {
        calls.push({ text, values });
        if (text.startsWith("WITH candidate")) {
          return { rows: [{
            event_id: "123e4567-e89b-42d3-a456-426614174000",
            event_type: "evolution_eval.dispatch_requested",
            aggregate_id: "eej_1",
            holder_id: "dispatcher-a",
            lease_nonce: "123e4567-e89b-42d3-a456-426614174001",
            lease_expires_at: new Date("2026-08-26T00:00:30.000Z"),
            attempt_count: 2,
          }] };
        }
        return { rows: [] };
      },
    };
    const lease = await claimNextEvolutionEvalDuty(client, {
      holderId: "dispatcher-a",
      leaseNonce: "123e4567-e89b-42d3-a456-426614174001",
    });
    expect(calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE OF o SKIP LOCKED"),
      "COMMIT",
    ]);
    expect(calls[1]?.text).toContain("lease_expires_at<=clock_timestamp()");
    expect(lease).toMatchObject({ duty: "dispatch", attemptCount: 2 });
  });

  test("renew and current-lease checks require the exact holder and nonce", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client: TransactionClient = {
      async query(text, values) {
        calls.push({ text, values });
        return text.startsWith("UPDATE")
          ? { rows: [{ lease_expires_at: "2026-08-26T00:01:00.000Z" }] }
          : { rows: [{ "?column?": 1 }] };
      },
    };
    const identity = {
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      holderId: "dispatcher-a",
      leaseNonce: "123e4567-e89b-42d3-a456-426614174001",
    };
    expect(await renewEvolutionEvalDutyLease(client, identity)).toBe("2026-08-26T00:01:00.000Z");
    expect(await hasCurrentEvolutionEvalDutyLease(client, identity)).toBe(true);
    for (const call of calls) {
      expect(call.values?.slice(0, 2)).toEqual([identity.eventId, identity.holderId]);
      expect(call.values?.[2]).toMatch(/^[0-9a-f]{64}$/);
      expect(call.values?.[2]).not.toBe(identity.leaseNonce);
    }
  });
});
