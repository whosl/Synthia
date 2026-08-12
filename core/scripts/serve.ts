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
 */
import { Pool } from "pg";
import { startSynthiaServer } from "../src/api/server.ts";
import { createConnectorFromEnv } from "../src/api/connector-adapter.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Expected: postgres://user:pass@host:5432/synthia");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const connector = await createConnectorFromEnv();
const server = startSynthiaServer(pool, {
  port: process.env.PORT ? Number(process.env.PORT) : 8787,
  connector,
});
console.log(`[core] api listening on :${server.port} connector=${connector ? "configured" : "unavailable"}`);
