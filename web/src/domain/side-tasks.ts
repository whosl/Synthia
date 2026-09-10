import { ApiError, NetworkError } from "../api/client.ts";
import type {
  AdoptSideTaskRequest,
  CreateSideTaskRequest,
  SideTaskAdoptionResult,
  SideTaskAdoptionState,
  SideTaskAuthorizationScope,
  SideTaskConversationEvent,
  SideTaskConversationEventKind,
  SideTaskConversationPage,
  SideTaskDiff,
  SideTaskDiffFile,
  SideTaskResult,
  SideTaskResultFile,
  SideTaskStatus,
  SideTaskSummary,
  SideTaskTestResult,
  SideTaskWorkspaceState,
} from "../api/types.ts";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_WRITE_PATHS = 32;
const MAX_WRITE_PATH_BYTES = 512;
const MAX_WRITE_PATH_SEGMENTS = 32;
const MAX_OBJECTIVE_CHARS = 2_000;
const MAX_REASON_CHARS = 1_000;
const MAX_DIFF_CHARS = 2 * 1024 * 1024;
const WORKSPACE_TOP_LEVEL_DIRS = new Set(["rtl", "tb", "doc", "prj"]);
const HDL_EXTENSION_RE = /\.(?:v|sv|vh|svh|vhd|vhdl)$/i;
const PLATFORM_PATH_PREFIX_RE = /^(?:[A-Za-z]:|\/cygdrive\/|\/[a-zA-Z]\/)/;
export const SIDE_TASK_READ_PATHS = ["rtl/**", "tb/**", "doc/**", "prj/constr/**"] as const;
const SIDE_TASK_READ_PATH_SET = new Set<string>(SIDE_TASK_READ_PATHS);
export const SIDE_TASK_AUTHORIZATION_KEYS = new Set([
  "schema",
  "workspace",
  "read_paths",
  "write_paths",
  "run_classes",
  "can_submit_gates",
  "can_create_milestones",
  "can_start_formal_runs",
]);

const SIDE_TASK_STATUSES = new Set<SideTaskStatus>([
  "queued",
  "running",
  "awaiting_user",
  "succeeded",
  "failed",
  "cancelled",
  "fail_closed",
]);

const SIDE_TASK_ADOPTION_STATES = new Set<SideTaskAdoptionState>([
  "pending",
  "available",
  "partially_adopted",
  "adopted",
  "discarded",
]);

const SIDE_TASK_WORKSPACE_STATES = new Set<SideTaskWorkspaceState>([
  "provisioning",
  "active",
  "sealed",
  "failed",
  "released",
]);

export const SIDE_TASK_STATUS_TEXT: Readonly<Record<SideTaskStatus, string>> = {
  queued: "排队中",
  running: "探索中",
  awaiting_user: "等待补充",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  fail_closed: "安全停止",
};

export const SIDE_TASK_STATUS_TONE: Readonly<Record<SideTaskStatus, "neutral" | "accent" | "ok" | "warn" | "danger">> = {
  queued: "neutral",
  running: "accent",
  awaiting_user: "warn",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  fail_closed: "danger",
};

export const SIDE_TASK_ADOPTION_TEXT: Readonly<Record<SideTaskAdoptionState, string>> = {
  pending: "尚无可采纳结果",
  available: "未采纳",
  partially_adopted: "部分已采纳",
  adopted: "已全部采纳",
  discarded: "已放弃",
};

export class SideTaskContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SideTaskContractError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SideTaskContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SideTaskContractError(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new SideTaskContractError(`${label} must be a valid identifier`);
  }
  return value;
}

function hash(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new SideTaskContractError(`${label} must be a lowercase SHA-256 hash${nullable ? " or null" : ""}`);
  }
  return value;
}

function commit(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !COMMIT_RE.test(value)) {
    throw new SideTaskContractError(`${label} must be a 40 or 64 character Git object id${nullable ? " or null" : ""}`);
  }
  return value.toLowerCase();
}

function isoTime(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new SideTaskContractError(`${label} must be an ISO timestamp${nullable ? " or null" : ""}`);
  }
  return value;
}

/**
 * Browser mirror of Core `validateWorkspacePath` plus the side-task exact-path
 * rule. A leading `./` is accepted and normalized exactly as Core does.
 */
export function normalizeSideTaskWritePath(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  if (PLATFORM_PATH_PREFIX_RE.test(path) || path.startsWith("/")) return null;
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  if (normalized.includes("*")) return null;
  if (new TextEncoder().encode(normalized).byteLength > MAX_WRITE_PATH_BYTES) return null;
  const parts = normalized.split("/");
  if (parts.length < 2) return null;
  if (parts.length > MAX_WRITE_PATH_SEGMENTS) return null;
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const [top, second] = parts;
  if (!top || !WORKSPACE_TOP_LEVEL_DIRS.has(top)) return null;
  if (top === "prj" && (second !== "constr" || parts.length < 3)) return null;
  if (top === "doc" && HDL_EXTENSION_RE.test(normalized)) return null;
  return normalized;
}

/** Exact workspace path accepted by the frozen Core contract. */
export function isSafeSideTaskWritePath(path: string): boolean {
  return normalizeSideTaskWritePath(path) !== null;
}

function parseAuthorizationScope(value: unknown, label: string): SideTaskAuthorizationScope {
  const scope = asRecord(value, label);
  const unsupportedKeys = Object.keys(scope).filter((key) => !SIDE_TASK_AUTHORIZATION_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    throw new SideTaskContractError(`${label} contains unsupported fields: ${unsupportedKeys.sort().join(", ")}`);
  }
  if (scope.schema !== "task-scope.v1" || scope.workspace !== "isolated") {
    throw new SideTaskContractError(`${label} must use task-scope.v1 with an isolated workspace`);
  }
  if (
    !Array.isArray(scope.read_paths)
    || scope.read_paths.length !== SIDE_TASK_READ_PATHS.length
    || scope.read_paths.some((path) => typeof path !== "string" || !SIDE_TASK_READ_PATH_SET.has(path))
    || new Set(scope.read_paths).size !== SIDE_TASK_READ_PATHS.length
  ) {
    throw new SideTaskContractError(`${label}.read_paths must expose only the frozen project roots`);
  }
  if (!Array.isArray(scope.run_classes) || scope.run_classes.length !== 1 || scope.run_classes[0] !== "exploratory") {
    throw new SideTaskContractError(`${label}.run_classes must contain only exploratory`);
  }
  if (
    scope.can_submit_gates !== false
    || scope.can_create_milestones !== false
    || scope.can_start_formal_runs !== false
  ) {
    throw new SideTaskContractError(`${label} cannot grant formal engineering capabilities`);
  }
  if (!Array.isArray(scope.write_paths) || scope.write_paths.length === 0 || scope.write_paths.length > MAX_WRITE_PATHS) {
    throw new SideTaskContractError(`${label}.write_paths must contain 1-${MAX_WRITE_PATHS} exact paths`);
  }
  const writePaths = scope.write_paths.map((path, index) => {
    const normalized = typeof path === "string" ? normalizeSideTaskWritePath(path) : null;
    if (normalized === null) {
      throw new SideTaskContractError(`${label}.write_paths[${index}] is not a safe exact workspace path`);
    }
    return normalized;
  });
  if (new Set(writePaths).size !== writePaths.length) {
    throw new SideTaskContractError(`${label}.write_paths contains duplicates`);
  }
  return {
    schema: "task-scope.v1",
    workspace: "isolated",
    read_paths: [...SIDE_TASK_READ_PATHS],
    write_paths: writePaths.sort(),
    run_classes: ["exploratory"],
    can_submit_gates: false,
    can_create_milestones: false,
    can_start_formal_runs: false,
  };
}

function optionalFailureReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new SideTaskContractError("side task failure_reason must be a string or null");
  return value.slice(0, 2_000);
}

export function parseSideTask(value: unknown): SideTaskSummary {
  const row = asRecord(value, "side task");
  if (row.kind !== "side") throw new SideTaskContractError("task.kind must be side");
  const status = row.status;
  if (typeof status !== "string" || !SIDE_TASK_STATUSES.has(status as SideTaskStatus)) {
    throw new SideTaskContractError("side task status is not canonical");
  }
  const adoptionState = row.adoption_state;
  if (typeof adoptionState !== "string" || !SIDE_TASK_ADOPTION_STATES.has(adoptionState as SideTaskAdoptionState)) {
    throw new SideTaskContractError("side task adoption_state is not canonical");
  }
  const workspaceState = row.workspace_state;
  if (
    workspaceState !== null && workspaceState !== undefined &&
    (typeof workspaceState !== "string" || !SIDE_TASK_WORKSPACE_STATES.has(workspaceState as SideTaskWorkspaceState))
  ) {
    throw new SideTaskContractError("side task workspace_state is not canonical");
  }
  const outputHash = hash(row.output_hash, "side task output_hash", true);
  if (status === "succeeded" && outputHash === null) {
    throw new SideTaskContractError("a succeeded side task must expose output_hash");
  }
  const objective = requiredString(row, "objective", "side task");
  if (objective.length > MAX_OBJECTIVE_CHARS) throw new SideTaskContractError("side task objective is too long");
  return {
    task_id: identifier(row.task_id, "side task task_id"),
    project_id: identifier(row.project_id, "side task project_id"),
    kind: "side",
    parent_task_id: identifier(row.parent_task_id, "side task parent_task_id"),
    workspace_id: identifier(row.workspace_id, "side task workspace_id"),
    objective,
    status: status as SideTaskStatus,
    input_hash: hash(row.input_hash, "side task input_hash")!,
    output_hash: outputHash,
    adoption_state: adoptionState as SideTaskAdoptionState,
    authorization_scope: parseAuthorizationScope(row.authorization_scope, "side task authorization_scope"),
    base_commit: commit(row.base_commit, "side task base_commit", true),
    base_manifest_hash: hash(row.base_manifest_hash, "side task base_manifest_hash", true),
    workspace_state: (workspaceState ?? null) as SideTaskWorkspaceState | null,
    created_at: isoTime(row.created_at, "side task created_at")!,
    updated_at: isoTime(row.updated_at, "side task updated_at")!,
    finished_at: isoTime(row.finished_at, "side task finished_at", true),
    failure_reason: optionalFailureReason(row.failure_reason ?? row.reason),
  };
}

/** Accept the frozen `{tasks}` collection plus the compatibility `{agents}`/array envelope. */
export function parseSideTaskList(value: unknown): SideTaskSummary[] {
  let rows: unknown;
  if (Array.isArray(value)) rows = value;
  else {
    const root = asRecord(value, "side task list");
    rows = root.tasks ?? root.agents;
  }
  if (!Array.isArray(rows)) throw new SideTaskContractError("side task list must contain a tasks array");
  const sideRows = rows.filter((item) => {
    const row = asRecord(item, "side task list item");
    return row.kind === "side";
  });
  return sideRows.map(parseSideTask);
}

const SIDE_TASK_EVENT_KINDS = new Set<SideTaskConversationEventKind>([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "status",
]);

/** Strictly parse the Core-owned event page used to resume awaiting_user tasks. */
export function parseSideTaskConversationPage(value: unknown): SideTaskConversationPage {
  const row = asRecord(value, "side task conversation page");
  if (!Array.isArray(row.events)) {
    throw new SideTaskContractError("side task conversation page.events must be an array");
  }
  const taskId = identifier(row.task_id, "side task conversation page.task_id");
  const events = row.events.map((raw, index): SideTaskConversationEvent => {
    const event = asRecord(raw, `side task event ${index}`);
    const kind = event.event_kind;
    if (typeof kind !== "string" || !SIDE_TASK_EVENT_KINDS.has(kind as SideTaskConversationEventKind)) {
      throw new SideTaskContractError(`side task event ${index}.event_kind is not canonical`);
    }
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= 0) {
      throw new SideTaskContractError(`side task event ${index}.sequence must be a positive integer`);
    }
    const actorType = event.actor_type;
    if (actorType !== "human" && actorType !== "service") {
      throw new SideTaskContractError(`side task event ${index}.actor_type is invalid`);
    }
    return {
      id: identifier(event.id, `side task event ${index}.id`),
      sequence: event.sequence as number,
      event_kind: kind as SideTaskConversationEventKind,
      payload: asRecord(event.payload, `side task event ${index}.payload`),
      payload_hash: hash(event.payload_hash, `side task event ${index}.payload_hash`)!,
      actor_type: actorType,
      actor_id: requiredString(event, "actor_id", `side task event ${index}`),
      created_at: isoTime(event.created_at, `side task event ${index}.created_at`)!,
    };
  });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) {
      throw new SideTaskContractError("side task events must be strictly ordered by sequence");
    }
  }
  if (!Number.isSafeInteger(row.next_after) || (row.next_after as number) < 0) {
    throw new SideTaskContractError("side task conversation page.next_after must be a non-negative integer");
  }
  const nextAfter = row.next_after as number;
  if (events.length > 0 && nextAfter !== events.at(-1)!.sequence) {
    throw new SideTaskContractError("side task conversation page.next_after must match the last event");
  }
  return { task_id: taskId, events, next_after: nextAfter };
}

/** User-visible text for an append-only side-task event; null hides transport-only facts. */
export function sideTaskEventText(event: SideTaskConversationEvent): string | null {
  if (event.event_kind === "user_message" || event.event_kind === "assistant_message") {
    return typeof event.payload.text === "string" && event.payload.text.trim()
      ? event.payload.text.trim()
      : null;
  }
  if (event.event_kind === "status" && typeof event.payload.status === "string") {
    const status = event.payload.status as SideTaskStatus;
    return SIDE_TASK_STATUS_TEXT[status] ? `状态：${SIDE_TASK_STATUS_TEXT[status]}` : null;
  }
  return null;
}

function parseTest(value: unknown, index: number): SideTaskTestResult {
  if (typeof value === "string" && value.trim()) {
    return { name: value.trim(), status: "unknown", detail: null };
  }
  const row = asRecord(value, `side task test ${index}`);
  const name = requiredString(row, "name", `side task test ${index}`).slice(0, 256);
  const rawStatus = row.status ?? "unknown";
  const status = rawStatus === "passed" || rawStatus === "failed" || rawStatus === "skipped" || rawStatus === "unknown"
    ? rawStatus
    : "unknown";
  const detail = row.detail === null || row.detail === undefined
    ? null
    : typeof row.detail === "string"
      ? row.detail.slice(0, 2_000)
      : (() => { throw new SideTaskContractError(`side task test ${index}.detail must be a string or null`); })();
  return { name, status, detail };
}

function parseResultFile(value: unknown, index: number): SideTaskResultFile {
  const row = asRecord(value, `side task result file ${index}`);
  const path = requiredString(row, "path", `side task result file ${index}`);
  if (!isSafeSideTaskWritePath(path)) throw new SideTaskContractError(`side task result file ${index} has an unsafe path`);
  const changeKind = row.change_kind;
  if (changeKind !== "added" && changeKind !== "modified") {
    throw new SideTaskContractError(`side task result file ${index}.change_kind is invalid`);
  }
  const baseHash = hash(row.base_hash, `side task result file ${index}.base_hash`, true);
  if (changeKind === "added" && baseHash !== null) throw new SideTaskContractError("an added result file must have a null base_hash");
  if (changeKind === "modified" && baseHash === null) throw new SideTaskContractError("a modified result file must have a base_hash");
  const size = row.size_bytes;
  if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > 1024 * 1024) {
    throw new SideTaskContractError(`side task result file ${index}.size_bytes is invalid`);
  }
  return {
    path,
    change_kind: changeKind,
    base_hash: baseHash,
    result_hash: hash(row.result_hash, `side task result file ${index}.result_hash`)!,
    size_bytes: size as number,
  };
}

export function parseSideTaskResult(value: unknown): SideTaskResult {
  const row = asRecord(value, "side task result");
  if (!Array.isArray(row.tests) || !Array.isArray(row.files)) {
    throw new SideTaskContractError("side task result must contain tests and files arrays");
  }
  const files = row.files.map(parseResultFile);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new SideTaskContractError("side task result contains duplicate paths");
  }
  const summary = requiredString(row, "summary", "side task result");
  return {
    result_id: identifier(row.result_id, "side task result_id"),
    task_id: identifier(row.task_id, "side task result task_id"),
    workspace_id: identifier(row.workspace_id, "side task result workspace_id"),
    base_commit: commit(row.base_commit, "side task result base_commit")!,
    result_commit: commit(row.result_commit, "side task result result_commit")!,
    summary: summary.slice(0, 10_000),
    tests: row.tests.map(parseTest),
    files,
    output_hash: hash(row.output_hash, "side task result output_hash")!,
    created_at: isoTime(row.created_at, "side task result created_at", true),
  };
}

function parseDiffFile(value: unknown, index: number): SideTaskDiffFile {
  const row = asRecord(value, `side task diff file ${index}`);
  const path = requiredString(row, "path", `side task diff file ${index}`);
  if (!isSafeSideTaskWritePath(path)) throw new SideTaskContractError(`side task diff file ${index} has an unsafe path`);
  const changeKind = row.change_kind;
  if (changeKind !== "added" && changeKind !== "modified") {
    throw new SideTaskContractError(`side task diff file ${index}.change_kind is invalid`);
  }
  const baseHash = hash(row.base_hash, `side task diff file ${index}.base_hash`, true);
  if (changeKind === "added" && baseHash !== null) throw new SideTaskContractError("an added diff file must have a null base_hash");
  if (changeKind === "modified" && baseHash === null) throw new SideTaskContractError("a modified diff file must have a base_hash");
  const diff = requiredString(row, "diff", `side task diff file ${index}`);
  if (diff.length > MAX_DIFF_CHARS) throw new SideTaskContractError(`side task diff file ${index} is too large`);
  const conflictReason = row.conflict_reason;
  if (conflictReason !== null && conflictReason !== undefined && typeof conflictReason !== "string") {
    throw new SideTaskContractError(`side task diff file ${index}.conflict_reason must be a string or null`);
  }
  const adopted = row.adopted === true || row.adoption_state === "adopted" || row.adoption_status === "adopted";
  return {
    path,
    change_kind: changeKind,
    base_hash: baseHash,
    result_hash: hash(row.result_hash, `side task diff file ${index}.result_hash`)!,
    current_target_hash: hash(row.current_target_hash, `side task diff file ${index}.current_target_hash`, true),
    diff,
    conflict_reason: typeof conflictReason === "string" ? conflictReason.slice(0, 1_000) : null,
    adopted,
  };
}

export function parseSideTaskDiff(value: unknown): SideTaskDiff {
  const row = asRecord(value, "side task diff");
  if (!Array.isArray(row.files)) throw new SideTaskContractError("side task diff must contain a files array");
  const files = row.files.map(parseDiffFile);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new SideTaskContractError("side task diff contains duplicate paths");
  }
  return {
    task_id: identifier(row.task_id, "side task diff task_id"),
    result_id: identifier(row.result_id, "side task diff result_id"),
    preview_hash: hash(row.preview_hash, "side task diff preview_hash")!,
    files,
  };
}

export function parseSideTaskAdoptionResult(value: unknown): SideTaskAdoptionResult {
  const row = asRecord(value, "side task adoption");
  const status = row.status ?? row.state;
  if (status !== "applied" && status !== "conflicted" && status !== "failed") {
    throw new SideTaskContractError("side task adoption status is not canonical");
  }
  const paths = row.adopted_paths ?? row.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !isSafeSideTaskWritePath(path))) {
    throw new SideTaskContractError("side task adoption adopted_paths is invalid");
  }
  return {
    adoption_id: identifier(row.adoption_id ?? row.id, "side task adoption_id"),
    task_id: identifier(row.task_id ?? row.side_task_id, "side task adoption task_id"),
    result_id: identifier(row.result_id, "side task adoption result_id"),
    status,
    adopted_paths: paths as string[],
    project_commit_before: commit(row.project_commit_before, "side task adoption project_commit_before", true),
    project_commit_after: commit(row.project_commit_after, "side task adoption project_commit_after", true),
  };
}

export interface SideTaskCreateDraft {
  readonly parentTaskId: string | null;
  readonly objective: string;
  readonly baseCommit: string | null;
  readonly writePathsText: string;
}

export type SideTaskCreateParse =
  | { readonly ok: true; readonly request: CreateSideTaskRequest }
  | { readonly ok: false; readonly message: string };

export function buildCreateSideTaskRequest(draft: SideTaskCreateDraft): SideTaskCreateParse {
  const objective = draft.objective.trim();
  if (!draft.parentTaskId || !IDENTIFIER_RE.test(draft.parentTaskId)) {
    return { ok: false, message: "当前没有可作为父级的非终态主任务。" };
  }
  if (!objective) return { ok: false, message: "请填写探索目标。" };
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return { ok: false, message: `探索目标不能超过 ${MAX_OBJECTIVE_CHARS} 个字符。` };
  }
  if (!draft.baseCommit || !COMMIT_RE.test(draft.baseCommit)) {
    return { ok: false, message: "Core 未提供可信的当前 Git 提交，暂不能创建隔离副本。" };
  }
  const paths = draft.writePathsText
    .split(/[\r\n,]+/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (paths.length === 0) return { ok: false, message: "请至少填写一个允许写入的精确文件路径。" };
  if (paths.length > MAX_WRITE_PATHS) return { ok: false, message: `最多授权 ${MAX_WRITE_PATHS} 个文件。` };
  const unsafe = paths.find((path) => normalizeSideTaskWritePath(path) === null);
  if (unsafe) return { ok: false, message: `路径不安全、超出工作区范围或包含通配符：${unsafe}` };
  const normalizedPaths = paths.map((path) => normalizeSideTaskWritePath(path)!);
  if (new Set(normalizedPaths).size !== normalizedPaths.length) return { ok: false, message: "授权路径不能重复。" };
  return {
    ok: true,
    request: {
      kind: "side",
      parent_task_id: draft.parentTaskId,
      objective,
      base_commit: draft.baseCommit.toLowerCase(),
      authorization_scope: {
        schema: "task-scope.v1",
        workspace: "isolated",
        read_paths: [...SIDE_TASK_READ_PATHS],
        write_paths: normalizedPaths.sort(),
        run_classes: ["exploratory"],
        can_submit_gates: false,
        can_create_milestones: false,
        can_start_formal_runs: false,
      },
    },
  };
}

export interface SideTaskCreateAttempt {
  readonly signature: string;
  readonly idempotencyKey: string;
  readonly request: CreateSideTaskRequest;
}

/** Reuse the exact create body/key until the draft changes or the caller clears it. */
export function prepareSideTaskCreateAttempt(
  previous: SideTaskCreateAttempt | null,
  request: CreateSideTaskRequest,
  createKey: () => string,
): SideTaskCreateAttempt {
  const signature = JSON.stringify(request);
  if (previous?.signature === signature) return previous;
  return { signature, idempotencyKey: createKey(), request };
}

export interface SideTaskAdoptionAttempt {
  readonly signature: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly request: AdoptSideTaskRequest;
}

/**
 * Ignore a newly generated adoption id when every user-controlled field is
 * unchanged, so retrying a failed POST replays the original body and key.
 */
export function prepareSideTaskAdoptionAttempt(
  previous: SideTaskAdoptionAttempt | null,
  taskId: string,
  request: AdoptSideTaskRequest,
): SideTaskAdoptionAttempt {
  const signature = JSON.stringify({
    taskId,
    result_id: request.result_id,
    files: request.files,
    preview_hash: request.preview_hash,
    reason: request.reason,
  });
  if (previous?.signature === signature) return previous;
  return {
    signature,
    taskId,
    idempotencyKey: request.adoption_id,
    request,
  };
}

/** Full hashes are intentionally shown before adoption; null means no file existed. */
export function formatSideTaskHash(value: string | null): string {
  return value ?? "不存在";
}

export type SideTaskAdoptionParse =
  | { readonly ok: true; readonly request: AdoptSideTaskRequest }
  | { readonly ok: false; readonly message: string };

export function buildSideTaskAdoptionRequest(
  diff: SideTaskDiff,
  selectedPaths: ReadonlySet<string>,
  reasonInput: string,
  adoptionId: string,
): SideTaskAdoptionParse {
  const reason = reasonInput.trim();
  if (!IDENTIFIER_RE.test(adoptionId)) return { ok: false, message: "采纳请求标识无效，请重试。" };
  if (!reason) return { ok: false, message: "请填写人工采纳理由。" };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, message: `采纳理由不能超过 ${MAX_REASON_CHARS} 个字符。` };
  const selected = diff.files.filter((file) => selectedPaths.has(file.path));
  if (selected.length === 0) return { ok: false, message: "请至少选择一个无冲突且未采纳的文件。" };
  const blocked = selected.find((file) => file.adopted || file.conflict_reason !== null);
  if (blocked) {
    return {
      ok: false,
      message: blocked.adopted ? `${blocked.path} 已经采纳，不能重复操作。` : `${blocked.path} 存在覆盖冲突，请刷新后处理。`,
    };
  }
  return {
    ok: true,
    request: {
      adoption_id: adoptionId,
      result_id: diff.result_id,
      preview_hash: diff.preview_hash,
      reason,
      files: selected.map((file) => ({
        path: file.path,
        expected_base_hash: file.base_hash,
        expected_proposed_hash: file.result_hash,
        expected_target_hash: file.current_target_hash,
      })),
    },
  };
}

export function isSideTaskTerminal(status: SideTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "fail_closed";
}

/** Drawer-scoped polling never participates in the main task/SSE refresh loop. */
export function shouldPollSideTasks(open: boolean, tasks: readonly SideTaskSummary[]): boolean {
  return open && tasks.some((task) =>
    task.status === "queued" || task.status === "running" || task.status === "awaiting_user"
  );
}

export function canInspectSideTaskResult(task: SideTaskSummary): boolean {
  return task.status === "succeeded" && task.output_hash !== null;
}

export function sideTaskErrorText(error: unknown, action: "加载" | "创建" | "采纳"): string {
  if (error instanceof SideTaskContractError) return "Core 返回的探索任务数据不符合冻结契约，已停止展示。";
  if (error instanceof NetworkError) return `网络连接失败，探索任务${action}未完成。`;
  if (error instanceof ApiError) {
    const detail = `${error.code} ${error.message}`;
    if (error.status === 409 && action === "采纳") {
      return "主工作区或差异预览已经变化，本次未采纳任何文件。请刷新差异后重新选择。";
    }
    if (error.status === 409) return `探索任务${action}发生状态冲突，请刷新后重试。`;
    if (error.status === 503 || /SIDE_TASK|side task/i.test(detail) && /disabled|unavailable/i.test(detail)) {
      return "探索任务能力暂不可用；现有主 Agent 与正式阶段不受影响。";
    }
    if (error.status === 404) return "探索任务不存在、已清理或不属于当前项目。";
    if (error.status === 403) return action === "采纳" ? "当前账号不能执行人工采纳。" : "当前账号无权操作探索任务。";
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.status >= 500) return `服务暂时不可用，探索任务${action}未完成。`;
  }
  return `探索任务${action}失败，请重试。`;
}
