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
import type { RunState, GovernanceClient, LoopConnector } from "./types.ts";
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
  FreeAgentSession,
  FreeAgentStatus,
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

class FreeAgentSessionImpl implements FreeAgentSession {
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
    });
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
      this._status = "idle";
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
    };

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
    };
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
      JSON.stringify({ runId: this.runId, status: this._status, messages: this.messages }, null, 2) + "\n",
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
): Promise<{ runId: string; status: FreeAgentStatus; messages: AgentMessage[] } | null> {
  const dir = runsDir ?? dirname(runStatePath(runId));
  const path = join(dir, `${runId}.conversation.json`);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as {
      runId: string;
      status: FreeAgentStatus;
      messages: AgentMessage[];
    };
  } catch {
    return null;
  }
}
