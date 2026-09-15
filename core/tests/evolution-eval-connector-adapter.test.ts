import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  canonicalEvolutionEvalSealedInputProjection,
  evolutionEvalCanonicalHash,
  type EvolutionEvalWorkspaceManifestV1,
} from "../src/domain/evolution-eval.ts";
import {
  createConnectorFromEnv,
  loadM4fDirectMtlsMaterial,
  RemoteConnectorAdapter,
} from "../src/api/connector-adapter.ts";
import type {
  CoreIssuedEvalBinding,
  EvalCancelReason,
  EvalEvidenceAckRequestV1,
  EvalEvidenceCleanupRequestV1,
  EvalEvidenceCorruptAckRequestV1,
  SealedEvalInput,
} from "../src/services/evolution-eval-connector-port.ts";

function binding(
  projectId: string,
  projectionManifest?: EvolutionEvalWorkspaceManifestV1,
): CoreIssuedEvalBinding {
  const dispatch = {
    schema: "evolution-eval-dispatch-request.v1" as const,
    eval_job_id: `eej-${projectId}`,
    connector_job_id: `connector-${projectId}`,
    connector_idempotency_key: createHash("sha256").update(`key:${projectId}`).digest("hex"),
    eval_input_ref: `input-${projectId}`,
    input_manifest_hash: "a".repeat(64),
    workspace_id: `workspace-${projectId}`,
    workspace_revision: 1,
    workspace_manifest_hash: "b".repeat(64),
    sealed_input_projection_hash: projectionManifest === undefined
      ? "d".repeat(64)
      : canonicalEvolutionEvalSealedInputProjection(projectionManifest).sha256,
    operation: "validate_sources" as const,
    parameters: {
      operation: "validate_sources" as const,
      source_paths: ["rtl/top.sv"],
      top: "top",
    },
    part: null,
    toolchain_profile_hash: "c".repeat(64),
    requested_timeout_ms: 60_000,
    operation_cap_ms: 7_200_000 as const,
    deadline_at: "2026-08-27T12:00:00.000Z",
    run_class: "evolution_eval" as const,
  };
  return {
    project_id: projectId,
    dispatch_request_hash: evolutionEvalCanonicalHash(dispatch),
    dispatch,
  };
}

function observation(value: CoreIssuedEvalBinding, ledgerEpoch = "epoch-adapter-test") {
  return {
    schema: "evolution-eval-ledger-query.v1" as const,
    connector_job_id: value.dispatch.connector_job_id,
    connector_idempotency_key: value.dispatch.connector_idempotency_key,
    dispatch_request_hash: value.dispatch_request_hash,
    ledger_epoch: ledgerEpoch,
    state: "accepted" as const,
    execution_state: "queued" as const,
    accepted_at: "2026-08-27T00:00:00.000Z",
  };
}

const CERTIFIED_IDENTITY = {
  sdkWorkerBuildHash: "1".repeat(64),
  activeConfigSha256: "2".repeat(64),
  workerProcessInstanceId: "00000000-0000-4000-8000-000000000001",
  ledgerEpoch: "epoch-adapter-test",
  vivadoToolchainAttestationSha256: "3".repeat(64),
  toolchainProfileHash: "c".repeat(64),
};

interface FactoryOptions {
  readonly actor: { readonly actor_type: "service" | "user"; readonly actor_id: string };
  readonly projectId: string;
}

class EvalRemoteClient {
  readonly state = "ready";
  readonly hasCapabilityDrift = false;
  submitInput: unknown = null;
  reserveAttestation: unknown = null;
  submitAttestation: unknown = null;
  retentionRequests: unknown[] = [];
  evidenceChunks: Uint8Array[] = [];
  evidenceAcquireErrorCode: string | null = null;
  evidenceIterationErrorCode: string | null = null;
  sdkWorkerBuildHash = CERTIFIED_IDENTITY.sdkWorkerBuildHash;
  activeConfigSha256 = CERTIFIED_IDENTITY.activeConfigSha256;
  workerProcessInstanceId = CERTIFIED_IDENTITY.workerProcessInstanceId;
  vivadoToolchainAttestationSha256 =
    CERTIFIED_IDENTITY.vivadoToolchainAttestationSha256;
  toolchainProfileHash = CERTIFIED_IDENTITY.toolchainProfileHash;
  liveMappingHealth: "healthy" | "unavailable" = "healthy";
  ledgerEpoch = CERTIFIED_IDENTITY.ledgerEpoch;
  spoolResult = {
    schema: "evolution-eval-spool-result.v1" as const,
    unacked_bytes: 0,
    hard_cap_bytes: 2_147_483_648 as const,
  };

  constructor(
    readonly options: FactoryOptions,
    private readonly spoolBarrier?: () => Promise<void>,
  ) {}

  async register() { return { registration_state: "approved" }; }
  async heartbeat() { return { registration_state: "ready" }; }
  async discover() {
    return {
      capabilities: [],
      connector_protocol_version: "connector.remote.v1",
      toolchain_profile_hash: this.toolchainProfileHash,
      sdk_worker_build_hash: this.sdkWorkerBuildHash,
      active_config_sha256: this.activeConfigSha256,
      worker_process_instance_id: this.workerProcessInstanceId,
      vivado_toolchain_attestation_sha256:
        this.vivadoToolchainAttestationSha256,
      live_mapping_health: this.liveMappingHealth,
    };
  }
  async submit(): Promise<never> { throw new Error("generic submit must not be called"); }
  async status(): Promise<never> { throw new Error("generic status must not be called"); }
  async evidence(): Promise<never> { throw new Error("generic evidence must not be called"); }
  async fetchEvidenceContent(): Promise<never> { throw new Error("generic evidence must not be called"); }
  async evolutionEvalPreflight(value: CoreIssuedEvalBinding) {
    return {
      schema: "evolution-eval-preflight-result.v1" as const,
      eligible: true,
      operation: value.dispatch.operation,
      capability_version: "vivado-batch-1",
      license_available: true,
      unacked_spool_bytes: this.spoolResult.unacked_bytes,
      hard_cap_bytes: 2_147_483_648 as const,
      error_code: null,
      active_config_sha256: CERTIFIED_IDENTITY.activeConfigSha256,
      worker_process_instance_id: CERTIFIED_IDENTITY.workerProcessInstanceId,
      vivado_toolchain_attestation_sha256:
        CERTIFIED_IDENTITY.vivadoToolchainAttestationSha256,
      live_mapping_health: this.liveMappingHealth,
    };
  }
  async evolutionEvalQuery(value: CoreIssuedEvalBinding) {
    return observation(value, this.ledgerEpoch);
  }
  async evolutionEvalReserve(value: CoreIssuedEvalBinding, attestation?: unknown) {
    this.reserveAttestation = attestation;
    return observation(value);
  }
  async evolutionEvalSubmit(value: CoreIssuedEvalBinding, input: unknown, attestation?: unknown) {
    this.submitInput = input;
    this.submitAttestation = attestation;
    return observation(value);
  }
  async evolutionEvalCancel(value: CoreIssuedEvalBinding, _reason: EvalCancelReason) {
    return observation(value);
  }
  async evolutionEvalQuerySpool(value: CoreIssuedEvalBinding) {
    await this.spoolBarrier?.();
    return { ...this.spoolResult, binding: value };
  }
  async evolutionEvalEvidenceManifest(value: CoreIssuedEvalBinding) {
    const preimage = {
      schema: "evolution-eval-connector-evidence-manifest.v1" as const,
      eval_job_id: value.dispatch.eval_job_id,
      connector_job_id: value.dispatch.connector_job_id,
      dispatch_request_hash: value.dispatch_request_hash,
      entries: [],
    };
    return { ...preimage, manifest_hash: evolutionEvalCanonicalHash(preimage) };
  }
  async evolutionEvalEvidenceEntryStream(
    _value: CoreIssuedEvalBinding,
    _name: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    if (this.evidenceAcquireErrorCode !== null) {
      throw Object.assign(new Error(this.evidenceAcquireErrorCode), {
        code: this.evidenceAcquireErrorCode,
        retryable: false,
      });
    }
    const chunks = this.evidenceChunks;
    const iterationErrorCode = this.evidenceIterationErrorCode;
    return (async function* () {
      for (const chunk of chunks) yield chunk;
      if (iterationErrorCode !== null) {
        throw Object.assign(new Error(iterationErrorCode), {
          code: iterationErrorCode,
          retryable: false,
        });
      }
    })();
  }
  async evolutionEvalQueryRetention(value: CoreIssuedEvalBinding) {
    return {
      schema: "evolution-eval-retention-result.v1" as const,
      binding: value,
      state: "pending_ack" as const,
      retryable: false,
      authorization_kind: null,
      authorization_hash: null,
      connector_fact_hash: null,
      source_authorization_kind: null,
      source_authorization_hash: null,
      source_connector_fact_hash: null,
      physical_deleted: false,
      error_code: null,
    };
  }
  async evolutionEvalAcknowledgeEvidence(request: EvalEvidenceAckRequestV1) {
    this.retentionRequests.push(request);
    return this.evolutionEvalQueryRetention(request.binding);
  }
  async evolutionEvalAcknowledgeCorrupt(request: EvalEvidenceCorruptAckRequestV1) {
    this.retentionRequests.push(request);
    return this.evolutionEvalQueryRetention(request.binding);
  }
  async evolutionEvalCleanupEvidence(request: EvalEvidenceCleanupRequestV1) {
    this.retentionRequests.push(request);
    return this.evolutionEvalQueryRetention(request.binding);
  }
}

function adapter(
  clients: Map<string, EvalRemoteClient>,
  spoolBarrier?: (projectId: string) => Promise<void>,
  certification?: ConstructorParameters<typeof RemoteConnectorAdapter>[4],
  discovery?: Partial<{
    readonly sdkWorkerBuildHash: string;
    readonly activeConfigSha256: string;
    readonly workerProcessInstanceId: string;
    readonly vivadoToolchainAttestationSha256: string;
    readonly toolchainProfileHash: string;
    readonly liveMappingHealth: "healthy" | "unavailable";
    readonly ledgerEpoch: string;
  }>,
): RemoteConnectorAdapter {
  return new RemoteConnectorAdapter(
    ((options: FactoryOptions) => {
      const client = new EvalRemoteClient(
        options,
        spoolBarrier === undefined ? undefined : () => spoolBarrier(options.projectId),
      );
      Object.assign(client, discovery);
      if (options.projectId === "project-b") client.spoolResult.unacked_bytes = 22;
      clients.set(`${options.actor.actor_id}:${options.projectId}`, client);
      return client;
    }) as never,
    { connector_id: "connector-adapter-test" },
    ["connector.test"],
    {},
    certification ?? {
      identity: CERTIFIED_IDENTITY,
      current: async () => CERTIFIED_IDENTITY,
    },
  );
}

function sealedInput(content: Uint8Array): SealedEvalInput {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    manifest: {
      schema: "evolution-eval-workspace-manifest.v1",
      workspace_id: "workspace-project-a",
      revision: 1,
      files: [{
        path: "rtl/top.sv",
        sha256,
        size_bytes: content.byteLength,
        media_type: "text/x-systemverilog",
        layer: "source",
        read_only: true,
      }],
    },
    files: (async function* () {
      yield {
        path: "rtl/top.sv",
        sha256,
        size_bytes: content.byteLength,
        media_type: "text/x-systemverilog",
        content: (async function* () { yield content; })(),
      };
    })(),
  };
}

describe("evolution-eval production Connector adapter", () => {
  test("uses an exact dispatcher actor and independent project clients for concurrent spool queries", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    let releaseA!: () => void;
    let enteredA!: () => void;
    const aEntered = new Promise<void>((resolve) => { enteredA = resolve; });
    const aRelease = new Promise<void>((resolve) => { releaseA = resolve; });
    const connector = adapter(clients, async (projectId) => {
      if (projectId === "project-a") {
        enteredA();
        await aRelease;
      }
    });

    const aPromise = connector.querySpool(binding("project-a"));
    await aEntered;
    const bResult = await connector.querySpool(binding("project-b"));
    releaseA();
    const aResult = await aPromise;

    expect(aResult.unackedBytes).toBe(0);
    expect(bResult.unackedBytes).toBe(22);
    expect([...clients.values()].map(client => ({
      actor: client.options.actor,
      projectId: client.options.projectId,
    }))).toEqual([
      {
        actor: { actor_type: "service", actor_id: "synthia-core-evolution-eval-dispatcher" },
        projectId: "project-a",
      },
      {
        actor: { actor_type: "service", actor_id: "synthia-core-evolution-eval-dispatcher" },
        projectId: "project-b",
      },
    ]);
  });

  test("encodes only the exact bounded sealed stream and checks its bytes before the RPC", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    const bytes = new TextEncoder().encode("module top; endmodule\n");
    const input = sealedInput(bytes);
    await expect(connector.submit(binding("project-a", input.manifest), input)).resolves.toMatchObject({
      state: "accepted",
    });
    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;
    expect(client.submitInput).toMatchObject({
      schema: "evolution-eval-sealed-input.v1",
      files: [{ content_base64: Buffer.from(bytes).toString("base64") }],
    });

    const valid = sealedInput(bytes);
    const corrupt: SealedEvalInput = {
      manifest: valid.manifest,
      files: (async function* () {
        yield {
          path: "rtl/top.sv",
          sha256: valid.manifest.files[0]!.sha256,
          size_bytes: bytes.byteLength,
          media_type: "text/x-systemverilog",
          content: (async function* () { yield new Uint8Array(bytes.byteLength); })(),
        };
      })(),
    };
    await expect(connector.submit(binding("project-a", corrupt.manifest), corrupt)).rejects.toThrow(
      "sealed file stream size or hash differs",
    );
  });

  test("fails before the RPC when the transmitted projection differs from the dispatch binding", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    const input = sealedInput(new TextEncoder().encode("module top; endmodule\n"));

    await expect(connector.submit(binding("project-a"), input)).rejects.toThrow(
      "sealed Connector projection differs from the Core dispatch binding",
    );
    expect(clients.size).toBe(0);
  });

  test("keeps Skill assets in the Core binding but never transmits them to Connector", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    const bytes = new TextEncoder().encode("module top; endmodule\n");
    const skillBytes = new TextEncoder().encode("puts {must never execute}\n");
    const input = sealedInput(bytes);
    const withSkill: SealedEvalInput = {
      manifest: {
        ...input.manifest,
        files: [
          ...input.manifest.files,
          {
            path: "scripts/check.tcl",
            sha256: createHash("sha256").update(skillBytes).digest("hex"),
            size_bytes: skillBytes.byteLength,
            media_type: "text/x-tcl",
            layer: "skill",
            read_only: true,
          },
        ],
      },
      // The sealed loader's Connector projection is source+overlay only.
      files: input.files,
    };

    await expect(connector.submit(binding("project-a", withSkill.manifest), withSkill)).resolves.toMatchObject({
      state: "accepted",
    });
    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;
    expect(client.submitInput).toMatchObject({
      manifest: { files: [{ path: "rtl/top.sv", layer: "source" }] },
      files: [{ path: "rtl/top.sv" }],
    });
    expect(JSON.stringify(client.submitInput)).not.toContain("scripts/check.tcl");
    expect(JSON.stringify(client.submitInput)).not.toContain(Buffer.from(skillBytes).toString("base64"));
  });

  test("fails closed on a malformed project-bound spool response", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    await connector.querySpool(binding("project-a"));
    clients.get("synthia-core-evolution-eval-dispatcher:project-a")!.spoolResult = {
      schema: "evolution-eval-spool-result.v1",
      unacked_bytes: -1,
      hard_cap_bytes: 2_147_483_648,
    };
    await expect(connector.querySpool(binding("project-a"))).rejects.toThrow(
      "evolution-eval spool response is invalid",
    );

    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;
    client.spoolResult = {
      schema: "evolution-eval-spool-result.v1",
      unacked_bytes: 0,
      hard_cap_bytes: 2_147_483_648,
    };
    client.evolutionEvalQuerySpool = async () => ({
      ...client.spoolResult,
      binding: binding("project-b"),
    });
    await expect(connector.querySpool(binding("project-a"))).rejects.toThrow(
      "evolution-eval spool response is invalid",
    );
  });

  test("uses only the dedicated streaming evidence and exact retention methods", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    const value = binding("project-a");
    const manifest = await connector.fetchEvidenceManifest(value);
    expect(manifest).toMatchObject({
      eval_job_id: value.dispatch.eval_job_id,
      connector_job_id: value.dispatch.connector_job_id,
      dispatch_request_hash: value.dispatch_request_hash,
    });
    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;
    client.evidenceChunks = [
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
    ];
    const chunks: number[][] = [];
    for await (const chunk of await connector.fetchEvidenceEntry(value, "report.json")) {
      chunks.push([...chunk]);
    }
    expect(chunks).toEqual([[1, 2], [3]]);
    expect(await connector.queryRetention(value)).toMatchObject({
      state: "pending_ack",
      physical_deleted: false,
    });

    const cleanupRequest: EvalEvidenceCleanupRequestV1 = {
      schema: "evolution-eval-evidence-cleanup-request.v1",
      binding: value,
      mode: "core_discard",
      reason: "absolute_expiry",
      core_manifest_hash: "1".repeat(64),
      core_conclusion_fact_hash: "2".repeat(64),
      core_cleanup_fact_hash: "3".repeat(64),
      discard_authorization_hash: "4".repeat(64),
    };
    await connector.cleanupEvidence(cleanupRequest);
    expect(client.retentionRequests).toEqual([cleanupRequest]);
  });

  test("preserves deterministic evidence error codes before and during stream iteration", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    const value = binding("project-a");
    await connector.fetchEvidenceManifest(value);
    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;

    client.evidenceAcquireErrorCode = "COMPATIBILITY_REJECTED";
    await expect(connector.fetchEvidenceEntry(value, "report.json"))
      .rejects.toMatchObject({ code: "COMPATIBILITY_REJECTED", retryable: false });

    client.evidenceAcquireErrorCode = null;
    client.evidenceIterationErrorCode = "EVIDENCE_LIMIT_EXCEEDED";
    const consume = async () => {
      for await (const _chunk of await connector.fetchEvidenceEntry(value, "report.json")) {
        // consume the real async boundary
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "EVIDENCE_LIMIT_EXCEEDED" });
  });

  test("rechecks B identity and injects exact reserve/submit attestation without blocking recovery", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    let valid = true;
    const connector = adapter(clients, undefined, {
      identity: CERTIFIED_IDENTITY,
      current: async () => {
        if (!valid) throw new Error("B expired");
        return CERTIFIED_IDENTITY;
      },
    });
    const value = binding("project-a");
    await expect(connector.preflight(value)).resolves.toMatchObject({ eligible: true });
    await expect(connector.queryOrReserve(value)).resolves.toMatchObject({ state: "accepted" });
    const input = sealedInput(new TextEncoder().encode("module top; endmodule\n"));
    await expect(connector.submit(binding("project-a", input.manifest), input))
      .resolves.toMatchObject({ state: "accepted" });
    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;
    const expectedAttestation = {
      active_config_sha256: CERTIFIED_IDENTITY.activeConfigSha256,
      worker_process_instance_id: CERTIFIED_IDENTITY.workerProcessInstanceId,
      vivado_toolchain_attestation_sha256:
        CERTIFIED_IDENTITY.vivadoToolchainAttestationSha256,
    };
    expect(client.reserveAttestation).toEqual(expectedAttestation);
    expect(client.submitAttestation).toEqual(expectedAttestation);

    valid = false;
    await expect(connector.query(value)).resolves.toMatchObject({ state: "accepted" });
    await expect(connector.preflight(value)).rejects.toMatchObject({
      code: "EVOLUTION_EVAL_CERTIFICATION_INVALID",
    });
    await expect(connector.queryOrReserve(value)).rejects.toMatchObject({
      code: "EVOLUTION_EVAL_CERTIFICATION_INVALID",
    });
  });

  test("recovery-only tolerates certified identity drift while new effects remain fail closed", async () => {
    const restartedInstanceId = "00000000-0000-4000-8000-000000000002";
    const restarted = adapter(new Map(), undefined, undefined, {
      workerProcessInstanceId: restartedInstanceId,
    });
    await expect(restarted.revalidateEvolutionEvalCertification(binding("project-a"), false))
      .resolves.toBeUndefined();
    await expect(restarted.revalidateEvolutionEvalCertification(binding("project-a"), true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });

    const buildDrift = adapter(new Map(), undefined, undefined, {
      sdkWorkerBuildHash: "f".repeat(64),
      workerProcessInstanceId: restartedInstanceId,
    });
    await expect(buildDrift.revalidateEvolutionEvalCertification(binding("project-a"), false))
      .resolves.toBeUndefined();

    const configDrift = adapter(new Map(), undefined, undefined, {
      activeConfigSha256: "e".repeat(64),
      workerProcessInstanceId: restartedInstanceId,
    });
    await expect(configDrift.revalidateEvolutionEvalCertification(binding("project-a"), false))
      .resolves.toBeUndefined();

    const toolchainDrift = adapter(new Map(), undefined, undefined, {
      vivadoToolchainAttestationSha256: "d".repeat(64),
      workerProcessInstanceId: restartedInstanceId,
    });
    await expect(toolchainDrift.revalidateEvolutionEvalCertification(binding("project-a"), false))
      .resolves.toBeUndefined();
    await expect(toolchainDrift.queryOrReserve(binding("project-a")))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
  });

  test("authenticated live probe checks mapping health, profile, and ledger epoch for each new-effect tick", async () => {
    const clients = new Map<string, EvalRemoteClient>();
    const connector = adapter(clients);
    const value = binding("project-a");
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .resolves.toBeUndefined();
    const client = clients.get("synthia-core-evolution-eval-dispatcher:project-a")!;

    client.liveMappingHealth = "unavailable";
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    client.liveMappingHealth = "healthy";

    client.sdkWorkerBuildHash = "f".repeat(64);
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    client.sdkWorkerBuildHash = CERTIFIED_IDENTITY.sdkWorkerBuildHash;

    client.activeConfigSha256 = "e".repeat(64);
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    client.activeConfigSha256 = CERTIFIED_IDENTITY.activeConfigSha256;

    client.workerProcessInstanceId = "00000000-0000-4000-8000-000000000002";
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    client.workerProcessInstanceId = CERTIFIED_IDENTITY.workerProcessInstanceId;

    client.vivadoToolchainAttestationSha256 = "d".repeat(64);
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    client.vivadoToolchainAttestationSha256 =
      CERTIFIED_IDENTITY.vivadoToolchainAttestationSha256;

    client.toolchainProfileHash = "f".repeat(64);
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    client.toolchainProfileHash = CERTIFIED_IDENTITY.toolchainProfileHash;
    client.ledgerEpoch = "epoch-drift";
    await expect(connector.revalidateEvolutionEvalCertification(value, true))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_LEDGER_EPOCH_MISMATCH" });
  });

  test("pins every reloaded B identity field to the startup certification", async () => {
    const drifts = [
      { sdkWorkerBuildHash: "a".repeat(64) },
      { activeConfigSha256: "b".repeat(64) },
      { workerProcessInstanceId: "00000000-0000-4000-8000-000000000002" },
      { ledgerEpoch: "epoch-reloaded-drift" },
      { vivadoToolchainAttestationSha256: "d".repeat(64) },
      { toolchainProfileHash: "e".repeat(64) },
    ] as const;

    for (const drift of drifts) {
      const connector = adapter(new Map(), undefined, {
        identity: CERTIFIED_IDENTITY,
        current: async () => ({ ...CERTIFIED_IDENTITY, ...drift }),
      });
      await expect(connector.revalidateEvolutionEvalCertification(binding("project-a"), true))
        .rejects.toMatchObject({ code: "EVOLUTION_EVAL_CERTIFICATION_INVALID" });
    }
  });
});

const directMtlsRoots: string[] = [];

afterEach(() => {
  for (const root of directMtlsRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("M4-F 18443 direct mTLS material", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "synthia-m4f-mtls-"));
    directMtlsRoots.push(root);
    const caPath = join(root, "ca.pem");
    const certPath = join(root, "client.pem");
    const keyPath = join(root, "client-key.pem");
    const ca = "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n";
    const cert = "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n";
    const key = "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n";
    for (const [path, value] of [[caPath, ca], [certPath, cert], [keyPath, key]]) {
      writeFileSync(path, value, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const env = {
      SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION: "I_AUTHORIZE_M4F_18443_DIRECT_MTLS",
      SYNTHIA_M4F_DIRECT_MTLS_CA_PATH: caPath,
      SYNTHIA_M4F_DIRECT_MTLS_CA_SHA256: hash(ca),
      SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_PATH: certPath,
      SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_SHA256: hash(cert),
      SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_PATH: keyPath,
      SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_SHA256: hash(key),
    };
    return { ca, cert, key, caPath, certPath, keyPath, env };
  }

  test("loads only exact-mode, owner-bound, hash-bound distinct PEM files", () => {
    const scenario = fixture();
    expect(loadM4fDirectMtlsMaterial(scenario.env)).toEqual({
      ca: scenario.ca,
      cert: scenario.cert,
      key: scenario.key,
      caSha256: scenario.env.SYNTHIA_M4F_DIRECT_MTLS_CA_SHA256,
      certSha256: scenario.env.SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_SHA256,
      keySha256: scenario.env.SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_SHA256,
    });
  });

  test("rejects missing authorization, path reuse, hash drift, and permissive key mode", () => {
    const unauthorized = fixture();
    delete (unauthorized.env as Record<string, string | undefined>)
      .SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION;
    expect(() => loadM4fDirectMtlsMaterial(unauthorized.env))
      .toThrow("AUTHORIZATION is required");

    const reused = fixture();
    reused.env.SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_PATH = reused.caPath;
    expect(() => loadM4fDirectMtlsMaterial(reused.env)).toThrow("paths must be distinct");

    const drift = fixture();
    writeFileSync(drift.certPath, `${drift.cert}replacement\n`);
    expect(() => loadM4fDirectMtlsMaterial(drift.env)).toThrow("binding is untrusted");

    const permissive = fixture();
    chmodSync(permissive.keyPath, 0o644);
    expect(() => loadM4fDirectMtlsMaterial(permissive.env)).toThrow("binding is untrusted");
  });

  test("builds the isolated adapter without Cloudflare credentials and never falls back to 8443", async () => {
    const scenario = fixture();
    const configPath = join(directMtlsRoots.at(-1)!, "connector.json");
    writeFileSync(configPath, JSON.stringify({
      connector_id: "vivado-m4f-gate",
      display_name: "M4-F sidecar",
      endpoint_url: "https://192.0.2.1:443",
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
    }), { mode: 0o600 });
    const connector = await createConnectorFromEnv({
      configPath,
      endpointUrl: "https://100.96.223.49:18443",
      env: scenario.env,
    });
    expect(connector).toBeInstanceOf(RemoteConnectorAdapter);

    await expect(createConnectorFromEnv({
      configPath,
      endpointUrl: "https://100.96.223.49:8443",
      env: {
        ...scenario.env,
        SYNTHIA_CF_ACCESS_CLIENT_ID: "must-not-enable-fallback",
        SYNTHIA_CF_ACCESS_CLIENT_SECRET: "must-not-enable-fallback",
      },
    })).rejects.toThrow("cannot target a non-18443 endpoint");
  });
});
