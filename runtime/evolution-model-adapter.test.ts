import { describe, expect, test } from "bun:test";
import type {
  AgentMessage,
  AgentTool,
  ChatTurn,
  ConversationalModel,
} from "./agent-types.ts";
import {
  EvolutionModelAdapter,
  EvolutionModelAdapterError,
} from "./evolution-model-adapter.ts";
import type { EvolutionJsonModelRequest } from "./evolution-workers.ts";

const REQUEST: EvolutionJsonModelRequest = {
  purpose: "distillation",
  systemPrompt: "Return exactly one JSON object.",
  userPrompt: "Distill this sealed trajectory.",
  maxOutputBytes: 1_024,
};

class RecordingModel implements ConversationalModel {
  readonly calls: Array<{
    readonly messages: readonly AgentMessage[];
    readonly tools: readonly AgentTool[];
  }> = [];

  constructor(private readonly result: ChatTurn | Error) {}

  async chat(messages: readonly AgentMessage[], tools: readonly AgentTool[]): Promise<ChatTurn> {
    this.calls.push({ messages, tools });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function adapterFor(turn: ChatTurn): EvolutionModelAdapter {
  return new EvolutionModelAdapter(new RecordingModel(turn), "model-v1");
}

async function expectMalformed(promise: Promise<unknown>): Promise<EvolutionModelAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EvolutionModelAdapterError);
    expect(error).toMatchObject({ code: "MALFORMED_MODEL_OUTPUT", retryable: false });
    return error as EvolutionModelAdapterError;
  }
  throw new Error("expected EvolutionModelAdapterError");
}

describe("EvolutionModelAdapter", () => {
  test("parses one strict JSON object and sends exactly system + user with no tools", async () => {
    const model = new RecordingModel({ kind: "text", content: "{\"action\":\"no_op\"}" });
    const adapter = new EvolutionModelAdapter(model, "model-v1");

    await expect(adapter.generateJson(REQUEST)).resolves.toEqual({ action: "no_op" });
    expect(adapter.modelId).toBe("model-v1");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.messages).toEqual([
      { role: "system", content: REQUEST.systemPrompt },
      { role: "user", content: REQUEST.userPrompt },
    ]);
    expect(model.calls[0]!.messages).toHaveLength(2);
    expect(model.calls[0]!.tools).toEqual([]);
    expect(Object.isFrozen(model.calls[0]!.messages)).toBe(true);
    expect(Object.isFrozen(model.calls[0]!.tools)).toBe(true);
  });

  test("rejects a tool-call turn even when it also carries JSON text", async () => {
    await expectMalformed(adapterFor({
      kind: "tool_calls",
      calls: [{ toolCallId: "call-1", name: "vivado_run", args: {} }],
      content: "{\"action\":\"no_op\"}",
    }).generateJson(REQUEST));
  });

  test.each([
    ["markdown fence", "```json\n{\"action\":\"no_op\"}\n```"],
    ["leading commentary", "Here is the result: {\"action\":\"no_op\"}"],
    ["trailing commentary", "{\"action\":\"no_op\"} done"],
    ["invalid JSON", "{\"action\":"],
  ])("rejects %s instead of salvaging JSON", async (_label, content) => {
    await expectMalformed(adapterFor({ kind: "text", content }).generateJson(REQUEST));
  });

  test.each(["", "  \n\t  "])("rejects empty text %#", async (content) => {
    await expectMalformed(adapterFor({ kind: "text", content }).generateJson(REQUEST));
  });

  test("enforces maxOutputBytes using UTF-8 bytes", async () => {
    const content = "{\"value\":\"进化🚀\"}";
    const bytes = Buffer.byteLength(content, "utf8");
    expect(content.length).toBeLessThan(bytes);

    const adapter = adapterFor({ kind: "text", content });
    await expectMalformed(adapter.generateJson({ ...REQUEST, maxOutputBytes: bytes - 1 }));

    await expect(adapterFor({ kind: "text", content }).generateJson({
      ...REQUEST,
      maxOutputBytes: bytes,
    })).resolves.toEqual({ value: "进化🚀" });
  });

  test.each([
    ["array", "[]"],
    ["string", "\"value\""],
    ["number", "1"],
    ["null", "null"],
  ])("rejects a top-level JSON %s", async (_label, content) => {
    await expectMalformed(adapterFor({ kind: "text", content }).generateJson(REQUEST));
  });

  test("rejects malformed or mixed-content turn shapes", async () => {
    const malformedModel: ConversationalModel = {
      async chat() {
        return {
          kind: "text",
          content: "{\"action\":\"no_op\"}",
          calls: [],
        } as unknown as ChatTurn;
      },
    };
    await expectMalformed(new EvolutionModelAdapter(malformedModel, "model-v1").generateJson(REQUEST));

    const nonTextModel: ConversationalModel = {
      async chat() {
        return { kind: "text", content: null } as unknown as ChatTurn;
      },
    };
    await expectMalformed(new EvolutionModelAdapter(nonTextModel, "model-v1").generateJson(REQUEST));
  });

  test.each([true, false])("preserves a model error with retryable=%s", async (retryable) => {
    const original = Object.assign(new Error("upstream model failed"), {
      code: retryable ? "MODEL_BUSY" : "MODEL_REJECTED",
      retryable,
    });
    const adapter = new EvolutionModelAdapter(new RecordingModel(original), "model-v1");

    try {
      await adapter.generateJson(REQUEST);
      throw new Error("expected model error");
    } catch (error) {
      expect(error).toBe(original);
      expect(error).toMatchObject({ retryable });
    }
  });

  test("abort detaches a conversational model that never resolves", async () => {
    let observedSignal: AbortSignal | undefined;
    const model: ConversationalModel = {
      async chat(_messages, _tools, signal) {
        observedSignal = signal;
        return await new Promise<ChatTurn>(() => {});
      },
    };
    const controller = new AbortController();
    const result = new EvolutionModelAdapter(model, "model-v1")
      .generateJson(REQUEST, controller.signal);
    controller.abort(new DOMException("service stopping", "AbortError"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
  });

  test("rejects extra request facts such as lease tokens before calling the model", async () => {
    const model = new RecordingModel({ kind: "text", content: "{}" });
    const adapter = new EvolutionModelAdapter(model, "model-v1");
    const requestWithLease = {
      ...REQUEST,
      lease_token: "must-not-enter-the-model-context",
    } as unknown as EvolutionJsonModelRequest;

    await expectMalformed(adapter.generateJson(requestWithLease));
    expect(model.calls).toHaveLength(0);
  });

  test("has no Connector, governance, project-write, or lease API surface", () => {
    const adapter = new EvolutionModelAdapter(
      new RecordingModel({ kind: "text", content: "{}" }),
      "model-v1",
    );
    const ownSurface = Reflect.ownKeys(adapter).map(String);
    const prototypeSurface = Reflect.ownKeys(Object.getPrototypeOf(adapter)).map(String);
    const surface = [...ownSurface, ...prototypeSurface].join(" ").toLowerCase();

    expect(ownSurface).toEqual(["modelId"]);
    expect(prototypeSurface.sort()).toEqual(["constructor", "generateJson"].sort());
    expect(surface).not.toContain("connector");
    expect(surface).not.toContain("governance");
    expect(surface).not.toContain("workspace");
    expect(surface).not.toContain("project");
    expect(surface).not.toContain("lease");
  });

  test.each(["", "   ", "x".repeat(513)])("rejects invalid model id %#", (modelId) => {
    expect(() => new EvolutionModelAdapter(
      new RecordingModel({ kind: "text", content: "{}" }),
      modelId,
    )).toThrow(TypeError);
  });
});
