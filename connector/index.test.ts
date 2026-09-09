import { describe, expect, test } from "bun:test";
import { FakeConnector, McpConnectorFacade } from "./index.ts";
describe("FakeConnector", () => { test("deterministic success hashes evidence", async () => { const c = new FakeConnector(); const j = await c.submit({ idempotencyKey: "k", projectId: "p", operation: "vivado_synthesize", runClass: "exploratory", input: "abc", correlationId: "c", outcome: "success" }); expect(j.state).toBe("succeeded"); expect(j.inputSha256).toHaveLength(64); expect(c.evidence(j.id).entries[0]?.sha256).toHaveLength(64); }); test("unknown effect is terminal and Tcl is fail closed", async () => { const c = new FakeConnector(); const j = await c.submit({ idempotencyKey: "u", projectId: "p", operation: "vivado_synthesize", runClass: "exploratory", input: "abc", correlationId: "c", outcome: "unknown_effect" }); expect(j.state).toBe("unknown_effect"); expect(() => new McpConnectorFacade(c).proposeTcl({ commands: ["exec rm -rf /"], purpose: "x" })).toThrow("TCL_POLICY_REJECTED"); }); });

test("generic Fake/MCP submit surfaces reject evolution_eval before creating a job", async () => {
  const connector = new FakeConnector();
  const request = { jobId: "forbidden-eval", idempotencyKey: "e", projectId: "p", operation: "vivado_synthesize", runClass: "evolution_eval" as const, input: "abc", correlationId: "c" };
  await expect(connector.submit(request)).rejects.toThrow("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
  expect(() => connector.status(request.jobId)).toThrow("JOB_NOT_FOUND");
  const facade = new McpConnectorFacade(connector);
  expect(() => facade.submit(request)).toThrow("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
  expect(() => connector.status(request.jobId)).toThrow("JOB_NOT_FOUND");
});
