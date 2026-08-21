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
 *   POST /workspace/files                       → 200 {commit, registered[], …}
 *   GET  /workspace/file?path=                  → 200 {path, content, content_hash, registered, …}
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
  ImportedMaterialSummary,
  ProjectEventSummary,
  ProjectInfo,
  RegisteredRevision,
  WorkspaceFileContent,
  WorkspaceRegisteredFile,
  WorkspaceWriteResult,
} from "./types.ts";

export interface CoreGovernanceConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly processInstanceId?: string;
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

type HttpMethod = "GET" | "POST" | "PUT";

interface WorkspaceFileRow {
  readonly path: string;
  readonly artifact_id: string;
  readonly revision_id: string;
  readonly version: number;
  readonly content_hash: string;
}

function narrowWorkspaceRow(r: WorkspaceFileRow): WorkspaceRegisteredFile {
  return {
    path: r.path,
    artifactId: r.artifact_id,
    revisionId: r.revision_id,
    version: r.version,
    contentHash: r.content_hash,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(row: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function optionalStringField(row: Record<string, unknown> | null, ...keys: readonly string[]): string | undefined {
  if (!row) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function nullableStringField(row: Record<string, unknown> | null, ...keys: readonly string[]): string | null {
  if (!row) return null;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value.trim() === "" ? null : value;
    if (value === null) return null;
  }
  return null;
}

/**
 * Read a nullable Core field without collapsing an omitted property into null.
 * That distinction is part of the project-process contract: free projects must
 * return all four process fields explicitly as null, while engineering projects
 * must return all four as non-empty strings.
 */
function optionalNullableStringField(
  row: Record<string, unknown> | null,
  ...keys: readonly string[]
): string | null | undefined {
  if (!row) return undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (value === null || typeof value === "string") return value;
    // Preserve a present-but-invalid value as a non-null string. The Runtime
    // validator will then reject both free and engineering shapes instead of
    // treating the malformed property as absent or null.
    return "";
  }
  return undefined;
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function arrayField(row: Record<string, unknown>, ...keys: readonly string[]): readonly unknown[] {
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function recordRows(value: readonly unknown[]): Record<string, unknown>[] | null {
  const rows: Record<string, unknown>[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function importedMaterialRows(data: unknown): Record<string, unknown>[] | null {
  const root = asRecord(data);
  if (!root) return null;
  const items = root["items"];
  const results = root["results"];
  const query = root["query"];
  const total = root["total"];
  if (!Array.isArray(items) || !Array.isArray(results) || typeof query !== "string") return null;
  if (!Number.isSafeInteger(total) || (total as number) < items.length) return null;
  // Core intentionally exposes both names to one canonical file-level array.
  // Reject conflicting duplicates instead of choosing whichever is convenient.
  if (JSON.stringify(items) !== JSON.stringify(results)) return null;
  return recordRows(items);
}

const IMPORT_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMPORT_SOURCE_KINDS = new Set(["project", "local_directory", "zip"]);

function validImportIdentifier(value: string, maxLength = 128): boolean {
  return value.length > 0 && value.length <= maxLength && IMPORT_IDENTIFIER_PATTERN.test(value);
}

function validImportPath(path: string): boolean {
  if (path.length === 0 || new TextEncoder().encode(path).length > 512) return false;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  if (parts.length === 0 || parts.length > 32) return false;
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  return !parts.some((part) => [...part].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f"));
}

function searchableImportPath(path: string): boolean {
  if (!validImportPath(path)) return false;
  const normalized = path.toLowerCase();
  if (normalized === "sim" || normalized.startsWith("sim/")) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (base === ".env" || base.startsWith(".env.")) return false;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts)$/.test(base)) return false;
  if (/(?:secret|credential|password|private[_-]?key|access[_-]?token)/.test(base)) return false;
  return !/\.(?:key|pem|crt|cer|der|p12|pfx|jks|keystore|kdb|kdbx)$/.test(base);
}

function mapImportedMaterial(
  row: Record<string, unknown>,
): ImportedMaterialSummary | null {
  const projectId = row["project_id"];
  const snapshotId = row["snapshot_id"];
  const fileId = row["file_id"];
  const path = row["path"];
  const content = row["content"];
  const contentHash = row["content_hash"];
  const sourceHash = row["source_hash"];
  const sourceKind = row["source_kind"];
  const sourceProjectId = row["source_project_id"];
  const sourceName = row["source_name"];
  const expiresAt = row["expires_at"];
  if (typeof projectId !== "string" || !validImportIdentifier(projectId)) return null;
  if (typeof snapshotId !== "string" || !validImportIdentifier(snapshotId)) return null;
  // File ids append a server-generated suffix to a valid 128-byte snapshot id.
  if (typeof fileId !== "string" || !validImportIdentifier(fileId, 256)) return null;
  if (typeof path !== "string" || !searchableImportPath(path)) return null;
  if (typeof content !== "string" || new TextEncoder().encode(content).length > 1024 * 1024) return null;
  if (typeof contentHash !== "string" || !SHA256_PATTERN.test(contentHash)) return null;
  if (sha256Hex(content) !== contentHash) return null;
  if (typeof sourceHash !== "string" || !SHA256_PATTERN.test(sourceHash)) return null;
  if (typeof sourceKind !== "string" || !IMPORT_SOURCE_KINDS.has(sourceKind)) return null;
  if (sourceProjectId !== null && (typeof sourceProjectId !== "string" || !validImportIdentifier(sourceProjectId))) return null;
  if (sourceKind === "project" ? typeof sourceProjectId !== "string" : sourceProjectId !== null) return null;
  if (typeof sourceName !== "string" || sourceName.trim().length === 0) return null;
  if (new TextEncoder().encode(sourceName).length > 256 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(sourceName)) return null;
  if (expiresAt !== null && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) return null;
  if (row["status"] !== "confirmed" || row["valid"] !== true || row["searchable"] !== true) return null;

  return {
    snapshotId,
    fileId,
    // Do not infer ownership from the URL.  P2 search items must carry an
    // explicit project_id; missing/null values are rejected below rather than
    // being silently pinned to the requested project.
    projectId,
    path,
    contentHash,
    content,
    sourceKind,
    sourceName,
    sourceProjectId,
    sourceHash,
    status: "confirmed",
    valid: true,
    searchable: true,
    expiresAt,
  };
}

export class CoreGovernanceClient implements GovernanceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly processInstanceId: string | undefined;
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
      // 不传这个字段是老的真 bug：Core 会退化成 `db://artifact_revision/<id>`，于是
      // 前端拿不到任何路径线索，只能去反解标题里的 `技能名: rtl/pwm.v`。
      content_location: input.contentLocation,
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

  // ----- workspace (real disk + git; Core is the only writer) -----

  async writeWorkspaceFiles(input: {
    files: readonly { path: string; content: string }[];
    changeReason?: string;
    artifactType?: ArtifactType;
  }): Promise<WorkspaceWriteResult> {
    const body = {
      files: input.files.map((f) => ({ path: f.path, content: f.content })),
      ...(input.changeReason ? { change_reason: input.changeReason } : {}),
      ...(input.artifactType ? { artifact_type: input.artifactType } : {}),
    };
    // 幂等键由「路径 + 内容」决定：同一批字节重发是同一次写入，内容一变就是新的一次。
    const fingerprint = sha256Hex(
      input.files.map((f) => `${f.path}\0${sha256Hex(f.content)}`).sort().join("\n"),
    );
    const data = await this.request(
      "POST",
      `/api/v1/projects/${this.projectId}/workspace/files`,
      body,
      `wsfiles-${fingerprint.slice(0, 32)}`,
    ) as {
      commit: string;
      registered: readonly WorkspaceFileRow[];
      unchanged?: readonly WorkspaceFileRow[];
    };
    return {
      commit: data.commit,
      registered: (data.registered ?? []).map(narrowWorkspaceRow),
      unchanged: (data.unchanged ?? []).map(narrowWorkspaceRow),
    };
  }

  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    const data = await this.request(
      "GET",
      `/api/v1/projects/${this.projectId}/workspace/file?path=${encodeURIComponent(path)}`,
    ) as {
      path: string;
      content: string;
      content_hash: string;
      registered?: boolean;
      revision_id?: string | null;
      version?: number | null;
      commit?: string | null;
    };
    return {
      path: data.path,
      content: data.content,
      contentHash: data.content_hash,
      registered: data.registered === true,
      revisionId: data.revision_id ?? null,
      version: data.version ?? null,
      commit: data.commit ?? null,
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
    const data = asRecord(await this.request("GET", `/api/v1/projects/${projectId}`)) ?? {};
    const returnedId = optionalStringField(data, "id");
    if (returnedId !== undefined && returnedId !== projectId) {
      throw new GovernanceError(
        `Core returned project ${returnedId} while ${projectId} was requested`,
        "PROJECT_OWNERSHIP_MISMATCH",
        502,
        false,
      );
    }
    const processProfile = asRecord(data["process_profile"] ?? data["processProfile"]);
    const projectType = optionalStringField(data, "project_type", "projectType");
    const processVersionId = firstDefined(
      optionalNullableStringField(data, "process_version_id", "processVersionId"),
      optionalNullableStringField(processProfile, "process_version_id", "processVersionId"),
    );
    const processProfileId = firstDefined(
      optionalNullableStringField(data, "process_profile_id", "processProfileId"),
      optionalNullableStringField(processProfile, "id", "profile_id", "profileId"),
    );
    const processProfileName = firstDefined(
      optionalNullableStringField(data, "process_profile_name", "processProfileName"),
      optionalNullableStringField(processProfile, "name"),
    );
    const processProfileVersion = firstDefined(
      optionalNullableStringField(data, "process_profile_version", "processProfileVersion"),
      optionalNullableStringField(processProfile, "version"),
    );
    return {
      id: stringField(data, "id"),
      name: stringField(data, "name"),
      status: stringField(data, "status"),
      scope: stringField(data, "scope"),
      dataClassification: stringField(data, "data_classification", "dataClassification"),
      targetPart: nullableStringField(data, "target_part", "targetPart"),
      standardVersion: stringField(data, "standard_version", "standardVersion"),
      ...(projectType ? { projectType } : {}),
      ...(processVersionId !== undefined ? { processVersionId } : {}),
      ...(processProfileId !== undefined ? { processProfileId } : {}),
      ...(processProfileName !== undefined ? { processProfileName } : {}),
      ...(processProfileVersion !== undefined ? { processProfileVersion } : {}),
      processInstances: arrayField(data, "process_instances", "processInstances").map((row) => {
        const pi = asRecord(row) ?? {};
        return {
          id: stringField(pi, "id"),
          currentGate: stringField(pi, "current_gate", "currentGate"),
          gateProfileVersion: stringField(pi, "gate_profile_version", "gateProfileVersion"),
        };
      }),
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

  /**
   * Query Core's project-scoped default historical-material index.  Core's
   * endpoint enforces confirmed+valid search semantics; `include_content=true`
   * is intentional because the result is used as a bounded prompt context,
   * not merely as a catalogue.  Runtime applies a second state/ownership/
   * expiry filter before rendering any bytes.
   */
  async searchImportedMaterials(
    projectId: string,
    query: { readonly q?: string; readonly limit?: number } = {},
  ): Promise<readonly ImportedMaterialSummary[]> {
    if (projectId !== this.projectId) {
      throw new GovernanceError(
        `governance client for ${this.projectId} cannot query historical material for ${projectId}`,
        "PROJECT_OWNERSHIP_MISMATCH",
        403,
        false,
      );
    }
    const params = new URLSearchParams();
    if (query.q?.trim()) params.set("q", query.q.trim());
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit <= 0) {
        throw new GovernanceError("historical material limit must be a positive integer", "validation", 400, false);
      }
      params.set("limit", String(query.limit));
    }
    params.set("include_content", "true");
    const suffix = params.toString();
    const data = await this.request(
      "GET",
      `/api/v1/projects/${projectId}/import-snapshots/search${suffix ? `?${suffix}` : ""}`,
    );
    const rawRows = importedMaterialRows(data);
    if (!rawRows) {
      throw new GovernanceError(
        "Core returned an invalid historical-material search envelope",
        "HISTORICAL_MATERIAL_SHAPE_INVALID",
        502,
        false,
      );
    }
    const rows: ImportedMaterialSummary[] = [];
    for (const rawRow of rawRows) {
      const row = mapImportedMaterial(rawRow);
      if (!row) {
        throw new GovernanceError(
          "Core returned a malformed historical-material row",
          "HISTORICAL_MATERIAL_SHAPE_INVALID",
          502,
          false,
        );
      }
      rows.push(row);
    }
    const mismatch = rows.find((row) => row.projectId !== projectId);
    if (mismatch) {
      throw new GovernanceError(
        `Core returned historical material for ${mismatch.projectId} while ${projectId} was requested`,
        "PROJECT_OWNERSHIP_MISMATCH",
        502,
        false,
      );
    }
    return query.limit === undefined ? rows : rows.slice(0, query.limit);
  }

  // ----- internals -----

  private async request(
    method: HttpMethod,
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

  private buildInit(method: HttpMethod, body: unknown, idempotencyKey?: string): RequestInit {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (method !== "GET") {
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
  /** Seedable P2 rows returned by the default historical-material search. */
  importedMaterials: ImportedMaterialSummary[] = [];
  readonly importedMaterialQueries: Array<{
    projectId: string;
    query?: { readonly q?: string; readonly limit?: number };
  }> = [];
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

  // ----- in-memory workspace (mirrors Core's disk + git behaviour) -----

  /** path → current bytes, plus what the last **registered** write left behind.
   *  `registeredHash === null` means "on disk but never registered" (untracked). */
  private readonly workspace = new Map<
    string,
    { content: string; registeredHash: string | null; revisionId: string | null; commit: string | null }
  >();

  /** Seed a file as if a human had edited it: present on disk, not registered. */
  seedWorkspaceFile(path: string, content: string): void {
    const prev = this.workspace.get(path);
    this.workspace.set(path, {
      content,
      registeredHash: prev?.registeredHash ?? null,
      revisionId: prev?.revisionId ?? null,
      commit: prev?.commit ?? null,
    });
  }

  /** Current workspace contents, for assertions. */
  workspaceSnapshot(): Map<string, string> {
    return new Map([...this.workspace].map(([path, f]) => [path, f.content]));
  }

  async writeWorkspaceFiles(input: {
    files: readonly { path: string; content: string }[];
    changeReason?: string;
    artifactType?: ArtifactType;
  }): Promise<WorkspaceWriteResult> {
    // 与 Core 的 `writeAndCommit` 同一条红线：目标文件带着未登记的人工改动就整批拒绝。
    const conflicts = input.files
      .filter((f) => {
        const cur = this.workspace.get(f.path);
        if (!cur || cur.content === f.content) return false;
        return cur.registeredHash !== sha256Hex(cur.content);
      })
      .map((f) => f.path);
    if (conflicts.length > 0) {
      throw new GovernanceError(
        `这些文件有未登记的人工改动，拒绝覆盖：${conflicts.join("、")}`,
        "WORKSPACE_FILE_DIRTY", 409, false,
      );
    }

    // 不消耗 `counter`：revisionId 的编号是测试断言的对象，不该被这里的取值扰动。
    const commit = sha256Hex(
      input.files.map((f) => `${f.path} ${sha256Hex(f.content)}`).sort().join("\n"),
    ).slice(0, 40);

    const registered: WorkspaceRegisteredFile[] = [];
    const unchanged: WorkspaceRegisteredFile[] = [];
    for (const file of input.files) {
      const contentHash = sha256Hex(file.content);
      const artifactId = `ws-${file.path}`.replace(/[^A-Za-z0-9._-]/g, "-");
      const prev = this.workspace.get(file.path);
      if (prev?.registeredHash === contentHash) {
        const prior = [...this.registeredArtifacts].reverse().find((a) => a.artifactId === artifactId);
        this.workspace.set(file.path, { ...prev, content: file.content });
        unchanged.push({
          path: file.path,
          artifactId,
          revisionId: prior?.revisionId ?? "",
          version: prior?.version ?? 0,
          contentHash,
        });
        continue;
      }
      const version = (this.artifactVersions.get(artifactId) ?? 0) + 1;
      this.artifactVersions.set(artifactId, version);
      const revisionId = this.nextId("rev");
      this.workspace.set(file.path, { content: file.content, registeredHash: contentHash, revisionId, commit });
      this.registeredArtifacts.push({
        artifactId,
        artifactType: input.artifactType ?? ("DETAILED_DESIGN" as ArtifactType),
        title: file.path,
        contentHash,
        contentLocation: file.path,
        revisionId,
        version,
      });
      registered.push({ path: file.path, artifactId, revisionId, version, contentHash });
    }
    return { commit, registered, unchanged };
  }

  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    const file = this.workspace.get(path);
    if (!file) {
      throw new GovernanceError(`工作区没有这个文件：${path}`, "WORKSPACE_FILE_NOT_FOUND", 404, false);
    }
    const contentHash = sha256Hex(file.content);
    const registered = file.registeredHash === contentHash;
    const artifactId = `ws-${path}`.replace(/[^A-Za-z0-9._-]/g, "-");
    const prior = registered
      ? [...this.registeredArtifacts].reverse().find((a) => a.artifactId === artifactId)
      : undefined;
    return {
      path,
      content: file.content,
      contentHash,
      registered,
      revisionId: registered ? file.revisionId : null,
      version: prior?.version ?? null,
      commit: registered ? file.commit : null,
    };
  }

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
      projectType: "engineering",
      processVersionId: "GJB_REF_V1",
      processProfileId: "GJB_REF_V1",
      processProfileName: "GJB reference flow",
      processProfileVersion: "GJB_REF_V1",
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

  async searchImportedMaterials(
    projectId: string,
    query?: { readonly q?: string; readonly limit?: number },
  ): Promise<readonly ImportedMaterialSummary[]> {
    this.importedMaterialQueries.push({ projectId, ...(query ? { query } : {}) });
    const q = query?.q?.trim().toLocaleLowerCase();
    const filtered = q
      ? this.importedMaterials.filter((row) =>
          (row.path + " " + (row.sourceName ?? "")).toLocaleLowerCase().includes(q),
        )
      : this.importedMaterials;
    return query?.limit && query.limit > 0 ? filtered.slice(0, query.limit) : [...filtered];
  }
}
