/**
 * Anthropic Messages transport for Synthia, backed by @mariozechner/pi-ai.
 *
 * Connects to any Anthropic-compatible Messages API endpoint (Anthropic,
 * Zhipu GLM via /api/anthropic, etc.). pi-ai owns only wire conversion;
 * Synthia owns the agent loop, tool execution, governance, and audit.
 */

import {
  complete as piComplete,
  stream as piStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type TSchema,
  type Tool,
} from "@mariozechner/pi-ai";

import {
  ModelClient,
  type ChatCompletionResponse,
  type ChatPoster,
  type ModelClientConfig,
} from "./model-client.ts";
import type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
  ChatTurn,
} from "./agent-types.ts";
import type {
  ArtifactFile,
  DocGeneration,
  LoopModel,
  RepairGeneration,
  RtlGeneration,
  TbGeneration,
  UpstreamArtifacts,
  XdcGeneration,
} from "./types.ts";
import type { RuntimeModel } from "./pi-responses-model.ts";

type PiAnthropicModel = Model<"anthropic-messages">;
type PiAnthropicComplete = (
  model: PiAnthropicModel,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;
type PiAnthropicStream = (
  model: PiAnthropicModel,
  context: Context,
  options?: ProviderStreamOptions,
) => AssistantMessageEventStream;

export interface PiAnthropicDeps {
  readonly complete?: PiAnthropicComplete;
  readonly stream?: PiAnthropicStream;
  readonly now?: () => number;
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function cloneEmptyUsage(): AssistantMessage["usage"] {
  return { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch { /* tool loop carries the validation error back */ }
  }
  return {};
}

function assistantMessage(
  content: AssistantMessage["content"],
  model: PiAnthropicModel,
  now: number,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: cloneEmptyUsage(),
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: now,
  };
}

function agentMessagesToContext(
  messages: readonly AgentMessage[],
  tools: readonly AgentTool[],
  model: PiAnthropicModel,
  now: () => number,
): Context {
  const systemParts: string[] = [];
  const converted: Context["messages"] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content, timestamp: now() });
      continue;
    }
    if (message.role === "tool") {
      converted.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: [{ type: "text", text: message.content }],
        isError: message.isError === true,
        timestamp: now(),
      });
      continue;
    }
    if (message.role !== "assistant") continue;

    const content: AssistantMessage["content"] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "toolCall",
        id: call.toolCallId,
        name: call.name,
        arguments: parseArguments(call.args),
      });
    }
    if (content.length > 0) converted.push(assistantMessage(content, model, now()));
  }

  const piTools: Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as TSchema,
  }));
  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages: converted,
    ...(piTools.length > 0 ? { tools: piTools } : {}),
  };
}

interface ChatWireToolCall {
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
}
interface ChatWireMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly tool_calls?: readonly ChatWireToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}
interface ChatWireTool {
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly description?: string; readonly parameters?: unknown };
}
interface ChatWireRequest {
  readonly messages?: readonly ChatWireMessage[];
  readonly tools?: readonly ChatWireTool[];
  readonly tool_choice?: unknown;
  readonly response_format?: unknown;
  readonly max_tokens?: unknown;
  readonly max_completion_tokens?: unknown;
}

function wireRequestToContext(
  request: ChatWireRequest,
  model: PiAnthropicModel,
  now: () => number,
): Context {
  const messages: AgentMessage[] = [];
  for (const message of request.messages ?? []) {
    const content = typeof message.content === "string" ? message.content : "";
    if (message.role === "system" || message.role === "user") {
      messages.push({ role: message.role, content });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls: AgentToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
        toolCallId: call.id ?? `call_${index}`,
        name: call.function?.name ?? "",
        args: parseArguments(call.function?.arguments),
      }));
      messages.push({
        role: "assistant",
        content: content || null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        toolCallId: message.tool_call_id ?? "call_unknown",
        name: message.name ?? "tool",
        content,
      });
    }
  }

  const tools: AgentTool[] = (request.tools ?? []).flatMap((tool) => {
    const fn = tool.function;
    if (tool.type !== "function" || !fn?.name || !isRecord(fn.parameters)) return [];
    return [{
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters,
      async execute() { throw new Error("pi-anthropic transport tools are descriptions only"); },
    }];
  });
  return agentMessagesToContext(messages, tools, model, now);
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function assistantToChatTurn(message: AssistantMessage): ChatTurn {
  const calls: AgentToolCall[] = message.content.flatMap((block) => block.type === "toolCall"
    ? [{ toolCallId: block.id, name: block.name, args: block.arguments }]
    : []);
  const text = textFromAssistant(message);
  return calls.length > 0
    ? { kind: "tool_calls", calls, content: text || null }
    : { kind: "text", content: text };
}

function assistantToChatCompletion(message: AssistantMessage): ChatCompletionResponse {
  const turn = assistantToChatTurn(message);
  const wireMessage = turn.kind === "tool_calls"
    ? {
        content: turn.content,
        tool_calls: turn.calls.map((call) => ({
          id: call.toolCallId,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      }
    : { content: turn.content };
  const json = {
    choices: [{
      message: wireMessage,
      finish_reason: turn.kind === "tool_calls" ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: message.usage.input,
      completion_tokens: message.usage.output,
      total_tokens: message.usage.totalTokens,
    },
  };
  return { status: 200, json, text: JSON.stringify(json) };
}

function statusFromError(value: unknown): number | undefined {
  const message = value instanceof Error ? value.message : String(value);
  const match = message.match(/(?:^|\D)([45]\d\d)(?:\D|$)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export class PiAnthropicRuntimeModel implements RuntimeModel {
  private readonly piModel: PiAnthropicModel;
  private readonly completeFn: PiAnthropicComplete;
  private readonly streamFn: PiAnthropicStream;
  private readonly now: () => number;
  private readonly actionClient: ModelClient;

  constructor(private readonly config: ModelClientConfig, deps: PiAnthropicDeps = {}) {
    this.completeFn = deps.complete ?? piComplete;
    this.streamFn = deps.stream ?? piStream;
    this.now = deps.now ?? Date.now;
    const maxTokens = Math.max(
      config.chatMaxTokens ?? 16_384,
      config.docMaxTokens ?? 8192,
      config.toolMaxTokens ?? 4096,
    );
    this.piModel = {
      id: config.model,
      name: config.model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: config.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens,
      // pi-ai merges model.headers over the SDK defaults on every request
      // (chat, stream, and pipeline action calls alike), identifying traffic
      // as originating from the Synthia pi agent loop.
      headers: {
        "User-Agent": "pi-agent/1.0",
        "X-Request-Source": "pi-agent",
      },
      compat: {
        supportsEagerToolInputStreaming: false,
        supportsLongCacheRetention: false,
      },
    };
    const poster: ChatPoster = (input) => this.postChatCompletion(input.body, input.timeoutMs);
    this.actionClient = new ModelClient({
      ...config,
      networkRetries: 0,
      post: poster,
    });
  }

  private options(maxTokens: number, extra: ProviderStreamOptions = {}): ProviderStreamOptions {
    return {
      apiKey: this.config.apiKey,
      maxTokens,
      cacheRetention: "none",
      timeoutMs: this.config.timeoutMs ?? 120_000,
      maxRetries: Math.max(0, this.config.networkRetries ?? 2),
      ...extra,
    };
  }

  private async requireSuccess(promise: Promise<AssistantMessage>): Promise<AssistantMessage> {
    const message = await promise;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `pi-anthropic stopped: ${message.stopReason}`);
    }
    return message;
  }

  /**
   * Transient transport failures (socket closed mid-generation, ECONNRESET,
   * fetch aborted) surface as thrown errors from the provider client. A
   * dropped connection killed a whole multi-minute turn in the T1 AES run
   * and marked the agent failed — retry transient-looking failures here
   * before letting anything reach the turn level.
   */
  private isTransientTransportError(err: unknown): boolean {
    const text = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}` : String(err);
    return /socket connection was closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|network|Connection closed unexpectedly|aborted/i.test(text);
  }

  private async withTransportRetry<T>(op: () => Promise<T>): Promise<T> {
    const attempts = Math.max(1, this.config.networkRetries ?? 2) + 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        if (attempt === attempts || !this.isTransientTransportError(err)) throw err;
        const backoffMs = 2_000 * attempt;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
    throw lastErr;
  }

  private async postChatCompletion(body: string, timeoutMs: number): Promise<ChatCompletionResponse> {
    let request: ChatWireRequest;
    try {
      request = JSON.parse(body) as ChatWireRequest;
    } catch {
      return { status: 400, json: { error: "invalid request JSON" }, text: "invalid request JSON" };
    }
    const context = wireRequestToContext(request, this.piModel, this.now);
    const maxTokens = positiveInteger(
      request.max_completion_tokens ?? request.max_tokens,
      this.config.toolMaxTokens ?? 4096,
    );
    try {
      const message = await this.withTransportRetry(() => this.requireSuccess(this.completeFn(
        this.piModel,
        context,
        this.options(maxTokens, { timeoutMs }),
      )));
      return assistantToChatCompletion(message);
    } catch (error) {
      const status = statusFromError(error);
      if (status) {
        const text = error instanceof Error ? error.message : String(error);
        return { status, json: { error: text }, text };
      }
      throw error;
    }
  }

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    const context = agentMessagesToContext(messages, tools, this.piModel, this.now);
    const message = await this.withTransportRetry(() => this.requireSuccess(this.completeFn(
      this.piModel,
      context,
      this.options(this.config.chatMaxTokens ?? 16_384),
    )));
    return assistantToChatTurn(message);
  }

  async chatStream(
    messages: readonly AgentMessage[],
    tools: readonly AgentTool[],
    opts: {
      onTextStart?: () => void;
      onDelta?: (text: string) => void;
      onReasoningStart?: () => void;
      onReasoning?: (text: string) => void;
    } = {},
  ): Promise<ChatTurn> {
    const context = agentMessagesToContext(messages, tools, this.piModel, this.now);
    const controller = new AbortController();
    const idleMs = this.config.streamIdleTimeoutMs ?? 120_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let emitted = false;
    const bump = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleMs > 0) {
        idleTimer = setTimeout(
          () => controller.abort(new Error(`pi-anthropic: no upstream events for ${idleMs}ms`)),
          idleMs,
        );
      }
    };
    bump();
    try {
      const eventStream = await this.withTransportRetry(() => Promise.resolve(this.streamFn(
        this.piModel,
        context,
        this.options(this.config.chatMaxTokens ?? 16_384, { signal: controller.signal }),
      )));
      for await (const event of eventStream) {
        bump();
        if (event.type === "text_start") { emitted = true; opts.onTextStart?.(); }
        else if (event.type === "text_delta") { emitted = true; opts.onDelta?.(event.delta); }
        else if (event.type === "thinking_start") { emitted = true; opts.onReasoningStart?.(); }
        else if (event.type === "thinking_delta") { emitted = true; opts.onReasoning?.(event.delta); }
      }
      return assistantToChatTurn(await this.requireSuccess(eventStream.result()));
    } catch (error) {
      if (!emitted && this.config.streamFallbackToBuffered !== false) {
        return this.chat(messages, tools);
      }
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  generateRtl(task: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<RtlGeneration> {
    return this.actionClient.generateRtl(task, systemPrompt, upstream);
  }
  generateTestbench(
    rtl: readonly ArtifactFile[], topModule: string, systemPrompt: string, upstream?: UpstreamArtifacts,
  ): Promise<TbGeneration> {
    return this.actionClient.generateTestbench(rtl, topModule, systemPrompt, upstream);
  }
  generateXdc(
    topModule: string, part: string, systemPrompt: string,
    allowPinAssignments: boolean, upstream?: UpstreamArtifacts, topPorts?: readonly string[],
  ): Promise<XdcGeneration> {
    return this.actionClient.generateXdc(topModule, part, systemPrompt, allowPinAssignments, upstream, topPorts);
  }
  repair(input: Parameters<LoopModel["repair"]>[0]): Promise<RepairGeneration> {
    return this.actionClient.repair(input);
  }
  generateIntake(task: string, systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    return this.actionClient.generateIntake(task, systemPrompt, upstream);
  }
  generateBehaviorWave(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    return this.actionClient.generateBehaviorWave(systemPrompt, upstream);
  }
  generateArchitecture(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    return this.actionClient.generateArchitecture(systemPrompt, upstream);
  }
  generateRegisterSpec(systemPrompt: string, upstream?: UpstreamArtifacts): Promise<DocGeneration> {
    return this.actionClient.generateRegisterSpec(systemPrompt, upstream);
  }
}
