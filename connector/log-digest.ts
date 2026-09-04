/**
 * Structured log digest for Vivado batch runs (synthia-log-digest.v1).
 *
 * The worker already scans simulator output for PASS/FAIL markers to judge a
 * run (judgeSimulation); this module formats the same scan into a bounded,
 * structured digest so downstream consumers (the Runtime agent loop) never
 * have to guess which part of a multi-thousand-char Vivado log matters.
 *
 * Design constraints:
 *  - Position windows (head or tail slices) are avoided on purpose: Vivado
 *    batch logs put project-generation noise up front and TB assertions at
 *    the end, but multi-scenario TBs interleave errors anywhere. Extraction
 *    is line-classification based, so errors are captured wherever they sit.
 *  - Every list carries a TOTAL count alongside the capped sample, plus a
 *    `truncated` flag, so the reader knows when it is seeing a subset.
 *  - Failure lines keep up to 2 preceding non-empty lines as context — that
 *    is what preserves the TB scenario banner ("INFO [B2B] begin") which
 *    attributes the error to a scenario.
 *  - When a dedicated simulator stream is provided, TB-style lines inside the
 *    stdout simulator region are attributed to the simulator source only
 *    (no double counting).
 */

export type LogDigestSource = "stdout" | "stderr" | "simulator";

export interface LogDigestLine {
  readonly source: LogDigestSource;
  /** 1-based line number within the source stream. */
  readonly index: number;
  /** Capped to LINE_CHAR_CAP characters. */
  readonly line: string;
  /** Up to CONTEXT_LINES preceding non-empty lines (failure lines only). */
  readonly contextBefore?: readonly string[];
}

export interface LogDigestCounts {
  readonly failure: number;
  readonly warning: number;
  readonly pass: number;
}

export interface LogDigest {
  readonly schema: "synthia-log-digest.v1";
  readonly operation: string;
  /** Total classified line counts before capping. */
  readonly counts: LogDigestCounts;
  readonly failureLines: readonly LogDigestLine[];
  readonly warningLines: readonly LogDigestLine[];
  readonly passLines: readonly LogDigestLine[];
  /** Controlled verdict/phase markers observed in stdout (PHASE=…, SIMULATION_OK, …). */
  readonly phaseMarkers: readonly string[];
  /** Character counts of the scanned streams, so consumers know coverage. */
  readonly scanned: { readonly stdout: number; readonly stderr: number; readonly simulator?: number };
  /** True when any list was capped. */
  readonly truncated: boolean;
}

export const LOG_DIGEST_FILE_NAME = "log-digest.json";
export const MAX_FAILURE_LINES = 20;
export const MAX_WARNING_LINES = 15;
export const MAX_PASS_LINES = 10;
export const LINE_CHAR_CAP = 400;
export const CONTEXT_LINE_CHAR_CAP = 200;
export const CONTEXT_LINES = 2;

/** Vivado batch ("ERROR: [Vivado 12-…] …"), TB ("ERROR [B2B] …"), xsim ("Fatal: …"). */
const FAILURE_LINE_RE = /^\s*(?:ERROR\b|Fatal:|\*\s*Error|FAIL\b)/;
/** Applied only inside the simulator region / dedicated simulator stream. */
const SIMULATOR_FAILURE_RE = /(?:\$fatal|\bFatal:)/;
const WARNING_LINE_RE = /^\s*(?:CRITICAL WARNING\b|WARNING\b|WARN\b)/;
/** Applied only to simulator output, matching judgeSimulation's PASS semantics
 *  ("PASS", "ALL TESTS PASSED", …). */
const PASS_LINE_RE = /\bPASS/;
const PHASE_MARKER_RE = /^(?:PHASE=\S+|PHASE_EXIT_CODE=\d+|SOURCE_VALIDATION_OK|SIMULATION_OK|SYNTHIA_DRC_FAILED|SYNTHIA_TIMING_FAILED|SYNTHIA_TIMING_UNCONSTRAINED)$/;

function capLine(line: string, cap: number): string {
  return line.length <= cap ? line : `${line.slice(0, cap)}…`;
}

function isFailureLine(line: string, source: LogDigestSource): boolean {
  if (FAILURE_LINE_RE.test(line)) return true;
  return source === "simulator" && SIMULATOR_FAILURE_RE.test(line);
}

function isPassLine(line: string, source: LogDigestSource): boolean {
  return source === "simulator" && PASS_LINE_RE.test(line) && !isFailureLine(line, source);
}

/** Line index range (inclusive, 0-based) of the stdout simulator region, if present. */
function stdoutSimulatorRegion(stdout: string): { start: number; end: number } | undefined {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex(line => line.includes("SIMULATOR_OUTPUT_BEGIN"));
  if (start === -1) return undefined;
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) {
    if (lines[i]!.includes("SIMULATOR_OUTPUT_END")) { end = i; break; }
  }
  return end > start ? { start, end } : undefined;
}

interface Classified {
  failure: LogDigestLine[];
  warning: LogDigestLine[];
  pass: LogDigestLine[];
  phaseMarkers: string[];
  counts: LogDigestCounts;
  truncated: boolean;
}

function scanStream(
  text: string,
  source: LogDigestSource,
  skipTbRegion: boolean,
  region: { start: number; end: number } | undefined,
): Classified {
  const lines = text.split(/\r?\n/);
  const failure: LogDigestLine[] = [];
  const warning: LogDigestLine[] = [];
  const pass: LogDigestLine[] = [];
  const phaseMarkers: string[] = [];
  let failureTotal = 0;
  let warningTotal = 0;
  let passTotal = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (source === "stdout" && PHASE_MARKER_RE.test(line)) {
      phaseMarkers.push(capLine(line, LINE_CHAR_CAP));
      continue;
    }
    // When a dedicated simulator stream exists, TB lines inside stdout's
    // simulator region belong to that stream — skip them here to avoid
    // counting the same assertion twice under two sources.
    const inSimulatorRegion = skipTbRegion && region !== undefined && i >= region.start && i <= region.end;
    if (inSimulatorRegion) continue;

    if (isFailureLine(line, source)) {
      failureTotal++;
      if (failure.length < MAX_FAILURE_LINES) {
        const contextBefore: string[] = [];
        for (let j = i - 1; j >= 0 && contextBefore.length < CONTEXT_LINES; j--) {
          const prev = lines[j]!;
          if (prev.trim().length > 0) contextBefore.unshift(capLine(prev, CONTEXT_LINE_CHAR_CAP));
        }
        failure.push({ source, index: i + 1, line: capLine(line, LINE_CHAR_CAP), ...(contextBefore.length > 0 ? { contextBefore } : {}) });
      } else {
        truncated = true;
      }
    } else if (WARNING_LINE_RE.test(line)) {
      warningTotal++;
      if (warning.length < MAX_WARNING_LINES) warning.push({ source, index: i + 1, line: capLine(line, LINE_CHAR_CAP) });
      else truncated = true;
    } else if (isPassLine(line, source)) {
      passTotal++;
      if (pass.length < MAX_PASS_LINES) pass.push({ source, index: i + 1, line: capLine(line, LINE_CHAR_CAP) });
      else truncated = true;
    }
  }
  return {
    failure, warning, pass, phaseMarkers, truncated,
    counts: { failure: failureTotal, warning: warningTotal, pass: passTotal },
  };
}

export function buildLogDigest(
  operation: string,
  streams: { stdout?: string; stderr?: string; simulator?: string },
): LogDigest {
  const stdout = streams.stdout ?? "";
  const stderr = streams.stderr ?? "";
  const simulator = streams.simulator;
  // Only exclude stdout's simulator region when the dedicated stream carries it.
  const region = simulator !== undefined ? stdoutSimulatorRegion(stdout) : undefined;

  const out = scanStream(stdout, "stdout", simulator !== undefined, region);
  const err = scanStream(stderr, "stderr", false, undefined);
  const sim = simulator !== undefined ? scanStream(simulator, "simulator", false, undefined) : undefined;

  return {
    schema: "synthia-log-digest.v1",
    operation,
    counts: {
      failure: out.counts.failure + err.counts.failure + (sim?.counts.failure ?? 0),
      warning: out.counts.warning + err.counts.warning + (sim?.counts.warning ?? 0),
      pass: out.counts.pass + err.counts.pass + (sim?.counts.pass ?? 0),
    },
    failureLines: [...sim?.failure ?? [], ...out.failure, ...err.failure],
    warningLines: [...out.warning, ...err.warning, ...sim?.warning ?? []],
    passLines: [...sim?.pass ?? [], ...out.pass, ...err.pass],
    phaseMarkers: out.phaseMarkers,
    scanned: {
      stdout: stdout.length,
      stderr: stderr.length,
      ...(simulator !== undefined ? { simulator: simulator.length } : {}),
    },
    truncated: out.truncated || err.truncated || (sim?.truncated ?? false),
  };
}
