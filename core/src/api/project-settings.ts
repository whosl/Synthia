import { randomUUID } from "node:crypto";
import { asObject, outboxEvent, requireString, runIdempotent, type HandlerResult, type RequestContext } from "./handlers.ts";
import { capabilityUnavailableError, conflictApiError, forbiddenError, notFoundError, validationError } from "./errors.ts";
import { canonicalRequestHash } from "../hashing.ts";
import { configurationBlockers, concretePart, lockProjectConfiguration, normalizeConstraints, readProjectConfiguration } from "../services/project-configuration.ts";
import type { ConfigurationQuery } from "../services/project-configuration.ts";
import { mapRuntimeError } from "./task-proxy.ts";

async function legacyActivityBlockers(ctx: RequestContext): Promise<{ kind: string; id: string; state: string }[]> {
  if (!ctx.runtimeClient) throw capabilityUnavailableError("Runtime activity cannot be confirmed");
  const known = await ctx.pool.query("SELECT id,runtime_agent_id FROM agent_task WHERE project_id=$1", [ctx.params.projectId]);
  const ids = new Set(known.rows.flatMap(row => [row.id, row.runtime_agent_id]));
  try {
    const snapshot = await ctx.runtimeClient.listTasks(ctx.params.projectId!);
    return (snapshot.agents ?? []).filter(agent => agent.project_id === ctx.params.projectId && !ids.has(agent.agent_id)
      && ["queued", "idle", "running", "awaiting_approval"].includes(agent.status))
      .map(agent => ({ kind: "task", id: agent.agent_id, state: `legacy_${agent.status}` }));
  } catch (error) { throw mapRuntimeError(error); }
}

async function requireSettingsAccess(ctx: RequestContext, write: boolean, query: ConfigurationQuery = ctx.pool): Promise<void> {
  if (write && ctx.identity.actorType !== "human") throw forbiddenError("only project owners may edit settings");
  if (ctx.identity.scopes.includes("core:admin")) return;
  const result = await query.query("SELECT role FROM role_assignment WHERE project_id=$1 AND actor_type=$2 AND actor_id=$3", [ctx.params.projectId, ctx.identity.actorType, ctx.identity.actorId]);
  if (!result.rows.length) throw notFoundError(`project not found: ${ctx.params.projectId}`);
  if (write && !result.rows.some((row) => ["owner", "project_owner", "admin"].includes(String((row as Record<string, unknown>).role)))) throw forbiddenError("project owner role required");
}

export async function getProjectSettings(ctx: RequestContext): Promise<HandlerResult> {
  await requireSettingsAccess(ctx, false);
  const result = await ctx.pool.query("SELECT id,name,scope,project_type,config_epoch,settings_revision FROM project WHERE id=$1", [ctx.params.projectId]);
  if (!result.rows[0]) throw notFoundError("project not found");
  const configuration = await readProjectConfiguration(ctx.pool, ctx.params.projectId!);
  const history = await ctx.pool.query("SELECT project_id,epoch,target_part,target_frequency_mhz,created_by_type,created_by,created_at FROM project_configuration WHERE project_id=$1 ORDER BY epoch DESC", [ctx.params.projectId]);
  let legacyBlockers: { kind: string; id: string; state: string }[] = [];
  let activityConfirmed = ctx.featureFlags?.sideTasks === true;
  if (activityConfirmed && result.rows[0].project_type === "free") {
    try { legacyBlockers = await legacyActivityBlockers(ctx); }
    catch { activityConfirmed = false; }
  }
  return { status: 200, data: { ...result.rows[0], configuration, history: history.rows,
    verification_edit_supported: activityConfirmed,
    blockers: [...await configurationBlockers(ctx.pool, ctx.params.projectId!), ...legacyBlockers] } };
}

export async function updateProjectSettings(ctx: RequestContext): Promise<HandlerResult> {
  await requireSettingsAccess(ctx, true);
  const body = asObject(ctx.body);
  const allowed = ["expected_revision", "name", "description", "target_part", "target_frequency_mhz", "constraints"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw validationError("unknown project settings field");
  if (!Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 1) throw validationError("expected_revision is required");
  const cached = await ctx.pool.query(`SELECT 1 FROM idempotency_records WHERE actor_type=$1 AND actor_id=$2 AND project_id=$3
    AND operation='update_project_settings' AND idempotency_key=$4 AND request_hash=$5 AND status='completed'`,
  [ctx.identity.actorType, ctx.identity.actorId, ctx.params.projectId, ctx.idempotencyKey, canonicalRequestHash(body)]);
  // Legacy turns cannot be started on the modern message route. Their already
  // running activity is checked before the short project transaction.
  const previous = await readProjectConfiguration(ctx.pool, ctx.params.projectId!);
  const verificationRequested = previous && (
    (body.target_part !== undefined && body.target_part !== previous.target_part)
    || (body.target_frequency_mhz !== undefined && body.target_frequency_mhz !== previous.target_frequency_mhz)
    || (body.constraints !== undefined && canonicalRequestHash(normalizeConstraints(body.constraints)) !== canonicalRequestHash(previous.constraints)));
  const legacyBlockers = verificationRequested && ctx.featureFlags?.sideTasks === true && !cached.rows.length ? await legacyActivityBlockers(ctx) : [];
  const { result } = await runIdempotent(ctx, "update_project_settings", ctx.params.projectId!, async (query) => {
    const project = await lockProjectConfiguration(query, ctx.params.projectId!);
    await requireSettingsAccess(ctx, true, query);
    if (project.project_type !== "free") throw forbiddenError("engineering configuration requires the formal workflow");
    if (Number(project.settings_revision) !== body.expected_revision) throw conflictApiError("PROJECT_SETTINGS_STALE");
    const previous = (await readProjectConfiguration(query, ctx.params.projectId!))!;
    const part = body.target_part === undefined ? previous.target_part : concretePart(body.target_part);
    const frequency = body.target_frequency_mhz === undefined ? previous.target_frequency_mhz : body.target_frequency_mhz;
    if (frequency !== null && (typeof frequency !== "number" || !Number.isFinite(frequency) || frequency <= 0 || frequency > 10000)) throw validationError("target_frequency_mhz must be positive or null");
    const constraints = body.constraints === undefined ? previous.constraints : normalizeConstraints(body.constraints);
    const changed = canonicalRequestHash({ part, frequency, constraints }) !== canonicalRequestHash({ part: previous.target_part, frequency: previous.target_frequency_mhz, constraints: previous.constraints });
    if (changed) {
      // Legacy Runtime-only tasks have no atomic activity reservation in Core.
      if (ctx.featureFlags?.sideTasks !== true) throw capabilityUnavailableError("verification edits require the Core-owned task lifecycle");
      const blockers = [...await configurationBlockers(query, ctx.params.projectId!), ...legacyBlockers];
      if (blockers.length) throw conflictApiError("PROJECT_CONFIGURATION_BUSY", { blockers });
    }
    const name = body.name === undefined ? project.name : requireString(body, "name").trim();
    const description = body.description === undefined ? project.scope : body.description;
    if (typeof description !== "string" || description.length > 20000 || !String(name).length || String(name).length > 256) throw validationError("project text is too long or invalid");
    const epoch = Number(project.config_epoch) + (changed ? 1 : 0);
    if (changed) await query.query(
      `INSERT INTO project_configuration(project_id,epoch,target_part,target_frequency_mhz,constraints,created_by_type,created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, [project.id, epoch, part, frequency, JSON.stringify(constraints), ctx.identity.actorType, ctx.identity.actorId],
    );
    const edited = changed || name !== project.name || description !== project.scope;
    const updated = await query.query("UPDATE project SET name=$2,scope=$3,target_part=$4,config_epoch=$5,settings_revision=settings_revision+$6 WHERE id=$1 RETURNING id,name,scope,config_epoch,settings_revision",
      [project.id, name, description, part, epoch, edited ? 1 : 0]);
    if (edited) await outboxEvent(query, ctx, { type: "project", id: String(project.id) }, "project.settings_changed", { epoch, configurationChanged: changed, eventId: randomUUID() });
    return { ...(updated.rows[0] as Record<string, unknown>), configuration: await readProjectConfiguration(query, String(project.id)) };
  }, (query) => requireSettingsAccess(ctx, true, query));
  return { status: 200, data: result };
}
