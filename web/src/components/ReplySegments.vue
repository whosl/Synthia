<script setup lang="ts">
/**
 * 信息流折叠段渲染：free-agent 回复分段 + 工具条展开区长文本共用。
 *
 * - 代码段 ≤ 15 行：内联 <pre>（行为不变）；> 15 行：折叠为「代码卡」
 *   （文件名/语言 + 行数 + 点击展开），展开后显示全文并可收起。
 * - 文本段 > 15 行：折叠为前 3 行预览 + 「展开全部」；短文本按 Markdown 渲染。
 * - 展开状态组件内维护（以 partKey+段 id 为键；同一 part 轮询刷新时组件实例
 *   由 v-for :key 保持稳定，展开状态不丢）。
 */
import { ref } from "vue";
import { renderMarkdown } from "../domain/markdown.ts";
import { toggleSetKey, type ReplySegment } from "../domain/reply-segments.ts";

const props = defineProps<{
  segments: readonly ReplySegment[];
  /** 折叠状态键前缀（信息流 part key），保证同页多个回复互不干扰。 */
  partKey: string;
}>();

/** 长文本折叠时预览行数。 */
const PREVIEW_LINES = 3;

const expanded = ref<ReadonlySet<string>>(new Set());

function segKey(seg: ReplySegment): string {
  return `${props.partKey}:${seg.id}`;
}

function isExpanded(seg: ReplySegment): boolean {
  return expanded.value.has(segKey(seg));
}

function toggle(seg: ReplySegment): void {
  expanded.value = toggleSetKey(expanded.value, segKey(seg));
}

/** 折叠预览：取前 N 行纯文本（避免渲染被截断的 Markdown）。 */
function previewOf(text: string): string {
  return text.split("\n").slice(0, PREVIEW_LINES).join("\n");
}

/** 代码卡标题：文件名优先，其次语言名。 */
function codeCardName(seg: ReplySegment): string {
  if (seg.kind === "code" && seg.filename) return seg.filename;
  if (seg.kind === "code" && seg.language) return `${seg.language} 代码`;
  return "代码片段";
}
</script>

<template>
  <div class="reply-segments">
    <template v-for="seg in segments" :key="seg.id">
      <!-- 文本段 -->
      <template v-if="seg.kind === 'text'">
        <div v-if="seg.collapsible && !isExpanded(seg)" class="reply-preview-wrap">
          <div class="reply-preview">{{ previewOf(seg.text) }}</div>
          <button type="button" class="reply-toggle" @click.stop="toggle(seg)">
            展开全部（共 {{ seg.lineCount }} 行）
          </button>
        </div>
        <div v-else class="reply-text-wrap">
          <div class="markdown-body reply-text" v-html="renderMarkdown(seg.text)"></div>
          <button v-if="seg.collapsible" type="button" class="reply-toggle" @click.stop="toggle(seg)">收起</button>
        </div>
      </template>

      <!-- 代码段：短块内联 -->
      <pre v-else-if="!seg.collapsible" class="code-view reply-code">{{ seg.code }}</pre>

      <!-- 代码段：长块折叠为代码卡 -->
      <div v-else class="code-card" :class="{ open: isExpanded(seg) }">
        <button type="button" class="code-card-head" @click.stop="toggle(seg)">
          <span class="code-card-icon">&lt;/&gt;</span>
          <span class="code-card-name">{{ codeCardName(seg) }}</span>
          <span class="code-card-meta">{{ seg.lineCount }} 行</span>
          <span class="code-card-toggle">{{ isExpanded(seg) ? "收起" : "点击展开" }}</span>
        </button>
        <pre v-if="isExpanded(seg)" class="code-view code-card-body">{{ seg.code }}</pre>
      </div>
    </template>
  </div>
</template>
