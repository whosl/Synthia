#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { evolutionEvalCanonicalHash, evolutionEvalCanonicalJson } from "../src/domain/evolution-eval.ts";
import {
  exactHttpsOrigin,
  gateDatabaseIdentity,
  loadEvolutionEvalNewEffectsCertification,
} from "./certify-evolution-eval-m4f.ts";

export type EvolutionEvalChaosScenario =
  | "unforwarded_submit"
  | "accepted_submit_response_lost"
  | "query_response_lost"
  | "cancel_response_lost"
  | "evidence_entry_stream_lost"
  | "ack_response_lost"
  | "corrupt_ack_response_lost"
  | "cleanup_response_lost";

export interface EvolutionEvalChaosFact {
  readonly schema: "synthia-evolution-eval-chaos-fact.v1";
  readonly gate_id: string;
  readonly scenario: EvolutionEvalChaosScenario;
  readonly method: string;
  readonly path: string;
  readonly request_sha256: string;
  readonly forwarded_to_connector: boolean;
  readonly upstream_status: number | null;
  readonly upstream_response_sha256: string | null;
  readonly upstream_response_bytes: number | null;
  readonly connector_response_observed: boolean;
  readonly response_delivered: boolean;
  readonly injection_applied: boolean;
}

export interface EvolutionEvalChaosAuthorizationV1 {
  readonly schema: "synthia-evolution-eval-chaos-authorization.v1";
  readonly gate_id: string;
  readonly database_identity_hash: string;
  readonly worker_release_manifest_hash: string;
  readonly certification_hash: string;
  readonly certification_file_sha256: string;
  readonly scenario: EvolutionEvalChaosScenario;
  readonly proxy_origin: string;
  readonly upstream_origin: string;
  readonly run_nonce: string;
  readonly authorized: true;
  readonly authorization_hash: string;
}

export interface EvolutionEvalChaosLogEntryV1 {
  readonly schema: "synthia-evolution-eval-chaos-log-entry.v1";
  readonly sequence: number;
  readonly previous_hash: string;
  readonly recorded_at: string;
  readonly run_nonce: string;
  readonly authorization_hash: string;
  readonly fact: EvolutionEvalChaosFact;
  readonly entry_hash: string;
}

export interface EvolutionEvalChaosLogSealV1 {
  readonly schema: "synthia-evolution-eval-chaos-log-seal.v1";
  readonly sequence: number;
  readonly previous_hash: string;
  readonly recorded_at: string;
  readonly run_nonce: string;
  readonly authorization_hash: string;
  readonly entry_count: number;
  readonly seal_hash: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const TARGET_PATH: Readonly<Record<EvolutionEvalChaosScenario, string>> = Object.freeze({
  unforwarded_submit: "/evolution-eval/submit",
  accepted_submit_response_lost: "/evolution-eval/submit",
  query_response_lost: "/evolution-eval/query",
  cancel_response_lost: "/evolution-eval/cancel",
  evidence_entry_stream_lost: "/evolution-eval/evidence/entry",
  ack_response_lost: "/evolution-eval/evidence/ack",
  corrupt_ack_response_lost: "/evolution-eval/evidence/corrupt-ack",
  cleanup_response_lost: "/evolution-eval/evidence/cleanup",
});

const SCENARIOS = Object.freeze(Object.keys(TARGET_PATH) as EvolutionEvalChaosScenario[]);
const HASH = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ZERO_HASH = "0".repeat(64);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string")
    || (actual as string[]).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

export function parseEvolutionEvalChaosScenario(value: string): EvolutionEvalChaosScenario {
  if (!SCENARIOS.includes(value as EvolutionEvalChaosScenario)) {
    throw new TypeError(`unsupported M4-F chaos scenario: ${value}`);
  }
  return value as EvolutionEvalChaosScenario;
}

function exactLoopbackHttpsOrigin(value: string, label: string): string {
  const url = exactHttpsOrigin(value, label);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new TypeError(`${label} must use an exact loopback HTTPS origin`);
  }
  return url.origin;
}

export function createEvolutionEvalChaosAuthorization(input: {
  readonly gateId: string;
  readonly databaseIdentityHash: string;
  readonly workerReleaseManifestHash: string;
  readonly certificationHash: string;
  readonly certificationFileSha256: string;
  readonly scenario: EvolutionEvalChaosScenario;
  readonly proxyOrigin: string;
  readonly upstreamOrigin: string;
  readonly runNonce: string;
}): EvolutionEvalChaosAuthorizationV1 {
  const body = {
    schema: "synthia-evolution-eval-chaos-authorization.v1" as const,
    gate_id: input.gateId,
    database_identity_hash: input.databaseIdentityHash,
    worker_release_manifest_hash: input.workerReleaseManifestHash,
    certification_hash: input.certificationHash,
    certification_file_sha256: input.certificationFileSha256,
    scenario: input.scenario,
    proxy_origin: input.proxyOrigin,
    upstream_origin: input.upstreamOrigin,
    run_nonce: input.runNonce,
    authorized: true as const,
  };
  return parseEvolutionEvalChaosAuthorization({
    ...body,
    authorization_hash: evolutionEvalCanonicalHash(body),
  });
}

export function parseEvolutionEvalChaosAuthorization(
  value: unknown,
): EvolutionEvalChaosAuthorizationV1 {
  const authorization = record(value, "chaos authorization");
  exactKeys(authorization, [
    "authorization_hash",
    "authorized",
    "certification_file_sha256",
    "certification_hash",
    "database_identity_hash",
    "gate_id",
    "proxy_origin",
    "run_nonce",
    "scenario",
    "schema",
    "upstream_origin",
    "worker_release_manifest_hash",
  ], "chaos authorization");
  if (
    authorization.schema !== "synthia-evolution-eval-chaos-authorization.v1"
    || authorization.authorized !== true
    || typeof authorization.gate_id !== "string"
    || !OPAQUE_ID.test(authorization.gate_id)
    || typeof authorization.run_nonce !== "string"
    || !UUID_V4.test(authorization.run_nonce)
    || typeof authorization.scenario !== "string"
  ) {
    throw new TypeError("chaos authorization identity is invalid");
  }
  const body = {
    schema: "synthia-evolution-eval-chaos-authorization.v1" as const,
    gate_id: authorization.gate_id,
    database_identity_hash: hash(
      authorization.database_identity_hash,
      "chaos authorization database_identity_hash",
    ),
    worker_release_manifest_hash: hash(
      authorization.worker_release_manifest_hash,
      "chaos authorization worker_release_manifest_hash",
    ),
    certification_hash: hash(
      authorization.certification_hash,
      "chaos authorization certification_hash",
    ),
    certification_file_sha256: hash(
      authorization.certification_file_sha256,
      "chaos authorization certification_file_sha256",
    ),
    scenario: parseEvolutionEvalChaosScenario(authorization.scenario),
    proxy_origin: exactLoopbackHttpsOrigin(
      String(authorization.proxy_origin),
      "chaos authorization proxy_origin",
    ),
    upstream_origin: exactHttpsOrigin(
      String(authorization.upstream_origin),
      "chaos authorization upstream_origin",
    ).origin,
    run_nonce: authorization.run_nonce,
    authorized: true as const,
  };
  const authorizationHash = hash(
    authorization.authorization_hash,
    "chaos authorization authorization_hash",
  );
  if (evolutionEvalCanonicalHash(body) !== authorizationHash) {
    throw new TypeError("chaos authorization_hash is invalid");
  }
  return Object.freeze({ ...body, authorization_hash: authorizationHash });
}

export async function loadEvolutionEvalChaosAuthorization(options: {
  readonly authorizationPath: string;
  readonly expectedAuthorizationFileSha256: string;
  readonly releaseManifestPath: string;
  readonly certificationPath: string;
  readonly expectedCertificationFileSha256: string;
  readonly toolchainAttestationPath: string;
  readonly expectedToolchainAttestationFileSha256: string;
  readonly connectorConfigPath: string;
  readonly databaseUrl: string;
  readonly gateId: string;
  readonly scenario: EvolutionEvalChaosScenario;
  readonly proxyOrigin: string;
  readonly requireFreshCertification?: boolean;
}): Promise<EvolutionEvalChaosAuthorizationV1> {
  const bytes = await readFile(options.authorizationPath);
  if (sha256(bytes) !== hash(
    options.expectedAuthorizationFileSha256,
    "expectedAuthorizationFileSha256",
  )) {
    throw new Error("chaos authorization raw file SHA-256 differs from deployment authorization");
  }
  const authorization = parseEvolutionEvalChaosAuthorization(
    JSON.parse(bytes.toString("utf8")),
  );
  const certified = await loadEvolutionEvalNewEffectsCertification({
    releaseManifestPath: options.releaseManifestPath,
    certificationPath: options.certificationPath,
    expectedCertificationFileSha256: options.expectedCertificationFileSha256,
    toolchainAttestationPath: options.toolchainAttestationPath,
    expectedToolchainAttestationFileSha256:
      options.expectedToolchainAttestationFileSha256,
    connectorConfigPath: options.connectorConfigPath,
    databaseUrl: options.databaseUrl,
    gateId: options.gateId,
    requireFresh: options.requireFreshCertification !== false,
  });
  const database = gateDatabaseIdentity(options.databaseUrl);
  if (
    authorization.gate_id !== options.gateId
    || authorization.database_identity_hash !== database.identity_hash
    || authorization.worker_release_manifest_hash !== certified.releaseManifest.manifest_hash
    || authorization.certification_hash !== certified.certification.certification_hash
    || authorization.certification_file_sha256 !== options.expectedCertificationFileSha256
    || authorization.scenario !== options.scenario
    || authorization.proxy_origin !== exactLoopbackHttpsOrigin(options.proxyOrigin, "proxyOrigin")
    || authorization.upstream_origin !== certified.certification.endpoint.origin
  ) {
    throw new Error("chaos authorization differs from Gate A/B, scenario, or exact endpoints");
  }
  return authorization;
}

export class EvolutionEvalChaosLogWriter {
  private sequence = 0;
  private previousHash = ZERO_HASH;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly handle: FileHandle,
    private readonly authorization: EvolutionEvalChaosAuthorizationV1,
    private readonly now: () => Date,
  ) {}

  static async create(options: {
    readonly path: string;
    readonly authorization: EvolutionEvalChaosAuthorizationV1;
    readonly now?: () => Date;
  }): Promise<EvolutionEvalChaosLogWriter> {
    const authorization = parseEvolutionEvalChaosAuthorization(options.authorization);
    const handle = await open(options.path, "wx", 0o600);
    return new EvolutionEvalChaosLogWriter(handle, authorization, options.now ?? (() => new Date()));
  }

  async record(fact: EvolutionEvalChaosFact): Promise<void> {
    if (this.closed) throw new Error("chaos log is sealed");
    if (
      fact.gate_id !== this.authorization.gate_id
      || fact.scenario !== this.authorization.scenario
    ) {
      throw new Error("chaos fact differs from authorization");
    }
    const frozenFact = structuredClone(fact);
    const task = this.pending.then(async () => {
      const body = {
        schema: "synthia-evolution-eval-chaos-log-entry.v1" as const,
        sequence: this.sequence + 1,
        previous_hash: this.previousHash,
        recorded_at: canonicalTimestamp(this.now().toISOString(), "chaos log recorded_at"),
        run_nonce: this.authorization.run_nonce,
        authorization_hash: this.authorization.authorization_hash,
        fact: frozenFact,
      };
      const entry: EvolutionEvalChaosLogEntryV1 = {
        ...body,
        entry_hash: evolutionEvalCanonicalHash(body),
      };
      await this.handle.write(`${evolutionEvalCanonicalJson(entry)}\n`);
      await this.handle.sync();
      this.sequence = entry.sequence;
      this.previousHash = entry.entry_hash;
    });
    this.pending = task;
    return task;
  }

  async seal(): Promise<EvolutionEvalChaosLogSealV1> {
    if (this.closed) throw new Error("chaos log is already sealed");
    this.closed = true;
    await this.pending;
    const body = {
      schema: "synthia-evolution-eval-chaos-log-seal.v1" as const,
      sequence: this.sequence + 1,
      previous_hash: this.previousHash,
      recorded_at: canonicalTimestamp(this.now().toISOString(), "chaos log seal recorded_at"),
      run_nonce: this.authorization.run_nonce,
      authorization_hash: this.authorization.authorization_hash,
      entry_count: this.sequence,
    };
    const seal: EvolutionEvalChaosLogSealV1 = {
      ...body,
      seal_hash: evolutionEvalCanonicalHash(body),
    };
    try {
      await this.handle.write(`${evolutionEvalCanonicalJson(seal)}\n`);
      await this.handle.sync();
    } finally {
      await this.handle.close();
    }
    return seal;
  }
}

export function verifyEvolutionEvalChaosLog(
  bytes: Uint8Array,
  authorization: EvolutionEvalChaosAuthorizationV1,
): { readonly entries: readonly EvolutionEvalChaosLogEntryV1[]; readonly seal: EvolutionEvalChaosLogSealV1 } {
  const canonicalAuthorization = parseEvolutionEvalChaosAuthorization(authorization);
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n")) throw new Error("chaos log is not newline terminated");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1) throw new Error("chaos log is empty");
  let previousHash = ZERO_HASH;
  const entries: EvolutionEvalChaosLogEntryV1[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const entry = record(JSON.parse(lines[index]!), `chaos log entry ${index + 1}`);
    exactKeys(entry, [
      "authorization_hash", "entry_hash", "fact", "previous_hash", "recorded_at",
      "run_nonce", "schema", "sequence",
    ], `chaos log entry ${index + 1}`);
    const { entry_hash: rawEntryHash, ...body } = entry;
    const entryHash = hash(rawEntryHash, "chaos log entry_hash");
    if (
      entry.schema !== "synthia-evolution-eval-chaos-log-entry.v1"
      || entry.sequence !== index + 1
      || entry.previous_hash !== previousHash
      || entry.run_nonce !== canonicalAuthorization.run_nonce
      || entry.authorization_hash !== canonicalAuthorization.authorization_hash
      || evolutionEvalCanonicalHash(body) !== entryHash
      || evolutionEvalCanonicalJson(entry) !== lines[index]
    ) {
      throw new Error("chaos log entry chain is invalid");
    }
    canonicalTimestamp(entry.recorded_at, "chaos log entry recorded_at");
    previousHash = entryHash;
    entries.push(entry as unknown as EvolutionEvalChaosLogEntryV1);
  }
  const rawSeal = record(JSON.parse(lines.at(-1)!), "chaos log seal");
  exactKeys(rawSeal, [
    "authorization_hash", "entry_count", "previous_hash", "recorded_at", "run_nonce",
    "schema", "seal_hash", "sequence",
  ], "chaos log seal");
  const { seal_hash: rawSealHash, ...sealBody } = rawSeal;
  const sealHash = hash(rawSealHash, "chaos log seal_hash");
  if (
    rawSeal.schema !== "synthia-evolution-eval-chaos-log-seal.v1"
    || rawSeal.sequence !== entries.length + 1
    || rawSeal.entry_count !== entries.length
    || rawSeal.previous_hash !== previousHash
    || rawSeal.run_nonce !== canonicalAuthorization.run_nonce
    || rawSeal.authorization_hash !== canonicalAuthorization.authorization_hash
    || evolutionEvalCanonicalHash(sealBody) !== sealHash
    || evolutionEvalCanonicalJson(rawSeal) !== lines.at(-1)
  ) {
    throw new Error("chaos log seal is invalid");
  }
  canonicalTimestamp(rawSeal.recorded_at, "chaos log seal recorded_at");
  return {
    entries: Object.freeze(entries),
    seal: rawSeal as unknown as EvolutionEvalChaosLogSealV1,
  };
}

async function requestHash(request: Request): Promise<string> {
  const body = new Uint8Array(await request.clone().arrayBuffer());
  return sha256(Buffer.concat([
    Buffer.from(`${request.method}\n${new URL(request.url).pathname}${new URL(request.url).search}\n`),
    Buffer.from(sha256(body)),
  ]));
}

function brokenResponse(
  status: number,
  headers: Headers,
  prefix = new Uint8Array(),
): Response {
  let prefixDelivered = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (prefix.byteLength > 0 && !prefixDelivered) {
        prefixDelivered = true;
        controller.enqueue(prefix);
        return;
      }
      controller.error(new Error("SYNTHIA_M4F_CHAOS_RESPONSE_LOST"));
    },
  });
  return new Response(body, { status, headers });
}

function responsePayload(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envelope = parsed as Record<string, unknown>;
    if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
      return null;
    }
    return envelope.payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

function durableResponseMatches(
  scenario: EvolutionEvalChaosScenario,
  status: number,
  bytes: Uint8Array,
): boolean {
  if (status < 200 || status >= 300) return false;
  if (
    scenario === "query_response_lost"
    || scenario === "cancel_response_lost"
    || scenario === "evidence_entry_stream_lost"
  ) {
    return true;
  }
  const payload = responsePayload(bytes);
  if (!payload) return false;
  if (scenario === "accepted_submit_response_lost") {
    return payload.state === "accepted";
  }
  if (scenario === "ack_response_lost") {
    return payload.state === "acknowledged";
  }
  if (scenario === "corrupt_ack_response_lost") {
    return payload.state === "quarantined";
  }
  if (scenario === "cleanup_response_lost") {
    return payload.state === "cleaned" && payload.physical_deleted === true;
  }
  return true;
}

function forwardedRequest(request: Request, upstreamOrigin?: string): Request {
  if (!upstreamOrigin) return request.clone();
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin);
  return new Request(target, request);
}

/**
 * Create a single-scenario transport fault injector.
 *
 * Requests and successful upstream bytes are never rewritten. Non-target
 * routes pass through unchanged. Each actual injection is recorded before the
 * broken response is returned so a later client retry cannot erase whether
 * the Connector was reached or its response was observed by the proxy.
 */
export function createEvolutionEvalChaosFetch(options: {
  readonly gateId: string;
  readonly scenario: EvolutionEvalChaosScenario;
  readonly upstreamFetch?: FetchLike;
  readonly upstreamOrigin?: string;
  readonly evidencePrefixBytes?: number;
  readonly record: (fact: EvolutionEvalChaosFact) => void | Promise<void>;
}): FetchLike {
  if (!OPAQUE_ID.test(options.gateId)) throw new TypeError("gateId is invalid");
  const scenario = parseEvolutionEvalChaosScenario(options.scenario);
  const upstreamFetch = options.upstreamFetch ?? fetch;
  const upstreamOrigin = options.upstreamOrigin === undefined
    ? undefined
    : exactHttpsOrigin(options.upstreamOrigin, "upstreamOrigin").origin;
  const evidencePrefixBytes = options.evidencePrefixBytes ?? 1024;
  if (!Number.isSafeInteger(evidencePrefixBytes) || evidencePrefixBytes < 0 || evidencePrefixBytes > 65_536) {
    throw new TypeError("evidencePrefixBytes must be between 0 and 65536");
  }

  return async (input, init) => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname !== TARGET_PATH[scenario] || request.method !== "POST") {
      return upstreamFetch(forwardedRequest(request, upstreamOrigin));
    }
    const requestSha256 = await requestHash(request);
    if (!HASH.test(requestSha256)) throw new Error("CHAOS_REQUEST_HASH_FAILED");

    if (scenario === "unforwarded_submit") {
      await options.record({
        schema: "synthia-evolution-eval-chaos-fact.v1",
        gate_id: options.gateId,
        scenario,
        method: request.method,
        path: url.pathname,
        request_sha256: requestSha256,
        forwarded_to_connector: false,
        upstream_status: null,
        upstream_response_sha256: null,
        upstream_response_bytes: null,
        connector_response_observed: false,
        response_delivered: false,
        injection_applied: true,
      });
      return brokenResponse(200, new Headers({ "content-type": "application/json" }));
    }

    const upstream = await upstreamFetch(forwardedRequest(request, upstreamOrigin));
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const factBase = {
      schema: "synthia-evolution-eval-chaos-fact.v1" as const,
      gate_id: options.gateId,
      scenario,
      method: request.method,
      path: url.pathname,
      request_sha256: requestSha256,
      forwarded_to_connector: true,
      upstream_status: upstream.status,
      upstream_response_sha256: sha256(bytes),
      upstream_response_bytes: bytes.byteLength,
      connector_response_observed: true,
    };
    if (!durableResponseMatches(scenario, upstream.status, bytes)) {
      await options.record({
        ...factBase,
        response_delivered: true,
        injection_applied: false,
      });
      return new Response(bytes, { status: upstream.status, headers: upstream.headers });
    }

    await options.record({
      ...factBase,
      response_delivered: false,
      injection_applied: true,
    });
    if (scenario === "evidence_entry_stream_lost") {
      return brokenResponse(
        upstream.status,
        upstream.headers,
        bytes.slice(0, Math.min(bytes.byteLength, evidencePrefixBytes)),
      );
    }
    // Deliver at most one authentic upstream byte before breaking the body.
    // This avoids synthesizing a protocol response while still guaranteeing
    // the client cannot observe or parse the Connector response.
    return brokenResponse(upstream.status, upstream.headers, bytes.slice(0, 1));
  };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function outsideRepository(path: string, repositoryRoot: string, name: string): string {
  const absolute = resolve(path);
  const fromRepository = relative(repositoryRoot, absolute);
  if (!isAbsolute(absolute) || fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error(`${name} must be outside the repository`);
  }
  return absolute;
}

async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const gateId = requiredEnv(env, "SYNTHIA_M4F_GATE_ID");
  if (!OPAQUE_ID.test(gateId)) throw new Error("SYNTHIA_M4F_GATE_ID is invalid");
  const scenario = parseEvolutionEvalChaosScenario(requiredEnv(env, "SYNTHIA_M4F_CHAOS_SCENARIO"));
  const upstreamOrigin = requiredEnv(env, "SYNTHIA_M4F_CHAOS_UPSTREAM_ORIGIN");
  const allowedUpstream = requiredEnv(env, "SYNTHIA_M4F_CHAOS_ALLOWED_UPSTREAM_ORIGIN");
  if (upstreamOrigin !== allowedUpstream) throw new Error("chaos upstream differs from exact allowlist");
  exactHttpsOrigin(upstreamOrigin, "SYNTHIA_M4F_CHAOS_UPSTREAM_ORIGIN");
  const logPath = outsideRepository(
    requiredEnv(env, "SYNTHIA_M4F_CHAOS_LOG"),
    repositoryRoot,
    "SYNTHIA_M4F_CHAOS_LOG",
  );
  const hostname = env.SYNTHIA_M4F_CHAOS_LISTEN_HOST ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("chaos proxy may listen only on loopback");
  }
  const portValue = env.SYNTHIA_M4F_CHAOS_LISTEN_PORT ?? "9443";
  if (!/^\d+$/.test(portValue)) throw new Error("chaos proxy port is invalid");
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("chaos proxy port must be between 1024 and 65535");
  }
  const proxyOrigin = `https://${hostname === "::1" ? "[::1]" : hostname}:${port}`;

  if (env.SYNTHIA_M4F_CHAOS_PROXY_AUTHORIZED !== "1") {
    console.log(JSON.stringify({
      mode: "preflight",
      proxy_started: false,
      gate_id: gateId,
      scenario,
      upstream_origin: upstreamOrigin,
      log_path: logPath,
    }));
    return;
  }

  const certPath = outsideRepository(
    requiredEnv(env, "SYNTHIA_M4F_CHAOS_TLS_CERT"),
    repositoryRoot,
    "SYNTHIA_M4F_CHAOS_TLS_CERT",
  );
  const keyPath = outsideRepository(
    requiredEnv(env, "SYNTHIA_M4F_CHAOS_TLS_KEY"),
    repositoryRoot,
    "SYNTHIA_M4F_CHAOS_TLS_KEY",
  );
  const authorizationPath = outsideRepository(
    requiredEnv(env, "SYNTHIA_M4F_CHAOS_AUTHORIZATION"),
    repositoryRoot,
    "SYNTHIA_M4F_CHAOS_AUTHORIZATION",
  );
  const authorization = await loadEvolutionEvalChaosAuthorization({
    authorizationPath,
    expectedAuthorizationFileSha256: requiredEnv(
      env,
      "SYNTHIA_M4F_CHAOS_AUTHORIZATION_SHA256",
    ),
    releaseManifestPath: requiredEnv(env, "SYNTHIA_M4F_RELEASE_MANIFEST"),
    certificationPath: requiredEnv(env, "SYNTHIA_M4F_F0_CERTIFICATION"),
    expectedCertificationFileSha256: requiredEnv(
      env,
      "SYNTHIA_M4F_F0_CERTIFICATION_SHA256",
    ),
    toolchainAttestationPath: requiredEnv(
      env,
      "SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION",
    ),
    expectedToolchainAttestationFileSha256: requiredEnv(
      env,
      "SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256",
    ),
    connectorConfigPath: requiredEnv(env, "SYNTHIA_CONNECTOR_CONFIG"),
    databaseUrl: requiredEnv(env, "DATABASE_URL"),
    gateId,
    scenario,
    proxyOrigin,
  });
  if (authorization.upstream_origin !== upstreamOrigin) {
    throw new Error("chaos proxy upstream differs from authorization");
  }
  const log = await EvolutionEvalChaosLogWriter.create({
    path: logPath,
    authorization,
  });
  const chaosFetch = createEvolutionEvalChaosFetch({
    gateId,
    scenario,
    upstreamOrigin,
    record: async (fact) => {
      await log.record(fact);
    },
  });
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const server = Bun.serve({
    hostname,
    port,
    tls: { cert, key },
    fetch: (request) => chaosFetch(request),
  });
  console.log(JSON.stringify({
    mode: "active",
    proxy_started: true,
    gate_id: gateId,
    scenario,
    listen_origin: server.url.origin,
    upstream_origin: upstreamOrigin,
    log_path: logPath,
    authorization_hash: authorization.authorization_hash,
    run_nonce: authorization.run_nonce,
  }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await log.seal();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "M4F_CHAOS_PROXY_FAILED");
    process.exitCode = 1;
  });
}
