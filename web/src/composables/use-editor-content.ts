import { onScopeDispose, ref } from "vue";
import type { ApiClient } from "../api/client.ts";
import {
  getRevisionContent,
  getWorkspaceFile,
  putWorkspaceFile,
} from "../api/index.ts";
import type { ArtifactRevision } from "../api/types.ts";
import { humanizeLoadError } from "../domain/unified.ts";
import type { CodeEditorProps } from "../views/project-view-contract.ts";

/** Own the identity of every read/write; late responses cannot replace another file. */
export function useEditorContent(client: ApiClient, projectId: string) {
  const fileContent = ref<string | null>(null);
  const fileContentLoading = ref(false);
  const contentSource = ref<"workspace" | "revision">("revision");
  const saving = ref(false);
  const saveError = ref<string | null>(null);
  const diffAgainst = ref<CodeEditorProps["diffAgainst"]>(null);
  let generation = 0;
  let disposed = false;

  function resetContent(): number {
    generation += 1;
    fileContent.value = null;
    fileContentLoading.value = false;
    contentSource.value = "revision";
    diffAgainst.value = null;
    saveError.value = null;
    return generation;
  }

  async function read(
    load: () => Promise<{
      content: string;
      source: "workspace" | "revision";
      diff?: CodeEditorProps["diffAgainst"];
    }>,
  ): Promise<void> {
    const request = resetContent();
    fileContentLoading.value = true;
    try {
      const result = await load();
      if (disposed || request !== generation) return;
      fileContent.value = result.content;
      contentSource.value = result.source;
      diffAgainst.value = result.diff ?? null;
    } catch (cause) {
      if (!disposed && request === generation)
        saveError.value = humanizeLoadError(cause);
    } finally {
      if (!disposed && request === generation) fileContentLoading.value = false;
    }
  }

  function loadRevisionContent(
    artifactId: string,
    revisionId: string,
  ): Promise<void> {
    return read(async () => ({
      ...(await getRevisionContent(client, projectId, artifactId, revisionId)),
      source: "revision",
    }));
  }

  function loadWorkspaceContent(path: string): Promise<void> {
    return read(async () => ({
      ...(await getWorkspaceFile(client, projectId, path)),
      source: "workspace",
    }));
  }

  function loadComparison(
    artifactId: string,
    base: ArtifactRevision,
    head: ArtifactRevision,
  ): Promise<void> {
    return read(async () => {
      const [baseResult, headResult] = await Promise.all([
        getRevisionContent(client, projectId, artifactId, base.id),
        getRevisionContent(client, projectId, artifactId, head.id),
      ]);
      return {
        content: headResult.content,
        source: "revision",
        diff: { base, baseContent: baseResult.content, head },
      };
    });
  }

  async function saveWorkspaceContent(
    path: string,
    content: string,
  ): Promise<boolean> {
    if (
      saving.value ||
      disposed ||
      fileContentLoading.value ||
      contentSource.value !== "workspace" ||
      fileContent.value === null
    )
      return false;
    const request = generation;
    saving.value = true;
    saveError.value = null;
    try {
      await putWorkspaceFile(client, projectId, path, content);
      if (!disposed && request === generation) fileContent.value = content;
      return true;
    } catch (cause) {
      if (!disposed && request === generation)
        saveError.value = humanizeLoadError(cause);
      return false;
    } finally {
      if (!disposed) saving.value = false;
    }
  }

  onScopeDispose(() => {
    disposed = true;
    generation += 1;
  });
  return {
    fileContent,
    fileContentLoading,
    contentSource,
    saving,
    saveError,
    diffAgainst,
    resetContent,
    loadRevisionContent,
    loadWorkspaceContent,
    loadComparison,
    saveWorkspaceContent,
  };
}
