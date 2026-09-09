import { describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { startSynthiaServer } from "../src/api/server.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition was not reached");
}

describe("evolution-eval dispatcher server lifecycle", () => {
  test("rejects invalid host configuration before opening an HTTP listener", () => {
    const pool = new Pool({ connectionString: "postgres://unused" });
    expect(() => startSynthiaServer(pool, {
      port: 0,
      evolutionEvalDispatcher: {
        enabled: true,
        intervalMs: 0,
        tick: async () => undefined,
      },
    })).toThrow("interval must be between 10 and 300000 ms");
    void pool.end();
  });

  test("is default-off and performs no background work", async () => {
    const pool = new Pool({ connectionString: "postgres://unused" });
    const server = startSynthiaServer(pool, { port: 0 });
    await Bun.sleep(20);
    await server.stopAsync();
    await pool.end();
  });

  test("runs one explicitly enabled bounded tick at a time", async () => {
    const pool = new Pool({ connectionString: "postgres://unused" });
    const release = deferred();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const server = startSynthiaServer(pool, {
      port: 0,
      evolutionEvalDispatcher: {
        enabled: true,
        intervalMs: 10,
        tick: async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (calls === 1) await release.promise;
          active -= 1;
        },
      },
    });
    await eventually(() => calls === 1);
    await Bun.sleep(25);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
    release.resolve();
    await eventually(() => calls >= 2);
    await server.stopAsync();
    const stoppedAt = calls;
    await Bun.sleep(25);
    expect(calls).toBe(stoppedAt);
    expect(maxActive).toBe(1);
    await pool.end();
  });

  test("graceful stop rejects new ticks and awaits the current tick", async () => {
    const pool = new Pool({ connectionString: "postgres://unused" });
    const release = deferred();
    let calls = 0;
    const server = startSynthiaServer(pool, {
      port: 0,
      evolutionEvalDispatcher: {
        enabled: true,
        intervalMs: 10,
        tick: async () => {
          calls += 1;
          await release.promise;
        },
      },
    });
    await eventually(() => calls === 1);
    let stopped = false;
    const stopping = server.stopAsync().then(() => {
      stopped = true;
    });
    await Bun.sleep(15);
    expect(stopped).toBe(false);
    expect(calls).toBe(1);
    release.resolve();
    await stopping;
    await Bun.sleep(20);
    expect(calls).toBe(1);
    await pool.end();
  });
});
