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
import Button from "../ui/Button.vue";

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
  <div class="doc-preview">
    <div class="doc-preview-toolbar">
      <Button size="sm" :variant="mode === 'preview' ? 'secondary' : 'ghost'" @click="mode = 'preview'">预览</Button>
      <Button size="sm" :variant="mode === 'source' ? 'secondary' : 'ghost'" @click="mode = 'source'">源码</Button>
    </div>
    <div class="doc-preview-body">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="mode === 'preview'" class="doc-preview-rendered markdown-body" v-html="safeHtml" />
      <pre v-else class="doc-preview-source">{{ content }}</pre>
    </div>
  </div>
</template>

<style scoped>
.doc-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-base);
}

.doc-preview-toolbar {
  flex: none;
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
}

.doc-preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.doc-preview-source {
  margin: 0;
  padding: var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
  line-height: var(--line-height-code);
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.doc-preview-rendered {
  padding: var(--space-6);
  max-width: 860px;
  margin: 0 auto;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  line-height: var(--line-height-chat);
}

/* v-html 注入的内容不受 scoped 属性选择器约束，需要 :deep() */
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
