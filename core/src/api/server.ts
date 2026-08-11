/**
 * Synthia Core API — Bun.serve entry point
 *
 * Boots a `Bun.serve` HTTP server that routes every request through the
 * versioned `/api/v1` router. No new npm dependencies — `Bun.serve` and the
 * already-available `pg` pool are the only runtime requirements.
 */

import type { Pool } from "pg";
import { routeApi } from "./router.ts";

export interface SynthiaServer {
  readonly port: number;
  readonly hostname: string;
  /** Stop the server, aborting in-flight connections. */
  stop: () => void;
}

export function startSynthiaServer(pool: Pool, opts: { port?: number; hostname?: string } = {}): SynthiaServer {
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: (request: Request) => routeApi(request, pool),
  });
  return {
    port: server.port,
    hostname: server.hostname,
    stop: () => server.stop(true),
  };
}
