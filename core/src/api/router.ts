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
import {
  approveGateHandler,
  assignRole,
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
} from "./task-proxy.ts";

const API_PREFIX = "/api/v1";
const CLASSIFICATIONS: Record<string, true> = { D1: true, D2: true, D3: true, D4: true, UNCLASSIFIED: true };

type Handler = (ctx: RequestContext) => Promise<HandlerResult>;
type RequiredScope = "core:read" | "core:write" | "core:approve";

interface RouteMatch {
  readonly handler: Handler;
  readonly params: Record<string, string>;
  readonly requiredScope: RequiredScope;
}


export async function routeApi(request: Request, pool: Pool, connector?: ConnectorPort, runtimeClient?: RuntimeClient): Promise<Response> {
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
    params: {},
    body,
    correlationId,
    idempotencyKey: request.headers.get("idempotency-key"),
    classification,
    connector,
    runtimeClient,
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

    // GET /projects/:projectId/jobs/:jobId
    if (segments.length === 4 && segments[2] === "jobs" && method === "GET") {
      return { handler: getJobStatusHandler, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
    }

    // GET /projects/:projectId/tasks/:runId
    if (segments.length === 4 && segments[2] === "tasks" && method === "GET") {
      return { handler: getTaskHandler, params: { projectId, runId: segments[3]! }, requiredScope: "core:read" };
    }

    // POST /projects/:projectId/tasks/:runId/message | /abort (free-agent conversation)
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "message" && method === "POST") {
      return { handler: sendTaskMessageHandler, params: { projectId, runId: segments[3]! }, requiredScope: "core:write" };
    }
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "abort" && method === "POST") {
      return { handler: abortTaskHandler, params: { projectId, runId: segments[3]! }, requiredScope: "core:write" };
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
  if (isPgUniqueViolation(err)) return conflictApiError("RESOURCE_CONFLICT", null, true);
  // Real diagnostic goes only to the server log; the client gets a fixed message.
  console.error("[synthia-api] internal error:", err);
  return INTERNAL_ERROR;
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
