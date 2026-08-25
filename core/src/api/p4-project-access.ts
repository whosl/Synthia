import type { AuthenticatedIdentity } from "./auth.ts";
import { notFoundError } from "./errors.ts";

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

const ACTIVE_TASK_STATES = ["queued", "running", "awaiting_user"] as const;

/**
 * Enforce the tenant boundary for a project that the router has already
 * identified as a modern P4 project.  Deliberately collapse a missing role or
 * Runtime binding to the same 404 as a missing project so project ids cannot be
 * enumerated through any P4 endpoint.
 *
 * A service actor bound to a live main task only gains coarse project
 * visibility here. Formal submission still requires the singleton
 * task-runtime credential and performs the stronger approval/task/actor
 * binding check in `authorizeFormalSubmitter` before it can attach to or create
 * a ToolRun.
 */
export async function requireP4ProjectVisibility(
  query: QueryClient,
  identity: AuthenticatedIdentity,
  projectId: string,
): Promise<void> {
  if (identity.scopes.includes("core:admin")) return;

  const role = await query.query(
    `SELECT 1 FROM role_assignment
      WHERE project_id = $1 AND actor_type = $2 AND actor_id = $3
      LIMIT 1`,
    [projectId, identity.actorType, identity.actorId],
  );
  if (role.rows.length > 0) return;

  if (identity.actorType === "service") {
    const task = await query.query(
      `SELECT 1 FROM agent_task
        WHERE project_id = $1
          AND project_type = 'engineering'
          AND kind = 'main'
          AND runtime_actor_id = $2
          AND status = ANY($3::text[])
        LIMIT 1`,
      [projectId, identity.actorId, ACTIVE_TASK_STATES],
    );
    if (task.rows.length > 0) return;
  }

  throw notFoundError(`project not found: ${projectId}`);
}
