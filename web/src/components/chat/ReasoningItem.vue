<script setup lang="ts">
/**
 * 思考过程卡（模型思维链，「▾ 思考中… / ▸ 已思考」）。
 *
 * 数据只来自 SSE 实时流（runtime 从 `delta.reasoning_content` 解出，见
 * `runtime/model-client.ts`），不落 audit，因此本轮结束刷新页面不再重放。
 *
 * 交互：streaming 时默认展开——模型推理阶段实测 8–40 秒，这段时间里流内本来
 * 什么都没有，思考过程正是用来填满它的；定稿后自动收起，避免长思维链把回复
 * 正文挤出视野。用户手动开合后以手动状态为准（`touched`）。
 */
import { computed, ref, watch } from "vue";
import type { SynthiaReasoningPart } from "../../domain/parts.ts";

const props = defineProps<{ part: SynthiaReasoningPart }>();

const touched = ref(false);
const expanded = ref(props.part.state === "streaming");

watch(
  () => props.part.state,
  (state) => {
    if (!touched.value) expanded.value = state === "streaming";
  },
);

function toggle(): void {
  touched.value = true;
  expanded.value = !expanded.value;
}

const streaming = computed(() => props.part.state === "streaming");
/** 收起态摘要：思维链首行（去掉 Markdown 标记噪音），太长省略。 */
const summary = computed(() => {
  const firstLine = props.part.text.trim().split("\n").find((l) => l.trim().length > 0) ?? "";
  const clean = firstLine.replace(/^[#>*\-\s]+/, "").trim();
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
});
</script>

<template>
  <div class="reasoning-item" :class="{ streaming, expanded }">
    <div
      class="reasoning-header"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="reasoning-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      <span class="reasoning-glyph" aria-hidden="true">💭</span>
      <span class="reasoning-title">{{ streaming ? "思考中…" : "已思考" }}</span>
      <span v-if="!expanded && summary" class="reasoning-summary">{{ summary }}</span>
    </div>
    <div v-if="expanded" class="reasoning-body">
      <pre class="reasoning-text">{{ part.text }}</pre>
      <span v-if="streaming" class="reasoning-cursor" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.reasoning-item {
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  border-left: 2px solid var(--border-strong);
}

.reasoning-item.streaming {
  border-left-color: var(--accent);
}

.reasoning-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.reasoning-chevron {
  flex: none;
  width: 10px;
  color: var(--text-muted);
}

.reasoning-glyph {
  flex: none;
}

.reasoning-title {
  flex: none;
  color: var(--text-secondary);
}

.streaming .reasoning-title {
  color: var(--accent);
}

.reasoning-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.reasoning-body {
  padding: 0 var(--space-2) var(--space-2) calc(var(--space-2) + 14px);
}

/* 思维链是模型的草稿：等宽、保留换行、不渲染 Markdown（避免半截语法闪烁）。 */
.reasoning-text {
  margin: 0;
  max-height: 320px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
  line-height: var(--line-height-list);
  color: var(--text-muted);
}

.reasoning-cursor {
  display: inline-block;
  width: 6px;
  height: 1em;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: reasoning-cursor-blink 900ms step-end infinite;
}

@keyframes reasoning-cursor-blink {
  50% {
    opacity: 0;
  }
}
</style>
