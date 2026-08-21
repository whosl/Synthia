/**
 * P3 dual-service acceptance driver.
 *
 * Starts real Core and Runtime HTTP servers against a disposable PostgreSQL
 * database, injects only a deterministic model/Connector boundary, and checks
 * the full main + side-task lifecycle through adoption.
 *
 * Usage:
 *   DATABASE_URL=<admin-db-url> bun run core/scripts/make-test-db.ts synthia_p3_http_verify
 *   DATABASE_URL=<printed-scratch-db-url> bun run core/scripts/verify-p3-http.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

import { startSynthiaServer, type SynthiaServer } from "../src/api/server.ts";
import {
  HttpRuntimeClient,
} from "../src/api/task-proxy.ts";
import type {
  ConnectorDiscovery,
  ConnectorJobSnapshot,
  ConnectorPort,
  EvidenceContent,
  EvidenceManifest,
  SubmitJobParams,
} from "../src/api/connector-port.ts";
import { sha256Hex } from "../src/hashing.ts";
import { headSha } from "../src/workspace/git.ts";
import { projectWorkspaceDir } from "../src/workspace/paths.ts";
import { taskWorkspaceDir } from "../src/workspace/task-store.ts";
import {
  createEnvDepsFactory,
  createServerConfig,
  RuntimeServer,
} from "../../runtime/server.ts";
import type {
  AgentMessage,
  AgentTool,
  ChatTurn,
  ConversationalModel,
} from "../../runtime/agent-types.ts";
import { CoreApiConnector } from "../../runtime/core-api-connector.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required; point it at a disposable migrated PostgreSQL database");
}
const ORIGINAL_FETCH = globalThis.fetch;
const EVIDENCE_BODY = "validate_sources succeeded\n";
const EVIDENCE_SHA = sha256Hex(EVIDENCE_BODY);
const ORIGINAL_RTL = "module a(output wire y); assign y = 1'b0; endmodule\n";
const MODIFIED_RTL = "module a(output wire y); assign y = 1'b1; endmodule\n";

interface HttpRecord {
  readonly target: "core" | "runtime" | "other";
  readonly method: string;
  readonly path: string;
  readonly auth: "human" | "generic" | "task" | "mixed" | "none" | "other";
  readonly taskHeader: string | null;
  readonly workspaceHeader: string | null;
  readonly bodyTaskId: string | null;
}

class MainBlockingModel implements ConversationalModel {
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  calls = 0;

  async chat(
    _messages: readonly AgentMessage[],
    _tools: readonly AgentTool[],
  ): Promise<ChatTurn> {
    this.calls += 1;
    this.started.resolve();
    await this.release.promise;
    return { kind: "text", content: "main task can now finish" };
  }
}

class SideScriptedModel implements ConversationalModel {
  readonly calls: Array<{
    readonly messages: readonly AgentMessage[];
    readonly toolNames: readonly string[];
  }> = [];

  async chat(
    messages: readonly AgentMessage[],
    tools: readonly AgentTool[],
  ): Promise<ChatTurn> {
    this.calls.push({ messages: [...messages], toolNames: tools.map((tool) => tool.name) });
    switch (this.calls.length) {
      case 1:
        return {
          kind: "tool_calls",
          calls: [{
            toolCallId: "p3-http-write-rtl",
            name: "fpga-rtl-build",
            args: {
              filename: "rtl/a.v",
              content: MODIFIED_RTL,
              notes: "P3 real HTTP isolation verification",
            },
          }],
          content: null,
        };
      case 2:
        return {
          kind: "tool_calls",
          calls: [{
            toolCallId: "p3-http-validate",
            name: "vivado_run",
            args: {
              operation: "validate_sources",
              sources: [{ path: "rtl/a.v" }],
              top: "a",
            },
          }],
          content: null,
        };
      case 3:
        return {
          kind: "text",
          content: "隔离副本已修改并验证；请确认是否密封本次探索结果。",
        };
      case 4:
        return {
          kind: "tool_calls",
          calls: [{
            toolCallId: "p3-http-complete-side",
            name: "synthia_complete_side_task",
            args: {},
          }],
          content: null,
        };
      case 5:
        return {
          kind: "text",
          content: "确认完成：rtl/a.v 已在隔离副本中修改，validate_sources 通过。",
        };
      default:
        throw new Error(`unexpected side model call ${this.calls.length}`);
    }
  }
}

class DeterministicConnector implements ConnectorPort {
  readonly connectorId = "p3-real-http-fake-connector";
  readonly submissions: SubmitJobParams[] = [];
  readonly statusQueries: Array<{ projectId: string; jobId: string }> = [];
  readonly evidenceQueries: Array<{ projectId: string; jobId: string }> = [];
  readonly contentQueries: Array<{ projectId: string; jobId: string; name: string }> = [];

  async discover(_projectId: string): Promise<ConnectorDiscovery> {
    return {
      capabilities: [{
        operation: "validate_sources",
        version: "vivado-batch-1",
        runClasses: ["exploratory"],
      }],
      drift: false,
    };
  }

  async submitJob(params: SubmitJobParams): Promise<ConnectorJobSnapshot> {
    this.submissions.push(params);
    return { jobId: params.jobId, state: "queued" };
  }

  async queryStatus(projectId: string, jobId: string): Promise<ConnectorJobSnapshot> {
    this.statusQueries.push({ projectId, jobId });
    return { jobId, state: "succeeded", outputSha256: EVIDENCE_SHA };
  }

  async fetchEvidence(projectId: string, jobId: string): Promise<EvidenceManifest> {
    this.evidenceQueries.push({ projectId, jobId });
    return {
      jobId,
      entries: [{
        name: "compile.log",
        uri: `connector://p3/${jobId}/compile.log`,
        sha256: EVIDENCE_SHA,
        sizeBytes: Buffer.byteLength(EVIDENCE_BODY),
        mediaType: "text/plain",
      }],
    };
  }

  async fetchEvidenceContent(
    projectId: string,
    jobId: string,
    name: string,
  ): Promise<EvidenceContent> {
    this.contentQueries.push({ projectId, jobId, name });
    return {
      name,
      content: EVIDENCE_BODY,
      sha256: EVIDENCE_SHA,
      truncated: false,
      mediaType: "text/plain",
    };
  }
}

function token(): string {
  return `p3_${randomBytes(32).toString("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function data(value: unknown): Record<string, unknown> {
  const envelope = asRecord(value);
  return asRecord(envelope.data);
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (true) {
    last = await read();
    if (accept(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
    }
    await Bun.sleep(25);
  }
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)), timeoutMs);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  const scratch = await mkdtemp(join(tmpdir(), "synthia-p3-real-http-"));
  const workspacesDir = join(scratch, "workspaces");
  const taskWorkspacesDir = join(scratch, "task-workspaces");
  const runsDir = join(scratch, "runs");
  await Promise.all([
    mkdir(workspacesDir, { recursive: true }),
    mkdir(taskWorkspacesDir, { recursive: true }),
    mkdir(runsDir, { recursive: true }),
  ]);
  process.env.SYNTHIA_WORKSPACES_DIR = workspacesDir;
  process.env.SYNTHIA_TASK_WORKSPACES_DIR = taskWorkspacesDir;
  process.env.SYNTHIA_RUNS_DIR = runsDir;

  const humanToken = token();
  const genericToken = token();
  const taskToken = token();
  const mixedToken = token();
  const mainModel = new MainBlockingModel();
  const sideModel = new SideScriptedModel();
  const connector = new DeterministicConnector();
  const httpRecords: HttpRecord[] = [];
  const checks: string[] = [];
  let runtime: RuntimeServer | undefined;
  let core: SynthiaServer | undefined;
  let coreBase = "";
  let runtimeBase = "";
  let mainTaskId = "";

  function check(
    condition: unknown,
    label: string,
    diagnostic?: string,
  ): asserts condition {
    if (!condition) {
      throw new Error(`CHECK FAILED: ${label}${diagnostic ? `; ${diagnostic}` : ""}`);
    }
    checks.push(label);
  }

  function authLabel(raw: string | null): HttpRecord["auth"] {
    if (!raw) return "none";
    const bearer = raw.replace(/^Bearer\s+/i, "");
    if (bearer === humanToken) return "human";
    if (bearer === genericToken) return "generic";
    if (bearer === taskToken) return "task";
    if (bearer === mixedToken) return "mixed";
    return "other";
  }

  async function call(
    path: string,
    options: {
      readonly method?: string;
      readonly token?: string;
      readonly key?: string;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
    } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers = new Headers(options.headers);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.key) headers.set("idempotency-key", options.key);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(`${coreBase}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, json: await jsonBody(response) };
  }

  async function provisionIdentity(
    uid: string,
    actorType: "human" | "service",
    plaintext: string,
    scopes: readonly string[],
  ): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const provisioned = await pool.query(
      `INSERT INTO user_account
         (id,uid,cn,display_name,member_of,mail,actor_type,status)
       VALUES ($1,$2,$3,$3,'{}',$4,$5,'active')
       ON CONFLICT (uid) DO UPDATE
         SET cn=EXCLUDED.cn,
             display_name=EXCLUDED.display_name,
             mail=EXCLUDED.mail,
             actor_type=EXCLUDED.actor_type,
             status='active',
             updated_at=now()
       RETURNING id`,
      [userId, uid, uid, `${uid}@p3.local`, actorType],
    );
    const effectiveUserId = String(provisioned.rows[0]!.id);
    await pool.query(
      "INSERT INTO auth_token(token_hash,user_id,scope) VALUES ($1,$2,$3)",
      [sha256Hex(plaintext), effectiveUserId, [...scopes]],
    );
    return effectiveUserId;
  }

  try {
    await provisionIdentity(
      "p3-http-admin",
      "human",
      humanToken,
      ["core:admin", "core:write", "core:read", "core:approve"],
    );
    const genericServiceUserId = await provisionIdentity(
      "synthia-service",
      "service",
      genericToken,
      ["core:read", "core:write"],
    );
    await provisionIdentity(
      "synthia-runtime",
      "service",
      taskToken,
      ["core:task-runtime"],
    );
    await pool.query(
      "INSERT INTO auth_token(token_hash,user_id,scope) VALUES ($1,$2,$3)",
      [
        sha256Hex(mixedToken),
        genericServiceUserId,
        ["core:read", "core:write", "core:task-runtime"],
      ],
    );

    const runtimeEnv: Record<string, string | undefined> = {
      SYNTHIA_RUNTIME_MODE: "core",
      SYNTHIA_CORE_URL: "http://127.0.0.1:1",
      SYNTHIA_CORE_TOKEN: genericToken,
      SYNTHIA_TASK_RUNTIME_TOKEN: taskToken,
      SYNTHIA_MODEL_URL: "http://127.0.0.1:9/v1/chat/completions",
      SYNTHIA_MODEL_KEY: "p3-http-dummy-key",
      SYNTHIA_MODEL_NAME: "p3-http-dummy-model",
    };
    const config = await createServerConfig({
      ...process.env,
      SYNTHIA_RUNTIME_PORT: "0",
      SYNTHIA_GATE_POLL_MS: "600000",
      SYNTHIA_FEATURE_HISTORICAL_MATERIALS: "0",
    });
    let modelFactoryCalls = 0;
    runtime = new RuntimeServer(
      config,
      createEnvDepsFactory(runtimeEnv),
      () => {
        modelFactoryCalls += 1;
        if (modelFactoryCalls === 1) return mainModel;
        if (modelFactoryCalls === 2) return sideModel;
        throw new Error(`unexpected conversational model factory call ${modelFactoryCalls}`);
      },
    );
    await runtime.start();
    runtimeBase = runtime.url;

    core = startSynthiaServer(pool, {
      port: 0,
      runtimeClient: new HttpRuntimeClient({ baseUrl: runtime.url, timeoutMs: 30_000 }),
      connector,
      features: { sideTasks: true },
      runtimeActorId: "synthia-runtime",
    });
    coreBase = `http://${core.hostname}:${core.port}`;
    runtimeEnv.SYNTHIA_CORE_URL = coreBase;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input));
      const headers = new Headers(request?.headers ?? init?.headers);
      const target = url.origin === coreBase
        ? "core"
        : url.origin === runtimeBase
          ? "runtime"
          : "other";
      let bodyTaskId: string | null = null;
      const rawBody = request ? null : init?.body;
      if (typeof rawBody === "string") {
        try {
          const parsed = JSON.parse(rawBody) as Record<string, unknown>;
          bodyTaskId = typeof parsed.task_id === "string" ? parsed.task_id : null;
        } catch {
          bodyTaskId = null;
        }
      }
      httpRecords.push({
        target,
        method: request?.method ?? init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        auth: authLabel(headers.get("authorization")),
        taskHeader: headers.get("x-synthia-task-id"),
        workspaceHeader: headers.get("x-synthia-workspace-id"),
        bodyTaskId,
      });
      return ORIGINAL_FETCH(input, init);
    }) as typeof fetch;

    const projectId = `p3-http-${randomUUID()}`;
    const createProject = await call("/api/v1/projects", {
      method: "POST",
      token: humanToken,
      key: `create-project-${randomUUID()}`,
      body: {
        id: projectId,
        name: "P3 real Core + Runtime HTTP verification",
        project_type: "free",
        target_part: "xc7k70tfbv676-1",
      },
    });
    check(createProject.status === 201, "free project created through Core HTTP");

    const seed = await call(`/api/v1/projects/${projectId}/workspace/files`, {
      method: "POST",
      token: humanToken,
      key: `seed-rtl-${randomUUID()}`,
      body: {
        files: [{ path: "rtl/a.v", content: ORIGINAL_RTL }],
        change_reason: "seed P3 real HTTP verification",
      },
    });
    check(seed.status === 200, "controlled project workspace seeded through Core HTTP");

    const role = await call(`/api/v1/projects/${projectId}/role-assignments`, {
      method: "POST",
      token: humanToken,
      key: `assign-service-${randomUUID()}`,
      body: {
        id: `role_${randomUUID()}`,
        actor_type: "service",
        actor_id: "synthia-service",
        role: "developer",
      },
    });
    check(role.status === 201, "ordinary service received an explicit project role");

    const controlledDir = projectWorkspaceDir(projectId);
    const baseHead = await headSha(controlledDir);
    check(typeof baseHead === "string" && baseHead.length >= 40, "controlled workspace has a frozen Git HEAD");

    const createMain = await call(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: humanToken,
      key: `main-${randomUUID()}`,
      body: { task: "保持主线运行，允许并行探索" },
    });
    check(createMain.status === 201, "main task created through Core to real Runtime HTTP");
    const mainData = data(createMain.json);
    mainTaskId = String(mainData.task_id);
    await withTimeout("main model start", mainModel.started.promise);

    const mainRowResult = await pool.query(
      `SELECT id,runtime_agent_id,runtime_actor_id,status
         FROM agent_task WHERE id=$1 AND project_id=$2`,
      [mainTaskId, projectId],
    );
    const mainRow = mainRowResult.rows[0] as Record<string, unknown>;
    check(mainRow.runtime_agent_id === mainTaskId, "main Runtime registration is bound to the Core task id");
    check(mainRow.runtime_actor_id === "synthia-runtime", "main callback actor is the dedicated Runtime identity");
    check(mainRow.status === "running", "main remains running while its first model turn is blocked");

    const mainRunningEvent = await pool.query(
      `SELECT actor_type,actor_id,payload
         FROM task_conversation_event
        WHERE task_id=$1 AND event_kind='status' AND payload->>'status'='running'`,
      [mainTaskId],
    );
    check(
      mainRunningEvent.rows.some((row) => row.actor_type === "service" && row.actor_id === "synthia-runtime"),
      "main running callback reached Core over the task capability",
    );

    const sideKey = `side-${randomUUID()}`;
    const createSide = await call(`/api/v1/projects/${projectId}/tasks`, {
      method: "POST",
      token: humanToken,
      key: sideKey,
      body: {
        kind: "side",
        parent_task_id: mainTaskId,
        objective: "在隔离副本中修改 rtl/a.v，运行 validate_sources，等待确认后密封",
        base_commit: baseHead,
        authorization_scope: {
          schema: "task-scope.v1",
          workspace: "isolated",
          read_paths: ["rtl/**", "tb/**", "doc/**", "prj/constr/**"],
          write_paths: ["rtl/a.v"],
          run_classes: ["exploratory"],
          can_submit_gates: false,
          can_create_milestones: false,
          can_start_formal_runs: false,
        },
      },
    });
    check(
      createSide.status === 201,
      "side task registered, bound, and started through both real HTTP services",
      `status=${createSide.status} body=${JSON.stringify(createSide.json)}`,
    );
    const sideData = data(createSide.json);
    const sideTaskId = String(sideData.task_id);
    const workspaceId = String(sideData.workspace_id);

    const awaitingRow = await waitFor(
      "side awaiting_user",
      async () => (await pool.query(
        "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
        [sideTaskId, projectId],
      )).rows[0]?.status as string | undefined,
      (status) => status === "awaiting_user" || status === "failed" || status === "fail_closed",
    );
    check(awaitingRow === "awaiting_user", "ordinary side reply pauses at awaiting_user");

    const sideRowResult = await pool.query(
      `SELECT runtime_agent_id,runtime_actor_id,status,workspace_id
         FROM agent_task WHERE id=$1 AND project_id=$2`,
      [sideTaskId, projectId],
    );
    const sideRow = sideRowResult.rows[0] as Record<string, unknown>;
    check(
      sideRow.runtime_agent_id === sideTaskId && sideRow.runtime_actor_id === "synthia-runtime",
      "side Runtime binding is committed to the dedicated actor",
    );
    check(
      Number((await pool.query("SELECT count(*) FROM task_result WHERE task_id=$1", [sideTaskId])).rows[0]!.count) === 0,
      "awaiting_user does not create a premature task result",
    );

    const mainHeadDuringSide = await headSha(controlledDir);
    const mainRtlDuringSide = await readFile(join(controlledDir, "rtl/a.v"), "utf8");
    const isolatedRtl = await readFile(
      join(taskWorkspaceDir(projectId, workspaceId), "rtl/a.v"),
      "utf8",
    );
    check(mainHeadDuringSide === baseHead, "controlled workspace HEAD is unchanged before adoption");
    check(mainRtlDuringSide === ORIGINAL_RTL, "controlled workspace bytes are unchanged before adoption");
    check(isolatedRtl === MODIFIED_RTL, "RTL write occurred only in the isolated task clone");

    check(connector.submissions.length === 1, "one deterministic Connector job was submitted");
    const submission = connector.submissions[0]!;
    check(
      submission.actor.actorType === "service" && submission.actor.actorId === "synthia-runtime",
      "Connector submission is attributed to the task Runtime identity",
    );
    check(
      submission.runClass === "exploratory" && submission.parameters.sources[0]?.content === MODIFIED_RTL,
      "Connector compiled the isolated bytes with exploratory run class",
    );
    check(connector.statusQueries.length >= 1, "job status was polled through Core");
    check(connector.evidenceQueries.length >= 1, "job evidence manifest was fetched through Core");

    const runRowResult = await pool.query(
      "SELECT id,state,parameters,evidence FROM tool_run WHERE id=$1 AND project_id=$2",
      [submission.jobId, projectId],
    );
    const runRow = runRowResult.rows[0] as Record<string, unknown>;
    const runParameters = asRecord(runRow.parameters);
    const frozenEvidence = asRecord(runRow.evidence);
    check(
      runRow.state === "succeeded"
        && runParameters.taskId === sideTaskId
        && runParameters.workspaceId === workspaceId,
      "tool_run is terminal and bound to the exact task/workspace",
    );
    check(
      Array.isArray(frozenEvidence.entries) && frozenEvidence.entries.length === 1,
      "terminal evidence manifest is frozen on the Core tool_run",
    );

    const taskConnector = new CoreApiConnector({
      baseUrl: coreBase,
      token: taskToken,
      projectId,
      taskId: sideTaskId,
      workspaceId,
      pollIntervalMs: 1,
      retryDelayMs: 1,
    });
    const evidenceContent = await taskConnector.fetchEvidenceContent(submission.jobId, "compile.log");
    check(
      evidenceContent.content === EVIDENCE_BODY && evidenceContent.sha256 === EVIDENCE_SHA,
      "task-bound evidence content route returns verified content",
    );

    const genericTaskRoute = await call(
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/workspace/tree`,
      {
        token: genericToken,
        headers: {
          "x-synthia-task-id": sideTaskId,
          "x-synthia-workspace-id": workspaceId,
        },
      },
    );
    check(genericTaskRoute.status === 403, "ordinary service token cannot call task-only routes");

    const deniedGenericWrites = await Promise.all([
      call(`/api/v1/projects/${projectId}/workspace/files`, {
        method: "POST",
        token: taskToken,
        key: `deny-workspace-${randomUUID()}`,
        body: { files: [{ path: "rtl/a.v", content: "must not write" }] },
      }),
      call(`/api/v1/projects/${projectId}/jobs`, {
        method: "POST",
        token: taskToken,
        key: `deny-job-${randomUUID()}`,
        body: {
          operation: "validate_sources",
          run_class_intent: "exploratory",
          sources: [{ path: "rtl/a.v", content: ORIGINAL_RTL }],
        },
      }),
      call(`/api/v1/projects/${projectId}/snapshots`, {
        method: "POST",
        token: taskToken,
        key: `deny-snapshot-${randomUUID()}`,
        body: { id: `snapshot-${randomUUID()}` },
      }),
      call(`/api/v1/projects/${projectId}/gate-submissions`, {
        method: "POST",
        token: taskToken,
        key: `deny-gate-${randomUUID()}`,
        body: { id: `gate-${randomUUID()}` },
      }),
    ]);
    check(
      deniedGenericWrites.every((result) => result.status === 403),
      "task token cannot call generic workspace/job/snapshot/gate write routes",
    );

    const mixed = await call("/api/v1/projects", { token: mixedToken });
    check(mixed.status === 401, "mixed task-runtime and generic scopes are rejected at authentication");

    const messageKey = `side-message-${randomUUID()}`;
    const message = await call(`/api/v1/projects/${projectId}/tasks/${sideTaskId}/message`, {
      method: "POST",
      token: humanToken,
      key: messageKey,
      body: { text: "确认方案 A，请完成并密封。" },
    });
    check(message.status === 200, "Core forwarded the side follow-up message to Runtime");
    const replay = await call(`/api/v1/projects/${projectId}/tasks/${sideTaskId}/message`, {
      method: "POST",
      token: humanToken,
      key: messageKey,
      body: { text: "确认方案 A，请完成并密封。" },
    });
    check(
      replay.status === 200
        && JSON.stringify(data(replay.json)) === JSON.stringify(data(message.json)),
      "Core side-message forwarding replays idempotently",
      `first=${message.status}/${JSON.stringify(message.json)} replay=${replay.status}/${JSON.stringify(replay.json)}`,
    );

    const succeeded = await waitFor(
      "side succeeded",
      async () => (await pool.query(
        "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
        [sideTaskId, projectId],
      )).rows[0]?.status as string | undefined,
      (status) => status === "succeeded" || status === "failed" || status === "fail_closed",
    );
    check(succeeded === "succeeded", "completion tool seals the side task as succeeded");
    check(sideModel.calls.length === 5, "side model ran exactly one initial and one follow-up turn");

    const resultResponse = await call(
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/result`,
      { token: humanToken },
    );
    check(resultResponse.status === 200, "sealed side result is readable through Core HTTP");
    const resultData = data(resultResponse.json);
    const tests = resultData.tests as Array<Record<string, unknown>>;
    check(
      Array.isArray(tests)
        && tests.length === 1
        && tests[0]?.status === "passed"
        && tests[0]?.job_id === submission.jobId,
      "sealed tests are derived from the bound Core tool_run",
    );
    const resultCount = Number((await pool.query(
      "SELECT count(*) FROM task_result WHERE task_id=$1 AND project_id=$2",
      [sideTaskId, projectId],
    )).rows[0]!.count);
    const sealEvents = Number((await pool.query(
      "SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND event_type='side_task.result_sealed'",
      [sideTaskId],
    )).rows[0]!.count);
    check(resultCount === 1 && sealEvents === 1, "result and seal event are each persisted exactly once");

    const runtimeRegisterAndStart = (taskId: string) => {
      const register = httpRecords.findIndex((record) => (
        record.target === "runtime"
        && record.method === "POST"
        && record.path === "/tasks"
        && record.bodyTaskId === taskId
      ));
      const start = httpRecords.findIndex((record) => (
        record.target === "runtime"
        && record.method === "POST"
        && record.path === `/tasks/${taskId}/start`
      ));
      return { register, start };
    };
    const mainHttp = runtimeRegisterAndStart(mainTaskId);
    const sideHttp = runtimeRegisterAndStart(sideTaskId);
    check(
      mainHttp.register >= 0 && mainHttp.start > mainHttp.register
        && sideHttp.register >= 0 && sideHttp.start > sideHttp.register,
      "main and side both cross Runtime register then explicit start over HTTP",
    );

    const mainTaskCallbacks = httpRecords.filter((record) => (
      record.target === "core"
      && record.method === "POST"
      && record.path === `/api/v1/projects/${projectId}/tasks/${mainTaskId}/events`
    ));
    check(
      mainTaskCallbacks.length >= 1
        && mainTaskCallbacks.every((record) => record.auth === "task" && record.taskHeader === mainTaskId),
      "all main callbacks use the singleton task token and task header",
    );

    const requiredSideJobPaths = [
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/jobs`,
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/jobs/${submission.jobId}`,
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/jobs/${submission.jobId}/evidence`,
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/jobs/${submission.jobId}/evidence/content?name=compile.log`,
    ];
    check(
      requiredSideJobPaths.every((path) => httpRecords.some((record) => (
        record.target === "core"
        && record.path === path
        && record.auth === "task"
        && record.taskHeader === sideTaskId
        && record.workspaceHeader === workspaceId
      ))),
      "submit, poll, evidence, and content all use task-scoped HTTP routes",
    );

    const finalMainHead = await headSha(controlledDir);
    const finalMainRtl = await readFile(join(controlledDir, "rtl/a.v"), "utf8");
    check(
      finalMainHead === baseHead && finalMainRtl === ORIGINAL_RTL,
      "controlled workspace remains untouched after side result sealing and before adoption",
    );

    const diffResponse = await call(
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/diff`,
      { token: humanToken },
    );
    check(diffResponse.status === 200, "human can preview the sealed side-task diff");
    const diffData = data(diffResponse.json);
    const diffFiles = diffData.files as Array<Record<string, unknown>>;
    const selected = diffFiles.find((file) => file.path === "rtl/a.v");
    check(
      selected?.conflict_reason === null && selected.adopted === false,
      "sealed RTL proposal is conflict-free and available for adoption",
    );
    const adoptionBody = {
      adoption_id: `adopt-${randomUUID()}`,
      result_id: String(resultData.result_id),
      preview_hash: String(diffData.preview_hash),
      reason: "P3 real HTTP verification adoption",
      files: [{
        path: "rtl/a.v",
        expected_base_hash: selected!.base_hash,
        expected_proposed_hash: selected!.result_hash,
        expected_target_hash: selected!.current_target_hash,
      }],
    };
    const adoptionKey = `adopt-key-${randomUUID()}`;
    const adoption = await call(
      `/api/v1/projects/${projectId}/tasks/${sideTaskId}/adoptions`,
      {
        method: "POST",
        token: humanToken,
        key: adoptionKey,
        body: adoptionBody,
      },
    );
    check(adoption.status === 201, "human adoption applies through Core HTTP");
    const adoptionData = data(adoption.json);
    check(
      adoptionData.status === "applied"
        && Array.isArray(adoptionData.adopted_paths)
        && adoptionData.adopted_paths.length === 1,
      "adoption records exactly the selected side-task file",
    );
    const adoptedHead = await headSha(controlledDir);
    const adoptedRtl = await readFile(join(controlledDir, "rtl/a.v"), "utf8");
    check(
      adoptedHead !== baseHead && adoptedRtl === MODIFIED_RTL,
      "controlled workspace changes only after explicit human adoption",
    );

    mainModel.release.resolve();
    const mainTerminal = await waitFor(
      "main idle boundary after release",
      async () => (await pool.query(
        "SELECT status FROM agent_task WHERE id=$1 AND project_id=$2",
        [mainTaskId, projectId],
      )).rows[0]?.status as string | undefined,
      (status) => status === "awaiting_user" || status === "failed" || status === "fail_closed",
    );
    check(mainTerminal === "awaiting_user", "blocked main reaches its normal awaiting_user boundary after parallel side verification");

    const report = {
      outcome: "PASS",
      checks: checks.length,
      projectId,
      mainTaskId,
      sideTaskId,
      workspaceId,
      jobId: submission.jobId,
      sideModelCalls: sideModel.calls.length,
      connectorCalls: {
        submit: connector.submissions.length,
        status: connector.statusQueries.length,
        evidence: connector.evidenceQueries.length,
        content: connector.contentQueries.length,
      },
      taskScopedHttpCalls: httpRecords.filter((record) => (
        record.target === "core" && record.auth === "task"
      )).length,
      checkLabels: checks,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    mainModel.release.resolve();
    globalThis.fetch = ORIGINAL_FETCH;
    core?.stop();
    await runtime?.stop().catch(() => {});
    await pool.end().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
