import { describe, expect, test } from "bun:test";
import { createCloudflareAccessTokenProvider, createCloudflareRemoteConnector, createCloudflareRemoteTransport, createDirectMtlsRemoteConnector, createDirectMtlsRemoteTransport, createEnvironmentSecretResolver,
  createMtlsDirectRemoteConnector,
} from "./http.ts";
import { EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER, EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER, EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER, RemoteConnectorError, type RemoteEnvelope } from "./remote.ts";

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

  test("forwards only exact evolution-eval attestation headers to fetch", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id-1", clientSecret: "secret-1" }),
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ ...envelope, payload: { ok: true } }), { status: 200 });
      },
    });
    const attestationHeaders = {
      [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]: "a".repeat(64),
      [EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER]: "123e4567-e89b-42d3-a456-426614174000",
      [EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER]: "b".repeat(64),
    };
    for (const path of ["/evolution-eval/reserve", "/evolution-eval/submit"]) {
      await transport.request(path, { method: "POST", body: envelope, headers: attestationHeaders });
    }
    expect(seen.map((call) => call.url)).toEqual([
      "https://connect.wenzhuolin.xyz/evolution-eval/reserve",
      "https://connect.wenzhuolin.xyz/evolution-eval/submit",
    ]);
    for (const call of seen) {
      expect(call.headers.get(EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER)).toBe(attestationHeaders[EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]);
      expect(call.headers.get(EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER)).toBe(attestationHeaders[EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER]);
      expect(call.headers.get(EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER)).toBe(attestationHeaders[EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER]);
      expect(call.headers.get("CF-Access-Client-Id")).toBe("id-1");
      expect(call.headers.get("CF-Access-Client-Secret")).toBe("secret-1");
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("accept")).toBe("application/json");
    }
  });

  test("caller headers cannot override transport or Cloudflare authentication headers", async () => {
    let fetches = 0;
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id-1", clientSecret: "secret-1" }),
      fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
    });
    for (const name of ["CF-Access-Client-Id", "CF-Access-Client-Secret", "content-type", "accept"]) {
      await expect(transport.request("/evolution-eval/reserve", {
        method: "POST",
        body: envelope,
        headers: { [name]: "attacker-controlled" },
      })).rejects.toMatchObject({ code: "REMOTE_HEADER_FORBIDDEN" });
    }
    await expect(transport.request("/evolution-eval/reserve", {
      method: "POST",
      body: envelope,
      headers: { [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]: "invalid" },
    })).rejects.toMatchObject({ code: "REMOTE_HEADER_INVALID" });
    expect(fetches).toBe(0);
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

  test("maps a Cloudflare HTML access page to ACCESS_DENIED even with an edge 200", async () => {
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id", clientSecret: "secret" }),
      fetchImpl: async () => new Response("<!doctype html><html><title>Cloudflare Access</title></html>", { status: 200 }),
    });
    const result = await transport.request("/discover", { method: "POST", body: envelope });
    expect(result.body).toMatchObject({ error_code: "ACCESS_DENIED" });
  });

  test("does not misclassify an unrelated HTML failure as Cloudflare Access", async () => {
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id", clientSecret: "secret" }),
      fetchImpl: async () => new Response("<!doctype html><html><title>Upstream error</title></html>", { status: 502 }),
    });
    const result = await transport.request("/discover", { method: "POST", body: envelope });
    expect(result.body).toMatchObject({ error_code: "REMOTE_PROTOCOL_ERROR" });
  });

  test("maps response body download failures to retryable remote unavailable", async () => {
    const transport = createCloudflareRemoteTransport({
      endpointUrl: "https://connect.wenzhuolin.xyz",
      tokenProvider: async () => ({ clientId: "id", clientSecret: "secret" }),
      fetchImpl: async () => ({
        status: 200,
        text: async () => { throw new DOMException("timed out", "TimeoutError"); },
      }) as Response,
    });
    await expect(transport.request("/discover", { method: "POST", body: envelope }))
      .rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE", retryable: true });
  });
});

// ─── direct mTLS connector factory ───────────────────────────────────────────

describe("mTLS direct connector factory", () => {
  const base = {
    allowlist: ["100.96.223.49"],
    actor: { actor_type: "service" as const, actor_id: "core-test" },
    classification: "internal" as const,
    projectId: "p1",
  };

  test("rejects config without endpoint_url", () => {
    expect(() => createMtlsDirectRemoteConnector({ ...base, endpoint: {} })).toThrow("endpoint_url");
  });

  test("rejects config without cert paths", () => {
    expect(() => createMtlsDirectRemoteConnector({ ...base, endpoint: { endpoint_url: "https://100.96.223.49:8444" } })).toThrow("client_cert_path");
  });

  test("rejects unreadable mTLS material", () => {
    expect(() =>
      createMtlsDirectRemoteConnector({
        ...base,
        endpoint: { endpoint_url: "https://100.96.223.49:8444", client_cert_path: "/nonexistent/a.pem", client_key_path: "/nonexistent/b.pem", server_ca_path: "/nonexistent/c.pem" },
      }),
    ).toThrow("unreadable");

describe("isolated M4-F direct mTLS transport", () => {
  test("pins the 18443 Tailscale target and presents exact TLS material", async () => {
    const seen: Array<{ url: string; init: BunFetchRequestInit }> = [];
    const transport = createDirectMtlsRemoteTransport({
      endpointUrl: "https://100.96.223.49:18443",
      ca: "test-ca",
      cert: "test-client-cert",
      key: "test-client-key",
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({ ...envelope, payload: { ok: true } }), {
          status: 200,
        });
      },
    });
    const headers = {
      [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]: "a".repeat(64),
      [EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER]: "123e4567-e89b-42d3-a456-426614174000",
      [EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER]: "b".repeat(64),
    };
    const result = await transport.request("/evolution-eval/reserve", {
      method: "POST",
      body: envelope,
      headers,
    });
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://100.96.223.49:18443/evolution-eval/reserve");
    expect(seen[0]!.init.tls).toMatchObject({
      ca: "test-ca",
      cert: "test-client-cert",
      key: "test-client-key",
      rejectUnauthorized: true,
    });
    const sent = new Headers(seen[0]!.init.headers);
    expect(sent.get("CF-Access-Client-Id")).toBeNull();
    expect(sent.get(EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER)).toBe("a".repeat(64));
  });

  test("cannot target old 8443, another host, a path, or empty TLS material", () => {
    for (const endpointUrl of [
      "https://100.96.223.49:8443",
      "https://connect.wenzhuolin.xyz:18443",
      "https://100.96.223.49:18443/gate",
    ]) {
      expect(() => createDirectMtlsRemoteTransport({
        endpointUrl,
        ca: "ca",
        cert: "cert",
        key: "key",
      })).toThrow(RemoteConnectorError);
    }
    expect(() => createDirectMtlsRemoteTransport({
      endpointUrl: "https://100.96.223.49:18443",
      ca: "",
      cert: "cert",
      key: "key",
    })).toThrow("TLS material is invalid");
  });

  test("constructs a remote client only for the certified sidecar origin", () => {
    const client = createDirectMtlsRemoteConnector({
      endpoint: {
        connector_id: "vivado-m4f-gate",
        display_name: "M4-F sidecar",
        endpoint_url: "https://100.96.223.49:18443",
        protocol_version: "connector.remote.v1",
        transport_mode: "direct_https",
        auth_mode: "mtls",
        tls_trust_ref: "cert://m4f-direct/trust",
        tls_client_cert_ref: "cert://m4f-direct/client",
        project_scope: ["m4f-gate-project"],
        data_classification_scope: ["internal"],
        allowed_capability_ids: ["vivado_synthesize"],
        toolchain_profile_hash: "profile-a",
        worker_labels: { os: "windows" },
        heartbeat_interval_seconds: 10,
        lease_seconds: 30,
        max_concurrency: 1,
        registration_state: "registering",
        created_at: "2026-08-28T00:00:00Z",
        updated_at: "2026-08-28T00:00:00Z",
        audited_by: "m4f-reviewer",
      },
      ca: "ca",
      cert: "cert",
      key: "key",
      actor: { actor_type: "service", actor_id: "core" },
      classification: "internal",
      projectId: "m4f-gate-project",
      allowlist: ["100.96.223.49"],
    });
    expect(client.state).toBe("registering");
  });
});
