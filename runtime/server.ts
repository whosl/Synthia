/**
 * Synthia Runtime — HTTP task service.
 *
 * Wraps LoopExecutor in a Bun.serve HTTP server with:
 *   POST /tasks                  → async-start a loop run, 201 {run_id}
 *   GET  /tasks                  → list all runs
 *   GET  /tasks/:runId           → run detail (status, docs, audit, evidence)
 *   POST /tasks/:runId/resume    → idempotent resume, 200 {resumed:true}
 *
 * Approval auto-resume monitor: polls Core gate-submission state for every
 * awaiting_approval run every `gatePollMs`; approved → auto-resume;
 * rejected/withdrawn → fail_closed terminal.
 *
 * Disk recovery: on startup, loads .runs/ from disk; runs whose persisted
 * status was "running" are marked "interrupted" (a server-level concept;
 * disk is updated to "failed" with reason).
 *
 * Env (production):
 *   SYNTHIA_RUNTIME_PORT       (default 8790)
 *   SYNTHIA_GATE_POLL_MS       (default 8000)
 *   SYNTHIA_RUNTIME_MODE       offline | core | fake-connector  (default core)
 *   SYNTHIA_NO_GOVERNANCE      1|true to skip gate flow
 *   SYNTHIA_PART               default FPGA part (default xc7k70tfbv676-1)
 *   SYNTHIA_TOOL_MODEL_POLICY_HASH (default synthia-policy-v1)
 *   SYNTHIA_RUNS_DIR           override .runs/ directory (tests)
 *   SYNTHIA_MODEL_URL / KEY / NAME  (real model, non-offline mode)
 *   SYNTHIA_CORE_TOKEN / URL        (core / governance mode)
 *
 * Usage:
 *   bun run runtime/server.ts                    # core mode, port 8790
 *   SYNTHIA_RUNTIME_MODE=offline bun run runtime/server.ts   # offline smoke
 */

import type { Server } from "bun";

// ── loop + persistence ──────────────────────────────────────────────────────
import { LoopExecutor, FakeVivadoConnector, successBehavior } from "./loop.ts";
import {
  newRunId, createRunState, loadRunState, saveRunState, listRuns,
} from "./run-state.ts";
import type {
  AuditEvent, EvidenceSummary, GateId, GovernanceClient, LoopModel,
  LoopConnector, LoopResult, RegisteredRevision, RunState, StageId,
  TerminalCause,
} from "./types.ts";

// ── shared deps ──────────────────────────────────────────────────────────────
import {
  CounterScriptedModel, buildCoreApiConnector, buildCoreGovernanceClient,
} from "./deps.ts";
import { ModelClient, modelConfigFromEnv } from "./model-client.ts";
import { SkillLoader } from "./skill-loader.ts";
import type { SkillPrompts } from "./skill-loader.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerStatus =
  | "running" | "awaiting_approval" | "succeeded" | "failed" | "fail_closed"
  | "interrupted";

export interface RunHandle {
  readonly runId: string;
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly task: string;
  readonly part: string;
  status: ServerStatus;
  currentStage: StageId;
  awaitingGate?: GateId;
  busy: boolean;
  audit: AuditEvent[];
  evidence: EvidenceSummary[];
  docs: Partial<Record<StageId, RegisteredRevision>>;
  endedReason?: string;
  /** Structured terminal cause (governance_rejected = not resumable). */
  terminalCause?: TerminalCause;
  // deps retained for resume
  readonly model: LoopModel;
  readonly connector: LoopConnector;
  readonly governance: GovernanceClient;
  readonly skillPrompts: SkillPrompts;
  readonly toolModelPolicyHash: string;
  // latest persisted state (mirrors disk; updated via onStateChange)
  currentState?: RunState;
}

export interface RunDeps {
  readonly model: LoopModel;
  readonly connector: LoopConnector;
  readonly governance: GovernanceClient;
}

export type DepsFactory = (opts: {
  projectId: string;
  processInstanceId: string;
}) => Promise<RunDeps>;

export interface ServerConfig {
  readonly skillPrompts: SkillPrompts;
  readonly toolModelPolicyHash: string;
  readonly defaultPart: string;
  readonly gatePollMs: number;
  readonly port: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE_PHASE: Readonly<Record<string, string>> = {
  intake: "generate_intake",
  behavior_wave: "generate_behavior_wave",
  architecture: "generate_architecture",
  register_spec: "generate_register_spec",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

// ---------------------------------------------------------------------------
// RuntimeServer
// ---------------------------------------------------------------------------

export class RuntimeServer {
  private readonly registry = new Map<string, RunHandle>();
  private server?: Server;
  private monitorTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: ServerConfig,
    private readonly depsFactory: DepsFactory,
  ) {}

  get port(): number { return this.server?.port ?? this.config.port; }
  get url(): string { return `http://127.0.0.1:${this.port}`; }

  // ----- lifecycle -----

  async start(): Promise<void> {
    await this.recover();
    this.startMonitor();
    this.server = Bun.serve({
      port: this.config.port,
      fetch: (req) => this.handle(req),
    });
    process.stderr.write(`[runtime-server] listening on ${this.url}\n`);
  }

  async stop(): Promise<void> {
    this.stopMonitor();
    this.server?.stop(true);
    this.server = undefined;
  }

  /** Force-stop without recovery (tests). */
  async reset(): Promise<void> {
    this.stopMonitor();
    this.server?.stop(true);
    this.server = undefined;
    this.registry.clear();
  }

  // ----- HTTP routing -----

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    try {
      if (method === "POST" && path === "/tasks")
        return await this.handleCreateTask(req);
      if (method === "GET" && path === "/tasks")
        return this.handleListTasks();

      const resumeMatch = path.match(/^\/tasks\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch)
        return this.handleResume(resumeMatch[1]!);

      const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (method === "GET" && taskMatch)
        return this.handleGetTask(taskMatch[1]!);

      return errorResponse(404, "not_found", `unknown endpoint: ${method} ${path}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return errorResponse(500, "internal_error", message);
    }
  }

  // POST /tasks
  private async handleCreateTask(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return errorResponse(400, "bad_request", "invalid JSON body");
    }

    const projectId = body.project_id;
    const processInstanceId = body.process_instance_id;
    const task = body.task;
    const part = (typeof body.part === "string" && body.part) || this.config.defaultPart;

    if (typeof projectId !== "string" || !projectId)
      return errorResponse(400, "bad_request", "project_id is required");
    if (typeof processInstanceId !== "string" || !processInstanceId)
      return errorResponse(400, "bad_request", "process_instance_id is required");
    if (typeof task !== "string" || !task)
      return errorResponse(400, "bad_request", "task is required");

    // Build deps before creating state so a factory failure doesn't orphan files.
    let deps: RunDeps;
    try {
      deps = await this.depsFactory({ projectId, processInstanceId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(503, "capability_unavailable", `failed to build runtime deps: ${msg}`);
    }

    const runId = newRunId();
    const runState = createRunState({ runId, task, part, projectId, processInstanceId });
    await saveRunState(runState);

    const handle: RunHandle = {
      runId, projectId, processInstanceId, task, part,
      status: "running",
      currentStage: "intake",
      busy: false,
      audit: [],
      evidence: [],
      docs: {},
      createdAt: runState.createdAt,
      model: deps.model,
      connector: deps.connector,
      governance: deps.governance,
      skillPrompts: this.config.skillPrompts,
      toolModelPolicyHash: this.config.toolModelPolicyHash,
      currentState: runState,
    };
    this.registry.set(runId, handle);

    // Async start — don't await.
    this.executeRun(runId, "initial").catch((e) => {
      process.stderr.write(`[runtime-server] executeRun error for ${runId}: ${e}\n`);
    });

    return json({ run_id: runId }, 201);
  }

  // GET /tasks
  private handleListTasks(): Response {
    const runs = [...this.registry.values()].map((h) => ({
      run_id: h.runId,
      project_id: h.projectId,
      status: h.status,
      current_stage: h.currentStage,
      awaiting_gate: h.awaitingGate ?? null,
      created_at: h.createdAt,
    }));
    return json({ runs });
  }

  // GET /tasks/:runId
  private handleGetTask(runId: string): Response {
    const h = this.registry.get(runId);
    if (!h) return errorResponse(404, "not_found", `run ${runId} not found`);

    const docs = Object.entries(h.docs)
      .filter(([, rev]) => rev)
      .map(([stage, rev]) => ({
        phase: STAGE_PHASE[stage] ?? stage,
        path: rev!.contentLocation ?? "",
        artifact_id: rev!.artifactId,
        revision_id: rev!.revisionId,
      }));

    return json({
      run_id: h.runId,
      project_id: h.projectId,
      task: h.task,
      status: h.status,
      current_stage: h.currentStage,
      awaiting_gate: h.awaitingGate ?? null,
      docs,
      audit: h.audit.slice(-50),
      evidence: h.evidence,
      ...(h.endedReason ? { reason: h.endedReason } : {}),
      ...(h.terminalCause ? { terminal_cause: h.terminalCause } : {}),
    });
  }

  // POST /tasks/:runId/resume
  private handleResume(runId: string): Response {
    const h = this.registry.get(runId);
    if (!h) return errorResponse(404, "not_found", `run ${runId} not found`);

    // Governance-rejected runs are permanently terminal — never resumable.
    if (h.terminalCause === "governance_rejected") {
      return errorResponse(
        409, "not_resumable",
        `run ${runId} terminated by governance rejection (${h.endedReason ?? "gate rejected"}) — not resumable`,
      );
    }

    // Idempotent: always return {resumed:true} if the run exists and is not
    // governance-rejected. Only trigger actual execution when resumable and
    // not busy.
    const resumable =
      h.status === "awaiting_approval" ||
      h.status === "interrupted" ||
      h.status === "failed" ||
      h.status === "fail_closed";

    if (!h.busy && resumable) {
      this.executeRun(runId, "resume").catch((e) => {
        process.stderr.write(`[runtime-server] resume executeRun error for ${runId}: ${e}\n`);
      });
    }

    return json({ resumed: true });
  }

  // ----- core execution -----

  private async executeRun(
    runId: string,
    trigger: "initial" | "resume",
  ): Promise<void> {
    const h = this.registry.get(runId);
    if (!h) return;
    if (h.busy) return; // concurrent guard

    h.busy = true;

    try {
      const runState = await loadRunState(runId);

      const loop = new LoopExecutor({
        model: h.model,
        connector: h.connector,
        governance: h.governance,
        skillPrompts: h.skillPrompts,
        part: h.part,
        projectId: h.projectId,
        processInstanceId: h.processInstanceId,
        toolModelPolicyHash: h.toolModelPolicyHash,
        actorId: "synthia-runtime-server",
        onEvent: (e) => { h.audit.push(e); },
        onStateChange: async (state) => {
          await saveRunState(state);
          h.currentState = state;
          h.currentStage = state.currentStage;
          h.docs = { ...(state.docs ?? {}) };
          if (state.awaitingGate) h.awaitingGate = state.awaitingGate;
        },
        onAwaitingApproval: (gate, submissionId, rid) => {
          process.stderr.write(
            `[runtime-server] run ${rid} awaiting ${gate} (submission: ${submissionId})\n`,
          );
        },
      });

      h.status = "running";
      h.awaitingGate = undefined;
      h.terminalCause = undefined;

      const isResume =
        trigger === "resume" ||
        (runState.status === "awaiting_approval" && runState.awaitingGate);

      const result: LoopResult = isResume
        ? await loop.resume(runState)
        : await loop.run(h.task, { runId, runState });

      this.applyResult(h, result);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      h.status = "failed";
      h.endedReason = reason;
      h.terminalCause = "execution_error";
      process.stderr.write(`[runtime-server] executeRun failed for ${runId}: ${reason}\n`);
      await this.persistTerminal(h, "failed", reason, "execution_error").catch(() => {});
    } finally {
      h.busy = false;
    }
  }

  private applyResult(h: RunHandle, result: LoopResult): void {
    if (result.awaitingGate) {
      h.status = "awaiting_approval";
      h.awaitingGate = result.awaitingGate;
    } else {
      h.status = result.status; // succeeded | failed | fail_closed
      h.endedReason = result.endedReason;
      h.terminalCause = result.terminalCause;
      h.awaitingGate = undefined;
      // Persist terminal state — the loop's finish() doesn't call onStateChange.
      this.persistTerminal(h, result.status, result.endedReason, result.terminalCause).catch(() => {});
    }

    // Merge evidence (deduped by jobId) — evidence is per-executor-instance.
    for (const ev of result.evidence) {
      if (!h.evidence.some((e) => e.jobId === ev.jobId)) {
        h.evidence.push(ev);
      }
    }
  }

  private async persistTerminal(
    h: RunHandle,
    status: "succeeded" | "failed" | "fail_closed",
    reason?: string,
    cause?: TerminalCause,
  ): Promise<void> {
    if (!h.currentState) return;
    const terminal: RunState = {
      ...h.currentState,
      status,
      endedReason: reason,
      ...(cause ? { terminalCause: cause } : {}),
      awaitingGate: undefined,
    };
    await saveRunState(terminal);
    h.currentState = terminal;
  }

  // ----- approval auto-resume monitor -----

  private startMonitor(): void {
    const ms = this.config.gatePollMs;
    if (ms <= 0) return; // disabled
    this.monitorTimer = setInterval(() => {
      this.monitorTick().catch((e) => {
        process.stderr.write(`[runtime-server] monitor tick error: ${e}\n`);
      });
    }, ms);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  private async monitorTick(): Promise<void> {
    const awaiting = [...this.registry.values()].filter(
      (h) => h.status === "awaiting_approval" && !h.busy,
    );
    await Promise.allSettled(awaiting.map((h) => this.pollGate(h)));
  }

  private async pollGate(h: RunHandle): Promise<void> {
    const gate = h.awaitingGate;
    if (!gate) return;
    const submissionId = h.currentState?.gateSubmissions?.[gate];
    if (!submissionId) return;

    const { state } = await h.governance.getGateSubmissionState(submissionId);

    if (state === "approved") {
      process.stderr.write(
        `[runtime-server] gate ${gate} approved for run ${h.runId} — auto-resuming\n`,
      );
      this.executeRun(h.runId, "resume").catch(() => {});
    } else if (state === "rejected" || state === "withdrawn") {
      process.stderr.write(
        `[runtime-server] gate ${gate} ${state} for run ${h.runId} — fail-closed\n`,
      );
      h.status = "fail_closed";
      h.endedReason = `gate ${gate} was ${state} — stopping (fail-closed)`;
      h.terminalCause = "governance_rejected";
      h.awaitingGate = undefined;
      await this.persistTerminal(h, "fail_closed", h.endedReason, "governance_rejected").catch(() => {});
    }
    // else: still preparing/submitted/checking/in_review — keep waiting.
  }

  // ----- disk recovery -----

  private async recover(): Promise<void> {
    const runIds = await listRuns();
    for (const runId of runIds) {
      try {
        const state = await loadRunState(runId);
        const wasRunning = state.status === "running";
        const processInstanceId = state.processInstanceId ?? "pi-default";

        const deps = await this.depsFactory({
          projectId: state.projectId,
          processInstanceId,
        });

        const handle: RunHandle = {
          runId,
          projectId: state.projectId,
          processInstanceId,
          task: state.task,
          part: state.part,
          status: wasRunning ? "interrupted" : state.status,
          currentStage: state.currentStage,
          awaitingGate: state.awaitingGate,
          busy: false,
          audit: [],
          evidence: [],
          docs: { ...(state.docs ?? {}) },
          endedReason: wasRunning
            ? "interrupted by server restart"
            : state.endedReason,
          ...(state.terminalCause ? { terminalCause: state.terminalCause } : {}),
          model: deps.model,
          connector: deps.connector,
          governance: deps.governance,
          skillPrompts: this.config.skillPrompts,
          toolModelPolicyHash: this.config.toolModelPolicyHash,
          currentState: state,
        };
        this.registry.set(runId, handle);

        // Persist interrupted runs as "failed" on disk (RunState has no
        // "interrupted" status; the handle tracks it in-memory).
        if (wasRunning) {
          const updated: RunState = {
            ...state,
            status: "failed",
            endedReason: "interrupted by server restart",
            terminalCause: "execution_error",
          };
          await saveRunState(updated);
          handle.currentState = updated;
        }

        process.stderr.write(
          `[runtime-server] recovered run ${runId} (status=${handle.status})\n`,
        );
      } catch (e) {
        process.stderr.write(
          `[runtime-server] recovery: failed to load ${runId}: ${e}\n`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Env-based factory (production)
// ---------------------------------------------------------------------------

export async function createServerConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<ServerConfig> {
  const loader = new SkillLoader();
  const skillPrompts = await loader.buildPrompts();
  return {
    skillPrompts,
    toolModelPolicyHash:
      env.SYNTHIA_TOOL_MODEL_POLICY_HASH ?? "synthia-policy-v1",
    defaultPart: env.SYNTHIA_PART ?? "xc7k70tfbv676-1",
    gatePollMs: Number(env.SYNTHIA_GATE_POLL_MS ?? 8000),
    port: Number(env.SYNTHIA_RUNTIME_PORT ?? 8790),
  };
}

export function createEnvDepsFactory(
  env: Record<string, string | undefined> = process.env,
): DepsFactory {
  const mode = (env.SYNTHIA_RUNTIME_MODE ?? "core") as
    | "offline" | "core" | "fake-connector";
  const noGovernance =
    env.SYNTHIA_NO_GOVERNANCE === "1" || env.SYNTHIA_NO_GOVERNANCE === "true";

  return async ({ projectId, processInstanceId }) => {
    // Model
    const model: LoopModel =
      mode === "offline"
        ? new CounterScriptedModel()
        : new ModelClient(modelConfigFromEnv(env));

    // Connector
    let connector: LoopConnector;
    if (mode === "offline" || mode === "fake-connector") {
      connector = new FakeVivadoConnector({ behavior: successBehavior() });
    } else {
      connector = buildCoreApiConnector(projectId);
    }

    // Governance
    let governance: GovernanceClient;
    if (noGovernance) {
      governance = new NoGovernanceClient();
    } else if (mode === "core") {
      governance = buildCoreGovernanceClient(projectId, processInstanceId);
    } else {
      // offline / fake-connector without Core → no governance.
      governance = new NoGovernanceClient();
    }

    return { model, connector, governance };
  };
}

// ---------------------------------------------------------------------------
// Main entry (bun run runtime/server.ts)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Clear proxy env so the internal model endpoint and Core are reached directly.
  for (const k of [
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
  ])
    delete process.env[k];

  const config = await createServerConfig();
  const factory = createEnvDepsFactory();
  const server = new RuntimeServer(config, factory);
  await server.start();

  // Graceful shutdown.
  process.on("SIGINT", async () => { await server.stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await server.stop(); process.exit(0); });
}

// Run only when executed directly, not when imported by tests.
if (import.meta.path === Bun.main) {
  main().catch((e) => {
    process.stderr.write(
      `[runtime-server] fatal: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
