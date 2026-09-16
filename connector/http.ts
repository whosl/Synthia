import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { RemoteConnectorClient, RemoteConnectorError, type RemoteEnvelope, type RemoteResponse, type RemoteTransport, type RemoteClientOptions } from "./remote.ts";

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
  if (!text.trim()) return { error_code: "REMOTE_PROTOCOL_ERROR" };
  try {
    return JSON.parse(text) as RemoteEnvelope<unknown> | { error_code: string; message?: string };
  } catch {
    // 非 JSON 响应（中间层 HTML 拒绝页等）规范化为协议错误，不外泄页面内容。
    return { error_code: "REMOTE_PROTOCOL_ERROR" };
  }
}

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
 * mTLS, for deployments where Core reaches the Worker directly (for example
 * over Tailscale). Client material is a PEM cert/key pair — Bun's node:https does not
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
