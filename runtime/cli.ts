/**
 * Synthia Runtime — CLI entry.
 *
 *   bun run runtime/cli.ts "<中文任务>" [--part <part>] [--project <id>]
 *        [--via-core] [--fake-connector] [--offline] [--no-governance]
 *        [--resume <runId>]
 *
 * Modes:
 *  - default         real model (SYNTHIA_MODEL_*) + real Cloudflare connector
 *  - --via-core      real model + CoreApiConnector (submits jobs through Core
 *                    API instead of hitting worker 66 directly); governance via
 *                    Core API (artifact registration + gate submissions).
 *  - --fake-connector real model + FakeVivadoConnector (no 66 traffic)
 *  - --offline        scripted model + FakeVivadoConnector (fully local smoke)
 *  - --no-governance  skip artifact registration and gate flow (dev/debug only;
 *                    audit records governance_skipped). Requires --offline or
 *                    --fake-connector.
 *  - --resume <runId> resume a paused run; polls the pending gate and continues
 *                    if approved, or reports still-waiting / fail-closed.
 *
 * Governance: when --via-core, artifact registration and gate submissions go
 * through the Core API using SYNTHIA_CORE_TOKEN. Without --via-core AND without
 * --no-governance, the CLI prints a message that Core is required for
 * governance and exits.
 *
 * Credentials load from .env (bun auto-loads) / process env. Proxy env vars
 * are cleared so the internal model endpoint and the public connector are
 * reached directly.
 *
 * --via-core env: SYNTHIA_CORE_URL (default http://127.0.0.1:8787) and
 * SYNTHIA_CORE_TOKEN (REQUIRED — Core service token with core:read/core:write).
 */

// Bun snapshots proxy env at startup; JS deletion is best-effort.
const _inheritedProxy = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]
  .some(k => process.env[k]);
if (_inheritedProxy) process.stderr.write(`[runtime] WARNING: proxy env detected. Bun may use it despite in-process clearing.\n[runtime] Launch with: env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY bun run runtime/cli.ts ...\n`);
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];

import { readFile } from "node:fs/promises";
import { createEnvironmentCloudflareRemoteConnector } from "../connector/http.ts";
import type { ConnectorEndpoint } from "../connector/remote.ts";
import { SkillLoader } from "./skill-loader.ts";
import { ModelClient, modelConfigFromEnv } from "./model-client.ts";
import { LoopExecutor, FakeVivadoConnector, successBehavior, VIVADO_CAPABILITY_VERSION } from "./loop.ts";
import { RemoteVivadoConnector } from "./remote-connector.ts";
import { CoreApiConnector, resolveCoreApiConfig } from "./core-api-connector.ts";
import { CoreGovernanceClient } from "./governance-client.ts";
import { newRunId, createRunState, loadRunState, saveRunState } from "./run-state.ts";
import type { ArtifactFile, DocGeneration, GovernanceClient, LoopModel, LoopResult, RtlGeneration, RunState, TbGeneration, XdcGeneration, RepairGeneration } from "./types.ts";
import { NoGovernanceClient as NoGovClient } from "./types.ts";

const DEFAULT_PART = "xc7k70tfbv676-1";
const DEFAULT_PROJECT = "p1";
const CONNECTOR_HOST = "connect.wenzhuolin.xyz";

interface CliArgs {
  task: string;
  part: string;
  project: string;
  viaCore: boolean;
  fakeConnector: boolean;
  offline: boolean;
  noGovernance: boolean;
  resumeRunId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    console.error('usage: bun run runtime/cli.ts "<task>" [--part <part>] [--project <id>] [--via-core] [--fake-connector] [--offline] [--no-governance] [--resume <runId>]');
    process.exit(rest.length === 0 ? 1 : 0);
  }
  // --resume can appear without a task argument.
  const resumeIdx = rest.indexOf("--resume");
  let resumeRunId: string | undefined;
  let taskArgs = rest;
  if (resumeIdx >= 0) {
    resumeRunId = rest[resumeIdx + 1];
    if (!resumeRunId) {
      console.error("--resume requires a runId argument");
      process.exit(1);
    }
    taskArgs = rest.filter((_, i) => i !== resumeIdx && i !== resumeIdx + 1);
  }
  // Task = first arg that isn't a flag; flags = everything else.
  // Supports: --resume <id> --via-core (no task text).
  const task = taskArgs.find(a => !a.startsWith("-")) ?? "";
  const flags = taskArgs.filter(a => a !== task);
  const val = (name: string): string | undefined => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  return {
    task,
    part: val("--part") ?? DEFAULT_PART,
    project: val("--project") ?? DEFAULT_PROJECT,
    viaCore: flags.includes("--via-core"),
    fakeConnector: flags.includes("--fake-connector"),
    offline: flags.includes("--offline"),
    noGovernance: flags.includes("--no-governance"),
    resumeRunId,
  };
}

// ----- offline scripted model (local smoke) -----

class CounterScriptedModel implements LoopModel {
  async generateIntake(task: string): Promise<DocGeneration> {
    return { phase: "generate_intake", reasoning: "intake", docPath: "doc/intake/summary.md", content: `# ${task} 需求梳理摘要\n## Task Summary\n${task}\n## Acceptance Criteria\n8-bit counter increments on clock.` };
  }
  async generateBehaviorWave(): Promise<DocGeneration> {
    return { phase: "generate_behavior_wave", reasoning: "behavior", docPath: "doc/spec/behavior_spec.md", content: "# Behavior Spec\n## Rules\nR1: counter increments on positive clock edge." };
  }
  async generateArchitecture(): Promise<DocGeneration> {
    return { phase: "generate_architecture", reasoning: "arch", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\ncounter: single-module top." };
  }
  async generateRegisterSpec(): Promise<DocGeneration> {
    return { phase: "generate_register_spec", reasoning: "reg", docPath: "doc/reg/register_map.md", content: "# Register Map\nNo registers for this design." };
  }
  async generateRtl(): Promise<RtlGeneration> {
    return {
      phase: "generate_rtl", reasoning: "8-bit counter with synchronous reset",
      topModule: "counter",
      sources: [rtlCounter()],
    };
  }
  async generateTestbench(): Promise<TbGeneration> {
    return {
      phase: "generate_testbench", reasoning: "self-checking TB counting a few cycles",
      testbenchModule: "tb_counter",
      testbench: tbCounter(),
    };
  }
  async generateXdc(_top: string, part: string, _sys: string, _allowPin: boolean): Promise<XdcGeneration> {
    return { phase: "generate_xdc", reasoning: `smoke constraints for ${part}`, constraints: [xdcSmoke()] };
  }
  async repair(): Promise<RepairGeneration> {
    return { phase: "repair", reasoning: "noop repair", sources: [rtlCounter()], testbench: tbCounter() };
  }
}

function rtlCounter(): ArtifactFile {
  return {
    path: "counter.v",
    content: `module counter(\n  input wire clk,\n  input wire rst_n,\n  output reg [7:0] count\n);\n  always @(posedge clk) begin\n    if (!rst_n) count <= 8'd0;\n    else count <= count + 8'd1;\n  end\nendmodule\n`,
  };
}
function tbCounter(): ArtifactFile {
  return {
    path: "tb_counter.v",
    content: `\`timescale 1ns/1ps\nmodule tb_counter;\n  reg clk = 0; reg rst_n = 0; wire [7:0] count;\n  counter dut(.clk(clk), .rst_n(rst_n), .count(count));\n  always #5 clk = ~clk;\n  integer i, errors = 0;\n  initial begin\n    rst_n = 0; #20; rst_n = 1;\n    for (i = 0; i < 4; i = i + 1) @(posedge clk);\n    if (count !== 8'd4) begin errors = errors + 1; $display("FAIL count=%0d", count); end\n    if (errors == 0) $display("PASS");\n    $finish;\n  end\nendmodule\n`,
  };
}
function xdcSmoke(): ArtifactFile {
  return {
    path: "synthia.xdc",
    content: `# Smoke constraints — downgrade unconstrained-pin DRC so write_bitstream passes\nset_property SEVERITY {Warning} [get_drc_checks NSTD-1]\nset_property SEVERITY {Warning} [get_drc_checks UCIO-1]\ncreate_clock -period 10.0 [get_ports clk]\n`,
  };
}

// ----- connector construction -----

async function buildRemoteConnector(projectId: string): Promise<RemoteVivadoConnector> {
  const cfg = JSON.parse(await readFile("connector/worker-66.config.json", "utf8")) as Record<string, unknown>;
  const str = (k: string): string => { const v = cfg[k]; if (typeof v !== "string") throw new Error(`worker config missing ${k}`); return v; };
  const num = (k: string): number => { const v = cfg[k]; if (typeof v !== "number") throw new Error(`worker config missing ${k}`); return v; };
  const arr = (k: string): string[] => { const v = cfg[k]; if (!Array.isArray(v)) throw new Error(`worker config missing ${k}`); return v as string[]; };
  const labels = cfg.worker_labels as Record<string, string>;
  const endpoint: ConnectorEndpoint = {
    connector_id: str("connector_id"),
    display_name: str("display_name"),
    endpoint_url: `https://${CONNECTOR_HOST}`,
    protocol_version: str("protocol_version"),
    transport_mode: "direct_https",
    auth_mode: "mtls",
    tls_trust_ref: "secret://trust/cloudflare-edge",
    tls_client_cert_ref: "secret://cert/cloudflare-origin",
    project_scope: arr("project_scope"),
    data_classification_scope: arr("data_classification_scope") as ConnectorEndpoint["data_classification_scope"],
    allowed_capability_ids: arr("allowed_capability_ids"),
    toolchain_profile_hash: str("toolchain_profile_hash"),
    worker_labels: labels,
    heartbeat_interval_seconds: num("heartbeat_interval_seconds"),
    lease_seconds: num("lease_seconds"),
    max_concurrency: num("max_concurrency"),
    registration_state: "registering",
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    audited_by: str("audited_by"),
    expected_capability_map_version: str("capability_map_version"),
    expected_part_catalog_hash: str("part_catalog_hash"),
    expected_sdk_worker_build_hash: str("sdk_worker_build_hash"),
  };
  const clientFactory = () => createEnvironmentCloudflareRemoteConnector({
    endpoint,
    actor: { actor_type: "service", actor_id: "synthia-runtime" },
    classification: "internal",
    projectId,
    allowlist: [CONNECTOR_HOST],
    env: process.env,
  });
  return new RemoteVivadoConnector({ clientFactory, connectorId: endpoint.connector_id, projectId, onLifecycle: (e) => process.stderr.write(`[runtime] lifecycle/${e.action} ${e.result} ${e.detail ?? ""}\n`) });
}

function buildCoreApiConnector(projectId: string): CoreApiConnector {
  // Throws if SYNTHIA_CORE_TOKEN is missing → main().catch exits 2 with fatal.
  const cfg = resolveCoreApiConfig(process.env);
  return new CoreApiConnector({
    baseUrl: cfg.baseUrl, token: cfg.token, projectId,
  });
}

// ----- report rendering (no secrets) -----

function renderReport(result: LoopResult): string {
  const lines: string[] = [];
  lines.push(`=== Synthia Runtime report ===`);
  lines.push(`status: ${result.status}`);
  lines.push(`part: ${result.part}`);
  if (result.runId) lines.push(`runId: ${result.runId}`);
  if (result.awaitingGate) lines.push(`awaitingGate: ${result.awaitingGate}`);
  if (result.endedReason) lines.push(`reason: ${result.endedReason}`);
  if (result.docs?.length) lines.push(`docs: ${result.docs.map(d => d.docPath).join(", ")}`);
  if (result.rtl) lines.push(`rtl: top=${result.rtl.topModule} files=${result.rtl.sources.map(s => s.path).join(",")}`);
  if (result.testbench) lines.push(`testbench: module=${result.testbench.testbenchModule} file=${result.testbench.testbench.path}`);
  if (result.xdc) lines.push(`xdc: ${result.xdc.constraints.map(c => c.path).join(",")}`);
  lines.push(`--- evidence manifest ---`);
  for (const ev of result.evidence) {
    lines.push(`  ${ev.operation} [${ev.status}] jobId=${ev.jobId} inputSha=${ev.inputSha256.slice(0, 12)}…`);
    for (const e of ev.entries) lines.push(`      - ${e.name} sha256=${e.sha256.slice(0, 12)}… ${e.sizeBytes}B ${e.mediaType}`);
  }
  lines.push(`--- audit (${result.audit.length} events) ---`);
  for (const a of result.audit) lines.push(`  [${a.seq}] ${a.category}/${a.phase} ${a.action} ${a.result ?? ""} ${a.errorCode ?? ""}`);
  return lines.join("\n");
}

// ----- main -----

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const skillLoader = new SkillLoader();
  const skillPrompts = await skillLoader.buildPrompts();

  const model: LoopModel = args.offline ? new CounterScriptedModel() : new ModelClient(modelConfigFromEnv());

  let connector;
  if (args.offline) {
    connector = new FakeVivadoConnector({ behavior: successBehavior() });
  } else if (args.viaCore) {
    connector = buildCoreApiConnector(args.project);
  } else if (args.fakeConnector) {
    connector = new FakeVivadoConnector({ behavior: successBehavior() });
  } else {
    connector = await buildRemoteConnector(args.project);
  }

  // Governance: --no-governance → NoGovernanceClient; --via-core → CoreGovernanceClient.
  // Neither flag + not offline → require Core for governance.
  let governance: GovernanceClient;
  if (args.noGovernance) {
    governance = new NoGovClient();
    process.stderr.write(`[runtime] governance=skipped (--no-governance; audit will record governance_skipped)\n`);
  } else if (args.viaCore) {
    const coreCfg = resolveCoreApiConfig(process.env);
    governance = new CoreGovernanceClient({
      baseUrl: coreCfg.baseUrl, token: coreCfg.token, projectId: args.project,
      processInstanceId: process.env.SYNTHIA_PROCESS_INSTANCE_ID ?? "pi-default",
    });
    process.stderr.write(`[runtime] governance=core-api (${coreCfg.baseUrl})\n`);
  } else {
    process.stderr.write(`[runtime] ERROR: Core is required for GJB gate governance. Use --via-core (with SYNTHIA_CORE_TOKEN) or --no-governance (dev/debug only).\n`);
    process.exit(1);
  }

  process.stderr.write(`[runtime] model=${args.offline ? "offline-scripted" : "openai-compatible"} connector=${connector.id} part=${args.part} cap=${VIVADO_CAPABILITY_VERSION}\n`);

  // Run-state persistence
  let runState: RunState | undefined;
  let runId: string;

  if (args.resumeRunId) {
    runState = await loadRunState(args.resumeRunId);
    runId = runState.runId;
    process.stderr.write(`[runtime] resuming run ${runId} (status=${runState.status}, stage=${runState.currentStage}${runState.awaitingGate ? `, gate=${runState.awaitingGate}` : ""})\n`);
  } else {
    runId = newRunId();
    runState = createRunState({ runId, task: args.task, part: args.part, projectId: args.project });
    process.stderr.write(`[runtime] starting new run ${runId}\n`);
  }

  const loop = new LoopExecutor({
    model, connector, governance, skillPrompts,
    part: args.part, projectId: args.project,
    processInstanceId: process.env.SYNTHIA_PROCESS_INSTANCE_ID ?? "pi-default",
    toolModelPolicyHash: process.env.SYNTHIA_TOOL_MODEL_POLICY_HASH ?? "synthia-policy-v1",
    actorId: "synthia-runtime",
    onEvent: (e) => process.stderr.write(`[runtime] ${e.category}/${e.phase} ${e.action} ${e.result ?? ""}\n`),
    onStateChange: async (state) => { await saveRunState(state); },
    onAwaitingApproval: (gate, submissionId, rid) => {
      process.stderr.write(`\n[runtime] ═══════════════════════════════════════════════════\n`);
      process.stderr.write(`[runtime]  等待 ${gate} 人工批准\n`);
      process.stderr.write(`[runtime]  submission: ${submissionId}\n`);
      process.stderr.write(`[runtime]  run: ${rid}\n`);
      process.stderr.write(`[runtime]  批准后执行: bun run runtime/cli.ts --resume ${rid}\n`);
      process.stderr.write(`[runtime] ═══════════════════════════════════════════════════\n\n`);
    },
  });

  const result = args.resumeRunId && runState
    ? await loop.resume(runState)
    : await loop.run(args.task, { runId, runState });

  process.stdout.write(renderReport(result) + "\n");
  // Exit codes: 0=succeeded, 1=failed, 3=fail_closed, 4=awaiting_approval
  const exitCode = result.awaitingGate ? 4 : result.status === "succeeded" ? 0 : result.status === "fail_closed" ? 3 : 1;
  process.exit(exitCode);
}

main().catch((e) => { process.stderr.write(`[runtime] fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
