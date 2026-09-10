<script setup lang="ts">
/**
 * 中栏编辑器顶部版本下拉（spec §3.2/§3.3：多 revision 时树上只展示最新版，
 * 完整版本历史在这里通过下拉列出）。
 *
 * 列出该 artifact 的全部 revision（版本号 + 状态点 + 时间），点击即
 * emit "select-revision"，具体的内容拉取由 ProjectView 负责，本组件只吐意图。
 * 第一批不做版本对比选择 UI——`compare-revisions` 是 CodeEditorEmits 上的占位，
 * 留给后续批次在这里加"对比"入口时使用。
 */
import { computed, ref } from "vue";
import type { ArtifactRevision } from "../../api/types.ts";
import { REVISION_STATE_TEXT } from "../../domain/gates.ts";
import { artifactDotState, ARTIFACT_DOT_TEXT, ARTIFACT_DOT_TONE } from "../../views/project-view-contract.ts";
import Dropdown from "../ui/Dropdown.vue";
import Badge from "../ui/Badge.vue";

const props = defineProps<{
  /** 该 artifact 的全部版本，顺序不限（本组件自行按版本号降序展示）。 */
  revisions: readonly ArtifactRevision[];
  /** 当前查看的版本 id；未选中（不应出现，防御性处理）为 null。 */
  activeRevisionId: string | null;
}>();

const emit = defineEmits<{
  "select-revision": [revisionId: string];
}>();

const open = ref(false);

const activeRevision = computed<ArtifactRevision | null>(
  () => props.revisions.find((r) => r.id === props.activeRevisionId) ?? null,
);

/** 下拉列表按版本号降序（最新版在最上）。 */
const sortedRevisions = computed(() => [...props.revisions].sort((a, b) => b.version - a.version));

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function onSelect(revisionId: string): void {
  open.value = false;
  if (revisionId === props.activeRevisionId) return;
  emit("select-revision", revisionId);
}
</script>

<template>
  <Dropdown v-model:open="open" align="start" class="version-bar">
    <template #trigger>
      <button type="button" class="version-bar-trigger">
        <span v-if="activeRevision" class="version-bar-version">v{{ activeRevision.version }}</span>
        <span v-else class="version-bar-version version-bar-empty">无版本</span>
        <Badge
          v-if="activeRevision"
          variant="dot"
          size="sm"
          :tone="ARTIFACT_DOT_TONE[artifactDotState(activeRevision.state)]"
        >
          {{ ARTIFACT_DOT_TEXT[artifactDotState(activeRevision.state)] }}
        </Badge>
        <span class="version-bar-caret" aria-hidden="true">▾</span>
      </button>
    </template>

    <div class="version-bar-list" role="listbox">
      <p v-if="sortedRevisions.length === 0" class="version-bar-list-empty">暂无版本</p>
      <button
        v-for="rev in sortedRevisions"
        :key="rev.id"
        type="button"
        role="option"
        class="version-bar-item"
        :aria-selected="rev.id === activeRevisionId"
        :class="{ 'version-bar-item-active': rev.id === activeRevisionId }"
        @click="onSelect(rev.id)"
      >
        <span class="version-bar-item-version">v{{ rev.version }}</span>
        <Badge variant="dot" size="sm" :tone="ARTIFACT_DOT_TONE[artifactDotState(rev.state)]">
          {{ REVISION_STATE_TEXT[rev.state] ?? ARTIFACT_DOT_TEXT[artifactDotState(rev.state)] }}
        </Badge>
        <span class="version-bar-item-time">{{ formatTime(rev.created_at) }}</span>
      </button>
    </div>
  </Dropdown>
</template>

<style scoped>
.version-bar-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 24px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.version-bar-trigger:hover {
  background: var(--surface-hover);
}

.version-bar-version {
  font-family: var(--font-mono);
  font-weight: 600;
}

.version-bar-empty {
  font-family: var(--font-sans);
  font-weight: 400;
  color: var(--text-muted);
}

.version-bar-caret {
  color: var(--text-muted);
  font-size: 10px;
}

.version-bar-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 220px;
  max-height: 280px;
  overflow: auto;
}

.version-bar-list-empty {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.version-bar-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.version-bar-item:hover {
  background: var(--surface-hover);
}

.version-bar-item-active {
  background: var(--accent-subtle);
}

.version-bar-item-version {
  font-family: var(--font-mono);
  font-weight: 600;
  min-width: 32px;
}

.version-bar-item-time {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}
</style>
