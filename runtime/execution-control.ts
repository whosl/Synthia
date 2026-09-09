/** Stop local continuation without claiming that an in-flight remote job stopped. */
export function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** All service calls in a loop share one cancellation boundary, including formal flow. */
export function guardExecution<T extends object>(service: T, signal: AbortSignal): T {
  return new Proxy(service, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]) => abortable(() => value.apply(target, args), signal)
        : value;
    },
  });
}
