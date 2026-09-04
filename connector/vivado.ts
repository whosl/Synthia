import { createHash } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { ConnectorCapability, EvidenceManifest } from "./index.ts";
import { buildLogDigest, LOG_DIGEST_FILE_NAME, type LogDigest } from "./log-digest.ts";

export const VIVADO_CAPABILITY_VERSION = "vivado-batch-1" as const;
export type VivadoOperation = "discover_toolchain" | "query_parts" | "validate_sources" | "simulate" | "synthesize" | "implement" | "report_drc" | "report_sta" | "report_resources";
export type VivadoRunClass = "exploratory" | "gate_check" | "formal";
export type VivadoResultStatus = "succeeded" | "failed" | "unsupported" | "timeout" | "lost" | "unknown_effect";
export interface SourceInput { readonly path: string; readonly content: string | Uint8Array; readonly mediaType?: string; }
export interface VivadoRequestBase { readonly jobId: string; readonly runClass: VivadoRunClass; readonly projectId: string; readonly inputHash?: string; readonly toolchainHash?: string; readonly toolchain?: { readonly vivadoBinary?: string; readonly requiredLicense?: string; readonly part?: string; readonly profileHash?: string }; readonly timeoutMs?: number }
export interface DiscoverToolchainRequest extends VivadoRequestBase { readonly operation: "discover_toolchain" }
export interface QueryPartsRequest extends VivadoRequestBase { readonly operation: "query_parts"; readonly pattern?: string; readonly family?: string }
export interface ValidateSourcesRequest extends VivadoRequestBase { readonly operation: "validate_sources"; readonly sources: readonly SourceInput[]; readonly top?: string }
export interface SimulateRequest extends VivadoRequestBase { readonly operation: "simulate"; readonly sources: readonly SourceInput[]; readonly top: string; readonly testbench: string }
export interface SynthesizeRequest extends VivadoRequestBase { readonly operation: "synthesize"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export interface ConstraintInput { readonly path: string; readonly content: string | Uint8Array; readonly mediaType?: string }
export interface ImplementRequest extends VivadoRequestBase { readonly operation: "implement"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string; readonly constraints?: readonly ConstraintInput[]; readonly stopBeforeBitstream?: boolean }
export interface ReportRequest extends VivadoRequestBase { readonly operation: "report_drc" | "report_sta" | "report_resources"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export type VivadoRequest = DiscoverToolchainRequest | QueryPartsRequest | ValidateSourcesRequest | SimulateRequest | SynthesizeRequest | ImplementRequest | ReportRequest;
export interface CapabilityDefinition<I extends VivadoRequest = VivadoRequest> extends ConnectorCapability { readonly operation: I["operation"]; readonly inputKind: string; readonly outputKind: string; readonly execution: "vivado_batch" }
export const VIVADO_CAPABILITIES: readonly CapabilityDefinition[] = [
  ["discover_toolchain", "node", "toolchain_snapshot"], ["query_parts", "part_query", "part_list"], ["validate_sources", "source_manifest", "source_validation"], ["simulate", "simulation_request", "simulation_result"], ["synthesize", "synthesis_request", "synthesis_result"], ["implement", "implementation_request", "bitstream_artifact"], ["report_drc", "design_request", "drc_report"], ["report_sta", "design_request", "sta_report"], ["report_resources", "design_request", "resource_report"],
].map(([operation, inputKind, outputKind]) => ({ operation, version: VIVADO_CAPABILITY_VERSION, runClasses: ["exploratory", "gate_check", "formal"], inputKind, outputKind, execution: "vivado_batch" })) as readonly CapabilityDefinition[];
export interface EvidenceReference { readonly name: string; readonly uri: string; readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string }
export interface ToolchainMetadata { readonly binary: string; readonly vivadoVersion?: string; readonly licenseStatus: "available" | "unavailable" | "unknown"; readonly part?: string; readonly profileHash?: string }
export interface VivadoExecutionResult { readonly status: VivadoResultStatus; readonly jobId: string; readonly operation: VivadoOperation; readonly command: readonly string[]; readonly inputSha256: string; readonly workspace: string; readonly toolchain: ToolchainMetadata; readonly exitCode?: number; readonly phase?: string; readonly phaseExitCode?: number; readonly simulatorStdout?: string; readonly stdout?: string; readonly stderr?: string; readonly output?: unknown; readonly errorCode?: string; readonly error?: Record<string, unknown>; readonly evidence: EvidenceManifest; readonly unsupportedReason?: "BINARY_UNAVAILABLE" | "LICENSE_UNAVAILABLE" | "PART_UNAVAILABLE"; readonly timeoutMs?: number; readonly timedOut?: boolean; readonly signal?: string | null; readonly logDigest?: LogDigest }
export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean; readonly signal?: string | null }
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;
export interface VivadoAdapterOptions { readonly workspaceRoot: string; readonly binary?: string; readonly part?: string; readonly profileHash?: string; readonly commandRunner?: CommandRunner }
export const VIVADO_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const VIVADO_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** XSim simulation runtime cap (sim-time, not wall-clock).
 *  TBs with $finish complete naturally before this; TBs without $finish stop
 *  here instead of looping until the process-level timeoutMs (30 min default)
 *  burns Vivado compute on 66. 100 ms sim-time is far beyond what realistic
 *  behavioral TBs need (the golden UART TB runs ~4.2 ms), yet tight enough to
 *  fail-closed quickly on a runaway TB. request.timeoutMs remains the hard
 *  wall-clock backstop. */
const XSIM_RUNTIME_CAP = "100ms";

const idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function reject(code: string): never { throw new Error(`VIVADO_POLICY_REJECTED:${code}`); }
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
function safePath(path: string): void {
  if (!path || Buffer.byteLength(path, "utf8") > 512 || path !== path.normalize("NFC") || path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.includes("\0")) reject("UNSAFE_PATH");
  const segments = path.split("/");
  if (segments.length === 0 || segments.length > 32) reject("UNSAFE_PATH");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || Buffer.byteLength(segment, "utf8") > 255 || /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment) || /[ .]$/.test(segment)) reject("UNSAFE_PATH");
    const deviceName = segment.split(".", 1)[0]!.replace(/[ .]+$/u, "");
    if (WINDOWS_RESERVED_NAME.test(deviceName)) reject("UNSAFE_PATH");
  }
}
function portablePathKey(path: string): string { return path.normalize("NFC").toLowerCase(); }
function assertDistinctPortablePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = portablePathKey(path);
    if (seen.has(key)) reject("PATH_COLLISION");
    seen.add(key);
  }
}
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
  while ((m = moduleDeclRe.exec(text)) !== null) names.push(m[1]!);
  return names;
}
function assertSimulateModules(request: SimulateRequest): void {
  const totals = new Map<string, number>();
  for (const source of request.sources) for (const name of declaredModules(source)) totals.set(name, (totals.get(name) ?? 0) + 1);
  const topCount = totals.get(request.top) ?? 0; const tbCount = totals.get(request.testbench) ?? 0;
  if (topCount === 0 || tbCount === 0) reject("MISSING_TOP_MODULE");
  if (topCount > 1 || tbCount > 1) reject("AMBIGUOUS_TOP_MODULE");
  for (const source of request.sources) { const names = new Set(declaredModules(source)); if (names.has(request.top) && names.has(request.testbench)) reject("AMBIGUOUS_SOURCE_ROLE"); }
}
const XDC_COMMANDS = new Set([
  "create_clock",
  "create_generated_clock",
  "set_case_analysis",
  "set_clock_groups",
  "set_clock_latency",
  "set_clock_transition",
  "set_clock_uncertainty",
  "set_disable_timing",
  "set_false_path",
  "set_input_delay",
  "set_input_transition",
  "set_io",
  "set_load",
  "set_location",
  "set_max_capacitance",
  "set_max_delay",
  "set_max_fanout",
  "set_max_transition",
  "set_min_delay",
  "set_multicycle_path",
  "set_output_delay",
  "set_property",
]);
const XDC_QUERY_COMMANDS = new Set(["current_design", "get_cells", "get_clocks", "get_drc_checks", "get_nets", "get_pins", "get_ports"]);
function assertXdcLine(line: string): void {
  if (/\\[ \t]*$/.test(line)) reject("XDC_LINE_CONTINUATION");
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  if (
    /\bset_property\b/i.test(trimmed) &&
    /\bSEVERITY\b/i.test(trimmed) &&
    /\bget_drc_checks\b/i.test(trimmed) &&
    /\b(?:NSTD-1|UCIO-1)\b/i.test(trimmed)
  ) reject("UNSAFE_XDC_DRC_SEVERITY_OVERRIDE");
  if (trimmed.includes("$") || trimmed.includes(";") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed)) reject("UNSAFE_XDC_COMMAND");
  let remainder = "";
  for (let cursor = 0; cursor < trimmed.length;) {
    const open = trimmed.indexOf("[", cursor);
    const strayClose = trimmed.indexOf("]", cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) reject("UNSAFE_XDC_COMMAND");
    if (open === -1) { remainder += trimmed.slice(cursor); break; }
    remainder += trimmed.slice(cursor, open);
    const close = trimmed.indexOf("]", open + 1);
    if (close === -1 || trimmed.slice(open + 1, close).includes("[") || trimmed.slice(open + 1, close).includes("]")) reject("UNSAFE_XDC_COMMAND");
    const query = trimmed.slice(open + 1, close).trim();
    const command = query.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
    if (!command || !XDC_QUERY_COMMANDS.has(command)) reject("UNSAFE_XDC_QUERY");
    remainder += " __SYNTHIA_QUERY__ ";
    cursor = close + 1;
  }
  if (remainder.includes("[") || remainder.includes("]")) reject("UNSAFE_XDC_COMMAND");
  const command = remainder.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
  if (!command || !XDC_COMMANDS.has(command)) reject("UNSAFE_XDC_COMMAND");
}
function assertXdcPolicy(content: string | Uint8Array): void {
  let text: string;
  try { text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { reject("INVALID_CONSTRAINT_ENCODING"); }
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) reject("INVALID_CONSTRAINT_ENCODING");
  for (const line of normalized.split("\n")) assertXdcLine(line);
}
export function validateVivadoRequest(request: VivadoRequest): void {
  if (!isPlainObject(request)) reject("INVALID_REQUEST");
  if (typeof request.jobId !== "string" || typeof request.projectId !== "string" || !idRe.test(request.jobId) || !idRe.test(request.projectId)) reject("INVALID_ID");
  if (request.runClass !== "exploratory" && request.runClass !== "gate_check" && request.runClass !== "formal") reject("INVALID_RUN_CLASS");
  if (request.inputHash !== undefined && (typeof request.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(request.inputHash))) reject("INVALID_INPUT_HASH");
  if (request.toolchainHash !== undefined && (typeof request.toolchainHash !== "string" || !/^[0-9a-f]{64}$/.test(request.toolchainHash))) reject("INVALID_TOOLCHAIN_HASH");
  if (request.runClass === "formal" && (!request.inputHash || !request.toolchainHash)) reject("FORMAL_BINDING_REQUIRED");
  if (request.timeoutMs !== undefined) { const t = request.timeoutMs; if (typeof t !== "number" || !Number.isFinite(t) || !Number.isInteger(t) || t <= 0 || t > VIVADO_MAX_TIMEOUT_MS) reject("INVALID_TIMEOUT"); }
  if (!VIVADO_CAPABILITIES.some(c => c.operation === request.operation)) reject("CAPABILITY_UNAVAILABLE");
  if (request.toolchain !== undefined) {
    if (!isPlainObject(request.toolchain)) reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary !== undefined && typeof request.toolchain.vivadoBinary !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.requiredLicense !== undefined && typeof request.toolchain.requiredLicense !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.part !== undefined && typeof request.toolchain.part !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.profileHash !== undefined && typeof request.toolchain.profileHash !== "string") reject("INVALID_TOOLCHAIN");
    if (request.toolchain.vivadoBinary) safeToken(request.toolchain.vivadoBinary, "binary");
    if (request.toolchain.part) safeToken(request.toolchain.part, "part");
    if (request.toolchain.profileHash !== undefined && !/^[0-9a-f]{64}$/.test(request.toolchain.profileHash)) reject("INVALID_TOOLCHAIN");
    if (request.runClass === "formal" && request.toolchain.profileHash !== undefined && request.toolchain.profileHash !== request.toolchainHash) reject("FORMAL_TOOLCHAIN_MISMATCH");
  }
  if ("part" in request) { if (typeof request.part !== "string") reject("INVALID_PART"); safeToken(request.part, "part"); }
  if ("top" in request) { if (typeof request.top !== "string") reject("INVALID_TOP"); safeToken(request.top, "top"); }
  if ("stopBeforeBitstream" in request && request.stopBeforeBitstream !== undefined) {
    if (request.operation !== "implement" || typeof request.stopBeforeBitstream !== "boolean") reject("INVALID_STOP_BEFORE_BITSTREAM");
  }
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
  if ("constraints" in request && request.constraints !== undefined) {
    if (!Array.isArray(request.constraints)) reject("INVALID_CONSTRAINTS");
    for (const constraint of request.constraints) {
      if (!isPlainObject(constraint)) reject("INVALID_CONSTRAINT");
      if (typeof constraint.path !== "string") reject("INVALID_CONSTRAINT_PATH");
      safePath(constraint.path);
      if (!constraint.path.toLowerCase().endsWith(".xdc")) reject("UNSUPPORTED_CONSTRAINT_FORMAT");
      if (typeof constraint.content !== "string" && !(constraint.content instanceof Uint8Array)) reject("INVALID_CONSTRAINT_CONTENT");
      if (constraint.mediaType !== undefined && typeof constraint.mediaType !== "string") reject("INVALID_CONSTRAINT_MEDIA_TYPE");
      const size = typeof constraint.content === "string" ? Buffer.byteLength(constraint.content) : constraint.content.byteLength;
      if (!size) reject("EMPTY_CONSTRAINT");
      if (size > 4 * 1024 * 1024) reject("CONSTRAINT_TOO_LARGE");
      assertXdcPolicy(constraint.content);
    }
  }
  const paths = [
    ...("sources" in request && Array.isArray(request.sources) ? request.sources.map(source => source.path) : []),
    ...("constraints" in request && Array.isArray(request.constraints) ? request.constraints.map(constraint => constraint.path) : []),
  ];
  assertDistinctPortablePaths(paths);
  if ("part" in request && request.toolchain?.part !== undefined && request.part !== request.toolchain.part) reject("TOOLCHAIN_PART_MISMATCH");
}
function tclQuote(value: string): string { return `{${value.replace(/[{}]/g, c => `\\${c}`)}}`; }
function readSourceLine(source: SourceInput, inputDir: string): string {
  const target = tclQuote(join(inputDir, source.path));
  const isSystemVerilog = source.path.toLowerCase().endsWith(".sv") || source.mediaType === "text/systemverilog" || source.mediaType === "application/systemverilog";
  return isSystemVerilog ? `read_verilog -sv ${target}` : `read_verilog ${target}`;
}
function scriptFor(request: VivadoRequest, inputDir: string, outputDir: string): string {
  const sources = "sources" in request ? request.sources.map(s => readSourceLine(s, inputDir)).join("\n") : "";
  const top = "top" in request && typeof request.top === "string" ? `-top ${tclQuote(request.top)}` : ""; const part = "part" in request && typeof request.part === "string" ? `-part ${tclQuote(request.part)}` : request.toolchain?.part ? `-part ${tclQuote(request.toolchain.part)}` : "";
  if (request.operation === "discover_toolchain") return "puts [version -short]\nputs [join [get_parts *] \\\"\\n\\\"]";
  if (request.operation === "query_parts") return `puts [join [get_parts ${tclQuote(request.pattern ?? "*")}] "\\n"]`;
  if (request.operation === "validate_sources") return `${sources}\nputs SOURCE_VALIDATION_OK`;
  if (request.operation === "simulate") {
    const designPaths: string[] = []; const simPaths: string[] = [];
    for (const source of request.sources) {
      const target = tclQuote(join(inputDir, source.path));
      const testSource = declaredModules(source).includes(request.testbench) || /(^|\/)(?:tb|test|tests|testbench)(?:\/|$)/i.test(source.path);
      (testSource ? simPaths : designPaths).push(target);
    }
    const designFiles = designPaths.join(" ");
    const simFiles = simPaths.join(" ");
    const project = tclQuote(join(resolve(inputDir, ".."), "vivado-project"));
    const projectPart = tclQuote(request.toolchain?.part ?? "xc7k70tfbv676-1");
    const topQ = tclQuote(request.top);
    const tbQ = tclQuote(request.testbench);
    return `${sources}\ncreate_project synthia_batch ${project} -part ${projectPart} -force\nadd_files -fileset sources_1 ${designFiles}\nadd_files -fileset sim_1 ${simFiles}\nset_property top ${topQ} [get_filesets sources_1]\nset_property top ${tbQ} [get_filesets sim_1]\nset_property xsim.simulate.runtime {${XSIM_RUNTIME_CAP}} [get_filesets sim_1]\nupdate_compile_order -fileset sources_1\nupdate_compile_order -fileset sim_1\nlaunch_simulation -mode behavioral -scripts_only -absolute_path\nset simRoot [file normalize [file join ${project} "synthia_batch.sim" "sim_1" "behav" "xsim"]]\ncd $simRoot\nproc phaseExitCode {options} {\n  if {[dict exists $options -errorcode]} {\n    set ec [dict get $options -errorcode]\n    if {[llength $ec] >= 3 && [lindex $ec 0] eq "CHILDSTATUS"} { return [lindex $ec 2] }\n  }\n  return 1\n}\nset phase compile\nif {[catch {exec cmd.exe /d /c [list call [file join $simRoot compile.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=compile"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }\nset phase elaborate\nif {[catch {exec cmd.exe /d /c [list call [file join $simRoot elaborate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=elaborate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; return -options $sim_options $sim_output }\nset phase simulate\nif {[catch {exec cmd.exe /d /c [list call [file join $simRoot simulate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=simulate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts "SIMULATOR_OUTPUT_BEGIN"; puts $sim_output; puts "SIMULATOR_OUTPUT_END"; return -options $sim_options $sim_output }\nputs "PHASE=simulate"\nputs "PHASE_EXIT_CODE=0"\nputs "SIMULATOR_OUTPUT_BEGIN"\nputs $sim_output\nputs "SIMULATOR_OUTPUT_END"\nputs SIMULATION_OK`;
  }
  if (request.operation === "synthesize") return `${sources}\nsynth_design ${part} ${top}\nreport_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  if (request.operation === "implement") {
    const constraints = (request.constraints ?? []).map(c => `read_xdc ${tclQuote(join(inputDir, c.path))}`).join("\n");
    const out = (name: string) => tclQuote(join(outputDir, name));
    // Single-session full flow: DCPs and the bitstream never leave the job workspace,
    // so every stage consumes state produced earlier in THIS run — no cross-job artifact transfer.
    return [sources, constraints, `synth_design ${part} ${top}`, `write_checkpoint -force ${out("synth.dcp")}`, "opt_design", "place_design", "route_design", `report_methodology -file ${out("methodology.rpt")}`, `report_cdc -details -file ${out("cdc.rpt")}`, `report_drc -file ${out("drc.rpt")}`, `report_timing_summary -file ${out("sta.rpt")}`, `report_utilization -file ${out("resources.rpt")}`, "set drcErrors [get_drc_violations -quiet -filter {SEVERITY == Error}]", "if {[llength $drcErrors] > 0} { error \"SYNTHIA_DRC_FAILED\" }", "set timingClocks [get_clocks -quiet]", "if {[llength $timingClocks] == 0} { error \"SYNTHIA_TIMING_UNCONSTRAINED\" }", "set failingPaths [get_timing_paths -quiet -max_paths 1 -slack_lesser_than 0]", "if {[llength $failingPaths] > 0} { error \"SYNTHIA_TIMING_FAILED\" }", `write_checkpoint -force ${out("routed.dcp")}`, request.stopBeforeBitstream ? "puts BITSTREAM_GENERATION_SKIPPED" : `write_bitstream -force ${out("synthia.bit")}`, "puts IMPLEMENT_OK"].filter(Boolean).join("\n");
  }
  const report = request.operation === "report_drc" ? `report_drc -file ${tclQuote(join(outputDir, "drc.rpt"))}` : request.operation === "report_sta" ? `report_timing_summary -file ${tclQuote(join(outputDir, "sta.rpt"))}` : `report_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  return `${sources}\nsynth_design ${part} ${top}\n${report}`;
}

function inputMember(source: SourceInput): Record<string, unknown> {
  const bytes = typeof source.content === "string"
    ? new TextEncoder().encode(source.content)
    : source.content;
  return {
    path: source.path,
    sha256: hash(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: source.mediaType ?? "application/octet-stream",
  };
}

/** A content-free, deterministic record of the exact Vivado request binding. */
function evidenceInputManifest(request: VivadoRequest): Record<string, unknown> {
  return {
    schema: "vivado-input-manifest.v1",
    jobId: request.jobId,
    projectId: request.projectId,
    operation: request.operation,
    runClass: request.runClass,
    inputHash: request.inputHash ?? null,
    toolchainHash: request.toolchainHash ?? request.toolchain?.profileHash ?? null,
    top: "top" in request ? request.top : null,
    testbench: request.operation === "simulate" ? request.testbench : null,
    part: request.operation === "synthesize" || request.operation === "implement"
      ? ("part" in request ? request.part : request.toolchain?.part ?? null)
      : null,
    stopBeforeBitstream: request.operation === "implement" ? request.stopBeforeBitstream === true : null,
    sources: "sources" in request
      ? request.sources.map(inputMember).sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0)
      : [],
    constraints: "constraints" in request && request.constraints
      ? request.constraints.map(inputMember).sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0)
      : [],
  };
}

const RESULT_FILE_BY_OPERATION: Readonly<Partial<Record<VivadoOperation, string>>> = {
  validate_sources: "validation-result.json",
  simulate: "simulation-result.json",
  synthesize: "synthesis-result.json",
  implement: "implementation-result.json",
};

async function writeExecutionEvidence(
  outputDir: string,
  request: VivadoRequest,
  result: CommandResult,
  status: VivadoResultStatus,
  details: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  await Promise.all([
    writeFile(join(outputDir, "stdout.log"), stdout, "utf8"),
    writeFile(join(outputDir, "stderr.log"), stderr, "utf8"),
    writeFile(join(outputDir, "tool.log"), `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`, "utf8"),
  ]);
  const resultName = RESULT_FILE_BY_OPERATION[request.operation];
  if (resultName) {
    await writeFile(join(outputDir, resultName), JSON.stringify({
      schema: `${request.operation}-result.v1`,
      passed: status === "succeeded",
      status,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      ...details,
    }, null, 2), "utf8");
  }
}

async function evidence(workspace: string, jobId: string, omittedNames: ReadonlySet<string> = new Set()): Promise<EvidenceManifest> {
  const output = join(workspace, "output"); const entries: EvidenceReference[] = [];
  for (const name of (await readdir(output)).sort()) {
    safePath(name);
    if (omittedNames.has(name)) continue;
    const bytes = await readFile(join(output, name));
    const mediaType = name.endsWith(".json")
      ? "application/json"
      : name.endsWith(".rpt") || name.endsWith(".log") || name.endsWith(".tcl")
        ? "text/plain"
        : "application/octet-stream";
    entries.push({ name, uri: `workspace://${jobId}/output/${name}`, sha256: hash(bytes), sizeBytes: (await stat(join(output, name))).size, mediaType });
  }
  return { jobId, entries };
}
function terminateProcessTree(pid: number): void {
  try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}
const defaultRunner: CommandRunner = (command, args, cwd, timeoutMs) => {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const lower = command.toLowerCase();
  const isBatch = lower.endsWith(".bat") || lower.endsWith(".cmd");
  const child = isBatch
    ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: true })
    : spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (d: Buffer) => stdout += d); child.stderr.on("data", (d: Buffer) => stderr += d);
  const timer = setTimeout(() => { timedOut = true; if (child.pid) terminateProcessTree(child.pid); }, timeoutMs);
  child.once("error", reject);
  child.once("close", exitCode => { clearTimeout(timer); resolve({ exitCode: exitCode ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, signal: timedOut ? "SIGTERM" : null }); });
  return promise;
};
function parseSimulatePhases(text: string): { phase?: string; phaseExitCode?: number; simulatorStdout?: string } {
  const phaseMatch = text.match(/^PHASE=(\S+)/m);
  const exitMatch = text.match(/^PHASE_EXIT_CODE=(\d+)/m);
  const beginIdx = text.indexOf("SIMULATOR_OUTPUT_BEGIN");
  const endIdx = text.lastIndexOf("SIMULATOR_OUTPUT_END");
  const simulatorStdout = beginIdx !== -1 && endIdx !== -1 ? text.slice(beginIdx + "SIMULATOR_OUTPUT_BEGIN".length, endIdx).trim() : undefined;
  return { phase: phaseMatch?.[1], phaseExitCode: exitMatch ? Number(exitMatch[1]) : undefined, simulatorStdout };
}
/** Judge a behavioral simulation result from its controlled output region.
 *  XSim can print `Fatal:` (from a TB `$fatal`) yet still exit 0, so the exit
 *  code alone is unsafe. All markers are scoped to the SIMULATOR_OUTPUT region
 *  to avoid false matches from log lines or echoed source elsewhere. */
function judgeSimulation(simulatorStdout: string | undefined, phaseExitCode: number | undefined, exitCode: number): { status: VivadoResultStatus; errorCode?: string } {
  const region = simulatorStdout ?? "";
  if (/\bFatal:/i.test(region) || /\$fatal/i.test(region) || /^\s*FAIL\b/m.test(region)) return { status: "failed", errorCode: "VIVADO_SIMULATION_FAILED" };
  if ((phaseExitCode ?? exitCode) !== 0 || exitCode !== 0) return { status: "failed", errorCode: "VIVADO_SIMULATION_FAILED" };
  if (/\bPASS\b/.test(region)) return { status: "succeeded" };
  return { status: "failed", errorCode: "VIVADO_SIMULATION_INCONCLUSIVE" };
}
export type ReportVerdict = "passed" | "failed" | "unconstrained" | "inconclusive";
const PRE_BITSTREAM_IMPLEMENTATION_OUTPUTS = ["synth.dcp", "methodology.rpt", "cdc.rpt", "drc.rpt", "sta.rpt", "resources.rpt", "routed.dcp"] as const;
const FAILED_IMPLEMENTATION_OMISSIONS = new Set(["synthia.bit"]);
export function judgeDrcReport(report: string): ReportVerdict {
  const finished = report.match(/DRC finished with\s+(\d+)\s+Errors?/i);
  if (finished) return Number(finished[1]) === 0 ? "passed" : "failed";
  if (!/\bReport DRC\b/i.test(report)) return "inconclusive";
  const found = report.match(/Violations found:\s*(\d+)/i);
  const rows = [...report.matchAll(/^\|\s*[^|]+\|\s*(Error|Critical Warning|Warning|Advisory)\s*\|[^|]*\|\s*(\d+)\s*\|\s*$/gim)];
  if (rows.some(row => row[1]?.toLowerCase() === "error") || /^\S+#\d+\s+Error\s*$/im.test(report)) return "failed";
  if (!found) return "inconclusive";
  const violationCount = Number(found[1]);
  if (violationCount === 0) return "passed";
  const summarizedCount = rows.reduce((total, row) => total + Number(row[2]), 0);
  return rows.length > 0 && summarizedCount === violationCount ? "passed" : "inconclusive";
}
export function judgeStaReport(report: string): ReportVerdict {
  if (
    /There are\s+[1-9]\d*\s+register\/latch pins with no clock driven/i.test(report) ||
    /There are no user specified timing constraints\./i.test(report) ||
    /\bno clocks? found\b/i.test(report) ||
    /\bno timing constraints?\b/i.test(report)
  ) return "unconstrained";
  if (/timing constraints are not met/i.test(report) || /Slack\s*\(VIOLATED\)/i.test(report)) return "failed";
  const lines = report.split(/\r?\n/);
  const summaryHeader = lines.findIndex(line => /\bWNS\(ns\)/.test(line) && /\bTNS\(ns\)/.test(line));
  let summary: number[] | undefined;
  if (summaryHeader !== -1) {
    for (const line of lines.slice(summaryHeader + 1, summaryHeader + 8)) {
      const values = line.trim().split(/\s+/);
      if (values.length >= 2 && values.every(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) { summary = values.map(Number); break; }
    }
  }
  if (summary) {
    const slackAndViolationIndexes = summary.length >= 10 ? [0, 1, 4, 5, 8, 9] : [0, 1];
    if (slackAndViolationIndexes.some(index => (summary?.[index] ?? 0) < 0)) return "failed";
  }
  if (!/All user specified timing constraints are met\./i.test(report) || !summary) return "inconclusive";
  return "passed";
}
async function implementationVerdict(outputDir: string, exitCode: number, text: string, stopBeforeBitstream: boolean): Promise<{ status: VivadoResultStatus; errorCode?: string }> {
  let drc: string | undefined; let sta: string | undefined;
  try { drc = await readFile(join(outputDir, "drc.rpt"), "utf8"); } catch {}
  try { sta = await readFile(join(outputDir, "sta.rpt"), "utf8"); } catch {}
  if (drc !== undefined && judgeDrcReport(drc) === "failed" || /SYNTHIA_DRC_FAILED/.test(text)) return { status: "failed", errorCode: "VIVADO_DRC_FAILED" };
  if (sta !== undefined && judgeStaReport(sta) === "unconstrained" || /SYNTHIA_TIMING_UNCONSTRAINED/.test(text)) return { status: "failed", errorCode: "VIVADO_TIMING_UNCONSTRAINED" };
  if (sta !== undefined && judgeStaReport(sta) === "failed" || /SYNTHIA_TIMING_FAILED/.test(text)) return { status: "failed", errorCode: "VIVADO_TIMING_FAILED" };
  if (exitCode !== 0) return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_FAILED" };
  if (drc === undefined || sta === undefined || judgeDrcReport(drc) !== "passed" || judgeStaReport(sta) !== "passed") return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_EVIDENCE_INCOMPLETE" };
  for (const name of [...PRE_BITSTREAM_IMPLEMENTATION_OUTPUTS, ...(stopBeforeBitstream ? [] : ["synthia.bit"])]) {
    try { const details = await stat(join(outputDir, name)); if (!details.isFile() || details.size === 0) return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_EVIDENCE_INCOMPLETE" }; }
    catch { return { status: "failed", errorCode: "VIVADO_IMPLEMENTATION_EVIDENCE_INCOMPLETE" }; }
  }
  if (stopBeforeBitstream) {
    try { await access(join(outputDir, "synthia.bit")); return { status: "failed", errorCode: "VIVADO_UNEXPECTED_BITSTREAM" }; }
    catch {}
  }
  return { status: "succeeded" };
}
async function failedImplementationEvidence(workspace: string, jobId: string): Promise<EvidenceManifest> {
  try { await unlink(join(workspace, "output", "synthia.bit")); } catch {}
  return evidence(workspace, jobId, FAILED_IMPLEMENTATION_OMISSIONS);
}
export class VivadoBatchAdapter {
  private readonly run: CommandRunner; private readonly root: string; private readonly defaultBinary: string; private readonly configuredPart: string | undefined; private readonly configuredProfileHash: string | undefined; private readonly injected: boolean;
  constructor(options: VivadoAdapterOptions) { this.root = resolve(options.workspaceRoot); this.defaultBinary = options.binary ?? "vivado"; this.configuredPart = options.part; this.configuredProfileHash = options.profileHash; this.injected = options.commandRunner !== undefined; this.run = options.commandRunner ?? defaultRunner; }
  capabilities(): readonly CapabilityDefinition[] { return VIVADO_CAPABILITIES; }
  async execute(request: VivadoRequest): Promise<VivadoExecutionResult> {
    validateVivadoRequest(request);
    if (request.toolchain?.vivadoBinary !== undefined && request.toolchain.vivadoBinary !== this.defaultBinary) reject("TOOLCHAIN_BINARY_MISMATCH");
    if (this.configuredPart !== undefined && (("part" in request && request.part !== this.configuredPart) || (request.toolchain?.part !== undefined && request.toolchain.part !== this.configuredPart))) reject("TOOLCHAIN_PART_MISMATCH");
    if (this.configuredProfileHash !== undefined && ((request.toolchainHash !== undefined && request.toolchainHash !== this.configuredProfileHash) || (request.toolchain?.profileHash !== undefined && request.toolchain.profileHash !== this.configuredProfileHash))) reject("TOOLCHAIN_PROFILE_MISMATCH");
    const effectiveToolchain = {
      ...(request.toolchain ?? {}),
      vivadoBinary: this.defaultBinary,
      ...(this.configuredPart !== undefined ? { part: this.configuredPart } : {}),
      ...(this.configuredProfileHash !== undefined ? { profileHash: this.configuredProfileHash } : {}),
    };
    const effectiveRequest = { ...request, toolchain: effectiveToolchain } as VivadoRequest;
    const workspace = join(this.root, request.jobId); const inputDir = join(workspace, "input"); const outputDir = join(workspace, "output"); await mkdir(inputDir, { recursive: true }); await mkdir(outputDir, { recursive: true });
    if (request.operation === "implement" && request.stopBeforeBitstream === true) {
      try { await unlink(join(outputDir, "synthia.bit")); } catch {}
    }
    if ("sources" in request) for (const source of request.sources) { safePath(source.path); const target = join(inputDir, source.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, source.content); }
    if ("constraints" in request && request.constraints) for (const constraint of request.constraints) { safePath(constraint.path); const target = join(inputDir, constraint.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, constraint.content); }
    const inputSha256 = hash(JSON.stringify(effectiveRequest)); const binary = this.defaultBinary; const command = [binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", join(workspace, "run.tcl")]; const base = { jobId: request.jobId, operation: request.operation, command, inputSha256, workspace, toolchain: { binary, licenseStatus: "unknown" as const, part: "part" in request ? request.part : effectiveRequest.toolchain?.part, profileHash: effectiveRequest.toolchain?.profileHash ?? request.toolchainHash }, evidence: { jobId: request.jobId, entries: [] } satisfies EvidenceManifest };
    try { if (!this.injected && (binary.includes("/") || binary.includes("\\"))) await access(binary, constants.X_OK); } catch { return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE" }; }
    const runScript = scriptFor(effectiveRequest, inputDir, outputDir);
    await Promise.all([
      writeFile(join(workspace, "run.tcl"), runScript, "utf8"),
      writeFile(join(outputDir, "run.tcl"), runScript, "utf8"),
      writeFile(join(outputDir, "input-manifest.json"), JSON.stringify(evidenceInputManifest(effectiveRequest), null, 2), "utf8"),
    ]);
    const effectiveTimeout = request.timeoutMs ?? VIVADO_DEFAULT_TIMEOUT_MS;
    let result: CommandResult;
    try {
      result = await this.run(binary, command.slice(1), workspace, effectiveTimeout);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      const ev = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId);
      if (code === "ENOENT" || code === "EACCES") return { ...base, status: "unsupported", unsupportedReason: "BINARY_UNAVAILABLE", evidence: ev };
      return { ...base, status: "lost", evidence: ev };
    }
    if (result.timedOut) { const ev = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId); return { ...base, status: "timeout", timedOut: true, signal: result.signal ?? null, exitCode: result.exitCode, timeoutMs: effectiveTimeout, evidence: ev }; }
    const text = `${result.stdout}\n${result.stderr}`;
    // Structured log digest: written before any verdict branch so every
    // downstream path (license failure, part failure, simulate, implement,
    // default) carries it — both as an evidence file (cheap for consumers to
    // fetch) and on the result object (embedded into worker-result.json).
    const baseDigest = buildLogDigest(request.operation, { stdout: result.stdout, stderr: result.stderr });
    await writeFile(join(outputDir, LOG_DIGEST_FILE_NAME), JSON.stringify(baseDigest, null, 2), "utf8");
    const licenseSuccess = /\b(?:checkout|feature)\b.*\b(?:succe\w*|granted|checked[\s-]*out)\b|\b(?:license|licence)\b.*\b(?:granted|checked[\s-]*out|succe\w*)\b|\bgot\s+(?:a\s+)?(?:license|licence)\b/i.test(text);
    const licenseFailure = !licenseSuccess && result.exitCode !== 0 && /\b(?:license|licence)\b/i.test(text);
    if (licenseFailure) { const ev = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId); return { ...base, status: "unsupported", unsupportedReason: "LICENSE_UNAVAILABLE", exitCode: result.exitCode, toolchain: { ...base.toolchain, licenseStatus: "unavailable" }, evidence: ev }; }
    if (/part.*(not found|does not exist|unknown)/i.test(text)) { const ev = request.operation === "implement" ? await failedImplementationEvidence(workspace, request.jobId) : await evidence(workspace, request.jobId); return { ...base, status: "unsupported", unsupportedReason: "PART_UNAVAILABLE", exitCode: result.exitCode, evidence: ev }; }
    const toolchain = { ...base.toolchain, licenseStatus: licenseSuccess ? "available" as const : base.toolchain.licenseStatus };
    if (request.operation === "simulate") {
      const sim = parseSimulatePhases(result.stdout);
      const verdict = judgeSimulation(sim.simulatorStdout, sim.phaseExitCode, result.exitCode);
      await writeExecutionEvidence(outputDir, request, result, verdict.status, {
        phase: sim.phase ?? null,
        phaseExitCode: sim.phaseExitCode ?? null,
        simulatorVerdict: verdict.errorCode ?? "passed",
      });
      // Re-emit the digest with the simulator stream included: TB assertions
      // are attributed to the simulator source and deduplicated against the
      // stdout simulator region.
      const digest = sim.simulatorStdout !== undefined
        ? buildLogDigest(request.operation, { stdout: result.stdout, stderr: result.stderr, simulator: sim.simulatorStdout })
        : baseDigest;
      await writeFile(join(outputDir, LOG_DIGEST_FILE_NAME), JSON.stringify(digest, null, 2), "utf8");
      const ev = await evidence(workspace, request.jobId);
      return { ...base, status: verdict.status, exitCode: result.exitCode, phase: sim.phase, phaseExitCode: sim.phaseExitCode, simulatorStdout: sim.simulatorStdout, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev, errorCode: verdict.errorCode, logDigest: digest };
    }
    if (request.operation === "implement") {
      const stopBeforeBitstream = request.stopBeforeBitstream === true;
      const verdict = await implementationVerdict(outputDir, result.exitCode, text, stopBeforeBitstream);
      let drcVerdict: ReportVerdict = "inconclusive";
      let timingVerdict: ReportVerdict = "inconclusive";
      try { drcVerdict = judgeDrcReport(await readFile(join(outputDir, "drc.rpt"), "utf8")); } catch {}
      try { timingVerdict = judgeStaReport(await readFile(join(outputDir, "sta.rpt"), "utf8")); } catch {}
      await writeExecutionEvidence(outputDir, request, result, verdict.status, {
        drcVerdict,
        timingVerdict,
        bitstreamGenerated: stopBeforeBitstream ? false : verdict.status === "succeeded",
        stopBeforeBitstream,
        errorCode: verdict.errorCode ?? null,
      });
      const ev = verdict.status === "succeeded" ? await evidence(workspace, request.jobId) : await failedImplementationEvidence(workspace, request.jobId);
      return { ...base, status: verdict.status, exitCode: result.exitCode, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev, errorCode: verdict.errorCode, logDigest: baseDigest };
    }
    const status = result.exitCode === 0 ? "succeeded" : "failed";
    await writeExecutionEvidence(outputDir, request, result, status);
    const ev = await evidence(workspace, request.jobId);
    return { ...base, status, exitCode: result.exitCode, toolchain, timeoutMs: effectiveTimeout, stdout: result.stdout, stderr: result.stderr, output: { stdout: result.stdout, stderr: result.stderr }, evidence: ev, logDigest: baseDigest };
  }
}
