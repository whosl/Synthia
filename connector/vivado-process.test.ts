import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PROCESS_OUTPUT_BYTES } from "./output-capture.ts";
import { VivadoBatchAdapter, type VivadoRequest } from "./vivado.ts";

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "synthia-runner-ablation-"));
  const binary = join(root, "fake-vivado.cjs");
  await writeFile(binary, `#!${process.execPath}\n${body}\n`);
  await chmod(binary, 0o700);
  return {
    root,
    adapter: new VivadoBatchAdapter({ workspaceRoot: root, binary }),
    request: { operation: "discover_toolchain", jobId: "job-process", projectId: "p-test", runClass: "exploratory" } as VivadoRequest,
    clean: () => rm(root, { recursive: true, force: true }),
  };
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("process condition did not settle");
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const state = await readFile(`/proc/${pid}/stat`, "utf8");
      return state.slice(state.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch { return false; }
}

// The executable fixture uses a Unix shebang. Windows keeps its original
// KILL_ON_JOB_CLOSE guardian and requires the Windows deployment gate.
describe.skipIf(process.platform === "win32")("Vivado real process runner after ablation", () => {
  test("captures both streams and preserves successful/failed process verdicts", async () => {
    for (const code of [0, 7]) {
      const f = await fixture(`process.stdout.write("Vivado v2025.1\\n"); process.stderr.write("diagnostic\\n"); process.exitCode = ${code};`);
      try {
        const result = await f.adapter.execute(f.request);
        expect(result.status).toBe(code === 0 ? "succeeded" : "failed");
        expect(result.exitCode).toBe(code);
        expect(result.stdout).toContain("Vivado v2025.1");
        expect(result.stderr).toContain("diagnostic");
      } finally { await f.clean(); }
    }
  });

  test("bounds UTF-8 output from a real subprocess at 5 MiB", async () => {
    const f = await fixture('process.stdout.write("波".repeat(2_000_000));');
    try {
      const result = await f.adapter.execute(f.request);
      expect(result.status).toBe("succeeded");
      expect(Buffer.byteLength(result.stdout!, "utf8")).toBeLessThanOrEqual(MAX_PROCESS_OUTPUT_BYTES);
      expect(result.stdout).toContain("[TRUNCATED:");
      expect(result.stdout).not.toContain("\ufffd");
    } finally { await f.clean(); }
  });

  test("an already-aborted request never starts the executable", async () => {
    const f = await fixture('require("node:fs").writeFileSync("started", "yes");');
    try {
      const controller = new AbortController();
      controller.abort();
      expect((await f.adapter.execute(f.request, controller.signal)).status).toBe("lost");
      await expect(readFile(join(f.root, "job-process", "started"))).rejects.toThrow();
    } finally { await f.clean(); }
  });

  for (const mode of ["timeout", "abort"] as const) {
    test(`${mode} terminates a descendant that ignores SIGTERM`, async () => {
      const f = await fixture(`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000);'], { stdio: "inherit" });
fs.writeFileSync("descendant.pid", String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
      let descendant: number | undefined;
      try {
        const controller = new AbortController();
        const pending = f.adapter.execute({ ...f.request, timeoutMs: mode === "timeout" ? 500 : 5_000 }, controller.signal);
        await eventually(async () => {
          try { descendant = Number(await readFile(join(f.root, "job-process", "ready"), "utf8")); return Number.isSafeInteger(descendant) && descendant! > 0; }
          catch { return false; }
        });
        expect(await isRunning(descendant!)).toBe(true);
        if (mode === "abort") controller.abort();
        const result = await pending;
        expect(result.status).toBe(mode === "timeout" ? "timeout" : "failed");
        expect(result.timedOut ?? false).toBe(mode === "timeout");
        await eventually(async () => !(await isRunning(descendant!)));
      } finally {
        if (descendant && await isRunning(descendant)) process.kill(descendant, "SIGKILL");
        await f.clean();
      }
    });
  }
});
