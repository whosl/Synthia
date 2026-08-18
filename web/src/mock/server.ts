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
  LIVE_RUN_ID,
  MOCK_ARTIFACTS,
  MOCK_CONTENT,
  MOCK_PROJECT,
  MOCK_REVISIONS,
  IMPLEMENT_NARRATION,
  IMPLEMENT_NARRATION_TEXT,
  mockJobEvidenceContent,
  mockRunDetail,
  mockRuns,
  mockState,
} from "./data.ts";

/** 假装有网络：让 loading 态真的能被看见，而不是同步瞬间填满。 */
const LATENCY_MS = 80;
/** SSE 每块文本的间隔（打字机手感）。 */
const DELTA_INTERVAL_MS = 700;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ok<T>(data: T): Response {
  return new Response(JSON.stringify({ data, correlation_id: `mock-${Date.now().toString(36)}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, retryable: false, details: null, correlation_id: "mock" } }),
    { status, headers: { "content-type": "application/json" } },
  );
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
function liveStream(runId: string, signal: AbortSignal | null | undefined): Response {
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

      const partId = `sp-implement-${runId}`;
      if (runId === LIVE_RUN_ID && !mockState.runBDone) {
        send("part", { part: { kind: "text", id: partId, state: "streaming", text: "" } });
        for (const chunk of IMPLEMENT_NARRATION) {
          await wait(DELTA_INTERVAL_MS);
          if (stopped) return;
          send("delta", { partId, text: chunk });
        }
        await wait(DELTA_INTERVAL_MS);
        if (stopped) return;
        send("part", { part: { kind: "text", id: partId, state: "done", text: IMPLEMENT_NARRATION_TEXT } });
        mockState.runBDone = true;
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

  // /projects
  if (seg.length === 1 && seg[0] === "projects" && method === "GET") {
    const { scope, standard_version, target_part, toolchain_profile_ref, process_instances, ...plain } = MOCK_PROJECT;
    void scope; void standard_version; void target_part; void toolchain_profile_ref; void process_instances;
    return ok([plain]);
  }
  if (seg[0] !== "projects" || seg.length < 2) return null;

  const projectId = seg[1]!;
  if (projectId !== MOCK_PROJECT.id) return fail(404, "not_found", `mock 只有项目 ${MOCK_PROJECT.id}`);
  const rest = seg.slice(2);

  // /projects/:id
  if (rest.length === 0 && method === "GET") return ok(MOCK_PROJECT);

  // /projects/:id/artifacts[/:aid/revisions[/:rid/content]]
  if (rest[0] === "artifacts") {
    if (rest.length === 1 && method === "GET") return ok(MOCK_ARTIFACTS);
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

  // /projects/:id/tasks[/:runId[/message|abort|stream]]
  if (rest[0] === "tasks") {
    if (rest.length === 1) {
      if (method === "GET") return ok({ runs: mockRuns() });
      if (method === "POST") {
        // mock 不真的开新 run：把指令回显到当前活动 run 上，并说明这是离线模式。
        const text = String((body as { task?: unknown } | null)?.task ?? "");
        mockState.extraUserMessages.push({ runId: LIVE_RUN_ID, text, ts: new Date().toISOString() });
        return ok({ runId: LIVE_RUN_ID });
      }
      return null;
    }
    const runId = rest[1]!;
    if (rest.length === 2 && method === "GET") {
      const detail = mockRunDetail(runId);
      return detail ? ok(detail) : fail(404, "not_found", "run 不存在");
    }
    if (rest.length === 3 && rest[2] === "stream" && method === "GET") return liveStream(runId, signal);
    if (rest.length === 3 && rest[2] === "message" && method === "POST") {
      const text = String((body as { text?: unknown } | null)?.text ?? "");
      mockState.extraUserMessages.push({ runId, text, ts: new Date().toISOString() });
      const status = mockRunDetail(runId)?.status ?? "idle";
      return ok({ steered: status === "running", status });
    }
    if (rest.length === 3 && rest[2] === "abort" && method === "POST") {
      mockState.runBDone = true;
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

/** 安装拦截器（幂等）。仅在 `import.meta.env.VITE_MOCK === "1"` 时由 main.ts 调用。 */
export function installMockServer(): void {
  if (installed) return;
  installed = true;

  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { pathname, searchParams } = new URL(url, window.location.origin);
    if (!pathname.startsWith("/api/v1")) return realFetch(input, init);

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
    if (res) return res;
    return fail(404, "not_found", `mock 未实现该端点：${method} ${pathname}`);
  };

  // eslint-disable-next-line no-console
  console.info(
    "[mock] 离线模式已启用：/api/v1/** 由 src/mock 接管。数据是 worker-66 真机 Vivado 产物快照；没有模型后端，对话不会有真回复。",
  );
}
