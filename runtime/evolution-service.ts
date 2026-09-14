/**
 * Independent Runtime host for self-evolution workers.
 *
 * It deliberately does not import RuntimeServer, Connector, governance, task
 * workspace, or project-writing capabilities. The only Runtime observation is
 * a read-only GET /tasks idle probe. Production wiring is closed by default and
 * requires dedicated evolution Core tokens plus dedicated model credentials.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { ChatPoster } from "./model-client.ts";
import { ModelClient } from "./model-client.ts";
import { EvolutionModelAdapter } from "./evolution-model-adapter.ts";
import {
  EvolutionScheduler,
  type EvolutionSchedulerClock,
  type EvolutionCuratorScheduleEnqueuer,
  type EvolutionSchedulerRestoreState,
  type EvolutionSchedulerSnapshot,
  type EvolutionSchedulerTickResult,
  type EvolutionSchedulerWorker,
  type EvolutionSchedulerWorkerResult,
} from "./evolution-scheduler.ts";
import {
  CoreCuratorEvolutionClient,
  CoreDistillerEvolutionClient,
  CoreSchedulerEvolutionClient,
  type CuratorEvolutionClient,
} from "./evolution-worker-client.ts";
import { CuratorWorker, DistillerWorker } from "./evolution-workers.ts";

export const EVOLUTION_SERVICE_STATE_SCHEMA = "evolution-service-state.v1";
export const EVOLUTION_SERVICE_DEFAULT_TICK_MS = 60_000;
export const EVOLUTION_SERVICE_DEFAULT_IO_TIMEOUT_MS = 120_000;
export const EVOLUTION_SERVICE_DEFAULT_STOP_GRACE_MS = 5_000;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_TASKS_RESPONSE_BYTES = 5 * 1024 * 1024;

const RESTORE_KEYS = [
  "curatorConsecutiveFailures",
  "curatorRetryNotBeforeMs",
  "distillerConsecutiveFailures",
  "distillerRetryNotBeforeMs",
  "idleSinceMs",
  "lastObservedAtMs",
  "lastSuccessfulCuratorRunAtMs",
] as const;

const NON_BUSY_TASK_STATUSES = new Set([
  "idle",
  "awaiting_user",
  "awaiting_approval",
  "succeeded",
  "failed",
  "fail_closed",
  "interrupted",
]);

export interface EvolutionServiceStateStore {
  load(signal?: AbortSignal): Promise<EvolutionSchedulerRestoreState | null>;
  save(snapshot: EvolutionSchedulerSnapshot, signal?: AbortSignal): Promise<void>;
}

export interface EvolutionServiceFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface EvolutionServiceTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface EvolutionServiceScheduler {
  tick(signal?: AbortSignal): Promise<EvolutionSchedulerTickResult>;
  snapshot(): EvolutionSchedulerSnapshot;
  recordManualCuratorRun(record: {
    readonly mode: "run" | "dry_run";
    readonly state: "completed" | "failed";
    readonly completedAtMs?: number;
  }): void;
}

export interface EvolutionServiceOptions {
  readonly enabled?: boolean;
  readonly tickIntervalMs?: number;
  readonly clock: EvolutionSchedulerClock;
  readonly manualCuratorWorker: EvolutionSchedulerWorker;
  readonly schedulerFactory: (
    restoreState: EvolutionSchedulerRestoreState | undefined,
  ) => EvolutionServiceScheduler;
  readonly stateStore: EvolutionServiceStateStore;
  readonly timer?: EvolutionServiceTimer;
  readonly ioTimeoutMs?: number;
  readonly stopGraceMs?: number;
  /** Receives stable messages only. Raw errors and credentials are never passed. */
  readonly reportError?: (message: string) => void;
}

export interface EvolutionServiceTickResult {
  readonly state: "disabled" | "completed";
  readonly manualCurator: { readonly state: "idle" | "completed" | "failed" };
  readonly scheduled: EvolutionSchedulerTickResult | null;
}

export type EvolutionServiceSignal = "SIGINT" | "SIGTERM";

export interface EvolutionServiceSignalHost {
  once(signal: EvolutionServiceSignal, listener: () => void): void;
  off(signal: EvolutionServiceSignal, listener: () => void): void;
}

export interface EvolutionServiceMainController {
  readonly service: EvolutionService;
  stop(): Promise<void>;
}

export interface EvolutionServiceMainOptions {
  readonly env?: Record<string, string | undefined>;
  readonly createService?: (
    env: Record<string, string | undefined>,
  ) => EvolutionService | Promise<EvolutionService>;
  readonly signalHost?: EvolutionServiceSignalHost;
  readonly reportStartupError?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
}

export interface EvolutionServiceFactoryOverrides {
  /** Typed claim-manual worker factory; receives curator scope only. */
  readonly manualCuratorWorkerFactory?: (
    context: EvolutionCuratorWorkerFactoryContext,
  ) => EvolutionSchedulerWorker;
  /** Typed claim-scheduled worker factory; receives curator scope only. */
  readonly scheduledCuratorWorkerFactory?: (
    context: EvolutionCuratorWorkerFactoryContext,
  ) => EvolutionSchedulerWorker;
  /** Ensure-only factory; receives scheduler scope and no curator credential. */
  readonly scheduledRunEnqueuerFactory?: (
    context: EvolutionScheduleEnqueuerFactoryContext,
  ) => EvolutionCuratorScheduleEnqueuer;
  readonly fetchImpl?: EvolutionServiceFetch;
  readonly modelPost?: ChatPoster;
  readonly clock?: EvolutionSchedulerClock;
  readonly timer?: EvolutionServiceTimer;
  readonly stateStore?: EvolutionServiceStateStore;
  readonly reportError?: (message: string) => void;
  /** Tests may shorten host I/O and graceful-stop deadlines. */
  readonly ioTimeoutMs?: number;
  readonly stopGraceMs?: number;
  /** Tests may shorten frozen durations without adding production env knobs. */
  readonly schedulerTiming?: {
    readonly curatorScheduleIntervalMs?: number;
    readonly curatorIdleRequiredMs?: number;
    readonly failureBackoffBaseMs?: number;
    readonly failureBackoffMaxMs?: number;
  };
}

export interface EvolutionCuratorWorkerFactoryContext {
  readonly coreBaseUrl: string;
  readonly curatorToken: string;
  readonly fetchImpl: EvolutionServiceFetch;
  readonly model: EvolutionModelAdapter;
  readonly workerId: string;
  readonly ioTimeoutMs: number;
}

export interface EvolutionScheduleEnqueuerFactoryContext {
  readonly coreBaseUrl: string;
  readonly schedulerToken: string;
  readonly fetchImpl: EvolutionServiceFetch;
  readonly ioTimeoutMs: number;
}

export class EvolutionServiceStateError extends Error {
  readonly code = "INVALID_EVOLUTION_SERVICE_STATE";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "EvolutionServiceStateError";
  }
}

export class FileEvolutionServiceStateStore implements EvolutionServiceStateStore {
  constructor(readonly path: string) {
    if (typeof path !== "string" || path.trim() === "") {
      throw new TypeError("evolution state path must be a non-empty string");
    }
  }

  async load(signal?: AbortSignal): Promise<EvolutionSchedulerRestoreState | null> {
    let text: string;
    try {
      text = await readFile(this.path, { encoding: "utf8", signal });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new EvolutionServiceStateError("unable to read evolution scheduler state");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
      throw new EvolutionServiceStateError("evolution scheduler state exceeds byte limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new EvolutionServiceStateError("evolution scheduler state is not strict JSON");
    }
    const envelope = strictRecord(parsed, "state envelope");
    exactKeys(envelope, ["schema", "state"], "state envelope");
    if (envelope.schema !== EVOLUTION_SERVICE_STATE_SCHEMA) {
      throw new EvolutionServiceStateError("evolution scheduler state schema is unsupported");
    }
    return parseRestoreState(envelope.state);
  }

  async save(snapshot: EvolutionSchedulerSnapshot, signal?: AbortSignal): Promise<void> {
    const state = restoreStateFromSnapshot(snapshot);
    const body = JSON.stringify({
      schema: EVOLUTION_SERVICE_STATE_SCHEMA,
      state,
    }, null, 2) + "\n";
    if (Buffer.byteLength(body, "utf8") > MAX_STATE_BYTES) {
      throw new EvolutionServiceStateError("evolution scheduler state exceeds byte limit");
    }
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, signal });
      await rename(temporaryPath, this.path);
    } catch {
      await unlink(temporaryPath).catch(() => {});
      throw new EvolutionServiceStateError("unable to atomically persist evolution scheduler state");
    }
  }
}

export class RuntimeTasksIdleProbe {
  readonly #tasksUrl: string;
  readonly #fetch: EvolutionServiceFetch;
  readonly #timeoutMs: number;

  constructor(
    runtimeBaseUrl: string,
    fetchImpl: EvolutionServiceFetch = fetch,
    timeoutMs = EVOLUTION_SERVICE_DEFAULT_IO_TIMEOUT_MS,
  ) {
    this.#tasksUrl = `${absoluteHttpUrl(runtimeBaseUrl, "runtimeBaseUrl")}/tasks`;
    this.#fetch = fetchImpl;
    this.#timeoutMs = positiveSafeInteger(timeoutMs, "idle probe timeoutMs");
  }

  async isIdle(signal?: AbortSignal): Promise<boolean> {
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await withAbortTimeout(async (requestSignal) => {
        const next = await abortable(this.#fetch(this.#tasksUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: requestSignal,
        }), requestSignal);
        return {
          response: next,
          text: await readResponseTextWithByteLimit(
            next,
            MAX_TASKS_RESPONSE_BYTES,
            requestSignal,
          ),
        };
      },
        this.#timeoutMs,
        signal,
      ));
    } catch {
      throw new Error("Runtime task activity probe failed");
    }
    if (!response.ok) throw new Error("Runtime task activity probe failed");
    if (Buffer.byteLength(text, "utf8") > MAX_TASKS_RESPONSE_BYTES) {
      throw new Error("Runtime task activity probe returned an oversized response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Runtime task activity probe returned malformed JSON");
    }
    const envelope = strictRecordGeneric(parsed, "Runtime tasks response");
    if (!Array.isArray(envelope.agents)) {
      throw new Error("Runtime task activity probe returned malformed agents");
    }
    for (const raw of envelope.agents) {
      const agent = strictRecordGeneric(raw, "Runtime task row");
      if (agent.busy === true) return false;
      if (agent.busy !== undefined && typeof agent.busy !== "boolean") {
        throw new Error("Runtime task activity probe returned malformed busy state");
      }
      if (agent.status === "running" || agent.status === "busy") return false;
      if (typeof agent.status !== "string" || !NON_BUSY_TASK_STATUSES.has(agent.status)) {
        throw new Error("Runtime task activity probe returned unknown task status");
      }
    }
    return true;
  }
}

const DEFAULT_TIMER: EvolutionServiceTimer = {
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export class EvolutionService {
  readonly enabled: boolean;
  readonly #tickIntervalMs: number;
  readonly #clock: EvolutionSchedulerClock;
  readonly #manualCuratorWorker: EvolutionSchedulerWorker;
  readonly #schedulerFactory: EvolutionServiceOptions["schedulerFactory"];
  readonly #stateStore: EvolutionServiceStateStore;
  readonly #timer: EvolutionServiceTimer;
  readonly #ioTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #reportError: (message: string) => void;

  #scheduler: EvolutionServiceScheduler | null = null;
  #timerHandle: unknown;
  #started = false;
  #stopping = false;
  #inFlight: Promise<EvolutionServiceTickResult> | null = null;
  #tickAbortController: AbortController | null = null;
  #persistInFlight: Promise<void> | null = null;

  constructor(options: EvolutionServiceOptions) {
    this.enabled = options.enabled === true;
    this.#tickIntervalMs = positiveSafeInteger(
      options.tickIntervalMs ?? EVOLUTION_SERVICE_DEFAULT_TICK_MS,
      "tickIntervalMs",
    );
    this.#clock = options.clock;
    this.#manualCuratorWorker = options.manualCuratorWorker;
    this.#schedulerFactory = options.schedulerFactory;
    this.#stateStore = options.stateStore;
    this.#timer = options.timer ?? DEFAULT_TIMER;
    this.#ioTimeoutMs = positiveSafeInteger(
      options.ioTimeoutMs ?? EVOLUTION_SERVICE_DEFAULT_IO_TIMEOUT_MS,
      "ioTimeoutMs",
    );
    this.#stopGraceMs = positiveSafeInteger(
      options.stopGraceMs ?? EVOLUTION_SERVICE_DEFAULT_STOP_GRACE_MS,
      "stopGraceMs",
    );
    this.#reportError = options.reportError ?? (() => {
      process.stderr.write("[evolution-service] background tick failed\n");
    });
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("evolution service is already started");
    this.#started = true;
    if (!this.enabled) return;
    try {
      const restored = await withAbortTimeout(
        (signal) => this.#stateStore.load(signal),
        this.#ioTimeoutMs,
      );
      this.#scheduler = this.#schedulerFactory(restored ?? undefined);
      this.#timerHandle = this.#timer.setInterval(() => {
        void this.tickNow().catch(() => {
          try {
            this.#reportError("[evolution-service] background tick failed");
          } catch {
            // Observability must not convert a handled background failure into
            // an unhandled rejection or expose the original error.
          }
        });
      }, this.#tickIntervalMs);
    } catch (error) {
      this.#started = false;
      this.#scheduler = null;
      throw error;
    }
  }

  tickNow(): Promise<EvolutionServiceTickResult> {
    if (!this.#started) return Promise.reject(new Error("evolution service is not started"));
    if (!this.enabled) {
      return Promise.resolve({
        state: "disabled",
        manualCurator: { state: "idle" },
        scheduled: null,
      });
    }
    if (this.#stopping) return Promise.reject(new Error("evolution service is stopping"));
    if (this.#inFlight !== null) return this.#inFlight;

    const controller = new AbortController();
    this.#tickAbortController = controller;
    const run = this.#executeTick(controller.signal).finally(() => {
      if (this.#inFlight === run) this.#inFlight = null;
      if (this.#tickAbortController === controller) this.#tickAbortController = null;
    });
    this.#inFlight = run;
    return run;
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopping = true;
    const scheduler = this.#scheduler;
    const shutdownDeadlineMs = Date.now() + this.#stopGraceMs;
    if (this.#timerHandle !== undefined) {
      this.#timer.clearInterval(this.#timerHandle);
      this.#timerHandle = undefined;
    }
    this.#tickAbortController?.abort(new DOMException(
      "evolution service is stopping",
      "AbortError",
    ));
    try {
      if (this.#inFlight !== null) {
        await withDeadline(
          this.#inFlight.catch(() => {}),
          remainingDeadlineMs(shutdownDeadlineMs),
          "evolution service stop grace expired",
        ).catch(() => {});
      }
      // A tick may be detached because one of its dependencies ignored
      // cancellation. Persist the scheduler's latest observable state on an
      // independent I/O signal so the aborted tick signal cannot discard
      // backoff or fail-closed idle facts. Coalescing with the tick's finally
      // keeps state-store writes serial and prevents an older snapshot from
      // racing a shutdown snapshot.
      if (scheduler !== null) {
        const flush = this.#persistSchedulerState(scheduler).catch(() => {});
        await withDeadline(
          flush,
          remainingDeadlineMs(shutdownDeadlineMs),
          "evolution service shutdown state flush expired",
        ).catch(() => {});
      }
    } finally {
      this.#scheduler = null;
      this.#started = false;
      this.#stopping = false;
      this.#inFlight = null;
      this.#tickAbortController = null;
    }
  }

  async #executeTick(signal: AbortSignal): Promise<EvolutionServiceTickResult> {
    const scheduler = this.#scheduler;
    if (scheduler === null) throw new Error("evolution scheduler is unavailable");

    const manualCurator = await this.#runManualCurator(scheduler, signal);
    let scheduled: EvolutionSchedulerTickResult | null = null;
    try {
      scheduled = await abortable(scheduler.tick(signal), signal);
      return { state: "completed", manualCurator, scheduled };
    } finally {
      // Includes idle-probe and scheduler failures: the fail-closed idle reset
      // and all retry facts must survive a restart.
      await this.#persistSchedulerState(scheduler);
    }
  }

  #persistSchedulerState(scheduler: EvolutionServiceScheduler): Promise<void> {
    if (this.#persistInFlight !== null) return this.#persistInFlight;
    const snapshot = scheduler.snapshot();
    const persist = withAbortTimeout(
      (saveSignal) => this.#stateStore.save(snapshot, saveSignal),
      this.#ioTimeoutMs,
    ).finally(() => {
      if (this.#persistInFlight === persist) this.#persistInFlight = null;
    });
    this.#persistInFlight = persist;
    return persist;
  }

  async #runManualCurator(
    scheduler: EvolutionServiceScheduler,
    signal: AbortSignal,
  ): Promise<{ readonly state: "idle" | "completed" | "failed" }> {
    let result: EvolutionSchedulerWorkerResult;
    try {
      result = await abortable(this.#manualCuratorWorker.runOnce(signal), signal);
    } catch {
      throwIfAborted(signal);
      return { state: "failed" };
    }
    if (!isWorkerResult(result)) return { state: "failed" };
    if (result.state !== "completed") return { state: result.state };

    const mode = completedCuratorMode(result);
    if (mode === null) return { state: "failed" };
    scheduler.recordManualCuratorRun({
      mode,
      state: "completed",
      completedAtMs: readClock(this.#clock),
    });
    return { state: "completed" };
  }
}

const PROCESS_SIGNAL_HOST: EvolutionServiceSignalHost = {
  once(signal, listener) { process.once(signal, listener); },
  off(signal, listener) { process.off(signal, listener); },
};

/** Start the process lifecycle and install idempotent graceful-stop handlers. */
export async function startEvolutionServiceMain(
  options: EvolutionServiceMainOptions = {},
): Promise<EvolutionServiceMainController> {
  const env = options.env ?? process.env;
  const service = await (options.createService ?? createEvolutionServiceFromEnv)(env);
  await service.start();
  const signals = options.signalHost ?? PROCESS_SIGNAL_HOST;
  let stopping: Promise<void> | null = null;

  const removeSignals = (): void => {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  };
  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    removeSignals();
    stopping = service.stop();
    return stopping;
  };
  const onSignal = (): void => { void stop(); };
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);
  return { service, stop };
}

/** Executable wrapper: startup diagnostics are intentionally constant. */
export async function runEvolutionServiceEntrypoint(
  options: EvolutionServiceMainOptions = {},
): Promise<EvolutionServiceMainController | null> {
  try {
    return await startEvolutionServiceMain(options);
  } catch {
    const report = options.reportStartupError ?? ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
    try {
      report("[evolution-service] startup failed");
    } catch {
      // Reporting failure cannot reveal the original error or change shutdown.
    }
    (options.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
    return null;
  }
}

/**
 * Production assembly with three authority-specific lanes. Factory overrides
 * remain test seams only; the default path constructs the typed Distiller,
 * Curator, and Scheduler clients directly from dedicated credentials.
 */
export function createEvolutionServiceFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: EvolutionServiceFactoryOverrides = {},
): EvolutionService {
  const enabled = env.SYNTHIA_FEATURE_SELF_EVOLUTION === "1"
    || env.SYNTHIA_FEATURE_SELF_EVOLUTION === "true";
  const clock = overrides.clock ?? { now: () => Date.now() };
  const disabledStateStore = overrides.stateStore
    ?? new FileEvolutionServiceStateStore(stateFileFromEnv(env));
  if (!enabled) {
    return new EvolutionService({
      enabled: false,
      clock,
      manualCuratorWorker: { async runOnce() { return { state: "idle" }; } },
      schedulerFactory: () => disabledScheduler(),
      stateStore: disabledStateStore,
      timer: overrides.timer,
      reportError: overrides.reportError,
    });
  }

  const distillerToken = requiredEnv(env, "SYNTHIA_EVOLUTION_DISTILLER_TOKEN");
  const curatorToken = requiredEnv(env, "SYNTHIA_EVOLUTION_CURATOR_TOKEN");
  const schedulerToken = requiredEnv(env, "SYNTHIA_EVOLUTION_SCHEDULER_TOKEN");
  const modelUrl = requiredEnv(env, "SYNTHIA_EVOLUTION_MODEL_URL");
  const modelKey = requiredEnv(env, "SYNTHIA_EVOLUTION_MODEL_KEY");
  const modelId = requiredEnv(env, "SYNTHIA_EVOLUTION_MODEL_NAME");
  const ioTimeoutMs = overrides.ioTimeoutMs ?? optionalPositiveInteger(
    env.SYNTHIA_EVOLUTION_IO_TIMEOUT_MS,
    EVOLUTION_SERVICE_DEFAULT_IO_TIMEOUT_MS,
  );
  const stopGraceMs = overrides.stopGraceMs ?? optionalPositiveInteger(
    env.SYNTHIA_EVOLUTION_STOP_GRACE_MS,
    EVOLUTION_SERVICE_DEFAULT_STOP_GRACE_MS,
  );
  const coreBaseUrl = env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:8787";
  const runtimeBaseUrl = env.SYNTHIA_RUNTIME_URL
    ?? `http://127.0.0.1:${env.SYNTHIA_RUNTIME_PORT ?? "8790"}`;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const distillerClient = new CoreDistillerEvolutionClient({
    baseUrl: coreBaseUrl,
    distillerToken,
    fetchImpl: fetchImpl as typeof fetch,
    requestTimeoutMs: ioTimeoutMs,
  });
  const model = new EvolutionModelAdapter(new ModelClient({
    baseUrl: absoluteHttpUrl(modelUrl, "SYNTHIA_EVOLUTION_MODEL_URL"),
    apiKey: modelKey,
    model: modelId,
    protocol: "json",
    timeoutMs: optionalPositiveInteger(env.SYNTHIA_EVOLUTION_MODEL_TIMEOUT_MS, 120_000),
    networkRetries: optionalNonNegativeInteger(
      env.SYNTHIA_EVOLUTION_MODEL_NETWORK_RETRIES,
      2,
    ),
    chatMaxTokens: optionalPositiveInteger(
      env.SYNTHIA_EVOLUTION_MODEL_MAX_TOKENS,
      16_384,
    ),
    ...(env.SYNTHIA_EVOLUTION_MODEL_REASONING_EFFORT?.trim()
      ? { reasoningEffort: env.SYNTHIA_EVOLUTION_MODEL_REASONING_EFFORT.trim() }
      : {}),
    ...(overrides.modelPost === undefined ? {} : { post: overrides.modelPost }),
  }), modelId);
  const distillerWorker = new DistillerWorker(distillerClient, model, {
    workerId: env.SYNTHIA_EVOLUTION_DISTILLER_WORKER_ID ?? "runtime-evolution-distiller",
  });
  const curatorContext = {
    coreBaseUrl: absoluteHttpUrl(coreBaseUrl, "SYNTHIA_CORE_URL"),
    curatorToken,
    fetchImpl,
    model,
    ioTimeoutMs,
  };
  const curatorClient = new CoreCuratorEvolutionClient({
    baseUrl: curatorContext.coreBaseUrl,
    curatorToken,
    fetchImpl: fetchImpl as typeof fetch,
    requestTimeoutMs: ioTimeoutMs,
  });
  const manualContext = {
    ...curatorContext,
    workerId: env.SYNTHIA_EVOLUTION_CURATOR_MANUAL_WORKER_ID
      ?? "runtime-evolution-curator-manual",
  };
  const scheduledContext = {
    ...curatorContext,
    workerId: env.SYNTHIA_EVOLUTION_CURATOR_SCHEDULED_WORKER_ID
      ?? "runtime-evolution-curator-scheduled",
  };
  const manualCuratorWorker = overrides.manualCuratorWorkerFactory?.(manualContext)
    ?? schedulerCuratorWorker(
      new CuratorWorker(
        curatorLaneClient(curatorClient, "manual"),
        model,
        {
          workerId: manualContext.workerId,
        },
      ),
    );
  const scheduledCuratorLane = overrides.scheduledCuratorWorkerFactory?.(scheduledContext)
    ?? schedulerCuratorWorker(
      new CuratorWorker(
        curatorLaneClient(curatorClient, "scheduled"),
        model,
        {
          workerId: scheduledContext.workerId,
        },
      ),
    );
  const schedulerContext = {
    coreBaseUrl: curatorContext.coreBaseUrl,
    schedulerToken,
    fetchImpl,
    ioTimeoutMs,
  };
  const scheduledRunEnqueuer = overrides.scheduledRunEnqueuerFactory?.(schedulerContext)
    ?? coreScheduleEnqueuer(new CoreSchedulerEvolutionClient({
      baseUrl: schedulerContext.coreBaseUrl,
      schedulerToken,
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: ioTimeoutMs,
    }));
  const distillerLane: EvolutionSchedulerWorker = {
    async runOnce(signal) {
      const result = await distillerWorker.runOnce(signal);
      if (result.state === "idle") return { state: "idle" };
      if (result.state === "failed") return { state: "failed" };
      return { state: "completed", result: result.result };
    },
  };
  const idleProbe = new RuntimeTasksIdleProbe(runtimeBaseUrl, fetchImpl, ioTimeoutMs);
  const stateStore = overrides.stateStore
    ?? new FileEvolutionServiceStateStore(stateFileFromEnv(env));

  return new EvolutionService({
    enabled: true,
    tickIntervalMs: optionalPositiveInteger(
      env.SYNTHIA_EVOLUTION_TICK_MS,
      EVOLUTION_SERVICE_DEFAULT_TICK_MS,
    ),
    clock,
    manualCuratorWorker,
    stateStore,
    timer: overrides.timer,
    reportError: overrides.reportError,
    ioTimeoutMs,
    stopGraceMs,
    schedulerFactory: (restoreState) => new EvolutionScheduler({
      enabled: true,
      clock,
      idleProbe,
      distillerWorker: distillerLane,
      curatorWorker: scheduledCuratorLane,
      curatorScheduleEnqueuer: scheduledRunEnqueuer,
      ...(restoreState === undefined ? {} : { restoreState }),
      ...overrides.schedulerTiming,
    }),
  });
}

function curatorLaneClient(
  client: CoreCuratorEvolutionClient,
  lane: "manual" | "scheduled",
): CuratorEvolutionClient {
  return {
    claim: (input, signal) => lane === "manual"
      ? client.claimManual(input, signal)
      : client.claimScheduled(input, signal),
    renewLease: (runId, input, signal) => client.renewLease(runId, input, signal),
    complete: (runId, input, signal) => client.complete(runId, input, signal),
    fail: (runId, input, signal) => client.fail(runId, input, signal),
  };
}

function schedulerCuratorWorker(worker: CuratorWorker): EvolutionSchedulerWorker {
  return {
    async runOnce(signal) {
      const result = await worker.runOnce(signal);
      if (result.state === "idle") return { state: "idle" };
      if (result.state === "failed") return { state: "failed" };
      return { state: "completed", result: result.result };
    },
  };
}

function coreScheduleEnqueuer(
  client: CoreSchedulerEvolutionClient,
): EvolutionCuratorScheduleEnqueuer {
  return {
    async ensureScheduledRun(request, signal) {
      const result = await client.ensureScheduled({ request_key: request.requestKey }, signal);
      const canonical = {
        canonicalScheduleBucket: result.schedule_bucket,
        canonicalEligibleAt: result.eligible_at,
      };
      if (result.state === "queued") return { state: "ready", ...canonical };
      if (result.state === "already_completed") {
        return { state: "already_completed", ...canonical };
      }
      return { state: "no_work", ...canonical };
    },
  };
}

function disabledScheduler(): EvolutionServiceScheduler {
  const snapshot: EvolutionSchedulerSnapshot = {
    enabled: false,
    running: false,
    idleSinceMs: null,
    lastObservedAtMs: null,
    lastSuccessfulCuratorRunAtMs: null,
    nextCuratorEligibleAtMs: null,
    distillerConsecutiveFailures: 0,
    distillerRetryNotBeforeMs: null,
    curatorConsecutiveFailures: 0,
    curatorRetryNotBeforeMs: null,
  };
  return {
    async tick() {
      return {
        state: "disabled",
        atMs: null,
        clockRollback: false,
        curatorScheduleBucket: null,
        distiller: { state: "skipped", reason: "disabled" },
        curator: { state: "skipped", reason: "disabled" },
      };
    },
    snapshot: () => snapshot,
    recordManualCuratorRun: () => {},
  };
}

function restoreStateFromSnapshot(
  snapshot: EvolutionSchedulerSnapshot,
): EvolutionSchedulerRestoreState {
  return {
    idleSinceMs: snapshot.idleSinceMs,
    lastObservedAtMs: snapshot.lastObservedAtMs,
    lastSuccessfulCuratorRunAtMs: snapshot.lastSuccessfulCuratorRunAtMs,
    distillerConsecutiveFailures: snapshot.distillerConsecutiveFailures,
    distillerRetryNotBeforeMs: snapshot.distillerRetryNotBeforeMs,
    curatorConsecutiveFailures: snapshot.curatorConsecutiveFailures,
    curatorRetryNotBeforeMs: snapshot.curatorRetryNotBeforeMs,
  };
}

function parseRestoreState(value: unknown): EvolutionSchedulerRestoreState {
  const row = strictRecord(value, "scheduler state");
  exactKeys(row, RESTORE_KEYS, "scheduler state");
  const timestamp = (key: typeof RESTORE_KEYS[number]): number | null => {
    const item = row[key];
    if (item === null) return null;
    return nonNegativeSafeInteger(item, `scheduler state.${key}`);
  };
  return {
    idleSinceMs: timestamp("idleSinceMs"),
    lastObservedAtMs: timestamp("lastObservedAtMs"),
    lastSuccessfulCuratorRunAtMs: timestamp("lastSuccessfulCuratorRunAtMs"),
    distillerConsecutiveFailures: nonNegativeSafeInteger(
      row.distillerConsecutiveFailures,
      "scheduler state.distillerConsecutiveFailures",
    ),
    distillerRetryNotBeforeMs: timestamp("distillerRetryNotBeforeMs"),
    curatorConsecutiveFailures: nonNegativeSafeInteger(
      row.curatorConsecutiveFailures,
      "scheduler state.curatorConsecutiveFailures",
    ),
    curatorRetryNotBeforeMs: timestamp("curatorRetryNotBeforeMs"),
  };
}

function completedCuratorMode(
  result: EvolutionSchedulerWorkerResult,
): "run" | "dry_run" | null {
  if (result.state !== "completed") return null;
  const nested = result.result;
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return null;
  const state = (nested as { readonly state?: unknown }).state;
  if (state === "completed") return "run";
  if (state === "dry_run_complete") return "dry_run";
  return null;
}

function isWorkerResult(value: unknown): value is EvolutionSchedulerWorkerResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = (value as { readonly state?: unknown }).state;
  return state === "idle" || state === "completed" || state === "failed";
}

function stateFileFromEnv(env: Record<string, string | undefined>): string {
  if (env.SYNTHIA_EVOLUTION_STATE_FILE?.trim()) {
    return env.SYNTHIA_EVOLUTION_STATE_FILE.trim();
  }
  return join(env.SYNTHIA_RUNS_DIR?.trim() || ".runs", "evolution-scheduler-state.json");
}

function requiredEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`evolution service requires ${key}`);
  }
  return value.trim();
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return positiveSafeInteger(Number(value), "evolution service numeric environment value");
}

function optionalNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return nonNegativeSafeInteger(Number(value), "evolution service numeric environment value");
}

function readClock(clock: EvolutionSchedulerClock): number {
  return nonNegativeSafeInteger(clock.now(), "evolution service clock");
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvolutionServiceStateError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function remainingDeadlineMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

function absoluteHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must use http or https`);
  }
  return url.toString().replace(/\/+$/, "");
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    return strictRecordGeneric(value, label);
  } catch {
    throw new EvolutionServiceStateError(`${label} must be an object`);
  }
}

function strictRecordGeneric(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(row).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw new EvolutionServiceStateError(`${label} has unexpected fields`);
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("self-evolution operation aborted", "AbortError");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function readResponseTextWithByteLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel("response exceeds byte limit").catch(() => {});
        throw new Error("response exceeds byte limit");
      }
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException(
    "self-evolution I/O timed out",
    "TimeoutError",
  )), timeoutMs);
  try {
    return await abortable(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

if (import.meta.main) {
  await runEvolutionServiceEntrypoint();
}
