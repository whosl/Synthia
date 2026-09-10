import { describe, expect, test } from "bun:test";
import {
  EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER,
  EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER,
  EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER,
  REMOTE_SCHEMA_VERSION,
  RemoteConnectorClient,
  type ConnectorEndpoint,
  type DiscoverySnapshot,
  type EvolutionEvalRemoteAttestation,
  type RemoteEnvelope,
  type RemoteResponse,
  type RemoteTransport,
} from "./remote.ts";
import {
  canonicalEvolutionEvalHash,
  computeEvolutionEvalDispatchRequestHash,
  type CoreIssuedEvalBinding,
  type EvolutionEvalSealedInputV1,
} from "./evolution-eval.ts";

const endpoint: ConnectorEndpoint = {
  connector_id: "connector-eval-1",
  display_name: "eval",
  endpoint_url: "https://worker.example.test",
  protocol_version: REMOTE_SCHEMA_VERSION,
  transport_mode: "direct_https",
  auth_mode: "mtls",
  tls_trust_ref: "secret://trust",
  tls_client_cert_ref: "secret://cert",
  project_scope: ["project-eval-1"],
  data_classification_scope: ["restricted"],
  allowed_capability_ids: ["validate_sources", "simulate", "synthesize", "implement"],
  toolchain_profile_hash: "3".repeat(64),
  worker_labels: {},
  heartbeat_interval_seconds: 10,
  lease_seconds: 30,
  max_concurrency: 1,
  registration_state: "approved",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  audited_by: "test",
};

const attestation: EvolutionEvalRemoteAttestation = {
  active_config_sha256: "6".repeat(64),
  worker_process_instance_id: "123e4567-e89b-42d3-a456-426614174000",
  vivado_toolchain_attestation_sha256: "7".repeat(64),
};

function bindingAndInput(): {
  binding: CoreIssuedEvalBinding;
  input: EvolutionEvalSealedInputV1;
} {
  const bytes = Buffer.from("module top; endmodule\n", "utf8");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const manifest = {
    schema: "evolution-eval-workspace-manifest.v1" as const,
    workspace_id: "workspace-eval-1",
    revision: 1,
    files: [{
      path: "rtl/top.sv",
      sha256,
      size_bytes: bytes.byteLength,
      media_type: "text/x-systemverilog",
      layer: "source" as const,
      read_only: true,
    }],
  };
  const dispatch = {
    schema: "evolution-eval-dispatch-request.v1" as const,
    eval_job_id: "eval-job-1",
    connector_job_id: "connector-eval-job-1",
    connector_idempotency_key: "1".repeat(64),
    eval_input_ref: "eval-input-1",
    input_manifest_hash: "2".repeat(64),
    workspace_id: manifest.workspace_id,
    workspace_revision: manifest.revision,
    workspace_manifest_hash: canonicalEvolutionEvalHash(manifest),
    sealed_input_projection_hash: canonicalEvolutionEvalHash({
      schema: "evolution-eval-sealed-input-projection.v1",
      manifest,
      files: manifest.files.map(({ path, sha256: hash, size_bytes, media_type }) => ({
        path,
        sha256: hash,
        size_bytes,
        media_type,
      })),
    }),
    operation: "validate_sources" as const,
    parameters: { operation: "validate_sources" as const, source_paths: ["rtl/top.sv"], top: "top" },
    part: null,
    toolchain_profile_hash: "3".repeat(64),
    requested_timeout_ms: 60_000,
    operation_cap_ms: 7_200_000 as const,
    deadline_at: "2099-01-01T00:00:00.000Z",
    run_class: "evolution_eval" as const,
  };
  const binding = {
    project_id: "project-eval-1",
    dispatch_request_hash: computeEvolutionEvalDispatchRequestHash(dispatch),
    dispatch,
  };
  return {
    binding,
    input: {
      schema: "evolution-eval-sealed-input.v1",
      manifest,
      files: [{
        path: "rtl/top.sv",
        sha256,
        size_bytes: bytes.byteLength,
        media_type: "text/x-systemverilog",
        content_base64: bytes.toString("base64"),
      }],
    },
  };
}

class CapturingTransport implements RemoteTransport {
  readonly calls: Array<{
    path: string;
    body: RemoteEnvelope<unknown>;
    headers?: Readonly<Record<string, string>>;
  }> = [];

  constructor(private readonly payload: (path: string) => unknown) {}

  async request(
    path: string,
    request: {
      method: "POST" | "GET";
      body?: RemoteEnvelope<unknown>;
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<RemoteResponse<unknown>> {
    this.calls.push({ path, body: request.body!, headers: request.headers });
    return {
      status: 200,
      body: { ...request.body!, payload: this.payload(path) },
    };
  }
}

function client(transport: RemoteTransport): RemoteConnectorClient {
  return new RemoteConnectorClient({
    endpoint,
    transport,
    actor: { actor_type: "service", actor_id: "synthia-core-evolution-eval-dispatcher" },
    classification: "restricted",
    projectId: "project-eval-1",
    allowlist: ["worker.example.test"],
    correlationId: () => "correlation-1",
  });
}

function neverAccepted(binding: CoreIssuedEvalBinding) {
  return {
    schema: "evolution-eval-ledger-query.v1",
    connector_job_id: binding.dispatch.connector_job_id,
    connector_idempotency_key: binding.dispatch.connector_idempotency_key,
    dispatch_request_hash: binding.dispatch_request_hash,
    ledger_epoch: "epoch-1",
    state: "proven_never_accepted",
    replay_permitted: true,
  };
}

describe("remote evolution-eval attestation", () => {
  test("reserve and submit send exact attestation headers", async () => {
    const { binding, input } = bindingAndInput();
    const transport = new CapturingTransport(() => neverAccepted(binding));
    const remote = client(transport);

    await remote.evolutionEvalReserve(binding, attestation);
    await remote.evolutionEvalSubmit(binding, input, attestation);

    expect(transport.calls.map((call) => call.path))
      .toEqual(["/evolution-eval/reserve", "/evolution-eval/submit"]);
    for (const call of transport.calls) {
      expect(call.headers).toEqual({
        [EVOLUTION_EVAL_ACTIVE_CONFIG_HEADER]: attestation.active_config_sha256,
        [EVOLUTION_EVAL_PROCESS_INSTANCE_HEADER]: attestation.worker_process_instance_id,
        [EVOLUTION_EVAL_TOOLCHAIN_ATTESTATION_HEADER]: attestation.vivado_toolchain_attestation_sha256,
      });
    }
  });

  test("missing or malformed expected attestation is rejected before transport", async () => {
    const { binding, input } = bindingAndInput();
    const transport = new CapturingTransport(() => neverAccepted(binding));
    const remote = client(transport);

    await expect(remote.evolutionEvalReserve(binding, undefined as never))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_REMOTE_ATTESTATION_REQUIRED" });
    await expect(remote.evolutionEvalSubmit(binding, input, {
      ...attestation,
      active_config_sha256: "invalid",
    })).rejects.toMatchObject({ code: "EVOLUTION_EVAL_REMOTE_ATTESTATION_REQUIRED" });
    expect(transport.calls).toHaveLength(0);
  });
});

describe("remote discovery attestation compatibility", () => {
  const baseDiscovery: DiscoverySnapshot = {
    connector_id: endpoint.connector_id,
    connector_protocol_version: REMOTE_SCHEMA_VERSION,
    capability_map_version: "v1",
    vivado_version: "2025.1",
    vivado_patch: "1",
    part_catalog_hash: "parts",
    sdk_worker_build_hash: "worker",
    capabilities: [{ operation: "validate_sources", version: "vivado-batch-1", runClasses: ["exploratory"] }],
    toolchain_profile_hash: endpoint.toolchain_profile_hash,
    license_status: "available",
  };

  test("generic discovery may omit attestation", async () => {
    const remote = client(new CapturingTransport(() => baseDiscovery));
    expect(await remote.discover()).toEqual(baseDiscovery);
  });

  test("evolution-eval discovery requires both valid attestation fields", async () => {
    const evalDiscovery = {
      ...baseDiscovery,
      capabilities: ["validate_sources", "simulate", "synthesize", "implement"].map((operation) => ({
        operation,
        version: "vivado-batch-1",
        runClasses: ["exploratory", "evolution_eval"],
      })),
    };
    await expect(client(new CapturingTransport(() => evalDiscovery)).discover())
      .rejects.toMatchObject({ code: "COMPATIBILITY_REJECTED" });
    await expect(client(new CapturingTransport(() => ({
      ...evalDiscovery,
      ...attestation,
      worker_process_instance_id: "not-a-uuid",
    }))).discover()).rejects.toMatchObject({ code: "COMPATIBILITY_REJECTED" });
    expect(await client(new CapturingTransport(() => ({ ...evalDiscovery, ...attestation, live_mapping_health: "healthy" }))).discover())
      .toMatchObject(attestation);
  });
});
