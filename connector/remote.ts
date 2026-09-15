import { createHash } from "node:crypto";
import type {
  ConnectorCapability,
  EvidenceManifest,
  Job,
  JobRequest,
} from "./index.ts";
import {
  EVOLUTION_EVAL_EVIDENCE_LIMITS,
  EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES,
  canonicalEvolutionEvalHash,
  evaluateEvolutionEvalDiscoveryPolicy,
  validateCoreIssuedEvalBinding,
  validateEvalLedgerQuery,
  type CoreIssuedEvalBinding,
  type EvalLedgerQuery,
  type EvolutionEvalPreflightResultV1,
  type EvolutionEvalConnectorEvidenceContentV1,
  type EvolutionEvalConnectorEvidenceManifestV1,
  type EvolutionEvalRetentionResultV1,
  type EvolutionEvalRemoteRequestV1,
  type EvolutionEvalSealedInputV1,
  type EvolutionEvalSpoolResultV1,
} from "./evolution-eval.ts";

export const REMOTE_SCHEMA_VERSION = "connector.remote.v1" as const;
export const EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER = "x-synthia-evolution-eval-active-config-sha256" as const;
export const EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER = "x-synthia-evolution-eval-worker-process-instance-id" as const;
export const EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER = "x-synthia-evolution-eval-vivado-toolchain-attestation-sha256" as const;
export const MAX_EVIDENCE_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_EVIDENCE_ENTRIES = 64;
export const MAX_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_EVIDENCE_PREVIEW_BYTES = 257 * 1024;
export type TransportMode = "direct_https" | "outbound_tunnel";
export type AuthMode = "mtls";
export type RegistrationState =
  "registering" | "approved" | "ready" | "degraded" | "offline" | "revoked";
export type DataClassification =
  "public" | "internal" | "confidential" | "restricted";
export interface ConnectorEndpoint {
  connector_id: string;
  display_name: string;
  endpoint_url: string;
  protocol_version: string;
  transport_mode: TransportMode;
  auth_mode: AuthMode;
  tls_trust_ref: string;
  tls_client_cert_ref: string;
  project_scope: readonly string[];
  data_classification_scope: readonly DataClassification[];
  allowed_capability_ids: readonly string[];
  toolchain_profile_hash: string;
  worker_labels: Readonly<Record<string, string>>;
  heartbeat_interval_seconds: number;
  lease_seconds: number;
  max_concurrency: number;
  registration_state: RegistrationState;
  created_at: string;
  updated_at: string;
  audited_by: string;
  expected_capability_map_version?: string;
  expected_part_catalog_hash?: string;
  expected_sdk_worker_build_hash?: string;
}
export interface DiscoverySnapshot {
  connector_id: string;
  connector_protocol_version: string;
  capability_map_version: string;
  vivado_version: string;
  vivado_patch: string;
  part_catalog_hash: string;
  sdk_worker_build_hash: string;
  /** Optional for legacy/generic discovery; mandatory when any capability advertises evolution_eval. */
  active_config_sha256?: string;
  /** Random per Worker server start and stable for that process lifetime. */
  worker_process_instance_id?: string;
  /** Raw SHA-256 of the strict Vivado toolchain attestation read by this process. */
  vivado_toolchain_attestation_sha256?: string;
  /** Result of the current backing/image/read-only mapping recheck. */
  live_mapping_health?: "healthy" | "unavailable";
  capabilities: readonly ConnectorCapability[];
  toolchain_profile_hash: string;
  license_status: "available" | "unavailable" | "unknown";
  unsupported?: readonly string[];
}
export interface ConnectorRegistration extends ConnectorEndpoint {
  discovered?: DiscoverySnapshot;
  last_heartbeat_at?: string;
  lease_expires_at?: string;
  capability_drift?: boolean;
}
export interface RemoteEnvelope<T> {
  schema_version: typeof REMOTE_SCHEMA_VERSION;
  correlation_id: string;
  causation_id?: string;
  idempotency_key: string;
  actor: { actor_type: "user" | "service"; actor_id: string };
  project_id: string;
  classification: DataClassification;
  capability_version: string;
  payload: T;
}
export interface RemoteResponse<T> {
  status: number;
  body: RemoteEnvelope<T> | { error_code: string; message?: string };
}
export interface RemoteTransport {
  request(
    path: string,
    request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown>; headers?: Readonly<Record<string, string>> },
  ): Promise<RemoteResponse<unknown>>;
  requestStream?(
    path: string,
    request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown> },
  ): Promise<{ readonly status: number; readonly headers: Headers; readonly body: ReadableStream<Uint8Array> | null }>;
}
export class RemoteConnectorError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "RemoteConnectorError";
  }
}
export interface EvolutionEvalRemoteAttestation {
  readonly active_config_sha256: string;
  readonly worker_process_instance_id: string;
  readonly vivado_toolchain_attestation_sha256: string;
}
const classes: readonly DataClassification[] = [
    "public",
    "internal",
    "confidential",
    "restricted",
  ],
  states: readonly RegistrationState[] = [
    "registering",
    "approved",
    "ready",
    "degraded",
    "offline",
    "revoked",
  ],
  runClasses: readonly string[] = [
    "exploratory",
    "gate_check",
    "formal",
    "evolution_eval",
  ],
  idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  refRe = /^(secret|vault|cert):\/\/[A-Za-z0-9._~:/-]+$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function required(v: unknown, n: string): asserts v is string {
  if (typeof v !== "string" || !v.trim())
    throw new RemoteConnectorError("CONFIG_INVALID", `${n} must be non-empty`);
}
function ref(v: unknown, n: string): asserts v is string {
  required(v, n);
  if (!refRe.test(v) || v.includes("-----BEGIN"))
    throw new RemoteConnectorError(
      "SECRET_VALUE_FORBIDDEN",
      `${n} must be a reference`,
    );
}
function validId(v: unknown) {
  return typeof v === "string" && idRe.test(v);
}
function uniqueList(
  v: unknown,
  n: string,
  check: (x: unknown) => boolean,
): asserts v is readonly unknown[] {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.some((x) => !check(x)) ||
    new Set(v).size !== v.length
  )
    throw new RemoteConnectorError("CONFIG_INVALID", `${n} invalid`);
}
function validTimestamp(v: unknown, n: string) {
  required(v, n);
  if (Number.isNaN(Date.parse(v)))
    throw new RemoteConnectorError("CONFIG_INVALID", `${n} invalid`);
}
function allowedHostname(v: unknown, n: string): string {
  required(v, n);
  const h = v.trim().toLowerCase();
  if (
    !h ||
    h.includes("://") ||
    h.includes("/") ||
    h.includes("*") ||
    h.endsWith(".")
  )
    throw new RemoteConnectorError("CONFIG_INVALID", `${n} invalid`);
  return h;
}
export function validateConnectorEndpoint(
  e: ConnectorEndpoint,
  o: { devMode?: boolean; allowlist: readonly string[] },
): ConnectorEndpoint {
  if (!object(e)) throw new RemoteConnectorError("CONFIG_INVALID");
  for (const n of [
    "connector_id",
    "display_name",
    "protocol_version",
    "toolchain_profile_hash",
    "audited_by",
  ] as const)
    required(e[n], n);
  if (!validId(e.connector_id))
    throw new RemoteConnectorError("CONFIG_INVALID", "connector_id malformed");
  required(e.endpoint_url, "endpoint_url");
  let u: URL;
  try {
    u = new URL(e.endpoint_url);
  } catch {
    throw new RemoteConnectorError("CONFIG_INVALID", "endpoint_url malformed");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !u.hostname
  ) {
    const code =
      u.protocol !== "https:" ? "INSECURE_ENDPOINT" : "CONFIG_INVALID";
    throw new RemoteConnectorError(code, `${code}: endpoint_url invalid`);
  }
  const h = allowedHostname(u.hostname, "endpoint hostname");
  const allow = (o.allowlist ?? []).map((x) =>
    allowedHostname(x, "allowlist hostname"),
  );
  if (!allow.length || !allow.includes(h))
    throw new RemoteConnectorError("ENDPOINT_NOT_ALLOWLISTED");
  if (e.protocol_version !== REMOTE_SCHEMA_VERSION)
    throw new RemoteConnectorError("UNSUPPORTED_PROTOCOL");
  if (e.transport_mode !== "direct_https")
    throw new RemoteConnectorError("UNSUPPORTED_TRANSPORT");
  if (e.auth_mode !== "mtls")
    throw new RemoteConnectorError("UNSUPPORTED_AUTH");
  ref(e.tls_trust_ref, "tls_trust_ref");
  ref(e.tls_client_cert_ref, "tls_client_cert_ref");
  uniqueList(e.project_scope, "project_scope", validId);
  uniqueList(
    e.data_classification_scope,
    "classification scope",
    (x) => typeof x === "string" && classes.includes(x as DataClassification),
  );
  uniqueList(e.allowed_capability_ids, "capability scope", validId);
  if (
    !object(e.worker_labels) ||
    Object.values(e.worker_labels).some(
      (v) => typeof v !== "string" || !v.trim(),
    )
  )
    throw new RemoteConnectorError("CONFIG_INVALID", "worker_labels invalid");
  if (
    !Number.isInteger(e.heartbeat_interval_seconds) ||
    e.heartbeat_interval_seconds < 1
  )
    throw new RemoteConnectorError("CONFIG_INVALID", "heartbeat invalid");
  if (
    !Number.isInteger(e.lease_seconds) ||
    e.lease_seconds < e.heartbeat_interval_seconds * 2
  )
    throw new RemoteConnectorError("CONFIG_INVALID", "lease invalid");
  if (!Number.isInteger(e.max_concurrency) || e.max_concurrency < 1)
    throw new RemoteConnectorError("CONFIG_INVALID", "concurrency invalid");
  if (!states.includes(e.registration_state))
    throw new RemoteConnectorError("CONFIG_INVALID", "state invalid");
  validTimestamp(e.created_at, "created_at");
  validTimestamp(e.updated_at, "updated_at");
  for (const n of [
    "expected_capability_map_version",
    "expected_part_catalog_hash",
    "expected_sdk_worker_build_hash",
  ] as const)
    if (e[n] !== undefined) required(e[n], n);
  return structuredClone(e);
}
function validateDiscovery(
  d: unknown,
  e: ConnectorEndpoint,
): DiscoverySnapshot {
  if (
    !object(d) ||
    d.connector_id !== e.connector_id ||
    typeof d.connector_protocol_version !== "string" ||
    typeof d.capability_map_version !== "string" ||
    typeof d.vivado_version !== "string" ||
    typeof d.vivado_patch !== "string" ||
    typeof d.part_catalog_hash !== "string" ||
    typeof d.sdk_worker_build_hash !== "string" ||
    typeof d.toolchain_profile_hash !== "string" ||
    !(["available", "unavailable", "unknown"] as const).includes(
      d.license_status as never,
    ) ||
    !Array.isArray(d.capabilities)
  )
    throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
  if (d.connector_protocol_version !== REMOTE_SCHEMA_VERSION)
    throw new RemoteConnectorError("UNSUPPORTED_PROTOCOL");
  for (const c of d.capabilities)
    if (
      !object(c) ||
      typeof c.operation !== "string" ||
      !validId(c.operation) ||
      typeof c.version !== "string" ||
      !Array.isArray(c.runClasses) ||
      !c.runClasses.length ||
      c.runClasses.some((x) => typeof x !== "string" || !runClasses.includes(x))
    )
      throw new RemoteConnectorError("CAPABILITY_UNAVAILABLE");
  // The wire may carry server-internal CapabilityDefinition fields (inputKind,
  // outputKind, execution); ConnectorCapability is the frozen client contract.
  const capabilities = d.capabilities.map((c) => ({
    operation: c.operation,
    version: c.version,
    runClasses: [...c.runClasses],
  }));
  const activeConfigValid = typeof d.active_config_sha256 === "string" && /^[0-9a-f]{64}$/.test(d.active_config_sha256);
  const processInstanceValid = typeof d.worker_process_instance_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(d.worker_process_instance_id);
  const toolchainAttestationValid = typeof d.vivado_toolchain_attestation_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(d.vivado_toolchain_attestation_sha256);
  if ((d.active_config_sha256 !== undefined && !activeConfigValid)
    || (d.worker_process_instance_id !== undefined && !processInstanceValid)) {
    throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
  }
  if (capabilities.some((capability) => capability.runClasses.includes("evolution_eval"))) {
    if (!activeConfigValid || !processInstanceValid || !toolchainAttestationValid || d.live_mapping_health !== "healthy") {
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    }
    const policy = evaluateEvolutionEvalDiscoveryPolicy(capabilities, "vivado-batch-1");
    if (!policy.eligible) throw new RemoteConnectorError("CAPABILITY_UNAVAILABLE");
  }
  return structuredClone({ ...d, capabilities } as unknown as DiscoverySnapshot);
}
const makeId = (p: string) => `${p}-${crypto.randomUUID()}`;
export interface RemoteClientOptions {
  endpoint: ConnectorEndpoint;
  transport: RemoteTransport;
  actor: { actor_type: "user" | "service"; actor_id: string };
  classification: DataClassification;
  projectId: string;
  allowlist: readonly string[];
  devMode?: boolean;
  correlationId?: () => string;
}
export interface ApprovalContext {
  baselineId?: string;
  approvedGateResultId?: string;
  gateSubmissionId?: string;
  inputApproved?: boolean;
  projectId?: string;
}
function capabilitySupports(
  d: DiscoverySnapshot | undefined,
  operation: string,
  runClass: string,
  version: string,
): boolean {
  const cap = d?.capabilities.find((x) => x.operation === operation);
  return !!cap && cap.version === version && cap.runClasses.includes(runClass);
}
export interface EvidenceContent {
  content: string;
  bytes: Uint8Array;
  sha256: string;
  truncated: boolean;
  mediaType: string;
}
interface EvidenceContentEnvelope {
  name: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  content_base64: string;
  truncated: boolean;
}
function decodeBase64(b64: string): Uint8Array {
  if (
    b64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      b64,
    )
  )
    throw new RemoteConnectorError("EVIDENCE_CORRUPT");
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new RemoteConnectorError("EVIDENCE_CORRUPT");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(bytes.byteLength);
  normalized.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", normalized);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function exactRemoteKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function expectedEvolutionEvidenceMedia(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".rpt") || lower.endsWith(".log") || lower.endsWith(".tcl")) return "text/plain";
  if (lower.endsWith(".bit") || lower.endsWith(".dcp")) return "application/octet-stream";
  return null;
}
export class RemoteConnectorClient {
  private readonly e: ConnectorEndpoint;
  private readonly t: RemoteTransport;
  private readonly a: RemoteClientOptions["actor"];
  private readonly c: DataClassification;
  private readonly p: string;
  private readonly corr: () => string;
  private s: RegistrationState;
  private drift = false;
  private lease?: number;
  private discovered?: DiscoverySnapshot;
  constructor(o: RemoteClientOptions) {
    this.e = validateConnectorEndpoint(o.endpoint, o);
    this.t = o.transport;
    this.a = o.actor;
    this.c = o.classification;
    this.p = o.projectId;
    this.corr = o.correlationId ?? (() => makeId("corr"));
    if (!this.e.project_scope.includes(this.p))
      throw new RemoteConnectorError("PROJECT_NOT_ALLOWED");
    if (!this.e.data_classification_scope.includes(this.c))
      throw new RemoteConnectorError("CLASSIFICATION_NOT_ALLOWED");
    this.s = this.e.registration_state;
  }
  get state() {
    if (
      this.lease !== undefined &&
      Date.now() >= this.lease &&
      this.s !== "revoked"
    )
      this.s = "offline";
    return this.s;
  }
  get hasCapabilityDrift() {
    return this.drift;
  }
  private async call<T>(
    path: string,
    payload: unknown,
    cap: string,
    key: string,
    correlation: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<RemoteEnvelope<T>> {
    if (this.state === "revoked")
      throw new RemoteConnectorError("ENDPOINT_REVOKED");
    const body: RemoteEnvelope<unknown> = {
      schema_version: REMOTE_SCHEMA_VERSION,
      correlation_id: correlation,
      idempotency_key: key,
      actor: this.a,
      project_id: this.p,
      classification: this.c,
      capability_version: cap,
      payload,
    };
    const r = await this.t.request(path, { method: "POST", body, headers });
    if (
      !r.body ||
      !object(r.body) ||
      r.status < 200 ||
      r.status >= 300 ||
      !("payload" in r.body)
    ) {
      const code =
        object(r.body) && typeof r.body.error_code === "string"
          ? r.body.error_code
          : "REMOTE_PROTOCOL_ERROR";
      throw new RemoteConnectorError(
        code,
        code,
        code !== "unknown_effect" && r.status >= 500,
      );
    }
    const x = r.body as unknown as RemoteEnvelope<T>;
    if (
      x.schema_version !== REMOTE_SCHEMA_VERSION ||
      x.correlation_id !== correlation ||
      x.idempotency_key !== key ||
      x.project_id !== this.p ||
      x.classification !== this.c ||
      x.capability_version !== cap ||
      !object(x.actor) ||
      x.actor.actor_type !== this.a.actor_type ||
      x.actor.actor_id !== this.a.actor_id
    )
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    return x;
  }
  private evolutionEvalBinding(input: CoreIssuedEvalBinding): CoreIssuedEvalBinding {
    if (
      this.a.actor_type !== "service" ||
      this.a.actor_id !== "synthia-core-evolution-eval-dispatcher"
    ) {
      throw new RemoteConnectorError("EVOLUTION_EVAL_OPERATION_FORBIDDEN");
    }
    return validateCoreIssuedEvalBinding(input, this.p);
  }
  private async evolutionEvalCall<T>(
    path: string,
    payload: unknown,
    key: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<T> {
    return (
      await this.call<T>(
        path,
        payload,
        "vivado-batch-1",
        key,
        this.corr(),
        headers,
      )
    ).payload;
  }
  async register() {
    const x = await this.call<ConnectorRegistration>(
      "/registration",
      { endpoint: this.e },
      REMOTE_SCHEMA_VERSION,
      `register:${this.e.connector_id}:${makeId("nonce")}`,
      this.corr(),
    );
    if (!object(x.payload) || x.payload.connector_id !== this.e.connector_id)
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    if (x.payload.registration_state === "revoked")
      throw new RemoteConnectorError("ENDPOINT_REVOKED");
    this.s =
      x.payload.registration_state === "ready"
        ? "approved"
        : x.payload.registration_state;
    return structuredClone(x.payload);
  }
  async heartbeat() {
    if (this.state === "offline")
      throw new RemoteConnectorError("LEASE_EXPIRED");
    const x = await this.call<ConnectorRegistration>(
      "/heartbeat",
      { connector_id: this.e.connector_id },
      REMOTE_SCHEMA_VERSION,
      `heartbeat:${this.e.connector_id}:${makeId("nonce")}`,
      this.corr(),
    );
    if (!object(x.payload) || x.payload.connector_id !== this.e.connector_id)
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    if (x.payload.registration_state === "revoked")
      throw new RemoteConnectorError("ENDPOINT_REVOKED");
    if (x.payload.registration_state === "ready" && !x.payload.discovered)
      throw new RemoteConnectorError("DISCOVERY_REQUIRED");
    this.s = x.payload.registration_state;
    this.drift = x.payload.capability_drift === true;
    if (x.payload.discovered)
      this.discovered = validateDiscovery(x.payload.discovered, this.e);
    if (x.payload.lease_expires_at) {
      const lease = Date.parse(x.payload.lease_expires_at);
      if (Number.isNaN(lease))
        throw new RemoteConnectorError(
          "CONFIG_INVALID",
          "lease_expires_at invalid",
        );
      this.lease = lease;
      if (lease <= Date.now()) {
        this.s = "offline";
        throw new RemoteConnectorError("LEASE_EXPIRED");
      }
    }
    return structuredClone(x.payload);
  }
  async discover() {
    const x = await this.call<DiscoverySnapshot>(
      "/discover",
      { connector_id: this.e.connector_id },
      REMOTE_SCHEMA_VERSION,
      `discover:${this.e.connector_id}:${makeId("nonce")}`,
      this.corr(),
    );
    const d = validateDiscovery(x.payload, this.e);
    this.discovered = d;
    this.drift =
      d.toolchain_profile_hash !== this.e.toolchain_profile_hash ||
      d.connector_protocol_version !== this.e.protocol_version ||
      (this.e.expected_capability_map_version !== undefined &&
        d.capability_map_version !== this.e.expected_capability_map_version) ||
      (this.e.expected_part_catalog_hash !== undefined &&
        d.part_catalog_hash !== this.e.expected_part_catalog_hash) ||
      (this.e.expected_sdk_worker_build_hash !== undefined &&
        d.sdk_worker_build_hash !== this.e.expected_sdk_worker_build_hash) ||
      d.license_status !== "available" ||
      d.capabilities.some(
        (cap) => !this.e.allowed_capability_ids.includes(cap.operation),
      );
    return structuredClone(d);
  }
  async status(id: string) {
    required(id, "jobId");
    return structuredClone(
      (
        await this.call<Job>(
          "/jobs/status",
          { job_id: id },
          "0",
          `status:${id}:${makeId("nonce")}`,
          this.corr(),
        )
      ).payload,
    );
  }
  async evolutionEvalPreflight(
    bindingInput: CoreIssuedEvalBinding,
  ): Promise<EvolutionEvalPreflightResultV1> {
    const binding = this.evolutionEvalBinding(bindingInput);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/preflight",
      { schema: "evolution-eval-preflight-request.v1", binding },
      `eval-preflight:${binding.dispatch.connector_job_id}:${makeId("nonce")}`,
    );
    if (
      !object(result) ||
      Object.keys(result).sort().join(",") !==
        "active_config_sha256,capability_version,eligible,error_code,hard_cap_bytes,license_available,live_mapping_health,operation,schema,unacked_spool_bytes,vivado_toolchain_attestation_sha256,worker_process_instance_id" ||
      result.schema !== "evolution-eval-preflight-result.v1" ||
      typeof result.eligible !== "boolean" ||
      result.operation !== binding.dispatch.operation ||
      (result.capability_version !== null && typeof result.capability_version !== "string") ||
      typeof result.license_available !== "boolean" ||
      typeof result.active_config_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.active_config_sha256) ||
      typeof result.worker_process_instance_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.worker_process_instance_id) ||
      typeof result.vivado_toolchain_attestation_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.vivado_toolchain_attestation_sha256) ||
      result.live_mapping_health !== "healthy" ||
      !Number.isSafeInteger(result.unacked_spool_bytes) ||
      Number(result.unacked_spool_bytes) < 0 ||
      result.hard_cap_bytes !== EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES ||
      (result.error_code !== null && typeof result.error_code !== "string")
    ) throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    return structuredClone(result) as unknown as EvolutionEvalPreflightResultV1;
  }
  async evolutionEvalQuery(bindingInput: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    const binding = this.evolutionEvalBinding(bindingInput);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/query",
      { schema: "evolution-eval-query-request.v1", binding },
      `eval-query:${binding.dispatch.connector_job_id}:${makeId("nonce")}`,
    );
    return validateEvalLedgerQuery(result, binding);
  }
  async evolutionEvalReserve(
    bindingInput: CoreIssuedEvalBinding,
    expectedAttestation: EvolutionEvalRemoteAttestation,
  ): Promise<EvalLedgerQuery> {
    const binding = this.evolutionEvalBinding(bindingInput);
    this.assertEvolutionEvalRemoteAttestation(expectedAttestation);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/reserve",
      { schema: "evolution-eval-reserve-request.v1", binding },
      `eval-reserve:${binding.dispatch.connector_job_id}`,
      {
        [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]: expectedAttestation.active_config_sha256,
        [EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER]: expectedAttestation.worker_process_instance_id,
        [EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER]: expectedAttestation.vivado_toolchain_attestation_sha256,
      },
    );
    return validateEvalLedgerQuery(result, binding);
  }
  async evolutionEvalSubmit(
    bindingInput: CoreIssuedEvalBinding,
    input: EvolutionEvalSealedInputV1,
    expectedAttestation: EvolutionEvalRemoteAttestation,
  ): Promise<EvalLedgerQuery> {
    const binding = this.evolutionEvalBinding(bindingInput);
    this.assertEvolutionEvalRemoteAttestation(expectedAttestation);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/submit",
      { schema: "evolution-eval-submit-request.v1", binding, input },
      binding.dispatch.connector_idempotency_key,
      {
        [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]: expectedAttestation.active_config_sha256,
        [EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER]: expectedAttestation.worker_process_instance_id,
        [EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER]: expectedAttestation.vivado_toolchain_attestation_sha256,
      },
    );
    return validateEvalLedgerQuery(result, binding);
  }
  private assertEvolutionEvalRemoteAttestation(
    expectedAttestation: EvolutionEvalRemoteAttestation | undefined,
  ): asserts expectedAttestation is EvolutionEvalRemoteAttestation {
    if (!expectedAttestation
      || !/^[0-9a-f]{64}$/.test(expectedAttestation.active_config_sha256)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedAttestation.worker_process_instance_id)
      || !/^[0-9a-f]{64}$/.test(expectedAttestation.vivado_toolchain_attestation_sha256)) {
      throw new RemoteConnectorError("EVOLUTION_EVAL_REMOTE_ATTESTATION_REQUIRED");
    }
  }
  async evolutionEvalCancel(
    bindingInput: CoreIssuedEvalBinding,
    reason: "tombstoned" | "deadline" | "shutdown",
  ): Promise<EvalLedgerQuery> {
    const binding = this.evolutionEvalBinding(bindingInput);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/cancel",
      { schema: "evolution-eval-cancel-request.v1", binding, reason },
      `eval-cancel:${binding.dispatch.connector_job_id}:${reason}`,
    );
    return validateEvalLedgerQuery(result, binding);
  }
  async evolutionEvalQuerySpool(bindingInput: CoreIssuedEvalBinding): Promise<EvolutionEvalSpoolResultV1> {
    const binding = this.evolutionEvalBinding(bindingInput);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/spool/query",
      { schema: "evolution-eval-spool-query.v1", binding },
      `eval-spool:${binding.dispatch.connector_job_id}:${makeId("nonce")}`,
    );
    let echoedBinding: CoreIssuedEvalBinding | undefined;
    if (object(result)) {
      try { echoedBinding = validateCoreIssuedEvalBinding(result.binding, binding.project_id); } catch {}
    }
    if (
      !object(result) ||
      Object.keys(result).sort().join(",") !== "binding,hard_cap_bytes,schema,unacked_bytes" ||
      result.schema !== "evolution-eval-spool-result.v1" ||
      JSON.stringify(echoedBinding) !== JSON.stringify(binding) ||
      !Number.isSafeInteger(result.unacked_bytes) ||
      Number(result.unacked_bytes) < 0 ||
      result.hard_cap_bytes !== EVOLUTION_EVAL_SPOOL_HARD_CAP_BYTES
    ) throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    return structuredClone(result) as unknown as EvolutionEvalSpoolResultV1;
  }
  async evolutionEvalEvidenceManifest(
    bindingInput: CoreIssuedEvalBinding,
  ): Promise<EvolutionEvalConnectorEvidenceManifestV1> {
    const binding = this.evolutionEvalBinding(bindingInput);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/evidence/manifest",
      { schema: "evolution-eval-evidence-manifest-request.v1", binding },
      `eval-evidence-manifest:${binding.dispatch.connector_job_id}:${makeId("nonce")}`,
    );
    if (!exactRemoteKeys(result, [
      "connector_job_id", "dispatch_request_hash", "entries", "eval_job_id", "manifest_hash", "schema",
    ]) || result.schema !== "evolution-eval-connector-evidence-manifest.v1"
      || result.eval_job_id !== binding.dispatch.eval_job_id
      || result.connector_job_id !== binding.dispatch.connector_job_id
      || result.dispatch_request_hash !== binding.dispatch_request_hash
      || !Array.isArray(result.entries)
      || result.entries.length > EVOLUTION_EVAL_EVIDENCE_LIMITS.entries
      || !/^[0-9a-f]{64}$/.test(String(result.manifest_hash))) {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    let prior: string | undefined;
    let total = 0;
    for (const candidate of result.entries) {
      if (!exactRemoteKeys(candidate, [
        "artifact_classification", "media_type", "name", "sha256", "size_bytes", "usage_classification",
      ])) throw new RemoteConnectorError("EVIDENCE_CORRUPT");
      const name = candidate.name;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)
        || (prior !== undefined && prior >= name) || !/^[0-9a-f]{64}$/.test(String(candidate.sha256))
        || !Number.isSafeInteger(candidate.size_bytes) || Number(candidate.size_bytes) < 0
        || Number(candidate.size_bytes) > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes
        || !(["application/json", "text/plain", "application/octet-stream"] as const).includes(candidate.media_type as never)
        || (expectedEvolutionEvidenceMedia(name) !== null
          && expectedEvolutionEvidenceMedia(name) !== candidate.media_type)
        || candidate.artifact_classification !== (name.toLowerCase().endsWith(".bit")
          ? "experimental/evolution_eval" : "evolution_eval_evidence")
        || candidate.usage_classification !== "evolution_eval_only") {
        throw new RemoteConnectorError("EVIDENCE_CORRUPT");
      }
      prior = name;
      total += Number(candidate.size_bytes);
      if (!Number.isSafeInteger(total) || total > EVOLUTION_EVAL_EVIDENCE_LIMITS.totalBytes) {
        throw new RemoteConnectorError("EVIDENCE_LIMIT_EXCEEDED");
      }
    }
    const manifest = result as unknown as EvolutionEvalConnectorEvidenceManifestV1;
    const { manifest_hash: ignored, ...canonical } = manifest;
    if (canonicalEvolutionEvalHash(canonical) !== manifest.manifest_hash) {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    return structuredClone(manifest);
  }
  async evolutionEvalEvidenceEntry(
    bindingInput: CoreIssuedEvalBinding,
    name: string,
  ): Promise<EvolutionEvalConnectorEvidenceContentV1> {
    const binding = this.evolutionEvalBinding(bindingInput);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)) {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/evidence/entry",
      { schema: "evolution-eval-evidence-entry-request.v1", binding, name },
      `eval-evidence-entry:${binding.dispatch.connector_job_id}:${name}:${makeId("nonce")}`,
    );
    if (!exactRemoteKeys(result, [
      "connector_job_id", "content_base64", "dispatch_request_hash", "eval_job_id", "media_type", "name",
      "schema", "sha256", "size_bytes",
    ]) || result.schema !== "evolution-eval-connector-evidence-entry.v1"
      || result.eval_job_id !== binding.dispatch.eval_job_id
      || result.connector_job_id !== binding.dispatch.connector_job_id
      || result.dispatch_request_hash !== binding.dispatch_request_hash || result.name !== name
      || !/^[0-9a-f]{64}$/.test(String(result.sha256))
      || !Number.isSafeInteger(result.size_bytes) || Number(result.size_bytes) < 0
      || Number(result.size_bytes) > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes
      || !(["application/json", "text/plain", "application/octet-stream"] as const).includes(result.media_type as never)
      || (expectedEvolutionEvidenceMedia(name) !== null && expectedEvolutionEvidenceMedia(name) !== result.media_type)
      || typeof result.content_base64 !== "string"
      || result.content_base64.length > Math.ceil(EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes / 3) * 4) {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    let bytes: Uint8Array;
    try { bytes = decodeBase64(result.content_base64); } catch {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    if (bytes.byteLength !== result.size_bytes || await sha256OfBytes(bytes) !== result.sha256) {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    return structuredClone(result) as unknown as EvolutionEvalConnectorEvidenceContentV1;
  }
  async evolutionEvalEvidenceEntryStream(
    bindingInput: CoreIssuedEvalBinding,
    name: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    const binding = this.evolutionEvalBinding(bindingInput);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name) || !this.t.requestStream) {
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    const correlation = this.corr();
    const key = `eval-evidence-entry:${binding.dispatch.connector_job_id}:${name}:${makeId("nonce")}`;
    const response = await this.t.requestStream("/evolution-eval/evidence/entry", {
      method: "POST",
      body: {
        schema_version: REMOTE_SCHEMA_VERSION,
        correlation_id: correlation,
        idempotency_key: key,
        actor: this.a,
        project_id: this.p,
        classification: this.c,
        capability_version: "vivado-batch-1",
        payload: { schema: "evolution-eval-evidence-entry-request.v1", binding, name },
      },
    });
    if (response.status < 200 || response.status >= 300 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteConnectorError(response.status >= 500 ? "REMOTE_UNAVAILABLE" : "EVIDENCE_NOT_AVAILABLE", undefined, response.status >= 500);
    }
    const lengthValue = response.headers.get("content-length");
    if (lengthValue === null || !/^\d+$/.test(lengthValue)) {
      await response.body.cancel().catch(() => undefined);
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    const expectedBytes = Number(lengthValue);
    const expectedHash = response.headers.get("x-synthia-evidence-sha256");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0
      || expectedBytes > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes
      || response.headers.get("x-synthia-schema") !== "evolution-eval-connector-evidence-entry-stream.v1"
      || response.headers.get("x-synthia-correlation-id") !== correlation
      || response.headers.get("x-synthia-idempotency-key") !== key
      || response.headers.get("x-synthia-project-id") !== this.p
      || response.headers.get("x-synthia-classification") !== this.c
      || response.headers.get("x-synthia-capability-version") !== "vivado-batch-1"
      || response.headers.get("x-synthia-eval-job-id") !== binding.dispatch.eval_job_id
      || response.headers.get("x-synthia-connector-job-id") !== binding.dispatch.connector_job_id
      || response.headers.get("x-synthia-dispatch-request-hash") !== binding.dispatch_request_hash
      || response.headers.get("x-synthia-evidence-name") !== name
      || !/^[0-9a-f]{64}$/.test(String(expectedHash))
      || !(["application/json", "text/plain", "application/octet-stream"] as const).includes(mediaType as never)
      || (expectedEvolutionEvidenceMedia(name) !== null && expectedEvolutionEvidenceMedia(name) !== mediaType)) {
      await response.body.cancel().catch(() => undefined);
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    }
    const stream = response.body;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        const reader = stream.getReader();
        const digest = createHash("sha256");
        let total = 0;
        let complete = false;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > expectedBytes || total > EVOLUTION_EVAL_EVIDENCE_LIMITS.entryBytes) {
              await reader.cancel();
              throw new RemoteConnectorError("EVIDENCE_LIMIT_EXCEEDED");
            }
            const detached = new Uint8Array(part.value.byteLength);
            detached.set(part.value);
            digest.update(detached);
            yield detached;
          }
          if (total !== expectedBytes || digest.digest("hex") !== expectedHash) {
            throw new RemoteConnectorError("EVIDENCE_CORRUPT");
          }
          complete = true;
        } finally {
          if (!complete) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
    };
  }
  private validateEvolutionEvalRetention(
    value: unknown,
    binding: CoreIssuedEvalBinding,
  ): EvolutionEvalRetentionResultV1 {
    if (!exactRemoteKeys(value, [
      "authorization_hash", "authorization_kind", "binding", "connector_fact_hash", "error_code",
      "physical_deleted", "retryable", "schema", "source_authorization_hash", "source_authorization_kind",
      "source_connector_fact_hash", "state",
    ])) throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    let echoed: CoreIssuedEvalBinding;
    try { echoed = validateCoreIssuedEvalBinding(value.binding, binding.project_id); }
    catch { throw new RemoteConnectorError("COMPATIBILITY_REJECTED"); }
    const states = ["absent", "pending_ack", "acknowledged", "quarantined", "discarded", "cleaned", "expired", "transient_unavailable"];
    const kinds = ["ack", "quarantine", "expiry", "discard", "cleanup"];
    if (canonicalEvolutionEvalHash(echoed) !== canonicalEvolutionEvalHash(binding)
      || value.schema !== "evolution-eval-retention-result.v1"
      || typeof value.state !== "string" || !states.includes(value.state)
      || (value.authorization_kind !== null
        && (typeof value.authorization_kind !== "string" || !kinds.includes(value.authorization_kind)))
      || (value.authorization_hash !== null && !/^[0-9a-f]{64}$/.test(String(value.authorization_hash)))
      || (value.connector_fact_hash !== null && !/^[0-9a-f]{64}$/.test(String(value.connector_fact_hash)))
      || (value.source_authorization_kind !== null
        && (typeof value.source_authorization_kind !== "string" || !kinds.includes(value.source_authorization_kind)))
      || (value.source_authorization_hash !== null && !/^[0-9a-f]{64}$/.test(String(value.source_authorization_hash)))
      || (value.source_connector_fact_hash !== null && !/^[0-9a-f]{64}$/.test(String(value.source_connector_fact_hash)))
      || typeof value.retryable !== "boolean"
      || typeof value.physical_deleted !== "boolean"
      || (value.error_code !== null && typeof value.error_code !== "string")) {
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    }
    if ((value.state === "absent" || value.state === "pending_ack") && (value.authorization_kind !== null
      || value.authorization_hash !== null || value.connector_fact_hash !== null
      || value.source_authorization_kind !== null || value.source_authorization_hash !== null
      || value.source_connector_fact_hash !== null || value.retryable || value.error_code !== null
      || value.physical_deleted)) {
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    }
    if (value.state === "transient_unavailable") {
      if (!value.retryable || value.authorization_kind !== null || value.authorization_hash !== null
        || value.connector_fact_hash !== null || value.source_authorization_kind !== null
        || value.source_authorization_hash !== null || value.source_connector_fact_hash !== null
        || typeof value.error_code !== "string") {
        throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
      }
    } else if (!(value.state === "absent" || value.state === "pending_ack") && (value.retryable || value.error_code !== null
      || value.authorization_kind === null || value.authorization_hash === null || value.connector_fact_hash === null)) {
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    }
    if (value.state === "cleaned") {
      if (value.source_authorization_kind === null || value.source_authorization_hash === null
        || value.source_connector_fact_hash === null || !value.physical_deleted) throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    } else if (value.source_authorization_kind !== null || value.source_authorization_hash !== null
      || value.source_connector_fact_hash !== null) throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    return structuredClone(value) as unknown as EvolutionEvalRetentionResultV1;
  }
  async evolutionEvalQueryRetention(bindingInput: CoreIssuedEvalBinding): Promise<EvolutionEvalRetentionResultV1> {
    const binding = this.evolutionEvalBinding(bindingInput);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/retention/query",
      { schema: "evolution-eval-retention-query-request.v1", binding },
      `eval-retention-query:${binding.dispatch.connector_job_id}:${makeId("nonce")}`,
    );
    return this.validateEvolutionEvalRetention(result, binding);
  }
  async evolutionEvalAcknowledgeEvidence(
    request: Extract<EvolutionEvalRemoteRequestV1, { schema: "evolution-eval-evidence-ack-request.v1" }>,
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = this.evolutionEvalBinding(request.binding);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/evidence/ack",
      { ...request, binding },
      `eval-evidence-ack:${binding.dispatch.connector_job_id}:${request.core_ack_fact_hash}`,
    );
    return this.validateEvolutionEvalRetention(result, binding);
  }
  async evolutionEvalAcknowledgeCorrupt(
    request: Extract<EvolutionEvalRemoteRequestV1, { schema: "evolution-eval-evidence-corrupt-ack-request.v1" }>,
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = this.evolutionEvalBinding(request.binding);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/evidence/corrupt-ack",
      { ...request, binding },
      `eval-evidence-corrupt-ack:${binding.dispatch.connector_job_id}:${request.core_quarantine_fact_hash}`,
    );
    return this.validateEvolutionEvalRetention(result, binding);
  }
  async evolutionEvalCleanupEvidence(
    request: Extract<EvolutionEvalRemoteRequestV1, { schema: "evolution-eval-evidence-cleanup-request.v1" }>,
  ): Promise<EvolutionEvalRetentionResultV1> {
    const binding = this.evolutionEvalBinding(request.binding);
    const result = await this.evolutionEvalCall<unknown>(
      "/evolution-eval/evidence/cleanup",
      { ...request, binding },
      `eval-evidence-cleanup:${binding.dispatch.connector_job_id}:${request.core_cleanup_fact_hash}`,
    );
    return this.validateEvolutionEvalRetention(result, binding);
  }
  async submit(r: JobRequest, approval?: ApprovalContext) {
    if (r.runClass === "evolution_eval") {
      throw new RemoteConnectorError("EVOLUTION_EVAL_DEDICATED_ROUTE_REQUIRED");
    }
    if (this.state === "offline")
      throw new RemoteConnectorError("LEASE_EXPIRED");
    if (this.state !== "ready")
      throw new RemoteConnectorError("ENDPOINT_NOT_APPROVED");
    if (this.drift) throw new RemoteConnectorError("CAPABILITY_DRIFT");
    if (r.projectId !== this.p)
      throw new RemoteConnectorError("PROJECT_SCOPE_MISMATCH");
    required(r.idempotencyKey, "idempotencyKey");
    required(r.correlationId, "correlationId");
    if (!this.e.allowed_capability_ids.includes(r.operation))
      throw new RemoteConnectorError("CAPABILITY_UNAVAILABLE");
    const version =
      (r as JobRequest & { capabilityVersion?: string }).capabilityVersion ??
      this.discovered?.capabilities.find((cap) => cap.operation === r.operation)
        ?.version ??
      "fake-1";
    if (
      this.discovered &&
      !capabilitySupports(this.discovered, r.operation, r.runClass, version)
    )
      throw new RemoteConnectorError("CAPABILITY_UNAVAILABLE");
    if (r.runClass === "gate_check" && !approval?.gateSubmissionId)
      throw new RemoteConnectorError("GATE_SUBMISSION_REQUIRED");
    if (
      r.runClass === "formal" &&
      (!approval?.inputApproved ||
        (!approval.baselineId && !approval.approvedGateResultId) ||
        (approval.projectId !== undefined && approval.projectId !== this.p))
    )
      throw new RemoteConnectorError("FORMAL_GATE_REQUIRED");
    if (r.runClass === "formal" && r.input.startsWith("candidate:"))
      throw new RemoteConnectorError("CANDIDATE_FORMAL_REJECTED");
    const result = (
      await this.call<Job>(
        "/jobs/submit",
        { request: r, approval },
        version,
        r.idempotencyKey,
        r.correlationId,
      )
    ).payload;
    if (
      !object(result) ||
      !object(result.request) ||
      result.request.projectId !== this.p ||
      result.request.operation !== r.operation ||
      result.request.runClass !== r.runClass ||
      result.request.idempotencyKey !== r.idempotencyKey ||
      result.request.correlationId !== r.correlationId
    )
      throw new RemoteConnectorError("COMPATIBILITY_REJECTED");
    return structuredClone(result as Job);
  }
  async cancel(id: string) {
    required(id, "jobId");
    return structuredClone(
      (
        await this.call<Job>(
          "/jobs/cancel",
          { job_id: id },
          "0",
          `cancel:${id}:${makeId("nonce")}`,
          this.corr(),
        )
      ).payload,
    );
  }
  async evidence(id: string) {
    required(id, "jobId");
    const m = (
      await this.call<EvidenceManifest>(
        "/jobs/evidence",
        { job_id: id },
        "0",
        `evidence:${id}:${makeId("nonce")}`,
        this.corr(),
      )
    ).payload;
    if (
      !object(m) ||
      m.jobId !== id ||
      !Array.isArray(m.entries) ||
      m.entries.length > MAX_EVIDENCE_ENTRIES ||
      !m.entries.every(
        (e) =>
          object(e) &&
          typeof e.name === "string" &&
          /^[a-f0-9]{64}$/.test(String(e.sha256)) &&
          Number.isSafeInteger(e.sizeBytes) &&
          Number(e.sizeBytes) >= 0 &&
          Number(e.sizeBytes) <= MAX_EVIDENCE_ENTRY_BYTES &&
          typeof e.mediaType === "string" &&
          !!e.mediaType,
      )
    )
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    const total = m.entries.reduce((sum, e) => sum + Number(e.sizeBytes), 0);
    if (!Number.isSafeInteger(total) || total > MAX_EVIDENCE_TOTAL_BYTES)
      throw new RemoteConnectorError("EVIDENCE_LIMIT_EXCEEDED");
    return structuredClone(m as EvidenceManifest);
  }
  async fetchEvidenceContent(
    id: string,
    name: string,
    options: { complete?: boolean } = {},
  ): Promise<EvidenceContent> {
    required(id, "jobId");
    required(name, "name");
    const payload =
      options.complete === true
        ? { job_id: id, name, complete: true }
        : { job_id: id, name };
    const m = (
      await this.call<EvidenceContentEnvelope>(
        "/jobs/evidence/content",
        payload,
        "0",
        `evidence-content:${id}:${name}:${makeId("nonce")}`,
        this.corr(),
      )
    ).payload;
    if (
      !object(m) ||
      m.name !== name ||
      typeof m.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.sha256) ||
      typeof m.content_base64 !== "string" ||
      typeof m.truncated !== "boolean" ||
      typeof m.mediaType !== "string" ||
      !m.mediaType ||
      !Number.isSafeInteger(m.sizeBytes) ||
      m.sizeBytes < 0 ||
      m.sizeBytes > MAX_EVIDENCE_ENTRY_BYTES
    )
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    const maxEncoded = Math.ceil(MAX_EVIDENCE_ENTRY_BYTES / 3) * 4;
    if (m.content_base64.length > maxEncoded)
      throw new RemoteConnectorError("EVIDENCE_LIMIT_EXCEEDED");
    const bytes = decodeBase64(m.content_base64);
    if (options.complete === true && m.truncated)
      throw new RemoteConnectorError(
        "EVIDENCE_CORRUPT",
        "complete evidence request was truncated",
      );
    if (m.truncated && bytes.byteLength > MAX_EVIDENCE_PREVIEW_BYTES)
      throw new RemoteConnectorError("EVIDENCE_LIMIT_EXCEEDED");
    if (
      !m.truncated &&
      (bytes.byteLength !== m.sizeBytes ||
        (await sha256OfBytes(bytes)) !== m.sha256)
    )
      throw new RemoteConnectorError("EVIDENCE_CORRUPT");
    return {
      content: new TextDecoder("utf-8").decode(bytes),
      bytes,
      sha256: m.sha256,
      truncated: m.truncated,
      mediaType: m.mediaType,
    };
  }
}
