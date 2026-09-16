import { describe, expect, test } from "bun:test";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ProviderStreamOptions,
} from "@mariozechner/pi-ai";

import {
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

describe("Model mode configuration", () => {
  test("defaults to Chat Completions; anthropic aliases resolve; responses removed", () => {
    expect(modelApiModeFromEnv({})).toBe("chat-completions");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "anthropic" })).toBe("anthropic-messages");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "anthropic-messages" })).toBe("anthropic-messages");
    expect(modelApiModeFromEnv({ SYNTHIA_MODEL_API: "messages" })).toBe("anthropic-messages");
    expect(() => modelApiModeFromEnv({ SYNTHIA_MODEL_API: "bogus" })).toThrow(
      /chat-completions or anthropic-messages/,
    );
    expect(() => modelApiModeFromEnv({ SYNTHIA_MODEL_API: "responses" })).toThrow(
      /chat-completions or anthropic-messages/,
    );
  });

  test("factory builds the legacy client for chat-completions mode", () => {
    const env = {
      SYNTHIA_MODEL_URL: CONFIG.baseUrl,
      SYNTHIA_MODEL_KEY: CONFIG.apiKey,
      SYNTHIA_MODEL_NAME: CONFIG.model,
    };
    expect(createRuntimeModelFromEnv(env)).toBeInstanceOf(ModelClient);
  });

  test("stable tool ids discard provider-owned Responses item ids", () => {
    expect(stableToolCallId("call_123|fc_456")).toBe("call_123");
    expect(stableToolCallId("call_plain")).toBe("call_plain");
  });
});
