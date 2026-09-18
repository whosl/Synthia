import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createVivadoProcessGuardian, VIVADO_DEFAULT_TIMEOUT_MS, VIVADO_MAX_TIMEOUT_MS, type CommandResult, type CommandRunner } from "../../connector/vivado.ts";
import { assertSafeRelativePath, assertWorkspaceId, truncateMiddle } from "./files.ts";

/** Printed as the last line of every staged script. Vivado batch can exit 0
 *  even when a sourced script raised a TCL error, so success is judged by
 *  exit code 0 AND this sentinel reaching stdout. */
export const VIVADO_MCP_DONE_SENTINEL = "__VIVADO_MCP_DONE__";

export type VivadoTclRunStatus = "succeeded" | "failed" | "timeout" | "error";

export interface VivadoTclRunOptions { readonly workspace?: string; readonly timeoutMs?: number }

export interface VivadoTclRunResult {
  readonly status: VivadoTclRunStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly workspace: string;
  readonly workspaceCreated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly stdoutTruncatedBytes: number;
  readonly stderrTruncatedBytes: number;
  readonly command: readonly string[];
  readonly errorCode?: string;
}

export interface WorkspaceFileEntry { readonly path: string; readonly sizeBytes: number }

export interface VivadoTclRunnerOptions {
  readonly workspaceRoot: string;
  readonly binary?: string;
  readonly maxConcurrency?: number;
  readonly scriptMaxBytes?: number;
  readonly outputMaxBytes?: number;
  /** Tests inject a fake here, mirroring VivadoBatchAdapter's commandRunner. */
  readonly commandRunner?: CommandRunner;
}

/** FIFO semaphore bounding concurrent Vivado batch processes. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit && this.waiters.length === 0) { this.active++; return; }
    await new Promise<void>(notify => this.waiters.push(notify));
    this.active++;
  }
  release(): void { this.active--; this.waiters.shift()?.(); }
}

async function existsDir(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** Walk a workspace collecting portable relative paths (`input/foo.v`). */
async function walk(dir: string, prefix: string, entries: WorkspaceFileEntry[], cap: number): Promise<void> {
  let names: string[];
  try { names = (await readdir(dir)).sort(); } catch { return; }
  for (const name of names) {
    if (entries.length >= cap) { entries.push({ path: "...", sizeBytes: -1 }); return; }
    const child = join(dir, name);
    let isDirectory = false;
    let sizeBytes = 0;
    try { const details = await stat(child); isDirectory = details.isDirectory(); sizeBytes = details.size; } catch { continue; }
    const path = prefix ? `${prefix}/${name}` : name;
    if (isDirectory) await walk(child, path, entries, cap);
    else entries.push({ path, sizeBytes });
  }
}

/**
 * Executes arbitrary TCL in `vivado -mode batch`, one fresh process per call,
 * mirroring the connector's workspace conventions: `<root>/<id>/{input,output}`,
 * staged `run.tcl`, untruncated `stdout.log`/`stderr.log`/`tool.log` evidence.
 * Cross-call state lives only in workspace files (open_checkpoint chains).
 */
export class VivadoTclRunner {
  private readonly root: string;
  private readonly binary: string;
  private readonly semaphore: Semaphore;
  private readonly scriptMaxBytes: number;
  private readonly outputMaxBytes: number;
  private readonly injected: CommandRunner | undefined;

  constructor(options: VivadoTclRunnerOptions) {
    this.root = resolve(options.workspaceRoot);
    this.binary = options.binary ?? "vivado";
    this.semaphore = new Semaphore(Math.max(1, options.maxConcurrency ?? 1));
    this.scriptMaxBytes = options.scriptMaxBytes ?? 1024 * 1024;
    this.outputMaxBytes = options.outputMaxBytes ?? 200 * 1024;
    this.injected = options.commandRunner;
  }

  async run(script: string, options: VivadoTclRunOptions = {}): Promise<VivadoTclRunResult> {
    if (typeof script !== "string" || script.trim() === "") throw new Error("VIVADO_MCP_SCRIPT_EMPTY");
    if (Buffer.byteLength(script, "utf8") > this.scriptMaxBytes) throw new Error("VIVADO_MCP_SCRIPT_TOO_LARGE");
    const timeoutMs = options.timeoutMs ?? VIVADO_DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > VIVADO_MAX_TIMEOUT_MS) throw new Error("VIVADO_MCP_INVALID_TIMEOUT");
    if (options.workspace !== undefined) assertWorkspaceId(options.workspace);
    const workspaceId = options.workspace ?? `ws-${randomBytes(8).toString("hex")}`;
    const workspace = resolve(this.root, workspaceId);
    if (workspace === this.root || !workspace.startsWith(`${this.root}${sep}`)) throw new Error("VIVADO_MCP_UNSAFE_WORKSPACE");
    const inputDir = join(workspace, "input");
    const outputDir = join(workspace, "output");
    const workspaceCreated = !(await existsDir(workspace));
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const runScript = `${script}\nputs ${VIVADO_MCP_DONE_SENTINEL}\n`;
    await writeFile(join(workspace, "run.tcl"), runScript, "utf8");
    const command = [this.binary, "-mode", "batch", "-nolog", "-nojournal", "-notrace", "-source", "run.tcl"];
    const startedAt = Date.now();

    await this.semaphore.acquire();
    let outcome: { result?: CommandResult; spawnError?: { code: string } };
    try {
      outcome = { result: await this.execute(command, workspace, timeoutMs) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      outcome = { spawnError: { code: typeof code === "string" && code ? code : (error instanceof Error ? error.message : "VIVADO_MCP_RUN_LOST") } };
    } finally {
      this.semaphore.release();
    }
    const durationMs = Date.now() - startedAt;

    const result = outcome.result;
    const stdout = result?.stdout ?? "";
    const stderr = result?.stderr ?? "";
    const exitCode = result?.exitCode ?? null;
    const timedOut = result?.timedOut === true;
    const out = truncateMiddle(stdout, this.outputMaxBytes);
    const err = truncateMiddle(stderr, this.outputMaxBytes);
    let status: VivadoTclRunStatus;
    let errorCode: string | undefined;
    if (outcome.spawnError) { status = "error"; errorCode = outcome.spawnError.code; }
    else if (timedOut) { status = "timeout"; errorCode = "VIVADO_MCP_TIMEOUT"; }
    else if (exitCode === 0 && stdout.includes(VIVADO_MCP_DONE_SENTINEL)) status = "succeeded";
    else { status = "failed"; errorCode = exitCode === 0 ? "VIVADO_MCP_SENTINEL_MISSING" : "VIVADO_MCP_TCL_FAILED"; }

    await Promise.all([
      writeFile(join(outputDir, "stdout.log"), stdout, "utf8"),
      writeFile(join(outputDir, "stderr.log"), stderr, "utf8"),
      writeFile(join(outputDir, "tool.log"), `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`, "utf8"),
      writeFile(join(outputDir, "run-meta.json"), JSON.stringify({ workspace: workspaceId, status, exitCode, timedOut, timeoutMs, durationMs, startedAt: new Date(startedAt).toISOString(), errorCode: errorCode ?? null }, null, 2), "utf8"),
    ]).catch(() => {});

    return {
      status,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      workspace: workspaceId,
      workspaceCreated,
      durationMs,
      timedOut,
      stdoutTruncatedBytes: out.truncatedBytes,
      stderrTruncatedBytes: err.truncatedBytes,
      command,
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }

  async listWorkspaceFiles(workspace: string, cap = 2000): Promise<WorkspaceFileEntry[]> {
    assertWorkspaceId(workspace);
    const dir = resolve(this.root, workspace);
    if (dir === this.root || !dir.startsWith(`${this.root}${sep}`)) throw new Error("VIVADO_MCP_UNSAFE_WORKSPACE");
    if (!(await existsDir(dir))) throw new Error("VIVADO_MCP_WORKSPACE_NOT_FOUND");
    const entries: WorkspaceFileEntry[] = [];
    await walk(dir, "", entries, cap);
    return entries;
  }

  async readWorkspaceFile(workspace: string, path: string): Promise<WorkspaceFileEntry & { readonly content: string }> {
    assertWorkspaceId(workspace);
    assertSafeRelativePath(path);
    const workspaceDir = resolve(this.root, workspace);
    if (workspaceDir === this.root || !workspaceDir.startsWith(`${this.root}${sep}`)) throw new Error("VIVADO_MCP_UNSAFE_WORKSPACE");
    const target = resolve(workspaceDir, path);
    const relativePath = relative(workspaceDir, target);
    if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes("..") || !target.startsWith(`${workspaceDir}${sep}`)) throw new Error("VIVADO_MCP_UNSAFE_WORKSPACE");
    let sizeBytes: number;
    try { sizeBytes = (await stat(target)).size; } catch { throw new Error("VIVADO_MCP_FILE_NOT_FOUND"); }
    if (sizeBytes > this.outputMaxBytes) throw new Error("VIVADO_MCP_FILE_TOO_LARGE");
    return { path, sizeBytes, content: await readFile(target, "utf8") };
  }

  private async execute(command: readonly string[], workspace: string, timeoutMs: number): Promise<CommandResult> {
    const args = command.slice(1);
    if (this.injected) return this.injected(command[0]!, args, workspace, timeoutMs);
    const guardian = await createVivadoProcessGuardian(workspace);
    try { return await guardian.run(command[0]!, args, workspace, timeoutMs); }
    finally { await guardian.close().catch(() => {}); }
  }
}
