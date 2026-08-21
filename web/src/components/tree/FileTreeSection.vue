<script setup lang="ts">
/**
 * 文件树的一栏（上「源文件」/ 下「文档产物」共用）。
 *
 * 纯展示组件：只画 `domain/file-tree.ts` 已经建好的 `FileTreeResult`，不做任何
 * 分组决策。折叠态存在父组件（FileTree.vue）里而不是这里——顶栏点阶段节点定位
 * 时需要先把目标分组展开，那个动作跨栏发生，状态必须在共同的父层。父层用
 * `${keyPrefix}:${groupKey}` 做键，两栏的分组 key 因此不会互相顶掉（上栏的
 * `rtl` 与下栏的 GJB 文档名分属不同命名空间）。
 */
import type { WorkspaceFileStatus } from "../../api/types.ts";
import type { FileTreeResult } from "../../domain/file-tree.ts";
import { ARTIFACT_DOT_TONE } from "../../views/project-view-contract.ts";
import Badge from "../ui/Badge.vue";

const props = defineProps<{
  result: FileTreeResult;
  /** 折叠键命名空间，见文件头注释。 */
  keyPrefix: string;
  collapsed: ReadonlySet<string>;
  openArtifactId: string | null;
  /** 当前被顶栏定位高亮的分组 key（未加前缀）。 */
  highlightedGroupKey: string | null;
  /** 当前被顶栏定位高亮的阶段——分组里找不到时退到按行的 phase 高亮。 */
  highlightedPhase: string | null;
  /** 降级提示下方是否给「切到产物类型视图」的出口（只有上栏需要）。 */
  offersViewEscape: boolean;
}>();

const emit = defineEmits<{
  "toggle-group": [key: string];
  "open-file": [artifactId: string];
  "escape-view": [];
}>();

/**
 * 待登记角标：盘上的字节还没进治理链，这一行的状态点说的**不是**盘上那份内容。
 *
 * `dirty` 尤其要标出来——它的状态点会照常显示「已批准」，可盘上的字节早被人改过，
 * 不标一下就等于拿批准过的名义盖在没人看过的内容上。`registered` 无话可说，
 * `ignored` 压根不进树（见 `domain/file-tree.ts:buildFileTreeEntries`）。
 */
const PENDING_BADGE: Readonly<Partial<Record<WorkspaceFileStatus, string>>> = {
  dirty: "已改动",
  untracked: "新文件",
};

/** 这一行要不要出待登记角标；不在工作区里的产物（status 为 null）自然不出。 */
function pendingBadge(status: WorkspaceFileStatus | null): string | null {
  return status ? PENDING_BADGE[status] ?? null : null;
}

function isCollapsed(key: string): boolean {
  return props.collapsed.has(`${props.keyPrefix}:${key}`);
}
</script>

<template>
  <div class="filetree-section-body">
    <div v-if="result.degraded" class="filetree-degraded">
      <p>{{ result.degradedMessage }}</p>
      <button v-if="offersViewEscape" type="button" class="filetree-degraded-action" @click="emit('escape-view')">
        切到产物类型视图
      </button>
    </div>

    <div v-else-if="result.groups.length === 0" class="filetree-empty">{{ result.degradedMessage ?? "暂无产物" }}</div>

    <div
      v-for="group in result.groups"
      v-else
      :key="group.key"
      class="filetree-group"
      :class="{ 'is-highlighted': highlightedGroupKey === group.key }"
      :data-group-key="group.key"
    >
      <button type="button" class="filetree-group-header" @click="emit('toggle-group', group.key)">
        <span class="filetree-group-caret" :class="{ 'is-collapsed': isCollapsed(group.key) }" aria-hidden="true">▾</span>
        <span class="filetree-group-label">{{ group.label }}</span>
        <span class="filetree-group-count">{{ group.files.length }}</span>
      </button>

      <ul v-if="!isCollapsed(group.key)" class="filetree-file-list">
        <li v-for="file in group.files" :key="file.artifactId">
          <button
            type="button"
            class="filetree-file"
            :class="{
              'is-active': file.artifactId === openArtifactId,
              'is-highlighted': highlightedPhase !== null && file.phase === highlightedPhase,
            }"
            :data-phase="file.phase ?? undefined"
            :title="file.path ?? file.name"
            @click="emit('open-file', file.artifactId)"
          >
            <span class="filetree-file-name">{{ file.name }}</span>
            <span v-if="file.revisionCount > 1 && file.latestRevision" class="filetree-file-version">
              v{{ file.latestRevision.version }}
            </span>
            <Badge v-if="pendingBadge(file.status)" variant="dot" size="sm" tone="warn">
              {{ pendingBadge(file.status) }}
            </Badge>
            <Badge variant="dot" size="sm" :tone="ARTIFACT_DOT_TONE[file.dotState]">{{ file.dotText }}</Badge>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.filetree-section-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1) 0 var(--space-2);
}

.filetree-degraded {
  margin: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.filetree-degraded p {
  margin: 0 0 var(--space-2);
}

.filetree-degraded-action {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: var(--font-size-sm);
  cursor: pointer;
  padding: 0;
}

.filetree-degraded-action:hover {
  color: var(--accent-hover);
}

.filetree-empty {
  padding: var(--space-3);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.filetree-group {
  border-radius: var(--radius-sm);
  transition: background-color var(--duration-slow) var(--ease-out);
}

.filetree-group.is-highlighted {
  background: var(--accent-subtle);
}

.filetree-group-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: var(--space-1) var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-list);
}

.filetree-group-header:hover {
  color: var(--text-primary);
}

.filetree-group-caret {
  display: inline-block;
  font-size: 10px;
  transition: transform var(--duration) var(--ease-out);
}

.filetree-group-caret.is-collapsed {
  transform: rotate(-90deg);
}

.filetree-group-label {
  flex: 1;
  text-align: left;
  font-weight: 500;
}

.filetree-group-count {
  color: var(--text-muted);
  font-size: 11px;
}

.filetree-file-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.filetree-file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-5);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  line-height: var(--line-height-list);
  border-radius: var(--radius-sm);
  text-align: left;
}

.filetree-file:hover {
  background: var(--surface-hover);
}

.filetree-file.is-highlighted {
  background: var(--accent-subtle);
  transition: background-color var(--duration-slow) var(--ease-out);
}

.filetree-file.is-active {
  background: var(--accent-subtle);
  color: var(--accent);
}

.filetree-file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filetree-file-version {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-family: var(--font-mono);
}
</style>
