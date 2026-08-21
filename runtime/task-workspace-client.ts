/**
 * Runtime client for a Core-owned isolated task workspace.
 *
 * The client is deliberately narrower than GovernanceClient: it can only read
 * and write the workspace bound to one Core-issued task id. It has no project
 * workspace, artifact, snapshot, gate, milestone, adoption, or approval API.
 */

import type { ArtifactType } from "../core/src/domain/enums.ts";
import { sha256Hex } from "../core/src/hashing.ts";

export type RuntimeTaskKind = "main" | "side";

export interface TaskAuthorizationScope {
  readonly schema: "task-scope.v1";
  readonly workspace: "project" | "isolated";
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly run_classes: readonly string[];
  readonly allowed_tools?: readonly string[];
  readonly can_submit_gates: boolean;
  readonly can_create_milestones: boolean;
  readonly can_start_formal_runs: boolean;
}

export interface TaskWorkspaceFile {
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  readonly commit: string | null;
}

export interface TaskWorkspaceTreeEntry {
  readonly path: string;
  readonly contentHash: string | null;
  readonly bytes: number | null;
}

export interface TaskWorkspaceWrittenFile {
  readonly path: string;
  readonly contentHash: string;
}

export interface TaskWorkspaceWriteResult {
  readonly commit: string;
  readonly committed: readonly string[];
  readonly registered: readonly TaskWorkspaceWrittenFile[];
  readonly unchanged: readonly TaskWorkspaceWrittenFile[];
  readonly isolated: true;
}

export type TaskConversationEventKind =
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "status";

export interface TaskConversationEventResult {
  readonly taskId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly replayed: boolean;
}

export interface TaskFinalizedResult {
  readonly resultId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly summary: string;
  readonly outputHash: string;
}

/** Core-owned append-only conversation facts shared by main and side tasks. */
export interface TaskConversationClient {
  readonly projectId: string;
  readonly taskId: string;
  appendEvent(input: {
    readonly eventId: string;
    readonly type: TaskConversationEventKind;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<TaskConversationEventResult>;
}

export interface TaskWorkspaceClient extends TaskConversationClient {
  readonly workspaceId: string;
  listTree(): Promise<readonly TaskWorkspaceTreeEntry[]>;
  readFile(path: string): Promise<TaskWorkspaceFile>;
  writeFiles(input: {
    readonly files: readonly { readonly path: string; readonly content: string }[];
    readonly changeReason?: string;
    readonly artifactType?: ArtifactType;
  }): Promise<TaskWorkspaceWriteResult>;
  finalizeResult(input: {
    readonly summary: string;
    readonly tests?: readonly unknown[];
  }): Promise<TaskFinalizedResult>;
}

export interface CoreTaskConversationClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CoreTaskWorkspaceClientOptions extends CoreTaskConversationClientOptions {
  readonly workspaceId: string;
  readonly authorization: TaskAuthorizationScope;
}

export class TaskWorkspaceClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TaskWorkspaceClientError";
  }
}

interface EnvelopeError {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryable?: boolean;
  };
}

/** Shared Core API transport pinned to one Core-issued task identity. */
class CoreTaskClientBase implements TaskConversationClient {
  readonly projectId: string;
  readonly taskId: string;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly workspaceHeader?: string;

  constructor(options: CoreTaskConversationClientOptions, workspaceHeader?: string) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.projectId = requireIdentifier("projectId", options.projectId);
    this.taskId = requireIdentifier("taskId", options.taskId);
    this.workspaceHeader = workspaceHeader;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleeper = options.sleep ?? defaultSleep;
  }

  async appendEvent(input: {
    readonly eventId: string;
    readonly type: TaskConversationEventKind;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<TaskConversationEventResult> {
    const eventId = requireIdentifier("eventId", input.eventId);
    const fingerprint = sha256Hex(JSON.stringify({
      eventId,
      type: input.type,
      payload: input.payload,
    }));
    const data = asRecord(await this.request(
      "POST",
      "events",
      { event_id: eventId, type: input.type, payload: input.payload },
      `task-event-${this.taskId}-${fingerprint.slice(0, 32)}`,
    ));
    if (
      data.task_id !== this.taskId ||
      data.event_id !== eventId ||
      typeof data.sequence !== "number" ||
      typeof data.replayed !== "boolean"
    ) {
      throw shapeError("task event response is invalid");
    }
    return {
      taskId: data.task_id,
      eventId: data.event_id,
      sequence: data.sequence,
      replayed: data.replayed,
    };
  }

  protected async request(
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const path = `/api/v1/projects/${this.projectId}/tasks/${this.taskId}/${suffix}`;
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.token}`,
          "X-Synthia-Task-Id": this.taskId,
          ...(this.workspaceHeader ? { "X-Synthia-Workspace-Id": this.workspaceHeader } : {}),
        };
        if (method === "POST") {
          headers["Content-Type"] = "application/json";
          if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
        }
        const response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        if (response.ok) return asRecord(json).data;
        const error = asRecord(json) as EnvelopeError;
        const retryable = error.error?.retryable ?? response.status >= 500;
        if (retryable && attempt === 0) {
          await this.sleeper(this.retryDelayMs);
          continue;
        }
        throw new TaskWorkspaceClientError(
          error.error?.message ?? `HTTP ${response.status}`,
          error.error?.code ?? `http_${response.status}`,
          response.status,
          retryable,
        );
      } catch (error) {
        if (error instanceof TaskWorkspaceClientError) throw error;
        if (attempt === 0) {
          await this.sleeper(this.retryDelayMs);
          continue;
        }
        throw new TaskWorkspaceClientError(
          error instanceof Error ? error.message : String(error),
          "network_error",
          0,
          true,
        );
      }
    }
    throw new TaskWorkspaceClientError("request failed", "request_failed", 0, true);
  }
}

/** Event-only callback client used by a Core-owned main task. */
export class CoreTaskConversationClient extends CoreTaskClientBase {
  constructor(options: CoreTaskConversationClientOptions) {
    super(options);
  }
}

/** Core API implementation pinned to one task-scoped workspace. */
export class CoreTaskWorkspaceClient extends CoreTaskClientBase implements TaskWorkspaceClient {
  readonly workspaceId: string;

  private readonly authorization: TaskAuthorizationScope;

  constructor(options: CoreTaskWorkspaceClientOptions) {
    const workspaceId = requireIdentifier("workspaceId", options.workspaceId);
    super(options, workspaceId);
    this.workspaceId = workspaceId;
    this.authorization = options.authorization;
  }

  async listTree(): Promise<readonly TaskWorkspaceTreeEntry[]> {
    const data = asRecord(await this.request("GET", "workspace/tree"));
    this.assertOwnership(data);
    const rows = Array.isArray(data.files) ? data.files : [];
    return rows.map((raw, index) => {
      const row = asRecord(raw);
      if (!row || typeof row.path !== "string") {
        throw shapeError(`workspace tree row ${index} is invalid`);
      }
      const path = normalizeWorkspacePath(row.path);
      return {
        path,
        contentHash: typeof row.content_hash === "string" ? row.content_hash : null,
        bytes: typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) ? row.bytes : null,
      };
    });
  }

  async readFile(inputPath: string): Promise<TaskWorkspaceFile> {
    const path = normalizeWorkspacePath(inputPath);
    this.assertAuthorized(path, this.authorization.read_paths, "read");
    const data = asRecord(await this.request(
      "GET",
      `workspace/file?path=${encodeURIComponent(path)}`,
    ));
    if (
      typeof data.path !== "string" ||
      typeof data.content !== "string" ||
      typeof data.content_hash !== "string"
    ) {
      throw shapeError("workspace file response is invalid");
    }
    const returnedPath = normalizeWorkspacePath(data.path);
    if (returnedPath !== path) {
      throw shapeError(`Core returned ${returnedPath} while ${path} was requested`);
    }
    if (sha256Hex(data.content) !== data.content_hash) {
      throw shapeError(`Core returned a content hash mismatch for ${path}`);
    }
    return {
      path,
      content: data.content,
      contentHash: data.content_hash,
      commit: typeof data.commit === "string" ? data.commit : null,
    };
  }

  async writeFiles(input: {
    readonly files: readonly { readonly path: string; readonly content: string }[];
    readonly changeReason?: string;
    readonly artifactType?: ArtifactType;
  }): Promise<TaskWorkspaceWriteResult> {
    if (input.files.length === 0) {
      throw new TaskWorkspaceClientError("files must not be empty", "bad_request", 400, false);
    }
    const seen = new Set<string>();
    const files = input.files.map((file) => {
      const path = normalizeWorkspacePath(file.path);
      this.assertAuthorized(path, this.authorization.write_paths, "write");
      if (seen.has(path)) {
        throw new TaskWorkspaceClientError(`duplicate workspace path: ${path}`, "bad_request", 400, false);
      }
      seen.add(path);
      return { path, content: file.content };
    });
    const requestBody = {
      files,
      ...(input.changeReason ? { change_reason: input.changeReason } : {}),
      ...(input.artifactType ? { artifact_type: input.artifactType } : {}),
    };
    // The idempotency key must identify the exact normalized request sent to
    // Core. Hashing file bytes alone aliases requests whose audit reason,
    // artifact type, or file ordering differs; Core correctly rejects that as
    // an idempotency conflict because the request bodies are not the same.
    const fingerprint = sha256Hex(JSON.stringify(requestBody));
    const data = asRecord(await this.request(
      "POST",
      "workspace/files",
      requestBody,
      `task-ws-${this.taskId}-${fingerprint.slice(0, 32)}`,
    ));
    if (typeof data.commit !== "string" || data.isolated !== true) {
      throw shapeError("workspace write response is not an isolated commit");
    }
    return {
      commit: data.commit,
      committed: stringArray(data.committed),
      registered: writtenRows(data.registered),
      unchanged: writtenRows(data.unchanged),
      isolated: true,
    };
  }

  async finalizeResult(input: {
    readonly summary: string;
    readonly tests?: readonly unknown[];
  }): Promise<TaskFinalizedResult> {
    const summary = input.summary.trim();
    const tests = input.tests ?? [];
    const fingerprint = sha256Hex(JSON.stringify({ summary, tests }));
    const data = asRecord(await this.request(
      "POST",
      "result",
      { summary, tests },
      `task-result-${this.taskId}-${fingerprint.slice(0, 32)}`,
    ));
    if (
      typeof data.result_id !== "string" ||
      data.task_id !== this.taskId ||
      data.workspace_id !== this.workspaceId ||
      typeof data.summary !== "string" ||
      typeof data.output_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.output_hash)
    ) {
      throw shapeError("task result response is invalid");
    }
    return {
      resultId: data.result_id,
      taskId: data.task_id,
      workspaceId: data.workspace_id,
      summary: data.summary,
      outputHash: data.output_hash,
    };
  }

  private assertOwnership(data: Record<string, unknown>): void {
    if (typeof data.project_id === "string" && data.project_id !== this.projectId) {
      throw shapeError("Core returned another project's task workspace");
    }
    if (typeof data.task_id === "string" && data.task_id !== this.taskId) {
      throw shapeError("Core returned another task's workspace");
    }
    if (typeof data.workspace_id === "string" && data.workspace_id !== this.workspaceId) {
      throw shapeError("Core returned a different workspace id");
    }
  }

  private assertAuthorized(path: string, patterns: readonly string[], access: "read" | "write"): void {
    if (!patterns.some((pattern) => matchesPath(pattern, path))) {
      throw new TaskWorkspaceClientError(
        `${access} path is outside the Core-issued task scope: ${path}`,
        "SIDE_TASK_PATH_NOT_AUTHORIZED",
        403,
        false,
      );
    }
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function writtenRows(value: unknown): TaskWorkspaceWrittenFile[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const row = asRecord(raw);
    if (typeof row.path !== "string" || typeof row.content_hash !== "string") {
      throw shapeError(`workspace write row ${index} is invalid`);
    }
    return { path: normalizeWorkspacePath(row.path), contentHash: row.content_hash };
  });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (!value.every((item) => typeof item === "string")) {
    throw shapeError("workspace committed paths are invalid");
  }
  return value.map(normalizeWorkspacePath);
}

function requireIdentifier(name: string, value: string): string {
  if (
    value.length === 0 ||
    value.length > 160 ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new TaskWorkspaceClientError(`${name} is invalid`, "bad_request", 400, false);
  }
  return value;
}

export function normalizeWorkspacePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new TaskWorkspaceClientError(`invalid workspace path: ${value}`, "bad_request", 400, false);
  }
  const path = value.startsWith("./") ? value.slice(2) : value;
  const parts = path.split("/");
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new TaskWorkspaceClientError(`invalid workspace path: ${value}`, "bad_request", 400, false);
  }
  return path;
}

function matchesPath(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -2);
    return path.startsWith(prefix) && path.length > prefix.length;
  }
  return normalizedPattern === path;
}

function shapeError(message: string): TaskWorkspaceClientError {
  return new TaskWorkspaceClientError(message, "TASK_WORKSPACE_SHAPE_INVALID", 502, false);
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
