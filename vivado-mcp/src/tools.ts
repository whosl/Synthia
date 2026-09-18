import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { VivadoMcpAuthSession } from "./auth.ts";
import { VIVADO_MAX_TIMEOUT_MS } from "../../connector/vivado.ts";
import type { VivadoTclRunner } from "./runner.ts";

const PART_PATTERN_RE = /^[A-Za-z0-9*?_.-]{1,64}$/;

const RUN_TCL_DESCRIPTION = `Execute an arbitrary Vivado TCL script in a fresh \`vivado -mode batch\` process. This covers every Vivado TCL command (create_project, read_verilog, synth_design, place_design, route_design, report_*, write_bitstream, open_checkpoint, exec, ...).

Model:
- The script runs with cwd = the workspace root; \`input/\` and \`output/\` subdirectories exist. Relative paths in the script land in the workspace.
- State does NOT persist between calls (no shared Vivado process); pass the same \`workspace\` to chain runs through files, e.g. one call writes a checkpoint, the next opens it with \`open_checkpoint\`.
- Success requires exit code 0 AND the script completing to the end; a TCL error mid-script marks the run failed even if Vivado exits 0.
- Full untruncated stdout/stderr is always kept in the workspace under \`output/stdout.log\` and \`output/stderr.log\`; returned text is truncated to a size limit.
- Vivado runs can take many minutes; prefer chained short steps over one giant script, and set \`timeout_ms\` when needed.`;

export function registerTools(server: FastMCP<VivadoMcpAuthSession>, runner: VivadoTclRunner): void {
  server.addTool({
    name: "run_tcl",
    description: RUN_TCL_DESCRIPTION,
    parameters: z.object({
      script: z.string().min(1).describe("TCL script; multi-line scripts execute sequentially in one batch run"),
      workspace: z.string().optional().describe("Workspace id to create or reuse (omit for a fresh workspace; the result reports the id used)"),
      timeout_ms: z.number().int().positive().max(VIVADO_MAX_TIMEOUT_MS).optional().describe("Wall-clock timeout in milliseconds (default 30 min, max 2 h)"),
    }),
    execute: async (args) => JSON.stringify(await runner.run(args.script, { workspace: args.workspace, timeoutMs: args.timeout_ms }), null, 2),
  });

  server.addTool({
    name: "vivado_version",
    description: "Report the Vivado version of the configured toolchain (wraps `version -short`). Cheap connectivity probe.",
    parameters: z.object({}),
    execute: async () => JSON.stringify(await runner.run("puts [version -short]"), null, 2),
  });

  server.addTool({
    name: "list_parts",
    description: "List FPGA parts matching a glob pattern (wraps `get_parts`), one part per line in stdout.",
    parameters: z.object({
      pattern: z.string().regex(PART_PATTERN_RE).default("*").describe("Part glob, e.g. `xc7k*` or `*` (letters, digits, `*?_.-` only)"),
    }),
    execute: async (args) => {
      const pattern = args.pattern ?? "*";
      if (!PART_PATTERN_RE.test(pattern)) throw new Error("VIVADO_MCP_INVALID_PATTERN");
      return JSON.stringify(await runner.run(`puts [join [get_parts {${pattern}}] \\n]`), null, 2);
    },
  });

  server.addTool({
    name: "list_workspace_files",
    description: "List all files in a workspace (reports, checkpoints, logs, staged inputs) with sizes, as portable relative paths usable inside TCL scripts.",
    parameters: z.object({
      workspace: z.string().describe("Workspace id from a previous run_tcl result"),
    }),
    execute: async (args) => JSON.stringify(await runner.listWorkspaceFiles(args.workspace), null, 2),
  });

  server.addTool({
    name: "read_workspace_file",
    description: "Read a text file from a workspace (reports, logs, small artifacts). Intended for .rpt/.log/.txt/.tcl outputs; size-capped.",
    parameters: z.object({
      workspace: z.string().describe("Workspace id from a previous run_tcl result"),
      path: z.string().describe("Relative path inside the workspace, e.g. `output/utilization.rpt`"),
    }),
    execute: async (args) => JSON.stringify(await runner.readWorkspaceFile(args.workspace, args.path), null, 2),
  });
}
