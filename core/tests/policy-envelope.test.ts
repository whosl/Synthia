import { describe, expect, test } from "bun:test";
import { authorize, type AuthorizationContext, type PolicyDefinition } from "../src/policy.ts";
import { actor, makeCommand, makeError } from "../src/envelope.ts";

const context: AuthorizationContext = { actorType: "human", actorId: "h", projectId: "p", roles: ["quality"], operation: "tool_submit", runClass: "formal", dataClassification: "D2", resource: "run:1" };
const allow: PolicyDefinition = { rules: [{ effect: "allow", actorTypes: ["human"], actorIds: ["h"], projectIds: ["p"], roles: ["quality"], operations: ["tool_submit"], runClasses: ["formal"], dataClassifications: ["D2"], resources: ["run:1"] }] };

describe("structured RBAC and envelope", () => {
  test("all authorization dimensions must match", () => {
    expect(authorize(allow, context).authorized).toBe(true);
    expect(authorize(allow, { ...context, projectId: "other" }).authorized).toBe(false);
    expect(authorize(allow, { ...context, dataClassification: "D3" }).authorized).toBe(false);
    expect(authorize(allow, { ...context, resource: "run:2" }).authorized).toBe(false);
    expect(authorize(allow, { ...context, runClass: "exploratory" }).authorized).toBe(false);
  });

  test("explicit deny wins over allow", () => {
    const policy: PolicyDefinition = { rules: [...allow.rules, { effect: "deny", projectIds: ["p"], operations: ["tool_submit"] }] };
    expect(authorize(policy, context)).toMatchObject({ authorized: false, reason: "deny_rule" });
  });

  test("agent cannot approve baseline publish or hardware write", () => {
    for (const operation of ["approve", "baseline", "publish", "hardware_write"] as const) {
      const decision = authorize({ agentPriority: "P3", rules: [{ effect: "allow" }] }, { ...context, actorType: "agent", operation });
      expect(decision).toMatchObject({ authorized: false, reason: "agent_forbidden_operation" });
    }
  });

  test("stable envelopes propagate audit metadata and errors", () => {
    const command = makeCommand({ commandId: "cmd", correlationId: "corr", causationId: "cause", actor: actor("human", "h", "quality"), projectId: "p", expectedVersion: 7, classification: "D2", payload: {} });
    expect(command).toMatchObject({ correlationId: "corr", causationId: "cause", classification: "D2", expectedVersion: 7 });
    expect(makeError({ code: "conflict", message: "version", correlationId: command.correlationId, commandId: command.commandId, causationId: command.causationId, classification: command.classification })).toMatchObject({ error: { code: "conflict", retryable: false }, correlationId: "corr", causationId: "cause", classification: "D2" });
  });
});
