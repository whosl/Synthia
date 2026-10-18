import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerExecution, type WorkerConfig } from "./server.ts";
import type { JobRequest } from "./index.ts";

test("H34 canonical bundle matches source verdict and retains H33 compile-order discovery", async () => {
  const bundled = await import("./server.bundle.mjs");
  for (const factory of [createWorkerExecution, bundled.createWorkerExecution]) {
    const root = await mkdtemp(join(tmpdir(), "synthia-canonical-h34-"));
    try {
      let script = "";
      const execution = factory({ workspace_root: root, vivado_binary: "vivado", vivado_part: "any", toolchain_profile_hash: "b".repeat(64) } as WorkerConfig,
        { activeConfigSha256: "c".repeat(64), workerProcessInstanceId: "test" }, async (_binary: string, _args: readonly string[], cwd: string) => {
          script = await readFile(join(cwd, "run.tcl"), "utf8");
          return { exitCode: 0, stdout: "SIMULATOR_OUTPUT_BEGIN\nLINE_RATE_MBPS 11.95\nGOODPUT_MBPS 11.0\nDROPPED_PKTS 0\nPASS\n$finish called at time : 100 ns\nSIMULATOR_OUTPUT_END\nPHASE=simulate\nPHASE_EXIT_CODE=0\n", stderr: "" };
        });
      const result = await execution.execute({ jobId: "job-h34", projectId: "p-test", operation: "simulate", runClass: "exploratory", input: "a".repeat(64), idempotencyKey: "h34", correlationId: "h34",
        parameters: { jobId: "job-h34", projectId: "p-test", operation: "simulate", runClass: "exploratory", part: "xc7k70tfbv676-1", top: "dut", testbench: "tb", sources: [{ path: "rtl/dut.v", content: "module dut; endmodule" }, { path: "tb/tb.v", content: "module tb; endmodule" }] },
      } as JobRequest, root);
      expect(result.outcome).toBe("failure");
      expect(result.error_code).toBe("VIVADO_SIMULATION_FAILED");
      const metadata = JSON.parse(result.output!);
      expect(metadata.logDigest.performance.failed).toBe(true);
      expect(metadata.logDigest.counts.failure).toBe(1);
      const firstDiscovery = script.indexOf("update_compile_order -fileset sim_1");
      const pinTop = script.indexOf("set_property top {tb}");
      expect(firstDiscovery).toBeGreaterThan(0);
      expect(pinTop).toBeGreaterThan(firstDiscovery);
      expect(script.lastIndexOf("update_compile_order -fileset sim_1")).toBeGreaterThan(pinTop);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("H42/H43/H44 canonical bundle preserves VCD policy, judging lines and xvlog validation", async () => {
  const bundled = await import("./server.bundle.mjs");
  for (const factory of [createWorkerExecution, bundled.createWorkerExecution]) {
    const root = await mkdtemp(join(tmpdir(), "synthia-canonical-closeout-"));
    try {
      const scripts: string[] = [];
      let waveform = "";
      const execution = factory({ workspace_root: root, vivado_binary: "vivado", vivado_part: "any", vcd_limit_mb: 24, toolchain_profile_hash: "b".repeat(64) } as WorkerConfig,
        { activeConfigSha256: "c".repeat(64), workerProcessInstanceId: "test" }, async (_binary: string, _args: readonly string[], cwd: string) => {
          scripts.push(await readFile(join(cwd, "run.tcl"), "utf8"));
          if (scripts.length === 1) return { exitCode: 0, stdout: "SOURCE_VALIDATION_OK\nPHASE=compile\nPHASE_EXIT_CODE=0\n", stderr: "" };
          waveform = await readFile(join(cwd, "output", "waveform.tcl"), "utf8");
          return { exitCode: 0, stdout: `SIMULATOR_OUTPUT_BEGIN\n${"PASS\n".repeat(60)}SCENE 11 completed\nFRAME 2 done\nPIXEL 256 verified\nSPRITE0 hit\nDIGEST complete\nLINE_RATE_MBPS 12\nGOODPUT_MBPS 12\nDROPPED_PKTS 0\nTB PASS\n$finish called at time : 100 ns\nSIMULATOR_OUTPUT_END\nPHASE=simulate\nPHASE_EXIT_CODE=0\n`, stderr: "" };
        });
      for (const operation of ["validate_sources", "simulate"]) {
        const result = await execution.execute({ jobId: `job-${operation}`, projectId: "p-test", operation, runClass: "exploratory", input: "a".repeat(64), idempotencyKey: operation, correlationId: operation,
          parameters: { jobId: `job-${operation}`, projectId: "p-test", operation, runClass: "exploratory", part: "xc7k70tfbv676-1", top: "dut", testbench: "tb", sources: [{ path: "rtl/dut.v", content: "module dut; endmodule" }, { path: "tb/tb.v", content: "module tb; endmodule" }] },
        } as JobRequest, join(root, operation));
        expect({ outcome: result.outcome, error: result.error_code }).toEqual({ outcome: "success", error: undefined });
        if (operation === "simulate") {
          const judging = JSON.parse(result.output!).logDigest.judging;
          expect(judging.lines.map((line: { line: string }) => line.line)).toContain("SCENE 11 completed");
          expect(judging.lines.map((line: { line: string }) => line.line)).toContain("DROPPED_PKTS 0");
        }
      }
      expect(waveform).toContain("limit_vcd 25165824");
      expect(scripts[0]).toContain("xvlog");
      expect(scripts[0]).not.toContain("launch_simulation");
      expect(scripts[0]).not.toContain("xelab");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
