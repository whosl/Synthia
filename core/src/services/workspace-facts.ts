import { hashPayload } from "../hashing.ts";
import { headSha } from "../workspace/git.ts";
import { projectWorkspaceDir } from "../workspace/paths.ts";
import {
  ensureWorkspace,
  pendingChanges,
  readTreeAt,
} from "../workspace/store.ts";

export interface WorkspaceFactsV1 {
  readonly commit: string;
  readonly manifestHash: string;
  readonly pending: readonly string[];
  readonly skippedBinary: readonly string[];
}

/**
 * Core-owned workspace fact used by both the discoverable workspace API and
 * P4 readiness. Keeping this in one function prevents clients from inventing a
 * subtly different manifest (especially around ignored binary tree entries).
 */
export async function collectWorkspaceFacts(projectId: string): Promise<WorkspaceFactsV1> {
  await ensureWorkspace(projectId);
  const commit = await headSha(projectWorkspaceDir(projectId));
  if (commit === null) {
    throw new Error(`workspace has no HEAD commit: ${projectId}`);
  }
  const tree = await readTreeAt(projectId, commit);
  const pending = (await pendingChanges(projectId)).map((entry) => entry.path).sort();
  return {
    commit,
    manifestHash: hashPayload({
      schema: "workspace-manifest.v1",
      commit,
      files: tree.files.map((file) => ({ path: file.path, sha256: file.contentHash })),
      skippedBinary: tree.skippedBinary,
    }),
    pending,
    skippedBinary: tree.skippedBinary,
  };
}
