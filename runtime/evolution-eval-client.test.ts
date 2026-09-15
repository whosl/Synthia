import { describe, expect, test } from "bun:test";
import {
  CoreEvolutionEvalClient,
  EvolutionEvalClientError,
  type EvolutionEvalPrepareRequestV1,
} from "./evolution-eval-client.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const DEADLINE = "2026-08-27T03:00:00.000Z";

function response(data: unknown): Response {
  return Response.json({ data, correlation_id: "corr-eval-1" });
}

function prepareBody(operation: EvolutionEvalPrepareRequestV1["operation"]): EvolutionEvalPrepareRequestV1 {
  const parameters = operation === "validate_sources"
    ? { operation, source_paths: ["rtl/top.sv"], top: "top" as const }
    : operation === "simulate"
    ? { operation, source_paths: ["rtl/top.sv", "sim/tb.sv"], top: "top", testbench: "tb" }
    : operation === "synthesize"
    ? { operation, source_paths: ["rtl/top.sv"], top: "top", part: "xc7a35tcpg236-1" }
    : { operation, source_paths: ["rtl/top.sv"], constraint_paths: ["constraints/top.xdc"], top: "top", part: "xc7a35tcpg236-1", generate_trial_bitstream: true };
  return {
    schema: "evolution-eval-prepare.v1",
    curator_lease_token: "lease-1",
    application_id: "app-1",
    evidence_snapshot_hash: H1,
    version_id: "version-1",
    eval_input_ref: "input-1",
    input_manifest_hash: H2,
    operation,
    parameters,
    timeout_ms: 60_000,
  } as EvolutionEvalPrepareRequestV1;
}

describe("CoreEvolutionEvalClient", () => {
  test("uses only the exact evaluator routes, bearer token, and mutation header", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = new CoreEvolutionEvalClient({
      baseUrl: "http://core.local/",
      evaluatorToken: "evaluator-token",
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), init: init! });
        return response({
          schema: "evolution-eval-prepare-result.v1",
          eval_job_id: "job-1",
          tool_run_id: "tool-1",
          workspace_id: "workspace-1",
          ordinal: 1,
          state: "submitted",
          workspace_revision: 1,
          source_commit: "a".repeat(40),
          source_manifest_hash: H1,
          workspace_manifest_hash: H2,
          deadline_at: DEADLINE,
          effective_timeout_ms: 60_000,
          replayed: false,
        });
      },
    });
    await client.prepare("run-1", prepareBody("synthesize"), "prepare-key", undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://core.local/api/v1/internal/evolution/curator-runs/run-1/eval-jobs/prepare");
    expect(new Headers(seen[0]!.init.headers).get("Authorization")).toBe("Bearer evaluator-token");
    expect(new Headers(seen[0]!.init.headers).get("Idempotency-Key")).toBe("prepare-key");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(prepareBody("synthesize"));
  });

  test("accepts each of the four strict typed operations and rejects raw or caller-owned fields before fetch", async () => {
    let calls = 0;
    const client = new CoreEvolutionEvalClient({
      baseUrl: "http://core.local",
      evaluatorToken: "token",
      fetchImpl: async (_input, init) => {
        calls += 1;
        const body = JSON.parse(String(init!.body));
        return response({
          schema: "evolution-eval-prepare-result.v1",
          eval_job_id: `job-${calls}`,
          tool_run_id: `tool-${calls}`,
          workspace_id: `workspace-${calls}`,
          ordinal: Math.min(calls, 3),
          state: "submitted",
          workspace_revision: 1,
          source_commit: "a".repeat(40),
          source_manifest_hash: H1,
          workspace_manifest_hash: H2,
          deadline_at: DEADLINE,
          effective_timeout_ms: body.timeout_ms,
          replayed: false,
        });
      },
    });
    for (const operation of ["validate_sources", "simulate", "synthesize", "implement"] as const) {
      await client.prepare("run-1", prepareBody(operation), `key-${operation}`);
    }
    expect(calls).toBe(4);
    for (const forbidden of [
      { ...prepareBody("synthesize"), raw_tcl: "exec sh" },
      { ...prepareBody("synthesize"), project_path: "/project" },
      { ...prepareBody("synthesize"), hardware_target: "xilinx_tcf" },
      { ...prepareBody("synthesize"), parameters: { ...prepareBody("synthesize").parameters, command: "vivado" } },
    ]) {
      await expect(client.prepare("run-1", forbidden as EvolutionEvalPrepareRequestV1, "bad-key"))
        .rejects.toBeInstanceOf(TypeError);
    }
    expect(calls).toBe(4);
  });

  test("recovery and status parsing fail closed on extra fields or an oversized job set", async () => {
    const payloads: unknown[] = [
      {
        budget_started_at: "2026-08-27T01:00:00.000Z",
        deadline_at: DEADLINE,
        unknown_effect_latched_at: null,
        jobs: [],
        injected: true,
      },
      {
        budget_started_at: "2026-08-27T01:00:00.000Z",
        deadline_at: DEADLINE,
        unknown_effect_latched_at: null,
        jobs: Array.from({ length: 4 }, (_, index) => ({ ordinal: index + 1 })),
      },
      {
        budget_started_at: "2026-08-27T01:00:00.000Z",
        deadline_at: DEADLINE,
        unknown_effect_latched_at: null,
        jobs: [{
          eval_job_id: "job-1",
          tool_run_id: "tool-1",
          application_id: "app-1",
          version_id: "version-1",
          ordinal: 1,
          operation: "synthesize",
          state: "failed",
          error_code: "EVOLUTION_EVAL_NOT_ACCEPTED",
          workspace_id: "workspace-1",
          workspace_revision: 1,
          workspace_manifest_hash: H2,
          workspace_sealed: true,
          evidence_state: "none",
          retention_state: "not_applicable",
          evidence_manifest_hash: null,
          reconciliation_state: "confirmed",
        }],
      },
    ];
    const client = new CoreEvolutionEvalClient({
      baseUrl: "http://core.local",
      evaluatorToken: "token",
      fetchImpl: async () => response(payloads.shift()),
    });
    await expect(client.recover("run-1", "lease-1")).rejects.toBeInstanceOf(TypeError);
    await expect(client.recover("run-1", "lease-1")).rejects.toBeInstanceOf(TypeError);
    await expect(client.recover("run-1", "lease-1")).rejects.toBeInstanceOf(TypeError);
  });

  test("preserves stable Core errors and never falls back to a broader token or route", async () => {
    const client = new CoreEvolutionEvalClient({
      baseUrl: "http://core.local",
      evaluatorToken: "eval-token",
      fetchImpl: async () => Response.json({
        error: {
          code: "EVOLUTION_EVAL_FORBIDDEN",
          message: "disabled",
          retryable: false,
          details: null,
          correlation_id: "corr-denied",
        },
      }, { status: 403 }),
    });
    const error = await client.prepare("run-1", prepareBody("synthesize"), "key")
      .catch(value => value);
    expect(error).toBeInstanceOf(EvolutionEvalClientError);
    expect(error).toMatchObject({ code: "EVOLUTION_EVAL_FORBIDDEN", httpStatus: 403, retryable: false, correlationId: "corr-denied" });
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client)).sort()).toEqual([
      "cancel", "constructor", "freezeEvidence", "prepare", "readEvidence", "readWorkspace",
      "recover", "status", "submit", "writeWorkspace",
    ]);
  });
});
