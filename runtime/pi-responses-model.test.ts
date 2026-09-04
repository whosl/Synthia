import { describe, expect, test } from "bun:test";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ProviderStreamOptions,
} from "@mariozechner/pi-ai";

import {
  PiResponsesRuntimeModel,
  assistantToChatTurn,
  createRuntimeModelFromEnv,
  modelApiModeFromEnv,
  stableToolCallId,
} from "./pi-responses-model.ts";
import { ModelClient, type ModelClientConfig } from "./model-client.ts";
import type { AgentMessage, AgentTool } from "./agent-types.ts";

const CONFIG: ModelClientConfig = {
  baseUrl: "https://model.example/v1",
  apiKey: "secret",
  model: "gpt-test",
  protocol: "tools",
  reasoningEffort: "medium",
  networkRetries: 0,
  timeoutMs: 1000,
  toolMaxTokens: 512,
  docMaxTokens: 1024,
  chatMaxTokens: 2048,
};

function usage(): AssistantMessage["usage"] {
  return {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function response(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "synthia-openai-responses",
    model: "gpt-test",
    usage: usage(),
    stopReason,
    timestamp: 1,
  };
}

const TOOL: AgentTool = {
  name: "add",
  description: "Add two values",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  async execute() {
    return { content: "12" };
  },
};

describe("Responses model configuration", () => {
  test("defaults to Chat Completions and accepts explicit Responses mode", () => {
    expect(modelApiModeFromEnv({})).toBe("chat-completions");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "responses" })).toBe("responses");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "anthropic" })).toBe("anthropic-messages");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "anthropic-messages" })).toBe("anthropic-messages");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "messages" })).toBe("anthropic-messages");
    expect(() => modelApiModeFromEnv({ SYNTHIA_MODEL_API: "bogus" })).toThrow(
      /chat-completions, responses, or anthropic-messages/,
    );
  });

  test("factory preserves the legacy client unless Responses is explicit", () => {
    const env = {
      SYNTHIA_MODEL_URL: CONFIG.baseUrl,
      SYNTHIA_MODEL_KEY: CONFIG.apiKey,
      SYNTHIA_MODEL_NAME: CONFIG.model,
    };
    expect(createRuntimeModelFromEnv(env)).toBeInstanceOf(ModelClient);
    expect(createRuntimeModelFromEnv({ ...env, SYNTHIA_MODEL_API: "responses" }))
      .toBeInstanceOf(PiResponsesRuntimeModel);
  });

  test("stable tool ids discard provider-owned Responses item ids", () => {
    expect(stableToolCallId("call_123|fc_456")).toBe("call_123");
    expect(stableToolCallId("call_plain")).toBe("call_plain");
  });
});

describe("PiResponsesRuntimeModel conversation adapter", () => {
  test("maps tool calls and replays a matching stable call id", async () => {
    const contexts: Context[] = [];
    let call = 0;
    const model = new PiResponsesRuntimeModel(CONFIG, {
      now: () => 10,
      complete: async (_model, context) => {
        contexts.push(context);
        call++;
        return call === 1
          ? response([{
              type: "toolCall",
              id: "call_add|fc_output_item",
              name: "add",
              arguments: { a: 7, b: 5 },
            }], "toolUse")
          : response([{ type: "text", text: "12" }]);
      },
    });

    const first = await model.chat([
      { role: "system", content: "system" },
      { role: "user", content: "7+5" },
    ], [TOOL]);
    expect(first).toEqual({
      kind: "tool_calls",
      calls: [{ toolCallId: "call_add", name: "add", args: { a: 7, b: 5 } }],
      content: null,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "7+5" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ toolCallId: "call_add", name: "add", args: { a: 7, b: 5 } }],
      },
      { role: "tool", toolCallId: "call_add", name: "add", content: "12" },
    ];
    expect(await model.chat(messages, [TOOL])).toEqual({ kind: "text", content: "12" });

    const replay = contexts[1]!.messages;
    const assistant = replay.find((message) => message.role === "assistant");
    const result = replay.find((message) => message.role === "toolResult");
    expect(assistant?.role === "assistant" && assistant.content.find((block) => block.type === "toolCall"))
      .toMatchObject({ id: "call_add", name: "add" });
    expect(result?.role === "toolResult" ? result.toolCallId : undefined).toBe("call_add");
  });

  test("streams thinking and text while returning the aggregated turn", async () => {
    const final = response([
      { type: "thinking", thinking: "check" },
      { type: "text", text: "pong" },
    ]);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: response([]) });
    stream.push({ type: "thinking_start", contentIndex: 0, partial: response([]) });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "check", partial: response([]) });
    stream.push({ type: "thinking_end", contentIndex: 0, content: "check", partial: response([]) });
    stream.push({ type: "text_start", contentIndex: 1, partial: response([]) });
    stream.push({ type: "text_delta", contentIndex: 1, delta: "pong", partial: response([]) });
    stream.push({ type: "text_end", contentIndex: 1, content: "pong", partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
    stream.end();

    const model = new PiResponsesRuntimeModel(CONFIG, { stream: () => stream });
    const events: string[] = [];
    const turn = await model.chatStream([{ role: "user", content: "ping" }], [], {
      onReasoningStart: () => events.push("reasoning:start"),
      onReasoning: (text) => events.push(`reasoning:${text}`),
      onTextStart: () => events.push("text:start"),
      onDelta: (text) => events.push(`text:${text}`),
    });
    expect(events).toEqual([
      "reasoning:start",
      "reasoning:check",
      "text:start",
      "text:pong",
    ]);
    expect(turn).toEqual({ kind: "text", content: "pong" });
  });

  test("assistant conversion keeps text accompanying tool calls", () => {
    expect(assistantToChatTurn(response([
      { type: "text", text: "working" },
      { type: "toolCall", id: "call_1|fc_1", name: "add", arguments: { a: 1, b: 2 } },
    ], "toolUse"))).toEqual({
      kind: "tool_calls",
      calls: [{ toolCallId: "call_1", name: "add", args: { a: 1, b: 2 } }],
      content: "working",
    });
  });
});

describe("PiResponsesRuntimeModel structured action adapter", () => {
  test("forces the requested action tool and preserves ModelClient validation", async () => {
    let providerPayload: unknown;
    let providerContext: Context | undefined;
    const model = new PiResponsesRuntimeModel(CONFIG, {
      complete: async (_model, context, options?: ProviderStreamOptions) => {
        providerContext = context;
        providerPayload = await options?.onPayload?.({ model: "gpt-test" }, _model);
        return response([{
          type: "toolCall",
          id: "call_rtl|fc_rtl",
          name: "generate_rtl",
          arguments: {
            reasoning: "implements counter",
            top_module: "counter",
            sources: [{ path: "rtl/counter.v", content: "module counter; endmodule\n" }],
          },
        }], "toolUse");
      },
    });

    const result = await model.generateRtl("counter", "system");
    expect(result.topModule).toBe("counter");
    expect(result.sources[0]?.path).toBe("rtl/counter.v");
    expect(providerPayload).toMatchObject({
      tool_choice: { type: "function", name: "generate_rtl" },
    });
    expect(providerContext?.tools?.[0]?.name).toBe("generate_rtl");
  });

  test("maps provider 4xx failures back to a non-retryable ModelClient response", async () => {
    const model = new PiResponsesRuntimeModel(CONFIG, {
      complete: async () => ({
        ...response([], "error"),
        errorMessage: "403 forbidden",
      }),
    });
    await expect(model.generateRtl("counter", "system")).rejects.toThrow(/403/);
  });
});
