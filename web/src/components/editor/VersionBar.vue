<script setup lang="ts">
/**
 * 中栏编辑器顶部版本下拉（spec §3.2/§3.3：多 revision 时树上只展示最新版，
 * 完整版本历史在这里通过下拉列出）。
 *
 * 列出该 artifact 的全部 revision（版本号 + 状态点 + 时间），点击即
 * emit "select-revision"，具体的内容拉取由 ProjectView 负责，本组件只吐意图。
 * 每行另有 hover/focus 才出现的「对比」小按钮：把该行版本与当前查看版本送进
 * diff——base/head 在这里按版本号排好序再经 "compare-revisions" 上抛，
 * CodeEditor 透传、ProjectView 拉正文回填（compareRevisions）。当前版本行
 * 不出对比按钮：自己跟自己没的可比。
 */
import { computed, ref } from "vue";
import type { ArtifactRevision } from "../../api/types.ts";
import { formatTime } from "../../util/format-time.ts";
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
  /** 行内「对比」：base 为两版中版本号较小者，head 为较大者。 */
  "compare-revisions": [baseRevisionId: string, headRevisionId: string];
}>();

const open = ref(false);

const activeRevision = computed<ArtifactRevision | null>(
  () => props.revisions.find((r) => r.id === props.activeRevisionId) ?? null,
);

/** 下拉列表按版本号降序（最新版在最上）。 */
const sortedRevisions = computed(() => [...props.revisions].sort((a, b) => b.version - a.version));

/** 对比入口的前提：已确有「当前查看版本」，且存在另一版可与之对比。 */
const canCompare = computed(() => props.activeRevisionId !== null && props.revisions.length > 1);

function onSelect(revisionId: string): void {
  open.value = false;
  if (revisionId === props.activeRevisionId) return;
  emit("select-revision", revisionId);
}

/** 对比对象恒为「当前查看版本 × 该行进版本」；diff 语义上 base 必须是更早的那一版。 */
function onCompare(rev: ArtifactRevision): void {
  const current = activeRevision.value;
  if (!current || current.id === rev.id) return;
  open.value = false;
  const [base, head] = rev.version < current.version ? [rev, current] : [current, rev];
  emit("compare-revisions", base.id, head.id);
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
      <!-- 每行 = 选择按钮（menuitem 本体）+ 行内对比按钮；menuitem 语义留给选择动作，
           「当前查看版本」用 aria-current 表达，不再把 menuitem 伪装成 listbox option。 -->
      <div v-for="rev in sortedRevisions" :key="rev.id" class="group flex items-center">
        <DropdownMenuItem as-child class="min-w-0 flex-1">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 px-2 py-1 text-left text-xs text-fg hover:bg-hover"
            :class="rev.id === activeRevisionId ? 'bg-brand-subtle' : 'bg-transparent'"
            :aria-current="rev.id === activeRevisionId ? 'true' : undefined"
            @click="onSelect(rev.id)"
          >
            <span class="min-w-[32px] font-mono font-semibold tabular-nums">v{{ rev.version }}</span>
            <Badge variant="dot" size="sm" :tone="ARTIFACT_DOT_TONE[artifactDotState(rev.state)]">
              {{ REVISION_STATE_TEXT[rev.state] ?? ARTIFACT_DOT_TEXT[artifactDotState(rev.state)] }}
            </Badge>
            <span class="ml-auto text-[11px] whitespace-nowrap text-fg-muted tabular-nums">{{ formatTime(rev.created_at) }}</span>
          </button>
        </DropdownMenuItem>
        <button
          v-if="canCompare && rev.id !== activeRevisionId"
          type="button"
          class="invisible mx-1 flex-none cursor-pointer border-none bg-transparent p-0 text-[11px] text-fg-muted group-hover:visible group-focus-within:visible hover:text-brand"
          @click.stop="onCompare(rev)"
        >对比</button>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
