import { RemoteConnectorClient, RemoteConnectorError, type RemoteEnvelope, type RemoteResponse, type RemoteTransport, type RemoteClientOptions } from "./remote.ts";

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

  async request(path: string, request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown> }): Promise<RemoteResponse<unknown>> {
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
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      throw new RemoteConnectorError("REMOTE_UNAVAILABLE", "remote request failed", true);
    }
    const text = await response.text();
    return { status: response.status, body: parseResponse(response.status, text) };
  }
}

export function createCloudflareRemoteTransport(options: CloudflareRemoteTransportOptions): CloudflareRemoteTransport {
  return new CloudflareRemoteTransport(options);
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

export function createEnvironmentCloudflareRemoteConnector(
  options: Omit<CloudflareRemoteConnectorOptions, "tokenProvider"> & { env?: Record<string, string | undefined>; secretNames?: EnvironmentSecretNames },
): RemoteConnectorClient {
  return createCloudflareRemoteConnector({
    ...options,
    tokenProvider: createEnvironmentCloudflareAccessTokenProvider(options.env, options.secretNames),
  });
}
