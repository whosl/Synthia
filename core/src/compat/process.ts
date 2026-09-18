import { spawn } from "node:child_process";

export interface CapturedProcess {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CaptureProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Spawn a command, fully capture stdout/stderr, and resolve with the exit
 * code. Cross-runtime replacement for the previous direct `Bun.spawn` call
 * (which also leaned on `Response.prototype.bytes()`, a Node-22 API).
 */
export function captureProcess(command: string, args: readonly string[], options: CaptureProcessOptions): Promise<CapturedProcess> {
  return new Promise<CapturedProcess>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: exitCode ?? -1 });
    });
  });
}
