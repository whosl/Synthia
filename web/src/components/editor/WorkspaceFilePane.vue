<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, watch } from "vue";
import { api } from "../../api/service.ts";
import { useEditorContent } from "../../composables/use-editor-content.ts";
import { deriveReadonlyReason, languageFromPath } from "../../domain/editor-state.ts";
import { isTerminalStatus } from "../../domain/tasks.ts";
import type { WorkspaceFileTab } from "../../domain/workspace-tabs.ts";
import type { FileTreeEntry } from "../../views/project-view-contract.ts";
import type { Theme } from "../../domain/theme.ts";
import CodeEditor from "./CodeEditor.vue";
import Button from "../ui/AppButton.vue";

const WaveformViewer = defineAsyncComponent(() => import("../waveform/WaveformViewer.vue"));
const props = defineProps<{ projectId: string; tab: WorkspaceFileTab; entry: FileTreeEntry; agentStatus: string | null; theme: Theme }>();
const emit = defineEmits<{
  dirty: [value: boolean];
  saving: [value: boolean];
  saved: [];
  revision: [revisionId: string];
  compare: [baseRevisionId: string, headRevisionId: string];
  "exit-diff": [];
}>();
const { fileContent, fileContentLoading, contentSource, saving, saveError, diffAgainst, loadRevisionContent, loadWorkspaceContent, loadComparison, saveWorkspaceContent } = useEditorContent(api, props.projectId);
const editorEntry = computed(() => ({ ...props.entry, artifactId: props.tab.entry.artifactId }));
const revision = computed(() => props.tab.source === "workspace" ? props.entry.latestRevision : props.entry.revisions.find((row) => row.id === props.tab.revisionId) ?? props.tab.entry.revisions.find((row) => row.id === props.tab.revisionId) ?? null);
const readonlyReason = computed(() => deriveReadonlyReason({
  revisionState: revision.value?.state ?? null,
  agentStatus: props.agentStatus,
  inWorkspace: props.entry.status !== null,
  contentSource: contentSource.value,
}, isTerminalStatus));
const language = computed(() => props.entry.path ? languageFromPath(props.entry.path) : props.entry.artifactType === "RTL_SOURCE_SET" ? "verilog" : props.entry.artifactType === "TB_SOURCE_SET" ? "systemverilog" : "markdown");
watch(saving, (value) => emit("saving", value), { flush: "sync" });
async function load(): Promise<void> {
  const tab = props.tab;
  if (tab.source === "workspace") await loadWorkspaceContent(tab.entry.path!);
  else if (tab.source === "diff") {
    const base = tab.entry.revisions.find((row) => row.id === tab.baseRevisionId)!;
    const head = tab.entry.revisions.find((row) => row.id === tab.revisionId)!;
    await loadComparison(tab.entry.artifactId, base, head);
  } else await loadRevisionContent(tab.entry.artifactId, tab.revisionId!);
}
onMounted(() => { void load(); });
async function save(content: string): Promise<void> {
  if (readonlyReason.value || props.tab.source !== "workspace" || !props.entry.path) return;
  if (await saveWorkspaceContent(props.entry.path, content)) emit("saved");
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="saveError && fileContent === null && !fileContentLoading" class="flex-none border-b border-line px-3 py-2"><Button size="sm" @click="load">重新加载文件</Button></div>
  <WaveformViewer v-if="entry.path?.toLowerCase().endsWith('.vcd') && fileContent !== null && tab.source !== 'diff'" :content="fileContent" :name="entry.path.split('/').pop()!" />
  <CodeEditor v-else
    :file="editorEntry" :active-revision="revision" :content="fileContent" :content-source="contentSource"
    :loading="fileContentLoading" :readonly-reason="readonlyReason" :saving="saving" :save-error="saveError"
    :language="language" :theme="theme" :diff-against="diffAgainst"
    @save="save" @dirty-change="emit('dirty', $event)" @select-revision="emit('revision', $event)"
    @compare-revisions="(base, head) => emit('compare', base, head)" @exit-diff="emit('exit-diff')"
  />
  </div>
</template>
