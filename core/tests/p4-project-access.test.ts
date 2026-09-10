import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import type { AuthenticatedIdentity } from "../src/api/auth.ts";
import type { ConnectorPort } from "../src/api/connector-port.ts";
import { DISABLED_CORE_FEATURE_FLAGS } from "../src/api/feature-flags.ts";
import type { RequestContext } from "../src/api/handlers.ts";
import { getP4FormalJobHandler } from "../src/api/p4-handlers.ts";
import { requireP4ProjectVisibility } from "../src/api/p4-project-access.ts";
import { routeApi } from "../src/api/router.ts";

function identity(
  actorType: "human" | "service",
  actorId: string,
  scopes: readonly string[],
): AuthenticatedIdentity {
  return { actorType, actorId, scopes, userId: `user-${actorId}` };
}

async function expectHidden(action: Promise<unknown>): Promise<void> {
  try {
    await action;
    throw new Error("expected project visibility to fail closed");
  } catch (error) {
    expect(error).toMatchObject({ code: "not_found", httpStatus: 404 });
  }
}

describe("P4 project visibility", () => {
  test("human and service role assignments are evaluated on every request, including revocation", async () => {
    let roleAssigned = true;
    const seen: Array<readonly unknown[] | undefined> = [];
    const query = {
      async query(_text: string, values?: readonly unknown[]) {
        seen.push(values);
        return { rows: roleAssigned ? [{ visible: 1 }] : [] };
      },
    };

    await requireP4ProjectVisibility(query, identity("human", "alice", ["core:read"]), "project-a");
    roleAssigned = false;
    await expectHidden(
      requireP4ProjectVisibility(query, identity("human", "alice", ["core:read"]), "project-a"),
    );
    roleAssigned = true;
    await requireP4ProjectVisibility(query, identity("service", "build-service", ["core:write"]), "project-a");

    expect(seen).toEqual([
      ["project-a", "human", "alice"],
      ["project-a", "human", "alice"],
      ["project-a", "service", "build-service"],
    ]);
  });

  test("core:admin is visible without a project role lookup", async () => {
    let queries = 0;
    const query = {
      async query() {
        queries += 1;
        throw new Error("admin visibility must not query mutable role state");
      },
    };
    await requireP4ProjectVisibility(
      query,
      identity("human", "platform-admin", ["core:admin", "core:read"]),
      "project-a",
    );
    expect(queries).toBe(0);
  });

  test("only a service actor bound to an active engineering main task gets runtime visibility", async () => {
    const activeRuntime = identity("service", "runtime-a", ["core:task-runtime"]);
    const queries: string[] = [];
    let taskActive = true;
    const query = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push(text);
        if (text.includes("role_assignment")) return { rows: [] };
        if (text.includes("agent_task")) {
          const [projectId, actorId] = values ?? [];
          return {
            rows: taskActive && projectId === "project-a" && actorId === "runtime-a"
              ? [{ visible: 1 }]
              : [],
          };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };

    await requireP4ProjectVisibility(query, activeRuntime, "project-a");
    taskActive = false;
    await expectHidden(requireP4ProjectVisibility(query, activeRuntime, "project-a"));
    taskActive = true;
    await expectHidden(requireP4ProjectVisibility(query, activeRuntime, "project-b"));
    await requireP4ProjectVisibility(
      query,
      identity("service", "runtime-a", ["core:read"]),
      "project-a",
    );
    await expectHidden(
      requireP4ProjectVisibility(query, identity("service", "unbound-service", ["core:read"]), "project-a"),
    );
    expect(queries.filter((text) => text.includes("agent_task"))).toHaveLength(5);
  });

  test("router returns the same 404 before entering a cross-project P4 handler", async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        if (text.includes("FROM auth_token")) {
          return {
            rows: [{
              scope: ["core:read"],
              expires_at: null,
              revoked_at: null,
              user_id: "user-outsider",
              uid: "outsider",
              actor_type: "human",
              status: "active",
            }],
          };
        }
        if (text.includes("SELECT project_type, process_version_id, process_profile_id")) {
          return {
            rows: [{
              project_type: "engineering",
              process_version_id: "GJB_REF_V1",
              process_profile_id: "GJB_REF_V1",
            }],
          };
        }
        if (text.includes("role_assignment")) return { rows: [] };
        throw new Error(`P4 handler was entered before visibility: ${text}`);
      },
    } as unknown as Pool;

    const response = await routeApi(
      new Request("http://local/api/v1/projects/secret-project/process-state", {
        headers: { authorization: "Bearer opaque-token" },
      }),
      pool,
      undefined,
      undefined,
      { ...DISABLED_CORE_FEATURE_FLAGS, formalDelivery: true },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatchObject({
      code: "not_found",
      message: "project not found: secret-project",
    });
    expect(queries).toHaveLength(3);
  });

  test("legacy project routes keep their existing behavior and do not require a P4 role", async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        if (text.includes("FROM auth_token")) {
          return {
            rows: [{
              scope: ["core:read"],
              expires_at: null,
              revoked_at: null,
              user_id: "user-legacy-reader",
              uid: "legacy-reader",
              actor_type: "human",
              status: "active",
            }],
          };
        }
        if (text.includes("SELECT project_type, process_version_id, process_profile_id")) {
          return {
            rows: [{
              project_type: "engineering",
              process_version_id: "LEGACY_COMPAT",
              process_profile_id: "LEGACY_COMPAT",
            }],
          };
        }
        if (text.includes("SELECT id, name, scope")) {
          return {
            rows: [{
              id: "legacy-project",
              name: "Legacy project",
              scope: "legacy",
              data_classification: "D1",
              standard_version: null,
              target_part: null,
              toolchain_profile_ref: null,
              status: "active",
              created_at: "2026-01-01T00:00:00.000Z",
              project_type: "engineering",
              process_profile_id: "LEGACY_COMPAT",
              process_profile_version: "v1",
              process_profile_name: "Legacy",
              process_version_id: "LEGACY_COMPAT",
            }],
          };
        }
        if (text.includes("FROM process_instance")) return { rows: [] };
        if (text.includes("FROM project_source_relation")) return { rows: [] };
        if (text.includes("role_assignment")) throw new Error("legacy route unexpectedly entered P4 ACL");
        throw new Error(`unexpected query: ${text}`);
      },
    } as unknown as Pool;

    const response = await routeApi(
      new Request("http://local/api/v1/projects/legacy-project", {
        headers: { authorization: "Bearer opaque-token" },
      }),
      pool,
      undefined,
      undefined,
      { ...DISABLED_CORE_FEATURE_FLAGS, formalDelivery: true },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: "legacy-project" });
    expect(queries.some((text) => text.includes("role_assignment"))).toBe(false);
  });
});

describe("feature-off formal Job reads", () => {
  test("returns the persisted snapshot without Connector calls or UPDATE statements", async () => {
    const sql: string[] = [];
    const pool = {
      async query(text: string) {
        sql.push(text);
        if (text.includes("SELECT id, project_type")) {
          return {
            rows: [{
              id: "project-a",
              project_type: "engineering",
              process_version_id: "GJB_REF_V1",
              process_profile_id: "GJB_REF_V1",
              process_profile_version: "GJB_REF_V1",
              target_part: "xc7a35t",
              toolchain_profile_ref: "a".repeat(64),
              data_classification: "D1",
            }],
          };
        }
        if (text.includes("FROM tool_run")) {
          return {
            rows: [{
              id: "formal-job-a",
              state: "running",
              operation: "implement",
              run_class: "formal",
              formal_input_approval_id: "approval-a",
              input_snapshot_id: "snapshot-a",
              input_hash: "b".repeat(64),
              toolchain_profile_hash: "a".repeat(64),
              error_code: null,
              output_sha256: null,
            }],
          };
        }
        throw new Error(`feature-off GET attempted a side effect: ${text}`);
      },
    } as unknown as Pool;
    let connectorCalls = 0;
    const connector = {
      connectorId: "must-not-be-used",
      async queryStatus() {
        connectorCalls += 1;
        throw new Error("feature-off GET contacted Connector");
      },
    } as unknown as ConnectorPort;
    const request = new Request("http://local/api/v1/projects/project-a/jobs/formal-job-a");
    const ctx: RequestContext = {
      pool,
      identity: identity("human", "reader", ["core:read"]),
      method: "GET",
      url: new URL(request.url),
      request,
      params: { projectId: "project-a", jobId: "formal-job-a" },
      body: null,
      correlationId: "corr-feature-off",
      idempotencyKey: null,
      classification: "D1",
      connector,
      runtimeActorId: "runtime-a",
      featureFlags: DISABLED_CORE_FEATURE_FLAGS,
    };

    const response = await getP4FormalJobHandler(ctx);
    expect(response).toEqual({
      status: 200,
      data: {
        jobId: "formal-job-a",
        state: "running",
        operation: "implement",
        runClass: "formal",
        formalInputApprovalId: "approval-a",
        inputSnapshotId: "snapshot-a",
        inputHash: "b".repeat(64),
        toolchainProfileHash: "a".repeat(64),
      },
    });
    expect(connectorCalls).toBe(0);
    expect(sql.some((text) => /^\s*UPDATE\b/i.test(text))).toBe(false);
  });

  test("feature-on keeps Connector polling and persists the refreshed state", async () => {
    let updated = false;
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        if (text.includes("SELECT id, project_type")) {
          return {
            rows: [{
              id: "project-a",
              project_type: "engineering",
              process_version_id: "GJB_REF_V1",
              process_profile_id: "GJB_REF_V1",
              process_profile_version: "GJB_REF_V1",
              target_part: "xc7a35t",
              toolchain_profile_ref: "a".repeat(64),
              data_classification: "D1",
            }],
          };
        }
        if (text.includes("FROM tool_run")) {
          return {
            rows: [{
              id: "formal-job-a",
              state: "running",
              operation: "implement",
              run_class: "formal",
              formal_input_approval_id: "approval-a",
              input_snapshot_id: "snapshot-a",
              input_hash: "b".repeat(64),
              toolchain_profile_hash: "a".repeat(64),
              error_code: null,
              output_sha256: null,
            }],
          };
        }
        if (/^\s*UPDATE tool_run\b/i.test(text)) {
          updated = true;
          expect(values?.slice(0, 4)).toEqual(["succeeded", null, "c".repeat(64), true]);
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    } as unknown as Pool;
    let connectorCalls = 0;
    const connector = {
      connectorId: "connector-a",
      async queryStatus() {
        connectorCalls += 1;
        return {
          jobId: "formal-job-a",
          state: "succeeded",
          outputSha256: "c".repeat(64),
        };
      },
    } as unknown as ConnectorPort;
    const request = new Request("http://local/api/v1/projects/project-a/jobs/formal-job-a");
    const response = await getP4FormalJobHandler({
      pool,
      identity: identity("human", "reader", ["core:read"]),
      method: "GET",
      url: new URL(request.url),
      request,
      params: { projectId: "project-a", jobId: "formal-job-a" },
      body: null,
      correlationId: "corr-feature-on",
      idempotencyKey: null,
      classification: "D1",
      connector,
      runtimeActorId: "runtime-a",
      featureFlags: { ...DISABLED_CORE_FEATURE_FLAGS, formalDelivery: true },
    });

    expect(response.data).toMatchObject({
      jobId: "formal-job-a",
      state: "succeeded",
      outputSha256: "c".repeat(64),
    });
    expect(connectorCalls).toBe(1);
    expect(updated).toBe(true);
  });
});
