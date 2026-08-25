/**
 * Synthia Core API — Bun.serve entry point
 *
 * Boots a `Bun.serve` HTTP server that routes every request through the
 * versioned `/api/v1` router. No new npm dependencies — `Bun.serve` and the
 * already-available `pg` pool are the only runtime requirements.
 */

import type { Pool } from "pg";
import type { ConnectorPort } from "./connector-port.ts";
import { createRuntimeClientFromEnv, type RuntimeClient } from "./task-proxy.ts";
import {
  resolveCoreFeatureFlags,
  type CoreFeatureFlags,
} from "./feature-flags.ts";
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
  /**
   * Runtime client for the task-workbench slice. When omitted the server builds
   * one from env (SYNTHIA_RUNTIME_URL, default http://127.0.0.1:8790); set
   * SYNTHIA_RUNTIME_URL="none" to disable (task endpoints → 503). Tests inject
   * a fake RuntimeClient directly.
   */
  readonly runtimeClient?: RuntimeClient;
  /**
   * Authenticated service uid expected on Runtime task callbacks. Defaults to
   * SYNTHIA_RUNTIME_ACTOR_ID, then `synthia-runtime`.
   */
  readonly runtimeActorId?: string;
  /**
   * Explicit Core feature overrides. P2/P3/P4 writes default off; when omitted,
   * SYNTHIA_FEATURE_HISTORICAL_MATERIALS, SYNTHIA_FEATURE_SIDE_TASKS, and
   * SYNTHIA_FEATURE_FORMAL_DELIVERY are parsed strictly.
   */
  readonly features?: Readonly<Partial<CoreFeatureFlags>>;
}

export function startSynthiaServer(pool: Pool, opts: SynthiaServerOptions = {}): SynthiaServer {
  const runtimeClient = opts.runtimeClient ?? createRuntimeClientFromEnv();
  const runtimeActorId = resolveRuntimeActorId(
    opts.runtimeActorId ?? process.env.SYNTHIA_RUNTIME_ACTOR_ID,
  );
  const featureFlags = resolveCoreFeatureFlags({ features: opts.features });
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    // Bun 默认 idleTimeout=10s。SSE 透传（GET …/tasks/:agentId/stream）在模型
    // 推理静默期会超过它而被掐断，浏览器于是陷入 ~10 秒一次的重连回放循环，
    // 流式输出永远渲染不出来。放到 Bun 上限，保活由 Runtime 的心跳负责。
    idleTimeout: 255,
    fetch: (request: Request) => routeApi(
      request,
      pool,
      opts.connector,
      runtimeClient,
      featureFlags,
      runtimeActorId,
    ),
  });
  return {
    port: server.port ?? (opts.port ?? 0),
    hostname: server.hostname ?? (opts.hostname ?? "127.0.0.1"),
    stop: () => server.stop(true),
  };
}

function resolveRuntimeActorId(raw: string | undefined): string {
  const actorId = (raw ?? "synthia-runtime").trim();
  if (
    actorId.length === 0
    || actorId.length > 255
    || /[\u0000-\u001f\u007f]/.test(actorId)
  ) {
    throw new TypeError("SYNTHIA_RUNTIME_ACTOR_ID must be a non-empty service uid");
  }
  return actorId;
}
