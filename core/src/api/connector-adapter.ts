/**
 * Synthia Core API — production Connector adapter (IF-002 run/connector slice)
 *
 * Implements {@link ConnectorPort} by delegating to the real remote Connector
 * client built from `connector/http.ts`'s `createEnvironmentCloudflareRemoteConnector`.
 *
 * Core is multi-project but `RemoteConnectorClient` is constructed single-project
 * (it validates project scope at construction), so the adapter caches one client
 * per `projectId` and lazily drives it through register → heartbeat → discover
 * before submit, surfacing drift / lease / capability rejection as
 * {@link ConnectorError} (→ 503 at the handler).
 *
 * The Connector factory is loaded with a **dynamic import** so the heavy
 * Connector module graph is pulled in only when this adapter is actually built
 * (production, env-driven). The test path injects a fake `ConnectorPort` and
 * never loads this module, keeping the Core test graph Connector-free.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import type { RunClass, ToolRunState } from "../domain/enums.ts";
import {
  EVOLUTION_EVAL_LIMITS,
  canonicalEvolutionEvalSealedInputProjection,
  evolutionEvalCanonicalHash,
} from "../domain/evolution-eval.ts";
import {
  validateEvolutionEvalLedgerObservation,
} from "../services/evolution-eval-dispatcher.ts";
import type {
  CoreIssuedEvalBinding,
  EvalCancelReason,
  EvalEvidenceAckRequestV1,
  EvalEvidenceCleanupRequestV1,
  EvalEvidenceConnectorManifestV1,
  EvalEvidenceCorruptAckRequestV1,
  EvalLedgerQuery,
  EvalPreflight,
  EvalRetentionResult,
  EvolutionEvalConnectorPort,
  SealedEvalInput,
} from "../services/evolution-eval-connector-port.ts";
import {
  ConnectorError,
  type ConnectorDiscovery,
  type ConnectorJobSnapshot,
  type ConnectorPort,
  type EvidenceContent,
  type EvidenceContentOptions,
  type EvidenceManifest,
  type SubmitJobParams,
} from "./connector-port.ts";

/** Fixed production tunnel endpoint — the public Cloudflare origin for worker 66. */
const PRODUCTION_ENDPOINT_URL = "https://connect.wenzhuolin.xyz";
const M4F_DIRECT_MTLS_ENDPOINT_URL = "https://100.96.223.49:18443";
const M4F_DIRECT_MTLS_AUTHORIZATION = "I_AUTHORIZE_M4F_18443_DIRECT_MTLS";
const M4F_DIRECT_MTLS_TRUST_REF = "cert://m4f-direct/trust";
const M4F_DIRECT_MTLS_CLIENT_REF = "cert://m4f-direct/client";
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TLS_MATERIAL_BYTES = 1024 * 1024;

// ─── structural shapes of the Connector client we depend on ───────────────────
// Locally declared (not imported) so this module does not pull Connector types
// into Core's compile-time graph. The dynamically-imported factory returns an
// object that is structurally compatible with `RemoteClientLike`.

interface RemoteJobRequest {
  jobId?: string;
  idempotencyKey: string;
  projectId: string;
  operation: string;
  runClass: RunClass;
  input: string;
  correlationId: string;
  capabilityVersion?: string;
  /** Worker vivado.execute() reads parameters as a non-empty object (else
   *  VIVADO_PARAMETERS_REQUIRED). Must repeat operation/jobId/projectId/runClass
   *  plus the source/constraint payload (see buildRemoteParameters). */
  parameters: Record<string, unknown>;
}

/** remote.ts ApprovalContext shape (gate_check/formal client-side guard). */
interface RemoteApproval {
  gateSubmissionId?: string;
  approvedGateResultId?: string;
  baselineId?: string;
  inputApproved?: boolean;
  projectId?: string;
}

interface RemoteJob {
  id: string;
  state: ToolRunState;
  outputSha256?: string;
  errorCode?: string;
}

interface RemoteEvidenceEntry {
  name: string;
  uri?: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

interface RemoteEvidenceManifest {
  jobId: string;
  entries: RemoteEvidenceEntry[];
}

/** remote.ts EvidenceContent shape — the decoded content of one artifact
 *  (POST /jobs/evidence/content response). Does not echo `name` back. */
interface RemoteEvidenceContent {
  content: string;
  bytes?: Uint8Array;
  sha256: string;
  truncated: boolean;
  mediaType: string;
}

interface RemoteCapability {
  operation: string;
  version: string;
  runClasses: readonly string[];
}

interface RemoteDiscovery {
  capabilities: readonly RemoteCapability[];
  connector_protocol_version?: string;
  toolchain_profile_hash?: string;
  sdk_worker_build_hash?: string;
  active_config_sha256?: string;
  worker_process_instance_id?: string;
  vivado_toolchain_attestation_sha256?: string;
  live_mapping_health?: "healthy" | "unavailable";
}

interface RemoteEvolutionEvalAttestation {
  readonly active_config_sha256: string;
  readonly worker_process_instance_id: string;
  readonly vivado_toolchain_attestation_sha256: string;
}

interface RemoteEvolutionEvalPreflight {
  schema: "evolution-eval-preflight-result.v1";
  eligible: boolean;
  operation: string;
  capability_version: string | null;
  license_available: boolean;
  unacked_spool_bytes: number;
  hard_cap_bytes: 2_147_483_648;
  error_code: string | null;
  active_config_sha256: string;
  worker_process_instance_id: string;
  vivado_toolchain_attestation_sha256: string;
  live_mapping_health: "healthy";
}

interface RemoteEvolutionEvalSpool {
  schema: "evolution-eval-spool-result.v1";
  binding: CoreIssuedEvalBinding;
  unacked_bytes: number;
  hard_cap_bytes: 2_147_483_648;
}

interface RemoteEvolutionEvalSealedInput {
  schema: "evolution-eval-sealed-input.v1";
  manifest: SealedEvalInput["manifest"];
  files: readonly {
    path: string;
    sha256: string;
    size_bytes: number;
    media_type: string;
    content_base64: string;
  }[];
}

interface RemoteRegistration {
  registration_state: string;
}

interface RemoteClientLike {
  register(): Promise<RemoteRegistration>;
  heartbeat(): Promise<RemoteRegistration>;
  discover(): Promise<RemoteDiscovery>;
  submit(req: RemoteJobRequest, approval?: RemoteApproval): Promise<RemoteJob>;
  status(id: string): Promise<RemoteJob>;
  evidence(id: string): Promise<RemoteEvidenceManifest>;
  fetchEvidenceContent(
    id: string,
    name: string,
    options?: { complete?: boolean },
  ): Promise<RemoteEvidenceContent>;
  evolutionEvalPreflight(binding: CoreIssuedEvalBinding): Promise<RemoteEvolutionEvalPreflight>;
  evolutionEvalQuery(binding: CoreIssuedEvalBinding): Promise<unknown>;
  evolutionEvalReserve(
    binding: CoreIssuedEvalBinding,
    attestation: RemoteEvolutionEvalAttestation,
  ): Promise<unknown>;
  evolutionEvalSubmit(
    binding: CoreIssuedEvalBinding,
    input: RemoteEvolutionEvalSealedInput,
    attestation: RemoteEvolutionEvalAttestation,
  ): Promise<unknown>;
  evolutionEvalCancel(binding: CoreIssuedEvalBinding, reason: EvalCancelReason): Promise<unknown>;
  evolutionEvalQuerySpool(binding: CoreIssuedEvalBinding): Promise<RemoteEvolutionEvalSpool>;
  evolutionEvalEvidenceManifest(
    binding: CoreIssuedEvalBinding,
  ): Promise<EvalEvidenceConnectorManifestV1>;
  evolutionEvalEvidenceEntryStream(
    binding: CoreIssuedEvalBinding,
    name: string,
  ): Promise<AsyncIterable<Uint8Array>>;
  evolutionEvalQueryRetention(binding: CoreIssuedEvalBinding): Promise<unknown>;
  evolutionEvalAcknowledgeEvidence(request: EvalEvidenceAckRequestV1): Promise<unknown>;
  evolutionEvalAcknowledgeCorrupt(request: EvalEvidenceCorruptAckRequestV1): Promise<unknown>;
  evolutionEvalCleanupEvidence(request: EvalEvidenceCleanupRequestV1): Promise<unknown>;
  readonly state: string;
  readonly hasCapabilityDrift: boolean;
}

interface RemoteFactoryOptions {
  endpoint: Record<string, unknown>;
  allowlist: readonly string[];
  actor: { actor_type: "service" | "user"; actor_id: string };
  classification: string;
  projectId: string;
  env?: Record<string, string | undefined>;
  secretNames?: { clientId?: string; clientSecret?: string };
  devMode?: boolean;
}

type RemoteFactory = (options: RemoteFactoryOptions) => RemoteClientLike;

interface DirectMtlsRemoteFactoryOptions extends RemoteFactoryOptions {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}

type DirectMtlsRemoteFactory =
  (options: DirectMtlsRemoteFactoryOptions) => RemoteClientLike;

export interface M4fDirectMtlsMaterial {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
  readonly caSha256: string;
  readonly certSha256: string;
  readonly keySha256: string;
}

function requiredM4fEnvironment(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for direct M4-F mTLS`);
  return value;
}

function readBoundM4fPem(
  path: string,
  expectedSha256: string,
  kind: "ca" | "cert" | "key",
): string {
  if (!isAbsolute(path) || path.length > 1024 || /[\r\n\0]/.test(path)
    || !SHA256.test(expectedSha256)) {
    throw new Error(`direct M4-F ${kind} binding is invalid`);
  }
  let fd: number | null = null;
  try {
    const pathBefore = lstatSync(path);
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (pathBefore.isSymbolicLink() || !before.isFile() || before.nlink !== 1
      || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
      || bytes.length < 1 || bytes.length > MAX_TLS_MATERIAL_BYTES
      || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new Error(`direct M4-F ${kind} binding is untrusted`);
    }
    const pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const marker = kind === "key"
      ? /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/
      : /-----BEGIN CERTIFICATE-----/;
    if (!marker.test(pem) || /\0/.test(pem)) {
      throw new Error(`direct M4-F ${kind} PEM is invalid`);
    }
    return pem;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("direct M4-F")) throw error;
    throw new Error(`direct M4-F ${kind} binding is unavailable`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function loadM4fDirectMtlsMaterial(
  env: Record<string, string | undefined>,
): M4fDirectMtlsMaterial {
  if (env.SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION !== M4F_DIRECT_MTLS_AUTHORIZATION) {
    throw new Error("SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION is required");
  }
  const caPath = requiredM4fEnvironment(env, "SYNTHIA_M4F_DIRECT_MTLS_CA_PATH");
  const certPath = requiredM4fEnvironment(env, "SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_PATH");
  const keyPath = requiredM4fEnvironment(env, "SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_PATH");
  if (new Set([caPath, certPath, keyPath]).size !== 3) {
    throw new Error("direct M4-F mTLS paths must be distinct");
  }
  const caSha256 = requiredM4fEnvironment(env, "SYNTHIA_M4F_DIRECT_MTLS_CA_SHA256");
  const certSha256 = requiredM4fEnvironment(
    env,
    "SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_SHA256",
  );
  const keySha256 = requiredM4fEnvironment(
    env,
    "SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_SHA256",
  );
  return {
    ca: readBoundM4fPem(caPath, caSha256, "ca"),
    cert: readBoundM4fPem(certPath, certSha256, "cert"),
    key: readBoundM4fPem(keyPath, keySha256, "key"),
    caSha256,
    certSha256,
    keySha256,
  };
}

export interface EvolutionEvalCertifiedRemoteIdentity {
  readonly sdkWorkerBuildHash: string;
  readonly activeConfigSha256: string;
  readonly workerProcessInstanceId: string;
  readonly ledgerEpoch: string;
  readonly vivadoToolchainAttestationSha256: string;
  readonly toolchainProfileHash: string;
}

export type EvolutionEvalCertificationProvider =
  () => Promise<EvolutionEvalCertifiedRemoteIdentity>;

// ─── error translation ───────────────────────────────────────────────────────

/** Translate any thrown value into a {@link ConnectorError}. */
export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  if (err instanceof Error && "code" in err) {
    const code = String((err as { code: unknown }).code);
    const retryable = Boolean((err as { retryable?: unknown }).retryable);
    return new ConnectorError(code, err.message || code, retryable);
  }
  return new ConnectorError("REMOTE_UNAVAILABLE", err instanceof Error ? err.message : "connector error", true);
}

/** LEASE_EXPIRED may surface from either a proactive heartbeat or the submit
 *  call itself (Worker checks leaseExpiresAt at submit, worker.ts:47). */
function isLeaseExpiredError(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    return err.code === "LEASE_EXPIRED";
  }
  return false;
}

function isExactEvolutionEvalBinding(
  actual: unknown,
  expected: CoreIssuedEvalBinding,
): boolean {
  try {
    return evolutionEvalCanonicalHash(actual) === evolutionEvalCanonicalHash(expected);
  } catch {
    return false;
  }
}

/**
 * Client-lifecycle errors that mean the cached client is stale against the
 * worker's CURRENT state — most commonly the worker process restarted and lost
 * its in-memory registration/lease (worker state is not durable). Without this
 * check a NOT_REGISTERED heartbeat error would propagate forever because the
 * cached client never gets evicted. Re-priming (register → heartbeat →
 * discover) is the recovery for all of these.
 */
function isStaleClientError(err: unknown): boolean {
  if (isLeaseExpiredError(err)) return true;
  if (err instanceof Error && "code" in err) {
    const code = String((err as { code: unknown }).code);
    return code === "NOT_REGISTERED" || code === "ENDPOINT_NOT_APPROVED" || code === "ENDPOINT_REVOKED";
  }
  return false;
}

/**
 * Build the `parameters` object the Worker's vivado.execute() consumes. The
 * inner object MUST repeat operation/jobId/projectId/runClass (worker server.ts
 * spreads `candidate` to build the VivadoRequest) alongside the source payload.
 * Mirrors runtime/remote-connector.ts buildParameters. `input` is the manifest
 * digest stamp the Worker writes to request-input.txt (value is informational;
 * vivado reads `parameters`, not `input`).
 */
function buildRemoteParameters(params: SubmitJobParams): Record<string, unknown> {
  const p = params.parameters;
  const base: Record<string, unknown> = {
    operation: params.operation,
    jobId: params.jobId,
    projectId: params.projectId,
    runClass: params.runClass,
    inputHash: params.inputHash,
  };
  // Toolchain/part discovery requests have no HDL payload. Including the
  // API-level default `sources: []` changes the structural Vivado request into
  // a source-bearing request, which the Worker correctly rejects as
  // VIVADO_POLICY_REJECTED:NO_SOURCES. Only source-consuming operations should
  // carry this member across the Connector boundary.
  if (params.operation !== "discover_toolchain" && params.operation !== "query_parts") {
    base.sources = p.sources;
  }
  if (params.toolchainProfileHash !== undefined) {
    base.toolchainHash = params.toolchainProfileHash;
  }
  if (p.top !== undefined) base.top = p.top;
  if (p.part !== undefined) base.part = p.part;
  if (p.testbench !== undefined) base.testbench = p.testbench;
  if (p.constraints.length > 0) base.constraints = p.constraints;
  if (p.stopBeforeBitstream !== undefined) base.stopBeforeBitstream = p.stopBeforeBitstream;
  if (p.timeoutMs !== undefined) base.timeoutMs = p.timeoutMs;
  return base;
}

/** Map Core's ConnectorApproval to the remote client's ApprovalContext. The
 *  remote client (remote.ts submit) hard-requires gateSubmissionId for
 *  gate_check and inputApproved(+baseline/agr) for formal. */
function buildRemoteApproval(params: SubmitJobParams): RemoteApproval | undefined {
  if (params.runClass === "exploratory") return undefined;
  const a = params.approval ?? {};
  if (params.runClass === "gate_check") {
    return a.gateSubmissionId ? { gateSubmissionId: a.gateSubmissionId } : { gateSubmissionId: undefined };
  }
  // formal
  return {
    inputApproved: true,
    projectId: params.projectId,
    ...(a.baselineId ? { baselineId: a.baselineId } : {}),
    ...(a.approvedGateResultId ? { approvedGateResultId: a.approvedGateResultId } : {}),
  };
}

async function encodeEvolutionEvalSealedInput(
  input: SealedEvalInput,
): Promise<RemoteEvolutionEvalSealedInput> {
  const manifestFiles = input.manifest.files;
  if (manifestFiles.length > EVOLUTION_EVAL_LIMITS.workspace.files) {
    throw new ConnectorError(
      "EVOLUTION_EVAL_RESOURCE_LIMIT",
      "sealed workspace has too many files",
      false,
    );
  }
  const layerTotals = {
    source: { files: 0, bytes: 0 },
    skill: { files: 0, bytes: 0 },
    overlay: { files: 0, bytes: 0 },
  };
  let manifestBytes = 0;
  let previousPortableKey: string | null = null;
  for (const file of manifestFiles) {
    const portableKey = file.path.replace(/[A-Z]/g, (character) => character.toLowerCase());
    if (previousPortableKey !== null && portableKey <= previousPortableKey) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_BINDING_CONFLICT",
        "sealed manifest paths are not in canonical portable order",
        false,
      );
    }
    previousPortableKey = portableKey;
    if ((file.layer === "overlay") === file.read_only) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_BINDING_CONFLICT",
        "sealed manifest layer is not bound to its read-only policy",
        false,
      );
    }
    const limit = EVOLUTION_EVAL_LIMITS[file.layer];
    if (
      !Number.isSafeInteger(file.size_bytes)
      || file.size_bytes < 0
      || file.size_bytes > limit.fileBytes
    ) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_RESOURCE_LIMIT",
        "sealed manifest file exceeds its layer budget",
        false,
      );
    }
    layerTotals[file.layer].files += 1;
    layerTotals[file.layer].bytes += file.size_bytes;
    manifestBytes += file.size_bytes;
  }
  for (const layer of ["source", "skill", "overlay"] as const) {
    const total = layerTotals[layer];
    const limit = EVOLUTION_EVAL_LIMITS[layer];
    if (total.files > limit.files || total.bytes > limit.bytes) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_RESOURCE_LIMIT",
        `sealed ${layer} layer exceeds its budget`,
        false,
      );
    }
  }
  if (manifestBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes) {
    throw new ConnectorError(
      "EVOLUTION_EVAL_RESOURCE_LIMIT",
      "sealed workspace exceeds its total byte budget",
      false,
    );
  }

  // Skill files remain part of Core's immutable workspace/input binding and
  // budget accounting, but Appendix B.2 forbids transmitting even read-only
  // Skill assets to Connector. The remote execution projection is therefore
  // exactly the source+overlay subset; Connector rejects any Skill-layer wire
  // entry and still binds the request to Core's full workspace hash carried by
  // `binding.dispatch.workspace_manifest_hash`.
  const remoteManifestFiles = manifestFiles.filter((file) => file.layer !== "skill");
  const remoteManifestBytes = remoteManifestFiles.reduce(
    (sum, file) => sum + file.size_bytes,
    0,
  );

  const encoded: RemoteEvolutionEvalSealedInput["files"][number][] = [];
  let index = 0;
  let streamedBytes = 0;
  for await (const file of input.files) {
    const expected = remoteManifestFiles[index];
    if (
      !expected
      || file.path !== expected.path
      || file.sha256 !== expected.sha256
      || file.size_bytes !== expected.size_bytes
      || file.media_type !== expected.media_type
    ) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_BINDING_CONFLICT",
        "sealed file stream differs from the canonical manifest",
        false,
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of file.content) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ConnectorError(
          "EVOLUTION_EVAL_BINDING_CONFLICT",
          "sealed file stream contains a non-byte chunk",
          false,
        );
      }
      size += chunk.byteLength;
      streamedBytes += chunk.byteLength;
      if (
        size > expected.size_bytes
        || streamedBytes > EVOLUTION_EVAL_LIMITS.workspace.bytes
      ) {
        throw new ConnectorError(
          "EVOLUTION_EVAL_RESOURCE_LIMIT",
          "sealed file stream exceeds the durable manifest budget",
          false,
        );
      }
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    if (size !== expected.size_bytes || hash.digest("hex") !== expected.sha256) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_BINDING_CONFLICT",
        "sealed file stream size or hash differs from the durable manifest",
        false,
      );
    }
    encoded.push({
      path: expected.path,
      sha256: expected.sha256,
      size_bytes: expected.size_bytes,
      media_type: expected.media_type,
      content_base64: Buffer.concat(chunks, size).toString("base64"),
    });
    index += 1;
  }
  if (index !== remoteManifestFiles.length || streamedBytes !== remoteManifestBytes) {
    throw new ConnectorError(
      "EVOLUTION_EVAL_BINDING_CONFLICT",
      "sealed file stream is incomplete",
      false,
    );
  }
  return {
    schema: "evolution-eval-sealed-input.v1",
    manifest: {
      ...input.manifest,
      files: remoteManifestFiles,
    },
    files: encoded,
  };
}

// ─── adapter ─────────────────────────────────────────────────────────────────

/**
 * Production ConnectorPort backed by the real remote Connector client.
 *
 * Lease lifecycle (mirrors runtime/remote-connector.ts, multi-project):
 *  1. Every operation proactively heartbeats to refresh the Worker lease before
 *     the capability call — long LLM-generation gaps (validate_sources →
 *     simulate ≈40s) otherwise let the 30s lease expire.
 *  2. On LEASE_EXPIRED (heartbeat or submit), a FRESH per-project client is
 *     built (register → heartbeat → discover → drift check) and the call retries
 *     exactly once. A fresh instance is required: RemoteConnectorClient never
 *     clears its internal lease once expired.
 *  3. After any discover, capability drift is fail-closed (CAPABILITY_DRIFT →
 *     503, no retry).
 */
export class RemoteConnectorAdapter implements ConnectorPort, EvolutionEvalConnectorPort {
  private readonly clients = new Map<string, RemoteClientLike>();
  private readonly primed = new Set<string>();
  private readonly evolutionEvalClients = new Map<string, RemoteClientLike>();
  private readonly evolutionEvalPrimed = new Set<string>();
  private readonly factory: RemoteFactory;
  private readonly endpointConfig: Record<string, unknown>;
  private readonly allowlist: readonly string[];
  private readonly env: Record<string, string | undefined>;
  private readonly certifiedEvolutionEvalIdentity?: EvolutionEvalCertifiedRemoteIdentity;
  private readonly currentEvolutionEvalCertification?: EvolutionEvalCertificationProvider;

  constructor(
    factory: RemoteFactory,
    endpointConfig: Record<string, unknown>,
    allowlist: readonly string[],
    env: Record<string, string | undefined>,
    certification?: {
      readonly identity: EvolutionEvalCertifiedRemoteIdentity;
      readonly current: EvolutionEvalCertificationProvider;
    },
  ) {
    this.factory = factory;
    this.endpointConfig = endpointConfig;
    this.allowlist = allowlist;
    this.env = env;
    this.certifiedEvolutionEvalIdentity = certification?.identity;
    this.currentEvolutionEvalCertification = certification?.current;
  }

  get connectorId(): string {
    return String(this.endpointConfig.connector_id ?? "remote-connector");
  }

  /** Startup proof that the live remote still equals the frozen B identity. */
  async revalidateEvolutionEvalCertification(
    binding: CoreIssuedEvalBinding,
    requireFresh = true,
  ): Promise<void> {
    const certification = requireFresh
      ? await this.requireCurrentEvolutionEvalCertification()
      : this.certifiedEvolutionEvalIdentity;
    if (!certification) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_CERTIFICATION_INVALID",
        "evolution-eval certification is not configured",
        false,
      );
    }
    const client = await this.ensureEvolutionEvalReady(binding.project_id);
    const discovery = await client.discover();
    if (requireFresh) {
      if (client.hasCapabilityDrift) {
        throw new ConnectorError(
          "CAPABILITY_DRIFT",
          "evolution-eval connector capability drift detected during certification",
          false,
        );
      }
      this.assertCertifiedDiscovery(discovery, certification);
      this.assertCertifiedLedgerEpoch(validateEvolutionEvalLedgerObservation(
        binding,
        await client.evolutionEvalQuery(binding),
      ));
    } else {
      this.assertEvolutionEvalProtocol(discovery);
    }
  }

  private buildClient(projectId: string): RemoteClientLike {
    try {
      return this.factory({
        endpoint: this.endpointConfig,
        allowlist: this.allowlist,
        actor: { actor_type: "service", actor_id: "synthia-core" },
        classification: "internal",
        projectId,
        env: this.env,
        secretNames: { clientId: "SYNTHIA_CF_ACCESS_CLIENT_ID", clientSecret: "SYNTHIA_CF_ACCESS_CLIENT_SECRET" },
      });
    } catch (err) {
      throw toConnectorError(err);
    }
  }

  private buildEvolutionEvalClient(projectId: string): RemoteClientLike {
    try {
      return this.factory({
        endpoint: this.endpointConfig,
        allowlist: this.allowlist,
        actor: {
          actor_type: "service",
          actor_id: "synthia-core-evolution-eval-dispatcher",
        },
        classification: "internal",
        projectId,
        env: this.env,
        secretNames: {
          clientId: "SYNTHIA_CF_ACCESS_CLIENT_ID",
          clientSecret: "SYNTHIA_CF_ACCESS_CLIENT_SECRET",
        },
      });
    } catch (err) {
      throw toConnectorError(err);
    }
  }

  /** Bring a fresh client through register → heartbeat → discover → drift check. */
  private async bringOnline(client: RemoteClientLike): Promise<void> {
    await client.register();
    await client.heartbeat();
    await client.discover();
    if (client.hasCapabilityDrift) {
      throw new ConnectorError("CAPABILITY_DRIFT", "capability drift detected", false);
    }
    if (client.state !== "ready") {
      throw new ConnectorError("ENDPOINT_NOT_APPROVED", `connector not ready (state=${client.state})`, true);
    }
  }

  /**
   * Ensure a ready client for `projectId`. First call primes (register →
   * heartbeat → discover → drift). Subsequent calls proactively heartbeat to
   * refresh the lease; if that heartbeat sees LEASE_EXPIRED, a fresh client is
   * rebuilt inline. Any other heartbeat error is rethrown.
   */
  private async ensureReady(projectId: string): Promise<RemoteClientLike> {
    if (!this.primed.has(projectId)) {
      const client = this.buildClient(projectId);
      this.clients.set(projectId, client);
      try {
        await this.bringOnline(client);
      } catch (err) {
        this.clients.delete(projectId);
        throw toConnectorError(err);
      }
      this.primed.add(projectId);
      return client;
    }
    const client = this.clients.get(projectId);
    if (!client) {
      // Defensive: primed flag set but client evicted by a prior reconnect
      // failure — re-prime from scratch.
      this.primed.delete(projectId);
      return this.ensureReady(projectId);
    }
    try {
      await client.heartbeat();
    } catch (err) {
      if (isStaleClientError(err)) {
        this.clients.delete(projectId);
        this.primed.delete(projectId);
        return this.ensureReady(projectId);
      }
      throw toConnectorError(err);
    }
    if (client.hasCapabilityDrift) {
      throw new ConnectorError("CAPABILITY_DRIFT", "capability drift detected on heartbeat", false);
    }
    return client;
  }

  /**
   * Evolution-eval uses an actor- and project-isolated client pool. Keeping it
   * separate from generic Job clients prevents either authority from reusing
   * the other's envelope identity, and avoids a mutable last-project context.
   */
  private async ensureEvolutionEvalReady(projectId: string): Promise<RemoteClientLike> {
    if (!this.evolutionEvalPrimed.has(projectId)) {
      const client = this.buildEvolutionEvalClient(projectId);
      this.evolutionEvalClients.set(projectId, client);
      try {
        await client.register();
        await client.heartbeat();
        this.assertEvolutionEvalProtocol(await client.discover());
        if (client.state !== "ready") {
          throw new ConnectorError(
            "ENDPOINT_NOT_APPROVED",
            `connector not ready (state=${client.state})`,
            true,
          );
        }
      } catch (err) {
        this.evolutionEvalClients.delete(projectId);
        throw toConnectorError(err);
      }
      this.evolutionEvalPrimed.add(projectId);
      return client;
    }
    const client = this.evolutionEvalClients.get(projectId);
    if (!client) {
      this.evolutionEvalPrimed.delete(projectId);
      return this.ensureEvolutionEvalReady(projectId);
    }
    try {
      await client.heartbeat();
    } catch (err) {
      if (isLeaseExpiredError(err)) {
        this.evolutionEvalClients.delete(projectId);
        this.evolutionEvalPrimed.delete(projectId);
        return this.ensureEvolutionEvalReady(projectId);
      }
      throw toConnectorError(err);
    }
    return client;
  }

  /**
   * Run `action` against a ready client. If the action throws LEASE_EXPIRED,
   * evict the stale client, rebuild (register → heartbeat → discover → drift),
   * and retry the action exactly once. Drift and all other errors propagate.
   */
  private async withClient<T>(projectId: string, action: (client: RemoteClientLike) => Promise<T>): Promise<T> {
    const client = await this.ensureReady(projectId);
    try {
      return await action(client);
    } catch (err) {
      if (!isStaleClientError(err)) throw toConnectorError(err);
      // Stale client (lease/registration lost, e.g. worker restart) — rebuild and retry once.
      const rebuilt = this.buildClient(projectId);
      this.clients.set(projectId, rebuilt);
      try {
        await this.bringOnline(rebuilt);
      } catch (onlineErr) {
        this.clients.delete(projectId);
        this.primed.delete(projectId);
        throw toConnectorError(onlineErr);
      }
      this.primed.add(projectId);
      return await action(rebuilt);
    }
  }

  private async withEvolutionEvalClient<T>(
    binding: CoreIssuedEvalBinding,
    action: (client: RemoteClientLike) => Promise<T>,
  ): Promise<T> {
    const projectId = binding.project_id;
    const client = await this.ensureEvolutionEvalReady(projectId);
    try {
      return await action(client);
    } catch (err) {
      if (!isLeaseExpiredError(err)) throw toConnectorError(err);
      const rebuilt = this.buildEvolutionEvalClient(projectId);
      this.evolutionEvalClients.set(projectId, rebuilt);
      try {
        await rebuilt.register();
        await rebuilt.heartbeat();
        this.assertEvolutionEvalProtocol(await rebuilt.discover());
        if (rebuilt.state !== "ready") {
          throw new ConnectorError(
            "ENDPOINT_NOT_APPROVED",
            `connector not ready (state=${rebuilt.state})`,
            true,
          );
        }
      } catch (onlineErr) {
        this.evolutionEvalClients.delete(projectId);
        this.evolutionEvalPrimed.delete(projectId);
        throw toConnectorError(onlineErr);
      }
      this.evolutionEvalPrimed.add(projectId);
      return await action(rebuilt);
    }
  }

  private async requireCurrentEvolutionEvalCertification(): Promise<EvolutionEvalCertifiedRemoteIdentity | undefined> {
    if (!this.currentEvolutionEvalCertification) return undefined;
    try {
      const current = await this.currentEvolutionEvalCertification();
      const startup = this.certifiedEvolutionEvalIdentity;
      if (
        !startup
        || current.sdkWorkerBuildHash !== startup.sdkWorkerBuildHash
        || current.activeConfigSha256 !== startup.activeConfigSha256
        || current.workerProcessInstanceId !== startup.workerProcessInstanceId
        || current.ledgerEpoch !== startup.ledgerEpoch
        || current.vivadoToolchainAttestationSha256
          !== startup.vivadoToolchainAttestationSha256
        || current.toolchainProfileHash !== startup.toolchainProfileHash
      ) {
        throw new Error("certification identity changed after startup");
      }
      return current;
    } catch (error) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_CERTIFICATION_INVALID",
        error instanceof Error ? error.message : "evolution-eval certification invalid",
        false,
      );
    }
  }

  private assertCertifiedDiscovery(
    discovery: RemoteDiscovery,
    certification: EvolutionEvalCertifiedRemoteIdentity,
  ): void {
    this.assertEvolutionEvalProtocol(discovery);
    if (
      discovery.sdk_worker_build_hash !== certification.sdkWorkerBuildHash
      || discovery.active_config_sha256 !== certification.activeConfigSha256
      || discovery.worker_process_instance_id !== certification.workerProcessInstanceId
      || discovery.vivado_toolchain_attestation_sha256
        !== certification.vivadoToolchainAttestationSha256
      || discovery.toolchain_profile_hash !== certification.toolchainProfileHash
      || discovery.live_mapping_health !== "healthy"
    ) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_CERTIFICATION_INVALID",
        "remote build, config, process instance, or toolchain attestation differs from certification",
        false,
      );
    }
  }

  private assertEvolutionEvalProtocol(discovery: RemoteDiscovery): void {
    if (discovery.connector_protocol_version !== "connector.remote.v1") {
      throw new ConnectorError(
        "COMPATIBILITY_REJECTED",
        "remote evolution-eval protocol is incompatible",
        false,
      );
    }
  }

  private async assertCurrentCertifiedDiscovery(
    client: RemoteClientLike,
    certification: EvolutionEvalCertifiedRemoteIdentity,
  ): Promise<void> {
    const discovery = await client.discover();
    if (client.hasCapabilityDrift) {
      throw new ConnectorError(
        "CAPABILITY_DRIFT",
        "evolution-eval connector capability drift detected before a new effect",
        false,
      );
    }
    this.assertCertifiedDiscovery(discovery, certification);
  }

  private assertCertifiedLedgerEpoch(observation: EvalLedgerQuery): EvalLedgerQuery {
    const expected = this.certifiedEvolutionEvalIdentity?.ledgerEpoch;
    if (expected !== undefined && observation.ledger_epoch !== expected) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH",
        "remote ledger epoch differs from certification",
        false,
      );
    }
    return observation;
  }

  async discover(projectId: string): Promise<ConnectorDiscovery> {
    return this.withClient(projectId, async (client) => {
      const d = await client.discover();
      if (client.hasCapabilityDrift) {
        throw new ConnectorError("CAPABILITY_DRIFT", "capability drift detected during discover", false);
      }
      return {
        capabilities: d.capabilities,
        drift: false,
        toolchainProfileHash: d.toolchain_profile_hash,
      };
    });
  }

  async submitJob(params: SubmitJobParams): Promise<ConnectorJobSnapshot> {
    return this.withClient(params.projectId, async (client) => {
      const request: RemoteJobRequest = {
        jobId: params.jobId,
        idempotencyKey: params.idempotencyKey,
        projectId: params.projectId,
        operation: params.operation,
        runClass: params.runClass,
        input: params.inputHash,
        correlationId: params.correlationId,
        parameters: buildRemoteParameters(params),
      };
      const job = await client.submit(request, buildRemoteApproval(params));
      return { jobId: job.id, state: job.state, outputSha256: job.outputSha256, errorCode: job.errorCode };
    });
  }

  async queryStatus(projectId: string, jobId: string): Promise<ConnectorJobSnapshot> {
    return this.withClient(projectId, async (client) => {
      const job = await client.status(jobId);
      return { jobId: job.id, state: job.state, outputSha256: job.outputSha256, errorCode: job.errorCode };
    });
  }

  async fetchEvidence(projectId: string, jobId: string): Promise<EvidenceManifest> {
    return this.withClient(projectId, async (client) => {
      const manifest = await client.evidence(jobId);
      return { jobId: manifest.jobId, entries: manifest.entries };
    });
  }

  async fetchEvidenceContent(
    projectId: string,
    jobId: string,
    name: string,
    options?: EvidenceContentOptions,
  ): Promise<EvidenceContent> {
    return this.withClient(projectId, async (client) => {
      const c = await client.fetchEvidenceContent(jobId, name, {
        complete: options?.requireFull === true,
      });
      return {
        name,
        content: c.content,
        ...(c.bytes ? { bytes: c.bytes } : {}),
        sha256: c.sha256,
        truncated: c.truncated,
        mediaType: c.mediaType,
      };
    });
  }

  async preflight(binding: CoreIssuedEvalBinding): Promise<EvalPreflight> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      const certification = await this.requireCurrentEvolutionEvalCertification();
      if (!certification) {
        throw new ConnectorError(
          "EVOLUTION_EVAL_CERTIFICATION_INVALID",
          "new-effect preflight requires a current certification",
          false,
        );
      }
      await this.assertCurrentCertifiedDiscovery(client, certification);
      const result = await client.evolutionEvalPreflight(binding);
      if (
        result.schema !== "evolution-eval-preflight-result.v1"
        || result.operation !== binding.dispatch.operation
        || typeof result.eligible !== "boolean"
        || typeof result.license_available !== "boolean"
        || (result.capability_version !== null && typeof result.capability_version !== "string")
        || !Number.isSafeInteger(result.unacked_spool_bytes)
        || result.unacked_spool_bytes < 0
        || result.hard_cap_bytes !== EVOLUTION_EVAL_LIMITS.connectorUnackedSpoolBytes
        || (result.error_code !== null && typeof result.error_code !== "string")
        || result.active_config_sha256 !== certification.activeConfigSha256
        || result.worker_process_instance_id !== certification.workerProcessInstanceId
        || result.vivado_toolchain_attestation_sha256
          !== certification.vivadoToolchainAttestationSha256
        || result.live_mapping_health !== "healthy"
      ) {
        throw new ConnectorError(
          "COMPATIBILITY_REJECTED",
          "evolution-eval preflight response is not bound to the Core request",
          false,
        );
      }
      return {
        eligible: result.eligible,
        operation: binding.dispatch.operation,
        capability_version: result.capability_version,
        license_available: result.license_available,
        unacked_spool_bytes: result.unacked_spool_bytes,
        hard_cap_bytes: 2_147_483_648,
        error_code: result.error_code,
      };
    });
  }

  async query(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      return validateEvolutionEvalLedgerObservation(
        binding,
        await client.evolutionEvalQuery(binding),
      );
    });
  }

  async queryOrReserve(binding: CoreIssuedEvalBinding): Promise<EvalLedgerQuery> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      const certification = await this.requireCurrentEvolutionEvalCertification();
      if (!certification) {
        throw new ConnectorError(
          "EVOLUTION_EVAL_CERTIFICATION_INVALID",
          "new-effect reservation requires a current certification",
          false,
        );
      }
      await this.assertCurrentCertifiedDiscovery(client, certification);
      const attestation = {
        active_config_sha256: certification.activeConfigSha256,
        worker_process_instance_id: certification.workerProcessInstanceId,
        vivado_toolchain_attestation_sha256:
          certification.vivadoToolchainAttestationSha256,
      };
      return this.assertCertifiedLedgerEpoch(validateEvolutionEvalLedgerObservation(
        binding,
        await client.evolutionEvalReserve(binding, attestation),
      ));
    });
  }

  async submit(
    binding: CoreIssuedEvalBinding,
    input: SealedEvalInput,
  ): Promise<EvalLedgerQuery> {
    // Encode before acquiring/refreshing the remote client lease. A maximum
    // workspace can take time to buffer, while the actual RPC must start from
    // a freshly validated project/actor context.
    const transportInput = await encodeEvolutionEvalSealedInput(input);
    const projectionHash = canonicalEvolutionEvalSealedInputProjection(
      transportInput.manifest,
    ).sha256;
    if (projectionHash !== binding.dispatch.sealed_input_projection_hash) {
      throw new ConnectorError(
        "EVOLUTION_EVAL_BINDING_CONFLICT",
        "sealed Connector projection differs from the Core dispatch binding",
        false,
      );
    }
    return this.withEvolutionEvalClient(binding, async (client) => {
      const certification = await this.requireCurrentEvolutionEvalCertification();
      if (!certification) {
        throw new ConnectorError(
          "EVOLUTION_EVAL_CERTIFICATION_INVALID",
          "new-effect submission requires a current certification",
          false,
        );
      }
      await this.assertCurrentCertifiedDiscovery(client, certification);
      const attestation = {
        active_config_sha256: certification.activeConfigSha256,
        worker_process_instance_id: certification.workerProcessInstanceId,
        vivado_toolchain_attestation_sha256:
          certification.vivadoToolchainAttestationSha256,
      };
      return this.assertCertifiedLedgerEpoch(validateEvolutionEvalLedgerObservation(
        binding,
        await client.evolutionEvalSubmit(binding, transportInput, attestation),
      ));
    });
  }

  async cancel(
    binding: CoreIssuedEvalBinding,
    reason: EvalCancelReason,
  ): Promise<EvalLedgerQuery> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      return validateEvolutionEvalLedgerObservation(
        binding,
        await client.evolutionEvalCancel(binding, reason),
      );
    });
  }

  async querySpool(
    binding: CoreIssuedEvalBinding,
  ): Promise<{
    readonly schema: "evolution-eval-spool-result.v1";
    readonly binding: CoreIssuedEvalBinding;
    readonly unackedBytes: number;
    readonly hardCapBytes: 2_147_483_648;
  }> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      const result = await client.evolutionEvalQuerySpool(binding);
      if (
        result.schema !== "evolution-eval-spool-result.v1"
        || !isExactEvolutionEvalBinding(result.binding, binding)
        || !Number.isSafeInteger(result.unacked_bytes)
        || result.unacked_bytes < 0
        || result.hard_cap_bytes !== EVOLUTION_EVAL_LIMITS.connectorUnackedSpoolBytes
      ) {
        throw new ConnectorError(
          "COMPATIBILITY_REJECTED",
          "evolution-eval spool response is invalid",
          false,
        );
      }
      return {
        schema: "evolution-eval-spool-result.v1",
        binding: structuredClone(binding),
        unackedBytes: result.unacked_bytes,
        hardCapBytes: 2_147_483_648,
      };
    });
  }

  async fetchEvidenceManifest(
    binding: CoreIssuedEvalBinding,
  ): Promise<EvalEvidenceConnectorManifestV1> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      return client.evolutionEvalEvidenceManifest(binding);
    });
  }

  async fetchEvidenceEntry(
    binding: CoreIssuedEvalBinding,
    name: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      return client.evolutionEvalEvidenceEntryStream(binding, name);
    });
  }

  async queryRetention(binding: CoreIssuedEvalBinding): Promise<EvalRetentionResult> {
    return this.withEvolutionEvalClient(binding, async (client) => {
      return await client.evolutionEvalQueryRetention(binding) as EvalRetentionResult;
    });
  }

  async acknowledgeEvidence(
    request: EvalEvidenceAckRequestV1,
  ): Promise<EvalRetentionResult> {
    return this.withEvolutionEvalClient(request.binding, async (client) => {
      return await client.evolutionEvalAcknowledgeEvidence(request) as EvalRetentionResult;
    });
  }

  async acknowledgeCorrupt(
    request: EvalEvidenceCorruptAckRequestV1,
  ): Promise<EvalRetentionResult> {
    return this.withEvolutionEvalClient(request.binding, async (client) => {
      return await client.evolutionEvalAcknowledgeCorrupt(request) as EvalRetentionResult;
    });
  }

  async cleanupEvidence(
    request: EvalEvidenceCleanupRequestV1,
  ): Promise<EvalRetentionResult> {
    return this.withEvolutionEvalClient(request.binding, async (client) => {
      return await client.evolutionEvalCleanupEvidence(request) as EvalRetentionResult;
    });
  }
}

// ─── env-driven bootstrap ────────────────────────────────────────────────────

export interface ConnectorEnvOptions {
  /** Path to the Connector endpoint config JSON. Default: env SYNTHIA_CONNECTOR_CONFIG or `connector/worker-66.config.json`. */
  configPath?: string;
  /** Env source. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override the endpoint_url (always the production tunnel in real deployments). */
  endpointUrl?: string;
  /** Frozen startup identity plus a per-effect raw-B/freshness reloader. */
  evolutionEvalCertification?: {
    readonly identity: EvolutionEvalCertifiedRemoteIdentity;
    readonly current: EvolutionEvalCertificationProvider;
  };
}

/**
 * Build a production {@link ConnectorPort} from environment, or return undefined
 * when the ordinary Cloudflare Connector is not configured. The isolated M4-F
 * 18443 mode is deliberately stricter: an incomplete authorization or TLS
 * binding throws so a dispatcher host cannot silently fall back to 8443.
 */
export async function createConnectorFromEnv(
  opts: ConnectorEnvOptions = {},
): Promise<RemoteConnectorAdapter | undefined> {
  const env = opts.env ?? process.env;
  const endpointUrl = opts.endpointUrl ?? PRODUCTION_ENDPOINT_URL;
  const directM4fMtls = endpointUrl === M4F_DIRECT_MTLS_ENDPOINT_URL;
  if (!directM4fMtls && env.SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION !== undefined) {
    throw new Error("direct M4-F mTLS mode cannot target a non-18443 endpoint");
  }
  const directMaterial = directM4fMtls ? loadM4fDirectMtlsMaterial(env) : null;

  const configPath = opts.configPath ?? env.SYNTHIA_CONNECTOR_CONFIG ?? "connector/worker-66.config.json";

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return undefined;
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (directM4fMtls) {
    if (config.tls_trust_ref !== M4F_DIRECT_MTLS_TRUST_REF
      || config.tls_client_cert_ref !== M4F_DIRECT_MTLS_CLIENT_REF) {
      throw new Error("direct M4-F Connector config has unexpected TLS references");
    }
    config = { ...config, endpoint_url: endpointUrl };
  } else if (config.transport_mode === "direct_https" && config.auth_mode === "mtls") {
    // Direct mTLS deployments (for example Core on a workstation reaching the
    // Worker over Tailscale) opt in via transport_mode "direct_https": keep the
    // on-disk endpoint origin and let the factory load the client/server
    // certificate material from the config paths.
    const httpModule = (await import("../../../connector/http.ts")) as unknown as {
      createMtlsDirectRemoteConnector: RemoteFactory;
    };
    const directEndpoint = String(config.endpoint_url ?? "");
    if (!directEndpoint) return undefined;
    return new RemoteConnectorAdapter(httpModule.createMtlsDirectRemoteConnector, config, [new URL(directEndpoint).hostname], env);
  } else {
    // Cloudflare-tunnel deployments require the Access service-token credentials.
    const cfId = env.SYNTHIA_CF_ACCESS_CLIENT_ID;
    const cfSecret = env.SYNTHIA_CF_ACCESS_CLIENT_SECRET;
    if (!cfId || !cfSecret) return undefined;

    // Override the endpoint origin to the public tunnel; allowlist must include it.
    // The tunnel terminates TLS at Cloudflare Access, so the mTLS material in the
    // on-disk (LAN) config does not apply: point the TLS refs at the Cloudflare
    // secret references the environment factory resolves into Access credentials.
    config = {
      ...config,
      endpoint_url: endpointUrl,
      tls_trust_ref: "secret://trust/cloudflare-edge",
      tls_client_cert_ref: "secret://cert/cloudflare-origin",
    };
  }
  const allowlist = [new URL(endpointUrl).hostname];

  // Dynamic import: the Connector package lives outside Core's compilation unit
  // (core/tsconfig.json includes only src/**/*.ts) and connector/index.ts already
  // imports from ../core/src/*, so a static import would pull all of connector/
  // (vivado.ts, worker.ts) into Core's type-check graph and create a core↔connector
  // dependency cycle. Loading it lazily here keeps Core self-contained and lets the
  // test path skip the Connector module entirely (fake is injected instead).
  const connectorHttpModulePath: string = "../../../connector/http.ts";
  const httpModule = (await import(connectorHttpModulePath)) as unknown as {
    createEnvironmentCloudflareRemoteConnector: RemoteFactory;
    createDirectMtlsRemoteConnector: DirectMtlsRemoteFactory;
  };
  const factory: RemoteFactory = directMaterial === null
    ? httpModule.createEnvironmentCloudflareRemoteConnector
    : (options) => httpModule.createDirectMtlsRemoteConnector({
        ...options,
        ca: directMaterial.ca,
        cert: directMaterial.cert,
        key: directMaterial.key,
      });
  return new RemoteConnectorAdapter(
    factory,
    config,
    allowlist,
    env,
    opts.evolutionEvalCertification,
  );
}
