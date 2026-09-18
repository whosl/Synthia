/**
 * Runtime polyfills for the Node target (core bundles ship as
 * `bun build --target=node`; Node 20 predates a few APIs Bun/Node 22 have).
 * Import for side effects from bundle entry points only.
 */

interface WithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function") {
  (Promise as unknown as { withResolvers: <T>() => WithResolvers<T> }).withResolvers =
    function withResolvers<T>(this: PromiseConstructor): WithResolvers<T> {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
}
