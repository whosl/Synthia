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

import { SkillLoader } from "./skill-loader.ts";
import { ModelClient, modelConfigFromEnv } from "./model-client.ts";
import { LoopExecutor, FakeVivadoConnector, successBehavior, VIVADO_CAPABILITY_VERSION } from "./loop.ts";
import { resolveCoreApiConfig } from "./core-api-connector.ts";
import { CoreGovernanceClient } from "./governance-client.ts";
import { newRunId, createRunState, loadRunState, saveRunState } from "./run-state.ts";
import type { GovernanceClient, LoopModel, LoopResult, RunState } from "./types.ts";
import { NoGovernanceClient as NoGovClient } from "./types.ts";
import { CounterScriptedModel, buildRemoteConnector, buildCoreApiConnector } from "./deps.ts";

const DEFAULT_PART = "xc7k70tfbv676-1";
const DEFAULT_PROJECT = "p1";

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
