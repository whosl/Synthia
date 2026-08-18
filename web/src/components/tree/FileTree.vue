<script setup lang="ts">
/**
 * 左栏文件树（spec §3.2）：三种视图切换 + 可展开折叠的分组树。
 *
 * 分组逻辑全部委托给 `domain/file-tree.ts:buildFileTree`（纯函数，测试见
 * tests/file-tree.test.ts）——本组件只负责渲染分组结果与折叠/高亮这类纯本地
 * UI 态，不重新实现任何分组规则，也不重新做 artifact↔TaskDocRef 关联
 * （entries 已经是 ProjectView 关联好的统一视图模型，见契约注释）。
 */
import { computed, nextTick, ref, watch } from "vue";
import type { FileTreeEmits, FileTreeProps } from "../../views/project-view-contract.ts";
import { buildFileTree, stageFocusGroupKey, type FileTreeFileNode } from "../../domain/file-tree.ts";
import Badge from "../ui/Badge.vue";
import ViewSwitcher from "./ViewSwitcher.vue";

const props = defineProps<FileTreeProps>();
const emit = defineEmits<FileTreeEmits>();

const result = computed(() => buildFileTree(props.entries, props.viewMode, props.hasAgent));

// ─── 分组展开/折叠（纯本地 UI 态：默认全部展开，不跨刷新保留）───────────────

const collapsedGroups = ref<Set<string>>(new Set());

function isCollapsed(key: string): boolean {
  return collapsedGroups.value.has(key);
}

function toggleGroup(key: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroups.value = next;
}

// ─── 状态点语气色（spec §3.2 四态 → Badge tone，走 --state-* 变量）──────────

const DOT_TONE: Readonly<Record<FileTreeFileNode["dotState"], "ok" | "info" | "danger" | "neutral">> = {
  approved: "ok",
  candidate: "info",
  rejected: "danger",
  invalidated: "neutral",
};

// ─── 点击文件：中栏打开 + 抽屉模式下自动收起 ─────────────────────────────

function onOpenFile(artifactId: string): void {
  emit("open-file", artifactId);
  if (props.drawerMode) emit("close-drawer");
}

// ─── 顶栏点击阶段节点 → 切到阶段视图并定位到该阶段分组（spec §3.1 末条）────

const treeScrollEl = ref<HTMLElement | null>(null);
const highlightedGroupKey = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

async function focusGroup(stageId: string): Promise<void> {
  const key = stageFocusGroupKey(stageId);
  collapsedGroups.value.delete(key); // 若原本折叠，先展开再定位
  collapsedGroups.value = new Set(collapsedGroups.value);
  await nextTick();
  const el = treeScrollEl.value?.querySelector<HTMLElement>(`[data-group-key="${CSS.escape(key)}"]`);
  if (!el) return; // 门节点（G1/G3/G4）在阶段视图里没有对应分组，静默忽略，不报错
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  highlightedGroupKey.value = key;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightedGroupKey.value = null;
  }, 1600);
}

watch(
  () => props.focusStageId,
  (stageId) => {
    if (stageId && props.viewMode === "stage") void focusGroup(stageId);
  },
);
watch(
  () => props.viewMode,
  (mode) => {
    if (mode === "stage" && props.focusStageId) void focusGroup(props.focusStageId);
  },
);
</script>

<template>
  <div class="filetree">
    <div class="filetree-header">
      <ViewSwitcher :model-value="viewMode" @update:model-value="emit('update:viewMode', $event)" />
    </div>

    <div ref="treeScrollEl" class="filetree-scroll">
      <div v-if="result.degraded" class="filetree-degraded">
        <p>{{ result.degradedMessage }}</p>
        <button type="button" class="filetree-degraded-action" @click="emit('update:viewMode', 'type')">切到产物类型视图</button>
      </div>

      <div v-else-if="result.groups.length === 0" class="filetree-empty">暂无产物</div>

      <div
        v-for="group in result.groups"
        v-else
        :key="group.key"
        class="filetree-group"
        :class="{ 'is-highlighted': highlightedGroupKey === group.key }"
        :data-group-key="group.key"
      >
        <button type="button" class="filetree-group-header" @click="toggleGroup(group.key)">
          <span class="filetree-group-caret" :class="{ 'is-collapsed': isCollapsed(group.key) }" aria-hidden="true">▾</span>
          <span class="filetree-group-label">{{ group.label }}</span>
          <span class="filetree-group-count">{{ group.files.length }}</span>
        </button>

        <ul v-if="!isCollapsed(group.key)" class="filetree-file-list">
          <li v-for="file in group.files" :key="file.artifactId">
            <button
              type="button"
              class="filetree-file"
              :class="{ 'is-active': file.artifactId === openArtifactId }"
              @click="onOpenFile(file.artifactId)"
            >
              <span class="filetree-file-name">{{ file.name }}</span>
              <span v-if="file.revisionCount > 1" class="filetree-file-version">v{{ file.latestRevision.version }}</span>
              <Badge variant="dot" size="sm" :tone="DOT_TONE[file.dotState]">{{ file.dotText }}</Badge>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filetree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
  color: var(--text-primary);
}

.filetree-header {
  flex: none;
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.filetree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) 0;
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
  padding: var(--space-4) var(--space-3);
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
