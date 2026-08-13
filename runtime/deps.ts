/**
 * Synthia Runtime — shared dependency construction.
 *
 * Extracted from cli.ts so both the CLI and the HTTP server build their
 * model/connector/governance dependencies through the same factories.
 *
 * Exports:
 *  - CounterScriptedModel + artifact helpers (offline smoke)
 *  - buildRemoteConnector  (direct Cloudflare connector from worker config)
 *  - buildCoreApiConnector  (via-core job submission through Core)
 *  - buildCoreGovernanceClient (Core API artifact/gate governance)
 */

import { readFile } from "node:fs/promises";
import { createEnvironmentCloudflareRemoteConnector } from "../connector/http.ts";
import type { ConnectorEndpoint } from "../connector/remote.ts";
import { CoreApiConnector, resolveCoreApiConfig } from "./core-api-connector.ts";
import { CoreGovernanceClient } from "./governance-client.ts";
import { RemoteVivadoConnector } from "./remote-connector.ts";
import type { ArtifactFile, DocGeneration, LoopModel, RtlGeneration, TbGeneration, XdcGeneration, RepairGeneration } from "./types.ts";

// ---------------------------------------------------------------------------
// Offline scripted model (local smoke)
// ---------------------------------------------------------------------------

export class CounterScriptedModel implements LoopModel {
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

export function rtlCounter(): ArtifactFile {
  return {
    path: "counter.v",
    content: `module counter(\n  input wire clk,\n  input wire rst_n,\n  output reg [7:0] count\n);\n  always @(posedge clk) begin\n    if (!rst_n) count <= 8'd0;\n    else count <= count + 8'd1;\n  end\nendmodule\n`,
  };
}
export function tbCounter(): ArtifactFile {
  return {
    path: "tb_counter.v",
    content: `\`timescale 1ns/1ps\nmodule tb_counter;\n  reg clk = 0; reg rst_n = 0; wire [7:0] count;\n  counter dut(.clk(clk), .rst_n(rst_n), .count(count));\n  always #5 clk = ~clk;\n  integer i, errors = 0;\n  initial begin\n    rst_n = 0; #20; rst_n = 1;\n    for (i = 0; i < 4; i = i + 1) @(posedge clk);\n    if (count !== 8'd4) begin errors = errors + 1; $display("FAIL count=%0d", count); end\n    if (errors == 0) $display("PASS");\n    $finish;\n  end\nendmodule\n`,
  };
}
export function xdcSmoke(): ArtifactFile {
  return {
    path: "synthia.xdc",
    content: `# Smoke constraints — downgrade unconstrained-pin DRC so write_bitstream passes\nset_property SEVERITY {Warning} [get_drc_checks NSTD-1]\nset_property SEVERITY {Warning} [get_drc_checks UCIO-1]\ncreate_clock -period 10.0 [get_ports clk]\n`,
  };
}

// ---------------------------------------------------------------------------
// Connector construction
// ---------------------------------------------------------------------------

const CONNECTOR_HOST = "connect.wenzhuolin.xyz";

export async function buildRemoteConnector(projectId: string): Promise<RemoteVivadoConnector> {
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

export function buildCoreApiConnector(projectId: string): CoreApiConnector {
  // Throws if SYNTHIA_CORE_TOKEN is missing → main().catch exits 2 with fatal.
  const cfg = resolveCoreApiConfig(process.env);
  return new CoreApiConnector({
    baseUrl: cfg.baseUrl, token: cfg.token, projectId,
  });
}

export function buildCoreGovernanceClient(projectId: string, processInstanceId: string): CoreGovernanceClient {
  const cfg = resolveCoreApiConfig(process.env);
  return new CoreGovernanceClient({
    baseUrl: cfg.baseUrl, token: cfg.token, projectId, processInstanceId,
  });
}
