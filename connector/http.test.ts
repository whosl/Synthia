import { describe, expect, test } from "bun:test";
import { createCloudflareAccessTokenProvider, createCloudflareRemoteConnector, createCloudflareRemoteTransport, createEnvironmentSecretResolver } from "./http.ts";
import { RemoteConnectorError, type RemoteEnvelope } from "./remote.ts";

const envelope: RemoteEnvelope<Record<string, never>> = {
  schema_version: "connector.remote.v1",
  correlation_id: "corr-1",
  idempotency_key: "idem-1",
  actor: { actor_type: "service", actor_id: "core" },
  project_id: "p1",
  classification: "internal",
  capability_version: "connector.remote.v1",
  payload: {},
};

describe("Cloudflare Access remote transport", () => {
  test("resolves secrets by reference and injects headers without logging them", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: createCloudflareAccessTokenProvider({
        clientIdRef: "env://CLIENT_ID",
        clientSecretRef: "env://CLIENT_SECRET",
        resolve: createEnvironmentSecretResolver({ CLIENT_ID: "id-1", CLIENT_SECRET: "secret-1" }),
      }),
      fetchImpl: async (url, init) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify({ ...envelope, payload: { ok: true } }), { status: 200 }); },
    });
    const result = await transport.request("/discover", { method: "POST", body: envelope });
    expect(result.status).toBe(200);
    expect(seen[0]?.url).toBe("https://connect.wenzhuolin.xyz/discover");
    expect(new Headers(seen[0]?.init?.headers).get("CF-Access-Client-Id")).toBe("id-1");
    expect(new Headers(seen[0]?.init?.headers).get("CF-Access-Client-Secret")).toBe("secret-1");
    expect(new Headers(seen[0]?.init?.headers).get("content-type")).toBe("application/json");
  });

  test("fails closed when a secret is unavailable", async () => {
    const provider = createCloudflareAccessTokenProvider({
      clientIdRef: "env://CLIENT_ID",
      clientSecretRef: "env://CLIENT_SECRET",
      resolve: createEnvironmentSecretResolver({ CLIENT_ID: "id-1" }),
    });
    await expect(provider()).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
  });

  test("rejects plaintext secret and unsafe endpoint configuration", () => {
    expect(() => createCloudflareAccessTokenProvider({
      clientIdRef: "id-1",
      clientSecretRef: "env://CLIENT_SECRET",
      resolve: () => "x",
    })).toThrow(RemoteConnectorError);
    expect(() => createCloudflareRemoteTransport({
      endpointUrl: "http://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id", clientSecret: "secret" }),
    })).toThrow("plain HTTPS origin");
  });

  test("creates a production connector with the endpoint URL", () => {
    const client = createCloudflareRemoteConnector({
      endpoint: {
        connector_id: "vivado-1", display_name: "remote", endpoint_url: "https://eda.example.test:8443", protocol_version: "connector.remote.v1", transport_mode: "direct_https", auth_mode: "mtls", tls_trust_ref: "secret://trust/1", tls_client_cert_ref: "secret://cert/1", project_scope: ["p1"], data_classification_scope: ["internal"], allowed_capability_ids: ["vivado_synthesize"], toolchain_profile_hash: "profile-a", worker_labels: { os: "linux" }, heartbeat_interval_seconds: 10, lease_seconds: 30, max_concurrency: 1, registration_state: "registering", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", audited_by: "svc",
      },
      tokenProvider: async () => ({ clientId: "id", clientSecret: "secret" }),
      actor: { actor_type: "service", actor_id: "core" }, classification: "internal", projectId: "p1", allowlist: ["eda.example.test"],
    });
    expect(client.state).toBe("registering");
  });
  test("maps an edge 403 to a stable access error", async () => {
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id", clientSecret: "secret" }),
      fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    });
    const result = await transport.request("/discover", { method: "POST", body: envelope });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error_code: "ACCESS_DENIED" });
  });
});
