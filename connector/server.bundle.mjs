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
  leaseExpiresAt;
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
  discoveryReady() {
    return this.discovery?.license_status === "available" && this.discovery.capabilities.length > 0 && this.discovery.unsupported?.length === undefined;
  }
  hasDrift(discovery) {
    return discovery.connector_protocol_version !== this.endpoint.protocol_version || discovery.toolchain_profile_hash !== this.endpoint.toolchain_profile_hash || this.endpoint.expected_capability_map_version !== undefined && discovery.capability_map_version !== this.endpoint.expected_capability_map_version || this.endpoint.expected_part_catalog_hash !== undefined && discovery.part_catalog_hash !== this.endpoint.expected_part_catalog_hash || this.endpoint.expected_sdk_worker_build_hash !== undefined && discovery.sdk_worker_build_hash !== this.endpoint.expected_sdk_worker_build_hash || discovery.license_status !== "available";
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
    const p = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {};
    if (path === "/registration") {
      if (this.endpoint.registration_state === "revoked")
        throw new Error("ENDPOINT_REVOKED");
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
      if (this.endpoint.registration_state === "revoked")
        throw new Error("ENDPOINT_REVOKED");
      if (!this.discovery)
        this.discovery = await this.execution.discover();
      const now = this.clock();
      const drift = this.hasDrift(this.discovery);
      const ready = this.discoveryReady() && !drift;
      this.leaseExpiresAt = now.getTime() + this.endpoint.lease_seconds * 1000;
      this.registration = { ...this.registration, registration_state: ready ? "ready" : "degraded", discovered: copy(this.discovery), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(this.leaseExpiresAt).toISOString(), capability_drift: drift };
      return { status: 200, body: this.envelope(e, this.registration) };
    }
    if (path === "/jobs/submit") {
      if (this.leaseExpiresAt !== undefined && this.clock().getTime() >= this.leaseExpiresAt) {
        this.registration = this.registration ? { ...this.registration, registration_state: "offline" } : this.registration;
        throw new Error("LEASE_EXPIRED");
      }
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
    if (!this.registration || this.registration.registration_state !== "ready" || this.registration.capability_drift === true)
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
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "input"), job.request.input, "utf8");
      job.state = "preparing";
      job.state = "running";
      const result = await this.execution.execute(copy(job.request), workspace);
      if (this.jobs.get(job.id)?.state === "cancelled")
        return;
      job.state = result.outcome === "success" ? "succeeded" : result.outcome === "timeout" ? "timeout" : result.outcome === "lost" ? "lost" : result.outcome === "unknown_effect" ? "unknown_effect" : "failed";
      if (result.error_code)
        job.errorCode = result.error_code;
      if (result.output !== undefined) {
        job.outputSha256 = sha256(result.output);
        const outputPath = join(workspace, "output", "worker-result.json");
        await mkdir(join(workspace, "output"), { recursive: true });
        await writeFile(outputPath, result.output, "utf8");
        const outputEntry = { name: "worker-result.json", uri: `workspace://${job.id}/output/worker-result.json`, sha256: job.outputSha256, sizeBytes: new TextEncoder().encode(result.output).byteLength, mediaType: "application/json" };
        job.evidence = { jobId: job.id, entries: [...result.evidence?.entries ?? [], outputEntry] };
      } else if (result.evidence)
        job.evidence = result.evidence;
    } catch {
      if (this.jobs.get(job.id)?.state === "cancelled")
        return;
      job.state = "failed";
      if (!job.errorCode)
        job.errorCode = "WORKER_EXECUTION_ERROR";
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
import { access, constants } from "node:fs/promises";
import { mkdir as mkdir2, readFile, readdir, stat, writeFile as writeFile2 } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join as join2, resolve } from "node:path";
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
var VIVADO_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
var VIVADO_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
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
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var VERILOG_MEDIA_TYPES = { "text/verilog": true, "text/x-verilog": true, "text/systemverilog": true, "application/systemverilog": true };
function assertSourceLanguage(source) {
  const lower = source.path.toLowerCase();
  const extOk = lower.endsWith(".v") || lower.endsWith(".sv");
  const mediaOk = source.mediaType === undefined || VERILOG_MEDIA_TYPES[source.mediaType] === true;
  if (!extOk || !mediaOk)
    reject("UNSUPPORTED_SOURCE_LANGUAGE");
}
function stripVerilogLexical(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== `
`)
        i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n)
          i += 2;
        else
          i += 1;
      }
      if (i < n)
        i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
var moduleDeclRe = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g;
function declaredModules(source) {
  const text = stripVerilogLexical(typeof source.content === "string" ? source.content : Buffer.from(source.content).toString("utf8"));
  const names = [];
  let m;
  moduleDeclRe.lastIndex = 0;
  while ((m = moduleDeclRe.exec(text)) !== null)
    names.push(m[1]);
  return names;
}
function assertSimulateModules(request) {
  const totals = new Map;
  for (const source of request.sources)
    for (const name of declaredModules(source))
      totals.set(name, (totals.get(name) ?? 0) + 1);
  const topCount = totals.get(request.top) ?? 0;
  const tbCount = totals.get(request.testbench) ?? 0;
  if (topCount === 0 || tbCount === 0)
    reject("MISSING_TOP_MODULE");
  if (topCount > 1 || tbCount > 1)
    reject("AMBIGUOUS_TOP_MODULE");
  for (const source of request.sources) {
    const names = new Set(declaredModules(source));
    if (names.has(request.top) && names.has(request.testbench))
      reject("AMBIGUOUS_SOURCE_ROLE");
  }
}
function validateVivadoRequest(request) {
  if (!isPlainObject(request))
    reject("INVALID_REQUEST");
  if (typeof request.jobId !== "string" || typeof request.projectId !== "string" || !idRe2.test(request.jobId) || !idRe2.test(request.projectId))
    reject("INVALID_ID");
  if (request.runClass !== "exploratory" && request.runClass !== "gate_check" && request.runClass !== "formal")
    reject("INVALID_RUN_CLASS");
  if (request.timeoutMs !== undefined) {
    const t = request.timeoutMs;
    if (typeof t !== "number" || !Number.isFinite(t) || !Number.isInteger(t) || t <= 0 || t > VIVADO_MAX_TIMEOUT_MS)
      reject("INVALID_TIMEOUT");
  }
  if (!VIVADO_CAPABILITIES.some((c) => c.operation === request.operation))
    reject("CAPABILITY_UNAVAILABLE");
  if (request.toolchain !== undefined) {
    if (!isPlainObject(request.toolchain))
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary !== undefined && typeof request.toolchain.vivadoBinary !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.requiredLicense !== undefined && typeof request.toolchain.requiredLicense !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.part !== undefined && typeof request.toolchain.part !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.profileHash !== undefined && typeof request.toolchain.profileHash !== "string")
      reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary)
      safeToken(request.toolchain.vivadoBinary, "binary");
  }
  if ("part" in request) {
    if (typeof request.part !== "string")
      reject("INVALID_PART");
    safeToken(request.part, "part");
  }
  if ("top" in request) {
    if (typeof request.top !== "string")
      reject("INVALID_TOP");
    safeToken(request.top, "top");
  }
  if (request.operation === "simulate") {
    const tb = request.testbench;
    if (tb === undefined)
      reject("NO_TESTBENCH");
    if (typeof tb !== "string")
      reject("INVALID_TESTBENCH");
    safeToken(tb, "testbench");
    if (request.top === tb)
      reject("SAME_TOP_TESTBENCH");
  }
  if ("pattern" in request && request.pattern) {
    if (typeof request.pattern !== "string")
      reject("INVALID_PATTERN");
    safeToken(request.pattern, "pattern");
  }
  if ("family" in request && request.family) {
    if (typeof request.family !== "string")
      reject("INVALID_FAMILY");
    safeToken(request.family, "family");
  }
  if ("sources" in request) {
    if (!Array.isArray(request.sources))
      reject("INVALID_SOURCES");
    if (!request.sources.length)
      reject("NO_SOURCES");
    for (const source of request.sources) {
      if (!isPlainObject(source))
        reject("INVALID_SOURCE");
      if (typeof source.path !== "string")
        reject("INVALID_SOURCE_PATH");
      safePath(source.path);
      if (typeof source.content !== "string" && !(source.content instanceof Uint8Array))
        reject("INVALID_SOURCE_CONTENT");
      if (source.mediaType !== undefined && typeof source.mediaType !== "string")
        reject("INVALID_SOURCE_MEDIA_TYPE");
      assertSourceLanguage(source);
      const size = typeof source.content === "string" ? Buffer.byteLength(source.content) : source.content.byteLength;
      if (!size)
        reject("EMPTY_SOURCE");
      if (size > 16 * 1024 * 1024)
        reject("SOURCE_TOO_LARGE");
    }
    if (request.operation === "simulate")
      assertSimulateModules(request);
  }
}
function tclQuote(value) {
  return `{${value.replace(/[{}]/g, (c) => `\\${c}`)}}`;
}
function readSourceLine(source, inputDir) {
  const target = tclQuote(join2(inputDir, source.path));
  const isSystemVerilog = source.path.toLowerCase().endsWith(".sv") || source.mediaType === "text/systemverilog" || source.mediaType === "application/systemverilog";
  return isSystemVerilog ? `read_verilog -sv ${target}` : `read_verilog ${target}`;
}
function scriptFor(request, inputDir, outputDir) {
  const sources = "sources" in request ? request.sources.map((s) => readSourceLine(s, inputDir)).join(`
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
  if (request.operation === "simulate") {
    const designPaths = [];
    const simPaths = [];
    for (const source of request.sources) {
      const target = tclQuote(join2(inputDir, source.path));
      (declaredModules(source).includes(request.testbench) ? simPaths : designPaths).push(target);
    }
    const designFiles = designPaths.join(" ");
    const simFiles = simPaths.join(" ");
    const project = tclQuote(join2(resolve(inputDir, ".."), "vivado-project"));
    const projectPart = tclQuote(request.toolchain?.part ?? "xc7k70tfbv676-1");
    const topQ = tclQuote(request.top);
    const tbQ = tclQuote(request.testbench);
    return `${sources}
create_project synthia_batch ${project} -part ${projectPart} -force
add_files -fileset sources_1 ${designFiles}
add_files -fileset sim_1 ${simFiles}
set_property top ${topQ} [get_filesets sources_1]
set_property top ${tbQ} [get_filesets sim_1]
update_compile_order -fileset sources_1
update_compile_order -fileset sim_1
launch_simulation -mode behavioral -scripts_only -absolute_path
set simRoot [file normalize [file join ${project} "synthia_batch.sim" "sim_1" "behav" "xsim"]]
cd $simRoot
proc phaseExitCode {options} {
  if {[dict exists $options -errorcode]} {
    set ec [dict get $options -errorcode]
    if {[llength $ec] >= 3 && [lindex $ec 0] eq "CHILDSTATUS"} { return [lindex $ec 2] }
  }
  return 1
}
set phase compile
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot compile.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=compile"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }
set phase elaborate
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot elaborate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=elaborate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }
set phase simulate
if {[catch {exec cmd.exe /d /c [list call [file join $simRoot simulate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=simulate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts "SIMULATOR_OUTPUT_BEGIN"; puts $sim_output; puts "SIMULATOR_OUTPUT_END"; return -options $sim_options $sim_output }
puts "PHASE=simulate"
puts "PHASE_EXIT_CODE=0"
puts "SIMULATOR_OUTPUT_BEGIN"
puts $sim_output
puts "SIMULATOR_OUTPUT_END"
puts SIMULATION_OK`;
  }
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
function terminateProcessTree(pid) {
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}
var defaultRunner = (command, args, cwd, timeoutMs) => {
  const { promise, resolve: resolve2, reject: reject2 } = Promise.withResolvers();
  const lower = command.toLowerCase();
  const isBatch = lower.endsWith(".bat") || lower.endsWith(".cmd");
  const child = isBatch ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: true }) : spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (d) => stdout += d);
  child.stderr.on("data", (d) => stderr += d);
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid)
      terminateProcessTree(child.pid);
  }, timeoutMs);
  child.once("error", reject2);
  child.once("close", (exitCode) => {
    clearTimeout(timer);
    resolve2({ exitCode: exitCode ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, signal: timedOut ? "SIGTERM" : null });
  });
  return promise;
};
function parseSimulatePhases(text) {
  const phaseMatch = text.match(/^PHASE=(\S+)/m);
  const exitMatch = text.match(/^PHASE_EXIT_CODE=(\d+)/m);
  const beginIdx = text.indexOf("SIMULATOR_OUTPUT_BEGIN");
  const endIdx = text.lastIndexOf("SIMULATOR_OUTPUT_END");
  const simulatorStdout = beginIdx !== -1 && endIdx !== -1 ? text.slice(beginIdx + "SIMULATOR_OUTPUT_BEGIN".length, endIdx).trim() : undefined;
  return { phase: phaseMatch?.[1], phaseExitCode: exitMatch ? Number(exitMatch[1]) : undefined, simulatorStdout };
}

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
        const target = join2(inputDir, source.path);
        await mkdir2(dirname(target), { recursive: true });
        await writeFile2(target, source.content);
      }
    const inputSha256 = hash(JSON.stringify(request));
    const binary = request.toolchain?.vivadoBinary ?? this.defaultBinary;
    const command = [binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", join2(workspace, "run.tcl")];
    const base = { jobId: request.jobId, operation: request.operation, command, inputSha256, workspace, toolchain: { binary, licenseStatus: "unknown", part: "part" in request ? request.part : request.toolchain?.part, profileHash: request.toolchain?.profileHash }, evidence: { jobId: request.jobId, entries: [] } };
    try {
      if (!this.injected && (binary.includes("/") || binary.includes("\\")))
        await access(binary, constants.X_OK);
    } catch {
      return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE" };
    }
    await writeFile2(join2(workspace, "run.tcl"), scriptFor(request, inputDir, outputDir), "utf8");
    const effectiveTimeout = request.timeoutMs ?? VIVADO_DEFAULT_TIMEOUT_MS;
    let result;
    try {
      result = await this.run(binary, command.slice(1), workspace, effectiveTimeout);
    } catch (error) {
      const code = error?.code;
      const ev2 = await evidence(workspace, request.jobId);
      if (code === "ENOENT" || code === "EACCES")
        return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE", evidence: ev2 };
      return { ...base, status: "lost", evidence: ev2 };
    }
    if (result.timedOut) {
      const ev2 = await evidence(workspace, request.jobId);
      return { ...base, status: "timeout", timedOut: true, signal: result.signal ?? null, exitCode: result.exitCode, timeoutMs: effectiveTimeout, evidence: ev2 };
    }
    const text = `${result.stdout}
${result.stderr}`;
    const ev = await evidence(workspace, request.jobId);
    const licenseSuccess = /\b(?:checkout|feature)\b.*\b(?:succe\w*|granted|checked[\s-]*out)\b|\b(?:license|licence)\b.*\b(?:granted|checked[\s-]*out|succe\w*)\b/i.test(text);
    const licenseFailure = !licenseSuccess && /\b(?:license|licence|checkout|feature)\b.*\b(?:not\s*(?:available|found|licensed)|fail\w*|denied|unable|could\s*not|error|missing)\b/i.test(text);
    if (licenseFailure)
      return { ...base, status: "unsupported", unsupportedReason: "LICENSE_UNAVAILABLE", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "unavailable" }, evidence: ev };
    if (/part.*(not found|does not exist|unknown)/i.test(text))
      return { ...base, status: "unsupported", unsupportedReason: "PART_UNAVAILABLE", exitCode: result.exitCode, evidence: ev };
    const toolchain = { ...base.toolchain, licenseStatus: licenseSuccess ? "available" : base.toolchain.licenseStatus };
    if (request.operation === "simulate") {
      const sim = parseSimulatePhases(result.stdout);
      const simExitCode = sim.phaseExitCode ?? result.exitCode;
      const errorCode = sim.phaseExitCode !== undefined && sim.phaseExitCode !== 0 ? "VIVADO_SIMULATION_FAILED" : undefined;
      return { ...base, status: simExitCode === 0 && result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, phase: sim.phase, phaseExitCode: sim.phaseExitCode, simulatorStdout: sim.simulatorStdout, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev, errorCode };
    }
    return { ...base, status: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev };
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
        return { outcome: "failure", error_code: "VIVADO_PARAMETERS_REQUIRED", output: JSON.stringify({ status: "rejected", errorCode: "VIVADO_PARAMETERS_REQUIRED" }), evidence: { jobId: request.jobId ?? "worker", entries: [] } };
      const vivadoRequest = {
        ...candidate,
        toolchain: {
          ...candidate.toolchain ?? {},
          vivadoBinary: candidate.toolchain?.vivadoBinary ?? config.vivado_binary,
          part: candidate.toolchain?.part ?? config.vivado_part,
          profileHash: candidate.toolchain?.profileHash ?? config.toolchain_profile_hash
        }
      };
      let result;
      try {
        result = await adapter.execute(vivadoRequest);
      } catch (error) {
        const message = error instanceof Error ? error.message : "VIVADO_EXECUTION_ERROR";
        const errorCode2 = message.startsWith("VIVADO_POLICY_REJECTED:") ? message : "VIVADO_EXECUTION_ERROR";
        const jobId = request.jobId ?? "worker";
        return { outcome: "failure", error_code: errorCode2, output: JSON.stringify({ status: "rejected", jobId, errorCode: errorCode2 }), evidence: { jobId, entries: [] } };
      }
      const outcome = result.status === "succeeded" ? "success" : result.status === "timeout" ? "timeout" : result.status === "lost" ? "lost" : result.status === "unknown_effect" ? "unknown_effect" : "failure";
      const meta = { jobId: result.jobId, operation: result.operation, status: result.status, command: result.command, inputSha256: result.inputSha256, workspace: result.workspace, toolchain: result.toolchain };
      if (result.exitCode !== undefined)
        meta.exitCode = result.exitCode;
      if (result.phase !== undefined)
        meta.phase = result.phase;
      if (result.phaseExitCode !== undefined)
        meta.phaseExitCode = result.phaseExitCode;
      if (result.simulatorStdout !== undefined)
        meta.simulatorStdout = result.simulatorStdout;
      if (result.stdout !== undefined)
        meta.stdout = result.stdout;
      if (result.stderr !== undefined)
        meta.stderr = result.stderr;
      if (result.errorCode !== undefined)
        meta.errorCode = result.errorCode;
      if (result.timeoutMs !== undefined)
        meta.timeoutMs = result.timeoutMs;
      if (result.timedOut !== undefined)
        meta.timedOut = result.timedOut;
      if (result.signal !== undefined)
        meta.signal = result.signal;
      if (result.unsupportedReason !== undefined)
        meta.unsupportedReason = result.unsupportedReason;
      if (result.output && typeof result.output === "object") {
        const o = result.output;
        if (o.stdout !== undefined)
          meta.output = o;
      }
      const errorCode = result.errorCode ?? (result.status === "unsupported" ? result.unsupportedReason ?? "VIVADO_UNSUPPORTED" : undefined);
      return { outcome, error_code: errorCode, output: JSON.stringify(meta, null, 2), evidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
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
