import { describe, expect, test } from "bun:test";
import { createRuntimeModelFromEnv, modelApiModeFromEnv } from "./runtime-model.ts";
import { ModelClient } from "./model-client.ts";
import { PiAnthropicRuntimeModel } from "./pi-anthropic-model.ts";

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
      SYNTHIA_MODEL_URL: "https://model.example/v1",
      SYNTHIA_MODEL_KEY: "secret",
      SYNTHIA_MODEL_NAME: "gpt-test",
    };
    expect(createRuntimeModelFromEnv(env)).toBeInstanceOf(ModelClient);
  });

  test("factory builds the Anthropic client for Messages mode", () => {
    expect(createRuntimeModelFromEnv({
      SYNTHIA_MODEL_API: "messages",
      SYNTHIA_MODEL_URL: "https://model.example/v1",
      SYNTHIA_MODEL_KEY: "secret",
      SYNTHIA_MODEL_NAME: "claude-test",
    })).toBeInstanceOf(PiAnthropicRuntimeModel);
  });
});
