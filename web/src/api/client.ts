/**
 * Core API 统一 fetch 封装。
 *
 * - 信封：成功 `{ data, correlation_id }`；失败 `{ error: { code, message, retryable, details, correlation_id } }`。
 * - base URL 可配：`import.meta.env.VITE_API_BASE_URL`（缺省空串 = 同源，dev 由 vite proxy 转发 /api → 127.0.0.1:8787）。
 * - Authorization 由注入的 tokenProvider 提供（sessionStorage），client 本身不依赖 store/router，便于测试。
 * - 401：清 token 并回调 onUnauthorized（跳登录）；403：抛 ApiError，由界面显示「无权限」。
 */

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: unknown;
  readonly correlation_id: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = "ApiError";
  }

  get code(): string {
    return this.body.code;
  }

  get correlationId(): string {
    return this.body.correlation_id;
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("网络请求失败：无法连接 Core API");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly tokenProvider?: () => string | null;
  readonly onUnauthorized?: () => void;
  readonly fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const UNKNOWN_ERROR_BODY: ApiErrorBody = {
  code: "internal",
  message: "服务返回了无法解析的错误",
  retryable: true,
  details: null,
  correlation_id: "",
};

function isErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as ApiErrorBody).code === "string" &&
    typeof (v as ApiErrorBody).message === "string"
  );
}

/** 解析响应信封：成功取 data，失败抛 ApiError。导出以便单测。 */
export async function unwrapEnvelope<T>(response: Response): Promise<T> {
  let parsed: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.ok) {
    if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
      return (parsed as { data: T }).data;
    }
    throw new ApiError(response.status, { ...UNKNOWN_ERROR_BODY, message: "服务响应缺少 data 信封" });
  }

  const errBody =
    typeof parsed === "object" && parsed !== null && "error" in parsed && isErrorBody((parsed as { error: unknown }).error)
      ? (parsed as { error: ApiErrorBody }).error
      : { ...UNKNOWN_ERROR_BODY };
  throw new ApiError(response.status, errBody);
}

export function createClient(options: ClientOptions = {}) {
  const baseUrl = options.baseUrl ?? ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function request<T>(path: string, req: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    const token = options.tokenProvider?.() ?? null;
    if (token) headers.authorization = `Bearer ${token}`;
    if (req.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: req.method ?? "GET",
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
    } catch (err) {
      throw new NetworkError(err);
    }

    if (response.status === 401) {
      options.onUnauthorized?.();
    }
    return unwrapEnvelope<T>(response);
  };
}

export type ApiClient = ReturnType<typeof createClient>;
