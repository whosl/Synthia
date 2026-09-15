/** Deterministic, fail-closed scanner for writable evolution-eval XDC overlays. */

import { scanTclSafetyRules } from "./learned-skill-scan.ts";

export interface EvolutionEvalXdcFinding {
  readonly code: string;
  readonly detail: string;
}

export interface EvolutionEvalXdcScanResult {
  readonly decision: "pass" | "reject";
  readonly findings: readonly EvolutionEvalXdcFinding[];
}

const TOP_LEVEL_COMMANDS = new Set([
  "create_clock",
  "create_generated_clock",
  "set_bus_skew",
  "set_case_analysis",
  "set_clock_groups",
  "set_clock_latency",
  "set_clock_transition",
  "set_clock_uncertainty",
  "set_data_check",
  "set_disable_timing",
  "set_false_path",
  "set_input_delay",
  "set_input_jitter",
  "set_max_capacitance",
  "set_max_delay",
  "set_max_fanout",
  "set_max_time_borrow",
  "set_max_transition",
  "set_min_delay",
  "set_multicycle_path",
  "set_operating_conditions",
  "set_output_delay",
  "set_property",
  "set_system_jitter",
  "set_units",
  "set_voltage",
]);

const QUERY_COMMANDS = new Set([
  "all_clocks",
  "all_inputs",
  "all_outputs",
  "all_registers",
  "current_design",
  "current_instance",
  "get_cells",
  "get_clocks",
  "get_nets",
  "get_pins",
  "get_ports",
  "get_property",
]);

const COMMAND_NAME = /^[A-Za-z_][A-Za-z0-9_:.-]*/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const NETWORK = /(?:https?|ftp|file):\/\/|\\\\[A-Za-z0-9_.-]+\\/i;
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s"'{(])(?:[A-Za-z]:[\\/])/m;
const POSIX_ABSOLUTE_PATH = /(?:^|[\s"'{(])\/(?![/*])/m;

interface TclContext {
  commandStart: boolean;
  braceDepth: number;
  quote: boolean;
}

function reject(code: string, detail: string): EvolutionEvalXdcFinding {
  return { code, detail };
}

/**
 * This is deliberately not a Tcl interpreter. It recognizes only literal,
 * declarative XDC commands and literal bracketed Vivado queries. Dynamic
 * command names, variables, script bodies and unknown commands fail closed.
 */
function scanLiteralCommands(content: string): EvolutionEvalXdcFinding[] {
  const findings: EvolutionEvalXdcFinding[] = [];
  const contexts: TclContext[] = [{ commandStart: true, braceDepth: 0, quote: false }];
  let index = 0;
  while (index < content.length) {
    const context = contexts[contexts.length - 1]!;
    const char = content[index]!;
    if (char === "\\") {
      findings.push(reject(
        content[index + 1] === "\n" || (content[index + 1] === "\r" && content[index + 2] === "\n")
          ? "XDC_LINE_CONTINUATION"
          : "XDC_ESCAPE_FORBIDDEN",
        "XDC backslash escaping and line continuation are forbidden",
      ));
      return findings;
    }
    if (context.braceDepth > 0) {
      if (char === "{") context.braceDepth += 1;
      else if (char === "}") context.braceDepth -= 1;
      index += 1;
      continue;
    }
    if (char === "\"") {
      context.quote = !context.quote;
      index += 1;
      continue;
    }
    if (!context.quote && char === "{") {
      context.braceDepth = 1;
      context.commandStart = false;
      index += 1;
      continue;
    }
    if (char === "[") {
      contexts.push({ commandStart: true, braceDepth: 0, quote: false });
      index += 1;
      continue;
    }
    if (char === "]") {
      if (contexts.length === 1 || context.quote) {
        findings.push(reject("XDC_SYNTAX_INVALID", "XDC contains an unmatched bracket"));
        return findings;
      }
      contexts.pop();
      contexts[contexts.length - 1]!.commandStart = false;
      index += 1;
      continue;
    }
    if (!context.quote && (char === ";" || char === "\n" || char === "\r")) {
      context.commandStart = true;
      index += 1;
      continue;
    }
    if (context.commandStart && /[ \t]/.test(char)) {
      index += 1;
      continue;
    }
    if (context.commandStart && char === "#") {
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }
    if (context.commandStart) {
      const match = COMMAND_NAME.exec(content.slice(index));
      if (!match) {
        findings.push(reject("XDC_DYNAMIC_COMMAND_FORBIDDEN", "XDC command names must be literal"));
        return findings;
      }
      const command = match[0]!;
      const allowed = contexts.length === 1 ? TOP_LEVEL_COMMANDS : QUERY_COMMANDS;
      if (!allowed.has(command)) {
        findings.push(reject("XDC_COMMAND_FORBIDDEN", `XDC command is not allowlisted: ${command}`));
      }
      context.commandStart = false;
      index += command.length;
      continue;
    }
    index += 1;
  }
  if (contexts.length !== 1 || contexts[0]!.braceDepth !== 0 || contexts[0]!.quote) {
    findings.push(reject("XDC_SYNTAX_INVALID", "XDC contains an unterminated quote, brace, or bracket"));
  }
  return findings;
}

export function scanEvolutionEvalXdc(content: string): EvolutionEvalXdcScanResult {
  const findings: EvolutionEvalXdcFinding[] = [];
  if (content.length === 0) findings.push(reject("XDC_EMPTY", "XDC content must not be empty"));
  if (CONTROL.test(content)) findings.push(reject("XDC_CONTROL_CHARACTER", "XDC contains a control character"));
  if (content.includes("$") || content.includes("`")) {
    findings.push(reject("XDC_DYNAMIC_SUBSTITUTION", "XDC variable and shell-style substitution are forbidden"));
  }
  if (NETWORK.test(content)) findings.push(reject("XDC_NETWORK_REFERENCE", "XDC network references are forbidden"));
  if (WINDOWS_ABSOLUTE_PATH.test(content) || POSIX_ABSOLUTE_PATH.test(content)) {
    findings.push(reject("XDC_HOST_PATH", "XDC host absolute paths are forbidden"));
  }
  for (const item of scanTclSafetyRules(content, "<evolution-eval-xdc>")) {
    findings.push(reject(item.code, item.detail));
  }
  findings.push(...scanLiteralCommands(content));
  const unique = [...new Map(findings.map((item) => [`${item.code}:${item.detail}`, item])).values()];
  return { decision: unique.length === 0 ? "pass" : "reject", findings: unique };
}
