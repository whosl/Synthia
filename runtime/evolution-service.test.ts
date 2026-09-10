import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EVOLUTION_SERVICE_STATE_SCHEMA,
  EvolutionService,
  EvolutionServiceStateError,
  FileEvolutionServiceStateStore,
  RuntimeTasksIdleProbe,
  createEvolutionServiceFromEnv,
  runEvolutionServiceEntrypoint,
  startEvolutionServiceMain,
  type EvolutionServiceFetch,
  type EvolutionServiceScheduler,
  type EvolutionServiceSignal,
  type EvolutionServiceSignalHost,
  type EvolutionServiceStateStore,
  type EvolutionServiceTimer,
} from "./evolution-service.ts";
import {
  EvolutionScheduler,
  type EvolutionCuratorScheduleEnqueuer,
  type EvolutionSchedulerRestoreState,
  type EvolutionSchedulerSnapshot,
  type EvolutionSchedulerTickResult,
  type EvolutionSchedulerWorker,
} from "./evolution-scheduler.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const temporaryDirectories: string[] = [];

function readyScheduleResult(): Awaited<ReturnType<EvolutionCuratorScheduleEnqueuer["ensureScheduledRun"]>> {
  return {
    state: "ready",
    canonicalScheduleBucket: "core:canonical-cycle",
    canonicalEligibleAt: "2026-08-26T00:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

class FakeClock {
  constructor(public nowMs = 0) {}
  now(): number { return this.nowMs; }
}

class FakeTimer implements EvolutionServiceTimer {
  callback: (() => void) | null = null;
  intervalMs: number | null = null;
  clearCalls = 0;

  setInterval(callback: () => void, intervalMs: number): unknown {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return { timer: "fake" };
  }

  clearInterval(): void {
    this.clearCalls += 1;
    this.callback = null;
  }

  fire(): void {
    if (this.callback === null) throw new Error("timer is not armed");
    this.callback();
  }
}

class FakeSignalHost implements EvolutionServiceSignalHost {
  readonly listeners = new Map<EvolutionServiceSignal, () => void>();
  readonly removed: EvolutionServiceSignal[] = [];

  once(signal: EvolutionServiceSignal, listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  off(signal: EvolutionServiceSignal, listener: () => void): void {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
    this.removed.push(signal);
  }

  emit(signal: EvolutionServiceSignal): void {
    const listener = this.listeners.get(signal);
    if (listener === undefined) throw new Error(`${signal} listener is not installed`);
    this.listeners.delete(signal);
    listener();
  }
}

class ObservedEvolutionService extends EvolutionService {
  startCalls = 0;
  stopCalls = 0;

  constructor() {
    super({
      enabled: false,
      clock: new FakeClock(),
      manualCuratorWorker: new ScriptedWorker(),
      schedulerFactory: () => { throw new Error("disabled service must not construct scheduler"); },
      stateStore: new MemoryStateStore(),
      timer: new FakeTimer(),
    });
  }

  override async start(): Promise<void> {
    this.startCalls += 1;
    await super.start();
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    await super.stop();
  }
}

class MemoryStateStore implements EvolutionServiceStateStore {
  loadCalls = 0;
  saves: EvolutionSchedulerSnapshot[] = [];

  constructor(public restored: EvolutionSchedulerRestoreState | null = null) {}

  async load(): Promise<EvolutionSchedulerRestoreState | null> {
    this.loadCalls += 1;
    return this.restored;
  }

  async save(snapshot: EvolutionSchedulerSnapshot): Promise<void> {
    this.saves.push(structuredClone(snapshot));
  }
}

class ScriptedWorker implements EvolutionSchedulerWorker {
  calls = 0;
  readonly #results: Array<Awaited<ReturnType<EvolutionSchedulerWorker["runOnce"]>> | Error>;

  constructor(
    results: Array<Awaited<ReturnType<EvolutionSchedulerWorker["runOnce"]>> | Error> = [
      { state: "idle" },
    ],
  ) {
    this.#results = [...results];
  }

  async runOnce(): ReturnType<EvolutionSchedulerWorker["runOnce"]> {
    this.calls += 1;
    const next = this.#results.shift() ?? { state: "idle" };
    if (next instanceof Error) throw next;
    return next;
  }
}

const EMPTY_SNAPSHOT: EvolutionSchedulerSnapshot = {
  enabled: true,
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

const ENABLED_ENV: Record<string, string> = {
  SYNTHIA_FEATURE_SELF_EVOLUTION: "true",
  SYNTHIA_CORE_URL: "http://core.local",
  SYNTHIA_RUNTIME_URL: "http://runtime.local",
  SYNTHIA_EVOLUTION_DISTILLER_TOKEN: "distiller-secret-only",
  SYNTHIA_EVOLUTION_CURATOR_TOKEN: "curator-secret-only",
  SYNTHIA_EVOLUTION_SCHEDULER_TOKEN: "scheduler-secret-only",
  SYNTHIA_EVOLUTION_MODEL_URL: "http://evolution-model.local/v1",
  SYNTHIA_EVOLUTION_MODEL_KEY: "evolution-model-secret-only",
  SYNTHIA_EVOLUTION_MODEL_NAME: "evolution-model-v1",
};

function ok(data: unknown): Response {
  return Response.json({ data, correlation_id: "corr-service-test" });
}

function nullClaim(schema: "distillation-claim.v1" | "curator-claim.v1"): Response {
  return ok({ schema, run: null });
}

function curatorClaim(
  runId: string,
  mode: "run" | "dry_run",
  scheduleBucket: string,
): Response {
  return ok({
    schema: "curator-claim.v1",
    run: {
      run_id: runId,
      mode,
      state: "running",
      attempt: 1,
      lease_token: `lease-${runId}`,
      lease_expires_at: "2026-08-27T00:00:00.000Z",
      schedule_bucket: scheduleBucket,
      eval_recovery: mode === "dry_run" ? {
        budget_started_at: null,
        deadline_at: null,
        unknown_effect_latched_at: null,
        jobs: [],
      } : {
        budget_started_at: "2026-08-26T22:00:00.000Z",
        deadline_at: "2026-08-27T00:00:00.000Z",
        unknown_effect_latched_at: null,
        jobs: [],
      },
      applications: [],
    },
  });
}

function curatorResult(runId: string, state: "completed" | "dry_run_complete"): Response {
  return ok({
    schema: "curator-result.v1",
    run_id: runId,
    state,
    evaluation_ids: [],
    proposed_evaluations: [],
    produced_version_ids: [],
    skipped_actions: [],
    replayed: false,
  });
}

function directService(options: {
  readonly clock?: FakeClock;
  readonly manual?: EvolutionSchedulerWorker;
  readonly scheduled?: EvolutionSchedulerWorker;
  readonly distiller?: EvolutionSchedulerWorker;
  readonly idleProbe?: { isIdle(): boolean | Promise<boolean> };
  readonly store?: EvolutionServiceStateStore;
  readonly timer?: EvolutionServiceTimer;
  readonly intervalMs?: number;
  readonly lastSuccessMs?: number | null;
  readonly idleRequiredMs?: number;
  readonly ioTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly enqueuer?: EvolutionCuratorScheduleEnqueuer;
} = {}): EvolutionService {
  const clock = options.clock ?? new FakeClock();
  return new EvolutionService({
    enabled: true,
    tickIntervalMs: options.intervalMs ?? 100,
    clock,
    manualCuratorWorker: options.manual ?? new ScriptedWorker(),
    stateStore: options.store ?? new MemoryStateStore(),
    timer: options.timer ?? new FakeTimer(),
    ioTimeoutMs: options.ioTimeoutMs,
    stopGraceMs: options.stopGraceMs,
    schedulerFactory: (restoreState) => new EvolutionScheduler({
      enabled: true,
      clock,
      idleProbe: options.idleProbe ?? { isIdle: () => true },
      distillerWorker: options.distiller ?? new ScriptedWorker(),
      curatorWorker: options.scheduled ?? new ScriptedWorker(),
      curatorScheduleEnqueuer: options.enqueuer ?? {
        async ensureScheduledRun() { return readyScheduleResult(); },
      },
      ...(restoreState === undefined
        ? { initialLastSuccessfulCuratorRunAtMs: options.lastSuccessMs ?? null }
        : { restoreState }),
      curatorIdleRequiredMs: options.idleRequiredMs ?? 0,
    }),
  });
}

function factorySeams(): {
  readonly manualCuratorWorkerFactory: () => EvolutionSchedulerWorker;
  readonly scheduledCuratorWorkerFactory: () => EvolutionSchedulerWorker;
  readonly scheduledRunEnqueuerFactory: () => EvolutionCuratorScheduleEnqueuer;
} {
  return {
    manualCuratorWorkerFactory: () => new ScriptedWorker(),
    scheduledCuratorWorkerFactory: () => new ScriptedWorker(),
    scheduledRunEnqueuerFactory: () => ({
      async ensureScheduledRun() { return readyScheduleResult(); },
    }),
  };
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "synthia-evolution-service-"));
  temporaryDirectories.push(path);
  return path;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

describe("EvolutionService feature and credential boundary", () => {
  test("is closed by default without reading state, arming a timer, or requiring secrets", async () => {
    const store = new MemoryStateStore();
    const timer = new FakeTimer();
    const service = createEvolutionServiceFromEnv({
      SYNTHIA_CORE_TOKEN: "ordinary-core-must-not-be-used",
      SYNTHIA_MODEL_KEY: "ordinary-model-must-not-be-used",
    }, { stateStore: store, timer });

    expect(service.enabled).toBe(false);
    await service.start();
    await expect(service.tickNow()).resolves.toMatchObject({ state: "disabled" });
    expect(store.loadCalls).toBe(0);
    expect(timer.callback).toBeNull();
    await service.stop();
  });

  test.each([
    "SYNTHIA_EVOLUTION_DISTILLER_TOKEN",
    "SYNTHIA_EVOLUTION_CURATOR_TOKEN",
    "SYNTHIA_EVOLUTION_SCHEDULER_TOKEN",
    "SYNTHIA_EVOLUTION_MODEL_URL",
    "SYNTHIA_EVOLUTION_MODEL_KEY",
    "SYNTHIA_EVOLUTION_MODEL_NAME",
  ])("requires dedicated %s and never falls back to ordinary credentials", (missing) => {
    const env: Record<string, string> = {
      ...ENABLED_ENV,
      SYNTHIA_CORE_TOKEN: "ordinary-core",
      SYNTHIA_MODEL_URL: "http://ordinary-model.local/v1",
      SYNTHIA_MODEL_KEY: "ordinary-model-key",
      SYNTHIA_MODEL_NAME: "ordinary-model",
    };
    delete env[missing];
    expect(() => createEvolutionServiceFromEnv(env, factorySeams())).toThrow(missing);
  });

  test("enabled production assembly no longer requires injected lane factories", () => {
    expect(() => createEvolutionServiceFromEnv(ENABLED_ENV, {
      stateStore: new MemoryStateStore(),
      timer: new FakeTimer(),
    })).not.toThrow();
  });

  test("keeps the evaluator lane default-off and requires its singleton token only when explicitly enabled", () => {
    expect(() => createEvolutionServiceFromEnv(ENABLED_ENV, factorySeams())).not.toThrow();
    expect(() => createEvolutionServiceFromEnv({
      ...ENABLED_ENV,
      SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION: "true",
    }, factorySeams())).toThrow("SYNTHIA_EVOLUTION_EVALUATOR_TOKEN");
    expect(() => createEvolutionServiceFromEnv({
      ...ENABLED_ENV,
      SYNTHIA_FEATURE_EVOLUTION_EVAL_EXECUTION: "true",
      SYNTHIA_EVOLUTION_EVALUATOR_TOKEN: "evaluator-secret-only",
    }, factorySeams())).not.toThrow();
  });

  test("exposes no Connector, governance, workspace, or project-write capability", () => {
    const service = createEvolutionServiceFromEnv({}, {
      stateStore: new MemoryStateStore(),
    });
    const surface = [
      ...Reflect.ownKeys(service),
      ...Reflect.ownKeys(Object.getPrototypeOf(service)),
    ].map(String).join(" ").toLowerCase();
    expect(Reflect.ownKeys(service)).toEqual(["enabled"]);
    expect(surface).not.toContain("connector");
    expect(surface).not.toContain("governance");
    expect(surface).not.toContain("workspace");
    expect(surface).not.toContain("project");
    expect(surface).not.toContain("lease");
  });

  test("assembles the Distiller client plus split Curator/scheduler seams", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    const fetchImpl: EvolutionServiceFetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      if (url === "http://runtime.local/tasks") return Response.json({ agents: [] });
      if (url.endsWith("/distillation-runs/claim")) {
        return nullClaim("distillation-claim.v1");
      }
      if (url.endsWith("/curator-runs/claim-manual")) return nullClaim("curator-claim.v1");
      if (url.endsWith("/curator-runs/ensure-scheduled")) {
        return ok({
          schema: "curator-schedule.v1",
          request_key: "scheduled:initial",
          schedule_bucket: "scheduled:initial",
          eligible_at: "1970-01-01T00:00:00.000Z",
          state: "queued",
          curator_run_id: "curator-scheduled-1",
          reason_code: "materialized",
          replayed: false,
        });
      }
      if (url.endsWith("/curator-runs/claim-scheduled")) return nullClaim("curator-claim.v1");
      throw new Error(`unexpected request ${url}`);
    };
    const timer = new FakeTimer();
    const service = createEvolutionServiceFromEnv(ENABLED_ENV, {
      fetchImpl,
      timer,
      stateStore: new MemoryStateStore(),
      clock: new FakeClock(7 * DAY),
      schedulerTiming: { curatorIdleRequiredMs: 0 },
    });

    await service.start();
    await service.tickNow();
    await service.stop();

    expect(requests).toContainEqual({
      url: "http://runtime.local/tasks",
      method: "GET",
      authorization: null,
    });
    expect(requests.find((item) => item.url.endsWith("/distillation-runs/claim")))
      .toMatchObject({ method: "POST", authorization: "Bearer distiller-secret-only" });
    expect(requests.find((item) => item.url.endsWith("/curator-runs/claim-manual")))
      .toMatchObject({ method: "POST", authorization: "Bearer curator-secret-only" });
    expect(requests.find((item) => item.url.endsWith("/curator-runs/claim-scheduled")))
      .toMatchObject({ method: "POST", authorization: "Bearer curator-secret-only" });
    expect(requests.find((item) => item.url.endsWith("/curator-runs/ensure-scheduled")))
      .toMatchObject({ method: "POST", authorization: "Bearer scheduler-secret-only" });
    expect(requests.some((item) => item.authorization?.includes("ordinary") === true)).toBe(false);
  });

  test("default HTTP lanes run manual persistent work immediately and reset scheduled eligibility", async () => {
    const paths: string[] = [];
    const fetchImpl: EvolutionServiceFetch = async (input) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      if (url.endsWith("/curator-runs/claim-manual")) {
        return curatorClaim("curator-manual-1", "run", "manual:key-1");
      }
      if (url.endsWith("/curator-runs/curator-manual-1/lease")) {
        return ok({
          schema: "curator-lease.v1",
          run_id: "curator-manual-1",
          lease_expires_at: "2026-08-27T00:00:00.000Z",
        });
      }
      if (url.endsWith("/curator-runs/curator-manual-1/complete")) {
        return curatorResult("curator-manual-1", "completed");
      }
      if (url.endsWith("/distillation-runs/claim")) {
        return nullClaim("distillation-claim.v1");
      }
      if (url === "http://runtime.local/tasks") return Response.json({ agents: [] });
      throw new Error(`unexpected request ${url}`);
    };
    const store = new MemoryStateStore({
      ...EMPTY_SNAPSHOT,
      lastSuccessfulCuratorRunAtMs: 0,
    });
    const service = createEvolutionServiceFromEnv(ENABLED_ENV, {
      fetchImpl,
      stateStore: store,
      timer: new FakeTimer(),
      clock: new FakeClock(7 * DAY),
      schedulerTiming: { curatorIdleRequiredMs: 0 },
    });

    await service.start();
    await expect(service.tickNow()).resolves.toMatchObject({
      manualCurator: { state: "completed" },
      scheduled: { curator: { state: "skipped", reason: "not_eligible" } },
    });
    expect(paths[0]).toEndWith("/curator-runs/claim-manual");
    expect(paths.some((path) => path.endsWith("/curator-runs/ensure-scheduled"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/curator-runs/claim-scheduled"))).toBe(false);
    expect(store.saves.at(-1)?.lastSuccessfulCuratorRunAtMs).toBe(7 * DAY);
    await service.stop();
  });

  test("default HTTP lanes keep dry-run non-persistent and order scheduled ensure before claim", async () => {
    const paths: string[] = [];
    const fetchImpl: EvolutionServiceFetch = async (input, init) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      if (url.endsWith("/curator-runs/claim-manual")) {
        return curatorClaim("curator-dry-1", "dry_run", "manual:key-dry");
      }
      if (url.endsWith("/curator-runs/curator-dry-1/lease")) {
        return ok({
          schema: "curator-lease.v1",
          run_id: "curator-dry-1",
          lease_expires_at: "2026-08-27T00:00:00.000Z",
        });
      }
      if (url.endsWith("/curator-runs/curator-dry-1/complete")) {
        return curatorResult("curator-dry-1", "dry_run_complete");
      }
      if (url.endsWith("/distillation-runs/claim")) {
        return nullClaim("distillation-claim.v1");
      }
      if (url === "http://runtime.local/tasks") return Response.json({ agents: [] });
      if (url.endsWith("/curator-runs/ensure-scheduled")) {
        const request = JSON.parse(String(init?.body)) as { request_key: string };
        return ok({
          schema: "curator-schedule.v1",
          request_key: request.request_key,
          schedule_bucket: "scheduled:after:core-persistent-1",
          eligible_at: "1970-01-08T00:00:00.000Z",
          state: "queued",
          curator_run_id: "curator-scheduled-1",
          reason_code: "materialized",
          replayed: false,
        });
      }
      if (url.endsWith("/curator-runs/claim-scheduled")) {
        return nullClaim("curator-claim.v1");
      }
      throw new Error(`unexpected request ${url}`);
    };
    const store = new MemoryStateStore({
      ...EMPTY_SNAPSHOT,
      lastSuccessfulCuratorRunAtMs: 0,
    });
    const service = createEvolutionServiceFromEnv(ENABLED_ENV, {
      fetchImpl,
      stateStore: store,
      timer: new FakeTimer(),
      clock: new FakeClock(7 * DAY),
      schedulerTiming: { curatorIdleRequiredMs: 0 },
    });

    await service.start();
    await expect(service.tickNow()).resolves.toMatchObject({
      manualCurator: { state: "completed" },
      scheduled: {
        curatorScheduleBucket: "scheduled:after:core-persistent-1",
        curator: { state: "idle" },
      },
    });
    const manualIndex = paths.findIndex((path) => path.endsWith("/curator-runs/claim-manual"));
    const ensureIndex = paths.findIndex((path) => path.endsWith("/curator-runs/ensure-scheduled"));
    const scheduledIndex = paths.findIndex((path) => path.endsWith("/curator-runs/claim-scheduled"));
    expect(manualIndex).toBe(0);
    expect(ensureIndex).toBeGreaterThan(manualIndex);
    expect(scheduledIndex).toBeGreaterThan(ensureIndex);
    expect(store.saves.at(-1)?.lastSuccessfulCuratorRunAtMs).toBe(0);
    await service.stop();
  });
});

describe("EvolutionService timer, manual lane, and lifecycle", () => {
  test("timer uses one single-flight and stop aborts an in-flight worker", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const manual: EvolutionSchedulerWorker = {
      calls: 0,
      async runOnce() {
        (this as { calls: number }).calls += 1;
        await barrier;
        return { state: "idle" };
      },
    } as EvolutionSchedulerWorker & { calls: number };
    const timer = new FakeTimer();
    const store = new MemoryStateStore();
    const service = directService({ manual, timer, store });
    await service.start();

    const first = service.tickNow();
    const second = service.tickNow();
    expect(second).toBe(first);
    timer.fire();
    await Promise.resolve();
    expect((manual as EvolutionSchedulerWorker & { calls: number }).calls).toBe(1);

    const stopping = service.stop();
    expect(timer.clearCalls).toBe(1);
    await stopping;
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(store.saves.length).toBeGreaterThanOrEqual(1);
    release();
  });

  test("stop remains bounded when a manual worker ignores its abort signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const manual: EvolutionSchedulerWorker = {
      async runOnce(signal) {
        observedSignal = signal;
        return await new Promise(() => {});
      },
    };
    const service = directService({ manual });
    await service.start();
    const tick = service.tickNow();
    await waitUntil(() => observedSignal !== undefined);

    await Promise.race([
      service.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("stop did not finish")),
        50,
      )),
    ]);
    expect(observedSignal?.aborted).toBe(true);
    await expect(tick).rejects.toMatchObject({ name: "AbortError" });
  });

  test.each(["distiller", "probe", "ensure", "scheduled"] as const)(
    "stop aborts a hung scheduler %s boundary",
    async (stage) => {
      let observedSignal: AbortSignal | undefined;
      const hang = async (signal?: AbortSignal): Promise<never> => {
        observedSignal = signal;
        return await new Promise<never>(() => {});
      };
      const service = directService({
        distiller: stage === "distiller" ? { runOnce: hang } : undefined,
        idleProbe: stage === "probe" ? { isIdle: hang } : undefined,
        enqueuer: stage === "ensure"
          ? { ensureScheduledRun: async (_request, signal) => await hang(signal) }
          : undefined,
        scheduled: stage === "scheduled" ? { runOnce: hang } : undefined,
        idleRequiredMs: 0,
      });
      await service.start();
      const tick = service.tickNow();
      await waitUntil(() => observedSignal !== undefined);

      await service.stop();
      expect(observedSignal?.aborted).toBe(true);
      await expect(tick).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  test("stop detaches a scheduler implementation that ignores cancellation", async () => {
    let observedSignal: AbortSignal | undefined;
    const service = new EvolutionService({
      enabled: true,
      clock: new FakeClock(),
      manualCuratorWorker: new ScriptedWorker(),
      stateStore: new MemoryStateStore(),
      timer: new FakeTimer(),
      stopGraceMs: 5,
      schedulerFactory: () => ({
        async tick(signal) {
          observedSignal = signal;
          return await new Promise<EvolutionSchedulerTickResult>(() => {});
        },
        snapshot: () => EMPTY_SNAPSHOT,
        recordManualCuratorRun: () => {},
      }),
    });
    await service.start();
    const tick = service.tickNow();
    await waitUntil(() => observedSignal !== undefined);

    await service.stop();
    expect(observedSignal?.aborted).toBe(true);
    await expect(tick).rejects.toMatchObject({ name: "AbortError" });
  });

  test("default real timer drives ticks and stops cleanly", async () => {
    const manual = new ScriptedWorker();
    const service = new EvolutionService({
      enabled: true,
      tickIntervalMs: 5,
      clock: new FakeClock(),
      manualCuratorWorker: manual,
      stateStore: new MemoryStateStore(),
      schedulerFactory: () => ({
        async tick() {
          return {
            state: "completed",
            atMs: 0,
            clockRollback: false,
            curatorScheduleBucket: null,
            distiller: { state: "idle" },
            curator: { state: "idle" },
          };
        },
        snapshot: () => EMPTY_SNAPSHOT,
        recordManualCuratorRun: () => {},
      }),
    });

    await service.start();
    await waitUntil(() => manual.calls >= 1);
    await service.stop();
    const stoppedAt = manual.calls;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manual.calls).toBe(stoppedAt);
  });

  test("persistent manual completion resets the cycle before scheduled lane", async () => {
    const clock = new FakeClock(7 * DAY);
    const manual = new ScriptedWorker([{
      state: "completed",
      result: { state: "completed" },
    }]);
    const scheduled = new ScriptedWorker();
    const store = new MemoryStateStore();
    const service = directService({
      clock,
      manual,
      scheduled,
      store,
      lastSuccessMs: 0,
    });
    await service.start();

    await expect(service.tickNow()).resolves.toMatchObject({
      manualCurator: { state: "completed" },
      scheduled: { curator: { state: "skipped", reason: "not_eligible" } },
    });
    expect(scheduled.calls).toBe(0);
    expect(store.saves.at(-1)?.lastSuccessfulCuratorRunAtMs).toBe(7 * DAY);
    await service.stop();
  });

  test("manual dry-run completes promptly but does not reset scheduled eligibility", async () => {
    const manual = new ScriptedWorker([{
      state: "completed",
      result: { state: "dry_run_complete" },
    }]);
    const scheduled = new ScriptedWorker();
    const store = new MemoryStateStore();
    const service = directService({
      clock: new FakeClock(7 * DAY),
      manual,
      scheduled,
      store,
      lastSuccessMs: 0,
    });
    await service.start();

    await expect(service.tickNow()).resolves.toMatchObject({
      manualCurator: { state: "completed" },
      scheduled: { curator: { state: "idle" } },
    });
    expect(scheduled.calls).toBe(1);
    expect(store.saves.at(-1)?.lastSuccessfulCuratorRunAtMs).toBe(0);
    await service.stop();
  });
});

describe("Evolution service executable lifecycle", () => {
  test("enabled production entrypoint starts before Core is reachable and fails only on tick", async () => {
    const timer = new FakeTimer();
    const signalHost = new FakeSignalHost();
    const startupLogs: string[] = [];
    const exitCodes: number[] = [];
    const controller = await runEvolutionServiceEntrypoint({
      env: ENABLED_ENV,
      createService: (env) => createEvolutionServiceFromEnv(env, {
        fetchImpl: async () => { throw new Error("Core is unreachable"); },
        stateStore: new MemoryStateStore(),
        timer,
        ioTimeoutMs: 10,
      }),
      signalHost,
      reportStartupError: (message) => startupLogs.push(message),
      setExitCode: (code) => exitCodes.push(code),
    });

    expect(controller).not.toBeNull();
    expect(timer.callback).not.toBeNull();
    expect(startupLogs).toEqual([]);
    expect(exitCodes).toEqual([]);
    await expect(controller!.service.tickNow()).rejects.toThrow("activity probe failed");
    await controller!.stop();
  });

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s requests graceful stop and removes both signal handlers",
    async (signal) => {
      const service = new ObservedEvolutionService();
      const signalHost = new FakeSignalHost();
      const controller = await startEvolutionServiceMain({
        env: {},
        createService: () => service,
        signalHost,
      });

      expect(service.startCalls).toBe(1);
      expect([...signalHost.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
      signalHost.emit(signal);
      await waitUntil(() => service.stopCalls === 1);

      expect(service.stopCalls).toBe(1);
      expect(signalHost.listeners.size).toBe(0);
      expect(signalHost.removed.sort()).toEqual(["SIGINT", "SIGTERM"]);
      await controller.stop();
      expect(service.stopCalls).toBe(1);
    },
  );

  test("controller stop is idempotent", async () => {
    const service = new ObservedEvolutionService();
    const controller = await startEvolutionServiceMain({
      env: {},
      createService: () => service,
      signalHost: new FakeSignalHost(),
    });

    const first = controller.stop();
    const second = controller.stop();
    expect(second).toBe(first);
    await first;
    expect(service.stopCalls).toBe(1);
  });

  test("startup failure reports only a constant message and sets exit code", async () => {
    const logs: string[] = [];
    const exitCodes: number[] = [];
    const result = await runEvolutionServiceEntrypoint({
      env: {},
      createService: () => {
        throw new Error("startup leaked evolution-model-secret-only");
      },
      reportStartupError: (message) => logs.push(message),
      setExitCode: (code) => exitCodes.push(code),
    });

    expect(result).toBeNull();
    expect(logs).toEqual(["[evolution-service] startup failed"]);
    expect(logs.join("\n")).not.toContain("evolution-model-secret-only");
    expect(exitCodes).toEqual([1]);
  });
});

describe("RuntimeTasksIdleProbe", () => {
  test.each([
    [{ agents: [] }, true],
    [{ agents: [{ status: "awaiting_user" }] }, true],
    [{ agents: [{ status: "running" }] }, false],
    [{ agents: [{ status: "awaiting_user", busy: true }] }, false],
    [{ agents: [{ status: "busy" }] }, false],
  ])("maps Runtime /tasks activity %#", async (body, expected) => {
    let observedInit: RequestInit | undefined;
    const probe = new RuntimeTasksIdleProbe("http://runtime.local/", async (_input, init) => {
      observedInit = init;
      return Response.json(body);
    });
    await expect(probe.isIdle()).resolves.toBe(expected);
    expect(observedInit?.method).toBe("GET");
    expect(observedInit?.body).toBeUndefined();
    expect(new Headers(observedInit?.headers).has("authorization")).toBe(false);
  });

  test("fails closed on network, HTTP, malformed, and unknown status", async () => {
    const cases: EvolutionServiceFetch[] = [
      async () => { throw new Error("secret network detail"); },
      async () => new Response("no", { status: 503 }),
      async () => new Response("not-json"),
      async () => Response.json({ agents: [{ status: "new-unknown-state" }] }),
    ];
    for (const fetchImpl of cases) {
      const probe = new RuntimeTasksIdleProbe("http://runtime.local", fetchImpl);
      await expect(probe.isIdle()).rejects.toThrow();
    }
  });

  test("times out a transport that never resolves and propagates parent abort", async () => {
    const observed: AbortSignal[] = [];
    const fetchImpl: EvolutionServiceFetch = async (_input, init) => {
      observed.push(init?.signal as AbortSignal);
      return await new Promise<Response>(() => {});
    };
    const timed = new RuntimeTasksIdleProbe("http://runtime.local", fetchImpl, 5);
    await expect(timed.isIdle()).rejects.toThrow("activity probe failed");
    expect(observed[0]?.aborted).toBe(true);

    const controller = new AbortController();
    const cancelled = new RuntimeTasksIdleProbe("http://runtime.local", fetchImpl, 1_000);
    const result = cancelled.isIdle(controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("activity probe failed");
    expect(observed[1]?.aborted).toBe(true);
  });

  test("the same deadline covers a 200 response body that never finishes", async () => {
    const response = (): Response => new Response(new ReadableStream({
      start() {
        // Intentionally never enqueue or close: headers exist, body does not.
      },
    }), { status: 200 });
    const timed = new RuntimeTasksIdleProbe(
      "http://runtime.local",
      async () => response(),
      5,
    );
    await expect(timed.isIdle()).rejects.toThrow("activity probe failed");

    const controller = new AbortController();
    const cancelled = new RuntimeTasksIdleProbe(
      "http://runtime.local",
      async () => response(),
      1_000,
    );
    const result = cancelled.isIdle(controller.signal);
    controller.abort(new DOMException("service stopping", "AbortError"));
    await expect(result).rejects.toThrow("activity probe failed");
  });

  test("streams UTF-8 across chunk boundaries and cancels before buffering an oversized body", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      agents: [{ status: "awaiting_user", label: "综合完成" }],
    }));
    const splitAt = encoded.indexOf(0xe7) + 1;
    const validBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
        controller.close();
      },
    });
    const validProbe = new RuntimeTasksIdleProbe(
      "http://runtime.local",
      async () => new Response(validBody),
    );
    await expect(validProbe.isIdle()).resolves.toBe(true);

    let pulls = 0;
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversizedProbe = new RuntimeTasksIdleProbe(
      "http://runtime.local",
      async () => new Response(oversizedBody),
    );
    await expect(oversizedProbe.isIdle()).rejects.toThrow("activity probe failed");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(7);
  });
});

describe("Evolution service durable state", () => {
  test("atomically round-trips only scheduler restore facts", async () => {
    const root = await tempDirectory();
    const path = join(root, "nested", "evolution.json");
    const store = new FileEvolutionServiceStateStore(path);
    const snapshot: EvolutionSchedulerSnapshot = {
      ...EMPTY_SNAPSHOT,
      running: true,
      idleSinceMs: 100,
      lastObservedAtMs: 200,
      lastSuccessfulCuratorRunAtMs: 50,
      nextCuratorEligibleAtMs: 999,
      distillerConsecutiveFailures: 1,
      distillerRetryNotBeforeMs: 300,
    };
    await store.save(snapshot);

    await expect(store.load()).resolves.toEqual({
      idleSinceMs: 100,
      lastObservedAtMs: 200,
      lastSuccessfulCuratorRunAtMs: 50,
      distillerConsecutiveFailures: 1,
      distillerRetryNotBeforeMs: 300,
      curatorConsecutiveFailures: 0,
      curatorRetryNotBeforeMs: null,
    });
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted.schema).toBe(EVOLUTION_SERVICE_STATE_SCHEMA);
    expect(JSON.stringify(persisted)).not.toContain("running");
    expect(JSON.stringify(persisted)).not.toContain("nextCuratorEligibleAtMs");
  });

  test("restores persisted facts into a restarted scheduler", async () => {
    const root = await tempDirectory();
    const path = join(root, "state.json");
    const store = new FileEvolutionServiceStateStore(path);
    const first = directService({
      clock: new FakeClock(7 * DAY),
      store,
      lastSuccessMs: 0,
      idleRequiredMs: 2 * HOUR,
    });
    await first.start();
    await first.tickNow();
    await first.stop();

    const restoredStore = new FileEvolutionServiceStateStore(path);
    const second = directService({
      clock: new FakeClock(7 * DAY + HOUR),
      store: restoredStore,
      idleRequiredMs: 2 * HOUR,
    });
    await second.start();
    const result = await second.tickNow();
    expect(result.scheduled?.curator).toEqual({ state: "skipped", reason: "idle_window" });
    expect((await restoredStore.load())?.idleSinceMs).toBe(7 * DAY);
    await second.stop();
  });

  test("bad state file fails start closed before scheduler or timer", async () => {
    const root = await tempDirectory();
    const path = join(root, "state.json");
    await writeFile(path, "{bad-json", "utf8");
    const timer = new FakeTimer();
    let schedulerCalls = 0;
    const service = new EvolutionService({
      enabled: true,
      clock: new FakeClock(),
      manualCuratorWorker: new ScriptedWorker(),
      stateStore: new FileEvolutionServiceStateStore(path),
      timer,
      schedulerFactory() {
        schedulerCalls += 1;
        throw new Error("must not construct");
      },
    });

    await expect(service.start()).rejects.toBeInstanceOf(EvolutionServiceStateError);
    expect(schedulerCalls).toBe(0);
    expect(timer.callback).toBeNull();
    await expect(service.tickNow()).rejects.toThrow("not started");
  });

  test("state load and save have non-zero host deadlines", async () => {
    const hungLoad = directService({
      store: {
        async load() { return await new Promise<null>(() => {}); },
        async save() {},
      },
      ioTimeoutMs: 5,
    });
    await expect(hungLoad.start()).rejects.toThrow("I/O timed out");

    const hungSave = directService({
      store: {
        async load() { return null; },
        async save() { return await new Promise<void>(() => {}); },
      },
      ioTimeoutMs: 5,
    });
    await hungSave.start();
    await expect(hungSave.tickNow()).rejects.toThrow("I/O timed out");
    await hungSave.stop();
  });

  test("stop independently flushes a mutated scheduler snapshot and restart restores backoff", async () => {
    let probeSignal: AbortSignal | undefined;
    const store = new MemoryStateStore();
    const service = directService({
      clock: new FakeClock(),
      store,
      distiller: new ScriptedWorker([{ state: "failed" }]),
      idleProbe: {
        async isIdle(signal?: AbortSignal) {
          probeSignal = signal;
          return await new Promise<boolean>(() => {});
        },
      },
      stopGraceMs: 50,
    });
    await service.start();
    const tick = service.tickNow();
    await waitUntil(() => probeSignal !== undefined);

    await service.stop();
    await expect(tick).rejects.toMatchObject({ name: "AbortError" });
    expect(probeSignal?.aborted).toBe(true);
    expect(store.saves.length).toBeGreaterThanOrEqual(1);
    const durable = store.saves.at(-1)!;
    expect(durable.distillerConsecutiveFailures).toBe(1);
    expect(durable.distillerRetryNotBeforeMs).toBe(60_000);
    expect(durable.idleSinceMs).toBeNull();

    const restartedDistiller = new ScriptedWorker();
    const restarted = directService({
      clock: new FakeClock(),
      store: new MemoryStateStore(durable),
      distiller: restartedDistiller,
    });
    await restarted.start();
    await expect(restarted.tickNow()).resolves.toMatchObject({
      scheduled: { distiller: { state: "skipped", reason: "backoff" } },
    });
    expect(restartedDistiller.calls).toBe(0);
    await restarted.stop();
  });

  test("stop stays bounded when the independent shutdown save ignores abort", async () => {
    let saveCalls = 0;
    const service = directService({
      store: {
        async load() { return null; },
        async save() {
          saveCalls += 1;
          return await new Promise<void>(() => {});
        },
      },
      ioTimeoutMs: 20,
      stopGraceMs: 5,
    });
    await service.start();
    const tick = service.tickNow();
    await waitUntil(() => saveCalls === 1);

    await Promise.race([
      service.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("stop did not finish")),
        50,
      )),
    ]);
    expect(saveCalls).toBe(1);
    await expect(tick).rejects.toThrow("I/O timed out");
  });

  test("probe failure clears idle continuity and persists the fail-closed snapshot", async () => {
    const clock = new FakeClock(7 * DAY);
    let probeCalls = 0;
    const probe = new RuntimeTasksIdleProbe("http://runtime.local", async () => {
      probeCalls += 1;
      return probeCalls === 1
        ? Response.json({ agents: [] })
        : new Response("unavailable", { status: 503 });
    });
    const store = new MemoryStateStore();
    const service = directService({
      clock,
      store,
      idleProbe: probe,
      idleRequiredMs: 2 * HOUR,
      lastSuccessMs: 0,
    });
    await service.start();
    await service.tickNow();
    expect(store.saves.at(-1)?.idleSinceMs).toBe(7 * DAY);

    clock.nowMs += HOUR;
    await expect(service.tickNow()).rejects.toThrow("activity probe failed");
    expect(store.saves.at(-1)?.idleSinceMs).toBeNull();
    await service.stop();
  });

  test("dedicated secrets never enter logs or persisted state", async () => {
    const root = await tempDirectory();
    const path = join(root, "state.json");
    const timer = new FakeTimer();
    const logs: string[] = [];
    const fetchImpl: EvolutionServiceFetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/distillation-runs/claim")) {
        return nullClaim("distillation-claim.v1");
      }
      if (url === "http://runtime.local/tasks") {
        return new Response("probe failed with curator-secret-only", { status: 503 });
      }
      throw new Error("unexpected network path");
    };
    const service = createEvolutionServiceFromEnv(ENABLED_ENV, {
      ...factorySeams(),
      fetchImpl,
      timer,
      stateStore: new FileEvolutionServiceStateStore(path),
      reportError: (message) => logs.push(message),
      clock: new FakeClock(7 * DAY),
    });
    await service.start();
    timer.fire();
    await waitUntil(() => logs.length === 1);
    await service.stop();

    const durable = await readFile(path, "utf8");
    const combined = `${logs.join("\n")}\n${durable}`;
    expect(combined).not.toContain(ENABLED_ENV.SYNTHIA_EVOLUTION_DISTILLER_TOKEN);
    expect(combined).not.toContain(ENABLED_ENV.SYNTHIA_EVOLUTION_CURATOR_TOKEN);
    expect(combined).not.toContain(ENABLED_ENV.SYNTHIA_EVOLUTION_SCHEDULER_TOKEN);
    expect(combined).not.toContain(ENABLED_ENV.SYNTHIA_EVOLUTION_MODEL_KEY);
    expect(logs).toEqual(["[evolution-service] background tick failed"]);
  });
});
