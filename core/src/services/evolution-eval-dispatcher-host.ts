export interface EvolutionEvalDispatcherHostOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly tick: () => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

export interface EvolutionEvalDispatcherHost {
  readonly enabled: boolean;
  readonly stop: () => Promise<void>;
}

export function validateEvolutionEvalDispatcherHostOptions(
  options: EvolutionEvalDispatcherHostOptions,
): void {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 10 || options.intervalMs > 300_000) {
    throw new TypeError("evolution-eval dispatcher interval must be between 10 and 300000 ms");
  }
}

/**
 * Runs one bounded dispatcher tick at a time. The next timer is installed only
 * after the current tick settles, so a slow Connector can never create an
 * overlapping claim lane. Disabled hosts install no timer and perform no DB or
 * Connector work.
 */
export function startEvolutionEvalDispatcherHost(
  options: EvolutionEvalDispatcherHostOptions,
): EvolutionEvalDispatcherHost {
  validateEvolutionEvalDispatcherHostOptions(options);

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const schedule = (delayMs: number): void => {
    if (!options.enabled || stopping || timer !== null || inFlight !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopping) return;
      inFlight = Promise.resolve()
        .then(options.tick)
        .then(() => undefined)
        .catch((error: unknown) => {
          options.onError?.(error);
        })
        .finally(() => {
          inFlight = null;
          schedule(options.intervalMs);
        });
    }, delayMs);
  };

  schedule(0);

  return {
    enabled: options.enabled,
    stop: async () => {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}
