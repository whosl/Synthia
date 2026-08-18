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
 */
import { computed, ref } from "vue";
import type { ReplyCodeSegment } from "../../domain/reply-segments.ts";

const props = defineProps<{
  /** 叙述折叠模式的代码内容；产物卡模式传 null。 */
  segment: ReplyCodeSegment | null;
  /** 卡片标题：叙述折叠模式用「语言 · 文件名 · N 行代码」；产物卡模式传文档中文名。 */
  title: string;
  /** 非空时卡片可点击「在编辑器中打开」；为 null 时只能本地展开/收起查看代码。 */
  artifactId: string | null;
}>();

const emit = defineEmits<{ open: [artifactId: string] }>();

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
  <div class="code-card" :class="{ openable }">
    <button type="button" class="code-card-header" @click="onClick">
      <span class="code-card-icon" aria-hidden="true">📄</span>
      <span class="code-card-title">{{ title }}</span>
      <span v-if="segment" class="code-card-meta">{{ segment.lineCount }} 行</span>
      <span v-if="openable" class="code-card-action">在编辑器中打开 ↗</span>
      <span v-else-if="segment?.collapsible" class="code-card-action">{{ expanded ? "收起 ▴" : "展开 ▾" }}</span>
    </button>
    <pre v-if="segment && (expanded || !segment.collapsible)" class="code-card-body mono"><code>{{ segment.code }}</code></pre>
  </div>
</template>

<style scoped>
.code-card {
  border-radius: var(--radius);
  background: var(--surface-hover);
  overflow: hidden;
}

.code-card-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.code-card-icon {
  flex: none;
}

.code-card-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-card-meta {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
}

.code-card-action {
  flex: none;
  color: var(--text-secondary);
  font-size: 11px;
}

.code-card.openable:hover {
  background: var(--accent-subtle);
}

.code-card.openable:hover .code-card-action {
  color: var(--accent);
}

.code-card-body {
  margin: 0;
  padding: var(--space-2);
  padding-top: 0;
  overflow-x: auto;
  white-space: pre;
  color: var(--text-primary);
  background: var(--surface-panel);
}
</style>
