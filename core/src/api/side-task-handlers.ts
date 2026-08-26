/**
 * P3 isolated side tasks. Core owns task/event/result/adoption facts; Runtime
 * can access an isolated workspace only through task-bound service endpoints.
 */
import { randomUUID } from "node:crypto";
import {
  claimIdempotencySlot,
  completeIdempotencySlot,
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import { canonicalRequestHash, sha256Hex } from "../hashing.ts";
import type { SourceInput } from "./connector-port.ts";
import { git, gitRaw, headSha } from "../workspace/git.ts";
import { WorkspaceError, isRegisterablePath, validateWorkspacePath } from "../workspace/paths.ts";
import {
  createIsolatedTaskWorkspace,
  currentProjectFile,
  readTaskWorkspaceFile,
  readTaskWorkspaceTree,
  snapshotTaskWorkspace,
  writeTaskWorkspaceFiles,
  type TaskWorkspaceChange,
} from "../workspace/task-store.ts";
import { ensureWorkspace, readTreeAt, writeAndCommit } from "../workspace/store.ts";
import {
  capabilityUnavailableError,
  conflictApiError,
  forbiddenError,
  internalError,
  notFoundError,
  validationError,
} from "./errors.ts";
import {
  asObject,
  getJobEvidenceContentHandler,
  getJobEvidenceHandler,
  getJobStatusHandler,
  mapConnectorError,
  outboxEvent,
  requireConnector,
  runIdempotent,
  type HandlerResult,
  type RequestContext,
} from "./handlers.ts";
import {
  mapRuntimeError,
  requireConfiguredRuntimeActor,
  requireRuntime,
  type RuntimeCreateResponse,
} from "./task-proxy.ts";
import { reconcileIntoRevisions } from "./workspace-handlers.ts";
import {
  acquireP4ProjectMutationSessionLock,
  isModernP4Project,
  releaseP4ProjectMutationSessionLock,
  requireP4ChangeWorkVersion,
} from "./p4-write-guard.ts";

const MAX_FILES_PER_WRITE = 32;
const MAX_AUTHORIZED_WRITE_PATHS = 32;
const MAX_SIDE_TASK_PATH_BYTES = 512;
const MAX_SIDE_TASK_PATH_SEGMENTS = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const EVENT_KINDS = new Set(["user_message", "assistant_message", "tool_call", "tool_result", "status"]);
const TASK_JOB_OPERATIONS = new Set(["validate_sources", "simulate", "synthesize", "implement"]);

interface SideAuthorizationScope {
  readonly schema: "task-scope.v1";
  readonly workspace: "isolated";
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly run_classes: readonly ["exploratory"];
  readonly can_submit_gates: false;
  readonly can_create_milestones: false;
  readonly can_start_formal_runs: false;
}

const SIDE_TASK_READ_PATHS = Object.freeze([
  "rtl/**",
  "tb/**",
  "doc/**",
  "prj/constr/**",
] as const);

const SIDE_AUTHORIZATION_KEYS = new Set([
  "schema",
  "workspace",
  "read_paths",
  "write_paths",
  "run_classes",
  "can_submit_gates",
  "can_create_milestones",
  "can_start_formal_runs",
]);

interface SideTaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_type: "free" | "engineering";
  readonly kind: "side";
  readonly agent_role: "side";
  readonly parent_task_id: string;
  readonly workspace_id: string;
  readonly runtime_agent_id: string | null;
  readonly runtime_actor_id: string | null;
  readonly objective: string;
  readonly authorization_scope: SideAuthorizationScope;
  readonly status: "queued" | "running" | "awaiting_user" | "succeeded" | "failed" | "cancelled" | "fail_closed";
  readonly input_hash: string;
  readonly output_hash: string | null;
  readonly adoption_state: "pending" | "available" | "partially_adopted" | "adopted" | "discarded";
  readonly runtime_snapshot: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly finished_at: Date | string | null;
}

interface AgentTaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: "main" | "side";
  readonly agent_role: "project" | "run" | "side";
  readonly workspace_id: string | null;
  readonly runtime_agent_id: string | null;
  readonly runtime_actor_id: string | null;
  readonly status: "queued" | "running" | "awaiting_user" | "succeeded" | "failed" | "cancelled" | "fail_closed";
  readonly adoption_state: string;
  readonly output_hash: string | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly state: "provisioning" | "active" | "sealed" | "failed" | "released";
  readonly base_commit: string;
  readonly base_manifest_hash: string;
  readonly head_commit: string | null;
}

interface TaskResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly base_commit: string;
  readonly result_commit: string;
  readonly summary: string;
  readonly tests: unknown;
  readonly manifest: unknown;
  readonly output_hash: string;
  readonly created_at: Date | string;
}

interface WorkspaceFileRow {
  readonly id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly path: string;
  readonly artifact_type: string;
  readonly change_kind: "added" | "modified";
  readonly base_content_hash: string | null;
  readonly content_hash: string;
  readonly content_text: string;
  readonly size_bytes: number | string;
  readonly workspace_commit: string;
  readonly version: number;
}

interface AdoptionSelection {
  readonly path: string;
  readonly expected_base_hash: string | null;
  readonly expected_proposed_hash: string;
  readonly expected_target_hash: string | null;
}

interface AdoptionRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly result_id: string;
  readonly state: "applying" | "applied" | "conflicted" | "failed";
  readonly selection_hash: string;
  readonly project_commit_before: string;
  readonly project_commit_after: string | null;
  readonly reason: string;
  readonly details: unknown;
  readonly created_by: string;
}

export async function createSideTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireSideTaskWrites(ctx);
  if (ctx.identity.actorType !== "human") throw forbiddenError("SIDE_TASK_CREATE_REQUIRES_HUMAN");
  const runtime = requireRuntime(ctx);
  const projectId = ctx.params.projectId!;
  const body = asObject(ctx.body);
  if (body.kind !== "side") throw validationError("field 'kind' must be 'side'");
  const parentTaskId = requiredString(body, "parent_task_id");
  const objective = requiredString(body, body.objective !== undefined ? "objective" : "task").trim();
  if (!objective) throw validationError("field 'objective' must not be blank");
  const requestedBaseCommit = requiredCommit(body.base_commit, "base_commit");
  const authorizationScope = parseAuthorizationScope(body.authorization_scope);
  const taskId = stableResourceId("task", ctx, projectId, "side");
  const workspaceId = `ws-${taskId.slice(5)}`;

  const write = await runIdempotent(ctx, `create_side_task:${parentTaskId}`, projectId, async (tx) => {
    await requireProjectAccess(ctx, tx, projectId);
    await requireConfiguredRuntimeActor(ctx, tx);
    const parentResult = await tx.query(
      `SELECT t.id,t.kind,t.agent_role,t.status,p.project_type,p.status AS project_status,
              p.target_part,p.process_version_id,p.process_profile_id,
              p.process_profile_name,p.process_profile_version
         FROM agent_task t JOIN project p ON p.id=t.project_id
        WHERE t.id=$1 AND t.project_id=$2 FOR UPDATE OF t,p`,
      [parentTaskId, projectId],
    );
    const parent = parentResult.rows[0] as {
      id: string;
      kind: string;
      agent_role: string;
      status: string;
      project_type: "free" | "engineering";
      project_status: string;
      target_part: string | null;
      process_version_id: string | null;
      process_profile_id: string | null;
      process_profile_name: string | null;
      process_profile_version: string | null;
    } | undefined;
    if (!parent || parent.kind !== "main" || parent.agent_role !== "project") {
      throw notFoundError(`active main task not found: ${parentTaskId}`);
    }
    if (parent.project_status !== "active") throw conflictApiError("PROJECT_NOT_ACTIVE", { projectId });

    const workspace = await createIsolatedTaskWorkspace(projectId, workspaceId, requestedBaseCommit);
    const inputHash = canonicalRequestHash({
      schema: "task-input.v1",
      projectId,
      kind: "side",
      parentTaskId,
      objective,
      baseCommit: workspace.baseCommit,
      baseManifestHash: workspace.baseManifestHash,
      authorizationScope,
    });
    const now = new Date().toISOString();
    await tx.query(
      `INSERT INTO agent_task
         (id,project_id,project_type,kind,agent_role,parent_task_id,workspace_id,process_instance_id,
          runtime_actor_id,objective,authorization_scope,status,input_hash,adoption_state,
          created_by_type,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,'side','side',$4,$5,NULL,$6,$7,$8::jsonb,'queued',$9,'pending',$10,$11,$12,$12)`,
      [
        taskId,
        projectId,
        parent.project_type,
        parentTaskId,
        workspaceId,
        ctx.runtimeActorId,
        objective,
        JSON.stringify(authorizationScope),
        inputHash,
        ctx.identity.actorType,
        ctx.identity.actorId,
        now,
      ],
    );
    await tx.query(
      `INSERT INTO task_workspace
         (id,task_id,project_id,state,storage_key,base_commit,base_manifest_hash,head_commit,created_at)
       VALUES ($1,$2,$3,'active',$1,$4,$5,$4,$6)`,
      [workspaceId, taskId, projectId, workspace.baseCommit, workspace.baseManifestHash, now],
    );

    const runtimeRequest = {
        task_id: taskId,
        task_kind: "side",
        execution_intent: "side_agent",
        parent_task_id: parentTaskId,
        workspace_id: workspaceId,
        authorization_scope: authorizationScope as unknown as Readonly<Record<string, unknown>>,
        input_hash: inputHash,
        project_id: projectId,
        task: objective,
        mode: "agent",
        project_type: parent.project_type,
        ...(parent.target_part ? { part: parent.target_part } : {}),
        ...(parent.process_version_id ? { process_version_id: parent.process_version_id } : {}),
        ...(parent.process_profile_id ? { process_profile_id: parent.process_profile_id } : {}),
        ...(parent.process_profile_name ? { process_profile_name: parent.process_profile_name } : {}),
        ...(parent.process_profile_version ? { process_profile_version: parent.process_profile_version } : {}),
      } as const;
    await insertConversationEvent(tx, {
      id: `te-${canonicalRequestHash({ taskId, objective }).slice(0, 40)}`,
      projectId,
      taskId,
      eventKind: "user_message",
      payload: { text: objective, source: "side_task_objective" },
      actorType: ctx.identity.actorType,
      actorId: ctx.identity.actorId,
    });
    await appendOutbox(tx, ctx, taskId, "side_task.created", {
      taskId,
      projectId,
      parentTaskId,
      workspaceId,
      inputHash,
    });
    return { taskId, runtimeRequest };
  }, (tx) => requireProjectAccess(ctx, tx, projectId));

  // The database transaction above is the durable boundary. Every replay
  // drives the idempotent Runtime register/bind/start sequence again, repairing
  // crashes after Core commit without duplicating the model prompt.
  let response: RuntimeCreateResponse;
  try {
    response = await runtime.createTask(write.result.runtimeRequest);
  } catch (error) {
    throw mapRuntimeError(error);
  }
  if (response.agent_id !== write.result.taskId) {
    throw conflictApiError("RUNTIME_TASK_ID_MISMATCH", {
      expected: write.result.taskId,
      received: response.agent_id,
    });
  }
  const bound = await ctx.pool.query(
    `UPDATE agent_task
        SET runtime_agent_id=$3,
            runtime_snapshot=runtime_snapshot || $4::jsonb,
            updated_at=now()
      WHERE id=$1 AND project_id=$2
        AND (runtime_agent_id IS NULL OR runtime_agent_id=$3)
        AND runtime_actor_id=$5
      RETURNING id`,
    [
      write.result.taskId,
      projectId,
      response.agent_id,
      JSON.stringify({
        agent_id: write.result.taskId,
        project_id: projectId,
        kind: "side",
        parent_task_id: parentTaskId,
        workspace_id: workspaceId,
        registered: true,
      }),
      ctx.runtimeActorId,
    ],
  );
  if (bound.rows.length === 0) {
    const current = await loadSideTask(ctx.pool, projectId, write.result.taskId);
    throw conflictApiError("RUNTIME_TASK_BINDING_CONFLICT", {
      taskId: write.result.taskId,
      expected: current.runtime_agent_id,
      received: response.agent_id,
      expectedActor: current.runtime_actor_id,
      receivedActor: ctx.runtimeActorId,
    });
  }
  let started;
  try {
    started = await runtime.startTask(response.agent_id);
  } catch (error) {
    throw mapRuntimeError(error);
  }
  if (!started.started && started.reason !== "already_started") {
    throw conflictApiError("RUNTIME_TASK_NOT_STARTED", {
      taskId: write.result.taskId,
      status: started.status,
      reason: started.reason ?? null,
    });
  }
  if (started.status === "failed" || started.status === "fail_closed" || started.status === "cancelled") {
    const terminal = started.status === "cancelled" ? "cancelled" : started.status;
    await ctx.pool.query(
      `UPDATE agent_task
          SET status=$3,adoption_state='discarded',finished_at=now(),updated_at=now(),
              runtime_snapshot=runtime_snapshot || $4::jsonb
        WHERE id=$1 AND project_id=$2 AND status IN ('queued','running','awaiting_user')`,
      [
        write.result.taskId,
        projectId,
        terminal,
        JSON.stringify({ status: terminal, reason: "Runtime reports an already-started terminal task" }),
      ],
    );
  }
  // Runtime normally persists running before returning. This guarded update is
  // only a fallback for adapters/tests that do not issue the callback; it never
  // moves a more advanced Core fact backwards.
  await ctx.pool.query(
    "UPDATE agent_task SET status='running',updated_at=now() WHERE id=$1 AND project_id=$2 AND status='queued'",
    [write.result.taskId, projectId],
  );

  const task = await loadSideTask(ctx.pool, projectId, write.result.taskId);
  const workspace = await loadWorkspace(ctx.pool, projectId, task);
  return { status: 201, data: sideTaskPayload(task, workspace) };
}

export async function getTaskEventsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const taskResult = await ctx.pool.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2",
    [taskId, projectId],
  );
  const task = taskResult.rows[0] as AgentTaskRow | undefined;
  if (!task) throw notFoundError(`task not found: ${taskId}`);
  if (ctx.identity.actorType === "service") {
    requireRuntimeTaskBinding(ctx, task);
  } else {
    await requireProjectReadable(ctx, projectId);
  }
  const afterRaw = ctx.url.searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(afterRaw)) throw validationError("query parameter 'after' must be a non-negative integer");
  const after = Number(afterRaw);
  const { rows } = await ctx.pool.query(
    `SELECT id,sequence,event_kind,payload,payload_hash,actor_type,actor_id,created_at
       FROM task_conversation_event
      WHERE task_id=$1 AND project_id=$2 AND sequence>$3
      ORDER BY sequence ASC LIMIT 500`,
    [taskId, projectId, after],
  );
  return {
    status: 200,
    data: {
      task_id: taskId,
      events: rows.map((row) => ({ ...row, sequence: Number((row as { sequence: string | number }).sequence) })),
      next_after: rows.length > 0 ? Number((rows.at(-1) as { sequence: string | number }).sequence) : after,
    },
  };
}

export async function getSideTaskWorkspaceTreeHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const task = await loadSideTask(ctx.pool, projectId, taskParam(ctx));
  requireRuntimeBinding(ctx, task);
  const workspace = await loadWorkspace(ctx.pool, projectId, task);
  if (workspace.state !== "active") throw conflictApiError("SIDE_TASK_WORKSPACE_NOT_ACTIVE", { state: workspace.state });
  const tree = await readTaskWorkspaceTree(projectId, task.workspace_id);
  return {
    status: 200,
    data: {
      project_id: projectId,
      task_id: task.id,
      workspace_id: task.workspace_id,
      commit: tree.commit,
      isolated: true,
      files: tree.files.filter((file) => isAuthorizedReadPath(task, file.path)).map((file) => ({
        path: file.path,
        content_hash: file.content_hash,
        bytes: file.size_bytes,
      })),
    },
  };
}

export async function getSideTaskWorkspaceFileHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const task = await loadSideTask(ctx.pool, projectId, taskParam(ctx));
  requireRuntimeBinding(ctx, task);
  const workspace = await loadWorkspace(ctx.pool, projectId, task);
  if (workspace.state !== "active") throw conflictApiError("SIDE_TASK_WORKSPACE_NOT_ACTIVE", { state: workspace.state });
  const rawPath = ctx.url.searchParams.get("path");
  if (!rawPath) throw validationError("query parameter 'path' is required");
  const path = validateWorkspacePath(rawPath);
  requireAuthorizedReadPath(task, path);
  const file = await readTaskWorkspaceFile(projectId, task.workspace_id, path);
  return {
    status: 200,
    data: {
      path: file.path,
      content: file.content,
      content_hash: file.contentHash,
      commit: file.commit,
      workspace_id: task.workspace_id,
      isolated: true,
      adopted: false,
    },
  };
}

export async function writeSideTaskWorkspaceFilesHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireSideTaskWrites(ctx);
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const body = asObject(ctx.body);
  const files = parseFiles(body.files);
  const reason = optionalTrimmed(body.change_reason) || "side task workspace update";
  const write = await runIdempotent(ctx, `write_task_workspace:${taskId}`, projectId, async (tx) => {
    const task = await requireActiveSideTask(tx, projectId, taskId);
    requireRuntimeBinding(ctx, task);
    const workspace = await lockWorkspace(tx, projectId, task);
    if (workspace.state !== "active") throw conflictApiError("SIDE_TASK_WORKSPACE_NOT_ACTIVE", { state: workspace.state });
    for (const file of files) requireAuthorizedPath(task, file.path);
    const outcome = await writeTaskWorkspaceFiles(
      projectId,
      task.workspace_id,
      files,
      `${reason}\n\ntask: ${task.id}`,
      gitAuthor(ctx.identity.actorId),
    );
    await tx.query(
      "UPDATE task_workspace SET head_commit=$3 WHERE id=$1 AND project_id=$2 AND state='active'",
      [task.workspace_id, projectId, outcome.commit],
    );
    const returned: Record<string, unknown>[] = [];
    for (const file of files) {
      const current = await readTaskWorkspaceFile(projectId, task.workspace_id, file.path);
      returned.push({ path: file.path, content_hash: current.contentHash });
    }
    return {
      task_id: task.id,
      workspace_id: task.workspace_id,
      commit: outcome.commit,
      committed: outcome.changed,
      registered: returned.filter((file) => outcome.changed.includes(String(file.path))),
      unchanged: returned.filter((file) => !outcome.changed.includes(String(file.path))),
      isolated: true,
    };
  }, (tx) => authorizeRuntimeTaskWrite(ctx, tx, projectId, taskId, false));
  return { status: 200, data: write.result };
}

export async function submitSideTaskJobHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireSideTaskWrites(ctx);
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const body = asObject(ctx.body);
  const operation = requiredString(body, "operation");
  if (!TASK_JOB_OPERATIONS.has(operation)) throw validationError("unsupported job operation");
  const sources = parseTaskJobSources(body.sources, "sources", true);
  const constraints = parseTaskJobSources(body.constraints, "constraints", false);
  const top = optionalJobString(body.top, "top");
  const testbench = optionalJobString(body.testbench, "testbench");
  const part = optionalJobString(body.part, "part");
  const timeoutMs = optionalJobTimeout(body.timeout_ms);
  const connector = requireConnector(ctx);
  const dispatch = stableSideTaskJobDispatch(ctx, projectId, taskId);

  const write = await runIdempotent(ctx, `submit_side_task_job:${taskId}`, projectId, async (tx) => {
    const task = await requireActiveSideTask(tx, projectId, taskId);
    requireRuntimeBinding(ctx, task);
    const workspace = await lockWorkspace(tx, projectId, task);
    if (workspace.state !== "active") {
      throw conflictApiError("SIDE_TASK_WORKSPACE_NOT_ACTIVE", { state: workspace.state });
    }
    for (const file of [...sources, ...constraints]) {
      requireAuthorizedReadPath(task, file.path);
      const isolated = await readTaskWorkspaceFile(projectId, task.workspace_id, file.path);
      if (isolated.content !== file.content) {
        throw conflictApiError("SIDE_TASK_JOB_SOURCE_STALE", {
          path: file.path,
          expected: isolated.contentHash,
        });
      }
    }

    // Connector submission is an external side effect. If it accepts the job
    // and the response is lost, this database transaction rolls back. Derive
    // every downstream identity from Core's idempotency scope so a retry sends
    // an identical request and reattaches to the already-accepted job.
    const jobId = dispatch.jobId;
    const runClass = "exploratory" as const;
    const inputManifestHash = canonicalRequestHash({
      schema: "side-task-job.v1",
      projectId,
      taskId,
      workspaceId: task.workspace_id,
      workspaceCommit: workspace.head_commit,
      operation,
      sources,
      constraints,
      top,
      testbench,
      part,
      timeoutMs,
      runClass,
    });
    const parameters = {
      operation,
      jobId,
      projectId,
      taskId,
      workspaceId: task.workspace_id,
      workspaceCommit: workspace.head_commit,
      runClass,
      sources,
      constraints,
      top,
      testbench,
      part,
      timeoutMs,
    };
    await tx.query(
      `INSERT INTO tool_run
         (id,project_id,operation,capability_version,run_class,state,input_manifest_hash,
          authorization_context,parameters,connector_id,correlation_id)
       VALUES ($1,$2,$3,'v1','exploratory','submitted',$4,'{}'::jsonb,$5::jsonb,$6,$7)`,
      [
        jobId,
        projectId,
        operation,
        inputManifestHash,
        JSON.stringify(parameters),
        connector.connectorId,
        dispatch.correlationId,
      ],
    );
    await outboxEvent(tx, ctx, { type: "tool_run", id: jobId }, "tool_run.submitted", {
      jobId,
      projectId,
      taskId,
      workspaceId: task.workspace_id,
      operation,
      runClass,
      state: "submitted",
    });
    try {
      await connector.submitJob({
        jobId,
        projectId,
        operation,
        runClass,
        idempotencyKey: dispatch.idempotencyKey,
        correlationId: dispatch.correlationId,
        inputHash: inputManifestHash,
        actor: { actorType: ctx.identity.actorType, actorId: ctx.identity.actorId },
        parameters: {
          sources,
          constraints,
          ...(top ? { top } : {}),
          ...(testbench ? { testbench } : {}),
          ...(part ? { part } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      });
    } catch (error) {
      throw mapConnectorError(error);
    }
    return {
      jobId,
      runClass,
      state: "submitted",
      task_id: taskId,
      workspace_id: task.workspace_id,
    };
  }, (tx) => authorizeRuntimeTaskWrite(ctx, tx, projectId, taskId, true));
  return { status: 201, data: write.result };
}

/**
 * Runtime-only task-scoped job reads.  The generic handlers remain the single
 * implementation for Connector polling and evidence persistence; this guard
 * proves the job belongs to the authenticated task capability before any of
 * those observable or mutating Connector operations can run.
 */
export async function getSideTaskJobStatusHandler(ctx: RequestContext): Promise<HandlerResult> {
  await authorizeRuntimeTaskJobRead(ctx);
  return getJobStatusHandler(ctx);
}

export async function getSideTaskJobEvidenceHandler(ctx: RequestContext): Promise<HandlerResult> {
  await authorizeRuntimeTaskJobRead(ctx);
  return getJobEvidenceHandler(ctx);
}

export async function getSideTaskJobEvidenceContentHandler(ctx: RequestContext): Promise<HandlerResult> {
  await authorizeRuntimeTaskJobRead(ctx);
  return getJobEvidenceContentHandler(ctx);
}

export async function appendTaskEventHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const body = asObject(ctx.body);
  const eventId = requiredResourceId(body.event_id, "event_id");
  const eventKind = requiredString(body, body.type !== undefined ? "type" : "event_kind");
  if (!EVENT_KINDS.has(eventKind)) throw validationError("unsupported task event type");
  const payload = asObject(body.payload);
  const requestedSequence = body.sequence === undefined ? null : positiveInteger(body.sequence, "sequence");
  const write = await runIdempotent(ctx, `append_task_event:${taskId}:${eventId}`, projectId, async (tx) => {
    const task = await lockAgentTask(tx, projectId, taskId);
    requireTaskEventFeature(ctx, task);
    requireRuntimeTaskBinding(ctx, task);
    const existing = await tx.query(
      "SELECT sequence,event_kind,payload_hash FROM task_conversation_event WHERE id=$1 AND project_id=$2",
      [eventId, projectId],
    );
    const payloadHash = canonicalRequestHash(payload);
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { sequence: number | string; event_kind: string; payload_hash: string };
      if (
        row.event_kind !== eventKind
        || row.payload_hash !== payloadHash
        || (requestedSequence !== null && Number(row.sequence) !== requestedSequence)
      ) {
        throw conflictApiError("TASK_EVENT_REPLAY_MISMATCH", { eventId });
      }
      return { task_id: taskId, event_id: eventId, sequence: Number(row.sequence), replayed: true };
    }
    const next = await nextEventSequence(tx, taskId);
    if (requestedSequence !== null && requestedSequence !== next) {
      throw conflictApiError("TASK_EVENT_SEQUENCE_CONFLICT", { expected: next, received: requestedSequence });
    }
    await insertConversationEvent(tx, {
      id: eventId,
      projectId,
      taskId,
      sequence: next,
      eventKind,
      payload,
      actorType: ctx.identity.actorType,
      actorId: ctx.identity.actorId,
    });
    if (eventKind === "status") await applyRuntimeStatus(tx, task, payload);
    return { task_id: taskId, event_id: eventId, sequence: next, replayed: false };
  }, (tx) => authorizeRuntimeTaskEvent(ctx, tx, projectId, taskId));
  return { status: 201, data: write.result };
}

async function recordedSideTaskTests(
  tx: TransactionClient,
  projectId: string,
  taskId: string,
  workspaceId: string,
): Promise<readonly Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT id,operation,state,error_code
      FROM tool_run
      WHERE project_id=$1
        AND parameters->>'taskId'=$2
        AND parameters->>'workspaceId'=$3
        AND run_class='exploratory'
        AND parameters->>'runClass'='exploratory'
      ORDER BY created_at,id`,
    [projectId, taskId, workspaceId],
  );
  return (rows as Array<{
    id: string;
    operation: string;
    state: string;
    error_code: string | null;
  }>).map((row) => {
    const status = row.state === "succeeded"
      ? "passed"
      : new Set([
          "rejected",
          "failed",
          "cancelled",
          "timeout",
          "lost",
          "unknown_effect",
        ]).has(row.state)
        ? "failed"
        : "unknown";
    return {
      name: `${row.operation} (${row.id})`,
      status,
      detail: row.error_code ?? `Core tool run state: ${row.state}`,
      job_id: row.id,
      operation: row.operation,
      state: row.state,
    };
  });
}

export async function finalizeSideTaskResultHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireSideTaskWrites(ctx);
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const body = asObject(ctx.body);
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  if (body.tests !== undefined && !Array.isArray(body.tests)) {
    throw validationError("field 'tests' must be an array");
  }
  const write = await runIdempotent(ctx, `finalize_task_result:${taskId}`, projectId, async (tx) => {
    const task = await lockSideTask(tx, projectId, taskId);
    requireRuntimeBinding(ctx, task);
    if (task.status !== "running" && task.status !== "awaiting_user") {
      throw conflictApiError("SIDE_TASK_NOT_FINALIZABLE", { taskId, status: task.status });
    }
    const workspace = await lockWorkspace(tx, projectId, task);
    if (workspace.state !== "active") throw conflictApiError("SIDE_TASK_WORKSPACE_NOT_ACTIVE", { state: workspace.state });
    const already = await tx.query("SELECT id FROM task_result WHERE task_id=$1 AND project_id=$2", [taskId, projectId]);
    if (already.rows.length > 0) throw conflictApiError("SIDE_TASK_RESULT_ALREADY_FINALIZED", { taskId });
    // Tests are Core-owned facts derived from tool runs bound to this exact
    // task/workspace. Runtime-provided summaries are never trusted as evidence.
    const tests = await recordedSideTaskTests(tx, projectId, taskId, task.workspace_id);
    const snapshot = await snapshotTaskWorkspace(projectId, task.workspace_id, workspace.base_commit, {
      taskId,
      workspaceId: task.workspace_id,
      summary,
      tests,
    });
    for (const change of snapshot.changes) requireAuthorizedPath(task, change.path);
    const resultId = `result-${canonicalRequestHash({ taskId, outputHash: snapshot.output_hash }).slice(0, 32)}`;
    for (const change of snapshot.changes) {
      await tx.query(
        `INSERT INTO task_workspace_file
           (id,task_id,project_id,workspace_id,path,artifact_type,change_kind,
            base_content_hash,content_hash,content_text,size_bytes,workspace_commit,version,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,now())`,
        [
          workspaceFileId(taskId, change),
          taskId,
          projectId,
          task.workspace_id,
          change.path,
          artifactTypeForPath(change.path),
          change.change_kind,
          change.base_hash,
          change.result_hash,
          change.result_content,
          change.size_bytes,
          snapshot.result_commit,
        ],
      );
    }
    await tx.query(
      `INSERT INTO task_result
         (id,project_id,task_id,workspace_id,base_commit,result_commit,summary,tests,
          manifest,output_hash,created_by_type,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,now())`,
      [
        resultId,
        projectId,
        taskId,
        task.workspace_id,
        snapshot.base_commit,
        snapshot.result_commit,
        summary,
        JSON.stringify(tests),
        JSON.stringify(snapshot.manifest),
        snapshot.output_hash,
        ctx.identity.actorType,
        ctx.identity.actorId,
      ],
    );
    await tx.query(
      `UPDATE task_workspace SET state='sealed',head_commit=$3,sealed_at=now()
        WHERE id=$1 AND project_id=$2 AND state='active'`,
      [task.workspace_id, projectId, snapshot.result_commit],
    );
    await tx.query(
      `UPDATE agent_task
          SET status='succeeded',output_hash=$3,adoption_state='available',
              finished_at=now(),updated_at=now(),runtime_snapshot=runtime_snapshot || $4::jsonb
        WHERE id=$1 AND project_id=$2`,
      [taskId, projectId, snapshot.output_hash, JSON.stringify({ status: "succeeded", summary })],
    );
    await appendOutbox(tx, ctx, taskId, "side_task.result_sealed", {
      taskId,
      resultId,
      outputHash: snapshot.output_hash,
      resultCommit: snapshot.result_commit,
      paths: snapshot.changes.map((change) => change.path),
    });
    return { resultId };
  }, (tx) => authorizeRuntimeTaskWrite(ctx, tx, projectId, taskId, false));
  const result = await loadResult(ctx.pool, projectId, taskId, write.result.resultId);
  return { status: 201, data: await resultPayload(ctx, result) };
}

export async function getSideTaskResultHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  await requireProjectReadable(ctx, projectId);
  await loadSideTask(ctx.pool, projectId, taskId);
  const result = await loadLatestResult(ctx.pool, projectId, taskId);
  if (!result) throw notFoundError(`side task result not found: ${taskId}`);
  return { status: 200, data: await resultPayload(ctx, result) };
}

export async function getSideTaskDiffHandler(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  await requireProjectReadable(ctx, projectId);
  await loadSideTask(ctx.pool, projectId, taskId);
  const result = await loadLatestResult(ctx.pool, projectId, taskId);
  if (!result) throw notFoundError(`side task result not found: ${taskId}`);
  const allFiles = await loadWorkspaceFiles(ctx.pool, projectId, taskId);
  const requested = ctx.url.searchParams.get("path");
  const normalizedRequested = requested ? validateWorkspacePath(requested) : null;
  const adopted = await adoptedPaths(ctx, taskId, result.id);
  const previews: Record<string, unknown>[] = [];
  const previewFacts: { path: string; targetHash: string | null }[] = [];
  for (const file of allFiles) {
    const target = await currentProjectFile(projectId, file.path);
    previewFacts.push({ path: file.path, targetHash: target.hash });
    if (normalizedRequested && file.path !== normalizedRequested) continue;
    const risk = overwriteRisk(file, target.hash);
    previews.push({
      path: file.path,
      change_kind: file.change_kind,
      base_hash: file.base_content_hash,
      result_hash: file.content_hash,
      current_target_hash: target.hash,
      diff: unifiedDiff(file.path, target.content, file.content_text),
      conflict_reason: risk === "none" ? null : risk,
      adopted: adopted.has(file.path),
    });
  }
  if (normalizedRequested && previews.length === 0) {
    throw notFoundError(`side task result path not found: ${normalizedRequested}`);
  }
  const previewHash = canonicalRequestHash({
    schema: "task-adoption-preview.v1",
    resultId: result.id,
    outputHash: result.output_hash,
    files: previewFacts.sort((a, b) => comparePaths(a.path, b.path)),
  });
  return {
    status: 200,
    data: {
      task_id: taskId,
      result_id: result.id,
      output_hash: result.output_hash,
      preview_hash: previewHash,
      files: previews,
    },
  };
}

export async function adoptSideTaskHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireSideTaskWrites(ctx);
  if (ctx.identity.actorType !== "human") throw forbiddenError("SIDE_TASK_ADOPTION_REQUIRES_HUMAN");
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const body = asObject(ctx.body);
  const resultId = requiredResourceId(body.result_id, "result_id");
  const previewHash = requiredHash(body.preview_hash, "preview_hash");
  const reason = requiredString(body, "reason").trim();
  if (!reason) throw validationError("field 'reason' must not be blank");
  const selected = parseAdoptionFiles(body.files).sort((a, b) => comparePaths(a.path, b.path));
  const adoptionId = body.adoption_id === undefined
    ? stableResourceId("adopt", ctx, projectId, taskId)
    : requiredResourceId(body.adoption_id, "adoption_id");
  const selectionHash = canonicalRequestHash({
    schema: "task-adoption-selection.v1",
    taskId,
    resultId,
    previewHash,
    files: selected,
  });
  const idempotencyScope = {
    actorType: ctx.identity.actorType,
    actorId: ctx.identity.actorId,
    projectId,
    operation: `adopt_side_task:${taskId}`,
    key: ctx.idempotencyKey,
  };
  const requestHash = canonicalRequestHash(ctx.body);
  const conn = await ctx.pool.connect();
  let lockKind: "p4" | "legacy" | null = null;
  try {
    if (await isModernP4Project(conn as unknown as TransactionClient, projectId)) {
      await acquireP4ProjectMutationSessionLock(
        conn,
        projectId,
        "side-task.adopt",
      );
      lockKind = "p4";
    } else {
      await conn.query(
        "SELECT pg_advisory_lock(hashtext($1))",
        [`task-adoption:${projectId}`],
      );
      lockKind = "legacy";
    }
    const prepared = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await requireProjectAccess(ctx, tx, projectId);
      await requireP4ChangeWorkVersion(tx, projectId);
      const claim = await claimIdempotencySlot(tx, idempotencyScope, requestHash);
      if (!claim.owned) {
        if (!claim.existing) throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
        if (claim.existing.requestHash !== requestHash) {
          throw conflictApiError("IDEMPOTENCY_CONFLICT", { operation: idempotencyScope.operation });
        }
        if (claim.existing.status === "completed") {
          return {
            replayed: true as const,
            data: decodeAdoptionResponse(claim.existing.response),
          };
        }
        if (claim.existing.status !== "in_progress") {
          throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
        }
        // The project advisory lock excludes a still-running adoption here.
        // An in-progress slot therefore represents an interrupted attempt and
        // must resume through the task_adoption crash-recovery state machine.
      }
      const task = await lockSideTask(tx, projectId, taskId);
      if (task.status !== "succeeded" || !task.output_hash) {
        throw conflictApiError("SIDE_TASK_RESULT_NOT_READY", { taskId, status: task.status });
      }
      const workspace = await lockWorkspace(tx, projectId, task);
      if (workspace.state !== "sealed") {
        throw conflictApiError("SIDE_TASK_RESULT_NOT_SEALED", { state: workspace.state });
      }
      const result = await loadResultTx(tx, projectId, taskId, resultId);
      const files = await loadWorkspaceFilesTx(tx, projectId, taskId);
      const byPath = new Map(files.map((file) => [file.path, file]));
      const existingResult = await tx.query(
        "SELECT * FROM task_adoption WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [adoptionId, projectId],
      );
      const existing = existingResult.rows[0] as AdoptionRow | undefined;
      if (existing) {
        if (
          existing.task_id !== taskId
          || existing.result_id !== resultId
          || existing.selection_hash !== selectionHash
          || existing.reason !== reason
          || existing.created_by !== ctx.identity.actorId
        ) {
          throw conflictApiError("IDEMPOTENCY_CONFLICT", { adoptionId });
        }
        if (existing.state === "applied") {
          const data = await adoptionPayloadTx(tx, adoptionId);
          await completeIdempotencySlot(tx, idempotencyScope, requestHash, data);
          return { replayed: true as const, data };
        }
        if (existing.state === "conflicted" || existing.state === "failed") {
          return {
            replayed: false as const,
            done: false as const,
            conflict: existing.details,
            terminal: existing.state,
            result,
            files: [] as { path: string; content: string }[],
          };
        }
      }

      const controlled = await ensureWorkspace(projectId);
      const beforeCommit = await headSha(controlled);
      if (!beforeCommit) throw internalError("PROJECT_WORKSPACE_HEAD_MISSING");
      const recoveryCommit = existing?.state === "applying"
        ? await findRecoveredAdoptionCommit(
          projectId,
          controlled,
          adoptionId,
          existing.project_commit_before,
          selected,
          byPath,
        )
        : null;
      const currentTargets = new Map<string, Awaited<ReturnType<typeof currentProjectFile>>>();
      for (const file of files) {
        currentTargets.set(file.path, await currentProjectFile(projectId, file.path));
      }
      if (!existing) {
        await tx.query(
          `INSERT INTO task_adoption
             (id,project_id,task_id,result_id,state,selection_hash,project_commit_before,
              reason,details,created_by_type,created_by,created_at)
           VALUES ($1,$2,$3,$4,'applying',$5,$6,$7,$8::jsonb,'human',$9,now())`,
          [
            adoptionId,
            projectId,
            taskId,
            resultId,
            selectionHash,
            beforeCommit,
            reason,
            JSON.stringify({ preview_hash: previewHash, files: selected }),
            ctx.identity.actorId,
          ],
        );
      }
      const duplicates = await tx.query(
        `SELECT path FROM task_adoption_file
          WHERE task_id=$1 AND result_id=$2 AND path=ANY($3::text[])`,
        [taskId, resultId, selected.map((file) => file.path)],
      );
      if (duplicates.rows.length > 0) {
        const detail = {
          code: "SIDE_TASK_ADOPTION_CONFLICT",
          conflicts: duplicates.rows.map((row) => ({
            path: (row as { path: string }).path,
            reason: "already_adopted",
          })),
        };
        await tx.query(
          `UPDATE task_adoption
              SET state='conflicted',details=$2::jsonb,completed_at=now()
            WHERE id=$1 AND state='applying'`,
          [adoptionId, JSON.stringify(detail)],
        );
        return {
          replayed: false as const,
          done: false as const,
          conflict: detail,
          terminal: "conflicted",
          result,
          files: [] as { path: string; content: string }[],
        };
      }
      const currentPreviewHash = canonicalRequestHash({
        schema: "task-adoption-preview.v1",
        resultId: result.id,
        outputHash: result.output_hash,
        files: files
          .map((file) => ({ path: file.path, targetHash: currentTargets.get(file.path)!.hash }))
          .sort((a, b) => comparePaths(a.path, b.path)),
      });
      // The complete preview hash is an audit link to what the human saw, not
      // a project-wide compare-and-swap token. An unselected result path may
      // change without blocking another selected path. Selected paths remain
      // protected below by base/proposed/target hashes and file write guards.
      const completePreviewChanged = currentPreviewHash !== previewHash && !recoveryCommit;

      const conflicts: Record<string, unknown>[] = [];
      const toApply: { path: string; content: string }[] = [];
      for (const selection of selected) {
        const file = byPath.get(selection.path);
        if (!file) throw validationError(`path is not present in result: ${selection.path}`);
        if (
          selection.expected_base_hash !== file.base_content_hash
          || selection.expected_proposed_hash !== file.content_hash
        ) {
          throw conflictApiError("SIDE_TASK_PREVIEW_STALE", { path: selection.path });
        }
        const target = currentTargets.get(selection.path)!;
        const recovering = recoveryCommit !== null;
        const baseCompatible = file.change_kind === "added"
          ? target.hash === null
          : target.hash === file.base_content_hash;
        if (!baseCompatible && !recovering) {
          conflicts.push({
            path: selection.path,
            reason: overwriteRisk(file, target.hash),
            expected: file.base_content_hash,
            actual: target.hash,
          });
          continue;
        }
        if (selection.expected_target_hash !== target.hash && !recovering) {
          conflicts.push({
            path: selection.path,
            reason: "target_changed_after_preview",
            expected: selection.expected_target_hash,
            actual: target.hash,
          });
          continue;
        }
        toApply.push({ path: selection.path, content: file.content_text });
      }
      if (conflicts.length > 0) {
        const detail = { code: "SIDE_TASK_ADOPTION_CONFLICT", conflicts };
        await tx.query(
          `UPDATE task_adoption
              SET state='conflicted',details=$2::jsonb,completed_at=now()
            WHERE id=$1 AND state='applying'`,
          [adoptionId, JSON.stringify(detail)],
        );
        return {
          replayed: false as const,
          done: false as const,
          conflict: detail,
          terminal: "conflicted",
          result,
          files: [] as { path: string; content: string }[],
        };
      }
      return {
        replayed: false as const,
        done: false as const,
        conflict: null,
        result,
        files: toApply,
        recoveryCommit,
        previewChangedUnselected: completePreviewChanged
          ? { currentPreviewHash }
          : null,
        guards: selected.map((selection) => ({
          path: selection.path,
          expectedContentHash: currentTargets.get(selection.path)!.hash,
          rejectPending: true,
        })),
      };
    });

    if (prepared.replayed) return { status: 201, data: prepared.data };
    if (prepared.conflict) {
      const code = typeof prepared.conflict === "object"
        && prepared.conflict !== null
        && "code" in prepared.conflict
        && typeof (prepared.conflict as { code?: unknown }).code === "string"
        ? (prepared.conflict as { code: string }).code
        : "SIDE_TASK_ADOPTION_CONFLICT";
      throw conflictApiError(code, prepared.conflict);
    }

    let outcome: Awaited<ReturnType<typeof writeAndCommit>>;
    try {
      outcome = prepared.recoveryCommit
        ? { commit: prepared.recoveryCommit, changed: selected.map((file) => file.path) }
        : await writeAndCommit(
          projectId,
          prepared.files,
          `采纳探索任务 ${taskId}\n\nadoption: ${adoptionId}`,
          gitAuthor(ctx.identity.actorId),
          { guards: prepared.guards },
        );
      if (!outcome.commit) throw internalError("PROJECT_WORKSPACE_HEAD_MISSING");
    } catch (error) {
      const conflicted = error instanceof WorkspaceError && error.code === "WORKSPACE_FILE_DIRTY";
      await withTransaction(conn as unknown as TransactionClient, async (tx) => {
        await tx.query(
          `UPDATE task_adoption
              SET state=$2,details=$3::jsonb,completed_at=now()
            WHERE id=$1 AND state='applying'`,
          [
            adoptionId,
            conflicted ? "conflicted" : "failed",
            JSON.stringify({
              code: conflicted ? "SIDE_TASK_ADOPTION_CONFLICT" : "SIDE_TASK_ADOPTION_WRITE_FAILED",
              ...(conflicted ? { reason: error.message } : {}),
            }),
          ],
        );
      });
      throw error;
    }

    const response = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      const adoptionResult = await tx.query(
        "SELECT * FROM task_adoption WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [adoptionId, projectId],
      );
      const adoption = adoptionResult.rows[0] as AdoptionRow | undefined;
      if (!adoption) throw internalError("SIDE_TASK_ADOPTION_MISSING");
      if (adoption.state === "applied") {
        const data = await adoptionPayloadTx(tx, adoptionId);
        await completeIdempotencySlot(tx, idempotencyScope, requestHash, data);
        return data;
      }
      if (adoption.state !== "applying") {
        throw conflictApiError("SIDE_TASK_ADOPTION_NOT_APPLYING", { state: adoption.state });
      }
      const tree = await readTreeAt(projectId, outcome.commit!);
      const reconciled = await reconcileIntoRevisions(tx, ctx, projectId, tree, {
        changeReason: `${reason}（来源探索任务 ${taskId}，结果 ${resultId}）`,
        artifactTypeOverride: "",
        onlyPaths: selected.map((file) => file.path),
      });
      if (reconciled.skipped.length > 0) throw internalError("ADOPTION_REVISION_SKIPPED");
      const revisions = new Map(
        [...reconciled.registered, ...reconciled.unchanged].map((row) => [row.path, row]),
      );
      const workspaceFiles = new Map(
        (await loadWorkspaceFilesTx(tx, projectId, taskId)).map((file) => [file.path, file]),
      );
      for (const selection of selected) {
        const revision = revisions.get(selection.path);
        const source = workspaceFiles.get(selection.path);
        if (!revision || !source) throw internalError("ADOPTION_REVISION_MISSING");
        await tx.query(
          `INSERT INTO task_adoption_file
             (adoption_id,project_id,task_id,result_id,workspace_file_id,path,
              source_content_hash,prior_target_hash,target_artifact_id,target_revision_id,target_version,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
          [
            adoptionId,
            projectId,
            taskId,
            resultId,
            source.id,
            selection.path,
            source.content_hash,
            selection.expected_target_hash,
            revision.artifact_id,
            revision.revision_id,
            revision.version,
          ],
        );
      }
      await tx.query(
        `UPDATE task_adoption
            SET state='applied',project_commit_after=$2,completed_at=now(),
                details=details || $3::jsonb
          WHERE id=$1 AND state='applying'`,
        [
          adoptionId,
          outcome.commit,
          JSON.stringify({
            paths: selected.map((file) => file.path),
            ...(prepared.previewChangedUnselected ? {
              preview_changed_unselected: true,
              current_preview_hash: prepared.previewChangedUnselected.currentPreviewHash,
            } : {}),
          }),
        ],
      );
      const countResult = await tx.query(
        "SELECT COUNT(DISTINCT path)::int AS count FROM task_adoption_file WHERE task_id=$1 AND result_id=$2",
        [taskId, resultId],
      );
      const totalResult = await tx.query(
        "SELECT COUNT(DISTINCT path)::int AS count FROM task_workspace_file WHERE task_id=$1",
        [taskId],
      );
      const adoptedCount = Number((countResult.rows[0] as { count?: number }).count ?? 0);
      const totalCount = Number((totalResult.rows[0] as { count?: number }).count ?? 0);
      const adoptionState = adoptedCount >= totalCount ? "adopted" : "partially_adopted";
      await tx.query(
        "UPDATE agent_task SET adoption_state=$3,updated_at=now() WHERE id=$1 AND project_id=$2",
        [taskId, projectId, adoptionState],
      );
      await appendOutbox(tx, ctx, taskId, "side_task.adopted", {
        adoptionId,
        taskId,
        resultId,
        paths: selected.map((file) => file.path),
        projectCommit: outcome.commit,
      });
      const data = await adoptionPayloadTx(tx, adoptionId);
      await completeIdempotencySlot(tx, idempotencyScope, requestHash, data);
      return data;
    });
    return { status: 201, data: response };
  } finally {
    if (lockKind === "p4") {
      await releaseP4ProjectMutationSessionLock(conn, projectId)
        .catch(() => undefined);
    } else if (lockKind === "legacy") {
      await conn.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [`task-adoption:${projectId}`],
      ).catch(() => undefined);
    }
    conn.release();
  }
}

function requireSideTaskWrites(ctx: RequestContext): void {
  if (ctx.featureFlags?.sideTasks !== true) {
    throw capabilityUnavailableError("side tasks are disabled by SYNTHIA_FEATURE_SIDE_TASKS");
  }
}

function requireTaskEventFeature(ctx: RequestContext, task: AgentTaskRow): void {
  if (task.kind === "side") requireSideTaskWrites(ctx);
}

function taskParam(ctx: RequestContext): string {
  return ctx.params.taskId ?? ctx.params.agentId ?? "";
}

function requireRuntimeBinding(ctx: RequestContext, task: SideTaskRow): void {
  requireRuntimeTaskBinding(ctx, task);
}

function requireRuntimeTaskBinding(ctx: RequestContext, task: AgentTaskRow): void {
  if (
    ctx.identity.actorType !== "service"
    || !ctx.identity.scopes.includes("core:task-runtime")
  ) {
    throw forbiddenError("TASK_RUNTIME_SERVICE_REQUIRED");
  }
  const taskHeader = ctx.request.headers.get("x-synthia-task-id");
  if (
    task.runtime_actor_id === null
    || task.runtime_agent_id === null
    || ctx.identity.actorId !== task.runtime_actor_id
    || taskHeader !== task.id
    || taskHeader !== task.runtime_agent_id
  ) {
    throw notFoundError(`task not found: ${task.id}`);
  }
  if (
    task.kind === "side"
    && ctx.request.headers.get("x-synthia-workspace-id") !== task.workspace_id
  ) {
    throw notFoundError(`task not found: ${task.id}`);
  }
  if (
    task.kind === "main"
    && (task.workspace_id !== null || ctx.request.headers.has("x-synthia-workspace-id"))
  ) {
    throw notFoundError(`task not found: ${task.id}`);
  }
}

async function requireProjectReadable(ctx: RequestContext, projectId: string): Promise<void> {
  const project = await ctx.pool.query("SELECT id FROM project WHERE id=$1", [projectId]);
  if (project.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  if (ctx.identity.scopes.includes("core:admin")) return;
  const access = await ctx.pool.query(
    "SELECT 1 FROM role_assignment WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3 LIMIT 1",
    [projectId, ctx.identity.actorType, ctx.identity.actorId],
  );
  if (access.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
}

async function requireProjectAccess(
  ctx: RequestContext,
  tx: TransactionClient,
  projectId: string,
): Promise<void> {
  const project = await tx.query("SELECT status FROM project WHERE id=$1", [projectId]);
  const row = project.rows[0] as { status?: string } | undefined;
  if (!row) throw notFoundError(`project not found: ${projectId}`);
  if (!ctx.identity.scopes.includes("core:admin")) {
    const access = await tx.query(
      "SELECT 1 FROM role_assignment WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3 LIMIT 1",
      [projectId, ctx.identity.actorType, ctx.identity.actorId],
    );
    if (access.rows.length === 0) throw notFoundError(`project not found: ${projectId}`);
  }
  if (row.status !== "active") throw conflictApiError("PROJECT_NOT_ACTIVE", { projectId });
}

async function loadSideTask(
  client: Pick<TransactionClient, "query">,
  projectId: string,
  taskId: string,
): Promise<SideTaskRow> {
  const { rows } = await client.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2 AND kind='side'",
    [taskId, projectId],
  );
  const task = rows[0] as SideTaskRow | undefined;
  if (!task) throw notFoundError(`side task not found: ${taskId}`);
  return task;
}

async function lockSideTask(
  tx: TransactionClient,
  projectId: string,
  taskId: string,
): Promise<SideTaskRow> {
  const { rows } = await tx.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2 AND kind='side' FOR UPDATE",
    [taskId, projectId],
  );
  const task = rows[0] as SideTaskRow | undefined;
  if (!task) throw notFoundError(`side task not found: ${taskId}`);
  return task;
}

async function lockAgentTask(
  tx: TransactionClient,
  projectId: string,
  taskId: string,
): Promise<AgentTaskRow> {
  const { rows } = await tx.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2 FOR UPDATE",
    [taskId, projectId],
  );
  const task = rows[0] as AgentTaskRow | undefined;
  if (!task) throw notFoundError(`task not found: ${taskId}`);
  return task;
}

async function requireActiveSideTask(
  tx: TransactionClient,
  projectId: string,
  taskId: string,
): Promise<SideTaskRow> {
  const task = await lockSideTask(tx, projectId, taskId);
  if (task.status !== "running" && task.status !== "awaiting_user") {
    throw conflictApiError("SIDE_TASK_NOT_WRITABLE", { taskId, status: task.status });
  }
  return task;
}

async function authorizeRuntimeTaskWrite(
  ctx: RequestContext,
  tx: TransactionClient,
  projectId: string,
  taskId: string,
  requireActiveWorkspace: boolean,
): Promise<void> {
  const task = await loadSideTask(tx, projectId, taskId);
  requireRuntimeBinding(ctx, task);
  if (requireActiveWorkspace) {
    const workspace = await loadWorkspace(tx, projectId, task);
    if (workspace.state !== "active") {
      throw conflictApiError("SIDE_TASK_WORKSPACE_NOT_ACTIVE", { state: workspace.state });
    }
  }
}

async function authorizeRuntimeTaskEvent(
  ctx: RequestContext,
  tx: TransactionClient,
  projectId: string,
  taskId: string,
): Promise<void> {
  const task = await loadAgentTask(tx, projectId, taskId);
  requireTaskEventFeature(ctx, task);
  requireRuntimeTaskBinding(ctx, task);
}

async function authorizeRuntimeTaskJobRead(ctx: RequestContext): Promise<void> {
  const projectId = ctx.params.projectId!;
  const taskId = taskParam(ctx);
  const jobId = ctx.params.jobId!;
  const task = await loadSideTask(ctx.pool, projectId, taskId);
  requireRuntimeBinding(ctx, task);
  const bound = await ctx.pool.query(
    `SELECT 1
       FROM tool_run
      WHERE id=$1
        AND project_id=$2
        AND run_class='exploratory'
        AND parameters->>'taskId'=$3
        AND parameters->>'workspaceId'=$4
        AND parameters->>'runClass'='exploratory'
      LIMIT 1`,
    [jobId, projectId, task.id, task.workspace_id],
  );
  if (bound.rows.length === 0) throw notFoundError(`job not found: ${jobId}`);
}

async function loadAgentTask(
  client: Pick<TransactionClient, "query">,
  projectId: string,
  taskId: string,
): Promise<AgentTaskRow> {
  const { rows } = await client.query(
    "SELECT * FROM agent_task WHERE id=$1 AND project_id=$2",
    [taskId, projectId],
  );
  const task = rows[0] as AgentTaskRow | undefined;
  if (!task) throw notFoundError(`task not found: ${taskId}`);
  return task;
}

async function loadWorkspace(
  client: Pick<TransactionClient, "query">,
  projectId: string,
  task: SideTaskRow,
): Promise<WorkspaceRow> {
  const result = await client.query(
    "SELECT * FROM task_workspace WHERE id=$1 AND task_id=$2 AND project_id=$3",
    [task.workspace_id, task.id, projectId],
  );
  const row = result.rows[0] as WorkspaceRow | undefined;
  if (!row) throw internalError("SIDE_TASK_WORKSPACE_MISSING");
  return row;
}

async function lockWorkspace(
  tx: TransactionClient,
  projectId: string,
  task: SideTaskRow,
): Promise<WorkspaceRow> {
  const result = await tx.query(
    "SELECT * FROM task_workspace WHERE id=$1 AND task_id=$2 AND project_id=$3 FOR UPDATE",
    [task.workspace_id, task.id, projectId],
  );
  const row = result.rows[0] as WorkspaceRow | undefined;
  if (!row) throw internalError("SIDE_TASK_WORKSPACE_MISSING");
  return row;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(`field '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredResourceId(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)
    || value === "."
    || value === ".."
  ) {
    throw validationError(`${field} contains invalid characters`);
  }
  return value;
}

function requiredHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw validationError(`${field} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function nullableHash(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredHash(value, field);
}

function requiredCommit(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw validationError(`${field} must be a lowercase Git object id`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw validationError(`${field} must be a positive integer`);
  }
  return value;
}

function stableResourceId(
  prefix: string,
  ctx: RequestContext,
  projectId: string,
  discriminator: string,
): string {
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");
  return `${prefix}-${canonicalRequestHash({
    schema: `${prefix}-id.v1`,
    projectId,
    discriminator,
    actorType: ctx.identity.actorType,
    actorId: ctx.identity.actorId,
    idempotencyKey: ctx.idempotencyKey,
  }).slice(0, 32)}`;
}

function stableSideTaskJobDispatch(
  ctx: RequestContext,
  projectId: string,
  taskId: string,
): { readonly jobId: string; readonly idempotencyKey: string; readonly correlationId: string } {
  if (!ctx.idempotencyKey) throw validationError("Idempotency-Key header is required for writes");
  const hash = canonicalRequestHash({
    schema: "side-task-job-dispatch.v1",
    actorType: ctx.identity.actorType,
    actorId: ctx.identity.actorId,
    projectId,
    taskId,
    idempotencyKey: ctx.idempotencyKey,
  });
  return {
    jobId: `job-${hash.slice(0, 32)}`,
    idempotencyKey: `side-job-${hash.slice(0, 48)}`,
    correlationId: `side-job-${hash.slice(0, 48)}`,
  };
}

function parseAuthorizationScope(raw: unknown): SideAuthorizationScope {
  const value = asObject(raw);
  const unsupportedKeys = Object.keys(value).filter((key) => !SIDE_AUTHORIZATION_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    throw validationError(
      `authorization_scope contains unsupported fields: ${unsupportedKeys.sort().join(", ")}`,
    );
  }
  if (value.schema !== "task-scope.v1") {
    throw validationError("authorization_scope.schema must be 'task-scope.v1'");
  }
  if (value.workspace !== "isolated") {
    throw validationError("authorization_scope.workspace must be 'isolated'");
  }
  if (!hasExactSideTaskReadPaths(value.read_paths)) {
    throw validationError(
      `authorization_scope.read_paths must equal [${SIDE_TASK_READ_PATHS.map((path) => `'${path}'`).join(", ")}]`,
    );
  }
  if (
    !Array.isArray(value.run_classes)
    || value.run_classes.length !== 1
    || value.run_classes[0] !== "exploratory"
  ) {
    throw validationError("authorization_scope.run_classes must equal ['exploratory']");
  }
  if (value.can_submit_gates !== false) {
    throw validationError("authorization_scope.can_submit_gates must be false");
  }
  if (value.can_create_milestones !== false) {
    throw validationError("authorization_scope.can_create_milestones must be false");
  }
  if (value.can_start_formal_runs !== false) {
    throw validationError("authorization_scope.can_start_formal_runs must be false");
  }
  const writePaths = parseExactPaths(value.write_paths, "authorization_scope.write_paths");
  return {
    schema: "task-scope.v1",
    workspace: "isolated",
    read_paths: SIDE_TASK_READ_PATHS,
    write_paths: writePaths,
    run_classes: ["exploratory"],
    can_submit_gates: false,
    can_create_milestones: false,
    can_start_formal_runs: false,
  };
}

function hasExactSideTaskReadPaths(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== SIDE_TASK_READ_PATHS.length) return false;
  if (raw.some((path) => typeof path !== "string")) return false;
  const paths = new Set(raw as string[]);
  return paths.size === SIDE_TASK_READ_PATHS.length
    && SIDE_TASK_READ_PATHS.every((path) => paths.has(path));
}

function parseExactPaths(raw: unknown, field: string): string[] {
  if (
    !Array.isArray(raw)
    || raw.length === 0
    || raw.length > MAX_AUTHORIZED_WRITE_PATHS
    || raw.some((item) => typeof item !== "string")
  ) {
    throw validationError(`${field} must contain 1..${MAX_AUTHORIZED_WRITE_PATHS} exact paths`);
  }
  const normalized = raw.map((item) => validateWorkspacePath(item as string));
  if (normalized.some((path) => path.includes("*"))) {
    throw validationError(`${field} does not accept glob patterns`);
  }
  if (normalized.some((path) => Buffer.byteLength(path, "utf8") > MAX_SIDE_TASK_PATH_BYTES)) {
    throw validationError(`${field} paths must not exceed ${MAX_SIDE_TASK_PATH_BYTES} UTF-8 bytes`);
  }
  if (normalized.some((path) => path.split("/").length > MAX_SIDE_TASK_PATH_SEGMENTS)) {
    throw validationError(`${field} paths must not exceed ${MAX_SIDE_TASK_PATH_SEGMENTS} segments`);
  }
  if (normalized.some((path) => !SIDE_TASK_READ_PATHS.some((pattern) => path.startsWith(pattern.slice(0, -2))))) {
    throw validationError(`${field} paths must stay inside the frozen controlled roots`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw validationError(`${field} contains duplicate paths`);
  }
  return normalized.sort(comparePaths);
}

function parseFiles(raw: unknown): { path: string; content: string }[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES_PER_WRITE) {
    throw validationError(`field 'files' must contain 1..${MAX_FILES_PER_WRITE} entries`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const value = asObject(entry);
    const path = validateWorkspacePath(value.path);
    if (seen.has(path)) throw validationError(`files contains duplicate path: ${path}`);
    seen.add(path);
    if (typeof value.content !== "string") {
      throw validationError(`files[${index}].content must be a string`);
    }
    if (Buffer.byteLength(value.content, "utf8") > MAX_FILE_BYTES) {
      throw validationError(`files[${index}] exceeds 1 MiB`);
    }
    return { path, content: value.content };
  });
}

function parseTaskJobSources(raw: unknown, field: string, required: boolean): SourceInput[] {
  if (raw === undefined || raw === null) {
    if (required) throw validationError(`field '${field}' must be a non-empty array`);
    return [];
  }
  if (!Array.isArray(raw) || (required && raw.length === 0) || raw.length > 64) {
    throw validationError(`field '${field}' must contain ${required ? "1..64" : "0..64"} entries`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const value = asObject(entry);
    const path = validateWorkspacePath(value.path);
    if (!isRegisterablePath(path)) throw validationError(`${field}[${index}].path is not a controlled source path`);
    if (seen.has(path)) throw validationError(`${field} contains duplicate path: ${path}`);
    seen.add(path);
    if (typeof value.content !== "string") throw validationError(`${field}[${index}].content must be a string`);
    if (Buffer.byteLength(value.content, "utf8") > MAX_FILE_BYTES) {
      throw validationError(`${field}[${index}] exceeds 1 MiB`);
    }
    const mediaType = value.mediaType;
    if (mediaType !== undefined && typeof mediaType !== "string") {
      throw validationError(`${field}[${index}].mediaType must be a string`);
    }
    return {
      path,
      content: value.content,
      ...(typeof mediaType === "string" ? { mediaType } : {}),
    };
  });
}

function optionalJobString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`field '${field}' must be a non-empty string`);
  }
  return value.trim();
}

function optionalJobTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw validationError("field 'timeout_ms' must be a positive number");
  }
  return value;
}

function parseAdoptionFiles(raw: unknown): AdoptionSelection[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES_PER_WRITE) {
    throw validationError(`field 'files' must contain 1..${MAX_FILES_PER_WRITE} entries`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const value = asObject(entry);
    const path = validateWorkspacePath(value.path);
    if (seen.has(path)) throw validationError(`files contains duplicate path: ${path}`);
    seen.add(path);
    return {
      path,
      expected_base_hash: nullableHash(
        value.expected_base_hash,
        `files[${index}].expected_base_hash`,
      ),
      expected_proposed_hash: requiredHash(
        value.expected_proposed_hash,
        `files[${index}].expected_proposed_hash`,
      ),
      expected_target_hash: nullableHash(
        value.expected_target_hash,
        `files[${index}].expected_target_hash`,
      ),
    };
  });
}

function requireAuthorizedPath(task: SideTaskRow, path: string): void {
  if (!task.authorization_scope.write_paths.includes(path)) {
    throw forbiddenError("SIDE_TASK_PATH_NOT_AUTHORIZED", { taskId: task.id, path });
  }
}

function isAuthorizedReadPath(task: SideTaskRow, path: string): boolean {
  return task.authorization_scope.read_paths.some((pattern) => {
    const prefix = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    return path.startsWith(`${prefix}/`);
  });
}

function requireAuthorizedReadPath(task: SideTaskRow, path: string): void {
  if (!isAuthorizedReadPath(task, path)) {
    throw forbiddenError("SIDE_TASK_PATH_NOT_AUTHORIZED", { taskId: task.id, path });
  }
}

async function nextEventSequence(tx: TransactionClient, taskId: string): Promise<number> {
  const result = await tx.query(
    "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM task_conversation_event WHERE task_id=$1",
    [taskId],
  );
  return Number((result.rows[0] as { next: number | string }).next);
}

async function insertConversationEvent(
  tx: TransactionClient,
  event: {
    id: string;
    projectId: string;
    taskId: string;
    sequence?: number;
    eventKind: string;
    payload: Record<string, unknown>;
    actorType: "human" | "service";
    actorId: string;
  },
): Promise<number> {
  const sequence = event.sequence ?? await nextEventSequence(tx, event.taskId);
  await tx.query(
    `INSERT INTO task_conversation_event
       (id,project_id,task_id,sequence,event_kind,payload,payload_hash,actor_type,actor_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,now())`,
    [
      event.id,
      event.projectId,
      event.taskId,
      sequence,
      event.eventKind,
      JSON.stringify(event.payload),
      canonicalRequestHash(event.payload),
      event.actorType,
      event.actorId,
    ],
  );
  return sequence;
}

async function applyRuntimeStatus(
  tx: TransactionClient,
  task: AgentTaskRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const raw = requiredString(payload, "status");
  if (task.kind === "side" && (raw === "succeeded" || raw === "completed")) {
    throw conflictApiError("SIDE_TASK_RESULT_MUST_BE_FINALIZED", { taskId: task.id });
  }
  if (task.kind === "side" && (raw === "awaiting_approval" || payload.awaiting_gate !== undefined)) {
    throw conflictApiError("SIDE_TASK_GOVERNANCE_FORBIDDEN", { taskId: task.id });
  }
  const next = task.agent_role === "project" && (raw === "succeeded" || raw === "completed")
    ? "awaiting_user"
    : raw === "idle" || raw === "interrupted" || raw === "awaiting_approval"
    ? "awaiting_user"
    : raw === "aborted"
      ? "cancelled"
      : raw === "completed"
        ? "succeeded"
        : raw;
  if (!new Set(["running", "awaiting_user", "succeeded", "failed", "cancelled", "fail_closed"]).has(next)) {
    throw validationError("unsupported task status");
  }
  const transitions: Record<string, readonly string[]> = {
    queued: ["running", "failed", "cancelled", "fail_closed"],
    running: ["running", "awaiting_user", "succeeded", "failed", "cancelled", "fail_closed"],
    awaiting_user: ["running", "awaiting_user", "succeeded", "failed", "cancelled", "fail_closed"],
    succeeded: ["succeeded"],
    failed: ["failed"],
    cancelled: ["cancelled"],
    fail_closed: ["fail_closed"],
  };
  const projectAgentRecovery = task.agent_role === "project"
    && new Set(["running", "awaiting_user", "failed", "cancelled", "fail_closed"]).has(next);
  if (!projectAgentRecovery && !transitions[task.status]?.includes(next)) {
    throw conflictApiError("TASK_STATUS_CONFLICT", { from: task.status, to: next });
  }
  const terminal = next === "succeeded" || next === "failed" || next === "cancelled" || next === "fail_closed";
  const outputHash = next === "succeeded"
    ? (task.output_hash ?? (payload.output_hash === undefined
      ? canonicalRequestHash({ schema: "task-terminal.v1", taskId: task.id, payload })
      : requiredHash(payload.output_hash, "payload.output_hash")))
    : null;
  const currentStage = typeof payload.current_stage === "string" ? payload.current_stage : null;
  const awaitingGate = task.kind === "main" && typeof payload.awaiting_gate === "string"
    ? (/^G[0-9]$/.test(payload.awaiting_gate)
      ? payload.awaiting_gate
      : (() => { throw validationError("payload.awaiting_gate must be G0..G9"); })())
    : null;
  await tx.query(
    `UPDATE agent_task
        SET status=$3,finished_at=CASE WHEN $4 THEN now() ELSE NULL END,
            output_hash=$5,
            adoption_state=CASE WHEN kind='side' AND $4 THEN 'discarded' ELSE adoption_state END,
            current_stage=COALESCE($6,current_stage),awaiting_gate=$7,
            runtime_snapshot=runtime_snapshot || $8::jsonb,updated_at=now()
      WHERE id=$1 AND project_id=$2`,
    [
      task.id,
      task.project_id,
      next,
      terminal,
      outputHash,
      currentStage,
      awaitingGate,
      JSON.stringify({
        status: next,
        ...(outputHash ? { output_hash: outputHash } : {}),
        ...(currentStage ? { current_stage: currentStage } : {}),
        ...(awaitingGate ? { awaiting_gate: awaitingGate } : {}),
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      }),
    ],
  );
}

function workspaceFileId(taskId: string, change: TaskWorkspaceChange): string {
  return `twf-${canonicalRequestHash({
    taskId,
    path: change.path,
    resultHash: change.result_hash,
  }).slice(0, 32)}`;
}

async function loadLatestResult(
  client: Pick<TransactionClient, "query">,
  projectId: string,
  taskId: string,
): Promise<TaskResultRow | null> {
  const result = await client.query(
    "SELECT * FROM task_result WHERE task_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
    [taskId, projectId],
  );
  return result.rows[0] as TaskResultRow | undefined ?? null;
}

async function loadResult(
  client: Pick<TransactionClient, "query">,
  projectId: string,
  taskId: string,
  resultId: string,
): Promise<TaskResultRow> {
  const result = await client.query(
    "SELECT * FROM task_result WHERE id=$1 AND task_id=$2 AND project_id=$3",
    [resultId, taskId, projectId],
  );
  const row = result.rows[0] as TaskResultRow | undefined;
  if (!row) throw notFoundError(`side task result not found: ${resultId}`);
  return row;
}

async function loadResultTx(
  tx: TransactionClient,
  projectId: string,
  taskId: string,
  resultId: string,
): Promise<TaskResultRow> {
  const result = await tx.query(
    "SELECT * FROM task_result WHERE id=$1 AND task_id=$2 AND project_id=$3 FOR UPDATE",
    [resultId, taskId, projectId],
  );
  const row = result.rows[0] as TaskResultRow | undefined;
  if (!row) throw notFoundError(`side task result not found: ${resultId}`);
  return row;
}

async function loadWorkspaceFiles(
  client: Pick<TransactionClient, "query">,
  projectId: string,
  taskId: string,
): Promise<WorkspaceFileRow[]> {
  const result = await client.query(
    `SELECT DISTINCT ON (path) * FROM task_workspace_file
      WHERE task_id=$1 AND project_id=$2 ORDER BY path,version DESC`,
    [taskId, projectId],
  );
  return result.rows as WorkspaceFileRow[];
}

async function loadWorkspaceFilesTx(
  tx: TransactionClient,
  projectId: string,
  taskId: string,
): Promise<WorkspaceFileRow[]> {
  return loadWorkspaceFiles(tx, projectId, taskId);
}

async function adoptedPaths(
  ctx: RequestContext,
  taskId: string,
  resultId: string,
): Promise<Set<string>> {
  const result = await ctx.pool.query(
    "SELECT path FROM task_adoption_file WHERE task_id=$1 AND result_id=$2",
    [taskId, resultId],
  );
  return new Set(result.rows.map((row) => (row as { path: string }).path));
}

async function resultPayload(
  ctx: RequestContext,
  result: TaskResultRow,
): Promise<Record<string, unknown>> {
  const files = await loadWorkspaceFiles(ctx.pool, result.project_id, result.task_id);
  return {
    result_id: result.id,
    task_id: result.task_id,
    workspace_id: result.workspace_id,
    summary: result.summary,
    tests: Array.isArray(result.tests) ? result.tests : [],
    files: files.map((file) => ({
      path: file.path,
      change_kind: file.change_kind,
      base_hash: file.base_content_hash,
      result_hash: file.content_hash,
      size_bytes: Number(file.size_bytes),
    })),
    base_commit: result.base_commit,
    result_commit: result.result_commit,
    output_hash: result.output_hash,
    created_at: iso(result.created_at),
  };
}

function sideTaskPayload(task: SideTaskRow, workspace: WorkspaceRow): Record<string, unknown> {
  return {
    id: task.id,
    agent_id: task.id,
    task_id: task.id,
    project_id: task.project_id,
    kind: "side",
    parent_task_id: task.parent_task_id,
    objective: task.objective,
    task: task.objective,
    status: task.status,
    workspace_id: task.workspace_id,
    workspace_label: `探索副本 ${task.workspace_id.slice(-8)}`,
    workspace_state: workspace.state,
    base_commit: workspace.base_commit,
    base_manifest_hash: workspace.base_manifest_hash,
    head_commit: workspace.head_commit,
    authorization_scope: task.authorization_scope,
    input_hash: task.input_hash,
    output_hash: task.output_hash,
    adoption_state: task.adoption_state,
    created_at: iso(task.created_at),
    updated_at: iso(task.updated_at),
    finished_at: task.finished_at ? iso(task.finished_at) : null,
  };
}

async function adoptionPayloadTx(
  tx: TransactionClient,
  adoptionId: string,
): Promise<Record<string, unknown>> {
  const result = await tx.query("SELECT * FROM task_adoption WHERE id=$1", [adoptionId]);
  const adoption = result.rows[0] as AdoptionRow | undefined;
  if (!adoption) throw notFoundError(`task adoption not found: ${adoptionId}`);
  const files = await tx.query(
    `SELECT path,source_content_hash,prior_target_hash,target_artifact_id,
            target_revision_id,target_version
       FROM task_adoption_file WHERE adoption_id=$1 ORDER BY path`,
    [adoptionId],
  );
  return {
    adoption_id: adoption.id,
    task_id: adoption.task_id,
    result_id: adoption.result_id,
    status: adoption.state,
    adopted_paths: files.rows.map((row) => (row as { path: string }).path),
    project_commit_before: adoption.project_commit_before,
    project_commit_after: adoption.project_commit_after,
  };
}

function decodeAdoptionResponse(response: unknown): Record<string, unknown> {
  if (typeof response === "string") {
    try {
      const decoded = JSON.parse(response) as unknown;
      if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
        return decoded as Record<string, unknown>;
      }
    } catch {
      // Fall through to the stable internal-state error below.
    }
    throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw internalError("IDEMPOTENCY_UNEXPECTED_STATE");
  }
  return response as Record<string, unknown>;
}

function overwriteRisk(file: WorkspaceFileRow, targetHash: string | null): string {
  if (file.change_kind === "added") return targetHash === null ? "none" : "target_created";
  if (targetHash === null) return "target_deleted";
  return targetHash === file.base_content_hash ? "none" : "target_changed";
}

/**
 * Recover the Git half of an adoption when Core crashed after committing the
 * selected files but before its database transaction could mark the adoption
 * as applied. A later, unrelated commit may already be HEAD, so recovery must
 * locate and validate the original adoption commit instead of treating HEAD as
 * that commit or creating a second adoption commit.
 */
async function findRecoveredAdoptionCommit(
  projectId: string,
  workspaceDir: string,
  adoptionId: string,
  projectCommitBefore: string,
  selected: readonly AdoptionSelection[],
  resultFiles: ReadonlyMap<string, WorkspaceFileRow>,
): Promise<string | null> {
  const marker = `adoption: ${adoptionId}`;
  const history = await git(workspaceDir, [
    "log",
    "--format=%H",
    "--fixed-strings",
    `--grep=${marker}`,
    "HEAD",
  ]);
  const candidates = history.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selectedPaths = selected.map((file) => file.path).sort(comparePaths);
  if (selectedPaths.some((path) => !resultFiles.has(path))) return null;
  const selectionsByPath = new Map(selected.map((selection) => [selection.path, selection]));

  const valid: string[] = [];
  for (const candidate of candidates) {
    const message = await git(workspaceDir, ["show", "-s", "--format=%B", candidate]);
    if (!message.split(/\r?\n/).some((line) => line.trim() === marker)) continue;

    const parents = (await git(workspaceDir, ["rev-list", "--parents", "-n", "1", candidate]))
      .trim()
      .split(/\s+/);
    if (parents.length !== 2 || parents[0] !== candidate) continue;
    const parent = parents[1]!;
    const ancestry = await gitRaw(workspaceDir, [
      "merge-base",
      "--is-ancestor",
      projectCommitBefore,
      candidate,
    ]);
    if (ancestry.exitCode === 1) continue;
    if (ancestry.exitCode !== 0) {
      throw new WorkspaceError(
        "WORKSPACE_GIT_FAILED",
        "无法验证采纳提交与原项目版本的祖先关系",
        {
          projectId,
          projectCommitBefore,
          candidate,
          stderr: ancestry.stderr.trim(),
        },
      );
    }

    const changedOutput = await git(workspaceDir, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      candidate,
    ]);
    const changedPaths = changedOutput.split("\0").filter(Boolean).sort(comparePaths);
    if (
      changedPaths.length !== selectedPaths.length
      || changedPaths.some((path, index) => path !== selectedPaths[index])
    ) {
      continue;
    }

    let contentMatches = true;
    for (const path of selectedPaths) {
      const source = resultFiles.get(path)!;
      const selection = selectionsByPath.get(path)!;
      const [preimage, adopted] = await Promise.all([
        commitPathFact(workspaceDir, parent, path),
        commitPathFact(workspaceDir, candidate, path),
      ]);
      // The recorded project commit may be an older ancestor when unrelated
      // work landed before the adoption write. The candidate's unique parent
      // is the authoritative preimage: it must still match what the human
      // previewed (and an added file must still be absent there).
      const preimageMatches = selection.expected_target_hash === null
        ? preimage === null
        : preimage?.objectType === "blob"
          && (preimage.mode === "100644" || preimage.mode === "100755")
          && preimage.contentHash === selection.expected_target_hash;
      const expectedAdoptedMode = preimage?.mode === "100755" ? "100755" : "100644";
      const adoptedMatches = adopted?.objectType === "blob"
        && adopted.mode === expectedAdoptedMode
        && adopted.contentHash === source.content_hash;
      if (!preimageMatches || !adoptedMatches) {
        contentMatches = false;
        break;
      }
    }
    if (contentMatches) valid.push(candidate);
  }

  return valid.length === 1 ? valid[0]! : null;
}

interface CommitPathFact {
  readonly mode: string;
  readonly objectType: "blob" | "commit";
  readonly contentHash: string | null;
}

/** Read one literal path without conflating a missing entry with Git failure. */
async function commitPathFact(
  workspaceDir: string,
  commit: string,
  path: string,
): Promise<CommitPathFact | null> {
  const listed = await gitRaw(workspaceDir, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    commit,
    "--",
    path,
  ]);
  if (listed.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `无法检查采纳提交的文件状态：${path}`,
      { commit, path, stderr: listed.stderr.trim() },
    );
  }
  const output = new TextDecoder().decode(listed.stdout);
  if (output.length === 0) return null;
  const records = output.split("\0").filter(Boolean);
  if (records.length !== 1) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `采纳提交的文件路径不唯一：${path}`,
      { commit, path },
    );
  }
  const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(records[0]!);
  if (!match || match[4] !== path) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `采纳提交的文件记录无效：${path}`,
      { commit, path },
    );
  }
  const objectType = match[2]! as "blob" | "commit";
  if (objectType === "commit") {
    return { mode: match[1]!, objectType, contentHash: null };
  }
  const objectId = match[3]!;
  const blob = await gitRaw(workspaceDir, ["cat-file", "blob", objectId]);
  if (blob.exitCode !== 0) {
    throw new WorkspaceError(
      "WORKSPACE_GIT_FAILED",
      `无法读取采纳提交的文件对象：${path}`,
      { commit, path, objectId, stderr: blob.stderr.trim() },
    );
  }
  return {
    mode: match[1]!,
    objectType,
    contentHash: sha256Hex(blob.stdout),
  };
}

function unifiedDiff(path: string, current: string | null, proposed: string): string {
  const before = current ?? "";
  if (before === proposed) return "";
  const oldLines = before.split("\n");
  const newLines = proposed.split("\n");
  return [
    `--- current/${path}`,
    `+++ proposed/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function artifactTypeForPath(path: string): string {
  if (path.startsWith("rtl/")) return "RTL_SOURCE_SET";
  if (path.startsWith("tb/")) return "TB_SOURCE_SET";
  if (path.startsWith("prj/constr/")) return "XDC_CANDIDATE";
  return "DETAILED_DESIGN";
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitAuthor(actorId: string): { name: string; email: string } {
  const name = actorId.replace(/[<>\n\r]/g, "").trim() || "unknown";
  return { name, email: `${name.replace(/[^A-Za-z0-9._-]/g, "-")}@synthia.local` };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function appendOutbox(
  tx: TransactionClient,
  ctx: RequestContext,
  taskId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await tx.query(
    `WITH next_sequence AS (
       SELECT COALESCE(MAX(sequence),0)+1 AS value
         FROM outbox_events WHERE aggregate_type='task' AND aggregate_id=$1
     )
     INSERT INTO outbox_events
       (event_id,aggregate_type,aggregate_id,sequence,event_type,project_id,payload,
        correlation_id,causation_id,classification)
     SELECT $2,'task',$1,value,$3,$4,$5::jsonb,$6,NULL,$7 FROM next_sequence`,
    [
      taskId,
      randomUUID(),
      eventType,
      ctx.params.projectId ?? "",
      JSON.stringify(payload),
      ctx.correlationId,
      ctx.classification,
    ],
  );
}
