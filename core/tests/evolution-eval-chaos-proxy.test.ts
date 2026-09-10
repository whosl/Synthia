import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvolutionEvalChaosAuthorization,
  createEvolutionEvalChaosFetch,
  EvolutionEvalChaosLogWriter,
  parseEvolutionEvalChaosAuthorization,
  verifyEvolutionEvalChaosLog,
  type EvolutionEvalChaosFact,
  type EvolutionEvalChaosScenario,
} from "../scripts/evolution-eval-chaos-proxy.ts";

const PATHS: Readonly<Record<EvolutionEvalChaosScenario, string>> = {
  unforwarded_submit: "/evolution-eval/submit",
  accepted_submit_response_lost: "/evolution-eval/submit",
  query_response_lost: "/evolution-eval/query",
  cancel_response_lost: "/evolution-eval/cancel",
  evidence_entry_stream_lost: "/evolution-eval/evidence/entry",
  ack_response_lost: "/evolution-eval/evidence/ack",
  corrupt_ack_response_lost: "/evolution-eval/evidence/corrupt-ack",
  cleanup_response_lost: "/evolution-eval/evidence/cleanup",
};

function envelope(payload: Record<string, unknown>): Response {
  return Response.json({
    schema_version: "connector.remote.v1",
    correlation_id: "corr-1",
    idempotency_key: "idem-1",
    actor: { actor_type: "service", actor_id: "dispatcher" },
    project_id: "p1",
    classification: "internal",
    capability_version: "vivado-batch-1",
    payload,
  });
}

function responseForScenario(scenario: EvolutionEvalChaosScenario): Response {
  if (scenario === "evidence_entry_stream_lost") {
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "5",
        "x-synthia-evidence-sha256": "1".repeat(64),
      },
    });
  }
  if (scenario === "accepted_submit_response_lost") return envelope({ state: "accepted" });
  if (scenario === "ack_response_lost") return envelope({ state: "acknowledged" });
  if (scenario === "corrupt_ack_response_lost") return envelope({ state: "quarantined" });
  if (scenario === "cleanup_response_lost") {
    return envelope({ state: "cleaned", physical_deleted: true });
  }
  return envelope({ state: "proven_never_accepted" });
}

function authorization() {
  return createEvolutionEvalChaosAuthorization({
    gateId: "gate-1",
    databaseIdentityHash: "1".repeat(64),
    workerReleaseManifestHash: "2".repeat(64),
    certificationHash: "3".repeat(64),
    certificationFileSha256: "4".repeat(64),
    scenario: "query_response_lost",
    proxyOrigin: "https://127.0.0.1:9443",
    upstreamOrigin: "https://connector.example.test",
    runNonce: "00000000-0000-4000-8000-000000000001",
  });
}

function chaosFact(requestSha256 = "5".repeat(64)): EvolutionEvalChaosFact {
  return {
    schema: "synthia-evolution-eval-chaos-fact.v1",
    gate_id: "gate-1",
    scenario: "query_response_lost",
    method: "POST",
    path: "/evolution-eval/query",
    request_sha256: requestSha256,
    forwarded_to_connector: true,
    upstream_status: 200,
    upstream_response_sha256: "6".repeat(64),
    upstream_response_bytes: 10,
    connector_response_observed: true,
    response_delivered: false,
    injection_applied: true,
  };
}

describe("M4-F evolution-eval chaos proxy", () => {
  test("unforwarded submit records that no Connector request or response existed", async () => {
    const facts: EvolutionEvalChaosFact[] = [];
    let forwards = 0;
    const chaosFetch = createEvolutionEvalChaosFetch({
      gateId: "gate-1",
      scenario: "unforwarded_submit",
      upstreamFetch: async () => {
        forwards += 1;
        return envelope({ state: "accepted" });
      },
      record: (fact) => {
        facts.push(fact);
      },
    });
    const response = await chaosFetch(new Request("https://proxy.test/evolution-eval/submit", {
      method: "POST",
      body: JSON.stringify({ payload: "never-forwarded" }),
    }));

    await expect(response.text()).rejects.toThrow("SYNTHIA_M4F_CHAOS_RESPONSE_LOST");
    expect(forwards).toBe(0);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      scenario: "unforwarded_submit",
      forwarded_to_connector: false,
      upstream_status: null,
      connector_response_observed: false,
      response_delivered: false,
      injection_applied: true,
    });
  });

  for (const scenario of [
    "accepted_submit_response_lost",
    "query_response_lost",
    "cancel_response_lost",
    "evidence_entry_stream_lost",
    "ack_response_lost",
    "corrupt_ack_response_lost",
    "cleanup_response_lost",
  ] as const) {
    test(`${scenario} forwards exact request, observes upstream, then loses response`, async () => {
      const facts: EvolutionEvalChaosFact[] = [];
      let forwardedBody = "";
      let forwardedHeader = "";
      const chaosFetch = createEvolutionEvalChaosFetch({
        gateId: "gate-1",
        scenario,
        evidencePrefixBytes: 2,
        upstreamFetch: async (input) => {
          const request = input instanceof Request ? input : new Request(input);
          forwardedBody = await request.text();
          forwardedHeader = request.headers.get("x-test-opaque") ?? "";
          return responseForScenario(scenario);
        },
        record: (fact) => {
          facts.push(fact);
        },
      });
      const body = JSON.stringify({ exact: "payload", scenario });
      const response = await chaosFetch(new Request(`https://proxy.test${PATHS[scenario]}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-opaque": "header-value" },
        body,
      }));

      await expect(response.arrayBuffer()).rejects.toThrow("SYNTHIA_M4F_CHAOS_RESPONSE_LOST");
      expect(forwardedBody).toBe(body);
      expect(forwardedHeader).toBe("header-value");
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        scenario,
        path: PATHS[scenario],
        forwarded_to_connector: true,
        upstream_status: 200,
        connector_response_observed: true,
        response_delivered: false,
        injection_applied: true,
      });
      expect(facts[0]!.upstream_response_bytes).toBeGreaterThan(0);
      expect(facts[0]!.upstream_response_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(facts[0])).not.toContain("header-value");
      expect(JSON.stringify(facts[0])).not.toContain("exact");
    });
  }

  test("does not claim accepted-response loss when submit was not accepted", async () => {
    const facts: EvolutionEvalChaosFact[] = [];
    const chaosFetch = createEvolutionEvalChaosFetch({
      gateId: "gate-1",
      scenario: "accepted_submit_response_lost",
      upstreamFetch: async () => envelope({ state: "terminal" }),
      record: (fact) => {
        facts.push(fact);
      },
    });
    const response = await chaosFetch("https://proxy.test/evolution-eval/submit", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payload: { state: "terminal" } });
    expect(facts[0]).toMatchObject({
      forwarded_to_connector: true,
      connector_response_observed: true,
      response_delivered: true,
      injection_applied: false,
    });
  });

  test("passes non-target routes through without a chaos fact", async () => {
    const facts: EvolutionEvalChaosFact[] = [];
    let forwardedUrl = "";
    const chaosFetch = createEvolutionEvalChaosFetch({
      gateId: "gate-1",
      scenario: "query_response_lost",
      upstreamOrigin: "https://connector.example.test",
      upstreamFetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        forwardedUrl = request.url;
        return envelope({ registration_state: "ready" });
      },
      record: (fact) => {
        facts.push(fact);
      },
    });
    const response = await chaosFetch("https://proxy.test/heartbeat", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(forwardedUrl).toBe("https://connector.example.test/heartbeat");
    expect(facts).toEqual([]);
  });

  test("strict authorization binds the loopback proxy and rejects self-hash tampering", () => {
    const value = authorization();
    expect(parseEvolutionEvalChaosAuthorization(value)).toEqual(value);
    expect(() => parseEvolutionEvalChaosAuthorization({
      ...value,
      proxy_origin: "https://not-loopback.example.test",
    })).toThrow("loopback HTTPS origin");
    expect(() => parseEvolutionEvalChaosAuthorization({
      ...value,
      scenario: "cancel_response_lost",
    })).toThrow("authorization_hash is invalid");
  });

  test("creates one exclusive fsynced hash chain with a final seal and detects tampering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synthia-chaos-log-test-"));
    const path = join(directory, "chaos.jsonl");
    try {
      let tick = 0;
      const log = await EvolutionEvalChaosLogWriter.create({
        path,
        authorization: authorization(),
        now: () => new Date(Date.UTC(2026, 7, 27, 0, 0, tick++)),
      });
      await expect(EvolutionEvalChaosLogWriter.create({
        path,
        authorization: authorization(),
      })).rejects.toMatchObject({ code: "EEXIST" });
      await Promise.all([
        log.record(chaosFact("7".repeat(64))),
        log.record(chaosFact("8".repeat(64))),
      ]);
      const seal = await log.seal();
      expect(seal.entry_count).toBe(2);
      const bytes = await readFile(path);
      const verified = verifyEvolutionEvalChaosLog(bytes, authorization());
      expect(verified.entries.map(entry => entry.sequence)).toEqual([1, 2]);
      expect(verified.entries[1]!.previous_hash).toBe(verified.entries[0]!.entry_hash);
      expect(verified.seal.previous_hash).toBe(verified.entries[1]!.entry_hash);

      const lines = bytes.toString("utf8").trimEnd().split("\n");
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      first.recorded_at = "2026-08-27T00:00:59.000Z";
      lines[0] = JSON.stringify(first);
      expect(() => verifyEvolutionEvalChaosLog(
        Buffer.from(`${lines.join("\n")}\n`),
        authorization(),
      )).toThrow("entry chain is invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
