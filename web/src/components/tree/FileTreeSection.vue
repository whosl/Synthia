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
import Badge from "../ui/AppBadge.vue";

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
  <div class="min-h-0 flex-1 overflow-y-auto pt-1 pb-2">
    <div v-if="result.degraded" class="m-2 rounded-md bg-hover p-3 text-xs leading-[1.4] text-fg-secondary">
      <p class="m-0 mb-2">{{ result.degradedMessage }}</p>
      <button
        v-if="offersViewEscape"
        type="button"
        class="cursor-pointer border-0 bg-transparent p-0 text-xs text-brand hover:text-brand-hover"
        @click="emit('escape-view')"
      >
        切到产物类型视图
      </button>
    </div>

    <div v-else-if="result.groups.length === 0" class="p-3 text-center text-xs text-fg-muted">{{ result.degradedMessage ?? "暂无产物" }}</div>

    <div
      v-for="group in result.groups"
      v-else
      :key="group.key"
      class="rounded-sm transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
      :class="highlightedGroupKey === group.key ? 'bg-brand-subtle' : ''"
      :data-group-key="group.key"
    >
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-1 border-0 bg-transparent px-3 py-1 text-left text-xs leading-[1.4] text-fg-secondary hover:text-fg"
        @click="emit('toggle-group', group.key)"
      >
        <span
          class="inline-block text-[10px] transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]"
          :class="isCollapsed(group.key) ? '-rotate-90' : ''"
          aria-hidden="true"
        >▾</span>
        <span class="flex-1 text-left font-medium">{{ group.label }}</span>
        <span class="text-[11px] text-fg-muted tabular-nums">{{ group.files.length }}</span>
      </button>

      <ul v-if="!isCollapsed(group.key)" class="m-0 list-none p-0">
        <li v-for="file in group.files" :key="file.artifactId">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent py-1 pr-3 pl-5 text-left text-[13px] leading-[1.4] text-fg"
            :class="[
              file.artifactId === openArtifactId
                ? 'bg-brand-subtle text-brand'
                : highlightedPhase !== null && file.phase === highlightedPhase
                  ? 'bg-brand-subtle transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]'
                  : 'hover:bg-hover',
            ]"
            :data-phase="file.phase ?? undefined"
            :title="file.path ?? file.name"
            @click="emit('open-file', file.artifactId)"
          >
            <span class="flex-1 truncate">{{ file.name }}</span>
            <span v-if="file.revisionCount > 1 && file.latestRevision" class="flex-none font-mono text-[11px] text-fg-muted tabular-nums">
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

