/**
 * Synthia Runtime — CLI entry.
 *
 *   bun run runtime/cli.ts "<中文任务>" [--part <part>] [--project <id>]
 *        [--fake-connector] [--offline]
 *
 * Modes:
 *  - default         real model (SYNTHIA_MODEL_*) + real Cloudflare connector
 *  - --fake-connector real model + FakeVivadoConnector (no 66 traffic)
 *  - --offline        scripted model + FakeVivadoConnector (fully local smoke)
 *
 * Credentials load from .env (bun auto-loads) / process env. The bearer key and
 * CF service token are read from env only and never printed. Proxy env vars are
 * cleared so the internal model endpoint and the public connector are reached
 * directly (the dev-box proxy 127.0.0.1:65533 is dead).
 */

// Bun snapshots proxy env at startup; JS deletion is best-effort. Warn if a
// proxy was inherited so the operator clears it at the process level.
const _inheritedProxy = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]
  .some(k => process.env[k]);
if (_inheritedProxy) process.stderr.write(`[runtime] WARNING: proxy env detected. Bun may use it despite in-process clearing.\n[runtime] Launch with: env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY bun run runtime/cli.ts ...\n`);
// Clear dead proxy so fetch reaches the model + connector directly (best-effort).
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];

import { readFile } from "node:fs/promises";
import { createEnvironmentCloudflareRemoteConnector } from "../connector/http.ts";
import type { ConnectorEndpoint } from "../connector/remote.ts";
import { SkillLoader } from "./skill-loader.ts";
import { ModelClient, modelConfigFromEnv } from "./model-client.ts";
import { LoopExecutor, FakeVivadoConnector, successBehavior, VIVADO_CAPABILITY_VERSION } from "./loop.ts";
import { RemoteVivadoConnector } from "./remote-connector.ts";
import type { ArtifactFile, LoopModel, LoopResult, RtlGeneration, TbGeneration, XdcGeneration, RepairGeneration } from "./types.ts";

const DEFAULT_PART = "xc7k70tfbv676-1";
const DEFAULT_PROJECT = "p1";
const CONNECTOR_HOST = "connect.wenzhuolin.xyz";

interface CliArgs {
  task: string;
  part: string;
  project: string;
  fakeConnector: boolean;
  offline: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    console.error('usage: bun run runtime/cli.ts "<task>" [--part <part>] [--project <id>] [--fake-connector] [--offline]');
    process.exit(rest.length === 0 ? 1 : 0);
  }
  const task = rest[0]!;
  const flags = rest.slice(1);
  const val = (name: string): string | undefined => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  return {
    task,
    part: val("--part") ?? DEFAULT_PART,
    project: val("--project") ?? DEFAULT_PROJECT,
    fakeConnector: flags.includes("--fake-connector"),
    offline: flags.includes("--offline"),
  };
}

// ----- offline scripted model (local smoke) -----

class CounterScriptedModel implements LoopModel {
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
  async generateXdc(_top: string, part: string): Promise<XdcGeneration> {
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

// ----- report rendering (no secrets) -----

function renderReport(result: LoopResult): string {
  const lines: string[] = [];
  lines.push(`=== Synthia Runtime report ===`);
  lines.push(`status: ${result.status}`);
  lines.push(`part: ${result.part}`);
  if (result.endedReason) lines.push(`reason: ${result.endedReason}`);
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
  if (args.offline || args.fakeConnector) {
    connector = new FakeVivadoConnector({ behavior: successBehavior() });
  } else {
    connector = await buildRemoteConnector(args.project);
  }

  process.stderr.write(`[runtime] model=${args.offline ? "offline-scripted" : "openai-compatible"} connector=${connector.id} part=${args.part} cap=${VIVADO_CAPABILITY_VERSION}\n`);

  const loop = new LoopExecutor({
    model, connector, skillPrompts,
    part: args.part, projectId: args.project, actorId: "synthia-runtime",
    onEvent: (e) => process.stderr.write(`[runtime] ${e.category}/${e.phase} ${e.action} ${e.result ?? ""}\n`),
  });

  const result = await loop.run(args.task);
  process.stdout.write(renderReport(result) + "\n");
  process.exit(result.status === "succeeded" ? 0 : result.status === "fail_closed" ? 3 : 1);
}

main().catch((e) => { process.stderr.write(`[runtime] fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
