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
import Badge from "../ui/AppBadge.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

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
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="inline-flex h-6 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 text-xs text-fg hover:bg-hover"
      >
        <span v-if="activeRevision" class="font-mono font-semibold tabular-nums">v{{ activeRevision.version }}</span>
        <span v-else class="font-sans font-normal text-fg-muted">无版本</span>
        <Badge
          v-if="activeRevision"
          variant="dot"
          size="sm"
          :tone="ARTIFACT_DOT_TONE[artifactDotState(activeRevision.state)]"
        >
          {{ ARTIFACT_DOT_TEXT[artifactDotState(activeRevision.state)] }}
        </Badge>
        <span class="text-[10px] text-fg-muted" aria-hidden="true">▾</span>
      </button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="start" class="max-h-[280px] min-w-[220px]">
      <p v-if="sortedRevisions.length === 0" class="m-0 px-3 py-2 text-xs text-fg-muted">暂无版本</p>
      <DropdownMenuItem v-for="rev in sortedRevisions" :key="rev.id" as-child>
        <button
          type="button"
          role="option"
          class="flex cursor-pointer items-center gap-2 rounded-sm border-0 px-2 py-1 text-left text-xs text-fg hover:bg-hover"
          :class="rev.id === activeRevisionId ? 'bg-brand-subtle' : 'bg-transparent'"
          :aria-selected="rev.id === activeRevisionId"
          @click="onSelect(rev.id)"
        >
          <span class="min-w-[32px] font-mono font-semibold tabular-nums">v{{ rev.version }}</span>
          <Badge variant="dot" size="sm" :tone="ARTIFACT_DOT_TONE[artifactDotState(rev.state)]">
            {{ REVISION_STATE_TEXT[rev.state] ?? ARTIFACT_DOT_TEXT[artifactDotState(rev.state)] }}
          </Badge>
          <span class="ml-auto text-[11px] whitespace-nowrap text-fg-muted tabular-nums">{{ formatTime(rev.created_at) }}</span>
        </button>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
