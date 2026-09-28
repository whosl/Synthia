import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { Readable } from "node:stream";

/** The subset of Bun.serve's result the API server relies on. */
export interface FetchServer {
  readonly port: number;
  readonly hostname: string;
  stop(force?: boolean): void;
}

export interface ServeFetchOptions {
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly port: number;
  /** 与 Bun.serve 一致：缺省 0.0.0.0。core 显式传 127.0.0.1（本机语义）。 */
  readonly hostname?: string;
  /** Bun-only connection idle budget; the Node branch disables request timeouts instead (SSE survival is the point). */
  readonly idleTimeout?: number;
}

type BunServe = (options: {
  port: number;
  hostname: string;
  idleTimeout?: number;
  fetch: (request: Request) => Response | Promise<Response>;
}) => { port: number; hostname: string; stop: (force?: boolean) => void };

/**
 * Cross-runtime `Bun.serve` replacement. Under Bun the call is forwarded
 * verbatim (identical behavior, including synchronous binding for port 0);
 * under Node a `node:http` server bridges IncomingMessage/ServerResponse to
 * web Request/Response. The Node bridge:
 *  - streams request and response bodies (SSE task streams pass through),
 *  - aborts `request.signal` when the client disconnects (the SSE proxy in
 *    task-proxy.ts relies on it to stop upstream forwarding),
 *  - disables requestTimeout (Node's 300 s default would cut long streams;
 *    keepalive remains the Runtime heartbeat's job, same as on Bun).
 */
export function serveFetch(options: ServeFetchOptions): FetchServer {
  const bunServe = (globalThis as { Bun?: { serve: BunServe } }).Bun?.serve;
  if (bunServe !== undefined) {
    const server = bunServe({
      port: options.port,
      hostname: options.hostname ?? "0.0.0.0",
      ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
      fetch: options.fetch,
    });
    return { port: server.port, hostname: server.hostname, stop: force => server.stop(force) };
  }
  return serveNodeHttp(options);
}

function serveNodeHttp(options: ServeFetchOptions): FetchServer {
  if (!(options.port > 0)) {
    throw new Error("SYNTHIA_COMPAT: the node:http bridge requires an explicit port (port 0 needs Bun)");
  }
  const server: HttpServer = createServer((req, res) => {
    void handleNodeRequest(options, req, res);
  });
  // Long-lived SSE responses must outlive Node's 300 s requestTimeout default.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  const hostname = options.hostname ?? "0.0.0.0";
  server.listen(options.port, hostname);
  return {
    port: options.port,
    hostname,
    stop: () => {
      server.closeAllConnections?.();
      server.close(() => undefined);
    },
  };
}

async function handleNodeRequest(options: ServeFetchOptions, req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const host = typeof req.headers.host === "string" ? req.headers.host : `${options.hostname}:${options.port}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const abort = new AbortController();
  res.once("close", () => { if (res.writableEnded === false) abort.abort(); });
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) { for (const item of value) headers.append(name, item); }
      else headers.set(name, value);
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, {
      method,
      headers,
      redirect: "manual",
      signal: abort.signal,
      ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" } : {}),
    });
    const response = await options.fetch(request);
    if (abort.signal.aborted) return;
    // Headers iteration folds repeated set-cookie with ", " (invalid for
    // cookies); undici exposes them separately via getSetCookie.
    const headerMap = new Map<string, string[]>();
    for (const [name, value] of response.headers) {
      const key = name.toLowerCase();
      if (key === "set-cookie") continue;
      const list = headerMap.get(key) ?? [];
      list.push(value);
      headerMap.set(key, list);
    }
    const setCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [key, list] of headerMap) responseHeaders[key] = list.length === 1 ? list[0]! : list;
    if (setCookie.length > 0) responseHeaders["set-cookie"] = setCookie;
    res.writeHead(response.status, responseHeaders);
    if (response.body === null || response.status === 204 || response.status === 304) {
      res.end();
      return;
    }
    // Flush headers immediately so SSE clients see the response before the first chunk.
    res.flushHeaders();
    const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
    body.on("error", () => { res.destroy(); });
    body.pipe(res);
  } catch {
    if (res.headersSent === false) res.writeHead(500, { "content-type": "application/json" });
    if (res.writableEnded === false) res.end(JSON.stringify({ error_code: "INTERNAL" }));
    res.destroy();
  }
}
