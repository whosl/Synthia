import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "../core/src/hashing.ts";
import {
  canonicalEvolutionEvalHash,
  computeEvolutionEvalDispatchRequestHash,
  EVOLUTION_EVAL_EVIDENCE_LIMITS,
  evolutionEvalDiscardAuthorizationHash,
  type CoreIssuedEvalBinding,
  type EvolutionEvalDispatchRequestV1,
} from "./evolution-eval.ts";
import { FileEvolutionEvalLedger, type EvolutionEvalLedger } from "./evolution-eval-ledger.ts";
import {
  REMOTE_SCHEMA_VERSION,
  RemoteConnectorClient,
  type ConnectorEndpoint,
  type RemoteEnvelope,
  type RemoteResponse,
  type RemoteTransport,
} from "./remote.ts";
import { WorkerRuntime, type EvolutionEvalExecution } from "./worker.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function dispatch(overrides: Partial<EvolutionEvalDispatchRequestV1> = {}): EvolutionEvalDispatchRequestV1 {
  return {
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: "eej-e3-1",
    connector_job_id: "connector-e3-1",
    connector_idempotency_key: "1".repeat(64),
    eval_input_ref: "eei-e3-1",
    input_manifest_hash: "2".repeat(64),
    workspace_id: "eew-e3-1",
    workspace_revision: 1,
    workspace_manifest_hash: "3".repeat(64),
    sealed_input_projection_hash: "4".repeat(64),
    operation: "simulate",
    parameters: { operation: "simulate", source_paths: ["top.sv"], top: "top", testbench: "tb" },
    part: "xc7a35tcsg324-1",
    toolchain_profile_hash: "5".repeat(64),
    requested_timeout_ms: 60_000,
    operation_cap_ms: 7_200_000,
    deadline_at: "2026-08-26T10:00:00.000Z",
    run_class: "evolution_eval",
    ...overrides,
  };
}

function binding(request = dispatch()): CoreIssuedEvalBinding {
  return { project_id: "p1", dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(request), dispatch: request };
}

function coreAckHash(expected: CoreIssuedEvalBinding, coreManifestHash: string): string {
  return canonicalEvolutionEvalHash({
    schema: "evolution-eval-evidence-ack-intent.v1",
    eval_job_id: expected.dispatch.eval_job_id,
    manifest_hash: coreManifestHash,
  });
}

function coreQuarantineHash(expected: CoreIssuedEvalBinding, errorFactHash: string): string {
  return canonicalEvolutionEvalHash({
    schema: "evolution-eval-evidence-quarantine-intent.v1",
    eval_job_id: expected.dispatch.eval_job_id,
    error_fact_hash: errorFactHash,
  });
}

function coreCleanupHash(expected: CoreIssuedEvalBinding, causeFactHash: string): string {
  return canonicalEvolutionEvalHash({
    schema: "evolution-eval-evidence-cleanup.v1",
    eval_job_id: expected.dispatch.eval_job_id,
    cause_fact_hash: causeFactHash,
  });
}

async function ledgerFixture(now: { value: Date }, expected = binding()) {
  const root = await mkdtemp(join(tmpdir(), "synthia-e3-retention-"));
  roots.push(root);
  const ledger = await FileEvolutionEvalLedger.initialize({ root, ledgerEpoch: "e3-epoch", now: () => now.value });
  expect((await ledger.queryOrReserve(expected)).state).toBe("proven_never_accepted");
  const accepted = await ledger.markAccepted(expected, { executionState: "running" });
  const token = accepted.effect_owner_token!;
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(await ledger.markProcessStarted(expected, { pid: 777, processGroupId: 777, startToken: "e3-process" }, token)).toBe(true);
  return { root, ledger, token, binding: expected };
}

describe("evolution-eval E3 durable retention chain", () => {
  test("freezes the shared Core/Connector discard authorization vectors", () => {
    const request: EvolutionEvalDispatchRequestV1 = {
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
    };
    const expected: CoreIssuedEvalBinding = {
      project_id: "project-1",
      dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(request),
      dispatch: request,
    };
    expect(evolutionEvalDiscardAuthorizationHash(expected, { reason: "unavailable_at_deadline" }))
      .toBe("abad2ebc1c87a69bc682a7f0e22de64303a75ba540bc4b2398819e811d4c4e5d");
    expect(evolutionEvalDiscardAuthorizationHash(expected, {
      reason: "absolute_expiry",
      connectorManifestHash: "9".repeat(64),
      terminalAt: "2026-08-19T01:00:00.000Z",
    })).toBe("06ea86b2ba6f398cceb30c0f2c93885c47818eca08079b14e229145a94e1b813");
  });

  test("ack keeps bytes logically readable until distinct cleanup and response-lost replay recovers the ack receipt", async () => {
    const now = { value: new Date("2026-08-26T08:00:00.000Z") };
    const fixture = await ledgerFixture(now);
    const connectorManifestHash = "a".repeat(64);
    expect(await fixture.ledger.markOutput(fixture.binding, {
      spoolManifestHash: connectorManifestHash,
      entryCount: 1,
      totalBytes: 12,
    }, fixture.token)).toBe(true);
    expect(await fixture.ledger.markProcessExitConfirmed(
      fixture.binding,
      { pid: 777, processGroupId: 777, startToken: "e3-process" },
      fixture.token,
    )).toBe(true);
    expect((await fixture.ledger.markTerminal(
      fixture.binding,
      { terminalState: "succeeded" },
      fixture.token,
    )).state).toBe("terminal");
    const coreManifestHash = "b".repeat(64);
    const ack = {
      connectorManifestHash,
      coreManifestHash,
      coreAckFactHash: coreAckHash(fixture.binding, coreManifestHash),
    };
    const acknowledged = await fixture.ledger.markEvidenceAcknowledged(fixture.binding, ack);
    expect(acknowledged).toMatchObject({
      state: "acknowledged",
      manifestHash: connectorManifestHash,
      coreManifestHash: ack.coreManifestHash,
      authorizationHash: ack.coreAckFactHash,
    });
    const ackFactHash = acknowledged.state === "acknowledged" ? acknowledged.factHash : "";
    expect((await fixture.ledger.getRetentionObservation(fixture.binding)).state).toBe("acknowledged");

    const acknowledgedFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-acknowledged.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      manifest_hash: coreManifestHash,
      connector_fact_hash: ackFactHash,
    });
    const cleaned = await fixture.ledger.markEvidenceCleaned(
      fixture.binding,
      ackFactHash,
      coreCleanupHash(fixture.binding, acknowledgedFactHash),
    );
    expect(cleaned).toMatchObject({ state: "cleaned", sourceKind: "ack", sourceAuthorizationHash: ack.coreAckFactHash });
    const replay = await fixture.ledger.markEvidenceAcknowledged(fixture.binding, ack);
    expect(replay).toMatchObject({ state: "cleaned", sourceKind: "ack", authorizationFactHash: ackFactHash });
    expect((await fixture.ledger.markEvidenceAcknowledged(fixture.binding, {
      ...ack,
      coreAckFactHash: "e".repeat(64),
    })).state).toBe("corrupt");
    expect((await fixture.ledger.markEvidenceCleaned(fixture.binding, ackFactHash, "e".repeat(64))).state).toBe("corrupt");
  });

  test("deadline discard is an irreversible pre-terminal fence and restart preserves cleanup authorization", async () => {
    const now = { value: new Date("2026-08-26T10:00:00.000Z") };
    const fixture = await ledgerFixture(now);
    const coreConclusionFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-deadline.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      deadline_at: fixture.binding.dispatch.deadline_at,
      error_code: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE",
    });
    const coreCleanupFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-cleanup.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      cause_fact_hash: coreConclusionFactHash,
    });
    const discardAuthorizationHash = evolutionEvalDiscardAuthorizationHash(fixture.binding, {
      reason: "unavailable_at_deadline",
    });
    const arbitraryConclusion = "6".repeat(64);
    expect((await fixture.ledger.markEvidenceDiscarded(fixture.binding, {
      reason: "unavailable_at_deadline",
      coreConclusionFactHash: arbitraryConclusion,
      coreCleanupFactHash: coreCleanupHash(fixture.binding, arbitraryConclusion),
      discardAuthorizationHash,
    })).state).toBe("corrupt");
    const discarded = await fixture.ledger.markEvidenceDiscarded(fixture.binding, {
      reason: "unavailable_at_deadline",
      coreConclusionFactHash,
      coreCleanupFactHash,
      discardAuthorizationHash,
    });
    expect(discarded).toMatchObject({ state: "discarded", authorizationHash: discardAuthorizationHash });
    expect(await fixture.ledger.markOutput(fixture.binding, {
      spoolManifestHash: "7".repeat(64), entryCount: 1, totalBytes: 1,
    }, fixture.token)).toBe(false);
    expect(await fixture.ledger.markProcessExitConfirmed(
      fixture.binding,
      { pid: 777, processGroupId: 777, startToken: "e3-process" },
      fixture.token,
    )).toBe(true);
    expect((await fixture.ledger.markTerminal(
      fixture.binding,
      { terminalState: "failed", errorCode: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE" },
      fixture.token,
    )).state).toBe("terminal");
    const discardFactHash = discarded.state === "discarded" ? discarded.factHash : "";
    expect((await fixture.ledger.markEvidenceCleaned(
      fixture.binding,
      discardFactHash,
      coreCleanupFactHash,
    )).state).toBe("cleaned");
    const reopened = await FileEvolutionEvalLedger.reopen({
      root: fixture.root,
      ledgerEpoch: "e3-epoch",
      now: () => now.value,
    });
    expect(await reopened.getRetentionObservation(fixture.binding)).toMatchObject({
      state: "cleaned",
      authorizationHash: coreCleanupFactHash,
      sourceAuthorizationHash: discardAuthorizationHash,
    });
  });

  test("7d expiry is clock-bound and an earlier valid ack wins", async () => {
    const now = { value: new Date("2026-08-26T08:00:00.000Z") };
    const fixture = await ledgerFixture(now);
    expect(await fixture.ledger.markOutput(fixture.binding, {
      spoolManifestHash: "a".repeat(64), entryCount: 1, totalBytes: 1,
    }, fixture.token)).toBe(true);
    expect(await fixture.ledger.markProcessExitConfirmed(
      fixture.binding,
      { pid: 777, processGroupId: 777, startToken: "e3-process" },
      fixture.token,
    )).toBe(true);
    expect((await fixture.ledger.markTerminal(fixture.binding, { terminalState: "succeeded" }, fixture.token)).state)
      .toBe("terminal");
    now.value = new Date("2026-09-02T07:59:59.999Z");
    expect((await fixture.ledger.markEvidenceExpired(fixture.binding)).state).toBe("pending_ack");
    now.value = new Date("2026-09-02T08:00:00.000Z");
    expect((await fixture.ledger.markEvidenceExpired(fixture.binding)).state).toBe("expired");
    const terminalAt = "2026-08-26T08:00:00.000Z";
    const coreManifestHash = "9".repeat(64);
    const exactConclusion = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-expired.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      manifest_hash: coreManifestHash,
      terminal_at: terminalAt,
    });
    const discardAuthorizationHash = evolutionEvalDiscardAuthorizationHash(fixture.binding, {
      reason: "absolute_expiry",
      connectorManifestHash: "a".repeat(64),
      terminalAt,
    });
    expect((await fixture.ledger.markEvidenceDiscarded(fixture.binding, {
      reason: "absolute_expiry",
      coreManifestHash,
      coreConclusionFactHash: "8".repeat(64),
      coreCleanupFactHash: coreCleanupHash(fixture.binding, "8".repeat(64)),
      discardAuthorizationHash,
    })).state).toBe("corrupt");
    expect((await fixture.ledger.markEvidenceDiscarded(fixture.binding, {
      reason: "absolute_expiry",
      coreManifestHash,
      coreConclusionFactHash: exactConclusion,
      coreCleanupFactHash: coreCleanupHash(fixture.binding, exactConclusion),
      discardAuthorizationHash,
    })).state).toBe("discarded");

    const second = binding(dispatch({ eval_job_id: "eej-e3-2", connector_job_id: "connector-e3-2" }));
    now.value = new Date("2026-08-26T08:00:00.000Z");
    const acked = await ledgerFixture(now, second);
    expect(await acked.ledger.markOutput(second, {
      spoolManifestHash: "b".repeat(64), entryCount: 1, totalBytes: 1,
    }, acked.token)).toBe(true);
    expect(await acked.ledger.markProcessExitConfirmed(
      second,
      { pid: 777, processGroupId: 777, startToken: "e3-process" },
      acked.token,
    )).toBe(true);
    expect((await acked.ledger.markTerminal(second, { terminalState: "succeeded" }, acked.token)).state)
      .toBe("terminal");
    const secondCoreManifestHash = "c".repeat(64);
    expect((await acked.ledger.markEvidenceAcknowledged(second, {
      connectorManifestHash: "b".repeat(64),
      coreManifestHash: secondCoreManifestHash,
      coreAckFactHash: coreAckHash(second, secondCoreManifestHash),
    })).state).toBe("acknowledged");
    now.value = new Date("2026-09-02T08:00:00.000Z");
    expect((await acked.ledger.markEvidenceExpired(second)).state).toBe("acknowledged");
  });

  test("quarantine delete-by is exactly 24h and survives restart", async () => {
    const now = { value: new Date("2026-08-26T08:00:00.000Z") };
    const fixture = await ledgerFixture(now);
    expect(await fixture.ledger.markOutput(fixture.binding, {
      spoolManifestHash: "a".repeat(64), entryCount: 1, totalBytes: 1,
    }, fixture.token)).toBe(true);
    expect(await fixture.ledger.markProcessExitConfirmed(
      fixture.binding,
      { pid: 777, processGroupId: 777, startToken: "e3-process" },
      fixture.token,
    )).toBe(true);
    expect((await fixture.ledger.markTerminal(fixture.binding, { terminalState: "succeeded" }, fixture.token)).state)
      .toBe("terminal");
    const errorFactHash = "e".repeat(64);
    expect((await fixture.ledger.markEvidenceQuarantined(fixture.binding, {
      errorFactHash, coreQuarantineFactHash: "f".repeat(64),
    })).state).toBe("corrupt");
    expect((await fixture.ledger.getRetentionObservation(fixture.binding)).state).toBe("pending_ack");
    const quarantined = await fixture.ledger.markEvidenceQuarantined(fixture.binding, {
      errorFactHash, coreQuarantineFactHash: coreQuarantineHash(fixture.binding, errorFactHash),
    });
    expect(quarantined).toMatchObject({
      state: "quarantined",
      quarantinedAt: "2026-08-26T08:00:00.000Z",
      deleteBy: "2026-08-27T08:00:00.000Z",
    });
    const reopened = await FileEvolutionEvalLedger.reopen({
      root: fixture.root, ledgerEpoch: "e3-epoch", now: () => now.value,
    });
    expect(await reopened.getRetentionObservation(fixture.binding)).toMatchObject({
      state: "quarantined", deleteBy: "2026-08-27T08:00:00.000Z",
    });
  });

  test("preterminal Core retention intents are rejected before any byte mutation", async () => {
    const now = { value: new Date("2026-08-26T08:00:00.000Z") };
    const fixture = await ledgerFixture(now);
    const connectorManifestHash = "a".repeat(64);
    expect(await fixture.ledger.markOutput(fixture.binding, {
      spoolManifestHash: connectorManifestHash, entryCount: 1, totalBytes: 1,
    }, fixture.token)).toBe(true);
    const spool = join(fixture.root, "spool");
    const output = join(spool, "jobs", sha256(fixture.binding.dispatch.connector_job_id), "output");
    await mkdir(output, { recursive: true });
    const evidencePath = join(output, "entry.log");
    await writeFile(evidencePath, "x");
    const runtime = new WorkerRuntime({
      endpoint,
      workspaceRoot: join(fixture.root, "ordinary"),
      evolutionEval: {
        ledger: fixture.ledger,
        spoolRoot: spool,
        execution: { async execute() { return { terminalState: "failed" }; } },
        toolchainProfileHash: fixture.binding.dispatch.toolchain_profile_hash,
        now: () => now.value,
      },
    });
    const worker = (runtime as unknown as { evolutionEval: {
      acknowledgeEvidence(binding: CoreIssuedEvalBinding, hashes: { connectorManifestHash: string; coreManifestHash: string; coreAckFactHash: string }): Promise<unknown>;
      quarantineEvidence(binding: CoreIssuedEvalBinding, hashes: { errorFactHash: string; coreQuarantineFactHash: string }): Promise<unknown>;
      cleanupEvidence(binding: CoreIssuedEvalBinding, authorizationFactHash: string, coreCleanupFactHash: string): Promise<unknown>;
      queryRetention(binding: CoreIssuedEvalBinding): Promise<{ state: string }>;
    } }).evolutionEval;
    const coreManifestHash = "b".repeat(64);
    await expect(worker.acknowledgeEvidence(fixture.binding, {
      connectorManifestHash,
      coreManifestHash,
      coreAckFactHash: coreAckHash(fixture.binding, coreManifestHash),
    })).rejects.toMatchObject({ code: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" });
    const errorFactHash = "c".repeat(64);
    await expect(worker.quarantineEvidence(fixture.binding, {
      errorFactHash,
      coreQuarantineFactHash: coreQuarantineHash(fixture.binding, errorFactHash),
    })).rejects.toMatchObject({ code: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" });
    await expect(worker.cleanupEvidence(
      fixture.binding,
      "d".repeat(64),
      coreCleanupHash(fixture.binding, "d".repeat(64)),
    )).rejects.toMatchObject({ code: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" });
    expect((await stat(evidencePath)).isFile()).toBe(true);
    expect((await worker.queryRetention(fixture.binding)).state).toBe("pending_ack");
  });

  test("public query-first exposes absent and deadline discard fences all late output", async () => {
    const now = { value: new Date("2026-08-26T08:00:00.000Z") };
    const fixture = await ledgerFixture(now);
    const runtime = new WorkerRuntime({
      endpoint,
      workspaceRoot: join(fixture.root, "ordinary"),
      evolutionEval: {
        ledger: fixture.ledger,
        spoolRoot: join(fixture.root, "spool"),
        execution: { async execute() { return { terminalState: "failed" }; } },
        toolchainProfileHash: fixture.binding.dispatch.toolchain_profile_hash,
        now: () => now.value,
      },
    });
    const worker = (runtime as unknown as { evolutionEval: {
      queryRetention(binding: CoreIssuedEvalBinding): Promise<{ state: string; physical_deleted: boolean }>;
      discardEvidence(binding: CoreIssuedEvalBinding, input: { reason: "unavailable_at_deadline"; coreConclusionFactHash: string; coreCleanupFactHash: string; discardAuthorizationHash: string }): Promise<{ state: string }>;
    } }).evolutionEval;
    expect(await worker.queryRetention(fixture.binding)).toMatchObject({ state: "absent", physical_deleted: false });
    now.value = new Date(fixture.binding.dispatch.deadline_at);
    const conclusion = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-deadline.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      deadline_at: fixture.binding.dispatch.deadline_at,
      error_code: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE",
    });
    expect(await worker.discardEvidence(fixture.binding, {
      reason: "unavailable_at_deadline",
      coreConclusionFactHash: conclusion,
      coreCleanupFactHash: coreCleanupHash(fixture.binding, conclusion),
      discardAuthorizationHash: evolutionEvalDiscardAuthorizationHash(fixture.binding, {
        reason: "unavailable_at_deadline",
      }),
    })).toMatchObject({ state: "discarded" });
    expect(await fixture.ledger.markOutput(fixture.binding, {
      spoolManifestHash: "a".repeat(64), entryCount: 1, totalBytes: 1,
    }, fixture.token)).toBe(false);
  });

  test("Worker scan physically deletes quarantine at 24h and pending output at terminal+7d", async () => {
    const run = async (mode: "quarantine" | "expiry") => {
      const now = { value: new Date("2026-08-26T08:00:00.000Z") };
      const expected = binding(dispatch({
        eval_job_id: `eej-e3-${mode}`,
        connector_job_id: `connector-e3-${mode}`,
      }));
      const fixture = await ledgerFixture(now, expected);
      expect(await fixture.ledger.markOutput(expected, {
        spoolManifestHash: "a".repeat(64), entryCount: 1, totalBytes: 1,
      }, fixture.token)).toBe(true);
      expect(await fixture.ledger.markProcessExitConfirmed(
        expected,
        { pid: 777, processGroupId: 777, startToken: "e3-process" },
        fixture.token,
      )).toBe(true);
      expect((await fixture.ledger.markTerminal(expected, { terminalState: "succeeded" }, fixture.token)).state)
        .toBe("terminal");
      const spool = join(fixture.root, "spool");
      const output = join(spool, "jobs", sha256(expected.dispatch.connector_job_id), "output");
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "entry.log"), "x");
      const runtime = new WorkerRuntime({
        endpoint,
        workspaceRoot: join(fixture.root, "ordinary"),
        evolutionEval: {
          ledger: fixture.ledger,
          spoolRoot: spool,
          execution: { async execute() { return { terminalState: "failed" }; } },
          toolchainProfileHash: expected.dispatch.toolchain_profile_hash,
          now: () => now.value,
        },
      });
      const worker = (runtime as unknown as { evolutionEval: {
        quarantineEvidence(binding: CoreIssuedEvalBinding, hashes: { errorFactHash: string; coreQuarantineFactHash: string }): Promise<unknown>;
        reconcileRetentionForBinding(binding: CoreIssuedEvalBinding): Promise<void>;
      } }).evolutionEval;
      if (mode === "quarantine") {
        const errorFactHash = "b".repeat(64);
        await worker.quarantineEvidence(expected, {
          errorFactHash, coreQuarantineFactHash: coreQuarantineHash(expected, errorFactHash),
        });
        const quarantined = join(dirname(output), "quarantine-output", "entry.log");
        expect((await stat(quarantined)).isFile()).toBe(true);
        now.value = new Date("2026-08-27T07:59:59.999Z");
        await worker.reconcileRetentionForBinding(expected);
        expect((await stat(quarantined)).isFile()).toBe(true);
        now.value = new Date("2026-08-27T08:00:00.000Z");
        await worker.reconcileRetentionForBinding(expected);
        await expect(stat(quarantined)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        now.value = new Date("2026-09-02T07:59:59.999Z");
        await worker.reconcileRetentionForBinding(expected);
        expect((await stat(join(output, "entry.log"))).isFile()).toBe(true);
        now.value = new Date("2026-09-02T08:00:00.000Z");
        await worker.reconcileRetentionForBinding(expected);
        await expect(stat(join(output, "entry.log"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await fixture.ledger.getRetentionObservation(expected)).state)
        .toBe(mode === "quarantine" ? "quarantined" : "expired");
    };
    await run("quarantine");
    await run("expiry");
  });

  test("overdue restart purges bytes but preserves exact late Core cleanup for ack, quarantine, and expiry", async () => {
    for (const mode of ["ack", "quarantine", "expiry"] as const) {
      const terminalAt = "2026-08-26T08:00:00.000Z";
      const now = { value: new Date(terminalAt) };
      const expected = binding(dispatch({
        eval_job_id: `eej-e3-restart-${mode}`,
        connector_job_id: `connector-e3-restart-${mode}`,
      }));
      const fixture = await ledgerFixture(now, expected);
      const connectorManifestHash = "a".repeat(64);
      expect(await fixture.ledger.markOutput(expected, {
        spoolManifestHash: connectorManifestHash, entryCount: 1, totalBytes: 1,
      }, fixture.token)).toBe(true);
      expect(await fixture.ledger.markProcessExitConfirmed(
        expected,
        { pid: 777, processGroupId: 777, startToken: "e3-process" },
        fixture.token,
      )).toBe(true);
      expect((await fixture.ledger.markTerminal(expected, { terminalState: "succeeded" }, fixture.token)).state)
        .toBe("terminal");
      const spool = join(fixture.root, "restart-spool");
      const output = join(spool, "jobs", sha256(expected.dispatch.connector_job_id), "output");
      await mkdir(output, { recursive: true });
      const evidencePath = join(output, "entry.log");
      await writeFile(evidencePath, "x");
      const admissions = join(spool, "admissions");
      await mkdir(admissions, { recursive: true });
      await writeFile(join(admissions, "slot-0.json"), JSON.stringify({
        schema: "evolution-eval-spool-admission.v2",
        connector_job_id: expected.dispatch.connector_job_id,
        dispatch_request_hash: expected.dispatch_request_hash,
        sealed_input_projection_hash: expected.dispatch.sealed_input_projection_hash,
        reserved_bytes: 256 * 1024 * 1024,
        owner_process: { pid: process.pid, start_token: "1".repeat(64) },
        binding: expected,
      }));
      let errorFactHash: string | null = null;
      let coreManifestHash: string | null = null;
      if (mode === "ack") {
        coreManifestHash = "b".repeat(64);
        expect((await fixture.ledger.markEvidenceAcknowledged(expected, {
          connectorManifestHash,
          coreManifestHash,
          coreAckFactHash: coreAckHash(expected, coreManifestHash),
        })).state).toBe("acknowledged");
      } else if (mode === "quarantine") {
        errorFactHash = "c".repeat(64);
        expect((await fixture.ledger.markEvidenceQuarantined(expected, {
          errorFactHash,
          coreQuarantineFactHash: coreQuarantineHash(expected, errorFactHash),
        })).state).toBe("quarantined");
        await rename(output, join(dirname(output), "quarantine-output"));
      }
      now.value = new Date(mode === "quarantine"
        ? "2026-08-27T08:00:00.000Z"
        : "2026-09-02T08:00:00.000Z");
      const runtime = new WorkerRuntime({
        endpoint,
        workspaceRoot: join(fixture.root, "ordinary"),
        evolutionEval: {
          ledger: fixture.ledger,
          spoolRoot: spool,
          execution: { async execute() { return { terminalState: "failed" }; } },
          toolchainProfileHash: expected.dispatch.toolchain_profile_hash,
          now: () => now.value,
        },
      });
      const worker = (runtime as unknown as { evolutionEval: {
        queryRetention(binding: CoreIssuedEvalBinding): Promise<{ state: string; physical_deleted: boolean; connector_fact_hash: string | null; source_authorization_kind: string | null }>;
        cleanupEvidence(binding: CoreIssuedEvalBinding, authorizationFactHash: string, coreCleanupFactHash: string): Promise<unknown>;
        discardEvidence(binding: CoreIssuedEvalBinding, input: { reason: "absolute_expiry"; coreManifestHash: string; coreConclusionFactHash: string; coreCleanupFactHash: string; discardAuthorizationHash: string }): Promise<unknown>;
      } }).evolutionEval;
      const overdue = await worker.queryRetention(expected);
      expect(overdue).toMatchObject({
        state: mode === "expiry" ? "expired" : mode === "ack" ? "acknowledged" : "quarantined",
        physical_deleted: true,
      });
      await expect(stat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      if (mode === "ack") {
        const acknowledgedFactHash = canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-acknowledged.v1",
          eval_job_id: expected.dispatch.eval_job_id,
          manifest_hash: coreManifestHash!,
          connector_fact_hash: overdue.connector_fact_hash!,
        });
        await worker.cleanupEvidence(
          expected,
          overdue.connector_fact_hash!,
          coreCleanupHash(expected, acknowledgedFactHash),
        );
      } else if (mode === "quarantine") {
        await worker.cleanupEvidence(
          expected,
          overdue.connector_fact_hash!,
          coreCleanupHash(expected, errorFactHash!),
        );
      } else {
        coreManifestHash = "d".repeat(64);
        const conclusion = canonicalEvolutionEvalHash({
          schema: "evolution-eval-evidence-expired.v1",
          eval_job_id: expected.dispatch.eval_job_id,
          manifest_hash: coreManifestHash,
          terminal_at: terminalAt,
        });
        await worker.discardEvidence(expected, {
          reason: "absolute_expiry",
          coreManifestHash,
          coreConclusionFactHash: conclusion,
          coreCleanupFactHash: coreCleanupHash(expected, conclusion),
          discardAuthorizationHash: evolutionEvalDiscardAuthorizationHash(expected, {
            reason: "absolute_expiry",
            connectorManifestHash,
            terminalAt,
          }),
        });
      }
      expect(await worker.queryRetention(expected)).toMatchObject({
        state: "cleaned",
        physical_deleted: true,
        source_authorization_kind: mode === "expiry" ? "discard" : mode,
      });
    }
  });
});

function sealedExecutionFixture() {
  const content = new TextEncoder().encode("module top; endmodule\n");
  const manifest = {
    schema: "evolution-eval-workspace-manifest.v1" as const,
    workspace_id: "eew-e3-live",
    revision: 1,
    files: [{
      path: "top.sv",
      sha256: sha256(content),
      size_bytes: content.byteLength,
      media_type: "text/x-systemverilog",
      layer: "source" as const,
      read_only: true,
    }],
  };
  const projection = canonicalEvolutionEvalHash({
    schema: "evolution-eval-sealed-input-projection.v1",
    manifest,
    files: manifest.files.map(({ path, sha256, size_bytes, media_type }) => ({ path, sha256, size_bytes, media_type })),
  });
  const request = dispatch({
    eval_job_id: "eej-e3-live",
    connector_job_id: "connector-e3-live",
    workspace_id: manifest.workspace_id,
    workspace_manifest_hash: canonicalEvolutionEvalHash(manifest),
    sealed_input_projection_hash: projection,
    deadline_at: "2026-08-27T10:00:00.000Z",
    parameters: { operation: "simulate", source_paths: ["top.sv"], top: "top", testbench: "tb" },
  });
  return {
    binding: binding(request),
    input: {
      schema: "evolution-eval-sealed-input.v1" as const,
      manifest,
      files: manifest.files.map(({ path, sha256, size_bytes, media_type }) => ({
        path, sha256, size_bytes, media_type, content_base64: Buffer.from(content).toString("base64"),
      })),
    },
  };
}

describe("evolution-eval Worker durable output lifecycle", () => {
  test("persists real .bit bytes and manifest, keeps them after ack, then removes only raw output on cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-e3-worker-"));
    roots.push(root);
    const ledger = await FileEvolutionEvalLedger.initialize({
      root: join(root, "ledger"), ledgerEpoch: "e3-live", now: () => new Date("2026-08-26T08:00:00.000Z"),
    });
    const fixture = sealedExecutionFixture();
    const execution: EvolutionEvalExecution = {
      async execute({ workspace, onProcessStarted }) {
        expect(await onProcessStarted({ pid: 888, processGroupId: 888, startToken: "e3-live-process" })).toBe(true);
        const output = join(workspace, "output");
        await mkdir(output, { recursive: true });
        const bytes = new Uint8Array([0xaa, 0x99, 0x55, 0x66]);
        await writeFile(join(output, "trial.bit"), bytes);
        return {
          terminalState: "succeeded",
          evidence: {
            jobId: fixture.binding.dispatch.connector_job_id,
            entries: [{
              name: "trial.bit",
              uri: `workspace://${fixture.binding.dispatch.connector_job_id}/output/trial.bit`,
              sha256: sha256(bytes),
              sizeBytes: bytes.byteLength,
              mediaType: "application/octet-stream",
            }],
          },
        };
      },
    };
    const runtime = new WorkerRuntime({
      endpoint,
      workspaceRoot: join(root, "ordinary"),
      evolutionEval: {
        ledger,
        spoolRoot: join(root, "spool"),
        execution,
        toolchainProfileHash: fixture.binding.dispatch.toolchain_profile_hash,
        now: () => new Date("2026-08-26T08:00:00.000Z"),
        processSupervisor: {
          isTreeStopped: () => true,
          ownsIdentity: async () => true,
          stopAndConfirm: async () => true,
        },
      },
    });
    const worker = (runtime as unknown as { evolutionEval: {
      reserve(binding: CoreIssuedEvalBinding): Promise<unknown>;
      submit(binding: CoreIssuedEvalBinding, input: unknown): Promise<unknown>;
      evidenceManifest(binding: CoreIssuedEvalBinding): Promise<{ manifest_hash: string; entries: readonly { name: string; artifact_classification: string; usage_classification: string }[] }>;
      acknowledgeEvidence(binding: CoreIssuedEvalBinding, hashes: { connectorManifestHash: string; coreManifestHash: string; coreAckFactHash: string }): Promise<{ connector_fact_hash: string | null }>;
      evidenceEntryDescriptor(binding: CoreIssuedEvalBinding, name: string): Promise<{ path: string }>;
      cleanupEvidence(binding: CoreIssuedEvalBinding, connectorFactHash: string, coreCleanupFactHash: string): Promise<unknown>;
    } }).evolutionEval;
    await worker.reserve(fixture.binding);
    await worker.submit(fixture.binding, fixture.input);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ledger.query(fixture.binding)).state === "terminal") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await ledger.query(fixture.binding)).state).toBe("terminal");
    const manifest = await worker.evidenceManifest(fixture.binding);
    expect(manifest.entries[0]).toMatchObject({
      name: "trial.bit",
      artifact_classification: "experimental/evolution_eval",
      usage_classification: "evolution_eval_only",
    });
    const descriptor = await worker.evidenceEntryDescriptor(fixture.binding, "trial.bit");
    expect((await readFile(descriptor.path)).byteLength).toBe(4);
    const coreManifestHash = "a".repeat(64);
    await expect(worker.acknowledgeEvidence(fixture.binding, {
      connectorManifestHash: manifest.manifest_hash,
      coreManifestHash,
      coreAckFactHash: "b".repeat(64),
    })).rejects.toMatchObject({ code: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" });
    expect((await stat(descriptor.path)).isFile()).toBe(true);
    const ack = await worker.acknowledgeEvidence(fixture.binding, {
      connectorManifestHash: manifest.manifest_hash,
      coreManifestHash,
      coreAckFactHash: coreAckHash(fixture.binding, coreManifestHash),
    });
    expect((await stat(descriptor.path)).isFile()).toBe(true);
    await worker.evidenceEntryDescriptor(fixture.binding, "trial.bit");
    const acknowledgedFactHash = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-acknowledged.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      manifest_hash: coreManifestHash,
      connector_fact_hash: ack.connector_fact_hash!,
    });
    await expect(worker.cleanupEvidence(
      fixture.binding,
      ack.connector_fact_hash!,
      "c".repeat(64),
    )).rejects.toMatchObject({ code: "EVOLUTION_EVAL_EVIDENCE_CORRUPT" });
    expect((await stat(descriptor.path)).isFile()).toBe(true);
    await worker.cleanupEvidence(
      fixture.binding,
      ack.connector_fact_hash!,
      coreCleanupHash(fixture.binding, acknowledgedFactHash),
    );
    await expect(stat(descriptor.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(dirname(descriptor.path), "..", "evidence-manifest.json"), "utf8")))
      .toMatchObject({ manifest_hash: manifest.manifest_hash });
  });

  test("discard winning the markOutput race still deletes late bytes and reaches terminal cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-e3-output-race-"));
    roots.push(root);
    const now = { value: new Date("2026-08-26T08:00:00.000Z") };
    const ledger = await FileEvolutionEvalLedger.initialize({
      root: join(root, "ledger"), ledgerEpoch: "e3-race", now: () => now.value,
    });
    const reachedMarkOutput = Promise.withResolvers<void>();
    const releaseMarkOutput = Promise.withResolvers<void>();
    const gatedLedger = new Proxy(ledger as EvolutionEvalLedger, {
      get(target, property) {
        if (property === "markOutput") {
          return async (...args: Parameters<EvolutionEvalLedger["markOutput"]>) => {
            reachedMarkOutput.resolve();
            await releaseMarkOutput.promise;
            return target.markOutput(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fixture = sealedExecutionFixture();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const execution: EvolutionEvalExecution = {
      async execute({ workspace, onProcessStarted }) {
        expect(await onProcessStarted({ pid: 889, processGroupId: 889, startToken: "e3-race-process" })).toBe(true);
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(join(workspace, "output", "race.bit"), bytes);
        return {
          terminalState: "succeeded",
          evidence: {
            jobId: fixture.binding.dispatch.connector_job_id,
            entries: [{
              name: "race.bit",
              uri: `workspace://${fixture.binding.dispatch.connector_job_id}/output/race.bit`,
              sha256: sha256(bytes),
              sizeBytes: bytes.byteLength,
              mediaType: "application/octet-stream",
            }],
          },
        };
      },
    };
    const spool = join(root, "spool");
    const runtime = new WorkerRuntime({
      endpoint,
      workspaceRoot: join(root, "ordinary"),
      evolutionEval: {
        ledger: gatedLedger,
        spoolRoot: spool,
        execution,
        toolchainProfileHash: fixture.binding.dispatch.toolchain_profile_hash,
        now: () => now.value,
        processSupervisor: {
          isTreeStopped: () => true,
          ownsIdentity: async () => true,
          stopAndConfirm: async () => true,
        },
      },
    });
    const worker = (runtime as unknown as { evolutionEval: {
      reserve(binding: CoreIssuedEvalBinding): Promise<unknown>;
      submit(binding: CoreIssuedEvalBinding, input: unknown): Promise<unknown>;
      discardEvidence(binding: CoreIssuedEvalBinding, input: { reason: "unavailable_at_deadline"; coreConclusionFactHash: string; coreCleanupFactHash: string; discardAuthorizationHash: string }): Promise<unknown>;
      queryRetention(binding: CoreIssuedEvalBinding): Promise<{ state: string; physical_deleted: boolean; source_authorization_kind: string | null }>;
    } }).evolutionEval;
    await worker.reserve(fixture.binding);
    await worker.submit(fixture.binding, fixture.input);
    await reachedMarkOutput.promise;
    now.value = new Date(fixture.binding.dispatch.deadline_at);
    const conclusion = canonicalEvolutionEvalHash({
      schema: "evolution-eval-evidence-deadline.v1",
      eval_job_id: fixture.binding.dispatch.eval_job_id,
      deadline_at: fixture.binding.dispatch.deadline_at,
      error_code: "EVOLUTION_EVAL_EVIDENCE_UNAVAILABLE_AT_DEADLINE",
    });
    await worker.discardEvidence(fixture.binding, {
      reason: "unavailable_at_deadline",
      coreConclusionFactHash: conclusion,
      coreCleanupFactHash: coreCleanupHash(fixture.binding, conclusion),
      discardAuthorizationHash: evolutionEvalDiscardAuthorizationHash(fixture.binding, {
        reason: "unavailable_at_deadline",
      }),
    });
    releaseMarkOutput.resolve();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ledger.query(fixture.binding)).state === "terminal") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await ledger.query(fixture.binding)).state).toBe("terminal");
    expect(await worker.queryRetention(fixture.binding)).toMatchObject({
      state: "cleaned",
      physical_deleted: true,
      source_authorization_kind: "discard",
    });
    await expect(stat(join(spool, "jobs", sha256(fixture.binding.dispatch.connector_job_id), "output", "race.bit")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

const endpoint: ConnectorEndpoint = {
  connector_id: "vivado-1",
  display_name: "remote",
  endpoint_url: "https://eda.example.test",
  protocol_version: REMOTE_SCHEMA_VERSION,
  transport_mode: "direct_https",
  auth_mode: "mtls",
  tls_trust_ref: "secret://trust/1",
  tls_client_cert_ref: "secret://cert/1",
  project_scope: ["p1"],
  data_classification_scope: ["internal"],
  allowed_capability_ids: ["simulate"],
  toolchain_profile_hash: "5".repeat(64),
  worker_labels: {},
  heartbeat_interval_seconds: 10,
  lease_seconds: 30,
  max_concurrency: 1,
  registration_state: "ready",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  audited_by: "svc",
};

class StreamTransport implements RemoteTransport {
  constructor(private readonly response: (body: RemoteEnvelope<unknown>) => {
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  }) {}
  async request(): Promise<RemoteResponse<unknown>> {
    return { status: 500, body: { error_code: "unused" } };
  }
  async requestStream(_path: string, request: { body?: RemoteEnvelope<unknown> }) {
    return this.response(request.body!);
  }
}

class ManifestTransport implements RemoteTransport {
  constructor(private readonly manifest: unknown) {}
  async request(_path: string, request: { body?: RemoteEnvelope<unknown> }): Promise<RemoteResponse<unknown>> {
    return { status: 200, body: { ...request.body!, payload: this.manifest } };
  }
}

function streamClient(transport: RemoteTransport): RemoteConnectorClient {
  return new RemoteConnectorClient({
    endpoint,
    transport,
    actor: { actor_type: "service", actor_id: "synthia-core-evolution-eval-dispatcher" },
    classification: "internal",
    projectId: "p1",
    allowlist: ["eda.example.test"],
    correlationId: () => "stream-correlation",
  });
}

function streamResponse(request: RemoteEnvelope<unknown>, expected: CoreIssuedEvalBinding, bytes: Uint8Array, length = bytes.byteLength) {
  const payload = request.payload as { name: string };
  return {
    status: 200,
    headers: new Headers({
      "content-type": "application/octet-stream",
      "content-length": String(length),
      "x-synthia-schema": "evolution-eval-connector-evidence-entry-stream.v1",
      "x-synthia-correlation-id": request.correlation_id,
      "x-synthia-idempotency-key": request.idempotency_key,
      "x-synthia-project-id": request.project_id,
      "x-synthia-classification": request.classification,
      "x-synthia-capability-version": request.capability_version,
      "x-synthia-eval-job-id": expected.dispatch.eval_job_id,
      "x-synthia-connector-job-id": expected.dispatch.connector_job_id,
      "x-synthia-dispatch-request-hash": expected.dispatch_request_hash,
      "x-synthia-evidence-name": payload.name,
      "x-synthia-evidence-sha256": sha256(bytes),
    }),
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  };
}

describe("evolution-eval bounded binary evidence stream", () => {
  test("streams verified bytes without base64 materialization", async () => {
    const expected = binding();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const transport = new StreamTransport((request) => streamResponse(request, expected, bytes));
    const stream = await streamClient(transport).evolutionEvalEvidenceEntryStream(expected, "trial.bit");
    const received: number[] = [];
    for await (const chunk of stream) received.push(...chunk);
    expect(received).toEqual([...bytes]);
  });

  test("rejects absent/lying length and truncated bodies with bounded cancellation", async () => {
    const expected = binding();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const absent = new StreamTransport((request) => {
      const response = streamResponse(request, expected, bytes);
      response.headers.delete("content-length");
      return response;
    });
    await expect(streamClient(absent).evolutionEvalEvidenceEntryStream(expected, "trial.bit"))
      .rejects.toMatchObject({ code: "EVIDENCE_CORRUPT" });

    for (const length of [2, 8]) {
      const transport = new StreamTransport((request) => streamResponse(request, expected, bytes, length));
      const stream = await streamClient(transport).evolutionEvalEvidenceEntryStream(expected, "trial.bit");
      const consume = async () => { for await (const _chunk of stream) {} };
      await expect(consume()).rejects.toMatchObject({
        code: length < bytes.byteLength ? "EVIDENCE_LIMIT_EXCEEDED" : "EVIDENCE_CORRUPT",
      });
    }
  });
});

describe("evolution-eval connector manifest limits and classifications", () => {
  function manifest(expected: CoreIssuedEvalBinding, count: number, sizeBytes = 1) {
    const entries = Array.from({ length: count }, (_, index) => ({
      name: index === 0 ? "trial.bit" : `entry-${String(index).padStart(3, "0")}.log`,
      sha256: index.toString(16).padStart(64, "0"),
      size_bytes: sizeBytes,
      media_type: index === 0 ? "application/octet-stream" as const : "text/plain" as const,
      artifact_classification: index === 0
        ? "experimental/evolution_eval" as const : "evolution_eval_evidence" as const,
      usage_classification: "evolution_eval_only" as const,
    })).sort((left, right) => left.name < right.name ? -1 : 1);
    const canonical = {
      schema: "evolution-eval-connector-evidence-manifest.v1" as const,
      eval_job_id: expected.dispatch.eval_job_id,
      connector_job_id: expected.dispatch.connector_job_id,
      dispatch_request_hash: expected.dispatch_request_hash,
      entries,
    };
    return { ...canonical, manifest_hash: canonicalEvolutionEvalHash(canonical) };
  }

  test("accepts 128 entries and exact .bit dual classification, rejects 129 and canonical drift", async () => {
    const expected = binding();
    const accepted = manifest(expected, EVOLUTION_EVAL_EVIDENCE_LIMITS.entries);
    const result = await streamClient(new ManifestTransport(accepted)).evolutionEvalEvidenceManifest(expected);
    expect(result.entries).toHaveLength(128);
    expect(result.entries.find((entry) => entry.name === "trial.bit")).toMatchObject({
      artifact_classification: "experimental/evolution_eval",
      usage_classification: "evolution_eval_only",
    });
    await expect(streamClient(new ManifestTransport(manifest(expected, 129))).evolutionEvalEvidenceManifest(expected))
      .rejects.toMatchObject({ code: "EVIDENCE_CORRUPT" });
    await expect(streamClient(new ManifestTransport({ ...accepted, manifest_hash: "f".repeat(64) }))
      .evolutionEvalEvidenceManifest(expected)).rejects.toMatchObject({ code: "EVIDENCE_CORRUPT" });
  });

  test("accepts the 256 MiB metadata boundary and rejects one byte over without allocating evidence bytes", async () => {
    const expected = binding();
    const boundary = manifest(expected, 4, EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes);
    expect((await streamClient(new ManifestTransport(boundary)).evolutionEvalEvidenceManifest(expected)).entries)
      .toHaveLength(4);
    const over = manifest(expected, 5, EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes);
    await expect(streamClient(new ManifestTransport(over)).evolutionEvalEvidenceManifest(expected))
      .rejects.toMatchObject({ code: "EVIDENCE_LIMIT_EXCEEDED" });
  });
});
