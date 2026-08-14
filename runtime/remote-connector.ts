/**
 * Synthia Runtime — Cloudflare remote connector adapter.
 *
 * Adapts the frozen `RemoteConnectorClient` (connector.remote.v1 over the
 * Cloudflare tunnel to worker 66) to the loop-facing {@link LoopConnector}.
 *
 * Lease handling:
 *  The RemoteConnectorClient stores `this.lease` after the first heartbeat.
 *  Once it expires, the `state` getter permanently returns "offline" because
 *  register() does NOT clear the lease — heartbeat() refuses to run. The ONLY
 *  recovery is to create a fresh client instance (whose `lease` starts
 *  undefined). Therefore this adapter:
 *   1. Proactively heartbeats before each capability call to keep the lease
 *      alive across long LLM generation gaps.
 *   2. On LEASE_EXPIRED (proactive heartbeat or submit), creates a fresh client
 *      via `clientFactory`, runs register→heartbeat→discover, re-checks drift,
 *      and retries the call exactly once.
 *   3. After reconnect, if drift is detected → fail-closed (no submit).
 */

import { RemoteConnectorError, type RemoteConnectorClient } from "../connector/remote.ts";
import { sha256Hex, stableId } from "../core/src/hashing.ts";
import { FailClosedError, VIVADO_CAPABILITY_VERSION, submissionSha } from "./loop.ts";
import type { ConnectorCapability, EvidenceContent, EvidenceManifest, LoopConnector, VivadoResult, VivadoSubmission } from "./types.ts";

export interface ConnectorLifecycleEvent {
  readonly action: string;
  readonly detail?: string;
  readonly result: "ok" | "fail_closed";
}

export interface RemoteVivadoOptions {
  /** Factory that creates a FRESH RemoteConnectorClient (clears lease state). */
  readonly clientFactory: () => RemoteConnectorClient;
  readonly connectorId: string;
  readonly projectId: string;
  readonly pollIntervalMs?: number;
  readonly maxPollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onLifecycle?: (event: ConnectorLifecycleEvent) => void;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_POLL_MS = 30 * 60 * 1000;
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded", "failed", "cancelled", "timeout", "lost", "unknown_effect",
]);

export class RemoteVivadoConnector implements LoopConnector {
  readonly id: string;
  private client: RemoteConnectorClient;
  private readonly clientFactory: () => RemoteConnectorClient;
  private readonly projectId: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly onLifecycle?: (event: ConnectorLifecycleEvent) => void;
  readonly lifecycleEvents: ConnectorLifecycleEvent[] = [];
  private primed = false;

  constructor(opts: RemoteVivadoOptions) {
    this.id = opts.connectorId;
    this.clientFactory = opts.clientFactory;
    this.client = opts.clientFactory();
    this.projectId = opts.projectId;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.maxPollMs = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    this.clock = opts.now ?? Date.now;
    this.sleeper = opts.sleep ?? defaultSleep;
    this.onLifecycle = opts.onLifecycle;
  }

  get drift(): boolean { return this.client.hasCapabilityDrift; }

  async discover(): Promise<readonly ConnectorCapability[]> {
    try {
      await this.ensureReady();
      return (await this.client.discover()).capabilities;
    } catch (e) {
      if (isLeaseExpired(e)) {
        await this.reconnect("lease expired during discover");
        return (await this.client.discover()).capabilities;
      }
      throw e;
    }
  }

  async submit(submission: VivadoSubmission): Promise<VivadoResult> {
    await this.ensureReady();
    try {
      return await this.doSubmit(submission);
    } catch (e) {
      if (isLeaseExpired(e)) {
        await this.reconnect("lease expired during submit");
        return await this.doSubmit(submission);
      }
      throw e;
    }
  }

  async fetchEvidenceContent(jobId: string, name: string): Promise<EvidenceContent> {
    await this.ensureReady();
    try {
      return await this.doFetchEvidenceContent(jobId, name);
    } catch (e) {
      if (isLeaseExpired(e)) {
        await this.reconnect("lease expired during fetchEvidenceContent");
        return await this.doFetchEvidenceContent(jobId, name);
      }
      throw e;
    }
  }

  // ----- internals -----

  private async doSubmit(submission: VivadoSubmission): Promise<VivadoResult> {
    const jobId = stableId(`job-${submission.operation}`);
    const parameters = buildParameters(submission, jobId, this.projectId);
    const input = submissionSha(submission);
    const request = {
      jobId,
      idempotencyKey: jobId,
      projectId: this.projectId,
      operation: submission.operation,
      runClass: "exploratory" as const,
      input,
      correlationId: stableId("corr"),
      parameters,
    };
    const started = await this.client.submit(request);
    const job = await this.pollTerminal(started.id);
    let evidence: EvidenceManifest | undefined;
    try { evidence = await this.client.evidence(job.id); } catch { /* evidence may be absent on failure */ }
    return {
      status: jobStateToResultStatus(job.state),
      jobId: job.id,
      operation: submission.operation,
      inputSha256: input,
      errorCode: job.errorCode,
      evidence,
    };
  }

  private async doFetchEvidenceContent(jobId: string, name: string): Promise<EvidenceContent> {
    const c = await this.client.fetchEvidenceContent(jobId, name);
    return {
      content: c.content,
      sha256: c.sha256,
      truncated: c.truncated,
      mediaType: c.mediaType,
    };
  }

  /**
   * Ensure the connector is ready before each operation. Proactively heartbeats
   * to refresh the lease. If the heartbeat itself sees an expired lease, falls
   * through to a full reconnect via a fresh client instance.
   */
  private async ensureReady(): Promise<void> {
    if (!this.primed) {
      // Use the constructor-created client for initial priming (its lease is
      // undefined, so register → heartbeat → discover works normally).
      await this.client.register();
      await this.client.heartbeat();
      await this.client.discover();
      if (this.client.hasCapabilityDrift) {
        this.emitLifecycle("drift_check", "fail_closed", "drift detected during initial priming");
        throw new FailClosedError("capability drift detected during initial priming", "CAPABILITY_DRIFT");
      }
      this.emitLifecycle("drift_check", "ok", "initial priming complete");
      this.primed = true;
      return;
    }
    try {
      await this.client.heartbeat();
      this.emitLifecycle("heartbeat", "ok");
    } catch (e) {
      if (isLeaseExpired(e)) {
        await this.reconnect("lease expired during proactive heartbeat");
      } else {
        throw e;
      }
    }
  }

  /**
   * Full lifecycle re-establishment via a FRESH client: factory() → register →
   * heartbeat → discover → drift check. A fresh client is required because the
   * frozen RemoteConnectorClient never clears its internal `lease` field — once
   * expired, the state getter permanently returns "offline" on the old instance.
   * After discover, if capability drift is detected, fail-closed immediately.
   */
  private async reconnect(reason: string): Promise<void> {
    this.emitLifecycle("reconnect", "ok", reason);
    this.client = this.clientFactory();
    await this.client.register();
    await this.client.heartbeat();
    await this.client.discover();
    if (this.client.hasCapabilityDrift) {
      this.emitLifecycle("drift_check", "fail_closed", "capability drift detected after reconnect");
      throw new FailClosedError("capability drift detected after reconnect", "CAPABILITY_DRIFT");
    }
    this.emitLifecycle("drift_check", "ok", "no drift after reconnect");
  }

  private emitLifecycle(action: string, result: ConnectorLifecycleEvent["result"], detail?: string): void {
    const event: ConnectorLifecycleEvent = { action, result, ...(detail ? { detail } : {}) };
    this.lifecycleEvents.push(event);
    this.onLifecycle?.(event);
  }

  private async pollTerminal(jobId: string): Promise<{ id: string; state: string; errorCode?: string }> {
    const deadline = this.clock() + this.maxPollMs;
    let last: { id: string; state: string; errorCode?: string } = { id: jobId, state: "queued" };
    while (this.clock() < deadline) {
      const job = await this.client.status(jobId);
      last = { id: job.id, state: job.state, errorCode: job.errorCode };
      if (TERMINAL_STATES.has(job.state)) return last;
      await this.sleeper(this.pollIntervalMs);
    }
    return { ...last, state: "timeout" };
  }
}

function isLeaseExpired(e: unknown): e is RemoteConnectorError {
  return e instanceof RemoteConnectorError && e.code === "LEASE_EXPIRED";
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function jobStateToResultStatus(state: string): VivadoResult["status"] {
  switch (state) {
    case "succeeded": return "succeeded";
    case "timeout": return "timeout";
    case "lost": return "lost";
    case "unknown_effect": return "unknown_effect";
    default: return "failed";
  }
}

function buildParameters(submission: VivadoSubmission, jobId: string, projectId: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    jobId, projectId, runClass: "exploratory",
    operation: submission.operation,
    sources: submission.sources.map(toSourceInput),
    top: submission.top, part: submission.part,
    capabilityVersion: VIVADO_CAPABILITY_VERSION,
  };
  if (submission.operation === "simulate" && submission.testbench) base.testbench = submission.testbench;
  if (submission.operation === "implement" && submission.constraints?.length) base.constraints = submission.constraints.map(toSourceInput);
  return base;
}

function toSourceInput(f: { path: string; content: string; mediaType?: string }) {
  return { path: f.path, content: f.content, ...(f.mediaType ? { mediaType: f.mediaType } : {}) };
}

export function manifestDigest(submission: VivadoSubmission): string {
  return sha256Hex(JSON.stringify(buildParameters(submission, "manifest", submission.projectId)));
}
