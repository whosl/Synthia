import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertVivadoToolchainAttestationFresh,
  assertConnectorConfigMatchesCertification,
  certifyEvolutionEvalRemote,
  createM4fCertificationRemoteClient,
  deriveVivadoToolchainProfileHash,
  gateDatabaseIdentity,
  loadEvolutionEvalNewEffectsCertification,
  parseEvolutionEvalCanaryReservationReceipt,
  parseEvolutionEvalF0Certification,
  parseVivadoToolchainAttestation,
  parseWorkerReleaseManifest,
  reserveEvolutionEvalCanary,
  resolveM4fGateEndpoint,
  type CertificationRemoteClient,
  type CertificationReservationRemoteClient,
  type WorkerReleaseManifestV1,
} from "../scripts/certify-evolution-eval-m4f.ts";
import { evolutionEvalCanonicalHash } from "../src/domain/evolution-eval.ts";
import type { CoreIssuedEvalBinding } from "../src/services/evolution-eval-connector-port.ts";
import { canonicalEvolutionEvalHash } from "../../connector/evolution-eval.ts";
import { validateVivadoToolchainAttestation } from "../../connector/toolchain-attestation.ts";

const HASHES = {
  bundle: "1".repeat(64),
  runtime: "2".repeat(64),
  config: "3".repeat(64),
  launcher: "4".repeat(64),
  certifier: "5".repeat(64),
  sourceA: "6".repeat(64),
  sourceB: "7".repeat(64),
  partCatalog: "8".repeat(64),
  profile: "9".repeat(64),
};
const ACTIVE_CONFIG_SHA256 = "0".repeat(64);
const PRE_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const POST_INSTANCE_ID = "00000000-0000-4000-8000-000000000002";
const TOOLCHAIN_NOT_BEFORE = new Date(Date.now() - 120_000).toISOString();
const TOOLCHAIN_ISSUED_AT = TOOLCHAIN_NOT_BEFORE;
const TOOLCHAIN_EXPIRES_AT = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolchainAttestationValue(): Record<string, unknown> {
  const fileIdentity = {
    volume_serial_number: "volume-serial-1",
    file_id: "file-id-1",
  };
  const volumeIdentity = {
    guid: "volume-guid-1",
    serial_number: "volume-serial-2",
    file_system: "NTFS" as const,
    mount_path: "V:\\",
  };
  const body = {
    schema: "synthia-vivado-toolchain-attestation.v1" as const,
    gate_id: "gate-1",
    issued_at: TOOLCHAIN_ISSUED_AT,
    not_before: TOOLCHAIN_NOT_BEFORE,
    expires_at: TOOLCHAIN_EXPIRES_AT,
    vhdx: {
      path: "D:\\synthia-toolchain\\vivado-2021.1.vhdx",
      sha256: "a".repeat(64),
      size_bytes: 1024,
      file_identity: fileIdentity,
      backing_parent: {
        path: "D:\\synthia-toolchain",
        owner_sid: "S-1-5-18",
        acl_sha256: "f".repeat(64),
        protected: true as const,
      },
    },
    attachment: {
      image_path: "D:\\synthia-toolchain\\vivado-2021.1.vhdx",
      attached: true as const,
      read_only: true as const,
      disk: {
        number: 7,
        unique_id: "disk-unique-id-1",
      },
      partition: {
        number: 1,
        guid: "partition-guid-1",
      },
      volume: {
        ...volumeIdentity,
        identity_canonical_sha256: evolutionEvalCanonicalHash(volumeIdentity),
      },
      write_probe: "access_denied" as const,
      backing_file_identity: fileIdentity,
    },
    full_tree_manifest: {
      schema: "synthia-vivado-full-tree-manifest.v1" as const,
      canonical_sha256: "b".repeat(64),
      entry_count: 12,
      file_count: 10,
      total_bytes: 512,
    },
    vivado: {
      binary_relative_path: "Vivado/2021.1/bin/vivado.bat",
      version: "2021.1",
      sw_build: "3247384",
      ip_build: "3246043",
      version_probe_stdout_sha256: "c".repeat(64),
      part_catalog_sha256: HASHES.partCatalog,
      target_part: "xc7k70tfbv676-1",
      part_present: true as const,
      part_probe_stdout_sha256: "d".repeat(64),
      license: {
        status: "passed" as const,
        stdout_sha256: "e".repeat(64),
        exit_code: 0 as const,
      },
      minimal_synth: {
        status: "passed" as const,
        input_sha256: "1".repeat(64),
        stdout_sha256: "2".repeat(64),
        exit_code: 0 as const,
      },
    },
    toolchain_profile: {
      capability_map_version: "vivado-2021.1-1",
      semantic_profile_sha256: "3".repeat(64),
      derived_sha256: "",
    },
  };
  body.toolchain_profile.derived_sha256 = deriveVivadoToolchainProfileHash(body);
  return {
    ...body,
    canonical_attestation_sha256: evolutionEvalCanonicalHash(body),
  };
}

const TOOLCHAIN_ATTESTATION_TEXT = JSON.stringify(toolchainAttestationValue());
const TOOLCHAIN_ATTESTATION_SHA256 = sha256(TOOLCHAIN_ATTESTATION_TEXT);
const TOOLCHAIN_ATTESTATION = parseVivadoToolchainAttestation(
  JSON.parse(TOOLCHAIN_ATTESTATION_TEXT),
);
(HASHES as { profile: string }).profile =
  TOOLCHAIN_ATTESTATION.toolchain_profile.derived_sha256;
const TOOLCHAIN_OPTIONS = {
  toolchainAttestation: TOOLCHAIN_ATTESTATION,
  toolchainAttestationRawSha256: TOOLCHAIN_ATTESTATION_SHA256,
};

const capabilities = [
  "implement",
  "simulate",
  "synthesize",
  "validate_sources",
].map((operation) => ({
  operation,
  version: "vivado-batch-1",
  run_classes: ["evolution_eval"],
}));

function releaseValue(): Record<string, unknown> {
  const body = {
    schema: "synthia-worker-release-manifest.v1" as const,
    git_commit: "a".repeat(40),
    source_state: "clean" as const,
    git_status_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    bundle: {
      path: "server.bundle.mjs" as const,
      size_bytes: 123,
      sha256: HASHES.bundle,
    },
    runtime: {
      kind: "bun" as const,
      version: "1.4.1" as const,
      executable_name: "bun.exe" as const,
      sha256: HASHES.runtime,
    },
    release_files: {
      config_template_sha256: HASHES.config,
      launcher_sha256: HASHES.launcher,
      windows_certifier_sha256: HASHES.certifier,
    },
    sources: [
      { path: "a.ts", sha256: HASHES.sourceA },
      { path: "z/b.ts", sha256: HASHES.sourceB },
    ],
    expected: {
      sdk_worker_build_hash: HASHES.bundle,
      protocol_version: "connector.remote.v1" as const,
      capability_map_version: "vivado-2021.1-1",
      part_catalog_hash: HASHES.partCatalog,
      toolchain_profile_hash: HASHES.profile,
      vivado_version: "2021.1",
      vivado_patch: "3247384",
      part: "xc7k70tfbv676-1",
      capabilities,
    },
  };
  return { ...body, manifest_hash: evolutionEvalCanonicalHash(body) };
}

function binding(): CoreIssuedEvalBinding {
  const dispatch = {
    schema: "evolution-eval-dispatch-request.v1" as const,
    eval_job_id: "eval-cert-canary",
    connector_job_id: "connector-cert-canary",
    connector_idempotency_key: "a".repeat(64),
    eval_input_ref: "input-cert-canary",
    input_manifest_hash: "b".repeat(64),
    workspace_id: "workspace-cert-canary",
    workspace_revision: 1,
    workspace_manifest_hash: "c".repeat(64),
    sealed_input_projection_hash: "d".repeat(64),
    operation: "validate_sources" as const,
    parameters: {
      operation: "validate_sources" as const,
      source_paths: ["top.v"],
      top: null,
    },
    part: null,
    toolchain_profile_hash: HASHES.profile,
    requested_timeout_ms: 30_000,
    operation_cap_ms: 7_200_000 as const,
    deadline_at: "2026-08-27T10:00:00.000Z",
    run_class: "evolution_eval" as const,
  };
  return {
    project_id: "p1",
    dispatch_request_hash: evolutionEvalCanonicalHash(dispatch),
    dispatch,
  };
}

function discovery(
  release: WorkerReleaseManifestV1,
  activeConfigSha256 = ACTIVE_CONFIG_SHA256,
  workerProcessInstanceId = POST_INSTANCE_ID,
) {
  return {
    connector_id: "vivado-gate-1",
    connector_protocol_version: release.expected.protocol_version,
    capability_map_version: release.expected.capability_map_version,
    vivado_version: release.expected.vivado_version,
    vivado_patch: release.expected.vivado_patch,
    part_catalog_hash: release.expected.part_catalog_hash,
    sdk_worker_build_hash: release.expected.sdk_worker_build_hash,
    capabilities: release.expected.capabilities.map((capability) => ({
      operation: capability.operation,
      version: capability.version,
      runClasses: capability.run_classes,
    })),
    toolchain_profile_hash: release.expected.toolchain_profile_hash,
    license_status: "available",
    active_config_sha256: activeConfigSha256,
    worker_process_instance_id: workerProcessInstanceId,
    vivado_toolchain_attestation_sha256: TOOLCHAIN_ATTESTATION_SHA256,
    live_mapping_health: "healthy" as const,
  };
}

function connectorConfig(release: WorkerReleaseManifestV1) {
  return {
    connector_id: "vivado-gate-1",
    protocol_version: release.expected.protocol_version,
    capability_map_version: release.expected.capability_map_version,
    part_catalog_hash: release.expected.part_catalog_hash,
    toolchain_profile_hash: release.expected.toolchain_profile_hash,
    sdk_worker_build_hash: release.expected.sdk_worker_build_hash,
    vivado_part: release.expected.part,
    vivado_toolchain_attestation_path:
      "D:\\synthia-toolchain\\synthia-vivado-toolchain-attestation.v1.json",
    vivado_toolchain_attestation_sha256: TOOLCHAIN_ATTESTATION_SHA256,
    evolution_eval_enabled: true,
    evolution_eval_ledger_mode: "reopen",
    evolution_eval_ledger_epoch: "epoch-gate-1",
    evolution_eval_log_root: "C:\\Windows\\Temp\\synthia-m4f-gate-1\\logs",
    allowed_capability_ids: release.expected.capabilities.map((capability) => capability.operation),
  };
}

function remoteFixture(
  release: WorkerReleaseManifestV1,
  calls: string[],
  overrides: {
    readonly discovery?: Record<string, unknown>;
    readonly observation?: Record<string, unknown>;
    readonly heartbeat?: Record<string, unknown>;
    readonly activeConfigSha256?: string;
    readonly workerProcessInstanceId?: string;
    readonly toolchainAttestationSha256?: string;
  } = {},
): CertificationReservationRemoteClient {
  const canary = binding();
  return {
    async register() {
      calls.push("register");
      return { registration_state: "approved" };
    },
    async heartbeat() {
      calls.push("heartbeat");
      return {
        registration_state: "ready",
        capability_drift: false,
        ...overrides.heartbeat,
      };
    },
    async discover() {
      calls.push("discover");
      return {
        ...discovery(
          release,
          overrides.activeConfigSha256,
          overrides.workerProcessInstanceId,
        ),
        vivado_toolchain_attestation_sha256:
          overrides.toolchainAttestationSha256 ?? TOOLCHAIN_ATTESTATION_SHA256,
        ...overrides.discovery,
      } as ReturnType<typeof discovery>;
    },
    async evolutionEvalQuery() {
      calls.push("query");
      return overrides.observation ?? {
        schema: "evolution-eval-ledger-query.v1",
        state: "proven_never_accepted",
        connector_job_id: canary.dispatch.connector_job_id,
        connector_idempotency_key: canary.dispatch.connector_idempotency_key,
        dispatch_request_hash: canary.dispatch_request_hash,
        ledger_epoch: "epoch-gate-1",
        replay_permitted: true,
      };
    },
    async evolutionEvalReserve() {
      calls.push("reserve");
      return overrides.observation ?? {
        schema: "evolution-eval-ledger-query.v1",
        state: "proven_never_accepted",
        connector_job_id: canary.dispatch.connector_job_id,
        connector_idempotency_key: canary.dispatch.connector_idempotency_key,
        dispatch_request_hash: canary.dispatch_request_hash,
        ledger_epoch: "epoch-gate-1",
        replay_permitted: true,
      };
    },
  };
}

async function reservationReceiptOptions(
  release: WorkerReleaseManifestV1,
  options: {
    readonly activeConfigSha256?: string;
    readonly databaseUrl?: string;
    readonly calls?: string[];
  } = {},
): Promise<{
  readonly reservationReceiptBytes: Uint8Array;
  readonly expectedReservationReceiptFileSha256: string;
}> {
  const calls = options.calls ?? [];
  const receipt = await reserveEvolutionEvalCanary({
    gateId: "gate-1",
    activeConfigSha256: options.activeConfigSha256 ?? ACTIVE_CONFIG_SHA256,
    database: gateDatabaseIdentity(
      options.databaseUrl ?? "postgres://db/synthia-selfevo-gate-1",
    ),
    connectorId: "vivado-gate-1",
    releaseManifest: release,
    ...TOOLCHAIN_OPTIONS,
    canaryBinding: binding(),
    verifyCoreIssuedCanary: async () => undefined,
    remote: remoteFixture(release, calls, {
      activeConfigSha256: options.activeConfigSha256 ?? ACTIVE_CONFIG_SHA256,
      workerProcessInstanceId: PRE_INSTANCE_ID,
    }),
  });
  const reservationReceiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  return {
    reservationReceiptBytes,
    expectedReservationReceiptFileSha256: createHash("sha256")
      .update(reservationReceiptBytes)
      .digest("hex"),
  };
}

describe("M4-F worker release and F0 certification", () => {
  test("dispatcher host never falls back to the production endpoint", () => {
    expect(resolveM4fGateEndpoint({
      dispatcherHostEnabled: false,
      endpoint: undefined,
      allowedOrigin: undefined,
    })).toBeUndefined();
    expect(() => resolveM4fGateEndpoint({
      dispatcherHostEnabled: true,
      endpoint: undefined,
      allowedOrigin: undefined,
    })).toThrow("ENDPOINT_URL is required");
    expect(resolveM4fGateEndpoint({
      dispatcherHostEnabled: true,
      endpoint: "https://gate.example.test",
      allowedOrigin: "https://gate.example.test",
    })).toBe("https://gate.example.test");
  });

  test("18443 certification selects the hardened direct-mTLS factory with frozen PEM bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synthia-m4f-cert-mtls-"));
    try {
      const ca = "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n";
      const cert = "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n";
      const key = "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n";
      const caPath = join(directory, "ca.pem");
      const certPath = join(directory, "client.pem");
      const keyPath = join(directory, "client-key.pem");
      await Promise.all([
        writeFile(caPath, ca, { mode: 0o600 }),
        writeFile(certPath, cert, { mode: 0o600 }),
        writeFile(keyPath, key, { mode: 0o600 }),
      ]);
      const env = {
        SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION: "I_AUTHORIZE_M4F_18443_DIRECT_MTLS",
        SYNTHIA_M4F_DIRECT_MTLS_CA_PATH: caPath,
        SYNTHIA_M4F_DIRECT_MTLS_CA_SHA256: sha256(ca),
        SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_PATH: certPath,
        SYNTHIA_M4F_DIRECT_MTLS_CLIENT_CERT_SHA256: sha256(cert),
        SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_PATH: keyPath,
        SYNTHIA_M4F_DIRECT_MTLS_CLIENT_KEY_SHA256: sha256(key),
      };
      let directOptions: Record<string, unknown> | null = null;
      let cloudflareCalls = 0;
      const fakeRemote = remoteFixture(parseWorkerReleaseManifest(releaseValue()), []);
      await expect(createM4fCertificationRemoteClient({
        endpointOrigin: "https://100.96.223.49:18443",
        config: {
          transport_mode: "direct_https",
          auth_mode: "mtls",
          tls_trust_ref: "cert://m4f-direct/trust",
          tls_client_cert_ref: "cert://m4f-direct/client",
        },
        projectId: "project-gate-1",
        env,
        factories: {
          createDirectMtlsRemoteConnector(options) {
            directOptions = options;
            return fakeRemote;
          },
          createEnvironmentCloudflareRemoteConnector() {
            cloudflareCalls += 1;
            return fakeRemote;
          },
        },
      })).resolves.toBe(fakeRemote);
      expect(cloudflareCalls).toBe(0);
      expect(directOptions).toMatchObject({ ca, cert, key, projectId: "project-gate-1" });
      expect((directOptions!.endpoint as Record<string, unknown>)).toMatchObject({
        endpoint_url: "https://100.96.223.49:18443",
        tls_trust_ref: "cert://m4f-direct/trust",
        tls_client_cert_ref: "cert://m4f-direct/client",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("certification rejects direct credentials on another origin and unreviewed 18443 TLS refs", async () => {
    const fakeRemote = remoteFixture(parseWorkerReleaseManifest(releaseValue()), []);
    const factories = {
      createDirectMtlsRemoteConnector: () => fakeRemote,
      createEnvironmentCloudflareRemoteConnector: () => fakeRemote,
    };
    await expect(createM4fCertificationRemoteClient({
      endpointOrigin: "https://gate.example.test",
      config: {},
      projectId: "project-gate-1",
      env: { SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION: "I_AUTHORIZE_M4F_18443_DIRECT_MTLS" },
      factories,
    })).rejects.toThrow("cannot target a non-18443 endpoint");
    await expect(createM4fCertificationRemoteClient({
      endpointOrigin: "https://100.96.223.49:18443",
      config: {
        transport_mode: "direct_https",
        auth_mode: "mtls",
        tls_trust_ref: "secret://trust/cloudflare-edge",
        tls_client_cert_ref: "secret://cert/cloudflare-origin",
      },
      projectId: "project-gate-1",
      env: {},
      factories,
    })).rejects.toThrow("reviewed mTLS Connector config");
  });

  test("strictly parses canonical A and rejects key, sort, and hash drift", () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const releasePreimage = { ...release } as Record<string, unknown>;
    delete releasePreimage.manifest_hash;
    expect(release.manifest_hash).toBe(evolutionEvalCanonicalHash(releasePreimage));

    const extra = { ...releaseValue(), secret: "forbidden" };
    expect(() => parseWorkerReleaseManifest(extra)).toThrow("unsupported or missing fields");

    const unsortedBody = releaseValue();
    unsortedBody.sources = [...(unsortedBody.sources as unknown[])].reverse();
    const { manifest_hash: ignored, ...unsortedPreimage } = unsortedBody;
    expect(() => parseWorkerReleaseManifest({
      ...unsortedBody,
      manifest_hash: evolutionEvalCanonicalHash(unsortedPreimage),
    })).toThrow("bytewise sorted");

    expect(() => parseWorkerReleaseManifest({
      ...releaseValue(),
      manifest_hash: "f".repeat(64),
    })).toThrow("manifest_hash is invalid");

    const dirtyEmpty = releaseValue();
    dirtyEmpty.source_state = "dirty";
    const dirtyEmptyPreimage = { ...dirtyEmpty };
    delete dirtyEmptyPreimage.manifest_hash;
    expect(() => parseWorkerReleaseManifest({
      ...dirtyEmptyPreimage,
      manifest_hash: evolutionEvalCanonicalHash(dirtyEmptyPreimage),
    })).toThrow("dirty worker release cannot bind the empty git status");
  });

  test("strictly parses a read-only Vivado toolchain attestation with at most four-hour validity", () => {
    expect(parseVivadoToolchainAttestation(toolchainAttestationValue()))
      .toEqual(TOOLCHAIN_ATTESTATION);
    const caseVariant = toolchainAttestationValue();
    caseVariant.attachment = {
      ...(caseVariant.attachment as Record<string, unknown>),
      image_path: "d:/SYNTHIA-TOOLCHAIN/VIVADO-2021.1.VHDX",
    };
    const caseVariantBody = { ...caseVariant };
    delete caseVariantBody.canonical_attestation_sha256;
    expect(() => parseVivadoToolchainAttestation({
      ...caseVariantBody,
      canonical_attestation_sha256: evolutionEvalCanonicalHash(caseVariantBody),
    })).not.toThrow();
    expect(() => parseVivadoToolchainAttestation({
      ...toolchainAttestationValue(),
      unsupported: true,
    })).toThrow("unsupported or missing fields");

    const tooLong = toolchainAttestationValue();
    tooLong.expires_at = new Date(Date.parse(TOOLCHAIN_NOT_BEFORE) + 4 * 60 * 60 * 1000 + 1)
      .toISOString();
    const tooLongBody = { ...tooLong };
    delete tooLongBody.canonical_attestation_sha256;
    expect(() => parseVivadoToolchainAttestation({
      ...tooLongBody,
      canonical_attestation_sha256: evolutionEvalCanonicalHash(tooLongBody),
    })).toThrow("validity window is invalid");

    const writable = toolchainAttestationValue();
    writable.attachment = {
      ...(writable.attachment as Record<string, unknown>),
      write_probe: "succeeded",
    };
    const writableBody = { ...writable };
    delete writableBody.canonical_attestation_sha256;
    expect(() => parseVivadoToolchainAttestation({
      ...writableBody,
      canonical_attestation_sha256: evolutionEvalCanonicalHash(writableBody),
    })).toThrow("not read-only");
  });

  test("shares one canonical attestation fixture with Connector independent of key order", () => {
    const fixture = toolchainAttestationValue();
    const reordered = Object.fromEntries(Object.entries(fixture).reverse());
    reordered.attachment = Object.fromEntries(Object.entries(
      reordered.attachment as Record<string, unknown>,
    ).reverse());
    const now = new Date(
      (Date.parse(TOOLCHAIN_NOT_BEFORE) + Date.parse(TOOLCHAIN_EXPIRES_AT)) / 2,
    );

    const coreParsed = parseVivadoToolchainAttestation(reordered);
    const connectorParsed = validateVivadoToolchainAttestation(reordered, { now });

    expect(coreParsed).toEqual(connectorParsed);
    expect(evolutionEvalCanonicalHash(fixture)).toBe(canonicalEvolutionEvalHash(reordered));
    expect(coreParsed.canonical_attestation_sha256)
      .toBe(connectorParsed.canonical_attestation_sha256);
  });

  test("rejects non-portable or non-Unicode-scalar attestation strings and fixed-fact drift", () => {
    const invalidBinary = structuredClone(toolchainAttestationValue());
    (invalidBinary.vivado as Record<string, unknown>).binary_relative_path =
      "Vivado\\2021.1\\bin\\vivado.bat";
    expect(() => parseVivadoToolchainAttestation(invalidBinary))
      .toThrow("portable relative path");

    const invalidUnicode = structuredClone(toolchainAttestationValue());
    const invalidUnicodeVhdx = invalidUnicode.vhdx as Record<string, unknown>;
    invalidUnicodeVhdx.backing_parent = {
      ...(invalidUnicodeVhdx.backing_parent as Record<string, unknown>),
      owner_sid: `S-1-5-18-${String.fromCharCode(0xd800)}`,
    };
    expect(() => parseVivadoToolchainAttestation(invalidUnicode))
      .toThrow("invalid Unicode");

    const nonNfc = structuredClone(toolchainAttestationValue());
    const nonNfcVhdx = nonNfc.vhdx as Record<string, unknown>;
    nonNfcVhdx.backing_parent = {
      ...(nonNfcVhdx.backing_parent as Record<string, unknown>),
      owner_sid: "S-1-5-18-e\u0301",
    };
    expect(() => parseVivadoToolchainAttestation(nonNfc))
      .toThrow("NFC normalized");

    const versionDrift = structuredClone(toolchainAttestationValue());
    (versionDrift.vivado as Record<string, unknown>).version = "2021.2";
    expect(() => parseVivadoToolchainAttestation(versionDrift))
      .toThrow("fixed Vivado facts");
  });

  test("both sides reject an attestation after its signed validity window", () => {
    const fixture = toolchainAttestationValue();
    const expiredNow = new Date(Date.parse(TOOLCHAIN_EXPIRES_AT) + 1);
    const parsed = parseVivadoToolchainAttestation(fixture);

    expect(() => assertVivadoToolchainAttestationFresh(parsed, expiredNow))
      .toThrow("not fresh");
    expect(() => validateVivadoToolchainAttestation(fixture, { now: expiredNow }))
      .toThrow("TOOLCHAIN_ATTESTATION_INVALID:validity");
  });

  test("certifies only register, heartbeat, discover, and never-accepted query", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const calls: string[] = [];
    let verifiedBindingHash = "";
    const certification = await certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://user:secret@db:5432/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      ...(await reservationReceiptOptions(release)),
      verifyCoreIssuedCanary: async (candidate) => {
        verifiedBindingHash = evolutionEvalCanonicalHash(candidate);
      },
      remote: remoteFixture(release, calls),
    });

    expect(calls).toEqual(["register", "heartbeat", "discover", "query"]);
    expect(verifiedBindingHash).toBe(certification.canary.binding_hash);
    expect(certification.remote.sdk_worker_build_hash).toBe(HASHES.bundle);
    expect(certification.remote.license_status).toBe("available");
    expect(certification.ledger).toEqual({ epoch: "epoch-gate-1", health: "healthy" });
    expect(certification.canary.state).toBe("proven_never_accepted");
    expect(parseEvolutionEvalF0Certification(
      certification,
      release,
      TOOLCHAIN_ATTESTATION,
      TOOLCHAIN_ATTESTATION_SHA256,
    )).toEqual(certification);
  });

  test("reserve is a separate four-call stage and certify proves a different process instance", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const reserveCalls: string[] = [];
    const receipt = await reservationReceiptOptions(release, { calls: reserveCalls });
    expect(reserveCalls).toEqual(["register", "heartbeat", "discover", "reserve"]);
    const parsedReceipt = JSON.parse(Buffer.from(receipt.reservationReceiptBytes).toString("utf8"));
    expect(parsedReceipt).toMatchObject({
      active_config_sha256: ACTIVE_CONFIG_SHA256,
      pre_worker_process_instance_id: PRE_INSTANCE_ID,
      ledger_epoch: "epoch-gate-1",
      state: "proven_never_accepted",
    });

    const certifyCalls: string[] = [];
    await expect(certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      ...receipt,
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, certifyCalls, {
        workerProcessInstanceId: PRE_INSTANCE_ID,
      }),
    })).rejects.toThrow("WORKER_RESTART_NOT_PROVEN");
    expect(certifyCalls).toEqual(["register", "heartbeat", "discover"]);
  });

  test("reservation receipt parser preserves the validated live mapping health union", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const receipt = await reservationReceiptOptions(release);
    const value = JSON.parse(Buffer.from(receipt.reservationReceiptBytes).toString("utf8"));
    const unavailableBody = { ...value, live_mapping_health: "unavailable" };
    delete unavailableBody.receipt_hash;
    const unavailable = {
      ...unavailableBody,
      receipt_hash: evolutionEvalCanonicalHash(unavailableBody),
    };

    expect(parseEvolutionEvalCanaryReservationReceipt(value).live_mapping_health).toBe("healthy");
    expect(parseEvolutionEvalCanaryReservationReceipt(unavailable).live_mapping_health).toBe("unavailable");
    expect(() => parseEvolutionEvalCanaryReservationReceipt({
      ...unavailable,
      live_mapping_health: "degraded",
    })).toThrow("state is invalid");
  });

  test("independent raw receipt hash rejects a forged pre-instance before remote calls", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const receipt = await reservationReceiptOptions(release);
    const forged = JSON.parse(Buffer.from(receipt.reservationReceiptBytes).toString("utf8"));
    forged.pre_worker_process_instance_id = "00000000-0000-4000-8000-000000000099";
    const forgedBody = { ...forged };
    delete forgedBody.receipt_hash;
    forged.receipt_hash = evolutionEvalCanonicalHash(forgedBody);
    const calls: string[] = [];
    await expect(certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      reservationReceiptBytes: Buffer.from(`${JSON.stringify(forged)}\n`),
      expectedReservationReceiptFileSha256: receipt.expectedReservationReceiptFileSha256,
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, calls),
    })).rejects.toThrow("CANARY_RESERVATION_RECEIPT_FILE_HASH_MISMATCH");
    expect(calls).toEqual([]);
  });

  test("fails closed before query when actual remote identity differs from A", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const calls: string[] = [];
    await expect(certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      ...(await reservationReceiptOptions(release)),
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, calls, {
        discovery: { sdk_worker_build_hash: "f".repeat(64) },
      }),
    })).rejects.toThrow("REMOTE_RELEASE_IDENTITY_MISMATCH");
    expect(calls).toEqual(["register", "heartbeat", "discover"]);
  });

  test("heartbeat requires an explicit no-drift observation", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const calls: string[] = [];
    await expect(certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      ...(await reservationReceiptOptions(release)),
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, calls, {
        heartbeat: { capability_drift: undefined },
      }),
    })).rejects.toThrow("REMOTE_HEARTBEAT_NOT_READY");
    expect(calls).toEqual(["register", "heartbeat"]);
  });

  test("rejects accepted canary and does not create a certification", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const canary = binding();
    const calls: string[] = [];
    await expect(certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: canary,
      ...(await reservationReceiptOptions(release)),
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, calls, {
        observation: {
          schema: "evolution-eval-ledger-query.v1",
          state: "accepted",
          connector_job_id: canary.dispatch.connector_job_id,
          connector_idempotency_key: canary.dispatch.connector_idempotency_key,
          dispatch_request_hash: canary.dispatch_request_hash,
          ledger_epoch: "epoch-gate-1",
          execution_state: "queued",
          accepted_at: "2026-08-27T08:00:00.000Z",
        },
      }),
    })).rejects.toThrow("REMOTE_CANARY_NOT_PROVEN_NEVER_ACCEPTED");
    expect(calls).toEqual(["register", "heartbeat", "discover", "query"]);
  });

  test("B is bound to A, Gate DB, healthy epoch, and authorization", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const certification = await certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      ...(await reservationReceiptOptions(release)),
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, []),
    });
    const body = { ...certification } as Record<string, unknown>;
    delete body.certification_hash;

    expect(() => parseEvolutionEvalF0Certification({
      ...body,
      schema: "synthia-evolution-eval-f0-certification.v1",
      certification_hash: evolutionEvalCanonicalHash({
        ...body,
        schema: "synthia-evolution-eval-f0-certification.v1",
      }),
    }, release, TOOLCHAIN_ATTESTATION, TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("cannot authorize new effects");

    expect(() => parseEvolutionEvalF0Certification({
      ...body,
      toolchain_attestation: {
        ...(body.toolchain_attestation as Record<string, unknown>),
        raw_sha256: "f".repeat(64),
      },
      certification_hash: evolutionEvalCanonicalHash({
        ...body,
        toolchain_attestation: {
          ...(body.toolchain_attestation as Record<string, unknown>),
          raw_sha256: "f".repeat(64),
        },
      }),
    }, release, TOOLCHAIN_ATTESTATION, TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("different Vivado toolchain attestation");

    expect(() => parseEvolutionEvalF0Certification({
      ...body,
      worker_release_manifest_hash: "f".repeat(64),
      certification_hash: evolutionEvalCanonicalHash({
        ...body,
        worker_release_manifest_hash: "f".repeat(64),
      }),
    }, release, TOOLCHAIN_ATTESTATION, TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("different worker release");
    expect(() => parseEvolutionEvalF0Certification({
      ...body,
      remote_certification_authorized: false,
      certification_hash: evolutionEvalCanonicalHash({
        ...body,
        remote_certification_authorized: false,
      }),
    }, release, TOOLCHAIN_ATTESTATION, TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("not explicitly authorized");
    expect(() => parseEvolutionEvalF0Certification({
      ...body,
      ledger: { epoch: "epoch-gate-1", health: "degraded" },
      certification_hash: evolutionEvalCanonicalHash({
        ...body,
        ledger: { epoch: "epoch-gate-1", health: "degraded" },
      }),
    }, release, TOOLCHAIN_ATTESTATION, TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("not healthy");
  });

  test("dirty A requires a separate explicit B authorization", async () => {
    const dirtyValue = releaseValue();
    dirtyValue.source_state = "dirty";
    dirtyValue.git_status_sha256 = "f".repeat(64);
    const dirtyPreimage = { ...dirtyValue };
    delete dirtyPreimage.manifest_hash;
    const release = parseWorkerReleaseManifest({
      ...dirtyPreimage,
      manifest_hash: evolutionEvalCanonicalHash(dirtyPreimage),
    });
    const options = {
      gateId: "gate-1",
      activeConfigSha256: ACTIVE_CONFIG_SHA256,
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      canaryBinding: binding(),
      ...(await reservationReceiptOptions(release)),
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, []),
    };

    await expect(certifyEvolutionEvalRemote({
      ...options,
      dirtyReleaseAuthorized: false,
    })).rejects.toThrow("DIRTY_RELEASE_AUTHORIZATION_MISMATCH");
    const certification = await certifyEvolutionEvalRemote({
      ...options,
      dirtyReleaseAuthorized: true,
    });
    expect(certification.dirty_release_authorized).toBe(true);
    expect(certification.remote_certification_authorized).toBe(true);
  });

  test("startup consumption binds A+B to Gate DB, Gate ID, and Connector config", async () => {
    const release = parseWorkerReleaseManifest(releaseValue());
    const configText = JSON.stringify(connectorConfig(release));
    const certification = await certifyEvolutionEvalRemote({
      gateId: "gate-1",
      activeConfigSha256: sha256(configText),
      database: gateDatabaseIdentity("postgres://db/synthia-selfevo-gate-1"),
      endpointOrigin: "https://gate.example.test",
      connectorId: "vivado-gate-1",
      releaseManifest: release,
      ...TOOLCHAIN_OPTIONS,
      dirtyReleaseAuthorized: false,
      canaryBinding: binding(),
      ...(await reservationReceiptOptions(release, {
        activeConfigSha256: sha256(configText),
      })),
      verifyCoreIssuedCanary: async () => undefined,
      remote: remoteFixture(release, [], {
        activeConfigSha256: sha256(configText),
      }),
    });
    expect(() => assertConnectorConfigMatchesCertification({
      ...connectorConfig(release),
      sdk_worker_build_hash: "f".repeat(64),
    }, release, certification.endpoint.connector_id, certification.ledger.epoch,
    TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("differs from the certified");
    expect(() => assertConnectorConfigMatchesCertification({
      ...connectorConfig(release),
      evolution_eval_enabled: false,
    }, release, certification.endpoint.connector_id, certification.ledger.epoch,
    TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("differs from the certified");
    expect(() => assertConnectorConfigMatchesCertification({
      ...connectorConfig(release),
      evolution_eval_ledger_mode: "initialize",
    }, release, certification.endpoint.connector_id, certification.ledger.epoch,
    TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("differs from the certified");
    expect(() => assertConnectorConfigMatchesCertification({
      ...connectorConfig(release),
      evolution_eval_ledger_epoch: "wrong-epoch",
    }, release, certification.endpoint.connector_id, certification.ledger.epoch,
    TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("differs from the certified");
    expect(() => assertConnectorConfigMatchesCertification({
      ...connectorConfig(release),
      evolution_eval_log_root: "",
    }, release, certification.endpoint.connector_id, certification.ledger.epoch,
    TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("differs from the certified");
    expect(() => assertConnectorConfigMatchesCertification({
      ...connectorConfig(release),
      vivado_toolchain_attestation_sha256: "f".repeat(64),
    }, release, certification.endpoint.connector_id, certification.ledger.epoch,
    TOOLCHAIN_ATTESTATION_SHA256))
      .toThrow("differs from the certified");

    const directory = await mkdtemp(join(tmpdir(), "synthia-m4f-cert-test-"));
    try {
      const releasePath = join(directory, "release.json");
      const certificationPath = join(directory, "certification.json");
      const configPath = join(directory, "connector.json");
      const toolchainAttestationPath = join(directory, "toolchain-attestation.json");
      await Promise.all([
        writeFile(releasePath, JSON.stringify(release)),
        writeFile(certificationPath, JSON.stringify(certification)),
        writeFile(configPath, configText),
        writeFile(toolchainAttestationPath, TOOLCHAIN_ATTESTATION_TEXT),
      ]);
      const loadOptions = {
        releaseManifestPath: releasePath,
        certificationPath,
        expectedCertificationFileSha256: sha256(JSON.stringify(certification)),
        toolchainAttestationPath,
        expectedToolchainAttestationFileSha256: TOOLCHAIN_ATTESTATION_SHA256,
        connectorConfigPath: configPath,
        databaseUrl: "postgres://db/synthia-selfevo-gate-1",
        gateId: "gate-1",
      };
      await expect(loadEvolutionEvalNewEffectsCertification(loadOptions)).resolves.toMatchObject({
        certification: { certification_hash: certification.certification_hash },
        releaseManifest: { manifest_hash: release.manifest_hash },
      });
      await writeFile(toolchainAttestationPath, `${TOOLCHAIN_ATTESTATION_TEXT}\n`);
      await expect(loadEvolutionEvalNewEffectsCertification(loadOptions))
        .rejects.toThrow("raw file SHA-256 differs");
      await writeFile(toolchainAttestationPath, TOOLCHAIN_ATTESTATION_TEXT);
      await writeFile(configPath, `${configText}\n`);
      await expect(loadEvolutionEvalNewEffectsCertification({
        ...loadOptions,
      })).rejects.toThrow("config bytes differ from F0 certification");
      await writeFile(configPath, configText);
      await expect(loadEvolutionEvalNewEffectsCertification({
        ...loadOptions,
        databaseUrl: "postgres://db/synthia-selfevo-gate-other",
      })).rejects.toThrow("differs from DATABASE_URL");
      await expect(loadEvolutionEvalNewEffectsCertification({
        ...loadOptions,
        gateId: "gate-other",
      })).rejects.toThrow("differs from SYNTHIA_M4F_GATE_ID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
