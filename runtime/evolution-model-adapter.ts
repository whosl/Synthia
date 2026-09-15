/**
 * Capability-narrow adapter from the Runtime conversational model to the
 * strict-JSON primitive used by the self-evolution workers.
 *
 * This adapter deliberately exposes no tools, Connector, governance, workspace,
 * or lease capability. Model failures are allowed to escape unchanged so their
 * retryability classification is preserved for the worker.
 */

import type {
  AgentMessage,
  AgentTool,
  ChatTurn,
  ConversationalModel,
} from "./agent-types.ts";
import type {
  EvolutionJsonModel,
  EvolutionJsonModelRequest,
} from "./evolution-workers.ts";

const REQUEST_KEYS = ["maxOutputBytes", "purpose", "systemPrompt", "userPrompt"] as const;
const TEXT_TURN_KEYS = ["content", "kind"] as const;
const NO_TOOLS: readonly AgentTool[] = Object.freeze([]);

/** Stable, non-retryable failure for an invalid adapter request or model turn. */
export class EvolutionModelAdapterError extends Error {
  readonly code = "MALFORMED_MODEL_OUTPUT";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "EvolutionModelAdapterError";
  }
}

/**
 * Adapts an existing {@link ConversationalModel} without granting the
 * self-evolution worker any of the free Agent's tool or execution surface.
 */
export class EvolutionModelAdapter implements EvolutionJsonModel {
  readonly modelId: string;
  readonly #model: ConversationalModel;

  constructor(model: ConversationalModel, modelId: string) {
    if (typeof modelId !== "string" || modelId.trim() === "" || Buffer.byteLength(modelId, "utf8") > 512) {
      throw new TypeError("modelId must be a non-empty string up to 512 bytes");
    }
    this.#model = model;
    this.modelId = modelId;
  }

  async generateJson(
    request: EvolutionJsonModelRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    validateRequest(request);
    throwIfAborted(signal);

    const messages: readonly AgentMessage[] = Object.freeze([
      Object.freeze({ role: "system" as const, content: request.systemPrompt }),
      Object.freeze({ role: "user" as const, content: request.userPrompt }),
    ]);

    // Do not catch here. In particular, a model error's `retryable` fact must
    // reach EvolutionWorker.failureFor unchanged.
    const turn: ChatTurn = await abortable(this.#model.chat(messages, NO_TOOLS, signal), signal);
    const content = strictTextContent(turn);

    if (content.trim() === "") {
      malformed("model returned empty text");
    }
    if (Buffer.byteLength(content, "utf8") > request.maxOutputBytes) {
      malformed("model output exceeds maxOutputBytes");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      malformed("model output is not strict JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed("model output must be one JSON object");
    }
    return parsed;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("self-evolution model request aborted", "AbortError");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function validateRequest(request: EvolutionJsonModelRequest): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    malformed("request must be an EvolutionJsonModelRequest object");
  }
  const actualKeys = Object.keys(request).sort();
  if (
    actualKeys.length !== REQUEST_KEYS.length
    || actualKeys.some((key, index) => key !== REQUEST_KEYS[index])
  ) {
    malformed("request fields do not match EvolutionJsonModelRequest");
  }
  if (request.purpose !== "distillation" && request.purpose !== "curation") {
    malformed("request purpose is not supported");
  }
  if (typeof request.systemPrompt !== "string" || typeof request.userPrompt !== "string") {
    malformed("request prompts must be strings");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    malformed("request maxOutputBytes must be a positive safe integer");
  }
}

function strictTextContent(turn: unknown): string {
  if (turn === null || typeof turn !== "object" || Array.isArray(turn)) {
    malformed("model did not return a text turn");
  }
  const row = turn as Record<string, unknown>;
  // ChatTurn legitimately carries transport metadata beyond {kind, content}
  // (e.g. the optional usage block), so unknown extra fields are tolerated.
  // A tool-call list on a claimed text turn is still mixed content and stays
  // rejected — the strict JSON contract has no tool surface to consume it.
  if (row.kind !== "text" || typeof row.content !== "string" || row.calls !== undefined) {
    malformed("model did not return one pure text turn");
  }
  return row.content as string;
}

function malformed(message: string): never {
  throw new EvolutionModelAdapterError(message);
}
