/** Bound only a pending model request; callers never wrap tool execution. */
export class ModelWatchdogError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`model request stalled without conversation persistence for ${timeoutMs}ms`);
    this.name = "ModelWatchdogError";
  }
}

export function modelWatchdogMs(env = process.env): number {
  const minutes = Number(env.SYNTHIA_MODEL_WATCHDOG_MINUTES?.trim() || 15);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 15 * 60_000;
}

export async function watchModelRequest<T>(
  call: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  lastPersistedAt: () => number,
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new Error("model request aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const check = (): void => {
      const remaining = timeoutMs - (Date.now() - Math.max(startedAt, lastPersistedAt()));
      if (remaining <= 0) controller.abort(new ModelWatchdogError(timeoutMs));
      else timer = setTimeout(check, remaining);
    };
    if (timeoutMs > 0 && !controller.signal.aborted) timer = setTimeout(check, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
