/**
 * Self-evolution v1 Core API.
 *
 * This module owns only Core facts and deterministic projections. Learned
 * Skill assets are inert data: no handler here executes Tcl/Python/TypeScript
 * or grants a Connector/governance capability.
 */

import { randomUUID } from "node:crypto";
import {
  appendOutboxEventInTx,
  withTransaction,
  type TransactionClient,
} from "../db/repository.ts";
import {
  computeSkillMetrics,
  freshnessState,
  nextQualityState,
  requireInconclusiveBelowThreshold,
  skillVisibility,
  type EvaluationOutcome,
  type QualityState,
  type SkillMetricObservation,
} from "../domain/self-evolution.ts";
import { canonicalRequestHash, sha256Hex } from "../hashing.ts";
import {
  scanLearnedSkillPackage,
  type LearnedSkillFileInput,
} from "../services/learned-skill-scan.ts";
import {
  rawTrajectoryHash,
  sanitizeTrajectoryRef,
  sanitizeTrajectoryText,
  sanitizeTrajectoryValue,
} from "../services/trajectory-sanitize.ts";
import {
  capabilityUnavailableError,
  conflictApiError,
  evolutionEvalApiError,
  forbiddenError,
  notFoundError,
  validationError,
} from "./errors.ts";
import {
  materializeEvolutionEvalClaim,
  reconcileEvolutionEvalAfterCommit,
  type EvolutionEvalClaimMaterialization,
} from "./evolution-eval-handlers.ts";
import {
  runIdempotent,
  type HandlerResult,
  type RequestContext,
} from "./handlers.ts";
import { ConnectorError } from "./connector-port.ts";

const EVOLUTION_IDEMPOTENCY_SCOPE = "__evolution__";
const QUALITY_STATES = new Set<QualityState>([
  "active_unproven",
  "active_observed",
  "needs_review",
  "degraded",
  "quarantined",
]);
const EVALUATION_OUTCOMES = new Set<EvaluationOutcome>([
  "success",
  "applicability_failure",
  "execution_failure",
  "inconclusive",
]);
const TERMINAL_DISTILLATION_STATES = new Set(["succeeded", "noop", "quarantined"]);
const TERMINAL_CURATOR_STATES = new Set(["completed", "dry_run_complete"]);

type QueryClient = Pick<TransactionClient, "query">;
type Row = Record<string, unknown>;

function asObject(value: unknown, label = "request body"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !allow.has(key));
  if (unknown.length > 0) throw validationError(`unknown field '${unknown[0]}'`);
  for (const key of required) {
    if (!(key in body)) throw validationError(`field '${key}' is required`);
  }
}

function textField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError(`field '${key}' must be a non-empty string`);
  }
  return value.trim();
}

function nullableTextField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === null) return null;
  return textField(body, key);
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw validationError(`field '${key}' must be a boolean`);
  return value;
}

function integerField(
  body: Record<string, unknown>,
  key: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw validationError(`field '${key}' must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function numberField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw validationError(`field '${key}' must be a number between ${min} and ${max}`);
  }
  return value;
}

function nullableIntegerField(body: Record<string, unknown>, key: string): number | null {
  return body[key] === null ? null : integerField(body, key, 1);
}

function hashField(body: Record<string, unknown>, key: string): string {
  const value = textField(body, key);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw validationError(`field '${key}' must be a lowercase SHA-256 hash`);
  }
  return value;
}

function stringArrayField(
  body: Record<string, unknown>,
  key: string,
  max = 100,
): string[] {
  const value = body[key];
  if (
    !Array.isArray(value)
    || value.length > max
    || value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw validationError(`field '${key}' must be an array of at most ${max} non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function jsonArrayField(body: Record<string, unknown>, key: string, max = 100): unknown[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > max) {
    throw validationError(`field '${key}' must be an array with at most ${max} items`);
  }
  return value;
}

function structuredJsonField(body: Record<string, unknown>, key: string): unknown {
  const value = body[key];
  if (value === null || typeof value !== "object") {
    throw validationError(`field '${key}' must be a JSON object or array`);
  }
  return value;
}

function enumField<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: ReadonlySet<T>,
): T {
  const value = body[key];
  if (typeof value !== "string" || !values.has(value as T)) {
    throw validationError(`field '${key}' is not canonical`);
  }
  return value as T;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("database returned an invalid timestamp");
  return date.toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function requireRollout(ctx: RequestContext): void {
  if (ctx.featureFlags?.selfEvolution !== true) {
    throw capabilityUnavailableError("EVOLUTION_DISABLED");
  }
}

function requireHumanControl(ctx: RequestContext): void {
  if (ctx.identity.actorType !== "human") {
    throw forbiddenError("EVOLUTION_SCOPE_FORBIDDEN");
  }
}

/** Rollout-off permits exactly the emergency learned-skills true -> false edge. */
export function rolloutOffSettingsTransitionAllowed(
  current: { readonly learningPaused: boolean; readonly learnedSkillsEnabled: boolean },
  requested: { readonly learningPaused: boolean; readonly learnedSkillsEnabled: boolean },
): boolean {
  return current.learnedSkillsEnabled
    && !requested.learnedSkillsEnabled
    && requested.learningPaused === current.learningPaused;
}

async function settingsRow(query: QueryClient, lock = false): Promise<Row> {
  const result = await query.query(
    `SELECT learning_paused,learned_skills_enabled,revision,updated_at
       FROM evolution_settings WHERE singleton_id='global'${lock ? " FOR UPDATE" : ""}`,
  );
  const row = result.rows[0] as Row | undefined;
  if (!row) throw new Error("evolution settings row is missing");
  return row;
}

async function requireLearningWritable(ctx: RequestContext, query: QueryClient): Promise<void> {
  requireRollout(ctx);
  const settings = await settingsRow(query);
  if (settings.learning_paused === true) throw conflictApiError("LEARNING_PAUSED");
}

async function canViewProject(ctx: RequestContext, projectId: string): Promise<boolean> {
  if (ctx.identity.scopes.includes("core:admin")) return true;
  const role = await ctx.pool.query(
    `SELECT 1 FROM role_assignment
      WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3 LIMIT 1`,
    [projectId, ctx.identity.actorType, ctx.identity.actorId],
  );
  if (role.rows.length > 0) return true;
  if (
    ctx.identity.actorType !== "service"
    || ctx.identity.scopes.length !== 1
    || ctx.identity.scopes[0] !== "core:task-runtime"
  ) return false;
  const taskId = ctx.request.headers.get("x-synthia-task-id");
  if (!taskId) return false;
  const task = await ctx.pool.query(
    `SELECT 1 FROM agent_task
      WHERE id=$1 AND project_id=$2 AND runtime_actor_id=$3 LIMIT 1`,
    [taskId, projectId, ctx.identity.actorId],
  );
  return task.rows.length > 0;
}

async function appendEvolutionOutbox(
  tx: TransactionClient,
  ctx: RequestContext,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: unknown,
  projectId = EVOLUTION_IDEMPOTENCY_SCOPE,
): Promise<void> {
  await appendOutboxEventInTx(tx, {
    eventId: randomUUID(),
    aggregateType,
    aggregateId,
    eventType,
    projectId,
    payload,
    correlationId: ctx.correlationId,
    classification: ctx.classification,
  });
}

async function metricRows(query: QueryClient, versionId: string): Promise<SkillMetricObservation[]> {
  const result = await query.query(
    `SELECT sas.role,a.state,a.started_at,a.closed_at,a.human_corrections,
            current_eval.outcome
       FROM skill_application_skill sas
       JOIN skill_application a ON a.id=sas.application_id
       LEFT JOIN LATERAL (
         SELECT ce.outcome
           FROM curator_evaluation ce
          WHERE ce.application_id=a.id
            AND ce.version_id=sas.version_id
            AND NOT EXISTS (
              SELECT 1 FROM curator_evaluation newer WHERE newer.supersedes_id=ce.id
            )
          ORDER BY ce.created_at DESC,ce.id DESC LIMIT 1
       ) current_eval ON true
      WHERE sas.version_id=$1`,
    [versionId],
  );
  return (result.rows as Row[]).map((row) => ({
    role: row.role as "primary" | "supporting",
    applicationState: row.state as SkillMetricObservation["applicationState"],
    outcome: (row.outcome ?? null) as EvaluationOutcome | null,
    durationMs: row.closed_at === null
      ? null
      : Math.max(0, new Date(String(row.closed_at)).getTime() - new Date(String(row.started_at)).getTime()),
    humanCorrections: row.human_corrections === null ? null : Number(row.human_corrections),
  }));
}

async function skillSummary(query: QueryClient, skillId: string): Promise<Record<string, unknown>> {
  const result = await query.query(
    `SELECT s.*,v.version_no,vs.quality_state
       FROM learned_skill s
       LEFT JOIN learned_skill_version v ON v.id=s.active_version_id
       LEFT JOIN learned_skill_version_status vs ON vs.version_id=s.active_version_id
      WHERE s.id=$1`,
    [skillId],
  );
  const row = result.rows[0] as Row | undefined;
  if (!row) throw notFoundError(`learned skill not found: ${skillId}`);
  const quality = (row.quality_state ?? null) as QualityState | null;
  const freshness = freshnessState(nullableIso(row.last_used_at), new Date(), iso(row.created_at));
  const visibility = skillVisibility({
    enabled: row.enabled === true,
    availabilityState: row.availability_state as "available" | "archived",
    freshnessState: freshness,
    qualityState: quality,
  });
  const metrics = row.active_version_id
    ? computeSkillMetrics(await metricRows(query, String(row.active_version_id)))
    : computeSkillMetrics([]);
  return {
    schema: "learned-skill-summary.v1",
    skill_id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    applicability_summary: row.applicability_summary,
    active_version_id: row.active_version_id ?? null,
    active_version_no: row.version_no === null || row.version_no === undefined
      ? null
      : Number(row.version_no),
    quality_state: quality,
    freshness_state: freshness,
    availability_state: row.availability_state,
    enabled: row.enabled,
    pinned: row.pinned,
    recommended: visibility.recommended,
    control_revision: Number(row.control_revision),
    last_used_at: nullableIso(row.last_used_at),
    metrics,
  };
}

async function overview(query: QueryClient, ctx: RequestContext): Promise<Record<string, unknown>> {
  const settings = await settingsRow(query);
  const countsResult = await query.query(
    `SELECT s.enabled,s.availability_state,vs.quality_state,count(*)::int AS count
       FROM learned_skill s
       LEFT JOIN learned_skill_version_status vs ON vs.version_id=s.active_version_id
      GROUP BY s.enabled,s.availability_state,vs.quality_state`,
  );
  const counts: Record<string, number> = {
    active_unproven: 0,
    active_observed: 0,
    needs_review: 0,
    degraded: 0,
    quarantined: 0,
    archived: 0,
    disabled: 0,
  };
  for (const raw of countsResult.rows as Row[]) {
    const count = Number(raw.count);
    if (raw.enabled === false) counts.disabled = (counts.disabled ?? 0) + count;
    else if (raw.availability_state === "archived") counts.archived = (counts.archived ?? 0) + count;
    else if (typeof raw.quality_state === "string" && raw.quality_state in counts) {
      counts[raw.quality_state] = (counts[raw.quality_state] ?? 0) + count;
    }
  }
  const pendingResult = await query.query(
    "SELECT count(*)::int AS count FROM skill_application WHERE state='pending_evaluation'",
  );
  const lastRunResult = await query.query(
    `SELECT completed_at FROM curator_run
      WHERE state='completed' ORDER BY completed_at DESC LIMIT 1`,
  );
  const lastRun = (lastRunResult.rows[0] as Row | undefined)?.completed_at ?? null;
  return {
    schema: "evolution-overview.v1",
    rollout_enabled: ctx.featureFlags?.selfEvolution === true,
    learning_paused: settings.learning_paused,
    learned_skills_enabled: settings.learned_skills_enabled,
    settings_revision: Number(settings.revision),
    skill_counts: counts,
    pending_applications: Number((pendingResult.rows[0] as Row).count),
    curator: {
      last_run_at: nullableIso(lastRun),
      next_eligible_at: lastRun === null
        ? null
        : new Date(new Date(String(lastRun)).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      pending_evaluations: Number((pendingResult.rows[0] as Row).count),
      schedule_days: 7,
      idle_hours: 2,
      max_vivado_jobs: 3,
      max_duration_minutes: 120,
    },
  };
}

export async function getEvolutionOverviewHandler(ctx: RequestContext): Promise<HandlerResult> {
  return { status: 200, data: await overview(ctx.pool, ctx) };
}

/**
 * Read-only startup proof for the dedicated M4-F runner.  `ready` means Core
 * was started with all three gates, a dedicated Connector, and the exact B v2
 * identity shown below.  The dispatcher still revalidates B and the live
 * Worker on every tick before any new effect.
 */
export async function getM4fEvolutionReadinessHandler(
  ctx: RequestContext,
): Promise<HandlerResult> {
  const certification = ctx.evolutionEvalReadiness;
  const dispatcherHostEnabled = ctx.featureFlags?.evolutionEvalDispatcherHost === true;
  const newEffectsEnabled = ctx.featureFlags?.evolutionEvalExecution === true;
  const rolloutEnabled = ctx.featureFlags?.selfEvolution === true;
  const connectorConfigured = ctx.evolutionEvalConnector !== undefined;
  return {
    status: 200,
    data: {
      schema: "synthia-m4f-core-readiness.v1",
      ready: dispatcherHostEnabled
        && newEffectsEnabled
        && rolloutEnabled
        && connectorConfigured
        && certification !== undefined
        && Date.now() < Date.parse(certification.expiresAt),
      dispatcher_host_enabled: dispatcherHostEnabled,
      new_effects_enabled: newEffectsEnabled,
      rollout_enabled: rolloutEnabled,
      connector_configured: connectorConfigured,
      certification: certification === undefined
        ? null
        : {
            gate_id: certification.gateId,
            certification_hash: certification.certificationHash,
            expires_at: certification.expiresAt,
            endpoint_origin: certification.endpointOrigin,
            project_id: certification.projectId,
            connector_id: certification.connectorId,
            worker_process_instance_id: certification.workerProcessInstanceId,
            ledger_epoch: certification.ledgerEpoch,
            active_config_sha256: certification.activeConfigSha256,
          },
    },
  };
}

/**
 * Prove that the frozen M4-F identity still maps to the authenticated live
 * Worker and its certified ledger immediately before the runner creates any
 * role, task, distillation, or application facts. This handler is deliberately
 * read-only: it does not use idempotency or write an audit/outbox row.
 */
export async function postM4fEvolutionLiveCertificationProbeHandler(
  ctx: RequestContext,
): Promise<HandlerResult> {
  requireHumanControl(ctx);
  const body = asObject(ctx.body);
  exactFields(body, [
    "schema",
    "gate_id",
    "certification_hash",
    "project_id",
    "ledger_epoch",
  ]);
  const certification = ctx.evolutionEvalReadiness;
  const probe = ctx.evolutionEvalLiveCertificationProbe;
  if (certification === undefined || probe === undefined) {
    throw capabilityUnavailableError("M4F_LIVE_CERTIFICATION_UNAVAILABLE");
  }
  if (
    body.schema !== "synthia-m4f-live-certification-probe.v1"
    || body.gate_id !== certification.gateId
    || body.certification_hash !== certification.certificationHash
    || body.project_id !== certification.projectId
    || body.ledger_epoch !== certification.ledgerEpoch
  ) {
    throw validationError("M4-F live certification request does not match Core startup identity");
  }
  try {
    await probe();
  } catch (error) {
    throw capabilityUnavailableError(
      "M4F_LIVE_CERTIFICATION_FAILED",
      {
        code: error instanceof ConnectorError
          ? error.code
          : "EVOLUTION_EVAL_CERTIFICATION_INVALID",
      },
    );
  }
  return {
    status: 200,
    data: {
      schema: "synthia-m4f-live-certification.v1",
      fresh: true,
      gate_id: certification.gateId,
      certification_hash: certification.certificationHash,
      project_id: certification.projectId,
      endpoint_origin: certification.endpointOrigin,
      connector_id: certification.connectorId,
      worker_process_instance_id: certification.workerProcessInstanceId,
      ledger_epoch: certification.ledgerEpoch,
      checked_at: new Date().toISOString(),
    },
  };
}

function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw validationError("limit must be an integer between 1 and 100");
  }
  return value;
}

export async function listLearnedSkillsHandler(ctx: RequestContext): Promise<HandlerResult> {
  const limit = pageLimit(ctx.url);
  const cursor = ctx.url.searchParams.get("cursor");
  const status = ctx.url.searchParams.get("status");
  if (status !== null && !QUALITY_STATES.has(status as QualityState) && status !== "archived" && status !== "disabled") {
    throw validationError("status is not canonical");
  }
  const result = await ctx.pool.query(
    `SELECT s.id FROM learned_skill s
       LEFT JOIN learned_skill_version_status vs ON vs.version_id=s.active_version_id
      WHERE ($1::text IS NULL OR s.id > $1)
        AND ($2::text IS NULL
          OR ($2='archived' AND s.availability_state='archived')
          OR ($2='disabled' AND s.enabled=false)
          OR vs.quality_state=$2)
      ORDER BY s.id LIMIT $3`,
    [cursor, status, limit + 1],
  );
  const ids = (result.rows as Row[]).map((row) => String(row.id));
  const page = ids.slice(0, limit);
  return {
    status: 200,
    data: {
      schema: "learned-skill-list.v1",
      items: await Promise.all(page.map((skillId) => skillSummary(ctx.pool, skillId))),
      next_cursor: ids.length > limit ? page.at(-1)! : null,
    },
  };
}

export async function getLearnedSkillHandler(ctx: RequestContext): Promise<HandlerResult> {
  const skillId = ctx.params.skillId!;
  const summary = await skillSummary(ctx.pool, skillId);
  const versionsResult = await ctx.pool.query(
    `SELECT v.id,v.version_no,v.parent_version_id,v.content_manifest_hash,v.created_at,vs.quality_state
       FROM learned_skill_version v
       JOIN learned_skill_version_status vs ON vs.version_id=v.id
      WHERE v.skill_id=$1 ORDER BY v.version_no DESC`,
    [skillId],
  );
  const sourceResult = await ctx.pool.query(
    `SELECT dr.id,e.project_id FROM learned_skill_version v
       JOIN distillation_run dr ON dr.id=v.distillation_run_id
       JOIN learning_episode e ON e.id=dr.episode_id
      WHERE v.skill_id=$1 ORDER BY v.version_no,dr.id`,
    [skillId],
  );
  const sources = sourceResult.rows as Row[];
  let visibleSourceCount = 0;
  for (const source of sources) {
    if (await canViewProject(ctx, String(source.project_id))) visibleSourceCount += 1;
  }
  const source = sources[0];
  return {
    status: 200,
    data: {
      ...summary,
      versions: (versionsResult.rows as Row[]).map((row) => ({
        version_id: row.id,
        version_no: Number(row.version_no),
        parent_version_id: row.parent_version_id ?? null,
        quality_state: row.quality_state,
        content_manifest_hash: row.content_manifest_hash,
        created_at: iso(row.created_at),
      })),
      source_summary: {
        distillation_run_id: source?.id ?? "unavailable",
        source_count: sources.length,
        visible_source_count: visibleSourceCount,
      },
    },
  };
}

async function versionDto(
  query: QueryClient,
  skillId: string,
  versionId: string,
): Promise<Record<string, unknown>> {
  const result = await query.query(
    `SELECT v.*,vs.quality_state
       FROM learned_skill_version v
       JOIN learned_skill_version_status vs ON vs.version_id=v.id
      WHERE v.id=$1 AND v.skill_id=$2`,
    [versionId, skillId],
  );
  const row = result.rows[0] as Row | undefined;
  if (!row) throw notFoundError(`learned skill version not found: ${versionId}`);
  const filesResult = await query.query(
    `SELECT path,kind,language,sha256,size_bytes,media_type,content
       FROM learned_skill_file WHERE version_id=$1 ORDER BY path`,
    [versionId],
  );
  return {
    schema: "learned-skill-version.v1",
    skill: await skillSummary(query, skillId),
    version: {
      version_id: row.id,
      version_no: Number(row.version_no),
      parent_version_id: row.parent_version_id ?? null,
      quality_state: row.quality_state,
      description: row.description,
      applicability: row.applicability,
      outcome_contract: row.outcome_contract,
      content_manifest_hash: row.content_manifest_hash,
      created_at: iso(row.created_at),
      files: (filesResult.rows as Row[]).map((file) => ({
        path: file.path,
        kind: file.kind,
        language: file.language ?? null,
        sha256: file.sha256,
        size_bytes: Number(file.size_bytes),
        media_type: file.media_type,
        content: file.content,
      })),
      scan: {
        scanner_version: row.scanner_version,
        decision: row.scan_decision,
        findings: row.scan_findings,
      },
    },
  };
}

export async function getLearnedSkillVersionHandler(ctx: RequestContext): Promise<HandlerResult> {
  return {
    status: 200,
    data: await versionDto(ctx.pool, ctx.params.skillId!, ctx.params.versionId!),
  };
}

async function currentEvaluation(query: QueryClient, applicationId: string): Promise<Row | null> {
  const result = await query.query(
    `SELECT e.id,e.outcome,e.confidence,e.created_at
       FROM curator_evaluation e
      WHERE e.application_id=$1
        AND NOT EXISTS (SELECT 1 FROM curator_evaluation n WHERE n.supersedes_id=e.id)
      ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
    [applicationId],
  );
  return (result.rows[0] as Row | undefined) ?? null;
}

async function applicationListItem(ctx: RequestContext, row: Row): Promise<Record<string, unknown>> {
  const applicationId = String(row.id);
  const visible = await canViewProject(ctx, String(row.project_id));
  const skills = await ctx.pool.query(
    `SELECT version_id,role FROM skill_application_skill
      WHERE application_id=$1 ORDER BY role,version_id`,
    [applicationId],
  );
  const evaluation = await currentEvaluation(ctx.pool, applicationId);
  return {
    application_id: applicationId,
    project_ref: visible ? row.project_id : "redacted",
    task_ref: visible ? row.task_id : "redacted",
    local_goal: visible ? row.local_goal : "redacted",
    state: row.state,
    started_at: iso(row.started_at),
    closed_at: nullableIso(row.closed_at),
    duration_ms: row.closed_at === null
      ? null
      : Math.max(0, new Date(String(row.closed_at)).getTime() - new Date(String(row.started_at)).getTime()),
    human_corrections: row.human_corrections === null ? null : Number(row.human_corrections),
    outcome_claim: row.outcome_claim === null
      ? null
      : visible ? row.outcome_claim : "redacted",
    skills: (skills.rows as Row[]).map((skill) => ({
      version_id: skill.version_id,
      role: skill.role,
    })),
    current_evaluation: evaluation
      ? {
          evaluation_id: evaluation.id,
          outcome: evaluation.outcome,
          confidence: Number(evaluation.confidence),
          created_at: iso(evaluation.created_at),
        }
      : null,
  };
}

export async function listLearnedSkillApplicationsHandler(ctx: RequestContext): Promise<HandlerResult> {
  await skillSummary(ctx.pool, ctx.params.skillId!);
  const limit = pageLimit(ctx.url);
  const cursor = ctx.url.searchParams.get("cursor");
  const result = await ctx.pool.query(
    `SELECT DISTINCT a.* FROM skill_application a
       JOIN skill_application_skill sas ON sas.application_id=a.id
       JOIN learned_skill_version v ON v.id=sas.version_id
      WHERE v.skill_id=$1 AND ($2::text IS NULL OR a.id > $2)
      ORDER BY a.id LIMIT $3`,
    [ctx.params.skillId!, cursor, limit + 1],
  );
  const rows = result.rows as Row[];
  return {
    status: 200,
    data: {
      schema: "skill-application-list.v1",
      items: await Promise.all(rows.slice(0, limit).map((row) => applicationListItem(ctx, row))),
      next_cursor: rows.length > limit ? String(rows[limit - 1]!.id) : null,
    },
  };
}

function evidenceProjection(refs: unknown[], visible: boolean): {
  visible: number;
  redacted: number;
  refs: { type: string; id: string; hash: string }[];
} {
  const projected = refs.map((value) => {
    if (typeof value === "string") {
      return { type: "reference", id: value, hash: sha256Hex(value) };
    }
    const row = value && typeof value === "object" && !Array.isArray(value)
      ? value as Row
      : {};
    const rawId = typeof row.id === "string" ? row.id : JSON.stringify(value);
    const hash = typeof row.hash === "string" && /^[0-9a-f]{64}$/.test(row.hash)
      ? row.hash
      : sha256Hex(JSON.stringify(value));
    return {
      type: typeof row.type === "string" ? row.type : "reference",
      id: rawId,
      hash,
    };
  });
  return {
    visible: visible ? projected.length : 0,
    redacted: visible ? 0 : projected.length,
    refs: visible ? projected : [],
  };
}

async function evalJobTraceProjection(
  ctx: RequestContext,
  applicationId: string,
  refsValue: unknown,
  visible: boolean,
): Promise<Record<string, unknown>[]> {
  const refs = Array.isArray(refsValue) ? refsValue : [];
  const ids = refs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const ref = value as Row;
    return typeof ref.eval_job_id === "string" ? [ref.eval_job_id] : [];
  });
  if (ids.length === 0) return [];
  const result = await ctx.pool.query(
    `SELECT job.id,job.tool_run_id,job.operation,job.input_manifest_hash,
            tool.state::text,revision.manifest_hash AS workspace_manifest_hash,
            dispatch.dispatch_request_hash,
            COALESCE(array_agg(fact.fact_type ORDER BY fact.created_at,fact.id)
              FILTER (WHERE fact.id IS NOT NULL),'{}'::text[]) AS evidence_facts,
            max(fact.id) FILTER (WHERE fact.fact_type='frozen') AS frozen_fact_id,
            max(fact.manifest_hash) FILTER (WHERE fact.fact_type='frozen') AS evidence_manifest_hash
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       JOIN evolution_eval_workspace_projection projection ON projection.workspace_id=job.workspace_id
       JOIN evolution_eval_workspace_revision revision
         ON revision.workspace_id=job.workspace_id AND revision.revision=projection.current_revision
       LEFT JOIN evolution_eval_dispatch dispatch ON dispatch.eval_job_id=job.id
       LEFT JOIN evolution_eval_evidence_fact fact ON fact.eval_job_id=job.id
      WHERE job.application_id=$1 AND job.id=ANY($2::text[])
      GROUP BY job.id,tool.state,revision.manifest_hash,dispatch.dispatch_request_hash
      ORDER BY job.ordinal`,
    [applicationId, ids],
  );
  const rows = result.rows as Row[];
  const traces: Record<string, unknown>[] = [];
  for (const job of rows) {
    const facts = new Set((job.evidence_facts as string[] | undefined) ?? []);
    const evidenceState = facts.has("frozen")
      ? "frozen"
      : facts.has("corrupt")
      ? "corrupt"
      : facts.has("unavailable_at_deadline")
      ? "unavailable_at_deadline"
      : "none";
    const retention = facts.has("expired")
      ? "expired"
      : facts.has("quarantine_pending")
      ? "quarantine_pending"
      : facts.has("acknowledged")
      ? "acknowledged"
      : facts.has("ack_pending")
      ? "pending_ack"
      : "not_applicable";
    const entriesResult = job.frozen_fact_id === null
      ? { rows: [] as Row[] }
      : await ctx.pool.query(
          `SELECT name,sha256,size_bytes,media_type,artifact_classification,usage_classification
             FROM evolution_eval_evidence_entry WHERE evidence_fact_id=$1
            ORDER BY name COLLATE "C"`,
          [job.frozen_fact_id],
        );
    traces.push({
      eval_job_ref: visible ? job.id : "redacted",
      tool_run_ref: visible ? job.tool_run_id : "redacted",
      operation: job.operation,
      state: job.state,
      input_manifest_hash: job.input_manifest_hash,
      workspace_manifest_hash: job.workspace_manifest_hash ?? null,
      dispatch_request_hash: job.dispatch_request_hash ?? null,
      evidence_manifest_hash: job.evidence_manifest_hash ?? null,
      evidence_state: evidenceState,
      retention_state: retention,
      evidence_entries: (entriesResult.rows as Row[]).map((entry) => ({
        name: visible ? entry.name : "redacted",
        sha256: entry.sha256,
        size_bytes: Number(entry.size_bytes),
        media_type: entry.media_type,
        artifact_classification: entry.artifact_classification,
        usage_classification: entry.usage_classification,
      })),
    });
  }
  return traces;
}

async function applicationDetail(ctx: RequestContext, applicationId: string): Promise<Record<string, unknown>> {
  const result = await ctx.pool.query("SELECT * FROM skill_application WHERE id=$1", [applicationId]);
  const row = result.rows[0] as Row | undefined;
  if (!row) throw notFoundError(`skill application not found: ${applicationId}`);
  const visible = await canViewProject(ctx, String(row.project_id));
  const skillsResult = await ctx.pool.query(
    `SELECT skill_id,version_id,role,reason_codes
       FROM skill_application_skill WHERE application_id=$1 ORDER BY created_at,id`,
    [applicationId],
  );
  const evaluationsResult = await ctx.pool.query(
    `SELECT * FROM curator_evaluation
      WHERE application_id=$1 ORDER BY created_at,id`,
    [applicationId],
  );
  const evidenceRefs = Array.isArray(row.evidence_refs) ? row.evidence_refs : [];
  return {
    schema: "skill-application-detail.v1",
    application_id: applicationId,
    project_ref: visible ? row.project_id : "redacted",
    task_ref: visible ? row.task_id : "redacted",
    observation_key: visible ? row.observation_key : "redacted",
    episode_ref: row.episode_id === null ? null : visible ? row.episode_id : "redacted",
    local_goal: visible ? row.local_goal : "redacted",
    state: row.state,
    started_at: iso(row.started_at),
    closed_at: nullableIso(row.closed_at),
    duration_ms: row.closed_at === null
      ? null
      : Math.max(0, new Date(String(row.closed_at)).getTime() - new Date(String(row.started_at)).getTime()),
    human_corrections: row.human_corrections === null ? null : Number(row.human_corrections),
    outcome_claim: row.outcome_claim === null
      ? null
      : visible ? row.outcome_claim : "redacted",
    skills: (skillsResult.rows as Row[]).map((skill) => ({
      skill_id: skill.skill_id,
      version_id: skill.version_id,
      role: skill.role,
      reason_codes: visible ? skill.reason_codes : [],
    })),
    evidence_summary: evidenceProjection(evidenceRefs, visible),
    evaluations: await Promise.all((evaluationsResult.rows as Row[]).map(async (evaluation) => {
      const refs = Array.isArray(evaluation.evidence_refs) ? evaluation.evidence_refs : [];
      return {
        evaluation_id: evaluation.id,
        outcome: evaluation.outcome,
        confidence: Number(evaluation.confidence),
        reason: visible ? evaluation.reason : "redacted",
        evidence_summary: {
          visible: visible ? refs.length : 0,
          redacted: visible ? 0 : refs.length,
          hashes: refs.map((ref) => {
            if (typeof ref === "string" && /^[0-9a-f]{64}$/.test(ref)) return ref;
            if (ref && typeof ref === "object" && !Array.isArray(ref)) {
              const hash = (ref as Row).hash;
              if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) return hash;
            }
            return sha256Hex(JSON.stringify(ref));
          }),
        },
        supersedes_id: evaluation.supersedes_id ?? null,
        evaluator_type: evaluation.evaluator_type,
        evaluator_version: evaluation.evaluator_version,
        eval_job_refs: await evalJobTraceProjection(
          ctx,
          applicationId,
          evaluation.eval_job_refs,
          visible,
        ),
        created_at: iso(evaluation.created_at),
      };
    })),
  };
}

export async function getSkillApplicationHandler(ctx: RequestContext): Promise<HandlerResult> {
  return { status: 200, data: await applicationDetail(ctx, ctx.params.applicationId!) };
}

export async function updateEvolutionSettingsHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireHumanControl(ctx);
  const body = asObject(ctx.body);
  exactFields(body, ["learning_paused", "learned_skills_enabled", "expected_revision", "reason"]);
  const learningPaused = booleanField(body, "learning_paused");
  const learnedSkillsEnabled = booleanField(body, "learned_skills_enabled");
  const expectedRevision = integerField(body, "expected_revision", 1);
  const reason = textField(body, "reason");
  const write = await runIdempotent(
    ctx,
    "update_evolution_settings",
    EVOLUTION_IDEMPOTENCY_SCOPE,
    async (tx) => {
      const current = await settingsRow(tx, true);
      if (
        ctx.featureFlags?.selfEvolution !== true
        && !rolloutOffSettingsTransitionAllowed(
          {
            learningPaused: current.learning_paused === true,
            learnedSkillsEnabled: current.learned_skills_enabled === true,
          },
          { learningPaused, learnedSkillsEnabled },
        )
      ) {
        throw capabilityUnavailableError("EVOLUTION_DISABLED");
      }
      if (Number(current.revision) !== expectedRevision) {
        throw conflictApiError("EVOLUTION_CAS_CONFLICT", {
          expected_revision: expectedRevision,
          current_revision: Number(current.revision),
        });
      }
      await tx.query(
        `UPDATE evolution_settings
            SET learning_paused=$1,learned_skills_enabled=$2,revision=revision+1,
                updated_by_type=$3,updated_by=$4,update_reason=$5,updated_at=now()
          WHERE singleton_id='global'`,
        [learningPaused, learnedSkillsEnabled, ctx.identity.actorType, ctx.identity.actorId, reason],
      );
      await appendEvolutionOutbox(tx, ctx, "evolution_settings", "global", "evolution.settings_changed", {
        learning_paused: learningPaused,
        learned_skills_enabled: learnedSkillsEnabled,
        reason,
      });
      return await overview(tx, ctx);
    },
  );
  return { status: 200, data: write.result };
}

export async function createCuratorRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireHumanControl(ctx);
  requireRollout(ctx);
  const body = asObject(ctx.body);
  exactFields(body, ["mode", "reason", "manual_key"]);
  const mode = enumField(body, "mode", new Set(["run", "dry_run"] as const));
  const reason = textField(body, "reason");
  const manualKey = textField(body, "manual_key");
  const write = await runIdempotent(
    ctx,
    `create_curator_run:${manualKey}`,
    EVOLUTION_IDEMPOTENCY_SCOPE,
    async (tx) => {
      const settings = await settingsRow(tx, true);
      if (settings.learning_paused === true && mode === "run") {
        throw conflictApiError("LEARNING_PAUSED");
      }
      const runId = id("cur");
      const created = new Date();
      await tx.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,reason,created_by_type,created_by,created_at,updated_at)
         VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8,$8)`,
        [
          runId,
          mode,
          `manual:${manualKey}`,
          manualKey,
          reason,
          ctx.identity.actorType,
          ctx.identity.actorId,
          created,
        ],
      );
      await appendEvolutionOutbox(tx, ctx, "curator_run", runId, "evolution.curator_run_queued", {
        mode,
        manual_key: manualKey,
      });
      return {
        schema: "curator-run.v1",
        curator_run_id: runId,
        state: "queued",
        mode,
        created_at: created.toISOString(),
      };
    },
  );
  return { status: 201, data: write.result };
}

async function appendLifecycle(
  tx: TransactionClient,
  ctx: RequestContext,
  input: {
    skillId: string;
    versionId: string | null;
    eventType: string;
    from: Record<string, unknown>;
    to: Record<string, unknown>;
    reason: string;
    controlRevision: number;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO learned_skill_lifecycle_event
      (id,skill_id,version_id,event_type,from_projection,to_projection,reason,
       control_revision,actor_type,actor_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)`,
    [
      id("lse"),
      input.skillId,
      input.versionId,
      input.eventType,
      JSON.stringify(input.from),
      JSON.stringify(input.to),
      input.reason,
      input.controlRevision,
      ctx.identity.actorType,
      ctx.identity.actorId,
    ],
  );
}

export async function controlLearnedSkillHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireHumanControl(ctx);
  const action = ctx.params.action!;
  const skillId = ctx.params.skillId!;
  const body = asObject(ctx.body);
  if (action === "rollback") {
    exactFields(body, ["target_version_id", "expected_active_version_id", "expected_control_revision", "reason"]);
  } else {
    exactFields(body, ["expected_control_revision", "reason"]);
  }
  if (ctx.featureFlags?.selfEvolution !== true && action !== "disable") {
    throw capabilityUnavailableError("EVOLUTION_DISABLED");
  }
  const expectedRevision = integerField(body, "expected_control_revision", 1);
  const reason = textField(body, "reason");
  const write = await runIdempotent(
    ctx,
    `control_learned_skill:${skillId}:${action}`,
    EVOLUTION_IDEMPOTENCY_SCOPE,
    async (tx) => {
      const result = await tx.query("SELECT * FROM learned_skill WHERE id=$1 FOR UPDATE", [skillId]);
      const row = result.rows[0] as Row | undefined;
      if (!row) throw notFoundError(`learned skill not found: ${skillId}`);
      if (Number(row.control_revision) !== expectedRevision) {
        throw conflictApiError("EVOLUTION_CAS_CONFLICT", { current_revision: Number(row.control_revision) });
      }
      if (
        ctx.featureFlags?.selfEvolution !== true
        && action === "disable"
        && row.enabled !== true
      ) {
        // Rollout-off is a one-way emergency edge, not a general-purpose
        // control lane. A replay with the original Idempotency-Key is served
        // by runIdempotent before this callback; a new request must not mint a
        // second revision/lifecycle event for an already-disabled Skill.
        throw capabilityUnavailableError("EVOLUTION_DISABLED");
      }
      const from = {
        enabled: row.enabled,
        pinned: row.pinned,
        availability_state: row.availability_state,
        active_version_id: row.active_version_id,
      };
      let enabled = row.enabled === true;
      let pinned = row.pinned === true;
      let availability = String(row.availability_state);
      let activeVersionId = row.active_version_id === null ? null : String(row.active_version_id);
      if (action === "pin") pinned = true;
      else if (action === "unpin") pinned = false;
      else if (action === "disable") enabled = false;
      else if (action === "enable") enabled = true;
      else if (action === "archive") availability = "archived";
      else if (action === "restore") availability = "available";
      else if (action === "rollback") {
        if (availability === "archived") throw conflictApiError("SKILL_NOT_AVAILABLE");
        const expectedActive = textField(body, "expected_active_version_id");
        if (activeVersionId !== expectedActive) throw conflictApiError("EVOLUTION_CAS_CONFLICT");
        const target = textField(body, "target_version_id");
        const targetResult = await tx.query(
          `SELECT v.id,vs.quality_state FROM learned_skill_version v
             JOIN learned_skill_version_status vs ON vs.version_id=v.id
            WHERE v.id=$1 AND v.skill_id=$2`,
          [target, skillId],
        );
        const targetRow = targetResult.rows[0] as Row | undefined;
        if (!targetRow) throw notFoundError(`learned skill version not found: ${target}`);
        if (targetRow.quality_state === "quarantined") throw conflictApiError("SKILL_NOT_AVAILABLE");
        activeVersionId = target;
      } else {
        throw validationError("unsupported learned skill control action");
      }
      const revision = expectedRevision + 1;
      await tx.query(
        `UPDATE learned_skill
            SET enabled=$2,pinned=$3,availability_state=$4,active_version_id=$5,
                control_revision=$6,updated_at=now()
          WHERE id=$1`,
        [skillId, enabled, pinned, availability, activeVersionId, revision],
      );
      const to = {
        enabled,
        pinned,
        availability_state: availability,
        active_version_id: activeVersionId,
      };
      await appendLifecycle(tx, ctx, {
        skillId,
        versionId: activeVersionId,
        eventType: `human_${action}`,
        from,
        to,
        reason,
        controlRevision: revision,
      });
      await appendEvolutionOutbox(tx, ctx, "learned_skill", skillId, "evolution.skill_controlled", {
        action,
        reason,
        control_revision: revision,
      });
      return await skillSummary(tx, skillId);
    },
  );
  return { status: 200, data: write.result };
}

interface BoundTaskRow extends Row {
  id: string;
  project_id: string;
  agent_role: "project" | "run" | "side";
  status: string;
  runtime_actor_id: string;
}

async function requireTaskBound(
  ctx: RequestContext,
  query: QueryClient,
  lock = false,
): Promise<BoundTaskRow> {
  const projectId = ctx.params.projectId!;
  const taskId = ctx.params.taskId!;
  if (
    ctx.identity.actorType !== "service"
    || ctx.identity.scopes.length !== 1
    || ctx.identity.scopes[0] !== "core:task-runtime"
    || ctx.request.headers.get("x-synthia-task-id") !== taskId
  ) {
    throw forbiddenError("EVOLUTION_SCOPE_FORBIDDEN");
  }
  const result = await query.query(
    `SELECT * FROM agent_task WHERE id=$1 AND project_id=$2${lock ? " FOR UPDATE" : ""}`,
    [taskId, projectId],
  );
  const row = result.rows[0] as BoundTaskRow | undefined;
  if (!row || row.runtime_actor_id !== ctx.identity.actorId) {
    throw notFoundError(`task not found: ${taskId}`);
  }
  return row;
}

async function committedTaskEvent(
  query: QueryClient,
  taskId: string,
  sequence: number,
): Promise<Row> {
  const result = await query.query(
    `SELECT sequence,event_kind,payload,payload_hash,created_at
       FROM task_conversation_event WHERE task_id=$1 AND sequence=$2`,
    [taskId, sequence],
  );
  const row = result.rows[0] as Row | undefined;
  if (!row) throw conflictApiError("TASK_EVENT_NOT_COMMITTED", { sequence });
  return row;
}

function taskObservationKey(task: BoundTaskRow, turnId: string | null): string {
  if (task.agent_role === "project") {
    if (turnId === null) throw validationError("field 'turn_id' is required for a Project Agent");
    return `turn:${turnId}`;
  }
  if (turnId !== null) throw validationError("field 'turn_id' must be null for a bounded task");
  return `task:${task.id}`;
}

function requireVersionUsable(row: Row | undefined, versionId: string): Row {
  if (!row) throw notFoundError(`learned skill version not found: ${versionId}`);
  if (
    row.active_version_id !== versionId
    || row.enabled !== true
    || row.availability_state !== "available"
    || row.quality_state === "quarantined"
  ) {
    throw conflictApiError(
      row.active_version_id === versionId ? "SKILL_NOT_AVAILABLE" : "SKILL_VERSION_NOT_ACTIVE",
    );
  }
  return row;
}

async function loadUsableVersion(query: QueryClient, versionId: string, lock = false): Promise<Row> {
  const result = await query.query(
    `SELECT v.id,v.skill_id,s.active_version_id,s.enabled,s.pinned,s.availability_state,
            s.control_revision,s.last_used_at,vs.quality_state
       FROM learned_skill_version v
       JOIN learned_skill s ON s.id=v.skill_id
       JOIN learned_skill_version_status vs ON vs.version_id=v.id
      WHERE v.id=$1${lock ? " FOR UPDATE OF s" : ""}`,
    [versionId],
  );
  return requireVersionUsable(result.rows[0] as Row | undefined, versionId);
}

async function requireAgentDiscoveryEnabled(ctx: RequestContext, query: QueryClient): Promise<void> {
  requireRollout(ctx);
  const settings = await settingsRow(query);
  if (settings.learned_skills_enabled !== true) {
    throw conflictApiError("LEARNED_SKILLS_DISABLED");
  }
}

export async function taskSearchLearnedSkillsHandler(ctx: RequestContext): Promise<HandlerResult> {
  await requireTaskBound(ctx, ctx.pool);
  await requireAgentDiscoveryEnabled(ctx, ctx.pool);
  const q = (ctx.url.searchParams.get("q") ?? "").trim();
  const limit = pageLimit(ctx.url);
  const result = await ctx.pool.query(
    `SELECT s.id,s.active_version_id,vs.quality_state
       FROM learned_skill s
       JOIN learned_skill_version_status vs ON vs.version_id=s.active_version_id
      WHERE s.enabled=true AND s.availability_state='available'
        AND vs.quality_state <> 'quarantined'
        AND ($1='' OR s.name ILIKE '%' || $1 || '%'
          OR s.summary ILIKE '%' || $1 || '%'
          OR s.applicability_summary ILIKE '%' || $1 || '%')
      ORDER BY CASE WHEN s.name ILIKE '%' || $1 || '%' THEN 0 ELSE 1 END,s.id
      LIMIT $2`,
    [q, limit],
  );
  const items: Record<string, unknown>[] = [];
  for (const row of result.rows as Row[]) {
    const summary = await skillSummary(ctx.pool, String(row.id));
    items.push({
      skill_id: summary.skill_id,
      version_id: summary.active_version_id,
      name: summary.name,
      summary: summary.summary,
      applicability_summary: summary.applicability_summary,
      quality_state: summary.quality_state,
      recommended: summary.recommended,
    });
  }
  return {
    status: 200,
    data: {
      schema: "learned-skill-search.v1",
      items,
      learned_skills_enabled: true,
    },
  };
}

export async function taskViewLearnedSkillVersionHandler(ctx: RequestContext): Promise<HandlerResult> {
  const task = await requireTaskBound(ctx, ctx.pool);
  const skillId = ctx.params.skillId!;
  const versionId = ctx.params.versionId!;
  const pinnedApplication = await ctx.pool.query(
    `SELECT 1 FROM skill_application a
       JOIN skill_application_skill sas ON sas.application_id=a.id
      WHERE a.task_id=$1 AND a.project_id=$2 AND sas.version_id=$3 LIMIT 1`,
    [task.id, task.project_id, versionId],
  );
  if (pinnedApplication.rows.length === 0) {
    await requireAgentDiscoveryEnabled(ctx, ctx.pool);
    await loadUsableVersion(ctx.pool, versionId);
  }
  return { status: 200, data: await versionDto(ctx.pool, skillId, versionId) };
}

export async function createLearningEpisodeHandler(ctx: RequestContext): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  exactFields(body, [
    "schema",
    "observation_key",
    "episode_key",
    "turn_id",
    "end_event_sequence",
    "content_hash",
    "outcome_claim",
    "tool_event_start_sequence",
    "tool_event_end_sequence",
    "evidence_refs",
  ]);
  if (body.schema !== "learning-episode-create.v1") throw validationError("invalid schema");
  const observationKey = textField(body, "observation_key");
  const episodeKey = textField(body, "episode_key");
  const turnId = nullableTextField(body, "turn_id");
  const endSequence = integerField(body, "end_event_sequence", 1);
  const contentHash = hashField(body, "content_hash");
  const outcomeClaim = nullableTextField(body, "outcome_claim");
  const toolStart = nullableIntegerField(body, "tool_event_start_sequence");
  const toolEnd = nullableIntegerField(body, "tool_event_end_sequence");
  const evidenceRefs = jsonArrayField(body, "evidence_refs");
  if ((toolStart === null) !== (toolEnd === null) || (toolStart !== null && toolStart > toolEnd!)) {
    throw validationError("tool event range is invalid");
  }
  const projectId = ctx.params.projectId!;
  const taskId = ctx.params.taskId!;
  const write = await runIdempotent(
    ctx,
    `create_learning_episode:${taskId}:${episodeKey}`,
    projectId,
    async (tx) => {
      const task = await requireTaskBound(ctx, tx, true);
      const derivedObservation = taskObservationKey(task, turnId);
      const derivedEpisode = task.agent_role === "project"
        ? `${derivedObservation}:${endSequence}`
        : `terminal:${endSequence}`;
      if (observationKey !== derivedObservation || episodeKey !== derivedEpisode) {
        throw validationError("episode keys do not match the Core-derived boundary");
      }
      const endEvent = await committedTaskEvent(tx, taskId, endSequence);
      const payload = asObject(endEvent.payload, "end event payload");
      if (endEvent.event_kind !== "status") throw conflictApiError("EPISODE_BOUNDARY_NOT_STATUS");
      const expectedStatus = task.agent_role === "project"
        ? "awaiting_user"
        : task.status;
      const eventStatus = payload.status === "completed" ? "succeeded" : payload.status;
      if (
        eventStatus !== expectedStatus
        || (task.agent_role === "project" && payload.turn_id !== turnId)
        || (task.agent_role !== "project" && !new Set(["succeeded", "failed", "cancelled", "fail_closed"]).has(String(eventStatus)))
      ) {
        throw conflictApiError("EPISODE_BOUNDARY_MISMATCH");
      }
      if (toolStart !== null) {
        const range = await tx.query(
          `SELECT count(*)::int AS count,
                  bool_and($4::text IS NULL OR payload->>'turn_id'=$4) AS same_turn
             FROM task_conversation_event
            WHERE task_id=$1 AND sequence BETWEEN $2 AND $3
              AND event_kind IN ('tool_call','tool_result')`,
          [taskId, toolStart, toolEnd, turnId],
        );
        if (Number((range.rows[0] as Row).count) === 0 || (range.rows[0] as Row).same_turn !== true) {
          throw conflictApiError("EPISODE_TOOL_RANGE_INVALID");
        }
      }
      const existingEpisode = await tx.query(
        `SELECT id FROM learning_episode
          WHERE task_id=$1 AND observation_key=$2 AND episode_key=$3
            AND turn_id IS NOT DISTINCT FROM $4 AND end_event_sequence=$5`,
        [taskId, observationKey, episodeKey, turnId, endSequence],
      );
      if (existingEpisode.rows.length > 0) {
        const existingId = String((existingEpisode.rows[0] as Row).id);
        const enrichmentPayload = {
          content_hash: contentHash,
          outcome_claim: outcomeClaim,
          tool_event_start_sequence: toolStart,
          tool_event_end_sequence: toolEnd,
          evidence_refs: evidenceRefs,
        };
        const enrichment = await tx.query(
          `INSERT INTO learning_episode_enrichment
            (episode_id,content_hash,outcome_claim,tool_event_start_sequence,
             tool_event_end_sequence,evidence_refs,created_by_type,created_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
           ON CONFLICT (episode_id) DO NOTHING
           RETURNING episode_id`,
          [
            existingId,
            contentHash,
            outcomeClaim,
            toolStart,
            toolEnd,
            JSON.stringify(evidenceRefs),
            ctx.identity.actorType,
            ctx.identity.actorId,
          ],
        );
        if (enrichment.rows.length === 0) {
          const prior = await tx.query(
            `SELECT content_hash,outcome_claim,tool_event_start_sequence,
                    tool_event_end_sequence,evidence_refs
               FROM learning_episode_enrichment WHERE episode_id=$1`,
            [existingId],
          );
          const priorRow = prior.rows[0] as Row;
          const priorPayload = {
            content_hash: priorRow.content_hash,
            outcome_claim: priorRow.outcome_claim,
            tool_event_start_sequence: priorRow.tool_event_start_sequence === null
              ? null
              : Number(priorRow.tool_event_start_sequence),
            tool_event_end_sequence: priorRow.tool_event_end_sequence === null
              ? null
              : Number(priorRow.tool_event_end_sequence),
            evidence_refs: priorRow.evidence_refs,
          };
          if (canonicalRequestHash(priorPayload) !== canonicalRequestHash(enrichmentPayload)) {
            throw conflictApiError("EPISODE_ENRICHMENT_CONFLICT");
          }
        }
        await tx.query(
          `UPDATE distillation_run SET ready_at=now(),updated_at=now()
            WHERE episode_id=$1 AND state='queued'`,
          [existingId],
        );
        const bound = await tx.query(
          "SELECT id FROM skill_application WHERE episode_id=$1 ORDER BY id",
          [existingId],
        );
        const settings = await settingsRow(tx);
        return {
          schema: "learning-episode.v1",
          episode_id: existingId,
          observation_key: observationKey,
          episode_key: episodeKey,
          distillation_state: ctx.featureFlags?.selfEvolution !== true
            ? "disabled"
            : settings.learning_paused === true ? "paused" : "queued",
          bound_application_ids: (bound.rows as Row[]).map((row) => row.id),
          replayed: true,
        };
      }
      const maxResult = await tx.query(
        "SELECT max(sequence)::bigint AS sequence FROM task_conversation_event WHERE task_id=$1",
        [taskId],
      );
      if (Number((maxResult.rows[0] as Row).sequence) !== endSequence) {
        throw conflictApiError("EPISODE_BOUNDARY_NOT_CURRENT");
      }
      const episodeId = id("lep");
      await tx.query(
        `INSERT INTO learning_episode
          (id,project_id,task_id,observation_key,episode_key,turn_id,end_event_sequence,
           content_hash,outcome_claim,tool_event_start_sequence,tool_event_end_sequence,
           evidence_refs,created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
        [
          episodeId,
          projectId,
          taskId,
          observationKey,
          episodeKey,
          turnId,
          endSequence,
          contentHash,
          outcomeClaim,
          toolStart,
          toolEnd,
          JSON.stringify(evidenceRefs),
          ctx.identity.actorType,
          ctx.identity.actorId,
        ],
      );
      const bound = await tx.query(
        `UPDATE skill_application
            SET episode_id=$3,
                state=CASE WHEN state IN ('open','closed_pending_episode') THEN 'pending_evaluation' ELSE state END,
                end_event_sequence=CASE WHEN state='open' THEN $4 ELSE end_event_sequence END,
                outcome_claim=CASE WHEN state='open' THEN NULL ELSE outcome_claim END,
                human_corrections=CASE WHEN state='open' THEN 0 ELSE human_corrections END,
                evidence_refs=CASE WHEN state='open' THEN '[]'::jsonb ELSE evidence_refs END,
                tool_run_refs=CASE WHEN state='open' THEN '[]'::jsonb ELSE tool_run_refs END,
                closed_at=CASE WHEN state='open' THEN $5 ELSE closed_at END
          WHERE task_id=$1 AND observation_key=$2 AND episode_id IS NULL
          RETURNING id`,
        [taskId, observationKey, episodeId, endSequence, endEvent.created_at],
      );
      await tx.query(
        `INSERT INTO distillation_run(id,episode_id,state,ready_at,created_at,updated_at)
         VALUES ($1,$2,'queued',now(),now(),now())`,
        [id("dst"), episodeId],
      );
      await appendEvolutionOutbox(tx, ctx, "learning_episode", episodeId, "evolution.episode_created", {
        task_id: taskId,
        episode_key: episodeKey,
      }, projectId);
      const settings = await settingsRow(tx);
      const distillationState = ctx.featureFlags?.selfEvolution !== true
        ? "disabled"
        : settings.learning_paused === true
          ? "paused"
          : "queued";
      return {
        schema: "learning-episode.v1",
        episode_id: episodeId,
        observation_key: observationKey,
        episode_key: episodeKey,
        distillation_state: distillationState,
        bound_application_ids: (bound.rows as Row[]).map((row) => row.id),
        replayed: false,
      };
    },
  );
  return {
    status: 201,
    data: {
      ...(write.result as Record<string, unknown>),
      replayed: write.replayed || (write.result as Row).replayed === true,
    },
  };
}

async function validateToolCall(
  tx: TransactionClient,
  task: BoundTaskRow,
  toolCallId: string,
  turnId: string | null,
  expectedArgs: Record<string, unknown>,
): Promise<Row> {
  const result = await tx.query(
    `SELECT sequence,payload,created_at FROM task_conversation_event
      WHERE task_id=$1 AND event_kind='tool_call' AND payload->>'tool_call_id'=$2
      ORDER BY sequence DESC LIMIT 1`,
    [task.id, toolCallId],
  );
  const event = result.rows[0] as Row | undefined;
  if (!event) throw conflictApiError("TASK_TOOL_CALL_NOT_COMMITTED");
  const payload = asObject(event.payload, "tool call payload");
  if (payload.name !== "learned_skill_apply") {
    throw conflictApiError("TASK_TOOL_CALL_KIND_MISMATCH");
  }
  if (task.agent_role === "project" && payload.turn_id !== turnId) {
    throw conflictApiError("TASK_TOOL_CALL_TURN_MISMATCH");
  }
  const args = asObject(payload.args, "tool call args");
  if (canonicalRequestHash(args) !== canonicalRequestHash(expectedArgs)) {
    throw conflictApiError("TASK_TOOL_CALL_ARGS_MISMATCH");
  }
  return event;
}

export async function createSkillApplicationHandler(ctx: RequestContext): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  exactFields(body, ["schema", "tool_call_id", "turn_id", "version_id", "local_goal", "reason_codes"]);
  if (body.schema !== "skill-application-create.v1") throw validationError("invalid schema");
  const toolCallId = textField(body, "tool_call_id");
  const turnId = nullableTextField(body, "turn_id");
  const versionId = textField(body, "version_id");
  const localGoal = textField(body, "local_goal");
  const reasonCodes = stringArrayField(body, "reason_codes", 20);
  const projectId = ctx.params.projectId!;
  const taskId = ctx.params.taskId!;
  const write = await runIdempotent(
    ctx,
    `create_skill_application:${taskId}:${toolCallId}`,
    projectId,
    async (tx) => {
      await requireAgentDiscoveryEnabled(ctx, tx);
      const task = await requireTaskBound(ctx, tx, true);
      const observationKey = taskObservationKey(task, turnId);
      const event = await validateToolCall(tx, task, toolCallId, turnId, {
        version_id: versionId,
        local_goal: localGoal,
        reason_codes: reasonCodes,
        role: "primary",
      });
      const version = await loadUsableVersion(tx, versionId, true);
      const applicationId = id("app");
      await tx.query(
        `INSERT INTO skill_application
          (id,project_id,task_id,observation_key,local_goal,state,primary_tool_call_id,
           start_event_sequence,started_at,created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10)`,
        [
          applicationId,
          projectId,
          taskId,
          observationKey,
          localGoal,
          toolCallId,
          Number(event.sequence),
          event.created_at,
          ctx.identity.actorType,
          ctx.identity.actorId,
        ],
      );
      await tx.query(
        `INSERT INTO skill_application_skill
          (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
         VALUES ($1,$2,$3,$4,'primary',$5,$6::jsonb)`,
        [id("aps"), applicationId, version.skill_id, versionId, toolCallId, JSON.stringify(reasonCodes)],
      );
      const wasStale = freshnessState(nullableIso(version.last_used_at)) === "stale";
      await tx.query("UPDATE learned_skill SET last_used_at=now() WHERE id=$1", [version.skill_id]);
      if (wasStale) {
        await appendLifecycle(tx, ctx, {
          skillId: String(version.skill_id),
          versionId,
          eventType: "freshness_restored_on_application",
          from: { freshness_state: "stale" },
          to: { freshness_state: "current" },
          reason: "new legal application",
          controlRevision: Number(version.control_revision),
        });
      }
      await appendEvolutionOutbox(tx, ctx, "skill_application", applicationId, "evolution.application_created", {
        task_id: taskId,
        version_id: versionId,
      }, projectId);
      return {
        schema: "skill-application.v1",
        application_id: applicationId,
        observation_key: observationKey,
        episode_id: null,
        state: "open",
        version_id: versionId,
        role: "primary",
        replayed: false,
      };
    },
  );
  return { status: 201, data: { ...(write.result as Row), replayed: write.replayed } };
}

export async function attachSkillApplicationHandler(ctx: RequestContext): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  exactFields(body, ["schema", "tool_call_id", "version_id", "role", "reason_codes"]);
  if (body.schema !== "skill-application-attach.v1" || body.role !== "supporting") {
    throw validationError("supporting attach shape is invalid");
  }
  const applicationId = ctx.params.applicationId!;
  const toolCallId = textField(body, "tool_call_id");
  const versionId = textField(body, "version_id");
  const reasonCodes = stringArrayField(body, "reason_codes", 20);
  const projectId = ctx.params.projectId!;
  const taskId = ctx.params.taskId!;
  const write = await runIdempotent(
    ctx,
    `attach_skill_application:${applicationId}:${toolCallId}`,
    projectId,
    async (tx) => {
      await requireAgentDiscoveryEnabled(ctx, tx);
      const task = await requireTaskBound(ctx, tx, true);
      const appResult = await tx.query(
        "SELECT * FROM skill_application WHERE id=$1 AND task_id=$2 AND project_id=$3 FOR UPDATE",
        [applicationId, taskId, projectId],
      );
      const application = appResult.rows[0] as Row | undefined;
      if (!application) throw notFoundError(`skill application not found: ${applicationId}`);
      if (application.state !== "open") throw conflictApiError("APPLICATION_ALREADY_CLOSED");
      await validateToolCall(
        tx,
        task,
        toolCallId,
        task.agent_role === "project"
          ? String(application.observation_key).slice("turn:".length)
          : null,
        {
          version_id: versionId,
          local_goal: application.local_goal,
          reason_codes: reasonCodes,
          role: "supporting",
          application_id: applicationId,
        },
      );
      const version = await loadUsableVersion(tx, versionId, true);
      await tx.query(
        `INSERT INTO skill_application_skill
          (id,application_id,skill_id,version_id,role,tool_call_id,reason_codes)
         VALUES ($1,$2,$3,$4,'supporting',$5,$6::jsonb)`,
        [id("aps"), applicationId, version.skill_id, versionId, toolCallId, JSON.stringify(reasonCodes)],
      );
      await tx.query("UPDATE learned_skill SET last_used_at=now() WHERE id=$1", [version.skill_id]);
      await appendEvolutionOutbox(tx, ctx, "skill_application", applicationId, "evolution.application_skill_attached", {
        version_id: versionId,
        role: "supporting",
      }, projectId);
      return {
        schema: "skill-application.v1",
        application_id: applicationId,
        observation_key: application.observation_key,
        episode_id: application.episode_id ?? null,
        state: application.state,
        version_id: versionId,
        role: "supporting",
        replayed: false,
      };
    },
  );
  return { status: 201, data: { ...(write.result as Row), replayed: write.replayed } };
}

export async function closeSkillApplicationHandler(ctx: RequestContext): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  exactFields(body, [
    "schema",
    "end_event_sequence",
    "outcome_claim",
    "human_corrections",
    "evidence_refs",
    "tool_run_refs",
  ]);
  if (body.schema !== "skill-application-close.v1") throw validationError("invalid schema");
  const endSequence = integerField(body, "end_event_sequence", 1);
  const outcomeClaim = nullableTextField(body, "outcome_claim");
  const corrections = integerField(body, "human_corrections", 0, 1_000_000);
  const evidenceRefs = jsonArrayField(body, "evidence_refs");
  const toolRunRefs = jsonArrayField(body, "tool_run_refs");
  const applicationId = ctx.params.applicationId!;
  const projectId = ctx.params.projectId!;
  const taskId = ctx.params.taskId!;
  const write = await runIdempotent(
    ctx,
    `close_skill_application:${applicationId}`,
    projectId,
    async (tx) => {
      await requireTaskBound(ctx, tx, true);
      const appResult = await tx.query(
        "SELECT * FROM skill_application WHERE id=$1 AND task_id=$2 AND project_id=$3 FOR UPDATE",
        [applicationId, taskId, projectId],
      );
      const application = appResult.rows[0] as Row | undefined;
      if (!application) throw notFoundError(`skill application not found: ${applicationId}`);
      if (application.state !== "open") throw conflictApiError("APPLICATION_ALREADY_CLOSED");
      if (endSequence < Number(application.start_event_sequence)) {
        throw conflictApiError("APPLICATION_EVENT_RANGE_INVALID");
      }
      const endEvent = await committedTaskEvent(tx, taskId, endSequence);
      const endPayload = asObject(endEvent.payload, "application close event payload");
      if (endEvent.event_kind !== "tool_call" || endPayload.name !== "learned_skill_close") {
        throw conflictApiError("APPLICATION_CLOSE_EVENT_MISMATCH");
      }
      const expectedTurnId = String(application.observation_key).startsWith("turn:")
        ? String(application.observation_key).slice("turn:".length)
        : null;
      if (expectedTurnId !== null && endPayload.turn_id !== expectedTurnId) {
        throw conflictApiError("APPLICATION_CLOSE_EVENT_MISMATCH");
      }
      const closeArgs = asObject(endPayload.args, "application close event args");
      if (canonicalRequestHash(closeArgs) !== canonicalRequestHash({
        application_id: applicationId,
        outcome_claim: outcomeClaim,
        human_corrections: corrections,
        evidence_refs: evidenceRefs,
        tool_run_refs: toolRunRefs,
      })) {
        throw conflictApiError("TASK_TOOL_CALL_ARGS_MISMATCH");
      }
      const state = application.episode_id === null ? "closed_pending_episode" : "pending_evaluation";
      await tx.query(
        `UPDATE skill_application
            SET state=$2,end_event_sequence=$3,outcome_claim=$4,human_corrections=$5,
                evidence_refs=$6::jsonb,tool_run_refs=$7::jsonb,closed_at=$8
          WHERE id=$1`,
        [
          applicationId,
          state,
          endSequence,
          outcomeClaim,
          corrections,
          JSON.stringify(evidenceRefs),
          JSON.stringify(toolRunRefs),
          endEvent.created_at,
        ],
      );
      await appendEvolutionOutbox(tx, ctx, "skill_application", applicationId, "evolution.application_closed", {
        state,
        end_event_sequence: endSequence,
      }, projectId);
      return {
        schema: "skill-application.v1",
        application_id: applicationId,
        state,
        replayed: false,
      };
    },
  );
  return { status: 200, data: { ...(write.result as Row), replayed: write.replayed } };
}

function requireCapability(ctx: RequestContext, scope: string): void {
  if (
    ctx.identity.actorType !== "service"
    || ctx.identity.scopes.length !== 1
    || ctx.identity.scopes[0] !== scope
  ) {
    throw forbiddenError("EVOLUTION_SCOPE_FORBIDDEN");
  }
}

function leaseBody(ctx: RequestContext): { workerId: string; leaseSeconds: number } {
  const body = asObject(ctx.body);
  exactFields(body, ["worker_id", "lease_seconds"]);
  return {
    workerId: textField(body, "worker_id"),
    leaseSeconds: integerField(body, "lease_seconds", 30, 900),
  };
}

async function distillationClaimDto(ctx: RequestContext, run: Row): Promise<Record<string, unknown>> {
  const episodeResult = await ctx.pool.query(
    `SELECT e.*,
            COALESCE(x.content_hash,e.content_hash) AS content_hash,
            COALESCE(x.outcome_claim,e.outcome_claim) AS outcome_claim,
            COALESCE(x.tool_event_start_sequence,e.tool_event_start_sequence) AS tool_event_start_sequence,
            COALESCE(x.tool_event_end_sequence,e.tool_event_end_sequence) AS tool_event_end_sequence,
            COALESCE(x.evidence_refs,e.evidence_refs) AS evidence_refs,
            t.objective
       FROM learning_episode e
       LEFT JOIN learning_episode_enrichment x
         ON x.episode_id=e.id AND x.created_at <= $2::timestamptz
       JOIN agent_task t ON t.id=e.task_id AND t.project_id=e.project_id
      WHERE e.id=$1`,
    [run.episode_id, run.input_cutoff_at],
  );
  const episode = episodeResult.rows[0] as Row;
  const eventsResult = await ctx.pool.query(
    `SELECT sequence,event_kind,payload,payload_hash
       FROM task_conversation_event
      WHERE task_id=$1 AND sequence <= $2
        AND ($3::text IS NULL OR payload->>'turn_id'=$3)
      ORDER BY sequence`,
    [episode.task_id, episode.end_event_sequence, episode.turn_id],
  );
  const events = eventsResult.rows as Row[];
  const messages = events
    .filter((event) => event.event_kind === "user_message" || event.event_kind === "assistant_message")
    .map((event) => {
      const payload = asObject(event.payload, "event payload");
      const content = typeof payload.content === "string"
        ? payload.content
        : typeof payload.text === "string"
          ? payload.text
          : JSON.stringify(payload);
      return {
        sequence: Number(event.sequence),
        role: event.event_kind === "user_message" ? "user" : "assistant",
        content: sanitizeTrajectoryText(content),
        content_hash: sha256Hex(content),
      };
    });
  const toolEvents = events.filter((event) => {
    if (event.event_kind !== "tool_call" && event.event_kind !== "tool_result") return false;
    if (episode.tool_event_start_sequence === null) return true;
    return Number(event.sequence) >= Number(episode.tool_event_start_sequence)
      && Number(event.sequence) <= Number(episode.tool_event_end_sequence);
  });
  const applicationResult = await ctx.pool.query(
    `SELECT start_event_sequence,end_event_sequence,human_corrections,evidence_refs,tool_run_refs
       FROM skill_application WHERE episode_id=$1 ORDER BY started_at,id`,
    [episode.id],
  );
  const applications = applicationResult.rows as Row[];
  const stringRefs = (value: unknown): string[] => Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item))
    : [];
  const refsForSequence = (sequence: number, field: "evidence_refs" | "tool_run_refs"): string[] => [
    ...new Set(applications.flatMap((application) => {
      const end = application.end_event_sequence === null
        ? Number(episode.end_event_sequence)
        : Number(application.end_event_sequence);
      return sequence >= Number(application.start_event_sequence) && sequence <= end
        ? stringRefs(application[field])
        : [];
    })),
  ];
  const resultsByCall = new Map<string, Row>();
  for (const event of toolEvents.filter((candidate) => candidate.event_kind === "tool_result")) {
    const payload = asObject(event.payload, "tool result payload");
    if (typeof payload.tool_call_id === "string") resultsByCall.set(payload.tool_call_id, event);
  }
  const tools = toolEvents.filter((event) => event.event_kind === "tool_call").map((event) => {
    const payload = asObject(event.payload, "tool call payload");
    const toolCallId = String(payload.tool_call_id ?? "");
    const resultEvent = resultsByCall.get(toolCallId);
    const resultPayload = resultEvent ? asObject(resultEvent.payload, "tool result payload") : null;
    return {
      call_sequence: Number(event.sequence),
      result_sequence: resultEvent ? Number(resultEvent.sequence) : null,
      tool_call_id: sanitizeTrajectoryRef("TOOL_CALL_REF", toolCallId),
      name: sanitizeTrajectoryText(String(payload.name ?? "")),
      args: sanitizeTrajectoryValue(payload.args ?? null, "args"),
      args_hash: rawTrajectoryHash(payload.args ?? null),
      result: sanitizeTrajectoryValue(resultPayload?.result ?? null, "result"),
      result_hash: rawTrajectoryHash(resultPayload?.result ?? null),
      is_error: resultPayload ? resultPayload.ok === false : false,
      tool_run_refs: refsForSequence(Number(event.sequence), "tool_run_refs")
        .map((ref) => sanitizeTrajectoryRef("TOOL_RUN_REF", ref)),
      evidence_refs: refsForSequence(Number(event.sequence), "evidence_refs")
        .map((ref) => sanitizeTrajectoryRef("EVIDENCE_REF", ref)),
    };
  });
  const firstAssistantSequence = messages.find((message) => message.role === "assistant")?.sequence
    ?? Number.POSITIVE_INFINITY;
  const humanCorrections = events
    .filter((event) => {
      if (event.event_kind !== "user_message") return false;
      const payload = asObject(event.payload, "event payload");
      return payload.human_correction === true
        || payload.correction === true
        || Number(event.sequence) > firstAssistantSequence;
    })
    .map((event) => {
      const payload = asObject(event.payload, "event payload");
      const content = typeof payload.content === "string"
        ? payload.content
        : typeof payload.text === "string"
          ? payload.text
          : JSON.stringify(payload);
      return {
        sequence: Number(event.sequence),
        content: sanitizeTrajectoryText(content),
        content_hash: sha256Hex(content),
      };
    });
  const skillIdsResult = await ctx.pool.query("SELECT id FROM learned_skill ORDER BY id");
  const existingSkills = await Promise.all(
    (skillIdsResult.rows as Row[]).map((row) => skillSummary(ctx.pool, String(row.id))),
  );
  return {
    schema: "distillation-claim.v1",
    run: {
      run_id: run.id,
      state: "running",
      attempt: Number(run.attempt),
      lease_token: run.lease_token,
      lease_expires_at: iso(run.lease_expires_at),
      episode: {
        episode_id: sanitizeTrajectoryRef("EPISODE_REF", String(episode.id)),
        observation_key: sanitizeTrajectoryRef("OBSERVATION_REF", String(episode.observation_key)),
        episode_key: sanitizeTrajectoryRef("EPISODE_KEY", String(episode.episode_key)),
        project_ref: sanitizeTrajectoryRef("PROJECT_REF", String(episode.project_id)),
        task_ref: sanitizeTrajectoryRef("TASK_REF", String(episode.task_id)),
        turn_id: episode.turn_id === null
          ? null
          : sanitizeTrajectoryRef("TURN_REF", String(episode.turn_id)),
        end_event_sequence: Number(episode.end_event_sequence),
        content_hash: episode.content_hash,
        outcome_claim: episode.outcome_claim === null
          ? null
          : sanitizeTrajectoryText(String(episode.outcome_claim)),
      },
      trajectory: {
        schema: "learning-trajectory.v1",
        objective: sanitizeTrajectoryText(String(episode.objective)),
        messages,
        tools,
        human_corrections: humanCorrections,
      },
      existing_skills: existingSkills,
    },
  };
}

export async function claimDistillationRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-distiller");
  const { workerId, leaseSeconds } = leaseBody(ctx);
  requireRollout(ctx);
  const settings = await settingsRow(ctx.pool);
  if (settings.learning_paused === true) {
    return { status: 200, data: { schema: "distillation-claim.v1", run: null } };
  }
  const conn = await ctx.pool.connect();
  let run: Row | null = null;
  try {
    run = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      const selected = await tx.query(
        `SELECT * FROM distillation_run
          WHERE (state='queued' AND ready_at <= now())
             OR (state='running' AND lease_expires_at <= now())
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) return null;
      const token = randomUUID();
      const updated = await tx.query(
        `UPDATE distillation_run
            SET state='running',attempt=attempt+1,worker_id=$2,lease_token=$3,
                lease_expires_at=now()+($4::int * interval '1 second'),updated_at=now(),
                input_cutoff_at=COALESCE(input_cutoff_at,now()),
                completed_at=NULL
          WHERE id=$1 RETURNING *`,
        [row.id, workerId, token, leaseSeconds],
      );
      return updated.rows[0] as Row;
    });
  } finally {
    conn.release();
  }
  return {
    status: 200,
    data: run ? await distillationClaimDto(ctx, run) : { schema: "distillation-claim.v1", run: null },
  };
}

async function renewLease(
  ctx: RequestContext,
  table: "distillation_run" | "curator_run",
  runId: string,
): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  exactFields(body, ["lease_token", "lease_seconds"]);
  const token = textField(body, "lease_token");
  const leaseSeconds = integerField(body, "lease_seconds", 30, 900);
  const result = await ctx.pool.query(
    `UPDATE ${table}
        SET lease_expires_at=now()+($3::int * interval '1 second'),updated_at=now()
      WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_expires_at > now()
      RETURNING lease_expires_at`,
    [runId, token, leaseSeconds],
  );
  const row = result.rows[0] as Row | undefined;
  if (!row) throw conflictApiError("EVOLUTION_LEASE_CONFLICT");
  return {
    status: 200,
    data: {
      schema: table === "distillation_run" ? "distillation-lease.v1" : "curator-lease.v1",
      run_id: runId,
      lease_expires_at: iso(row.lease_expires_at),
    },
  };
}

export async function renewDistillationLeaseHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-distiller");
  return renewLease(ctx, "distillation_run", ctx.params.runId!);
}

interface DistillationSkillPayload {
  readonly skillId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly applicability: unknown;
  readonly outcomeContract: unknown;
  readonly files: LearnedSkillFileInput[];
}

function distillationSkill(value: unknown): DistillationSkillPayload {
  const skill = asObject(value, "skill");
  exactFields(
    skill,
    ["skill_id", "slug", "name", "summary", "description", "applicability", "outcome_contract", "files"],
    ["slug", "name", "summary", "description", "applicability", "outcome_contract", "files"],
  );
  const skillId = skill.skill_id === undefined ? null : nullableTextField(skill, "skill_id");
  const slug = textField(skill, "slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw validationError("field 'skill.slug' must be kebab-case");
  }
  const files = jsonArrayField(skill, "files", 64).map((raw, index) => {
    const file = asObject(raw, `skill.files[${index}]`);
    exactFields(file, ["path", "kind", "language", "content"]);
    const kind = enumField(file, "kind", new Set(["skill_md", "reference", "template", "script"] as const));
    const language = file.language === null
      ? null
      : enumField(file, "language", new Set(["tcl", "python", "typescript"] as const));
    return {
      path: textField(file, "path"),
      kind,
      language,
      content: textField(file, "content"),
    };
  });
  return {
    skillId,
    slug,
    name: textField(skill, "name"),
    summary: textField(skill, "summary"),
    description: textField(skill, "description"),
    applicability: structuredJsonField(skill, "applicability"),
    outcomeContract: structuredJsonField(skill, "outcome_contract"),
    files,
  };
}

function applicabilitySummary(applicability: unknown): string {
  if (applicability && typeof applicability === "object" && !Array.isArray(applicability)) {
    const summary = (applicability as Row).summary;
    if (typeof summary === "string" && summary.trim() !== "") return summary.trim().slice(0, 2_000);
  }
  return JSON.stringify(applicability).slice(0, 2_000) || "See version applicability";
}

export async function completeDistillationRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-distiller");
  const body = asObject(ctx.body);
  exactFields(body, [
    "lease_token",
    "input_hash",
    "model_id",
    "prompt_hash",
    "action",
    "expected_parent_version_id",
    "expected_control_revision",
    "skill",
  ]);
  const leaseToken = textField(body, "lease_token");
  hashField(body, "input_hash");
  textField(body, "model_id");
  hashField(body, "prompt_hash");
  const action = enumField(body, "action", new Set(["no_op", "create", "patch"] as const));
  const requestHash = canonicalRequestHash(body);
  const expectedParent = body.expected_parent_version_id === null
    ? null
    : textField(body, "expected_parent_version_id");
  const expectedRevision = body.expected_control_revision === null
    ? null
    : integerField(body, "expected_control_revision", 1);
  let skill: DistillationSkillPayload | null = null;
  if (action === "no_op") {
    if (body.skill !== null || expectedParent !== null || expectedRevision !== null) {
      throw validationError("no_op must not carry skill or CAS fields");
    }
  } else {
    if (body.skill === null) throw validationError(`${action} requires skill`);
    skill = distillationSkill(body.skill);
    if (action === "create" && (skill.skillId !== null || expectedParent !== null || expectedRevision !== null)) {
      throw validationError("create must not carry skill_id or CAS fields");
    }
    if (action === "patch" && (skill.skillId === null || expectedParent === null || expectedRevision === null)) {
      throw validationError("patch requires skill_id and both CAS fields");
    }
  }
  const runId = ctx.params.runId!;
  const conn = await ctx.pool.connect();
  try {
    const result = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      const runResult = await tx.query(
        `SELECT r.*,e.project_id FROM distillation_run r
           JOIN learning_episode e ON e.id=r.episode_id
          WHERE r.id=$1 FOR UPDATE OF r`,
        [runId],
      );
      const run = runResult.rows[0] as Row | undefined;
      if (!run) throw notFoundError(`distillation run not found: ${runId}`);
      if (TERMINAL_DISTILLATION_STATES.has(String(run.state))) {
        if (run.terminal_request_hash !== requestHash) throw conflictApiError("EVOLUTION_CAS_CONFLICT");
        return { ...(run.terminal_result as Row), replayed: true };
      }
      await requireLearningWritable(ctx, tx);
      if (
        run.state !== "running"
        || run.lease_token !== leaseToken
        || new Date(String(run.lease_expires_at)).getTime() <= Date.now()
      ) {
        throw conflictApiError("EVOLUTION_LEASE_CONFLICT");
      }
      if (action === "no_op") {
        const terminal = {
          schema: "distillation-result.v1",
          run_id: runId,
          state: "noop",
          version_id: null,
          replayed: false,
        };
        await tx.query(
          `UPDATE distillation_run
              SET state='noop',terminal_request_hash=$2,terminal_result=$3::jsonb,
                  completed_at=now(),updated_at=now()
            WHERE id=$1`,
          [runId, requestHash, JSON.stringify(terminal)],
        );
        return terminal;
      }
      const payload = skill!;
      const scan = scanLearnedSkillPackage(payload.files, {
        name: payload.name,
        summary: payload.summary,
        description: payload.description,
        applicability: payload.applicability,
        outcomeContract: payload.outcomeContract,
      });
      let skillId = payload.skillId;
      let versionNo = 1;
      let fromProjection: Record<string, unknown> = {};
      if (action === "create") {
        // Serialize by slug so a quarantined first candidate cannot either
        // strand the namespace or race a concurrent rebuild.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [payload.slug]);
        const slugResult = await tx.query(
          "SELECT * FROM learned_skill WHERE slug=$1 FOR UPDATE",
          [payload.slug],
        );
        const existingSlug = slugResult.rows[0] as Row | undefined;
        if (existingSlug) {
          if (existingSlug.active_version_id !== null) {
            throw conflictApiError("SKILL_SLUG_CONFLICT");
          }
          if (
            existingSlug.pinned === true
            || existingSlug.enabled !== true
            || existingSlug.availability_state !== "available"
          ) {
            throw conflictApiError("SKILL_NOT_AVAILABLE");
          }
          const reusableCandidate = await tx.query(
            `SELECT bool_and(vs.quality_state='quarantined') AS all_quarantined,
                    count(*)::int AS version_count
               FROM learned_skill_version v
               JOIN learned_skill_version_status vs ON vs.version_id=v.id
              WHERE v.skill_id=$1`,
            [existingSlug.id],
          );
          const candidateState = reusableCandidate.rows[0] as Row;
          if (
            Number(candidateState.version_count) === 0
            || candidateState.all_quarantined !== true
          ) {
            throw conflictApiError("SKILL_NOT_AVAILABLE");
          }
          skillId = String(existingSlug.id);
          const versionResult = await tx.query(
            "SELECT COALESCE(max(version_no),0)+1 AS version_no FROM learned_skill_version WHERE skill_id=$1",
            [skillId],
          );
          versionNo = Number((versionResult.rows[0] as Row).version_no);
          fromProjection = {
            active_version_id: null,
            control_revision: Number(existingSlug.control_revision),
            recovered_quarantined_slug: true,
          };
        } else {
          skillId = id("lsk");
          await tx.query(
            `INSERT INTO learned_skill
              (id,slug,name,summary,applicability_summary,enabled,pinned,availability_state,
              active_version_id,control_revision,created_by_type,created_by)
             VALUES ($1,$2,$3,$4,$5,true,false,'available',NULL,1,$6,$7)`,
            [
              skillId,
              payload.slug,
              scan.decision === "pass" ? payload.name : "Quarantined candidate",
              scan.decision === "pass" ? payload.summary : "Candidate failed deterministic scan",
              scan.decision === "pass"
                ? applicabilitySummary(payload.applicability)
                : "Unavailable pending a passing deterministic scan",
              ctx.identity.actorType,
              ctx.identity.actorId,
            ],
          );
        }
      } else {
        const existingResult = await tx.query("SELECT * FROM learned_skill WHERE id=$1 FOR UPDATE", [skillId]);
        const existing = existingResult.rows[0] as Row | undefined;
        if (!existing) throw notFoundError(`learned skill not found: ${skillId}`);
        if (
          existing.active_version_id !== expectedParent
          || Number(existing.control_revision) !== expectedRevision
        ) {
          throw conflictApiError("EVOLUTION_CAS_CONFLICT");
        }
        if (existing.pinned === true || existing.enabled !== true || existing.availability_state !== "available") {
          throw conflictApiError("SKILL_NOT_AVAILABLE");
        }
        const versionResult = await tx.query(
          "SELECT COALESCE(max(version_no),0)+1 AS version_no FROM learned_skill_version WHERE skill_id=$1",
          [skillId],
        );
        versionNo = Number((versionResult.rows[0] as Row).version_no);
        fromProjection = {
          active_version_id: existing.active_version_id,
          control_revision: Number(existing.control_revision),
        };
      }
      const versionId = id("lsv");
      await tx.query(
        `INSERT INTO learned_skill_version
          (id,skill_id,version_no,parent_version_id,description,applicability,outcome_contract,
           content_manifest_hash,scanner_version,scan_decision,scan_findings,distillation_run_id,
           created_by_type,created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
        [
          versionId,
          skillId,
          versionNo,
          action === "patch" ? expectedParent : null,
          payload.description,
          JSON.stringify(payload.applicability),
          JSON.stringify(payload.outcomeContract),
          scan.contentManifestHash,
          scan.scannerVersion,
          scan.decision,
          JSON.stringify(scan.findings),
          runId,
          ctx.identity.actorType,
          ctx.identity.actorId,
        ],
      );
      await tx.query(
        `INSERT INTO learned_skill_version_status(version_id,quality_state)
         VALUES ($1,$2)`,
        [versionId, scan.decision === "pass" ? "active_unproven" : "quarantined"],
      );
      for (const file of scan.files) {
        await tx.query(
          `INSERT INTO learned_skill_file
            (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id("lsf"),
            versionId,
            file.path,
            file.kind,
            file.language,
            file.sha256,
            file.sizeBytes,
            file.mediaType,
            file.content,
          ],
        );
      }
      let revision = action === "patch" ? expectedRevision! : 1;
      if (scan.decision === "pass") {
        if (action === "patch") revision += 1;
        await tx.query(
          `UPDATE learned_skill
              SET name=$2,summary=$3,applicability_summary=$4,active_version_id=$5,
                  control_revision=$6,updated_at=now()
            WHERE id=$1`,
          [
            skillId,
            payload.name,
            payload.summary,
            applicabilitySummary(payload.applicability),
            versionId,
            revision,
          ],
        );
      }
      const toProjection = {
        active_version_id: scan.decision === "pass" ? versionId : action === "patch" ? expectedParent : null,
        control_revision: revision,
        quality_state: scan.decision === "pass" ? "active_unproven" : "quarantined",
      };
      await appendLifecycle(tx, ctx, {
        skillId: skillId!,
        versionId,
        eventType: scan.decision === "pass" ? `${action}_version_activated` : "candidate_quarantined",
        from: fromProjection,
        to: toProjection,
        reason: scan.decision === "pass" ? "distillation completed" : "deterministic scan failed",
        controlRevision: revision,
      });
      const terminal = {
        schema: "distillation-result.v1",
        run_id: runId,
        state: scan.decision === "pass" ? "succeeded" : "quarantined",
        version_id: versionId,
        replayed: false,
      };
      await tx.query(
        `UPDATE distillation_run
            SET state=$2,terminal_request_hash=$3,terminal_result=$4::jsonb,
                completed_at=now(),updated_at=now()
          WHERE id=$1`,
        [runId, terminal.state, requestHash, JSON.stringify(terminal)],
      );
      await appendEvolutionOutbox(tx, ctx, "learned_skill", skillId!, "evolution.distillation_completed", {
        run_id: runId,
        version_id: versionId,
        state: terminal.state,
      }, String(run.project_id));
      return terminal;
    });
    return { status: 200, data: result };
  } finally {
    conn.release();
  }
}

async function failLeasedRun(
  ctx: RequestContext,
  table: "distillation_run" | "curator_run",
  runId: string,
): Promise<HandlerResult> {
  const body = asObject(ctx.body);
  exactFields(body, ["lease_token", "error_code", "retryable", "details_hash"]);
  const token = textField(body, "lease_token");
  const errorCode = textField(body, "error_code");
  const retryable = booleanField(body, "retryable");
  const detailsHash = hashField(body, "details_hash");
  const conn = await ctx.pool.connect();
  let row: Row;
  try {
    row = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      if (table === "curator_run") {
        const runResult = await tx.query(
          `SELECT state,lease_token,lease_expires_at
             FROM curator_run WHERE id=$1 FOR UPDATE`,
          [runId],
        );
        const run = runResult.rows[0] as Row | undefined;
        if (
          !run
          || run.state !== "running"
          || run.lease_token !== token
          || new Date(String(run.lease_expires_at)).getTime() <= Date.now()
        ) {
          throw conflictApiError("EVOLUTION_LEASE_CONFLICT");
        }
        await validateCuratorEvolutionFailure(tx, runId);
      }
      const result = await tx.query(
        `UPDATE ${table}
            SET state=CASE WHEN $3 THEN 'queued' ELSE 'failed' END,
                worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,error_code=$4,details_hash=$5,
                completed_at=CASE WHEN $3 THEN NULL ELSE now() END,updated_at=now()
          WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_expires_at > now()
          RETURNING state`,
        [runId, token, retryable, errorCode, detailsHash],
      );
      const updated = result.rows[0] as Row | undefined;
      if (!updated) throw conflictApiError("EVOLUTION_LEASE_CONFLICT");
      if (table === "curator_run" && !retryable) {
        await tx.query(
          `UPDATE evolution_eval_run SET completed_at=COALESCE(completed_at,clock_timestamp())
            WHERE curator_run_id=$1`,
          [runId],
        );
        await tx.query(
          `DELETE FROM curator_application_reservation reservation
            WHERE reservation.curator_run_id=$1
              AND NOT EXISTS (
                SELECT 1 FROM evolution_eval_job job
                 WHERE job.curator_run_id=reservation.curator_run_id
                   AND job.application_id=reservation.application_id
              )`,
          [runId],
        );
      }
      return updated;
    });
  } finally {
    conn.release();
  }
  return {
    status: 200,
    data: {
      schema: table === "distillation_run" ? "distillation-failure.v1" : "curator-failure.v1",
      run_id: runId,
      state: row.state,
    },
  };
}

export async function failDistillationRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-distiller");
  return failLeasedRun(ctx, "distillation_run", ctx.params.runId!);
}

async function applicationSnapshotHash(query: QueryClient, applicationId: string): Promise<string> {
  const appResult = await query.query("SELECT * FROM skill_application WHERE id=$1", [applicationId]);
  const application = appResult.rows[0] as Row | undefined;
  if (!application) throw notFoundError(`skill application not found: ${applicationId}`);
  const skills = await query.query(
    `SELECT skill_id,version_id,role,reason_codes FROM skill_application_skill
      WHERE application_id=$1 ORDER BY role,version_id`,
    [applicationId],
  );
  return canonicalRequestHash({
    schema: "curator-evidence-snapshot.v1",
    application: {
      id: application.id,
      project_id: application.project_id,
      task_id: application.task_id,
      observation_key: application.observation_key,
      episode_id: application.episode_id,
      local_goal: application.local_goal,
      state: application.state,
      start_event_sequence: Number(application.start_event_sequence),
      end_event_sequence: application.end_event_sequence === null
        ? null
        : Number(application.end_event_sequence),
      outcome_claim: application.outcome_claim,
      human_corrections: application.human_corrections === null
        ? null
        : Number(application.human_corrections),
      evidence_refs: application.evidence_refs,
      tool_run_refs: application.tool_run_refs,
    },
    skills: skills.rows,
  });
}

async function curatorApplicationBundle(
  ctx: RequestContext,
  applicationId: string,
): Promise<Record<string, unknown>> {
  const primaryResult = await ctx.pool.query(
    `SELECT sas.skill_id,sas.version_id,v.content_manifest_hash,v.description,
            v.applicability,v.outcome_contract
       FROM skill_application_skill sas
       JOIN learned_skill_version v ON v.id=sas.version_id
      WHERE sas.application_id=$1 AND sas.role='primary'`,
    [applicationId],
  );
  const primary = primaryResult.rows[0] as Row | undefined;
  if (!primary) throw conflictApiError("APPLICATION_PRIMARY_MISSING");
  const filesResult = await ctx.pool.query(
    `SELECT path,kind,language,sha256,content FROM learned_skill_file
      WHERE version_id=$1 ORDER BY path`,
    [primary.version_id],
  );
  const appResult = await ctx.pool.query(
    "SELECT project_id,evidence_refs,tool_run_refs FROM skill_application WHERE id=$1",
    [applicationId],
  );
  const app = appResult.rows[0] as Row;
  const refs = [
    ...(Array.isArray(app.evidence_refs) ? app.evidence_refs : []),
    ...(Array.isArray(app.tool_run_refs) ? app.tool_run_refs : []),
  ];
  const sourceVisible = await canViewProject(ctx, String(app.project_id));
  return {
    application: await applicationDetail(ctx, applicationId),
    primary_version: {
      skill: await skillSummary(ctx.pool, String(primary.skill_id)),
      version_id: primary.version_id,
      content_manifest_hash: primary.content_manifest_hash,
      description: primary.description,
      applicability: primary.applicability,
      outcome_contract: primary.outcome_contract,
      files: (filesResult.rows as Row[]).map((file) => ({
        path: file.path,
        kind: file.kind,
        language: file.language ?? null,
        sha256: file.sha256,
        content: file.content,
      })),
    },
    evidence_snapshot_hash: await applicationSnapshotHash(ctx.pool, applicationId),
    evidence: refs.map((ref) => {
      const serialized = typeof ref === "string" ? ref : JSON.stringify(ref);
      return {
        type: sourceVisible ? "reference" : "redacted",
        id: sourceVisible ? serialized : "redacted",
        sha256: sha256Hex(serialized),
        summary: sourceVisible ? "Core-recorded application evidence reference" : "redacted",
        content: null,
      };
    }),
  };
}

export async function ensureScheduledCuratorRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-scheduler");
  requireRollout(ctx);
  const body = asObject(ctx.body);
  exactFields(body, ["request_key"]);
  const requestKey = textField(body, "request_key");
  const conn = await ctx.pool.connect();
  try {
    const result = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('curator-scheduler',0))");
      const lastCompletedResult = await tx.query(
        `SELECT id,completed_at FROM curator_run
          WHERE state='completed' AND mode='run'
          ORDER BY completed_at DESC,id DESC LIMIT 1`,
      );
      const lastCompleted = lastCompletedResult.rows[0] as Row | undefined;
      const scheduleBucket = lastCompleted
        ? `scheduled:after:${String(lastCompleted.id)}`
        : "scheduled:initial";
      const eligibleAt = lastCompleted
        ? new Date(
          new Date(lastCompleted.completed_at as string | Date).getTime() + 7 * 24 * 60 * 60 * 1000,
        )
        : new Date(0);
      const existingResult = await tx.query(
        "SELECT * FROM curator_run WHERE schedule_bucket=$1 AND manual_key IS NULL FOR UPDATE",
        [scheduleBucket],
      );
      const existing = existingResult.rows[0] as Row | undefined;
      const settings = await settingsRow(tx, true);
      if (settings.learning_paused === true) {
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "no_work",
          curator_run_id: null,
          reason_code: "learning_paused",
          replayed: false,
        };
      }
      if (eligibleAt.getTime() > Date.now()) {
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "no_work",
          curator_run_id: null,
          reason_code: "not_eligible",
          replayed: false,
        };
      }
      if (existing && (existing.state === "queued" || existing.state === "running")) {
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "queued",
          curator_run_id: existing.id,
          reason_code: "already_materialized",
          replayed: true,
        };
      }
      if (existing && (existing.state === "completed" || existing.state === "dry_run_complete")) {
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "already_completed",
          curator_run_id: existing.id,
          reason_code: `terminal_${String(existing.state)}`,
          replayed: true,
        };
      }
      const activeResult = await tx.query(
        `SELECT id FROM curator_run
          WHERE state IN ('queued','running') AND ($1::text IS NULL OR id<>$1)
          ORDER BY created_at,id LIMIT 1`,
        [existing?.id ?? null],
      );
      if (activeResult.rows.length > 0) {
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "no_work",
          curator_run_id: null,
          reason_code: "active_run",
          replayed: false,
        };
      }
      const pendingResult = await tx.query(
        "SELECT 1 FROM skill_application WHERE state='pending_evaluation' LIMIT 1",
      );
      if (pendingResult.rows.length === 0) {
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "no_work",
          curator_run_id: null,
          reason_code: "no_pending_applications",
          replayed: false,
        };
      }
      if (existing?.state === "failed") {
        const attempt = Math.max(1, Number(existing.attempt));
        const backoffMs = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(6, attempt - 1));
        const retryNotBefore = new Date(
          new Date(existing.completed_at as string | Date).getTime() + backoffMs,
        );
        if (retryNotBefore.getTime() > Date.now()) {
          return {
            schema: "curator-schedule.v1",
            request_key: requestKey,
            schedule_bucket: scheduleBucket,
            eligible_at: eligibleAt.toISOString(),
            state: "no_work",
            curator_run_id: existing.id,
            reason_code: "retry_backoff",
            retry_not_before: retryNotBefore.toISOString(),
            replayed: true,
          };
        }
        const retried = await tx.query(
          `UPDATE curator_run
              SET state='queued',error_code=NULL,details_hash=NULL,completed_at=NULL,updated_at=now()
            WHERE id=$1 RETURNING id`,
          [existing.id],
        );
        return {
          schema: "curator-schedule.v1",
          request_key: requestKey,
          schedule_bucket: scheduleBucket,
          eligible_at: eligibleAt.toISOString(),
          state: "queued",
          curator_run_id: (retried.rows[0] as Row).id,
          reason_code: "rematerialized_after_failure",
          replayed: false,
        };
      }
      const runId = `cur_${sha256Hex(`scheduled:${scheduleBucket}`).slice(0, 40)}`;
      await tx.query(
        `INSERT INTO curator_run
          (id,mode,state,schedule_bucket,manual_key,eligible_at,reason,created_by_type,created_by)
         VALUES ($1,'run','queued',$2,NULL,$3,'scheduled seven-day curation',$4,$5)`,
        [runId, scheduleBucket, eligibleAt, ctx.identity.actorType, ctx.identity.actorId],
      );
      await appendEvolutionOutbox(tx, ctx, "curator_run", runId, "evolution.curator_run_queued", {
        mode: "run",
        schedule_bucket: scheduleBucket,
        eligible_at: eligibleAt.toISOString(),
      });
      return {
        schema: "curator-schedule.v1",
        request_key: requestKey,
        schedule_bucket: scheduleBucket,
        eligible_at: eligibleAt.toISOString(),
        state: "queued",
        curator_run_id: runId,
        reason_code: "materialized",
        replayed: false,
      };
    });
    return { status: 200, data: result };
  } finally {
    conn.release();
  }
}

async function claimCuratorRun(
  ctx: RequestContext,
  lane: "manual" | "scheduled",
): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-curator");
  if (ctx.url.search.length > 0) throw validationError("query parameters are not allowed");
  const { workerId, leaseSeconds } = leaseBody(ctx);
  requireRollout(ctx);
  const conn = await ctx.pool.connect();
  let claim: {
    readonly run: Row;
    readonly applications: readonly {
      readonly applicationId: string;
      readonly evidenceSnapshotHash: string;
    }[];
    readonly evalMaterialization: EvolutionEvalClaimMaterialization;
  } | null = null;
  try {
    claim = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      const settings = await settingsRow(tx);
      const lanePredicate = lane === "manual"
        ? "manual_key IS NOT NULL"
        : `manual_key IS NULL
           AND schedule_bucket=COALESCE(
             (SELECT 'scheduled:after:' || completed.id
                FROM curator_run completed
               WHERE completed.state='completed' AND completed.mode='run'
               ORDER BY completed.completed_at DESC,completed.id DESC LIMIT 1),
             'scheduled:initial')
           AND EXISTS (
             SELECT 1 FROM skill_application pending
              WHERE pending.state='pending_evaluation'
           )`;
      const selected = await tx.query(
        `SELECT * FROM curator_run
          WHERE (state='queued' OR (state='running' AND lease_expires_at <= now()))
            AND ${lanePredicate}
            AND ($1::boolean=false OR mode='dry_run')
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [settings.learning_paused === true],
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) return null;
      const token = randomUUID();
      const updated = await tx.query(
        `UPDATE curator_run
            SET state='running',attempt=attempt+1,worker_id=$2,lease_token=$3,
                lease_expires_at=now()+($4::int * interval '1 second'),updated_at=now(),
                completed_at=NULL
          WHERE id=$1 RETURNING *`,
        [row.id, workerId, token, leaseSeconds],
      );
      await tx.query(
        `DELETE FROM curator_application_reservation r
          USING curator_run stale
          WHERE stale.id=r.curator_run_id
            AND stale.state IN ('completed','dry_run_complete','failed')
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_job job
               WHERE job.curator_run_id=r.curator_run_id
                 AND job.application_id=r.application_id
            )`,
      );
      const existing = await tx.query(
        "SELECT count(*)::int AS count FROM curator_application_reservation WHERE curator_run_id=$1",
        [row.id],
      );
      const remaining = Math.max(0, 100 - Number((existing.rows[0] as Row).count));
      if (remaining > 0) {
        await tx.query(
          `INSERT INTO curator_application_reservation(curator_run_id,application_id)
           SELECT $1,a.id FROM skill_application a
            WHERE a.state='pending_evaluation'
              AND NOT EXISTS (
                SELECT 1 FROM curator_application_reservation held
                 WHERE held.application_id=a.id
              )
            ORDER BY a.closed_at,a.id
            LIMIT $2
           ON CONFLICT (application_id) DO NOTHING`,
          [row.id, remaining],
        );
      }
      const claimedRun = updated.rows[0] as Row;
      const applicationsResult = await tx.query(
        `SELECT a.id FROM curator_application_reservation r
           JOIN skill_application a ON a.id=r.application_id
          WHERE r.curator_run_id=$1 AND a.state='pending_evaluation'
          ORDER BY a.closed_at,a.id`,
        [row.id],
      );
      const applications: Array<{
        applicationId: string;
        evidenceSnapshotHash: string;
      }> = [];
      for (const applicationRow of applicationsResult.rows as Row[]) {
        const applicationId = String(applicationRow.id);
        applications.push({
          applicationId,
          evidenceSnapshotHash: await applicationSnapshotHash(tx, applicationId),
        });
      }
      const evalMaterialization = await materializeEvolutionEvalClaim(
        tx,
        ctx,
        { id: String(claimedRun.id), mode: String(claimedRun.mode) },
        applications,
      );
      return { run: claimedRun, applications, evalMaterialization };
    });
  } finally {
    conn.release();
  }
  if (!claim) return { status: 200, data: { schema: "curator-claim.v1", run: null } };
  const { run, applications: claimedApplications, evalMaterialization } = claim;
  const evalRecovery = run.mode === "dry_run"
    ? evalMaterialization.recovery
    : await reconcileEvolutionEvalAfterCommit(ctx, String(run.id));
  const applications = await Promise.all(
    claimedApplications.map(async (application) => ({
      ...await curatorApplicationBundle(ctx, application.applicationId),
      eval_input: evalMaterialization.evalInputs.get(application.applicationId) ?? null,
      evidence_snapshot_hash: application.evidenceSnapshotHash,
    })),
  );
  return {
    status: 200,
    data: {
      schema: "curator-claim.v1",
      run: {
        run_id: run.id,
        mode: run.mode,
        state: "running",
        attempt: Number(run.attempt),
        lease_token: run.lease_token,
        lease_expires_at: iso(run.lease_expires_at),
        schedule_bucket: run.schedule_bucket,
        eval_recovery: evalRecovery,
        applications,
      },
    },
  };
}

export async function claimManualCuratorRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  return await claimCuratorRun(ctx, "manual");
}

export async function claimScheduledCuratorRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  return await claimCuratorRun(ctx, "scheduled");
}

export async function renewCuratorLeaseHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-curator");
  return renewLease(ctx, "curator_run", ctx.params.runId!);
}

interface CuratorEvaluationPayload {
  readonly applicationId: string;
  readonly evidenceSnapshotHash: string;
  readonly outcome: EvaluationOutcome;
  readonly confidence: number;
  readonly reason: string;
  readonly evidenceRefs: unknown[];
  readonly evalJobRefs: readonly {
    readonly evalJobId: string;
    readonly toolRunId: string;
    readonly evidenceManifestHash: string | null;
  }[];
  readonly supersedesId: string | null;
}

function curatorEvaluations(body: Record<string, unknown>): CuratorEvaluationPayload[] {
  return jsonArrayField(body, "evaluations", 100).map((raw, index) => {
    const item = asObject(raw, `evaluations[${index}]`);
    exactFields(item, [
      "application_id",
      "evidence_snapshot_hash",
      "outcome",
      "confidence",
      "reason",
      "evidence_refs",
      "eval_job_refs",
      "supersedes_id",
    ]);
    const outcome = enumField(item, "outcome", EVALUATION_OUTCOMES);
    const confidence = numberField(item, "confidence", 0, 1);
    if (!requireInconclusiveBelowThreshold(outcome, confidence)) {
      throw validationError("low-confidence evaluation must be inconclusive");
    }
    const evalJobRefs = jsonArrayField(item, "eval_job_refs", 3).map((rawRef, refIndex) => {
      const ref = asObject(rawRef, `evaluations[${index}].eval_job_refs[${refIndex}]`);
      exactFields(ref, ["eval_job_id", "tool_run_id", "evidence_manifest_hash"]);
      return {
        evalJobId: textField(ref, "eval_job_id"),
        toolRunId: textField(ref, "tool_run_id"),
        evidenceManifestHash: ref.evidence_manifest_hash === null
          ? null
          : hashField(ref, "evidence_manifest_hash"),
      };
    });
    if (
      new Set(evalJobRefs.map((ref) => ref.evalJobId)).size !== evalJobRefs.length
      || new Set(evalJobRefs.map((ref) => ref.toolRunId)).size !== evalJobRefs.length
    ) {
      throw validationError("eval_job_refs must be unique by eval_job_id and tool_run_id");
    }
    return {
      applicationId: textField(item, "application_id"),
      evidenceSnapshotHash: hashField(item, "evidence_snapshot_hash"),
      outcome,
      confidence,
      reason: textField(item, "reason"),
      evidenceRefs: jsonArrayField(item, "evidence_refs"),
      evalJobRefs,
      supersedesId: item.supersedes_id === null ? null : textField(item, "supersedes_id"),
    };
  });
}

interface RemediationPayload {
  readonly skillId: string;
  readonly expectedActiveVersionId: string;
  readonly expectedControlRevision: number;
  readonly action: "no_op" | "patch" | "scope_change" | "state_action";
  readonly patch: Record<string, unknown> | null;
  readonly stateAction: Record<string, unknown> | null;
}

function curatorRemediations(body: Record<string, unknown>): RemediationPayload[] {
  return jsonArrayField(body, "remediations", 100).map((raw, index) => {
    const item = asObject(raw, `remediations[${index}]`);
    exactFields(
      item,
      ["skill_id", "expected_active_version_id", "expected_control_revision", "action", "patch", "state_action"],
      ["skill_id", "expected_active_version_id", "expected_control_revision", "action"],
    );
    const action = enumField(item, "action", new Set(["no_op", "patch", "scope_change", "state_action"] as const));
    const patch = item.patch === undefined || item.patch === null
      ? null
      : asObject(item.patch, `remediations[${index}].patch`);
    const stateAction = item.state_action === undefined || item.state_action === null
      ? null
      : asObject(item.state_action, `remediations[${index}].state_action`);
    if ((action === "patch" || action === "scope_change") !== (patch !== null)) {
      throw validationError(`${action} remediation patch shape is invalid`);
    }
    if ((action === "state_action") !== (stateAction !== null)) {
      throw validationError(`${action} remediation state_action shape is invalid`);
    }
    return {
      skillId: textField(item, "skill_id"),
      expectedActiveVersionId: textField(item, "expected_active_version_id"),
      expectedControlRevision: integerField(item, "expected_control_revision", 1),
      action,
      patch,
      stateAction,
    };
  });
}

async function applyCuratorEvaluation(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
  evaluatorVersion: string,
  evaluation: CuratorEvaluationPayload,
): Promise<string> {
  const currentSnapshot = await applicationSnapshotHash(tx, evaluation.applicationId);
  if (currentSnapshot !== evaluation.evidenceSnapshotHash) {
    throw conflictApiError("EVOLUTION_CAS_CONFLICT", { application_id: evaluation.applicationId });
  }
  const primaryResult = await tx.query(
    `SELECT a.state,sas.skill_id,sas.version_id
       FROM skill_application a
       JOIN skill_application_skill sas ON sas.application_id=a.id AND sas.role='primary'
       JOIN curator_application_reservation r
         ON r.application_id=a.id AND r.curator_run_id=$2
      WHERE a.id=$1 FOR UPDATE OF a`,
    [evaluation.applicationId, runId],
  );
  const primary = primaryResult.rows[0] as Row | undefined;
  if (!primary || (primary.state !== "pending_evaluation" && primary.state !== "evaluated")) {
    throw conflictApiError("APPLICATION_NOT_EVALUATABLE");
  }
  const leafResult = await tx.query(
    `SELECT e.id FROM curator_evaluation e
      WHERE e.application_id=$1 AND e.version_id=$2
        AND NOT EXISTS (SELECT 1 FROM curator_evaluation n WHERE n.supersedes_id=e.id)
      ORDER BY e.created_at DESC,e.id DESC`,
    [evaluation.applicationId, primary.version_id],
  );
  if (leafResult.rows.length > 1) throw conflictApiError("EVALUATION_LEAF_CONFLICT");
  const currentLeafId = (leafResult.rows[0] as Row | undefined)?.id ?? null;
  if (
    (primary.state === "pending_evaluation" && (currentLeafId !== null || evaluation.supersedesId !== null))
    || (primary.state === "evaluated" && (
      currentLeafId === null || evaluation.supersedesId !== currentLeafId
    ))
  ) {
    throw conflictApiError("EVALUATION_SUPERSEDE_MISMATCH");
  }
  const evaluationId = id("cev");
  await tx.query(
    `INSERT INTO curator_evaluation
      (id,curator_run_id,application_id,skill_id,version_id,evidence_snapshot_hash,
       outcome,confidence,reason,evidence_refs,eval_job_refs,supersedes_id,evaluator_type,evaluator_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,'curator',$13)`,
    [
      evaluationId,
      runId,
      evaluation.applicationId,
      primary.skill_id,
      primary.version_id,
      evaluation.evidenceSnapshotHash,
      evaluation.outcome,
      evaluation.confidence,
      evaluation.reason,
      JSON.stringify(evaluation.evidenceRefs),
      JSON.stringify(evaluation.evalJobRefs.map((ref) => ({
        eval_job_id: ref.evalJobId,
        tool_run_id: ref.toolRunId,
        evidence_manifest_hash: ref.evidenceManifestHash,
      }))),
      evaluation.supersedesId,
      evaluatorVersion,
    ],
  );
  const statusResult = await tx.query(
    `SELECT vs.quality_state,s.control_revision
       FROM learned_skill_version_status vs
       JOIN learned_skill_version v ON v.id=vs.version_id
       JOIN learned_skill s ON s.id=v.skill_id
      WHERE vs.version_id=$1 FOR UPDATE OF vs`,
    [primary.version_id],
  );
  const status = statusResult.rows[0] as Row;
  const historyResult = await tx.query(
    `SELECT leaf.outcome FROM (
       SELECT DISTINCT ON (e.application_id)
              e.application_id,e.outcome,e.created_at,e.id
         FROM curator_evaluation e
        WHERE e.version_id=$1
          AND NOT EXISTS (SELECT 1 FROM curator_evaluation n WHERE n.supersedes_id=e.id)
        ORDER BY e.application_id,e.created_at DESC,e.id DESC
     ) leaf
     ORDER BY leaf.created_at,leaf.id`,
    [primary.version_id],
  );
  const history = (historyResult.rows as Row[]).map((row) => ({ outcome: row.outcome as EvaluationOutcome }));
  const currentQuality = status.quality_state as QualityState;
  const nextQuality = nextQualityState(currentQuality, history);
  await tx.query(
    `UPDATE learned_skill_version_status
        SET quality_state=$2,last_evaluation_id=$3,updated_at=now()
      WHERE version_id=$1`,
    [primary.version_id, nextQuality, evaluationId],
  );
  await tx.query(
    `UPDATE skill_application SET state='evaluated'
      WHERE id=$1 AND state='pending_evaluation'`,
    [evaluation.applicationId],
  );
  if (nextQuality !== currentQuality) {
    await appendLifecycle(tx, ctx, {
      skillId: String(primary.skill_id),
      versionId: String(primary.version_id),
      eventType: "quality_evaluated",
      from: { quality_state: currentQuality },
      to: { quality_state: nextQuality },
      reason: evaluation.reason,
      controlRevision: Number(status.control_revision),
    });
  }
  return evaluationId;
}

interface CuratorRemediationResult {
  readonly decision: "applied" | "skipped";
  readonly producedVersionId: string | null;
  readonly skipReason: string | null;
  readonly skipped: Record<string, unknown> | null;
}

async function remediationVersionPayload(
  tx: TransactionClient,
  item: RemediationPayload,
): Promise<DistillationSkillPayload> {
  const currentResult = await tx.query(
    `SELECT s.slug,s.name,s.summary,v.description,v.applicability,v.outcome_contract
       FROM learned_skill s
       JOIN learned_skill_version v ON v.id=s.active_version_id
      WHERE s.id=$1`,
    [item.skillId],
  );
  const current = currentResult.rows[0] as Row | undefined;
  if (!current) throw conflictApiError("SKILL_NOT_AVAILABLE");
  const filesResult = await tx.query(
    `SELECT path,kind,language,content FROM learned_skill_file
      WHERE version_id=$1 ORDER BY path`,
    [item.expectedActiveVersionId],
  );
  const patch = item.patch!;
  exactFields(
    patch,
    ["slug", "name", "summary", "description", "applicability", "outcome_contract", "files"],
    [],
  );
  const value = {
    skill_id: item.skillId,
    slug: patch.slug ?? current.slug,
    name: patch.name ?? current.name,
    summary: patch.summary ?? current.summary,
    description: patch.description ?? current.description,
    applicability: patch.applicability ?? current.applicability,
    outcome_contract: patch.outcome_contract ?? current.outcome_contract,
    files: patch.files ?? (filesResult.rows as Row[]).map((file) => ({
      path: file.path,
      kind: file.kind,
      language: file.language ?? null,
      content: file.content,
    })),
  };
  return distillationSkill(value);
}

async function appendRemediationAudit(
  tx: TransactionClient,
  runId: string,
  evaluationId: string,
  applicationId: string,
  item: RemediationPayload,
  decision: "applied" | "skipped",
  producedVersionId: string | null,
  skipReason: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO curator_remediation_audit
      (id,curator_run_id,evaluation_id,application_id,skill_id,action,request_payload,
       decision,produced_version_id,skip_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [
      id("crm"),
      runId,
      evaluationId,
      applicationId,
      item.skillId,
      item.action,
      JSON.stringify({
        expected_active_version_id: item.expectedActiveVersionId,
        expected_control_revision: item.expectedControlRevision,
        patch: item.patch,
        state_action: item.stateAction,
      }),
      decision,
      producedVersionId,
      skipReason,
    ],
  );
}

async function applyCuratorRemediation(
  tx: TransactionClient,
  ctx: RequestContext,
  runId: string,
  item: RemediationPayload,
): Promise<CuratorRemediationResult> {
  const skillResult = await tx.query(
    `SELECT * FROM learned_skill WHERE id=$1 FOR UPDATE`,
    [item.skillId],
  );
  const skill = skillResult.rows[0] as Row | undefined;
  const casMatches = skill
    && skill.active_version_id === item.expectedActiveVersionId
    && Number(skill.control_revision) === item.expectedControlRevision;
  if (!casMatches) {
    return {
      decision: "skipped",
      producedVersionId: null,
      skipReason: "cas_conflict",
      skipped: { skill_id: item.skillId, action: item.action, reason: "cas_conflict" },
    };
  }
  if (item.action === "no_op") {
    return { decision: "applied", producedVersionId: null, skipReason: null, skipped: null };
  }
  if (skill!.pinned === true || skill!.enabled !== true || skill!.availability_state !== "available") {
    return {
      decision: "skipped",
      producedVersionId: null,
      skipReason: "skill_controlled",
      skipped: { skill_id: item.skillId, action: item.action, reason: "skill_controlled" },
    };
  }

  if (item.action === "patch" || item.action === "scope_change") {
    const payload = await remediationVersionPayload(tx, item);
    const scan = scanLearnedSkillPackage(payload.files, {
      name: payload.name,
      summary: payload.summary,
      description: payload.description,
      applicability: payload.applicability,
      outcomeContract: payload.outcomeContract,
    });
    const versionNoResult = await tx.query(
      "SELECT COALESCE(max(version_no),0)+1 AS version_no FROM learned_skill_version WHERE skill_id=$1",
      [item.skillId],
    );
    const versionId = id("lsv");
    await tx.query(
      `INSERT INTO learned_skill_version
        (id,skill_id,version_no,parent_version_id,description,applicability,outcome_contract,
         content_manifest_hash,scanner_version,scan_decision,scan_findings,curator_run_id,
         created_by_type,created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
      [
        versionId,
        item.skillId,
        Number((versionNoResult.rows[0] as Row).version_no),
        item.expectedActiveVersionId,
        payload.description,
        JSON.stringify(payload.applicability),
        JSON.stringify(payload.outcomeContract),
        scan.contentManifestHash,
        scan.scannerVersion,
        scan.decision,
        JSON.stringify(scan.findings),
        runId,
        ctx.identity.actorType,
        ctx.identity.actorId,
      ],
    );
    await tx.query(
      `INSERT INTO learned_skill_version_status(version_id,quality_state)
       VALUES ($1,$2)`,
      [versionId, scan.decision === "pass" ? "active_unproven" : "quarantined"],
    );
    for (const file of scan.files) {
      await tx.query(
        `INSERT INTO learned_skill_file
          (id,version_id,path,kind,language,sha256,size_bytes,media_type,content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id("lsf"), versionId, file.path, file.kind, file.language, file.sha256, file.sizeBytes, file.mediaType, file.content],
      );
    }
    const revision = item.expectedControlRevision + (scan.decision === "pass" ? 1 : 0);
    if (scan.decision === "pass") {
      await tx.query(
        `UPDATE learned_skill
            SET slug=$2,name=$3,summary=$4,applicability_summary=$5,
                active_version_id=$6,control_revision=$7,updated_at=now()
          WHERE id=$1`,
        [
          item.skillId,
          payload.slug,
          payload.name,
          payload.summary,
          applicabilitySummary(payload.applicability),
          versionId,
          revision,
        ],
      );
    }
    await appendLifecycle(tx, ctx, {
      skillId: item.skillId,
      versionId,
      eventType: scan.decision === "pass"
        ? `curator_${item.action}_activated`
        : "curator_candidate_quarantined",
      from: {
        active_version_id: item.expectedActiveVersionId,
        control_revision: item.expectedControlRevision,
      },
      to: {
        active_version_id: scan.decision === "pass" ? versionId : item.expectedActiveVersionId,
        control_revision: revision,
        quality_state: scan.decision === "pass" ? "active_unproven" : "quarantined",
      },
      reason: `${item.action} remediation`,
      controlRevision: revision,
    });
    return {
      decision: "applied",
      producedVersionId: versionId,
      skipReason: null,
      skipped: null,
    };
  }

  const stateAction = item.stateAction!;
  exactFields(stateAction, ["action", "target_version_id"], ["action"]);
  const action = enumField(
    stateAction,
    "action",
    new Set(["disable", "archive", "rollback", "quarantine"] as const),
  );
  let enabled = true;
  let availabilityState = "available";
  let activeVersionId = item.expectedActiveVersionId;
  if (action === "rollback") {
    const targetVersionId = textField(stateAction, "target_version_id");
    const target = await tx.query(
      `SELECT 1 FROM learned_skill_version v
         JOIN learned_skill_version_status vs ON vs.version_id=v.id
        WHERE v.id=$1 AND v.skill_id=$2 AND vs.quality_state<>'quarantined'`,
      [targetVersionId, item.skillId],
    );
    if (target.rows.length === 0) throw conflictApiError("SKILL_NOT_AVAILABLE");
    activeVersionId = targetVersionId;
  } else if (stateAction.target_version_id !== undefined) {
    throw validationError("target_version_id is only valid for rollback");
  } else if (action === "disable") {
    enabled = false;
  } else if (action === "archive") {
    availabilityState = "archived";
  } else {
    await tx.query(
      `UPDATE learned_skill_version_status
          SET quality_state='quarantined',updated_at=now()
        WHERE version_id=$1`,
      [activeVersionId],
    );
  }
  const revision = item.expectedControlRevision + 1;
  await tx.query(
    `UPDATE learned_skill
        SET enabled=$2,availability_state=$3,active_version_id=$4,
            control_revision=$5,updated_at=now()
      WHERE id=$1`,
    [item.skillId, enabled, availabilityState, activeVersionId, revision],
  );
  await appendLifecycle(tx, ctx, {
    skillId: item.skillId,
    versionId: activeVersionId,
    eventType: `curator_state_${action}`,
    from: {
      enabled: skill!.enabled,
      availability_state: skill!.availability_state,
      active_version_id: skill!.active_version_id,
    },
    to: { enabled, availability_state: availabilityState, active_version_id: activeVersionId },
    reason: "state_action remediation",
    controlRevision: revision,
  });
  return { decision: "applied", producedVersionId: null, skipReason: null, skipped: null };
}

async function validateDryRunEvaluation(
  tx: TransactionClient,
  runId: string,
  evaluation: CuratorEvaluationPayload,
): Promise<string> {
  const snapshot = await applicationSnapshotHash(tx, evaluation.applicationId);
  if (snapshot !== evaluation.evidenceSnapshotHash) {
    throw conflictApiError("EVOLUTION_CAS_CONFLICT", { application_id: evaluation.applicationId });
  }
  const primaryResult = await tx.query(
    `SELECT a.state,sas.skill_id
       FROM skill_application a
       JOIN skill_application_skill sas ON sas.application_id=a.id AND sas.role='primary'
       JOIN curator_application_reservation r
         ON r.application_id=a.id AND r.curator_run_id=$2
      WHERE a.id=$1`,
    [evaluation.applicationId, runId],
  );
  const primary = primaryResult.rows[0] as Row | undefined;
  if (!primary || primary.state !== "pending_evaluation" || evaluation.supersedesId !== null) {
    throw conflictApiError("APPLICATION_NOT_EVALUATABLE");
  }
  return String(primary.skill_id);
}

async function validateDryRunRemediation(
  tx: TransactionClient,
  remediation: RemediationPayload,
): Promise<void> {
  const result = await tx.query(
    `SELECT active_version_id,control_revision FROM learned_skill WHERE id=$1`,
    [remediation.skillId],
  );
  const skill = result.rows[0] as Row | undefined;
  if (
    !skill
    || skill.active_version_id !== remediation.expectedActiveVersionId
    || Number(skill.control_revision) !== remediation.expectedControlRevision
  ) {
    throw conflictApiError("EVOLUTION_CAS_CONFLICT", { skill_id: remediation.skillId });
  }
}

interface CuratorEvalJobRow extends Row {
  readonly id: string;
  readonly tool_run_id: string;
  readonly application_id: string;
  readonly version_id: string;
  readonly state: string;
  readonly error_code: string | null;
  readonly reconciliation_state: string;
  readonly evidence_facts: string[];
  readonly evidence_manifest_hash: string | null;
}

function evalFactConclusion(facts: ReadonlySet<string>): "frozen" | "corrupt" | "unavailable_at_deadline" | "none" {
  if (facts.has("frozen")) return "frozen";
  if (facts.has("corrupt")) return "corrupt";
  if (facts.has("unavailable_at_deadline")) return "unavailable_at_deadline";
  return "none";
}

async function lockedCuratorEvalJobs(
  tx: TransactionClient,
  runId: string,
): Promise<CuratorEvalJobRow[]> {
  await tx.query(
    `SELECT job.id FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
      WHERE job.curator_run_id=$1 ORDER BY job.ordinal
      FOR UPDATE OF job,tool`,
    [runId],
  );
  const result = await tx.query(
    `SELECT job.id,job.tool_run_id,job.application_id,job.version_id,
            job.reconciliation_state,tool.state::text,tool.error_code,
            COALESCE(array_agg(fact.fact_type ORDER BY fact.created_at,fact.id)
              FILTER (WHERE fact.id IS NOT NULL),'{}'::text[]) AS evidence_facts,
            max(fact.manifest_hash) FILTER (WHERE fact.fact_type='frozen') AS evidence_manifest_hash
       FROM evolution_eval_job job
       JOIN tool_run tool ON tool.id=job.tool_run_id
       LEFT JOIN evolution_eval_evidence_fact fact ON fact.eval_job_id=job.id
      WHERE job.curator_run_id=$1
      GROUP BY job.id,tool.state,tool.error_code
      ORDER BY job.ordinal`,
    [runId],
  );
  return result.rows as CuratorEvalJobRow[];
}

function evalJobRefKey(ref: {
  readonly evalJobId: string;
  readonly toolRunId: string;
  readonly evidenceManifestHash: string | null;
}): string {
  return `${ref.evalJobId}\0${ref.toolRunId}\0${ref.evidenceManifestHash ?? ""}`;
}

async function validateCuratorEvolutionCompletion(
  tx: TransactionClient,
  runId: string,
  evaluations: readonly CuratorEvaluationPayload[],
  remediations: readonly RemediationPayload[],
): Promise<void> {
  const jobs = await lockedCuratorEvalJobs(tx, runId);
  const terminal = new Set(["rejected", "succeeded", "failed", "cancelled", "timeout", "unknown_effect"]);
  if (jobs.some((job) => !terminal.has(job.state) || job.reconciliation_state === "required")) {
    throw evolutionEvalApiError("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
  }
  const affectedApplications = new Set<string>();
  const primaryVersionIds = new Set<string>();
  for (const job of jobs) {
    const facts = new Set(job.evidence_facts ?? []);
    const conclusion = evalFactConclusion(facts);
    const durableNotAccepted = job.state === "failed" && new Set([
      "EVOLUTION_EVAL_NOT_ACCEPTED",
      "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE",
    ]).has(job.error_code ?? "");
    if (
      new Set(["succeeded", "failed", "cancelled", "timeout"]).has(job.state)
      && !durableNotAccepted
      && conclusion === "none"
    ) {
      throw evolutionEvalApiError("EVOLUTION_EVAL_EVIDENCE_NOT_READY", 409, true);
    }
    if (job.state === "unknown_effect" || conclusion === "corrupt" || conclusion === "unavailable_at_deadline") {
      affectedApplications.add(job.application_id);
      primaryVersionIds.add(job.version_id);
    }
  }

  const byApplication = new Map<string, CuratorEvalJobRow[]>();
  for (const job of jobs) {
    const rows = byApplication.get(job.application_id) ?? [];
    rows.push(job);
    byApplication.set(job.application_id, rows);
  }
  for (const evaluation of evaluations) {
    const expected = (byApplication.get(evaluation.applicationId) ?? []).map((job) => {
      const facts = new Set(job.evidence_facts ?? []);
      return {
        evalJobId: job.id,
        toolRunId: job.tool_run_id,
        evidenceManifestHash: evalFactConclusion(facts) === "frozen"
          ? job.evidence_manifest_hash
          : null,
      };
    });
    const actualKeys = [...evaluation.evalJobRefs].map(evalJobRefKey).sort();
    const expectedKeys = expected.map(evalJobRefKey).sort();
    if (
      actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw evolutionEvalApiError("EVOLUTION_EVAL_BINDING_CONFLICT", 409, false, {
        application_id: evaluation.applicationId,
      });
    }
    if (affectedApplications.has(evaluation.applicationId) && evaluation.outcome !== "inconclusive") {
      throw evolutionEvalApiError("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE", 409, false, {
        application_id: evaluation.applicationId,
      });
    }
  }
  if (affectedApplications.size === 0) return;
  const affectedSkillResult = await tx.query(
    `SELECT DISTINCT sas.skill_id
       FROM skill_application_skill sas
      WHERE sas.role='primary' AND sas.version_id=ANY($1::text[])`,
    [[...primaryVersionIds]],
  );
  const affectedSkillIds = new Set((affectedSkillResult.rows as Row[]).map((row) => String(row.skill_id)));
  for (const remediation of remediations) {
    if (affectedSkillIds.has(remediation.skillId) && remediation.action !== "no_op") {
      throw evolutionEvalApiError("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE", 409, false, {
        skill_id: remediation.skillId,
      });
    }
  }
}

async function validateCuratorEvolutionFailure(
  tx: TransactionClient,
  runId: string,
): Promise<void> {
  const jobs = await lockedCuratorEvalJobs(tx, runId);
  if (jobs.some((job) => job.state === "unknown_effect")) {
    throw evolutionEvalApiError("EVOLUTION_EVAL_UNKNOWN_REQUIRES_COMPLETE", 409);
  }
  if (jobs.some((job) => {
    const facts = new Set(job.evidence_facts ?? []);
    return facts.has("corrupt") || facts.has("unavailable_at_deadline");
  })) {
    throw evolutionEvalApiError("EVOLUTION_EVAL_EVIDENCE_REQUIRES_COMPLETE", 409);
  }
  if (jobs.some((job) => {
    if (job.reconciliation_state === "required") return true;
    if (!new Set(["rejected", "succeeded", "failed", "cancelled", "timeout"]).has(job.state)) return true;
    if (job.state === "rejected") return false;
    if (
      job.state === "failed"
      && new Set(["EVOLUTION_EVAL_NOT_ACCEPTED", "EVOLUTION_EVAL_CAPABILITY_UNAVAILABLE"])
        .has(job.error_code ?? "")
    ) return false;
    return evalFactConclusion(new Set(job.evidence_facts ?? [])) === "none";
  })) {
    throw evolutionEvalApiError("EVOLUTION_EVAL_RECONCILIATION_REQUIRED", 409, true);
  }
}

export async function completeCuratorRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-curator");
  const body = asObject(ctx.body);
  exactFields(body, ["lease_token", "evaluator_version", "evaluations", "remediations"]);
  const leaseToken = textField(body, "lease_token");
  const evaluatorVersion = textField(body, "evaluator_version");
  const evaluations = curatorEvaluations(body);
  const remediations = curatorRemediations(body);
  const requestHash = canonicalRequestHash(body);
  const runId = ctx.params.runId!;
  const conn = await ctx.pool.connect();
  try {
    const result = await withTransaction(conn as unknown as TransactionClient, async (tx) => {
      const runResult = await tx.query("SELECT * FROM curator_run WHERE id=$1 FOR UPDATE", [runId]);
      const run = runResult.rows[0] as Row | undefined;
      if (!run) throw notFoundError(`curator run not found: ${runId}`);
      if (TERMINAL_CURATOR_STATES.has(String(run.state))) {
        if (run.terminal_request_hash !== requestHash) throw conflictApiError("EVOLUTION_CAS_CONFLICT");
        return { ...(run.terminal_result as Row), replayed: true };
      }
      requireRollout(ctx);
      if (
        run.state !== "running"
        || run.lease_token !== leaseToken
        || new Date(String(run.lease_expires_at)).getTime() <= Date.now()
      ) {
        throw conflictApiError("EVOLUTION_LEASE_CONFLICT");
      }
      const settings = await settingsRow(tx, true);
      if (run.mode === "run" && settings.learning_paused === true) {
        throw conflictApiError("LEARNING_PAUSED");
      }
      if (new Set(evaluations.map((item) => item.applicationId)).size !== evaluations.length) {
        throw validationError("an application may be evaluated only once per Curator run");
      }
      if (new Set(remediations.map((item) => item.skillId)).size !== remediations.length) {
        throw validationError("a skill may have only one remediation per Curator run");
      }
      const reservationResult = await tx.query(
        `SELECT r.application_id,sas.skill_id
           FROM curator_application_reservation r
           LEFT JOIN skill_application_skill sas
             ON sas.application_id=r.application_id AND sas.role='primary'
          WHERE r.curator_run_id=$1
          ORDER BY r.application_id`,
        [runId],
      );
      const reservations = reservationResult.rows as Row[];
      if (reservations.some((item) => item.skill_id === null || item.skill_id === undefined)) {
        throw conflictApiError("APPLICATION_PRIMARY_MISSING");
      }
      const expectedByApplication = new Map(
        reservations.map((item) => [String(item.application_id), String(item.skill_id)]),
      );
      const evaluationApplications = new Set(evaluations.map((item) => item.applicationId));
      if (
        evaluationApplications.size !== expectedByApplication.size
        || [...expectedByApplication.keys()].some((applicationId) => !evaluationApplications.has(applicationId))
      ) {
        throw validationError("evaluations must exactly cover the Curator reservation set");
      }
      const expectedSkillIds = new Set(expectedByApplication.values());
      const remediationSkillIds = new Set(remediations.map((item) => item.skillId));
      if (
        remediationSkillIds.size !== expectedSkillIds.size
        || [...expectedSkillIds].some((skillId) => !remediationSkillIds.has(skillId))
      ) {
        throw validationError("remediations must exactly cover the distinct primary skill set");
      }
      await validateCuratorEvolutionCompletion(tx, runId, evaluations, remediations);
      const skippedActions: Record<string, unknown>[] = [];
      const evaluationIds: string[] = [];
      const producedVersionIds: string[] = [];
      if (run.mode === "run") {
        const appliedEvaluations: {
          applicationId: string;
          evaluationId: string;
          skillId: string;
        }[] = [];
        for (const evaluation of evaluations) {
          const evaluationId = await applyCuratorEvaluation(
            tx,
            ctx,
            runId,
            evaluatorVersion,
            evaluation,
          );
          const skillId = expectedByApplication.get(evaluation.applicationId)!;
          appliedEvaluations.push({ applicationId: evaluation.applicationId, evaluationId, skillId });
          evaluationIds.push(evaluationId);
        }
        for (const remediation of remediations) {
          const applied = await applyCuratorRemediation(
            tx,
            ctx,
            runId,
            remediation,
          );
          if (applied.producedVersionId !== null) producedVersionIds.push(applied.producedVersionId);
          if (applied.skipped !== null) skippedActions.push(applied.skipped);
          for (const evaluation of appliedEvaluations.filter(
            (candidate) => candidate.skillId === remediation.skillId,
          )) {
            await appendRemediationAudit(
              tx,
              runId,
              evaluation.evaluationId,
              evaluation.applicationId,
              remediation,
              applied.decision,
              applied.producedVersionId,
              applied.skipReason,
            );
          }
        }
      } else {
        for (const evaluation of evaluations) {
          const skillId = await validateDryRunEvaluation(tx, runId, evaluation);
          if (skillId !== expectedByApplication.get(evaluation.applicationId)) {
            throw conflictApiError("APPLICATION_NOT_EVALUATABLE");
          }
        }
        for (const remediation of remediations) {
          await validateDryRunRemediation(tx, remediation);
        }
      }
      const terminal = {
        schema: "curator-result.v1",
        run_id: runId,
        state: run.mode === "dry_run" ? "dry_run_complete" : "completed",
        evaluation_ids: evaluationIds,
        proposed_evaluations: run.mode === "dry_run" ? body.evaluations : [],
        proposed_remediations: run.mode === "dry_run" ? body.remediations : [],
        produced_version_ids: producedVersionIds,
        skipped_actions: skippedActions,
        replayed: false,
      };
      await tx.query(
        `UPDATE curator_run
            SET state=$2,terminal_request_hash=$3,terminal_result=$4::jsonb,
                completed_at=now(),updated_at=now()
          WHERE id=$1`,
        [runId, terminal.state, requestHash, JSON.stringify(terminal)],
      );
      if (run.mode === "run") {
        await tx.query(
          `UPDATE evolution_eval_run SET completed_at=COALESCE(completed_at,clock_timestamp())
            WHERE curator_run_id=$1`,
          [runId],
        );
      }
      await tx.query(
        `DELETE FROM curator_application_reservation reservation
          WHERE reservation.curator_run_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM evolution_eval_job job
               WHERE job.curator_run_id=reservation.curator_run_id
                 AND job.application_id=reservation.application_id
            )`,
        [runId],
      );
      if (run.mode === "run") {
        await appendEvolutionOutbox(tx, ctx, "curator_run", runId, "evolution.curator_run_completed", {
          evaluation_ids: evaluationIds,
          skipped_actions: skippedActions,
        });
      }
      return terminal;
    });
    return { status: 200, data: result };
  } finally {
    conn.release();
  }
}

export async function failCuratorRunHandler(ctx: RequestContext): Promise<HandlerResult> {
  requireCapability(ctx, "core:evolution-curator");
  return failLeasedRun(ctx, "curator_run", ctx.params.runId!);
}
