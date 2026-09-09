#!/usr/bin/env bun
/**
 * M4-F production-chain runner for the two bounded Self-Evolution scenarios.
 *
 * This script never writes PostgreSQL directly. All scenario mutations travel
 * through the public/task/internal Core HTTP contracts and the existing Runtime
 * Distiller, Curator, EvolutionEvaluator, Core dispatcher, and Connector path.
 * PostgreSQL is used only for read-only isolation checks and the final audit.
 */

import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  gateDatabaseIdentity,
  loadEvolutionEvalNewEffectsCertification,
  type EvolutionEvalF0CertificationV2,
} from "./certify-evolution-eval-m4f.ts";
import {
  EVOLUTION_EVAL_LIMITS,
  canonicalEvolutionEvalEvidenceManifest,
  canonicalEvolutionEvalSealedInputProjection,
  canonicalEvolutionEvalWorkspaceManifest,
  evolutionEvalCanonicalHash,
  type EvolutionEvalWorkspaceManifestV1,
} from "../src/domain/evolution-eval.ts";
import {
  CoreTaskEvolutionClient,
  EvolutionClientError,
} from "../../runtime/evolution-client.ts";
import { CoreEvolutionEvalClient } from "../../runtime/evolution-eval-client.ts";
import { EvolutionEvaluator } from "../../runtime/evolution-evaluator.ts";
import {
  CoreCuratorEvolutionClient,
  CoreDistillerEvolutionClient,
} from "../../runtime/evolution-worker-client.ts";
import {
  CuratorWorker,
  DistillerWorker,
  type EvolutionJsonModel,
  type EvolutionJsonModelRequest,
} from "../../runtime/evolution-workers.ts";

export const M4F_E2E_SUMMARY_SCHEMA = "synthia-self-evolution-m4f-e2e.v1" as const;
export const M4F_E2E_EXECUTION_AUTHORIZATION = "I_AUTHORIZE_M4F_SELF_EVOLUTION_EFFECTS";
export const M4F_E2E_RUNTIME_FIXTURE_ASSERTION = "I_ASSERT_M4F_DETERMINISTIC_RUNTIME_FIXTURE";
export const M4F_E2E_SCENARIOS = ["success", "failure-quarantine"] as const;
export type M4fE2eScenario = (typeof M4F_E2E_SCENARIOS)[number];
export const M4F_E2E_DIRECT_ENDPOINT_ORIGIN = "https://100.96.223.49:18443";

const GATE_DATABASE_PREFIX = "synthia-selfevo-gate-";
const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PART = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SIDE_READ_PATHS = ["rtl/**", "tb/**", "doc/**", "prj/constr/**"] as const;
export const M4F_E2E_FAILURE_JOB_TIMEOUT_MS = 90_000;
export const M4F_E2E_SUCCESS_JOB_TIMEOUT_MS = 180_000;
export const M4F_E2E_CERTIFICATION_SAFETY_MARGIN_MS = 120_000;
const M4F_E2E_RETENTION_TIMEOUT_MS = 120_000;
const VALID_SOURCE = [
  "module top(",
  "  input  logic a,",
  "  input  logic b,",
  "  output logic y",
  ");",
  "  assign y = a ^ b;",
  "endmodule",
  "",
].join("\n");
const INVALID_SOURCE = [
  "module top(",
  "  input  logic a,",
  "  output logic y",
  ");",
  "  assign y = ; // intentional M4-F deterministic syntax failure",
  "endmodule",
  "",
].join("\n");

export interface M4fE2eConfig {
  readonly mode: "preflight" | "execute";
  readonly scenario: M4fE2eScenario;
  readonly gateId: string;
  readonly runId: string;
  /** Bound from B v2 canary.project_id after the certification is loaded. */
  readonly projectId: string | null;
  readonly databaseUrl: string;
  readonly coreBaseUrl: string;
  readonly runtimeBaseUrl: string;
  readonly targetPart: string;
  readonly jobTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly runtimeReadyTimeoutMs: number;
  readonly retentionTimeoutMs: number;
  readonly tokens: {
    readonly human: string;
    readonly taskRuntime: string;
    readonly distiller: string;
    readonly curator: string;
    readonly evaluator: string;
  };
  readonly certification: {
    readonly releaseManifestPath: string;
    readonly certificationPath: string;
    readonly certificationSha256: string;
    readonly toolchainAttestationPath: string;
    readonly toolchainAttestationSha256: string;
    readonly connectorConfigPath: string;
  } | null;
  readonly summaryOutput: string | null;
  readonly executionAuthorized: boolean;
  readonly exclusiveWorkersAsserted: boolean;
  readonly deterministicRuntimeAsserted: boolean;
}

type CertifiedM4fE2eConfig = Omit<M4fE2eConfig, "projectId"> & {
  readonly projectId: string;
};

interface TokenIdentity {
  readonly uid: string;
  readonly actorType: "human" | "service";
  readonly scopes: readonly string[];
}

interface GateIsolationSnapshot {
  readonly settings: {
    readonly learningPaused: boolean;
    readonly learnedSkillsEnabled: boolean;
  };
  readonly projectCount: number;
  readonly project: {
    readonly id: string;
    readonly projectType: string;
    readonly targetPart: string | null;
    readonly toolchainProfileRef: string | null;
    readonly status: string;
  } | null;
  readonly canaryBindingMatched: boolean;
  readonly pendingApplications: number;
  readonly openCuratorRuns: number;
  readonly openEvalRuns: number;
  readonly openDistillationRuns: number;
  readonly tokenIdentities: {
    readonly human: TokenIdentity;
    readonly taskRuntime: TokenIdentity;
    readonly distiller: TokenIdentity;
    readonly curator: TokenIdentity;
    readonly evaluator: TokenIdentity;
  };
}

export interface ScenarioApplication {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly applicationId: string;
  readonly evidenceRef: string;
  readonly resultId: string;
}

export interface ScenarioDeposition {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly resultId: string;
}

export interface ScenarioAudit {
  readonly project: Record<string, unknown>;
  readonly skill: Record<string, unknown>;
  readonly version: Record<string, unknown>;
  readonly sourceDistillation: Record<string, unknown>;
  readonly applications: readonly Record<string, unknown>[];
  readonly curatorRuns: readonly Record<string, unknown>[];
  readonly evaluations: readonly Record<string, unknown>[];
  readonly evalJobs: readonly Record<string, unknown>[];
  readonly connectorObservations: readonly Record<string, unknown>[];
  readonly evidenceFacts: readonly Record<string, unknown>[];
  readonly evidenceEntries: readonly Record<string, unknown>[];
  readonly retentionReceipts: readonly Record<string, unknown>[];
  readonly lifecycleEvents: readonly Record<string, unknown>[];
}

export interface ScenarioCertificationExpectation {
  readonly ledgerEpoch: string;
  readonly targetPart: string;
  readonly toolchainProfileHash: string;
}

export interface FailureQuarantineEffectSnapshot {
  readonly evalJobs: readonly Record<string, unknown>[];
  readonly dispatches: readonly Record<string, unknown>[];
  readonly toolRuns: readonly Record<string, unknown>[];
  readonly connectorObservations: readonly Record<string, unknown>[];
}

export interface FailureQuarantineRejection {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly message: string;
}

/**
 * Pure assertion used by the production runner and unit tests.  The database
 * snapshots contain the durable Core/Connector execution identities, not only
 * aggregate counts, so replacement or an unexpected additional submission is
 * also rejected.
 */
export function assertFailureQuarantineNegativeProof(input: {
  readonly versionId: string;
  readonly searchVersionIds: readonly string[];
  readonly rejection: FailureQuarantineRejection;
  readonly before: FailureQuarantineEffectSnapshot;
  readonly after: FailureQuarantineEffectSnapshot;
}): void {
  if (input.searchVersionIds.includes(input.versionId)) {
    throw new Error("quarantined Skill remained visible in task search");
  }
  if (
    input.rejection.code !== "conflict"
    || input.rejection.httpStatus !== 409
    || input.rejection.retryable !== false
    || input.rejection.message !== "SKILL_NOT_AVAILABLE"
  ) {
    throw new Error("quarantined Skill apply was not rejected as SKILL_NOT_AVAILABLE");
  }
  for (const field of [
    "evalJobs",
    "dispatches",
    "toolRuns",
    "connectorObservations",
  ] as const) {
    if (
      evolutionEvalCanonicalHash(input.before[field])
      !== evolutionEvalCanonicalHash(input.after[field])
    ) {
      throw new Error(`quarantine rejection created or changed ${field}`);
    }
  }
}

export interface M4fLiveCertificationProbeInput {
  readonly coreBaseUrl: string;
  readonly humanToken: string;
  readonly gateId: string;
  readonly certificationHash: string;
  readonly projectId: string;
  readonly endpointOrigin: string;
  readonly connectorId: string;
  readonly workerProcessInstanceId: string;
  readonly ledgerEpoch: string;
}

export function resolveM4fE2eConfig(
  env: Record<string, string | undefined> = process.env,
): M4fE2eConfig {
  const mode = env.SYNTHIA_M4F_E2E_MODE ?? "preflight";
  if (mode !== "preflight" && mode !== "execute") {
    throw new Error("SYNTHIA_M4F_E2E_MODE must be preflight or execute");
  }
  const scenarioRaw = env.SYNTHIA_M4F_E2E_SCENARIO ?? "success";
  if (!M4F_E2E_SCENARIOS.includes(scenarioRaw as M4fE2eScenario)) {
    throw new Error("SYNTHIA_M4F_E2E_SCENARIO must be success or failure-quarantine");
  }
  const scenario = scenarioRaw as M4fE2eScenario;
  const databaseUrl = required(env, "DATABASE_URL");
  const identity = gateDatabaseIdentity(databaseUrl);
  if (!identity.name.startsWith(GATE_DATABASE_PREFIX)) {
    throw new Error("DATABASE_URL must name a dedicated M4-F Gate database");
  }
  const gateId = opaque(required(env, "SYNTHIA_M4F_GATE_ID"), "SYNTHIA_M4F_GATE_ID");
  const runId = opaque(env.SYNTHIA_M4F_E2E_RUN_ID ?? `preflight-${gateId}`, "SYNTHIA_M4F_E2E_RUN_ID");
  const coreBaseUrl = exactLoopbackHttpOrigin(
    env.SYNTHIA_CORE_URL ?? "http://127.0.0.1:8787",
    "SYNTHIA_CORE_URL",
  );
  const runtimeBaseUrl = exactLoopbackHttpOrigin(
    env.SYNTHIA_M4F_E2E_RUNTIME_URL ?? "http://127.0.0.1:8790",
    "SYNTHIA_M4F_E2E_RUNTIME_URL",
  );
  const targetPart = env.SYNTHIA_M4F_E2E_TARGET_PART ?? "xc7k70tfbv676-1";
  if (!PART.test(targetPart)) throw new Error("SYNTHIA_M4F_E2E_TARGET_PART is invalid");
  const certificationValues = [
    env.SYNTHIA_M4F_RELEASE_MANIFEST,
    env.SYNTHIA_M4F_F0_CERTIFICATION,
    env.SYNTHIA_M4F_F0_CERTIFICATION_SHA256,
    env.SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION,
    env.SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256,
    env.SYNTHIA_CONNECTOR_CONFIG,
  ];
  const hasSomeCertification = certificationValues.some(Boolean);
  const hasAllCertification = certificationValues.every(Boolean);
  if (hasSomeCertification && !hasAllCertification) {
    throw new Error("the M4-F B v2 deployment inputs must be supplied as one complete set");
  }
  const certification = hasAllCertification ? {
    releaseManifestPath: certificationValues[0]!,
    certificationPath: certificationValues[1]!,
    certificationSha256: sha256(certificationValues[2]!, "SYNTHIA_M4F_F0_CERTIFICATION_SHA256"),
    toolchainAttestationPath: certificationValues[3]!,
    toolchainAttestationSha256: sha256(
      certificationValues[4]!,
      "SYNTHIA_M4F_VIVADO_TOOLCHAIN_ATTESTATION_SHA256",
    ),
    connectorConfigPath: certificationValues[5]!,
  } : null;
  const requestedJobTimeout = env.SYNTHIA_M4F_E2E_JOB_TIMEOUT_MS;
  if (
    scenario === "failure-quarantine"
    && requestedJobTimeout !== undefined
    && Number(requestedJobTimeout) !== M4F_E2E_FAILURE_JOB_TIMEOUT_MS
  ) {
    throw new Error(
      `failure-quarantine fixes SYNTHIA_M4F_E2E_JOB_TIMEOUT_MS=${M4F_E2E_FAILURE_JOB_TIMEOUT_MS}`,
    );
  }
  return {
    mode,
    scenario,
    gateId,
    runId,
    projectId: null,
    databaseUrl,
    coreBaseUrl,
    runtimeBaseUrl,
    targetPart,
    jobTimeoutMs: scenario === "failure-quarantine"
      ? M4F_E2E_FAILURE_JOB_TIMEOUT_MS
      : boundedInteger(
          requestedJobTimeout,
          M4F_E2E_SUCCESS_JOB_TIMEOUT_MS,
          10_000,
          7_200_000,
        ),
    pollIntervalMs: boundedInteger(env.SYNTHIA_M4F_E2E_POLL_INTERVAL_MS, 1_000, 10, 60_000),
    runtimeReadyTimeoutMs: boundedInteger(
      env.SYNTHIA_M4F_E2E_RUNTIME_READY_TIMEOUT_MS,
      30_000,
      1_000,
      300_000,
    ),
    retentionTimeoutMs: boundedInteger(
      env.SYNTHIA_M4F_E2E_RETENTION_TIMEOUT_MS,
      M4F_E2E_RETENTION_TIMEOUT_MS,
      10_000,
      600_000,
    ),
    tokens: {
      human: required(env, "SYNTHIA_M4F_E2E_HUMAN_TOKEN"),
      taskRuntime: required(env, "SYNTHIA_TASK_RUNTIME_TOKEN"),
      distiller: required(env, "SYNTHIA_EVOLUTION_DISTILLER_TOKEN"),
      curator: required(env, "SYNTHIA_EVOLUTION_CURATOR_TOKEN"),
      evaluator: required(env, "SYNTHIA_EVOLUTION_EVALUATOR_TOKEN"),
    },
    certification,
    summaryOutput: env.SYNTHIA_M4F_E2E_SUMMARY_OUTPUT ?? null,
    executionAuthorized:
      env.SYNTHIA_M4F_E2E_EFFECTS_AUTHORIZATION === M4F_E2E_EXECUTION_AUTHORIZATION,
    exclusiveWorkersAsserted: env.SYNTHIA_M4F_E2E_EXCLUSIVE_WORKERS === "1",
    deterministicRuntimeAsserted:
      env.SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME === M4F_E2E_RUNTIME_FIXTURE_ASSERTION,
  };
}

export function assertM4fE2eExecutionAuthorized(config: M4fE2eConfig): void {
  if (config.mode !== "execute") throw new Error("M4-F E2E runner is not in execute mode");
  if (!config.executionAuthorized) {
    throw new Error(`SYNTHIA_M4F_E2E_EFFECTS_AUTHORIZATION must equal ${M4F_E2E_EXECUTION_AUTHORIZATION}`);
  }
  if (!config.exclusiveWorkersAsserted) {
    throw new Error("SYNTHIA_M4F_E2E_EXCLUSIVE_WORKERS=1 is required");
  }
  if (!config.deterministicRuntimeAsserted) {
    throw new Error(
      `SYNTHIA_M4F_E2E_DETERMINISTIC_RUNTIME must equal ${M4F_E2E_RUNTIME_FIXTURE_ASSERTION}`,
    );
  }
  if (config.certification === null) throw new Error("a complete, fresh M4-F B v2 set is required");
  if (config.summaryOutput === null) throw new Error("SYNTHIA_M4F_E2E_SUMMARY_OUTPUT is required");
  assertOutsideRepository(config.summaryOutput, resolve(import.meta.dir, "../.."));
}

export class M4fScenarioModel implements EvolutionJsonModel {
  readonly modelId = "m4f-deterministic-e2e-fixture.v1";
  private depositTaskId: string | null = null;

  constructor(
    readonly scenario: M4fE2eScenario,
    readonly runId: string,
    readonly part: string,
  ) {}

  /** Pin the deposit side task so only its episode distills into a Skill. */
  pinDepositTask(taskId: string): void {
    this.depositTaskId = taskId;
  }

  async generateJson(request: EvolutionJsonModelRequest, _signal?: AbortSignal): Promise<unknown> {
    if (request.purpose === "distillation") {
      const input = JSON.parse(request.userPrompt) as {
        episode?: { task_ref?: string };
        trajectory?: { objective?: string };
        existing_skills?: unknown[];
      };
      // Only the deposit side task (which carries the reusable synthesis
      // diagnosis) distills into a Skill; the main task acknowledgement and
      // any application episodes return no_op.
      const objective = input.trajectory?.objective ?? "";
      if (!objective.includes("synthesis diagnosis")) {
        return { action: "no_op" };
      }
      return this.distillationDecision(input.existing_skills ?? []);
    }
    return this.curatorDecision(JSON.parse(request.userPrompt) as Record<string, unknown>);
  }

  private distillationDecision(existingSkills: readonly unknown[] = []): Record<string, unknown> {
    const skillSlug = `m4f-${slug(this.runId)}-synthesis-recovery`;
    // The deterministic scenario creates the Skill from the first deposit
    // episode it processes; any later auto-enqueued episode (the main task
    // acknowledgement, application tasks) returns no_op instead of failing
    // on a duplicate create.
    const alreadyCreated = existingSkills.length > 0;
    if (alreadyCreated) {
      return { action: "no_op" };
    }
    return {
      action: "create",
      skill: {
        slug: skillSlug,
        name: `M4-F synthesis recovery ${this.runId}`,
        summary: "Reuse a bounded, typed Vivado synthesis diagnosis on the same FPGA failure family.",
        description: "Inspect the sealed source snapshot, select a typed validation or synthesis operation, and use frozen evidence to decide whether the method worked.",
        applicability: {
          summary: "Vivado HDL validation and synthesis failures on the certified target part",
          target_part: this.part,
        },
        outcome_contract: {
          expected: "The selected typed Vivado operation reaches a frozen, attributable terminal result.",
        },
        files: [{
          path: "SKILL.md",
          kind: "skill_md",
          language: null,
          content: [
            `# M4-F synthesis recovery ${this.runId}`,
            "",
            "Use only typed, governed FPGA operations on the isolated evaluation copy.",
            "Confirm the target part and source paths before synthesis.",
            "Treat frozen Vivado evidence as authoritative; never request hardware download.",
            "",
          ].join("\n"),
        }],
      },
    };
  }

  private curatorDecision(input: Record<string, unknown>): Record<string, unknown> {
    const allowed = stringArray(input.allowed_actions, "allowed_actions");
    const applications = objectArray(input.applications, "applications");
    const recovery = object(input.eval_recovery, "eval_recovery");
    const jobs = objectArray(recovery.jobs, "eval_recovery.jobs");
    if (allowed.includes("run_eval")) {
      const evaluated = new Set(jobs.map((job) => String(job.application_id)));
      const next = applications.find((application) => {
        const detail = object(application.application, "application.application");
        return !evaluated.has(String(detail.application_id));
      });
      if (next) {
        const detail = object(next.application, "application.application");
        return {
          action: "run_eval",
          application_id: String(detail.application_id),
          operation: "synthesize",
          parameters: {
            operation: "synthesize",
            source_paths: ["rtl/top.sv"],
            top: "top",
            part: this.part,
          },
          timeout_ms: 600_000,
          workspace_changes: [],
        };
      }
    }
    const expectedJobState = this.scenario === "success" ? "succeeded" : "failed";
    const jobsByApplication = new Map<string, Record<string, unknown>[]>();
    for (const job of jobs) {
      const applicationId = String(job.application_id);
      const existing = jobsByApplication.get(applicationId) ?? [];
      existing.push(job);
      jobsByApplication.set(applicationId, existing);
    }
    const applicationIds = applications.map((application) => {
      const detail = object(application.application, "application.application");
      return String(detail.application_id);
    });
    if (
      jobs.length !== applicationIds.length
      || jobsByApplication.size !== applicationIds.length
      || [...jobsByApplication.keys()].some((applicationId) => !applicationIds.includes(applicationId))
    ) {
      throw new Error("M4-F finalize requires one closed-set eval job per application");
    }
    for (const applicationId of applicationIds) {
      const applicationJobs = jobsByApplication.get(applicationId) ?? [];
      const job = applicationJobs[0];
      if (
        applicationJobs.length !== 1
        || job === undefined
        || job.operation !== "synthesize"
        || job.state !== expectedJobState
        || job.workspace_sealed !== true
        || job.evidence_state !== "frozen"
        || typeof job.evidence_manifest_hash !== "string"
        || !HASH.test(job.evidence_manifest_hash)
        || job.reconciliation_state === "required"
      ) {
        throw new Error("M4-F finalize requires one matching frozen synthesis result per application");
      }
    }
    const skills = new Set<string>();
    const evaluations = applications.map((application) => {
      const detail = object(application.application, "application.application");
      const applicationId = String(detail.application_id);
      const job = jobsByApplication.get(applicationId)![0]!;
      const outcome = job.state === "succeeded" ? "success" : "execution_failure";
      const primary = object(application.primary_version, "application.primary_version");
      const skill = object(primary.skill, "application.primary_version.skill");
      skills.add(String(skill.skill_id));
      const evidence = objectArray(application.evidence, "application.evidence");
      if (evidence.length === 0) throw new Error("M4-F application has no attributable evidence ref");
      return {
        application_id: applicationId,
        outcome,
        confidence: 0.99,
        reason: outcome === "success"
          ? "The certified Vivado synthesis job succeeded and its evidence was frozen."
          : "The certified Vivado synthesis job reproduced the deterministic HDL failure and froze attributable evidence.",
        evidence_refs: [String(evidence[0]!.id)],
        supersedes_id: null,
      };
    });
    return {
      action: "finalize",
      evaluations,
      remediations: [...skills].map((skillId) => ({ skill_id: skillId, action: "no_op" })),
    };
  }
}

class CoreGateHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly humanToken: string,
    private readonly taskRuntimeToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  human(path: string, method = "GET", body?: unknown, key?: string): Promise<Record<string, unknown>> {
    return this.request(path, method, this.humanToken, body, key, {});
  }

  task(
    path: string,
    taskId: string,
    workspaceId: string | null,
    method = "GET",
    body?: unknown,
    key?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(path, method, this.taskRuntimeToken, body, key, {
      "X-Synthia-Task-Id": taskId,
      ...(workspaceId === null ? {} : { "X-Synthia-Workspace-Id": workspaceId }),
    });
  }

  private async request(
    path: string,
    method: string,
    token: string,
    body: unknown,
    key: string | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (key !== undefined) headers["Idempotency-Key"] = key;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let envelope: Record<string, unknown>;
    try {
      envelope = object(text ? JSON.parse(text) : {}, "Core response");
    } catch {
      throw new Error(`Core returned non-JSON for ${method} ${path}`);
    }
    if (!response.ok) {
      const error = envelope.error && typeof envelope.error === "object"
        ? envelope.error as Record<string, unknown>
        : {};
      throw new Error(`${method} ${path} failed: ${String(error.code ?? response.status)}`);
    }
    return object(envelope.data, "Core response.data");
  }
}

/**
 * Keep the fresh remote proof and the first business mutation in one ordered
 * function so callers cannot accidentally start the scenario after merely
 * reading the static Core readiness snapshot.
 */
export async function executeM4fEffectsAfterLiveCertification<T>(
  input: M4fLiveCertificationProbeInput,
  fetchImpl: typeof fetch,
  effects: () => Promise<T>,
): Promise<{ readonly liveCertification: Record<string, unknown>; readonly result: T }> {
  const core = new CoreGateHttpClient(
    input.coreBaseUrl,
    input.humanToken,
    input.humanToken,
    fetchImpl,
  );
  const liveCertification = await core.human(
    "/api/v1/evolution/m4f-live-certification",
    "POST",
    {
      schema: "synthia-m4f-live-certification-probe.v1",
      gate_id: input.gateId,
      certification_hash: input.certificationHash,
      project_id: input.projectId,
      ledger_epoch: input.ledgerEpoch,
    },
  );
  if (
    liveCertification.schema !== "synthia-m4f-live-certification.v1"
    || liveCertification.fresh !== true
    || liveCertification.gate_id !== input.gateId
    || liveCertification.certification_hash !== input.certificationHash
    || liveCertification.project_id !== input.projectId
    || liveCertification.endpoint_origin !== input.endpointOrigin
    || liveCertification.connector_id !== input.connectorId
    || liveCertification.worker_process_instance_id !== input.workerProcessInstanceId
    || liveCertification.ledger_epoch !== input.ledgerEpoch
    || !validIsoTimestamp(liveCertification.checked_at)
  ) {
    throw new Error("Core live certification response does not match the frozen M4-F identity");
  }
  return { liveCertification, result: await effects() };
}

export async function runM4fE2e(
  config: M4fE2eConfig,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const certification = config.certification === null
      ? null
      : await loadCertification(config);
    if (certification === null) {
      throw new Error("a complete, fresh M4-F B v2 set is required for preflight and execute");
    }
    const certifiedConfig: CertifiedM4fE2eConfig = {
      ...config,
      projectId: certification.canary.project_id,
    };
    assertCertificationBudget(certifiedConfig, certification);
    const isolation = await readGateIsolation(pool, certifiedConfig, certification);
    assertReadyForEffects(certifiedConfig, isolation, certification);
    const services = await probeM4fServices(
      certifiedConfig,
      certification,
      options.fetchImpl ?? fetch,
    );
    const preflight = {
      schema: M4F_E2E_SUMMARY_SCHEMA,
      mode: "preflight",
      remote_called: false,
      gate_id: certifiedConfig.gateId,
      run_id: certifiedConfig.runId,
      scenario: certifiedConfig.scenario,
      project_id: certifiedConfig.projectId,
      database_identity_hash: gateDatabaseIdentity(certifiedConfig.databaseUrl).identity_hash,
      core_url: certifiedConfig.coreBaseUrl,
      runtime_url: certifiedConfig.runtimeBaseUrl,
      target_part: certifiedConfig.targetPart,
      certification_loaded: true,
      certification_hash: certification.certification_hash,
      certification_expires_at: certification.expires_at,
      endpoint_origin: certification.endpoint.origin,
      certification_required_remaining_ms: requiredCertificationRemainingMs(certifiedConfig),
      ledger_epoch: certification.ledger.epoch,
      isolation,
      services,
      execution_authorized: certifiedConfig.executionAuthorized,
      exclusive_workers_asserted: certifiedConfig.exclusiveWorkersAsserted,
      deterministic_runtime_asserted: certifiedConfig.deterministicRuntimeAsserted,
    };
    if (certifiedConfig.mode === "preflight") return preflight;
    assertM4fE2eExecutionAuthorized(certifiedConfig);
    // The service probes and DB checks above are intentionally repeated by an
    // execute invocation before its first mutation.  A prior preflight summary
    // is evidence, not reusable authority.
    assertCertificationBudget(certifiedConfig, certification);
    const fetchImpl = options.fetchImpl ?? fetch;
    const effectRun = await executeM4fEffectsAfterLiveCertification(
      {
        coreBaseUrl: certifiedConfig.coreBaseUrl,
        humanToken: certifiedConfig.tokens.human,
        gateId: certifiedConfig.gateId,
        certificationHash: certification.certification_hash,
        projectId: certifiedConfig.projectId,
        endpointOrigin: certification.endpoint.origin,
        connectorId: certification.endpoint.connector_id,
        workerProcessInstanceId: certification.worker_process_instance_id,
        ledgerEpoch: certification.ledger.epoch,
      },
      fetchImpl,
      () => executeScenario(
        pool,
        certifiedConfig,
        certification,
        isolation.tokenIdentities,
        fetchImpl,
      ),
    );
    const executed = {
      ...effectRun.result,
      services,
      live_certification: effectRun.liveCertification,
    };
    const bytes = Buffer.from(`${JSON.stringify(executed)}\n`, "utf8");
    await writeExclusiveDurable(certifiedConfig.summaryOutput!, bytes);
    return executed;
  } finally {
    await pool.end();
  }
}

async function loadCertification(config: M4fE2eConfig): Promise<EvolutionEvalF0CertificationV2> {
  const source = config.certification!;
  const loaded = await loadEvolutionEvalNewEffectsCertification({
    releaseManifestPath: source.releaseManifestPath,
    certificationPath: source.certificationPath,
    expectedCertificationFileSha256: source.certificationSha256,
    toolchainAttestationPath: source.toolchainAttestationPath,
    expectedToolchainAttestationFileSha256: source.toolchainAttestationSha256,
    connectorConfigPath: source.connectorConfigPath,
    databaseUrl: config.databaseUrl,
    gateId: config.gateId,
    requireFresh: true,
  });
  return loaded.certification;
}

function assertReadyForEffects(
  config: CertifiedM4fE2eConfig,
  isolation: GateIsolationSnapshot,
  certification: EvolutionEvalF0CertificationV2,
): void {
  if (isolation.settings.learningPaused || !isolation.settings.learnedSkillsEnabled) {
    throw new Error("Self-Evolution must be enabled and unpaused");
  }
  if (
    isolation.projectCount !== 1
    || isolation.project === null
    || isolation.project.id !== config.projectId
    || isolation.project.projectType !== "free"
    || isolation.project.targetPart !== config.targetPart
    || isolation.project.toolchainProfileRef !== certification.remote.toolchain_profile_hash
    || isolation.project.status !== "active"
    || !isolation.canaryBindingMatched
    || isolation.pendingApplications !== 0
    || isolation.openCuratorRuns !== 0
    || isolation.openEvalRuns !== 0
    || isolation.openDistillationRuns !== 0
  ) {
    throw new Error("dedicated Gate database is not isolated for this run id");
  }
  if (
    certification.database.identity_hash !== gateDatabaseIdentity(config.databaseUrl).identity_hash
    || certification.gate_id !== config.gateId
    || certification.remote.part !== config.targetPart
    || certification.endpoint.origin !== M4F_E2E_DIRECT_ENDPOINT_ORIGIN
  ) {
    throw new Error("M4-F B v2 identity does not match the requested scenario");
  }
}

export function requiredCertificationRemainingMs(
  config: Pick<
    CertifiedM4fE2eConfig,
    "scenario" | "jobTimeoutMs" | "runtimeReadyTimeoutMs"
  >,
): number {
  const serialJobs = config.scenario === "success" ? 1 : 3;
  return serialJobs * config.jobTimeoutMs
    + config.runtimeReadyTimeoutMs
    + M4F_E2E_CERTIFICATION_SAFETY_MARGIN_MS;
}

export function assertCertificationBudget(
  config: Pick<
    CertifiedM4fE2eConfig,
    "scenario" | "jobTimeoutMs" | "runtimeReadyTimeoutMs"
  >,
  certification: Pick<EvolutionEvalF0CertificationV2, "expires_at">,
  nowMs = Date.now(),
): void {
  const remaining = Date.parse(certification.expires_at) - nowMs;
  const requiredRemaining = requiredCertificationRemainingMs(config);
  if (!Number.isFinite(remaining) || remaining <= requiredRemaining) {
    throw new Error(
      `F0 certification has ${Math.max(0, remaining)}ms remaining; `
      + `${requiredRemaining}ms is required for the serial M4-F scenario`,
    );
  }
}

interface M4fServiceProbeInput {
  readonly overview: Record<string, unknown>;
  readonly coreReadiness: Record<string, unknown>;
  readonly project: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
  readonly connectorConfig: Record<string, unknown>;
}

export function assertM4fServiceReadiness(
  config: Pick<CertifiedM4fE2eConfig, "gateId" | "projectId" | "targetPart">,
  certification: EvolutionEvalF0CertificationV2,
  input: M4fServiceProbeInput,
): Record<string, unknown> {
  const readinessCertification = object(
    input.coreReadiness.certification,
    "Core M4-F readiness certification",
  );
  const runtimeAgents = input.runtime.agents;
  const projectScope = input.connectorConfig.project_scope;
  if (certification.endpoint.origin !== M4F_E2E_DIRECT_ENDPOINT_ORIGIN) {
    throw new Error("M4-F B v2 is not bound to the authorized 18443 direct-mTLS origin");
  }
  if (
    input.overview.schema !== "evolution-overview.v1"
    || input.overview.rollout_enabled !== true
    || input.overview.learning_paused !== false
    || input.overview.learned_skills_enabled !== true
  ) {
    throw new Error("Core Self-Evolution overview is not enabled and unpaused");
  }
  if (
    input.coreReadiness.schema !== "synthia-m4f-core-readiness.v1"
    || input.coreReadiness.ready !== true
    || input.coreReadiness.dispatcher_host_enabled !== true
    || input.coreReadiness.new_effects_enabled !== true
    || input.coreReadiness.rollout_enabled !== true
    || input.coreReadiness.connector_configured !== true
    || readinessCertification.gate_id !== config.gateId
    || readinessCertification.certification_hash !== certification.certification_hash
    || readinessCertification.expires_at !== certification.expires_at
    || readinessCertification.endpoint_origin !== certification.endpoint.origin
    || readinessCertification.project_id !== config.projectId
    || readinessCertification.connector_id !== certification.endpoint.connector_id
    || readinessCertification.worker_process_instance_id
      !== certification.worker_process_instance_id
    || readinessCertification.ledger_epoch !== certification.ledger.epoch
    || readinessCertification.active_config_sha256 !== certification.active_config_sha256
  ) {
    throw new Error("Core did not load the exact effective M4-F B v2/new-effects identity");
  }
  if (
    input.project.id !== config.projectId
    || input.project.project_type !== "free"
    || input.project.target_part !== config.targetPart
    || input.project.toolchain_profile_ref !== certification.remote.toolchain_profile_hash
    || input.project.status !== "active"
  ) {
    throw new Error("Core canary project does not match the certified M4-F project");
  }
  if (!Array.isArray(runtimeAgents) || runtimeAgents.length !== 0) {
    throw new Error("deterministic M4-F Runtime is unavailable or its fresh runs directory is not empty");
  }
  if (
    !Array.isArray(projectScope)
    || projectScope.length !== 1
    || projectScope[0] !== config.projectId
    || input.connectorConfig.connector_id !== certification.endpoint.connector_id
    || input.connectorConfig.transport_mode !== "direct_https"
    || input.connectorConfig.auth_mode !== "mtls"
    || input.connectorConfig.tls_trust_ref !== "cert://m4f-direct/trust"
    || input.connectorConfig.tls_client_cert_ref !== "cert://m4f-direct/client"
    || input.connectorConfig.evolution_eval_enabled !== true
    || input.connectorConfig.evolution_eval_ledger_mode !== "reopen"
    || input.connectorConfig.evolution_eval_ledger_epoch !== certification.ledger.epoch
    || input.connectorConfig.toolchain_profile_hash
      !== certification.remote.toolchain_profile_hash
    || input.connectorConfig.vivado_part !== config.targetPart
    || input.connectorConfig.vivado_toolchain_attestation_sha256
      !== certification.toolchain_attestation.raw_sha256
  ) {
    throw new Error("Connector config is not the exact single certified canary project scope");
  }
  return {
    core_ready: true,
    runtime_ready: true,
    connector_ready: true,
    effective_new_effects: true,
    certification_hash: certification.certification_hash,
    endpoint_origin: certification.endpoint.origin,
    project_scope: [config.projectId],
  };
}

async function probeM4fServices(
  config: CertifiedM4fE2eConfig,
  certification: EvolutionEvalF0CertificationV2,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const core = new CoreGateHttpClient(
    config.coreBaseUrl,
    config.tokens.human,
    config.tokens.taskRuntime,
    fetchImpl,
  );
  const [overview, coreReadiness, project, runtime, connectorConfigBytes] = await Promise.all([
    core.human("/api/v1/evolution/overview"),
    core.human("/api/v1/evolution/m4f-readiness"),
    core.human(`/api/v1/projects/${encodeURIComponent(config.projectId)}`),
    fetchRuntimeSnapshot(config, fetchImpl),
    readFile(config.certification!.connectorConfigPath),
  ]);
  let connectorConfig: Record<string, unknown>;
  try {
    connectorConfig = object(
      JSON.parse(connectorConfigBytes.toString("utf8")),
      "Connector config",
    );
  } catch {
    throw new Error("Connector config is not valid JSON");
  }
  return assertM4fServiceReadiness(config, certification, {
    overview,
    coreReadiness,
    project,
    runtime,
    connectorConfig,
  });
}

async function fetchRuntimeSnapshot(
  config: Pick<CertifiedM4fE2eConfig, "runtimeBaseUrl" | "runtimeReadyTimeoutMs">,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${config.runtimeBaseUrl}/tasks`, {
    method: "GET",
    signal: AbortSignal.timeout(config.runtimeReadyTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`M4-F Runtime readiness failed: HTTP ${response.status}`);
  }
  try {
    return object(await response.json(), "M4-F Runtime readiness");
  } catch {
    throw new Error("M4-F Runtime readiness returned non-JSON");
  }
}

async function executeScenario(
  pool: Pool,
  config: CertifiedM4fE2eConfig,
  certification: EvolutionEvalF0CertificationV2,
  identities: GateIsolationSnapshot["tokenIdentities"],
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const core = new CoreGateHttpClient(
    config.coreBaseUrl,
    config.tokens.human,
    config.tokens.taskRuntime,
    fetchImpl,
  );
  // B v2 already certifies this exact Gate project.  Reusing it keeps the
  // Connector project_scope singular and prevents the certification canary
  // and the real scenario from silently crossing project authorities.
  for (const [role, identity] of [
    ["evolution-curator", identities.curator],
    ["evolution-evaluator", identities.evaluator],
  ] as const) {
    await core.human(`/api/v1/projects/${encodeURIComponent(config.projectId)}/role-assignments`, "POST", {
      id: `role-${slug(config.runId)}-${role}`,
      actor_type: "service",
      actor_id: identity.uid,
      role,
      permissions: {},
    }, key(config.runId, `role-${role}`));
  }
  const main = await core.human(`/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks`, "POST", {
    task: "M4-F deterministic fixture: acknowledge readiness without calling tools.",
  }, key(config.runId, "main-task"));
  const mainTaskId = text(main.task_id ?? main.agentId ?? main.agent_id, "main task id");
  await waitForTaskReady(core, config, mainTaskId);
  const treeBefore = await core.human(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/workspace/tree`,
  );
  const projectCommitBefore = text(treeBefore.head_commit ?? treeBefore.commit, "project workspace commit");

  const deposition = await createAndFinalizeSideTask(core, config, {
    mainTaskId,
    baseCommit: projectCommitBefore,
    label: "deposit",
    objective: "Resolve a reusable Vivado synthesis diagnosis and record the bounded method.",
    source: VALID_SOURCE,
  });
  const model = new M4fScenarioModel(config.scenario, config.runId, config.targetPart);
  const distiller = new DistillerWorker(new CoreDistillerEvolutionClient({
    baseUrl: config.coreBaseUrl,
    distillerToken: config.tokens.distiller,
    fetchImpl,
    requestTimeoutMs: 120_000,
  }), model, {
    workerId: `m4f-distiller-${slug(config.runId)}`,
    leaseSeconds: 300,
  });
  // Auto-enqueued episodes for the main task return no_op; keep claiming
  // until the deposit episode produces the Skill version.
  let versionId: string | null = null;
  for (let attempt = 0; attempt < 6 && versionId === null; attempt += 1) {
    const distilled = await distiller.runOnce();
    if (distilled.state === "completed" && distilled.result.version_id) {
      versionId = String(distilled.result.version_id);
    }
  }
  if (versionId === null) {
    throw new Error("M4-F Distiller did not create an active Skill version");
  }
  const applicationCount = config.scenario === "success" ? 1 : 3;
  const applications: ScenarioApplication[] = [];
  for (let index = 1; index <= applicationCount; index += 1) {
    applications.push(await createApplicationTask(core, config, {
      mainTaskId,
      baseCommit: projectCommitBefore,
      versionId,
      index,
      source: config.scenario === "success" ? VALID_SOURCE : INVALID_SOURCE,
    }));
  }
  await core.human("/api/v1/evolution/curator-runs", "POST", {
    mode: "run",
    reason: `M4-F ${config.scenario} production-chain evaluation`,
    manual_key: `m4f-e2e-${config.runId}`,
  }, key(config.runId, "curator-run"));

  const curatorClient = new CoreCuratorEvolutionClient({
    baseUrl: config.coreBaseUrl,
    curatorToken: config.tokens.curator,
    fetchImpl,
    requestTimeoutMs: 120_000,
  });
  const evaluator = new EvolutionEvaluator(new CoreEvolutionEvalClient({
    baseUrl: config.coreBaseUrl,
    evaluatorToken: config.tokens.evaluator,
    fetchImpl,
    requestTimeoutMs: 120_000,
  }), new JobTimeoutModel(model, config.jobTimeoutMs), {
    pollIntervalMs: config.pollIntervalMs,
  });
  const curator = new CuratorWorker({
    claim: (request, signal) => curatorClient.claimManual(request, signal),
    renewLease: (runId, request, signal) => curatorClient.renewLease(runId, request, signal),
    complete: (runId, request, signal) => curatorClient.complete(runId, request, signal),
    fail: (runId, request, signal) => curatorClient.fail(runId, request, signal),
  }, model, {
    workerId: `m4f-curator-${slug(config.runId)}`,
    leaseSeconds: 900,
    evaluator,
  });
  const curated = await curator.runOnce();
  if (curated.state !== "completed") throw new Error("M4-F Curator did not complete");
  await waitForRetentionConvergence(pool, config, versionId);
  const treeAfter = await core.human(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/workspace/tree`,
  );
  const projectCommitAfter = text(treeAfter.head_commit ?? treeAfter.commit, "project workspace commit");
  if (projectCommitAfter !== projectCommitBefore) {
    throw new Error("isolated Self-Evolution evaluation modified the project workspace");
  }
  const audit = await readScenarioAudit(pool, config.projectId, versionId);
  const expectedQuality = config.scenario === "success" ? "active_observed" : "quarantined";
  assertScenarioAudit(
    audit,
    config.scenario,
    deposition,
    applications,
    curated.runId,
    {
      ledgerEpoch: certification.ledger.epoch,
      targetPart: certification.remote.part,
      toolchainProfileHash: certification.remote.toolchain_profile_hash,
    },
  );
  const quarantineNegativeProof = config.scenario === "failure-quarantine"
    ? await verifyFailureQuarantineIsolation({
        pool,
        core,
        config,
        mainTaskId,
        baseCommit: projectCommitBefore,
        versionId,
      })
    : null;
  return {
    schema: M4F_E2E_SUMMARY_SCHEMA,
    mode: "executed",
    gate_id: config.gateId,
    run_id: config.runId,
    scenario: config.scenario,
    project_id: config.projectId,
    database_identity_hash: certification.database.identity_hash,
    certification_hash: certification.certification_hash,
    worker_process_instance_id: certification.worker_process_instance_id,
    ledger_epoch: certification.ledger.epoch,
    connector_id: certification.endpoint.connector_id,
    project_commit_before: projectCommitBefore,
    project_commit_after: projectCommitAfter,
    project_unchanged: true,
    deposition_task_id: deposition.taskId,
    deposition_result_id: deposition.resultId,
    distilled_version_id: versionId,
    application_ids: applications.map((application) => application.applicationId),
    curator_run_id: curated.runId,
    curator_result: curated.result,
    expected_quality_state: expectedQuality,
    quarantine_negative_proof: quarantineNegativeProof,
    audit,
  };
}

async function verifyFailureQuarantineIsolation(input: {
  readonly pool: Pool;
  readonly core: CoreGateHttpClient;
  readonly config: CertifiedM4fE2eConfig;
  readonly mainTaskId: string;
  readonly baseCommit: string;
  readonly versionId: string;
}): Promise<Record<string, unknown>> {
  const before = await readFailureQuarantineEffectSnapshot(
    input.pool,
    input.config.projectId,
  );
  const task = await input.core.human(
    `/api/v1/projects/${encodeURIComponent(input.config.projectId)}/tasks`,
    "POST",
    {
      kind: "side",
      parent_task_id: input.mainTaskId,
      objective: "Verify that the quarantined M4-F Skill cannot be discovered or applied.",
      base_commit: input.baseCommit,
      authorization_scope: sideScope(["rtl/top.sv"]),
    },
    key(input.config.runId, "side-quarantine-negative"),
  );
  const taskId = text(task.task_id, "quarantine negative task id");
  const workspaceId = text(task.workspace_id, "quarantine negative workspace id");
  await waitForTaskReady(input.core, input.config, taskId);
  const evolution = new CoreTaskEvolutionClient({
    baseUrl: input.config.coreBaseUrl,
    token: input.config.tokens.taskRuntime,
    projectId: input.config.projectId,
    taskId,
  });
  const search = await evolution.search(
    `M4-F synthesis recovery ${input.config.runId}`,
    10,
  );
  const applyCallId = `apply-${slug(input.config.runId)}-quarantine-negative`;
  const localGoal = "Attempt to reuse the quarantined method; Core must reject this binding";
  await appendEvent(
    input.core,
    input.config,
    taskId,
    workspaceId,
    "quarantine-negative-apply",
    "tool_call",
    {
      tool_call_id: applyCallId,
      name: "learned_skill_apply",
      args: {
        version_id: input.versionId,
        local_goal: localGoal,
        reason_codes: ["m4f_e2e_quarantine_negative_probe"],
        role: "primary",
      },
    },
  );
  let rejection: FailureQuarantineRejection | null = null;
  try {
    await evolution.createApplication({
      toolCallId: applyCallId,
      turnId: null,
      versionId: input.versionId,
      localGoal,
      reasonCodes: ["m4f_e2e_quarantine_negative_probe"],
      idempotencyKey: key(input.config.runId, "quarantine-negative-create"),
    });
  } catch (error) {
    if (error instanceof EvolutionClientError) {
      rejection = {
        code: error.code,
        httpStatus: error.httpStatus,
        retryable: error.retryable,
        message: error.message,
      };
    } else {
      throw error;
    }
  }
  if (rejection === null) {
    throw new Error("quarantined Skill application unexpectedly succeeded");
  }
  const after = await readFailureQuarantineEffectSnapshot(
    input.pool,
    input.config.projectId,
  );
  const searchVersionIds = search.items.map((item) => item.versionId);
  assertFailureQuarantineNegativeProof({
    versionId: input.versionId,
    searchVersionIds,
    rejection,
    before,
    after,
  });
  return {
    schema: "synthia-self-evolution-m4f-quarantine-negative-proof.v1",
    task_id: taskId,
    workspace_id: workspaceId,
    search_absent: true,
    apply_rejected: true,
    rejection,
    eval_job_count_before: before.evalJobs.length,
    eval_job_count_after: after.evalJobs.length,
    dispatch_count_before: before.dispatches.length,
    dispatch_count_after: after.dispatches.length,
    tool_run_count_before: before.toolRuns.length,
    tool_run_count_after: after.toolRuns.length,
    connector_observation_count_before: before.connectorObservations.length,
    connector_observation_count_after: after.connectorObservations.length,
    effect_snapshot_hash_before: evolutionEvalCanonicalHash(before),
    effect_snapshot_hash_after: evolutionEvalCanonicalHash(after),
    zero_new_eval_jobs: true,
    zero_new_vivado_tool_runs: true,
    zero_new_connector_observations: true,
  };
}

export function assertScenarioAudit(
  audit: ScenarioAudit,
  scenario: M4fE2eScenario,
  expectedDeposition: ScenarioDeposition,
  expectedApplications: readonly ScenarioApplication[],
  expectedCuratorRunId: string,
  certification: ScenarioCertificationExpectation,
): void {
  const expectedQuality = scenario === "success" ? "active_observed" : "quarantined";
  const expectedOutcome = scenario === "success" ? "success" : "execution_failure";
  const expectedToolState = scenario === "success" ? "succeeded" : "failed";
  const expectedCount = scenario === "success" ? 1 : 3;
  const expectedApplicationIds = expectedApplications.map((application) => application.applicationId);
  const expectedTaskIds = expectedApplications.map((application) => application.taskId);
  const expectedWorkspaceIds = expectedApplications.map((application) => application.workspaceId);
  const expectedResultIds = expectedApplications.map((application) => application.resultId);
  if (
    expectedApplications.length !== expectedCount
    || new Set(expectedApplicationIds).size !== expectedCount
    || new Set(expectedTaskIds).size !== expectedCount
    || new Set(expectedWorkspaceIds).size !== expectedCount
    || new Set(expectedResultIds).size !== expectedCount
  ) {
    throw new Error("scenario expected applications are not independent");
  }
  if (audit.version.quality_state !== expectedQuality) {
    throw new Error(`expected final Skill quality ${expectedQuality}`);
  }
  if (
    audit.project.target_part !== certification.targetPart
    || audit.project.toolchain_profile_ref !== certification.toolchainProfileHash
  ) {
    throw new Error("scenario project target/toolchain differs from the certified B v2 identity");
  }
  const source = audit.sourceDistillation;
  const sourceEvidence = objectArray(source.evidence_refs, "audit source episode evidence_refs");
  if (
    audit.version.distillation_run_id !== source.distillation_run_id
    || source.distillation_run_id !== source.run_id
    || source.run_state !== "succeeded"
    || source.run_episode_id !== source.episode_id
    || source.project_id !== audit.project.id
    || source.task_id !== expectedDeposition.taskId
    || source.result_id !== expectedDeposition.resultId
    || source.workspace_id !== expectedDeposition.workspaceId
    || sourceEvidence.length !== 1
    || sourceEvidence[0]!.type !== "task_result"
    || sourceEvidence[0]!.id !== expectedDeposition.resultId
    || sourceEvidence[0]!.hash !== source.output_hash
    || !HASH.test(text(source.output_hash, "audit source task result output hash"))
  ) {
    throw new Error("distilled Skill version is not bound to the exact deposition task result");
  }
  if (
    audit.applications.length !== expectedCount
    || audit.evaluations.length !== expectedCount
    || audit.evalJobs.length !== expectedCount
  ) {
    throw new Error("scenario did not produce the expected independent application/evaluation/job count");
  }
  assertSameIds(
    audit.applications.map((application) => text(application.id, "audit application id")),
    expectedApplicationIds,
    "audit applications",
  );
  assertSameIds(
    audit.applications.map((application) => text(application.task_id, "audit application task id")),
    expectedTaskIds,
    "audit application tasks",
  );
  assertSameIds(
    audit.applications.map((application) => text(application.workspace_id, "audit application workspace id")),
    expectedWorkspaceIds,
    "audit application workspaces",
  );
  assertSameIds(
    audit.applications.map((application) => text(application.result_id, "audit application result id")),
    expectedResultIds,
    "audit application results",
  );
  for (const expected of expectedApplications) {
    const application = audit.applications.find((candidate) => candidate.id === expected.applicationId);
    if (
      application === undefined
      || application.task_id !== expected.taskId
      || application.workspace_id !== expected.workspaceId
      || application.result_id !== expected.resultId
      || application.project_id !== audit.project.id
      || application.state !== "evaluated"
      || application.episode_id === null
      || application.episode_id === undefined
      || integer(application.human_corrections, "audit application human corrections") !== 0
    ) {
      throw new Error("scenario application is not bound to its exact evaluated task result");
    }
  }
  assertSameIds(
    audit.evaluations.map((evaluation) => text(evaluation.application_id, "audit evaluation application id")),
    expectedApplicationIds,
    "audit evaluations",
  );
  assertSameIds(
    audit.evalJobs.map((job) => text(job.application_id, "audit job application id")),
    expectedApplicationIds,
    "audit jobs",
  );
  if (
    audit.curatorRuns.length !== 1
    || audit.curatorRuns[0]!.id !== expectedCuratorRunId
    || audit.curatorRuns[0]!.mode !== "run"
    || audit.curatorRuns[0]!.state !== "completed"
  ) {
    throw new Error("scenario was not completed by the expected production Curator run");
  }

  const jobsByApplication = new Map<string, Record<string, unknown>>();
  for (const job of audit.evalJobs) {
    const applicationId = text(job.application_id, "audit job application id");
    const manifestHash = text(job.evidence_manifest_hash, "audit frozen evidence manifest hash");
    if (
      job.curator_run_id !== expectedCuratorRunId
      || job.operation !== "synthesize"
      || job.tool_operation !== job.operation
      || job.tool_run_class !== "evolution_eval"
      || job.tool_project_id !== audit.project.id
      || job.tool_input_manifest_hash !== job.input_manifest_hash
      || job.tool_toolchain_profile_hash !== certification.toolchainProfileHash
      || job.state !== expectedToolState
      || job.error_code !== null
      || !HASH.test(manifestHash)
    ) {
      throw new Error("scenario job operation, state, Curator binding, or frozen evidence is invalid");
    }
    assertCertifiedDispatchBinding(job, certification);
    jobsByApplication.set(applicationId, job);
  }
  const ordinals = audit.evalJobs.map((job) => integer(job.ordinal, "audit job ordinal")).sort((a, b) => a - b);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new Error("scenario jobs were not allocated as one serial ordinal per application");
  }

  for (const evaluation of audit.evaluations) {
    const applicationId = text(evaluation.application_id, "audit evaluation application id");
    if (evaluation.curator_run_id !== expectedCuratorRunId || evaluation.outcome !== expectedOutcome) {
      throw new Error("scenario evaluation outcome or Curator binding is invalid");
    }
    const job = jobsByApplication.get(applicationId)!;
    const refs = objectArray(evaluation.eval_job_refs, "audit evaluation eval_job_refs");
    if (
      refs.length !== 1
      || refs[0]!.eval_job_id !== job.id
      || refs[0]!.tool_run_id !== job.tool_run_id
      || refs[0]!.evidence_manifest_hash !== job.evidence_manifest_hash
    ) {
      throw new Error("scenario evaluation does not carry the exact frozen Vivado job reference");
    }
  }

  for (const job of audit.evalJobs) {
    const frozenFacts = audit.evidenceFacts.filter((fact) => (
      fact.eval_job_id === job.id && fact.fact_type === "frozen"
    ));
    if (
      frozenFacts.length !== 1
      || frozenFacts[0]!.manifest_hash !== job.evidence_manifest_hash
      || !HASH.test(text(frozenFacts[0]!.fact_hash, "audit frozen evidence fact hash"))
      || !HASH.test(text(
        frozenFacts[0]!.connector_manifest_hash,
        "audit frozen Connector manifest hash",
      ))
    ) {
      throw new Error("scenario job does not have exactly one matching frozen evidence fact");
    }
    const frozenManifest = object(
      frozenFacts[0]!.manifest,
      "audit frozen evidence manifest",
    );
    const canonicalFrozen = canonicalEvolutionEvalEvidenceManifest(frozenManifest);
    const entries = objectArray(frozenManifest.entries, "audit frozen evidence entries");
    const synthesisEntries = audit.evidenceEntries.filter((entry) => (
      entry.eval_job_id === job.id && entry.name === "synthesis-result.json"
    ));
    let synthesisResult: Record<string, unknown> | null = null;
    if (synthesisEntries.length === 1) {
      try {
        synthesisResult = object(
          JSON.parse(text(synthesisEntries[0]!.content_text, "audit synthesis result content")),
          "audit synthesis result",
        );
      } catch {
        synthesisResult = null;
      }
    }
    if (
      canonicalFrozen.sha256 !== job.evidence_manifest_hash
      || frozenManifest.eval_job_id !== job.id
      || frozenManifest.tool_run_id !== job.tool_run_id
      || entries.length === 0
      || integer(frozenFacts[0]!.entry_count, "audit frozen evidence entry count")
        !== entries.length
      || entries.some((entry) => (
        entry.artifact_classification !== "evolution_eval_evidence"
        || entry.usage_classification !== "evolution_eval_only"
      ))
      || synthesisResult === null
      || synthesisResult.schema !== "synthesize-result.v1"
      || synthesisResult.status !== expectedToolState
      || synthesisResult.passed !== (scenario === "success")
      || synthesisResult.timedOut !== false
      || (scenario === "success"
        ? integer(synthesisResult.exitCode, "audit synthesis exit code") !== 0
        : integer(synthesisResult.exitCode, "audit synthesis exit code") === 0)
      || synthesisEntries[0]!.sha256 !== entries.find(
        (entry) => entry.name === "synthesis-result.json",
      )?.sha256
    ) {
      throw new Error("scenario frozen evidence does not prove the exact Vivado synthesis result");
    }
    const observations = audit.connectorObservations.filter(
      (observation) => observation.eval_job_id === job.id,
    );
    if (observations.length === 0) {
      throw new Error("scenario job has no durable Connector observation");
    }
    for (const observation of observations) {
      const payload = object(observation.observation, "audit Connector observation");
      if (
        observation.connector_job_id !== job.connector_job_id
        || observation.observation_type !== payload.state
        || observation.connector_idempotency_key !== job.connector_idempotency_key
        || observation.dispatch_request_hash !== job.dispatch_request_hash
        || observation.ledger_epoch !== certification.ledgerEpoch
        || payload.connector_job_id !== job.connector_job_id
        || payload.connector_idempotency_key !== job.connector_idempotency_key
        || payload.dispatch_request_hash !== job.dispatch_request_hash
        || payload.ledger_epoch !== certification.ledgerEpoch
        || evolutionEvalCanonicalHash(payload) !== observation.observation_hash
      ) {
        throw new Error("scenario Connector observation is outside the certified job binding");
      }
    }
    const terminals = observations.filter(
      (observation) => observation.observation_type === "terminal",
    );
    if (
      terminals.length === 0
      || terminals.some((terminal) => {
        const payload = object(terminal.observation, "audit terminal Connector observation");
        return payload.state !== "terminal"
          || payload.terminal_state !== expectedToolState
          || payload.error_code !== null
          || payload.process_stopped !== true;
      })
    ) {
      throw new Error("scenario job lacks a matching process-stopped terminal Connector observation");
    }
  }

  if (!retentionConverged({
    jobIds: audit.evalJobs.map((job) => text(job.id, "audit retention job id")),
    facts: audit.evidenceFacts,
    receipts: audit.retentionReceipts,
  })) {
    throw new Error("scenario Connector acknowledgement/cleanup retention did not converge");
  }

  const qualityEdges = reconstructQualityLifecycle(audit.lifecycleEvents);
  const expectedEdges = scenario === "success"
    ? ["active_unproven->active_observed"]
    : [
        "active_unproven->needs_review",
        "needs_review->degraded",
        "degraded->quarantined",
      ];
  assertExactOrder(qualityEdges, expectedEdges, "Skill quality lifecycle transitions");
}

/**
 * PostgreSQL `now()` is transaction-scoped, so multiple lifecycle facts from
 * one Curator completion can have identical timestamps.  Reconstruct the
 * unique chain from its immutable from/to projections instead of sorting
 * random UUIDs and pretending that order is chronology.
 */
export function reconstructQualityLifecycle(
  lifecycleEvents: readonly Record<string, unknown>[],
): string[] {
  const edges = lifecycleEvents
    .filter((event) => event.event_type === "quality_evaluated")
    .map((event) => {
      const from = object(event.from_projection, "audit lifecycle from_projection");
      const to = object(event.to_projection, "audit lifecycle to_projection");
      return {
        from: text(from.quality_state, "audit lifecycle from quality_state"),
        to: text(to.quality_state, "audit lifecycle to quality_state"),
      };
    });
  const byFrom = new Map<string, { readonly from: string; readonly to: string }>();
  for (const edge of edges) {
    if (byFrom.has(edge.from)) {
      throw new Error("Skill quality lifecycle transitions branch from one state");
    }
    byFrom.set(edge.from, edge);
  }
  const ordered: string[] = [];
  const used = new Set<string>();
  let current = "active_unproven";
  while (byFrom.has(current)) {
    if (used.has(current)) throw new Error("Skill quality lifecycle transitions contain a cycle");
    used.add(current);
    const edge = byFrom.get(current)!;
    ordered.push(`${edge.from}->${edge.to}`);
    current = edge.to;
  }
  if (used.size !== edges.length) {
    throw new Error("Skill quality lifecycle transitions are disconnected");
  }
  return ordered;
}

function assertCertifiedDispatchBinding(
  job: Record<string, unknown>,
  certification: ScenarioCertificationExpectation,
): void {
  const workspaceManifest = object(
    job.workspace_manifest,
    "audit workspace manifest",
  ) as unknown as EvolutionEvalWorkspaceManifestV1;
  const canonicalWorkspace = canonicalEvolutionEvalWorkspaceManifest(workspaceManifest);
  const workspaceManifestHash = text(
    job.workspace_manifest_hash,
    "audit workspace manifest hash",
  );
  const sealedProjectionHash = text(
    job.sealed_input_projection_hash,
    "audit sealed input projection hash",
  );
  const dispatchRequestHash = text(job.dispatch_request_hash, "audit dispatch request hash");
  if (
    canonicalWorkspace.sha256 !== workspaceManifestHash
    || canonicalEvolutionEvalSealedInputProjection(workspaceManifest).sha256
      !== sealedProjectionHash
    || job.workspace_id !== job.dispatch_workspace_id
    || integer(job.workspace_revision, "audit workspace revision")
      !== integer(job.current_revision, "audit current workspace revision")
    || workspaceManifestHash !== job.dispatch_workspace_manifest_hash
    || job.workspace_sealed_at === null
    || job.workspace_sealed_at === undefined
    || job.input_manifest_hash !== job.workspace_input_manifest_hash
    || job.input_manifest_hash !== job.eval_input_manifest_hash
    || job.workspace_source_commit !== job.eval_source_commit
    || job.workspace_source_manifest_hash !== job.eval_source_manifest_hash
    || job.eval_part !== certification.targetPart
    || job.eval_toolchain_profile_hash !== certification.toolchainProfileHash
    || job.ledger_epoch !== certification.ledgerEpoch
    || !HASH.test(text(job.connector_idempotency_key, "audit Connector idempotency key"))
    || text(job.dispatch_audit_request_hash, "audit dispatch audit request hash")
      !== dispatchRequestHash
    || object(job.dispatch_outbox_payload, "audit dispatch outbox payload").dispatch_request_hash
      !== dispatchRequestHash
    || job.dispatch_outbox_published !== true
  ) {
    throw new Error("scenario job dispatch/workspace is outside the certified sealed binding");
  }
  const expectedDispatchHash = evolutionEvalCanonicalHash({
    schema: "evolution-eval-dispatch-request.v1",
    eval_job_id: job.id,
    connector_job_id: job.connector_job_id,
    connector_idempotency_key: job.connector_idempotency_key,
    eval_input_ref: job.eval_input_ref,
    input_manifest_hash: job.input_manifest_hash,
    workspace_id: job.workspace_id,
    workspace_revision: integer(job.workspace_revision, "audit dispatch workspace revision"),
    workspace_manifest_hash: workspaceManifestHash,
    sealed_input_projection_hash: sealedProjectionHash,
    operation: job.operation,
    parameters: object(job.parameters, "audit eval job parameters"),
    part: job.eval_part,
    toolchain_profile_hash: job.eval_toolchain_profile_hash,
    requested_timeout_ms: integer(job.requested_timeout_ms, "audit requested timeout"),
    operation_cap_ms: EVOLUTION_EVAL_LIMITS.operationCapMs,
    deadline_at: timestamp(job.deadline_at, "audit job deadline"),
    run_class: "evolution_eval",
  });
  if (expectedDispatchHash !== dispatchRequestHash) {
    throw new Error("scenario dispatch request hash does not match its canonical sealed input");
  }
}

class JobTimeoutModel implements EvolutionJsonModel {
  readonly modelId: string;

  constructor(
    private readonly inner: M4fScenarioModel,
    private readonly timeoutMs: number,
  ) {
    this.modelId = inner.modelId;
  }

  async generateJson(request: EvolutionJsonModelRequest, signal?: AbortSignal): Promise<unknown> {
    const decision = await this.inner.generateJson(request, signal);
    if (
      request.purpose === "curation"
      && decision !== null
      && typeof decision === "object"
      && !Array.isArray(decision)
      && (decision as Record<string, unknown>).action === "run_eval"
    ) {
      return { ...(decision as Record<string, unknown>), timeout_ms: this.timeoutMs };
    }
    return decision;
  }
}

async function createAndFinalizeSideTask(
  core: CoreGateHttpClient,
  config: CertifiedM4fE2eConfig,
  input: {
    readonly mainTaskId: string;
    readonly baseCommit: string;
    readonly label: string;
    readonly objective: string;
    readonly source: string;
  },
): Promise<{ readonly taskId: string; readonly workspaceId: string; readonly resultId: string }> {
  const task = await core.human(`/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks`, "POST", {
    kind: "side",
    parent_task_id: input.mainTaskId,
    objective: input.objective,
    base_commit: input.baseCommit,
    authorization_scope: sideScope(["rtl/top.sv"]),
  }, key(config.runId, `side-${input.label}`));
  const taskId = text(task.task_id, "side task id");
  const workspaceId = text(task.workspace_id, "side workspace id");
  await waitForTaskReady(core, config, taskId);
  await core.task(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks/${encodeURIComponent(taskId)}/workspace/files`,
    taskId,
    workspaceId,
    "POST",
    { files: [{ path: "rtl/top.sv", content: input.source }], change_reason: `M4-F ${input.label}` },
    key(config.runId, `write-${input.label}`),
  );
  const finalized = await core.task(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks/${encodeURIComponent(taskId)}/result`,
    taskId,
    workspaceId,
    "POST",
    { summary: input.objective, tests: [] },
    key(config.runId, `finalize-${input.label}`),
  );
  return { taskId, workspaceId, resultId: text(finalized.result_id, "side result id") };
}

async function createApplicationTask(
  core: CoreGateHttpClient,
  config: CertifiedM4fE2eConfig,
  input: {
    readonly mainTaskId: string;
    readonly baseCommit: string;
    readonly versionId: string;
    readonly index: number;
    readonly source: string;
  },
): Promise<ScenarioApplication> {
  const label = `application-${input.index}`;
  const task = await core.human(`/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks`, "POST", {
    kind: "side",
    parent_task_id: input.mainTaskId,
    objective: `Apply the distilled M4-F method to independent fixture ${input.index}.`,
    base_commit: input.baseCommit,
    authorization_scope: sideScope(["rtl/top.sv"]),
  }, key(config.runId, `side-${label}`));
  const taskId = text(task.task_id, "application task id");
  const workspaceId = text(task.workspace_id, "application workspace id");
  await waitForTaskReady(core, config, taskId);
  await core.task(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks/${encodeURIComponent(taskId)}/workspace/files`,
    taskId,
    workspaceId,
    "POST",
    { files: [{ path: "rtl/top.sv", content: input.source }], change_reason: `M4-F ${label}` },
    key(config.runId, `write-${label}`),
  );
  const evolution = new CoreTaskEvolutionClient({
    baseUrl: config.coreBaseUrl,
    token: config.tokens.taskRuntime,
    projectId: config.projectId,
    taskId,
  });
  const search = await evolution.search(`M4-F synthesis recovery ${config.runId}`, 10);
  const found = search.items.find((item) => item.versionId === input.versionId);
  if (!found) throw new Error("newly distilled Skill was not visible to the application task");
  await evolution.view(found.skillId, found.versionId);
  const applyCallId = `apply-${slug(config.runId)}-${input.index}`;
  const localGoal = `Evaluate fixture ${input.index} with the distilled typed synthesis method`;
  await appendEvent(core, config, taskId, workspaceId, `${label}-apply`, "tool_call", {
    tool_call_id: applyCallId,
    name: "learned_skill_apply",
    args: {
      version_id: found.versionId,
      local_goal: localGoal,
      reason_codes: ["m4f_e2e_same_failure_family"],
      role: "primary",
    },
  });
  const application = await evolution.createApplication({
    toolCallId: applyCallId,
    turnId: null,
    versionId: found.versionId,
    localGoal,
    reasonCodes: ["m4f_e2e_same_failure_family"],
    idempotencyKey: key(config.runId, `${label}-create`),
  });
  const evidenceRef = `m4f-evidence:${config.runId}:${input.index}`;
  const closeEvent = await appendEvent(core, config, taskId, workspaceId, `${label}-close`, "tool_call", {
    tool_call_id: `close-${slug(config.runId)}-${input.index}`,
    name: "learned_skill_close",
    args: {
      application_id: application.applicationId,
      outcome_claim: config.scenario === "success" ? "expected success" : "expected deterministic failure",
      human_corrections: 0,
      evidence_refs: [evidenceRef],
      tool_run_refs: [],
    },
  });
  await evolution.closeApplication({
    applicationId: application.applicationId,
    endEventSequence: closeEvent,
    outcomeClaim: config.scenario === "success" ? "expected success" : "expected deterministic failure",
    humanCorrections: 0,
    evidenceRefs: [evidenceRef],
    toolRunRefs: [],
    idempotencyKey: key(config.runId, `${label}-close`),
  });
  const finalized = await core.task(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks/${encodeURIComponent(taskId)}/result`,
    taskId,
    workspaceId,
    "POST",
    { summary: `M4-F application fixture ${input.index} sealed`, tests: [] },
    key(config.runId, `finalize-${label}`),
  );
  return {
    taskId,
    workspaceId,
    applicationId: application.applicationId,
    evidenceRef,
    resultId: text(finalized.result_id, "application result id"),
  };
}

async function appendEvent(
  core: CoreGateHttpClient,
  config: CertifiedM4fE2eConfig,
  taskId: string,
  workspaceId: string | null,
  label: string,
  eventKind: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const result = await core.task(
    `/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks/${encodeURIComponent(taskId)}/events`,
    taskId,
    workspaceId,
    "POST",
    { event_id: `event-${slug(config.runId)}-${label}`, event_kind: eventKind, payload },
    key(config.runId, `event-${label}`),
  );
  return integer(result.sequence, "task event sequence");
}

async function waitForTaskReady(
  core: CoreGateHttpClient,
  config: CertifiedM4fE2eConfig,
  taskId: string,
): Promise<void> {
  const deadline = Date.now() + config.runtimeReadyTimeoutMs;
  while (Date.now() < deadline) {
    const task = await core.human(
      `/api/v1/projects/${encodeURIComponent(config.projectId)}/tasks/${encodeURIComponent(taskId)}`,
    );
    if (task.status === "awaiting_user") return;
    if (["failed", "fail_closed", "cancelled", "succeeded"].includes(String(task.status))) {
      throw new Error(`M4-F deterministic Runtime task became terminal: ${String(task.status)}`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(config.pollIntervalMs, 250, remainingMs),
      ));
    }
  }
  throw new Error("M4-F deterministic Runtime task did not become ready before timeout");
}

interface RetentionSnapshot {
  readonly jobIds: readonly string[];
  readonly facts: readonly Record<string, unknown>[];
  readonly receipts: readonly Record<string, unknown>[];
}

export function retentionConverged(snapshot: RetentionSnapshot): boolean {
  if (snapshot.jobIds.length === 0 || new Set(snapshot.jobIds).size !== snapshot.jobIds.length) {
    return false;
  }
  return snapshot.jobIds.every((jobId) => {
    const factTypes = new Set(snapshot.facts
      .filter((fact) => fact.eval_job_id === jobId)
      .map((fact) => String(fact.fact_type)));
    const receipts = snapshot.receipts.filter((receipt) => receipt.eval_job_id === jobId);
    const acknowledgement = receipts.filter((receipt) => (
      receipt.receipt_type === "acknowledgement"
      && receipt.connector_state === "acknowledged"
      && HASH.test(String(receipt.authorization_hash))
      && HASH.test(String(receipt.connector_fact_hash))
    ));
    const cleanup = receipts.filter((receipt) => (
      receipt.receipt_type === "cleanup"
      && receipt.connector_state === "cleaned"
      && HASH.test(String(receipt.authorization_hash))
      && HASH.test(String(receipt.connector_fact_hash))
    ));
    return ["frozen", "ack_pending", "acknowledged", "cleanup_pending", "cleaned"]
      .every((factType) => factTypes.has(factType))
      && acknowledgement.length === 1
      && cleanup.length === 1
      && receipts.length === 2;
  });
}

async function waitForRetentionConvergence(
  pool: Pool,
  config: CertifiedM4fE2eConfig,
  versionId: string,
): Promise<void> {
  const expectedJobs = config.scenario === "success" ? 1 : 3;
  const deadline = Date.now() + config.retentionTimeoutMs;
  let latest: RetentionSnapshot = { jobIds: [], facts: [], receipts: [] };
  do {
    latest = await readRetentionSnapshot(pool, config.projectId, versionId);
    if (latest.jobIds.length === expectedJobs && retentionConverged(latest)) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(config.pollIntervalMs, remainingMs),
      ));
    }
  } while (Date.now() < deadline);
  throw new Error(
    "M4-F Connector acknowledgement/cleanup did not converge before the bounded retention timeout",
  );
}

async function readRetentionSnapshot(
  pool: Pool,
  projectId: string,
  versionId: string,
): Promise<RetentionSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const jobs = await client.query(
      `SELECT id FROM evolution_eval_job
        WHERE project_id=$1 AND version_id=$2 ORDER BY ordinal,id`,
      [projectId, versionId],
    );
    const facts = await client.query(
      `SELECT fact.eval_job_id,fact.fact_type
         FROM evolution_eval_evidence_fact fact
         JOIN evolution_eval_job job ON job.id=fact.eval_job_id
        WHERE job.project_id=$1 AND job.version_id=$2
        ORDER BY fact.created_at,fact.id`,
      [projectId, versionId],
    );
    const receipts = await client.query(
      `SELECT receipt.eval_job_id,receipt.receipt_type,receipt.connector_state,
              receipt.authorization_hash,receipt.connector_fact_hash
         FROM evolution_eval_retention_receipt receipt
         JOIN evolution_eval_job job ON job.id=receipt.eval_job_id
        WHERE job.project_id=$1 AND job.version_id=$2
        ORDER BY receipt.created_at,receipt.id`,
      [projectId, versionId],
    );
    await client.query("COMMIT");
    return {
      jobIds: (jobs.rows as Record<string, unknown>[]).map((row) => String(row.id)),
      facts: facts.rows as Record<string, unknown>[],
      receipts: receipts.rows as Record<string, unknown>[],
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readFailureQuarantineEffectSnapshot(
  pool: Pool,
  projectId: string,
): Promise<FailureQuarantineEffectSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const [evalJobs, dispatches, toolRuns, connectorObservations] = await Promise.all([
      client.query(
        `SELECT job.id,job.version_id,job.tool_run_id,job.connector_job_id,job.ordinal
           FROM evolution_eval_job job
          WHERE job.project_id=$1
          ORDER BY job.created_at,job.id`,
        [projectId],
      ),
      client.query(
        `SELECT dispatch.eval_job_id,dispatch.dispatch_request_hash
           FROM evolution_eval_dispatch dispatch
           JOIN evolution_eval_job job ON job.id=dispatch.eval_job_id
          WHERE job.project_id=$1
          ORDER BY dispatch.eval_job_id`,
        [projectId],
      ),
      client.query(
        `SELECT tool.id,tool.operation,tool.run_class::text AS run_class,tool.state,
                tool.connector_id,tool.worker_id,tool.start_time,tool.end_time
           FROM tool_run tool
          WHERE tool.project_id=$1
          ORDER BY tool.created_at,tool.id`,
        [projectId],
      ),
      client.query(
        `SELECT observation.id,observation.eval_job_id,observation.observation_type,
                observation.observation_hash,observation.ledger_epoch
           FROM evolution_eval_connector_observation observation
           JOIN evolution_eval_job job ON job.id=observation.eval_job_id
          WHERE job.project_id=$1
          ORDER BY observation.observed_at,observation.id`,
        [projectId],
      ),
    ]);
    await client.query("COMMIT");
    return {
      evalJobs: evalJobs.rows.map((row) => jsonSafe(row as Record<string, unknown>)),
      dispatches: dispatches.rows.map((row) => jsonSafe(row as Record<string, unknown>)),
      toolRuns: toolRuns.rows.map((row) => jsonSafe(row as Record<string, unknown>)),
      connectorObservations: connectorObservations.rows.map(
        (row) => jsonSafe(row as Record<string, unknown>),
      ),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function sideScope(writePaths: readonly string[]): Record<string, unknown> {
  return {
    schema: "task-scope.v1",
    workspace: "isolated",
    read_paths: SIDE_READ_PATHS,
    write_paths: [...writePaths],
    run_classes: ["exploratory"],
    can_submit_gates: false,
    can_create_milestones: false,
    can_start_formal_runs: false,
  };
}

async function readGateIsolation(
  pool: Pool,
  config: CertifiedM4fE2eConfig,
  certification: EvolutionEvalF0CertificationV2,
): Promise<GateIsolationSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const tables = await client.query(
      `SELECT to_regclass('public.learning_episode') AS learning_episode,
              to_regclass('public.evolution_eval_job') AS evolution_eval_job,
              to_regclass('public.curator_run') AS curator_run`,
    );
    if (Object.values(tables.rows[0] as Record<string, unknown>).some((value) => value === null)) {
      throw new Error("Gate database is missing Self-Evolution migrations");
    }
    const settingsResult = await client.query(
      "SELECT learning_paused,learned_skills_enabled FROM evolution_settings WHERE singleton_id='global'",
    );
    const projectResult = await client.query(
      `SELECT id,project_type,target_part,toolchain_profile_ref,status
         FROM project WHERE id=$1`,
      [config.projectId],
    );
    const projectCountResult = await client.query("SELECT count(*)::int AS count FROM project");
    const canaryResult = await client.query(
      `SELECT scenario,project_id,
              binding->'dispatch'->>'eval_job_id' AS id,
              binding->'dispatch'->>'connector_job_id' AS connector_job_id,
              binding->>'dispatch_request_hash' AS dispatch_request_hash
         FROM evolution_eval_canary_binding
        WHERE singleton_id='m4f-canary'
          AND binding->'dispatch'->>'eval_job_id'=$1`,
      [certification.canary.eval_job_id],
    );
    const counts = await client.query(
      `SELECT
        (SELECT count(*)::int FROM skill_application application
          WHERE application.state='pending_evaluation'
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_job canary
               WHERE canary.id=$1 AND canary.application_id=application.id
            )) AS pending_applications,
        (SELECT count(*)::int FROM curator_run run
          WHERE run.state IN ('queued','running')
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_job canary
               WHERE canary.id=$1 AND canary.curator_run_id=run.id
            )) AS open_curator_runs,
        (SELECT count(*)::int FROM evolution_eval_run eval_run
          WHERE eval_run.completed_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_job canary
               WHERE canary.id=$1 AND canary.curator_run_id=eval_run.curator_run_id
            )) AS open_eval_runs,
        (SELECT count(*)::int FROM distillation_run WHERE state IN ('queued','running')) AS open_distillation_runs`,
      [certification.canary.eval_job_id],
    );
    const tokenIdentities = {
      human: await tokenIdentity(client, config.tokens.human, null, "human"),
      taskRuntime: await tokenIdentity(client, config.tokens.taskRuntime, "core:task-runtime", "service"),
      distiller: await tokenIdentity(client, config.tokens.distiller, "core:evolution-distiller", "service"),
      curator: await tokenIdentity(client, config.tokens.curator, "core:evolution-curator", "service"),
      evaluator: await tokenIdentity(client, config.tokens.evaluator, "core:evolution-eval", "service"),
    };
    if (!tokenIdentities.human.scopes.includes("core:write")) {
      throw new Error("M4-F human token must carry core:write");
    }
    await client.query("COMMIT");
    const settings = settingsResult.rows[0] as Record<string, unknown> | undefined;
    if (!settings) throw new Error("evolution_settings row is missing");
    const row = counts.rows[0] as Record<string, unknown>;
    const projectRow = projectResult.rows[0] as Record<string, unknown> | undefined;
    const canary = canaryResult.rows[0] as Record<string, unknown> | undefined;
    return {
      settings: {
        learningPaused: settings.learning_paused === true,
        learnedSkillsEnabled: settings.learned_skills_enabled === true,
      },
      projectCount: Number((projectCountResult.rows[0] as Record<string, unknown>).count),
      project: projectRow === undefined
        ? null
        : {
            id: String(projectRow.id),
            projectType: String(projectRow.project_type),
            targetPart: projectRow.target_part === null ? null : String(projectRow.target_part),
            toolchainProfileRef: projectRow.toolchain_profile_ref === null
              ? null
              : String(projectRow.toolchain_profile_ref),
            status: String(projectRow.status),
          },
      canaryBindingMatched: canary !== undefined
        && canary.scenario === config.scenario
        && canary.id === certification.canary.eval_job_id
        && canary.project_id === config.projectId
        && canary.connector_job_id === certification.canary.connector_job_id
        && canary.dispatch_request_hash === certification.canary.dispatch_request_hash,
      pendingApplications: Number(row.pending_applications),
      openCuratorRuns: Number(row.open_curator_runs),
      openEvalRuns: Number(row.open_eval_runs),
      openDistillationRuns: Number(row.open_distillation_runs),
      tokenIdentities,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function tokenIdentity(
  client: PoolClient,
  token: string,
  exactScope: string | null,
  actorType: "human" | "service",
): Promise<TokenIdentity> {
  const result = await client.query(
    `SELECT account.uid,account.actor_type,token.scope
       FROM auth_token token
       JOIN user_account account ON account.id=token.user_id
      WHERE token.token_hash=$1 AND token.revoked_at IS NULL
        AND (token.expires_at IS NULL OR token.expires_at>now())
        AND account.status='active'`,
    [createHash("sha256").update(token).digest("hex")],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || row.actor_type !== actorType || !Array.isArray(row.scope)) {
    throw new Error("M4-F token identity is invalid or inactive");
  }
  const scopes = row.scope.map(String);
  if (exactScope !== null && (scopes.length !== 1 || scopes[0] !== exactScope)) {
    throw new Error(`M4-F service token must carry exactly ${exactScope}`);
  }
  return { uid: String(row.uid), actorType, scopes };
}

async function readScenarioAudit(pool: Pool, projectId: string, versionId: string): Promise<ScenarioAudit> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const project = await one(client, "SELECT id,target_part,toolchain_profile_ref,status FROM project WHERE id=$1", [projectId]);
    const skill = await one(
      client,
      `SELECT skill.id,skill.slug,skill.active_version_id,skill.enabled,skill.availability_state
         FROM learned_skill skill JOIN learned_skill_version version ON version.skill_id=skill.id
        WHERE version.id=$1`,
      [versionId],
    );
    const version = await one(
      client,
      `SELECT version.id,version.skill_id,version.version_no,status.quality_state,
              version.content_manifest_hash,version.scan_decision,version.distillation_run_id
         FROM learned_skill_version version
         JOIN learned_skill_version_status status ON status.version_id=version.id
        WHERE version.id=$1`,
      [versionId],
    );
    const sourceDistillation = await one(
      client,
      `SELECT version.distillation_run_id,run.id AS run_id,run.state AS run_state,
              run.episode_id AS run_episode_id,episode.id AS episode_id,
              episode.project_id,episode.task_id,episode.evidence_refs,
              result.id AS result_id,result.workspace_id,result.output_hash
         FROM learned_skill_version version
         JOIN distillation_run run ON run.id=version.distillation_run_id
         JOIN learning_episode episode ON episode.id=run.episode_id
         LEFT JOIN task_result result
           ON result.task_id=episode.task_id AND result.project_id=episode.project_id
        WHERE version.id=$1`,
      [versionId],
    );
    const applications = await many(
      client,
      `SELECT application.id,application.project_id,application.task_id,application.state,
              application.episode_id,application.outcome_claim,application.human_corrections,
              result.id AS result_id,result.workspace_id,result.output_hash
         FROM skill_application application
         JOIN skill_application_skill skill ON skill.application_id=application.id
         JOIN task_result result
           ON result.task_id=application.task_id AND result.project_id=application.project_id
        WHERE application.project_id=$1 AND skill.version_id=$2 AND skill.role='primary'
        ORDER BY application.closed_at,application.id`,
      [projectId, versionId],
    );
    const curatorRuns = await many(
      client,
      `SELECT DISTINCT run.id,run.mode,run.state,run.schedule_bucket,run.completed_at
         FROM curator_run run
         JOIN curator_evaluation evaluation ON evaluation.curator_run_id=run.id
        WHERE evaluation.version_id=$1 ORDER BY run.completed_at,run.id`,
      [versionId],
    );
    const evaluations = await many(
      client,
      `SELECT id,curator_run_id,application_id,outcome,confidence,evidence_refs,
              eval_job_refs,evaluator_type,evaluator_version
         FROM curator_evaluation WHERE version_id=$1 ORDER BY created_at,id`,
      [versionId],
    );
    const evalJobs = await many(
      client,
      `SELECT job.id,job.curator_run_id,job.application_id,job.tool_run_id,
              job.connector_job_id,job.connector_idempotency_key,job.eval_input_ref,
              job.input_manifest_hash,job.ordinal,job.operation,job.parameters,
              job.requested_timeout_ms,job.deadline_at,tool.state,tool.error_code,
              tool.operation AS tool_operation,tool.run_class::text AS tool_run_class,
              tool.project_id AS tool_project_id,
              tool.input_manifest_hash AS tool_input_manifest_hash,
              tool.toolchain_profile_hash AS tool_toolchain_profile_hash,
              job.workspace_id,workspace.input_manifest_hash AS workspace_input_manifest_hash,
              workspace.source_commit AS workspace_source_commit,
              workspace.source_manifest_hash AS workspace_source_manifest_hash,
              eval_input.input_manifest_hash AS eval_input_manifest_hash,
              eval_input.source_commit AS eval_source_commit,
              eval_input.source_manifest_hash AS eval_source_manifest_hash,
              eval_input.part AS eval_part,
              eval_input.toolchain_profile_hash AS eval_toolchain_profile_hash,
              dispatch.workspace_id AS dispatch_workspace_id,
              dispatch.workspace_revision,
              dispatch.workspace_manifest_hash AS workspace_manifest_hash,
              dispatch.workspace_manifest_hash AS dispatch_workspace_manifest_hash,
              dispatch.sealed_input_projection_hash,dispatch.dispatch_request_hash,
              projection.current_revision,projection.sealed_at AS workspace_sealed_at,
              revision.manifest AS workspace_manifest,
              epoch.ledger_epoch,
              dispatch_audit.request_hash AS dispatch_audit_request_hash,
              dispatch_outbox.payload AS dispatch_outbox_payload,
              dispatch_outbox.published_at IS NOT NULL AS dispatch_outbox_published,
              frozen.manifest_hash AS evidence_manifest_hash
         FROM evolution_eval_job job
         JOIN tool_run tool ON tool.id=job.tool_run_id
         JOIN evolution_eval_input eval_input ON eval_input.eval_input_ref=job.eval_input_ref
         JOIN evolution_eval_workspace workspace ON workspace.id=job.workspace_id
         JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
         JOIN evolution_eval_workspace_projection projection
           ON projection.workspace_id=job.workspace_id
         JOIN evolution_eval_workspace_revision revision
           ON revision.workspace_id=dispatch.workspace_id
          AND revision.revision=dispatch.workspace_revision
         JOIN evolution_eval_connector_ledger_epoch epoch ON epoch.eval_job_id=job.id
         JOIN evolution_eval_audit_event dispatch_audit
           ON dispatch_audit.id=dispatch.audit_event_id
         JOIN outbox_events dispatch_outbox ON dispatch_outbox.event_id=dispatch.outbox_event_id
         LEFT JOIN LATERAL (
           SELECT fact.manifest_hash FROM evolution_eval_evidence_fact fact
            WHERE fact.eval_job_id=job.id AND fact.fact_type='frozen'
            ORDER BY fact.created_at DESC,fact.id DESC LIMIT 1
         ) frozen ON true
        WHERE job.project_id=$1 AND job.version_id=$2 ORDER BY job.ordinal,job.id`,
      [projectId, versionId],
    );
    const connectorObservations = await many(
      client,
      `SELECT observation.eval_job_id,observation.observation_type,
              observation.connector_job_id,observation.connector_idempotency_key,
              observation.dispatch_request_hash,observation.ledger_epoch,
              observation.observation,observation.observation_hash,observation.observed_at
         FROM evolution_eval_connector_observation observation
         JOIN evolution_eval_job job ON job.id=observation.eval_job_id
        WHERE job.project_id=$1 AND job.version_id=$2
        ORDER BY observation.observed_at,observation.id`,
      [projectId, versionId],
    );
    const evidenceFacts = await many(
      client,
      `SELECT fact.eval_job_id,fact.fact_type,fact.manifest_hash,fact.manifest,
              fact.connector_manifest_hash,fact.error_code,
              fact.fact_hash,fact.entry_count,fact.total_bytes,fact.created_at
         FROM evolution_eval_evidence_fact fact
         JOIN evolution_eval_job job ON job.id=fact.eval_job_id
        WHERE job.project_id=$1 AND job.version_id=$2 ORDER BY fact.created_at,fact.id`,
      [projectId, versionId],
    );
    const evidenceEntries = await many(
      client,
      `SELECT entry.eval_job_id,entry.name,entry.sha256,entry.size_bytes,
              entry.media_type,entry.artifact_classification,entry.usage_classification,
              convert_from(entry.managed_content,'UTF8') AS content_text
         FROM evolution_eval_evidence_entry entry
         JOIN evolution_eval_job job ON job.id=entry.eval_job_id
        WHERE job.project_id=$1 AND job.version_id=$2
          AND entry.name='synthesis-result.json'
        ORDER BY entry.eval_job_id,entry.name`,
      [projectId, versionId],
    );
    const retentionReceipts = await many(
      client,
      `SELECT receipt.eval_job_id,receipt.receipt_type,receipt.connector_state,
              receipt.authorization_hash,receipt.connector_fact_hash,
              receipt.source_authorization_kind,receipt.source_authorization_hash,
              receipt.source_connector_fact_hash,receipt.created_at
         FROM evolution_eval_retention_receipt receipt
         JOIN evolution_eval_job job ON job.id=receipt.eval_job_id
        WHERE job.project_id=$1 AND job.version_id=$2
        ORDER BY receipt.created_at,receipt.id`,
      [projectId, versionId],
    );
    const lifecycleEvents = await many(
      client,
      `SELECT event.id,event.event_type,event.from_projection,event.to_projection,
              event.reason,event.control_revision,event.actor_type,event.actor_id,event.created_at
         FROM learned_skill_lifecycle_event event
        WHERE event.version_id=$1 ORDER BY event.created_at,event.id`,
      [versionId],
    );
    await client.query("COMMIT");
    return {
      project,
      skill,
      version,
      sourceDistillation,
      applications,
      curatorRuns,
      evaluations,
      evalJobs,
      connectorObservations,
      evidenceFacts,
      evidenceEntries,
      retentionReceipts,
      lifecycleEvents,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function one(client: PoolClient, sql: string, values: readonly unknown[]): Promise<Record<string, unknown>> {
  const result = await client.query(sql, [...values]);
  if (result.rows.length !== 1) throw new Error("M4-F audit expected exactly one row");
  return jsonSafe(result.rows[0] as Record<string, unknown>);
}

async function many(client: PoolClient, sql: string, values: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const result = await client.query(sql, [...values]);
  return result.rows.map((row) => jsonSafe(row as Record<string, unknown>));
}

function jsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name,
    item instanceof Date ? item.toISOString() : typeof item === "bigint" ? item.toString() : item,
  ]));
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactLoopbackHttpOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must be an exact loopback HTTP origin`);
  }
  return url.toString().replace(/\/$/u, "");
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`integer must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function opaque(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  if (!normalized) throw new Error("run id cannot be converted to a safe slug");
  return normalized.slice(0, 60);
}

function sha256(value: string, label: string): string {
  if (!HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => object(item, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function assertSameIds(actual: readonly string[], expected: readonly string[], label: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} do not match the expected closed set`);
  }
}

function assertExactOrder(actual: readonly string[], expected: readonly string[], label: string): void {
  if (
    actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} do not match the expected order`);
  }
}

function key(runId: string, action: string): string {
  return createHash("sha256").update(`${M4F_E2E_SUMMARY_SCHEMA}\0${runId}\0${action}`).digest("hex");
}

function assertOutsideRepository(path: string, repositoryRoot: string): string {
  const absolute = resolve(path);
  const fromRepository = relative(repositoryRoot, absolute);
  if (
    !isAbsolute(absolute)
    || fromRepository === ""
    || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
  ) {
    throw new Error("SYNTHIA_M4F_E2E_SUMMARY_OUTPUT must be outside the repository");
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

async function main(): Promise<void> {
  const config = resolveM4fE2eConfig();
  const result = await runM4fE2e(config);
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "M4F_SELF_EVOLUTION_E2E_FAILED");
    process.exitCode = 1;
  });
}
