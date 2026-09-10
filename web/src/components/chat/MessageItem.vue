<script setup lang="ts">
/**
 * 单条文本消息（user 气泡 / agent 叙述）。
 *
 * - role="user"：右侧气泡，纯文本（保留换行，不解析 Markdown，避免用户输入被
 *   当作 HTML/Markdown 注入渲染）；`steer=true` 时带 `↗ 纠偏` 标记
 *   （spec §3.5 D21，标记来自 `domain/composer.ts:buildChatRenderItems` 的配对
 *   识别，本组件只管渲染，不做识别）。
 * - role="agent" 且 state="streaming"：走 `domain/markdown-stream.ts:project`
 *   做增量块投影，token 级追加渲染，不整量重渲染；
 * - role="agent" 且 state="done"：走 `domain/reply-segments.ts:segmentAgentReply`
 *   分段——超过 15 行的代码块折叠为 `CodeCard`（叙述折叠模式，无产物 id，
 *   点击只本地展开/收起），超过 15 行的纯文本用原生 `<details>` 折叠，其余按
 *   Markdown 渲染。
 */
import { computed, ref, watch } from "vue";
import { renderMarkdown } from "../../domain/markdown.ts";
import { project, type Projection } from "../../domain/markdown-stream.ts";
import { segmentAgentReply, type ReplyCodeSegment } from "../../domain/reply-segments.ts";
import type { SynthiaTextPart } from "../../domain/parts.ts";
import { STEER_BADGE_TEXT } from "../../domain/composer.ts";
import Badge from "../ui/Badge.vue";
import CodeCard from "./CodeCard.vue";

const props = defineProps<{
  part: SynthiaTextPart;
  /** 是否为插话（steer）发出的用户消息；非 user 消息恒为 false。 */
  steer?: boolean;
}>();

// ─── 流式：增量 Markdown 块投影（token 级追加，不整量重渲染）───────────
const projection = ref<Projection | undefined>(undefined);
watch(
  () => [props.part.text, props.part.state] as const,
  ([text, state]) => {
    projection.value = project(projection.value, text, state === "streaming");
  },
  { immediate: true },
);

// ─── 定稿：>15 行代码/文本折叠分段 ───────────────────────────────────
const displaySegments = computed(() =>
  props.part.role === "agent" ? (props.part.segments ?? segmentAgentReply(props.part.text)) : [],
);

function codeCardTitle(seg: ReplyCodeSegment): string {
  if (seg.filename) return seg.filename;
  if (seg.language) return `${seg.language} 代码`;
  return "代码片段";
}
</script>

<template>
  <div class="message-item" :class="`role-${part.role}`">
    <span v-if="part.role === 'agent'" class="message-avatar" aria-hidden="true">🤖</span>

    <div class="message-body">
      <div v-if="part.role === 'user'" class="message-bubble">
        <Badge v-if="steer" tone="info" variant="soft" size="sm" class="message-steer-badge">{{ STEER_BADGE_TEXT }}</Badge>
        <p class="message-user-text">{{ part.text }}</p>
      </div>

      <template v-else>
        <template v-if="part.state === 'streaming'">
          <template v-for="(block, i) in projection?.blocks ?? []" :key="i">
            <div v-if="block.mode === 'code'" class="message-code-block">
              <div v-if="block.language" class="message-code-label">{{ block.language }}</div>
              <pre class="message-code mono"><code>{{ block.src }}</code></pre>
            </div>
            <div v-else class="markdown-body" v-html="renderMarkdown(block.src)"></div>
          </template>
          <span class="message-cursor" aria-hidden="true" />
        </template>

        <template v-else>
          <template v-for="seg in displaySegments" :key="seg.id">
            <CodeCard v-if="seg.kind === 'code' && seg.collapsible" :segment="seg" :title="codeCardTitle(seg)" :artifact-id="null" />
            <div v-else-if="seg.kind === 'code'" class="message-code-block">
              <div v-if="seg.language || seg.filename" class="message-code-label">{{ seg.filename ?? seg.language }}</div>
              <pre class="message-code mono"><code>{{ seg.code }}</code></pre>
            </div>
            <details v-else-if="seg.collapsible" class="message-text-fold">
              <summary>展开全文（{{ seg.lineCount }} 行）</summary>
              <div class="markdown-body" v-html="renderMarkdown(seg.text)"></div>
            </details>
            <div v-else class="markdown-body" v-html="renderMarkdown(seg.text)"></div>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.message-item {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}

.role-user {
  justify-content: flex-end;
}

.message-avatar {
  flex: none;
  line-height: var(--line-height-chat);
}

.message-body {
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 88% 宽度上限必须落在 .message-body 上，不能落在 .message-bubble 上：
   .message-body 是 shrink-to-fit（宽度由气泡内容撑出）的 flex item，气泡上写
   max-width:88% 会自我参照——百分比在内在尺寸阶段按 none 计算，布局阶段却按
   「气泡自身 max-content 的 88%」收紧，于是每条用户消息尾部约 12% 必被折行。
   放到 .message-body 上则以 .message-item（整行宽度，定值）为基准，无环。 */
.role-user .message-body {
  align-items: flex-end;
  max-width: 88%;
}

.message-bubble {
  max-width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--accent-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.message-steer-badge {
  align-self: flex-start;
}

.message-user-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: var(--line-height-chat);
  color: var(--text-primary);
}

.message-code-block {
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-hover);
}

.message-code-label {
  padding: var(--space-1) var(--space-2);
  font-size: 11px;
  color: var(--text-muted);
}

.message-code {
  margin: 0;
  padding: var(--space-2);
  overflow-x: auto;
  white-space: pre;
  color: var(--text-primary);
}

.message-text-fold summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  padding: var(--space-1) 0;
}

.message-text-fold summary::marker {
  color: var(--text-muted);
}

.message-cursor {
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: message-cursor-blink 900ms step-end infinite;
}

@keyframes message-cursor-blink {
  50% {
    opacity: 0;
  }
}

/* v-html 注入的 Markdown 内容：scoped 属性选择器不会附着在动态插入的节点上，
   须用 :deep() 才能命中（见 Vue scoped CSS 对 v-html 内容的已知限制）。 */
.message-body :deep(.markdown-body) {
  line-height: var(--line-height-chat);
  color: var(--text-primary);
}

.message-body :deep(.markdown-body p) {
  margin: 0 0 var(--space-2);
}

.message-body :deep(.markdown-body p:last-child) {
  margin-bottom: 0;
}

.message-body :deep(.markdown-body ul),
.message-body :deep(.markdown-body ol) {
  margin: 0 0 var(--space-2);
  padding-left: var(--space-5);
}

.message-body :deep(.markdown-body pre) {
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  overflow-x: auto;
}

.message-body :deep(.markdown-body code) {
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.message-body :deep(.markdown-body :not(pre) > code) {
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.message-body :deep(.markdown-body blockquote) {
  margin: 0 0 var(--space-2);
  padding-left: var(--space-3);
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
}

.message-body :deep(.markdown-body a) {
  color: var(--accent);
}
</style>
