/**
 * OpenAI Responses transport for Synthia, backed by @mariozechner/pi-ai.
 *
 * pi-ai owns only provider-specific wire conversion and streaming. Synthia
 * continues to own the agent loop, tool execution, governance hooks, audit,
 * and persistence. In particular, this module deliberately does not use
 * pi-agent-core.
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
  type ToolCall,
} from "@mariozechner/pi-ai";

import {
  ModelClient,
  modelConfigFromEnv,
  type ChatCompletionResponse,
  type ChatPoster,
  type ModelClientConfig,
} from "./model-client.ts";
import type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
  ChatTurn,
  ConversationalModel,
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

export type ModelApiMode = "chat-completions" | "anthropic-messages";
export type RuntimeModel = LoopModel & ConversationalModel;

type PiResponsesModel = Model<"openai-responses">;
type PiComplete = (
  model: PiResponsesModel,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;
type PiStream = (
  model: PiResponsesModel,
  context: Context,
  options?: ProviderStreamOptions,
) => AssistantMessageEventStream;


interface ChatWireToolCall {
  readonly id?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
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
  readonly function?: {
    readonly name?: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

interface ChatWireRequest {
  readonly messages?: readonly ChatWireMessage[];
  readonly tools?: readonly ChatWireTool[];
  readonly tool_choice?: unknown;
  readonly response_format?: unknown;
  readonly max_tokens?: unknown;
  readonly max_completion_tokens?: unknown;
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function cloneEmptyUsage(): AssistantMessage["usage"] {
  return {
    ...EMPTY_USAGE,
    cost: { ...EMPTY_USAGE.cost },
  };
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
    } catch {
      // The tool loop will receive an empty argument object and the tool result
      // will carry the validation error back to the model.
    }
  }
  return {};
}

/**
 * pi-ai represents Responses calls as `call_id|output_item_id`. Synthia only
 * persists the stable call_id. Omitting the provider-owned item id also means
 * a resumed Synthia conversation never claims to possess encrypted reasoning
 * items that its audit-safe message contract intentionally does not persist.
 */
export function stableToolCallId(id: string): string {
  return id.split("|", 1)[0] || id;
}

function assistantMessage(
  content: AssistantMessage["content"],
  model: PiResponsesModel,
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
  model: PiResponsesModel,
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
        toolCallId: stableToolCallId(message.toolCallId),
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
        id: stableToolCallId(call.toolCallId),
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

function wireRequestToContext(
  request: ChatWireRequest,
  model: PiResponsesModel,
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
        toolCallId: stableToolCallId(call.id ?? `call_${index}`),
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
        toolCallId: stableToolCallId(message.tool_call_id ?? "call_unknown"),
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
      async execute() {
        throw new Error("pi-responses transport tools are descriptions only");
      },
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

export function assistantToChatTurn(message: AssistantMessage): ChatTurn {
  const calls: AgentToolCall[] = message.content.flatMap((block) => block.type === "toolCall"
    ? [{
        toolCallId: stableToolCallId(block.id),
        name: block.name,
        args: block.arguments,
      }]
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

function forcedToolName(toolChoice: unknown): string | undefined {
  if (!isRecord(toolChoice) || toolChoice.type !== "function") return undefined;
  if (typeof toolChoice.name === "string") return toolChoice.name;
  const fn = toolChoice.function;
  return isRecord(fn) && typeof fn.name === "string" ? fn.name : undefined;
}

function responsePayloadOverride(request: ChatWireRequest): ProviderStreamOptions["onPayload"] {
  return (payload) => {
    if (!isRecord(payload)) return payload;
    const next: Record<string, unknown> = { ...payload };
    const forcedName = forcedToolName(request.tool_choice);
    if (forcedName) next.tool_choice = { type: "function", name: forcedName };
    if (isRecord(request.response_format) && request.response_format.type === "json_object") {
      next.text = { format: { type: "json_object" } };
    }
    return next;
  };
}

function reasoningEffort(value: string | undefined): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : undefined;
}

export function modelApiModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): ModelApiMode {
  const raw = env.SYNTHIA_MODEL_API?.trim().toLowerCase();
  if (!raw || raw === "chat-completions" || raw === "chat_completions" || raw === "chat") {
    return "chat-completions";
  }
  if (raw === "anthropic-messages" || raw === "anthropic" || raw === "messages") return "anthropic-messages";
  throw new Error(
    "SYNTHIA_MODEL_API must be one of chat-completions or anthropic-messages",
  );
}

import { PiAnthropicRuntimeModel } from "./pi-anthropic-model.ts";

export function createRuntimeModelFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeModel {
  const config = modelConfigFromEnv(env);
  const mode = modelApiModeFromEnv(env);
  if (mode === "anthropic-messages") return new PiAnthropicRuntimeModel(config);
  return new ModelClient(config);
}
