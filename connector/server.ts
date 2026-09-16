import { createServer, type Server } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { WorkerRuntime, type WorkerExecution, type WorkerRuntimeOptions, type WorkerExecutionResult } from "./worker.ts";
import { createVivadoProcessGuardian, VivadoBatchAdapter, VIVADO_CAPABILITIES, type VivadoRequest } from "./vivado.ts";
import type { JobRequest } from "./index.ts";
import { REMOTE_SCHEMA_VERSION, type ConnectorEndpoint, type DiscoverySnapshot } from "./remote.ts";
import { canonicalRequestHash } from "../core/src/hashing.ts";

// The discovery wire contract is the three-key ConnectorCapability shape;
// server-internal CapabilityDefinition fields must not leak onto the wire.
const DISCOVERY_CAPABILITIES: readonly { operation: string; version: string; runClasses: readonly string[] }[] = Object.freeze(
  VIVADO_CAPABILITIES.map((capability) => ({
    operation: capability.operation,
    version: capability.version,
    runClasses: Object.freeze([...capability.runClasses]),
  })),
);

export interface WorkerConfig extends ConnectorEndpoint {
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

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const execFileAsync = promisify(execFile);

function boundedIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}

/**
 * Keep the outer Connector request and the inner Vivado request on one
 * identity. Legacy exploratory requests may omit the newer inputHash member,
 * but may never provide a conflicting one. Formal requests must bind both the
 * immutable input hash and the discovered toolchain profile exactly.
 */
export function workerRequestBindingMatches(
  request: JobRequest,
  candidate: unknown,
  toolchainProfileHash: string,
  configured?: { readonly vivadoBinary: string; readonly part: string },
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const binding = candidate as Record<string, unknown>;
  const identityBinding = binding.jobId === request.jobId
    && binding.projectId === request.projectId
    && binding.operation === request.operation
    && binding.runClass === request.runClass;
  const inputBinding = request.runClass === "formal"
    ? binding.inputHash === request.input
    : binding.inputHash === undefined || binding.inputHash === request.input;
  const toolchainBinding = request.runClass !== "formal"
    || binding.toolchainHash === toolchainProfileHash;
  const nested = binding.toolchain === undefined
    ? undefined
    : binding.toolchain && typeof binding.toolchain === "object" && !Array.isArray(binding.toolchain)
      ? binding.toolchain as Record<string, unknown>
      : null;
  if (nested === null) return false;
  const profileBinding = nested?.profileHash === undefined || nested.profileHash === toolchainProfileHash;
  const configuredBinding = configured === undefined || (
    (nested?.vivadoBinary === undefined || nested.vivadoBinary === configured.vivadoBinary)
    && (nested?.part === undefined || nested.part === configured.part)
    && (binding.part === undefined || binding.part === configured.part)
  );
  return identityBinding && inputBinding && toolchainBinding && profileBinding && configuredBinding;
}

function validateWorkerConfig(config: WorkerConfig): WorkerConfig {
  for (const name of ["connector_id", "endpoint_url", "protocol_version", "transport_mode", "auth_mode", "workspace_root", "evidence_root", "server_certificate_path", "server_private_key_path", "trusted_client_ca_path", "vivado_binary", "vivado_part", "toolchain_profile_hash", "part_catalog_hash", "sdk_worker_build_hash"] as const) required(config[name], name);
  if (config.protocol_version !== REMOTE_SCHEMA_VERSION || config.transport_mode !== "direct_https" || config.auth_mode !== "mtls") throw new Error("CONFIG_INVALID:protocol");
  if (!Number.isInteger(config.listen_port) || config.listen_port < 1 || config.listen_port > 65535) throw new Error("CONFIG_INVALID:listen_port");
    return config;
}

async function readWorkerConfig(path: string): Promise<{ config: WorkerConfig; sha256: string }> {
  const bytes = await readFile(path);
  return {
    config: validateWorkerConfig(JSON.parse(bytes.toString("utf8")) as WorkerConfig),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function loadWorkerConfig(path = process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json"): Promise<WorkerConfig> {
  return (await readWorkerConfig(path)).config;
}

export async function verifyWorkerReleaseManifest(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const plain = (candidate: unknown): candidate is Record<string, unknown> => (
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
  );
  const exact = (candidate: unknown, expected: readonly string[]): candidate is Record<string, unknown> => (
    plain(candidate)
    && Object.keys(candidate).sort().length === expected.length
    && Object.keys(candidate).sort().every((key, index) => key === [...expected].sort()[index])
  );
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "bundle",
    "expected",
    "git_commit",
    "git_status_sha256",
    "manifest_hash",
    "release_files",
    "runtime",
    "schema",
    "source_state",
    "sources",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("RELEASE_MANIFEST_INVALID:shape");
  }
  if (value.schema !== "synthia-worker-release-manifest.v1"
    || typeof value.git_commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.git_commit)
    || (value.source_state !== "clean" && value.source_state !== "dirty")
    || typeof value.git_status_sha256 !== "string" || !HASH_PATTERN.test(value.git_status_sha256)
    || (value.source_state === "clean" && value.git_status_sha256 !== createHash("sha256").update("").digest("hex"))
    || (value.source_state === "dirty" && value.git_status_sha256 === createHash("sha256").update("").digest("hex"))
    || !exact(value.bundle, ["path", "size_bytes", "sha256"])
    || value.bundle.path !== "server.bundle.mjs"
    || !Number.isSafeInteger(value.bundle.size_bytes) || Number(value.bundle.size_bytes) < 1
    || typeof value.bundle.sha256 !== "string" || !HASH_PATTERN.test(value.bundle.sha256)
    || !exact(value.runtime, ["kind", "version", "executable_name", "sha256"])
    || value.runtime.kind !== "bun" || value.runtime.version !== "1.4.1" || value.runtime.executable_name !== "bun.exe"
    || typeof value.runtime.sha256 !== "string" || !HASH_PATTERN.test(value.runtime.sha256)
    || !exact(value.release_files, ["config_template_sha256", "launcher_sha256", "windows_certifier_sha256"])
    || Object.values(value.release_files).some((hash) => typeof hash !== "string" || !HASH_PATTERN.test(hash))) {
    throw new Error("RELEASE_MANIFEST_INVALID:shape");
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1) throw new Error("RELEASE_MANIFEST_INVALID:sources");
  const sourcePaths: string[] = [];
  for (const source of value.sources) {
    if (!exact(source, ["path", "sha256"])
      || !boundedIdentity(source.path, 512)
      || source.path.startsWith("/")
      || source.path.includes("\\")
      || !/^[\x20-\x7e]+$/.test(source.path)
      || source.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || typeof source.sha256 !== "string" || !HASH_PATTERN.test(source.sha256)) {
      throw new Error("RELEASE_MANIFEST_INVALID:sources");
    }
    sourcePaths.push(source.path);
  }
  if (sourcePaths.some((source, index) => index > 0 && sourcePaths[index - 1]! >= source)) {
    throw new Error("RELEASE_MANIFEST_INVALID:sources");
  }
  if (!exact(value.expected, [
    "capabilities",
    "capability_map_version",
    "part",
    "part_catalog_hash",
    "protocol_version",
    "sdk_worker_build_hash",
    "toolchain_profile_hash",
    "vivado_patch",
    "vivado_version",
  ])
    || value.expected.protocol_version !== "connector.remote.v1"
    || value.expected.sdk_worker_build_hash !== value.bundle.sha256
    || !boundedIdentity(value.expected.capability_map_version, 128)
    || typeof value.expected.part_catalog_hash !== "string" || !HASH_PATTERN.test(value.expected.part_catalog_hash)
    || typeof value.expected.toolchain_profile_hash !== "string" || !HASH_PATTERN.test(value.expected.toolchain_profile_hash)
    || !boundedIdentity(value.expected.vivado_version, 64)
    || !boundedIdentity(value.expected.vivado_patch, 64)
    || !boundedIdentity(value.expected.part, 128)
    || !Array.isArray(value.expected.capabilities) || value.expected.capabilities.length === 0) {
    throw new Error("RELEASE_MANIFEST_INVALID:expected");
  }
  let previousOperation = "";
  for (const capability of value.expected.capabilities) {
    const runClasses = capability && typeof capability === "object"
      && "run_classes" in capability && Array.isArray(capability.run_classes)
      ? capability.run_classes as unknown[]
      : undefined;
    if (!exact(capability, ["operation", "run_classes", "version"])
      || typeof capability.operation !== "string" || !OPAQUE_ID_PATTERN.test(capability.operation)
      || capability.operation <= previousOperation
      || typeof capability.version !== "string" || !OPAQUE_ID_PATTERN.test(capability.version)
      || !runClasses || runClasses.length === 0
      || runClasses.some((runClass, index) => typeof runClass !== "string"
        || !OPAQUE_ID_PATTERN.test(runClass)
        || (index > 0 && typeof runClasses[index - 1] === "string"
          && (runClasses[index - 1] as string) >= runClass))) {
      throw new Error("RELEASE_MANIFEST_INVALID:capabilities");
    }
    previousOperation = capability.operation;
  }
  const manifestHash = value.manifest_hash;
  if (typeof manifestHash !== "string" || !HASH_PATTERN.test(manifestHash)) {
    throw new Error("RELEASE_MANIFEST_INVALID:manifest_hash");
  }
  const body = { ...value };
  delete body.manifest_hash;
  if (canonicalRequestHash(body) !== manifestHash) {
    throw new Error("RELEASE_MANIFEST_INVALID:canonical_hash");
  }
  return manifestHash;
}

function execution(
  config: WorkerConfig,
  identity: {
    readonly activeConfigSha256: string;
    readonly workerProcessInstanceId: string;
  },
): WorkerExecution {
  const adapter = new VivadoBatchAdapter({ workspaceRoot: config.workspace_root, binary: config.vivado_binary, part: config.vivado_part, profileHash: config.toolchain_profile_hash });
  return {
    async discover(): Promise<DiscoverySnapshot> {
      const remoteAttestation = {
        active_config_sha256: identity.activeConfigSha256,
        worker_process_instance_id: identity.workerProcessInstanceId,
      };
      try { await access(config.vivado_binary, constants.X_OK); } catch { return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_binary"] }; }
      return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "2021.1", vivado_patch: "3247384", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, ...remoteAttestation, capabilities: DISCOVERY_CAPABILITIES, toolchain_profile_hash: config.toolchain_profile_hash, license_status: "available" };
    },
    async execute(request: JobRequest, _workspace: string): Promise<WorkerExecutionResult> {
      const candidate = (request as JobRequest & { parameters?: unknown }).parameters;
      if (!candidate || typeof candidate !== "object") return { outcome: "failure", error_code: "VIVADO_PARAMETERS_REQUIRED", output: JSON.stringify({ status: "rejected", errorCode: "VIVADO_PARAMETERS_REQUIRED" }), evidence: { jobId: request.jobId ?? "worker", entries: [] } };
      if (!workerRequestBindingMatches(request, candidate, config.toolchain_profile_hash, { vivadoBinary: config.vivado_binary, part: config.vivado_part })) {
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: "FORMAL_BINDING_MISMATCH", output: JSON.stringify({ status: "rejected", jobId, errorCode: "FORMAL_BINDING_MISMATCH" }), evidence: { jobId, entries: [] } };
      }
      const vivadoRequest = {
        ...candidate as VivadoRequest,
        toolchain: {
          requiredLicense: (candidate as VivadoRequest).toolchain?.requiredLicense,
          vivadoBinary: config.vivado_binary,
          part: config.vivado_part,
          profileHash: config.toolchain_profile_hash,
        },
      } as VivadoRequest;
      let result;
      try {
        result = await adapter.execute(vivadoRequest);
      } catch (error) {
        const message = error instanceof Error ? error.message : "VIVADO_EXECUTION_ERROR";
        const errorCode = message.startsWith("VIVADO_POLICY_REJECTED:") ? message : "VIVADO_EXECUTION_ERROR";
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: errorCode, output: JSON.stringify({ status: "rejected", jobId, errorCode }), evidence: { jobId, entries: [] } };
      }
      const outcome = result.status === "succeeded" ? "success" : result.status === "timeout" ? "timeout" : result.status === "lost" ? "lost" : result.status === "unknown_effect" ? "unknown_effect" : "failure";
      const meta: Record<string, unknown> = { jobId: result.jobId, operation: result.operation, status: result.status, command: result.command, inputSha256: result.inputSha256, workspace: result.workspace, toolchain: result.toolchain };
      if (result.exitCode !== undefined) meta.exitCode = result.exitCode;
      if (result.phase !== undefined) meta.phase = result.phase;
      if (result.phaseExitCode !== undefined) meta.phaseExitCode = result.phaseExitCode;
      if (result.simulatorStdout !== undefined) meta.simulatorStdout = result.simulatorStdout;
      if (result.logDigest !== undefined) meta.logDigest = result.logDigest;
      if (result.stdout !== undefined) meta.stdout = result.stdout;
      if (result.stderr !== undefined) meta.stderr = result.stderr;
      if (result.errorCode !== undefined) meta.errorCode = result.errorCode;
      if (result.timeoutMs !== undefined) meta.timeoutMs = result.timeoutMs;
      if (result.timedOut !== undefined) meta.timedOut = result.timedOut;
      if (result.signal !== undefined) meta.signal = result.signal;
      if (result.unsupportedReason !== undefined) meta.unsupportedReason = result.unsupportedReason;
      if (result.output && typeof result.output === "object") { const o = result.output as { stdout?: unknown; stderr?: unknown }; if (o.stdout !== undefined) meta.output = o; }
      const errorCode = result.errorCode ?? (result.status === "unsupported" ? (result.unsupportedReason ?? "VIVADO_UNSUPPORTED") : undefined);
      return { outcome, error_code: errorCode, output: JSON.stringify(meta, null, 2), evidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export async function startWorker(configPath?: string): Promise<{ server: Server; config: WorkerConfig }> {
  const resolvedConfigPath = configPath ?? process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json";
  const loaded = await readWorkerConfig(resolvedConfigPath);
  const config = loaded.config;
  const workerProcessInstanceId = randomUUID();
  if (process.env.SYNTHIA_WORKER_VERIFY_BUNDLE === "1") {
    await verifyConfiguredBundleIdentity(config, process.argv[1] ?? "");
  }
  const privateKey = config.server_private_key_path.toLowerCase().endsWith(".pfx") || config.server_private_key_path.toLowerCase().endsWith(".p12");
  const tls = privateKey ? { pfx: await readFile(config.server_private_key_path), passphrase: required(process.env.SYNTHIA_WORKER_PFX_PASSWORD, "SYNTHIA_WORKER_PFX_PASSWORD"), ca: await readFile(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true } : { cert: await readFile(config.server_certificate_path), key: await readFile(config.server_private_key_path), ca: await readFile(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true };
  const options: WorkerRuntimeOptions = {
    endpoint: config,
    workspaceRoot: config.workspace_root,
    execution: execution(config, {
      activeConfigSha256: loaded.sha256,
      workerProcessInstanceId,
    }),
  };
  const runtime = new WorkerRuntime(options);
  const handler = runtime.handle.bind(runtime);
  const server = createServer(tls, async (req, res) => {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      received += bytes.byteLength;
      chunks.push(bytes);
    }
    const request = new Request(`https://${req.headers.host ?? `${config.listen_host}:${config.listen_port}`}${req.url ?? "/"}`, { method: req.method, headers: Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"), body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen_port, config.listen_host, resolve); });
  return { server, config };
}

if (import.meta.main) {
  const [command, configPath, outputPath] = process.argv.slice(2);
  const run = command === "--verify-release-manifest"
      ? verifyWorkerReleaseManifest(configPath ?? "")
          .then((hash) => console.log(`synthia-worker release manifest verified hash=${hash}`))
    : command === undefined
      ? startWorker().then(({ config }) => console.log(`synthia-worker listening on ${config.listen_host}:${config.listen_port} connector=${config.connector_id}`))
      : Promise.reject(new Error("CONFIG_INVALID:command"));
  run.catch(error => { console.error(`synthia-worker failed: ${error instanceof Error ? error.message : "startup"}`); process.exitCode = 1; });
}
