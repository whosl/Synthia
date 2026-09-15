/**
 * Task-bound Core client for Learned Skill discovery, application, and episode
 * sealing. It deliberately carries only the singleton `core:task-runtime`
 * capability and never exposes Distiller, Curator, governance, or Connector
 * operations.
 */

export type LearnedSkillQualityState =
  | "active_unproven"
  | "active_observed"
  | "needs_review"
  | "degraded"
  | "quarantined";

export interface LearnedSkillSearchItem {
  readonly skillId: string;
  readonly versionId: string;
  readonly name: string;
  readonly summary: string;
  readonly applicabilitySummary: string;
  readonly qualityState: LearnedSkillQualityState;
  readonly recommended: boolean;
}

export interface LearnedSkillSearchResult {
  readonly items: readonly LearnedSkillSearchItem[];
  readonly learnedSkillsEnabled: boolean;
}

export interface LearnedSkillFile {
  readonly path: string;
  readonly kind: "skill_md" | "reference" | "template" | "script";
  readonly language: "tcl" | "python" | "typescript" | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly content: string;
}

export interface LearnedSkillVersion {
  readonly skillId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly applicability: unknown;
  readonly outcomeContract: unknown;
  readonly qualityState: LearnedSkillQualityState;
  readonly contentManifestHash: string;
  readonly files: readonly LearnedSkillFile[];
}

export interface SkillApplicationResult {
  readonly applicationId: string;
  readonly observationKey: string;
  readonly episodeId: string | null;
  readonly state: "open" | "closed_pending_episode" | "pending_evaluation";
  readonly versionId?: string;
  readonly role?: "primary" | "supporting";
  readonly replayed: boolean;
}

/** Frozen close response intentionally omits discovery/binding details. */
export interface SkillApplicationCloseResult {
  readonly applicationId: string;
  readonly state: "closed_pending_episode" | "pending_evaluation";
  readonly replayed: boolean;
}

export interface LearningEpisodeResult {
  readonly episodeId: string;
  readonly observationKey: string;
  readonly episodeKey: string;
  readonly distillationState: "queued" | "paused" | "disabled";
  readonly boundApplicationIds: readonly string[];
  readonly replayed: boolean;
}

export interface TaskEvolutionClient {
  readonly projectId: string;
  readonly taskId: string;
  search(query: string, limit?: number): Promise<LearnedSkillSearchResult>;
  view(skillId: string, versionId: string): Promise<LearnedSkillVersion>;
  createApplication(input: {
    readonly toolCallId: string;
    readonly turnId: string | null;
    readonly versionId: string;
    readonly localGoal: string;
    readonly reasonCodes: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<SkillApplicationResult>;
  attachSupportingSkill(input: {
    readonly applicationId: string;
    readonly toolCallId: string;
    readonly versionId: string;
    readonly reasonCodes: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<SkillApplicationResult>;
  closeApplication(input: {
    readonly applicationId: string;
    readonly endEventSequence: number;
    readonly outcomeClaim: string | null;
    readonly humanCorrections: number;
    readonly evidenceRefs: readonly string[];
    readonly toolRunRefs: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<SkillApplicationCloseResult>;
  createEpisode(input: {
    readonly observationKey: string;
    readonly episodeKey: string;
    readonly turnId: string | null;
    readonly endEventSequence: number;
    readonly contentHash: string;
    readonly outcomeClaim: string | null;
    readonly toolEventStartSequence: number | null;
    readonly toolEventEndSequence: number | null;
    readonly evidenceRefs: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<LearningEpisodeResult>;
}

export interface CoreTaskEvolutionClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class EvolutionClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EvolutionClientError";
  }
}

export class CoreTaskEvolutionClient implements TaskEvolutionClient {
  readonly projectId: string;
  readonly taskId: string;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly sleeper: (ms: number) => Promise<void>;

  constructor(options: CoreTaskEvolutionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = requireText("token", options.token);
    this.projectId = requireIdentifier("projectId", options.projectId);
    this.taskId = requireIdentifier("taskId", options.taskId);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleeper = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async search(query: string, limit = 10): Promise<LearnedSkillSearchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw contractError("limit must be an integer between 1 and 100");
    }
    const params = new URLSearchParams({ q: query.trim(), limit: String(limit) });
    const row = asRecord(await this.request("GET", `learned-skills/search?${params}`));
    requireSchema(row, "learned-skill-search.v1");
    const items = requireArray(row.items, "items").map((item, index) => parseSearchItem(item, `items[${index}]`));
    return {
      items,
      learnedSkillsEnabled: requireBoolean(row.learned_skills_enabled, "learned_skills_enabled"),
    };
  }

  async view(skillId: string, versionId: string): Promise<LearnedSkillVersion> {
    const path = `learned-skills/${encodeURIComponent(requireIdentifier("skillId", skillId))}`
      + `/versions/${encodeURIComponent(requireIdentifier("versionId", versionId))}`;
    const row = asRecord(await this.request("GET", path));
    requireSchema(row, "learned-skill-version.v1");
    const skill = asRecord(row.skill);
    const version = asRecord(row.version);
    const parsedSkillId = requireString(skill.skill_id, "skill.skill_id");
    const parsedVersionId = requireString(version.version_id, "version.version_id");
    if (parsedSkillId !== skillId || parsedVersionId !== versionId) {
      throw contractError("Core returned a different Learned Skill version");
    }
    return {
      skillId: parsedSkillId,
      versionId: parsedVersionId,
      versionNo: requireNonNegativeInteger(version.version_no, "version.version_no"),
      name: requireString(skill.name, "skill.name"),
      summary: requireString(skill.summary, "skill.summary"),
      description: requireString(version.description, "version.description"),
      applicability: version.applicability,
      outcomeContract: version.outcome_contract,
      qualityState: requireQualityState(version.quality_state, "version.quality_state"),
      contentManifestHash: requireHash(version.content_manifest_hash, "version.content_manifest_hash"),
      files: requireArray(version.files, "version.files")
        .map((file, index) => parseFile(file, `version.files[${index}]`)),
    };
  }

  async createApplication(input: Parameters<TaskEvolutionClient["createApplication"]>[0]): Promise<SkillApplicationResult> {
    const body = {
      schema: "skill-application-create.v1",
      tool_call_id: requireIdentifier("toolCallId", input.toolCallId),
      turn_id: input.turnId === null ? null : requireIdentifier("turnId", input.turnId),
      version_id: requireIdentifier("versionId", input.versionId),
      local_goal: requireText("localGoal", input.localGoal),
      reason_codes: requireStringList("reasonCodes", input.reasonCodes),
    };
    return parseApplication(await this.request(
      "POST",
      "skill-applications",
      body,
      requireIdempotencyKey(input.idempotencyKey),
    ));
  }

  async attachSupportingSkill(
    input: Parameters<TaskEvolutionClient["attachSupportingSkill"]>[0],
  ): Promise<SkillApplicationResult> {
    const applicationId = requireIdentifier("applicationId", input.applicationId);
    return parseApplication(await this.request(
      "POST",
      `skill-applications/${encodeURIComponent(applicationId)}/skills`,
      {
        schema: "skill-application-attach.v1",
        tool_call_id: requireIdentifier("toolCallId", input.toolCallId),
        version_id: requireIdentifier("versionId", input.versionId),
        role: "supporting",
        reason_codes: requireStringList("reasonCodes", input.reasonCodes),
      },
      requireIdempotencyKey(input.idempotencyKey),
    ));
  }

  async closeApplication(
    input: Parameters<TaskEvolutionClient["closeApplication"]>[0],
  ): Promise<SkillApplicationCloseResult> {
    const applicationId = requireIdentifier("applicationId", input.applicationId);
    return parseApplicationClose(await this.request(
      "POST",
      `skill-applications/${encodeURIComponent(applicationId)}/close`,
      {
        schema: "skill-application-close.v1",
        end_event_sequence: requireNonNegativeInteger(input.endEventSequence, "endEventSequence"),
        outcome_claim: input.outcomeClaim === null ? null : requireText("outcomeClaim", input.outcomeClaim),
        human_corrections: requireNonNegativeInteger(input.humanCorrections, "humanCorrections"),
        evidence_refs: requireStringList("evidenceRefs", input.evidenceRefs),
        tool_run_refs: requireStringList("toolRunRefs", input.toolRunRefs),
      },
      requireIdempotencyKey(input.idempotencyKey),
    ));
  }

  async createEpisode(input: Parameters<TaskEvolutionClient["createEpisode"]>[0]): Promise<LearningEpisodeResult> {
    const row = asRecord(await this.request(
      "POST",
      "learning-episodes",
      {
        schema: "learning-episode-create.v1",
        observation_key: requireIdentifier("observationKey", input.observationKey),
        episode_key: requireIdentifier("episodeKey", input.episodeKey),
        turn_id: input.turnId === null ? null : requireIdentifier("turnId", input.turnId),
        end_event_sequence: requireNonNegativeInteger(input.endEventSequence, "endEventSequence"),
        content_hash: requireHash(input.contentHash, "contentHash"),
        outcome_claim: input.outcomeClaim === null ? null : requireText("outcomeClaim", input.outcomeClaim),
        tool_event_start_sequence: nullableSequence(input.toolEventStartSequence, "toolEventStartSequence"),
        tool_event_end_sequence: nullableSequence(input.toolEventEndSequence, "toolEventEndSequence"),
        evidence_refs: requireStringList("evidenceRefs", input.evidenceRefs),
      },
      requireIdempotencyKey(input.idempotencyKey),
    ));
    requireSchema(row, "learning-episode.v1");
    const state = row.distillation_state;
    if (state !== "queued" && state !== "paused" && state !== "disabled") {
      throw contractError("distillation_state is invalid");
    }
    return {
      episodeId: requireString(row.episode_id, "episode_id"),
      observationKey: requireString(row.observation_key, "observation_key"),
      episodeKey: requireString(row.episode_key, "episode_key"),
      distillationState: state,
      boundApplicationIds: requireArray(row.bound_application_ids, "bound_application_ids")
        .map((value, index) => requireString(value, `bound_application_ids[${index}]`)),
      replayed: requireBoolean(row.replayed, "replayed"),
    };
  }

  private async request(
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const path = `/api/v1/projects/${encodeURIComponent(this.projectId)}`
      + `/tasks/${encodeURIComponent(this.taskId)}/${suffix}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.token}`,
          "X-Synthia-Task-Id": this.taskId,
        };
        if (method === "POST") {
          headers["Content-Type"] = "application/json";
          headers["Idempotency-Key"] = idempotencyKey!;
        }
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        if (response.ok) return asRecord(json).data;
        const envelope = asRecord(json);
        const error = asRecord(envelope.error);
        const retryable = typeof error.retryable === "boolean" ? error.retryable : response.status >= 500;
        if (retryable && attempt === 0) {
          await this.sleeper(this.retryDelayMs);
          continue;
        }
        throw new EvolutionClientError(
          typeof error.message === "string" ? error.message : `HTTP ${response.status}`,
          typeof error.code === "string" ? error.code : `http_${response.status}`,
          response.status,
          retryable,
        );
      } catch (error) {
        if (error instanceof EvolutionClientError) throw error;
        if (attempt === 0) {
          await this.sleeper(this.retryDelayMs);
          continue;
        }
        throw new EvolutionClientError(
          error instanceof Error ? error.message : String(error),
          "network_error",
          0,
          true,
        );
      }
    }
    throw new EvolutionClientError("request failed", "request_failed", 0, true);
  }
}

function parseSearchItem(value: unknown, path: string): LearnedSkillSearchItem {
  const row = asRecord(value);
  return {
    skillId: requireString(row.skill_id, `${path}.skill_id`),
    versionId: requireString(row.version_id, `${path}.version_id`),
    name: requireString(row.name, `${path}.name`),
    summary: requireString(row.summary, `${path}.summary`),
    applicabilitySummary: requireString(row.applicability_summary, `${path}.applicability_summary`),
    qualityState: requireQualityState(row.quality_state, `${path}.quality_state`),
    recommended: requireBoolean(row.recommended, `${path}.recommended`),
  };
}

function parseFile(value: unknown, path: string): LearnedSkillFile {
  const row = asRecord(value);
  const kind = row.kind;
  if (kind !== "skill_md" && kind !== "reference" && kind !== "template" && kind !== "script") {
    throw contractError(`${path}.kind is invalid`);
  }
  const language = row.language;
  if (language !== null && language !== "tcl" && language !== "python" && language !== "typescript") {
    throw contractError(`${path}.language is invalid`);
  }
  return {
    path: requireString(row.path, `${path}.path`),
    kind,
    language,
    sha256: requireHash(row.sha256, `${path}.sha256`),
    sizeBytes: requireNonNegativeInteger(row.size_bytes, `${path}.size_bytes`),
    mediaType: requireString(row.media_type, `${path}.media_type`),
    content: requireString(row.content, `${path}.content`),
  };
}

function parseApplication(value: unknown): SkillApplicationResult {
  const row = asRecord(value);
  requireSchema(row, "skill-application.v1");
  const state = row.state;
  if (state !== "open" && state !== "closed_pending_episode" && state !== "pending_evaluation") {
    throw contractError("skill application state is invalid");
  }
  const role = row.role;
  if (role !== undefined && role !== "primary" && role !== "supporting") {
    throw contractError("skill application role is invalid");
  }
  return {
    applicationId: requireString(row.application_id, "application_id"),
    observationKey: requireString(row.observation_key, "observation_key"),
    episodeId: row.episode_id === null ? null : requireString(row.episode_id, "episode_id"),
    state,
    ...(row.version_id === undefined ? {} : { versionId: requireString(row.version_id, "version_id") }),
    ...(role === undefined ? {} : { role }),
    replayed: requireBoolean(row.replayed, "replayed"),
  };
}

function parseApplicationClose(value: unknown): SkillApplicationCloseResult {
  const row = asRecord(value);
  requireSchema(row, "skill-application.v1");
  const state = row.state;
  if (state !== "closed_pending_episode" && state !== "pending_evaluation") {
    throw contractError("closed skill application state is invalid");
  }
  return {
    applicationId: requireString(row.application_id, "application_id"),
    state,
    replayed: requireBoolean(row.replayed, "replayed"),
  };
}

function requireQualityState(value: unknown, path: string): LearnedSkillQualityState {
  if (
    value !== "active_unproven"
    && value !== "active_observed"
    && value !== "needs_review"
    && value !== "degraded"
    && value !== "quarantined"
  ) {
    throw contractError(`${path} is invalid`);
  }
  return value;
}

function requireSchema(row: Record<string, unknown>, schema: string): void {
  if (row.schema !== schema) throw contractError(`expected schema ${schema}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contractError("response must be an object");
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw contractError(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw contractError(`${path} must be a string`);
  return value;
}

function requireText(path: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw contractError(`${path} must be non-empty`);
  return value.trim();
}

function requireIdentifier(path: string, value: unknown): string {
  const text = requireText(path, value);
  if (text.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw contractError(`${path} is not a safe identifier`);
  }
  return text;
}

function requireIdempotencyKey(value: unknown): string {
  const key = requireText("idempotencyKey", value);
  if (key.length > 256 || /[^\x21-\x7e]/.test(key)) throw contractError("idempotencyKey is invalid");
  return key;
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw contractError(`${path} must be a lowercase SHA-256`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw contractError(`${path} must be boolean`);
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw contractError(`${path} must be a non-negative integer`);
  return value as number;
}

function nullableSequence(value: unknown, path: string): number | null {
  return value === null ? null : requireNonNegativeInteger(value, path);
}

function requireStringList(path: string, values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw contractError(`${path} must be an array`);
  return values.map((value, index) => requireIdentifier(`${path}[${index}]`, value));
}

function contractError(message: string): EvolutionClientError {
  return new EvolutionClientError(message, "evolution_contract_error", 0, false);
}
