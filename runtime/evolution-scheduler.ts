/**
 * Caller-driven scheduler for self-evolution workers.
 *
 * The scheduler owns timing decisions only. It has no timer loop, persistence,
 * database, token, Connector, or governance capability; the host explicitly
 * calls {@link EvolutionScheduler.tick} and may persist/restore its snapshot.
 * It is disabled unless opted in.
 */

export const CURATOR_SCHEDULE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
export const CURATOR_IDLE_REQUIRED_MS = 2 * 60 * 60 * 1_000;
export const EVOLUTION_FAILURE_BACKOFF_BASE_MS = 60_000;
export const EVOLUTION_FAILURE_BACKOFF_MAX_MS = 60 * 60 * 1_000;

export interface EvolutionSchedulerClock {
  now(): number;
}

export interface EvolutionSchedulerIdleProbe {
  isIdle(signal?: AbortSignal): boolean | Promise<boolean>;
}

/** Structural subset shared by DistillerWorker and CuratorWorker results. */
export type EvolutionSchedulerWorkerResult =
  | { readonly state: "idle" }
  | { readonly state: "completed"; readonly [key: string]: unknown }
  | { readonly state: "failed"; readonly [key: string]: unknown };

export interface EvolutionSchedulerWorker {
  runOnce(signal?: AbortSignal): Promise<EvolutionSchedulerWorkerResult>;
}

export interface EvolutionCuratorScheduleRequest {
  /** Stable idempotency hint only. Core computes the authoritative cycle. */
  readonly requestKey: string;
}

export type EvolutionCuratorScheduleResult =
  | {
      readonly state: "ready" | "already_completed";
      readonly canonicalScheduleBucket: string;
      readonly canonicalEligibleAt: string;
    }
  | {
      readonly state: "no_work";
      readonly canonicalScheduleBucket: string;
      readonly canonicalEligibleAt: string;
    };

/** Idempotent materialization only; it must never claim, lease, or evaluate. */
export interface EvolutionCuratorScheduleEnqueuer {
  ensureScheduledRun(
    request: EvolutionCuratorScheduleRequest,
    signal?: AbortSignal,
  ): Promise<EvolutionCuratorScheduleResult>;
}

export interface EvolutionSchedulerRestoreState {
  readonly idleSinceMs: number | null;
  readonly lastObservedAtMs: number | null;
  readonly lastSuccessfulCuratorRunAtMs: number | null;
  readonly distillerConsecutiveFailures: number;
  readonly distillerRetryNotBeforeMs: number | null;
  readonly curatorConsecutiveFailures: number;
  readonly curatorRetryNotBeforeMs: number | null;
}

export interface EvolutionSchedulerOptions {
  /** Defaults false: constructing a scheduler never starts learning. */
  readonly enabled?: boolean;
  readonly clock: EvolutionSchedulerClock;
  readonly idleProbe: EvolutionSchedulerIdleProbe;
  readonly distillerWorker: EvolutionSchedulerWorker;
  readonly curatorWorker: EvolutionSchedulerWorker;
  readonly curatorScheduleEnqueuer: EvolutionCuratorScheduleEnqueuer;
  /** Null means there has never been a successful persistent Curator run. */
  readonly initialLastSuccessfulCuratorRunAtMs?: number | null;
  /** Host-persisted state; mutually exclusive with the legacy initial value. */
  readonly restoreState?: EvolutionSchedulerRestoreState;
  readonly curatorScheduleIntervalMs?: number;
  readonly curatorIdleRequiredMs?: number;
  readonly failureBackoffBaseMs?: number;
  readonly failureBackoffMaxMs?: number;
}

export type EvolutionSchedulerSkipReason =
  | "disabled"
  | "busy"
  | "backoff"
  | "not_idle"
  | "idle_window"
  | "not_eligible";

export type EvolutionSchedulerLaneResult =
  | { readonly state: "skipped"; readonly reason: EvolutionSchedulerSkipReason }
  | { readonly state: "idle" | "completed" | "failed" };

export interface EvolutionSchedulerTickResult {
  readonly state: "disabled" | "busy" | "completed";
  readonly atMs: number | null;
  readonly clockRollback: boolean;
  readonly curatorScheduleBucket: string | null;
  readonly distiller: EvolutionSchedulerLaneResult;
  readonly curator: EvolutionSchedulerLaneResult;
}

export interface EvolutionSchedulerSnapshot extends EvolutionSchedulerRestoreState {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly idleSinceMs: number | null;
  readonly lastObservedAtMs: number | null;
  readonly lastSuccessfulCuratorRunAtMs: number | null;
  /** Null means immediately eligible once the idle requirement is met. */
  readonly nextCuratorEligibleAtMs: number | null;
  readonly distillerConsecutiveFailures: number;
  readonly distillerRetryNotBeforeMs: number | null;
  readonly curatorConsecutiveFailures: number;
  readonly curatorRetryNotBeforeMs: number | null;
}

export interface ManualCuratorRunRecord {
  readonly mode: "run" | "dry_run";
  readonly state: "completed" | "failed";
  /** Defaults to the injected clock. */
  readonly completedAtMs?: number;
}

interface LaneBackoff {
  failures: number;
  retryNotBeforeMs: number | null;
}

interface LaneAttempt {
  readonly lane: EvolutionSchedulerLaneResult;
  readonly terminalAtMs: number;
  readonly workerResult?: EvolutionSchedulerWorkerResult;
  readonly persistentCompletedAtMs?: number;
  readonly canonicalScheduleBucket?: string;
}

const SKIPPED_DISABLED: EvolutionSchedulerLaneResult = Object.freeze({
  state: "skipped",
  reason: "disabled",
});
const SKIPPED_BUSY: EvolutionSchedulerLaneResult = Object.freeze({
  state: "skipped",
  reason: "busy",
});

export class EvolutionScheduler {
  readonly #clock: EvolutionSchedulerClock;
  readonly #idleProbe: EvolutionSchedulerIdleProbe;
  readonly #distillerWorker: EvolutionSchedulerWorker;
  readonly #curatorWorker: EvolutionSchedulerWorker;
  readonly #curatorScheduleEnqueuer: EvolutionCuratorScheduleEnqueuer;
  readonly #curatorScheduleIntervalMs: number;
  readonly #curatorIdleRequiredMs: number;
  readonly #failureBackoffBaseMs: number;
  readonly #failureBackoffMaxMs: number;

  #enabled: boolean;
  #running = false;
  #idleSinceMs: number | null = null;
  #lastObservedAtMs: number | null = null;
  #lastSuccessfulCuratorRunAtMs: number | null;
  readonly #distillerBackoff: LaneBackoff = { failures: 0, retryNotBeforeMs: null };
  readonly #curatorBackoff: LaneBackoff = { failures: 0, retryNotBeforeMs: null };

  constructor(options: EvolutionSchedulerOptions) {
    this.#clock = options.clock;
    this.#idleProbe = options.idleProbe;
    this.#distillerWorker = options.distillerWorker;
    this.#curatorWorker = options.curatorWorker;
    this.#curatorScheduleEnqueuer = options.curatorScheduleEnqueuer;
    this.#enabled = options.enabled === true;
    this.#curatorScheduleIntervalMs = positiveSafeInteger(
      options.curatorScheduleIntervalMs ?? CURATOR_SCHEDULE_INTERVAL_MS,
      "curatorScheduleIntervalMs",
    );
    this.#curatorIdleRequiredMs = nonNegativeSafeInteger(
      options.curatorIdleRequiredMs ?? CURATOR_IDLE_REQUIRED_MS,
      "curatorIdleRequiredMs",
    );
    this.#failureBackoffBaseMs = positiveSafeInteger(
      options.failureBackoffBaseMs ?? EVOLUTION_FAILURE_BACKOFF_BASE_MS,
      "failureBackoffBaseMs",
    );
    this.#failureBackoffMaxMs = positiveSafeInteger(
      options.failureBackoffMaxMs ?? EVOLUTION_FAILURE_BACKOFF_MAX_MS,
      "failureBackoffMaxMs",
    );
    if (this.#failureBackoffMaxMs < this.#failureBackoffBaseMs) {
      throw new TypeError("failureBackoffMaxMs must be at least failureBackoffBaseMs");
    }
    if (this.#failureBackoffMaxMs > this.#curatorScheduleIntervalMs) {
      throw new TypeError("failureBackoffMaxMs must not exceed the Curator schedule interval");
    }
    if (
      options.restoreState !== undefined
      && options.initialLastSuccessfulCuratorRunAtMs !== undefined
    ) {
      throw new TypeError(
        "restoreState and initialLastSuccessfulCuratorRunAtMs are mutually exclusive",
      );
    }
    if (options.restoreState !== undefined) {
      const restored = validateRestoreState(options.restoreState);
      this.#idleSinceMs = restored.idleSinceMs;
      this.#lastObservedAtMs = restored.lastObservedAtMs;
      this.#lastSuccessfulCuratorRunAtMs = restored.lastSuccessfulCuratorRunAtMs;
      this.#distillerBackoff.failures = restored.distillerConsecutiveFailures;
      this.#distillerBackoff.retryNotBeforeMs = restored.distillerRetryNotBeforeMs;
      this.#curatorBackoff.failures = restored.curatorConsecutiveFailures;
      this.#curatorBackoff.retryNotBeforeMs = restored.curatorRetryNotBeforeMs;
    } else {
      const initial = options.initialLastSuccessfulCuratorRunAtMs ?? null;
      this.#lastSuccessfulCuratorRunAtMs = initial === null
        ? null
        : nonNegativeSafeInteger(initial, "initialLastSuccessfulCuratorRunAtMs");
    }
  }

  /** Runtime feature control. Disabling also breaks the accumulated idle window. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.#idleSinceMs = null;
  }

  /**
   * Record a host-driven manual Curator terminal result.
   * Only a successful persistent `run` resets the seven-day cycle. A dry-run,
   * even when successful, deliberately changes no schedule or retry state.
   */
  recordManualCuratorRun(record: ManualCuratorRunRecord): void {
    if (record.mode !== "run" && record.mode !== "dry_run") {
      throw new TypeError("manual Curator mode must be run or dry_run");
    }
    if (record.state !== "completed" && record.state !== "failed") {
      throw new TypeError("manual Curator state must be completed or failed");
    }
    if (record.mode !== "run" || record.state !== "completed") return;
    const completedAt = record.completedAtMs === undefined
      ? readClock(this.#clock)
      : nonNegativeSafeInteger(record.completedAtMs, "completedAtMs");
    this.#recordCuratorSuccess(completedAt);
  }

  snapshot(): EvolutionSchedulerSnapshot {
    const lastSuccess = this.#lastSuccessfulCuratorRunAtMs;
    return {
      enabled: this.#enabled,
      running: this.#running,
      idleSinceMs: this.#idleSinceMs,
      lastObservedAtMs: this.#lastObservedAtMs,
      lastSuccessfulCuratorRunAtMs: lastSuccess,
      nextCuratorEligibleAtMs: lastSuccess === null
        ? null
        : safeTimestampAdd(lastSuccess, this.#curatorScheduleIntervalMs),
      distillerConsecutiveFailures: this.#distillerBackoff.failures,
      distillerRetryNotBeforeMs: this.#distillerBackoff.retryNotBeforeMs,
      curatorConsecutiveFailures: this.#curatorBackoff.failures,
      curatorRetryNotBeforeMs: this.#curatorBackoff.retryNotBeforeMs,
    };
  }

  /** Execute at most one Distiller claim and one eligible Curator claim. */
  async tick(signal?: AbortSignal): Promise<EvolutionSchedulerTickResult> {
    throwIfAborted(signal);
    if (!this.#enabled) {
      return {
        state: "disabled",
        atMs: null,
        clockRollback: false,
        curatorScheduleBucket: null,
        distiller: SKIPPED_DISABLED,
        curator: SKIPPED_DISABLED,
      };
    }
    if (this.#running) {
      return {
        state: "busy",
        atMs: this.#lastObservedAtMs,
        clockRollback: false,
        curatorScheduleBucket: null,
        distiller: SKIPPED_BUSY,
        curator: SKIPPED_BUSY,
      };
    }

    this.#running = true;
    try {
      let clockRollback = false;
      const observeBoundary = (): number => {
        const observed = this.#observeTime(readClock(this.#clock));
        clockRollback = clockRollback || observed.clockRollback;
        return observed.atMs;
      };

      let atMs = observeBoundary();
      const distillerAttempt = await this.#runLane(
        this.#distillerWorker,
        this.#distillerBackoff,
        atMs,
        observeBoundary,
        signal,
      );
      const distiller = distillerAttempt.lane;

      let idle: boolean;
      try {
        idle = await abortable(this.#idleProbe.isIdle(signal), signal);
      } catch (error) {
        // Unknown activity is not idle. Break continuity before surfacing the
        // host-probe failure so a later tick must observe a fresh full window.
        this.#idleSinceMs = null;
        throw error;
      }
      if (typeof idle !== "boolean") {
        this.#idleSinceMs = null;
        throw new TypeError("idleProbe.isIdle() must return a boolean");
      }
      // The idle observation becomes true only when the async probe resolves;
      // worker/probe latency before this boundary is never backdated as idle.
      atMs = observeBoundary();
      this.#observeIdle(atMs, idle, clockRollback);

      const curatorSkip = this.#curatorSkipReason(atMs, idle);
      let curatorScheduleBucket: string | null = null;
      let curator: EvolutionSchedulerLaneResult;
      if (curatorSkip !== null) {
        curator = { state: "skipped", reason: curatorSkip };
      } else {
        const schedule = this.#currentCuratorScheduleRequest();
        const curatorAttempt = await this.#ensureAndRunCurator(
          schedule,
          atMs,
          observeBoundary,
          signal,
        );
        curatorScheduleBucket = curatorAttempt.canonicalScheduleBucket ?? null;
        curator = curatorAttempt.lane;
        if (curator.state === "completed") {
          if (curatorAttempt.persistentCompletedAtMs !== undefined) {
            this.#recordCuratorSuccess(curatorAttempt.persistentCompletedAtMs);
          } else if (isPersistentCuratorCompletion(curatorAttempt.workerResult)) {
            this.#recordCuratorSuccess(curatorAttempt.terminalAtMs);
          }
        }
        // An actual Curator attempt is scheduler activity. An idle claim is not.
        if (curator.state === "completed" || curator.state === "failed") {
          this.#idleSinceMs = null;
        }
      }

      atMs = this.#lastObservedAtMs ?? atMs;

      return {
        state: "completed",
        atMs,
        clockRollback,
        curatorScheduleBucket,
        distiller,
        curator,
      };
    } finally {
      this.#running = false;
    }
  }

  #observeTime(now: number): { readonly atMs: number; readonly clockRollback: boolean } {
    const rollback = this.#lastObservedAtMs !== null && now < this.#lastObservedAtMs;
    if (rollback) this.#idleSinceMs = null;
    this.#lastObservedAtMs = now;
    return { atMs: now, clockRollback: rollback };
  }

  #observeIdle(now: number, idle: boolean, clockRollback: boolean): void {
    if (!idle) {
      this.#idleSinceMs = null;
      return;
    }
    if (clockRollback || this.#idleSinceMs === null || now < this.#idleSinceMs) {
      this.#idleSinceMs = now;
    }
  }

  #curatorSkipReason(now: number, idle: boolean): EvolutionSchedulerSkipReason | null {
    if (!idle) return "not_idle";
    if (
      this.#idleSinceMs === null
      || now - this.#idleSinceMs < this.#curatorIdleRequiredMs
    ) return "idle_window";

    const eligibleAt = this.#lastSuccessfulCuratorRunAtMs === null
      ? null
      : safeTimestampAdd(
          this.#lastSuccessfulCuratorRunAtMs,
          this.#curatorScheduleIntervalMs,
        );
    if (eligibleAt !== null && now < eligibleAt) return "not_eligible";
    if (
      this.#curatorBackoff.retryNotBeforeMs !== null
      && now < this.#curatorBackoff.retryNotBeforeMs
    ) return "backoff";
    return null;
  }

  #currentCuratorScheduleRequest(): EvolutionCuratorScheduleRequest {
    const eligibleAtMs = this.#lastSuccessfulCuratorRunAtMs === null
      ? null
      : safeTimestampAdd(
          this.#lastSuccessfulCuratorRunAtMs,
          this.#curatorScheduleIntervalMs,
        );
    return {
      requestKey: `scheduled:${eligibleAtMs === null ? "initial" : eligibleAtMs}`,
    };
  }

  async #ensureAndRunCurator(
    schedule: EvolutionCuratorScheduleRequest,
    startedAtMs: number,
    observeBoundary: () => number,
    signal?: AbortSignal,
  ): Promise<LaneAttempt> {
    let ensured: EvolutionCuratorScheduleResult;
    try {
      ensured = await abortable(
        this.#curatorScheduleEnqueuer.ensureScheduledRun(schedule, signal),
        signal,
      );
    } catch {
      throwIfAborted(signal);
      const terminalAtMs = monotonicTerminal(startedAtMs, observeBoundary());
      this.#recordFailure(this.#curatorBackoff, terminalAtMs);
      return { lane: { state: "failed" }, terminalAtMs };
    }
    const ensuredAtMs = monotonicTerminal(startedAtMs, observeBoundary());
    if (!isScheduleResult(ensured)) {
      this.#recordFailure(this.#curatorBackoff, ensuredAtMs);
      return { lane: { state: "failed" }, terminalAtMs: ensuredAtMs };
    }
    if (ensured.state === "no_work" || ensured.state === "already_completed") {
      resetBackoff(this.#curatorBackoff);
      return {
        lane: { state: "idle" },
        terminalAtMs: ensuredAtMs,
        ...(ensured.state === "already_completed"
          ? { canonicalScheduleBucket: ensured.canonicalScheduleBucket }
          : {}),
      };
    }
    const attempt = await this.#runLane(
      this.#curatorWorker,
      this.#curatorBackoff,
      ensuredAtMs,
      observeBoundary,
      signal,
    );
    return {
      ...attempt,
      canonicalScheduleBucket: ensured.canonicalScheduleBucket,
    };
  }

  async #runLane(
    worker: EvolutionSchedulerWorker,
    backoff: LaneBackoff,
    startedAtMs: number,
    observeBoundary: () => number,
    signal?: AbortSignal,
  ): Promise<LaneAttempt> {
    if (
      backoff.retryNotBeforeMs !== null
      && startedAtMs < backoff.retryNotBeforeMs
    ) {
      return {
        lane: { state: "skipped", reason: "backoff" },
        terminalAtMs: startedAtMs,
      };
    }
    try {
      const result = await abortable(worker.runOnce(signal), signal);
      const terminalAtMs = monotonicTerminal(startedAtMs, observeBoundary());
      if (!isWorkerResult(result)) {
        this.#recordFailure(backoff, terminalAtMs);
        return { lane: { state: "failed" }, terminalAtMs };
      }
      if (result.state === "failed") {
        this.#recordFailure(backoff, terminalAtMs);
        return { lane: { state: "failed" }, terminalAtMs, workerResult: result };
      }
      // An idle claim still proves the lane is healthy; it is not a failure and
      // must not make a later unrelated failure inherit an old exponent.
      if (result.state === "completed" || result.state === "idle") resetBackoff(backoff);
      return { lane: { state: result.state }, terminalAtMs, workerResult: result };
    } catch {
      throwIfAborted(signal);
      // Do not log or return the raw error: it may contain upstream context.
      const terminalAtMs = monotonicTerminal(startedAtMs, observeBoundary());
      this.#recordFailure(backoff, terminalAtMs);
      return { lane: { state: "failed" }, terminalAtMs };
    }
  }

  #recordFailure(backoff: LaneBackoff, now: number): void {
    backoff.failures += 1;
    const exponent = Math.min(backoff.failures - 1, 52);
    const delay = Math.min(
      this.#failureBackoffMaxMs,
      this.#failureBackoffBaseMs * 2 ** exponent,
    );
    backoff.retryNotBeforeMs = safeTimestampAdd(now, delay);
  }

  #recordCuratorSuccess(atMs: number): void {
    // A late duplicate notification must never move eligibility backwards.
    this.#lastSuccessfulCuratorRunAtMs = Math.max(
      this.#lastSuccessfulCuratorRunAtMs ?? 0,
      atMs,
    );
    resetBackoff(this.#curatorBackoff);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("self-evolution operation aborted", "AbortError");
}

async function abortable<T>(
  value: T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const promise = Promise.resolve(value);
  if (signal === undefined) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function isWorkerResult(value: unknown): value is EvolutionSchedulerWorkerResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = (value as { readonly state?: unknown }).state;
  return state === "idle" || state === "completed" || state === "failed";
}

function isScheduleResult(value: unknown): value is EvolutionCuratorScheduleResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.state === "ready"
    || row.state === "already_completed"
    || row.state === "no_work"
  )
    && typeof row.canonicalScheduleBucket === "string"
    && row.canonicalScheduleBucket.trim() !== ""
    && typeof row.canonicalEligibleAt === "string"
    && row.canonicalEligibleAt.trim() !== "";
}

/**
 * CuratorWorker exposes persistent-vs-dry completion in its nested Core result.
 * A minimal injected scheduled worker may omit that detail; such a completion
 * is persistent by construction. An explicit dry-run completion never resets
 * the seven-day schedule bucket.
 */
function isPersistentCuratorCompletion(
  result: EvolutionSchedulerWorkerResult | undefined,
): boolean {
  if (result?.state !== "completed") return false;
  const nested = result.result;
  if (nested === undefined) return true;
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return false;
  const state = (nested as { readonly state?: unknown }).state;
  return state === "completed";
}

function resetBackoff(backoff: LaneBackoff): void {
  backoff.failures = 0;
  backoff.retryNotBeforeMs = null;
}

function validateRestoreState(
  state: EvolutionSchedulerRestoreState,
): EvolutionSchedulerRestoreState {
  const nullableTimestamp = (value: number | null, label: string): number | null => value === null
    ? null
    : nonNegativeSafeInteger(value, label);
  const restored: EvolutionSchedulerRestoreState = {
    idleSinceMs: nullableTimestamp(state.idleSinceMs, "restoreState.idleSinceMs"),
    lastObservedAtMs: nullableTimestamp(
      state.lastObservedAtMs,
      "restoreState.lastObservedAtMs",
    ),
    lastSuccessfulCuratorRunAtMs: nullableTimestamp(
      state.lastSuccessfulCuratorRunAtMs,
      "restoreState.lastSuccessfulCuratorRunAtMs",
    ),
    distillerConsecutiveFailures: nonNegativeSafeInteger(
      state.distillerConsecutiveFailures,
      "restoreState.distillerConsecutiveFailures",
    ),
    distillerRetryNotBeforeMs: nullableTimestamp(
      state.distillerRetryNotBeforeMs,
      "restoreState.distillerRetryNotBeforeMs",
    ),
    curatorConsecutiveFailures: nonNegativeSafeInteger(
      state.curatorConsecutiveFailures,
      "restoreState.curatorConsecutiveFailures",
    ),
    curatorRetryNotBeforeMs: nullableTimestamp(
      state.curatorRetryNotBeforeMs,
      "restoreState.curatorRetryNotBeforeMs",
    ),
  };
  if (
    restored.idleSinceMs !== null
    && (
      restored.lastObservedAtMs === null
      || restored.idleSinceMs > restored.lastObservedAtMs
    )
  ) {
    throw new TypeError("restored idleSinceMs must not exceed lastObservedAtMs");
  }
  validateRestoredBackoff(
    restored.distillerConsecutiveFailures,
    restored.distillerRetryNotBeforeMs,
    "distiller",
  );
  validateRestoredBackoff(
    restored.curatorConsecutiveFailures,
    restored.curatorRetryNotBeforeMs,
    "curator",
  );
  return restored;
}

function validateRestoredBackoff(
  failures: number,
  retryNotBeforeMs: number | null,
  lane: string,
): void {
  if ((failures === 0) !== (retryNotBeforeMs === null)) {
    throw new TypeError(
      `restoreState ${lane} failures and retryNotBeforeMs are inconsistent`,
    );
  }
}

function readClock(clock: EvolutionSchedulerClock): number {
  return nonNegativeSafeInteger(clock.now(), "clock.now()");
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeTimestampAdd(timestamp: number, duration: number): number {
  const sum = timestamp + duration;
  if (!Number.isSafeInteger(sum)) throw new RangeError("scheduler timestamp exceeds safe range");
  return sum;
}

function monotonicTerminal(startedAtMs: number, observedAtMs: number): number {
  return Math.max(startedAtMs, observedAtMs);
}
