import { describe, expect, test } from "bun:test";
import {
  PiAnthropicRuntimeModel,
  type PiAnthropicDeps,
} from "./pi-anthropic-model.ts";
import type { ModelClientConfig } from "./model-client.ts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";

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
    expect(turn.stopReason).toBe("end_turn");
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
    expect(turn.stopReason).toBe("tool_use");
    if (turn.kind === "tool_calls") {
      expect(turn.calls).toHaveLength(1);
      expect(turn.calls[0]!.name).toBe("emit_rtl");
    }
  });

  test("H38 buffered pi length is exposed as max_tokens, including empty text", async () => {
    for (const content of ["继续读取：", ""]) {
      const model = new PiAnthropicRuntimeModel(CONFIG, {
        complete: async () => fakeAssistant({ stopReason: "length", content: [{ type: "text", text: content }] }),
      });
      const turn = await model.chat([{ role: "user", content: "test" }], []);
      expect(turn).toMatchObject({ kind: "text", content, stopReason: "max_tokens" });
    }
  });

  test("H38 streaming completion retains length and deltas; default thinking options stay unset", async () => {
    const partial = fakeAssistant({ stopReason: "length", content: [{ type: "text", text: "先读：" }] });
    const deltas: string[] = [];
    const model = new PiAnthropicRuntimeModel(CONFIG, {
      stream: (_model, _context, options) => {
        expect(options).not.toHaveProperty("thinkingEnabled");
        expect(options).not.toHaveProperty("thinkingBudgetTokens");
        expect(options).not.toHaveProperty("effort");
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "先读：", partial });
        stream.push({ type: "done", reason: "length", message: partial });
        return stream;
      },
    });
    const turn = await model.chatStream([{ role: "user", content: "test" }], [], { onDelta: delta => deltas.push(delta) });
    expect(turn).toMatchObject({ kind: "text", content: "先读：", stopReason: "max_tokens" });
    expect(deltas).toEqual(["先读："]);
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

// ---------------------------------------------------------------------------
// P1: transient transport retry (T1 AES run: one socket drop killed a turn)
// ---------------------------------------------------------------------------

describe("PiAnthropicRuntimeModel transport retry (P1)", () => {
  function okAssistant(): AssistantMessage {
    return fakeAssistant();
  }

  test("a transient socket-close error is retried and the turn survives", async () => {
    let calls = 0;
    const deps: PiAnthropicDeps = {
      complete: async () => {
        calls++;
        if (calls === 1) throw new Error("The socket connection was closed unexpectedly.");
        return okAssistant();
      },
    };
    const model = new PiAnthropicRuntimeModel({ ...CONFIG, networkRetries: 2 }, deps);
    const turn = await model.chat([{ role: "user", content: "hi" }], []);
    expect(turn.kind).toBe("text");
    expect(calls).toBe(2);
  });

  test("non-transient errors are not retried", async () => {
    let calls = 0;
    const deps: PiAnthropicDeps = {
      complete: async () => {
        calls++;
        throw new Error("401 invalid api key");
      },
    };
    const model = new PiAnthropicRuntimeModel({ ...CONFIG, networkRetries: 2 }, deps);
    expect(model.chat([{ role: "user", content: "hi" }], [])).rejects.toThrow("401");
    await new Promise(r => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  test("retry budget exhausted rethrows the last transport error", async () => {
    let calls = 0;
    const deps: PiAnthropicDeps = {
      complete: async () => {
        calls++;
        throw new Error("fetch failed: ECONNRESET");
      },
    };
    const model = new PiAnthropicRuntimeModel({ ...CONFIG, networkRetries: 1 }, deps);
    await expect(model.chat([{ role: "user", content: "hi" }], [])).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(2); // 1 + 1 retry
  });
});

describe("Anthropic context accounting", () => {
  test("includes cache-read and cache-write input, without counting output as context input", async () => {
    const response = fakeAssistant();
    response.usage = { ...response.usage, input: 100, cacheRead: 800, cacheWrite: 200, output: 50, totalTokens: 1150 };
    const model = new PiAnthropicRuntimeModel(CONFIG, { complete: async () => response });
    const turn = await model.chat([{ role: "user", content: "hello" }], []);
    expect(turn.usage).toEqual({ promptTokens: 1100, completionTokens: 50 });
  });
});

describe("H36 Anthropic transport cancellation", () => {
  test("buffered abort reaches the provider and does not enter transport retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = new PiAnthropicRuntimeModel(CONFIG, { complete: async (_model, _context, options) => {
      calls++;
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error("watchdog aborted"));
      throw new Error("fetch aborted");
    } });
    await expect(model.chat([{ role: "user", content: "test" }], [], controller.signal)).rejects.toThrow("watchdog aborted");
    expect(calls).toBe(1);
  });
  test("stream cancellation reaches the provider and never falls back to buffered", async () => {
    const controller = new AbortController();
    let buffered = 0;
    const model = new PiAnthropicRuntimeModel(CONFIG, {
      complete: async () => { buffered++; return fakeAssistant(); },
      stream: (_model, _context, options) => {
        expect(options?.signal?.aborted).toBe(false);
        controller.abort(new Error("watchdog aborted"));
        expect(options?.signal?.aborted).toBe(true);
        throw new Error("fetch aborted");
      },
    });
    await expect(model.chatStream([{ role: "user", content: "test" }], [], { signal: controller.signal })).rejects.toThrow("watchdog aborted");
    expect(buffered).toBe(0);
  });
});
