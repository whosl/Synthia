import { createHash, randomBytes } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ConnectorCapability, EvidenceManifest } from "./index.ts";
import { buildLogDigest, LOG_DIGEST_FILE_NAME, type LogDigest } from "./log-digest.ts";

export const VIVADO_CAPABILITY_VERSION = "vivado-batch-1" as const;
export type VivadoOperation = "discover_toolchain" | "query_parts" | "validate_sources" | "simulate" | "synthesize" | "implement" | "report_drc" | "report_sta" | "report_resources";
export type VivadoRunClass = "exploratory" | "gate_check" | "formal" | "evolution_eval";
export type VivadoResultStatus = "succeeded" | "failed" | "unsupported" | "timeout" | "lost" | "unknown_effect";
export interface SourceInput { readonly path: string; readonly content: string | Uint8Array; readonly mediaType?: string; }
export interface VivadoRequestBase { readonly jobId: string; readonly runClass: VivadoRunClass; readonly projectId: string; readonly inputHash?: string; readonly toolchainHash?: string; readonly toolchain?: { readonly vivadoBinary?: string; readonly requiredLicense?: string; readonly part?: string; readonly profileHash?: string }; readonly timeoutMs?: number }
export interface DiscoverToolchainRequest extends VivadoRequestBase { readonly operation: "discover_toolchain" }
export interface QueryPartsRequest extends VivadoRequestBase { readonly operation: "query_parts"; readonly pattern?: string; readonly family?: string }
export interface ValidateSourcesRequest extends VivadoRequestBase { readonly operation: "validate_sources"; readonly sources: readonly SourceInput[]; readonly top?: string }
export interface SimulateRequest extends VivadoRequestBase { readonly operation: "simulate"; readonly sources: readonly SourceInput[]; readonly top: string; readonly testbench: string }
export interface SynthesizeRequest extends VivadoRequestBase { readonly operation: "synthesize"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export interface ConstraintInput { readonly path: string; readonly content: string | Uint8Array; readonly mediaType?: string }
export interface ImplementRequest extends VivadoRequestBase { readonly operation: "implement"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string; readonly constraints?: readonly ConstraintInput[]; readonly stopBeforeBitstream?: boolean; readonly generateTrialBitstream?: boolean }
export interface ReportRequest extends VivadoRequestBase { readonly operation: "report_drc" | "report_sta" | "report_resources"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string }
export type VivadoRequest = DiscoverToolchainRequest | QueryPartsRequest | ValidateSourcesRequest | SimulateRequest | SynthesizeRequest | ImplementRequest | ReportRequest;
interface EvolutionEvalVivadoBase {
  readonly schema: "evolution-eval-vivado-request.v1";
  readonly evalJobId: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly runClass: "evolution_eval";
  readonly dispatchRequestHash: string;
  readonly workspaceManifestHash: string;
  readonly sealedInputProjectionHash: string;
  readonly toolchainProfileHash: string;
  readonly deadlineAt: string;
  readonly timeoutMs: number;
}
export type EvolutionEvalVivadoRequest =
  | (EvolutionEvalVivadoBase & { readonly operation: "validate_sources"; readonly sources: readonly SourceInput[]; readonly top: string | null })
  | (EvolutionEvalVivadoBase & { readonly operation: "simulate"; readonly sources: readonly SourceInput[]; readonly top: string; readonly testbench: string })
  | (EvolutionEvalVivadoBase & { readonly operation: "synthesize"; readonly sources: readonly SourceInput[]; readonly top: string; readonly part: string })
  | (EvolutionEvalVivadoBase & { readonly operation: "implement"; readonly sources: readonly SourceInput[]; readonly constraints: readonly ConstraintInput[]; readonly top: string; readonly part: string; readonly generateTrialBitstream: boolean });
export interface CapabilityDefinition<I extends VivadoRequest = VivadoRequest> extends ConnectorCapability { readonly operation: I["operation"]; readonly inputKind: string; readonly outputKind: string; readonly execution: "vivado_batch" }
export const VIVADO_CAPABILITIES: readonly CapabilityDefinition[] = [
  ["discover_toolchain", "node", "toolchain_snapshot"], ["query_parts", "part_query", "part_list"], ["validate_sources", "source_manifest", "source_validation"], ["simulate", "simulation_request", "simulation_result"], ["synthesize", "synthesis_request", "synthesis_result"], ["implement", "implementation_request", "bitstream_artifact"], ["report_drc", "design_request", "drc_report"], ["report_sta", "design_request", "sta_report"], ["report_resources", "design_request", "resource_report"],
].map(([operation, inputKind, outputKind]) => ({
  operation,
  version: VIVADO_CAPABILITY_VERSION,
  runClasses: [
    "exploratory",
    "gate_check",
    "formal",
    ...(["validate_sources", "simulate", "synthesize", "implement"].includes(operation!) ? ["evolution_eval"] : []),
  ],
  inputKind,
  outputKind,
  execution: "vivado_batch",
})) as readonly CapabilityDefinition[];
export interface EvidenceReference { readonly name: string; readonly uri: string; readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string }
export interface ToolchainMetadata { readonly binary: string; readonly vivadoVersion?: string; readonly licenseStatus: "available" | "unavailable" | "unknown"; readonly part?: string; readonly profileHash?: string }
export interface VivadoExecutionResult { readonly status: VivadoResultStatus; readonly jobId: string; readonly operation: VivadoOperation; readonly command: readonly string[]; readonly inputSha256: string; readonly workspace: string; readonly toolchain: ToolchainMetadata; readonly exitCode?: number; readonly phase?: string; readonly phaseExitCode?: number; readonly simulatorStdout?: string; readonly stdout?: string; readonly stderr?: string; readonly output?: unknown; readonly errorCode?: string; readonly error?: Record<string, unknown>; readonly evidence: EvidenceManifest; readonly unsupportedReason?: "BINARY_UNAVAILABLE" | "LICENSE_UNAVAILABLE" | "PART_UNAVAILABLE"; readonly timeoutMs?: number; readonly timedOut?: boolean; readonly signal?: string | null; readonly logDigest?: LogDigest }
export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean; readonly signal?: string | null }
export interface VivadoProcessIdentity { readonly pid: number; readonly processGroupId: number; readonly startToken: string }
export type ProcessStartObserver = (identity: VivadoProcessIdentity) => boolean | void | Promise<boolean | void>;
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal, onProcessStarted?: ProcessStartObserver) => Promise<CommandResult>;
export interface VivadoProcessGuardian {
  readonly identity: VivadoProcessIdentity;
  readonly run: CommandRunner;
  close(): Promise<void>;
}
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
const VERILOG_MEDIA_TYPES: Record<string, true> = { "text/verilog": true, "text/x-verilog": true, "text/systemverilog": true, "text/x-systemverilog": true, "application/systemverilog": true };
function assertSourceLanguage(source: SourceInput): void {
  const lower = source.path.toLowerCase();
  const extOk = lower.endsWith(".v") || lower.endsWith(".vh") || lower.endsWith(".sv") || lower.endsWith(".svh");
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
  if (request.runClass !== "exploratory" && request.runClass !== "gate_check" && request.runClass !== "formal" && request.runClass !== "evolution_eval") reject("INVALID_RUN_CLASS");
  if (request.runClass === "evolution_eval" && !(["validate_sources", "simulate", "synthesize", "implement"] as readonly string[]).includes(request.operation)) reject("CAPABILITY_UNAVAILABLE");
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
  if (request.operation === "implement" && request.generateTrialBitstream !== undefined
    && typeof request.generateTrialBitstream !== "boolean") reject("INVALID_TRIAL_BITSTREAM_POLICY");
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

export function validateEvolutionEvalVivadoRequest(input: unknown): EvolutionEvalVivadoRequest {
  if (!isPlainObject(input)) reject("INVALID_REQUEST");
  const request = input as Record<string, unknown>;
  const operation = request.operation;
  if (!(operation === "validate_sources" || operation === "simulate" || operation === "synthesize" || operation === "implement")) reject("CAPABILITY_UNAVAILABLE");
  const keysByOperation: Readonly<Record<typeof operation & string, readonly string[]>> = {
    validate_sources: ["deadlineAt", "dispatchRequestHash", "evalJobId", "jobId", "operation", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
    simulate: ["deadlineAt", "dispatchRequestHash", "evalJobId", "jobId", "operation", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "testbench", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
    synthesize: ["deadlineAt", "dispatchRequestHash", "evalJobId", "jobId", "operation", "part", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
    implement: ["constraints", "deadlineAt", "dispatchRequestHash", "evalJobId", "generateTrialBitstream", "jobId", "operation", "part", "projectId", "runClass", "schema", "sealedInputProjectionHash", "sources", "timeoutMs", "toolchainProfileHash", "top", "workspaceManifestHash"],
  };
  const actual = Reflect.ownKeys(request);
  const expected = keysByOperation[operation];
  if (actual.some((key) => typeof key !== "string") || actual.length !== expected.length
    || [...actual as string[]].sort().some((key, index) => key !== [...expected].sort()[index])) reject("INVALID_REQUEST");
  if (request.schema !== "evolution-eval-vivado-request.v1" || request.runClass !== "evolution_eval") reject("INVALID_RUN_CLASS");
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 512) reject("INVALID_SOURCES");
  for (const source of request.sources) {
    if (!isPlainObject(source) || Reflect.ownKeys(source).length !== 3
      || !["content", "mediaType", "path"].every((key) => Object.prototype.hasOwnProperty.call(source, key))) reject("INVALID_SOURCE");
  }
  if (operation === "implement") {
    if (!Array.isArray(request.constraints) || request.constraints.length > 128) reject("INVALID_CONSTRAINTS");
    for (const constraint of request.constraints) {
      if (!isPlainObject(constraint) || Reflect.ownKeys(constraint).length !== 3
        || !["content", "mediaType", "path"].every((key) => Object.prototype.hasOwnProperty.call(constraint, key))) reject("INVALID_CONSTRAINT");
    }
  }
  for (const key of ["dispatchRequestHash", "workspaceManifestHash", "sealedInputProjectionHash", "toolchainProfileHash"] as const) {
    if (typeof request[key] !== "string" || !/^[0-9a-f]{64}$/.test(request[key])) reject("INVALID_INPUT_HASH");
  }
  if (typeof request.deadlineAt !== "string" || !request.deadlineAt.endsWith("Z") || !Number.isFinite(Date.parse(request.deadlineAt))) reject("INVALID_TIMEOUT");
  const generic = operation === "validate_sources"
    ? { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, ...(request.top === null ? {} : { top: request.top }), inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs }
    : operation === "simulate"
      ? { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, top: request.top, testbench: request.testbench, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs }
      : operation === "synthesize"
        ? { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, top: request.top, part: request.part, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs }
        : { operation, jobId: request.jobId, projectId: request.projectId, runClass: request.runClass, sources: request.sources, constraints: request.constraints, top: request.top, part: request.part, generateTrialBitstream: request.generateTrialBitstream, inputHash: request.workspaceManifestHash, toolchainHash: request.toolchainProfileHash, timeoutMs: request.timeoutMs };
  validateVivadoRequest(generic as VivadoRequest);
  if (typeof request.evalJobId !== "string" || !idRe.test(request.evalJobId)) reject("INVALID_ID");
  return structuredClone(input) as EvolutionEvalVivadoRequest;
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
    return `${sources}\ncreate_project synthia_batch ${project} -part ${projectPart} -force\nadd_files -fileset sources_1 ${designFiles}\nadd_files -fileset sim_1 ${simFiles}\nset_property top ${topQ} [get_filesets sources_1]\nset_property top ${tbQ} [get_filesets sim_1]\nset_property xsim.simulate.runtime {${XSIM_RUNTIME_CAP}} [get_filesets sim_1]\nupdate_compile_order -fileset sources_1\nupdate_compile_order -fileset sim_1\nlaunch_simulation -mode behavioral -scripts_only -absolute_path\nset simRoot [file normalize [file join ${project} "synthia_batch.sim" "sim_1" "behav" "xsim"]]\ncd $simRoot\nproc phaseExitCode {options} {\n  if {[dict exists $options -errorcode]} {\n    set ec [dict get $options -errorcode]\n    if {[llength $ec] >= 3 && [lindex $ec 0] eq "CHILDSTATUS"} { return [lindex $ec 2] }\n  }\n  return 1\n}\nproc catLog {p} { if {![catch {set f [open $p r]}]} { set d [read $f]; close $f; if {[string length $d] > 0} { puts $d } } }\nset phase compile\nif {[catch {exec cmd.exe /d /c [list call [file join $simRoot compile.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=compile"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; catch {catLog [file join $simRoot compile.log]}; return -options $sim_options $sim_output }
catch {catLog [file join $simRoot compile.log]}\nset phase elaborate\nif {[catch {exec cmd.exe /d /c [list call [file join $simRoot elaborate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=elaborate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts $sim_output; catch {catLog [file join $simRoot elaborate.log]}; catch {catLog [file join $simRoot compile.log]}; return -options $sim_options $sim_output }
catch {catLog [file join $simRoot elaborate.log]}\nset phase simulate\nif {[catch {exec cmd.exe /d /c [list call [file join $simRoot simulate.bat]] 2>@1} sim_output sim_options]} { puts "PHASE=simulate"; puts "PHASE_EXIT_CODE=[phaseExitCode $sim_options]"; puts "SIMULATOR_OUTPUT_BEGIN"; puts $sim_output; puts "SIMULATOR_OUTPUT_END"; return -options $sim_options $sim_output }\nputs "PHASE=simulate"\nputs "PHASE_EXIT_CODE=0"\nputs "SIMULATOR_OUTPUT_BEGIN"\nputs $sim_output\nputs "SIMULATOR_OUTPUT_END"\nputs SIMULATION_OK`;
  }
  if (request.operation === "synthesize") return `${sources}\nsynth_design ${part} ${top}\nreport_utilization -file ${tclQuote(join(outputDir, "resources.rpt"))}`;
  if (request.operation === "implement") {
    const constraints = (request.constraints ?? []).map(c => `read_xdc ${tclQuote(join(inputDir, c.path))}`).join("\n");
    const out = (name: string) => tclQuote(join(outputDir, name));
    // Single-session full flow: DCPs and the bitstream never leave the job workspace,
    // so every stage consumes state produced earlier in THIS run — no cross-job artifact transfer.
    return [sources, constraints, `synth_design ${part} ${top}`, `write_checkpoint -force ${out("synth.dcp")}`, "opt_design", "place_design", "route_design", `report_methodology -file ${out("methodology.rpt")}`, `report_cdc -details -file ${out("cdc.rpt")}`, `report_drc -file ${out("drc.rpt")}`, `report_timing_summary -file ${out("sta.rpt")}`, `report_utilization -file ${out("resources.rpt")}`, "set drcErrors [get_drc_violations -quiet -filter {SEVERITY == Error}]", "if {[llength $drcErrors] > 0} { error \"SYNTHIA_DRC_FAILED\" }", "set timingClocks [get_clocks -quiet]", "if {[llength $timingClocks] == 0} { error \"SYNTHIA_TIMING_UNCONSTRAINED\" }", "set failingPaths [get_timing_paths -quiet -max_paths 1 -slack_lesser_than 0]", "if {[llength $failingPaths] > 0} { error \"SYNTHIA_TIMING_FAILED\" }", `write_checkpoint -force ${out("routed.dcp")}`, request.stopBeforeBitstream ? "puts BITSTREAM_GENERATION_SKIPPED" : request.generateTrialBitstream === false ? "" : `write_bitstream -force ${out("synthia.bit")}`, "puts IMPLEMENT_OK"].filter(Boolean).join("\n");
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
  if (process.platform === "win32") {
    // `pid` is always the PowerShell Job guardian. Killing only that process
    // closes its KILL_ON_JOB_CLOSE handle and lets Windows terminate every Job
    // member atomically. `taskkill /T` performs a separate tree enumeration
    // and can block while the guardian itself waits for Job accounting.
    try { spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }, 1_000).unref();
}
const WINDOWS_PROCESS_IDENTITY_SOURCE = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$identityPid = [int]$env:SYNTHIA_PROCESS_IDENTITY_PID
$process = Get-Process -Id $identityPid
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$cimProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $identityPid)
if ($null -eq $cimProcess -or [string]::IsNullOrWhiteSpace([string]$cimProcess.CommandLine)) { exit 19 }
$facts = $operatingSystem.LastBootUpTime.ToUniversalTime().Ticks.ToString() + ':' +
  $process.StartTime.ToUniversalTime().Ticks.ToString() + ':' + [string]$cimProcess.CommandLine
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($facts))
[Console]::Out.Write('SYNTHIA_PROCESS_IDENTITY:' + $env:SYNTHIA_PROCESS_IDENTITY_NONCE + ':' + $encoded)
`;

export function readWindowsProcessIdentityFacts(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const nonce = randomBytes(16).toString("hex");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(WINDOWS_PROCESS_IDENTITY_SOURCE, "utf16le").toString("base64"),
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SYNTHIA_PROCESS_IDENTITY_PID: String(pid),
      SYNTHIA_PROCESS_IDENTITY_NONCE: nonce,
    },
  });
  if (result.error || result.status !== 0 || result.stderr.trim() !== "") return null;
  const prefix = `SYNTHIA_PROCESS_IDENTITY:${nonce}:`;
  if (!result.stdout.startsWith(prefix)) return null;
  const encoded = result.stdout.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return null;
  let facts: string;
  try { facts = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  return /^\d+:\d+:.+$/s.test(facts) ? facts : null;
}

async function processStartToken(pid: number): Promise<string> {
  let source = "";
  if (process.platform === "linux") {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!tail[19] || !bootId) throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
    source = `${bootId}:${pid}:${tail[19]}`;
  } else if (process.platform === "win32") {
    const facts = readWindowsProcessIdentityFacts(pid);
    if (!facts) throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
    source = `${pid}:${facts}`;
  } else {
    const bootResult = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    const factsResult = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const boot = bootResult.stdout.trim();
    const facts = factsResult.stdout.trim();
    if (bootResult.error || bootResult.status !== 0 || factsResult.error || factsResult.status !== 0 || !boot || !facts) {
      throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
    }
    source = `${boot}:${pid}:${facts}`;
  }
  if (!source.trim()) throw new Error("VIVADO_PROCESS_IDENTITY_UNAVAILABLE");
  return hash(source);
}
const PROCESS_GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (!input) process.exit(125);
  let request;
  try { request = JSON.parse(input); } catch { process.exit(125); }
  const lower = String(request.command).toLowerCase();
  const isBatch = process.platform === "win32" && (lower.endsWith(".bat") || lower.endsWith(".cmd"));
  const child = isBatch
    ? spawn("cmd.exe", ["/d", "/s", "/c", '"' + request.command + '"', ...request.args], { cwd: request.cwd, stdio: ["ignore", "inherit", "inherit"], windowsVerbatimArguments: true })
    : spawn(request.command, request.args, { cwd: request.cwd, stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", () => process.exit(126));
  child.once("exit", (code, signal) => process.exit(code == null ? (signal ? 128 : 1) : code));
});
process.stdin.resume();
`;
const WINDOWS_JOB_GUARDIAN_SOURCE = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SynthiaJobGuardian {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;
  const int JobObjectBasicAccountingInformation = 1;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(
    string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
    uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Win(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[]{' ', '\t', '"'}) < 0) return value;
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { b.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      b.Append('\\', slashes).Append(c); slashes = 0;
    }
    return b.Append('\\', slashes * 2).Append('"').ToString();
  }
  static string CommandLine(string application, string[] args) {
    var b = new StringBuilder(Quote(application)); foreach (var arg in args) b.Append(' ').Append(Quote(arg)); return b.ToString();
  }

  public static int Run(string application, string[] args, string cwd) {
    return RunTail(application, args, cwd, null);
  }

  public static int RunTail(string application, string[] args, string cwd, string rawTail) {
    IntPtr job = IntPtr.Zero, limits = IntPtr.Zero, list = IntPtr.Zero, jobValue = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      job = CreateJobObject(IntPtr.Zero, null); Win(job != IntPtr.Zero);
      var policy = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      policy.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int policySize = Marshal.SizeOf(policy); limits = Marshal.AllocHGlobal(policySize); Marshal.StructureToPtr(policy, limits, false);
      Win(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, (uint)policySize));

      IntPtr listSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
      list = Marshal.AllocHGlobal(listSize); Win(InitializeProcThreadAttributeList(list, 1, 0, ref listSize));
      jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
      Win(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

      var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(si); si.lpAttributeList = list;
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = GetStdHandle(-10); si.StartupInfo.hStdOutput = GetStdHandle(-11); si.StartupInfo.hStdError = GetStdHandle(-12);
      var line = new StringBuilder(CommandLine(application, args));
      if (rawTail != null) line.Append(' ').Append(rawTail);
      Win(CreateProcess(application, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi));
      if (ResumeThread(pi.hThread) == 0xFFFFFFFF) { TerminateProcess(pi.hProcess, 126); throw new Win32Exception(Marshal.GetLastWin32Error()); }
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; Win(GetExitCodeProcess(pi.hProcess, out code));
      int accountingSize = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      IntPtr accounting = Marshal.AllocHGlobal(accountingSize);
      try {
        while (true) {
          Win(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, accounting, (uint)accountingSize, IntPtr.Zero));
          var state = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(accounting, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
          if (state.ActiveProcesses == 0) break;
          Thread.Sleep(10);
        }
      } finally { Marshal.FreeHGlobal(accounting); }
      return unchecked((int)code);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (list != IntPtr.Zero) DeleteProcThreadAttributeList(list); if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue); if (limits != IntPtr.Zero) Marshal.FreeHGlobal(limits);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 125 }
$request = $raw | ConvertFrom-Json
$application = [string]$request.command
[string[]]$arguments = @($request.args | ForEach-Object { [string]$_ })
if ($application.ToLowerInvariant().EndsWith('.bat') -or $application.ToLowerInvariant().EndsWith('.cmd')) {
  # cmd /S strips exactly the outermost quotes of the /c payload, so the whole
  # hand-built command line is passed as a raw tail instead of a quoted argv
  # element (the CLR quoting escapes inner quotes in a way cmd cannot parse).
  $joined = '"' + $application + '" ' + (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"','""') + '"' } else { $_ } }) -join ' ')
  $application = [string]$request.command_interpreter
  $arguments = @('/d', '/s', '/c')
  exit [SynthiaJobGuardian]::RunTail($application, $arguments, [string]$request.cwd, ('"' + $joined + '"'))
}
exit [SynthiaJobGuardian]::Run($application, $arguments, [string]$request.cwd)
`;

function windowsSystemExecutable(name: "where.exe" | "cmd.exe"): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  const candidate = realpathSync(join(systemRoot, "System32", name));
  if (!statSync(candidate).isFile()) throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  return candidate;
}

function resolveWindowsExecutable(command: string): string {
  if (isAbsolute(command)) {
    const candidate = realpathSync(command);
    if (!statSync(candidate).isFile()) throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
    return candidate;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command)) throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  const where = windowsSystemExecutable("where.exe");
  const result = spawnSync(where, [command], {
    cwd: dirname(where),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stderr.trim() !== "") throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  const candidates = [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => realpathSync(line)).map((line) => line.toLowerCase()))];
  if (candidates.length !== 1) throw new Error("VIVADO_EXECUTABLE_AMBIGUOUS");
  const candidate = realpathSync(candidates[0]!);
  if (!statSync(candidate).isFile()) throw new Error("VIVADO_EXECUTABLE_UNAVAILABLE");
  return candidate;
}

function windowsGuardianRequest(command: string, args: readonly string[], cwd: string) {
  const resolvedCommand = resolveWindowsExecutable(command);
  return {
    command: resolvedCommand,
    args: [...args],
    cwd,
    command_interpreter: /\.(?:bat|cmd)$/i.test(resolvedCommand) ? windowsSystemExecutable("cmd.exe") : null,
  };
}

const defaultRunner: CommandRunner = (command, args, cwd, timeoutMs, signal, onProcessStarted) => {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const nonce = randomBytes(16).toString("hex");
  const windowsGuardian = `${WINDOWS_JOB_GUARDIAN_SOURCE}\n# ${nonce}`;
  const guardianCommand = process.platform === "win32" ? "powershell.exe" : process.execPath;
  const guardianArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsGuardian, "utf16le").toString("base64")]
    : ["-e", PROCESS_GUARDIAN_SOURCE, nonce];
  const child = spawn(guardianCommand, guardianArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "", timedOut = false;
  if (!child.pid) { reject(new Error("VIVADO_PROCESS_ID_UNAVAILABLE")); return promise; }
  const processStarted = processStartToken(child.pid).then(async (startToken) => {
    const identity = { pid: child.pid!, processGroupId: child.pid!, startToken };
    if (await onProcessStarted?.(identity) === false) throw new Error("VIVADO_PROCESS_IDENTITY_NOT_DURABLE");
    if (signal?.aborted) throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
    child.stdin.end(JSON.stringify(process.platform === "win32"
      ? windowsGuardianRequest(command, args, cwd)
      : { command, args: [...args], cwd }));
    return identity;
  }).catch((error) => {
    terminateProcessTree(child.pid!);
    throw error;
  });
  child.stdout.on("data", (d: Buffer) => stdout += d); child.stderr.on("data", (d: Buffer) => stderr += d);
  const timer = setTimeout(() => { timedOut = true; if (child.pid) terminateProcessTree(child.pid); }, timeoutMs);
  const abort = () => { if (child.pid) terminateProcessTree(child.pid); };
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  child.once("error", reject);
  child.once("close", (exitCode, closeSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); void processStarted.then(() => resolve({ exitCode: exitCode ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, signal: closeSignal }), reject); });
  return promise;
};

/**
 * Starts an inert, durably-owned process supervisor before any fallible eval
 * preparation. The command cannot execute until `run` is called, and closing
 * the supervisor kills its Unix process group or Windows kill-on-close Job.
 */
export async function createVivadoProcessGuardian(
  cwd: string,
  signal?: AbortSignal,
  onProcessStarted?: ProcessStartObserver,
  identityReader: (pid: number) => Promise<string> = processStartToken,
  beforeLaunch?: () => boolean | void | Promise<boolean | void>,
  terminateTree: (pid: number) => void = terminateProcessTree,
): Promise<VivadoProcessGuardian> {
  const nonce = randomBytes(16).toString("hex");
  const windowsGuardian = `${WINDOWS_JOB_GUARDIAN_SOURCE}\n# ${nonce}`;
  const guardianCommand = process.platform === "win32" ? "powershell.exe" : process.execPath;
  const guardianArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsGuardian, "utf16le").toString("base64")]
    : ["-e", PROCESS_GUARDIAN_SOURCE, nonce];
  const child = spawn(guardianCommand, guardianArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (!child.pid) throw new Error("VIVADO_PROCESS_ID_UNAVAILABLE");
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.on("data", (data: Buffer) => stdout += data);
  child.stderr.on("data", (data: Buffer) => stderr += data);
  child.once("error", (error) => { spawnError = error; });
  let exited = false;
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.once("close", (exitCode, closeSignal) => {
      exited = true;
      resolveClose({ exitCode, signal: closeSignal });
    });
  });
  const abort = () => { if (!exited) terminateTree(child.pid!); };
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  let identity: VivadoProcessIdentity;
  let permitted = false;
  try {
    identity = { pid: child.pid, processGroupId: child.pid, startToken: await identityReader(child.pid) };
    permitted = await onProcessStarted?.(identity) !== false;
  } catch (error) {
    if (!exited) terminateTree(child.pid);
    await closed;
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  if (!permitted || signal?.aborted) {
    if (!exited) terminateTree(child.pid);
    await closed;
    signal?.removeEventListener("abort", abort);
    throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
  }
  let launched = false;
  return {
    identity: identity!,
    run: async (command, args, runCwd, timeoutMs, runSignal) => {
      if (launched || runCwd !== cwd || !permitted || signal?.aborted || runSignal?.aborted) {
        throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
      }
      launched = true;
      const serializedRequest = JSON.stringify(process.platform === "win32"
        ? windowsGuardianRequest(command, args, runCwd)
        : { command, args: [...args], cwd: runCwd });
      let launchReady = false;
      try { launchReady = await beforeLaunch?.() !== false; }
      catch {
        if (!exited) terminateTree(child.pid!);
        await closed;
        throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
      }
      if (!launchReady || signal?.aborted || runSignal?.aborted) {
        if (!exited) terminateTree(child.pid!);
        await closed;
        throw new Error("VIVADO_PROCESS_LAUNCH_CANCELLED");
      }
      const runAbort = () => { if (!exited) terminateTree(child.pid!); };
      runSignal?.addEventListener("abort", runAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; if (!exited) terminateTree(child.pid!); }, timeoutMs);
      child.stdin.end(serializedRequest);
      const ended = await closed;
      clearTimeout(timer);
      runSignal?.removeEventListener("abort", runAbort);
      signal?.removeEventListener("abort", abort);
      if (spawnError) throw spawnError;
      return {
        exitCode: ended.exitCode ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        timedOut,
        signal: ended.signal,
      };
    },
    async close() {
      if (!exited) terminateTree(child.pid!);
      await closed;
      signal?.removeEventListener("abort", abort);
    },
  };
}
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
  async execute(request: VivadoRequest, signal?: AbortSignal): Promise<VivadoExecutionResult> {
    validateVivadoRequest(request);
    if (request.runClass === "evolution_eval") reject("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
    return this.executeRequest(request, signal);
  }
  async executeEvolutionEval(
    input: unknown,
    signal?: AbortSignal,
    onProcessStarted?: ProcessStartObserver,
    sealedWorkspace?: string,
    processRunner?: CommandRunner,
  ): Promise<VivadoExecutionResult> {
    const request = validateEvolutionEvalVivadoRequest(input);
    const common = {
      jobId: request.jobId,
      projectId: request.projectId,
      runClass: request.runClass,
      inputHash: request.workspaceManifestHash,
      toolchainHash: request.toolchainProfileHash,
      timeoutMs: request.timeoutMs,
    };
    const generic: VivadoRequest = request.operation === "validate_sources"
      ? { ...common, operation: request.operation, sources: request.sources, ...(request.top === null ? {} : { top: request.top }) }
      : request.operation === "simulate"
        ? { ...common, operation: request.operation, sources: request.sources, top: request.top, testbench: request.testbench }
        : request.operation === "synthesize"
          ? { ...common, operation: request.operation, sources: request.sources, top: request.top, part: request.part }
          : { ...common, operation: request.operation, sources: request.sources, constraints: request.constraints, top: request.top, part: request.part, generateTrialBitstream: request.generateTrialBitstream };
    return this.executeRequest(generic, signal, onProcessStarted, sealedWorkspace, processRunner);
  }
  private async executeRequest(
    request: VivadoRequest,
    signal?: AbortSignal,
    onProcessStarted?: ProcessStartObserver,
    sealedWorkspace?: string,
    processRunner?: CommandRunner,
  ): Promise<VivadoExecutionResult> {
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
    const workspace = sealedWorkspace === undefined ? join(this.root, request.jobId) : resolve(sealedWorkspace);
    if (sealedWorkspace !== undefined && request.runClass !== "evolution_eval") reject("SEALED_WORKSPACE_FORBIDDEN");
    if (sealedWorkspace !== undefined && workspace !== this.root && !workspace.startsWith(`${this.root}${sep}`)) reject("UNSAFE_WORKSPACE");
    const inputDir = join(workspace, "input"); const outputDir = join(workspace, "output"); await mkdir(inputDir, { recursive: true }); await mkdir(outputDir, { recursive: true });
    if (request.operation === "implement" && (request.stopBeforeBitstream === true || request.generateTrialBitstream === false)) {
      try { await unlink(join(outputDir, "synthia.bit")); } catch {}
    }
    const stageInput = async (item: SourceInput | ConstraintInput): Promise<void> => {
      safePath(item.path);
      const target = join(inputDir, item.path);
      if (sealedWorkspace === undefined) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, item.content);
      } else {
        let existing: Uint8Array;
        try { existing = await readFile(target); } catch { reject("SEALED_INPUT_MISSING"); }
        const expected = typeof item.content === "string" ? Buffer.from(item.content) : Buffer.from(item.content);
        if (!Buffer.from(existing).equals(expected)) reject("SEALED_INPUT_DRIFT");
      }
      if (request.runClass === "evolution_eval") await chmod(target, 0o400);
    };
    if ("sources" in request) for (const source of request.sources) await stageInput(source);
    if ("constraints" in request && request.constraints) for (const constraint of request.constraints) await stageInput(constraint);
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
      result = await (processRunner ?? this.run)(
        binary,
        command.slice(1),
        workspace,
        effectiveTimeout,
        signal,
        processRunner ? undefined : onProcessStarted,
      );
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
      const stopBeforeBitstream = request.stopBeforeBitstream === true || request.generateTrialBitstream === false;
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
