/**
 * Synthia Runtime — OpenAI-compatible model client.
 *
 * Implements {@link LoopModel} against an internal vLLM endpoint
 * (deepseek-v4-flash). Two action protocols:
 *
 *  - "tools" (primary): the model is given a single function tool per phase and
 *    returns structured arguments via `tool_calls`. Probe confirmed this is
 *    supported by the endpoint.
 *  - "json" (fallback): the model emits a strict JSON object (response_format
 *    json_object) which is parsed and validated.
 *
 * In both modes the raw model output is run through a strict validator; on a
 * validation failure the request is retried once with a corrective instruction.
 *
 * Credentials are read ONLY from the environment and never logged. The
 * Authorization header carries the bearer key; no other path touches it.
 */

import { ModelActionError } from "./types.ts";
import type { ArtifactFile, LoopModel, LoopPhase, LoopAction, RtlGeneration, TbGeneration, XdcGeneration, RepairGeneration, DocGeneration, UpstreamArtifacts } from "./types.ts";
import type { ConversationalModel, ChatTurn, AgentMessage, AgentTool, AgentToolCall } from "./agent-types.ts";

export type ActionProtocol = "tools" | "json";

export interface ModelClientConfig {
  /** Base URL, e.g. http://172.16.0.3:4000/v1 (no trailing slash). */
  readonly baseUrl: string;
  /** Bearer key; sourced from env, never logged. */
  readonly apiKey: string;
  readonly model: string;
  readonly protocol: ActionProtocol;
  /** Per-request timeout (cold start can exceed 30s). Default 120000ms. */
  readonly timeoutMs?: number;
  /** Extra attempts after the first malformed response. Default 1. */
  readonly maxParseRetries?: number;
  /** Network/timeout retries. Default 2. */
  readonly networkRetries?: number;
  /** Max output tokens for tool phases (RTL/TB/XDC/repair). Default 4096. */
  readonly toolMaxTokens?: number;
  /** Max output tokens for doc phases (intake/behavior/architecture/register). Default 8192. */
  readonly docMaxTokens?: number;
  /** When true, log raw response summaries to stderr (no secrets). */
  readonly debug?: boolean;
  /** Injectable for tests. */
  readonly post?: ChatPoster;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Low-level poster abstraction (tests inject a canned responder). */
export interface ChatPoster {
  (input: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<ChatCompletionResponse>;
}

export interface ChatCompletionResponse {
  readonly status: number;
  readonly json?: unknown;
  readonly text: string;
}

export interface ActionRequest {
  readonly phase: LoopPhase;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly actionName: string;
  readonly actionDescription: string;
  readonly schema: Record<string, unknown>;
}

export interface EmitOutcome {
  readonly action: LoopAction;
  readonly attempts: number;
  readonly protocol: ActionProtocol;
  /** Recorded reasons for invalid responses (feedback injected into retries). */
  readonly validationFeedbacks?: readonly string[];
}

export type ActionValidator = (raw: unknown) => LoopAction;

// ---------------------------------------------------------------------------
// env wiring
// ---------------------------------------------------------------------------

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelClientConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v || !v.trim()) throw new Error(`model-client: ${k} is required in the environment`);
    return v.trim();
  };
  const protocol: ActionProtocol = (env.SYNTHIA_MODEL_PROTOCOL ?? "tools") === "json" ? "json" : "tools";
  const timeoutMs = env.SYNTHIA_MODEL_TIMEOUT_MS ? Number(env.SYNTHIA_MODEL_TIMEOUT_MS) : 120_000;
  return {
    baseUrl: required("SYNTHIA_MODEL_URL").replace(/\/+$/, ""),
    apiKey: required("SYNTHIA_MODEL_KEY"),
    model: required("SYNTHIA_MODEL_NAME"),
    protocol,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
    maxParseRetries: env.SYNTHIA_MODEL_PARSE_RETRIES ? Number(env.SYNTHIA_MODEL_PARSE_RETRIES) : 1,
    networkRetries: env.SYNTHIA_MODEL_NETWORK_RETRIES ? Number(env.SYNTHIA_MODEL_NETWORK_RETRIES) : 2,
    toolMaxTokens: env.SYNTHIA_MODEL_TOOL_MAX_TOKENS ? Number(env.SYNTHIA_MODEL_TOOL_MAX_TOKENS) : 4096,
    docMaxTokens: env.SYNTHIA_MODEL_DOC_MAX_TOKENS ? Number(env.SYNTHIA_MODEL_DOC_MAX_TOKENS) : 8192,
    debug: env.SYNTHIA_MODEL_DEBUG === "1" || env.SYNTHIA_MODEL_DEBUG === "true",
  };
}

// ---------------------------------------------------------------------------
// default poster: native fetch, no proxy, abortable timeout
// ---------------------------------------------------------------------------

const defaultPost: ChatPoster = async ({ url, headers, body, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
};

function extractArguments(json: unknown, protocol: ActionProtocol): { ok: true; value: unknown } | { ok: false; reason: string } {
  interface ToolCallFn { function?: { arguments?: unknown } }
  interface Msg { content?: string; tool_calls?: ToolCallFn[] }
  const choices = (json as { choices?: Array<{ message?: Msg }> } | undefined)?.choices;
  const msg = choices?.[0]?.message;
  if (!msg) return { ok: false, reason: "response has no message" };
  if (protocol === "tools") {
    const call = msg.tool_calls?.[0]?.function?.arguments;
    if (call === undefined) return { ok: false, reason: "no tool_calls in response" };
    if (typeof call === "string") {
      try { return { ok: true, value: JSON.parse(call) }; } catch { return { ok: false, reason: "tool arguments are not valid JSON" }; }
    }
    return { ok: true, value: call };
  }
  const content = msg.content;
  if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "empty content" };
  try { return { ok: true, value: JSON.parse(content) }; } catch { return { ok: false, reason: "content is not valid JSON" }; }
}

/** Default doc_path for each doc phase, used when the model puts raw markdown
 *  in message.content without a structured tool call. */
const DOC_DEFAULT_PATH: Record<string, string> = {
  generate_intake: "doc/intake/summary.md",
  generate_behavior_wave: "doc/spec/behavior_spec.md",
  generate_architecture: "doc/arch/module_partition.md",
  generate_register_spec: "doc/reg/register_map.md",
};

/**
 * Salvage a doc-generation action from message.content when the model didn't
 * use tool_calls. Tries: (1) JSON object in content, (2) raw markdown wrapped
 * into the expected doc shape. Returns null if nothing usable.
 * The result still goes through the strict validator, so validation semantics
 * (.md path, heading structure, no bare path hallucination) are preserved.
 */
function salvageDocFromContent(json: unknown, phase: string): unknown | null {
  const choices = (json as { choices?: Array<{ message?: { content?: string } }> } | undefined)?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  // Try JSON parse first — model may have put the full object in content.
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* not JSON, try raw markdown */ }
  // Raw markdown fallback: wrap into the expected doc shape.
  const docPath = DOC_DEFAULT_PATH[phase] ?? "doc/output.md";
  return { reasoning: `salvaged from message.content`, doc_path: docPath, content };
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function backoffMs(attempt: number): number { return Math.min(8000, 250 * 2 ** (attempt - 1)); }

/**
 * Convert an {@link AgentMessage} to the OpenAI wire format. The tool role
 * carries toolCallId/name; the assistant role may carry toolCalls; system/user
 * pass straight through. Roles other than "tool"/"assistant" default to their
 * declared role.
 */
function toWireMessage(m: AgentMessage): Record<string, unknown> {
  if (m.role === "assistant") {
    const out: Record<string, unknown> = { role: "assistant", content: m.content ?? null };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map(c => ({
        id: c.toolCallId,
        type: "function",
        function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}) },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
  }
  return { role: m.role, content: m.content };
}

/**
 * Parse a chat-completion response into a {@link ChatTurn}. Fault-tolerant:
 * a tool_call whose `arguments` is not valid JSON is still surfaced (args set
 * to the raw string so the loop can feed an error back to the model) rather
 * than throwing. Returns a text turn when there are no usable tool_calls.
 */
function parseChatTurn(json: unknown): ChatTurn {
  interface WireToolCall { id?: string; function?: { name?: string; arguments?: unknown } }
  interface WireMessage { content?: string | null; tool_calls?: WireToolCall[] }
  const choices = (json as { choices?: Array<{ message?: WireMessage }> } | undefined)?.choices;
  const msg = choices?.[0]?.message;
  const content = msg?.content ?? null;
  const wireCalls = msg?.tool_calls;
  if (wireCalls && wireCalls.length > 0) {
    const calls: AgentToolCall[] = wireCalls.map((c, i) => {
      const rawArgs = c.function?.arguments;
      let args: unknown;
      if (typeof rawArgs === "string") {
        try { args = JSON.parse(rawArgs); } catch { args = rawArgs; }
      } else if (rawArgs === undefined || rawArgs === null) {
        args = {};
      } else {
        args = rawArgs;
      }
      return {
        toolCallId: c.id ?? `call_${i}`,
        name: c.function?.name ?? "",
        args,
      };
    });
    return { kind: "tool_calls", calls, content };
  }
  // No tool calls → treat as a text turn. Fall back to empty string if both
  // content and tool_calls are absent (malformed but non-throwing).
  return { kind: "text", content: typeof content === "string" ? content : "" };
}

/**
 * Render upstream artifacts into a dedicated, strongly-delimited prompt section
 * with explicit consistency instructions. Returns "" when no upstream is given.
 * The section is placed ahead of the task body so the model treats upstream
 * facts as binding constraints, not optional context.
 */
export function renderUpstream(upstream?: UpstreamArtifacts): string {
  if (!upstream || upstream.length === 0) return "";
  const blocks = upstream.map(s => `### ${s.label}\n\n${s.content}`).join("\n\n");
  return [
    "===== 上游产物 (Upstream Artifacts) — 一致性约束（必须遵守）=====",
    "以下上游产物已确认。本次输出必须与上游保持严格一致：",
    "- 模块名、顶层端口名、参数名不得偏离上游定义；",
    "- 需求/规则编号须可追溯到上游；",
    "- 不得臆造与上游冲突的硬件事实（时钟、复位、寄存器偏移、引脚等）；",
    "- 若上游缺失某信息，须显式标注为假设（assumption），不得静默编造。",
    "",
    blocks,
    "===== 上游产物结束 =====",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ModelClient
// ---------------------------------------------------------------------------

export class ModelClient implements LoopModel, ConversationalModel {
  private readonly cfg: ModelClientConfig;
  private readonly post: ChatPoster;

  constructor(config: ModelClientConfig) {
    this.cfg = config;
    this.post = config.post ?? defaultPost;
  }

  /** Low-level structured-action emission used by every phase method. */
  async emitAction(req: ActionRequest, validate: ActionValidator): Promise<EmitOutcome> {
    const maxParse = Math.max(0, this.cfg.maxParseRetries ?? 1);
    const maxNetwork = Math.max(0, this.cfg.networkRetries ?? 2);
    const feedbacks: string[] = [];
    let lastReason = "no attempt made";
    let attempt = 0;
    for (let parseRound = 0; parseRound <= maxParse; parseRound++) {
      attempt = parseRound + 1;
      const messages = this.buildMessages(req, parseRound > 0 ? lastReason : undefined);
      let response: ChatCompletionResponse;
      let netAttempt = 0;
      while (true) {
        try {
          response = await this.post(this.buildRequest(req, messages));
          break;
        } catch (e) {
          netAttempt++;
          if (netAttempt > maxNetwork) throw e;
          lastReason = `network error: ${e instanceof Error ? e.message : String(e)}`;
          await sleep(backoffMs(netAttempt));
        }
      }
      if (response.status < 200 || response.status >= 300) {
        lastReason = `HTTP ${response.status}`;
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new Error(`model-client: upstream returned ${response.status}`);
        }
        continue;
      }

      // Debug: log raw response summary (no secrets, no full content).
      if (this.cfg.debug) this.debugResponse(req.phase, response.json, parseRound);

      // Standard extraction: tool_calls (tools protocol) or JSON content (json protocol).
      const extracted = extractArguments(response.json, this.cfg.protocol);
      if (extracted.ok) {
        try {
          const action = validate(extracted.value);
          return { action, attempts: attempt, protocol: this.cfg.protocol, ...(feedbacks.length ? { validationFeedbacks: [...feedbacks] } : {}) };
        } catch (e) {
          lastReason = e instanceof Error ? e.message : String(e);
          feedbacks.push(lastReason);
          continue;
        }
      }

      // Fallback for doc phases: model may have put the document in message.content
      // instead of tool_calls (common with large outputs). Try to salvage.
      if (DOC_PHASES.has(req.phase)) {
        const salvaged = salvageDocFromContent(response.json, req.phase);
        if (salvaged) {
          if (this.cfg.debug) process.stderr.write(`[model-debug] ${req.phase}: salvaged from message.content (attempt ${attempt})\n`);
          try {
            const action = validate(salvaged);
            return { action, attempts: attempt, protocol: this.cfg.protocol, ...(feedbacks.length ? { validationFeedbacks: [...feedbacks] } : {}) };
          } catch (e) {
            lastReason = `content salvage failed validation: ${e instanceof Error ? e.message : String(e)}`;
            feedbacks.push(lastReason);
            continue;
          }
        }
      }

      lastReason = extracted.reason;
    }
    const e = new ModelActionError(
      `model produced no valid action for phase ${req.phase}: ${lastReason}`,
      req.phase,
      attempt,
    );
    (e as ModelActionError & { validationFeedbacks?: readonly string[] }).validationFeedbacks = feedbacks.length ? [...feedbacks] : undefined;
    throw e;
  }

  // ----- ConversationalModel implementation (free agent mode) -----

  /**
   * Free-form multi-turn tool-calling primitive (spec 001-agent-freedom).
   *
   * Sends the full conversation + the tool catalog to the model in OpenAI
   * "tools" format and returns one chat turn: either a plain-text reply or a
   * batch of tool calls. Unlike {@link emitAction} this performs NO phase
   * validation and NO single-tool coercion — the model picks freely. Argument
   * parsing is fault-tolerant: a tool_call whose `arguments` is missing or not
   * valid JSON is surfaced to the model as an error-shaped result by the loop,
   * not retried here.
   *
   * Network/timeout errors are retried with the same backoff as emitAction;
   * non-retryable 4xx surface immediately.
   */
  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    const maxNetwork = Math.max(0, this.cfg.networkRetries ?? 2);
    const timeoutMs = this.cfg.timeoutMs ?? 120_000;

    // Convert AgentMessage[] → OpenAI wire messages.
    const wireMessages = messages.map(toWireMessage);

    // Convert AgentTool[] → OpenAI tools array. Always sent as function tools;
    // tool_choice is "auto" so the model decides whether to call or reply.
    const wireTools = tools.length === 0
      ? []
      : tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      temperature: 0,
      max_tokens: this.cfg.toolMaxTokens ?? 4096,
      messages: wireMessages,
    };
    if (wireTools.length > 0) {
      body.tools = wireTools;
      body.tool_choice = "auto";
    }

    const req = {
      url: `${this.cfg.baseUrl}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      timeoutMs,
    };

    let netAttempt = 0;
    let response: ChatCompletionResponse;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        response = await this.post(req);
        break;
      } catch (e) {
        netAttempt++;
        if (netAttempt > maxNetwork) throw e;
        await sleep(backoffMs(netAttempt));
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`model-client.chat: upstream returned ${response.status}`);
    }

    if (this.cfg.debug) process.stderr.write(`[model-debug] chat: status=${response.status} len=${response.text.length}\n`);

    return parseChatTurn(response.json);
  }

  /**
   * Log a summary of the raw model response to stderr for debugging.
   * Shows: finish_reason, has tool_calls, content length, usage tokens.
   * Never logs full content or secrets.
   */
  private debugResponse(phase: LoopPhase, json: unknown, parseRound: number): void {
    interface Choice { finish_reason?: string; message?: { content?: string; tool_calls?: unknown[] } }
    interface Usage { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number }
    const choices = (json as { choices?: Choice[] } | undefined)?.choices;
    const choice = choices?.[0];
    const msg = choice?.message;
    const usage = (json as { usage?: Usage } | undefined)?.usage;
    const hasToolCalls = !!msg?.tool_calls?.length;
    const contentLen = msg?.content?.length ?? 0;
    process.stderr.write(
      `[model-debug] ${phase} round=${parseRound} finish=${choice?.finish_reason ?? "?"} ` +
      `tool_calls=${hasToolCalls} content_len=${contentLen} ` +
      `tokens=${usage ? `prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"}` : "?"}\n`,
    );
  }

  private buildMessages(req: ActionRequest, correction?: string): ChatMessage[] {
    const sys: ChatMessage = { role: "system", content: req.systemPrompt };
    const instr = this.cfg.protocol === "json"
      ? `You MUST respond with a single JSON object matching this schema. No prose, no markdown fences:\n${JSON.stringify(req.schema)}`
      : `You MUST call the "${req.actionName}" tool with the required arguments. Do not respond with prose.`;
    const user: ChatMessage = { role: "user", content: `${instr}\n\n${PHASE_CONSTRAINTS[req.phase] ?? ""}\n\n${req.userMessage}` };
    const msgs = [sys, user];
    if (correction) {
      msgs.push({ role: "assistant", content: "(previous response was invalid)" });
      msgs.push({ role: "user", content: `Your previous response was REJECTED: ${correction}\n\n${PHASE_CONSTRAINTS[req.phase] ?? ""}\nFix the problem and respond again. Output ONLY the required source/constraint files — no documentation, no .md/.txt/.yaml/.json files.` });
    }
    return msgs;
  }

  private buildRequest(req: ActionRequest, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: string; timeoutMs: number } {
    const isDocPhase = DOC_PHASES.has(req.phase);
    const maxTokens = isDocPhase
      ? (this.cfg.docMaxTokens ?? 8192)
      : (this.cfg.toolMaxTokens ?? 4096);
    const base: Record<string, unknown> = { model: this.cfg.model, temperature: 0, max_tokens: maxTokens, messages };
    if (this.cfg.protocol === "tools") {
      base.tools = [{ type: "function", function: { name: req.actionName, description: req.actionDescription, parameters: req.schema } }];
      base.tool_choice = { type: "function", function: { name: req.actionName } };
    } else {
      base.response_format = { type: "json_object" };
    }
    return {
      url: `${this.cfg.baseUrl}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(base),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
    };
  }

  // ----- LoopModel implementation -----

  /** Prepend the rendered upstream section (if any) to a user message body. */
  private withUpstream(userMessage: string, upstream?: UpstreamArtifacts): string {
    const block = renderUpstream(upstream);
    return block ? `${block}\n\n${userMessage}` : userMessage;
  }

  async generateRtl(task: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<RtlGeneration> {
    const outcome = await this.emitAction(
      {
        phase: "generate_rtl", systemPrompt,
        userMessage: this.withUpstream(`User task:\n${task}\n\nProduce a synthesizable Verilog RTL module implementing this task. The module name, ports, and parameters must match the upstream architecture/register contract. Output one module.`, upstream),
        actionName: "generate_rtl", actionDescription: "Produce an RTL source set for the requested task.",
        schema: RTL_SCHEMA,
      },
      validateRtl,
    );
    return outcome.action as RtlGeneration;
  }

  async generateTestbench(rtl: readonly ArtifactFile[], topModule: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<TbGeneration> {
    const rtlBlock = rtl.map(f => `# ${f.path}\n\`\`\`verilog\n${f.content}\n\`\`\``).join("\n\n");
    const outcome = await this.emitAction(
      {
        phase: "generate_testbench", systemPrompt,
        userMessage: this.withUpstream(`RTL top module: ${topModule}\n\nRTL sources:\n${rtlBlock}\n\nProduce a self-checking testbench that drives the DUT and prints PASS/FAIL. Cover the behavior rules from the upstream behavior/wave spec.`, upstream),
        actionName: "generate_testbench", actionDescription: "Produce a self-checking testbench for the given RTL.",
        schema: TB_SCHEMA,
      },
      validateTb,
    );
    return outcome.action as TbGeneration;
  }

  async generateXdc(topModule: string, part: string, systemPrompt: string, allowPinAssignments: boolean, upstream?: UpstreamArtifacts): Promise<XdcGeneration> {
    const pinGuidance = allowPinAssignments
      ? "You MAY include PACKAGE_PIN and IOSTANDARD assignments IF AND ONLY IF you have verified pin data from the hardware manual. Do not invent pin numbers."
      : [
          "No verified pin table is available for this target part.",
          "Do NOT output any PACKAGE_PIN or IOSTANDARD assignment — those would be fabricated.",
          "Instead, output EXACTLY the following template verbatim, changing only the clock port name if your design uses a different clock signal name:",
          "",
          "```",
          "# Flow-validation smoke constraints (no verified pin table for this target)",
          "create_clock -name sys_clk -period 10.000 [get_ports clk]",
          "set_property SEVERITY {Warning} [get_drc_checks NSTD-1]",
          "set_property SEVERITY {Warning} [get_drc_checks UCIO-1]",
          "```",
          "",
          "These constraints downgrade the two DRC checks that fail on unconstrained-pin designs so write_bitstream completes.",
          "This is a flow-validation smoke design, not a hardware-deployment bitstream.",
        ].join("\n");
    const outcome = await this.emitAction(
      {
        phase: "generate_xdc", systemPrompt,
        userMessage: this.withUpstream(`Target part: ${part}\nRTL top module: ${topModule}\n\n${pinGuidance}`, upstream),
        actionName: "generate_xdc", actionDescription: "Produce XDC constraints for the target part.",
        schema: XDC_SCHEMA,
      },
      makeXdcValidator(allowPinAssignments),
    );
    return outcome.action as XdcGeneration;
  }

  async repair(input: {
    sources: readonly ArtifactFile[];
    testbench?: ArtifactFile;
    topModule: string;
    testbenchModule?: string;
    stderr: string;
    stdout?: string;
    attempt: number;
    systemPrompt: string;
  }): Promise<RepairGeneration> {
    const srcBlock = input.sources.map(f => `# ${f.path}\n\`\`\`verilog\n${f.content}\n\`\`\``).join("\n\n");
    const tbBlock = input.testbench ? `\n\nTestbench:\n\`\`\`verilog\n${input.testbench.content}\n\`\`\`` : "";
    const outcome = await this.emitAction(
      {
        phase: "repair", systemPrompt: input.systemPrompt,
        userMessage: `Repair attempt ${input.attempt}. Apply a minimal patch.\n\nCurrent sources:\n${srcBlock}${tbBlock}\n\nSimulator stdout:\n\`\`\`\n${input.stdout ?? ""}\n\`\`\`\n\nSimulator stderr:\n\`\`\`\n${input.stderr}\n\`\`\`\n\nReturn the FULL corrected sources (and testbench if the TB is at fault).`,
        actionName: "repair_sources", actionDescription: "Return corrected RTL/TB sources fixing the reported errors.",
        schema: REPAIR_SCHEMA,
      },
      validateRepair,
    );
    return outcome.action as RepairGeneration;
  }

  // ----- Doc-generation phases -----

  async generateIntake(task: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    const outcome = await this.emitAction(
      {
        phase: "generate_intake", systemPrompt,
        userMessage: this.withUpstream(`User task:\n${task}\n\nProduce a requirements clarification summary (doc/intake/summary.md). Follow the method sections: Task Summary, Confirmed Facts, Hardware Dependency, Assumptions and Defaults, Missing Information, Evidence Needed, Acceptance Criteria, Handoff and Next Step.`, upstream),
        actionName: "generate_intake", actionDescription: "Produce an intake requirements summary markdown document.",
        schema: DOC_SCHEMA,
      },
      validateIntake,
    );
    return outcome.action as DocGeneration;
  }

  async generateBehaviorWave(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    const outcome = await this.emitAction(
      {
        phase: "generate_behavior_wave", systemPrompt,
        userMessage: this.withUpstream(`Produce a behavior & wave-plan specification (doc/spec/behavior_spec.md) with rule IDs, observable signals, and PASS/FAIL conditions. Rules must trace to the upstream intake requirements and use the upstream module/port names.`, upstream),
        actionName: "generate_behavior_wave", actionDescription: "Produce a behavior & wave-plan spec markdown document.",
        schema: DOC_SCHEMA,
      },
      validateBehaviorWave,
    );
    return outcome.action as DocGeneration;
  }

  async generateArchitecture(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    const outcome = await this.emitAction(
      {
        phase: "generate_architecture", systemPrompt,
        userMessage: this.withUpstream(`Produce an architecture design document (doc/arch/module_partition.md) documenting module partition, interface contract (top-level port list with directions/widths), clock/reset/CDC strategy. Module names and ports must be consistent with the upstream artifacts.`, upstream),
        actionName: "generate_architecture", actionDescription: "Produce an architecture design markdown document.",
        schema: DOC_SCHEMA,
      },
      validateArchitecture,
    );
    return outcome.action as DocGeneration;
  }

  async generateRegisterSpec(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    const outcome = await this.emitAction(
      {
        phase: "generate_register_spec", systemPrompt,
        userMessage: this.withUpstream(`Produce a register specification document (doc/reg/register_map.md) documenting the register map, field semantics, access types, and side effects. Register/module names must be consistent with the upstream architecture.`, upstream),
        actionName: "generate_register_spec", actionDescription: "Produce a register specification markdown document.",
        schema: DOC_SCHEMA,
      },
      validateRegisterSpec,
    );
    return outcome.action as DocGeneration;
  }
}

// ---------------------------------------------------------------------------
// JSON Schemas + strict validators (fail loudly → triggers one retry)
// ---------------------------------------------------------------------------

/** Phases that produce markdown documents (larger output budget). */
const DOC_PHASES: ReadonlySet<LoopPhase> = new Set([
  "generate_intake", "generate_behavior_wave", "generate_architecture", "generate_register_spec",
]);

const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Phase-specific file-type constraints injected into every user message and
 *  repeated explicitly on validation-failure retry, so the model knows exactly
 *  what is allowed and what is forbidden. */
const PHASE_CONSTRAINTS: Record<LoopPhase, string> = {
  generate_rtl: "FILE TYPE CONSTRAINT: sources[] may ONLY contain .v, .sv, or .vh files. Do NOT output .md, .txt, .yaml, .json, .xdc, or any documentation files.",
  generate_testbench: "FILE TYPE CONSTRAINT: testbench.path must be a .v, .sv, or .vh file. Do NOT output .md, .txt, .yaml, .json, or any documentation files.",
  generate_xdc: "FILE TYPE CONSTRAINT: constraints[] may ONLY contain .xdc files. Do NOT output .md, .txt, .yaml, .json, .v, .sv, or any documentation files.",
  repair: "FILE TYPE CONSTRAINT: sources[] may ONLY contain .v, .sv, or .vh files. testbench (if provided) must also be .v/.sv/.vh. Do NOT output documentation files.",
  generate_intake: "OUTPUT CONSTRAINT: produce exactly ONE markdown document (.md). Output real content: sections with confirmed facts, assumptions, missing information, acceptance criteria. No file paths outside code fences. No fabrication of hardware facts.",
  generate_behavior_wave: "OUTPUT CONSTRAINT: produce exactly ONE markdown document (.md) with behavior rules, observable signals, and PASS/FAIL conditions. No file paths outside code fences. No fabrication.",
  generate_architecture: "OUTPUT CONSTRAINT: produce exactly ONE markdown document (.md) documenting module partition, interface contract, clock/reset/CDC strategy. No file paths outside code fences. No fabrication.",
  generate_register_spec: "OUTPUT CONSTRAINT: produce exactly ONE markdown document (.md) documenting register map, field semantics, access types, side effects. No file paths outside code fences. No fabrication.",
};

function err(msg: string): never { throw new Error(msg); }

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) err(`field "${field}" must be a non-empty string`);
  return v;
}

function asFiles(v: unknown, field: string, allowed: { kind: "source" | "constraint"; extensions: readonly string[] }): ArtifactFile[] {
  if (!Array.isArray(v) || v.length === 0) err(`field "${field}" must be a non-empty array`);
  const out: ArtifactFile[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") err(`each item of "${field}" must be an object`);
    const o = item as Record<string, unknown>;
    const path = asString(o.path, `${field}.path`);
    const lower = path.toLowerCase();
    const okExt = allowed.extensions.some(ext => lower.endsWith(ext));
    if (!okExt) err(`${field}.path "${path}" must be ${allowed.extensions.length === 1 ? `a ${allowed.extensions[0]} file` : `one of: ${allowed.extensions.join("/")}`}. Do NOT include documentation files (.md/.txt/.yaml/.json) or any other type.`);
    const content = asString(o.content, `${field}.content`);
    out.push({ path, content, ...(typeof o.mediaType === "string" ? { mediaType: o.mediaType } : {}) });
  }
  return out;
}

const SOURCE_EXTS = [".v", ".sv", ".vh"] as const;
const XDC_EXTS = [".xdc"] as const;

function asFile(v: unknown, field: string): ArtifactFile {
  return asFiles([v], field, { kind: "source", extensions: SOURCE_EXTS })[0];
}

export const RTL_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    top_module: { type: "string" },
    sources: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  },
  required: ["reasoning", "top_module", "sources"],
} as const;

export function validateRtl(raw: unknown): LoopAction {
  if (!raw || typeof raw !== "object") err("rtl action must be an object");
  const o = raw as Record<string, unknown>;
  const reasoning = asString(o.reasoning, "reasoning");
  const topModule = asString(o.top_module ?? o.topModule, "top_module");
  if (!MODULE_RE.test(topModule)) err(`top_module "${topModule}" is not a valid identifier`);
  const sources = asFiles(o.sources, "sources", { kind: "source", extensions: SOURCE_EXTS });
  return { phase: "generate_rtl", reasoning, topModule, sources };
}

export const TB_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    testbench_module: { type: "string" },
    testbench: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  required: ["reasoning", "testbench_module", "testbench"],
} as const;

export function validateTb(raw: unknown): LoopAction {
  if (!raw || typeof raw !== "object") err("testbench action must be an object");
  const o = raw as Record<string, unknown>;
  const reasoning = asString(o.reasoning, "reasoning");
  const testbenchModule = asString(o.testbench_module ?? o.testbenchModule, "testbench_module");
  if (!MODULE_RE.test(testbenchModule)) err(`testbench_module "${testbenchModule}" is not a valid identifier`);
  const testbench = asFile(o.testbench, "testbench");
  return { phase: "generate_testbench", reasoning, testbenchModule, testbench };
}

export const XDC_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    constraints: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  },
  required: ["reasoning", "constraints"],
} as const;

/** Regex detecting PACKAGE_PIN / IOSTANDARD pin assignments in XDC content. */
const XDC_PIN_RE = /\b(?:set_property\s+(?:PACKAGE_PIN|IOSTANDARD)|PACKAGE_PIN|IOSTANDARD)\b/i;

export function makeXdcValidator(allowPinAssignments: boolean): ActionValidator {
  return (raw: unknown): LoopAction => {
    if (!raw || typeof raw !== "object") err("xdc action must be an object");
    const o = raw as Record<string, unknown>;
    const reasoning = asString(o.reasoning, "reasoning");
    const constraints = asFiles(o.constraints, "constraints", { kind: "constraint", extensions: XDC_EXTS });
    if (!allowPinAssignments) {
      for (const c of constraints) {
        if (XDC_PIN_RE.test(c.content)) {
          err(`constraints content must NOT contain PACKAGE_PIN or IOSTANDARD assignments because no verified pin table is available for this target. Use only a clock constraint and the two DRC severity downgrades. Output exactly this template, changing only the clock port name if needed: create_clock -name sys_clk -period 10.000 [get_ports clk] then set_property SEVERITY Warning for DRC checks NSTD-1 and UCIO-1.`);
        }
      }
    }
    return { phase: "generate_xdc", reasoning, constraints };
  };
}

/** Backward-compatible validator: allows pin assignments (for tests that only
 *  check structural validity). Production code uses makeXdcValidator(false). */
export const validateXdc = makeXdcValidator(true);


export const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    sources: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    testbench: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  required: ["reasoning", "sources"],
} as const;

export function validateRepair(raw: unknown): LoopAction {
  if (!raw || typeof raw !== "object") err("repair action must be an object");
  const o = raw as Record<string, unknown>;
  const reasoning = asString(o.reasoning, "reasoning");
  const sources = asFiles(o.sources, "sources", { kind: "source", extensions: SOURCE_EXTS });
  const tb: ArtifactFile | undefined = o.testbench !== undefined && o.testbench !== null ? asFile(o.testbench, "testbench") : undefined;
  return { phase: "repair", reasoning, sources, ...(tb ? { testbench: tb } : {}) };
}

// ---------------------------------------------------------------------------
// Doc generation (intake / behavior-wave / architecture / register-spec)
// ---------------------------------------------------------------------------

export const DOC_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    doc_path: { type: "string" },
    content: { type: "string" },
  },
  required: ["reasoning", "doc_path", "content"],
} as const;

/** Regex matching a markdown heading line. */
const MD_HEADING_RE = /^#{1,6}\s+\S/;

/** Regex matching a code-fence opening (``` or ~~~). */
const CODE_FENCE_RE = /^(?:```|~~~)/;

/**
 * Validate a doc-generation action. Enforces:
 * - doc_path ends with .md
 * - content is non-empty markdown with at least one heading
 * - no path-like strings outside code fences (detects hallucinated file refs)
 */
export function makeDocValidator(phase: "generate_intake" | "generate_behavior_wave" | "generate_architecture" | "generate_register_spec"): ActionValidator {
  return (raw: unknown): LoopAction => {
    if (!raw || typeof raw !== "object") err("doc action must be an object");
    const o = raw as Record<string, unknown>;
    const reasoning = asString(o.reasoning, "reasoning");
    const docPath = asString(o.doc_path ?? o.docPath, "doc_path");
    if (!docPath.toLowerCase().endsWith(".md")) {
      err(`doc_path "${docPath}" must be a .md file (got: ${docPath}). Output exactly ONE markdown document.`);
    }
    const content = asString(o.content, "content");
    if (!MD_HEADING_RE.test(content)) {
      err(`content must contain at least one markdown heading (line starting with #). Output real structured markdown, not prose.`);
    }
    // Detect hallucinated file paths outside code fences.
    const lines = content.split("\n");
    let inFence = false;
    for (const line of lines) {
      if (CODE_FENCE_RE.test(line.trim())) { inFence = !inFence; continue; }
      if (!inFence && /(?:^|\s)(?:doc\/|rtl\/|tb\/|prj\/|toolruns\/)[^\s`]+/m.test(line)) {
        // Allow inline-code references like `doc/intake/summary.md` — the regex
        // only fires on bare path tokens outside backticks.
        if (!/`[^`]*doc\/|`[^`]*rtl\/|`[^`]*tb\/|`[^`]*prj\//.test(line)) {
          err(`content must not contain bare file paths outside code fences or inline code. Found: "${line.trim()}". Wrap references in backticks or remove.`);
        }
      }
    }
    return { phase, reasoning, docPath, content };
  };
}

export const validateIntake = makeDocValidator("generate_intake");
export const validateBehaviorWave = makeDocValidator("generate_behavior_wave");
export const validateArchitecture = makeDocValidator("generate_architecture");
export const validateRegisterSpec = makeDocValidator("generate_register_spec");
