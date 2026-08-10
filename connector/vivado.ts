import { createHash } from "node:crypto";
import { access, constants } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { ConnectorCapability, EvidenceManifest } from "./index.ts";

export const VIVADO_CAPABILITY_VERSION = "vivado-batch-1" as const;
export type VivadoOperation = "discover_toolchain" | "query_parts" | "validate_sources" | "simulate" | "synthesize" | "report_drc" | "report_sta" | "report_resources";
export type VivadoRunClass = "exploratory" | "gate_check" | "formal";
export type VivadoResultStatus = "succeeded" | "failed" | "unsupported" | "timeout" | "lost" | "unknown_effect";
export interface SourceInput { readonly path: string; readonly content: string | Uint8Array; readonly mediaType?: string; }
export interface VivadoRequestBase { readonly jobId: string; readonly runClass: VivadoRunClass; readonly projectId: string; readonly toolchain?: { readonly vivadoBinary?: string; readonly requiredLicense?: string; readonly part?: string; readonly profileHash?: string }; readonly timeoutMs?: number }
export interface DiscoverToolchainRequest extends VivadoRequestBase { readonly operation: "discover_toolchain" }
export interface QueryPartsRequest extends VivadoRequestBase { readonly operation: "query_parts"; readonly pattern?: string; readonly family?: string }
export interface ValidateSourcesRequest extends VivadoRequestBase { readonly operation: "validate_sources"; readonly sources: readonly SourceInput[]; readonly top?: string }
export interface SimulateRequest extends VivadoRequestBase { readonly operation: "simulate"; readonly sources: readonly SourceInput[]; readonly top: string; readonly testbench: string }
export interface SynthesizeRequest extends VivadoRequestBase { readonly operation: "synthesize"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export interface ReportRequest extends VivadoRequestBase { readonly operation: "report_drc" | "report_sta" | "report_resources"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export type VivadoRequest = DiscoverToolchainRequest | QueryPartsRequest | ValidateSourcesRequest | SimulateRequest | SynthesizeRequest | ReportRequest;
export interface CapabilityDefinition<I extends VivadoRequest = VivadoRequest> extends ConnectorCapability { readonly operation: I["operation"]; readonly inputKind: string; readonly outputKind: string; readonly execution: "vivado_batch" }
export const VIVADO_CAPABILITIES: readonly CapabilityDefinition[] = [
  ["discover_toolchain", "node", "toolchain_snapshot"], ["query_parts", "part_query", "part_list"], ["validate_sources", "source_manifest", "source_validation"], ["simulate", "simulation_request", "simulation_result"], ["synthesize", "synthesis_request", "synthesis_result"], ["report_drc", "design_request", "drc_report"], ["report_sta", "design_request", "sta_report"], ["report_resources", "design_request", "resource_report"],
].map(([operation, inputKind, outputKind]) => ({ operation, version: VIVADO_CAPABILITY_VERSION, runClasses: ["exploratory", "gate_check", "formal"], inputKind, outputKind, execution: "vivado_batch" })) as readonly CapabilityDefinition[];
export interface EvidenceReference { readonly name: string; readonly uri: string; readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string }
export interface ToolchainMetadata { readonly binary: string; readonly vivadoVersion?: string; readonly licenseStatus: "available" | "unavailable" | "unknown"; readonly part?: string; readonly profileHash?: string }
export interface VivadoExecutionResult { readonly status: VivadoResultStatus; readonly jobId: string; readonly operation: VivadoOperation; readonly command: readonly string[]; readonly inputSha256: string; readonly workspace: string; readonly toolchain: ToolchainMetadata; readonly exitCode?: number; readonly output?: unknown; readonly evidence: EvidenceManifest; readonly unsupportedReason?: "BINARY_UNAVAILABLE" | "LICENSE_UNAVAILABLE" | "PART_UNAVAILABLE"; readonly timeoutMs?: number; readonly timedOut?: boolean; readonly signal?: string | null }
export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean; readonly signal?: string | null }
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;
export interface VivadoAdapterOptions { readonly workspaceRoot: string; readonly binary?: string; readonly commandRunner?: CommandRunner }
export const VIVADO_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const VIVADO_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function reject(code: string): never { throw new Error(`VIVADO_POLICY_REJECTED:${code}`); }
function safePath(path: string): void { if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("..") || path.includes("\\") || path.includes("\0")) reject("UNSAFE_PATH"); }
function safeToken(value: string, name: string): void { if (!value || value.length > 256 || /[\0\r\n{}\[\]$;]/.test(value)) reject(`UNSAFE_${name.toUpperCase()}`); }
function isPlainObject(value: unknown): boolean { return typeof value === "object" && value !== null && !Array.isArray(value); }
const VERILOG_MEDIA_TYPES: Record<string, true> = { "text/verilog": true, "text/x-verilog": true, "text/systemverilog": true, "application/systemverilog": true };
function assertSourceLanguage(source: SourceInput): void {
  const lower = source.path.toLowerCase();
  const extOk = lower.endsWith(".v") || lower.endsWith(".sv");
  const mediaOk = source.mediaType === undefined || VERILOG_MEDIA_TYPES[source.mediaType] === true;
  if (!extOk || !mediaOk) reject("UNSUPPORTED_SOURCE_LANGUAGE");
}
function stripVerilogLexical(text: string): string {
  let out = ""; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const next = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && next === "/") { i += 2; while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"') { i += 1; while (i < n && text[i] !== '"') { if (text[i] === "\\" && i + 1 < n) i += 2; else i += 1; } if (i < n) i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}
const moduleDeclRe = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g;
function declaredModules(source: SourceInput): string[] {
  const text = stripVerilogLexical(typeof source.content === "string" ? source.content : Buffer.from(source.content).toString("utf8")); const names: string[] = []; let m: RegExpExecArray | null; moduleDeclRe.lastIndex = 0;
  while ((m = moduleDeclRe.exec(text)) !== null) names.push(m[1]);
  return names;
}
function assertSimulateModules(request: SimulateRequest): void {
  // Count raw declarations (no per-file Set folding): a module declared twice
  // within ONE file is an unresolvable duplicate, and cross-file duplicates are
  // naturally summed by iterating every declaration rather than deduping per source.
  const totals = new Map<string, number>();
  for (const source of request.sources) for (const name of declaredModules(source)) totals.set(name, (totals.get(name) ?? 0) + 1);
  const topCount = totals.get(request.top) ?? 0; const tbCount = totals.get(request.testbench) ?? 0;
  if (topCount === 0 || tbCount === 0) reject("MISSING_TOP_MODULE");
  if (topCount > 1 || tbCount > 1) reject("AMBIGUOUS_TOP_MODULE");
  // Role separation is per-file: a single source holding both requested roles
  // cannot be routed unambiguously into sources_1 and sim_1.
  for (const source of request.sources) { const names = new Set(declaredModules(source)); if (names.has(request.top) && names.has(request.testbench)) reject("AMBIGUOUS_SOURCE_ROLE"); }
}
export function validateVivadoRequest(request: VivadoRequest): void {
  // Boundary guard: an external untyped payload must be a plain record before any
  // property access — arrays and primitives would otherwise sneak past `typeof === "object"`.
  if (!isPlainObject(request)) reject("INVALID_REQUEST");
  if (typeof request.jobId !== "string" || typeof request.projectId !== "string" || !idRe.test(request.jobId) || !idRe.test(request.projectId)) reject("INVALID_ID");
  if (request.runClass !== "exploratory" && request.runClass !== "gate_check" && request.runClass !== "formal") reject("INVALID_RUN_CLASS");
  if (request.timeoutMs !== undefined) { const t = request.timeoutMs; if (typeof t !== "number" || !Number.isFinite(t) || !Number.isInteger(t) || t <= 0 || t > VIVADO_MAX_TIMEOUT_MS) reject("INVALID_TIMEOUT"); }
  if (!VIVADO_CAPABILITIES.some(c => c.operation === request.operation)) reject("CAPABILITY_UNAVAILABLE");
  if (request.toolchain !== undefined) {
    if (!isPlainObject(request.toolchain)) reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary !== undefined && typeof request.toolchain.vivadoBinary !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.requiredLicense !== undefined && typeof request.toolchain.requiredLicense !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.part !== undefined && typeof request.toolchain.part !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.profileHash !== undefined && typeof request.toolchain.profileHash !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary) safeToken(request.toolchain.vivadoBinary, "binary");
  }
  if ("part" in request) { if (typeof request.part !== "string") reject("INVALID_PART"); safeToken(request.part, "part"); }
  if ("top" in request) { if (typeof request.top !== "string") reject("INVALID_TOP"); safeToken(request.top, "top"); }
  if (request.operation === "simulate") {
    const tb = request.testbench;
    if (tb === undefined) reject("NO_TESTBENCH");
    if (typeof tb !== "string") reject("INVALID_TESTBENCH");
    safeToken(tb, "testbench");
    if (request.top === tb) reject("SAME_TOP_TESTBENCH");
  }
  if ("pattern" in request && request.pattern) { if (typeof request.pattern !== "string") reject("INVALID_PATTERN"); safeToken(request.pattern, "pattern"); }
  if ("family" in request && request.family) { if (typeof request.family !== "string") reject("INVALID_FAMILY"); safeToken(request.family, "family"); }
  if ("sources" in request) {
    if (!Array.isArray(request.sources)) reject("INVALID_SOURCES");
    if (!request.sources.length) reject("NO_SOURCES");
    for (const source of request.sources) {
      if (!isPlainObject(source)) reject("INVALID_SOURCE");
      if (typeof source.path !== "string") reject("INVALID_SOURCE_PATH");
      safePath(source.path);
      if (typeof source.content !== "string" && !(source.content instanceof Uint8Array)) reject("INVALID_SOURCE_CONTENT");
      if (source.mediaType !== undefined && typeof source.mediaType !== "string") reject("INVALID_SOURCE_MEDIA_TYPE");
      assertSourceLanguage(source);
      const size = typeof source.content === "string" ? Buffer.byteLength(source.content) : source.content.byteLength;
      if (!size) reject("EMPTY_SOURCE");
      if (size > 16 * 1024 * 1024) reject("SOURCE_TOO_LARGE");
    }
    if (request.operation === "simulate") assertSimulateModules(request);
  }
}
function tclQuote(value: string): string { return `{${value.replace(/[{}]/g, c => `\\${c}`)}}`; }
function readSourceLine(source: SourceInput, inputDir: string): string {
  const target = tclQuote(join(inputDir, source.path));
  const isSystemVerilog = source.path.toLowerCase().endsWith(".sv") || source.mediaType === "text/systemverilog" || source.mediaType === "application/systemverilog";
  return isSystemVerilog ? `read_verilog -sv ${target}` : `read_verilog ${target}`;
}
function scriptFor(request: VivadoRequest, inputDir: string, outputDir: string): string {
  const sources = "sources" in request ? request.sources.map(s => readSourceLine(s, inputDir)).join("\n") : "";
  const top = "top" in request ? `-top ${tclQuote(request.top)}` : ""; const part = "part" in request ? `-part ${tclQuote(request.part)}` : request.toolchain?.part ? `-part ${tclQuote(request.toolchain.part)}` : "";
  if (request.operation === "discover_toolchain") return "puts [version -short]\nputs [join [get_parts *] \\\"\\n\\\"]";
  if (request.operation === "query_parts") return `puts [join [get_parts ${tclQuote(request.pattern ?? "*")}] "\\n"]`;
  if (request.operation === "validate_sources") return `${sources}\nputs SOURCE_VALIDATION_OK`;
  if (request.operation === "simulate") {
    const designPaths: string[] = []; const simPaths: string[] = [];
    for (const source of request.sources) { const target = tclQuote(join(inputDir, source.path)); (declaredModules(source).includes(request.testbench) ? simPaths : designPaths).push(target); }
    const addDesign = designPaths.length ? `add_files -fileset sources_1 ${designPaths.join(" ")}` : "";
    const addSim = simPaths.length ? `add_files -fileset sim_1 ${simPaths.join(" ")}` : "";
    const reads = request.sources.map(s => readSourceLine(s, inputDir)).join("\n");
    return ["create_project -in_memory", reads, addDesign, addSim, `set_property top ${tclQuote(request.top)} [current_fileset]`, `set_property top ${tclQuote(request.testbench)} [get_filesets sim_1]`, "update_compile_order -fileset sources_1", "update_compile_order -fileset sim_1", "launch_simulation -mode behavioral", "run all", "puts SIMULATION_OK"].filter(Boolean).join("\n");
  }
  if (request.operation === "synthesize") return `${sources}\nsynth_design ${part} ${top}\nreport_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  const report = request.operation === "report_drc" ? `report_drc -file ${tclQuote(join(outputDir, "drc.rpt"))}` : request.operation === "report_sta" ? `report_timing_summary -file ${tclQuote(join(outputDir, "sta.rpt"))}` : `report_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  return `${sources}\nsynth_design ${part} ${top}\n${report}`;
}
async function evidence(workspace: string, jobId: string): Promise<EvidenceManifest> {
  const output = join(workspace, "output"); const entries: EvidenceReference[] = [];
  for (const name of await readdir(output)) { safePath(name); const bytes = await readFile(join(output, name)); entries.push({ name, uri: `workspace://${jobId}/output/${name}`, sha256: hash(bytes), sizeBytes: (await stat(join(output, name))).size, mediaType: name.endsWith(".rpt") ? "text/plain" : "application/octet-stream" }); }
  return { jobId, entries };
}
const defaultRunner: CommandRunner = (command, args, cwd, timeoutMs) => {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
  child.once("error", reject);
  child.once("close", exitCode => { clearTimeout(timer); resolve({ exitCode: exitCode ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, signal: timedOut ? "SIGTERM" : null }); });
  return promise;
};
export class VivadoBatchAdapter {
  private readonly run: CommandRunner; private readonly root: string; private readonly defaultBinary: string; private readonly injected: boolean;
  constructor(options: VivadoAdapterOptions) { this.root = resolve(options.workspaceRoot); this.defaultBinary = options.binary ?? "vivado"; this.injected = options.commandRunner !== undefined; this.run = options.commandRunner ?? defaultRunner; }
  capabilities(): readonly CapabilityDefinition[] { return VIVADO_CAPABILITIES; }
  async execute(request: VivadoRequest): Promise<VivadoExecutionResult> {
    validateVivadoRequest(request); const workspace = join(this.root, request.jobId); const inputDir = join(workspace, "input"); const outputDir = join(workspace, "output"); await mkdir(inputDir, { recursive: true }); await mkdir(outputDir, { recursive: true });
    if ("sources" in request) for (const source of request.sources) { safePath(source.path); const target = join(inputDir, source.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, source.content); }
    const inputSha256 = hash(JSON.stringify(request)); const binary = request.toolchain?.vivadoBinary ?? this.defaultBinary; const command = [binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", join(workspace, "run.tcl")]; const base = { jobId: request.jobId, operation: request.operation, command, inputSha256, workspace, toolchain: { binary, licenseStatus: "unknown" as const, part: "part" in request ? request.part : request.toolchain?.part, profileHash: request.toolchain?.profileHash }, evidence: { jobId: request.jobId, entries: [] } satisfies EvidenceManifest };
    try { if (!this.injected && binary.includes("/")) await access(binary, constants.X_OK); } catch { return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE" }; }
    await writeFile(join(workspace, "run.tcl"), scriptFor(request, inputDir, outputDir), "utf8");
    const effectiveTimeout = request.timeoutMs ?? VIVADO_DEFAULT_TIMEOUT_MS;
    let result: CommandResult;
    try {
      result = await this.run(binary, command.slice(1), workspace, effectiveTimeout);
    } catch (error) {
      // Only a missing/non-executable binary is a deterministic BINARY_UNAVAILABLE;
      // any other thrown failure means no result was ever observed, so the worker/transport
      // was lost rather than the toolchain being absent.
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      const ev = await evidence(workspace, request.jobId);
      if (code === "ENOENT" || code === "EACCES") return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE", evidence: ev };
      return { ...base, status: "lost", evidence: ev };
    }
    // An explicit timeout marker from the runner is a first-class outcome: the process
    // exceeded its budget and was terminated; it is neither "failed" nor "unsupported"
    // because the effect on the design is genuinely unknown.
    if (result.timedOut) { const ev = await evidence(workspace, request.jobId); return { ...base, status: "timeout", timedOut: true, signal: result.signal ?? null, exitCode: result.exitCode, timeoutMs: effectiveTimeout, evidence: ev }; }
    const text = `${result.stdout}\n${result.stderr}`; const ev = await evidence(workspace, request.jobId);
    // License status is evidence-driven, never inferred from a clean exit: discover_toolchain
    // only runs version/get_parts (not a checkout), so a successful run keeps licenseStatus
    // "unknown"; only explicit checkout success or failure evidence changes it.
    const licenseSuccess = /\b(?:checkout|feature)\b.*\b(?:succe\w*|granted|checked[\s-]*out)\b|\b(?:license|licence)\b.*\b(?:granted|checked[\s-]*out|succe\w*)\b/i.test(text);
    const licenseFailure = !licenseSuccess && /\b(?:license|licence|checkout|feature)\b.*\b(?:not\s*(?:available|found|licensed)|fail\w*|denied|unable|could\s*not|error|missing)\b/i.test(text);
    if (licenseFailure) return { ...base, status: "unsupported", unsupportedReason: "LICENSE_UNAVAILABLE", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "unavailable" }, evidence: ev };
    if (/part.*(not found|does not exist|unknown)/i.test(text)) return { ...base, status: "unsupported", unsupportedReason: "PART_UNAVAILABLE", exitCode: result.exitCode, evidence: ev };
    const toolchain = { ...base.toolchain, licenseStatus: licenseSuccess ? "available" as const : base.toolchain.licenseStatus };
    return { ...base, status: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, toolchain, timeoutMs: effectiveTimeout, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev };
  }
}
