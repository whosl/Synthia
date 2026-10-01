import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerExecution, type WorkerConfig } from "./server.ts";
import type { JobRequest } from "./index.ts";

describe("Worker per-job device execution", () => {
  test("any executes two devices without a global override and records the actual device", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthia-parts-"));
    const scripts: string[] = [];
    const config = { workspace_root: root, vivado_binary: "vivado", vivado_part: "any", toolchain_profile_hash: "b".repeat(64) } as WorkerConfig;
    const execution = createWorkerExecution(config, { activeConfigSha256: "c".repeat(64), workerProcessInstanceId: "test" }, async (_binary, _args, cwd) => {
      scripts.push(await readFile(join(cwd, "run.tcl"), "utf8"));
      await writeFile(join(cwd, "output", "synth.dcp"), "checkpoint");
      return { exitCode: 0, stdout: "License checkout succeeded", stderr: "" };
    });
    const request = (id: string, part?: string): JobRequest => ({
      jobId: id, projectId: "project", operation: "synthesize", runClass: "exploratory",
      input: "a".repeat(64), idempotencyKey: id, correlationId: id,
      parameters: { jobId: id, projectId: "project", operation: "synthesize", runClass: "exploratory", part,
        top: "top", sources: [{ path: "top.v", content: "module top; endmodule" }] },
    } as JobRequest);
    try {
      for (const [index, part] of ["xc7k70tfbv676-1", "xc7k160tffg676-2"].entries()) {
        const result = await execution.execute(request(`job-${index}`, part), root);
        expect(result.outcome).toBe("success");
        expect(JSON.parse(result.output).toolchain.part).toBe(part);
        expect(scripts[index]).toContain(part);
        expect(scripts[index]).not.toContain(index === 0 ? "xc7k160tffg676-2" : "xc7k70tfbv676-1");
      }
      const rejected = await execution.execute(request("job-missing"), root);
      expect(rejected.error_code).toBe("PART_REQUIRED");
      expect(scripts).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
