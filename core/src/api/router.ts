/**
 * Synthia Core API — router (IF-001 §3, §8 versioned under /api/v1)
 *
 * Parses the request, authenticates via Bearer token, parses the JSON body
 * (parse failure → 400 validation), matches the method+path to a handler,
 * enforces a coarse route scope guard, and wraps the
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
import { requireP4ProjectVisibility } from "./p4-project-access.ts";
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
import { getProjectToolSummaryHandler } from "./tool-summary.ts";
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
import { getProjectToolSummaryHandler } from "./tool-summary.ts";
import {
  abortTaskHandler,
  permissionTaskHandler,
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
import {
  adoptSideTaskHandler,
  appendTaskEventHandler,
  createSideTaskHandler,
  finalizeSideTaskResultHandler,
  getSideTaskDiffHandler,
  getSideTaskJobEvidenceContentHandler,
  getSideTaskJobEvidenceHandler,
  getSideTaskJobStatusHandler,
  getSideTaskResultHandler,
  getSideTaskWorkspaceFileHandler,
  getSideTaskWorkspaceTreeHandler,
  getTaskEventsHandler,
  submitSideTaskJobHandler,
  writeSideTaskWorkspaceFilesHandler,
} from "./side-task-handlers.ts";
import {
  approveP4GateHandler,
  confirmP4FormalInputHandler,
  confirmP4ReadinessHandler,
  createP4ChangeRequestHandler,
  createP4GateEvaluationHandler,
  createP4GateSubmissionHandler,
  freezeP4EvidenceHandler,
  getP4DeliveryContentHandler,
  getP4DeliveryManifestHandler,
  getP4DeliveryReleaseHandler,
  getP4EvidenceContentHandler,
  getP4EvidenceHandler,
  getP4FormalInputApprovalHandler,
  getP4FormalJobHandler,
  getP4ProcessProfileHandler,
  getP4ProcessStateHandler,
  getP4WorkVersionHandler,
  isModernP4Project,
  listP4BitstreamsHandler,
  listP4ChangeRequestsHandler,
  listP4DeliveryReleasesHandler,
  listP4GateEvaluationsHandler,
  listP4ReadinessHandler,
  prepareP4ReadinessHandler,
  previewP4FormalInputHandler,
  submitP4FormalJobHandler,
  submitP4GateSubmissionHandler,
  withdrawP4ChangeRequestHandler,
} from "./p4-handlers.ts";

const API_PREFIX = "/api/v1";
const CLASSIFICATIONS: Record<string, true> = { D1: true, D2: true, D3: true, D4: true, UNCLASSIFIED: true };

type Handler = (ctx: RequestContext) => Promise<HandlerResult | Response>;

/** 文件头写的 coarse route scope guard。
 *  之前 `RequiredScope` 只被引用、从没被声明过（tsc TS2304）——因为纯类型位置会被
 *  转译器擦掉，运行时不报错，于是一直没人发现；代价是下面 30 多条路由的 scope
 *  字面量实际上没被校验过。 */
type RequiredScope = "core:read" | "core:write" | "core:approve" | "core:task-runtime";
type RequiredScopeCheck = RequiredScope | readonly RequiredScope[];

interface RouteMatch {
  readonly handler: Handler;
  readonly params: Record<string, string>;
  readonly requiredScope: RequiredScopeCheck;
}

async function modernGateSubmissionDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  return await isModernP4Project(ctx.pool, ctx.params.projectId!)
    ? createP4GateSubmissionHandler(ctx)
    : createGateSubmissionHandler(ctx);
}

async function modernGateSubmitDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  return await isModernP4Project(ctx.pool, ctx.params.projectId!)
    ? submitP4GateSubmissionHandler(ctx)
    : submitGateSubmissionHandler(ctx);
}

async function modernGateApproveDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  // Deliberately dispatch by the frozen project profile before looking at the
  // feature flag.  A disabled modern P4 project must return 503 from the P4
  // handler and can never fall back to the release-less legacy approval path.
  return await isModernP4Project(ctx.pool, ctx.params.projectId!)
    ? approveP4GateHandler(ctx)
    : approveGateHandler(ctx);
}

async function formalJobDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  const body = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body as Record<string, unknown>
    : {};
  const formalIntent = body.run_class_intent === "formal";
  const modernFormal = formalIntent
    && await isModernP4Project(ctx.pool, ctx.params.projectId!);
  const taskRuntime = ctx.identity.scopes.includes("core:task-runtime");
  if (taskRuntime) {
    const exactFormalShape = typeof body.formal_input_approval_id === "string"
      && Object.keys(body).every((key) => [
        "formal_input_approval_id",
        "operation",
        "run_class_intent",
      ].includes(key));
    if (!modernFormal || !exactFormalShape) {
      throw forbiddenErrorWithRequired("core:write");
    }
  }
  if (modernFormal) {
    return submitP4FormalJobHandler(ctx);
  }
  if (taskRuntime) {
    throw forbiddenErrorWithRequired("core:write");
  }
  return submitJobHandler(ctx);
}

async function isFormalBoundJob(ctx: RequestContext): Promise<boolean> {
  const { rows } = await ctx.pool.query(
    `SELECT binding_version FROM tool_run
      WHERE id = $1 AND project_id = $2`,
    [ctx.params.jobId!, ctx.params.projectId!],
  );
  return (rows[0] as { binding_version?: string } | undefined)?.binding_version === "formal-input.v1";
}

async function jobStatusDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  return await isFormalBoundJob(ctx) ? getP4FormalJobHandler(ctx) : getJobStatusHandler(ctx);
}

async function jobEvidenceDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  return await hasP4Evidence(ctx) ? getP4EvidenceHandler(ctx) : getJobEvidenceHandler(ctx);
}

async function jobEvidenceContentDispatcher(ctx: RequestContext): Promise<HandlerResult> {
  return await hasP4Evidence(ctx) ? getP4EvidenceContentHandler(ctx) : getJobEvidenceContentHandler(ctx);
}

async function hasP4Evidence(ctx: RequestContext): Promise<boolean> {
  if (await isFormalBoundJob(ctx)) return true;
  const { rows } = await ctx.pool.query(
    `SELECT 1 FROM tool_run_evidence_manifest
      WHERE tool_run_id = $1 AND project_id = $2`,
    [ctx.params.jobId!, ctx.params.projectId!],
  );
  return rows.length > 0;
}


export async function routeApi(
  request: Request,
  pool: Pool,
  connector?: ConnectorPort,
  runtimeClient?: RuntimeClient,
  featureFlags: Readonly<CoreFeatureFlags> = DISABLED_CORE_FEATURE_FLAGS,
  runtimeActorId = "synthia-runtime",
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
    // Auth-layer crashes are the worst kind of 500 (every request fails, no
    // handler-level logging fires) — always leave a server-side trace.
    console.error("[synthia-api] authentication internal error:", err);
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
    runtimeActorId,
    featureFlags,
  };

  const match = matchRoute(ctx);
  if (!match) {
    return jsonBody(404, errorEnvelope(notFoundError(`unknown path: ${request.method} ${url.pathname}`), correlationId));
  }

  // Coarse route scope guard (B4). Modern P4 projects additionally enforce a
  // tenant boundary below before any handler or dispatcher is entered.
  const requiredScopes = Array.isArray(match.requiredScope)
    ? match.requiredScope
    : [match.requiredScope];
  if (!requiredScopes.some((scope) => identity.scopes.includes(scope))) {
    return jsonBody(403, errorEnvelope(forbiddenErrorWithRequired(match.requiredScope), correlationId));
  }

  try {
    const projectId = match.params.projectId;
    if (projectId && await isModernP4Project(pool, projectId)) {
      await requireP4ProjectVisibility(pool, identity, projectId);
    }
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
  if (
    segments.length === 3
    && segments[0] === "process-versions"
    && segments[2] === "profile"
    && ctx.method === "GET"
  ) {
    return {
      handler: getP4ProcessProfileHandler,
      params: { processVersionId: segments[1]! },
      requiredScope: "core:read",
    };
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
        case "process-state":
          if (method === "GET") return { handler: getP4ProcessStateHandler, params, requiredScope: "core:read" };
          break;
        case "readiness":
          if (method === "POST") return { handler: prepareP4ReadinessHandler, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: listP4ReadinessHandler, params, requiredScope: "core:read" };
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
          if (method === "POST") return { handler: modernGateSubmissionDispatcher, params, requiredScope: "core:write" };
          if (method === "GET") return { handler: getGateSubmissions, params, requiredScope: "core:read" };
          break;
        case "artifacts":
          if (method === "GET") return { handler: getArtifacts, params, requiredScope: "core:read" };
          break;
        case "tool-summary":
          if (method === "GET") return { handler: getProjectToolSummaryHandler, params, requiredScope: "core:read" };
          break;
        case "jobs":
          if (method === "POST") {
            const body = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
              ? ctx.body as Record<string, unknown>
              : {};
            return {
              handler: formalJobDispatcher,
              params,
              requiredScope: body.run_class_intent === "formal"
                ? ["core:write", "core:task-runtime"]
                : "core:write",
            };
          }
          if (method === "GET") return { handler: listJobsHandler, params, requiredScope: "core:read" };
          break;
        case "bitstreams":
          if (method === "GET") return { handler: listP4BitstreamsHandler, params, requiredScope: "core:read" };
          break;
        case "delivery-releases":
          if (method === "GET") return { handler: listP4DeliveryReleasesHandler, params, requiredScope: "core:read" };
          break;
        case "change-requests":
          if (method === "POST") return { handler: createP4ChangeRequestHandler, params, requiredScope: "core:approve" };
          if (method === "GET") return { handler: listP4ChangeRequestsHandler, params, requiredScope: "core:read" };
          break;
        case "tasks":
          if (method === "POST") {
            const body = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
              ? ctx.body as Record<string, unknown>
              : {};
            return {
              handler: body.kind === "side" ? createSideTaskHandler : createTaskHandler,
              params,
              requiredScope: "core:write",
            };
          }
          if (method === "GET") return { handler: listTasksHandler, params, requiredScope: "core:read" };
          break;
      }
    }

    // GET /projects/:projectId/gate-submissions/:subId
    if (segments.length === 4 && segments[2] === "gate-submissions" && method === "GET") {
      return { handler: getGateSubmissionHandler, params: { projectId, subId: segments[3]! }, requiredScope: "core:read" };
    }

    if (
      segments.length === 5
      && segments[2] === "readiness"
      && segments[4] === "confirm"
      && method === "POST"
    ) {
      return {
        handler: confirmP4ReadinessHandler,
        params: { projectId, readinessId: segments[3]! },
        requiredScope: "core:approve",
      };
    }

    if (segments.length === 4 && segments[2] === "formal-input-approvals") {
      if (segments[3] === "preview" && method === "POST") {
        return { handler: previewP4FormalInputHandler, params: { projectId }, requiredScope: "core:write" };
      }
      if (method === "GET") {
        return {
          handler: getP4FormalInputApprovalHandler,
          params: { projectId, formalInputApprovalId: segments[3]! },
          requiredScope: "core:read",
        };
      }
    }
    if (segments.length === 3 && segments[2] === "formal-input-approvals" && method === "POST") {
      return { handler: confirmP4FormalInputHandler, params: { projectId }, requiredScope: "core:approve" };
    }

    if (segments.length === 4 && segments[2] === "delivery-releases" && method === "GET") {
      return {
        handler: getP4DeliveryReleaseHandler,
        params: { projectId, releaseId: segments[3]! },
        requiredScope: "core:read",
      };
    }
    if (segments.length === 5 && segments[2] === "delivery-releases" && method === "GET") {
      const params = { projectId, releaseId: segments[3]! };
      if (segments[4] === "manifest") {
        return { handler: getP4DeliveryManifestHandler, params, requiredScope: "core:read" };
      }
      if (segments[4] === "content") {
        return { handler: getP4DeliveryContentHandler, params, requiredScope: "core:read" };
      }
    }

    if (segments.length === 4 && segments[2] === "work-versions" && method === "GET") {
      return {
        handler: getP4WorkVersionHandler,
        params: { projectId, workVersionId: segments[3]! },
        requiredScope: "core:read",
      };
    }
    if (
      segments.length === 5
      && segments[2] === "change-requests"
      && segments[4] === "withdraw"
      && method === "POST"
    ) {
      return {
        handler: withdrawP4ChangeRequestHandler,
        params: { projectId, changeRequestId: segments[3]! },
        requiredScope: "core:approve",
      };
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
      return { handler: jobStatusDispatcher, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
    }

    // GET /projects/:projectId/tasks/:agentId
    if (segments.length === 4 && segments[2] === "tasks" && method === "GET") {
      return { handler: getTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:read" };
    }

    // P3 Core-owned task facts and sealed side-task results.
    if (segments.length === 5 && segments[2] === "tasks") {
      const params = { projectId, taskId: segments[3]! };
      if (segments[4] === "events") {
        if (method === "GET") return { handler: getTaskEventsHandler, params, requiredScope: "core:read" };
        if (method === "POST") return { handler: appendTaskEventHandler, params, requiredScope: "core:task-runtime" };
      }
      if (segments[4] === "result") {
        if (method === "GET") return { handler: getSideTaskResultHandler, params, requiredScope: "core:read" };
        if (method === "POST") return { handler: finalizeSideTaskResultHandler, params, requiredScope: "core:task-runtime" };
      }
      if (segments[4] === "diff" && method === "GET") {
        return { handler: getSideTaskDiffHandler, params, requiredScope: "core:read" };
      }
      if (segments[4] === "adoptions" && method === "POST") {
        return { handler: adoptSideTaskHandler, params, requiredScope: "core:write" };
      }
      if (segments[4] === "jobs" && method === "POST") {
        return { handler: submitSideTaskJobHandler, params, requiredScope: "core:task-runtime" };
      }
    }

    // Runtime-only task-scoped job polling and evidence.  These routes never
    // grant the task token access to the generic project job surface.
    if (segments.length >= 6 && segments[2] === "tasks" && segments[4] === "jobs") {
      const params = { projectId, taskId: segments[3]!, jobId: segments[5]! };
      if (segments.length === 6 && method === "GET") {
        return { handler: getSideTaskJobStatusHandler, params, requiredScope: "core:task-runtime" };
      }
      if (segments.length === 7 && segments[6] === "evidence" && method === "GET") {
        return { handler: getSideTaskJobEvidenceHandler, params, requiredScope: "core:task-runtime" };
      }
      if (
        segments.length === 8
        && segments[6] === "evidence"
        && segments[7] === "content"
        && method === "GET"
      ) {
        return { handler: getSideTaskJobEvidenceContentHandler, params, requiredScope: "core:task-runtime" };
      }
    }

    // Runtime-only task-scoped isolated workspace.
    if (segments.length === 6 && segments[2] === "tasks" && segments[4] === "workspace") {
      const params = { projectId, taskId: segments[3]! };
      if (segments[5] === "tree" && method === "GET") {
        return { handler: getSideTaskWorkspaceTreeHandler, params, requiredScope: "core:task-runtime" };
      }
      if (segments[5] === "file" && method === "GET") {
        return { handler: getSideTaskWorkspaceFileHandler, params, requiredScope: "core:task-runtime" };
      }
      if (segments[5] === "files" && method === "POST") {
        return { handler: writeSideTaskWorkspaceFilesHandler, params, requiredScope: "core:task-runtime" };
      }
    }

    // POST /projects/:projectId/tasks/:agentId/message | /abort (free-agent conversation)
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "message" && method === "POST") {
      return { handler: sendTaskMessageHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:write" };
    }
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "abort" && method === "POST") {
      return { handler: abortTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:write" };
    }
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "permission" && method === "POST") {
      return { handler: permissionTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:write" };
    }

    // GET /projects/:projectId/tasks/:agentId/stream — SSE pass-through (raw Response)
    if (segments.length === 5 && segments[2] === "tasks" && segments[4] === "stream" && method === "GET") {
      return { handler: streamTaskHandler, params: { projectId, agentId: segments[3]! }, requiredScope: "core:read" };
    }

    // GET /projects/:projectId/jobs/:jobId/evidence
    if (segments.length === 5 && segments[2] === "jobs" && segments[4] === "evidence" && method === "GET") {
      return { handler: jobEvidenceDispatcher, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
    }

    if (
      segments.length === 6
      && segments[2] === "jobs"
      && segments[4] === "evidence"
      && segments[5] === "freeze"
      && method === "POST"
    ) {
      return {
        handler: freezeP4EvidenceHandler,
        params: { projectId, jobId: segments[3]! },
        requiredScope: "core:write",
      };
    }

    // GET /projects/:projectId/jobs/:jobId/evidence/content?name=<name>
    if (segments.length === 6 && segments[2] === "jobs" && segments[4] === "evidence" && segments[5] === "content" && method === "GET") {
      return { handler: jobEvidenceContentDispatcher, params: { projectId, jobId: segments[3]! }, requiredScope: "core:read" };
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
    if (
      segments.length === 5
      && segments[2] === "gate-submissions"
      && segments[4] === "evaluations"
    ) {
      const params = { projectId, subId: segments[3]! };
      if (method === "POST") {
        return { handler: createP4GateEvaluationHandler, params, requiredScope: "core:write" };
      }
      if (method === "GET") {
        return { handler: listP4GateEvaluationsHandler, params, requiredScope: "core:read" };
      }
    }

    if (segments.length === 5 && segments[2] === "gate-submissions" && segments[4] === "approve" && method === "POST") {
      return { handler: modernGateApproveDispatcher, params: { projectId, subId: segments[3]! }, requiredScope: "core:approve" };
    }

    // /projects/:projectId/gate-submissions/:subId/submit
    if (segments.length === 5 && segments[2] === "gate-submissions" && segments[4] === "submit" && method === "POST") {
      return { handler: modernGateSubmitDispatcher, params: { projectId, subId: segments[3]! }, requiredScope: "core:write" };
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
function forbiddenErrorWithRequired(scope: RequiredScopeCheck): ApiError {
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
