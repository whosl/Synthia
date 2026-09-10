import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mayReplayEvolutionEvalDispatch } from "../core/src/domain/evolution-eval-dispatcher.ts";
import {
  computeEvolutionEvalDispatchRequestHash,
  validateEvalLedgerQuery,
  type CoreIssuedEvalBinding,
  type EvalLedgerQuery,
  type EvolutionEvalDispatchRequestV1,
} from "./evolution-eval.ts";
import {
  evolutionEvalLedgerRecordKey,
  FileEvolutionEvalLedger,
  type EvolutionEvalLedger,
} from "./evolution-eval-ledger.ts";

const FIXED_NOW = new Date("2026-08-26T08:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryLedgerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "synthia-eval-ledger-adversarial-"));
  roots.push(root);
  return root;
}

function dispatch(
  overrides: Partial<EvolutionEvalDispatchRequestV1> = {},
): EvolutionEvalDispatchRequestV1 {
  return {
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: "eej-adversarial-1",
    connector_job_id: "connector-adversarial-1",
    connector_idempotency_key: "1".repeat(64),
    eval_input_ref: "eei-adversarial-1",
    input_manifest_hash: "2".repeat(64),
    workspace_id: "eew-adversarial-1",
    workspace_revision: 1,
    workspace_manifest_hash: "3".repeat(64),
    sealed_input_projection_hash: "4".repeat(64),
    operation: "simulate",
    parameters: {
      operation: "simulate",
      source_paths: ["rtl/top.sv", "tb/top_tb.sv"],
      top: "top",
      testbench: "top_tb",
    },
    part: "xc7a35tcsg324-1",
    toolchain_profile_hash: "4".repeat(64),
    requested_timeout_ms: 60_000,
    operation_cap_ms: 7_200_000,
    deadline_at: "2026-08-26T10:00:00.000Z",
    run_class: "evolution_eval",
    ...overrides,
  };
}

function binding(
  request = dispatch(),
  projectId = "project-adversarial-1",
): CoreIssuedEvalBinding {
  return {
    project_id: projectId,
    dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(request),
    dispatch: request,
  };
}

async function initializeLedger(
  root: string,
  epoch = "epoch-adversarial-1",
  faultInjector?: Parameters<typeof FileEvolutionEvalLedger.initialize>[0]["faultInjector"],
) {
  return FileEvolutionEvalLedger.initialize({
    root,
    ledgerEpoch: epoch,
    now: () => FIXED_NOW,
    faultInjector,
  });
}

async function reopenLedger(root: string, epoch = "epoch-adversarial-1") {
  return FileEvolutionEvalLedger.reopen({
    root,
    ledgerEpoch: epoch,
    now: () => FIXED_NOW,
  });
}

function factPath(
  root: string,
  connectorJobId: string,
  kind: "reservation" | "accepted" | "terminal",
): string {
  return join(
    root,
    "facts",
    `${evolutionEvalLedgerRecordKey(connectorJobId)}.${kind}.json`,
  );
}

function commonProof(expected: CoreIssuedEvalBinding) {
  return {
    schema: "evolution-eval-ledger-query.v1" as const,
    connector_job_id: expected.dispatch.connector_job_id,
    connector_idempotency_key: expected.dispatch.connector_idempotency_key,
    dispatch_request_hash: expected.dispatch_request_hash,
    ledger_epoch: "epoch-adversarial-1",
  };
}

const PROCESS = { pid: 4343, processGroupId: 4343, startToken: "adversarial-process-1" } as const;
async function confirmProcessExit(store: EvolutionEvalLedger, expected: CoreIssuedEvalBinding, token: string): Promise<void> {
  expect(await store.markProcessStarted(expected, PROCESS, token)).toBe(true);
  expect(await store.markProcessExitConfirmed(expected, PROCESS, token)).toBe(true);
}

function requireEffectOwnerToken(result: {
  readonly accepted_now: boolean;
  readonly effect_owner_token?: string;
}): string {
  expect(result.accepted_now).toBe(true);
  expect(result.effect_owner_token).toMatch(/^[0-9a-f]{64}$/);
  if (result.effect_owner_token === undefined) {
    throw new Error("new acceptance did not return its effect owner token");
  }
  return result.effect_owner_token;
}

describe("evolution-eval ledger six-state proof contract", () => {
  test("accepts exactly the frozen six-state discriminated union and rejects invented states", () => {
    const expected = binding();
    const base = commonProof(expected);
    const observations: EvalLedgerQuery[] = [
      { ...base, state: "proven_never_accepted", replay_permitted: true },
      {
        ...base,
        state: "accepted",
        execution_state: "running",
        accepted_at: "2026-08-26T08:00:01.000Z",
      },
      {
        ...base,
        state: "terminal",
        terminal_state: "succeeded",
        process_stopped: true,
        terminal_at: "2026-08-26T08:00:02.000Z",
        error_code: null,
      },
      {
        ...base,
        state: "transient_unavailable",
        retryable: true,
        error_code: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
      },
      {
        ...base,
        state: "ambiguous",
        effect_possible: true,
        error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
      },
      {
        ...base,
        state: "ledger_corrupt",
        replay_permitted: false,
        error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT",
      },
    ];

    for (const observation of observations) {
      expect(validateEvalLedgerQuery(observation, expected, base.ledger_epoch)).toEqual(observation);
    }
    expect(() => validateEvalLedgerQuery({
      ...base,
      state: "not_found",
      replay_permitted: true,
    }, expected, base.ledger_epoch)).toThrow("six frozen states");
  });

  test("only positive durable negative proof permits a same-ID submission", () => {
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
      expect(mayReplayEvolutionEvalDispatch(state, false)).toBe(false);
    }
  });
});

describe("evolution-eval ledger query-first and restart behavior", () => {
  test("ordinary absence stays ambiguous until an immutable reservation creates proof", async () => {
    const root = await temporaryLedgerRoot();
    const expected = binding();
    const firstProcess = await initializeLedger(root);

    expect(await firstProcess.query(expected)).toMatchObject({
      state: "ambiguous",
      effect_possible: true,
      error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
    });
    expect(await readdir(join(root, "facts"))).toEqual([]);

    const reserved = await firstProcess.queryOrReserve(expected);
    expect(reserved).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });
    const restarted = await reopenLedger(root);
    expect(await restarted.query(expected)).toEqual(reserved);
    expect(await restarted.queryOrReserve(expected)).toEqual(reserved);
    expect(await readdir(join(root, "facts"))).toHaveLength(1);
  });

  test("pre-accept crash can resume the original ID, while response-lost after acceptance cannot execute twice", async () => {
    const root = await temporaryLedgerRoot();
    const expected = binding();

    await (await initializeLedger(root)).queryOrReserve(expected);
    const afterPreAcceptCrash = await reopenLedger(root);
    expect(await afterPreAcceptCrash.query(expected)).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });
    const accepted = await afterPreAcceptCrash.markAccepted(expected, {
      executionState: "running",
      acceptedAt: "2026-08-26T08:00:01.000Z",
    });

    const ownerToken = requireEffectOwnerToken(accepted);
    expect(accepted.observation).toMatchObject({ state: "accepted" });

    const afterLostResponse = await reopenLedger(root);
    expect(await afterLostResponse.queryOrReserve(expected)).toEqual(accepted.observation);
    const duplicateAcceptance = await afterLostResponse.markAccepted(expected, {
      executionState: "queued",
      acceptedAt: "2026-08-26T08:00:03.000Z",
    });
    expect(duplicateAcceptance).toEqual({
      observation: accepted.observation,
      accepted_now: false,
    });
    expect((await readdir(join(root, "facts"))).filter((name) => (
      name.endsWith(".reservation.json") || name.endsWith(".accepted.json")
    ))).toHaveLength(2);
    expect(await readFile(join(root, "ledger.json"), "utf8")).not.toContain(ownerToken);
    expect((await Promise.all((await readdir(join(root, "facts"))).map((name) => (
      readFile(join(root, "facts", name), "utf8")
    )))).join("\n")).not.toContain(ownerToken);
    expect((await Promise.all((await readdir(join(root, "heads"))).map((name) => (
      readFile(join(root, "heads", name), "utf8")
    )))).join("\n")).not.toContain(ownerToken);
  });

  test("terminal proof remains immutable across restart and conflicting settlement", async () => {
    const root = await temporaryLedgerRoot();
    const expected = binding();
    const firstProcess = await initializeLedger(root);
    await firstProcess.queryOrReserve(expected);
    const acceptance = await firstProcess.markAccepted(expected, { executionState: "running" });
    const ownerToken = requireEffectOwnerToken(acceptance);
    await confirmProcessExit(firstProcess, expected, ownerToken);
    const terminal = await firstProcess.markTerminal(expected, {
      terminalState: "succeeded",
      terminalAt: "2026-08-26T08:00:02.000Z",
    }, ownerToken);

    const restarted = await reopenLedger(root);
    expect(await restarted.query(expected)).toEqual(terminal);
    expect(await restarted.markTerminal(expected, {
      terminalState: "failed",
      errorCode: "VIVADO_FAILED",
    }, ownerToken)).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_LEDGER_TERMINAL_CONFLICT",
    });
    expect(await restarted.query(expected)).toEqual(terminal);
  });

  test("only the one-time effect owner can append terminal proof", async () => {
    const root = await temporaryLedgerRoot();
    const expected = binding();
    const store = await initializeLedger(root);
    await store.queryOrReserve(expected);
    const acceptance = await store.markAccepted(expected, { executionState: "running" });
    const ownerToken = requireEffectOwnerToken(acceptance);
    await confirmProcessExit(store, expected, ownerToken);

    expect(await store.markTerminal(
      expected,
      { terminalState: "succeeded" },
      "f".repeat(64),
    )).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_EFFECT_OWNER_MISMATCH",
    });
    expect(await store.query(expected)).toEqual(acceptance.observation);
    expect((await readdir(join(root, "facts"))).filter((name) => (
      name.endsWith(".terminal.json")
    ))).toEqual([]);
    expect((await readdir(join(root, "heads"))).filter((name) => (
      name.endsWith(".terminal.json")
    ))).toEqual([]);
    expect(await store.markTerminal(
      expected,
      { terminalState: "succeeded" },
      ownerToken,
    )).toMatchObject({ state: "terminal", terminal_state: "succeeded" });
  });

  test("acceptance commit-boundary failures never return effect ownership or blind-replay proof", async () => {
    const expected = binding();

    const beforeCommitRoot = await temporaryLedgerRoot();
    const beforeCommit = await initializeLedger(beforeCommitRoot, undefined, (point) => {
      if (point.factKind === "acceptance_head" && point.operation === "link") {
        throw new Error("injected acceptance head link failure");
      }
    });
    await beforeCommit.queryOrReserve(expected);
    const beforeCommitResult = await beforeCommit.markAccepted(expected, {
      executionState: "running",
    });
    expect(beforeCommitResult).toMatchObject({
      accepted_now: false,
      observation: {
        state: "transient_unavailable",
        retryable: true,
      },
    });
    expect(beforeCommitResult.effect_owner_token).toBeUndefined();
    expect(await (await reopenLedger(beforeCommitRoot)).query(expected)).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });

    const ambiguousCommitRoot = await temporaryLedgerRoot();
    const ambiguousCommit = await initializeLedger(ambiguousCommitRoot, undefined, (point) => {
      if (point.factKind === "acceptance_head" && point.operation === "directory_fsync") {
        throw new Error("injected acceptance head directory fsync failure");
      }
    });
    await ambiguousCommit.queryOrReserve(expected);
    const ambiguousCommitResult = await ambiguousCommit.markAccepted(expected, {
      executionState: "running",
    });
    expect(ambiguousCommitResult).toMatchObject({
      accepted_now: false,
      observation: {
        state: "transient_unavailable",
        retryable: true,
      },
    });
    expect(ambiguousCommitResult.effect_owner_token).toBeUndefined();
    const reopenedAmbiguousCommit = await reopenLedger(ambiguousCommitRoot);
    expect(await reopenedAmbiguousCommit.query(expected)).toMatchObject({ state: "accepted" });
    expect(await reopenedAmbiguousCommit.queryOrReserve(expected)).toMatchObject({ state: "accepted" });
    expect(await reopenedAmbiguousCommit.markAccepted(expected, { executionState: "running" })).toMatchObject({
      accepted_now: false,
      observation: { state: "accepted" },
    });
  });
});

describe("evolution-eval ledger binding and epoch fail-closed behavior", () => {
  test("same connector job ID rejects project, idempotency-key, and dispatch-hash drift without appending effect facts", async () => {
    const root = await temporaryLedgerRoot();
    const original = binding();
    const store = await initializeLedger(root);
    await store.queryOrReserve(original);

    const changedKeyDispatch = dispatch({ connector_idempotency_key: "9".repeat(64) });
    const changedKey = binding(changedKeyDispatch);
    const changedProject = binding(dispatch(), "project-adversarial-2");
    const changedHash = {
      ...original,
      dispatch_request_hash: "8".repeat(64),
    };
    for (const changed of [changedKey, changedProject]) {
      expect(await store.query(changed)).toMatchObject({
        state: "ledger_corrupt",
        replay_permitted: false,
      });
      expect(await store.queryOrReserve(changed)).toMatchObject({
        state: "ledger_corrupt",
        replay_permitted: false,
      });
    }
    await expect(store.query(changedHash)).rejects.toThrow();
    expect(await readdir(join(root, "facts"))).toHaveLength(1);
  });

  test("a different connector job ID for the same Core eval job cannot create a second reservation", async () => {
    const root = await temporaryLedgerRoot();
    const original = binding();
    const store = await initializeLedger(root);
    await store.queryOrReserve(original);

    const changedId = binding(dispatch({ connector_job_id: "connector-adversarial-2" }));
    const observation = await store.queryOrReserve(changedId);
    expect(observation).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_BINDING_CONFLICT",
    });
    expect((await readdir(join(root, "facts"))).filter((name) => (
      name.endsWith(".reservation.json")
    ))).toHaveLength(1);
    expect(await readdir(join(root, "indexes"))).toHaveLength(1);
  });

  test("epoch replacement and malformed facts never become replay proof", async () => {
    const expected = binding();

    const epochRoot = await temporaryLedgerRoot();
    await (await initializeLedger(epochRoot, "epoch-original")).queryOrReserve(expected);
    expect(await (await reopenLedger(epochRoot, "epoch-replacement")).query(expected)).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
    });

    const malformedRoot = await temporaryLedgerRoot();
    const malformed = await initializeLedger(malformedRoot);
    await malformed.queryOrReserve(expected);
    await writeFile(
      factPath(malformedRoot, expected.dispatch.connector_job_id, "reservation"),
      "{partial",
      "utf8",
    );
    expect(await malformed.query(expected)).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
    });
  });

  test("orphan effect facts fail closed without manufacturing reservation proof", async () => {
    const expected = binding();
    const orphanRoot = await temporaryLedgerRoot();
    const orphan = await initializeLedger(orphanRoot);
    await writeFile(
      factPath(orphanRoot, expected.dispatch.connector_job_id, "accepted"),
      "{}\n",
      "utf8",
    );
    expect(await orphan.queryOrReserve(expected)).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
    });
    expect((await readdir(join(orphanRoot, "facts"))).filter((name) => (
      name.endsWith(".reservation.json")
    ))).toEqual([]);
  });

  test("filesystem unavailability is transient, while deterministic malformed content is corrupt", async () => {
    const expected = binding();

    const unavailableRoot = await temporaryLedgerRoot();
    const unavailable = await initializeLedger(unavailableRoot);
    await chmod(join(unavailableRoot, "facts"), 0o000);
    try {
      expect(await unavailable.query(expected)).toMatchObject({
        state: "transient_unavailable",
        retryable: true,
        error_code: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE",
      });
    } finally {
      await chmod(join(unavailableRoot, "facts"), 0o700);
    }

    const corruptRoot = await temporaryLedgerRoot();
    const corrupt = await initializeLedger(corruptRoot);
    await corrupt.queryOrReserve(expected);
    await writeFile(
      factPath(corruptRoot, expected.dispatch.connector_job_id, "reservation"),
      "{}\n",
      "utf8",
    );
    expect(await corrupt.query(expected)).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT",
    });
  });

  test("concurrent reserve, acceptance, and terminal writes have one immutable fact per phase", async () => {
    const root = await temporaryLedgerRoot();
    const expected = binding();
    const left = await initializeLedger(root);
    const right = await reopenLedger(root);

    const reservations = await Promise.all([
      left.queryOrReserve(expected),
      right.queryOrReserve(expected),
    ]);
    expect(reservations.every((result) => (
      result.state === "proven_never_accepted" && result.replay_permitted
    ))).toBe(true);
    const acceptances = await Promise.all([
      left.markAccepted(expected, { executionState: "running" }),
      right.markAccepted(expected, { executionState: "running" }),
    ]);
    expect(acceptances.every((result) => result.observation.state === "accepted")).toBe(true);
    expect(acceptances.filter((result) => result.accepted_now)).toHaveLength(1);
    const ownerToken = requireEffectOwnerToken(
      acceptances.find((result) => result.accepted_now)!,
    );
    await confirmProcessExit(left, expected, ownerToken);
    const terminals = await Promise.all([
      left.markTerminal(expected, { terminalState: "succeeded" }, ownerToken),
      right.markTerminal(
        expected,
        { terminalState: "failed", errorCode: "VIVADO_FAILED" },
        ownerToken,
      ),
    ]);
    expect(terminals.filter((result) => result.state === "terminal")).toHaveLength(1);
    expect(terminals.filter((result) => result.state === "ledger_corrupt")).toHaveLength(1);

    const facts = await readdir(join(root, "facts"));
    expect(facts.filter((name) => name.endsWith(".reservation.json"))).toHaveLength(1);
    expect(facts.filter((name) => name.endsWith(".accepted.json"))).toHaveLength(1);
    expect(facts.filter((name) => name.endsWith(".terminal.json"))).toHaveLength(1);
    expect(await readdir(join(root, "indexes"))).toHaveLength(1);
    expect(await readdir(join(root, "heads"))).toHaveLength(3);
    expect(await readFile(join(root, "ledger.json"), "utf8")).not.toContain(tmpdir());
  });
});
