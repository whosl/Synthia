/**
 * `VITE_MOCK=1` 的离线后端：一层 `fetch` 拦截器。
 *
 * 为什么是拦截 `fetch` 而不是换掉 `api/client.ts`：
 * 对话流的 SSE 走的是 `domain/task-stream.ts` 里的裸 `fetch`（Core 鉴权是 Bearer
 * 头，原生 EventSource 带不了自定义头），不经过 ApiClient。拦 `fetch` 一处就同时
 * 盖住 REST 与 SSE，而且真实的 client 仍在跑——信封解包、401 跳登录这些逻辑照样
 * 被走一遍，不会因为 mock 而绕过。
 *
 * 只接管 `/api/v1/**`，其它请求（Vite HMR、Monaco worker、静态资源）原样放行。
 */

import {
  LIVE_AGENT_ID,
  MOCK_ARTIFACTS,
  MOCK_CONTENT,
  MOCK_LEGACY_PROJECT,
  MOCK_PROCESS_VERSIONS,
  MOCK_PROJECT,
  MOCK_REVISIONS,
  IMPLEMENT_NARRATION,
  IMPLEMENT_NARRATION_TEXT,
  mockJobEvidenceContent,
  mockAgentDetail,
  mockAgents,
  mockState,
  persistCreatedMockProjects,
} from "./data.ts";
import type { CreateProjectResult, ProcessInstance, Project, ProjectDetail } from "../api/types.ts";

/** 假装有网络：让 loading 态真的能被看见，而不是同步瞬间填满。 */
const LATENCY_MS = 80;
/** SSE 每块文本的间隔（打字机手感）。 */
const DELTA_INTERVAL_MS = 700;
/** 浏览器验收可用同名本地值或 `?mockProcessVersions=error` 验证 UI fail closed。 */
export const MOCK_PROCESS_VERSIONS_MODE_KEY = "synthia.mock.process-versions-mode";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function processVersionsMode(): string | null {
  try {
    const queryMode = typeof globalThis.location === "undefined"
      ? null
      : new URLSearchParams(globalThis.location.search).get("mockProcessVersions");
    if (queryMode) return queryMode;
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage.getItem(MOCK_PROCESS_VERSIONS_MODE_KEY);
  } catch {
    return null;
  }
}

function ok<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ data, correlation_id: `mock-${Date.now().toString(36)}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, retryable: false, details: null, correlation_id: "mock" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function allProjects(): readonly ProjectDetail[] {
  return [...mockState.createdProjects, MOCK_PROJECT, MOCK_LEGACY_PROJECT];
}

function findProject(projectId: string): ProjectDetail | null {
  return allProjects().find((project) => project.id === projectId) ?? null;
}

function projectSummary(project: ProjectDetail): Project {
  const { scope, standard_version, toolchain_profile_ref, ...summary } = project;
  void scope;
  void standard_version;
  void toolchain_profile_ref;
  return summary;
}

function createResult(project: ProjectDetail): CreateProjectResult {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    project_type: project.project_type,
    process_version_id: project.process_version_id,
    process_profile_id: project.process_profile_id,
    process_profile_version: project.process_profile_version,
    process_profile_name: project.process_profile_name,
    target_part: project.target_part,
    process_instances: project.process_instances,
  };
}

function createMockProject(body: unknown): Response {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "validation", "创建项目请求必须是对象");
  }
  const request = body as Record<string, unknown>;
  const id = typeof request.id === "string" ? request.id.trim() : "";
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (!id) return fail(400, "validation", "项目 id 必填");
  if (!name) return fail(400, "validation", "项目名称必填");
  if (findProject(id)) return fail(409, "PROJECT_ALREADY_EXISTS_DIFFERENT_PAYLOAD", `项目 ${id} 已存在`);

  const projectType = request.project_type;
  if (projectType !== "free" && projectType !== "engineering") {
    return fail(400, "validation", "project_type 必须是 free 或 engineering");
  }

  const requestedProfile = request.process_profile_id;
  const profile = typeof requestedProfile === "string"
    ? MOCK_PROCESS_VERSIONS.find((version) => version.id === requestedProfile)
    : undefined;
  if (projectType === "engineering" && !profile) {
    return fail(400, "validation", "工程项目必须选择 Core 返回的 active 流程版本");
  }
  if (projectType === "free" && requestedProfile !== undefined && requestedProfile !== null) {
    return fail(400, "validation", "自由项目不能绑定流程版本");
  }

  const rawTargetPart = request.target_part;
  if (rawTargetPart !== undefined && rawTargetPart !== null && typeof rawTargetPart !== "string") {
    return fail(400, "validation", "target_part 必须是字符串或 null");
  }
  const targetPart = typeof rawTargetPart === "string" && rawTargetPart.trim() ? rawTargetPart.trim() : null;
  const createdAt = new Date().toISOString();
  const processInstances: readonly ProcessInstance[] = profile
    ? [{ id: `pi_${id}_G0`, gate_profile_version: profile.id, current_gate: "G0", created_at: createdAt }]
    : [];
  const project: ProjectDetail = {
    id,
    name,
    status: "active",
    data_classification: typeof request.data_classification === "string" ? request.data_classification : "D1",
    created_at: createdAt,
    project_type: projectType,
    process_version_id: profile?.id ?? null,
    process_profile_id: profile?.process_profile_id ?? null,
    process_profile_version: profile?.process_profile_version ?? null,
    process_profile_name: profile?.process_profile_name ?? null,
    target_part: targetPart,
    process_instances: processInstances,
    scope: "",
    standard_version: "GB/T 33781-2017",
    toolchain_profile_ref: null,
  };
  mockState.createdProjects.unshift(project);
  persistCreatedMockProjects();
  return ok(createResult(project), 201);
}

function copyMockProjectAsEngineering(sourceProjectId: string, body: unknown): Response {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "validation", "复制请求必须是对象");
  }
  const source = findProject(sourceProjectId);
  if (!source) return fail(404, "not_found", `项目 ${sourceProjectId} 不存在`);
  const sourceEligible = source.project_type === "free" || source.process_profile_id === "LEGACY_COMPAT";
  if (!sourceEligible) return fail(409, "PROJECT_COPY_SOURCE_NOT_ELIGIBLE", "只有自由或兼容旧流程项目可以正式化");
  const request = body as Record<string, unknown>;
  const id = typeof request.id === "string" ? request.id.trim() : "";
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (!id || !name) return fail(400, "validation", "复制目标 id 和名称必填");
  if (findProject(id)) return fail(409, "PROJECT_ALREADY_EXISTS_DIFFERENT_PAYLOAD", `项目 ${id} 已存在`);
  const rawTarget = request.target_part;
  if (rawTarget !== undefined && rawTarget !== null && typeof rawTarget !== "string") {
    return fail(400, "validation", "target_part 必须是字符串或 null");
  }
  const targetPart = rawTarget === undefined ? source.target_part : (typeof rawTarget === "string" && rawTarget.trim() ? rawTarget.trim() : null);
  const createdAt = new Date().toISOString();
  const project: ProjectDetail = {
    id,
    name,
    status: "active",
    data_classification: source.data_classification,
    created_at: createdAt,
    project_type: "engineering",
    process_version_id: "GJB_REF_V1",
    process_profile_id: "GJB_REF_V1",
    process_profile_version: "GJB_REF_V1",
    process_profile_name: "GJB 参考流程 v1",
    target_part: targetPart,
    process_instances: [{ id: `pi_${id}_G0`, gate_profile_version: "GJB_REF_V1", current_gate: "G0", created_at: createdAt }],
    source_relation: {
      source_project_id: sourceProjectId,
      target_project_id: id,
      relation_kind: "copied_as_engineering",
      created_by_type: "human",
      created_by: "mock-user",
      created_at: createdAt,
    },
    scope: source.scope,
    standard_version: source.standard_version,
    toolchain_profile_ref: source.toolchain_profile_ref,
  };
  mockState.createdProjects.unshift(project);
  persistCreatedMockProjects();
  return ok({ ...createResult(project), source_relation: project.source_relation, workspace_content_copied: false }, 201);
}

function sseFrame(event: string, id: number, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 实现阶段的流式叙述。
 *
 * 播完最后一块后把 run 翻成 succeeded 再发 `status`/`done`——顺序反了的话前端会
 * 在 run 还是 running 的时候刷新，成功卡不出来。已完成的 run（或重新订阅的老 run）
 * 只发保活注释，模拟 Core 那边的空闲长连接。
 */
function liveStream(agentId: string, signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      const send = (event: string, data: unknown): void => {
        if (stopped) return;
        seq += 1;
        controller.enqueue(encoder.encode(sseFrame(event, seq, data)));
      };
      const wait = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms);
        });

      const partId = `sp-implement-${agentId}`;
      if (agentId === LIVE_AGENT_ID && !mockState.agentBDone) {
        send("part", { part: { kind: "text", id: partId, state: "streaming", text: "" } });
        for (const chunk of IMPLEMENT_NARRATION) {
          await wait(DELTA_INTERVAL_MS);
          if (stopped) return;
          send("delta", { partId, text: chunk });
        }
        await wait(DELTA_INTERVAL_MS);
        if (stopped) return;
        send("part", { part: { kind: "text", id: partId, state: "done", text: IMPLEMENT_NARRATION_TEXT } });
        mockState.agentBDone = true;
        send("status", { status: "succeeded" });
        send("done", { reply: IMPLEMENT_NARRATION_TEXT });
      }

      // 空闲保活：不主动断流，避免前端进入退避重连。
      for (;;) {
        await wait(15_000);
        if (stopped) return;
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });

  signal?.addEventListener("abort", () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function route(pathname: string, method: string, body: unknown, signal: AbortSignal | null | undefined, searchParams: URLSearchParams): Promise<Response | null> {
  const seg = pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  if (seg.length === 1 && seg[0] === "process-versions" && method === "GET") {
    if (processVersionsMode() === "error") {
      return fail(503, "process_registry_unavailable", "Core 流程注册表暂不可用");
    }
    return ok(MOCK_PROCESS_VERSIONS);
  }

  // /projects
  if (seg.length === 1 && seg[0] === "projects" && method === "GET") {
    return ok(allProjects().map(projectSummary));
  }
  if (seg.length === 1 && seg[0] === "projects" && method === "POST") {
    return createMockProject(body);
  }
  if (seg[0] !== "projects" || seg.length < 2) return null;

  const projectId = seg[1]!;
  const project = findProject(projectId);
  if (!project) return fail(404, "not_found", `项目 ${projectId} 不存在`);
  const fixtureProject = projectId === MOCK_PROJECT.id;
  const rest = seg.slice(2);

  // /projects/:id
  if (rest.length === 0 && method === "GET") return ok(project);

  if (rest.length === 1 && rest[0] === "copy-as-engineering" && method === "POST") {
    return copyMockProjectAsEngineering(projectId, body);
  }

  if (rest[0] === "gate-submissions" && rest.length === 1 && method === "GET") return ok([]);

  // /projects/:id/artifacts[/:aid/revisions[/:rid/content]]
  if (rest[0] === "artifacts") {
    if (rest.length === 1 && method === "GET") return ok(fixtureProject ? MOCK_ARTIFACTS : []);
    if (!fixtureProject) return fail(404, "not_found", "artifact 不存在");
    const artifactId = rest[1]!;
    const revisions = MOCK_REVISIONS[artifactId];
    if (!revisions) return fail(404, "not_found", "artifact 不存在");
    if (rest.length === 3 && rest[2] === "revisions" && method === "GET") return ok(revisions);
    if (rest.length === 5 && rest[2] === "revisions" && rest[4] === "content" && method === "GET") {
      const revision = revisions.find((r) => r.id === rest[3]);
      const content = revision ? MOCK_CONTENT[revision.id] : undefined;
      if (!revision || content === undefined) return fail(404, "not_found", "修订不存在");
      return ok({ content, content_hash: revision.content_hash });
    }
    return null;
  }

  // /projects/:id/tasks[/:agentId[/message|abort|stream]]
  if (rest[0] === "tasks") {
    if (rest.length === 1) {
      if (method === "GET") return ok({ agents: fixtureProject ? mockAgents() : [] });
      if (method === "POST") {
        if (!fixtureProject) return fail(501, "mock_unsupported", "新建项目的离线 Agent 尚未实现");
        // mock 不真的开新 run：把指令回显到当前活动 run 上，并说明这是离线模式。
        const text = String((body as { task?: unknown } | null)?.task ?? "");
        mockState.extraUserMessages.push({ agentId: LIVE_AGENT_ID, text, ts: new Date().toISOString() });
        return ok({ agentId: LIVE_AGENT_ID });
      }
      return null;
    }
    if (!fixtureProject) return fail(404, "not_found", "run 不存在");
    const agentId = rest[1]!;
    if (rest.length === 2 && method === "GET") {
      const detail = mockAgentDetail(agentId);
      return detail ? ok(detail) : fail(404, "not_found", "run 不存在");
    }
    if (rest.length === 3 && rest[2] === "stream" && method === "GET") return liveStream(agentId, signal);
    if (rest.length === 3 && rest[2] === "message" && method === "POST") {
      const text = String((body as { text?: unknown } | null)?.text ?? "");
      mockState.extraUserMessages.push({ agentId, text, ts: new Date().toISOString() });
      const status = mockAgentDetail(agentId)?.status ?? "idle";
      return ok({ steered: status === "running", status });
    }
    if (rest.length === 3 && rest[2] === "abort" && method === "POST") {
      mockState.agentBDone = true;
      return ok({ aborted: true, status: "interrupted" });
    }
    return null;
  }

  // /projects/:id/jobs/:jobId/evidence/content?name=
  if (rest[0] === "jobs" && rest.length === 4 && rest[2] === "evidence" && rest[3] === "content" && method === "GET") {
    const jobId = rest[1]!;
    const name = searchParams.get("name") ?? "";
    const content = mockJobEvidenceContent(jobId, name);
    if (!content) return fail(404, "not_found", "证据条目不存在或已被清理");
    return ok(content);
  }

  return null;
}

let installed = false;

/**
 * 单次 mock 请求处理。导出后测试可以走与浏览器完全相同的信封/路由逻辑，
 * 同时不必永久替换测试进程的 globalThis.fetch。
 */
export async function mockApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname, searchParams } = new URL(url, "http://mock.local");
  if (!pathname.startsWith("/api/v1")) return null;

  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
  }

  // SSE 不加人为延迟：它本来就是长连接。
  const isStream = pathname.endsWith("/stream");
  if (!isStream) await sleep(LATENCY_MS);

  const res = await route(pathname, method, body, init?.signal, searchParams);
  return res ?? fail(404, "not_found", `mock 未实现该端点：${method} ${pathname}`);
}

/** 安装拦截器（幂等）。仅在 `import.meta.env.VITE_MOCK === "1"` 时由 main.ts 调用。 */
export function installMockServer(): void {
  if (installed) return;
  installed = true;

  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await mockApiFetch(input, init);
    return res ?? realFetch(input, init);
  };

  // eslint-disable-next-line no-console
  console.info(
    "[mock] 离线模式已启用：/api/v1/** 由 src/mock 接管。数据是 worker-66 真机 Vivado 产物快照；没有模型后端，对话不会有真回复。",
  );
}
