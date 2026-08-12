/**
 * Synthia Core API — Bun.serve entry point
 *
 * Boots a `Bun.serve` HTTP server that routes every request through the
 * versioned `/api/v1` router. No new npm dependencies — `Bun.serve` and the
 * already-available `pg` pool are the only runtime requirements.
 */

import type { Pool } from "pg";
import type { ConnectorPort } from "./connector-port.ts";
import { routeApi } from "./router.ts";

export interface SynthiaServer {
  readonly port: number;
  readonly hostname: string;
  /** Stop the server, aborting in-flight connections. */
  readonly stop: () => void;
}

export interface SynthiaServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  /**
   * Connector port for the run/Job slice. Inject the production adapter built
   * from env via `createConnectorFromEnv()` (connector-adapter.ts):
   *
   *   const connector = await createConnectorFromEnv();
   *   startSynthiaServer(pool, { connector });
   *
   * When omitted, Job endpoints surface 503 capability_unavailable; every other
   * endpoint works unchanged. Tests inject a fake ConnectorPort directly.
   */
  readonly connector?: ConnectorPort;
}

export function startSynthiaServer(pool: Pool, opts: SynthiaServerOptions = {}): SynthiaServer {
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: (request: Request) => routeApi(request, pool, opts.connector),
  });
  return {
    port: server.port,
    hostname: server.hostname,
    stop: () => server.stop(true),
  };
}
