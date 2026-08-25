import type { Pool, PoolClient } from "pg";
import type { TransactionClient } from "../db/repository.ts";
import { conflictApiError } from "./errors.ts";

type QueryClient = Pick<Pool, "query"> | TransactionClient;

export type P4ProjectMutationLockOwner =
  | "workspace.put"
  | "workspace.register"
  | "workspace.files"
  | "revision.create"
  | "side-task.adopt"
  | "readiness.prepare"
  | "readiness.confirm"
  | "formal-input.confirm"
  | "g4.evaluate"
  | "g4.submit"
  | "g4.approve"
  | "change-request.withdraw";

export type P4ProjectMutationLockPhase = "beforeAcquire" | "afterAcquire";

type P4ProjectMutationLockHook = () => void | Promise<void>;

interface TestHookRegistration {
  readonly projectId: string;
  readonly owner: P4ProjectMutationLockOwner;
  readonly phase: P4ProjectMutationLockPhase;
  readonly callback: P4ProjectMutationLockHook;
}

const testHooks = new Set<TestHookRegistration>();

function projectMutationLockKey(projectId: string): string {
  return `p4-project-mutation:${projectId}`;
}

async function runTestHooks(
  projectId: string,
  owner: P4ProjectMutationLockOwner,
  phase: P4ProjectMutationLockPhase,
): Promise<void> {
  const matching = [...testHooks].filter((hook) => (
    hook.projectId === projectId
    && hook.owner === owner
    && hook.phase === phase
  ));
  for (const hook of matching) {
    // Hooks are deliberately one-shot. A replay or a second lock acquisition
    // must not accidentally reuse a barrier installed for one interleaving.
    testHooks.delete(hook);
    await hook.callback();
  }
}

/**
 * Install a one-shot, promise-based lock hook for deterministic concurrency
 * tests. Production code never registers hooks; no timers or sleeps are used.
 */
export function installP4ProjectMutationLockTestHook(
  projectId: string,
  owner: P4ProjectMutationLockOwner,
  phase: P4ProjectMutationLockPhase,
  callback: P4ProjectMutationLockHook,
): () => void {
  const registration = { projectId, owner, phase, callback };
  testHooks.add(registration);
  return () => testHooks.delete(registration);
}

export async function isModernP4Project(
  query: QueryClient,
  projectId: string,
): Promise<boolean> {
  const projectResult = await query.query(
    `SELECT project_type, process_version_id, process_profile_id
       FROM project WHERE id = $1`,
    [projectId],
  );
  const project = projectResult.rows[0] as {
    project_type?: string;
    process_version_id?: string | null;
    process_profile_id?: string | null;
  } | undefined;
  return project?.project_type === "engineering"
    && project.process_version_id === "GJB_REF_V1"
    && project.process_profile_id === "GJB_REF_V1";
}

/**
 * Acquire the process-wide lock used by local Git mutations. The caller must
 * keep this exact PoolClient until Git and all convergence transactions finish.
 */
export async function acquireP4ProjectMutationSessionLock(
  client: Pick<PoolClient, "query">,
  projectId: string,
  owner: P4ProjectMutationLockOwner,
): Promise<void> {
  await runTestHooks(projectId, owner, "beforeAcquire");
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended($1, 0))",
    [projectMutationLockKey(projectId)],
  );
  try {
    await runTestHooks(projectId, owner, "afterAcquire");
  } catch (error) {
    await client.query(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      [projectMutationLockKey(projectId)],
    ).catch(() => undefined);
    throw error;
  }
}

export async function releaseP4ProjectMutationSessionLock(
  client: Pick<PoolClient, "query">,
  projectId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
    [projectMutationLockKey(projectId)],
  );
}

/** Serialize DB-only P4 transitions with the session lock used around Git. */
export async function acquireP4ProjectMutationTransactionLock(
  tx: TransactionClient,
  projectId: string,
  owner: P4ProjectMutationLockOwner,
): Promise<void> {
  await runTestHooks(projectId, owner, "beforeAcquire");
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [projectMutationLockKey(projectId)],
  );
  await runTestHooks(projectId, owner, "afterAcquire");
}

/** Legacy projects deliberately skip the P4 serialization boundary. */
export async function acquireP4ProjectMutationTransactionLockIfModern(
  tx: TransactionClient,
  projectId: string,
  owner: P4ProjectMutationLockOwner,
): Promise<boolean> {
  if (!(await isModernP4Project(tx, projectId))) return false;
  await acquireP4ProjectMutationTransactionLock(tx, projectId, owner);
  return true;
}

/** Enforce the post-release change-request boundary for modern P4 projects. */
export async function requireP4ChangeWorkVersion(
  query: QueryClient,
  projectId: string,
): Promise<string | null> {
  if (!(await isModernP4Project(query, projectId))) return null;

  const activeResult = await query.query(
    `SELECT id FROM project_work_version
      WHERE project_id = $1 AND state IN ('working','in_review')
      ORDER BY version DESC LIMIT 1`,
    [projectId],
  );
  const activeId = (activeResult.rows[0] as { id?: string } | undefined)?.id;
  if (activeId) return activeId;

  const releaseResult = await query.query(
    "SELECT id FROM delivery_release WHERE project_id = $1 ORDER BY version DESC LIMIT 1",
    [projectId],
  );
  const releaseId = (releaseResult.rows[0] as { id?: string } | undefined)?.id;
  if (releaseId) {
    throw conflictApiError("CHANGE_REQUEST_REQUIRED", {
      currentDeliveryReleaseId: releaseId,
    });
  }
  return null;
}
