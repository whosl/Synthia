import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorDiagnostic, MAX_ERROR_DIAGNOSTIC_CHARS } from "./error-diagnostic.ts";
import { listAgents } from "./agent-state.ts";
import { loadFreeAgentConversation } from "./free-agent.ts";

test("H45 diagnostics retain stack and nested cause and bound long/cyclic errors", () => {
  const cause = new Error("connection reset at project-state write");
  const error = new Error("internal error", { cause });
  expect(errorDiagnostic(error)).toContain("Caused by: Error: connection reset");
  expect(errorDiagnostic(error)).toContain("closeout.test.ts");
  cause.cause = error;
  expect(errorDiagnostic(error)).toContain("cyclic cause");
  expect(errorDiagnostic(new Error("x".repeat(30_000))).length).toBeLessThanOrEqual(MAX_ERROR_DIAGNOSTIC_CHARS);
  expect(errorDiagnostic("non-Error throw")).toBe("non-Error throw");
});

test("H46 state recovery skips AppleDouble but still loads valid conversations and rejects corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthia-h46-"));
  const previous = process.env.SYNTHIA_RUNS_DIR;
  process.env.SYNTHIA_RUNS_DIR = root;
  try {
    await writeFile(join(root, "._agent-real.json"), "resource fork");
    await writeFile(join(root, "._agent-real.conversation.json"), "resource fork");
    await writeFile(join(root, "agent-real.json"), "{}");
    await writeFile(join(root, "agent-real.conversation.json"), JSON.stringify({ agentId: "agent-real", messages: [{ role: "user", content: "resume" }] }));
    expect(await listAgents()).toEqual(["agent-real"]);
    expect(await loadFreeAgentConversation("._agent-real", root)).toBeNull();
    expect((await loadFreeAgentConversation("agent-real", root))?.messages.length).toBe(1);
    await writeFile(join(root, "agent-real.conversation.json"), "corrupt");
    await expect(loadFreeAgentConversation("agent-real", root)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.SYNTHIA_RUNS_DIR; else process.env.SYNTHIA_RUNS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
