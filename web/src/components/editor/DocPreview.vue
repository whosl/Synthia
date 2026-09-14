<script setup lang="ts">
/**
 * Markdown 文档预览（.md 默认渲染视图，spec §3.3）。
 *
 * 渲染走 domain/markdown.ts:renderMarkdown，该函数已在源头接 DOMPurify 净化
 * （spec §5.1），此处直接 v-html 即可，不再叠加第二层 sanitize。
 *
 * 内部自带「预览 / 源码」切换（纯本地 UI 态，不跨栏、不需要跨刷新保留，按
 * contract 注释的原则不提升到 ProjectView）。
 */
import { computed, ref } from "vue";
import { renderMarkdown } from "../../domain/markdown.ts";
import Button from "../ui/AppButton.vue";

const props = defineProps<{
  /** Markdown 原文；加载中或无内容时传空串，组件只负责渲染，不理解加载态。 */
  content: string;
}>();

type PreviewMode = "preview" | "source";
const mode = ref<PreviewMode>("preview");

/** 已净化的 HTML，供 v-html 使用。 */
const safeHtml = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-base">
    <div class="flex flex-none gap-1 border-b border-line bg-panel px-3 py-1">
      <Button size="sm" :variant="mode === 'preview' ? 'secondary' : 'ghost'" @click="mode = 'preview'">预览</Button>
      <Button size="sm" :variant="mode === 'source' ? 'secondary' : 'ghost'" @click="mode = 'source'">源码</Button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div
        v-if="mode === 'preview'"
        class="markdown-body mx-auto max-w-[860px] p-6 text-[13px] leading-[1.55] text-fg"
        v-html="safeHtml"
      />
      <!-- pre 的等宽/12.5px/1.6 由 style.css 未分层的 code,pre,kbd 元素规则供给，此处只需布局类 -->
      <pre v-else class="m-0 p-4 break-words whitespace-pre-wrap text-fg">{{ content }}</pre>
    </div>
  </div>
</template>
