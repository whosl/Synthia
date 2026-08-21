/**
 * Synthia Core API — router (IF-001 §3, §8 versioned under /api/v1)
 *
 * Parses the request, authenticates via Bearer token, parses the JSON body
 * (parse failure → 400 validation), matches the method+path to a handler,
 * enforces a coarse three-tier scope guard (read/write/approve), and wraps the
 * handler result in the unified envelope. Unknown paths → 404.
 *
 * Internal-error hardening: any unexpected error returns a fixed "internal
 * error" message with the correlation_id; the real `err.message` goes only to
 * the server log. PostgreSQL unique-violation (SQLSTATE 23505) is mapped to a
 * stable 409 conflict.
 */

import type { Pool } from "pg";
import { authenticate } from "./auth.ts";
import type { ConnectorPort } from "./connector-port.ts";
import type { RuntimeClient } from "./task-proxy.ts";
import {
  DISABLED_CORE_FEATURE_FLAGS,
  type CoreFeatureFlags,
} from "./feature-flags.ts";
import { errorEnvelope, resolveCorrelationId, successEnvelope } from "./envelope.ts";
import {
  ApiError,
  conflictApiError,
  internalError,
  isPgUniqueViolation,
  notFoundError,
  validationError,
} from "./errors.ts";
import type { HandlerResult, RequestContext } from "./handlers.ts";
import { WorkspaceError } from "../workspace/paths.ts";
import {
  approveGateHandler,
  assignRole,
  copyProjectAsEngineering,
  createGateSubmissionHandler,
  createProcessInstance,
  createProject,
  createRevisionHandler,
  createSnapshotHandler,
  createTraceRelationHandler,
  getArtifacts,
  getBaselines,
  getEvents,
  getGateSubmissionHandler,
  getGateSubmissions,
  getJobEvidenceContentHandler,
  getJobEvidenceHandler,
  getJobStatusHandler,
  getProject,
  getProjects,
  getProcessVersions,
  getRevision,
  getRevisionContent,
  getRevisions,
  getTraceRelations,
  listJobsHandler,
  rejectGateSubmissionHandler,
  submitGateSubmissionHandler,
  submitJobHandler,
  withdrawGateSubmissionHandler,
} from "./handlers.ts";
import {
  abortTaskHandler,
  createTaskHandler,
  getTaskHandler,
  listTasksHandler,
  sendTaskMessageHandler,
  streamTaskHandler,
} from "./task-proxy.ts";
import {
  getWorkspaceFileHandler,
  getWorkspaceTreeHandler,
  putWorkspaceFileHandler,
  registerWorkspaceHandler,
  writeWorkspaceFilesHandler,
} from "./workspace-handlers.ts";
import {
  confirmImportSnapshotHandler,
  copyImportSnapshotHandler,
  createImportSnapshotHandler,
  denyImportSnapshotHandler,
  getImportSnapshotHandler,
  listImportSnapshotsHandler,
  searchImportSnapshotsHandler,
} from "./import-handlers.ts";

const API_PREFIX = "/api/v1";
const CLASSIFICATIONS: Record<string, true> = { D1: true, D2: true, D3: true, D4: true, UNCLASSIFIED: true };

type Handler = (ctx: RequestContext) => Promise<HandlerResult | Response>;

/** 文件头写的「coarse three-tier scope guard」的那三层。
 *  之前 `RequiredScope` 只被引用、从没被声明过（tsc TS2304）——因为纯类型位置会被
 *  转译器擦掉，运行时不报错，于是一直没人发现；代价是下面 30 多条路由的 scope
 *  字面量实际上没被校验过。 */
type RequiredScope = "core:read" | "core:write" | "core:approve";

interface RouteMatch {
  readonly handler: Handler;
  readonly params: Record<string, string>;
  readonly requiredScope: RequiredScope;
}


export async function routeApi(
  request: Request,
  pool: Pool,
  connector?: ConnectorPort,
  runtimeClient?: RuntimeClient,
  featureFlags: Readonly<CoreFeatureFlags> = DISABLED_CORE_FEATURE_FLAGS,
): Promise<Response> {
  const url = new URL(request.url);
  const correlationId = resolveCorrelationId(request.headers.get("x-correlation-id"));

  if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
    return jsonBody(404, errorEnvelope(notFoundError(`unknown path: ${request.method} ${url.pathname}`), correlationId));
  }

  let identity;
  try {
    identity = await authenticate(pool, request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ApiError) return jsonBody(err.httpStatus, errorEnvelope(err, correlationId));
    return jsonBody(500, errorEnvelope(INTERNAL_ERROR, correlationId));
  }

  let body: unknown = null;
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    const raw = await request.text();
    if (raw.length === 0) {
      return jsonBody(400, errorEnvelope(validationError("request body is required for writes"), correlationId));
    }
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonBody(400, errorEnvelope(validationError("request body is not valid JSON"), correlationId));
    }
  }

  let classification: string;
  try {
    classification = resolveClassification(request.headers.get("x-classification"), body);
  } catch (err) {
    return jsonBody(400, errorEnvelope(err instanceof ApiError ? err : validationError("invalid classification"), correlationId));
  }

  const ctx: RequestContext = {
    pool,
    identity,
    method: request.method,
    url,
    request,
    params: {},
    body,
    correlationId,
    idempotencyKey: request.headers.get("idempotency-key"),
    classification,
    connector,
    runtimeClient,
    featureFlags,
  };

  const match = matchRoute(ctx);
  if (!match) {
    return jsonBody(404, errorEnvelope(notFoundError(`unknown path: ${request.method} ${url.pathname}`), correlationId));
  }

  // Coarse three-tier scope guard (B4). Project-level ACL is a later slice;
  // the first slice runs inside the trusted intranet domain.
  if (!identity.scopes.includes(match.requiredScope)) {
    return jsonBody(403, errorEnvelope(forbiddenErrorWithRequired(match.requiredScope), correlationId));
  }

  try {
    const result = await match.handler({ ...ctx, params: match.params });
    // Raw pass-through (SSE): the handler already built the final Response —
    // no envelope wrap. Errors still surface through the JSON error envelope.
    if (result instanceof Response) return result;
    return jsonBody(result.status, successEnvelope(result.data, correlationId));
  } catch (err) {
    return jsonBody(toErrorStatus(err), errorEnvelope(toApiError(err), correlationId));
  }
}

function resolveClassification(header: string | null, body: unknown): string {
  const headerVal = (header ?? "").trim();
  if (headerVal) {
    if (!(headerVal in CLASSIFICATIONS)) {
      throw validationError(`classification must be one of: ${Object.keys(CLASSIFICATIONS).join(", ")}`);
    }
    return headerVal;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const c = (body as Record<string, unknown>).classification;
    if (c === undefined || c === null) return "D1";
    if (typeof c !== "string" || !(c in CLASSIFICATIONS)) {
      throw validationError(`classification must be one of: ${Object.keys(CLASSIFICATIONS).join(", ")}`);
    }
    return c;
  }
  return "D1";
}

/** Match method + path segments to a handler. Returns null if no match. */
function matchRoute(ctx: RequestContext): RouteMatch | null {
  const segments = ctx.url.pathname.slice(API_PREFIX.length).split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "process-versions" && ctx.method === "GET") {
    return { handler: getProcessVersions, params: {}, requiredScope: "core:read" };
  }
  if (segments.length === 0 || segments[0] !== "projects") return null;
  const method = ctx.method;

  // POST /projects
  if (segments.length === 1 && method === "POST") return { handler: createProject, params: {}, requiredScope: "core:write" };

  // GET /projects — list all projects (newest first)
  if (segments.length === 1 && method === "GET") return { handler: getProjects, params: {}, requiredScope: "core:read" };

  if (segments.length >= 2) {
    const projectId = segments[1]!;
    const tail = segments[2];

    // GET /projects/:projectId
    if (segments.length === 2 && method === "GET") return { handler: getProject, params: { projectId }, requiredScope: "core:read" };

    // 3-segment routes under /projects/:projectId
    if (segments.length === 3 && tail) {
      const params = { projectId };
      switch (tail) {
        case "baselines":
          if (method === "GET") return { handler: getBaselines, params, requiredScope: "core:read" };
          break;
        case "copy-as-engineering":
          if (method === "POST") return { handler: copyProjectAsEngineering, params, requiredScope: "core:write" };
          break;
        case "events":
          if (method === "GET") return { handler: getEvents, params, requiredScope: "core:read" };
          break;
        case "process-instances":
          if (method === "POST") return { handler: createProcessInstance, params, requiredScope: "core:write" };
          break;
        case "role-assignments":
          if (method === "POST") return { handler: assignRole, params, requiredScope: "core:write" };
          break;
        case "snapshots":
          if (method === "POST") return { handler: createSnapshotHandler, params, requiredScope: "core:write" };
          break;
        case "import-snapshots":
          if (method === "POST") return { handler: createImportSnapshotHandler, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: listImportSnapshotsHandler, params, requiredScope: "core:read" };
          break;
        case "trace-relations":
          if (method === "POST") return { handler: createTraceRelationHandler, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: getTraceRelations, params, requiredScope: "core:read" };
          break;
        case "gate-submissions":
          if (method === "POST") return { handler: createGateSubmissionHandler, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: getGateSubmissions, params, requiredScope: "core:read" };
          break;
        case "artifacts":
          if (method === "GET") return { handler: getArtifacts, params, requiredScope: "core:read" };
          break;
        case "jobs":
          if (method === "POST") return { handler: submitJobHandler, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: listJobsHandler, params, requiredScope: "core:read" };
          break;
        case "tasks":
          if (method === "POST") return { handler: createTaskHandler, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: listTasksHandler, params, requiredScope: "core:read" };
          break;
      }
    }

    // GET /projects/:projectId/gate-submissions/:subId
    if (segments.length === 4 && segments[2] === "gate-submissions" && method === "GET") {
      return { handler: getGateSubmissionHandler, params: { projectId, subId: segments[3]! }, requiredScope: "core:read" };
    }

    // P2 historical-material library: search and snapshot detail.
    if (segments.length === 4 && segments[2] === "import-snapshots") {
      if (segments[3] === "search" && method === "GET") {
        return { handler: searchImportSnapshotsHandler, params: { projectId }, requiredScope: "core:read" };
      }
      if (method === "GET") {
        return { handler: getImportSnapshotHandler, params: { projectId, snapshotId: segments[3]! }, requiredScope: "core:read" };
      }
    }

    if (segments.length === 5 && segments[2] === "import-snapshots" && method === "POST") {
      const params = { projectId, snapshotId: segments[3]! };
      if (segments[4] === "confirm") return { handler: confirmImportSnapshotHandler, params, requiredScope: "core:approve" };
      if (segments[4] === "deny") return { handler: denyImportSnapshotHandler, params, requiredScope: "core:approve" };
      if (segments[4] === "copy") return { handler: copyImportSnapshotHandler, params, requiredScope: "core:write" };
    }

    // GET /projects/:projectId/jobs/:jobId
    if (segments.length === 4 && segments[2] === "jobs" && method === "GET") {
      return { handler: getJobStatusHandler, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
    }

    // GET /projects/:projectId/tasks/:agentId
    if (segments.length === 4 && segments[2] === "tasks" && method === "GET") {
      return { handler: getTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:read" };
    }

    // POST /projects/:projectId/tasks/:agentId/message | /abort (free-agent conversation)
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "message" && method === "POST") {
      return { handler: sendTaskMessageHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:write" };
    }
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "abort" && method === "POST") {
      return { handler: abortTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:write" };
    }

    // GET /projects/:projectId/tasks/:agentId/stream — SSE pass-through (raw Response)
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "stream" && method === "GET") {
      return { handler: streamTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:read" };
    }

    // GET /projects/:projectId/jobs/:jobId/evidence
    if (segments.length === 5 && segments[2] === "jobs" && segments[4] === "evidence" && method === "GET") {
      return { handler: getJobEvidenceHandler, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
    }

    // GET /projects/:projectId/jobs/:jobId/evidence/content?name=<name>
    if (segments.length === 6 && segments[2] === "jobs" && segments[4] === "evidence" && segments[5] === "content" && method === "GET") {
      return { handler: getJobEvidenceContentHandler, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
    }

    // /projects/:projectId/artifacts/:artifactId/revisions[/:revId]
    if (segments.length >= 5 && segments[2] === "artifacts" && segments[4] === "revisions") {
      const artifactId = segments[3]!;
      if (segments.length === 5 && method === "POST") {
        return { handler: createRevisionHandler, params: { projectId, artifactId }, requiredScope: "core:write" };
      }
      // GET .../revisions — list revisions of an artifact (version desc)
      if (segments.length === 5 && method === "GET") {
        return { handler: getRevisions, params: { projectId, artifactId }, requiredScope: "core:read" };
      }
      if (segments.length === 6 && method === "GET") {
        return { handler: getRevision, params: { projectId, artifactId, revId: segments[5]! }, requiredScope: "core:read" };
      }
      // GET .../revisions/:revId/content — inline revision content
      if (segments.length === 7 && segments[6] === "content" && method === "GET") {
        return { handler: getRevisionContent, params: { projectId, artifactId, revId: segments[5]! }, requiredScope: "core:read" };
      }
    }

    // /projects/:projectId/workspace/{tree|file|register|files} — 真实磁盘工作区
    if (segments.length === 4 && segments[2] === "workspace") {
      const params = { projectId };
      switch (segments[3]) {
        case "tree":
          if (method === "GET") return { handler: getWorkspaceTreeHandler, params, requiredScope: "core:read" };
          break;
        case "file":
          if (method === "GET") return { handler: getWorkspaceFileHandler, params, requiredScope: "core:read" };
          if (method === "PUT") return { handler: putWorkspaceFileHandler, params, requiredScope: "core:write" };
          break;
        case "files":
          if (method === "POST") return { handler: writeWorkspaceFilesHandler, params, requiredScope: "core:write" };
          break;
        case "register":
          if (method === "POST") return { handler: registerWorkspaceHandler, params, requiredScope: "core:write" };
          break;
      }
    }

    // /projects/:projectId/gate-submissions/:subId/approve
    if (segments.length === 5 && segments[2] === "gate-submissions" && segments[4] === "approve" && method === "POST") {
      return { handler: approveGateHandler, params: { projectId, subId: segments[3]! }, requiredScope: "core:approve" };
    }

    // /projects/:projectId/gate-submissions/:subId/submit
    if (segments.length === 5 && segments[2] === "gate-submissions" && segments[4] === "submit" && method === "POST") {
      return { handler: submitGateSubmissionHandler, params: { projectId, subId: segments[3]! }, requiredScope: "core:write" };
    }

    // /projects/:projectId/gate-submissions/:subId/withdraw
    if (segments.length === 5 && segments[2] === "gate-submissions" && segments[4] === "withdraw" && method === "POST") {
      return { handler: withdrawGateSubmissionHandler, params: { projectId, subId: segments[3]! }, requiredScope: "core:write" };
    }

    // /projects/:projectId/gate-submissions/:subId/reject
    if (segments.length === 5 && segments[2] === "gate-submissions" && segments[4] === "reject" && method === "POST") {
      return { handler: rejectGateSubmissionHandler, params: { projectId, subId: segments[3]! }, requiredScope: "core:approve" };
    }
  }

  return null;
}

// ─── error hardening ─────────────────────────────────────────────────────────

/** Fixed internal-error payload — never leaks the real exception text. */
const INTERNAL_ERROR = internalError("internal error");

/** Scope-missing error naming the required tier. */
function forbiddenErrorWithRequired(scope: RequiredScope): ApiError {
  const err = new ApiError("authorization", 403, "insufficient scope for this operation", false, { requiredScope: scope });
  return err;
}

/** Map an unknown thrown value to the ApiError surfaced to the client. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof WorkspaceError) return workspaceApiError(err);
  if (isPgUniqueViolation(err)) return conflictApiError("RESOURCE_CONFLICT", null, true);
  // Real diagnostic goes only to the server log; the client gets a fixed message.
  console.error("[synthia-api] internal error:", err);
  return INTERNAL_ERROR;
}

/**
 * 工作区错误的消息是**给人看的操作指引**（「这些文件有未登记的人工改动…」），
 * 与 `INTERNAL_ERROR` 的固定措辞不同，要原样透出去；这不泄露内部实现，路径与
 * RULE-25 条款本来就是用户可见契约。只有 git 命令失败例外——那里面可能带机器上
 * 的绝对路径与 git 内部输出，只记日志。
 */
function workspaceApiError(err: WorkspaceError): ApiError {
  switch (err.code) {
    case "WORKSPACE_PATH_INVALID":
      return validationError(err.message, err.details);
    case "WORKSPACE_FILE_NOT_FOUND":
      return notFoundError(err.message, err.details);
    case "WORKSPACE_FILE_DIRTY":
      return conflictApiError(err.message, err.details, false);
    case "CONTENT_HASH_MISMATCH":
      return new ApiError("internal", 500, err.message, false, err.details);
    default:
      console.error("[synthia-api] workspace git error:", err);
      return INTERNAL_ERROR;
  }
}

function toErrorStatus(err: unknown): number {
  return toApiError(err).httpStatus;
}

function jsonBody(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
