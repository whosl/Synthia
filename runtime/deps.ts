/**
 * Synthia Runtime — shared dependency construction.
 *
 * Extracted from cli.ts so both the CLI and the HTTP server build their
 * model/connector/governance dependencies through the same factories.
 *
 * Exports:
 *  - CounterScriptedModel + artifact helpers (offline smoke)
 *  - buildCoreApiConnector  (via-core job submission through Core)
 *  - buildCoreGovernanceClient (Core API artifact/gate governance)
 */

import { readFile } from "node:fs/promises";
import {
  CoreApiConnector,
  resolveCoreApiConfig,
  resolveTaskRuntimeApiConfig,
} from "./core-api-connector.ts";
import { CoreGovernanceClient } from "./governance-client.ts";
import { RemoteVivadoConnector } from "./remote-connector.ts";
import {
  CoreTaskClientBase,
  CoreTaskWorkspaceClient,
  type TaskAuthorizationScope,
} from "./task-workspace-client.ts";
import { CoreTaskEvolutionClient } from "./evolution-client.ts";
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
    return { phase: "generate_architecture", reasoning: "arch", docPath: "doc/arch/module_partition.md", content: "# Architecture\n## Modules\ncounter: single-module top.\n## Ports\nclk, rst_n, count." };
  }
  async generateRegisterSpec(): Promise<DocGeneration> {
    return { phase: "generate_register_spec", reasoning: "reg", docPath: "doc/reg/register_map.md", content: "# Register Map\nNo registers for counter." };
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
    content: `# Candidate clock constraint only. Missing board I/O facts intentionally remain blocking.\ncreate_clock -period 10.0 [get_ports clk]\n`,
  };
}

// ---------------------------------------------------------------------------
// Connector construction
// ---------------------------------------------------------------------------

const CONNECTOR_HOST = "connect.wenzhuolin.xyz";

export interface CoreApiTaskJobBinding {
  readonly taskId: string;
  readonly workspaceId: string;
}

export function buildCoreApiConnector(
  projectId: string,
  taskBinding?: CoreApiTaskJobBinding,
  env: Record<string, string | undefined> = process.env,
): CoreApiConnector {
  const cfg = taskBinding === undefined
    ? resolveCoreApiConfig(env)
    : resolveTaskRuntimeApiConfig(env);
  return new CoreApiConnector({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    projectId,
    ...(taskBinding ?? {}),
  });
}

export function buildCoreGovernanceClient(
  projectId: string,
  processInstanceId: string,
  taskId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): CoreGovernanceClient {
  const cfg = resolveCoreApiConfig(env);
  return new CoreGovernanceClient({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    taskRuntimeToken: env.SYNTHIA_TASK_RUNTIME_TOKEN,
    taskId,
    projectId,
    processInstanceId,
  });
}

/** Build the event-only callback used by a Core-owned main task. */
export function buildCoreTaskClient(
  projectId: string,
  taskId: string,
  env: Record<string, string | undefined> = process.env,
): CoreTaskClientBase {
  const cfg = resolveTaskRuntimeApiConfig(env);
  return new CoreTaskClientBase({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    projectId,
    taskId,
  });
}

/** Build the task-bound Learned Skill client using the same singleton token. */
export function buildCoreTaskEvolutionClient(
  projectId: string,
  taskId: string,
  env: Record<string, string | undefined> = process.env,
): CoreTaskEvolutionClient {
  const cfg = resolveTaskRuntimeApiConfig(env);
  return new CoreTaskEvolutionClient({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    projectId,
    taskId,
  });
}

/** Build the narrow workspace capability used by a single Core-owned side task. */
export function buildCoreTaskWorkspaceClient(
  projectId: string,
  taskId: string,
  workspaceId: string,
  authorization: TaskAuthorizationScope,
  env: Record<string, string | undefined> = process.env,
): CoreTaskWorkspaceClient {
  const cfg = resolveTaskRuntimeApiConfig(env);
  return new CoreTaskWorkspaceClient({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    projectId,
    taskId,
    workspaceId,
    authorization,
  });
}
