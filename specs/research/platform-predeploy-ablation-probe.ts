import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Compare two checkouts using fake clients and a temporary workspace only.
// Usage: bun specs/research/platform-predeploy-ablation-probe.ts <baseline-dir> [output.json]
if (!process.argv[2]) throw new Error("Provide the baseline checkout directory");
const baseline = resolve(process.argv[2]);
const root = process.cwd();
const workspaceRoot = await mkdtemp(join(tmpdir(), "synthia-ablation-trace-"));
const traces: Record<string, unknown> = {};
try {
  for (const [version, repo] of [["baseline", baseline], ["candidate", root]] as const) {
    const { RemoteConnectorAdapter } = await import(resolve(repo, "core/src/api/connector-adapter.ts"));
    const coreCalls: unknown[] = [];
    let clients = 0, expired = false;
    const factory = (options: unknown) => {
      const id = ++clients;
      coreCalls.push(["factory", id, options]);
      return {
        state: "ready", hasCapabilityDrift: false,
        async register() { coreCalls.push([id, "register"]); return { registration_state: "registered" }; },
        async heartbeat() { coreCalls.push([id, "heartbeat"]); return { registration_state: "registered" }; },
        async discover() { coreCalls.push([id, "discover"]); return { capabilities: [{ operation: "simulate", version: "vivado-batch-1", runClasses: ["exploratory", "formal"] }], toolchain_profile_hash: "b".repeat(64) }; },
        async submit(request: { jobId: string }, approval?: unknown) {
          coreCalls.push([id, "submit", request, approval]);
          if (request.jobId === "lease-retry" && !expired) { expired = true; throw Object.assign(new Error("lease expired"), { code: "LEASE_EXPIRED", retryable: true }); }
          return { id: request.jobId, state: "queued" };
        },
        async status(jobId: string) { coreCalls.push([id, "status", jobId]); return { id: jobId, state: "succeeded", outputSha256: "e".repeat(64) }; },
        async evidence(jobId: string) { coreCalls.push([id, "evidence", jobId]); return { jobId, entries: [{ name: "waveform.vcd", sha256: "e".repeat(64), sizeBytes: 1234567, mediaType: "text/plain" }] }; },
        async fetchEvidenceContent(jobId: string, name: string, options: unknown) { coreCalls.push([id, "content", jobId, name, options]); return { content: "VCD", sha256: "e".repeat(64), sizeBytes: 1234567, truncated: true, mediaType: "text/plain" }; },
      };
    };
    const adapter = new RemoteConnectorAdapter(factory, { connector_id: "fake" }, ["fake.example"], {});
    const params = { projectId: "p-ablation", operation: "simulate", runClass: "exploratory", idempotencyKey: "key", correlationId: "corr", inputHash: "a".repeat(64), toolchainProfileHash: "b".repeat(64), actor: { actorType: "service", actorId: "test" }, parameters: { top: "dut", testbench: "tb", sources: [{ path: "dut.v", content: "module dut; endmodule" }], constraints: [] } };
    const coreResults: unknown[] = [];
    coreResults.push(await adapter.submitJob({ ...params, jobId: "plain" }));
    coreResults.push(await adapter.submitJob({ ...params, jobId: "lease-retry" }));
    coreResults.push(await adapter.submitJob({ ...params, jobId: "formal", runClass: "formal", approval: { baselineId: "baseline" } }));
    coreResults.push(await adapter.submitJob({ ...params, jobId: "discovery", operation: "discover_toolchain", parameters: { sources: [], constraints: [] } }));
    coreResults.push(await adapter.queryStatus("p-ablation", "plain"));
    coreResults.push(await adapter.fetchEvidence("p-ablation", "plain"));
    coreResults.push(await adapter.fetchEvidenceContent("p-ablation", "plain", "waveform.vcd", { range: { offset: 65536, limit: 65536 } }));
    const modelModule = await import(resolve(repo, existsSync(resolve(repo, "runtime/runtime-model.ts")) ? "runtime/runtime-model.ts" : "runtime/pi-responses-model.ts"));
    const runtime = [undefined, "chat", "chat_completions", "chat-completions", "messages", "anthropic", "anthropic-messages", "responses", "invalid"].map(mode => {
      try {
        const env = { SYNTHIA_MODEL_API: mode, SYNTHIA_MODEL_URL: "https://fake.invalid/v1", SYNTHIA_MODEL_KEY: "fake", SYNTHIA_MODEL_NAME: "fake" };
        return [mode, modelModule.modelApiModeFromEnv(env), modelModule.createRuntimeModelFromEnv(env).constructor.name];
      } catch (error) { return [mode, (error as Error).message]; }
    });
    const { VivadoBatchAdapter } = await import(resolve(repo, "connector/vivado.ts"));
    const workerCalls: unknown[] = [], workerResults: unknown[] = [];
    for (const [jobId, output, exitCode] of [
      ["pass", "GOODPUT_MBPS 11.6\nDROPPED_PKTS 0", 0],
      ["low-goodput", "GOODPUT_MBPS 11.0", 0],
      ["drops", "DROPPED_PKTS 1", 0],
      ["cpp", "CYCLES_PER_PIXEL 45", 0],
      ["fatal", "Fatal: assertion", 0],
      ["nonzero", "GOODPUT_MBPS 11.6", 1],
    ] as const) {
      const worker = new VivadoBatchAdapter({ workspaceRoot, binary: "fake-vivado", commandRunner: async (command: string, args: readonly string[], cwd: string, timeoutMs: number) => {
        workerCalls.push({ command, args, cwd, timeoutMs, script: await readFile(join(cwd, "run.tcl"), "utf8") });
        return { exitCode, stdout: `SIMULATOR_OUTPUT_BEGIN\n${output}\nPASS\n$finish called at time : 100 ns\nSIMULATOR_OUTPUT_END\nPHASE=simulate\nPHASE_EXIT_CODE=${exitCode}\n`, stderr: "" };
      } });
      const request = { jobId, projectId: "p-ablation", runClass: "exploratory", operation: "simulate", top: "dut", testbench: "tb", sources: [{ path: "rtl/dut.v", content: "module dut; endmodule" }, { path: "tb/tb.v", content: "module tb; endmodule" }] };
      workerResults.push(await worker.execute(request));
      for (const bad of [{ ...request, runClass: "evolution_eval" }, { ...request, top: "../escape" }]) {
        try { await worker.execute(bad); throw new Error("unsafe request accepted"); }
        catch (error) { workerResults.push((error as Error).message); }
      }
    }
    traces[version] = { core: { calls: coreCalls, results: coreResults }, runtime, worker: { calls: workerCalls, results: workerResults } };
    await rm(workspaceRoot, { recursive: true, force: true });
  }
} finally { await rm(workspaceRoot, { recursive: true, force: true }); }
const a = traces.baseline as Record<string, unknown>, b = traces.candidate as Record<string, unknown>;
const result: Record<string, unknown> = {};
for (const layer of ["core", "runtime", "worker"]) {
  if (!isDeepStrictEqual(a[layer], b[layer])) throw new Error(`${layer} behavioral trace changed`);
  result[layer] = { identical: true, sha256: createHash("sha256").update(JSON.stringify(a[layer])).digest("hex"), cases: layer === "core" ? 7 : layer === "runtime" ? 9 : 18 };
}
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
