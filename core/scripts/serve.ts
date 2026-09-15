#!/usr/bin/env bun
/**
 * Synthia Core API server launcher.
 *
 *   DATABASE_URL=postgres://... [PORT=8787] bun run core/scripts/serve.ts
 *
 * Connector port is built from env when Cloudflare credentials are present
 * (SYNTHIA_CF_ACCESS_CLIENT_ID / SYNTHIA_CF_ACCESS_CLIENT_SECRET /
 * SYNTHIA_CONNECTOR_CONFIG); without them the server still starts and the
 * Job endpoints answer 503 capability_unavailable.
 * Historical-material writes require SYNTHIA_FEATURE_HISTORICAL_MATERIALS=1
 * (or true); unset/0/false keeps the capability read-only.
 * Side-task workspace/adoption writes require SYNTHIA_FEATURE_SIDE_TASKS=1.
 * Self-evolution (learned skills) requires SYNTHIA_FEATURE_SELF_EVOLUTION=1.
 */
import { Pool } from "pg";
import { startSynthiaServer } from "../src/api/server.ts";
import { createConnectorFromEnv } from "../src/api/connector-adapter.ts";
import { resolveCoreFeatureFlags } from "../src/api/feature-flags.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Expected: postgres://user:pass@host:5432/synthia");
  process.exit(1);
}

// H1: a silent death with an empty log is the worst failure shape — both Core
// and Runtime exited without a trace during the C-series runs. Anything that
// escapes the server loop lands here and is journaled before the exit.
process.on("uncaughtException", (err) => {
  console.error("[core] uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[core] unhandled rejection:", reason);
});

const features = resolveCoreFeatureFlags({ env: process.env });
const pool = new Pool({ connectionString: DATABASE_URL });
const connector = await createConnectorFromEnv({ env: process.env });
const server = startSynthiaServer(pool, {
  port: process.env.PORT ? Number(process.env.PORT) : 8787,
  connector,
  features,
});
console.log(
  `[core] api listening on :${server.port} connector=${connector ? "configured" : "unavailable"}`
  + ` historical_materials=${features.historicalMaterials ? "enabled" : "disabled"}`
  + ` side_tasks=${features.sideTasks ? "enabled" : "disabled"}`
  + ` self_evolution_rollout=${features.selfEvolution ? "enabled" : "disabled"}`,
);
