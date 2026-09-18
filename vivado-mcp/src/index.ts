import { parseConfig, VivadoMcpConfigError } from "./config.ts";
import { VIVADO_MCP_ENDPOINT, createServer } from "./server.ts";

let config;
try {
  config = parseConfig(process.env);
} catch (error) {
  if (error instanceof VivadoMcpConfigError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}

const server = createServer(config);
await server.start({
  transportType: "httpStream",
  httpStream: { host: config.host, port: config.port, endpoint: VIVADO_MCP_ENDPOINT, stateless: true },
});
console.log(`vivado-mcp listening on http://${config.host}:${config.port}${VIVADO_MCP_ENDPOINT} (Bearer token required)`);

const shutdown = (): void => {
  console.log("vivado-mcp shutting down");
  void server.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
