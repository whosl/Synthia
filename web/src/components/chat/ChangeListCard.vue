<script setup lang="ts">
/**
 * 轮末「本轮改动」汇总卡：一轮里登记过的产物修订收成一张列表，
 * 每行点击进中栏 Monaco diff（有上一版时）或打开该版（首版/新文件）。
 *
 * diff 只做版间对比（这一版 vs 它的上一版），行级渲染是中栏编辑器的活，
 * 流内不重复实现（同 doc 卡的取舍，见 ChatFeed 头部注释）。
 */
import { FileDiff, FilePlus2 } from "lucide-vue-next";
import type { SynthiaChangesPart } from "../../domain/parts.ts";

defineProps<{ part: SynthiaChangesPart }>();

const emit = defineEmits<{
  "open-doc": [artifactId: string, revisionId: string];
  "open-diff": [artifactId: string, revisionId: string];
}>();

function open(item: SynthiaChangesPart["items"][number]): void {
  if (item.prevRevisionId !== null) {
    emit("open-diff", item.artifactId, item.revisionId);
  } else {
    emit("open-doc", item.artifactId, item.revisionId);
  }
}
</script>

<template>
  <div class="rounded-md border border-line bg-base px-3 py-2">
    <p class="m-0 mb-1.5 text-[11px] font-semibold text-fg-muted">
      本轮改动 · {{ part.items.length }} 个文件
    </p>
    <div class="flex flex-col">
      <button
        v-for="item in part.items"
        :key="item.revisionId"
        type="button"
        class="group flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-1.5 py-1 text-left text-xs text-fg hover:bg-hover"
        :title="item.prevRevisionId !== null ? '查看这一版的改动（中栏 diff）' : '首版（新文件），点击打开'"
        @click="open(item)"
      >
        <FileDiff v-if="item.prevRevisionId !== null" :size="14" class="flex-none text-fg-muted group-hover:text-brand" aria-hidden="true" />
        <FilePlus2 v-else :size="14" class="flex-none text-fg-muted group-hover:text-brand" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ item.path }}</span>
        <span class="flex-none text-[10px] text-fg-muted tabular-nums">{{ item.title }}</span>
        <span class="flex-none text-[10px] text-fg-muted group-hover:text-brand">{{ item.prevRevisionId !== null ? "查看改动" : "打开" }}</span>
      </button>
    </div>
  </div>
</template>
