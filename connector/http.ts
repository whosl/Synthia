import { EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER, EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER, EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER, RemoteConnectorClient, RemoteConnectorError, type RemoteEnvelope, type RemoteResponse, type RemoteTransport, type RemoteClientOptions } from "./remote.ts";

export interface CloudflareAccessToken {
  clientId: string;
  clientSecret: string;
}

export type CloudflareAccessTokenProvider = () => Promise<CloudflareAccessToken>;
export type SecretResolver = (reference: string) => Promise<string> | string;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CloudflareAccessTokenProviderOptions {
  clientIdRef: string;
  clientSecretRef: string;
  resolve: SecretResolver;
}

export interface EnvironmentSecretNames {
  clientId?: string;
  clientSecret?: string;
}

export function createEnvironmentSecretResolver(env: Record<string, string | undefined> = process.env): SecretResolver {
  return (reference: string): string => {
    const match = /^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
    if (!match) throw new RemoteConnectorError("SECRET_REFERENCE_UNSUPPORTED");
    const value = env[match[1]!];
    if (!value) throw new RemoteConnectorError("SECRET_UNAVAILABLE");
    return value;
  };
}

function requiredReference(value: string, name: string): string {
  if (typeof value !== "string" || !/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new RemoteConnectorError("CONFIG_INVALID", `${name} must be an env:// reference`);
  }
  return value;
}

function headerValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) {
    throw new RemoteConnectorError("SECRET_INVALID", `${name} is invalid`);
  }
  return value;
}

const CONTROLLED_REQUEST_HEADERS = new Map<string, RegExp>([
  [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER, /^[0-9a-f]{64}$/],
  [EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
  [EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER, /^[0-9a-f]{64}$/],
]);

function mergeControlledRequestHeaders(
  target: Record<string, string>,
  supplied: Readonly<Record<string, string>> | undefined,
): void {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(supplied ?? {})) {
    const normalized = name.toLowerCase();
    const pattern = CONTROLLED_REQUEST_HEADERS.get(normalized);
    if (!pattern || seen.has(normalized)) {
      throw new RemoteConnectorError("REMOTE_HEADER_FORBIDDEN", `${name} is not an allowed remote header`);
    }
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new RemoteConnectorError("REMOTE_HEADER_INVALID", `${name} is invalid`);
    }
    seen.add(normalized);
    target[normalized] = value;
  }
}

export function createCloudflareAccessTokenProvider(options: CloudflareAccessTokenProviderOptions): CloudflareAccessTokenProvider {
  const clientIdRef = requiredReference(options.clientIdRef, "clientIdRef");
  const clientSecretRef = requiredReference(options.clientSecretRef, "clientSecretRef");
  return async () => {
    try {
      const [clientId, clientSecret] = await Promise.all([
        options.resolve(clientIdRef),
        options.resolve(clientSecretRef),
      ]);
      return {
        clientId: headerValue(clientId, "clientId"),
        clientSecret: headerValue(clientSecret, "clientSecret"),
      };
    } catch (error) {
      if (error instanceof RemoteConnectorError && ["SECRET_INVALID", "SECRET_UNAVAILABLE", "SECRET_REFERENCE_UNSUPPORTED"].includes(error.code)) throw error;
      throw new RemoteConnectorError("SECRET_UNAVAILABLE");
    }
  };
}

export function createEnvironmentCloudflareAccessTokenProvider(
  env: Record<string, string | undefined> = process.env,
  names: EnvironmentSecretNames = {},
): CloudflareAccessTokenProvider {
  const clientId = names.clientId ?? "SYNTHIA_CF_ACCESS_CLIENT_ID";
  const clientSecret = names.clientSecret ?? "SYNTHIA_CF_ACCESS_CLIENT_SECRET";
  return createCloudflareAccessTokenProvider({
    clientIdRef: `env://${clientId}`,
    clientSecretRef: `env://${clientSecret}`,
    resolve: createEnvironmentSecretResolver(env),
  });
}

export interface CloudflareRemoteTransportOptions {
  endpointUrl: string;
  tokenProvider: CloudflareAccessTokenProvider;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface DirectMtlsRemoteTransportOptions {
  endpointUrl: string;
  ca: string;
  cert: string;
  key: string;
  fetchImpl?: (input: string | URL, init?: BunFetchRequestInit) => Promise<Response>;
  timeoutMs?: number;
}

function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteConnectorError("CONFIG_INVALID", "endpointUrl malformed");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RemoteConnectorError("CONFIG_INVALID", "endpointUrl must be a plain HTTPS origin");
  }
  return url;
}

function requestUrl(base: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) throw new RemoteConnectorError("CONFIG_INVALID", "remote path must be absolute");
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new RemoteConnectorError("CONFIG_INVALID", "remote path escaped endpoint origin");
  return url;
}

function parseResponse(status: number, text: string): RemoteEnvelope<unknown> | { error_code: string; message?: string } {
  if (!text.trim()) return { error_code: status === 403 ? "ACCESS_DENIED" : "REMOTE_PROTOCOL_ERROR" };
  try {
    return JSON.parse(text) as RemoteEnvelope<unknown> | { error_code: string; message?: string };
  } catch {
    return { error_code: status === 403 ? "ACCESS_DENIED" : "REMOTE_PROTOCOL_ERROR" };
  }
}

export class CloudflareRemoteTransport implements RemoteTransport {
  private readonly base: URL;
  private readonly tokenProvider: CloudflareAccessTokenProvider;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: CloudflareRemoteTransportOptions) {
    this.base = endpoint(options.endpointUrl);
    this.tokenProvider = options.tokenProvider;
    this.fetcher = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new RemoteConnectorError("CONFIG_INVALID", "timeoutMs invalid");
  }

  async request(path: string, request: {
    method: "POST" | "GET";
    body?: RemoteEnvelope<unknown>;
    headers?: Readonly<Record<string, string>>;
  }): Promise<RemoteResponse<unknown>> {
    const url = requestUrl(this.base, path);
    const token = await this.tokenProvider();
    const headers: Record<string, string> = {
      accept: "application/json",
      "CF-Access-Client-Id": headerValue(token.clientId, "clientId"),
      "CF-Access-Client-Secret": headerValue(token.clientSecret, "clientSecret"),
    };
    const init: RequestInit = { method: request.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    mergeControlledRequestHeaders(headers, request.headers);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, init);
      // The timeout signal remains active while the body is consumed. A slow
      // or interrupted Cloudflare tunnel can therefore reject response.text()
      // after fetch() itself has already resolved; normalize both phases to
      // the same retryable transport error.
      text = await response.text();
    } catch {
      throw new RemoteConnectorError("REMOTE_UNAVAILABLE", "remote request failed", true);
    }
    return { status: response.status, body: parseResponse(response.status, text) };
  }

  async requestStream(
    path: string,
    request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown> },
  ): Promise<{ readonly status: number; readonly headers: Headers; readonly body: ReadableStream<Uint8Array> | null }> {
    const url = requestUrl(this.base, path);
    const token = await this.tokenProvider();
    const headers: Record<string, string> = {
      accept: "application/octet-stream, application/json",
      "CF-Access-Client-Id": headerValue(token.clientId, "clientId"),
      "CF-Access-Client-Secret": headerValue(token.clientSecret, "clientSecret"),
    };
    const init: RequestInit = { method: request.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    try {
      const response = await this.fetcher(url, init);
      return { status: response.status, headers: response.headers, body: response.body };
    } catch {
      throw new RemoteConnectorError("REMOTE_UNAVAILABLE", "remote request failed", true);
    }
  }
}

export function createCloudflareRemoteTransport(options: CloudflareRemoteTransportOptions): CloudflareRemoteTransport {
  return new CloudflareRemoteTransport(options);
}

function requiredTlsMaterial(
  value: string,
  name: "ca" | "cert" | "key",
): string {
  const size = Buffer.byteLength(value);
  if (size < 1 || size > 1024 * 1024) {
    throw new RemoteConnectorError("CONFIG_INVALID", `${name} TLS material is invalid`);
  }
  return value;
}

/**
 * Strict direct-mTLS transport used only by the isolated M4-F 18443 sidecar.
 * Unlike the Cloudflare transport, the client certificate is presented by
 * this process and the target certificate is verified against the supplied
 * private CA. Certificate verification can never be disabled through this API.
 */
export class DirectMtlsRemoteTransport implements RemoteTransport {
  private readonly base: URL;
  private readonly fetcher: (input: string | URL, init?: BunFetchRequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly tls: BunFetchRequestInitTLS;

  constructor(options: DirectMtlsRemoteTransportOptions) {
    this.base = endpoint(options.endpointUrl);
    if (this.base.pathname !== "/" || this.base.origin !== options.endpointUrl) {
      throw new RemoteConnectorError("CONFIG_INVALID", "endpointUrl must be an exact HTTPS origin");
    }
    if (this.base.hostname !== "100.96.223.49" || this.base.port !== "18443") {
      throw new RemoteConnectorError(
        "ENDPOINT_NOT_ALLOWLISTED",
        "direct M4-F mTLS is restricted to 100.96.223.49:18443",
      );
    }
    this.fetcher = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RemoteConnectorError("CONFIG_INVALID", "timeoutMs invalid");
    }
    this.tls = Object.freeze({
      ca: requiredTlsMaterial(options.ca, "ca"),
      cert: requiredTlsMaterial(options.cert, "cert"),
      key: requiredTlsMaterial(options.key, "key"),
      rejectUnauthorized: true,
    });
  }

  async request(path: string, request: {
    method: "POST" | "GET";
    body?: RemoteEnvelope<unknown>;
    headers?: Readonly<Record<string, string>>;
  }): Promise<RemoteResponse<unknown>> {
    const url = requestUrl(this.base, path);
    const headers: Record<string, string> = { accept: "application/json" };
    const init: BunFetchRequestInit = {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      tls: this.tls,
    };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    mergeControlledRequestHeaders(headers, request.headers);
    try {
      const response = await this.fetcher(url, init);
      const text = await response.text();
      return { status: response.status, body: parseResponse(response.status, text) };
    } catch {
      throw new RemoteConnectorError("REMOTE_UNAVAILABLE", "remote request failed", true);
    }
  }

  async requestStream(
    path: string,
    request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown> },
  ): Promise<{
    readonly status: number;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array> | null;
  }> {
    const url = requestUrl(this.base, path);
    const headers: Record<string, string> = {
      accept: "application/octet-stream, application/json",
    };
    const init: BunFetchRequestInit = {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      tls: this.tls,
    };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    try {
      const response = await this.fetcher(url, init);
      return { status: response.status, headers: response.headers, body: response.body };
    } catch {
      throw new RemoteConnectorError("REMOTE_UNAVAILABLE", "remote request failed", true);
    }
  }
}

export function createDirectMtlsRemoteTransport(
  options: DirectMtlsRemoteTransportOptions,
): DirectMtlsRemoteTransport {
  return new DirectMtlsRemoteTransport(options);
}

export type CloudflareRemoteConnectorOptions = Omit<RemoteClientOptions, "transport"> & {
  tokenProvider: CloudflareAccessTokenProvider;
  timeoutMs?: number;
};

export function createCloudflareRemoteConnector(options: CloudflareRemoteConnectorOptions): RemoteConnectorClient {
  return new RemoteConnectorClient({
    ...options,
    transport: createCloudflareRemoteTransport({
      endpointUrl: options.endpoint.endpoint_url,
      tokenProvider: options.tokenProvider,
      timeoutMs: options.timeoutMs,
    }),
  });
}

export type DirectMtlsRemoteConnectorOptions = Omit<RemoteClientOptions, "transport"> & {
  ca: string;
  cert: string;
  key: string;
  timeoutMs?: number;
};

export function createDirectMtlsRemoteConnector(
  options: DirectMtlsRemoteConnectorOptions,
): RemoteConnectorClient {
  return new RemoteConnectorClient({
    ...options,
    transport: createDirectMtlsRemoteTransport({
      endpointUrl: options.endpoint.endpoint_url,
      ca: options.ca,
      cert: options.cert,
      key: options.key,
      timeoutMs: options.timeoutMs,
    }),
  });
}

export function createEnvironmentCloudflareRemoteConnector(
  options: Omit<CloudflareRemoteConnectorOptions, "tokenProvider"> & { env?: Record<string, string | undefined>; secretNames?: EnvironmentSecretNames },
): RemoteConnectorClient {
  return createCloudflareRemoteConnector({
    ...options,
    tokenProvider: createEnvironmentCloudflareAccessTokenProvider(options.env, options.secretNames),
  });
}
