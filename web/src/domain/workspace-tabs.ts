import type { FileTreeEntry } from "../views/project-view-contract.ts";
import { artifactDocName } from "./artifacts.ts";

export interface WorkspaceFileTab {
  readonly id: string;
  readonly entry: FileTreeEntry;
  readonly source: "workspace" | "revision" | "diff";
  readonly revisionId: string | null;
  readonly baseRevisionId: string | null;
  readonly label: string;
  readonly description: string;
}

/** A workspace path, a frozen revision, and a comparison are separate documents. */
export function createFileTab(
  entry: FileTreeEntry,
  revisionId?: string,
  baseRevisionId?: string,
): WorkspaceFileTab | null {
  const source = baseRevisionId ? "diff" : !revisionId && entry.status !== null && entry.path ? "workspace" : "revision";
  const revision = revisionId ? entry.revisions.find((row) => row.id === revisionId) : entry.latestRevision;
  const base = baseRevisionId ? entry.revisions.find((row) => row.id === baseRevisionId) : null;
  // A missing snapshot revision must never silently open newer bytes.
  if (source !== "workspace" && (!revision || (baseRevisionId && !base))) return null;
  const name = entry.path?.split("/").pop() || artifactDocName(entry.artifactType);
  const suffix = source === "workspace" ? "" : source === "diff" ? ` · v${base!.version} ↔ v${revision!.version}` : ` · v${revision!.version}`;
  return {
    id: JSON.stringify(source === "workspace" ? [source, entry.path] : [source, entry.artifactId, revision!.id, baseRevisionId ?? null]),
    entry,
    source,
    revisionId: source === "workspace" ? null : revision!.id,
    baseRevisionId: baseRevisionId ?? null,
    label: name + suffix,
    description: `${entry.path ?? name}${suffix} · ${source === "workspace" ? "工作区" : source === "diff" ? "版本对比" : "快照 · 只读"}`,
  };
}

export function tabAfterClose(ids: readonly string[], activeId: string, closingId: string): string {
  if (closingId !== activeId) return activeId;
  const index = ids.indexOf(closingId);
  return ids[index + 1] ?? ids[index - 1] ?? "overview";
}
