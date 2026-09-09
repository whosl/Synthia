#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  evolutionEvalCanonicalHash,
  evolutionEvalCanonicalJson,
  requireNfcString,
} from "../src/domain/evolution-eval.ts";
import type { CoreIssuedEvalBinding } from "../src/services/evolution-eval-connector-port.ts";
import { validateEvolutionEvalLedgerObservation } from "../src/services/evolution-eval-dispatcher.ts";

const RELEASE_SCHEMA = "synthia-worker-release-manifest.v1" as const;
const CERTIFICATION_SCHEMA = "synthia-evolution-eval-f0-certification.v2" as const;
const TOOLCHAIN_ATTESTATION_SCHEMA = "synthia-vivado-toolchain-attestation.v1" as const;
const TOOLCHAIN_TREE_MANIFEST_SCHEMA = "synthia-vivado-full-tree-manifest.v1" as const;
const HASH = /^[0-9a-f]{64}$/;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATE_DATABASE_PREFIX = "synthia-selfevo-gate-";
const CERTIFICATION_VALIDITY_MS = 10 * 60 * 1000;
const MAX_CERTIFICATION_VALIDITY_MS = 15 * 60 * 1000;
const MAX_TOOLCHAIN_ATTESTATION_VALIDITY_MS = 4 * 60 * 60 * 1000;
const EXPECTED_VIVADO_VERSION = "2021.1" as const;
const EXPECTED_VIVADO_SW_BUILD = "3247384" as const;
const EXPECTED_VIVADO_IP_BUILD = "3246043" as const;
const EXPECTED_VIVADO_PART = "xc7k70tfbv676-1" as const;
const M4F_DIRECT_MTLS_ENDPOINT_ORIGIN = "https://100.96.223.49:18443" as const;
const M4F_DIRECT_MTLS_TRUST_REF = "cert://m4f-direct/trust" as const;
const M4F_DIRECT_MTLS_CLIENT_REF = "cert://m4f-direct/client" as const;
const EVAL_OPERATIONS = [
  "implement",
  "simulate",
  "synthesize",
  "validate_sources",
] as const;

export interface WorkerReleaseManifestV1 {
  readonly schema: typeof RELEASE_SCHEMA;
  readonly git_commit: string;
  readonly source_state: "clean" | "dirty";
  readonly git_status_sha256: string;
  readonly bundle: {
    readonly path: "server.bundle.mjs";
    readonly size_bytes: number;
    readonly sha256: string;
  };
  readonly runtime: {
    readonly kind: "bun";
    readonly version: "1.4.1";
    readonly executable_name: "bun.exe";
    readonly sha256: string;
  };
  readonly release_files: {
    readonly config_template_sha256: string;
    readonly launcher_sha256: string;
    readonly windows_certifier_sha256: string;
  };
  readonly sources: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly expected: {
    readonly sdk_worker_build_hash: string;
    readonly protocol_version: "connector.remote.v1";
    readonly capability_map_version: string;
    readonly part_catalog_hash: string;
    readonly toolchain_profile_hash: string;
    readonly vivado_version: string;
    readonly vivado_patch: string;
    readonly part: string;
    readonly capabilities: readonly CertifiedCapability[];
  };
  readonly manifest_hash: string;
}

export interface CertifiedCapability {
  readonly operation: string;
  readonly version: string;
  readonly run_classes: readonly string[];
}

export interface VivadoToolchainAttestationV1 {
  readonly schema: typeof TOOLCHAIN_ATTESTATION_SCHEMA;
  readonly gate_id: string;
  readonly issued_at: string;
  readonly not_before: string;
  readonly expires_at: string;
  readonly vhdx: {
    readonly path: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly file_identity: {
      readonly volume_serial_number: string;
      readonly file_id: string;
    };
    readonly backing_parent: {
      readonly path: string;
      readonly owner_sid: string;
      readonly acl_sha256: string;
      readonly protected: true;
    };
  };
  readonly attachment: {
    readonly image_path: string;
    readonly attached: true;
    readonly read_only: true;
    readonly disk: {
      readonly number: number;
      readonly unique_id: string;
    };
    readonly partition: {
      readonly number: number;
      readonly guid: string;
    };
    readonly volume: {
      readonly guid: string;
      readonly serial_number: string;
      readonly file_system: "NTFS";
      readonly mount_path: string;
      readonly identity_canonical_sha256: string;
    };
    readonly write_probe: "access_denied";
    readonly backing_file_identity: {
      readonly volume_serial_number: string;
      readonly file_id: string;
    };
  };
  readonly full_tree_manifest: {
    readonly schema: typeof TOOLCHAIN_TREE_MANIFEST_SCHEMA;
    readonly canonical_sha256: string;
    readonly entry_count: number;
    readonly file_count: number;
    readonly total_bytes: number;
  };
  readonly vivado: {
    readonly binary_relative_path: string;
    readonly version: typeof EXPECTED_VIVADO_VERSION;
    readonly sw_build: typeof EXPECTED_VIVADO_SW_BUILD;
    readonly ip_build: typeof EXPECTED_VIVADO_IP_BUILD;
    readonly version_probe_stdout_sha256: string;
    readonly part_catalog_sha256: string;
    readonly target_part: typeof EXPECTED_VIVADO_PART;
    readonly part_present: true;
    readonly part_probe_stdout_sha256: string;
    readonly license: {
      readonly status: "passed";
      readonly stdout_sha256: string;
      readonly exit_code: 0;
    };
    readonly minimal_synth: {
      readonly status: "passed";
      readonly input_sha256: string;
      readonly stdout_sha256: string;
      readonly exit_code: 0;
    };
  };
  readonly toolchain_profile: {
    readonly capability_map_version: string;
    readonly semantic_profile_sha256: string;
    readonly derived_sha256: string;
  };
  readonly canonical_attestation_sha256: string;
}

export interface EvolutionEvalF0CertificationV2 {
  readonly schema: typeof CERTIFICATION_SCHEMA;
  readonly gate_id: string;
  readonly certified_at: string;
  readonly expires_at: string;
  readonly reservation_receipt_hash: string;
  readonly worker_process_instance_id: string;
  readonly active_config_sha256: string;
  readonly database: GateDatabaseIdentity;
  readonly endpoint: {
    readonly origin: string;
    readonly hostname: string;
    readonly connector_id: string;
  };
  readonly worker_release_manifest_hash: string;
  readonly toolchain_attestation: {
    readonly schema: typeof TOOLCHAIN_ATTESTATION_SCHEMA;
    readonly raw_sha256: string;
    readonly canonical_attestation_sha256: string;
    readonly full_tree_manifest_hash: string;
    readonly toolchain_profile_hash: string;
  };
  readonly remote: {
    readonly sdk_worker_build_hash: string;
    readonly protocol_version: "connector.remote.v1";
    readonly capability_map_version: string;
    readonly part_catalog_hash: string;
    readonly toolchain_profile_hash: string;
    readonly vivado_version: string;
    readonly vivado_patch: string;
    readonly part: string;
    readonly license_status: "available";
    readonly live_mapping_health: "healthy";
    readonly capabilities: readonly CertifiedCapability[];
  };
  readonly ledger: {
    readonly epoch: string;
    readonly health: "healthy";
  };
  readonly canary: {
    readonly project_id: string;
    readonly eval_job_id: string;
    readonly connector_job_id: string;
    readonly dispatch_request_hash: string;
    readonly binding_hash: string;
    readonly state: "proven_never_accepted";
    readonly replay_permitted: true;
  };
  readonly dirty_release_authorized: boolean;
  readonly remote_certification_authorized: true;
  readonly certification_hash: string;
}

export interface EvolutionEvalCanaryReservationReceiptV1 {
  readonly schema: "synthia-evolution-eval-canary-reservation-receipt.v1";
  readonly gate_id: string;
  readonly database_identity_hash: string;
  readonly worker_release_manifest_hash: string;
  readonly active_config_sha256: string;
  readonly vivado_toolchain_attestation_sha256: string;
  readonly live_mapping_health: "healthy" | "unavailable";
  readonly pre_worker_process_instance_id: string;
  readonly binding_hash: string;
  readonly project_id: string;
  readonly eval_job_id: string;
  readonly connector_job_id: string;
  readonly dispatch_request_hash: string;
  readonly ledger_epoch: string;
  readonly reservation_observation_hash: string;
  readonly state: "proven_never_accepted";
  readonly replay_permitted: true;
  readonly reserved_at: string;
  readonly receipt_hash: string;
}

export interface GateDatabaseIdentity {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly identity_hash: string;
}

interface RemoteDiscoveryLike {
  readonly connector_id: string;
  readonly connector_protocol_version: string;
  readonly capability_map_version: string;
  readonly vivado_version: string;
  readonly vivado_patch: string;
  readonly part_catalog_hash: string;
  readonly sdk_worker_build_hash: string;
  readonly capabilities: readonly {
    readonly operation: string;
    readonly version: string;
    readonly runClasses: readonly string[];
  }[];
  readonly toolchain_profile_hash: string;
  readonly license_status: string;
  readonly active_config_sha256: string;
  readonly worker_process_instance_id: string;
  readonly vivado_toolchain_attestation_sha256: string;
  readonly live_mapping_health: "healthy" | "unavailable";
}

export interface CertificationRemoteClient {
  register(): Promise<{ readonly registration_state?: unknown }>;
  heartbeat(): Promise<{
    readonly registration_state?: unknown;
    readonly capability_drift?: unknown;
  }>;
  discover(): Promise<RemoteDiscoveryLike>;
  evolutionEvalQuery(binding: CoreIssuedEvalBinding): Promise<unknown>;
}

export interface CertificationReservationRemoteClient extends CertificationRemoteClient {
  evolutionEvalReserve(
    binding: CoreIssuedEvalBinding,
    attestation: {
      readonly active_config_sha256: string;
      readonly worker_process_instance_id: string;
      readonly vivado_toolchain_attestation_sha256: string;
    },
  ): Promise<unknown>;
}

interface CertificationRemoteFactories {
  createEnvironmentCloudflareRemoteConnector(
    options: Record<string, unknown>,
  ): CertificationReservationRemoteClient;
  createDirectMtlsRemoteConnector(
    options: Record<string, unknown>,
  ): CertificationReservationRemoteClient;
}

export interface M4fCertificationRemoteClientOptions {
  readonly endpointOrigin: string;
  readonly config: Record<string, unknown>;
  readonly projectId: string;
  readonly env: Record<string, string | undefined>;
  /** Test seam only; production always imports the reviewed Connector factories. */
  readonly factories?: CertificationRemoteFactories;
}

/**
 * Select the certification transport from the exact Gate origin.  The 18443
 * path deliberately reuses Core's hardened, file-descriptor-bound PEM loader;
 * the resulting Connector transport always sets rejectUnauthorized=true.
 */
export async function createM4fCertificationRemoteClient(
  options: M4fCertificationRemoteClientOptions,
): Promise<CertificationReservationRemoteClient> {
  const endpointUrl = exactHttpsOrigin(
    options.endpointOrigin,
    "M4-F certification endpoint",
  );
  const connectorHttpModulePath: string = "../../connector/http.ts";
  const factories = options.factories ?? await import(connectorHttpModulePath) as unknown as
    CertificationRemoteFactories;
  const common = {
    allowlist: [endpointUrl.hostname],
    actor: {
      actor_type: "service",
      actor_id: "synthia-core-evolution-eval-dispatcher",
    },
    classification: "internal",
    projectId: options.projectId,
  };
  if (options.endpointOrigin === M4F_DIRECT_MTLS_ENDPOINT_ORIGIN) {
    if (
      options.config.transport_mode !== "direct_https"
      || options.config.auth_mode !== "mtls"
      || options.config.tls_trust_ref !== M4F_DIRECT_MTLS_TRUST_REF
      || options.config.tls_client_cert_ref !== M4F_DIRECT_MTLS_CLIENT_REF
    ) {
      throw new Error("direct M4-F certification requires the reviewed mTLS Connector config");
    }
    const connectorAdapterModulePath: string = "../src/api/connector-adapter.ts";
    const { loadM4fDirectMtlsMaterial } = await import(connectorAdapterModulePath) as {
      loadM4fDirectMtlsMaterial(env: Record<string, string | undefined>): {
        readonly ca: string;
        readonly cert: string;
        readonly key: string;
      };
    };
    const material = loadM4fDirectMtlsMaterial(options.env);
    return factories.createDirectMtlsRemoteConnector({
      ...common,
      endpoint: { ...options.config, endpoint_url: options.endpointOrigin },
      ca: material.ca,
      cert: material.cert,
      key: material.key,
    });
  }
  if (options.env.SYNTHIA_M4F_DIRECT_MTLS_AUTHORIZATION !== undefined) {
    throw new Error("direct M4-F mTLS authorization cannot target a non-18443 endpoint");
  }
  return factories.createEnvironmentCloudflareRemoteConnector({
    ...common,
    endpoint: {
      ...options.config,
      endpoint_url: options.endpointOrigin,
      tls_trust_ref: "secret://trust/cloudflare-edge",
      tls_client_cert_ref: "secret://cert/cloudflare-origin",
    },
    env: options.env,
    secretNames: {
      clientId: "SYNTHIA_CF_ACCESS_CLIENT_ID",
      clientSecret: "SYNTHIA_CF_ACCESS_CLIENT_SECRET",
    },
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Reflect.ownKeys(value).length !== expected.length
    || Object.keys(value).sort().join("\u0000") !== [...expected].sort().join("\u0000")
  ) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function nonEmptyString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} is invalid`);
  }
  requireNfcString(value, label);
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function portableRelativePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label, 512);
  if (
    path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path)
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a portable relative path`);
  }
  return path;
}

function timestamp(value: unknown, label: string): string {
  const candidate = nonEmptyString(value, label, 64);
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== candidate) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return candidate;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function uuidV4(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new TypeError(`${label} must be a lowercase UUIDv4`);
  }
  return value;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseCapability(value: unknown, label: string): CertifiedCapability {
  const capability = record(value, label);
  exactKeys(capability, ["operation", "run_classes", "version"], label);
  const operation = nonEmptyString(capability.operation, `${label}.operation`, 128);
  const version = nonEmptyString(capability.version, `${label}.version`, 128);
  if (!OPAQUE_ID.test(operation) || !OPAQUE_ID.test(version)) {
    throw new TypeError(`${label} identity is invalid`);
  }
  if (!Array.isArray(capability.run_classes) || capability.run_classes.length === 0) {
    throw new TypeError(`${label}.run_classes must be non-empty`);
  }
  const runClasses = capability.run_classes.map((candidate, index) => {
    const runClass = nonEmptyString(candidate, `${label}.run_classes[${index}]`, 128);
    if (!OPAQUE_ID.test(runClass)) throw new TypeError(`${label}.run_classes is invalid`);
    return runClass;
  });
  assertStrictlySorted(runClasses, `${label}.run_classes`);
  return { operation, version, run_classes: Object.freeze(runClasses) };
}

function parseCapabilities(value: unknown, label: string): readonly CertifiedCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const capabilities = value.map((candidate, index) =>
    parseCapability(candidate, `${label}[${index}]`));
  assertStrictlySorted(capabilities.map((candidate) => candidate.operation), label);
  return Object.freeze(capabilities);
}

function assertStrictlySorted(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareBytes(values[index - 1]!, values[index]!) >= 0) {
      throw new TypeError(`${label} must be bytewise sorted without duplicates`);
    }
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return evolutionEvalCanonicalHash(left) === evolutionEvalCanonicalHash(right);
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("/", "\\").replace(/\\+$/u, "");
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

export function deriveVivadoToolchainProfileHash(
  attestation: Omit<VivadoToolchainAttestationV1, "canonical_attestation_sha256">,
): string {
  return evolutionEvalCanonicalHash({
    schema: "synthia-vivado-toolchain-profile-derivation.v1",
    capability_map_version: attestation.toolchain_profile.capability_map_version,
    semantic_profile_sha256: attestation.toolchain_profile.semantic_profile_sha256,
    full_tree_manifest_sha256: attestation.full_tree_manifest.canonical_sha256,
    volume_identity_canonical_sha256:
      attestation.attachment.volume.identity_canonical_sha256,
    binary_relative_path: attestation.vivado.binary_relative_path,
    version: attestation.vivado.version,
    sw_build: attestation.vivado.sw_build,
    ip_build: attestation.vivado.ip_build,
    part_catalog_sha256: attestation.vivado.part_catalog_sha256,
    target_part: attestation.vivado.target_part,
    part_probe_stdout_sha256: attestation.vivado.part_probe_stdout_sha256,
    license_probe_stdout_sha256: attestation.vivado.license.stdout_sha256,
    synth_input_sha256: attestation.vivado.minimal_synth.input_sha256,
    synth_stdout_sha256: attestation.vivado.minimal_synth.stdout_sha256,
  });
}

export function parseWorkerReleaseManifest(value: unknown): WorkerReleaseManifestV1 {
  const manifest = record(value, "worker release manifest");
  exactKeys(manifest, [
    "bundle",
    "expected",
    "git_commit",
    "git_status_sha256",
    "manifest_hash",
    "release_files",
    "runtime",
    "schema",
    "source_state",
    "sources",
  ], "worker release manifest");
  if (manifest.schema !== RELEASE_SCHEMA) throw new TypeError("worker release schema is invalid");
  if (typeof manifest.git_commit !== "string" || !COMMIT.test(manifest.git_commit)) {
    throw new TypeError("worker release git_commit is invalid");
  }
  if (manifest.source_state !== "clean" && manifest.source_state !== "dirty") {
    throw new TypeError("worker release source_state is invalid");
  }
  const sourceState = manifest.source_state as "clean" | "dirty";
  const gitStatusSha256 = hash(manifest.git_status_sha256, "worker release git_status_sha256");
  if (sourceState === "clean" && gitStatusSha256 !== EMPTY_SHA256) {
    throw new TypeError("clean worker release must bind the empty git status");
  }
  if (sourceState === "dirty" && gitStatusSha256 === EMPTY_SHA256) {
    throw new TypeError("dirty worker release cannot bind the empty git status");
  }

  const bundle = record(manifest.bundle, "worker release bundle");
  exactKeys(bundle, ["path", "sha256", "size_bytes"], "worker release bundle");
  if (bundle.path !== "server.bundle.mjs") throw new TypeError("worker release bundle path is invalid");
  const parsedBundle = {
    path: "server.bundle.mjs" as const,
    size_bytes: safeInteger(bundle.size_bytes, "worker release bundle.size_bytes", 1),
    sha256: hash(bundle.sha256, "worker release bundle.sha256"),
  };

  const runtime = record(manifest.runtime, "worker release runtime");
  exactKeys(runtime, ["executable_name", "kind", "sha256", "version"], "worker release runtime");
  if (
    runtime.kind !== "bun"
    || runtime.version !== "1.4.1"
    || runtime.executable_name !== "bun.exe"
  ) {
    throw new TypeError("worker release runtime identity is invalid");
  }
  const parsedRuntime = {
    kind: "bun" as const,
    version: "1.4.1" as const,
    executable_name: "bun.exe" as const,
    sha256: hash(runtime.sha256, "worker release runtime.sha256"),
  };

  const releaseFiles = record(manifest.release_files, "worker release files");
  exactKeys(releaseFiles, [
    "config_template_sha256",
    "launcher_sha256",
    "windows_certifier_sha256",
  ], "worker release files");
  const parsedReleaseFiles = {
    config_template_sha256: hash(
      releaseFiles.config_template_sha256,
      "worker release files.config_template_sha256",
    ),
    launcher_sha256: hash(releaseFiles.launcher_sha256, "worker release files.launcher_sha256"),
    windows_certifier_sha256: hash(
      releaseFiles.windows_certifier_sha256,
      "worker release files.windows_certifier_sha256",
    ),
  };

  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new TypeError("worker release sources must be a non-empty array");
  }
  const sources = manifest.sources.map((candidate, index) => {
    const source = record(candidate, `worker release sources[${index}]`);
    exactKeys(source, ["path", "sha256"], `worker release sources[${index}]`);
    const path = nonEmptyString(source.path, `worker release sources[${index}].path`, 512);
    if (
      path.startsWith("/")
      || path.includes("\\")
      || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || !/^[\x20-\x7e]+$/.test(path)
    ) {
      throw new TypeError(`worker release sources[${index}].path is not portable POSIX`);
    }
    return { path, sha256: hash(source.sha256, `worker release sources[${index}].sha256`) };
  });
  assertStrictlySorted(sources.map((source) => source.path), "worker release sources");

  const expected = record(manifest.expected, "worker release expected");
  exactKeys(expected, [
    "capabilities",
    "capability_map_version",
    "part",
    "part_catalog_hash",
    "protocol_version",
    "sdk_worker_build_hash",
    "toolchain_profile_hash",
    "vivado_patch",
    "vivado_version",
  ], "worker release expected");
  if (expected.protocol_version !== "connector.remote.v1") {
    throw new TypeError("worker release protocol_version is invalid");
  }
  const parsedExpected = {
    sdk_worker_build_hash: hash(
      expected.sdk_worker_build_hash,
      "worker release expected.sdk_worker_build_hash",
    ),
    protocol_version: "connector.remote.v1" as const,
    capability_map_version: nonEmptyString(
      expected.capability_map_version,
      "worker release expected.capability_map_version",
      128,
    ),
    part_catalog_hash: hash(expected.part_catalog_hash, "worker release expected.part_catalog_hash"),
    toolchain_profile_hash: hash(
      expected.toolchain_profile_hash,
      "worker release expected.toolchain_profile_hash",
    ),
    vivado_version: nonEmptyString(expected.vivado_version, "worker release expected.vivado_version", 64),
    vivado_patch: nonEmptyString(expected.vivado_patch, "worker release expected.vivado_patch", 64),
    part: nonEmptyString(expected.part, "worker release expected.part", 128),
    capabilities: parseCapabilities(expected.capabilities, "worker release expected.capabilities"),
  };
  if (parsedExpected.sdk_worker_build_hash !== parsedBundle.sha256) {
    throw new TypeError("worker release build identity differs from bundle SHA-256");
  }

  const parsed = {
    schema: RELEASE_SCHEMA,
    git_commit: manifest.git_commit,
    source_state: sourceState,
    git_status_sha256: gitStatusSha256,
    bundle: parsedBundle,
    runtime: parsedRuntime,
    release_files: parsedReleaseFiles,
    sources: Object.freeze(sources),
    expected: parsedExpected,
  };
  const manifestHash = hash(manifest.manifest_hash, "worker release manifest_hash");
  if (evolutionEvalCanonicalHash(parsed) !== manifestHash) {
    throw new TypeError("worker release manifest_hash is invalid");
  }
  return Object.freeze({ ...parsed, manifest_hash: manifestHash });
}

export function parseVivadoToolchainAttestation(
  value: unknown,
): VivadoToolchainAttestationV1 {
  const attestation = record(value, "Vivado toolchain attestation");
  exactKeys(attestation, [
    "attachment",
    "canonical_attestation_sha256",
    "expires_at",
    "full_tree_manifest",
    "gate_id",
    "issued_at",
    "not_before",
    "schema",
    "toolchain_profile",
    "vhdx",
    "vivado",
  ], "Vivado toolchain attestation");
  if (attestation.schema !== TOOLCHAIN_ATTESTATION_SCHEMA) {
    throw new TypeError("Vivado toolchain attestation schema is invalid");
  }
  const gateId = nonEmptyString(attestation.gate_id, "Vivado toolchain attestation gate_id", 64);
  if (!OPAQUE_ID.test(gateId)) {
    throw new TypeError("Vivado toolchain attestation gate_id is invalid");
  }
  const issuedAt = timestamp(attestation.issued_at, "Vivado toolchain attestation issued_at");
  const notBefore = timestamp(attestation.not_before, "Vivado toolchain attestation not_before");
  const expiresAt = timestamp(attestation.expires_at, "Vivado toolchain attestation expires_at");
  if (
    Date.parse(issuedAt) > Date.parse(notBefore)
    || Date.parse(expiresAt) <= Date.parse(notBefore)
    || Date.parse(expiresAt) - Date.parse(notBefore) > MAX_TOOLCHAIN_ATTESTATION_VALIDITY_MS
  ) {
    throw new TypeError("Vivado toolchain attestation validity window is invalid");
  }

  const vhdx = record(attestation.vhdx, "Vivado toolchain attestation vhdx");
  exactKeys(vhdx, [
    "backing_parent",
    "file_identity",
    "path",
    "sha256",
    "size_bytes",
  ], "Vivado toolchain attestation vhdx");
  const fileIdentity = record(
    vhdx.file_identity,
    "Vivado toolchain attestation vhdx.file_identity",
  );
  exactKeys(
    fileIdentity,
    ["file_id", "volume_serial_number"],
    "Vivado toolchain attestation vhdx.file_identity",
  );
  const parsedFileIdentity = {
    volume_serial_number: nonEmptyString(
      fileIdentity.volume_serial_number,
      "Vivado toolchain attestation vhdx.file_identity.volume_serial_number",
      128,
    ),
    file_id: nonEmptyString(
      fileIdentity.file_id,
      "Vivado toolchain attestation vhdx.file_identity.file_id",
      128,
    ),
  };
  const backingParent = record(
    vhdx.backing_parent,
    "Vivado toolchain attestation vhdx.backing_parent",
  );
  exactKeys(
    backingParent,
    ["acl_sha256", "owner_sid", "path", "protected"],
    "Vivado toolchain attestation vhdx.backing_parent",
  );
  if (backingParent.protected !== true) {
    throw new TypeError("Vivado toolchain attestation VHDX backing parent is not protected");
  }
  const parsedVhdx = {
    path: nonEmptyString(vhdx.path, "Vivado toolchain attestation vhdx.path", 512),
    sha256: hash(vhdx.sha256, "Vivado toolchain attestation vhdx.sha256"),
    size_bytes: safeInteger(vhdx.size_bytes, "Vivado toolchain attestation vhdx.size_bytes", 1),
    file_identity: parsedFileIdentity,
    backing_parent: {
      path: nonEmptyString(
        backingParent.path,
        "Vivado toolchain attestation vhdx.backing_parent.path",
        512,
      ),
      owner_sid: nonEmptyString(
        backingParent.owner_sid,
        "Vivado toolchain attestation vhdx.backing_parent.owner_sid",
        184,
      ),
      acl_sha256: hash(
        backingParent.acl_sha256,
        "Vivado toolchain attestation vhdx.backing_parent.acl_sha256",
      ),
      protected: true as const,
    },
  };

  const attachment = record(attestation.attachment, "Vivado toolchain attestation attachment");
  exactKeys(
    attachment,
    [
      "attached",
      "backing_file_identity",
      "disk",
      "image_path",
      "partition",
      "read_only",
      "volume",
      "write_probe",
    ],
    "Vivado toolchain attestation attachment",
  );
  if (
    attachment.attached !== true
    || attachment.read_only !== true
    || attachment.write_probe !== "access_denied"
  ) {
    throw new TypeError("Vivado toolchain attestation attachment is not read-only and attached");
  }
  const disk = record(attachment.disk, "Vivado toolchain attestation attachment.disk");
  exactKeys(
    disk,
    ["number", "unique_id"],
    "Vivado toolchain attestation attachment.disk",
  );
  const partition = record(
    attachment.partition,
    "Vivado toolchain attestation attachment.partition",
  );
  exactKeys(
    partition,
    ["guid", "number"],
    "Vivado toolchain attestation attachment.partition",
  );
  const volume = record(attachment.volume, "Vivado toolchain attestation attachment.volume");
  exactKeys(
    volume,
    ["file_system", "guid", "identity_canonical_sha256", "mount_path", "serial_number"],
    "Vivado toolchain attestation attachment.volume",
  );
  if (volume.file_system !== "NTFS") {
    throw new TypeError("Vivado toolchain attestation volume is not verified read-only NTFS");
  }
  const parsedVolumeIdentity = {
    guid: nonEmptyString(
      volume.guid,
      "Vivado toolchain attestation attachment.volume.guid",
      128,
    ),
    serial_number: nonEmptyString(
      volume.serial_number,
      "Vivado toolchain attestation attachment.volume.serial_number",
      128,
    ),
    file_system: "NTFS" as const,
    mount_path: nonEmptyString(
      volume.mount_path,
      "Vivado toolchain attestation attachment.volume.mount_path",
      512,
    ),
  };
  const volumeIdentityHash = hash(
    volume.identity_canonical_sha256,
    "Vivado toolchain attestation attachment.volume.identity_canonical_sha256",
  );
  if (evolutionEvalCanonicalHash(parsedVolumeIdentity) !== volumeIdentityHash) {
    throw new TypeError("Vivado toolchain attestation volume identity hash is invalid");
  }
  const backingFileIdentity = record(
    attachment.backing_file_identity,
    "Vivado toolchain attestation attachment.backing_file_identity",
  );
  exactKeys(
    backingFileIdentity,
    ["file_id", "volume_serial_number"],
    "Vivado toolchain attestation attachment.backing_file_identity",
  );
  const parsedBackingFileIdentity = {
    volume_serial_number: nonEmptyString(
      backingFileIdentity.volume_serial_number,
      "Vivado toolchain attestation attachment.backing_file_identity.volume_serial_number",
      128,
    ),
    file_id: nonEmptyString(
      backingFileIdentity.file_id,
      "Vivado toolchain attestation attachment.backing_file_identity.file_id",
      128,
    ),
  };
  const imagePath = nonEmptyString(
    attachment.image_path,
    "Vivado toolchain attestation attachment.image_path",
    512,
  );
  if (
    !sameWindowsPath(imagePath, parsedVhdx.path)
    || !sameCanonical(parsedBackingFileIdentity, parsedFileIdentity)
  ) {
    throw new TypeError("Vivado toolchain attestation attachment differs from backing VHDX");
  }
  const parsedAttachment = {
    image_path: imagePath,
    attached: true as const,
    read_only: true as const,
    disk: {
      number: safeInteger(disk.number, "Vivado toolchain attestation attachment.disk.number"),
      unique_id: nonEmptyString(
        disk.unique_id,
        "Vivado toolchain attestation attachment.disk.unique_id",
        256,
      ),
    },
    partition: {
      number: safeInteger(
        partition.number,
        "Vivado toolchain attestation attachment.partition.number",
        1,
      ),
      guid: nonEmptyString(
        partition.guid,
        "Vivado toolchain attestation attachment.partition.guid",
        128,
      ),
    },
    volume: { ...parsedVolumeIdentity, identity_canonical_sha256: volumeIdentityHash },
    write_probe: "access_denied" as const,
    backing_file_identity: parsedBackingFileIdentity,
  };

  const tree = record(
    attestation.full_tree_manifest,
    "Vivado toolchain attestation full_tree_manifest",
  );
  exactKeys(
    tree,
    [
      "canonical_sha256",
      "entry_count",
      "file_count",
      "schema",
      "total_bytes",
    ],
    "Vivado toolchain attestation full_tree_manifest",
  );
  if (tree.schema !== TOOLCHAIN_TREE_MANIFEST_SCHEMA) {
    throw new TypeError("Vivado toolchain full-tree manifest schema is invalid");
  }
  const entryCount = safeInteger(
    tree.entry_count,
    "Vivado toolchain attestation full_tree_manifest.entry_count",
    1,
  );
  const fileCount = safeInteger(
    tree.file_count,
    "Vivado toolchain attestation full_tree_manifest.file_count",
    1,
  );
  if (entryCount < fileCount) {
    throw new TypeError("Vivado toolchain full-tree manifest entry count is inconsistent");
  }
  const parsedTree = {
    schema: TOOLCHAIN_TREE_MANIFEST_SCHEMA,
    canonical_sha256: hash(
      tree.canonical_sha256,
      "Vivado toolchain attestation full_tree_manifest.canonical_sha256",
    ),
    entry_count: entryCount,
    file_count: fileCount,
    total_bytes: safeInteger(
      tree.total_bytes,
      "Vivado toolchain attestation full_tree_manifest.total_bytes",
      1,
    ),
  };

  const vivado = record(attestation.vivado, "Vivado toolchain attestation vivado");
  exactKeys(vivado, [
    "binary_relative_path",
    "ip_build",
    "license",
    "minimal_synth",
    "part_catalog_sha256",
    "part_present",
    "part_probe_stdout_sha256",
    "sw_build",
    "target_part",
    "version",
    "version_probe_stdout_sha256",
  ], "Vivado toolchain attestation vivado");
  const license = record(vivado.license, "Vivado toolchain attestation vivado.license");
  exactKeys(
    license,
    ["exit_code", "status", "stdout_sha256"],
    "Vivado toolchain attestation vivado.license",
  );
  if (license.status !== "passed" || license.exit_code !== 0) {
    throw new TypeError("Vivado toolchain attestation license probe is invalid");
  }
  const minimalSynth = record(
    vivado.minimal_synth,
    "Vivado toolchain attestation vivado.minimal_synth",
  );
  exactKeys(
    minimalSynth,
    ["exit_code", "input_sha256", "status", "stdout_sha256"],
    "Vivado toolchain attestation vivado.minimal_synth",
  );
  if (minimalSynth.status !== "passed" || minimalSynth.exit_code !== 0) {
    throw new TypeError("Vivado toolchain attestation minimal synthesis probe is invalid");
  }
  const binaryRelativePath = portableRelativePath(
    vivado.binary_relative_path,
    "Vivado toolchain attestation vivado.binary_relative_path",
  );
  const version = nonEmptyString(
    vivado.version,
    "Vivado toolchain attestation vivado.version",
    64,
  );
  const swBuild = nonEmptyString(
    vivado.sw_build,
    "Vivado toolchain attestation vivado.sw_build",
    64,
  );
  const ipBuild = nonEmptyString(
    vivado.ip_build,
    "Vivado toolchain attestation vivado.ip_build",
    64,
  );
  const targetPart = nonEmptyString(
    vivado.target_part,
    "Vivado toolchain attestation vivado.target_part",
    128,
  );
  if (
    version !== EXPECTED_VIVADO_VERSION
    || swBuild !== EXPECTED_VIVADO_SW_BUILD
    || ipBuild !== EXPECTED_VIVADO_IP_BUILD
    || targetPart !== EXPECTED_VIVADO_PART
  ) {
    throw new TypeError("Vivado toolchain attestation fixed Vivado facts are invalid");
  }
  const parsedVivado = {
    binary_relative_path: binaryRelativePath,
    version: EXPECTED_VIVADO_VERSION,
    sw_build: EXPECTED_VIVADO_SW_BUILD,
    ip_build: EXPECTED_VIVADO_IP_BUILD,
    version_probe_stdout_sha256: hash(
      vivado.version_probe_stdout_sha256,
      "Vivado toolchain attestation vivado.version_probe_stdout_sha256",
    ),
    part_catalog_sha256: hash(
      vivado.part_catalog_sha256,
      "Vivado toolchain attestation vivado.part_catalog_sha256",
    ),
    target_part: EXPECTED_VIVADO_PART,
    part_present: vivado.part_present === true
      ? true as const
      : (() => { throw new TypeError("Vivado toolchain target part is not present"); })(),
    part_probe_stdout_sha256: hash(
      vivado.part_probe_stdout_sha256,
      "Vivado toolchain attestation vivado.part_probe_stdout_sha256",
    ),
    license: {
      status: "passed" as const,
      stdout_sha256: hash(
        license.stdout_sha256,
        "Vivado toolchain attestation vivado.license.stdout_sha256",
      ),
      exit_code: 0 as const,
    },
    minimal_synth: {
      status: "passed" as const,
      input_sha256: hash(
        minimalSynth.input_sha256,
        "Vivado toolchain attestation vivado.minimal_synth.input_sha256",
      ),
      stdout_sha256: hash(
        minimalSynth.stdout_sha256,
        "Vivado toolchain attestation vivado.minimal_synth.stdout_sha256",
      ),
      exit_code: 0 as const,
    },
  };
  const profile = record(attestation.toolchain_profile, "Vivado toolchain attestation toolchain_profile");
  exactKeys(
    profile,
    ["capability_map_version", "derived_sha256", "semantic_profile_sha256"],
    "Vivado toolchain attestation toolchain_profile",
  );
  const parsedProfile = {
    capability_map_version: nonEmptyString(
      profile.capability_map_version,
      "Vivado toolchain attestation toolchain_profile.capability_map_version",
      128,
    ),
    semantic_profile_sha256: hash(
      profile.semantic_profile_sha256,
      "Vivado toolchain attestation toolchain_profile.semantic_profile_sha256",
    ),
    derived_sha256: hash(
      profile.derived_sha256,
      "Vivado toolchain attestation toolchain_profile.derived_sha256",
    ),
  };
  const body = {
    schema: TOOLCHAIN_ATTESTATION_SCHEMA,
    gate_id: gateId,
    issued_at: issuedAt,
    not_before: notBefore,
    expires_at: expiresAt,
    vhdx: parsedVhdx,
    attachment: parsedAttachment,
    full_tree_manifest: parsedTree,
    vivado: parsedVivado,
    toolchain_profile: parsedProfile,
  };
  if (
    deriveVivadoToolchainProfileHash(body)
    !== parsedProfile.derived_sha256
  ) {
    throw new TypeError("Vivado toolchain derived profile hash is invalid");
  }
  const canonicalAttestationSha256 = hash(
    attestation.canonical_attestation_sha256,
    "Vivado toolchain attestation canonical_attestation_sha256",
  );
  if (evolutionEvalCanonicalHash(body) !== canonicalAttestationSha256) {
    throw new TypeError("Vivado toolchain canonical_attestation_sha256 is invalid");
  }
  return Object.freeze({
    ...body,
    canonical_attestation_sha256: canonicalAttestationSha256,
  });
}

export function assertVivadoToolchainAttestationFresh(
  attestation: Pick<VivadoToolchainAttestationV1, "issued_at" | "not_before" | "expires_at">,
  now = new Date(),
): void {
  const issuedAt = Date.parse(timestamp(attestation.issued_at, "toolchain issued_at"));
  const notBefore = Date.parse(timestamp(attestation.not_before, "toolchain not_before"));
  const expiresAt = Date.parse(timestamp(attestation.expires_at, "toolchain expires_at"));
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs)
    || issuedAt > notBefore
    || issuedAt > nowMs + 30_000
    || nowMs < notBefore
    || expiresAt <= notBefore
    || expiresAt - notBefore > MAX_TOOLCHAIN_ATTESTATION_VALIDITY_MS
    || nowMs >= expiresAt
  ) {
    throw new Error("Vivado toolchain attestation is not fresh");
  }
}

export function gateDatabaseIdentity(databaseUrl: string): GateDatabaseIdentity {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new TypeError("DATABASE_URL is malformed");
  }
  if (!(["postgres:", "postgresql:"] as const).includes(url.protocol as never)) {
    throw new TypeError("DATABASE_URL must use postgres or postgresql");
  }
  const host = nonEmptyString(url.hostname, "DATABASE_URL hostname", 253).toLowerCase();
  const port = url.port === "" ? 5432 : safeInteger(Number(url.port), "DATABASE_URL port", 1);
  if (port > 65_535) throw new TypeError("DATABASE_URL port is invalid");
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name.startsWith(GATE_DATABASE_PREFIX) || !OPAQUE_ID.test(name)) {
    throw new TypeError(`database name must start with ${GATE_DATABASE_PREFIX}`);
  }
  const identity = { host, port, name };
  return Object.freeze({
    ...identity,
    identity_hash: evolutionEvalCanonicalHash(identity),
  });
}

export function exactHttpsOrigin(value: string, label = "endpoint"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} is malformed`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value
  ) {
    throw new TypeError(`${label} must be an exact plain HTTPS origin`);
  }
  return url;
}

export function resolveM4fGateEndpoint(options: {
  readonly dispatcherHostEnabled: boolean;
  readonly endpoint: string | undefined;
  readonly allowedOrigin: string | undefined;
  readonly certifiedOrigin?: string;
}): string | undefined {
  if (
    !options.dispatcherHostEnabled
    && !options.endpoint
    && !options.allowedOrigin
    && !options.certifiedOrigin
  ) {
    return undefined;
  }
  const endpoint = options.endpoint;
  const allowedOrigin = options.allowedOrigin;
  if (!endpoint) throw new Error("SYNTHIA_M4F_ENDPOINT_URL is required when dispatcher host is enabled");
  if (!allowedOrigin) {
    throw new Error("SYNTHIA_M4F_ENDPOINT_ALLOWED_ORIGIN is required when dispatcher host is enabled");
  }
  exactHttpsOrigin(endpoint, "SYNTHIA_M4F_ENDPOINT_URL");
  exactHttpsOrigin(allowedOrigin, "SYNTHIA_M4F_ENDPOINT_ALLOWED_ORIGIN");
  if (endpoint !== allowedOrigin) {
    throw new Error("SYNTHIA_M4F_ENDPOINT_URL differs from its exact allowlist");
  }
  if (options.certifiedOrigin !== undefined && endpoint !== options.certifiedOrigin) {
    throw new Error("SYNTHIA_M4F_ENDPOINT_URL differs from F0 certification");
  }
  return endpoint;
}

function parseDatabaseIdentity(value: unknown): GateDatabaseIdentity {
  const identity = record(value, "certification database");
  exactKeys(identity, ["host", "identity_hash", "name", "port"], "certification database");
  const host = nonEmptyString(identity.host, "certification database.host", 253).toLowerCase();
  const port = safeInteger(identity.port, "certification database.port", 1);
  if (port > 65_535) throw new TypeError("certification database.port is invalid");
  const name = nonEmptyString(identity.name, "certification database.name", 128);
  if (!name.startsWith(GATE_DATABASE_PREFIX) || !OPAQUE_ID.test(name)) {
    throw new TypeError("certification database.name is not a Gate database");
  }
  const identityHash = hash(identity.identity_hash, "certification database.identity_hash");
  if (evolutionEvalCanonicalHash({ host, port, name }) !== identityHash) {
    throw new TypeError("certification database.identity_hash is invalid");
  }
  return { host, port, name, identity_hash: identityHash };
}

export function parseEvolutionEvalCanaryReservationReceipt(
  value: unknown,
): EvolutionEvalCanaryReservationReceiptV1 {
  const receipt = record(value, "canary reservation receipt");
  exactKeys(receipt, [
    "active_config_sha256",
    "binding_hash",
    "connector_job_id",
    "database_identity_hash",
    "dispatch_request_hash",
    "eval_job_id",
    "gate_id",
    "ledger_epoch",
    "live_mapping_health",
    "pre_worker_process_instance_id",
    "project_id",
    "receipt_hash",
    "replay_permitted",
    "reservation_observation_hash",
    "reserved_at",
    "schema",
    "state",
    "vivado_toolchain_attestation_sha256",
    "worker_release_manifest_hash",
  ], "canary reservation receipt");
  if (
    receipt.schema !== "synthia-evolution-eval-canary-reservation-receipt.v1"
    || receipt.state !== "proven_never_accepted"
    || receipt.replay_permitted !== true
    || (receipt.live_mapping_health !== "healthy" && receipt.live_mapping_health !== "unavailable")
  ) {
    throw new TypeError("canary reservation receipt state is invalid");
  }
  const body = {
    schema: "synthia-evolution-eval-canary-reservation-receipt.v1" as const,
    gate_id: nonEmptyString(receipt.gate_id, "reservation gate_id", 128),
    database_identity_hash: hash(receipt.database_identity_hash, "reservation database_identity_hash"),
    worker_release_manifest_hash: hash(
      receipt.worker_release_manifest_hash,
      "reservation worker_release_manifest_hash",
    ),
    active_config_sha256: hash(receipt.active_config_sha256, "reservation active_config_sha256"),
    vivado_toolchain_attestation_sha256: hash(
      receipt.vivado_toolchain_attestation_sha256,
      "reservation Vivado toolchain attestation SHA-256",
    ),
    live_mapping_health: receipt.live_mapping_health as "healthy" | "unavailable",
    pre_worker_process_instance_id: uuidV4(
      receipt.pre_worker_process_instance_id,
      "reservation pre_worker_process_instance_id",
    ),
    binding_hash: hash(receipt.binding_hash, "reservation binding_hash"),
    project_id: nonEmptyString(receipt.project_id, "reservation project_id", 128),
    eval_job_id: nonEmptyString(receipt.eval_job_id, "reservation eval_job_id", 128),
    connector_job_id: nonEmptyString(receipt.connector_job_id, "reservation connector_job_id", 128),
    dispatch_request_hash: hash(receipt.dispatch_request_hash, "reservation dispatch_request_hash"),
    ledger_epoch: nonEmptyString(receipt.ledger_epoch, "reservation ledger_epoch", 128),
    reservation_observation_hash: hash(
      receipt.reservation_observation_hash,
      "reservation observation hash",
    ),
    state: "proven_never_accepted" as const,
    replay_permitted: true as const,
    reserved_at: timestamp(receipt.reserved_at, "reservation reserved_at"),
  };
  const receiptHash = hash(receipt.receipt_hash, "reservation receipt_hash");
  if (evolutionEvalCanonicalHash(body) !== receiptHash) {
    throw new TypeError("canary reservation receipt_hash is invalid");
  }
  return Object.freeze({ ...body, receipt_hash: receiptHash });
}

export function assertEvolutionEvalCertificationFresh(
  certification: Pick<EvolutionEvalF0CertificationV2, "certified_at" | "expires_at">,
  now = new Date(),
): void {
  const certifiedAt = Date.parse(timestamp(certification.certified_at, "certification certified_at"));
  const expiresAt = Date.parse(timestamp(certification.expires_at, "certification expires_at"));
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs)
    || certifiedAt > nowMs + 30_000
    || expiresAt <= certifiedAt
    || expiresAt - certifiedAt > MAX_CERTIFICATION_VALIDITY_MS
    || nowMs >= expiresAt
  ) {
    throw new Error("F0 certification is not fresh");
  }
}

export function parseEvolutionEvalF0Certification(
  value: unknown,
  releaseManifest: WorkerReleaseManifestV1,
  toolchainAttestation: VivadoToolchainAttestationV1,
  toolchainAttestationRawSha256: string,
): EvolutionEvalF0CertificationV2 {
  const certification = record(value, "F0 certification");
  exactKeys(certification, [
    "canary",
    "active_config_sha256",
    "certified_at",
    "certification_hash",
    "database",
    "dirty_release_authorized",
    "endpoint",
    "expires_at",
    "gate_id",
    "ledger",
    "remote",
    "remote_certification_authorized",
    "reservation_receipt_hash",
    "schema",
    "toolchain_attestation",
    "worker_release_manifest_hash",
    "worker_process_instance_id",
  ], "F0 certification");
  if (certification.schema !== CERTIFICATION_SCHEMA) {
    throw new TypeError("F0 certification schema is invalid or cannot authorize new effects");
  }
  const gateId = nonEmptyString(certification.gate_id, "F0 certification gate_id", 128);
  if (!OPAQUE_ID.test(gateId)) throw new TypeError("F0 certification gate_id is invalid");
  const activeConfigSha256 = hash(
    certification.active_config_sha256,
    "F0 certification active_config_sha256",
  );
  const certifiedAt = timestamp(certification.certified_at, "F0 certification certified_at");
  const expiresAt = timestamp(certification.expires_at, "F0 certification expires_at");
  if (
    Date.parse(expiresAt) <= Date.parse(certifiedAt)
    || Date.parse(expiresAt) - Date.parse(certifiedAt) > MAX_CERTIFICATION_VALIDITY_MS
  ) {
    throw new TypeError("F0 certification validity window is invalid");
  }
  if (
    Date.parse(certifiedAt) < Date.parse(toolchainAttestation.not_before)
    || Date.parse(expiresAt) > Date.parse(toolchainAttestation.expires_at)
  ) {
    throw new TypeError("F0 certification is outside the Vivado toolchain attestation window");
  }
  const reservationReceiptHash = hash(
    certification.reservation_receipt_hash,
    "F0 certification reservation_receipt_hash",
  );
  const workerProcessInstanceId = uuidV4(
    certification.worker_process_instance_id,
    "F0 certification worker_process_instance_id",
  );
  const database = parseDatabaseIdentity(certification.database);

  const endpoint = record(certification.endpoint, "F0 certification endpoint");
  exactKeys(endpoint, ["connector_id", "hostname", "origin"], "F0 certification endpoint");
  const origin = nonEmptyString(endpoint.origin, "F0 certification endpoint.origin", 2048);
  const endpointUrl = exactHttpsOrigin(origin, "F0 certification endpoint.origin");
  const hostname = nonEmptyString(endpoint.hostname, "F0 certification endpoint.hostname", 253)
    .toLowerCase();
  if (hostname !== endpointUrl.hostname.toLowerCase()) {
    throw new TypeError("F0 certification endpoint hostname differs from origin");
  }
  const connectorId = nonEmptyString(endpoint.connector_id, "F0 certification endpoint.connector_id", 128);
  if (!OPAQUE_ID.test(connectorId)) throw new TypeError("F0 certification connector_id is invalid");

  const releaseHash = hash(
    certification.worker_release_manifest_hash,
    "F0 certification worker_release_manifest_hash",
  );
  if (releaseHash !== releaseManifest.manifest_hash) {
    throw new TypeError("F0 certification references a different worker release manifest");
  }

  const toolchain = record(certification.toolchain_attestation, "F0 certification toolchain_attestation");
  exactKeys(toolchain, [
    "canonical_attestation_sha256",
    "full_tree_manifest_hash",
    "raw_sha256",
    "schema",
    "toolchain_profile_hash",
  ], "F0 certification toolchain_attestation");
  if (toolchain.schema !== TOOLCHAIN_ATTESTATION_SCHEMA) {
    throw new TypeError("F0 certification toolchain attestation schema is invalid");
  }
  const parsedToolchain = {
    schema: TOOLCHAIN_ATTESTATION_SCHEMA,
    raw_sha256: hash(toolchain.raw_sha256, "F0 certification toolchain attestation raw_sha256"),
    canonical_attestation_sha256: hash(
      toolchain.canonical_attestation_sha256,
      "F0 certification toolchain attestation canonical_attestation_sha256",
    ),
    full_tree_manifest_hash: hash(
      toolchain.full_tree_manifest_hash,
      "F0 certification toolchain attestation full_tree_manifest_hash",
    ),
    toolchain_profile_hash: hash(
      toolchain.toolchain_profile_hash,
      "F0 certification toolchain attestation toolchain_profile_hash",
    ),
  };
  if (
    parsedToolchain.raw_sha256
      !== hash(toolchainAttestationRawSha256, "Vivado toolchain attestation raw SHA-256")
    || parsedToolchain.canonical_attestation_sha256
      !== toolchainAttestation.canonical_attestation_sha256
    || parsedToolchain.full_tree_manifest_hash
      !== toolchainAttestation.full_tree_manifest.canonical_sha256
    || parsedToolchain.toolchain_profile_hash
      !== toolchainAttestation.toolchain_profile.derived_sha256
    || toolchainAttestation.gate_id !== gateId
  ) {
    throw new TypeError("F0 certification references a different Vivado toolchain attestation");
  }

  const remote = record(certification.remote, "F0 certification remote");
  exactKeys(remote, [
    "capabilities",
    "capability_map_version",
    "license_status",
    "live_mapping_health",
    "part",
    "part_catalog_hash",
    "protocol_version",
    "sdk_worker_build_hash",
    "toolchain_profile_hash",
    "vivado_patch",
    "vivado_version",
  ], "F0 certification remote");
  if (
    remote.protocol_version !== "connector.remote.v1"
    || remote.license_status !== "available"
    || remote.live_mapping_health !== "healthy"
  ) {
    throw new TypeError("F0 certification remote protocol or license is invalid");
  }
  const parsedRemote = {
    sdk_worker_build_hash: hash(remote.sdk_worker_build_hash, "F0 certification remote.sdk_worker_build_hash"),
    protocol_version: "connector.remote.v1" as const,
    capability_map_version: nonEmptyString(
      remote.capability_map_version,
      "F0 certification remote.capability_map_version",
      128,
    ),
    part_catalog_hash: hash(remote.part_catalog_hash, "F0 certification remote.part_catalog_hash"),
    toolchain_profile_hash: hash(
      remote.toolchain_profile_hash,
      "F0 certification remote.toolchain_profile_hash",
    ),
    vivado_version: nonEmptyString(remote.vivado_version, "F0 certification remote.vivado_version", 64),
    vivado_patch: nonEmptyString(remote.vivado_patch, "F0 certification remote.vivado_patch", 64),
    part: nonEmptyString(remote.part, "F0 certification remote.part", 128),
    license_status: "available" as const,
    live_mapping_health: "healthy" as const,
    capabilities: parseCapabilities(remote.capabilities, "F0 certification remote.capabilities"),
  };
  const expectedRemote = {
    ...releaseManifest.expected,
    license_status: "available" as const,
    live_mapping_health: "healthy" as const,
  };
  if (!sameCanonical(parsedRemote, expectedRemote)) {
    throw new TypeError("F0 certification remote identity differs from worker release expectations");
  }
  if (
    parsedRemote.toolchain_profile_hash !== toolchainAttestation.toolchain_profile.derived_sha256
    || parsedRemote.vivado_version !== toolchainAttestation.vivado.version
    || parsedRemote.vivado_patch !== toolchainAttestation.vivado.sw_build
    || parsedRemote.part !== toolchainAttestation.vivado.target_part
    || parsedRemote.license_status !== "available"
  ) {
    throw new TypeError("F0 certification remote identity differs from Vivado toolchain attestation");
  }
  assertFourEvolutionEvalCapabilities(parsedRemote.capabilities);

  const ledger = record(certification.ledger, "F0 certification ledger");
  exactKeys(ledger, ["epoch", "health"], "F0 certification ledger");
  const epoch = nonEmptyString(ledger.epoch, "F0 certification ledger.epoch", 128);
  if (ledger.health !== "healthy") throw new TypeError("F0 certification ledger is not healthy");

  const canary = record(certification.canary, "F0 certification canary");
  exactKeys(canary, [
    "binding_hash",
    "connector_job_id",
    "dispatch_request_hash",
    "eval_job_id",
    "project_id",
    "replay_permitted",
    "state",
  ], "F0 certification canary");
  if (canary.state !== "proven_never_accepted" || canary.replay_permitted !== true) {
    throw new TypeError("F0 certification canary is not proven never accepted");
  }
  const parsedCanary = {
    project_id: nonEmptyString(canary.project_id, "F0 certification canary.project_id", 128),
    eval_job_id: nonEmptyString(canary.eval_job_id, "F0 certification canary.eval_job_id", 128),
    connector_job_id: nonEmptyString(
      canary.connector_job_id,
      "F0 certification canary.connector_job_id",
      128,
    ),
    dispatch_request_hash: hash(
      canary.dispatch_request_hash,
      "F0 certification canary.dispatch_request_hash",
    ),
    binding_hash: hash(canary.binding_hash, "F0 certification canary.binding_hash"),
    state: "proven_never_accepted" as const,
    replay_permitted: true as const,
  };
  if (certification.remote_certification_authorized !== true) {
    throw new TypeError("F0 certification is not explicitly authorized");
  }
  if (typeof certification.dirty_release_authorized !== "boolean") {
    throw new TypeError("F0 certification dirty_release_authorized must be a boolean");
  }
  if (
    (releaseManifest.source_state === "clean" && certification.dirty_release_authorized)
    || (releaseManifest.source_state === "dirty" && !certification.dirty_release_authorized)
  ) {
    throw new TypeError("F0 certification dirty release authorization differs from A provenance");
  }

  const body = {
    schema: CERTIFICATION_SCHEMA,
    gate_id: gateId,
    certified_at: certifiedAt,
    expires_at: expiresAt,
    reservation_receipt_hash: reservationReceiptHash,
    worker_process_instance_id: workerProcessInstanceId,
    active_config_sha256: activeConfigSha256,
    database,
    endpoint: { origin, hostname, connector_id: connectorId },
    worker_release_manifest_hash: releaseHash,
    toolchain_attestation: parsedToolchain,
    remote: parsedRemote,
    ledger: { epoch, health: "healthy" as const },
    canary: parsedCanary,
    dirty_release_authorized: certification.dirty_release_authorized,
    remote_certification_authorized: true as const,
  };
  const certificationHash = hash(certification.certification_hash, "F0 certification_hash");
  if (evolutionEvalCanonicalHash(body) !== certificationHash) {
    throw new TypeError("F0 certification_hash is invalid");
  }
  return Object.freeze({ ...body, certification_hash: certificationHash });
}

function assertFourEvolutionEvalCapabilities(capabilities: readonly CertifiedCapability[]): void {
  const actual = capabilities
    .filter((capability) => capability.run_classes.includes("evolution_eval"))
    .map((capability) => capability.operation)
    .sort(compareBytes);
  if (!sameCanonical(actual, EVAL_OPERATIONS)) {
    throw new TypeError("remote evolution_eval capability allowlist must contain exactly four operations");
  }
}

function assertToolchainAttestationForGate(options: {
  readonly attestation: VivadoToolchainAttestationV1;
  readonly rawSha256: string;
  readonly gateId: string;
  readonly releaseManifest: WorkerReleaseManifestV1;
  readonly now: Date;
}): string {
  const rawSha256 = hash(options.rawSha256, "Vivado toolchain attestation raw SHA-256");
  assertVivadoToolchainAttestationFresh(options.attestation, options.now);
  const expected = options.releaseManifest.expected;
  if (
    options.attestation.gate_id !== options.gateId
    || options.attestation.toolchain_profile.derived_sha256 !== expected.toolchain_profile_hash
    || options.attestation.toolchain_profile.capability_map_version
      !== expected.capability_map_version
    || options.attestation.vivado.version !== expected.vivado_version
    || options.attestation.vivado.sw_build !== expected.vivado_patch
    || options.attestation.vivado.part_catalog_sha256 !== expected.part_catalog_hash
    || options.attestation.vivado.target_part !== expected.part
    || options.attestation.vivado.part_present !== true
    || options.attestation.vivado.license.status !== "passed"
    || options.attestation.vivado.license.exit_code !== 0
    || options.attestation.vivado.minimal_synth.status !== "passed"
    || options.attestation.vivado.minimal_synth.exit_code !== 0
  ) {
    throw new Error("VIVADO_TOOLCHAIN_ATTESTATION_RELEASE_MISMATCH");
  }
  return rawSha256;
}

function normalizeDiscoveryCapabilities(
  capabilities: RemoteDiscoveryLike["capabilities"],
): readonly CertifiedCapability[] {
  if (!Array.isArray(capabilities)) throw new TypeError("remote discovery capabilities are invalid");
  const normalized = capabilities.map((candidate) => ({
    operation: candidate.operation,
    version: candidate.version,
    run_classes: Object.freeze([...candidate.runClasses].sort(compareBytes)),
  })).sort((left, right) => compareBytes(left.operation, right.operation));
  return Object.freeze(normalized);
}

function requireDirtyReleaseAuthorization(
  releaseManifest: WorkerReleaseManifestV1,
  dirtyReleaseAuthorized: boolean,
): void {
  if (
    (releaseManifest.source_state === "clean" && dirtyReleaseAuthorized)
    || (releaseManifest.source_state === "dirty" && !dirtyReleaseAuthorized)
  ) {
    throw new Error("DIRTY_RELEASE_AUTHORIZATION_MISMATCH");
  }
}

export async function certifyEvolutionEvalRemote(options: {
  readonly gateId: string;
  readonly activeConfigSha256: string;
  readonly database: GateDatabaseIdentity;
  readonly endpointOrigin: string;
  readonly connectorId: string;
  readonly releaseManifest: WorkerReleaseManifestV1;
  readonly toolchainAttestation: VivadoToolchainAttestationV1;
  readonly toolchainAttestationRawSha256: string;
  readonly dirtyReleaseAuthorized: boolean;
  readonly canaryBinding: CoreIssuedEvalBinding;
  readonly reservationReceiptBytes: Uint8Array;
  readonly expectedReservationReceiptFileSha256: string;
  readonly verifyCoreIssuedCanary: (binding: CoreIssuedEvalBinding) => Promise<void>;
  readonly remote: CertificationRemoteClient;
  readonly now?: Date;
}): Promise<EvolutionEvalF0CertificationV2> {
  if (!OPAQUE_ID.test(options.gateId)) throw new TypeError("gateId is invalid");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now is invalid");
  const activeConfigSha256 = hash(options.activeConfigSha256, "activeConfigSha256");
  const toolchainAttestationRawSha256 = assertToolchainAttestationForGate({
    attestation: options.toolchainAttestation,
    rawSha256: options.toolchainAttestationRawSha256,
    gateId: options.gateId,
    releaseManifest: options.releaseManifest,
    now,
  });
  requireDirtyReleaseAuthorization(options.releaseManifest, options.dirtyReleaseAuthorized);
  const endpoint = exactHttpsOrigin(options.endpointOrigin);
  if (!OPAQUE_ID.test(options.connectorId)) throw new TypeError("connectorId is invalid");
  await options.verifyCoreIssuedCanary(options.canaryBinding);
  const reservationReceiptFileSha256 = sha256Bytes(options.reservationReceiptBytes);
  if (
    reservationReceiptFileSha256
    !== hash(
      options.expectedReservationReceiptFileSha256,
      "expectedReservationReceiptFileSha256",
    )
  ) {
    throw new Error("CANARY_RESERVATION_RECEIPT_FILE_HASH_MISMATCH");
  }
  const receipt = parseEvolutionEvalCanaryReservationReceipt(
    JSON.parse(Buffer.from(options.reservationReceiptBytes).toString("utf8")),
  );
  const bindingHash = evolutionEvalCanonicalHash(options.canaryBinding);
  if (
    receipt.gate_id !== options.gateId
    || receipt.database_identity_hash !== options.database.identity_hash
    || receipt.worker_release_manifest_hash !== options.releaseManifest.manifest_hash
    || receipt.active_config_sha256 !== activeConfigSha256
    || receipt.vivado_toolchain_attestation_sha256 !== toolchainAttestationRawSha256
    || receipt.live_mapping_health !== "healthy"
    || receipt.binding_hash !== bindingHash
    || receipt.project_id !== options.canaryBinding.project_id
    || receipt.eval_job_id !== options.canaryBinding.dispatch.eval_job_id
    || receipt.connector_job_id !== options.canaryBinding.dispatch.connector_job_id
    || receipt.dispatch_request_hash !== options.canaryBinding.dispatch_request_hash
  ) {
    throw new Error("CANARY_RESERVATION_RECEIPT_MISMATCH");
  }
  const observed = await observeCertificationRemote({
    remote: options.remote,
    releaseManifest: options.releaseManifest,
    connectorId: options.connectorId,
    activeConfigSha256,
    toolchainAttestationRawSha256,
  });
  if (observed.workerProcessInstanceId === receipt.pre_worker_process_instance_id) {
    throw new Error("WORKER_RESTART_NOT_PROVEN");
  }

  const observation = validateEvolutionEvalLedgerObservation(
    options.canaryBinding,
    await options.remote.evolutionEvalQuery(options.canaryBinding),
  );
  if (observation.state !== "proven_never_accepted" || observation.replay_permitted !== true) {
    throw new Error("REMOTE_CANARY_NOT_PROVEN_NEVER_ACCEPTED");
  }
  if (observation.ledger_epoch !== receipt.ledger_epoch) {
    throw new Error("REMOTE_CANARY_LEDGER_EPOCH_MISMATCH");
  }
  const certifiedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CERTIFICATION_VALIDITY_MS).toISOString();
  if (Date.parse(expiresAt) > Date.parse(options.toolchainAttestation.expires_at)) {
    throw new Error("F0 certification would exceed the Vivado toolchain attestation window");
  }
  const body = {
    schema: CERTIFICATION_SCHEMA,
    gate_id: options.gateId,
    certified_at: certifiedAt,
    expires_at: expiresAt,
    reservation_receipt_hash: reservationReceiptFileSha256,
    worker_process_instance_id: observed.workerProcessInstanceId,
    active_config_sha256: activeConfigSha256,
    database: options.database,
    endpoint: {
      origin: endpoint.origin,
      hostname: endpoint.hostname.toLowerCase(),
      connector_id: options.connectorId,
    },
    worker_release_manifest_hash: options.releaseManifest.manifest_hash,
    toolchain_attestation: {
      schema: TOOLCHAIN_ATTESTATION_SCHEMA,
      raw_sha256: toolchainAttestationRawSha256,
      canonical_attestation_sha256:
        options.toolchainAttestation.canonical_attestation_sha256,
      full_tree_manifest_hash:
        options.toolchainAttestation.full_tree_manifest.canonical_sha256,
      toolchain_profile_hash: options.toolchainAttestation.toolchain_profile.derived_sha256,
    },
    remote: observed.expectedRemote,
    ledger: {
      epoch: observation.ledger_epoch,
      health: "healthy" as const,
    },
    canary: {
      project_id: options.canaryBinding.project_id,
      eval_job_id: options.canaryBinding.dispatch.eval_job_id,
      connector_job_id: options.canaryBinding.dispatch.connector_job_id,
      dispatch_request_hash: options.canaryBinding.dispatch_request_hash,
      binding_hash: evolutionEvalCanonicalHash(options.canaryBinding),
      state: "proven_never_accepted" as const,
      replay_permitted: true as const,
    },
    dirty_release_authorized: options.dirtyReleaseAuthorized,
    remote_certification_authorized: true as const,
  };
  return parseEvolutionEvalF0Certification({
    ...body,
    certification_hash: evolutionEvalCanonicalHash(body),
  }, options.releaseManifest, options.toolchainAttestation, toolchainAttestationRawSha256);
}

async function observeCertificationRemote(options: {
  readonly remote: CertificationRemoteClient;
  readonly releaseManifest: WorkerReleaseManifestV1;
  readonly connectorId: string;
  readonly activeConfigSha256: string;
  readonly toolchainAttestationRawSha256: string;
}): Promise<{
  readonly expectedRemote: EvolutionEvalF0CertificationV2["remote"];
  readonly workerProcessInstanceId: string;
}> {
  await options.remote.register();
  const heartbeat = await options.remote.heartbeat();
  if (heartbeat.registration_state !== "ready" || heartbeat.capability_drift !== false) {
    throw new Error("REMOTE_HEARTBEAT_NOT_READY");
  }
  const discovery = await options.remote.discover();
  const capabilities = normalizeDiscoveryCapabilities(discovery.capabilities);
  const expectedRemote = {
    ...options.releaseManifest.expected,
    license_status: "available" as const,
    live_mapping_health: "healthy" as const,
  };
  const remoteIdentity = {
    sdk_worker_build_hash: discovery.sdk_worker_build_hash,
    protocol_version: discovery.connector_protocol_version,
    capability_map_version: discovery.capability_map_version,
    part_catalog_hash: discovery.part_catalog_hash,
    toolchain_profile_hash: discovery.toolchain_profile_hash,
    vivado_version: discovery.vivado_version,
    vivado_patch: discovery.vivado_patch,
    part: options.releaseManifest.expected.part,
    license_status: discovery.license_status,
    live_mapping_health: discovery.live_mapping_health,
    capabilities,
  };
  const workerProcessInstanceId = uuidV4(
    discovery.worker_process_instance_id,
    "remote worker_process_instance_id",
  );
  if (
    discovery.connector_id !== options.connectorId
    || discovery.active_config_sha256 !== options.activeConfigSha256
    || discovery.vivado_toolchain_attestation_sha256
      !== options.toolchainAttestationRawSha256
    || discovery.live_mapping_health !== "healthy"
    || !HASH.test(discovery.active_config_sha256)
    || !sameCanonical(remoteIdentity, expectedRemote)
  ) {
    throw new Error("REMOTE_RELEASE_IDENTITY_MISMATCH");
  }
  assertFourEvolutionEvalCapabilities(capabilities);
  return { expectedRemote, workerProcessInstanceId };
}

export async function reserveEvolutionEvalCanary(options: {
  readonly gateId: string;
  readonly activeConfigSha256: string;
  readonly database: GateDatabaseIdentity;
  readonly connectorId: string;
  readonly releaseManifest: WorkerReleaseManifestV1;
  readonly toolchainAttestation: VivadoToolchainAttestationV1;
  readonly toolchainAttestationRawSha256: string;
  readonly canaryBinding: CoreIssuedEvalBinding;
  readonly verifyCoreIssuedCanary: (binding: CoreIssuedEvalBinding) => Promise<void>;
  readonly remote: CertificationReservationRemoteClient;
  readonly now?: Date;
}): Promise<EvolutionEvalCanaryReservationReceiptV1> {
  if (!OPAQUE_ID.test(options.gateId)) throw new TypeError("gateId is invalid");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now is invalid");
  const activeConfigSha256 = hash(options.activeConfigSha256, "activeConfigSha256");
  const toolchainAttestationRawSha256 = assertToolchainAttestationForGate({
    attestation: options.toolchainAttestation,
    rawSha256: options.toolchainAttestationRawSha256,
    gateId: options.gateId,
    releaseManifest: options.releaseManifest,
    now,
  });
  await options.verifyCoreIssuedCanary(options.canaryBinding);
  const observed = await observeCertificationRemote({
    remote: options.remote,
    releaseManifest: options.releaseManifest,
    connectorId: options.connectorId,
    activeConfigSha256,
    toolchainAttestationRawSha256,
  });
  const observation = validateEvolutionEvalLedgerObservation(
    options.canaryBinding,
    await options.remote.evolutionEvalReserve(options.canaryBinding, {
      active_config_sha256: activeConfigSha256,
      worker_process_instance_id: observed.workerProcessInstanceId,
      vivado_toolchain_attestation_sha256: toolchainAttestationRawSha256,
    }),
  );
  if (observation.state !== "proven_never_accepted" || observation.replay_permitted !== true) {
    throw new Error("REMOTE_CANARY_RESERVATION_FAILED");
  }
  const body = {
    schema: "synthia-evolution-eval-canary-reservation-receipt.v1" as const,
    gate_id: options.gateId,
    database_identity_hash: options.database.identity_hash,
    worker_release_manifest_hash: options.releaseManifest.manifest_hash,
    active_config_sha256: activeConfigSha256,
    vivado_toolchain_attestation_sha256: toolchainAttestationRawSha256,
    live_mapping_health: "healthy" as const,
    pre_worker_process_instance_id: observed.workerProcessInstanceId,
    binding_hash: evolutionEvalCanonicalHash(options.canaryBinding),
    project_id: options.canaryBinding.project_id,
    eval_job_id: options.canaryBinding.dispatch.eval_job_id,
    connector_job_id: options.canaryBinding.dispatch.connector_job_id,
    dispatch_request_hash: options.canaryBinding.dispatch_request_hash,
    ledger_epoch: observation.ledger_epoch,
    reservation_observation_hash: evolutionEvalCanonicalHash(observation),
    state: "proven_never_accepted" as const,
    replay_permitted: true as const,
    reserved_at: now.toISOString(),
  };
  return parseEvolutionEvalCanaryReservationReceipt({
    ...body,
    receipt_hash: evolutionEvalCanonicalHash(body),
  });
}

export async function loadEvolutionEvalNewEffectsCertification(options: {
  readonly releaseManifestPath: string;
  readonly certificationPath: string;
  readonly expectedCertificationFileSha256: string;
  readonly toolchainAttestationPath: string;
  readonly expectedToolchainAttestationFileSha256: string;
  readonly connectorConfigPath: string;
  readonly databaseUrl: string;
  readonly gateId: string;
  readonly now?: Date;
  readonly requireFresh?: boolean;
}): Promise<{
  readonly releaseManifest: WorkerReleaseManifestV1;
  readonly toolchainAttestation: VivadoToolchainAttestationV1;
  readonly toolchainAttestationFileSha256: string;
  readonly certification: EvolutionEvalF0CertificationV2;
}> {
  const releaseManifest = parseWorkerReleaseManifest(
    JSON.parse(await readFile(options.releaseManifestPath, "utf8")),
  );
  const toolchainAttestationBytes = await readFile(options.toolchainAttestationPath);
  const toolchainAttestationFileSha256 = sha256Bytes(toolchainAttestationBytes);
  if (
    toolchainAttestationFileSha256
    !== hash(
      options.expectedToolchainAttestationFileSha256,
      "expectedToolchainAttestationFileSha256",
    )
  ) {
    throw new Error(
      "Vivado toolchain attestation raw file SHA-256 differs from deployment authorization",
    );
  }
  const toolchainAttestation = parseVivadoToolchainAttestation(
    JSON.parse(toolchainAttestationBytes.toString("utf8")),
  );
  const certificationBytes = await readFile(options.certificationPath);
  if (
    sha256Bytes(certificationBytes)
    !== hash(options.expectedCertificationFileSha256, "expectedCertificationFileSha256")
  ) {
    throw new Error("F0 certification raw file SHA-256 differs from deployment authorization");
  }
  const certification = parseEvolutionEvalF0Certification(
    JSON.parse(certificationBytes.toString("utf8")),
    releaseManifest,
    toolchainAttestation,
    toolchainAttestationFileSha256,
  );
  if (options.requireFresh !== false) {
    assertEvolutionEvalCertificationFresh(certification, options.now);
    assertVivadoToolchainAttestationFresh(toolchainAttestation, options.now);
  }
  const actualDatabase = gateDatabaseIdentity(options.databaseUrl);
  if (!sameCanonical(certification.database, actualDatabase)) {
    throw new Error("F0 certification database differs from DATABASE_URL");
  }
  if (certification.gate_id !== options.gateId) {
    throw new Error("F0 certification gate differs from SYNTHIA_M4F_GATE_ID");
  }
  const activeConfigBytes = await readFile(options.connectorConfigPath);
  if (sha256Bytes(activeConfigBytes) !== certification.active_config_sha256) {
    throw new Error("active Connector config bytes differ from F0 certification");
  }
  assertConnectorConfigMatchesCertification(
    JSON.parse(activeConfigBytes.toString("utf8")),
    releaseManifest,
    certification.endpoint.connector_id,
    certification.ledger.epoch,
    certification.toolchain_attestation.raw_sha256,
  );
  return Object.freeze({
    releaseManifest,
    toolchainAttestation,
    toolchainAttestationFileSha256,
    certification,
  });
}

export function assertConnectorConfigMatchesCertification(
  value: unknown,
  releaseManifest: WorkerReleaseManifestV1,
  certifiedConnectorId: string,
  certifiedLedgerEpoch: string,
  certifiedToolchainAttestationSha256: string,
): void {
  const config = record(value, "Connector config");
  const allowedCapabilityIds = config.allowed_capability_ids;
  if (
    !Array.isArray(allowedCapabilityIds)
    || allowedCapabilityIds.some((candidate) => typeof candidate !== "string")
    || new Set(allowedCapabilityIds).size !== allowedCapabilityIds.length
  ) {
    throw new TypeError("Connector config allowed_capability_ids is invalid");
  }
  const expectedCapabilityIds = releaseManifest.expected.capabilities
    .map((capability) => capability.operation)
    .sort(compareBytes);
  const actualCapabilityIds = [...allowedCapabilityIds].sort(compareBytes);
  if (
    config.connector_id !== certifiedConnectorId
    || config.protocol_version !== releaseManifest.expected.protocol_version
    || config.capability_map_version !== releaseManifest.expected.capability_map_version
    || config.part_catalog_hash !== releaseManifest.expected.part_catalog_hash
    || config.toolchain_profile_hash !== releaseManifest.expected.toolchain_profile_hash
    || config.sdk_worker_build_hash !== releaseManifest.expected.sdk_worker_build_hash
    || config.vivado_part !== releaseManifest.expected.part
    || config.evolution_eval_enabled !== true
    || config.evolution_eval_ledger_mode !== "reopen"
    || config.evolution_eval_ledger_epoch !== certifiedLedgerEpoch
    || typeof config.evolution_eval_log_root !== "string"
    || config.evolution_eval_log_root.length === 0
    || typeof config.vivado_toolchain_attestation_path !== "string"
    || config.vivado_toolchain_attestation_path.length === 0
    || config.vivado_toolchain_attestation_sha256
      !== hash(
        certifiedToolchainAttestationSha256,
        "certifiedToolchainAttestationSha256",
      )
    || !sameCanonical(actualCapabilityIds, expectedCapabilityIds)
  ) {
    throw new Error("Connector config differs from the certified Worker release");
  }
}

export async function verifyM4fCanaryInDatabase(
  client: PoolClient,
  binding: CoreIssuedEvalBinding,
  expected: { readonly databaseName: string; readonly gateId: string },
): Promise<void> {
  const connectorModulePath: string = "../../connector/evolution-eval.ts";
  const { validateCoreIssuedEvalBinding } = await import(connectorModulePath) as {
    validateCoreIssuedEvalBinding(value: unknown, expectedProjectId?: string): CoreIssuedEvalBinding;
  };
  const canonicalBinding = validateCoreIssuedEvalBinding(binding);
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    const result = await client.query(
      `SELECT current_database() AS current_database_name,
              database_name,gate_id,scenario,project_id,request_hash,
              binding_hash,binding
         FROM evolution_eval_canary_binding
        WHERE singleton_id='m4f-canary'
          AND project_id=$2
          AND binding->'dispatch'->>'eval_job_id'=$1`,
      [canonicalBinding.dispatch.eval_job_id, canonicalBinding.project_id],
    );
    if (result.rows.length !== 1) throw new Error("CORE_CANARY_BINDING_NOT_FOUND");
    const row = result.rows[0] as Record<string, unknown>;
    const databaseBinding = validateCoreIssuedEvalBinding(row.binding);
    if (
      row.current_database_name !== row.database_name
      || row.database_name !== expected.databaseName
      || row.gate_id !== expected.gateId
      || row.project_id !== canonicalBinding.project_id
      || row.binding_hash !== evolutionEvalCanonicalHash(databaseBinding)
      || !sameCanonical(databaseBinding, canonicalBinding)
    ) {
      throw new Error("CORE_CANARY_BINDING_MISMATCH");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertOutsideRepository(path: string, repositoryRoot: string, name: string): string {
  const absolute = resolve(path);
  const fromRepository = relative(repositoryRoot, absolute);
  if (!isAbsolute(absolute) || fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error(`${name} must be outside the repository`);
  }
  return absolute;
}

async function writeExclusiveDurable(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const phase = env.SYNTHIA_M4F_CERTIFICATION_PHASE ?? "preflight";
  if (phase !== "preflight" && phase !== "reserve" && phase !== "certify") {
    throw new Error("SYNTHIA_M4F_CERTIFICATION_PHASE must be preflight, reserve, or certify");
  }
  const databaseUrl = requiredEnv(env, "DATABASE_URL");
  const gateId = requiredEnv(env, "SYNTHIA_M4F_GATE_ID");
  const endpointOrigin = requiredEnv(env, "SYNTHIA_M4F_ENDPOINT_URL");
  const allowedOrigin = requiredEnv(env, "SYNTHIA_M4F_ENDPOINT_ALLOWED_ORIGIN");
  if (endpointOrigin !== allowedOrigin) throw new Error("M4-F endpoint differs from the exact allowlist");
  exactHttpsOrigin(endpointOrigin, "SYNTHIA_M4F_ENDPOINT_URL");
  const database = gateDatabaseIdentity(databaseUrl);
  const releaseManifest = parseWorkerReleaseManifest(JSON.parse(
    await readFile(requiredEnv(env, "SYNTHIA_M4F_RELEASE_MANIFEST"), "utf8"),
  ));
  const toolchainAttestationBytes = await readFile(
    requiredEnv(env, "SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION"),
  );
  const toolchainAttestationRawSha256 = sha256Bytes(toolchainAttestationBytes);
  if (
    toolchainAttestationRawSha256
    !== hash(
      requiredEnv(env, "SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256"),
      "SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256",
    )
  ) {
    throw new Error("Vivado toolchain attestation differs from Windows ceremony hash");
  }
  const toolchainAttestation = parseVivadoToolchainAttestation(
    JSON.parse(toolchainAttestationBytes.toString("utf8")),
  );
  assertToolchainAttestationForGate({
    attestation: toolchainAttestation,
    rawSha256: toolchainAttestationRawSha256,
    gateId,
    releaseManifest,
    now: new Date(),
  });
  const canaryPath = requiredEnv(env, "SYNTHIA_M4F_CANARY_BINDING");
  const connectorModulePath: string = "../../connector/evolution-eval.ts";
  const { validateCoreIssuedEvalBinding } = await import(connectorModulePath) as {
    validateCoreIssuedEvalBinding(value: unknown, expectedProjectId?: string): CoreIssuedEvalBinding;
  };
  const canaryBinding = validateCoreIssuedEvalBinding(
    JSON.parse(await readFile(canaryPath, "utf8")),
  );
  const activeConfigBytes = await readFile(requiredEnv(env, "SYNTHIA_CONNECTOR_CONFIG"));
  const activeConfigSha256 = sha256Bytes(activeConfigBytes);
  const expectedActiveConfigSha256 = hash(
    requiredEnv(env, "SYNTHIA_M4F_ACTIVE_CONFIG_SHA256"),
    "SYNTHIA_M4F_ACTIVE_CONFIG_SHA256",
  );
  if (activeConfigSha256 !== expectedActiveConfigSha256) {
    throw new Error("active Connector config differs from Windows preflight/startup hash");
  }
  const config = JSON.parse(activeConfigBytes.toString("utf8")) as Record<string, unknown>;
  const connectorId = nonEmptyString(config.connector_id, "Connector config connector_id", 128);
  const configuredLedgerEpoch = nonEmptyString(
    requiredEnv(env, "SYNTHIA_M4F_LEDGER_EPOCH"),
    "SYNTHIA_M4F_LEDGER_EPOCH",
    128,
  );
  assertConnectorConfigMatchesCertification(
    config,
    releaseManifest,
    connectorId,
    configuredLedgerEpoch,
    toolchainAttestationRawSha256,
  );
  const dirtyReleaseAuthorized = env.SYNTHIA_M4F_DIRTY_RELEASE_AUTHORIZED === "1";
  requireDirtyReleaseAuthorization(releaseManifest, dirtyReleaseAuthorized);
  if (phase !== "preflight" && env.SYNTHIA_M4F_REMOTE_CERTIFICATION_AUTHORIZED !== "1") {
    throw new Error("SYNTHIA_M4F_REMOTE_CERTIFICATION_AUTHORIZED=1 is required for remote phases");
  }
  // Constructing the client is intentionally part of preflight: direct mode
  // must bind and freeze all three reviewed PEM files before any remote phase
  // can be authorized.  No network request is made by either factory here.
  const remote = await createM4fCertificationRemoteClient({
    endpointOrigin,
    config,
    projectId: canaryBinding.project_id,
    env,
  });
  if (phase === "preflight") {
    console.log(JSON.stringify({
      mode: "preflight",
      remote_called: false,
      gate_id: gateId,
      active_config_sha256: activeConfigSha256,
      database_identity_hash: database.identity_hash,
      endpoint: endpointOrigin,
      connector_id: connectorId,
      worker_release_manifest_hash: releaseManifest.manifest_hash,
      vivado_toolchain_attestation_sha256: toolchainAttestationRawSha256,
      remote_auth_mode: endpointOrigin === M4F_DIRECT_MTLS_ENDPOINT_ORIGIN
        ? "direct_mtls"
        : "cloudflare_access",
      dirty_release_authorized: dirtyReleaseAuthorized,
    }));
    return;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const verifyCoreIssuedCanary = async (binding: CoreIssuedEvalBinding) => {
      const client = await pool.connect();
      try {
        await verifyM4fCanaryInDatabase(client, binding, {
          databaseName: database.name,
          gateId,
        });
      } finally {
        client.release();
      }
    };
    if (phase === "reserve") {
      const output = assertOutsideRepository(
        requiredEnv(env, "SYNTHIA_M4F_RESERVATION_RECEIPT_OUTPUT"),
        repositoryRoot,
        "SYNTHIA_M4F_RESERVATION_RECEIPT_OUTPUT",
      );
      const receipt = await reserveEvolutionEvalCanary({
        gateId,
        activeConfigSha256,
        database,
        connectorId,
        releaseManifest,
        toolchainAttestation,
        toolchainAttestationRawSha256,
        canaryBinding,
        verifyCoreIssuedCanary,
        remote,
      });
      const bytes = Buffer.from(`${evolutionEvalCanonicalJson(receipt)}\n`, "utf8");
      await writeExclusiveDurable(output, bytes);
      console.log(JSON.stringify({
        mode: "reserved",
        remote_called: true,
        receipt_hash: receipt.receipt_hash,
        reservation_receipt_file_sha256: sha256Bytes(bytes),
        output,
        next_action: "restart the external Worker before running the certify phase",
      }));
      return;
    }

    const output = assertOutsideRepository(
      requiredEnv(env, "SYNTHIA_M4F_CERTIFICATION_OUTPUT"),
      repositoryRoot,
      "SYNTHIA_M4F_CERTIFICATION_OUTPUT",
    );
    const reservationReceiptBytes = await readFile(
      requiredEnv(env, "SYNTHIA_M4F_RESERVATION_RECEIPT"),
    );
    const expectedReservationReceiptFileSha256 = hash(
      requiredEnv(env, "SYNTHIA_M4F_RESERVATION_RECEIPT_SHA256"),
      "SYNTHIA_M4F_RESERVATION_RECEIPT_SHA256",
    );
    const certification = await certifyEvolutionEvalRemote({
      gateId,
      activeConfigSha256,
      database,
      endpointOrigin,
      connectorId,
      releaseManifest,
      toolchainAttestation,
      toolchainAttestationRawSha256,
      dirtyReleaseAuthorized,
      canaryBinding,
      reservationReceiptBytes,
      expectedReservationReceiptFileSha256,
      verifyCoreIssuedCanary,
      remote,
    });
    const bytes = Buffer.from(`${evolutionEvalCanonicalJson(certification)}\n`, "utf8");
    await writeExclusiveDurable(output, bytes);
    console.log(JSON.stringify({
      mode: "certified",
      remote_called: true,
      certification_hash: certification.certification_hash,
      certification_file_sha256: sha256Bytes(bytes),
      output,
    }));
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "M4F_CERTIFICATION_FAILED");
    process.exitCode = 1;
  });
}
