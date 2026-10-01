import { ModelClient, modelConfigFromEnv } from "./model-client.ts";
import { PiAnthropicRuntimeModel } from "./pi-anthropic-model.ts";
import type { ConversationalModel } from "./agent-types.ts";
import type { LoopModel } from "./types.ts";

export type ModelApiMode = "chat-completions" | "anthropic-messages";
export type RuntimeModel = LoopModel & ConversationalModel;

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

export function createRuntimeModelFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeModel {
  const config = modelConfigFromEnv(env);
  const mode = modelApiModeFromEnv(env);
  if (mode === "anthropic-messages") return new PiAnthropicRuntimeModel(config);
  return new ModelClient(config);
}
