import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { CommandRunner } from "../../connector/vivado.ts";
import { VIVADO_MCP_DONE_SENTINEL, VivadoTclRunner } from "./runner.ts";

const SENTINEL_LINE = `puts ${VIVADO_MCP_DONE_SENTINEL}`;

function okRunner(stdout = `${VIVADO_MCP_DONE_SENTINEL}\nok`): CommandResult { return { exitCode: 0, stdout, stderr: "" }; }
type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; signal?: string | null };

async function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "vivado-mcp-")); }

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe("VivadoTclRunner.run", () => {
  test("stages run.tcl with the sentinel and runs vivado batch in the workspace", async () => {
    const root = await tempRoot();
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      binary: "/opt/vivado/bin/vivado",
      commandRunner: async (command, args, cwd) => {
        calls.push({ command, args: [...args], cwd });
        return okRunner();
      },
    });
    const result = await runner.run("puts hello");
    expect(result.status).toBe("succeeded");
    expect(result.workspaceCreated).toBe(true);
    expect(result.command).toEqual(["/opt/vivado/bin/vivado", "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", "run.tcl"]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.cwd).toBe(join(root, result.workspace));
    expect(calls[0]!.args).toEqual(["-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", "run.tcl"]);
    const staged = await readFile(join(root, result.workspace, "run.tcl"), "utf8");
    expect(staged).toBe(`puts hello\n${SENTINEL_LINE}\n`);
    for (const name of ["stdout.log", "stderr.log", "tool.log", "run-meta.json"]) {
      await expect(readFile(join(root, result.workspace, "output", name), "utf8")).resolves.toBeTypeOf("string");
    }
  });

  test("creates input/ and output/ with cwd at the workspace root", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({ workspaceRoot: root, commandRunner: async () => okRunner() });
    const result = await runner.run("puts hi");
    const names = (await readdir(join(root, result.workspace))).sort();
    expect(names).toEqual(["input", "output", "run.tcl"]);
  });

  test("reuses an existing workspace across runs", async () => {
    const root = await tempRoot();
    let invocationCount = 0;
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      commandRunner: async (_command, _args, cwd) => {
        if (invocationCount++ === 0) await writeFile(join(cwd, "input", "design.dcp"), "checkpoint", "utf8");
        return okRunner();
      },
    });
    const first = await runner.run("write_checkpoint design.dcp", { workspace: "chain-demo" });
    const second = await runner.run("open_checkpoint design.dcp", { workspace: "chain-demo" });
    expect(first.workspace).toBe("chain-demo");
    expect(first.workspaceCreated).toBe(true);
    expect(second.workspaceCreated).toBe(false);
    const files = await runner.listWorkspaceFiles("chain-demo");
    expect(files.map(entry => entry.path)).toContain("input/design.dcp");
    await expect(readFile(join(root, "chain-demo", "run.tcl"), "utf8")).resolves.toBe(`open_checkpoint design.dcp\n${SENTINEL_LINE}\n`);
  });

  test("fails when exit code is 0 but the sentinel never printed", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({ workspaceRoot: root, commandRunner: async () => ({ exitCode: 0, stdout: "ERROR: some TCL failure\n", stderr: "" }) });
    const result = await runner.run("this_command_does_not_exist");
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("VIVADO_MCP_SENTINEL_MISSING");
  });

  test("fails on a non-zero exit even with partial sentinel output", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      commandRunner: async () => ({ exitCode: 1, stdout: `${VIVADO_MCP_DONE_SENTINEL}\n`, stderr: "boom" }),
    });
    const result = await runner.run("exit 1");
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("VIVADO_MCP_TCL_FAILED");
  });

  test("reports a guardian-style timeout result", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      commandRunner: async () => ({ exitCode: 124, stdout: "running...", stderr: "", timedOut: true, signal: "SIGKILL" }),
    });
    const result = await runner.run("after 10000 { }", { timeoutMs: 50 });
    expect(result.status).toBe("timeout");
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("VIVADO_MCP_TIMEOUT");
  });

  test("maps a spawn failure to status error without crashing", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      commandRunner: async () => { const error = new Error("spawn failed") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; },
    });
    const result = await runner.run("puts hi");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("ENOENT");
    expect(result.exitCode).toBeNull();
  });

  test("rejects empty and oversized scripts and bad timeouts", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({ workspaceRoot: root, scriptMaxBytes: 64, commandRunner: async () => okRunner() });
    await expect(runner.run("   ")).rejects.toThrow("VIVADO_MCP_SCRIPT_EMPTY");
    await expect(runner.run("x".repeat(65))).rejects.toThrow("VIVADO_MCP_SCRIPT_TOO_LARGE");
    await expect(runner.run("puts hi", { timeoutMs: 0 })).rejects.toThrow("VIVADO_MCP_INVALID_TIMEOUT");
    await expect(runner.run("puts hi", { timeoutMs: 3 * 60 * 60 * 1000 })).rejects.toThrow("VIVADO_MCP_INVALID_TIMEOUT");
  });

  test("rejects unsafe workspace ids", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({ workspaceRoot: root, commandRunner: async () => okRunner() });
    await expect(runner.run("puts hi", { workspace: "../escape" })).rejects.toThrow("VIVADO_MCP_INVALID_WORKSPACE");
    await expect(runner.run("puts hi", { workspace: "CON" })).rejects.toThrow("VIVADO_MCP_INVALID_WORKSPACE");
  });

  test("truncates returned stdout but keeps full logs on disk", async () => {
    const root = await tempRoot();
    const big = `${"x".repeat(300 * 1024)}`;
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      outputMaxBytes: 8192,
      commandRunner: async () => ({ exitCode: 0, stdout: `${big}\n${VIVADO_MCP_DONE_SENTINEL}\n`, stderr: "" }),
    });
    const result = await runner.run("report_utilization");
    expect(result.status).toBe("succeeded");
    expect(result.stdoutTruncatedBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(8192);
    expect(result.stdout).toContain("truncated");
    const full = await readFile(join(root, result.workspace, "output", "stdout.log"), "utf8");
    expect(full.length).toBe(big.length + 1 + VIVADO_MCP_DONE_SENTINEL.length + 1);
  });

  test("serializes runs under maxConcurrency=1", async () => {
    const root = await tempRoot();
    let active = 0;
    let maxActive = 0;
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      commandRunner: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active--;
        return okRunner();
      },
    });
    const results = await Promise.all([runner.run("puts a"), runner.run("puts b"), runner.run("puts c")]);
    expect(maxActive).toBe(1);
    expect(results.every(result => result.status === "succeeded")).toBe(true);
    expect(new Set(results.map(result => result.workspace)).size).toBe(3);
  });
});

describe("VivadoTclRunner file helpers", () => {
  test("lists workspace files recursively and rejects unknown workspaces", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({
      workspaceRoot: root,
      commandRunner: async (_command, _args, cwd) => {
        await writeFile(join(cwd, "output", "resources.rpt"), "report", "utf8");
        return okRunner();
      },
    });
    const result = await runner.run("report_utilization", { workspace: "files-demo" });
    expect(result.workspace).toBe("files-demo");
    const files = await runner.listWorkspaceFiles("files-demo");
    const paths = files.map(entry => entry.path);
    expect(paths).toContain("run.tcl");
    expect(paths).toContain("output/resources.rpt");
    expect(paths).toContain("output/stdout.log");
    await expect(runner.listWorkspaceFiles("no-such-ws")).rejects.toThrow("VIVADO_MCP_WORKSPACE_NOT_FOUND");
  });

  test("reads small files and rejects traversal, missing, and oversized files", async () => {
    const root = await tempRoot();
    const runner = new VivadoTclRunner({ workspaceRoot: root, commandRunner: async () => okRunner() });
    await runner.run("puts hi", { workspace: "read-demo" });
    const read = await runner.readWorkspaceFile("read-demo", "run.tcl");
    expect(read.content).toContain("puts hi");
    expect(read.sizeBytes).toBeGreaterThan(0);
    await expect(runner.readWorkspaceFile("read-demo", "../../../etc/passwd")).rejects.toThrow();
    await expect(runner.readWorkspaceFile("read-demo", "output/missing.log")).rejects.toThrow("VIVADO_MCP_FILE_NOT_FOUND");
    const tinyRunner = new VivadoTclRunner({
      workspaceRoot: root,
      outputMaxBytes: 8,
      commandRunner: async () => okRunner(),
    });
    await tinyRunner.run("puts hi", { workspace: "read-demo" });
    await expect(tinyRunner.readWorkspaceFile("read-demo", "run.tcl")).rejects.toThrow("VIVADO_MCP_FILE_TOO_LARGE");
  });
});
