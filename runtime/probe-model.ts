/**
 * Synthia Runtime — Model capability probe.
 *
 * One-shot diagnostic: determines whether the internal OpenAI-compatible endpoint
 * (vLLM deepseek-v4-flash) supports (1) basic chat completions, (2) native tool /
 * function calling, and (3) response_format json_object. The result selects the
 * action protocol used by the loop (native tool calling preferred, else strict
 * JSON action protocol).
 *
 * Credentials are read ONLY from the environment; nothing is logged or printed.
 *
 * Run:
 *   env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
 *     SYNTHIA_MODEL_URL=... SYNTHIA_MODEL_KEY=... SYNTHIA_MODEL_NAME=... \
 *     bun run runtime/probe-model.ts
 */

// The internal endpoint is on a private address. The dev box has a dead proxy
// (127.0.0.1:65533) in its env; strip proxy vars so fetch connects directly.
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
  delete process.env[k];
}

export interface ProbeResult {
  readonly endpoint: string;
  readonly model: string;
  readonly checkedAt: string;
  readonly basicChat: { ok: boolean; httpStatus: number; sample?: string; error?: string; latencyMs: number };
  readonly toolCalling: { ok: boolean; httpStatus: number; hasToolCalls: boolean; error?: string; latencyMs: number };
  readonly jsonMode: { ok: boolean; httpStatus: number; parsesAsObject: boolean; error?: string; latencyMs: number };
  readonly recommendation: "tools" | "json";
}

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`probe: ${name} is required in the environment`);
  return v.trim();
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latencyMs: Date.now() - start };
}

async function postChat(baseUrl: string, apiKey: string, model: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown; text: string }> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, ...body }),
    // No proxy; direct connect.
  });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* keep undefined */ }
  return { status: res.status, json, text };
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>;
}
function firstContent(json: unknown): string | undefined {
  const choices = (json as ChatCompletion | undefined)?.choices;
  return choices?.[0]?.message?.content;
}
function hasToolCalls(json: unknown): boolean {
  const calls = (json as ChatCompletion | undefined)?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

export async function probeModel(opts: { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const baseUrl = (opts.baseUrl ?? envRequired("SYNTHIA_MODEL_URL")).replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? envRequired("SYNTHIA_MODEL_KEY");
  const model = opts.model ?? envRequired("SYNTHIA_MODEL_NAME");
  const base: Record<string, unknown> = { model, temperature: 0, max_tokens: 64 };

  // 1) basic chat
  let basicChat: ProbeResult["basicChat"];
  try {
    const { value, latencyMs } = await timed(() => postChat(baseUrl, apiKey, model, { ...base, messages: [{ role: "user", content: "Reply with exactly: pong" }] }));
    basicChat = { ok: value.status === 200, httpStatus: value.status, sample: firstContent(value.json)?.slice(0, 40), latencyMs };
  } catch (e) {
    basicChat = { ok: false, httpStatus: 0, error: e instanceof Error ? e.message : String(e), latencyMs: 0 };
  }

  // 2) tool calling
  let toolCalling: ProbeResult["toolCalling"];
  try {
    const { value, latencyMs } = await timed(() => postChat(baseUrl, apiKey, model, {
      ...base, max_tokens: 128,
      messages: [{ role: "user", content: "What is 7 + 5? Use the add tool." }],
      tools: [{
        type: "function",
        function: {
          name: "add",
          description: "Add two integers",
          parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] },
        },
      }],
      tool_choice: "auto",
    }));
    toolCalling = { ok: value.status === 200 && hasToolCalls(value.json), httpStatus: value.status, hasToolCalls: hasToolCalls(value.json), latencyMs };
  } catch (e) {
    toolCalling = { ok: false, httpStatus: 0, hasToolCalls: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 };
  }

  // 3) json mode
  let jsonMode: ProbeResult["jsonMode"];
  try {
    const { value, latencyMs } = await timed(() => postChat(baseUrl, apiKey, model, {
      ...base, max_tokens: 128,
      messages: [{ role: "user", content: 'Return JSON: {"sum": 12}' }],
      response_format: { type: "json_object" },
    }));
    const content = firstContent(value.json);
    let parsesAsObject = false;
    if (content) { try { const p = JSON.parse(content); parsesAsObject = typeof p === "object" && p !== null; } catch { /* false */ } }
    jsonMode = { ok: value.status === 200 && parsesAsObject, httpStatus: value.status, parsesAsObject, latencyMs };
  } catch (e) {
    jsonMode = { ok: false, httpStatus: 0, parsesAsObject: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 };
  }

  const recommendation: "tools" | "json" = toolCalling.ok ? "tools" : jsonMode.ok ? "json" : "json";
  return { endpoint: baseUrl, model, checkedAt: new Date().toISOString(), basicChat, toolCalling, jsonMode, recommendation };
}

if (import.meta.main) {
  probeModel()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error(`probe failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
