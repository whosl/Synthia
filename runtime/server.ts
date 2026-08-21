/**
 * Synthia Runtime — HTTP task service.
 *
 * Wraps LoopExecutor in a Bun.serve HTTP server with:
 *   POST /tasks                  → async-start a loop agent, 201 {agent_id}
 *   GET  /tasks                  → list all agents
 *   GET  /tasks/:agentId           → agent detail (status, docs, audit, evidence)
 *   POST /tasks/:agentId/resume    → idempotent resume, 200 {resumed:true}
 *
 * Approval auto-resume monitor: polls Core gate-submission state for every
 * awaiting_approval agent every `gatePollMs`; approved → auto-resume;
 * rejected/withdrawn → fail_closed terminal.
 *
 * Disk recovery: on startup, loads .runs/ from disk; agents whose persisted
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
 *   SYNTHIA_MODEL_REASONING_EFFORT  (optional; sent as reasoning_effort. 当前保 xhigh，
 *                                    见 specs/agent-stream-benchmark.md §4.2)
 *   SYNTHIA_MODEL_CHAT_MAX_TOKENS   (free-agent 对话轮的可见 token 上限, default 16384)
 *   SYNTHIA_MODEL_TOOL_MAX_TOKENS   (流水线工具阶段, default 4096)
 *   SYNTHIA_MODEL_STREAM_FALLBACK   0|false 关掉「流式失败降级为非流式」(default on)
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
  newAgentId, createAgentState, loadAgentState, saveAgentState, listAgents,
} from "./agent-state.ts";
import type {
  AuditEvent, EvidenceSummary, GateId, GovernanceClient, LoopModel,
  LoopConnector, LoopResult, RegisteredRevision, AgentState, StageId,
  ProjectInfo, TerminalCause,
} from "./types.ts";
// 值导入（上面那块是 import type，`new` 不到）：offline / fake-connector /
// SYNTHIA_NO_GOVERNANCE 三条路径都要实例化它。
import { NoGovernanceClient } from "./types.ts";

// ── shared deps ──────────────────────────────────────────────────────────────
import {
  CounterScriptedModel, buildCoreApiConnector, buildCoreGovernanceClient,
} from "./deps.ts";
import { ModelClient, modelConfigFromEnv } from "./model-client.ts";
import { SkillLoader } from "./skill-loader.ts";
import type { SkillPrompts } from "./skill-loader.ts";

// ── free-agent mode (spec 001-agent-freedom) ────────────────────────────────
import { createFreeAgentSession } from "./free-agent.ts";
import { assembleSkillTools } from "./skill-tools.ts";
import { assembleGateTools } from "./gate-tools.ts";
import { assembleVivadoTool } from "./vivado-tool.ts";
import { assembleSkillDocTool } from "./skill-doc-tool.ts";
import { buildContextSnapshot } from "./context-snapshot.ts";
import { buildAgentDoc, composeSystemPrompt } from "./agent-doc.ts";
import type { FreeAgentDeps, FreeAgentSession, ConversationalModel, PromptStreamOptions } from "./agent-types.ts";
import { StreamHub, type StreamEvent } from "./stream-hub.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerStatus =
  | "idle" | "running" | "awaiting_approval" | "succeeded" | "failed" | "fail_closed"
  | "interrupted";

export interface AgentHandle {
  readonly agentId: string;
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly projectType?: string;
  readonly processVersionId?: string | null;
  readonly processProfileId?: string | null;
  readonly processProfileName?: string | null;
  readonly processProfileVersion?: string | null;
  readonly executionMode: "free" | "engineering";
  readonly task: string;
  readonly part: string;
  readonly createdAt: string;
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
  currentState?: AgentState;
}

export interface AgentDeps {
  readonly model: LoopModel;
  readonly connector: LoopConnector;
  readonly governance: GovernanceClient;
}

export type DepsFactory = (opts: {
  projectId: string;
  processInstanceId: string;
  projectType?: string;
  processVersionId?: string;
  processProfileId?: string;
  processProfileName?: string;
  processProfileVersion?: string;
}) => Promise<AgentDeps>;

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

function optionalBodyString(
  body: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const value = body[snakeKey] ?? body[camelKey];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function inferExecutionMode(state: AgentState): "free" | "engineering" {
  if (state.executionMode) return state.executionMode;
  // Pre-P1 free sessions used this stable task label; old pipeline states use
  // the user's task text. Unknown states fail toward the governed path.
  return state.task === "free-agent session" ? "free" : "engineering";
}

class RuntimeProjectConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProjectConfigError";
  }
}

interface ProjectRuntimeFacts {
  readonly projectType?: "free" | "engineering";
  readonly processVersionId?: string | null;
  readonly processProfileId?: string | null;
  readonly processProfileName?: string | null;
  readonly processProfileVersion?: string | null;
}

interface ResolvedProjectRuntime extends ProjectRuntimeFacts {
  readonly executionMode: "free" | "engineering";
  readonly processInstanceId: string;
  readonly part: string;
}

function normalizeKnownProjectType(projectType: string | undefined): "free" | "engineering" | undefined {
  if (projectType === undefined) return undefined;
  if (projectType === "free" || projectType === "engineering") return projectType;
  throw new RuntimeProjectConfigError(409, "project_type_unsupported", `unsupported project_type: ${projectType}`);
}

function factsFromProjectInfo(info: ProjectInfo | null): ProjectRuntimeFacts {
  if (!info) return {};
  return {
    projectType: normalizeKnownProjectType(info.projectType),
    ...(info.processVersionId !== undefined ? { processVersionId: info.processVersionId } : {}),
    ...(info.processProfileId !== undefined ? { processProfileId: info.processProfileId } : {}),
    ...(info.processProfileName !== undefined ? { processProfileName: info.processProfileName } : {}),
    ...(info.processProfileVersion !== undefined ? { processProfileVersion: info.processProfileVersion } : {}),
  };
}

function coalesceNullableString(...values: readonly (string | null | undefined)[]): string | null | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function supportedProfileId(facts: ProjectRuntimeFacts): string | null {
  return facts.processProfileId ?? facts.processVersionId ?? null;
}

const PROCESS_RUNTIME_FACT_KEYS = [
  "processVersionId",
  "processProfileId",
  "processProfileVersion",
  "processProfileName",
] as const satisfies readonly (keyof ProjectRuntimeFacts)[];

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertSupportedProjectRuntime(facts: ProjectRuntimeFacts): void {
  const hasProcessFacts = PROCESS_RUNTIME_FACT_KEYS.some(
    (key) => facts[key] !== undefined && facts[key] !== null,
  );
  if (!facts.projectType) {
    if (hasProcessFacts) {
      throw new RuntimeProjectConfigError(
        409,
        "project_type_missing",
        "project_type is required when process profile facts are present",
      );
    }
    // Pre-P1/no-governance callers may have no project-model facts at all.
    // That compatibility path is deliberately distinct from a partial modern
    // binding, which is rejected above.
    return;
  }

  if (facts.projectType === "free") {
    const configured = PROCESS_RUNTIME_FACT_KEYS.filter(
      (key) => facts[key] !== undefined && facts[key] !== null,
    );
    if (configured.length > 0) {
      throw new RuntimeProjectConfigError(
        409,
        "project_process_profile_invalid",
        `free project process fields must all be null: ${configured.join(", ")}`,
      );
    }
    return;
  }

  const missing = PROCESS_RUNTIME_FACT_KEYS.filter((key) => !isNonEmptyString(facts[key]));
  if (missing.length > 0) {
    throw new RuntimeProjectConfigError(
      409,
      "project_process_profile_invalid",
      `engineering project is missing frozen process facts: ${missing.join(", ")}`,
    );
  }

  const processVersionId = facts.processVersionId!;
  const processProfileId = facts.processProfileId!;
  const processProfileVersion = facts.processProfileVersion!;
  if (processVersionId !== processProfileId || processProfileVersion !== processProfileId) {
    throw new RuntimeProjectConfigError(
      409,
      "project_process_profile_conflict",
      `frozen process aliases disagree: process_version_id=${processVersionId}, ` +
        `process_profile_id=${processProfileId}, process_profile_version=${processProfileVersion}`,
    );
  }
  const profile = processProfileId;
  if (profile && profile !== "GJB_REF_V1" && profile !== "LEGACY_COMPAT") {
    throw new RuntimeProjectConfigError(
      409,
      "project_process_profile_unsupported",
      `unsupported process profile: ${profile}`,
    );
  }
}

function assertCompleteCoreProjectRuntime(facts: ProjectRuntimeFacts): void {
  if (!facts.projectType) {
    throw new RuntimeProjectConfigError(
      409,
      "project_type_missing",
      "Core project facts are missing project_type",
    );
  }
  if (facts.projectType === "free") {
    const notNull = PROCESS_RUNTIME_FACT_KEYS.filter((key) => facts[key] !== null);
    if (notNull.length > 0) {
      throw new RuntimeProjectConfigError(
        409,
        "project_process_profile_invalid",
        `Core free-project process fields must be explicit null: ${notNull.join(", ")}`,
      );
    }
    return;
  }
  assertSupportedProjectRuntime(facts);
}

function assertMatchingFact(
  key: string,
  requestValue: string | null | undefined,
  coreValue: string | null | undefined,
): void {
  if (requestValue !== undefined && coreValue !== undefined && requestValue !== coreValue) {
    throw new RuntimeProjectConfigError(
      409,
      "project_process_profile_mismatch",
      `request ${key} ${requestValue} does not match Core ${key} ${coreValue}`,
    );
  }
}

function mergeProjectRuntimeFacts(
  request: ProjectRuntimeFacts,
  core: ProjectRuntimeFacts,
): ProjectRuntimeFacts {
  if (request.projectType && core.projectType && request.projectType !== core.projectType) {
    throw new RuntimeProjectConfigError(
      409,
      "project_type_mismatch",
      `request project_type ${request.projectType} does not match Core project_type ${core.projectType}`,
    );
  }
  assertMatchingFact("process_version_id", request.processVersionId, core.processVersionId);
  assertMatchingFact("process_profile_id", request.processProfileId, core.processProfileId);
  assertMatchingFact("process_profile_name", request.processProfileName, core.processProfileName);
  assertMatchingFact("process_profile_version", request.processProfileVersion, core.processProfileVersion);
  const projectType = core.projectType ?? request.projectType;
  const processVersionId = coalesceNullableString(core.processVersionId, request.processVersionId);
  const processProfileId = coalesceNullableString(core.processProfileId, request.processProfileId);
  const processProfileName = coalesceNullableString(core.processProfileName, request.processProfileName);
  const processProfileVersion = coalesceNullableString(core.processProfileVersion, request.processProfileVersion);
  const merged: ProjectRuntimeFacts = {
    ...(projectType ? { projectType } : {}),
    ...(processVersionId !== undefined ? { processVersionId } : {}),
    ...(processProfileId !== undefined ? { processProfileId } : {}),
    ...(processProfileName !== undefined ? { processProfileName } : {}),
    ...(processProfileVersion !== undefined ? { processProfileVersion } : {}),
  };
  assertSupportedProjectRuntime(merged);
  return merged.projectType === "free"
    ? {
        ...merged,
        processVersionId: null,
        processProfileId: null,
        processProfileName: null,
        processProfileVersion: null,
      }
    : merged;
}

function resolveProjectRuntime(input: {
  readonly requestFacts: ProjectRuntimeFacts;
  readonly coreInfo: ProjectInfo | null;
  readonly requestedMode: unknown;
  readonly rawProcessInstanceId: unknown;
  readonly projectId: string;
  readonly requestedPart: unknown;
  readonly defaultPart: string;
}): ResolvedProjectRuntime {
  const coreFacts = factsFromProjectInfo(input.coreInfo);
  if (input.coreInfo !== null) assertCompleteCoreProjectRuntime(coreFacts);
  const facts = mergeProjectRuntimeFacts(input.requestFacts, coreFacts);
  const legacyMode: "free" | "engineering" = input.requestedMode === "agent" ? "free" : "engineering";
  const frozenProfile = supportedProfileId(facts);
  // LEGACY_COMPAT preserves access to old projects but must never be treated
  // as adoption of the new GJB reference loop. Core also sends mode="agent"
  // for this path; the frozen profile is authoritative if that hint is absent.
  const executionMode: "free" | "engineering" = frozenProfile === "LEGACY_COMPAT"
    ? "free"
    : facts.projectType === "engineering" && frozenProfile === "GJB_REF_V1"
      ? "engineering"
      : facts.projectType === "free"
        ? "free"
        : legacyMode;
  const processInstanceId = typeof input.rawProcessInstanceId === "string" && input.rawProcessInstanceId
    ? input.rawProcessInstanceId
    : executionMode === "free"
      ? `free:${input.projectId}`
      : "";
  if (!processInstanceId) {
    throw new RuntimeProjectConfigError(
      400,
      "bad_request",
      "process_instance_id is required for engineering projects",
    );
  }
  const requestedPart = typeof input.requestedPart === "string" ? input.requestedPart.trim() : "";
  // A modern Core project is allowed to have no target part at creation. Only
  // the legacy/no-governance path retains SYNTHIA_PART as a compatibility
  // default; authoritative project facts must never be overwritten by it.
  const hasAuthoritativeProjectFacts = input.coreInfo !== null || facts.projectType !== undefined;
  const part = requestedPart || (!hasAuthoritativeProjectFacts && executionMode === "engineering"
    ? input.defaultPart
    : "");
  return { ...facts, executionMode, processInstanceId, part };
}

async function readProjectInfo(
  governance: GovernanceClient,
  projectId: string,
): Promise<ProjectInfo | null> {
  if (governance instanceof NoGovernanceClient) return null;
  try {
    return await governance.getProjectInfo(projectId);
  } catch (e) {
    if (e instanceof RuntimeProjectConfigError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new RuntimeProjectConfigError(503, "project_fact_unavailable", `failed to read project facts: ${msg}`);
  }
}

function depsFactoryInput(projectId: string, runtime: {
  readonly processInstanceId: string;
  readonly projectType?: string;
  readonly processVersionId?: string | null;
  readonly processProfileId?: string | null;
  readonly processProfileName?: string | null;
  readonly processProfileVersion?: string | null;
}): Parameters<DepsFactory>[0] {
  return {
    projectId,
    processInstanceId: runtime.processInstanceId,
    ...(runtime.projectType ? { projectType: runtime.projectType } : {}),
    ...(runtime.processVersionId ? { processVersionId: runtime.processVersionId } : {}),
    ...(runtime.processProfileId ? { processProfileId: runtime.processProfileId } : {}),
    ...(runtime.processProfileName ? { processProfileName: runtime.processProfileName } : {}),
    ...(runtime.processProfileVersion ? { processProfileVersion: runtime.processProfileVersion } : {}),
  };
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/**
 * audit 里的工具载荷比 SSE 那份再收一道。
 *
 * SSE 的 2000 字上限（free-agent.ts 的 STREAM_PAYLOAD_MAX）是「一次性推送」的预算；
 * audit 不一样——GET /tasks/:agentId 每 3 秒整量返回一次 slice，同样的字数会被
 * 反复传几百遍。回看一次工具调用只需要认出「调了什么、给了什么、大概返回什么」，
 * 不需要全文，所以这里按预览尺寸截。真正的全文在证据/产物里。
 */
const AUDIT_TOOL_ARGS_MAX = 400;
const AUDIT_TOOL_RESULT_MAX = 800;

/** 超长截断并标注，`…（共 N 字）` 让前端知道这是预览而非全部。 */
function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…（共 ${s.length} 字）`;
}

/**
 * GET /tasks/:agentId 返回的 audit 条数上限。
 *
 * 原来是 50。工具调用落 audit 后，一轮多工具的对话能一口气吃掉十几条，50 会把
 * 更早的用户消息挤出去、对话流开头凭空消失。按上面的预览尺寸算，200 条的最坏
 * 情况约 250KB，3 秒一轮可以接受。
 */
const AUDIT_RESPONSE_LIMIT = 200;

// ---------------------------------------------------------------------------
// RuntimeServer
// ---------------------------------------------------------------------------

export class RuntimeServer {
  private readonly registry = new Map<string, AgentHandle>();
  private readonly sessions = new Map<string, FreeAgentSession>();
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
      // Bun 默认 idleTimeout=10s，会在「无字节收发满 10 秒」时直接掐断连接。
      // SSE 长连接在模型推理阶段（实测 8–40 秒）完全静默，落在这个窗口里必被
      // 掐断——而心跳原本是 15s，永远赶不及。这里放到 Bun 上限 255s，真正的
      // 保活交给 HEARTBEAT_MS（见 handleStream）。
      idleTimeout: 255,
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
    this.sessions.clear();
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

      const messageMatch = path.match(/^\/tasks\/([^/]+)\/message$/);
      if (method === "POST" && messageMatch)
        return await this.handleSendMessage(messageMatch[1]!, req);

      const streamMatch = path.match(/^\/tasks\/([^/]+)\/stream$/);
      if (method === "GET" && streamMatch)
        return await this.handleStream(streamMatch[1]!, req);

      const abortMatch = path.match(/^\/tasks\/([^/]+)\/abort$/);
      if (method === "POST" && abortMatch)
        return await this.handleAbort(abortMatch[1]!);

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
    const rawProcessInstanceId = body.process_instance_id;
    const task = body.task;
    if (typeof projectId !== "string" || !projectId)
      return errorResponse(400, "bad_request", "project_id is required");
    if (typeof task !== "string" || !task)
      return errorResponse(400, "bad_request", "task is required");

    let requestFacts: ProjectRuntimeFacts;
    try {
      const projectType = normalizeKnownProjectType(optionalBodyString(body, "project_type", "projectType"));
      requestFacts = {
        ...(projectType ? { projectType } : {}),
        ...(optionalBodyString(body, "process_version_id", "processVersionId") ? {
          processVersionId: optionalBodyString(body, "process_version_id", "processVersionId"),
        } : {}),
        ...(optionalBodyString(body, "process_profile_id", "processProfileId") ? {
          processProfileId: optionalBodyString(body, "process_profile_id", "processProfileId"),
        } : {}),
        ...(optionalBodyString(body, "process_profile_name", "processProfileName") ? {
          processProfileName: optionalBodyString(body, "process_profile_name", "processProfileName"),
        } : {}),
        ...(optionalBodyString(body, "process_profile_version", "processProfileVersion") ? {
          processProfileVersion: optionalBodyString(body, "process_profile_version", "processProfileVersion"),
        } : {}),
      };
    } catch (e) {
      if (e instanceof RuntimeProjectConfigError) return errorResponse(400, "bad_request", e.message);
      throw e;
    }

    // Build lightweight deps first so Runtime can read Core's project facts
    // before deciding whether this is a free session or governed engineering run.
    const lookupProcessInstanceId =
      typeof rawProcessInstanceId === "string" && rawProcessInstanceId ? rawProcessInstanceId : `lookup:${projectId}`;
    let lookupDeps: AgentDeps;
    let runtime: ResolvedProjectRuntime;
    try {
      lookupDeps = await this.depsFactory({ projectId, processInstanceId: lookupProcessInstanceId });
      runtime = resolveProjectRuntime({
        requestFacts,
        coreInfo: await readProjectInfo(lookupDeps.governance, projectId),
        requestedMode: body.mode,
        rawProcessInstanceId,
        projectId,
        requestedPart: body.part,
        defaultPart: this.config.defaultPart,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof RuntimeProjectConfigError) {
        return errorResponse(e.status, e.code, msg);
      }
      return errorResponse(503, "capability_unavailable", `failed to resolve project runtime config: ${msg}`);
    }

    // Build deps before creating state so a factory failure doesn't orphan files.
    let deps: AgentDeps;
    try {
      deps = await this.depsFactory(depsFactoryInput(projectId, runtime));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(503, "capability_unavailable", `failed to build runtime deps: ${msg}`);
    }

    const agentId = newAgentId();
    const agentState = createAgentState({
      agentId, task, part: runtime.part, projectId, processInstanceId: runtime.processInstanceId,
      ...(runtime.projectType ? { projectType: runtime.projectType } : {}),
      ...(runtime.processVersionId !== undefined ? { processVersionId: runtime.processVersionId } : {}),
      ...(runtime.processProfileId !== undefined ? { processProfileId: runtime.processProfileId } : {}),
      ...(runtime.processProfileName !== undefined ? { processProfileName: runtime.processProfileName } : {}),
      ...(runtime.processProfileVersion !== undefined ? { processProfileVersion: runtime.processProfileVersion } : {}),
      executionMode: runtime.executionMode,
    });
    await saveAgentState(agentState);

    const handle: AgentHandle = {
      agentId, projectId, processInstanceId: runtime.processInstanceId, task, part: runtime.part,
      ...(runtime.projectType ? { projectType: runtime.projectType } : {}),
      ...(runtime.processVersionId !== undefined ? { processVersionId: runtime.processVersionId } : {}),
      ...(runtime.processProfileId !== undefined ? { processProfileId: runtime.processProfileId } : {}),
      ...(runtime.processProfileName !== undefined ? { processProfileName: runtime.processProfileName } : {}),
      ...(runtime.processProfileVersion !== undefined ? { processProfileVersion: runtime.processProfileVersion } : {}),
      executionMode: runtime.executionMode,
      status: "running",
      currentStage: "intake",
      busy: false,
      audit: [],
      evidence: [],
      docs: {},
      createdAt: agentState.createdAt,
      model: deps.model,
      connector: deps.connector,
      governance: deps.governance,
      skillPrompts: this.config.skillPrompts,
      toolModelPolicyHash: this.config.toolModelPolicyHash,
      currentState: agentState,
    };
    this.registry.set(agentId, handle);

    // mode="agent": free-agent conversation only — do NOT start the GJB
    // pipeline loop. The agent stays idle until /message drives it.
    if (runtime.executionMode === "free") {
      handle.status = "idle";
      return json({ agent_id: agentId }, 201);
    }

    // Async start — don't await.
    this.executeAgent(agentId, "initial").catch((e) => {
      process.stderr.write(`[runtime-server] executeAgent error for ${agentId}: ${e}\n`);
    });

    return json({ agent_id: agentId }, 201);
  }

  // GET /tasks
  private handleListTasks(): Response {
    const agents = [...this.registry.values()].map((h) => ({
      agent_id: h.agentId,
      project_id: h.projectId,
      status: h.status,
      current_stage: h.currentStage,
      awaiting_gate: h.awaitingGate ?? null,
      created_at: h.createdAt,
    }));
    return json({ agents });
  }

  // GET /tasks/:agentId
  private handleGetTask(agentId: string): Response {
    const h = this.registry.get(agentId);
    if (!h) return errorResponse(404, "not_found", `agent ${agentId} not found`);

    const docs = Object.entries(h.docs)
      .filter(([, rev]) => rev)
      .map(([stage, rev]) => ({
        phase: STAGE_PHASE[stage] ?? stage,
        path: rev!.contentLocation ?? "",
        artifact_id: rev!.artifactId,
        revision_id: rev!.revisionId,
      }));

    return json({
      agent_id: h.agentId,
      project_id: h.projectId,
      execution_mode: h.executionMode,
      project_type: h.projectType ?? null,
      process_version_id: h.processVersionId ?? null,
      process_profile_id: h.processProfileId ?? null,
      process_profile_name: h.processProfileName ?? null,
      process_profile_version: h.processProfileVersion ?? null,
      task: h.task,
      status: h.status,
      current_stage: h.currentStage,
      awaiting_gate: h.awaitingGate ?? null,
      docs,
      audit: h.audit.slice(-AUDIT_RESPONSE_LIMIT),
      evidence: h.evidence,
      ...(h.endedReason ? { reason: h.endedReason } : {}),
      ...(h.terminalCause ? { terminal_cause: h.terminalCause } : {}),
    });
  }

  // POST /tasks/:agentId/resume
  private handleResume(agentId: string): Response {
    const h = this.registry.get(agentId);
    if (!h) return errorResponse(404, "not_found", `agent ${agentId} not found`);

    // Governance-rejected agents are permanently terminal — never resumable.
    if (h.terminalCause === "governance_rejected") {
      return errorResponse(
        409, "not_resumable",
        `agent ${agentId} terminated by governance rejection (${h.endedReason ?? "gate rejected"}) — not resumable`,
      );
    }

    // Idempotent: always return {resumed:true} if the agent exists and is not
    // governance-rejected. Only trigger actual execution when resumable and
    // not busy.
    const resumable =
      h.status === "awaiting_approval" ||
      h.status === "interrupted" ||
      h.status === "failed" ||
      h.status === "fail_closed";

    if (!h.busy && resumable) {
      this.executeAgent(agentId, "resume").catch((e) => {
        process.stderr.write(`[runtime-server] resume executeAgent error for ${agentId}: ${e}\n`);
      });
    }

    return json({ resumed: true });
  }

  // ----- free-agent conversation (spec 001-agent-freedom) -----

  /** agent 是否存在于 registry 或磁盘。 */
  private async agentExists(agentId: string): Promise<boolean> {
    if (this.registry.has(agentId)) return true;
    try {
      return !!(await loadAgentState(agentId));
    } catch {
      return false;
    }
  }

  /**
   * POST /tasks/:agentId/message — 给自由 Agent 发消息（立即 accepted）。
   *
   * 语义（SSE 切片）：不再阻塞等整轮完成。idle/终态 → 后台启动
   * session.prompt（流式回调 → StreamHub → SSE 推送），立即返回
   * `{accepted:true, status}`；running → session.steer（照旧同步语义）。
   * 轮次结果（reply/错误）经 stream 的 `done`/`status` 事件与 GET 详情
   * 的 audit（free_agent_reply/free_agent_reply_error）可查，旧行为的
   * `{reply}` 字段不再返回（前端已改为流式/轮询渲染，轮询路径不受影响）。
   */
  private async handleSendMessage(agentId: string, req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return errorResponse(400, "bad_request", "invalid JSON body");
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return errorResponse(400, "bad_request", "text is required");

    if (!(await this.agentExists(agentId))) {
      return errorResponse(404, "not_found", `agent ${agentId} not found`);
    }

    const session = await this.getOrCreateSession(agentId);
    if (!session) {
      return errorResponse(503, "capability_unavailable", "failed to assemble free-agent session (model/governance/snapshot)");
    }

    this.recordConversationAudit(agentId, "user_message", text);

    if (session.status() === "running") {
      // 运行中：注入纠偏上下文（下一工具结束后生效），不开新 prompt。
      session.steer(text);
      this.recordConversationAudit(agentId, "free_agent_steer");
      return json({ steered: true, status: session.status() });
    }

    // idle/终态：后台启动整轮，立即返回 accepted。同一 agent 同时只允许
    // 一个 prompt（session.prompt 自身对 running 抛错，这里是双保险）。
    const hub = StreamHub.for(agentId);
    hub.emit({ type: "status", status: "running", ts: new Date().toISOString() });
    const opts = this.streamOptions(agentId);
    void session.prompt(text, opts)
      .then((reply) => {
        this.recordConversationAudit(agentId, "free_agent_reply", reply);
        opts.finalize();
        this.syncHandleFromSession(agentId, session);
        const status = session.status();
        hub.emit({ type: "done", reply, status, ts: new Date().toISOString() });
        hub.emit({ type: "status", status, ts: new Date().toISOString() });
      })
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        this.recordConversationAudit(agentId, "free_agent_reply_error", reason);
        opts.finalize();
        this.syncHandleFromSession(agentId, session);
        const status = session.status();
        hub.emit({ type: "done", reply: `[error] ${reason}`, status, ts: new Date().toISOString() });
        hub.emit({ type: "status", status, ts: new Date().toISOString() });
      });
    this.syncHandleFromSession(agentId, session);
    return json({ accepted: true, status: session.status() });
  }

  /**
   * GET /tasks/:agentId/stream — SSE 事件流（part/delta/status/done + 心跳）。
   *
   * - 事件按 hub 的单调 seq 有序推送，id=seq（EventSource 重连带回
   *   Last-Event-ID 即续传）；
   * - 心跳为 SSE 注释行（`: hb\n\n`），15s 一次防中间层超时；
   * - 会话 idle 时连接保持（等待下一轮），客户端断开即清理订阅；
   * - agent 不存在 → 404（同步 JSON 错误，不进入流）。
   */
  private async handleStream(agentId: string, req: Request): Promise<Response> {
    if (!(await this.agentExists(agentId))) {
      return errorResponse(404, "not_found", `agent ${agentId} not found`);
    }
    const hub = StreamHub.for(agentId);
    const lastEventId = Number(req.headers.get("last-event-id") ?? "");
    const after = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : undefined;
    // `?from=turn`（前端首连用）只回放当前轮次；断线重连带 Last-Event-ID 精确续传。
    const cursor = after !== undefined
      ? hub.subscribe(after)
      : new URL(req.url).searchParams.get("from") === "turn"
        ? hub.subscribeCurrentTurn()
        : hub.subscribe();
    const encoder = new TextEncoder();
    // 5s：必须显著小于任何中间层的 idle 超时（Bun 默认 10s，Cloudflare 100s），
    // 否则静默期（模型推理 8–40 秒无任何 token）连接会被掐断，前端陷入重连
    // 回放循环、流式输出永远渲染不出来。
    const HEARTBEAT_MS = 5_000;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          cursor.stop();
          try { controller.close(); } catch { /* already closed */ }
        };
        req.signal.addEventListener("abort", close);
        const writeEvent = (e: StreamEvent): void => {
          if (closed) return;
          const payload = e.type === "part"
            ? { part: e.part }
            : e.type === "delta"
              ? { partId: e.partId, text: e.text }
              : e.type === "done"
                ? { reply: e.reply, status: e.status, ts: e.ts }
                : e.type === "reset"
                  ? { reason: e.reason }
                  : { status: e.status, ts: e.ts };
          controller.enqueue(encoder.encode(`event: ${e.type}\nid: ${e.seq}\ndata: ${JSON.stringify(payload)}\n\n`));
        };
        // Initial comment so proxies see a body immediately.
        controller.enqueue(encoder.encode(": stream open\n\n"));
        const heartbeat = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(": hb\n\n")); } catch { close(); }
        }, HEARTBEAT_MS);
        try {
          while (!closed) {
            const batch = await cursor.next();
            if (cursor.stopped) break;
            for (const e of batch) writeEvent(e);
          }
        } catch {
          // stream write failure — fall through to close
        } finally {
          clearInterval(heartbeat);
          close();
        }
      },
      cancel() {
        cursor.stop();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /** 流式 prompt 回调 → hub 事件（part 定位用 Map 累计文本）。 */
  private streamOptions(agentId: string): PromptStreamOptions & { finalize: () => void } {
    const hub = StreamHub.for(agentId);
    /** partId → {kind, 累计文本}；轮次结束统一补 done 定稿事件。 */
    const parts = new Map<string, { kind: "text" | "reasoning"; text: string }>();
    /**
     * callId → 工具名/入参。onToolEnd 只带 callId（定稿事件整体替换前一条，
     * 前端沿用已有 part 的 name/args），但落 audit 要写一条自足的记录，
     * 所以在这里把 onToolStart 的 name/args 存着，结束时合并成一条。
     */
    const toolCalls = new Map<string, { name: string; args: string }>();
    const openText = (partId: string, kind: "text" | "reasoning"): void => {
      parts.set(partId, { kind, text: "" });
      hub.emit({
        type: "part",
        part: { kind, id: partId, state: "streaming", text: "", ts: new Date().toISOString() },
      });
    };
    const appendText = (partId: string, text: string): void => {
      const cell = parts.get(partId);
      if (cell) cell.text += text;
      hub.emit({ type: "delta", partId, text });
    };
    return {
      onTextStart: (partId) => openText(partId, "text"),
      onDelta: appendText,
      onReasoningStart: (partId) => openText(partId, "reasoning"),
      onReasoningDelta: appendText,
      onToolStart: (callId, name, args) => {
        toolCalls.set(callId, { name, args });
        hub.emit({
          type: "part",
          part: { kind: "tool", id: callId, state: "running", name, args, result: null, ts: new Date().toISOString() },
        });
      },
      onToolEnd: (callId, ok, result) => {
        hub.emit({
          type: "part",
          part: {
            kind: "tool",
            id: callId,
            state: ok ? "done" : "error",
            // 工具 part 定稿事件整体替换前一条，name/args 由前端沿用已有 part。
            name: "",
            args: "",
            result,
            ts: new Date().toISOString(),
          },
        });
        // 只在结束时落一条 audit（不是 start/end 两条）：轮次进行中刷新页面走的是
        // StreamHub.subscribeCurrentTurn()，它从上一个 done 事件之后重放，running
        // 态的卡片本来就会被 SSE 补回来；audit 只需要负责「本轮结束后还能回看」。
        const started = toolCalls.get(callId);
        toolCalls.delete(callId);
        this.recordConversationAudit(
          agentId,
          "free_agent_tool",
          JSON.stringify({
            id: callId,
            name: started?.name ?? "",
            args: clip(started?.args ?? "", AUDIT_TOOL_ARGS_MAX),
            result: clip(result, AUDIT_TOOL_RESULT_MAX),
          }),
          ok ? "ok" : "failed",
        );
      },
      finalize: () => {
        const ts = new Date().toISOString();
        for (const [id, cell] of parts) {
          hub.emit({ type: "part", part: { kind: cell.kind, id, state: "done", text: cell.text, ts } });
        }
        parts.clear();
        toolCalls.clear();
      },
    };
  }

  /** POST /tasks/:agentId/abort — 终止自由 Agent 会话。 */
  private async handleAbort(agentId: string): Promise<Response> {
    const session = this.sessions.get(agentId);
    if (!session) {
      if (!(await this.agentExists(agentId))) {
        return errorResponse(404, "not_found", `agent ${agentId} not found`);
      }
      return json({ aborted: false, status: null, reason: "no active free-agent session" });
    }
    session.abort("aborted via web");
    this.recordConversationAudit(agentId, "free_agent_abort");
    this.syncHandleFromSession(agentId, session);
    return json({ aborted: true, status: session.status() });
  }

  /**
   * 取或懒装配 FreeAgentSession。agent 已确认存在（调用方先 agentExists）；
   * 装配失败（deps/model/snapshot）→ 返回 null（调用方返 503）。
   */
  private async getOrCreateSession(agentId: string): Promise<FreeAgentSession | null> {
    const existing = this.sessions.get(agentId);
    if (existing) return existing;
    let projectId: string | undefined;
    let part: string | undefined;
    let governance: GovernanceClient | undefined;
    let connector: LoopConnector | null = null;
    let processInstanceId = "pi-default";
    let executionMode: "free" | "engineering" = "engineering";
    let projectType: string | undefined;
    let processVersionId: string | null | undefined;
    let processProfileId: string | null | undefined;
    let processProfileName: string | null | undefined;
    let processProfileVersion: string | null | undefined;
    let snapshotProjectInfo: ProjectInfo | undefined;
    let initialGateLock: { gate: GateId; submissionId: string } | undefined;

    const handle = this.registry.get(agentId);
    if (handle) {
      projectId = handle.projectId;
      part = handle.part;
      governance = handle.governance;
      connector = handle.connector;
      processInstanceId = handle.processInstanceId ?? "pi-default";
      executionMode = handle.executionMode;
      projectType = handle.projectType;
      processVersionId = handle.processVersionId;
      processProfileId = handle.processProfileId;
      processProfileName = handle.processProfileName;
      processProfileVersion = handle.processProfileVersion;
      initialGateLock = executionMode === "engineering" ? handle.currentState?.freeAgentLock : undefined;
    } else {
      let state: AgentState | undefined;
      try {
        state = await loadAgentState(agentId);
      } catch {
        state = undefined;
      }
      if (!state) return null;
      processInstanceId = state.processInstanceId ?? "pi-default";
      executionMode = inferExecutionMode(state);
      projectType = state.projectType;
      processVersionId = state.processVersionId;
      processProfileId = state.processProfileId;
      processProfileName = state.processProfileName;
      processProfileVersion = state.processProfileVersion;
      initialGateLock = executionMode === "engineering" ? state.freeAgentLock : undefined;
      try {
        const deps = await this.depsFactory({
          projectId: state.projectId,
          processInstanceId,
          ...(state.projectType ? { projectType: state.projectType } : {}),
          ...(state.processVersionId ? { processVersionId: state.processVersionId } : {}),
          ...(state.processProfileId ? { processProfileId: state.processProfileId } : {}),
          ...(state.processProfileName ? { processProfileName: state.processProfileName } : {}),
          ...(state.processProfileVersion ? { processProfileVersion: state.processProfileVersion } : {}),
        });
        projectId = state.projectId;
        part = state.part;
        governance = deps.governance;
        connector = deps.connector;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `[runtime-server] free-agent deps build failed for ${agentId}: ${msg}\n`,
        );
        return null;
      }
    }

    if (!projectId || !governance) return null;

    try {
      const coreInfo = await readProjectInfo(governance, projectId);
      const runtime = resolveProjectRuntime({
        requestFacts: {
          ...(projectType ? { projectType: normalizeKnownProjectType(projectType) } : {}),
          ...(processVersionId !== undefined ? { processVersionId } : {}),
          ...(processProfileId !== undefined ? { processProfileId } : {}),
          ...(processProfileName !== undefined ? { processProfileName } : {}),
          ...(processProfileVersion !== undefined ? { processProfileVersion } : {}),
        },
        coreInfo,
        requestedMode: executionMode === "free" ? "agent" : undefined,
        rawProcessInstanceId: processInstanceId,
        projectId,
        requestedPart: part,
        defaultPart: this.config.defaultPart,
      });
      executionMode = runtime.executionMode;
      processInstanceId = runtime.processInstanceId;
      part = runtime.part;
      projectType = runtime.projectType;
      processVersionId = runtime.processVersionId;
      processProfileId = runtime.processProfileId;
      processProfileName = runtime.processProfileName;
      processProfileVersion = runtime.processProfileVersion;
      snapshotProjectInfo = coreInfo ?? undefined;
      initialGateLock = executionMode === "engineering" ? initialGateLock : undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[runtime-server] project runtime config invalid for ${agentId}: ${msg}\n`,
      );
      return null;
    }

    // model：ConversationalModel，用 env SYNTHIA_MODEL_* 构造（依赖 Slice A 使 ModelClient 实现 chat()）。
    let model: ConversationalModel;
    try {
      model = new ModelClient(modelConfigFromEnv(process.env));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[runtime-server] free-agent model unavailable for ${agentId}: ${msg}\n`,
      );
      return null;
    }

    // System prompt = static operating manual + rules, then the live project
    // status snapshot. The manual half never throws (it degrades to whatever it
    // could read); only the snapshot half can fail hard enough to abort session
    // creation, because a session with no project state is not worth starting.
    let systemPrompt: string;
    try {
      const doc = await buildAgentDoc({ mode: executionMode });
      if (doc.problems.length > 0) {
        process.stderr.write(
          `[runtime-server] agent doc partially unavailable for ${agentId}: ${doc.problems.join("; ")}\n`,
        );
      }
      systemPrompt = composeSystemPrompt(
        doc.text,
        await buildContextSnapshot(
          governance,
          projectId,
          snapshotProjectInfo ? { projectInfo: snapshotProjectInfo } : {},
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[runtime-server] context snapshot failed for ${agentId}: ${msg}\n`,
      );
      return null;
    }

    const deps: FreeAgentDeps = {
      model,
      tools: [
        ...await assembleSkillTools(),
        ...(executionMode === "engineering" ? await assembleGateTools() : []),
        assembleVivadoTool(),
        assembleSkillDocTool(),
      ],
      systemPrompt,
      projectId,
      part: part ?? "",
      classification: process.env.SYNTHIA_CLASSIFICATION ?? "internal",
      governance,
      connector,
      processInstanceId,
      ...(initialGateLock ? { initialGateLock } : {}),
      ...(process.env.SYNTHIA_RUNS_DIR ? { agentsDir: process.env.SYNTHIA_RUNS_DIR } : {}),
    };

    const session = createFreeAgentSession(agentId, deps);
    this.sessions.set(agentId, session);
    return session;
  }

  /**
   * 把自由会话的状态回写进 registry handle。
   *
   * 自由 agent 走的是 `POST /message` → `session.prompt()`，全程**不经过**
   * `executeAgent`，而 `h.status` / `h.awaitingGate` 只有 `executeAgent` 和
   * `recover()` 写。结果是自由 agent 在门上停住时，handle 还停在创建时的
   * `idle`、`awaitingGate` 恒 undefined —— GET /tasks 据此序列化，前端就永远
   * 看不到待批的门。会话才是自由 agent 的真相，所以在每个轮次边界把它同步过来。
   *
   * `currentStage` 不动：自由 agent 没有流水线的阶段推进，前端
   * `deriveStageChain` 对 `awaiting_approval + awaiting_gate` 有优先分支，
   * 拿到门就能把阶段条画对，不需要 stage。
   */
  private syncHandleFromSession(agentId: string, session: FreeAgentSession): void {
    const h = this.registry.get(agentId);
    if (!h) return;

    const locked = session.lockedGate;
    if (locked) {
      h.status = "awaiting_approval";
      h.awaitingGate = locked.gate;
      return;
    }

    const s = session.status();
    h.status = s === "completed" ? "succeeded" : s === "cancelled" ? "failed" : s;
    h.awaitingGate = undefined;
  }

  /**
   * 记录对话/接管/终止审计事件，进入 handle.audit（带单调 seq），
   * 供 GET /tasks/:agentId 的 audit 序列返回（web 信息流据此渲染）。
   * agent 无 in-memory handle 时静默跳过（磁盘恢复竞态，罕见）。
   */
  private recordConversationAudit(
    agentId: string,
    action: string,
    detail?: string,
    result?: AuditEvent["result"],
  ): void {
    const handle = this.registry.get(agentId);
    if (!handle) return;
    const seq = handle.audit.reduce((max, e) => (e.seq > max ? e.seq : max), -1) + 1;
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      seq,
      category: "model",
      phase: "loop",
      action,
      ...(detail !== undefined ? { detail } : {}),
      ...(result !== undefined ? { result } : {}),
    };
    handle.audit.push(event);
  }

  // ----- core execution -----

  private async executeAgent(
    agentId: string,
    trigger: "initial" | "resume",
  ): Promise<void> {
    const h = this.registry.get(agentId);
    if (!h) return;
    if (h.busy) return; // concurrent guard

    h.busy = true;

    try {
      const agentState = await loadAgentState(agentId);

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
          await saveAgentState(state);
          h.currentState = state;
          h.currentStage = state.currentStage;
          h.docs = { ...(state.docs ?? {}) };
          if (state.awaitingGate) h.awaitingGate = state.awaitingGate;
        },
        onAwaitingApproval: (gate, submissionId, rid) => {
          process.stderr.write(
            `[runtime-server] agent ${rid} awaiting ${gate} (submission: ${submissionId})\n`,
          );
        },
      });

      h.status = "running";
      h.awaitingGate = undefined;
      h.terminalCause = undefined;

      const isResume =
        trigger === "resume" ||
        (agentState.status === "awaiting_approval" && agentState.awaitingGate);

      const result: LoopResult = isResume
        ? await loop.resume(agentState)
        : await loop.run(h.task, { agentId, agentState });

      this.applyResult(h, result);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      h.status = "failed";
      h.endedReason = reason;
      h.terminalCause = "execution_error";
      process.stderr.write(`[runtime-server] executeAgent failed for ${agentId}: ${reason}\n`);
      await this.persistTerminal(h, "failed", reason, "execution_error").catch(() => {});
    } finally {
      h.busy = false;
    }
  }

  private applyResult(h: AgentHandle, result: LoopResult): void {
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
    h: AgentHandle,
    status: "succeeded" | "failed" | "fail_closed",
    reason?: string,
    cause?: TerminalCause,
  ): Promise<void> {
    if (!h.currentState) return;
    const terminal: AgentState = {
      ...h.currentState,
      status,
      endedReason: reason,
      ...(cause ? { terminalCause: cause } : {}),
      awaitingGate: undefined,
    };
    await saveAgentState(terminal);
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

  private async pollGate(h: AgentHandle): Promise<void> {
    const gate = h.awaitingGate;
    if (!gate) return;
    const submissionId = h.currentState?.gateSubmissions?.[gate];
    if (!submissionId) return;

    const { state } = await h.governance.getGateSubmissionState(submissionId);

    if (state === "approved") {
      process.stderr.write(
        `[runtime-server] gate ${gate} approved for agent ${h.agentId} — auto-resuming\n`,
      );
      this.executeAgent(h.agentId, "resume").catch(() => {});
    } else if (state === "rejected" || state === "withdrawn") {
      process.stderr.write(
        `[runtime-server] gate ${gate} ${state} for agent ${h.agentId} — fail-closed\n`,
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
    const agentIds = await listAgents();
    for (const agentId of agentIds) {
      try {
        const state = await loadAgentState(agentId);
        const wasRunning = state.status === "running";
        const processInstanceId = state.processInstanceId ?? "pi-default";
        const executionMode = inferExecutionMode(state);

        const lookupDeps = await this.depsFactory({
          projectId: state.projectId,
          processInstanceId,
        });
        const runtime = resolveProjectRuntime({
          requestFacts: {
            ...(state.projectType ? { projectType: normalizeKnownProjectType(state.projectType) } : {}),
            ...(state.processVersionId !== undefined ? { processVersionId: state.processVersionId } : {}),
            ...(state.processProfileId !== undefined ? { processProfileId: state.processProfileId } : {}),
            ...(state.processProfileName !== undefined ? { processProfileName: state.processProfileName } : {}),
            ...(state.processProfileVersion !== undefined ? { processProfileVersion: state.processProfileVersion } : {}),
          },
          coreInfo: await readProjectInfo(lookupDeps.governance, state.projectId),
          requestedMode: executionMode === "free" ? "agent" : undefined,
          rawProcessInstanceId: processInstanceId,
          projectId: state.projectId,
          requestedPart: state.part,
          defaultPart: this.config.defaultPart,
        });

        const deps = await this.depsFactory({
          projectId: state.projectId,
          processInstanceId: runtime.processInstanceId,
          ...(runtime.projectType ? { projectType: runtime.projectType } : {}),
          ...(runtime.processVersionId ? { processVersionId: runtime.processVersionId } : {}),
          ...(runtime.processProfileId ? { processProfileId: runtime.processProfileId } : {}),
          ...(runtime.processProfileName ? { processProfileName: runtime.processProfileName } : {}),
          ...(runtime.processProfileVersion ? { processProfileVersion: runtime.processProfileVersion } : {}),
        });

        const handle: AgentHandle = {
          agentId,
          projectId: state.projectId,
          processInstanceId: runtime.processInstanceId,
          task: state.task,
          part: runtime.part,
          createdAt: state.createdAt,
          ...(runtime.projectType ? { projectType: runtime.projectType } : {}),
          ...(runtime.processVersionId !== undefined ? { processVersionId: runtime.processVersionId } : {}),
          ...(runtime.processProfileId !== undefined ? { processProfileId: runtime.processProfileId } : {}),
          ...(runtime.processProfileName !== undefined ? { processProfileName: runtime.processProfileName } : {}),
          ...(runtime.processProfileVersion !== undefined ? { processProfileVersion: runtime.processProfileVersion } : {}),
          executionMode: runtime.executionMode,
          status: wasRunning ? "interrupted" : state.status,
          currentStage: state.currentStage,
          // `?? freeAgentLock.gate` 是为**本次修复之前**落盘的自由 agent 状态兜底：
          // 那些文件只写了 freeAgentLock，没有 awaitingGate，直接读会恢复成
          // 「等待批准但不知道等哪个门」。两个字段本就同源，取任一非空即可。
          awaitingGate: state.awaitingGate ?? state.freeAgentLock?.gate,
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
        this.registry.set(agentId, handle);

        // Persist interrupted agents as "failed" on disk (AgentState has no
        // "interrupted" status; the handle tracks it in-memory).
        if (wasRunning) {
          const updated: AgentState = {
            ...state,
            status: "failed",
            endedReason: "interrupted by server restart",
            terminalCause: "execution_error",
          };
          await saveAgentState(updated);
          handle.currentState = updated;
        }

        process.stderr.write(
          `[runtime-server] recovered agent ${agentId} (status=${handle.status})\n`,
        );
      } catch (e) {
        process.stderr.write(
          `[runtime-server] recovery: failed to load ${agentId}: ${e}\n`,
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

  return async ({ projectId, processInstanceId, projectType, processVersionId, processProfileId }) => {
    if (projectType !== undefined) normalizeKnownProjectType(projectType);
    const frozenProfile = processProfileId ?? processVersionId;
    if (projectType === "free" && frozenProfile) {
      throw new Error("free project cannot carry a process profile");
    }
    if (projectType === "engineering" && !frozenProfile) {
      throw new Error("engineering project is missing its frozen process profile");
    }
    if (frozenProfile && frozenProfile !== "GJB_REF_V1" && frozenProfile !== "LEGACY_COMPAT") {
      throw new Error(`unsupported process profile: ${frozenProfile}`);
    }
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
