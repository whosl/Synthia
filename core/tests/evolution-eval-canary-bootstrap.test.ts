import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  M4F_CANARY_BOOTSTRAP_AUTHORIZATION,
  bootstrapM4fCanary,
  resolveM4fCanaryBootstrapConfig,
  writeM4fCanaryBinding,
  type M4fCanaryBootstrapConfig,
} from "../scripts/bootstrap-evolution-eval-canary-m4f.ts";
import { verifyM4fCanaryInDatabase } from "../scripts/certify-evolution-eval-m4f.ts";
import { issueM4fEvolutionEvalCanaryHandler } from "../src/api/evolution-eval-canary-handlers.ts";
import type { RequestContext } from "../src/api/handlers.ts";
import { evolutionEvalCanonicalHash } from "../src/domain/evolution-eval.ts";
import {
  M4F_CANARY_BINDING_ISSUED_SCHEMA,
  M4F_CANARY_BOOTSTRAP_SCHEMA,
  M4F_CANARY_EXPIRED_DEADLINE,
  buildM4fCanaryBinding,
  parseM4fCanaryBootstrapRequest,
  type M4fCanaryBootstrapRequestV1,
} from "../src/services/evolution-eval-canary-bootstrap.ts";
import {
  effectiveEvolutionEvalTimeoutMs,
  validateCoreIssuedEvalBinding,
} from "../../connector/evolution-eval.ts";

const HASH_A = "a".repeat(64);
const DATABASE = "synthia-selfevo-gate-success-test";
const GATE = "gate-success-test";
const PROJECT = "m4f-success-canary";
const PART = "xc7k70tfbv676-1";
const temporaryPaths: string[] = [];

function request(
  overrides: Partial<M4fCanaryBootstrapRequestV1> = {},
): M4fCanaryBootstrapRequestV1 {
  return {
    schema: M4F_CANARY_BOOTSTRAP_SCHEMA,
    database_name: DATABASE,
    gate_id: GATE,
    scenario: "success",
    project_id: PROJECT,
    target_part: PART,
    toolchain_profile_hash: HASH_A,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M4-F canary binding construction", () => {
  test("strictly parses the DTO and rejects unknown or non-Gate inputs", () => {
    expect(parseM4fCanaryBootstrapRequest(request())).toEqual(request());
    expect(() => parseM4fCanaryBootstrapRequest({ ...request(), extra: true })).toThrow("exactly");
    expect(() => parseM4fCanaryBootstrapRequest({
      ...request(),
      database_name: "synthia-production",
    })).toThrow("dedicated");
    expect(() => parseM4fCanaryBootstrapRequest({
      ...request(),
      scenario: "other",
    })).toThrow("success or failure-quarantine");
  });

  test("mints a strict but permanently non-submittable Connector binding", () => {
    const built = buildM4fCanaryBinding(request());
    const validated = validateCoreIssuedEvalBinding(built.binding, PROJECT);
    expect(validated).toEqual(built.binding);
    expect(built.bindingHash).toBe(evolutionEvalCanonicalHash(validated));
    expect(validated.dispatch.deadline_at).toBe(M4F_CANARY_EXPIRED_DEADLINE);
    expect(validated.dispatch.requested_timeout_ms).toBe(1);
    expect(() => effectiveEvolutionEvalTimeoutMs(validated, new Date("2026-08-29T00:00:00.000Z")))
      .toThrow("deadline has elapsed");
  });

  test("binds database and scenario into all remote identities", () => {
    const success = buildM4fCanaryBinding(request());
    const failure = buildM4fCanaryBinding(request({
      database_name: "synthia-selfevo-gate-failure-test",
      gate_id: "gate-failure-test",
      scenario: "failure-quarantine",
      project_id: "m4f-failure-canary",
    }));
    expect(failure.requestHash).not.toBe(success.requestHash);
    expect(failure.bindingHash).not.toBe(success.bindingHash);
    expect(failure.binding.dispatch.connector_job_id)
      .not.toBe(success.binding.dispatch.connector_job_id);
    expect(failure.binding.dispatch.connector_idempotency_key)
      .not.toBe(success.binding.dispatch.connector_idempotency_key);
  });
});

class FakeCanaryConnection {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  stored: Record<string, unknown> | null = null;
  businessCounts = { eval_jobs: 0, applications: 0, curator_runs: 0, distillation_runs: 0 };

  async query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("LOCK TABLE")) return { rows: [] };
    if (sql.includes("current_database() AS name")) return { rows: [{ name: DATABASE }] };
    if (sql.includes("FROM project") && sql.includes("FOR UPDATE")) {
      return { rows: [{
        id: PROJECT,
        project_type: "free",
        target_part: PART,
        toolchain_profile_ref: HASH_A,
        status: "active",
      }] };
    }
    if (sql.startsWith("SELECT * FROM evolution_eval_canary_binding")) {
      return { rows: this.stored === null ? [] : [this.stored] };
    }
    if (sql.includes("AS eval_jobs") && sql.includes("AS applications")) {
      return { rows: [this.businessCounts] };
    }
    if (sql.includes("INSERT INTO evolution_eval_canary_binding")) {
      const binding = JSON.parse(String(values?.[6]));
      this.stored = {
        database_name: values?.[0],
        gate_id: values?.[1],
        scenario: values?.[2],
        project_id: values?.[3],
        request_hash: values?.[4],
        binding_hash: values?.[5],
        binding,
        issued_at: "2026-08-29T00:00:00.000Z",
      };
      return { rows: [this.stored] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  release(): void {}
}

function handlerContext(
  connection: FakeCanaryConnection,
  body: unknown = request(),
  identity: RequestContext["identity"] = {
    actorType: "human",
    actorId: "m4f-admin",
    userId: "usr-admin",
    scopes: ["core:admin", "core:write", "core:read"],
  },
): RequestContext {
  return {
    pool: { connect: async () => connection } as unknown as RequestContext["pool"],
    identity,
    method: "POST",
    url: new URL("http://127.0.0.1:8787/api/v1/evolution/m4f-canary-bindings"),
    request: new Request("http://127.0.0.1:8787/api/v1/evolution/m4f-canary-bindings"),
    params: {},
    body,
    correlationId: "corr-canary-test",
    idempotencyKey: null,
    classification: "D1",
    runtimeActorId: "synthia-runtime",
  };
}

describe("M4-F canary issuance handler", () => {
  test("issues once and replays the byte-equivalent binding", async () => {
    const connection = new FakeCanaryConnection();
    const first = await issueM4fEvolutionEvalCanaryHandler(handlerContext(connection));
    const second = await issueM4fEvolutionEvalCanaryHandler(handlerContext(connection));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((first.data as Record<string, unknown>).replayed).toBe(false);
    expect((second.data as Record<string, unknown>).replayed).toBe(true);
    expect((second.data as Record<string, unknown>).binding)
      .toEqual((first.data as Record<string, unknown>).binding);
    expect(connection.calls.filter((call) => call.sql.includes("INSERT INTO evolution_eval_canary_binding")))
      .toHaveLength(1);

    const firstTransaction = connection.calls.slice(
      0,
      connection.calls.findIndex((call) => call.sql === "COMMIT") + 1,
    );
    const advisoryIndex = firstTransaction.findIndex((call) => call.sql.includes("pg_advisory_xact_lock"));
    const lockIndex = firstTransaction.findIndex((call) => call.sql.includes("LOCK TABLE"));
    const databaseIndex = firstTransaction.findIndex((call) => call.sql.includes("current_database() AS name"));
    const projectIndex = firstTransaction.findIndex((call) => call.sql.includes("FROM project"));
    const countsIndex = firstTransaction.findIndex((call) => call.sql.includes("AS eval_jobs"));
    const insertIndex = firstTransaction.findIndex((call) => call.sql.includes("INSERT INTO evolution_eval_canary_binding"));
    expect(advisoryIndex).toBeGreaterThan(0);
    expect(advisoryIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(databaseIndex);
    expect(lockIndex).toBeLessThan(projectIndex);
    expect(lockIndex).toBeLessThan(countsIndex);
    expect(lockIndex).toBeLessThan(insertIndex);
    const lockSql = firstTransaction[lockIndex]!.sql;
    for (const table of [
      "project",
      "evolution_eval_job",
      "skill_application",
      "curator_run",
      "distillation_run",
    ]) {
      expect(lockSql).toContain(table);
    }
    expect(lockSql).toContain("IN SHARE MODE");
  });

  test("rejects non-admin identity, shape drift, stateful DB, and singleton reuse", async () => {
    const service = new FakeCanaryConnection();
    await expect(issueM4fEvolutionEvalCanaryHandler(handlerContext(service, request(), {
      actorType: "service",
      actorId: "service",
      userId: "usr-service",
      scopes: ["core:admin", "core:write"],
    }))).rejects.toMatchObject({ httpStatus: 403 });

    const shape = new FakeCanaryConnection();
    await expect(issueM4fEvolutionEvalCanaryHandler(handlerContext(shape, {
      ...request(),
      injected_binding: {},
    }))).rejects.toMatchObject({ httpStatus: 400 });

    const stateful = new FakeCanaryConnection();
    stateful.businessCounts.eval_jobs = 1;
    await expect(issueM4fEvolutionEvalCanaryHandler(handlerContext(stateful)))
      .rejects.toMatchObject({ httpStatus: 409 });

    const replay = new FakeCanaryConnection();
    await issueM4fEvolutionEvalCanaryHandler(handlerContext(replay));
    await expect(issueM4fEvolutionEvalCanaryHandler(handlerContext(replay, request({
      scenario: "failure-quarantine",
    })))).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("M4-F certification canary readback", () => {
  test("binds the immutable row to the exact database and Gate", async () => {
    const built = buildM4fCanaryBinding(request());
    const client = {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        if (sql === "BEGIN TRANSACTION READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        return { rows: [{
          current_database_name: DATABASE,
          database_name: DATABASE,
          gate_id: GATE,
          scenario: "success",
          project_id: PROJECT,
          request_hash: built.requestHash,
          binding_hash: built.bindingHash,
          binding: built.binding,
        }] };
      },
    };
    await expect(verifyM4fCanaryInDatabase(
      client as never,
      built.binding,
      { databaseName: DATABASE, gateId: GATE },
    )).resolves.toBeUndefined();
    await expect(verifyM4fCanaryInDatabase(
      client as never,
      built.binding,
      { databaseName: DATABASE, gateId: "other-gate" },
    )).rejects.toThrow("CORE_CANARY_BINDING_MISMATCH");
  });
});

describe("M4-F canary HTTP-only CLI", () => {
  test("requires explicit authorization, Gate DB, loopback Core and outside output", () => {
    const repositoryRoot = "/repo";
    const base = {
      DATABASE_URL: `postgresql://user:pass@127.0.0.1:5432/${DATABASE}`,
      SYNTHIA_CORE_URL: "http://127.0.0.1:8787",
      SYNTHIA_M4F_CANARY_BOOTSTRAP_AUTHORIZATION: M4F_CANARY_BOOTSTRAP_AUTHORIZATION,
      SYNTHIA_M4F_CANARY_SCENARIO: "success",
      SYNTHIA_M4F_GATE_ID: GATE,
      SYNTHIA_M4F_CANARY_PROJECT_ID: PROJECT,
      SYNTHIA_M4F_TARGET_PART: PART,
      SYNTHIA_M4F_TOOLCHAIN_PROFILE_HASH: HASH_A,
      SYNTHIA_M4F_E2E_HUMAN_TOKEN: "secret-token",
      SYNTHIA_M4F_CANARY_BINDING_OUTPUT: "/artifacts/canary.json",
    };
    expect(resolveM4fCanaryBootstrapConfig(base, repositoryRoot)).toMatchObject({
      databaseName: DATABASE,
      scenario: "success",
      bindingOutput: "/artifacts/canary.json",
    });
    expect(() => resolveM4fCanaryBootstrapConfig({
      ...base,
      SYNTHIA_M4F_CANARY_BOOTSTRAP_AUTHORIZATION: "wrong",
    }, repositoryRoot)).toThrow("AUTHORIZATION");
    expect(() => resolveM4fCanaryBootstrapConfig({
      ...base,
      SYNTHIA_CORE_URL: "https://connect.example.test",
    }, repositoryRoot)).toThrow("loopback");
    expect(() => resolveM4fCanaryBootstrapConfig({
      ...base,
      SYNTHIA_M4F_CANARY_BINDING_OUTPUT: "/repo/canary.json",
    }, repositoryRoot)).toThrow("outside");
  });

  test("creates through public Core APIs and writes only the strict binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synthia-m4f-canary-test-"));
    temporaryPaths.push(directory);
    const output = join(directory, "binding.json");
    const config: M4fCanaryBootstrapConfig = {
      coreBaseUrl: "http://127.0.0.1:8787",
      databaseName: DATABASE,
      gateId: GATE,
      scenario: "success",
      projectId: PROJECT,
      targetPart: PART,
      toolchainProfileHash: HASH_A,
      humanToken: "must-not-appear",
      bindingOutput: output,
    };
    const built = buildM4fCanaryBinding(request());
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      const data = url.endsWith("/api/v1/projects")
        ? { id: PROJECT, status: "active" }
        : url.endsWith(`/api/v1/projects/${PROJECT}`)
          ? {
              id: PROJECT,
              project_type: "free",
              target_part: PART,
              toolchain_profile_ref: HASH_A,
              status: "active",
            }
          : {
              schema: M4F_CANARY_BINDING_ISSUED_SCHEMA,
              database_name: DATABASE,
              gate_id: GATE,
              scenario: "success",
              project_id: PROJECT,
              binding_hash: built.bindingHash,
              binding: built.binding,
              issued_at: "2026-08-29T00:00:00.000Z",
              replayed: false,
            };
      return new Response(JSON.stringify({ data, correlation_id: "corr" }), {
        status: url.endsWith("/api/v1/projects")
          || url.endsWith("/api/v1/evolution/m4f-canary-bindings")
          ? 201
          : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await bootstrapM4fCanary(config, fetchImpl);
    expect(result.bindingHash).toBe(built.bindingHash);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => (
      new Headers(call.init.headers).get("authorization") === "Bearer must-not-appear"
    ))).toBe(true);
    expect(calls.every((call) => !String(call.init.body ?? "").includes("must-not-appear")))
      .toBe(true);
    const fileHash = await writeM4fCanaryBinding(output, result.binding);
    expect(fileHash).toMatch(/^[0-9a-f]{64}$/u);
    const raw = await readFile(output, "utf8");
    expect(validateCoreIssuedEvalBinding(JSON.parse(raw))).toEqual(built.binding);
    expect(raw).not.toContain("must-not-appear");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });
});
