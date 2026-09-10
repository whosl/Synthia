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
        class="doc-preview-rendered markdown-body mx-auto max-w-[860px] p-6 text-[13px] leading-[1.55] text-fg"
        v-html="safeHtml"
      />
      <!-- pre 的等宽/12.5px/1.6 由 style.css 未分层的 code,pre,kbd 元素规则供给，此处只需布局类 -->
      <pre v-else class="m-0 p-4 break-words whitespace-pre-wrap text-fg">{{ content }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* v-html 注入的内容不受 scoped 属性选择器约束，markdown 排印需要 :deep()（同 MessageItem）；
   Tailwind 无法表达「容器内全部 h1–h4/li/code…」这种对注入 DOM 的后代选择器，故整段保留。 */
.doc-preview-rendered :deep(h1),
.doc-preview-rendered :deep(h2),
.doc-preview-rendered :deep(h3),
.doc-preview-rendered :deep(h4) {
  margin: var(--space-6) 0 var(--space-3);
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-primary);
}

.doc-preview-rendered :deep(h1) {
  font-size: 1.5em;
}

.doc-preview-rendered :deep(h2) {
  font-size: 1.3em;
}

.doc-preview-rendered :deep(h3) {
  font-size: 1.1em;
}

.doc-preview-rendered :deep(p) {
  margin: 0 0 var(--space-3);
}

.doc-preview-rendered :deep(ul),
.doc-preview-rendered :deep(ol) {
  margin: 0 0 var(--space-3);
  padding-left: var(--space-6);
}

.doc-preview-rendered :deep(li) {
  margin: var(--space-1) 0;
}

.doc-preview-rendered :deep(a) {
  color: var(--accent);
}

.doc-preview-rendered :deep(code) {
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
  background: var(--surface-hover);
  border-radius: var(--radius-sm);
  padding: 1px var(--space-1);
}

.doc-preview-rendered :deep(pre) {
  margin: 0 0 var(--space-4);
  padding: var(--space-3);
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  overflow: auto;
}

.doc-preview-rendered :deep(pre code) {
  background: none;
  padding: 0;
}

.doc-preview-rendered :deep(blockquote) {
  margin: 0 0 var(--space-3);
  padding: var(--space-1) var(--space-4);
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
  background: var(--surface-panel);
  border-radius: 0 var(--radius) var(--radius) 0;
}

.doc-preview-rendered :deep(table) {
  border-collapse: collapse;
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-sm);
}

.doc-preview-rendered :deep(th),
.doc-preview-rendered :deep(td) {
  border: 1px solid var(--border-subtle);
  padding: var(--space-1) var(--space-2);
  text-align: left;
}

.doc-preview-rendered :deep(th) {
  background: var(--surface-panel);
}

.doc-preview-rendered :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: var(--space-6) 0;
}
</style>
