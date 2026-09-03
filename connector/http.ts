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
    // Cloudflare Access can return an HTML login/denial page with a non-403
    // edge status. Normalize it without exposing the page or credential data.
    const accessPage = /cloudflare\s+access|cf-access/i.test(text);
    return { error_code: status === 401 || status === 403 || accessPage ? "ACCESS_DENIED" : "REMOTE_PROTOCOL_ERROR" };
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

// ─── direct mTLS transport (LAN/Tailscale deployments) ───────────────────────

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

export interface MtlsDirectTransportOptions {
  endpointUrl: string;
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  servername?: string;
  timeoutMs?: number;
}

/**
 * Speaks connector.remote.v1 over a direct HTTPS hop with client-certificate
 * mTLS, for deployments where Core reaches the Worker without the Cloudflare
 * Access tunnel (for example Mac→Worker over Tailscale). Same wire contract
 * and error normalization as the Cloudflare transport; only the TLS posture
 * differs. Client material is a PEM cert/key pair — Bun's node:https does not
 * implement the `pfx` option, so PKCS#12 bundles must be converted up front
 * (`openssl pkcs12 -nodes`) and the key file protected on disk.
 */
export class MtlsDirectTransport implements RemoteTransport {
  private readonly base: URL;
  private readonly cert: Buffer;
  private readonly key: Buffer;
  private readonly ca: Buffer;
  private readonly servername?: string;
  private readonly timeoutMs: number;

  constructor(options: MtlsDirectTransportOptions) {
    this.base = endpoint(options.endpointUrl);
    this.cert = options.cert;
    this.key = options.key;
    this.ca = options.ca;
    this.servername = options.servername;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new RemoteConnectorError("CONFIG_INVALID", "timeoutMs invalid");
  }

  request(path: string, request: { method: "POST" | "GET"; body?: RemoteEnvelope<unknown> }): Promise<RemoteResponse<unknown>> {
    const url = requestUrl(this.base, path);
    const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), "utf8");
    return new Promise<RemoteResponse<unknown>>((resolve) => {
      const req = httpsRequest({
        protocol: "https:",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(body.byteLength) }),
        },
        ...(this.servername === undefined ? {} : { servername: this.servername }),
        ca: this.ca,
        cert: this.cert,
        key: this.key,
        rejectUnauthorized: true,
        timeout: this.timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          resolve({ status, body: parseResponse(status, Buffer.concat(chunks).toString("utf8")) });
        });
      });
      req.on("timeout", () => req.destroy(new RemoteConnectorError("REMOTE_UNAVAILABLE", "mtls request timed out", true)));
      req.on("error", () => resolve({ status: 503, body: { error_code: "REMOTE_UNAVAILABLE", message: "remote request failed" } }));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

export interface MtlsDirectEndpointConfig {
  endpoint_url?: unknown;
  client_cert_path?: unknown;
  client_key_path?: unknown;
  server_ca_path?: unknown;
  tls_servername?: unknown;
}

/**
 * Build a RemoteConnectorClient from an endpoint config whose
 * `transport_mode` is `direct_https` and `auth_mode` is `mtls`. The PEM
 * cert/key pair and CA are read once at construction; the key file must be
 * provisioned unencrypted with filesystem permissions restricting access —
 * PKCS#12 material is intentionally not accepted because the runtime's
 * node:https layer does not implement `pfx`.
 */
export function createMtlsDirectRemoteConnector(options: Omit<RemoteClientOptions, "transport"> & { endpoint: MtlsDirectEndpointConfig }): RemoteConnectorClient {
  const cfg = options.endpoint;
  const endpointUrl = typeof cfg.endpoint_url === "string" ? cfg.endpoint_url : "";
  if (!endpointUrl) throw new RemoteConnectorError("CONFIG_INVALID", "direct_https endpoint requires endpoint_url");
  const certPath = typeof cfg.client_cert_path === "string" ? cfg.client_cert_path : "";
  const keyPath = typeof cfg.client_key_path === "string" ? cfg.client_key_path : "";
  const caPath = typeof cfg.server_ca_path === "string" ? cfg.server_ca_path : "";
  if (!certPath || !keyPath || !caPath) throw new RemoteConnectorError("CONFIG_INVALID", "direct_https endpoint requires client_cert_path, client_key_path and server_ca_path");
  let cert: Buffer;
  let key: Buffer;
  let ca: Buffer;
  try {
    cert = readFileSync(certPath);
    key = readFileSync(keyPath);
    ca = readFileSync(caPath);
  } catch {
    throw new RemoteConnectorError("CONFIG_INVALID", "mTLS material unreadable");
  }
  return new RemoteConnectorClient({
    ...options,
    endpoint: options.endpoint as unknown as RemoteClientOptions["endpoint"],
    transport: new MtlsDirectTransport({
      endpointUrl,
      cert,
      key,
      ca,
      ...(typeof cfg.tls_servername === "string" && cfg.tls_servername !== "" ? { servername: cfg.tls_servername } : {}),
    }),
  });
}
