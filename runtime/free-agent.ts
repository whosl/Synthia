/**
 * Synthia Runtime — Free Agent session (spec 001-agent-freedom, Slice A).
 *
 * A self-contained free tool-calling loop built on the existing ModelClient's
 * {@link ConversationalModel.chat} primitive. No pi-agent-core / dsh / Cordis.
 *
 * The session exposes {@link FreeAgentSession.prompt} / {@link FreeAgentSession.steer}
 * / {@link FreeAgentSession.abort} and enforces the GJB three-layer compliance
 * hooks (beforeToolCall permission + whitelist + data-domain, afterToolCall
 * lineage, beforeModelCall data-domain pre-check).
 *
 * State is persisted to `.runs/` each iteration (RunState + conversation
 * sidecar) so that steer/abort/intermediate artifacts survive crashes.
 *
 * GJB red line (non-negotiable): the agent only produces candidates. It must
 * never approve, baseline, publish, write hardware directly, or execute raw
 * Tcl. The default beforeToolCall hook blocks all such operations.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import { saveRunState, createRunState, runStatePath } from "./run-state.ts";
import type { RunState, GovernanceClient, LoopConnector, GateId } from "./types.ts";
import type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  BeforeToolCallHook,
  AfterToolCallHook,
  BeforeModelCallHook,
  ChatTurn,
  ConversationalModel,
  FreeAgentController,
  FreeAgentSession,
  FreeAgentStatus,
  RegisteredArtifactInfo,
  ToolExecContext,
} from "./agent-types.ts";

// ---------------------------------------------------------------------------
// Fixed exported contract (Slice A — do not change the signatures).
// ---------------------------------------------------------------------------

export interface FreeAgentDeps {
  model: ConversationalModel;
  tools: readonly AgentTool[];
  systemPrompt: string;
  projectId: string;
  part: string;
  classification: string;
  governance: GovernanceClient;
  connector: LoopConnector | null;
  /** 流程实例 id（createGateSubmission 入参）；默认 "pi-default"。 */
  readonly processInstanceId?: string;
  /** 会话恢复时的初始门禁锁定（重启后仍锁定）；来自 run-state.freeAgentLock。 */
  readonly initialGateLock?: { readonly gate: GateId; readonly submissionId: string };
  /** Override for the .runs/ directory (defaults to SYNTHIA_RUNS_DIR or built-in). */
  runsDir?: string;
}

export function createFreeAgentSession(runId: string, deps: FreeAgentDeps): FreeAgentSession {
  return new FreeAgentSessionImpl(runId, deps);
}

// ---------------------------------------------------------------------------
// GJB red-line: forbidden tool set.
// ---------------------------------------------------------------------------

/**
 * These operations are human-only. The agent may only produce candidates — it
 * must never approve, baseline, publish, write hardware directly, or execute
 * raw Tcl (which would bypass the Core governance + Connector capability gate).
 * The default {@link defaultBeforeToolCall} hook blocks every call whose name
 * is listed below.
 */
const FORBIDDEN_TOOLS: Readonly<Record<string, true>> = {
  approve: true,
  baseline: true,
  publish: true,
  hardware_write: true,
  execute_tcl: true,
};

// ---------------------------------------------------------------------------
// Default compliance hooks.
// ---------------------------------------------------------------------------

/**
 * Layer 1 — beforeToolCall: permission / whitelist / data-domain gate.
 *
 * Default enforcement blocks the GJB-protected operations (approve / baseline /
 * publish / hardware_write / execute_tcl). Data-domain and capability-whitelist
 * logic lives primarily inside the tool implementations (which have access to
 * the Connector); this hook is the session-level hard stop for red-line tools.
 */
function defaultBeforeToolCall(
  call: AgentToolCall,
  _ctx: ToolExecContext,
): { block: true; reason: string } | undefined {
  if (FORBIDDEN_TOOLS[call.name]) {
    return {
      block: true,
      reason:
        `工具 "${call.name}" 是 GJB 受保护操作（仅限人工）。` +
        `Agent 只产 candidate，永不 approve/baseline/publish/hardware_write/execute_tcl。`,
    };
  }
  return undefined;
}

/**
 * Layer 2 — afterToolCall: lineage / evidence write-back seam.
 *
 * Tools register candidate artifacts via `ctx.governance.registerCandidateArtifact`
 * themselves (they own the artifactType / content / contentLocation). This hook
 * is the session-level audit point. The default implementation is a no-op; the
 * server layer (Slice D) or a governance-aware tool wires real evidence here.
 */
function defaultAfterToolCall(
  _call: AgentToolCall,
  _result: AgentToolResult,
  _ctx: ToolExecContext,
): void {
  // No-op by default. Real lineage is tool-driven via ctx.governance.
}

/**
 * Layer 3 — beforeModelCall: data-domain pre-check on the outgoing messages.
 *
 * Returns `{ stop: true, reason }` to halt the loop before a model call that
 * would violate the data-domain contract. The default allows all calls; a
 * governance-aware deployment injects domain classification logic here.
 */
function defaultBeforeModelCall(
  _messages: readonly AgentMessage[],
): { stop: true; reason: string } | undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the session is aborted via {@link FreeAgentSession.abort}. */
export class FreeAgentAbortedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`free agent aborted: ${reason}`);
    this.name = "FreeAgentAbortedError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Session implementation
// ---------------------------------------------------------------------------

/** Safety bound: a single prompt() may not spin more tool rounds than this. */
const MAX_TOOL_ROUNDS = 50;

// ---------------------------------------------------------------------------
// 声称-记录一致性核查（防呆 2）
// ---------------------------------------------------------------------------
//
// 用户裁定：绝不把「模型声称 X + 系统记录显示非 X」并排展示给用户。
// 模型纯文本回复中出现完成性声明（仿真通过/成功/PASS 等）时，核查本会话
// 是否存在 succeeded 的 simulate 工具记录；无记录则拦截该回复，以工具结果
// 形态回灌核查结论，让模型重新生成（最多 2 次重试），超限发系统兜底文案。

/** 单次 prompt() 内完成声明被拦截后的最大重试次数（共 3 次文本尝试）。 */
const MAX_CLAIM_RETRIES = 2;

/**
 * 完成性声明模式（中英文）。宁漏勿滥：只拦高置信的「仿真已通过」类表述，
 * 「正在仿真」「计划仿真」等过程性表述不在此列。
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /仿真[^。\n]{0,10}(?:通过|成功|PASS\b)/i,
  /已(?:完成|通过|验证)[^。\n]{0,6}仿真/,
  /simulation[^.\n]{0,60}?(?:passed|succeeded)/i,
  /(?:passed|succeeded)[^.\n]{0,40}?simulation/i,
  /(?:state|status|状态|结果)\s*[=:：]?\s*(?:succeeded|PASS)\b/i,
];

/** 否定守卫：匹配窗口内出现这些词视为否定/失败表述，不算完成声明。 */
const CLAIM_NEGATION_RE = /未|没有|没|尚|暂|无法|不|not\s|fail/i;

/** 一条 claim-check 审计记录（持久化进 conversation sidecar）。 */
export interface ClaimCheckRecord {
  /** ISO 时间戳。 */
  readonly at: string;
  /** 命中的声明片段（截断到 80 字符）。 */
  readonly claim: string;
  /** 是否存在 succeeded 的 simulate 工具记录。 */
  readonly supported: boolean;
  /** 处置：放行 / 拦截重试 / 拦截后超限兜底。 */
  readonly disposition: "passed" | "intercepted_retry" | "intercepted_fallback";
  /** 本次 prompt() 内第几次文本尝试（1 起）。 */
  readonly attempt: number;
}

/**
 * 检测文本是否含高置信完成性声明（带否定守卫）。导出供单测直接使用。
 * 返回命中的声明片段，未命中（或仅否定表述）返回 null。
 */
export function matchCompletionClaim(text: string): string | null {
  for (const re of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    // 否定守卫窗口：匹配片段向前扩 12 字符，覆盖「仿真尚未通过」「not passed」。
    const windowStart = Math.max(0, m.index - 12);
    const window = text.slice(windowStart, m.index + m[0].length);
    if (CLAIM_NEGATION_RE.test(window)) continue;
    return m[0].slice(0, 80);
  }
  return null;
}

/** 拦截时回灌给模型的工具结果文案。 */
const CLAIM_CHECK_FEEDBACK =
  "系统核查：你的回复声称仿真通过，但本会话没有 succeeded 的 simulate 记录。" +
  "请实际调用 vivado_run 运行仿真（operation=\"simulate\"），或修改你的表述为未验证。";

/** 重试超限后的系统兜底文案（系统消息，非模型的话）。 */
const CLAIM_CHECK_FALLBACK =
  "[系统] 上述完成声明未经工具记录支撑，已拦截。请要求 Agent 实际运行仿真。";

class FreeAgentSessionImpl implements FreeAgentSession, FreeAgentController {
  readonly runId: string;
  readonly projectId: string;

  private readonly deps: FreeAgentDeps;
  private readonly toolMap: ReadonlyMap<string, AgentTool>;
  private readonly messages: AgentMessage[] = [];

  private _status: FreeAgentStatus = "idle";
  private abortFlag = false;
  private abortReason: string | undefined;
  private readonly pendingSteer: string[] = [];

  /** Three-layer compliance hooks (wired to defaults; overridable by server). */
  private readonly beforeToolCallHook: BeforeToolCallHook;
  private readonly afterToolCallHook: AfterToolCallHook;
  private readonly beforeModelCallHook: BeforeModelCallHook;

  /** Managed RunState for .runs/ persistence. */
  private runState: RunState;

  /** Gate-lock state (awaiting human approval). Persisted into run-state. */
  private lockGate: GateId | undefined;
  private lockSubmissionId: string | undefined;
  /** Artifact registry: revisionId → info (for content-conformity pre-check). */
  private readonly artifactsById = new Map<string, RegisteredArtifactInfo>();
  private readonly artifactList: RegisteredArtifactInfo[] = [];
  /** Snapshot registry: snapshotId → member revision ids (for conformity). */

  private readonly snapshotsById = new Map<string, readonly string[]>();

  /** claim-check 审计记录（防呆 2；持久化进 conversation sidecar）。 */
  private readonly claimChecks: ClaimCheckRecord[] = [];

  constructor(runId: string, deps: FreeAgentDeps) {
    this.runId = runId;
    this.projectId = deps.projectId;
    this.deps = deps;

    this.toolMap = new Map(deps.tools.map(t => [t.name, t]));

    this.beforeToolCallHook = defaultBeforeToolCall;
    this.afterToolCallHook = defaultAfterToolCall;
    this.beforeModelCallHook = defaultBeforeModelCall;

    // Seed conversation with the system prompt.
    this.messages.push({ role: "system", content: deps.systemPrompt });

    this.runState = createRunState({
      runId,
      task: "free-agent session",
      part: deps.part,
      projectId: deps.projectId,
      ...(deps.processInstanceId ? { processInstanceId: deps.processInstanceId } : {}),
    });

    // Restore an awaiting-approval lock from a prior (crashed/restarted) session.
    if (deps.initialGateLock) {
      this.lockGate = deps.initialGateLock.gate;
      this.lockSubmissionId = deps.initialGateLock.submissionId;
      this._status = "awaiting_approval";
    }
  }

  status(): FreeAgentStatus {
    return this._status;
  }

  async prompt(text: string): Promise<string> {
    if (this._status === "running") {
      throw new Error("free-agent: a prompt is already in progress");
    }

    // Reset abort for this prompt round.
    this.abortFlag = false;
    this.abortReason = undefined;
    this._status = "running";

    // Append the user message.
    this.messages.push({ role: "user", content: text });

    // Update the persisted task to the latest prompt for resume clarity.
    this.runState = { ...this.runState, task: text };
    await this.persist();

    try {
      const reply = await this.runLoop();
      // Preserve the awaiting-approval lock: a locked session stays locked
      // across prompt boundaries (only core_check_gate approved unlocks it).
      this._status = this.isGateLocked() ? "awaiting_approval" : "idle";
      await this.persist();
      return reply;
    } catch (e) {
      if (e instanceof FreeAgentAbortedError) {
        this._status = "cancelled";
      } else {
        this._status = "failed";
        if (e instanceof Error) this.abortReason = e.message;
      }
      await this.persist();
      throw e;
    }
  }

  steer(text: string): void {
    // Queue for injection after the next tool round (does not start a new prompt).
    this.pendingSteer.push(text);
  }

  abort(reason?: string): void {
    this.abortFlag = true;
    this.abortReason = reason ?? "aborted by caller";
  }

  // ----- core loop -----

  /**
   * chat → (tool_calls? execute each →回填) → chat, until the model returns a
   * plain-text reply. Aborts and steer-injections are checked at every tool
   * boundary. Bounded by {@link MAX_TOOL_ROUNDS}.
   */
  private async runLoop(): Promise<string> {
    // 防呆 2：本 prompt() 内完成声明被拦截的次数（重试上限 MAX_CLAIM_RETRIES）。
    let claimRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.checkAbort();

      // Layer 3: beforeModelCall data-domain pre-check.
      const stop = this.beforeModelCallHook(this.messages);
      if (stop?.stop) {
        // Halt the loop — surface the reason as the reply.
        return `[系统] 模型调用被数据域预检阻止: ${stop.reason}`;
      }

      // Call the model with the full conversation + tool catalog.
      const turn: ChatTurn = await this.deps.model.chat(this.messages, this.deps.tools);

      if (turn.kind === "text") {
        // 防呆 2：声称-记录一致性核查。绝不把「模型声称仿真通过 + 无 succeeded
        // 记录」并排展示给用户：拦截 → 回灌核查结论 → 模型重新生成。
        const claim = matchCompletionClaim(turn.content);
        if (claim && !this.hasSucceededSimulateRecord()) {
          const attemptNo = claimRetries + 1;
          if (claimRetries < MAX_CLAIM_RETRIES) {
            claimRetries++;
            this.claimChecks.push({
              at: new Date().toISOString(),
              claim,
              supported: false,
              disposition: "intercepted_retry",
              attempt: attemptNo,
            });
            // 不推送被拦截的 assistant 文本；以「assistant tool_call + 工具结果」
            // 形态回灌，保持 tool 消息必须跟在 tool_calls 之后的消息序列不变式。
            const toolCallId = `claim_check_${attemptNo}`;
            this.messages.push({
              role: "assistant",
              content: null,
              toolCalls: [{ toolCallId, name: "claim_check", args: {} }],
            });
            this.messages.push({
              role: "tool",
              toolCallId,
              name: "claim_check",
              content: JSON.stringify({
                error: "claim_check_failed",
                reason: CLAIM_CHECK_FEEDBACK,
              }),
              isError: true,
            });
            await this.persist();
            continue; // 下一轮：模型看到核查结果后重新生成回复。
          }
          // 重试超限：发系统兜底文案（系统消息，非模型的话，不算自相矛盾）。
          this.claimChecks.push({
            at: new Date().toISOString(),
            claim,
            supported: false,
            disposition: "intercepted_fallback",
            attempt: attemptNo,
          });
          this.messages.push({ role: "system", content: CLAIM_CHECK_FALLBACK });
          await this.persist();
          return CLAIM_CHECK_FALLBACK;
        }
        if (claim) {
          this.claimChecks.push({
            at: new Date().toISOString(),
            claim,
            supported: true,
            disposition: "passed",
            attempt: claimRetries + 1,
          });
        }

        // Model converged to a plain-text reply — turn complete.
        this.messages.push({ role: "assistant", content: turn.content });
        await this.persist();
        return turn.content;
      }

      // turn.kind === "tool_calls": record the assistant turn, then execute.
      this.messages.push({
        role: "assistant",
        content: turn.content,
        toolCalls: turn.calls,
      });
      await this.persist();

      // Execute every tool call in order (sequential — order matters for lineage).
      for (const call of turn.calls) {
        this.checkAbort();

        const result = await this.executeToolCall(call);

        this.messages.push({
          role: "tool",
          toolCallId: call.toolCallId,
          name: call.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
        await this.persist();

        // Inject queued steer after each tool round completes.
        if (this.pendingSteer.length > 0) {
          const steers = this.pendingSteer.splice(0);
          this.messages.push({
            role: "user",
            content: `[接管/纠偏] ${steers.join("\n")}`,
          });
          await this.persist();
        }
      }
      // Loop back: the next model call sees the tool results.
    }

    // Safety valve: the model kept calling tools without converging.
    throw new Error(
      `free-agent: exceeded ${MAX_TOOL_ROUNDS} tool rounds without a text reply — possible infinite loop`,
    );
  }

  /**
   * 防呆 2 支持性核查：本会话是否存在 succeeded 的 simulate 工具记录。
   * 扫描消息历史中 role=tool 且 name=vivado_run 的结果，解析 JSON 后判定
   * state=succeeded 且（operation=simulate 或 phase 含 simulate）；错误结果
   * （isError）不算。
   */
  private hasSucceededSimulateRecord(): boolean {
    for (const m of this.messages) {
      if (m.role !== "tool" || m.name !== "vivado_run" || m.isError) continue;
      try {
        const parsed = JSON.parse(m.content) as {
          state?: unknown;
          operation?: unknown;
          failureDiagnostics?: { phase?: unknown };
        };
        if (parsed.state !== "succeeded") continue;
        const phase = typeof parsed.failureDiagnostics?.phase === "string" ? parsed.failureDiagnostics.phase : "";
        if (parsed.operation === "simulate" || phase.includes("simulate")) return true;
      } catch {
        // 非 JSON 工具结果不参与判定。
      }
    }
    return false;
  }

  /**
   * Execute a single tool call through the three-layer hooks.
   * Returns an error-shaped result on block / unknown tool / execution failure
   * so the model can self-correct.
   */
  private async executeToolCall(call: AgentToolCall): Promise<AgentToolResult> {
    const ctx: ToolExecContext = {
      projectId: this.deps.projectId,
      governance: this.deps.governance,
      connector: this.deps.connector,
      part: this.deps.part,
      classification: this.deps.classification,
      freeAgent: this,
    };

    // Layer 0 — gate-lock hard block (system-level, NOT a prompt request).
    // While awaiting human approval, every tool except core_check_gate is
    // rejected at the execution layer. core_check_gate is the only escape:
    // approved → unlockGate; rejected/withdrawn → stays locked.
    if (this.isGateLocked() && call.name !== "core_check_gate") {
      return {
        content: JSON.stringify({
          error: "gate_locked",
          gate: this.lockGate,
          submissionId: this.lockSubmissionId,
          reason:
            `会话处于「等待批准」状态（门禁 ${this.lockGate ?? "?"}，提交 ${this.lockSubmissionId ?? "?"}）。` +
            `在人工批准前，除 core_check_gate 轮询与纯对话外，一切 skill/vivado 工具调用被系统硬拦。` +
            `请调用 core_check_gate(submission_id="${this.lockSubmissionId ?? ""}") 查询状态；approved 后自动解锁。`,
        }),
        isError: true,
      };
    }

    // Layer 1: beforeToolCall — permission / whitelist / data-domain.
    const block = this.beforeToolCallHook(call, ctx);
    if (block?.block) {
      return { content: JSON.stringify({ error: "blocked", reason: block.reason }), isError: true };
    }

    // Resolve the tool.
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      return {
        content: JSON.stringify({ error: "unknown_tool", reason: `no available tool named "${call.name}"` }),
        isError: true,
      };
    }

    // Execute (tool owns fail-closed / governance / connector logic).
    let result: AgentToolResult;
    try {
      result = await tool.execute(call.args, ctx);
    } catch (e) {
      result = {
        content: JSON.stringify({ error: "execution_failed", reason: e instanceof Error ? e.message : String(e) }),
        isError: true,
      };
    }

    // Layer 2: afterToolCall — lineage / evidence write-back.
    try {
      await this.afterToolCallHook(call, result, ctx);
    } catch {
      // Hook failure must not crash the loop; the tool result is still valid.
    }

    return result;
  }

  // ----- FreeAgentController: gate lock + registries -----

  isGateLocked(): boolean {
    return this.lockGate !== undefined;
  }

  get lockedGate(): { readonly gate: GateId; readonly submissionId: string } | undefined {
    return this.lockGate !== undefined && this.lockSubmissionId !== undefined
      ? { gate: this.lockGate, submissionId: this.lockSubmissionId }
      : undefined;
  }

  get processInstanceId(): string {
    return this.deps.processInstanceId ?? "pi-default";
  }

  get artifacts(): readonly RegisteredArtifactInfo[] {
    return this.artifactList;
  }

  lockForGate(gate: GateId, submissionId: string): void {
    this.lockGate = gate;
    this.lockSubmissionId = submissionId;
    // Reflect into session status immediately; persistence happens on next persist().
    if (this._status === "idle" || this._status === "running") {
      this._status = "awaiting_approval";
    }
  }

  unlockGate(): void {
    this.lockGate = undefined;
    this.lockSubmissionId = undefined;
    if (this._status === "awaiting_approval") {
      this._status = "idle";
    }
  }

  recordArtifact(info: RegisteredArtifactInfo): void {
    if (!this.artifactsById.has(info.revisionId)) {
      this.artifactList.push(info);
    }
    this.artifactsById.set(info.revisionId, info);
  }

  recordSnapshot(snapshotId: string, memberRevisionIds: readonly string[]): void {
    this.snapshotsById.set(snapshotId, [...memberRevisionIds]);
  }

  getSnapshotMembers(snapshotId: string): readonly string[] | undefined {
    return this.snapshotsById.get(snapshotId);
  }

  getArtifact(revisionId: string): RegisteredArtifactInfo | undefined {
    return this.artifactsById.get(revisionId);
  }

  // ----- abort -----

  private checkAbort(): void {
    if (this.abortFlag) {
      throw new FreeAgentAbortedError(this.abortReason ?? "aborted");
    }
  }

  // ----- persistence -----

  /** Persist RunState (status) + conversation sidecar to .runs/. */
  private async persist(): Promise<void> {
    const status = this.mapStatus();
    const endedReason =
      this._status === "cancelled" || this._status === "failed"
        ? this.abortReason ?? this._status
        : undefined;

    this.runState = {
      ...this.runState,
      updatedAt: new Date().toISOString(),
      status,
      ...(endedReason ? { endedReason } : {}),
      ...(this.lockGate !== undefined && this.lockSubmissionId !== undefined
        ? { freeAgentLock: { gate: this.lockGate, submissionId: this.lockSubmissionId } }
        : { freeAgentLock: undefined }),
    };
    // saveRunState serializes with JSON.stringify; an explicit undefined field
    // is dropped, clearing any previously-persisted lock on unlock.
    await saveRunState(this.runState);

    // Conversation sidecar: full message history for crash recovery.
    await this.persistConversation();
  }

  private async persistConversation(): Promise<void> {
    const dir = this.deps.runsDir ?? dirname(runStatePath(this.runId));
    const path = join(dir, `${this.runId}.conversation.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          runId: this.runId,
          status: this._status,
          messages: this.messages,
          // 防呆 2：claim-check 审计记录（无记录时省略，保持 sidecar 向后兼容）。
          ...(this.claimChecks.length > 0 ? { claimChecks: this.claimChecks } : {}),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  /** Map FreeAgentStatus → RunState status (pipeline-oriented but reused). */
  private mapStatus(): RunState["status"] {
    switch (this._status) {
      case "running":
      case "idle":
        return "running";
      case "awaiting_approval":
        return "awaiting_approval";
      case "completed":
        return "succeeded";
      case "cancelled":
      case "failed":
        return "failed";
    }
  }
}

// ---------------------------------------------------------------------------
// Crash recovery: load a persisted conversation for resume.
// ---------------------------------------------------------------------------

/**
 * Load a persisted free-agent conversation snapshot from `.runs/`.
 * Returns `null` if no sidecar exists (e.g. fresh session).
 *
 * Used by the server layer to restore message history after a crash so that a
 * resumed session continues with full context.
 */
export async function loadFreeAgentConversation(
  runId: string,
  runsDir?: string,
): Promise<LoadedFreeAgentConversation | null> {
  const dir = runsDir ?? dirname(runStatePath(runId));
  const path = join(dir, `${runId}.conversation.json`);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as LoadedFreeAgentConversation;
  } catch {
    return null;
  }
}

/** 崩溃恢复快照：消息历史 + 防呆 2 的 claim-check 审计记录。 */
export interface LoadedFreeAgentConversation {
  readonly runId: string;
  readonly status: FreeAgentStatus;
  readonly messages: AgentMessage[];
  /** claim-check 审计记录（无命中时缺失；向后兼容旧 sidecar）。 */
  readonly claimChecks?: readonly ClaimCheckRecord[];
}
