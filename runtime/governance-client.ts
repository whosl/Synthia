/**
 * Synthia Runtime — Core API governance client.
 *
 * Implements {@link GovernanceClient} against the Synthia Core REST API. The
 * runtime calls this to register candidate ArtifactRevisions, create
 * ConfigurationSnapshots, and manage gate submissions (create → submit → poll)
 * as it advances through the GJB stage chain (G1–G4).
 *
 * Endpoints (all under /api/v1/projects/:projectId):
 *   POST /artifacts/:artifactId/revisions       → 201 {id, version, state}
 *   POST /snapshots                             → 201 {id, manifestHash}
 *   POST /gate-submissions                      → 201 {id, state}
 *   POST /gate-submissions/:subId/submit        → 200 {state}
 *   GET  /gate-submissions/:subId               → 200 {state}
 *
 * Idempotency: every POST sends an Idempotency-Key (reused from runIdempotent).
 * Responses are unwrapped from the unified envelope ({data} on success,
 * {error:{code,...}} on failure). Transient 5xx / network errors are retried
 * once; non-retryable 4xx surface immediately.
 *
 * Credentials (SYNTHIA_CORE_TOKEN) are read from env via the CLI and passed in;
 * they are never logged.
 */

import { randomUUID } from "node:crypto";
import { sha256Hex } from "../core/src/hashing.ts";
import type {
  ArtifactType,
  GateId,
  GateSubmissionState,
} from "../core/src/domain/enums.ts";
import type { GovernanceClient, RegisteredRevision } from "./types.ts";

export interface CoreGovernanceConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly processInstanceId: string;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
}

interface EnvelopeError {
  readonly error: { readonly code: string; readonly message: string; readonly retryable?: boolean };
}

function unwrapError(json: unknown): EnvelopeError["error"] | null {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as { error: unknown }).error;
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      return err as EnvelopeError["error"];
    }
  }
  return null;
}

export class GovernanceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

export class CoreGovernanceClient implements GovernanceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly processInstanceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(config: CoreGovernanceConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.projectId = config.projectId;
    this.processInstanceId = config.processInstanceId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.retryDelayMs = config.retryDelayMs ?? 500;
  }

  async registerCandidateArtifact(input: {
    artifactId: string;
    artifactType: ArtifactType;
    title: string;
    content: string;
    contentLocation: string;
    changeReason?: string;
  }): Promise<RegisteredRevision> {
    const contentHash = sha256Hex(input.content);
    const body = {
      id: `rev_${randomUUID()}`,
      version: 1,
      content_hash: contentHash,
      content: input.content,
      artifact_type: input.artifactType,
      title: input.title,
      ...(input.changeReason ? { change_reason: input.changeReason } : {}),
    };
    const data = await this.request(
      "POST",
      `/api/v1/projects/${this.projectId}/artifacts/${input.artifactId}/revisions`,
      body,
      `regart-${input.artifactId}-${contentHash.slice(0, 16)}`,
    ) as { id: string; version: number; artifact_id?: string; content_hash?: string };
    return {
      revisionId: data.id,
      artifactId: input.artifactId,
      version: data.version,
      contentHash,
    };
  }

  async createSnapshot(input: {
    memberRevisionIds: readonly string[];
    toolModelPolicyHash: string;
  }): Promise<{ snapshotId: string }> {
    const snapshotId = `snap_${randomUUID()}`;
    const body = {
      id: snapshotId,
      member_revision_ids: [...input.memberRevisionIds],
      tool_model_policy_hash: input.toolModelPolicyHash,
    };
    const data = await this.request(
      "POST",
      `/api/v1/projects/${this.projectId}/snapshots`,
      body,
      `snap-${snapshotId}`,
    ) as { id: string };
    return { snapshotId: data.id };
  }

  async createGateSubmission(input: {
    processInstanceId: string;
    gate: GateId;
    snapshotId: string;
  }): Promise<{ submissionId: string }> {
    const submissionId = `sub_${randomUUID()}`;
    const body = {
      id: submissionId,
      process_instance_id: input.processInstanceId,
      gate: input.gate,
      snapshot_id: input.snapshotId,
    };
    const data = await this.request(
      "POST",
      `/api/v1/projects/${this.projectId}/gate-submissions`,
      body,
      `sub-${submissionId}`,
    ) as { id: string };
    return { submissionId: data.id };
  }

  async submitGate(submissionId: string): Promise<{ state: GateSubmissionState }> {
    const data = await this.request(
      "POST",
      `/api/v1/projects/${this.projectId}/gate-submissions/${submissionId}/submit`,
      {},
      `submit-${submissionId}`,
    ) as { state: GateSubmissionState };
    return { state: data.state };
  }

  async getGateSubmissionState(submissionId: string): Promise<{ state: GateSubmissionState }> {
    const data = await this.request(
      "GET",
      `/api/v1/projects/${this.projectId}/gate-submissions/${submissionId}`,
    ) as { state: GateSubmissionState };
    return { state: data.state };
  }

  // ----- internals -----

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const init = this.buildInit(method, body, idempotencyKey);
        const res = await this.fetchImpl(url, init);
        const text = await res.text();
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }

        if (res.status >= 200 && res.status < 300) {
          return (json as { data?: unknown } | undefined)?.data;
        }

        const err = unwrapError(json);
        const code = err?.code ?? `http_${res.status}`;
        const message = err?.message ?? `HTTP ${res.status}`;
        const retryable = err?.retryable ?? (res.status >= 500 && res.status <= 599);

        if (retryable && attempt === 0) {
          await this.sleep(this.retryDelayMs);
          continue;
        }
        throw new GovernanceError(message, code, res.status, false);
      } catch (e) {
        if (e instanceof GovernanceError) throw e;
        // Network-level failure: retry once, then surface.
        if (attempt === 0) {
          await this.sleep(this.retryDelayMs);
          continue;
        }
        throw new GovernanceError(
          e instanceof Error ? e.message : String(e),
          "network_error",
          0,
          false,
        );
      }
    }
    throw new GovernanceError("request failed after retry", "request_failed", 0, false);
  }

  private buildInit(method: "GET" | "POST", body: unknown, idempotencyKey?: string): RequestInit {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }
    return { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  }

  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }
}

/**
 * In-memory governance client for tests: records every call and returns
 * deterministic ids so tests can assert artifact registration, snapshot, and
 * gate submission without a real Core.
 */
export class MockGovernanceClient implements GovernanceClient {
  readonly registeredArtifacts: Array<{
    artifactId: string;
    artifactType: ArtifactType;
    title: string;
    contentHash: string;
    contentLocation: string;
    revisionId: string;
    version: number;
  }> = [];
  readonly snapshots: Array<{ snapshotId: string; memberRevisionIds: readonly string[]; toolModelPolicyHash: string }> = [];
  readonly submissions: Array<{ submissionId: string; processInstanceId: string; gate: GateId; snapshotId: string }> = [];
  readonly submittedGates: string[] = [];
  readonly polledGates: string[] = [];
  private counter = 0;
  /** Gate state map; tests pre-set the poll result per submissionId. */
  gateStates = new Map<string, GateSubmissionState>();
  private submitResultState: GateSubmissionState = "in_review";

  private nextId(prefix: string): string {
    return `${prefix}-mock-${++this.counter}`;
  }

  setSubmitResult(state: GateSubmissionState): void {
    this.submitResultState = state;
  }

  setGateState(submissionId: string, state: GateSubmissionState): void {
    this.gateStates.set(submissionId, state);
  }

  async registerCandidateArtifact(input: {
    artifactId: string;
    artifactType: ArtifactType;
    title: string;
    content: string;
    contentLocation: string;
  }): Promise<RegisteredRevision> {
    const contentHash = sha256Hex(input.content);
    const revisionId = this.nextId("rev");
    const result: RegisteredRevision = {
      revisionId,
      artifactId: input.artifactId,
      version: 1,
      contentHash,
    };
    this.registeredArtifacts.push({
      artifactId: input.artifactId,
      artifactType: input.artifactType,
      title: input.title,
      contentHash,
      contentLocation: input.contentLocation,
      revisionId,
      version: 1,
    });
    return result;
  }

  async createSnapshot(input: {
    memberRevisionIds: readonly string[];
    toolModelPolicyHash: string;
  }): Promise<{ snapshotId: string }> {
    const snapshotId = this.nextId("snap");
    this.snapshots.push({ snapshotId, memberRevisionIds: [...input.memberRevisionIds], toolModelPolicyHash: input.toolModelPolicyHash });
    return { snapshotId };
  }

  async createGateSubmission(input: {
    processInstanceId: string;
    gate: GateId;
    snapshotId: string;
  }): Promise<{ submissionId: string }> {
    const submissionId = this.nextId("sub");
    this.submissions.push({ submissionId, processInstanceId: input.processInstanceId, gate: input.gate, snapshotId: input.snapshotId });
    return { submissionId };
  }

  async submitGate(submissionId: string): Promise<{ state: GateSubmissionState }> {
    this.submittedGates.push(submissionId);
    return { state: this.submitResultState };
  }

  async getGateSubmissionState(submissionId: string): Promise<{ state: GateSubmissionState }> {
    this.polledGates.push(submissionId);
    const state = this.gateStates.get(submissionId) ?? "approved";
    return { state };
  }
}
