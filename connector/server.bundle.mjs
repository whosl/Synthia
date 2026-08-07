import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// connector/server.ts
import { createServer } from "node:https";
import { readFile as readFile2 } from "node:fs/promises";
import { access as access2, constants as constants2 } from "node:fs/promises";

// connector/worker.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// core/src/hashing.ts
import { createHash, randomUUID } from "node:crypto";
function sha256Hex(data) {
  const h = createHash("sha256");
  if (typeof data === "string") {
    h.update(data, "utf8");
  } else {
    h.update(data);
  }
  return h.digest("hex");
}
var sha256 = sha256Hex;

// connector/remote.ts
var REMOTE_SCHEMA_VERSION = "connector.remote.v1";

// connector/worker.ts
var terminal = new Set(["succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect"]);
var idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var classes = ["public", "internal", "confidential", "restricted"];
var unavailableExecution = {
  async discover() {
    return { connector_id: "unavailable", connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: "none", vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: "unavailable", sdk_worker_build_hash: "unavailable", capabilities: [], toolchain_profile_hash: "unavailable", license_status: "unknown", unsupported: ["vivado_discovery", "vivado_execution"] };
  },
  async execute() {
    return { outcome: "failure", error_code: "UNSUPPORTED_VIVADO" };
  }
};
function good(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function responseError(code, message, status) {
  return Response.json({ error_code: code, message }, { status });
}
function copy(v) {
  return structuredClone(v);
}

class WorkerRuntime {
  endpoint;
  root;
  execution;
  clock;
  registration;
  discovery;
  active = 0;
  jobs = new Map;
  keys = new Map;
  pending = [];
  constructor(o) {
    this.endpoint = copy(o.endpoint);
    this.root = o.workspaceRoot;
    this.execution = o.execution ?? unavailableExecution;
    this.clock = o.now ?? (() => new Date);
    if (!idRe.test(this.endpoint.connector_id) || this.endpoint.protocol_version !== REMOTE_SCHEMA_VERSION || this.endpoint.max_concurrency < 1)
      throw new Error("CONFIG_INVALID");
  }
  async handle(request) {
    if (request.method !== "POST")
      return responseError("METHOD_NOT_ALLOWED", "POST required", 405);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
      return responseError("UNSUPPORTED_MEDIA_TYPE", "application/json required", 415);
    let e;
    try {
      e = await request.json();
    } catch {
      return responseError("INVALID_JSON", "request body must be JSON", 400);
    }
    const invalid = this.validateEnvelope(e);
    if (invalid)
      return invalid;
    const fingerprint = sha256(JSON.stringify({ ...e, correlation_id: undefined }));
    const key = `${e.project_id}:${e.actor.actor_type}:${e.actor.actor_id}:${e.idempotency_key}`;
    const prior = this.keys.get(key);
    if (prior)
      return prior.fingerprint === fingerprint ? Response.json(prior.body, { status: prior.status }) : responseError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", 409);
    try {
      const out = await this.route(new URL(request.url).pathname, e);
      this.keys.set(key, { fingerprint, status: out.status, body: out.body });
      return this.ok(out.body, out.status);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORKER_ERROR";
      const status = code === "JOB_NOT_FOUND" ? 404 : code === "UNSUPPORTED_VIVADO" ? 501 : code === "IDEMPOTENCY_CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : code === "PROJECT_NOT_ALLOWED" || code === "CLASSIFICATION_NOT_ALLOWED" ? 403 : 400;
      return responseError(code, code, status);
    }
  }
  validateEnvelope(v) {
    if (!v || typeof v !== "object")
      return responseError("INVALID_ENVELOPE", "object required", 400);
    const e = v;
    if (e.schema_version !== REMOTE_SCHEMA_VERSION)
      return responseError("UNSUPPORTED_PROTOCOL", "connector.remote.v1 required", 400);
    if (!good(e.correlation_id) || !good(e.idempotency_key) || !good(e.project_id) || !good(e.capability_version))
      return responseError("INVALID_ENVELOPE", "required envelope fields are missing", 400);
    if (!e.actor || e.actor.actor_type !== "user" && e.actor.actor_type !== "service" || !good(e.actor.actor_id))
      return responseError("INVALID_ENVELOPE", "actor is invalid", 400);
    if (!classes.includes(e.classification))
      return responseError("INVALID_ENVELOPE", "classification is invalid", 400);
    return;
  }
  async route(path, e) {
    if (!this.endpoint.project_scope.includes(e.project_id))
      throw new Error("PROJECT_NOT_ALLOWED");
    if (!this.endpoint.data_classification_scope.includes(e.classification))
      throw new Error("CLASSIFICATION_NOT_ALLOWED");
    const p = e.payload;
    if (path === "/registration") {
      this.registration = { ...copy(this.endpoint), registration_state: "approved" };
      return { status: 200, body: this.envelope(e, this.registration) };
    }
    if (path === "/discover") {
      this.discovery = await this.execution.discover();
      return { status: 200, body: this.envelope(e, this.discovery) };
    }
    if (path === "/heartbeat") {
      if (!this.registration)
        throw new Error("NOT_REGISTERED");
      if (!this.discovery)
        this.discovery = await this.execution.discover();
      const now = this.clock();
      this.registration = { ...this.registration, registration_state: "ready", discovered: copy(this.discovery), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + this.endpoint.lease_seconds * 1000).toISOString(), capability_drift: this.discovery.connector_protocol_version !== this.endpoint.protocol_version || this.discovery.toolchain_profile_hash !== this.endpoint.toolchain_profile_hash };
      return { status: 200, body: this.envelope(e, this.registration) };
    }
    if (path === "/jobs/submit") {
      return this.submit(e, p.request, p.approval);
    }
    const jobId = p.job_id;
    if (!good(jobId))
      throw new Error("INVALID_JOB_ID");
    const job = this.jobs.get(jobId);
    if (!job)
      throw new Error("JOB_NOT_FOUND");
    if (path === "/jobs/status")
      return { status: 200, body: this.envelope(e, copy(job)) };
    if (path === "/jobs/cancel") {
      if (!terminal.has(job.state))
        job.state = "cancelled";
      return { status: 200, body: this.envelope(e, copy(job)) };
    }
    if (path === "/jobs/evidence") {
      if (!job.evidence)
        throw new Error("EVIDENCE_NOT_AVAILABLE");
      return { status: 200, body: this.envelope(e, copy(job.evidence)) };
    }
    throw new Error("NOT_FOUND");
  }
  submit(e, request, approval) {
    const capability = this.discovery?.capabilities.find((c) => c.operation === request?.operation);
    if (!this.registration || this.registration.registration_state !== "ready" && (request?.runClass === "formal" || request?.runClass === "gate_check"))
      throw new Error("ENDPOINT_NOT_APPROVED");
    if (!request || request.projectId !== e.project_id || !good(request.idempotencyKey) || !good(request.operation) || !good(request.input) || !good(request.correlationId))
      throw new Error("INVALID_JOB_REQUEST");
    if (!this.endpoint.allowed_capability_ids.includes(request.operation) || !capability || capability.version !== e.capability_version || !capability.runClasses.includes(request.runClass))
      throw new Error("CAPABILITY_UNAVAILABLE");
    if (request.runClass === "gate_check" && !good(approval?.gateSubmissionId))
      throw new Error("GATE_SUBMISSION_REQUIRED");
    if (request.runClass === "formal" && (approval?.inputApproved !== true || !good(approval?.baselineId) && !good(approval?.approvedGateResultId)))
      throw new Error("FORMAL_GATE_REQUIRED");
    if (request.runClass === "formal" && request.input.startsWith("candidate:"))
      throw new Error("CANDIDATE_FORMAL_REJECTED");
    const jobId = request.jobId ?? `job-${crypto.randomUUID()}`;
    if (!idRe.test(jobId))
      throw new Error("INVALID_JOB_ID");
    const fingerprint = sha256(JSON.stringify(request));
    const old = this.jobs.get(jobId);
    if (old) {
      if (sha256(JSON.stringify(old.request)) !== fingerprint)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return { status: 200, body: this.envelope(e, copy(old)) };
    }
    const job = { id: jobId, request: { ...request, jobId }, state: "submitted", inputSha256: sha256(request.input) };
    this.jobs.set(jobId, job);
    this.pending.push(jobId);
    this.pump();
    return { status: 202, body: this.envelope(e, copy(job)) };
  }
  async pump() {
    while (this.active < this.endpoint.max_concurrency && this.pending.length) {
      const jobId = this.pending.shift();
      const job = this.jobs.get(jobId);
      if (!job || terminal.has(job.state))
        continue;
      this.active++;
      this.run(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
  async run(job) {
    const workspace = join(this.root, job.id);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "input"), job.request.input, "utf8");
    job.state = "preparing";
    job.state = "running";
    try {
      const result = await this.execution.execute(copy(job.request), workspace);
      if (this.jobs.get(job.id)?.state === "cancelled")
        return;
      job.state = result.outcome === "success" ? "succeeded" : result.outcome === "timeout" ? "timeout" : result.outcome === "lost" ? "lost" : result.outcome === "unknown_effect" ? "unknown_effect" : "failed";
      if (result.output !== undefined) {
        job.outputSha256 = sha256(result.output);
        job.evidence = result.evidence ?? { jobId: job.id, entries: [{ name: "output.txt", sha256: job.outputSha256, sizeBytes: new TextEncoder().encode(result.output).byteLength, mediaType: "text/plain" }] };
      }
    } catch {
      job.state = "failed";
    }
  }
  envelope(e, payload) {
    return { schema_version: REMOTE_SCHEMA_VERSION, correlation_id: e.correlation_id, causation_id: e.correlation_id, idempotency_key: e.idempotency_key, actor: e.actor, project_id: e.project_id, classification: e.classification, capability_version: e.capability_version, payload };
  }
  jobIdFrom(v) {
    return v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : "worker";
  }
  ok(body, status) {
    return Response.json(body, { status });
  }
}

// connector/vivado.ts
import { createHash as createHash2 } from "node:crypto";
import { access, constants } from "node:fs";
import { mkdir as mkdir2, readFile, readdir, stat, writeFile as writeFile2 } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join as join2, resolve } from "node:path";
var VIVADO_CAPABILITY_VERSION = "vivado-batch-1";
var VIVADO_CAPABILITIES = [
  ["discover_toolchain", "node", "toolchain_snapshot"],
  ["query_parts", "part_query", "part_list"],
  ["validate_sources", "source_manifest", "source_validation"],
  ["simulate", "simulation_request", "simulation_result"],
  ["synthesize", "synthesis_request", "synthesis_result"],
  ["report_drc", "design_request", "drc_report"],
  ["report_sta", "design_request", "sta_report"],
  ["report_resources", "design_request", "resource_report"]
].map(([operation, inputKind, outputKind]) => ({ operation, version: VIVADO_CAPABILITY_VERSION, runClasses: ["exploratory", "gate_check", "formal"], inputKind, outputKind, execution: "vivado_batch" }));
var idRe2 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var hash = (data) => createHash2("sha256").update(data).digest("hex");
function reject(code) {
  throw new Error(`VIVADO_POLICY_REJECTED:${code}`);
}
function safePath(path) {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("..") || path.includes("\\") || path.includes("\x00"))
    reject("UNSAFE_PATH");
}
function safeToken(value, name) {
  if (!value || value.length > 256 || /[\0\r\n{}\[\]$;]/.test(value))
    reject(`UNSAFE_${name.toUpperCase()}`);
}
function validateVivadoRequest(request) {
  if (!request || !idRe2.test(request.jobId) || !idRe2.test(request.projectId))
    reject("INVALID_ID");
  if (!VIVADO_CAPABILITIES.some((c) => c.operation === request.operation))
    reject("CAPABILITY_UNAVAILABLE");
  if (request.toolchain?.vivadoBinary)
    safeToken(request.toolchain.vivadoBinary, "binary");
  if ("part" in request)
    safeToken(request.part, "part");
  if ("top" in request)
    safeToken(request.top, "top");
  if ("pattern" in request && request.pattern)
    safeToken(request.pattern, "pattern");
  if ("family" in request && request.family)
    safeToken(request.family, "family");
  if ("sources" in request) {
    if (!request.sources.length)
      reject("NO_SOURCES");
    for (const source of request.sources) {
      safePath(source.path);
      const size = typeof source.content === "string" ? Buffer.byteLength(source.content) : source.content.byteLength;
      if (!size)
        reject("EMPTY_SOURCE");
      if (size > 16 * 1024 * 1024)
        reject("SOURCE_TOO_LARGE");
    }
  }
}
function tclQuote(value) {
  return `{${value.replace(/[{}]/g, (c) => `\\${c}`)}}`;
}
function scriptFor(request, inputDir, outputDir) {
  const sources = "sources" in request ? request.sources.map((s) => `read_verilog ${tclQuote(join2(inputDir, s.path))}`).join(`
`) : "";
  const top = "top" in request ? `-top ${tclQuote(request.top)}` : "";
  const part = "part" in request ? `-part ${tclQuote(request.part)}` : request.toolchain?.part ? `-part ${tclQuote(request.toolchain.part)}` : "";
  if (request.operation === "discover_toolchain")
    return `puts [version -short]
puts [join [get_parts *] \\"\\n\\"]`;
  if (request.operation === "query_parts")
    return `puts [join [get_parts ${tclQuote(request.pattern ?? "*")}] "\\n"]`;
  if (request.operation === "validate_sources")
    return `${sources}
puts SOURCE_VALIDATION_OK`;
  if (request.operation === "simulate")
    return `${sources}
launch_simulation -mode behavioral
puts SIMULATION_OK`;
  if (request.operation === "synthesize")
    return `${sources}
synth_design ${part} ${top}
report_utilization -file ${tclQuote(join2(outputDir, "resources.rpt"))}`;
  const report = request.operation === "report_drc" ? `report_drc -file ${tclQuote(join2(outputDir, "drc.rpt"))}` : request.operation === "report_sta" ? `report_timing_summary -file ${tclQuote(join2(outputDir, "sta.rpt"))}` : `report_utilization -file ${tclQuote(join2(outputDir, "resources.rpt"))}`;
  return `${sources}
synth_design ${part} ${top}
${report}`;
}
async function evidence(workspace, jobId) {
  const output = join2(workspace, "output");
  const entries = [];
  for (const name of await readdir(output)) {
    safePath(name);
    const bytes = await readFile(join2(output, name));
    entries.push({ name, uri: `workspace://${jobId}/output/${name}`, sha256: hash(bytes), sizeBytes: (await stat(join2(output, name))).size, mediaType: name.endsWith(".rpt") ? "text/plain" : "application/octet-stream" });
  }
  return { jobId, entries };
}
var defaultRunner = (command, args, cwd, timeoutMs) => new Promise((ok, fail) => {
  const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => stdout += d);
  child.stderr.on("data", (d) => stderr += d);
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.once("error", fail);
  child.once("close", (exitCode) => {
    clearTimeout(timer);
    ok({ exitCode: exitCode ?? 1, stdout, stderr });
  });
});

class VivadoBatchAdapter {
  run;
  root;
  defaultBinary;
  injected;
  constructor(options) {
    this.root = resolve(options.workspaceRoot);
    this.defaultBinary = options.binary ?? "vivado";
    this.injected = options.commandRunner !== undefined;
    this.run = options.commandRunner ?? defaultRunner;
  }
  capabilities() {
    return VIVADO_CAPABILITIES;
  }
  async execute(request) {
    validateVivadoRequest(request);
    const workspace = join2(this.root, request.jobId);
    const inputDir = join2(workspace, "input");
    const outputDir = join2(workspace, "output");
    await mkdir2(inputDir, { recursive: true });
    await mkdir2(outputDir, { recursive: true });
    if ("sources" in request)
      for (const source of request.sources) {
        safePath(source.path);
        await writeFile2(join2(inputDir, source.path), source.content);
      }
    const inputSha256 = hash(JSON.stringify(request));
    const binary = request.toolchain?.vivadoBinary ?? this.defaultBinary;
    const command = [binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", join2(workspace, "run.tcl")];
    const base = { jobId: request.jobId, operation: request.operation, command, inputSha256, workspace, toolchain: { binary, licenseStatus: "unknown", part: "part" in request ? request.part : request.toolchain?.part, profileHash: request.toolchain?.profileHash }, evidence: { jobId: request.jobId, entries: [] } };
    try {
      if (!this.injected && binary.includes("/"))
        await access(binary, constants.X_OK);
    } catch {
      return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE" };
    }
    await writeFile2(join2(workspace, "run.tcl"), scriptFor(request, inputDir, outputDir), "utf8");
    let result;
    try {
      result = await this.run(binary, command.slice(1), workspace, request.timeoutMs ?? 30 * 60 * 1000);
    } catch {
      return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE", evidence: await evidence(workspace, request.jobId) };
    }
    const text = `${result.stdout}
${result.stderr}`;
    const ev = await evidence(workspace, request.jobId);
    if (/license|checkout|feature.*not found/i.test(text))
      return { ...base, status: "unsupported", unsupportedReason: "LICENSE_UNAVAILABLE", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "unavailable" }, evidence: ev };
    if (/part.*(not found|does not exist|unknown)/i.test(text))
      return { ...base, status: "unsupported", unsupportedReason: "PART_UNAVAILABLE", exitCode: result.exitCode, evidence: ev };
    return { ...base, status: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "available" }, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev };
  }
}

// connector/server.ts
function required(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}
async function loadConfig(path = process.env.SYNTHIA_WORKER_CONFIG ?? "D:/synthia-worker/config.json") {
  const config = JSON.parse(await readFile2(path, "utf8"));
  for (const name of ["connector_id", "endpoint_url", "protocol_version", "transport_mode", "auth_mode", "workspace_root", "server_certificate_path", "server_private_key_path", "trusted_client_ca_path", "vivado_binary", "vivado_part", "toolchain_profile_hash", "part_catalog_hash", "sdk_worker_build_hash"])
    required(config[name], name);
  if (config.protocol_version !== REMOTE_SCHEMA_VERSION || config.transport_mode !== "direct_https" || config.auth_mode !== "mtls")
    throw new Error("CONFIG_INVALID:protocol");
  if (!Number.isInteger(config.listen_port) || config.listen_port < 1 || config.listen_port > 65535)
    throw new Error("CONFIG_INVALID:listen_port");
  return config;
}
function execution(config) {
  const adapter = new VivadoBatchAdapter({ workspaceRoot: config.workspace_root, binary: config.vivado_binary });
  return {
    async discover() {
      try {
        await access2(config.vivado_binary, constants2.X_OK);
      } catch {
        return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "unavailable", vivado_patch: "unavailable", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, capabilities: [], toolchain_profile_hash: config.toolchain_profile_hash, license_status: "unavailable", unsupported: ["vivado_binary"] };
      }
      return { connector_id: config.connector_id, connector_protocol_version: REMOTE_SCHEMA_VERSION, capability_map_version: config.capability_map_version, vivado_version: "2021.1", vivado_patch: "3247384", part_catalog_hash: config.part_catalog_hash, sdk_worker_build_hash: config.sdk_worker_build_hash, capabilities: VIVADO_CAPABILITIES, toolchain_profile_hash: config.toolchain_profile_hash, license_status: "available" };
    },
    async execute(request, _workspace) {
      const candidate = request.parameters;
      if (!candidate || typeof candidate !== "object")
        return { outcome: "failure", error_code: "VIVADO_PARAMETERS_REQUIRED" };
      const result = await adapter.execute(candidate);
      if (result.status === "unsupported")
        return { outcome: "failure", error_code: result.unsupportedReason ?? "VIVADO_UNSUPPORTED" };
      return { outcome: result.status === "succeeded" ? "success" : "failure", output: JSON.stringify({ command: result.command, inputSha256: result.inputSha256, workspace: result.workspace, toolchain: result.toolchain }), evidence: result.evidence };
    }
  };
}
async function startWorker(configPath) {
  const config = await loadConfig(configPath);
  const privateKey = config.server_private_key_path.toLowerCase().endsWith(".pfx") || config.server_private_key_path.toLowerCase().endsWith(".p12");
  const tls = privateKey ? { pfx: await readFile2(config.server_private_key_path), passphrase: required(process.env.SYNTHIA_WORKER_PFX_PASSWORD, "SYNTHIA_WORKER_PFX_PASSWORD"), ca: await readFile2(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true } : { cert: await readFile2(config.server_certificate_path), key: await readFile2(config.server_private_key_path), ca: await readFile2(config.trusted_client_ca_path), requestCert: true, rejectUnauthorized: true };
  const options = { endpoint: config, workspaceRoot: config.workspace_root, execution: execution(config) };
  const runtime = new WorkerRuntime(options);
  const handler = runtime.handle.bind(runtime);
  const server = createServer(tls, async (req, res) => {
    const chunks = [];
    for await (const chunk of req)
      chunks.push(Buffer.from(chunk));
    const request = new Request(`https://${req.headers.host ?? `${config.listen_host}:${config.listen_port}`}${req.url ?? "/"}`, { method: req.method, headers: Object.entries(req.headers).filter((entry) => typeof entry[1] === "string"), body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve2, reject2) => {
    server.once("error", reject2);
    server.listen(config.listen_port, config.listen_host, resolve2);
  });
  return { server, config };
}
if (__require.main == __require.module) {
  startWorker().then(({ config }) => console.log(`synthia-worker listening on ${config.listen_host}:${config.listen_port} connector=${config.connector_id}`)).catch((error) => {
    console.error(`synthia-worker failed: ${error instanceof Error ? error.message : "startup"}`);
    process.exitCode = 1;
  });
}
export {
  startWorker
};
