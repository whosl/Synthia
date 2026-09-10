import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEvolutionEvalDispatchRequestHash,
  type CoreIssuedEvalBinding,
  type EvolutionEvalDispatchRequestV1,
} from "./evolution-eval.ts";
import {
  evolutionEvalLedgerRecordKey,
  FileEvolutionEvalLedger,
  type EvolutionEvalAcceptanceResult,
  type EvolutionEvalLedger,
  type EvolutionEvalLedgerFactKind,
  type EvolutionEvalLedgerFsOperation,
} from "./evolution-eval-ledger.ts";

const roots: string[] = [];
setDefaultTimeout(process.platform === "win32" ? 120_000 : 5_000);
const FIXED_NOW = new Date("2026-08-26T08:00:00.000Z");
const EPOCH = "epoch-ledger-1";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "synthia-eval-ledger-"));
  roots.push(path);
  return path;
}

function dispatch(overrides: Partial<EvolutionEvalDispatchRequestV1> = {}): EvolutionEvalDispatchRequestV1 {
  return {
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: "eej-ledger-1",
    connector_job_id: "connector-ledger-1",
    connector_idempotency_key: "1".repeat(64),
    eval_input_ref: "eei-ledger-1",
    input_manifest_hash: "2".repeat(64),
    workspace_id: "eew-ledger-1",
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

function binding(request = dispatch(), projectId = "project-ledger-1"): CoreIssuedEvalBinding {
  return {
    project_id: projectId,
    dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(request),
    dispatch: request,
  };
}

function options(path: string, overrides: Record<string, unknown> = {}) {
  return {
    root: path,
    ledgerEpoch: EPOCH,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

async function initialize(path: string) {
  return FileEvolutionEvalLedger.initialize(options(path));
}

async function reopen(path: string, overrides: Record<string, unknown> = {}) {
  return FileEvolutionEvalLedger.reopen(options(path, overrides));
}

function recordPath(path: string, expected: CoreIssuedEvalBinding, kind: "reservation" | "accepted" | "process" | "process-exit" | "terminal"): string {
  return join(path, "facts", `${evolutionEvalLedgerRecordKey(expected.dispatch.connector_job_id)}.${kind}.json`);
}

function headPath(path: string, expected: CoreIssuedEvalBinding, kind: "acceptance" | "terminal"): string {
  return join(path, "heads", `${evolutionEvalLedgerRecordKey(expected.dispatch.connector_job_id)}.${kind}.json`);
}

function indexPath(path: string, expected: CoreIssuedEvalBinding): string {
  return join(path, "indexes", `${evolutionEvalLedgerRecordKey(expected.dispatch.eval_job_id)}.json`);
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function owner(result: EvolutionEvalAcceptanceResult): string {
  expect(result.accepted_now).toBe(true);
  expect(result.effect_owner_token).toMatch(/^[0-9a-f]{64}$/);
  return result.effect_owner_token!;
}

const PROCESS = { pid: 4242, processGroupId: 4242, startToken: "ledger-process-1" } as const;
async function confirmProcessExit(store: EvolutionEvalLedger, expected: CoreIssuedEvalBinding, token: string): Promise<void> {
  expect(await store.markProcessStarted(expected, PROCESS, token)).toBe(true);
  expect(await store.markProcessExitConfirmed(expected, PROCESS, token)).toBe(true);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("file evolution-eval ledger initialization and negative proof", () => {
  test("Windows PowerShell 5.1 write-through moves receive paths through the controlled environment", async () => {
    if (process.platform !== "win32") return;
    const base = await temporaryRoot();
    const path = join(base, "ledger with spaces [encoded-command]");
    const expected = binding();
    const store = await initialize(path);
    expect(await store.queryOrReserve(expected)).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });
    expect(await (await reopen(path)).query(expected)).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });
  });

  test("initialize is explicit and pure query never turns ordinary absence into proof", async () => {
    const path = await temporaryRoot();
    const store = await initialize(path);
    expect(await store.query(binding())).toMatchObject({
      state: "ambiguous",
      effect_possible: true,
      error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF",
    });
    expect(await readdir(join(path, "facts"))).toEqual([]);
    expect(await readdir(join(path, "indexes"))).toEqual([]);
  });

  test("initialize and reopen never self-heal a non-empty or anchored root without metadata", async () => {
    const nonEmpty = await temporaryRoot();
    await writeFile(join(nonEmpty, "anchor"), "existing", "utf8");
    const initialized = await FileEvolutionEvalLedger.initialize(options(nonEmpty));
    expect(await initialized.query(binding())).toMatchObject({
      state: "ledger_corrupt",
      error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT",
    });
    expect(await readdir(nonEmpty)).toEqual(["anchor"]);

    const empty = await temporaryRoot();
    const reopened = await reopen(empty);
    expect(await reopened.query(binding())).toMatchObject({
      state: "ledger_corrupt",
      error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT",
    });
    expect(await readdir(empty)).toEqual([]);
  });

  test("epoch mismatch and corrupt metadata use distinct stable codes", async () => {
    const epochPath = await temporaryRoot();
    await initialize(epochPath);
    const mismatch = await FileEvolutionEvalLedger.reopen(options(epochPath, { ledgerEpoch: "epoch-other" }));
    expect(await mismatch.query(binding())).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
    });

    const corruptPath = await temporaryRoot();
    await initialize(corruptPath);
    await writeFile(join(corruptPath, "ledger.json"), "{partial", "utf8");
    const corrupt = await reopen(corruptPath);
    expect(await corrupt.query(binding())).toMatchObject({
      state: "ledger_corrupt",
      replay_permitted: false,
      error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT",
    });
  });

  test("queryOrReserve publishes an indexed proof and restart verifies its fact chain", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    const first = await (await initialize(path)).queryOrReserve(expected);
    expect(first).toMatchObject({ state: "proven_never_accepted", replay_permitted: true });
    expect(await (await reopen(path)).query(expected)).toEqual(first);

    const metadata = await json(join(path, "ledger.json"));
    const index = await json(indexPath(path, expected));
    const reservation = await json(recordPath(path, expected, "reservation"));
    expect(index.parent_fact_hash).toBe(metadata.fact_hash);
    expect(reservation.parent_fact_hash).toBe(metadata.fact_hash);
    expect(index.reservation_fact_hash).toBe(reservation.fact_hash);
  });

  test("a first tombstone reservation is durable and can never own an effect", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    const store = await initialize(path);
    expect(await store.queryOrReserve(expected, { replayPermitted: false })).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: false,
    });
    const result = await store.markAccepted(expected, { executionState: "queued" });
    expect(result).toMatchObject({
      accepted_now: false,
      observation: { state: "ledger_corrupt", error_code: "EVOLUTION_EVAL_LEDGER_ACCEPTANCE_WITHOUT_RESERVATION" },
    });
    expect(result.effect_owner_token).toBeUndefined();
  });

  test("concurrent same-binding reservations converge on one index and one fact", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    await initialize(path);
    const left = await reopen(path);
    const right = await reopen(path);
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (
      index % 2 === 0 ? left : right
    ).queryOrReserve(expected)));
    expect(results.every((result) => result.state === "proven_never_accepted" && result.replay_permitted)).toBe(true);
    expect(await readdir(join(path, "indexes"))).toHaveLength(1);
    expect((await readdir(join(path, "facts"))).filter((name) => name.endsWith(".reservation.json"))).toHaveLength(1);
  });

  test("global eval_job_id index blocks connector-job drift across processes", async () => {
    const path = await temporaryRoot();
    const original = binding();
    const drifted = binding(dispatch({
      connector_job_id: "connector-ledger-drifted",
      connector_idempotency_key: "9".repeat(64),
    }));
    await initialize(path);
    const [left, right] = await Promise.all([reopen(path), reopen(path)]);
    const results = await Promise.all([
      left.queryOrReserve(original),
      right.queryOrReserve(drifted),
    ]);
    expect(results.filter((result) => result.state === "proven_never_accepted")).toHaveLength(1);
    expect(results.filter((result) => result.state === "ledger_corrupt"
      && result.error_code === "EVOLUTION_EVAL_BINDING_CONFLICT")).toHaveLength(1);
    expect(await readdir(join(path, "indexes"))).toHaveLength(1);
    expect((await readdir(join(path, "facts"))).filter((name) => name.endsWith(".reservation.json"))).toHaveLength(1);
  });
});

describe("file evolution-eval effect ownership and terminal chain", () => {
  test("cross-instance acceptance barrier gives exactly one durable effect owner", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    const initial = await initialize(path);
    await initial.queryOrReserve(expected);
    const [left, right] = await Promise.all([reopen(path), reopen(path)]);
    const results = await Promise.all([
      left.markAccepted(expected, { executionState: "running", acceptedAt: "2026-08-26T08:00:01.000Z" }),
      right.markAccepted(expected, { executionState: "running", acceptedAt: "2026-08-26T08:00:02.000Z" }),
    ]);
    expect(results.filter((result) => result.accepted_now)).toHaveLength(1);
    expect(results.filter((result) => result.effect_owner_token !== undefined)).toHaveLength(1);
    expect(results.every((result) => result.observation.state === "accepted")).toBe(true);
    const winner = results.find((result) => result.accepted_now)!;
    const loser = results.find((result) => !result.accepted_now)!;
    expect(loser.effect_owner_token).toBeUndefined();

    const restarted = await reopen(path);
    await confirmProcessExit(restarted, expected, winner.effect_owner_token!);
    expect(await restarted.markTerminal(expected, { terminalState: "succeeded" }, "f".repeat(64))).toMatchObject({
      state: "ledger_corrupt",
      error_code: "EVOLUTION_EVAL_EFFECT_OWNER_MISMATCH",
    });
    expect(await restarted.markTerminal(expected, { terminalState: "succeeded" }, winner.effect_owner_token!)).toMatchObject({
      state: "terminal",
      terminal_state: "succeeded",
      process_stopped: true,
    });
  });

  test("acceptance and terminal heads bind every immutable parent hash", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    const store = await initialize(path);
    await store.queryOrReserve(expected);
    const token = owner(await store.markAccepted(expected, { executionState: "running" }));
    await confirmProcessExit(store, expected, token);
    await store.markTerminal(expected, { terminalState: "failed", errorCode: "VIVADO_FAILED" }, token);

    const reservation = await json(recordPath(path, expected, "reservation"));
    const acceptanceHead = await json(headPath(path, expected, "acceptance"));
    const acceptance = await json(recordPath(path, expected, "accepted"));
    const terminalHead = await json(headPath(path, expected, "terminal"));
    const terminal = await json(recordPath(path, expected, "terminal"));
    expect(acceptanceHead.parent_fact_hash).toBe(reservation.fact_hash);
    expect(acceptance.parent_fact_hash).toBe(reservation.fact_hash);
    expect(acceptanceHead.acceptance_fact_hash).toBe(acceptance.fact_hash);
    const processExit = await json(recordPath(path, expected, "process-exit"));
    expect(terminalHead.parent_fact_hash).toBe(processExit.fact_hash);
    expect(terminal.parent_fact_hash).toBe(processExit.fact_hash);
    expect(terminalHead.terminal_fact_hash).toBe(terminal.fact_hash);
    expect(terminal.effect_owner_token_hash).toBe(acceptance.effect_owner_token_hash);
  });

  test("missing, replaced, or partial parents never regress accepted/terminal to negative proof", async () => {
    const acceptancePath = await temporaryRoot();
    const expected = binding();
    const acceptedStore = await initialize(acceptancePath);
    await acceptedStore.queryOrReserve(expected);
    await acceptedStore.markAccepted(expected, { executionState: "running" });
    await unlink(recordPath(acceptancePath, expected, "accepted"));
    // The acceptance head is the atomic commit point and carries enough data
    // to reconstruct a fact whose hash it already committed.
    expect(await (await reopen(acceptancePath)).query(expected)).toMatchObject({ state: "accepted" });

    const replacementPath = await temporaryRoot();
    const replacementStore = await initialize(replacementPath);
    await replacementStore.queryOrReserve(expected);
    await replacementStore.markAccepted(expected, { executionState: "running" });
    await writeFile(recordPath(replacementPath, expected, "reservation"), "{}\n", "utf8");
    expect(await (await reopen(replacementPath)).query(expected)).toMatchObject({ state: "ledger_corrupt" });

    const terminalPath = await temporaryRoot();
    const terminalStore = await initialize(terminalPath);
    await terminalStore.queryOrReserve(expected);
    const token = owner(await terminalStore.markAccepted(expected, { executionState: "running" }));
    await confirmProcessExit(terminalStore, expected, token);
    await terminalStore.markTerminal(expected, { terminalState: "succeeded" }, token);
    await unlink(recordPath(terminalPath, expected, "terminal"));
    expect(await (await reopen(terminalPath)).query(expected)).toMatchObject({ state: "ledger_corrupt" });
  });

  test("embedded inert guardian identity survives acceptance-head recovery and converges after reopen", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    const identity = { pid: 4242, processGroupId: 4242, startToken: "guardian-before-acceptance" };
    const store = await initialize(path);
    await store.queryOrReserve(expected);
    await store.markAccepted(expected, { executionState: "running", processIdentity: identity });
    await unlink(recordPath(path, expected, "accepted"));
    const recovered = await reopen(path);
    expect(await recovered.query(expected)).toMatchObject({ state: "accepted" });
    expect(await recovered.getProcessIdentity(expected)).toEqual(identity);
    expect(await recovered.markStopRequested(expected, "cancelled")).toBe(true);
    expect(await recovered.markProcessExitConfirmed(expected, identity)).toBe(true);
    expect(await recovered.markTerminalAfterConfirmedStop(
      expected,
      "cancelled",
      "EVOLUTION_EVAL_CANCELLED",
    )).toMatchObject({ state: "terminal", terminal_state: "cancelled", process_stopped: true });
  });

  test("concurrent conflicting terminal attempts have one immutable winner", async () => {
    const path = await temporaryRoot();
    const expected = binding();
    const initial = await initialize(path);
    await initial.queryOrReserve(expected);
    const token = owner(await initial.markAccepted(expected, { executionState: "running" }));
    await confirmProcessExit(initial, expected, token);
    const [left, right] = await Promise.all([reopen(path), reopen(path)]);
    const results = await Promise.all([
      left.markTerminal(expected, { terminalState: "succeeded" }, token),
      right.markTerminal(expected, { terminalState: "failed", errorCode: "VIVADO_FAILED" }, token),
    ]);
    expect(results.filter((result) => result.state === "terminal")).toHaveLength(1);
    expect(results.filter((result) => result.state === "ledger_corrupt"
      && result.error_code === "EVOLUTION_EVAL_LEDGER_TERMINAL_CONFLICT")).toHaveLength(1);
    expect((await readdir(join(path, "heads"))).filter((name) => name.endsWith(".terminal.json"))).toHaveLength(1);
    expect((await readdir(join(path, "facts"))).filter((name) => name.endsWith(".terminal.json"))).toHaveLength(1);
  });
});

describe("file evolution-eval durability fault injection", () => {
  const operations: readonly EvolutionEvalLedgerFsOperation[] = [
    "temp_write",
    "file_fsync",
    "link",
    "directory_fsync",
  ];

  async function failingReopen(
    path: string,
    operation: EvolutionEvalLedgerFsOperation,
    factKind: EvolutionEvalLedgerFactKind,
  ) {
    let fired = false;
    return reopen(path, {
      faultInjector(point: { operation: EvolutionEvalLedgerFsOperation; factKind: EvolutionEvalLedgerFactKind }) {
        if (!fired && point.operation === operation && point.factKind === factKind) {
          fired = true;
          throw new Error("injected I/O failure");
        }
      },
    });
  }

  test("a reservation observer cannot return while both publisher and observer lack a directory fence", async () => {
    if (process.platform === "win32") return;
    const path = await temporaryRoot();
    const expected = binding();
    await initialize(path);
    const winnerReachedFence = deferred();
    const releaseWinner = deferred();
    const winner = await reopen(path, {
      async faultInjector(point: { operation: EvolutionEvalLedgerFsOperation; factKind: EvolutionEvalLedgerFactKind }) {
        if (point.operation === "directory_fsync" && point.factKind === "reservation") {
          winnerReachedFence.resolve();
          await releaseWinner.promise;
        }
      },
    });
    let winnerDone = false;
    const winnerResult = winner.queryOrReserve(expected).then((result) => {
      winnerDone = true;
      return result;
    });
    const releaseObserver = deferred();
    try {
      await winnerReachedFence.promise;
      const observerReachedFence = deferred();
      const observer = await reopen(path, {
        async faultInjector(point: { operation: EvolutionEvalLedgerFsOperation; factKind: EvolutionEvalLedgerFactKind }) {
          if (point.operation === "directory_fsync" && point.factKind === "reservation") {
            observerReachedFence.resolve();
            await releaseObserver.promise;
          }
        },
      });
      let observerDone = false;
      const observerResult = observer.queryOrReserve(expected).then((result) => {
        observerDone = true;
        return result;
      });
      await observerReachedFence.promise;
      expect(winnerDone).toBe(false);
      expect(observerDone).toBe(false);
      releaseObserver.resolve();
      expect(await observerResult).toMatchObject({ state: "proven_never_accepted", replay_permitted: true });
      expect(winnerDone).toBe(false);
      releaseWinner.resolve();
      expect(await winnerResult).toMatchObject({ state: "proven_never_accepted", replay_permitted: true });
    } finally {
      releaseObserver.resolve();
      releaseWinner.resolve();
    }
  });

  test("Windows write-through mutex makes concurrent reservation publication converge durably", async () => {
    if (process.platform !== "win32") return;
    const path = await temporaryRoot();
    const expected = binding();
    await initialize(path);
    const [left, right] = await Promise.all([reopen(path), reopen(path)]);
    const results = await Promise.all([left.queryOrReserve(expected), right.queryOrReserve(expected)]);
    expect(results.every((result) => result.state === "proven_never_accepted" && result.replay_permitted)).toBe(true);
    expect((await readdir(join(path, "facts"))).filter((name) => name.endsWith(".reservation.json"))).toHaveLength(1);
    expect(await (await reopen(path)).query(expected)).toMatchObject({
      state: "proven_never_accepted",
      replay_permitted: true,
    });
  });

  test("a terminal observer cannot return while both publisher and observer lack a directory fence", async () => {
    if (process.platform === "win32") return;
    const path = await temporaryRoot();
    const expected = binding();
    const base = await initialize(path);
    await base.queryOrReserve(expected);
    const token = owner(await base.markAccepted(expected, { executionState: "running" }));
    await confirmProcessExit(base, expected, token);

    const winnerReachedFence = deferred();
    const releaseWinner = deferred();
    const winner = await reopen(path, {
      async faultInjector(point: { operation: EvolutionEvalLedgerFsOperation; factKind: EvolutionEvalLedgerFactKind }) {
        if (point.operation === "directory_fsync" && point.factKind === "terminal") {
          winnerReachedFence.resolve();
          await releaseWinner.promise;
        }
      },
    });
    let winnerDone = false;
    const winnerResult = winner.markTerminal(expected, { terminalState: "succeeded" }, token).then((result) => {
      winnerDone = true;
      return result;
    });
    const releaseObserver = deferred();
    try {
      await winnerReachedFence.promise;
      const observerReachedFence = deferred();
      const observer = await reopen(path, {
        async faultInjector(point: { operation: EvolutionEvalLedgerFsOperation; factKind: EvolutionEvalLedgerFactKind }) {
          if (point.operation === "directory_fsync" && point.factKind === "terminal") {
            observerReachedFence.resolve();
            await releaseObserver.promise;
          }
        },
      });
      let observerDone = false;
      const observerResult = observer.markTerminal(expected, { terminalState: "succeeded" }, token).then((result) => {
        observerDone = true;
        return result;
      });
      await observerReachedFence.promise;
      expect(winnerDone).toBe(false);
      expect(observerDone).toBe(false);
      releaseObserver.resolve();
      expect(await observerResult).toMatchObject({ state: "terminal", terminal_state: "succeeded" });
      expect(winnerDone).toBe(false);
      releaseWinner.resolve();
      expect(await winnerResult).toMatchObject({ state: "terminal", terminal_state: "succeeded" });
    } finally {
      releaseObserver.resolve();
      releaseWinner.resolve();
    }
  });

  test("acceptance owner is never returned across head/fact write, fsync, link, or dir-fsync failures", async () => {
    for (const factKind of ["acceptance_head", "acceptance"] as const) {
      for (const operation of operations) {
        const path = await temporaryRoot();
        const expected = binding(dispatch({
          eval_job_id: `eej-${factKind}-${operation}`,
          connector_job_id: `connector-${factKind}-${operation}`,
        }));
        const base = await initialize(path);
        await base.queryOrReserve(expected);
        const failing = await failingReopen(path, operation, factKind);
        const result = await failing.markAccepted(expected, { executionState: "running" });
        expect(result.accepted_now).toBe(false);
        expect(result.effect_owner_token).toBeUndefined();
        expect(result.observation.state).not.toBe("terminal");

        const afterCrash = await reopen(path);
        const observation = await afterCrash.query(expected);
        expect(["proven_never_accepted", "ledger_corrupt", "accepted"]).toContain(observation.state);
        if (observation.state === "accepted") {
          expect(await afterCrash.markTerminal(expected, { terminalState: "succeeded" }, "f".repeat(64))).toMatchObject({
            state: "ledger_corrupt",
            error_code: "EVOLUTION_EVAL_EFFECT_OWNER_MISMATCH",
          });
        }
      }
    }
  });

  test("terminal is never returned before its fact and directory are durable", async () => {
    for (const factKind of ["terminal_head", "terminal"] as const) {
      for (const operation of operations) {
        const path = await temporaryRoot();
        const expected = binding(dispatch({
          eval_job_id: `eej-${factKind}-${operation}`,
          connector_job_id: `connector-${factKind}-${operation}`,
        }));
        const base = await initialize(path);
        await base.queryOrReserve(expected);
        const token = owner(await base.markAccepted(expected, { executionState: "running" }));
        await confirmProcessExit(base, expected, token);
        const failing = await failingReopen(path, operation, factKind);
        const result = await failing.markTerminal(expected, { terminalState: "succeeded" }, token);
        expect(result.state).not.toBe("terminal");

        const afterCrash = await reopen(path);
        const recovered = await afterCrash.markTerminal(expected, { terminalState: "succeeded" }, token);
        expect(recovered).toMatchObject({ state: "terminal", terminal_state: "succeeded", process_stopped: true });
      }
    }
  });

  test("process-exit proof faults never publish terminal and are recoverable only after reconfirmation", async () => {
    for (const factKind of ["process_exit", "process_exit_head"] as const) for (const operation of operations) {
      const path = await temporaryRoot();
      const expected = binding(dispatch({
        eval_job_id: `eej-${factKind}-${operation}`,
        connector_job_id: `connector-${factKind}-${operation}`,
      }));
      const base = await initialize(path);
      await base.queryOrReserve(expected);
      const token = owner(await base.markAccepted(expected, { executionState: "running" }));
      expect(await base.markProcessStarted(expected, PROCESS, token)).toBe(true);
      const failing = await failingReopen(path, operation, factKind);
      expect(await failing.markProcessExitConfirmed(expected, PROCESS, token)).toBe(false);
      expect((await failing.markTerminal(expected, { terminalState: "succeeded" }, token)).state).not.toBe("terminal");

      const afterCrash = await reopen(path);
      expect((await afterCrash.query(expected)).state).not.toBe("terminal");
      expect(await afterCrash.markProcessExitConfirmed(expected, PROCESS, token)).toBe(true);
      expect(await afterCrash.markTerminal(expected, { terminalState: "succeeded" }, token)).toMatchObject({
        state: "terminal",
        terminal_state: "succeeded",
        process_stopped: true,
      });
    }
  });
});
