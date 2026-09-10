/**
 * Runtime workers for the frozen self-evolution v1 internal API.
 *
 * The dependency surface is intentionally narrow: a strict-JSON model plus
 * the Distiller or Curator Core client. There is no Connector, Vivado,
 * governance, task, workspace, or project-writer dependency in this module.
 */

import { canonicalRequestHash, sha256Hex } from "../core/src/hashing.ts";
import type {
  CuratorClaimV1,
  CuratorCompleteRequestV1,
  CuratorEvaluationV1,
  CuratorEvolutionClient,
  CuratorRemediationV1,
  CuratorResultV1,
  DistillationClaimV1,
  DistillationCompleteRequestV1,
  DistillationResultV1,
  DistillationSkillFileV1,
  DistillationSkillV1,
  DistillerEvolutionClient,
  EvolutionEvaluationOutcome,
  EvolutionFailRequestV1,
} from "./evolution-worker-client.ts";

export const EVOLUTION_WORKER_SCHEMA_VERSION = "evolution-worker.v1";
export const DISTILLER_PROMPT_VERSION = "distiller-prompt.v3";
export const CURATOR_PROMPT_VERSION = "curator-prompt.v2";
export const EVOLUTION_MODEL_OUTPUT_MAX_BYTES = 1_500_000;
export const EVOLUTION_LEASE_MIN_SECONDS = 30;
export const EVOLUTION_LEASE_MAX_SECONDS = 900;
export const CURATOR_CONFIDENCE_THRESHOLD_V1 = 0.7;

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_FILE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const DISTILLER_SYSTEM_PROMPT = [
  `You are Synthia's ${DISTILLER_PROMPT_VERSION}.`,
  "Return exactly one JSON object and no markdown or commentary.",
  "Choose no_op unless the sealed trajectory contains a reusable, evidence-supported method.",
  "A failed/cancelled episode may create or patch only when a locally effective step or explicit human correction is evidenced.",
  "Learned Skill files are inert guidance assets and must never request permissions, Connector access, governance writes, or hardware download.",
  "Allowed assets: root SKILL.md, references/, templates/, and scripts/*.tcl|*.py|*.ts. Shell is forbidden.",
  "Actions: {action:'no_op'}, {action:'create',skill:{...}}, or {action:'patch',skill:{skill_id,...}}.",
  "skill fields are exactly: slug, name, summary, description, applicability, outcome_contract, files.",
  "skill.slug is kebab-case; applicability and outcome_contract are JSON objects describing when to apply the skill and its guaranteed result contract.",
  'skill.files items are exactly {path, kind, language, content}: for "SKILL.md" use kind "skill_md" and language null; references/ files use kind "reference" and language null; templates/ use "template" and null; scripts/*.tcl|*.py|*.ts use kind "script" and language "tcl"|"python"|"typescript" respectively. Exactly one file must have path "SKILL.md".',
  "For patch, select an existing skill_id and repeat every skill field plus skill_id. The worker derives expected parent/revision; never invent CAS fields.",
].join("\n");

export const CURATOR_SYSTEM_PROMPT = [
  `You are Synthia's ${CURATOR_PROMPT_VERSION}.`,
  "Return exactly one JSON object and no markdown or commentary.",
  "Evaluate every supplied pending application exactly once using only supplied evidence.",
  "Outcome is one of success, applicability_failure, execution_failure, inconclusive.",
  `Confidence below ${CURATOR_CONFIDENCE_THRESHOLD_V1} must be inconclusive.`,
  "Do not treat the main Agent's outcome claim as authoritative.",
  "Every evaluation must cite only evidence ids or hashes supplied for that application.",
  "Return one remediation per distinct primary skill: no_op, patch, scope_change, or state_action.",
  'Top-level output is exactly {"evaluations":[...],"remediations":[...]} — no other keys.',
  "Each evaluation is exactly {application_id, outcome, confidence, reason, evidence_refs, supersedes_id}: confidence is 0..1, evidence_refs cites supplied evidence ids/hashes, supersedes_id is null unless replacing an earlier evaluation id.",
  'Each remediation is exactly {skill_id, action} for "no_op", plus "patch" (the full skill object) for "patch", plus "state_action" for "state_action".',
  "The worker derives active-version/control CAS fields; never invent permissions or execute assets.",
].join("\n");

export interface EvolutionJsonModelRequest {
  readonly purpose: "distillation" | "curation";
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputBytes: number;
}

/** Strict JSON generation only; deliberately no tools or execution hooks. */
export interface EvolutionJsonModel {
  readonly modelId: string;
  generateJson(request: EvolutionJsonModelRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface EvolutionWorkerOptions {
  readonly workerId: string;
  readonly leaseSeconds?: number;
  /** Testable heartbeat cadence; production defaults to one third of the lease. */
  readonly heartbeatIntervalMs?: number;
  /** Optional bounded Appendix-B evaluator; omitted keeps evidence-only behavior. */
  readonly evaluator?: CuratorEvaluationRunner;
}

export interface CuratorEvaluationRunner {
  run(
    input: { readonly run: NonNullable<CuratorClaimV1["run"]> },
    signal?: AbortSignal,
  ): Promise<{
    readonly evaluations: readonly CuratorEvaluationV1[];
    readonly remediations: readonly CuratorRemediationV1[];
  }>;
}

export interface EvolutionWorkerProvenance {
  readonly inputHash: string;
  readonly promptHash: string;
  readonly modelHash: string;
}

export type DistillerRunOnceResult =
  | { readonly state: "idle" }
  | ({ readonly state: "completed"; readonly runId: string; readonly result: DistillationResultV1 }
    & EvolutionWorkerProvenance)
  | ({ readonly state: "failed"; readonly runId: string; readonly errorCode: string; readonly retryable: boolean; readonly coreState: "queued" | "failed" }
    & EvolutionWorkerProvenance);

export type CuratorRunOnceResult =
  | { readonly state: "idle" }
  | ({ readonly state: "completed"; readonly runId: string; readonly result: CuratorResultV1 }
    & EvolutionWorkerProvenance)
  | ({ readonly state: "failed"; readonly runId: string; readonly errorCode: string; readonly retryable: boolean; readonly coreState: "queued" | "failed" }
    & EvolutionWorkerProvenance);

export class EvolutionWorkerValidationError extends Error {
  readonly code = "MALFORMED_MODEL_OUTPUT";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "EvolutionWorkerValidationError";
  }
}

export class DistillerWorker {
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly client: DistillerEvolutionClient,
    private readonly model: EvolutionJsonModel,
    options: EvolutionWorkerOptions,
  ) {
    this.workerId = workerId(options.workerId);
    this.leaseSeconds = leaseSeconds(options.leaseSeconds);
    this.heartbeatIntervalMs = heartbeatIntervalMs(options.heartbeatIntervalMs, this.leaseSeconds);
    requireModelId(model.modelId);
  }

  async runOnce(signal?: AbortSignal): Promise<DistillerRunOnceResult> {
    throwIfAborted(signal);
    const claim = await abortable(this.client.claim({
      worker_id: this.workerId,
      lease_seconds: this.leaseSeconds,
    }, signal), signal);
    if (claim.run === null) return { state: "idle" };

    const run = claim.run;
    const input = stableDistillationInput(claim);
    const provenance = provenanceFor(input, DISTILLER_SYSTEM_PROMPT, this.model.modelId);
    try {
      const raw = await withLeaseHeartbeat(
        () => this.client.renewLease(run.run_id, {
          lease_token: run.lease_token,
          lease_seconds: this.leaseSeconds,
        }, signal),
        () => this.model.generateJson({
          purpose: "distillation",
          systemPrompt: DISTILLER_SYSTEM_PROMPT,
          userPrompt: JSON.stringify(input),
          maxOutputBytes: EVOLUTION_MODEL_OUTPUT_MAX_BYTES,
        }, signal),
        this.heartbeatIntervalMs,
        signal,
      );
      throwIfAborted(signal);
      const action = parseDistillationOutput(raw, run.existing_skills);
      await abortable(this.client.renewLease(run.run_id, {
        lease_token: run.lease_token,
        lease_seconds: this.leaseSeconds,
      }, signal), signal);
      throwIfAborted(signal);
      const request = distillationCompleteRequest(
        action,
        run.lease_token,
        provenance,
        this.model.modelId,
      );
      const result = await abortable(this.client.complete(run.run_id, request, signal), signal);
      return { state: "completed", runId: run.run_id, result, ...provenance };
    } catch (error) {
      throwIfAborted(signal);
      return await this.failRun(run.run_id, run.lease_token, error, provenance, signal);
    }
  }

  private async failRun(
    runId: string,
    leaseToken: string,
    error: unknown,
    provenance: EvolutionWorkerProvenance,
    signal?: AbortSignal,
  ): Promise<DistillerRunOnceResult> {
    const failure = failureFor(error);
    const result = await abortable(
      this.client.fail(runId, failRequest(leaseToken, failure, provenance), signal),
      signal,
    );
    return {
      state: "failed",
      runId,
      errorCode: failure.code,
      retryable: failure.retryable,
      coreState: result.state,
      ...provenance,
    };
  }
}

function suppressesCuratorFail(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && (error as { readonly suppressCuratorFail?: unknown }).suppressCuratorFail === true;
}

export class CuratorWorker {
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly evaluator: CuratorEvaluationRunner | null;

  constructor(
    private readonly client: CuratorEvolutionClient,
    private readonly model: EvolutionJsonModel,
    options: EvolutionWorkerOptions,
  ) {
    this.workerId = workerId(options.workerId);
    this.leaseSeconds = leaseSeconds(options.leaseSeconds);
    this.heartbeatIntervalMs = heartbeatIntervalMs(options.heartbeatIntervalMs, this.leaseSeconds);
    this.evaluator = options.evaluator ?? null;
    requireModelId(model.modelId);
  }

  async runOnce(signal?: AbortSignal): Promise<CuratorRunOnceResult> {
    throwIfAborted(signal);
    const claim = await abortable(this.client.claim({
      worker_id: this.workerId,
      lease_seconds: this.leaseSeconds,
    }, signal), signal);
    if (claim.run === null) return { state: "idle" };

    const run = claim.run;
    const input = stableCuratorInput(claim);
    const provenance = provenanceFor(input, CURATOR_SYSTEM_PROMPT, this.model.modelId);
    try {
      const parsed = this.evaluator !== null
        ? await withLeaseHeartbeat(
            () => this.client.renewLease(run.run_id, {
              lease_token: run.lease_token,
              lease_seconds: this.leaseSeconds,
            }, signal),
            () => this.evaluator!.run({ run }, signal),
            this.heartbeatIntervalMs,
            signal,
          )
        : run.applications.length === 0
        ? { evaluations: [] as CuratorEvaluationV1[], remediations: [] as CuratorRemediationV1[] }
        : parseCuratorOutput(
            await withLeaseHeartbeat(
              () => this.client.renewLease(run.run_id, {
                lease_token: run.lease_token,
                lease_seconds: this.leaseSeconds,
              }, signal),
              () => this.model.generateJson({
                purpose: "curation",
                systemPrompt: CURATOR_SYSTEM_PROMPT,
                userPrompt: JSON.stringify(input),
                maxOutputBytes: EVOLUTION_MODEL_OUTPUT_MAX_BYTES,
              }, signal),
              this.heartbeatIntervalMs,
              signal,
            ),
            run,
          );
      await abortable(this.client.renewLease(run.run_id, {
        lease_token: run.lease_token,
        lease_seconds: this.leaseSeconds,
      }, signal), signal);
      throwIfAborted(signal);
      const request: CuratorCompleteRequestV1 = {
        lease_token: run.lease_token,
        evaluator_version: curatorEvaluatorVersion(provenance),
        evaluations: parsed.evaluations,
        remediations: parsed.remediations,
      };
      const result = await abortable(this.client.complete(run.run_id, request, signal), signal);
      return { state: "completed", runId: run.run_id, result, ...provenance };
    } catch (error) {
      throwIfAborted(signal);
      if (suppressesCuratorFail(error)) throw error;
      return await this.failRun(run.run_id, run.lease_token, error, provenance, signal);
    }
  }

  private async failRun(
    runId: string,
    leaseToken: string,
    error: unknown,
    provenance: EvolutionWorkerProvenance,
    signal?: AbortSignal,
  ): Promise<CuratorRunOnceResult> {
    const failure = failureFor(error);
    const result = await abortable(
      this.client.fail(runId, failRequest(leaseToken, failure, provenance), signal),
      signal,
    );
    return {
      state: "failed",
      runId,
      errorCode: failure.code,
      retryable: failure.retryable,
      coreState: result.state,
      ...provenance,
    };
  }
}

type DistillationAction =
  | { readonly action: "no_op" }
  | { readonly action: "create"; readonly skill: DistillationSkillV1 }
  | {
      readonly action: "patch";
      readonly skill: DistillationSkillV1 & { readonly skill_id: string };
      readonly expectedParentVersionId: string;
      readonly expectedControlRevision: number;
    };

function stableDistillationInput(claim: DistillationClaimV1): Record<string, unknown> {
  const run = claim.run;
  if (run === null) throw new Error("distillation claim unexpectedly has no run");
  return {
    schema: "distillation-model-input.v1",
    episode: run.episode,
    trajectory: run.trajectory,
    existing_skills: run.existing_skills,
  };
}

function stableCuratorInput(claim: CuratorClaimV1): Record<string, unknown> {
  const run = claim.run;
  if (run === null) throw new Error("curator claim unexpectedly has no run");
  return {
    schema: "curator-model-input.v1",
    mode: run.mode,
    schedule_bucket: run.schedule_bucket,
    applications: run.applications,
  };
}

function provenanceFor(
  input: unknown,
  prompt: string,
  modelId: string,
): EvolutionWorkerProvenance {
  return {
    inputHash: canonicalRequestHash(input),
    promptHash: sha256Hex(prompt),
    modelHash: sha256Hex(modelId),
  };
}

function parseDistillationOutput(
  raw: unknown,
  existingSkills: DistillationClaimV1["run"] extends infer R
    ? R extends { existing_skills: infer S } ? S : never
    : never,
): DistillationAction {
  const row = modelRecord(raw);
  const action = string(row.action, "action");
  if (action === "no_op") {
    exactKeys(row, ["action"], "distillation output");
    return { action };
  }
  if (action !== "create" && action !== "patch") {
    malformed("action must be no_op, create, or patch");
  }
  exactKeys(row, ["action", "skill"], "distillation output");
  const skill = parseSkill(row.skill, action === "patch");
  if (action === "create") return { action, skill };

  const target = existingSkills.find((candidate) => candidate.skill_id === skill.skill_id);
  if (!target) malformed("patch skill_id is not in existing_skills");
  if (
    target.active_version_id === null
    || target.pinned
    || !target.enabled
    || target.availability_state !== "available"
  ) {
    malformed("patch target is not automatically mutable");
  }
  return {
    action,
    skill: skill as DistillationSkillV1 & { readonly skill_id: string },
    expectedParentVersionId: target.active_version_id,
    expectedControlRevision: target.control_revision,
  };
}

function parseSkill(raw: unknown, requireSkillId: boolean): DistillationSkillV1 {
  const row = strictRecord(raw, "skill");
  const keys = [
    ...(requireSkillId ? ["skill_id"] : []),
    "slug",
    "name",
    "summary",
    "description",
    "applicability",
    "outcome_contract",
    "files",
  ];
  exactKeys(row, keys, "skill");
  const slug = boundedText(row.slug, "skill.slug", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) malformed("skill.slug must be kebab-case");
  const filesRaw = array(row.files, "skill.files", MAX_FILES);
  if (filesRaw.length === 0) malformed("skill.files must not be empty");
  const files = filesRaw.map((file, index) => parseSkillFile(file, index));
  if (files.filter((file) => file.path === "SKILL.md").length !== 1) {
    malformed("skill.files must contain exactly one root SKILL.md");
  }
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  if (totalBytes > MAX_TOTAL_FILE_BYTES) malformed("skill files exceed total byte limit");
  const applicability = structured(row.applicability, "skill.applicability");
  const outcomeContract = structured(row.outcome_contract, "skill.outcome_contract");
  return {
    ...(requireSkillId ? { skill_id: identifier(row.skill_id, "skill.skill_id") } : {}),
    slug,
    name: boundedText(row.name, "skill.name", 512),
    summary: boundedText(row.summary, "skill.summary", 4_096),
    description: boundedText(row.description, "skill.description", MAX_TEXT_BYTES),
    applicability,
    outcome_contract: outcomeContract,
    files,
  };
}

function parseSkillFile(raw: unknown, index: number): DistillationSkillFileV1 {
  const label = `skill.files[${index}]`;
  const row = strictRecord(raw, label);
  exactKeys(row, ["path", "kind", "language", "content"], label);
  const path = boundedText(row.path, `${label}.path`, 512);
  const kind = oneOf(row.kind, ["skill_md", "reference", "template", "script"] as const, `${label}.kind`);
  const expected = fileShape(path);
  if (!expected || expected.kind !== kind) malformed(`${label} path/kind is not allowed`);
  const language = row.language === null
    ? null
    : oneOf(row.language, ["tcl", "python", "typescript"] as const, `${label}.language`);
  if (language !== expected.language) malformed(`${label} language does not match path`);
  const content = boundedText(row.content, `${label}.content`, MAX_FILE_BYTES);
  return { path, kind, language, content };
}

function fileShape(path: string): {
  readonly kind: DistillationSkillFileV1["kind"];
  readonly language: DistillationSkillFileV1["language"];
} | null {
  if (
    path !== path.normalize("NFC")
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) return null;
  if (path === "SKILL.md") return { kind: "skill_md", language: null };
  if (path.startsWith("references/")) return { kind: "reference", language: null };
  if (path.startsWith("templates/")) return { kind: "template", language: null };
  if (path.startsWith("scripts/") && path.endsWith(".tcl")) return { kind: "script", language: "tcl" };
  if (path.startsWith("scripts/") && path.endsWith(".py")) return { kind: "script", language: "python" };
  if (path.startsWith("scripts/") && path.endsWith(".ts")) return { kind: "script", language: "typescript" };
  return null;
}

function distillationCompleteRequest(
  action: DistillationAction,
  leaseToken: string,
  provenance: EvolutionWorkerProvenance,
  modelId: string,
): DistillationCompleteRequestV1 {
  const base = {
    lease_token: leaseToken,
    input_hash: provenance.inputHash,
    model_id: modelId,
    prompt_hash: provenance.promptHash,
  } as const;
  if (action.action === "no_op") {
    return {
      ...base,
      action: "no_op",
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: null,
    };
  }
  if (action.action === "create") {
    return {
      ...base,
      action: "create",
      expected_parent_version_id: null,
      expected_control_revision: null,
      skill: action.skill,
    };
  }
  return {
    ...base,
    action: "patch",
    expected_parent_version_id: action.expectedParentVersionId,
    expected_control_revision: action.expectedControlRevision,
    skill: action.skill,
  };
}

export function parseCuratorOutput(
  raw: unknown,
  run: NonNullable<CuratorClaimV1["run"]>,
): { evaluations: CuratorEvaluationV1[]; remediations: CuratorRemediationV1[] } {
  const row = modelRecord(raw);
  exactKeys(row, ["evaluations", "remediations"], "curator output");
  const expectedApplications = new Map(
    run.applications.map((bundle) => [bundle.application.application_id, bundle]),
  );
  const evaluations = array(row.evaluations, "evaluations", run.applications.length)
    .map((value, index) => parseEvaluation(value, index, expectedApplications));
  if (evaluations.length !== expectedApplications.size) {
    malformed("curator must evaluate every claimed application exactly once");
  }
  if (new Set(evaluations.map((item) => item.application_id)).size !== evaluations.length) {
    malformed("curator returned duplicate application evaluations");
  }
  for (const applicationId of expectedApplications.keys()) {
    if (!evaluations.some((item) => item.application_id === applicationId)) {
      malformed(`curator omitted application ${applicationId}`);
    }
  }

  const expectedSkills = new Map<string, NonNullable<CuratorClaimV1["run"]>["applications"][number]>();
  for (const bundle of run.applications) {
    expectedSkills.set(bundle.primary_version.skill.skill_id, bundle);
  }
  const remediations = array(row.remediations, "remediations", expectedSkills.size)
    .map((value, index) => parseRemediation(value, index, expectedSkills));
  if (remediations.length !== expectedSkills.size) {
    malformed("curator must return one remediation per primary skill");
  }
  if (new Set(remediations.map((item) => item.skill_id)).size !== remediations.length) {
    malformed("curator returned duplicate skill remediations");
  }
  for (const skillId of expectedSkills.keys()) {
    if (!remediations.some((item) => item.skill_id === skillId)) {
      malformed(`curator omitted remediation for skill ${skillId}`);
    }
  }
  return { evaluations, remediations };
}

function parseEvaluation(
  raw: unknown,
  index: number,
  expected: ReadonlyMap<string, NonNullable<CuratorClaimV1["run"]>["applications"][number]>,
): CuratorEvaluationV1 {
  const label = `evaluations[${index}]`;
  const row = strictRecord(raw, label);
  exactKeys(row, [
    "application_id",
    "outcome",
    "confidence",
    "reason",
    "evidence_refs",
    "supersedes_id",
  ], label);
  const applicationId = identifier(row.application_id, `${label}.application_id`);
  const bundle = expected.get(applicationId);
  if (!bundle) malformed(`${label}.application_id was not claimed`);
  const outcome = oneOf(
    row.outcome,
    ["success", "applicability_failure", "execution_failure", "inconclusive"] as const,
    `${label}.outcome`,
  );
  const confidence = finiteNumber(row.confidence, `${label}.confidence`, 0, 1);
  if (confidence < CURATOR_CONFIDENCE_THRESHOLD_V1 && outcome !== "inconclusive") {
    malformed(`${label} low confidence must be inconclusive`);
  }
  const allowedRefs = new Set(bundle.evidence.flatMap((item) => [item.id, item.sha256]));
  const evidenceRefs = array(row.evidence_refs, `${label}.evidence_refs`, 100).map((value, refIndex) => {
    const ref = boundedText(value, `${label}.evidence_refs[${refIndex}]`, 1_024);
    if (!allowedRefs.has(ref)) malformed(`${label} cites evidence outside the claim`);
    return ref;
  });
  if (outcome !== "inconclusive" && evidenceRefs.length === 0) {
    malformed(`${label} attributable outcome requires evidence`);
  }
  const supersedesId = row.supersedes_id === null
    ? null
    : identifier(row.supersedes_id, `${label}.supersedes_id`);
  if (
    supersedesId !== null
    && !bundle.application.evaluations.some((evaluation) => evaluation.evaluation_id === supersedesId)
  ) {
    malformed(`${label}.supersedes_id does not belong to the application`);
  }
  return {
    application_id: applicationId,
    evidence_snapshot_hash: hash(bundle.evidence_snapshot_hash, `${label}.evidence_snapshot_hash`),
    outcome,
    confidence,
    reason: boundedText(row.reason, `${label}.reason`, 8_192),
    evidence_refs: evidenceRefs,
    eval_job_refs: [],
    supersedes_id: supersedesId,
  };
}

function parseRemediation(
  raw: unknown,
  index: number,
  expected: ReadonlyMap<string, NonNullable<CuratorClaimV1["run"]>["applications"][number]>,
): CuratorRemediationV1 {
  const label = `remediations[${index}]`;
  const row = strictRecord(raw, label);
  const action = oneOf(
    row.action,
    ["no_op", "patch", "scope_change", "state_action"] as const,
    `${label}.action`,
  );
  const expectedKeys = action === "no_op"
    ? ["skill_id", "action"]
    : action === "state_action"
      ? ["skill_id", "action", "state_action"]
      : ["skill_id", "action", "patch"];
  exactKeys(row, expectedKeys, label);
  const skillId = identifier(row.skill_id, `${label}.skill_id`);
  const bundle = expected.get(skillId);
  if (!bundle) malformed(`${label}.skill_id was not claimed`);
  const skill = bundle.primary_version.skill;
  if (skill.active_version_id !== bundle.primary_version.version_id) {
    malformed(`${label} primary version is no longer the claimed active version`);
  }
  const base = {
    skill_id: skillId,
    expected_active_version_id: bundle.primary_version.version_id,
    expected_control_revision: skill.control_revision,
    action,
  };
  if (action === "no_op") return base;
  if (action === "state_action") return { ...base, state_action: structured(row.state_action, `${label}.state_action`) };
  return { ...base, patch: structured(row.patch, `${label}.patch`) };
}

function curatorEvaluatorVersion(provenance: EvolutionWorkerProvenance): string {
  return `${CURATOR_PROMPT_VERSION}:${provenance.modelHash}:${provenance.promptHash}:${provenance.inputHash}`;
}

interface FailureDescriptor {
  readonly code: string;
  readonly retryable: boolean;
  readonly message: string;
}

function failureFor(error: unknown): FailureDescriptor {
  if (error instanceof EvolutionWorkerValidationError) {
    return { code: error.code, retryable: error.retryable, message: error.message };
  }
  const row = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const retryable = row?.retryable === true;
  const candidate = typeof row?.code === "string" ? row.code : retryable ? "MODEL_REQUEST_RETRYABLE" : "WORKER_EXECUTION_FAILED";
  const code = ID.test(candidate) ? candidate : retryable ? "MODEL_REQUEST_RETRYABLE" : "WORKER_EXECUTION_FAILED";
  return {
    code,
    retryable,
    message: error instanceof Error ? error.message : String(error),
  };
}

function failRequest(
  leaseToken: string,
  failure: FailureDescriptor,
  provenance: EvolutionWorkerProvenance,
): EvolutionFailRequestV1 {
  return {
    lease_token: leaseToken,
    error_code: failure.code,
    retryable: failure.retryable,
    details_hash: canonicalRequestHash({
      schema: "evolution-worker-failure.v1",
      error_code: failure.code,
      retryable: failure.retryable,
      message_hash: sha256Hex(failure.message),
      provenance,
    }),
  };
}

function modelRecord(raw: unknown): Record<string, unknown> {
  let parsed = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > EVOLUTION_MODEL_OUTPUT_MAX_BYTES) malformed("model output exceeds byte limit");
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformed("model output is not strict JSON");
    }
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(raw);
    } catch {
      malformed("model output is not JSON serializable");
    }
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > EVOLUTION_MODEL_OUTPUT_MAX_BYTES) {
      malformed("model output exceeds byte limit");
    }
  }
  return strictRecord(parsed, "model output");
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformed(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    malformed(`${label} fields must be exactly: ${canonical.join(", ")}`);
  }
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) malformed(`${label} must be an array of at most ${max} items`);
  return value as unknown[];
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") malformed(`${label} must be a string`);
  return value as string;
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  const text = string(value, label).trim();
  if (text === "" || Buffer.byteLength(text, "utf8") > maxBytes) malformed(`${label} is empty or exceeds ${maxBytes} bytes`);
  return text;
}

function identifier(value: unknown, label: string): string {
  const text = boundedText(value, label, 256);
  if (!ID.test(text)) malformed(`${label} is not a valid identifier`);
  return text;
}

function hash(value: unknown, label: string): string {
  const text = string(value, label);
  if (!HASH.test(text)) malformed(`${label} must be lowercase SHA-256`);
  return text;
}

function structured(value: unknown, label: string): unknown {
  if (value === null || typeof value !== "object") malformed(`${label} must be a JSON object or array`);
  return value;
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    malformed(`${label} must be between ${min} and ${max}`);
  }
  return value as number;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) malformed(`${label} is not canonical`);
  return value as T[number];
}

function workerId(value: string): string {
  const text = value.trim();
  if (!ID.test(text) || text.length > 256) throw new TypeError("workerId must be a valid identifier");
  return text;
}

function requireModelId(value: string): void {
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value, "utf8") > 512) {
    throw new TypeError("model.modelId must be a non-empty string up to 512 bytes");
  }
}

function leaseSeconds(value: number | undefined): number {
  const seconds = value ?? 300;
  if (!Number.isInteger(seconds) || seconds < EVOLUTION_LEASE_MIN_SECONDS || seconds > EVOLUTION_LEASE_MAX_SECONDS) {
    throw new TypeError(`leaseSeconds must be ${EVOLUTION_LEASE_MIN_SECONDS}-${EVOLUTION_LEASE_MAX_SECONDS}`);
  }
  return seconds;
}

function heartbeatIntervalMs(value: number | undefined, lease: number): number {
  const interval = value ?? Math.max(1_000, Math.floor((lease * 1_000) / 3));
  if (!Number.isInteger(interval) || interval < 1 || interval >= lease * 1_000) {
    throw new TypeError("heartbeatIntervalMs must be a positive integer shorter than the lease");
  }
  return interval;
}

/**
 * Keep a claimed run alive for the whole model inference, not merely before
 * completion. Renewal errors are remembered while the non-cancellable model
 * request drains; the caller then fails the run and never submits a result
 * under a lease whose ownership is uncertain.
 */
async function withLeaseHeartbeat<T>(
  renew: () => Promise<unknown>,
  work: () => Promise<T>,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> = Promise.resolve();
  let renewalError: unknown;

  const schedule = (): void => {
    if (stopped || renewalError !== undefined) return;
    timer = setTimeout(() => {
      renewal = abortable(renew(), signal)
        .then(() => {})
        .catch((error: unknown) => {
          renewalError = error;
          stopped = true;
        })
        .finally(schedule);
    }, intervalMs);
  };

  schedule();
  try {
    const result = await abortable(work(), signal);
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await abortable(renewal, signal);
    if (renewalError !== undefined) throw renewalError;
    return result;
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await abortable(renewal, signal);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("self-evolution worker aborted", "AbortError");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function malformed(message: string): never {
  throw new EvolutionWorkerValidationError(message);
}
