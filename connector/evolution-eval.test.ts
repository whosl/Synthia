import { describe, expect, test } from "bun:test";
import { evolutionEvalCanonicalHash as coreCanonicalHash } from "../core/src/domain/evolution-eval.ts";
import {
  EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
  computeEvolutionEvalDispatchRequestHash,
  evaluateEvolutionEvalDiscoveryPolicy,
  type CoreIssuedEvalBinding,
  type EvalLedgerQuery,
  type EvolutionEvalDispatchRequestV1,
  EvolutionEvalProtocolError,
  validateCoreIssuedEvalBinding,
  validateEvalLedgerQuery,
} from "./evolution-eval.ts";

const GOLDEN_DISPATCH_HASHES = Object.freeze({
  validate_sources: "9bbff835bf03282697e4f726b49c4abea938cb9ba030bb6611bf22cab93dfa03",
  simulate: "60cc900222937afd51f369fdf1a5027e2c4d01353ade0d82d683aae29a213169",
  synthesize: "d41183ebf833e6c9460b4bf4d839e79bc15132e82e4ec428d03941b46085d901",
  implement: "5d1940e8a81249843e3b0c03a9c946796533cb8b32b17dbff3c8a254c70887c5",
});

function dispatch(): EvolutionEvalDispatchRequestV1 {
  return {
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: "eej-fixture-1",
    connector_job_id: "connector-eval-fixture-1",
    connector_idempotency_key: "1".repeat(64),
    eval_input_ref: "eei-fixture-1",
    input_manifest_hash: "2".repeat(64),
    workspace_id: "eew-fixture-1",
    workspace_revision: 3,
    workspace_manifest_hash: "3".repeat(64),
    sealed_input_projection_hash: "5".repeat(64),
    operation: "implement",
    parameters: {
      operation: "implement",
      source_paths: ["rtl/top.sv"],
      constraint_paths: ["constraints/top.xdc"],
      top: "top",
      part: "xc7a35tcsg324-1",
      generate_trial_bitstream: true,
    },
    part: "xc7a35tcsg324-1",
    toolchain_profile_hash: "4".repeat(64),
    requested_timeout_ms: 3_600_000,
    operation_cap_ms: 7_200_000,
    deadline_at: "2026-08-26T10:00:00.000Z",
    run_class: "evolution_eval",
  };
}

function binding(overrides: Partial<CoreIssuedEvalBinding> = {}): CoreIssuedEvalBinding {
  const request = dispatch();
  return {
    project_id: "project-fixture-1",
    dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(request),
    dispatch: request,
    ...overrides,
  };
}

function queryBase() {
  const expected = binding();
  return {
    schema: EVOLUTION_EVAL_LEDGER_QUERY_SCHEMA,
    connector_job_id: expected.dispatch.connector_job_id,
    connector_idempotency_key: expected.dispatch.connector_idempotency_key,
    dispatch_request_hash: expected.dispatch_request_hash,
    ledger_epoch: "epoch-fixture-1",
  } as const;
}

describe("evolution-eval canonical Core binding", () => {
  test("matches the Core golden JCS hash byte-for-byte", () => {
    const request = dispatch();
    expect(computeEvolutionEvalDispatchRequestHash(request)).toBe(GOLDEN_DISPATCH_HASHES.implement);
    expect(coreCanonicalHash(request)).toBe(GOLDEN_DISPATCH_HASHES.implement);
    expect(validateCoreIssuedEvalBinding(binding(), "project-fixture-1")).toEqual(binding());
  });

  test("matches independent Core golden hashes for every allowed operation", () => {
    const base = dispatch();
    const cases: readonly EvolutionEvalDispatchRequestV1[] = [
      {
        ...base,
        operation: "validate_sources",
        parameters: { operation: "validate_sources", source_paths: ["rtl/top.sv"], top: null },
      },
      {
        ...base,
        operation: "simulate",
        parameters: {
          operation: "simulate",
          source_paths: ["rtl/top.sv", "tb/top_tb.sv"],
          top: "top",
          testbench: "top_tb",
        },
      },
      {
        ...base,
        operation: "synthesize",
        parameters: {
          operation: "synthesize",
          source_paths: ["rtl/top.sv"],
          top: "top",
          part: "xc7a35tcsg324-1",
        },
      },
      base,
    ];
    for (const request of cases) {
      expect(computeEvolutionEvalDispatchRequestHash(request)).toBe(GOLDEN_DISPATCH_HASHES[request.operation]);
      expect(coreCanonicalHash(request)).toBe(GOLDEN_DISPATCH_HASHES[request.operation]);
    }
  });

  test("rejects unknown fields, hash drift, class aliases, and envelope project drift", () => {
    const valid = binding();
    expect(() => validateCoreIssuedEvalBinding({ ...valid, caller_command: "vivado -mode tcl" }))
      .toThrow(EvolutionEvalProtocolError);
    expect(() => validateCoreIssuedEvalBinding({ ...valid, dispatch_request_hash: "f".repeat(64) }))
      .toThrow("dispatch_request_hash does not bind");
    expect(() => validateCoreIssuedEvalBinding({
      ...valid,
      dispatch: { ...valid.dispatch, run_class: "exploratory" },
    })).toThrow("dispatch schema or run_class is invalid");
    expect(() => validateCoreIssuedEvalBinding(valid, "another-project"))
      .toThrow("binding project_id differs from the remote envelope");
  });

  test("rejects typed parameter drift and non-canonical path or policy values", () => {
    const valid = binding();
    const invalidCases = [
      { ...valid.dispatch, parameters: { ...valid.dispatch.parameters, operation: "synthesize" } },
      { ...valid.dispatch, parameters: { ...valid.dispatch.parameters, source_paths: ["../top.sv"] } },
      { ...valid.dispatch, parameters: { ...valid.dispatch.parameters, constraint_paths: ["constraints/top.tcl"] } },
      { ...valid.dispatch, parameters: { ...valid.dispatch.parameters, extra: true } },
      { ...valid.dispatch, operation_cap_ms: 7_199_999 },
      { ...valid.dispatch, part: "xc7a200t" },
    ];
    for (const candidate of invalidCases) {
      expect(() => validateCoreIssuedEvalBinding({
        ...valid,
        dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(candidate as EvolutionEvalDispatchRequestV1),
        dispatch: candidate,
      })).toThrow(EvolutionEvalProtocolError);
    }
  });
});

describe("evolution-eval discovery policy", () => {
  const supported = ["validate_sources", "simulate", "synthesize", "implement"].map((operation) => ({
    operation,
    version: "eval-v1",
    runClasses: ["evolution_eval"],
  }));

  test("requires all four operations to advertise the class explicitly", () => {
    const result = evaluateEvolutionEvalDiscoveryPolicy([
      ...supported,
      { operation: "report_drc", version: "generic-v1", runClasses: ["exploratory", "formal"] },
    ], "eval-v1");
    expect(result.eligible).toBe(true);
    expect(result.missing_operations).toEqual([]);
    expect(result.forbidden_operations).toEqual([]);

    const missing = evaluateEvolutionEvalDiscoveryPolicy(supported.slice(0, 3), "eval-v1");
    expect(missing.eligible).toBe(false);
    expect(missing.missing_operations).toEqual(["implement"]);
  });

  test("rejects class leakage, duplicate advertising, and version drift without fallback", () => {
    const leaked = evaluateEvolutionEvalDiscoveryPolicy([
      ...supported,
      { operation: "report_drc", version: "eval-v1", runClasses: ["evolution_eval"] },
    ], "eval-v1");
    expect(leaked.eligible).toBe(false);
    expect(leaked.forbidden_operations).toEqual(["report_drc"]);

    const duplicate = evaluateEvolutionEvalDiscoveryPolicy([...supported, supported[0]!], "eval-v1");
    expect(duplicate.eligible).toBe(false);
    expect(duplicate.forbidden_operations).toEqual(["validate_sources"]);

    const splitDuplicate = evaluateEvolutionEvalDiscoveryPolicy([
      ...supported,
      { operation: "simulate", version: "generic-v1", runClasses: ["exploratory"] },
    ], "eval-v1");
    expect(splitDuplicate.eligible).toBe(false);
    expect(splitDuplicate.forbidden_operations).toEqual(["simulate"]);

    const drifted = supported.map((capability) => capability.operation === "simulate"
      ? { ...capability, version: "eval-v2" }
      : capability);
    expect(evaluateEvolutionEvalDiscoveryPolicy(drifted, "eval-v1").version_mismatches).toEqual(["simulate"]);
  });
});

describe("evolution-eval six-state ledger query contract", () => {
  const cases: readonly EvalLedgerQuery[] = [
    { ...queryBase(), state: "proven_never_accepted", replay_permitted: true },
    { ...queryBase(), state: "accepted", execution_state: "running", accepted_at: "2026-08-26T08:00:00.000Z" },
    { ...queryBase(), state: "terminal", terminal_state: "succeeded", process_stopped: true, terminal_at: "2026-08-26T08:01:00.000Z", error_code: null },
    { ...queryBase(), state: "transient_unavailable", retryable: true, error_code: "EVOLUTION_EVAL_LEDGER_UNAVAILABLE" },
    { ...queryBase(), state: "ambiguous", effect_possible: true, error_code: "EVOLUTION_EVAL_LEDGER_NO_PROOF" },
    { ...queryBase(), state: "ledger_corrupt", replay_permitted: false, error_code: "EVOLUTION_EVAL_LEDGER_CORRUPT" },
  ];

  test("accepts exactly the six frozen variants and echoes all binding fields", () => {
    for (const candidate of cases) {
      expect(validateEvalLedgerQuery(candidate, binding(), "epoch-fixture-1")).toEqual(candidate);
    }
  });

  test("fails closed on binding, epoch, terminal-stop, or shape drift", () => {
    const accepted = cases[1]!;
    expect(() => validateEvalLedgerQuery({ ...accepted, connector_idempotency_key: "9".repeat(64) }, binding()))
      .toThrow("ledger observation binding differs");
    expect(() => validateEvalLedgerQuery(accepted, binding(), "epoch-other"))
      .toThrow("ledger observation binding differs");
    expect(() => validateEvalLedgerQuery({
      ...cases[2]!,
      process_stopped: false,
    }, binding())).toThrow("terminal must prove process_stopped");
    expect(() => validateEvalLedgerQuery({ ...accepted, extra: "forbidden" }, binding()))
      .toThrow("non-canonical shape");
    expect(() => validateEvalLedgerQuery({ ...queryBase(), state: "not_found" }, binding()))
      .toThrow("six frozen states");
  });
});
