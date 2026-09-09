#!/usr/bin/env bun
/**
 * Synthia Core API server launcher.
 *
 *   DATABASE_URL=postgres://... [PORT=8787] bun run core/scripts/serve.ts
 *
 * Connector port is built from env when Cloudflare credentials are present
 * (SYNTHIA_CF_ACCESS_CLIENT_ID / SYNTHIA_CF_ACCESS_CLIENT_SECRET /
 * SYNTHIA_CONNECTOR_CONFIG); without them the server still starts and the
 * Job endpoints answer 503 capability_unavailable.
 * Historical-material writes require SYNTHIA_FEATURE_HISTORICAL_MATERIALS=1
 * (or true); unset/0/false keeps the capability read-only.
 * Side-task workspace/adoption writes require SYNTHIA_FEATURE_SIDE_TASKS=1.
 */
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { startSynthiaServer } from "../src/api/server.ts";
import { createConnectorFromEnv } from "../src/api/connector-adapter.ts";
import {
  resolveCoreFeatureFlags,
  resolveEvolutionEvalExecutionPlane,
} from "../src/api/feature-flags.ts";
import { runEvolutionEvalDispatcherTick } from "../src/services/evolution-eval-dispatcher.ts";
import { evolutionEvalCanonicalHash } from "../src/domain/evolution-eval.ts";
import type { CoreIssuedEvalBinding } from "../src/services/evolution-eval-connector-port.ts";
import {
  gateDatabaseIdentity,
  loadEvolutionEvalNewEffectsCertification,
  resolveM4fGateEndpoint,
} from "./certify-evolution-eval-m4f.ts";
import {
  loadEvolutionEvalChaosAuthorization,
  parseEvolutionEvalChaosScenario,
} from "./evolution-eval-chaos-proxy.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Expected: postgres://user:pass@host:5432/synthia");
  process.exit(1);
}

const features = resolveCoreFeatureFlags({ env: process.env });
const executionPlane = resolveEvolutionEvalExecutionPlane(features);
if (executionPlane.dispatcherHostEnabled) {
  gateDatabaseIdentity(DATABASE_URL);
  requiredEnvironment("SYNTHIA_M4F_GATE_ID", process.env.SYNTHIA_M4F_GATE_ID);
}
const certificationLoadOptions = executionPlane.allowNewEffects
  ? resolveCertificationLoadOptions(process.env, DATABASE_URL)
  : undefined;
let certifiedEvolutionEval: Awaited<ReturnType<typeof loadEvolutionEvalNewEffectsCertification>>
  | undefined;
if (executionPlane.allowNewEffects) {
  try {
    if (certificationLoadOptions) {
      certifiedEvolutionEval = await loadEvolutionEvalNewEffectsCertification(
        certificationLoadOptions,
      );
    }
  } catch {
    certifiedEvolutionEval = undefined;
    console.error(
      "[core] evolution-eval certification/toolchain attestation is unavailable; "
      + "starting recovery/retention-only",
    );
  }
}
const certifiedEvolutionEvalIdentity = certifiedEvolutionEval
  ? certificationIdentity(certifiedEvolutionEval.certification)
  : undefined;
const chaosAuthorizationPath = process.env.SYNTHIA_M4F_CHAOS_AUTHORIZATION;
if (
  !chaosAuthorizationPath
  && (
    process.env.SYNTHIA_M4F_CHAOS_AUTHORIZATION_SHA256
    || process.env.SYNTHIA_M4F_CHAOS_SCENARIO
  )
) {
  throw new Error("SYNTHIA_M4F_CHAOS_AUTHORIZATION is required for chaos configuration");
}
const chaosAuthorization = chaosAuthorizationPath && certificationLoadOptions
  ? await loadEvolutionEvalChaosAuthorization({
      authorizationPath: chaosAuthorizationPath,
      expectedAuthorizationFileSha256: requiredEnvironment(
        "SYNTHIA_M4F_CHAOS_AUTHORIZATION_SHA256",
        process.env.SYNTHIA_M4F_CHAOS_AUTHORIZATION_SHA256,
      ),
      releaseManifestPath: certificationLoadOptions.releaseManifestPath,
      certificationPath: certificationLoadOptions.certificationPath,
      expectedCertificationFileSha256:
        certificationLoadOptions.expectedCertificationFileSha256,
      toolchainAttestationPath: certificationLoadOptions.toolchainAttestationPath,
      expectedToolchainAttestationFileSha256:
        certificationLoadOptions.expectedToolchainAttestationFileSha256,
      connectorConfigPath: certificationLoadOptions.connectorConfigPath,
      databaseUrl: DATABASE_URL,
      gateId: certificationLoadOptions.gateId,
      scenario: parseEvolutionEvalChaosScenario(requiredEnvironment(
        "SYNTHIA_M4F_CHAOS_SCENARIO",
        process.env.SYNTHIA_M4F_CHAOS_SCENARIO,
      )),
      proxyOrigin: requiredEnvironment(
        "SYNTHIA_M4F_ENDPOINT_URL",
        process.env.SYNTHIA_M4F_ENDPOINT_URL,
      ),
      requireFreshCertification: executionPlane.allowNewEffects,
    })
  : undefined;
const endpointOverride = resolveM4fGateEndpoint({
  dispatcherHostEnabled: executionPlane.dispatcherHostEnabled,
  endpoint: process.env.SYNTHIA_M4F_ENDPOINT_URL,
  allowedOrigin: process.env.SYNTHIA_M4F_ENDPOINT_ALLOWED_ORIGIN,
  certifiedOrigin: chaosAuthorization?.proxy_origin
    ?? certifiedEvolutionEval?.certification.endpoint.origin,
});
const pool = new Pool({ connectionString: DATABASE_URL });
const connector = await createConnectorFromEnv({
  env: process.env,
  ...(endpointOverride ? { endpointUrl: endpointOverride } : {}),
  ...(certificationLoadOptions && certifiedEvolutionEvalIdentity
    ? {
        evolutionEvalCertification: {
          identity: certifiedEvolutionEvalIdentity,
          current: async () => certificationIdentity((
            await loadEvolutionEvalNewEffectsCertification({
              ...certificationLoadOptions,
              requireFresh: true,
            })
          ).certification),
        },
      }
    : {}),
});
if (executionPlane.dispatcherHostEnabled && !connector) {
  throw new Error(
    "SYNTHIA_FEATURE_EVOLUTION_EVAL_DISPATCHER_HOST requires a configured Connector",
  );
}
let certifiedCanaryBinding: CoreIssuedEvalBinding | undefined;
if (connector && certifiedEvolutionEval) {
  certifiedCanaryBinding = await loadCertifiedCanaryBinding(
    process.env,
    certifiedEvolutionEval.certification,
  );
  await connector.revalidateEvolutionEvalCertification(
    certifiedCanaryBinding,
    executionPlane.allowNewEffects,
  );
}
const dispatcherIntervalMs = optionalBoundedInteger(
  process.env.SYNTHIA_EVOLUTION_EVAL_DISPATCH_INTERVAL_MS,
  1_000,
  10,
  300_000,
  "SYNTHIA_EVOLUTION_EVAL_DISPATCH_INTERVAL_MS",
);
const dispatcherMaxDuties = optionalBoundedInteger(
  process.env.SYNTHIA_EVOLUTION_EVAL_DISPATCH_MAX_DUTIES,
  10,
  1,
  100,
  "SYNTHIA_EVOLUTION_EVAL_DISPATCH_MAX_DUTIES",
);
const server = startSynthiaServer(pool, {
  port: process.env.PORT ? Number(process.env.PORT) : 8787,
  connector,
  evolutionEvalConnector: connector ?? undefined,
  features,
  ...(connector && certifiedEvolutionEval
    ? {
        evolutionEvalReadiness: {
          gateId: certifiedEvolutionEval.certification.gate_id,
          certificationHash: certifiedEvolutionEval.certification.certification_hash,
          expiresAt: certifiedEvolutionEval.certification.expires_at,
          endpointOrigin: certifiedEvolutionEval.certification.endpoint.origin,
          projectId: certifiedEvolutionEval.certification.canary.project_id,
          connectorId: certifiedEvolutionEval.certification.endpoint.connector_id,
          workerProcessInstanceId:
            certifiedEvolutionEval.certification.worker_process_instance_id,
          ledgerEpoch: certifiedEvolutionEval.certification.ledger.epoch,
          activeConfigSha256: certifiedEvolutionEval.certification.active_config_sha256,
        },
        evolutionEvalLiveCertificationProbe: async () => {
          if (!certificationLoadOptions || !certifiedCanaryBinding) {
            throw new Error("M4-F live certification is not configured");
          }
          const loaded = await loadEvolutionEvalNewEffectsCertification({
            ...certificationLoadOptions,
            requireFresh: true,
          });
          const current = certificationIdentity(loaded.certification);
          if (!sameCertificationIdentity(current, certifiedEvolutionEvalIdentity)) {
            throw new Error("M4-F live certification identity changed after startup");
          }
          const binding = await loadCertifiedCanaryBinding(
            process.env,
            loaded.certification,
          );
          await connector.revalidateEvolutionEvalCertification(binding, true);
        },
      }
    : {}),
  ...(connector && executionPlane.dispatcherHostEnabled
    ? {
        evolutionEvalDispatcher: {
          enabled: true,
          intervalMs: dispatcherIntervalMs,
          tick: async () => {
            let certificationCurrent = !executionPlane.allowNewEffects;
            if (executionPlane.allowNewEffects) {
              try {
                const tickLoadOptions = resolveCertificationLoadOptions(
                  process.env,
                  DATABASE_URL,
                );
                if (tickLoadOptions) {
                  const loaded = await loadEvolutionEvalNewEffectsCertification(tickLoadOptions);
                  const current = certificationIdentity(loaded.certification);
                  certificationCurrent = sameCertificationIdentity(
                    current,
                    certifiedEvolutionEvalIdentity,
                  );
                  if (certificationCurrent) {
                    await connector.revalidateEvolutionEvalCertification(
                      await loadCertifiedCanaryBinding(process.env, loaded.certification),
                      true,
                    );
                  }
                }
              } catch {
                certificationCurrent = false;
                console.error("[core] evolution-eval certification is stale or invalid; new effects disabled for this tick");
              }
            }
            return runEvolutionEvalDispatcherTick(pool, connector, {
              holderId: process.env.SYNTHIA_EVOLUTION_EVAL_DISPATCHER_ID
                ?? `core-evolution-eval-${process.pid}`,
              maxDuties: dispatcherMaxDuties,
              allowNewEffects: executionPlane.allowNewEffects && certificationCurrent,
              rolloutEnabled: executionPlane.rolloutEnabled && certificationCurrent,
            });
          },
          onError: () => console.error("[core] evolution-eval dispatcher tick failed"),
        },
      }
    : {}),
});
console.log(
  `[core] api listening on :${server.port} connector=${connector ? "configured" : "unavailable"}`
  + ` historical_materials=${features.historicalMaterials ? "enabled" : "disabled"}`
  + ` side_tasks=${features.sideTasks ? "enabled" : "disabled"}`
  + ` evolution_eval_dispatcher_host=${executionPlane.dispatcherHostEnabled ? "enabled" : "disabled"}`
  + ` evolution_eval_new_effects=${executionPlane.allowNewEffects ? "enabled" : "disabled"}`
  + ` self_evolution_rollout=${executionPlane.rolloutEnabled ? "enabled" : "disabled"}`,
);

function requiredEnvironment(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveCertificationLoadOptions(
  env: Record<string, string | undefined>,
  databaseUrl: string,
): Parameters<typeof loadEvolutionEvalNewEffectsCertification>[0] | undefined {
  const releaseManifestPath = env.SYNTHIA_M4F_RELEASE_MANIFEST;
  const certificationPath = env.SYNTHIA_M4F_F0_CERTIFICATION;
  const expectedCertificationFileSha256 = env.SYNTHIA_M4F_F0_CERTIFICATION_SHA256;
  const toolchainAttestationPath = env.SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION;
  const expectedToolchainAttestationFileSha256 =
    env.SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256;
  const connectorConfigPath = env.SYNTHIA_CONNECTOR_CONFIG;
  const gateId = env.SYNTHIA_M4F_GATE_ID;
  if (
    !releaseManifestPath
    || !certificationPath
    || !expectedCertificationFileSha256
    || !toolchainAttestationPath
    || !expectedToolchainAttestationFileSha256
    || !connectorConfigPath
    || !gateId
  ) {
    return undefined;
  }
  return {
    releaseManifestPath,
    certificationPath,
    expectedCertificationFileSha256,
    toolchainAttestationPath,
    expectedToolchainAttestationFileSha256,
    connectorConfigPath,
    databaseUrl,
    gateId,
    requireFresh: true,
  };
}

function certificationIdentity(certification: {
  readonly active_config_sha256: string;
  readonly worker_process_instance_id: string;
  readonly ledger: { readonly epoch: string };
  readonly toolchain_attestation: { readonly raw_sha256: string };
  readonly remote: {
    readonly sdk_worker_build_hash: string;
    readonly toolchain_profile_hash: string;
  };
}) {
  return {
    sdkWorkerBuildHash: certification.remote.sdk_worker_build_hash,
    activeConfigSha256: certification.active_config_sha256,
    workerProcessInstanceId: certification.worker_process_instance_id,
    ledgerEpoch: certification.ledger.epoch,
    vivadoToolchainAttestationSha256: certification.toolchain_attestation.raw_sha256,
    toolchainProfileHash: certification.remote.toolchain_profile_hash,
  };
}

function sameCertificationIdentity(
  left: ReturnType<typeof certificationIdentity>,
  right: ReturnType<typeof certificationIdentity> | undefined,
): boolean {
  return right !== undefined
    && left.sdkWorkerBuildHash === right.sdkWorkerBuildHash
    && left.activeConfigSha256 === right.activeConfigSha256
    && left.workerProcessInstanceId === right.workerProcessInstanceId
    && left.ledgerEpoch === right.ledgerEpoch
    && left.vivadoToolchainAttestationSha256
      === right.vivadoToolchainAttestationSha256
    && left.toolchainProfileHash === right.toolchainProfileHash;
}

async function loadCertifiedCanaryBinding(
  env: Record<string, string | undefined>,
  certification: {
    readonly canary: {
      readonly project_id: string;
      readonly eval_job_id: string;
      readonly connector_job_id: string;
      readonly dispatch_request_hash: string;
      readonly binding_hash: string;
    };
  },
): Promise<CoreIssuedEvalBinding> {
  const path = requiredEnvironment(
    "SYNTHIA_M4F_CANARY_BINDING",
    env.SYNTHIA_M4F_CANARY_BINDING,
  );
  const value = JSON.parse(await readFile(path, "utf8")) as CoreIssuedEvalBinding;
  const canary = certification.canary;
  if (
    evolutionEvalCanonicalHash(value) !== canary.binding_hash
    || value.project_id !== canary.project_id
    || value.dispatch.eval_job_id !== canary.eval_job_id
    || value.dispatch.connector_job_id !== canary.connector_job_id
    || value.dispatch_request_hash !== canary.dispatch_request_hash
  ) {
    throw new Error("M4-F canary binding differs from certification");
  }
  return value;
}

function optionalBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new TypeError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
