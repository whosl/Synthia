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
  <div class="rounded-sm border-l-2 border-line-strong bg-hover" :class="streaming ? 'border-l-brand' : ''">
    <div
      class="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left text-xs text-fg-secondary"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="w-[10px] flex-none text-fg-muted" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      <span class="flex-none" aria-hidden="true">💭</span>
      <span class="flex-none" :class="streaming ? 'text-brand' : 'text-fg-secondary'">{{ streaming ? "思考中…" : "已思考" }}</span>
      <span v-if="!expanded && summary" class="min-w-0 flex-1 truncate text-fg-muted">{{ summary }}</span>
    </div>
    <div v-if="expanded" class="px-2 pb-2 pl-[22px]">
      <!-- 思维链是模型的草稿：等宽、保留换行、不渲染 Markdown（避免半截语法闪烁）。 -->
      <pre class="reasoning-text m-0 max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words text-fg-muted">{{ part.text }}</pre>
      <span v-if="streaming" class="reasoning-cursor inline-block h-[1em] w-[6px] bg-brand align-text-bottom [animation:reasoning-cursor-blink_900ms_step-end_infinite]" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
/* 未分层全局 pre 规则（font/line-height）优先级高于 Tailwind utilities 层，
   思维链的 1.4 行高留在 scoped。 */
.reasoning-text {
  line-height: var(--line-height-list);
}

@keyframes reasoning-cursor-blink {
  50% {
    opacity: 0;
  }
}
</style>
