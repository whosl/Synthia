import { describe, expect, test } from "bun:test";
import {
  CURATOR_IDLE_REQUIRED_MS,
  CURATOR_SCHEDULE_INTERVAL_MS,
  EvolutionScheduler,
  type EvolutionCuratorScheduleEnqueuer,
  type EvolutionCuratorScheduleRequest,
  type EvolutionCuratorScheduleResult,
  type EvolutionSchedulerRestoreState,
  type EvolutionSchedulerIdleProbe,
  type EvolutionSchedulerWorker,
  type EvolutionSchedulerWorkerResult,
} from "./evolution-scheduler.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const CORE_ELIGIBLE_AT = "2026-08-26T00:00:00.000Z";

function scheduleResult(
  state: EvolutionCuratorScheduleResult["state"],
  bucket = "core:canonical-cycle",
): EvolutionCuratorScheduleResult {
  return {
    state,
    canonicalScheduleBucket: bucket,
    canonicalEligibleAt: CORE_ELIGIBLE_AT,
  };
}

class FakeClock {
  constructor(public nowMs = 0) {}
  now(): number { return this.nowMs; }
}

class FakeIdleProbe {
  calls = 0;
  idle = true;
  async isIdle(): Promise<boolean> {
    this.calls += 1;
    return this.idle;
  }
}

class ScriptedWorker implements EvolutionSchedulerWorker {
  calls = 0;
  readonly #results: Array<EvolutionSchedulerWorkerResult | Error>;

  constructor(results: Array<EvolutionSchedulerWorkerResult | Error> = [{ state: "idle" }]) {
    this.#results = [...results];
  }

  async runOnce(): Promise<EvolutionSchedulerWorkerResult> {
    this.calls += 1;
    const next = this.#results.shift() ?? { state: "idle" };
    if (next instanceof Error) throw next;
    return next;
  }
}

class ScriptedEnqueuer implements EvolutionCuratorScheduleEnqueuer {
  readonly calls: EvolutionCuratorScheduleRequest[] = [];
  readonly #results: Array<EvolutionCuratorScheduleResult | Error>;

  constructor(results: Array<EvolutionCuratorScheduleResult | Error> = [scheduleResult("ready")]) {
    this.#results = [...results];
  }

  async ensureScheduledRun(
    request: EvolutionCuratorScheduleRequest,
  ): Promise<EvolutionCuratorScheduleResult> {
    this.calls.push(request);
    const next = this.#results.shift() ?? scheduleResult("ready");
    if (next instanceof Error) throw next;
    return next;
  }
}

function setup(options: {
  readonly enabled?: boolean;
  readonly nowMs?: number;
  readonly lastSuccessMs?: number | null;
  readonly idleRequiredMs?: number;
  readonly intervalMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly distiller?: EvolutionSchedulerWorker;
  readonly curator?: EvolutionSchedulerWorker;
  readonly enqueuer?: EvolutionCuratorScheduleEnqueuer;
  readonly restoreState?: EvolutionSchedulerRestoreState;
  readonly idleProbe?: EvolutionSchedulerIdleProbe;
} = {}) {
  const clock = new FakeClock(options.nowMs ?? 0);
  const idle = new FakeIdleProbe();
  const idleProbe = options.idleProbe ?? idle;
  const distiller = options.distiller ?? new ScriptedWorker();
  const curator = options.curator ?? new ScriptedWorker();
  const enqueuer = options.enqueuer ?? new ScriptedEnqueuer();
  const scheduler = new EvolutionScheduler({
    enabled: options.enabled ?? true,
    clock,
    idleProbe,
    distillerWorker: distiller,
    curatorWorker: curator,
    curatorScheduleEnqueuer: enqueuer,
    ...(options.restoreState === undefined
      ? { initialLastSuccessfulCuratorRunAtMs: options.lastSuccessMs ?? null }
      : { restoreState: options.restoreState }),
    ...(options.idleRequiredMs === undefined
      ? {}
      : { curatorIdleRequiredMs: options.idleRequiredMs }),
    ...(options.intervalMs === undefined
      ? {}
      : { curatorScheduleIntervalMs: options.intervalMs }),
    ...(options.backoffBaseMs === undefined
      ? {}
      : { failureBackoffBaseMs: options.backoffBaseMs }),
    ...(options.backoffMaxMs === undefined
      ? {}
      : { failureBackoffMaxMs: options.backoffMaxMs }),
  });
  return { scheduler, clock, idle, distiller, curator, enqueuer };
}

async function waitForSignal(read: () => AbortSignal | undefined): Promise<AbortSignal> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const signal = read();
    if (signal !== undefined) return signal;
    await Bun.sleep(1);
  }
  throw new Error("cancellation signal was not observed");
}

describe("EvolutionScheduler", () => {
  test("is closed by default and does not touch any dependency", async () => {
    const clock = new FakeClock();
    const idle = new FakeIdleProbe();
    const distiller = new ScriptedWorker();
    const curator = new ScriptedWorker();
    const scheduler = new EvolutionScheduler({
      clock,
      idleProbe: idle,
      distillerWorker: distiller,
      curatorWorker: curator,
      curatorScheduleEnqueuer: new ScriptedEnqueuer(),
    });

    await expect(scheduler.tick()).resolves.toMatchObject({
      state: "disabled",
      atMs: null,
      distiller: { state: "skipped", reason: "disabled" },
      curator: { state: "skipped", reason: "disabled" },
    });
    expect(idle.calls).toBe(0);
    expect(distiller.calls).toBe(0);
    expect(curator.calls).toBe(0);
  });

  test("runs Distiller only as one claim-if-work attempt per enabled tick", async () => {
    const distiller = new ScriptedWorker([{ state: "idle" }, { state: "completed" }]);
    const { scheduler, curator } = setup({ distiller, lastSuccessMs: 0 });

    expect((await scheduler.tick()).distiller).toEqual({ state: "idle" });
    expect((await scheduler.tick()).distiller).toEqual({ state: "completed" });
    expect(distiller.calls).toBe(2);
    expect((curator as ScriptedWorker).calls).toBe(0);
  });

  test("Curator starts only at both exact seven-day and continuous two-hour boundaries", async () => {
    const start = CURATOR_SCHEDULE_INTERVAL_MS - CURATOR_IDLE_REQUIRED_MS;
    const { scheduler, clock, curator } = setup({
      nowMs: start,
      lastSuccessMs: 0,
      curator: new ScriptedWorker([{ state: "completed" }]),
    });

    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "idle_window" });
    clock.nowMs = CURATOR_SCHEDULE_INTERVAL_MS - 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "idle_window" });
    clock.nowMs = CURATOR_SCHEDULE_INTERVAL_MS;
    expect((await scheduler.tick()).curator).toEqual({ state: "completed" });
    expect((curator as ScriptedWorker).calls).toBe(1);
    expect(scheduler.snapshot()).toMatchObject({
      lastSuccessfulCuratorRunAtMs: CURATOR_SCHEDULE_INTERVAL_MS,
      nextCuratorEligibleAtMs: 2 * CURATOR_SCHEDULE_INTERVAL_MS,
      idleSinceMs: null,
    });
  });

  test("eligibility alone is insufficient until the two-hour idle window completes", async () => {
    const { scheduler, clock } = setup({ nowMs: 7 * DAY, lastSuccessMs: 0 });
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "idle_window" });
    clock.nowMs += 2 * HOUR - 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "idle_window" });
    clock.nowMs += 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "idle" });
  });

  test("clock rollback restarts idle continuity and cannot trigger Curator early", async () => {
    const start = 10 * DAY;
    const { scheduler, clock, curator } = setup({ nowMs: start, lastSuccessMs: 0 });
    await scheduler.tick();
    clock.nowMs = start + CURATOR_IDLE_REQUIRED_MS - 1;
    await scheduler.tick();

    clock.nowMs = start - HOUR;
    const rollback = await scheduler.tick();
    expect(rollback.clockRollback).toBe(true);
    expect(rollback.curator).toEqual({ state: "skipped", reason: "idle_window" });
    expect(scheduler.snapshot().idleSinceMs).toBe(start - HOUR);

    clock.nowMs = start + HOUR - 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "idle_window" });
    clock.nowMs += 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "idle" });
    expect((curator as ScriptedWorker).calls).toBe(1);
  });

  test("a non-idle observation resets the full idle window", async () => {
    const { scheduler, clock, idle, curator } = setup({ nowMs: 7 * DAY, lastSuccessMs: 0 });
    await scheduler.tick();
    clock.nowMs += HOUR;
    idle.idle = false;
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "not_idle" });
    expect(scheduler.snapshot().idleSinceMs).toBeNull();

    idle.idle = true;
    await scheduler.tick();
    clock.nowMs += CURATOR_IDLE_REQUIRED_MS - 1;
    await scheduler.tick();
    expect((curator as ScriptedWorker).calls).toBe(0);
    clock.nowMs += 1;
    await scheduler.tick();
    expect((curator as ScriptedWorker).calls).toBe(1);
  });

  test("an idle-probe failure breaks continuity and never invokes Curator", async () => {
    const { scheduler, clock, idle, curator } = setup({ nowMs: 7 * DAY, lastSuccessMs: 0 });
    await scheduler.tick();
    clock.nowMs += HOUR;
    idle.isIdle = async () => {
      idle.calls += 1;
      throw new Error("activity source unavailable");
    };

    await expect(scheduler.tick()).rejects.toThrow("activity source unavailable");
    expect(scheduler.snapshot()).toMatchObject({ running: false, idleSinceMs: null });
    expect((curator as ScriptedWorker).calls).toBe(0);
  });

  test("successful manual run resets seven days while successful dry-run does not", async () => {
    const { scheduler, clock, curator } = setup({
      nowMs: 6 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
    });
    scheduler.recordManualCuratorRun({ mode: "dry_run", state: "completed" });
    expect(scheduler.snapshot().lastSuccessfulCuratorRunAtMs).toBe(0);

    clock.nowMs = 7 * DAY;
    expect((await scheduler.tick()).curator).toEqual({ state: "idle" });
    expect((curator as ScriptedWorker).calls).toBe(1);

    clock.nowMs = 8 * DAY;
    scheduler.recordManualCuratorRun({ mode: "run", state: "completed" });
    expect(scheduler.snapshot()).toMatchObject({
      lastSuccessfulCuratorRunAtMs: 8 * DAY,
      nextCuratorEligibleAtMs: 15 * DAY,
    });
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "not_eligible" });
  });

  test("a dry-run completed by the injected Curator worker does not reset the cycle", async () => {
    const curator = new ScriptedWorker([{
      state: "completed",
      result: { state: "dry_run_complete" },
    }]);
    const { scheduler } = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      curator,
    });

    expect((await scheduler.tick()).curator).toEqual({ state: "completed" });
    expect(scheduler.snapshot().lastSuccessfulCuratorRunAtMs).toBe(0);
  });

  test("worker and probe latency is sampled at each boundary, never backdated", async () => {
    const clock = new FakeClock(7 * DAY);
    const distiller: EvolutionSchedulerWorker = {
      async runOnce() {
        clock.nowMs += HOUR;
        return { state: "idle" };
      },
    };
    const idle = new FakeIdleProbe();
    idle.isIdle = async () => {
      idle.calls += 1;
      clock.nowMs += HOUR;
      return true;
    };
    const curator = new ScriptedWorker();
    const scheduler = new EvolutionScheduler({
      enabled: true,
      clock,
      idleProbe: idle,
      distillerWorker: distiller,
      curatorWorker: curator,
      curatorScheduleEnqueuer: new ScriptedEnqueuer(),
      initialLastSuccessfulCuratorRunAtMs: 0,
    });

    const result = await scheduler.tick();
    expect(result.atMs).toBe(7 * DAY + 2 * HOUR);
    expect(result.curator).toEqual({ state: "skipped", reason: "idle_window" });
    expect(scheduler.snapshot().idleSinceMs).toBe(7 * DAY + 2 * HOUR);
    expect(curator.calls).toBe(0);
  });

  test("Curator success and failure schedules are anchored at terminal time", async () => {
    const successClock = new FakeClock(7 * DAY);
    const successWorker: EvolutionSchedulerWorker = {
      async runOnce() {
        successClock.nowMs += HOUR;
        return { state: "completed", result: { state: "completed" } };
      },
    };
    const successScheduler = new EvolutionScheduler({
      enabled: true,
      clock: successClock,
      idleProbe: { isIdle: () => true },
      distillerWorker: new ScriptedWorker(),
      curatorWorker: successWorker,
      curatorScheduleEnqueuer: new ScriptedEnqueuer(),
      initialLastSuccessfulCuratorRunAtMs: 0,
      curatorIdleRequiredMs: 0,
    });
    await successScheduler.tick();
    expect(successScheduler.snapshot()).toMatchObject({
      lastSuccessfulCuratorRunAtMs: 7 * DAY + HOUR,
      nextCuratorEligibleAtMs: 14 * DAY + HOUR,
    });

    const failureClock = new FakeClock(7 * DAY);
    const failureWorker: EvolutionSchedulerWorker = {
      async runOnce() {
        failureClock.nowMs += HOUR;
        return { state: "failed" };
      },
    };
    const failureScheduler = new EvolutionScheduler({
      enabled: true,
      clock: failureClock,
      idleProbe: { isIdle: () => true },
      distillerWorker: new ScriptedWorker(),
      curatorWorker: failureWorker,
      curatorScheduleEnqueuer: new ScriptedEnqueuer(),
      initialLastSuccessfulCuratorRunAtMs: 0,
      curatorIdleRequiredMs: 0,
      failureBackoffBaseMs: 100,
      failureBackoffMaxMs: 1_000,
    });
    await failureScheduler.tick();
    expect(failureScheduler.snapshot().curatorRetryNotBeforeMs)
      .toBe(7 * DAY + HOUR + 100);
  });

  test("failed or late manual records cannot reset or move the cycle backwards", () => {
    const { scheduler } = setup({ nowMs: 10 * DAY, lastSuccessMs: 9 * DAY });
    scheduler.recordManualCuratorRun({ mode: "run", state: "failed" });
    scheduler.recordManualCuratorRun({
      mode: "run",
      state: "completed",
      completedAtMs: 8 * DAY,
    });
    expect(scheduler.snapshot().lastSuccessfulCuratorRunAtMs).toBe(9 * DAY);
  });

  test("missed cycles never accumulate catch-up runs", async () => {
    const curator = new ScriptedWorker([{ state: "completed" }, { state: "completed" }]);
    const { scheduler, clock } = setup({
      nowMs: 21 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      curator,
    });
    expect((await scheduler.tick()).curator).toEqual({ state: "completed" });
    expect(curator.calls).toBe(1);
    expect(scheduler.snapshot().nextCuratorEligibleAtMs).toBe(28 * DAY);

    clock.nowMs = 21 * DAY + 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "not_eligible" });
    expect(curator.calls).toBe(1);
  });

  test("request key is stable across restart while displayed bucket is Core canonical", async () => {
    const firstEnqueuer = new ScriptedEnqueuer();
    const first = setup({
      nowMs: 21 * DAY,
      lastSuccessMs: 14 * DAY,
      idleRequiredMs: 0,
      enqueuer: firstEnqueuer,
    });
    const firstTick = await first.scheduler.tick();
    expect(firstTick).toMatchObject({
      curatorScheduleBucket: "core:canonical-cycle",
      curator: { state: "idle" },
    });
    first.clock.nowMs += 1;
    expect((await first.scheduler.tick()).curatorScheduleBucket)
      .toBe("core:canonical-cycle");
    expect(firstEnqueuer.calls).toEqual([
      { requestKey: `scheduled:${21 * DAY}` },
      { requestKey: `scheduled:${21 * DAY}` },
    ]);

    const restoredEnqueuer = new ScriptedEnqueuer();
    const restored = setup({
      nowMs: first.clock.nowMs,
      idleRequiredMs: 0,
      restoreState: first.scheduler.snapshot(),
      enqueuer: restoredEnqueuer,
    });
    expect((await restored.scheduler.tick()).curatorScheduleBucket)
      .toBe("core:canonical-cycle");
    expect(restoredEnqueuer.calls).toEqual([
      { requestKey: `scheduled:${21 * DAY}` },
    ]);
  });

  test("already-completed uses the Core bucket and never enters the claim lane", async () => {
    const curator = new ScriptedWorker();
    const { scheduler } = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      curator,
      enqueuer: new ScriptedEnqueuer([
        scheduleResult("already_completed", "core:already-completed-cycle"),
      ]),
    });

    await expect(scheduler.tick()).resolves.toMatchObject({
      curatorScheduleBucket: "core:already-completed-cycle",
      curator: { state: "idle" },
    });
    expect(curator.calls).toBe(0);
  });

  test("ensure-only lane runs before scheduled claim and no_work never claims", async () => {
    const order: string[] = [];
    const enqueuer: EvolutionCuratorScheduleEnqueuer = {
      async ensureScheduledRun() {
        order.push("ensure");
        return scheduleResult("ready");
      },
    };
    const curator: EvolutionSchedulerWorker = {
      async runOnce() {
        order.push("claim");
        return { state: "idle" };
      },
    };
    const ready = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      enqueuer,
      curator,
    });
    await ready.scheduler.tick();
    expect(order).toEqual(["ensure", "claim"]);

    const noWorkCurator = new ScriptedWorker();
    const noWork = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      enqueuer: new ScriptedEnqueuer([scheduleResult("no_work")]),
      curator: noWorkCurator,
    });
    expect((await noWork.scheduler.tick()).curator).toEqual({ state: "idle" });
    expect(noWorkCurator.calls).toBe(0);
  });

  test("ensure failure enters terminal-time backoff without claiming", async () => {
    const clock = new FakeClock(7 * DAY);
    const curator = new ScriptedWorker();
    const enqueuer: EvolutionCuratorScheduleEnqueuer = {
      async ensureScheduledRun() {
        clock.nowMs += HOUR;
        throw new Error("ensure unavailable");
      },
    };
    const direct = new EvolutionScheduler({
      enabled: true,
      clock,
      idleProbe: { isIdle: () => true },
      distillerWorker: new ScriptedWorker(),
      curatorWorker: curator,
      curatorScheduleEnqueuer: enqueuer,
      initialLastSuccessfulCuratorRunAtMs: 0,
      curatorIdleRequiredMs: 0,
      failureBackoffBaseMs: 100,
      failureBackoffMaxMs: 1_000,
    });
    expect((await direct.tick()).curator).toEqual({ state: "failed" });
    expect(curator.calls).toBe(0);
    expect(direct.snapshot().curatorRetryNotBeforeMs).toBe(7 * DAY + HOUR + 100);
  });

  test("concurrent ticks are single-instance and never reenter workers", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const distiller: EvolutionSchedulerWorker = {
      async runOnce() {
        await barrier;
        return { state: "idle" };
      },
    };
    const { scheduler, idle, curator } = setup({ distiller });

    const first = scheduler.tick();
    await Promise.resolve();
    await expect(scheduler.tick()).resolves.toMatchObject({
      state: "busy",
      distiller: { state: "skipped", reason: "busy" },
      curator: { state: "skipped", reason: "busy" },
    });
    expect(idle.calls).toBe(0);
    expect((curator as ScriptedWorker).calls).toBe(0);
    release();
    await first;
  });

  test.each(["distiller", "probe", "ensure", "curator"] as const)(
    "abort interrupts a hung %s boundary without recording a failure",
    async (stage) => {
      let observedSignal: AbortSignal | undefined;
      const hung = async (signal?: AbortSignal): Promise<never> => {
        observedSignal = signal;
        return await new Promise<never>(() => {});
      };
      const scheduler = setup({
        nowMs: 7 * DAY,
        lastSuccessMs: 0,
        idleRequiredMs: 0,
        distiller: stage === "distiller"
          ? { runOnce: hung }
          : new ScriptedWorker(),
        idleProbe: stage === "probe"
          ? { isIdle: hung }
          : new FakeIdleProbe(),
        enqueuer: stage === "ensure"
          ? { ensureScheduledRun: async (_request, signal) => await hung(signal) }
          : new ScriptedEnqueuer(),
        curator: stage === "curator"
          ? { runOnce: hung }
          : new ScriptedWorker(),
      }).scheduler;
      const controller = new AbortController();
      const tick = scheduler.tick(controller.signal);
      const signal = await waitForSignal(() => observedSignal);

      controller.abort(new DOMException("test stop", "AbortError"));
      await expect(tick).rejects.toMatchObject({ name: "AbortError" });
      expect(signal.aborted).toBe(true);
      expect(scheduler.snapshot()).toMatchObject({
        running: false,
        distillerConsecutiveFailures: 0,
        curatorConsecutiveFailures: 0,
      });
    },
  );

  test("Curator failures use capped exponential backoff without granting eligibility", async () => {
    const curator = new ScriptedWorker([
      new Error("transient"),
      { state: "failed" },
      { state: "failed" },
      { state: "completed" },
    ]);
    const { scheduler, clock } = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      intervalMs: 1_000,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      curator,
    });

    expect((await scheduler.tick()).curator).toEqual({ state: "failed" });
    expect(scheduler.snapshot()).toMatchObject({
      curatorConsecutiveFailures: 1,
      curatorRetryNotBeforeMs: 7 * DAY + 100,
    });

    clock.nowMs += 99;
    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "backoff" });
    clock.nowMs += 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "failed" });
    expect(scheduler.snapshot().curatorRetryNotBeforeMs).toBe(7 * DAY + 300);

    clock.nowMs = 7 * DAY + 300;
    expect((await scheduler.tick()).curator).toEqual({ state: "failed" });
    expect(scheduler.snapshot().curatorRetryNotBeforeMs).toBe(7 * DAY + 700);

    clock.nowMs = 7 * DAY + 700;
    expect((await scheduler.tick()).curator).toEqual({ state: "completed" });
    expect(scheduler.snapshot()).toMatchObject({
      curatorConsecutiveFailures: 0,
      curatorRetryNotBeforeMs: null,
      lastSuccessfulCuratorRunAtMs: 7 * DAY + 700,
    });
  });

  test("failure backoff never bypasses the seven-day qualification", async () => {
    const curator = new ScriptedWorker([{ state: "failed" }]);
    const { scheduler, clock } = setup({
      nowMs: DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      backoffBaseMs: 100,
      backoffMaxMs: 1_000,
      curator,
    });

    expect((await scheduler.tick()).curator).toEqual({ state: "skipped", reason: "not_eligible" });
    expect(curator.calls).toBe(0);
    clock.nowMs = 7 * DAY - 1;
    await scheduler.tick();
    expect(curator.calls).toBe(0);
    clock.nowMs = 7 * DAY;
    expect((await scheduler.tick()).curator).toEqual({ state: "failed" });
    expect(curator.calls).toBe(1);
  });

  test("an idle Curator claim is no work: it does not reset the cycle or idle window", async () => {
    const curator = new ScriptedWorker([{ state: "idle" }, { state: "idle" }]);
    const { scheduler, clock } = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      idleRequiredMs: 0,
      curator,
    });

    expect((await scheduler.tick()).curator).toEqual({ state: "idle" });
    expect(scheduler.snapshot()).toMatchObject({
      lastSuccessfulCuratorRunAtMs: 0,
      idleSinceMs: 7 * DAY,
    });
    clock.nowMs += 1;
    expect((await scheduler.tick()).curator).toEqual({ state: "idle" });
    expect(curator.calls).toBe(2);
  });

  test("disabling breaks idle continuity before a later re-enable", async () => {
    const { scheduler, clock, curator } = setup({ nowMs: 7 * DAY, lastSuccessMs: 0 });
    await scheduler.tick();
    clock.nowMs += HOUR;
    scheduler.setEnabled(false);
    await expect(scheduler.tick()).resolves.toMatchObject({ state: "disabled" });
    scheduler.setEnabled(true);
    await scheduler.tick();
    clock.nowMs += CURATOR_IDLE_REQUIRED_MS - 1;
    await scheduler.tick();
    expect((curator as ScriptedWorker).calls).toBe(0);
    clock.nowMs += 1;
    await scheduler.tick();
    expect((curator as ScriptedWorker).calls).toBe(1);
  });

  test("snapshot restore preserves idle continuity and failure backoff", async () => {
    const distiller = new ScriptedWorker([{ state: "failed" }]);
    const first = setup({
      nowMs: 7 * DAY,
      lastSuccessMs: 0,
      distiller,
      backoffBaseMs: 1_000,
      backoffMaxMs: 1_000,
    });
    await first.scheduler.tick();
    const snapshot = first.scheduler.snapshot();
    expect(snapshot).toMatchObject({
      idleSinceMs: 7 * DAY,
      distillerConsecutiveFailures: 1,
      distillerRetryNotBeforeMs: 7 * DAY + 1_000,
    });

    const restoredDistiller = new ScriptedWorker([{ state: "completed" }]);
    const restored = setup({
      nowMs: 7 * DAY + HOUR,
      restoreState: snapshot,
      distiller: restoredDistiller,
      backoffBaseMs: 1_000,
      backoffMaxMs: 1_000,
    });
    const result = await restored.scheduler.tick();
    expect(result.distiller).toEqual({ state: "completed" });
    expect(result.curator).toEqual({ state: "skipped", reason: "idle_window" });
    expect(restored.scheduler.snapshot().idleSinceMs).toBe(7 * DAY);

    const blockedSnapshot: EvolutionSchedulerRestoreState = {
      ...snapshot,
      lastObservedAtMs: 7 * DAY,
      idleSinceMs: 7 * DAY,
    };
    const blocked = setup({
      nowMs: 7 * DAY + 999,
      restoreState: blockedSnapshot,
      distiller: new ScriptedWorker([{ state: "completed" }]),
      backoffBaseMs: 1_000,
      backoffMaxMs: 1_000,
    });
    expect((await blocked.scheduler.tick()).distiller)
      .toEqual({ state: "skipped", reason: "backoff" });
  });

  test("exposes timing controls only, with no DB, token, Connector, or governance surface", () => {
    const { scheduler } = setup();
    const surface = [
      ...Reflect.ownKeys(scheduler),
      ...Reflect.ownKeys(Object.getPrototypeOf(scheduler)),
    ].map(String).join(" ").toLowerCase();

    expect(Reflect.ownKeys(scheduler)).toEqual([]);
    expect(surface).toContain("tick");
    expect(surface).toContain("snapshot");
    expect(surface).not.toContain("connector");
    expect(surface).not.toContain("governance");
    expect(surface).not.toContain("database");
    expect(surface).not.toContain("token");
    expect(surface).not.toContain("lease");
  });
});
