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
  ArtifactRevisionState,
  ArtifactType,
  GateId,
  GateSubmissionState,
} from "../core/src/domain/enums.ts";
import type {
  ArtifactRevisionSummary,
  ArtifactSummary,
  GateSubmissionSummary,
  GovernanceClient,
  ProjectEventSummary,
  ProjectInfo,
  RegisteredRevision,
} from "./types.ts";

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
    version: number;
  }): Promise<RegisteredRevision> {
    const contentHash = sha256Hex(input.content);
    const body = {
      id: `rev_${randomUUID()}`,
      version: input.version,
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

  // ----- read-only queries (project status snapshot) -----

  async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    const data = await this.request("GET", `/api/v1/projects/${projectId}`) as {
      id: string;
      name: string;
      scope: string;
      status: string;
      data_classification: string;
      standard_version: string;
      target_part: string;
      process_instances?: readonly {
        id: string;
        current_gate: string;
        gate_profile_version: string;
      }[];
    };
    return {
      id: data.id,
      name: data.name,
      status: data.status,
      scope: data.scope,
      dataClassification: data.data_classification,
      targetPart: data.target_part,
      standardVersion: data.standard_version,
      processInstances: (data.process_instances ?? []).map((pi) => ({
        id: pi.id,
        currentGate: pi.current_gate,
        gateProfileVersion: pi.gate_profile_version,
      })),
    };
  }

  async listGateSubmissions(
    projectId: string,
    state?: GateSubmissionState,
  ): Promise<readonly GateSubmissionSummary[]> {
    const query = state ? `?state=${encodeURIComponent(state)}` : "";
    const rows = await this.request(
      "GET",
      `/api/v1/projects/${projectId}/gate-submissions${query}`,
    ) as readonly {
      id: string;
      gate: GateId;
      state: GateSubmissionState;
      snapshot_id: string;
      process_instance_id: string;
      submitted_at: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      gate: r.gate,
      state: r.state,
      snapshotId: r.snapshot_id,
      processInstanceId: r.process_instance_id,
      submittedAt: r.submitted_at,
      createdAt: r.created_at,
    }));
  }

  async listArtifacts(projectId: string): Promise<readonly ArtifactSummary[]> {
    const rows = await this.request(
      "GET",
      `/api/v1/projects/${projectId}/artifacts`,
    ) as readonly { id: string; artifact_type: ArtifactType; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      artifactType: r.artifact_type,
      createdAt: r.created_at,
    }));
  }

  async listRevisions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly ArtifactRevisionSummary[]> {
    const rows = await this.request(
      "GET",
      `/api/v1/projects/${projectId}/artifacts/${artifactId}/revisions`,
    ) as readonly {
      id: string;
      version: number;
      state: ArtifactRevisionState;
      content_hash: string;
      content_location: string;
      title: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      state: r.state,
      contentHash: r.content_hash,
      contentLocation: r.content_location,
      title: r.title,
      createdAt: r.created_at,
    }));
  }

  async listEvents(
    projectId: string,
    limit?: number,
  ): Promise<readonly ProjectEventSummary[]> {
    const rows = await this.request(
      "GET",
      `/api/v1/projects/${projectId}/events`,
    ) as readonly {
      event_id: string;
      aggregate_type: string;
      aggregate_id: string;
      sequence: number;
      event_type: string;
      occurred_at: string;
    }[];
    const mapped = rows.map((r) => ({
      eventId: r.event_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      sequence: r.sequence,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
    }));
    // Core exposes no LIMIT param; bound client-side, most recent occurred_at first.
    mapped.sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.sequence - a.sequence,
    );
    return limit && limit > 0 ? mapped.slice(0, limit) : mapped;
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
  /** Highest version registered per artifactId (monotonicity guard). */
  private artifactVersions = new Map<string, number>();

  async registerCandidateArtifact(input: {
    artifactId: string;
    artifactType: ArtifactType;
    title: string;
    content: string;
    contentLocation: string;
    version: number;
  }): Promise<RegisteredRevision> {
    const prev = this.artifactVersions.get(input.artifactId) ?? 0;
    if (input.version <= prev) {
      throw new GovernanceError(
        `RESOURCE_CONFLICT: artifact ${input.artifactId} is at version ${prev}, got ${input.version} (must be > ${prev})`,
        "RESOURCE_CONFLICT", 409, false,
      );
    }
    this.artifactVersions.set(input.artifactId, input.version);
    const contentHash = sha256Hex(input.content);
    const revisionId = this.nextId("rev");
    const result: RegisteredRevision = {
      revisionId,
      artifactId: input.artifactId,
      version: input.version,
      contentHash,
    };
    this.registeredArtifacts.push({
      artifactId: input.artifactId,
      artifactType: input.artifactType,
      title: input.title,
      contentHash,
      contentLocation: input.contentLocation,
      revisionId,
      version: input.version,
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

  // ----- read-only queries (derived from recorded state) -----

  async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    const piIds = new Set(this.submissions.map((s) => s.processInstanceId));
    return {
      id: projectId,
      name: projectId,
      status: "active",
      scope: "",
      dataClassification: "D1",
      targetPart: "",
      standardVersion: "",
      processInstances: [...piIds].map((id) => ({ id, currentGate: "", gateProfileVersion: "" })),
    };
  }

  async listGateSubmissions(): Promise<readonly GateSubmissionSummary[]> {
    return this.submissions.map((s) => {
      const submitted = this.submittedGates.includes(s.submissionId);
      const state: GateSubmissionState =
        this.gateStates.get(s.submissionId) ?? (submitted ? "in_review" : "preparing");
      return {
        id: s.submissionId,
        gate: s.gate,
        state,
        snapshotId: s.snapshotId,
        processInstanceId: s.processInstanceId,
        submittedAt: null,
        createdAt: "",
      };
    });
  }

  async listArtifacts(): Promise<readonly ArtifactSummary[]> {
    const seen = new Map<string, ArtifactType>();
    for (const a of this.registeredArtifacts) seen.set(a.artifactId, a.artifactType);
    return [...seen.entries()].map(([id, artifactType]) => ({ id, artifactType, createdAt: "" }));
  }

  async listRevisions(_projectId: string, artifactId: string): Promise<readonly ArtifactRevisionSummary[]> {
    return this.registeredArtifacts
      .filter((a) => a.artifactId === artifactId)
      .sort((a, b) => b.version - a.version)
      .map((a) => ({
        id: a.revisionId,
        version: a.version,
        state: "candidate" as ArtifactRevisionState,
        contentHash: a.contentHash,
        contentLocation: a.contentLocation,
        title: a.title,
        createdAt: "",
      }));
  }

  async listEvents(): Promise<readonly ProjectEventSummary[]> {
    return [];
  }
}
