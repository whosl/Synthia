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

import { readFileSync } from "node:fs";
import type { RunClass, ToolRunState } from "../domain/enums.ts";
import {
  ConnectorError,
  type ConnectorDiscovery,
  type ConnectorJobSnapshot,
  type ConnectorPort,
  type EvidenceManifest,
  type SubmitJobParams,
} from "./connector-port.ts";

/** Fixed production tunnel endpoint — the public Cloudflare origin for worker 66. */
const PRODUCTION_ENDPOINT_URL = "https://connect.wenzhuolin.xyz";

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

interface RemoteCapability {
  operation: string;
  version: string;
  runClasses: readonly string[];
}

interface RemoteDiscovery {
  capabilities: readonly RemoteCapability[];
  toolchain_profile_hash?: string;
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
    sources: p.sources,
  };
  if (p.top !== undefined) base.top = p.top;
  if (p.part !== undefined) base.part = p.part;
  if (p.testbench !== undefined) base.testbench = p.testbench;
  if (p.constraints.length > 0) base.constraints = p.constraints;
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
export class RemoteConnectorAdapter implements ConnectorPort {
  private readonly clients = new Map<string, RemoteClientLike>();
  private readonly primed = new Set<string>();
  private readonly factory: RemoteFactory;
  private readonly endpointConfig: Record<string, unknown>;
  private readonly allowlist: readonly string[];
  private readonly env: Record<string, string | undefined>;

  constructor(
    factory: RemoteFactory,
    endpointConfig: Record<string, unknown>,
    allowlist: readonly string[],
    env: Record<string, string | undefined>,
  ) {
    this.factory = factory;
    this.endpointConfig = endpointConfig;
    this.allowlist = allowlist;
    this.env = env;
  }

  get connectorId(): string {
    return String(this.endpointConfig.connector_id ?? "remote-connector");
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
      if (isLeaseExpiredError(err)) {
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
   * Run `action` against a ready client. If the action throws LEASE_EXPIRED,
   * evict the stale client, rebuild (register → heartbeat → discover → drift),
   * and retry the action exactly once. Drift and all other errors propagate.
   */
  private async withClient<T>(projectId: string, action: (client: RemoteClientLike) => Promise<T>): Promise<T> {
    const client = await this.ensureReady(projectId);
    try {
      return await action(client);
    } catch (err) {
      if (!isLeaseExpiredError(err)) throw toConnectorError(err);
      // Lease expired mid-call — rebuild and retry once.
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

  async discover(projectId: string): Promise<ConnectorDiscovery> {
    return this.withClient(projectId, async (client) => {
      const d = await client.discover();
      if (client.hasCapabilityDrift) {
        throw new ConnectorError("CAPABILITY_DRIFT", "capability drift detected during discover", false);
      }
      return { capabilities: d.capabilities, drift: false };
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
        input: `manifest:${params.jobId}`,
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
}

// ─── env-driven bootstrap ────────────────────────────────────────────────────

export interface ConnectorEnvOptions {
  /** Path to the Connector endpoint config JSON. Default: env SYNTHIA_CONNECTOR_CONFIG or `connector/worker-66.config.json`. */
  configPath?: string;
  /** Env source. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override the endpoint_url (always the production tunnel in real deployments). */
  endpointUrl?: string;
}

/**
 * Build a production {@link ConnectorPort} from environment, or return undefined
 * when the Connector cannot be configured (no CF Access credentials). Returns
 * undefined — never throws — so a misconfigured server still boots and surfaces
 * 503 on Job endpoints rather than failing to start.
 */
export async function createConnectorFromEnv(opts: ConnectorEnvOptions = {}): Promise<ConnectorPort | undefined> {
  const env = opts.env ?? process.env;
  const cfId = env.SYNTHIA_CF_ACCESS_CLIENT_ID;
  const cfSecret = env.SYNTHIA_CF_ACCESS_CLIENT_SECRET;
  if (!cfId || !cfSecret) return undefined;

  const configPath = opts.configPath ?? env.SYNTHIA_CONNECTOR_CONFIG ?? "connector/worker-66.config.json";
  const endpointUrl = opts.endpointUrl ?? PRODUCTION_ENDPOINT_URL;

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
  const allowlist = [new URL(endpointUrl).hostname];

  // Dynamic import: the Connector package lives outside Core's compilation unit
  // (core/tsconfig.json includes only src/**/*.ts) and connector/index.ts already
  // imports from ../core/src/*, so a static import would pull all of connector/
  // (vivado.ts, worker.ts) into Core's type-check graph and create a core↔connector
  // dependency cycle. Loading it lazily here keeps Core self-contained and lets the
  // test path skip the Connector module entirely (fake is injected instead).
  const httpModule = (await import("../../../connector/http.ts")) as unknown as {
    createEnvironmentCloudflareRemoteConnector: RemoteFactory;
  };
  return new RemoteConnectorAdapter(httpModule.createEnvironmentCloudflareRemoteConnector, config, allowlist, env);
}
