import { createServer, type Server } from "node:https";
import { readFile } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WorkerRuntime, type WorkerExecution, type WorkerRuntimeOptions, type WorkerExecutionResult } from "./worker.ts";
import { VivadoBatchAdapter, VIVADO_CAPABILITIES, VIVADO_CAPABILITY_VERSION, type VivadoRequest } from "./vivado.ts";
import { REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type DiscoverySnapshot, type JobRequest } from "./remote.ts";

interface WorkerConfig extends ConnectorEndpoint {
  listen_host: string;
  listen_port: number;
  server_certificate_path: string;
  server_private_key_path: string;
  trusted_client_ca_path: string;
  workspace_root: string;
  evidence_root: string;
  vivado_binary: string;
  vivado_part: string;
  vivado_install_identity: string;
  capability_map_version: string;
  part_catalog_hash: string;
  sdk_worker_build_hash: string;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}

async function loadConfig(path = process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json"): Promise<WorkerConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as WorkerConfig;
  for (const name of ["connector_id", "endpoint_url", "protocol_version", "transport_mode", "auth_mode", "workspace_root", "server_certificate_path", "server_private_key_path", "trusted_client_ca_path", "vivado_binary", "vivado_part", "toolchain_profile_hash", "part_catalog_hash", "sdk_worker_build_hash"] as const) required(config[name], name);
  if (config.protocol_version !== REMOTE_SCHEMA_VERSION || config.transport_mode !== "direct_https" || config.auth_mode !== "mtls") throw new Error("CONFIG_INVALID:protocol");
  if (!Number.isInteger(config.listen_port) || config.listen_port < 1 || config.listen_port > 65535) throw new Error("CONFIG_INVALID:listen_port");
  return config;
}

function execution(config: WorkerConfig): WorkerExecution {
  const adapter = new VivadoBatchAdapter({ workspaceRoot: config.workspace_root, binary: config.vivado_binary });
  return {
    async discover(): Promise<DiscoverySnapshot> {
      try { await access(config.vivado_binary, constants.X_OK); } catch { return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_binary"] }; }
      return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "2021.1", vivado_patch: "3247384", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, capabilities: VIVADO_CAPABILITIES, toolchain_profile_hash: config.toolchain_profile_hash, license_status: "available" };
    },
    async execute(request: JobRequest, _workspace: string): Promise<WorkerExecutionResult> {
      const candidate = (request as JobRequest & { parameters?: unknown }).parameters;
      if (!candidate || typeof candidate !== "object") return { outcome: "failure", error_code: "VIVADO_PARAMETERS_REQUIRED" };
      const result = await adapter.execute(candidate as VivadoRequest);
      if (result.status === "unsupported") return { outcome: "failure", error_code: result.unsupportedReason ?? "VIVADO_UNSUPPORTED" };
      return { outcome: result.status === "succeeded" ? "success" : "failure", output: JSON.stringify({ command: result.command, inputSha256: result.inputSha256, workspace: result.workspace, toolchain: result.toolchain }), evidence: result.evidence };
    },
  };
}

export async function startWorker(configPath?: string): Promise<{ server: Server; config: WorkerConfig }> {
  const config = await loadConfig(configPath);
  const privateKey = config.server_private_key_path.toLowerCase().endsWith(".pfx") || config.server_private_key_path.toLowerCase().endsWith(".p12");
  const tls = privateKey ? { pfx: await readFile(config.server_private_key_path), passphrase: required(process.env.SYNTHIA_WORKER_PFX_PASSWORD, "SYNTHIA_WORKER_PFX_PASSWORD"), ca: await readFile(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true } : { cert: await readFile(config.server_certificate_path), key: await readFile(config.server_private_key_path), ca: await readFile(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true };
  const options: WorkerRuntimeOptions = { endpoint: config, workspaceRoot: config.workspace_root, execution: execution(config) };
  const runtime = new WorkerRuntime(options);
  const handler = runtime.handle.bind(runtime);
  const server = createServer(tls, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new Request(`https://${req.headers.host ?? `${config.listen_host}:${config.listen_port}`}${req.url ?? "/"}`, { method: req.method, headers: Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"), body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen_port, config.listen_host, resolve); });
  return { server, config };
}

if (import.meta.main) {
  startWorker().then(({ config }) => console.log(`synthia-worker listening on ${config.listen_host}:${config.listen_port} connector=${config.connector_id}`)).catch(error => { console.error(`synthia-worker failed: ${error instanceof Error ? error.message : "startup"}`); process.exitCode = 1; });
}
