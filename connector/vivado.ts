import { createHash } from "node:crypto";
import { access, constants } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { ConnectorCapability, EvidenceManifest } from "./index.ts";

export const VIVADO_CAPABILITY_VERSION = "vivado-batch-1" as const;
export type VivadoOperation = "discover_toolchain" | "query_parts" | "validate_sources" | "simulate" | "synthesize" | "report_drc" | "report_sta" | "report_resources";
export type VivadoRunClass = "exploratory" | "gate_check" | "formal";
export type VivadoResultStatus = "succeeded" | "failed" | "unsupported";
export interface SourceInput { readonly path: string; readonly content: string | Uint8Array; readonly mediaType?: string; }
export interface VivadoRequestBase { readonly jobId: string; readonly runClass: VivadoRunClass; readonly projectId: string; readonly toolchain?: { readonly vivadoBinary?: string; readonly requiredLicense?: string; readonly part?: string; readonly profileHash?: string }; readonly timeoutMs?: number }
export interface DiscoverToolchainRequest extends VivadoRequestBase { readonly operation: "discover_toolchain" }
export interface QueryPartsRequest extends VivadoRequestBase { readonly operation: "query_parts"; readonly pattern?: string; readonly family?: string }
export interface ValidateSourcesRequest extends VivadoRequestBase { readonly operation: "validate_sources"; readonly sources: readonly SourceInput[]; readonly top?: string }
export interface SimulateRequest extends VivadoRequestBase { readonly operation: "simulate"; readonly sources: readonly SourceInput[]; readonly top: string; readonly testbench?: string }
export interface SynthesizeRequest extends VivadoRequestBase { readonly operation: "synthesize"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export interface ReportRequest extends VivadoRequestBase { readonly operation: "report_drc" | "report_sta" | "report_resources"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export type VivadoRequest = DiscoverToolchainRequest | QueryPartsRequest | ValidateSourcesRequest | SimulateRequest | SynthesizeRequest | ReportRequest;
export interface CapabilityDefinition<I extends VivadoRequest = VivadoRequest> extends ConnectorCapability { readonly operation: I["operation"]; readonly inputKind: string; readonly outputKind: string; readonly execution: "vivado_batch" }
export const VIVADO_CAPABILITIES: readonly CapabilityDefinition[] = [
  ["discover_toolchain", "node", "toolchain_snapshot"], ["query_parts", "part_query", "part_list"], ["validate_sources", "source_manifest", "source_validation"], ["simulate", "simulation_request", "simulation_result"], ["synthesize", "synthesis_request", "synthesis_result"], ["report_drc", "design_request", "drc_report"], ["report_sta", "design_request", "sta_report"], ["report_resources", "design_request", "resource_report"],
].map(([operation, inputKind, outputKind]) => ({ operation, version: VIVADO_CAPABILITY_VERSION, runClasses: ["exploratory", "gate_check", "formal"], inputKind, outputKind, execution: "vivado_batch" })) as readonly CapabilityDefinition[];
export interface EvidenceReference { readonly name: string; readonly uri: string; readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string }
export interface ToolchainMetadata { readonly binary: string; readonly vivadoVersion?: string; readonly licenseStatus: "available" | "unavailable" | "unknown"; readonly part?: string; readonly profileHash?: string }
export interface VivadoExecutionResult { readonly status: VivadoResultStatus; readonly jobId: string; readonly operation: VivadoOperation; readonly command: readonly string[]; readonly inputSha256: string; readonly workspace: string; readonly toolchain: ToolchainMetadata; readonly exitCode?: number; readonly output?: unknown; readonly evidence: EvidenceManifest; readonly unsupportedReason?: "BINARY_UNAVAILABLE" | "LICENSE_UNAVAILABLE" | "PART_UNAVAILABLE" }
export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;
export interface VivadoAdapterOptions { readonly workspaceRoot: string; readonly binary?: string; readonly commandRunner?: CommandRunner }

const idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function reject(code: string): never { throw new Error(`VIVADO_POLICY_REJECTED:${code}`); }
function safePath(path: string): void { if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("..") || path.includes("\\") || path.includes("\0")) reject("UNSAFE_PATH"); }
function safeToken(value: string, name: string): void { if (!value || value.length > 256 || /[\0\r\n{}\[\]$;]/.test(value)) reject(`UNSAFE_${name.toUpperCase()}`); }
export function validateVivadoRequest(request: VivadoRequest): void {
  if (!request || !idRe.test(request.jobId) || !idRe.test(request.projectId)) reject("INVALID_ID");
  if (!VIVADO_CAPABILITIES.some(c => c.operation === request.operation)) reject("CAPABILITY_UNAVAILABLE");
  if (request.toolchain?.vivadoBinary) safeToken(request.toolchain.vivadoBinary, "binary");
  if ("part" in request) safeToken(request.part, "part");
  if ("top" in request) safeToken(request.top, "top");
  if ("pattern" in request && request.pattern) safeToken(request.pattern, "pattern");
  if ("family" in request && request.family) safeToken(request.family, "family");
  if ("sources" in request) { if (!request.sources.length) reject("NO_SOURCES"); for (const source of request.sources) { safePath(source.path); const size = typeof source.content === "string" ? Buffer.byteLength(source.content) : source.content.byteLength; if (!size) reject("EMPTY_SOURCE"); if (size > 16 * 1024 * 1024) reject("SOURCE_TOO_LARGE"); } }
}
function tclQuote(value: string): string { return `{${value.replace(/[{}]/g, c => `\\${c}`)}}`; }
function scriptFor(request: VivadoRequest, inputDir: string, outputDir: string): string {
  const sources = "sources" in request ? request.sources.map(s => `read_verilog ${tclQuote(join(inputDir, s.path))}`).join("\n") : "";
  const top = "top" in request ? `-top ${tclQuote(request.top)}` : ""; const part = "part" in request ? `-part ${tclQuote(request.part)}` : request.toolchain?.part ? `-part ${tclQuote(request.toolchain.part)}` : "";
  if (request.operation === "discover_toolchain") return "puts [version -short]\nputs [join [get_parts *] \\\"\\n\\\"]";
  if (request.operation === "query_parts") return `puts [join [get_parts ${tclQuote(request.pattern ?? "*")}] "\\n"]`;
  if (request.operation === "validate_sources") return `${sources}\nputs SOURCE_VALIDATION_OK`;
  if (request.operation === "simulate") return `${sources}\nlaunch_simulation -mode behavioral\nputs SIMULATION_OK`;
  if (request.operation === "synthesize") return `${sources}\nsynth_design ${part} ${top}\nreport_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  const report = request.operation === "report_drc" ? `report_drc -file ${tclQuote(join(outputDir, "drc.rpt"))}` : request.operation === "report_sta" ? `report_timing_summary -file ${tclQuote(join(outputDir, "sta.rpt"))}` : `report_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  return `${sources}\nsynth_design ${part} ${top}\n${report}`;
}
async function evidence(workspace: string, jobId: string): Promise<EvidenceManifest> {
  const output = join(workspace, "output"); const entries: EvidenceReference[] = [];
  for (const name of await readdir(output)) { safePath(name); const bytes = await readFile(join(output, name)); entries.push({ name, uri: `workspace://${jobId}/output/${name}`, sha256: hash(bytes), sizeBytes: (await stat(join(output, name))).size, mediaType: name.endsWith(".rpt") ? "text/plain" : "application/octet-stream" }); }
  return { jobId, entries };
}
const defaultRunner: CommandRunner = (command, args, cwd, timeoutMs) => new Promise((ok, fail) => { const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d); const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); child.once("error", fail); child.once("close", exitCode => { clearTimeout(timer); ok({ exitCode: exitCode ?? 1, stdout, stderr }); }); });
export class VivadoBatchAdapter {
  private readonly run: CommandRunner; private readonly root: string; private readonly defaultBinary: string; private readonly injected: boolean;
  constructor(options: VivadoAdapterOptions) { this.root = resolve(options.workspaceRoot); this.defaultBinary = options.binary ?? "vivado"; this.injected = options.commandRunner !== undefined; this.run = options.commandRunner ?? defaultRunner; }
  capabilities(): readonly CapabilityDefinition[] { return VIVADO_CAPABILITIES; }
  async execute(request: VivadoRequest): Promise<VivadoExecutionResult> {
    validateVivadoRequest(request); const workspace = join(this.root, request.jobId); const inputDir = join(workspace, "input"); const outputDir = join(workspace, "output"); await mkdir(inputDir, { recursive: true }); await mkdir(outputDir, { recursive: true });
    if ("sources" in request) for (const source of request.sources) { safePath(source.path); await writeFile(join(inputDir, source.path), source.content); }
    const inputSha256 = hash(JSON.stringify(request)); const binary = request.toolchain?.vivadoBinary ?? this.defaultBinary; const command = [binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", join(workspace, "run.tcl")]; const base = { jobId: request.jobId, operation: request.operation, command, inputSha256, workspace, toolchain: { binary, licenseStatus: "unknown" as const, part: "part" in request ? request.part : request.toolchain?.part, profileHash: request.toolchain?.profileHash }, evidence: { jobId: request.jobId, entries: [] } satisfies EvidenceManifest };
    try { if (!this.injected && binary.includes("/")) await access(binary, constants.X_OK); } catch { return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE" }; }
    await writeFile(join(workspace, "run.tcl"), scriptFor(request, inputDir, outputDir), "utf8");
    let result: CommandResult; try { result = await this.run(binary, command.slice(1), workspace, request.timeoutMs ?? 30 * 60 * 1000); } catch { return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE", evidence: await evidence(workspace, request.jobId) }; }
    const text = `${result.stdout}\n${result.stderr}`; const ev = await evidence(workspace, request.jobId); if (/license|checkout|feature.*not found/i.test(text)) return { ...base, status: "unsupported", unsupportedReason: "LICENSE_UNAVAILABLE", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "unavailable" }, evidence: ev }; if (/part.*(not found|does not exist|unknown)/i.test(text)) return { ...base, status: "unsupported", unsupportedReason: "PART_UNAVAILABLE", exitCode: result.exitCode, evidence: ev }; return { ...base, status: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "available" }, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev };
  }
}
