<script setup lang="ts">
/**
 * 代码卡：两种用途共用同一张卡片外观（Claude 风格：底色分区，不加硬边框）。
 *
 * 1. 叙述折叠（`segment` 非空）：Agent 回复中 >15 行的代码块
 *    （`domain/reply-segments.ts:segmentAgentReply` 判定 collapsible）折叠为卡片，
 *    默认收起，点击展开/收起查看原文；这类代码没有对应的产物 id，点击不导航。
 * 2. 产物卡（`artifactId` 非空）：`domain/parts.ts` 物化的 `SynthiaDocPart`——
 *    agent 登记的候选产物在对话流里的引用。点击直接 emit `open`，由 ChatFeed
 *    转发 `open-doc`，在中栏编辑器打开（spec §3.5：不再弹抽屉，这是三栏相对
 *    v3 单页的主要收益）。这类卡片没有正文预览，只有一行标题。
 *
 *    `diffable` 时额外给一枚「查看改动」——**流内不渲染行级 diff**，而是复用中栏
 *    Monaco 的 diff 模式（对标结论 P1 的取舍，见 specs/agent-stream-benchmark.md §4）。
 *    本组件不认识修订号：两个事件都只带 artifactId，由 ChatFeed 补上这张卡对应的
 *    revisionId。
 */
import { computed, ref } from "vue";
import type { ReplyCodeSegment } from "../../domain/reply-segments.ts";

const props = withDefaults(
  defineProps<{
    /** 叙述折叠模式的代码内容；产物卡模式传 null。 */
    segment: ReplyCodeSegment | null;
    /** 卡片标题：叙述折叠模式用「语言 · 文件名 · N 行代码」；产物卡模式传文档中文名。 */
    title: string;
    /** 非空时卡片可点击「在编辑器中打开」；为 null 时只能本地展开/收起查看代码。 */
    artifactId: string | null;
    /** 这一版有上一版可比时为 true → 多一枚「查看改动」。首版为 false。 */
    diffable?: boolean;
  }>(),
  { diffable: false },
);

const emit = defineEmits<{ open: [artifactId: string]; "open-diff": [artifactId: string] }>();

const openable = computed(() => props.artifactId !== null);
const expanded = ref(false);

function onClick(): void {
  if (props.artifactId) {
    emit("open", props.artifactId);
    return;
  }
  if (props.segment?.collapsible) expanded.value = !expanded.value;
}
</script>

<template>
  <div class="overflow-hidden rounded-md bg-hover" :class="openable ? 'group hover:bg-brand-subtle' : ''">
    <div class="flex items-stretch">
      <button
        type="button"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-none bg-transparent px-2 py-1 text-left"
        @click="onClick"
      >
        <span class="flex-none text-xs" aria-hidden="true">📄</span>
        <span class="min-w-0 flex-1 truncate text-xs text-fg">{{ title }}</span>
        <span v-if="segment" class="flex-none text-[11px] text-fg-muted">{{ segment.lineCount }} 行</span>
        <span v-if="openable" class="flex-none text-[11px] text-fg-secondary group-hover:text-brand">在编辑器中打开 ↗</span>
        <span v-else-if="segment?.collapsible" class="flex-none text-[11px] text-fg-secondary">{{ expanded ? "收起 ▴" : "展开 ▾" }}</span>
      </button>
      <button
        v-if="diffable && artifactId"
        type="button"
        class="code-card-diff flex-none cursor-pointer border-none bg-transparent px-2 py-1 whitespace-nowrap"
        @click="emit('open-diff', artifactId)"
      >
        查看改动 ⇄
      </button>
    </div>
    <pre v-if="segment && (expanded || !segment.collapsible)" class="mono m-0 overflow-x-auto whitespace-pre bg-panel p-2 pt-0 text-fg"><code>{{ segment.code }}</code></pre>
  </div>
</template>

<style scoped>
/* 未分层全局 reset 的 button { font: inherit; color: inherit } 优先级高于 Tailwind
   utilities 层，裸按钮自身的字号/文字色只能留在 scoped。 */
.code-card-diff {
  font-size: 11px;
  color: var(--text-secondary);
}

.code-card-diff:hover {
  color: var(--accent);
}
</style>
