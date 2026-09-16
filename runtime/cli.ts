/**
 * Synthia Runtime — CLI entry.
 *
 *   bun run runtime/cli.ts "<中文任务>" [--part <part>] [--project <id>]
 *        [--via-core] [--fake-connector] [--offline] [--no-governance]
 *        [--resume <agentId>] [--acceptance-tb <path> --acceptance-module <module>]
 *
 * Modes:
 *  - default         real model (SYNTHIA_MODEL_*) — requires --via-core (direct transport removed)
 *  - --via-core      real model + CoreApiConnector (submits jobs through Core
 *                    API instead of hitting worker 66 directly); governance via
 *                    Core API (artifact registration + gate submissions).
 *  - --fake-connector real model + FakeVivadoConnector (no 66 traffic)
 *  - --offline        scripted model + FakeVivadoConnector (fully local smoke)
 *  - --no-governance  skip artifact registration and gate flow (dev/debug only;
 *                    audit records governance_skipped). Requires --offline or
 *                    --fake-connector.
 *  - --resume <agentId> resume a paused agent; polls the pending gate and continues
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
 * SYNTHIA_CORE_TOKEN (REQUIRED — ordinary Core service token with read/write;
 * it must not carry core:task-runtime).
 */

function clearInheritedProxyEnvironment(): void {
  // Bun snapshots proxy env at startup; JS deletion is best-effort.
  const inherited = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]
    .some((key) => process.env[key]);
  if (inherited) process.stderr.write(`[runtime] WARNING: proxy env detected. Bun may use it despite in-process clearing.\n[runtime] Launch with: env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY bun run runtime/cli.ts ...\n`);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[key];
}

import { SkillLoader } from "./skill-loader.ts";
import { createRuntimeModelFromEnv } from "./pi-responses-model.ts";
import { LoopExecutor, FakeVivadoConnector, successBehavior, VIVADO_CAPABILITY_VERSION } from "./loop.ts";
import { resolveCoreApiConfig } from "./core-api-connector.ts";
import { CoreGovernanceClient } from "./governance-client.ts";
import { newAgentId, createAgentState, loadAgentState, saveAgentState } from "./agent-state.ts";
import type { GovernanceClient, LoopModel, LoopResult, AgentState } from "./types.ts";
import { NoGovernanceClient as NoGovClient } from "./types.ts";
import { CounterScriptedModel, buildCoreApiConnector } from "./deps.ts";

const DEFAULT_PART = "xc7k70tfbv676-1";
const DEFAULT_PROJECT = "p1";

interface CliArgs {
  task: string;
  part?: string;
  project?: string;
  viaCore: boolean;
  fakeConnector: boolean;
  offline: boolean;
  noGovernance: boolean;
  resumeAgentId?: string;
  acceptanceTbPath?: string;
  acceptanceModule?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const rest = argv.slice(2);
  const usage = 'usage: bun run runtime/cli.ts "<task>" [--part <part>] [--project <id>] [--via-core] [--fake-connector] [--offline] [--no-governance] [--resume <agentId>] [--acceptance-tb <path> --acceptance-module <module>]';
  if (rest.length === 0) throw new Error(usage);
  if (rest[0] === "--help" || rest[0] === "-h") {
    console.error(usage);
    process.exit(0);
  }
  let task = "";
  let part: string | undefined;
  let project: string | undefined;
  let resumeAgentId: string | undefined;
  let acceptanceTbPath: string | undefined;
  let acceptanceModule: string | undefined;
  let viaCore = false;
  let fakeConnector = false;
  let offline = false;
  let noGovernance = false;
  const valueAfter = (index: number, flag: string): string => {
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value\n${usage}`);
    return value;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    switch (arg) {
      case "--part": part = valueAfter(i, arg); i++; break;
      case "--project": project = valueAfter(i, arg); i++; break;
      case "--resume": resumeAgentId = valueAfter(i, arg); i++; break;
      case "--acceptance-tb": acceptanceTbPath = valueAfter(i, arg); i++; break;
      case "--acceptance-module": acceptanceModule = valueAfter(i, arg); i++; break;
      case "--via-core": viaCore = true; break;
      case "--fake-connector": fakeConnector = true; break;
      case "--offline": offline = true; break;
      case "--no-governance": noGovernance = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${usage}`);
        if (task) throw new Error(`multiple task arguments are not supported\n${usage}`);
        task = arg;
    }
  }
  if (!task && !resumeAgentId) throw new Error(usage);
  if ((acceptanceTbPath === undefined) !== (acceptanceModule === undefined)) {
    throw new Error(`--acceptance-tb and --acceptance-module must be supplied together\n${usage}`);
  }
  if (resumeAgentId && acceptanceTbPath) {
    throw new Error(`external acceptance testbench is immutable across --resume; use the persisted acceptance testbench\n${usage}`);
  }
  return {
    task,
    part,
    project,
    viaCore,
    fakeConnector,
    offline,
    noGovernance,
    resumeAgentId,
    acceptanceTbPath,
    acceptanceModule,
  };
}


// ----- report rendering (no secrets) -----

function renderReport(result: LoopResult): string {
  const lines: string[] = [];
  lines.push(`=== Synthia Runtime report ===`);
  lines.push(`status: ${result.status}`);
  lines.push(`part: ${result.part}`);
  if (result.agentId) lines.push(`agentId: ${result.agentId}`);
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
  clearInheritedProxyEnvironment();
  const args = parseArgs(process.argv);
  let agentState: AgentState | undefined;
  if (args.resumeAgentId) {
    agentState = await loadAgentState(args.resumeAgentId);
    if (args.part && args.part !== agentState.part) throw new Error(`--part ${args.part} does not match persisted agent part ${agentState.part}`);
    if (args.project && args.project !== agentState.projectId) throw new Error(`--project ${args.project} does not match persisted agent project ${agentState.projectId}`);
  }
  const part = agentState?.part ?? args.part ?? DEFAULT_PART;
  const project = agentState?.projectId ?? args.project ?? DEFAULT_PROJECT;
  let acceptanceTestbench = agentState?.acceptanceTestbench;
  if (args.acceptanceTbPath && args.acceptanceModule) {
    const file = Bun.file(args.acceptanceTbPath);
    if (!(await file.exists())) throw new Error(`acceptance testbench not found: ${args.acceptanceTbPath}`);
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(args.acceptanceModule)) throw new Error("--acceptance-module must be a Verilog identifier");
    if (!/\.(?:v|sv)$/i.test(args.acceptanceTbPath)) throw new Error("--acceptance-tb must be a .v or .sv file");
    acceptanceTestbench = {
      phase: "generate_testbench",
      reasoning: "evaluator-owned immutable acceptance testbench",
      testbenchModule: args.acceptanceModule,
      testbench: {
        path: `acceptance/${args.acceptanceTbPath.split(/[\\/]/).pop()!}`,
        content: await file.text(),
        mediaType: args.acceptanceTbPath.toLowerCase().endsWith(".sv") ? "text/systemverilog" : "text/x-verilog",
      },
    };
  }
  const skillLoader = new SkillLoader();
  const skillPrompts = await skillLoader.buildPrompts();

  const model: LoopModel = args.offline ? new CounterScriptedModel() : createRuntimeModelFromEnv();

  let connector;
  if (args.offline) {
    connector = new FakeVivadoConnector({ behavior: successBehavior() });
  } else if (args.viaCore) {
    connector = buildCoreApiConnector(project);
  } else if (args.fakeConnector) {
    connector = new FakeVivadoConnector({ behavior: successBehavior() });
  } else {
    // Cloudflare 中继传输已消融（生产为 direct mTLS / 经 Core 两条路）。
    throw new Error("direct worker transport removed — pass --via-core (production path) or --offline/--fake-connector");
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
      baseUrl: coreCfg.baseUrl, token: coreCfg.token, projectId: project,
      taskRuntimeToken: process.env.SYNTHIA_TASK_RUNTIME_TOKEN,
      taskId: process.env.SYNTHIA_TASK_ID,
      processInstanceId: process.env.SYNTHIA_PROCESS_INSTANCE_ID ?? "pi-default",
    });
    process.stderr.write(`[runtime] governance=core-api (${coreCfg.baseUrl})\n`);
  } else {
    process.stderr.write(`[runtime] ERROR: Core is required for GJB gate governance. Use --via-core (with SYNTHIA_CORE_TOKEN) or --no-governance (dev/debug only).\n`);
    process.exit(1);
  }

  process.stderr.write(`[runtime] model=${args.offline ? "offline-scripted" : "openai-compatible"} connector=${connector.id} part=${part} cap=${VIVADO_CAPABILITY_VERSION}\n`);

  // Run-state persistence
  let agentId: string;

  if (args.resumeAgentId) {
    agentState = agentState!;
    agentId = agentState.agentId;
    process.stderr.write(`[runtime] resuming agent ${agentId} (status=${agentState.status}, stage=${agentState.currentStage}${agentState.awaitingGate ? `, gate=${agentState.awaitingGate}` : ""})\n`);
  } else {
    agentId = newAgentId();
    agentState = createAgentState({ agentId, task: args.task, part, projectId: project, acceptanceTestbench });
    process.stderr.write(`[runtime] starting new agent ${agentId}\n`);
  }

  const loop = new LoopExecutor({
    model, connector, governance, skillPrompts,
    part, projectId: project,
    processInstanceId: process.env.SYNTHIA_PROCESS_INSTANCE_ID ?? "pi-default",
    toolModelPolicyHash: process.env.SYNTHIA_TOOL_MODEL_POLICY_HASH ?? "synthia-policy-v1",
    actorId: "synthia-runtime",
    acceptanceTestbench,
    onEvent: (e) => process.stderr.write(`[runtime] ${e.category}/${e.phase} ${e.action} ${e.result ?? ""}\n`),
    onStateChange: async (state) => { await saveAgentState(state); },
    onAwaitingApproval: (gate, submissionId, rid) => {
      process.stderr.write(`\n[runtime] ═══════════════════════════════════════════════════\n`);
      process.stderr.write(`[runtime]  等待 ${gate} 人工批准\n`);
      process.stderr.write(`[runtime]  submission: ${submissionId}\n`);
      process.stderr.write(`[runtime]  agent: ${rid}\n`);
      process.stderr.write(`[runtime]  批准后执行: bun run runtime/cli.ts --resume ${rid}\n`);
      process.stderr.write(`[runtime] ═══════════════════════════════════════════════════\n\n`);
    },
  });

  const result = args.resumeAgentId && agentState
    ? await loop.resume(agentState)
    : await loop.run(args.task, { agentId, agentState });

  // The loop persists stage boundaries; persist the terminal projection too so
  // CLI inspection never leaves a completed run looking "running".
  const persisted = await loadAgentState(agentId);
  await saveAgentState({
    ...persisted,
    status: result.awaitingGate ? "awaiting_approval" : result.status,
    ...(result.endedReason ? { endedReason: result.endedReason } : {}),
    ...(result.terminalCause ? { terminalCause: result.terminalCause } : {}),
  });

  process.stdout.write(renderReport(result) + "\n");
  // Exit codes: 0=succeeded, 1=failed, 3=fail_closed, 4=awaiting_approval
  const exitCode = result.awaitingGate ? 4 : result.status === "succeeded" ? 0 : result.status === "fail_closed" ? 3 : 1;
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((e) => { process.stderr.write(`[runtime] fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
}
