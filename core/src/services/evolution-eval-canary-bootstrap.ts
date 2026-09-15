import {
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
  evolutionEvalCanonicalHash,
  type EvolutionEvalWorkspaceManifestV1,
} from "../domain/evolution-eval.ts";
import { sha256Hex } from "../hashing.ts";
import type { CoreIssuedEvalBinding } from "./evolution-eval-connector-port.ts";

export const M4F_CANARY_BOOTSTRAP_SCHEMA = "synthia-m4f-canary-bootstrap.v1" as const;
export const M4F_CANARY_BINDING_ISSUED_SCHEMA = "synthia-m4f-canary-binding-issued.v1" as const;
export const M4F_GATE_DATABASE_PREFIX = "synthia-selfevo-gate-";
export const M4F_CANARY_SCENARIOS = ["success", "failure-quarantine"] as const;
export type M4fCanaryScenario = (typeof M4F_CANARY_SCENARIOS)[number];

const HASH = /^[0-9a-f]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PART = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

/**
 * The certification canary is intentionally never a runnable business job.
 * Reserve/query do not consult this deadline, while submit always computes an
 * effective timeout before any spool, workspace, process, or Vivado effect.
 */
export const M4F_CANARY_EXPIRED_DEADLINE = "2000-01-01T00:00:00.000Z";

export interface M4fCanaryBootstrapRequestV1 {
  readonly schema: typeof M4F_CANARY_BOOTSTRAP_SCHEMA;
  readonly database_name: string;
  readonly gate_id: string;
  readonly scenario: M4fCanaryScenario;
  readonly project_id: string;
  readonly target_part: string;
  readonly toolchain_profile_hash: string;
}

export interface BuiltM4fCanaryBinding {
  readonly requestHash: string;
  readonly bindingHash: string;
  readonly binding: CoreIssuedEvalBinding;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError(`${label} must contain exactly: ${canonical.join(", ")}`);
  }
}

function text(
  value: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string"
    || candidate.normalize("NFC") !== candidate
    || !pattern.test(candidate)
  ) {
    throw new TypeError(`${key} is invalid`);
  }
  return candidate;
}

export function parseM4fCanaryBootstrapRequest(value: unknown): M4fCanaryBootstrapRequestV1 {
  const input = record(value, "M4-F canary bootstrap request");
  exactKeys(input, [
    "database_name",
    "gate_id",
    "project_id",
    "scenario",
    "schema",
    "target_part",
    "toolchain_profile_hash",
  ], "M4-F canary bootstrap request");
  if (input.schema !== M4F_CANARY_BOOTSTRAP_SCHEMA) {
    throw new TypeError("M4-F canary bootstrap schema is invalid");
  }
  const databaseName = text(input, "database_name", DATABASE_NAME);
  if (
    !databaseName.startsWith(M4F_GATE_DATABASE_PREFIX)
    || databaseName.length === M4F_GATE_DATABASE_PREFIX.length
  ) {
    throw new TypeError(`database_name must identify a dedicated ${M4F_GATE_DATABASE_PREFIX}* database`);
  }
  const scenario = input.scenario;
  if (!M4F_CANARY_SCENARIOS.includes(scenario as M4fCanaryScenario)) {
    throw new TypeError("scenario must be success or failure-quarantine");
  }
  const toolchainProfileHash = text(input, "toolchain_profile_hash", HASH);
  return Object.freeze({
    schema: M4F_CANARY_BOOTSTRAP_SCHEMA,
    database_name: databaseName,
    gate_id: text(input, "gate_id", OPAQUE),
    scenario: scenario as M4fCanaryScenario,
    project_id: text(input, "project_id", PROJECT_ID),
    target_part: text(input, "target_part", PART),
    toolchain_profile_hash: toolchainProfileHash,
  });
}

function id(prefix: string, requestHash: string): string {
  return `${prefix}_${requestHash.slice(0, 40)}`;
}

/**
 * Build the complete strict Connector binding from the Core-authoritative
 * bootstrap request. Database name and scenario are inside requestHash, so two
 * scenario databases cannot accidentally mint the same remote ledger key.
 */
export function buildM4fCanaryBinding(
  requestInput: M4fCanaryBootstrapRequestV1,
): BuiltM4fCanaryBinding {
  const request = parseM4fCanaryBootstrapRequest(requestInput);
  const requestHash = evolutionEvalCanonicalHash(request);
  const workspaceId = id("eew_canary", requestHash);
  const source = Buffer.from([
    "module synthia_m4f_canary(input logic a, output logic y);",
    "  assign y = a;",
    "endmodule",
    "",
  ].join("\n"), "utf8");
  const sourceContentHash = sha256Hex(source);
  const sourceHash = evolutionEvalCanonicalHash({
    schema: "synthia-m4f-canary-source.v1",
    content_sha256: sourceContentHash,
    request_hash: requestHash,
  });
  const manifest: EvolutionEvalWorkspaceManifestV1 = {
    schema: "evolution-eval-workspace-manifest.v1",
    workspace_id: workspaceId,
    revision: 1,
    files: [{
      path: "rtl/synthia_m4f_canary.sv",
      sha256: sourceContentHash,
      size_bytes: source.byteLength,
      media_type: "text/x-systemverilog",
      layer: "source",
      read_only: true,
    }],
  };
  const canonicalManifest = canonicalEvolutionEvalWorkspaceManifest(manifest);
  const sealedProjection = canonicalEvolutionEvalSealedInputProjection(manifest);
  const dispatch = {
    schema: "evolution-eval-dispatch-request.v1" as const,
    eval_job_id: id("eej_canary", requestHash),
    connector_job_id: id("eec_canary", requestHash),
    connector_idempotency_key: evolutionEvalCanonicalHash({
      schema: "synthia-m4f-canary-connector-key.v1",
      request_hash: requestHash,
    }),
    eval_input_ref: id("eei_canary", requestHash),
    input_manifest_hash: evolutionEvalCanonicalHash({
      schema: "synthia-m4f-canary-input-manifest.v1",
      request_hash: requestHash,
      source_hash: sourceHash,
      workspace_manifest_hash: canonicalManifest.sha256,
    }),
    workspace_id: workspaceId,
    workspace_revision: 1,
    workspace_manifest_hash: canonicalManifest.sha256,
    sealed_input_projection_hash: sealedProjection.sha256,
    operation: "validate_sources" as const,
    parameters: {
      operation: "validate_sources" as const,
      source_paths: ["rtl/synthia_m4f_canary.sv"],
      top: null,
    },
    part: request.target_part,
    toolchain_profile_hash: request.toolchain_profile_hash,
    requested_timeout_ms: 1,
    operation_cap_ms: 7_200_000 as const,
    deadline_at: M4F_CANARY_EXPIRED_DEADLINE,
    run_class: "evolution_eval" as const,
  };
  const dispatchRequestHash = evolutionEvalCanonicalHash(dispatch);
  const binding: CoreIssuedEvalBinding = {
    project_id: request.project_id,
    dispatch_request_hash: dispatchRequestHash,
    dispatch,
  };
  return Object.freeze({
    requestHash,
    bindingHash: evolutionEvalCanonicalHash(binding),
    binding: Object.freeze(structuredClone(binding)),
  });
}
