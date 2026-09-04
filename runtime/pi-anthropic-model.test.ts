import { describe, expect, test } from "bun:test";
import {
  PiAnthropicRuntimeModel,
  type PiAnthropicDeps,
} from "./pi-anthropic-model.ts";
import type { ModelClientConfig } from "./model-client.ts";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const CONFIG: ModelClientConfig = {
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  apiKey: "test-key",
  model: "glm-4.6",
  protocol: "tools",
};

function fakeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "module top; endmodule" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "glm-4.6",
    usage: {
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("PiAnthropicRuntimeModel", () => {
  test("chat returns text turn", async () => {
    const deps: PiAnthropicDeps = {
      complete: async () => fakeAssistant(),
    };
    const model = new PiAnthropicRuntimeModel(CONFIG, deps);
    const turn = await model.chat([{ role: "user", content: "hello" }], []);
    expect(turn.kind).toBe("text");
    if (turn.kind === "text") expect(turn.content).toContain("module top");
  });

  test("chat maps tool calls", async () => {
    const deps: PiAnthropicDeps = {
      complete: async () => fakeAssistant({
        content: [{
          type: "toolCall",
          id: "call_1",
          name: "emit_rtl",
          arguments: { files: [{ path: "top.v", content: "module top; endmodule" }] },
        }],
        stopReason: "toolUse",
      }),
    };
    const model = new PiAnthropicRuntimeModel(CONFIG, deps);
    const turn = await model.chat(
      [{ role: "user", "content": "generate rtl" }],
      [],
    );
    expect(turn.kind).toBe("tool_calls");
    if (turn.kind === "tool_calls") {
      expect(turn.calls).toHaveLength(1);
      expect(turn.calls[0]!.name).toBe("emit_rtl");
    }
  });

  test("chat throws on error stop reason", async () => {
    const deps: PiAnthropicDeps = {
      complete: async () => fakeAssistant({
        stopReason: "error",
        errorMessage: "rate limit",
      }),
    };
    const model = new PiAnthropicRuntimeModel(CONFIG, deps);
    await expect(model.chat([{ role: "user", content: "hi" }], []))
      .rejects
      .toThrow("rate limit");
  });

  test("chatStream falls back to buffered on failure when nothing emitted", async () => {
    const deps: PiAnthropicDeps = {
      complete: async () => fakeAssistant(),
      stream: () => {
        throw new Error("stream broken");
      },
    };
    const model = new PiAnthropicRuntimeModel(CONFIG, deps);
    const turn = await model.chatStream([{ role: "user", content: "hello" }], []);
    expect(turn.kind).toBe("text");
  });

  test("postChatCompletion converts wire request to context and back", async () => {
    let capturedContext: unknown;
    const deps: PiAnthropicDeps = {
      complete: async (_model, context) => {
        capturedContext = context;
        return fakeAssistant({
          content: [{
            type: "toolCall",
            id: "call_42",
            name: "emit_rtl",
            arguments: {
              reasoning: "test reasoning",
              top_module: "a",
              sources: [{ path: "a.v", content: "module a; endmodule" }],
            },
          }],
          stopReason: "toolUse",
        });
      },
    };
    const model = new PiAnthropicRuntimeModel(CONFIG, deps);
    // Access the private method via the action client — generateRtl triggers postChatCompletion
    const result = await model.generateRtl("test task", "system prompt");
    expect(result.sources).toBeDefined();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]!.path).toBe("a.v");
    expect(result.topModule).toBe("a");
    expect(capturedContext).toBeDefined();
  });
});
