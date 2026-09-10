/**
 * One-shot live probe for the pi-anthropic transport (run manually, never in CI).
 *
 * Usage:
 *   SYNTHIA_MODEL_URL=https://open.bigmodel.cn/api/anthropic \
 *   SYNTHIA_MODEL_KEY=... SYNTHIA_MODEL_NAME=glm-4.6 \
 *   bun run runtime/probe-anthropic.ts
 */

for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
  delete process.env[k];
}

import { PiAnthropicRuntimeModel } from "./pi-anthropic-model.ts";
import { modelConfigFromEnv } from "./model-client.ts";
import type { AgentTool } from "./agent-types.ts";

const config = modelConfigFromEnv();
const model = new PiAnthropicRuntimeModel({ ...config, timeoutMs: 60_000, networkRetries: 1 });

const addTool: AgentTool = {
  name: "add",
  description: "Add two integers",
  parameters: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
  },
  async execute(args: Record<string, unknown>) {
    return String(Number(args.a) + Number(args.b));
  },
};

// 1) basic chat
try {
  const start = Date.now();
  const turn = await model.chat(
    [{ role: "user", content: "Reply with exactly: pong" }],
    [],
  );
  console.log(`[chat] kind=${turn.kind} content=${JSON.stringify(turn.kind === "text" ? turn.content : null)} latency=${Date.now() - start}ms`);
} catch (e) {
  console.error(`[chat] FAILED: ${e instanceof Error ? e.message : String(e)}`);
}

// 2) tool calling
try {
  const start = Date.now();
  const turn = await model.chat(
    [{ role: "user", content: "What is 7 + 5? Use the add tool." }],
    [addTool],
  );
  if (turn.kind === "tool_calls") {
    console.log(`[tool] calls=${JSON.stringify(turn.calls)} latency=${Date.now() - start}ms`);
  } else {
    console.log(`[tool] no tool_calls, text=${JSON.stringify(turn.content)} latency=${Date.now() - start}ms`);
  }
} catch (e) {
  console.error(`[tool] FAILED: ${e instanceof Error ? e.message : String(e)}`);
}

// 3) pipeline action (intake doc — lightest LoopModel phase)
try {
  const start = Date.now();
  const doc = await model.generateIntake(
    "Design a UART controller: 115200 baud, 8N1, 16-byte RX FIFO.",
    "You are an FPGA requirements engineer. Produce a concise 研制任务书-style intake document in Markdown. Return the document via the provided action tool.",
  );
  console.log(`[intake] ok docPath=${JSON.stringify(doc.docPath)} bytes=${doc.content.length} latency=${Date.now() - start}ms`);
} catch (e) {
  console.error(`[intake] FAILED: ${e instanceof Error ? e.message : String(e)}`);
}
