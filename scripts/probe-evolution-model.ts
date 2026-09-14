// Probe: what does GLM actually return for a distiller-shaped prompt?
import { createRuntimeModelFromEnv } from "../runtime/pi-responses-model.ts";
import { DISTILLER_SYSTEM_PROMPT } from "../runtime/evolution-workers.ts";

const model = createRuntimeModelFromEnv();
const userPrompt = JSON.stringify({
  schema: "distillation-input.v1",
  episode: {
    objective: "用 Vivado validate_sources 检查 uart_tx.v 与 baud_gen.v，修复语法/综合问题并回报",
    outcome: "succeeded",
    tool_events: [
      { operation: "validate_sources", status: "succeeded", note: "两个文件通过检查，baud_gen 的参数默认值被显式化" },
    ],
    workspace_files: [
      { path: "rtl/uart_tx.v", change: "parameter 注释补全" },
      { path: "rtl/baud_gen.v", change: "无实质修改" },
    ],
    human_correction: null,
  },
  existing_skills: [],
});

const turn = await model.chat(
  [
    { role: "system", content: DISTILLER_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ],
  Object.freeze([]) as never,
);
const row = turn as Record<string, unknown>;
console.log("kind:", row.kind);
const content = String(row.content ?? "");
console.log("first 80 chars:", JSON.stringify(content.slice(0, 80)));
console.log("last 40 chars:", JSON.stringify(content.slice(-40)));
try {
  const parsed = JSON.parse(content);
  console.log("STRICT JSON OK:", Object.keys(parsed));
} catch {
  console.log("STRICT JSON FAIL");
}
