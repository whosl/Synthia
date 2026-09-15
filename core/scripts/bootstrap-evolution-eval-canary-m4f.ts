#!/usr/bin/env bun
/**
 * Create the one-project M4-F scenario boundary and ask Core to issue its
 * immutable certification canary binding. This script never connects to
 * PostgreSQL and never calls Connector or Vivado.
 */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { validateCoreIssuedEvalBinding } from "../../connector/evolution-eval.ts";
import { evolutionEvalCanonicalHash, evolutionEvalCanonicalJson } from "../src/domain/evolution-eval.ts";
import {
  M4F_CANARY_BINDING_ISSUED_SCHEMA,
  M4F_CANARY_BOOTSTRAP_SCHEMA,
  M4F_CANARY_SCENARIOS,
  M4F_GATE_DATABASE_PREFIX,
  type M4fCanaryScenario,
} from "../src/services/evolution-eval-canary-bootstrap.ts";
import type { CoreIssuedEvalBinding } from "../src/services/evolution-eval-connector-port.ts";

export const M4F_CANARY_BOOTSTRAP_AUTHORIZATION = "I_AUTHORIZE_M4F_CANARY_BOOTSTRAP";

const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PART = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export interface M4fCanaryBootstrapConfig {
  readonly coreBaseUrl: string;
  readonly databaseName: string;
  readonly gateId: string;
  readonly scenario: M4fCanaryScenario;
  readonly projectId: string;
  readonly targetPart: string;
  readonly toolchainProfileHash: string;
  readonly humanToken: string;
  readonly bindingOutput: string;
}

export interface M4fCanaryBootstrapResult {
  readonly binding: CoreIssuedEvalBinding;
  readonly bindingHash: string;
  readonly replayed: boolean;
  readonly issuedAt: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function match(value: string, pattern: RegExp, name: string): string {
  if (value.normalize("NFC") !== value || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SYNTHIA_CORE_URL must be a loopback HTTP origin");
  }
  if (
    url.protocol !== "http:"
    || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("SYNTHIA_CORE_URL must be a loopback HTTP origin");
  }
  return url.origin;
}

function gateDatabaseName(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (
    !name.startsWith(M4F_GATE_DATABASE_PREFIX)
    || name.length === M4F_GATE_DATABASE_PREFIX.length
  ) {
    throw new Error(`DATABASE_URL must name a dedicated ${M4F_GATE_DATABASE_PREFIX}* database`);
  }
  return name;
}

function outsideRepository(path: string, repositoryRoot: string): string {
  const absolute = resolve(path);
  const fromRepository = relative(repositoryRoot, absolute);
  if (
    !isAbsolute(absolute)
    || fromRepository === ""
    || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
  ) {
    throw new Error("SYNTHIA_M4F_CANARY_BINDING_OUTPUT must be outside the repository");
  }
  return absolute;
}

export function resolveM4fCanaryBootstrapConfig(
  env: Record<string, string | undefined> = process.env,
  repositoryRoot = resolve(import.meta.dir, "../.."),
): M4fCanaryBootstrapConfig {
  if (
    required(env, "SYNTHIA_M4F_CANARY_BOOTSTRAP_AUTHORIZATION")
    !== M4F_CANARY_BOOTSTRAP_AUTHORIZATION
  ) {
    throw new Error("SYNTHIA_M4F_CANARY_BOOTSTRAP_AUTHORIZATION is invalid");
  }
  const scenario = required(env, "SYNTHIA_M4F_CANARY_SCENARIO");
  if (!M4F_CANARY_SCENARIOS.includes(scenario as M4fCanaryScenario)) {
    throw new Error("SYNTHIA_M4F_CANARY_SCENARIO must be success or failure-quarantine");
  }
  return Object.freeze({
    coreBaseUrl: loopbackOrigin(env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:8787"),
    databaseName: gateDatabaseName(required(env, "DATABASE_URL")),
    gateId: match(required(env, "SYNTHIA_M4F_GATE_ID"), ID, "SYNTHIA_M4F_GATE_ID"),
    scenario: scenario as M4fCanaryScenario,
    projectId: match(
      required(env, "SYNTHIA_M4F_CANARY_PROJECT_ID"),
      PROJECT_ID,
      "SYNTHIA_M4F_CANARY_PROJECT_ID",
    ),
    targetPart: match(
      required(env, "SYNTHIA_M4F_TARGET_PART"),
      PART,
      "SYNTHIA_M4F_TARGET_PART",
    ),
    toolchainProfileHash: match(
      required(env, "SYNTHIA_M4F_TOOLCHAIN_PROFILE_HASH"),
      HASH,
      "SYNTHIA_M4F_TOOLCHAIN_PROFILE_HASH",
    ),
    humanToken: required(env, "SYNTHIA_M4F_E2E_HUMAN_TOKEN"),
    bindingOutput: outsideRepository(
      required(env, "SYNTHIA_M4F_CANARY_BINDING_OUTPUT"),
      repositoryRoot,
    ),
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

async function coreCall(
  config: M4fCanaryBootstrapConfig,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  idempotencyKey: string | null,
  fetchImpl: typeof fetch,
): Promise<{ readonly status: number; readonly data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.humanToken}`,
  };
  if (body !== null) headers["content-type"] = "application/json";
  if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
  const response = await fetchImpl(`${config.coreBaseUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}`);
  }
  const envelope = object(json, `${method} ${path} response`);
  if (!response.ok) {
    const error = object(envelope.error, `${method} ${path} error`);
    throw new Error(`${method} ${path} failed: HTTP ${response.status} ${String(error.message ?? error.code ?? "unknown")}`);
  }
  return { status: response.status, data: object(envelope.data, `${method} ${path} data`) };
}

function idempotencyKey(label: string, payload: unknown): string {
  return `m4f-canary-${label}-${createHash("sha256").update(evolutionEvalCanonicalJson(payload)).digest("hex").slice(0, 32)}`;
}

export async function bootstrapM4fCanary(
  config: M4fCanaryBootstrapConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<M4fCanaryBootstrapResult> {
  const project = {
    id: config.projectId,
    name: `M4-F ${config.scenario} canary`,
    scope: `m4f:${config.gateId}:${config.scenario}`,
    data_classification: "D1",
    project_type: "free",
    target_part: config.targetPart,
    toolchain_profile_ref: config.toolchainProfileHash,
  };
  const created = await coreCall(
    config,
    "/api/v1/projects",
    "POST",
    project,
    idempotencyKey("project", project),
    fetchImpl,
  );
  if (created.status !== 201 || created.data.id !== config.projectId) {
    throw new Error("Core did not create or replay the exact canary project");
  }
  const projectRead = await coreCall(
    config,
    `/api/v1/projects/${encodeURIComponent(config.projectId)}`,
    "GET",
    null,
    null,
    fetchImpl,
  );
  if (
    projectRead.data.id !== config.projectId
    || projectRead.data.project_type !== "free"
    || projectRead.data.target_part !== config.targetPart
    || projectRead.data.toolchain_profile_ref !== config.toolchainProfileHash
    || projectRead.data.status !== "active"
  ) {
    throw new Error("Core canary project readback differs from the requested identity");
  }

  const request = {
    schema: M4F_CANARY_BOOTSTRAP_SCHEMA,
    database_name: config.databaseName,
    gate_id: config.gateId,
    scenario: config.scenario,
    project_id: config.projectId,
    target_part: config.targetPart,
    toolchain_profile_hash: config.toolchainProfileHash,
  };
  const issued = await coreCall(
    config,
    "/api/v1/evolution/m4f-canary-bindings",
    "POST",
    request,
    null,
    fetchImpl,
  );
  if (
    !new Set([200, 201]).has(issued.status)
    || issued.data.schema !== M4F_CANARY_BINDING_ISSUED_SCHEMA
    || issued.data.database_name !== config.databaseName
    || issued.data.gate_id !== config.gateId
    || issued.data.scenario !== config.scenario
    || issued.data.project_id !== config.projectId
    || typeof issued.data.binding_hash !== "string"
    || !HASH.test(issued.data.binding_hash)
    || typeof issued.data.issued_at !== "string"
    || typeof issued.data.replayed !== "boolean"
  ) {
    throw new Error("Core returned an invalid M4-F canary issuance response");
  }
  const binding = validateCoreIssuedEvalBinding(issued.data.binding, config.projectId);
  const bindingHash = evolutionEvalCanonicalHash(binding);
  if (bindingHash !== issued.data.binding_hash) {
    throw new Error("Core canary binding hash does not match the returned binding");
  }
  return Object.freeze({
    binding,
    bindingHash,
    replayed: issued.data.replayed,
    issuedAt: new Date(issued.data.issued_at).toISOString(),
  });
}

export async function writeM4fCanaryBinding(
  output: string,
  binding: CoreIssuedEvalBinding,
): Promise<string> {
  const bytes = Buffer.from(`${evolutionEvalCanonicalJson(binding)}\n`, "utf8");
  const handle = await open(output, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const config = resolveM4fCanaryBootstrapConfig();
  const result = await bootstrapM4fCanary(config);
  const fileSha256 = await writeM4fCanaryBinding(config.bindingOutput, result.binding);
  console.log(JSON.stringify({
    schema: "synthia-m4f-canary-bootstrap-result.v1",
    database_name: config.databaseName,
    gate_id: config.gateId,
    scenario: config.scenario,
    project_id: config.projectId,
    binding_hash: result.bindingHash,
    binding_file_sha256: fileSha256,
    output: config.bindingOutput,
    replayed: result.replayed,
    remote_called: false,
    vivado_called: false,
  }));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "M4F_CANARY_BOOTSTRAP_FAILED");
    process.exitCode = 1;
  });
}
