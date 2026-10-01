import { canonicalRequestHash } from "../hashing.ts";
import { conflictApiError, notFoundError, validationError } from "../api/errors.ts";
import { validationInputs } from "./validation-inputs.ts";

export interface ConfigurationQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ProjectConfiguration {
  project_id: string;
  epoch: number;
  target_part: string | null;
  target_frequency_mhz: number | null;
  constraints: { path: string; content: string }[];
  created_at: unknown;
}

export interface ProjectTurnConfiguration {
  part: string | null;
  epoch: number;
  target_frequency_mhz?: number | null;
  constraints?: { path: string; content: string }[];
}

export async function lockProjectConfiguration(query: ConfigurationQuery, projectId: string): Promise<Record<string, unknown>> {
  const result = await query.query("SELECT * FROM project WHERE id=$1 FOR UPDATE", [projectId]);
  if (!result.rows[0]) throw notFoundError(`project not found: ${projectId}`);
  return result.rows[0] as Record<string, unknown>;
}

export async function readProjectConfiguration(query: ConfigurationQuery, projectId: string, epoch?: number): Promise<ProjectConfiguration | null> {
  const result = await query.query(
    `SELECT configuration.* FROM project_configuration configuration JOIN project ON project.id=configuration.project_id
     WHERE project.id=$1 AND configuration.epoch=COALESCE($2,project.config_epoch)`, [projectId, epoch ?? null],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? { ...row, epoch: Number(row.epoch), target_frequency_mhz: row.target_frequency_mhz === null ? null : Number(row.target_frequency_mhz) } as ProjectConfiguration : null;
}

/** Report content stays immutable; its current/historical label is derived. */
export async function readJobConfigurationMetadata(query: ConfigurationQuery, projectId: string, jobId: string): Promise<Record<string, unknown>> {
  const result = await query.query(`SELECT run.config_epoch,run.validation_chain_hash,run.parameters->>'part' AS part,
    project.config_epoch AS current_epoch,project.project_type FROM tool_run run JOIN project ON project.id=run.project_id
    WHERE run.project_id=$1 AND run.id=$2`, [projectId, jobId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || row.project_type !== "free") return {};
  return { configEpoch: row.config_epoch, part: row.part, validationChainHash: row.validation_chain_hash,
    evidenceScope: row.config_epoch === null ? "unattributed" : row.config_epoch === row.current_epoch ? "current" : "historical",
    configuration: row.config_epoch === null ? null : await readProjectConfiguration(query, projectId, Number(row.config_epoch)) };
}

export async function configurationBlockers(query: ConfigurationQuery, projectId: string): Promise<{ kind: string; id: string; state: string }[]> {
  const result = await query.query(
    `SELECT 'task' AS kind,id,status AS state FROM agent_task WHERE project_id=$1 AND status IN ('queued','running')
     UNION ALL SELECT 'job',id,state::text FROM tool_run WHERE project_id=$1
     AND state IN ('submitted','queued','preparing','running','cancelling','lost','unknown_effect')`, [projectId],
  );
  return result.rows as { kind: string; id: string; state: string }[];
}

export function concretePart(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.toLowerCase() === "any") {
    throw validationError("a concrete device part is required");
  }
  return value;
}

export function normalizeConstraints(value: unknown): { path: string; content: string }[] {
  if (!Array.isArray(value) || value.length > 32) throw validationError("constraints must contain at most 32 files");
  const paths = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw validationError("invalid constraint file");
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || !/^[A-Za-z0-9_./-]+\.xdc$/.test(file.path)
      || file.path.startsWith("/") || file.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || paths.has(file.path) || typeof file.content !== "string" || Buffer.byteLength(file.content) > 1024 * 1024) {
      throw validationError("invalid or duplicate constraint file");
    }
    paths.add(file.path);
    return { path: file.path, content: file.content };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export async function bindJobConfiguration(query: ConfigurationQuery, projectId: string, part: string | null,
  constraints: readonly { path: string; content: string }[], sources: readonly { path: string; content: string }[], top: string | null,
  taskId?: string | null): Promise<{ epoch: number | null; part: string | null; constraints: { path: string; content: string }[]; chainHash: string | null }> {
  const project = await lockProjectConfiguration(query, projectId);
  if (project.project_type !== "free") return { epoch: null, part, constraints: [...constraints], chainHash: null };
  const configuration = (await readProjectConfiguration(query, projectId))!;
  if (taskId) {
    const task = await query.query("SELECT config_epoch FROM agent_task WHERE id=$1 AND project_id=$2", [taskId, projectId]);
    if (!task.rows[0] || Number((task.rows[0] as Record<string, unknown>).config_epoch) !== configuration.epoch) throw conflictApiError("TASK_CONFIGURATION_STALE");
  }
  const configuredPart = concretePart(configuration.target_part);
  const effectivePart = concretePart(part ?? configuredPart);
  if (effectivePart !== configuredPart) throw conflictApiError("PROJECT_PART_MISMATCH");
  const effectiveConstraints = normalizeConstraints(constraints.length ? constraints : configuration.constraints);
  if (configuration.constraints.length && canonicalRequestHash(effectiveConstraints) !== canonicalRequestHash(configuration.constraints)) {
    throw conflictApiError("PROJECT_CONSTRAINTS_MISMATCH");
  }
  const inputs = validationInputs(sources, top);
  return { epoch: configuration.epoch, part: effectivePart, constraints: effectiveConstraints,
    chainHash: canonicalRequestHash({ epoch: configuration.epoch, part: effectivePart, sources: inputs.design, top: inputs.top, constraints: effectiveConstraints }) };
}
